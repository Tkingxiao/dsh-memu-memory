import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-audit-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const inject = await import('../lib/inject.js')
const rpc = await import('../lib/rpc.js')
const curator = await import('../lib/curator.js')
const memu = await import('../lib/memu.js')

test.after(() => {
  try { state.flushState() } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function execFor(sessionId, cwd, agentPreset = 'coding') {
  return { agent: { session: { header: { id: sessionId, cwd, agentPreset } } } }
}

function setup(name) {
  const cwd = path.join(home, 'proj-' + name)
  const sessionId = 'audit-' + name
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  return { cwd, sessionId, binding, exec: execFor(sessionId, cwd) }
}

// ---- §2.2 pending_review must not reach recall / anchor / anniversary / global

test('a held (pending_review) memory never reaches recall, anchor, anniversary, or global recall', async () => {
  const { exec, binding, sessionId } = setup('pending')
  await memory.privateRemember({ exec, content: '部署密钥放在 vault。', title: '部署密钥位置' })
  const held = await memory.privateRemember({ exec, content: '部署密钥改放在 1Password。', title: '部署密钥位置' })
  assert.equal(held.entry.status, 'pending_review')

  const recalled = await memory.privateRecall({ exec, query: '部署密钥位置', topK: 10, relevanceThreshold: 0 })
  assert.ok(!recalled.files.some((f) => f.name === held.id), 'held memory must not be recalled')

  const anchor = inject.buildAnchor(binding, state.getSettings(), sessionId)
  assert.ok(!anchor.text.includes(held.id), 'held memory must not sit in the anchor')

  const md = '01-01'
  state.updatePrivateIndex(binding.libraryId, (idx) => { idx.entries[held.id].salientDate = md })
  const anniversary = inject.buildAnniversary(sessionId, binding, new Date(2026, 0, 1))
  assert.ok(!anniversary.ids.includes(held.id), 'held memory must not surface in anniversaries')

  state.saveGlobalIndex({ entries: { g1: { title: 't', content: '部署密钥改放在 1Password。', domain: 'coding', status: 'pending_review' } } })
  const global = await memory.globalRecall({ exec, query: '部署密钥', topK: 10, relevanceThreshold: 0 })
  assert.ok(!global.files.some((f) => f.name === 'g1'), 'held global memory must not be recalled')
  state.saveGlobalIndex({ entries: {} })
})

// ---- §2.4 agent backend: accepting a global review must not touch the engine

test('agent backend accepts a global review without the engine', async () => {
  state.saveGlobalIndex({ entries: { gpend: { title: 'x', content: 'y', domain: 'coding', status: 'pending_review' } } })
  const out = await rpc.dispatch({}, 'resolveReview', { id: 'gpend', action: 'accept' })
  assert.equal(out.status, 'active')
  const index = state.loadGlobalIndex()
  assert.equal(index.entries.gpend.status, 'active')
  state.saveGlobalIndex({ entries: {} })
})

// ---- §2.1 MemU nonzero exit must reject, not crash the host

test('a failing MemU command rejects with MEMU_COMMAND_FAILED (and the process survives)', async () => {
  fs.mkdirSync(path.join(home, 'engine'), { recursive: true })
  fs.writeFileSync(path.join(home, 'engine', 'current.json'), JSON.stringify({ python: process.execPath, venv: home }))
  let error = null
  try {
    await memu.retrieve({ query: 'x', db: path.join(home, 'x.sqlite3'), timeoutMs: 15_000 })
  } catch (e) {
    error = e
  }
  assert.ok(error, 'must reject, not resolve')
  assert.equal(error.code, 'MEMU_COMMAND_FAILED')
  fs.rmSync(path.join(home, 'engine'), { recursive: true, force: true })
})

// ---- §2.7 globalList domain is a real filter

test('globalList({domain}) returns only that domain', async () => {
  state.saveGlobalIndex({
    entries: {
      gd1: { title: 'a', content: 'a', domain: 'coding', status: 'active' },
      gd2: { title: 'b', content: 'b', domain: 'rp', status: 'active' },
    },
  })
  const { exec, sessionId } = setup('glist')
  state.setSessionBinding(sessionId, { domainOverride: 'coding' })
  const out = await memory.globalList({ exec, domain: 'coding' })
  assert.deepEqual(out.files.map((f) => f.name), ['gd1'])
  state.saveGlobalIndex({ entries: {} })
})

// ---- §2.8 backups carry the prompt manifest

test('a backup includes prompts/manifest.json', () => {
  fs.mkdirSync(path.join(home, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(home, 'prompts', 'manifest.json'), '{"version":1}')
  const dest = state.backupDatabases()
  assert.ok(fs.existsSync(path.join(dest, 'prompts', 'manifest.json')), 'prompt manifest must be in the backup')
})

// ---- §2.9 confidence 0 survives

test('confidence: 0 is stored as 0, not coerced to the default', async () => {
  const { exec, binding } = setup('confzero')
  const saved = await memory.privateRemember({ exec, content: 'low confidence', title: 'zero', confidence: 0 })
  const entry = state.loadPrivateIndex(binding.libraryId).entries[saved.id]
  assert.equal(entry.confidence, 0)
  const updated = await memory.privateUpdate({ exec, id: saved.id, confidence: 0.35 })
  assert.equal(updated.entry.confidence, 0.35)
  const zeroed = await memory.privateUpdate({ exec, id: saved.id, confidence: 0 })
  assert.equal(zeroed.entry.confidence, 0)
})

// ---- §2.6 library browser cannot orphan a session-scoped memory

test('the panel refuses the removed session level with an explanation', async () => {
  const lib = state.createLibrary({ name: 'audit-orphan', cwd: path.join(home, 'ws-orphan') })
  // Refused by the write path itself now, not by a panel-only guard: a client that kept
  // the old dropdown must be told what replaced the level, not silently given 'shared'.
  await assert.rejects(
    rpc.dispatch({}, 'addMemory', { libraryId: lib.id, content: 'x', visibility: 'session' }),
    /visibility 'session' was removed/,
  )
  const saved = await rpc.dispatch({}, 'addMemory', { libraryId: lib.id, content: 'y', title: 'y' })
  await assert.rejects(
    rpc.dispatch({}, 'updateMemory', { libraryId: lib.id, id: saved.id, patch: { visibility: 'session' } }),
    /visibility 'session' was removed/,
  )
  assert.equal(state.loadPrivateIndex(lib.id).entries[saved.id].visibility, 'shared', 'the failed edit changed nothing')
})

test('addMemory passes pin fields through for must_remember', async () => {
  const lib = state.createLibrary({ name: 'audit-pin', cwd: path.join(home, 'ws-pin') })
  const out = await rpc.dispatch({}, 'addMemory', {
    libraryId: lib.id, content: 'pinned from browser', title: 'pinned',
    layer: 'must_remember', pinReason: 'user asked to remember', pinSource: 'user_explicit',
  })
  assert.equal(out.entry.layer, 'must_remember')
  assert.equal(out.entry.pinSource, 'user_explicit')
})

// ---- §2.13 switches constrain tool-level operations

test('a conversation with useLibrary=false cannot read or write private memory', async () => {
  const { exec, sessionId } = setup('switched-off')
  await memory.privateRemember({ exec, content: 'before the switch', title: 't' })
  state.setSessionBinding(sessionId, { useLibrary: false })
  await assert.rejects(() => memory.privateRecall({ exec, query: 'before the switch' }), /turned off for this conversation/)
  await assert.rejects(() => memory.privateRemember({ exec, content: 'sneaky', title: 's' }), /turned off for this conversation/)
  state.setSessionBinding(sessionId, { useLibrary: true })
})

test('a conversation with useGlobal=false cannot recall global memory', async () => {
  const { exec, sessionId } = setup('global-off')
  state.setSessionBinding(sessionId, { useGlobal: false })
  await assert.rejects(() => memory.globalRecall({ exec, query: 'anything' }), /turned off for this conversation/)
  state.setSessionBinding(sessionId, { useGlobal: true })
})

// ---- §2.14 unbound writes are refused, not written to null.json

test('writing with no library binding refuses instead of creating index/null.json', async () => {
  const cwd = path.join(home, 'proj-unbound')
  const sessionId = 'audit-unbound'
  // Bind with both layers off and no library — the "no memory" new-session choice.
  state.ensureSession(sessionId, { cwd, createLibrary: false })
  state.setSessionBinding(sessionId, { useLibrary: false, useGlobal: false })
  const exec = execFor(sessionId, cwd)
  await assert.rejects(() => memory.privateRemember({ exec, content: 'orphan', title: 'o' }), /no memory library/)
  assert.ok(!fs.existsSync(path.join(home, 'index', 'null.json')), 'no null.json may appear')
})

// ---- §2.21 engine downgrade gate

test('engine version comparison treats betas and finals correctly', async () => {
  const { isVersionDowngrade } = await import('../lib/engine.js')
  assert.equal(isVersionDowngrade('0.11.0b2', '0.11.0b3'), true)
  assert.equal(isVersionDowngrade('0.11.0b3', '0.11.0b3'), false)
  assert.equal(isVersionDowngrade('0.11.0', '0.11.0b3'), false, 'final release is newer than its betas')
  assert.equal(isVersionDowngrade('0.10.0', '0.11.0'), true)
  assert.equal(isVersionDowngrade('0.12.0', '0.11.0b3'), false)
})

// ---- §2.16 a failed state.json read must never write the fallback back

test('a transient state.json read failure does not overwrite real data on recovery', () => {
  const stateFile = path.join(home, 'state.json')
  state.flushState()
  const saved = fs.readFileSync(stateFile, 'utf8')
  const parsed = JSON.parse(saved)
  parsed.settings.marker = 'real-data'
  fs.writeFileSync(stateFile, JSON.stringify(parsed))

  // Make the file unreadable (a directory at its path), then touch bookkeeping.
  fs.rmSync(stateFile)
  fs.mkdirSync(stateFile)
  state.loadState()
  state.setWorkspacePolicy(path.join(home, 'during-failure'), { useLibrary: false })
  assert.throws(() => state.flushState(), (error) => error.code === 'dsh-memu-memory/read-failed')

  // Recover: the real file comes back. The next flush must adopt the disk truth,
  // not the defaults that were cached while reads failed.
  fs.rmdirSync(stateFile)
  fs.writeFileSync(stateFile, JSON.stringify(parsed))
  state.loadState()
  state.flushState()
  const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(after.settings.marker, 'real-data', 'real settings survive the incident')
  assert.ok(after.workspacePolicies != null, 'workspace policies map still exists')
})

// ---- §2.15 recall ids match the text that actually got injected

test('buildRecall ids only contain entries present in the (possibly truncated) text', async () => {
  const { exec, binding, sessionId } = setup('truncate')
  const long = '内容'.repeat(400)
  await memory.privateRemember({ exec, content: long, title: '第一条长记忆' })
  await memory.privateRemember({ exec, content: long, title: '第二条长记忆' })
  const settings = { ...state.getSettings(), turnTokens: 120, relevanceThreshold: 0, privateTopK: 4, dedupeTurns: 0 }
  const out = await inject.buildRecall(binding, '长记忆', 1, settings, exec, sessionId)
  if (out.text) {
    assert.ok(out.text.includes('</memory-context>'), 'the block must be closed after truncation')
    for (const id of out.ids) assert.ok(out.text.includes(`[${id}]`), `id ${id} must appear in the text`)
  }
})

// ---- §2.17 merge + needs_review must not overwrite the target

test('curator merge with needs_review holds a copy and keeps the original active', async () => {
  state.saveGlobalIndex({
    entries: { gtarget: { title: 'original', content: 'original body', domain: 'coding', status: 'active', createdAt: new Date().toISOString() } },
  })
  const job = { step: '' }
  const out = await curator.commitCuratorOutput({
    memories: [{ op: 'merge', target_id: 'gtarget', title: 'original', content: 'rewritten body', domain: 'coding', needs_review: true }],
  }, { job })
  assert.equal(out.pending, 1)
  const index = state.loadGlobalIndex()
  assert.equal(index.entries.gtarget.status, 'active')
  assert.equal(index.entries.gtarget.content, 'original body')
  const held = Object.values(index.entries).find((e) => e.status === 'pending_review')
  assert.ok(held, 'the rewrite waits in its own pending row')
  assert.notEqual(Object.keys(index.entries).find((id) => index.entries[id] === held), 'gtarget')
  state.saveGlobalIndex({ entries: {} })
})

// ---- §2.20 the remember tool says when a memory is held for review

test('memu_private_remember reports a held conflict instead of plain success', async () => {
  const { registerTools } = await import('../lib/tools.js')
  const registered = []
  const dispose = registerTools({ tools: { register(t) { registered.push(t); return () => {} } }, logger: { warn() {} } })
  try {
    const remember = registered.find((t) => t.name === 'memu_private_remember')
    const { exec } = setup('conflict-reply')
    await remember.execute({ content: '周五发布。', title: '发布日' }, exec)
    const reply = await remember.execute({ content: '改到周四发布。', title: '发布日' }, exec)
    assert.match(reply, /待复核|pending_review/, 'the reply must say the memory is held for review')
    assert.doesNotMatch(reply, /^已写入私有记忆/)
  } finally {
    dispose()
  }
})
