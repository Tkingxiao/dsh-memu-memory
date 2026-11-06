import fs from 'node:fs'
import path from 'node:path'
import { downloadsDir, warn } from './paths.js'
import { listLibraries, loadPrivateIndex, loadGlobalIndex } from './state.js'
import { commit as memuCommit, listFiles as memuListFiles, forget as memuForget } from './memu.js'
import { getEmbeddingCatalog, prefixesRequireRole, resolveEmbeddingSources } from './embedding-catalog.js'
import { createEmbeddingDownloadManager } from './embedding-download.js'
import { createVectorMigrator } from './vector-migration.js'
import { profileFromCatalog, setRequestedProfile, vectorStatus, assertProfileVerified } from './vector-profile.js'
import { embeddingWorkerManager } from './local-embedding-manager.js'
import { modelIdForRole } from './local-embedding-protocol.js'
import { managedEmbeddingRuntime, resetManagedEmbeddingRuntime } from './embedding-runtime.js'

const root = path.join(downloadsDir(), 'embeddings')
// 受管 runtime 与模型制品分开放：模型在 downloads/embeddings/<id>，运行时在
// downloads/embeddings/runtime/<key>。切换/回滚模型永远不碰运行时目录。
const runtimeRoot = path.join(root, 'runtime')
let downloader
let migrator
let installer
let runtimeJob = null

function getDownloader() {
  return downloader ||= createEmbeddingDownloadManager({ root })
}

// warn 走 paths.js 的 sink（index.js 装成 ctx.logger.warn）：安装失败必须留可观测信号
// （§1 规则 10），但它绝不能把召回一起拖垮——召回仍然 fail-open 到词法。
function getInstaller() {
  return installer ||= managedEmbeddingRuntime({ root: runtimeRoot, logger: { warn: message => warn(message) } })
}

function envRuntimeDir() {
  const value = String(process.env.DSH_MEMU_EMBED_RUNTIME_DIR || '').trim()
  return value ? path.resolve(value) : null
}

/** 目录里真的有一套可 require 的运行时吗（不是「env 设了就算」）。 */
export function hasEmbeddingRuntimePackages(dir) {
  if (typeof dir !== 'string' || !dir.trim()) return false
  try {
    return fs.statSync(path.join(path.resolve(dir.trim()), 'node_modules', 'onnxruntime-node', 'package.json')).isFile()
  } catch {
    return false
  }
}

/**
 * 运行时状态 = 受管安装事实 + 用户 env 覆盖事实，两者都如实报告。
 * env 指到一个没有运行时的目录时不会被当成 ready，而是回落到受管目录并留 warn。
 */
export function localVectorRuntimeStatus(options = {}) {
  const env = envRuntimeDir()
  const envUsable = env != null && hasEmbeddingRuntimePackages(env)
  let status
  try {
    status = getInstaller().getStatus({ deep: options.deep === true, modelId: options.modelId || null })
  } catch (error) {
    status = { status: 'unsupported', ready: false, path: null, platform: null, key: null, error: { code: String(error?.code || 'LOCAL_VECTOR_RUNTIME_UNVERIFIED'), message: String(error?.message || error) } }
  }
  if (envUsable) return { ...status, status: 'configured', ready: true, source: 'env', path: env, managedStatus: status.status, error: null }
  return { ...status, source: status.status === 'installed' ? 'managed' : null, ...(env ? { envIgnored: true } : {}) }
}

// The installer owns the live job; pause/stop must survive the moment after the
// abort (when that job is already gone) so the UI can still show the partial bytes
// and let the user switch source before resuming.
export function runtimeStateView() {
  const base = localVectorRuntimeStatus()
  if (!runtimeJob) return base
  const progress = runtimeJob.progress || base.progress || null
  if (runtimeJob.status === 'downloading') {
    return {
      ...base,
      status: 'downloading',
      ready: false,
      path: null,
      downloadSource: runtimeJob.source || base.downloadSource || null,
      progress: progress ? { ...progress, speedBps: Number(progress.speedBps) || 0 } : null,
    }
  }
  return {
    ...base,
    status: runtimeJob.status,
    ready: false,
    path: null,
    downloadSource: runtimeJob.source || null,
    progress: progress ? { ...progress, speedBps: 0 } : null,
    error: runtimeJob.error || null,
  }
}

/**
 * 受管安装：只有 confirmed === true 才会联网下载 catalog 里 pin 住的制品。
 * action=pause/stop 只中断当前下载并保留 .part；再次 start 会从稳定缓存续传。
 */
export async function installLocalVectorRuntime(options = {}) {
  const action = String(options.action || 'start')
  const installer = getInstaller()
  if (action === 'pause' || action === 'stop') {
    if (runtimeJob && runtimeJob.status === 'downloading') {
      runtimeJob.stopRequested = action === 'stop'
      runtimeJob.status = action === 'stop' ? 'stopped' : 'paused'
      runtimeJob.progress = runtimeJob.progress ? { ...runtimeJob.progress, speedBps: 0 } : runtimeJob.progress
      try { runtimeJob.controller.abort() } catch {}
    }
    return { runtime: runtimeStateView(), action }
  }
  if (runtimeJob?.status === 'downloading') {
    throw Object.assign(new Error('a managed runtime install is already running'), { code: 'LOCAL_VECTOR_RUNTIME_BUSY' })
  }
  if (runtimeJob?.run) {
    try { await runtimeJob.run } catch {}
  }
  runtimeJob = null
  const controller = new AbortController()
  const onExternalAbort = () => controller.abort()
  options.signal?.addEventListener?.('abort', onExternalAbort, { once: true })
  const job = { status: 'downloading', source: options.source || null, progress: null, controller, stopRequested: false, run: null, error: null }
  runtimeJob = job
  const run = installer.ensure({
    modelId: options.modelId || null,
    confirmed: options.confirmed === true,
    reuseOnly: options.reuseOnly === true,
    source: options.source || null,
    signal: controller.signal,
    onProgress: (progress) => {
      if (runtimeJob === job) job.progress = { ...progress }
      try { options.onProgress?.(progress) } catch {}
    },
  })
  job.run = run
  try {
    const result = await run
    job.status = 'installed'
    return { runtime: result, state: getLocalVectorState() }
  } catch (error) {
    if (controller.signal.aborted || error?.code === 'LOCAL_VECTOR_RUNTIME_ABORTED' || error?.name === 'AbortError') {
      job.status = job.stopRequested ? 'stopped' : 'paused'
      job.progress = job.progress ? { ...job.progress, speedBps: 0 } : job.progress
      return { runtime: runtimeStateView(), paused: job.status === 'paused', stopped: job.status === 'stopped' }
    }
    job.status = 'failed'
    job.error = { code: String(error?.code || 'LOCAL_VECTOR_RUNTIME_INSTALL_FAILED'), message: String(error?.message || error) }
    throw error
  } finally {
    options.signal?.removeEventListener?.('abort', onExternalAbort)
    if (runtimeJob === job && job.status !== 'paused' && job.status !== 'stopped') runtimeJob = null
  }
}

/** 生效的运行时目录：用户显式 env > 已核实的受管目录 > profile 里记录的旧值。 */
function runtimeDirFor(profile) {
  const env = envRuntimeDir()
  if (env && hasEmbeddingRuntimePackages(env)) return env
  if (env) warn('DSH_MEMU_EMBED_RUNTIME_DIR does not contain the managed runtime packages; using the managed runtime instead')
  const recorded = typeof profile?.runtimeDir === 'string' && profile.runtimeDir.trim() ? profile.runtimeDir.trim() : ''
  if (recorded && hasEmbeddingRuntimePackages(recorded)) return path.resolve(recorded)
  const status = getInstaller().getStatus({ modelId: profile?.catalogId || null })
  return status.status === 'installed' ? status.path : null
}

function profileFor(catalogId) {
  const id = String(catalogId)
  return profileFromCatalog(id, { modelDir: path.join(root, id), runtimeDir: runtimeDirFor({ catalogId: id }) })
}

function installationFor(id, sharedRuntime = null) {
  const status = getDownloader().getStatus(id, { deep: true })
  // 所有可用模型 pin 的是同一个受管 runtime；每个模型各走一遍运行时目录树（几百个文件）
  // 会让每次 getState 多花几百毫秒。上层已经算过一次就复用。
  const runtime = sharedRuntime || localVectorRuntimeStatus({ modelId: id })
  const degraded = status.state === 'installed' && status.verified === false
  return {
    status: degraded ? 'degraded' : status.state,
    installed: status.installed === true && !degraded,
    verified: status.verified ?? null,
    modelDir: status.installed && !degraded ? path.join(root, id) : null,
    runtimeDir: runtime.ready ? runtime.path : null,
    fingerprintMatches: status.fingerprintMatches ?? null,
    error: degraded ? { code: 'EMBEDDING_INSTALL_TAMPERED', message: 'installed embedding files failed deep verification' } : (status.error || null),
    progress: status.progress || null,
  }
}

/**
 * MemU `commit` 只认 `{ recall_files, resource, user }` 信封（写入与策划路径都走这个形状）。
 * 迁移器原先直接把 `{ name, description, ...entry }` 裸对象传进去：MemU 返回成功却一行
 * 都没写，随后回读不到 → 每条都 `VECTOR_READBACK_FAILED`，整次重建作废。
 */
export function migrationCommitPayload(item) {
  const entry = item?.entry || {}
  const text = String(entry.content ?? item?.text ?? '')
  const title = String(entry.title ?? item?.text ?? item?.id ?? '')
  return {
    recall_files: [{ name: String(item?.id ?? ''), track: 'memory', description: title.slice(0, 180), content: text }],
    resource: [],
    user: {},
  }
}

function migratorFor() {
  return migrator ||= createVectorMigrator({
    listLibraries: () => listLibraries().map(item => item.id),
    loadIndex: libraryId => libraryId == null ? loadGlobalIndex() : loadPrivateIndex(libraryId),
    commit: ({ db, item, profile }) => {
      assertProfileVerified(profile)
      return memuCommit({
      db,
      vectorProfile: profile,
      route: 'managed-local',
      payload: migrationCommitPayload(item),
      })
    },
    forget: ({ db, itemId }) => memuForget({ db, name: itemId, route: 'managed-local' }),
    listFiles: ({ db, profile }) => {
      assertProfileVerified(profile)
      return memuListFiles({ db, vectorProfile: profile, route: 'managed-local' })
    },
  })
}

export function getLocalVectorState() {
  const catalog = getEmbeddingCatalog().map(entry => ({
    id: entry.id,
    displayName: entry.displayName,
    availability: entry.availability,
    dimension: entry.dimension,
    totalBytes: entry.totalBytes,
    languages: Array.isArray(entry.languages) ? [...entry.languages] : [],
    rolesRequired: prefixesRequireRole(entry),
    // 能让用户选的来源（不是目录里写了几个 provider，而是那几个真的固定了 revision）。
    // 顺序就是默认顺序：第一个是 download() 不传 provider 时会用的那个。
    providers: resolveEmbeddingSources(entry).sources.map(source => ({ id: source.provider, label: source.label })),
    pendingReasons: [...(entry.pendingReasons || [])],
    license: entry.license?.base || null,
  }))
  let indexed = null
  try { indexed = migratorFor().membership() } catch { indexed = null }
  const runtime = runtimeStateView()
  return {
    catalog,
    installations: Object.fromEntries(catalog.map(entry => [entry.id, installationFor(entry.id, runtime)])),
    runtime,
    vector: { ...vectorStatus(), indexed },
  }
}

export function selectLocalVectorModel(id) {
  const status = getDownloader().getStatus(String(id), { deep: true })
  if (status.state !== 'installed' || status.verified !== true || status.fingerprintMatches === false) {
    const error = new Error('install and verify the local embedding model before selecting it')
    error.code = 'LOCAL_VECTOR_MODEL_NOT_INSTALLED'
    throw error
  }
  setRequestedProfile(profileFor(id), { status: 'requested' })
  return getLocalVectorState()
}

export async function downloadLocalVectorModel(id, options = {}) {
  const modelId = String(id)
  // provider 只影响「从哪个已固定的来源取字节」；落盘前每个文件都按目录 pin 的
  // sha256 校验，所以换源不会换向量空间，指纹里也没有 provider。
  const result = await getDownloader().download(modelId, {
    confirmed: options.confirmed === true,
    ...(options.provider ? { provider: String(options.provider) } : {}),
  })
  return { result, runtime: null, state: getLocalVectorState() }
}

export async function switchLocalVectorProfile(options = {}) {
  const state = vectorStatus()
  const requested = state.requested?.catalogId || options.id
  if (!requested) throw Object.assign(new Error('select a requested local embedding model first'), { code: 'LOCAL_VECTOR_REQUEST_MISSING' })
  const profile = profileFor(requested)
  if (!profile.runtimeDir) throw Object.assign(new Error('a verified managed runtime is required before switching local embeddings; install it from the managed vector settings first'), { code: 'LOCAL_VECTOR_RUNTIME_UNAVAILABLE' })
  // force：同一个 profile 已经 active 时也重建一代。用于库集合变化（如恢复一个曾归档
  // 的库、或首次激活时漏掉了库）后把索引重新追平；不传 force 时保持 already-active
  // 的幂等口径（不重建、不重嵌入）。
  const result = await migratorFor().switchProfile({ profile, force: options.force === true })
  return { result, state: getLocalVectorState() }
}

export async function rollbackLocalVectorProfile() {
  const result = await migratorFor().rollbackProfile()
  return { result, state: getLocalVectorState() }
}

export function abortLocalVectorMigration() {
  const result = migratorFor().abortPending()
  return { result, state: getLocalVectorState() }
}

/**
 * 启动 loopback worker 并真的打一次 POST /v1/embeddings：200 + 正确维度 + 有限数值才算就绪。
 * 失败一律带 fallback: 'lexical'，上游照旧 fail-open，但错误必须留在日志/lastRecallError 里。
 */
export async function healthCheckLocalVector(profile, { timeoutMs = 30_000 } = {}) {
  const endpoint = await embeddingWorkerManager().acquire(profile)
  const url = new URL('/v1/embeddings', endpoint.baseUrl).href
  // A profile with different query/document prefixes has no role-less reading: the
  // worker refuses a bare model id rather than pick one. Probe it as a document, which
  // is what the writing path (and the reindex migration) will ask for.
  const servedModel = endpoint.rolesRequired === true ? modelIdForRole(endpoint.model, 'document') : endpoint.model
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + String(endpoint.token) },
      body: JSON.stringify({ model: servedModel, input: ['本地向量健康检查'] }),
      signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 30_000)),
    })
  } catch (error) {
    throw Object.assign(new Error('the local embedding worker did not answer /v1/embeddings: ' + String(error?.message || error)), { code: 'LOCAL_VECTOR_HEALTH_FAILED', fallback: 'lexical' })
  }
  if (!response.ok) {
    throw Object.assign(new Error('the local embedding worker answered /v1/embeddings with ' + response.status), { code: 'LOCAL_VECTOR_HEALTH_FAILED', fallback: 'lexical', status: response.status })
  }
  const payload = await response.json().catch(() => null)
  const vector = payload?.data?.[0]?.embedding
  const dimension = Array.isArray(vector) ? vector.length : 0
  if (!Array.isArray(vector) || dimension !== Number(profile.dimension)) {
    throw Object.assign(new Error('the local embedding worker returned no ' + Number(profile.dimension) + '-dimension vector'), { code: 'LOCAL_VECTOR_HEALTH_FAILED', fallback: 'lexical', dimension })
  }
  if (!vector.every(value => typeof value === 'number' && Number.isFinite(value))) {
    throw Object.assign(new Error('the local embedding worker returned non-finite vector components'), { code: 'LOCAL_VECTOR_HEALTH_FAILED', fallback: 'lexical' })
  }
  return { ok: true, path: '/v1/embeddings', status: response.status, model: endpoint.model, dimension }
}

/**
 * 首用引导：runtime 复用（或确认后安装）→ 起 worker → /v1/embeddings 健康检查。
 * 没有云端回退：任一环失败都是 typed error + fallback=lexical。
 */
export async function bootstrapLocalVector(options = {}) {
  const state = vectorStatus()
  const catalogId = options.id || state.active?.profile?.catalogId || state.requested?.catalogId || null
  if (!catalogId) throw Object.assign(new Error('select a local embedding model before bootstrapping the local runtime'), { code: 'LOCAL_VECTOR_NOT_SELECTED' })
  const before = localVectorRuntimeStatus({ modelId: catalogId })
  let runtime
  if (before.status === 'configured') {
    runtime = { status: 'configured', ready: true, source: 'env', path: before.path, reused: true }
  } else {
    try {
      runtime = await getInstaller().ensure({
        modelId: catalogId,
        confirmed: options.confirmed === true,
        reuseOnly: options.confirmed !== true,
        signal: options.signal,
        onProgress: options.onProgress,
      })
    } catch (error) {
      // 引导失败照旧 fail-open 到词法：错误如实抛出，但必须带上降级标记。
      if (error && typeof error === 'object' && error.fallback === undefined) error.fallback = 'lexical'
      throw error
    }
  }
  const health = await healthCheckLocalVector(profileFor(catalogId), { timeoutMs: options.timeoutMs })
  return { ok: true, runtime: { status: runtime.status, ready: true, path: runtime.path || null, key: runtime.key || null, source: runtime.source || 'managed', reused: runtime.reused === true }, model: health.model, dimension: health.dimension, health, state: getLocalVectorState() }
}

export async function testLocalVector() {
  return bootstrapLocalVector({ confirmed: false })
}

export function closeLocalVectorService() {
  try { getDownloader().dispose() } catch {}
  try { getInstaller().abort() } catch {}
}

/** 仅供测试：清掉进程级单例，避免测试之间互相污染。 */
export function resetLocalVectorService() {
  try { getDownloader().dispose() } catch {}
  downloader = null
  migrator = null
  installer = null
  resetManagedEmbeddingRuntime()
}
