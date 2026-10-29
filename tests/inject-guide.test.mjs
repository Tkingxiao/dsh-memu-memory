import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The guide message is delivered through the real agent/pre-step hook, so this
// file exercises registerInjection({ guide: false, guideMessage: true }) exactly
// the way lib/preset-scope.js does for a preset conversation. Assertions land on
// real binding/library ids and on message.source.kind, not on labels alone.

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-guide-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const inject = await import('../lib/inject.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function mountGuide() {
  const entries = []
  const registered = []
  const logger = { warnings: [], warn(message) { this.warnings.push(String(message)) } }
  const ctx = {
    logger,
    inject() { registered.push('systemPrompt') },
    on(event, fn) {
      const entry = { event, fn }
      entries.push(entry)
      return () => {
        const index = entries.indexOf(entry)
        if (index >= 0) entries.splice(index, 1)
      }
    },
  }
  inject.registerInjection(ctx, { guide: false, guideMessage: true })
  const pre = entries.find((entry) => entry.event === 'agent/pre-step')
  assert.ok(pre, 'registerInjection must register an agent/pre-step listener')
  assert.deepEqual(registered, [], 'guide:false must not register system prompt sections')
  return {
    ctx,
    logger,
    entries,
    run(payload, decision) { return pre.fn(payload, async () => decision) },
  }
}

function makeTurn(sessionId, options = {}) {
  const {
    cwd = home,
    agentPreset = 'coding',
    origin = 'user',
    step = 1,
    turn = 1,
    text = 'please continue with the earlier context of this task',
  } = options
  const user = {
    id: sessionId + '-user-' + turn,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
  const decision = { kind: 'enter', messages: [user] }
  const agent = { session: { header: { id: sessionId, cwd, agentPreset, origin } } }
  const payload = { agent, turn, step, signal: { aborted: false } }
  return { user, decision, payload }
}

function seedPinned(binding, id, title) {
  const index = state.loadPrivateIndex(binding.libraryId)
  index.entries[id] = {
    track: 'memory',
    layer: 'must_remember',
    title,
    content: 'pinned detail for ' + id,
    status: 'active',
    pinReason: 'test fixture',
    pinSource: 'user_explicit',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  state.savePrivateIndex(binding.libraryId, index)
}

function pluginMessages(messages) {
  return (messages || []).filter((message) => message?.role === 'user' && message?.source?.kind === 'plugin:' + inject.PLUGIN)
}

function guideMessages(messages) {
  return pluginMessages(messages).filter((message) => String(message?.content?.[0]?.text || '').includes('<memory-guide>'))
}

function texts(messages) {
  return pluginMessages(messages).map((message) => String(message?.content?.[0]?.text || '')).join('\n')
}

test('the guide is delivered once on the first step, then never again in that session', async () => {
  const sessionId = 'guide-first-step'
  const cwd = path.join(home, 'project-guide-first')
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  seedPinned(binding, 'mem-guide-pinned', 'Guide pin')
  const mounted = mountGuide()

  const first = makeTurn(sessionId, { cwd })
  const firstOut = await mounted.run(first.payload, first.decision)
  const firstGuides = guideMessages(firstOut.messages)
  assert.equal(firstGuides.length, 1)
  assert.match(String(firstGuides[0].content[0].text), /^<memory-guide>/)
  assert.equal(firstGuides[0].source.form, 'recall')
  assert.ok(texts(firstOut.messages).includes('[mem-guide-pinned]'), 'the anchor must carry the real private id')
  assert.equal(firstOut.messages.filter((message) => message.source?.kind === 'user').length, 1)
  assert.equal(firstOut.messages.find((message) => message.source?.kind === 'user').id, first.user.id)
  assert.equal(firstOut.messages[firstOut.messages.length - 1], firstGuides[0])

  const stamped = state.getSessionBinding(sessionId)
  assert.ok(stamped.guideMessageAt, 'the once-only flag is written after delivery')
  assert.equal(stamped.lastRecallError, undefined)

  const second = makeTurn(sessionId, { cwd, turn: 2 })
  const secondOut = await mounted.run(second.payload, second.decision)
  assert.equal(guideMessages(secondOut.messages).length, 0)
  // Other plugin messages (texture/cue) are legitimate on later turns; the contract
  // here is only that the guide is not delivered again.
  assert.equal(secondOut.messages.filter((message) => message.source?.kind === 'plugin:' + inject.PLUGIN
    && String(message.content?.[0]?.text || '').includes('<memory-guide>')).length, 0)
  assert.equal(secondOut.messages.find((message) => message.source?.kind === 'user'), second.user)
  assert.equal(state.getSessionBinding(sessionId).guideMessageAt, stamped.guideMessageAt)
})

test('a normal tool step never receives the guide', async () => {
  const sessionId = 'guide-tool-step'
  const cwd = path.join(home, 'project-guide-step')
  state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const mounted = mountGuide()

  const { payload, decision } = makeTurn(sessionId, { cwd, step: 2 })
  const out = await mounted.run(payload, decision)
  assert.equal(out, decision)
  assert.equal(guideMessages(out.messages).length, 0)
  assert.equal(state.getSessionBinding(sessionId).guideMessageAt, undefined)
})

test('different sessions deliver independently', async () => {
  const cwd = path.join(home, 'project-guide-pair')
  const sessionA = 'guide-session-a'
  const sessionB = 'guide-session-b'
  const bindingA = state.ensureSession(sessionA, { cwd, agentPreset: 'coding' })
  state.ensureSession(sessionB, { cwd, agentPreset: 'coding' })
  seedPinned(bindingA, 'mem-guide-shared', 'Shared pin')
  const mounted = mountGuide()

  const turnA = makeTurn(sessionA, { cwd })
  const turnB = makeTurn(sessionB, { cwd })
  const outA = await mounted.run(turnA.payload, turnA.decision)
  const outB = await mounted.run(turnB.payload, turnB.decision)
  assert.equal(guideMessages(outA.messages).length, 1)
  assert.equal(guideMessages(outB.messages).length, 1)
  assert.ok(texts(outA.messages).includes('[mem-guide-shared]'))
  assert.ok(texts(outB.messages).includes('[mem-guide-shared]'), 'the same library id reaches both sessions')
  assert.ok(state.getSessionBinding(sessionA).guideMessageAt)
  assert.ok(state.getSessionBinding(sessionB).guideMessageAt)

  const again = makeTurn(sessionA, { cwd, turn: 2 })
  const againOut = await mounted.run(again.payload, again.decision)
  assert.equal(guideMessages(againOut.messages).length, 0)
  assert.equal(guideMessages(outB.messages).length, 1, 'the other session keeps its own once-only state')
})

test('subagent conversations never receive the guide', async () => {
  const sessionId = 'guide-subagent'
  const cwd = path.join(home, 'project-guide-sub')
  state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const mounted = mountGuide()

  const { payload, decision } = makeTurn(sessionId, { cwd, origin: 'subagent' })
  const out = await mounted.run(payload, decision)
  assert.equal(out, decision)
  assert.equal(guideMessages(out.messages).length, 0)
  assert.equal(state.getSessionBinding(sessionId).guideMessageAt, undefined)
})

test('disabling memory blocks the guide and does not consume the once-only flag', async () => {
  const sessionId = 'guide-disabled'
  const cwd = path.join(home, 'project-guide-disabled')
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  seedPinned(binding, 'mem-guide-disabled', 'Disabled pin')
  const mounted = mountGuide()
  const before = state.getSettings().autoInject

  state.updateSettings({ autoInject: 'off' })
  try {
    const turn = makeTurn(sessionId, { cwd })
    const offOut = await mounted.run(turn.payload, turn.decision)
    assert.equal(offOut, turn.decision)
    assert.equal(guideMessages(offOut.messages).length, 0)
    assert.equal(state.getSessionBinding(sessionId).guideMessageAt, undefined, 'a disabled scope must not be marked as delivered')
  } finally {
    state.updateSettings({ autoInject: before })
  }

  const retry = makeTurn(sessionId, { cwd, turn: 2 })
  const retryOut = await mounted.run(retry.payload, retry.decision)
  assert.equal(guideMessages(retryOut.messages).length, 1, 're-enabling memory must still deliver the guide once')
  assert.ok(state.getSessionBinding(sessionId).guideMessageAt)
})

test('a folder with memory switched off blocks the guide too', async () => {
  const sessionId = 'guide-folder-off'
  const cwd = path.join(home, 'project-guide-folder')
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  assert.equal(binding.scopeKey, state.normalizeCwd(cwd))
  assert.equal(state.effectiveScope(binding).enabled, true)
  state.setWorkspacePolicy(cwd, { useLibrary: false, useGlobal: false })
  try {
    const mounted = mountGuide()
    const turn = makeTurn(sessionId, { cwd })
    const out = await mounted.run(turn.payload, turn.decision)
    assert.equal(guideMessages(out.messages).length, 0)
    assert.equal(state.getSessionBinding(sessionId).guideMessageAt, undefined)
  } finally {
    state.setWorkspacePolicy(cwd, { useLibrary: true, useGlobal: true })
  }
})

test('the guide is an added plugin message; the original user turn is untouched', async () => {
  const sessionId = 'guide-preserve'
  const cwd = path.join(home, 'project-guide-preserve')
  state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const mounted = mountGuide()

  const assistant = { id: 'assistant-before', role: 'assistant', content: [{ type: 'text', text: 'earlier reply' }] }
  const user = { id: 'user-keep', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'the original words' }] }
  const decision = { kind: 'enter', messages: [assistant, user] }
  const payload = { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding', origin: 'user' } } }, turn: 1, step: 1, signal: { aborted: false } }
  const out = await mounted.run(payload, decision)

  assert.deepEqual(out.messages.filter((message) => message.id === 'user-keep'), [user])
  const guides = guideMessages(out.messages)
  assert.equal(guides.length, 1)
  assert.notEqual(guides[0].id, user.id)
  assert.equal(out.messages[out.messages.length - 1], guides[0], 'the guide is appended, not substituted')
  assert.equal(guides[0].source.kind, 'plugin:' + inject.PLUGIN)
  const allText = texts(out.messages)
  assert.ok(allText.includes('若本会话的工具列表里没有 memu_* 工具'), 'the message states its own tool caveat')
})
