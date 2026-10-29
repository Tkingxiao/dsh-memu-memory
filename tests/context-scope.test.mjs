import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-scope-'))
process.env.DSH_MEMU_HOME = home
const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const { dispatch } = await import('../lib/rpc.js')
test.after(() => { state.flushState(); fs.rmSync(home, { recursive: true, force: true }) })
function exec(id) { return { agent: { session: { header: { id } } } } }
for (const id of ['a', 'b']) state.ensureSession(id, { cwd: path.join(home, 'shared-rp'), agentPreset: 'rp' })

test('same-title claims from distinct speakers do not become contradictions', async () => {
  const a = await memory.privateRemember({ exec: exec('a'), title: '饮品偏好', content: '小甲喜欢红茶。', context: { speakerId: 'user-a' } })
  const b = await memory.privateRemember({ exec: exec('a'), title: '饮品偏好', content: '小乙不喜欢红茶。', context: { speakerId: 'user-b' } })
  assert.equal(a.entry.status, 'active')
  assert.equal(b.entry.status, 'active')
})

test('world, branch and channel isolate every recall and list surface', async () => {
  await dispatch({}, 'setMemoryContext', { sessionId: 'a', context: { channelId: 'group-1', characterId: 'hero', worldId: 'world-1', branchId: 'west' } })
  await dispatch({}, 'setMemoryContext', { sessionId: 'b', context: { channelId: 'group-2', characterId: 'hero', worldId: 'world-1', branchId: 'west' } })
  const secret = await memory.privateRemember({ exec: exec('a'), title: '剧场钥匙', content: '剧场钥匙在台灯旁。', context: { knownBy: ['hero'] } })
  assert.ok((await memory.privateRecall({ exec: exec('a'), query: secret.id })).files.length)
  assert.equal((await memory.privateRecall({ exec: exec('b'), query: secret.id })).files.length, 0)
  assert.ok(!(await memory.privateList({ exec: exec('b') })).files.some(file => file.name === secret.id))
  await dispatch({}, 'setMemoryContext', { sessionId: 'b', context: { channelId: 'group-1', characterId: 'hero', worldId: 'world-1', branchId: 'east' } })
  assert.equal((await memory.privateRecall({ exec: exec('b'), query: secret.id })).files.length, 0)
  await assert.rejects(memory.privateRemember({ exec: exec('b'), content: 'scope bypass', context: { branchId: 'west' } }), /cannot widen/)
  await assert.rejects(memory.privateRemember({ exec: exec('b'), content: 'scope widening', context: { branchId: '' } }), /cannot widen/)
})

test('knownBy is a character knowledge boundary, not a relationship score', async () => {
  await dispatch({}, 'setMemoryContext', { sessionId: 'a', context: { characterId: 'hero' } })
  const record = await memory.privateRemember({ exec: exec('a'), title: '反派的计划', content: '叙事者记录了反派的计划，主角不知道。', context: { knownBy: ['villain'] } })
  assert.equal((await memory.privateRecall({ exec: exec('a'), query: record.id })).files.length, 0)
  assert.ok(!(await memory.privateList({ exec: exec('a') })).files.some(file => file.name === record.id))
})
