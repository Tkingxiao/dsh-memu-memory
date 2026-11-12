import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { dataDir, ensureDir, redactSecrets, warn, windowsSystemEnv } from './paths.js'
import { ENGINE_VERSION, readCurrent, verifyEngine } from './engine.js'
import { effectiveVectorRoute, getSettings } from './state.js'
import { activeProfile, captureVectorGeneration, assertVectorGeneration, assertProfileVerified, assertMigrationProfile } from './vector-profile.js'
import { embeddingWorkerManager } from './local-embedding-manager.js'
import { modelIdForRole } from './local-embedding-protocol.js'

// 单次命令捕获上限：工具输出异常放大时不能把整个进程内存吃光；超限只标 truncated。
const MAX_CAPTURE_CHARS = 8 * 1024 * 1024

// MemU's own storage mode. 'local' keeps every row in this plugin's sqlite files;
// 'cloud' hands storage to MemU's backend and needs the vendor credentials in
// ~/.memu/config.env. Read per call, never cached, so toggling it takes effect on
// the next command without a restart.
function memoryMode() {
  return getSettings().memoryMode === 'cloud' ? 'cloud' : 'local'
}

export class MemuError extends Error {
  constructor(message, code = 'MEMU_ERROR', detail = null) {
    super(message)
    this.name = 'MemuError'
    this.code = code
    this.detail = detail
  }
}

function currentEngine() {
  const current = readCurrent()
  if (!current?.python) {
    throw new MemuError('MemU engine is not installed or not ready', 'MEMU_ENGINE_NOT_READY')
  }
  return current
}

function runRaw(pythonArgs, { env, timeoutMs = 90_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const current = currentEngine()
    const child = spawn(current.python, pythonArgs, {
      cwd,
      env: {
        ...windowsSystemEnv(),
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        MEMU_MEMORY_MODE: memoryMode(),
        ...(env || {}),
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch {}
    }, timeoutMs)
    child.stdout?.on('data', (d) => {
      const text = d.toString()
      if (stdout.length + text.length > MAX_CAPTURE_CHARS) { truncated = true; return }
      stdout += text
    })
    child.stderr?.on('data', (d) => {
      if (stderr.length >= 64 * 1024) return
      stderr += d.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new MemuError(`failed to start memu: ${error.message}`, 'MEMU_SPAWN_FAILED', { error }))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve({ stdout, stderr, code, truncated })
        return
      }
      const secrets = Object.entries({ ...process.env, ...(env || {}) }).filter(([key]) => /(?:API_KEY|TOKEN|SECRET)$/.test(key)).map(([, value]) => value)
      const detail = redactSecrets((stderr || stdout || '').trim(), secrets)
      reject(new MemuError(
        `memu ${pythonArgs[0] === '-m' ? pythonArgs[2] : pythonArgs[0] || ''} failed (exit ${code}${timedOut ? ', timeout' : ''}): ${detail.slice(-2000)}`,
        'MEMU_COMMAND_FAILED',
        { code, stdout: redactSecrets(stdout, secrets), stderr: redactSecrets(stderr, secrets), timedOut },
      ))
    })
  })
}

// ---- resident engine ---------------------------------------------------------
// MemU is a Python CLI: every command normally pays the whole import chain
// (~2 s), because the process exits when the command ends. Local vector mode
// calls the same three commands on every turn (recall) and on every write,
// so one warm interpreter removes that constant from both paths.
//
// The worker imports ``memu.cli`` once and calls the exact ``main(argv)`` the
// CLI entrypoint calls — command semantics stay in MemU's own code. One JSON
// object per line is the protocol on both directions. ``_close_backends`` is
// what keeps the per-command process model intact: a command that ends must
// release its sqlite handles, otherwise backup / migration / rollback would
// see a database still held open by a process that is supposed to be idle.
const RESIDENT_SCRIPT = String.raw`
import contextlib
import io
import json
import os
import sys

for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _reply(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


BASE_ENV = dict(os.environ)
try:
    import memu.cli as _cli
except Exception as _exc:
    _reply({"ready": False, "error": "memu import failed: %s" % (_exc,)})
    raise SystemExit(1)

_original_build = _cli.build_agentic_memory_backend_from_env
_created = []


def _tracked_build(*args, **kwargs):
    backend = _original_build(*args, **kwargs)
    _created.append(backend)
    return backend


_cli.build_agentic_memory_backend_from_env = _tracked_build


def _close_backends():
    while _created:
        backend = _created.pop()
        try:
            closer = getattr(getattr(backend, "database", None), "close", None)
            if callable(closer):
                closer()
        except Exception:
            pass


_reply({"ready": True})

for _line in sys.stdin:
    _line = _line.strip()
    if not _line:
        continue
    try:
        _request = json.loads(_line)
    except Exception:
        continue
    if _request.get("op") == "shutdown":
        break
    os.environ.clear()
    os.environ.update(BASE_ENV)
    for _key, _value in (_request.get("env") or {}).items():
        if _value is None:
            os.environ.pop(str(_key), None)
        else:
            os.environ[str(_key)] = str(_value)
    _argv = [str(_item) for _item in (_request.get("argv") or [])]
    _out = io.StringIO()
    _err = io.StringIO()
    _code = 1
    try:
        with contextlib.redirect_stdout(_out), contextlib.redirect_stderr(_err):
            _result = _cli.main(_argv)
            _code = 0 if _result is None else int(_result)
    except BaseException as _exc:
        _err.write("%s: %s\n" % (type(_exc).__name__, _exc))
    finally:
        _close_backends()
    _reply({"id": _request.get("id"), "code": _code, "stdout": _out.getvalue(), "stderr": _err.getvalue()})
`

const RESIDENT_READY_TIMEOUT_MS = 30_000
const RESIDENT_LINE_LIMIT = 8 << 20

// 常驻引擎的进程级单例。之前漏了这个声明：所有更新点都在写它，第一次真正 spawn
// 时直接 ReferenceError（MEMU_SPAWN_FAILED: residentRecord is not defined）。
let residentRecord = null

function residentKey(current) {
  return `${current.python}\u0000${String(current.version || '')}`
}

function residentBaseEnv() {
  return {
    ...windowsSystemEnv(),
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    MEMU_MEMORY_MODE: memoryMode(),
  }
}

function stopResident(record, failure = null) {
  if (!record) return
  record.stopping = true
  if (residentRecord === record) residentRecord = null
  if (failure) {
    for (const pending of record.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(failure)
    }
  }
  record.pending.clear()
  try { record.child?.stdin?.end() } catch {}
  try { record.child?.kill() } catch {}
}

function residentFailure(pending, code, detail, timedOut = false) {
  const stdout = redactSecrets(String(detail?.stdout || ''), pending.secrets)
  const stderr = redactSecrets(String(detail?.stderr || ''), pending.secrets)
  const text = (stderr || stdout || '').trim()
  return new MemuError(
    `memu ${pending.label} failed (exit ${code}${timedOut ? ', timeout' : ''}): ${text.slice(-2000)}`,
    'MEMU_COMMAND_FAILED',
    { code, stdout, stderr, timedOut },
  )
}

function startResident(current, key) {
  const record = { key, child: null, pending: new Map(), seq: 0, stopping: false, stderr: '', readySettled: false }
  const abortReady = (message) => {
    if (record.readySettled) return
    record.readySettled = true
    if (residentRecord === record) residentRecord = null
    try { clearTimeout(record.bootTimer) } catch {}
    try { record.child?.kill() } catch {}
    record.readyReject?.(new MemuError(`failed to start memu: ${message}`, 'MEMU_SPAWN_FAILED'))
  }
  record.ready = new Promise((resolve, reject) => {
    record.readyReject = reject
    let buffer = ''
    const settle = () => {
      record.readySettled = true
      try { clearTimeout(record.bootTimer) } catch {}
      resolve(record)
    }
    record.bootTimer = setTimeout(() => abortReady('the memu resident process did not become ready in time'), RESIDENT_READY_TIMEOUT_MS)
    try {
      record.child = spawn(current.python, ['-c', RESIDENT_SCRIPT], {
        env: residentBaseEnv(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      abortReady(error.message)
      return
    }
    // An unhandled 'error' event on a child pipe is an uncaught exception in the host.
    for (const pipe of [record.child.stdin, record.child.stdout, record.child.stderr]) {
      try { pipe?.on?.('error', () => {}) } catch {}
    }
    record.child.stderr?.on('data', (chunk) => {
      record.stderr = (record.stderr + String(chunk)).slice(-4096)
    })
    record.child.stdout?.on('data', (chunk) => {
      buffer += String(chunk)
      if (buffer.length > RESIDENT_LINE_LIMIT) {
        buffer = ''
        abortReady('the resident engine response exceeded the line limit')
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r+$/, '')
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line.trim()) continue
        let message = null
        try { message = JSON.parse(line) } catch { continue }
        if (!record.readySettled) {
          if (message.ready === true) settle()
          else abortReady(String(message.error || 'the resident worker did not report ready'))
          continue
        }
        const pending = record.pending.get(message.id)
        if (!pending) continue
        record.pending.delete(message.id)
        clearTimeout(pending.timer)
        const code = Number(message.code)
        if (code === 0) pending.resolve({ stdout: String(message.stdout || ''), stderr: String(message.stderr || ''), code: 0 })
        else pending.reject(residentFailure(pending, code, message))
      }
    })
    record.child.on('error', (error) => abortReady(error.message))
    record.child.on('close', (code) => {
      if (!record.readySettled) {
        abortReady(`the resident engine exited before it was ready (exit ${code})`)
        return
      }
      if (residentRecord === record) residentRecord = null
      if (record.stopping) return
      const tail = redactSecrets(record.stderr.trim(), [])
      const failure = new MemuError(
        `memu resident process exited (exit ${code})${tail ? `: ${tail.slice(-2000)}` : ''}`,
        'MEMU_COMMAND_FAILED',
        { code, timedOut: false, stderr: tail },
      )
      for (const pending of record.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(failure)
      }
      record.pending.clear()
      warn('dsh-memu-memory: the resident memu engine exited; the next command will cold-start')
    })
  })
  return record
}

function ensureResident(current) {
  const key = residentKey(current)
  if (residentRecord && residentRecord.key !== key) {
    stopResident(residentRecord, new MemuError('the memu engine changed; the resident process was stopped', 'MEMU_COMMAND_FAILED'))
  }
  if (!residentRecord) residentRecord = startResident(current, key)
  return residentRecord.ready
}

async function runResident(args, { env, timeoutMs = 90_000 } = {}) {
  const current = currentEngine()
  let record
  try {
    record = await ensureResident(current)
  } catch (error) {
    throw error instanceof MemuError ? error : new MemuError(String(error?.message || error), 'MEMU_SPAWN_FAILED')
  }
  if (!record || record.stopping) throw new MemuError('the resident memu engine is not available', 'MEMU_SPAWN_FAILED')
  const label = args[0] || ''
  const id = ++record.seq
  const secrets = Object.entries({ ...process.env, ...(env || {}) })
    .filter(([key]) => /(?:API_KEY|TOKEN|SECRET)$/.test(key)).map(([, value]) => value)
  const payload = JSON.stringify({
    id,
    argv: args,
    env: { ...(env || {}), MEMU_MEMORY_MODE: memoryMode() },
  }) + '\n'
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      record.pending.delete(id)
      const failure = new MemuError(
        `memu ${label} failed (timeout): the resident engine did not answer in ${Math.round(timeoutMs / 1000)}s`,
        'MEMU_COMMAND_FAILED',
        { code: null, stdout: '', stderr: '', timedOut: true, killed: true },
      )
      reject(failure)
      // A Python command cannot be cancelled from the outside, so a stuck command
      // costs this process; the next request cold-starts a fresh one.
      stopResident(record, failure)
    }, timeoutMs)
    record.pending.set(id, { resolve, reject, timer, label, secrets })
    try {
      record.child.stdin.write(payload)
    } catch (error) {
      record.pending.delete(id)
      clearTimeout(timer)
      const failure = new MemuError(`failed to start memu: ${error.message}`, 'MEMU_SPAWN_FAILED', { error })
      reject(failure)
      stopResident(record, failure)
    }
  })
}

/** Close the resident engine (plugin dispose, or an explicit teardown). */
export function closeMemuResident() {
  const record = residentRecord
  residentRecord = null
  if (!record) return 0
  stopResident(record, new MemuError('the resident memu engine is closed', 'MEMU_COMMAND_FAILED'))
  return 1
}

/**
 * Warm the resident engine for local vector mode. Called after the local vector
 * bootstrap (or on the first managed-local command), and deliberately fail-open:
 * an engine that is missing or broken must not delay plugin activation.
 */
export async function prewarmMemuResident() {
  try {
    if (effectiveVectorRoute() !== 'managed-local') return false
    if (!activeProfile()) return false
    const current = readCurrent()
    if (!current?.python) return false
    await ensureResident(current)
    return true
  } catch (error) {
    try { warn(`dsh-memu-memory: resident memu prewarm skipped: ${error?.message || error}`) } catch {}
    return false
  }
}

async function runConfigured(args, options = {}) {
  const route = options.route || (options.vectorProfile ? 'managed-local' : 'remote-api')
  const useManagedLocal = route === 'managed-local'
  const migration = options.vectorProfile ? assertMigrationProfile({ profile: options.vectorProfile, db: options.db }) : null
  const generation = useManagedLocal && !options.vectorProfile && activeProfile() ? captureVectorGeneration() : null
  if (generation && options.db && ![generation.global, ...Object.values(generation.libraries)].includes(options.db)) {
    throw new MemuError('database does not belong to the captured vector generation', 'VECTOR_DB_MISMATCH')
  }
  const env = await envFor({ ...options, route })
  if (generation) assertVectorGeneration(generation)
  if (migration) assertMigrationProfile(migration)
  // The cost is the Python import chain, not the embedding call, and every route
  // pays it once per command. The resident worker already takes its env (base URL,
  // key, model, db) per command and releases sqlite handles after each one, so the
  // remote API route reuses the same warm interpreter. One process per command made
  // every recall pay a cold start, which is exactly the "send a message, wait ten
  // seconds" latency users saw in API mode.
  const result = await runResident(args, { env, timeoutMs: options.timeoutMs })
  if (generation) assertVectorGeneration(generation)
  if (migration) assertMigrationProfile(migration)
  return result
}

async function envFor({ db, provider, embedModel, baseUrl, apiKey, vectorProfile, route, role }) {
  const profile = route === 'managed-local' ? (vectorProfile || activeProfile()) : null
  if (profile) {
    assertProfileVerified(profile)
    const endpoint = await embeddingWorkerManager().acquire(profile)
    return localEmbeddingEnv({ ...endpoint, db, role })
  }
  if (route === 'managed-local') throw new MemuError('managed local vector profile is not active', 'VECTOR_NOT_READY')
  const env = {}
  if (db) env.MEMU_DB = db
  if (provider) env.MEMU_EMBED_PROVIDER = provider
  if (embedModel) env.MEMU_EMBED_MODEL = embedModel
  if (baseUrl) env.MEMU_BASE_URL = baseUrl
  if (apiKey) env.MEMU_API_KEY = apiKey
  return env
}

// §14.3 strict-local embedding wiring. The plugin injects this into each MemU
// child instead of asking the user to export anything: the loopback endpoint, the
// per-process random token (env only, never argv/log/config) and the pinned
// embedding model id. Telemetry is switched off explicitly, because "local mode"
// alone is not proof that nothing leaves the machine.
export function localEmbeddingEnv({ baseUrl, token, model, rolesRequired, db, role } = {}) {
  const env = {
    MEMU_MEMORY_MODE: 'local',
    MEMU_EMBED_PROVIDER: 'openai',
    MEMU_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
    MEMU_EVENTS_BASE_URL: '',
  }
  if (typeof baseUrl === 'string' && baseUrl.trim()) env.MEMU_BASE_URL = baseUrl.trim()
  if (typeof token === 'string' && token.trim()) env.MEMU_API_KEY = token.trim()
  // The embeddings envelope has no role field, so a profile that reads query and
  // document differently carries its role on the model string. Only this side knows
  // which MemU process it is starting, so only this side may say so — and it has to:
  // the worker refuses a bare model id for such a profile rather than guess (§14.4).
  const modelId = rolesRequired === true && typeof model === 'string' && model.trim()
    ? modelIdForRole(model, role === 'query' ? 'query' : 'document')
    : model
  if (typeof modelId === 'string' && modelId.trim()) env.MEMU_EMBED_MODEL = modelId.trim()
  if (typeof db === 'string' && db.trim()) env.MEMU_DB = db.trim()
  return env
}

export function parseJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  try { return JSON.parse(raw) } catch {}
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)) } catch {}
  }
  return null
}

export async function retrieve({ query, db, provider, embedModel, baseUrl, apiKey, vectorProfile, route, timeoutMs = 60_000 }) {
  if (!query || !String(query).trim()) {
    throw new MemuError('retrieve requires a non-empty query', 'MEMU_BAD_ARGUMENT')
  }
  const res = await runConfigured(['retrieve', String(query), '--json'], { db, provider, embedModel, baseUrl, apiKey, vectorProfile, route, timeoutMs, role: 'query' })
  const data = parseJson(res.stdout)
  if (data === null) {
    return { raw: res.stdout.trim(), parseWarning: 'memu retrieve returned non-JSON' }
  }
  return data
}

export async function listFiles({ db, provider, embedModel, baseUrl, apiKey, vectorProfile, route, timeoutMs = 60_000 } = {}) {
  const res = await runConfigured(['list-files', '--json'], { db, provider, embedModel, baseUrl, apiKey, vectorProfile, route, timeoutMs, role: 'document' })
  const data = parseJson(res.stdout)
  if (data === null) {
    return { recall_files: [], raw: res.stdout.trim(), parseWarning: 'memu list-files returned non-JSON' }
  }
  return data
}

export async function commit({ payload, db, provider, embedModel, baseUrl, apiKey, vectorProfile, route, timeoutMs = 180_000 }) {
  const tmpDir = ensureDir(path.join(dataDir(), 'tmp'))
  // 临时文件名不可预测（旧版 pid+Date.now 可被并行进程猜到），并收紧权限。
  const file = path.join(tmpDir, `commit-${crypto.randomUUID()}.json`)
  try {
    fs.writeFileSync(file, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
    const res = await runConfigured(['commit', file, '--json'], { db, provider, embedModel, baseUrl, apiKey, vectorProfile, route, timeoutMs, role: 'document' })
    const data = parseJson(res.stdout)
    if (data === null) {
      return { raw: res.stdout.trim(), parseWarning: 'memu commit returned non-JSON' }
    }
    return data
  } finally {
    try { fs.rmSync(file, { force: true }) } catch {}
  }
}

// MemU's CLI has no delete subcommand (retrieve / search / list-files / commit only),
// so a permanent delete has to go to the sqlite file itself. The segments rows are
// removed first: they carry the embeddings, and a segment without its parent file
// would keep matching a semantic query after the text was supposedly gone.
// Idempotent: deleting an already-gone name reports 0, it does not throw.
const FORGET_SCRIPT = [
  'import json, sqlite3, sys',
  'db, name = sys.argv[1], sys.argv[2]',
  'conn = sqlite3.connect(db)',
  'try:',
  '    ids = [r[0] for r in conn.execute("select id from memu_recall_files where name = ?", (name,)).fetchall()]',
  '    segs = 0',
  '    for rid in ids:',
  '        cur = conn.execute("delete from memu_recall_file_segments where recall_file_id = ?", (rid,))',
  '        segs += cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0',
  '    conn.execute("delete from memu_recall_files where name = ?", (name,))',
  '    conn.commit()',
  '    print(json.dumps({"deleted": len(ids), "segments": segs}))',
  'finally:',
  '    conn.close()',
].join('\n')

export async function forget({ db, name, timeoutMs = 60_000 } = {}) {
  if (!db) throw new MemuError('forget requires a db path', 'MEMU_BAD_ARGUMENT')
  if (!name) throw new MemuError('forget requires a memory name', 'MEMU_BAD_ARGUMENT')
  // sqlite3.connect would happily create an empty file for a typo'd path, which is
  // why the existence check comes before the spawn.
  if (!fs.existsSync(db)) return { deleted: 0, segments: 0, missing: true }
  const res = await runRaw(['-c', FORGET_SCRIPT, db, String(name)], { env: {}, timeoutMs })
  const data = parseJson(res.stdout)
  if (data === null) {
    return { deleted: 0, segments: 0, raw: res.stdout.trim(), parseWarning: 'memu forget returned non-JSON' }
  }
  return data
}

export async function probe() {
  const current = currentEngine()
  const verified = await verifyEngine(current.python, { expectedVersion: current.version || ENGINE_VERSION })
  return { ...verified, current }
}
