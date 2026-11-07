import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-recall-intent-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

let seq = 0
function session(name) {
  seq += 1
  const cwd = path.join(home, 'ws', `${name}-${seq}`)
  const sessionId = `${name}-${seq}`
  state.ensureSession(sessionId, { cwd, agentPreset: 'rp' })
  return {
    sessionId,
    exec: { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'rp' } } } },
  }
}

test('a date question raises the candidate count; a general question keeps the requested topK', async () => {
  const { exec } = session('intent-topk')
  const topics = ['灯光', '投影仪', '白板', '咖啡机', '门禁', '椅子', '窗帘', '空调', '插座', '网络', '打印纸', '绿植']
  for (const [index, topic] of topics.entries()) {
    await memory.privateRemember({
      exec,
      title: `会议记录 ${index + 1}`,
      content: `会议室第 ${index + 1} 项：${topic}的情况需要跟进。`,
      absoluteDate: `2026-11-${String(index + 1).padStart(2, '0')}`,
    })
  }
  const general = await memory.privateRecall({ exec, query: '会议', topK: 3, relevanceThreshold: 0 })
  assert.equal(general.files.length, 3, 'general respects the requested three')

  const dated = await memory.privateRecall({ exec, query: '会议什么时候开', topK: 3, relevanceThreshold: 0 })
  assert.ok(dated.files.length > general.files.length, 'a date question asks for a bigger timeline')
  assert.ok(dated.files.length <= 8)
})

test('one-hop expansion follows an explicit link to a memory the query never matched', async () => {
  const { exec, sessionId } = session('intent-multihop')
  const a = await memory.privateRemember({
    exec, title: '林眠去了码头', content: '林眠傍晚一个人去了码头。',
  })
  const b = await memory.privateRemember({
    exec, title: '她带了一把旧伞', content: '那天她带着一把旧伞。',
  })
  const binding = state.getSessionBinding(sessionId)
  state.updatePrivateIndex(binding.libraryId, (index) => {
    index.entries[a.id].links = [{ to: b.id, kind: 'event', note: 'same evening', confidence: 0.9 }]
    index.entries[b.id].links = [{ to: a.id, kind: 'event', note: 'same evening', confidence: 0.9 }]
  })

  const recalled = await memory.privateRecall({ exec, query: '林眠到码头', topK: 2, relevanceThreshold: 0 })
  const ids = recalled.files.map((file) => file.name)
  assert.ok(ids.includes(a.id), 'the direct hit is recalled')
  assert.ok(ids.includes(b.id), 'the linked clue rides along one hop')
  assert.deepEqual(recalled.expanded, [{ from: a.id, to: b.id, kind: 'event' }])
  assert.ok(recalled.files.find((file) => file.name === b.id).relatedTo === a.id)
})

test('graph expansion only fills empty topK seats, never adds injected entries', async () => {
  const { exec, sessionId } = session('intent-multihop-budget')
  const a = await memory.privateRemember({
    exec, title: '码头灯塔记录', content: '林眠傍晚去了码头看灯塔。',
  })
  const b = await memory.privateRemember({
    exec, title: '灯塔亮起时间', content: '码头边的灯塔亮了三次。',
  })
  const linked = await memory.privateRemember({
    exec, title: '她带了一把旧伞', content: '那天她带着一把旧伞。',
  })
  const binding = state.getSessionBinding(sessionId)
  state.updatePrivateIndex(binding.libraryId, (index) => {
    index.entries[a.id].links = [{ to: linked.id, kind: 'event', note: 'same evening', confidence: 0.9 }]
  })
  const recalled = await memory.privateRecall({ exec, query: '码头 灯塔', topK: 2, relevanceThreshold: 0 })
  const ids = recalled.files.map((file) => file.name)
  assert.equal(recalled.files.length, 2, 'topK seats stay full; expansion cannot add a third')
  assert.ok(ids.includes(a.id) && ids.includes(b.id))
  assert.ok(!ids.includes(linked.id), 'the linked memory must wait until a seat is free')
  assert.equal(recalled.expanded, undefined)
})

test('automatic recall hides never_say and only_if_asked; boundary questions release only_if_asked', async () => {
  const { exec } = session('intent-disclosure')
  const open = await memory.privateRemember({
    exec, title: '账本放在书房', content: '账本放在书房第二个抽屉。',
  })
  const ask = await memory.privateRemember({
    exec, title: '账本记着一笔旧账', content: '账本里记着一笔他不愿提的旧账。', disclosure: 'only_if_asked',
  })
  const never = await memory.privateRemember({
    exec, title: '账本的真正来历', content: '账本其实是他父亲留下的。', disclosure: 'never_say',
  })

  const automatic = await memory.privateRecall({
    exec, query: '账本', topK: 10, relevanceThreshold: 0, purpose: 'automatic',
  })
  const autoIds = automatic.files.map((file) => file.name)
  assert.ok(autoIds.includes(open.id))
  assert.ok(!autoIds.includes(ask.id), 'only_if_asked waits for a direct question')
  assert.ok(!autoIds.includes(never.id), 'never_say never auto-surfaces')

  const explicit = await memory.privateRecall({ exec, query: '账本', topK: 10, relevanceThreshold: 0 })
  const explicitIds = explicit.files.map((file) => file.name)
  assert.ok(explicitIds.includes(ask.id) && explicitIds.includes(never.id), 'an explicit recall may still read them')

  const boundary = await memory.privateRecall({
    exec, query: '账本的秘密是什么', topK: 10, relevanceThreshold: 0, purpose: 'automatic',
  })
  const boundaryIds = boundary.files.map((file) => file.name)
  assert.ok(boundaryIds.includes(ask.id), 'a boundary question is the "asked" case')
  assert.ok(!boundaryIds.includes(never.id), 'never_say stays out even then')
})
