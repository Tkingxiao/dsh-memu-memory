// The only path that decides whether an automatic edge may exist. Pure: no IO,
// no clock, no randomness — the same index/entities/suppression always produce
// the same edge list.
//
// Two deterministic rules feed it:
//   entity-mention : a memory mentions a CONFIRMED entity name/alias
//   field evidence : conflicts_with / supersedes / the same fact_key+context
//
// Lexical similarity, shared tokens, vectors and statistics never reach this
// file. They may rank review candidates elsewhere; they cannot create an edge.

import { isMemoryEligible } from '../memory.js'
import { AUTOLINK_POLICY_V3, AUTOLINK_SCHEMA_VERSION } from './policy.js'
import { isSuppressed } from './suppression.js'
import { firstMention, isMentionSurface, mentionCount, normalizeForIndex } from './normalize.js'

const FACT_KEYS = ['channelId', 'speakerId', 'characterId', 'worldId', 'branchId']

const RULE_ORDER = new Map(['entity-mention', 'conflict', 'supersede', 'fact-key', 'worker-quote'].map((rule, index) => [rule, index]))

export function contextSignature(context = {}) {
  return FACT_KEYS.map(key => String(context?.[key] || '')).join('\u0000')
}

/** Only a confirmed entity may produce edges; missing/legacy status is not confirmed. */
export function isConfirmedEntity(entity) {
  return Boolean(entity && typeof entity === 'object' && entity.id && entity.status === 'confirmed')
}

/** Effective status for display/grading without writing anything back. */
export function effectiveEntityStatus(entity) {
  if (!entity) return 'provisional'
  if (['provisional', 'confirmed', 'archived'].includes(entity.status)) return entity.status
  return 'provisional'
}

/** Eligible memory rows in the shape the rules consume (no secret rows). */
export function eligibleEntries(index) {
  return Object.entries(index?.entries || {})
    .filter(([, entry]) => entry && entry.visibility !== 'secret' && isMemoryEligible(entry, { automatic: true }))
    .map(([id, entry]) => ({ id: String(id), entry, text: `${entry.title || ''}\n${entry.content || ''}` }))
}

function entryText(entry) {
  return `${entry?.title || ''}\n${entry?.content || ''}`
}

/** One name per normalized key; longest first so the most specific surface wins. */
function entitySurfaces(entity) {
  const seen = new Set()
  const out = []
  for (const raw of [entity?.name, ...(Array.isArray(entity?.aliases) ? entity.aliases : [])]) {
    const name = String(raw || '').trim()
    const key = normalizeForIndex(name)
    if (!key || seen.has(key) || !isMentionSurface(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out.sort((a, b) => normalizeForIndex(b).length - normalizeForIndex(a).length || a.localeCompare(b))
}

/**
 * Character-bigram postings over the COMPACT text (punctuation/space removed),
 * so the prefilter uses exactly the same normalization as `mentionCount`:
 * 「小·柚」、小 柚 and 星宫雲-yuike all remain findable. It is only a prefilter —
 * the authoritative boundary check is still `mentionCount` on the raw text.
 */
export function buildMentionIndex(entries) {
  const bigrams = new Map()
  const push = (key, index) => {
    let set = bigrams.get(key)
    if (!set) { set = new Set(); bigrams.set(key, set) }
    set.add(index)
  }
  entries.forEach(({ text }, index) => {
    const chars = [...normalizeForIndex(text)]
    for (let i = 0; i + 1 < chars.length; i += 1) push(chars[i] + chars[i + 1], index)
  })
  return { bigrams }
}

/** Rarest posting set for one name, or null when the prefilter proves no hit. */
function mentionCandidates(mentionIndex, name) {
  const key = normalizeForIndex(name)
  if (!key) return null
  const chars = [...key]
  if (chars.length < 2) return null
  let best = null
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const set = mentionIndex.bigrams.get(chars[i] + chars[i + 1])
    if (!set || set.size === 0) return new Set()
    if (!best || set.size < best.size) best = set
  }
  return best || new Set()
}

function matchField(entry, name) {
  const titleOffset = firstMention(entry?.title || '', name)
  if (titleOffset >= 0) return { field: 'title', offset: titleOffset }
  const contentOffset = firstMention(entry?.content || '', name)
  if (contentOffset >= 0) return { field: 'content', offset: contentOffset }
  return null
}

/**
 * memory→entity edges for every confirmed entity. One edge per (memory, entity);
 * the longest matching alias supplies the evidence surface. `maxPerEntity` keeps
 * a popular name from turning into an unbounded fan-out; the newest memories win.
 */
export function mentionEdges(entries, entities, { policy = AUTOLINK_POLICY_V3 } = {}) {
  const confirmed = (Array.isArray(entities) ? entities : []).filter(isConfirmedEntity)
  if (!confirmed.length || !entries.length) return []
  const mentionIndex = buildMentionIndex(entries)
  const cap = Math.max(1, Number(policy.maxMentionEdgesPerEntity) || 200)
  const edges = []
  for (const entity of confirmed) {
    const surfaces = entitySurfaces(entity)
    if (!surfaces.length) continue
    const matched = new Map()
    for (const name of surfaces) {
      const candidates = mentionCandidates(mentionIndex, name)
      if (!candidates) continue
      for (const index of candidates) {
        const item = entries[index]
        if (!item || matched.has(item.id)) continue
        if (mentionCount(item.text, name) === 0) continue
        const at = matchField(item.entry, name)
        if (!at) continue
        matched.set(item.id, { item, name, ...at })
      }
    }
    if (!matched.size) continue
    const picked = [...matched.values()]
      .sort((a, b) => String(b.item.entry?.updatedAt || b.item.entry?.createdAt || '').localeCompare(String(a.item.entry?.updatedAt || a.item.entry?.createdAt || ''))
        || a.item.id.localeCompare(b.item.id))
      .slice(0, cap)
    for (const hit of picked) {
      edges.push({
        from: hit.item.id,
        to: entity.id,
        kind: entity.kind === 'person' ? 'person' : 'relation',
        rule: 'entity-mention',
        confidence: 1,
        schemaVersion: AUTOLINK_SCHEMA_VERSION,
        evidence: { rule: 'entity-mention', entityId: entity.id, surface: hit.name, field: hit.field, offset: hit.offset },
      })
    }
  }
  return edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
}

/** All entries as link targets: field evidence may cite a superseded/archived row. */
function allEntries(index) {
  return Object.entries(index?.entries || {}).map(([id, entry]) => ({ id: String(id), entry }))
}

/**
 * One O(N) pass that turns the pairwise field scans into lookups:
 *   reverseConflicts/Supersedes : target id -> rows that point AT it
 *   families                    : fact_key+context -> time-ordered versions
 * The old shape scanned the whole library once per entry (O(N²), 6s at 10k).
 */
function buildFieldIndexes(rows) {
  const byId = new Map()
  const reverseConflicts = new Map()
  const reverseSupersedes = new Map()
  const families = new Map()
  const pushTo = (map, key, value) => {
    let list = map.get(key)
    if (!list) { list = []; map.set(key, list) }
    list.push(value)
  }
  for (const row of rows) {
    const entry = row.entry
    if (!entry) continue
    byId.set(row.id, row)
    if (entry.conflicts_with) pushTo(reverseConflicts, String(entry.conflicts_with), row)
    if (entry.supersedes) pushTo(reverseSupersedes, String(entry.supersedes), row)
    if (entry.fact_key) {
      const key = `${entry.fact_key}\u0000${contextSignature(entry.context)}`
      pushTo(families, key, row)
    }
  }
  const positions = new Map()
  for (const [key, rowsInFamily] of families) {
    rowsInFamily.sort((a, b) => String(a.entry?.createdAt || '').localeCompare(String(b.entry?.createdAt || ''))
      || (Number(a.entry?.version) || 0) - (Number(b.entry?.version) || 0)
      || a.id.localeCompare(b.id))
    rowsInFamily.forEach((row, index) => positions.set(`${key}\u0000${row.id}`, index))
  }
  return { byId, reverseConflicts, reverseSupersedes, families, positions }
}

function fieldEdge(from, to, kind, field, rule) {
  return {
    from, to, kind, rule, confidence: 1,
    schemaVersion: AUTOLINK_SCHEMA_VERSION,
    evidence: { rule, field },
  }
}

function relationFieldEdges(indexes, id) {
  const self = indexes.byId.get(id)
  const entry = self?.entry
  if (!entry) return []
  const out = []
  const add = (from, to, kind, field, rule) => {
    if (!from || !to || from === to) return
    if (!indexes.byId.has(String(to))) return
    out.push(fieldEdge(from, to, kind, field, rule))
  }
  if (entry.conflicts_with) add(id, entry.conflicts_with, 'conflict', 'conflicts_with', 'conflict')
  if (entry.supersedes) add(id, entry.supersedes, 'supersede', 'supersedes', 'supersede')
  // memory.js writes the reverse field in the same transaction; the reverse index
  // makes both directed edges O(1) instead of a per-entry full scan.
  for (const other of indexes.reverseConflicts.get(id) || []) add(other.id, id, 'conflict', 'conflicts_with', 'conflict')
  for (const other of indexes.reverseSupersedes.get(id) || []) add(other.id, id, 'supersede', 'supersedes', 'supersede')
  return out
}

/** Same fact_key + context: chain the versions instead of building a clique. */
function factKeyEdge(indexes, id) {
  const self = indexes.byId.get(id)
  const entry = self?.entry
  const key = entry?.fact_key
  if (!key) return []
  const familyKey = `${key}\u0000${contextSignature(entry.context)}`
  const position = indexes.positions.get(`${familyKey}\u0000${id}`)
  if (position === undefined || position <= 0) return []
  const other = indexes.families.get(familyKey)[position - 1]
  if (!other) return []
  if (entry.conflicts_with === other.id || other.entry?.conflicts_with === id) return []
  return [fieldEdge(id, other.id, 'relation', 'fact_key', 'fact-key')]
}

function collectFieldEdges(indexes, ids) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw)
    if (!indexes.byId.has(id)) continue
    for (const edge of [...relationFieldEdges(indexes, id), ...factKeyEdge(indexes, id)]) {
      const dedupe = `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${edge.rule}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      out.push(edge)
    }
  }
  return out
}

/**
 * Field-evidence edges for the given memory ids only. One O(N) index build, then
 * O(|ids|) lookups — the incremental consolidation path stays well under 50 ms
 * at 10k memories.
 */
export function fieldEvidenceEdgesFor(index, ids) {
  const indexes = buildFieldIndexes(allEntries(index))
  const eligible = new Set(eligibleEntries(index).map(item => item.id))
  const wanted = (Array.isArray(ids) ? ids : []).map(id => String(id)).filter(id => eligible.has(id))
  return collectFieldEdges(indexes, wanted)
}

/** Full-library field evidence, used by dry-run / migration / purity tests. */
export function fieldEvidenceEdges(index) {
  const indexes = buildFieldIndexes(allEntries(index))
  return collectFieldEdges(indexes, eligibleEntries(index).map(item => item.id))
}

export function filterSuppressed(edges, suppression) {
  if (!suppression || suppression.size === 0) return edges
  return edges.filter(edge => !isSuppressed(suppression, edge))
}

function sortEdges(edges) {
  return edges.sort((a, b) => (RULE_ORDER.get(a.rule) ?? 99) - (RULE_ORDER.get(b.rule) ?? 99)
    || a.from.localeCompare(b.from)
    || a.to.localeCompare(b.to)
    || a.kind.localeCompare(b.kind))
}

/**
 * Full deterministic decision over one library snapshot.
 * @returns { entities: edges[], ... } — edges carry rule/evidence/confidence 1.0
 */
export function decideAutoLinks({ index, entities = [], policy = AUTOLINK_POLICY_V3, suppression = null } = {}) {
  const entries = eligibleEntries(index)
  const mention = mentionEdges(entries, entities, { policy })
  const field = fieldEvidenceEdges(index)
  return filterSuppressed(sortEdges([...mention, ...field]), suppression)
}

/** Incremental decision for the entries a consolidation just touched. */
export function decideAutoLinksFor({ index, entities = [], ids, policy = AUTOLINK_POLICY_V3, suppression = null } = {}) {
  const all = eligibleEntries(index)
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(id => String(id)))
  const entries = all.filter(item => wanted.has(item.id))
  if (!entries.length) return []
  const mention = mentionEdges(entries, entities, { policy })
  const field = fieldEvidenceEdgesFor(index, [...wanted])
  return filterSuppressed(sortEdges([...mention, ...field]), suppression)
}

export default { decideAutoLinks, decideAutoLinksFor, mentionEdges, fieldEvidenceEdges, fieldEvidenceEdgesFor, eligibleEntries, isConfirmedEntity, effectiveEntityStatus }
