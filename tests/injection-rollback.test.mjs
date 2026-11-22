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
process.env.DSH_HOME = home
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

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

async function accept(session, messages) {
  const history = session.messages ||= []
  for (const message of messages) {
    if (history.some(item => item.id === message.id)) continue
    history.push(message)
    if (message.role === 'user') await sessionEvent({ header: { id: session.id } }, { type: 'user/message', data: message })
  }
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
    anchor: binding.anchorPushed === true || (binding.injectedIds || []).includes(inject.ANCHOR_SENTINEL),
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
  assert.equal(placed.guide, null, 'the returned guide is only proposed')
  assert.equal(placed.anchor, false, 'the returned anchor is only proposed')
  assert.equal(placed.injected, 0, 'unadmitted refs do not enter history')
  assert.deepEqual(session.messages || [], [], 'Native history is still empty')

  await failTurn(session, 1)
  const rolled = facts(session.id)
  assert.equal(rolled.guide, null, 'guide key rolled back')
  assert.equal(rolled.anchor, false, 'anchor sentinel rolled back')
  assert.equal(rolled.injected, 0, 'the recall ids of that turn are forgotten too')
  assert.equal(rolled.rollback, null, 'the rollback record is consumed, not left to age')
  assert.ok(warns.some((line) => /discarded .* unadmitted injection proposals/.test(line)), 'discarding proposals leaves a log signal')
  const events = activity.listEvents({ limit: 50, kind: 'system' })
  assert.ok(events.some((event) => event.sessionId === session.id && /未接纳的记忆提案已丢弃/.test(event.message || '')),
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
  await accept(session, first)
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
  await accept(session, first)
  assert.equal(state.getSessionBinding(session.id).acceptedMemoryMessages.length, 2, 'each accepted message has its own immutable record')
  assert.equal(facts(session.id).rollback, null, 'proposals do not use legacy rollback accounting')

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
  await accept(session, first)
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

  const dated = await step(session, 1, [user(1, '明天有什么我要办的事')])
  assert.ok(dated.some(message => /memory-due|open loop/.test(textOf(message))), 'dated blocks were proposed')
  const binding = state.getSessionBinding(session.id)
  assert.equal(Object.keys(binding.anniversariesShown || {}).length, 0, 'unaccepted dated blocks do not mark a day')
  assert.equal(Object.keys(binding.openLoopRemindedAt || {}).length, 0, 'unaccepted nudges do not start cooldown')
  await failTurn(session, 1)
  const after = state.getSessionBinding(session.id)
  assert.equal(Object.keys(after.anniversariesShown || {}).length, 0, 'the day mark is withdrawn with the turn')
  assert.equal(Object.keys(after.openLoopRemindedAt || {}).length, 0, 'and so is the re-reminder clock')
})

test('the same real user message gets one injection pass when the host emits two enter decisions', async () => {
  const session = makeSession('dup-step')
  const first = await step(session, 221, [user(1, '林眠的相机镜头维修到哪一步了？')])
  await accept(session, first)
  const afterFirst = state.getSessionBinding(session.id)
  assert.equal(afterFirst.lastInjectedUserMessageId, 'u-1', 'the first pass marks the message it handled')
  const clockAfterFirst = afterFirst.inbound?.clock
  const injectedAfterFirst = facts(session.id).injected
  const pluginBlocks = (messages) => messages.filter((message) => message?.source?.kind === 'plugin:dsh-memu-memory').length
  const blocksAfterFirst = pluginBlocks(first)
  assert.ok(blocksAfterFirst > 0, 'the first pass actually injected something')

  // 宿主把同一条用户消息又交给了一次 enter 决策（turn 号成对跳），第二次不应再召回。
  const second = await step(session, 222, [...first])
  assert.equal(pluginBlocks(second), blocksAfterFirst, 'the duplicate pass adds no second memory block')
  const afterSecond = state.getSessionBinding(session.id)
  assert.equal(afterSecond.lastInjectedUserMessageId, 'u-1', 'the marker stays on the handled message')
  assert.equal(afterSecond.inbound?.clock, clockAfterFirst, 'the duplicate pass does not advance the memory clock')
  assert.equal(facts(session.id).injected, injectedAfterFirst, 'nor does it write new dedupe accounting')
})

test('a rolled-back turn clears the one-pass marker so a real retry injects again', async () => {
  const session = makeSession('dup-retry')
  const first = await step(session, 1, [user(1, '林眠的相机镜头修好了吗')])
  assert.equal(countWith(first, ANCHOR_RE), 1)
  assert.equal(state.getSessionBinding(session.id).lastInjectedUserMessageId, undefined, 'one-pass marker waits for history')

  await failTurn(session, 1)
  assert.equal(state.getSessionBinding(session.id).lastInjectedUserMessageId, undefined,
    'the rollback forgets the message so a real retry can inject again')

  const retry = await step(session, 1, [user(1, '林眠的相机镜头修好了吗')])
  assert.equal(countWith(retry, ANCHOR_RE), 1, 'the retry places the anchor again')
})

for (const kind of ['completed', 'error', 'aborted', 'stopped']) test(`${kind} ends unadmitted proposals; a late exact message cannot revive them`, async () => {
  const session = makeSession('end-' + kind)
  const first = await step(session, 1, [user(kind, '林眠的相机镜头修好了吗')])
  assert.equal(facts(session.id).injected, 0)
  await sessionEvent({ header: { id: session.id } }, { type: 'turn/end', data: { turn: 1, reason: { kind } } })
  for (const message of first.filter(item => item.source?.kind === 'plugin:dsh-memu-memory')) {
    await sessionEvent({ header: { id: session.id } }, { type: 'user/message', data: message })
  }
  assert.equal(facts(session.id).guide, null)
  assert.equal(facts(session.id).anchor, false)
  assert.equal(facts(session.id).injected, 0)
  assert.equal(state.getSessionBinding(session.id).inbound.pending.length, 1, 'unaccepted input stays retryable')
})

for (const acceptedPart of ['guide', 'recall']) test(`partial ${acceptedPart} admission never represents the other message`, async () => {
  const session = makeSession('partial-' + acceptedPart)
  const first = await step(session, 1, [user(acceptedPart, '林眠的相机镜头修好了吗')])
  const plugin = first.filter(message => message.source?.kind === 'plugin:dsh-memu-memory')
  const selected = plugin.find(message => GUIDE_RE.test(textOf(message)) === (acceptedPart === 'guide'))
  await accept(session, [selected])
  const before = facts(session.id)
  assert.equal(Boolean(before.guide), acceptedPart === 'guide')
  assert.equal(before.anchor, acceptedPart === 'recall')
  assert.equal(state.getSessionBinding(session.id).inbound.pending.length, 1, 'the real human has not entered history')
  await failTurn(session, 1)
  const after = facts(session.id)
  assert.deepEqual(after, before, 'model failure does not roll back admitted history')
  const late = plugin.find(message => message.id !== selected.id)
  await sessionEvent({ header: { id: session.id } }, { type: 'user/message', data: late })
  assert.deepEqual(facts(session.id), after, 'discarded partial sibling cannot commit late')
})

test('proposal reuse preserves post-human ordering and missing human projection without duplicate IDs', async () => {
  const session = makeSession('projection')
  const human = user('projection', '林眠的相机镜头修好了吗')
  const first = await step(session, 1, [human])
  const memory = first.find(message => ANCHOR_RE.test(textOf(message)))
  const second = await step(session, 1, [human])
  assert.equal(second.find(message => ANCHOR_RE.test(textOf(message))).id, memory.id)
  assert.ok(second.findIndex(message => message.id === memory.id) > second.findIndex(message => message.id === human.id),
    'memory sits after the human turn')
  const missing = await step(session, 1, [])
  assert.equal(missing.filter(message => message.id === human.id).length, 1, 'retry carries the pending human too')
  assert.equal(missing.filter(message => message.id === memory.id).length, 1)
  assert.ok(missing.findIndex(message => message.id === memory.id) > missing.findIndex(message => message.id === human.id))
  await accept(session, [human])
  const nativeAlready = await step(session, 1, [])
  assert.equal(nativeAlready.some(message => message.id === human.id), false, 'a Native-admitted human is not appended twice')
  assert.equal(nativeAlready.filter(message => message.id === memory.id).length, 1)
})

test('a reused proposal belongs to its latest turn without extending its original memory clock', async () => {
  const session = makeSession('reused-turn-owner')
  const human = user('turn-owner', '林眠的相机镜头修好了吗')
  const first = await step(session, 1, [human])
  const second = await step(session, 2, [human])
  assert.equal(second.find(message => ANCHOR_RE.test(textOf(message))).id, first.find(message => ANCHOR_RE.test(textOf(message))).id)
  await failTurn(session, 1)
  await accept(session, second)
  const binding = state.getSessionBinding(session.id)
  assert.equal(binding.anchorPushed, true, 'a late old-turn end cannot discard the current owner')
  assert.ok(binding.guideRulesKey)
  assert.ok(binding.acceptedMemoryMessages.every(record => record.hostTurn === 2))
  assert.ok(binding.acceptedMemoryMessages.every(record => record.memoryClock === 1), 'reusing does not extend cooldown')
})

test('digest/source mismatch and mutable returned bodies cannot commit a different proposal', async () => {
  const session = makeSession('digest')
  const first = await step(session, 1, [user('digest', '林眠的相机镜头修好了吗')])
  const memory = first.find(message => ANCHOR_RE.test(textOf(message)))
  await sessionEvent({ header: { id: session.id } }, { type: 'user/message', data: { ...memory, source: { kind: 'plugin:other' } } })
  const altered = { ...memory, content: [{ type: 'text', text: 'not the proposed body' }] }
  await sessionEvent({ header: { id: session.id } }, { type: 'user/message', data: altered })
  assert.equal(facts(session.id).anchor, false)
  const originalText = textOf(memory)
  memory.content[0].text = 'caller-mutated returned proposal body'
  const replay = await step(session, 1, [user('digest', '林眠的相机镜头修好了吗')])
  assert.equal(textOf(replay.find(message => message.id === memory.id)), originalText, 'stored body remains an independent snapshot')
  await accept(session, replay)
  assert.equal(facts(session.id).anchor, true)
})

test('a turn ending while recall awaits cannot publish a late proposal', async () => {
  const session = makeSession('inflight-end')
  const pending = step(session, 1, [user('inflight', '林眠的相机镜头修好了吗')])
  await completeTurn(session, 1)
  const out = await pending
  assert.equal(out.some(message => message.source?.kind === 'plugin:dsh-memu-memory'), false)
  assert.equal(facts(session.id).injected, 0)
})

test('typed effects and refs are independent; late rollback never erases new owner counters', async () => {
  const session = makeSession('owner-counters')
  const ref = { scope: 'private', libraryId: state.getSessionBinding(session.id).libraryId, id: 'same', revision: 'r1', entry: { content: 'do not store body' } }
  const actions = { patch: { replayIds: ['old'], textureKey: 'old', lastInjectedUserMessageId: 'old' }, anniversaries: { same: 'old-day' }, nudgeIds: ['same'] }
  const one = state.markInjectedRefs(session.id, [ref], 1, { messageId: 'owner-old', hostTurn: 1, actions })
  ref.revision = 'mutated'
  actions.patch.replayIds.push('mutated')
  one.effects.replayIds.value = ['mutated-return']
  one.refs[0].revision = 'mutated-return'
  const two = state.markInjectedRefs(session.id, [{ ...ref, revision: 'r2' }], 2, { messageId: 'owner-new', hostTurn: 2,
    actions: { patch: { replayIds: ['new'], textureKey: 'new', lastInjectedUserMessageId: 'new' }, anniversaries: { same: 'new-day' }, nudgeIds: ['same'] } })
  const before = state.getSessionBinding(session.id)
  assert.equal(before.acceptedMemoryMessages[0].refs[0].revision, 'r1')
  assert.equal(before.acceptedMemoryMessages[0].refs[0].entry, undefined)
  assert.deepEqual(two.effects.replayIds.value, ['old'])
  state.rollbackInjectionForTurn(session.id, 1, { messageIds: ['owner-old'] })
  const after = state.getSessionBinding(session.id)
  assert.deepEqual(after.replayIds, ['new'])
  assert.equal(after.textureKey, 'new')
  assert.equal(after.lastInjectedUserMessageId, 'new')
  assert.equal(after.anniversariesShown.same, 'new-day')
  assert.equal(after.openLoopRemindedAt.same, before.openLoopRemindedAt.same)
  assert.equal(after.injectedAt.same, 2)
  // A late older admission records history but cannot take ownership back.
  state.markInjectedRefs(session.id, [ref], 1, { messageId: 'owner-late', hostTurn: 1, actions })
  assert.equal(state.getSessionBinding(session.id).textureKey, 'new')
  assert.equal(state.getSessionBinding(session.id).anniversariesShown.same, 'new-day')
})

test('same-value legacy rewrites and a new epoch protect markers from old rollback', () => {
  const session = makeSession('legacy-owners')
  state.markInjected(session.id, ['same', '__anchor__'], 1)
  state.markAnniversaryShown(session.id, 'same', 'day')
  state.markOpenLoopReminded(session.id, 'same')
  state.setSessionBinding(session.id, { lastInjectedUserMessageId: 'human', guideRulesKey: 'rules', guideMessageAt: 'at' })
  state.recordInjectionRollback(session.id, { hostTurn: 1, ids: ['same', '__anchor__'], guideKey: 'rules', nudgeIds: ['same'], anniversaryIds: ['same'] })
  state.markInjected(session.id, ['same', '__anchor__'], 1)
  state.markAnniversaryShown(session.id, 'same', 'day')
  state.markOpenLoopReminded(session.id, 'same')
  state.setSessionBinding(session.id, { lastInjectedUserMessageId: 'human', guideRulesKey: 'rules', guideMessageAt: 'at' })
  state.rollbackInjectionForTurn(session.id, 1)
  const kept = state.getSessionBinding(session.id)
  assert.equal(kept.anchorPushed, true)
  assert.equal(kept.lastInjectedUserMessageId, 'human')
  assert.equal(kept.guideRulesKey, 'rules')
  assert.equal(kept.injectedAt.same, 1)
  assert.equal(kept.anniversariesShown.same, 'day')
  assert.ok(kept.openLoopRemindedAt.same)
  state.recordInjectionRollback(session.id, { hostTurn: 2, ids: ['same', '__anchor__'], guideKey: 'rules' })
  state.markReinjectPending(session.id)
  state.rollbackInjectionForTurn(session.id, 2)
  assert.equal(state.getSessionBinding(session.id).anchorPushed, true)
})
