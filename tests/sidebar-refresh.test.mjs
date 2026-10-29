// The sidebar painted one snapshot and never heard about a write again: a memory
// added in the browser, or by the model mid-turn, stayed invisible until the tab
// was remounted. The first fix was a monotonic revision the reader polls — but that
// counter only moves in the process that wrote, so a tool call served elsewhere left
// the panel stale anyway. These cases pin all three halves: the counter moves on
// every write this process makes, the on-disk stamp moves for writes it did not
// make, and the heartbeat stays a bare marker with no entry bodies in it.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-sidebar-refresh-'))
process.env.DSH_MEMU_HOME = home

const {
  createLibrary, ensureSession, loadPrivateIndex, savePrivateIndex, saveGlobalIndex, saveState, memoryRevision,
  memoryStamp, clearCaches, syncActivity,
} = await import('../lib/state.js')
const { privateRemember } = await import('../lib/memory.js')
const { dispatch } = await import('../lib/rpc.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function fixture(name) {
  const cwd = path.join(home, name)
  const lib = createLibrary({ name, cwd })
  const sessionId = name + '-session'
  ensureSession(sessionId, { cwd, libraryId: lib.id })
  return { cwd, lib, sessionId }
}

test('the heartbeat is a bare marker and needs no session', async () => {
  fixture('refresh-a')
  // Every pane polls this marker — the sidebar, the settings page, and the
  // standalone WebUI. Only the settings page and the WebUI have no conversation,
  // so the marker itself must not demand one; the full first screen still does.
  const beat = await dispatch({}, 'getSidebarState', { revisionOnly: true })
  // Two fields, both tiny: the in-process counter and the on-disk fingerprint that
  // a second window or a curator job can move.
  assert.deepEqual(Object.keys(beat), ['revision', 'stamp'], 'the heartbeat must not carry entries')
  assert.equal(typeof beat.revision, 'number')
  assert.equal(typeof beat.stamp, 'string')
  assert.equal(typeof syncActivity().lastBeatAt, 'number', 'a beat is recorded for memu_status')
  await assert.rejects(
    async () => { await dispatch({}, 'getSidebarState', {}) },
    /requires a sessionId/,
    'the full first screen still belongs to one conversation',
  )
})

test('a write records an event memu_status can show', async () => {
  const { lib, sessionId, cwd } = fixture('refresh-write')
  const exec = { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding' } } } }
  await privateRemember({ exec, content: '用户偏好周五下午整理下周计划，不要安排会议', title: '周五整理' })
  const activity = syncActivity()
  assert.equal(activity.lastWrite?.kind, 'private', 'the write event names what was written')
  assert.equal(activity.lastWrite?.libraryId, lib.id, 'and which library it belongs to')
  assert.equal(typeof activity.lastWrite?.at, 'number')
})

test('a private write moves the revision and lands in the next full read', async () => {
  const { lib, sessionId, cwd } = fixture('refresh-b')
  const before = (await dispatch({}, 'getSidebarState', { sessionId })).revision
  const exec = { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding' } } } }
  await privateRemember({ exec, content: '用户偏好周五下午整理下周计划，不要安排会议', title: '周五整理' })
  assert.equal(loadPrivateIndex(lib.id).entries ? Object.keys(loadPrivateIndex(lib.id).entries).length : 0, 1)
  const beat = await dispatch({}, 'getSidebarState', { sessionId, revisionOnly: true })
  assert.ok(beat.revision > before, 'writing a memory must move the revision')
  const full = await dispatch({}, 'getSidebarState', { sessionId })
  assert.equal(full.revision, beat.revision, 'the full read must report the revision it painted')
  assert.equal(full.private.items.length, 1, 'the new memory must be on the first screen')
  assert.match(full.private.items[0].preview, /周五下午/)
})

test('archiving through the browser also moves it', async () => {
  const { lib, sessionId } = fixture('refresh-c')
  const index = loadPrivateIndex(lib.id)
  index.entries['mem-refresh-1'] = { layer: 'long_term', title: 'old', content: 'body', status: 'active', createdAt: '2026-10-01T00:00:00.000Z' }
  savePrivateIndex(lib.id, index)
  const before = (await dispatch({}, 'getSidebarState', { sessionId })).revision
  await dispatch({}, 'archiveMemory', { libraryId: lib.id, id: 'mem-refresh-1' })
  assert.ok((await dispatch({}, 'getSidebarState', { sessionId, revisionOnly: true })).revision > before)
  const full = await dispatch({}, 'getSidebarState', { sessionId })
  assert.equal(full.private.items.length, 0, 'an archived entry must leave the list')
})

test('the global index and state.json writes move it too', async () => {
  fixture('refresh-d')
  const a = memoryRevision()
  saveGlobalIndex({ version: 1, entries: {} })
  assert.ok(memoryRevision() > a, 'a global write must move the revision')
  const b = memoryRevision()
  saveState(Object.assign({}, JSON.parse(JSON.stringify({})), { sessions: {}, libraries: {}, settings: {} }))
  assert.ok(memoryRevision() > b, 'a state write (folder policy, binding) must move the revision')
})

test('the stamp hears a write this process never made', async () => {
  const { lib, sessionId } = fixture('refresh-e')
  const beat = await dispatch({}, 'getSidebarState', { sessionId, revisionOnly: true })
  assert.equal(beat.stamp, memoryStamp(), 'the beat and a direct read agree on the stamp')
  assert.equal(beat.stamp, memoryStamp(), 'reading the stamp changes nothing')

  // Write the index straight to disk, the way another process or module instance
  // would: no savePrivateIndex, so this process's counter never moves.
  const index = loadPrivateIndex(lib.id)
  index.entries['mem-outside-1'] = {
    layer: 'long_term', title: 'outside', content: 'written elsewhere', status: 'active', createdAt: '2026-10-02T00:00:00.000Z',
  }
  fs.writeFileSync(path.join(home, 'index', lib.id + '.json'), JSON.stringify(index, null, 2))

  const after = await dispatch({}, 'getSidebarState', { sessionId, revisionOnly: true })
  assert.equal(after.revision, beat.revision, 'the per-process counter deliberately stands still')
  assert.notEqual(after.stamp, beat.stamp, 'the stamp is the half another process can move')

  clearCaches()
  const full = await dispatch({}, 'getSidebarState', { sessionId })
  assert.equal(full.stamp, after.stamp, 'the refetch reports the stamp it painted')
  assert.equal(full.private.items.length, 1, 'the outside write shows up on the next full read')
})
