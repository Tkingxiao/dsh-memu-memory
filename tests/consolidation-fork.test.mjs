import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-fork-'))
process.env.DSH_HOME = home
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const state = await import('../lib/state.js')
const activity = await import('../lib/activity-log.js')
const ledger = await import('../lib/consolidation-ledger.js')
const forkModel = await import('../lib/fork-model.js')
const { dataDir, setWarnSink } = await import('../lib/paths.js')
const { retireWorker } = await import('../lib/worker-pool.js')
const { CORE_WRITE_TOOLS, WORKER_TOOL_ALLOW } = await import('../lib/consolidation-worker.js')
const { requestPrivateConsolidation, isConsolidating, consolidationWaitBudget, CONSOLIDATION_WAIT_POLICY, CONSOLIDATION_WINDOW_EVENTS, isEffortRefused, markEffortRefused, effortRefusalOf, compactSeedEvents, selectConsolidationWindow, selectTailTurnWindow, mustCoverCandidates, mergeMustCover, candidateCovered, seedLimitsFor } = await import('../lib/private.js')
// 这些用例验证“路由继承”，不是推理强度；默认 medium 由 config 测试单独覆盖。
state.updateSettings({ consolidationReasoningEffort: 'inherit' })

test.after(() => {
  forkModel.disposeConsolidationRoute()
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

// The manual path (the sidebar button, RPC generatePrivate) shares one entry point
// with the idle sweep. Both now fork; neither may queue anything on the live agent,
// because a queued followup is what the host renders as a pending draft above the
// user's composer and what ends up as a permanent housekeeping turn in their chat.
// The host contract this plugin must satisfy, mirrored from the runtime:
// packages/core/session SessionStore.prepare() rebuilds a session header from a
// fixed meta whitelist and `Session` then throws "seeded session requires an
// inherited event count" when the count was not passed as a TOP-LEVEL option.
// The host drops an unknown meta key silently; this fake refuses it loudly, so a
// plugin that misplaces the field fails the test instead of dying in production.
const META_KEYS = ['cwd', 'parentSession', 'isSeeded', 'origin', 'delegationDepth', 'agentPreset']

function assertHostCreateAccepts(spec = {}) {
  const meta = spec.meta ?? {}
  const count = spec.inheritedEventCount
  for (const key of Object.keys(meta)) {
    if (!META_KEYS.includes(key)) {
      throw new Error(`session meta "${key}" is not a header field: SessionStore.prepare() drops it`)
    }
  }
  if (meta.isSeeded === true) {
    if (spec.seed === undefined) throw new Error('seeded session requires an explicit constructor seed')
    if (count === undefined) throw new Error('seeded session requires an inherited event count')
  } else if (count !== undefined && count !== 0) {
    throw new Error('unseeded session inherited event count must be 0')
  }
  // buildForkSeed() returns a seed object, not a bare array, so the length guard
  // only applies to an array seed.
  if (Array.isArray(spec.seed) && count !== undefined && count > spec.seed.length) {
    throw new Error('session inherited event count exceeds its event log')
  }
  if (spec.agentOptions !== undefined) {
    if (!spec.agentOptions || typeof spec.agentOptions.provider !== 'string' || typeof spec.agentOptions.model !== 'string') {
      throw new Error('agentOptions must carry the parent provider and model')
    }
  }
}

function host({ live = false, whenIdle = null, parentOptions = { provider: 'test-provider', model: 'test-model' }, requestConfig = null, extraEvents = [], transcriptSize = 0, turnReason = { kind: 'completed' }, emitTurnEnd = true, headerTools = null, childCtxFactory = null, llm = null, cwd = path.join(home, 'proj') } = {}) {
  const rec = { liveFollowups: [], created: [], forkFollowups: [], disposed: [], sessionHandlers: [], workerToolRegistrations: [], workerToolDisposals: [] }
  // agents.get 返回裸 agent；dispose 注销活句柄，但会话 id 仍在磁盘上占用。
  const childAgents = new Map()
  const tick = String.fromCharCode(96)
  const receiptFence = (range, identity) => [tick + tick + tick + 'memu-consolidation-receipt', JSON.stringify({ version: 1, ...identity, status: 'completed', outcome: 'no_value', checkedRange: range, createdIds: [], updatedIds: [], heldIds: [], reasonCode: null, retryable: false }), tick + tick + tick].join('\n')
  // 真实长会话的规模：补齐不产生证据的事件，只影响 fork 成本判定。
  const padding = Math.max(0, transcriptSize - 3 - extraEvents.length)
  const filler = Array.from({ length: padding }, (_, i) => ({ seq: 3 + extraEvents.length + i, type: 'todo/write', data: {} }))
  const ctx = {
    rec,
    on: (name, handler) => {
      if (name !== 'session/event') return () => {}
      rec.sessionHandlers.push(handler)
      return () => {
        const index = rec.sessionHandlers.indexOf(handler)
        if (index >= 0) rec.sessionHandlers.splice(index, 1)
      }
    },
    get: (name) => {
      if (name === 'agents') {
        return {
          get: (id) => {
            if (childAgents.has(id)) return childAgents.get(id)
            return (live
              ? {
                  followup: (message) => rec.liveFollowups.push({ id, message }),
                  ...(parentOptions ? { options: parentOptions } : {}),
                  ...(requestConfig || headerTools ? { session: { requestHeader: () => ({
                    ...(requestConfig ? { config: requestConfig } : {}),
                    ...(headerTools ? { tools: headerTools.map((toolName) => ({ name: toolName })) } : {}),
                  }) } } : {}),
                }
              : undefined)
          },
          create: async (spec) => {
            assertHostCreateAccepts(spec)
            if (childAgents.has(spec.sessionId)) throw new Error('session already exists: ' + spec.sessionId)
            rec.created.push(spec)
            const childSession = { id: spec.sessionId }
            const dispose = async () => {
              rec.disposed.push(spec.sessionId)
              childAgents.set(spec.sessionId, null)
            }
            const handle = {
              agent: {
                session: childSession,
                ctx: childCtxFactory?.(),
                dispose,
                followup: (message) => {
                  rec.forkFollowups.push({ child: spec.sessionId, message })
                  if (emitTurnEnd) {
                    const reason = typeof turnReason === 'function' ? turnReason(spec) : turnReason
                    if (reason?.kind === 'completed') {
                      // The worker receipt must match the window the fork was seeded
                      // with, not the whole parent transcript.
                      const child = state.getSessionBinding(spec.sessionId)
                      const fromSeq = Number.isSafeInteger(child?.snapshotFromSeq) ? child.snapshotFromSeq : 0
                      const throughSeq = Number.isSafeInteger(child?.snapshotThroughSeq)
                        ? child.snapshotThroughSeq
                        : 2 + extraEvents.length + padding
                      for (const handler of rec.sessionHandlers) {
                        handler(childSession, { type: 'assistant/message', seq: 99, data: { message: { content: [{ type: 'text', text: receiptFence({ fromSeq, throughSeq }, child) }] } } })
                      }
                    }
                    for (const handler of rec.sessionHandlers) {
                      handler(childSession, { type: 'turn/end', seq: 100, data: { turn: 1, reason } })
                    }
                  }
                },
                whenIdle: whenIdle || (async () => {}),
              },
              dispose,
            }
            childAgents.set(spec.sessionId, handle.agent)
            return handle
          },
        }
      }
      // 整理 fork 的模型选择（lib/fork-model.js）按需探测的宿主 llm service；
      // 缺省没有 = custom 模式必须降级回 inherit 的宿主形态。
      if (name === 'llm') return llm
      if (name === 'sessionQuery') {
        return {
          readSession: async () => ({
            events: [
              { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这个 fork 为什么一直建不起来，帮我看下' }] } },
              { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'read', arguments: '{}' }] } } },
              { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '看到了' }] } } },
              ...extraEvents,
              ...filler,
            ],
            session: { cwd, agentPreset: 'coding' },
          }),
        }
      }
      return undefined
    },
  }
  return ctx
}

test('enabling local or remote vectors does not opt into remote summary', async () => {
  const originalFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = async () => { fetches += 1; throw new Error('summary API must not be called') }
  try {
    for (const vectorSource of ['local', 'api']) {
      state.updateSettings({ memoryBackend: 'api', vectorSource })
      const id = 'fork-vector-' + vectorSource
      state.ensureSession(id, { cwd: path.join(home, id), agentPreset: 'coding' })
      const ctx = host({ live: true })
      const result = await requestPrivateConsolidation(ctx, id)
      assert.equal(result.ok, true)
      assert.equal(ctx.rec.created.length, 1, 'vector enable still delegates extraction to the conversation Agent')
      assert.equal(ctx.rec.forkFollowups.length, 1)
    }
    assert.equal(fetches, 0)
  } finally {
    globalThis.fetch = originalFetch
    state.updateSettings({ memoryBackend: 'agent', vectorSource: 'local' })
  }
})

test('a live session is consolidated in a fork, not by queueing on itself', async () => {
  const binding = state.ensureSession('fork-live', { cwd: path.join(home, 'proj'), agentPreset: 'coding' })
  const parentOptions = { provider: 'test-provider', model: 'test-model', reasoningEffort: 'max', maxTokens: 262144 }
  const ctx = host({ live: true, parentOptions })
  const result = await requestPrivateConsolidation(ctx, 'fork-live')
  assert.equal(result.ok, true)
  assert.equal(result.settled, true)
  assert.equal(ctx.rec.liveFollowups.length, 0, 'no queued draft on the live agent')
  assert.equal(ctx.rec.created.length, 1, 'exactly one scratch fork')
  assert.equal(ctx.rec.forkFollowups.length, 1, 'the fork does the work')
  assert.equal(ctx.rec.disposed.length, 1, 'the fork is disposed')
  const spec = ctx.rec.created[0]
  assert.equal(spec.meta.parentSession, 'fork-live')
  assert.equal(spec.meta.origin, 'subagent')
  assert.equal(spec.meta.isSeeded, true)
  assert.equal(spec.inheritedEventCount, 3, 'inherits the whole transcript as a top-level option')
  assert.equal(Object.hasOwn(spec.meta, 'inheritedEventCount'), false, 'must not hide in the session meta: prepare() drops it')
  assert.deepEqual(spec.agentOptions, parentOptions, 'the fork starts on the parent model route')
  const child = state.getSessionBinding(spec.sessionId)
  assert.equal(child, null, 'disposed worker binding is removed')
  assert.equal(state.getSessionBinding('fork-live').lastSleepSeq, 2, 'only a completed turn advances the sleep cursor')
  assert.equal(result.scanned, 3, 'report how much of the transcript was scanned')
  assert.equal(result.fresh, 3, 'report how many events were new since the last consolidation')
  assert.equal(result.wrote, 0, 'the fake fork writes nothing, but the metric must still be measured')
  const text = ctx.rec.forkFollowups[0].message.content[0].text
  const { estTokens } = await import('../lib/budget.js')
  assert.equal(result.measurement.runner, 'fork')
  assert.equal(result.measurement.packet.inputChars, text.length)
  assert.equal(result.measurement.packet.estimatedTokens, estTokens(text))
  assert.equal(result.measurement.usage.inputTokens, null)
})

for (const restriction of ['succeeds', 'missing', 'throws twice']) {
  test(`a fork keeps host permissions and dispatches when tools.restrict ${restriction}`, async (t) => {
    const id = 'fork-permissions-' + restriction.replaceAll(' ', '-')
    state.ensureSession(id, { cwd: home, agentPreset: 'coding' })
    const setPermission = t.mock.fn()
    const disposeRestriction = t.mock.fn()
    const followupsAtRestriction = []
    const restrict = t.mock.fn(() => {
      followupsAtRestriction.push(ctx.rec.forkFollowups.length)
      if (restriction === 'throws twice') throw new Error('host refused tool restriction')
      return disposeRestriction
    })
    const ctx = host({
      live: true,
      headerTools: [...CORE_WRITE_TOOLS, 'read', 'shell'],
      childCtxFactory: () => ({ tools: restriction === 'missing' ? {} : { restrict } }),
    })
    ctx.permissionPresets = { set: setPermission }

    const result = await requestPrivateConsolidation(ctx, id)
    assert.equal(setPermission.mock.callCount(), 0, 'the plugin must not change the host permission preset')
    assert.equal(result.ok, true, String(result.error || ''))
    assert.equal(result.settled, true, 'missing or failing restrict keeps the existing capability fallback')
    assert.equal(ctx.rec.created.length, 1)
    assert.equal(ctx.rec.forkFollowups.length, 1, 'the fork still receives the consolidation task')
    assert.equal(ctx.rec.liveFollowups.length, 0, 'the parent never receives the task')
    assert.equal(ctx.rec.disposed.length, 1, 'the scratch fork is still disposed')
    const expectedAllows = restriction === 'missing' ? []
      : restriction === 'throws twice' ? [WORKER_TOOL_ALLOW, CORE_WRITE_TOOLS] : [WORKER_TOOL_ALLOW]
    assert.deepEqual(restrict.mock.calls.map((call) => call.arguments), expectedAllows.map((allow) => [{ allow }]),
      'restriction still tries the full allowlist and falls back to the write core on failure')
    assert.deepEqual(followupsAtRestriction, expectedAllows.map(() => 0), 'all restriction attempts precede dispatch')
    assert.equal(disposeRestriction.mock.callCount(), restriction === 'succeeds' ? 1 : 0)
  })
}

test('a fork preserves an existing parent cwd', async () => {
  const cwd = fs.mkdtempSync(path.join(home, 'existing-cwd-'))
  state.ensureSession('fork-cwd-existing', { cwd, agentPreset: 'coding' })
  const ctx = host({ live: true, cwd })
  const result = await requestPrivateConsolidation(ctx, 'fork-cwd-existing')
  assert.equal(result.ok, true, String(result.error || ''))
  assert.equal(ctx.rec.created.length, 1)
  assert.notEqual(cwd, dataDir(), 'the existing cwd differs from the fallback')
  assert.equal(ctx.rec.created[0].meta.cwd, cwd)
  assert.equal(ctx.rec.forkFollowups.length, 1)
})

test('a fork falls back to the real dataDir when the parent cwd no longer exists', async () => {
  const cwd = path.join(home, 'missing-cwd')
  assert.equal(fs.existsSync(cwd), false)
  state.ensureSession('fork-cwd-missing', { cwd, agentPreset: 'coding' })
  const ctx = host({ live: true, cwd })
  const result = await requestPrivateConsolidation(ctx, 'fork-cwd-missing')
  assert.equal(result.ok, true, String(result.error || ''))
  assert.equal(ctx.rec.created.length, 1)
  assert.equal(ctx.rec.created[0].meta.cwd, dataDir())
  assert.equal(fs.statSync(ctx.rec.created[0].meta.cwd).isDirectory(), true, 'the fallback is a real directory')
  assert.equal(ctx.rec.forkFollowups.length, 1)
})

test('a live session inherits the route of its latest turn, not stale creation options', async () => {
  state.ensureSession('fork-route', { cwd: path.join(home, 'proj-route'), agentPreset: 'coding' })
  const ctx = host({
    live: true,
    parentOptions: { provider: 'creation', model: 'old-model' },
    requestConfig: { provider: 'request', model: 'new-model', reasoningEffort: 'high', maxTokens: 32768 },
  })
  const result = await requestPrivateConsolidation(ctx, 'fork-route')
  assert.equal(result.ok, true)
  assert.deepEqual(ctx.rec.created[0].agentOptions, {
    provider: 'request',
    model: 'new-model',
    reasoningEffort: 'high',
    maxTokens: 32768,
  }, 'requestHeader() is the route that served the parent, options can be stale')
})

test('a closed session inherits the last request/header event', async () => {
  state.ensureSession('fork-closed', { cwd: path.join(home, 'proj-closed'), agentPreset: 'coding' })
  const ctx = host({
    live: false,
    extraEvents: [
      { seq: 3, type: 'request/header', data: { header: { config: { provider: 'old', model: 'old-model' } } } },
      { seq: 4, type: 'request/header', data: { header: { config: { provider: 'latest', model: 'latest-model', reasoningEffort: 'low', maxTokens: 4096 } } } },
    ],
  })
  const result = await requestPrivateConsolidation(ctx, 'fork-closed')
  assert.equal(result.ok, true)
  const spec = ctx.rec.created[0]
  assert.equal(spec.inheritedEventCount, 3, 'only conversation events are seeded; request/header is noise')
  assert.deepEqual(spec.agentOptions, { provider: 'latest', model: 'latest-model', reasoningEffort: 'low', maxTokens: 4096 })
})

test('a session with no model source is refused before a doomed fork', async () => {
  state.ensureSession('fork-no-model', { cwd: path.join(home, 'proj-no-model'), agentPreset: 'coding' })
  const ctx = host({ live: true, parentOptions: null })
  const result = await requestPrivateConsolidation(ctx, 'fork-no-model')
  assert.equal(result.ok, false)
  assert.match(result.error, /model\/provider/)
  assert.equal(ctx.rec.created.length, 0, 'never create a fork that cannot resolve {{model}}')
})

test('a failed fork turn is reported as failure and does not advance the sleep cursor', async () => {
  state.ensureSession('fork-turn-error', { cwd: path.join(home, 'proj-turn-error'), agentPreset: 'coding' })
  const ctx = host({
    live: true,
    turnReason: { kind: 'error', error: { message: 'prompt variable "{{model}}" has no value for this assembly', code: 'UNKNOWN' } },
  })
  const result = await requestPrivateConsolidation(ctx, 'fork-turn-error')
  assert.equal(result.ok, false)
  assert.equal(result.settled, false)
  assert.match(result.error, /fork turn ended error/)
  assert.match(result.error, /prompt variable/)
  assert.equal(state.getSessionBinding('fork-turn-error').lastSleepSeq, undefined, 'a failed turn must be retried, not marked asleep')
  assert.equal(ctx.rec.disposed.length, 1, 'the failed fork is still disposed')
  assert.equal(ctx.rec.sessionHandlers.length, 0, 'the failed fork listener is removed')
  const { sessionState } = await import('../lib/consolidation-ledger.js')
  const ledger = sessionState('fork-turn-error')
  assert.equal(ledger.checked, null)
  assert.equal(ledger.pending.fromSeq, 0)
  assert.equal(ledger.pending.throughSeq, 2)
  assert.ok(result.measurement.packet.inputChars > 0, 'failed dispatches still carry cost measurement')
})

test('a fork that never reports turn/end is a failure, not a success', async () => {
  state.ensureSession('fork-no-turn-end', { cwd: path.join(home, 'proj-no-turn-end'), agentPreset: 'coding' })
  const ctx = host({ live: true, emitTurnEnd: false })
  const result = await requestPrivateConsolidation(ctx, 'fork-no-turn-end')
  assert.equal(result.ok, false)
  assert.equal(result.settled, false)
  assert.match(result.error, /no turn\/end/)
  assert.equal(state.getSessionBinding('fork-no-turn-end').lastSleepSeq, undefined, 'without a turn/end event the cursor must not advance')
  assert.equal(ctx.rec.disposed.length, 1, 'the unmatched fork is still disposed')
  assert.equal(ctx.rec.sessionHandlers.length, 0, 'the listener is removed even when no turn/end arrives')
})

test('a fork still running at the deadline reports a timeout instead of silence', async () => {
  state.ensureSession('fork-timeout', { cwd: path.join(home, 'proj-timeout'), agentPreset: 'coding' })
  const ctx = host({ live: true, whenIdle: () => new Promise(() => {}) })
  const result = await requestPrivateConsolidation(ctx, 'fork-timeout', { maxWaitMs: 30 })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.equal(result.settled, false)
  // The settings button renders result.error and nothing else; an empty string
  // there is why two clicks in a row looked like the button did nothing.
  assert.match(result.error, /timed out after \d+s/)
  assert.equal(state.getSessionBinding('fork-timeout').lastSleepSeq, undefined, 'a timeout must not advance the sleep cursor')
  assert.equal(ctx.rec.disposed.length, 1, 'the timed-out fork is stopped')
  assert.equal(ctx.rec.sessionHandlers.length, 0, 'the listener is removed on timeout')
})

test('a session already being consolidated is not forked twice', async () => {
  state.ensureSession('fork-busy', { cwd: path.join(home, 'proj2'), agentPreset: 'coding' })
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  const ctx = host({ live: true, whenIdle: () => gate })
  const first = requestPrivateConsolidation(ctx, 'fork-busy')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(isConsolidating('fork-busy'), true)
  const second = await requestPrivateConsolidation(ctx, 'fork-busy')
  assert.equal(second.ok, false)
  assert.equal(second.running, true)
  assert.equal(ctx.rec.created.length, 1, 'the second call must not fork again')
  release()
  const done = await first
  assert.equal(done.ok, true)
  assert.equal(isConsolidating('fork-busy'), false)
})

test('two calls in the same tick fork once, not twice', async () => {
  // The guard used to be checked before the first await and claimed only after
  // readSession() and agents.create() resolved, so this exact pair raced past it
  // and forked the same transcript twice on the real host.
  state.ensureSession('fork-race', { cwd: path.join(home, 'proj3'), agentPreset: 'coding' })
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  const ctx = host({ live: true, whenIdle: () => gate })
  const both = Promise.all([
    requestPrivateConsolidation(ctx, 'fork-race'),
    requestPrivateConsolidation(ctx, 'fork-race'),
  ])
  await new Promise((resolve) => setTimeout(resolve, 20))
  release()
  const [a, b] = await both
  assert.equal(ctx.rec.created.length, 1, 'exactly one scratch fork for the pair')
  const outcomes = [a, b].map((r) => r.running === true ? 'running' : r.ok === true ? 'ok' : 'error').sort()
  assert.deepEqual(outcomes, ['ok', 'running'], 'the loser is told the session is already being consolidated')
})

test('an unbound session is refused before any fork is attempted', async () => {
  const ctx = host({ live: true })
  const result = await requestPrivateConsolidation(ctx, 'fork-unbound')
  assert.equal(result.ok, false)
  assert.match(result.error, /not bound/)
  assert.equal(ctx.rec.created.length, 0)
  assert.equal(ctx.rec.liveFollowups.length, 0)
})
test('thin evidence holds the fork back until the starvation threshold', async () => {
  state.ensureSession('fork-thin', { cwd: path.join(home, 'proj-thin'), agentPreset: 'coding' })
  // 空闲 5 分钟：还在"短空闲"区间，证据又薄（一条短消息 + 一个工具调用），不唤醒。
  state.setSessionBinding('fork-thin', { lastTurnAt: new Date(Date.now() - 5 * 60_000).toISOString() })
  const ctx = host({ live: true })
  const result = await requestPrivateConsolidation(ctx, 'fork-thin')
  assert.equal(result.ok, true)
  assert.equal(result.skipped, 'low-score')
  assert.equal(ctx.rec.created.length, 0, 'a thin short-idle session must not pay for a fork')
})

test('starvation wakes a thin session so it can never be starved', async () => {
  state.ensureSession('fork-starved', { cwd: path.join(home, 'proj-starved'), agentPreset: 'coding' })
  state.setSessionBinding('fork-starved', { lastTurnAt: new Date(Date.now() - 40 * 60_000).toISOString() })
  const ctx = host({ live: true })
  const result = await requestPrivateConsolidation(ctx, 'fork-starved')
  assert.equal(result.ok, true)
  assert.equal(ctx.rec.created.length, 1, 'past the starvation threshold the check runs regardless of score')
})

test('a large transcript with nothing new since the cursor does not refork', async () => {
  // 真机会话 5913 条事件、26MB 转录。游标停在末尾附近时，待整理区间只剩几条纯轮询：
  // 没有新的真人回合，就没有可整理的证据，不该为此把整段转录重新种进 fork。
  // （桩把填充事件全放在末尾，所以「大会话 + 末尾一句轻话」这种形态表达不出来；
  //   另一侧「从未整理过就必须整理」由下一条用例覆盖。）
  state.ensureSession('fork-large-thin', { cwd: path.join(home, 'proj-large'), agentPreset: 'coding' })
  state.setSessionBinding('fork-large-thin', {
    lastTurnAt: new Date(Date.now() - 40 * 60_000).toISOString(),
    lastSleepSeq: 5905,
  })
  const ctx = host({ live: true, transcriptSize: 5913 })
  const result = await requestPrivateConsolidation(ctx, 'fork-large-thin')
  assert.equal(result.ok, true)
  assert.equal(result.skipped, 'no-human-turn', 'the increment carries no human turn to consolidate')
  assert.equal(result.settled, true, 'a policy skip is terminal: the idle sweep stops re-reading the same greetings')
  assert.equal(ctx.rec.created.length, 0, 'no fork when the pending increment has no evidence')
  assert.equal(state.getSessionBinding('fork-large-thin').lastSleepSeq, 5912, 'a terminal policy skip advances the coarse cursor so the same thin tail is not rescanned')
})

test('a large transcript that was never consolidated does fork, because the backlog is real', async () => {
  // 同一条会话，但没有整理过：整段 5913 条事件都躺在 pending 里。
  // 守卫要躲的是「为一句轻话重种整段转录」，不是「把从没整理过的大会话永远挡在门外」；
  // 没有这条上界，长会话早期的决定永远进不了记忆——那不是省 token，是丢失。
  state.ensureSession('fork-large-owed', { cwd: path.join(home, 'proj-large-owed'), agentPreset: 'coding' })
  state.setSessionBinding('fork-large-owed', { lastTurnAt: new Date(Date.now() - 40 * 60_000).toISOString() })
  const ctx = host({ live: true, transcriptSize: 5913 })
  const result = await requestPrivateConsolidation(ctx, 'fork-large-owed')
  assert.equal(result.ok, true, 'the backlog bound lets this one through')
  assert.equal(ctx.rec.created.length, 1, 'a large unconsolidated backlog is worth exactly one fork')
})
// ---------------------------------------------------------------- window & seed
test('the seed keeps conversation only, renumbers from zero, and strips replay/stream noise', () => {
  const plugin = { seq: 0, type: 'user/message', data: { source: { kind: 'plugin:dsh-memu-memory', form: 'recall' }, content: [{ type: 'text', text: '旧召回' }] } }
  const runtime = { seq: 1, type: 'user/message', data: { source: { kind: 'runtime-context', form: 'snapshot' }, content: [{ type: 'text', text: '运行时快照' }] } }
  const header = { seq: 2, type: 'request/header', data: { header: {} } }
  const user = { seq: 3, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '记住：我不吃香菜' }] } }
  const assistant = { seq: 4, type: 'assistant/message', data: {
    message: {
      source: { provider: 'p', model: 'm', replayState: { huge: 'x'.repeat(400) } },
      content: [{ type: 'reasoning', text: '思考过程' }, { type: 'text', text: '好的' }, { type: 'tool-call', name: 'read', arguments: 'x'.repeat(2000) }],
    },
    stream: { blob: 'y'.repeat(400) },
  } }
  const repeated = 'R'.repeat(4000)
  const tool1 = { seq: 5, type: 'tool/result', data: { message: { content: [{ type: 'text', text: repeated }] } } }
  const tool2 = { seq: 6, type: 'tool/result', data: { message: { content: [{ type: 'text', text: repeated }] } } }
  const catalog = {
    type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
    data: { role: 'user', source: { kind: 'plugin:dsh-memu-memory', form: 'notice' }, content: [{ type: 'text', text: '已有记忆目录' }] },
  }
  const seed = compactSeedEvents([plugin, runtime, header, user, assistant, tool1, tool2], catalog)
  assert.deepEqual(seed.map(event => event.seq), [0, 1, 2, 3, 4], 'contiguous from zero, catalog at 0')
  assert.match(seed[0].data.content[0].text, /已有记忆目录/)
  assert.equal(seed[1].data.source.kind, 'user', 'only real user messages survive')
  const msg = seed[2].data.message
  assert.equal(msg.content.some(block => block.type === 'reasoning'), false, 'reasoning is not evidence')
  assert.equal(msg.source.replayState, undefined, 'replay state duplicates the body')
  assert.deepEqual(seed[2].data.stream, [], 'the raw chunk log is emptied, not deleted — 0.2.2-rc.1 seed validation requires the array')
  assert.match(msg.content.find(block => block.type === 'tool-call').arguments, /已截断/)
  assert.match(seed[3].data.message.content[0].text, /已截断/)
  assert.match(seed[4].data.message.content[0].text, /与前面相同的工具输出/, 'identical tool output is deduped')
})

test('a long tail is cut to one closed-turn window with a remainder', () => {
  const events = Array.from({ length: CONSOLIDATION_WINDOW_EVENTS + 180 }, (_, seq) => ({ seq, type: 'todo/write', data: {} }))
  const window = selectConsolidationWindow(events)
  assert.equal(window.fromSeq, 0)
  assert.ok(window.events.length <= CONSOLIDATION_WINDOW_EVENTS, 'the window stays bounded')
  assert.ok(window.remaining > 0, 'the rest is left for the next sweep')
  assert.ok(window.throughSeq < events.length - 1)
})

test('a manual re-check starts at a complete turn instead of mid-step', () => {
  const events = [
    { seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '旧回答' }] } } },
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '最后一问' }] } },
    { seq: 2, type: 'turn/start', data: { turn: 2 } },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '最后回答' }] } } },
    { seq: 4, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ]
  const window = selectTailTurnWindow(events)
  assert.equal(window.fromSeq, 1, 'the user message that opened the turn is included')
  assert.equal(window.throughSeq, 4, 'the window ends on a closed turn')
})

test('must-cover candidates keep the high-signal turn and its seq range', () => {
  const events = [
    { seq: 0, type: 'turn/start', data: {} },
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '说好周末拿给阿兰换伞骨，记得带过去。' }] } },
    { seq: 2, type: 'turn/end', data: {} },
    { seq: 3, type: 'turn/start', data: {} },
    { seq: 4, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '今天天气不错。' }] } },
    { seq: 5, type: 'turn/end', data: {} },
  ]
  const rows = mustCoverCandidates(events, { max: 4 })
  assert.equal(rows.length, 1, 'a low-signal turn is not a must-cover candidate')
  assert.equal(rows[0].fromSeq, 0)
  assert.equal(rows[0].throughSeq, 2)
  assert.equal(rows[0].tag, '人物/关系')
  assert.match(rows[0].text, /阿兰/)
})

test('mergeMustCover puts carried candidates first and reserves room for fresh ones', () => {
  const carry = Array.from({ length: 6 }, (_, i) => ({ text: 'carry' + i, fromSeq: i, throughSeq: i, tag: '事实' }))
  const fresh = Array.from({ length: 6 }, (_, i) => ({ text: 'fresh' + i, fromSeq: i, throughSeq: i, tag: '事实' }))
  const merged = mergeMustCover(carry, fresh)
  assert.equal(merged.length, 8)
  assert.deepEqual(merged.slice(0, 4).map((row) => row.text), ['carry0', 'carry1', 'carry2', 'carry3'])
  assert.deepEqual(merged.slice(4).map((row) => row.text), ['fresh0', 'fresh1', 'fresh2', 'fresh3'])
  assert.ok(merged.slice(0, 4).every((row) => row.carried === true))
  assert.equal(mergeMustCover([{ text: 'same' }], [{ text: 'same' }]).length, 1, 'duplicates are dropped')
})

test('a candidate is covered only when a written entry carries the fact', () => {
  const index = {
    entries: {
      'mem-1': { title: '楼下修伞的阿兰', content: '说好周末拿折伞给她换伞骨，布不用动。' },
      'mem-2': { title: '同事叶楠生日是八月十八号', content: '叶楠生日八月十八号。' },
    },
  }
  assert.equal(candidateCovered({ text: '说好周末拿给阿兰换伞骨' }, ['mem-1'], index), true)
  assert.equal(candidateCovered({ text: '叶楠生日八月十八号' }, ['mem-2'], index), true)
  assert.equal(candidateCovered({ text: '父亲不吃芹菜' }, ['mem-1'], index), false)
  assert.equal(candidateCovered({ text: '父亲不吃芹菜' }, [], index), false, 'no writes means no coverage')
})

test('coverage does not discard facts for matching dates, polarity, values, or generic overlap', () => {
  const covered = (text, content, title = '') => candidateCovered({ text }, ['mem-written'], { entries: { 'mem-written': { title, content } } })
  assert.equal(covered('11月20日阿兰取伞', '11月20日小林去医院'), false, 'same date is not the same event')
  assert.equal(covered('父亲不吃芹菜', '父亲爱吃芹菜'), false, 'opposite polarity is not coverage')
  assert.equal(covered('父亲周末去图书馆还书', '父亲周末去图书馆借书'), false, 'shared topic must retain the action')
  assert.equal(covered('父亲生日是11月20日', '父亲生日是11月21日'), false, 'different date is not coverage')
  assert.equal(covered('项目预算是1200元', '项目预算是1500元'), false, 'different value is not coverage')
  assert.equal(covered('11月20日', '11月20日小林去医院'), false, 'date alone is insufficient evidence')
  assert.equal(covered('父亲不吃芹菜', '父亲不吃芹菜，母亲喜欢白菜'), true)
  assert.equal(covered('父亲喜欢芹菜', '父亲喜欢芹菜，母亲不吃白菜'), true, 'unrelated negation does not alter the fact')
  assert.equal(covered('11月20日阿兰取伞', '11月20日阿兰取伞，记得提前联系'), true)
  assert.equal(covered('项目预算是1200元', '项目预算是1200元'), true)
})

test('the same failed snapshot stops automatic re-forking after the failure cap', async () => {
  state.ensureSession('fork-failcap', { cwd: path.join(home, 'proj-failcap'), agentPreset: 'coding' })
  const ctx = host({ live: true, turnReason: { kind: 'error', error: { message: 'provider refused max-tokens argument' } } })
  const first = await requestPrivateConsolidation(ctx, 'fork-failcap', { force: true })
  const second = await requestPrivateConsolidation(ctx, 'fork-failcap', { force: true })
  assert.equal(first.ok, false)
  assert.equal(second.ok, false)
  assert.equal(ctx.rec.created.length, 2, 'two real attempts happen')
  // 自动路径仍然受上限约束：同一快照连续失败 2 次后不再付第三次 fork 成本。
  const third = await requestPrivateConsolidation(ctx, 'fork-failcap')
  assert.equal(third.ok, true)
  assert.equal(third.skipped, 'snapshot-failed')
  assert.equal(ctx.rec.created.length, 2, 'the automatic call does not pay for the same snapshot again')
  // 手动整理是明确的一次再决定：force 不受上限约束（否则冻结回放/用户重试会被永久卡住）。
  const forcedAgain = await requestPrivateConsolidation(ctx, 'fork-failcap', { force: true })
  assert.equal(forcedAgain.ok, false)
  assert.equal(ctx.rec.created.length, 3, 'a manual retry is allowed past the cap')
})

for (const runner of ['fork', 'worker']) {
  test(`${runner} preserves max-tokens pending and retries the same snapshot only after output configuration changes`, async () => {
    state.updateSettings({ consolidationRunner: runner, consolidationModelMode: 'inherit', consolidationReasoningEffort: 'inherit' })
    const id = 'output-limit-' + runner
    state.ensureSession(id, { cwd: path.join(home, id), agentPreset: 'coding' })
    const parentOptions = { provider: id, model: 'test-model', maxTokens: 4096, reasoningEffort: 'medium' }
    markEffortRefused([id, 'test-model', 'medium'].join('|'))
    const ctx = host({ live: true, parentOptions, turnReason: spec => spec.agentOptions.maxTokens <= 4096 ? { kind: 'max-tokens' } : { kind: 'completed' } })
    try {
      for (let i = 0; i < 2; i++) {
        const failed = await requestPrivateConsolidation(ctx, id, { force: true })
        assert.equal(failed.ok, false)
        assert.equal(failed.settled, false)
        assert.equal(failed.reasonCode, 'model-output-limit')
        assert.equal(failed.retryable, true)
        assert.equal(failed.configuredMaxTokens, 4096)
        assert.match(failed.error, /输出预算不足/)
        assert.equal(state.getSessionBinding(id).lastSleepSeq, undefined)
        assert.ok(ledger.sessionState(id).pending)
        assert.equal(parentOptions.maxTokens, 4096, 'the plugin never raises the parent limit')
        assert.equal(parentOptions.reasoningEffort, 'medium')
        assert.equal(ctx.rec.created.at(-1).agentOptions.reasoningEffort, undefined)
      }
      const suppressed = await requestPrivateConsolidation(ctx, id)
      assert.equal(suppressed.skipped, 'snapshot-failed')
      assert.equal(suppressed.settled, false)
      assert.equal(ctx.rec.created.length, 2)
      parentOptions.maxTokens = 32768
      const recovered = await requestPrivateConsolidation(ctx, id)
      assert.equal(recovered.ok, true, recovered.error || '')
      assert.equal(recovered.settled, true)
      assert.equal(ctx.rec.created.length, 3)
      assert.equal(ctx.rec.created.at(-1).agentOptions.maxTokens, 32768)
      assert.equal(state.getSessionBinding(id).lastSleepSeq, 2)
      assert.equal(ledger.sessionState(id).pending, null)
    } finally {
      const worker = state.getSessionBinding(id)?.workerEpoch?.forkSessionId
      if (worker) await retireWorker(ctx, worker, 'test-cleanup', { handoff: false })
      state.updateSettings({ consolidationRunner: 'fork', consolidationModelMode: 'inherit' })
    }
  })
}

test('host-route output default changes unlock a truncated snapshot without inheriting a parent route or overriding its cap', async () => {
  const id = 'output-default-host'
  state.ensureSession(id, { cwd: path.join(home, id), agentPreset: 'coding' })
  state.updateSettings({ consolidationRunner: 'fork', consolidationModelMode: 'host', consolidationModel: 'test-provider/test-model', consolidationReasoningEffort: 'inherit' })
  let defaultMaxTokens = 4096
  const ctx = host({ live: false, llm: { resolveModelInfo: async () => ({ defaultMaxTokens }) }, turnReason: () => defaultMaxTokens <= 4096 ? { kind: 'max-tokens' } : { kind: 'completed' } })
  try {
    for (let i = 0; i < 2; i++) {
      const result = await requestPrivateConsolidation(ctx, id, { force: true })
      assert.equal(result.reasonCode, 'model-output-limit')
      assert.equal(result.configuredMaxTokens, 4096)
    }
    const frozen = await requestPrivateConsolidation(ctx, id)
    assert.equal(frozen.skipped, 'snapshot-failed')
    defaultMaxTokens = 32768
    const resumed = await requestPrivateConsolidation(ctx, id)
    assert.equal(resumed.ok, true, resumed.error || '')
    assert.equal(resumed.settled, true)
    assert.equal(ctx.rec.created.length, 3)
    assert.ok(ctx.rec.created.every(spec => !Object.hasOwn(spec.agentOptions, 'maxTokens')))
  } finally {
    state.updateSettings({ consolidationModelMode: 'inherit', consolidationModel: '' })
  }
})

test('a budget change during a truncated turn is not charged as a failed attempt of the new configuration', async () => {
  const id = 'output-limit-mid-turn-change'
  state.ensureSession(id, { cwd: path.join(home, id), agentPreset: 'coding' })
  state.updateSettings({ consolidationRunner: 'fork', consolidationModelMode: 'inherit', consolidationReasoningEffort: 'inherit' })
  const parentOptions = { provider: id, model: 'test-model', maxTokens: 4096 }
  let oldAttempts = 0
  let newAttempts = 0
  const ctx = host({ live: true, parentOptions, turnReason: spec => {
    if (spec.agentOptions.maxTokens === 4096) {
      if (++oldAttempts === 2) parentOptions.maxTokens = 8192
      return { kind: 'max-tokens' }
    }
    return ++newAttempts === 1 ? { kind: 'max-tokens' } : { kind: 'completed' }
  } })
  for (let i = 0; i < 2; i++) assert.equal((await requestPrivateConsolidation(ctx, id, { force: true })).reasonCode, 'model-output-limit')
  assert.equal((await requestPrivateConsolidation(ctx, id)).reasonCode, 'model-output-limit')
  const recovered = await requestPrivateConsolidation(ctx, id)
  assert.equal(recovered.ok, true, recovered.error || '')
  assert.equal(recovered.settled, true)
  assert.equal(newAttempts, 2)
  assert.equal(ctx.rec.created.length, 4)
  assert.equal(state.getSessionBinding(id).lastSleepSeq, 2)
})

test('a provider default reasoning change reopens an output-limited host route without an explicit effort override', async () => {
  const id = 'output-limit-default-reasoning'
  state.ensureSession(id, { cwd: path.join(home, id), agentPreset: 'coding' })
  state.updateSettings({ consolidationRunner: 'fork', consolidationModelMode: 'host', consolidationModel: id + '/test-model', consolidationReasoningEffort: 'inherit' })
  let defaultEffort = 'high'
  const ctx = host({ live: false, llm: { resolveModelInfo: async () => ({ defaultMaxTokens: 4096, reasoning: { defaultEffort } }) }, turnReason: () => defaultEffort === 'high' ? { kind: 'max-tokens' } : { kind: 'completed' } })
  try {
    for (let i = 0; i < 2; i++) assert.equal((await requestPrivateConsolidation(ctx, id, { force: true })).reasonCode, 'model-output-limit')
    assert.equal((await requestPrivateConsolidation(ctx, id)).skipped, 'snapshot-failed')
    defaultEffort = 'low'
    const result = await requestPrivateConsolidation(ctx, id)
    assert.equal(result.ok, true, result.error || '')
    assert.equal(result.settled, true)
    assert.equal(ctx.rec.created.length, 3)
    assert.ok(ctx.rec.created.every(spec => !Object.hasOwn(spec.agentOptions, 'reasoningEffort')))
  } finally {
    state.updateSettings({ consolidationModelMode: 'inherit', consolidationModel: '' })
  }
})

test('unavailable model metadata does not masquerade as an output configuration change', async () => {
  const id = 'output-limit-unavailable-defaults'
  state.ensureSession(id, { cwd: path.join(home, id), agentPreset: 'coding' })
  state.updateSettings({ consolidationRunner: 'fork', consolidationModelMode: 'host', consolidationModel: id + '/test-model', consolidationReasoningEffort: 'inherit' })
  let unavailable = false
  let defaultMaxTokens = 4096
  const ctx = host({ live: false, llm: { resolveModelInfo: async () => {
    if (unavailable) throw new Error('model metadata unavailable')
    return { defaultMaxTokens }
  } }, turnReason: () => defaultMaxTokens <= 4096 ? { kind: 'max-tokens' } : { kind: 'completed' } })
  try {
    for (let i = 0; i < 2; i++) assert.equal((await requestPrivateConsolidation(ctx, id, { force: true })).reasonCode, 'model-output-limit')
    unavailable = true
    assert.equal((await requestPrivateConsolidation(ctx, id)).skipped, 'snapshot-failed')
    unavailable = false
    assert.equal((await requestPrivateConsolidation(ctx, id)).skipped, 'snapshot-failed')
    assert.equal(ctx.rec.created.length, 2)
    defaultMaxTokens = 32768
    assert.equal((await requestPrivateConsolidation(ctx, id)).settled, true)
    assert.equal(ctx.rec.created.length, 3)
  } finally {
    state.updateSettings({ consolidationModelMode: 'inherit', consolidationModel: '' })
  }
})

test('an explicit live output limit supersedes a cached header budget only on the same route', async () => {
  const id = 'output-limit-cached-header'
  state.ensureSession(id, { cwd: path.join(home, id), agentPreset: 'coding' })
  state.updateSettings({ consolidationRunner: 'fork', consolidationModelMode: 'inherit', consolidationReasoningEffort: 'inherit' })
  const parentOptions = { provider: id, model: 'test-model', maxTokens: 4096 }
  const requestConfig = Object.freeze({ provider: id, model: 'test-model', maxTokens: 4096 })
  const ctx = host({ live: true, parentOptions, requestConfig, turnReason: spec => spec.agentOptions.maxTokens <= 4096 ? { kind: 'max-tokens' } : { kind: 'completed' } })
  for (let i = 0; i < 2; i++) assert.equal((await requestPrivateConsolidation(ctx, id, { force: true })).reasonCode, 'model-output-limit')
  assert.equal((await requestPrivateConsolidation(ctx, id)).skipped, 'snapshot-failed')
  parentOptions.maxTokens = 32768
  const result = await requestPrivateConsolidation(ctx, id)
  assert.equal(result.ok, true, result.error || '')
  assert.equal(result.settled, true)
  assert.equal(ctx.rec.created.at(-1).agentOptions.maxTokens, 32768)
  assert.equal(requestConfig.maxTokens, 4096)
  assert.equal(ctx.rec.created.length, 3)
})

// ---------------------------------------------------------------- PTC 兼容
// 现场（2026-10-31，yuike-ptc 会话）：PTC 模式下 request/header 的工具表只有 run_code，
// probe 曾据此判 unavailable（worker-tools-ptc-only），PTC 会话永远不被整理。宿主的
// PTC executor 明确 "only run_code is directly callable"，其余工具走 run_code 程序里的
// SDK 绑定（tools.schemas(agent, toolSet) 枚举可见面）—— header 名单在 PTC 会话里
// 不承载"能不能写记忆"。修复后：PTC 不构成否证 + fork 时把 worker 的读写面
// （WORKER_WRITE_TOOLS + WORKER_READ_TOOLS）挂进 worker 自己的
// scope（注册表按 scope 链取可见面，不扩散到其它会话）。

test('a PTC session (run_code only header) is consolidated and the worker gets write tools on its own scope', async () => {
  const registered = []
  const disposals = []
  state.ensureSession('fork-ptc', { cwd: path.join(home, 'proj-ptc'), agentPreset: 'yuike-ptc' })
  const ctx = host({
    live: true,
    headerTools: ['run_code'],
    extraEvents: [
      { seq: 3, type: 'tool/ptc-dispatch-start', data: { rootCallId: 'r1', parentCallId: 'r1', subCallId: 'r1:ptc:1', name: 'read', arguments: {} } },
      { seq: 4, type: 'tool/ptc-dispatch', data: { rootCallId: 'r1', parentCallId: 'r1', subCallId: 'r1:ptc:1', name: 'read', arguments: {}, isError: false, content: [] } },
    ],
    childCtxFactory: () => ({
      tools: {
        register: (tool) => {
          registered.push(tool?.name)
          return () => { disposals.push(tool?.name) }
        },
      },
    }),
  })
  const result = await requestPrivateConsolidation(ctx, 'fork-ptc')
  assert.equal(result.ok, true, 'a run_code header must not block consolidation: ' + String(result.error || ''))
  assert.equal(result.settled, true)
  assert.equal(ctx.rec.created.length, 1, 'the fork is created for the PTC conversation')
  // 只挂 worker 真正用到的写面（remember/batch/update + link/link_suggest 裁决两件）；
  // lexicon、archive/delete/unpin 这些用不到或破坏性的工具不进 worker 面。
  assert.deepEqual([...registered].sort(), ['memu_private_link', 'memu_private_link_suggest', 'memu_private_remember', 'memu_private_remember_batch', 'memu_private_update'])
  // 整理结束（finally）必须卸载挂载，不能给这条一次性 worker 留常驻注册。
  assert.deepEqual([...disposals].sort(), ['memu_private_link', 'memu_private_link_suggest', 'memu_private_remember', 'memu_private_remember_batch', 'memu_private_update'])
  // 全量挂载的活动元数据：attached=实际子集（此处=完整 wanted）、requested=完整 wanted、
  // partial=false。三件一起钉住"成功路径不再含糊"。
  const started = startedEntryFor(ctx, 'fork-ptc')
  assert.deepEqual([...started.detail.workerToolsAttached].sort(), ['memu_private_link', 'memu_private_link_suggest', 'memu_private_remember', 'memu_private_remember_batch', 'memu_private_update'])
  assert.deepEqual([...started.detail.workerToolsRequested].sort(), ['memu_private_link', 'memu_private_link_suggest', 'memu_private_remember', 'memu_private_remember_batch', 'memu_private_update'])
  assert.equal(started.detail.workerToolsPartial, false, 'a full mount is not partial')
  const followup = ctx.rec.forkFollowups[0]?.message
  const brief = Array.isArray(followup?.content)
    ? followup.content.map((block) => block?.text || '').join('\n')
    : String(followup || '')
  assert.match(brief, /run_code/, 'the brief names the PTC transport')
  assert.match(brief, /tools\.memu_private_remember/, 'the brief shows the SDK invocation shape')
})

// "整理已开始"那条活动日志：按 sessionId + phase=started 取，childId 对上这次的 fork。
function startedEntryFor(ctx, sessionId) {
  const childId = ctx.rec.created[0]?.sessionId
  const entry = activity.listEvents({ kind: 'consolidate', sessionId })
    .find((row) => row.detail?.phase === 'started' && row.detail?.childId === childId)
  assert.ok(entry, 'the consolidation-started activity entry exists')
  return entry
}

test('a host registry refusing one write tool leaves a structured partial mount in the activity log', async () => {
  // 宿主注册表对单件工具说"不"（重名、scope 锁定）是真实的部分挂载路径：registerTools
  // 逐件 fail-open，其余工具照常挂上。活动日志必须记实际子集 + requested + partial，
  // 而不是把 wanted 全量误报成已挂载（旧口径的缺陷）。
  const registered = []
  const disposals = []
  state.ensureSession('fork-ptc-partial', { cwd: path.join(home, 'proj-ptc-partial'), agentPreset: 'yuike-ptc' })
  const ctx = host({
    live: true,
    headerTools: ['run_code'],
    childCtxFactory: () => ({
      tools: {
        register: (tool) => {
          if (tool?.name === 'memu_private_remember') throw new Error('registry refused: name already bound')
          registered.push(tool?.name)
          return () => { disposals.push(tool?.name) }
        },
      },
    }),
  })
  const result = await requestPrivateConsolidation(ctx, 'fork-ptc-partial')
  assert.equal(result.ok, true, String(result.error || ''))
  assert.equal(result.settled, true)
  assert.deepEqual([...registered].sort(), ['memu_private_link', 'memu_private_link_suggest', 'memu_private_remember_batch', 'memu_private_update'],
    'exactly the tools that actually registered are mounted')
  assert.deepEqual([...disposals].sort(), ['memu_private_link', 'memu_private_link_suggest', 'memu_private_remember_batch', 'memu_private_update'],
    'dispose unmounts exactly what was mounted')
  const started = startedEntryFor(ctx, 'fork-ptc-partial')
  assert.deepEqual([...started.detail.workerToolsAttached].sort(), ['memu_private_link', 'memu_private_link_suggest', 'memu_private_remember_batch', 'memu_private_update'],
    'the log records the actual subset, not the full wanted list')
  assert.deepEqual([...started.detail.workerToolsRequested].sort(), ['memu_private_link', 'memu_private_link_suggest', 'memu_private_remember', 'memu_private_remember_batch', 'memu_private_update'])
  assert.equal(started.detail.workerToolsPartial, true)
  // 挂载为部分子集时任务书仍带 PTC 调用形态：worker 知道写记忆走 run_code 的 SDK 绑定。
  const followup = ctx.rec.forkFollowups[0]?.message
  const brief = Array.isArray(followup?.content)
    ? followup.content.map((block) => block?.text || '').join('\n')
    : String(followup || '')
  assert.match(brief, /await tools\.memu_private_remember/, 'the brief keeps the PTC invocation shape on a partial mount')
})

test('a fork context without a tools service records a null mount, the request and the partial flag', async () => {
  // 宿主不暴露 agent ctx（或 ctx 上没有 tools 服务）→ attachWorkerTools 的现有 warn 路径。
  // 语义：workerToolsAttached=null = 挂载没有完成（与"挂全了"严格区分）；requested 仍记
  // 完整 wanted；workerToolsPartial=true —— "未证明拿到完整 wanted 集"，一件都没有
  // 是它最极端的形态。若这里标 false，false 会被一眼读成"全量挂载"，元数据又不准了。
  state.ensureSession('fork-ptc-notools', { cwd: path.join(home, 'proj-ptc-notools'), agentPreset: 'yuike-ptc' })
  const ctx = host({ live: true, headerTools: ['run_code'] })
  const result = await requestPrivateConsolidation(ctx, 'fork-ptc-notools')
  assert.equal(result.ok, true, String(result.error || ''))
  const started = startedEntryFor(ctx, 'fork-ptc-notools')
  assert.equal(started.detail.workerToolsAttached, null, 'no mount completed, so the log must not claim one')
  assert.deepEqual([...started.detail.workerToolsRequested].sort(), ['memu_private_link', 'memu_private_link_suggest', 'memu_private_remember', 'memu_private_remember_batch', 'memu_private_update'])
  assert.equal(started.detail.workerToolsPartial, true)
})

test('a non-PTC header without write tools still refuses to fork', async () => {
  state.ensureSession('fork-notools', { cwd: path.join(home, 'proj-notools'), agentPreset: 'coding' })
  const ctx = host({ live: true, headerTools: ['read', 'shell', 'edit'] })
  const result = await requestPrivateConsolidation(ctx, 'fork-notools')
  assert.equal(result.ok, false)
  assert.equal(result.reasonCode, 'worker-tools-missing')
  assert.equal(ctx.rec.created.length, 0, 'no fork when the model surface provably lacks the write tools')
})

// 超时预算（2026-11-15）：下限与封顶齐平为 600 s——预算恒为 600 s（10 分钟），不再随
// 事件数缩放。慢推理模型（GLM-5.3-Flash）+ 500 事件窗需要完整的 10 分钟余量；卡死的
// fork 仍会在 10 分钟到点后被收掉。显式 maxWaitMs 调用原样生效（另见 requestHistoricalConsolidation）。
test('the consolidation wait budget is a flat 600 s for the slow-reasoning window', () => {
  assert.equal(CONSOLIDATION_WAIT_POLICY.minMs, 600_000)
  assert.equal(CONSOLIDATION_WAIT_POLICY.maxMs, 600_000)
  assert.equal(consolidationWaitBudget(0), 600_000, 'an empty range still gets the full budget')
  assert.equal(consolidationWaitBudget(100), 600_000, 'small sessions get the full ten minutes')
  assert.equal(consolidationWaitBudget(935), 600_000, 'the session that timed out gets the full ten minutes')
  assert.equal(consolidationWaitBudget(5_000), 600_000, 'a wedged fork still dies inside ten minutes')
  assert.equal(consolidationWaitBudget(undefined), 600_000)
  assert.equal(consolidationWaitBudget('not-a-number'), 600_000)
  assert.ok(CONSOLIDATION_WAIT_POLICY.minMs <= CONSOLIDATION_WAIT_POLICY.maxMs)
})

// ---------------------------------------------------------------- 整理 fork 的模型选择（三模式接线）
// lib/fork-model.js 的解析与 route 生命周期在 fork-model.test.mjs 单测；这里钉住接线行为：
// fork 真正拿到的 agentOptions、被拒时的 reasonCode、以及 inherit 模式与旧路径逐字节一致。

function servingLlm() {
  const llm = {
    registerAdapter: (routes) => {
      const handle = () => {}
      handle.replace = () => {}
      return handle
    },
    listModels: async (provider) => [{ provider, id: 'any', name: 'route serves models', inputModalities: ['text'] }],
  }
  return llm
}

const CUSTOM = {
  consolidationModelMode: 'custom',
  consolidationCustomBaseURL: 'http://127.0.0.1:9100/v1',
  consolidationCustomModel: 'gateway-model',
  consolidationCustomApiKey: '',
}

function restoreSettings() {
  state.updateSettings({
    consolidationModelMode: 'inherit',
    consolidationModel: null,
    consolidationCustomBaseURL: '',
    consolidationCustomApiKey: '',
    consolidationCustomModel: '',
    consolidationCustomApi: 'openai-completions',
  })
}

test('custom mode puts the fork on the registered dsh-memu-custom route', async () => {
  state.updateSettings(CUSTOM)
  try {
    state.ensureSession('fork-mode-custom', { cwd: path.join(home, 'proj-mode-custom'), agentPreset: 'coding' })
    const ctx = host({ live: true, llm: servingLlm() })
    const result = await requestPrivateConsolidation(ctx, 'fork-mode-custom')
    assert.equal(result.ok, true, String(result.error || ''))
    assert.equal(result.settled, true)
    assert.equal(ctx.rec.created.length, 1)
    assert.deepEqual(ctx.rec.created[0].agentOptions, { provider: 'dsh-memu-custom', model: 'gateway-model' }, 'the fork names the plugin-owned custom route')
    const started = startedEntryFor(ctx, 'fork-mode-custom')
    assert.equal(started.detail.modelMode, 'custom')
  } finally {
    forkModel.disposeConsolidationRoute()
    restoreSettings()
  }
})

test('custom mode falls back to the inherited route when the host cannot serve the custom route', async () => {
  state.updateSettings(CUSTOM)
  try {
    state.ensureSession('fork-mode-fallback', { cwd: path.join(home, 'proj-mode-fallback'), agentPreset: 'coding' })
    // 没有 llm service 的宿主：custom 不可用，降级回父会话 route，整理照常完成。
    const ctx = host({ live: true, parentOptions: { provider: 'fallback-prov', model: 'fallback-model' } })
    const result = await requestPrivateConsolidation(ctx, 'fork-mode-fallback')
    assert.equal(result.ok, true, String(result.error || ''))
    assert.deepEqual(ctx.rec.created[0].agentOptions, { provider: 'fallback-prov', model: 'fallback-model' }, 'the fork falls back to the parent route instead of dying')
    const started = startedEntryFor(ctx, 'fork-mode-fallback')
    assert.equal(started.detail.modelMode, 'inherit-fallback')
  } finally {
    restoreSettings()
  }
})

test('custom mode without a usable custom route and without a parent route is refused', async () => {
  state.updateSettings(CUSTOM)
  try {
    state.ensureSession('fork-mode-custom-dead', { cwd: path.join(home, 'proj-mode-dead'), agentPreset: 'coding' })
    const ctx = host({ live: true, parentOptions: null })
    const result = await requestPrivateConsolidation(ctx, 'fork-mode-custom-dead')
    assert.equal(result.ok, false)
    assert.equal(result.reasonCode, 'custom-route-unavailable')
    assert.match(result.error, /custom consolidation route is unavailable/)
    assert.equal(ctx.rec.created.length, 0)
  } finally {
    restoreSettings()
  }
})

test('host mode resolves consolidationModel the same way the curator does', async () => {
  state.updateSettings({ consolidationModelMode: 'host', consolidationModel: 'host-prov/host-model/nested' })
  try {
    state.ensureSession('fork-mode-host', { cwd: path.join(home, 'proj-mode-host'), agentPreset: 'coding' })
    const ctx = host({ live: true, parentOptions: { provider: 'other', model: 'other-model' } })
    const result = await requestPrivateConsolidation(ctx, 'fork-mode-host')
    assert.equal(result.ok, true, String(result.error || ''))
    assert.deepEqual(ctx.rec.created[0].agentOptions, { provider: 'host-prov', model: 'host-model/nested' }, 'everything after the first slash is the model id')
    assert.equal(startedEntryFor(ctx, 'fork-mode-host').detail.modelMode, 'host')
  } finally {
    restoreSettings()
  }
})

test('a bad host consolidationModel is refused with its own reason, not the parent one', async () => {
  state.updateSettings({ consolidationModelMode: 'host', consolidationModel: 'no-slash' })
  try {
    state.ensureSession('fork-mode-host-bad', { cwd: path.join(home, 'proj-mode-host-bad'), agentPreset: 'coding' })
    const ctx = host({ live: true })
    const result = await requestPrivateConsolidation(ctx, 'fork-mode-host-bad')
    assert.equal(result.ok, false)
    assert.equal(result.reasonCode, 'invalid-consolidation-model')
    assert.match(result.error, /consolidation model \(/, 'the new reasons name the bad configuration face, not the parent route')
    assert.equal(ctx.rec.created.length, 0)
  } finally {
    restoreSettings()
  }
})

test('compactSeedEvents accepts the catalog and local recall as two read-only preludes', () => {
  const user = {
    seq: 10,
    type: 'user/message',
    time: 1,
    sceneTime: '2026-11-06T04:00:00+08:00',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '明天码头见' }] },
  }
  const catalog = {
    seq: 0,
    type: 'user/message',
    time: 1,
    data: { source: { kind: 'plugin:dsh-memu-memory', form: 'notice', summary: 'memory-catalog' }, content: [{ type: 'text', text: '[memory-catalog]' }] },
  }
  const recall = {
    seq: 0,
    type: 'user/message',
    time: 1,
    data: { source: { kind: 'plugin:dsh-memu-memory', form: 'notice', summary: 'memory-recall' }, content: [{ type: 'text', text: '[memory-recall] [mem-1] 码头' }] },
  }
  const seed = compactSeedEvents([user], [catalog, recall])
  assert.equal(seed.length, 3)
  assert.deepEqual(seed.map((event) => event.seq), [0, 1, 2])
  assert.equal(seed[0].data.source.summary, 'memory-catalog')
  assert.equal(seed[1].data.source.summary, 'memory-recall')
  assert.equal(seed[2].type, 'user/message')
  assert.match(seed[2].data.content[0].text, /事件时间/)
})

// ------------------------------------------------------- surface replacements
// Mirrors @deepseek-ai/dsh-session 0.2.2-rc.1 Session.create for the fields a
// consolidation seed touches: seq contiguity plus the surface fold. The host
// rejects "seed event at index N has seq M" and every dangling replace citation,
// so the assertion has to replay the fold, not just look at one event.
const HOST_SURFACE_EVENT_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
function assertSeedAcceptedByHost(seed, label = 'seed') {
  const nodes = []
  seed.forEach((event, index) => {
    assert.equal(event.seq, index, `${label}: event at index ${index} has seq ${event.seq}`)
    if (!HOST_SURFACE_EVENT_TYPES.has(event.type)) {
      assert.equal(event.surfaceOp, undefined, `${label}: ${event.type} cannot carry surfaceOp`)
      assert.equal(event.sourceEventSeqs, undefined, `${label}: ${event.type} cannot carry sourceEventSeqs`)
      return
    }
    const op = event.surfaceOp
    assert.ok(op !== undefined, `${label}: ${event.type} at ${index} requires a surfaceOp marker`)
    const sources = event.sourceEventSeqs
    if (sources !== undefined) {
      assert.ok(Array.isArray(sources) && sources.length > 0, `${label}: sourceEventSeqs must be a non-empty array`)
      assert.equal(new Set(sources).size, sources.length, `${label}: sourceEventSeqs must not repeat`)
      assert.ok(sources.every(seq => Number.isSafeInteger(seq) && seq < event.seq), `${label}: sourceEventSeqs must reference earlier events`)
    }
    if (op === 'append') {
      nodes.push(event.seq)
      return
    }
    assert.deepEqual(Object.keys(op).sort(), ['endSeq', 'op', 'startSeq'], `${label}: replace markers carry exactly op/startSeq/endSeq`)
    assert.ok(op.startSeq < event.seq && op.endSeq < event.seq, `${label}: surface replace at ${index} must reference earlier events`)
    const startIdx = nodes.indexOf(op.startSeq)
    const endIdx = nodes.indexOf(op.endSeq)
    assert.ok(startIdx >= 0, `${label}: replace start seq ${op.startSeq} is not on the surface`)
    assert.ok(endIdx >= startIdx, `${label}: replace range must be ordered`)
    const shadowed = nodes.slice(startIdx, endIdx + 1)
    if (event.type === 'tool/result') assert.equal(shadowed.length, 1, `${label}: tool/result replacement rewrites exactly one node`)
    assert.ok(Array.isArray(sources), `${label}: replace at ${index} needs sourceEventSeqs`)
    assert.deepEqual(shadowed.filter(seq => !sources.includes(seq)), [], `${label}: replace at ${index} must cite every shadowed node`)
    nodes.splice(startIdx, endIdx - startIdx + 1)
    nodes.push(event.seq)
  })
}

const userEvent = (seq, text, extra = {}) => ({
  seq, type: 'user/message', surfaceOp: 'append',
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] }, ...extra,
})
const assistantEvent = (seq, text) => ({
  seq, type: 'assistant/message', surfaceOp: 'append',
  data: { message: { content: [{ type: 'text', text }] } },
})
const toolResultEvent = (seq, text, extra = {}) => ({
  seq, type: 'tool/result', surfaceOp: 'append',
  data: { message: { content: [{ type: 'text', text }] } }, ...extra,
})

test('a surface replace is renumbered into the seed instead of citing original seqs', () => {
  const seed = compactSeedEvents([
    userEvent(0, '记住：周五交房租'),
    assistantEvent(1, '好'),
    toolResultEvent(2, '原始工具输出'),
    toolResultEvent(3, '[已裁剪]', {
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 },
      sourceEventSeqs: [2],
    }),
    userEvent(4, '继续'),
  ])
  assert.deepEqual(seed.map(event => event.seq), [0, 1, 2, 3, 4])
  assert.deepEqual(seed[3].surfaceOp, { op: 'replace', startSeq: 2, endSeq: 2 }, 'the citation follows the surviving node, not its original seq')
  assert.deepEqual(seed[3].sourceEventSeqs, [2])
  assertSeedAcceptedByHost(seed)
})

test('a replace pointing outside the window is dropped and the seed stays contiguous', () => {
  // 窗口从父会话中间切出：seq 4 不在这一窗里；后面的 replace 又引用前面被丢的
  // replace。旧实现先编号后丢弃，留下 seq 空洞，宿主报 index 1 has seq 5。
  const seed = compactSeedEvents([
    userEvent(10, '这一窗的第一句'),
    toolResultEvent(11, '输出'),
    toolResultEvent(12, '[已裁剪]', {
      surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 },
      sourceEventSeqs: [4],
    }),
    assistantEvent(13, '回答'),
    toolResultEvent(14, '[已裁剪]', {
      surfaceOp: { op: 'replace', startSeq: 12, endSeq: 12 },
      sourceEventSeqs: [12],
    }),
  ])
  assert.deepEqual(seed.map(event => event.seq), [0, 1, 2], 'dropping a patch must renumber the survivors')
  assert.equal(seed.some(event => event.surfaceOp && typeof event.surfaceOp === 'object'), false)
  assertSeedAcceptedByHost(seed)
})

test('a replacement that cites another replacement keeps both when their targets survive', () => {
  const seed = compactSeedEvents([
    userEvent(0, '开头'),
    toolResultEvent(1, '原始输出'),
    toolResultEvent(2, '[第一次裁剪]', {
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
      sourceEventSeqs: [1],
    }),
    assistantEvent(3, '中间'),
    toolResultEvent(4, '[第二次裁剪]', {
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 },
      sourceEventSeqs: [2],
    }),
  ])
  assert.deepEqual(seed.map(event => event.seq), [0, 1, 2, 3, 4])
  assert.deepEqual(seed[2].surfaceOp, { op: 'replace', startSeq: 1, endSeq: 1 })
  assert.deepEqual(seed[4].surfaceOp, { op: 'replace', startSeq: 2, endSeq: 2 })
  assertSeedAcceptedByHost(seed)
})

test('a multi-node replace is remapped when every shadowed node survives', () => {
  const seed = compactSeedEvents([
    userEvent(0, 'A'),
    userEvent(1, 'X'),
    userEvent(2, 'B'),
    userEvent(3, '外层摘要', {
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 2 },
      sourceEventSeqs: [0, 1, 2],
    }),
  ])
  assert.deepEqual(seed.map(event => event.seq), [0, 1, 2, 3])
  assert.deepEqual(seed[3].surfaceOp, { op: 'replace', startSeq: 0, endSeq: 2 })
  assert.deepEqual(seed[3].sourceEventSeqs, [0, 1, 2])
  assertSeedAcceptedByHost(seed)
})

test('a replace is dropped when filtering an inner checkpoint reveals a shadowed node', () => {
  // 内层压缩检查点（source.kind 不是 user）会被种子过滤器丢掉；它遮住的 X 因此
  // 重新出现在种子的 surface 上。外层替换写于 X 被遮住期间，引用里没有 X。
  // 宿主会要求外层补上 X 的引用——补不出来就只能丢外层，种子回到纯 append。
  const seed = compactSeedEvents([
    userEvent(0, 'A'),
    userEvent(1, 'X'),
    userEvent(2, 'B'),
    userEvent(3, '内层摘要', { data: { source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: '内层摘要' }] }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, sourceEventSeqs: [1] }),
    userEvent(4, '外层摘要', {
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 2 },
      sourceEventSeqs: [0, 2],
    }),
  ])
  assert.deepEqual(seed.map(event => event.seq), [0, 1, 2])
  assert.deepEqual(seed.map(event => event.data.content[0].text), ['A', 'X', 'B'])
  assertSeedAcceptedByHost(seed)
})


// 2026-11-15 扫雷守卫：整理思考强度被模型拒绝 → 学习组合 → 清失败连击 → 下次 fork 不带档。
// 现场：wb/glm-5.3-flash 不支持 medium，fork 回合起点即失败，同快照 2 次后被冻结数天。
function rejectMedium(spec) {
  const { provider, model, reasoningEffort } = spec.agentOptions
  return reasoningEffort === 'medium'
    ? { kind: 'error', error: { message: `provider "${provider}" model "${model}" does not support reasoning effort "medium"` } }
    : { kind: 'completed' }
}

function cleanupEffortHost(t, ctx, sessionId) {
  t.after(async () => {
    const forkId = state.getSessionBinding(sessionId)?.workerEpoch?.forkSessionId
    if (forkId) await retireWorker(ctx, forkId, 'test-finished', { handoff: false })
    state.updateSettings({ consolidationRunner: 'fork', consolidationReasoningEffort: 'inherit' })
    restoreSettings()
  })
}

for (const runner of ['fork', 'worker']) {
  for (const mode of ['inherit', 'custom']) {
    for (const effort of ['inherit', 'medium']) {
      test(`${runner} learns inherited medium with ${mode} route / ${effort} setting and really succeeds on retry`, async (t) => {
        const id = `effort-${runner}-${mode}-${effort}`
        const parentOptions = Object.freeze({ provider: id, model: 'test-model', reasoningEffort: 'medium', maxTokens: 32768 })
        const key = `${id}|test-model|medium`
        const ctx = host({ live: true, parentOptions, turnReason: rejectMedium })
        ctx.permissionPresets = { set: t.mock.fn() }
        cleanupEffortHost(t, ctx, id)
        state.updateSettings({ ...(mode === 'custom' ? CUSTOM : {}), consolidationRunner: runner, consolidationReasoningEffort: effort })
        state.ensureSession(id, { cwd: home, agentPreset: 'coding' })
        assert.equal(effortRefusalOf(rejectMedium({ agentOptions: parentOptions }).error.message).key, key)
        assert.equal(isEffortRefused(key), false)

        const first = await requestPrivateConsolidation(ctx, id, { force: true })
        assert.equal(first.ok, false)
        assert.equal(first.reasonCode, 'fork-turn-failed')
        assert.equal(state.getSessionBinding(id).lastSleepSeq, undefined)
        assert.equal(isEffortRefused(key), true)
        assert.deepEqual(ctx.rec.created[0].agentOptions, parentOptions)
        assert.ok(ctx.rec.disposed.includes(first.childId), 'the failed child was retired')
        assert.equal(state.getSessionBinding(first.childId), null, 'the failed child binding was removed')
        if (runner === 'worker') assert.equal(state.getSessionBinding(id).workerEpoch ?? null, null)
        if (mode === 'custom') assert.equal(startedEntryFor(ctx, id).detail.modelMode, 'inherit-fallback')

        const second = await requestPrivateConsolidation(ctx, id)
        assert.equal(second.skipped, undefined, 'the automatic retry is not frozen')
        assert.equal(second.ok, true, second.error || '')
        assert.equal(second.settled, true, 'the parameter-dependent host completed and its receipt settled')
        assert.equal(state.getSessionBinding(id).lastSleepSeq, 2)
        assert.equal(ctx.rec.created.length, 2, 'retry really creates a fresh child')
        assert.notEqual(second.childId, first.childId)
        const secondOptions = ctx.rec.created[1].agentOptions
        assert.equal(Object.hasOwn(secondOptions, 'reasoningEffort'), false)
        assert.deepEqual(secondOptions, { provider: id, model: 'test-model', maxTokens: 32768 })
        assert.equal(ctx.get('agents').get(id).options, parentOptions, 'the parent object is not replaced')
        assert.equal(parentOptions.reasoningEffort, 'medium', 'the parent effort is untouched')
        assert.equal(ctx.permissionPresets.set.mock.callCount(), 0, 'no automatic permission elevation')
      })
    }
  }

  test(`${runner} applies an allowed explicit effort after custom fallback and checks only the effective route`, async (t) => {
    const id = `effort-override-${runner}`
    const parentOptions = Object.freeze({ provider: id, model: 'model', reasoningEffort: 'medium', maxTokens: 4096 })
    const ctx = host({ live: true, parentOptions, turnReason: rejectMedium })
    cleanupEffortHost(t, ctx, id)
    state.updateSettings({ ...CUSTOM, consolidationRunner: runner, consolidationReasoningEffort: 'high' })
    state.ensureSession(id, { cwd: home, agentPreset: 'coding' })
    markEffortRefused(`${id}|model|medium`)
    markEffortRefused('dsh-memu-custom|gateway-model|high')
    const result = await requestPrivateConsolidation(ctx, id, { force: true })
    assert.equal(result.ok, true, result.error || '')
    assert.equal(result.settled, true)
    assert.equal(startedEntryFor(ctx, id).detail.modelMode, 'inherit-fallback')
    assert.deepEqual(ctx.rec.created[0].agentOptions, { ...parentOptions, reasoningEffort: 'high' })
    assert.equal(parentOptions.reasoningEffort, 'medium')
  })
}

test('a fresh worker shares the refusal learned by a fork', async (t) => {
  const parentOptions = Object.freeze({ provider: 'shared-effort', model: 'model', reasoningEffort: 'medium', maxTokens: 8192 })
  const ctx = host({ live: true, parentOptions, turnReason: rejectMedium })
  cleanupEffortHost(t, ctx, 'effort-shared-worker')
  state.updateSettings({ consolidationRunner: 'fork', consolidationReasoningEffort: 'inherit' })
  state.ensureSession('effort-shared-fork', { cwd: home, agentPreset: 'coding' })
  const failed = await requestPrivateConsolidation(ctx, 'effort-shared-fork', { force: true })
  assert.equal(failed.reasonCode, 'fork-turn-failed')
  state.updateSettings({ consolidationRunner: 'worker' })
  state.ensureSession('effort-shared-worker', { cwd: home, agentPreset: 'coding' })
  const result = await requestPrivateConsolidation(ctx, 'effort-shared-worker', { force: true })
  assert.equal(result.ok, true, result.error || '')
  assert.equal(result.settled, true)
  assert.match(result.childId, /^memu-worker-/)
  assert.deepEqual(ctx.rec.created[1].agentOptions, { provider: 'shared-effort', model: 'model', maxTokens: 8192 })
  assert.equal(parentOptions.reasoningEffort, 'medium')
})

// 2026-11-18：学习表持久化。反代服务商签名各异（raccoon/sn-deepseek-v4-1-flash-1017
// 拒 medium 实测），表只在内存时每次重启后的第一次整理都要再吃一次 fork-turn-failed。
test('a learned effort refusal survives a restart — it is persisted to the data dir', async (t) => {
  state.updateSettings({ consolidationReasoningEffort: 'medium' })
  state.ensureSession('fork-effort-persist', { cwd: path.join(home, 'proj-effort-persist'), agentPreset: 'coding' })
  const ctx = host({ live: true, parentOptions: { provider: 'persist-provider', model: 'persist-model' }, turnReason: rejectMedium })
  cleanupEffortHost(t, ctx, 'fork-effort-persist')
  const first = await requestPrivateConsolidation(ctx, 'fork-effort-persist', { force: true })
  assert.equal(first.ok, false)
  assert.equal(first.reasonCode, 'fork-turn-failed')

  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir(), 'effort-refusals.json'), 'utf8'))
  assert.ok(persisted.keys.includes('persist-provider|persist-model|medium'), 'the refusal was written to the data dir')
  const child = effortChild(t, home, `assert.equal(api.isEffortRefused('persist-provider|persist-model|medium'), true)`)
  await child.ready
  child.release()
  await child.done
})

// 子进程只加载测试 loader + private.js，home/cwd 全部指向临时目录。
// IPC 屏障保证并发用例里的两个进程先各自读完旧表，再同时开始 mark。
function effortChild(t, dir, before, after = '') {
  const code = `
    import assert from 'node:assert/strict'
    const api = await import(${JSON.stringify(new URL('../lib/private.js', import.meta.url).href)})
    ${before}
    const released = new Promise(resolve => process.once('message', resolve))
    process.send('loaded')
    await released
    ${after}
    process.disconnect()
  `
  const child = spawn(process.execPath, ['--import', new URL('./loader-register.mjs', import.meta.url).href, '--input-type=module', '-e', code], {
    cwd: dir, windowsHide: true, timeout: 20_000,
    env: { ...process.env, DSH_HOME: dir, DSH_MEMU_HOME: dir, DSH_MEMU_MEMORY_HOME: dir },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let errors = ''
  child.stdout.on('data', data => { errors += data })
  child.stderr.on('data', data => { errors += data })
  const ready = new Promise((resolve, reject) => {
    child.on('message', message => { if (message === 'loaded') resolve() })
    child.on('error', reject)
    child.on('close', () => reject(new Error('child exited before barrier: ' + errors)))
  })
  const done = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error('effort child failed: ' + errors)))
  })
  // 在等待另一个进程抵达屏障时也接住早退；原 promise 仍供断言 await。
  ready.catch(() => {})
  done.catch(() => {})
  t.after(() => { if (child.exitCode === null) child.kill() })
  return { ready, done, release: () => child.send('mark') }
}

function refusalStore(t) {
  state.flushState()
  const dir = fs.mkdtempSync(path.join(home, 'effort-store-'))
  const previous = [process.env.DSH_MEMU_HOME, process.env.DSH_MEMU_MEMORY_HOME]
  process.env.DSH_MEMU_HOME = process.env.DSH_MEMU_MEMORY_HOME = dir
  const warnings = []
  setWarnSink(message => warnings.push(message))
  t.after(() => {
    ;[process.env.DSH_MEMU_HOME, process.env.DSH_MEMU_MEMORY_HOME] = previous
    setWarnSink(null)
  })
  return { dir, file: path.join(dir, 'effort-refusals.json'), warnings }
}

function seedRefusals(file, keys) {
  const raw = JSON.stringify({ version: 1, keys })
  fs.writeFileSync(file, raw)
  return raw
}

function refusalKeys(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).keys.sort()
}

test('refusals load lazily once and clean queries/duplicate marks perform no file IO', async (t) => {
  const { file } = refusalStore(t)
  seedRefusals(file, ['initial|model|medium'])
  const read = t.mock.method(fs, 'readFileSync')
  const write = t.mock.method(fs, 'writeFileSync')
  const fresh = await import('../lib/private.js?effort-lazy')
  const tableReads = () => read.mock.calls.filter(call => call.arguments[0] === file).length
  assert.equal(tableReads(), 0, 'import does not capture or read a home')
  assert.equal(fresh.isEffortRefused('initial|model|medium'), true)
  assert.equal(tableReads(), 1)
  for (let i = 0; i < 20; i++) {
    assert.equal(fresh.isEffortRefused('initial|model|medium'), true)
    assert.equal(fresh.isEffortRefused('unknown|model|medium'), false)
    fresh.markEffortRefused('initial|model|medium')
  }
  assert.equal(tableReads(), 1, 'a clean cache never rescans the table')
  assert.equal(write.mock.callCount(), 0, 'queries and duplicate clean marks never rewrite the table')
})

test('a failed initial read never replaces old keys and retries after IO recovers', (t) => {
  const { file, warnings } = refusalStore(t)
  const original = seedRefusals(file, ['old|model|medium'])
  const read = fs.readFileSync
  let failing = true
  t.mock.method(fs, 'readFileSync', function (target, ...args) {
    if (target === file && failing) throw Object.assign(new Error('read failed api_key=secret123456789'), { code: 'EIO' })
    return read.call(this, target, ...args)
  })
  assert.equal(isEffortRefused('old|model|medium'), false, 'an unreadable key is not yet known')
  markEffortRefused('new|model|medium')
  assert.equal(isEffortRefused('new|model|medium'), true, 'new knowledge survives the failed read')
  assert.equal(read(file, 'utf8'), original, 'read failure cannot be saved back as an empty table')
  assert.ok(warnings.length > 0)
  assert.ok(warnings.every(message => !message.includes('secret123456789')), 'warnings use the existing redaction sink')
  failing = false
  assert.equal(isEffortRefused('old|model|medium'), true, 'the query retries the pending merge')
  assert.deepEqual(refusalKeys(file), ['new|model|medium', 'old|model|medium'])
})

for (const retry of ['same-key mark', 'query']) {
  test(`an atomic write failure keeps pending keys and recovers on ${retry}`, (t) => {
    const { dir, file, warnings } = refusalStore(t)
    const original = seedRefusals(file, ['old|model|medium'])
    assert.equal(isEffortRefused('old|model|medium'), true)
    const rename = fs.renameSync
    let failing = true
    t.mock.method(fs, 'renameSync', function (from, to) {
      if (to === file && failing) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' })
      return rename.call(this, from, to)
    })
    markEffortRefused('new|model|medium')
    assert.equal(isEffortRefused('new|model|medium'), true)
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'failed atomic replace preserves the previous bytes')
    assert.deepEqual(fs.readdirSync(dir), ['effort-refusals.json'], 'temporary files and locks are cleaned')
    assert.ok(warnings.some(message => message.includes('injected rename failure')))
    failing = false
    if (retry === 'same-key mark') markEffortRefused('new|model|medium')
    else assert.equal(isEffortRefused('old|model|medium'), true, 'even an unrelated lookup flushes pending knowledge')
    assert.deepEqual(refusalKeys(file), ['new|model|medium', 'old|model|medium'])
    const reads = t.mock.method(fs, 'readFileSync')
    const writes = t.mock.method(fs, 'writeFileSync')
    isEffortRefused('new|model|medium')
    markEffortRefused('new|model|medium')
    assert.equal(reads.mock.callCount(), 0, 'successful recovery clears the pending state')
    assert.equal(writes.mock.callCount(), 0)
  })
}

for (const [label, raw] of [
  ['broken JSON', '{"version":1,"keys":['],
  ['invalid keys', JSON.stringify({ version: 1, keys: [123] })],
  ['unknown schema', JSON.stringify({ version: 2, keys: [] })],
]) {
  test(`${label} is never overwritten, and pending knowledge merges after repair`, (t) => {
    const { file, warnings } = refusalStore(t)
    fs.writeFileSync(file, raw)
    assert.equal(isEffortRefused('pending|model|medium'), false)
    markEffortRefused('pending|model|medium')
    assert.equal(isEffortRefused('pending|model|medium'), true)
    assert.equal(fs.readFileSync(file, 'utf8'), raw)
    assert.ok(warnings.length > 0)
    seedRefusals(file, ['restored|model|high'])
    assert.equal(isEffortRefused('restored|model|high'), true)
    assert.deepEqual(refusalKeys(file), ['pending|model|medium', 'restored|model|high'])
  })
}

test('refusal caches and writes follow the current home without leaking keys', (t) => {
  const { file: firstFile } = refusalStore(t)
  assert.equal(isEffortRefused('first|model|medium'), false, 'ENOENT starts an empty table')
  markEffortRefused('first|model|medium')
  const secondDir = fs.mkdtempSync(path.join(home, 'effort-other-'))
  const secondFile = path.join(secondDir, 'effort-refusals.json')
  seedRefusals(secondFile, ['second|model|high'])
  process.env.DSH_MEMU_HOME = process.env.DSH_MEMU_MEMORY_HOME = secondDir
  assert.equal(isEffortRefused('first|model|medium'), false)
  assert.equal(isEffortRefused('second|model|high'), true)
  markEffortRefused('second|model|medium')
  process.env.DSH_MEMU_HOME = process.env.DSH_MEMU_MEMORY_HOME = path.dirname(firstFile)
  assert.equal(isEffortRefused('first|model|medium'), true)
  assert.equal(isEffortRefused('second|model|medium'), false)
  assert.deepEqual(refusalKeys(firstFile), ['first|model|medium'])
  assert.deepEqual(refusalKeys(secondFile), ['second|model|high', 'second|model|medium'])
})

test('two processes merge stale refusal snapshots under the file lock', async (t) => {
  const { dir, file } = refusalStore(t)
  seedRefusals(file, ['old|model|medium'])
  const children = ['left', 'right'].map(name => effortChild(t, dir,
    `assert.equal(api.isEffortRefused('old|model|medium'), true)`,
    `api.markEffortRefused('${name}|model|medium'); assert.equal(api.isEffortRefused('${name}|model|medium'), true)`,
  ))
  await Promise.all(children.map(child => child.ready))
  for (const child of children) child.release()
  await Promise.all(children.map(child => child.done))
  assert.deepEqual(refusalKeys(file), ['left|model|medium', 'old|model|medium', 'right|model|medium'])
})

test('missing buildForkSeed only disables fork; worker really completes without loading the seed API', async (t) => {
  const dir = fs.mkdtempSync(path.join(home, 'missing-seed-'))
  const before = `
    const { registerHooks } = await import('node:module')
    let seedImports = 0
    const hooks = registerHooks({ resolve(specifier, context, next) {
      if (specifier === '@deepseek-ai/dsh-session') {
        seedImports++
        return { url: 'data:text/javascript,export const unavailable = true', shortCircuit: true }
      }
      return next(specifier, context)
    } })
    const state = await import(${JSON.stringify(new URL('../lib/state.js', import.meta.url).href)})
    const home = ${JSON.stringify(dir)}
    const META_KEYS = ${JSON.stringify(META_KEYS)}
    const assertHostCreateAccepts = ${assertHostCreateAccepts.toString()}
    const host = ${host.toString()}
    const ctx = host({ live: true, cwd: home })
    state.ensureSession('missing-seed-fork', { cwd: home, agentPreset: 'coding' })
    state.updateSettings({ consolidationRunner: 'fork', consolidationReasoningEffort: 'inherit' })
    const fork = await api.requestPrivateConsolidation(ctx, 'missing-seed-fork', { force: true })
    assert.equal(fork.reasonCode, 'no-fork-seed')
    assert.equal(fork.settled, false)
    assert.equal(ctx.rec.created.length, 0)
    const afterFork = seedImports
    state.ensureSession('missing-seed-worker', { cwd: home, agentPreset: 'coding' })
    state.updateSettings({ consolidationRunner: 'worker' })
    const worker = await api.requestPrivateConsolidation(ctx, 'missing-seed-worker', { force: true })
    assert.equal(worker.ok, true, worker.error || '')
    assert.equal(worker.settled, true)
    assert.equal(ctx.rec.created.length, 1)
    assert.equal(ctx.rec.created[0].seed, undefined)
    assert.equal(state.getSessionBinding('missing-seed-worker').lastSleepSeq, 2)
    assert.equal(seedImports, afterFork, 'worker never imports the missing seed API')
    hooks.deregister()
  `
  const child = effortChild(t, dir, before)
  await child.ready
  child.release()
  await child.done
})

test('coding seeds keep more tool output and arguments than the default caps', () => {
  const events = [
    { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '改代码' }] } },
    { seq: 1, type: 'tool/call', data: { callId: 'c1', name: 'edit', arguments: '{"patch":"' + 'A'.repeat(1500) + '"}' } },
    { seq: 2, type: 'tool/result', data: { message: { callId: 'c1', content: [{ type: 'text', text: 'R'.repeat(3000) }] } } },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '完成' }] } } },
  ]
  const sizes = (seed) => ({
    args: String(seed.find((event) => event.type === 'tool/call').data.arguments).length,
    result: String(seed.find((event) => event.type === 'tool/result').data.message.content[0].text).length,
  })
  const plain = sizes(compactSeedEvents(events))
  const coding = sizes(compactSeedEvents(events, null, seedLimitsFor('coding')))
  assert.ok(plain.args <= 510, 'the default argument cap is unchanged')
  assert.ok(coding.args > 1000, 'coding keeps a longer tool-call argument body')
  assert.ok(plain.result <= 1110, 'the default result cap is unchanged')
  assert.ok(coding.result > 2100 && coding.result < 2300, 'coding keeps 2200 chars of the tool result')
})
