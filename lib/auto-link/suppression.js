import path from 'node:path'
import { indexDir, isSafeId, readJsonStrict, writeJson, withFileLock, stamp } from '../paths.js'

// Negative feedback for the deterministic link layer. When the user removes an
// automatic edge (or revokes an entity, which collects its edges), the exact
// (from, to, kind, rule) key is written here so the next consolidation cannot
// resurrect it. One file per library, next to the index it protects.

const VERSION = 1

function suppressionFile(libraryId) {
  if (!isSafeId(libraryId)) throw new Error('invalid library id')
  return path.join(indexDir(), `${libraryId}.link-suppression.json`)
}

/** Canonical key for one edge. A legacy auto edge without a rule keeps its own key. */
export function suppressionKey(edge) {
  const rule = String(edge?.rule || edge?.evidence?.rule || 'auto')
  return `${String(edge?.from || '')}|${String(edge?.to || '')}|${String(edge?.kind || '')}|${rule}`
}

function tripleKey(edge) {
  return `${String(edge?.from || '')}|${String(edge?.to || '')}|${String(edge?.kind || '')}`
}

/**
 * A user's removal is a negative label on the (from, to, kind) fact, not on the
 * rule string that happened to be current. Legacy auto edges carry no rule, so a
 * later deterministic edge with `entity-mention` must still be blocked. The
 * wildcard key (`...|*`) is what makes "deleted never comes back" true across a
 * rule upgrade; `...|auto` keeps older suppression files working.
 */
export function isSuppressed(suppression, edge) {
  if (!suppression || suppression.size === 0) return false
  return suppression.has(suppressionKey(edge))
    || suppression.has(`${tripleKey(edge)}|*`)
    || suppression.has(`${tripleKey(edge)}|auto`)
}

export function readSuppression(libraryId) {
  const file = suppressionFile(libraryId)
  const result = readJsonStrict(file)
  if (result.ok) {
    const value = result.value
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid link suppression store')
    const entries = value.entries && typeof value.entries === 'object' && !Array.isArray(value.entries) ? value.entries : {}
    return { version: VERSION, entries }
  }
  if (result.missing) return { version: VERSION, entries: {} }
  throw new Error(`cannot read link suppression store: ${result.error?.message || 'invalid data'}`)
}

/** Set of suppressed keys for the pure decision layer. A corrupt store throws. */
export function suppressionSet(libraryId) {
  return new Set(Object.keys(readSuppression(libraryId).entries))
}

/**
 * Persist suppression keys for removed edges. Idempotent: an existing key keeps
 * its original timestamp. The caller has already removed the edges; a failure
 * here must be reported by the caller, not silently repaired.
 */
export function addSuppression(libraryId, edges, { by = 'user' } = {}) {
  const list = (Array.isArray(edges) ? edges : []).filter(edge => edge && edge.from && edge.to)
  if (!list.length) return { added: 0, total: 0 }
  const file = suppressionFile(libraryId)
  return withFileLock(file, () => {
    const store = readSuppression(libraryId)
    let added = 0
    const at = stamp()
    for (const edge of list) {
      const key = suppressionKey(edge)
      const wildcard = `${tripleKey(edge)}|*`
      // Write both the exact rule and the triple wildcard: the former documents
      // what was removed, the latter keeps the fact suppressed after the rule
      // that produced it changes (legacy 'auto' -> 'entity-mention').
      for (const entryKey of [key, wildcard]) {
        if (store.entries[entryKey]) continue
        store.entries[entryKey] = {
          at, by: String(by || 'user'),
          from: String(edge.from), to: String(edge.to),
          kind: String(edge.kind || ''), rule: entryKey === wildcard ? '*' : String(edge.rule || edge.evidence?.rule || 'auto'),
        }
        added += 1
      }
    }
    if (added) writeJson(file, store)
    return { added, total: Object.keys(store.entries).length }
  })
}

export function clearSuppression(libraryId) {
  const file = suppressionFile(libraryId)
  return withFileLock(file, () => {
    let entries = {}
    try { entries = readSuppression(libraryId).entries } catch {}
    const cleared = Object.keys(entries).length
    writeJson(file, { version: VERSION, entries: {} })
    return { cleared }
  })
}
