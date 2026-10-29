import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import sharp from 'sharp'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-inbound-'))
process.env.DSH_MEMU_HOME = home
const state = await import('../lib/state.js')
const inbound = await import('../lib/inbound.js')
const inject = await import('../lib/inject.js')
const memory = await import('../lib/memory.js')
const cycle = await import('../lib/cycle.js')
const budget = await import('../lib/budget.js')
test.after(() => { state.flushState(); fs.rmSync(home, { recursive: true, force: true }) })

function fixture(name) {
  const cwd = path.join(home, name)
  const binding = state.ensureSession(name, { cwd, agentPreset: 'coding' })
  const session = { header: { id: name, cwd, agentPreset: 'coding' } }
  const agent = { session, status: 'running' }
  state.setSessionBinding(name, { injectedIds: ['__anchor__'] })
  return { id: name, binding, session, agent, exec: { agent } }
}
function batch(id, text = '部署脚本在书店那台电脑上', extra = {}) {
  return { type: inbound.INBOUND_TYPE, version: 1, producer: 'transport.example', batchId: 'batch-' + id,
    messages: [{ id, role: 'user', content: [{ type: 'text', text }], ...extra }] }
}
function result(callId, value, meta) {
  return { type: 'tool/result', data: { turn: 1, step: 2, message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }, ...(meta ? { meta } : {}) } }
}
async function continueStep(f, step = 2, options = {}) {
  return inject.injectForStep({ agent: f.agent, decision: { kind: 'enter', messages: [] }, turn: 1, step, ...options })
}
function textOf(decision) { return decision.messages.flatMap(message => message.content || []).map(block => block.text || '').join('\n') }
async function saved(f, title = '部署脚本') {
  return memory.privateRemember({ exec: f.exec, title, content: '部署脚本放在 tools/deploy.ps1，传入 staging token。' })
}

test('a declared tool-result message batch recalls on step 2 without another user turn or model call', async () => {
  const f = fixture('meta')
  const entry = await saved(f)
  inbound.observeInboundEvent({}, f.session, result('wait-call', 'opaque presentation', { memoryInbound: batch('msg-1', '部署脚本在哪里') }))
  const out = await continueStep(f)
  assert.ok(textOf(out).includes(`[${entry.id}]`))
  assert.equal(out.messages[0].source.kind, 'plugin:dsh-memu-memory')
  assert.equal(out.messages[0].source.form, 'recall')
  assert.equal(state.getSessionBinding(f.id).inbound.pending.length, 0)
  assert.equal(state.getSessionBinding(f.id).lastInboundOutcome.injectedCount, 1)
  assert.ok(budget.estTokens(textOf(out)) <= state.getSettings().turnTokens)
  assert.deepEqual((await continueStep(f, 3)).messages, [], 'no new external input means no per-step injection')
})

test('inbound injection honors injectionTotalTokens even when turnTokens is larger', async () => {
  const f = fixture('total-budget')
  const previous = state.getSettings()
  state.updateSettings({ turnTokens: 800, injectionTotalTokens: 160, anchorTokens: 800, relevanceThreshold: 0, hybridRecall: false })
  try {
    const entry = await memory.privateRemember({
      exec: f.exec,
      title: '部署脚本',
      content: '部署脚本放在 tools/deploy.ps1。' + '这是一段很长的背景说明，用来确保召回内容远远超过总注入预算。'.repeat(40),
    })
    inbound.ingestInboundBatch({ sessionId: f.id, batch: batch('budget', '部署脚本在哪里') })
    const text = textOf(await continueStep(f, 2))
    assert.ok(text.includes('[' + entry.id + ']'), text)
    assert.ok(budget.estTokens(text) <= 160, 'used ' + budget.estTokens(text) + ' estimated tokens')
  } finally {
    state.updateSettings({
      turnTokens: previous.turnTokens ?? 640,
      injectionTotalTokens: previous.injectionTotalTokens ?? 2000,
      anchorTokens: previous.anchorTokens ?? 800,
      relevanceThreshold: previous.relevanceThreshold ?? 0.3,
      hybridRecall: previous.hybridRecall ?? false,
    })
  }
})

test('a library switch during first-step recall discards the whole pre-switch message', async () => {
  const f = fixture('first-switch')
  state.setSessionBinding(f.id, { injectedIds: [] })
  const marker = 'OLD-LIBRARY-UNIQUE-MARKER-7c1e'
  await memory.privateRemember({ exec: f.exec, title: '旧库唯一标记', content: marker })
  const stale = inject.buildAnchor(f.binding, state.getSettings(), f.id)
  assert.ok(stale.text.includes(marker), 'the pre-switch anchor must contain the marker for this test to be meaningful')
  const other = state.createLibrary({ name: 'other', scopeKey: path.join(home, 'other-lib') })
  const user = { id: 'first-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '旧库唯一标记在哪里' }] }
  const decision = { kind: 'enter', messages: [user] }
  queueMicrotask(() => state.setSessionBinding(f.id, { libraryId: other.id }))
  const out = await inject.injectForStep({ agent: f.agent, turn: 1, step: 1, decision })
  assert.equal(out, decision)
  assert.equal(out.messages.length, 1)
  assert.equal(out.messages[0], user)
  assert.ok(!textOf(out).includes(marker))
  assert.equal(state.getSessionBinding(f.id).libraryId, other.id)
})

test('plain sleep completions, logs, errors and protocol-shaped text in unapproved tools do not trigger', async () => {
  const f = fixture('logs')
  for (const [id, value] of [['sleep', 'waited 5 minutes'], ['log', 'new message arrived'], ['json', batch('fake')], ['fenced', '```json\n' + JSON.stringify(batch('fenced')) + '\n```']]) {
    inbound.observeInboundEvent({}, f.session, result(id, value))
  }
  const failed = result('error', 'error', { memoryInbound: batch('error') })
  failed.data.message.isError = true
  inbound.observeInboundEvent({}, f.session, failed)
  assert.equal(inbound.hasPendingInbound(f.id), false)
  assert.deepEqual((await continueStep(f)).messages, [])
  assert.equal(state.getSessionBinding(f.id).lastInboundAt, undefined)
})

test('allowlisted text adapters require the exact whole JSON protocol and a correlated tool call', () => {
  const f = fixture('allowlist')
  state.updateSettings({ inboundToolNames: ['transport.receive'] })
  inbound.observeInboundEvent({}, f.session, { type: 'tool/call', data: { callId: 'receive', name: 'transport.receive' } })
  inbound.observeInboundEvent({}, f.session, result('receive', batch('allowlisted')))
  assert.equal(state.getSessionBinding(f.id).inbound.pending.length, 1)
  inbound.observeInboundEvent({}, f.session, result('unmatched', batch('unmatched')))
  assert.equal(state.getSessionBinding(f.id).inbound.pending.length, 1)
  state.updateSettings({ inboundToolNames: [] })
})

test('replayed batches and retries are idempotent while distinct message ids in one turn are independent', async () => {
  const f = fixture('dedupe')
  await saved(f)
  const first = batch('same', '部署脚本在哪里')
  assert.equal(inbound.ingestInboundBatch({ sessionId: f.id, batch: first }).accepted, 1)
  assert.equal(inbound.ingestInboundBatch({ sessionId: f.id, batch: first }).accepted, 0)
  await continueStep(f)
  assert.equal(inbound.ingestInboundBatch({ sessionId: f.id, batch: { ...first, batchId: 'different-batch-id' } }).accepted, 0)
  assert.equal(inbound.ingestInboundBatch({ sessionId: f.id, batch: batch('second', '部署脚本在哪里') }).accepted, 1)
  await continueStep(f, 3)
  assert.equal(state.getSessionBinding(f.id).inbound.clock, 2)
})

test('dedupe expires by logical message batches even when the physical turn stays 1', async () => {
  const f = fixture('clock')
  const entry = await saved(f)
  state.updateSettings({ dedupeTurns: 2, globalEveryNTurns: 2 })
  try {
    inbound.ingestInboundBatch({ sessionId: f.id, batch: batch('a', '部署脚本在哪里') })
    assert.ok(textOf(await continueStep(f, 2)).includes(entry.id))
    inbound.ingestInboundBatch({ sessionId: f.id, batch: batch('b', '部署脚本在哪里') })
    assert.ok(!textOf(await continueStep(f, 3)).includes(entry.id))
    inbound.ingestInboundBatch({ sessionId: f.id, batch: batch('c', '部署脚本在哪里') })
    assert.ok(textOf(await continueStep(f, 4)).includes(entry.id))
  } finally { state.updateSettings({ dedupeTurns: 16, globalEveryNTurns: 6 }) }
})

test('real user inbox messages admitted on a later step work without a tool adapter', async () => {
  const f = fixture('native')
  const entry = await saved(f)
  const user = { id: 'late-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '部署脚本在哪里' }] }
  const decision = { kind: 'enter', messages: [user] }
  const out = await inject.injectForStep({ agent: f.agent, turn: 1, step: 7, decision })
  assert.equal(out.messages[0], user, 'do not rewrite or disguise the producer message')
  assert.ok(textOf(out).includes(entry.id))
  const again = await inject.injectForStep({ agent: f.agent, turn: 1, step: 8, decision })
  assert.equal(again, decision)
})

test('normal first-step input is acknowledged and not replayed as an external batch', async () => {
  const f = fixture('first')
  const user = { id: 'normal-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '部署脚本在哪里' }] }
  inbound.observeInboundEvent({}, f.session, { seq: 1, type: 'user/message', data: user })
  await inject.injectForStep({ agent: f.agent, turn: 1, step: 1, decision: { kind: 'enter', messages: [user] } })
  assert.equal(inbound.hasPendingInbound(f.id), false)
  assert.deepEqual((await continueStep(f)).messages, [])
})

test('continuation image references are saved and disclosed before the next model step without fabricating a user event', async () => {
  const f = fixture('image')
  const data = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#48996e' } }).png().toBuffer()
  const sha = crypto.createHash('sha256').update(data).digest('hex')
  const ref = { attachmentId: 'opaque-host-id', mediaType: 'image/png', bytes: data.length, width: 16, height: 16 }
  let reads = 0
  const ctx = { get: name => name === 'attachments' ? { readImage: async () => { reads++; return { data, ref } } } : undefined }
  const input = batch('photo', '这张图是绿色色卡', { content: [{ type: 'text', text: '这张图是绿色色卡' }, { type: 'image', attachment: ref }] })
  inbound.ingestInboundBatch({ sessionId: f.id, session: f.session, ctx, batch: input })
  const out = await continueStep(f, 4, { ctx })
  assert.ok(fs.existsSync(path.join(home, 'attachments', f.binding.libraryId, sha + '.png')))
  assert.ok(textOf(out).includes(sha))
  assert.ok(textOf(out).includes('</memory-media>'))
  await continueStep(f, 5, { ctx })
  assert.equal(reads, 1, 'pending-media capture and pre-step draining share the same event id')
  const note = await memory.privateRemember({ exec: f.exec, title: '色卡', content: '收到绿色色卡。', attachments: [{ sha256: sha }] })
  assert.equal(note.entry.attachments[0].missing, false)
})

test('channel/world boundaries cannot be widened and assistant/log records cannot be declared as humans', () => {
  const f = fixture('scope')
  state.setSessionBinding(f.id, { memoryContext: { channelId: 'room-a', worldId: 'story-a' } })
  assert.throws(() => inbound.ingestInboundBatch({ sessionId: f.id, batch: batch('wrong', 'text', { context: { channelId: 'room-b' } }) }), /outside/)
  assert.throws(() => inbound.ingestInboundBatch({ sessionId: f.id, batch: batch('assistant', 'text', { role: 'assistant' }) }), /human/)
  assert.equal(inbound.hasPendingInbound(f.id), false)
})

test('same message ids from distinct explicit speakers are not collapsed', () => {
  const f = fixture('speakers')
  const input = batch('same-id')
  input.messages = ['a', 'b'].map(speakerId => ({ ...input.messages[0], context: { speakerId } }))
  assert.equal(inbound.ingestInboundBatch({ sessionId: f.id, batch: input }).accepted, 2)
})

test('queues are bounded and overflow does not silently discard messages', () => {
  const f = fixture('bounded')
  const input = batch('q')
  input.messages = Array.from({ length: 32 }, (_, i) => ({ ...input.messages[0], id: 'id-' + i }))
  inbound.ingestInboundBatch({ sessionId: f.id, batch: input })
  assert.throws(() => inbound.ingestInboundBatch({ sessionId: f.id, batch: batch('overflow') }), /queue is full/)
  assert.equal(state.getSessionBinding(f.id).inbound.pending.length, 32)
  assert.throws(() => inbound.normalizeInboundBatch(batch('long', 'x'.repeat(4001))), /4000/)
})

test('disabled memory does not capture image bytes or inject on continuation steps', async () => {
  const f = fixture('disabled')
  state.setSessionBinding(f.id, { useLibrary: false, useGlobal: false })
  let reads = 0
  const ctx = { get: () => ({ readImage: () => { reads++; throw new Error('must not read') } }) }
  inbound.ingestInboundBatch({ sessionId: f.id, ctx, batch: batch('off', '', { content: [{ type: 'image', attachment: {
    attachmentId: 'disabled-image', mediaType: 'image/png', bytes: 10, width: 8, height: 8,
  } }] }) })
  assert.deepEqual((await continueStep(f, 2, { ctx })).messages, [])
  assert.equal(reads, 0)
  assert.equal(state.getSessionBinding(f.id).inbound.pending.length, 0)
})

test('retrieval errors stay fail-open, preserve the batch and use a retry delay', async () => {
  const f = fixture('retry')
  state.updateSettings({ memoryBackend: 'api' })
  try {
    inbound.ingestInboundBatch({ sessionId: f.id, batch: batch('retry', '部署脚本在哪里') })
    assert.deepEqual((await continueStep(f)).messages, [])
    assert.equal(state.getSessionBinding(f.id).inbound.pending.length, 1)
    assert.ok(state.getSessionBinding(f.id).lastRecallError)
    assert.equal(inbound.hasPendingInbound(f.id), false)
    state.updateSettings({ memoryBackend: 'agent' })
    const current = state.getSessionBinding(f.id)
    state.setSessionBinding(f.id, { inbound: { ...current.inbound, retryAt: null } })
    await saved(f)
    const out = await continueStep(f, 3)
    assert.ok(textOf(out).includes('tools/deploy.ps1'))
    assert.equal(state.getSessionBinding(f.id).inbound.pending.length, 0)
  } finally { state.updateSettings({ memoryBackend: 'agent' }) }
})

test('rejected steps, cancelled requests and subagents leave queued input untouched', async () => {
  const f = fixture('admission')
  inbound.ingestInboundBatch({ sessionId: f.id, batch: batch('pending') })
  const rejected = { kind: 'reject' }
  assert.equal(await inject.injectForStep({ agent: f.agent, decision: rejected, step: 2 }), rejected)
  assert.deepEqual((await continueStep(f, 2, { signal: { aborted: true } })).messages, [])
  const child = { session: { header: { ...f.session.header, origin: 'subagent' } } }
  assert.deepEqual((await inject.injectForStep({ agent: child, decision: { kind: 'enter', messages: [] }, step: 2 })).messages, [])
  assert.equal(state.getSessionBinding(f.id).inbound.pending.length, 1)
})

test('a long-running tool prevents sleep consolidation even after the idle threshold', async () => {
  const f = fixture('waiting')
  state.updateSettings({ sleepConsolidation: true, sleepAfterIdleMinutes: 8 })
  state.setSessionBinding(f.id, { lastTurnAt: new Date(Date.now() - 60 * 60_000).toISOString() })
  const out = await cycle.runSleepPass({ get: name => name === 'agents' ? { get: id => id === f.id ? f.agent : null } : null })
  assert.equal(out.ran, 0)
  assert.equal(state.getSessionBinding(f.id).lastSleepAt, undefined)
  assert.equal(state.getSessionBinding(f.id).sleepAttempts, undefined, 'must not try to fork while the parent is running')
})

test('real inbound activity refreshes the idle clock, but empty polls and replay do not', () => {
  const f = fixture('activity')
  const at = Date.now() - 60_000
  inbound.ingestInboundBatch({ sessionId: f.id, batch: batch('active'), now: at })
  const stamp = state.getSessionBinding(f.id).lastTurnAt
  inbound.ingestInboundBatch({ sessionId: f.id, batch: { ...batch('empty'), messages: [] }, now: at + 1000 })
  inbound.ingestInboundBatch({ sessionId: f.id, batch: batch('active'), now: at + 2000 })
  assert.equal(state.getSessionBinding(f.id).lastTurnAt, stamp)
})

test('different producers may reuse an external message id without losing either message', () => {
  const f = fixture('producers')
  inbound.ingestInboundBatch({ sessionId: f.id, batch: batch('shared-id') })
  assert.equal(inbound.ingestInboundBatch({ sessionId: f.id, batch: { ...batch('shared-id'), producer: 'other.transport' } }).accepted, 1)
})

test('messages received during media draining stay queued for the next admission', async () => {
  const f = fixture('concurrent')
  const data = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#48996e' } }).png().toBuffer()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const ref = { attachmentId: 'concurrent-image', mediaType: 'image/png', bytes: data.length, width: 8, height: 8 }
  const ctx = { get: () => ({ readImage: async () => { await gate; return { data, ref } } }) }
  inbound.ingestInboundBatch({ sessionId: f.id, session: f.session, ctx, batch: batch('first-image', '', { content: [{ type: 'image', attachment: ref }] }) })
  const first = continueStep(f, 2, { ctx })
  inbound.ingestInboundBatch({ sessionId: f.id, batch: batch('later-text') })
  release()
  await first
  assert.deepEqual(state.getSessionBinding(f.id).inbound.pending.map(item => item.id), ['later-text'])
  await continueStep(f, 3, { ctx })
  assert.equal(state.getSessionBinding(f.id).inbound.pending.length, 0)
})

test('restored pending batches drain on a first step even with no native user message', async () => {
  const f = fixture('restore')
  const entry = await saved(f)
  inbound.ingestInboundBatch({ sessionId: f.id, batch: batch('restored', '部署脚本在哪里') })
  state.flushState()
  state.clearCaches()
  const out = await continueStep(f, 1)
  assert.ok(textOf(out).includes(entry.id))
  assert.equal(state.getSessionBinding(f.id).inbound.pending.length, 0)
})

test('global cadence advances by external batches and not by tool-loop steps', async () => {
  const f = fixture('global-clock')
  state.setSessionBinding(f.id, { useLibrary: false, domainOverride: 'coding' })
  state.updateSettings({ globalEveryNTurns: 2 })
  state.saveGlobalIndex({ entries: {
    'gmem-transport': { title: 'Unique Neptune Global', content: 'Neptune build convention', domain: 'coding', status: 'active' },
  } })
  try {
    for (const [id, query, step] of [['g1', 'unrelated ordinary words', 2], ['g2', 'Unique Neptune Global', 3]]) {
      inbound.ingestInboundBatch({ sessionId: f.id, batch: batch(id, query) })
      const out = await continueStep(f, step)
      if (step === 3) assert.ok(textOf(out).includes('gmem-transport'))
    }
    assert.equal(state.getSessionBinding(f.id).inbound.clock, 2)
    await continueStep(f, 4)
    assert.equal(state.getSessionBinding(f.id).inbound.clock, 2)
  } finally {
    state.saveGlobalIndex({ entries: {} })
    state.updateSettings({ globalEveryNTurns: 6 })
  }
})

test('public event hooks recognize declared result metadata and record idle transitions', async () => {
  const f = fixture('hooks')
  const entry = await saved(f)
  const handlers = new Map()
  const ctx = { on: (name, handler) => { handlers.set(name, handler); return () => {} }, logger: { warn() {} }, inject() {} }
  const dispose = inject.registerInjection(ctx)
  try {
    await handlers.get('session/event')(f.session, result('hook-tool', 'result', { memoryInbound: batch('hook-message', '部署脚本在哪里') }))
    const decision = { kind: 'enter', messages: [] }
    const out = await handlers.get('agent/pre-step')({ agent: f.agent, turn: 1, step: 2 }, async () => decision)
    assert.ok(textOf(out).includes(entry.id))
    handlers.get('agent/status')({ agent: f.agent, status: 'idle' })
    assert.ok(state.getSessionBinding(f.id).lastAgentIdleAt)
    await handlers.get('session/event')(f.session, result('bad-tool', 'bad', { memoryInbound: { type: inbound.INBOUND_TYPE, version: 1 } }))
    assert.ok(state.getSessionBinding(f.id).lastInboundError, 'a malformed producer contract is visible but does not crash the host')
  } finally { dispose() }
})

test('sidebar snapshots never ship pending human text or the dedupe ledger', async () => {
  const f = fixture('sidebar-projection')
  const { dispatch } = await import('../lib/rpc.js')
  const phrase = 'pending human body must not ship in a sidebar snapshot'
  inbound.ingestInboundBatch({ sessionId: f.id, batch: batch('private-pending', phrase) })
  const result = await dispatch({}, 'getSidebarState', { sessionId: f.id })
  assert.equal(result.binding.inbound.pendingCount, 1)
  assert.equal(result.binding.inbound.pending, undefined)
  assert.equal(result.binding.inbound.seen, undefined)
  assert.ok(!JSON.stringify(result).includes(phrase))
})

test('the UI RPC persists the tool allowlist and rejects invalid names', async () => {
  const { dispatch } = await import('../lib/rpc.js')
  try {
    await dispatch({}, 'setSettings', { patch: { inboundToolNames: ['transport.receive', 'notifications.poll'] } })
    state.flushState()
    state.clearCaches()
    assert.deepEqual(state.getSettings().inboundToolNames, ['transport.receive', 'notifications.poll'])
    await assert.rejects(dispatch({}, 'setSettings', { patch: { inboundToolNames: ['bad tool name'] } }), /invalid inbound tool/)
  } finally { state.updateSettings({ inboundToolNames: [] }) }
})

test('switching libraries while image collection waits cannot publish old-batch memory in the new library', async () => {
  const f = fixture('switch-library')
  const data = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#48996e' } }).png().toBuffer()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const ref = { attachmentId: 'old-library-image', mediaType: 'image/png', bytes: data.length, width: 8, height: 8 }
  const ctx = { get: () => ({ readImage: async () => { await gate; return { data, ref } } }) }
  inbound.ingestInboundBatch({ sessionId: f.id, session: f.session, ctx, batch: batch('old-image', '', { content: [{ type: 'image', attachment: ref }] }) })
  const collecting = continueStep(f, 2, { ctx })
  const other = state.createLibrary({ name: 'other', cwd: path.join(home, 'other-library') })
  state.setSessionBinding(f.id, { libraryId: other.id })
  release()
  assert.deepEqual((await collecting).messages, [])
  assert.ok(!(state.getSessionBinding(f.id).pendingMedia || []).some(item => item.sourceAttachmentId === ref.attachmentId))
  assert.deepEqual((await continueStep(f, 3, { ctx })).messages, [])
  assert.equal(state.getSessionBinding(f.id).lastInboundOutcome.reason, 'scope')
})
