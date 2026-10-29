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
    'memu_private_remember',
    'memu_private_recall',
    'memu_private_list',
    'memu_private_update',
    'memu_private_archive',
    'memu_private_unpin',
    'memu_global_recall',
    'memu_global_list',
    'memu_status',
  ]) {
    assert.ok(names.includes(name), `missing ${name}`)
  }
  // Exactly ten, not "at least these nine": a schema the host DSL refuses used to
  // abort registerTools() before any register() ran, so counting is the assertion
  // that actually catches a total registration failure.
  assert.equal(names.length, 10, `expected 10 tools, got ${names.length}: ${names.join(', ')}`)
  dispose()
})

test('status works without an engine', async () => {
  const { tools, dispose } = fakeCtx()
  const status = await tools.find((t) => t.name === 'memu_status').execute({}, exec)
  assert.match(status, /engine:/)
  assert.match(status, /library:/)
  // The registration count is the visible signal for a refused schema: without it
  // a host that rejects the tool and a plugin that never had it look identical.
  assert.match(status, /tools: 10\/10 registered/)
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
