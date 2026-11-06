import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-conflict-inject-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const inject = await import('../lib/inject.js')
const { conflictCard } = await import('../lib/snippet.js')
const { estTokens } = await import('../lib/budget.js')

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

test('a recalled conflict brings both sides and one compact card', async () => {
  const { exec, sessionId } = session('conflict-inject')
  const left = await memory.privateRemember({
    exec, title: '客厅地板是木色', content: '客厅地板是木色的，去年刚铺的。',
    factKey: 'home:living_floor_color', absoluteDate: '2026-10-01',
  })
  const right = await memory.privateRemember({
    exec, title: '客厅地板是灰色', content: '客厅地板不是木色，是灰色瓷砖。',
    factKey: 'home:living_floor_color', absoluteDate: '2026-11-05',
  })

  const recalled = await memory.privateRecall({ exec, query: '客厅地板颜色是什么', topK: 1, relevanceThreshold: 0 })
  const ids = recalled.files.map((file) => file.name)
  assert.ok(ids.includes(left.id) && ids.includes(right.id), 'topK=1 still yields the pair, not half a contradiction')
  assert.equal(recalled.conflictPairs.length, 1)

  const binding = state.getSessionBinding(sessionId)
  const build = await inject.buildRecall(binding, '客厅地板颜色是什么', 1, {
    ...state.getSettings(), privateTopK: 1, relevanceThreshold: 0, turnTokens: 800,
  }, exec, sessionId)
  assert.deepEqual(build.errors, [])
  assert.match(build.text, /冲突 · home:living_floor_color/)
  assert.match(build.text, /未确认哪版为准/)
  assert.ok(build.text.includes(`[${left.id}]`) && build.text.includes(`[${right.id}]`))
  assert.ok(build.ids.includes(left.id) && build.ids.includes(right.id))
  // The pair is rendered once as a card, not again as two ordinary title cards.
  assert.equal(build.text.split(`[${left.id}]`).length - 1, 1)
  assert.ok(estTokens(build.text) <= 800)
})

test('the card text stays under 200 characters even with long titles', () => {
  const long = '很长的标题'.repeat(40)
  const card = conflictCard({
    factKey: 'home:living_floor_color',
    left: { id: 'mem-a', entry: { title: long, absolute_date: '2026-10-01' } },
    right: { id: 'mem-b', entry: { title: long, absolute_date: '2026-11-05' } },
  })
  assert.ok(card.length <= 200, `card length ${card.length}`)
  assert.ok(card.includes('[mem-a]') && card.includes('[mem-b]'))
  assert.equal(conflictCard({ left: null, right: null }), '')
})

test('a conflict card that cannot fit falls back to the ordinary title cards', async () => {
  const { exec, sessionId } = session('conflict-budget')
  const longTitle = '非常长的旅行目的地描述'.repeat(8)
  const longKey = 'trip:' + 'x'.repeat(180)
  const left = await memory.privateRemember({
    exec, title: longTitle, content: '说好去冰岛。', factKey: longKey,
  })
  const right = await memory.privateRemember({
    exec, title: longTitle + '乙', content: '说好不去冰岛，去挪威。', factKey: longKey,
  })
  const binding = state.getSessionBinding(sessionId)
  // The card's fact_key + two long titles cannot fit; a one-line title card still can.
  const build = await inject.buildRecall(binding, '旅行目的地', 1, {
    ...state.getSettings(), privateTopK: 5, relevanceThreshold: 0, turnTokens: 150,
  }, exec, sessionId)
  assert.deepEqual(build.errors, [])
  assert.equal(build.text.includes('冲突 ·'), false)
  assert.ok(build.text.length > 0)
  assert.ok(build.ids.length >= 1)
  assert.ok([left.id, right.id].some((id) => build.text.includes(`[${id}]`)))
})
