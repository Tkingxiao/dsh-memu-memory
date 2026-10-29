import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { getEmbeddingModel } from '../lib/embedding-catalog.js'
import { startEmbeddingWorker } from '../lib/local-embedding-worker.js'

const id = 'bge-small-zh-v1.5-int8'
const root = path.resolve('.tmp-local-vector-20261030')
const modelDir = path.join(root, 'model-root', id)
const runtimeDir = path.join(root, 'runtime-root')
const manifest = getEmbeddingModel(id)
const token = crypto.randomBytes(32).toString('hex')
const begin = performance.now()
let worker
const norm = a => Math.sqrt(a.reduce((n, x) => n + x * x, 0))
const cosine = (a, b) => a.reduce((n, x, i) => n + x * b[i], 0) / norm(a) / norm(b)
try {
  worker = await startEmbeddingWorker({ modelDir, runtimeDir, manifest, token })
  const readyMs = performance.now() - begin
  const texts = ['一个人在海边散步，海风很轻。', '海边的微风吹着散步的人。', '数据库迁移必须保持事务一致性。']
  async function request(input, encoding_format = 'float') {
    const start = performance.now()
    const response = await fetch(worker.url, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ model: worker.model, input, encoding_format }) })
    const result = await response.json()
    if (!response.ok) throw new Error(JSON.stringify(result))
    return { result, ms: performance.now() - start }
  }
  const batch = await request(texts)
  const single = await request(texts[0])
  const single2 = await request(texts[0])
  const base64 = await request(texts[0], 'base64')
  const vectors = batch.result.data.map(row => row.embedding)
  const buf = Buffer.from(base64.result.data[0].embedding, 'base64')
  const decoded = Array.from({ length: buf.length / 4 }, (_, i) => buf.readFloatLE(i * 4))
  if (vectors.some(v => v.length !== 512 || v.some(x => !Number.isFinite(x)) || Math.abs(norm(v) - 1) > 0.00001)) throw new Error('invalid real inference vector')
  const batchSingleCosine = cosine(vectors[0], single.result.data[0].embedding)
  const repeatedSingleCosine = cosine(single.result.data[0].embedding, single2.result.data[0].embedding)
  console.log(JSON.stringify({ batchSingleCosine, repeatedSingleCosine, norms: vectors.map(norm) }))
  if (batchSingleCosine < 0.999) throw new Error('batch padding changed embedding')
  if (cosine(decoded, single.result.data[0].embedding) < 0.999999) throw new Error('base64 encoding mismatch')
  const metadata = ['onnxruntime-node', 'onnxruntime-common', '@huggingface/tokenizers'].map(name => {
    const file = path.join(runtimeDir, 'node_modules', name, 'package.json')
    const bytes = fs.readFileSync(file)
    const pkg = JSON.parse(bytes)
    return { name, version: pkg.version, license: pkg.license, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
  })
  const report = { ok: true, model: worker.model, dimension: worker.dimension, readyMs, batchMs: batch.ms, singleMs: single.ms, norms: vectors.map(norm), relatedCosine: cosine(vectors[0], vectors[1]), unrelatedCosine: cosine(vectors[0], vectors[2]), batchSingleCosine, encodingCosine: cosine(decoded, single.result.data[0].embedding), metadata }
  fs.writeFileSync(path.join(root, 'runtime-smoke.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  if (worker) await worker.close()
}
