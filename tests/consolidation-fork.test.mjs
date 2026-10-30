import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-fork-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const activity = await import('../lib/activity-log.js')
const { requestPrivateConsolidation, isConsolidating } = await import('../lib/private.js')

test.after(() => {
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

function host({ live = false, whenIdle = null, parentOptions = { provider: 'test-provider', model: 'test-model' }, requestConfig = null, extraEvents = [], transcriptSize = 0, turnReason = { kind: 'completed' }, emitTurnEnd = true, headerTools = null, childCtxFactory = null } = {}) {
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
                      const throughSeq = 2 + extraEvents.length + padding
                      for (const handler of rec.sessionHandlers) {
                        handler(childSession, { type: 'assistant/message', seq: 99, data: { message: { content: [{ type: 'text', text: receiptFence({ fromSeq: 0, throughSeq }, state.getSessionBinding(spec.sessionId)) }] } } })
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
  assert.equal(spec.inheritedEventCount, 5, 'the header events are part of the inherited log')
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
  assert.equal(result.settled, false, 'nothing was consolidated, so the cursor must not move')
  assert.equal(ctx.rec.created.length, 0, 'no fork when the pending increment has no evidence')
  assert.equal(state.getSessionBinding('fork-large-thin').lastSleepSeq, 5905, 'the cursor must not advance')
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
// ---------------------------------------------------------------- PTC 兼容
// 现场（2026-10-31，yuike-ptc 会话）：PTC 模式下 request/header 的工具表只有 run_code，
// probe 曾据此判 unavailable（worker-tools-ptc-only），PTC 会话永远不被整理。宿主的
// PTC executor 明确 "only run_code is directly callable"，其余工具走 run_code 程序里的
// SDK 绑定（tools.schemas(agent, toolSet) 枚举可见面）—— header 名单在 PTC 会话里
// 不承载"能不能写记忆"。修复后：PTC 不构成否证 + fork 时把读写四件挂进 worker 自己的
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
  // 只挂读写四件；archive/delete/unpin 这些破坏性工具不得进 worker 的工具面。
  assert.deepEqual([...registered].sort(), ['memu_private_list', 'memu_private_recall', 'memu_private_remember', 'memu_private_update'])
  // 整理结束（finally）必须卸载挂载，不能给这条一次性 worker 留常驻注册。
  assert.deepEqual([...disposals].sort(), ['memu_private_list', 'memu_private_recall', 'memu_private_remember', 'memu_private_update'])
  // 全量挂载的活动元数据：attached=实际子集（此处=完整 wanted）、requested=完整 wanted、
  // partial=false。三件一起钉住"成功路径不再含糊"。
  const started = startedEntryFor(ctx, 'fork-ptc')
  assert.deepEqual([...started.detail.workerToolsAttached].sort(), ['memu_private_list', 'memu_private_recall', 'memu_private_remember', 'memu_private_update'])
  assert.deepEqual([...started.detail.workerToolsRequested].sort(), ['memu_private_list', 'memu_private_recall', 'memu_private_remember', 'memu_private_update'])
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
  // 逐件 fail-open，其余三件照常挂上。活动日志必须记实际子集 + requested + partial，
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
  assert.deepEqual([...registered].sort(), ['memu_private_list', 'memu_private_recall', 'memu_private_update'],
    'exactly the tools that actually registered are mounted')
  assert.deepEqual([...disposals].sort(), ['memu_private_list', 'memu_private_recall', 'memu_private_update'],
    'dispose unmounts exactly what was mounted')
  const started = startedEntryFor(ctx, 'fork-ptc-partial')
  assert.deepEqual([...started.detail.workerToolsAttached].sort(), ['memu_private_list', 'memu_private_recall', 'memu_private_update'],
    'the log records the actual subset, not the full wanted list')
  assert.deepEqual([...started.detail.workerToolsRequested].sort(), ['memu_private_list', 'memu_private_recall', 'memu_private_remember', 'memu_private_update'])
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
  assert.deepEqual([...started.detail.workerToolsRequested].sort(), ['memu_private_list', 'memu_private_recall', 'memu_private_remember', 'memu_private_update'])
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
