import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  getEmbeddingCatalog,
  getEmbeddingModel,
  PROVIDERS,
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
//   4. 下载走独立 .cache 里的 .part + Range 断点续传，半成品不进 staging；
//      安装前校验完整总 hash，磁盘写失败清 .part 并给明确错误。

const INSTALL_RECORD = 'installed.json'
const STAGING_DIR = '.staging'
const TRASH_DIR = '.trash'
const CACHE_DIR = '.cache'
// 单文件上限。512 MiB 装不下已经逐字节核实过的 Qwen3-Embedding int8 图（600,223,343 B），
// 所以按「最大的一条 pin 住制品 + 余量」定；目录条目仍各自带 exact bytes，超限一律拒。
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024 * 1024
// S-1：网络总超时与分块 stall 超时，避免半开连接把下载永久挂住。
const DEFAULT_FETCH_TIMEOUT_MS = 600_000
const DEFAULT_STALL_TIMEOUT_MS = 30_000

function fail(code, message, extra) {
  const error = new Error(message)
  error.code = code
  if (extra) Object.assign(error, extra)
  return error
}

function sha256FileSync(file) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let read
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read))
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

// S-16：下载前预检目标盘剩余空间。statfsSync 抛错/回报 0 时不拦（fail-open），
// 让写入路径自己报错，别因为一个探针就挡住本来能装成功的下载。
function ensureFreeSpace(dir, requiredBytes) {
  if (!Number.isFinite(requiredBytes) || requiredBytes <= 0) return
  let available = null
  try {
    const stat = fs.statfsSync(dir)
    available = Number(stat.bavail) * Number(stat.bsize)
  } catch {
    return
  }
  if (!Number.isFinite(available) || available <= 0) return
  // 留一倍余量给 .part + staging 双份与安装副本，别把盘压到 0。
  if (available < requiredBytes * 2) {
    throw fail('EMBEDDING_DISK_FULL', `not enough free space to download the model: need ~${requiredBytes * 2} bytes, only ${available} available`)
  }
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

// Installed records are local state, not a trusted manifest. Resolve every
// recorded file without following symlinks out of its model directory.
function modelFileTarget(dir, relative) {
  const text = String(relative || '')
  if (!text || text.includes('\\') || path.isAbsolute(text)) return null
  const parts = text.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) return null
  const root = path.resolve(dir)
  const target = path.resolve(root, ...parts)
  if (target !== root && !target.startsWith(root + path.sep)) return null
  try {
    const rootReal = fs.realpathSync(root)
    const targetReal = fs.realpathSync(target)
    if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) return null
  } catch {
    return null
  }
  return target
}

function isRegularNonSymlink(file) {
  try {
    const stat = fs.lstatSync(file)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
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
  // 分窗不能超过制品自己声明的位置上限——超过就是必炸的输入；比它小是刻意的策略
  // （例如 32k 上下文的模型按 8k 切，避免单条记忆把 CPU 推理拖到请求超时），
  // 而这个选择本来就在 profile 指纹里，可复现。
  if (entry.maxTokens !== null && config.max_position_embeddings && config.max_position_embeddings < entry.maxTokens) {
    throw new Error(`manifest maxTokens ${entry.maxTokens} exceeds the artifact's max_position_embeddings ${config.max_position_embeddings}`)
  }
  if (config.max_position_embeddings) checks.push('config.max_position_embeddings=' + config.max_position_embeddings + ' window=' + (entry.maxTokens ?? 'unset'))

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
    if (entry.pooling === 'mean' && pooling.pooling_mode_mean_tokens !== true) throw new Error('pooling config is not mean pooling')
    // 因果 LM 的卡片最容易踩的坑：目录写着 last、制品其实是 mean。lasttoken 是基座自己
    // 声明的字段，能对得上才继续。
    if (entry.pooling === 'last' && pooling.pooling_mode_lasttoken !== true) throw new Error('pooling config is not last-token pooling')
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
  // float32 与 float16 都能被 worker 池化（fp16 走 Number() 取值），但别的 dtype
  // （int8 输出、string）不是 embedding worker 该假装能吃的东西。声明与实际必须一致。
  if (!['float32', 'float16'].includes(actualOutput.dtype)) throw new Error(`graph output dtype ${actualOutput.dtype} is not float32/float16`)
  if (declaredOutput && declaredOutput.dtype && actualOutput.dtype !== declaredOutput.dtype) {
    throw new Error(`graph output dtype ${actualOutput.dtype} does not match manifest ${declaredOutput.dtype}`)
  }
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
  const fetchTimeoutMs = Number.isInteger(options.fetchTimeoutMs) ? options.fetchTimeoutMs : DEFAULT_FETCH_TIMEOUT_MS
  const stallTimeoutMs = Number.isInteger(options.stallTimeoutMs) ? options.stallTimeoutMs : DEFAULT_STALL_TIMEOUT_MS
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
  // S-16：续传用的稳定 .part 放在独立 .cache，与 .staging 隔离（staging 仍保持
  // 「安装成功后必须为空」的既有语义）。文件名带 sha256，换源/换版本不会误复用。
  const partPathFor = file => {
    const safe = String(file.path).split('/').pop().replace(/[^A-Za-z0-9._-]+/g, '-')
    return path.join(insideRoot(path.join(baseDir, CACHE_DIR)), `${safe}-${file.sha256}.part`)
  }

  function readInstall(entry) {
    const dir = modelDir(entry.id)
    try {
      const dirStat = fs.lstatSync(dir)
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return { ok: false, code: 'EMBEDDING_INSTALL_INCOMPLETE' }
    } catch { return null }
    const record = readJsonFile(recordPath(entry.id))
    if (!record || typeof record !== 'object') return null
    if (record.id !== entry.id) return { ok: false, code: 'EMBEDDING_INSTALL_MISMATCH' }
    const files = Array.isArray(record.files) ? record.files : []
    if (!files.length) return { ok: false, code: 'EMBEDDING_INSTALL_INCOMPLETE' }
    for (const file of files) {
      const target = modelFileTarget(dir, file.path)
      if (!target || !isRegularNonSymlink(target)) return { ok: false, code: 'EMBEDDING_INSTALL_INCOMPLETE' }
      let stat
      try { stat = fs.lstatSync(target) } catch { return { ok: false, code: 'EMBEDDING_INSTALL_INCOMPLETE' } }
      if (stat.size !== file.bytes) return { ok: false, code: 'EMBEDDING_INSTALL_INCOMPLETE' }
    }
    return { ok: true, record }
  }

  function deepVerify(entry, record) {
    const dir = modelDir(entry.id)
    for (const file of record.files || []) {
      const target = modelFileTarget(dir, file.path)
      if (!target || !isRegularNonSymlink(target)) return false
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
    const { confirmed = false, signal, provider = null } = downloadOptions || {}
    const entry = lookup(typeof id === 'string' ? id : String(id || ''))
    if (!entry) throw fail('EMBEDDING_MODEL_UNKNOWN', `unknown embedding model: ${id}`)
    if (provider !== null && !PROVIDERS[provider]) {
      throw fail('EMBEDDING_PROVIDER_UNKNOWN', `unknown download provider: ${String(provider)}`)
    }
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
    // 默认取目录顺序里第一个已固定的来源（Qwen3 卡片因此默认 hf-mirror）；显式传
    // provider 时只解析那一个，解析不出可用来源就如实报错，绝不回退到别的源去下载。
    const resolved = provider ? resolveEmbeddingSources(entry, { providers: [provider] }) : resolveEmbeddingSources(entry)
    const source = provider ? resolved.sources.find(item => item.provider === provider) || null : resolved.primary
    if (!source) {
      throw fail('EMBEDDING_SOURCE_UNAVAILABLE', `no source with a pinned revision is available for ${entry.id}${provider ? ' on ' + provider : ''}`, { skipped: resolved.skipped })
    }

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
    const parts = []
    try {
      // S-16：下载前预检磁盘空间，避免 ENOSPC 留下 .part 占空间。
      fs.mkdirSync(baseDir, { recursive: true })
      ensureFreeSpace(baseDir, entry.totalBytes)
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

        // S-16：稳定 .part 缓存（独立于 .staging）+ Range 续传。半成品只进 .cache，
        // 保持 staging「安装成功后必须为空」的既有语义。
        const part = partPathFor(file)
        parts.push(part)
        fs.mkdirSync(path.dirname(part), { recursive: true })
        let existing = 0
        try { existing = fs.statSync(part).size } catch {}
        if (existing > file.bytes) {
          try { fs.rmSync(part, { force: true }) } catch {}
          existing = 0
        }
        if (existing > 0 && existing === file.bytes) {
          let reusable = false
          try { reusable = sha256FileSync(part) === file.sha256 } catch { reusable = false }
          if (reusable) {
            fs.copyFileSync(part, target)
            job.progress.bytes += file.bytes
            job.progress.done += 1
            continue
          }
          // 长度对但 hash 不符：这份半成品不可信，从头下。
          try { fs.rmSync(part, { force: true }) } catch {}
          existing = 0
        }

        // S-1：总超时 + 分块 stall 超时。任一触发都中断响应体流，避免 CDN 半开
        // 连接让 for-await 永久 pending；超时单独记账，别被误判成用户取消。
        let timedOut = false
        const totalSignal = AbortSignal.timeout(fetchTimeoutMs)
        totalSignal.addEventListener('abort', () => { timedOut = true }, { once: true })
        const stallController = new AbortController()
        let stallTimer = null
        const armStall = () => {
          if (stallTimer) clearTimeout(stallTimer)
          stallTimer = setTimeout(() => { timedOut = true; stallController.abort() }, stallTimeoutMs)
          stallTimer.unref?.()
        }
        const clearStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null } }
        const timeoutFailure = cause => fail('EMBEDDING_DOWNLOAD_TIMEOUT', `download of ${file.path} timed out (total ${fetchTimeoutMs}ms / stall ${stallTimeoutMs}ms)`, { cause })
        const abortedFailure = cause => fail('EMBEDDING_DOWNLOAD_ABORTED', `download of ${entry.id} was aborted`, { cause })
        // 磁盘写失败清 .part；超时/取消保留 .part 供下次 Range 续传。
        let removePart = false
        const streamFailure = error => {
          if (timedOut && !controller.signal.aborted) return timeoutFailure(error)
          if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'UND_ERR_ABORTED') return abortedFailure(error)
          if (['ENOSPC', 'EIO', 'EROFS', 'EDQUOT', 'EFBIG'].includes(String(error?.code || ''))) {
            removePart = true
            return fail('EMBEDDING_DISK_FULL', `cannot write ${file.path}: ${error.code}; partial download removed`, { cause: error })
          }
          return error
        }
        armStall()
        const signal = AbortSignal.any([controller.signal, totalSignal, stallController.signal])
        const headers = { 'accept-encoding': 'identity' }
        if (existing > 0) headers.Range = `bytes=${existing}-`
        let response
        try {
          response = await fetchImpl(file.url, { signal, redirect: 'follow', headers })
        } catch (error) {
          if (timedOut && !controller.signal.aborted) throw timeoutFailure(error)
          if (isAbort(error, controller.signal)) throw abortedFailure(error)
          throw fail('EMBEDDING_NETWORK_ERROR', `cannot fetch ${file.path} from ${source.provider}: ${error?.message || error}`, { cause: error })
        }
        if (!response || !response.ok) {
          throw fail('EMBEDDING_HTTP_ERROR', `${source.provider} returned ${response?.status ?? 'no response'} for ${file.path}`)
        }
        let append = existing > 0
        if (append && response.status === 200) {
          // 源忽略了 Range，丢弃 .part 从头下，避免把整段内容追加到半成品后面。
          job.progress.bytes = Math.max(0, job.progress.bytes - existing)
          try { fs.rmSync(part, { force: true }) } catch {}
          append = false
          existing = 0
        } else if (append) {
          const contentRange = String(response.headers?.get?.('content-range') || '')
          const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(contentRange)
          if (response.status !== 206 || !match || Number(match[1]) !== existing || Number(match[3]) !== file.bytes) {
            throw fail('EMBEDDING_SIZE_MISMATCH', `${file.path} returned an unexpected Content-Range for resume: ${contentRange || '(missing)'}`)
          }
        }
        // 没有 content-length（hf-mirror 对小文件用 chunked 传输）等于「未知」，不是 0：
        // 当成 0 会把每个小文件都误判成大小不符。真正的门槛是下面落盘后的 sha256。
        const declaredHeader = response.headers?.get?.('content-length')
        const declaredLength = Number(declaredHeader)
        const expectedLength = file.bytes - existing
        if (declaredHeader != null && Number.isInteger(declaredLength) && declaredLength > 0 && declaredLength !== expectedLength) {
          throw fail('EMBEDDING_SIZE_MISMATCH', `${file.path} content-length ${declaredLength} does not match the expected ${expectedLength} bytes`)
        }
        let size = existing
        const fd = fs.openSync(part, append ? 'a' : 'w', 0o600)
        try {
          const body = response.body
          if (body && typeof body[Symbol.asyncIterator] === 'function') {
            try {
              for await (const chunk of body) {
                if (controller.signal.aborted) throw abortedFailure(null)
                armStall()
                size += chunk.length
                if (size > file.bytes) throw fail('EMBEDDING_SIZE_MISMATCH', `${file.path} exceeded the pinned ${file.bytes} bytes`)
                fs.writeSync(fd, chunk)
                job.progress.bytes += chunk.length
              }
            } catch (error) { throw streamFailure(error) }
          } else {
            try {
              const buffer = Buffer.from(await response.arrayBuffer())
              size += buffer.length
              if (size > file.bytes) throw fail('EMBEDDING_SIZE_MISMATCH', `${file.path} exceeded the pinned ${file.bytes} bytes`)
              fs.writeSync(fd, buffer)
              job.progress.bytes += buffer.length
            } catch (error) { throw streamFailure(error) }
          }
        } finally {
          clearStall()
          try { fs.closeSync(fd) } catch {}
          if (removePart) { try { fs.rmSync(part, { force: true }) } catch {} }
        }
        if (size !== file.bytes) {
          try { fs.rmSync(part, { force: true }) } catch {}
          throw fail('EMBEDDING_SIZE_MISMATCH', `${file.path} is ${size} bytes, expected ${file.bytes}`)
        }
        const digest = sha256FileSync(part)
        if (digest !== file.sha256) {
          try { fs.rmSync(part, { force: true }) } catch {}
          throw fail('EMBEDDING_HASH_MISMATCH', `${file.path} sha256 ${digest} does not match the pinned ${file.sha256}`)
        }
        try {
          fs.copyFileSync(part, target)
        } catch (error) {
          throw fail('EMBEDDING_INSTALL_FAILED', `cannot stage ${file.path}: ${error?.code || error?.message || error}; partial download removed`, { cause: error })
        }
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
      // S-16：非可续传类失败清掉 .part，别让半成品占空间；网络错误/超时/取消
      // 保留 .part 供下次 Range 续传（S-1）。
      if (!['EMBEDDING_DOWNLOAD_ABORTED', 'EMBEDDING_NETWORK_ERROR', 'EMBEDDING_DOWNLOAD_TIMEOUT'].includes(code)) {
        for (const part of parts) { try { fs.rmSync(part, { force: true }) } catch {} }
      }
      job.state = aborted ? 'cancelled' : 'failed'
      job.error = { code, message: String(failed.message || error) }
      jobs.delete(entry.id)
      outcomes.set(entry.id, { state: job.state, error: { ...job.error } })
      throw failed
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (staging && !installed) { try { fs.rmSync(staging, { recursive: true, force: true }) } catch {} }
      // 安装成功后本次的 .part 已完成使命，清掉避免长期占空间。
      if (installed) { for (const part of parts) { try { fs.rmSync(part, { force: true }) } catch {} } }
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
