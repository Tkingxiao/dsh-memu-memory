import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { startEmbeddingWorker } from './local-embedding-worker.js'
import { LocalEmbeddingError } from './local-embedding-protocol.js'

// §14.5: the worker runs in its own child process so a native crash cannot take
// the host down. The port and the random token travel over the process
// environment (never argv, never a shared config file, never a log line), and the
// parent learns the real port from a single ready line on stdout.
export const ENTRY_ENV = Object.freeze({
  modelDir: 'DSH_MEMU_EMBED_MODEL_DIR',
  manifest: 'DSH_MEMU_EMBED_MANIFEST',
  manifestFile: 'DSH_MEMU_EMBED_MANIFEST_FILE',
  runtimeDir: 'DSH_MEMU_EMBED_RUNTIME_DIR',
  token: 'DSH_MEMU_EMBED_TOKEN',
  host: 'DSH_MEMU_EMBED_HOST',
  port: 'DSH_MEMU_EMBED_PORT',
  maxBodyBytes: 'DSH_MEMU_EMBED_MAX_BODY_BYTES',
  maxBatch: 'DSH_MEMU_EMBED_MAX_BATCH',
})

function readManifest(env) {
  const inline = String(env[ENTRY_ENV.manifest] || '').trim()
  if (inline.startsWith('{')) {
    try {
      return JSON.parse(inline)
    } catch (error) {
      throw new LocalEmbeddingError('manifest env is not valid JSON', 'LOCAL_VECTOR_MANIFEST_INVALID', 503, String((error && error.message) || error))
    }
  }
  const file = inline || String(env[ENTRY_ENV.manifestFile] || '').trim()
  if (!file) throw new LocalEmbeddingError('a manifest path or inline manifest is required', 'LOCAL_VECTOR_MANIFEST_INVALID', 503)
  let raw = ''
  try {
    raw = fs.readFileSync(path.resolve(file), 'utf8')
  } catch (error) {
    throw new LocalEmbeddingError('manifest file ' + path.basename(file) + ' could not be read', 'LOCAL_VECTOR_MANIFEST_INVALID', 503, String((error && error.code) || error))
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new LocalEmbeddingError('manifest file ' + path.basename(file) + ' is not valid JSON', 'LOCAL_VECTOR_MANIFEST_INVALID', 503, String((error && error.message) || error))
  }
}

function readInteger(value, label, fallback) {
  const text = String(value || '').trim()
  if (!text) return fallback
  const number = Number(text)
  if (!Number.isInteger(number) || number < 0) {
    throw new LocalEmbeddingError(label + ' must be a non-negative integer', 'LOCAL_VECTOR_BAD_CONFIG', 400)
  }
  return number
}

export function parseEmbeddingEntryConfig(env = process.env) {
  const token = String(env[ENTRY_ENV.token] || '')
  if (!token) throw new LocalEmbeddingError('a worker token is required', 'LOCAL_VECTOR_TOKEN_INVALID', 400)
  const modelDir = String(env[ENTRY_ENV.modelDir] || '').trim()
  if (!modelDir) throw new LocalEmbeddingError('modelDir is required', 'LOCAL_VECTOR_MODEL_DIR_MISSING', 503)
  const runtimeDir = String(env[ENTRY_ENV.runtimeDir] || '').trim()
  return {
    modelDir,
    manifest: readManifest(env),
    runtimeDir: runtimeDir || undefined,
    token,
    host: String(env[ENTRY_ENV.host] || '127.0.0.1').trim() || '127.0.0.1',
    port: readInteger(env[ENTRY_ENV.port], 'port', 0),
    maxBodyBytes: readInteger(env[ENTRY_ENV.maxBodyBytes], 'maxBodyBytes', undefined),
    maxBatch: readInteger(env[ENTRY_ENV.maxBatch], 'maxBatch', undefined),
  }
}

/**
 * Starts the worker and emits exactly one ready line. Kept separate from main()
 * so a test can drive it with a stub worker and never listen on a socket.
 */
export async function runEmbeddingEntry({ env = process.env, stdout = process.stdout, logger = console, startWorker = startEmbeddingWorker } = {}) {
  const config = parseEmbeddingEntryConfig(env)
  const worker = await startWorker({ ...config, logger })
  const ready = {
    type: 'ready',
    baseUrl: worker.baseUrl,
    url: worker.url,
    model: worker.model,
    dimension: worker.dimension,
    pid: process.pid,
  }
  stdout.write(JSON.stringify(ready) + '\n')
  return { worker, ready }
}

function stderrLogger(stderr) {
  const write = (level) => (message) => {
    try { stderr.write('[local-embedding ' + level + '] ' + String(message) + '\n') } catch {}
  }
  return { info: write('info'), warn: write('warn'), error: write('error'), log: write('info') }
}

function isEntryPoint() {
  const invoked = process.argv[1]
  if (!invoked) return false
  try {
    return pathToFileURL(fs.realpathSync(invoked)).href === pathToFileURL(fs.realpathSync(new URL(import.meta.url))).href
  } catch {
    return false
  }
}

async function main() {
  const stdout = process.stdout
  const stderr = process.stderr
  let worker = null
  let stopping = false
  const stop = async (code) => {
    if (stopping) return
    stopping = true
    try { await worker?.close() } catch {}
    process.exit(code)
  }
  const failAndExit = (error) => {
    const code = String((error && error.code) || 'LOCAL_VECTOR_ERROR')
    const message = String((error && error.message) || error || 'embedding worker failed')
    try { stderr.write(JSON.stringify({ type: 'error', code, message }) + '\n') } catch {}
    void stop(1)
  }

  // The parent owns the lifetime: stdin EOF, SIGTERM/SIGINT or an IPC disconnect
  // all mean "release the native session now" (§14.5: no leaked processes).
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { void stop(0) })
  process.on('disconnect', () => { void stop(0) })
  process.on('uncaughtException', failAndExit)
  process.on('unhandledRejection', failAndExit)
  try { process.stdin.on('end', () => { void stop(0) }); process.stdin.on('close', () => { void stop(0) }); process.stdin.resume() } catch {}

  try {
    const result = await runEmbeddingEntry({ stdout, logger: stderrLogger(stderr) })
    worker = result.worker
  } catch (error) {
    failAndExit(error)
  }
}

if (isEntryPoint()) main()
