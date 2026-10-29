import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  getEmbeddingCatalog,
  getEmbeddingModel,
  readOnnxGraphHeader,
  resolveEmbeddingSources,
  validateEmbeddingManifest,
} from './embedding-catalog.js'

// §14.4/§14.7 受管隔离下载器：
//   staging → bytes/sha256 校验 → 模型 smoke（图头 + config/tokenizer 结构）→ 原子安装。
// 硬约束：
//   1. 只有用户在 UI 里明确确认（confirmed: true）才会联网；没有确认就绝不发请求。
//   2. 只从 manifest 里显式固定的 repo+revision 生成 URL；没有固定 revision 的来源不下载。
//   3. 失败、取消、hash 不符、smoke 不过一律不改动已安装目录——它代表"当前的 profiles"，
//      写 active 是另一个模块的事，本模块永远不写 active/profile 指针（§14.8）。
//   4. 不做断点续传：重下必须从零重新验总 hash（§14.4 第 4 条），半成品不出 staging。

export const DOWNLOAD_STATES = Object.freeze(['unknown', 'absent', 'downloading', 'verifying', 'installed', 'failed', 'cancelled'])

const INSTALL_RECORD = 'installed.json'
const STAGING_DIR = '.staging'
const TRASH_DIR = '.trash'
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024

function fail(code, message, extra) {
  const error = new Error(message)
  error.code = code
  if (extra) Object.assign(error, extra)
  return error
}

function isAbort(error, signal) {
  return Boolean(signal?.aborted) || error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'UND_ERR_ABORTED' || error?.code === 'EMBEDDING_DOWNLOAD_ABORTED'
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, file)
}

/**
 * 默认模型 smoke：不需要 onnxruntime。读 config/tokenizer/图头，核对 manifest 声明的
 * 维度、最大长度、输入输出名与 dtype、opset、自包含性、词表规模。真实推理 smoke 要等
 * ORT 装好后再加（§14.11），这里不假装它已经跑过。
 */
export async function verifyStagedArtifacts({ entry, dir }) {
  const checks = []
  const fileOf = role => (entry.files || []).find(file => file.role === role) || null
  const bytesOf = role => {
    const file = fileOf(role)
    if (!file) return null
    return fs.readFileSync(path.join(dir, ...String(file.path).split('/')))
  }

  const configBytes = bytesOf('config')
  if (!configBytes) throw new Error('staged artifact has no config.json')
  const config = JSON.parse(configBytes.toString('utf8'))
  if (config.hidden_size !== entry.dimension) throw new Error(`config.hidden_size ${config.hidden_size} does not match manifest dimension ${entry.dimension}`)
  checks.push('config.hidden_size=' + config.hidden_size)
  if (entry.maxTokens !== null && config.max_position_embeddings && config.max_position_embeddings !== entry.maxTokens) {
    throw new Error(`config.max_position_embeddings ${config.max_position_embeddings} does not match manifest maxTokens ${entry.maxTokens}`)
  }
  if (config.max_position_embeddings) checks.push('config.max_position_embeddings=' + config.max_position_embeddings)

  const vocabBytes = bytesOf('vocab')
  if (vocabBytes && Number.isInteger(config.vocab_size)) {
    const vocabLines = vocabBytes.toString('utf8').split(/\r?\n/).filter(line => line.length > 0).length
    if (vocabLines !== config.vocab_size) throw new Error(`vocab.txt has ${vocabLines} entries but config.vocab_size is ${config.vocab_size}`)
    checks.push('vocab.txt=' + vocabLines)
  }

  const tokenizerBytes = bytesOf('tokenizer')
  if (tokenizerBytes) {
    const tokenizer = JSON.parse(tokenizerBytes.toString('utf8'))
    const vocab = tokenizer?.model?.vocab
    if (!vocab || typeof vocab !== 'object' || Object.keys(vocab).length < 2) throw new Error('tokenizer.json has no usable model.vocab')
    checks.push('tokenizer.vocab=' + Object.keys(vocab).length)
  }

  const poolingBytes = bytesOf('pooling-config')
  if (poolingBytes) {
    const pooling = JSON.parse(poolingBytes.toString('utf8'))
    if (entry.pooling === 'cls' && pooling.pooling_mode_cls_token !== true) throw new Error('pooling config is not CLS pooling')
    if (Number.isInteger(pooling.word_embedding_dimension) && pooling.word_embedding_dimension !== entry.dimension) {
      throw new Error(`pooling word_embedding_dimension ${pooling.word_embedding_dimension} does not match dimension ${entry.dimension}`)
    }
    checks.push('pooling=' + entry.pooling)
  }

  const graphFile = fileOf('graph')
  if (!graphFile) throw new Error('staged artifact has no graph file')
  const graphBytes = bytesOf('graph')
  const header = readOnnxGraphHeader(graphBytes)
  if (!header.selfContained) throw new Error('graph references external data or has no initializer bytes; this build only installs self-contained graphs')
  checks.push('graph.selfContained=true', 'graph.initializerBytes=' + header.initializerBytes)
  const declared = entry.graph || {}
  const declaredInputs = (declared.inputs || []).map(io => io.name).sort()
  const actualInputs = header.inputs.map(io => io.name).sort()
  if (declaredInputs.join(',') !== actualInputs.join(',')) {
    throw new Error(`graph inputs ${actualInputs.join(',')} do not match manifest ${declaredInputs.join(',')}`)
  }
  for (const io of declared.inputs || []) {
    const actual = header.inputs.find(item => item.name === io.name)
    if (actual.dtype !== io.dtype) throw new Error(`graph input ${io.name} dtype ${actual.dtype} does not match manifest ${io.dtype}`)
  }
  const declaredOutput = (declared.outputs || [])[0]
  const actualOutput = header.outputs[0]
  if (!actualOutput) throw new Error('graph has no outputs')
  if (declaredOutput && actualOutput.name !== declaredOutput.name) throw new Error(`graph output ${actualOutput.name} does not match manifest ${declaredOutput.name}`)
  if (actualOutput.dtype !== 'float32') throw new Error(`graph output dtype ${actualOutput.dtype} is not float32`)
  const lastDim = Array.isArray(actualOutput.shape) ? actualOutput.shape[actualOutput.shape.length - 1] : null
  if (lastDim !== entry.dimension) throw new Error(`graph output last dim ${lastDim} does not match dimension ${entry.dimension}`)
  checks.push('graph.output=' + actualOutput.name + ':' + actualOutput.dtype + '[' + lastDim + ']')
  if (Number.isInteger(declared.opset)) {
    const defaultOpset = header.opsets.find(opset => !opset.domain)
    if (!defaultOpset || defaultOpset.version !== declared.opset) {
      throw new Error(`graph opset ${defaultOpset?.version} does not match manifest ${declared.opset}`)
    }
    checks.push('graph.opset=' + defaultOpset.version)
  }
  return { ok: true, checks }
}

/**
 * createEmbeddingDownloadManager({ root, catalog?, fetchImpl?, verifyModel? })
 * root: 本插件受管模型目录（复用 paths.js 的数据目录，不要放进宿主 app.asar）。
 */
export function createEmbeddingDownloadManager(options = {}) {
  const { root, fetchImpl = fetch, verifyModel, maxFileBytes = DEFAULT_MAX_FILE_BYTES, now = () => new Date().toISOString() } = options
  if (typeof root !== 'string' || !root.trim()) throw new TypeError('createEmbeddingDownloadManager requires a root directory')
  const baseDir = path.resolve(root)
  const extraCatalog = Array.isArray(options.catalog) ? options.catalog : []
  const jobs = new Map()
  // 失败/取消结果单独记账：jobs 只表示「在途」，所以重试不会被误判成 BUSY，
  // 但 UI 仍能读到上一次的失败原因（§14.7 的 failed 状态）。
  const outcomes = new Map()

  const lookup = id => extraCatalog.find(entry => entry && entry.id === id) || getEmbeddingModel(id)

  function insideRoot(target) {
    const resolved = path.resolve(target)
    if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
      throw fail('EMBEDDING_PATH_ESCAPE', `refusing to touch a path outside the model root: ${resolved}`)
    }
    return resolved
  }

  const modelDir = id => insideRoot(path.join(baseDir, id))
  const recordPath = id => path.join(modelDir(id), INSTALL_RECORD)

  function readInstall(entry) {
    const dir = modelDir(entry.id)
    const record = readJsonFile(recordPath(entry.id))
    if (!record || typeof record !== 'object') return null
    if (record.id !== entry.id) return { ok: false, code: 'EMBEDDING_INSTALL_MISMATCH' }
    const files = Array.isArray(record.files) ? record.files : []
    if (!files.length) return { ok: false, code: 'EMBEDDING_INSTALL_INCOMPLETE' }
    for (const file of files) {
      const target = path.join(dir, ...String(file.path).split('/'))
      let stat
      try { stat = fs.statSync(target) } catch { return { ok: false, code: 'EMBEDDING_INSTALL_INCOMPLETE' } }
      if (!stat.isFile() || stat.size !== file.bytes) return { ok: false, code: 'EMBEDDING_INSTALL_INCOMPLETE' }
    }
    return { ok: true, record }
  }

  function deepVerify(entry, record) {
    const dir = modelDir(entry.id)
    for (const file of record.files || []) {
      const target = path.join(dir, ...String(file.path).split('/'))
      let hash
      try { hash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') } catch { return false }
      if (hash !== file.sha256) return false
    }
    return true
  }

  function getStatus(id, statusOptions = {}) {
    const key = typeof id === 'string' ? id : String(id || '')
    const entry = lookup(key)
    if (!entry) {
      return { id: key, known: false, state: 'unknown', installed: false, active: false, downloadable: false, error: { code: 'EMBEDDING_MODEL_UNKNOWN', message: `unknown embedding model: ${key}` } }
    }
    const base = {
      id: entry.id,
      known: true,
      availability: entry.availability,
      downloadable: entry.availability === 'available',
      active: false, // 下载器永远不激活 profile（§14.8）；active 由迁移模块负责
      dimension: entry.dimension,
      maxTokens: entry.maxTokens,
      pooling: entry.pooling,
      normalization: entry.normalization,
      totalBytes: entry.totalBytes,
      fingerprint: entry.profileFingerprint,
      license: entry.license?.base || null,
      pendingReasons: [...(entry.pendingReasons || [])],
    }
    const job = jobs.get(entry.id)
    if (job && (job.state === 'downloading' || job.state === 'verifying')) {
      return { ...base, state: job.state, installed: false, provider: job.provider, revision: job.revision, startedAt: job.startedAt, progress: { ...job.progress } }
    }
    const install = readInstall(entry)
    if (install?.ok) {
      return {
        ...base,
        state: 'installed',
        installed: true,
        provider: install.record.provider || null,
        revision: install.record.revision || null,
        installedAt: install.record.installedAt || null,
        fingerprintMatches: install.record.fingerprint === entry.profileFingerprint,
        checks: Array.isArray(install.record.checks) ? [...install.record.checks] : [],
        verified: statusOptions.deep ? deepVerify(entry, install.record) : null,
      }
    }
    if (install && !install.ok) {
      return { ...base, state: 'failed', installed: false, error: { code: install.code, message: 'existing install record does not match the files on disk' } }
    }
    const outcome = outcomes.get(entry.id)
    if (outcome) return { ...base, state: outcome.state, installed: false, error: outcome.error || null }
    return { ...base, state: 'absent', installed: false }
  }

  async function download(id, downloadOptions = {}) {
    const { confirmed = false, signal } = downloadOptions || {}
    const entry = lookup(typeof id === 'string' ? id : String(id || ''))
    if (!entry) throw fail('EMBEDDING_MODEL_UNKNOWN', `unknown embedding model: ${id}`)
    const report = validateEmbeddingManifest(entry)
    if (!report.ok) {
      throw fail('EMBEDDING_MANIFEST_INVALID', `${entry.id} manifest is not installable: ${report.errors.map(item => item.code).join(', ')}`, { errors: report.errors })
    }
    if (entry.availability !== 'available') {
      throw fail('EMBEDDING_MODEL_UNAVAILABLE', `${entry.id} has no verified artifact; nothing will be downloaded`, { pendingReasons: [...(entry.pendingReasons || [])] })
    }
    if (confirmed !== true) {
      throw fail('EMBEDDING_CONFIRMATION_REQUIRED', 'downloading a model needs explicit user confirmation: download(id, { confirmed: true })')
    }
    if (jobs.has(entry.id)) throw fail('EMBEDDING_DOWNLOAD_BUSY', `${entry.id} is already downloading`)
    if (signal?.aborted) throw fail('EMBEDDING_DOWNLOAD_ABORTED', `download of ${entry.id} was aborted before it started`)
    const resolved = resolveEmbeddingSources(entry)
    const source = resolved.primary
    if (!source) throw fail('EMBEDDING_SOURCE_UNAVAILABLE', `no source with a pinned revision is available for ${entry.id}`, { skipped: resolved.skipped })

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const job = {
      id: entry.id,
      state: 'downloading',
      provider: source.provider,
      revision: source.revision,
      startedAt: now(),
      controller,
      progress: { files: source.files.length, done: 0, bytes: 0, totalBytes: entry.totalBytes, current: null },
    }
    jobs.set(entry.id, job)
    outcomes.delete(entry.id)
    let staging = null
    let installed = false
    try {
      const stagingRoot = insideRoot(path.join(baseDir, STAGING_DIR))
      fs.mkdirSync(stagingRoot, { recursive: true })
      staging = fs.mkdtempSync(path.join(stagingRoot, `${entry.id}-`))
      for (const file of source.files) {
        if (controller.signal.aborted) throw fail('EMBEDDING_DOWNLOAD_ABORTED', `download of ${entry.id} was aborted`)
        if (!Number.isInteger(file.bytes) || file.bytes < 0) throw fail('EMBEDDING_MANIFEST_INVALID', `file ${file.path} has no exact byte count`)
        if (file.bytes > maxFileBytes) throw fail('EMBEDDING_FILE_TOO_LARGE', `file ${file.path} declares ${file.bytes} bytes, above the ${maxFileBytes} byte cap`)
        const target = path.join(staging, ...String(file.path).split('/'))
        if (!path.resolve(target).startsWith(path.resolve(staging) + path.sep)) throw fail('EMBEDDING_PATH_ESCAPE', `file ${file.path} escapes the staging directory`)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        job.progress.current = file.path
        let response
        try {
          response = await fetchImpl(file.url, { signal: controller.signal, redirect: 'follow', headers: { 'accept-encoding': 'identity' } })
        } catch (error) {
          if (isAbort(error, controller.signal)) throw fail('EMBEDDING_DOWNLOAD_ABORTED', `download of ${entry.id} was aborted`, { cause: error })
          throw fail('EMBEDDING_NETWORK_ERROR', `cannot fetch ${file.path} from ${source.provider}: ${error?.message || error}`, { cause: error })
        }
        if (!response || !response.ok) {
          throw fail('EMBEDDING_HTTP_ERROR', `${source.provider} returned ${response?.status ?? 'no response'} for ${file.path}`)
        }
        const declaredLength = Number(response.headers?.get?.('content-length'))
        if (Number.isFinite(declaredLength) && declaredLength !== file.bytes) {
          throw fail('EMBEDDING_SIZE_MISMATCH', `${file.path} content-length ${declaredLength} does not match the pinned ${file.bytes} bytes`)
        }
        const hash = crypto.createHash('sha256')
        let size = 0
        const fd = fs.openSync(target, 'wx', 0o600)
        try {
          const body = response.body
          if (body && typeof body[Symbol.asyncIterator] === 'function') {
            for await (const chunk of body) {
              if (controller.signal.aborted) throw fail('EMBEDDING_DOWNLOAD_ABORTED', `download of ${entry.id} was aborted`)
              size += chunk.length
              if (size > file.bytes) throw fail('EMBEDDING_SIZE_MISMATCH', `${file.path} exceeded the pinned ${file.bytes} bytes`)
              hash.update(chunk)
              fs.writeSync(fd, chunk)
              job.progress.bytes += chunk.length
            }
          } else {
            const buffer = Buffer.from(await response.arrayBuffer())
            size = buffer.length
            if (size > file.bytes) throw fail('EMBEDDING_SIZE_MISMATCH', `${file.path} exceeded the pinned ${file.bytes} bytes`)
            hash.update(buffer)
            fs.writeSync(fd, buffer)
            job.progress.bytes += buffer.length
          }
        } finally {
          fs.closeSync(fd)
        }
        if (size !== file.bytes) throw fail('EMBEDDING_SIZE_MISMATCH', `${file.path} is ${size} bytes, expected ${file.bytes}`)
        const digest = hash.digest('hex')
        if (digest !== file.sha256) throw fail('EMBEDDING_HASH_MISMATCH', `${file.path} sha256 ${digest} does not match the pinned ${file.sha256}`)
        job.progress.done += 1
      }
      job.state = 'verifying'
      job.progress.current = null
      const verifier = typeof verifyModel === 'function' ? verifyModel : verifyStagedArtifacts
      let smoke
      try {
        smoke = await verifier({ id: entry.id, dir: staging, entry, manifest: entry, provider: source.provider, revision: source.revision })
      } catch (error) {
        if (isAbort(error, controller.signal)) throw fail('EMBEDDING_DOWNLOAD_ABORTED', `download of ${entry.id} was aborted`, { cause: error })
        throw fail('EMBEDDING_SMOKE_FAILED', `model smoke failed for ${entry.id}: ${error?.message || error}`, { cause: error })
      }
      if (smoke && smoke.ok === false) throw fail('EMBEDDING_SMOKE_FAILED', `model smoke rejected ${entry.id}`, { smoke })

      const record = {
        id: entry.id,
        revision: source.revision,
        repo: source.repo,
        provider: source.provider,
        fingerprint: entry.profileFingerprint,
        installedAt: now(),
        totalBytes: entry.totalBytes,
        files: (entry.files || []).map(file => ({ path: file.path, role: file.role, bytes: file.bytes, sha256: file.sha256 })),
        checks: Array.isArray(smoke?.checks) ? smoke.checks : [],
        verifiedBy: typeof verifyModel === 'function' ? 'custom-verify-model' : 'sha256+structural-smoke',
        // 明确记录：安装≠启用。active profile 由迁移模块的受验证切换流程负责。
        active: false,
      }
      writeJsonAtomic(path.join(staging, INSTALL_RECORD), record)

      const finalDir = modelDir(entry.id)
      const previousExists = fs.existsSync(finalDir)
      let trash = null
      if (previousExists) {
        const trashRoot = insideRoot(path.join(baseDir, TRASH_DIR))
        fs.mkdirSync(trashRoot, { recursive: true })
        trash = path.join(trashRoot, `${entry.id}-${crypto.randomUUID()}`)
        fs.renameSync(finalDir, trash)
      }
      try {
        fs.renameSync(staging, finalDir)
        staging = null
        installed = true
      } catch (error) {
        if (trash) { try { fs.renameSync(trash, finalDir) } catch {} }
        throw fail('EMBEDDING_INSTALL_FAILED', `cannot move the verified artifact into place: ${error?.message || error}`, { cause: error })
      }
      if (trash) { try { fs.rmSync(trash, { recursive: true, force: true }) } catch {} }
      job.state = 'installed'
      jobs.delete(entry.id)
      outcomes.delete(entry.id)
      return getStatus(entry.id)
    } catch (error) {
      const aborted = isAbort(error, controller.signal)
      const code = aborted ? 'EMBEDDING_DOWNLOAD_ABORTED' : (typeof error?.code === 'string' && error.code.startsWith('EMBEDDING_') ? error.code : 'EMBEDDING_DOWNLOAD_FAILED')
      const failed = code === error?.code ? error : fail(code, `download of ${entry.id} failed: ${error?.message || error}`, { cause: error })
      job.state = aborted ? 'cancelled' : 'failed'
      job.error = { code, message: String(failed.message || error) }
      jobs.delete(entry.id)
      outcomes.set(entry.id, { state: job.state, error: { ...job.error } })
      throw failed
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (staging && !installed) { try { fs.rmSync(staging, { recursive: true, force: true }) } catch {} }
    }
  }

  function dispose() {
    // 只中止在途下载；状态与错误原因留给 getStatus 展示。
    for (const job of jobs.values()) { try { job.controller?.abort() } catch {} }
  }

  return {
    root: baseDir,
    catalogIds: [...getEmbeddingCatalog().map(entry => entry.id), ...extraCatalog.map(entry => entry?.id).filter(Boolean)],
    getStatus,
    download,
    dispose,
  }
}
