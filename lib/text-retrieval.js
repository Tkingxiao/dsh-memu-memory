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
// shared similarity ruler) and lib/curator-policy.js (the single constant
// table). No state, no IO, no clock — same input, same output, always.

import {
  bigrams,
  dice,
  lengthGap,
  similarityDetail,
  similarTexts,
} from './text-similarity.js'
import {
  BM25_B,
  BM25_K1,
  BM25_MAX_QUERY_TERMS,
  BLOCK_DF_RATIO,
  CLUSTER_BLOCK_MIN_SHARED,
  CLUSTER_EXACT_PAIR_LIMIT,
  CLUSTER_MAX,
  CLUSTER_MAX_MEMBERS,
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
  RRF_K,
  RRF_W_BM25,
  RRF_W_DICE,
  RRF_W_ENTITY,
} from './curator-policy.js'

// —— §4.1 分词 ——

/**
 * Verbatim §4.1: NFKC + lowercase; latin runs of ≥2 chars keep `._-` joins as
 * one token; CJK runs become single chars when isolated, otherwise overlapping
 * bigrams; the result is deduplicated (a set — Jaccard/blocking only care
 * about presence). Build tf from tokenStream below, never from this.
 */
export function tokenize(text) {
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

/** Raw token stream (no dedupe) — the frequency source for BM25's tf. */
function tokenStream(text) {
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
 * Verbatim §4.1 formula. Queries wider than BM25_MAX_QUERY_TERMS keep only the
 * 64 highest-IDF terms — measured among terms the corpus actually knows
 * (df > 0): an absent term scores 0 no matter its nominal IDF, so letting it
 * occupy the quota would only shrink the effective query. Ties break by term.
 */
export function bm25(queryTokens, doc, corpus, { k1 = BM25_K1, b = BM25_B } = {}) {
  if (!queryTokens?.length || !doc || !corpus || corpus.size === 0) return 0
  let terms = [...new Set(queryTokens)].filter((term) => corpus.df.has(term))
  if (terms.length === 0) return 0
  if (terms.length > BM25_MAX_QUERY_TERMS) {
    terms = terms
      .map((term) => ({ term, idf: idfOf(corpus, term) }))
      .sort((a, b2) => b2.idf - a.idf || (a.term < b2.term ? -1 : 1))
      .slice(0, BM25_MAX_QUERY_TERMS)
      .map((item) => item.term)
  }
  let score = 0
  for (const term of terms) {
    const tf = doc.tf.get(term) || 0
    if (!tf) continue
    const idf = idfOf(corpus, term)
    score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * doc.len / corpus.avgdl))
  }
  return score
}

// —— §4.2 成对特征 ——

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const item of a) if (b.has(item)) shared += 1
  return shared / (a.size + b.size - shared)
}

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
 *   tokenJaccard  — tokenize() set Jaccard over title+content
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
    tokenJaccard: jaccard(new Set(tokenize(aText)), new Set(tokenize(bText))),
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
// outside this package's edit scope). One ruler for "opposite claim".
const NEGATION_RE = /不|没|别|无|never|not|no longer|doesn't|don't/i

/** True when the text carries a negation marker (memory.js findConflict 口径). */
export function negationPolarity(text) {
  return NEGATION_RE.test(String(text || ''))
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
 * §4.8 全局冲突预筛（同 domain/track 前提由调用方保证）。返回 'same_title' |
 * 'negation' | 'value' 或 null。containment ≥0.92 或 charDice ≥0.95 一票豁免
 * （重复/细化，不是冲突）。预筛只决定“送不送人审”，最终由 LLM + 人审裁决。
 */
export function globalConflictCheck(a, b, features = pairFeatures(a, b)) {
  if (features.containment >= 0.92 || features.charDice >= 0.95) return null
  if (features.titleExact && features.charDice < 0.95) return 'same_title'
  const aBody = String(a?.content || '')
  const bBody = String(b?.content || '')
  if (features.charDice >= 0.55 && negationPolarity(aBody) !== negationPolarity(bBody)) return 'negation'
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
 * §4.3 rankPairCandidates({ corpus, proposal, limit })。
 *
 * 1) blocking：同 track；N ≤ exactPairLimit 时精确两两，否则查询 token 中
 *    df ≤ 30%N 的稀有词、共享 ≥2 token，或 exact title。
 * 2) 三路排名 bm25 / charDice / entityJaccard（tiebreak containment）。
 * 3) 加权 RRF(k=60)：0.5/(60+rankBm25) + 0.3/(60+rankDice) + 0.2/(60+rankEntity)。
 * 4) 取前 limit 算完整 pairFeatures/pairScore/pairDecision，按 pairScore 降序。
 * 5) 不足 limit 用同域最近条目补齐（“多看几眼”，不降低门槛）。
 *
 * 返回 [{ id, entry, score, decision, features, rrf, fallback }]，score 降序，
 * 平手 rrf 降序 → id 升序——完全确定。
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
  const queryTokens = tokenize(`${proposal.title || ''} ${proposal.content || ''}`)

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
    for (const term of queryTokens) {
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
  const rankBm25 = new Map()
  bm25Scores.forEach((item, index) => rankBm25.set(item.id, index + 1))

  const probes = ids.map((id) => {
    const doc = corpus.docs.get(id)
    const detail = similarityDetail(`${proposal.title || ''}\n${proposal.content || ''}`, `${doc.entry?.title || ''}\n${doc.entry?.content || ''}`)
    return { id, diceScore: detail.dice, containment: detail.containment, lexical: Math.max(detail.dice, detail.containment) }
  })
  const diceRankOrder = [...probes].sort((a, b) => b.diceScore - a.diceScore || b.containment - a.containment || idAsc(a, b))
  const rankDice = new Map()
  diceRankOrder.forEach((item, index) => rankDice.set(item.id, index + 1))

  const entityOrder = ids.map((id) => {
    const doc = corpus.docs.get(id)
    return {
      id,
      entity: entityScore(proposal.appliesTo, doc.entry?.appliesTo),
      containment: containmentOf(proposal, doc.entry),
    }
  }).sort((a, b) => b.entity - a.entity || b.containment - a.containment || idAsc(a, b))
  const rankEntity = new Map()
  entityOrder.forEach((item, index) => rankEntity.set(item.id, index + 1))

  // 3) weighted RRF
  const rrf = new Map()
  for (const id of ids) {
    rrf.set(id, RRF_W_BM25 / (RRF_K + rankBm25.get(id))
      + RRF_W_DICE / (RRF_K + rankDice.get(id))
      + RRF_W_ENTITY / (RRF_K + rankEntity.get(id)))
  }
  ids.sort((a, b) => rrf.get(b) - rrf.get(a) || idAsc(a, b))

  // 4) features for the top slice only
  const taken = new Set()
  for (const id of ids.slice(0, max)) {
    const doc = corpus.docs.get(id)
    const features = pairFeatures(proposal, doc.entry)
    const score = pairScore(features)
    taken.add(id)
    out.push({ id, entry: doc.entry, score, decision: pairDecision(proposal, doc.entry, features), features, rrf: rrf.get(id), fallback: false })
  }
  out.sort((a, b) => b.score - a.score || b.rrf - a.rrf || idAsc(a, b))
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
 * 2) 同 track 内：N ≤ exactPairLimit(300) 全对；否则倒排 blocking（共享
 *    ≥ blockMinShared(2) token）。
 * 3) 候选对算 pairFeatures/pairScore，保留 ≥ minPairScore(0.55) 的边。
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
    const inverted = new Map()
    for (const item of items) {
      const tokens = tokenize(`${item.entry?.title || ''} ${item.entry?.content || ''}`)
      tokenSets.set(item.id, new Set(tokens))
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
      const shared = new Map()
      for (const posting of inverted.values()) {
        if (posting.length < 2) continue
        for (let i = 0; i < posting.length; i++) {
          for (let j = i + 1; j < posting.length; j++) {
            const key = pairKey(posting[i], posting[j])
            shared.set(key, (shared.get(key) || 0) + 1)
          }
        }
      }
      for (const [key, count] of shared) {
        if (count >= blockMinShared) pairSet.add(key)
      }
    }
    if (pairSet.size === 0) continue

    const corpus = buildCorpus(items.map((item) => ({ id: item.id, title: item.entry?.title || '', content: item.entry?.content || '', entry: item.entry })))
    const pairList = [...pairSet].map((key) => {
      const [aId, bId] = key.split('\u0000')
      const aItem = byId.get(aId)
      const bItem = byId.get(bId)
      const features = pairFeatures(aItem.entry, bItem.entry)
      const score = pairScore(features)
      return { key, aId, bId, aItem, bItem, features, score }
    }).filter((pair) => pair.score >= minPair)
    if (pairList.length === 0) continue

    // three route rankings for edge order only
    const bm25Route = pairList.map((pair) => ({
      key: pair.key,
      s: bm25(tokenStream(`${pair.aItem.entry?.title || ''} ${pair.aItem.entry?.content || ''}`), corpus.docs.get(pair.bId), corpus)
        + bm25(tokenStream(`${pair.bItem.entry?.title || ''} ${pair.bItem.entry?.content || ''}`), corpus.docs.get(pair.aId), corpus),
    })).sort((a, b) => b.s - a.s || (a.key < b.key ? -1 : 1))
    const rankBm25 = new Map()
    bm25Route.forEach((item, i) => rankBm25.set(item.key, i + 1))
    const diceRoute = [...pairList].sort((a, b) => b.features.charDice - a.features.charDice
      || b.features.containment - a.features.containment || (a.key < b.key ? -1 : 1))
    const rankDice = new Map()
    diceRoute.forEach((item, i) => rankDice.set(item.key, i + 1))
    const entityRoute = [...pairList].sort((a, b) => b.features.entityJaccard - a.features.entityJaccard
      || b.features.containment - a.features.containment || (a.key < b.key ? -1 : 1))
    const rankEntity = new Map()
    entityRoute.forEach((item, i) => rankEntity.set(item.key, i + 1))
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
