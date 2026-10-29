import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  createOnnxAdapter,
  manifestDimension,
  manifestModelId,
  resolveInsideModelDir,
  startEmbeddingWorker,
} from '../lib/local-embedding-worker.js'
import { decodeVectorBase64 } from '../lib/local-embedding-protocol.js'

const TOKEN = 'test-worker-token-0123456789abcdef'
const DIMENSION = 8
const MODEL = 'bge-small-zh-v1.5@r1+mean-l2-512'

const manifest = (overrides = {}) => ({
  id: 'bge-small-zh-v1.5',
  revision: 'r1',
  protocol: 'mean-l2-512',
  verified: true,
  dimension: DIMENSION,
  graph: 'model.onnx',
  tokenizer: { file: 'tokenizer.json' },
  ...overrides,
})

const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-embed-'))
test.after(() => fs.rmSync(modelDir, { recursive: true, force: true }))

const vectorFor = (text, dimension = DIMENSION) => {
  const seed = [...String(text)].reduce((total, character) => total + character.codePointAt(0), 0)
  return Array.from({ length: dimension }, (_unused, index) => Math.sin(seed * 0.37 + index) + 0.25)
}

function fakeAdapter({ vectors = null, usage = null } = {}) {
  const calls = []
  return {
    calls,
    encode: async (inputs) => {
      calls.push([...inputs])
      const produced = vectors ? vectors(inputs) : inputs.map((text) => vectorFor(text))
      return usage ? { vectors: produced, usage } : produced
    },
  }
}

const silence = () => {
  const lines = []
  const record = (level) => (message) => { lines.push(level + ' ' + String(message)) }
  return { lines, logger: { info: record('info'), warn: record('warn'), error: record('error'), log: record('info') } }
}

async function fixture({ adapter = fakeAdapter(), logger = silence().logger, ...overrides } = {}) {
  const worker = await startEmbeddingWorker({
    modelDir,
    manifest: manifest(),
    runtimeDir: modelDir,
    token: TOKEN,
    adapter,
    logger,
    ...overrides,
  })
  return { worker, adapter }
}

const auth = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }

const post = (worker, body, headers = auth) => fetch(worker.url, {
  method: 'POST',
  headers,
  body: JSON.stringify(body),
}).then(async (response) => ({ status: response.status, headers: response.headers, body: await response.json() }))

const rawCall = (baseUrl, { path: route = '/v1/embeddings', method = 'POST', headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
  const url = new URL(route, baseUrl)
  const request = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method, headers }, (response) => {
    let text = ''
    response.setEncoding('utf8')
    response.on('data', (chunk) => { text += chunk })
    response.on('end', () => {
      let json = null
      try { json = JSON.parse(text) } catch {}
      resolve({ status: response.statusCode, headers: response.headers, body: text, json })
    })
  })
  request.on('error', reject)
  if (body !== null) request.write(body)
  request.end()
})

test('a verified manifest is required; pending, unverified and missing directories are refused', async () => {
  const base = { modelDir, manifest: manifest(), runtimeDir: modelDir, token: TOKEN, adapter: fakeAdapter(), logger: silence().logger }
  await assert.rejects(startEmbeddingWorker({ ...base, manifest: manifest({ status: 'pending', verified: false }) }), (error) => error.code === 'LOCAL_VECTOR_MANIFEST_UNVERIFIED')
  await assert.rejects(startEmbeddingWorker({ ...base, manifest: manifest({ verified: false, status: 'available' }) }), (error) => error.code === 'LOCAL_VECTOR_MANIFEST_UNVERIFIED')
  await assert.rejects(startEmbeddingWorker({ ...base, manifest: manifest({ verified: false }) }), (error) => error.code === 'LOCAL_VECTOR_MANIFEST_UNVERIFIED')
  await assert.rejects(startEmbeddingWorker({ ...base, modelDir: '' }), (error) => error.code === 'LOCAL_VECTOR_MODEL_DIR_MISSING')
  await assert.rejects(startEmbeddingWorker({ ...base, modelDir: path.join(modelDir, 'nope') }), (error) => error.code === 'LOCAL_VECTOR_MODEL_DIR_MISSING')
  await assert.rejects(startEmbeddingWorker({ ...base, manifest: manifest({ dimension: undefined }) }), (error) => error.code === 'LOCAL_VECTOR_MANIFEST_INCOMPLETE')
  await assert.rejects(startEmbeddingWorker({ ...base, token: 'short' }), (error) => error.code === 'LOCAL_VECTOR_TOKEN_INVALID')
  await assert.rejects(startEmbeddingWorker({ ...base, host: '0.0.0.0' }), (error) => error.code === 'LOCAL_VECTOR_BAD_HOST')
  const statusVerified = await startEmbeddingWorker({ ...base, manifest: manifest({ verified: false, status: 'verified' }) })
  assert.equal(statusVerified.dimension, DIMENSION)
  await statusVerified.close()
})

test('the manifest fixes the model id and dimension exposed to MemU', async () => {
  assert.equal(manifestModelId(manifest()), MODEL)
  assert.equal(manifestModelId({ id: 'm', revision: 'r' }), 'm@r')
  assert.equal(manifestModelId({ model: 'explicit-model' }), 'explicit-model')
  assert.equal(manifestModelId({}), '')
  assert.equal(manifestDimension({ expectedDimension: 512 }), 512)
  assert.equal(manifestDimension({ output: { dimension: 384 } }), 384)
  assert.equal(manifestDimension({}), 0)
})

test('the worker binds loopback only and reports the base URL MemU needs', async () => {
  const { worker, adapter } = await fixture()
  try {
    assert.match(worker.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    assert.equal(worker.url, worker.baseUrl + '/embeddings')
    assert.equal(worker.model, MODEL)
    assert.equal(worker.dimension, DIMENSION)
    assert.equal(worker.lastError, null)
    // ready means one smoke encode already produced a finite vector
    assert.deepEqual(adapter.calls.length, 1)
    assert.equal(adapter.calls[0].length, 1)
  } finally {
    await worker.close()
  }
})

test('POST /v1/embeddings serves float and base64 vectors in input order', async () => {
  const { worker } = await fixture()
  try {
    const single = await post(worker, { model: MODEL, input: '一个人在海边散步' })
    assert.equal(single.status, 200)
    assert.equal(single.body.object, 'list')
    assert.equal(single.body.model, MODEL)
    assert.equal(single.body.data.length, 1)
    assert.equal(single.body.data[0].index, 0)
    assert.deepEqual(single.body.data[0].embedding.map((value) => Math.round(value * 1e6) / 1e6), vectorFor('一个人在海边散步').map((value) => Math.round(value * 1e6) / 1e6))
    assert.ok(Number.isFinite(single.body.usage.prompt_tokens))

    const texts = ['alpha', 'beta', 'gamma']
    const batch = await post(worker, { model: MODEL, input: texts })
    assert.deepEqual(batch.body.data.map((entry) => entry.index), [0, 1, 2])
    assert.deepEqual(batch.body.data[1].embedding.map((value) => Math.round(value * 1e6) / 1e6), vectorFor('beta').map((value) => Math.round(value * 1e6) / 1e6))

    const encoded = await post(worker, { model: MODEL, input: texts, encoding_format: 'base64' })
    assert.equal(encoded.status, 200)
    assert.equal(typeof encoded.body.data[0].embedding, 'string')
    const decoded = decodeVectorBase64(encoded.body.data[2].embedding, DIMENSION)
    assert.deepEqual(decoded.map((value) => Math.round(value * 1e6) / 1e6), vectorFor('gamma').map((value) => Math.round(value * 1e6) / 1e6))
  } finally {
    await worker.close()
  }
})

test('adapter usage is passed through when the runtime knows token counts', async () => {
  const adapter = fakeAdapter({ usage: { prompt_tokens: 11, total_tokens: 11 } })
  const { worker } = await fixture({ adapter })
  try {
    const response = await post(worker, { model: MODEL, input: 'hello' })
    assert.deepEqual(response.body.usage, { prompt_tokens: 11, total_tokens: 11 })
  } finally {
    await worker.close()
  }
})

test('auth, origin, host, method, content type and JSON failures are all refused', async () => {
  const { worker, adapter } = await fixture()
  try {
    const noToken = await post(worker, { model: MODEL, input: 'x' }, { 'content-type': 'application/json' })
    assert.equal(noToken.status, 401)
    assert.equal(noToken.body.error.code, 'LOCAL_VECTOR_UNAUTHORIZED')
    assert.equal(noToken.headers.get('www-authenticate'), 'Bearer')

    const wrongToken = await post(worker, { model: MODEL, input: 'x' }, { authorization: 'Bearer nope-nope-nope-nope', 'content-type': 'application/json' })
    assert.equal(wrongToken.status, 401)

    const origin = await rawCall(worker.baseUrl, { headers: { ...auth, origin: 'https://evil.example' }, body: JSON.stringify({ model: MODEL, input: 'x' }) })
    assert.equal(origin.status, 403)
    assert.equal(origin.json.error.code, 'LOCAL_VECTOR_CORS_REJECTED')
    assert.equal(origin.headers['access-control-allow-origin'], undefined)

    const host = await rawCall(worker.baseUrl, { headers: { ...auth, host: 'evil.example' }, body: JSON.stringify({ model: MODEL, input: 'x' }) })
    assert.equal(host.status, 403)
    assert.equal(host.json.error.code, 'LOCAL_VECTOR_BAD_HOST')

    const wrongMethod = await rawCall(worker.baseUrl, { method: 'GET', headers: auth })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.headers.allow, 'POST')

    const wrongType = await rawCall(worker.baseUrl, { headers: { ...auth, 'content-type': 'text/plain' }, body: 'hello' })
    assert.equal(wrongType.status, 415)
    assert.equal(wrongType.json.error.code, 'LOCAL_VECTOR_UNSUPPORTED_MEDIA_TYPE')

    const brokenJson = await rawCall(worker.baseUrl, { headers: { ...auth, 'content-length': '7' }, body: 'notjson' })
    assert.equal(brokenJson.status, 400)
    assert.equal(brokenJson.json.error.code, 'LOCAL_VECTOR_BAD_REQUEST')

    const unknownPath = await rawCall(worker.baseUrl, { path: '/v1/models', headers: auth })
    assert.equal(unknownPath.status, 404)
    assert.equal(unknownPath.json.error.code, 'LOCAL_VECTOR_NOT_FOUND')
    // none of the refused requests reached the model
    assert.equal(adapter.calls.length, 1)
  } finally {
    await worker.close()
  }
})

test('an unknown model is refused instead of being served by the loaded weights', async () => {
  const { worker, adapter } = await fixture()
  try {
    const response = await post(worker, { model: 'text-embedding-3-small', input: 'x' })
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'LOCAL_VECTOR_MODEL_MISMATCH')
    assert.equal(adapter.calls.length, 1)
  } finally {
    await worker.close()
  }
})

test('body and batch limits are enforced before inference', async () => {
  const { worker, adapter } = await fixture({ maxBatch: 2, maxBodyBytes: 256 })
  try {
    const tooMany = await post(worker, { model: MODEL, input: ['a', 'b', 'c'] })
    assert.equal(tooMany.status, 400)
    assert.equal(tooMany.body.error.code, 'LOCAL_VECTOR_BATCH_TOO_LARGE')

    const bigBody = await rawCall(worker.baseUrl, { headers: { ...auth, 'content-length': '4096' }, body: '{}' })
    assert.equal(bigBody.status, 413)
    assert.equal(bigBody.json.error.code, 'LOCAL_VECTOR_BODY_TOO_LARGE')
    assert.equal(adapter.calls.length, 1)
  } finally {
    await worker.close()
  }
})

test('broken vectors fail the request and leave a typed lastError behind', async () => {
  const cases = [
    { adapter: fakeAdapter({ vectors: (inputs) => inputs.map(() => new Array(DIMENSION - 1).fill(0.5)) }), code: 'LOCAL_VECTOR_DIMENSION_MISMATCH' },
    { adapter: fakeAdapter({ vectors: (inputs) => inputs.map(() => new Array(DIMENSION).fill(0)) }), code: 'LOCAL_VECTOR_ZERO_VECTOR' },
    { adapter: fakeAdapter({ vectors: (inputs) => inputs.map(() => [Number.NaN, ...new Array(DIMENSION - 1).fill(0.5)]) }), code: 'LOCAL_VECTOR_INVALID_VECTOR' },
    { adapter: fakeAdapter({ vectors: () => [] }), code: 'LOCAL_VECTOR_VECTOR_COUNT_MISMATCH' },
  ]
  for (const item of cases) {
    // the smoke encode uses the same adapter, so a broken adapter is refused at start
    await assert.rejects(fixture({ adapter: item.adapter }), (error) => typeof error.code === 'string' && error.code.startsWith('LOCAL_VECTOR_'))
  }

  const good = fakeAdapter()
  let broken = true
  const flaky = {
    encode: async (inputs) => {
      if (!broken) return good.encode(inputs)
      // first call (smoke) is healthy, every later call returns a wrong dimension
      if (good.calls.length === 0) return good.encode(inputs)
      return inputs.map(() => new Array(DIMENSION - 1).fill(0.5))
    },
  }
  const { worker } = await fixture({ adapter: flaky })
  try {
    const failed = await post(worker, { model: MODEL, input: 'x' })
    assert.equal(failed.status, 500)
    assert.equal(failed.body.error.code, 'LOCAL_VECTOR_DIMENSION_MISMATCH')
    assert.equal(worker.lastError.code, 'LOCAL_VECTOR_DIMENSION_MISMATCH')
    assert.ok(worker.lastError.at)
    broken = false
    const healthy = await post(worker, { model: MODEL, input: 'y' })
    assert.equal(healthy.status, 200)
    assert.equal(worker.lastError, null)
  } finally {
    await worker.close()
  }
})

test('GET /health answers behind the token and never leaks the token or input text into logs', async () => {
  const sink = silence()
  const { worker } = await fixture({ logger: sink.logger })
  try {
    const health = await fetch(worker.healthUrl, { headers: { authorization: 'Bearer ' + TOKEN } })
    assert.equal(health.status, 200)
    const body = await health.json()
    assert.equal(body.status, 'ok')
    assert.equal(body.model, MODEL)
    assert.equal(body.dimension, DIMENSION)
    assert.deepEqual(body.encodings, ['float', 'base64'])
    assert.equal(await (await fetch(worker.healthUrl)).status, 401)

    await post(worker, { model: MODEL, input: '机密用户原文 secret-input-text' })
    await post(worker, { model: 'wrong-model', input: '机密用户原文 secret-input-text' })
    await fetch(worker.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"input":"保密"}' })

    const logged = sink.lines.join('\n')
    assert.ok(!logged.includes(TOKEN))
    assert.ok(!logged.includes('secret-input-text'))
    assert.ok(!logged.includes('机密用户原文'))
    assert.ok(!logged.includes('保密'))
  } finally {
    await worker.close()
  }
})

test('close is idempotent, stops the listener and honours an abort signal', async () => {
  const { worker } = await fixture()
  await worker.close()
  await worker.close()
  await assert.rejects(fetch(worker.url, { method: 'POST', headers: auth, body: '{}' }))

  const controller = new AbortController()
  const aborted = await fixture({ signal: controller.signal })
  const before = await fetch(aborted.worker.healthUrl, { headers: { authorization: 'Bearer ' + TOKEN } })
  assert.equal(before.status, 200)
  controller.abort()
  await new Promise((resolve) => setTimeout(resolve, 100))
  await assert.rejects(fetch(aborted.worker.healthUrl, { headers: { authorization: 'Bearer ' + TOKEN } }))
})

test('model files are resolved inside the model directory and cannot escape it', () => {
  fs.writeFileSync(path.join(modelDir, 'tokenizer.json'), '{}')
  assert.equal(path.basename(resolveInsideModelDir(modelDir, 'tokenizer.json')), 'tokenizer.json')
  assert.throws(() => resolveInsideModelDir(modelDir, '../escape.json'), (error) => error.code === 'LOCAL_VECTOR_MANIFEST_INCOMPLETE')
  assert.throws(() => resolveInsideModelDir(modelDir, 'C:/Windows/win.ini'), (error) => error.code === 'LOCAL_VECTOR_MANIFEST_INCOMPLETE')
  assert.throws(() => resolveInsideModelDir(modelDir, 'missing.onnx'), (error) => error.code === 'LOCAL_VECTOR_MODEL_FILE_MISSING')
})

test('without an injected adapter the pinned runtime is required and never downloaded', async () => {
  await assert.rejects(
    createOnnxAdapter({ modelDir, manifest: manifest(), runtimeDir: modelDir }),
    (error) => error.code === 'LOCAL_VECTOR_RUNTIME_UNAVAILABLE' || error.code === 'LOCAL_VECTOR_MODEL_FILE_MISSING',
  )
  fs.writeFileSync(path.join(modelDir, 'model.onnx'), 'not a graph')
  await assert.rejects(
    createOnnxAdapter({ modelDir, manifest: manifest({ runtime: { module: 'onnxruntime-node-not-installed' } }), runtimeDir: modelDir }),
    (error) => error.code === 'LOCAL_VECTOR_RUNTIME_UNAVAILABLE' && /not installed/.test(error.message),
  )
  await assert.rejects(
    startEmbeddingWorker({ modelDir, manifest: manifest(), runtimeDir: modelDir, token: TOKEN, logger: silence().logger, adapter: null }),
    (error) => error.code === 'LOCAL_VECTOR_RUNTIME_UNAVAILABLE' || error.code === 'LOCAL_VECTOR_MODEL_FILE_MISSING',
  )
})
