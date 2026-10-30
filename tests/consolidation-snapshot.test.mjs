import test from 'node:test'
import assert from 'node:assert/strict'

const { captureSessionSnapshot, safePrefix, toolPairing, lastClosedTurnSeq, snapshotHash } = await import('../lib/consolidation-snapshot.js')
const { probeToolSurface, lastHeaderTools, buildWorkerBrief } = await import('../lib/consolidation-worker.js')

// C 包第 1、2 条：安全前缀必须可解释。这里逐条钉住「什么算完整」，
// 因为把半步喂给 worker 的代价是它对没发生的事编出结论。

function turn(turnNo, step, extra = {}) {
  return [
    { seq: 0, type: 'turn/start', data: { turn: turnNo } },
    { seq: 1, type: 'step/start', data: { turn: turnNo, step } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我把 API key 放到 1password 了' }] } },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '收到' }] } } },
    { seq: 4, type: 'step/end', data: { turn: turnNo, step } },
    { seq: 5, type: 'turn/end', data: { turn: turnNo, reason: { kind: 'completed' } } },
  ].map((event) => ({ ...event, ...extra }))
}

function closeTurn(events, turnNo, base) {
  return [
    ...events,
    { seq: base, type: 'turn/start', data: { turn: turnNo } },
    { seq: base + 1, type: 'step/start', data: { turn: turnNo, step: 1 } },
    { seq: base + 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二轮：别删那条记忆' }] } },
    { seq: base + 3, type: 'step/end', data: { turn: turnNo, step: 1 } },
    { seq: base + 4, type: 'turn/end', data: { turn: turnNo, reason: { kind: 'completed' } } },
  ]
}

test('a live lease is cut at the last closed turn', () => {
  const events = [
    ...turn(1, 1),
    // 第二轮只开了头：turn/start + step/start + 一条真人消息，没有 turn/end。
    { seq: 6, type: 'turn/start', data: { turn: 2 } },
    { seq: 7, type: 'step/start', data: { turn: 2, step: 1 } },
    { seq: 8, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这句话还没答完' }] } },
  ]
  const safe = safePrefix(events, { requireClosedTurn: true })
  assert.equal(safe.ok, true)
  assert.equal(safe.throughSeq, 5, 'the open second turn is not part of the snapshot')
  assert.equal(safe.eventCount, 6)
  assert.equal(safe.dropped, 3)
})

test('a live transcript with no closed turn is deferred, not consolidated', () => {
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
  ]
  const safe = safePrefix(events, { requireClosedTurn: true })
  assert.equal(safe.ok, false)
  assert.equal(safe.reasonCode, 'no-closed-turn')
})

test('a tool call without its result is a half step and is trimmed', () => {
  const events = [
    ...turn(1, 1),
    { seq: 6, type: 'turn/start', data: { turn: 2 } },
    { seq: 7, type: 'step/start', data: { turn: 2, step: 1 } },
    { seq: 8, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'call-1', name: 'read' }] } } },
    { seq: 9, type: 'tool/call', data: { turn: 2, step: 1, callId: 'call-1', name: 'read', arguments: '{}' } },
    { seq: 10, type: 'step/end', data: { turn: 2, step: 1 } },
    { seq: 11, type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted' } } },
  ]
  const pairing = toolPairing(events)
  assert.equal(pairing.unpaired.length, 1)
  assert.equal(pairing.firstUnpairedSeq, 8)
  const safe = safePrefix(events, { requireClosedTurn: true })
  assert.equal(safe.ok, true)
  assert.equal(safe.throughSeq, 5, 'the turn whose call never resolved is dropped whole')
})

test('a paired tool call keeps its turn', () => {
  const events = [
    ...turn(1, 1),
    { seq: 6, type: 'turn/start', data: { turn: 2 } },
    { seq: 7, type: 'step/start', data: { turn: 2, step: 1 } },
    { seq: 8, type: 'tool/call', data: { turn: 2, step: 1, callId: 'call-1', name: 'read', arguments: '{}' } },
    { seq: 9, type: 'tool/result', data: { turn: 2, step: 1, message: { toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: 'ok' }], isError: false } } },
    { seq: 10, type: 'step/end', data: { turn: 2, step: 1 } },
    { seq: 11, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ]
  const safe = safePrefix(events, { requireClosedTurn: true })
  assert.equal(safe.ok, true)
  assert.equal(safe.throughSeq, 11)
  assert.equal(safe.pairing.unpaired, 0)
})

test('host tool result identities pair in both live and validated snapshot modes', async () => {
  for (const message of [
    { toolCallId: 'host-call', source: { kind: 'tool', callId: 'host-call' } },
    { source: { kind: 'tool', callId: 'host-call' } },
    { callId: 'host-call' },
  ]) {
    const events = [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'host-call', name: 'read' }] } } },
      { seq: 3, type: 'tool/call', data: { callId: 'host-call', name: 'read' } },
      { seq: 4, type: 'tool/result', data: { message: { ...message, content: [{ type: 'text', text: 'ok' }] } } },
      { seq: 5, type: 'step/end', data: { turn: 1, step: 1 } },
      { seq: 6, type: 'turn/end', data: { turn: 1 } },
    ]
    assert.equal(toolPairing(events).unpaired.length, 0)
    for (const requireClosedTurn of [true, false]) {
      const safe = safePrefix(events, { requireClosedTurn })
      assert.equal(safe.ok, true)
      assert.equal(safe.throughSeq, 6)
    }
    const captured = await captureSessionSnapshot(leaseHost({ events }), 'host-pair')
    assert.equal(captured.ok, true)
    assert.equal(captured.snapshot.throughSeq, 6)
    const unmatched = events.filter(event => event.type !== 'tool/result')
    assert.equal(toolPairing(unmatched).firstUnpairedSeq, 2)
    assert.equal(safePrefix(unmatched, { requireClosedTurn: true }).ok, false)
  }
})

test('a validated log keeps its full range but still drops a trailing step/start', () => {
  const events = [
    ...turn(1, 1),
    { seq: 6, type: 'turn/start', data: { turn: 2 } },
    { seq: 7, type: 'step/start', data: { turn: 2, step: 1 } },
  ]
  const safe = safePrefix(events, { requireClosedTurn: false })
  assert.equal(safe.ok, true)
  assert.equal(safe.throughSeq, 5, 'an open step at the tail is not part of the prefix')
  assert.equal(lastClosedTurnSeq(events), 5)
})

test('an empty transcript has nothing to snapshot', () => {
  assert.equal(safePrefix([], { requireClosedTurn: true }).reasonCode, 'no-events')
})

test('the snapshot hash is stable for the same range and changes with content', () => {
  const events = turn(1, 1)
  const a = snapshotHash(events, 0, 5)
  const b = snapshotHash(events, 0, 5)
  const c = snapshotHash([...events.slice(0, 5), { seq: 5, type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } }], 0, 5)
  const equalLength = snapshotHash(events.map((event) => event.type === 'user/message' ? { ...event, data: { ...event.data, content: [{ type: 'text', text: '同样长度' }] } } : event), 0, 5)
  assert.equal(a, b)
  assert.notEqual(a, c, 'a different last event means a different snapshot identity')
  assert.notEqual(a, equalLength, 'different equal-length event bodies must have different identities')
  assert.equal(a.length, 64, 'content-addressed sha256 of the canonical events')
})

// ---- captureSessionSnapshot：只用公开 API，缺能力就明确失败 ----

function leaseHost({ events, source = 'live', cursor = null, dispose = null, onObserve = null }) {
  const rec = { disposed: 0, projectionMode: null, readSessionCalls: 0 }
  return {
    rec,
    on: () => () => {},
    get: (name) => {
      if (name !== 'sessionQuery') return undefined
      return {
        observeSession: async (id, options) => {
          rec.projectionMode = options?.projectionMode ?? null
          if (onObserve) onObserve(id, options)
          return {
            source,
            header: { cwd: 'D:/proj', agentPreset: 'standard' },
            inheritedEventCount: 0,
            events,
            cursor: cursor === null ? (events.at(-1)?.seq ?? -1) : cursor,
            retain: () => ({ [Symbol.dispose]: () => {} }),
            [Symbol.dispose]: () => { rec.disposed += 1; dispose?.() },
          }
        },
        readSession: async () => { rec.readSessionCalls += 1; return { events, session: { cwd: 'D:/proj' } } },
      }
    },
  }
}

test('captureSessionSnapshot uses the public lease, pins the cut and disposes the lease', async () => {
  const events = turn(1, 1)
  const ctx = leaseHost({ events })
  const captured = await captureSessionSnapshot(ctx, 'sess-lease')
  assert.equal(captured.ok, true)
  assert.equal(captured.snapshot.source, 'lease-live')
  assert.equal(captured.snapshot.throughSeq, 5)
  assert.equal(captured.snapshot.eventCount, 6)
  assert.equal(captured.snapshot.cursor, 5)
  assert.equal(ctx.rec.projectionMode, 'none', 'raw events, not the model-visible projection')
  assert.equal(ctx.rec.disposed, 1, 'the lease is always released')
  assert.equal(ctx.rec.readSessionCalls, 0, 'a lease read must not fall back to a full log read')
})

test('a prepared lease is a balanced log, so it does not need a closed turn', async () => {
  const events = [
    { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我更喜欢简短回答' }] } },
    { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好' }] } } },
  ]
  const ctx = leaseHost({ events, source: 'prepared' })
  const captured = await captureSessionSnapshot(ctx, 'sess-prepared')
  assert.equal(captured.ok, true)
  assert.equal(captured.snapshot.source, 'lease-prepared')
  assert.equal(captured.snapshot.throughSeq, 1)
})

test('a live lease with an open turn is deferred instead of consolidated', async () => {
  const ctx = leaseHost({ events: [{ seq: 0, type: 'turn/start', data: { turn: 1 } }] })
  const captured = await captureSessionSnapshot(ctx, 'sess-open')
  assert.equal(captured.ok, false)
  assert.equal(captured.code, 'deferred')
  assert.equal(captured.reasonCode, 'no-closed-turn')
  assert.equal(ctx.rec.disposed, 1, 'a deferred read still releases the lease')
})

test('a host with readSession only is used as a validated log', async () => {
  const ctx = { on: () => () => {}, get: (name) => (name === 'sessionQuery'
    ? { readSession: async () => ({ events: turn(1, 1), session: { cwd: 'D:/p' }, inheritedEventCount: 0 }) }
    : undefined) }
  const captured = await captureSessionSnapshot(ctx, 'sess-legacy')
  assert.equal(captured.ok, true)
  assert.equal(captured.snapshot.source, 'validated-log')
  assert.equal(captured.snapshot.throughSeq, 5)
})

test('a host without any snapshot API is unavailable, not an empty success', async () => {
  const none = await captureSessionSnapshot({ on: () => () => {}, get: () => undefined }, 'sess-none')
  assert.equal(none.ok, false)
  assert.equal(none.code, 'unavailable')
  assert.equal(none.reasonCode, 'no-session-query')
  const partial = await captureSessionSnapshot({ on: () => () => {}, get: () => ({}) }, 'sess-partial')
  assert.equal(partial.reasonCode, 'no-snapshot-api')
})

test('a failing observeSession is a retryable failure with the host message', async () => {
  const ctx = { on: () => () => {}, get: () => ({ observeSession: async () => { throw new Error('SESSION_QUERY_PERSISTENCE_FAILED: disk gone') } }) }
  const captured = await captureSessionSnapshot(ctx, 'sess-boom')
  assert.equal(captured.ok, false)
  assert.equal(captured.code, 'failed')
  assert.match(captured.error, /disk gone/)
})

// ---- 工具面：标准 / PTC / 未知 三种都要能分辨 ----

const MEMU_TOOLS = [
  { name: 'memu_private_remember' },
  { name: 'memu_private_update' },
  { name: 'memu_private_recall' },
  { name: 'read' },
]

test('a standard header that lists memu_* tools proves the worker can write', () => {
  const events = [{ seq: 0, type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' }, tools: MEMU_TOOLS } } }]
  const probe = probeToolSurface({ ctx: null, sessionId: 's', events })
  assert.equal(probe.ok, true)
  assert.equal(probe.hasWrite, true)
  assert.equal(probe.source, 'header-event')
  assert.deepEqual(probe.tools, ['memu_private_remember', 'memu_private_update', 'memu_private_recall', 'read'])
})

test('a header without memory tools is unavailable rather than a silent wasted fork', () => {
  const events = [{ seq: 0, type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' }, tools: [{ name: 'read' }, { name: 'write' }] } } }]
  const probe = probeToolSurface({ ctx: null, sessionId: 's', events })
  assert.equal(probe.ok, false)
  assert.equal(probe.reasonCode, 'worker-tools-missing')
})

test('a PTC-only turn is not a refusal: the probe reports ptc and the SDK surface is checked at fork time', () => {
  // 2026-10-31 口径变更：PTC 模式下 header 只列 transport（这里 ptc_exec，真实宿主为
  // run_code），其余工具走 run_code 程序里的 SDK 绑定 —— header 名单不承载"能不能写"，
  // 不再产生 worker-tools-ptc-only 拒绝；fork 后由 attachWorkerTools 挂载读写工具。
  const events = [
    { seq: 0, type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' }, tools: [{ name: 'ptc_exec' }] } } },
    { seq: 1, type: 'tool/ptc-dispatch', data: { name: 'ptc_exec' } },
  ]
  const probe = probeToolSurface({ ctx: null, sessionId: 's', events })
  assert.equal(probe.ok, true, 'a PTC surface can never disprove write ability')
  assert.equal(probe.source, 'ptc-header')
  assert.equal(probe.ptcObserved, true)
  assert.equal(probe.hasWrite, null)
})

test('a run_code header alone (no dispatch events yet) is still recognized as PTC', () => {
  // 新 PTC 会话一次 run_code 都没跑过时也要认得出来：run_code 出现在名单里就是证据。
  const events = [{ seq: 0, type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' }, tools: [{ name: 'run_code' }] } } }]
  const probe = probeToolSurface({ ctx: null, sessionId: 's', events })
  assert.equal(probe.ok, true)
  assert.equal(probe.source, 'ptc-header')
  assert.equal(probe.ptcObserved, true)
})

test('a mixed surface (run_code beside native memu_*) proves write ability and keeps the PTC shape', () => {
  // 混合面：PTC transport 与原生 memu_* 同时出现在 header 名单（preset 部分列出本插件、
  // 或 PTC 与原生工具共存的会话）。probe 既不能当纯 PTC（hasWrite:null 会丢掉"名单里
  // 明摆着有写工具"的证据），也不能当普通名单（ptcObserved:false 会丢掉 PTC transport）。
  // hasWrite:true + ptcObserved:true 是钉住的口径；任务书（buildWorkerBrief）在混合面下
  // 既要列原生名单、又要带 run_code 的 SDK 调用形态——两种 transport 都覆盖。
  const events = [{
    seq: 0,
    type: 'request/header',
    data: { header: { config: { provider: 'p', model: 'm' }, tools: [{ name: 'run_code' }, ...MEMU_TOOLS] } },
  }]
  const probe = probeToolSurface({ ctx: null, sessionId: 's', events })
  assert.equal(probe.ok, true)
  assert.equal(probe.hasWrite, true, 'a native write tool in the list still proves write ability')
  assert.equal(probe.ptcObserved, true, 'run_code in the list is PTC evidence even beside native tools')
  assert.equal(probe.source, 'header-event')
  const brief = buildWorkerBrief({
    snapshot: { fromSeq: 0, throughSeq: 5, eventCount: 6, hash: 'mix001' },
    probe,
    contract: 'MIXED-CONTRACT',
  })
  assert.match(brief, /run_code, memu_private_remember, memu_private_update/, 'the brief lists the native names')
  assert.match(brief, /await tools\.memu_private_remember/, 'the brief keeps the PTC SDK invocation shape on a mixed surface')
  assert.match(brief, /MIXED-CONTRACT/)
})

test('a missing tool list is unknown, not a refusal', () => {
  const probe = probeToolSurface({ ctx: null, sessionId: 's', events: [{ seq: 0, type: 'request/header', data: { header: { config: {} } } }] })
  assert.equal(probe.ok, true)
  assert.equal(probe.source, 'unknown-tools')
  assert.equal(probe.tools, null)
  assert.equal(probeToolSurface({ ctx: null, sessionId: 's', events: [] }).source, 'unknown')
})

test('the live request header wins over an older logged one', () => {
  const ctx = {
    get: (name) => (name === 'agents' ? { get: () => ({ session: { requestHeader: () => ({ config: {}, tools: MEMU_TOOLS }) } }) } : undefined),
  }
  const events = [{ seq: 9, type: 'request/header', data: { header: { config: {}, tools: [{ name: 'read' }] } } }]
  const probe = probeToolSurface({ ctx, sessionId: 'live', events })
  assert.equal(probe.ok, true)
  assert.equal(probe.source, 'live-header')
})

test('lastHeaderTools folds to the latest header only', () => {
  const events = [
    { seq: 0, type: 'request/header', data: { header: { tools: [{ name: 'old' }] } } },
    { seq: 1, type: 'request/header', data: { header: { tools: MEMU_TOOLS } } },
  ]
  const folded = lastHeaderTools(events)
  assert.equal(folded.found, true)
  assert.ok(folded.tools.includes('memu_private_remember'))
  assert.equal(folded.tools.includes('old'), false)
})

test('the worker brief carries the range, the tools and the receipt contract', () => {
  const brief = buildWorkerBrief({
    snapshot: { fromSeq: 0, throughSeq: 41, eventCount: 42, hash: 'abc123' },
    probe: { tools: ['memu_private_remember', 'memu_private_recall'] },
    contract: 'RECEIPT-CONTRACT-MARKER',
    reason: 'manual',
    jobId: 'cons-1',
  })
  assert.match(brief, /不是这场对话里的角色/)
  assert.match(brief, /第 0 到第 41 条事件/)
  assert.match(brief, /快照 abc123/)
  assert.match(brief, /memu_private_remember/)
  assert.match(brief, /不写全局记忆/)
  assert.match(brief, /RECEIPT-CONTRACT-MARKER/)
  assert.match(brief, /手动/)
  assert.match(brief, /tools-unavailable/)
})