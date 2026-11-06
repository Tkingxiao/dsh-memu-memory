import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-speaker-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const inject = await import('../lib/inject.js')

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

test('speaker and source_kind are stored and default honestly', async () => {
  const { exec } = session('speaker-fields')
  const said = await memory.privateRemember({
    exec, title: '用户提到旅行', content: '我想去 Iceland 看极光。', source: 'user_said',
  })
  assert.equal(said.entry.speaker_id, 'user')
  assert.equal(said.entry.source_kind, 'user_said')

  const promised = await memory.privateRemember({
    exec, title: '助手答应查机票', content: '我明天帮你查去冰岛的机票。',
    sourceKind: 'assistant_said', speakerId: 'assistant',
    quoteSpan: { seq: 42, turn: 7, textHash: 'abc123' },
    storylineId: 'iceland-trip', branchId: 'branch-a', knownBy: ['user', 'assistant'],
  })
  assert.equal(promised.entry.source, 'assistant_said')
  assert.equal(promised.entry.source_kind, 'assistant_said')
  assert.equal(promised.entry.speaker_id, 'assistant')
  assert.deepEqual(promised.entry.quote_span, { seq: 42, turn: 7, textHash: 'abc123' })
  assert.equal(promised.entry.storyline_id, 'iceland-trip')
  assert.equal(promised.entry.branch_id, 'branch-a')
  assert.deepEqual(promised.entry.known_by, ['user', 'assistant'])

  const imagined = await memory.privateRemember({
    exec, title: '想象里的雪', content: '她想象过冰岛的雪落在窗台上。', source: 'imagined',
  })
  assert.equal(imagined.entry.source_kind, 'imagined')
  assert.equal(imagined.entry.speaker_id, 'unknown', 'an imagined memory cannot claim a speaker')

  const contextSpeaker = await memory.privateRemember({
    exec, title: '角色说过的话', content: '林说冰岛的冬天太长了。',
    source: 'user_said', context: { speakerId: 'character:lin' },
  })
  assert.equal(contextSpeaker.entry.speaker_id, 'character:lin', 'a bound speaker identity wins over the default')
})

test('a conflicting source/source_kind pair is refused, and so is a bad quote_span', async () => {
  const { exec } = session('speaker-invalid')
  await assert.rejects(
    () => memory.privateRemember({ exec, title: '矛盾来源', content: '测试。', source: 'user_said', sourceKind: 'assistant_said' }),
    /source and source_kind disagree/,
  )
  await assert.rejects(
    () => memory.privateRemember({ exec, title: '坏 span', content: '测试。', sourceKind: 'assistant_said', quoteSpan: { seq: -1 } }),
    /quote_span\.seq/,
  )
  await assert.rejects(
    () => memory.privateRemember({ exec, title: '坏说话人', content: '测试。', sourceKind: 'user_said', speakerId: '   ' }),
    /speaker_id/,
  )
})

test('a query that asks who said it filters recall by speaker', async () => {
  const { exec } = session('speaker-filter')
  const userSide = await memory.privateRemember({
    exec, title: '旅行计划 A', content: '旅行要去冰岛看极光。', source: 'user_said',
  })
  const assistantSide = await memory.privateRemember({
    exec, title: '旅行计划 B', content: '旅行去冰岛看极光，我来订票。', sourceKind: 'assistant_said',
  })
  const unknownSide = await memory.privateRemember({
    exec, title: '旅行计划 C', content: '旅行去冰岛看极光是旧念头。',
  })

  const mine = await memory.privateRecall({ exec, query: '我说过旅行去冰岛看极光', topK: 10, relevanceThreshold: 0 })
  const mineIds = mine.files.map((file) => file.name)
  assert.ok(mineIds.includes(userSide.id))
  assert.ok(!mineIds.includes(assistantSide.id), 'the assistant statement is not returned for 我说过')
  assert.ok(mineIds.includes(unknownSide.id), 'an entry without a speaker stays recallable')

  const yours = await memory.privateRecall({ exec, query: '你说过旅行去冰岛看极光', topK: 10, relevanceThreshold: 0 })
  const yourIds = yours.files.map((file) => file.name)
  assert.ok(yourIds.includes(assistantSide.id))
  assert.ok(!yourIds.includes(userSide.id), 'the user statement is not returned for 你说过')

  assert.equal(memory.detectSpeakerQuery('我说过要早点睡'), 'user')
  assert.equal(memory.detectSpeakerQuery('你说过会帮我查机票'), 'assistant')
  assert.equal(memory.detectSpeakerQuery('他说过要早点睡'), 'third')
  assert.equal(memory.detectSpeakerQuery('冰岛在哪里'), null)
})

test('the injected title card names a non-default speaker', async () => {
  const { exec, sessionId } = session('speaker-inject')
  await memory.privateRemember({
    exec, title: '助手答应订票', content: '助手答应明天订机票。', sourceKind: 'assistant_said',
  })
  const binding = state.getSessionBinding(sessionId)
  const recall = await inject.buildRecall(binding, '订票', 1, { ...state.getSettings(), relevanceThreshold: 0, privateTopK: 5 }, exec, sessionId)
  assert.deepEqual(recall.errors, [])
  assert.match(recall.text, /source=assistant_said/)
  assert.match(recall.text, /speaker=assistant/)
})
