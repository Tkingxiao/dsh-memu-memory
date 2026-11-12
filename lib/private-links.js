// Private auto-association, split into a legacy candidate pass and the
// deterministic write layer (DESIGN v3).
//
//   * suggestPrivateLinks — PURE legacy candidate suggestion. It still finds
//     statistically name-like pairs, but its output is only a review hint. It
//     never decides that an edge exists.
//   * autoLinkPrivateMemories — MODE GATED. In the default 'suggest' mode it
//     returns candidates and writes nothing. In 'deterministic' mode it refreshes
//     the edges that lib/auto-link/ decided: memory→confirmed-entity mentions and
//     explicit field evidence. Lexical similarity, shared tokens and vectors are
//     never written as edges.
//
// The write layer is incremental: the consolidation hands over the ids it just
// created/updated, and only those rows are recomputed (O(Δ)). Rebuilding the
// whole library is the migration script's job.
//
// Links are metadata only: they never touch the vector store, never delete
// memory, and can be removed from the relationship graph. A failed association
// pass must never fail the consolidation job, so every write is individually
// caught and only a warning is logged; the top-level index load is caught too.

import { sameFactContext } from './context.js'
import { listEntities } from './graph.js'
import { findConflict, isMemoryEligible, visibleToSession } from './memory.js'
import { pairFeatures, pairScore, tokenize } from './text-retrieval.js'
import { getSettings, loadPrivateIndex } from './state.js'
import { record } from './activity-log.js'
import { applyAutoEdges, refreshMemoryAutoLinks } from './auto-link/apply.js'
import { decideAutoLinks } from './auto-link/decide.js'
import { suppressionSet } from './auto-link/suppression.js'

const DEFAULT_PER_ENTRY = 2
const DEFAULT_TOTAL = 5
const DEFAULT_MAX_CANDIDATES = 8
const DEFAULT_MAX_ENTITIES = 2
const SCORE_CANDIDATE_MIN = 0.55
const SCORE_DUPLICATE = 0.82
const DF_RATIO = 0.15
const LATIN_NAME_MIN_LENGTH = 3
// findConflict compares the same five identity keys; grouping hubs by the same
// key keeps "not across context" true for the entity side too.
const FACT_KEYS = ['channelId', 'speakerId', 'characterId', 'worldId', 'branchId']
const BLOCKING_LINK_KINDS = new Set(['relation', 'person'])
const CJK_RE = /^[\u3400-\u9fff\uf900-\ufaff]+$/
const LATIN_RE = /[a-z]/
const EMPTY_SET = new Set()

// Title tokens that carry no identifying power on their own. The draft list is
// kept and expanded with ordinary bigrams/words so a shared "名字"/"关于"/"the"
// never looks like a stable name. Bigrams touching a function character are
// dropped separately by isStopToken (字的/的由/…).
const STOPWORDS = new Set([
  '名字', '由来', '记忆', '关于', '什么', '怎么', '一个', '这个', '那个', '我们', '你们', '他们',
  '她们', '自己', '现在', '已经', '只是', '就是', '时候', '因为', '所以', '但是', '如果', '然后',
  '还是', '可以', '不是', '没有', '内容', '信息', '角色', '设定', '故事', '对话', '用户', '一些',
  '进行', '今天', '昨天', '明天', '之前', '之后', '一起', '知道', '觉得', '喜欢', '开始', '结束',
  '东西', '事情', '问题', '感觉', '看到', '听到', '打算', '准备', '应该', '需要', '可能', '真的',
  '非常', '特别', '有点', '有些', '一样', '这样', '那样', '这里', '那里', '哪里', '第一', '第二',
  '于是', '而且', '并且', '或者', '虽然', '不过', '对于', '为了', '通过', '以及', '还有', '记录',
  '笔记', '计划', '项目', '会议', '工作', '生活', '世界', '地方', '时间', '目前', '最近', '以后',
  '以前', '当时', '那时', '这时', '不会', '不能', '不要',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'will', 'your', 'you', 'name',
  'memory', 'user', 'role', 'story', 'about', 'into', 'when', 'what', 'which', 'were', 'was',
  'are', 'is', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'as', 'or', 'be', 'it', 'its', 'not',
  'but', 'they', 'them', 'their', 'we', 'our', 'me', 'my', 'he', 'she', 'his', 'her', 'him',
  'has', 'had', 'do', 'does', 'did', 'can', 'could', 'would', 'should', 'there', 'here', 'then',
  'than', 'so', 'if', 'all', 'any', 'each', 'other', 'more', 'most', 'some', 'such', 'no', 'only',
  'own', 'same', 'too', 'very', 'just', 'also', 'how', 'why', 'who', 'whom', 'whose', 'out', 'up',
  'down', 'over', 'under', 'again', 'further', 'once', 'during', 'before', 'after', 'above',
  'below', 'between', 'both', 'few', 'many', 'much', 'every', 'off', 'project', 'note', 'notes',
  'meeting', 'update', 'info', 'detail', 'details', 'thing', 'things', 'stuff', 'today',
  'yesterday', 'tomorrow', 'day', 'night',
])

// A CJK bigram containing a particle/pronoun is grammatical glue, not a name.
// Kept intentionally narrow: characters that legitimately appear inside names
// (上/下/中/一/…) are not listed.
const CJK_FUNCTION_CHARS = new Set([
  '的', '了', '是', '在', '和', '与', '也', '就', '都', '很', '又', '还', '你', '我', '他', '她',
  '它', '们', '这', '那', '哪', '什', '么', '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '之', '其',
  '而', '且', '但', '却', '把', '被', '让', '给', '对', '从', '向', '于', '为', '及', '或', '并',
  '着', '过', '得', '地', '有', '没', '不', '要', '会', '能', '可', '以', '说', '去', '来',
])

// Person cues. Deliberately conservative: a pronoun or "角色"/"名字" near the
// name is the cheap signal that the token is a person and not a thing. English
// cues are word-bounded so "the" never matches "he".
const PERSON_CUE_RE = /猫娘|角色|人物|名字|人设|称呼|登场|姓名|男主|女主|男配|女配|她|他|\bcp\b|\bcharacter\b|\bperson\b|\bshe\b|\bhe\b|\bher\b|\bhis\b|\bhim\b/i

function entryOf(value) {
  // Accept both plain entries and [id, entry] pairs (Object.entries output).
  return Array.isArray(value) ? value[1] : value
}

function hasCjk(token) {
  return typeof token === 'string' && CJK_RE.test(token)
}

function isLatinNameLike(token) {
  return typeof token === 'string' && token.length >= LATIN_NAME_MIN_LENGTH && LATIN_RE.test(token) && !hasCjk(token)
}

function isNameLikeToken(token) {
  if (hasCjk(token)) return token.length >= 2
  return isLatinNameLike(token)
}

function isStopToken(token) {
  if (STOPWORDS.has(token)) return true
  if (hasCjk(token)) {
    for (const char of token) if (CJK_FUNCTION_CHARS.has(char)) return true
  }
  return false
}

/**
 * Case/NFKC/whitespace/punctuation-insensitive entity-name key. `Yuike`,
 * `ｙｕｉｋｅ`, `Yuike!` and `yuike` all collapse to `yuike`, so the algorithm
 * never creates a second entity for a name it has already seen.
 */
export function normalizeEntityName(name) {
  return String(name || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}\p{Cf}]+/gu, '')
}

function titleTokens(entry) {
  const out = new Set()
  for (const token of tokenize(entry?.title || '')) {
    if (token.length >= 2 && !isStopToken(token)) out.add(token)
  }
  return out
}

function factKey(entry) {
  const context = entry?.context || {}
  return FACT_KEYS.map(key => String(context[key] || '')).join('\u0000')
}

function trackOf(entry) {
  return entry?.track || 'memory'
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function displayNameOfToken(token, titles) {
  let pattern
  try { pattern = new RegExp(escapeRegExp(token), 'i') } catch { return token }
  for (const title of titles) {
    const match = String(title || '').normalize('NFKC').match(pattern)
    if (match) return match[0]
  }
  return token
}

/**
 * Decide whether a shared name-like token names a person or a thing.
 *   * any involved title/content carries a person cue → person;
 *   * a Latin name-like token without a cue → thing (conservative, never org/place);
 *   * a CJK token without a cue → null: the type is unresolved and the caller
 *     must not auto-create an entity for it.
 */
export function inferEntityKind(entries, token) {
  const texts = (Array.isArray(entries) ? entries : [])
    .map(entryOf)
    .map(entry => `${entry?.title || ''}\n${entry?.content || ''}`)
    .join('\n')
  if (PERSON_CUE_RE.test(texts)) return 'person'
  if (isLatinNameLike(token)) return 'thing'
  return null
}

function resolveEntity(entities, token, kind) {
  const key = normalizeEntityName(token)
  if (!key) return { entityId: null, conflict: false }
  let mismatch = null
  for (const entity of Array.isArray(entities) ? entities : []) {
    if (!entity || !entity.id) continue
    const names = [entity.name, ...(Array.isArray(entity.aliases) ? entity.aliases : [])]
    if (!names.some(name => normalizeEntityName(name) === key)) continue
    if (kind !== null && entity.kind === kind) return { entityId: entity.id, conflict: false }
    if (!mismatch) mismatch = entity
  }
  if (mismatch) return { entityId: null, conflict: true, existingKind: mismatch.kind || null }
  return { entityId: null, conflict: false }
}

function hasBlockingLink(entry, targetId) {
  return (entry?.links || []).some(link => link?.to === targetId && BLOCKING_LINK_KINDS.has(link?.kind))
}

function pairKey(a, b) {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

function collapse(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function clip(text, max) {
  return String(text || '').slice(0, max)
}

// Candidate title/preview describe the memory the new/updated entry points AT,
// i.e. the other side of the pair.
function describeOther(entry) {
  const title = collapse(entry?.title || '') || collapse(entry?.content || '')
  return { title: clip(title, 80), preview: clip(collapse(entry?.content || ''), 120) }
}

function linkConfidence(score) {
  // Name-like links live in the 0.6–0.78 band from the spec.
  return Math.max(0.6, Math.min(0.78, 0.55 + score * 0.3))
}

function capNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback
}

function compareTokenDf(a, b, df) {
  return (df.get(a) || 0) - (df.get(b) || 0) || b.length - a.length || a.localeCompare(b)
}

/**
 * Pure candidate suggestion. Never writes.
 *
 * Universe: eligible entries (active/not secret/visible/same library) whose
 * pair shares a fact context and track, where at least one endpoint is in
 * `ids`. Returns
 *   { autoLinks: [{ from, to, score, token, nameLike, confidence }],
 *     entityHubs: [{ token, name, kind, entityId?, memoryIds }],
 *     candidates: [{ from, to, score, sharedToken?, title, preview, suggestedEntity? }] }
 */
export function suggestPrivateLinks({
  index,
  entities = [],
  ids,
  sessionId,
  perEntry = DEFAULT_PER_ENTRY,
  total = DEFAULT_TOTAL,
  maxCandidates = DEFAULT_MAX_CANDIDATES,
  maxEntities = DEFAULT_MAX_ENTITIES,
} = {}) {
  const entries = index?.entries || {}
  const eligibleList = Object.entries(entries)
    .filter(([, entry]) => entry && isMemoryEligible(entry, { automatic: true })
      && entry.visibility !== 'secret'
      && (!sessionId || visibleToSession(entry, sessionId)))
    .map(([id, entry]) => ({ id: String(id), entry }))
  const empty = { autoLinks: [], entityHubs: [], candidates: [] }
  if (eligibleList.length < 2) return empty
  const eligible = new Map(eligibleList.map(item => [item.id, item.entry]))
  const wanted = []
  const wantedSet = new Set()
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw)
    if (wantedSet.has(id) || !eligible.has(id)) continue
    wantedSet.add(id)
    wanted.push(id)
  }
  if (!wanted.length) return empty

  const tokensById = new Map()
  const df = new Map()
  for (const { id, entry } of eligibleList) {
    const set = titleTokens(entry)
    tokensById.set(id, set)
    for (const token of set) df.set(token, (df.get(token) || 0) + 1)
  }
  const dfCap = Math.max(2, Math.ceil(eligibleList.length * DF_RATIO))
  const isRare = token => (df.get(token) || 0) <= dfCap

  // Entity-hub groups: one rare name-like token within one fact context + track.
  // Rarity bounds the group, context/track bounds who may be connected.
  const groups = new Map()
  for (const item of eligibleList) {
    for (const token of tokensById.get(item.id) || EMPTY_SET) {
      if (!isNameLikeToken(token) || !isRare(token)) continue
      const key = `${token}\u0000${factKey(item.entry)}\u0000${trackOf(item.entry)}`
      if (!groups.has(key)) groups.set(key, { token, entries: [] })
      groups.get(key).entries.push(item)
    }
  }
  const analyses = new Map()
  for (const [key, group] of groups) {
    if (group.entries.length < 2) continue
    if (!group.entries.some(item => wantedSet.has(item.id))) continue
    const kind = inferEntityKind(group.entries.map(item => item.entry), group.token)
    const name = displayNameOfToken(group.token, group.entries.map(item => item.entry?.title || ''))
    const resolution = resolveEntity(entities, group.token, kind)
    analyses.set(key, {
      token: group.token,
      kind,
      name,
      entries: group.entries,
      entityId: resolution.entityId,
      conflict: resolution.conflict,
    })
  }

  const autoLinks = []
  const candidates = []
  const seenPairs = new Set()
  const wantedOrder = new Map(wanted.map((id, indexInIds) => [id, indexInIds]))
  for (const fromId of wanted) {
    const a = eligible.get(fromId)
    const aTokens = tokensById.get(fromId) || EMPTY_SET
    for (const other of eligibleList) {
      if (other.id === fromId) continue
      const key = pairKey(fromId, other.id)
      if (seenPairs.has(key)) continue
      const otherOrder = wantedOrder.get(other.id)
      // Both endpoints created/updated: the earlier id is the source of the
      // link; the later one will not evaluate the same unordered pair again.
      if (otherOrder !== undefined && otherOrder < wantedOrder.get(fromId)) continue
      seenPairs.add(key)
      const b = other.entry
      if (trackOf(a) !== trackOf(b)) continue
      if (!sameFactContext(a.context, b.context)) continue
      if (hasBlockingLink(a, other.id) || hasBlockingLink(b, fromId)) continue
      const score = pairScore(pairFeatures(a, b))
      if (!Number.isFinite(score) || score >= SCORE_DUPLICATE) continue
      const sharedRare = [...aTokens]
        .filter(token => (tokensById.get(other.id) || EMPTY_SET).has(token) && isRare(token))
        .sort((x, y) => compareTokenDf(x, y, df))
      if (!sharedRare.length && score < SCORE_CANDIDATE_MIN) continue
      if (findConflict({ [other.id]: b }, a)) continue
      const nameTokens = sharedRare.filter(isNameLikeToken)
      let resolved = null
      let unresolved = null
      for (const token of nameTokens) {
        const analysis = analyses.get(`${token}\u0000${factKey(a)}\u0000${trackOf(a)}`)
        if (!analysis) continue
        if (analysis.kind !== null && !analysis.conflict) {
          if (!resolved) resolved = analysis
        } else if (!unresolved) {
          unresolved = analysis
        }
      }
      const base = { from: fromId, to: other.id, score }
      if (resolved) {
        // A name-like pair may still be linked even when a hub is created for
        // it; a resolved pair must not be duplicated into candidates.
        autoLinks.push({ ...base, token: resolved.token, nameLike: true, confidence: linkConfidence(score) })
        continue
      }
      if (nameTokens.length) {
        // Name-like token, but the entity type is unresolved (CJK without a
        // person cue) or conflicts with an existing entity kind: nothing is
        // linked automatically; the worker decides, so this is one uncertain
        // candidate carrying a suggested entity.
        const analysis = unresolved || analyses.get(`${nameTokens[0]}\u0000${factKey(a)}\u0000${trackOf(a)}`) || null
        const otherText = describeOther(b)
        const candidate = {
          ...base,
          sharedToken: analysis?.token || nameTokens[0],
          title: otherText.title,
          preview: otherText.preview,
        }
        if (analysis) candidate.suggestedEntity = { name: analysis.name, kind: analysis.kind }
        candidates.push(candidate)
        continue
      }
      if (score >= SCORE_CANDIDATE_MIN) {
        const otherText = describeOther(b)
        const candidate = { ...base, title: otherText.title, preview: otherText.preview }
        if (sharedRare.length) candidate.sharedToken = sharedRare[0]
        candidates.push(candidate)
      }
    }
  }

  autoLinks.sort((a, b) => b.score - a.score
    || a.from.localeCompare(b.from)
    || a.to.localeCompare(b.to))
  const perEntryCap = capNumber(perEntry, DEFAULT_PER_ENTRY)
  const totalCap = capNumber(total, DEFAULT_TOTAL)
  const perFrom = new Map()
  const chosenLinks = []
  for (const link of autoLinks) {
    if (chosenLinks.length >= totalCap) break
    const count = perFrom.get(link.from) || 0
    if (count >= perEntryCap) continue
    perFrom.set(link.from, count + 1)
    chosenLinks.push(link)
  }

  const entityHubs = [...analyses.values()]
    .filter(analysis => analysis.kind !== null && !analysis.conflict)
    .sort((a, b) => b.entries.length - a.entries.length
      || compareTokenDf(a.token, b.token, df))
    .slice(0, capNumber(maxEntities, DEFAULT_MAX_ENTITIES))
    .map(analysis => {
      const hub = { token: analysis.token, name: analysis.name, kind: analysis.kind }
      if (analysis.entityId) hub.entityId = analysis.entityId
      hub.memoryIds = analysis.entries.map(item => item.id)
      return hub
    })

  candidates.sort((a, b) => b.score - a.score
    || a.from.localeCompare(b.from)
    || a.to.localeCompare(b.to))
  return {
    autoLinks: chosenLinks,
    entityHubs,
    candidates: candidates.slice(0, capNumber(maxCandidates, DEFAULT_MAX_CANDIDATES)),
  }
}

/**
 * Mode-gated entry point used by the consolidation settle path and the worker
 * tool. `ids` are the entries created/updated by the finished consolidation.
 *
 *  * 'suggest' (default): compute the legacy review candidates, write nothing.
 *  * 'deterministic': additionally refresh this layer's edges in lib/auto-link/
 *    for those ids — mention edges to confirmed entities and explicit field
 *    evidence. Legacy statistical pairs remain candidates only.
 *  * 'off': no candidates, no writes.
 *
 * A consolidation must never fail because of this module: the index load, the
 * suggestion pass and the deterministic write are each caught and logged at warn
 * level. Return counts: `linked` = memory↔memory evidence edges written,
 * `entities` = memory→confirmed-entity edges written, `suggested` = candidate
 * count handed to the worker.
 */
export async function autoLinkPrivateMemories({
  libraryId,
  sessionId,
  ids,
  perEntry = DEFAULT_PER_ENTRY,
  total = DEFAULT_TOTAL,
  maxCandidates = DEFAULT_MAX_CANDIDATES,
  maxEntities = DEFAULT_MAX_ENTITIES,
} = {}) {
  const result = { linked: 0, entities: 0, suggested: 0, candidates: [], autoLinked: [] }
  if (!libraryId) return result
  // S0 止血：默认的 'suggest' 只出候选、不写边；'off' 连候选都不算。
  // 误连的代价远高于漏连，迁移期间先停写，再按 DESIGN 的确定性判定层重建。
  const mode = getSettings().autoLinkMode
  if (mode === 'off') return result
  const idList = (Array.isArray(ids) ? ids : []).map(id => String(id)).filter(Boolean)
  if (!idList.length) return result

  let index
  let entityList = []
  try {
    index = loadPrivateIndex(libraryId)
    // No session filter: reuse must see every entity in the library, including
    // names that only appear in conversations this session cannot read.
    entityList = listEntities({ libraryId }).items
  } catch (error) {
    record({
      kind: 'write', scope: 'private', sessionId, libraryId, ok: false, level: 'warn',
      message: `私有自动关联跳过：${String(error?.message || error)}`,
      detail: { op: 'auto-link', phase: 'load', error: String(error?.message || error) },
      refs: [],
    })
    return result
  }

  let suggestion
  try {
    suggestion = suggestPrivateLinks({ index, entities: entityList, ids: idList, sessionId, perEntry, total, maxCandidates, maxEntities })
  } catch (error) {
    record({
      kind: 'write', scope: 'private', sessionId, libraryId, ok: false, level: 'warn',
      message: `私有自动关联候选计算失败：${String(error?.message || error)}`,
      detail: { op: 'auto-link', phase: 'suggest', error: String(error?.message || error) },
      refs: [],
    })
    return result
  }
  result.suggested = suggestion.candidates.length
  result.candidates = suggestion.candidates
  // Only deterministic mode writes edges. suggest/off stop here with the candidates.
  if (mode !== 'deterministic') return result

  // Deterministic pass: only confirmed-entity mentions and explicit field
  // evidence are written; the legacy statistical pairs stay candidates.
  const refreshed = await refreshPrivateAutoLinks({ libraryId, sessionId, ids: idList, entities: entityList })
  if (refreshed.applied) {
    result.linked = refreshed.applied.memory
    result.entities = refreshed.applied.entity
    result.autoLinked = refreshed.applied.applied.map(({ from, to, kind }) => ({ from, to, kind }))
  }
  return result
}

/**
 * Deterministic-only incremental refresh, shared by every write path that can
 * change what the edges should be: consolidation settle, the worker tool, a
 * private write carrying conflicts_with / supersedes / a fact_key pair, and a
 * review accept that turns a claim into a supersede. Returns `{ skipped, applied }`
 * and never throws — a failure is logged and the caller's write stays valid.
 */
export async function refreshPrivateAutoLinks({ libraryId, sessionId = null, ids, entities = null, full = false } = {}) {
  const mode = getSettings().autoLinkMode
  if (mode !== 'deterministic') return { skipped: mode || 'suggest', applied: null }
  const idList = [...new Set((Array.isArray(ids) ? ids : []).map(id => String(id ?? '').trim()).filter(Boolean))]
  if (!libraryId || (!full && !idList.length)) return { skipped: 'no-ids', applied: null }
  let entityList
  try {
    entityList = Array.isArray(entities) ? entities : listEntities({ libraryId }).items
  } catch (error) {
    record({
      kind: 'write', scope: 'private', sessionId, libraryId, ok: false, level: 'warn',
      message: `私有自动关联跳过：实体表不可读（${String(error?.message || error)}）`,
      detail: { op: 'auto-link', phase: 'entities', error: String(error?.message || error) },
      refs: [],
    })
    return { skipped: 'entities', applied: null }
  }
  let suppression
  try {
    suppression = suppressionSet(libraryId)
  } catch (error) {
    record({
      kind: 'write', scope: 'private', sessionId, libraryId, ok: false, level: 'warn',
      message: `私有自动关联跳过：抑制表不可读（${String(error?.message || error)}）`,
      detail: { op: 'auto-link', phase: 'suppression', error: String(error?.message || error) },
      refs: [],
    })
    return { skipped: 'suppression', applied: null }
  }
  try {
    // `full` recomputes the whole library in one transaction. It is the catch-up
    // path for entities confirmed while the mode was off: their status is already
    // confirmed, so a later per-id refresh has nothing to trigger.
    if (full) {
      const edges = decideAutoLinks({ index: loadPrivateIndex(libraryId), entities: entityList, suppression })
      const applied = applyAutoEdges({
        libraryId, edges, entities: entityList, sessionId, operation: 'auto-link-rebuild',
      })
      return { skipped: null, applied, full: true }
    }
    const applied = refreshMemoryAutoLinks({
      libraryId, ids: idList, entities: entityList, suppression, sessionId,
    })
    return { skipped: null, applied }
  } catch (error) {
    record({
      kind: 'write', scope: 'private', sessionId, libraryId, ok: false, level: 'warn',
      message: `私有自动关联写入失败：${String(error?.message || error)}`,
      detail: { op: 'auto-link', phase: 'apply', error: String(error?.message || error) },
      refs: [],
    })
    return { skipped: 'apply', applied: null }
  }
}

export default { suggestPrivateLinks, autoLinkPrivateMemories, refreshPrivateAutoLinks, normalizeEntityName, inferEntityKind }
