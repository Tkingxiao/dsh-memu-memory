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

test.after(() => {
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

test('link suggest applies high-confidence links and returns only uncertain candidates', async () => {
  const { tools, dispose } = fakeCtx()
  const cwd = path.join(home, 'project-links')
  const execLinks = { agent: { session: { header: { id: 'tools-links', cwd, agentPreset: 'rp' } } } }
  const binding = state.ensureSession('tools-links', { cwd, agentPreset: 'rp' })
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

  const payload = JSON.parse(await suggest.execute({ ids: ['mem-a'] }, execLinks))
  assert.deepEqual(Object.keys(payload).sort(), ['autoLinked', 'candidates'], 'the tool answers with the two-field contract only')
  assert.deepEqual(payload.candidates, [], 'the yuike pair is high confidence, so nothing is handed over')
  assert.equal(payload.autoLinked.length, 3, 'relation link plus one hub link per memory')
  for (const edge of payload.autoLinked) {
    assert.deepEqual(Object.keys(edge).sort(), ['from', 'kind', 'to'], 'no bodies or notes in the compact payload')
  }
  assert.ok(payload.autoLinked.some((edge) => edge.from === 'mem-a' && edge.to === 'mem-b' && edge.kind === 'relation'))
  assert.ok(payload.autoLinked.some((edge) => edge.from === 'mem-a' && edge.kind === 'person'))
  // The auto source survives into the graph the UI reads.
  const graph = await import('../lib/graph.js')
  const view = graph.getGraph({ libraryId: binding.libraryId, focusId: 'mem-a', depth: 1 })
  assert.ok(view.edges.some((edge) => edge.from === 'mem-a' && edge.to === 'mem-b' && edge.source === 'auto'))

  // Running it again is idempotent: no new links, same empty candidate list.
  const rerun = JSON.parse(await suggest.execute({ ids: ['mem-a', 'mem-b'] }, execLinks))
  assert.deepEqual(rerun.autoLinked, [])
  assert.deepEqual(rerun.candidates, [])
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
