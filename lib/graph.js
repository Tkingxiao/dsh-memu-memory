import path from 'node:path'
import { indexDir, readJsonStrict, writeJson, withFileLock, stamp, warn } from './paths.js'
import { loadPrivateIndex, updatePrivateIndex, newMemoryId, listLibraries } from './state.js'
import { resolveLibrary, sessionIdOf, visibleToSession, isMemoryEligible, decayStrength } from './memory.js'
import { record } from './activity-log.js'
// Entity merge suggestions reuse the exact folding rule auto-linking already
// uses (NFKC / case / whitespace / punctuation). This is a deliberate module
// cycle: private-links.js imports the entity writers from here, but both sides
// only touch each other's bindings in function bodies, and ESM hoists the
// function declarations before either module body runs.
import { normalizeEntityName } from './private-links.js'

export const LINK_KINDS = ['relation', 'commitment', 'event', 'person', 'conflict']
const ENTITY_KINDS = ['person', 'place', 'thing', 'org']
function entitiesPath(libraryId) { return path.join(indexDir(), `${libraryId}.entities.json`) }

function readEntities(libraryId) {
  const result = readJsonStrict(entitiesPath(libraryId))
  if (result.ok) {
    if (!result.value?.entities || typeof result.value.entities !== 'object' || Array.isArray(result.value.entities)) throw new Error('invalid entity store')
    return { relationships: {}, ...result.value }
  }
  if (result.missing) return { version: 1, entities: {}, relationships: {} }
  throw new Error(`cannot read entity store: ${result.error?.message || 'invalid data'}`)
}

function scopeFor(args) { return resolveLibrary({ ...args, readOnly: true }) }
function allowed(entry, exec) {
  return !sessionIdOf(exec) || (isMemoryEligible(entry, { automatic: true }) && visibleToSession(entry, sessionIdOf(exec)))
}

/**
 * Entity listing with the derived `linked` flag (§6.4 包 D). The visibility rule
 * is unchanged: without a session every entity comes back (GraphPanel calls it
 * exactly that way), with a session only entities reachable from visible memory
 * links are listed. What is new is the classification:
 *   * `linked` = referenced by an entry's links[] OR by a relationship snapshot.
 *     A snapshot counts — an entity with only a relationship and no memory link
 *     is history, not an orphan, and must not be misjudged as one.
 *   * With a session, a snapshot only counts when its evidenceIds include a
 *     memory visible in this conversation; without a session every snapshot
 *     counts (there is nobody to hide it from).
 * `linked` is derived on the fly and never written back to the entities file —
 * the startup prune (pruneOrphanEntitiesAll) stays the sole collector.
 */
export function listEntities(args) {
  const scope = scopeFor(args)
  const store = readEntities(scope.libraryId)
  const index = loadPrivateIndex(scope.libraryId)
  const sessionId = sessionIdOf(args.exec)
  const linked = new Set()
  for (const entry of Object.values(index.entries)) {
    if (!allowed(entry, args.exec)) continue
    for (const link of entry.links || []) linked.add(link.to)
  }
  for (const rel of Object.values(store.relationships || {})) {
    if (sessionId) {
      const evidenceVisible = (Array.isArray(rel?.evidenceIds) ? rel.evidenceIds : [])
        .some(id => { const entry = index.entries[id]; return Boolean(entry) && allowed(entry, args.exec) })
      if (!evidenceVisible) continue
    }
    if (rel?.fromId) linked.add(rel.fromId)
    if (rel?.toId) linked.add(rel.toId)
  }
  const items = Object.values(store.entities)
    .filter(entity => !sessionId || linked.has(entity.id))
    .map(entity => ({ ...entity, linked: linked.has(entity.id) }))
  return { items, total: items.length }
}

export function graphExport(libraryId) {
  const scope = scopeFor({ libraryId })
  return readEntities(scope.libraryId)
}

export function restoreGraphData(libraryId, data, memoryIdMap) {
  if (!data?.entities) return
  const scope = scopeFor({ libraryId })
  const entityMap = {}
  for (const [oldId, entity] of Object.entries(data.entities).slice(0, 2000)) {
    if (!/^ent[-_][a-z0-9_-]+$/i.test(oldId)) continue
    const restored = createEntity({ libraryId: scope.libraryId, name: entity.name, kind: entity.kind, aliases: entity.aliases || [] })
    entityMap[oldId] = restored.id
  }
  const remap = { ...entityMap, ...memoryIdMap }
  updatePrivateIndex(libraryId, index => {
    for (const id of Object.values(memoryIdMap)) {
      const entry = index.entries[id]
      if (!entry) continue
      entry.links = (entry.links || []).map(link => ({ ...link, to: remap[link.to] || link.to }))
    }
  })
  for (const relationship of Object.values(data.relationships || {})) {
    if (!entityMap[relationship.fromId] || !entityMap[relationship.toId]) continue
    const evidenceIds = (relationship.evidenceIds || []).map(id => memoryIdMap[id]).filter(Boolean)
    if (!evidenceIds.length) continue
    updateRelationship({ libraryId, fromId: entityMap[relationship.fromId], toId: entityMap[relationship.toId], state: relationship.state, evidenceIds, reason: relationship.reason || 'Imported relationship with explicit evidence.' })
  }
  // A backup carries the whole entity store, but only the memories that made it
  // through the export/import mapping come back, so entities nothing points at
  // any more would sit in the file forever as invisible weight. Collect them
  // once the remap is done; a prune failure must not fail a restore that
  // already succeeded, and the startup sweep would catch it on the next launch.
  try {
    pruneOrphanEntities(scope.libraryId)
  } catch (error) {
    warn(`orphan entity prune after graph restore skipped: ${error?.message || error}`)
  }
}

export function createEntity({ exec, libraryId, name, kind = 'person', aliases = [] }) {
  const scope = scopeFor({ exec, libraryId })
  if (!ENTITY_KINDS.includes(kind)) throw new Error(`entity kind must be ${ENTITY_KINDS.join(', ')}`)
  const clean = String(name || '').trim()
  if (!clean || clean.length > 120) throw new Error('entity name must contain 1-120 characters')
  const file = entitiesPath(scope.libraryId)
  return withFileLock(file, () => {
    const store = readEntities(scope.libraryId)
    const existing = Object.values(store.entities).find(entity => entity.name === clean && entity.kind === kind)
    if (existing) return existing
    const id = newMemoryId('ent')
    const entity = { id, name: clean, kind, aliases: normalizeAliases(aliases), createdAt: stamp(), updatedAt: stamp() }
    store.entities[id] = entity
    writeJson(file, store)
    return entity
  })
}

function normalizeAliases(aliases) {
  if (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== 'string')) throw new Error('aliases must be an array of strings')
  return [...new Set(aliases.map(alias => alias.trim()).filter(Boolean))].slice(0, 30).map(alias => alias.slice(0, 120))
}

export function renameEntity({ libraryId, entityId, name, aliases = [] }) {
  const scope = scopeFor({ libraryId })
  const clean = String(name || '').trim()
  if (!clean || clean.length > 120) throw new Error('entity name must contain 1-120 characters')
  const file = entitiesPath(scope.libraryId)
  return withFileLock(file, () => {
    const store = readEntities(scope.libraryId)
    const entity = store.entities[entityId]
    if (!entity) throw new Error('unknown entity')
    entity.name = clean
    entity.aliases = normalizeAliases(aliases)
    entity.updatedAt = stamp()
    writeJson(file, store)
    return entity
  })
}

// What keeps an entity alive. Edges only live in one direction: an entry's
// links[] names the entity, the entity stores nothing back. On top of that,
// relationship snapshots (same file, keyed by the endpoint pair) describe the
// pair with history and evidence that outlive the individual entries — deleting
// an endpoint would leave a snapshot whose endpoints no longer resolve, so a
// snapshot counts as a reference too. An entity referenced by neither is an
// *orphan*: unreachable except as a graph placeholder, and safe to collect.
// Orphans come from old builds whose permanent delete dropped the memory row
// without cascading, and from partial backups.

/**
 * Remove every entity in one library that no entry links to and no relationship
 * snapshot references. Idempotent: on healthy data it writes nothing. Returns
 * `{ removed, total }` with the removed entity ids.
 *
 * `keep` names ids that must survive even while unreferenced — a merge passes
 * its target, because folding sources into a row and then collecting that row
 * would silently undo the merge when the pair had no edges yet.
 */
export function pruneOrphanEntities(libraryId, keep = []) {
  const scope = scopeFor({ libraryId })
  const file = entitiesPath(scope.libraryId)
  const protectedIds = new Set(Array.isArray(keep) ? keep : [])
  return withFileLock(file, () => {
    const store = readEntities(scope.libraryId)
    const ids = Object.keys(store.entities)
    if (!ids.length) return { removed: [], total: 0 }
    const referenced = new Set()
    for (const entry of Object.values(loadPrivateIndex(scope.libraryId).entries || {})) {
      for (const link of entry.links || []) referenced.add(link.to)
    }
    for (const relationship of Object.values(store.relationships || {})) {
      referenced.add(relationship.fromId)
      referenced.add(relationship.toId)
    }
    const removed = ids.filter(id => !referenced.has(id) && !protectedIds.has(id))
    // Write only when something actually goes, so the common case never touches
    // the file (mtime-based caches, backups and concurrent readers all benefit).
    if (removed.length) {
      for (const id of removed) delete store.entities[id]
      writeJson(file, store)
    }
    return { removed, total: ids.length }
  })
}

/**
 * The startup sweep: run pruneOrphanEntities over every active library. One
 * corrupt store must not stop the rest, so per-library failures are collected
 * instead of thrown; the caller decides how to log them. Archived libraries are
 * deliberately left alone (frozen user data — restoring one runs the prune via
 * restoreGraphData anyway). Returns `{ scanned, removed, failed }`.
 */
export function pruneOrphanEntitiesAll() {
  const libraries = listLibraries()
  const result = { scanned: libraries.length, removed: 0, failed: [] }
  for (const library of libraries) {
    try {
      result.removed += pruneOrphanEntities(library.id).removed.length
    } catch (error) {
      result.failed.push({ libraryId: library.id, error: String(error?.message || error) })
    }
  }
  return result
}

/**
 * Delete an entity. This is graph bookkeeping, not a memory write: the entity
 * row goes, no memory text is touched. An entity still referenced by links or
 * relationship snapshots is refused by default — silently deleting it would
 * turn every one of those edges into a `[deleted]` placeholder and rewrite what
 * those memories are *about*. `force` deletes through that: inbound links are
 * removed from every entry (not session-filtered — a link left behind in an
 * entry this conversation cannot see would dangle exactly the way this guard
 * exists to prevent, and the entry text itself is untouched) and relationship
 * snapshots on the endpoints are dropped with their history, which is the loss
 * `force` is asking for. Index links are cleaned before the entity row so a
 * crash between the two writes leaves at worst a collectable orphan, never a
 * link to an entity that is already gone.
 */
export function deleteEntity({ exec, libraryId, entityId, force = false }) {
  const scope = scopeFor({ exec, libraryId })
  if (!entityId || typeof entityId !== 'string') throw new Error('entityId is required')
  const file = entitiesPath(scope.libraryId)
  return withFileLock(file, () => {
    const store = readEntities(scope.libraryId)
    if (!store.entities[entityId]) throw new Error('unknown entity')
    const index = loadPrivateIndex(scope.libraryId)
    let inbound = 0
    for (const entry of Object.values(index.entries || {})) {
      for (const link of entry.links || []) if (link.to === entityId) inbound += 1
    }
    const relationshipKeys = Object.keys(store.relationships || {})
      .filter(key => { const [from, to] = JSON.parse(key); return from === entityId || to === entityId })
    if ((inbound || relationshipKeys.length) && !force) {
      const parts = []
      if (inbound) parts.push(`${inbound} link(s) point at it`)
      if (relationshipKeys.length) parts.push(`${relationshipKeys.length} relationship snapshot(s) reference it`)
      throw new Error(`entity is still referenced: ${parts.join(' and ')}; remove the links first or pass force to delete the entity with them`)
    }
    let removedLinks = 0
    if (inbound) {
      updatePrivateIndex(scope.libraryId, fresh => {
        for (const entry of Object.values(fresh.entries)) {
          if (!Array.isArray(entry.links) || !entry.links.some(link => link.to === entityId)) continue
          const kept = entry.links.filter(link => link.to !== entityId)
          removedLinks += entry.links.length - kept.length
          entry.links = kept
        }
      })
    }
    for (const key of relationshipKeys) delete store.relationships[key]
    delete store.entities[entityId]
    writeJson(file, store)
    return { entityId, deleted: true, removedLinks, removedRelationships: relationshipKeys.length }
  })
}

/**
 * Merge one or more source entities into a target entity inside the same
 * library. This is graph bookkeeping, not a memory write: no memory text or
 * vector is touched, links only change the entity id they point at.
 *
 * Lock order follows deleteEntity exactly: the entity file lock is taken first
 * and the private index lock is nested inside it (withFileLock is re-entrant,
 * and no path takes the index lock before the entity lock, so this order cannot
 * deadlock). The index remap is written *before* the source rows are deleted:
 * a crash between the two writes leaves at worst collectable entities behind,
 * never a surviving link that points at an entity that is already gone.
 *
 * Dedupe after remapping keeps the edge that already pointed at the target (or,
 * with no such edge, the first remapped one), and carries an `auto` marker over
 * from a dropped duplicate so the graph view keeps its badge. Relationship
 * snapshots are re-keyed on the target; an existing target-side snapshot wins
 * and the discarded source key is reported in `relationships.conflicts`.
 */
export function mergeEntities({ exec, libraryId, targetId, sourceIds } = {}) {
  const scope = scopeFor({ exec, libraryId })
  if (typeof targetId !== 'string' || !targetId.trim()) throw new Error('targetId is required')
  const target = targetId.trim()
  if (!Array.isArray(sourceIds) || !sourceIds.length) throw new Error('sourceIds must be a non-empty array of entity ids')
  const sources = []
  const seen = new Set()
  for (const raw of sourceIds) {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('sourceIds must contain entity ids')
    const id = raw.trim()
    if (id === target) throw new Error('target entity cannot be one of its own sources')
    if (seen.has(id)) continue
    seen.add(id)
    sources.push(id)
  }
  if (!sources.length) throw new Error('sourceIds must name at least one entity')
  const file = entitiesPath(scope.libraryId)
  let targetName = target
  const result = withFileLock(file, () => {
    const store = readEntities(scope.libraryId)
    const targetEntity = store.entities[target]
    if (!targetEntity || typeof targetEntity !== 'object') throw new Error(`unknown entity: ${target}`)
    targetName = String(targetEntity.name || target)
    const sourceEntities = []
    for (const id of sources) {
      const entity = store.entities[id]
      if (!entity || typeof entity !== 'object') throw new Error(`unknown entity: ${id}`)
      if (entity.kind !== targetEntity.kind) {
        throw new Error(`cannot merge entities of different kinds: ${targetEntity.kind || 'unknown'} vs ${entity.kind || 'unknown'}`)
      }
      sourceEntities.push(entity)
    }

    // Union of names: the target's own name stays the display name, every
    // source name becomes an alias, and the shared normalizer trims, dedupes
    // and caps at 30. Anything beyond the cap is reported, not silently lost.
    const rawAliases = [
      ...(Array.isArray(targetEntity.aliases) ? targetEntity.aliases : []),
      ...sourceEntities.flatMap(entity => [entity.name, ...(Array.isArray(entity.aliases) ? entity.aliases : [])]),
    ].filter(alias => typeof alias === 'string')
    const aliasUnion = [...new Set(rawAliases.map(alias => alias.trim()).filter(Boolean))]
    const aliases = normalizeAliases(aliasUnion)
    const droppedAliases = aliasUnion.slice(aliases.length)

    const sourceSet = new Set(sources)
    let remappedLinks = 0
    let duplicateLinks = 0
    updatePrivateIndex(scope.libraryId, index => {
      for (const entry of Object.values(index.entries || {})) {
        const links = Array.isArray(entry.links) ? entry.links : null
        if (!links || !links.some(link => link && sourceSet.has(link.to))) continue
        // Kinds already present on the target win the dedupe; every remapped
        // edge of such a kind is a duplicate, and an `auto` marker survives on
        // the retained edge even when the dropped copy was the auto one.
        const targetKinds = new Set()
        for (const link of links) if (link && link.to === target) targetKinds.add(link.kind)
        const autoKinds = new Set()
        const nextLinks = []
        for (const link of links) {
          if (!link || !sourceSet.has(link.to)) { nextLinks.push(link); continue }
          remappedLinks += 1
          if (targetKinds.has(link.kind)) {
            duplicateLinks += 1
            if (link.source === 'auto') autoKinds.add(link.kind)
            continue
          }
          targetKinds.add(link.kind)
          nextLinks.push({ ...link, to: target })
        }
        for (const kind of autoKinds) {
          const at = nextLinks.findIndex(item => item && item.to === target && item.kind === kind)
          if (at >= 0 && !nextLinks[at].source) nextLinks[at] = { ...nextLinks[at], source: 'auto' }
        }
        entry.links = nextLinks
      }
    })

    // Re-key snapshots: replace source endpoints with the target, keep an
    // existing target-side snapshot untouched (it is the history written under
    // the real pair), and drop self-loops a merge would create. The whole
    // snapshot object, history included, moves unchanged.
    const relationships = { moved: 0, conflicts: [] }
    for (const key of Object.keys(store.relationships || {})) {
      const snapshot = store.relationships[key]
      if (!snapshot || typeof snapshot !== 'object') continue
      let endpoints
      try { endpoints = JSON.parse(key) } catch { continue }
      if (!Array.isArray(endpoints) || endpoints.length !== 2) continue
      const [fromId, toId] = endpoints
      if (!sourceSet.has(fromId) && !sourceSet.has(toId)) continue
      const nextFrom = sourceSet.has(fromId) ? target : fromId
      const nextTo = sourceSet.has(toId) ? target : toId
      delete store.relationships[key]
      if (nextFrom === nextTo) {
        relationships.conflicts.push({ key, reason: 'self' })
        continue
      }
      const nextKey = JSON.stringify([nextFrom, nextTo])
      if (store.relationships[nextKey]) {
        relationships.conflicts.push({ key, reason: 'existing-target', keptKey: nextKey })
        continue
      }
      store.relationships[nextKey] = { ...snapshot, fromId: nextFrom, toId: nextTo }
      relationships.moved += 1
    }

    targetEntity.aliases = aliases
    targetEntity.updatedAt = stamp()
    for (const id of sources) delete store.entities[id]
    writeJson(file, store)
    // Safety net: a source may have been kept alive only by a snapshot that the
    // merge dropped. The same lock is re-entered, so this cannot race the write
    // above; a prune failure must not turn a completed merge into an error. The
    // target is protected — an unreferenced pair is still a legitimate merge and
    // collecting the row it just merged into would undo it.
    try { pruneOrphanEntities(scope.libraryId, [target]) } catch (error) {
      warn(`orphan entity prune after entity merge skipped: ${error?.message || error}`)
    }
    return { targetId: target, merged: sources, aliases, droppedAliases, remappedLinks, duplicateLinks, relationships }
  })

  // The merge is already durable; the activity log is diagnostics and is
  // fail-open by design, so it must never decide the result.
  try {
    record({
      kind: 'write', scope: 'private', libraryId: scope.libraryId, ok: true,
      message: `实体合并：「${targetName}」并入完成（${sources.length} 个来源）`,
      detail: {
        op: 'entity-merge', targetId: target, merged: sources,
        remappedLinks: result.remappedLinks, duplicateLinks: result.duplicateLinks,
        movedRelationships: result.relationships.moved,
        relationshipConflicts: result.relationships.conflicts.length,
        aliases: result.aliases.length, droppedAliases: result.droppedAliases.length,
      },
      refs: [target, ...sources],
    })
  } catch {}
  return result
}

const SUGGEST_LIMIT = 20

function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0 }

// Bounded Levenshtein. Row minima never decrease, so once a row's best cell is
// already above the budget the remaining rows cannot recover; scanning stops.
function withinEditDistance(a, b, max) {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > max) return false
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    let best = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
      current[j] = value
      if (value < best) best = value
    }
    if (best > max) return false
    previous = current
  }
  return previous[b.length] <= max
}

/**
 * Pure read: candidate entity merges inside one library. Never writes and never
 * merges — the caller shows the pair and the user confirms.
 *
 * Names are folded with normalizeEntityName (NFKC / case / whitespace /
 * punctuation), identical folded names are skipped (that duplicate is handled by
 * createEntity or an explicit merge), and only same-kind pairs qualify. A pair
 * is a candidate when the shorter normalized name is contained in the longer one
 * and has >= 2 characters, or when both names have >= 3 characters and sit at
 * most 2 edits apart. The longer name is the target (the hub the shorter one
 * folds into); on equal length the older id wins, which keeps the direction
 * stable across calls. Results are sorted by reason then names then ids, and
 * capped at 20.
 */
export function suggestEntityMerges({ libraryId } = {}) {
  const scope = scopeFor({ libraryId })
  const store = readEntities(scope.libraryId)
  const rows = Object.values(store.entities || {})
    .filter(entity => entity && typeof entity === 'object' && entity.id)
    .map(entity => ({ id: String(entity.id), kind: String(entity.kind || ''), key: normalizeEntityName(entity.name) }))
    .filter(row => row.key)
  const found = []
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i]
      const b = rows[j]
      if (a.kind !== b.kind || a.key === b.key) continue
      const aIsLonger = a.key.length > b.key.length || (a.key.length === b.key.length && a.id < b.id)
      const longer = aIsLonger ? a : b
      const shorter = aIsLonger ? b : a
      let reason = null
      if (shorter.key.length >= 2 && longer.key.includes(shorter.key)) reason = 'containment'
      else if (shorter.key.length >= 3
        && longer.key.length - shorter.key.length <= 2
        && withinEditDistance(shorter.key, longer.key, 2)) reason = 'edit-distance'
      if (!reason) continue
      found.push({ sourceId: shorter.id, targetId: longer.id, reason, sourceKey: shorter.key, targetKey: longer.key })
    }
  }
  found.sort((x, y) => (x.reason === y.reason ? 0 : x.reason === 'containment' ? -1 : 1)
    || compareText(x.targetKey, y.targetKey)
    || compareText(x.sourceKey, y.sourceKey)
    || compareText(x.targetId, y.targetId)
    || compareText(x.sourceId, y.sourceId))
  return { items: found.slice(0, SUGGEST_LIMIT).map(item => ({ sourceId: item.sourceId, targetId: item.targetId, reason: item.reason })) }
}

/**
 * Write one directed link from a memory to a memory or entity.
 *
 * `source` records who made the edge: 'auto' (private auto-association / entity
 * hub, §5.3–5.5) or 'user'. Anything else is omitted rather than stored, so the
 * field never turns into a free-form label and an old link without it keeps
 * reading as a model/user link. Replacement stays idempotent: the same
 * (to, kind) pair is overwritten in place instead of appended.
 */
export function linkEntries({ exec, libraryId, fromId, toId, kind, note, confidence = 0.7, source }) {
  const scope = scopeFor({ exec, libraryId })
  if (!LINK_KINDS.includes(kind)) throw new Error(`link kind must be ${LINK_KINDS.join(', ')}`)
  const reason = String(note || '').trim()
  if (reason.replace(/\s/g, '').length < 8 || reason.length > 500) throw new Error('link note must contain 8-500 characters explaining the evidence')
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('link confidence must be between 0 and 1')
  if (fromId === toId) throw new Error('a memory cannot link to itself')
  const linkSource = source === 'auto' || source === 'user' ? source : null
  const entities = readEntities(scope.libraryId).entities
  let result
  updatePrivateIndex(scope.libraryId, index => {
    const origin = index.entries[fromId]
    const target = index.entries[toId]
    if (!origin || !allowed(origin, exec) || target && !allowed(target, exec)) throw new Error('unknown or inaccessible memory')
    if (!target && !entities[toId]) throw new Error('link target must be an existing memory or entity')
    if (kind === 'person' && entities[toId]?.kind !== 'person') throw new Error('person links must target a person entity')
    const links = Array.isArray(origin.links) ? origin.links : []
    result = { to: toId, kind, note: reason, confidence, createdAt: stamp() }
    if (linkSource) result.source = linkSource
    const found = links.findIndex(link => link.to === toId && link.kind === kind)
    if (found >= 0) links[found] = result
    else {
      if (links.length >= 100) throw new Error('memory already has 100 links; review the existing connections first')
      links.push(result)
    }
    origin.links = links
  })
  return { from: fromId, ...result }
}

export function unlinkEntry({ libraryId, fromId, toId, kind }) {
  const scope = scopeFor({ libraryId })
  let removed = 0
  updatePrivateIndex(scope.libraryId, index => {
    const entry = index.entries[fromId]
    if (!entry) throw new Error('unknown memory')
    entry.links = (entry.links || []).filter(link => {
      const drop = link.to === toId && (!kind || link.kind === kind)
      if (drop) removed += 1
      return !drop
    })
  })
  return { removed }
}

export function getGraph({ exec, libraryId, focusId = null, depth = 1, limit = 200, includeOrphans = false }) {
  const scope = scopeFor({ exec, libraryId })
  const index = loadPrivateIndex(scope.libraryId)
  const entities = readEntities(scope.libraryId).entities
  const cap = Math.max(1, Math.min(200, Math.floor(Number(limit) || 200)))
  const hops = Math.max(0, Math.min(2, Math.floor(Number(depth) || 0)))
  const visible = new Set(Object.entries(index.entries).filter(([, entry]) => allowed(entry, exec)).map(([id]) => id))
  const edges = []
  const adjacency = new Map()
  for (const from of visible) {
    for (const link of index.entries[from].links || []) {
      if (!LINK_KINDS.includes(link.kind)) continue
      // A deleted target gets a placeholder; an inaccessible target gets no hint.
      if (index.entries[link.to] && !visible.has(link.to)) continue
      // source is display metadata only ('auto' edges get a badge in the graph
      // view); an older link without the field reports null instead of undefined.
      const edge = { from, to: link.to, kind: link.kind, note: link.note, confidence: link.confidence ?? 0.7, source: link.source || null }
      edges.push(edge)
      for (const [a, b] of [[from, link.to], [link.to, from]]) {
        if (!adjacency.has(a)) adjacency.set(a, new Set())
        adjacency.get(a).add(b)
      }
    }
  }
  if (focusId && !visible.has(focusId) && !adjacency.has(focusId) && (!entities[focusId] || sessionIdOf(exec))) throw new Error('unknown or inaccessible graph focus')
  const selected = new Set()
  if (focusId) {
    let frontier = [focusId]
    for (let hop = 0; hop <= hops; hop += 1) {
      const next = []
      for (const id of frontier) {
        if (selected.size >= cap || selected.has(id)) continue
        selected.add(id)
        if (hop < hops) next.push(...(adjacency.get(id) || []))
      }
      frontier = next
    }
  } else {
    // Orphan entities — no edge from any visible entry — are hidden by default.
    // After the permanent-delete cascade and pruneOrphanEntities they should not
    // exist on disk at all; a leftover from old data is invisible weight, and a
    // session-scoped viewer already never saw them (the check below). Pass
    // includeOrphans to see what an old entities.json still holds. An explicit
    // focusId always wins: asking for a node by id is intent, not browsing.
    for (const id of [...visible, ...Object.keys(entities), ...adjacency.keys()]) {
      if (selected.size >= cap) break
      if (sessionIdOf(exec) && !visible.has(id) && !adjacency.has(id)) continue
      if (!includeOrphans && entities[id] && !adjacency.has(id)) continue
      selected.add(id)
    }
  }
  const nodes = [...selected].map(id => {
    const entry = index.entries[id]
    const entity = entities[id]
    return { id, title: entry?.title || entity?.name || '[deleted]', layer: entry?.layer || null,
      kind: entity?.kind || 'memory', strength: entry ? decayStrength(entry) : 0.5,
      degree: adjacency.get(id)?.size || 0, missing: !entry && !entity }
  })
  return { nodes, edges: edges.filter(edge => selected.has(edge.from) && selected.has(edge.to)), limit: cap, truncated: selected.size >= cap, focusId }
}

export function recallRelations(libraryId, index, id, sessionId) {
  const entities = readEntities(libraryId).entities
  const out = []
  for (const [from, entry] of Object.entries(index.entries || {})) {
    if (!isMemoryEligible(entry, { automatic: true }) || !visibleToSession(entry, sessionId)) continue
    for (const link of entry.links || []) {
      if (from !== id && link.to !== id) continue
      const to = from === id ? link.to : from
      const target = index.entries[to]
      if (target && (!isMemoryEligible(target, { automatic: true }) || !visibleToSession(target, sessionId))) continue
      // A dangling edge (entry and entity both gone) used to be dropped here
      // while getGraph rendered the same disk state as a [deleted] placeholder —
      // the two views disagreed. Both now report the edge and mark it `missing`;
      // the caller filters if it wants the old silence back.
      const missing = !target && !entities[to]
      out.push({ id: to, title: target?.title || entities[to]?.name || '[deleted]', kind: link.kind, note: String(link.note || '').slice(0, 80), confidence: link.confidence ?? 0.7, missing })
    }
  }
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, 2)
}

export function getRelationship({ exec, libraryId, fromId, toId }) {
  const scope = scopeFor({ exec, libraryId })
  const store = readEntities(scope.libraryId)
  const relationship = store.relationships[JSON.stringify([fromId, toId])]
  if (!relationship) return { relationship: null }
  const index = loadPrivateIndex(scope.libraryId)
  if (sessionIdOf(exec) && relationship.evidenceIds.some(id => !index.entries[id] || !allowed(index.entries[id], exec))) return { relationship: null }
  return { relationship }
}

export function updateRelationship({ exec, libraryId, fromId, toId, state, evidenceIds, reason }) {
  const scope = scopeFor({ exec, libraryId })
  if (fromId === toId) throw new Error('relationship needs two distinct entities')
  if (!Array.isArray(evidenceIds) || !evidenceIds.length || evidenceIds.length > 20) throw new Error('relationship needs 1-20 evidence memory ids')
  if (String(reason || '').trim().length < 8) throw new Error('relationship update needs an evidence-based reason')
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('relationship state must be an object')
  const snapshot = {}
  for (const key of ['familiarity', 'trust', 'warmth']) {
    if (state[key] === undefined || state[key] === null) { snapshot[key] = null; continue }
    if (!Number.isFinite(state[key]) || state[key] < 0 || state[key] > 1) throw new Error(`relationship ${key} must be 0-1 or null (unknown)`)
    snapshot[key] = state[key]
  }
  for (const key of ['boundaries', 'callbacks', 'openPromises']) {
    const values = state[key] || []
    if (!Array.isArray(values) || values.length > 20 || values.some(value => typeof value !== 'string' || value.length > 300)) throw new Error(`invalid relationship ${key}`)
    snapshot[key] = values.slice()
  }
  const index = loadPrivateIndex(scope.libraryId)
  if (evidenceIds.some(id => !index.entries[id] || !allowed(index.entries[id], exec))) throw new Error('relationship evidence is not visible in this conversation')
  const file = entitiesPath(scope.libraryId)
  return withFileLock(file, () => {
    const store = readEntities(scope.libraryId)
    if (!store.entities[fromId] || !store.entities[toId]) throw new Error('relationship endpoints must be existing entities')
    const key = JSON.stringify([fromId, toId])
    const previous = store.relationships[key]
    const history = [...(previous?.history || [])]
    if (previous) history.push({ state: previous.state, evidenceIds: previous.evidenceIds, reason: previous.reason, validFrom: previous.validFrom, validTo: stamp() })
    const relationship = {
      fromId, toId, state: snapshot, evidenceIds: [...new Set(evidenceIds)],
      reason: String(reason).trim().slice(0, 1000), validFrom: stamp(), revision: (previous?.revision || 0) + 1,
      history,
    }
    store.relationships[key] = relationship
    writeJson(file, store)
    return { relationship }
  })
}
