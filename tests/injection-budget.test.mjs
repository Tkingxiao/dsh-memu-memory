import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-injection-budget-'))
process.env.DSH_HOME = home
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const state = await import('../lib/state.js')
const inject = await import('../lib/inject.js')
const budget = await import('../lib/budget.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function pluginMessages(messages) {
  return (messages || []).filter((message) => message?.role === 'user' && message?.source?.kind === 'plugin:' + inject.PLUGIN)
}

function pluginText(messages) {
  return pluginMessages(messages).map((message) => String(message?.content?.[0]?.text || '')).join('\n')
}

function seedRecallMemory(libraryId, layer = 'long_term') {
  const index = state.loadPrivateIndex(libraryId)
  const createdAt = new Date().toISOString()
  index.entries['mem-budget-recall'] = {
    track: 'memory',
    layer,
    title: 'deploy script',
    content: 'The deploy script lives in tools/deploy.ps1 and needs the staging token before the production rollout. ' +
      'Run tools/deploy.ps1 with the staging token first, then promote it to production after the smoke test passes. ' +
      'The deploy script logs to tools/deploy.log and refuses to run without the staging token.',
    status: 'active',
    confidence: 0.9,
    createdAt,
    updatedAt: createdAt,
    ...(layer === 'short_term' ? { expiresAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString() } : {}),
  }
  state.savePrivateIndex(libraryId, index)
}

function makeTurn(sessionId, { cwd, agentPreset, text }) {
  const user = { id: sessionId + '-u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
  const agent = { session: { header: { id: sessionId, cwd, agentPreset, origin: 'user' } } }
  return { agent, decision: { kind: 'enter', messages: [user] } }
}

test('turnTokens stays the recall budget while injectionTotalTokens gates the whole message', async () => {
  state.updateSettings({ turnTokens: 640, injectionTotalTokens: 2000, randomCueChance: 0, habitsInjection: false })
  const cwd = path.join(home, 'project-budget-total')
  const binding = state.ensureSession('budget-total', { cwd, agentPreset: 'coding' })
  seedRecallMemory(binding.libraryId, 'short_term')
  state.setSessionBinding('budget-total', { injectedIds: [inject.ANCHOR_SENTINEL] })
  const turn = makeTurn('budget-total', { cwd, agentPreset: 'coding', text: 'where does the deploy script live' })
  const out = await inject.injectForStep({ agent: turn.agent, decision: turn.decision, turn: 1, step: 1, signal: { aborted: false } })
  const text = pluginText(out.messages)
  const used = budget.estTokens(text)
  assert.ok(text.includes('[mem-budget-recall]'), text)
  assert.ok(used <= 2000, 'used ' + used)
  assert.ok(used <= 640 + 200, 'the recall block is capped by turnTokens, not the total: ' + used)
})

test('budget-omitted display callbacks never mark unseen entries, dates or nudges', async () => {
  const id = 'budget-callbacks'
  const cwd = path.join(home, id)
  const binding = state.ensureSession(id, { cwd, agentPreset: 'coding' })
  state.setSessionBinding(id, { useGlobal: false })
  const previous = state.getSettings()
  state.updateSettings({ autoInject: 'anchor-only', anchorTokens: 300, injectionTotalTokens: 300, randomCueChance: 0, habitsInjection: false })
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  state.updatePrivateIndex(binding.libraryId, index => {
    for (let i = 0; i < 16; i++) index.entries[`mem-callback-${i}`] = { title: `永久记忆 ${i}`, content: 'only the title may display', track: 'memory',
      layer: 'must_remember', status: 'active', strength: 1 - i / 20, createdAt: now.toISOString(), updatedAt: now.toISOString() }
    index.entries['mem-callback-due'] = { title: '到期承诺'.repeat(150), content: 'not displayed', track: 'memory', layer: 'long_term', status: 'active',
      salientDate: today, openLoop: true, createdAt: new Date(Date.now() - 5 * 86400000).toISOString(), updatedAt: now.toISOString() }
  })
  const turn = makeTurn(id, { cwd, agentPreset: 'coding', text: '请继续' })
  const out = await inject.injectForStep({ agent: turn.agent, decision: turn.decision, turn: 1, step: 1 })
  assert.ok(pluginMessages(out.messages).length > 0)
  assert.equal((state.getSessionBinding(id).acceptedMemoryMessages || []).length, 0, 'nothing accepted before append')
  const handlers = new Map()
  inject.registerInjection({ on: (topic, fn) => { handlers.set(topic, fn); return () => {} }, logger: { warn() {} } })
  turn.agent.session.messages = []
  for (const message of out.messages) {
    turn.agent.session.messages.push(message)
    await handlers.get('session/event')(turn.agent.session, { type: 'user/message', data: message })
  }
  const accepted = state.getSessionBinding(id)
  const text = pluginText(out.messages)
  assert.ok(budget.estTokens(text) <= 300)
  const refs = accepted.acceptedMemoryMessages.flatMap(record => record.refs)
  assert.ok(refs.length > 0 && refs.length < 16)
  for (const ref of refs) assert.ok(text.includes(`[${ref.id}]`))
  const entries = state.loadPrivateIndex(binding.libraryId).entries
  for (const [entryId, entry] of Object.entries(entries)) {
    assert.equal(Number(entry.injectCount || 0), refs.some(ref => ref.id === entryId) ? 1 : 0, `callback count follows displayed ${entryId}`)
  }
  assert.deepEqual(accepted.anniversariesShown || {}, {}, 'omitted date block never marks a day')
  assert.deepEqual(accepted.openLoopRemindedAt || {}, {}, 'omitted nudge never starts a cooldown')
  // A duplicate history notification cannot charge the display callbacks twice.
  for (const message of pluginMessages(out.messages)) await handlers.get('session/event')(turn.agent.session, { type: 'user/message', data: message })
  for (const ref of refs) assert.equal(state.loadPrivateIndex(binding.libraryId).entries[ref.id].injectCount, 1)
  state.updateSettings(previous)
})

test('anchor uses one atomic shared conflict group across pin/core partitions', () => {
  const id = 'budget-anchor-conflict'
  const binding = state.ensureSession(id, { cwd: path.join(home, id), agentPreset: 'coding' })
  state.setSessionBinding(id, { useGlobal: false })
  state.updatePrivateIndex(binding.libraryId, index => {
    index.entries['mem-group-pin'] = { title: '部署使用旧路径', content: 'old body', status: 'active', layer: 'must_remember', conflicts_with: 'mem-group-core' }
    index.entries['mem-group-core'] = { title: '部署使用新路径', content: 'new body', status: 'active', layer: 'long_term', conflicts_with: 'mem-group-pin' }
  })
  const anchor = inject.buildAnchor(state.getSessionBinding(id), { ...state.getSettings(), anchorTokens: 2000 }, id)
  assert.match(anchor.text, /冲突/)
  assert.match(anchor.text, /未确认哪版为准/)
  assert.equal((anchor.text.match(/\[mem-group-pin\]/g) || []).length, 1)
  assert.equal((anchor.text.match(/\[mem-group-core\]/g) || []).length, 1)
  assert.equal(anchor.refs.length, 2)
  assert.equal(anchor.refs[0].groupKey, anchor.refs[1].groupKey)
  assert.equal(anchor.refs[0].groupRevision, anchor.refs[1].groupRevision)
  const tiny = inject.buildAnchor(state.getSessionBinding(id), { ...state.getSettings(), anchorTokens: 160 }, id)
  assert.equal(tiny.text.includes('[mem-group-pin]'), tiny.text.includes('[mem-group-core]'), 'a budget cannot publish a single certain side')
})

test('accepted replay restores context without renewing typed cooldown or inject callbacks', async () => {
  const id = 'budget-replay-cooldown'
  const cwd = path.join(home, id)
  const binding = state.ensureSession(id, { cwd, agentPreset: 'coding' })
  const memoryId = 'mem-replay-' + 'x'.repeat(140)
  const entry = { title: '旧记忆', content: 'already shown body', status: 'active', layer: 'must_remember' }
  state.updatePrivateIndex(binding.libraryId, index => { index.entries[memoryId] = entry })
  const { memoryRef } = await import('../lib/paths.js')
  state.setSessionBinding(id, { useGlobal: false })
  state.markInjectedRefs(id, [memoryRef({ scope: 'private', libraryId: binding.libraryId, id: memoryId, entry })], 1, { messageId: 'replay-original', hostTurn: 1 })
  state.setSessionBinding(id, { reinjectPending: true, replayIds: [memoryId] })
  // Pin partition is too small for the whole id, while the independent replay fits.
  const previous = state.getSettings()
  state.updateSettings({ anchorTokens: 160, injectionTotalTokens: 400, randomCueChance: 0, habitsInjection: false })
  try {
    const turn = makeTurn(id, { cwd, agentPreset: 'coding', text: '请继续' })
    const out = await inject.injectForStep({ agent: turn.agent, decision: turn.decision, turn: 2, step: 1 })
    assert.ok(pluginText(out.messages).includes('[replay'))
    assert.ok(pluginText(out.messages).includes(`[${memoryId}]`))
    assert.deepEqual(state.getSessionBinding(id).replayIds, [memoryId], 'a proposed replay does not consume its IDs')
    const handlers = new Map()
    inject.registerInjection({ on: (topic, fn) => { handlers.set(topic, fn); return () => {} }, logger: { warn() {} } })
    turn.agent.session.messages = []
    for (const message of out.messages) {
      turn.agent.session.messages.push(message)
      await handlers.get('session/event')(turn.agent.session, { type: 'user/message', data: message })
    }
    const after = state.getSessionBinding(id)
    assert.deepEqual(after.replayIds, [])
    assert.deepEqual(after.acceptedMemoryMessages.at(-1).refs, [], 'replay is not a fresh typed display')
    assert.equal(Number(state.loadPrivateIndex(binding.libraryId).entries[memoryId].injectCount || 0), 0)
    assert.deepEqual(state.recentMemoryRefs(after, 17, 16), [], 'the original cooldown expires at its original clock')
  } finally { state.updateSettings(previous) }
})
