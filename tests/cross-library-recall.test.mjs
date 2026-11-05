import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-cross-library-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const { privateRecall, privateList } = await import('../lib/memory.js')

test.after(() => {
  state.flushState()
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

const dir = (name) => path.join(home, name)
const execFor = (sessionId) => ({ agent: { session: { header: { id: sessionId } } } })

function seed(libraryId, id, entry = {}) {
  const index = state.loadPrivateIndex(libraryId)
  index.entries[id] = {
    layer: 'long_term', title: id, content: `body of ${id}`, status: 'active',
    createdAt: '2026-10-01T00:00:00.000Z', ...entry,
  }
  state.savePrivateIndex(libraryId, index)
}

function bind(sessionId, folder, libraryId, domain = 'coding') {
  state.ensureSession(sessionId, { cwd: folder, libraryId })
  state.setSessionBinding(sessionId, { domainOverride: domain })
}

function world() {
  const current = state.ensureLibraryForCwd(dir('current'))
  const other = state.ensureLibraryForCwd(dir('other'))
  const rp = state.ensureLibraryForCwd(dir('rp'))
  const off = state.ensureLibraryForCwd(dir('off'))
  bind('cross-current', dir('current'), current.id, 'coding')
  bind('cross-other', dir('other'), other.id, 'coding')
  bind('cross-rp', dir('rp'), rp.id, 'rp')
  bind('cross-off', dir('off'), off.id, 'coding')
  state.setWorkspacePolicy(dir('off'), { useLibrary: false })
  seed(current.id, 'mem-current', { title: '当前库的部署约定' })
  seed(other.id, 'mem-other', { title: '另一个库的部署约定' })
  seed(other.id, 'mem-secret', { title: '另一个库的部署秘密', visibility: 'secret' })
  seed(rp.id, 'mem-rp', { title: '角色扮演里的部署约定' })
  seed(off.id, 'mem-off', { title: '已关闭文件夹的部署约定' })
  return { current, other, rp, off }
}

test('cross-library recall is opt-in and merges same-domain libraries only', async () => {
  const libs = world()
  const exec = execFor('cross-current')

  state.updateSettings({ crossLibraryRecall: false })
  const offResult = await privateRecall({ exec, query: '部署约定', topK: 10, relevanceThreshold: 0 })
  assert.deepEqual(offResult.files.map((file) => file.name), ['mem-current'])

  state.updateSettings({ crossLibraryRecall: true })
  const onResult = await privateRecall({ exec, query: '部署约定', topK: 10, relevanceThreshold: 0 })
  const names = onResult.files.map((file) => file.name).sort()
  // Same-domain (coding) libraries only: the RP folder and the folder whose
  // private switch is off never contribute, even with a matching query.
  assert.deepEqual(names, ['mem-current', 'mem-other', 'mem-secret'])
  assert.deepEqual(onResult.libraries.sort(), [libs.current.id, libs.other.id].sort())
  const foreign = onResult.files.find((file) => file.name === 'mem-other')
  assert.equal(foreign.libraryId, libs.other.id, 'foreign hits keep their owning library')
  assert.equal(onResult.recallRoute, 'cross-library')
})

test('automatic recall keeps the secret exclusion across libraries', async () => {
  world()
  state.updateSettings({ crossLibraryRecall: true })
  const result = await privateRecall({
    exec: execFor('cross-current'), query: '部署约定', topK: 10,
    relevanceThreshold: 0, purpose: 'automatic',
  })
  const names = result.files.map((file) => file.name).sort()
  assert.deepEqual(names, ['mem-current', 'mem-other'])
  assert.ok(!result.files.some((file) => file.entry?.visibility === 'secret'))
})

test('the sidebar list follows the same cross-library scope, while an explicit library stays single', async () => {
  const libs = world()
  state.updateSettings({ crossLibraryRecall: true })
  const all = await privateList({ exec: execFor('cross-current') })
  assert.deepEqual((all.libraries || []).map((library) => library.id).sort(), [libs.current.id, libs.other.id].sort())
  assert.ok(all.files.some((file) => file.name === 'mem-other' && file.libraryId === libs.other.id))
  assert.ok(!all.files.some((file) => file.name === 'mem-rp'), 'different domain is excluded')
  assert.ok(!all.files.some((file) => file.name === 'mem-off'), 'folder with private memory off is excluded')

  // An explicit libraryId is the browser's selector, not the session scope: it
  // must show exactly that library even when the cross-library setting is on.
  const explicit = await privateList({ exec: execFor('cross-current'), libraryId: libs.current.id })
  assert.deepEqual(explicit.files.map((file) => file.name), ['mem-current'])
  assert.equal(explicit.libraries, undefined)
})

test('the bound library is always included, while other libraries depend on a domain hint', async () => {
  world()
  state.updateSettings({ crossLibraryRecall: true })
  // The bound library's own entries are never domain-filtered; only the extra
  // libraries are. Switching this conversation to `mixed` must not hide its own
  // memories, but it must stop pulling the coding-only library.
  state.setSessionBinding('cross-current', { domainOverride: 'mixed' })
  const result = await privateRecall({
    exec: execFor('cross-current'), query: '当前库的部署约定', topK: 10, relevanceThreshold: 0,
  })
  assert.ok(result.files.some((file) => file.name === 'mem-current'))
  assert.ok(!result.files.some((file) => file.name === 'mem-other'))
})
