import {
  getSettings, listSessionBindings, getLastSleepAt, setLastSleepAt,
  getCycleState, setCycleState, listLibrariesAll, archiveLibrary, setSessionBinding,
  deleteLibrary, restoreLibrary, normalizeCwd,
} from './state.js'
import { expireShortTerm } from './memory.js'
import { requestPrivateConsolidation } from './private.js'
import { startGlobalCuration } from './curator.js'
import { runVisibilityMigrationPass } from './migrate.js'
import { record } from './activity-log.js'
import { ACTIVE_MEMORY_POLICY, suppressionReason } from './active-memory.js'

const SWEEP_MS = 5 * 60 * 1000
// Long enough that the host has restored its session list and the agent objects
// the fork needs, short enough that a user who opens the app and reads for a minute
// still gets the catch-up before they type their next message.
const STARTUP_SWEEP_MS = 8000

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

// The host's answer when a conversation has been deleted: `session "<id>" not
// found`. It is not transient — retrying it is how a dead session used to be woken
// up once an hour forever.
//
// `ENOENT` is deliberately not part of this list. A missing file is what a failed
// *read* looks like, and captureSessionSnapshot marks every read failure retryable on
// purpose (`consolidation-snapshot.js` failed(): "读失败，可重试" → retryable: true).
// Matching the bare word here turned one unreadable transcript into `sessionGone`,
// and the sweep then skips that conversation (`if (binding.sessionGone) continue`)
// until `lib/inbound.js` clears the mark on some later human message — so a
// quiet-but-alive conversation silently stopped being consolidated.
export function isGoneSessionError(message) {
  return /session[^"]*".*" not found|no such session|session .*does not exist/i.test(String(message || ''))
}

// Sleep consolidation: after a conversation has been quiet for a while, the agent
// gets one instruction to tidy the library it wrote during it. Failed attempts
// back off, but never pretend that an unread transcript was consolidated.
//
// Two things this pass must not do. It must not wake a conversation that no longer
// exists: the host answers "session not found" for it forever, and the retry curve
// tops out at one hour, so one deleted chat used to be retried for the life of the
// install. And it must not read "there are new turns" as "there is something worth
// remembering" — `assessConsolidationValue` inspects the transcript first, and a
// session that only exchanged greetings is marked asleep instead of being forked.
export async function runSleepPass(ctx, { now = Date.now(), log = () => {}, limit = 2 } = {}) {
  const settings = getSettings()
  if (settings.sleepConsolidation !== true) return { ran: 0, skipped: 'disabled' }
  const idleMs = Math.max(1, Number(settings.sleepAfterIdleMinutes) || 3) * 60_000
  const candidates = []
  for (const binding of listSessionBindings()) {
    if (binding.consolidationFork || !binding.lastTurnAt) continue
    if (binding.sessionGone) continue
    const activeAt = Math.max(Date.parse(binding.lastTurnAt) || 0, Date.parse(binding.lastInboundAt) || 0, Date.parse(binding.lastAgentIdleAt) || 0)
    if (now - activeAt < idleMs) continue
    // Running includes a long-lived asynchronous tool. Waiting is not proof that
    // the conversation ended, and a fork should not race its active agent.
    if (liveAgent(ctx, binding.sessionId)?.status === 'running') continue
    if (binding.inbound?.pending?.length) continue
    if (older(getLastSleepAt(binding.sessionId), binding.lastTurnAt) >= 0) continue
    if ((Date.parse(binding.sleepRetryAt || '') || 0) > now) continue
    candidates.push({ binding, activeAt })
  }
  // Newest first: a catch-up run after the app was closed should tidy what the user
  // just lived through, not a week-old chat that has already waited this long.
  candidates.sort((a, b) => b.activeAt - a.activeAt)
  const budget = Math.max(1, Math.min(10, Number(limit) || 2))
  let ran = 0
  for (const { binding } of candidates.slice(0, budget)) {
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
    // 近期刚整理过、或刚注入过记忆的会话不再 fork：长会话每次整理都会把整段
    // 转录种进子会话，连续触发等于重复付同一笔 token。
    const suppression = suppressionReason({
      now,
      lastSleepAt: getLastSleepAt(binding.sessionId),
      lastInjectedAt: binding.lastInjectedAt || null,
      consolidatedCooldownMinutes: Number(settings.activeMemoryCooldownMinutes ?? ACTIVE_MEMORY_POLICY.consolidatedCooldownMinutes),
      recallCooldownMinutes: Number(settings.activeMemoryRecallCooldownMinutes ?? ACTIVE_MEMORY_POLICY.recallCooldownMinutes),
    })
    if (suppression) {
      log(`sleep consolidation suppressed for ${binding.sessionId}: ${suppression}`)
      record({
        kind: 'check', scope: 'private', sessionId: binding.sessionId, libraryId: binding.libraryId || null, ok: true,
        message: '闲时检查抑制：' + suppression,
        detail: { trigger: 'idle', reason: suppression, lastSleepAt: getLastSleepAt(binding.sessionId), lastInjectedAt: binding.lastInjectedAt || null },
      })
      continue
    }
    try {
      const result = await requestPrivateConsolidation(ctx, binding.sessionId)
      if (result?.ok) {
        // 证据不足（low-score）不是"已整理"：不推进游标、不计数，等空闲越过饥饿阈值
        // 或后续证据变多再检查。否则这句话会被永久跳过。
        if (result.settled === false) {
          log(`sleep consolidation deferred for ${binding.sessionId}: ${result.skipped || 'not settled'}`)
          continue
        }
        // Only cover activity this pass began with, not new messages during it.
        setLastSleepAt(binding.sessionId, binding.lastTurnAt)
        setSessionBinding(binding.sessionId, { sleepRetryAt: null, sleepAttempts: 0, lastSleepError: null })
        ran += 1
      } else if (isGoneSessionError(result?.error)) {
        setSessionBinding(binding.sessionId, { sessionGone: true, sessionGoneAt: new Date(now).toISOString(), sleepRetryAt: null, sleepAttempts: 0, lastSleepError: String(result.error) })
        log(`sleep consolidation dropped ${binding.sessionId}: the conversation no longer exists`)
      } else {
        const attempts = Number(binding.sleepAttempts || 0) + 1
        setSessionBinding(binding.sessionId, { sleepAttempts: attempts, lastSleepError: result?.error || 'not settled', sleepRetryAt: new Date(now + Math.min(60, 2 ** Math.min(attempts, 6)) * 60_000).toISOString() })
        log(`sleep consolidation skipped for ${binding.sessionId}: ${result?.error || 'not queued'}`)
      }
    } catch (error) {
      if (isGoneSessionError(error?.message)) {
        setSessionBinding(binding.sessionId, { sessionGone: true, sessionGoneAt: new Date(now).toISOString(), sleepRetryAt: null, sleepAttempts: 0, lastSleepError: String(error.message) })
        continue
      }
      // A missing service or transient file failure can heal without a new turn.
      const attempts = Number(binding.sleepAttempts || 0) + 1
      setSessionBinding(binding.sessionId, { sleepAttempts: attempts, lastSleepError: String(error?.message || error), sleepRetryAt: new Date(now + Math.min(60, 2 ** Math.min(attempts, 6)) * 60_000).toISOString() })
      log(`sleep consolidation failed for ${binding.sessionId}: ${error?.message || error}`)
    }
  }
  return { ran, considered: candidates.length }
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
    .filter((b) => !b.consolidationFork && b.lastTurnAt && older(b.lastTurnAt, new Date(lastRunAt).toISOString()) > 0)
    .sort((a, b) => String(b.lastTurnAt).localeCompare(String(a.lastTurnAt)))
    .slice(0, limit)
    .map((b) => b.sessionId)
  if (due.length === 0) return { ran: 0, skipped: 'no-new-sessions' }

  const parent = due.find((id) => liveAgent(ctx, id))
    || listSessionBindings().filter((b) => !b.consolidationFork).map((b) => b.sessionId).find((id) => liveAgent(ctx, id))
  if (!parent) {
    // Deliberately not recording the attempt: the next sweep retries, and a run
    // that never started must not push the schedule forward.
    log('auto curation waiting for a live session to host the curator')
    return { ran: 0, skipped: 'no-live-parent' }
  }
  try {
    const job = await startGlobalCuration(ctx, { sessionIds: due, parentSessionId: parent, model: settings.curatorModel })
    setCycleState({ lastCurateAt: new Date(now).toISOString(), lastCurateJob: job?.id || null })
    record({ kind: 'curate', scope: 'global', ok: true, message: `自动提炼启动：${due.length} 个会话`, detail: { sessions: due.length, jobId: job?.id || null, parent } })
    return { ran: due.length, job }
  } catch (error) {
    log(`auto curation failed: ${error?.message || error}`)
    record({ kind: 'curate', scope: 'global', ok: false, level: 'error', message: '自动提炼失败：' + String(error?.message || error), detail: { sessions: due.length } })
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
  // One catch-up sweep shortly after load. The sweep timer only exists while the app
  // is open, so a conversation that ended while it was closed used to wait for the
  // next idle window — and the next message always resets that clock, which is how a
  // whole evening could pass without a single consolidation. The delay lets the host
  // finish restoring sessions and agents first; the pass itself is bounded (two
  // sessions) so a long list of stale bindings cannot turn startup into a stampede.
  const startup = setTimeout(() => { void tick() }, STARTUP_SWEEP_MS)
  startup.unref?.()
  // Property access on an uninjected service throws in cordis, so the probe itself
  // is guarded; a host without the timer service falls back instead of failing.
  let scoped = null
  try { scoped = typeof ctx.interval === 'function' ? ctx : null } catch { scoped = null }
  if (scoped) {
    // cordis' ctx.interval returns a *disposer function*, not a Node timer id —
    // clearInterval() on it is a silent no-op and the sweep would keep running
    // after plugin unload/HMR. Call the disposer.
    const dispose = scoped.interval(() => { void tick() }, SWEEP_MS)
    return () => { try { clearTimeout(startup) } catch {} try { dispose?.() } catch {} }
  }
  const timer = setInterval(() => { void tick() }, SWEEP_MS)
  timer.unref?.()
  return () => { clearTimeout(startup); clearInterval(timer) }
}
