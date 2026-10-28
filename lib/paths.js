import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function dataDir() {
  if (process.env.DSH_MEMU_MEMORY_HOME || process.env.DSH_MEMU_HOME) return process.env.DSH_MEMU_MEMORY_HOME || process.env.DSH_MEMU_HOME
  const legacy = path.join(dshHome(), 'dsh-memu')
  const current = path.join(dshHome(), 'dsh-memu-memory')
  // Existing installations keep their data in place; renaming a package is not a migration.
  return fs.existsSync(path.join(current, 'state.json')) || !fs.existsSync(legacy) ? current : legacy
}

export function engineDir(...parts) {
  return path.join(dataDir(), 'engine', ...parts)
}

export function logsDir() {
  return path.join(dataDir(), 'logs')
}

export function librariesDir() {
  return path.join(dataDir(), 'libraries')
}

export function indexDir() {
  return path.join(dataDir(), 'index')
}

export function downloadsDir() {
  return path.join(dataDir(), 'downloads')
}

export function backupsDir() {
  return path.join(dataDir(), 'backups')
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// A swallow-all read is what turns one transient failure into permanent data
// loss: every writer here does load -> mutate -> save, so returning "empty" for
// "unreadable" makes the next save atomically replace a whole library with
// nothing. Read failures are therefore classified, and a file we could not read
// is never written over. See AGENTS.md 3.3 (a read failure must never be saved back).
const readFailures = new Map()
let warnSink = null

export function setWarnSink(fn) {
  warnSink = typeof fn === 'function' ? fn : null
}

export function warn(message) {
  try { warnSink?.(redactSecrets(message)) } catch {}
}

export function redactSecrets(value, secrets = []) {
  let text = String(value || '')
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 8) text = text.split(secret).join('[REDACTED_KEY]')
  return text.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer [REDACTED_KEY]')
    .replace(/((?:api[_-]?key|access[_-]?token)\s*["']?\s*[:=]\s*["']?)[^\s"',;&]{8,}/gi, '$1[REDACTED_KEY]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/g, '$1[REDACTED]@')
}

export function readJsonStrict(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, missing: true }
    return { ok: false, missing: false, kind: 'io', error }
  }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch (error) {
    return { ok: false, missing: false, kind: 'corrupt', error }
  }
}

// Safe to move a corrupt file aside because every writer uses temp+rename: a
// reader can never observe a torn write, so a parse failure means the bytes on
// disk are genuinely bad rather than mid-write.
function quarantine(file) {
  const dest = `${file}.corrupt-${stamp().replace(/[:.]/g, '-')}`
  try {
    fs.renameSync(file, dest)
    return dest
  } catch {
    return null
  }
}

export function readJson(file, fallback = null) {
  const key = path.resolve(file)
  const result = readJsonStrict(file)
  if (result.ok) {
    readFailures.delete(key)
    return result.value
  }
  if (result.missing) {
    if (readFailures.get(key)?.kind === 'corrupt') return fallback
    readFailures.delete(key)
    return fallback
  }
  if (result.kind === 'corrupt') {
    const dest = quarantine(file)
    if (dest) {
      readFailures.set(key, { at: stamp(), kind: 'corrupt', quarantine: dest, code: 'INVALID_JSON', message: 'quarantined; restore a valid file before writing' })
      warn(`${file} is not valid JSON; kept as ${path.basename(dest)}; writes are blocked until a valid file is restored`)
      return fallback
    }
  }
  readFailures.set(key, { at: stamp(), kind: result.kind, code: result.error?.code || '', message: result.kind === 'corrupt' ? 'invalid JSON; quarantine failed' : String(result.error?.code || 'read failed') })
  warn(`cannot read ${file} (${result.error?.code || result.error}); writes are blocked until it reads cleanly again`)
  return fallback
}

/** Non-null when the file could not be read and is therefore write-protected. */
export function readFailure(file) {
  const key = path.resolve(file)
  if (!readFailures.has(key) && !fs.existsSync(file)) {
    try {
      const prefix = path.basename(file) + '.corrupt-'
      const kept = fs.readdirSync(path.dirname(file)).find(name => name.startsWith(prefix))
      if (kept) readFailures.set(key, { at: stamp(), kind: 'corrupt', code: 'INVALID_JSON', quarantine: path.join(path.dirname(file), kept), message: 'quarantined; restore a valid file before writing' })
    } catch {}
  }
  return readFailures.get(key) || null
}

/** Every file under `dir` currently write-protected by a failed read. */
export function readFailuresUnder(dir) {
  const root = path.resolve(dir) + path.sep
  const out = []
  for (const [file, failure] of readFailures) {
    if (file.startsWith(root)) out.push({ file, ...failure })
  }
  return out
}

export function assertWritable(file) {
  const failure = readFailure(file)
  if (!failure) return
  const error = new Error(`refusing to overwrite ${path.basename(file)}: an earlier read failed (${failure.code || failure.message})`)
  error.code = 'dsh-memu-memory/read-failed'
  throw error
}

export function assertJsonShape(file, value, valid) {
  if (valid(value)) return value
  const dest = quarantine(file)
  readFailures.set(path.resolve(file), { at: stamp(), kind: 'corrupt', code: 'INVALID_SHAPE', quarantine: dest, message: 'invalid JSON schema; restore a valid file before writing' })
  warn(`${path.basename(file)} has an invalid data shape; writes are blocked`)
  return null
}

export function writeJson(file, value) {
  assertWritable(file)
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    const fd = fs.openSync(tmp, 'r+')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(tmp, file); break } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt >= 5) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8 * (attempt + 1))
      }
    }
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }) } catch {}
    throw error
  }
}

const heldLocks = new Set()

export async function retryStoreWrite(action, attempts = 4) {
  for (let attempt = 0; ; attempt++) {
    try { return action() } catch (error) {
      if (!['DSH_MEMU_STORE_BUSY', 'EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt >= attempts - 1) throw error
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)))
    }
  }
}

/** Synchronous transactions never hold this lock across a backend/network await. */
export function withFileLock(file, action) {
  const lock = `${path.resolve(file)}.lock`
  if (heldLocks.has(lock)) return action()
  ensureDir(path.dirname(lock))
  const until = Date.now() + 500
  let fd
  while (fd === undefined) {
    try {
      fd = fs.openSync(lock, 'wx', 0o600)
      fs.writeFileSync(fd, String(process.pid))
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const owner = Number(fs.readFileSync(lock, 'utf8'))
        if (Number.isSafeInteger(owner) && owner > 0) {
          try { process.kill(owner, 0) } catch (probe) {
            if (probe?.code === 'ESRCH') { fs.unlinkSync(lock); continue }
          }
        }
      } catch {}
      if (Date.now() >= until) {
        const busy = new Error(`memory store is busy: ${path.basename(file)}; retry the operation`)
        busy.code = 'DSH_MEMU_STORE_BUSY'
        throw busy
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  heldLocks.add(lock)
  try { return action() } finally {
    heldLocks.delete(lock)
    fs.closeSync(fd)
    for (let attempt = 0; ; attempt++) {
      try { fs.unlinkSync(lock); break } catch (error) {
        if (error.code === 'ENOENT') break
        if (['EPERM', 'EBUSY', 'EACCES'].includes(error.code) && attempt < 5) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 * (attempt + 1))
          continue
        }
        warn(`could not release memory store lock: ${path.basename(lock)} (${error.code || 'IO error'})`)
        break
      }
    }
  }
}

export function stamp() {
  return new Date().toISOString()
}

export function safeSegment(value, fallback = 'unknown') {
  const text = String(value ?? '').trim()
  if (!text) return fallback
  const cleaned = text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || fallback
}

export function isSafeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) && value !== '.' && value !== '..'
}

export function libraryIdForScope(scopeKey) {
  let hash = 2166136261
  for (let i = 0; i < scopeKey.length; i++) {
    hash ^= scopeKey.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `lib_${(hash >>> 0).toString(16)}`
}

export function shortHash(value) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
