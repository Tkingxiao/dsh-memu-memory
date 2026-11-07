import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-fork-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const activity = await import('../lib/activity-log.js')
const forkModel = await import('../lib/fork-model.js')
const { requestPrivateConsolidation, isConsolidating, consolidationWaitBudget, CONSOLIDATION_WAIT_POLICY, CONSOLIDATION_WINDOW_EVENTS, compactSeedEvents, selectConsolidationWindow, selectTailTurnWindow, mustCoverCandidates, mergeMustCover, candidateCovered } = await import('../lib/private.js')

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

function host({ live = false, whenIdle = null, parentOptions = { provider: 'test-provider', model: 'test-model' }, requestConfig = null, extraEvents = [], transcriptSize = 0, turnReason = { kind: 'completed' }, emitTurnEnd = true, headerTools = null, childCtxFactory = null, llm = null } = {}) {
  const rec = { liveFollowups: [], created: [], forkFollowups: [], disposed: [], sessionHandlers: [], workerToolRegistrations: [], workerToolDisposals: [] }
  const childContexts = new Map()
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
            // attachWorkerTools 用 childContexts 模拟"宿主在 create 后暴露的 agent ctx"。
            if (childContexts.has(id)) return { ctx: childContexts.get(id) }
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
            rec.created.push(spec)
            if (childCtxFactory) childContexts.set(spec.sessionId, childCtxFactory())
            const childSession = { id: spec.sessionId }
            return {
              agent: {
                session: childSession,
                followup: (message) => {
                  rec.forkFollowups.push({ child: spec.sessionId, message })
                  if (emitTurnEnd) {
                    if (turnReason?.kind === 'completed') {
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
                      handler(childSession, { type: 'turn/end', seq: 100, data: { turn: 1, reason: turnReason } })
                    }
                  }
                },
                whenIdle: whenIdle || (async () => {}),
              },
              dispose: async () => { rec.disposed.push(spec.sessionId) },
            }
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
            session: { cwd: path.join(home, 'proj'), agentPreset: 'coding' },
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

test('the same failed snapshot stops automatic re-forking after the failure cap', async () => {
  state.ensureSession('fork-failcap', { cwd: path.join(home, 'proj-failcap'), agentPreset: 'coding' })
  const ctx = host({ live: true, turnReason: { kind: 'error', error: { message: 'provider refused' } } })
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
  // 只挂 worker 真正用到的读写面（remember/update/link_suggest/list/recall/status）；
  // lexicon、private_link、archive/delete/unpin 这些用不到或破坏性的工具不进 worker 面。
  assert.deepEqual([...registered].sort(), ['memu_private_link_suggest', 'memu_private_list', 'memu_private_recall', 'memu_private_remember', 'memu_private_update', 'memu_status'])
  // 整理结束（finally）必须卸载挂载，不能给这条一次性 worker 留常驻注册。
  assert.deepEqual([...disposals].sort(), ['memu_private_link_suggest', 'memu_private_list', 'memu_private_recall', 'memu_private_remember', 'memu_private_update', 'memu_status'])
  // 全量挂载的活动元数据：attached=实际子集（此处=完整 wanted）、requested=完整 wanted、
  // partial=false。三件一起钉住"成功路径不再含糊"。
  const started = startedEntryFor(ctx, 'fork-ptc')
  assert.deepEqual([...started.detail.workerToolsAttached].sort(), ['memu_private_link_suggest', 'memu_private_list', 'memu_private_recall', 'memu_private_remember', 'memu_private_update', 'memu_status'])
  assert.deepEqual([...started.detail.workerToolsRequested].sort(), ['memu_private_link_suggest', 'memu_private_list', 'memu_private_recall', 'memu_private_remember', 'memu_private_update', 'memu_status'])
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
  assert.deepEqual([...registered].sort(), ['memu_private_link_suggest', 'memu_private_list', 'memu_private_recall', 'memu_private_update', 'memu_status'],
    'exactly the tools that actually registered are mounted')
  assert.deepEqual([...disposals].sort(), ['memu_private_link_suggest', 'memu_private_list', 'memu_private_recall', 'memu_private_update', 'memu_status'],
    'dispose unmounts exactly what was mounted')
  const started = startedEntryFor(ctx, 'fork-ptc-partial')
  assert.deepEqual([...started.detail.workerToolsAttached].sort(), ['memu_private_link_suggest', 'memu_private_list', 'memu_private_recall', 'memu_private_update', 'memu_status'],
    'the log records the actual subset, not the full wanted list')
  assert.deepEqual([...started.detail.workerToolsRequested].sort(), ['memu_private_link_suggest', 'memu_private_list', 'memu_private_recall', 'memu_private_remember', 'memu_private_update', 'memu_status'])
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
  assert.deepEqual([...started.detail.workerToolsRequested].sort(), ['memu_private_link_suggest', 'memu_private_list', 'memu_private_recall', 'memu_private_remember', 'memu_private_update', 'memu_status'])
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

// 超时预算按范围大小推：935 条事件那次实测「180 s 到点只写了 3 条，退避重试 131 s 完成」，
// 约 0.14–0.2 s/事件；政策取 0.35 s/事件（≈2 倍余量）并夹在 [180 s, 600 s]。
test('the consolidation wait budget scales with the transcript, not a fixed 180 s', () => {
  assert.equal(consolidationWaitBudget(0), CONSOLIDATION_WAIT_POLICY.minMs, 'an empty range still gets the floor')
  assert.equal(consolidationWaitBudget(100), 420_000, 'small sessions get the slow-reasoning floor')
  assert.equal(consolidationWaitBudget(200), 420_000)
  assert.equal(consolidationWaitBudget(935), 447_250, 'the session that timed out gets ~7.5 minutes')
  assert.equal(consolidationWaitBudget(5_000), CONSOLIDATION_WAIT_POLICY.maxMs, 'a wedged fork still dies inside ten minutes')
  assert.equal(consolidationWaitBudget(undefined), CONSOLIDATION_WAIT_POLICY.minMs)
  assert.equal(consolidationWaitBudget('not-a-number'), CONSOLIDATION_WAIT_POLICY.minMs)
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
