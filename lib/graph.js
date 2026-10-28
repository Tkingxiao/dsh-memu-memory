import path from 'node:path'
import { indexDir, readJsonStrict, writeJson, withFileLock, stamp } from './paths.js'
import { loadPrivateIndex, updatePrivateIndex, newMemoryId } from './state.js'
import { resolveLibrary, sessionIdOf, visibleToSession, isMemoryEligible, decayStrength } from './memory.js'

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

export function listEntities(args) {
  const scope = scopeFor(args)
  const store = readEntities(scope.libraryId)
  const index = loadPrivateIndex(scope.libraryId)
  const visible = new Set(Object.values(index.entries)
    .filter(entry => allowed(entry, args.exec)).flatMap(entry => (entry.links || []).map(link => link.to)))
  const items = Object.values(store.entities).filter(entity => !sessionIdOf(args.exec) || visible.has(entity.id))
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

export function linkEntries({ exec, libraryId, fromId, toId, kind, note, confidence = 0.7 }) {
  const scope = scopeFor({ exec, libraryId })
  if (!LINK_KINDS.includes(kind)) throw new Error(`link kind must be ${LINK_KINDS.join(', ')}`)
  const reason = String(note || '').trim()
  if (reason.replace(/\s/g, '').length < 8 || reason.length > 500) throw new Error('link note must contain 8-500 characters explaining the evidence')
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('link confidence must be between 0 and 1')
  if (fromId === toId) throw new Error('a memory cannot link to itself')
  const entities = readEntities(scope.libraryId).entities
  let result
  updatePrivateIndex(scope.libraryId, index => {
    const source = index.entries[fromId]
    const target = index.entries[toId]
    if (!source || !allowed(source, exec) || target && !allowed(target, exec)) throw new Error('unknown or inaccessible memory')
    if (!target && !entities[toId]) throw new Error('link target must be an existing memory or entity')
    if (kind === 'person' && entities[toId]?.kind !== 'person') throw new Error('person links must target a person entity')
    const links = Array.isArray(source.links) ? source.links : []
    result = { to: toId, kind, note: reason, confidence, createdAt: stamp() }
    const found = links.findIndex(link => link.to === toId && link.kind === kind)
    if (found >= 0) links[found] = result
    else {
      if (links.length >= 100) throw new Error('memory already has 100 links; review the existing connections first')
      links.push(result)
    }
    source.links = links
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

export function getGraph({ exec, libraryId, focusId = null, depth = 1, limit = 200 }) {
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
      const edge = { from, to: link.to, kind: link.kind, note: link.note, confidence: link.confidence ?? 0.7 }
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
    for (const id of [...visible, ...Object.keys(entities), ...adjacency.keys()]) {
      if (selected.size >= cap) break
      if (sessionIdOf(exec) && !visible.has(id) && !adjacency.has(id)) continue
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
      if (!target && !entities[to]) continue
      out.push({ id: to, title: target?.title || entities[to]?.name, kind: link.kind, note: String(link.note || '').slice(0, 80), confidence: link.confidence ?? 0.7 })
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
