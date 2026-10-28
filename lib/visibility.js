// Visibility used to have three levels: `shared`, `session` (a lease on the one
// conversation that wrote it) and `secret`. The session level is gone.
//
// It could never answer the question people actually ask — "can the same character in
// another conversation read this?" — because a lease that dies with its conversation
// is wrong in both of its states: while that conversation is alive it hides the memory
// from every other conversation of the same character (breaking continuity), and once
// the conversation is deleted it falls back to the whole folder (protecting nothing).
// Anything that has to stay out of another conversation is expressed with `context`
// (channelId / characterId / worldId / branchId) instead: that survives conversation
// deletion, and it is the only dimension the reader checks.
//
// Stored data from an older version is still read here, so a library that has not been
// rewritten yet behaves exactly like a migrated one: `session` is read as `shared`, and
// the entry keeps a marker saying where it came from.
export const STORED_VISIBILITIES = ['shared', 'secret']
export const LEGACY_SESSION = 'session'

export function normalizeVisibility(value) {
  return value === LEGACY_SESSION ? 'shared' : value
}

export function isLegacySession(entry) {
  return entry?.visibility === LEGACY_SESSION
}

// Rewrites one entry in place. The timestamp is recorded so a reader can tell a memory
// that was always shared from one that inherited its folder during the upgrade.
export function migrateEntryVisibility(entry, now) {
  if (!entry || typeof entry !== 'object') return false
  let changed = false
  if (isLegacySession(entry)) {
    entry.visibility = 'shared'
    entry.migratedFromVisibility = LEGACY_SESSION
    entry.visibilityMigratedAt = now
    changed = true
  }
  // `sessionId` meant nothing outside the lease it belonged to; older writes also left
  // `sessionId: null` on ordinary entries. Either way it is a dead pointer, and a later
  // reader must not mistake it for a live scope.
  if ('sessionId' in entry) {
    delete entry.sessionId
    changed = true
  }
  return changed
}

export function migrateIndexVisibility(index, now = new Date().toISOString()) {
  const entries = index?.entries
  if (!entries || typeof entries !== 'object') return 0
  let migrated = 0
  for (const entry of Object.values(entries)) if (migrateEntryVisibility(entry, now)) migrated += 1
  return migrated
}

// Counted against the raw file, before load-time normalization, so a pass can tell a
// library that still needs rewriting from one that is already migrated. A leftover
// `sessionId` counts: it is the same old shape, just without the level that used it.
export function countLegacyInRaw(raw) {
  const entries = raw?.entries
  if (!entries || typeof entries !== 'object') return 0
  return Object.values(entries).filter((entry) => isLegacySession(entry) || (entry && 'sessionId' in entry)).length
}
