// Issue #4 / #5（dsh-memu-memory#4、#5）的 sweep 全链路模拟：
//   #5  冷掉的 inbound.pending 残骸不再永久阻断空闲整理，热队列仍然让路；
//   #4-1 snapshot-failed 熔断不再返回 settled:true（游标不推平、错误不清零）、
//        冻结期内活动日志去重、冷却到期自动放行真实重试；
//   #4-2 多窗整理 remaining>0 时粗游标不推平，尾段 <200 事件由下一扫收口；
//   #4-3 归档会话在候选阶段事前跳过，手动整理返回明确的 session-archived。
// 全部走 runSleepPass → requestPrivateConsolidation → fork → 回执 → 账本 的真实链路。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-sweep-issues-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const cycle = await import('../lib/cycle.js')
const privateLib = await import('../lib/private.js')
const ledger = await import('../lib/consolidation-ledger.js')
const activityLog = await import('../lib/activity-log.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function touchAgo(sessionId, minutesAgo) {
  state.setSessionBinding(sessionId, { lastTurnAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() })
}

// 与 cycle.test.mjs 的 fakeCtx 同款，外加三个旋钮：
//   receipts: 'full'（回执覆盖整段转录，默认）/ 'window'（回执只覆盖本窗种子，
//     用来模拟多窗的第一窗）/ 'error'（turn 以 error 收尾，走 failJob 退避）。
//   archived: 宿主 workspaceRegistry 的 archivedSessionIds。
//   events: 会话转录（默认一段最小真人对话）。
function fakeCtx({ live = [], receipts = 'full', archived = [], events = null, inbound = {} } = {}) {
  const liveSet = new Set(live)
  const created = []
  const disposed = []
  const forkFollowups = []
  const sessionHandlers = []
  const transcript = events || [
    { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我看一下这个插件为什么空闲整理从来没跑过，日志里只有 skip 一行' }] } },
    { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '排查结果：inbound 队列里留着召回异常的残骸，把会话挡住了。' }] } } },
    { seq: 2, type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
  ]
  const ctx = {
    created, disposed, forkFollowups,
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
            ? { options: { provider: 'test-provider', model: 'test-model' } }
            : undefined),
          create: async (spec) => {
            created.push(spec)
            const childSession = { id: spec.sessionId }
            return {
              agent: {
                session: childSession,
                followup: (message) => {
                  forkFollowups.push({ child: spec.sessionId, message })
                  if (receipts === 'error') {
                    for (const handler of sessionHandlers) {
                      handler(childSession, { type: 'assistant/message', seq: 99, data: { message: { content: [{ type: 'text', text: 'worker turn blew up' }] } } })
                      handler(childSession, { type: 'turn/end', seq: 100, data: { turn: 1, reason: { kind: 'error', error: { message: 'the fork turn ended error: simulated' } } } })
                    }
                    return
                  }
                  // 回执的 checkedRange：full = 整段转录；window = 本窗（多窗第一窗）。
                  // 窗口边界用与 private.js 相同的 selectConsolidationWindow 计算——
                  // seed.lastSeq 只是最后一个「对话」事件的 seq（todo/write 不进 seed），
                  // 不是窗口边界。
                  const childBinding = state.getSessionBinding(spec.sessionId)
                  const throughSeq = receipts === 'window'
                    ? privateLib.selectConsolidationWindow(transcript, privateLib.CONSOLIDATION_WINDOW_EVENTS).throughSeq
                    : transcript[transcript.length - 1].seq
                  const proof = {
                    version: 1,
                    jobId: childBinding.jobId,
                    snapshotHash: childBinding.snapshotHash,
                    status: 'completed',
                    outcome: 'no_value',
                    checkedRange: { fromSeq: spec.seed?.fromSeq ?? 0, throughSeq },
                    createdIds: [], updatedIds: [], heldIds: [],
                  }
                  const tick = '```'
                  for (const handler of sessionHandlers) {
                    handler(childSession, { type: 'assistant/message', seq: 99, data: { message: { content: [{ type: 'text', text: tick + 'memu-consolidation-receipt\n' + JSON.stringify(proof) + '\n' + tick }] } } })
                    handler(childSession, { type: 'turn/end', seq: 100, data: { turn: 1, reason: { kind: 'completed' } } })
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
          readSession: async () => ({ events: transcript, session: { cwd: path.join(home, 'p'), agentPreset: 'rp' } }),
        }
      }
      if (name === 'workspaceRegistry') return { archivedSessionIds: archived }
      return undefined
    },
  }
  return ctx
}

function ensureIdle(id, { minutesAgo = 60, inbound = null, lastInboundMinutesAgo = null } = {}) {
  state.ensureSession(id, { cwd: path.join(home, 'p-' + id), agentPreset: 'rp' })
  touchAgo(id, minutesAgo)
  if (inbound) {
    const ago = (m) => new Date(Date.now() - m * 60_000).toISOString()
    state.setSessionBinding(id, {
      inbound,
      ...(lastInboundMinutesAgo !== null ? {
        lastInboundAt: ago(lastInboundMinutesAgo),
        lastInboundOutcome: { reason: 'error', at: ago(lastInboundMinutesAgo), count: inbound.pending.length, injectedCount: 0 },
      } : {}),
    })
  }
}

// 失败后的两条退避时钟都清掉（binding.sleepRetryAt + 账本 entry.retryAt），
// 让下一扫立刻有资格再次进入，模拟「退避到期后」的时序。
function clearBackoffs(sessionId) {
  state.setSessionBinding(sessionId, { sleepRetryAt: null, sleepAttempts: 0 })
  patchLedger(sessionId, (entry) => { entry.retryAt = null })
}

// 直接编辑 consolidation.json（mutateLedger 未导出；测试只改自家临时目录里的文件）。
function patchLedger(sessionId, patch) {
  const file = ledger.ledgerPath()
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  patch(raw.sessions[sessionId])
  fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')
}

// —— Issue #5：inbound.pending 热窗 ——

test('issue #5: a hot inbound queue still defers the sweep', async () => {
  state.updateSettings({ sleepConsolidation: true, sleepAfterIdleMinutes: 10 })
  ensureIdle('issue5-hot', { minutesAgo: 30, inbound: { pending: [{ key: 'k1' }], retryAt: new Date(Date.now() + 20_000).toISOString() }, lastInboundMinutesAgo: 1 })
  const out = await cycle.runSleepPass(fakeCtx({ live: ['issue5-hot'] }))
  assert.equal(out.ran, 0)
  assert.equal(out.considered, 0, 'a hot queue is skipped at the candidate stage, without entering private.js')
  assert.equal(state.getLastSleepAt('issue5-hot'), null)
})

test('issue #5: cold queue residue no longer blocks idle consolidation forever', async () => {
  state.updateSettings({ sleepConsolidation: true, sleepAfterIdleMinutes: 10 })
  ensureIdle('issue5-cold', { minutesAgo: 30, inbound: { pending: [{ key: 'k1' }, { key: 'k2' }, { key: 'k3' }], retryAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() }, lastInboundMinutesAgo: 3 * 60 })
  const ctx = fakeCtx({ live: ['issue5-cold'] })
  const out = await cycle.runSleepPass(ctx, { limit: 10 })
  assert.equal(out.ran, 1, 'the residue is not drained until the user speaks again, so the sweep must proceed')
  assert.equal(ctx.created.length, 1, 'the fork ran')
  assert.ok(state.getLastSleepAt('issue5-cold'), 'the cursor advanced and the tail is not stranded')
})

// —— Issue #4 缺陷 3：归档会话事前跳过 ——

test('issue #4/defect 3: archived sessions are skipped at the candidate stage', async () => {
  state.updateSettings({ sleepConsolidation: true, sleepAfterIdleMinutes: 10 })
  ensureIdle('issue4-arch', { minutesAgo: 30 })
  ensureIdle('issue4-live', { minutesAgo: 30 })
  const ctx = fakeCtx({ live: ['issue4-arch', 'issue4-live'], archived: ['issue4-arch'] })
  const out = await cycle.runSleepPass(ctx, { limit: 10 })
  assert.equal(out.ran, 1, 'only the unarchived session is consolidated')
  assert.deepEqual(ctx.created.map((spec) => spec.meta.parentSession), ['issue4-live'], 'the archived session never becomes a fork and takes no budget slot')
})

test('issue #4/defect 3: a manual consolidation of an archived session is refused with a clear reason', async () => {
  ensureIdle('issue4-arch-manual', { minutesAgo: 30 })
  const ctx = fakeCtx({ live: ['issue4-arch-manual'], archived: ['issue4-arch-manual'] })
  const result = await privateLib.requestPrivateConsolidation(ctx, 'issue4-arch-manual', { force: true })
  assert.equal(result.ok, false)
  assert.equal(result.reasonCode, 'session-archived')
  assert.equal(ctx.created.length, 0, 'no doomed fork is created for an archived session')
})

// —— Issue #4 缺陷 1：snapshot-failed 熔断 ——

test('issue #4/defect 1: a frozen snapshot is not settled, keeps the error visible, and never advances the cursor', async () => {
  state.updateSettings({ sleepConsolidation: true, sleepAfterIdleMinutes: 5 })
  ensureIdle('issue4-freeze', { minutesAgo: 60 })
  const errorCtx = () => fakeCtx({ live: ['issue4-freeze'], receipts: 'error' })
  // 两次真实失败 → 同一快照连击到上限（CONSOLIDATION_SNAPSHOT_FAILURE_LIMIT = 2）。
  // 每次失败后的退避到期前不能重试，先把退避清掉模拟「退避过期」的时序。
  await cycle.runSleepPass(errorCtx(), { limit: 10 })
  clearBackoffs('issue4-freeze')
  await cycle.runSleepPass(errorCtx(), { limit: 10 })
  const frozenBinding = state.getSessionBinding('issue4-freeze')
  assert.ok(frozenBinding.lastSleepError, 'the last real failure stays visible')

  // 第三扫：命中熔断闸门。修复后 settled:false → deferred 路径：
  // 游标不推平、lastSleepError 不清零。
  clearBackoffs('issue4-freeze')
  await cycle.runSleepPass(errorCtx(), { limit: 10 })
  assert.equal(state.getLastSleepAt('issue4-freeze'), null, 'a frozen failure must not flatten the sleep cursor (was settled:true before the fix)')
  assert.ok(state.getSessionBinding('issue4-freeze').lastSleepError, 'the failure is not erased by the frozen gate')

  // 活动日志去重：同一份冻结记录只落一条 snapshot-failed-too-many。
  const frozenEvents = () => activityLog.listEvents({ kind: 'consolidate', limit: 50 })
    .filter((entry) => entry.detail?.reasonCode === 'snapshot-failed-too-many')
  assert.equal(frozenEvents().length, 1, 'the freeze logs once')

  clearBackoffs('issue4-freeze')
  await cycle.runSleepPass(errorCtx(), { limit: 10 })
  assert.equal(state.getLastSleepAt('issue4-freeze'), null, 'still frozen on the next sweep')
  assert.equal(frozenEvents().length, 1, 'repeated sweeps inside the freeze do not spam activity.jsonl')
})

test('issue #4/defect 1: the freeze expires after its cooldown and a real retry is allowed', async () => {
  // 沿用上一条冻结的 issue4-freeze：把冻结记录的 at 改到冷却期之外
  //（failures 保持 2），下一扫应当清零连击并真的 fork 一次。绑定侧的
  // sleepFrozenUntil 也要同步拨到过去——候选守卫读它，与账本冷却同时到期。
  const frozen = ledger.loadLedger().sessions['issue4-freeze']
  assert.ok(frozen, 'the ledger entry exists')
  const failedKeys = Object.entries(frozen.operations || {})
    .filter(([, op]) => op?.outcome === 'failed' && Number(op?.failures) >= 2)
  assert.ok(failedKeys.length >= 1, 'the failed operation streak is recorded')
  patchLedger('issue4-freeze', (entry) => {
    for (const [key] of failedKeys) {
      entry.operations[key].at = new Date(Date.now() - 7 * 60 * 60_000).toISOString()
    }
    entry.retryAt = null
  })
  state.setSessionBinding('issue4-freeze', { sleepRetryAt: null, sleepAttempts: 0, sleepFrozenUntil: new Date(Date.now() - 60_000).toISOString() })

  const ctx = fakeCtx({ live: ['issue4-freeze'], receipts: 'error' })
  await cycle.runSleepPass(ctx, { limit: 10 })
  assert.equal(ctx.created.length, 1, 'the cooldown expiry lets one real fork through (was frozen forever before the fix)')
})

test('issue #4/defect 1 (1.3.10): the freeze backoff skips idle re-sweeps but yields to a new human turn', async () => {
  state.updateSettings({ sleepConsolidation: true, sleepAfterIdleMinutes: 5 })
  ensureIdle('issue4-freeze-yield', { minutesAgo: 60 })
  const errorCtx = () => fakeCtx({ live: ['issue4-freeze-yield'], receipts: 'error' })
  // 两次真实失败 + 一次闸门扫入 → 冻结并写下 sleepFrozenUntil/At。
  await cycle.runSleepPass(errorCtx(), { limit: 10 })
  clearBackoffs('issue4-freeze-yield')
  await cycle.runSleepPass(errorCtx(), { limit: 10 })
  clearBackoffs('issue4-freeze-yield')
  await cycle.runSleepPass(errorCtx(), { limit: 10 })
  const frozenBinding = state.getSessionBinding('issue4-freeze-yield')
  const frozenAt = Date.parse(frozenBinding.sleepFrozenAt)
  assert.ok(Date.parse(frozenBinding.sleepFrozenUntil) > frozenAt, 'the freeze backoff fields are written')
  const probeAtFrozen = frozenBinding.lastConsolidationProbeAt

  // 冻结期内、无新活动：候选守卫直接跳过——不重读快照、不更新探针时间。
  clearBackoffs('issue4-freeze-yield')
  await cycle.runSleepPass(errorCtx(), { limit: 10, now: frozenAt + 60_000 })
  assert.equal(state.getSessionBinding('issue4-freeze-yield').lastConsolidationProbeAt, probeAtFrozen,
    'a guarded sweep does not re-enter consolidation (probe stamp untouched)')

  // 冻结后来了新真人回合（lastTurnAt 越过 frozenAt）：守卫立刻让路，重新扫入。
  state.setSessionBinding('issue4-freeze-yield', { lastTurnAt: new Date(frozenAt + 120_000).toISOString() })
  clearBackoffs('issue4-freeze-yield')
  await cycle.runSleepPass(errorCtx(), { limit: 10, now: frozenAt + 120_000 })
  assert.equal(state.getSessionBinding('issue4-freeze-yield').lastConsolidationProbeAt, new Date(frozenAt + 120_000).toISOString(),
    'a new human turn after the freeze yields immediately — the backoff never penalizes new activity')
})

// —— Issue #4 缺陷 2：多窗尾段 ——

test('issue #4/defect 2: a mid-window completion leaves the cursor behind and the tail is picked up by the next sweep', async () => {
  state.updateSettings({ sleepConsolidation: true, sleepAfterIdleMinutes: 10 })
  ensureIdle('issue4-tail', { minutesAgo: 30 })
  // 650 事件：头一段真人对话 + 644 条 todo/write 填充。第一窗切出约 500 条，
  // 余数 < 200（CONSOLIDATION_BACKLOG_EVENTS），修复前会永久悬空。
  const filler = Array.from({ length: privateLib.CONSOLIDATION_WINDOW_EVENTS + 144 }, (_, i) => ({
    seq: 3 + i,
    type: 'todo/write',
    data: { todo: '填充事件 ' + i },
  }))
  const longEvents = [
    { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我们把整个记忆系统的整理链路从头到尾对一遍账。' }] } },
    { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的，先从 sweep 的候选筛选开始。' }] } } },
    { seq: 2, type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
    ...filler,
  ]
  const ctx = fakeCtx({ live: ['issue4-tail'], receipts: 'window', events: longEvents })

  // 第一扫：fork 第一窗，回执只覆盖本窗（seed.lastSeq ≈ 502）→ remaining > 0。
  const first = await cycle.runSleepPass(ctx, { limit: 10 })
  assert.equal(first.ran, 1)
  assert.ok(ctx.created.length, 1, 'the first window forked')
  const checkedAfterFirst = ledger.sessionState('issue4-tail')?.checked
  assert.ok(checkedAfterFirst?.throughSeq > 0, 'window 1 advanced the ledger cursor')
  assert.ok(checkedAfterFirst.throughSeq < longEvents[longEvents.length - 1].seq, 'the receipt covered only window 1')
  assert.equal(state.getLastSleepAt('issue4-tail'), null, 'the coarse cursor must NOT advance while remaining > 0 (before the fix it was flattened here and the tail stranded)')

  // 第二扫：剩余尾段走 no-human-turn 终态跳过（skipRange），整段收口。
  const second = await cycle.runSleepPass(fakeCtx({ live: ['issue4-tail'], receipts: 'window', events: longEvents }), { limit: 10 })
  assert.equal(second.ran, 0, 'the tail sweep is a terminal policy skip, not a worker run')
  const settled = ledger.sessionState('issue4-tail')?.checked
  assert.equal(settled.throughSeq, longEvents[longEvents.length - 1].seq, 'the tail is fully checked — before the fix it stayed pending forever')
  assert.equal(ledger.sessionState('issue4-tail')?.pending, null, 'no pending range left behind')
  assert.ok(state.getLastSleepAt('issue4-tail'), 'the cursor advances once the whole transcript is settled')
})
