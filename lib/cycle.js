import {
  getSettings, listSessionBindings, getLastSleepAt, setLastSleepAt,
  getCycleState, setCycleState, listLibrariesAll, archiveLibrary, setSessionBinding,
  deleteLibrary, restoreLibrary, normalizeCwd,
} from './state.js'
import { expireShortTerm } from './memory.js'
import { requestPrivateConsolidation } from './private.js'
import { startGlobalCuration } from './curator.js'
import { runVisibilityMigrationPass } from './migrate.js'

const SWEEP_MS = 5 * 60 * 1000

function liveAgent(ctx, sessionId) {
  try {
    const agents = ctx.get?.('agents')
    return agents?.get?.(sessionId) || null
  } catch {
    return null
  }
}

function older(a, b) {
  const ta = Date.parse(a || '') || 0
  const tb = Date.parse(b || '') || 0
  return ta - tb
}

// Short-term expiry. Runs before the sleep pass on purpose: a draft that is already
// past its deadline must not be offered to consolidation as something worth keeping,
// and promoting a dead entry would resurrect text nobody asked for again.
export function runShortTermPass(_ctx, { now = Date.now(), log = () => {} } = {}) {
  try {
    const result = expireShortTerm({ now })
    if (result.expired.length > 0) {
      log(`expired ${result.expired.length} short-term memor${result.expired.length === 1 ? 'y' : 'ies'} in ${result.libraries.length} library(ies)`)
    }
    return result
  } catch (error) {
    log(`short-term expiry failed: ${error?.message || error}`)
    return { expired: [], libraries: [], error: String(error?.message || error) }
  }
}

// Sleep consolidation: after a conversation has been quiet for a while, the agent
// gets one instruction to tidy the library it wrote during it. Failed attempts
// back off, but never pretend that an unread transcript was consolidated.
export async function runSleepPass(ctx, { now = Date.now(), log = () => {} } = {}) {
  const settings = getSettings()
  if (settings.sleepConsolidation !== true) return { ran: 0, skipped: 'disabled' }
  const idleMs = Math.max(1, Number(settings.sleepAfterIdleMinutes) || 20) * 60_000
  let ran = 0
  for (const binding of listSessionBindings()) {
    if (!binding.lastTurnAt) continue
    const activeAt = Math.max(Date.parse(binding.lastTurnAt) || 0, Date.parse(binding.lastInboundAt) || 0, Date.parse(binding.lastAgentIdleAt) || 0)
    if (now - activeAt < idleMs) continue
    // Running includes a long-lived asynchronous tool. Waiting is not proof that
    // the conversation ended, and a fork should not race its active agent.
    if (liveAgent(ctx, binding.sessionId)?.status === 'running') continue
    if (binding.inbound?.pending?.length) continue
    if (older(getLastSleepAt(binding.sessionId), binding.lastTurnAt) >= 0) continue
    if ((Date.parse(binding.sleepRetryAt || '') || 0) > now) continue
    if (binding.useLibrary === false) {
      setLastSleepAt(binding.sessionId)
      continue
    }
    // One path for every session: both backends now read the transcript
    // themselves and neither touches the user's own chat — remote through the
    // configured endpoint, agent through a seeded fork (requestHistoricalConsolidation).
    // A live session used to be consolidated in place, which is exactly what put
    // a queued draft above the user's composer and then left a housekeeping turn
    // in their transcript for good.
    try {
      const result = await requestPrivateConsolidation(ctx, binding.sessionId)
      if (result?.ok) {
        // Only cover activity this pass began with, not new messages during it.
        setLastSleepAt(binding.sessionId, binding.lastTurnAt)
        setSessionBinding(binding.sessionId, { sleepRetryAt: null, sleepAttempts: 0, lastSleepError: null })
        ran += 1
      } else {
        const attempts = Number(binding.sleepAttempts || 0) + 1
        setSessionBinding(binding.sessionId, { sleepAttempts: attempts, lastSleepError: result?.error || 'not settled', sleepRetryAt: new Date(now + Math.min(60, 2 ** Math.min(attempts, 6)) * 60_000).toISOString() })
        log(`sleep consolidation skipped for ${binding.sessionId}: ${result?.error || 'not queued'}`)
      }
    } catch (error) {
      // A missing service or transient file failure can heal without a new turn.
      const attempts = Number(binding.sleepAttempts || 0) + 1
      setSessionBinding(binding.sessionId, { sleepAttempts: attempts, lastSleepError: String(error?.message || error), sleepRetryAt: new Date(now + Math.min(60, 2 ** Math.min(attempts, 6)) * 60_000).toISOString() })
      log(`sleep consolidation failed for ${binding.sessionId}: ${error?.message || error}`)
    }
  }
  return { ran }
}

// Background global curation: turn the conversations that happened since the last
// run into shared memory, using whichever session is live as the curator's parent.
export async function runCurationPass(ctx, { now = Date.now(), log = () => {} } = {}) {
  const settings = getSettings()
  const hours = Number(settings.autoCurateEveryHours) || 0
  if (!(hours > 0)) return { ran: 0, skipped: 'disabled' }
  const lastRunAt = Date.parse(getCycleState().lastCurateAt || '') || 0
  if (now - lastRunAt < hours * 3_600_000) return { ran: 0, skipped: 'not-due' }

  const limit = Math.max(1, Math.min(30, Number(settings.autoCurateSessionLimit) || 8))
  const due = listSessionBindings()
    .filter((b) => b.lastTurnAt && older(b.lastTurnAt, new Date(lastRunAt).toISOString()) > 0)
    .sort((a, b) => String(b.lastTurnAt).localeCompare(String(a.lastTurnAt)))
    .slice(0, limit)
    .map((b) => b.sessionId)
  if (due.length === 0) return { ran: 0, skipped: 'no-new-sessions' }

  const parent = due.find((id) => liveAgent(ctx, id))
    || listSessionBindings().map((b) => b.sessionId).find((id) => liveAgent(ctx, id))
  if (!parent) {
    // Deliberately not recording the attempt: the next sweep retries, and a run
    // that never started must not push the schedule forward.
    log('auto curation waiting for a live session to host the curator')
    return { ran: 0, skipped: 'no-live-parent' }
  }
  try {
    const job = await startGlobalCuration(ctx, { sessionIds: due, parentSessionId: parent, model: settings.curatorModel })
    setCycleState({ lastCurateAt: new Date(now).toISOString(), lastCurateJob: job?.id || null })
    return { ran: due.length, job }
  } catch (error) {
    log(`auto curation failed: ${error?.message || error}`)
    return { ran: 0, error: String(error?.message || error) }
  }
}

// A library leaves daily use when its workspace is removed from DSH — which is a
// pure unregister: the folder and every session log stay on disk. So the trigger is
// the workspace registry, never `fs.existsSync`. A deleted folder is not "removed
// from DSH", and a folder taken out of the sidebar still exists.
function registeredScopes(ctx) {
  let registry = null
  try { registry = ctx.get?.('workspaceRegistry') } catch { return null }
  if (!registry || typeof registry.list !== 'function') return null
  let list
  try { list = registry.list() } catch { return null }
  if (!Array.isArray(list)) return null
  // An empty registry is not trusted: a fresh install with no workspace yet must not
  // archive every library ever created.
  const scopes = list.map((ws) => normalizeCwd(ws?.path)).filter(Boolean)
  return { scopes: new Set(scopes), trustworthy: scopes.length > 0 }
}

export function runLibraryHousekeeping(ctx, { now = Date.now(), log = () => {} } = {}) {
  const settings = getSettings()
  const archived = []
  const revived = []
  const purged = []
  const purgeCandidates = []
  const registry = registeredScopes(ctx)

  for (const lib of listLibrariesAll()) {
    if (lib.archived === true) {
      const days = Number(settings.purgeArchivedAfterDays) || 0
      if (days > 0 && lib.archivedAt && (now - (Date.parse(lib.archivedAt) || now)) / 86_400_000 >= days) {
        purgeCandidates.push(lib.id)
      }
      // The workspace came back: un-archive it, or it stays hidden forever.
      if (registry?.trustworthy && registry.scopes.has(lib.scopeKey)) {
        if (restoreLibrary(lib.id).ok) revived.push(lib.id)
      }
      continue
    }
    if (!registry?.trustworthy) continue
    if (!lib.scopeKey || lib.scopeKey === '__default__') continue
    if (!registry.scopes.has(lib.scopeKey)) {
      archiveLibrary(lib.id)
      archived.push(lib.id)
      log(`archived library ${lib.id}: workspace ${lib.scopeKey} is no longer registered in DSH`)
    }
  }
  return { archived, revived, purged, purgeCandidates, registrySeen: Boolean(registry?.trustworthy) }
}

export async function runCyclePasses(ctx, options = {}) {
  const shortTerm = runShortTermPass(ctx, options)
  const sleep = await runSleepPass(ctx, options)
  const curate = await runCurationPass(ctx, options)
  const libraries = runLibraryHousekeeping(ctx, options)
  // A library can still be on disk in the removed `session` format when the plugin
  // updated mid-flight. Reads are already normalized, so this only keeps the files in
  // step with the code (see lib/migrate.js); it is cheap and idempotent.
  const migrated = runVisibilityMigrationPass({ log: options.log })
  return { shortTerm, sleep, curate, libraries, migrated }
}

// DSH has no host scheduler a plugin can register a *global* job with
// (`ctx.schedule` is session-bound and delivers a prompt into that session, which
// is the wrong shape for a plugin-wide sweep), so this owns a plain interval.
// Cordis' own `ctx.interval` is preferred because the host disposes it with the
// plugin scope; the raw fallback is unref'd so a plugin timer can never be the
// reason the app stays alive. Everything this reads is a persisted timestamp, so a
// missed sweep is recovered on the next one.
export function registerCycle(ctx, { log = () => {} } = {}) {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      await runCyclePasses(ctx, { log })
    } catch (error) {
      log(`cycle sweep failed: ${error?.message || error}`)
    } finally {
      running = false
    }
  }
  // Property access on an uninjected service throws in cordis, so the probe itself
  // is guarded; a host without the timer service falls back instead of failing.
  let scoped = null
  try { scoped = typeof ctx.interval === 'function' ? ctx : null } catch { scoped = null }
  if (scoped) {
    // cordis' ctx.interval returns a *disposer function*, not a Node timer id —
    // clearInterval() on it is a silent no-op and the sweep would keep running
    // after plugin unload/HMR. Call the disposer.
    const dispose = scoped.interval(() => { void tick() }, SWEEP_MS)
    return () => { try { dispose?.() } catch {} }
  }
  const timer = setInterval(() => { void tick() }, SWEEP_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
