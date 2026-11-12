// Write side of the deterministic link layer. All decisions come from decide.js;
// this module only persists them (idempotently) and keeps the activity log
// honest. A failing pass must never fail the consolidation that triggered it —
// the caller catches and warns.

import { getSettings, updatePrivateIndex } from '../state.js'
import { stamp } from '../paths.js'
import { record } from '../activity-log.js'
import { isMemoryEligible } from '../memory.js'
import { AUTOLINK_SCHEMA_VERSION, EVIDENCE_RULES } from './policy.js'
import { decideAutoLinksFor, eligibleEntries, mentionEdges } from './decide.js'
import { isSuppressed } from './suppression.js'

// Rules this layer owns. worker-quote edges come from the explicit tool and must
// survive a recompute; anything else auto-generated is replaced, not appended.
export const AUTO_RULES = Object.freeze(['entity-mention', 'conflict', 'supersede', 'fact-key'])

function isEligibleEntry(entry) {
  return Boolean(entry) && entry.visibility !== 'secret' && isMemoryEligible(entry, { automatic: true })
}

function noteFor(edge) {
  if (edge.rule === 'entity-mention') {
    const surface = edge.evidence?.surface ? `「${edge.evidence.surface}」` : ''
    const field = edge.evidence?.field === 'title' ? '标题' : '正文'
    return `提及已确认实体${surface}（${field}）。`
  }
  if (edge.rule === 'conflict') return '字段证据：conflicts_with 指向这条记忆，两者是同一事实的不同版本。'
  if (edge.rule === 'supersede') return '字段证据：supersedes 指向被取代的旧记忆。'
  if (edge.rule === 'fact-key') return '字段证据：同一 fact_key 且上下文一致的相邻版本。'
  return `确定性关联：${edge.rule}。`
}

function recordFor(edge, existing) {
  return {
    to: edge.to,
    kind: edge.kind,
    note: noteFor(edge),
    confidence: 1,
    createdAt: existing?.createdAt || stamp(),
    source: 'auto',
    schemaVersion: edge.schemaVersion || AUTOLINK_SCHEMA_VERSION,
    evidence: { ...(edge.evidence || {}), rule: edge.rule },
  }
}

// A repeated decision over unchanged content must not look like a write: same
// target, rule, note and evidence means the edge already says exactly this.
function sameAsRecord(existing, edge) {
  if (!existing || existing.source !== 'auto') return false
  const record_ = recordFor(edge, existing)
  return existing.kind === record_.kind
    && existing.note === record_.note
    && existing.confidence === 1
    && existing.schemaVersion === record_.schemaVersion
    && JSON.stringify(existing.evidence || null) === JSON.stringify(record_.evidence)
}

/**
 * Apply decided edges inside one index transaction. Existing manual/user edges
 * with the same (to, kind) win — an automatic fact never overwrites what a
 * person or the worker asserted. Returns counts plus the applied edge list.
 */
export function applyAutoEdges({ libraryId, edges, entities = [], sessionId = null, operation = 'auto-link-apply' } = {}) {
  const counts = { added: 0, updated: 0, skippedManual: 0, skippedCap: 0, skipped: 0, memory: 0, entity: 0 }
  const applied = []
  if (!libraryId || !Array.isArray(edges) || edges.length === 0) return { ...counts, applied }
  const entityIds = new Set((Array.isArray(entities) ? entities : []).map(entity => entity?.id).filter(Boolean))
  updatePrivateIndex(libraryId, index => {
    for (const edge of edges) {
      // The write layer only accepts the declared evidence vocabulary; an
      // unknown rule is a caller bug, never a new edge category.
      if (!EVIDENCE_RULES.includes(edge?.rule)) { counts.skipped += 1; continue }
      const from = index.entries[edge?.from]
      if (!from || !isEligibleEntry(from)) { counts.skipped += 1; continue }
      const isMemoryTarget = Boolean(index.entries[edge.to])
      if (!isMemoryTarget && !entityIds.has(edge.to)) { counts.skipped += 1; continue }
      const links = Array.isArray(from.links) ? from.links : []
      const at = links.findIndex(link => link && link.to === edge.to && link.kind === edge.kind)
      if (at >= 0 && links[at].source !== 'auto') { counts.skippedManual += 1; continue }
      if (at >= 0 && sameAsRecord(links[at], edge)) continue
      if (at < 0 && links.length >= 100) { counts.skippedCap += 1; continue }
      const record_ = recordFor(edge, at >= 0 ? links[at] : null)
      if (at >= 0) {
        links[at] = record_
        counts.updated += 1
      } else {
        links.push(record_)
        counts.added += 1
      }
      from.links = links
      counts[isMemoryTarget ? 'memory' : 'entity'] += 1
      applied.push({ from: edge.from, to: edge.to, kind: edge.kind, rule: edge.rule })
    }
  })
  if (counts.added || counts.updated) {
    try {
      record({
        kind: 'write', scope: 'private', sessionId, libraryId, ok: true,
        message: `自动关联写入 ${counts.added + counts.updated} 条（新增 ${counts.added} / 更新 ${counts.updated}）`,
        detail: {
          op: operation, added: counts.added, updated: counts.updated,
          skippedManual: counts.skippedManual, skippedCap: counts.skippedCap, skipped: counts.skipped,
          memory: counts.memory, entity: counts.entity,
        },
        refs: [...new Set(applied.map(edge => edge.from))].slice(0, 20),
      })
    } catch {}
  }
  return { ...counts, applied }
}

/**
 * Incremental refresh for the memories a consolidation touched: drop the auto
 * edges this layer generated for them, then re-add today's deterministic ones.
 * Removal and addition share one index lock, so a crash cannot leave the entry
 * with half a rule set.
 */
export function refreshMemoryAutoLinks({ libraryId, ids, entities = [], suppression = null, sessionId = null, operation = 'auto-link-apply' } = {}) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(id => String(id)).filter(Boolean))]
  const counts = { added: 0, updated: 0, removed: 0, skippedManual: 0, skippedCap: 0, skipped: 0, memory: 0, entity: 0 }
  const applied = []
  if (!libraryId || !wanted.length) return { ...counts, applied }
  const entityIds = new Set((Array.isArray(entities) ? entities : []).map(entity => entity?.id).filter(Boolean))
  updatePrivateIndex(libraryId, index => {
    const decided = decideAutoLinksFor({ index, entities, ids: wanted, suppression })
    // Diff instead of wipe-and-rebuild: an unchanged edge keeps its createdAt and
    // counts as no write, so a repeat pass over the same window is a no-op.
    const byMemory = new Map()
    for (const edge of decided) {
      if (!byMemory.has(edge.from)) byMemory.set(edge.from, new Map())
      byMemory.get(edge.from).set(`${edge.to}\u0000${edge.kind}`, edge)
    }
    for (const id of wanted) {
      const entry = index.entries[id]
      if (!entry || !Array.isArray(entry.links)) continue
      const candidates = byMemory.get(id) || new Map()
      const next = []
      let changed = false
      for (const link of entry.links) {
        // Rule-owned edges plus marker-less legacy auto edges: both are this
        // layer's noise and are replaced by today's decision.
        const owned = link && link.source === 'auto' && (AUTO_RULES.includes(link.evidence?.rule) || !link.evidence?.rule)
        if (!owned) { next.push(link); continue }
        const key = `${link.to}\u0000${link.kind}`
        const edge = candidates.get(key)
        if (edge && sameAsRecord(link, edge)) { candidates.delete(key); next.push(link); continue }
        counts.removed += 1
        changed = true
      }
      if (changed) entry.links = next
    }
    for (const [fromId, candidates] of byMemory) {
      const from = index.entries[fromId]
      if (!from || !isEligibleEntry(from)) { counts.skipped += candidates.size; continue }
      const links = Array.isArray(from.links) ? from.links : []
      for (const edge of candidates.values()) {
        const isMemoryTarget = Boolean(index.entries[edge.to])
        if (!isMemoryTarget && !entityIds.has(edge.to)) { counts.skipped += 1; continue }
        const at = links.findIndex(link => link && link.to === edge.to && link.kind === edge.kind)
        if (at >= 0 && links[at].source !== 'auto') { counts.skippedManual += 1; continue }
        if (at < 0 && links.length >= 100) { counts.skippedCap += 1; continue }
        const record_ = recordFor(edge, at >= 0 ? links[at] : null)
        if (at >= 0) { links[at] = record_; counts.updated += 1 }
        else { links.push(record_); counts.added += 1 }
        counts[isMemoryTarget ? 'memory' : 'entity'] += 1
        applied.push({ from: edge.from, to: edge.to, kind: edge.kind, rule: edge.rule })
      }
      from.links = links
    }
  })
  const written = counts.added + counts.updated
  if (written || counts.removed) {
    try {
      record({
        kind: 'write', scope: 'private', sessionId, libraryId, ok: true,
        message: `自动关联重算 ${written} 条（新增 ${counts.added} / 更新 ${counts.updated} / 清理 ${counts.removed}）`,
        detail: {
          op: operation, added: counts.added, updated: counts.updated, removed: counts.removed,
          skippedManual: counts.skippedManual, skippedCap: counts.skippedCap, skipped: counts.skipped,
          memory: counts.memory, entity: counts.entity,
        },
        refs: [...new Set(applied.map(edge => edge.from))].slice(0, 20),
      })
    } catch {}
  }
  return { ...counts, applied }
}

/**
 * Recompute one entity's mention edges across the whole library. Used when an
 * entity is confirmed, renamed, merged or revoked; field edges are untouched.
 */
export function refreshEntityMentions({ libraryId, entity, suppression = null, sessionId = null, operation = 'auto-link-entity' } = {}) {
  const counts = { added: 0, updated: 0, removed: 0, skipped: 0 }
  if (!libraryId || !entity?.id) return counts
  // 'off' means every automatic edge path is closed, including the ones explicit
  // UI actions used to trigger (create/confirm/rename/merge). 'suggest' still
  // maintains edges on an explicit confirmation: the §14 S4 migration flow
  // confirms while the automatic pass is still held back.
  if (getSettings().autoLinkMode === 'off') return counts
  updatePrivateIndex(libraryId, index => {
    const decided = entity.status === 'confirmed'
      ? mentionEdges(eligibleEntries(index), [entity]).filter(edge => !isSuppressed(suppression, edge))
      : []
    const byLink = new Map(decided.map(edge => [`${edge.from}\u0000${edge.to}\u0000${edge.kind}`, edge]))
    for (const [fromId, entry] of Object.entries(index.entries || {})) {
      if (!entry || !Array.isArray(entry.links)) continue
      const next = []
      let changed = false
      for (const link of entry.links) {
        const owned = link && link.source === 'auto' && link.evidence?.rule === 'entity-mention'
          && link.evidence?.entityId === entity.id
        if (!owned) { next.push(link); continue }
        const key = `${fromId}\u0000${link.to}\u0000${link.kind}`
        const edge = byLink.get(key)
        if (edge && sameAsRecord(link, edge)) { byLink.delete(key); next.push(link); continue }
        counts.removed += 1
        changed = true
      }
      if (changed) entry.links = next
    }
    for (const edge of byLink.values()) {
      const from = index.entries[edge.from]
      if (!from) continue
      const links = Array.isArray(from.links) ? from.links : []
      const at = links.findIndex(link => link && link.to === edge.to && link.kind === edge.kind)
      if (at >= 0 && links[at].source !== 'auto') { counts.skipped += 1; continue }
      if (at < 0 && links.length >= 100) { counts.skipped += 1; continue }
      const record_ = recordFor(edge, at >= 0 ? links[at] : null)
      if (at >= 0) { links[at] = record_; counts.updated += 1 }
      else { links.push(record_); counts.added += 1 }
      from.links = links
    }
  })
  if (counts.added || counts.updated || counts.removed) {
    try {
      record({
        kind: 'write', scope: 'private', sessionId, libraryId, ok: true,
        message: `实体提及边重算「${entity.name || entity.id}」：新增 ${counts.added} / 更新 ${counts.updated} / 清理 ${counts.removed}`,
        detail: { op: operation, entityId: entity.id, status: entity.status || null, ...counts },
        refs: [entity.id],
      })
    } catch {}
  }
  return counts
}

export default { applyAutoEdges, refreshMemoryAutoLinks, refreshEntityMentions, AUTO_RULES }
