// 词典管理面（RPC / 模型工具 / 备份导出 / 卡片流 UI）的接口与界面层测试。
//
// 当前版本起公开生命周期只有 active / archived：pending 是 legacy 数据、rejected 是内部
// 墓碑，二者都不出现在列表、页签计数与检索里；模型写入直接生效，人工只做编辑 /
// 归档 / 恢复 / 删除。本文件的断言只针对这一层自身的行为（授权、形状、映射、
// allowlist、导入冲突语义），不锁定核心内部实现。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-lexicon-ui-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const { dispatch } = await import('../lib/rpc.js')
const { registerTools } = await import('../lib/tools.js')
const backup = await import('../lib/backup.js')
const { dataDir, writeJson } = await import('../lib/paths.js')

test.after(() => {
  try { state.flushState() } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

const lib = state.createLibrary({ name: 'lexicon-main', cwd: path.join(home, 'lexicon-main') })
const readLexiconFile = (libraryId) => JSON.parse(fs.readFileSync(path.join(dataDir(), 'lexicon', `${libraryId}.json`), 'utf8'))
const writeLexiconFile = (libraryId, store) => writeJson(path.join(dataDir(), 'lexicon', `${libraryId}.json`), store)
const termIdOf = (libraryId, term) => Object.entries(readLexiconFile(libraryId).terms).find(([, e]) => e.term === term)?.[0] || null
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeToolCtx() {
  const tools = []
  const ctx = {
    tools: { register(tool) { tools.push(tool); return () => {} } },
    logger: { warn() {} },
  }
  const dispose = registerTools(ctx)
  return { tools, dispose }
}

const toolsExec = (sessionId) => ({ agent: { session: { header: { id: sessionId, cwd: path.join(home, 'lexicon-main'), agentPreset: 'rp' } } } })

// 直接写盘模拟 legacy / 墓碑数据：条目形状只保留列表与索引读取需要的字段。
function legacyEntry(term, status, extra = {}) {
  const stamp = '2026-01-01T00:00:00.000Z'
  return {
    term,
    normalizedTerm: term,
    kind: 'term',
    meaning: `legacy ${status}`,
    usage: '',
    aliases: [],
    normalizedAliases: [],
    examples: [],
    context: {},
    visibility: 'shared',
    sensitivity: 'normal',
    confidence: 0.8,
    evidence: [],
    status,
    source: 'model-proposal',
    createdAt: stamp,
    updatedAt: stamp,
    hitCounts: { candidate: 0, injection: 0, query: 0 },
    strength: 0.6,
    ...extra,
  }
}

test('lexiconList defaults to active; archived tab, stable statusCounts, includeArchived and pagination follow the RPC', async () => {
  await assert.rejects(() => dispatch({}, 'lexiconList', { libraryId: 'lib-nope' }), /library not found/)
  await dispatch({}, 'lexiconAdd', { libraryId: lib.id, term: '糖刀', kind: 'meme', meaning: '表面发糖、实际虐心的剧情' })
  await sleep(12)
  await dispatch({}, 'lexiconAdd', { libraryId: lib.id, term: '红牌', kind: 'trigger', sensitivity: 'sensitive', meaning: '角色行为的红线信号' })
  await sleep(12)
  await dispatch({}, 'lexiconAdd', { libraryId: lib.id, term: '咖啡上头', kind: 'slang', meaning: '连喝三杯后的亢奋状态' })
  const view = await dispatch({}, 'lexiconList', { libraryId: lib.id })
  assert.equal(view.libraryId, lib.id)
  assert.equal(view.page, 1)
  assert.equal(view.pages, 1)
  assert.equal(view.total, 3)
  assert.deepEqual(view.counts, { slang: 1, meme: 1, trigger: 1, term: 0 })
  assert.deepEqual(view.statusCounts, { active: 3, archived: 0 }, 'the default tab is active only')
  // 分页排序 updatedAt desc：最后写入的排最前。
  assert.deepEqual(view.items.map((row) => row.term), ['咖啡上头', '红牌', '糖刀'])
  assert.ok(view.items.every((row) => row.status === 'active'))
  // 只投影会话可见字段：核心内部的规范化表/指纹不上 RPC。
  for (const row of view.items) {
    assert.equal(Object.hasOwn(row, 'normalizedTerm'), false)
    assert.equal(Object.hasOwn(row, 'normalizedAliases'), false)
    assert.equal(Object.hasOwn(row, 'fingerprint'), false)
    assert.ok(row.id && row.term && row.kind)
  }
  const sensitive = await dispatch({}, 'lexiconList', { libraryId: lib.id, sensitivity: 'sensitive' })
  assert.deepEqual(sensitive.items.map((row) => row.term), ['红牌'])
  const slang = await dispatch({}, 'lexiconList', { libraryId: lib.id, kind: 'slang' })
  assert.deepEqual(slang.items.map((row) => row.term), ['咖啡上头'])
  assert.deepEqual(slang.counts, { slang: 1, meme: 1, trigger: 1, term: 0 }, 'kind 计数跟随 kind 以外的过滤')
  assert.deepEqual(slang.statusCounts, { active: 3, archived: 0 }, 'page-tab counts do not move with kind/search filters')
  const byQuery = await dispatch({}, 'lexiconList', { libraryId: lib.id, q: '红线' })
  assert.deepEqual(byQuery.items.map((row) => row.term), ['红牌'])
  assert.deepEqual(byQuery.statusCounts, { active: 3, archived: 0 })

  // 分页：每页 2 条，第 2 页拿走剩余 1 条；越界页与超大 pageSize 被 clamp。
  const paged = await dispatch({}, 'lexiconList', { libraryId: lib.id, pageSize: 2, page: 1 })
  assert.equal(paged.pages, 2)
  assert.equal(paged.total, 3)
  assert.deepEqual(paged.items.map((row) => row.term), ['咖啡上头', '红牌'])
  const page2 = await dispatch({}, 'lexiconList', { libraryId: lib.id, pageSize: 2, page: 2 })
  assert.deepEqual(page2.items.map((row) => row.term), ['糖刀'])
  const clamped = await dispatch({}, 'lexiconList', { libraryId: lib.id, pageSize: 9999, page: 99 })
  assert.equal(clamped.page, 1)
  assert.ok(clamped.pageSize <= 200)

  // 归档：离开 active 页签，但仍在归档页签 / includeArchived 里可恢复。
  const knifeId = view.items.find((row) => row.term === '糖刀').id
  const archived = await dispatch({}, 'lexiconArchive', { libraryId: lib.id, termId: knifeId })
  assert.equal(archived.action, 'archive')
  assert.equal(archived.term.status, 'archived')
  const afterArchive = await dispatch({}, 'lexiconList', { libraryId: lib.id })
  assert.equal(afterArchive.total, 2)
  assert.deepEqual(afterArchive.statusCounts, { active: 2, archived: 1 })
  assert.ok(!afterArchive.items.some((row) => row.id === knifeId))
  const archivedTab = await dispatch({}, 'lexiconList', { libraryId: lib.id, status: 'archived' })
  assert.deepEqual(archivedTab.items.map((row) => row.term), ['糖刀'])
  assert.deepEqual(archivedTab.statusCounts, { active: 2, archived: 1 })
  const both = await dispatch({}, 'lexiconList', { libraryId: lib.id, includeArchived: true })
  assert.equal(both.total, 3)
  const explicitWins = await dispatch({}, 'lexiconList', { libraryId: lib.id, includeArchived: true, status: 'active' })
  assert.deepEqual(explicitWins.items.map((row) => row.term), afterArchive.items.map((row) => row.term), 'an explicit status outranks includeArchived')
  // 归档词条默认搜不到；只有管理面显式 includeArchived 才返回。
  assert.equal((await dispatch({}, 'lexiconSearch', { libraryId: lib.id, q: '糖刀' })).items.length, 0)
  const archivedSearch = await dispatch({}, 'lexiconSearch', { libraryId: lib.id, q: '糖刀', includeArchived: true })
  assert.equal(archivedSearch.items.length, 1)
  assert.equal(archivedSearch.items[0].status, 'archived')
  assert.equal((await dispatch({}, 'lexiconSearch', { libraryId: lib.id, q: '糖刀', includePending: true })).items.length, 0, 'includePending is gone')
  // 恢复：重新回到 active 页签并重新可搜。
  const restored = await dispatch({}, 'lexiconRestore', { libraryId: lib.id, termId: knifeId })
  assert.equal(restored.action, 'restore')
  assert.equal(restored.term.status, 'active')
  assert.equal((await dispatch({}, 'lexiconList', { libraryId: lib.id })).total, 3)
  assert.equal((await dispatch({}, 'lexiconList', { libraryId: lib.id, status: 'archived' })).total, 0)
  assert.equal((await dispatch({}, 'lexiconSearch', { libraryId: lib.id, q: '糖刀' })).items.length, 1)

  // 生命周期只认两态；pending/rejected/deleted 不是可筛选的状态。
  for (const status of ['pending', 'rejected', 'deleted']) {
    await assert.rejects(() => dispatch({}, 'lexiconList', { libraryId: lib.id, status }), /unknown lexicon status/)
  }
  await assert.rejects(() => dispatch({}, 'lexiconRestore', { libraryId: lib.id, termId: knifeId }), /only archived terms can be restored/)
  await assert.rejects(() => dispatch({}, 'lexiconArchive', { libraryId: lib.id, termId: 'lex-nope' }), /does not exist/)
  await assert.rejects(() => dispatch({}, 'lexiconArchive', { libraryId: lib.id }), /termId is required/)
  await assert.rejects(() => dispatch({}, 'lexiconRestore', { libraryId: lib.id }), /termId is required/)
  // 旧审核方法彻底消失：lexiconReview 不再是 dispatch 的入口。
  await assert.rejects(() => dispatch({}, 'lexiconReview', { libraryId: lib.id, termId: knifeId, action: 'approve' }), /unknown endpoint/)
})

test('pending and rejected rows are internal only: never listed, counted or searchable', async () => {
  const store = readLexiconFile(lib.id)
  store.terms['lex-legacy-pending-qa'] = legacyEntry('老待审', 'pending')
  store.terms['lex-tombstone-qa'] = legacyEntry('墓碑词', 'rejected', { fingerprint: 'deadbeef' })
  writeLexiconFile(lib.id, store)

  const active = await dispatch({}, 'lexiconList', { libraryId: lib.id })
  assert.equal(active.total, 3, 'legacy pending and rejected tombstones are not listed')
  assert.deepEqual(active.statusCounts, { active: 3, archived: 0 }, 'tombstones never count toward the tabs')
  assert.ok(!active.items.some((row) => ['pending', 'rejected'].includes(row.status)))
  const archived = await dispatch({}, 'lexiconList', { libraryId: lib.id, status: 'archived' })
  assert.equal(archived.total, 0)
  const both = await dispatch({}, 'lexiconList', { libraryId: lib.id, includeArchived: true })
  assert.equal(both.total, 3)
  assert.equal((await dispatch({}, 'lexiconSearch', { libraryId: lib.id, q: '老待审' })).items.length, 0, 'legacy pending never searches')
  assert.equal((await dispatch({}, 'lexiconSearch', { libraryId: lib.id, q: '墓碑词', includeArchived: true })).items.length, 0, 'rejected tombstones never search')

  // 清理手工数据，后面的导入/备份用例不背着 legacy 行。
  const clean = readLexiconFile(lib.id)
  delete clean.terms['lex-legacy-pending-qa']
  delete clean.terms['lex-tombstone-qa']
  writeLexiconFile(lib.id, clean)
})

test('lexiconList and lexiconSearch resolve the library from the session binding', async () => {
  const sessionLib = state.createLibrary({ name: 'lexicon-session', cwd: path.join(home, 'lexicon-session') })
  state.ensureSession('lex-session-mapped', { cwd: path.join(home, 'lexicon-session') })
  await dispatch({}, 'lexiconAdd', { sessionId: 'lex-session-mapped', term: '月引', kind: 'term', meaning: '月下引路的仪式' })
  const view = await dispatch({}, 'lexiconList', { sessionId: 'lex-session-mapped' })
  assert.equal(view.libraryId, sessionLib.id)
  // 未绑定会话没有可映射的库。
  await assert.rejects(() => dispatch({}, 'lexiconList', { sessionId: 'lex-never-bound' }), /not bound/)
  // 搜索：会话路径带 memoryContext 做可见过滤；显式库路径是管理视角。
  await dispatch({}, 'lexiconAdd', { sessionId: 'lex-session-mapped', term: '雾航', kind: 'term', meaning: '雾夜航行的禁忌', context: { worldId: 'world-a' } })
  await dispatch({}, 'setMemoryContext', { sessionId: 'lex-session-mapped', context: { worldId: 'world-a' } })
  const visible = await dispatch({}, 'lexiconSearch', { sessionId: 'lex-session-mapped', q: '雾航' })
  assert.equal(visible.items.length, 1)
  await dispatch({}, 'setMemoryContext', { sessionId: 'lex-session-mapped', context: { worldId: 'world-b' } })
  const blocked = await dispatch({}, 'lexiconSearch', { sessionId: 'lex-session-mapped', q: '雾航' })
  assert.equal(blocked.items.length, 0, 'context 越界的词条不通过会话搜索搭车返回')
  await assert.rejects(() => dispatch({}, 'lexiconSearch', { libraryId: sessionLib.id }), /q is required/)
  // 显式选库（管理视角）没有会话场景：无作用域词条照常命中；带 worldId 作用域的
  // 词条与空白 context 不可见——与记忆的 contextVisible 同一把尺，词典不另造权限。
  const admin = await dispatch({}, 'lexiconSearch', { libraryId: sessionLib.id, q: '月引' })
  assert.equal(admin.items.length, 1)
  assert.equal(admin.items[0].id, termIdOf(sessionLib.id, '月引'))
  const adminScoped = await dispatch({}, 'lexiconSearch', { libraryId: sessionLib.id, q: '雾航' })
  assert.equal(adminScoped.items.length, 0, 'worldId 作用域词条对空白 context 不可见')
})

test('lexiconAdd validates required fields and writes as the user with active status', async () => {
  await assert.rejects(() => dispatch({}, 'lexiconAdd', { libraryId: lib.id, kind: 'meme', meaning: 'x' }), /term is required/)
  await assert.rejects(() => dispatch({}, 'lexiconAdd', { libraryId: lib.id, term: 'x', meaning: 'x' }), /kind is required/)
  await assert.rejects(() => dispatch({}, 'lexiconAdd', { libraryId: lib.id, term: 'x', kind: 'meme' }), /meaning is required/)
  const result = await dispatch({}, 'lexiconAdd', {
    libraryId: lib.id, term: '霓虹深海', kind: 'term', meaning: '城市夜景的代称',
    usage: '描写夜景', aliases: ['霓虹海'], examples: ['今晚是霓虹深海'],
    evidence: [{ kind: 'message', id: 'm1', quote: '今晚是霓虹深海' }],
  })
  assert.equal(result.created, true)
  assert.equal(result.libraryId, lib.id)
  assert.ok(result.term.termId, '核心回传词条对象（含 termId）')
  const store = readLexiconFile(lib.id)
  const entry = Object.values(store.terms).find((e) => e.term === '霓虹深海')
  assert.equal(entry.source, 'user')
  assert.equal(entry.status, 'active')
  assert.deepEqual(entry.aliases, ['霓虹海'])
  assert.equal(entry.evidence[0].quote, '今晚是霓虹深海')
})

test('user lexiconUpdate applies meaning and sensitivity in place; archive/restore/delete follow the public lifecycle', async () => {
  const termId = termIdOf(lib.id, '霓虹深海')
  assert.ok(termId)
  await assert.rejects(() => dispatch({}, 'lexiconUpdate', { libraryId: lib.id, termId: 'lex-nope', patch: { meaning: 'x' } }), /unknown lexicon term/)
  await assert.rejects(() => dispatch({}, 'lexiconUpdate', { libraryId: lib.id, termId, patch: { status: 'archived' } }), /unknown lexicon field/, 'status only moves through lexiconArchive/Restore')
  const before = Object.keys(readLexiconFile(lib.id).terms).length
  // 非敏感字段（usage）原地更新。
  const inPlace = await dispatch({}, 'lexiconUpdate', { libraryId: lib.id, termId, patch: { usage: '描写城市夜景时用' } })
  assert.equal(inPlace.created, false)
  assert.equal(readLexiconFile(lib.id).terms[termId].usage, '描写城市夜景时用')
  // meaning 是敏感字段，但用户来源直接生效：不生成 revision、不等人审。
  const meaning = await dispatch({}, 'lexiconUpdate', { libraryId: lib.id, termId, patch: { meaning: '城市夜景的代称（已核对）' } })
  assert.equal(meaning.created, false)
  assert.equal(meaning.pendingRevision, undefined)
  // sensitivity 同样由用户直接改。
  const sensitivity = await dispatch({}, 'lexiconUpdate', { libraryId: lib.id, termId, patch: { sensitivity: 'sensitive' } })
  assert.equal(sensitivity.created, false)
  let store = readLexiconFile(lib.id)
  assert.equal(Object.keys(store.terms).length, before, 'no revision row is ever created')
  assert.ok(!Object.values(store.terms).some((entry) => entry.revisionOf))
  assert.equal(store.terms[termId].meaning, '城市夜景的代称（已核对）')
  assert.equal(store.terms[termId].sensitivity, 'sensitive')
  assert.equal(store.terms[termId].status, 'active')
  assert.equal(store.terms[termId].source, 'user')
  // 改回普通敏感度，避免影响后面的导入保护用例。
  await dispatch({}, 'lexiconUpdate', { libraryId: lib.id, termId, patch: { sensitivity: 'normal' } })

  // 归档 / 恢复：可逆，不写 rejected 指纹。
  const archived = await dispatch({}, 'lexiconArchive', { libraryId: lib.id, termId })
  assert.equal(archived.action, 'archive')
  assert.equal(archived.term.status, 'archived')
  assert.equal((await dispatch({}, 'lexiconList', { libraryId: lib.id })).items.some((row) => row.id === termId), false)
  assert.equal((await dispatch({}, 'lexiconList', { libraryId: lib.id, status: 'archived' })).items.some((row) => row.id === termId), true)
  store = readLexiconFile(lib.id)
  assert.equal(store.rejected?.[store.terms[termId].fingerprint], undefined, 'archiving is not a rejection tombstone')
  await assert.rejects(() => dispatch({}, 'lexiconArchive', { libraryId: lib.id, termId }), /only active terms can be archived/)
  const restored = await dispatch({}, 'lexiconRestore', { libraryId: lib.id, termId })
  assert.equal(restored.action, 'restore')
  assert.equal(restored.term.status, 'active')
  assert.equal((await dispatch({}, 'lexiconList', { libraryId: lib.id })).items.some((row) => row.id === termId), true)

  // 删除是永久的：归档词条也能删（管理面两段确认由 UI 负责），删一次成功，再删报未知。
  await dispatch({}, 'lexiconArchive', { libraryId: lib.id, termId })
  const gone = await dispatch({}, 'lexiconDelete', { libraryId: lib.id, termId })
  assert.equal(gone.deleted, true)
  await assert.rejects(() => dispatch({}, 'lexiconDelete', { libraryId: lib.id, termId }), /does not exist/)
  await assert.rejects(() => dispatch({}, 'lexiconRestore', { libraryId: lib.id, termId }), /does not exist/)
})

test('model tools: proposals are active immediately; sensitive triggers and field rewrites are refused with readable text', async () => {
  const { tools, dispose } = fakeToolCtx()
  const names = tools.map((tool) => tool.name)
  assert.ok(names.includes('memu_lexicon_search'))
  assert.ok(names.includes('memu_lexicon_propose'))
  // 未绑定会话：两条工具都给明确文案，而不是创建幽灵库。
  const unboundSearch = await tools.find((tool) => tool.name === 'memu_lexicon_search').execute({ query: '糖刀' }, toolsExec('lex-unbound-session'))
  assert.match(unboundSearch, /没有绑定记忆库/)
  const unboundPropose = await tools.find((tool) => tool.name === 'memu_lexicon_propose').execute({ term: 'x', kind: 'term', meaning: 'y' }, toolsExec('lex-unbound-session'))
  assert.match(unboundPropose, /没有绑定记忆库/)
  state.ensureSession('lex-tools-session', { cwd: path.join(home, 'lexicon-main') })
  const exec = toolsExec('lex-tools-session')
  const propose = (args) => tools.find((tool) => tool.name === 'memu_lexicon_propose').execute(args, exec)
  const search = (query) => tools.find((tool) => tool.name === 'memu_lexicon_search').execute({ query }, exec)

  // snake_case → 内部 camelCase：usage/aliases/examples 全链路落到词条字段上；普通词条直接 active。
  const proposal = await propose({
    term: '贴贴',
    kind: 'slang',
    meaning: '亲密地靠在一起的动作',
    usage: '描述互动',
    aliases: ['贴贴抱'],
    examples: ['我们贴贴'],
    evidence: [{ kind: 'message', id: 'm2', quote: '我们贴贴' }],
    confidence: 0.8,
  })
  assert.match(proposal, /status=active/)
  let store = readLexiconFile(lib.id)
  const entry = Object.values(store.terms).find((e) => e.term === '贴贴')
  assert.equal(entry.status, 'active', 'model proposals take effect immediately; no pending state')
  assert.equal(entry.source, 'model-proposal')
  assert.equal(entry.usage, '描述互动')
  assert.deepEqual(entry.aliases, ['贴贴抱'])
  assert.deepEqual(entry.examples, ['我们贴贴'])
  assert.equal(entry.evidence[0].quote, '我们贴贴')

  // sensitive trigger 的 typed rejection 翻译成"该让用户做什么"。
  const refusal = await propose({ term: '红牌', kind: 'trigger', meaning: '试图由模型提案敏感触发词' })
  assert.match(refusal, /sensitive trigger 不能由模型写入或修改/)
  assert.equal(Object.values(readLexiconFile(lib.id).terms).find((e) => e.term === '红牌').meaning, '角色行为的红线信号', '敏感触发词的原词条没有被提案覆盖')

  // 重复提案改 meaning：非用户改敏感字段被拒绝（工具把它翻译成敏感 trigger 文案——当前后端行为）。
  const rewrite = await propose({ term: '糖刀', kind: 'meme', meaning: '试图覆盖 active 词条的提案' })
  assert.match(rewrite, /sensitive trigger/)
  assert.equal(Object.values(readLexiconFile(lib.id).terms).find((e) => e.term === '糖刀').meaning, '表面发糖、实际虐心的剧情')

  // 完全相同的重复提案：原地更新，不新建、不改生命周期。
  const replay = await propose({ term: '糖刀', kind: 'meme', meaning: '表面发糖、实际虐心的剧情' })
  assert.match(replay, /已更新现有生效词条/)
  store = readLexiconFile(lib.id)
  assert.equal(Object.values(store.terms).filter((e) => e.normalizedTerm === '糖刀').length, 1, 'no duplicate row')
  assert.equal(Object.values(store.terms).find((e) => e.normalizedTerm === '糖刀').status, 'active')

  // 归档词条归用户管理：模型不能复活或覆盖。
  const archivedSeed = await dispatch({}, 'lexiconAdd', { libraryId: lib.id, term: '归档提案词', kind: 'term', meaning: '模型不该复活它' })
  await dispatch({}, 'lexiconArchive', { libraryId: lib.id, termId: archivedSeed.term.termId })
  const notOwned = await propose({ term: '归档提案词', kind: 'term', meaning: '模型不该复活它' })
  assert.match(notOwned, /已归档或归用户管理/)
  assert.equal(readLexiconFile(lib.id).terms[archivedSeed.term.termId].status, 'archived')

  // 搜索工具：命中给 term→meaning/usage/evidence 摘要，归档词条不参与。
  const miss = await search('不存在的词')
  assert.match(miss, /没有命中/)
  const hit = await search('糖刀')
  assert.match(hit, /\[糖刀\]/)
  assert.match(hit, /meaning=/)
  const archivedHidden = await search('归档提案词')
  assert.match(archivedHidden, /没有命中/, 'archived terms do not enter the model search')
  assert.equal(formatSearchStatus(await search('贴贴')), 'active', 'a model-written term is searchable right away')
  dispose()
})

// 只从搜索结果里取 status 字段，避免测试耦合具体排版。
function formatSearchStatus(text) {
  const match = /status=([a-z]+)/.exec(String(text || ''))
  return match ? match[1] : ''
}

test('backup manifest carries the lexicon store and skips unsafe names', async () => {
  // 词典目录里放一个不安全命名的文件：writeStores 必须跳过它。
  const junk = path.join(dataDir(), 'lexicon', 'bad id.json')
  fs.mkdirSync(path.dirname(junk), { recursive: true })
  fs.writeFileSync(junk, '{}')
  const created = backup.createBackup({ label: 'lexicon-ui' })
  const manifest = JSON.parse(fs.readFileSync(path.join(created.dir, 'manifest.json'), 'utf8'))
  const rel = `lexicon/${lib.id}.json`
  assert.ok(manifest.files[rel], `manifest lists ${rel}`)
  assert.equal(manifest.files[rel].sha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(dataDir(), 'lexicon', `${lib.id}.json`))).digest('hex'))
  assert.ok(!Object.keys(manifest.files).some((name) => name.includes('bad id')), 'isSafeId 之外的文件名不进备份')
  fs.rmSync(junk, { force: true })
})

test('restore allowlist accepts lexicon/<id>.json and refuses out-of-bounds entries', async () => {
  const lexFile = path.join(dataDir(), 'lexicon', `${lib.id}.json`)
  const original = fs.readFileSync(lexFile, 'utf8')
  const craft = (name, files) => {
    const dir = path.join(dataDir(), 'backups', name)
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.join(dir, rel.split('/').slice(0, -1).join('/')), { recursive: true })
      fs.writeFileSync(path.join(dir, ...rel.split('/')), body)
    }
    const inventory = {}
    for (const [rel, body] of Object.entries(files)) {
      inventory[rel] = { bytes: Buffer.byteLength(body), sha256: crypto.createHash('sha256').update(body).digest('hex') }
    }
    writeJson(path.join(dir, 'manifest.json'), {
      version: backup.BACKUP_SCHEMA,
      kind: 'dsh-memu-memory/backup',
      name,
      uniqueId: name + '-craft',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
      label: 'craft',
      complete: true,
      files: inventory,
    })
    return dir
  }
  // 正路径：只含词典文件的备份可以整份恢复。
  craft('2026-01-01T00-00-00-000Z', { [`lexicon/${lib.id}.json`]: original })
  await dispatch({}, 'lexiconDelete', { libraryId: lib.id, termId: termIdOf(lib.id, '咖啡上头') })
  assert.notEqual(fs.readFileSync(lexFile, 'utf8'), original)
  const restored = await backup.restoreFromBackup('2026-01-01T00-00-00-000Z')
  assert.equal(restored.files, 1)
  assert.equal(fs.readFileSync(lexFile, 'utf8'), original)
  fs.rmSync(path.join(dataDir(), 'backups', '2026-01-01T00-00-00-000Z'), { recursive: true, force: true })
  // 越界：路径穿越在 manifest 校验阶段被拒。（restoreFromBackup 是同步抛错，
  // assert.rejects 必须用 async 箭头把同步 throw 变成 rejection。）
  craft('2026-01-02T00-00-00-000Z', { 'lexicon/../state.json': '{}' })
  await assert.rejects(async () => backup.restoreFromBackup('2026-01-02T00-00-00-000Z'), /invalid backup manifest path/)
  fs.rmSync(path.join(dataDir(), 'backups', '2026-01-02T00-00-00-000Z'), { recursive: true, force: true })
  // 越界：词典目录下的子路径不在 allowlist 内。
  craft('2026-01-03T00-00-00-000Z', { 'lexicon/sub/x.json': '{}' })
  await assert.rejects(async () => backup.restoreFromBackup('2026-01-03T00-00-00-000Z'), /cannot restore/)
  fs.rmSync(path.join(dataDir(), 'backups', '2026-01-03T00-00-00-000Z'), { recursive: true, force: true })
})

test('export bundles a versioned lexicon member; import merges in place with tombstones and sensitive terms protected', async () => {
  const out = await dispatch({}, 'exportLibrary', { libraryId: lib.id })
  assert.equal(out.format, 'dsh-memu-memory-library@1')
  assert.equal(out.lexicon.version, 1)
  assert.ok(Array.isArray(out.lexicon.terms) && out.lexicon.terms.length > 0)
  assert.ok(out.lexicon.terms.every((e) => e.id && e.term))

  const target = state.createLibrary({ name: 'lexicon-import', cwd: path.join(home, 'lexicon-import') })
  const anchorMemory = [{ id: 'mem-anchor', title: 'anchor', content: '锚点正文，让记忆导入有内容可写', status: 'active' }]
  // 冲突更新：同一规范化词（去标点/空白后同词）直接原地更新（用户来源），不再产生 pending revision。
  await dispatch({}, 'lexiconAdd', { libraryId: target.id, term: '糖刀', kind: 'meme', meaning: '导入前的旧释义' })
  let report = await dispatch({}, 'importMemories', {
    libraryId: target.id,
    memories: anchorMemory,
    lexicon: { version: 1, terms: [{ term: '糖刀!!', kind: 'meme', meaning: '导入后的新释义' }] },
  })
  assert.equal(report.lexicon.updated, 1, '同规范词的导入按"更新既有词条"计')
  assert.equal(report.lexicon.added, 0)
  assert.equal(report.lexicon.revisions, 0, 'current no longer generates pending revisions')
  let store = readLexiconFile(target.id)
  const merged = Object.values(store.terms).filter((e) => e.normalizedTerm === '糖刀')
  assert.equal(merged.length, 1, 'no revision draft is created')
  assert.equal(merged[0].meaning, '导入后的新释义')
  assert.equal(merged[0].status, 'active')
  assert.equal(merged[0].source, 'user')

  // 敏感保护：active 且 sensitive 的词条绝不覆盖，跳过并上报。
  await dispatch({}, 'lexiconAdd', { libraryId: target.id, term: '红线', kind: 'trigger', sensitivity: 'sensitive', meaning: '绝对红线' })
  report = await dispatch({}, 'importMemories', {
    libraryId: target.id,
    memories: anchorMemory,
    lexicon: { version: 1, terms: [{ term: '红线', kind: 'trigger', meaning: '试图用导入覆盖红线', sensitivity: 'sensitive' }] },
  })
  assert.equal(report.lexicon.skipped.length, 1)
  assert.equal(report.lexicon.updated, 0)
  assert.equal(Object.values(readLexiconFile(target.id).terms).find((e) => e.term === '红线').meaning, '绝对红线')

  // 墓碑：导入包里的 rejected 行不恢复；库里已有的 rejected 词条也不被洗回生命周期。
  store = readLexiconFile(target.id)
  store.terms['lex-tomb-import'] = legacyEntry('墓碑导入', 'rejected', { fingerprint: 'cafebabe' })
  writeLexiconFile(target.id, store)
  report = await dispatch({}, 'importMemories', {
    libraryId: target.id,
    memories: anchorMemory,
    lexicon: { version: 1, terms: [
      { term: '墓碑导入', kind: 'term', meaning: '导入想复活墓碑' },
      { term: '拒绝行', kind: 'term', meaning: '包里的墓碑行', status: 'rejected' },
    ] },
  })
  assert.equal(report.lexicon.added, 0)
  assert.equal(report.lexicon.skipped.length, 2, 'both the tombstone row and the existing tombstone are skipped')
  assert.equal(report.lexicon.failed.length, 0)
  store = readLexiconFile(target.id)
  assert.equal(store.terms['lex-tomb-import'].status, 'rejected')
  assert.equal(Object.values(store.terms).some((e) => e.term === '拒绝行'), false)

  // legacy pending 收口：普通提案 → active，敏感提案 → archived，revision 草稿不覆盖正条。
  await dispatch({}, 'lexiconAdd', { libraryId: target.id, term: '旧正条', kind: 'term', meaning: '正条释义' })
  report = await dispatch({}, 'importMemories', {
    libraryId: target.id,
    memories: anchorMemory,
    lexicon: { version: 1, terms: [
      { term: '旧提案导入', kind: 'term', meaning: 'legacy 普通提案', status: 'pending' },
      { term: '旧提案敏感', kind: 'trigger', sensitivity: 'sensitive', meaning: 'legacy 敏感提案', status: 'pending' },
      { term: '旧正条', kind: 'term', meaning: 'legacy 草稿不该覆盖正条', status: 'pending', revisionOf: 'lex-target' },
    ] },
  })
  assert.equal(report.lexicon.added, 2)
  assert.equal(report.lexicon.skipped.length, 1, 'the legacy revision draft is skipped, its active target is untouched')
  store = readLexiconFile(target.id)
  assert.equal(Object.values(store.terms).find((e) => e.term === '旧提案导入').status, 'active')
  assert.equal(Object.values(store.terms).find((e) => e.term === '旧提案敏感').status, 'archived')
  assert.equal(Object.values(store.terms).find((e) => e.term === '旧正条').meaning, '正条释义')
  assert.ok(!Object.values(store.terms).some((e) => e.status === 'pending'), 'no pending row lands from an import')

  // 新词条：超长 meaning/usage/aliases/examples 与直接写入同一把尺——按核心 clip 落地，
  // 不再整条拒绝；term 本身超长/归一化为空才进 failed（term 是唯一键，不能截断）。
  report = await dispatch({}, 'importMemories', {
    libraryId: target.id,
    memories: anchorMemory,
    lexicon: { version: 1, terms: [
      { term: '月白', kind: 'term', meaning: '月光下的白' },
      { term: '长义', kind: 'term', meaning: 'y'.repeat(501), usage: 'z'.repeat(301), aliases: ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'], examples: ['例'.repeat(201), '例二', '例三', '例四', '例五', '例六', '例七'] },
      { term: '超'.repeat(81), kind: 'term', meaning: 'term 本身超长，必须整条拒绝而不是截断' },
      { term: '!!!', kind: 'term', meaning: '规范化后为空的 term' },
    ] },
  })
  assert.equal(report.lexicon.added, 2, 'clipped entries land like a direct write would')
  assert.equal(report.lexicon.failed.length, 2)
  assert.match(report.lexicon.failed[0].reason, /80/, 'an over-long term is rejected, not clipped (uniqueness)')
  assert.match(report.lexicon.failed[1].reason, /normalizes to empty/)
  const store2 = readLexiconFile(target.id)
  const clipped = Object.values(store2.terms).find((e) => e.term === '长义')
  assert.equal(clipped.meaning.length, 500)
  assert.equal(clipped.usage.length, 300)
  assert.equal(clipped.aliases.length, 8, 'aliases beyond 8 are clipped like the core write path')
  assert.equal(clipped.examples.length, 5)
  assert.equal(clipped.examples[0].length, 200)
  await assert.rejects(() => dispatch({}, 'importMemories', { libraryId: target.id, memories: anchorMemory, lexicon: { version: 1 } }), /no "terms" array/)
  // 老版本包没有 lexicon member：导入照旧，不报错。
  const legacy = await dispatch({}, 'importMemories', { libraryId: target.id, memories: anchorMemory })
  assert.equal(legacy.lexicon, undefined)
})

test('the lexicon panel is a two-tab card flow with no review/pending surface; auto graph edges get a badge', () => {
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const start = src.indexOf('const LEXICON_TAB_LABELS')
  const end = src.indexOf('function SettingsPage')
  assert.ok(start > 0 && end > start, 'LexiconPanel and its tab labels must stay a single block before SettingsPage')
  const panel = src.slice(start, end)
  // 页签由 RPC 的 statusCounts 驱动，卡片网格替代表格行。
  assert.match(panel, /statusCounts/)
  assert.match(panel, /lexiconTabActive/)
  assert.match(panel, /lexiconTabArchived/)
  assert.match(panel, /gridTemplateColumns/)
  // 归档 / 恢复 / 删除走正确的 RPC，且不再有审核面。
  assert.match(panel, /lexiconArchive'/)
  assert.match(panel, /lexiconRestore'/)
  assert.match(panel, /lexiconDelete'/)
  assert.match(panel, /lexiconUpdate'/)
  assert.ok(!/lexiconReview|includePending|lexiconPending|lexiconApprove|lexiconReject|待审/.test(panel), 'no review/pending surface may remain')
  assert.ok(!/includeArchived/.test(panel), 'the panel never widens the listing; archived rows come from the tab status')
  // 空态：使用中 / 已归档 / 搜索无匹配三档分开。
  assert.match(panel, /lexiconArchivedEmpty/)
  assert.match(panel, /lexiconNoMatch/)
  // 来源记忆跳转与命中三计数 tooltip 保留。
  assert.match(panel, /onFocusMemory/)
  assert.match(panel, /lexiconHitsDetail/)
  // 自动关联边带小 Tag，手动边不受影响（只认 source === 'auto'）。
  assert.match(src, /edge\.source === 'auto'/)
  assert.match(src, /t\('graphAutoLink'\)/)
})
