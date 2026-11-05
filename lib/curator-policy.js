// Single point for every curator/absorb/link threshold (spec §4.12).
//
// Two rules keep this file load-bearing instead of decorative:
//   1. No other curator module may inline one of these numbers — a gate tuned
//      in a test or a script must import the constant, so "the threshold
//      moved" is a one-line diff.
//   2. Band constants derive from lib/text-similarity.js where a private-library
//      gate already owns the value (DUP_DICE / DUP_REJECT_DICE / TOPIC_DICE), so
//      the write-side duplicate ruler and the curator pair bands can never
//      drift apart.
import { DUP_DICE, DUP_REJECT_DICE, TOPIC_DICE } from './text-similarity.js'
// 刻意的双向依赖（仅函数体内使用）：computeRRFWeights 的近期语义检测要用
// 「当前生效的 tokenize」，而分词开关（TOKENIZER_V2）就定义在本表，实际实现
// 在 lib/text-retrieval.js。两侧顶层都不读对方的绑定（本模块顶层只有常量，
// text-retrieval 顶层只有函数声明与本地正则），ESM 循环加载在两种启动顺序
// 下都安全，且被 tests/dynamic-rrf.test.mjs 覆盖。
import { tokenize } from './text-retrieval.js'

// —— op 上限（§5.3）——
export const CURATOR_MAX_MEMORIES = 80
export const CURATOR_MAX_LINK_ABSORB = 20
export const CURATOR_MAX_ABSORB = 8

// —— absorb（§4.7；提交与覆盖率分段属于 F2，常量先定点）——
export const ABSORB_MAX_SOURCES = 5
export const ABSORB_MAX_CHARS = 8000
export const ABSORB_AUTO_SOURCE_COVERAGE = 0.45
export const ABSORB_AUTO_UNION_COVERAGE = 0.6
export const ABSORB_REVIEW_SOURCE_COVERAGE = 0.25
export const ABSORB_REVIEW_UNION_COVERAGE = 0.45
export const ABSORB_ABSTRACTIVE_COVERAGE = 0.75
export const ABSORB_MIN_LENGTH_RATIO = 0.5

// —— 候选簇（§4.4）——
export const CLUSTER_MAX = 12
export const CLUSTER_MAX_MEMBERS = 6
export const CLUSTER_MIN_PAIR = 0.55
export const CLUSTER_BLOCK_MIN_SHARED = 2
export const CLUSTER_EXACT_PAIR_LIMIT = 300
export const CLUSTER_RECENT_LIMIT = 2000

// —— 成对特征（§4.2）——
export const PAIR_SCAN_LIMIT = 20
export const PAIR_LINK_MIN = TOPIC_DICE // 0.55
export const PAIR_ABSORB_MIN = DUP_DICE // 0.82
export const PAIR_DUPLICATE_MIN = DUP_REJECT_DICE // 0.90
export const PAIR_W_LEXICAL = 0.5
export const PAIR_W_TOKEN = 0.2
export const PAIR_W_TITLE = 0.15
export const PAIR_W_ENTITY = 0.15

// —— 检索与融合（§4.1/§4.3）——
export const BM25_K1 = 1.2
export const BM25_B = 0.75
export const BM25_MAX_QUERY_TERMS = 64
export const BLOCK_DF_RATIO = 0.3
export const RRF_K = 60 // 与 memory.js 的 HYBRID_RRF_K 同一口径
export const RRF_W_BM25 = 0.5
export const RRF_W_DICE = 0.3
export const RRF_W_ENTITY = 0.2
// —— RRF 切片边界带（P0-1 回归修复：准入从 RRF 代理换成 pairScore 真尺）——
// pre-cut 用 RRF 代理决定谁进 pairScore 评分；近重复簇里 rrf 平刀锋时（bench
// 实测缝 3.6e-5 ~ 2.2e-4），len 归一噪声决定准入，pairScore 更准的候选反而落榜。
// 与切点 rrf 之差 ≤ RRF_SLICE_BAND 的候选并入评分集；评分集总量上限 = max ×
// RRF_SLICE_BAND_CAP（cap 才是真正的成本闸：近平手语料带内早已触发截断，带宽在
// cap 内上调不增加评分量，只是名额从顶部让给更宽的近平手区）。超限按 rrf 降序 +
// idAsc 截断。
export const RRF_SLICE_BAND = 2.5e-4
export const RRF_SLICE_BAND_CAP = 2

// —— 召回升级双轨开关（P0-1/P0-2）——
// TOKENIZER_V2：true → text-retrieval 的 tokenize/tokenStream 委托
// lib/tokenizer-v2.js（CJK unigram+bigram+trigram 三层 + 实体保护）；false →
// V1 原路径（CJK 只出 bigram）。对外签名与语义兼容，渐进切换用。
export const TOKENIZER_V2 = true
// RRF_DYNAMIC：true → rankPairCandidates 用 computeRRFWeights 按查询动态定权
// （近期查询加 recency 第四路）；false → 恒走静态 RRF_W_* 三路原式（字节级
// 回退路径，保证任何异常下可退回）。
export const RRF_DYNAMIC = true

// —— 动态 RRF 权重（P0-2；权重数字只在本表）——
// 近期查询的第四路权重与整组权重（设计稿 §4.2：关键词降权、recency 补一路）。
export const RRF_W_RECENCY = 0.2
export const RRF_RECENT_WEIGHTS = { bm25: 0.3, dice: 0.3, entity: 0.2, recency: 0.2 }
// 权重边界（风险表「权重边界 + fallback 到默认值」）：每个通道 clamp 到
// [MIN, MAX]，再按总和归一化为 1；越界/异常输入回退静态三路。
export const RRF_DYNAMIC_WEIGHT_MIN = 0.05
export const RRF_DYNAMIC_WEIGHT_MAX = 0.6
// coding 域的 entity 提权倍数（实体匹配对代码条目更关键）。
export const RRF_DYNAMIC_ENTITY_BOOST = 1.5
// 近期语义词典（中英）。CJK 词条刻意 ≤2 字：V1（只出 bigram）与 V2（三层
// n-gram）都会把 2 字词产成 token，检测口径不随 TOKENIZER_V2 开关漂移；
// 「前几天/前几周」等由「前几」bigram 覆盖。
export const RECENCY_TERMS = ['最近', '昨天', '今天', '刚刚', '前几', 'latest', 'recent', 'yesterday', 'recently']

// —— 跨域（§4.2/§4.9）——
export const CROSS_DOMAIN_LINK_MIN = 0.65
export const LINK_CYCLE_DEPTH = 3

// —— 上下文打包（§4.5/§0.3 C12）——
export const CURATOR_INDEX_TOKENS = 4000
export const CURATOR_CLUSTER_TOKENS = 2000
export const CURATOR_INDEX_MAX_ENTRIES = 120

// —— 证据（§4.6）——
export const EVIDENCE_MIN_CHARS = 6
export const EVIDENCE_MAX = 20
export const EVIDENCE_ELLIPSIS_MIN_CHARS = 4
export const EVIDENCE_ELLIPSIS_MAX_SEGMENTS = 3

// —— 全局 link（§3.2/§4.9）——
export const LINK_NOTE_MIN = 8
export const LINK_NOTE_MAX = 500
export const LINK_MAX_PER_ENTRY = 20
export const LINK_EVIDENCE_MAX = 3
export const LINK_CONFIDENCE_MIN = 0.5
export const GLOBAL_LINK_KINDS = ['related', 'refines', 'supports']

// —— 词典频率（包 C 预留；§4.12 表格逐字保留）——
export const HIT_COUNT_CAP = 1_000_000
export const WILSON_Z = 1.96

// —— 动态 RRF 权重（P0-2）——

/** 静态三路权重（回退口径，对象字面量每次新建，调用方可安全持有/改写）。 */
function staticRRFWeights() {
  return { bm25: RRF_W_BM25, dice: RRF_W_DICE, entity: RRF_W_ENTITY }
}

/** clamp 到 [RRF_DYNAMIC_WEIGHT_MIN, RRF_DYNAMIC_WEIGHT_MAX] 并按总和归一化为 1。 */
function clampAndNormalize(weights) {
  const clamped = {}
  let sum = 0
  for (const [key, value] of Object.entries(weights)) {
    const v = Math.min(RRF_DYNAMIC_WEIGHT_MAX, Math.max(RRF_DYNAMIC_WEIGHT_MIN, Number(value) || 0))
    clamped[key] = v
    sum += v
  }
  if (!(sum > 0)) return staticRRFWeights()
  const out = {}
  for (const [key, value] of Object.entries(clamped)) out[key] = value / sum
  return out
}

/**
 * P0-2 动态 RRF 权重。纯函数：无 clock、无状态，同输入同输出。
 *
 * - 查询文本 = proposal 的 title+content，用**当前生效的 tokenize** 分词后
 *   命中 RECENCY_TERMS → 近期查询：RRF_RECENT_WEIGHTS（bm25 0.3 / dice 0.3 /
 *   entity 0.2 / recency 0.2）；
 * - proposal.domain === 'coding' → entity 提权（×RRF_DYNAMIC_ENTITY_BOOST）；
 * - 每个权重 clamp 到 [RRF_DYNAMIC_WEIGHT_MIN, RRF_DYNAMIC_WEIGHT_MAX] 后按
 *   总和归一化为 1（普通查询恰好 = 静态 { bm25: 0.5, dice: 0.3, entity: 0.2 }）；
 * - 任何异常输入（proposal/corpus 非对象、字段不可分词等）→ 回退静态三路。
 *
 * 返回对象**带 recency 键** ⟺ 调用方（text-retrieval.rankPairCandidates）应
 * 启用第四路 recency 排名；不带则维持三路。
 */
export function computeRRFWeights(proposal, corpus) {
  if (!proposal || typeof proposal !== 'object') return staticRRFWeights()
  if (!corpus || typeof corpus !== 'object') return staticRRFWeights()
  let weights
  try {
    const queryText = `${proposal.title || ''} ${proposal.content || ''}`
    const tokens = tokenize(queryText)
    const recency = RECENCY_TERMS.some((term) => tokens.includes(term))
    weights = recency
      ? { ...RRF_RECENT_WEIGHTS }
      : staticRRFWeights()
  } catch {
    // tokenize 对任意输入都不该抛（内部 String() 兜底）；真抛了说明输入异常，
    // 按风险表回退默认权重，不把故障往上传。
    return staticRRFWeights()
  }
  if (proposal.domain === 'coding') {
    weights.entity = weights.entity * RRF_DYNAMIC_ENTITY_BOOST
  }
  return clampAndNormalize(weights)
}
