import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-cross-library-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

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

test('foreign conflict partners and their titles remain inside the domain scope', async () => {
  const libs = world()
  state.updateSettings({ memoryBackend: 'agent', crossLibraryRecall: true })
  seed(libs.other.id, 'mem-coding-left', { title: 'AlphaCert 部署证书', content: 'AlphaCert 部署证书轮换', domain: 'coding', conflicts_with: 'mem-rp-right' })
  seed(libs.other.id, 'mem-rp-right', { title: '不应泄露的异域版本标题', content: '舞台剧中的秘密', domain: 'rp', conflicts_with: 'mem-coding-left' })
  for (const purpose of ['automatic', 'explicit']) {
    const result = await privateRecall({ exec: execFor('cross-current'), query: 'AlphaCert', topK: 1, relevanceThreshold: 0.8, purpose })
    assert.deepEqual(result.files.map(file => file.name), ['mem-coding-left'])
    assert.equal(result.files[0].libraryId, libs.other.id)
    assert.equal(result.files[0].conflictComplete, false)
    const pointer = result.files[0].related.find(item => item.kind === 'conflict')
    assert.equal(pointer?.available, false)
    assert.notEqual(pointer?.title, '不应泄露的异域版本标题')
  }
})

test('conflict partners in the primary library retain the unfiltered domain contract', async () => {
  const libs = world()
  state.updateSettings({ memoryBackend: 'agent', crossLibraryRecall: true })
  seed(libs.current.id, 'mem-primary-left', { title: 'LocalCert 部署证书', content: 'LocalCert 部署证书轮换', domain: 'rp', conflicts_with: 'mem-primary-right' })
  seed(libs.current.id, 'mem-primary-right', { title: '本库另一版本', content: '本库相冲突的不同记忆', domain: 'rp', conflicts_with: 'mem-primary-left' })
  const result = await privateRecall({ exec: execFor('cross-current'), query: 'LocalCert', topK: 1, relevanceThreshold: 0.8, purpose: 'automatic' })
  assert.deepEqual(new Set(result.files.map(file => file.name)), new Set(['mem-primary-left', 'mem-primary-right']))
  assert.ok(result.files.every(file => file.libraryId === libs.current.id && file.conflictComplete))
})

// ---------------------------------------------------------------- R4 反例

test('R4: the same id in two libraries stays two facts with owning-library conflict pairing', async () => {
  const libs = world()
  state.updateSettings({ memoryBackend: 'agent', crossLibraryRecall: true })
  seed(libs.current.id, 'mem-twin', { title: '本库同名条目', content: 'alpha 集群的扩容记录与负责人安排', conflicts_with: 'mem-twin-partner' })
  seed(libs.current.id, 'mem-twin-partner', { title: '本库配对版本', content: 'alpha 集群扩容的另一版记录' })
  seed(libs.other.id, 'mem-twin', { title: '外库同名条目', content: 'beta 服务的回滚步骤与值班表' })
  const result = await privateRecall({ exec: execFor('cross-current'), query: '同名条目', topK: 2, relevanceThreshold: 0 })
  const twins = result.files.filter(file => file.name === 'mem-twin')
  assert.equal(twins.length, 2, '同 id 不同库是两条事实，不能被裸 id 折叠或 MMR 文本缓存误杀')
  assert.deepEqual(new Set(twins.map(file => file.libraryId)), new Set([libs.current.id, libs.other.id]))
  const local = twins.find(file => file.libraryId === libs.current.id)
  const foreign = twins.find(file => file.libraryId === libs.other.id)
  assert.ok(local.content.includes('alpha'), '本库正文不被外库覆盖')
  assert.ok(foreign.content.includes('beta'), '外库正文不被本库覆盖')
  assert.equal(local.conflictPair, 'mem-twin-partner', '冲突配对落在 owning library')
  assert.equal(foreign.conflictPair, undefined, '外库同 id 不继承本库的冲突关系')
})

test('R4: exact-id recall keeps both libraries documents, primary first', async () => {
  const libs = world()
  state.updateSettings({ memoryBackend: 'agent', crossLibraryRecall: true })
  seed(libs.current.id, 'mem-twin', { title: '本库同名条目', content: 'alpha 集群的扩容记录与负责人安排' })
  seed(libs.other.id, 'mem-twin', { title: '外库同名条目', content: 'beta 服务的回滚步骤与值班表' })
  const result = await privateRecall({ exec: execFor('cross-current'), query: 'mem-twin', topK: 5, relevanceThreshold: 0 })
  assert.deepEqual(result.files.map(file => file.libraryId), [libs.current.id, libs.other.id])
  assert.ok(result.files.every(file => file.name === 'mem-twin'))
})

test('R4: a strong local lexical hit outranks a weak foreign first place and the weak hit is cut', async () => {
  const libs = world()
  state.updateSettings({ memoryBackend: 'agent', crossLibraryRecall: true })
  seed(libs.current.id, 'mem-strong-local', { title: '量子计算部署约定', content: '量子计算部署约定，量子计算部署流程，量子计算部署检查清单' })
  seed(libs.other.id, 'mem-weak-foreign', { title: '部署工具清单', content: '部署工具清单' })
  const open = await privateRecall({ exec: execFor('cross-current'), query: '量子计算部署', topK: 10, relevanceThreshold: 0 })
  assert.equal(open.fusion?.crossLibraryLexical, 'unified-bm25', '跨库词法腿使用统一授权语料')
  const strong = open.files.find(file => file.name === 'mem-strong-local')
  const weak = open.files.find(file => file.name === 'mem-weak-foreign')
  assert.ok(strong && weak, '阈值 0 时两条都在候选里')
  assert.ok(strong.retrievalScore > weak.retrievalScore, '统一 BM25 分数可比：强本库命中高于弱外库首名')
  assert.equal(open.files[0].name, 'mem-strong-local')
  const cut = await privateRecall({ exec: execFor('cross-current'), query: '量子计算部署', topK: 10, relevanceThreshold: 0.8 })
  assert.deepEqual(cut.files.map(file => file.name), ['mem-strong-local'], '弱外库命中被相关度阈值拒绝，不因库内第一名身份保留')
})

test('R4: never_say and out-of-context foreign entries never enter automatic cross-library recall', async () => {
  const libs = world()
  state.updateSettings({ memoryBackend: 'agent', crossLibraryRecall: true })
  seed(libs.other.id, 'mem-never', { title: '隐蔽条目测试的不可说版本', content: '隐蔽条目测试 never', disclosure: 'never_say' })
  seed(libs.other.id, 'mem-context', { title: '隐蔽条目测试的频道版本', content: '隐蔽条目测试 context', context: { channelId: 'secret-channel' } })
  const automatic = await privateRecall({ exec: execFor('cross-current'), query: '隐蔽条目测试', topK: 10, relevanceThreshold: 0, purpose: 'automatic' })
  assert.ok(!automatic.files.some(file => ['mem-never', 'mem-context'].includes(file.name)), '自动召回不泄露 never_say 与异上下文条目')
  const explicit = await privateRecall({ exec: execFor('cross-current'), query: '隐蔽条目测试', topK: 10, relevanceThreshold: 0 })
  assert.ok(explicit.files.some(file => file.name === 'mem-never'), '显式召回仍可读 never_say')
  assert.ok(!explicit.files.some(file => file.name === 'mem-context'), '异上下文条目对显式召回也不可见')
})

test('R4: empty cross-library query stays a bounded recency page with finite scores', async () => {
  world()
  state.updateSettings({ memoryBackend: 'agent', crossLibraryRecall: true })
  const result = await privateRecall({ exec: execFor('cross-current'), query: '', topK: 5, relevanceThreshold: 0 })
  assert.equal(result.fusion?.crossLibraryLexical, 'recency')
  assert.ok(result.files.length > 0)
  assert.ok(result.files.every(file => Number.isFinite(file.score) && file.libraryId), '空查询不产生 NaN 分数，来源库不丢')
})

test('R4: semantic hits without raw scores keep an explicit rank-only limitation', async () => {
  const libs = world()
  state.updateSettings({ memoryBackend: 'api', vectorSource: 'api', crossLibraryRecall: true })
  seed(libs.current.id, 'mem-hybrid-local', { title: '混合召回本地条', content: 'hybrid local body' })
  seed(libs.other.id, 'mem-hybrid-foreign', { title: '混合召回外库条', content: 'hybrid foreign body' })
  const retrieveImpl = async ({ db }) => ({
    files: [{ name: String(db).includes(libs.current.id) ? 'mem-hybrid-local' : 'mem-hybrid-foreign' }],
    segments: [], resources: [],
  })
  const result = await privateRecall({ exec: execFor('cross-current'), query: 'zzzqqq wwwvvv', topK: 10, relevanceThreshold: 0, retrieveImpl })
  assert.equal(result.fusion?.crossLibrarySemantic, 'rank-only', '缺原始分数时不伪造跨库可比性')
  assert.deepEqual(new Set(result.files.map(file => file.name)), new Set(['mem-hybrid-local', 'mem-hybrid-foreign']))
  assert.ok(result.files.every(file => file.libraryId))
})

test('R4: a score missing on one library demotes the whole semantic leg to rank-only', async () => {
  const libs = world()
  state.updateSettings({ memoryBackend: 'api', vectorSource: 'api', crossLibraryRecall: true })
  seed(libs.current.id, 'mem-hybrid-local', { title: '混合召回本地条', content: 'hybrid local body' })
  seed(libs.other.id, 'mem-hybrid-foreign', { title: '混合召回外库条', content: 'hybrid foreign body' })
  const retrieveImpl = async ({ db }) => ({
    files: String(db).includes(libs.current.id)
      ? [{ name: 'mem-hybrid-local', score: 0.9 }]
      : [{ name: 'mem-hybrid-foreign' }],
    segments: [], resources: [],
  })
  const result = await privateRecall({ exec: execFor('cross-current'), query: 'zzzqqq xxxvvv', topK: 10, relevanceThreshold: 0, retrieveImpl })
  assert.equal(result.fusion?.crossLibrarySemantic, 'rank-only', '部分库缺分数时整体退回 rank-only')
})

test('R4: comparable raw semantic scores rank across libraries by score, not by library seat', async () => {
  const libs = world()
  state.updateSettings({ memoryBackend: 'api', vectorSource: 'api', crossLibraryRecall: true })
  seed(libs.current.id, 'mem-hybrid-local', { title: '混合召回本地条', content: 'hybrid local body' })
  seed(libs.other.id, 'mem-hybrid-foreign', { title: '混合召回外库条', content: 'hybrid foreign body' })
  const retrieveImpl = async ({ db }) => ({
    files: String(db).includes(libs.current.id)
      ? [{ name: 'mem-hybrid-local', score: 0.4 }]
      : [{ name: 'mem-hybrid-foreign', score: 0.9 }],
    segments: [], resources: [],
  })
  const result = await privateRecall({ exec: execFor('cross-current'), query: 'zzzqqq yyyvvv', topK: 10, relevanceThreshold: 0, retrieveImpl })
  assert.equal(result.fusion?.crossLibrarySemantic, 'score')
  assert.equal(result.files[0].name, 'mem-hybrid-foreign', '同代际原始相似度可比：高分外库命中排在低分本库命中之前')
  assert.equal(result.files[0].libraryId, libs.other.id)
})

test('R4: a scope change during cross-library recall rejects the stale result', async () => {
  const libs = world()
  state.updateSettings({ memoryBackend: 'api', vectorSource: 'api', crossLibraryRecall: true })
  seed(libs.current.id, 'mem-hybrid-local', { title: '混合召回本地条', content: 'hybrid local body' })
  const retrieveImpl = async () => {
    state.setSessionBinding('cross-current', { domainOverride: 'rp' })
    return { files: [], segments: [], resources: [] }
  }
  await assert.rejects(
    privateRecall({ exec: execFor('cross-current'), query: 'zzzqqq zzzvvv', topK: 5, relevanceThreshold: 0, retrieveImpl }),
    /scope changed/,
  )
  state.setSessionBinding('cross-current', { domainOverride: 'coding' })
})
