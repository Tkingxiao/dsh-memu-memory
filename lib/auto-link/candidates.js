// Review-queue builder (DESIGN §9). Candidate terms and legacy entity grades are
// derived data: they change no entity status and write no edge. The snapshot is
// persisted next to the index so the panel can render without recomputing, and
// it is safe to delete/recreate at any time.

import fs from 'node:fs'
import path from 'node:path'
import { dataDir, indexDir, isSafeId, writeJson } from '../paths.js'
import { loadPrivateIndex } from '../state.js'
import { listEntities } from '../graph.js'
import { loadLexicon } from '../lexicon.js'
import { AUTOLINK_POLICY_V3, AUTOLINK_POLICY_VERSION } from './policy.js'
import { eligibleEntries, effectiveEntityStatus } from './decide.js'
import { buildTermStats, rankCandidates } from './terminology.js'
import { normalizeForIndex } from './normalize.js'

const CACHE = new Map()

export function candidatesFile(libraryId) {
  if (!isSafeId(libraryId)) throw new Error('invalid library id')
  return path.join(indexDir(), `${libraryId}.anchor-candidates.json`)
}

function statSignature(libraryId) {
  const files = [
    path.join(indexDir(), `${libraryId}.json`),
    path.join(indexDir(), `${libraryId}.entities.json`),
    path.join(dataDir(), 'lexicon', `${libraryId}.json`),
  ]
  return files.map(file => {
    try {
      const stat = fs.statSync(file)
      return `${stat.mtimeMs}:${stat.size}`
    } catch { return '0:0' }
  }).join('|')
}

function lexiconSignals(libraryId) {
  const user = new Set()
  const model = new Set()
  let terms = {}
  try { terms = loadLexicon(libraryId).terms || {} } catch { return { user, model } }
  for (const entry of Object.values(terms)) {
    if (!entry || entry.status !== 'active') continue
    const userOwned = entry.source === 'user' || Boolean(entry.reviewedBy)
    const target = userOwned ? user : (entry.source === 'model-proposal' ? model : null)
    if (!target) continue
    for (const name of [entry.term, ...(Array.isArray(entry.aliases) ? entry.aliases : [])]) {
      const key = normalizeForIndex(name)
      if (key) target.add(key)
    }
  }
  return { user, model }
}

function entitySurfaceMap(entities) {
  const map = new Map()
  for (const entity of entities) {
    for (const name of [entity.name, ...(Array.isArray(entity.aliases) ? entity.aliases : [])]) {
      const key = normalizeForIndex(name)
      if (key && !map.has(key)) map.set(key, entity)
    }
  }
  return map
}

/**
 * Build (or reuse) one library's review queue. The snapshot never contains
 * memory bodies: rows are terms plus statistics, which the UI already shows.
 */
export function generateAnchorCandidates({ libraryId, now = Date.now(), force = false, policy = AUTOLINK_POLICY_V3 } = {}) {
  if (!isSafeId(libraryId)) throw new Error('invalid library id')
  const signature = statSignature(libraryId)
  const cached = CACHE.get(libraryId)
  if (!force && cached && cached.signature === signature) return cached.value
  const stored = readStored(libraryId)
  if (!force && stored && stored.revision === signature && Array.isArray(stored?.tiers?.tier1)) {
    CACHE.set(libraryId, { signature, value: stored })
    return stored
  }

  const index = loadPrivateIndex(libraryId)
  const rows = eligibleEntries(index).map(item => ({
    id: item.id,
    title: String(item.entry?.title || ''),
    text: `${item.entry?.title || ''}\n${item.entry?.content || ''}`,
  }))
  const stats = buildTermStats(rows, policy)
  const { user, model } = lexiconSignals(libraryId)
  const tiers = rankCandidates(rows, stats, { policy, lexiconUser: user, lexiconModel: model })
  const entityItems = listEntities({ libraryId }).items
  const bySurface = entitySurfaceMap(entityItems)
  for (const tier of ['tier1', 'tier2']) {
    for (const row of tiers[tier]) {
      const entity = bySurface.get(normalizeForIndex(row.term))
      if (!entity) continue
      row.entityId = entity.id
      row.entityName = entity.name
      row.entityKind = entity.kind
      row.entityStatus = effectiveEntityStatus(entity)
    }
  }
  const provisional = entityItems
    .filter(entity => effectiveEntityStatus(entity) === 'provisional')
    .map(entity => ({
      id: entity.id, name: entity.name, kind: entity.kind, linked: entity.linked === true,
      origin: entity.origin || null,
      terms: [...tiers.tier1, ...tiers.tier2].filter(row => row.entityId === entity.id).map(row => row.term),
    }))
    .sort((a, b) => (b.terms.length - a.terms.length) || a.name.localeCompare(b.name))
  const confirmed = entityItems
    .filter(entity => effectiveEntityStatus(entity) === 'confirmed')
    .map(entity => ({ id: entity.id, name: entity.name, kind: entity.kind }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const value = {
    version: 1,
    libraryId,
    revision: signature,
    policyVersion: AUTOLINK_POLICY_VERSION,
    generatedAt: new Date(now).toISOString(),
    totals: { memories: rows.length, entities: entityItems.length, tier1: tiers.tier1.length, tier2: tiers.tier2.length },
    tiers,
    entities: { provisional, confirmed },
  }
  CACHE.set(libraryId, { signature, value })
  try { writeJson(candidatesFile(libraryId), value) } catch {}
  return value
}

function readStored(libraryId) {
  try {
    const raw = fs.readFileSync(candidatesFile(libraryId), 'utf8')
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/** Test/ops helper: drop the in-process cache so the next read recomputes. */
export function resetAnchorCandidatesCache() {
  CACHE.clear()
}

/**
 * The candidate row for one confirmed-able term: the UI either confirms an
 * existing provisional entity or creates a confirmed one. Returns a descriptor;
 * the actual confirm/create stays an explicit user RPC.
 */
export function candidateConfirmationTarget(candidate) {
  if (candidate?.entityId && candidate.entityStatus === 'provisional') return { kind: 'confirm', entityId: candidate.entityId }
  if (candidate?.entityId && candidate.entityStatus === 'confirmed') return { kind: 'already-confirmed', entityId: candidate.entityId }
  return { kind: 'create', name: String(candidate?.term || '') }
}
