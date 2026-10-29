import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  backupsDir, dataDir, ensureDir, indexDir, isSafeId, librariesDir,
  readJson, warn, withFileLock, writeJson,
} from './paths.js'

/**
 * 本地向量施工文档 §14.9 - safe latest-three backup retention.
 *
 * One rule, one place. Every managed backup of the current data root is created
 * by createBackup(), published atomically, and only then may the oldest
 * complete backups beyond BACKUP_KEEP be deleted. Create, delete, restore and
 * prune share a single lock, so the safety backup a restore just made can never
 * collect the very directory that restore is reading from.
 *
 * Invariants:
 *  1. A failed or interrupted creation deletes nothing. The backup is built in
 *     backups/.staging/<name>.<pid>.<rand>, hashed file by file, given its
 *     manifest last (the completion marker) and only then renamed into place.
 *  2. Only directories that prove themselves complete are ever deleted.
 *     Corrupt, half-written, foreign, linked or unknown entries are reported
 *     and left exactly where they are.
 *  3. Ordering is the verified manifest createdAt plus a unique id - never an
 *     mtime that a copy or a clock change can reorder.
 *  4. A lease pins the directory a restore (or migration) is about to read, so
 *     prune cannot remove it mid-flight; going briefly over the limit is
 *     allowed and is reclaimed as soon as the operation finishes.
 *  5. A recursive delete re-checks realpath containment and refuses links
 *     before it removes a single byte.
 *  6. SQLite is snapshotted only by SQLite's own backup API, run by the
 *     plugin's isolated engine/<version>/venv interpreter. A live db+wal+shm is
 *     never copied by hand, and a global Python is never borrowed: if the
 *     managed engine cannot prove a consistent snapshot, the backup fails
 *     instead of publishing a copy that would restore as silent corruption.
 *     Only a zero-byte placeholder (no page, no WAL frame) may be copied.
 */

export const BACKUP_KEEP = 3
export const BACKUP_SCHEMA = 2

// Timestamp name of a published backup, optionally suffixed for uniqueness
// within the same millisecond. Anything else in backups/ is not a managed
// backup and is never counted or deleted by retention.
const MANAGED_NAME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z(-[A-Za-z0-9]+)*$/
const SQLITE_MAGIC = 'SQLite format 3' + String.fromCharCode(0)
const BACKSLASH = String.fromCharCode(92)
const NEWLINE = String.fromCharCode(10)
const STAGING_TTL_MS = 30 * 60 * 1000
const LEASE_TTL_MS = 15 * 60 * 1000
const RETRY_MS = 8
const PYTHON_TIMEOUT_MS = 120000
const PROBE_TIMEOUT_MS = 20000

const stagingRoot = () => path.join(backupsDir(), '.staging')
const leaseFile = () => path.join(backupsDir(), '.leases.json')
const lockAnchor = () => path.join(backupsDir(), '.backup')
const stateFile = () => path.join(dataDir(), 'state.json')
const globalDbFile = () => path.join(dataDir(), 'global.sqlite3')
const vectorActiveFile = () => path.join(indexDir(), 'vector-active.json')
const engineCurrentFile = () => path.join(dataDir(), 'engine', 'current.json')

function isoStamp() { return new Date().toISOString() }
function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

function statOrNull(file) {
  try { return fs.lstatSync(file) } catch { return null }
}

function readdirSafe(dir, options) {
  try { return fs.readdirSync(dir, options) } catch { return [] }
}

function realpathOrNull(file) {
  try { return fs.realpathSync.native(file) } catch { return null }
}

function samePath(a, b) {
  const left = path.resolve(String(a))
  const right = path.resolve(String(b))
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function readJsonQuiet(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function fileSize(file) {
  const info = statOrNull(file)
  return info ? info.size : -1
}

function hasSqliteHeader(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(SQLITE_MAGIC.length)
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
    return read === buffer.length && buffer.toString('latin1') === SQLITE_MAGIC
  } catch {
    return false
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch {} }
  }
}

// ---------------------------------------------------------------- lock & leases

/**
 * The one lock that coordinates create/delete/restore/prune. It is reentrant
 * inside this process (withFileLock keeps a held set), so a restore may create
 * its own safety backup and prune while still holding it.
 */
export function withBackupLock(action) {
  ensureDir(backupsDir())
  return withFileLock(lockAnchor(), action)
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

function readLeases() {
  const raw = readJson(leaseFile(), {})
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

/** Leases of operations that are still running right now. */
export function activeLeases() {
  const now = Date.now()
  const live = {}
  for (const [name, lease] of Object.entries(readLeases())) {
    if (!lease || typeof lease !== 'object') continue
    if (now - Number(lease.at || 0) > LEASE_TTL_MS) continue
    if (!pidAlive(Number(lease.pid))) continue
    live[name] = lease
  }
  return live
}

function writeLease(name, lease) {
  const leases = readLeases()
  if (lease) leases[name] = lease
  else delete leases[name]
  writeJson(leaseFile(), leases)
}

// ------------------------------------------------------------- sqlite snapshots
//
// One rule: a live SQLite database is only ever snapshotted by SQLite itself,
// through the plugin's own isolated interpreter (engine/<version>/venv). There
// is no global-Python path and no byte-copy fallback. A copy of a live database
// - or of a database plus its WAL - is torn the moment a writer commits between
// the two reads, and a torn copy restores as silent corruption, which is worse
// than no backup at all. So when the managed engine cannot produce a provable
// snapshot, the whole backup FAILS and nothing is published.
//
// The one file that may be copied verbatim is a zero-byte placeholder: no page
// was ever written and there are no WAL frames, so there is nothing to tear.

function engineRoot() { return path.join(dataDir(), 'engine') }

function engineCurrent() {
  const raw = readJsonQuiet(engineCurrentFile())
  if (!raw || typeof raw !== 'object') return null
  return {
    version: raw.version || null,
    schemaVersion: raw.schemaVersion || null,
    python: typeof raw.python === 'string' && raw.python ? raw.python : null,
    venv: typeof raw.venv === 'string' && raw.venv ? raw.venv : null,
  }
}

function venvPythonPath(venv) {
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python3')
}

/** True when both paths exist and `child` resolves inside `parent`. */
function insideDir(child, parent) {
  if (typeof child !== 'string' || !child) return false
  const left = realpathOrNull(child)
  const right = realpathOrNull(parent)
  if (!left || !right) return false
  const a = process.platform === 'win32' ? left.toLowerCase() : left
  const b = process.platform === 'win32' ? right.toLowerCase() : right
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)
}

/**
 * Every interpreter the plugin itself installed: whatever `engine/current.json`
 * points at first (that file is only written after the engine was verified
 * against the real databases), then any engine/<version>/venv* directory found
 * on disk, newest first. The on-disk scan is what makes an engine repair
 * possible: while a new engine installs, its venv is still `venv.tmp-*` and
 * current.json still points at the broken one.
 */
function engineVenvCandidates() {
  const root = engineRoot()
  const out = []
  const seen = new Set()
  const add = (venv, version, source) => {
    if (typeof venv !== 'string' || !venv) return
    const key = process.platform === 'win32' ? venv.toLowerCase() : venv
    if (seen.has(key)) return
    seen.add(key)
    out.push({ venv, version: version || null, source })
  }
  const current = engineCurrent()
  add(current?.venv, current?.version, 'engine/current.json')
  const mtimeOf = (file) => { const info = statOrNull(file); return info ? info.mtimeMs : 0 }
  const versions = readdirSafe(root, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => ({ name: item.name, at: mtimeOf(path.join(root, item.name)) }))
    .sort((a, b) => b.at - a.at)
  for (const version of versions) {
    const dir = path.join(root, version.name)
    const venvs = readdirSafe(dir, { withFileTypes: true })
      .filter((item) => item.isDirectory() && item.name.indexOf('venv') === 0)
      .map((item) => ({ name: item.name, at: mtimeOf(path.join(dir, item.name)) }))
      .sort((a, b) => b.at - a.at)
    for (const venv of venvs) add(path.join(dir, venv.name), version.name, 'engine/' + version.name + '/' + venv.name)
  }
  return out
}

// The probe answers two questions at once: does this interpreter have sqlite3,
// and is it really the isolated venv (sys.prefix) rather than a shim that hands
// the work to a global Python.
const PYTHON_PROBE_SCRIPT = [
  'import json, sys',
  'out = {"ok": False, "error": "unknown"}',
  'try:',
  '    import sqlite3',
  '    out = {"ok": True, "prefix": sys.prefix, "sqlite": getattr(sqlite3, "sqlite_version", "unknown")}',
  'except Exception as error:',
  '    out = {"ok": False, "prefix": sys.prefix, "error": str(error)}',
  'sys.stdout.write(json.dumps(out))',
].join(NEWLINE)

const SQLITE_SNAPSHOT_SCRIPT = [
  'import json, sqlite3, sys',
  'src, dst = sys.argv[1], sys.argv[2]',
  'out = {"ok": False, "error": "unknown"}',
  'try:',
  '    source = sqlite3.connect(src, timeout=10)',
  '    try:',
  '        target = sqlite3.connect(dst)',
  '        try:',
  '            source.backup(target)',
  '            row = target.execute("pragma quick_check").fetchone()',
  '            out = {"ok": True, "quickCheck": (row[0] if row else "unknown")}',
  '        finally:',
  '            target.close()',
  '    finally:',
  '        source.close()',
  'except Exception as error:',
  '    out = {"ok": False, "error": str(error)}',
  'sys.stdout.write(json.dumps(out))',
].join(NEWLINE)

let enginePythonCache = null

/** Forget the cached interpreter probe (tests use this between scenarios). */
export function resetBackupPythonProbe() { enginePythonCache = null }

/**
 * Runs an interpreter. `exec` is a seam for tests only (a fake interpreter);
 * production always spawns the verified venv binary and nothing else.
 */
function runPython(exec, cmd, args, timeout) {
  const runner = typeof exec === 'function' ? exec : spawnSync
  try {
    return runner(cmd, args, { timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  } catch (error) {
    return { error, status: null, stdout: '', stderr: '' }
  }
}

function jsonOutcome(result) {
  const text = String(result?.stdout || '').trim()
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

/**
 * Resolves the engine interpreter a snapshot may use, or reports why there is
 * none. Never falls back to a global interpreter: a missing, foreign or broken
 * venv is a refusal, not a downgrade.
 */
function enginePythonForBackup(exec) {
  const disabled = process.env.DSH_MEMU_BACKUP_NO_PYTHON === '1'
  const root = engineRoot()
  const candidates = disabled ? [] : engineVenvCandidates()
  const key = JSON.stringify({ disabled, root, candidates })
  if (enginePythonCache && enginePythonCache.key === key) return enginePythonCache.value
  const value = { python: null, rejected: [] }
  for (const candidate of candidates) {
    const python = venvPythonPath(candidate.venv)
    if (!fs.existsSync(python)) {
      value.rejected.push(candidate.source + ': no interpreter on disk')
      continue
    }
    if (!insideDir(candidate.venv, root) || !insideDir(python, root)) {
      value.rejected.push(candidate.source + ': outside ' + root)
      continue
    }
    const probe = runPython(exec, python, ['-c', PYTHON_PROBE_SCRIPT], PROBE_TIMEOUT_MS)
    const outcome = jsonOutcome(probe)
    if (!outcome || outcome.ok !== true) {
      const reason = outcome?.error || probe?.error?.message || (probe?.status != null ? 'exited ' + probe.status : 'no answer')
      value.rejected.push(candidate.source + ': ' + String(reason).slice(0, 200))
      continue
    }
    if (!insideDir(outcome.prefix, root)) {
      value.rejected.push(candidate.source + ': interpreter reports sys.prefix ' + String(outcome.prefix) + ', outside engine/')
      continue
    }
    value.python = {
      cmd: python,
      venv: candidate.venv,
      version: candidate.version,
      source: candidate.source,
      sqlite: outcome.sqlite ? String(outcome.sqlite) : null,
    }
    break
  }
  enginePythonCache = { key, value }
  return value
}

function backupRefusal(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function removeQuietly(file) {
  try { fs.rmSync(file, { force: true }) } catch {}
}

/**
 * Asks the engine interpreter to run SQLite's online backup API: it folds any
 * live WAL into one self-contained file and hands back a proven-consistent
 * snapshot. Anything short of a clean `quick_check` is a failure, never a
 * reason to copy the bytes ourselves.
 */
function pythonSnapshot(exec, python, from, to) {
  const result = runPython(exec, python.cmd, ['-c', SQLITE_SNAPSHOT_SCRIPT, from, to], PYTHON_TIMEOUT_MS)
  if (result?.error) return { ok: false, error: String(result.error.message || result.error) }
  if (result?.status !== 0) {
    return { ok: false, error: String(result?.stderr || ('engine interpreter exited ' + result?.status)).trim().slice(0, 400) }
  }
  const payload = jsonOutcome(result)
  if (!payload || payload.ok !== true) {
    return { ok: false, error: String(payload?.error || 'sqlite3 backup returned no result').slice(0, 400) }
  }
  if (payload.quickCheck !== 'ok') {
    return { ok: false, error: 'snapshot failed pragma quick_check: ' + String(payload.quickCheck || 'unknown').slice(0, 200) }
  }
  if (!hasSqliteHeader(to) || fileSize(to) <= 0) {
    return { ok: false, error: 'snapshot has no SQLite database header' }
  }
  return { ok: true, quickCheck: 'ok' }
}

/**
 * Produces one consistent copy of a live SQLite database inside the staging
 * directory. Two outcomes only: a snapshot the engine proved consistent, or a
 * thrown refusal that aborts the whole backup.
 */
function snapshotDatabase(from, to, exec) {
  const before = statOrNull(from)
  if (!before) return { mode: 'missing' }
  if (before.isSymbolicLink()) throw new Error('backup refuses symbolic links')
  if (!before.isFile()) throw new Error('backup refuses non-file: ' + path.basename(from))
  const name = path.basename(from)
  const walSize = fileSize(from + '-wal')
  const walContent = walSize > 0
  if (before.size === 0 && !walContent) {
    // A placeholder no engine has written a page to: copying it cannot tear.
    fs.copyFileSync(from, to)
    return { mode: 'empty-placeholder', quickCheck: 'empty' }
  }
  if (!hasSqliteHeader(from)) {
    throw backupRefusal('DSH_MEMU_BACKUP_NOT_SQLITE', 'backup refuses ' + name
      + ': it is neither an empty placeholder nor a SQLite database, so its contents cannot be verified'
      + (walContent ? ' (it has a non-empty WAL)' : ''))
  }
  const resolved = enginePythonForBackup(exec)
  const python = resolved.python
  if (!python) {
    const why = resolved.rejected.length ? ' (' + resolved.rejected.join('; ') + ')' : ''
    throw backupRefusal('DSH_MEMU_BACKUP_ENGINE_REQUIRED', 'backup of ' + name
      + " needs the plugin engine: no verified engine/<version>/venv Python with sqlite3 was found under "
      + engineRoot() + why + '. Install or repair the engine, then retry. '
      + 'Nothing was copied: a live database copied by hand can restore as silent corruption.')
  }
  const snapshot = pythonSnapshot(exec, python, from, to)
  if (!snapshot.ok) {
    removeQuietly(to)
    removeQuietly(to + '-wal')
    removeQuietly(to + '-shm')
    throw backupRefusal('DSH_MEMU_BACKUP_SNAPSHOT_FAILED', 'backup could not snapshot ' + name + ' with '
      + python.source + ' (engine ' + String(python.version || 'unknown') + '): ' + snapshot.error)
  }
  return {
    mode: 'sqlite-backup-api',
    engine: python.version ? String(python.version) : null,
    via: python.source,
    sqlite: python.sqlite,
    quickCheck: snapshot.quickCheck,
  }
}

// ------------------------------------------------------------------- inventory

function copyRegular(from, to) {
  const info = statOrNull(from)
  if (!info) return false
  if (info.isSymbolicLink()) throw new Error('backup refuses symbolic links')
  if (!info.isFile()) throw new Error('backup refuses non-file: ' + path.basename(from))
  ensureDir(path.dirname(to))
  fs.copyFileSync(from, to)
  return true
}

function copyTree(from, to) {
  const entries = readdirSafe(from, { withFileTypes: true })
  if (!entries.length && !statOrNull(from)) return
  ensureDir(to)
  for (const item of entries) {
    if (item.isSymbolicLink()) throw new Error('backup refuses symbolic links')
    const source = path.join(from, item.name)
    const target = path.join(to, item.name)
    if (item.isDirectory()) copyTree(source, target)
    else copyRegular(source, target)
  }
}

function collectFiles(dir, prefix = '', out = {}) {
  for (const item of readdirSafe(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)
    const rel = prefix ? prefix + '/' + item.name : item.name
    const info = statOrNull(full)
    if (!info) continue
    if (info.isSymbolicLink()) throw new Error('backup refuses symbolic links')
    if (info.isDirectory()) { collectFiles(full, rel, out); continue }
    if (!info.isFile()) continue
    out[rel] = { bytes: info.size, sha256: sha256File(full) }
  }
  return out
}

// --------------------------------------------------------------- backup creation

function nextBackupName() {
  const base = isoStamp().replace(/[:.]/g, '-')
  let name = base
  for (let attempt = 0; fs.existsSync(path.join(backupsDir(), name)); attempt += 1) {
    if (attempt >= 64) throw new Error('cannot allocate a unique backup name')
    name = base + '-' + process.pid.toString(36) + attempt.toString(36)
  }
  return name
}

function vectorSummary() {
  const raw = readJsonQuiet(vectorActiveFile())
  if (!raw || typeof raw !== 'object') return { present: false }
  const active = raw.active && typeof raw.active === 'object' ? raw.active : null
  const profile = active && active.profile && typeof active.profile === 'object' ? active.profile : null
  const libraries = active && active.databases && active.databases.libraries && typeof active.databases.libraries === 'object'
    ? Object.keys(active.databases.libraries).length
    : 0
  return {
    present: true,
    generation: Number.isSafeInteger(raw.generation) ? raw.generation : null,
    active: active
      ? {
        generation: Number.isSafeInteger(active.generation) ? active.generation : null,
        fingerprint: typeof active.fingerprint === 'string' ? active.fingerprint : null,
        catalogId: typeof profile?.catalogId === 'string' ? profile.catalogId : null,
        revision: typeof profile?.revision === 'string' ? profile.revision : null,
        dimension: Number.isSafeInteger(profile?.dimension) ? profile.dimension : null,
        libraries,
      }
      : null,
    pending: raw.pending && typeof raw.pending === 'object' ? String(raw.pending.status || '') : null,
  }
}

function engineSummary() {
  const current = engineCurrent()
  return current ? { version: current.version, schemaVersion: current.schemaVersion } : null
}

/**
 * Copies every store a restore needs: plugin state, the global index and the
 * per-library index files, the active vector profile journal, prompt overrides
 * and their manifest, attachment references, and every MemU SQLite database.
 * Deliberately absent: engine/, downloads/, logs/, tmp/ (large and
 * re-downloadable) and any key material - the manifest carries identity, never
 * a credential.
 *
 * `exec` only exists so tests can stand in for the engine interpreter; the
 * default path spawns the verified venv binary and nothing else.
 */
function writeStores(staging, exec) {
  ensureDir(path.join(staging, 'libraries'))
  ensureDir(path.join(staging, 'index'))
  ensureDir(path.join(staging, 'prompts'))
  copyRegular(stateFile(), path.join(staging, 'state.json'))
  for (const name of readdirSafe(indexDir())) {
    if (name.endsWith('.json')) copyRegular(path.join(indexDir(), name), path.join(staging, 'index', name))
  }
  copyRegular(path.join(dataDir(), 'prompts', 'manifest.json'), path.join(staging, 'prompts', 'manifest.json'))
  copyTree(path.join(dataDir(), 'prompts'), path.join(staging, 'prompts'))
  copyTree(path.join(dataDir(), 'attachments'), path.join(staging, 'attachments'))
  const databases = []
  const globalInfo = statOrNull(globalDbFile())
  if (globalInfo && globalInfo.isFile()) databases.push({ src: globalDbFile(), rel: 'global.sqlite3' })
  for (const item of readdirSafe(librariesDir(), { withFileTypes: true })) {
    if (!item.isFile() || !item.name.endsWith('.sqlite3')) continue
    databases.push({ src: path.join(librariesDir(), item.name), rel: 'libraries/' + item.name })
  }
  const snapshots = []
  for (const database of databases) {
    const target = path.join(staging, database.rel.split('/').join(path.sep))
    ensureDir(path.dirname(target))
    const result = snapshotDatabase(database.src, target, exec)
    snapshots.push({
      file: database.rel,
      mode: result.mode,
      engine: result.engine || null,
      quickCheck: result.quickCheck || null,
    })
  }
  return snapshots
}

function publishStaging(staging, name) {
  const dir = path.join(backupsDir(), name)
  if (fs.existsSync(dir)) throw new Error('backup directory already exists: ' + name)
  try {
    fs.renameSync(staging, dir)
  } catch (error) {
    throw new Error('could not publish backup ' + name + ': ' + (error?.code || 'io error'))
  }
  return dir
}

function discardStaging(staging) {
  try { fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3 }) } catch (error) {
    warn('backups: could not discard staging directory (' + (error?.code || 'io error') + ')')
  }
}

/** Staging leftovers of crashed runs are reclaimed; a live sibling is kept. */
function cleanupStaging() {
  const root = stagingRoot()
  const now = Date.now()
  for (const item of readdirSafe(root, { withFileTypes: true })) {
    if (!item.isDirectory()) continue
    const full = path.join(root, item.name)
    const parts = item.name.split('.')
    const pid = Number(parts.length > 1 ? parts[parts.length - 2] : NaN)
    const info = statOrNull(full)
    const age = info ? now - info.mtimeMs : 0
    const mine = Number.isSafeInteger(pid) && pid === process.pid
    const stale = mine ? age > STAGING_TTL_MS : (!Number.isSafeInteger(pid) || !pidAlive(pid) || age > STAGING_TTL_MS)
    if (!stale) continue
    try { fs.rmSync(full, { recursive: true, force: true, maxRetries: 3 }) } catch {}
  }
}

/**
 * Creates one managed backup of the current data root, then keeps the newest
 * BACKUP_KEEP complete ones. Returns a report whose dir is the published
 * directory, so every existing caller that treats the return value as a path
 * keeps working.
 *
 * `pythonExec` is a test seam for the engine interpreter (see writeStores).
 * A database that cannot be snapshotted by the verified engine throws, and the
 * throw happens before anything is published, so no partial or torn backup can
 * ever appear in backups/.
 */
export function createBackup({ label = 'auto', keep = BACKUP_KEEP, flushState = null, pythonExec = null } = {}) {
  return withBackupLock(() => {
    ensureDir(backupsDir())
    cleanupStaging()
    const name = nextBackupName()
    const staging = path.join(stagingRoot(), name + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex'))
    ensureDir(staging)
    try {
      // Plugin state is flushed first: a backup must never capture the pending
      // bookkeeping edits that are still only in memory.
      if (typeof flushState === 'function') flushState()
      const snapshots = writeStores(staging, pythonExec)
      const files = collectFiles(staging)
      const totals = { files: 0, bytes: 0 }
      for (const rel of Object.keys(files)) {
        totals.files += 1
        totals.bytes += Number(files[rel].bytes || 0)
      }
      const createdAt = isoStamp()
      const manifest = {
        version: BACKUP_SCHEMA,
        kind: 'dsh-memu-memory/backup',
        name,
        uniqueId: name + '-' + crypto.randomBytes(4).toString('hex'),
        createdAt,
        createdAtMs: Date.parse(createdAt) || Date.now(),
        label: String(label || 'auto'),
        complete: true,
        engine: engineSummary(),
        vector: vectorSummary(),
        snapshot: { databases: snapshots },
        totals,
        files,
      }
      // Written last and atomically: a finished manifest is the completion
      // marker that prune requires before it may delete anything.
      writeJson(path.join(staging, 'manifest.json'), manifest)
      const dir = publishStaging(staging, name)
      const prune = pruneBackups({ keep })
      return {
        name,
        dir,
        createdAt,
        files: totals.files,
        bytes: totals.bytes,
        snapshots: snapshots.map(item => ({ file: item.file, mode: item.mode, engine: item.engine || null })),
        pruned: prune.deleted,
        pruneFailed: prune.failed,
        pendingCleanup: prune.pendingCleanup,
        notice: prune.notice,
      }
    } catch (error) {
      discardStaging(staging)
      throw error
    }
  })
}

// -------------------------------------------------------------- listing / scan

function isManagedName(name) {
  return typeof name === 'string' && isSafeId(name) && MANAGED_NAME.test(name)
}

/** A relative path inside a backup that we are willing to copy back. */
function isSafeRelative(rel) {
  if (typeof rel !== 'string' || !rel) return false
  if (path.isAbsolute(rel)) return false
  if (rel.indexOf(BACKSLASH) !== -1) return false
  for (const part of rel.split('/')) {
    if (!part || part === '.' || part === '..') return false
  }
  return true
}

function inventoryIssues(dir, files) {
  const issues = []
  const rels = Object.keys(files)
  if (!rels.length) return ['manifest lists no files']
  for (const rel of rels) {
    if (!isSafeRelative(rel)) { issues.push('unsafe path in manifest: ' + rel.slice(0, 120)); continue }
    if (issues.length >= 5) { issues.push('and more'); break }
    const full = path.join(dir, rel.split('/').join(path.sep))
    const info = statOrNull(full)
    if (!info) { issues.push('missing: ' + rel); continue }
    if (!info.isFile()) { issues.push('not a file: ' + rel); continue }
    const expected = Number(files[rel]?.bytes)
    if (Number.isFinite(expected) && expected !== info.size) issues.push('size mismatch: ' + rel)
  }
  return issues
}

function buildEntry(name, dir, manifest, status, issues) {
  const files = manifest?.files && typeof manifest.files === 'object' ? manifest.files : null
  let bytes = null
  if (files) {
    bytes = 0
    for (const rel of Object.keys(files)) bytes += Number(files[rel]?.bytes || 0)
  }
  const createdAt = typeof manifest?.createdAt === 'string' ? manifest.createdAt : null
  const info = statOrNull(dir)
  const parsed = Date.parse(createdAt || '')
  return {
    name,
    dir,
    createdAt: createdAt || (info ? new Date(info.mtimeMs).toISOString() : null),
    createdAtMs: Number.isFinite(Number(manifest?.createdAtMs)) ? Number(manifest.createdAtMs) : (Number.isFinite(parsed) ? parsed : (info ? info.mtimeMs : 0)),
    engine: manifest?.engine || null,
    files: files ? Object.keys(files).length : null,
    bytes,
    hasManifest: Boolean(manifest),
    complete: status === 'complete',
    status,
    issues: issues.slice(0, 6),
    uniqueId: typeof manifest?.uniqueId === 'string' ? manifest.uniqueId : null,
    label: typeof manifest?.label === 'string' ? manifest.label : null,
    vector: manifest?.vector || null,
  }
}

/**
 * Reads one directory in backups/ and classifies it. status is 'complete'
 * (only these are counted or deleted), 'incomplete', 'corrupt' or 'unknown'.
 * verify re-hashes every file: cheap listing stays cheap, but retention must
 * never count a backup it has not actually checked.
 */
function scanEntry(name, { verify = false } = {}) {
  const dir = path.join(backupsDir(), name)
  const info = statOrNull(dir)
  if (!info) return null
  if (info.isSymbolicLink()) return buildEntry(name, dir, null, 'unknown', ['backups entry is a symbolic link or junction'])
  if (!info.isDirectory()) return buildEntry(name, dir, null, 'unknown', ['backups entry is not a directory'])
  const manifest = readJsonQuiet(path.join(dir, 'manifest.json'))
  const issues = []
  let status = 'complete'
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    status = 'unknown'
    issues.push('manifest.json is missing or unreadable')
  } else if (!isManagedName(name)) {
    status = 'unknown'
    issues.push('not a managed backup name')
  } else if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    status = 'incomplete'
    issues.push('manifest has no file inventory')
  } else if (manifest.complete !== true) {
    status = 'incomplete'
    issues.push('backup was never completed')
  }
  if (status === 'complete') {
    for (const issue of inventoryIssues(dir, manifest.files)) issues.push(issue)
    if (issues.length) status = 'incomplete'
  }
  if (status === 'complete' && verify) {
    for (const rel of Object.keys(manifest.files)) {
      const expected = manifest.files[rel] || {}
      if (typeof expected.sha256 !== 'string' || !expected.sha256) continue
      const full = path.join(dir, rel.split('/').join(path.sep))
      let actual = null
      try { actual = sha256File(full) } catch { actual = null }
      if (actual === expected.sha256) continue
      status = 'corrupt'
      issues.push('checksum mismatch: ' + rel)
      break
    }
  }
  if (status !== 'unknown') {
    const real = realpathOrNull(dir)
    if (!real || !samePath(real, dir)) { status = 'unknown'; issues.push('directory resolves somewhere else (link or junction)') }
    else if (!samePath(path.dirname(path.resolve(dir)), path.resolve(backupsDir()))) { status = 'unknown'; issues.push('directory is not a direct child of backups/') }
  }
  return buildEntry(name, dir, manifest, status, issues)
}

function compareEntries(a, b) {
  // createdAt first because mtimes lie, then the name: names are unique inside
  // backups/ and a colliding millisecond appends a monotonic suffix, so the
  // order stays deterministic without trusting the filesystem's clock.
  if (b.createdAtMs !== a.createdAtMs) return b.createdAtMs - a.createdAtMs
  return String(b.name).localeCompare(String(a.name))
}

/** Every entry in backups/, newest first, including incomplete and unknown. */
export function scanBackups({ verify = false } = {}) {
  const out = []
  for (const item of readdirSafe(backupsDir(), { withFileTypes: true })) {
    if (item.name.startsWith('.')) continue
    const scanned = scanEntry(item.name, { verify })
    if (scanned) out.push(scanned)
  }
  return out.sort(compareEntries)
}

/** Public listing used by the UI: newest first, with completeness reported. */
export function listBackupEntries() { return scanBackups() }

export function findBackup(name) {
  if (!isSafeId(name) || name.startsWith('.')) throw new Error('invalid backup name')
  const dir = path.join(backupsDir(), name)
  if (!statOrNull(dir)) throw new Error('backup not found: ' + name)
  const found = scanEntry(name)
  if (!found) throw new Error('backup not found: ' + name)
  return found
}

// ----------------------------------------------------------------------- prune

function assertNoLinks(dir, prefix) {
  for (const item of readdirSafe(dir, { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + item.name : item.name
    if (item.isSymbolicLink()) throw new Error('refusing to delete: ' + rel + ' is a link')
    if (item.isDirectory()) assertNoLinks(path.join(dir, item.name), rel)
  }
}

/**
 * Every guard a recursive delete needs, re-checked on the resolved path:
 * managed single-segment name, direct child of backups/, realpath unchanged,
 * and no link or junction anywhere inside.
 */
function assertRemovable(found) {
  if (!found || typeof found.name !== 'string' || !isManagedName(found.name)) throw new Error('refusing to delete a backup with an unmanaged name')
  const dir = path.join(backupsDir(), found.name)
  const info = statOrNull(dir)
  if (!info) throw new Error('backup not found: ' + found.name)
  if (info.isSymbolicLink()) throw new Error('refusing to delete a link: ' + found.name)
  if (!info.isDirectory()) throw new Error('refusing to delete a non-directory: ' + found.name)
  if (!samePath(path.dirname(path.resolve(dir)), path.resolve(backupsDir()))) throw new Error('refusing to delete outside backups/: ' + found.name)
  const real = realpathOrNull(dir)
  if (!real || !samePath(real, dir)) throw new Error('refusing to delete a redirected path: ' + found.name)
  assertNoLinks(dir, '')
}

function removeBackupDir(found) {
  assertRemovable(found)
  fs.rmSync(path.join(backupsDir(), found.name), { recursive: true, force: true, maxRetries: 3 })
}

/**
 * Keeps the newest keep complete managed backups and deletes the rest.
 * Incomplete and unknown entries are reported, never counted, never deleted.
 * A leased directory (a restore or migration is reading it) is skipped, as is
 * the safety backup named in protect - retention may briefly exceed the limit,
 * and the next prune reclaims it.
 */
export function pruneBackups({ keep = BACKUP_KEEP, protect = [] } = {}) {
  return withBackupLock(() => {
    ensureDir(backupsDir())
    cleanupStaging()
    const protectSet = new Set()
    for (const name of protect) if (name) protectSet.add(path.basename(String(name)))
    for (const name of Object.keys(activeLeases())) protectSet.add(name)
    // Retention decides what to delete, so it pays for the full hash pass: a
    // backup whose bytes no longer match its manifest must not occupy one of the
    // three slots, and must never be the reason an intact one is deleted.
    const all = scanBackups({ verify: true })
    const complete = all.filter(found => found.status === 'complete')
    const victims = complete.slice(keep).filter(found => !protectSet.has(found.name))
    const deleted = []
    const failed = []
    for (const victim of victims) {
      try {
        removeBackupDir(victim)
        deleted.push(victim.name)
      } catch (error) {
        failed.push({ name: victim.name, error: String(error?.message || error) })
        warn('backups: could not remove ' + victim.name + ' (' + String(error?.message || error) + ')')
      }
    }
    const kept = deleted.length
      ? scanBackups().filter(found => found.status === 'complete')
      : complete.filter(found => !deleted.includes(found.name))
    const notice = 'at most ' + keep + ' complete backups are kept; older ones are cleaned up automatically'
    if (deleted.length) {
      warn('backups: ' + notice + ' (deleted ' + deleted.join(', ') + ')')
      try {
        const marker = path.join(backupsDir(), '.retention-notice.json')
        if (!readJsonQuiet(marker)) writeJson(marker, { at: isoStamp(), policy: 'keep ' + keep, notice })
      } catch {}
    }
    return {
      keep,
      notice,
      deleted,
      failed,
      protected: Array.from(protectSet),
      pendingCleanup: Math.max(0, kept.length - keep),
      kept: kept.map(found => found.name),
      skipped: all.filter(found => found.status !== 'complete').map(found => ({ name: found.name, status: found.status, issues: found.issues })),
    }
  })
}

/** Explicit removal requested by the user. */
export function deleteBackupEntry(name) {
  return withBackupLock(() => {
    const found = findBackup(name)
    if (activeLeases()[found.name]) throw new Error('backup is in use by a running restore: ' + found.name)
    removeBackupDir(found)
    return { deleted: found.name, status: found.status }
  })
}

// --------------------------------------------------------------------- restore

/** Where one relative path inside a backup lands in the live data root. */
function liveTargetFor(rel) {
  const parts = rel.split('/')
  const head = parts[0]
  if (parts.length === 1) {
    if (head === 'state.json') return stateFile()
    if (head === 'global.sqlite3') return globalDbFile()
    if (head === 'global.sqlite3-wal') return globalDbFile() + '-wal'
    if (head === 'global.sqlite3-shm') return globalDbFile() + '-shm'
  }
  if ((head === 'index' || head === 'libraries') && parts.length === 2) {
    return path.join(head === 'index' ? indexDir() : librariesDir(), parts[1])
  }
  if ((head === 'prompts' || head === 'attachments') && parts.length >= 2) {
    return path.join(dataDir(), parts.join(path.sep))
  }
  throw new Error('backup contains an entry this version cannot restore: ' + rel)
}

function writeAtomicCopy(from, to) {
  ensureDir(path.dirname(to))
  const tmp = to + '.restore-' + process.pid + '-' + crypto.randomBytes(4).toString('hex')
  try {
    fs.copyFileSync(from, tmp)
    const fd = fs.openSync(tmp, 'r+')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    for (let attempt = 0; ; attempt += 1) {
      try { fs.renameSync(tmp, to); return } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt >= 5) throw error
        pause(RETRY_MS * (attempt + 1))
      }
    }
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }) } catch {}
    throw error
  }
}

/** A restored database must not inherit the WAL of the one it replaces. */
function dropCompanions(target) {
  for (const suffix of ['-wal', '-shm']) {
    try { fs.rmSync(target + suffix, { force: true }) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

function isSidecar(rel) {
  return rel.endsWith('-wal') || rel.endsWith('-shm')
}

/** A database file always lands before its sidecars. */
function restoreOrder(rels) {
  return rels.slice().sort((left, right) => {
    const delta = (isSidecar(left) ? 1 : 0) - (isSidecar(right) ? 1 : 0)
    if (delta !== 0) return delta
    return left.localeCompare(right)
  })
}

/**
 * Validates the WHOLE inventory before anything is written, so a restore either
 * has every byte it needs or leaves the live root untouched.
 */
function verifyInventory(found) {
  const manifest = readJsonQuiet(path.join(found.dir, 'manifest.json'))
  if (!manifest || typeof manifest !== 'object' || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error('backup is incomplete: ' + found.name + ' has no file inventory')
  }
  const rels = []
  for (const rel of Object.keys(manifest.files)) {
    if (!isSafeRelative(rel)) throw new Error('invalid backup manifest path')
    const full = path.join(found.dir, rel.split('/').join(path.sep))
    const info = statOrNull(full)
    if (!info || info.isSymbolicLink() || !info.isFile()) throw new Error('backup is incomplete: ' + rel + ' is missing')
    const expected = manifest.files[rel] || {}
    if (Number.isFinite(Number(expected.bytes)) && Number(expected.bytes) !== info.size) {
      throw new Error('backup is corrupt: ' + rel + ' has the wrong size')
    }
    if (expected.sha256 && sha256File(full) !== expected.sha256) {
      throw new Error('backup is corrupt: ' + rel + ' failed its checksum')
    }
    liveTargetFor(rel)
    rels.push(rel)
  }
  if (!rels.length) throw new Error('backup is incomplete: ' + found.name + ' lists no files')
  return { manifest, rels }
}

function normalizeDbRel(value) {
  if (typeof value !== 'string' || !value) return null
  const rel = value.split(BACKSLASH).join('/').replace(/^\.\//, '')
  if (rel.startsWith('libraries/')) return rel
  if (rel.indexOf('/') === -1) return 'libraries/' + rel
  return rel
}

/**
 * A backup made before the vector journal existed carries no vector-active
 * manifest. Restoring it over a live root that still points at the newer
 * generation would leave recall reading tables the restored text index never
 * saw, so that pointer must be retired, and the same holds for a journal that
 * points at databases the backup does not contain.
 */
function planVectorActive(found, rels) {
  const rel = 'index/vector-active.json'
  if (!rels.includes(rel)) return { action: 'absent', restore: false }
  const raw = readJsonQuiet(path.join(found.dir, 'index', 'vector-active.json'))
  if (!raw || typeof raw !== 'object') return { action: 'unreadable', restore: false }
  const active = raw.active && typeof raw.active === 'object' ? raw.active : null
  if (!active) return { action: 'restore', restore: true }
  const needed = []
  const global = active.databases && active.databases.global
  if (global && typeof global.path === 'string') needed.push(global.path)
  const libraries = active.databases && active.databases.libraries
  if (libraries && typeof libraries === 'object') {
    for (const key of Object.keys(libraries)) {
      const item = libraries[key]
      if (item && typeof item.path === 'string') needed.push(item.path)
    }
  }
  const missing = []
  for (const value of needed) {
    const normalized = normalizeDbRel(value)
    if (!normalized || !rels.includes(normalized)) missing.push(String(value))
  }
  if (missing.length) return { action: 'missing-databases', restore: false, missing: missing.slice(0, 5) }
  return { action: 'restore', restore: true }
}

/** Moves the live vector-active pointer aside so recall falls back to text. */
function retireVectorActive(reason) {
  const live = vectorActiveFile()
  const info = statOrNull(live)
  if (!info) return 'absent'
  if (info.isSymbolicLink()) {
    warn('backups: the live vector-active.json is a link; leaving it alone')
    return 'unreadable'
  }
  const aside = live + '.stale-' + isoStamp().replace(/[:.]/g, '-')
  try { fs.renameSync(live, aside) } catch (error) {
    throw new Error('the restored data has no usable vector-active manifest and the stale pointer could not be retired: ' + String(error?.message || error))
  }
  warn('backups: ' + reason + '; the stale vector-active pointer was moved to ' + path.basename(aside) + ' so recall falls back to lexical text')
  return 'cleared'
}

/**
 * Puts a backup back. The target is leased and fully verified first, the live
 * root is saved as a safety backup second, and only then is anything written.
 * A failure after that point is recoverable: the safety backup holds the state
 * that was replaced, and it is protected from this operation's prune.
 */
export function restoreFromBackup(name, { beforeRestore = null, flushState = null, clearCaches = null, keep = BACKUP_KEEP } = {}) {
  return withBackupLock(() => {
    const found = findBackup(name)
    const plan = verifyInventory(found)
    const vector = planVectorActive(found, plan.rels)
    writeLease(found.name, { pid: process.pid, at: Date.now(), kind: 'restore' })
    let safety = null
    try {
      const created = typeof beforeRestore === 'function'
        ? beforeRestore()
        : createBackup({ label: 'before-restore', flushState })
      safety = typeof created === 'string' ? created : (created && created.dir ? created.dir : null)
      const rels = restoreOrder(plan.rels.filter(rel => rel !== 'index/vector-active.json' || vector.restore))
      for (const rel of rels) {
        const target = liveTargetFor(rel)
        if (rel.endsWith('.sqlite3')) dropCompanions(target)
        writeAtomicCopy(path.join(found.dir, rel.split('/').join(path.sep)), target)
      }
      const vectorActive = vector.restore
        ? 'restored'
        : retireVectorActive(vector.action === 'absent'
          ? 'this backup predates the vector generation journal'
          : 'the vector journal in this backup does not match the databases it contains')
      if (typeof clearCaches === 'function') clearCaches()
      const prune = pruneBackups({ keep, protect: safety ? [path.basename(safety)] : [] })
      return {
        restored: found.name,
        safety,
        files: rels.length,
        vectorActive,
        pruned: prune.deleted,
        pendingCleanup: prune.pendingCleanup,
      }
    } catch (error) {
      const reason = String(error?.message || error)
      warn('backups: restore of ' + found.name + ' failed: ' + reason)
      const wrapped = new Error(safety
        ? 'restore failed (' + reason + '); the live state it replaced is saved as ' + path.basename(safety)
        : 'restore failed (' + reason + ') and no safety backup could be made')
      wrapped.code = 'DSH_MEMU_BACKUP_RESTORE_FAILED'
      wrapped.cause = error
      wrapped.safety = safety ? path.basename(safety) : null
      // Whatever landed on disk is the truth now: cached readers must not keep
      // serving the half-replaced state.
      try { if (typeof clearCaches === 'function') clearCaches() } catch {}
      throw wrapped
    } finally {
      try { writeLease(found.name, null) } catch {}
    }
  })
}
