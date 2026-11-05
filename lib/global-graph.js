// Global memory links: validation, transactional application, removal.
//
// Why this exists (spec §6.6): graph.js linkEntries is private-library-only —
// it resolves its store through scopeFor({exec, libraryId}) and the global
// index lives in a separate file with no links layer. Global edges therefore
// live INSIDE entries[id].links[] (§3.2): the top level of the global index is
// dropped by loadGlobalIndex, so entry-embedded is the only safe place.
//
// Rules (§4.9 / §0.3 C9/C10):
//   * kinds: related (symmetric, both ends share id+opId) / refines / supports
//     (directed, source end only, DFS cycle check depth ≤3).
//   * note 8-500 chars (whitespace-stripped length) and must quote at least
//     one grounded evidence item verbatim.
//   * evidence 1-3 items, all grounded; no evidence → no edge (both modes).
//   * confidence ∈ [0.5, 1]; every end ≤20 links; (to, kind) idempotent.
//   * cross-domain only related; rp↔coding never.
//   * links are metadata: they never touch the vector store and never delete
//     memory; removal deletes both ends of the edge by id.
//
// Concurrency: validateGlobalLink runs against the caller's index snapshot
// (fast rejection with a readable reason); applyGlobalLinks re-checks the
// mutable facts (active, idempotency, caps, cycle) INSIDE the
// updateGlobalIndex mutator so a concurrent write between snapshot and commit
// cannot smuggle a bad edge in.

import { createHash } from 'node:crypto'
import { record } from './activity-log.js'
import { loadGlobalIndex, updateGlobalIndex } from './state.js'
import { redactSecrets } from './paths.js'
import { groundEvidence, groundLinkNote } from './curator-evidence.js'
import { globalConflictCheck } from './text-retrieval.js'
import {
  GLOBAL_LINK_KINDS,
  LINK_CONFIDENCE_MIN,
  LINK_CYCLE_DEPTH,
  LINK_EVIDENCE_MAX,
  LINK_MAX_PER_ENTRY,
} from './curator-policy.js'

function sha116(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 16)
}

/**
 * §3.2 opId: sha1('link|' + kind + '|' + (symmetric ? sortedPair : from + '>' + to)
 * + '|' + normalize(note)).slice(0,16). Symmetric edges hash the sorted pair so
 * both ends derive the same id regardless of which end the model listed first.
 */
export function globalLinkOpId({ kind, fromId, toId, note }) {
  const symmetric = kind === 'related'
  const pair = symmetric
    ? [String(fromId), String(toId)].sort().join('|')
    : `${String(fromId)}>${String(toId)}`
  return sha116(`link|${kind}|${pair}|${normalizeForHash(note)}`)
}

function normalizeForHash(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function isDirected(kind) {
  return kind === 'refines' || kind === 'supports'
}

/**
 * DFS over directed refines/supports edges: can `startId` reach `goalId` in at
 * most maxDepth hops? Used to reject a from→to edge that would close a cycle
 * (to already reaching from).
 */
export function directedReaches(entries, startId, goalId, maxDepth = LINK_CYCLE_DEPTH) {
  const seen = new Set([startId])
  const walk = (id, depth) => {
    if (depth > maxDepth) return false
    for (const link of entries[id]?.links || []) {
      if (!isDirected(link?.kind)) continue
      const next = String(link.to || '')
      if (!next) continue
      if (next === goalId) return true
      if (seen.has(next)) continue
      seen.add(next)
      if (walk(next, depth + 1)) return true
    }
    return false
  }
  return walk(startId, 1)
}

function fail(reason) {
  return { ok: false, reason }
}

const AUDIT_MAX = 20

/** Append one bounded audit event to an entry (link/unlink/absorb undo). */
export function appendAudit(entry, event) {
  if (!entry) return
  const trail = Array.isArray(entry.auditTrail) ? entry.auditTrail.slice(-(AUDIT_MAX - 1)) : []
  trail.push(event)
  entry.auditTrail = trail
}

/**
 * validateGlobalLink({ index, fromId, toId, kind, note, confidence, evidence, sessionCorpus })
 * → { ok: true, fromId, toId, kind, symmetric, link } | { ok: false, reason }
 *
 * The returned link record is the §3.2 shape, fully prepared for storage:
 * { id: 'lnk_<opId>', opId, to, kind, note, confidence, evidence, createdAt }.
 * The caller applies it via applyGlobalLinks inside the index transaction.
 */
export function validateGlobalLink({ index, fromId, toId, kind, note, confidence, evidence, sessionCorpus = null, now = null }) {
  const entries = index?.entries || {}
  const from = String(fromId || '').trim()
  const to = String(toId || '').trim()
  const fromEntry = entries[from]
  const toEntry = entries[to]
  if (!fromEntry || !toEntry) return fail(`endpoint not found: ${!fromEntry ? from || '(empty)' : to || '(empty)'}`)
  if (from === to) return fail('self link')
  if (fromEntry.status !== 'active' || toEntry.status !== 'active') {
    return fail(`endpoint not active: ${fromEntry.status !== 'active' ? from : to}`)
  }
  if (!GLOBAL_LINK_KINDS.includes(kind)) return fail(`unknown kind: ${kind ?? '(missing)'}`)
  const noteText = String(note || '')
  const noteLen = noteText.replace(/\s+/g, '').length
  if (noteLen < 8 || noteLen > 500) return fail(`note length ${noteLen} outside 8-500`)
  const list = Array.isArray(evidence) ? evidence : []
  if (list.length < 1 || list.length > LINK_EVIDENCE_MAX) {
    return fail(`evidence must be 1-${LINK_EVIDENCE_MAX} items, got ${list.length}`)
  }
  const grounded = groundEvidence(list, sessionCorpus)
  if (!grounded.valid.length) {
    return fail(`evidence not grounded: ${grounded.invalid[0]?.reason || 'empty'}`)
  }
  if (grounded.invalid.length) {
    return fail(`evidence not grounded: ${grounded.invalid[0]?.reason}`)
  }
  const quoteCheck = groundLinkNote(noteText, grounded.valid)
  if (!quoteCheck.ok) return fail(`note quote: ${quoteCheck.reason}`)
  // §4.8 conflict prefilter: a contradictory pair must go through `conflict` /
  // human review, never become an auto-applied link edge. The prompt rule alone
  // is not a gate (2).
  const conflictSignal = globalConflictCheck(fromEntry, toEntry)
  if (conflictSignal) return fail(`conflict pair detected (${conflictSignal}); use op=conflict instead of link`)
  const conf = Number(confidence)
  if (!Number.isFinite(conf) || conf < LINK_CONFIDENCE_MIN || conf > 1) {
    return fail(`confidence ${Number.isFinite(conf) ? conf : '(nan)'} outside ${LINK_CONFIDENCE_MIN}-1`)
  }
  const fromDomain = fromEntry.domain || 'unknown'
  const toDomain = toEntry.domain || 'unknown'
  if (fromDomain !== toDomain) {
    if (kind !== 'related') return fail('cross-domain links must be related')
    if ((fromDomain === 'rp' && toDomain === 'coding') || (fromDomain === 'coding' && toDomain === 'rp')) {
      return fail('rp and coding never link')
    }
  }
  // idempotency pre-check on the snapshot (re-checked on fresh state in apply)
  if ((fromEntry.links || []).some((l) => l?.to === to && l?.kind === kind)) {
    return fail('duplicate link (idempotent)')
  }
  if (kind === 'related' && (toEntry.links || []).some((l) => l?.to === from && l?.kind === kind)) {
    return fail('duplicate link (idempotent)')
  }
  // cap: only the ends that will carry a record count (directed edges write the source end only)
  if ((fromEntry.links || []).length >= LINK_MAX_PER_ENTRY) return fail(`link cap reached on ${from}`)
  if (kind === 'related' && (toEntry.links || []).length >= LINK_MAX_PER_ENTRY) return fail(`link cap reached on ${to}`)
  if (isDirected(kind) && directedReaches(entries, to, from, LINK_CYCLE_DEPTH)) {
    return fail(`directed cycle: ${to} already reaches ${from} within depth ${LINK_CYCLE_DEPTH}`)
  }
  const opId = globalLinkOpId({ kind, fromId: from, toId: to, note: noteText })
  return {
    ok: true,
    fromId: from,
    toId: to,
    kind,
    symmetric: kind === 'related',
    link: {
      id: `lnk_${opId}`,
      opId,
      to,
      kind,
      note: redactSecrets(noteText),
      confidence: conf,
      evidence: grounded.valid.map((item) => ({ sessionId: item.sessionId, quote: item.quote })),
      createdAt: now || new Date().toISOString(),
    },
  }
}

/**
 * applyGlobalLinks(entries, writes, { now }) — runs INSIDE the
 * updateGlobalIndex mutator; `entries` is fresh.entries and is mutated in
 * place. Re-checks everything a concurrent writer could have changed, then
 * writes: symmetric edges land on both ends sharing id/opId; directed edges
 * only on the source end. One end full → neither end written (§4.11).
 *
 * Returns { applied: [{fromId, toId, kind, linkId}], skipped: [{linkId, reason}] }.
 */
export function applyGlobalLinks(entries, writes, { now = new Date().toISOString() } = {}) {
  const applied = []
  const skipped = []
  for (const write of writes || []) {
    const linkId = write?.link?.id || null
    const fromEntry = entries[write?.fromId]
    const toEntry = entries[write?.toId]
    if (!fromEntry || !toEntry || fromEntry.status !== 'active' || toEntry.status !== 'active') {
      skipped.push({ linkId, reason: 'endpoint missing or not active' })
      continue
    }
    if (globalConflictCheck(fromEntry, toEntry)) {
      skipped.push({ linkId, reason: 'conflict pair detected' })
      continue
    }
    fromEntry.links = Array.isArray(fromEntry.links) ? fromEntry.links : []
    if (write.symmetric) toEntry.links = Array.isArray(toEntry.links) ? toEntry.links : []
    const duplicateOnFrom = fromEntry.links.some((l) => l?.to === write.toId && l?.kind === write.kind)
    const duplicateOnTo = write.symmetric
      ? toEntry.links.some((l) => l?.to === write.fromId && l?.kind === write.kind)
      : false
    if (duplicateOnFrom || duplicateOnTo) {
      skipped.push({ linkId, reason: 'duplicate link (idempotent)' })
      continue
    }
    const capFrom = fromEntry.links.length >= LINK_MAX_PER_ENTRY
    const capTo = write.symmetric ? toEntry.links.length >= LINK_MAX_PER_ENTRY : false
    if (capFrom || capTo) {
      skipped.push({ linkId, reason: 'link cap reached' })
      continue
    }
    if (isDirected(write.kind) && directedReaches(entries, write.toId, write.fromId, LINK_CYCLE_DEPTH)) {
      skipped.push({ linkId, reason: 'directed cycle' })
      continue
    }
    const recordToStore = { ...write.link, createdAt: write.link?.createdAt || now }
    fromEntry.links.push(recordToStore)
    if (write.symmetric) toEntry.links.push({ ...recordToStore, to: write.fromId })
    const audit = {
      op: 'link', at: recordToStore.createdAt, linkId: recordToStore.id,
      fromId: write.fromId, toId: write.toId, kind: write.kind,
    }
    appendAudit(fromEntry, audit)
    if (write.symmetric) appendAudit(toEntry, { ...audit, fromId: write.toId, toId: write.fromId })
    applied.push({ fromId: write.fromId, toId: write.toId, kind: write.kind, linkId: recordToStore.id })
  }
  return { applied, skipped }
}

const GRAPH_HIDDEN_STATUS = new Set(['suppressed', 'expired'])

/**
 * getGlobalGraph({ focusId, depth, limit }) — read-only node graph over the
 * global index. Private memory has getGraph in graph.js; global edges live in
 * entries[id].links[] and have no entity store, so this mirrors the same
 * node/edge contract without entities or merge candidates.
 *
 * Suppressed/expired entries are hidden; a deleted target keeps a placeholder
 * node so the edge does not silently disappear, while an existing hidden target
 * gets no hint at all (same rule as the private graph).
 */
export function getGlobalGraph({ focusId = null, depth = 1, limit = 200 } = {}) {
  const index = loadGlobalIndex()
  const entries = index.entries || {}
  const cap = Math.max(1, Math.min(200, Math.floor(Number(limit) || 200)))
  const hops = Math.max(0, Math.min(2, Math.floor(Number(depth) || 0)))
  const visible = new Set(Object.entries(entries)
    .filter(([, entry]) => entry && !GRAPH_HIDDEN_STATUS.has(entry.status || 'active'))
    .map(([id]) => id))
  const edges = []
  const adjacency = new Map()
  // Symmetric `related` edges are stored on both ends under one link id; without
  // this set the canvas would draw the same line twice and the list twice.
  const seenEdges = new Set()
  for (const from of visible) {
    for (const link of entries[from].links || []) {
      if (!GLOBAL_LINK_KINDS.includes(link?.kind)) continue
      const to = String(link?.to || '')
      if (!to) continue
      if (entries[to] && !visible.has(to)) continue
      const edgeId = link.id || `${from}|${link.kind}|${to}`
      if (seenEdges.has(edgeId)) continue
      seenEdges.add(edgeId)
      // `related` is symmetric: sort the endpoints so the same edge reads the
      // same way whichever end happened to be visited first.
      const [edgeFrom, edgeTo] = link.kind === 'related' ? [from, to].sort() : [from, to]
      edges.push({
        from: edgeFrom,
        to: edgeTo,
        kind: link.kind,
        note: link.note,
        confidence: Number.isFinite(Number(link.confidence)) ? Number(link.confidence) : 0.7,
        source: link.source || null,
      })
      for (const [a, b] of [[from, to], [to, from]]) {
        if (!adjacency.has(a)) adjacency.set(a, new Set())
        adjacency.get(a).add(b)
      }
    }
  }
  const selected = new Set()
  if (focusId) {
    const id = String(focusId)
    if (!visible.has(id) && !adjacency.has(id)) throw new Error('unknown or inaccessible global graph focus')
    let frontier = [id]
    for (let hop = 0; hop <= hops; hop += 1) {
      const next = []
      for (const nodeId of frontier) {
        if (selected.size >= cap || selected.has(nodeId)) continue
        selected.add(nodeId)
        if (hop < hops) next.push(...(adjacency.get(nodeId) || []))
      }
      frontier = next
    }
  } else {
    for (const id of [...visible, ...adjacency.keys()]) {
      if (selected.size >= cap) break
      selected.add(id)
    }
  }
  const nodes = [...selected].map((id) => {
    const entry = entries[id]
    const strength = Number(entry?.strength ?? entry?.confidence ?? 0.5)
    return {
      id,
      title: entry?.title || '[deleted]',
      layer: entry?.layer || null,
      // 'global' is distinct from private 'memory' so the canvas can colour it;
      // domain/status are display metadata for the tooltip and audit.
      kind: 'global',
      domain: entry?.domain || null,
      status: entry?.status || 'active',
      strength: Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0.5,
      degree: adjacency.get(id)?.size || 0,
      missing: !entry,
    }
  })
  return {
    nodes,
    edges: edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to)),
    limit: cap,
    truncated: selected.size >= cap,
    focusId: focusId || null,
    scope: 'global',
  }
}

/**
 * removeGlobalLink({ linkId, kind? }) — deletes the edge's records from every
 * entry carrying that id (symmetric edges die on both ends at once). Metadata
 * only: statuses, content and vector rows are untouched. Callable from
 * resolveReview's unlink action (F2 wires the rpc branch).
 */
export function removeGlobalLink({ linkId, kind } = {}) {
  const id = String(linkId || '').trim()
  if (!id) throw new Error('unlink needs a linkId')
  const kindFilter = kind ? String(kind) : null
  let removed = 0
  const entries = []
  updateGlobalIndex((index) => {
    for (const [entryId, entry] of Object.entries(index.entries || {})) {
      if (!Array.isArray(entry?.links) || entry.links.length === 0) continue
      const before = entry.links.length
      entry.links = entry.links.filter((l) => !(l?.id === id && (!kindFilter || l.kind === kindFilter)))
      if (entry.links.length !== before) {
        removed += before - entry.links.length
        entries.push(entryId)
        appendAudit(entry, { op: 'unlink', at: new Date().toISOString(), linkId: id, kind: kindFilter || null })
      }
    }
    return index
  })
  record({
    kind: 'curate',
    scope: 'global',
    ok: removed > 0,
    level: removed > 0 ? 'info' : 'warn',
    message: removed > 0
      ? `全局关联已移除：linkId ${id}（${removed} 条记录，涉及 ${entries.length} 个条目）`
      : `全局关联移除未命中：linkId ${id} 不存在于任何条目`,
    detail: { op: 'unlink', linkId: id, kind: kindFilter, removed, entries: entries.slice(0, 20) },
  })
  return { removed, entries }
}
