import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  dataDir, engineDir, downloadsDir, logsDir, librariesDir, ensureDir, readJson, writeJson, stamp, windowsSystemEnv,
} from './paths.js'
import { getSettings, globalDbPath } from './state.js'
import { ensureManagedPython } from './managed-runtime.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOCK_PATH = path.join(HERE, '..', 'requirements.lock')

export const ENGINE_VERSION = '0.11.0b3'
export const REQUIRED_COMMANDS = ['retrieve', 'list-files', 'commit']
export const OPTIONAL_COMMANDS = ['search', 'memorize']

const STATE_FILE = () => path.join(engineDir(), 'state.json')
const CURRENT_FILE = () => path.join(engineDir(), 'current.json')
const LOCK_FILE = () => path.join(engineDir(), 'install.lock')
const INSTALL_LOG = () => path.join(logsDir(), 'install.log')
const AVAILABLE_FILE = () => path.join(engineDir(), 'available-versions.json')

const VERSION_CACHE_MS = 5 * 60 * 1000
// Persisted version lists are good enough to show without a network round trip.
const PERSISTED_TTL_MS = 24 * 60 * 60 * 1000
let versionCache = { at: 0, value: null }

// Compare PEP 440-ish versions without a dependency. A plain release is newer
// than a pre-release of the same number (`0.11.0` > `0.11.0b3`).
export function compareVersions(a, b) {
  const split = (value) => {
    const text = String(value || '').trim()
    const match = text.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/)
    if (!match) return { nums: [0, 0, 0], pre: text }
    return { nums: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] || '' }
  }
  const left = split(a)
  const right = split(b)
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i] - right.nums[i]
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre.localeCompare(right.pre, undefined, { numeric: true })
}

export function normalizeVersion(raw) {
  const match = String(raw || '').match(/^(\d+\.\d+\.\d+(?:[A-Za-z]+\d*)?)/)
  return match ? match[1] : null
}

export function parseSimpleVersions(html) {
  const found = new Set()
  // The distribution is `memu-cli`, while the CLI command is `memu`. Match the
  // distribution name here; matching bare `memu` picks up the unrelated MeMu
  // Game Boy package that owns that PyPI name.
  const re = /memu[_-]cli-(\d[0-9A-Za-z.]*[0-9A-Za-z])[-.]/g
  let match
  while ((match = re.exec(String(html || ''))) !== null) {
    const version = normalizeVersion(match[1])
    if (version) found.add(version)
  }
  return [...found]
}

export function readAvailableVersions() {
  try {
    const cached = readJson(AVAILABLE_FILE(), null)
    if (cached && cached.package === 'memu-cli' && Array.isArray(cached.versions)) return cached
  } catch {}
  return null
}

// The plugin never silently installs the newest release (CLI/JSON changes are
// real), but it can still answer "what exists?" without the user leaving Settings.
// PyPI JSON is tried first; the mirrors only expose simple indexes, so their HTML
// is parsed as a fallback. Failures are reported, never thrown into the page.
export async function fetchAvailableVersions({ force = false, timeoutMs = 6000 } = {}) {
  if (!force) {
    if (versionCache.value && Date.now() - versionCache.at < VERSION_CACHE_MS) {
      return { ...versionCache.value, cached: true }
    }
    // A cold process used to re-query PyPI every time Settings opened, and with
    // pypi.org unreachable that meant waiting out every timeout in turn. A
    // day-old answer is fine for a "what could I install" list.
    const persisted = readAvailableVersions()
    const fetchedAt = Date.parse(persisted?.fetchedAt || '') || 0
    if (persisted && fetchedAt > 0 && Date.now() - fetchedAt < PERSISTED_TTL_MS) {
      versionCache = { at: fetchedAt, value: persisted }
      return { ...persisted, cached: true }
    }
  }
  // Mirrors first: the package is mirrored in full, and pypi.org is the slowest
  // of these from mainland China.
  const sources = [
    { name: 'Tsinghua', url: 'https://pypi.tuna.tsinghua.edu.cn/pypi/memu-cli/json', json: true },
    { name: 'Aliyun', url: 'https://mirrors.aliyun.com/pypi/simple/memu-cli/', json: false },
    { name: 'PyPI', url: 'https://pypi.org/pypi/memu-cli/json', json: true },
    { name: 'Tsinghua-simple', url: 'https://pypi.tuna.tsinghua.edu.cn/simple/memu-cli/', json: false },
    { name: 'PyPI-simple', url: 'https://pypi.org/simple/memu-cli/', json: false },
  ]
  const errors = []
  for (const source of sources) {
    try {
      const response = await fetch(source.url, {
        headers: { accept: source.json ? 'application/json' : 'text/html' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = source.json ? await response.json() : await response.text()
      const versions = source.json
        ? Object.keys(body?.releases || body?.info ? (body.releases || {}) : {})
        : parseSimpleVersions(body)
      const clean = [...new Set(versions.map(normalizeVersion).filter(Boolean))]
        .sort((a, b) => compareVersions(b, a))
      if (clean.length === 0) throw new Error('no versions in response')
      const value = {
        ok: true,
        package: 'memu-cli',
        source: source.name,
        versions: clean.slice(0, 40),
        latest: clean[0],
        fetchedAt: stamp(),
      }
      versionCache = { at: Date.now(), value }
      try { writeJson(AVAILABLE_FILE(), value) } catch {}
      return { ...value, cached: false }
    } catch (error) {
      errors.push(`${source.name}: ${error?.message || error}`)
    }
  }
  const persisted = readAvailableVersions()
  if (persisted) return { ...persisted, ok: false, cached: true, errors }
  return { ok: false, versions: [], latest: null, errors, fetchedAt: stamp() }
}

const DEFAULT_INDEXES = [
  'https://pypi.tuna.tsinghua.edu.cn/simple',
  'https://mirrors.aliyun.com/pypi/simple/',
  'https://pypi.org/simple',
]

function isWindows() {
  return process.platform === 'win32'
}

export function venvPython(venv) {
  return isWindows()
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python3')
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...windowsSystemEnv(), ...process.env, ...(opts.env || {}) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch {}
    }, opts.timeoutMs ?? 120_000)
    child.stdout?.on('data', (d) => {
      const s = d.toString()
      stdout += s
      opts.onData?.(s)
    })
    child.stderr?.on('data', (d) => {
      const s = d.toString()
      stderr += s
      opts.onData?.(s)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr, error, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

function logLine(message, sink) {
  const line = `[${stamp()}] ${message}`
  try {
    ensureDir(logsDir())
    fs.appendFileSync(INSTALL_LOG(), line + '\n', 'utf8')
  } catch {}
  try { sink?.(line) } catch {}
}

function readState() {
  return readJson(STATE_FILE(), {}) || {}
}

function writeState(patch) {
  const next = { ...readState(), ...patch, updatedAt: stamp() }
  writeJson(STATE_FILE(), next)
  return next
}

export function readCurrent() {
  const current = readJson(CURRENT_FILE(), null)
  if (!current || typeof current.python !== 'string' || typeof current.venv !== 'string') return null
  return current
}

// Every version this machine has actually installed, kept so the engine page can
// offer a rollback target after the plugin itself is upgraded. It is a record of
// intent; `listEngineVersions` still verifies the venv is really on disk.
const HISTORY_FILE = () => engineDir('history.json')

function readHistory() {
  const raw = readJson(HISTORY_FILE(), null)
  return raw && typeof raw === 'object' ? raw : {}
}

function recordHistory(entry) {
  const history = readHistory()
  history[entry.version] = {
    ...history[entry.version],
    ...entry,
  }
  writeJson(HISTORY_FILE(), history)
  return history
}

function entryFromCurrent(current) {
  return {
    version: current.version,
    venv: current.venv,
    python: current.python,
    commands: current.commands || null,
    mirror: current.mirror || null,
    installedAt: current.installedAt || current.switchedAt || null,
  }
}

// Installs made before the history file existed (or a history file removed by
// hand) otherwise render as a bare version row with no install time or mirror.
// `current.json` still has that data, so backfill it once on the next read.
function ensureHistory(current = readCurrent()) {
  const history = readHistory()
  if (!current) return history
  const known = history[current.version]
  if (known?.installedAt && known?.mirror) return history
  const fresh = entryFromCurrent(current)
  history[current.version] = {
    ...fresh,
    ...known,
    installedAt: known?.installedAt || fresh.installedAt,
    mirror: known?.mirror || fresh.mirror,
    commands: known?.commands || fresh.commands,
    venv: known?.venv || fresh.venv,
    python: known?.python || fresh.python,
  }
  try { writeJson(HISTORY_FILE(), history) } catch {}
  return history
}

// Walking a venv is thousands of stat() calls; doing it on every `getState`
// made opening Settings slow. The number is stable until the version is
// reinstalled, so it is remembered in history.json and memoised per process.
const sizeCache = new Map()
const sizedThisSession = new Set()

function rememberedSize(version) {
  try {
    const history = JSON.parse(fs.readFileSync(HISTORY_FILE(), 'utf8'))
    const bytes = history?.[version]?.sizeBytes
    return Number.isFinite(bytes) ? bytes : null
  } catch {
    return null
  }
}

function rememberSize(version, bytes) {
  try {
    const history = JSON.parse(fs.readFileSync(HISTORY_FILE(), 'utf8'))
    if (!history?.[version]) return
    if (history[version].sizeBytes === bytes) return
    history[version].sizeBytes = bytes
    writeJson(HISTORY_FILE(), history)
  } catch {}
}

function sizeOfVersion(version, dir) {
  if (sizeCache.has(version)) return sizeCache.get(version)
  const stored = rememberedSize(version)
  const bytes = stored === null ? dirSizeBytes(dir) : stored
  sizeCache.set(version, bytes)
  if (stored === null && !sizedThisSession.has(version)) {
    sizedThisSession.add(version)
    rememberSize(version, bytes)
  }
  return bytes
}

function dirSizeBytes(dir) {
  let total = 0
  const walk = (current) => {
    let names = []
    try { names = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of names) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      try { total += fs.statSync(full).size } catch {}
    }
  }
  walk(dir)
  return total
}

function recordProbe(version, verified) {
  try {
    const history = ensureHistory(readCurrent())
    const entry = history[version] || {}
    history[version] = {
      ...entry,
      version,
      probe: verified?.ok
        ? { ok: true, at: stamp() }
        : { ok: false, at: stamp(), error: String(verified?.error || 'probe failed').slice(0, 300) },
      commands: verified?.commands || entry.commands || null,
    }
    writeJson(HISTORY_FILE(), history)
  } catch {}
}

export function listEngineVersions({ withSize = false } = {}) {
  const current = readCurrent()
  const history = ensureHistory(current)
  const names = new Set([...Object.keys(history), ENGINE_VERSION])
  // A directory can exist without a history entry (hand-copied venv, an install
  // interrupted before the record), so scan the tree too.
  try {
    for (const name of fs.readdirSync(engineDir())) {
      if (fs.existsSync(path.join(engineDir(), name, 'venv'))) names.add(name)
    }
  } catch {}
  return [...names]
    .filter(Boolean)
    .map((version) => {
      const known = history[version]
      const venv = known?.venv || engineDir(version, 'venv')
      const python = known?.python || venvPython(venv)
      const installed = fs.existsSync(venv)
      // "installed" only means a venv directory is there. "usable" means a probe
      // actually ran it: a venv whose python was deleted, or whose deps were
      // half-installed, still passes the directory check.
      const probe = known?.probe || null
      const usable = installed ? (probe ? probe.ok === true : null) : false
      return {
        version,
        installed,
        usable,
        probeAt: probe?.at || null,
        probeError: probe && probe.ok === false ? probe.error || 'probe failed' : null,
        schemaVersion: known?.schemaVersion || null,
        sizeBytes: withSize && installed ? sizeOfVersion(version, path.dirname(venv)) : null,
        current: installed && current?.version === version,
        recommended: version === ENGINE_VERSION,
        installedAt: known?.installedAt || null,
        mirror: known?.mirror || null,
        commands: known?.commands || null,
        venv,
        python,
      }
    })
    .sort((a, b) => String(b.installedAt || '').localeCompare(String(a.installedAt || '')))
}

/**
 * Deletes old engine versions, keeping the current one, the recommended one and
 * the newest `keep`. A version that is running cannot be removed on Windows, so
 * anything locked is skipped and reported instead of failing the batch.
 */
export function pruneEngineVersions({ keep = 3 } = {}) {
  const limit = Math.max(1, Math.min(10, Number(keep) || 3))
  const versions = listEngineVersions().filter((v) => v.installed)
  const protectedNames = new Set(versions.filter((v) => v.current || v.recommended).map((v) => v.version))
  const ordered = [...versions].sort((a, b) => String(b.installedAt || '').localeCompare(String(a.installedAt || '')))
  const keepNames = new Set()
  for (const v of ordered) {
    if (keepNames.size >= limit) break
    keepNames.add(v.version)
  }
  const removed = []
  const skipped = []
  for (const v of versions) {
    if (protectedNames.has(v.version) || keepNames.has(v.version)) { skipped.push(v.version); continue }
    try {
      fs.rmSync(engineDir(v.version), { recursive: true, force: true })
      const history = ensureHistory(readCurrent())
      delete history[v.version]
      try { writeJson(HISTORY_FILE(), history) } catch {}
      removed.push(v.version)
    } catch (error) {
      skipped.push(`${v.version} (${error?.code || 'locked'})`)
    }
  }
  return { removed, skipped, kept: [...protectedNames, ...keepNames] }
}

export function removeEngineVersion(version) {
  const target = listEngineVersions().find((v) => v.version === version)
  if (!target) return { ok: false, error: `unknown version: ${version}` }
  if (!target.installed) return { ok: false, error: `version ${version} is not installed` }
  if (target.current) return { ok: false, error: 'the current version cannot be removed; switch first' }
  if (!acquireLock()) return { ok: false, status: 'installing', error: 'another install is already running' }
  try {
    fs.rmSync(engineDir(version), { recursive: true, force: true })
    const history = ensureHistory(readCurrent())
    delete history[version]
    try { writeJson(HISTORY_FILE(), history) } catch {}
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  } finally {
    releaseLock()
  }
}

// ---- real-database gate -----------------------------------------------------
// An empty-temp-dir probe (verifyEngine) only proves the binary starts. The
// danger is switching engines while real memory databases exist that the new
// binary cannot read — or silently downgrading a schema a newer engine wrote.
// Before the current pointer moves, the target python must read every real
// database, and a version downgrade must be forced explicitly.

function realDatabases() {
  const dbs = []
  try {
    const globalDb = globalDbPath()
    if (fs.existsSync(globalDb)) dbs.push(globalDb)
  } catch {}
  try {
    for (const name of fs.readdirSync(librariesDir())) {
      if (name.endsWith('.sqlite3')) dbs.push(path.join(librariesDir(), name))
    }
  } catch {}
  return dbs
}

const ALEMBIC_SCRIPT = [
  'import json, sqlite3, sys',
  'db = sys.argv[1]',
  'conn = sqlite3.connect(db)',
  'try:',
  '    rows = conn.execute("select version_num from alembic_version").fetchall()',
  '    print(json.dumps({"versions": [r[0] for r in rows]}))',
  'except Exception as e:',
  '    print(json.dumps({"versions": [], "error": str(e)}))',
  'finally:',
  '    conn.close()',
].join('\n')

async function schemaVersions(python, dbs) {
  const out = {}
  for (const db of dbs) {
    try {
      const res = await run(python, ['-c', ALEMBIC_SCRIPT, db], { timeoutMs: 30_000 })
      if (res.code !== 0) throw new Error((res.stderr || `exit ${res.code}`).trim())
      out[db] = JSON.parse(res.stdout.trim()).versions
    } catch {
      out[db] = null
    }
  }
  return out
}

async function smokeRealDatabases(python, { log } = {}) {
  const dbs = realDatabases()
  for (const db of dbs) {
    logLine(`smoke-reading ${path.basename(db)} with target engine`, log)
    // Read-only: list-files never writes. MEMU_MEMORY_MODE stays local so the
    // probe cannot touch a configured cloud backend.
    const res = await run(python, ['-m', 'memu', 'list-files', '--json'], {
      timeoutMs: 90_000,
      env: { MEMU_DB: db, MEMU_MEMORY_MODE: 'local' },
    })
    if (res.code !== 0) {
      throw new Error(`目标引擎读不了现有记忆库 ${path.basename(db)}：${(res.stderr || res.stdout || '').trim().slice(-400)}`)
    }
  }
  return dbs
}

function versionRank(v) {
  const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)(?:b(\d+))?/)
  if (!m) return null
  // A final release outranks its betas: 0.11.0 > 0.11.0b3.
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? Number(m[4]) : Number.MAX_SAFE_INTEGER]
}

export function isVersionDowngrade(from, to) {
  const a = versionRank(from)
  const b = versionRank(to)
  if (!a || !b) return false
  for (let i = 0; i < 4; i += 1) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}

// Roll back (or forward) to an already-installed version. Verified first, and the
// caller's `beforeSwitch` runs before the pointer moves, so a bad target can never
// become current and data is snapshotted on the way in.
export async function switchEngineVersion(version, { log = null, beforeSwitch = null, force = false } = {}) {
  const target = listEngineVersions().find((v) => v.version === version)
  if (!target || !target.installed) {
    return { ok: false, error: `version ${version} is not installed` }
  }
  if (readCurrent()?.version === version) return { ok: true, current: readCurrent(), unchanged: true }

  if (!acquireLock()) return { ok: false, status: 'installing', error: 'another install is already running' }
  try {
    const verified = await verifyEngine(target.python, { log })
    // Record what the probe saw, so the version list can say "usable" or "broken"
    // instead of guessing from the presence of a venv directory.
    recordProbe(version, verified)
    if (!verified.ok) return { ok: false, error: `目标版本自检未通过：${verified.error}` }

    const dbs = realDatabases()
    const safety = typeof beforeSwitch === 'function' ? await beforeSwitch() : null
    if (dbs.length && !safety) throw new Error('a verified backup is required before switching an engine with real databases')
    if (dbs.length > 0) {
      const currentMeta = readCurrent()
      if (!force && currentMeta && isVersionDowngrade(version, currentMeta.version)) {
        return {
          ok: false,
          error: `拒绝降级：现有记忆库由更新的引擎 ${currentMeta.version} 写入，切到 ${version} 可能损坏数据；如确认要降级请勾选强制`,
        }
      }
      const beforeSchemas = await schemaVersions(currentMeta?.python || target.python, dbs)
      await smokeRealDatabases(target.python, { log })
      const afterSchemas = await schemaVersions(target.python, dbs)
      for (const db of dbs) {
        const a = JSON.stringify(beforeSchemas[db] || [])
        const b = JSON.stringify(afterSchemas[db] || [])
        if (a !== b && !force) throw new Error(`schema revision changed: ${a} -> ${b}; backup ${safety}; explicit confirmation is required`)
      }
    }

    const current = {
      version,
      venv: target.venv,
      python: target.python,
      commands: verified.commands,
      mirror: target.mirror,
      installedAt: target.installedAt || stamp(),
      switchedAt: stamp(),
    }
    writeJson(CURRENT_FILE(), current)
    writeState({ status: 'ready', version, step: 'ready', error: null })
    logLine(`switched engine to ${version}`, log)
    return { ok: true, current, verified }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  } finally {
    releaseLock()
  }
}

/** Sizes only, for the client to fetch after the page has painted. */
export function engineVersionSizes() {
  const sizes = {}
  for (const version of listEngineVersions()) {
    if (!version.installed) continue
    sizes[version.version] = sizeOfVersion(version.version, path.dirname(version.venv))
  }
  return sizes
}

export function engineStatus({ withSize = false } = {}) {
  const current = readCurrent()
  const state = readState()
  return {
    status: current ? 'ready' : state.status || 'idle',
    version: current?.version || state.version || ENGINE_VERSION,
    installed: Boolean(current),
    recommendedVersion: ENGINE_VERSION,
    current,
    state,
    versions: listEngineVersions({ withSize }),
    log: INSTALL_LOG(),
  }
}

export function mirrorCandidates() {
  // The settings page's pipIndexes list is a real user preference and must be
  // honored here; env vars only add transient overrides on top.
  const fromSettings = Array.isArray(getSettings().pipIndexes)
    ? getSettings().pipIndexes.map((s) => String(s || '').trim()).filter(Boolean)
    : []
  const configured = String(process.env.DSH_MEMU_PIP_INDEXES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const envIndex = String(process.env.PIP_INDEX_URL || '').trim()
  const list = envIndex ? [envIndex, ...fromSettings, ...configured, ...DEFAULT_INDEXES] : [...fromSettings, ...configured, ...DEFAULT_INDEXES]
  return [...new Set(list)]
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function acquireLock() {
  ensureDir(engineDir())
  const file = LOCK_FILE()
  try {
    const fd = fs.openSync(file, 'wx')
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: stamp() }), 'utf8')
    fs.closeSync(fd)
    return true
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const existing = readJson(file, null)
    const started = existing?.startedAt ? Date.parse(existing.startedAt) : 0
    if (Date.now() - started > 30 * 60 * 1000) {
      try { fs.rmSync(file, { force: true }) } catch {}
      return acquireLock()
    }
    return false
  }
}

function releaseLock() {
  try { fs.rmSync(LOCK_FILE(), { force: true }) } catch {}
}

async function pythonVersion(cmd, prefix = []) {
  const res = await run(cmd, [...prefix, '-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}")'], {
    timeoutMs: 15_000,
  })
  if (res.code !== 0) return null
  const text = res.stdout.trim().split(/\r?\n/).pop() || ''
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw: text }
}

async function hasPip(cmd, prefix = []) {
  const res = await run(cmd, [...prefix, '-m', 'pip', '--version'], { timeoutMs: 20_000 })
  return res.code === 0
}

function dshRuntimePythons() {
  const out = []
  const runtimeRoot = path.join(
    process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    'dsh-runtimes',
  )
  try {
    for (const name of fs.readdirSync(runtimeRoot)) {
      const base = path.join(runtimeRoot, name, 'dependencies', 'python')
      const exe = isWindows() ? path.join(base, 'python.exe') : path.join(base, 'bin', 'python3')
      if (fs.existsSync(exe)) out.push(exe)
    }
  } catch {}
  if (process.env.DSH_RUNTIME_PYTHON && fs.existsSync(process.env.DSH_RUNTIME_PYTHON)) {
    out.unshift(process.env.DSH_RUNTIME_PYTHON)
  }
  return out
}

async function pythonCandidate(cmd, prefix = [], source = 'path') {
  const version = await pythonVersion(cmd, prefix)
  if (!version || version.major !== 3 || version.minor < 11) return null
  const pip = await hasPip(cmd, prefix)
  return { kind: 'python', cmd, prefix, version, hasPip: pip, source }
}

export async function resolvePythonCandidates() {
  const out = []
  const seen = new Set()
  const push = (c) => {
    if (!c) return
    const key = `${c.cmd}|${c.prefix.join(' ')}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(c)
  }

  if (process.env.DSH_MEMU_PYTHON) {
    push(await pythonCandidate(process.env.DSH_MEMU_PYTHON, [], 'env'))
  }

  // Prefer interpreters with reliable wheels: 3.13, 3.12, DSH bundled, then 3.14.
  for (const ver of ['3.13', '3.12', '3.11']) {
    push(await pythonCandidate('py', [`-${ver}`], `py ${ver}`))
  }
  for (const exe of dshRuntimePythons()) {
    push(await pythonCandidate(exe, [], 'dsh-runtime'))
  }
  for (const exe of ['python3', 'python']) {
    push(await pythonCandidate(exe, [], exe))
  }
  push(await pythonCandidate('py', ['-3.14'], 'py 3.14'))

  return out
}

async function cleanupDir(dir) {
  try { await fsp.rm(dir, { recursive: true, force: true }) } catch {}
}

async function cleanupDownloads() {
  try {
    const dir = downloadsDir()
    for (const name of await fsp.readdir(dir)) {
      await fsp.rm(path.join(dir, name), { recursive: true, force: true })
    }
  } catch {}
}

async function installIntoVenv({ base, venv, mirror, log }) {
  const python = venvPython(venv)
  if (base.uvPath) {
    const result = await run(base.uvPath, ['pip', 'install', '--python', python, '-r', LOCK_PATH,
      '--index-url', mirror, '--only-binary', ':all:', '--no-cache', '--no-progress'],
    { env: base.uvEnv, timeoutMs: 20 * 60 * 1000, onData: data => logLine(data.trim(), log) })
    if (result.code !== 0) throw new Error(`managed uv dependency install failed (exit ${result.code})`)
    return
  }
  if (!base.hasPip) {
    throw new Error(`Python ${base.cmd} ${base.prefix.join(' ')} has no pip; install pip or uv first`)
  }
  logLine(`pip install using ${mirror}`, log)
  const res = await run(base.cmd, [
    ...base.prefix,
    '-m', 'pip', '--python', python,
    'install', '-r', LOCK_PATH,
    '--index-url', mirror,
    '--disable-pip-version-check',
    '--no-input',
    '--no-cache-dir',
    '--only-binary=:all:',
    '--timeout', '45',
    '--retries', '3',
  ], {
    env: { PIP_NO_CACHE_DIR: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' },
    timeoutMs: 20 * 60 * 1000,
    onData: (s) => {
      for (const line of s.split(/\r?\n/)) if (line.trim()) logLine(line.trim(), log)
    },
  })
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || '').trim().split(/\r?\n/).slice(-6).join(' | ')
    throw new Error(`pip install failed (exit ${res.code}${res.timedOut ? ', timeout' : ''}): ${detail}`)
  }
}

async function parseMemuCommands(python) {
  const res = await run(python, ['-m', 'memu', '--help'], { timeoutMs: 30_000 })
  if (res.code !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || 'memu --help failed').trim() }
  }
  const text = `${res.stdout}\n${res.stderr}`
  const commands = new Set()
  for (const name of [...REQUIRED_COMMANDS, ...OPTIONAL_COMMANDS]) {
    if (new RegExp(`(^|[\\s{,])(?:${name}|${name}\\s*\\()`, 'm').test(text)) commands.add(name)
  }
  return { ok: true, commands: [...commands], help: text }
}

export async function verifyEngine(python, { log } = {}) {
  const versionRes = await run(python, ['-c', 'import importlib.metadata as m; print(m.version("memu-cli"))'], {
    timeoutMs: 30_000,
  })
  if (versionRes.code !== 0) {
    return { ok: false, error: `memu-cli import failed: ${(versionRes.stderr || versionRes.stdout).trim()}` }
  }
  const version = versionRes.stdout.trim().split(/\r?\n/).pop() || ''
  const commands = await parseMemuCommands(python)
  if (!commands.ok) return { ok: false, version, error: commands.error }
  const missing = REQUIRED_COMMANDS.filter((c) => !commands.commands.includes(c))
  if (missing.length > 0) {
    return { ok: false, version, commands: commands.commands, error: `missing required commands: ${missing.join(', ')}` }
  }
  const tmpDb = path.join(os.tmpdir(), `dsh-memu-memory-smoke-${process.pid}-${Date.now()}.sqlite3`)
  try {
    const res = await run(python, ['-m', 'memu', 'list-files', '--json', '--db', tmpDb], { timeoutMs: 60_000 })
    if (res.code !== 0) {
      return { ok: false, version, commands: commands.commands, error: `list-files smoke failed: ${(res.stderr || res.stdout).trim()}` }
    }
    try { JSON.parse(res.stdout) } catch {
      return { ok: false, version, commands: commands.commands, error: 'list-files smoke returned non-JSON' }
    }
  } finally {
    try { fs.rmSync(tmpDb, { force: true }) } catch {}
    try { fs.rmSync(`${tmpDb}-wal`, { force: true }) } catch {}
    try { fs.rmSync(`${tmpDb}-shm`, { force: true }) } catch {}
  }
  logLine(`engine verified: memu-cli ${version}, commands ${commands.commands.join(',')}`, log)
  return { ok: true, version, commands: commands.commands }
}

function stateInstalling(step, extra = {}) {
  const previous = readState()
  return writeState({
    status: 'installing',
    version: ENGINE_VERSION,
    step,
    error: null,
    // Keep the first start time across step updates so the UI shows elapsed time
    // instead of restarting its clock every time the step advances.
    startedAt: previous.status === 'installing' && previous.startedAt ? previous.startedAt : stamp(),
    ...extra,
  })
}

function stateError(error, extra = {}) {
  const previous = readState()
  return writeState({
    status: 'error',
    version: ENGINE_VERSION,
    step: 'failed',
    error: String(error?.message || error),
    startedAt: previous.startedAt || null,
    finishedAt: stamp(),
    ...extra,
  })
}

// The installer already writes every step to ~/.dsh/dsh-memu-memory/logs/install.log.
// Surfacing the tail turns "Installing…" from a black box into progress: pip's own
// lines say which package it is on when a mirror stalls.
export function readInstallLogTail(maxLines = 14, maxBytes = 24 * 1024) {
  try {
    const stat = fs.statSync(INSTALL_LOG())
    const start = Math.max(0, stat.size - maxBytes)
    const fd = fs.openSync(INSTALL_LOG(), 'r')
    const buffer = Buffer.alloc(stat.size - start)
    try { fs.readSync(fd, buffer, 0, buffer.length, start) } finally { fs.closeSync(fd) }
    return buffer.toString('utf8').split(/\r?\n/).filter((line) => line.trim()).slice(-maxLines)
  } catch {
    return []
  }
}

export async function installEngine({ force = false, log = null, beforeSwitch = null } = {}) {
  const current = readCurrent()
  if (!force && current?.version === ENGINE_VERSION) {
    const verified = await verifyEngine(current.python, { log })
    if (verified.ok) return { ok: true, current, verified }
  }

  if (!acquireLock()) {
    return { ok: false, status: 'installing', error: 'another install is already running' }
  }

  try {
    ensureDir(engineDir())
    ensureDir(downloadsDir())
    stateInstalling('resolving-python')
    logLine(`installing MemU engine ${ENGINE_VERSION}`, log)

    const candidates = await resolvePythonCandidates()
    if (!candidates.some(candidate => candidate.hasPip)) candidates.push(await ensureManagedPython({ run, log: line => logLine(line, log) }))
    logLine(`python candidates: ${candidates.map((c) => `${c.cmd} ${c.prefix.join(' ')} (${c.version.raw}${c.hasPip ? '' : ', no-pip'})`).join('; ')}`, log)

    const errors = []
    const versionDir = engineDir(ENGINE_VERSION)
    ensureDir(versionDir)

    for (const base of candidates) {
      if (!base.hasPip && !base.uvPath) continue
      const tmpVenv = path.join(versionDir, `venv.tmp-${process.pid}-${Date.now()}`)
      try {
        stateInstalling(`creating-venv:${base.source}`)
        logLine(`creating venv with ${base.cmd} ${base.prefix.join(' ')}`, log)
        const venvRes = await run(base.cmd, [...base.prefix, '-m', 'venv', '--without-pip', tmpVenv], {
          timeoutMs: 120_000,
          onData: (s) => { for (const line of s.split(/\r?\n/)) if (line.trim()) logLine(line.trim(), log) },
        })
        if (venvRes.code !== 0) {
          throw new Error(`venv creation failed: ${(venvRes.stderr || venvRes.stdout).trim()}`)
        }

        stateInstalling(`installing-deps:${base.source}`)
        let installed = false
        let lastMirror = ''
        for (const mirror of mirrorCandidates()) {
          lastMirror = mirror
          try {
            await installIntoVenv({ base, venv: tmpVenv, mirror, log })
            installed = true
            break
          } catch (error) {
            errors.push(`${base.source} @ ${mirror}: ${error.message}`)
            logLine(`mirror failed: ${mirror}: ${error.message}`, log)
          }
        }
        if (!installed) throw new Error(`all mirrors failed for ${base.source}`)

        stateInstalling(`verifying:${base.source}`)
        const python = venvPython(tmpVenv)
        const verified = await verifyEngine(python, { log })
        if (!verified.ok) throw new Error(`verify failed: ${verified.error}`)

        if (typeof beforeSwitch === 'function') {
          stateInstalling('backing-up')
          await beforeSwitch()
        }
        if (realDatabases().length) {
          if (typeof beforeSwitch !== 'function') throw new Error('a verified backup is required before repairing an engine with real databases')
          await smokeRealDatabases(python, { log })
        }

        const finalVenv = fs.existsSync(path.join(versionDir, 'venv'))
          ? path.join(versionDir, `venv-${Date.now()}`)
          : path.join(versionDir, 'venv')
        await fsp.rename(tmpVenv, finalVenv)
        const finalPython = venvPython(finalVenv)
        const current = {
          version: ENGINE_VERSION,
          venv: finalVenv,
          python: finalPython,
          commands: verified.commands,
          mirror: lastMirror,
          installedAt: stamp(),
        }
        writeJson(CURRENT_FILE(), current)
        recordHistory(current)
        writeState({ status: 'ready', version: ENGINE_VERSION, step: 'ready', error: null, mirror: lastMirror })
        await cleanupDownloads()
        // New engine landed: keep the version count honest without waiting for
        // a manual prune. Never blocks the result.
        try { pruneEngineVersions({ keep: 3 }) } catch {}
        logLine(`engine ready: ${finalPython}`, log)
        return { ok: true, current, verified }
      } catch (error) {
        await cleanupDir(tmpVenv)
        errors.push(`${base.source}: ${error.message}`)
        logLine(`candidate failed: ${base.source}: ${error.message}`, log)
      }
    }

    throw new Error(`no Python candidate could install MemU:\n${errors.join('\n')}`)
  } catch (error) {
    stateError(error)
    await cleanupDownloads()
    logLine(`install failed: ${error.message}`, log)
    return { ok: false, status: 'error', error: String(error?.message || error) }
  } finally {
    releaseLock()
  }
}

export async function ensureEngine({ force = false, log = null, beforeSwitch = null } = {}) {
  const current = readCurrent()
  if (!force && current?.version === ENGINE_VERSION) {
    const verified = await verifyEngine(current.python, { log })
    if (verified.ok) {
      writeState({ status: 'ready', version: ENGINE_VERSION, step: 'ready', error: null })
      return { ok: true, current, verified }
    }
    logLine(`current engine failed verification: ${verified.error}; reinstalling`, log)
  }
  return installEngine({ force: true, log, beforeSwitch })
}

export function startBackgroundInstall({ log = null } = {}) {
  const status = engineStatus()
  if (status.status === 'installing') return status
  void ensureEngine({ log }).catch(() => {})
  return engineStatus()
}
