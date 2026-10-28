import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dataDir, ensureDir, stamp, withFileLock } from './paths.js'
import { getSettings } from './state.js'
import { commit, retrieve } from './memu.js'

export const MEMU_CONFIG_KEYS = [
  'MEMU_MEMORY_MODE',
  'MEMU_EMBED_PROVIDER',
  'MEMU_EMBED_MODEL',
  'MEMU_BASE_URL',
  'MEMU_API_KEY',
  'MEMU_SUMMARY_BASE_URL',
  'MEMU_SUMMARY_MODEL',
  'MEMU_SUMMARY_API_KEY',
  'MEMU_VISION_BASE_URL',
  'MEMU_VISION_MODEL',
  'MEMU_VISION_API_KEY',
]

export function memuConfigPath() {
  return process.env.MEMU_CONFIG || path.join(os.homedir(), '.memu', 'config.env')
}

function stripQuotes(value) {
  const v = String(value ?? '').trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  return v
}

export function readMemuEnv() {
  const file = memuConfigPath()
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return {} }
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    out[m[1]] = stripQuotes(m[2])
  }
  return out
}

function writeMemuEnv(values) {
  const file = memuConfigPath()
  ensureDir(path.dirname(file))
  const order = [...MEMU_CONFIG_KEYS]
  for (const key of Object.keys(values)) if (!order.includes(key)) order.push(key)
  const lines = [
    '# Managed by dsh-memu-memory. Other keys are preserved; comments are not.',
    `# updated: ${stamp()}`,
    ...order.filter((key) => values[key] !== undefined).map((key) => `${key}=${String(values[key]).replace(/\r?\n/g, ' ')}`),
    '',
  ]
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, lines.join('\n'), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  try { fs.renameSync(tmp, file) } catch (error) {
    try { fs.rmSync(tmp, { force: true }) } catch {}
    throw error
  }
}

const PROVIDER_ENV = {
  openai: 'OPENAI_API_KEY',
  jina: 'JINA_API_KEY',
  voyage: 'VOYAGE_API_KEY',
  doubao: 'DOUBAO_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
}

const CHAT_BASE_URL = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  deepseek: 'https://api.deepseek.com/v1',
}

const CHAT_MODEL = {
  openai: 'gpt-4o-mini',
  openrouter: 'openai/gpt-4o-mini',
  deepseek: 'deepseek-chat',
}

// MemU only ships remote embedding backends (doubao/jina/openai/openrouter/voyage)
// and DSH has no embedding capability of its own, so "本地" cannot mean "the host
// does it". What it can honestly mean is an OpenAI-compatible embeddings server on
// this machine — Ollama's default port is the commonest case. The plugin prefills
// that and leaves the key empty; it does not claim to work offline.
export const LOCAL_EMBED_BASE_URL = 'http://127.0.0.1:11434/v1'
export const LOCAL_EMBED_MODEL = 'nomic-embed-text'

export function getMemuConfig() {
  const env = { ...readMemuEnv(), ...process.env }
  const provider = String(env.MEMU_EMBED_PROVIDER || 'openai')
  const hasKey = Boolean(env.MEMU_API_KEY || (PROVIDER_ENV[provider] && env[PROVIDER_ENV[provider]]))
  const baseUrl = String(env.MEMU_BASE_URL || '')
  return {
    path: memuConfigPath(),
    mode: String(env.MEMU_MEMORY_MODE || 'local'),
    provider,
    model: String(env.MEMU_EMBED_MODEL || ''),
    baseUrl,
    hasKey,
    providers: Object.keys(PROVIDER_ENV),
    // Derived, not a separate stored flag: a loopback base URL is what "local"
    // actually means to MemU, so the toggle can never drift from the config.
    source: baseUrl && /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(baseUrl) ? 'local' : 'remote',
    localBaseUrl: LOCAL_EMBED_BASE_URL,
    localModel: LOCAL_EMBED_MODEL,
  }
}

export function getSummaryConfig({ withKey = false } = {}) {
  const env = { ...readMemuEnv(), ...process.env }
  const provider = String(env.MEMU_EMBED_PROVIDER || 'openai')
  const apiKey = String(env.MEMU_SUMMARY_API_KEY || env.MEMU_API_KEY || env[PROVIDER_ENV[provider]] || '')
  const baseUrl = String(env.MEMU_SUMMARY_BASE_URL || CHAT_BASE_URL[provider] || '').replace(/\/+$/, '')
  const model = String(env.MEMU_SUMMARY_MODEL || CHAT_MODEL[provider] || '')
  const view = {
    provider,
    baseUrl,
    model,
    hasKey: Boolean(apiKey),
    ready: Boolean(baseUrl && model && apiKey),
  }
  return withKey ? { ...view, apiKey } : view
}

// Switching source rewrites the connection fields but never the API key: leaving a
// third-party key in place after moving to a loopback endpoint would send it to a
// local server, and clearing it on the way out would silently break a working setup.
export function setEmbeddingSource(source, { keepModel = false } = {}) {
  const env = readMemuEnv()
  if (source === 'local') {
    env.MEMU_EMBED_PROVIDER = 'openai'
    env.MEMU_BASE_URL = String(env.MEMU_BASE_URL || '').includes('127.0.0.1') || String(env.MEMU_BASE_URL || '').includes('localhost')
      ? env.MEMU_BASE_URL
      : LOCAL_EMBED_BASE_URL
    if (!keepModel && !String(env.MEMU_EMBED_MODEL || '')) env.MEMU_EMBED_MODEL = LOCAL_EMBED_MODEL
  } else if (source === 'remote') {
    if (String(env.MEMU_BASE_URL || '') === LOCAL_EMBED_BASE_URL) delete env.MEMU_BASE_URL
    if (String(env.MEMU_EMBED_MODEL || '') === LOCAL_EMBED_MODEL) delete env.MEMU_EMBED_MODEL
  } else {
    throw new Error('source must be local or remote')
  }
  writeMemuEnv(env)
  return getMemuConfig()
}

export function getVisionConfig({ withKey = false } = {}) {
  const env = { ...readMemuEnv(), ...process.env }
  const baseUrl = String(env.MEMU_VISION_BASE_URL || '').replace(/\/+$/, '')
  const model = String(env.MEMU_VISION_MODEL || '')
  const apiKey = String(env.MEMU_VISION_API_KEY || '')
  const view = { baseUrl, model, hasKey: Boolean(apiKey), ready: Boolean(baseUrl && model) }
  return withKey ? { ...view, apiKey } : view
}

export function saveMemuConfig({ provider, model, baseUrl, apiKey, clearKey, summaryModel, summaryBaseUrl, summaryApiKey, clearSummaryKey, visionModel, visionBaseUrl, visionApiKey, clearVisionKey } = {}) {
  return withFileLock(memuConfigPath(), () => {
  const env = readMemuEnv()
  // Honour the storage-mode setting instead of pinning local, otherwise saving the
  // embedding config would silently undo a cloud-mode switch.
  env.MEMU_MEMORY_MODE = getSettings().memoryMode === 'cloud' ? 'cloud' : 'local'
  if (provider !== undefined && String(provider).trim()) env.MEMU_EMBED_PROVIDER = String(provider).trim()
  if (model !== undefined) env.MEMU_EMBED_MODEL = String(model).trim()
  if (baseUrl !== undefined) env.MEMU_BASE_URL = String(baseUrl).trim()
  if (apiKey !== undefined && String(apiKey).trim()) env.MEMU_API_KEY = String(apiKey).trim()
  if (clearKey === true) delete env.MEMU_API_KEY
  if (summaryModel !== undefined) env.MEMU_SUMMARY_MODEL = String(summaryModel).trim()
  if (summaryBaseUrl !== undefined) env.MEMU_SUMMARY_BASE_URL = String(summaryBaseUrl).trim()
  if (summaryApiKey !== undefined && String(summaryApiKey).trim()) env.MEMU_SUMMARY_API_KEY = String(summaryApiKey).trim()
  if (clearSummaryKey === true) delete env.MEMU_SUMMARY_API_KEY
  if (visionModel !== undefined) env.MEMU_VISION_MODEL = String(visionModel).trim()
  if (visionBaseUrl !== undefined) {
    if (visionBaseUrl) {
      const url = new URL(String(visionBaseUrl))
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('vision endpoint must be HTTP(S) without embedded credentials')
    }
    env.MEMU_VISION_BASE_URL = String(visionBaseUrl).trim()
  }
  if (visionApiKey !== undefined && String(visionApiKey).trim()) env.MEMU_VISION_API_KEY = String(visionApiKey).trim()
  if (clearVisionKey === true) delete env.MEMU_VISION_API_KEY
  writeMemuEnv(env)
  return getMemuConfig()
  })
}

export async function testMemuConfig() {
  const db = path.join(dataDir(), 'tmp', `embed-test-${process.pid}-${Date.now()}.sqlite3`)
  ensureDir(path.dirname(db))
  try {
    await commit({
      payload: {
        recall_files: [{
          name: 'embedding-test',
          track: 'memory',
          description: 'embedding test',
          content: 'dsh-memu-memory embedding test',
        }],
        resource: [],
        user: {},
      },
      db,
      timeoutMs: 90_000,
    })
    const result = await retrieve({ query: 'embedding test', db, timeoutMs: 60_000 })
    const files = Array.isArray(result?.files) ? result.files : []
    return {
      ok: true,
      files: files.length,
      provider: getMemuConfig().provider,
    }
  } finally {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(db + suffix, { force: true }) } catch {}
    }
  }
}
