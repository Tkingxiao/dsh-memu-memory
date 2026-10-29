import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-wiring-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const inject = await import('../lib/inject.js')
const activity = await import('../lib/activity-log.js')
const { requestPrivateConsolidation } = await import('../lib/private.js')
const { record } = activity

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

test.beforeEach(() => {
  activity.clearEvents()
  state.updateSettings({ memoryBackend: 'agent', vectorSource: 'local', relevanceThreshold: 0, sleepConsolidation: false })
})

function bind(sessionId) {
  const cwd = path.join(home, 'ws', sessionId)
  state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  return { cwd, exec: { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding' } } } } }
}

test('a private write lands in the activity log with its id', async () => {
  const { exec } = bind('wiring-write')
  const written = await memory.privateRemember({ exec, content: '写入链路必须留一条日志', title: '写入链路' })
  const rows = activity.listEvents({ kind: 'write' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].scope, 'private')
  assert.equal(rows[0].sessionId, 'wiring-write')
  assert.deepEqual(rows[0].refs, [written.id])
  assert.match(rows[0].message, /写入/)
  assert.ok(rows[0].libraryId, 'the library is recorded so the log row can be traced back')
})

test('a turn recall records the ids it injected and the route it took', async () => {
  const { exec } = bind('wiring-recall')
  const written = await memory.privateRemember({ exec, content: '海边的黄昏散步', title: '海边的黄昏' })
  activity.clearEvents()
  const binding = state.getSessionBinding('wiring-recall')
  const result = await inject.buildRecall(binding, '海边的黄昏', 1, state.getSettings(), exec, 'wiring-recall')
  const rows = activity.listEvents({ kind: 'recall' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sessionId, 'wiring-recall')
  assert.equal(rows[0].ok, true)
  assert.deepEqual(rows[0].detail.ids, result.ids)
  assert.deepEqual(rows[0].refs, result.ids)
  assert.ok(result.ids.includes(written.id), 'the seeded memory is what got recalled')
  assert.equal(rows[0].detail.route, undefined, 'the route is reported per layer')
  assert.ok(['local', 'managed-vector-rrf'].includes(rows[0].detail.privateRoute))
})

test('a recall with a degraded semantic leg is logged as not-ok', async () => {
  const { exec } = bind('wiring-recall-error')
  state.updateSettings({ memoryBackend: 'api', vectorSource: 'local' })
  const binding = state.getSessionBinding('wiring-recall-error')
  const result = await inject.buildRecall(binding, 'anything', 1, state.getSettings(), exec, 'wiring-recall-error')
  const [row] = activity.listEvents({ kind: 'recall' })
  assert.equal(row.ok, false)
  assert.ok(row.detail.errors.length > 0)
  assert.ok(result.errors.length > 0, 'the caller still sees the error')
})

test('a consolidation that cannot start is logged with its reason', async () => {
  bind('wiring-consolidate')
  const result = await requestPrivateConsolidation({ get: () => undefined }, 'wiring-consolidate')
  assert.equal(result.ok, false)
  const [row] = activity.listEvents({ kind: 'consolidate' })
  assert.equal(row.ok, false)
  assert.equal(row.sessionId, 'wiring-consolidate')
  assert.equal(row.level, 'error')
  assert.match(row.message, /整理失败/)
  assert.match(row.message, /readSession/)
})

test('a vector write outside an active generation is logged as a warning', async () => {
  const { exec } = bind('wiring-vector')
  state.updateSettings({ memoryBackend: 'api', vectorSource: 'local' })
  await memory.privateRemember({ exec, content: '没有代际时也要落库', title: '退化写入' })
  const rows = activity.listEvents({ kind: 'vector' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].level, 'warn')
  assert.match(rows[0].message, /降级/)
})

test('the log stays queryable by session and kind together', async () => {
  const a = bind('wiring-a')
  const b = bind('wiring-b')
  await memory.privateRemember({ exec: a.exec, content: 'a 的写入', title: 'a' })
  await memory.privateRemember({ exec: b.exec, content: 'b 的写入', title: 'b' })
  record({ kind: 'recall', sessionId: 'wiring-a', message: 'a 的召回' })
  assert.equal(activity.listEvents({ sessionId: 'wiring-a' }).length, 2)
  assert.equal(activity.listEvents({ sessionId: 'wiring-a', kind: 'write' }).length, 1)
})
