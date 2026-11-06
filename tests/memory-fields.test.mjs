import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-temporal-fields-'))
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
    cwd,
    exec: { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'rp' } } } },
  }
}

function index(sessionId) {
  const binding = state.getSessionBinding(sessionId)
  return state.loadPrivateIndex(binding.libraryId)
}

test('a relative date is resolved against sceneTime and stored as fields', async () => {
  const { exec, sessionId } = session('fields-relative')
  const { id, entry } = await memory.privateRemember({
    exec, title: '明天出门带伞', content: '她说 明天 去学校门口见面。',
  })
  assert.equal(entry.absolute_date, '2026-11-07')
  assert.equal(entry.date_precision, 'day')
  assert.equal(entry.date_source, 'relative')
  assert.equal(entry.event_time, '2026-11-06T04:00:00.000Z')
  assert.equal(entry.observed_at, '2026-11-06T04:00:00.000Z')
  assert.equal(entry.content, '她说 明天 去学校门口见面。', 'the original wording is kept verbatim')
  const onDisk = index(sessionId).entries[id]
  assert.equal(onDisk.absolute_date, '2026-11-07', 'fields survive the index round trip')
})

test('context.occurredAt overrides sceneTime for the same write', async () => {
  const { exec } = session('fields-occurred')
  const { entry } = await memory.privateRemember({
    exec, title: '后天交材料', content: '后天把材料交到教务处。',
    context: { occurredAt: '2026-12-30T12:00:00+08:00' },
  })
  assert.equal(entry.absolute_date, '2027-01-01', 'crosses the year boundary in the scene time zone')
  assert.equal(entry.observed_at, '2026-12-30T04:00:00.000Z')
})

test('month-end and unresolved relative wording are marked, not guessed', async () => {
  const { exec } = session('fields-precision')
  const monthEnd = await memory.privateRemember({ exec, title: '月底对账', content: '月底前把账对完。' })
  assert.equal(monthEnd.entry.absolute_date, '2026-11-30')
  assert.equal(monthEnd.entry.date_precision, 'month')

  const fuzzy = await memory.privateRemember({ exec, title: '下周再说', content: '下周再讨论排期。' })
  assert.equal(fuzzy.entry.absolute_date, undefined)
  assert.equal(fuzzy.entry.date_precision, 'unknown')
  assert.equal(fuzzy.entry.date_source, 'relative')

  const none = await memory.privateRemember({ exec, title: '窗户开着', content: '窗外的雨停了。' })
  assert.equal(none.entry.absolute_date, undefined)
  assert.equal(none.entry.date_precision, undefined)
})

test('an explicit absolute_date overrides prose and an impossible date is refused', async () => {
  const { exec } = session('fields-explicit')
  const { entry } = await memory.privateRemember({
    exec, title: '聚会', content: '她说 明天 见。', absoluteDate: '2026-11-20',
  })
  assert.equal(entry.absolute_date, '2026-11-20')
  assert.equal(entry.date_source, 'explicit')
  await assert.rejects(
    () => memory.privateRemember({ exec, title: '错日期', content: '测试。', absoluteDate: '2026-02-30' }),
    /absolute_date must be YYYY-MM-DD/,
  )
})

test('valid_from / valid_to hide an entry outside its window and never hide old entries without them', async () => {
  const { exec, sessionId } = session('fields-validity')
  const expired = await memory.privateRemember({
    exec, title: '旧地址', content: '她住在旧公寓。', absoluteDate: '2026-10-01', validTo: '2026-10-31',
  })
  const upcoming = await memory.privateRemember({
    exec, title: '新地址', content: '她下个月搬去新公寓。', absoluteDate: '2026-12-01', validFrom: '2026-12-01',
  })
  const current = await memory.privateRemember({
    exec, title: '当前住处', content: '她现在住在河边的房子。', absoluteDate: '2026-11-01', validFrom: '2026-11-01', validTo: '2026-11-30',
  })
  const legacy = await memory.privateRemember({ exec, title: '没有日期的旧条目', content: '窗户是朝东的。' })
  assert.equal(expired.entry.valid_to, '2026-10-31')
  assert.equal(upcoming.entry.valid_from, '2026-12-01')

  const currentEligible = memory.isMemoryEligible(current.entry, { now: Date.parse('2026-11-06T12:00:00+08:00') })
  assert.equal(currentEligible, true)
  assert.equal(memory.isMemoryEligible(expired.entry, { now: Date.parse('2026-11-06T12:00:00+08:00') }), false)
  assert.equal(memory.isMemoryEligible(upcoming.entry, { now: Date.parse('2026-11-06T12:00:00+08:00') }), false)
  assert.equal(memory.isMemoryEligible(legacy.entry, { now: Date.parse('2026-11-06T12:00:00+08:00') }), true)

  const recalled = await memory.privateRecall({ exec, query: '公寓 住处 窗户', topK: 10, relevanceThreshold: 0 })
  const ids = recalled.files.map((file) => file.name)
  assert.ok(ids.includes(current.id), 'a valid entry is recalled')
  assert.ok(ids.includes(legacy.id), 'an entry without a window is not filtered')
  assert.ok(!ids.includes(expired.id), 'a past valid_to is filtered')
  assert.ok(!ids.includes(upcoming.id), 'a future valid_from is filtered')
  assert.equal(index(sessionId).entries[expired.id].valid_to, '2026-10-31', 'filtering is read-only')
})

test('rewriting the text re-derives the date; the query resolves relative words too', async () => {
  const { exec } = session('fields-query')
  const dated = await memory.privateRemember({
    exec, title: '带伞', content: '出门要带伞，午后有雨。', absoluteDate: '2026-11-07',
  })
  // The body never says "明天"; only the resolved date can connect the query to it.
  const recalled = await memory.privateRecall({ exec, query: '明天天气怎么样', topK: 10, relevanceThreshold: 0 })
  assert.ok(recalled.files.some((file) => file.name === dated.id), 'the query resolves 明天 to 2026-11-07')

  const updated = await memory.privateUpdate({
    exec, id: dated.id, content: '后天出门要带伞，午后有雨。',
  })
  assert.equal(updated.entry.absolute_date, '2026-11-08', 'a rewrite re-resolves the date')
  assert.equal(updated.entry.content, '后天出门要带伞，午后有雨。')
})
