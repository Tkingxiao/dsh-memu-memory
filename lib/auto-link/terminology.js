// Nomination layer: local, zero-token term statistics used ONLY to rank a review
// queue. Nothing here decides that an entity exists or that an edge is written —
// statistical scores live and die inside the candidate list (DESIGN P4/P9).

import { AUTOLINK_POLICY_V3 } from './policy.js'
import { normalizeForIndex } from './normalize.js'

const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]+/g
const LATIN_RUN = /[a-z0-9][a-z0-9._-]*/g
const AV_CAP = 24

// Characters that make a CJK string grammatical glue rather than a name.
const FUNCTION_CHARS = new Set('的了是和与也就都很又还你我他她它们这那哪什么吗呢吧啊呀哦嗯之其而且但却被让给对从向于为及或并着过得地有不想要会可能可以说去来'.split(''))
// Measure-word templates: 一条/两只/这个/那些… A name never starts with one.
const MEASURE_PREFIX = /^(一|两|三|几|每|这|那|半)?[条只把张个位次件场顿盘杯碗袋包串支根颗头匹群套双对份页篇段句声口]/

const QUOTE_RE = /[「『《"']([^」』》"']{1,20})[」』》"']/g
const INTRO_RE = /(?:叫|名叫|名字(?:是|叫|为)?|称呼(?:是|为)?|自称|username|nickname)([^\n。]{0,6})/gi

/** Terms whose surface shape cannot be a name on its own (ranking hint only). */
export function looksGeneric(token) {
  const text = String(token || '')
  if (!text) return true
  if ([...text].some(ch => FUNCTION_CHARS.has(ch))) return true
  if (MEASURE_PREFIX.test(text) && text.length <= 3) return true
  return false
}

function isLatinTerm(term) {
  return /^[a-z0-9]/.test(term) && !/[\u3400-\u9fff\uf900-\ufaff]/.test(term)
}

function addNgrams(set, text, policy) {
  const value = String(text || '').normalize('NFKC').toLowerCase()
  for (const run of value.match(CJK_RUN) || []) {
    for (let size = policy.ngramCjkMin; size <= Math.min(policy.ngramCjkMax, run.length); size += 1) {
      for (let i = 0; i + size <= run.length; i += 1) set.add(run.slice(i, i + size))
    }
  }
  for (const token of value.match(LATIN_RUN) || []) {
    if (token.length >= policy.latinMin && token.length <= policy.latinMax) set.add(token)
  }
}

/** Quoted spans and name-intro neighbours, collected once per library. */
function surfaceEvidence(docs, policy) {
  const quoted = new Set()
  const intro = new Set()
  for (const { text } of docs) {
    const source = String(text || '')
    let match
    QUOTE_RE.lastIndex = 0
    while ((match = QUOTE_RE.exec(source))) addNgrams(quoted, match[1], policy)
    INTRO_RE.lastIndex = 0
    while ((match = INTRO_RE.exec(source))) addNgrams(intro, match[1], policy)
  }
  return { quoted, intro }
}

function llrFor(term, tf, unigram, ngramTotals) {
  if (term.length < 2) return 0
  const prefix = term.slice(0, -1)
  const suffix = term.slice(1)
  const countOf = (part) => (part.length === 1 ? (unigram.get(part) || 0) : (tf.get(part) || 0))
  const a = tf.get(term) || 0
  const b = Math.max(0, countOf(prefix) - a)
  const c = Math.max(0, countOf(suffix) - a)
  const total = Math.max(1, ngramTotals.get(term.length) || 0)
  const d = Math.max(0, total - a - b - c)
  const rows = [
    [a, b, a + b],
    [c, d, c + d],
  ]
  const cols = [a + c, b + d, a + b + c + d]
  let llr = 0
  for (let i = 0; i < 2; i += 1) {
    for (let j = 0; j < 2; j += 1) {
      const observed = rows[i][j]
      if (!observed) continue
      const expected = (rows[i][2] * cols[j]) / Math.max(1, cols[2])
      if (expected > 0) llr += observed * Math.log(observed / expected)
    }
  }
  return 2 * llr
}

function pmiFor(term, tf, unigram, totalChars) {
  if (!totalChars) return 0
  const chars = [...term]
  const termCount = tf.get(term) || 0
  if (!termCount) return 0
  let product = 1
  for (const ch of chars) product *= (unigram.get(ch) || 0) / totalChars
  if (product <= 0) return 0
  return Math.log2((termCount / totalChars) / product)
}

/**
 * Single pass over title+content per document. Returns Map(term -> statistics):
 * tf/df/titleDf, boundary variety, cohesion/freedom, PMI, LLR and the surface
 * shape bits (latin, quoted/intro membership is applied during ranking).
 */
export function buildTermStats(entries, policy = AUTOLINK_POLICY_V3) {
  const tf = new Map()
  const df = new Map()
  const titleDf = new Map()
  const unigram = new Map()
  const leftSets = new Map()
  const rightSets = new Map()
  const ngramTotals = new Map()
  let totalChars = 0

  const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by)
  const addNeighbour = (map, key, value) => {
    let set = map.get(key)
    if (!set) { set = new Set(); map.set(key, set) }
    if (set.size < AV_CAP) set.add(value)
  }

  for (const { text, title } of entries) {
    const normalized = String(text || '').normalize('NFKC').toLowerCase()
    const perDoc = new Set()
    for (const match of normalized.matchAll(CJK_RUN)) {
      const run = match[0]
      const start = match.index || 0
      totalChars += [...run].length
      for (const ch of run) bump(unigram, ch)
      for (let size = policy.ngramCjkMin; size <= Math.min(policy.ngramCjkMax, run.length); size += 1) {
        for (let i = 0; i + size <= run.length; i += 1) {
          const term = run.slice(i, i + size)
          bump(tf, term)
          bump(ngramTotals, size)
          perDoc.add(term)
          const offset = Math.max(0, start) + i
          addNeighbour(leftSets, term, offset > 0 ? normalized[offset - 1] : '^')
          addNeighbour(rightSets, term, offset + size < normalized.length ? normalized[offset + size] : '$')
        }
      }
    }
    for (const token of normalized.match(LATIN_RUN) || []) {
      if (token.length < policy.latinMin || token.length > policy.latinMax || /^\d+$/.test(token)) continue
      bump(tf, token)
      bump(ngramTotals, token.length)
      perDoc.add(token)
    }
    for (const term of perDoc) bump(df, term)
    const normalizedTitle = String(title || '').normalize('NFKC').toLowerCase()
    if (normalizedTitle) {
      const titleTerms = new Set()
      for (const run of normalizedTitle.match(CJK_RUN) || []) {
        for (let size = policy.ngramCjkMin; size <= Math.min(policy.ngramCjkMax, run.length); size += 1) {
          for (let i = 0; i + size <= run.length; i += 1) titleTerms.add(run.slice(i, i + size))
        }
      }
      for (const token of normalizedTitle.match(LATIN_RUN) || []) {
        if (token.length >= policy.latinMin && token.length <= policy.latinMax) titleTerms.add(token)
      }
      for (const term of titleTerms) bump(titleDf, term)
    }
  }

  const stats = new Map()
  for (const [term, count] of tf) {
    if (/^\d+$/.test(term)) continue
    const latin = isLatinTerm(term)
    const leftPart = term.slice(0, -1)
    const rightPart = term.slice(1)
    const base = (part) => (part.length === 1 ? (unigram.get(part) || 1) : (tf.get(part) || 1))
    const cohesion = latin ? 1 : count / Math.max(1, Math.min(base(leftPart), base(rightPart)))
    const avLeft = latin ? Math.min(3, df.get(term) || 1) : (leftSets.get(term)?.size || 0)
    const avRight = latin ? Math.min(3, df.get(term) || 1) : (rightSets.get(term)?.size || 0)
    stats.set(term, {
      term,
      tf: count,
      df: df.get(term) || 0,
      titleDf: titleDf.get(term) || 0,
      cohesion,
      avLeft,
      avRight,
      freedom: Math.min(avLeft, avRight),
      pmi: latin ? 0 : pmiFor(term, tf, unigram, totalChars),
      llr: latin ? 0 : llrFor(term, tf, unigram, ngramTotals),
      latin,
    })
  }
  return stats
}

function scoreOf(stat, { size, quoted, mixed, intro, titleBoost, lexiconTier1, lexiconModel, policy }) {
  const rarity = 1 - Math.min(1, stat.df / Math.max(4, size * 0.25))
  const boundary = Math.min(stat.avLeft, stat.avRight)
  const pmi = Math.max(0, Math.min(12, stat.pmi)) / 12
  const llr = Math.max(0, Math.min(1, Math.log10(1 + stat.llr) / 6))
  const titleFocus = stat.titleDf >= policy.minTitleDf ? Math.min(1, stat.titleDf / 3) : 0
  return boundary * 0.35
    + Math.min(stat.cohesion, 3) * 0.35
    + rarity * 0.8
    + pmi * 0.5
    + llr * 0.5
    + titleFocus * 0.6
    + (quoted ? 2.5 : 0)
    + (mixed ? 2.0 : 0)
    + (intro ? 2.0 : 0)
    + (titleBoost ? 1.2 : 0)
    + (lexiconTier1 ? 2.5 : 0)
    + (lexiconModel ? 0.8 : 0)
}

/**
 * Two review tiers. Tier 1 carries surface evidence (quote / identifier /
 * name-intro / user lexicon) and is cheap to confirm; tier 2 is statistical
 * only. Scores order the queue; they never gate an edge write.
 */
export function rankCandidates(entries, stats, { policy = AUTOLINK_POLICY_V3, lexiconUser = new Set(), lexiconModel = new Set() } = {}) {
  const docs = entries.map(({ text, title }) => ({ text: `${title || ''}\n${text || ''}` }))
  const { quoted, intro } = surfaceEvidence(docs, policy)
  const size = Math.max(1, entries.length)
  const tier1 = []
  const tier2 = []
  for (const stat of stats.values()) {
    const term = stat.term
    if (stat.df < policy.minDf) continue
    if (stat.df > Math.max(policy.minDf, Math.floor(size * policy.maxDfRatio))) continue
    if (looksGeneric(term)) continue
    // Boundary variety is a ranking feature, not a hard gate (DESIGN §9.1): a real
    // name that only ever appears at a title's start/end still belongs in the queue.
    if (/^\d{4}[-/年.]\d{1,2}/.test(term)) continue
    if ((term.match(/\d/g) || []).length >= Math.ceil(term.length / 2)) continue
    const normalized = normalizeForIndex(term)
    const isQuoted = quoted.has(term)
    const isMixed = /[a-z].*\d|\d.*[a-z]/i.test(term)
    const isIntro = intro.has(term)
    const lexiconTier1 = lexiconUser.has(normalized)
    const lexiconModelHit = !lexiconTier1 && lexiconModel.has(normalized)
    const titleBoost = stat.titleDf >= policy.minTitleDf
    const row = {
      term,
      score: scoreOf(stat, { size, quoted: isQuoted, mixed: isMixed, intro: isIntro, titleBoost, lexiconTier1, lexiconModel: lexiconModelHit, policy }),
      df: stat.df,
      tf: stat.tf,
      titleDf: stat.titleDf,
      cohesion: Number(stat.cohesion.toFixed(2)),
      avLeft: stat.avLeft,
      avRight: stat.avRight,
      freedom: stat.freedom,
      pmi: Number(stat.pmi.toFixed(2)),
      llr: Number(stat.llr.toFixed(2)),
      quoted: isQuoted,
      mixed: isMixed,
      intro: isIntro,
      lexicon: lexiconTier1 ? 'user' : (lexiconModelHit ? 'model-proposal' : null),
    }
    if (isQuoted || isMixed || isIntro || lexiconTier1) tier1.push(row)
    else tier2.push(row)
  }
  const byScore = (a, b) => b.score - a.score || a.term.localeCompare(b.term)
  tier1.sort(byScore)
  tier2.sort(byScore)
  return {
    tier1: tier1.slice(0, policy.tier1Max),
    tier2: tier2.slice(0, policy.tier2Max),
  }
}

export default { buildTermStats, rankCandidates, looksGeneric }
