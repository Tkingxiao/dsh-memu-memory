// 词典读取作用域（§8.15 的词典半边）：全局词典 + 同域跨库。
//
// 记忆侧的 crossLibraryRecall 管 privateRecall/privateList；本文件管词典的另一条链——
// 锚点摘要（buildLexiconAnchor）、B 通道匹配（injectLexiconTurn/commitLexiconTurn）、
// 模型检索（memu_lexicon_search）与词典 RPC 的全局存储。断言的是「看得见哪些词条」
// 与「计数落在哪本词典」，不锁内部实现。
//
// 末尾两条是「读失败」用例：它们会把文件写成坏 JSON，词典核心在读失败后拒绝写入，
// 所以必须留在最后，且只碰自己新建的库。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-lexicon-scope-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const lexicon = await import('../lib/lexicon.js')
const scope = await import('../lib/lexicon-scope.js')
const inject = await import('../lib/inject.js')
const { registerTools } = await import('../lib/tools.js')
const { dispatch } = await import('../lib/rpc.js')
const backup = await import('../lib/backup.js')
const { dataDir } = await import('../lib/paths.js')

test.after(() => {
  state.flushState()
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

const GLOBAL_ID = lexicon.GLOBAL_LEXICON_ID
const lexiconFile = (libraryId) => path.join(dataDir(), 'lexicon', `${libraryId}.json`)
const readStore = (libraryId) => JSON.parse(fs.readFileSync(lexiconFile(libraryId), 'utf8'))
const entryOf = (libraryId, term) => Object.entries(readStore(libraryId).terms || {})
  .find(([, e]) => e.term === term)?.[1] || null
const countsOf = (libraryId, term) => entryOf(libraryId, term)?.hitCounts || { candidate: 0, injection: 0, query: 0 }

const dir = (name) => path.join(home, name)
function bind(sessionId, folder, libraryId, domain) {
  state.ensureSession(sessionId, { cwd: folder, libraryId })
  state.setSessionBinding(sessionId, { domainOverride: domain })
  return state.getSessionBinding(sessionId)
}

function addTerm(libraryId, term, extra = {}) {
  return lexicon.upsertLexiconTerm({
    libraryId, term, kind: 'term', meaning: `${term} 的释义`, context: {}, source: 'user', ...extra,
  }).term
}

function toolByName(name) {
  const tools = []
  registerTools({ tools: { register(tool) { tools.push(tool) } }, logger: { warn() {} } })
  return tools.find((tool) => tool.name === name)
}

// 四本库：当前库、同域其它库、异域库、关掉私有记忆的文件夹；外加全局词典。
function world() {
  const current = state.ensureLibraryForCwd(dir('lex-current'))
  const other = state.ensureLibraryForCwd(dir('lex-other'))
  const rp = state.ensureLibraryForCwd(dir('lex-rp'))
  const off = state.ensureLibraryForCwd(dir('lex-off'))
  bind('lex-current', dir('lex-current'), current.id, 'coding')
  bind('lex-other', dir('lex-other'), other.id, 'coding')
  bind('lex-rp', dir('lex-rp'), rp.id, 'rp')
  bind('lex-off', dir('lex-off'), off.id, 'coding')
  state.setWorkspacePolicy(dir('lex-off'), { useLibrary: false })
  addTerm(current.id, '当前词')
  addTerm(other.id, '同域词')
  addTerm(rp.id, '异域词')
  addTerm(off.id, '关库词')
  addTerm(GLOBAL_ID, '全局词')
  return { current, other, rp, off }
}

const bindingOf = (sessionId) => state.getSessionBinding(sessionId)

test('lexiconSources: 默认是当前库 + 全局词典，开关打开才并入同域其它库', () => {
  const libs = world()
  const binding = bindingOf('lex-current')
  state.updateSettings({ crossLibraryRecall: false })
  assert.deepEqual(scope.lexiconSources(binding).map((s) => [s.libraryId, s.primary, s.scope]), [
    [libs.current.id, true, 'private'],
    [GLOBAL_ID, false, 'global'],
  ])
  state.updateSettings({ crossLibraryRecall: true })
  const ids = scope.lexiconSources(binding).map((s) => s.libraryId)
  assert.ok(ids.includes(libs.other.id), '同域库应进入候选')
  assert.ok(!ids.includes(libs.rp.id), '异域库不该进入候选')
  assert.ok(!ids.includes(libs.off.id), '文件夹关掉私有记忆的库不该进入候选')
  assert.equal(scope.lexiconSources(binding).at(-1).libraryId, GLOBAL_ID, '全局词典排在私有库之后（私有优先、全局补充）')
})

test('lexiconSources: 全局词典受 useGlobal 天花板约束，私有记忆关掉时只剩全局', () => {
  const libs = world()
  state.updateSettings({ crossLibraryRecall: false })
  state.setSessionBinding('lex-current', { useGlobal: false })
  assert.deepEqual(scope.lexiconSources(bindingOf('lex-current')).map((s) => s.libraryId), [libs.current.id])
  state.setSessionBinding('lex-current', { useGlobal: true, useLibrary: false })
  assert.deepEqual(scope.lexiconSources(bindingOf('lex-current')).map((s) => s.libraryId), [GLOBAL_ID])
  assert.equal(scope.lexiconScopeAllowed(bindingOf('lex-current')), true)
  state.setSessionBinding('lex-current', { useLibrary: true, useGlobal: true })
})

test('锚点摘要读得到全局词典，即使没开跨库开关', () => {
  world()
  state.updateSettings({ crossLibraryRecall: false })
  const text = inject.buildLexiconAnchor(bindingOf('lex-current'), 'lex-anchor-off', 300).text
  assert.match(text, /全局词/)
  assert.match(text, /当前词/)
  assert.doesNotMatch(text, /同域词/)
})

test('锚点摘要在开关打开后并入同域库，异域库与异域文件夹的词仍不进', () => {
  world()
  state.updateSettings({ crossLibraryRecall: true })
  const text = inject.buildLexiconAnchor(bindingOf('lex-current'), 'lex-anchor-on', 300).text
  assert.match(text, /同域词/)
  assert.doesNotMatch(text, /关库词/)
})

test('跨库词条按自己的 domain 戳过滤，没有戳的旧词条随库放行', () => {
  const libs = world()
  // 同域库里再放一条明确写着 rp 的词：库资格过了，条目级 domain 必须拦住它。
  addTerm(libs.other.id, '伪装词', { domain: 'rp' })
  state.updateSettings({ crossLibraryRecall: true })
  const text = inject.buildLexiconAnchor(bindingOf('lex-current'), 'lex-entry-domain', 300).text
  assert.match(text, /同域词/)
  assert.doesNotMatch(text, /伪装词/)
})

test('全局词条按 appliesToDomain 过滤：universal 恒可见，异领域隐藏', () => {
  world()
  const binding = bindingOf('lex-current')
  addTerm(GLOBAL_ID, '通用词', { domain: 'universal' })
  addTerm(GLOBAL_ID, '剧情词', { domain: 'rp' })
  const text = inject.buildLexiconAnchor(binding, 'lex-global-domain', 300).text
  assert.match(text, /通用词/)
  assert.doesNotMatch(text, /剧情词/)
})

test('B 通道命中全局词条，计数落在词条所属的词典而不是当前库', () => {
  const libs = world()
  state.updateSettings({ crossLibraryRecall: false })
  const binding = bindingOf('lex-current')
  lexicon.lexiconCooldownStore.clear()
  const turn = inject.injectLexiconTurn({ binding, sessionId: 'lex-accounting', userTexts: ['刚看到全局词'], tokenBudget: 800 })
  assert.match(turn.text, /全局词/)
  inject.commitLexiconTurn({ libraryId: libs.current.id, sessionId: 'lex-accounting', hits: turn.hits, selected: turn.selected })
  assert.equal(countsOf(GLOBAL_ID, '全局词').injection, 1)
  assert.equal(countsOf(GLOBAL_ID, '全局词').candidate, 1)
  assert.equal(countsOf(libs.current.id, '当前词').injection, 0)
})

test('B 通道在开关打开后命中同域库词条，candidate 记到那本库', () => {
  const libs = world()
  state.updateSettings({ crossLibraryRecall: true })
  const binding = bindingOf('lex-current')
  lexicon.lexiconCooldownStore.clear()
  const turn = inject.injectLexiconTurn({ binding, sessionId: 'lex-cross-turn', userTexts: ['同域词出现了'], tokenBudget: 800 })
  assert.match(turn.text, /同域词/)
  inject.commitLexiconTurn({ libraryId: libs.current.id, sessionId: 'lex-cross-turn', hits: turn.hits, selected: [] })
  assert.equal(countsOf(libs.other.id, '同域词').candidate, 1)
  assert.equal(countsOf(libs.current.id, '当前词').candidate, 0)
})

test('同词面去重：私有库那份压过全局词典那份，一行不重复', () => {
  const libs = world()
  addTerm(libs.current.id, '全局词', { meaning: '私有库的解释优先' })
  const text = inject.buildLexiconAnchor(bindingOf('lex-current'), 'lex-dedupe', 300).text
  assert.equal(text.split('「全局词」').length - 1, 1, '同一个词面只该出现一行')
  assert.match(text, /私有库的解释优先/)
})

test('memu_lexicon_search 跨全局与同域库，并把外来命中报成只读', async () => {
  const libs = world()
  state.updateSettings({ crossLibraryRecall: true })
  addTerm(GLOBAL_ID, '检索专用全局词', { meaning: '只给检索用例用' })
  addTerm(libs.other.id, '检索专用同域词', { meaning: '只给检索用例用' })
  const search = toolByName('memu_lexicon_search')
  const exec = { agent: { session: { header: { id: 'lex-current' } } } }
  const globalHit = await search.execute({ query: '检索专用全局词' }, exec)
  assert.match(globalHit, /home=全局词典/)
  assert.match(globalHit, /只读/)
  const crossHit = await search.execute({ query: '检索专用同域词' }, exec)
  assert.match(crossHit, new RegExp(`home=${libs.other.name}`))
  const foreignDomain = await search.execute({ query: '异域词' }, exec)
  assert.match(foreignDomain, /没有命中/)
})

test('memu_lexicon_propose 给私有词条打上当前领域戳', async () => {
  const libs = world()
  const propose = toolByName('memu_lexicon_propose')
  const exec = { agent: { session: { header: { id: 'lex-current' } } } }
  await propose.execute({ term: '新戳词', kind: 'term', meaning: '带领域戳', evidence: [{ quote: '新戳词' }] }, exec)
  assert.equal(entryOf(libs.current.id, '新戳词').domain, 'coding')
})

test('词典 RPC 把全局词典当一本可读可管的词典，且不给它打领域戳', async () => {
  const libs = world()
  const list = await dispatch({}, 'lexiconList', { libraryId: GLOBAL_ID })
  assert.equal(list.scope, 'global')
  assert.ok(list.items.some((item) => item.term === '全局词'))
  const added = await dispatch({}, 'lexiconAdd', { libraryId: GLOBAL_ID, sessionId: 'lex-current', term: '手写全局词', kind: 'term', meaning: '用户手写' })
  assert.equal(added.term.status, 'active')
  assert.equal(added.term.domain, undefined, '全局词条不继承写入时的领域')
  // 会话视角的检索跨到全局词典；显式选库的检索仍只看那一本。
  // 归档放在这两步之后：archived 词条按 §2.1 永不出现在检索里。
  const sessionSearch = await dispatch({}, 'lexiconSearch', { sessionId: 'lex-current', q: '手写全局词' })
  assert.ok(sessionSearch.items.some((item) => item.term === '手写全局词' && item.lexiconScope === 'global'))
  // 显式选库不跨库：全局词典里那条只在会话视角出现。当前库的「全局词」会因为
  // 词面包含关系被查到（searchLexicon 的 contains 层），这不代表跨库。
  const librarySearch = await dispatch({}, 'lexiconSearch', { libraryId: libs.current.id, sessionId: 'lex-current', q: '手写全局词' })
  assert.ok(librarySearch.items.every((item) => item.lexiconScope === undefined), '显式选库不该带来源标记')
  assert.ok(!librarySearch.items.some((item) => item.term === '手写全局词'))
  const archived = await dispatch({}, 'lexiconArchive', { libraryId: GLOBAL_ID, termId: added.term.termId })
  assert.equal(archived.term.status, 'archived')
  const afterArchive = await dispatch({}, 'lexiconSearch', { sessionId: 'lex-current', q: '手写全局词' })
  assert.ok(!afterArchive.items.some((item) => item.term === '手写全局词'), 'archived 词条不进检索')
})

test('lexiconAdd 带会话时给私有词条打领域戳', async () => {
  const libs = world()
  const added = await dispatch({}, 'lexiconAdd', {
    libraryId: libs.current.id, sessionId: 'lex-current', term: '面板词', kind: 'term', meaning: '从面板写入',
  })
  assert.equal(added.term.domain, 'coding')
  assert.equal(entryOf(libs.current.id, '面板词').domain, 'coding')
})

test('全局词典与私有词典同权进自动备份清单', async () => {
  world()
  const created = await backup.createBackup({ label: 'lexicon-scope-global' })
  const manifest = JSON.parse(fs.readFileSync(path.join(created.dir, 'manifest.json'), 'utf8'))
  assert.ok(manifest.files[`lexicon/${GLOBAL_ID}.json`], 'global.json 是词典数据，必须在备份里')
})

test('坏掉的辅源词典只降级并留信号，当前库照常注入', () => {
  const libs = world()
  state.updateSettings({ crossLibraryRecall: true })
  fs.writeFileSync(lexiconFile(libs.other.id), '{ not a lexicon', 'utf8')
  const anchor = inject.buildLexiconAnchor(bindingOf('lex-current'), 'lex-broken-secondary', 300)
  assert.match(anchor.text, /当前词/, '主源照常参与')
  assert.equal(anchor.errors.length, 1)
  assert.match(anchor.errors[0], new RegExp(libs.other.id))
})

test('主源（当前绑定库）读失败继续抛错，由调用方按 fail-open 留可观测信号', () => {
  const solo = state.ensureLibraryForCwd(dir('lex-solo'))
  bind('lex-solo', dir('lex-solo'), solo.id, 'coding')
  addTerm(solo.id, '独库词')
  fs.writeFileSync(lexiconFile(solo.id), '{ broken', 'utf8')
  assert.throws(() => scope.lexiconVisibleTerms(bindingOf('lex-solo')), /LEXICON_CORRUPT|could not be read/)
})
