import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// §3.24 —— 宿主会把失败的整轮回滚（真机实测：连用户消息都不留在转录里），而插件在"消息交回
// 决策"之后就记了账。不撤销的话，guide / 锚点 / 当日纪念日 / 复提时钟这类一次性内容就永远
// 不再投，整段对话只是"记忆像没接上"，一句错都不报。判据是本轮那几条注入消息到底进过转录没有：
// 进过（请求已经发出去）就保住记账，没进过才撤回。这里把撤与不撤两面都钉住。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-rollback-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const inject = await import('../lib/inject.js')
const activity = await import('../lib/activity-log.js')

const handlers = new Map()
const warns = []
const ctx = {
  on: (topic, handler) => { handlers.set(topic, handler); return () => {} },
  get: () => undefined,
  logger: { warn: (message) => warns.push(String(message)), info: () => {}, error: () => {} },
  effect: (fn) => { try { fn() } catch {} },
  slots: { inject: () => {} },
  webServer: { register: () => {} },
}
inject.registerInjection(ctx)
const preStep = handlers.get('agent/pre-step')
const sessionEvent = handlers.get('session/event')
assert.equal(typeof preStep, 'function', 'registerInjection must expose agent/pre-step')
assert.equal(typeof sessionEvent, 'function', 'registerInjection must listen to session/event')

const GUIDE_RE = /<memory-guide/
const ANCHOR_RE = /=====\s*memory\s*anchor\s*=====/
const textOf = (message) => (typeof message?.content === 'string'
  ? message.content
  : (message?.content || []).map((part) => part?.text || '').join(''))
const countWith = (messages, re) => messages.filter((message) => re.test(textOf(message))).length
const user = (n, text) => ({ id: `u-${n}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const assistant = (n, text) => ({ id: `a-${n}`, role: 'assistant', content: [{ type: 'text', text }] })

function makeSession(id) {
  const cwd = path.join(home, id)
  const binding = state.ensureSession(id, { cwd, agentPreset: 'coding' })
  state.setSessionBinding(id, { useLibrary: true, useGlobal: false })
  const now = new Date().toISOString()
  state.updatePrivateIndex(binding.libraryId, (index) => {
    for (let i = 1; i <= 3; i += 1) {
      index.entries[`mem-${id}-${i}`] = {
        id: `mem-${id}-${i}`, track: 'memory', layer: 'long_term', status: 'active',
        title: `林眠的相机镜头跑焦维修进度 ${i}`,
        content: `林眠的相机镜头送修，报价与工期记录在第 ${i} 条。`,
        visibility: 'shared', disclosure: 'can_tell', owner: 'me',
        createdAt: now, updatedAt: now,
      }
    }
  })
  return { id, cwd }
}

async function step(session, turn, messages) {
  const out = await preStep({
    agent: { session: { header: { id: session.id, cwd: session.cwd, agentPreset: 'coding', origin: 'user' } } },
    turn, step: 1, signal: { aborted: false },
  }, async () => ({ kind: 'enter', messages }))
  return out?.messages || messages
}

function failTurn(session, turn) {
  return sessionEvent(
    { header: { id: session.id } },
    { type: 'turn/end', data: { turn, reason: { kind: 'error', error: { message: 'llm unreachable' } } } },
  )
}

function completeTurn(session, turn) {
  return sessionEvent({ header: { id: session.id } }, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
}

const facts = (id) => {
  const binding = state.getSessionBinding(id) || {}
  return {
    guide: binding.guideRulesKey || null,
    anchor: (binding.injectedIds || []).includes(inject.ANCHOR_SENTINEL),
    rollback: binding.injectionRollback || null,
    injected: (binding.injectedIds || []).filter((entry) => entry !== inject.ANCHOR_SENTINEL).length,
  }
}

test('a failed turn gives back the one-shot accounting, and the next turn re-places it', async () => {
  const session = makeSession('rb-err')
  const first = await step(session, 1, [user(1, '林眠的相机镜头修好了吗')])
  assert.equal(countWith(first, GUIDE_RE), 1, 'turn 1 places the guide')
  assert.equal(countWith(first, ANCHOR_RE), 1, 'turn 1 places the anchor')
  const placed = facts(session.id)
  assert.ok(placed.guide && placed.anchor && placed.injected > 0, 'the accounting says everything was delivered')

  await failTurn(session, 1)
  const rolled = facts(session.id)
  assert.equal(rolled.guide, null, 'guide key rolled back')
  assert.equal(rolled.anchor, false, 'anchor sentinel rolled back')
  assert.equal(rolled.injected, 0, 'the recall ids of that turn are forgotten too')
  assert.equal(rolled.rollback, null, 'the rollback record is consumed, not left to age')
  assert.ok(warns.some((line) => /rolled back injection accounting/.test(line)), 'the rollback leaves a log signal')
  const events = activity.listEvents({ limit: 50, kind: 'system' })
  assert.ok(events.some((event) => event.sessionId === session.id && /已撤回本轮的注入记账/.test(event.message || '')),
    'and an activity-log row explains what happened')

  // 下一轮：宿主给的转录里没有任何一次性的东西，必须重新投出来。
  const second = await step(session, 2, [user(1, '林眠的相机镜头修好了吗'), user(2, '那维修报价给了吗')])
  assert.equal(countWith(second, GUIDE_RE), 1, 'the guide comes back')
  assert.equal(countWith(second, ANCHOR_RE), 1, 'the anchor comes back')
})

test('a completed turn keeps its accounting, so nothing is re-placed', async () => {
  const session = makeSession('rb-ok')
  const first = await step(session, 1, [user(1, '林眠的相机镜头修好了吗')])
  assert.equal(countWith(first, GUIDE_RE), 1)
  await completeTurn(session, 1)

  const kept = facts(session.id)
  assert.ok(kept.guide, 'a completed turn must not forget the guide key')
  assert.equal(kept.anchor, true, 'nor the anchor sentinel')

  const view = [...first, assistant(1, '还在修。'), user(2, '林眠镜头跑焦的工期多久')]
  const second = await step(session, 2, view)
  assert.equal(countWith(second, GUIDE_RE), 1, 'the guide stays single-copy')
  assert.equal(countWith(second, ANCHOR_RE), 1, 'the anchor is not repeated')
})

test('a completed turn consumes its record, so a late error cannot un-place what is already in the transcript', async () => {
  const session = makeSession('rb-stale')
  const first = await step(session, 1, [user(1, '林眠的相机镜头修好了吗')])
  assert.equal(countWith(first, GUIDE_RE), 1)
  assert.ok(facts(session.id).rollback, 'the turn that just delivered leaves a rollback record')

  await completeTurn(session, 1)
  const kept = facts(session.id)
  assert.equal(kept.rollback, null, 'a completed turn consumes the record')
  assert.ok(kept.guide, 'its guide key stays')
  assert.equal(kept.anchor, true, 'and so does the anchor sentinel')

  // 迟到的 error 事件不能再撤回已经落在转录里的那一份，否则下一轮就凭空多出第二条规则消息/锚点。
  await failTurn(session, 1)
  const after = facts(session.id)
  assert.ok(after.guide, 'the late error does not forget the guide key')
  assert.equal(after.anchor, true, 'nor re-arm the anchor')
  assert.equal(after.injected, kept.injected, 'the recall ids of that turn stay accounted')

  const warnBefore = warns.length
  const second = await step(session, 2, [...first, assistant(1, '还在修。'), user(2, '维修报价给了吗')])
  assert.equal(countWith(second, GUIDE_RE), 1, 'no second rules message')
  assert.equal(countWith(second, ANCHOR_RE), 1, 'no second anchor')
  assert.equal(warns.slice(warnBefore).filter((line) => /rolled back injection accounting/.test(line)).length, 0,
    'and nothing was rolled back along the way')
})

test('a failure after the injection reached the transcript keeps the accounting', async () => {
  const session = makeSession('rb-admitted')
  const first = await step(session, 1, [user(1, '林眠的相机镜头修好了吗')])
  const injected = first.find((message) => message?.source?.kind === 'plugin:dsh-memu-memory')
  assert.ok(injected?.id, 'the turn produced an identified injection message')

  // 宿主在第一次尝试里就把 decision.messages 逐条追加进转录，之后才连模型。上游 500 / 超时
  // 属于这一类：内容已经在转录里，撤回记账只会让下一轮多出第二份规则消息与锚点。
  await sessionEvent({ header: { id: session.id } }, { type: 'user/message', data: injected })
  await failTurn(session, 1)
  const kept = facts(session.id)
  assert.ok(kept.guide, 'the rules message stays accounted')
  assert.equal(kept.anchor, true, 'and so does the anchor')
  assert.equal(kept.rollback, null, 'the record is consumed instead of rolled back')

  const warnBefore = warns.length
  const second = await step(session, 2, [...first, user(2, '维修报价给了吗')])
  assert.equal(countWith(second, GUIDE_RE), 1, 'no second rules message')
  assert.equal(countWith(second, ANCHOR_RE), 1, 'no second anchor')
  assert.equal(warns.slice(warnBefore).filter((line) => /rolled back injection accounting/.test(line)).length, 0,
    'nothing was rolled back along the way')
})

test('a cancel before the messages were appended also gives the accounting back', async () => {
  const session = makeSession('rb-abort')
  const first = await step(session, 1, [user(1, '林眠的相机镜头修好了吗')])
  assert.equal(countWith(first, ANCHOR_RE), 1)

  // 用户在模型调用之前就按了停止：转录里什么都没有，aborted 同样该把记账还回来。
  await sessionEvent({ header: { id: session.id } }, {
    type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: 'user stop' } },
  })
  const after = facts(session.id)
  assert.equal(after.guide, null, '取消发生在投放之前：一次性内容还没有落进转录')
  assert.equal(after.anchor, false)

  const again = await step(session, 2, [user(1, '林眠的相机镜头修好了吗')])
  assert.equal(countWith(again, ANCHOR_RE), 1, 'the anchor is placed again next turn')
})

test('rollback also clears the day marks so dated blocks can return', async () => {
  const session = makeSession('rb-dated')
  const now = Date.now()
  const iso = (offsetDays) => new Date(now + offsetDays * 86400000).toISOString()
  const day = (offset) => {
    const value = new Date(now + offset * 86400000)
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  }
  state.updatePrivateIndex(state.getSessionBinding(session.id).libraryId, (index) => {
    index.entries['mem-rb-dated-lost'] = {
      id: 'mem-rb-dated-lost', track: 'memory', layer: 'long_term', status: 'active',
      title: '明天要把镜头还给林眠', content: '说明天在城南咖啡店把镜头还给林眠。',
      salientDate: day(1), openLoop: true, visibility: 'shared', disclosure: 'can_tell', owner: 'me',
      createdAt: iso(-2), updatedAt: iso(-2),
    }
    index.entries['mem-rb-dated-loop'] = {
      id: 'mem-rb-dated-loop', track: 'memory', layer: 'long_term', status: 'active',
      title: '答应给林眠带咖啡豆', content: '一直没做，也没有约定日期。',
      openLoop: true, visibility: 'shared', disclosure: 'can_tell', owner: 'me',
      createdAt: iso(-5), updatedAt: iso(-5),
    }
  })

  await step(session, 1, [user(1, '明天有什么我要办的事')])
  const binding = state.getSessionBinding(session.id)
  assert.ok(Object.keys(binding.anniversariesShown || {}).length > 0 || (binding.injectedIds || []).length > 1,
    'the dated blocks recorded their own clocks on that turn')
  await failTurn(session, 1)
  const after = state.getSessionBinding(session.id)
  assert.equal(Object.keys(after.anniversariesShown || {}).length, 0, 'the day mark is withdrawn with the turn')
  assert.equal(Object.keys(after.openLoopRemindedAt || {}).length, 0, 'and so is the re-reminder clock')
})
