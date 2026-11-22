import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-pending-'))
process.env.DSH_HOME = home
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const state = await import('../lib/state.js')
const inject = await import('../lib/inject.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

const digestOf = (message) => crypto.createHash('sha256').update(JSON.stringify(message?.content ?? null)).digest('hex')
const NOW = () => new Date().toISOString()

function seed(sessionId, entryId) {
  const cwd = path.join(home, sessionId)
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const index = state.loadPrivateIndex(binding.libraryId)
  index.entries[entryId] = {
    track: 'memory', layer: 'long_term', title: '部署脚本', content: '部署脚本放在 tools/deploy.ps1。',
    status: 'active', confidence: 0.9, createdAt: NOW(), updatedAt: NOW(),
  }
  state.savePrivateIndex(binding.libraryId, index)
  const user = { id: 'u-' + sessionId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '部署脚本放在哪里？' }] }
  const agent = { session: { header: { id: sessionId, cwd, agentPreset: 'coding', origin: 'user' } } }
  return { agent, user }
}

test('a proposal leaves a digest credential so another process can still finish the admission', async () => {
  const sessionId = 'pending-cred'
  const { agent, user } = seed(sessionId, 'mem-cred')
  const out = await inject.injectForStep({ agent, decision: { kind: 'enter', messages: [user] }, turn: 1, step: 1, signal: { aborted: false } })
  const plugin = out.messages.find((message) => message?.source?.kind === 'plugin:dsh-memu-memory')
  assert.ok(plugin, 'a plugin message is proposed on the first step')
  const credentials = state.getSessionBinding(sessionId).pendingInjections || []
  assert.equal(credentials.length, 1, 'exactly one credential is persisted')
  assert.equal(credentials[0].digest, digestOf(plugin))
  assert.equal(state.findPendingInjection(sessionId, digestOf(plugin))?.messageId, plugin.id)
  assert.ok(credentials[0].refs.length >= 1, 'the credential carries the refs needed to commit')
})

test('turn end invalidates the credential so a late identical message cannot revive a discarded proposal', async () => {
  const sessionId = 'pending-drop'
  const { agent, user } = seed(sessionId, 'mem-drop')
  const handlers = new Map()
  const ctx = { on (name, handler) { handlers.set(name, handler); return () => {} }, logger: { warn () {} }, inject () {} }
  inject.registerInjection(ctx)
  const out = await inject.injectForStep({ agent, decision: { kind: 'enter', messages: [user] }, turn: 1, step: 1, signal: { aborted: false } })
  const plugin = out.messages.find((message) => message?.source?.kind === 'plugin:dsh-memu-memory')
  const digest = digestOf(plugin)
  assert.ok(state.findPendingInjection(sessionId, digest), 'credential exists while the turn is open')
  await handlers.get('session/event')({ header: { id: sessionId } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(state.findPendingInjection(sessionId, digest), null, 'a closed turn leaves nothing to revive')
  assert.deepEqual(state.getSessionBinding(sessionId).pendingInjections ?? [], [])
})

test('digest credentials expire after the TTL and the freshest same-digest match wins', () => {
  const sessionId = 'pending-ttl'
  state.ensureSession(sessionId, { cwd: path.join(home, sessionId) })
  const stale = { digest: 'd-1', messageId: 'm-stale', turn: 0, clock: 0, at: new Date(Date.now() - 31 * 60_000).toISOString() }
  const old = { digest: 'd-1', messageId: 'm-old', turn: 1, clock: 1, at: new Date(Date.now() - 5 * 60_000).toISOString() }
  const fresh = { digest: 'd-1', messageId: 'm-fresh', turn: 2, clock: 2, at: new Date().toISOString() }
  state.setSessionBinding(sessionId, { pendingInjections: [stale, old, fresh] })
  assert.equal(state.findPendingInjection(sessionId, 'd-1').messageId, 'm-fresh', 'the newest same-digest credential wins')
  state.setSessionBinding(sessionId, { pendingInjections: [stale] })
  assert.equal(state.findPendingInjection(sessionId, 'd-1'), null, 'a 31-minute credential is dead')
  state.rememberPendingInjection(sessionId, { digest: 'd-2', messageId: 'm-new', turn: 9, clock: 9 })
  const rows = state.getSessionBinding(sessionId).pendingInjections
  assert.deepEqual(rows.map(row => row.messageId), ['m-new'], 'remembering prunes the expired credential')
})

test('a cross-process admission commits once, forgets its own credential, and re-observation is quiet', async () => {
  const sessionId = 'pending-store-admit'
  seed(sessionId, 'mem-store')
  const binding = state.getSessionBinding(sessionId)
  // 模拟另一个进程投出的同内容锚点：本进程 Map 里没有提案，只有落盘凭据。
  const lateMessage = { id: 'late-1', role: 'user', source: { kind: 'plugin:dsh-memu-memory' },
    content: [{ type: 'text', text: '===== memory anchor =====\nstore-path fixture' }] }
  state.setSessionBinding(sessionId, { pendingInjections: [{
    digest: digestOf(lateMessage), messageId: 'm-store-cred', turn: 42, clock: 3,
    generation: Number(binding.scopeGeneration || 0), epoch: Number(binding.injectionEpoch || 0),
    refs: [{ scope: 'private', libraryId: binding.libraryId, id: 'mem-store', revision: 'rev-1' }],
    actions: { patch: {} }, at: new Date().toISOString(),
  }] })
  const warns = []
  const handlers = new Map()
  const ctx = { on (name, handler) { handlers.set(name, handler); return () => {} }, logger: { warn: (m) => warns.push(String(m)) }, inject () {} }
  inject.registerInjection(ctx)
  const session = { header: { id: sessionId } }
  await handlers.get('session/event')(session, { type: 'user/message', data: lateMessage })
  const admitted = state.getSessionBinding(sessionId).acceptedMemoryMessages || []
  assert.equal(admitted.length, 1, 'the credential admission commits exactly once')
  assert.equal(admitted[0].messageId, 'late-1')
  assert.equal((state.getSessionBinding(sessionId).pendingInjections || []).length, 0,
    'the credential is forgotten by its own messageId, not the observed id')
  await handlers.get('session/event')(session, { type: 'user/message', data: lateMessage })
  assert.equal((state.getSessionBinding(sessionId).acceptedMemoryMessages || []).length, 1, 'the second observation neither re-commits')
  assert.equal(warns.filter(w => w.includes('未被接纳')).length, 0, 'nor warns — an admitted message observed twice is a success')
})
