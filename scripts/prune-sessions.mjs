#!/usr/bin/env node
// P2-5 explicit session-binding GC. Dry-run by default; --apply removes old bindings
// and their consolidation-ledger state.
//
// Two clocks, not one: lastTurnAt says when the conversation last spoke, and a live
// consolidation lease says something is writing for it right now. Pruning on
// lastTurnAt alone deleted sessions mid-job, so a session with an unexpired lease is
// skipped and reported.
import { pruneSessionBindings } from '../lib/state.js'
import { clearSessionState, sessionState } from '../lib/consolidation-ledger.js'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const daysFlag = args.indexOf('--days')
const days = daysFlag >= 0 ? Number(args[daysFlag + 1]) : 30
// 0 used to mean "every session is old enough", which made this a wipe command with a
// harmless-looking flag. Deleting a binding cannot be undone, so refuse it.
if (!Number.isFinite(days) || days <= 0) {
  console.error('prune-sessions: --days must be a positive number of days (0 is not "all")')
  process.exit(2)
}

const isBusy = (sessionId) => {
  const leaseUntil = Number(sessionState(sessionId)?.inflight?.leaseUntil) || 0
  return leaseUntil > Date.now()
}

const result = pruneSessionBindings({ olderThanDays: days, dryRun: !apply, isBusy })
if (apply) {
  for (const sessionId of result.removed || []) {
    try { clearSessionState(sessionId) } catch {}
  }
}
console.log(JSON.stringify(result, null, 2))
