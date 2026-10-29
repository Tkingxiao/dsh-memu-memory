// Task C: the statistics are a sidecar. These cases pin three things: the counters
// follow what actually happened (write / recall / inject / archive), the daily
// series is zero-filled and never renders NaN on an empty library, and a damaged
// stats file degrades the page without touching the memories.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-stats-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const stats = await import('../lib/stats.js')
const memory = await import('../lib/memory.js')
const { dispatch } = await import('../lib/rpc.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function fixture(name) {
  const cwd = path.join(home, name)
  const lib = state.createLibrary({ name, cwd })
  state.ensureSession(`${name}-session`, { cwd, libraryId: lib.id })
  const exec = { agent: { session: { header: { id: `${name}-session`, cwd, agentPreset: 'coding' } } } }
  return { lib, cwd, exec }
}

test('counters follow writes, recalls, injections and archives', async () => {
  const { lib, exec } = fixture('stats-counts')
  const written = await memory.privateRemember({
    exec,
    content: '周五下午不要安排会议，留给整理下周计划',
    title: '周五整理',
    source: 'user_said',
  })
  // A tool-driven recall is attention the user asked for; it counts as recalled.
  await memory.privateRecall({ exec, query: '周五 会议 计划', relevanceThreshold: 0 })
  // Being pushed into the prompt is the other half.
  memory.noteInjected({ libraryId: lib.id, ids: [written.id] })
  memory.privateArchive({ exec, id: written.id })

  const view = await dispatch({}, 'getStats', { libraryId: lib.id, days: 30 })
  assert.equal(view.totals.written, 1, 'one write')
  assert.ok(view.totals.recalled >= 1, 'the recall surfaced the entry, got ' + view.totals.recalled)
  assert.equal(view.totals.injected, 1, 'one injection of one entry')
  assert.equal(view.totals.archived, 1, 'the archive button counts')
  assert.equal(view.health.archived, 1, 'and the health block agrees')
  assert.equal(view.health.active, 0, 'archived entries are not live')
})

test('a library with no memories still renders zeros, never NaN', async () => {
  const { lib } = fixture('stats-empty')
  const view = await dispatch({}, 'getStats', { libraryId: lib.id, days: 30 })
  assert.equal(view.available, true, 'no stats file yet is not an error')
  assert.equal(view.days.length, 30, 'the series is still thirty days long')
  for (const day of view.days) {
    for (const key of ['written', 'injected', 'recalled', 'archived']) {
      assert.equal(day[key], 0, `${day.date} ${key} is zero`)
    }
  }
  assert.equal(view.health.total, 0)
  assert.equal(view.health.avgStrength, 0)
  assert.deepEqual(view.distribution, [])
  assert.deepEqual(view.stale, [])
  assert.deepEqual(view.ratio, { windowDays: 7, written: 0, injected: 0 })
  assert.ok(!JSON.stringify(view).includes('NaN'), 'no NaN leaked into the payload')
  assert.ok(!JSON.stringify(view).includes('Infinity'), 'Math.max(...[]) must not leak -Infinity')
})

test('the daily series rolls at 90 days and the page only asks for 30', () => {
  const now = new Date('2026-10-28T12:00:00')
  for (let i = 0; i < 120; i += 1) {
    stats.bumpStats('lib-roll', 'written', 1, now.getTime() - i * 86_400_000)
  }
  const loaded = stats.loadStats('lib-roll')
  const keys = Object.keys(loaded.days).sort()
  assert.equal(keys.length, stats.STATS_KEPT_DAYS, 'older days are trimmed on write')
  assert.equal(keys[0], '2026-07-31', 'the window starts 89 days before the last write')
  const view = stats.statsView({ libraryId: 'lib-roll', entries: {}, days: 30, now: now.getTime() })
  assert.equal(view.days.length, 30, 'the page receives thirty days, not ninety')
  assert.equal(view.days.at(-1).date, '2026-10-28')
})

test('a damaged stats file degrades the page, not the memories', async () => {
  const { lib, exec } = fixture('stats-broken')
  fs.mkdirSync(path.join(home, 'index'), { recursive: true })
  fs.writeFileSync(stats.statsPath(lib.id), '{"days": ', 'utf8')

  const view = await dispatch({}, 'getStats', { libraryId: lib.id })
  assert.equal(view.available, false, 'the page is told the numbers are missing')
  assert.equal(view.days.length, 30, 'and still gets a drawable zero series')

  // The memory path must not care: writing, listing and recalling still work.
  const written = await memory.privateRemember({ exec, content: '统计坏了也要能写记忆', title: '仍然可写' })
  assert.ok(written.id)
  const list = await memory.privateList({ exec })
  assert.equal(list.files.length, 1, 'the memory was written despite the broken sidecar')
  await memory.privateRecall({ exec, query: '写记忆', relevanceThreshold: 0 })
  assert.equal(fs.readFileSync(stats.statsPath(lib.id), 'utf8'), '{"days": ', 'a broken statistics sidecar is left intact')
})

test('a local archive through an edit counts once', async () => {
  const { lib, exec } = fixture('stats-edit-archive')
  const first = await memory.privateRemember({ exec, content: '一条会被编辑归档的记忆', title: '编辑归档' })
  await memory.privateUpdate({ exec, id: first.id, status: 'archived' })
  await memory.privateUpdate({ exec, id: first.id, status: 'archived' })
  const view = await dispatch({}, 'getStats', { libraryId: lib.id })
  assert.equal(view.totals.archived, 1, 'the same transition does not count twice')
})
