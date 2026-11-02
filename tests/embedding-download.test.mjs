import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Buffer } from 'node:buffer'
import { profileFingerprint, resolveEmbeddingSources } from '../lib/embedding-catalog.js'
import { createEmbeddingDownloadManager, verifyStagedArtifacts } from '../lib/embedding-download.js'

const REVISION = 'a'.repeat(40)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-embed-dl-'))
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex')

function varint(value) {
  const bytes = []
  let rest = value
  while (rest > 127) { bytes.push((rest & 0x7f) | 0x80); rest = Math.floor(rest / 128) }
  bytes.push(rest)
  return Buffer.from(bytes)
}
const tag = (field, wire) => varint((field << 3) | wire)
const bytesField = (field, buffer) => Buffer.concat([tag(field, 2), varint(buffer.length), buffer])
const textField = (field, text) => bytesField(field, Buffer.from(text, 'utf8'))
const intField = (field, value) => Buffer.concat([tag(field, 0), varint(value)])
const dimension = dim => (typeof dim === 'number' ? intField(1, dim) : textField(2, String(dim)))
function valueInfo(name, elemType, shape) {
  const shapeMessage = Buffer.concat(shape.map(dim => bytesField(1, dimension(dim))))
  const tensorType = Buffer.concat([intField(1, elemType), bytesField(2, shapeMessage)])
  return Buffer.concat([textField(1, name), bytesField(2, bytesField(1, tensorType))])
}
function tinyOnnxGraph(outputDim = 8) {
  const initializer = Buffer.concat([intField(1, 1), intField(2, 1), textField(8, 'w'), bytesField(9, Buffer.from('quantized-weights-fixture'))])
  const graph = Buffer.concat([
    bytesField(5, initializer),
    bytesField(11, valueInfo('input_ids', 7, ['batch_size', 'sequence_length'])),
    bytesField(11, valueInfo('attention_mask', 7, ['batch_size', 'sequence_length'])),
    bytesField(11, valueInfo('token_type_ids', 7, ['batch_size', 'sequence_length'])),
    bytesField(12, valueInfo('last_hidden_state', 1, ['batch_size', 'sequence_length', outputDim])),
  ])
  return Buffer.concat([intField(1, 6), textField(2, 'onnx.quantize'), bytesField(7, graph), bytesField(8, Buffer.concat([textField(1, ''), intField(2, 11)]))])
}

// fixture 目录：结构同真实 BGE 条目，但体积小、可在离线环境里跑完整个生命周期。
function fixtureManifest(overrides = {}) {
  const payloads = {
    'config.json': Buffer.from(JSON.stringify({ hidden_size: 8, max_position_embeddings: 32, vocab_size: 3, model_type: 'bert' })),
    'vocab.txt': Buffer.from('[PAD]\n[UNK]\n[CLS]\n'),
    'onnx/tiny.onnx': tinyOnnxGraph(8),
  }
  const files = Object.keys(payloads).map(filePath => ({
    path: filePath,
    role: filePath.endsWith('.onnx') ? 'graph' : filePath === 'config.json' ? 'config' : 'vocab',
    bytes: payloads[filePath].length,
    sha256: sha256(payloads[filePath]),
  }))
  const entry = {
    id: 'fixture-tiny-int8',
    displayName: 'Fixture tiny int8',
    languages: ['zh'],
    availability: 'available',
    pendingReasons: [],
    parameters: 1000,
    dimension: 8,
    maxTokens: 32,
    pooling: 'cls',
    normalization: 'l2',
    prefixes: { query: '', document: '' },
    quantization: { weights: 'qint8', scheme: 'dynamic-per-channel' },
    runtime: { engine: 'onnxruntime-node', version: null, abi: 'napi-v6', os: 'win32', arch: 'x64', verified: false },
    license: { base: { id: 'mit', source: 'fixture' }, onnxExport: { id: 'undeclared', source: 'fixture' } },
    verification: { status: 'verified', method: 'sha256+onnx-header', checkedAt: '2026-10-30T00:00:00.000Z' },
    sources: {
      modelscope: { repo: 'fixture/tiny', revision: REVISION },
      'hf-mirror': { repo: 'fixture/tiny', revision: REVISION },
      huggingface: { repo: 'fixture/tiny', revision: REVISION },
    },
    graph: {
      path: 'onnx/tiny.onnx',
      opset: 11,
      selfContained: true,
      externalData: [],
      inputs: [
        { name: 'input_ids', dtype: 'int64', shape: ['batch_size', 'sequence_length'] },
        { name: 'attention_mask', dtype: 'int64', shape: ['batch_size', 'sequence_length'] },
        { name: 'token_type_ids', dtype: 'int64', shape: ['batch_size', 'sequence_length'] },
      ],
      outputs: [{ name: 'last_hidden_state', dtype: 'float32', shape: ['batch_size', 'sequence_length', 8] }],
    },
    files,
  }
  entry.totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  entry.profileFingerprint = profileFingerprint(entry)
  return { entry: { ...entry, ...overrides.entry }, payloads: { ...payloads, ...(overrides.payloads || {}) } }
}

function responseFor(bytes, options = {}) {
  const status = options.status ?? 200
  const split = options.chunk ?? 7
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => {
      const lowered = String(name).toLowerCase()
      if (lowered === 'content-length') return options.contentLength === undefined ? String(bytes.length) : options.contentLength
      return null
    } },
    body: (async function* body() { for (let index = 0; index < bytes.length; index += split) yield bytes.subarray(index, index + split) })(),
  }
}

function makeFetch(entry, payloads, options = {}) {
  const resolved = resolveEmbeddingSources(entry)
  const routes = new Map(resolved.primary.files.map(file => [file.url, file.path]))
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (options.gate) await options.gate
    if (init?.signal?.aborted) { const error = new Error('aborted'); error.name = 'AbortError'; throw error }
    const filePath = routes.get(url)
    if (!filePath) return { ok: false, status: 404, headers: { get: () => null }, body: null }
    const payload = options.transform ? options.transform(filePath, payloads[filePath]) : payloads[filePath]
    return responseFor(payload, options.responseFor ? options.responseFor(filePath) : {})
  }
  return { fetchImpl, calls, routes, resolved }
}

function managerFor(entry, fetchImpl, extra = {}) {
  const root = fs.mkdtempSync(path.join(scratch, 'root-'))
  return { root, manager: createEmbeddingDownloadManager({ root, catalog: [entry], fetchImpl, ...extra }) }
}

test('没有明确确认就绝不下模型，也不发任何请求', async () => {
  const { entry, payloads } = fixtureManifest()
  const { fetchImpl, calls } = makeFetch(entry, payloads)
  const { manager } = managerFor(entry, fetchImpl)
  await assert.rejects(manager.download(entry.id, {}), error => error.code === 'EMBEDDING_CONFIRMATION_REQUIRED')
  await assert.rejects(manager.download(entry.id, { confirmed: 'yes' }), error => error.code === 'EMBEDDING_CONFIRMATION_REQUIRED')
  assert.equal(calls.length, 0)
  const status = manager.getStatus(entry.id)
  assert.equal(status.state, 'absent')
  assert.equal(status.installed, false)
  assert.equal(status.active, false)
})

test('pending 模型与未知 id 都被拒绝，且不会联网', async () => {
  const { entry, payloads } = fixtureManifest()
  const pending = {
    ...entry,
    id: 'fixture-pending-model',
    availability: 'pending',
    files: [],
    totalBytes: 0,
    pendingReasons: ['制品未核实：没有可比对的 bytes/sha256'],
    verification: { ...entry.verification, status: 'unverified' },
  }
  pending.profileFingerprint = profileFingerprint(pending)
  const { fetchImpl, calls } = makeFetch(entry, payloads)
  const { manager } = managerFor(pending, fetchImpl)
  await assert.rejects(manager.download('fixture-pending-model', { confirmed: true }), error => {
    assert.equal(error.code, 'EMBEDDING_MODEL_UNAVAILABLE')
    assert.ok(error.pendingReasons.length > 0)
    return true
  })
  await assert.rejects(manager.download('does-not-exist', { confirmed: true }), error => error.code === 'EMBEDDING_MODEL_UNKNOWN')
  assert.equal(calls.length, 0)
  assert.equal(manager.getStatus('does-not-exist').state, 'unknown')
})

// hf-mirror 对小文件用 chunked 传输（不发 content-length）。把「头缺失」当成 0 字节会
// 让每一个小文件都被误判成大小不符——真实装 Qwen3 时踩到的就是这个。
test('来源不发 content-length 时按下落的实际字节判断，不当成 0', async () => {
  const { entry, payloads } = fixtureManifest()
  const { fetchImpl } = makeFetch(entry, payloads, { responseFor: filePath => (filePath === 'config.json' ? { contentLength: null } : {}) })
  const { manager } = managerFor(entry, fetchImpl)
  const status = await manager.download(entry.id, { confirmed: true })
  assert.equal(status.state, 'installed')
  assert.equal(status.installed, true)
})

// 多来源条目（Qwen3 卡片就是 hf-mirror + huggingface 同一个 commit）：默认取目录顺序里
// 第一个，显式选源就只能用那一个，失败也不许回退到另一个源去下载。
test('显式选源只走那一个 provider，不回退到默认源', async () => {
  const { entry, payloads } = fixtureManifest()
  const mirrored = { ...entry, sources: {
    'hf-mirror': { repo: 'fixture/tiny', revision: REVISION },
    huggingface: { repo: 'fixture/tiny', revision: REVISION },
  } }
  const routes = new Map()
  for (const provider of ['hf-mirror', 'huggingface']) {
    for (const file of resolveEmbeddingSources(mirrored, { providers: [provider] }).primary.files) routes.set(file.url, { provider, path: file.path })
  }
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(url)
    const route = routes.get(url)
    if (!route) return { ok: false, status: 404, headers: { get: () => null }, body: null }
    return responseFor(payloads[route.path], {})
  }
  const { manager } = managerFor(mirrored, fetchImpl)
  const byDefault = await manager.download(mirrored.id, { confirmed: true })
  assert.equal(byDefault.provider, 'hf-mirror', '默认必须是镜像站')
  assert.ok(calls[0].startsWith('https://hf-mirror.com/'), calls[0])

  const { root } = managerFor(mirrored, fetchImpl)
  const second = createEmbeddingDownloadManager({ root, catalog: [mirrored], fetchImpl })
  const chosen = await second.download(mirrored.id, { confirmed: true, provider: 'huggingface' })
  assert.equal(chosen.provider, 'huggingface')
  assert.ok(calls.some(url => url.startsWith('https://huggingface.co/')), '选源后要真的打到源站')
  // 不存在的 provider 与「存在但这个条目没固定」是两种错，都要如实分开
  await assert.rejects(second.download(mirrored.id, { confirmed: true, provider: 'ollama' }), error => error.code === 'EMBEDDING_PROVIDER_UNKNOWN')
  await assert.rejects(second.download(mirrored.id, { confirmed: true, provider: 'modelscope' }), error => {
    assert.equal(error.code, 'EMBEDDING_SOURCE_UNAVAILABLE')
    assert.ok(String(error.message).includes('on modelscope'), error.message)
    return true
  })
  // 换源之后默认源仍然可用（不许把条目卡在唯一来源上）
  const third = createEmbeddingDownloadManager({ root, catalog: [mirrored], fetchImpl })
  assert.equal((await third.download(mirrored.id, { confirmed: true })).provider, 'hf-mirror')
})

test('verifyStagedArtifacts 核对 last-token pooling、float16 输出与窗口上限', async () => {
  const dir = fs.mkdtempSync(path.join(scratch, 'last-'))
  const graph = tinyOnnxGraph(8)
  fs.mkdirSync(path.join(dir, '1_Pooling'), { recursive: true })
  const base = {
    id: 'fixture-last', dimension: 8, maxTokens: 32, pooling: 'last', normalization: 'l2',
    graph: { path: 'onnx/tiny.onnx', opset: 11, inputs: [
      { name: 'input_ids', dtype: 'int64' }, { name: 'attention_mask', dtype: 'int64' }, { name: 'token_type_ids', dtype: 'int64' },
    ], outputs: [{ name: 'last_hidden_state', dtype: 'float32', shape: ['batch_size', 'sequence_length', 8] }] },
    files: [
      { path: 'config.json', role: 'config' },
      { path: 'onnx/tiny.onnx', role: 'graph' },
      { path: '1_Pooling/config.json', role: 'pooling-config' },
    ],
  }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ hidden_size: 8, max_position_embeddings: 32 }), 'utf8')
  fs.mkdirSync(path.join(dir, 'onnx'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'onnx/tiny.onnx'), graph)
  fs.writeFileSync(path.join(dir, '1_Pooling', 'config.json'), JSON.stringify({ word_embedding_dimension: 8, pooling_mode_lasttoken: true }), 'utf8')
  const ok = await verifyStagedArtifacts({ entry: base, dir })
  assert.ok(ok.checks.includes('pooling=last'), JSON.stringify(ok.checks))

  fs.writeFileSync(path.join(dir, '1_Pooling', 'config.json'), JSON.stringify({ word_embedding_dimension: 8, pooling_mode_mean_tokens: true }), 'utf8')
  await assert.rejects(verifyStagedArtifacts({ entry: base, dir }), /not last-token pooling/)
  fs.writeFileSync(path.join(dir, '1_Pooling', 'config.json'), JSON.stringify({ word_embedding_dimension: 8, pooling_mode_lasttoken: true }), 'utf8')

  // 窗口可以比制品小（刻意策略），但不能比制品大（必炸）
  await assert.rejects(verifyStagedArtifacts({ entry: { ...base, maxTokens: 64 }, dir }), /exceeds the artifact's max_position_embeddings/)
  // float16 图输出是可以接受的，但声明必须与图一致
  const fp16 = { ...base, files: base.files.map(file => (file.role === 'graph' ? file : file)), graph: { ...base.graph, outputs: [{ name: 'last_hidden_state', dtype: 'float16', shape: ['batch_size', 'sequence_length', 8] }] } }
  await assert.rejects(verifyStagedArtifacts({ entry: fp16, dir }), /output dtype/)
})

test('校验通过的制品原子安装：staging 清空、installed.json 记录 active:false', async () => {
  const { entry, payloads } = fixtureManifest()
  const { fetchImpl, calls } = makeFetch(entry, payloads)
  const { root, manager } = managerFor(entry, fetchImpl)
  const status = await manager.download(entry.id, { confirmed: true })
  assert.equal(status.state, 'installed')
  assert.equal(status.installed, true)
  assert.equal(status.active, false)
  assert.equal(status.fingerprintMatches, true)
  assert.equal(status.revision, REVISION)
  assert.equal(status.provider, 'modelscope')
  assert.ok(status.checks.includes('graph.opset=11'))
  assert.equal(calls.length, entry.files.length)
  assert.deepEqual(calls.map(call => call.url).sort(), resolveEmbeddingSources(entry).primary.files.map(file => file.url).sort())
  for (const file of entry.files) {
    const target = path.join(root, entry.id, ...file.path.split('/'))
    assert.equal(fs.statSync(target).size, file.bytes)
    assert.equal(sha256(fs.readFileSync(target)), file.sha256)
  }
  const record = JSON.parse(fs.readFileSync(path.join(root, entry.id, 'installed.json'), 'utf8'))
  assert.equal(record.active, false)
  assert.equal(record.fingerprint, entry.profileFingerprint)
  assert.equal(record.verifiedBy, 'sha256+structural-smoke')
  assert.deepEqual(fs.readdirSync(path.join(root, '.staging')), [])
  assert.equal(manager.getStatus(entry.id, { deep: true }).verified, true)
  // 磁盘上不允许出现 active/profile 指针文件：激活是迁移模块的事。
  const names = fs.readdirSync(path.join(root, entry.id))
  assert.ok(names.every(name => !/active|profile/i.test(name)))
})

test('hash 不符立即失败，不安装，也不碰已有安装', async () => {
  const { entry, payloads } = fixtureManifest()
  const good = makeFetch(entry, payloads)
  const { root, manager } = managerFor(entry, good.fetchImpl)
  const first = await manager.download(entry.id, { confirmed: true })
  assert.equal(first.state, 'installed')
  const recordPath = path.join(root, entry.id, 'installed.json')
  const before = fs.readFileSync(recordPath, 'utf8')

  const tampered = makeFetch(entry, payloads, { transform: (filePath, buffer) => (filePath === 'onnx/tiny.onnx' ? Buffer.concat([buffer, Buffer.from('tampered')]) : buffer) })
  const { manager: brokenManager } = managerFor(entry, tampered.fetchImpl, {})
  const brokenRoot = brokenManager.root
  await assert.rejects(brokenManager.download(entry.id, { confirmed: true }), error => {
    assert.equal(error.code, 'EMBEDDING_SIZE_MISMATCH')
    return true
  })
  assert.deepEqual(fs.readdirSync(path.join(brokenRoot, '.staging')), [])
  assert.equal(fs.existsSync(path.join(brokenRoot, entry.id)), false)

  const sameSizeTamper = makeFetch(entry, payloads, { transform: (filePath, buffer) => {
    if (filePath !== 'onnx/tiny.onnx') return buffer
    const copy = Buffer.from(buffer)
    copy[copy.length - 1] = copy[copy.length - 1] ^ 0xff
    return copy
  } })
  const { manager: sameSizeManager } = managerFor(entry, sameSizeTamper.fetchImpl, {})
  await assert.rejects(sameSizeManager.download(entry.id, { confirmed: true }), error => error.code === 'EMBEDDING_HASH_MISMATCH')
  assert.equal(fs.existsSync(path.join(sameSizeManager.root, entry.id)), false)
  assert.deepEqual(fs.readdirSync(path.join(sameSizeManager.root, '.staging')), [])

  // 原有安装一字未动。
  assert.equal(fs.readFileSync(recordPath, 'utf8'), before)
  assert.equal(manager.getStatus(entry.id).state, 'installed')
})

test('content-length 与固定字节数不符时代理响应被拒绝', async () => {
  const { entry, payloads } = fixtureManifest()
  const { fetchImpl } = makeFetch(entry, payloads, { responseFor: filePath => (filePath === 'config.json' ? { contentLength: '999' } : {}) })
  const { root, manager } = managerFor(entry, fetchImpl)
  await assert.rejects(manager.download(entry.id, { confirmed: true }), error => error.code === 'EMBEDDING_SIZE_MISMATCH')
  assert.equal(manager.getStatus(entry.id).state, 'failed')
  assert.equal(fs.existsSync(path.join(root, entry.id)), false)
})

test('模型 smoke 不通过（结构或自定义 verifyModel）时同样不安装', async () => {
  const { entry, payloads } = fixtureManifest()
  const badGraph = Buffer.from(tinyOnnxGraph(16))
  const wrongDim = fixtureManifest({ payloads: { 'onnx/tiny.onnx': badGraph }, entry: {} })
  wrongDim.entry.files.find(file => file.path === 'onnx/tiny.onnx').bytes = badGraph.length
  wrongDim.entry.files.find(file => file.path === 'onnx/tiny.onnx').sha256 = sha256(badGraph)
  wrongDim.entry.totalBytes = wrongDim.entry.files.reduce((sum, file) => sum + file.bytes, 0)
  wrongDim.entry.profileFingerprint = profileFingerprint(wrongDim.entry)
  const structural = makeFetch(wrongDim.entry, wrongDim.payloads)
  const { root, manager } = managerFor(wrongDim.entry, structural.fetchImpl)
  await assert.rejects(manager.download(wrongDim.entry.id, { confirmed: true }), error => {
    assert.equal(error.code, 'EMBEDDING_SMOKE_FAILED')
    assert.match(error.message, /last dim 16/)
    return true
  })
  assert.equal(fs.existsSync(path.join(root, wrongDim.entry.id)), false)

  const custom = makeFetch(entry, payloads)
  const { root: customRoot, manager: customManager } = managerFor(entry, custom.fetchImpl, { verifyModel: async () => { throw new Error('tokenizer smoke says no') } })
  await assert.rejects(customManager.download(entry.id, { confirmed: true }), error => error.code === 'EMBEDDING_SMOKE_FAILED')
  assert.equal(customManager.getStatus(entry.id).state, 'failed')
  assert.equal(fs.existsSync(path.join(customRoot, entry.id)), false)
})

test('verifyStagedArtifacts 直接核对图头、config 与词表', async () => {
  const { entry, payloads } = fixtureManifest()
  const dir = fs.mkdtempSync(path.join(scratch, 'staged-'))
  for (const [filePath, buffer] of Object.entries(payloads)) {
    fs.mkdirSync(path.dirname(path.join(dir, filePath)), { recursive: true })
    fs.writeFileSync(path.join(dir, filePath), buffer)
  }
  const result = await verifyStagedArtifacts({ entry, dir })
  assert.equal(result.ok, true)
  assert.ok(result.checks.includes('graph.initializerBytes=' + Buffer.from('quantized-weights-fixture').length))
  assert.ok(result.checks.includes('vocab.txt=3'))
  fs.writeFileSync(path.join(dir, 'vocab.txt'), '[PAD]\n')
  await assert.rejects(verifyStagedArtifacts({ entry, dir }), /vocab\.txt/)
})

test('取消下载：状态 cancelled、半成品不留在 staging、旧安装保留', async () => {
  const { entry, payloads } = fixtureManifest()
  const good = makeFetch(entry, payloads)
  const { root, manager } = managerFor(entry, good.fetchImpl)
  await manager.download(entry.id, { confirmed: true })
  const before = manager.getStatus(entry.id)

  let release
  const gate = new Promise(resolve => { release = resolve })
  const slow = makeFetch(entry, payloads, { gate })
  const { manager: slowManager } = managerFor(entry, slow.fetchImpl, {})
  const controller = new AbortController()
  const pending = slowManager.download(entry.id, { confirmed: true, signal: controller.signal })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(slowManager.getStatus(entry.id).state, 'downloading')
  controller.abort()
  release()
  await assert.rejects(pending, error => error.code === 'EMBEDDING_DOWNLOAD_ABORTED')
  assert.equal(slowManager.getStatus(entry.id).state, 'cancelled')
  assert.deepEqual(fs.readdirSync(path.join(slowManager.root, '.staging')), [])
  assert.equal(fs.existsSync(path.join(slowManager.root, entry.id)), false)
  assert.equal(manager.getStatus(entry.id).installedAt, before.installedAt)
  assert.equal(manager.getStatus(entry.id).state, 'installed')
})

test('同一模型并发下载被拒绝，进度可查', async () => {
  const { entry, payloads } = fixtureManifest()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const slow = makeFetch(entry, payloads, { gate })
  const { manager } = managerFor(entry, slow.fetchImpl)
  const first = manager.download(entry.id, { confirmed: true })
  await new Promise(resolve => setTimeout(resolve, 20))
  const progress = manager.getStatus(entry.id)
  assert.equal(progress.state, 'downloading')
  assert.equal(progress.progress.files, entry.files.length)
  await assert.rejects(manager.download(entry.id, { confirmed: true }), error => error.code === 'EMBEDDING_DOWNLOAD_BUSY')
  release()
  const status = await first
  assert.equal(status.state, 'installed')
})

test('越界文件路径在 manifest 阶段就被拒绝，写不出 root', async () => {
  for (const badPath of ['../escape.bin', 'nested/../../escape.bin', 'C:/windows/evil.bin', '/etc/passwd', 'onnx\\evil.onnx']) {
    const { entry, payloads } = fixtureManifest()
    entry.files = entry.files.map(file => (file.role === 'graph' ? { ...file, path: badPath } : file))
    entry.graph = { ...entry.graph, path: badPath }
    entry.profileFingerprint = profileFingerprint(entry)
    const { fetchImpl, calls } = makeFetch(entry, payloads)
    const { root, manager } = managerFor(entry, fetchImpl)
    await assert.rejects(manager.download(entry.id, { confirmed: true }), error => {
      assert.equal(error.code, 'EMBEDDING_MANIFEST_INVALID')
      assert.ok(error.errors.some(item => item.code === 'FILE_PATH_UNSAFE'))
      return true
    })
    assert.equal(calls.length, 0)
    assert.deepEqual(fs.readdirSync(root), [])
    assert.equal(fs.existsSync(path.join(scratch, 'escape.bin')), false)
  }
})

test('重新下载同一模型时旧安装被替换，不留 trash 残渣', async () => {
  const { entry, payloads } = fixtureManifest()
  const good = makeFetch(entry, payloads)
  const { root, manager } = managerFor(entry, good.fetchImpl)
  const first = await manager.download(entry.id, { confirmed: true })
  assert.equal(first.state, 'installed')
  const nextRevision = 'd'.repeat(40)
  const upgraded = { ...entry, sources: { modelscope: { repo: 'fixture/tiny', revision: nextRevision } } }
  upgraded.profileFingerprint = profileFingerprint(upgraded)
  const again = makeFetch(upgraded, payloads)
  // 同一个 root：旧安装必须先被原子替换，而不是并存或半途丢失。
  const freshManager = createEmbeddingDownloadManager({ root, catalog: [upgraded], fetchImpl: again.fetchImpl })
  const second = await freshManager.download(entry.id, { confirmed: true })
  assert.equal(second.revision, nextRevision)
  assert.equal(second.state, 'installed')
  assert.deepEqual(fs.readdirSync(path.join(freshManager.root, '.trash')), [])
  assert.equal(JSON.parse(fs.readFileSync(path.join(freshManager.root, entry.id, 'installed.json'), 'utf8')).revision, nextRevision)
  assert.equal(manager.getStatus(entry.id).state, 'installed')
})

test('fetchImpl 失败时状态是 failed，错误码可展示且不伪造安装', async () => {
  const { entry } = fixtureManifest()
  const failing = async () => { throw new Error('ECONNRESET') }
  const { root, manager } = managerFor(entry, failing)
  await assert.rejects(manager.download(entry.id, { confirmed: true }), error => error.code === 'EMBEDDING_NETWORK_ERROR')
  const status = manager.getStatus(entry.id)
  assert.equal(status.state, 'failed')
  assert.equal(status.installed, false)
  assert.equal(status.error.code, 'EMBEDDING_NETWORK_ERROR')
  assert.equal(fs.existsSync(path.join(root, entry.id)), false)
})

test('dispose 中止在途下载，不留下崩溃痕迹', async () => {
  const { entry, payloads } = fixtureManifest()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const slow = makeFetch(entry, payloads, { gate })
  const { manager } = managerFor(entry, slow.fetchImpl)
  const pending = manager.download(entry.id, { confirmed: true })
  await new Promise(resolve => setTimeout(resolve, 20))
  manager.dispose()
  release()
  await assert.rejects(pending, error => error.code === 'EMBEDDING_DOWNLOAD_ABORTED')
  assert.equal(manager.getStatus(entry.id).state, 'cancelled')
})

test('root 必须是显式目录；模型根目录之外的路径被拒绝', async () => {
  assert.throws(() => createEmbeddingDownloadManager({}), TypeError)
  assert.throws(() => createEmbeddingDownloadManager({ root: '' }), TypeError)
  const { entry } = fixtureManifest()
  const root = fs.mkdtempSync(path.join(scratch, 'root-guard-'))
  const manager = createEmbeddingDownloadManager({ root, catalog: [entry], fetchImpl: async () => { throw new Error('unused') } })
  assert.equal(manager.root, path.resolve(root))
  assert.ok(manager.catalogIds.includes('bge-small-zh-v1.5-int8'))
  assert.equal(manager.getStatus('bge-small-zh-v1.5-int8').state, 'absent')
})
