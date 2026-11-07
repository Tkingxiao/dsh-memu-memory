import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-fact-version-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

let seq = 0
function session(name, sceneTime = '2026-11-06T04:00:00.000Z') {
  seq += 1
  const cwd = path.join(home, 'ws', `${name}-${seq}`)
  const sessionId = `${name}-${seq}`
  state.ensureSession(sessionId, { cwd, agentPreset: 'rp' })
  state.setSessionBinding(sessionId, { sceneTime })
  return {
    sessionId,
    exec: { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'rp' } } } },
  }
}

function entries(sessionId) {
  const binding = state.getSessionBinding(sessionId)
  return state.loadPrivateIndex(binding.libraryId).entries
}

test('two statements about one fact coexist, cross-linked, with both bodies intact', async () => {
  const { exec, sessionId } = session('fact-conflict')
  const first = await memory.privateRemember({
    exec, title: '客厅地板颜色', content: '客厅地板是木色的，去年刚铺的。',
    factKey: 'home:living_floor_color',
  })
  assert.equal(first.entry.fact_key, 'home:living_floor_color')
  assert.equal(first.entry.version, 1)

  const second = await memory.privateRemember({
    exec, title: '客厅地板颜色改口', content: '客厅地板不是木色，是灰色瓷砖。',
    factKey: 'home:living_floor_color',
  })
  assert.equal(second.entry.status, 'active', 'a conflict pair is not held for review')
  assert.equal(second.entry.version, 2)
  assert.equal(second.entry.conflicts_with, first.id)
  assert.equal(second.conflictsWith, first.id)

  const stored = entries(sessionId)
  assert.equal(stored[first.id].status, 'active')
  assert.equal(stored[first.id].conflicts_with, second.id, 'the pair points both ways')
  assert.equal(stored[first.id].content, '客厅地板是木色的，去年刚铺的。', 'the old claim keeps its exact wording')
  assert.equal(stored[second.id].content, '客厅地板不是木色，是灰色瓷砖。')
})

test('explicit supersede retires the old row without deleting its text', async () => {
  const { exec, sessionId } = session('fact-supersede')
  const first = await memory.privateRemember({
    exec, title: '缴费日', content: '物业费每月5号缴。', factKey: 'home:fee_day',
  })
  const second = await memory.privateRemember({
    exec, title: '缴费日补充', content: '物业费每月5号缴，遇节假日顺延。', factKey: 'home:fee_day',
  })
  // The second statement conflicting with the first creates v2; then an explicit
  // correction supersedes v2.
  const third = await memory.privateRemember({
    exec, title: '缴费日最终确认', content: '物业费改成每月10号缴。',
    factKey: 'home:fee_day', supersedes: second.id,
  })
  assert.equal(third.entry.status, 'active')
  assert.equal(third.entry.version, 3)
  assert.equal(third.entry.supersedes, second.id)
  assert.equal(third.supersedes, second.id)

  const stored = entries(sessionId)
  assert.equal(stored[second.id].status, 'superseded')
  assert.equal(stored[second.id].content, '物业费每月5号缴，遇节假日顺延。', 'the superseded body is still there')
  assert.equal(stored[second.id].valid_to, '2026-11-06')
  assert.equal(stored[second.id].supersededBy, third.id)
  assert.equal(stored[first.id].content, '物业费每月5号缴。')

  const recalled = await memory.privateRecall({ exec, query: '物业费缴费日', topK: 10, relevanceThreshold: 0 })
  const ids = recalled.files.map((file) => file.name)
  assert.ok(ids.includes(third.id), 'the current version is recallable')
  assert.ok(!ids.includes(second.id), 'the superseded version is not recalled as current truth')
  assert.ok(ids.includes(first.id), 'the earliest version is kept unless it was superseded too')
})

test('a compatible supplement updates the same id and does not create a version', async () => {
  const { exec } = session('fact-supplement')
  const first = await memory.privateRemember({
    exec, title: '咖啡口味', content: '他只喝黑咖啡。', factKey: 'user:coffee',
  })
  const before = entries(exec.agent.session.header.id)[first.id]
  const updated = await memory.privateUpdate({
    exec, id: first.id, content: '他只喝黑咖啡，不加糖也不加奶。',
  })
  assert.equal(updated.id, first.id)
  assert.equal(updated.entry.version, before.version, 'a compatible supplement is not a new version')
  assert.equal(updated.entry.fact_key, 'user:coffee')
})

test('relation targets must exist, be active and share the scope', async () => {
  const { exec, sessionId } = session('fact-targets')
  const active = await memory.privateRemember({ exec, title: '在用的条目', content: '这条还在用。' })
  await assert.rejects(
    () => memory.privateRemember({ exec, title: '坏目标', content: '测试。', conflictsWith: 'mem-nope' }),
    /unknown memory/,
  )
  await memory.privateUpdate({ exec, id: active.id, status: 'archived' })
  await assert.rejects(
    () => memory.privateRemember({ exec, title: '归档目标', content: '测试。', conflictsWith: active.id }),
    /only an active memory/,
  )
  const stored = entries(sessionId)
  assert.ok(!Object.values(stored).some((entry) => entry.title === '坏目标'), 'nothing is written when the target is invalid')
})

test('explicit provenance derives local authority and evidence without extra card text', async () => {
  const { exec } = session('fact-authority')
  const quoted = await memory.privateRemember({
    exec, title: '报价确认', content: '他确认报价是三十万。',
    source: 'user_said', quoteSpan: { seq: 8, turn: 2, textHash: 'abc' },
  })
  assert.equal(quoted.entry.fact_authority, 3)
  assert.deepEqual(quoted.entry.fact_evidence, { seq: 8, turn: 2, textHash: 'abc' })

  const guessed = await memory.privateRemember({
    exec, title: '报价猜测', content: '我猜报价大概是三十万。',
  })
  assert.equal(guessed.entry.fact_authority, 1)

  const corrected = await memory.privateUpdate({ exec, id: guessed.id, source: 'user_said' })
  assert.equal(corrected.entry.fact_authority, 3, 'correcting provenance re-derives authority')
})

test('a derived fact_key is stored even without an explicit key', async () => {
  const { exec } = session('fact-derived')
  const { entry } = await memory.privateRemember({ exec, title: '窗台的绿萝', content: '窗台有一盆绿萝。' })
  assert.match(entry.fact_key, /^me:窗台的绿萝$/)
  assert.equal(entry.version, 1)
})
