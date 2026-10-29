// §14 local vector: the wire contract shared by the managed embedding worker,
// its child-process entry and their tests. MemU's OpenAI-compatible SDK posts
// {model, input, encoding_format} and expects object=list with data ordered like
// the input plus a usage block; float arrays and base64 float32 little-endian
// payloads are both real client shapes (probe in §14.3 saw base64), so both are
// implemented here and nothing else invents a private array protocol.
//
// All request/response validation lives in this file on purpose: the worker only
// moves bytes, so a test can pin the contract without opening a socket.

export const EMBEDDINGS_PATH = '/v1/embeddings'
export const HEALTH_PATH = '/health'

// MemU commits in batches of 64 by default; the body cap still leaves room for
// 64 long strings while refusing a whole document in one shot.
export const DEFAULT_MAX_BODY_BYTES = 1_048_576
export const DEFAULT_MAX_BATCH = 64
export const MAX_VECTOR_DIMENSION = 8192
export const MAX_INPUT_CHARS = 65_536
export const ENCODINGS = Object.freeze(['float', 'base64'])

export class LocalEmbeddingError extends Error {
  constructor(message, code = 'LOCAL_VECTOR_ERROR', status = 500, detail = null) {
    super(message)
    this.name = 'LocalEmbeddingError'
    this.code = code
    this.status = status
    if (detail !== null && detail !== undefined) this.detail = detail
  }
}

export function errorStatus(error) {
  const status = Number(error && error.status)
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500
}

// Mirrors the OpenAI error envelope the SDKs already understand, without echoing
// the request body (an error response must never replay a secret or raw text).
export function errorBody(error) {
  const status = errorStatus(error)
  return {
    error: {
      message: String((error && error.message) || 'local embedding request failed'),
      type: status >= 500 ? 'server_error' : 'invalid_request_error',
      code: String((error && error.code) || 'LOCAL_VECTOR_ERROR'),
    },
  }
}

function badRequest(message, code) {
  return new LocalEmbeddingError(message, code, 400)
}

function plainNumbers(value) {
  if (Array.isArray(value)) return value
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return Array.from(value)
  return null
}

export function encodeVectorBase64(vector) {
  const numbers = plainNumbers(vector)
  if (!numbers) throw new LocalEmbeddingError('cannot encode a non-numeric vector', 'LOCAL_VECTOR_INVALID_VECTOR', 500)
  const buffer = Buffer.allocUnsafe(numbers.length * 4)
  for (let index = 0; index < numbers.length; index++) buffer.writeFloatLE(Number(numbers[index]), index * 4)
  return buffer.toString('base64')
}

export function decodeVectorBase64(text, dimension = 0) {
  const buffer = Buffer.from(String(text || ''), 'base64')
  if (buffer.length === 0 || buffer.length % 4 !== 0) {
    throw new LocalEmbeddingError('base64 payload is not a whole float32 array', 'LOCAL_VECTOR_INVALID_VECTOR', 500)
  }
  const out = new Array(buffer.length / 4)
  for (let index = 0; index < out.length; index++) out[index] = buffer.readFloatLE(index * 4)
  if (Number.isInteger(dimension) && dimension > 0 && out.length !== dimension) {
    throw new LocalEmbeddingError('base64 payload decoded to ' + out.length + ' values, expected ' + dimension, 'LOCAL_VECTOR_DIMENSION_MISMATCH', 500)
  }
  return out
}

// One vector from the model, checked the way §14.6 demands: finite values,
// exactly the manifest dimension, and not the all-zero vector a broken session
// returns when its inputs never reach the graph.
export function assertVector(vector, dimension, index = 0) {
  const label = index >= 0 ? 'embedding ' + index : 'embedding'
  const numbers = plainNumbers(vector)
  if (!numbers) throw new LocalEmbeddingError(label + ' is not a numeric array', 'LOCAL_VECTOR_INVALID_VECTOR', 500)
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new LocalEmbeddingError('the manifest declares no usable embedding dimension', 'LOCAL_VECTOR_MANIFEST_INCOMPLETE', 503)
  }
  if (numbers.length !== dimension) {
    throw new LocalEmbeddingError(label + ' has ' + numbers.length + ' values, expected ' + dimension, 'LOCAL_VECTOR_DIMENSION_MISMATCH', 500)
  }
  let squared = 0
  for (let position = 0; position < numbers.length; position++) {
    const value = numbers[position]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new LocalEmbeddingError(label + ' contains a non-finite value at ' + position, 'LOCAL_VECTOR_INVALID_VECTOR', 500)
    }
    squared += value * value
  }
  if (!(squared > 0)) throw new LocalEmbeddingError(label + ' is all zeros', 'LOCAL_VECTOR_ZERO_VECTOR', 500)
  return numbers
}

function normalizeInputText(value, index, maxChars) {
  if (typeof value !== 'string') {
    throw badRequest('input[' + index + '] must be a string; token-id arrays are not accepted', 'LOCAL_VECTOR_BAD_REQUEST')
  }
  if (!value.trim()) throw badRequest('input[' + index + '] is empty', 'LOCAL_VECTOR_BAD_REQUEST')
  if (value.length > maxChars) {
    throw badRequest('input[' + index + '] is longer than ' + maxChars + ' characters', 'LOCAL_VECTOR_INPUT_TOO_LONG')
  }
  return value
}

// Accepts exactly what the SDK sends: one string or an array of strings. Anything
// else (token ids, nested arrays, non-string items) is a client bug, not something
// to coerce, because a silent coercion would embed the wrong text.
export function parseEmbeddingRequest(body, { model, maxBatch = DEFAULT_MAX_BATCH, maxChars = MAX_INPUT_CHARS } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('request body must be a JSON object', 'LOCAL_VECTOR_BAD_REQUEST')
  }
  const expected = String(model || '')
  const requested = body.model
  if (typeof requested !== 'string' || !requested.trim()) {
    throw badRequest('model is required', 'LOCAL_VECTOR_BAD_REQUEST')
  }
  if (!expected || requested !== expected) {
    throw badRequest('unknown model; this worker serves ' + (expected || '(none)'), 'LOCAL_VECTOR_MODEL_MISMATCH')
  }
  const encoding = body.encoding_format === undefined || body.encoding_format === null ? 'float' : body.encoding_format
  if (typeof encoding !== 'string' || !ENCODINGS.includes(encoding)) {
    throw badRequest('encoding_format must be one of ' + ENCODINGS.join(', '), 'LOCAL_VECTOR_BAD_ENCODING')
  }
  const raw = body.input
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : null
  if (!list) throw badRequest('input must be a string or an array of strings', 'LOCAL_VECTOR_BAD_REQUEST')
  if (list.length === 0) throw badRequest('input must not be empty', 'LOCAL_VECTOR_BAD_REQUEST')
  const batchLimit = Number.isInteger(maxBatch) && maxBatch > 0 ? maxBatch : DEFAULT_MAX_BATCH
  if (list.length > batchLimit) {
    throw badRequest('batch of ' + list.length + ' exceeds the limit of ' + batchLimit, 'LOCAL_VECTOR_BATCH_TOO_LARGE')
  }
  const inputs = list.map((value, index) => normalizeInputText(value, index, maxChars))
  return { inputs, encoding }
}

// Token counts are only used for the usage block; the worker never claims a real
// tokenizer count when the adapter cannot supply one.
export function estimateUsage(inputs) {
  let count = 0
  for (const input of inputs) count += Math.max(1, Math.ceil(String(input).length / 4))
  return { prompt_tokens: count, total_tokens: count }
}

export function buildEmbeddingResponse({ model, vectors, encoding = 'float', usage = null }) {
  const list = Array.isArray(vectors) ? vectors : []
  const data = list.map((vector, index) => ({
    object: 'embedding',
    index,
    embedding: encoding === 'base64' ? encodeVectorBase64(vector) : Array.from(vector, Number),
  }))
  const tokens = usage && typeof usage === 'object' ? usage : estimateUsage(new Array(list.length).fill(''))
  return {
    object: 'list',
    data,
    model,
    usage: {
      prompt_tokens: Number.isFinite(tokens.prompt_tokens) ? tokens.prompt_tokens : 0,
      total_tokens: Number.isFinite(tokens.total_tokens) ? tokens.total_tokens : 0,
    },
  }
}
