import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-tools-'))
process.env.DSH_MEMU_HOME = home

const { registerTools } = await import('../lib/tools.js')
const state = await import('../lib/state.js')
const { updateSettings } = state
const { redactSecrets } = await import('../lib/paths.js')
const { createHash } = await import('node:crypto')

test.after(() => {
  state.flushState()
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function fakeCtx() {
  const tools = []
  const ctx = {
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    logger: { warn() {} },
  }
  const dispose = registerTools(ctx)
  return { ctx, tools, dispose }
}

const exec = {
  agent: { session: { header: { id: 'tools-session', cwd: path.join(home, 'project-tools'), agentPreset: 'coding' } } },
}

test('all v1 tools register', () => {
  const { tools, dispose } = fakeCtx()
  const names = tools.map((t) => t.name)
  for (const name of [
    'memu_private_link',
    'memu_private_link_suggest',
    'memu_private_remember',
    'memu_private_remember_batch',
    'memu_private_recall',
    'memu_private_list',
    'memu_private_update',
    'memu_private_archive',
    'memu_private_unpin',
    'memu_lexicon_search',
    'memu_lexicon_propose',
    'memu_global_recall',
    'memu_global_list',
    'memu_status',
  ]) {
    assert.ok(names.includes(name), `missing ${name}`)
  }
  // Exactly fourteen, not "at least these": a schema the host DSL refuses used to
  // abort registerTools() before any register() ran, so counting is the assertion
  // that actually catches a total registration failure.
  assert.equal(names.length, 14, `expected 14 tools, got ${names.length}: ${names.join(', ')}`)
  dispose()
})

test('batch write applies shared defaults and reports each item', async () => {
  const { tools, dispose } = fakeCtx()
  const batch = tools.find((t) => t.name === 'memu_private_remember_batch')
  const batchExec = {
    agent: { session: { header: { id: 'tools-batch-session', cwd: path.join(home, 'project-batch'), agentPreset: 'coding' } } },
  }
  const reply = await batch.execute({
    defaults: { speaker_id: 'user', source: 'user_said', observed_at: '2026-11-06T04:00:00+08:00' },
    items: [
      { title: '码头见面', content: '明天下午三点在码头见面，别迟到。' },
      { title: '带伞', content: '她说码头风大，让我带把伞。' },
    ],
  }, batchExec)
  assert.match(reply, /批量写入完成：新增 2/)
  assert.match(reply, /1\. 已写入私有记忆/)
  assert.match(reply, /2\. 已写入私有记忆/)
  const empty = await batch.execute({ items: [] }, batchExec)
  assert.match(empty, /items 为空/)
  dispose()
})

test('status works without an engine', async () => {
  const { tools, dispose } = fakeCtx()
  const status = await tools.find((t) => t.name === 'memu_status').execute({}, exec)
  assert.match(status, /engine:/)
  assert.match(status, /library:/)
  // The registration count is the visible signal for a refused schema: without it
  // a host that rejects the tool and a plugin that never had it look identical.
  assert.match(status, /tools: 14\/14 registered/)
  dispose()
})

test('title descriptions explain the permanent index rule', () => {
  const { tools, dispose } = fakeCtx()
  const remember = tools.find((t) => t.name === 'memu_private_remember')
  const update = tools.find((t) => t.name === 'memu_private_update')
  for (const tool of [remember, update]) {
    const title = tool.parameters.title.description
    assert.match(title, /8-40/, `${tool.name} title carries the 8-40 rule`)
    assert.match(title, /name the concrete fact|title is a permanent index|anchor shows only titles/, `${tool.name} title says it is an index`)
    assert.match(title, /empty label/, `${tool.name} title forbids empty labels`)
  }
  assert.match(remember.parameters.title.description, /WITHOUT the body/, 'the anchor shows titles without bodies')
  const link = tools.find((t) => t.name === 'memu_private_link')
  assert.match(link.description, /memu_private_link_suggest/, 'link is named as the adjudication tool for candidates')
  assert.match(link.parameters.entity.description, /reused/, 'a named entity can be reused instead of duplicated')
  const search = tools.find((t) => t.name === 'memu_lexicon_search')
  assert.match(search.description, /ACTIVE/)
  assert.match(search.description, /archived entries are excluded/)
  const propose = tools.find((t) => t.name === 'memu_lexicon_propose')
  assert.match(propose.description, /ACTIVE immediately/)
  assert.doesNotMatch(propose.description, /stored as pending|needs human review before/, 'a model proposal is no longer pending')
  assert.match(propose.parameters.term.description, /index key/)
  assert.match(propose.parameters.meaning.description, /explanation/)
  assert.match(tools.find((t) => t.name === 'memu_private_link_suggest').parameters.ids.description, /Required/)
  dispose()
})

test('lexicon propose writes an active entry immediately; search only sees active terms', async () => {
  const { tools, dispose } = fakeCtx()
  const cwd = path.join(home, 'project-lex')
  const execLex = { agent: { session: { header: { id: 'tools-lex', cwd, agentPreset: 'coding' } } } }
  const binding = state.ensureSession('tools-lex', { cwd, agentPreset: 'coding' })
  const lexicon = await import('../lib/lexicon.js')
  const propose = tools.find((t) => t.name === 'memu_lexicon_propose')
  const search = tools.find((t) => t.name === 'memu_lexicon_search')

  const written = await propose.execute({ term: '糖刀', kind: 'slang', meaning: '又甜又扎人的说话方式。' }, execLex)
  assert.match(written, /status=active/)
  assert.doesNotMatch(written, /pending|待审/)
  const storedPair = Object.entries(lexicon.loadLexicon(binding.libraryId).terms).find(([, entry]) => entry.term === '糖刀')
  const stored = storedPair[1]
  assert.equal(stored.status, 'active', 'model-proposal lands as active, no review step')
  assert.equal(stored.source, 'model-proposal')

  // Writing the same normalized term again updates the active entry, it does not fork it.
  const again = await propose.execute({ term: '糖刀', kind: 'slang', meaning: '又甜又扎人的说话方式。', usage: '撒娇时用。' }, execLex)
  assert.match(again, /已更新现有生效词条/)
  assert.equal(Object.values(lexicon.loadLexicon(binding.libraryId).terms).filter((entry) => entry.term === '糖刀').length, 1)

  const hit = await search.execute({ query: '糖刀' }, execLex)
  assert.match(hit, /糖刀/)

  // Archived terms leave both the search surface and injection.
  lexicon.archiveLexiconTerm({ libraryId: binding.libraryId, termId: storedPair[0] })
  const archived = await search.execute({ query: '糖刀' }, execLex)
  assert.match(archived, /没有命中/)
  // Writing the archived term again is not the model's call: it reports the entry was not changed.
  const notOwned = await propose.execute({ term: '糖刀', kind: 'slang', meaning: '再次写入。' }, execLex)
  assert.match(notOwned, /未改动/)
  assert.match(notOwned, /已归档或归用户管理/)
  assert.equal(Object.values(lexicon.loadLexicon(binding.libraryId).terms).find((entry) => entry.term === '糖刀').status, 'archived')

  const refused = await propose.execute({ term: '别离开我', kind: 'trigger', meaning: '离别场景的触发词。' }, execLex)
  assert.match(refused, /sensitive trigger/, 'a sensitive trigger stays user-managed')
  dispose()
})

test('link suggest refreshes deterministic mention edges and returns only uncertain candidates', async () => {
  const { tools, dispose } = fakeCtx()
  const cwd = path.join(home, 'project-links')
  const execLinks = { agent: { session: { header: { id: 'tools-links', cwd, agentPreset: 'rp' } } } }
  const binding = state.ensureSession('tools-links', { cwd, agentPreset: 'rp' })
  const graph = await import('../lib/graph.js')
  const yuike = graph.createEntity({ libraryId: binding.libraryId, name: 'yuike', kind: 'person', status: 'confirmed', confirmedBy: 'user' })
  state.savePrivateIndex(binding.libraryId, { version: 1, entries: {
    'mem-a': { title: '猫娘yuike', content: 'yuike 是一只住在窗台的猫娘，喜欢晒太阳。', status: 'active', visibility: 'shared', layer: 'long_term' },
    'mem-b': { title: 'yuike名字的由来', content: '这个名字来自小时候养过的一只白猫。', status: 'active', visibility: 'shared', layer: 'long_term' },
  } })
  const suggest = tools.find((t) => t.name === 'memu_private_link_suggest')
  assert.equal(suggest.isConcurrencySafe(), false, 'suggest writes links, so it is not a concurrent read')

  const unbound = await suggest.execute({ ids: ['mem-a'] }, {
    agent: { session: { header: { id: 'tools-links-unbound', cwd: path.join(home, 'project-links-unbound') } } },
  })
  assert.match(unbound, /没有绑定记忆库/)
  const empty = await suggest.execute({ ids: [] }, execLinks)
  assert.match(empty, /1-20/)

  updateSettings({ autoLinkMode: 'deterministic' })
  try {
    const payload = JSON.parse(await suggest.execute({ ids: ['mem-a', 'mem-b'] }, execLinks))
    assert.deepEqual(Object.keys(payload).sort(), ['autoLinked', 'candidates'], 'the tool answers with the two-field contract only')
    assert.deepEqual(payload.candidates, [], 'the yuike pair is a deterministic mention, not an uncertain candidate')
    assert.equal(payload.autoLinked.length, 2, 'one mention edge per memory, no lexical pair edge')
    for (const edge of payload.autoLinked) {
      assert.deepEqual(Object.keys(edge).sort(), ['from', 'kind', 'to'], 'no bodies or notes in the compact payload')
      assert.equal(edge.to, yuike.id)
      assert.equal(edge.kind, 'person')
    }
    // The deterministic edge survives into the graph the UI reads.
    const view = graph.getGraph({ libraryId: binding.libraryId, focusId: 'mem-a', depth: 1 })
    assert.ok(view.edges.some((edge) => edge.from === 'mem-a' && edge.to === yuike.id && edge.source === 'auto'))

    // Running it again is idempotent: no new links, same empty candidate list.
    const rerun = JSON.parse(await suggest.execute({ ids: ['mem-a', 'mem-b'] }, execLinks))
    assert.deepEqual(rerun.autoLinked, [])
    assert.deepEqual(rerun.candidates, [])
  } finally {
    updateSettings({ autoLinkMode: 'suggest' })
  }
  dispose()
})

test('private list stays usable without an active vector profile and says why', async () => {
  const { tools, dispose } = fakeCtx()
  updateSettings({ memoryBackend: 'api' })
  try {
    // The conversation must actually be bound: an unbound chat gets the
    // "no library" answer instead, and never creates one just by listing.
    state.ensureSession('tools-session', { cwd: path.join(home, 'project-tools') })
    const text = await tools.find((t) => t.name === 'memu_private_list').execute({}, exec)
    // No active generation means MemU cannot answer; the index still can. "Empty"
    // on its own reads as lost memories, so the reason travels with the result.
    assert.match(text, /私有记忆库 .* 为空。/)
    assert.match(text, /本地向量未激活/)
  } finally {
    updateSettings({ memoryBackend: 'agent' })
    dispose()
  }
})

test('private list on an unbound conversation neither creates a library nor errors', async () => {
  const { tools, dispose } = fakeCtx()
  const before = state.listLibraries().length
  const text = await tools.find((t) => t.name === 'memu_private_list').execute({}, {
    agent: { session: { header: { id: 'tools-unbound', cwd: path.join(home, 'project-unbound'), agentPreset: 'coding' } } },
  })
  assert.match(text, /没有绑定记忆库/)
  assert.equal(state.listLibraries().length, before, 'listing must not materialize a library')
  dispose()
})

test('private list rows carry the same date label recall prints', async () => {
  const { tools, dispose } = fakeCtx()
  const cwd = path.join(home, 'project-dates')
  const execDates = { agent: { session: { header: { id: 'tools-list-dates', cwd, agentPreset: 'coding' } } } }
  state.ensureSession('tools-list-dates', { cwd })
  const remember = tools.find((t) => t.name === 'memu_private_remember')
  // Two forms of the same field: an appointment keeps its year, a birthday keeps MM-DD.
  await remember.execute({ content: '明天要去考驾照。', title: '明天要考驾照', salient_date: '2026-10-29' }, execDates)
  await remember.execute({ content: '生日是 10 月 28 日。', title: '生日', salient_date: '10-28' }, execDates)
  const list = await tools.find((t) => t.name === 'memu_private_list').execute({}, execDates)
  // A date only recall renders reads as "no date" in the list, so the two surfaces
  // must agree on the spelling: date= for a one-off, anniversary= for a yearly one.
  assert.match(list, /date=2026-10-29/)
  assert.match(list, /anniversary=10-28/)
  dispose()
})

test('must_remember requires a pin reason', async () => {
  const { tools, dispose } = fakeCtx()
  const text = await tools.find((t) => t.name === 'memu_private_remember').execute({
    content: 'something worth keeping',
    layer: 'must_remember',
  }, exec)
  assert.match(text, /pin_reason is required/)
  dispose()
})

test('status separates "nobody polled" from "nothing was written"', async () => {
  const { tools, dispose } = fakeCtx()
  const { dispatch } = await import('../lib/rpc.js')
  // A pane polling is what records a beat; a save is what records a write event.
  await dispatch({}, 'getSidebarState', { revisionOnly: true })
  state.savePrivateIndex('lib-sync', { version: 1, entries: {} })
  const unbound = { agent: { session: { header: { id: 'tools-sync', cwd: path.join(home, 'project-sync') } } } }
  const text = await tools.find((t) => t.name === 'memu_status').execute({}, unbound)
  assert.match(text, /sync: heartbeat \d+s ago, last write private@lib-sync \d+s ago/)
  dispose()
})

test('unpin is the model\'s call, guarded by reason, quota and cooldown', async () => {
  const { tools, dispose } = fakeCtx()
  const binding = state.ensureSession('tools-session', { cwd: path.join(home, 'project-tools'), agentPreset: 'coding' })
  const index = state.loadPrivateIndex(binding.libraryId)
  for (const id of ['mem-unpin', 'mem-unpin-2', 'mem-unpin-3']) {
    index.entries[id] = {
      track: 'memory',
      layer: 'must_remember',
      title: `A pinned memory ${id}`,
      content: 'Something that used to matter.',
      status: 'active',
      pinSource: 'user_explicit',
      pinReason: 'keep this',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }
  state.savePrivateIndex(binding.libraryId, index)

  const exec = { agent: { session: { header: { id: 'tools-session' } } } }
  const unpin = (id, reason) => tools.find((t) => t.name === 'memu_private_unpin').execute({ id, reason }, exec)

  const tooShort = await unpin('mem-unpin', 'let it go')
  assert.match(tooShort, /at least 20 characters/)
  assert.equal(state.loadPrivateIndex(binding.libraryId).entries['mem-unpin'].layer, 'must_remember')

  const accepted = await unpin('mem-unpin', '那件事已经过去了，我现在能把它当成一件旧事来讲，而不是每次想起都疼。')
  assert.match(accepted, /long_term|marginalized|边缘化/)
  const after = state.loadPrivateIndex(binding.libraryId).entries['mem-unpin']
  assert.equal(after.layer, 'long_term')
  assert.equal(after.marginalized, true)
  assert.equal(after.unpinnedBy, 'model')
  assert.ok(after.originalPinSource !== undefined)

  // Cooldown: a second unpin right after is refused even though quota remains.
  const cooldown = await unpin('mem-unpin-2', '这次也一样，我已经能平静地说完了，不再需要一直记着。')
  assert.match(cooldown, /cooldown/)
  assert.equal(state.loadPrivateIndex(binding.libraryId).entries['mem-unpin-2'].layer, 'must_remember')

  // Quota: once the conversation has spent it, memory stays pinned.
  state.setSessionBinding('tools-session', { lastUnpinAt: null, unpinCount: 2 })
  const quota = await unpin('mem-unpin-3', '我已经想清楚了，这件事可以放下来，不必再一直提醒自己。')
  assert.match(quota, /quota/)
  dispose()
})

let readFixtureNumber = 0
function readFixture(entries = {}, domain = 'coding') {
  const sessionId = `tools-read-${++readFixtureNumber}`
  const cwd = path.join(home, sessionId)
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: domain })
  state.setSessionBinding(sessionId, { domainOverride: domain })
  const index = { version: 1, entries: Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, {
    id, title: '读取测试', content: '', status: 'active', layer: 'long_term', visibility: 'shared', disclosure: 'can_tell',
    source: 'user_said', source_kind: 'user_said', speaker_id: 'user', domain,
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...entry,
  }])) }
  state.savePrivateIndex(binding.libraryId, index)
  const registered = fakeCtx()
  return { ...registered, sessionId, cwd, binding, exec: { agent: { session: { header: { id: sessionId, cwd } } } },
    privateTool: registered.tools.find((tool) => tool.name === 'memu_private_recall'),
    globalTool: registered.tools.find((tool) => tool.name === 'memu_global_recall') }
}

function parsedPage(reply) {
  assert.equal(typeof reply, 'string', 'tool receipts remain strings')
  const match = reply.match(/pagination: unit=codepoint · offset=(\d+) · returned_chars=(\d+) · total_chars=(\d+) · truncated=(true|false) · next_offset=(\d+|null)/)
  assert.ok(match, `missing codepoint pagination: ${reply}`)
  const revision = reply.match(/^revision=([a-f0-9]{64})$/m)?.[1]
  assert.ok(revision, 'the redacted body SHA256 must be visible')
  const body = reply.split('\nbody:\n')[1]?.split(/\n(?:next:|conflict:)/)[0]
  assert.notEqual(body, undefined)
  return { body, revision, offset: Number(match[1]), returnedChars: Number(match[2]), totalChars: Number(match[3]),
    truncated: match[4] === 'true', nextOffset: match[5] === 'null' ? null : Number(match[5]) }
}

const sha256 = (body) => createHash('sha256').update(body).digest('hex')
const tailBody = (length) => '甲'.repeat(length - 5) + '仅限测试尾'

test('empty bodies and the exact end offset are valid zero-length pages, not range errors', async () => {
  const f = readFixture({ 'mem-empty': { content: '' }, 'mem-end': { content: '😀末尾' } })
  try {
    const empty = parsedPage(await f.privateTool.execute({ query: 'mem-empty' }, f.exec))
    assert.deepEqual([empty.body, empty.totalChars, empty.returnedChars, empty.truncated, empty.nextOffset], ['', 0, 0, false, null])
    assert.equal(empty.revision, sha256(''))
    const start = parsedPage(await f.privateTool.execute({ query: 'mem-end' }, f.exec))
    const end = parsedPage(await f.privateTool.execute({ query: 'mem-end', offset: start.totalChars, revision: start.revision }, f.exec))
    assert.equal(end.body, '')
    assert.equal(end.returnedChars, 0)
    assert.equal(end.nextOffset, null)
    assert.match(await f.privateTool.execute({ query: 'mem-empty', offset: 1, revision: empty.revision }, f.exec), /MEMORY_OFFSET_OUT_OF_RANGE/)
  } finally { f.dispose() }
})

test('exact snippet centering reports its actual codepoint coordinates and a resumable next ref', async () => {
  const id = 'mem-centered-exact'
  const body = '😀'.repeat(200) + id + '🚀'.repeat(200)
  const f = readFixture({ [id]: { content: body } })
  try {
    const reply = await f.privateTool.execute({ query: id, view: 'snippet' }, f.exec)
    const page = parsedPage(reply)
    assert.equal(page.offset, 160)
    assert.equal(page.returnedChars, 160)
    assert.equal(page.body, '…' + Array.from(body).slice(160, 320).join('') + '…')
    assert.equal(page.nextOffset, 320)
    assert.equal(page.totalChars, Array.from(body).length)
    const rest = parsedPage(await f.privateTool.execute({ query: id, libraryId: f.binding.libraryId, offset: page.nextOffset, revision: page.revision }, f.exec))
    assert.equal(rest.body, Array.from(body).slice(320).join(''))
  } finally { f.dispose() }
})

test('private explicit reads allow secret/disclosure but never open archived or superseded entries', async () => {
  const f = readFixture({
    'mem-secret': { content: '显式秘密正文', visibility: 'secret', disclosure: 'never_say' },
    'mem-asked': { content: '仅当被问到的正文', disclosure: 'only_if_asked' },
    'mem-archived': { content: '归档正文不开放', status: 'archived' },
    'mem-superseded': { content: '被替代正文不开放', status: 'superseded' },
    'mem-held': { content: '待复核正文不开放', status: 'pending_review' },
  })
  try {
    assert.equal(parsedPage(await f.privateTool.execute({ query: 'mem-secret' }, f.exec)).body, '显式秘密正文')
    assert.equal(parsedPage(await f.privateTool.execute({ query: 'mem-asked' }, f.exec)).body, '仅当被问到的正文')
    for (const id of ['mem-archived', 'mem-superseded', 'mem-held']) {
      const reply = await f.privateTool.execute({ query: id }, f.exec)
      assert.match(reply, /MEMORY_NOT_READABLE/)
      assert.doesNotMatch(reply, /正文不开放/)
    }
    state.setSessionBinding(f.sessionId, { useLibrary: false })
    assert.doesNotMatch(await f.privateTool.execute({ query: 'mem-secret' }, f.exec), /显式秘密正文/)
  } finally { f.dispose() }
})

test('global exact reads retain automatic/domain eligibility', async () => {
  const f = readFixture()
  const saved = state.loadGlobalIndex()
  state.saveGlobalIndex({ version: 1, entries: {
    'gmem-good': { content: '合法全局正文', status: 'active', domain: 'coding', source: 'tool' },
    'gmem-secret': { content: '不开放秘密', status: 'active', domain: 'coding', visibility: 'secret' },
    'gmem-never': { content: '不开放披露', status: 'active', domain: 'coding', disclosure: 'never_say' },
    'gmem-asked': { content: '不开放仅问', status: 'active', domain: 'coding', disclosure: 'only_if_asked' },
    'gmem-rp': { content: '不开放异域', status: 'active', domain: 'rp' },
    'gmem-archived': { content: '不开放归档', status: 'archived', domain: 'coding' },
  } })
  try {
    assert.equal(parsedPage(await f.globalTool.execute({ query: 'gmem-good.md' }, f.exec)).body, '合法全局正文')
    for (const id of ['gmem-secret', 'gmem-never', 'gmem-asked', 'gmem-rp', 'gmem-archived']) {
      const reply = await f.globalTool.execute({ query: id }, f.exec)
      assert.match(reply, /MEMORY_NOT_READABLE/)
      assert.doesNotMatch(reply, /不开放/)
    }
    assert.match(await f.globalTool.execute({ query: 'gmem-unknown' }, f.exec), /MEMORY_NOT_FOUND/)
    state.setSessionBinding(f.sessionId, { useGlobal: false })
    assert.doesNotMatch(await f.globalTool.execute({ query: 'gmem-good' }, f.exec), /合法全局正文/)
  } finally { state.saveGlobalIndex(saved); f.dispose() }
})

test('cross-library same-id reads honor libraryId, domain and opt-in without changing bindings', async () => {
  const current = readFixture({ 'mem-same': { content: '本库正文', domain: 'rp' } })
  const foreign = readFixture({ 'mem-same': { content: '外库正文' }, 'mem-foreign-rp': { content: '外库异域禁止', domain: 'rp' } })
  const different = readFixture({ 'mem-same': { content: '异域库正文禁止' } }, 'rp')
  const savedCross = state.getSettings().crossLibraryRecall
  try {
    updateSettings({ crossLibraryRecall: false })
    assert.match(await current.privateTool.execute({ query: 'mem-same', libraryId: foreign.binding.libraryId }, current.exec), /MEMORY_LIBRARY_FORBIDDEN/)
    updateSettings({ crossLibraryRecall: true })
    const before = JSON.stringify(state.getSessionBinding(current.sessionId))
    assert.equal(parsedPage(await current.privateTool.execute({ query: 'mem-same' }, current.exec)).body, '本库正文', 'primary does not domain-filter its own entries')
    const directed = await current.privateTool.execute({ query: 'mem-same', libraryId: foreign.binding.libraryId }, current.exec)
    assert.equal(parsedPage(directed).body, '外库正文')
    assert.ok(directed.includes(`libraryId="${foreign.binding.libraryId}"`))
    assert.equal(JSON.stringify(state.getSessionBinding(current.sessionId)), before)
    assert.match(await current.privateTool.execute({ query: 'mem-foreign-rp', libraryId: foreign.binding.libraryId }, current.exec), /MEMORY_NOT_READABLE/)
    assert.match(await current.privateTool.execute({ query: 'mem-same', libraryId: different.binding.libraryId }, current.exec), /MEMORY_LIBRARY_FORBIDDEN/)
    state.setWorkspacePolicy(foreign.cwd, { useLibrary: false })
    assert.match(await current.privateTool.execute({ query: 'mem-same', libraryId: foreign.binding.libraryId }, current.exec), /MEMORY_LIBRARY_FORBIDDEN/)
  } finally {
    updateSettings({ crossLibraryRecall: savedCross })
    current.dispose(); foreign.dispose(); different.dispose()
  }
})

test('unbound private/full and global reads never create a binding or library', async () => {
  const f = readFixture()
  const saved = state.loadGlobalIndex()
  const sessionId = 'tools-full-unbound'
  const unboundExec = { agent: { session: { header: { id: sessionId, cwd: path.join(home, sessionId) } } } }
  state.saveGlobalIndex({ version: 1, entries: { 'gmem-unbound': { title: '通用全局', content: '通用只读正文', domain: 'general', status: 'active' } } })
  try {
    const libraries = JSON.stringify(state.listLibraries())
    assert.match(await f.privateTool.execute({ query: 'mem-unknown' }, unboundExec), /MEMORY_UNBOUND/)
    const global = await f.globalTool.execute({ query: 'gmem-unbound' }, unboundExec)
    assert.equal(parsedPage(global).body, '通用只读正文')
    assert.match(global, /unbound=true/)
    assert.equal(state.getSessionBinding(sessionId), null)
    assert.equal(JSON.stringify(state.listLibraries()), libraries)
  } finally { state.saveGlobalIndex(saved); f.dispose() }
})

test('natural search keeps snippets, provenance, cross-library refs and explicit truncation flags', async () => {
  const f = readFixture({
    'mem-search-long': { title: '码头部署约定', content: '甲'.repeat(200) + '码头部署约定' + '乙'.repeat(200), visibility: 'secret', disclosure: 'never_say' },
    'mem-search-short': { title: '短条咖啡约定', content: '短条咖啡约定：仅供测试。', source: 'tool', source_kind: 'tool' },
  })
  const foreign = readFixture({ 'mem-search-foreign': { title: '外库专用检索词', content: '外库专用检索词。' } })
  const saved = state.loadGlobalIndex()
  const savedSettings = state.getSettings()
  state.saveGlobalIndex({ version: 1, entries: { 'gmem-search-long': { title: '全局分页检索词', content: '甲'.repeat(200) + '全局分页检索词' + '乙'.repeat(200), status: 'active', domain: 'coding', source: 'tool' } } })
  updateSettings({ memoryBackend: 'agent', crossLibraryRecall: false, relevanceThreshold: 0 })
  try {
    const long = await f.privateTool.execute({ query: '码头部署约定', topK: 1 }, f.exec)
    assert.match(long, /1\. \[mem-search-long\]/)
    assert.match(long, /view=snippet.*scope=private.*truncated=true/)
    assert.match(long, /source=user_said/)
    assert.match(long, /visibility=secret/)
    assert.match(long, /disclosure=never_say/)
    assert.ok(long.includes(`libraryId="${f.binding.libraryId}"`))
    assert.doesNotMatch(long, /甲{200}|乙{200}/)
    const short = await f.privateTool.execute({ query: '短条咖啡约定', topK: 1 }, f.exec)
    assert.match(short, /\[mem-search-short\]/)
    assert.match(short, /truncated=false/)
    updateSettings({ crossLibraryRecall: true })
    const cross = await f.privateTool.execute({ query: '外库专用检索词', topK: 1 }, f.exec)
    assert.match(cross, /\[mem-search-foreign\]/)
    assert.ok(cross.includes(`libraryId="${foreign.binding.libraryId}"`))
    assert.match(cross, /跨库只读/)
    const global = await f.globalTool.execute({ query: '全局分页检索词', topK: 1 }, f.exec)
    assert.match(global, /1\. \[gmem-search-long\]/)
    assert.match(global, /view=snippet.*scope=global.*truncated=true/)
    assert.match(global, /source=tool/)
    assert.doesNotMatch(global, /甲{200}|乙{200}/)
  } finally {
    updateSettings({ memoryBackend: savedSettings.memoryBackend, crossLibraryRecall: savedSettings.crossLibraryRecall, relevanceThreshold: savedSettings.relevanceThreshold })
    state.saveGlobalIndex(saved)
    f.dispose(); foreign.dispose()
  }
})

test('private/global natural search retain degradation warnings with no active engine', async () => {
  const f = readFixture({ 'mem-degraded': { title: '降级专用检索词', content: '降级专用检索词。' } })
  const savedSettings = state.getSettings()
  const savedGlobal = state.loadGlobalIndex()
  state.saveGlobalIndex({ version: 1, entries: { 'gmem-degraded': { title: '降级专用检索词', content: '降级专用检索词。', status: 'active', domain: 'coding' } } })
  // No active vector generation in this temporary home: preflight rejects before
  // retrieve/ensure/engine startup. The local index hit must remain visible.
  updateSettings({ memoryBackend: 'api', vectorSource: 'local', crossLibraryRecall: false })
  try {
    for (const tool of [f.privateTool, f.globalTool]) {
      const reply = await tool.execute({ query: '降级专用检索词', topK: 1 }, f.exec)
      assert.equal(typeof reply, 'string')
      assert.match(reply, /\[(?:g?mem)-degraded\]/)
      assert.match(reply, /注意：本次召回已降级：/)
      assert.match(reply, /semantic recall failed/)
    }
  } finally {
    updateSettings({ memoryBackend: savedSettings.memoryBackend, vectorSource: savedSettings.vectorSource, crossLibraryRecall: savedSettings.crossLibraryRecall })
    state.saveGlobalIndex(savedGlobal)
    f.dispose()
  }
})

test('redaction happens before coordinates/revision; changed continuations retain MEMORY_CHANGED', async () => {
  const id = 'mem-redacted-page'
  const original = '😀开头 sk-fixtureOnly12345678901234567890 尾部🚀' + '乙'.repeat(180)
  const safe = redactSecrets(original)
  const f = readFixture({ [id]: { content: original } })
  try {
    const first = parsedPage(await f.privateTool.execute({ query: id, limitChars: 19 }, f.exec))
    assert.equal(first.body, Array.from(safe).slice(0, 19).join(''))
    assert.equal(first.totalChars, Array.from(safe).length)
    assert.equal(first.revision, sha256(safe))
    const restReply = await f.privateTool.execute({ query: id, offset: first.nextOffset, revision: first.revision, limitChars: 8000 }, f.exec)
    const rest = parsedPage(restReply)
    assert.equal(first.body + rest.body, safe)
    assert.doesNotMatch(first.body + rest.body, /fixtureOnly/)
    assert.match(await f.privateTool.execute({ query: id, offset: first.nextOffset }, f.exec), /REVISION_REQUIRED/)
    const index = state.loadPrivateIndex(f.binding.libraryId)
    index.entries[id].content += '新版'
    state.savePrivateIndex(f.binding.libraryId, index)
    const changed = await f.privateTool.execute({ query: id, offset: first.nextOffset, revision: first.revision }, f.exec)
    assert.match(changed, /\[MEMORY_CHANGED\]/)
    assert.match(changed, /offset 0/)
    assert.doesNotMatch(changed, /新版|body:/)
    assert.notEqual(parsedPage(await f.privateTool.execute({ query: id }, f.exec)).revision, first.revision)
  } finally { f.dispose() }
})

test('exact snippet stays at 160 codepoints, respects smaller page limits, and never expands conflicts', async () => {
  const id = 'mem-exact-snippet'
  const f = readFixture({
    [id]: { content: tailBody(4000), conflicts_with: 'mem-other-version', visibility: 'secret', disclosure: 'never_say' },
    'mem-other-version': { title: '不得渲染另一正文', content: '第二版秘密正文不得出现在第一版读取中。' },
  })
  try {
    const before = JSON.stringify(state.loadPrivateIndex(f.binding.libraryId))
    const reply = await f.privateTool.execute({ query: id, view: 'snippet', topK: 20 }, f.exec)
    const page = parsedPage(reply)
    assert.equal(page.returnedChars, 160)
    assert.equal(page.totalChars, 4000)
    assert.equal(page.truncated, true)
    assert.equal(page.nextOffset, 160, 'continue after visible text, not the hidden 2000-char API page')
    assert.equal(page.body, '甲'.repeat(160) + '…')
    assert.match(reply, /view=snippet/)
    assert.match(reply, /visibility=secret.*disclosure=never_say/)
    assert.match(reply, /conflict: \[mem-other-version\]/)
    assert.doesNotMatch(reply, /第二版秘密正文|不得渲染另一正文|仅限测试尾/)
    const small = parsedPage(await f.privateTool.execute({ query: id, view: 'snippet', limitChars: 3 }, f.exec))
    assert.equal(small.returnedChars, 3)
    assert.equal(small.body, '甲'.repeat(3))
    assert.equal(small.truncated, true)
    assert.equal(small.nextOffset, 3)
    const full = parsedPage(await f.privateTool.execute({ query: id, limitChars: 8000 }, f.exec))
    assert.equal(full.body, tailBody(4000))
    assert.equal(JSON.stringify(state.loadPrivateIndex(f.binding.libraryId)), before, 'exact full/snippet reads are not recall')
  } finally { f.dispose() }
})

test('exact prefixes/.md resolve to full refs; ambiguity and unknown ids never fall back to search', async () => {
  const f = readFixture({ 'mem-prefix-unique': { content: '唯一前缀正文' }, 'mem-prefix-two': { content: '另一个版本' } })
  try {
    const resolved = await f.privateTool.execute({ query: 'mem-prefix-u.md' }, f.exec)
    assert.match(resolved, /id="mem-prefix-unique"/)
    assert.equal(parsedPage(resolved).body, '唯一前缀正文')
    assert.match(await f.privateTool.execute({ query: 'mem-prefix' }, f.exec), /MEMORY_ID_AMBIGUOUS/)
    assert.match(await f.privateTool.execute({ query: 'mem-missing' }, f.exec), /MEMORY_NOT_FOUND/)
    assert.match(await f.privateTool.execute({ query: '部署限制', view: 'full' }, f.exec), /EXACT_ID_REQUIRED/)
    for (const query of [' mem-prefix-unique', 'mem-prefix-unique ', 'mem-prefix-unique\n', 'mem-prefix unique']) {
      assert.match(await f.privateTool.execute({ query, view: 'full' }, f.exec), /EXACT_ID_REQUIRED/, 'no whitespace in exact ids')
    }
  } finally { f.dispose() }
})

test('recall parser enforces ranges/types and rejects natural-query paging/library targeting', async () => {
  const f = readFixture({ 'mem-validation': { content: '校验正文' } })
  try {
    for (const tool of [f.privateTool, f.globalTool]) {
      assert.match(await tool.execute({ query: '自然语言', view: 'full' }, f.exec), /EXACT_ID_REQUIRED/)
      for (const topK of [0, 21, 1.5, '2', NaN, Infinity, null]) {
        assert.match(await tool.execute({ query: '自然语言', topK }, f.exec), /INVALID_RECALL_ARGUMENT.*topK/)
      }
      for (const field of ['offset', 'limitChars', 'revision', 'libraryId']) {
        assert.match(await tool.execute({ query: '自然语言', [field]: field === 'offset' ? 0 : field === 'limitChars' ? 2000 : 'value' }, f.exec), /INVALID_RECALL_ARGUMENT/)
      }
      for (const query of ['', '   ', null, 42]) assert.match(await tool.execute({ query }, f.exec), /query is required/)
      for (const view of ['object', '', 42, null]) assert.match(await tool.execute({ query: 'mem-validation', view }, f.exec), /INVALID_RECALL_ARGUMENT.*view/)
      for (const offset of [-1, 0.5, '1', NaN, Infinity, null]) assert.match(await tool.execute({ query: 'mem-validation', offset }, f.exec), /INVALID_RECALL_ARGUMENT.*offset/)
      for (const limitChars of [0, -1, 8001, 1.5, '20', Infinity, null]) assert.match(await tool.execute({ query: 'mem-validation', limitChars }, f.exec), /INVALID_RECALL_ARGUMENT.*limitChars/)
      for (const revision of ['', 42, null]) assert.match(await tool.execute({ query: 'mem-validation', revision }, f.exec), /INVALID_RECALL_ARGUMENT.*revision/)
    }
    const first = parsedPage(await f.privateTool.execute({ query: 'mem-validation', limitChars: 1 }, f.exec))
    assert.equal(first.returnedChars, 1)
    assert.match(await f.privateTool.execute({ query: 'mem-validation', offset: 99, revision: first.revision }, f.exec), /MEMORY_OFFSET_OUT_OF_RANGE/)
    assert.match(await f.globalTool.execute({ query: 'gmem-any', libraryId: f.binding.libraryId }, f.exec), /INVALID_RECALL_ARGUMENT/)
    assert.match(await f.privateTool.execute({ query: 'mem-validation', libraryId: '' }, f.exec), /INVALID_RECALL_ARGUMENT/)
  } finally { f.dispose() }
})

for (const scope of ['private', 'global']) {
  for (const length of [160, 161, 169]) {
    test(`${scope} exact auto/full keeps the tail condition of a ${length}-codepoint body`, async () => {
      const id = `${scope === 'private' ? 'mem' : 'gmem'}-tail-${length}`
      const body = tailBody(length)
      const f = readFixture(scope === 'private' ? { [id]: { content: body } } : {})
      const savedGlobal = state.loadGlobalIndex()
      if (scope === 'global') state.saveGlobalIndex({ version: 1, entries: { [id]: {
        title: '全局尾条件', content: body, status: 'active', domain: 'coding', appliesTo: ['coding'], source: 'tool',
      } } })
      try {
        const tool = scope === 'private' ? f.privateTool : f.globalTool
        const before = JSON.stringify(state.loadPrivateIndex(f.binding.libraryId))
        for (const view of [undefined, 'auto', 'full']) {
          const reply = await tool.execute({ query: id, ...(view ? { view } : {}), topK: 20 }, f.exec)
          const page = parsedPage(reply)
          assert.equal(page.body, body)
          assert.equal(page.totalChars, length)
          assert.equal(page.returnedChars, length)
          assert.equal(page.truncated, false)
          assert.equal(page.nextOffset, null)
          assert.equal(page.revision, sha256(body))
          assert.match(reply, /view=full/)
          assert.match(reply, /source=(user_said|tool)/)
          assert.match(reply, new RegExp(`ref: scope=${scope}`))
          assert.deepEqual(tool.output.render({}, reply), [{ type: 'text', text: reply }])
        }
        assert.equal(JSON.stringify(state.loadPrivateIndex(f.binding.libraryId)), before, 'exact reads must not touch search access counters')
      } finally {
        if (scope === 'global') state.saveGlobalIndex(savedGlobal)
        f.dispose()
      }
    })
  }
}

for (const scope of ['private', 'global']) {
  for (const length of [169, 4000]) {
    test(`${scope} ${length}-codepoint pagination is continuous and defaults to 2000`, async () => {
      const id = `${scope === 'private' ? 'mem' : 'gmem'}-paged-${length}`
      const body = '😀甲🚀乙'.repeat(Math.ceil(length / 4))
      const expected = Array.from(body).slice(0, length - 5).join('') + '仅限测试尾'
      const f = readFixture(scope === 'private' ? { [id]: { content: expected } } : {})
      const savedGlobal = state.loadGlobalIndex()
      if (scope === 'global') state.saveGlobalIndex({ version: 1, entries: { [id]: { title: '分页', content: expected, status: 'active', domain: 'coding' } } })
      try {
        const tool = scope === 'private' ? f.privateTool : f.globalTool
        const defaultPage = parsedPage(await tool.execute({ query: id }, f.exec))
        assert.equal(defaultPage.returnedChars, Math.min(2000, length))
        let offset = 0
        let revision = null
        let assembled = ''
        do {
          const reply = await tool.execute({ query: id, view: 'full', offset, limitChars: length === 169 ? 61 : 997,
            ...(revision ? { revision } : {}) }, f.exec)
          const page = parsedPage(reply)
          assert.equal(page.offset, offset)
          assert.equal(page.totalChars, length)
          assert.equal(page.returnedChars, Array.from(page.body).length)
          assert.equal(page.revision, sha256(expected))
          assert.equal(page.truncated, offset + page.returnedChars < length)
          assert.equal(page.body, Array.from(expected).slice(offset, offset + page.returnedChars).join(''))
          assert.equal(page.body.isWellFormed(), true, 'never split emoji surrogate pairs')
          assembled += page.body
          revision = page.revision
          offset = page.nextOffset
          if (offset !== null) {
            assert.match(reply, new RegExp(`next: memu_${scope}_recall query="${id}" view="full"`))
            assert.match(reply, new RegExp(`offset=${offset}.*revision="${revision}"`))
            if (scope === 'private') assert.ok(reply.includes(`libraryId="${f.binding.libraryId}"`))
          } else assert.doesNotMatch(reply, /^next:/m)
        } while (offset !== null)
        assert.equal(assembled, expected)
      } finally {
        if (scope === 'global') state.saveGlobalIndex(savedGlobal)
        f.dispose()
      }
    })
  }
}
