import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-activity-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const activity = await import('../lib/activity-log.js')
const paths = await import('../lib/paths.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

test.beforeEach(() => {
  activity.clearEvents()
  activity.resetActivityLogCache()
  paths.setWarnSink(null)
})

test('records newest first and persists a JSONL line', () => {
  activity.record({ kind: 'recall', scope: 'private', sessionId: 's1', libraryId: 'lib', message: 'first' })
  activity.record({ kind: 'write', sessionId: 's1', message: 'second', detail: { ids: ['mem-1'] }, refs: ['mem-1'] })
  const rows = activity.listEvents()
  assert.deepEqual(rows.map(row => row.message), ['second', 'first'])
  assert.deepEqual(rows[0].refs, ['mem-1'])
  const file = path.join(home, 'logs', 'activity.jsonl')
  assert.ok(fs.existsSync(file))
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2)
})

test('filters by kind, session, scope and free text', () => {
  activity.record({ kind: 'recall', scope: 'private', sessionId: 'a', message: 'recall a', detail: { route: 'managed-vector-rrf' } })
  activity.record({ kind: 'recall', scope: 'global', sessionId: 'b', message: 'recall b', detail: { route: 'local' } })
  activity.record({ kind: 'write', scope: 'private', sessionId: 'a', message: 'write a' })
  assert.equal(activity.listEvents({ kind: 'recall' }).length, 2)
  assert.equal(activity.listEvents({ kind: 'recall', sessionId: 'b' }).length, 1)
  assert.equal(activity.listEvents({ scope: 'private' }).length, 2)
  assert.equal(activity.listEvents({ q: 'managed-vector' }).length, 1)
  assert.equal(activity.listEvents({ q: 'nothing-here' }).length, 0)
})

test('secrets are redacted before they reach the file', () => {
  activity.record({
    kind: 'error',
    message: 'failed with sk-abcdefghijklmnop and Bearer abcdefghijklmnop',
    detail: { apiKey: 'sk-zyxwvutsrqponmlk', note: 'Authorization: Bearer abcdefghijklmnopqrst' },
  })
  const [row] = activity.listEvents()
  const text = JSON.stringify(row)
  assert.doesNotMatch(text, /sk-abcdefghijklmnop/)
  assert.doesNotMatch(text, /Bearer abcdefghijklmnop/)
  assert.match(text, /REDACTED/)
})

test('long messages and details are clipped instead of bloating the log', () => {
  activity.record({ kind: 'write', message: 'x'.repeat(5000), detail: { body: 'y'.repeat(9000) } })
  const [row] = activity.listEvents()
  assert.ok(row.message.length <= 300)
  assert.ok(JSON.stringify(row.detail).length <= 4001)
})

test('a corrupt log starts empty and leaves a warning instead of throwing', () => {
  activity.clearEvents()
  const file = path.join(home, 'logs', 'activity.jsonl')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{not json\n', 'utf8')
  activity.resetActivityLogCache()
  const warnings = []
  paths.setWarnSink(message => warnings.push(String(message)))
  assert.deepEqual(activity.listEvents(), [])
  assert.equal(warnings.length, 0, 'a bad line is skipped silently, not treated as an error')
  const entry = activity.record({ kind: 'recall', message: 'after corruption' })
  assert.ok(entry)
  assert.equal(activity.listEvents()[0].message, 'after corruption')
})

test('an unwritable directory degrades to memory-only and warns once', () => {
  activity.clearEvents()
  const warnings = []
  paths.setWarnSink(message => warnings.push(String(message)))
  const original = fs.appendFileSync
  fs.appendFileSync = () => { throw Object.assign(new Error('EACCES: fixture'), { code: 'EACCES' }) }
  try {
    activity.record({ kind: 'write', message: 'one' })
    activity.record({ kind: 'write', message: 'two' })
  } finally {
    fs.appendFileSync = original
  }
  assert.deepEqual(activity.listEvents().map(row => row.message), ['two', 'one'], 'memory keeps working')
  assert.equal(warnings.filter(message => /activity log could not be written/.test(message)).length, 1)
})

test('clear empties both the cache and the file; export emits JSONL', () => {
  activity.record({ kind: 'write', message: 'a' })
  activity.record({ kind: 'write', message: 'b' })
  const text = activity.exportEvents()
  assert.equal(text.split('\n').length, 2)
  for (const line of text.split('\n')) JSON.parse(line)
  activity.clearEvents()
  assert.deepEqual(activity.listEvents(), [])
  const file = path.join(home, 'logs', 'activity.jsonl')
  assert.equal(fs.readFileSync(file, 'utf8'), '')
})

test('the ring keeps the newest entries and reports its own size', () => {
  for (let index = 0; index < 30; index += 1) activity.record({ kind: 'recall', message: 'row ' + index })
  const rows = activity.listEvents({ limit: 5 })
  assert.deepEqual(rows.map(row => row.message), ['row 29', 'row 28', 'row 27', 'row 26', 'row 25'])
  const stats = activity.logStats()
  assert.equal(stats.total, 30)
  assert.ok(stats.bytes > 0)
  assert.equal(stats.file, path.join(home, 'logs', 'activity.jsonl'))
})

test('a level is inferred from ok=false and kept when explicit', () => {
  activity.record({ kind: 'consolidate', ok: false, message: 'timed out' })
  activity.record({ kind: 'consolidate', ok: true, level: 'error', message: 'explicit' })
  const rows = activity.listEvents({ kind: 'consolidate' })
  assert.equal(rows[0].level, 'error')
  assert.equal(rows[1].level, 'warn')
  assert.equal(activity.listEvents({ level: 'warn' }).length, 1)
})
