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

// 核实证据（2026-11-02）：两条新条目同样只走 ModelScope 直连（huggingface.co 超时、
// hf-mirror 重定向回 huggingface.co 后不可达）。revision 取仓库 HEAD commit；逐文件
// bytes/sha256 取自 ModelScope 文件清单，并与实际下载字节、图头解析结果复核一致。
const MINIML_REVISION = '5f19c574ce6bbb065d51869c525840f8a975dcc4'
const MINIML_COMMIT_TIME = '2025-07-22T19:48:27.000Z'
const MINIML_POOLING_REVISION = '524b52f1d626e9a5a16462e141fc9dffc25d5aeb'
const E5_REVISION = '252d0dcb679dda2c7b6fd5bbfed15df3c7feaebf'
const E5_COMMIT_TIME = '2025-07-22T22:49:03.000Z'
const E5_POOLING_REVISION = 'bdd905ef05181adf3ebbfaac5cd5bd4ed9a58760'

// 核实证据（2026-11-02）：Qwen3-Embedding 的 ONNX 导出只在 huggingface 系（n24q02m 的仓库
// 与基座 Qwen 的仓库在 ModelScope 上都没有对应条目）。本机 huggingface.co 连不上，
// hf-mirror.com 通（它重定向到自己的 resolve-cache，不经过 huggingface.co），所以
// 默认走 hf-mirror；两个 provider pin 同一个 commit，逐文件 sha256 与 HF 的 LFS oid 对过。
const QWEN_EXPORT_REPO = 'n24q02m/Qwen3-Embedding-0.6B-ONNX'
const QWEN_REVISION = 'dc873d64d6143f27ad68dadbd1f0d9a4371b994e'
const QWEN_COMMIT_TIME = '2026-02-18T17:28:18.000Z'
const QWEN_BASE_REPO = 'Qwen/Qwen3-Embedding-0.6B'
const QWEN_BASE_REVISION = '97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3'
// 官方默认 query prompt（config_sentence_transformers.json 的 prompts.query），document 侧
// 官方明确「No need to add instruction for retrieval documents」→ 非对称，走角色通道。
const QWEN_QUERY_PROMPT = 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:'
// 两个 provider 都是同一个 commit 的同一份内容；每写一个文件都要过 sha256，所以
// 允许见证制品在任一 provider 上取，而不是把源站整条封掉。
const QWEN_MIRROR_PROVIDERS = ['hf-mirror', 'huggingface']

// 三个模型 pin 的是同一棵受管 ONNX 运行时树：安装事实只写一次，条目里展开复用。
// 指纹只看 engine/abi/version/os/arch 五个字段（§14.8），note 不参与，所以共享常量
// 不会把某个模型的运行时事实悄悄改成另一个模型的。
const PINNED_ONNX_RUNTIME = Object.freeze({
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
  // Every source serves the same npm tarball; the installer still verifies the pinned
  // bytes+sha256 after download, so a mirror can never change the runtime tree.
  artifacts: [
    {
      name: 'onnxruntime-node', version: '1.31.1', license: 'MIT',
      url: 'https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.31.1.tgz',
      sources: [
        { id: 'npmjs', label: 'npmjs', url: 'https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.31.1.tgz' },
        { id: 'npmmirror', label: 'npmmirror（国内镜像）', url: 'https://registry.npmmirror.com/onnxruntime-node/-/onnxruntime-node-1.31.1.tgz' },
      ],
      bytes: 115391311,
      sha256: 'd7a3de2b1bba92614abc74af909cc0ba4f4dd5347735418794edeb58cfef2d22',
      integrity: 'sha512-ijnSghbDHVWaQ2nDPmVccPlCHI8kH1Mx1aJ4a/qzRP16bBcVs4E3EqZQKZCkhWnbqN1tuQWxagimFtDpbPYYQw==',
      extract: ['package.json', 'README.md', 'dist', 'lib', 'bin/napi-v6/<platform>'],
    },
    {
      name: 'onnxruntime-common', version: '1.31.1', license: 'MIT',
      url: 'https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.31.1.tgz',
      sources: [
        { id: 'npmjs', label: 'npmjs', url: 'https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.31.1.tgz' },
        { id: 'npmmirror', label: 'npmmirror（国内镜像）', url: 'https://registry.npmmirror.com/onnxruntime-common/-/onnxruntime-common-1.31.1.tgz' },
      ],
      bytes: 72322,
      sha256: '967acac0c2a22122461e526aeda07305da7289d94f276920d8a6919483f07bfc',
      integrity: 'sha512-F+nnYNiQtmNJ95V6R/isBJqiVpdANCrsMEg1OaF+Bkbl3GAtzWLR7Ng17Ld0QtYtYJyotOHPJzOQn1Y6PLZjpg==',
      extract: ['package.json', 'README.md', 'dist', 'lib'],
    },
    {
      name: '@huggingface/tokenizers', version: '0.2.0', license: 'Apache-2.0',
      url: 'https://registry.npmjs.org/@huggingface/tokenizers/-/tokenizers-0.2.0.tgz',
      sources: [
        { id: 'npmjs', label: 'npmjs', url: 'https://registry.npmjs.org/@huggingface/tokenizers/-/tokenizers-0.2.0.tgz' },
        { id: 'npmmirror', label: 'npmmirror（国内镜像）', url: 'https://registry.npmmirror.com/@huggingface/tokenizers/-/tokenizers-0.2.0.tgz' },
      ],
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
})

// Qwen3-Embedding 的两种量化各是一张卡片：int8 与 int4+fp16 的权重存储方式不同，
// 落出来的向量空间也不同（§14.8 里 quantization 进指纹），所以必须分条目、分 DB，
// 而不是一个条目两个文件让用户以为可以混用。
function qwen3Card(variant) {
  const int8 = variant === 'int8'
  const graphPath = int8 ? 'onnx/model_quantized.onnx' : 'onnx/model_q4f16.onnx'
  const graphBytes = int8 ? 600223343 : 541820311
  const graphSha = int8
    ? '76dc4f417876e48b2fae7f325cb052f46099c890e6a7c1b60f91ff5027d751ef'
    : '2db238eb6122ce336c9de62df9c08113a4da7f41514298885a379451e952178e'
  const activation = int8 ? 'float32' : 'float16'
  return {
    id: `qwen3-embedding-0.6b-${variant}`,
    displayName: `Qwen3-Embedding-0.6B (${variant} ONNX)`,
    summary: int8
      ? 'Qwen3 0.6B 多语言检索模型（1024 维、last-token pooling + L2），默认下载的就是这份 int8。受管 ORT CPU 实测：图加载 2.06 s、短句一次编码 91 ms、380 字 437 ms、1520 字 4.29 s——比 BGE/MiniLM/e5 慢一到两个数量级，换来的是跨 100+ 语言与代码检索。查询侧带官方 Instruct 前缀（非对称 → 需要角色通道），实测加/不加前缀的同句余弦只有 0.8284；同一份 recall-bench 草稿上带前缀 R@1 0.6970 / MRR 0.8359，不带前缀 0.6667 / 0.8081（33 条可答样本，差一个样本，不当结论，但方向与官方说明一致）。'
      : '与 int8 卡片同一份 0.6B 权重的 int4 变体（float16 激活 + com.microsoft.MatMulNBits，block_size=128），制品 542 MB vs 600 MB。受管 ORT CPU 实测反而更慢：加载 11.4 s、短句 110 ms、380 字 870 ms、1520 字 5.86 s，且依赖 com.microsoft 私有算子域。在这份合成草稿上它没有变差（带前缀 R@1 0.7273 / MRR 0.8510，int8 是 0.6970 / 0.8359）——33 个样本的差距不足以排序两个变体的质量，能当依据的是实测到的加载慢 5.5 倍与贡献算子依赖。向量空间与 int8 卡片不同，切换 = 重建。',
    languages: ['zh', 'en', 'multilingual'],
    tier: int8 ? 'preferred' : 'optional',
    availability: 'available',
    pendingReasons: [],
    parameters: int8 ? 595776975 : 599217221,
    parameterSource: int8
      ? '图内 initializer 元素合计 595,776,975（int8 440,402,116 + uint8 155,309,057 + float32 65,802，不含 int64/bool 位置与掩码表）；官方模型卡 0.6B'
      : '图内 initializer 元素合计 599,217,221（float16 158,815,301 + int4 按 uint8 打包 ×2 = 440,401,920）；与 int8 变体同一份 0.6B 权重，存储方式不同所以计数略有出入',
    dimension: 1024,
    // 制品侧 config.max_position_embeddings=32768（tokenizer model_max_length 131072），
    // 这里按实测延迟取 4096：1520 字已经 4.3 s，按 32k 跑一条长记忆会直接顶到 worker 的
    // 120 s 请求超时。分窗是指纹字段，所以它是刻意的策略而不是「没核实」。
    maxTokens: 4096,
    // 因果 LM：官方 1_Pooling pooling_mode_lasttoken=true，其余全 false。
    pooling: 'last',
    normalization: 'l2',
    prefixes: { query: QWEN_QUERY_PROMPT, document: '' },
    quantization: int8
      ? {
        weights: 'qint8',
        scheme: 'dynamic-per-tensor',
        reduceRange: null,
        source: '导出仓库 README 声明 onnxruntime.quantization.quantize_dynamic(QInt8)；图侧核实 196/196 个 MatMulInteger 的 scale/zero_point 都是 rank-0 标量、per-channel scale 向量 0 个，另有 DynamicQuantizeLinear 112 个 → 激活动态量化 + 权重 per-tensor，和 BGE/MiniLM/e5 的 per-channel 不是同一个空间',
      }
      : {
        weights: 'uint4-nbits',
        scheme: 'block-wise-int4-block128-fp16-activations',
        reduceRange: null,
        source: 'README 声明 MatMulNBitsQuantizer(block_size=128, symmetric) + FP16 cast；图侧核实 com.microsoft.MatMulNBits 196 个、打包权重形状 [out, blocks, 64]（blocks×128 = 输入维、64 字节 = 128 个 nibble），其余 initializer 为 float16；opset 21 + com.microsoft v1',
      },
    runtime: {
      ...PINNED_ONNX_RUNTIME,
      note: int8
        ? '受管 ORT 1.31.1 CPU 真实加载/推理已核实（2026-11-02，win32-x64）：1024 维、单位范数、重复编码余弦 1.0。'
        : '受管 ORT 1.31.1 CPU 真实加载/推理已核实（2026-11-02，win32-x64），但依赖 com.microsoft 贡献算子域；加载 11.4 s，仍在 worker 60 s ready 预算内。',
    },
    license: {
      base: { id: 'apache-2.0', source: 'hf-mirror 元数据 Qwen/Qwen3-Embedding-0.6B cardData.license = apache-2.0（2026-11-02 只读核对）' },
      onnxExport: { id: 'apache-2.0', source: 'n24q02m/Qwen3-Embedding-0.6B-ONNX 的 README front-matter license: apache-2.0（2026-11-02 核对下载字节）' },
    },
    verification: {
      status: 'verified',
      method: 'sha256+onnx-header+onnxruntime-inference',
      checkedAt: '2026-11-02T08:55:00.000Z',
      scope: `逐文件 bytes/sha256 与 HF 文件树声明一致（LFS 制品直接对 lfs.oid 的 sha256）+ ONNX 图头（opset 21、input_ids/attention_mask 两个 int64 输入、last_hidden_state ${activation}[1,sequence_length,1024]、自包含、固定 batch=1 导出）+ 基座 1_Pooling/2_Normalize 的 pooling 与归一化事实 + 受管 ORT CPU 真实推理与延迟测量`,
      evidence: int8
        ? '2026-11-02 实测（.tmp-model-adapt-20261102/qwen3*）：onnx/model_quantized.onnx 600,223,343 B 的 sha256 与 HF LFS oid 76dc4f41…逐字节一致；加载 2057 ms、首帧 91 ms、380 字 437 ms、1520 字 4286 ms、单位范数 1.0、重复编码余弦 1.0；instruct 前缀漂移余弦 0.8284；42 条 recall-bench 草稿的 33 条可答样本上带前缀 R@1 0.6970 / R@3 0.9697 / MRR 0.8359、裸文本 0.6667 / 0.9394 / 0.8081；真机五路互切（MiniLM→本卡→q4f16→e5→BGE）各 6/6 条重建、0 失败、中英查询均召回'
        : '2026-11-02 实测（.tmp-model-adapt-20261102/qwen3*）：onnx/model_q4f16.onnx 541,820,311 B 的 sha256 与 HF LFS oid 2db238eb…逐字节一致；加载 11401 ms、首帧 110 ms、380 字 870 ms、1520 字 5863 ms、单位范数 1.0、重复编码余弦 1.0；instruct 前缀漂移余弦 0.8203；同一份草稿带前缀 R@1 0.7273 / R@3 0.9697 / MRR 0.8510、裸文本 0.6667 / 0.9394 / 0.8081；真机五路互切里作为 g3 完成重建并召回',
      notVerified: [
        'modelscope 上没有该导出仓库与基座仓库的对应条目（只读核对 record not found）',
        `huggingface.co 源站本机不可达：同一 commit 的同一批文件只在 hf-mirror 上做过逐字节复核`,
        '与 PyTorch 基座（float32/bfloat16）向量的数值等价性——本包不做参考实现比对，只保证同一制品重复编码一致',
      ],
    },
    sources: {
      'hf-mirror': { repo: QWEN_EXPORT_REPO, revision: QWEN_REVISION, revisionVerified: true, commitTime: QWEN_COMMIT_TIME },
      huggingface: { repo: QWEN_EXPORT_REPO, revision: QWEN_REVISION, revisionVerified: false, commitTime: QWEN_COMMIT_TIME, note: '与 hf-mirror pin 同一个 commit；本机连不上 huggingface.co，所以未独立复核，但逐文件 sha256 是硬校验' },
    },
    witness: {
      provider: 'hf-mirror',
      repo: QWEN_BASE_REPO,
      revision: QWEN_BASE_REVISION,
      path: '1_Pooling/config.json',
      bytes: 313,
      sha256: '37bf193fa101f19101bfad9c31d3eb0f786e247b7b1e5cb7f007d730eed1ddbd',
      purpose: 'pooling 事实来源：pooling_mode_lasttoken=true 且 cls/mean/max/weightedmean 全 false、word_embedding_dimension=1024、include_prompt=true；同仓库 modules.json 含 2_Normalize（L2），config_sentence_transformers.json 的 prompts.query 给出官方 Instruct 前缀且 prompts.document 为空',
    },
    graph: {
      path: graphPath,
      opset: 21,
      producer: int8 ? 'onnx.quantize' : 'pytorch',
      producerVersion: int8 ? '0.1.0' : '2.10.0+cu128',
      selfContained: true,
      externalData: [],
      inputs: [
        { name: 'input_ids', dtype: 'int64', shape: ['batch_size', 'sequence_length'] },
        { name: 'attention_mask', dtype: 'int64', shape: ['batch_size', 'sequence_length'] },
      ],
      // batch 维是字面量 1（导出时固定），所以一次只能喂一行。
      outputs: [{ name: 'last_hidden_state', dtype: activation, shape: [1, 'sequence_length', 1024] }],
    },
    files: [
      { path: 'config.json', role: 'config', bytes: 1416, sha256: '88014d4dd5f874bf4050a57e76029ffdb42bead2c0c9253b4eb21bc65da8a5d9' },
      { path: 'tokenizer.json', role: 'tokenizer', bytes: 11423701, sha256: '93623af029cdc69b87f2864d3b2cc2424fdf16684f15e139b5b9d08ec34ced91' },
      { path: 'tokenizer_config.json', role: 'tokenizer-config', bytes: 349, sha256: 'bc3e7cb4dad833a185d4bfbb4880562dc9b0cb101c47b8985078122a122d553a' },
      { path: graphPath, role: 'graph', bytes: graphBytes, sha256: graphSha },
      { path: 'README.md', role: 'notice', bytes: 2226, sha256: 'a5b65f56517933cc8b6724293b73e7123531569df121ae3ebe597dd8dd571a3f' },
      {
        path: '1_Pooling/config.json',
        role: 'pooling-config',
        bytes: 313,
        sha256: '37bf193fa101f19101bfad9c31d3eb0f786e247b7b1e5cb7f007d730eed1ddbd',
        origin: {
          provider: 'hf-mirror',
          providers: QWEN_MIRROR_PROVIDERS,
          repo: QWEN_BASE_REPO,
          revision: QWEN_BASE_REVISION,
        },
      },
    ],
  }
}

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
      ...PINNED_ONNX_RUNTIME,
      note: '隔离目录真实 ORT CPU 加载/推理 smoke 已核实；仅允许固定版本，不隐式下载。',
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
    summary: '英文句子相似度小模型（384 维，mean pooling + L2）。中文能跑但明显弱于另外两个：同一份 recall-bench 草稿 33 条可答样本上 R@1 0.5455 / MRR@3 0.7525，BGE 是 0.6667 / 0.8106。它不是中文模型的等价替代，适合英文语料或只想装 23 MB 制品的场合。',
    languages: ['en'],
    tier: 'optional',
    availability: 'available',
    pendingReasons: [],
    parameters: 22565376,
    parameterSource: '实测图内 initializer 元素合计 22,565,376（uint8 11,917,824 + int8 10,616,832 + float32 30,720）；官方模型页标 22.7M',
    dimension: 384,
    // 底座 config.max_position_embeddings=512、tokenizer model_max_length=512、图输出第三维=384
    // 三处一致；sentence_bert_config.json 的 max_seq_length=256 只是 SB wrapper 的窗口。
    // 分窗按制品本身取 512，和 BGE 同窗，切换模型不会顺带改分窗口径。
    maxTokens: 512,
    pooling: 'mean',
    normalization: 'l2',
    prefixes: { query: '', document: '' },
    quantization: {
      weights: 'qint8',
      scheme: 'dynamic-per-channel',
      reduceRange: null,
      source: '仓库未随附 quant_config.json；方案取自图本身：MatMulInteger(36)+DynamicQuantizeLinear(24)，39/39 个 int8/uint8 二维权重都存在长度=输出通道数的一维 float32 scale，长度 1 的标量 scale=0',
    },
    runtime: { ...PINNED_ONNX_RUNTIME, note: '同一棵受管 ORT 1.31.1 CPU 树真实推理已核实（2026-11-02）：384 维、单位范数、重复编码余弦 1.0。' },
    license: {
      base: { id: 'apache-2.0', source: 'ModelScope Xenova/all-MiniLM-L6-v2 元数据 License=apache-2.0（2026-11-02 只读核对）' },
      onnxExport: { id: 'apache-2.0', source: '导出仓库 README front-matter license: apache-2.0（2026-11-02 核对下载字节）' },
    },
    verification: {
      status: 'verified',
      method: 'sha256+onnx-header+onnxruntime-inference',
      checkedAt: '2026-11-02T08:00:00.000Z',
      scope: '逐文件 bytes/sha256 与 ModelScope 文件清单双向一致 + ONNX 图头（opset 11、3 个 int64 输入、last_hidden_state float32[batch,seq,384]、自包含 22,661,632 initializer 字节）+ vocab.txt 行数 30522=config.vocab_size + 受管 ORT CPU 真实推理',
      evidence: '2026-11-02 实测（.tmp-model-adapt-20261102）：8 个文件 sha256 全部与清单一致；worker 单次编码 7ms、单位范数 1.0、重复编码余弦 1.0、>512 token 长文截断可用；42 条 recall-bench 草稿 33 条可答样本 R@1 0.5455 / R@3 1.0000 / MRR@3 0.7525',
      notVerified: ['huggingface/hf-mirror 上的对应 commit（本机不可达）'],
    },
    sources: {
      modelscope: { repo: 'Xenova/all-MiniLM-L6-v2', revision: MINIML_REVISION, revisionVerified: true, commitTime: MINIML_COMMIT_TIME },
      'hf-mirror': { repo: 'Xenova/all-MiniLM-L6-v2', revision: null, revisionVerified: false, note: 'hf-mirror.com 本机不可达，commit 未核实；不生成 URL' },
      huggingface: { repo: 'sentence-transformers/all-MiniLM-L6-v2', revision: null, revisionVerified: false, note: 'huggingface.co 本机不可达，commit 未核实；不生成 URL' },
    },
    witness: {
      provider: 'modelscope',
      repo: 'sentence-transformers/all-MiniLM-L6-v2',
      revision: MINIML_POOLING_REVISION,
      path: '1_Pooling/config.json',
      bytes: 190,
      sha256: '4be450dde3b0273bb9787637cfbd28fe04a7ba6ab9d36ac48e92b11e350ffc23',
      purpose: 'pooling 事实来源：pooling_mode_mean_tokens=true、cls/max=false、word_embedding_dimension=384；同仓库 modules.json 含 2_Normalize（L2），sentence_bert_config.json max_seq_length=256',
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
      outputs: [{ name: 'last_hidden_state', dtype: 'float32', shape: ['batch_size', 'sequence_length', 384] }],
    },
    files: [
      { path: 'config.json', role: 'config', bytes: 650, sha256: '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7' },
      { path: 'tokenizer.json', role: 'tokenizer', bytes: 711661, sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0' },
      { path: 'tokenizer_config.json', role: 'tokenizer-config', bytes: 366, sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3' },
      { path: 'special_tokens_map.json', role: 'special-tokens', bytes: 125, sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3' },
      { path: 'vocab.txt', role: 'vocab', bytes: 231508, sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3' },
      { path: 'onnx/model_quantized.onnx', role: 'graph', bytes: 22972370, sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1' },
      { path: 'README.md', role: 'notice', bytes: 1767, sha256: '63ea99bf681a2e9eda4f6a537d5ed8fda95d1677111656da37e9cfd080c3af02' },
      {
        path: '1_Pooling/config.json',
        role: 'pooling-config',
        bytes: 190,
        sha256: '4be450dde3b0273bb9787637cfbd28fe04a7ba6ab9d36ac48e92b11e350ffc23',
        origin: { provider: 'modelscope', repo: 'sentence-transformers/all-MiniLM-L6-v2', revision: MINIML_POOLING_REVISION },
      },
    ],
  },
  {
    id: 'multilingual-e5-small',
    displayName: 'multilingual-e5-small (int8 ONNX)',
    summary: '多语言检索模型（118M 参数、int8 制品 ≈118 MB、384 维，mean pooling + L2）。要 query/passage 前缀：worker 通过 model 字段的角色后缀拿到 role，绝不按文本猜角色。同一份 recall-bench 草稿上 R@1 0.6667 / R@3 1.0000 / MRR@3 0.8182，中文与 BGE 同级、英文 paraphrase 余弦 0.91/0.93（BGE 0.65/0.64）；代价是制品比 BGE 大 4.8 倍、推理慢一倍左右。',
    languages: ['zh', 'en', 'multilingual'],
    tier: 'optional',
    availability: 'available',
    pendingReasons: [],
    parameters: 117505920,
    parameterSource: '实测图内 initializer 元素合计 117,505,920（uint8 96,211,584 + int8 21,233,664 + float32 60,672）；官方模型页标 118M',
    dimension: 384,
    // 底座 config.max_position_embeddings=512、tokenizer model_max_length=512、
    // sentence_bert_config.json max_seq_length=512 三处一致。
    maxTokens: 512,
    pooling: 'mean',
    normalization: 'l2',
    // 非对称前缀 = query 与 document 落在两个不同的读法上，必须靠角色通道区分（§14.4）。
    prefixes: { query: 'query: ', document: 'passage: ' },
    quantization: {
      weights: 'qint8',
      scheme: 'dynamic-per-channel',
      reduceRange: true,
      source: 'quant_config.json(per_channel=true, reduce_range=true, weight_type=QInt8) + 图内 MatMulInteger(72)/DynamicQuantizeLinear(48)；75/75 个 int8/uint8 二维权重都存在长度=输出通道数的一维 float32 scale',
    },
    runtime: { ...PINNED_ONNX_RUNTIME, note: '同一棵受管 ORT 1.31.1 CPU 树真实推理已核实（2026-11-02）：XLM-R Unigram 分词可用、384 维、单位范数。' },
    license: {
      base: { id: 'mit', source: 'ModelScope intfloat/multilingual-e5-small 元数据 License=mit（2026-11-02 只读核对）' },
      onnxExport: { id: 'undeclared', source: 'ModelScope Xenova/multilingual-e5-small 的 README front-matter 只有 base_model/library_name，未声明 license（2026-11-02 核对下载字节）' },
    },
    verification: {
      status: 'verified',
      method: 'sha256+onnx-header+onnxruntime-inference',
      checkedAt: '2026-11-02T08:00:00.000Z',
      scope: '逐文件 bytes/sha256 与 ModelScope 文件清单双向一致 + ONNX 图头（opset 11、3 个 int64 输入、last_hidden_state float32[batch,seq,384]、自包含 117,687,936 initializer 字节）+ tokenizer.json Unigram 词表 250002 + 受管 ORT CPU 真实推理与前缀 A/B',
      evidence: '2026-11-02 实测（.tmp-model-adapt-20261102）：8 个文件 sha256 全部与清单一致；单次编码 6ms、单位范数 1.0、重复编码余弦 1.0；前缀 A/B（33 条可答样本）asym R@1 0.6667/MRR 0.8182/分离度 0.1230、sym-passage 0.6364/0.8030/0.0867、sym-query 0.6667/0.8157/0.1155、无前缀 0.6364/0.8030/0.1139；query: 与 passage: 同文余弦 0.9811',
      notVerified: ['huggingface/hf-mirror 上的对应 commit（本机不可达）', 'intfloat 官方仓库里 470 MB fp32 onnx/model.onnx 与本报告使用的 int8 导出数值等价性'],
    },
    sources: {
      modelscope: { repo: 'Xenova/multilingual-e5-small', revision: E5_REVISION, revisionVerified: true, commitTime: E5_COMMIT_TIME },
      'hf-mirror': { repo: 'Xenova/multilingual-e5-small', revision: null, revisionVerified: false, note: 'hf-mirror.com 本机不可达，commit 未核实；不生成 URL' },
      huggingface: { repo: 'intfloat/multilingual-e5-small', revision: null, revisionVerified: false, note: 'huggingface.co 本机不可达，commit 未核实；不生成 URL' },
    },
    witness: {
      provider: 'modelscope',
      repo: 'intfloat/multilingual-e5-small',
      revision: E5_POOLING_REVISION,
      path: '1_Pooling/config.json',
      bytes: 200,
      sha256: '987f7a67a38fa564c849bb5d277c52ab9088a84368fc0be31a354125aebb12a0',
      purpose: 'pooling 事实来源：pooling_mode_mean_tokens=true、cls/max=false、word_embedding_dimension=384；同仓库 modules.json 含 2_Normalize（L2），sentence_bert_config.json max_seq_length=512',
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
      outputs: [{ name: 'last_hidden_state', dtype: 'float32', shape: ['batch_size', 'sequence_length', 384] }],
    },
    files: [
      { path: 'config.json', role: 'config', bytes: 658, sha256: 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1' },
      { path: 'tokenizer.json', role: 'tokenizer', bytes: 17082730, sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' },
      { path: 'tokenizer_config.json', role: 'tokenizer-config', bytes: 443, sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b' },
      { path: 'special_tokens_map.json', role: 'special-tokens', bytes: 167, sha256: 'd05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7' },
      { path: 'quant_config.json', role: 'quantization', bytes: 674, sha256: '59d175f15264115f18c698d76e443b5d49fc6c8c599911c421405ef4f236e87d' },
      { path: 'onnx/model_quantized.onnx', role: 'graph', bytes: 118308185, sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193' },
      { path: 'README.md', role: 'notice', bytes: 1077, sha256: '561a19594636657fe033f8b4427a7743b5f6f3a12f16cecc5f286feca0453245' },
      {
        path: '1_Pooling/config.json',
        role: 'pooling-config',
        bytes: 200,
        sha256: '987f7a67a38fa564c849bb5d277c52ab9088a84368fc0be31a354125aebb12a0',
        origin: { provider: 'modelscope', repo: 'intfloat/multilingual-e5-small', revision: E5_POOLING_REVISION },
      },
    ],
  },
  qwen3Card('int8'),
  qwen3Card('q4f16'),
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

/**
 * 非对称前缀（query ≠ document）= 同一个模型对两种输入有两种读法，请求通道必须带上角色，
 * 否则 worker 只能按文本猜——§14.4 明确不许猜。这里只从前缀派生，不另设开关：前缀本身在
 * 指纹里，所以「要不要角色通道」和「这个向量空间是什么」永远来自同一份事实。
 */
export function prefixesRequireRole(entry) {
  const prefixes = entry?.prefixes
  return !!prefixes
    && typeof prefixes.query === 'string'
    && typeof prefixes.document === 'string'
    && prefixes.query !== prefixes.document
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
  if (!(manifest.maxTokens === null || (Number.isInteger(manifest.maxTokens) && manifest.maxTokens >= 32 && manifest.maxTokens <= 32768))) {
    error('MAX_TOKENS_INVALID', 'maxTokens must be null (unverified) or an integer in 32..32768')
  }
  // 'last' = 因果 LM 的最后一个非 pad token（Qwen3-Embedding 这一类）；'max' 仍是
  // 目录允许声明但执行侧未实现，所以没有任何 available 条目使用它。
  if (!['cls', 'mean', 'max', 'last'].includes(manifest.pooling)) error('POOLING_INVALID', 'pooling must be cls/mean/max/last')
  if (!['l2', 'none'].includes(manifest.normalization)) error('NORMALIZATION_INVALID', 'normalization must be l2/none')
  if (!isPlainObject(manifest.prefixes) || typeof manifest.prefixes.query !== 'string' || typeof manifest.prefixes.document !== 'string') {
    error('PREFIXES_INVALID', 'prefixes.query/document must be strings (empty is allowed)')
  } else if (manifest.prefixes.query !== manifest.prefixes.document) {
    warn('PREFIX_ASYMMETRIC', 'query/document prefixes differ, so this model reads the same text two ways: serving it needs an explicit role channel and role-less requests must be refused')
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
        } else if (origin.providers !== undefined
          && (!Array.isArray(origin.providers) || !origin.providers.length
            || !origin.providers.every(id => PROVIDERS[id]) || !origin.providers.includes(origin.provider))) {
          error('FILE_ORIGIN_INVALID', `file ${file.path} origin.providers must be a non-empty list of known providers that includes origin.provider`)
        }
      }
    }
    const graphs = files.filter(file => file.role === 'graph')
    if (manifest.availability === 'available' && graphs.length !== 1) error('GRAPH_MISSING', 'exactly one file must have role graph')
    for (const graphFile of graphs) if (!String(graphFile.path || '').endsWith('.onnx')) error('GRAPH_NOT_ONNX', `graph file must be .onnx: ${graphFile.path}`)

    // 目录构建器会给每条都补 totalBytes，而手写清单里那个「恰好等于文件之和」的值
    // 本来就是同一份事实——只有对不上才是错误。否则加一条条目就得假装没写它。
    const actual = files.reduce((sum, file) => sum + (Number.isFinite(file.bytes) ? file.bytes : 0), 0)
    if (manifest.totalBytes !== undefined && manifest.totalBytes !== actual) {
      error('TOTAL_BYTES_MISMATCH', `totalBytes ${manifest.totalBytes} does not equal the sum of files ${actual}`)
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
      // 见证制品默认绑死它被核实的那个 provider。镜像站族（hf-mirror / huggingface 是同一
      // commit 的同一份内容）可以由 origin.providers 显式声明多个合法来源，否则换源会被
      // 这条规则整条封掉；无论哪个来源，落盘都要过同一个 sha256。
      const allowedProviders = origin && Array.isArray(origin.providers) && origin.providers.length ? origin.providers : [origin?.provider]
      if (origin && !allowedProviders.includes(providerId)) {
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
