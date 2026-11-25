import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 全局生命周期管理面（1.3.12）：归档/恢复/两步永久删除与私有同权，内容仍由
// curator 书写。守卫口径：
//   1. 归档立即被召回排除（isMemoryEligible 统一闸门），恢复即回来；
//   2. 状态机边界：pending_review 走复核队列、superseded 不能直接恢复；
//   3. 全局 updateMemory 只接受 {status:'active'}，内容补丁一律拒绝；
//   4. 删除只开放已归档/抑制/过期条目，需显式确认，级联清他条 links 与指针；
//   5. 合并稿与活跃合并的来源拒删（absorbSnapshot 是撤销合并的唯一依据）；
//   6. 管理视图（browseWall/listGlobal standalone）仍看得到 archived 条目。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-global-lifecycle-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home
const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const rpc = await import('../lib/rpc.js')
test.after(() => { state.flushState(); fs.rmSync(home, { recursive: true, force: true }) })

state.updateSettings({ memoryBackend: 'agent', vectorSource: 'local', crossLibraryRecall: false })
const sessionId = 'global-lifecycle-session'
state.ensureSession(sessionId, { cwd: path.join(home, 'proj') })
// 域自动探测会随 cwd 落成 coding：这里钉成 general，与种子条目的 domain 对齐。
state.setSessionBinding(sessionId, { domain: 'general', domainOverride: 'general', domainSource: 'manual' })
const exec = { agent: { session: { header: { id: sessionId } } } }

const entry = (title, extra = {}) => ({
  title, content: title, status: 'active', layer: 'long_term', domain: 'general',
  visibility: 'shared', disclosure: 'can_tell', source: 'inferred',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra,
})
const seed = (entries) => {
  state.updateGlobalIndex((index) => { index.entries = entries })
  state.flushState()
}
const globalEntry = (id) => state.loadGlobalIndex().entries[id]

test('global archive drops the entry from recall; restore brings it back', async () => {
  seed({ 'mem-g-visible': entry('zqneedleglobal 部署窗口'), 'mem-g-other': entry('unrelated filler') })
  const before = await memory.globalRecall({ exec, query: 'zqneedleglobal', purpose: 'automatic', topK: 5, relevanceThreshold: 0 })
  assert.deepEqual(before.files.map(f => f.name), ['mem-g-visible'])
  assert.equal(memory.isMemoryEligible(globalEntry('mem-g-visible'), { automatic: true }), true)

  const archived = await rpc.dispatch({}, 'archiveMemory', { scope: 'global', id: 'mem-g-visible' })
  assert.equal(archived.entry.status, 'archived')
  assert.equal(memory.isMemoryEligible(globalEntry('mem-g-visible'), { automatic: true }), false)
  const after = await memory.globalRecall({ exec, query: 'zqneedleglobal', purpose: 'automatic', topK: 5, relevanceThreshold: 0 })
  assert.deepEqual(after.files.map(f => f.name), [], 'archived global memory must not recall')

  // 幂等归档不报错；恢复走 updateMemory 的唯一全局补丁形状。
  await rpc.dispatch({}, 'archiveMemory', { scope: 'global', id: 'mem-g-visible' })
  const restored = await rpc.dispatch({}, 'updateMemory', { scope: 'global', id: 'mem-g-visible', patch: { status: 'active' } })
  assert.equal(restored.entry.status, 'active')
  const back = await memory.globalRecall({ exec, query: 'zqneedleglobal', purpose: 'automatic', topK: 5, relevanceThreshold: 0 })
  assert.deepEqual(back.files.map(f => f.name), ['mem-g-visible'])
})

test('global lifecycle state machine refuses review, superseded and content edits', async () => {
  seed({
    'mem-g-pending': entry('待复核条目', { status: 'pending_review' }),
    'mem-g-superseded': entry('被取代条目', { status: 'superseded', supersededBy: 'mem-g-active' }),
    'mem-g-active': entry('现行条目'),
  })
  await assert.rejects(() => rpc.dispatch({}, 'archiveMemory', { scope: 'global', id: 'mem-g-pending' }), /review queue/)
  await assert.rejects(() => rpc.dispatch({}, 'updateMemory', { scope: 'global', id: 'mem-g-superseded', patch: { status: 'active' } }), /only archived/)
  await assert.rejects(() => rpc.dispatch({}, 'updateMemory', { scope: 'global', id: 'mem-g-active', patch: { status: 'active' } }), /only archived/)
  await assert.rejects(() => rpc.dispatch({}, 'updateMemory', { scope: 'global', id: 'mem-g-active', patch: { content: '改写' } }), /curator-written/)
  await assert.rejects(() => rpc.dispatch({}, 'updateMemory', { scope: 'global', id: 'mem-g-active', patch: { status: 'archived' } }), /curator-written/)
  await assert.rejects(() => rpc.dispatch({}, 'archiveMemory', { scope: 'global', id: 'mem-g-active', libraryId: 'lib-x' }), /libraryId/)
  await assert.rejects(() => rpc.dispatch({}, 'deleteMemory', { scope: 'global', id: 'mem-g-active', libraryId: 'lib-x', confirmed: true }), /libraryId/)
  await assert.rejects(() => rpc.dispatch({}, 'archiveMemory', { scope: 'global', id: 'mem-g-missing' }), /unknown global memory/)
  // superseded 可以归档（本就不可召回），但仍不能直接恢复。
  await rpc.dispatch({}, 'archiveMemory', { scope: 'global', id: 'mem-g-superseded' })
  assert.equal(globalEntry('mem-g-superseded').status, 'archived')
})

test('global permanent delete is gated, confirmed, and cascades inbound pointers', async () => {
  seed({
    'mem-g-target': entry('删除目标', { status: 'archived' }),
    'mem-g-live': entry('活跃条目'),
    'mem-g-referrer': entry('引用者', {
      links: [{ id: 'lnk-1', to: 'mem-g-target', kind: 'related' }, { id: 'lnk-2', to: 'mem-g-live', kind: 'related' }],
      duplicateOf: 'mem-g-target', relatedTo: 'mem-g-target', conflictingWith: 'mem-g-target',
      supersededBy: 'mem-g-target', absorbedBy: 'mem-g-target',
    }),
  })
  await assert.rejects(() => rpc.dispatch({}, 'deleteMemory', { scope: 'global', id: 'mem-g-live', confirmed: true }), /archive it first/)
  await assert.rejects(() => rpc.dispatch({}, 'deleteMemory', { scope: 'global', id: 'mem-g-target' }), /explicit confirmation/)
  await assert.rejects(() => rpc.dispatch({}, 'deleteMemory', { scope: 'global', id: 'mem-g-target', preview: true }), /no preview\/restore buffer/)
  await assert.rejects(() => rpc.dispatch({}, 'deleteMemory', { scope: 'global', id: 'mem-g-target', restore: true }), /no preview\/restore buffer/)

  const deleted = await rpc.dispatch({}, 'deleteMemory', { scope: 'global', id: 'mem-g-target', confirmed: true })
  assert.equal(deleted.deleted, true)
  assert.equal(deleted.libraryId, null)
  assert.equal(globalEntry('mem-g-target'), undefined)
  const referrer = globalEntry('mem-g-referrer')
  assert.deepEqual(referrer.links.map(l => l.to), ['mem-g-live'], 'inbound links to the deleted row are swept')
  for (const field of ['duplicateOf', 'relatedTo', 'conflictingWith', 'supersededBy', 'absorbedBy']) {
    assert.equal(referrer[field], undefined, `${field} must not dangle`)
  }
  await assert.rejects(() => rpc.dispatch({}, 'deleteMemory', { scope: 'global', id: 'mem-g-target', confirmed: true }), /unknown global memory/)
})

test('global delete refuses merged entries and sources of a live merge', async () => {
  seed({
    'mem-g-merged': entry('合并稿', { status: 'archived', absorbedFrom: ['mem-g-source'], absorbSnapshot: {} }),
    'mem-g-source': entry('来源', { status: 'archived', absorbedBy: 'mem-g-merged-live' }),
    'mem-g-merged-live': entry('活跃合并稿', { absorbedFrom: ['mem-g-source'] }),
  })
  await assert.rejects(() => rpc.dispatch({}, 'deleteMemory', { scope: 'global', id: 'mem-g-merged', confirmed: true }), /undo the merge first/)
  await assert.rejects(() => rpc.dispatch({}, 'deleteMemory', { scope: 'global', id: 'mem-g-source', confirmed: true }), /source of merged memory mem-g-merged-live/)
})

test('management views still show archived global rows; private archive path is unchanged', async () => {
  seed({ 'mem-g-archived': entry('已归档全局', { status: 'archived' }) })
  const wall = await rpc.dispatch({}, 'browseWall', { libraryId: null, limit: 300 })
  assert.ok(wall.items.some(item => item.libraryId === null && item.id === 'mem-g-archived' && item.status === 'archived'))
  const listed = await rpc.dispatch({}, 'listGlobal', {})
  assert.ok(listed.files.some(file => file.id === 'mem-g-archived' && file.status === 'archived'))

  // 私有路径回归：显式 libraryId 的 archiveMemory 不受 scope 分支影响。
  const lib = state.createLibrary({ name: 'global-lifecycle-private', cwd: path.join(home, 'private') })
  state.updatePrivateIndex(lib.id, (index) => { index.entries['mem-p-row'] = entry('私有条目') })
  const archived = await rpc.dispatch({}, 'archiveMemory', { libraryId: lib.id, id: 'mem-p-row' })
  assert.equal(archived.entry.status, 'archived')
  assert.equal(state.loadPrivateIndex(lib.id).entries['mem-p-row'].status, 'archived')
})

test('the wall stamps every row with its domain and filters without shrinking the choices', async () => {
  const lib = state.createLibrary({ name: 'global-lifecycle-domains', cwd: path.join(home, 'domain-wall') })
  seed({ 'mem-g-rp': entry('顾清欢的约定', { domain: 'RP' }) })
  state.updatePrivateIndex(lib.id, (index) => {
    index.entries['mem-p-coding'] = entry('部署窗口', { domain: '  Ｃｏｄｉｎｇ ' })
    index.entries['mem-p-legacy'] = { ...entry('没有域标记的旧条目'), domain: undefined }
  })
  const all = await rpc.dispatch({}, 'browseWall', { libraryId: lib.id, limit: 300 })
  const byId = new Map(all.items.map(item => [item.id, item]))
  assert.equal(byId.get('mem-p-coding').domain, 'coding', 'stamps normalize exactly like the graph filter does')
  assert.equal(byId.get('mem-p-legacy').domain, 'general', 'an unstamped private row reads as general')
  assert.equal(byId.get('mem-g-rp').domain, 'rp', 'global rows carry their own stamp')
  assert.deepEqual(all.domains, ['coding', 'general', 'rp'])

  const coding = await rpc.dispatch({}, 'browseWall', { libraryId: lib.id, limit: 300, domain: 'CODING' })
  assert.deepEqual(coding.items.map(item => item.id), ['mem-p-coding'])
  assert.equal(coding.total, 1, 'the count follows what the reader can actually see')
  assert.deepEqual(coding.domains, all.domains, 'the option list is never narrowed by the filter itself')
})