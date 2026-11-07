// Local candidate retrieval for the global curator (spec §4.1-§4.4, §4.8).
//
// Pipeline position: the LLM only arbitrates; everything here is model-free.
// tokenize + BM25 give the ranking spine, character-Dice/token/entity features
// give the pair score, weighted RRF fuses the three rankings, and the greedy
// all-pairs clique turns edges into candidate clusters. The commit layer
// (curator.js planCuratorOps) reuses rankPairCandidates as the final
// duplicate/conflict gate — one ruler from blocking to commit.
//
// Dependency discipline: this module imports only lib/text-similarity.js (the
// shared similarity ruler), lib/curator-policy.js (the single constant table)
// and lib/tokenizer-v2.js (the V2 tokenizer delegated to by the TOKENIZER_V2
// switch). No state, no IO, no clock — same input, same output, always.

import {
  bigrams,
  dice,
  jaccard,
  lengthGap,
  similarityDetail,
  similarTexts,
} from './text-similarity.js'
import {
  BM25_B,
  BM25_DF_MIN_POOL,
  BM25_DF_RATIO,
  BM25_K1,
  BM25_MAX_QUERY_TERMS,
  BLOCK_DF_RATIO,
  CLUSTER_BLOCK_MIN_SHARED,
  CLUSTER_EXACT_PAIR_LIMIT,
  CLUSTER_MAX,
  CLUSTER_MAX_MEMBERS,
  CLUSTER_MAX_PAIRS,
  CLUSTER_MIN_PAIR,
  CLUSTER_RECENT_LIMIT,
  CROSS_DOMAIN_LINK_MIN,
  PAIR_ABSORB_MIN,
  PAIR_DUPLICATE_MIN,
  PAIR_LINK_MIN,
  PAIR_SCAN_LIMIT,
  PAIR_W_ENTITY,
  PAIR_W_LEXICAL,
  PAIR_W_TITLE,
  PAIR_W_TOKEN,
  RRF_DYNAMIC,
  RRF_K,
  RRF_SLICE_BAND,
  RRF_SLICE_BAND_CAP,
  RRF_W_BM25,
  RRF_W_DICE,
  RRF_W_ENTITY,
  TOKENIZER_V2,
  computeRRFWeights,
} from './curator-policy.js'
import {
  tokenStreamV2,
  tokenize as tokenizeV2,
} from './tokenizer-v2.js'
import { hasTemporalHint, resolveQueryDates, DEFAULT_TIME_ZONE } from './temporal.js'

// —— §4.1 分词 ——

/**
 * V1 分词原实现（双角色）：TOKENIZER_V2 关时的回退路径；开时是本模块内
 * **idf 盲集合运算**（blocking 共享计数、tokenJaccard）的固定口径。
 * NFKC + lowercase; latin runs of ≥2 chars keep `._-` joins as one token; CJK
 * runs become single chars when isolated, otherwise overlapping bigrams; the
 * result is deduplicated (a set — Jaccard/blocking only care about presence).
 * Build tf from tokenStream below, never from this.
 */
function tokenizeV1(text) {
  const s = String(text || '').normalize('NFKC').toLowerCase()
  const out = []
  for (const m of s.matchAll(/[a-z0-9]+(?:[._-][a-z0-9]+)*/g)) {
    if (m[0].length >= 2) out.push(m[0])
  }
  for (const m of s.matchAll(/[\u3400-\u9fff\uf900-\ufaff]+/g)) {
    const run = m[0]
    if (run.length === 1) out.push(run)
    else for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
  }
  return [...new Set(out)]
}

/** V1 token stream 原实现（无去重）——BM25 tf 的频率来源（回退路径）。 */
function tokenStreamV1(text) {
  const s = String(text || '').normalize('NFKC').toLowerCase()
  const out = []
  for (const m of s.matchAll(/[a-z0-9]+(?:[._-][a-z0-9]+)*/g)) {
    if (m[0].length >= 2) out.push(m[0])
  }
  for (const m of s.matchAll(/[\u3400-\u9fff\uf900-\ufaff]+/g)) {
    const run = m[0]
    if (run.length === 1) out.push(run)
    else for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
  }
  return out
}

/**
 * 对外分词入口（双轨制，P0-1）：TOKENIZER_V2 开 → 委托 lib/tokenizer-v2.js
 * （CJK unigram+bigram+trigram 三层 + 实体保护，Set 插入序数组）；关 → V1
 * 原路径。签名与语义兼容，返回去重 token 数组（插入序）。
 *
 * 消费口径分层（P0 基准回归修复）：V2 的增量 token **只进 BM25 流**（idf
 * 加权通道，unigram 的低 idf 由权重自然压掉，子词命中是纯收益）；idf 盲的
 * 集合运算——blocking 共享计数、tokenJaccard——固定 tokenizeV1（bigram+latin）。
 * unigram 同时喂给集合运算会把高频单字灌进倒排/共享计数（候选池被灌爆、
 * 集合重叠被拉平，Recall@10 0.7675→0.6375 的定量根因）。开关关时本入口
 * 本来就是 V1，关闭路径字节级不变。
 */
export function tokenize(text) {
  if (TOKENIZER_V2) return tokenizeV2(text)
  return tokenizeV1(text)
}

/**
 * Raw token stream (no dedupe) — the frequency source for BM25's tf.
 * 与 tokenize 同一开关：V2 → tokenStreamV2（与 tokenizeV2 同一生成器）；V1 →
 * tokenStreamV1。
 */
function tokenStream(text) {
  if (TOKENIZER_V2) return tokenStreamV2(text)
  return tokenStreamV1(text)
}

// —— §4.1 语料与 BM25 ——

/**
 * entries: [{ id, title, content, ...rest }] — every extra field travels on
 * doc.entry so callers can reach track/domain/appliesTo/updatedAt without a
 * second lookup. Returns { docs, df, inverted, avgdl, size }.
 */
export function buildCorpus(entries) {
  const docs = new Map()
  const df = new Map()
  const inverted = new Map()
  let totalLen = 0
  for (const entry of entries || []) {
    const id = entry?.id
    if (id == null || docs.has(id)) continue
    const stream = tokenStream(`${entry.title || ''} ${entry.content || ''}`)
    const tf = new Map()
    for (const term of stream) tf.set(term, (tf.get(term) || 0) + 1)
    docs.set(id, { id, tokens: new Set(stream), tf, len: stream.length, entry })
    totalLen += stream.length
    for (const term of tf.keys()) {
      df.set(term, (df.get(term) || 0) + 1)
      if (!inverted.has(term)) inverted.set(term, new Set())
      inverted.get(term).add(id)
    }
  }
  return {
    docs,
    df,
    inverted,
    avgdl: docs.size ? totalLen / docs.size : 0,
    size: docs.size,
  }
}

function idfOf(corpus, term) {
  const df = corpus.df.get(term) || 0
  return Math.log(1 + (corpus.size - df + 0.5) / (df + 0.5))
}

/**
 * §4.1 BM25 formula with the query-side frequency gate (A-2)。
 *
 * 每个 query term 独立判定，df 超过 dfCap 就整条不参与打分，其中
 * dfCap = max(BM25_DF_MIN_POOL, ceil(BM25_DF_RATIO × N))。
 * 只看占比会在极小语料上把查询词剔光（12 条记忆都含「会议」→ 占比 100% → 召回
 * 0 条，实测回归），所以下限取「一次召回至少会看的候选数」；只看绝对数又会把
 * 「20000 条里 100 条」这种真正有区分度的词误杀。V2 的 CJK unigram 让「的」「了」
 * 在小库和大库上都会撞线。
 * 剔除的是整个 term，不是把它的分数清零后继续保留条目：后者只换来一个恒定 0
 * 分的候选，候选池照样是全库。
 *
 * qtf（A-12）：query 侧保留重复 term 的频率并乘进分数。qtf=1 时与旧口径逐位
 * 相同，所以既有的精确数值断言不受影响；重复查询词只会放大它自己的贡献，不会
 * 倒挂 IDF——真正的高频词在闸门处已经被剔除。
 *
 * Queries wider than BM25_MAX_QUERY_TERMS keep only the 64 highest-IDF terms —
 * measured among terms the corpus actually knows (df > 0): an absent term scores
 * 0 no matter its nominal IDF, so letting it occupy the quota would only shrink
 * the effective query. Ties break by term.
 */
export function bm25(queryTokens, doc, corpus, { k1 = BM25_K1, b = BM25_B } = {}) {
  if (!queryTokens?.length || !doc || !corpus || corpus.size === 0) return 0
  const qtf = new Map()
  for (const term of queryTokens) {
    if (!corpus.df.has(term)) continue
    qtf.set(term, (qtf.get(term) || 0) + 1)
  }
  if (qtf.size === 0) return 0
  const dfCap = Math.max(BM25_DF_MIN_POOL, Math.ceil(BM25_DF_RATIO * corpus.size))
  let terms = []
  for (const [term, count] of qtf) {
    if ((corpus.df.get(term) || 0) > dfCap) continue
    terms.push({ term, qtf: count, idf: idfOf(corpus, term) })
  }
  if (terms.length === 0) return 0
  if (terms.length > BM25_MAX_QUERY_TERMS) {
    terms = terms
      .sort((a, b2) => b2.idf - a.idf || (a.term < b2.term ? -1 : 1))
      .slice(0, BM25_MAX_QUERY_TERMS)
  }
  let score = 0
  for (const { term, qtf: count, idf } of terms) {
    const tf = doc.tf.get(term) || 0
    if (!tf) continue
    score += idf * count * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * doc.len / corpus.avgdl))
  }
  return score
}

// —— §4.2 成对特征 ——

function entitySet(appliesTo) {
  const out = new Set()
  for (const item of Array.isArray(appliesTo) ? appliesTo : []) {
    const v = String(item || '').trim().toLowerCase()
    if (v) out.add(v)
  }
  return out
}

function normalizedTitle(entry) {
  return String(entry?.title || '').trim().toLowerCase()
}

/**
 * §4.2 pair features over two index-shaped entries
 * ({ title, content, track, domain, appliesTo }).
 *   charDice      — similarTexts(title+\n+content)：length-prune + containment floor
 *   containment   — the probe floor when the length prune fired, else 0
 *   lexical       — max(charDice, containment)
 *   tokenJaccard  — V1 口径 tokenize set Jaccard over title+content（idf 盲集合
 *                   运算固定 V1；V2 三层只服务 BM25，见 tokenize 的 JSDoc）
 *   titleDice     — bigram Dice over the raw titles
 *   titleExact    — trimmed/lowercase title equality (non-empty)
 *   entityJaccard — appliesTo set Jaccard; both empty → 0.5 neutral
 */
export function pairFeatures(a, b) {
  const aText = `${a?.title || ''}\n${a?.content || ''}`
  const bText = `${b?.title || ''}\n${b?.content || ''}`
  const detail = similarityDetail(aText, bText)
  return {
    charDice: detail.dice,
    containment: detail.containment,
    lexical: Math.max(detail.dice, detail.containment),
    // idf 盲集合运算固定 V1 口径：unigram 会把跨主题的高频单字重叠拉平
    // tokenJaccard 的区分度。开关关时 tokenize 本就返回 V1，两种写法等价。
    tokenJaccard: jaccard(new Set(tokenizeV1(aText)), new Set(tokenizeV1(bText))),
    titleDice: dice(bigrams(a?.title || ''), bigrams(b?.title || '')),
    titleExact: normalizedTitle(a) !== '' && normalizedTitle(a) === normalizedTitle(b),
    entityJaccard: entityScore(a?.appliesTo, b?.appliesTo),
    lengthGap: detail.lengthGap,
  }
}

function entityScore(aApplies, bApplies) {
  const a = entitySet(aApplies)
  const b = entitySet(bApplies)
  if (a.size === 0 && b.size === 0) return 0.5
  return jaccard(a, b)
}

/**
 * §4.2 weighted sum. Accepts a features object (preferred — pairFeatures is
 * already computed on hot paths) or the two entries directly.
 */
export function pairScore(aOrFeatures, b) {
  const f = aOrFeatures && typeof aOrFeatures === 'object' && 'lexical' in aOrFeatures
    ? aOrFeatures
    : pairFeatures(aOrFeatures, b)
  return PAIR_W_LEXICAL * f.lexical
    + PAIR_W_TOKEN * f.tokenJaccard
    + PAIR_W_TITLE * f.titleDice
    + PAIR_W_ENTITY * f.entityJaccard
}

function isRpCodingClash(aDomain, bDomain) {
  return (aDomain === 'rp' && bDomain === 'coding') || (aDomain === 'coding' && bDomain === 'rp')
}

/**
 * §4.2 pairDecision, verbatim bands:
 *   track differs                → none
 *   domain differs               → link only at pairScore ≥0.65（跨域只 link 不 absorb；
 *                                  rp↔coding 永不 link——§4.9 的校验层再拦一次）
 *   titleExact && lexical <0.55  → conflict（同标题正文迥异；lexical 而非裸 charDice，
 *                                  因为 §4.8 明确 containment ≥0.92 是重复/细化不是冲突）
 *   ≥0.90 duplicate / ≥0.82 absorb / ≥0.55 link / else none
 */
export function pairDecision(a, b, features = pairFeatures(a, b)) {
  if ((a?.track || 'memory') !== (b?.track || 'memory')) return 'none'
  const aDomain = a?.domain || 'unknown'
  const bDomain = b?.domain || 'unknown'
  const score = pairScore(features)
  if (aDomain !== bDomain) {
    if (isRpCodingClash(aDomain, bDomain)) return 'none'
    return score >= CROSS_DOMAIN_LINK_MIN ? 'link' : 'none'
  }
  if (features.titleExact && features.lexical < PAIR_LINK_MIN) return 'conflict'
  if (score >= PAIR_DUPLICATE_MIN) return 'duplicate'
  if (score >= PAIR_ABSORB_MIN) return 'absorb'
  if (score >= PAIR_LINK_MIN) return 'link'
  return 'none'
}

// —— §4.8 全局冲突预筛 ——

// Same pattern as memory.js's NEGATION_RE (not exported there; lib/memory.js is
// outside this package's edit scope). One ruler for "opposite claim". 整文本
// 口径保持原样（P0 前的既有行为，也是无锚点时的回退路径），词典不在此扩。
const NEGATION_RE = /不|没|别|无|never|not|no longer|doesn't|don't/i

/** True when the text carries a negation marker (memory.js findConflict 口径). */
export function negationPolarity(text) {
  return NEGATION_RE.test(String(text || ''))
}

// —— 子句级否定作用域（P1-2）——
//
// 整文本 negationPolarity 有两类误报：无关子句的否定污染（「截止日期是 5 月
// 1 日，别忘了」整条算否定侧）和双重否定（「不是不喜欢香菜」仍算否定侧）。
// polarityAt 把判定范围缩到锚点所在的子句，用标记计数 mod 2 近似否定作用域，
// 不做句法分析——同输入同输出，无 clock。

// 子句切分：中西标点一视同仁（连续标点算一次切分）。
const CLAUSE_SPLIT_RE = /[。！？；，、,.!?;:]+/

// 对比结构：「不是 A 而是 B」的 B、「不用 A 改成/换成 B」的 B 都是肯定侧，
// 前文标记的否定作用到对比词为止。
const CONTRAST_RE = /而不是|而是|改成|换成/g

// 否定标记词典。CJK 没有词边界（\b 对中文无效），靠最长优先的 alternation
// 保证「不再」「没有」只数一次而不是拆成「不」+「再」；「非常/未来/别的」
// 与否定标记同形但不是否定（高频词），用 lookahead 排除。英文统一用 \b 包住
// （缩写以 't 结尾，\b 仍成立；不 \b 的话 'not' 会命中 another/desktop）。
const NEG_MARKER_RE = /禁止|不得|无法|不能|不再|从不|从未|并不|并非|没有|拒绝|反对|不|没|别(?!的)|无|未(?!来)|勿|莫|非(?!常)|\b(?:not|never|no longer|cannot|without|avoid|refuse|stop|doesn't|don't|won't|can't)\b/gi

/**
 * 一个子句内、锚点所在片段是否为否定侧。对比词把子句切成片段，逐片段判定：
 * 片段自带标记计数（奇数 → 否定）；「而不是」引出的片段额外继承 1 个否定
 * （「而不是队列」的队列仍是否定侧，等价于标记紧邻锚点前不被对比词隔断的
 * 场景），「而是/改成/换成」引出的片段从 0 起算。锚点在同片段多次出现只按
 * 片段判定一次，锚点落在多个片段时任一片段否定即为否定（保守）。
 */
function segmentNegated(clause, needle) {
  const segments = []
  let last = 0
  let inherit = false
  for (const m of clause.matchAll(CONTRAST_RE)) {
    segments.push({ text: clause.slice(last, m.index), inherit })
    inherit = m[0] === '而不是'
    last = m.index + m[0].length
  }
  segments.push({ text: clause.slice(last), inherit })
  for (const segment of segments) {
    if (!segment.text.includes(needle)) continue
    let markers = 0
    for (const _ of segment.text.matchAll(NEG_MARKER_RE)) markers += 1
    if ((markers + (segment.inherit ? 1 : 0)) % 2 === 1) return true
  }
  return false
}

/**
 * 子句级否定极性（P1-2）：text 里 anchor 所在的每个子句，任一为否定即算否定
 * 侧（锚点多次出现取保守口径）。子句切分与标记匹配都在 NFKC + lowercase 之后
 * 进行——锚点来自 tokenize（同一规范化），latin 大小写/全角差异不会漏匹配。
 * 锚点为空或不在 text 中出现 → false（没有可判定的作用域就不是否定侧）。
 */
export function polarityAt(text, anchor) {
  const needle = String(anchor || '').normalize('NFKC').toLowerCase()
  if (!needle) return false
  const s = String(text || '').normalize('NFKC').toLowerCase()
  for (const clause of s.split(CLAUSE_SPLIT_RE)) {
    if (clause.includes(needle) && segmentNegated(clause, needle)) return true
  }
  return false
}

/** 数字、周X/星期X、YYYY-MM-DD、M月D日 —— 抽出来比集合（§4.8 numericSetsDiffer）。 */
export function numericSet(text) {
  const s = String(text || '')
  const out = new Set()
  for (const m of s.matchAll(/\d{4}-\d{1,2}-\d{1,2}/g)) out.add(m[0])
  for (const m of s.matchAll(/\d{1,2}月\d{1,2}[日号]/g)) out.add(m[0])
  for (const m of s.matchAll(/周[一二三四五六日天]|星期[一二三四五六日天]/g)) out.add(m[0])
  for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) out.add(m[0])
  return out
}

export function numericSetsDiffer(a, b) {
  const sa = numericSet(a)
  const sb = numericSet(b)
  if (sa.size === 0 || sb.size === 0) return false
  for (const item of sa) if (!sb.has(item)) return true
  for (const item of sb) if (!sa.has(item)) return true
  return false
}

/**
 * 冲突锚点：双方 body 的共享 token 里最长者（长度相同取字典序最小，完全确定，
 * 与遍历序无关）。token 来自当前生效的 tokenize（双轨开关自动生效），只要求
 * 子串包含关系（clause.includes(anchor)）——锚点本身就是文本的子串，CJK
 * unigram/bigram 与 latin 词都覆盖。无共享词返回 ''（调用方回退整文本口径）。
 */
export function longestSharedToken(aBody, bBody) {
  const bTokens = new Set(tokenize(bBody))
  let anchor = ''
  for (const token of new Set(tokenize(aBody))) {
    if (!bTokens.has(token)) continue
    if (token.length > anchor.length || (token.length === anchor.length && token < anchor)) anchor = token
  }
  return anchor
}

/**
 * §4.8 全局冲突预筛（同 domain/track 前提由调用方保证）。返回 'same_title' |
 * 'negation' | 'value' 或 null。containment ≥0.92 或 charDice ≥0.95 一票豁免
 * （重复/细化，不是冲突）。预筛只决定“送不送人审”，最终由 LLM + 人审裁决。
 *
 * negation 分支（P1-2）：有共享锚点 → 双方 polarityAt(body, anchor) 不同才算
 * 否定冲突（子句级作用域，修掉「无关子句否定污染」与「双重否定」两类误报）；
 * 无共享锚点 → 回退整文本 negationPolarity 对比（原口径，行为不变）。
 */
export function globalConflictCheck(a, b, features = pairFeatures(a, b)) {
  if (features.containment >= 0.92 || features.charDice >= 0.95) return null
  if (features.titleExact && features.charDice < 0.95) return 'same_title'
  const aBody = String(a?.content || '')
  const bBody = String(b?.content || '')
  if (features.charDice >= 0.55) {
    const anchor = longestSharedToken(aBody, bBody)
    const differs = anchor
      ? polarityAt(aBody, anchor) !== polarityAt(bBody, anchor)
      : negationPolarity(aBody) !== negationPolarity(bBody)
    if (differs) return 'negation'
  }
  if (features.titleDice >= 0.8 && features.charDice >= 0.55
    && numericSetsDiffer(`${a?.title || ''} ${aBody}`, `${b?.title || ''} ${bBody}`)) return 'value'
  return null
}

// —— §4.3 候选召回 ——

function trackOf(entry) {
  return entry?.track || 'memory'
}

function updatedDesc(a, b) {
  return String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || ''))
}

function idAsc(a, b) {
  return String(a.id).localeCompare(String(b.id))
}

/**
 * 标准竞赛排名（1,2,2,4）：并列分数共享同一名次，后续名次跳号。
 * metricOf 返回参与并列判定的值（数组按值拼成键）——排序里的 id/键 tiebreak
 * 只负责让输出完全确定，不再把同分文档强行排成不同名次。RRF 是按名次加权
 * 融合的，给并列者不同名次等于凭空制造分差。
 */
function competitionRanks(sorted, metricOf) {
  const ranks = new Map()
  let previous = null
  let rank = 0
  sorted.forEach((item, index) => {
    const metric = metricOf(item)
    const key = Array.isArray(metric) ? metric.join('\u0000') : String(metric)
    if (key !== previous) {
      rank = index + 1
      previous = key
    }
    ranks.set(item.id ?? item.key, rank)
  })
  return ranks
}

/** 两个 token 集的交集大小（不构造第三个集合）：blocking 的便宜预筛。 */
function sharedTokenCount(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const token of small) if (large.has(token)) shared += 1
  return shared
}

/**
 * §4.3 rankPairCandidates({ corpus, proposal, limit })。
 *
 * 1) blocking：同 track；N ≤ exactPairLimit 时精确两两，否则查询 token 中
 *    df ≤ 30%N 的稀有词、共享 ≥2 token，或 exact title。
 * 2) 三路排名 bm25 / charDice / entityJaccard（tiebreak containment）。
 * 3) 加权 RRF(k=60)。RRF_DYNAMIC 开 → 权重来自 computeRRFWeights(proposal,
 *    corpus)：普通查询退化为静态 0.5/0.3/0.2，近期查询加第四路 recency
 *    （候选按 updatedAt 降序排名），coding 域 entity 提权；关 → 恒用静态
 *    0.5/(60+rankBm25) + 0.3/(60+rankDice) + 0.2/(60+rankEntity)。
 * 4) RRF 代理切分 + 边界带 → pairScore 真尺终选：前 max 名进评分集，与切点
 *    rrf 之差 ≤ RRF_SLICE_BAND 的候选并入（总量 ≤ max×RRF_SLICE_BAND_CAP），
 *    全部算 pairFeatures/pairScore，按 pairScore 降序截取前 max——近重复簇里
 *    rrf 平刀锋时 len 归一噪声不再决定准入。
 * 5) 不足 limit 用同域最近条目补齐（“多看几眼”，不降低门槛）。
 *
 * 返回 [{ id, entry, score, decision, features, rrf, fallback }]，score 降序，
 * 平手 rrf 降序 → id 升序——完全确定（动态路径的 recency 排名同样带
 * idAsc tiebreak，不引入任何 clock/随机性）。
 */
export function rankPairCandidates({ corpus, proposal, limit = PAIR_SCAN_LIMIT }) {
  const max = Number(limit) > 0 ? Math.floor(Number(limit)) : PAIR_SCAN_LIMIT
  const out = []
  if (!corpus || corpus.size === 0 || !proposal) return out
  const n = corpus.size
  const proposalTrack = trackOf(proposal)
  const proposalDomain = proposal?.domain || 'unknown'
  const proposalTitle = normalizedTitle(proposal)
  const proposalId = proposal?.id ?? null
  const queryText = `${proposal.title || ''} ${proposal.content || ''}`
  // BM25 查询词用当前生效分词（V2 三层在这里是收益）；blocking 是 idf 盲的
  // 共享计数，走下面的 V1 口径。
  const queryTokens = tokenize(queryText)

  // 1) blocking
  const candidates = new Map()
  if (n <= CLUSTER_EXACT_PAIR_LIMIT) {
    for (const doc of corpus.docs.values()) {
      if (proposalId != null && doc.id === proposalId) continue
      if (trackOf(doc.entry) !== proposalTrack) continue
      candidates.set(doc.id, 0)
    }
  } else {
    const dfCap = Math.ceil(BLOCK_DF_RATIO * n)
    const shared = new Map()
    // blocking 固定 V1 口径（bigram+latin）：V1 token ⊆ V2 token，V2 建的
    // corpus.inverted 照样命中，bigram 的 posting/df 也不受 unigram 膨胀影响；
    // 若用 V2 查询，高频单字会让无关条目凑满 ≥2 共享词，候选池被灌爆、
    // target 被挤出 RRF 前 limit 切片（基准 Recall 池命中 0.985→0.8625 的主因）。
    for (const term of tokenizeV1(queryText)) {
      const posting = corpus.inverted.get(term)
      if (!posting || posting.size === 0 || posting.size > dfCap) continue
      for (const id of posting) {
        if (proposalId != null && id === proposalId) continue
        shared.set(id, (shared.get(id) || 0) + 1)
      }
    }
    for (const [id, count] of shared) {
      if (count >= CLUSTER_BLOCK_MIN_SHARED) candidates.set(id, count)
    }
    if (proposalTitle) {
      for (const doc of corpus.docs.values()) {
        if (proposalId != null && doc.id === proposalId) continue
        if (trackOf(doc.entry) !== proposalTrack) continue
        if (normalizedTitle(doc.entry) === proposalTitle) candidates.set(doc.id, Math.max(candidates.get(doc.id) || 0, CLUSTER_BLOCK_MIN_SHARED))
      }
    }
  }
  if (candidates.size === 0) return backfill({ corpus, proposal, proposalDomain, proposalId, max, out: [], taken: new Set(), queryTokens })

  // 2) three rankings
  const ids = [...candidates.keys()]
  const bm25Scores = ids.map((id) => ({ id, s: bm25(queryTokens, corpus.docs.get(id), corpus) }))
  bm25Scores.sort((a, b) => b.s - a.s || idAsc(a, b))
  const rankBm25 = competitionRanks(bm25Scores, (item) => item.s)

  const probes = ids.map((id) => {
    const doc = corpus.docs.get(id)
    const detail = similarityDetail(`${proposal.title || ''}\n${proposal.content || ''}`, `${doc.entry?.title || ''}\n${doc.entry?.content || ''}`)
    return { id, diceScore: detail.dice, containment: detail.containment, lexical: Math.max(detail.dice, detail.containment) }
  })
  const diceRankOrder = [...probes].sort((a, b) => b.diceScore - a.diceScore || b.containment - a.containment || idAsc(a, b))
  // 并列按 (diceScore, containment) 判定：两个分量都相同才算同分，id 只是
  // 输出顺序的确定性 tiebreak。
  const rankDice = competitionRanks(diceRankOrder, (item) => [item.diceScore, item.containment])

  const entityOrder = ids.map((id) => {
    const doc = corpus.docs.get(id)
    return {
      id,
      entity: entityScore(proposal.appliesTo, doc.entry?.appliesTo),
      containment: containmentOf(proposal, doc.entry),
    }
  }).sort((a, b) => b.entity - a.entity || b.containment - a.containment || idAsc(a, b))
  const rankEntity = competitionRanks(entityOrder, (item) => [item.entity, item.containment])

  // 3) weighted RRF。开关关 → 静态三路原式（字节级回退路径）；开 → 权重来自
  // computeRRFWeights，含 recency 键时加第四路 updatedAt 降序排名。
  let rrf
  if (!RRF_DYNAMIC) {
    rrf = new Map()
    for (const id of ids) {
      rrf.set(id, RRF_W_BM25 / (RRF_K + rankBm25.get(id))
        + RRF_W_DICE / (RRF_K + rankDice.get(id))
        + RRF_W_ENTITY / (RRF_K + rankEntity.get(id)))
    }
  } else {
    const weights = computeRRFWeights(proposal, corpus)
    const rankRecency = new Map()
    if (weights.recency != null) {
      // 第四路：updatedAt 字符串降序（updatedDesc + idAsc tiebreak，与 backfill
      // 同一确定性口径）；rank 为 1 起的稠密序，只覆盖 blocking 后的候选集。
      const recencyOrder = ids
        .map((id) => ({ id, entry: corpus.docs.get(id).entry }))
        .sort((a, b) => updatedDesc(a.entry, b.entry) || idAsc(a, b))
      const ranked = competitionRanks(recencyOrder, (item) => String(item.entry?.updatedAt || ''))
      for (const [id, rank] of ranked) rankRecency.set(id, rank)
    }
    rrf = new Map()
    for (const id of ids) {
      let value = weights.bm25 / (RRF_K + rankBm25.get(id))
        + weights.dice / (RRF_K + rankDice.get(id))
        + weights.entity / (RRF_K + rankEntity.get(id))
      if (weights.recency != null) value += weights.recency / (RRF_K + rankRecency.get(id))
      rrf.set(id, value)
    }
  }
  ids.sort((a, b) => rrf.get(b) - rrf.get(a) || idAsc(a, b))

  // 4) features for the scored slice（P0-1 回归修复：准入从 RRF 代理换成
  // pairScore 真尺）。pre-cut 用 RRF 代理决定谁进入完整 pairFeatures/pairScore
  // 评分；近重复簇里 rrf 平刀锋时（bench 实测缝 3.6e-5），len 归一噪声决定
  // 准入，pairScore 更准的候选反而落榜。修法：与切点 rrf 之差 ≤
  // RRF_SLICE_BAND 的候选并入评分集（总量 ≤ max×RRF_SLICE_BAND_CAP，防病态
  // 全带，超限按 rrf 降序 + idAsc 截断），评分集全部评分后按 pairScore 降序
  // 截取前 max——准入决策从代理换真尺，返回数量语义不变（≤max）。开关关/开
  // 同轨生效（这是准入结构的改进，不分轨）。
  const cutIndex = Math.min(max, ids.length) - 1
  const bandFloor = rrf.get(ids[cutIndex]) - RRF_SLICE_BAND
  let scoredIds = []
  for (const id of ids) {
    if (rrf.get(id) < bandFloor) break // ids 已按 (rrf desc, idAsc) 排序，后面只会更低
    scoredIds.push(id)
  }
  const bandCap = max * RRF_SLICE_BAND_CAP
  if (scoredIds.length > bandCap) scoredIds = scoredIds.slice(0, bandCap)
  const taken = new Set()
  for (const id of scoredIds) {
    const doc = corpus.docs.get(id)
    const features = pairFeatures(proposal, doc.entry)
    const score = pairScore(features)
    taken.add(id)
    out.push({ id, entry: doc.entry, score, decision: pairDecision(proposal, doc.entry, features), features, rrf: rrf.get(id), fallback: false })
  }
  out.sort((a, b) => b.score - a.score || b.rrf - a.rrf || idAsc(a, b))
  // 真尺终选：评分集可能因边界带超过 max，按 pairScore 降序截取前 max
  if (out.length > max) out.length = max
  // 5) same-domain recent backfill — extra eyes, never a lower bar
  return backfill({ corpus, proposal, proposalDomain, proposalId, max, out, taken, queryTokens })
}

function containmentOf(a, b) {
  const detail = similarityDetail(`${a?.title || ''}\n${a?.content || ''}`, `${b?.title || ''}\n${b?.content || ''}`)
  return detail.containment
}

function backfill({ corpus, proposal, proposalDomain, proposalId, max, out, taken, queryTokens }) {
  if (out.length >= max) return out
  const recent = [...corpus.docs.values()]
    .filter((doc) => proposalId == null || doc.id !== proposalId)
    .filter((doc) => (doc.entry?.domain || 'unknown') === proposalDomain)
    .filter((doc) => !taken.has(doc.id))
    .sort((a, b) => updatedDesc(a.entry, b.entry) || idAsc(a, b))
  for (const doc of recent) {
    if (out.length >= max) break
    const features = pairFeatures(proposal, doc.entry)
    const score = pairScore(features)
    taken.add(doc.id)
    out.push({ id: doc.id, entry: doc.entry, score, decision: pairDecision(proposal, doc.entry, features), features, rrf: 0, fallback: true })
  }
  out.sort((a, b) => b.score - a.score || b.rrf - a.rrf || idAsc(a, b))
  return out
}

// —— §4.4 候选簇 ——

function pairKey(aId, bId) {
  return aId < bId ? `${aId}\u0000${bId}` : `${bId}\u0000${aId}`
}

function round2(value) {
  return Math.round(value * 100) / 100
}

/**
 * §4.4 buildCandidateClusters(index, options)。
 *
 * 1) active 条目按 updatedAt 降序取最近 recentLimit(2000) 条，按 track 分组。
 * 2) 同 track 内：N ≤ exactPairLimit(300) 全对；否则倒排 blocking（df ≤
 *    30%N 的 posting、共享 ≥ blockMinShared(2) token，收集总量 ≤
 *    CLUSTER_MAX_PAIRS 的硬上限）。
 * 3) 共享 token 为 0 的对先被预筛，其余算 pairFeatures/pairScore，保留
 *    ≥ minPairScore(0.55) 的边。
 * 4) 边排序用三路 RRF（同 §4.3：bm25 双向和 / charDice / entityJaccard）。
 * 5) 贪心成簇：边按 RRF 降序；种子=边两端；新成员必须与簇内**所有**成员
 *    pairScore ≥ 0.55（全对约束，禁传递闭包）；每簇 ≤6；每条目只进一个簇。
 * 6) medoid = 成员两两平均分最高者（平手 updatedAt 降序 → id 升序）。
 * 7) suggested_op：≥3 成员且 avg ≥0.82 且同 domain → absorb；2+ 成员且
 *    avg ≥0.55 → link；否则 none。medoid 平均 <0.55 整簇丢弃。
 * 8) 按 avg_score 降序最多输出 maxClusters(12) 簇。
 *
 * 返回 { clusters, truncated, scanned }。
 */
export function buildCandidateClusters(index, options = {}) {
  const maxClusters = options.maxClusters ?? CLUSTER_MAX
  const maxMembers = options.maxMembers ?? CLUSTER_MAX_MEMBERS
  const minPair = options.minPairScore ?? CLUSTER_MIN_PAIR
  const blockMinShared = options.blockMinShared ?? CLUSTER_BLOCK_MIN_SHARED
  const exactPairLimit = options.exactPairLimit ?? CLUSTER_EXACT_PAIR_LIMIT
  const recentLimit = options.recentLimit ?? CLUSTER_RECENT_LIMIT

  const active = Object.entries(index?.entries || index || {})
    .filter(([, e]) => e && e.status === 'active')
    .map(([id, entry]) => ({ id, entry }))
    .sort((a, b) => updatedDesc(a.entry, b.entry) || idAsc(a, b))
  const truncated = active.length > recentLimit
  const pool = active.slice(0, recentLimit)

  const byTrack = new Map()
  for (const item of pool) {
    const track = trackOf(item.entry)
    if (!byTrack.has(track)) byTrack.set(track, [])
    byTrack.get(track).push(item)
  }

  // edges: { a, b, aId, bId, features, score, rrf }
  const edges = []
  for (const [track, items] of byTrack) {
    const n = items.length
    if (n < 2) continue
    const tokenSets = new Map()
    const streams = new Map()
    const inverted = new Map()
    for (const item of items) {
      // blocking 倒排固定 V1 口径（idf 盲集合运算）：unigram 会把高频单字灌大
      // 倒排与两两共享计数（N=500 簇延迟 +60% 的根因），对成簇质量无收益。
      // 边打分的 BM25 路由（下方 bm25Route/buildCorpus）仍走 V2 流。
      const text = `${item.entry?.title || ''} ${item.entry?.content || ''}`
      const tokens = tokenizeV1(text)
      tokenSets.set(item.id, new Set(tokens))
      // BM25 流只算一次：pairList 里同一条目会出现在许多对中，逐对重算
      // tokenStream 是另一份 O(N²) 的浪费。
      streams.set(item.id, tokenStream(text))
      for (const term of tokens) {
        if (!inverted.has(term)) inverted.set(term, [])
        inverted.get(term).push(item.id)
      }
    }
    const byId = new Map(items.map((item) => [item.id, item]))
    const pairSet = new Set()
    if (n <= exactPairLimit) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) pairSet.add(pairKey(items[i].id, items[j].id))
      }
    } else {
      // 倒排层剪枝（A-1）：与 rankPairCandidates 同口径的 dfCap。中文常用字
      // bigram 的 posting 几乎覆盖全库，不剪枝时每个 posting 都展开成 N²/2 个
      // 对——这才是 N=500 要 5.8s 的根因，不是 similarityDetail 本身慢。
      // 被跳过的是整条 posting（倒排表层面的剪枝），不涉及候选门槛。
      const dfCap = Math.ceil(BLOCK_DF_RATIO * n)
      const shared = new Map()
      // 硬上限（CLUSTER_MAX_PAIRS）是防御性的：df 剪枝之后仍可能有大量中等
      // 频率词留下 O(N²) 的对，超过上限就停止收集**新**对（已收集的计数继续
      // 累加）。倒排按条目插入序遍历，截断位置确定 → 输出仍可复现。上限必须在
      // 内层检查：单个 posting（≤dfCap 条）自身就可能超过它。
      collectPairs: for (const posting of inverted.values()) {
        if (posting.length < 2 || posting.length > dfCap) continue
        for (let i = 0; i < posting.length; i++) {
          for (let j = i + 1; j < posting.length; j++) {
            const key = pairKey(posting[i], posting[j])
            const count = shared.get(key)
            if (count === undefined) {
              if (shared.size >= CLUSTER_MAX_PAIRS) break collectPairs
              shared.set(key, 1)
            } else {
              shared.set(key, count + 1)
            }
          }
        }
      }
      for (const [key, count] of shared) {
        if (count >= blockMinShared) pairSet.add(key)
      }
    }
    if (pairSet.size === 0) continue

    const corpus = buildCorpus(items.map((item) => ({ id: item.id, title: item.entry?.title || '', content: item.entry?.content || '', entry: item.entry })))
    // 便宜预筛：共享 token 为 0 的对直接跳过，连 similarityDetail（bigram 集
    // 构建 + 长度探针）都不进。它只剔除没有任何共享词元（V1 口径）的候选，
    // 不降低最终 pairScore 门槛。
    const pairList = []
    for (const key of pairSet) {
      const [aId, bId] = key.split('\u0000')
      const aItem = byId.get(aId)
      const bItem = byId.get(bId)
      if (sharedTokenCount(tokenSets.get(aId), tokenSets.get(bId)) === 0) continue
      const features = pairFeatures(aItem.entry, bItem.entry)
      const score = pairScore(features)
      if (score < minPair) continue
      pairList.push({ key, aId, bId, aItem, bItem, features, score })
    }
    if (pairList.length === 0) continue

    // three route rankings for edge order only。
    // 刻意不做动态权重（P0-2 只落在 rankPairCandidates）：buildCandidateClusters
    // 没有 proposal/查询上下文——它是无监督的全库成簇，三路 RRF 只决定贪心
    // 长簇的边访问顺序；引入「查询类型」没有语义落点，静态三路保证簇构建
    // 与查询无关、完全可复现。并列分数共享同一名次（A-12）。
    const bm25Route = pairList.map((pair) => ({
      key: pair.key,
      s: bm25(streams.get(pair.aId), corpus.docs.get(pair.bId), corpus)
        + bm25(streams.get(pair.bId), corpus.docs.get(pair.aId), corpus),
    })).sort((a, b) => b.s - a.s || (a.key < b.key ? -1 : 1))
    const rankBm25 = competitionRanks(bm25Route, (item) => item.s)
    const diceRoute = [...pairList].sort((a, b) => b.features.charDice - a.features.charDice
      || b.features.containment - a.features.containment || (a.key < b.key ? -1 : 1))
    const rankDice = competitionRanks(diceRoute, (item) => [item.features.charDice, item.features.containment])
    const entityRoute = [...pairList].sort((a, b) => b.features.entityJaccard - a.features.entityJaccard
      || b.features.containment - a.features.containment || (a.key < b.key ? -1 : 1))
    const rankEntity = competitionRanks(entityRoute, (item) => [item.features.entityJaccard, item.features.containment])
    for (const pair of pairList) {
      pair.rrf = RRF_W_BM25 / (RRF_K + rankBm25.get(pair.key))
        + RRF_W_DICE / (RRF_K + rankDice.get(pair.key))
        + RRF_W_ENTITY / (RRF_K + rankEntity.get(pair.key))
    }
    pairList.sort((a, b) => b.rrf - a.rrf || b.score - a.score || (a.key < b.key ? -1 : 1))
    edges.push(...pairList)
  }

  // greedy all-pairs clique growth
  edges.sort((a, b) => b.rrf - a.rrf || b.score - a.score || (a.key < b.key ? -1 : 1))
  const memberOf = new Map()
  const clusters = []
  for (const edge of edges) {
    const clusterA = memberOf.get(edge.aId)
    const clusterB = memberOf.get(edge.bId)
    if (clusterA && clusterB) continue
    if (!clusterA && !clusterB) {
      if (clusters.length >= maxClusters) continue
      const cluster = { members: [edge.aItem, edge.bItem], scores: new Map([[edge.key, edge.score]]) }
      clusters.push(cluster)
      memberOf.set(edge.aId, cluster)
      memberOf.set(edge.bId, cluster)
      continue
    }
    const cluster = clusterA || clusterB
    if (cluster.members.length >= maxMembers) continue
    const candidate = clusterA ? edge.bItem : edge.aItem
    let ok = true
    for (const member of cluster.members) {
      const key = pairKey(candidate.id, member.id)
      let score = cluster.scores.get(key)
      if (score == null) {
        score = pairScore(pairFeatures(candidate.entry, member.entry))
        cluster.scores.set(key, score)
      }
      if (score < minPair) { ok = false; break }
    }
    if (!ok) continue
    cluster.members.push(candidate)
    memberOf.set(candidate.id, cluster)
  }

  // medoid + output
  const out = []
  for (const cluster of clusters) {
    const members = [...cluster.members].sort((a, b) => idAsc(a, b))
    const pairScores = {}
    let sum = 0
    let count = 0
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const key = pairKey(members[i].id, members[j].id)
        let score = cluster.scores.get(key)
        if (score == null) {
          score = pairScore(pairFeatures(members[i].entry, members[j].entry))
          cluster.scores.set(key, score)
        }
        pairScores[`${members[i].id}|${members[j].id}`] = round2(score)
        sum += score
        count += 1
      }
    }
    const avg = count ? sum / count : 0
    let medoid = null
    let bestAvg = -1
    for (const member of members) {
      let mSum = 0
      for (const other of members) {
        if (other.id === member.id) continue
        const key = pairKey(member.id, other.id)
        mSum += cluster.scores.get(key) ?? 0
      }
      const mAvg = members.length > 1 ? mSum / (members.length - 1) : 0
      if (mAvg > bestAvg + 1e-9
        || (Math.abs(mAvg - bestAvg) <= 1e-9 && medoid
          && (updatedDesc(member.entry, medoid.entry) < 0
            || (updatedDesc(member.entry, medoid.entry) === 0 && String(member.id).localeCompare(String(medoid.id)) < 0)))) {
        bestAvg = mAvg
        medoid = member
      }
    }
    // medoid 平均 <0.55 → 整簇不输出（§4.4.9；全对约束下属防御分支）
    if (members.length > 1 && bestAvg < minPair) continue
    const sameDomain = members.every((m) => (m.entry?.domain || 'unknown') === (members[0].entry?.domain || 'unknown'))
    const suggestedOp = members.length >= 3 && avg >= PAIR_ABSORB_MIN && sameDomain
      ? 'absorb'
      : (members.length >= 2 && avg >= minPair ? 'link' : 'none')
    out.push({
      cluster_id: '',
      members: members.map((m) => ({
        id: m.id,
        title: m.entry?.title || '',
        track: trackOf(m.entry),
        domain: m.entry?.domain || 'unknown',
        updatedAt: m.entry?.updatedAt || null,
        content: m.entry?.content || '',
      })),
      pair_scores: pairScores,
      medoid_id: medoid?.id || members[0]?.id || '',
      avg_score: round2(avg),
      suggested_op: suggestedOp,
    })
  }
  out.sort((a, b) => b.avg_score - a.avg_score || String(a.medoid_id).localeCompare(String(b.medoid_id)))
  for (let i = 0; i < out.length; i++) out[i].cluster_id = `cl-${i + 1}`
  return { clusters: out.slice(0, maxClusters), truncated, scanned: pool.length }
}

// —— S5 查询意图与分解 ——
//
// 召回入口只需要知道“这句话在问哪一类事”，然后决定过滤与取数策略：
//   date       时间题：先解析相对日期，按 absolute_date 过滤/排序
//   entity     实体题：抽出实体名/别名，按实体索引扩展一跳
//   conflict   冲突题：按 fact_key / conflicts_with 成对取
//   commitment 约定题：未完成/到期承诺优先
//   boundary   边界题：只有用户明确问到时才注入 only_if_asked
//   general    普通题
// 纯规则，无外部模型，无网络；识别不出来就是 general，不猜。

const CONFLICT_RE = /矛盾|冲突|到底|哪一版|哪个版本|哪边|前后说法|说法不一|改口|不一致|不是说|谁对|真的吗|相反|contradict|conflict|which version/i
const COMMITMENT_RE = /答应|承诺|约定|说好|欠|兑现|到期|还没|什么时候还|做到|提醒我|promise|commitment|owe/i
const BOUNDARY_RE = /秘密|保密|别说|别告诉|不要告诉|不能说|不能提|隐私|瞒着|never[-_ ]?say|only if asked|secret/i
const DATE_QUERY_RE = /什么时候|哪天|几号|日期|时间|多久|几点|星期几|上次|之前|后来|最近|when|what time|which day/i

/**
 * @returns {'date'|'entity'|'conflict'|'commitment'|'boundary'|'general'}
 */
export function detectQueryIntent(query, { now = new Date(), timeZone = DEFAULT_TIME_ZONE, knownEntities = [] } = {}) {
  const text = String(query || '').trim()
  if (!text) return 'general'
  if (CONFLICT_RE.test(text)) return 'conflict'
  if (COMMITMENT_RE.test(text)) return 'commitment'
  if (BOUNDARY_RE.test(text)) return 'boundary'
  if (hasTemporalHint(text) || DATE_QUERY_RE.test(text) || /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(text)) return 'date'
  if (extractQueryEntities(text, { knownEntities }).length > 0) return 'entity'
  return 'general'
}

const QUOTED_RE = /["“”「」『』]([^"“”「」『』]{2,30})["“”「」『』]/g
const AT_RE = /@([\w\u4e00-\u9fff-]{2,30})/g

/** 实体抽取只用“明确标注”的名字：引号、@、已知实体表。宁缺毋滥。 */
export function extractQueryEntities(query, { knownEntities = [] } = {}) {
  const text = String(query || '')
  const found = []
  const add = (value) => {
    const name = String(value || '').trim()
    if (name.length < 2 || name.length > 30) return
    if (!found.includes(name)) found.push(name)
  }
  for (const match of text.matchAll(QUOTED_RE)) add(match[1])
  for (const match of text.matchAll(AT_RE)) add(match[1])
  for (const name of Array.isArray(knownEntities) ? knownEntities : []) {
    if (typeof name === 'string' && name.trim().length >= 2 && text.includes(name)) add(name)
  }
  return found.slice(0, 6)
}

/**
 * 把查询拆成召回能直接用的零件。`expanded` 是拼给词法/向量检索的查询，
 * `dates`/`entities` 同时供过滤与排序使用。
 */
export function decomposeQuery(query, intent = null, { now = new Date(), timeZone = DEFAULT_TIME_ZONE, knownEntities = [] } = {}) {
  const text = String(query || '')
  const resolvedIntent = intent || detectQueryIntent(text, { now, timeZone, knownEntities })
  const dates = resolveQueryDates(text, { now, timeZone })
  const entities = extractQueryEntities(text, { knownEntities })
  const terms = [...new Set([...dates, ...entities])]
  return {
    query: text,
    intent: resolvedIntent,
    dates,
    entities,
    terms,
    expanded: [text, ...terms].filter(Boolean).join(' ').trim(),
  }
}
