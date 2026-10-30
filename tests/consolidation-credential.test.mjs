import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-cons-credential-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const ledger = await import('../lib/consolidation-ledger.js')
const receipt = await import('../lib/consolidation-receipt.js')
const { requestPrivateConsolidation, isConsolidating } = await import('../lib/private.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function fence(json) {
  const tick = String.fromCharCode(96)
  return [tick + tick + tick + receipt.RECEIPT_TAG, JSON.stringify(json, null, 2), tick + tick + tick].join('\n')
}

function writeMemory(libraryId, id) {
  state.updatePrivateIndex(libraryId, (index) => {
    index.entries[id] = {
      title: '记忆 ' + id,
      content: '正文 ' + id,
      layer: 'long_term',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  })
}

// 真实宿主的四件事都在这里：agents.create 的顶层 inheritedEventCount、公共 session/event
// 事件流、request/header 里的工具表、以及可选的 observeSession 租约。
function host({
  live = true,
  requestConfig = { provider: 'test-provider', model: 'test-model' },
  headerTools = null,
  workerText = '',
  workerWrites = [],
  whenIdle = null,
  turnReason = { kind: 'completed' },
  events = null,
  observe = null,
  emitTurnEnd = true,
} = {}) {
  const rec = { created: [], handlers: [], followedUp: [], disposed: [] }
  const transcript = events || [
    { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '记住：我不吃香菜，另外别再提那件事' }] } },
    { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '记住了' }] } } },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ...(headerTools ? [{ seq: 3, type: 'request/header', data: { header: { config: requestConfig, tools: headerTools } } }] : []),
  ]
  const emit = (session, event) => { for (const handler of [...rec.handlers]) handler(session, event) }
  const parentLive = live ? { id: 'parent', session: { requestHeader: () => ({ config: requestConfig, ...(headerTools ? { tools: headerTools } : {}) }) } } : undefined
  const ctx = {
    rec,
    emit,
    parentLive,
    on: (name, handler) => {
      if (name !== 'session/event') return () => {}
      rec.handlers.push(handler)
      return () => {
        const index = rec.handlers.indexOf(handler)
        if (index >= 0) rec.handlers.splice(index, 1)
      }
    },
    get: (name) => {
      if (name === 'agents') {
        return {
          get: () => parentLive,
          create: async (spec) => {
            rec.created.push(spec)
            const childSession = { id: spec.sessionId }
            return {
              agent: {
                session: childSession,
                followup: (message) => {
                  rec.followedUp.push(message)
                  // 子会话的 binding 是在 create 之后才写入的，这里必须现取。
                  const childBinding = state.getSessionBinding(spec.sessionId)
                  for (const id of workerWrites) writeMemory(childBinding.libraryId, id)
                  if (workerText) {
                    const text = typeof workerText === 'function' ? workerText(childBinding) : workerText
                    emit(childSession, { type: 'assistant/message', seq: 90, data: { message: { content: [{ type: 'text', text }] } } })
                  }
                  if (emitTurnEnd) emit(childSession, { type: 'turn/end', seq: 91, data: { turn: 1, reason: turnReason } })
                },
                whenIdle: whenIdle || (async () => {}),
              },
              dispose: async () => { rec.disposed.push(spec.sessionId) },
            }
          },
        }
      }
      if (name === 'sessionQuery') {
        const query = {
          readSession: async () => ({ events: transcript, session: { cwd: path.join(home, 'proj'), agentPreset: 'standard' } }),
        }
        if (observe) query.observeSession = async () => observe
        return query
      }
      return undefined
    },
  }
  return ctx
}

// C 包第 6 条：写前重验父授权、凭证只认对账过的结果。

test('a verified receipt becomes the completion credential and advances the checked cursor', async () => {
  const sessionId = 'cred-ok'
  const binding = state.ensureSession(sessionId, { cwd: path.join(home, 'proj'), agentPreset: 'standard' })
  const ctx = host({
    workerWrites: ['mem-cred-1'],
    workerText: (child) => fence({ jobId: child.jobId, snapshotHash: child.snapshotHash, status: 'completed', outcome: 'created', createdIds: ['mem-cred-1'], updatedIds: [], heldIds: [], checkedRange: { fromSeq: 0, throughSeq: 2 } }),
  })
  const result = await requestPrivateConsolidation(ctx, sessionId, { force: true })
  assert.equal(result.ok, true)
  assert.equal(result.settled, true)
  assert.equal(result.status, 'completed')
  assert.equal(result.outcome, 'created')
  assert.deepEqual(result.createdIds, ['mem-cred-1'])
  assert.equal(result.receipt.status, 'completed')
  assert.equal(result.credential.checked.throughSeq, 2)
  assert.equal(result.wrote, 1)
  assert.equal(state.getSessionBinding(sessionId).lastSleepSeq, 2)
  assert.equal(ledger.sessionState(sessionId).checked.throughSeq, 2)
  assert.equal(ledger.sessionState(sessionId).inflight, null, 'a finished job releases its lease')
  assert.equal(state.getSessionBinding(ctx.rec.created[0].sessionId), null, 'disposed worker leaves no persistent child binding')
  assert.equal(ctx.rec.followedUp.length, 1)
  assert.equal(ctx.rec.disposed.length, 1)
})

test('a worker that reports but gives no receipt is a failure, not a success', async () => {
  const sessionId = 'cred-no-receipt'
  state.ensureSession(sessionId, { cwd: path.join(home, 'proj-nr'), agentPreset: 'standard' })
  const ctx = host({ workerText: '我把能记的都记下来了。' })
  const result = await requestPrivateConsolidation(ctx, sessionId, { force: true })
  assert.equal(result.ok, false)
  assert.equal(result.settled, false)
  assert.equal(result.reasonCode, 'receipt-missing')
  assert.match(result.error, /receipt/)
  assert.equal(state.getSessionBinding(sessionId).lastSleepSeq, undefined, 'without a credential the cursor must not advance')
  const job = ledger.sessionState(sessionId)
  assert.equal(job.checked, null)
  assert.equal(job.pending.throughSeq, 2, 'the range stays pending for the next attempt')
})

test('a receipt that cites a memory nobody wrote is rejected', async () => {
  const sessionId = 'cred-ghost'
  state.ensureSession(sessionId, { cwd: path.join(home, 'proj-ghost'), agentPreset: 'standard' })
  const ctx = host({
    workerText: (child) => fence({ jobId: child.jobId, snapshotHash: child.snapshotHash, status: 'completed', outcome: 'created', createdIds: ['mem-does-not-exist'], checkedRange: { fromSeq: 0, throughSeq: 2 } }),
  })
  const result = await requestPrivateConsolidation(ctx, sessionId, { force: true })
  assert.equal(result.ok, false)
  assert.equal(result.reasonCode, 'receipt-unverified')
  assert.match(result.error, /mem-does-not-exist/)
  assert.equal(state.getSessionBinding(sessionId).lastSleepSeq, undefined)
})

test('no closed turn on a live session defers instead of forking', async () => {
  const sessionId = 'cred-open-turn'
  state.ensureSession(sessionId, { cwd: path.join(home, 'proj-open'), agentPreset: 'standard' })
  const ctx = host({
    events: [
      { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这轮还没答完' }] } },
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
    ],
    observe: {
      source: 'live',
      header: { cwd: path.join(home, 'proj-open') },
      inheritedEventCount: 0,
      events: [
        { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这轮还没答完' }] } },
        { seq: 1, type: 'turn/start', data: { turn: 1 } },
      ],
      cursor: 1,
      [Symbol.dispose]: () => {},
    },
  })
  const result = await requestPrivateConsolidation(ctx, sessionId, { force: true })
  assert.equal(result.ok, true)
  assert.equal(result.settled, false)
  assert.equal(result.skipped, 'no-closed-turn')
  assert.equal(ctx.rec.created.length, 0, 'a half turn must not be seeded into a worker')
})

test('a tool surface without memory tools is unavailable, and nothing is forked', async () => {
  for (const [name, tools, reasonCode] of [
    ['missing', [{ name: 'read' }, { name: 'write' }], 'worker-tools-missing'],
  ]) {
    const sessionId = 'cred-tools-' + name
    state.ensureSession(sessionId, { cwd: path.join(home, 'proj-tools-' + name), agentPreset: 'standard' })
    const ctx = host({ headerTools: tools })
    const result = await requestPrivateConsolidation(ctx, sessionId, { force: true })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'unavailable')
    assert.equal(result.reasonCode, reasonCode)
    assert.match(result.error, /memu_private_remember/)
    assert.equal(ctx.rec.created.length, 0, 'no doomed fork is created')
    assert.equal(state.getSessionBinding(sessionId).lastSleepSeq, undefined)
  }
})

test('a PTC-only tool surface is not a refusal: the fork proceeds and only an honest receipt failure is reported', async () => {
  // 2026-10-31 口径变更：PTC 会话的 header 只有 run_code（或任意 PTC transport 名），
  // 其余工具走 run_code 程序里的 SDK 绑定 —— header 名单不承载"能不能写"。
  // 所以 PTC 不再产生 unavailable：fork 照常创建，写入能力由 scope 挂载与回执裁决。
  // 这个 fake 的 worker 不写回执，所以结果是一次诚实的 receipt-missing 失败，
  // 而不是"从不尝试"。
  const sessionId = 'cred-tools-ptc'
  state.ensureSession(sessionId, { cwd: path.join(home, 'proj-ptc'), agentPreset: 'standard' })
  const ctx = host({
    headerTools: [{ name: 'ptc_exec' }],
    events: [
      { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '用 PTC 跑一下' }] } },
      { seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { seq: 2, type: 'tool/ptc-dispatch', data: { name: 'ptc_exec' } },
      { seq: 3, type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' }, tools: [{ name: 'ptc_exec' }] } } },
    ],
  })
  const result = await requestPrivateConsolidation(ctx, sessionId, { force: true })
  assert.equal(ctx.rec.created.length, 1, 'a PTC surface no longer blocks the fork')
  assert.equal(result.ok, false)
  assert.equal(result.reasonCode, 'receipt-missing', 'the fake worker gave no receipt: an honest run failure, not a refusal')
  // 任务书按 PTC 口径写：点名 run_code transport 与 SDK 调用形态。
  const followup = ctx.rec.followedUp[0]
  const brief = Array.isArray(followup?.content)
    ? followup.content.map((block) => block?.text || '').join('\n')
    : String(followup || '')
  assert.match(brief, /run_code/)
  assert.match(brief, /tools\.memu_private_remember/)
})

test('a parent that changes its library mid-run voids the credential', async () => {
  const sessionId = 'cred-scope-change'
  const binding = state.ensureSession(sessionId, { cwd: path.join(home, 'proj-scope'), agentPreset: 'standard' })
  const other = state.ensureLibraryForCwd(path.join(home, 'proj-scope-other'))
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  const ctx = host({
    whenIdle: () => gate,
    workerWrites: ['mem-scope-1'],
    workerText: fence({ status: 'completed', outcome: 'created', createdIds: ['mem-scope-1'], checkedRange: { fromSeq: 0, throughSeq: 2 } }),
  })
  const running = requestPrivateConsolidation(ctx, sessionId, { force: true })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(isConsolidating(sessionId), true)
  // 用户在整理期间把会话切到另一个库：父会话自己发的 turn/start 就是这次的信号。
  state.setSessionBinding(sessionId, { libraryId: other.id })
  ctx.emit(ctx.parentLive.session, { type: 'turn/start', data: { turn: 2 } })
  release()
  const result = await running
  assert.equal(result.ok, false)
  assert.equal(result.reasonCode, 'parent-scope-changed')
  assert.equal(result.retryable, false)
  assert.equal(state.getSessionBinding(sessionId).lastSleepSeq, undefined)
  const job = ledger.sessionState(sessionId)
  assert.equal(job.checked, null, 'a credential from a stale authorization is worth nothing')
  assert.ok(binding.libraryId !== other.id)
})

test('a lease held in the ledger blocks a second run across a restart', async () => {
  const sessionId = 'cred-lease-held'
  const binding = state.ensureSession(sessionId, { cwd: path.join(home, 'proj-lease'), agentPreset: 'standard' })
  ledger.beginJob({ sessionId, jobId: 'ghost-job', snapshot: { hash: 'h', fromSeq: 0, throughSeq: 2, eventCount: 3 }, binding })
  const ctx = host({})
  const result = await requestPrivateConsolidation(ctx, sessionId, { force: true })
  assert.equal(result.ok, false)
  assert.equal(result.running, true)
  assert.equal(result.reasonCode, 'lease-held')
  assert.equal(ctx.rec.created.length, 0)
  assert.equal(ledger.sessionState(sessionId).inflight.jobId, 'ghost-job')
})

test('a ledger persistence failure never creates a worker', async () => {
  const sessionId = 'cred-ledger-unavailable'
  state.ensureSession(sessionId, { cwd: path.join(home, 'proj-ledger-failure'), agentPreset: 'standard' })
  const file = ledger.ledgerPath()
  const original = fs.existsSync(file) ? fs.readFileSync(file) : null
  const ctx = host({})
  try {
    fs.writeFileSync(file, '{broken-json')
    const result = await requestPrivateConsolidation(ctx, sessionId, { force: true })
    assert.equal(result.ok, false)
    assert.equal(result.reasonCode, 'ledger-unavailable')
    assert.equal(result.retryable, true)
    assert.equal(result.settled, false)
    assert.equal(ctx.rec.created.length, 0)
    assert.equal(state.getSessionBinding(sessionId).lastSleepSeq, undefined)
  } finally {
    if (original) fs.writeFileSync(file, original)
    else fs.rmSync(file, { force: true })
  }
})

test('a timeout leaves the range pending instead of pretending it was consolidated', async () => {
  const sessionId = 'cred-timeout'
  state.ensureSession(sessionId, { cwd: path.join(home, 'proj-timeout'), agentPreset: 'standard' })
  const ctx = host({ whenIdle: () => new Promise(() => {}), emitTurnEnd: false })
  const result = await requestPrivateConsolidation(ctx, sessionId, { force: true, maxWaitMs: 30 })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  const job = ledger.sessionState(sessionId)
  assert.equal(job.inflight, null)
  assert.equal(job.checked, null)
  assert.equal(job.pending.throughSeq, 2)
  assert.equal(job.lastReasonCode, 'timeout')
})

test('the same snapshot is not consolidated twice', async () => {
  const sessionId = 'cred-idempotent'
  state.ensureSession(sessionId, { cwd: path.join(home, 'proj-idem'), agentPreset: 'standard' })
  const ctx = host({
    workerWrites: ['mem-idem-1'],
    workerText: (child) => fence({ jobId: child.jobId, snapshotHash: child.snapshotHash, status: 'completed', outcome: 'created', createdIds: ['mem-idem-1'], checkedRange: { fromSeq: 0, throughSeq: 2 } }),
  })
  const first = await requestPrivateConsolidation(ctx, sessionId, { force: true })
  assert.equal(first.ok, true)
  const second = await requestPrivateConsolidation(ctx, sessionId, { force: true })
  assert.equal(second.ok, true)
  assert.equal(second.skipped, 'already-consolidated')
  assert.equal(second.settled, true)
  assert.equal(ctx.rec.created.length, 1, 'an unchanged snapshot is not paid for twice')
})