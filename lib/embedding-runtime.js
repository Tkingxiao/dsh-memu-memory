import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { ensureDir, readJsonStrict, writeJson } from './paths.js'
import { getEmbeddingCatalog, getEmbeddingModel } from './embedding-catalog.js'

// §14.13 受管 embedding runtime 安装器。
//
// 目标：用户装好插件、MemU 和已核实的 BGE 制品后，不需要再手写
// DSH_MEMU_EMBED_RUNTIME_DIR，也不需要装 Ollama 之类的第二个服务——首次需要时由本模块
// 把目录里 pin 住的运行时制品装进受管目录，然后原子切一个 active 指针。
//
// 硬约束（每一条都由下面的代码守卫，不是注释口号）：
//  1. 只用 catalog 里显式写出的 https URL + 逐字节 sha256/bytes；缺任何一项就拒绝安装
//     （LOCAL_VECTOR_RUNTIME_UNVERIFIED），绝不猜 hash、绝不落到「装了个大概能用的东西」。
//  2. 不跑 npm、不跑 postinstall、不读宿主 node_modules：tarball 按白名单解包，
//     postinstall 专用依赖（adm-zip/global-agent/...）根本不落盘。
//  3. 不支持的平台（catalog 没有该平台原生库 hash）fail-closed 报 unsupported。
//  4. staging → 字节/hash 校验 → 解包 → 逐文件核对 → 原生加载 smoke → 原子发布。
//     失败、取消、hash 不符都在 staging 里结束，active 指针保持不动。
//  5. 幂等 + 并发安全：同进程 join 同一个 promise，跨进程用 staging 里的 pid 锁；
//     已安装且核对通过就直接复用，重启后不重下 115 MB。

export const RUNTIME_RECORD = 'installed.json'
export const RUNTIME_ACTIVE = 'active.json'
export const RUNTIME_STAGING = '.staging'
export const RUNTIME_TRASH = '.trash'
export const RUNTIME_LAYOUT = 'node_modules'
export const RUNTIME_STATES = Object.freeze(['unknown', 'unsupported', 'absent', 'downloading', 'verifying', 'installing', 'installed', 'failed', 'cancelled'])

const DEFAULT_MAX_ARTIFACT_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_FILE_BYTES = 128 * 1024 * 1024
const DEFAULT_SMOKE_TIMEOUT_MS = 120_000
const DEFAULT_FETCH_TIMEOUT_MS = 600_000
const READY_LIMIT = 8_192

// The child smoke process needs the OS basics and nothing else: an inherited proxy
// variable could reroute a request and an inherited *_API_KEY would hand a cloud
// credential to a process whose whole job is loading a local .node file.
const DENIED_ENV_NAMES = Object.freeze(['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'node_options', 'node_path'])
const DENIED_ENV_PREFIXES = Object.freeze(['memu_', 'dsh_memu_embed_', 'openai_', 'azure_openai_', 'anthropic_', 'gemini_', 'google_', 'cohere_'])

function failure(code, message, extra) {
  const error = new Error(message)
  error.code = code
  if (extra) Object.assign(error, extra)
  return error
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isAbort(error, signal) {
  return Boolean(signal?.aborted) || error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'UND_ERR_ABORTED' || error?.code === 'LOCAL_VECTOR_RUNTIME_ABORTED'
}

function sha256Of(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

export function embeddingRuntimePlatform(platform = process.platform, arch = process.arch) {
  return String(platform) + '-' + String(arch)
}

// catalog 的 <platform> 占位符是 'win32/x64' 这种目录形状，catalog 的 key 是 'win32-x64'。
export function runtimeNativeDir(platform) {
  return String(platform).replace('-', '/')
}

export function runtimeKeyFor(entry, platform = embeddingRuntimePlatform()) {
  const runtime = isPlainObject(entry?.runtime) ? entry.runtime : {}
  return [String(runtime.engine || 'onnxruntime-node'), String(runtime.version || 'unpinned'), String(runtime.abi || 'unknown'), String(platform)].join('@').replace(/[^A-Za-z0-9._@-]+/g, '-')
}

/** 把 catalog 条目里的 runtime 事实整成一个可执行的安装计划；任何一项不完整都 fail-closed。 */
export function runtimePlan(entry, platform = embeddingRuntimePlatform()) {
  const errors = []
  const reject = (code, message) => errors.push({ code, message })
  const runtime = isPlainObject(entry?.runtime) ? entry.runtime : null
  const key = runtimeKeyFor(entry, platform)
  const empty = { ok: false, errors, key, platform, engine: null, version: null, abi: null, artifacts: [], packageFiles: [], native: [] }
  if (!runtime) {
    reject('RUNTIME_SPEC_MISSING', 'the catalog entry has no runtime spec')
    return empty
  }
  if (entry?.availability !== 'available') reject('RUNTIME_ENTRY_NOT_AVAILABLE', `${String(entry?.id ?? 'unknown model')} is not an available catalog entry; no runtime may be installed for it`)
  const engine = String(runtime.engine || '').trim()
  const version = String(runtime.version || '').trim()
  const abi = String(runtime.abi || '').trim()
  if (!engine) reject('RUNTIME_ENGINE_MISSING', 'runtime.engine is required')
  if (!version) reject('RUNTIME_VERSION_UNPINNED', 'runtime.version must be a pinned version, not null')
  if (!abi) reject('RUNTIME_ABI_MISSING', 'runtime.abi is required')
  const artifacts = []
  for (const artifact of Array.isArray(runtime.artifacts) ? runtime.artifacts : []) {
    if (!isPlainObject(artifact)) { reject('RUNTIME_ARTIFACT_INVALID', 'each runtime artifact must be an object'); continue }
    const name = String(artifact.name || '')
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)) reject('RUNTIME_ARTIFACT_NAME_INVALID', `invalid artifact name: ${JSON.stringify(artifact.name)}`)
    let url = null
    try { url = new URL(String(artifact.url || '')) } catch { url = null }
    if (!url || url.protocol !== 'https:') reject('RUNTIME_ARTIFACT_URL_INVALID', `artifact ${name} needs a pinned https URL`)
    if (!Number.isInteger(artifact.bytes) || artifact.bytes <= 0) reject('RUNTIME_ARTIFACT_BYTES_INVALID', `artifact ${name} needs exact bytes`)
    if (!isSha256(artifact.sha256)) reject('RUNTIME_ARTIFACT_SHA256_INVALID', `artifact ${name} needs a lowercase sha256; guessed hashes are not accepted`)
    if (!Array.isArray(artifact.extract) || !artifact.extract.length) reject('RUNTIME_ARTIFACT_EXTRACT_MISSING', `artifact ${name} needs an explicit extraction allow-list`)
    artifacts.push({
      name,
      version: String(artifact.version || version),
      url: url ? url.href : null,
      bytes: Number.isInteger(artifact.bytes) ? artifact.bytes : null,
      sha256: String(artifact.sha256 || ''),
      integrity: typeof artifact.integrity === 'string' ? artifact.integrity : null,
      license: typeof artifact.license === 'string' ? artifact.license : null,
      extract: Array.isArray(artifact.extract) ? artifact.extract.map(item => String(item)) : [],
    })
  }
  if (!artifacts.length) reject('RUNTIME_ARTIFACTS_MISSING', 'the runtime spec lists no pinned artifacts; nothing will be downloaded')
  const packageFiles = []
  for (const file of Array.isArray(runtime.packageFiles) ? runtime.packageFiles : []) {
    if (!isPlainObject(file) || typeof file.package !== 'string' || !file.package) { reject('RUNTIME_PACKAGE_FILE_INVALID', 'each packageFiles entry needs a package name'); continue }
    if (!Number.isInteger(file.bytes) || file.bytes <= 0) reject('RUNTIME_PACKAGE_FILE_INVALID', `packageFiles ${file.package} needs exact bytes`)
    if (!isSha256(file.sha256)) reject('RUNTIME_PACKAGE_FILE_INVALID', `packageFiles ${file.package} needs a lowercase sha256`)
    packageFiles.push({ package: file.package, path: `${RUNTIME_LAYOUT}/${file.package}/package.json`, bytes: Number(file.bytes), sha256: String(file.sha256) })
  }
  if (!packageFiles.length) reject('RUNTIME_PACKAGE_FILES_MISSING', 'the runtime spec pins no package.json facts; the extracted tree cannot be verified')
  const native = []
  for (const file of Array.isArray(runtime.native?.[platform]) ? runtime.native[platform] : []) {
    if (!isPlainObject(file) || typeof file.path !== 'string' || !file.path.startsWith(RUNTIME_LAYOUT + '/')) { reject('RUNTIME_NATIVE_INVALID', 'each native file needs a path inside node_modules'); continue }
    if (file.path.includes('..') || path.isAbsolute(file.path) || file.path.includes('\\')) { reject('RUNTIME_NATIVE_INVALID', `unsafe native path: ${JSON.stringify(file.path)}`); continue }
    if (!Number.isInteger(file.bytes) || file.bytes <= 0) reject('RUNTIME_NATIVE_INVALID', `native file ${file.path} needs exact bytes`)
    if (!isSha256(file.sha256)) reject('RUNTIME_NATIVE_INVALID', `native file ${file.path} needs a lowercase sha256`)
    native.push({ path: file.path, bytes: Number(file.bytes), sha256: String(file.sha256) })
  }
  if (!native.length) reject('RUNTIME_NATIVE_MISSING', `no verified native runtime is pinned for ${platform}; refusing to install on this platform`)
  return { ok: errors.length === 0, errors, key, platform, engine: engine || null, version: version || null, abi: abi || null, artifacts, packageFiles, native }
}

/** 下载到的字节必须与 pin 的 bytes+sha256 完全一致；不匹配一律拒绝执行。 */
export function verifyRuntimeArtifact(bytes, artifact) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? [])
  if (!isSha256(artifact?.sha256)) throw failure('LOCAL_VECTOR_RUNTIME_UNVERIFIED', `artifact ${String(artifact?.name || '?')} has no pinned sha256; refusing to install`)
  if (!Number.isSafeInteger(artifact?.bytes) || artifact.bytes <= 0) throw failure('LOCAL_VECTOR_RUNTIME_UNVERIFIED', `artifact ${String(artifact?.name || '?')} has no exact byte count`)
  if (buffer.length !== artifact.bytes) {
    throw failure('LOCAL_VECTOR_RUNTIME_SIZE_MISMATCH', `artifact ${String(artifact.name)} is ${buffer.length} bytes, expected ${artifact.bytes}`)
  }
  const digest = sha256Of(buffer)
  if (digest !== artifact.sha256) {
    throw failure('LOCAL_VECTOR_RUNTIME_HASH_MISMATCH', `artifact ${String(artifact.name)} sha256 ${digest} does not match the pinned ${artifact.sha256}`)
  }
  return digest
}

/** tar 条目白名单：只允许 catalog 里写出的前缀，且必须换成该平台的原生库目录。 */
export function extractAllowList(artifact, platform) {
  const nativeDir = runtimeNativeDir(platform)
  return (Array.isArray(artifact?.extract) ? artifact.extract : [])
    .map(item => String(item).replace('<platform>', nativeDir))
    .map(item => item.replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter(Boolean)
}

// Windows 上刚写完的目录会被杀软/索引器短暂占用，rename 会抛 EPERM/EBUSY；
// 这是可恢复的瞬时错误，重试几次再判失败，别把「正在被扫描」当成「装坏了」。
async function renameWithRetry(from, to, options = {}) {
  const attempts = Number.isFinite(options.attempts) ? options.attempts : 6
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : 60
  let last = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error) {
      last = error
      const code = String(error?.code || '')
      if (attempt === attempts || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(code)) break
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt))
    }
  }
  throw last
}

export function createEmbeddingRuntimeInstaller(options = {}) {
  const root = options.root
  if (typeof root !== 'string' || !root.trim()) throw new TypeError('createEmbeddingRuntimeInstaller requires a root directory')
  const baseDir = path.resolve(root)
  const platform = String(options.platform || embeddingRuntimePlatform())
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn
  const executable = String(options.executable || process.execPath)
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString()
  const logger = options.logger || null
  const maxArtifactBytes = Number.isInteger(options.maxArtifactBytes) ? options.maxArtifactBytes : DEFAULT_MAX_ARTIFACT_BYTES
  const maxFileBytes = Number.isInteger(options.maxFileBytes) ? options.maxFileBytes : DEFAULT_MAX_FILE_BYTES
  const smokeTimeoutMs = Number.isInteger(options.smokeTimeoutMs) ? options.smokeTimeoutMs : DEFAULT_SMOKE_TIMEOUT_MS
  const fetchTimeoutMs = Number.isInteger(options.fetchTimeoutMs) ? options.fetchTimeoutMs : DEFAULT_FETCH_TIMEOUT_MS
  const extract = typeof options.extract === 'function' ? options.extract : defaultExtract
  const smoke = typeof options.smoke === 'function' ? options.smoke : defaultSmoke
  const resolveEntry = typeof options.resolveEntry === 'function' ? options.resolveEntry : id => (id ? getEmbeddingModel(String(id)) : null)
  const activeFile = path.join(baseDir, RUNTIME_ACTIVE)
  const inflight = new Map()
  let job = null
  let outcome = null
  let disposed = false

  const warn = message => { try { logger?.warn?.(message) } catch {} }

  function insideRoot(target) {
    const resolved = path.resolve(target)
    if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
      throw failure('LOCAL_VECTOR_RUNTIME_PATH_ESCAPE', `refusing to touch a path outside the managed runtime root: ${resolved}`)
    }
    return resolved
  }

  function readActive() {
    const result = readJsonStrict(activeFile)
    if (!result.ok || !isPlainObject(result.value)) return null
    const value = result.value
    if (typeof value.key !== 'string' || typeof value.dir !== 'string' || typeof value.platform !== 'string') return null
    return value
  }

  function readRecord(dir) {
    const result = readJsonStrict(path.join(dir, RUNTIME_RECORD))
    return result.ok && isPlainObject(result.value) ? result.value : null
  }

  // The archive hash authenticates every extracted file, not only package/native pins.
  // Keep that complete inventory and reject new files or links before any runtime reuse.
  function inventoryTree(plan, dir, { deep = true, allowRecord = false } = {}) {
    const files = []
    const allowed = plan.artifacts.flatMap(artifact => extractAllowList(artifact, plan.platform).map(prefix => RUNTIME_LAYOUT + '/' + artifact.name + '/' + prefix))
    if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw failure('LOCAL_VECTOR_RUNTIME_PATH_ESCAPE', 'runtime root must be a real directory')
    const visit = (parent, relative = '') => {
      for (const name of fs.readdirSync(parent).sort()) {
        const rel = relative ? relative + '/' + name : name
        const target = path.join(parent, name)
        const stat = fs.lstatSync(target)
        if (stat.isSymbolicLink()) throw failure('LOCAL_VECTOR_RUNTIME_UNEXPECTED_FILE', 'runtime inventory contains a link: ' + rel)
        if (allowRecord && rel === RUNTIME_RECORD && stat.isFile()) continue
        if (stat.isDirectory()) {
          if (!allowed.some(prefix => prefix === rel || prefix.startsWith(rel + '/') || rel.startsWith(prefix + '/'))) throw failure('LOCAL_VECTOR_RUNTIME_UNEXPECTED_FILE', 'runtime inventory contains an unlisted directory: ' + rel)
          visit(target, rel)
        } else if (stat.isFile()) {
          if (!allowed.some(prefix => rel === prefix || rel.startsWith(prefix + '/'))) throw failure('LOCAL_VECTOR_RUNTIME_UNEXPECTED_FILE', 'runtime inventory contains an unlisted file: ' + rel)
          if (stat.size > maxFileBytes) throw failure('LOCAL_VECTOR_RUNTIME_TOO_LARGE', 'runtime inventory file exceeds its limit: ' + rel)
          files.push({ path: rel, bytes: stat.size, ...(deep ? { sha256: sha256Of(fs.readFileSync(target)) } : {}) })
        } else {
          throw failure('LOCAL_VECTOR_RUNTIME_UNEXPECTED_FILE', 'runtime inventory contains a non-regular entry: ' + rel)
        }
      }
    }
    visit(dir)
    return files
  }

  // 复用判定：便宜（只比字节数）还是彻底（重算 sha256）由调用方决定。
  // 便宜路径抓「文件被删/被换/明显截断」，彻底路径抓内容差异；两者都不猜。
  function inspectPlan(plan, { deep = false } = {}) {
    const active = readActive()
    if (!active) return { ok: false, code: 'LOCAL_VECTOR_RUNTIME_ABSENT' }
    if (active.key !== plan.key || active.platform !== plan.platform) return { ok: false, code: 'LOCAL_VECTOR_RUNTIME_STALE' }
    let dir
    try { dir = insideRoot(active.dir) } catch { return { ok: false, code: 'LOCAL_VECTOR_RUNTIME_PATH_ESCAPE' } }
    const record = readRecord(dir)
    if (!record) return { ok: false, code: 'LOCAL_VECTOR_RUNTIME_RECORD_MISSING' }
    if (record.key !== plan.key || record.platform !== plan.platform || record.engine !== plan.engine || record.version !== plan.version || record.abi !== plan.abi) return { ok: false, code: 'LOCAL_VECTOR_RUNTIME_RECORD_STALE' }
    const recordedArtifacts = Array.isArray(record.artifacts) ? record.artifacts : []
    if (recordedArtifacts.length !== plan.artifacts.length || plan.artifacts.some(artifact => {
      const saved = recordedArtifacts.find(item => item && item.name === artifact.name)
      return !saved || saved.version !== artifact.version || saved.url !== artifact.url || saved.bytes !== artifact.bytes || saved.sha256 !== artifact.sha256
    })) return { ok: false, code: 'LOCAL_VECTOR_RUNTIME_RECORD_STALE' }
    const expected = [...plan.packageFiles, ...plan.native]
    const recorded = Array.isArray(record.files) ? record.files : []
    if (record.inventoryVersion !== 1 || recorded.length < expected.length) return { ok: false, code: 'LOCAL_VECTOR_RUNTIME_RECORD_INCOMPLETE' }
    const byPath = new Map()
    for (const file of recorded) {
      if (!file || typeof file.path !== 'string' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !isSha256(file.sha256) || byPath.has(file.path)) return { ok: false, code: 'LOCAL_VECTOR_RUNTIME_RECORD_INCOMPLETE' }
      byPath.set(file.path, file)
    }
    for (const file of expected) {
      const pinned = byPath.get(file.path)
      if (!pinned || pinned.sha256 !== file.sha256 || pinned.bytes !== file.bytes) return { ok: false, code: 'LOCAL_VECTOR_RUNTIME_RECORD_STALE', path: file.path }
    }
    let actual
    try { actual = inventoryTree(plan, dir, { deep, allowRecord: true }) } catch (error) { return { ok: false, code: error?.code || 'LOCAL_VECTOR_RUNTIME_INCOMPLETE' } }
    if (actual.length !== recorded.length) return { ok: false, code: 'LOCAL_VECTOR_RUNTIME_UNEXPECTED_FILE' }
    for (const file of actual) {
      const pinned = byPath.get(file.path)
      if (!pinned) return { ok: false, code: 'LOCAL_VECTOR_RUNTIME_UNEXPECTED_FILE', path: file.path }
      if (file.bytes !== pinned.bytes) return { ok: false, code: 'LOCAL_VECTOR_RUNTIME_INCOMPLETE', path: file.path }
      if (deep && file.sha256 !== pinned.sha256) return { ok: false, code: 'LOCAL_VECTOR_RUNTIME_HASH_MISMATCH', path: file.path }
    }
    return { ok: true, dir, record }
  }

  function planFor(modelId) {
    const entry = resolveEntry(modelId)
    if (!entry) {
      const fallback = getEmbeddingCatalog().find(item => item.availability === 'available')
      if (!fallback) throw failure('LOCAL_VECTOR_RUNTIME_UNVERIFIED', 'no available catalog entry pins a runtime; nothing will be installed')
      return { entry: fallback, plan: runtimePlan(fallback, platform) }
    }
    return { entry, plan: runtimePlan(entry, platform) }
  }

  function status({ deep = false, modelId = null } = {}) {
    const base = { source: 'managed', platform, root: baseDir }
    let resolved = null
    try { resolved = planFor(modelId) } catch (error) { return { ...base, status: 'unsupported', ready: false, key: null, path: null, error: { code: String(error?.code || 'LOCAL_VECTOR_RUNTIME_UNVERIFIED'), message: String(error?.message || error) } } }
    const entry = resolved.entry
    const plan = resolved.plan
    const pinned = { key: plan.key, engine: plan.engine, version: plan.version, abi: plan.abi, artifacts: plan.artifacts.map(item => ({ name: item.name, version: item.version, bytes: item.bytes, sha256: item.sha256, license: item.license })), verifiedPlatforms: Object.keys(entry?.runtime?.install?.platforms || {}) }
    if (!plan.ok) {
      return { ...base, ...pinned, status: 'unsupported', ready: false, path: null, error: { code: 'LOCAL_VECTOR_RUNTIME_UNVERIFIED', message: 'the catalog does not pin a complete runtime for this platform', errors: plan.errors } }
    }
    if (job && job.key === plan.key) {
      return { ...base, ...pinned, status: job.state, ready: false, path: null, progress: { ...job.progress }, startedAt: job.startedAt }
    }
    const inspect = inspectPlan(plan, { deep })
    if (inspect.ok) {
      return { ...base, ...pinned, status: 'installed', ready: true, path: inspect.dir, installedAt: inspect.record.installedAt || null, verifiedAt: inspect.record.verifiedAt || null, checks: Array.isArray(inspect.record.checks) ? [...inspect.record.checks] : [], smoke: inspect.record.smoke || null }
    }
    if (outcome && outcome.key === plan.key && outcome.status === 'failed') {
      return { ...base, ...pinned, status: 'failed', ready: false, path: null, error: { ...outcome.error }, inspect: inspect.code }
    }
    return { ...base, ...pinned, status: 'absent', ready: false, path: null, inspect: inspect.code }
  }

  function activeDir({ deep = false, modelId = null } = {}) {
    const current = status({ deep, modelId })
    return current.status === 'installed' ? current.path : null
  }

  function acquireLock(stagingRoot) {
    ensureDir(stagingRoot)
    const lockFile = path.join(stagingRoot, 'install.lock')
    const token = crypto.randomUUID()
    const contents = JSON.stringify({ pid: process.pid, at: Date.now(), token })
    const release = () => {
      try { if (fs.readFileSync(lockFile, 'utf8') === contents) fs.unlinkSync(lockFile) } catch {}
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(lockFile, 'wx', 0o600)
        try { fs.writeFileSync(fd, contents) } finally { fs.closeSync(fd) }
        return release
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        let owner = null
        let observed = null
        try { observed = fs.readFileSync(lockFile, 'utf8'); owner = JSON.parse(observed) } catch {}
        // Age is not proof of death. Unknown owners and EPERM probes stay busy.
        let dead = false
        if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0) } catch (probe) { dead = probe?.code === 'ESRCH' }
        }
        if (!dead) throw failure('LOCAL_VECTOR_RUNTIME_BUSY', 'another process is installing the managed embedding runtime; retry when it finishes')
        try { if (fs.readFileSync(lockFile, 'utf8') === observed) fs.unlinkSync(lockFile) } catch {}
      }
    }
    throw failure('LOCAL_VECTOR_RUNTIME_BUSY', 'cannot take the managed runtime install lock; retry later')
  }

  async function downloadArtifact(artifact, targetDir, controller) {
    if (!Number.isInteger(artifact.bytes) || artifact.bytes <= 0) throw failure('LOCAL_VECTOR_RUNTIME_UNVERIFIED', `artifact ${artifact.name} has no exact byte count`)
    if (artifact.bytes > maxArtifactBytes) throw failure('LOCAL_VECTOR_RUNTIME_TOO_LARGE', `artifact ${artifact.name} declares ${artifact.bytes} bytes, above the ${maxArtifactBytes} byte cap`)
    const target = path.join(targetDir, `${artifact.name.replace(/[^A-Za-z0-9._-]+/g, '-')}.tgz`)
    let response
    try {
      response = await fetchImpl(artifact.url, { signal: controller.signal, redirect: 'follow', headers: { 'accept-encoding': 'identity' } })
    } catch (error) {
      if (isAbort(error, controller.signal)) throw failure('LOCAL_VECTOR_RUNTIME_ABORTED', 'the managed runtime install was aborted', { cause: error })
      throw failure('LOCAL_VECTOR_RUNTIME_NETWORK_ERROR', `cannot fetch ${artifact.name}: ${error?.message || error}`, { cause: error })
    }
    if (!response || !response.ok) throw failure('LOCAL_VECTOR_RUNTIME_HTTP_ERROR', `registry returned ${response?.status ?? 'no response'} for ${artifact.name}`)
    const declared = Number(response.headers?.get?.('content-length'))
    if (Number.isFinite(declared) && declared > 0 && declared !== artifact.bytes) {
      throw failure('LOCAL_VECTOR_RUNTIME_SIZE_MISMATCH', `${artifact.name} content-length ${declared} does not match the pinned ${artifact.bytes} bytes`)
    }
    const hash = crypto.createHash('sha256')
    let size = 0
    const fd = fs.openSync(target, 'wx', 0o600)
    try {
      const body = response.body
      if (body && typeof body[Symbol.asyncIterator] === 'function') {
        for await (const chunk of body) {
          if (controller.signal.aborted) throw failure('LOCAL_VECTOR_RUNTIME_ABORTED', 'the managed runtime install was aborted')
          size += chunk.length
          if (size > artifact.bytes) throw failure('LOCAL_VECTOR_RUNTIME_SIZE_MISMATCH', `${artifact.name} exceeded the pinned ${artifact.bytes} bytes`)
          hash.update(chunk)
          fs.writeSync(fd, chunk)
          job.progress.bytes += chunk.length
        }
      } else {
        const buffer = Buffer.from(await response.arrayBuffer())
        size = buffer.length
        if (size > artifact.bytes) throw failure('LOCAL_VECTOR_RUNTIME_SIZE_MISMATCH', `${artifact.name} exceeded the pinned ${artifact.bytes} bytes`)
        hash.update(buffer)
        fs.writeSync(fd, buffer)
        job.progress.bytes += buffer.length
      }
    } finally {
      fs.closeSync(fd)
    }
    if (size !== artifact.bytes) throw failure('LOCAL_VECTOR_RUNTIME_SIZE_MISMATCH', `${artifact.name} is ${size} bytes, expected ${artifact.bytes}`)
    const digest = hash.digest('hex')
    if (digest !== artifact.sha256) throw failure('LOCAL_VECTOR_RUNTIME_HASH_MISMATCH', `${artifact.name} sha256 ${digest} does not match the pinned ${artifact.sha256}`)
    return { path: target, bytes: size, sha256: digest }
  }

  function verifyExtracted(plan, dir) {
    const checks = []
    for (const file of plan.packageFiles) {
      const target = path.join(dir, ...file.path.split('/'))
      let bytes
      try { bytes = fs.readFileSync(target) } catch { throw failure('LOCAL_VECTOR_RUNTIME_INCOMPLETE', `the extracted tree has no ${file.path}`) }
      if (bytes.length !== file.bytes) throw failure('LOCAL_VECTOR_RUNTIME_SIZE_MISMATCH', `${file.path} is ${bytes.length} bytes, expected ${file.bytes}`)
      const digest = sha256Of(bytes)
      if (digest !== file.sha256) throw failure('LOCAL_VECTOR_RUNTIME_HASH_MISMATCH', `${file.path} sha256 ${digest} does not match the pinned ${file.sha256}`)
      checks.push(`${file.path}@${digest.slice(0, 12)}`)
    }
    for (const file of plan.native) {
      const target = path.join(dir, ...file.path.split('/'))
      let stat
      try { stat = fs.statSync(target) } catch { throw failure('LOCAL_VECTOR_RUNTIME_INCOMPLETE', `the extracted tree has no ${file.path}`) }
      if (!stat.isFile() || stat.size !== file.bytes) throw failure('LOCAL_VECTOR_RUNTIME_SIZE_MISMATCH', `${file.path} is not the pinned ${file.bytes} bytes`)
      const digest = sha256Of(fs.readFileSync(target))
      if (digest !== file.sha256) throw failure('LOCAL_VECTOR_RUNTIME_HASH_MISMATCH', `${file.path} sha256 ${digest} does not match the pinned ${file.sha256}`)
      checks.push(`${path.posix.basename(file.path)}@${digest.slice(0, 12)}`)
    }
    // 解包白名单不能被绕过成「多装了别的东西」：平台目录里只许出现 pin 住的文件。
    const nativeRoot = path.posix.join(RUNTIME_LAYOUT, 'onnxruntime-node', 'bin', plan.abi?.startsWith('napi') ? plan.abi : 'napi-v6', runtimeNativeDir(plan.platform))
    const expectedNative = new Set(plan.native.map(file => String(file.path).split('/').pop()))
    let entries = []
    try { entries = fs.readdirSync(path.join(dir, ...nativeRoot.split('/'))) } catch { entries = [] }
    if (entries.length) {
      const unexpected = entries.filter(name => !expectedNative.has(name))
      if (unexpected.length) throw failure('LOCAL_VECTOR_RUNTIME_UNEXPECTED_FILE', `the extracted native directory contains unexpected files: ${unexpected.join(', ')}`)
    }
    return checks
  }

  async function install(plan, options) {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const totalBytes = plan.artifacts.reduce((sum, artifact) => sum + (artifact.bytes || 0), 0)
    job = {
      key: plan.key,
      state: 'downloading',
      startedAt: now(),
      controller,
      progress: { artifacts: plan.artifacts.length, done: 0, bytes: 0, totalBytes, current: null },
    }
    const report = () => { try { options.onProgress?.({ ...job.progress }) } catch {} }
    let staging = null
    let release = null
    let published = false
    try {
      const stagingRoot = insideRoot(path.join(baseDir, RUNTIME_STAGING))
      release = acquireLock(stagingRoot)
      // 抢到锁之后先重看一眼：另一个进程可能刚刚装完，这时直接复用，不重复下载 115 MB。
      const existing = inspectPlan(plan, { deep: true })
      if (existing.ok) {
        job = null
        return { status: 'installed', ready: true, reused: true, key: plan.key, platform: plan.platform, path: existing.dir, engine: plan.engine, version: plan.version, abi: plan.abi, installedAt: existing.record.installedAt || null, verifiedAt: existing.record.verifiedAt || null, checks: Array.isArray(existing.record.checks) ? existing.record.checks : [], artifacts: plan.artifacts.map(item => ({ name: item.name, version: item.version, bytes: item.bytes, sha256: item.sha256 })), smoke: existing.record.smoke || null }
      }
      staging = fs.mkdtempSync(path.join(stagingRoot, 'install-'))
      const artifactDir = ensureDir(path.join(staging, '.artifacts'))
      const archives = []
      for (const artifact of plan.artifacts) {
        if (controller.signal.aborted) throw failure('LOCAL_VECTOR_RUNTIME_ABORTED', 'the managed runtime install was aborted')
        job.progress.current = artifact.name
        report()
        const saved = await downloadArtifact(artifact, artifactDir, controller)
        archives.push({ artifact, file: saved.path })
        job.progress.done += 1
      }
      job.state = 'verifying'
      job.progress.current = null
      report()
      for (const { artifact, file } of archives) {
        const allowList = extractAllowList(artifact, plan.platform)
        if (!allowList.length) throw failure('LOCAL_VECTOR_RUNTIME_UNVERIFIED', `artifact ${artifact.name} has an empty extraction allow-list`)
        const target = ensureDir(path.join(staging, RUNTIME_LAYOUT, artifact.name))
        await extract({ file, cwd: target, allowList, maxFileBytes, artifact })
      }
      try { fs.rmSync(artifactDir, { recursive: true, force: true }) } catch {}
      const checks = verifyExtracted(plan, staging)
      const files = inventoryTree(plan, staging)
      job.state = 'installing'
      report()
      const smokeResult = await smoke({ dir: staging, plan, executable, spawnImpl, timeoutMs: smokeTimeoutMs })
      if (!smokeResult || smokeResult.ok !== true) {
        throw failure('LOCAL_VECTOR_RUNTIME_SMOKE_FAILED', `the extracted runtime cannot load its native modules: ${String(smokeResult?.message || 'unknown reason')}`)
      }
      if (JSON.stringify(inventoryTree(plan, staging)) !== JSON.stringify(files)) throw failure('LOCAL_VECTOR_RUNTIME_HASH_MISMATCH', 'runtime files changed during install smoke')
      const record = {
        schema: 1,
        key: plan.key,
        platform: plan.platform,
        engine: plan.engine,
        version: plan.version,
        abi: plan.abi,
        installedAt: now(),
        verifiedAt: now(),
        source: 'catalog-pinned',
        postinstall: 'never-run',
        inventoryVersion: 1,
        artifacts: plan.artifacts.map(artifact => ({ name: artifact.name, version: artifact.version, url: artifact.url, bytes: artifact.bytes, sha256: artifact.sha256, integrity: artifact.integrity, license: artifact.license })),
        files,
        checks: [...checks, ...(Array.isArray(smokeResult.checks) ? smokeResult.checks : [])],
        smoke: { ok: true, ortVersion: smokeResult.ortVersion || null, tokenizer: smokeResult.tokenizer === true },
      }
      writeJson(path.join(staging, RUNTIME_RECORD), record)
      // Every install gets its own generation. Keep the old active directory in place
      // until the active pointer commit succeeds; this makes pointer-write failure safe.
      const previousActive = readActive()
      const finalDir = insideRoot(path.join(baseDir, plan.key + '-' + crypto.randomUUID()))
      try {
        await renameWithRetry(staging, finalDir)
        staging = null
        published = true
      } catch (error) {
        throw failure('LOCAL_VECTOR_RUNTIME_INSTALL_FAILED', `cannot move the verified runtime into place: ${error?.message || error}`, { cause: error })
      }
      try {
        writeJson(activeFile, { schema: 1, key: plan.key, platform: plan.platform, dir: finalDir, engine: plan.engine, version: plan.version, abi: plan.abi, installedAt: record.installedAt, verifiedAt: record.verifiedAt })
      } catch (error) {
        try { fs.rmSync(finalDir, { recursive: true, force: true }) } catch {}
        throw failure('LOCAL_VECTOR_RUNTIME_INSTALL_FAILED', `cannot publish the managed runtime active pointer: ${error?.message || error}`, { cause: error })
      }
      // Cleanup is deliberately after pointer publication. A stale cleanup failure is harmless.
      if (previousActive?.dir && previousActive.dir !== finalDir) {
        try { fs.rmSync(insideRoot(previousActive.dir), { recursive: true, force: true }) } catch {}
      }
      outcome = null
      job = null
      return { status: 'installed', ready: true, reused: false, key: plan.key, platform: plan.platform, path: finalDir, engine: plan.engine, version: plan.version, abi: plan.abi, installedAt: record.installedAt, verifiedAt: record.verifiedAt, checks: record.checks, artifacts: record.artifacts.map(item => ({ name: item.name, version: item.version, bytes: item.bytes, sha256: item.sha256 })), smoke: record.smoke }
    } catch (error) {
      const aborted = isAbort(error, controller.signal)
      const code = aborted ? 'LOCAL_VECTOR_RUNTIME_ABORTED' : (typeof error?.code === 'string' && error.code.startsWith('LOCAL_VECTOR_RUNTIME_') ? error.code : 'LOCAL_VECTOR_RUNTIME_INSTALL_FAILED')
      const failed = code === error?.code ? error : failure(code, `installing the managed embedding runtime failed: ${error?.message || error}`, { cause: error })
      outcome = { key: plan.key, status: 'failed', error: { code, message: String(failed.message || error) } }
      job = null
      warn(`managed embedding runtime install failed (${code}): ${failed.message}`)
      throw failed
    } finally {
      options.signal?.removeEventListener?.('abort', onAbort)
      try { release?.() } catch {}
      if (staging && !published) { try { fs.rmSync(staging, { recursive: true, force: true }) } catch {} }
    }
  }

  async function ensure(options = {}) {
    if (disposed) throw failure('LOCAL_VECTOR_RUNTIME_CLOSED', 'the managed runtime installer is closed')
    const { entry, plan } = planFor(options.modelId || options.id || null)
    if (!plan.ok) {
      const error = failure('LOCAL_VECTOR_RUNTIME_UNVERIFIED', `no verified managed runtime is available for ${plan.platform}`, { errors: plan.errors, entry: entry?.id ?? null })
      throw error
    }
    const existing = inspectPlan(plan, { deep: true })
    if (existing.ok) {
      return { status: 'installed', ready: true, reused: true, key: plan.key, platform: plan.platform, path: existing.dir, engine: plan.engine, version: plan.version, abi: plan.abi, installedAt: existing.record.installedAt || null, verifiedAt: existing.record.verifiedAt || null, checks: Array.isArray(existing.record.checks) ? existing.record.checks : [], artifacts: plan.artifacts.map(item => ({ name: item.name, version: item.version, bytes: item.bytes, sha256: item.sha256 })), smoke: existing.record.smoke || null }
    }
    const pending = inflight.get(plan.key)
    if (pending) return pending
    if (options.reuseOnly === true) throw failure('LOCAL_VECTOR_RUNTIME_ABSENT', 'the managed embedding runtime is not installed yet', { inspect: existing.code })
    if (options.confirmed !== true) throw failure('LOCAL_VECTOR_RUNTIME_CONFIRMATION_REQUIRED', 'installing the managed embedding runtime downloads pinned artifacts and needs explicit confirmation: ensure({ confirmed: true })')
    if (options.signal?.aborted) throw failure('LOCAL_VECTOR_RUNTIME_ABORTED', 'the managed runtime install was aborted before it started')
    const run = install(plan, options).finally(() => { inflight.delete(plan.key) })
    inflight.set(plan.key, run)
    return run
  }

  function abort() {
    try { job?.controller?.abort() } catch {}
  }

  function dispose() {
    disposed = true
    abort()
  }

  return { root: baseDir, platform, getStatus: status, ensure, activeDir, abort, dispose }
}

// ------------------------------------------------------------------ 默认解包 / 默认 smoke

async function defaultExtract({ file, cwd, allowList, maxFileBytes }) {
  const { x } = await import('tar')
  ensureDir(cwd)
  const allowed = rel => allowList.some(prefix => rel === prefix || rel.startsWith(prefix + '/'))
  const allowDir = rel => allowList.some(prefix => prefix === rel || prefix.startsWith(rel + '/') || rel.startsWith(prefix + '/'))
  await x({
    file,
    cwd,
    strip: 1,
    strict: true,
    preservePaths: false,
    filter: (name, entry) => {
      const rel = String(name || '').replace(/^package\//, '')
      if (!rel || rel === String(name)) return false
      if (rel.includes('..') || path.isAbsolute(rel) || rel.includes('\\')) return false
      if (entry?.type === 'Directory') return allowDir(rel)
      if (entry?.type !== 'File') return false
      if (!allowed(rel)) return false
      return Number(entry.size || 0) <= maxFileBytes
    },
  })
}

const SMOKE_SOURCE = [
  "const path = require('node:path')",
  "const { createRequire } = require('node:module')",
  "const write = value => process.stdout.write(JSON.stringify(value) + '\\n')",
  "try {",
  "  const from = createRequire(path.join(__dirname, 'entry.cjs'))",
  "  const ort = from('onnxruntime-node')",
  "  if (!ort || typeof ort.InferenceSession !== 'function') throw new Error('onnxruntime-node exposes no InferenceSession')",
  "  const pkg = from('onnxruntime-node/package.json')",
  "  const tok = from('@huggingface/tokenizers')",
  "  const Tokenizer = tok && (tok.Tokenizer || (tok.default && tok.default.Tokenizer))",
  "  if (typeof Tokenizer === 'undefined') throw new Error('@huggingface/tokenizers exposes no Tokenizer')",
  "  write({ ok: true, ortVersion: String((pkg && pkg.version) || ''), tokenizer: true })",
  "} catch (error) {",
  "  write({ ok: false, message: String((error && error.message) || error) })",
  "  process.exitCode = 1",
  "}",
].join('\n')

function smokeEnv(extra) {
  const env = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue
    const lower = name.toLowerCase()
    if (DENIED_ENV_NAMES.includes(lower) || lower.includes('proxy')) continue
    if (DENIED_ENV_PREFIXES.some(prefix => lower.startsWith(prefix))) continue
    env[name] = value
  }
  return { ...env, ...extra }
}

async function defaultSmoke({ dir, executable, spawnImpl, timeoutMs }) {
  const script = path.join(dir, '.runtime-smoke.cjs')
  fs.writeFileSync(script, SMOKE_SOURCE + '\n', { mode: 0o600, flag: 'w' })
  try {
    return await new Promise(resolve => {
      let stdout = ''
      let settled = false
      let timer = null
      const finish = value => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(value)
      }
      let child = null
      try {
        child = spawnImpl(executable, [script], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: smokeEnv({ ELECTRON_RUN_AS_NODE: '1' }),
        })
      } catch (error) {
        finish({ ok: false, message: `cannot start the runtime smoke process: ${error?.message || error}` })
        return
      }
      timer = setTimeout(() => {
        try { child?.kill() } catch {}
        finish({ ok: false, message: 'the runtime smoke process did not finish in time' })
      }, timeoutMs)
      timer.unref?.()
      try { child?.stdin?.on?.('error', () => {}) } catch {}
      try { child?.stderr?.on?.('data', () => {}) } catch {}
      child?.on?.('error', error => finish({ ok: false, message: `the runtime smoke process failed: ${error?.message || error}` }))
      child?.stdout?.on?.('data', chunk => {
        stdout += String(chunk)
        if (stdout.length > READY_LIMIT) {
          try { child?.kill() } catch {}
          finish({ ok: false, message: 'the runtime smoke output exceeded the limit' })
        }
      })
      child?.on?.('close', code => {
        const line = stdout.split(String.fromCharCode(10)).map(item => item.replace(/\r+$/, '')).filter(Boolean)[0] || ''
        let parsed = null
        try { parsed = JSON.parse(line) } catch { parsed = null }
        if (parsed && parsed.ok === true) finish({ ok: true, ortVersion: parsed.ortVersion || null, tokenizer: parsed.tokenizer === true, checks: [`smoke:onnxruntime-node@${parsed.ortVersion || 'unknown'}`] })
        else finish({ ok: false, message: String(parsed?.message || `the runtime smoke process exited with code ${code}`) })
      })
    })
  } finally {
    try { fs.rmSync(script, { force: true }) } catch {}
  }
}

let singleton = null
export function managedEmbeddingRuntime(options = {}) {
  if (!singleton || options.root && path.resolve(options.root) !== singleton.root) singleton = createEmbeddingRuntimeInstaller(options)
  return singleton
}
export function resetManagedEmbeddingRuntime() {
  try { singleton?.dispose() } catch {}
  singleton = null
}
