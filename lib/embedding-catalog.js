import crypto from 'node:crypto'

// §14.4 模型目录：只读、无副作用。目录里的每个事实都带来源；没有核实过的制品一律
// availability: 'pending' 且 files: []——绝不写猜测的 bytes/SHA-256（§14.4/§14.12）。
// 这里不做下载、不做安装、不读不写任何 profile/active 状态（那是 embedding-download 与
// 后续迁移模块的事）。

export const CATALOG_SCHEMA_VERSION = 1

// 默认来源顺序；只有 manifest 里显式写了 repo+revision 的来源才会生成 URL。
export const PROVIDER_ORDER = Object.freeze(['modelscope', 'hf-mirror', 'huggingface'])

export const PROVIDERS = Object.freeze({
  modelscope: Object.freeze({
    id: 'modelscope',
    label: 'ModelScope',
    url: ({ repo, revision, path }) => `https://modelscope.cn/api/v1/models/${repo}/repo?Revision=${revision}&FilePath=${encodeURIComponent(path)}`,
  }),
  'hf-mirror': Object.freeze({
    id: 'hf-mirror',
    label: 'hf-mirror',
    url: ({ repo, revision, path }) => `https://hf-mirror.com/${repo}/resolve/${revision}/${encodePath(path)}`,
  }),
  huggingface: Object.freeze({
    id: 'huggingface',
    label: 'Hugging Face',
    url: ({ repo, revision, path }) => `https://huggingface.co/${repo}/resolve/${revision}/${encodePath(path)}`,
  }),
})

export const FILE_ROLES = Object.freeze(['graph', 'config', 'tokenizer', 'tokenizer-config', 'special-tokens', 'vocab', 'quantization', 'pooling-config', 'notice'])

const ONNX_DTYPES = Object.freeze({
  1: 'float32', 2: 'uint8', 3: 'int8', 4: 'uint16', 5: 'int16', 6: 'int32', 7: 'int64',
  8: 'string', 9: 'bool', 10: 'float16', 11: 'double', 12: 'uint32', 13: 'uint64',
})

function encodePath(filePath) {
  return String(filePath).split('/').map(encodeURIComponent).join('/')
}

function sha256Of(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

// 核实证据（2026-10-30）：ModelScope 可直连；huggingface.co 与 hf-mirror.com 在本机
// fetch failed。逐文件 SHA-256 取自 ModelScope 文件清单，并与实际下载的字节复核一致，
// 证据留在 .tmp-local-vector-20261030/probe/。
const BGE_REPO = 'Xenova/bge-small-zh-v1.5'
const BGE_REVISION = '313386ad7ffad360a4870fd1910f8ecaf1a05151'
const BGE_COMMIT_TIME = '2025-07-22T11:41:37.000Z'
const BAAI_REPO = 'BAAI/bge-small-zh-v1.5'
const BAAI_POOLING_REVISION = '8399f11f8da998fe932df2684586c92024219d05'

const rawCatalog = [
  {
    id: 'bge-small-zh-v1.5-int8',
    displayName: 'BGE small zh v1.5 (int8 ONNX)',
    summary: '中文优先的检索小模型；BGE v1.5 检索无需 instruction，CLS pooling + L2 归一化，512 维。',
    languages: ['zh', 'en'],
    tier: 'preferred',
    availability: 'available',
    pendingReasons: [],
    parameters: 24000000,
    parameterSource: 'BAAI 官方模型页 24M（docs/local-vector-construction.md §14.4 引用）',
    dimension: 512,
    maxTokens: 512,
    pooling: 'cls',
    normalization: 'l2',
    prefixes: { query: '', document: '' },
    quantization: {
      weights: 'qint8',
      scheme: 'dynamic-per-channel',
      reduceRange: true,
      source: 'quantize_config.json(per_channel=true, reduce_range=true, weight_type=QInt8) + 图内 MatMulInteger/DynamicQuantizeLinear',
    },
    runtime: {
      engine: 'onnxruntime-node',
      version: '1.31.1',
      abi: 'napi-v6',
      os: 'win32',
      arch: 'x64',
      verified: true,
      tokenizer: { name: '@huggingface/tokenizers', version: '0.2.0', license: 'Apache-2.0', sha256: 'f6b9849b58de625c4fd79583242dd4506914b92082f9af17719d39416658ef24' },
      packages: [
        { name: 'onnxruntime-node', version: '1.31.1', license: 'MIT', sha256: '41aedb3e877786245ab4dc0f533cda63f7d971b5c5fec171eafca9fb9572a8d5' },
        { name: 'onnxruntime-common', version: '1.31.1', license: 'MIT', sha256: 'c8e59240260cd3d230f1417765e0dbe098323ef65a5785991059de1bd5d7cde0' },
      ],
      note: '隔离目录真实 ORT CPU 加载/推理 smoke 已核实；仅允许固定版本，不隐式下载。',
      // 受管安装事实（2026-10-30）：三个 npm tarball 本轮真实下载并核对 sha256/bytes；
      // 解包后的最小运行时树跑通真实 /v1/embeddings 推理（512 维、worker ready ≈559ms）。
      // 只允许从这些 URL 下载并按下面的 hash 校验；没有 hash 或没有该平台原生库一律拒绝安装。
      install: {
        scope: 'per-user-managed',
        layout: 'node_modules',
        postinstall: 'never-run',
        verifiedAt: '2026-10-30T03:45:00.000Z',
        verifiedOn: 'win32-x64',
        platforms: {
          'win32-x64': 'smoke-verified',
          'win32-arm64': 'artifact-pinned',
          'linux-x64': 'artifact-pinned',
          'linux-arm64': 'artifact-pinned',
          'darwin-arm64': 'artifact-pinned',
        },
        evidence: 'npm tarball sha256 与 registry integrity 双向一致；解包最小树真实推理通过；原生库逐文件 sha256 取自同一棵已核实树',
      },
      artifacts: [
        {
          name: 'onnxruntime-node', version: '1.31.1', license: 'MIT',
          url: 'https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.31.1.tgz',
          bytes: 115391311,
          sha256: 'd7a3de2b1bba92614abc74af909cc0ba4f4dd5347735418794edeb58cfef2d22',
          integrity: 'sha512-ijnSghbDHVWaQ2nDPmVccPlCHI8kH1Mx1aJ4a/qzRP16bBcVs4E3EqZQKZCkhWnbqN1tuQWxagimFtDpbPYYQw==',
          extract: ['package.json', 'README.md', 'dist', 'lib', 'bin/napi-v6/<platform>'],
        },
        {
          name: 'onnxruntime-common', version: '1.31.1', license: 'MIT',
          url: 'https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.31.1.tgz',
          bytes: 72322,
          sha256: '967acac0c2a22122461e526aeda07305da7289d94f276920d8a6919483f07bfc',
          integrity: 'sha512-F+nnYNiQtmNJ95V6R/isBJqiVpdANCrsMEg1OaF+Bkbl3GAtzWLR7Ng17Ld0QtYtYJyotOHPJzOQn1Y6PLZjpg==',
          extract: ['package.json', 'README.md', 'dist', 'lib'],
        },
        {
          name: '@huggingface/tokenizers', version: '0.2.0', license: 'Apache-2.0',
          url: 'https://registry.npmjs.org/@huggingface/tokenizers/-/tokenizers-0.2.0.tgz',
          bytes: 87011,
          sha256: '2800014c83b8186b2e4210c20672f1fb65a12cef85d7e95e0f2003e022611b4a',
          integrity: 'sha512-LidMHe1FpcSYH4vcSjXooda34pC0M8m1gmDOv7SQi6Iv+ib1zX7J3sHBCC9/3FPCkn2k1b55FneVqMRxrr99pg==',
          extract: ['package.json', 'README.md', 'LICENSE', 'dist', 'types'],
        },
      ],
      // 解包后的 package.json 事实（字节数 + sha256）：用于确认解出来的就是 pin 住的版本。
      packageFiles: [
        { package: 'onnxruntime-node', bytes: 1593, sha256: '41aedb3e877786245ab4dc0f533cda63f7d971b5c5fec171eafca9fb9572a8d5' },
        { package: 'onnxruntime-common', bytes: 977, sha256: 'c8e59240260cd3d230f1417765e0dbe098323ef65a5785991059de1bd5d7cde0' },
        { package: '@huggingface/tokenizers', bytes: 1965, sha256: 'f6b9849b58de625c4fd79583242dd4506914b92082f9af17719d39416658ef24' },
      ],
      // 判分/加载必需的原生库逐文件 hash。没有列出原生库的平台不得安装（不允许猜）。
      native: {
        'win32-x64': [
          { path: 'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node', bytes: 358200, sha256: '8d9f996ff7dcc60c4899aa87aa7abe07d806f9c314882f44a001d0fd8a23d16f' },
          { path: 'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll', bytes: 31736672, sha256: 'beb6e1edba0e74c132453fe4df113da2ea2b99ef8ea7dfc25696a872efd11c45' },
          { path: 'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/DirectML.dll', bytes: 18527544, sha256: 'd16be72fa002dd610cca93e376f0ef44865dfce43de4b7bf9738af22534f7a9d' },
          { path: 'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/dxcompiler.dll', bytes: 17986400, sha256: '430eed027979399769a325b60319aca4e4afa4daebe475d3c763dcf2a0190a72' },
        ],
        'win32-arm64': [
          { path: 'node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/onnxruntime_binding.node', bytes: 504160, sha256: '6f34d4635793371c85e5260dbdc0864c2ef62ccfcb1f439afa3501ba6f8d530d' },
          { path: 'node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/onnxruntime.dll', bytes: 32835936, sha256: '14d1cd398fa5bc8b5c61bdfba899f17b40550012ec2884955ce656a5d8a8ff77' },
          { path: 'node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/DirectML.dll', bytes: 18444600, sha256: '4bb0639eb23a02de2c5f1eddd117f13330819f55b556e8c75068b68ad1a3516e' },
          { path: 'node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/dxcompiler.dll', bytes: 22285624, sha256: '4a77bcadf4d437ad50d10517bb0b4a5a4c2fc84b1fde4d1cf5a5abe9e2dce431' },
        ],
        'linux-x64': [
          { path: 'node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node', bytes: 519712, sha256: 'e3a108803b8bd33c8e9691b52921c37bede7a6886251aa41219f053d268ee231' },
          { path: 'node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1', bytes: 47552704, sha256: 'f19a4da48c4c65e0cdccff82354482f657fa91a3455b66174195b94ca55b0e6f' },
        ],
        'linux-arm64': [
          { path: 'node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/onnxruntime_binding.node', bytes: 551752, sha256: '5d943f6bf8f65c40213bac636f19bcb227ee1d188417c4b6a6f70062579cfb84' },
          { path: 'node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/libonnxruntime.so.1', bytes: 25266408, sha256: '152fb7d2f4f06acc5a38627fbca3e56ba2a9b984cb060d2ac500ac272afbb9ba' },
        ],
        'darwin-arm64': [
          { path: 'node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node', bytes: 323512, sha256: '95ab5698fbcb34d035ea98266156ad5a06b76d0ee739ea42d660df6901df390a' },
          { path: 'node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib', bytes: 45331560, sha256: '9a362365243b56da98a2ad65128a32d6f8066d1f39ce697e0fce997adf0586dc' },
          { path: 'node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.31.1.dylib', bytes: 45331560, sha256: '9a362365243b56da98a2ad65128a32d6f8066d1f39ce697e0fce997adf0586dc' },
        ],
      },
    },
    license: {
      base: { id: 'mit', source: 'ModelScope BAAI/bge-small-zh-v1.5 的 License 字段 = mit（2026-10-30 只读核对）' },
      onnxExport: { id: 'undeclared', source: 'ModelScope Xenova/bge-small-zh-v1.5 的 License 字段为空，ONNX 导出未单独声明许可（2026-10-30 核对）' },
    },
    verification: {
      status: 'verified',
      method: 'sha256+onnx-header',
      checkedAt: '2026-10-30T00:20:00.000Z',
      scope: '逐文件 bytes/sha256 复核 + ONNX 图头（opset/输入输出/dtype/形状/自包含）+ config/tokenizer 解析',
      evidence: '.tmp-local-vector-20261030/probe/ 下的实测文件，sha256 与 ModelScope 清单逐字节一致',
      notVerified: ['huggingface/hf-mirror 上的对应 commit'],
    },
    sources: {
      modelscope: { repo: BGE_REPO, revision: BGE_REVISION, revisionVerified: true, commitTime: BGE_COMMIT_TIME },
      'hf-mirror': { repo: BGE_REPO, revision: null, revisionVerified: false, note: 'hf-mirror.com 本机不可达，commit 未核实；不生成 URL' },
      huggingface: { repo: BGE_REPO, revision: null, revisionVerified: false, note: 'huggingface.co 本机不可达，commit 未核实；不生成 URL' },
    },
    witness: {
      provider: 'modelscope',
      repo: BAAI_REPO,
      revision: BAAI_POOLING_REVISION,
      path: '1_Pooling/config.json',
      bytes: 190,
      sha256: 'aaa8861589f80c961a03cc86c7eeaef7605c1676b9ab55329d33a304738769c6',
      purpose: 'pooling 事实来源：pooling_mode_cls_token=true、word_embedding_dimension=512',
    },
    graph: {
      path: 'onnx/model_quantized.onnx',
      opset: 11,
      producer: 'onnx.quantize',
      producerVersion: '0.1.0',
      selfContained: true,
      externalData: [],
      inputs: [
        { name: 'input_ids', dtype: 'int64', shape: ['batch_size', 'sequence_length'] },
        { name: 'attention_mask', dtype: 'int64', shape: ['batch_size', 'sequence_length'] },
        { name: 'token_type_ids', dtype: 'int64', shape: ['batch_size', 'sequence_length'] },
      ],
      outputs: [{ name: 'last_hidden_state', dtype: 'float32', shape: ['batch_size', 'sequence_length', 512] }],
    },
    files: [
      { path: 'config.json', role: 'config', bytes: 716, sha256: 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f' },
      { path: 'tokenizer.json', role: 'tokenizer', bytes: 439125, sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26' },
      { path: 'tokenizer_config.json', role: 'tokenizer-config', bytes: 367, sha256: 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a' },
      { path: 'special_tokens_map.json', role: 'special-tokens', bytes: 125, sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3' },
      { path: 'vocab.txt', role: 'vocab', bytes: 109540, sha256: '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c' },
      { path: 'onnx/model_quantized.onnx', role: 'graph', bytes: 24010842, sha256: '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc' },
      { path: 'quantize_config.json', role: 'quantization', bytes: 674, sha256: '2cc488b20fa05fe86aba2fdc2be44d24827e11e2b7c7a0753d1427da6797b46f' },
      { path: 'README.md', role: 'notice', bytes: 1057, sha256: 'cb22054df1a98f7ee9d5b281d023e67c27cc316e1733baf03fc994d95c3048ab' },
      {
        path: '1_Pooling/config.json',
        role: 'pooling-config',
        bytes: 190,
        sha256: 'aaa8861589f80c961a03cc86c7eeaef7605c1676b9ab55329d33a304738769c6',
        origin: { provider: 'modelscope', repo: BAAI_REPO, revision: BAAI_POOLING_REVISION },
      },
    ],
  },
  {
    id: 'all-minilm-l6-v2-int8',
    displayName: 'all-MiniLM-L6-v2 (int8 ONNX)',
    summary: '英文句子相似度小模型；不是中文模型的等价替代（§14.4）。',
    languages: ['en'],
    tier: 'optional',
    availability: 'pending',
    pendingReasons: [
      'ONNX 制品尺寸/hash 未核实（本包只核实首个 BGE 制品）',
      '官方 wrapper 常用上限 256，不能按底座 512 推定，需在 config/tokenizer/实际输出三处确认',
      'huggingface/hf-mirror 在本机不可达，未取得固定 commit',
    ],
    parameters: 22000000,
    parameterSource: '约 22M（§14.4 候选值，未复核）',
    dimension: 384,
    maxTokens: null,
    pooling: 'mean',
    normalization: 'l2',
    prefixes: { query: '', document: '' },
    quantization: { weights: 'qint8', scheme: 'unknown', reduceRange: null, source: '未核实' },
    runtime: { engine: 'onnxruntime-node', version: null, abi: 'napi-v6', os: 'win32', arch: 'x64', verified: false, note: '同 BGE：ORT 未实测' },
    license: {
      base: { id: 'apache-2.0', source: 'ModelScope Xenova/all-MiniLM-L6-v2 的 License = apache-2.0（2026-10-30 只读核对）' },
      onnxExport: { id: 'undeclared', source: 'ONNX 导出未单独声明许可' },
    },
    verification: { status: 'unverified', method: null, checkedAt: null, scope: '仅候选条目；没有可下载制品', evidence: null, notVerified: ['全部制品'] },
    sources: {
      modelscope: { repo: 'Xenova/all-MiniLM-L6-v2', revision: null, revisionVerified: false, note: '候选来源，未固定 commit' },
      'hf-mirror': { repo: 'Xenova/all-MiniLM-L6-v2', revision: null, revisionVerified: false, note: '未核实' },
      huggingface: { repo: 'sentence-transformers/all-MiniLM-L6-v2', revision: null, revisionVerified: false, note: '未核实' },
    },
    graph: null,
    files: [],
  },
  {
    id: 'multilingual-e5-small',
    displayName: 'multilingual-e5-small（待适配，初版不启用）',
    summary: '多语言（约 118M），需要 query/passage 前缀；当前请求通道无 role 字段，不能靠文本猜角色（§14.4）。',
    languages: ['zh', 'en', 'multilingual'],
    tier: 'deferred',
    availability: 'pending',
    pendingReasons: [
      '需要 query/passage 前缀，当前请求通道无 role 字段，不能安全启用',
      '长度/量化/许可证制品均未核实',
      '约 118M，int8 理论约 118 MB，不是 22–24M 级',
    ],
    parameters: 118000000,
    parameterSource: '§14.4 E5 作者模型表',
    dimension: 384,
    maxTokens: null,
    pooling: 'mean',
    normalization: 'l2',
    prefixes: { query: 'query: ', document: 'passage: ' },
    quantization: { weights: 'qint8', scheme: 'unknown', reduceRange: null, source: '未核实' },
    runtime: { engine: 'onnxruntime-node', version: null, abi: 'napi-v6', os: 'win32', arch: 'x64', verified: false, note: '同 BGE：ORT 未实测' },
    license: {
      base: { id: 'unverified', source: '模型卡许可未核实（§14.4/§14.12）' },
      onnxExport: { id: 'undeclared', source: '无已核实导出' },
    },
    verification: { status: 'unverified', method: null, checkedAt: null, scope: '仅目录占位；初版不启用', evidence: null, notVerified: ['全部制品'] },
    sources: {
      modelscope: { repo: 'intfloat/multilingual-e5-small', revision: null, revisionVerified: false, note: '候选来源，未固定 commit' },
      'hf-mirror': { repo: 'intfloat/multilingual-e5-small', revision: null, revisionVerified: false, note: '未核实' },
      huggingface: { repo: 'intfloat/multilingual-e5-small', revision: null, revisionVerified: false, note: '未核实' },
    },
    graph: null,
    files: [],
  },
]

/**
 * profile fingerprint：任何会改变向量空间的字段（模型/revision/量化/pooling/tokenizer/
 * 前缀/维度/分窗）都必须进指纹（§14.8）。
 */
export function profileFingerprint(entry) {
  const files = Array.isArray(entry?.files) ? entry.files : []
  const graphFile = files.find(file => file.role === 'graph') || null
  const tokenizerFile = files.find(file => file.role === 'tokenizer') || null
  const sources = entry?.sources && typeof entry.sources === 'object' ? entry.sources : {}
  const primary = PROVIDER_ORDER.map(id => sources[id]).find(source => source && typeof source.revision === 'string') || null
  return sha256Of(canonical({
    schema: CATALOG_SCHEMA_VERSION,
    id: entry?.id ?? null,
    repo: primary?.repo ?? null,
    revision: primary?.revision ?? null,
    dimension: entry?.dimension ?? null,
    maxTokens: entry?.maxTokens ?? null,
    pooling: entry?.pooling ?? null,
    normalization: entry?.normalization ?? null,
    prefixes: entry?.prefixes ?? null,
    quantization: entry?.quantization ? { weights: entry.quantization.weights, scheme: entry.quantization.scheme } : null,
    graph: graphFile ? graphFile.sha256 : null,
    tokenizer: tokenizerFile ? tokenizerFile.sha256 : null,
    runtime: entry?.runtime ? { engine: entry.runtime.engine, abi: entry.runtime.abi, version: entry.runtime.version, os: entry.runtime.os, arch: entry.runtime.arch } : null,
    files: files.map(({ path, role, bytes, sha256 }) => ({ path, role, bytes, sha256 })).sort((a, b) => a.path.localeCompare(b.path)),
    graphProtocol: entry?.graph ?? null,
    tokenizerProtocol: entry?.tokenizer ?? null,
    preprocessing: entry?.preprocessing ?? null,
    windowing: entry?.windowing ?? null,
    aggregation: entry?.aggregation ?? null,
    protocol: entry?.protocol ?? 'dsh-local-embedding-v1',
  }))
}

const catalog = deepFreeze(rawCatalog.map(entry => ({
  ...entry,
  schema: CATALOG_SCHEMA_VERSION,
  totalBytes: (entry.files || []).reduce((sum, file) => sum + (Number.isFinite(file.bytes) ? file.bytes : 0), 0),
  profileFingerprint: profileFingerprint(entry),
})))

/**
 * 把目录条目映射成"向量 profile 描述符"（供 lib/vector-profile.js 之类模块计算/比较指纹）。
 * 目的：一处是模型事实（catalog），另一处是激活状态（profile），两边必须用同一份指纹，
 * 否则安装/迁移会拿两套不可比的 hash 互相判等。这里只做映射，不读写任何 active 状态。
 */
export function toProfileDescriptor(entry) {
  const files = Array.isArray(entry?.files) ? entry.files : []
  const tokenizerFile = files.find(file => file.role === "tokenizer") || null
  const sources = entry?.sources && typeof entry.sources === "object" ? entry.sources : {}
  const primary = PROVIDER_ORDER.map(id => sources[id]).find(source => source && typeof source.revision === "string") || null
  const runtime = entry?.runtime || {}
  return {
    id: entry?.id ?? "",
    model: entry?.id ?? "",
    repo: primary?.repo ?? "",
    revision: primary?.revision ?? "",
    runtime: runtime.version ? `${runtime.engine}@${runtime.version}` : String(runtime.engine || ""),
    tokenizer: tokenizerFile ? tokenizerFile.sha256 : null,
    preprocessing: {
      pooling: entry?.pooling ?? null,
      normalization: entry?.normalization ?? null,
      prefixes: entry?.prefixes ?? null,
      maxTokens: entry?.maxTokens ?? null,
      truncation: "keep-head",
    },
    pooling: entry?.pooling ?? "",
    normalization: entry?.normalization ?? "",
    prefixes: entry?.prefixes ?? null,
    maxTokens: entry?.maxTokens ?? null,
    dimension: entry?.dimension ?? null,
    protocol: "dsh-local-embedding-v1",
    fingerprint: entry?.profileFingerprint ?? null,
  }
}

/** 只读目录快照；返回冻结数组，调用方改不到目录本体。 */
export function getEmbeddingCatalog() {
  return catalog
}

/** 按稳定 id 取单个模型；未知 id 返回 null（不猜测、不回退默认模型）。 */
export function getEmbeddingModel(id) {
  if (typeof id !== 'string') return null
  return catalog.find(entry => entry.id === id) || null
}

// ---------------------------------------------------------------- ONNX 图头

function readVarint(buffer, offset) {
  let result = 0
  let shift = 0
  let position = offset
  for (;;) {
    if (position >= buffer.length) throw new Error('truncated varint')
    const byte = buffer[position++]
    result += (byte & 0x7f) * Math.pow(2, shift)
    shift += 7
    if ((byte & 0x80) === 0) break
    if (shift > 56) throw new Error('varint too long')
  }
  return [result, position]
}

function readFields(buffer) {
  const fields = []
  let position = 0
  while (position < buffer.length) {
    let key
    const keyRead = readVarint(buffer, position)
    key = keyRead[0]
    position = keyRead[1]
    const number = key >>> 3
    const wire = key & 7
    if (number === 0) throw new Error('invalid field number')
    if (wire === 0) {
      const valueRead = readVarint(buffer, position)
      position = valueRead[1]
      fields.push({ number, wire, value: valueRead[0] })
    } else if (wire === 2) {
      const lengthRead = readVarint(buffer, position)
      position = lengthRead[1]
      const length = lengthRead[0]
      if (position + length > buffer.length) throw new Error('length-prefixed field overruns buffer')
      fields.push({ number, wire, value: buffer.subarray(position, position + length) })
      position += length
    } else if (wire === 5) {
      if (position + 4 > buffer.length) throw new Error('truncated fixed32')
      fields.push({ number, wire, value: buffer.subarray(position, position + 4) })
      position += 4
    } else if (wire === 1) {
      if (position + 8 > buffer.length) throw new Error('truncated fixed64')
      fields.push({ number, wire, value: buffer.subarray(position, position + 8) })
      position += 8
    } else {
      throw new Error(`unsupported wire type ${wire}`)
    }
  }
  return fields
}

function textOf(field) {
  return field && Buffer.isBuffer(field.value) ? field.value.toString('utf8') : ''
}

function valueInfo(buffer) {
  const info = readFields(buffer)
  const name = textOf(info.find(field => field.number === 1))
  const typeField = info.find(field => field.number === 2)
  let dtype = null
  let shape = null
  if (typeField) {
    const tensorType = readFields(typeField.value).find(field => field.number === 1)
    if (tensorType) {
      const tensor = readFields(tensorType.value)
      const elemType = tensor.find(field => field.number === 1)
      if (elemType) dtype = ONNX_DTYPES[elemType.value] || `elem_type_${elemType.value}`
      const shapeField = tensor.find(field => field.number === 2)
      if (shapeField) {
        shape = readFields(shapeField.value)
          .filter(field => field.number === 1)
          .map(dimField => {
            const dim = readFields(dimField.value)
            const dimValue = dim.find(field => field.number === 1)
            if (dimValue) return dimValue.value
            const dimParam = dim.find(field => field.number === 2)
            return dimParam ? textOf(dimParam) : '?'
          })
      }
    }
  }
  return { name, dtype, shape }
}

/**
 * 只读解析 ONNX 图头：opset、生产者、输入/输出名与 dtype/形状、initializer 体积、
 * 是否引用 external_data。不执行图、不需要 onnxruntime（§14.4 第 1/2 条）。
 */
export function readOnnxGraphHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    const error = new Error('ONNX artifact is empty or too small to be a graph')
    error.code = 'EMBEDDING_ONNX_INVALID'
    throw error
  }
  try {
    const model = readFields(buffer)
    const graphField = model.find(field => field.number === 7)
    if (!graphField) {
      const error = new Error('ONNX artifact has no graph field')
      error.code = 'EMBEDDING_ONNX_INVALID'
      throw error
    }
    const graph = readFields(graphField.value)
    const initializers = graph.filter(field => field.number === 5)
    let initializerBytes = 0
    let externalDataEntries = 0
    for (const initializer of initializers) {
      const tensor = readFields(initializer.value)
      const raw = tensor.find(field => field.number === 9)
      if (raw) initializerBytes += raw.value.length
      externalDataEntries += tensor.filter(field => field.number === 13).length
    }
    return {
      irVersion: model.find(field => field.number === 1)?.value ?? null,
      producer: textOf(model.find(field => field.number === 2)) || null,
      producerVersion: textOf(model.find(field => field.number === 3)) || null,
      opsets: model.filter(field => field.number === 8).map(field => {
        const opset = readFields(field.value)
        return { domain: textOf(opset.find(item => item.number === 1)), version: opset.find(item => item.number === 2)?.value ?? null }
      }),
      inputs: graph.filter(field => field.number === 11).map(field => valueInfo(field.value)),
      outputs: graph.filter(field => field.number === 12).map(field => valueInfo(field.value)),
      initializerCount: initializers.length,
      initializerBytes,
      externalDataEntries,
      selfContained: externalDataEntries === 0 && initializerBytes > 0,
    }
  } catch (error) {
    if (error?.code === 'EMBEDDING_ONNX_INVALID') throw error
    const wrapped = new Error(`cannot parse ONNX graph header: ${error?.message || error}`)
    wrapped.code = 'EMBEDDING_ONNX_INVALID'
    throw wrapped
  }
}

// ---------------------------------------------------------------- manifest 校验

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isSafeRelativePath(filePath) {
  if (typeof filePath !== 'string' || !filePath || filePath.length > 240) return false
  if (filePath.includes('\\') || filePath.includes('\u0000')) return false
  if (filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath)) return false
  return filePath.split('/').every(segment => segment && segment !== '.' && segment !== '..')
}

/**
 * 校验 manifest/目录条目。返回 { ok, errors, warnings }：errors 是"不可下载/不可安装"，
 * warnings 是"可以下载但必须如实展示"（例如 ONNX 导出未单独声明许可、ORT 版本未实测）。
 */
export function validateEmbeddingManifest(manifest) {
  const errors = []
  const warnings = []
  const error = (code, message) => errors.push({ code, message })
  const warn = (code, message) => warnings.push({ code, message })

  if (!isPlainObject(manifest)) {
    error('MANIFEST_NOT_OBJECT', 'manifest must be a plain object')
    return { ok: false, errors, warnings }
  }
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(String(manifest.id || ''))) error('ID_INVALID', 'id must be a stable lowercase slug')
  if (typeof manifest.displayName !== 'string' || !manifest.displayName.trim()) error('DISPLAY_NAME_MISSING', 'displayName is required')
  if (!Array.isArray(manifest.languages) || !manifest.languages.length) error('LANGUAGES_INVALID', 'languages must be a non-empty array')

  const license = manifest.license
  if (!isPlainObject(license) || !isPlainObject(license.base) || typeof license.base.id !== 'string' || !license.base.id) {
    error('LICENSE_MISSING', 'license.base.id and its source are required (§14.4)')
  } else if (license.base.id === 'unverified' && manifest.availability === 'available') {
    error('LICENSE_UNVERIFIED', 'an available artifact must have a verified license')
  }
  if (isPlainObject(license) && isPlainObject(license.onnxExport) && !['declared', 'mit', 'apache-2.0'].includes(license.onnxExport.id)) {
    warn('LICENSE_DERIVATIVE_UNDECLARED', 'ONNX export license is not separately declared; show it as undeclared instead of inheriting the code licence')
  }

  if (!Number.isFinite(manifest.parameters) || manifest.parameters <= 0) error('PARAMETERS_INVALID', 'parameters must be a positive number')
  if (!Number.isInteger(manifest.dimension) || manifest.dimension < 1 || manifest.dimension > 8192) error('DIMENSION_INVALID', 'dimension must be an integer in 1..8192')
  if (!(manifest.maxTokens === null || (Number.isInteger(manifest.maxTokens) && manifest.maxTokens >= 32 && manifest.maxTokens <= 8192))) {
    error('MAX_TOKENS_INVALID', 'maxTokens must be null (unverified) or an integer in 32..8192')
  }
  if (!['cls', 'mean', 'max'].includes(manifest.pooling)) error('POOLING_INVALID', 'pooling must be cls/mean/max')
  if (!['l2', 'none'].includes(manifest.normalization)) error('NORMALIZATION_INVALID', 'normalization must be l2/none')
  if (!isPlainObject(manifest.prefixes) || typeof manifest.prefixes.query !== 'string' || typeof manifest.prefixes.document !== 'string') {
    error('PREFIXES_INVALID', 'prefixes.query/document must be strings (empty is allowed)')
  }

  const sources = manifest.sources
  if (!isPlainObject(sources) || !Object.keys(sources).length) error('SOURCES_MISSING', 'sources must map providers to explicit repo/revision')
  let pinnedSources = 0
  for (const provider of Object.keys(sources || {})) {
    const source = sources[provider]
    if (!PROVIDERS[provider]) { error('SOURCE_PROVIDER_UNKNOWN', `unknown provider ${provider}`); continue }
    if (!isPlainObject(source)) { error('SOURCE_INVALID', `source ${provider} must be an object`); continue }
    if (typeof source.repo !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(source.repo)) {
      error('SOURCE_REPO_INVALID', `source ${provider}.repo must be owner/name`)
    }
    if (source.revision === null) {
      warn('SOURCE_REVISION_UNPINNED', `source ${provider} has no pinned revision; no URL may be derived from it`)
    } else if (typeof source.revision !== 'string' || !/^[0-9a-f]{40}$/.test(source.revision)) {
      error('SOURCE_REVISION_INVALID', `source ${provider}.revision must be a 40-char lowercase commit sha`)
    } else {
      pinnedSources++
    }
  }

  if (manifest.availability === 'available') {
    if (!pinnedSources) error('SOURCE_NOT_PINNED', 'an available artifact needs at least one provider with an explicit pinned revision')
    if (!isPlainObject(manifest.verification) || manifest.verification.status !== 'verified') {
      error('VERIFICATION_MISSING', 'an available artifact must carry verification.status = verified')
    } else {
      if (typeof manifest.verification.method !== 'string' || !manifest.verification.method) error('VERIFICATION_METHOD_MISSING', 'verification.method is required')
      if (typeof manifest.verification.checkedAt !== 'string' || Number.isNaN(Date.parse(manifest.verification.checkedAt))) {
        error('VERIFICATION_TIME_INVALID', 'verification.checkedAt must be an ISO timestamp')
      }
    }
  } else if (!Array.isArray(manifest.pendingReasons) || !manifest.pendingReasons.length) {
    error('PENDING_REASON_MISSING', 'a non-available model must state why it is pending')
  }

  const runtime = manifest.runtime
  if (!isPlainObject(runtime) || typeof runtime.engine !== 'string' || typeof runtime.abi !== 'string' || typeof runtime.os !== 'string' || typeof runtime.arch !== 'string') {
    error('RUNTIME_INVALID', 'runtime.engine/abi/os/arch are required (§14.4)')
  } else if (runtime.version === null) {
    warn('RUNTIME_VERSION_UNPINNED', 'runtime version is not pinned yet; enabling the profile must stay blocked until ORT is verified')
  }

  const files = manifest.files
  if (!Array.isArray(files)) {
    error('FILES_INVALID', 'files must be an array')
  } else {
    if (manifest.availability === 'available' && !files.length) error('FILES_MISSING', 'an available artifact must list its files')
    const seen = new Set()
    for (const file of files) {
      if (!isPlainObject(file)) { error('FILE_INVALID', 'each file must be an object'); continue }
      if (!isSafeRelativePath(file.path)) error('FILE_PATH_UNSAFE', `unsafe file path: ${JSON.stringify(file.path)}`)
      if (seen.has(file.path)) error('FILE_DUPLICATE', `duplicate file path ${file.path}`)
      seen.add(file.path)
      if (!Number.isInteger(file.bytes) || file.bytes < 0) error('FILE_BYTES_INVALID', `file ${file.path} needs exact bytes`)
      if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) error('FILE_SHA256_INVALID', `file ${file.path} needs a lowercase sha256`)
      if (!FILE_ROLES.includes(file.role)) error('FILE_ROLE_INVALID', `file ${file.path} has unknown role ${file.role}`)
      if (file.origin !== undefined) {
        const origin = file.origin
        if (!isPlainObject(origin) || !PROVIDERS[origin.provider] || typeof origin.repo !== 'string' || !/^[0-9a-f]{40}$/.test(String(origin.revision))) {
          error('FILE_ORIGIN_INVALID', `file ${file.path} origin must pin provider/repo/revision`)
        }
      }
    }
    const graphs = files.filter(file => file.role === 'graph')
    if (manifest.availability === 'available' && graphs.length !== 1) error('GRAPH_MISSING', 'exactly one file must have role graph')
    for (const graphFile of graphs) if (!String(graphFile.path || '').endsWith('.onnx')) error('GRAPH_NOT_ONNX', `graph file must be .onnx: ${graphFile.path}`)

    if (manifest.totalBytes !== undefined) {
      const actual = files.reduce((sum, file) => sum + (Number.isFinite(file.bytes) ? file.bytes : 0), 0)
      if (manifest.totalBytes !== actual) error('TOTAL_BYTES_MISMATCH', `totalBytes ${manifest.totalBytes} does not equal the sum of files ${actual}`)
    }
  }

  const graph = manifest.graph
  if (manifest.availability === 'available') {
    if (!isPlainObject(graph)) {
      error('GRAPH_DESCRIPTOR_MISSING', 'graph descriptor (inputs/outputs/dtype) is required')
    } else {
      if (!Array.isArray(graph.inputs) || !graph.inputs.length || !Array.isArray(graph.outputs) || !graph.outputs.length) {
        error('GRAPH_IO_INVALID', 'graph.inputs/outputs must be non-empty arrays')
      }
      for (const io of [...(graph.inputs || []), ...(graph.outputs || [])]) {
        if (!isPlainObject(io) || typeof io.name !== 'string' || !io.name || typeof io.dtype !== 'string' || !io.dtype) {
          error('GRAPH_IO_INVALID', 'each graph input/output needs name and dtype')
        }
      }
      const output = (graph.outputs || [])[0]
      const last = Array.isArray(output?.shape) ? output.shape[output.shape.length - 1] : null
      if (Number.isInteger(manifest.dimension) && last !== manifest.dimension) {
        error('GRAPH_DIMENSION_MISMATCH', `graph output last dim ${last} does not match dimension ${manifest.dimension}`)
      }
      if (Array.isArray(graph.externalData) && graph.externalData.length && graph.selfContained !== false) {
        error('GRAPH_EXTERNAL_DATA_UNDECLARED', 'external data references must be listed and selfContained=false')
      }
    }
  }

  const graphFileInFiles = Array.isArray(files) ? files.find(file => file.role === 'graph') : null
  if (isPlainObject(graph) && graphFileInFiles && graph.path !== graphFileInFiles.path) {
    error('GRAPH_PATH_MISMATCH', `graph.path ${graph.path} must equal the graph file ${graphFileInFiles.path}`)
  }

  if (manifest.profileFingerprint !== undefined) {
    const expected = profileFingerprint(manifest)
    if (manifest.profileFingerprint !== expected) error('FINGERPRINT_MISMATCH', `profileFingerprint ${manifest.profileFingerprint} does not match the profile ${expected}`)
  }

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * 只按 manifest 里显式写明的 repo+revision 生成 URL（§14.4）。默认顺序
 * modelscope → hf-mirror → huggingface；没有固定 revision 的来源不生成任何 URL，
 * 而是列进 skipped 并写明原因。
 */
export function resolveEmbeddingSources(idOrEntry, options = {}) {
  const entry = typeof idOrEntry === 'string' ? getEmbeddingModel(idOrEntry) : idOrEntry
  if (!isPlainObject(entry)) {
    const error = new Error(`unknown embedding model: ${String(idOrEntry)}`)
    error.code = 'EMBEDDING_MODEL_UNKNOWN'
    throw error
  }
  const providers = Array.isArray(options.providers) && options.providers.length ? options.providers : PROVIDER_ORDER
  const files = Array.isArray(entry.files) ? entry.files : []
  const skipped = []
  const sources = []

  for (const providerId of providers) {
    if (!PROVIDERS[providerId]) {
      skipped.push({ provider: providerId, reason: 'provider-unknown' })
      continue
    }
    const source = isPlainObject(entry.sources) ? entry.sources[providerId] : null
    if (!isPlainObject(source)) { skipped.push({ provider: providerId, reason: 'not-mapped' }); continue }
    if (typeof source.revision !== 'string' || !/^[0-9a-f]{40}$/.test(source.revision)) {
      skipped.push({ provider: providerId, reason: 'revision-unpinned', repo: source.repo || null })
      continue
    }
    if (typeof source.repo !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(source.repo)) {
      skipped.push({ provider: providerId, reason: 'repo-invalid' })
      continue
    }
    const fileUrls = []
    let blocked = null
    for (const file of files) {
      const origin = file.origin
      if (origin && origin.provider !== providerId) {
        blocked = { provider: providerId, reason: 'origin-provider-mismatch', path: file.path, originProvider: origin.provider }
        break
      }
      const repo = origin?.repo || source.repo
      const revision = origin?.revision || source.revision
      fileUrls.push({
        path: file.path,
        role: file.role,
        bytes: file.bytes,
        sha256: file.sha256,
        repo,
        revision,
        url: PROVIDERS[providerId].url({ repo, revision, path: file.path }),
      })
    }
    if (blocked) { skipped.push(blocked); continue }
    if (!fileUrls.length) { skipped.push({ provider: providerId, reason: 'no-files' }); continue }
    sources.push({ provider: providerId, label: PROVIDERS[providerId].label, repo: source.repo, revision: source.revision, ready: true, files: fileUrls })
  }

  return {
    id: entry.id,
    availability: entry.availability,
    order: [...providers],
    sources,
    skipped,
    primary: sources[0] || null,
  }
}
