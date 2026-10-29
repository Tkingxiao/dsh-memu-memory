import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import {
  EMBEDDINGS_PATH,
  HEALTH_PATH,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_BATCH,
  ENCODINGS,
  MAX_VECTOR_DIMENSION,
  LocalEmbeddingError,
  assertVector,
  buildEmbeddingResponse,
  errorBody,
  errorStatus,
  parseEmbeddingRequest,
} from './local-embedding-protocol.js'

// §14.5: loopback only, port 0, random high-entropy token from the parent. Nothing
// here ever reaches the network, downloads a model, or logs a token or input text.
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1', 'localhost'])
export const MIN_TOKEN_LENGTH = 16
const SMOKE_TEXT = 'embedding readiness probe'

function asError(message, code, status, detail = null) {
  return new LocalEmbeddingError(message, code, status, detail)
}

function isLoopbackHostname(hostname) {
  const text = String(hostname || '').toLowerCase()
  return LOOPBACK_HOSTS.includes(text)
}

// The model id is what MemU passes as MEMU_EMBED_MODEL: the stable catalog id plus
// the pinned revision and processing protocol, so a different weight/quota/pooling
// build can never silently answer for the old one (§14.8: same dimension but a
// different space is still a different space).
export function manifestModelId(manifest) {
  if (!manifest || typeof manifest !== 'object') return ''
  if (typeof manifest.model === 'string' && manifest.model.trim()) return manifest.model.trim()
  const id = typeof manifest.id === 'string' ? manifest.id.trim() : ''
  if (!id) return ''
  const revision = typeof manifest.revision === 'string' ? manifest.revision.trim() : ''
  const protocol = typeof manifest.protocol === 'string' ? manifest.protocol.trim() : ''
  const suffix = [revision, protocol].filter(Boolean).join('+')
  return suffix ? id + '@' + suffix : id
}

export function manifestDimension(manifest) {
  const candidates = [
    manifest && manifest.dimension,
    manifest && manifest.expectedDimension,
    manifest && manifest.output && manifest.output.dimension,
    manifest && manifest.embedding && manifest.embedding.dimension,
  ]
  for (const value of candidates) {
    const number = Number(value)
    if (Number.isInteger(number) && number > 0) {
      if (number > MAX_VECTOR_DIMENSION) throw asError('manifest dimension ' + number + ' exceeds the protocol limit', 'LOCAL_VECTOR_MANIFEST_INCOMPLETE', 503)
      return number
    }
  }
  return 0
}

// A model is servable only when the installer marked it verified. pending /
// candidate / downloading entries exist in the catalog, but a half-installed
// artifact must never answer a request, and nothing here starts a download to
// fix that (§14.4).
export function assertServableManifest({ manifest, modelDir } = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw asError('a model manifest is required to start the embedding worker', 'LOCAL_VECTOR_MANIFEST_INVALID', 503)
  }
  const state = String(manifest.status || manifest.state || manifest.verification?.status || '').toLowerCase()
  if (manifest.pending === true || state === 'pending' || state === 'candidate' || state === 'downloading') {
    throw asError('model ' + (manifestModelId(manifest) || '(unnamed)') + ' is ' + (state || 'pending') + ', not verified; finish the managed download first', 'LOCAL_VECTOR_MANIFEST_UNVERIFIED', 503)
  }
  if (manifest.verified !== true && state !== 'verified') {
    throw asError('model ' + (manifestModelId(manifest) || '(unnamed)') + ' is not verified; refusing to serve it', 'LOCAL_VECTOR_MANIFEST_UNVERIFIED', 503)
  }
  const dir = typeof modelDir === 'string' ? modelDir.trim() : ''
  if (!dir) throw asError('modelDir is required', 'LOCAL_VECTOR_MODEL_DIR_MISSING', 503)
  let stat = null
  try { stat = fs.statSync(dir) } catch { stat = null }
  if (!stat || !stat.isDirectory()) throw asError('modelDir ' + dir + ' is missing; installed model files are required', 'LOCAL_VECTOR_MODEL_DIR_MISSING', 503)
  const model = manifestModelId(manifest)
  if (!model) throw asError('manifest is missing a stable id', 'LOCAL_VECTOR_MANIFEST_INCOMPLETE', 503)
  const dimension = manifestDimension(manifest)
  if (!dimension) throw asError('manifest is missing expected dimension', 'LOCAL_VECTOR_MANIFEST_INCOMPLETE', 503)
  return { model, dimension, modelDir: path.resolve(dir) }
}

// External-data graphs, tokenizer files and the model directory itself are all
// attacker-adjacent input: absolute paths, .. segments, symlinks or junctions that
// resolve outside the model directory are refused before anything is opened.
export function resolveInsideModelDir(modelDir, relPath) {
  const dir = typeof modelDir === 'string' ? modelDir.trim() : ''
  if (!dir) throw asError('modelDir is required', 'LOCAL_VECTOR_MODEL_DIR_MISSING', 503)
  let root = null
  try { root = fs.realpathSync(path.resolve(dir)) } catch { root = null }
  if (!root) throw asError('modelDir ' + dir + ' is missing', 'LOCAL_VECTOR_MODEL_DIR_MISSING', 503)
  const rel = typeof relPath === 'string' ? relPath.trim() : ''
  if (!rel) throw asError('manifest names no model file', 'LOCAL_VECTOR_MANIFEST_INCOMPLETE', 503)
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    throw asError('model file ' + rel + ' must be relative to the model directory', 'LOCAL_VECTOR_MANIFEST_INCOMPLETE', 503)
  }
  const segments = rel.split(/[\\/]+/)
  if (segments.some((segment) => segment === '..')) {
    throw asError('model file ' + rel + ' escapes the model directory', 'LOCAL_VECTOR_MANIFEST_INCOMPLETE', 503)
  }
  const target = path.resolve(root, rel)
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw asError('model file ' + rel + ' escapes the model directory', 'LOCAL_VECTOR_MANIFEST_INCOMPLETE', 503)
  }
  let real = null
  try { real = fs.realpathSync(target) } catch { real = null }
  if (!real) throw asError('model file ' + rel + ' is missing', 'LOCAL_VECTOR_MODEL_FILE_MISSING', 503)
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw asError('model file ' + rel + ' resolves outside the model directory', 'LOCAL_VECTOR_MANIFEST_INCOMPLETE', 503)
  }
  return real
}

function runtimeUnavailable(kind, specifier, runtimeDir, error) {
  const where = runtimeDir ? ' in ' + runtimeDir : ''
  const reason = String((error && (error.code || error.message)) || error || 'not found')
  return asError(
    kind + ' module "' + specifier + '" is not installed' + where + ' (' + reason + '); install the pinned artifact instead of downloading at runtime',
    'LOCAL_VECTOR_RUNTIME_UNAVAILABLE',
    503,
    { module: specifier, kind },
  )
}

// Resolve only from the explicitly installed managed runtime. Runtime imports never
// consult the host application's node_modules and never trigger an install.
async function importFrom(specifier, runtimeDir) {
  const value = String(specifier || '').trim()
  if (!value) throw new Error('module specifier is empty')
  if (path.isAbsolute(value) || value.startsWith('file:')) return import(value)
  if (!runtimeDir || !String(runtimeDir).trim()) {
    const error = new Error('managed runtimeDir is required for module ' + value)
    error.code = 'ERR_MODULE_NOT_FOUND'
    throw error
  }
  const requireFrom = createRequire(path.join(path.resolve(String(runtimeDir).trim()), 'entry.cjs'))
  const resolved = requireFrom.resolve(value)
  return import(pathToFileURL(resolved).href)
}

function manifestFilePath(manifest, role, fallback) {
  const files = Array.isArray(manifest?.files) ? manifest.files : []
  const match = files.find(file => file && file.role === role)
  const declared = role === 'graph' ? manifest?.graph?.path : (manifest?.tokenizer?.file || manifest?.tokenizer?.path)
  return declared || match?.path || fallback
}

async function openTokenizer(mod, modelDir, manifest = {}) {
  const tokenizerPath = resolveInsideModelDir(modelDir, manifestFilePath(manifest, 'tokenizer', 'tokenizer.json'))
  const configPath = resolveInsideModelDir(modelDir, manifestFilePath(manifest, 'tokenizer-config', 'tokenizer_config.json'))
  const Tokenizer = mod.Tokenizer || (mod.default && mod.default.Tokenizer)
  if (Tokenizer && typeof Tokenizer.fromFile === 'function') return Tokenizer.fromFile(tokenizerPath)
  if (Tokenizer && typeof Tokenizer === 'function') {
    const tokenizerJson = JSON.parse(fs.readFileSync(tokenizerPath, 'utf8'))
    let config = {}
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch {}
    return new Tokenizer(tokenizerJson, config)
  }
  const fromFile = mod.fromFile || (mod.default && mod.default.fromFile)
  if (typeof fromFile === 'function') return fromFile(tokenizerPath)
  throw new Error('tokenizer module exposes no supported local tokenizer constructor')
}

function padRows(rows, pad, requestedWidth = null) {
  const width = Number.isInteger(requestedWidth) && requestedWidth > 0 ? requestedWidth : rows.reduce((max, row) => Math.max(max, row.length), 0)
  return rows.map((row) => {
    if (row.length === width) return row
    if (row.length > width) return row.slice(0, width)
    const next = row.slice()
    while (next.length < width) next.push(pad)
    return next
  })
}

// Two real tokenizer shapes: the Rust binding (encode -> Encoding with getIds) and
// transformers.js (await tokenizer(texts, opts) -> {input_ids, attention_mask}).
async function tokenizeBatch(tokenizer, texts, maxTokens) {
  const limit = Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : 512
  if (tokenizer && typeof tokenizer.encode === 'function') {
    const ids = []
    const mask = []
    const types = []
    for (const text of texts) {
      let encoding = null
      try { encoding = await tokenizer.encode(String(text), { add_special_tokens: true, return_token_type_ids: true }) } catch { encoding = await tokenizer.encode(String(text)) }
      const rawIds = typeof encoding?.getIds === 'function' ? Array.from(encoding.getIds(), Number) : Array.isArray(encoding?.ids) ? Array.from(encoding.ids, Number) : null
      if (!rawIds) throw new Error('tokenizer.encode did not return token ids')
      const rawMask = typeof encoding?.getAttentionMask === 'function' ? Array.from(encoding.getAttentionMask(), Number) : Array.isArray(encoding?.attention_mask) ? Array.from(encoding.attention_mask, Number) : rawIds.map(() => 1)
      const rawTypes = typeof encoding?.getTypeIds === 'function' ? Array.from(encoding.getTypeIds(), Number) : Array.isArray(encoding?.token_type_ids) ? Array.from(encoding.token_type_ids, Number) : rawIds.map(() => 0)
      const truncate = (row) => row.length <= limit ? row : row.slice(0, Math.max(0, limit - 1)).concat(row.slice(-1))
      const rowIds = truncate(rawIds)
      const rowMask = truncate(rawMask)
      const rowTypes = truncate(rawTypes)
      ids.push(rowIds)
      mask.push(rowMask)
      types.push(rowTypes)
    }
    return { ids: padRows(ids, 0), mask: padRows(mask, 0), types: padRows(types, 0) }
  }
  if (typeof tokenizer === 'function') {
    const out = await tokenizer(texts, { padding: true, truncation: true, max_length: limit, return_tensor: false })
    const rows = (value) => (Array.isArray(value) && Array.isArray(value[0]) ? value : [value])
    const idsRows = rows(out && out.input_ids).map((row) => Array.from(row, Number).slice(0, limit))
    const maskRows = rows(out && (out.attention_mask || out.input_ids)).map((row) => Array.from(row, Number).slice(0, limit))
    return { ids: padRows(idsRows, 0), mask: padRows(maskRows, 0), types: idsRows.map((row) => row.map(() => 0)) }
  }
  throw new Error('unsupported tokenizer interface')
}

function poolTensor(tensor, { pooling, mask, normalize }) {
  const dims = Array.from((tensor && tensor.dims) || [])
  const data = tensor && tensor.data
  if (!data || dims.length < 2) throw new Error('graph output is not a hidden-state tensor')
  const batch = dims[0]
  const hidden = dims[dims.length - 1]
  const tokens = dims.length >= 3 ? dims[1] : 1
  const out = []
  for (let row = 0; row < batch; row++) {
    const vector = new Array(hidden).fill(0)
    const base = row * tokens * hidden
    if (pooling === 'mean' && tokens > 1) {
      const weights = mask && mask[row] ? mask[row] : null
      let total = 0
      for (let token = 0; token < tokens; token++) {
        const weight = weights ? Number(weights[token]) || 0 : 1
        if (!weight) continue
        total += weight
        for (let unit = 0; unit < hidden; unit++) vector[unit] += Number(data[base + token * hidden + unit]) * weight
      }
      for (let unit = 0; unit < hidden; unit++) vector[unit] = total > 0 ? vector[unit] / total : 0
    } else {
      for (let unit = 0; unit < hidden; unit++) vector[unit] = Number(data[base + unit])
    }
    if (normalize !== false) {
      let norm = 0
      for (const value of vector) norm += value * value
      norm = Math.sqrt(norm)
      if (norm > 0) for (let unit = 0; unit < hidden; unit++) vector[unit] /= norm
    }
    out.push(vector)
  }
  return out
}

function toBigInt64(rows) {
  const flat = new BigInt64Array(rows.length * rows[0].length)
  for (let row = 0; row < rows.length; row++) {
    for (let column = 0; column < rows[row].length; column++) flat[row * rows[row].length + column] = BigInt(Math.trunc(Number(rows[row][column]) || 0))
  }
  return flat
}

// Real inference path: managed CPU ONNX Runtime + a pinned tokenizer. It is only
// reached when no adapter is injected, and every failure is reported as
// LOCAL_VECTOR_RUNTIME_UNAVAILABLE rather than papered over by a fallback model.
export async function createOnnxAdapter({ modelDir, manifest = {}, runtimeDir, tokenizerModule, runtimeModule } = {}) {
  const graphPath = resolveInsideModelDir(modelDir, manifestFilePath(manifest, 'graph', manifest.onnx?.graph || 'model.onnx'))
  const runtimeSpec = runtimeModule || (manifest.runtime && manifest.runtime.module) || 'onnxruntime-node'
  let ort = null
  try { ort = await importFrom(runtimeSpec, runtimeDir) } catch (error) { throw runtimeUnavailable('runtime', runtimeSpec, runtimeDir, error) }
  const InferenceSession = ort.InferenceSession || (ort.default && ort.default.InferenceSession)
  if (!InferenceSession || typeof InferenceSession.create !== 'function') {
    throw runtimeUnavailable('runtime', runtimeSpec, runtimeDir, new Error('InferenceSession.create is missing'))
  }
  const tokenizerSpec = tokenizerModule || (manifest.tokenizer && manifest.tokenizer.module) || '@huggingface/tokenizers'
  let tokenizer = null
  try {
    const mod = await importFrom(tokenizerSpec, runtimeDir)
    tokenizer = await openTokenizer(mod, modelDir, manifest)
  } catch (error) {
    if (error instanceof LocalEmbeddingError) throw error
    throw runtimeUnavailable('tokenizer', tokenizerSpec, runtimeDir, error)
  }

  const threads = Number(manifest.runtime && manifest.runtime.threads)
  let session = null
  try {
    session = await InferenceSession.create(graphPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      ...(Number.isInteger(threads) && threads > 0 ? { intraOpNumThreads: threads } : {}),
    })
  } catch (error) {
    throw asError('embedding graph failed to load: ' + String((error && error.message) || error), 'LOCAL_VECTOR_RUNTIME_UNAVAILABLE', 503, { graph: path.basename(graphPath) })
  }

  const maxTokens = Number(manifest.maxTokens || (manifest.tokenizer && manifest.tokenizer.maxTokens) || 512)
  const pooling = String(manifest.pooling || 'cls').toLowerCase()
  const normalize = manifest.normalization ? String(manifest.normalization).toLowerCase() === 'l2' : manifest.normalize !== false
  const inputNames = Array.from(session.inputNames || Object.keys(session.inputMetadata || {}))

  const encode = async (texts) => {
    const batch = await tokenizeBatch(tokenizer, texts, maxTokens)
    const dims = [batch.ids.length, batch.ids[0].length]
    const feeds = {}
    for (const name of inputNames) {
      const key = name.toLowerCase()
      if (/token_type|segment/.test(key)) feeds[name] = new ort.Tensor('int64', toBigInt64(batch.types), dims)
      else if (/attention|mask/.test(key)) feeds[name] = new ort.Tensor('int64', toBigInt64(batch.mask), dims)
      else if (/input_ids|(^|_)ids$/.test(key)) feeds[name] = new ort.Tensor('int64', toBigInt64(batch.ids), dims)
    }
    const outputs = await session.run(feeds)
    const names = Array.from(session.outputNames || Object.keys(outputs))
    const tensor = outputs[names[0]] || Object.values(outputs)[0]
    return poolTensor(tensor, { pooling, mask: batch.mask, normalize })
  }

  return {
    // Quantized activations depend on other batch rows. Keep native inference
    // single-row so a document and the same query occupy one stable vector space.
    encode: async (texts) => {
      const vectors = []
      for (const text of texts) vectors.push(...await encode([text]))
      return vectors
    },
    close: async () => {
      try { await session.release() } catch {}
    },
  }
}

function bindAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw asError('an embedding adapter with encode(inputs) is required', 'LOCAL_VECTOR_RUNTIME_UNAVAILABLE', 503)
  }
  const fn = [adapter.encode, adapter.embed, adapter.embedBatch].find((candidate) => typeof candidate === 'function')
  if (!fn) throw asError('embedding adapter must expose encode(inputs)', 'LOCAL_VECTOR_RUNTIME_UNAVAILABLE', 503)
  return {
    encode: (inputs) => fn.call(adapter, inputs),
    close: typeof adapter.close === 'function' ? () => adapter.close() : null,
  }
}

// Accepts the shapes a runtime or a test adapter plausibly returns, but never
// guesses the count: a short/long result is an error, because a shifted batch
// would silently attach the wrong vector to the wrong memory segment.
function adapterVectors(output, expected, errorFactory) {
  let list = null
  if (Array.isArray(output)) list = output
  else if (output && typeof output === 'object') {
    if (Array.isArray(output.vectors)) list = output.vectors
    else if (Array.isArray(output.embeddings)) list = output.embeddings
    else if (Array.isArray(output.data)) list = output.data.map((entry) => (entry && typeof entry === 'object' && 'embedding' in entry ? entry.embedding : entry))
  }
  if (!list) throw errorFactory('embedding adapter returned no vectors', 'LOCAL_VECTOR_INVALID_VECTOR')
  if (list.length !== expected) {
    throw errorFactory('embedding adapter returned ' + list.length + ' vectors for ' + expected + ' inputs', 'LOCAL_VECTOR_VECTOR_COUNT_MISMATCH')
  }
  const usage = output && typeof output === 'object' && output.usage && typeof output.usage === 'object' ? output.usage : null
  return { vectors: list, usage }
}

function tokenMatches(header, token) {
  if (typeof header !== 'string' || typeof token !== 'string' || !token) return false
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) return false
  const provided = Buffer.from(match[1].trim(), 'utf8')
  const expected = Buffer.from(token, 'utf8')
  if (provided.length !== expected.length) return false
  return crypto.timingSafeEqual(provided, expected)
}

function sendJson(res, status, value, extraHeaders = null) {
  if (res.writableEnded || res.headersSent) return
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(extraHeaders || {}),
  })
  res.end(payload)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks = []
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish(asError('request body exceeds ' + limit + ' bytes', 'LOCAL_VECTOR_BODY_TOO_LARGE', 413))
        // Stop reading but keep the socket alive: the caller needs the 413 body,
        // so the connection is only torn down after the response is flushed.
        try { req.pause() } catch {}
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => finish(asError('request body could not be read', 'LOCAL_VECTOR_BODY_UNREADABLE', 400, String((error && error.code) || error))))
  })
}

/**
 * §14.5 managed embedding worker: one loopback HTTP server speaking the OpenAI
 * embeddings subset MemU already uses, backed by either an injected adapter (tests
 * only) or the pinned managed ONNX runtime.
 *
 * @returns {Promise<{baseUrl: string, url: string, healthUrl: string, model: string, dimension: number, close: () => Promise<void>, lastError: object|null}>}
 *   baseUrl is what MEMU_BASE_URL wants (http://host:port/v1); url is the full
 *   embeddings endpoint; healthUrl is the readiness probe outside /v1. lastError is
 *   live: set on any 5xx/inference failure and cleared by the next successful
 *   request so a healthy worker stops reporting.
 */
export async function startEmbeddingWorker(options = {}) {
  const {
    modelDir,
    manifest,
    runtimeDir,
    token,
    adapter = null,
    tokenizerModule,
    runtimeModule,
    host = '127.0.0.1',
    port = 0,
    logger = console,
    signal,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    maxBatch = DEFAULT_MAX_BATCH,
  } = options

  const { model, dimension } = assertServableManifest({ manifest, modelDir })

  if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH) {
    throw asError('a random token of at least ' + MIN_TOKEN_LENGTH + ' characters is required', 'LOCAL_VECTOR_TOKEN_INVALID', 400)
  }
  if (!isLoopbackHostname(host)) {
    throw asError('embedding worker only binds loopback, refused ' + String(host), 'LOCAL_VECTOR_BAD_HOST', 400)
  }
  const port_ = Number(port)
  if (!Number.isInteger(port_) || port_ < 0 || port_ > 65535) {
    throw asError('port must be an integer between 0 and 65535', 'LOCAL_VECTOR_BAD_PORT', 400)
  }
  const bodyLimit = Number.isInteger(maxBodyBytes) && maxBodyBytes > 0 ? maxBodyBytes : DEFAULT_MAX_BODY_BYTES
  const batchLimit = Number.isInteger(maxBatch) && maxBatch > 0 ? maxBatch : DEFAULT_MAX_BATCH

  const encoder = adapter
    ? bindAdapter(adapter)
    : await createOnnxAdapter({ modelDir, manifest, runtimeDir, tokenizerModule, runtimeModule })

  const fail = (message, code, status, detail) => asError(message, code, status, detail)
  const encodeVectors = async (inputs) => {
    let output = null
    try {
      output = await encoder.encode(inputs)
    } catch (error) {
      if (error instanceof LocalEmbeddingError) throw error
      throw fail('embedding inference failed: ' + String((error && error.message) || error), 'LOCAL_VECTOR_INFERENCE_FAILED', 500)
    }
    return adapterVectors(output, inputs.length, fail)
  }

  let lastError = null
  const noteFailure = (error) => {
    if (errorStatus(error) < 500) return
    lastError = {
      at: new Date().toISOString(),
      code: String((error && error.code) || 'LOCAL_VECTOR_ERROR'),
      message: String((error && error.message) || 'embedding request failed'),
    }
  }

  // Ready means the graph/tokenizer answered once with a finite, correctly sized,
  // non-zero vector. Without this smoke test the first recall pays the failure.
  let encoderClosed = false
  try {
    const smoke = await encodeVectors([SMOKE_TEXT])
    assertVector(smoke.vectors[0], dimension, 0)
  } catch (error) {
    try { if (encoder.close && !encoderClosed) { encoderClosed = true; await encoder.close() } } catch {}
    if (error instanceof LocalEmbeddingError) throw error
    throw fail('embedding smoke test failed: ' + String((error && error.message) || error), 'LOCAL_VECTOR_SMOKE_FAILED', 503)
  }

  const startedAt = Date.now()
  const sockets = new Set()
  let closed = false

  const assertLocalOrigin = (req) => {
    // Any Origin header means a browser page is talking to us: refuse, and never
    // send CORS headers, so a web app cannot use the local index as an oracle.
    if (req.headers.origin !== undefined) throw fail('cross-origin requests are not accepted', 'LOCAL_VECTOR_CORS_REJECTED', 403)
  }
  const assertLocalHost = (req) => {
    const raw = String(req.headers.host || '')
    const hostname = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0]
    if (!hostname) throw fail('host header is required', 'LOCAL_VECTOR_BAD_HOST', 403)
    if (!isLoopbackHostname(hostname)) throw fail('host header must be loopback', 'LOCAL_VECTOR_BAD_HOST', 403)
  }
  const assertAuthorized = (req) => {
    if (tokenMatches(req.headers.authorization, token)) return
    throw fail('missing or invalid bearer token', 'LOCAL_VECTOR_UNAUTHORIZED', 401)
  }
  const methodNotAllowed = (res, allowed) => {
    sendJson(res, 405, errorBody(fail('method not allowed', 'LOCAL_VECTOR_METHOD_NOT_ALLOWED', 405)), { allow: allowed })
  }

  const respondHealth = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET')
    lastError = null
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end()
      return
    }
    sendJson(res, 200, {
      object: 'local_embedding_health',
      status: 'ok',
      ready: !closed,
      model,
      dimension,
      maxBatch: batchLimit,
      encodings: ENCODINGS,
      uptimeMs: Date.now() - startedAt,
    })
  }

  const respondEmbeddings = async (req, res) => {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
    const contentType = String(req.headers['content-type'] || '')
    if (!/^application\/json\b/i.test(contentType)) {
      throw fail('content-type must be application/json', 'LOCAL_VECTOR_UNSUPPORTED_MEDIA_TYPE', 415)
    }
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > bodyLimit) {
      throw fail('request body exceeds ' + bodyLimit + ' bytes', 'LOCAL_VECTOR_BODY_TOO_LARGE', 413)
    }
    const raw = await readBody(req, bodyLimit)
    let body = null
    try { body = JSON.parse(raw) } catch { throw fail('request body is not valid JSON', 'LOCAL_VECTOR_BAD_REQUEST', 400) }
    const { inputs, encoding } = parseEmbeddingRequest(body, { model, maxBatch: batchLimit })
    const encoded = await encodeVectors(inputs)
    const vectors = encoded.vectors.map((vector, index) => assertVector(vector, dimension, index))
    sendJson(res, 200, buildEmbeddingResponse({ model, vectors, encoding, usage: encoded.usage }))
    lastError = null
  }

  const server = http.createServer((req, res) => {
    const route = String(req.url || '/')
    const serve = async () => {
      assertLocalOrigin(req)
      assertLocalHost(req)
      assertAuthorized(req)
      const pathname = new URL(route, 'http://127.0.0.1').pathname
      if (pathname === HEALTH_PATH) return respondHealth(req, res)
      if (pathname === EMBEDDINGS_PATH) return respondEmbeddings(req, res)
      throw fail('unknown endpoint', 'LOCAL_VECTOR_NOT_FOUND', 404)
    }
    serve().catch((error) => {
      noteFailure(error)
      const status = errorStatus(error)
      try {
        logger.warn?.('[dsh-memu-memory] local embedding worker ' + status + ' ' + String((error && error.code) || 'LOCAL_VECTOR_ERROR') + ' ' + String((error && error.message) || error) + ' (' + pathnameOf(route) + ')')
      } catch {}
      sendJson(res, status, errorBody(error), status === 401 ? { 'www-authenticate': 'Bearer' } : null)
      if (status === 413) res.on('finish', () => { try { req.destroy() } catch {} })
    })
  })
  const pathnameOf = (route) => {
    try { return new URL(route, 'http://127.0.0.1').pathname } catch { return '/' }
  }
  server.maxHeadersCount = 64
  server.headersTimeout = 20_000
  server.requestTimeout = 120_000
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  const close = async () => {
    if (closed) return
    closed = true
    if (signal) signal.removeEventListener?.('abort', onAbort)
    await new Promise((resolve) => {
      try {
        server.close(() => resolve())
      } catch {
        resolve()
      }
      for (const socket of sockets) {
        try { socket.destroy() } catch {}
      }
      sockets.clear()
      setTimeout(resolve, 2_000).unref?.()
    })
    if (encoder.close && !encoderClosed) {
      encoderClosed = true
      try { await encoder.close() } catch {}
    }
  }
  const onAbort = () => { void close() }

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      reject(fail('embedding worker could not listen on ' + host + ':' + port_ + ' (' + String((error && error.code) || error) + ')', 'LOCAL_VECTOR_LISTEN_FAILED', 503))
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port_, host)
  })

  if (signal) {
    if (signal.aborted) {
      await close()
      throw fail('embedding worker start aborted', 'LOCAL_VECTOR_ABORTED', 499)
    }
    signal.addEventListener?.('abort', onAbort, { once: true })
  }

  const address = server.address()
  const actualPort = address && typeof address === 'object' ? address.port : port_
  const hostForUrl = host === '::1' ? '[::1]' : host
  const origin = 'http://' + hostForUrl + ':' + actualPort
  const handle = {
    baseUrl: origin + '/v1',
    url: origin + EMBEDDINGS_PATH,
    healthUrl: origin + HEALTH_PATH,
    model,
    dimension,
    close,
  }
  Object.defineProperty(handle, 'lastError', { enumerable: true, get: () => lastError })
  try { logger.info?.('[dsh-memu-memory] local embedding worker ready on ' + origin + ' model=' + model + ' dimension=' + dimension) } catch {}
  return handle
}
