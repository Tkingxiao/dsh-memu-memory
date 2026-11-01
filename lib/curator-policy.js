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
