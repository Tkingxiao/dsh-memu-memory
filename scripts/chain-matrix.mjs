#!/usr/bin/env node
// 链路矩阵：backend × trigger。证明每条链路都走得通，而不只是各层各自可测。
//
//   node scripts/chain-matrix.mjs [--verbose]
//
//   backend  agent    纯词法（memoryBackend=agent）
//            local    受管本地向量（memoryBackend=api + vectorSource=local）
//            api      远程向量（memoryBackend=api + vectorSource=api）
//   trigger  manual   设置页「整理这次对话」→ RPC generatePrivate → 种子 fork
//            tool     模型自主调用 memu_private_remember
//            idle     空闲整理 sweep（sleepAfterIdleMinutes，默认 3 分钟）
//
// 每个格子断言同一组事实：写入落在父库索引 → 语义查询召回到它 → 注入文本带上同一 id；
// 词法查询也必须命中（融合不吞掉词法腿）；受管路由必须在租约里 commit。
//
// 边界：MemU 引擎（Python/SQLite）被替换成记账桥，因为本机没有引擎安装。所以这里验证的是
// 插件侧直到引擎调用为止的每一段链路；引擎自身的存储/检索由真机验收负责（docs §14）。
// 向量那一路走真实 embedding worker（loopback HTTP、真协议、真维度校验），但适配器是确定性
// 概念编码器——它只证明链路通，不代表任何真实模型的语义质量。质量问题看 recall-bench。

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERBOSE = process.argv.includes('--verbose')

// 宿主包只在 DSH 里存在；和 npm test / acceptance 用同一套 loader stub 重跑一次。
if (!process.env.DSH_MEMU_CHAIN_CHILD) {
  const child = spawnSync(process.execPath, [
    '--import', './tests/loader-register.mjs',
    fileURLToPath(import.meta.url),
    ...process.argv.slice(2),
  ], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, DSH_MEMU_CHAIN_CHILD: '1' } })
  process.exit(typeof child.status === 'number' ? child.status : 1)
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-chain-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

// ------------------------------------------------------------ 引擎边界替身
// memory.js / curator.js / rpc.js 都从 './memu.js' 取 commit/retrieve/forget/listFiles。
// 这里整体换成一个记账桥：调用被记录，retrieve 委托给当前格子的钩子。
const bridge = {
  calls: [],
  retrieveHook: null,
  failRetrieve: false,
  reset() {
    this.calls.length = 0
    this.retrieveHook = null
    this.failRetrieve = false
  },
}
globalThis.__chainMatrixBridge = {
  async commit(args) {
    let leased = null
    try {
      const current = (await import('../lib/vector-profile.js')).activeVectorState()
      leased = Object.keys(current?.writeGuard?.leases || {}).length > 0
    } catch { leased = null }
    bridge.calls.push({ op: 'commit', db: args?.db || null, route: args?.route || null, leased })
    return { ok: true }
  },
  async retrieve(args) {
    bridge.calls.push({ op: 'retrieve', db: args?.db || null, route: args?.route || null })
    if (bridge.failRetrieve) throw new Error('embedding worker unreachable (fixture)')
    if (!bridge.retrieveHook) return { files: [], segments: [], resources: [], raw: null }
    return bridge.retrieveHook(args)
  },
  async forget(args) {
    bridge.calls.push({ op: 'forget', db: args?.db || null })
    return { ok: true }
  },
  async listFiles(args) {
    bridge.calls.push({ op: 'listFiles', db: args?.db || null })
    return { files: [], segments: [], resources: [] }
  },
}
const engineSource = [
  'const b = globalThis.__chainMatrixBridge;',
  'export const commit = (...a) => b.commit(...a);',
  'export const retrieve = (...a) => b.retrieve(...a);',
  'export const forget = (...a) => b.forget(...a);',
  'export const listFiles = (...a) => b.listFiles(...a);',
].join(' ')
const engineUrl = 'data:text/javascript,' + encodeURIComponent(engineSource)
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './memu.js') return { url: engineUrl, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const inject = await import('../lib/inject.js')
const cycle = await import('../lib/cycle.js')
const tools = await import('../lib/tools.js')
const vp = await import('../lib/vector-profile.js')
const { dispatch } = await import('../lib/rpc.js')
const { startEmbeddingWorker } = await import('../lib/local-embedding-worker.js')

// ------------------------------------------------------------ 确定性“语义”编码器
// 概念表只服务于断言：记忆和查询共享概念但**不共享任何字符**，词法腿必然召不回，
// 向量腿必须召回到。这样每个格子都能同时验证“词法仍在工作”和“向量真的接上了”。
const DIMENSION = 16
const CONCEPTS = [
  { at: 0, words: ['黄昏', '斜阳', '夕阳', '日落', '傍晚', 'sunset'] },
  { at: 1, words: ['沙滩', '海岸', '海边', '滩涂', 'beach'] },
  { at: 2, words: ['散步', '慢行', '慢走', 'walk'] },
  { at: 3, words: ['数据库', '迁移', '事务', 'database', 'migration'] },
]
function conceptVector(value) {
  const text = String(value || '')
  const vector = new Array(DIMENSION).fill(0)
  let hit = false
  for (const concept of CONCEPTS) {
    for (const word of concept.words) {
      if (text.includes(word)) { vector[concept.at] += 1; hit = true }
    }
  }
  if (!hit) vector[DIMENSION - 1] = 1
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1
  return vector.map(x => x / norm)
}
const cosine = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0) / ((Math.hypot(...a) * Math.hypot(...b)) || 1)

// 记忆和查询没有共同字符：字符串层面的词法召回一定是空。
const MEMORY_TITLE = '海边的黄昏'
const MEMORY_TEXT = '黄昏时分在沙滩上散步，海风把话吹得很轻。'
const DISTRACTOR_TEXT = '数据库迁移必须保持事务一致性。'
const SEMANTIC_QUERY = '斜阳里慢行'
const LEXICAL_QUERY = '散步'

// ------------------------------------------------------------ 真实 embedding worker
const modelDir = path.join(home, 'fixture-model')
fs.mkdirSync(modelDir, { recursive: true })
const token = crypto.randomBytes(32).toString('hex')
let workerRequests = 0
const worker = await startEmbeddingWorker({
  modelDir,
  manifest: {
    id: 'chain-matrix-fixture',
    model: 'chain-matrix-fixture@fixture',
    status: 'verified',
    verified: true,
    dimension: DIMENSION,
    maxTokens: 512,
    pooling: 'cls',
    normalization: 'l2',
  },
  token,
  adapter: { encode: async (texts) => texts.map(conceptVector) },
  logger: { info() {}, warn() {} },
})
async function embedOverHttp(texts) {
  workerRequests += 1
  const response = await fetch(worker.url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ model: worker.model, input: texts }),
  })
  const payload = await response.json()
  if (!response.ok) throw new Error('worker ' + response.status + ': ' + JSON.stringify(payload).slice(0, 200))
  return payload.data.map(row => row.embedding)
}

// ------------------------------------------------------------ 会话/库/向量代际
let serial = 0
const results = []

function resetCell() {
  fs.rmSync(vp.vectorActiveFile(), { force: true })
  state.updateSettings({
    memoryBackend: 'agent', vectorSource: 'local', relevanceThreshold: 0, privateTopK: 8,
    sleepConsolidation: false, autoCurateEveryHours: 0, autoInject: 'smart',
  })
  state.saveGlobalIndex({ entries: {} })
  bridge.reset()
  workerRequests = 0
}

function activate(libraryIds) {
  const profile = vp.profileFromCatalog('bge-small-zh-v1.5-int8')
  const databases = vp.buildDatabaseSet({ profile, generation: 1, libraryIds })
  fs.mkdirSync(path.join(home, 'libraries'), { recursive: true })
  for (const row of [databases.global, ...Object.values(databases.libraries)]) {
    fs.writeFileSync(vp.resolveVectorPath(row.path), '')
  }
  vp.updateVectorStateSync(current => ({
    ...current, generation: 1, requested: null, pending: null,
    active: { status: 'active', generation: 1, fingerprint: profile.fingerprint, profile, databases },
  }))
}

function seedLibrary({ content = MEMORY_TEXT, title = MEMORY_TITLE } = {}) {
  serial += 1
  const sessionId = 'chain-session-' + serial
  const cwd = path.join(home, 'ws', 'chain-' + serial)
  state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  state.setSessionBinding(sessionId, { useLibrary: true, useGlobal: false })
  const binding = state.getSessionBinding(sessionId)
  const index = state.loadPrivateIndex(binding.libraryId)
  if (content) {
    index.entries['mem-fixture-' + serial] = {
      track: 'memory', layer: 'long_term', status: 'active',
      title, content, domain: 'coding',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    state.savePrivateIndex(binding.libraryId, index)
  }
  return { sessionId, cwd, libraryId: binding.libraryId }
}

function setBackend(backend) {
  state.updateSettings({
    memoryBackend: backend === 'agent' ? 'agent' : 'api',
    vectorSource: backend === 'api' ? 'api' : 'local',
  })
}

function execFor(sessionId, cwd) {
  return { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding' } } } }
}

// ------------------------------------------------------------ 向量召回钩子
function localVectorRetrieve(libraryId) {
  return async ({ query, route }) => {
    assert.equal(route, 'managed-local', 'the local route must not fall back to remote')
    const index = state.loadPrivateIndex(libraryId)
    const entries = Object.entries(index.entries).filter(([, entry]) => entry.status !== 'archived')
    const queryVector = (await embedOverHttp([query]))[0]
    const texts = entries.map(([, entry]) => [entry.title, entry.content].filter(Boolean).join(' '))
    const vectors = texts.length ? await embedOverHttp(texts) : []
    const scored = entries
      .map(([id], i) => ({ id, score: cosine(queryVector, vectors[i]) }))
      .filter(row => row.score >= 0.5)
      .sort((a, b) => b.score - a.score)
    return { files: scored.map(row => ({ name: row.id })), segments: [], resources: [], raw: null }
  }
}

// 远程那一路只验证路由与融合：用同一个概念编码器模拟“远端已经理解了查询”。
function remoteVectorRetrieve(libraryId) {
  return async ({ query, route }) => {
    assert.equal(route, 'remote-api', 'the remote route must be passed explicitly')
    const index = state.loadPrivateIndex(libraryId)
    const queryVector = conceptVector(query)
    const scored = Object.entries(index.entries)
      .filter(([, entry]) => entry.status !== 'archived')
      .map(([id, entry]) => ({ id, score: cosine(queryVector, conceptVector([entry.title, entry.content].join(' '))) }))
      .filter(row => row.score >= 0.5)
      .sort((a, b) => b.score - a.score)
    return { files: scored.map(row => ({ name: row.id })), segments: [], resources: [], raw: null }
  }
}

// ------------------------------------------------------------ 宿主 ctx（fork 宿主）
const TRANSCRIPT = [
  { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我把这段对话里值得记的东西整理成记忆，尤其是海边的那个傍晚。' }] } },
  { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'read', arguments: '{}' }] } } },
]

function makeHost({ sessionId, cwd, onFork }) {
  const handlers = []
  const created = []
  let pending = Promise.resolve()
  const ctx = {
    on(name, handler) {
      if (name !== 'session/event') return () => {}
      handlers.push(handler)
      return () => { const at = handlers.indexOf(handler); if (at >= 0) handlers.splice(at, 1) }
    },
    get(name) {
      if (name === 'sessionQuery') {
        return {
          readSession: async (id) => id === sessionId
            ? { events: TRANSCRIPT, session: { id, cwd, agentPreset: 'coding' } }
            : { events: [] },
        }
      }
      if (name === 'agents') {
        return {
          get: (id) => id === sessionId
            ? { status: 'idle', options: { provider: 'chain-matrix', model: 'fixture' } }
            : undefined,
          create: async (spec) => {
            const childSession = { id: spec.sessionId, header: { id: spec.sessionId, cwd, agentPreset: 'coding' } }
            created.push({ id: spec.sessionId, meta: spec.meta, seed: spec.seed })
            return {
              agent: {
                session: childSession,
                followup(message) {
                  pending = (async () => {
                    try { await onFork({ childId: spec.sessionId, message }) }
                    finally {
                      for (const handler of [...handlers]) {
                        handler(childSession, { type: 'turn/end', seq: 999, data: { turn: 1, reason: { kind: 'completed' } } })
                      }
                    }
                  })()
                },
                whenIdle: () => pending,
              },
              dispose: async () => {},
            }
          },
        }
      }
      return undefined
    },
  }
  return { ctx, created }
}

// ------------------------------------------------------------ 工具面
const registered = []
tools.registerTools({
  tools: { register(tool) { registered.push(tool); return () => {} } },
  logger: { warn() {} },
})
const rememberTool = registered.find(tool => tool.name === 'memu_private_remember')
const recallTool = registered.find(tool => tool.name === 'memu_private_recall')
assert.ok(rememberTool && recallTool, 'the tool surface must register memu_private_remember / memu_private_recall')

let lastToolText = ''
async function writeViaTool(sessionId, cwd, { content, title }) {
  lastToolText = await rememberTool.execute({ content, title }, execFor(sessionId, cwd))
  return lastToolText
}

function markOtherSessionsGone(keepSessionId) {
  for (const binding of state.listSessionBindings()) {
    if (binding.sessionId !== keepSessionId) state.setSessionBinding(binding.sessionId, { sessionGone: true })
  }
}

// ------------------------------------------------------------ 格子
async function runCell({ backend, trigger }) {
  resetCell()
  const seeded = seedLibrary({ content: null })
  const { sessionId, cwd, libraryId } = seeded
  setBackend(backend)
  if (backend !== 'agent') {
    activate([libraryId])
    bridge.retrieveHook = backend === 'local' ? localVectorRetrieve(libraryId) : remoteVectorRetrieve(libraryId)
  }
  const exec = execFor(sessionId, cwd)
  let forked = 0

  if (trigger === 'manual') {
    const host = makeHost({
      sessionId, cwd,
      onFork: async ({ childId }) => {
        forked += 1
        await writeViaTool(childId, cwd, { content: MEMORY_TEXT, title: MEMORY_TITLE })
      },
    })
    const outcome = await dispatch(host.ctx, 'generatePrivate', { sessionId })
    assert.equal(outcome.ok, true, 'manual consolidation refused: ' + JSON.stringify(outcome))
    assert.equal(forked, 1, 'the manual trigger must fork exactly once')
  } else if (trigger === 'tool') {
    await writeViaTool(sessionId, cwd, { content: MEMORY_TEXT, title: MEMORY_TITLE })
  } else {
    state.updateSettings({ sleepConsolidation: true, sleepAfterIdleMinutes: 3 })
    markOtherSessionsGone(sessionId)
    const now = Date.now()
    state.setSessionBinding(sessionId, { lastTurnAt: new Date(now - 2 * 60_000).toISOString() })
    const host = makeHost({
      sessionId, cwd,
      onFork: async ({ childId }) => {
        forked += 1
        await writeViaTool(childId, cwd, { content: MEMORY_TEXT, title: MEMORY_TITLE })
      },
    })
    const early = await cycle.runSleepPass(host.ctx, { now })
    assert.equal(early.ran, 0, 'below the 3-minute idle threshold nothing may run')
    state.setSessionBinding(sessionId, { lastTurnAt: new Date(now - 4 * 60_000).toISOString() })
    const due = await cycle.runSleepPass(host.ctx, { now })
    assert.equal(due.ran, 1, 'above the threshold the sweep must consolidate, got ' + JSON.stringify(due))
    assert.equal(forked, 1, 'the idle trigger must fork exactly once')
  }

  // 1. 写入落在索引里
  const index = state.loadPrivateIndex(libraryId)
  const written = Object.entries(index.entries).find(([, entry]) => String(entry.content || '').includes('黄昏时分'))
  assert.ok(written, 'no memory reached the library index; the tool said: ' + lastToolText)
  const writtenId = written[0]

  // 2. 语义查询：词法一定召不回，向量腿必须召回
  const semantic = await memory.privateRecall({ exec, query: SEMANTIC_QUERY, topK: 8 })
  const semanticIds = (semantic.files || []).map(file => file.name)
  if (backend === 'agent') {
    assert.deepEqual(semanticIds, [], 'the lexical backend must not invent a hit for a zero-overlap query')
    assert.equal(semantic.recallRoute, 'local')
  } else {
    assert.ok(semanticIds.includes(writtenId), 'the vector leg did not return ' + writtenId + ' (route ' + semantic.recallRoute + ')')
    assert.equal(semantic.recallRoute, 'managed-vector-rrf')
    const retrieves = bridge.calls.filter(call => call.op === 'retrieve')
    assert.ok(retrieves.length >= 1, 'the managed recall never reached the engine boundary')
    assert.equal(retrieves[0].route, backend === 'local' ? 'managed-local' : 'remote-api')
    if (backend === 'local') assert.ok(workerRequests > 0, 'the local route never called the embedding worker over HTTP')
    else assert.equal(workerRequests, 0, 'the remote route must not touch the local worker')
  }

  // 3. 词法腿仍然工作：融合不能吞掉字面命中
  const lexical = await memory.privateRecall({ exec, query: LEXICAL_QUERY, topK: 8 })
  assert.ok((lexical.files || []).some(file => file.name === writtenId), 'the lexical leg lost a literal hit under ' + backend)

  // 4. 注入：同一 id 出现在注入结果里
  const injected = await inject.buildRecall(state.getSessionBinding(sessionId), SEMANTIC_QUERY, 1, state.getSettings(), exec, sessionId)
  if (backend === 'agent') {
    assert.deepEqual(injected.ids, [], 'the lexical backend must not inject a semantic-only hit')
  } else {
    assert.ok((injected.ids || []).includes(writtenId), 'injection dropped ' + writtenId + '; errors=' + JSON.stringify(injected.errors))
    assert.ok(injected.text.includes(writtenId), 'the injected text does not name ' + writtenId)
  }

  // 5. 写入路径必须过引擎边界；受管本地必须在租约里 commit
  const commits = bridge.calls.filter(call => call.op === 'commit')
  if (backend === 'agent') {
    assert.equal(commits.length, 0, 'the lexical backend must never call the engine on a write')
    assert.equal(bridge.calls.filter(call => call.op === 'retrieve').length, 0, 'the lexical backend must never call the engine on a recall')
  } else {
    assert.ok(commits.length >= 1, 'the write never reached the engine boundary')
    if (backend === 'local') {
      assert.equal(commits[0].leased, true, 'a managed-local commit must happen under a write lease')
    }
  }

  return {
    detail: 'id=' + writtenId
      + ' route=' + semantic.recallRoute
      + ' workerCalls=' + workerRequests
      + ' commits=' + commits.length
      + ' inject=' + (injected.ids || []).length,
  }
}

// ------------------------------------------------------------ 降级格子
async function runDegradeCell() {
  resetCell()
  const { sessionId, cwd, libraryId } = seedLibrary({})
  setBackend('local')
  activate([libraryId])
  bridge.retrieveHook = localVectorRetrieve(libraryId)
  const exec = execFor(sessionId, cwd)

  await writeViaTool(sessionId, cwd, { content: MEMORY_TEXT, title: MEMORY_TITLE })
  const index = state.loadPrivateIndex(libraryId)
  const writtenId = Object.keys(index.entries)[0]
  assert.ok(writtenId, 'the fixture memory was not written')

  bridge.failRetrieve = true
  const degraded = await memory.privateRecall({ exec, query: LEXICAL_QUERY, topK: 8 })
  assert.equal(degraded.recallRoute, 'local-fallback', 'a dead worker must degrade to lexical, not fail the turn')
  assert.ok((degraded.errors || []).some(message => /semantic recall failed/.test(message)), 'the degradation left no error on the result')
  assert.ok((degraded.files || []).some(file => file.name === writtenId), 'the lexical fallback still has to answer')
  assert.match(String(state.getSessionBinding(sessionId).lastRecallError || ''), /unreachable/i, 'lastRecallError must carry the real reason')

  bridge.failRetrieve = false
  const healthy = await memory.privateRecall({ exec, query: LEXICAL_QUERY, topK: 8 })
  assert.equal(healthy.recallRoute, 'managed-vector-rrf')
  const cleared = state.getSessionBinding(sessionId).lastRecallError
  assert.ok(cleared === undefined || cleared === null, 'a healthy recall must clear lastRecallError, got ' + JSON.stringify(cleared))

  return { detail: 'degraded route=' + degraded.recallRoute + ' recovered=' + healthy.recallRoute }
}

// ------------------------------------------------------------ 跑矩阵
const CELLS = [
  { backend: 'agent', trigger: 'manual' },
  { backend: 'agent', trigger: 'tool' },
  { backend: 'agent', trigger: 'idle' },
  { backend: 'local', trigger: 'manual' },
  { backend: 'local', trigger: 'tool' },
  { backend: 'local', trigger: 'idle' },
  { backend: 'api', trigger: 'manual' },
  { backend: 'api', trigger: 'tool' },
  { backend: 'api', trigger: 'idle' },
]

try {
  for (const cell of CELLS) {
    const id = cell.backend + '/' + cell.trigger
    try {
      const outcome = await runCell(cell)
      results.push({ id, verdict: 'PASS', detail: outcome.detail })
    } catch (error) {
      results.push({ id, verdict: 'FAIL', detail: String(error?.message || error) })
    }
  }
  try {
    const outcome = await runDegradeCell()
    results.push({ id: 'local/degrade', verdict: 'PASS', detail: outcome.detail })
  } catch (error) {
    results.push({ id: 'local/degrade', verdict: 'FAIL', detail: String(error?.message || error) })
  }
} finally {
  try { await worker.close() } catch {}
}

const failed = results.filter(entry => entry.verdict === 'FAIL')
console.log('')
console.log('===== chain matrix =====')
console.log('data root: ' + home)
console.log('')
for (const entry of results) {
  console.log('  [' + entry.verdict + '] ' + entry.id.padEnd(16) + entry.detail)
}
if (VERBOSE || failed.length) {
  console.log('')
  console.log('--- engine boundary calls ---')
  for (const call of bridge.calls) console.log('  ' + JSON.stringify(call))
}
console.log('')
console.log('matrix: ' + (results.length - failed.length) + '/' + results.length + ' chains walked, ' + failed.length + ' failed')
if (failed.length) process.exitCode = 1

try { hooks.deregister() } catch {}
try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
