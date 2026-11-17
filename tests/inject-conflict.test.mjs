import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-conflict-inject-'))
process.env.DSH_HOME = home
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

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

  const recalled = await memory.privateRecall({ exec, query: '客厅地板颜色是什么', topK: 1, relevanceThreshold: 0, purpose: 'automatic' })
  const ids = recalled.files.map((file) => file.name)
  assert.ok(ids.includes(left.id) && ids.includes(right.id), 'topK=1 still yields the pair, not half a contradiction')
  assert.equal(recalled.conflictPairs.length, 1)
  const explicit = await memory.privateRecall({ exec, query: '客厅地板颜色是什么', topK: 1, relevanceThreshold: 0 })
  assert.equal(explicit.files.length, 1, 'explicit topK=1 returns one body, not a conflict pair')
  assert.equal(explicit.files[0].conflictComplete, false)
  assert.equal(explicit.files[0].related.find(item => item.kind === 'conflict')?.complete, false)
  assert.ok(!explicit.files[0].related.find(item => item.kind === 'conflict')?.content)

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

test('the card orders sides by local authority and observed time', () => {
  const card = conflictCard({
    factKey: 'home:living_floor_color',
    left: { id: 'mem-inferred', entry: { title: '木色', source_kind: 'inferred' } },
    right: { id: 'mem-user', entry: { title: '灰色', source_kind: 'user_said' } },
  })
  assert.match(card, /- A \[mem-user\]/, 'a direct quote is shown first')
  assert.match(card, /- B \[mem-inferred\]/)
  assert.ok(card.length <= 200)

  const newer = conflictCard({
    factKey: 'x',
    left: { id: 'mem-old', entry: { title: '旧', fact_authority: 1, observed_at: '2026-11-01' } },
    right: { id: 'mem-new', entry: { title: '新', fact_authority: 1, observed_at: '2026-11-05' } },
  })
  assert.match(newer, /- A \[mem-new\]/, 'equal authority falls back to the newer observation')
})

test('a conflict card that cannot fit is omitted atomically, never shown as one ordinary version', async () => {
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
  const build = await inject.buildRecall(binding, '旅行目的地', 1, {
    ...state.getSettings(), privateTopK: 5, relevanceThreshold: 0, turnTokens: 50,
  }, exec, sessionId)
  assert.equal(build.text, '')
  assert.deepEqual(build.ids, [])
  assert.deepEqual(build.refs, [])
  assert.equal(build.counts.budgetOmittedGroups, 1)
  assert.ok(!build.text.includes(`[${left.id}]`) && !build.text.includes(`[${right.id}]`))
})

test('a compact conflict group preserves both ids and uncertainty within the token budget', async () => {
  const { exec, sessionId } = session('compact-pair')
  const a = await memory.privateRemember({ exec, title: '长标题'.repeat(30), content: '计划去冰岛。', factKey: 'trip:' + 'x'.repeat(160) })
  const b = await memory.privateRemember({ exec, title: '长标题乙'.repeat(30), content: '计划改去挪威。', factKey: 'trip:' + 'x'.repeat(160) })
  const build = await inject.buildRecall(state.getSessionBinding(sessionId), '计划旅行', 1, { ...state.getSettings(), privateTopK: 1, turnTokens: 110, relevanceThreshold: 0 }, exec, sessionId)
  assert.match(build.text, /未确认哪版为准/)
  assert.ok(build.text.includes(`[${a.id}]`) && build.text.includes(`[${b.id}]`))
  assert.equal(build.groups.length, 1)
  assert.equal(build.refs.length, 2)
  assert.ok(estTokens(build.text) <= 110)
})

test('an unavailable conflict version is explicitly uncertain and does not disclose its title', async () => {
  const { exec, sessionId } = session('invisible-version')
  const binding = state.getSessionBinding(sessionId)
  state.savePrivateIndex(binding.libraryId, { entries: {
    'mem-visible-version': { title: '客厅地板颜色记录', content: '客厅地板是木色。', layer: 'long_term', status: 'active', strength: 1, conflicts_with: 'mem-invisible-version' },
    'mem-invisible-version': { title: '不能泄露的版本标题', content: '另一个私密版本内容', layer: 'long_term', status: 'active', strength: 1, visibility: 'secret', conflicts_with: 'mem-visible-version' },
  } })
  const build = await inject.buildRecall(binding, '客厅地板颜色', 1, { ...state.getSettings(), privateTopK: 1, relevanceThreshold: 0, turnTokens: 800 }, exec, sessionId)
  assert.match(build.text, /不可见\/不可用版本/)
  assert.match(build.text, /未确认哪版为准/)
  assert.ok(!build.text.includes('不能泄露') && !build.text.includes('私密版本内容'))
  assert.deepEqual(build.refs.map(ref => ref.id), ['mem-visible-version'])
  assert.equal(build.groups[0].complete, false)
})

test('a changed conflict member reintroduces the complete group even when its partner was seen', async () => {
  const { exec, sessionId } = session('changed-conflict')
  const a = await memory.privateRemember({ exec, title: '客厅地板木色', content: '客厅地板是木色。', factKey: 'floor:color' })
  const b = await memory.privateRemember({ exec, title: '客厅地板灰色', content: '客厅地板是灰色。', factKey: 'floor:color' })
  const binding = state.getSessionBinding(sessionId)
  const initial = await memory.privateRecall({ exec, query: '客厅地板', topK: 1, relevanceThreshold: 0, purpose: 'automatic' })
  state.markInjectedRefs(sessionId, initial.refs, 1, { messageId: 'admitted-conflict-before-change', hostTurn: 1 })
  state.updatePrivateIndex(binding.libraryId, index => { index.entries[b.id].content += ' 后来确认使用瓷砖。' })
  const result = await memory.privateRecall({ exec, query: '客厅地板', topK: 1, relevanceThreshold: 0, purpose: 'automatic', excludedRefs: state.recentMemoryRefs(state.getSessionBinding(sessionId), 2, 16) })
  assert.deepEqual(new Set(result.files.map(file => file.name)), new Set([a.id, b.id]))
  assert.equal(result.groups.length, 1)
  assert.equal(result.groups[0].reintroducedForConflict, true)
  assert.equal(result.trace.counts.selectedRows, 2)
  assert.equal(result.trace.counts.selectedGroups, 1)
})

test('large conflict cycles are bounded and omitted instead of splitting a fact into ordinary versions', async () => {
  const { exec, sessionId } = session('large-conflict-cycle')
  const binding = state.getSessionBinding(sessionId)
  const entries = {}
  for (let i = 0; i < 9; i++) entries['mem-cycle-' + i] = { title: '冲突链节点' + i, content: '冲突关系的第' + i + '个版本', layer: 'long_term', status: 'active', strength: 1, conflicts_with: 'mem-cycle-' + ((i + 1) % 9) }
  state.savePrivateIndex(binding.libraryId, { entries })
  const result = await memory.privateRecall({ exec, query: '冲突关系', topK: 2, relevanceThreshold: 0, purpose: 'automatic' })
  assert.deepEqual(result.files, [])
  assert.equal(result.trace.counts.oversizedGroups, 1)
  assert.equal(result.omittedGroups[0].members, 9)
})
