import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import {
  FILE_ROLES,
  PROVIDER_ORDER,
  getEmbeddingCatalog,
  getEmbeddingModel,
  prefixesRequireRole,
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
  assert.deepEqual(catalog.map(entry => entry.id), [
    BGE, 'all-minilm-l6-v2-int8', 'multilingual-e5-small', 'qwen3-embedding-0.6b-int8', 'qwen3-embedding-0.6b-q4f16',
  ])
  assert.equal(getEmbeddingModel('nope'), null)
  assert.equal(getEmbeddingModel(undefined), null)
  assert.equal(getEmbeddingModel('../../etc/passwd'), null)
})

test('三个模型的向量空间指纹钉死：改目录必须是有意识地来这里更新', () => {
  assert.deepEqual(
    Object.fromEntries(getEmbeddingCatalog().map(entry => [entry.id, entry.profileFingerprint])),
    {
      'bge-small-zh-v1.5-int8': '47511436d7468fa53b17dbd46d5dfd1454dbca9a70f34dc016c3af0a9decd748',
      'all-minilm-l6-v2-int8': '2ede97e232225e6e6a14d9b0ef870fe8cc5ba5ac6273ae9a6da8263c314b4082',
      'multilingual-e5-small': '4826773bf4a498168decd66edcef48e66befb982c3c60405a1416fb3fd0c5fcb',
      'qwen3-embedding-0.6b-int8': '0934c5b89781cea545ba40f87b1bc0a9e9eb5a95cdde20390953f3642bd386bb',
      'qwen3-embedding-0.6b-q4f16': 'a987005b6c033a3e2fdb7502836d73d6376bf8c15ea3c10be60ea0ca63a0a030',
    },
  )
})

// int8 与 int4 是两种量化、两个向量空间（quantization 进指纹），所以必须是两张卡片、
// 两份 DB，而不是一个条目挂两个图文件让用户以为可以混用。
test('Qwen3 的两张卡片是两个不同的向量空间', () => {
  const int8 = getEmbeddingModel('qwen3-embedding-0.6b-int8')
  const q4 = getEmbeddingModel('qwen3-embedding-0.6b-q4f16')
  assert.notEqual(int8.profileFingerprint, q4.profileFingerprint)
  assert.equal(int8.quantization.weights, 'qint8')
  assert.equal(int8.quantization.scheme, 'dynamic-per-tensor')
  assert.equal(q4.quantization.weights, 'uint4-nbits')
  assert.notEqual(q4.quantization.scheme, int8.quantization.scheme)
  for (const entry of [int8, q4]) {
    assert.equal(entry.availability, 'available', entry.id)
    assert.equal(entry.pooling, 'last', entry.id)
    assert.equal(entry.dimension, 1024, entry.id)
    assert.equal(entry.graph.opset, 21, entry.id)
    // 因果 LM：只有 input_ids + attention_mask，没有 token_type_ids
    assert.deepEqual(entry.graph.inputs.map(io => io.name), ['input_ids', 'attention_mask'], entry.id)
    assert.deepEqual(entry.graph.outputs[0].shape, [1, 'sequence_length', 1024], entry.id)
    // 32k 上下文的制品按 4096 分窗：刻意的延迟策略（不得超过制品上限，那条由下载器的
    // verifyStagedArtifacts 把），窗口本身进指纹所以可复现。
    assert.equal(entry.maxTokens, 4096, entry.id)
    assert.ok(validateEmbeddingManifest(entry).errors.length === 0, entry.id)
  }
  assert.equal(int8.graph.outputs[0].dtype, 'float32')
  assert.equal(q4.graph.outputs[0].dtype, 'float16')
  assert.equal(int8.tier, 'preferred')
  assert.equal(q4.tier, 'optional')
})

// Qwen3 的导出仓库在 ModelScope 上没有对应条目，所以它只能走 huggingface 系：
// 默认镜像站，源站作第二顺位；两者 pin 同一个 commit，落盘都按同一份 sha256 校。
test('Qwen3 卡片的默认来源是 hf-mirror，源站同 commit 可选', () => {
  for (const id of ['qwen3-embedding-0.6b-int8', 'qwen3-embedding-0.6b-q4f16']) {
    const resolved = resolveEmbeddingSources(id)
    assert.deepEqual(resolved.sources.map(source => source.provider), ['hf-mirror', 'huggingface'], id)
    assert.equal(resolved.primary.provider, 'hf-mirror', id + ' 默认必须是镜像站')
    assert.deepEqual(resolved.skipped.map(item => item.provider), ['modelscope'], id)
    assert.equal(resolved.skipped[0].reason, 'not-mapped', id)
    const revision = getEmbeddingModel(id).sources['hf-mirror'].revision
    assert.equal(getEmbeddingModel(id).sources.huggingface.revision, revision, id + ' 两个来源必须同 commit')
    const mirrorGraph = resolved.primary.files.find(file => file.role === 'graph')
    const originGraph = resolveEmbeddingSources(id, { providers: ['huggingface'] }).primary.files.find(file => file.role === 'graph')
    assert.ok(mirrorGraph.url.startsWith('https://hf-mirror.com/n24q02m/'), mirrorGraph.url)
    assert.ok(originGraph.url.startsWith('https://huggingface.co/n24q02m/'), originGraph.url)
    assert.equal(mirrorGraph.sha256, originGraph.sha256, id)
    // 见证制品来自基座仓库，且两个 provider 都合法（否则换源会被 origin 规则整条封掉）
    const pooling = resolveEmbeddingSources(id, { providers: ['huggingface'] }).primary.files.find(file => file.path === '1_Pooling/config.json')
    assert.ok(pooling.url.includes('/Qwen/Qwen3-Embedding-0.6B/'), pooling.url)
    assert.equal(validateEmbeddingManifest(getEmbeddingModel(id)).warnings.filter(item => item.code === 'SOURCE_REVISION_UNPINNED').length, 0, id)
  }
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

test('MiniLM 与 e5 已核实：制品齐全、清单合法、来源可下载', () => {
  for (const id of ['all-minilm-l6-v2-int8', 'multilingual-e5-small']) {
    const entry = getEmbeddingModel(id)
    assert.equal(entry.availability, 'available', id)
    assert.deepEqual(entry.pendingReasons, [], id)
    assert.equal(entry.verification.status, 'verified', id)
    assert.match(entry.sources.modelscope.revision, /^[0-9a-f]{40}$/, id + ' revision')
    assert.equal(entry.dimension, 384, id)
    assert.equal(entry.maxTokens, 512, id)
    assert.equal(entry.pooling, 'mean', id)
    assert.ok(entry.files.length >= 8, id + ' files')
    assert.ok(entry.totalBytes > 0, id)
    assert.equal(entry.graph.outputs[0].shape[2], entry.dimension, id)
    const report = validateEmbeddingManifest(entry)
    assert.deepEqual(report.errors.map(item => item.code), [], id + ' manifest must be installable')
    const resolved = resolveEmbeddingSources(entry)
    assert.equal(resolved.primary.provider, 'modelscope', id)
    assert.equal(resolved.primary.files.length, entry.files.length, id)
    // 见证制品（官方仓库的 1_Pooling）必须来自另一个 repo+revision，而不是冒充导出仓库
    const pooling = resolved.primary.files.find(file => file.path === '1_Pooling/config.json')
    assert.ok(pooling, id + ' needs a pooling witness')
    assert.notEqual(pooling.repo, entry.sources.modelscope.repo, id)
  }
})

test('只有非对称前缀的模型需要角色通道，对称前缀的模型不需要', () => {
  assert.equal(prefixesRequireRole(getEmbeddingModel('bge-small-zh-v1.5-int8')), false)
  assert.equal(prefixesRequireRole(getEmbeddingModel('all-minilm-l6-v2-int8')), false)
  assert.equal(prefixesRequireRole(getEmbeddingModel('multilingual-e5-small')), true)
  // 这条要求必须对用户可见：校验器把它列成警告，而不是静默地把模型标成可用
  const codes = validateEmbeddingManifest(getEmbeddingModel('multilingual-e5-small')).warnings.map(item => item.code)
  assert.ok(codes.includes('PREFIX_ASYMMETRIC'))
  assert.equal(validateEmbeddingManifest(getEmbeddingModel('all-minilm-l6-v2-int8')).warnings
    .some(item => item.code === 'PREFIX_ASYMMETRIC'), false)
})

test('未核实的目录条目依然被挡住：没有文件、没有哈希、理由齐全', () => {
  const pending = clone(getEmbeddingModel('all-minilm-l6-v2-int8'))
  pending.availability = 'pending'
  pending.pendingReasons = ['制品未核实']
  pending.files = []
  pending.totalBytes = 0
  pending.verification = { ...pending.verification, status: 'unverified' }
  delete pending.profileFingerprint
  const withFingerprint = { ...pending, profileFingerprint: profileFingerprint(pending) }
  const report = validateEmbeddingManifest(withFingerprint)
  assert.equal(report.ok, true, 'pending 条目本身结构合法')
  assert.equal(report.errors.length, 0)
  // pending 的原因必须写出来，不能只说「不可用」
  const noReason = { ...withFingerprint, pendingReasons: [] }
  assert.ok(validateEmbeddingManifest(noReason).errors.some(item => item.code === 'PENDING_REASON_MISSING'))
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
