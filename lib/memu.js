import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { dataDir, ensureDir, redactSecrets } from './paths.js'
import { readCurrent, verifyEngine } from './engine.js'
import { getSettings } from './state.js'

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
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch {}
    }, timeoutMs)
    child.stdout?.on('data', (d) => { stdout += d.toString() })
    child.stderr?.on('data', (d) => { stderr += d.toString() })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new MemuError(`failed to start memu: ${error.message}`, 'MEMU_SPAWN_FAILED', { error }))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve({ stdout, stderr, code })
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

function run(args, opts) {
  return runRaw(['-m', 'memu', ...args], opts)
}

function envFor({ db, provider, embedModel, baseUrl, apiKey }) {
  const env = {}
  if (db) env.MEMU_DB = db
  if (provider) env.MEMU_EMBED_PROVIDER = provider
  if (embedModel) env.MEMU_EMBED_MODEL = embedModel
  if (baseUrl) env.MEMU_BASE_URL = baseUrl
  if (apiKey) env.MEMU_API_KEY = apiKey
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

export async function retrieve({ query, db, provider, embedModel, baseUrl, apiKey, timeoutMs = 60_000 }) {
  if (!query || !String(query).trim()) {
    throw new MemuError('retrieve requires a non-empty query', 'MEMU_BAD_ARGUMENT')
  }
  const res = await run(['retrieve', String(query), '--json'], {
    env: envFor({ db, provider, embedModel, baseUrl, apiKey }),
    timeoutMs,
  })
  const data = parseJson(res.stdout)
  if (data === null) {
    return { raw: res.stdout.trim(), parseWarning: 'memu retrieve returned non-JSON' }
  }
  return data
}

export async function listFiles({ db, provider, embedModel, baseUrl, apiKey, timeoutMs = 60_000 } = {}) {
  const res = await run(['list-files', '--json'], {
    env: envFor({ db, provider, embedModel, baseUrl, apiKey }),
    timeoutMs,
  })
  const data = parseJson(res.stdout)
  if (data === null) {
    return { recall_files: [], raw: res.stdout.trim(), parseWarning: 'memu list-files returned non-JSON' }
  }
  return data
}

export async function commit({ payload, db, provider, embedModel, baseUrl, apiKey, timeoutMs = 180_000 }) {
  const tmpDir = ensureDir(path.join(dataDir(), 'tmp'))
  const file = path.join(tmpDir, `commit-${process.pid}-${Date.now()}.json`)
  try {
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
    const res = await run(['commit', file, '--json'], {
      env: envFor({ db, provider, embedModel, baseUrl, apiKey }),
      timeoutMs,
    })
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
  const verified = await verifyEngine(current.python)
  return { ...verified, current }
}
