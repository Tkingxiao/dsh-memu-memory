import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'

// No engine, worker, download or real library is used: all stores live here and
// the engine boundary is replaced before either production module is imported.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-managed-memory-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home
const calls = []
const warnings = []
const backendRows = new Map()
const backendKey = (db, name) => JSON.stringify([db, name])
let commitHook = null
let retrieveHook = null
let failCommit = false
let failForget = false
let forgetHook = null
let vp

globalThis.__managedMemoryTest = {
  async commit(args) {
    calls.push({ op: 'commit', ...args })
    // The lease invariant only exists while there is a generation to protect. A
    // requested-but-never-migrated profile writes without vectors on purpose.
    if (args.route === 'managed-local' && vp.hasActiveVectorGeneration()) {
      assert.ok(Object.keys(vp.activeVectorState().writeGuard.leases).length, 'lease spans MemU await')
    }
    if (commitHook) await commitHook(args)
    if (failCommit) throw new Error('mock managed commit failed')
    for (const row of args.payload.recall_files) backendRows.set(backendKey(args.db, row.name), structuredClone(row))
    return { ok: true }
  },
  async retrieve(args) {
    calls.push({ op: 'retrieve', ...args })
    return retrieveHook ? retrieveHook(args) : { files: [], segments: [], resources: [], raw: null }
  },
  async forget(args) {
    calls.push({ op: 'forget', ...args })
    if (args.route === 'managed-local' && vp.hasActiveVectorGeneration()) assert.ok(Object.keys(vp.activeVectorState().writeGuard.leases).length)
    if (forgetHook) return forgetHook(args)
    if (failForget) throw new Error('mock managed forget failed')
    backendRows.delete(backendKey(args.db, args.name))
    return { deleted: 1, segments: 1 }
  },
  async listFiles() { throw new Error('unexpected list engine call') },
}
const engineSource = 'const bridge = globalThis.__managedMemoryTest; export const commit = bridge.commit, retrieve = bridge.retrieve, forget = bridge.forget, listFiles = bridge.listFiles;'
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './memu.js') {
      return { url: 'data:text/javascript,' + encodeURIComponent(engineSource), shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
const state = await import('../lib/state.js')
vp = await import('../lib/vector-profile.js')
const paths = await import('../lib/paths.js')
const memory = await import('../lib/memory.js')
const curator = await import('../lib/curator.js')
const activity = await import('../lib/activity-log.js')
const profile = vp.profileFromCatalog('bge-small-zh-v1.5-int8')
const activeFile = vp.vectorActiveFile()
let serial = 0

function entry(content, extra = {}) {
  return { status: 'active', title: content, content, layer: 'long_term', strength: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra }
}
function fixture(entries = {}) {
  serial += 1
  const sessionId = 'managed-' + serial
  const cwd = path.join(home, 'project-' + serial)
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  state.setSessionBinding(sessionId, { useLibrary: true, useGlobal: true, domainOverride: 'coding' })
  state.savePrivateIndex(binding.libraryId, { entries })
  return { sessionId, libraryId: binding.libraryId, exec: { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding' } } } } }
}
function activate(libraryIds = []) {
  const databases = vp.buildDatabaseSet({ profile, generation: 1, libraryIds })
  fs.mkdirSync(path.join(home, 'libraries'), { recursive: true })
  for (const row of [databases.global, ...Object.values(databases.libraries)]) fs.writeFileSync(vp.resolveVectorPath(row.path), '')
  vp.updateVectorStateSync(current => ({ ...current, generation: 1, requested: null, pending: null,
    active: { status: 'active', generation: 1, fingerprint: profile.fingerprint, profile, databases } }))
  return databases
}
function job() { return { step: '', abort: new AbortController() } }
function curated(extra = {}) {
  return { op: 'create', domain: 'coding', title: 'global decision', content: 'global implementation decision',
    evidence: [{ session_id: 'source-session', quote: 'explicit decision' }], ...extra }
}

test.beforeEach(() => {
  fs.rmSync(activeFile, { force: true })
  state.updateSettings({ memoryBackend: 'api', vectorSource: 'local', relevanceThreshold: 0 })
  state.saveGlobalIndex({ entries: {} })
  calls.length = 0
  warnings.length = 0
  commitHook = null
  retrieveHook = null
  failCommit = false
  failForget = false
  forgetHook = null
  backendRows.clear()
  paths.setWarnSink(message => warnings.push(String(message)))
})
test.after(() => {
  hooks.deregister()
  delete globalThis.__managedMemoryTest
  paths.setWarnSink(null)
  fs.rmSync(home, { recursive: true, force: true })
})

test('fresh defaults disable all vector routes while retaining local as the selected source', () => {
  assert.equal(state.DEFAULT_SETTINGS.memoryBackend, 'agent')
  assert.equal(state.DEFAULT_SETTINGS.vectorSource, 'local')
  // 2026-10-30：用户要求召回默认 5/5（原来是 3/2）。
  assert.equal(state.DEFAULT_SETTINGS.privateTopK, 5)
  assert.equal(state.DEFAULT_SETTINGS.globalTopK, 5)
  assert.equal(state.effectiveVectorRoute(state.DEFAULT_SETTINGS), 'lexical')
  assert.equal(state.vectorBackendEnabled(state.DEFAULT_SETTINGS), false)
})

test('managed local private recall fuses real lexical and vector ids without LLM', async () => {
  const f = fixture({ 'mem-needle': entry('needle local match'), 'mem-orbit': entry('orbital mechanics') })
  activate([f.libraryId])
  retrieveHook = () => ({ files: [{ name: 'mem-orbit' }], segments: [], resources: [] })
  const result = await memory.privateRecall({ exec: f.exec, query: 'needle', topK: 8 })
  assert.deepEqual(new Set(result.files.map(file => file.name)), new Set(['mem-needle', 'mem-orbit']))
  assert.equal(result.recallRoute, 'managed-vector-rrf')
  assert.equal(calls[0].db, vp.dbPathFor(f.libraryId))
})

test('corrupt managed intent cannot call LLM or legacy API and preserves lexical ids', async () => {
  const f = fixture({ 'mem-needle': entry('needle local match') })
  state.updateSettings({ memoryBackend: 'api' })
  fs.writeFileSync(activeFile, '{bad-json')
  const result = await memory.privateRecall({ exec: f.exec, query: 'needle', topK: 8 })
  assert.deepEqual(result.files.map(file => file.name), ['mem-needle'])
  assert.equal(result.recallRoute, 'local-fallback')
  assert.match(state.getSessionBinding(f.sessionId).lastRecallError, /not valid JSON/)
  assert.ok(warnings.length)
  assert.equal(calls.length, 0)
})

test('agent backend stays lexical even when a local profile is active', async () => {
  const f = fixture({ 'mem-needle': entry('needle local match') })
  activate([f.libraryId])
  state.updateSettings({ memoryBackend: 'agent', vectorSource: 'local' })
  retrieveHook = () => { throw new Error('agent route must not call MemU') }
  const result = await memory.privateRecall({ exec: f.exec, query: 'needle', topK: 8 })
  assert.deepEqual(result.files.map(file => file.name), ['mem-needle'])
  assert.equal(result.recallRoute, 'local')
  assert.equal(calls.length, 0)
  assert.equal(state.effectiveVectorRoute(), 'lexical')
  assert.equal(state.vectorBackendEnabled(), false)
})

test('remote-api ignores an active local profile and passes explicit remote route', async () => {
  const f = fixture({ 'mem-needle': entry('needle local match') })
  activate([f.libraryId])
  state.updateSettings({ memoryBackend: 'api', vectorSource: 'api' })
  retrieveHook = () => ({ files: [{ name: 'mem-needle' }], segments: [], resources: [] })
  const result = await memory.privateRecall({ exec: f.exec, query: 'needle', topK: 8 })
  assert.equal(result.recallRoute, 'managed-vector-rrf')
  assert.equal(calls[0].route, 'remote-api')
  assert.notEqual(calls[0].db, vp.dbPathFor(f.libraryId))
})

test('invalid profile is a managed lexical fallback, never a remote fallback', async () => {
  const f = fixture({ 'mem-needle': entry('needle local match') })
  activate([f.libraryId])
  vp.updateVectorStateSync(current => ({ ...current, active: { ...current.active,
    profile: { ...current.active.profile, catalogId: 'missing-catalog-entry' } } }))
  const result = await memory.privateRecall({ exec: f.exec, query: 'needle', topK: 8 })
  assert.deepEqual(result.files.map(file => file.name), ['mem-needle'])
  assert.match(state.getSessionBinding(f.sessionId).lastRecallError, /catalog/)
  assert.equal(calls.length, 0)
})

test('global managed recall fuses by domain and records semantic errors despite lexical hits', async () => {
  const f = fixture()
  activate([f.libraryId])
  state.saveGlobalIndex({ entries: { 'gmem-needle': entry('needle global match', { domain: 'coding' }),
    'gmem-orbit': entry('orbital mechanics', { domain: 'coding' }), 'gmem-other': entry('needle other world', { domain: 'rp' }) } })
  retrieveHook = () => { throw new Error('worker unavailable') }
  const failed = await memory.globalRecall({ exec: f.exec, query: 'needle', topK: 8 })
  assert.deepEqual(failed.files.map(file => file.name), ['gmem-needle'])
  assert.equal(failed.recallRoute, 'local-fallback')
  assert.match(state.getSessionBinding(f.sessionId).lastRecallError, /worker unavailable/)
  retrieveHook = () => ({ files: [{ name: 'gmem-orbit' }, { name: 'gmem-other' }] })
  const healthy = await memory.globalRecall({ exec: f.exec, query: 'needle', topK: 8 })
  assert.deepEqual(new Set(healthy.files.map(file => file.name)), new Set(['gmem-needle', 'gmem-orbit']))
  assert.equal(healthy.recallRoute, 'managed-vector-rrf')
  assert.equal(state.getSessionBinding(f.sessionId).lastRecallError, undefined)
})

test('new library enrolls inside lease before first managed commit and lease spans index write', async () => {
  const f = fixture()
  activate()
  let entered
  let release
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  commitHook = async args => {
    assert.equal(args.db, vp.dbPathFor(f.libraryId))
    assert.equal(Object.keys(state.loadPrivateIndex(f.libraryId).entries).length, 0)
    entered()
    await gate
  }
  const writing = memory.privateRemember({ exec: f.exec, content: 'new managed fact', title: 'new managed fact' })
  await started
  await assert.rejects(vp.withVectorWriteFreeze(() => {}), { code: 'VECTOR_WRITE_BUSY' })
  release()
  const result = await writing
  assert.equal(state.loadPrivateIndex(f.libraryId).entries[result.id].content, 'new managed fact')
  assert.equal(Object.keys(vp.activeVectorState().writeGuard.leases).length, 0)
  assert.ok(vp.activeVectorState().active.databases.libraries[f.libraryId])
})

test('nonempty old library must rebuild rather than silently enroll an empty vector DB', async () => {
  const f = fixture({ 'mem-existing': entry('old stored fact') })
  activate()
  await assert.rejects(memory.privateRemember({ exec: f.exec, content: 'new different fact' }), { code: 'VECTOR_LIBRARY_REBUILD_REQUIRED' })
  assert.equal(calls.length, 0)
  assert.deepEqual(Object.keys(state.loadPrivateIndex(f.libraryId).entries), ['mem-existing'])
})

test('freeze rejects every async write before engine or index mutation', async () => {
  const f = fixture({ 'mem-live': entry('live fact'), 'mem-held': entry('held claim', { status: 'pending_review' }),
    'mem-archived': entry('old archived', { status: 'archived' }) })
  activate([f.libraryId])
  const before = JSON.stringify(state.loadPrivateIndex(f.libraryId))
  await vp.withVectorWriteFreeze(async () => {
    const writes = [
      () => memory.privateRemember({ exec: f.exec, content: 'new fact' }),
      () => memory.importMemories({ libraryId: f.libraryId, memories: [{ content: 'restored fact' }] }),
      () => memory.privateUpdate({ exec: f.exec, id: 'mem-live', content: 'updated fact' }),
      () => memory.privateDelete({ exec: f.exec, id: 'mem-archived' }),
      () => memory.resolveMemoryReview({ libraryId: f.libraryId, id: 'mem-held', action: 'accept' }),
      () => curator.commitCuratorOutput({ memories: [curated()] }, { job: job() }),
    ]
    for (const write of writes) await assert.rejects(write(), { code: 'VECTOR_WRITE_FROZEN' })
  })
  assert.equal(JSON.stringify(state.loadPrivateIndex(f.libraryId)), before)
  assert.equal(calls.length, 0)
  assert.deepEqual(state.loadGlobalIndex().entries, {})
})

test('managed agent update import delete and review call engine under lease; held edits stay index-only', async () => {
  const f = fixture({ 'mem-live': entry('live fact'), 'mem-held': entry('held claim', { status: 'pending_review' }),
    'mem-archived': entry('old archived', { status: 'archived' }) })
  activate([f.libraryId])
  await memory.privateUpdate({ exec: f.exec, id: 'mem-live', content: 'new implementation fact' })
  await memory.privateUpdate({ exec: f.exec, id: 'mem-held', content: 'edited held claim' })
  assert.equal(calls.length, 1, 'pending_review edit never commits')
  await memory.resolveMemoryReview({ libraryId: f.libraryId, id: 'mem-held', action: 'accept' })
  await memory.importMemories({ libraryId: f.libraryId, memories: [{ content: 'restored unique observation' }] })
  await memory.privateDelete({ exec: f.exec, id: 'mem-archived' })
  assert.deepEqual(calls.map(call => call.op), ['commit', 'commit', 'commit', 'forget'])
  assert.equal(state.loadPrivateIndex(f.libraryId).entries['mem-archived'], undefined)
})

test('post-CAS remember failure compensates the newly committed backend row', async () => {
  const f = fixture()
  activate([f.libraryId])
  commitHook = async () => state.setSessionBinding(f.sessionId, { libraryId: 'rebound-library' })
  await assert.rejects(
    memory.privateRemember({ exec: f.exec, content: 'must compensate', title: 'must compensate' }),
    /memory scope changed during write; retry/,
  )
  assert.deepEqual(calls.map(call => call.op), ['commit', 'forget'])
  assert.equal(calls[1].db, calls[0].db, 'cleanup uses the captured database after rebind')
  assert.equal(calls[1].name, calls[0].payload.recall_files[0].name)
  assert.equal(backendRows.size, 0, 'no orphan survives in the fake backend')
  assert.deepEqual(state.loadPrivateIndex(f.libraryId).entries, {})
  assert.equal(Object.keys(vp.activeVectorState().writeGuard.leases).length, 0)
})

test('post-CAS update failure deletes the new row and restores the old backend payload', async () => {
  const old = entry('old backend fact', { title: 'old title' })
  const f = fixture({ 'mem-live': old })
  activate([f.libraryId])
  commitHook = async () => state.setSessionBinding(f.sessionId, { libraryId: 'rebound-library' })
  await assert.rejects(
    memory.privateUpdate({ exec: f.exec, id: 'mem-live', content: 'new backend fact', title: 'new title' }),
    /memory scope changed during update; retry/,
  )
  assert.deepEqual(calls.map(call => call.op), ['commit', 'forget', 'commit'])
  assert.equal(calls[2].payload.recall_files[0].content, old.content)
  assert.equal(calls[2].payload.recall_files[0].description, old.title)
  assert.equal(calls[1].db, calls[0].db)
  assert.equal(calls[2].db, calls[0].db)
  assert.equal(backendRows.get(backendKey(calls[0].db, 'mem-live')).content, old.content)
  assert.deepEqual(state.loadPrivateIndex(f.libraryId).entries['mem-live'], old)
  assert.equal(Object.keys(vp.activeVectorState().writeGuard.leases).length, 0)
})

test('uncertain backend compensation is visible instead of reported as a successful write', async () => {
  const f = fixture()
  activate([f.libraryId])
  commitHook = async () => state.setSessionBinding(f.sessionId, { libraryId: 'rebound-library' })
  failForget = true
  await assert.rejects(
    memory.privateRemember({ exec: f.exec, content: 'uncertain backend state' }),
    error => error?.code === 'PRIVATE_BACKEND_COMPENSATION_FAILED' && /compensation uncertain/.test(error.message)
      && /memory scope changed/.test(error.cause?.message) && /mock managed forget failed/.test(error.compensationError?.message),
  )
  assert.deepEqual(calls.map(call => call.op), ['commit', 'forget'])
})

test('a failed restore is reported as uncertain and never erases the authoritative index', async () => {
  const f = fixture({ 'mem-live': entry('original backend payload') })
  activate([f.libraryId])
  const original = state.loadPrivateIndex(f.libraryId).entries['mem-live']
  let count = 0
  commitHook = async () => {
    if (++count > 1) throw new Error('restore unavailable')
    state.setSessionBinding(f.sessionId, { useLibrary: false })
  }
  await assert.rejects(memory.privateUpdate({ exec: f.exec, id: 'mem-live', content: 'rejected edit' }), error => {
    assert.equal(error.code, 'PRIVATE_BACKEND_COMPENSATION_FAILED')
    assert.match(error.compensationError.message, /restore unavailable/)
    return true
  })
  assert.deepEqual(calls.map(call => call.op), ['commit', 'forget', 'commit'])
  assert.deepEqual(state.loadPrivateIndex(f.libraryId).entries['mem-live'], original)
  assert.ok(warnings.some(warning => /compensation uncertain/.test(warning)))
})

test('unparseable compensation acknowledgement is visibly uncertain', async () => {
  const f = fixture()
  activate([f.libraryId])
  commitHook = async () => state.setSessionBinding(f.sessionId, { useLibrary: false })
  forgetHook = async () => ({ deleted: 0, parseWarning: 'mock non-JSON acknowledgement' })
  await assert.rejects(memory.privateRemember({ exec: f.exec, content: 'rejected new payload' }), {
    code: 'PRIVATE_BACKEND_COMPENSATION_FAILED',
  })
  assert.equal(backendRows.size, 1, 'uncertain cleanup is not claimed to remove the orphan')
  assert.deepEqual(state.loadPrivateIndex(f.libraryId).entries, {})
  forgetHook = async () => ({ ok: true })
  state.setSessionBinding(f.sessionId, { useLibrary: true })
  await assert.rejects(memory.privateRemember({ exec: f.exec, content: 'malformed delete acknowledgement' }), {
    code: 'PRIVATE_BACKEND_COMPENSATION_FAILED',
  })
})

test('a concurrently replaced index refuses destructive compensation', async () => {
  const f = fixture({ 'mem-live': entry('original backend payload') })
  activate([f.libraryId])
  commitHook = async () => state.updatePrivateIndex(f.libraryId, index => {
    index.entries['mem-live'].content = 'externally replaced authoritative value'
  })
  await assert.rejects(memory.privateUpdate({ exec: f.exec, id: 'mem-live', content: 'rejected edit' }), error => {
    assert.equal(error.code, 'PRIVATE_BACKEND_COMPENSATION_FAILED')
    assert.match(error.cause.message, /memory changed concurrently/)
    assert.match(error.compensationError.message, /changed before backend compensation/)
    return true
  })
  assert.deepEqual(calls.map(call => call.op), ['commit'], 'do not delete a newer same-name backend row')
  assert.equal(state.loadPrivateIndex(f.libraryId).entries['mem-live'].content, 'externally replaced authoritative value')
})

test('library queue spans compensation across routes and releases after failure', async () => {
  const f = fixture()
  activate([f.libraryId])
  let entered
  let release
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  commitHook = async () => {
    commitHook = null
    state.setSessionBinding(f.sessionId, { useLibrary: false })
  }
  forgetHook = async args => {
    entered()
    await gate
    backendRows.delete(backendKey(args.db, args.name))
    return { deleted: 1 }
  }
  const first = memory.privateRemember({ exec: f.exec, content: 'first write must roll back' })
  const rejected = assert.rejects(first, /private memory is turned off/)
  await started
  // A remote writer to the same library must wait for managed compensation.
  state.updateSettings({ vectorSource: 'api' })
  const second = memory.importMemories({ libraryId: f.libraryId, memories: [{ content: 'later remote write' }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls.map(call => call.op), ['commit', 'forget'])
  assert.equal(Object.keys(vp.activeVectorState().writeGuard.leases).length, 1)
  release()
  await rejected
  const imported = await second
  assert.equal(imported.imported, 1)
  assert.equal(calls[2].route, 'remote-api')
  assert.equal(Object.keys(vp.activeVectorState().writeGuard.leases).length, 0)
  assert.equal(backendRows.size, 1)
})

test('managed import failure rejects without index-first false success', async () => {
  const f = fixture()
  activate([f.libraryId])
  failCommit = true
  await assert.rejects(memory.importMemories({ libraryId: f.libraryId, memories: [{ content: 'restored unique fact' }] }), /mock managed commit failed/)
  assert.deepEqual(state.loadPrivateIndex(f.libraryId).entries, {})
  assert.equal(Object.keys(vp.activeVectorState().writeGuard.leases).length, 0)
})

test('a write under an active generation records which vector space it entered', async () => {
  const f = fixture()
  activate([f.libraryId])
  const written = await memory.privateRemember({ exec: f.exec, content: '这条应该记下向量归属', title: '向量归属' })
  const entry = state.loadPrivateIndex(f.libraryId).entries[written.id]
  assert.equal(entry.vector.model, 'bge-small-zh-v1.5-int8')
  assert.equal(entry.vector.generation, 1)
  assert.equal(entry.vector.route, 'managed-local')
  assert.match(entry.vector.fingerprint, /^[0-9a-f]{8}$/)

  // 没有代际（降级写）时不允许写字面上的"已入向量库"。
  fs.rmSync(activeFile, { force: true })
  const plain = await memory.privateRemember({ exec: f.exec, content: '降级写不应带向量归属', title: '降级' })
  assert.equal(state.loadPrivateIndex(f.libraryId).entries[plain.id].vector, undefined)
})

test('managed curator clean output commits under lease and held output is index-only', async () => {
  activate()
  const clean = await curator.commitCuratorOutput({ memories: [curated()] }, { job: job() })
  assert.equal(clean.created, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].db, vp.dbPathFor(null))
  const held = await curator.commitCuratorOutput({ memories: [curated({ title: 'held conflict', op: 'conflict' })] }, { job: job() })
  assert.equal(held.pending, 1)
  assert.equal(calls.length, 1)
  assert.ok(Object.values(state.loadGlobalIndex().entries).some(item => item.status === 'pending_review'))
  assert.equal(Object.keys(vp.activeVectorState().writeGuard.leases).length, 0)
})

// 现场事故（2026-10-29）：下载完模型、点了选择，但迁移没跑完 —— vector-active 只有
// requested，没有 active。写入路径当时直接抛 VECTOR_NOT_ACTIVE，整理 fork 跑完却一条
// 记忆都没落下，而最后睡眠标记照样前进。写入必须和召回一样降级，不能整体失败。
test('a requested-but-never-migrated profile degrades writes instead of failing them', async () => {
  const f = fixture()
  assert.equal(vp.hasActiveVectorGeneration(), false)
  fs.writeFileSync(activeFile, JSON.stringify({
    version: 1,
    generation: 0,
    requested: { status: 'requested', catalogId: 'bge-small-zh-v1.5-int8', fingerprint: profile.fingerprint },
  }))
  const private1 = await memory.privateRemember({ exec: f.exec, content: 'degraded private write must land', title: 'degraded private write' })
  assert.equal(state.loadPrivateIndex(f.libraryId).entries[private1.id].content, 'degraded private write must land')
  // No generation means no embedding environment, so MemU cannot take a commit at
  // all (envFor refuses managed-local). Index-only is the honest degradation; the
  // record is re-embedded by the next migration.
  assert.deepEqual(calls.map(call => call.op), [], 'a vectorless profile must not call the engine')
  assert.ok(warnings.some(message => /no active vector generation/.test(message)), 'the degradation is logged: ' + warnings.join(' | '))
  assert.ok(activity.listEvents({ kind: 'vector' }).length >= 1, 'the degradation is visible in the activity log')

  const curatedResult = await curator.commitCuratorOutput({ memories: [curated()] }, { job: job() })
  assert.equal(curatedResult.created, 1, 'global curation must not be thrown away either')
  assert.match(Object.keys(state.loadGlobalIndex().entries).join(','), /gmem-/, 'the global index still receives it')
  assert.deepEqual(calls.map(call => call.op), [], 'global curation degrades the same way')
})

test('archive stays index-only; deleting is what removes the vector row', async () => {
  const f = fixture({ 'mem-arch': entry('to archive') })
  activate([f.libraryId])
  await memory.privateArchive({ exec: f.exec, id: 'mem-arch' })
  assert.equal(state.loadPrivateIndex(f.libraryId).entries['mem-arch'].status, 'archived')
  assert.deepEqual(calls.map(call => call.op), [], 'archiving must not start the engine; it only flips the index status')
  await memory.privateDelete({ exec: f.exec, id: 'mem-arch' })
  assert.deepEqual(calls.map(call => call.op), ['forget'], 'permanent delete is what removes the MemU row')
})

test('UI listings read the index even when vectors are active', async () => {
  const f = fixture()
  activate([f.libraryId])
  // 列表走引擎意味着起 Python + embedding worker（秒级）。索引是权威，UI 刷新不该等它。
  const privateView = await memory.privateList({ libraryId: f.libraryId, preferIndex: true })
  assert.equal(privateView.source, 'index')
  assert.ok(privateView.files.length >= 0)
  const globalView = await memory.globalList({ exec: { agent: null }, preferIndex: true })
  assert.equal(globalView.source, 'index')
  assert.deepEqual(calls.map(call => call.op).filter(op => op === 'listFiles'), [], 'no engine list call')
})

test('global list degrades to the index when no vector generation is active', async () => {
  fs.writeFileSync(activeFile, JSON.stringify({
    version: 1,
    generation: 0,
    requested: { status: 'requested', catalogId: 'bge-small-zh-v1.5-int8', fingerprint: profile.fingerprint },
  }))
  state.saveGlobalIndex({ entries: { 'gmem-1': entry('global fact', { domain: 'coding' }) } })
  // 全局记忆页原先会闪一下 "managed local vector profile is not active" 再消失：
  // globalList 走了引擎路由，没有代际就必抛。列表本身能答，就按索引答。
  const result = await memory.globalList({ exec: { agent: null } })
  assert.equal(result.source, 'index')
  assert.deepEqual(result.files.map(file => file.name), ['gmem-1'])
  assert.match(result.warning, /本地向量未激活/)
})

test('an existing but torn generation still refuses writes loudly', async () => {
  const f = fixture()
  activate([f.libraryId])
  assert.equal(vp.hasActiveVectorGeneration(), true)
  const dbPath = vp.resolveVectorPath(vp.activeVectorState().active.databases.libraries[f.libraryId].path)
  fs.rmSync(dbPath, { force: true })
  await assert.rejects(
    memory.privateRemember({ exec: f.exec, content: 'must not be silently split', title: 'torn generation' }),
    { code: 'VECTOR_TORN_STATE' },
  )
  assert.deepEqual(Object.keys(state.loadPrivateIndex(f.libraryId).entries), [], 'a torn generation must not leave an index-only entry behind')
})

test('deleting an active archived library removes its route without tearing later writes', async () => {
  const f = fixture()
  const databases = activate([f.libraryId])
  const activeDb = vp.resolveVectorPath(databases.libraries[f.libraryId].path)
  fs.writeFileSync(path.join(home, 'libraries', f.libraryId + '.old.g1.sqlite3'), '')
  state.archiveLibrary(f.libraryId)
  await vp.withVectorWrite(async () => {
    assert.throws(() => state.deleteLibrary(f.libraryId), { code: 'VECTOR_WRITE_BUSY' })
  })
  const result = state.deleteLibrary(f.libraryId)
  assert.equal(result.ok, true)
  assert.equal(vp.activeVectorState().active.databases.libraries[f.libraryId], undefined)
  assert.equal(fs.existsSync(activeDb), false)
  assert.equal(fs.existsSync(path.join(home, 'libraries', f.libraryId + '.old.g1.sqlite3')), false)

  const next = fixture()
  const remembered = await memory.privateRemember({ exec: next.exec, content: 'write after deleting another library', title: 'route remains healthy' })
  assert.equal(state.loadPrivateIndex(next.libraryId).entries[remembered.id].content, 'write after deleting another library')
  assert.equal(vp.activeVectorState().active.databases.libraries[f.libraryId], undefined)
})
