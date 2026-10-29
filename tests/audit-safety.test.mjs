import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-safety-'))
process.env.DSH_MEMU_HOME = home
const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const inject = await import('../lib/inject.js')
const rpc = await import('../lib/rpc.js')
const paths = await import('../lib/paths.js')
const { readMood } = await import('../lib/mood.js')
const { estTokens } = await import('../lib/budget.js')

test.after(() => {
  state.flushState()
  fs.rmSync(home, { recursive: true, force: true })
})

function session(name, cwd = path.join(home, name)) {
  const binding = state.ensureSession(name, { cwd, agentPreset: 'rp' })
  return { binding, exec: { agent: { session: { header: { id: name, cwd, agentPreset: 'rp' } } } } }
}

test('a failed atomic replacement never removes the previous file', () => {
  const file = path.join(home, 'atomic.json')
  paths.writeJson(file, { old: true })
  const rename = fs.renameSync
  fs.renameSync = () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) }
  try { assert.throws(() => paths.writeJson(file, { new: true }), /busy/) } finally { fs.renameSync = rename }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { old: true })
  assert.ok(!fs.readdirSync(home).some(name => name.includes('.tmp-')))
  let attempts = 0
  fs.renameSync = (...args) => {
    if (++attempts <= 2) throw Object.assign(new Error('temporary Windows handle'), { code: 'EPERM' })
    return rename(...args)
  }
  try { paths.writeJson(file, { recovered: true }) } finally { fs.renameSync = rename }
  assert.equal(attempts, 3)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { recovered: true })
})

test('a throwing transaction cannot mutate either the cached or persisted memory', () => {
  const { binding } = session('mutator')
  state.updatePrivateIndex(binding.libraryId, index => { index.entries.a = { title: 'original' } })
  assert.throws(() => state.updatePrivateIndex(binding.libraryId, index => {
    index.entries.a.title = 'dirty'
    throw new Error('refused')
  }), /refused/)
  assert.equal(state.loadPrivateIndex(binding.libraryId).entries.a.title, 'original')
  state.clearCaches()
  assert.equal(state.loadPrivateIndex(binding.libraryId).entries.a.title, 'original')
})

test('a pending state write merges external fields even when a synchronous save follows', () => {
  state.flushState()
  state.updateSettings({ dedupeTurns: 17 })
  const file = path.join(home, 'state.json')
  const external = JSON.parse(fs.readFileSync(file))
  external.settings.globalTopK = 9
  external.sessions['external-session'] = { libraryId: null, useLibrary: false }
  fs.writeFileSync(file, JSON.stringify(external, null, 1))
  state.setSessionBinding('local-session', { useGlobal: false })
  state.saveState(state.loadState())
  const saved = JSON.parse(fs.readFileSync(file))
  assert.equal(saved.settings.dedupeTurns, 17)
  assert.equal(saved.settings.globalTopK, 9)
  assert.ok(saved.sessions['external-session'])
  assert.ok(saved.sessions['local-session'])
})

test('state flush preserves disk-only bindings even if the cached fingerprint matches', () => {
  state.flushState()
  const file = path.join(home, 'state.json')
  const external = JSON.parse(fs.readFileSync(file))
  external.sessions['fingerprint-collision'] = { useGlobal: false }
  const read = fs.readFileSync
  let raced = false
  state.clearCaches()
  fs.readFileSync = (...args) => {
    const result = read(...args)
    if (String(args[0]) === file && !raced) {
      raced = true
      fs.writeFileSync(file, JSON.stringify(external))
    }
    return result
  }
  try { state.loadState() } finally { fs.readFileSync = read }
  state.updateSettings({ dedupeTurns: 18 })
  state.flushState()
  assert.ok(raced)
  assert.ok(JSON.parse(fs.readFileSync(file)).sessions['fingerprint-collision'])
})

test('a compact follow-up query includes only recent real user context', () => {
  const previous = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '周五去车站找小周。' }] }
  const injection = { role: 'user', source: { kind: 'plugin:dsh-memu-memory' }, content: [{ type: 'text', text: 'do not use plugin text' }] }
  const current = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '她呢？' }] }
  const query = inject.contextualQuery([previous, injection, current], current)
  assert.ok(query.includes('小周'))
  assert.ok(!query.includes('plugin'))
})

test('disjoint stale snapshots merge, but an older edit to the same entry is refused', () => {
  const { binding } = session('snapshots')
  state.savePrivateIndex(binding.libraryId, { entries: { a: { title: 'a' }, b: { title: 'b' } } })
  const first = state.loadPrivateIndex(binding.libraryId)
  const second = state.loadPrivateIndex(binding.libraryId)
  first.entries.a.title = 'new a'
  state.savePrivateIndex(binding.libraryId, first)
  second.entries.b.title = 'new b'
  state.savePrivateIndex(binding.libraryId, second)
  assert.equal(state.loadPrivateIndex(binding.libraryId).entries.a.title, 'new a')
  second.entries.a.title = 'stale a'
  assert.throws(() => state.savePrivateIndex(binding.libraryId, second), /changed concurrently/)
  assert.equal(state.loadPrivateIndex(binding.libraryId).entries.a.title, 'new a')
})

test('a Chinese body larger than the turn budget still supplies a closed context and its actual id', async () => {
  const { exec, binding } = session('budget')
  const saved = await memory.privateRemember({ exec, title: '月光', content: '月光映着杯子。'.repeat(120), source: 'imagined' })
  const result = await inject.buildRecall(binding, '月光杯子', 2, { ...state.getSettings(), turnTokens: 640 }, exec)
  assert.deepEqual(result.ids, [saved.id])
  assert.ok(result.text.includes('source=imagined'))
  assert.ok(result.text.endsWith('</memory-context>'))
  assert.ok(estTokens(result.text) <= 640)
  assert.equal(state.loadPrivateIndex(binding.libraryId).entries[saved.id].accessCount, 0, 'automatic candidate lookup does not reinforce unseen text')
})

test('secrets require an explicit recall and never appear in automatic recall', async () => {
  const { exec, binding } = session('secret')
  const saved = await memory.privateRemember({ exec, title: '藏钥匙', content: '钥匙在绿色花盆下。', visibility: 'secret' })
  assert.deepEqual((await memory.privateRecall({ exec, query: '钥匙', purpose: 'automatic' })).files, [])
  assert.ok(!(await inject.buildRecall(binding, '钥匙', 2, state.getSettings(), exec)).text.includes(saved.id))
  assert.equal((await memory.privateRecall({ exec, query: saved.id })).files[0].name, saved.id)
})

test('lists and edits enforce the context boundary even with an explicit library id', async () => {
  const a = session('owner-a')
  const b = session('owner-b', path.join(home, 'owner-a'))
  // Both conversations live in the same folder (one library); what separates them is the
  // scope, which is the only thing left that can separate them.
  state.setSessionBinding('owner-a', { memoryContext: { characterId: 'hero' } })
  state.setSessionBinding('owner-b', { memoryContext: { characterId: 'villain' } })
  const saved = await memory.privateRemember({ exec: a.exec, title: '独处', content: '只属于英雄线的片段。' })
  assert.equal((await memory.privateList({ exec: b.exec })).files.length, 0)
  await assert.rejects(memory.privateUpdate({ exec: b.exec, libraryId: a.binding.libraryId, id: saved.id, visibility: 'secret' }), /not visible/)
  assert.equal(state.loadPrivateIndex(a.binding.libraryId).entries[saved.id].visibility, 'shared', 'an out-of-scope edit changes nothing')
  state.setSessionBinding('owner-b', { useLibrary: false })
  await assert.rejects(memory.privateList({ exec: b.exec }), /turned off/)
})

test('a read on an unbound conversation does not silently create a library', async () => {
  const before = state.listLibrariesAll().length
  const exec = { agent: { session: { header: { id: 'never-bound', cwd: path.join(home, 'new') } } } }
  await assert.rejects(memory.privateList({ exec }), /no bound session/)
  assert.equal(state.listLibrariesAll().length, before)
})

test('review acceptance replaces the old private fact in the same write and keeps its history', async () => {
  const { exec, binding } = session('review')
  const old = await memory.privateRemember({ exec, title: '会面地点', content: '明天在学校门口见面。' })
  const next = await memory.privateRemember({ exec, title: '会面地点', content: '明天改在市中心图书馆见面。' })
  await assert.rejects(memory.privateUpdate({ exec, id: next.id, status: 'active' }), /require review/)
  await rpc.dispatch({}, 'resolveReview', { libraryId: binding.libraryId, id: next.id, action: 'accept' })
  const index = state.loadPrivateIndex(binding.libraryId)
  assert.equal(index.entries[old.id].status, 'superseded')
  assert.equal(index.entries[old.id].content, old.entry.content)
  assert.equal(index.entries[old.id].validTo, index.entries[next.id].validFrom)
  const recalled = await memory.privateRecall({ exec, query: '会面地点', topK: 10, relevanceThreshold: 0 })
  assert.deepEqual(recalled.files.map(file => file.name), [next.id])
})

test('review coexistence needs conditions, and global acceptance retires the conflicting fact', async () => {
  state.saveGlobalIndex({ entries: {
    old: { title: 'old', content: 'old', status: 'active', domain: 'coding' },
    next: { title: 'new', content: 'new', status: 'pending_review', domain: 'coding', conflictingWith: 'old' },
  } })
  await assert.rejects(rpc.dispatch({}, 'resolveReview', { id: 'next', action: 'accept', resolution: 'coexist' }), /needs a reason/)
  await rpc.dispatch({}, 'resolveReview', { id: 'next', action: 'accept' })
  assert.equal(state.loadGlobalIndex().entries.old.status, 'superseded')
  state.saveGlobalIndex({ entries: {} })
})

test('global list obeys switches, status and conversation domain', async () => {
  const { exec } = session('global-gate')
  state.setSessionBinding('global-gate', { domain: 'rp' })
  state.saveGlobalIndex({ entries: {
    coding: { title: 'coding', domain: 'coding', status: 'active' },
    rp: { title: 'rp', domain: 'rp', status: 'active' },
    held: { title: 'held', domain: 'rp', status: 'pending_review' },
  } })
  assert.deepEqual((await memory.globalList({ exec })).files.map(file => file.name), ['rp'])
  state.setSessionBinding('global-gate', { useGlobal: false })
  await assert.rejects(memory.globalList({ exec }), /turned off/)
  state.saveGlobalIndex({ entries: {} })
})

test('anniversaries do not revive superseded or overdue drafts', () => {
  const { binding } = session('anniversary')
  state.savePrivateIndex(binding.libraryId, { entries: {
    old: { title: 'old', salientDate: '10-28', status: 'superseded' },
    due: { title: 'due', salientDate: '10-28', status: 'active', expiresAt: '2026-10-27T00:00:00Z' },
  } })
  assert.deepEqual(inject.buildAnniversary('anniversary', binding, new Date(2026, 9, 28)).ids, [])
})

test('Chinese negation does not turn sadness into a happy retrieval lens', () => {
  assert.ok(readMood('我今天不开心').valence < 0)
  assert.ok(readMood('我并不高兴').valence <= 0)
  assert.ok(readMood('他说“开心极了”，但我没有这种感觉。').valence <= 0)
})

test('domestic texture is once per day and band, and disabled for coding', () => {
  session('texture')
  const random = Math.random
  Math.random = () => 1
  try {
    assert.ok(inject.maybeTexture('texture', { habitsInjection: true }, new Date(2026, 9, 27, 10)))
    assert.equal(inject.maybeTexture('texture', { habitsInjection: true }, new Date(2026, 9, 27, 10)), null)
    assert.ok(inject.maybeTexture('texture', { habitsInjection: true }, new Date(2026, 9, 28, 10)))
    state.setSessionBinding('texture', { domainOverride: 'coding' })
    assert.equal(inject.maybeTexture('texture', { habitsInjection: true }, new Date(2026, 9, 29, 10)), null)
  } finally { Math.random = random }
})
