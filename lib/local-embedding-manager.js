import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertProfileVerified } from './vector-profile.js'
import { manifestModelId } from './local-embedding-worker.js'

const entry = fileURLToPath(new URL('./local-embedding-entry.js', import.meta.url))
const failure = (code, message) => Object.assign(new Error(message), { code, fallback: 'lexical' })

const LOOPBACK = '127.0.0.1'
const EMBEDDINGS_PATH = '/v1/embeddings'
const READY_LIMIT = 16_384
const TOKEN_BYTES = 32
const DEFAULT_WINDOW_MS = 60_000

// The worker needs the OS basics and nothing else. An inherited proxy variable can
// reroute the loopback call (§14.6: MEMU_HTTP_PROXY does exist), an inherited
// *_API_KEY would hand a cloud credential to a process whose whole point is that it
// never talks to anyone, and a stale DSH_MEMU_EMBED_* value would replace the fresh
// per-process token or point the child at another model directory.
const DENIED_ENV_NAMES = Object.freeze(['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'node_options'])
const DENIED_ENV_PREFIXES = Object.freeze(['memu_', 'dsh_memu_embed_', 'openai_', 'azure_openai_', 'anthropic_', 'gemini_', 'google_', 'cohere_'])

function childEnvironment(extra) {
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

// One isolated native process per immutable profile. Tokens live only in memory and
// in the child environment: never in argv, never in a log line, never in status().
// A failed boot counts toward the fuse too; recall never triggers installation.
export function createEmbeddingWorkerManager({ spawnImpl = spawn, executable = process.execPath, logger = console, now = Date.now, timeoutMs = 60_000, maxRestarts = 3, restartWindowMs = 60_000, verifyProfile = assertProfileVerified } = {}) {
  const records = new Map()
  const crashes = new Map()
  const windowMs = Number.isFinite(restartWindowMs) && restartWindowMs > 0 ? restartWindowMs : DEFAULT_WINDOW_MS
  const fuseLimit = Number.isInteger(maxRestarts) && maxRestarts > 0 ? maxRestarts : 0
  let disposed = false

  const warn = message => { try { logger?.warn?.(message) } catch {} }

  // The fuse counts failed boots and unexpected exits only: a worker that served
  // requests is not a restart storm. Timestamps older than the window are dropped so
  // a crash loop stays bounded while a single later retry is not blocked forever.
  const recentCrashes = key => {
    const list = (crashes.get(key) || []).filter(at => now() - at < windowMs)
    if (list.length) crashes.set(key, list)
    else crashes.delete(key)
    return list
  }
  const noteCrash = key => {
    const list = recentCrashes(key)
    list.push(now())
    crashes.set(key, list)
    return list.length
  }

  // stdin EOF is the worker's graceful "release the native session" signal; the kill
  // only guarantees it for a child that is wedged. Both are best effort by design —
  // stopping must never throw during disposal.
  const stopChild = record => {
    record.stopping = true
    const child = record.child
    if (!child) return
    try { child.stdin?.end() } catch {}
    try { child.kill() } catch {}
  }

  // Readiness is the only thing the parent believes about the child, so it is checked
  // against the requested profile instead of trusted: right model id, right dimension,
  // and a bare http loopback base URL with a real port. Anything else degrades to
  // lexical recall rather than pointing MemU at an unexpected endpoint.
  function checkReady(ready, expected) {
    if (!ready || typeof ready !== 'object' || Array.isArray(ready)) return { error: 'worker readiness is not an object' }
    if (ready.type !== 'ready') return { error: 'worker readiness is not a ready message' }
    if (!expected.model) return { error: 'the requested profile has no stable model id' }
    if (ready.model !== expected.model) return { error: 'worker readiness names a model other than the requested profile' }
    if (!Number.isInteger(expected.dimension) || expected.dimension <= 0) return { error: 'the requested profile has no embedding dimension' }
    if (ready.dimension !== expected.dimension) return { error: 'worker readiness reports a dimension other than the requested profile' }
    let base = null
    try { base = new URL(String(ready.baseUrl || '')) } catch { base = null }
    if (!base) return { error: 'worker readiness carries no usable endpoint' }
    if (base.protocol !== 'http:') return { error: 'worker endpoint must speak http on loopback' }
    if (base.hostname !== LOOPBACK) return { error: 'worker endpoint must be ' + LOOPBACK }
    const port = Number(base.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'worker endpoint must carry a real port' }
    if (base.username || base.password || base.search || base.hash) return { error: 'worker endpoint must be a bare loopback base URL' }
    if (base.pathname !== '/v1') return { error: 'worker endpoint path must be /v1' }
    if (ready.url !== undefined && ready.url !== null && String(ready.url) !== new URL(EMBEDDINGS_PATH, base).href) {
      return { error: 'worker embeddings URL does not belong to its base URL' }
    }
    return { endpoint: Object.freeze({ baseUrl: base.href, model: expected.model, dimension: expected.dimension }) }
  }

  function boot(profile, key, modelDir, runtimeDir) {
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex')
    const expected = { model: manifestModelId(profile.manifest), dimension: Number(profile.dimension) }
    const record = { key, child: null, stopping: false, settled: false, endpoint: null, reject: null }
    // Registered before the spawn so a concurrent acquire joins this boot instead of
    // starting a second child for the same profile.
    records.set(key, record)
    record.ready = new Promise((resolve, reject) => {
      let buffer = ''
      let timer = null
      const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null } }
      const forget = () => { if (records.get(key) === record) records.delete(key) }
      const abort = (code, message) => {
        if (record.settled) return
        record.settled = true
        clearTimer()
        forget()
        reject(failure(code, message))
      }
      // close() rejects an in-flight acquire through this hook, so a caller waiting on
      // a child that never reports ready fails immediately instead of hanging.
      record.reject = abort
      const fail = (code, message) => {
        noteCrash(key)
        abort(code, message)
        stopChild(record)
      }
      timer = setTimeout(() => fail('LOCAL_VECTOR_START_TIMEOUT', 'the local embedding worker did not become ready in time'), timeoutMs)
      timer.unref?.()
      let child = null
      try {
        child = spawnImpl(executable, [entry], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: childEnvironment({
            ELECTRON_RUN_AS_NODE: '1',
            DSH_MEMU_EMBED_MODEL_DIR: modelDir,
            DSH_MEMU_EMBED_RUNTIME_DIR: runtimeDir,
            DSH_MEMU_EMBED_MANIFEST: JSON.stringify({ ...profile.manifest, verified: true }),
            DSH_MEMU_EMBED_TOKEN: token,
            DSH_MEMU_EMBED_HOST: LOOPBACK,
            DSH_MEMU_EMBED_PORT: '0',
            MEMU_TELEMETRY: '0',
            DO_NOT_TRACK: '1',
            MEMU_EVENTS_BASE_URL: '',
          }),
        })
      } catch {
        fail('LOCAL_VECTOR_SPAWN_FAILED', 'the local embedding worker could not be started')
        return
      }
      record.child = child
      // A worker that died turns the next stdin write into EPIPE. An unhandled 'error'
      // event on a child pipe is an uncaught exception in the host process, so every
      // pipe gets a sink: semantic recall degrades, the host does not go down with it.
      for (const pipe of [child?.stdin, child?.stdout, child?.stderr]) {
        try { pipe?.on?.('error', () => {}) } catch {}
      }
      child?.on?.('error', () => {
        if (record.settled) { warn('the local embedding worker reported an error; semantic recall will degrade to lexical'); return }
        fail('LOCAL_VECTOR_SPAWN_FAILED', 'the local embedding worker could not be started')
      })
      child?.on?.('close', () => {
        forget()
        record.endpoint = null
        // A shutdown this manager asked for is not a crash and must stay quiet.
        if (record.stopping) return
        noteCrash(key)
        warn('the local embedding worker exited; semantic recall will degrade to lexical')
        abort('LOCAL_VECTOR_WORKER_EXITED', 'the local embedding worker exited before it became ready')
      })
      // Native stderr may quote request text, so it is read and discarded.
      child?.stderr?.on?.('data', () => {})
      child?.stdout?.on?.('data', chunk => {
        if (record.settled) return
        buffer += String(chunk)
        if (buffer.length > READY_LIMIT) { fail('LOCAL_VECTOR_BAD_READY', 'the worker readiness message exceeded the limit'); return }
        const newline = buffer.indexOf(String.fromCharCode(10))
        if (newline < 0) return
        const line = buffer.slice(0, newline).replace(/\r+$/, '')
        buffer = ''
        let ready = null
        try { ready = JSON.parse(line) } catch { fail('LOCAL_VECTOR_BAD_READY', 'the worker returned an unreadable readiness line'); return }
        const checked = checkReady(ready, expected)
        if (checked.error) { fail('LOCAL_VECTOR_BAD_READY', checked.error); return }
        record.settled = true
        clearTimer()
        record.endpoint = Object.freeze({ ...checked.endpoint, token })
        resolve(record.endpoint)
      })
    })
    return record
  }

  async function acquire(profile) {
    if (disposed) throw failure('LOCAL_VECTOR_MANAGER_CLOSED', 'the embedding worker manager is closed')
    verifyProfile(profile)
    const modelDir = typeof profile?.modelDir === 'string' ? profile.modelDir.trim() : ''
    const runtimeDir = typeof profile?.runtimeDir === 'string' ? profile.runtimeDir.trim() : ''
    if (!modelDir || !runtimeDir) throw failure('LOCAL_VECTOR_RUNTIME_UNAVAILABLE', 'install the verified model and runtime before enabling local embeddings')
    if (!manifestModelId(profile.manifest)) throw failure('LOCAL_VECTOR_MANIFEST_INCOMPLETE', 'the vector profile has no stable model id')
    const dimension = Number(profile.dimension)
    if (!Number.isInteger(dimension) || dimension <= 0) throw failure('LOCAL_VECTOR_MANIFEST_INCOMPLETE', 'the vector profile has no embedding dimension')
    const key = JSON.stringify([String(profile.fingerprint || ''), modelDir, runtimeDir])
    const existing = records.get(key)
    if (existing) return existing.ready
    if (fuseLimit && recentCrashes(key).length >= fuseLimit) throw failure('LOCAL_VECTOR_RESTART_FUSED', 'the local embedding worker keeps failing; retry after the cooldown')
    return boot(profile, key, modelDir, runtimeDir).ready
  }

  function close() {
    disposed = true
    const pending = [...records.values()]
    records.clear()
    crashes.clear()
    for (const record of pending) {
      // Reject first: a caller blocked in acquire() must fail on the shutdown it was
      // told about, not on the "worker exited" symptom of our own kill.
      record.reject?.('LOCAL_VECTOR_MANAGER_CLOSED', 'the embedding worker manager is closed')
      stopChild(record)
    }
    return pending.length
  }

  // Deliberately shallow: no token, no endpoint, no model directory, no fingerprint.
  function status() {
    let running = 0
    let booting = 0
    for (const record of records.values()) {
      if (record.settled) running += 1
      else booting += 1
    }
    let tripped = 0
    if (fuseLimit) for (const key of [...crashes.keys()]) if (recentCrashes(key).length >= fuseLimit) tripped += 1
    return { running, booting, closed: disposed, tripped }
  }

  return { acquire, close, status }
}

let singleton
export function embeddingWorkerManager() {
  return singleton ||= createEmbeddingWorkerManager()
}
export function closeEmbeddingWorkers() {
  const manager = singleton
  singleton = null
  try { manager?.close() } catch {}
}
