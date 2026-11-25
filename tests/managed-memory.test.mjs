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
const rebuildProbes = []
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
  async maybeAutoRebuildVectorGeneration(...args) {
    rebuildProbes.push(args)
    return { stubbed: true }
  },
}
const vectorServiceUrl = 'data:text/javascript,' + encodeURIComponent('export const maybeAutoRebuildVectorGeneration = globalThis.__managedMemoryTest.maybeAutoRebuildVectorGeneration;')
const engineSource = 'const bridge = globalThis.__managedMemoryTest; export const commit = bridge.commit, retrieve = bridge.retrieve, forget = bridge.forget, listFiles = bridge.listFiles, closeMemuResident = () => 0, prewarmMemuResident = async () => false;'
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './memu.js') {
      return { url: 'data:text/javascript,' + encodeURIComponent(engineSource), shortCircuit: true }
    }
    // managedRecall 的缺库分支会动态 import 向量服务做自动追平探测。这里只拦截
    // memory.js 发起的那一次（父 URL 限定），别的模块照常拿真实现——否则空转的
    // force 重建会把嵌入 worker 拉进单元测试。
    if (specifier === './local-vector-service.js' && context.parentURL === new URL('../lib/memory.js', import.meta.url).href) {
      return { url: vectorServiceUrl, shortCircuit: true }
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
const { buildCorpus, bm25, tokenize } = await import('../lib/text-retrieval.js')
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
  state.updateSettings({ memoryBackend: 'api', vectorSource: 'local', relevanceThreshold: 0, crossLibraryRecall: false })
  state.saveGlobalIndex({ entries: {} })
  calls.length = 0
  warnings.length = 0
  rebuildProbes.length = 0
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

// 2026-11-18：跨库召回扫到没有向量库的库时，缺库降级的诊断只该属于「有内容」的库。
// 空库（旧工作区遗留，索引 0 条）local-only 与语义召回的结果都是空——每轮给它刷
// "向量库未生成" warn 是常驻噪音（group_893418498 空库实测刷满活动日志）。
function vectorDegradeRows(libraryId) {
  return activity.listEvents({ kind: 'vector', limit: 100 })
    .filter(row => row.message === '向量库未生成，召回降级 local-only' && row.detail?.libraryId === libraryId)
}

async function settleRebuildProbes() {
  // Join the same data-module import and drain its fire-and-forget .then callback.
  // Importing the bridge itself does not call the probe or start a real worker.
  await import(vectorServiceUrl)
  await new Promise(resolve => setImmediate(resolve))
}

function trackIndexAccess(t, files) {
  const access = { clones: 0, stats: new Map(files.map(file => [file, 0])) }
  const clone = globalThis.structuredClone
  t.mock.method(globalThis, 'structuredClone', (value, ...args) => {
    if (value?.entries && !Array.isArray(value.entries)) access.clones += 1
    return clone(value, ...args)
  })
  const stat = fs.statSync
  t.mock.method(fs, 'statSync', (file, ...args) => {
    if (access.stats.has(file)) access.stats.set(file, access.stats.get(file) + 1)
    return stat(file, ...args)
  })
  return access
}

test('an empty library without a vector db recalls silently — no degrade noise, no rebuild probe', async () => {
  state.updateSettings({ memoryBackend: 'api', vectorSource: 'local' })
  const empty = fixture({})
  activate([]) // 活跃代际只含全局库：该库的向量库必然缺席
  const result = await memory.privateRecall({ exec: empty.exec, query: 'anything', topK: 5 })
  await settleRebuildProbes()
  assert.equal(result.recallRoute, 'local-fallback')
  assert.deepEqual(result.files, [], 'an empty library has nothing to recall')
  assert.deepEqual(result.errors || [], [])
  assert.deepEqual(warnings, [], 'an empty library must not warn')
  assert.equal(vectorDegradeRows(empty.libraryId).length, 0, 'an empty library must not log the degrade warning')
  assert.equal(rebuildProbes.length, 0, 'an empty library must not probe a rebuild')
  assert.equal(calls.length, 0)
})

test('a library with content but no vector db keeps the degrade diagnostic and probes the rebuild', async () => {
  state.updateSettings({ memoryBackend: 'api', vectorSource: 'local' })
  const rich = fixture({ 'mem-rich': entry('needle real content that semantic recall would serve') })
  activate([]) // 同上：库不在代际里，但索引里有内容——这是真正值得诊断的缺库
  const result = await memory.privateRecall({ exec: rich.exec, query: 'needle', topK: 5 })
  await settleRebuildProbes()
  assert.equal(result.recallRoute, 'local-fallback')
  assert.deepEqual(result.files.map(file => file.name), ['mem-rich'])
  assert.deepEqual(result.errors || [], [], 'missing registration is diagnostic, not a recall error')
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('has no database for library ' + rich.libraryId))
  assert.equal(vectorDegradeRows(rich.libraryId).length, 1, 'content-bearing libraries keep the diagnostic')
  assert.equal(rebuildProbes.length, 1, 'content-bearing libraries probe the rebuild')
  assert.equal(calls.length, 0)
})

test('an empty library resumes missing-db diagnostics after its first index entry is saved', async () => {
  const f = fixture()
  activate([])
  const empty = await memory.privateRecall({ exec: f.exec, query: 'needle', purpose: 'automatic' })
  await settleRebuildProbes()
  assert.deepEqual(empty.files, [])
  assert.deepEqual(warnings, [])
  assert.equal(vectorDegradeRows(f.libraryId).length, 0)
  assert.equal(rebuildProbes.length, 0)

  // A backfill must invalidate emptiness immediately; no new cache or enrollment.
  state.savePrivateIndex(f.libraryId, { entries: { 'mem-first': entry('needle first backfilled fact') } })
  const filled = await memory.privateRecall({ exec: f.exec, query: 'needle', purpose: 'automatic' })
  await settleRebuildProbes()
  assert.deepEqual(filled.files.map(file => file.name), ['mem-first'])
  assert.equal(filled.recallRoute, 'local-fallback')
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('has no database for library ' + f.libraryId))
  assert.equal(vectorDegradeRows(f.libraryId).length, 1)
  assert.equal(rebuildProbes.length, 1)
  assert.equal(calls.length, 0)
})

test('missing-db recall reuses loaded indexes on repeated warm-cache calls', async t => {
  const f = fixture({ 'mem-budget': entry('needle snapshot budget') })
  activate([])
  state.loadPrivateIndex(f.libraryId) // Warm the state index cache before spying.
  const indexFile = path.join(paths.indexDir(), f.libraryId + '.json')
  const access = trackIndexAccess(t, [indexFile])
  for (let round = 1; round <= 2; round += 1) {
    const result = await memory.privateRecall({ exec: f.exec, query: 'needle', purpose: 'automatic' })
    await settleRebuildProbes()
    assert.deepEqual(result.files.map(file => file.name), ['mem-budget'])
    // Two source snapshots clone twice each; the one hit also checks the existing
    // relation-inverted-index signature (stat only, no snapshot).
    assert.equal(access.stats.get(indexFile), 3 * round, 'two index reads plus one relation signature stat')
    assert.equal(access.clones, 4 * round, 'no extra full-index clones, regardless of corpus size')
    assert.equal(rebuildProbes.length, round, 'the fallback remains uncached and diagnostic')
  }
})

test('cross-library missing-db diagnostics use the full source before domain filtering without extra snapshots', async t => {
  const current = fixture({ 'mem-current': entry('needle current fact') })
  const foreign = fixture({ 'mem-other-domain': entry('needle other world', { domain: 'rp' }) })
  const empty = fixture()
  const domain = 'project:' + current.sessionId
  for (const f of [current, foreign, empty]) state.setSessionBinding(f.sessionId, { domainOverride: domain })
  state.updateSettings({ crossLibraryRecall: true })
  activate([])
  const indexFiles = [current, foreign, empty].map(f => path.join(paths.indexDir(), f.libraryId + '.json'))
  const access = trackIndexAccess(t, indexFiles)
  const result = await memory.privateRecall({ exec: current.exec, query: 'needle', purpose: 'automatic' })
  await settleRebuildProbes()
  assert.equal(result.recallRoute, 'cross-library')
  assert.deepEqual(new Set(result.libraries), new Set([current.libraryId, foreign.libraryId, empty.libraryId]))
  assert.deepEqual(result.files.map(file => file.name), ['mem-current'], 'the foreign domain contributes no hits')
  assert.deepEqual(result.errors, [])
  assert.equal(warnings.length, 2, 'only the two content-bearing libraries warn')
  for (const f of [current, foreign]) {
    assert.ok(warnings.some(message => message.includes('has no database for library ' + f.libraryId)))
    assert.equal(vectorDegradeRows(f.libraryId).length, 1)
  }
  assert.equal(vectorDegradeRows(empty.libraryId).length, 0)
  assert.equal(rebuildProbes.length, 2, 'a domain-filtered empty view still needs a rebuild probe')
  assert.equal(calls.length, 0)
  assert.deepEqual(indexFiles.map(file => access.stats.get(file)), [3, 1, 1], 'only the primary hit adds a relation signature stat')
  assert.equal(access.clones, 8, 'three source loads plus the existing primary refresh only')
})

test('by-id private recall still short-circuits vector IO and missing-db diagnostics', async t => {
  const f = fixture({ 'mem-byid': entry('needle direct lookup') })
  const databases = activate([])
  const globalDb = vp.resolveVectorPath(databases.global.path)
  fs.rmSync(globalDb)
  const indexFile = path.join(paths.indexDir(), f.libraryId + '.json')
  const access = trackIndexAccess(t, [indexFile, globalDb])
  const read = t.mock.method(fs, 'readFileSync')
  const result = await memory.privateRecall({ exec: f.exec, query: 'mem-byid', purpose: 'automatic' })
  await settleRebuildProbes()
  assert.deepEqual(result.files.map(file => file.name), ['mem-byid'])
  assert.equal(result.recallRoute, 'local')
  assert.deepEqual(warnings, [])
  assert.equal(vectorDegradeRows(f.libraryId).length, 0)
  assert.equal(rebuildProbes.length, 0)
  assert.equal(calls.length, 0)
  assert.equal(read.mock.calls.some(call => call.arguments[0] === activeFile), false, 'by-id does not read vector state')
  assert.equal(access.stats.get(globalDb), 0, 'by-id does not validate vector databases')
  assert.equal(access.stats.get(indexFile), 3, 'two index reads plus the existing relation signature stat')
  assert.equal(access.clones, 4)
})

test('global recall uses the null library route even for an empty index and adds no index snapshots', async t => {
  const f = fixture({ 'mem-private': entry('needle private-only fact') })
  activate([f.libraryId])
  const globalDb = vp.dbPathFor(null)
  const empty = await memory.globalRecall({ exec: f.exec, query: 'needle' })
  assert.deepEqual(empty.files, [])
  assert.equal(empty.recallRoute, 'managed-vector-rrf')
  assert.equal(calls.length, 1, 'an empty index must not suppress an existing vector route')
  assert.equal(calls[0].db, globalDb)

  state.saveGlobalIndex({ entries: {
    'gmem-needle': entry('needle global fact', { domain: 'coding' }),
    'gmem-other': entry('needle other world', { domain: 'rp' }),
  } })
  const indexFile = path.join(paths.indexDir(), 'global.json')
  const access = trackIndexAccess(t, [indexFile])
  const result = await memory.globalRecall({ exec: f.exec, query: 'needle' })
  await settleRebuildProbes()
  assert.deepEqual(result.files.map(file => file.name), ['gmem-needle'])
  assert.equal(result.recallRoute, 'managed-vector-rrf')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].db, globalDb, 'libraryId=null must select global, not private')
  assert.equal(calls[1].route, 'managed-local')
  assert.deepEqual(warnings, [])
  assert.equal(vectorDegradeRows(null).length, 0)
  assert.equal(rebuildProbes.length, 0)
  assert.equal(access.stats.get(indexFile), 2)
  assert.equal(access.clones, 4)
})

for (const content of ['empty', 'other-domain', 'matching']) {
  test(`a physically missing global database remains an error with ${content} content`, async () => {
    const f = fixture()
    const databases = activate([])
    if (content !== 'empty') state.saveGlobalIndex({ entries: {
      'gmem-needle': entry('needle global fact', { domain: content === 'matching' ? 'coding' : 'rp' }),
    } })
    const globalDb = vp.resolveVectorPath(databases.global.path)
    fs.rmSync(globalDb)
    const result = await memory.globalRecall({ exec: f.exec, query: 'needle' })
    await settleRebuildProbes()
    assert.deepEqual(result.files.map(file => file.name), content === 'matching' ? ['gmem-needle'] : [])
    assert.equal(result.recallRoute, 'local-fallback')
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0], /a database in the active generation is missing/)
    assert.match(state.getSessionBinding(f.sessionId).lastRecallError, /a database in the active generation is missing/)
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].includes(path.basename(globalDb)))
    assert.equal(vectorDegradeRows(null).length, 0, 'torn state is not ordinary missing registration')
    assert.equal(rebuildProbes.length, 0)
    assert.equal(calls.length, 0)
  })
}

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

test('managed vector commit failure defers to index-only instead of losing the write', async () => {
  const f = fixture()
  activate([f.libraryId])
  failCommit = true
  const written = await memory.privateRemember({ exec: f.exec, content: 'deferred write survives', title: 'deferred' })
  let entry = state.loadPrivateIndex(f.libraryId).entries[written.id]
  assert.equal(entry.content, 'deferred write survives')
  assert.equal(entry.vectorPending, true)
  assert.equal(entry.vector, undefined)
  assert.equal(backendRows.size, 0, 'nothing was falsely recorded as committed')
  assert.ok(warnings.some(message => /deferred/.test(message)), 'the degradation must be observable')

  failCommit = false
  await memory.privateUpdate({ exec: f.exec, id: written.id, content: 'deferred write now committed' })
  entry = state.loadPrivateIndex(f.libraryId).entries[written.id]
  assert.equal(entry.vectorPending, undefined, 'a later successful commit clears the pending flag')
  assert.equal(entry.vector.route, 'managed-local')
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

test('the vector count follows reality: writes stamp, review/import/curator stamp, deletes shrink', async () => {
  // 现场事故（2026-10-31）：设置页"当前已入向量库 N 条"只数迁移账本 —— 账本在切换
  // 那一刻写完就再也不更新，聊天里新写的记忆永远不进计数。membership = 账本腿（迁移
  // 写入，扣除已删除）+ 戳腿（迁移后写入）。每条迁移后写入路径都必须落戳，否则漏数。
  const vm = await import('../lib/vector-migration.js')
  const f = fixture({
    'mem-migrated': entry('迁移时就有的记忆'),
    'mem-held': entry('待审的主张', { status: 'pending_review' }),
  })
  activate([f.libraryId])
  // 预置"切换时写入 1/1"的账本快照：mem-migrated 在迁移时进了向量库（索引故意无戳）。
  const { ledger } = vm.loadLedger(profile.fingerprint, 1)
  ledger.libraries[f.libraryId] = { items: { 'mem-migrated': { hash: 'seed', at: new Date().toISOString() } }, tombstones: {}, snapshot: null }
  vm.saveLedger(ledger)
  const migrator = vm.createVectorMigrator({
    listLibraries: () => state.listLibraries().map(item => item.id),
    loadIndex: libraryId => libraryId == null ? state.loadGlobalIndex() : state.loadPrivateIndex(libraryId),
    commit: async () => {}, forget: async () => {}, listFiles: async () => [],
  })
  const idsOf = scope => (migrator.membership()[scope] || []).sort()
  assert.deepEqual(idsOf(f.libraryId), ['mem-migrated'], 'starts at the migration count — the reported bug state')

  // 聊天写入：戳腿接管，计数跟着涨。
  const written = await memory.privateRemember({ exec: f.exec, content: '切换后新写的记忆', title: '新记忆' })
  assert.equal(state.loadPrivateIndex(f.libraryId).entries[written.id].vector.generation, 1)
  assert.deepEqual(idsOf(f.libraryId), ['mem-migrated', written.id])

  // 编辑重提交：行被重写进当前空间，戳刷新到当前代际。
  await memory.privateUpdate({ exec: f.exec, id: written.id, content: '更新后的记忆内容' })
  const updated = state.loadPrivateIndex(f.libraryId).entries[written.id]
  assert.equal(updated.vector.generation, 1)
  assert.equal(updated.vector.route, 'managed-local')
  assert.deepEqual(idsOf(f.libraryId), ['mem-migrated', written.id])

  // 批量恢复与评审接受：此前完全不落戳，是计数漏数的另外两条路。
  await memory.importMemories({ libraryId: f.libraryId, memories: [{ content: '恢复回来的独特观察' }] })
  const imported = Object.entries(state.loadPrivateIndex(f.libraryId).entries).find(([, item]) => item.content === '恢复回来的独特观察')[0]
  assert.equal(state.loadPrivateIndex(f.libraryId).entries[imported].vector.generation, 1)
  await memory.resolveMemoryReview({ libraryId: f.libraryId, id: 'mem-held', action: 'accept' })
  assert.equal(state.loadPrivateIndex(f.libraryId).entries['mem-held'].vector.generation, 1)
  assert.ok(idsOf(f.libraryId).includes(imported) && idsOf(f.libraryId).includes('mem-held'))

  // 永久删除：引擎行先删、索引行后删，账本不知道 —— membership 必须把它扣掉。
  await memory.privateArchive({ exec: f.exec, id: 'mem-migrated' })
  await memory.privateDelete({ exec: f.exec, id: 'mem-migrated' })
  assert.equal(idsOf(f.libraryId).includes('mem-migrated'), false, 'a permanently deleted migration item leaves the count')

  // 全局整理：同样的口径，提交成功即落戳。
  const clean = await curator.commitCuratorOutput({ memories: [curated()] }, { job: job() })
  assert.equal(clean.created, 1)
  const curatedId = Object.keys(state.loadGlobalIndex().entries)[0]
  assert.equal(state.loadGlobalIndex().entries[curatedId].vector.route, 'managed-local')
  assert.deepEqual((migrator.membership().global || []), [curatedId])
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

// 2026-11-18 排序修正端到端：RRF 名次归一把词法满分命中压成近平手后，primacy/peakEnd
// 偏置会把弱相关元记忆顶到第一（运行时实测：lexical 219.5 的完美命中被挤到 #8）。
// 修复后巨无霸命中保住 #1，弱竞争者落到相对阈值之外。
test('a dominant lexical hit cannot be buried by primacy/peak-end biases', async () => {
  state.updateSettings({ memoryBackend: 'api', vectorSource: 'local' })
  // 大语料抬高 BM25 的库规模（IDF 随 N 增长，小语料造不出 ≥24 的巨无霸分）。
  const entries = {}
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'
  const token = (n) => alphabet[n % 26] + alphabet[Math.floor(n / 26) % 26]
  const old = '2026-10-01T00:00:00.000Z'
  for (let i = 0; i < 60; i += 1) {
    entries['mem-pad-' + String(i).padStart(2, '0')] = entry('常规条目 ' + token(3 * i) + token(3 * i + 1) + '，归档说明与轮值安排。', {
      createdAt: old, updatedAt: old, strength: 1, arousal: 0.9,
    })
  }
  // meta：最早创建（primacy ×1.2）+ 高唤醒（peakEnd ×1.25）+ strength 1——偏置加成最大；
  // 正文含查询里的常见词元（有/没有），让它也进词法腿，制造名次归一的近平手。
  entries['mem-meta'] = entry('运营值守安排，没有什么特别的说明。', { createdAt: old, updatedAt: old, strength: 1, arousal: 0.9 })
  entries['mem-food'] = entry('主人是江南人，爱吃桂花糖糕，在杭州吃不到几家做糖糕和豆沙米糕的铺子。', { strength: 0.8, arousal: 0.35 })
  const f = fixture(entries)
  activate([f.libraryId])
  // 语义腿把 meta 排在 food 前面（模拟引擎 embedding 被查询样板带偏的形态）：
  // 词法腿 food 满分，RRF 名次归一后两者 retrieval 近平手。
  retrieveHook = () => ({ files: [{ name: 'mem-meta' }, { name: 'mem-food' }], segments: [], resources: [] })
  const result = await memory.privateRecall({ exec: f.exec, query: '桂花的，我江南小囡喜欢吃糖糕，还有豆沙米糕', topK: 5, relevanceThreshold: 0.4 })
  assert.equal(result.files[0]?.name, 'mem-food', 'the dominant lexical hit must rank first, got ' + result.files[0]?.name)
  assert.ok((result.files[0]?.fusion?.lexicalDominant ?? 0) >= 24, 'the dominance must be recorded in fusion metadata')
  assert.ok(!result.files.some((file) => file.name === 'mem-meta'), 'weak competitors fall below the relative threshold')
  retrieveHook = null
})

// Real BM25 regressions: only the semantic boundary is stubbed. Dates deliberately
// age with now; a future sceneTime must not erase strength/primacy in these cases.
function rankingEntry(content, extra = {}) {
  const ago = days => new Date(Date.now() - days * 86_400_000).toISOString()
  return entry(content, { createdAt: ago(2), updatedAt: ago(1), ...extra })
}

function rankingWorld(primaryEntries, foreignEntries) {
  const primary = fixture(primaryEntries)
  const foreign = fixture(foreignEntries)
  const domain = 'ranking:' + primary.sessionId
  for (const f of [primary, foreign]) state.setSessionBinding(f.sessionId, { domainOverride: domain })
  state.updateSettings({ crossLibraryRecall: true })
  return { primary, foreign }
}

function realLexical(entries, query) {
  const corpus = buildCorpus(Object.entries(entries).map(([id, row]) => ({
    id, title: row.title,
    content: [row.content, (row.tags || []).join(' '), (row.attachments || []).map(item => `${item.caption || ''} 图片 ${item.kind || 'image'}`).join(' ')].filter(Boolean).join(' '),
  })))
  return new Map([...corpus.docs].map(([id, doc]) => [id, bm25(tokenize(query), doc, corpus)]))
}

async function assertRankingBoundary(expectedRetrieves) {
  await settleRebuildProbes()
  assert.equal(calls.length, expectedRetrieves, 'only the stub semantic retrieve boundary is called')
  assert.ok(calls.every(call => call.op === 'retrieve' && call.route === 'managed-local'))
  assert.deepEqual(rebuildProbes, [], 'ranking regressions must not start a real rebuild/worker')
  assert.deepEqual(warnings, [])
}

const tlsAnswer = 'TLS 服务证书过期，续签后重启代理恢复连接。'
const tlsTemplate = '请用自然简洁的语气回答。这是通用回复风格，不涉及饮食或服务故障。'
const pianoNotes = [
  '钢琴练习先慢速弹奏音阶，再练左右手协调。',
  '巴赫赋格练习需要分声部辨认旋律。',
  '踏板练习要注意换踏时机与音色。',
  '周末排练莫扎特奏鸣曲，保持轻巧触键。',
  '视奏练习每天十五分钟，先看拍号与调号。',
  '和弦转位练习强调指法与手腕放松。',
  '节拍器从慢速逐渐加快，避免抢拍。',
  '演出前检查琴凳高度，认真完成热身。',
]
function tlsEntries(template, size = 2) {
  const answerDate = new Date(Date.now() - 4 * 86_400_000).toISOString()
  return {
    'mem-answer': rankingEntry(tlsAnswer, { createdAt: answerDate, strength: 1, peak: true }),
    'mem-template': rankingEntry(template, { strength: 0.8 }),
    ...Object.fromEntries(pianoNotes.slice(0, size - 2).map((text, i) => ['mem-piano-' + i, rankingEntry(text)])),
  }
}

for (const crossLibrary of [false, true]) {
  test(`real BM25 short reply style leaves TLS answer first (${crossLibrary ? 'with three foreign piano notes' : 'two-entry library'})`, async () => {
    const entries = tlsEntries(tlsTemplate)
    const world = crossLibrary
      ? rankingWorld(entries, Object.fromEntries(pianoNotes.slice(0, 3).map((text, i) => ['mem-note-' + i, rankingEntry(text)])))
      : null
    const f = world?.primary || fixture(entries)
    activate(world ? [f.libraryId, world.foreign.libraryId] : [f.libraryId])
    retrieveHook = args => ({ files: args.db === vp.dbPathFor(f.libraryId) ? [{ name: 'mem-answer' }, { name: 'mem-template' }] : [], segments: [], resources: [] })
    const result = await memory.privateRecall({ exec: f.exec, query: '请用自然简洁的语气回答。TLS 故障原因？', topK: 5, relevanceThreshold: 0 })
    assert.equal(result.files[0]?.name, 'mem-answer', 'corpus changes must not crown the reply-style template')
    const template = result.files.find(file => file.name === 'mem-template')
    assert.ok(template?.lexical > 0, 'the original lexical score stays observable')
    assert.ok(template.lexicalEvidence < template.lexical, 'style-only overlap is not topical evidence')
    assert.notEqual(result.fusion?.lexicalDominance?.id, 'mem-template')
    assert.equal(result.files[0].entry.content, tlsAnswer)
    if (crossLibrary) assert.equal(result.files[0].libraryId, f.libraryId)
    await assertRankingBoundary(crossLibrary ? 2 : 1)
  })
}

for (const [language, template, query] of [
  ['short Chinese', tlsTemplate, '请用自然简洁的语气回答。TLS 故障原因？'],
  ['Chinese', '请结合上下文准确理解我的问题，不要机械重复，给出自然简洁且有条理的回复。', '请结合上下文准确理解我的问题，不要机械重复，给出自然简洁且有条理的回复。TLS 故障原因？'],
  ['English', 'Please answer clearly and concisely with accurate context and natural language. Avoid repetition and unnecessary details.', 'Please answer clearly and concisely with accurate context and natural language. Avoid repetition and unnecessary details. What caused TLS failure?'],
]) {
  for (const size of [2, 3, 10]) {
    test(`real BM25 ${language} long reply style keeps TLS answer first with ${size} documents`, async () => {
      const f = fixture(tlsEntries(template, size))
      activate([f.libraryId])
      retrieveHook = () => ({ files: [{ name: 'mem-answer' }, { name: 'mem-template' }], segments: [], resources: [] })
      const result = await memory.privateRecall({ exec: f.exec, query, topK: 5, relevanceThreshold: 0.4 })
      assert.ok(result.files.length, 'style removal must not turn a topical query into empty recall')
      assert.equal(result.files[0]?.name, 'mem-answer')
      assert.notEqual(result.fusion?.lexicalDominance?.id, 'mem-template')
      assert.ok(result.files[0].lexical > 0, 'TLS remains an actual lexical hit, not only a semantic rescue')
      await assertRankingBoundary(1)
    })
  }
}

const rankingWords = 'certificate expired renewal proxy restart connection handshake trust chain hostname issuer validity protocol cipher client server clock intermediate root authority verification transport security gateway service outage investigation diagnosis mitigation deployment recovery monitoring incident encryption authentication socket timeout negotiation alert endpoint configuration rotation revocation openssl pem browser response failure latency availability maintenance rollback'.split(' ')
const foodQuery = '桂花的，我江南小囡喜欢吃糖糕，还有豆沙米糕'
const foodAnswer = '主人是江南人，爱吃桂花糖糕，在杭州吃不到几家做糖糕和豆沙米糕的铺子。'

test('real BM25 a weak 的 hit is no worse than zero evidence and preserves topical answer order', async () => {
  const topicQuery = '桂花 江南 糖糕 豆沙米糕 杭州 铺子'
  const entries = {
    'mem-food': rankingEntry(foodAnswer, { peak: true, createdAt: new Date(Date.now() - 4 * 86_400_000).toISOString() }),
    'mem-semantic': rankingEntry('钢琴练习巴赫赋格。', { strength: 0.8 }),
    'mem-weak': rankingEntry('归档标记：的', { strength: 0.8 }),
  }
  const f = fixture(entries)
  activate([f.libraryId])
  retrieveHook = () => ({ files: [{ name: 'mem-food' }, { name: 'mem-semantic' }], segments: [], resources: [] })
  const result = await memory.privateRecall({ exec: f.exec, query: topicQuery + ' 的', topK: 5, relevanceThreshold: 0 })
  assert.equal(result.files[0]?.name, 'mem-food')
  assert.ok(result.fusion.lexicalDominance?.topLex >= 24, 'the test must exercise dominance, not an inactive branch')
  const weak = result.files.find(file => file.name === 'mem-weak')
  const zero = result.files.find(file => file.name === 'mem-semantic')
  assert.ok(weak?.lexical > 0 && weak.lexical < result.files[0].lexical / 20, '的 is a real but tiny BM25 hit')
  assert.ok(zero, 'the zero-evidence semantic candidate remains observable')
  assert.equal(zero.lexical ?? 0, 0)
  const sigma = 1 / (1 + result.fusion.lexicalDominance.topLex / 50)
  assert.ok(Math.abs(weak.fusion.lexicalDiscount - sigma) < 1e-12, 'tiny evidence is protected by the continuous sigma floor')
  assert.ok(weak.fusion.lexicalDiscount >= zero.fusion.lexicalDiscount, 'a tiny lexical hit cannot be penalized more than no hit')
  const baseline = await memory.privateRecall({ exec: f.exec, query: topicQuery, topK: 5, relevanceThreshold: 0 })
  assert.deepEqual(result.files.filter(file => file.name !== 'mem-weak').map(file => file.name), baseline.files.filter(file => file.name !== 'mem-weak').map(file => file.name))
  await assertRankingBoundary(2)
})

test('real BM25 cross-library same-id facts stay separate and a strong foreign hit is real evidence', async () => {
  state.updateSettings({ memoryBackend: 'agent' })
  const query = rankingWords.slice(0, 38).join(' ')
  const primaryEntries = {
    // 逆序打破逐字包含/核心覆盖探针：两条同 id 事实必须靠身份而不是内容去重存活。
    'mem-shared': rankingEntry(rankingWords.slice(0, 3).reverse().join(' ')),
    'mem-secondary': rankingEntry(rankingWords.slice(3, 9).join(' ')),
  }
  const foreignEntries = { 'mem-shared': rankingEntry(query), 'mem-piano': rankingEntry(pianoNotes[0]) }
  const { primary, foreign } = rankingWorld(primaryEntries, foreignEntries)
  const all = await memory.privateRecall({ exec: primary.exec, query, topK: 5, relevanceThreshold: 0 })
  assert.deepEqual(new Set(all.libraries), new Set([primary.libraryId, foreign.libraryId]))
  const twins = all.files.filter(file => file.name === 'mem-shared')
  assert.equal(twins.length, 2, 'same id in two libraries is two facts, not one folded row')
  const sharedPrimary = twins.find(file => file.libraryId === primary.libraryId)
  const sharedForeign = twins.find(file => file.libraryId === foreign.libraryId)
  assert.equal(sharedPrimary.entry.content, primaryEntries['mem-shared'].content)
  assert.equal(sharedForeign.entry.content, query)
  assert.ok(sharedForeign.lexical > sharedPrimary.lexical, 'each twin keeps its own unified-corpus evidence, nothing is inherited')
  assert.ok(all.files.some(file => file.name === 'mem-secondary' && file.libraryId === primary.libraryId))
  assert.ok(!all.files.some(file => file.name === 'mem-piano'), 'zero-evidence foreign filler stays out')
  assert.equal(all.files[0].libraryId, foreign.libraryId, 'the genuinely strong foreign fact outranks weak local rows')
  assert.equal(all.fusion.crossLibraryLexical, 'unified-bm25')
  const cut = await memory.privateRecall({ exec: primary.exec, query, topK: 5, relevanceThreshold: 0.8 })
  assert.deepEqual(cut.files.map(file => [file.libraryId, file.name]), [[foreign.libraryId, 'mem-shared']], 'the 0.8 cut is real competition now, not ghost removal')
  const evidence = file => file.lexicalEvidence ?? file.lexical ?? 0
  const ranked = all.files.slice().sort((a, b) => evidence(b) - evidence(a))
  const dominant = evidence(ranked[0]) >= 24 && evidence(ranked[0]) >= evidence(ranked[1]) * 4
  assert.equal(Boolean(all.fusion.lexicalDominance), dominant, 'dominance is computed from the surviving unified evidence')
  if (dominant) assert.equal(all.fusion.lexicalDominance.id, ranked[0].name)
  for (const file of all.files) {
    assert.ok(Math.abs(file.retrievalScore - Math.min(1, file.fusion.rawRetrievalScore * (file.fusion.lexicalDiscount ?? 1))) < 1e-12)
  }
  await assertRankingBoundary(0)
})

for (const gate of ['disclosure', 'speaker']) {
  test(`real BM25 ${gate} filtering recomputes dominance from eligible candidates`, async () => {
    const query = (gate === 'speaker' ? '我说过 ' : '') + rankingWords.join(' ')
    const entries = {
      'mem-hidden': rankingEntry(rankingWords.join(' '), gate === 'disclosure' ? { disclosure: 'only_if_asked' } : { speaker_id: 'assistant' }),
      'mem-small': rankingEntry(rankingWords.slice(0, 3).join(' '), { speaker_id: 'user', strength: 0.8 }),
      'mem-normal': rankingEntry('钢琴练习已经完成，下一次排练在周末。', { speaker_id: 'user', strength: 0.8 }),
    }
    const scores = realLexical(entries, query)
    assert.ok(scores.get('mem-hidden') >= 24 && scores.get('mem-hidden') >= scores.get('mem-small') * 4)
    const f = fixture(entries)
    activate([f.libraryId])
    retrieveHook = () => ({ files: [{ name: 'mem-normal' }], segments: [], resources: [] })
    const result = await memory.privateRecall({ exec: f.exec, query, topK: 5, relevanceThreshold: 0.8, purpose: 'automatic' })
    assert.deepEqual(new Set(result.files.map(file => file.name)), new Set(['mem-normal', 'mem-small']))
    assert.equal(result.fusion.lexicalDominance, null, 'the final summary must not retain the excluded top')
    for (const file of result.files) {
      assert.equal(file.fusion.lexicalDominant, undefined)
      assert.equal(file.fusion.lexicalDiscount, undefined)
      assert.equal(file.retrievalScore, file.fusion.rawRetrievalScore, 'filtered survivors recover their raw RRF share')
    }
    await assertRankingBoundary(1)
  })
}

test('real BM25 nested vector and cross-library RRF applies exactly one sigma to semantic-only recall', async () => {
  const query = rankingWords.join(' ')
  const entries = {
    'mem-strong': rankingEntry(query),
    'mem-mild': rankingEntry('端口8443证书根链验证失败，需要检查中间CA是否被撤销。', { tags: rankingWords.slice(0, 22) }),
    'mem-semantic': rankingEntry(pianoNotes.join(' ')),
  }
  const scores = realLexical(entries, query)
  const inner = memory.fuseRecallCandidates({
    index: { entries },
    local: ['mem-strong', 'mem-mild'].map(name => ({ name, entry: entries[name], content: entries[name].content, lexical: scores.get(name) })),
    semantic: [{ name: 'mem-semantic' }, { name: 'mem-strong' }],
  })
  assert.deepEqual(inner.files.map(file => file.name), ['mem-strong', 'mem-mild', 'mem-semantic'], 'real lexical evidence changes the discounted inner ordering')
  assert.ok(inner.files[2].fusion.rawRetrievalScore > inner.files[1].fusion.rawRetrievalScore, 'raw order is semantic before mild, the opposite of discounted order')
  assert.equal(inner.debug.lexicalDominance.id, 'mem-strong')
  const { primary, foreign } = rankingWorld(entries, {})
  activate([primary.libraryId, foreign.libraryId])
  retrieveHook = args => ({ files: args.db === vp.dbPathFor(primary.libraryId) ? [{ name: 'mem-semantic' }, { name: 'mem-strong' }] : [], segments: [], resources: [] })
  const result = await memory.privateRecall({ exec: primary.exec, query, topK: 5, relevanceThreshold: 0 })
  assert.equal(result.recallRoute, 'cross-library')
  assert.deepEqual(new Set(result.files.map(file => file.name)), new Set(['mem-strong', 'mem-mild', 'mem-semantic']))
  assert.equal(result.fusion.crossLibraryLexical, 'unified-bm25')
  assert.equal(result.fusion.crossLibrarySemantic, 'rank-only', 'hook files carry no scores, so the vector leg stays rank-only')
  const strong = result.files.find(file => file.name === 'mem-strong')
  const semantic = result.files.find(file => file.name === 'mem-semantic')
  const mild = result.files.find(file => file.name === 'mem-mild')
  // 统一语料此刻恰好等于主库三文档（外库为空），BM25 值与 realLexical 一致。
  const topLex = scores.get('mem-strong')
  assert.ok(topLex >= 24)
  assert.equal(strong.lexical, topLex)
  assert.equal(mild.lexical, scores.get('mem-mild'))
  // 方法间 RRF：词法腿 strong=1 mild=2，向量腿（rank-only）semantic=1 strong=2。
  const rrfStrong = 1 / 61 + 1 / 62
  assert.ok(Math.abs(strong.fusion.rawRetrievalScore - 1) < 1e-12)
  assert.ok(Math.abs(mild.fusion.rawRetrievalScore - (1 / 62) / rrfStrong) < 1e-12)
  assert.ok(Math.abs(semantic.fusion.rawRetrievalScore - (1 / 61) / rrfStrong) < 1e-12, 'outer RRF is rebuilt from unified leg ranks, not the discounted inner order')
  assert.equal(strong.fusion.bestRank, 1)
  assert.equal(mild.fusion.bestRank, 2, 'outer rank comes from the unified lexical leg, not the discounted inner rank of two')
  assert.equal(semantic.fusion.bestRank, 1)
  const sigma = 1 / (1 + topLex / 50)
  const mildDiscount = Math.sqrt(scores.get('mem-mild') / topLex)
  assert.ok(mildDiscount > sigma, 'the mild fact genuinely exercises the square-root branch')
  assert.ok(Math.abs(strong.retrievalScore - 1) < 1e-12)
  assert.ok(Math.abs(mild.retrievalScore - (1 / 62) / rrfStrong * mildDiscount) < 1e-12)
  assert.ok(Math.abs(semantic.retrievalScore - (1 / 61) / rrfStrong * sigma) < 1e-12, 'exactly one sigma, not multiplied by the inner share')
  assert.ok(Math.abs(semantic.retrievalScore - (1 / 61) / rrfStrong * sigma * sigma) > 0.01)
  assert.equal(result.fusion.lexicalDominance.id, 'mem-strong')
  assert.equal(result.fusion.lexicalDominance.stage, 'eligible')
  assert.equal(result.fusion.lexicalDominance.topLex, strong.lexical)
  assert.equal(semantic.fusion.lexicalDominantId, 'mem-strong')
  assert.equal(semantic.fusion.dominanceStage, 'eligible')
  assert.equal(calls.filter(call => call.db === vp.dbPathFor(primary.libraryId)).length, 1)
  assert.equal(calls.filter(call => call.db === vp.dbPathFor(foreign.libraryId)).length, 1)
  await assertRankingBoundary(2)
})

test('real BM25 two tied genuinely strong topical hits both survive without corpus padding', async () => {
  const query = rankingWords.join(' ')
  const entries = {
    'mem-tls-a': rankingEntry(rankingWords.slice(0, 26).join(' ')),
    'mem-tls-b': rankingEntry(rankingWords.slice(26).join(' ')),
  }
  const f = fixture(entries)
  activate([f.libraryId])
  retrieveHook = () => ({ files: [{ name: 'mem-tls-a' }, { name: 'mem-tls-b' }], segments: [], resources: [] })
  const result = await memory.privateRecall({ exec: f.exec, query, topK: 5, relevanceThreshold: 0.8 })
  assert.deepEqual(new Set(result.files.map(file => file.name)), new Set(['mem-tls-a', 'mem-tls-b']))
  for (const file of result.files) assert.ok(file.lexical >= 24, 'both hits are genuinely strong in this two-row corpus')
  assert.equal(result.fusion.lexicalDominance, null, 'two near-equal lexical tops do not single out a dominant row')
  await assertRankingBoundary(1)
})

test('real BM25 QQ private-chat envelope and preference trailer preserve food as the top answer', async () => {
  const query = '[私聊:900000001]22:11 Linxiu(900000001)[主人] #-100000001 [@咱]：桂花的，我江南小囡喜欢吃糖糕，还有豆沙米糕\n[管理员的长期偏好·优先遵守]请结合上下文准确理解我的问题，不要机械重复，给出自然简洁且有条理的回复。\n【本会话是QQ私聊：900000001。请用自然简洁的语气回答。】'
  const now = Date.now()
  const recentCreatedAt = new Date(now - 2 * 86_400_000).toISOString()
  const f = fixture({
    'mem-food': rankingEntry(foodAnswer, { strength: 0.8, createdAt: recentCreatedAt }),
    'mem-template': rankingEntry('[管理员的长期偏好·优先遵守]请结合上下文准确理解我的问题，不要机械重复，给出自然简洁且有条理的回复。【本会话是QQ私聊：900000001。请用自然简洁的语气回答。】', { peak: true, createdAt: new Date(now - 4 * 86_400_000).toISOString() }),
    'mem-piano': rankingEntry(pianoNotes[0], { createdAt: recentCreatedAt }),
  })
  activate([f.libraryId])
  retrieveHook = () => ({ files: [{ name: 'mem-template' }, { name: 'mem-food' }], segments: [], resources: [] })
  const result = await memory.privateRecall({ exec: f.exec, query, topK: 5, relevanceThreshold: 0.4 })
  assert.equal(result.files[0]?.name, 'mem-food', 'QQ transport text is not evidence of the user topic: ' + JSON.stringify({ fusion: result.fusion, files: result.files.map(({ name, lexical, lexicalEvidence, retrievalScore, score, fusion }) => ({ name, lexical, lexicalEvidence, retrievalScore, score, fusion })) }))
  assert.ok(result.files[0].lexical > 0 && result.files[0].lexicalEvidence > 0)
  assert.notEqual(result.fusion.lexicalDominance?.id, 'mem-template')
  assert.equal(calls[0].query, query, 'the semantic/index-facing query remains the original QQ message')
  await assertRankingBoundary(1)
})

test('real BM25 same-leg and cross-leg folding retain the absorbed topical lexical evidence', async () => {
  const topic = rankingWords.join(' ')
  const query = '请用自然简洁的语气回答。' + topic
  const body = 'TLS故障已记录，请用自然简洁的语气回答。故障排查统一记录在运维台账。'
  const entries = {
    'mem-a-host': rankingEntry(body, { tags: rankingWords.slice(0, 3) }),
    'mem-z-strong': rankingEntry(body, { tags: rankingWords }),
    'mem-piano': rankingEntry(pianoNotes[0]),
  }
  const originalScores = realLexical(entries, query)
  const evidenceScores = realLexical(entries, topic)
  assert.ok(evidenceScores.get('mem-z-strong') >= 24)
  assert.ok(originalScores.get('mem-z-strong') > originalScores.get('mem-a-host'))
  assert.ok(originalScores.get('mem-z-strong') > evidenceScores.get('mem-z-strong'), 'raw lexical includes the style overlap but evidence does not')
  const f = fixture(entries)
  activate([f.libraryId])
  retrieveHook = () => ({ files: [{ name: 'mem-a-host' }, { name: 'mem-z-strong' }], segments: [], resources: [] })
  const result = await memory.privateRecall({ exec: f.exec, query, topK: 5, relevanceThreshold: 0.8 })
  assert.deepEqual(result.files.map(file => file.name), ['mem-a-host'], 'one real fact occupies one recall slot after both folding stages')
  const host = result.files[0]
  assert.equal(host.lexical, originalScores.get('mem-z-strong'), 'the absorbed source retains its stronger original BM25 score')
  assert.equal(host.lexicalEvidence, evidenceScores.get('mem-z-strong'), 'topical BM25 evidence is inherited independently of raw lexical')
  assert.deepEqual(host.mergedTogether, ['mem-z-strong'])
  assert.ok(result.fusion.collapsed.some(group => group.kept === 'mem-z-strong' && group.dropped.includes('mem-a-host')), 'within-leg duplicate folding occurred')
  assert.ok(result.fusion.collapsed.some(group => group.kept === 'mem-a-host' && group.dropped.includes('mem-z-strong')), 'semantic/cross-leg host absorbed the lexical source')
  assert.equal(result.fusion.lexicalDominance.id, 'mem-a-host', 'the surviving host owns the final dominance trace')
  assert.equal(result.fusion.lexicalDominance.topLex, host.lexicalEvidence)
  assert.equal(host.fusion.rawRetrievalScore, 1)
  await assertRankingBoundary(1)
})

test('real BM25 Python in a request is topical evidence rather than a disposable reply template', async () => {
  const query = '请用Python回答TLS故障原因'
  const entries = {
    'mem-python': rankingEntry('请用Python回答TLS故障原因：Python ssl 模块报告证书过期。'),
    'mem-other': rankingEntry(pianoNotes[0]),
  }
  const f = fixture(entries)
  activate([f.libraryId])
  retrieveHook = () => ({ files: [], segments: [], resources: [] })
  const result = await memory.privateRecall({ exec: f.exec, query, topK: 5, relevanceThreshold: 0.4 })
  assert.equal(result.files[0]?.name, 'mem-python', 'a topic-bearing imperative must not be cleared')
  const hit = result.files[0]
  assert.equal(hit.lexical, realLexical(entries, query).get('mem-python'))
  assert.equal(hit.lexicalEvidence ?? hit.lexical, hit.lexical, 'Python/TLS are retained in dominance evidence')
  assert.equal(calls[0].query, query)
  await assertRankingBoundary(1)
})

test('automatic recall backfills a sixth qualified hit and reintroduces a changed admitted revision', async () => {
  state.updateSettings({ hybridRecall: true })
  const names = Array.from({ length: 6 }, (_, i) => 'mem-replay-' + i)
  const stamp = new Date(Date.now() - 86400000).toISOString()
  const entries = Object.fromEntries(names.map((name, i) => [name, rankingEntry(`AtlasReplay 部署备份节点${i}保留14天，每天执行核验。`, { createdAt: stamp, updatedAt: stamp })]))
  const f = fixture(entries)
  activate([f.libraryId])
  retrieveHook = () => ({ files: names.map(name => ({ name })), segments: [], resources: [] })
  const query = 'AtlasReplay 部署备份保留14天'
  const initial = await memory.privateRecall({ exec: f.exec, query, topK: 6, relevanceThreshold: 0.8, purpose: 'automatic' })
  assert.equal(initial.groups.length, 6)
  const shown = initial.refs.slice(0, 5)
  state.markInjectedRefs(f.sessionId, shown, 1, { messageId: 'admitted-replay-five', hostTurn: 1 })
  const excludedRefs = state.recentMemoryRefs(state.getSessionBinding(f.sessionId), 2, 16)
  const next = await memory.privateRecall({ exec: f.exec, query, topK: 1, relevanceThreshold: 0.8, purpose: 'automatic', excludedRefs })
  assert.equal(next.groups.length, 1)
  assert.equal(next.files[0].name, initial.refs[5].id)
  assert.equal(next.trace.counts.recentRows, 5)
  const changedId = shown[0].id
  await state.updatePrivateIndex(f.libraryId, index => { index.entries[changedId].content += ' 已补充副本验证。' })
  const changed = await memory.privateRecall({ exec: f.exec, query, topK: 1, relevanceThreshold: 0.8, purpose: 'automatic', excludedRefs })
  assert.equal(changed.files[0].name, changedId)
  assert.notEqual(changed.refs[0].revision, shown[0].revision)
  assert.equal(changed.groups[0].reintroducedForRevision, true)
  await assertRankingBoundary(2)
})

test('automatic recent exclusion cannot promote an unqualified lexical-only noise hit', async () => {
  state.updateSettings({ hybridRecall: true })
  const names = Array.from({ length: 5 }, (_, i) => 'mem-qualified-' + i)
  const stamp = new Date(Date.now() - 86400000).toISOString()
  const entries = Object.fromEntries(names.map((name, i) => [name, rankingEntry(`AtlasQuiet 部署备份节点${i}保留14天，每天执行核验。`, { createdAt: stamp, updatedAt: stamp })]))
  entries['mem-quiet-noise'] = rankingEntry('AtlasQuiet 的闲聊杂谈，没有备份安排。', { createdAt: stamp, updatedAt: stamp })
  const f = fixture(entries)
  activate([f.libraryId])
  retrieveHook = () => ({ files: names.map(name => ({ name })), segments: [], resources: [] })
  const query = 'AtlasQuiet 部署备份保留14天'
  const initial = await memory.privateRecall({ exec: f.exec, query, topK: 5, relevanceThreshold: 0.8, purpose: 'automatic' })
  assert.equal(initial.refs.length, 5)
  state.markInjectedRefs(f.sessionId, initial.refs, 1, { messageId: 'admitted-qualified-five', hostTurn: 1 })
  const next = await memory.privateRecall({ exec: f.exec, query, topK: 1, relevanceThreshold: 0.8, purpose: 'automatic', excludedRefs: state.recentMemoryRefs(state.getSessionBinding(f.sessionId), 2, 16) })
  assert.deepEqual(next.files, [])
  assert.ok(next.trace.counts.weakRows > 0)
  assert.equal(next.trace.counts.recentRows, 5)
  await assertRankingBoundary(2)
})
