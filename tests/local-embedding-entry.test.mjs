import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ENTRY_ENV, parseEmbeddingEntryConfig, runEmbeddingEntry } from '../lib/local-embedding-entry.js'

const ENTRY = fileURLToPath(new URL('../lib/local-embedding-entry.js', import.meta.url))
const TOKEN = 'entry-worker-token-0123456789abcdef'
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-entry-'))
test.after(() => fs.rmSync(workDir, { recursive: true, force: true }))

const manifest = { id: 'bge-small-zh-v1.5', revision: 'r1', protocol: 'mean-l2-512', verified: true, dimension: 512 }
const manifestFile = path.join(workDir, 'manifest.json')
fs.writeFileSync(manifestFile, JSON.stringify(manifest))

const env = (overrides = {}) => ({
  [ENTRY_ENV.modelDir]: workDir,
  [ENTRY_ENV.manifest]: manifestFile,
  [ENTRY_ENV.token]: TOKEN,
  ...overrides,
})

const runChild = (extraEnv) => new Promise((resolve) => {
  execFile(process.execPath, [ENTRY], { env: { ...process.env, ...extraEnv }, timeout: 30_000 }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr })
  })
})

test('entry config is read from the process environment, never from argv', () => {
  const config = parseEmbeddingEntryConfig(env())
  assert.equal(config.modelDir, workDir)
  assert.deepEqual(config.manifest, manifest)
  assert.equal(config.token, TOKEN)
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 0)

  assert.deepEqual(parseEmbeddingEntryConfig(env({ [ENTRY_ENV.manifest]: JSON.stringify(manifest) })).manifest, manifest)
  assert.equal(parseEmbeddingEntryConfig(env({ [ENTRY_ENV.port]: '45999', [ENTRY_ENV.maxBatch]: '8' })).port, 45999)
  assert.throws(() => parseEmbeddingEntryConfig(env({ [ENTRY_ENV.token]: '' })), (error) => error.code === 'LOCAL_VECTOR_TOKEN_INVALID')
  assert.throws(() => parseEmbeddingEntryConfig(env({ [ENTRY_ENV.modelDir]: '' })), (error) => error.code === 'LOCAL_VECTOR_MODEL_DIR_MISSING')
  assert.throws(() => parseEmbeddingEntryConfig(env({ [ENTRY_ENV.manifest]: path.join(workDir, 'missing.json') })), (error) => error.code === 'LOCAL_VECTOR_MANIFEST_INVALID')
  assert.throws(() => parseEmbeddingEntryConfig(env({ [ENTRY_ENV.manifest]: '{ broken' })), (error) => error.code === 'LOCAL_VECTOR_MANIFEST_INVALID')
  assert.throws(() => parseEmbeddingEntryConfig(env({ [ENTRY_ENV.port]: 'abc' })), (error) => error.code === 'LOCAL_VECTOR_BAD_CONFIG')
})

test('a ready line carries the port and model but never the token', async () => {
  const seen = []
  const stdout = { write: (chunk) => { seen.push(String(chunk)) } }
  const result = await runEmbeddingEntry({
    env: env(),
    stdout,
    startWorker: async (options) => {
      seen.push('options:' + JSON.stringify(Object.keys(options).sort()))
      return { baseUrl: 'http://127.0.0.1:41000/v1', url: 'http://127.0.0.1:41000/v1/embeddings', model: 'bge-small-zh-v1.5@r1+mean-l2-512', dimension: 512, close: async () => {}, lastError: null }
    },
  })
  const readyLine = seen.filter((line) => line.trim().startsWith('{')).join('').trim()
  const ready = JSON.parse(readyLine)
  assert.equal(ready.type, 'ready')
  assert.equal(ready.baseUrl, 'http://127.0.0.1:41000/v1')
  assert.equal(ready.url, 'http://127.0.0.1:41000/v1/embeddings')
  assert.equal(ready.model, 'bge-small-zh-v1.5@r1+mean-l2-512')
  assert.equal(ready.dimension, 512)
  assert.ok(!readyLine.includes(TOKEN))
  assert.equal(result.ready.type, 'ready')
  assert.ok(seen.some((line) => line.startsWith('options:') && line.includes('token')))
})

test('the entry refuses a missing model directory before it opens a port', async () => {
  const child = await runChild({ ...env(), [ENTRY_ENV.modelDir]: '' })
  assert.equal(child.code, 1)
  assert.equal(child.stdout.trim(), '')
  const error = JSON.parse(child.stderr.trim().split('\n').filter((line) => line.trim().startsWith('{')).pop())
  assert.equal(error.type, 'error')
  assert.equal(error.code, 'LOCAL_VECTOR_MODEL_DIR_MISSING')
  assert.ok(!child.stderr.includes(TOKEN))
})

test('the entry refuses a pending manifest and a missing runtime without downloading anything', async () => {
  const pendingFile = path.join(workDir, 'pending.json')
  fs.writeFileSync(pendingFile, JSON.stringify({ ...manifest, verified: false, status: 'pending' }))
  const pending = await runChild({ ...env(), [ENTRY_ENV.manifest]: pendingFile })
  assert.equal(pending.code, 1)
  assert.equal(JSON.parse(pending.stderr.trim().split('\n').filter((line) => line.trim().startsWith('{')).pop()).code, 'LOCAL_VECTOR_MANIFEST_UNVERIFIED')

  fs.writeFileSync(path.join(workDir, 'model.onnx'), 'not a graph')
  const runtime = await runChild(env())
  assert.equal(runtime.code, 1)
  assert.equal(runtime.stdout.trim(), '')
  const error = JSON.parse(runtime.stderr.trim().split('\n').filter((line) => line.trim().startsWith('{')).pop())
  assert.ok(['LOCAL_VECTOR_RUNTIME_UNAVAILABLE', 'LOCAL_VECTOR_MODEL_FILE_MISSING', 'LOCAL_VECTOR_SMOKE_FAILED'].includes(error.code))
})
