// Host `@deepseek-ai/dsh-session-query` stand-in for the external-append recovery tests.
// The real package is a host peer and is not installed in this repo. Tests put the cold
// log on the fake persistence object (`persistence.__coldLogs[sessionId]`), so the
// production `reconcilePersistedAhead` path can be exercised without the host.
export async function readColdSessionLog(persistence, sessionId) {
  const log = persistence?.__coldLogs?.[String(sessionId)]
  if (!log) {
    const error = new Error(`session "${sessionId}" not found`)
    error.name = 'SessionPersistenceNotFoundError'
    throw error
  }
  return log
}

export function assertSessionHeadersCompatible(a, b) {
  if (
    a.id !== b.id
    || a.createdAt !== b.createdAt
    || a.cwd !== b.cwd
    || a.parentSession !== b.parentSession
    || a.isSeeded !== b.isSeeded
    || (a.delegationDepth ?? 0) !== (b.delegationDepth ?? 0)
  ) {
    throw new Error(`session source headers conflict for session "${a.id}"`)
  }
}
