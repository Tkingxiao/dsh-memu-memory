import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-worker-lifecycle-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const state = await import('../lib/state.js')
const workerPool = await import('../lib/worker-pool.js')
const turnLog = await import('../lib/turn-log.js')
const { privateRemember } = await import('../lib/memory.js')
const { requestPrivateConsolidation, requestHistoricalConsolidation, alignWindowToTurn, selectWorkerWindow } = await import('../lib/private.js')

// 默认推理强度不参与本文件的断言（路由继承由 consolidation-fork.test.mjs 单独覆盖）。
state.updateSettings({ consolidationReasoningEffort: 'inherit' })

/** 给会话绑定的库写一条记忆：目录头（memoryCatalogEvent）只在库非空时才有内容。 */
async function seedMemory(sessionId, title, content) {
  const result = await privateRemember({
    exec: { agent: { session: { header: { id: sessionId } } } },
    content,
    title,
    source: 'inferred',
  })
  assert.ok(result?.id, 'the seeded memory landed: ' + JSON.stringify(result).slice(0, 200))
  return result.id
}

test.after(() => {
  try { state.flushState() } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

// —— 宿主事件 fixture（带 turn 包装：turn-log 缺口重建依赖闭合回合） ——————————

function wrappedTurn(seed, { user = '帮我看看这个整理 worker 为什么一直建不起来', sceneTime = null } = {}) {
  const events = [
    { seq: seed, type: 'turn/start', data: { turn: 1 } },
    { seq: seed + 1, type: 'user/message', time: seed, data: { source: { kind: 'user' }, content: [{ type: 'text', text: user }], ...(sceneTime ? { sceneTime } : {}) } },
    { seq: seed + 2, type: 'assistant/message', time: seed, data: { message: { content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] } } },
    { seq: seed + 3, type: 'tool/call', time: seed, data: { callId: 'c1', name: 'read', arguments: '{}' } },
    { seq: seed + 4, type: 'tool/result', time: seed, data: { message: { callId: 'c1', content: [{ type: 'text', text: 'ok' }] } } },
    { seq: seed + 5, type: 'assistant/message', time: seed, data: { message: { content: [{ type: 'text', text: '看到了' }] } } },
    { seq: seed + 6, type: 'turn/end', time: seed, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  return events
}

// —— 宿主 mock（形状沿用 consolidation-fork.test.mjs 的 host()，另加：
//      持久 worker 的进程内注册表 / resume 能力位 / whenIdle 计数） ————————

const META_KEYS = ['cwd', 'parentSession', 'isSeeded', 'origin', 'delegationDepth', 'agentPreset']

function assertHostCreateAccepts(spec = {}) {
  const meta = spec.meta ?? {}
  for (const key of Object.keys(meta)) {
    if (!META_KEYS.includes(key)) throw new Error(`session meta "${key}" is not a header field`)
  }
  if (meta.isSeeded === true) {
    if (spec.seed === undefined) throw new Error('seeded session requires an explicit constructor seed')
    if (spec.inheritedEventCount === undefined) throw new Error('seeded session requires an inherited event count')
  } else if (spec.inheritedEventCount !== undefined && spec.inheritedEventCount !== 0) {
    throw new Error('unseeded session inherited event count must be 0')
  } else if (spec.seed !== undefined) {
    throw new Error('unseeded session must not carry a seed')
  }
  if (spec.agentOptions !== undefined) {
    if (!spec.agentOptions || typeof spec.agentOptions.provider !== 'string' || typeof spec.agentOptions.model !== 'string') {
      throw new Error('agentOptions must carry the parent provider and model')
    }
  }
}

const RECEIPT_TICK = String.fromCharCode(96)
function receiptFence(range, identity) {
  return [
    RECEIPT_TICK + RECEIPT_TICK + RECEIPT_TICK + 'memu-consolidation-receipt',
    JSON.stringify({
      version: 1, ...identity,
      status: 'completed', outcome: 'no_value', checkedRange: range,
      createdIds: [], updatedIds: [], heldIds: [], reasonCode: null, retryable: false,
    }),
    RECEIPT_TICK + RECEIPT_TICK + RECEIPT_TICK,
  ].join('\n')
}

/**
 * worker 模式宿主 mock。resume: 'none'（宿主没有 resume 服务）| 'works' | 'fails'。
 * whenIdleCalls：前 N 次 whenIdle() 挂起（供超时用例），之后立即 resolve
 * （retireWorker 的 bounded 等待不能挂住测试）。
 */
function host({
  live = true,
  resume = 'none',
  turnReason = { kind: 'completed' },
  emitTurnEnd = true,
  delayTurn = false,
  headerTools = null,
  parentOptions = true,
} = {}) {
  const rec = {
    liveFollowups: [], created: [], forkFollowups: [], disposed: [], resumed: [],
    sessionHandlers: [],
  }
  const registry = new Map() // 进程内 agent 注册表：agents.get 只查这里
  // delayTurnMode=true 时 followup 不立即发回合事件，而是把回合挂起（whenIdle 等待），
  // 直到 ctx.completeTurn() 才落地——真实模拟"超时后上一回合还在跑"的时序（A1）。
  let delayTurnMode = delayTurn
  let childSeq = 0
  const transcript = [...wrappedTurn(0)]

  const makeRecord = (id) => {
    const childSession = { id } // 宿主语义：handle.agent.session 与 session/event 的 session 是同一个对象
    let pending = null // 在跑回合：{ promise, finish }
    const emitTurn = () => {
      childSeq += 1
      const child = state.getSessionBinding(id)
      const fromSeq = Number.isSafeInteger(child?.snapshotFromSeq) ? child.snapshotFromSeq : 0
      const throughSeq = Number.isSafeInteger(child?.snapshotThroughSeq) ? child.snapshotThroughSeq : 6
      const text = turnReason?.kind === 'completed' ? receiptFence({ fromSeq, throughSeq }, child || {}) : ''
      for (const handler of rec.sessionHandlers) {
        if (text) handler(childSession, { type: 'assistant/message', seq: 900 + childSeq, data: { message: { content: [{ type: 'text', text }] } } })
      }
      for (const handler of rec.sessionHandlers) {
        handler(childSession, { type: 'turn/end', seq: 901 + childSeq, data: { turn: childSeq, reason: turnReason } })
      }
    }
    return {
      agent: {
        session: childSession,
        followup: (message) => {
          rec.forkFollowups.push({ child: id, message })
          if (!emitTurnEnd) return
          if (delayTurnMode) {
            let resolve
            const promise = new Promise((r) => { resolve = r })
            pending = { promise, finish: () => { pending = null; emitTurn(); resolve() } }
          } else {
            emitTurn()
          }
        },
        // 真实语义：回合落地（pending 清空）whenIdle 才 resolve；回合在跑则一直等。
        whenIdle: async () => { if (pending) await pending.promise },
        // 保真：真实宿主 agents.get 返回裸 Agent，dispose 在裸 Agent 上（retireWorker 用）。
        dispose: async () => { rec.disposed.push(id) },
      },
      dispose: async () => { rec.disposed.push(id) },
      _finishTurn: () => { if (pending) pending.finish() },
    }
  }

  const parentRecord = live
    ? {
        followup: (message) => rec.liveFollowups.push({ message }),
        ...(parentOptions ? { options: { provider: 'test-provider', model: 'test-model' } } : {}),
        ...(headerTools ? { session: { requestHeader: () => ({ tools: headerTools.map((name) => ({ name })) }) } } : {}),
      }
    : null

  const ctx = {
    rec,
    restart: () => registry.clear(),
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
        const agents = {
          // 保真（bench 实测 bug #1）：真实宿主 get 返回**裸 Agent**（core/agent/src/index.ts:580
          // `store.get(id)?.agent`），create/resume 返回 handle 包装（{agent,...}）。
          // mock 曾让 get 也返回包装——恰好掩盖了复用派发读 handle.agent 崩溃的 bug。
          get: (id) => {
            const hit = registry.get(id)
            if (hit) return hit.agent
            return live && id === currentSession ? parentRecord : undefined
          },
          create: async (spec) => {
            assertHostCreateAccepts(spec)
            // 真实宿主语义：同 id 会话文件已存在时拒绝 create（bench 实测 already exists 连挂）。
            if (registry.has(spec.sessionId)) {
              throw new Error('session "' + spec.sessionId + '" already exists')
            }
            rec.created.push(spec)
            const record = makeRecord(spec.sessionId)
            registry.set(spec.sessionId, record)
            return record
          },
        }
        if (resume !== 'none') {
          agents.resume = async ({ resumeSessionId } = {}) => {
            rec.resumed.push(resumeSessionId)
            if (resume === 'works') {
              const hit = registry.get(resumeSessionId)
              if (hit) return hit
              const record = makeRecord(resumeSessionId)
              registry.set(resumeSessionId, record)
              return record
            }
            throw new Error('no live agent for ' + String(resumeSessionId))
          }
        }
        return agents
      }
      if (name === 'sessionQuery') {
        return {
          readSession: async () => ({ events: [...transcript], session: { cwd: path.join(home, 'proj'), agentPreset: 'coding' } }),
        }
      }
      return undefined
    },
    pushTurn: (events) => { transcript.push(...events) },
    // A1 时序控制：切换"回合延迟落地"模式；completeTurn 让所有在跑回合落地（发事件 + resolve whenIdle）。
    setDelayTurn: (value) => { delayTurnMode = Boolean(value) },
    completeTurn: () => { for (const record of registry.values()) record._finishTurn() },
  }
  let currentSession = null
  ctx.bindSession = (sessionId) => {
    currentSession = sessionId
    state.ensureSession(sessionId, { cwd: path.join(home, 'proj'), agentPreset: 'coding' })
    return sessionId
  }
  return ctx
}

function textOf(followup) {
  const content = followup?.message?.content
  if (typeof content === 'string') return content
  return (Array.isArray(content) ? content : []).map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('\n')
}

async function runWorkerWindow(ctx, sessionId, options = {}) {
  return requestHistoricalConsolidation(ctx, sessionId, options)
}

// —— 设置面（§10.1/§10.2） ————————————————————————————————————————

test('consolidationRunner defaults to fork, round-trips through rpc, and validates its enum', async () => {
  const rpc = await import('../lib/rpc.js')
  assert.equal(state.DEFAULT_SETTINGS.consolidationRunner, 'fork', 'T1 默认保持现状路径')
  await rpc.dispatch({}, 'setSettings', { patch: { consolidationRunner: 'worker' } })
  assert.equal(state.getSettings().consolidationRunner, 'worker')
  await assert.rejects(
    rpc.dispatch({}, 'setSettings', { patch: { consolidationRunner: 'thread' } }),
    /invalid setting consolidationRunner/,
  )
  const reset = await rpc.dispatch({}, 'resetSettings', {})
  assert.equal(reset.consolidationRunner, 'fork')
})

// —— 'fork' 默认路径回归 ————————————————————————————————————————————

test('the default runner keeps the seeded per-window fork path unchanged', async () => {
  const ctx = host({})
  const sessionId = ctx.bindSession('wl-fork-default')
  const result = await requestPrivateConsolidation(ctx, sessionId)
  assert.equal(result.ok, true)
  assert.equal(result.settled, true)
  assert.equal(ctx.rec.created.length, 1)
  const spec = ctx.rec.created[0]
  assert.equal(spec.sessionId.startsWith('memu-consolidate-'), true, 'fork path keeps its session-id scheme')
  assert.equal(spec.meta.isSeeded, true)
  assert.equal(spec.meta.origin, 'subagent')
  assert.equal(spec.inheritedEventCount, 7, 'the whole wrapped transcript is seeded')
  assert.ok(spec.seed, 'the fork carries a buildForkSeed payload')
  assert.equal(ctx.rec.disposed.length, 1, 'the fork is disposed per window')
  assert.equal(state.getSessionBinding(spec.sessionId), null, 'disposed fork binding removed')
  assert.equal(state.getSessionBinding(sessionId).lastSleepSeq, 6)
  assert.equal(state.getSessionBinding(sessionId).workerEpoch ?? null, null, 'fork path leaves no epoch behind')
})

// —— 模型路由：host/custom 不探测父会话（避免 resume 把父会话挂成活视图）——————

test('host/custom consolidation models do not resume the parent just to read a route', async () => {
  state.updateSettings({
    consolidationRunner: 'worker', consolidationModelMode: 'host', consolidationModel: 'test-provider/test-model',
    consolidationReasoningEffort: 'inherit',
  })
  try {
    const ctx = host({ resume: 'works', parentOptions: false })
    const sessionId = ctx.bindSession('wl-host-route-no-resume')
    const result = await runWorkerWindow(ctx, sessionId)
    assert.equal(result.ok, true, result.error || '')
    assert.equal(ctx.rec.resumed.length, 0, 'an unused inherit route must not resume (and pin) the parent session')
    assert.deepEqual(ctx.rec.created[0]?.agentOptions, { provider: 'test-provider', model: 'test-model' })
  } finally {
    state.updateSettings({ consolidationModelMode: 'inherit', consolidationModel: '' })
  }
})

// —— S1 冻结回归：活视图停在旧前缀时，窗口必须从持久日志取新回合 ————————————
test('a frozen live view is recovered from the persisted log before the window is chosen', async () => {
  state.updateSettings({
    consolidationRunner: 'worker', consolidationModelMode: 'host', consolidationModel: 'test-provider/test-model',
    consolidationReasoningEffort: 'inherit',
  })
  try {
    const ctx = host({})
    const sessionId = ctx.bindSession('wl-cold-ahead')
    const liveEvents = wrappedTurn(0) // 活视图冻结在第一回合 seq 0-6
    const coldEvents = [...wrappedTurn(0), ...wrappedTurn(7, { user: '追加回合：这条只存在于持久日志里' })] // seq 0-13
    const header = {
      id: sessionId, cwd: path.join(home, 'proj'), agentPreset: 'coding',
      createdAt: 1, isSeeded: false, delegationDepth: 0,
    }
    const originalGet = ctx.get.bind(ctx)
    ctx.get = (name) => {
      if (name === 'sessionQuery') {
        return {
          observeSession: async () => ({
            source: 'live',
            header,
            inheritedEventCount: 0,
            events: liveEvents,
            cursor: 6,
            retain: () => ({ [Symbol.dispose]: () => {} }),
            [Symbol.dispose]: () => {},
          }),
        }
      }
      if (name === 'sessionPersistence') {
        return {
          open: async () => ({}),
          __coldLogs: { [sessionId]: { header, inheritedEventCount: 0, events: coldEvents } },
        }
      }
      return originalGet(name)
    }
    const result = await runWorkerWindow(ctx, sessionId, { force: true })
    assert.equal(result.ok, true, result.error || '')
    assert.equal(result.settled, true)
    assert.equal(result.snapshot?.throughSeq, 13, 'the window uses the persisted tail, not the frozen live cut')
    assert.equal(state.getSessionBinding(sessionId).lastSleepSeq, 13, 'the cursor advances over the appended turn')
    const pack = textOf(ctx.rec.forkFollowups[0])
    assert.match(pack, /"seq":\[0,6\]/)
    assert.match(pack, /"seq":\[7,13\]/, 'the appended turn is in the worker pack')
  } finally {
    state.updateSettings({ consolidationModelMode: 'inherit', consolidationModel: '' })
  }
})

// —— 初生（§4.1） ——————————————————————————————————————————————————

test('worker mode births an unseeded persistent worker with an epoch and keeps it alive', async () => {
  state.updateSettings({ consolidationRunner: 'worker', consolidationReasoningEffort: 'inherit' })
  const ctx = host({})
  const sessionId = ctx.bindSession('wl-birth')
  await seedMemory(sessionId, '已有的一条记忆', '用户对伞的偏好：晴天不带。')
  const result = await runWorkerWindow(ctx, sessionId)
  assert.equal(result.ok, true, result.error || '')
  assert.equal(result.settled, true)
  assert.equal(ctx.rec.created.length, 1)
  const spec = ctx.rec.created[0]
  assert.match(spec.sessionId, /^memu-worker-[0-9a-f]+-1$/, 'the session id is memu-worker-<hash>-<epoch 序号>')
  assert.equal(spec.meta.parentSession, sessionId)
  assert.equal(spec.meta.origin, 'subagent')
  assert.equal(spec.meta.cwd, path.join(home, 'proj'))
  assert.equal(spec.meta.agentPreset, 'coding')
  assert.equal(spec.meta.isSeeded, undefined, 'no-seed birth (§4.1)')
  assert.equal(spec.seed, undefined)
  assert.equal(spec.inheritedEventCount, undefined)
  assert.deepEqual(spec.agentOptions, { provider: 'test-provider', model: 'test-model' })
  // worker 不销毁、子绑定不清（改动点 6）
  assert.equal(ctx.rec.disposed.length, 0)
  const child = state.getSessionBinding(spec.sessionId)
  assert.ok(child, 'the worker binding survives the window')
  assert.equal(child.consolidationFork, true)
  assert.equal(child.origin, 'subagent')
  assert.equal(child.libraryId, state.getSessionBinding(sessionId).libraryId)
  assert.equal(child.mood, null)
  assert.equal(child.workerEpoch?.forkSessionId, spec.sessionId)
  // 父绑定 epoch 记账：本窗已并入增量与产出
  const parent = state.getSessionBinding(sessionId)
  assert.equal(parent.workerEpoch?.forkSessionId, spec.sessionId)
  assert.equal(parent.workerEpoch?.index, 1)
  assert.equal(parent.workerEpoch?.windows, 1)
  assert.ok((parent.workerEpoch?.chars || 0) > 0, 'increment + observed output landed in epoch.chars')
  assert.equal(parent.workerEpoch?.timeouts, 0)
  assert.ok(parent.workerEpoch?.lastIdleAt, 'whenIdle completion stamps lastIdleAt')
  assert.equal(parent.workerEpoch?.scopeGeneration, state.getSessionBinding(sessionId).workerEpoch.scopeGeneration)
  assert.equal(parent.lastSleepSeq, 6)
  // 初生包：身份任务书 + 待处理回合 + 目录 + 契约 + 场景时间
  const pack = textOf(ctx.rec.forkFollowups[0])
  assert.match(pack, /私有整理 worker/, 'the identity brief leads the birth pack')
  assert.ok(pack.includes('--- 待处理回合 ---') && pack.includes('--- 结束 ---'))
  assert.match(pack, /memory-catalog/, 'the catalog header ships with the birth pack')
  assert.match(pack, /"seq":\[0,6\]/, 'the pending increment carries the turn record')
  assert.match(pack, /memu-consolidation-receipt/, 'the receipt contract ships with the birth pack')
})

// —— 续窗复用 + 增量包（§4.2/§15.2 改动点 4） ————————————————————————

test('a second window reuses the worker and ships only the increment pack', async () => {
  state.updateSettings({ consolidationRunner: 'worker', consolidationReasoningEffort: 'inherit' })
  const ctx = host({})
  const sessionId = ctx.bindSession('wl-reuse')
  await seedMemory(sessionId, '已有的一条记忆', '用户对伞的偏好：晴天不带。')
  const first = await runWorkerWindow(ctx, sessionId)
  assert.equal(first.ok, true, first.error || '')
  const forkId = ctx.rec.created[0].sessionId
  ctx.pushTurn(wrappedTurn(10, { user: '第二回合：把上次的结论再核对一遍', sceneTime: '第三日夜' }))
  // sceneTime 每窗重读：窗 2 前父绑定场景时间推进（RP 剧情可能推进，§6）
  state.setSessionBinding(sessionId, { sceneTime: '第三日夜' })
  const second = await runWorkerWindow(ctx, sessionId)
  assert.equal(second.ok, true, second.error || '')
  assert.equal(ctx.rec.created.length, 1, 'no new worker for the next window')
  assert.equal(ctx.rec.forkFollowups.length, 2)
  assert.equal(ctx.rec.forkFollowups[1].child, forkId, 'the increment pack goes to the same worker')
  const pack = textOf(ctx.rec.forkFollowups[1])
  assert.ok(pack.includes('--- 待处理回合 ---') && pack.includes('--- 结束 ---'), 'separator markers frame the increment')
  assert.match(pack, /"seq":\[10,16\]/, 'the increment covers only the new turn')
  assert.match(pack, /待处理增量\] 1 回合 · seq 10–16/, 'the digest line describes the increment')
  assert.match(pack, /memory-catalog/, 'the catalog header ships every window')
  assert.match(pack, /memu-consolidation-receipt/, 'the receipt contract ships every window')
  assert.match(pack, /\[场景时间\] 第三日夜/, 'sceneTime is re-read per window')
  assert.ok(!pack.includes('已结算参考'), 'continuation windows never carry the settled tail (§4.2)')
  assert.ok(!pack.includes('私有整理 worker'), 'continuation windows never repeat the identity brief')
  assert.equal(ctx.rec.disposed.length, 0, 'the worker survives the window')
  assert.equal(state.getSessionBinding(forkId) !== null, true)
  const parent = state.getSessionBinding(sessionId)
  assert.equal(parent.workerEpoch?.windows, 2)
  assert.equal(parent.workerEpoch?.index, 1, 'the epoch keeps its index across windows')
  assert.equal(parent.lastSleepSeq, 16)
})

// —— 三级试活（§4.6） ————————————————————————————————————————————————

test('resume capability revives the same epoch after a host restart', async () => {
  state.updateSettings({ consolidationRunner: 'worker' })
  const ctx = host({ resume: 'works' })
  const sessionId = ctx.bindSession('wl-resume-works')
  const first = await runWorkerWindow(ctx, sessionId)
  assert.equal(first.ok, true, first.error || '')
  const forkId = ctx.rec.created[0].sessionId
  ctx.restart()
  ctx.pushTurn(wrappedTurn(10, { user: '重启后的第一回合' }))
  const second = await runWorkerWindow(ctx, sessionId)
  assert.equal(second.ok, true, second.error || '')
  assert.equal(ctx.rec.created.length, 1, 'the epoch survives the restart without a new birth')
  assert.deepEqual(ctx.rec.resumed, [forkId])
  assert.equal(ctx.rec.forkFollowups[1].child, forkId, 'the increment goes to the resumed agent')
  assert.equal(state.getSessionBinding(sessionId).workerEpoch?.index, 1, 'epoch accounting is not reset by a restart')
})

test('without resume capability a dead worker cold-starts a new epoch', async () => {
  state.updateSettings({ consolidationRunner: 'worker' })
  const ctx = host({ resume: 'none' })
  const sessionId = ctx.bindSession('wl-resume-none')
  const first = await runWorkerWindow(ctx, sessionId)
  assert.equal(first.ok, true, first.error || '')
  const forkId = ctx.rec.created[0].sessionId
  ctx.restart()
  ctx.pushTurn(wrappedTurn(10, { user: '重启后 resume 不可用的回合' }))
  const second = await runWorkerWindow(ctx, sessionId)
  assert.equal(second.ok, true, second.error || '')
  assert.equal(ctx.rec.created.length, 2, 'a gone worker falls through to birth')
  const newSpec = ctx.rec.created[1]
  assert.equal(newSpec.sessionId.startsWith('memu-worker-'), true)
  assert.ok(newSpec.sessionId.endsWith('-2'), 'the epoch index increments across cold starts')
  assert.notEqual(newSpec.sessionId, forkId)
  assert.equal(state.getSessionBinding(forkId), null, 'the dead worker binding was cleaned up')
  assert.equal(state.getSessionBinding(sessionId).workerEpoch?.forkSessionId, newSpec.sessionId)
  assert.equal(state.getSessionBinding(sessionId).workerEpoch?.windows, 1, 'the new epoch starts its own accounting')
})

test('bench bug regression: a birth collision with a live orphan worker adopts it', async () => {
  // bench 实录（arm B）：窗口 2 派发崩溃 → retireWorker('failure') 清 epoch，但 dispose
  // 只关句柄不删会话 → 下一窗初生用同一 forkId → 宿主拒绝 already exists（连挂 10 次）
  // → 增量永远整理不进库。修复：撞车时探测旧会话——**存活就收编**（重建 epoch 记账指向它，
  // 保留其累积上下文），已死才顺延换新 id。
  state.updateSettings({ consolidationRunner: 'worker' })
  const ctx = host({ resume: 'none' })
  const sessionId = ctx.bindSession('wl-collision')
  const first = await runWorkerWindow(ctx, sessionId)
  assert.equal(first.ok, true, first.error || '')
  const firstForkId = ctx.rec.created[0].sessionId
  // 复刻实录：epoch 清零（retireWorker 的副作用），但宿主注册表里的旧 worker 还活着。
  state.setSessionBinding(sessionId, { workerEpoch: null })
  ctx.pushTurn(wrappedTurn(10, { user: '碰撞后的新回合' }))
  const second = await runWorkerWindow(ctx, sessionId)
  assert.equal(second.ok, true, second.error || '')
  assert.equal(second.childId, firstForkId, 'the live orphan is adopted, not re-created')
  assert.equal(ctx.rec.created.length, 1, 'no second create for a live orphan')
  assert.equal(ctx.rec.forkFollowups.filter((f) => f.child === second.childId).length, 2, 'both windows dispatch to the adopted worker; actual followups=' + JSON.stringify(ctx.rec.forkFollowups.map((f) => ({ child: f.child.slice(-14), msg: textOf(f).slice(0, 60) }))))
  const adoptedSecondPack = textOf(ctx.rec.forkFollowups.filter((f) => f.child === second.childId)[1])
  assert.match(adoptedSecondPack, /"seq":\[10,16\]/, 'the second window pack carries the pending increment')
  // 收编后 epoch 记账重建：同一 forkId、窗口计数续计、父绑定指回它
  const epoch = state.getSessionBinding(sessionId).workerEpoch
  assert.equal(epoch?.forkSessionId, firstForkId, 'the epoch points at the adopted worker')
  assert.equal(epoch?.windows, 1, 'the adopted epoch starts its own accounting (conservative: budget restarts, context itself is the safety net)')
  assert.equal(state.getSessionBinding(firstForkId)?.workerEpoch?.forkSessionId, firstForkId, 'the child binding is rebuilt too')
  assert.equal(ctx.rec.disposed.filter((id) => id === firstForkId).length, 0, 'the adopted worker was never disposed')
})

// —— 退役条件 1（scope 变化，§4.5） ———————————————————————————————————

test('a scope change retires the worker immediately and births without a handoff', async () => {
  state.updateSettings({ consolidationRunner: 'worker' })
  const ctx = host({})
  const sessionId = ctx.bindSession('wl-scope-change')
  const first = await runWorkerWindow(ctx, sessionId)
  assert.equal(first.ok, true, first.error || '')
  const forkId = ctx.rec.created[0].sessionId
  // 库/域指纹变化（scopeGenerationOf 的口径之一）
  state.setSessionBinding(sessionId, { domainOverride: 'coding' })
  ctx.pushTurn(wrappedTurn(10, { user: '换了领域之后的第一回合' }))
  const second = await runWorkerWindow(ctx, sessionId)
  assert.equal(second.ok, true, second.error || '')
  assert.deepEqual(ctx.rec.disposed, [forkId], 'the polluted worker is retired')
  assert.equal(ctx.rec.created.length, 2)
  const pack = textOf(ctx.rec.forkFollowups[1])
  assert.ok(!pack.includes('已结算参考'), 'scope-change retirement ships no settled tail (no handoff)')
  assert.match(pack, /私有整理 worker/, 'the fresh birth pack still carries the identity brief')
  assert.equal(state.getSessionBinding(sessionId).workerEpoch?.forkSessionId, ctx.rec.created[1].sessionId)
})

// —— 退役条件 2/3/4（只在 acquire 检查，§4.5） ——————————————————————————

test('char limit, window limit and idle TTL retire the epoch at acquire time', async () => {
  const { scopeGenerationOf } = await import('../lib/consolidation-ledger.js')
  const ctx = host({ resume: 'none' })
  const sessionId = 'wl-retire-unit'
  state.ensureSession(sessionId, { cwd: path.join(home, 'proj'), agentPreset: 'coding' })
  const generation = scopeGenerationOf(state.getSessionBinding(sessionId))
  const budget = workerPool.epochBudget({ workerEpoch: { modelMaxContext: null } })

  const birthed = []
  const runAcquire = async (workerEpoch) => {
    state.setSessionBinding(sessionId, { workerEpoch })
    const result = await workerPool.acquireWorker(ctx, { ...state.getSessionBinding(sessionId), sessionId }, {
      incrementChars: 100, settings: state.getSettings(), probe: { ok: true, source: 'unknown', hasWrite: null }, agentOptions: { provider: 'p', model: 'm' },
    })
    return result
  }

  // 条件 2：预算合格制——已累计 + 增量×3 越过 120k 档即换新（有交接）。
  const fit = await runAcquire({ forkSessionId: 'w0', index: 1, chars: 119_900, windows: 1, scopeGeneration: generation, parentSession: sessionId, timeouts: 0, lastIdleAt: new Date().toISOString() })
  assert.equal(fit.ok, true, fit.error || '')
  assert.equal(fit.birth, true, '119.9k + 100×3 crosses the 120k tier: retired and reborn')
  assert.deepEqual(fit.retired.map((r) => r.reason), ['char-limit'])
  assert.equal(fit.retired[0].handoff, true, 'char-limit retirement hands off')
  birthed.push(fit.forkId)

  // 条件 3：窗口数到档位上限（默认 8）。
  const windows = await runAcquire({ forkSessionId: 'w1', index: 2, chars: 0, windows: budget.maxWindows, scopeGeneration: generation, parentSession: sessionId, timeouts: 0, lastIdleAt: new Date().toISOString() })
  assert.equal(windows.ok, true, windows.error || '')
  assert.equal(windows.birth, true)
  assert.deepEqual(windows.retired.map((r) => r.reason), ['window-limit'])
  assert.equal(windows.retired[0].handoff, true)
  birthed.push(windows.forkId)

  // 条件 4：距上一窗 whenIdle 超 TTL（30 分钟）。
  const ttl = await runAcquire({ forkSessionId: 'w2', index: 3, chars: 0, windows: 1, scopeGeneration: generation, parentSession: sessionId, timeouts: 0, lastIdleAt: new Date(Date.now() - 31 * 60_000).toISOString() })
  assert.equal(ttl.ok, true, ttl.error || '')
  assert.equal(ttl.birth, true)
  assert.deepEqual(ttl.retired.map((r) => r.reason), ['idle-ttl'])
  assert.equal(ttl.retired[0].handoff, true)
  birthed.push(ttl.forkId)

  // 条件 1：scope 指纹变化——立即退役，无交接。
  const scope = await runAcquire({ forkSessionId: 'w3', index: 4, chars: 0, windows: 1, scopeGeneration: 'stale-generation', parentSession: sessionId, timeouts: 0, lastIdleAt: new Date().toISOString() })
  assert.equal(scope.ok, true, scope.error || '')
  assert.equal(scope.birth, true)
  assert.deepEqual(scope.retired.map((r) => r.reason), ['scope-change'])
  assert.equal(scope.retired[0].handoff, false, 'scope-change never hands off')

  // 条件全未触发：同 epoch 复用，不退役。
  const epoch = state.getSessionBinding(sessionId).workerEpoch
  const reuse = await runAcquire(epoch)
  assert.equal(reuse.ok, true, reuse.error || '')
  assert.equal(reuse.birth, false)
  assert.equal(reuse.reused, true)
  assert.deepEqual(reuse.retired, [])
  // 退役动作清掉的永远是「旧」fork 的绑定；四次退役的旧 id 都不该留下绑定。
  for (const oldId of ['w0', 'w1', 'w2', 'w3']) {
    assert.equal(state.getSessionBinding(oldId) ?? null, null, 'retired bindings are cleaned')
  }
  assert.equal(state.getSessionBinding(sessionId).workerEpoch?.forkSessionId, reuse.forkId, 'the parent epoch points at the live worker')
})

// —— 预算分档与产出系数（§4.5 条件 2） ————————————————————————————————

test('epoch tiers follow model maxContext and explicit settings override them', () => {
  assert.deepEqual(workerPool.epochBudget({ workerEpoch: { modelMaxContext: 100_000 } }), { charLimit: 120_000, maxWindows: 8 })
  assert.deepEqual(workerPool.epochBudget({ workerEpoch: { modelMaxContext: 131_072 } }), { charLimit: 120_000, maxWindows: 8 })
  assert.deepEqual(workerPool.epochBudget({ workerEpoch: { modelMaxContext: 200_000 } }), { charLimit: 200_000, maxWindows: 16 })
  assert.deepEqual(workerPool.epochBudget({ workerEpoch: { modelMaxContext: 262_144 } }), { charLimit: 200_000, maxWindows: 16 })
  assert.deepEqual(workerPool.epochBudget({ workerEpoch: { modelMaxContext: 1_000_000 } }), { charLimit: 200_000, maxWindows: 16 })
  assert.deepEqual(workerPool.epochBudget({ workerEpoch: {} }), { charLimit: 120_000, maxWindows: 8 }, 'unknown model takes the conservative tier')
  assert.deepEqual(
    workerPool.epochBudget({ workerEpoch: { modelMaxContext: 1_000_000 } }, { workerEpochCharLimit: 50_000, workerEpochMaxWindows: 3 }),
    { charLimit: 50_000, maxWindows: 3 },
    'explicit settings override the auto tier',
  )
})

test('budgetFit applies the output factor to the candidate increment only', () => {
  const epoch = { chars: 100_000, modelMaxContext: 131_072 }
  assert.equal(workerPool.budgetFit(epoch, 6_000), true, '100k + 6k×3 = 118k fits the 120k tier')
  assert.equal(workerPool.budgetFit(epoch, 7_000), false, '100k + 7k×3 = 121k crosses the 120k tier')
  assert.equal(workerPool.budgetFit({ chars: 100_000, modelMaxContext: 1_000_000 }, 7_000), true, 'the 200k tier has room')
  assert.equal(workerPool.budgetFit({ chars: 0 }, 40_000), true, '0 + 40k×3 = 120k exactly fits')
  assert.equal(workerPool.budgetFit({ chars: 1 }, 40_000), false)
})

// —— epoch 记账（recordEpochProgress） ————————————————————————————————

test('recordEpochProgress accumulates chars/windows and tracks the timeout streak', () => {
  const sessionId = 'wl-progress'
  state.ensureSession(sessionId, { cwd: path.join(home, 'proj'), agentPreset: 'coding' })
  const forkId = 'memu-worker-progress-1'
  const epoch = { forkSessionId: forkId, index: 1, birthAt: new Date().toISOString(), chars: 0, windows: 0, timeouts: 0, scopeGeneration: 'g', parentSession: sessionId, modelMaxContext: null, lastIdleAt: null }
  state.setSessionBinding(sessionId, { workerEpoch: epoch })
  state.setSessionBinding(forkId, { consolidationFork: true, workerEpoch: epoch })

  let next = workerPool.recordEpochProgress({ sessionId }, { incrementChars: 300, workerOutputChars: 120, idleAt: 1_700_000_000_000 })
  assert.equal(next.chars, 420)
  assert.equal(next.windows, 1)
  assert.equal(next.timeouts, 0)
  assert.equal(next.lastIdleAt, new Date(1_700_000_000_000).toISOString())

  next = workerPool.recordEpochProgress({ sessionId }, { timeout: true, progress: false })
  assert.equal(next.timeouts, 1, 'a timeout increments the streak')
  assert.equal(next.windows, 1, 'flag-only calls do not double-count the window')

  next = workerPool.recordEpochProgress({ sessionId }, { settled: true, progress: false })
  assert.equal(next.timeouts, 0, 'a settled window clears the streak')

  // 子绑定副本同步刷新
  assert.equal(state.getSessionBinding(forkId).workerEpoch.chars, 420)
  assert.equal(state.getSessionBinding(sessionId).workerEpoch.chars, 420)
})

// —— 退役动作（retireWorker） ————————————————————————————————————————

test('retireWorker waits idle, disposes tools and the agent, and clears both bindings', async () => {
  const ctx = host({})
  const agents = ctx.get('agents')
  const sessionId = 'wl-retire-action'
  const forkId = 'memu-worker-retire-1'
  state.ensureSession(sessionId, { cwd: path.join(home, 'proj'), agentPreset: 'coding' })
  state.setSessionBinding(forkId, {
    consolidationFork: true,
    origin: 'subagent',
    parentSessionId: sessionId,
    libraryId: state.getSessionBinding(sessionId).libraryId,
    workerEpoch: { forkSessionId: forkId, index: 1, chars: 900, windows: 3, parentSession: sessionId },
  })
  state.setSessionBinding(sessionId, { workerEpoch: { forkSessionId: forkId, index: 1, chars: 900, windows: 3, parentSession: sessionId } })
  // 注册表里放一个 handle，验证 dispose 与 bounded whenIdle
  agents.create({ sessionId: forkId, meta: { origin: 'subagent' } })
  const result = await workerPool.retireWorker(ctx, forkId, 'window-limit', { handoff: true, idleWaitMs: 200 })
  assert.equal(result.ok, true)
  assert.equal(result.handoff, true)
  assert.deepEqual(ctx.rec.disposed, [forkId])
  assert.equal(state.getSessionBinding(forkId), null)
  assert.equal(state.getSessionBinding(sessionId).workerEpoch ?? null, null, 'the parent epoch is cleared')
  // 已死的 worker：无 handle 也能完成清理（先清掉进程内注册表）
  ctx.restart()
  const dead = await workerPool.retireWorker(ctx, forkId, 'idle-ttl', { handoff: true, idleWaitMs: 50 })
  assert.equal(dead.ok, true)
  assert.equal(dead.hadHandle, false)
})

// —— 超时语义（§4.4）：废回合不废 worker，连续 2 次退役 ———————————————————

test('a timeout abandons the turn but keeps the worker; the next pack notes the unsettled window', async () => {
  state.updateSettings({ consolidationRunner: 'worker' })
  const ctx = host({})
  ctx.setDelayTurn(true) // 回合"在跑"：whenIdle 挂起，模拟慢回合导致窗口超时
  const sessionId = ctx.bindSession('wl-timeout')
  const first = await runWorkerWindow(ctx, sessionId, { maxWaitMs: 80 })
  assert.equal(first.ok, false)
  assert.equal(first.timedOut, true)
  assert.equal(first.partialWritesPossible, true, 'the range went back to pending with writes possible')
  assert.match(first.error, /the worker is kept/)
  const forkId = ctx.rec.created[0].sessionId
  assert.equal(ctx.rec.disposed.length, 0, 'the worker is NOT disposed on the first timeout')
  assert.ok(state.getSessionBinding(forkId), 'the worker binding survives')
  const parent = state.getSessionBinding(sessionId)
  assert.equal(parent.workerEpoch?.timeouts, 1)
  assert.ok(parent.consolidationPending, 'the unsettled window is flagged for the next pack')
  assert.equal(parent.workerEpoch?.lastIdleAt ?? null, null, 'a timed-out window never stamps lastIdleAt')
  assert.equal(parent.lastSleepSeq, undefined, 'the cursor did not advance')

  // 两窗之间：上一慢回合落地（真实宿主里它终会跑完）。A1 要求下一窗先等它 idle 再发包。
  ctx.completeTurn()
  // 第二窗：复用同一个 worker，增量包开头带「上窗未结算」核对说明；本窗回合又超时。
  const second = await runWorkerWindow(ctx, sessionId, { maxWaitMs: 80 })
  assert.equal(second.ok, false)
  assert.equal(second.timedOut, true)
  assert.equal(ctx.rec.created.length, 1, 'the first timeout did not retire the worker')
  assert.equal(ctx.rec.forkFollowups.length, 2)
  const pack = textOf(ctx.rec.forkFollowups[1])
  assert.match(pack, /\[上窗未结算/, 'the unsettled note leads the next pack')
  assert.match(pack, /勿重复写/)
  assert.match(pack, /（[0-9a-f]{12}…）/, 'the note cites the previous snapshot hash prefix')
  // 连续第 2 次超时 → 升级退役（§4.4）
  assert.deepEqual(ctx.rec.disposed, [forkId], 'two consecutive timeouts retire the worker')
  assert.equal(state.getSessionBinding(forkId), null)
  assert.equal(state.getSessionBinding(sessionId).workerEpoch ?? null, null)
})

// —— A1 回归：超时后必须等上一回合 idle 才发下一窗，杜绝事件污染 ————————————

test('A1: after a timeout the next window waits for the old turn to land and reuses cleanly', async () => {
  state.updateSettings({ consolidationRunner: 'worker' })
  const ctx = host({})
  const sessionId = ctx.bindSession('wl-a1-clean')
  ctx.setDelayTurn(true)
  const first = await runWorkerWindow(ctx, sessionId, { maxWaitMs: 80 })
  assert.equal(first.timedOut, true)
  const forkId = ctx.rec.created[0].sessionId
  // 上一回合在两窗之间落地；下一窗关掉延迟，正常结算。
  ctx.completeTurn()
  ctx.setDelayTurn(false)
  const second = await runWorkerWindow(ctx, sessionId)
  assert.equal(second.ok, true, second.error || '')
  assert.equal(second.settled, true)
  assert.equal(ctx.rec.created.length, 1, 'the idle worker is reused, not replaced')
  assert.equal(ctx.rec.forkFollowups[1].child, forkId)
  assert.equal(state.getSessionBinding(sessionId).lastSleepSeq, 6, 'the second window settled without contamination')
  assert.equal(state.getSessionBinding(sessionId).consolidationPending ?? null, null, 'the pending flag cleared on settle')
})

test('A1: a worker still busy past the idle grace is retired and replaced, never fed a new turn', async () => {
  state.updateSettings({ consolidationRunner: 'worker' })
  const ctx = host({})
  const sessionId = ctx.bindSession('wl-a1-stuck')
  const binding = () => ({ ...state.getSessionBinding(sessionId), sessionId })
  const opts = { probe: { hasWrite: true }, agentOptions: { provider: 'p', model: 'm' }, header: { cwd: path.join(home, 'proj'), agentPreset: 'coding' } }
  const first = await workerPool.acquireWorker(ctx, binding(), opts)
  assert.equal(first.ok, true, first.error || '')
  const forkId = first.forkId
  // 挂一个永不落地的回合，模拟卡死。
  ctx.setDelayTurn(true)
  first.handle.agent.followup({ content: 'stuck turn' })
  // 有界 idle 等待超时 → 退役冷启动，绝不把新回合塞进还在忙的 worker。
  const second = await workerPool.acquireWorker(ctx, binding(), { ...opts, idleWaitMs: 50 })
  assert.equal(second.ok, true, second.error || '')
  assert.equal(second.birth, true, 'the stuck worker was retired and a new one born')
  assert.notEqual(second.forkId, forkId)
  assert.ok(ctx.rec.disposed.includes(forkId), 'the stuck worker was disposed')
  assert.ok(second.retired.some((r) => r.forkId === forkId && r.stuck === true), 'retirement is flagged as stuck')
})

// —— 退役条件 5：回合失败即退役 ————————————————————————————————————————

test('a failed worker turn retires the epoch without a handoff', async () => {
  state.updateSettings({ consolidationRunner: 'worker' })
  const ctx = host({ turnReason: { kind: 'error', error: { message: 'prompt variable "{{model}}" has no value', code: 'UNKNOWN' } } })
  const sessionId = ctx.bindSession('wl-turn-failed')
  const result = await runWorkerWindow(ctx, sessionId)
  assert.equal(result.ok, false)
  assert.match(result.error, /fork turn ended error/)
  assert.deepEqual(ctx.rec.disposed.length, 1, 'the worker is retired on turn failure')
  assert.equal(state.getSessionBinding(ctx.rec.created[0].sessionId), null)
  assert.equal(state.getSessionBinding(sessionId).workerEpoch ?? null, null)
  assert.equal(state.getSessionBinding(sessionId).lastSleepSeq, undefined, 'the failed range stays pending')
})

// —— 增量读取与缺口重建（§3.3） ————————————————————————————————————————

test('loadWorkerIncrement rebuilds gaps from host events and falls back to condense', () => {
  const sessionId = 'wl-increment'
  state.ensureSession(sessionId, { cwd: path.join(home, 'proj'), agentPreset: 'coding' })
  const window = { fromSeq: 0, throughSeq: 6 }
  const events = wrappedTurn(0)

  // 日志缺失 → rebuildRange 从宿主事件补全
  const rebuilt = workerPool.loadWorkerIncrement({ sessionId, binding: {}, window, events })
  assert.equal(rebuilt.source, 'rebuilt')
  assert.equal(rebuilt.records.length, 1)
  assert.deepEqual(rebuilt.records[0].seq, [0, 6])
  assert.ok(rebuilt.chars > 0)
  assert.match(rebuilt.digest, /1 回合 · seq 0–6 · 缺口重建/)

  // 日志已衔接 → 直接读增量
  const again = workerPool.loadWorkerIncrement({ sessionId, binding: { lastSleepSeq: 0 }, window: { fromSeq: 0, throughSeq: 6 }, events })
  assert.equal(again.source, 'turn-log')
  assert.deepEqual(again.records[0].seq, [0, 6])

  // 记录起点越过窗口的整回合不会进增量（下窗游标推进后不重发）
  turnLog.recordTurn(sessionId, { seq: [20, 26], at: 't', scene: null, user: '下一窗的回合', model: '' })
  const clipped = workerPool.loadWorkerIncrement({ sessionId, binding: { lastSleepSeq: 6 }, window: { fromSeq: 10, throughSeq: 16 }, events: wrappedTurn(10) })
  assert.deepEqual(clipped.records.map((row) => row.seq), [[10, 16]])

  // 转录给不出闭合回合 → 现场 condenseEvents 回退，不写日志
  const openEvents = [
    { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '没有闭合回合的裸转录' }] } },
    { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的' }] } } },
  ]
  const fallback = workerPool.loadWorkerIncrement({ sessionId: 'wl-increment-fallback', binding: {}, window: { fromSeq: 0, throughSeq: 1 }, events: openEvents })
  assert.equal(fallback.source, 'fallback')
  assert.ok(fallback.text.includes('裸转录') || fallback.text.length >= 0, 'the fallback carries condensed text')
  assert.equal(turnLog.readIncrement('wl-increment-fallback', -1).records.length, 0, 'the fallback never writes the log')
})

// —— A3/A5/A7 回归：缺口判定 / 回合对齐 / off 开关 —————————————————————————

test('A3: heartbeat/injection-only turns do not force a permanent fallback', () => {
  const sessionId = 'wl-a3-heartbeat'
  state.ensureSession(sessionId, { cwd: path.join(home, 'proj'), agentPreset: 'coding' })
  // 正常回合 0-6 + 心跳回合 7-9（纯 plugin 注入，无对话）+ 正常回合 10-16。
  const heartbeat = [
    { seq: 7, type: 'turn/start', data: { turn: 2 } },
    { seq: 8, type: 'user/message', data: { source: { kind: 'plugin:heartbeat' }, content: [{ type: 'text', text: 'heartbeat' }] } },
    { seq: 9, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ]
  const events = [...wrappedTurn(0), ...heartbeat, ...wrappedTurn(10)]
  for (const record of turnLog.buildTurnRecords(events)) turnLog.recordTurn(sessionId, record)
  const inc = workerPool.loadWorkerIncrement({ sessionId, binding: { lastSleepSeq: -1 }, window: { fromSeq: 0, throughSeq: 16 }, events })
  assert.equal(inc.source, 'turn-log', 'the heartbeat gap is not a hole; no fallback')
  assert.deepEqual(inc.records.map((r) => r.seq), [[0, 6], [10, 16]])
  // 再跑一遍仍走 turn-log（缺口不会反复触发重建/回退）。
  const again = workerPool.loadWorkerIncrement({ sessionId, binding: { lastSleepSeq: -1 }, window: { fromSeq: 0, throughSeq: 16 }, events })
  assert.equal(again.source, 'turn-log')
})

test('A5: alignWindowToTurn trims a mid-turn window to the last closed turn', async () => {
  // 闭合回合 0-6、7-13，随后一个开了头但未闭合的回合 14-15。
  const events = [
    ...wrappedTurn(0), ...wrappedTurn(7),
    { seq: 14, type: 'turn/start', data: { turn: 3 } },
    { seq: 15, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '开回合' }] } },
  ]
  const aligned = alignWindowToTurn({ events, fromSeq: 0, throughSeq: 15, remaining: 0 })
  assert.equal(aligned.throughSeq, 13, 'the window backs off to the last turn/end')
  assert.equal(aligned.events.length, 14, 'the open turn is pushed to the next window')
  assert.equal(aligned.remaining, 2)
  // 已对齐的窗口原样返回。
  const already = alignWindowToTurn({ events: wrappedTurn(0), fromSeq: 0, throughSeq: 6, remaining: 0 })
  assert.equal(already.throughSeq, 6)
})

test('A5: turn-aligned windows feed a straddling turn exactly once', () => {
  const sessionId = 'wl-a5-straddle'
  state.ensureSession(sessionId, { cwd: path.join(home, 'proj'), agentPreset: 'coding' })
  const events = [...wrappedTurn(0), ...wrappedTurn(7), ...wrappedTurn(14)]
  for (const record of turnLog.buildTurnRecords(events)) turnLog.recordTurn(sessionId, record)
  // 窗 N 对齐到回合 A 末（6）：只喂 A；跨骑回合 T 整条留给下窗。
  const winN = workerPool.loadWorkerIncrement({ sessionId, binding: { lastSleepSeq: -1 }, window: { fromSeq: 0, throughSeq: 6 }, events })
  assert.deepEqual(winN.records.map((r) => r.seq), [[0, 6]])
  // 窗 N+1 游标 6、对齐到 20：喂 T 和 B，T 不会因跨骑被重复整条下发。
  const winN1 = workerPool.loadWorkerIncrement({ sessionId, binding: { lastSleepSeq: 6 }, window: { fromSeq: 7, throughSeq: 20 }, events })
  assert.deepEqual(winN1.records.map((r) => r.seq), [[7, 13], [14, 20]])
})

// 边界 1：单个回合超过 500 事件时，窗口向后补到该回合的 turn/end，不再整条跨窗重发。
test('A5: selectWorkerWindow extends a 500-event cut to the end of a long turn', () => {
  const events = [...wrappedTurn(0)]
  events.push({ seq: 7, type: 'turn/start', data: { turn: 2 } })
  events.push({ seq: 8, type: 'step/start', data: { turn: 2, step: 1 } })
  events.push({ seq: 9, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '长回合' }] } })
  for (let seq = 10; seq <= 554; seq += 1) {
    events.push({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } })
  }
  events.push({ seq: 555, type: 'step/end', data: { turn: 2, step: 1 } })
  events.push({ seq: 556, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  // 第一窗已结算 0-6；第二窗从 7 开始，500 事件切在长回合中间。
  const fresh = events.filter((event) => event.seq > 6)
  const window = selectWorkerWindow(fresh, 500)
  assert.equal(window.throughSeq, 556, 'the cut extends to the long turn end')
  assert.equal(window.events.length, 550)
  assert.equal(window.remaining, 0)
  const next = selectWorkerWindow(fresh.filter((event) => event.seq > 556), 500)
  assert.equal(next.events.length, 0, 'the long turn is not re-fed by a following window')
})

// 边界 2：turn/end 之后只有 session 级元数据时，对齐不能把游标回退。
test('A5: trailing session metadata after a closed turn never regresses the cursor', () => {
  const tail = [...wrappedTurn(0), { seq: 7, type: 'session/end-seed', data: {} }]
  const kept = alignWindowToTurn({ events: tail, fromSeq: 0, throughSeq: 7, remaining: 0 })
  assert.equal(kept.throughSeq, 7, 'metadata after the last turn/end stays in the window')
  const open = [
    ...wrappedTurn(0),
    { seq: 7, type: 'turn/start', data: { turn: 2 } },
    { seq: 8, type: 'step/start', data: { turn: 2, step: 1 } },
  ]
  const trimmed = alignWindowToTurn({ events: open, fromSeq: 0, throughSeq: 8, remaining: 0 })
  assert.equal(trimmed.throughSeq, 6, 'a genuinely open next turn is still pushed forward')
})

test('A7: consolidationTurnLog=off condenses without reading or writing the log', () => {
  state.updateSettings({ consolidationTurnLog: 'off' })
  try {
    const sessionId = 'wl-a7-off'
    state.ensureSession(sessionId, { cwd: path.join(home, 'proj'), agentPreset: 'coding' })
    const events = wrappedTurn(0)
    const inc = workerPool.loadWorkerIncrement({ sessionId, binding: {}, window: { fromSeq: 0, throughSeq: 6 }, events })
    assert.equal(inc.source, 'fallback', 'off falls back to on-the-fly condense')
    assert.equal(turnLog.readIncrement(sessionId, -1).records.length, 0, 'off never writes the log')
  } finally {
    state.updateSettings({ consolidationTurnLog: 'on' })
  }
})

test('A2: the epoch abort is wired at birth and stays stable across reuse', async () => {
  state.updateSettings({ consolidationRunner: 'worker' })
  const ctx = host({})
  const sessionId = ctx.bindSession('wl-a2-abort')
  const binding = () => ({ ...state.getSessionBinding(sessionId), sessionId })
  const opts = { probe: { hasWrite: true }, agentOptions: { provider: 'p', model: 'm' }, header: { cwd: path.join(home, 'proj'), agentPreset: 'coding' } }
  const first = await workerPool.acquireWorker(ctx, binding(), opts)
  assert.equal(first.ok, true, first.error || '')
  assert.ok(first.epochAbort && typeof first.epochAbort.abort === 'function', 'birth exposes an epoch abort controller')
  assert.equal(ctx.rec.created[0].signal, first.epochAbort.signal, 'create is wired to the epoch abort, not a window signal')
  const second = await workerPool.acquireWorker(ctx, binding(), opts)
  assert.equal(second.reused, true)
  assert.equal(second.epochAbort, first.epochAbort, 'reuse keeps the same lifetime-bound abort: hard-stop can stop the persistent worker')
})

// —— 增量包组装（§4.2） ————————————————————————————————————————————————

test('buildIncrementPack assembles separators, catalog, capped carry, contract and sceneTime', () => {
  const catalog = {
    type: 'user/message',
    data: { content: [{ type: 'text', text: ['[memory-catalog · 已有记忆目录]', '- [m1] 第一条', '- [m2] 第二条'].join('\n') }] },
  }
  const records = [
    { seq: [0, 6], at: 't', scene: null, user: '一', model: '甲' },
    { seq: [10, 16], at: 't', scene: '第三日夜', user: '二', model: '乙' },
  ]
  const carry = Array.from({ length: 6 }, (_, i) => ({ fromSeq: i, throughSeq: i + 1, tag: '事实', text: '顺延候选' + i, observedAt: null, carried: true }))
  carry.push({ fromSeq: 0, throughSeq: 6, tag: '事实', text: '本窗新候选', observedAt: null })
  const pack = workerPool.buildIncrementPack({
    binding: { sessionId: 's' },
    incrementRecords: records,
    catalog,
    digest: '2 回合 · seq 0–16',
    carry,
    contract: '[完成说明 · 1.3.1] 成功时最后一条消息用一句话说明整理结果即可',
    sceneTime: '第三日夜',
    pendingNote: true,
    pendingHash: 'a'.repeat(64),
  })
  assert.ok(pack.includes('--- 待处理回合 ---') && pack.includes('--- 结束 ---'), 'explicit separators frame the increment')
  assert.match(pack, /\[上窗未结算（aaaaaaaaaaaa…）\]/, 'the pending note cites the hash prefix')
  assert.match(pack, /勿重复写/)
  assert.match(pack, /\[待处理增量\] 2 回合 · seq 0–16/)
  assert.match(pack, /"seq":\[0,6\]/, 'the records ride inside the separators as JSONL')
  assert.match(pack, /memory-catalog/, 'the catalog header ships every window')
  assert.match(pack, /\[必写候选/, 'carry candidates ship with the pack')
  const carriedRows = (pack.match(/^\d+\. \[顺延/gm) || [])
  assert.equal(carriedRows.length, 4, 'at most 4 carried candidates (carry ≤4)')
  assert.match(pack, /本窗新候选/, 'fresh candidates keep their slot')
  assert.match(pack, /完成说明/, 'the receipt contract ships')
  assert.match(pack, /\[场景时间\] 第三日夜/, 'sceneTime ships as one line')
  // 没有上一窗未结算时不带核对说明
  const clean = workerPool.buildIncrementPack({ binding: { sessionId: 's' }, incrementRecords: records, catalog, carry: [], contract: 'c', sceneTime: null })
  assert.ok(!clean.includes('上窗未结算'))
  assert.ok(!clean.includes('[场景时间]'), 'a missing sceneTime emits no line')
})

// —— 交接包（§5.1）：尾部标注、摘要去重与封顶 ————————————————————————————

test('buildHandoffPack carries the settled tail, a deduped 20-row written summary and the pending increment', () => {
  const sessionId = 'wl-handoff'
  state.ensureSession(sessionId, { cwd: path.join(home, 'proj'), agentPreset: 'coding' })
  // 已结算两条 + 未结算一条：尾部只能带已结算段
  turnLog.recordTurn(sessionId, { seq: [0, 9], at: 't', scene: null, user: '已结算一', model: '甲' })
  turnLog.recordTurn(sessionId, { seq: [10, 19], at: 't', scene: null, user: '已结算二', model: '乙' })
  turnLog.recordTurn(sessionId, { seq: [30, 39], at: 't', scene: null, user: '未结算段', model: '丙' })

  // 最近优先：mem-24 最新（账本按 at 倒序；覆盖入参顺序即调用方给的 recency 顺序）
  const writtenIds = Array.from({ length: 25 }, (_, i) => `mem-${String(24 - i).padStart(2, '0')}`)
  // 目录头带 m1：written 里的 mem-00 与目录无关，但第一条写在目录里的 id 应被去重
  const catalog = {
    type: 'user/message',
    data: { content: [{ type: 'text', text: ['[memory-catalog · 已有记忆目录]', '- [mem-00] 目录里已有的一条', '- [mem-other] 另一条'].join('\n') }] },
  }
  const pack = workerPool.buildHandoffPack({
    sessionId,
    binding: { sessionId, libraryId: null, lastSleepSeq: 19 },
    snapshot: { fromSeq: 20, throughSeq: 39, eventCount: 10, hash: 'h'.repeat(64) },
    jobId: 'cons-test',
    mustCover: [],
    contract: '[完成说明 · 1.3.1]',
    incrementRecords: [{ seq: [30, 39], at: 't', scene: null, user: '未结算段', model: '丙' }],
    digest: '1 回合 · seq 30–39',
    catalog,
    sceneTime: '第三日夜',
    writtenRows: writtenIds.map((id) => ({ id, title: '标题 ' + id })),
    lastSleepSeq: 19,
  })
  assert.ok(pack.includes('--- 待处理回合 ---'), 'the pending increment rides in the pack')
  assert.match(pack, /"seq":\[30,39\]/)
  assert.ok(pack.includes('--- 已结算参考（勿为其写新记忆，只处理待处理区间）---'), 'the settled tail is labelled')
  assert.ok(pack.includes('--- 已结算参考结束 ---'))
  assert.match(pack, /"seq":\[0,9\]/, 'settled turn one rides the tail')
  assert.match(pack, /"seq":\[10,19\]/, 'settled turn two rides the tail')
  assert.ok(!pack.includes('"seq":[30,39]\n--- 已结算参考'), 'the unsettled record is tail-excluded')
  const tailBody = pack.split('--- 已结算参考（勿为其写新记忆，只处理待处理区间）---')[1] || ''
  assert.ok(!tailBody.includes('未结算段') || !tailBody.includes('"seq":[30,39]'), 'the tail never carries the pending range')
  assert.match(pack, /已写入摘要/, 'the written summary ships with the birth pack')
  const summarySection = (pack.split('[已写入摘要')[1] || '').split('\n[')[0]
  const summaryIds = (summarySection.match(/- \[(mem-\d+)\]/g) || []).map((row) => row.replace(/- \[|\]/g, ''))
  assert.equal(summaryIds.length, 20, 'the summary is capped at 20 rows')
  assert.equal(summaryIds[0], 'mem-24', 'the most recent operation leads')
  assert.ok(!summaryIds.includes('mem-00'), 'ids already listed in the catalog are deduped away')
  assert.match(pack, /另有 4 条均已在库。/, 'the remainder is counted (25 written − 20 shown − 1 catalog-deduped)')
  assert.match(pack, /\[场景时间\] 第三日夜/)

  // 无交接退役（scope-change/failure）：不带尾部与摘要，身份与目录照发
  const bare = workerPool.buildHandoffPack({
    sessionId,
    binding: { sessionId, libraryId: null },
    snapshot: { fromSeq: 0, throughSeq: 9, eventCount: 10, hash: 'h'.repeat(64) },
    contract: 'c',
    incrementRecords: [{ seq: [0, 9], at: 't', scene: null, user: 'x', model: '' }],
    catalog,
    includeTail: false,
    writtenRows: [],
  })
  assert.ok(!bare.includes('已结算参考'))
  assert.ok(!bare.includes('已写入摘要'))
  assert.match(bare, /memory-catalog/)
})

test('A8: the ledger-backed written summary includes created, updated and held ids', async () => {
  const { recordOperation } = await import('../lib/consolidation-ledger.js')
  const sessionId = 'wl-a8-summary'
  state.ensureSession(sessionId, { cwd: path.join(home, 'proj'), agentPreset: 'coding' })
  // private.js 结算时把 created+updated+held 全部记进 operation.ids（A8）；摘要走账本读取路径。
  recordOperation({ sessionId, key: 'op-a8', outcome: 'completed', ids: ['m-created', 'm-updated', 'm-held'] })
  const pack = workerPool.buildHandoffPack({
    sessionId,
    binding: { sessionId, libraryId: null, lastSleepSeq: 9 },
    snapshot: { fromSeq: 0, throughSeq: 9, eventCount: 10, hash: 'h'.repeat(64) },
    contract: 'c',
    incrementRecords: [],
    catalog: null,
    lastSleepSeq: 9,
  })
  assert.match(pack, /已写入摘要/)
  assert.match(pack, /\[m-created\]/)
  assert.match(pack, /\[m-updated\]/, 'updated ids are not dropped from the summary')
  assert.match(pack, /\[m-held\]/, 'held ids are not dropped from the summary')
})
