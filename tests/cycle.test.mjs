import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-cycle-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const cycle = await import('../lib/cycle.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

// A ctx stand-in for a host that can read a transcript and fork it. Consolidation
// never asks `agents.get` for anything any more, so the recorder counts both sides:
// followups handed to the user's own live agent (must stay 0) and followups handed
// to a scratch fork (must be 1 per consolidated session).
function fakeCtx({ live = [], forkable = null, gone = [], transcript = null, parentOptions = { provider: 'test-provider', model: 'test-model' }, turnReason = { kind: 'completed' } } = {}) {
  const liveSet = new Set(live)
  const forkSet = new Set(forkable || live)
  const goneSet = new Set(gone)
  const created = []
  const disposed = []
  const liveFollowups = []
  const forkFollowups = []
  const seeds = []
  const sessionHandlers = []
  // A transcript that actually contains a person: the value gate reads it before a
  // fork exists, so a fixture with bare `{seq}` markers would be judged empty.
  const events = transcript || [
    { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我看一下这个插件为什么空闲整理从来没跑过，日志里只有 skip 一行' }] } },
    { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'read', arguments: '{}' }] } } },
  ]
  const ctx = {
    created, disposed, liveFollowups, forkFollowups, seeds,
    on: (name, handler) => {
      if (name !== 'session/event') return () => {}
      sessionHandlers.push(handler)
      return () => {
        const index = sessionHandlers.indexOf(handler)
        if (index >= 0) sessionHandlers.splice(index, 1)
      }
    },
    get: (name) => {
      if (name === 'agents') {
        return {
          get: (id) => (liveSet.has(id)
            ? { followup: (message) => liveFollowups.push({ id, message }), options: parentOptions }
            : undefined),
          create: async (spec) => {
            created.push(spec)
            seeds.push(spec.seed)
            const childSession = { id: spec.sessionId }
            return {
              agent: {
                session: childSession,
                followup: (message) => {
                  forkFollowups.push({ child: spec.sessionId, message })
                  const proof = { version: 1, jobId: state.getSessionBinding(spec.sessionId).jobId, snapshotHash: state.getSessionBinding(spec.sessionId).snapshotHash, status: 'completed', outcome: 'no_value', checkedRange: { fromSeq: 0, throughSeq: events.at(-1).seq }, createdIds: [], updatedIds: [], heldIds: [] }
                  const tick = String.fromCharCode(96).repeat(3)
                  for (const handler of sessionHandlers) {
                    handler(childSession, { type: 'assistant/message', seq: 99, data: { message: { content: [{ type: 'text', text: tick + 'memu-consolidation-receipt\n' + JSON.stringify(proof) + '\n' + tick }] } } })
                    handler(childSession, { type: 'turn/end', seq: 100, data: { turn: 1, reason: turnReason } })
                  }
                },
                whenIdle: async () => {},
              },
              dispose: async () => { disposed.push(spec.sessionId) },
            }
          },
        }
      }
      if (name === 'sessionQuery') {
        return {
          readSession: async (id) => {
            if (goneSet.has(id)) throw new Error(`session "${id}" not found`)
            return forkSet.has(id) ? { events, session: { cwd: path.join(home, 'p'), agentPreset: 'rp' } } : { events: [] }
          },
        }
      }
      return undefined
    },
  }
  return ctx
}

function touchAgo(sessionId, minutesAgo) {
  state.setSessionBinding(sessionId, { lastTurnAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() })
}

test('sleep pass does nothing unless it is turned on', async () => {
  // Fresh installs now default this on, so turn it off explicitly to test the
  // disabled branch without depending on the default.
  state.updateSettings({ sleepConsolidation: false })
  const binding = state.ensureSession('cycle-off', { cwd: path.join(home, 'p-off'), agentPreset: 'rp' })
  touchAgo('cycle-off', 120)
  const out = await cycle.runSleepPass(fakeCtx({ live: ['cycle-off'] }))
  assert.equal(out.skipped, 'disabled')
  assert.equal(state.getLastSleepAt('cycle-off'), null)
})

test('an idle live session is consolidated in a fork, never in its own chat', async () => {
  state.updateSettings({ sleepConsolidation: true, sleepAfterIdleMinutes: 10 })
  const binding = state.ensureSession('cycle-idle', { cwd: path.join(home, 'p-idle'), agentPreset: 'rp' })
  touchAgo('cycle-idle', 30)

  const ctx = fakeCtx({ live: ['cycle-idle'] })
  const first = await cycle.runSleepPass(ctx)
  assert.equal(first.ran, 1)
  assert.ok(state.getLastSleepAt('cycle-idle'))

  // The reason this whole path exists: a consolidation prompt queued on the chat
  // the user is looking at shows up as a pending draft above the composer and then
  // lives in that transcript forever. The live agent must never be handed one.
  assert.equal(ctx.liveFollowups.length, 0, 'the live session must not get a queued draft')
  assert.equal(ctx.created.length, 1, 'exactly one scratch fork')
  assert.equal(ctx.forkFollowups.length, 1, 'the fork is what carries the work')
  assert.equal(ctx.disposed.length, 1, 'the fork is thrown away afterwards')
  const child = ctx.created[0].sessionId
  assert.match(child, /^memu-consolidate-/)
  assert.equal(ctx.created[0].meta.origin, 'subagent', 'a subagent fork stays out of the window list and the injection path')
  assert.equal(ctx.created[0].meta.parentSession, 'cycle-idle')
  assert.equal(ctx.seeds[0].lastSeq, 1, 'the seed is the parent transcript')
  assert.equal(state.getSessionBinding(child), null, 'worker binding is removed after disposal')

  const second = await cycle.runSleepPass(fakeCtx({ live: ['cycle-idle'] }))
  assert.equal(second.ran, 0)
  assert.equal(second.skipped, undefined)
})

test('a session that was not idle long enough is left alone', async () => {
  state.updateSettings({ sleepConsolidation: true, sleepAfterIdleMinutes: 30 })
  state.ensureSession('cycle-recent', { cwd: path.join(home, 'p-recent'), agentPreset: 'rp' })
  touchAgo('cycle-recent', 2)
  const out = await cycle.runSleepPass(fakeCtx({ live: ['cycle-recent'] }))
  assert.equal(out.ran, 0)
  assert.equal(state.getLastSleepAt('cycle-recent'), null)
})

test('an unreadable transcript backs off without claiming a completed sleep', async () => {
  state.updateSettings({ sleepConsolidation: true, sleepAfterIdleMinutes: 5 })
  state.ensureSession('cycle-dead', { cwd: path.join(home, 'p-dead'), agentPreset: 'rp' })
  touchAgo('cycle-dead', 60)
  const logs = []
  await cycle.runSleepPass({ get: () => undefined }, { log: (m) => logs.push(m) })
  assert.equal(state.getLastSleepAt('cycle-dead'), null)
  const failed = state.getSessionBinding('cycle-dead')
  assert.ok(Date.parse(failed.sleepRetryAt) > Date.now())
  assert.equal(failed.sleepAttempts, 1)
  await cycle.runSleepPass({ get: () => undefined })
  assert.equal(state.getSessionBinding('cycle-dead').sleepAttempts, 1, 'backoff suppresses immediate retries')
  assert.ok(logs.some((m) => /consolidation skipped for cycle-dead/.test(m)), 'skip logged: ' + logs.join(' | '))
  state.setSessionBinding('cycle-dead', { sleepRetryAt: new Date(0).toISOString() })
  await cycle.runSleepPass(fakeCtx({ live: ['cycle-dead'] }))
  assert.ok(state.getLastSleepAt('cycle-dead'), 'a recovered host retries without another user turn')
  assert.equal(state.getSessionBinding('cycle-dead').lastSleepError, null)
})

test('a fork that cannot be created is logged, not dropped silently', async () => {
  state.updateSettings({ sleepConsolidation: true, sleepAfterIdleMinutes: 5 })
  state.ensureSession('cycle-hist', { cwd: path.join(home, 'p-hist'), agentPreset: 'rp' })
  touchAgo('cycle-hist', 60)
  const logs = []
  const ctx = {
    get: (name) => {
      if (name === 'sessionQuery') return { readSession: async () => ({ events: [
        { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这个 fork 一直建不起来，帮我看下为什么，日志里只有 skipped 一行' }] } },
      ], session: {} }) }
      if (name === 'agents') return {
        get: () => ({ options: { provider: 'test-provider', model: 'test-model' } }),
        create: async () => { throw new Error('no fork in test env') },
      }
      return undefined
    },
  }
  await cycle.runSleepPass(ctx, { log: (m) => logs.push(m) })
  assert.ok(logs.some((m) => /consolidation skipped for cycle-hist: no fork in test env/.test(m)), 'attempt logged: ' + logs.join(' | '))
  assert.equal(state.getLastSleepAt('cycle-hist'), null)
  assert.match(state.getSessionBinding('cycle-hist').lastSleepError, /no fork/)
})

test('a fork whose turn errors is backed off, not marked asleep', async () => {
  state.updateSettings({ sleepConsolidation: true, sleepAfterIdleMinutes: 5 })
  state.ensureSession('cycle-fork-error', { cwd: path.join(home, 'p-fork-error'), agentPreset: 'rp' })
  touchAgo('cycle-fork-error', 60)
  const out = await cycle.runSleepPass(fakeCtx({
    live: ['cycle-fork-error'],
    turnReason: { kind: 'error', error: { message: 'prompt variable "{{model}}" has no value' } },
  }))
  assert.equal(out.ran, 0)
  assert.equal(state.getLastSleepAt('cycle-fork-error'), null, 'a failed turn is still unslept')
  const failed = state.getSessionBinding('cycle-fork-error')
  assert.equal(failed.sleepAttempts, 1)
  assert.match(failed.lastSleepError, /fork turn ended error/)
  assert.ok(Date.parse(failed.sleepRetryAt) > Date.now(), 'the scheduler backs off instead of losing the work')
})

test('a turn newer than the last sleep makes the session eligible again', async () => {
  state.updateSettings({ sleepConsolidation: true, sleepAfterIdleMinutes: 5 })
  state.ensureSession('cycle-again', { cwd: path.join(home, 'p-again'), agentPreset: 'rp' })
  // Slept 40 minutes ago, then the conversation continued 15 minutes ago: the
  // earlier sleep is stale and a new one is due.
  state.setLastSleepAt('cycle-again', new Date(Date.now() - 40 * 60_000).toISOString())
  touchAgo('cycle-again', 15)

  const out = await cycle.runSleepPass(fakeCtx({ live: ['cycle-again'] }))
  assert.equal(out.ran, 1)
  assert.ok(Date.parse(state.getLastSleepAt('cycle-again')) > Date.parse(new Date(Date.now() - 15 * 60_000).toISOString()) - 60_000)
})

test('a conversation the host says is gone is marked once and never retried', async () => {
  state.updateSettings({ sleepConsolidation: true, sleepAfterIdleMinutes: 5 })
  state.ensureSession('cycle-ghost', { cwd: path.join(home, 'p-ghost'), agentPreset: 'rp' })
  touchAgo('cycle-ghost', 120)
  const logs = []
  const out = await cycle.runSleepPass(fakeCtx({ live: ['cycle-ghost'], gone: ['cycle-ghost'] }), { log: (m) => logs.push(m) })
  assert.equal(out.ran, 0)
  const binding = state.getSessionBinding('cycle-ghost')
  assert.equal(binding.sessionGone, true, 'the mark is what stops the hourly retry')
  assert.equal(binding.sleepAttempts, 0, 'a deleted session is not a transient failure')
  assert.equal(binding.sleepRetryAt, null, 'nothing to retry later')
  assert.ok(logs.some((m) => /no longer exists/.test(m)), 'explained once: ' + logs.join(' | '))
  const quiet = await cycle.runSleepPass(fakeCtx({ live: ['cycle-ghost'] }))
  assert.equal(quiet.considered, 0, 'the next sweep does not even read the transcript')
})

test('a policy greeting skip does not claim a completed worker check', async () => {
  state.updateSettings({ sleepConsolidation: true, sleepAfterIdleMinutes: 5 })
  state.ensureSession('cycle-smalltalk', { cwd: path.join(home, 'p-small'), agentPreset: 'rp' })
  touchAgo('cycle-smalltalk', 20)
  const ctx = fakeCtx({ live: ['cycle-smalltalk'], transcript: [
    { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '谢谢' }] } },
    { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '不客气' }] } } },
  ] })
  const out = await cycle.runSleepPass(ctx)
  assert.equal(out.ran, 0, 'a policy skip is not a verified worker receipt')
  assert.equal(ctx.created.length, 0, 'no fork for small talk')
  assert.equal(state.getLastSleepAt('cycle-smalltalk'), null)
})

test('auto curation stays off unless an interval is set', async () => {
  const out = await cycle.runCurationPass(fakeCtx({ live: ['cycle-idle'] }))
  assert.equal(out.skipped, 'disabled')
})

test('auto curation waits for a live parent and does not advance the schedule', async () => {
  state.updateSettings({ autoCurateEveryHours: 1, autoCurateSessionLimit: 5 })
  state.setCycleState({ lastCurateAt: null })
  state.ensureSession('cycle-curate', { cwd: path.join(home, 'p-curate'), agentPreset: 'rp' })
  touchAgo('cycle-curate', 5)

  const out = await cycle.runCurationPass(fakeCtx({ live: [] }))
  assert.equal(out.skipped, 'no-live-parent')
  assert.equal(out.ran, 0)
  assert.ok(!state.getCycleState().lastCurateAt, 'a run that never started must not reschedule')
})

function registryCtx(paths) {
  return {
    get: (name) => (name === 'workspaceRegistry' ? { list: () => paths.map((p) => ({ path: p })) } : undefined),
  }
}

test('a library is archived only when its workspace leaves the DSH registry', () => {
  const lib = state.createLibrary({ name: 'cycle-ws', cwd: '/work/cycle-ws' })
  assert.ok(state.listLibraries().some((l) => l.id === lib.id), 'starts active')

  // Registered: this library must not be touched (other leftovers from earlier
  // tests may legitimately archive in the same sweep, so assert only about ours).
  const stillThere = cycle.runLibraryHousekeeping(registryCtx(['/work/cycle-ws', '/work/other']))
  assert.ok(!stillThere.archived.includes(lib.id))

  // Unregistered (but still on disk): archived.
  const removed = cycle.runLibraryHousekeeping(registryCtx(['/work/other']))
  assert.ok(removed.archived.includes(lib.id), 'library should archive when its workspace is unregistered')
  assert.ok(state.listArchivedLibraries().map((l) => l.id).includes(lib.id))
  assert.ok(state.listLibraries().every((l) => l.id !== lib.id), 'archived libraries leave the active list')
})

test('an absent or empty registry archives nothing (fail-open)', () => {
  const lib = state.createLibrary({ name: 'cycle-safe', cwd: '/work/cycle-safe' })
  // No workspaceRegistry service at all.
  const noService = cycle.runLibraryHousekeeping({ get: () => undefined })
  assert.deepEqual(noService.archived, [])
  assert.deepEqual(noService.revived, [])
  // Registry present but empty — a fresh install must not wipe the library list.
  const empty = cycle.runLibraryHousekeeping(registryCtx([]))
  assert.deepEqual(empty.archived, [])
  assert.ok(state.getLibrary(lib.id))
})

test('a workspace coming back revives its library', () => {
  const lib = state.createLibrary({ name: 'cycle-revive', cwd: '/work/cycle-revive' })
  cycle.runLibraryHousekeeping(registryCtx(['/work/other']))
  assert.ok(state.listArchivedLibraries().some((l) => l.id === lib.id), 'should have been archived')
  const back = cycle.runLibraryHousekeeping(registryCtx(['/work/cycle-revive']))
  assert.ok(back.revived.includes(lib.id))
  assert.ok(state.listLibraries().some((l) => l.id === lib.id), 'should be active again')
})

test('archived libraries are kept forever unless an age is set', () => {
  const lib = state.createLibrary({ name: 'cycle-keep', cwd: '/work/cycle-keep' })
  state.archiveLibrary(lib.id)
  state.updateSettings({ purgeArchivedAfterDays: 0 })
  const manual = cycle.runLibraryHousekeeping(registryCtx(['/work/somewhere-else']))
  assert.deepEqual(manual.purged, [])
  assert.ok(state.getLibrary(lib.id), 'manual mode must not delete')

  // Now make it old and turn on purging.
  const st = state.loadState()
  st.libraries[lib.id].archivedAt = new Date(Date.now() - 40 * 86_400_000).toISOString()
  state.saveState(st)
  state.updateSettings({ purgeArchivedAfterDays: 30 })
  const purged = cycle.runLibraryHousekeeping(registryCtx(['/work/somewhere-else']))
  assert.deepEqual(purged.purged, [])
  assert.ok(purged.purgeCandidates.includes(lib.id))
  assert.ok(state.getLibrary(lib.id), 'age produces a review candidate, never an automatic library deletion')
})

test('deleting an un-archived library is refused', () => {
  const lib = state.createLibrary({ name: 'cycle-nodelete', cwd: '/work/cycle-nodelete' })
  const result = state.deleteLibrary(lib.id)
  assert.equal(result.ok, false)
  assert.match(result.error, /archive the library before deleting/)
  assert.ok(state.getLibrary(lib.id))
})

test('auto curation is not due yet', async () => {
  state.updateSettings({ autoCurateEveryHours: 6 })
  state.setCycleState({ lastCurateAt: new Date().toISOString() })
  const out = await cycle.runCurationPass(fakeCtx({ live: ['cycle-curate'] }))
  assert.equal(out.skipped, 'not-due')
})
test('a thin turn shortly after a consolidation waits for real evidence', async () => {
  state.updateSettings({ sleepConsolidation: true, sleepAfterIdleMinutes: 3 })
  state.ensureSession('cycle-cooldown', { cwd: path.join(home, 'p-cooldown'), agentPreset: 'rp' })
  // 刚整理过（20 分钟前），5 分钟前只补了一句很短的话：再 fork 一次要把整段转录
  // 重新种进去，纯粹浪费 token。评分门槛会把它压到饥饿阈值之后。
  state.setSessionBinding('cycle-cooldown', { lastTurnAt: new Date(Date.now() - 5 * 60_000).toISOString() })
  state.setLastSleepAt('cycle-cooldown', new Date(Date.now() - 20 * 60_000).toISOString())
  const ctx = fakeCtx({ live: ['cycle-cooldown'] })
  const out = await cycle.runSleepPass(ctx)
  assert.equal(out.ran, 0)
  assert.equal(ctx.created.length, 0, 'a thin follow-up must not buy another full-transcript fork')
  // 收尾：把它标记为已睡，避免候选泄漏到后续用例。
  state.setLastSleepAt('cycle-cooldown', new Date().toISOString())
})

test('a session that just injected memory is left alone by the idle sweep', async () => {
  state.updateSettings({ sleepConsolidation: true, sleepAfterIdleMinutes: 3 })
  state.ensureSession('cycle-recall', { cwd: path.join(home, 'p-recall'), agentPreset: 'rp' })
  state.setSessionBinding('cycle-recall', {
    // 空闲已过饥饿阈值，按评分本会 fork；但 5 分钟前刚注入了记忆，抑制优先。
    lastTurnAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    lastInjectedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  })
  const ctx = fakeCtx({ live: ['cycle-recall'] })
  const out = await cycle.runSleepPass(ctx)
  assert.equal(out.ran, 0)
  assert.equal(ctx.created.length, 0, 'a session with fresh memory context does not need a fork')
  state.setLastSleepAt('cycle-recall', new Date().toISOString())
})

// H5: a missing file is not the host saying the conversation was deleted.
// captureSessionSnapshot marks a failed read retryable on purpose ("读失败，可重试"),
// but the bare word ENOENT in isGoneSessionError used to turn that into sessionGone —
// and the sweep skips a marked session until some later human message clears it.
test('a transcript that cannot be read is retried, not marked as a deleted conversation', async () => {
  state.updateSettings({ sleepConsolidation: true, sleepAfterIdleMinutes: 5 })
  state.ensureSession('cycle-enoent', { cwd: path.join(home, 'p-enoent'), agentPreset: 'rp' })
  // 6 minutes: still idle under the 5-minute threshold, but the sweep takes the two
  // newest candidates and this file shares one state directory across its tests.
  touchAgo('cycle-enoent', 6)
  const logs = []
  const ctx = {
    get: (name) => {
      if (name === 'sessionQuery') {
        return {
          readSession: async () => {
            const error = new Error("ENOENT: no such file or directory, open 'D:/home/sessions/cycle-enoent/log.jsonl'")
            error.code = 'ENOENT'
            throw error
          },
        }
      }
      if (name === 'agents') {
        return { get: () => ({}), create: async () => { throw new Error('a session that cannot be read must not be forked') } }
      }
      return undefined
    },
  }
  await cycle.runSleepPass(ctx, { log: (message) => logs.push(message), limit: 10 })
  const binding = state.getSessionBinding('cycle-enoent')
  assert.ok(!binding.sessionGone, 'a transient read failure is not the host reporting a deletion')
  assert.equal(binding.sleepAttempts, 1, 'it backs off like any other failure')
  assert.ok(Date.parse(binding.sleepRetryAt) > Date.now(), 'it is retried later')
  assert.match(binding.lastSleepError, /ENOENT/)
  assert.ok(logs.some((message) => /consolidation skipped for cycle-enoent/.test(message)), 'stated once: ' + logs.join(' | '))
  assert.equal(state.getLastSleepAt('cycle-enoent'), null, 'nothing was consolidated, so nothing is marked asleep')
})

test('only the host saying the conversation is gone counts as deleted', () => {
  assert.equal(cycle.isGoneSessionError('session "abc" not found'), true)
  assert.equal(cycle.isGoneSessionError('no such session: abc'), true)
  assert.equal(cycle.isGoneSessionError('this session does not exist any more'), true)
  assert.equal(cycle.isGoneSessionError("ENOENT: no such file or directory, open 'D:/x/log.jsonl'"), false)
  assert.equal(cycle.isGoneSessionError('EACCES: permission denied, open D:/x'), false)
})