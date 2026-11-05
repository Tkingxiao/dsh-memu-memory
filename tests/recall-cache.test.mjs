import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'

// P1-1 召回缓存测试。两部分：
//   1) 纯单元：lib/recall-cache.js 的 LRU/TTL/代数/wrap 去重/fail-open/键规范化；
//   2) 接线：managedRecall 的缓存命中、写路径失效、local-fallback 不缓存。
//      managedRecall 不是导出函数，接线行为从导出入口 privateRecall（purpose:
//      'automatic'，不触发 touchAccess 写）覆盖，mock 手法仿 tests/managed-memory.test.mjs：
//      在导入任何生产模块前用 registerHooks 把 ./memu.js 换成内存桥。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-recall-cache-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const calls = []
const warnings = []
globalThis.__recallCacheTest = {
  async commit(args) { calls.push({ op: 'commit', ...args }); return { ok: true } },
  async retrieve(args) { calls.push({ op: 'retrieve', ...args }); return retrieveHook(args) },
  async forget(args) { calls.push({ op: 'forget', ...args }); return { deleted: 1, segments: 1 } },
  async listFiles() { return { recall_files: [], resources: [], raw: null } },
}
let retrieveHook = () => ({ files: [], segments: [], resources: [], raw: null })
const engineSource = 'const bridge = globalThis.__recallCacheTest; export const commit = bridge.commit, retrieve = bridge.retrieve, forget = bridge.forget, listFiles = bridge.listFiles, closeMemuResident = () => 0, prewarmMemuResident = async () => false;'
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './memu.js') {
      return { url: 'data:text/javascript,' + encodeURIComponent(engineSource), shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const { createRecallCache, recallCache, recallCacheKey } = await import('../lib/recall-cache.js')
const state = await import('../lib/state.js')
const vp = await import('../lib/vector-profile.js')
const paths = await import('../lib/paths.js')
const memory = await import('../lib/memory.js')

// ---------------------------------------------------------------- 纯单元部分

test('LRU 容量驱逐：max=2 放 3 个，最旧（未刷新）的先被逐', () => {
  const cache = createRecallCache({ max: 2 })
  cache.set('a', { v: 'a' })
  cache.set('b', { v: 'b' })
  assert.deepEqual(cache.get('a'), { v: 'a' }, '命中把 a 刷成最新')
  cache.set('c', { v: 'c' })
  assert.equal(cache.get('b'), null, 'b 是最旧的，被驱逐')
  assert.deepEqual(cache.get('c'), { v: 'c' })
  assert.deepEqual(cache.get('a'), { v: 'a' })
  const stats = cache.stats()
  assert.equal(stats.size, 2)
  assert.equal(stats.evictions, 1)
})

test('TTL 过期：注入假时钟，到点即失效并计逐出', () => {
  let now = 1_000
  const cache = createRecallCache({ ttlMs: 100, now: () => now })
  cache.set('k', { v: 1 })
  now = 1_099
  assert.deepEqual(cache.get('k'), { v: 1 }, '到期前一刻仍有效')
  now = 1_100
  assert.equal(cache.get('k'), null, 'now >= 存入时刻+ttl 即过期')
  assert.equal(cache.stats().evictions, 1, '过期即逐出')
  assert.equal(cache.stats().misses, 1)
})

test('bumpGeneration：旧键立即失联；在途 producer 落回旧代，不污染新代', async () => {
  const cache = createRecallCache()
  cache.set('k', { v: 'old' })
  cache.bumpGeneration()
  assert.equal(cache.get('k'), null, 'bump 后旧键立即失联')
  assert.equal(cache.stats().generations, 1)

  let release
  const gate = new Promise((resolve) => { release = resolve })
  let runs = 0
  const inflight = cache.wrap('k', async () => { runs += 1; await gate; return { v: 'in-flight' } })
  cache.bumpGeneration()
  release()
  assert.deepEqual(await inflight, { v: 'in-flight' }, '在途请求照常拿到自己的结果')
  assert.equal(cache.get('k'), null, '旧代落地的结果在新代不可见')
  let secondRuns = 0
  const fresh = await cache.wrap('k', async () => { secondRuns += 1; return { v: 'fresh' } })
  assert.deepEqual(fresh, { v: 'fresh' }, '新代重新计算，绝不命中旧值')
  assert.equal(runs + secondRuns, 2, '旧代结果没有回流成新代缓存')
  cache.bumpGeneration()
  assert.equal(cache.stats().size, 0, '下一次 bump 把旧代残留清掉')
})

test('wrap 的 promise 去重：并发两次同 key，producer 只执行一次', async () => {
  const cache = createRecallCache()
  let runs = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const producer = async () => { runs += 1; await gate; return { n: runs } }
  const first = cache.wrap('k', producer)
  const joined = cache.wrap('k', producer)
  assert.equal(first, joined, '同 key 在途合并复用同一个 promise')
  assert.equal(cache.stats().inflight, 1)
  release()
  const [x, y] = await Promise.all([first, joined])
  assert.equal(runs, 1)
  assert.deepEqual(x, y)
  assert.equal(cache.stats().inflight, 0)
  const stats = cache.stats()
  assert.equal(stats.misses, 1)
  assert.equal(stats.hits, 1, '在途合并计为一次命中')
})

test('producer 抛错：不缓存、原样透传，下次重新执行', async () => {
  const cache = createRecallCache()
  let runs = 0
  await assert.rejects(
    cache.wrap('k', async () => { runs += 1; throw new Error('producer boom') }),
    /producer boom/,
  )
  assert.equal(runs, 1)
  assert.equal(cache.stats().errors, 0, 'producer 的业务错误不是缓存自身故障')
  assert.equal(cache.stats().size, 0, '错误结果不入缓存')
  const value = await cache.wrap('k', async () => { runs += 1; return { ok: true } })
  assert.deepEqual(value, { ok: true })
  assert.equal(runs, 2, '上次失败没有留下缓存')
})

test('缓存自身故障 fail-open：错误计数与 onError 留痕，绝不影响取值', () => {
  const seen = []
  const cache = createRecallCache({ onError: (info) => seen.push(info) })
  // 值不可 structuredClone（含函数）→ set 失败开放，计数不抛出。
  cache.set('bad', { fn: () => {} })
  assert.equal(cache.get('bad'), null, '写失败的键按未命中处理')
  assert.equal(cache.stats().size, 0)
  // 假时钟爆炸 → get 失败开放，返回 null。
  let boom = false
  const clocky = createRecallCache({ now: () => { if (boom) throw new Error('clock broke'); return 1 } })
  clocky.set('k', { v: 1 })
  boom = true
  assert.equal(clocky.get('k'), null)
  assert.match(clocky.stats().lastError, /get: clock broke/)
  assert.ok(seen.some((info) => info.op === 'set'), 'onError 把吞没的故障暴露给调用方')
  assert.ok(cache.stats().errors >= 1)
})

test('键规范化：NFKC+trim+lowercase 归一，结构字段参与键', () => {
  const base = { query: 'ABC', topK: 5, libraryId: 'lib', byId: false, route: 'managed-local', generation: 'gen:1:ab', revision: 3 }
  assert.equal(recallCacheKey(base), recallCacheKey({ ...base, query: '  abc  ' }), '首尾空格与大小写归一')
  assert.equal(recallCacheKey(base), recallCacheKey({ ...base, query: 'ＡＢＣ' }), 'NFKC 折叠全角')
  assert.equal(recallCacheKey(base), recallCacheKey({ ...base, topK: '5' }), 'topK 数值归一')
  assert.notEqual(recallCacheKey(base), recallCacheKey({ ...base, query: 'abcd' }), '不同 query 不同键')
  assert.notEqual(recallCacheKey(base), recallCacheKey({ ...base, topK: 6 }), '不同 topK 不同键')
  assert.notEqual(recallCacheKey(base), recallCacheKey({ ...base, libraryId: 'lib2' }), '不同 libraryId 不同键')
  assert.notEqual(recallCacheKey(base), recallCacheKey({ ...base, route: 'remote-api' }), '不同 route 不同键')
  assert.notEqual(recallCacheKey(base), recallCacheKey({ ...base, generation: 'gen:2:cd' }), '向量代数变化换键')
  assert.notEqual(recallCacheKey(base), recallCacheKey({ ...base, revision: 4 }), '写路径 revision 变化换键')
  assert.notEqual(recallCacheKey(base), recallCacheKey({ ...base, automatic: true }), 'automatic 语义不同换键')
  assert.notEqual(recallCacheKey(base), recallCacheKey({ ...base, sessionId: 's2' }), '会话可见性不同换键')
  assert.notEqual(recallCacheKey(base), recallCacheKey({ ...base, domain: 'rp' }), '域过滤不同换键')
  assert.notEqual(recallCacheKey(base), recallCacheKey({ ...base, context: { characterId: 'hero' } }), '绑定上下文不同换键')
})

test('invalidate：按规范化 query 精确失效，其他 query 不受牵连', async () => {
  const cache = createRecallCache()
  const keyOf = (q) => recallCacheKey({ query: q, topK: 4, libraryId: 'lib', route: 'remote-api' })
  await cache.wrap(keyOf('部署 窗口'), async () => ({ v: 1 }))
  await cache.wrap(keyOf('咖啡偏好'), async () => ({ v: 2 }))
  assert.equal(cache.invalidate('deploy-x'), 0)
  assert.equal(cache.invalidate('  部署 窗口  '), 1, 'trim + lowercase 归一后精确命中')
  assert.equal(cache.get(keyOf('部署 窗口')), null)
  assert.deepEqual(cache.get(keyOf('咖啡偏好')), { v: 2 }, '别的 query 不被牵连')
})

test('模块级单例存在且具备全部公开方法', () => {
  for (const method of ['get', 'set', 'bumpGeneration', 'invalidate', 'clear', 'stats', 'wrap', 'setErrorHandler']) {
    assert.equal(typeof recallCache[method], 'function', method)
  }
  assert.deepEqual(Object.keys(recallCache.stats()).sort(),
    ['errors', 'evictions', 'generations', 'hits', 'inflight', 'lastError', 'misses', 'size'])
})

// ---------------------------------------------------------------- 接线部分

let serial = 0
function entry(content, extra = {}) {
  return { status: 'active', title: content, content, layer: 'long_term', strength: 1,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...extra }
}
function fixture(entries = {}) {
  serial += 1
  const sessionId = 'cache-' + serial
  const cwd = path.join(home, 'project-' + serial)
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  state.setSessionBinding(sessionId, { useLibrary: true, useGlobal: true, domainOverride: 'coding' })
  state.savePrivateIndex(binding.libraryId, { entries })
  return { sessionId, libraryId: binding.libraryId, exec: { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding' } } } } }
}
function activate(libraryIds = []) {
  const profile = vp.profileFromCatalog('bge-small-zh-v1.5-int8')
  const databases = vp.buildDatabaseSet({ profile, generation: 1, libraryIds })
  fs.mkdirSync(path.join(home, 'libraries'), { recursive: true })
  for (const row of [databases.global, ...Object.values(databases.libraries)]) fs.writeFileSync(vp.resolveVectorPath(row.path), '')
  vp.updateVectorStateSync(current => ({ ...current, generation: 1, requested: null, pending: null,
    active: { status: 'active', generation: 1, fingerprint: profile.fingerprint, profile, databases } }))
}

const retrieveCalls = () => calls.filter((call) => call.op === 'retrieve').length

test.beforeEach(() => {
  state.updateSettings({ memoryBackend: 'api', vectorSource: 'local', relevanceThreshold: 0, privateTopK: 5 })
  state.saveGlobalIndex({ entries: {} })
  calls.length = 0
  warnings.length = 0
  retrieveHook = () => ({ files: [], segments: [], resources: [], raw: null })
  paths.setWarnSink((message) => warnings.push(String(message)))
})
test.after(() => {
  hooks.deregister()
  delete globalThis.__recallCacheTest
  paths.setWarnSink(null)
  fs.rmSync(home, { recursive: true, force: true })
})

// purpose 用 'automatic'（每轮注入的真正热路径）：显式召回会 touchAccess 写索引，
// 自己就会推进 revision——那是正确行为，但不适合演示命中。
test('接线：相同参数的两次召回，第二次命中缓存不再调 retrieveImpl', async () => {
  const f = fixture({ 'mem-needle': entry('needle local match'), 'mem-orbit': entry('orbital mechanics') })
  activate([f.libraryId])
  retrieveHook = () => ({ files: [{ name: 'mem-orbit' }], segments: [], resources: [] })
  const first = await memory.privateRecall({ exec: f.exec, query: 'needle', topK: 8, purpose: 'automatic' })
  assert.equal(first.recallRoute, 'managed-vector-rrf')
  assert.equal(retrieveCalls(), 1)
  const second = await memory.privateRecall({ exec: f.exec, query: 'needle', topK: 8, purpose: 'automatic' })
  assert.equal(second.recallRoute, 'managed-vector-rrf', '缓存值带着原 recallRoute 语义')
  assert.equal(retrieveCalls(), 1, '第二次没有再进语义召回')
  assert.deepEqual(second.files.map((file) => file.name), first.files.map((file) => file.name), '返回相同的 files')
  assert.deepEqual(new Set(second.files.map((file) => file.name)), new Set(['mem-needle', 'mem-orbit']))
  assert.equal(state.getSessionBinding(f.sessionId).lastRecallError, undefined, '命中路径照常清降级信号')
})

test('接线：写入索引后 revision 推进，第三次召回重新调 retrieveImpl 并拿到新记忆', async () => {
  const f = fixture({ 'mem-needle': entry('needle local match'), 'mem-orbit': entry('orbital mechanics') })
  activate([f.libraryId])
  retrieveHook = () => ({ files: [{ name: 'mem-orbit' }], segments: [], resources: [] })
  await memory.privateRecall({ exec: f.exec, query: 'needle', topK: 8, purpose: 'automatic' })
  await memory.privateRecall({ exec: f.exec, query: 'needle', topK: 8, purpose: 'automatic' })
  assert.equal(retrieveCalls(), 1)
  // 写路径失效：真实写收敛点（savePrivateIndex → memoryRevision 自增）改动键。
  const index = state.loadPrivateIndex(f.libraryId)
  index.entries['mem-fresh'] = entry('needle written just now')
  state.savePrivateIndex(f.libraryId, index)
  retrieveHook = () => ({ files: [{ name: 'mem-fresh' }], segments: [], resources: [] })
  const third = await memory.privateRecall({ exec: f.exec, query: 'needle', topK: 8, purpose: 'automatic' })
  assert.equal(retrieveCalls(), 2, '写入后缓存失效，语义召回真实重跑')
  assert.ok(third.files.some((file) => file.name === 'mem-fresh'), '拿到的是写入后的新世界，不是 stale 缓存')
})

test('接线：local-fallback 不缓存——失败的召回不会把降级结果放进缓存', async () => {
  const f = fixture({ 'mem-needle': entry('needle local match') })
  activate([f.libraryId])
  retrieveHook = () => { throw new Error('semantic leg down') }
  const failed = await memory.privateRecall({ exec: f.exec, query: 'needle', topK: 8, purpose: 'automatic' })
  assert.equal(failed.recallRoute, 'local-fallback')
  assert.equal(failed.errors.length, 1, 'fallback 带着 errors 信号')
  assert.equal(retrieveCalls(), 1)
  retrieveHook = () => ({ files: [{ name: 'mem-orbit' }], segments: [], resources: [] })
  const healthy = await memory.privateRecall({ exec: f.exec, query: 'needle', topK: 8, purpose: 'automatic' })
  assert.equal(healthy.recallRoute, 'managed-vector-rrf', '健康结果真实重算（失败那次没有占住键）')
  assert.equal(retrieveCalls(), 2, 'producer 抛错不缓存，第二次仍会执行')
})

test('接线：query 大小写/首尾空格不同命中同一键', async () => {
  const f = fixture({ 'mem-needle': entry('needle local match'), 'mem-orbit': entry('orbital mechanics') })
  activate([f.libraryId])
  retrieveHook = () => ({ files: [{ name: 'mem-orbit' }], segments: [], resources: [] })
  await memory.privateRecall({ exec: f.exec, query: 'Needle', topK: 8, purpose: 'automatic' })
  const again = await memory.privateRecall({ exec: f.exec, query: '  needle  ', topK: 8, purpose: 'automatic' })
  assert.equal(retrieveCalls(), 1, '规范化后命中同一缓存键')
  assert.equal(again.recallRoute, 'managed-vector-rrf')
})

test('接线：topK 不同不共享缓存（融合截断上限随 topK 变化）', async () => {
  const f = fixture({ 'mem-needle': entry('needle local match'), 'mem-orbit': entry('orbital mechanics') })
  activate([f.libraryId])
  retrieveHook = () => ({ files: [{ name: 'mem-orbit' }], segments: [], resources: [] })
  await memory.privateRecall({ exec: f.exec, query: 'needle', topK: 8, purpose: 'automatic' })
  await memory.privateRecall({ exec: f.exec, query: 'needle', topK: 3, purpose: 'automatic' })
  assert.equal(retrieveCalls(), 2, 'topK 参与键，两种截断各算各的')
})
