import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import {
  FILE_ROLES,
  PROVIDER_ORDER,
  getEmbeddingCatalog,
  getEmbeddingModel,
  profileFingerprint,
  readOnnxGraphHeader,
  resolveEmbeddingSources,
  toProfileDescriptor,
  validateEmbeddingManifest,
} from '../lib/embedding-catalog.js'

const BGE = 'bge-small-zh-v1.5-int8'
const BGE_REVISION = '313386ad7ffad360a4870fd1910f8ecaf1a05151'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

// 合成一个最小 ONNX 图头，用来验证解析器与"manifest 声称 vs 制品实际"的对照逻辑。
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

function dimension(dim) {
  return typeof dim === 'number' ? intField(1, dim) : textField(2, String(dim))
}

function valueInfo(name, elemType, shape) {
  const shapeMessage = Buffer.concat(shape.map(dim => bytesField(1, dimension(dim))))
  const tensorType = Buffer.concat([intField(1, elemType), bytesField(2, shapeMessage)])
  return Buffer.concat([textField(1, name), bytesField(2, bytesField(1, tensorType))])
}

function tinyOnnxGraph({ outputDim = 8, initializer = Buffer.from('weights-fixture') } = {}) {
  const initializerMessage = Buffer.concat([intField(1, 1), intField(2, 1), textField(8, 'w'), bytesField(9, initializer)])
  const graph = Buffer.concat([
    bytesField(5, initializerMessage),
    bytesField(11, valueInfo('input_ids', 7, ['batch_size', 'sequence_length'])),
    bytesField(11, valueInfo('attention_mask', 7, ['batch_size', 'sequence_length'])),
    bytesField(11, valueInfo('token_type_ids', 7, ['batch_size', 'sequence_length'])),
    bytesField(12, valueInfo('last_hidden_state', 1, ['batch_size', 'sequence_length', outputDim])),
  ])
  const opset = Buffer.concat([textField(1, ''), intField(2, 11)])
  return Buffer.concat([intField(1, 6), textField(2, 'onnx.quantize'), textField(3, '0.1.0'), bytesField(7, graph), bytesField(8, opset)])
}

test('目录是冻结的只读快照，未知 id 返回 null 而不是默认模型', () => {
  const catalog = getEmbeddingCatalog()
  assert.ok(Object.isFrozen(catalog))
  assert.ok(Object.isFrozen(catalog[0]))
  assert.throws(() => { catalog.push({ id: 'x' }) }, TypeError)
  assert.deepEqual(catalog.map(entry => entry.id), [BGE, 'all-minilm-l6-v2-int8', 'multilingual-e5-small'])
  assert.equal(getEmbeddingModel('nope'), null)
  assert.equal(getEmbeddingModel(undefined), null)
  assert.equal(getEmbeddingModel('../../etc/passwd'), null)
})

test('首个 BGE 条目带着已核实的固定 commit、逐文件字节数与 SHA-256', () => {
  const entry = getEmbeddingModel(BGE)
  assert.equal(entry.availability, 'available')
  assert.match(entry.sources.modelscope.revision, /^[0-9a-f]{40}$/)
  assert.equal(entry.sources.modelscope.revision, BGE_REVISION)
  assert.equal(entry.sources.modelscope.repo, 'Xenova/bge-small-zh-v1.5')
  assert.equal(entry.dimension, 512)
  assert.equal(entry.maxTokens, 512)
  assert.equal(entry.pooling, 'cls')
  assert.equal(entry.normalization, 'l2')
  assert.equal(entry.graph.opset, 11)
  assert.equal(entry.graph.outputs[0].name, 'last_hidden_state')
  assert.equal(entry.files.length, 9)
  assert.equal(entry.totalBytes, 24562636)
  for (const file of entry.files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/, file.path + ' sha256')
    assert.ok(Number.isInteger(file.bytes) && file.bytes > 0, file.path + ' bytes')
    assert.ok(FILE_ROLES.includes(file.role), file.path + ' role')
  }
  const graph = entry.files.find(file => file.role === 'graph')
  assert.equal(graph.bytes, 24010842)
  assert.equal(graph.sha256, '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc')
  assert.equal(entry.verification.status, 'verified')
  assert.equal(entry.verification.method, 'sha256+onnx-header')
  assert.ok(!Number.isNaN(Date.parse(entry.verification.checkedAt)))
  assert.equal(entry.license.base.id, 'mit')
})

test('已核实的 BGE manifest 通过校验，但把未核实项如实标成警告', () => {
  const report = validateEmbeddingManifest(getEmbeddingModel(BGE))
  assert.deepEqual(report.errors, [])
  assert.equal(report.ok, true)
  const codes = report.warnings.map(item => item.code)
  assert.ok(codes.includes('LICENSE_DERIVATIVE_UNDECLARED'), 'ONNX 导出许可未单独声明必须可见')
  assert.ok(!codes.includes('RUNTIME_VERSION_UNPINNED'), '隔离真实 ORT smoke 已固定运行时版本')
  assert.equal(codes.filter(code => code === 'SOURCE_REVISION_UNPINNED').length, 2)
})

test('未核实模型是 pending：没有文件、没有哈希、理由齐全', () => {
  for (const id of ['all-minilm-l6-v2-int8', 'multilingual-e5-small']) {
    const entry = getEmbeddingModel(id)
    assert.equal(entry.availability, 'pending')
    assert.deepEqual(entry.files, [])
    assert.equal(entry.totalBytes, 0)
    assert.ok(entry.pendingReasons.length >= 2)
    const report = validateEmbeddingManifest(entry)
    assert.equal(report.ok, true, id + ' pending 条目本身应结构合法')
    assert.equal(report.errors.length, 0)
  }
})

test('manifest 校验会拒绝伪造/缺失的制品元数据', () => {
  const broken = clone(getEmbeddingModel(BGE))
  broken.files[0].sha256 = 'not-a-hash'
  broken.files[1].bytes = '439125'
  broken.files[2].path = '../escape.json'
  broken.files[3].path = 'C:/windows/system32/config'
  broken.totalBytes = 1
  const report = validateEmbeddingManifest(broken)
  assert.equal(report.ok, false)
  const codes = new Set(report.errors.map(item => item.code))
  for (const code of ['FILE_SHA256_INVALID', 'FILE_BYTES_INVALID', 'FILE_PATH_UNSAFE', 'TOTAL_BYTES_MISMATCH']) {
    assert.ok(codes.has(code), 'expect ' + code)
  }
})

test('available 但制品未核实、没有固定 commit 的条目不可下载', () => {
  const lying = clone(getEmbeddingModel(BGE))
  lying.verification = { status: 'unverified', method: null, checkedAt: null }
  lying.sources = {
    modelscope: { repo: 'Xenova/bge-small-zh-v1.5', revision: null },
    'hf-mirror': { repo: 'Xenova/bge-small-zh-v1.5', revision: null },
    huggingface: { repo: 'Xenova/bge-small-zh-v1.5', revision: null },
  }
  const report = validateEmbeddingManifest(lying)
  assert.equal(report.ok, false)
  const codes = report.errors.map(item => item.code)
  assert.ok(codes.includes('VERIFICATION_MISSING'))
  assert.ok(codes.includes('SOURCE_NOT_PINNED'))
})

test('指纹随向量空间字段变化，篡改指纹会被拒绝', () => {
  const entry = getEmbeddingModel(BGE)
  assert.match(entry.profileFingerprint, /^[0-9a-f]{64}$/)
  assert.equal(profileFingerprint(entry), entry.profileFingerprint)
  const otherPooling = clone(entry)
  otherPooling.pooling = 'mean'
  assert.notEqual(profileFingerprint(otherPooling), entry.profileFingerprint)
  const otherPrefix = clone(entry)
  otherPrefix.prefixes = { query: 'query: ', document: 'passage: ' }
  assert.notEqual(profileFingerprint(otherPrefix), entry.profileFingerprint)
  const otherGraph = clone(entry)
  otherGraph.files.find(file => file.role === 'graph').sha256 = 'f'.repeat(64)
  assert.notEqual(profileFingerprint(otherGraph), entry.profileFingerprint)
  const tampered = clone(entry)
  tampered.profileFingerprint = '0'.repeat(64)
  assert.ok(validateEmbeddingManifest(tampered).errors.some(item => item.code === 'FINGERPRINT_MISMATCH'))
})

test('来源解析默认 modelscope→hf-mirror→huggingface，只为显式固定的 revision 生成 URL', () => {
  const resolved = resolveEmbeddingSources(BGE)
  assert.deepEqual(resolved.order, [...PROVIDER_ORDER])
  assert.deepEqual(resolved.order, ['modelscope', 'hf-mirror', 'huggingface'])
  assert.equal(resolved.sources.length, 1)
  const primary = resolved.primary
  assert.equal(primary.provider, 'modelscope')
  assert.equal(primary.revision, BGE_REVISION)
  assert.equal(primary.files.length, 9)
  const config = primary.files.find(file => file.path === 'config.json')
  assert.equal(config.url, 'https://modelscope.cn/api/v1/models/Xenova/bge-small-zh-v1.5/repo?Revision=' + BGE_REVISION + '&FilePath=config.json')
  const graph = primary.files.find(file => file.path === 'onnx/model_quantized.onnx')
  assert.match(graph.url, /FilePath=onnx%2Fmodel_quantized\.onnx$/)
  // 见证制品来自 BAAI 仓库的固定 revision，而不是冒充 BGE 导出仓库。
  const pooling = primary.files.find(file => file.path === '1_Pooling/config.json')
  assert.match(pooling.url, /BAAI\/bge-small-zh-v1\.5/)
  assert.match(pooling.url, /Revision=8399f11f8da998fe932df2684586c92024219d05/)
  // 没有固定 commit 的来源绝不生成 URL。
  assert.deepEqual(resolved.skipped.map(item => item.provider), ['hf-mirror', 'huggingface'])
  assert.ok(resolved.skipped.every(item => item.reason === 'revision-unpinned'))
  const serialized = JSON.stringify(resolved)
  assert.ok(!serialized.includes('hf-mirror.com'))
  assert.ok(!serialized.includes('huggingface.co'))
})

test('来源顺序可覆盖，三个来源都固定时按顺序给出各自的 URL 形状', () => {
  const pinned = clone(getEmbeddingModel(BGE))
  pinned.files = pinned.files.filter(file => !file.origin)
  const revision = 'b'.repeat(40)
  pinned.sources = {
    modelscope: { repo: 'Xenova/bge-small-zh-v1.5', revision },
    'hf-mirror': { repo: 'Xenova/bge-small-zh-v1.5', revision },
    huggingface: { repo: 'Xenova/bge-small-zh-v1.5', revision },
  }
  const resolved = resolveEmbeddingSources(pinned)
  assert.deepEqual(resolved.sources.map(source => source.provider), ['modelscope', 'hf-mirror', 'huggingface'])
  assert.deepEqual(resolved.skipped, [])
  assert.equal(resolved.sources[1].files[0].url, 'https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/' + revision + '/config.json')
  assert.equal(resolved.sources[2].files[0].url, 'https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/' + revision + '/config.json')
  const onlyHf = resolveEmbeddingSources(pinned, { providers: ['huggingface'] })
  assert.deepEqual(onlyHf.sources.map(source => source.provider), ['huggingface'])
  assert.equal(onlyHf.order.length, 1)
})

test('文件 origin 与来源不一致时该来源不可用，不会拼错 URL', () => {
  const entry = clone(getEmbeddingModel(BGE))
  entry.sources['hf-mirror'] = { repo: 'Xenova/bge-small-zh-v1.5', revision: 'c'.repeat(40) }
  const resolved = resolveEmbeddingSources(entry)
  const skipped = resolved.skipped.find(item => item.provider === 'hf-mirror')
  assert.equal(skipped.reason, 'origin-provider-mismatch')
  assert.equal(skipped.path, '1_Pooling/config.json')
  assert.equal(resolved.sources.length, 1)
})

test('ONNX 图头解析读得出输入输出/dtype/形状/opset 与自包含性', () => {
  const header = readOnnxGraphHeader(tinyOnnxGraph())
  assert.equal(header.irVersion, 6)
  assert.deepEqual(header.opsets, [{ domain: '', version: 11 }])
  assert.deepEqual(header.inputs.map(io => io.name), ['input_ids', 'attention_mask', 'token_type_ids'])
  assert.ok(header.inputs.every(io => io.dtype === 'int64'))
  assert.deepEqual(header.outputs, [{ name: 'last_hidden_state', dtype: 'float32', shape: ['batch_size', 'sequence_length', 8] }])
  assert.equal(header.initializerCount, 1)
  assert.equal(header.externalDataEntries, 0)
  assert.equal(header.selfContained, true)
})

test('ONNX 图头解析拒绝非图字节，也不猜维度', () => {
  assert.throws(() => readOnnxGraphHeader(Buffer.from('definitely not an onnx graph')), error => error.code === 'EMBEDDING_ONNX_INVALID')
  assert.throws(() => readOnnxGraphHeader(Buffer.alloc(0)), error => error.code === 'EMBEDDING_ONNX_INVALID')
  assert.throws(() => readOnnxGraphHeader('string-is-not-a-buffer'), error => error.code === 'EMBEDDING_ONNX_INVALID')
})

test('图输出维度与 manifest 声明不一致时校验失败', () => {
  const entry = clone(getEmbeddingModel(BGE))
  entry.graph.outputs[0].shape = ['batch_size', 'sequence_length', 384]
  const report = validateEmbeddingManifest(entry)
  assert.equal(report.ok, false)
  assert.ok(report.errors.some(item => item.code === 'GRAPH_DIMENSION_MISMATCH'))
})

test("目录条目能映射成向量 profile 描述符，指纹下传不丢字段", () => {
  const entry = getEmbeddingModel(BGE)
  const descriptor = toProfileDescriptor(entry)
  // 这些字段是 lib/vector-profile.js 计算 profile 指纹时读取的集合：
  // 两边必须来自同一份事实，否则安装与迁移会拿两套不可比的 hash 互相判等。
  for (const key of ["id", "model", "repo", "revision", "runtime", "tokenizer", "preprocessing", "pooling", "normalization", "prefixes", "maxTokens", "dimension", "protocol"]) {
    assert.ok(key in descriptor, "descriptor needs " + key)
  }
  assert.equal(descriptor.id, entry.id)
  assert.equal(descriptor.repo, "Xenova/bge-small-zh-v1.5")
  assert.equal(descriptor.revision, BGE_REVISION)
  assert.equal(descriptor.tokenizer, entry.files.find(file => file.role === "tokenizer").sha256)
  assert.equal(descriptor.dimension, 512)
  assert.equal(descriptor.pooling, "cls")
  assert.equal(descriptor.protocol, "dsh-local-embedding-v1")
  assert.equal(descriptor.fingerprint, entry.profileFingerprint)
  assert.equal(descriptor.preprocessing.maxTokens, 512)
})
