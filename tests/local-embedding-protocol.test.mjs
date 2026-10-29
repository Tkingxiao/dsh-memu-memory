import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MAX_BATCH,
  LocalEmbeddingError,
  assertVector,
  buildEmbeddingResponse,
  decodeVectorBase64,
  encodeVectorBase64,
  errorBody,
  errorStatus,
  estimateUsage,
  parseEmbeddingRequest,
} from '../lib/local-embedding-protocol.js'

const MODEL = 'bge-small-zh-v1.5@r1+mean-l2-512'
const rejects = (fn, pattern) => assert.throws(fn, (error) => error instanceof LocalEmbeddingError && pattern.test(error.code))

test('base64 payloads are raw little-endian float32, not a private array format', () => {
  const vector = [0.5, -1.25, 0, 3]
  const encoded = encodeVectorBase64(vector)
  const expected = Buffer.alloc(vector.length * 4)
  vector.forEach((value, index) => expected.writeFloatLE(value, index * 4))
  assert.equal(encoded, expected.toString('base64'))
  assert.deepEqual(decodeVectorBase64(encoded, 4), vector)
  assert.deepEqual(Array.from(decodeVectorBase64(encoded)), Array.from(new Float32Array(vector)))
})

test('decoding a base64 payload of the wrong length reports a dimension mismatch', () => {
  const encoded = encodeVectorBase64([1, 2, 3])
  rejects(() => decodeVectorBase64(encoded, 4), /^LOCAL_VECTOR_DIMENSION_MISMATCH$/)
  assert.throws(() => decodeVectorBase64('***'), (error) => error.code === 'LOCAL_VECTOR_INVALID_VECTOR')
})

test('vectors must be finite, non-zero and exactly the manifest dimension', () => {
  assert.deepEqual(assertVector([1, 2, 3], 3), [1, 2, 3])
  assert.deepEqual(assertVector(new Float32Array([1, 2, 3]), 3), [1, 2, 3])
  rejects(() => assertVector([1, 2], 3), /^LOCAL_VECTOR_DIMENSION_MISMATCH$/)
  rejects(() => assertVector([0, 0, 0], 3), /^LOCAL_VECTOR_ZERO_VECTOR$/)
  rejects(() => assertVector([1, Number.NaN, 3], 3), /^LOCAL_VECTOR_INVALID_VECTOR$/)
  rejects(() => assertVector([1, Number.POSITIVE_INFINITY, 3], 3), /^LOCAL_VECTOR_INVALID_VECTOR$/)
  rejects(() => assertVector('1,2,3', 3), /^LOCAL_VECTOR_INVALID_VECTOR$/)
  rejects(() => assertVector([1, 2, 3], 0), /^LOCAL_VECTOR_MANIFEST_INCOMPLETE$/)
})

test('the request parser accepts exactly the SDK shapes and refuses the rest', () => {
  assert.deepEqual(parseEmbeddingRequest({ model: MODEL, input: 'hello' }, { model: MODEL }), { inputs: ['hello'], encoding: 'float' })
  assert.deepEqual(parseEmbeddingRequest({ model: MODEL, input: ['a', 'b'], encoding_format: 'base64' }, { model: MODEL }), { inputs: ['a', 'b'], encoding: 'base64' })
  rejects(() => parseEmbeddingRequest(null, { model: MODEL }), /^LOCAL_VECTOR_BAD_REQUEST$/)
  rejects(() => parseEmbeddingRequest([], { model: MODEL }), /^LOCAL_VECTOR_BAD_REQUEST$/)
  rejects(() => parseEmbeddingRequest({ input: 'hello' }, { model: MODEL }), /^LOCAL_VECTOR_BAD_REQUEST$/)
  rejects(() => parseEmbeddingRequest({ model: MODEL, input: [] }, { model: MODEL }), /^LOCAL_VECTOR_BAD_REQUEST$/)
  rejects(() => parseEmbeddingRequest({ model: MODEL, input: '   ' }, { model: MODEL }), /^LOCAL_VECTOR_BAD_REQUEST$/)
  rejects(() => parseEmbeddingRequest({ model: MODEL, input: [1, 2] }, { model: MODEL }), /^LOCAL_VECTOR_BAD_REQUEST$/)
  rejects(() => parseEmbeddingRequest({ model: MODEL, input: [[1, 2, 3]] }, { model: MODEL }), /^LOCAL_VECTOR_BAD_REQUEST$/)
  rejects(() => parseEmbeddingRequest({ model: MODEL, input: { text: 'x' } }, { model: MODEL }), /^LOCAL_VECTOR_BAD_REQUEST$/)
  rejects(() => parseEmbeddingRequest({ model: 'other-model', input: 'hello' }, { model: MODEL }), /^LOCAL_VECTOR_MODEL_MISMATCH$/)
  rejects(() => parseEmbeddingRequest({ model: MODEL, input: 'hello', encoding_format: 'binary' }, { model: MODEL }), /^LOCAL_VECTOR_BAD_ENCODING$/)
  rejects(() => parseEmbeddingRequest({ model: MODEL, input: 'x'.repeat(65_537) }, { model: MODEL }), /^LOCAL_VECTOR_INPUT_TOO_LONG$/)
})

test('the batch cap is enforced before any inference happens', () => {
  const many = new Array(DEFAULT_MAX_BATCH + 1).fill('x')
  rejects(() => parseEmbeddingRequest({ model: MODEL, input: many }, { model: MODEL }), /^LOCAL_VECTOR_BATCH_TOO_LARGE$/)
  rejects(() => parseEmbeddingRequest({ model: MODEL, input: ['a', 'b', 'c'] }, { model: MODEL, maxBatch: 2 }), /^LOCAL_VECTOR_BATCH_TOO_LARGE$/)
  assert.equal(parseEmbeddingRequest({ model: MODEL, input: ['a', 'b'] }, { model: MODEL, maxBatch: 2 }).inputs.length, 2)
})

test('responses keep input order, carry the model and honour the encoding', () => {
  const vectors = [[1, 2, 3], [4, 5, 6]]
  const floatBody = buildEmbeddingResponse({ model: MODEL, vectors, encoding: 'float' })
  assert.equal(floatBody.object, 'list')
  assert.equal(floatBody.model, MODEL)
  assert.deepEqual(floatBody.data.map((entry) => entry.index), [0, 1])
  assert.equal(floatBody.data[0].object, 'embedding')
  assert.deepEqual(floatBody.data[1].embedding, [4, 5, 6])
  assert.ok(Number.isFinite(floatBody.usage.prompt_tokens))

  const base64Body = buildEmbeddingResponse({ model: MODEL, vectors, encoding: 'base64' })
  assert.equal(typeof base64Body.data[0].embedding, 'string')
  assert.deepEqual(decodeVectorBase64(base64Body.data[0].embedding, 3), [1, 2, 3])

  const withUsage = buildEmbeddingResponse({ model: MODEL, vectors, encoding: 'float', usage: { prompt_tokens: 7, total_tokens: 7 } })
  assert.deepEqual(withUsage.usage, { prompt_tokens: 7, total_tokens: 7 })
  assert.deepEqual(estimateUsage(['abcd', 'abcdefgh']), { prompt_tokens: 3, total_tokens: 3 })
})

test('error envelopes expose a code without echoing the request body', () => {
  const body = errorBody(new LocalEmbeddingError('unknown model; this worker serves m', 'LOCAL_VECTOR_MODEL_MISMATCH', 400))
  assert.equal(body.error.type, 'invalid_request_error')
  assert.equal(body.error.code, 'LOCAL_VECTOR_MODEL_MISMATCH')
  assert.equal(errorStatus(new LocalEmbeddingError('x', 'X', 503)), 503)
  assert.equal(errorStatus(new Error('plain')), 500)
  assert.equal(errorBody(new LocalEmbeddingError('boom', 'LOCAL_VECTOR_INFERENCE_FAILED', 500)).error.type, 'server_error')
})
