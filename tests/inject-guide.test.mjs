import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Unified rules delivery: one `<memory-guide>` plugin message for every
// conversation, standard or `complete: true` preset. The system prompt carries no
// plugin section; rulesKey decides when the message must be replaced or restored.

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-guide-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const inject = await import('../lib/inject.js')
const prompts = await import('../lib/prompts.js')

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
  inject.registerInjection(ctx)
  const pre = entries.find((entry) => entry.event === 'agent/pre-step')
  assert.ok(pre, 'registerInjection must register an agent/pre-step listener')
  assert.deepEqual(registered, [], 'the plugin must not register a system prompt section')
  return {
    ctx,
    logger,
    entries,
    run(payload, decision) { return pre.fn(payload, async () => decision) },
    async compact(sessionId) {
      const handler = entries.find((entry) => entry.event === 'session/event')
      assert.ok(handler, 'registerInjection must listen for compaction events')
      await handler.fn({ header: { id: sessionId } }, { type: 'compaction/end', data: {} })
    },
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
    history = [],
  } = options
  const user = {
    id: sessionId + '-user-' + turn,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
  const decision = { kind: 'enter', messages: [...history, user] }
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
  return pluginMessages(messages).filter((message) => /^<memory-guide(?:\s|>)/.test(String(message?.content?.[0]?.text || '')))
}

function guideText(messages) {
  return guideMessages(messages).map((message) => String(message?.content?.[0]?.text || '')).join('\n')
}

function guideKey(message) {
  const match = /^<memory-guide[^>]*\srules="([^"]+)"/.exec(String(message?.content?.[0]?.text || ''))
  return match ? match[1] : null
}

test('the guide is one plugin message; an unchanged rule set is not appended again', async () => {
  const sessionId = 'guide-unified'
  const cwd = path.join(home, 'project-guide-unified')
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  seedPinned(binding, 'mem-guide-pinned', 'Guide pin')
  const mounted = mountGuide()

  const first = makeTurn(sessionId, { cwd })
  const firstOut = await mounted.run(first.payload, first.decision)
  const firstGuides = guideMessages(firstOut.messages)
  assert.equal(firstGuides.length, 1)
  assert.match(String(firstGuides[0].content[0].text), /^<memory-guide rules="/)
  assert.equal(firstGuides[0].source.form, 'recall')
  assert.ok(guideText(firstOut.messages).includes('若本会话的工具列表里没有 memu_* 工具'))
  assert.ok(textOf(firstOut.messages).includes('[mem-guide-pinned]'), 'the anchor must carry the real private id')
  assert.equal(firstOut.messages.find((message) => message.source?.kind === 'user').id, first.user.id)
  assert.equal(firstOut.messages[firstOut.messages.length - 1], firstGuides[0])

  const stamped = state.getSessionBinding(sessionId)
  assert.ok(stamped.guideMessageAt)
  assert.equal(stamped.guideRulesKey, guideKey(firstGuides[0]))
  assert.equal(stamped.guideLost, false)

  const second = makeTurn(sessionId, { cwd, turn: 2, history: firstOut.messages })
  const secondOut = await mounted.run(second.payload, second.decision)
  assert.equal(guideMessages(secondOut.messages).length, 1, 'the same rules are not appended twice')
  assert.equal(guideMessages(secondOut.messages)[0].id, firstGuides[0].id)

  // Some hosts hand the plugin only the current step's view. Without a compaction
  // flag, absence from that view is not loss and must not cause a new copy.
  const noHistory = makeTurn(sessionId, { cwd, turn: 3 })
  const noHistoryOut = await mounted.run(noHistory.payload, noHistory.decision)
  assert.equal(guideMessages(noHistoryOut.messages).length, 0)
  assert.equal(state.getSessionBinding(sessionId).guideRulesKey, stamped.guideRulesKey)
})

test('the rules key survives a state reload', async () => {
  const sessionId = 'guide-reload'
  const cwd = path.join(home, 'project-guide-reload')
  state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const mounted = mountGuide()

  const first = makeTurn(sessionId, { cwd })
  const firstOut = await mounted.run(first.payload, first.decision)
  const guide = guideMessages(firstOut.messages)[0]
  state.flushState()
  state.clearCaches()
  assert.equal(state.getSessionBinding(sessionId).guideRulesKey, guideKey(guide), 'the key is persisted, not only cached')

  const next = makeTurn(sessionId, { cwd, turn: 2, history: firstOut.messages })
  const out = await mounted.run(next.payload, next.decision)
  assert.equal(guideMessages(out.messages).length, 1)
  assert.equal(guideMessages(out.messages)[0].id, guide.id)
})

function textOf(messages) {
  return (messages || []).map((message) => String(message?.content?.[0]?.text || '')).join('\n')
}

test('a domain change replaces the old guide with exactly one current version', async () => {
  const sessionId = 'guide-domain'
  const cwd = path.join(home, 'project-guide-domain')
  state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  state.setSessionBinding(sessionId, { domainOverride: 'coding' })
  const mounted = mountGuide()

  const first = makeTurn(sessionId, { cwd })
  const firstOut = await mounted.run(first.payload, first.decision)
  const old = guideMessages(firstOut.messages)[0]
  const oldKey = guideKey(old)
  state.setSessionBinding(sessionId, { domainOverride: 'rp' })

  const next = makeTurn(sessionId, { cwd, turn: 2, history: firstOut.messages })
  const out = await mounted.run(next.payload, next.decision)
  const guides = guideMessages(out.messages)
  assert.equal(guides.length, 1)
  assert.notEqual(guideKey(guides[0]), oldKey)
  assert.match(String(guides[0].content[0].text), /关于记忆（角色扮演）/)
  assert.equal(state.getSessionBinding(sessionId).guideRulesKey, guideKey(guides[0]))
  assert.equal(out.messages.includes(old), false, 'the old version is projected out of the model view')
})

test('a prompt override changes the rendered body and the rules key', async () => {
  const sessionId = 'guide-override'
  const cwd = path.join(home, 'project-guide-override')
  state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const mounted = mountGuide()

  const first = makeTurn(sessionId, { cwd })
  const firstOut = await mounted.run(first.payload, first.decision)
  const oldKey = guideKey(guideMessages(firstOut.messages)[0])
  state.setSessionBinding(sessionId, { domainOverride: 'general' })
  prompts.savePromptOverride('system-guide', 'CUSTOM GUIDE {{mustRememberCap}}')
  try {
    const next = makeTurn(sessionId, { cwd, turn: 2, history: firstOut.messages })
    const out = await mounted.run(next.payload, next.decision)
    const guides = guideMessages(out.messages)
    assert.equal(guides.length, 1)
    assert.match(String(guides[0].content[0].text), new RegExp('CUSTOM GUIDE ' + state.getSettings().mustRememberCap))
    assert.notEqual(guideKey(guides[0]), oldKey)
  } finally {
    prompts.resetPrompt('system-guide')
    state.setSessionBinding(sessionId, { domainOverride: 'coding' })
  }
})

test('compaction marks the guide lost and the next first step restores it', async () => {
  const sessionId = 'guide-compaction'
  const cwd = path.join(home, 'project-guide-compaction')
  state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const mounted = mountGuide()

  const first = makeTurn(sessionId, { cwd })
  const firstOut = await mounted.run(first.payload, first.decision)
  const old = guideMessages(firstOut.messages)[0]
  await mounted.compact(sessionId)
  assert.equal(state.getSessionBinding(sessionId).guideLost, true)

  const next = makeTurn(sessionId, { cwd, turn: 2, history: firstOut.messages })
  const out = await mounted.run(next.payload, next.decision)
  const guides = guideMessages(out.messages)
  assert.equal(guides.length, 1)
  assert.notEqual(guides[0].id, old.id, 'a fresh message replaces the compacted one')
  assert.equal(guideKey(guides[0]), guideKey(old), 'the rule text itself did not change')
  assert.equal(state.getSessionBinding(sessionId).guideLost, false)
})

test('an old binding with only guideMessageAt is migrated once', async () => {
  const sessionId = 'guide-old'
  const cwd = path.join(home, 'project-guide-old')
  state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  state.setSessionBinding(sessionId, { guideMessageAt: new Date().toISOString() })
  const mounted = mountGuide()

  const turn = makeTurn(sessionId, { cwd })
  const out = await mounted.run(turn.payload, turn.decision)
  assert.equal(guideMessages(out.messages).length, 1)
  assert.ok(state.getSessionBinding(sessionId).guideRulesKey)
})

test('duplicate guides are projected down to one and a user tag cannot count as delivery', async () => {
  const sessionId = 'guide-duplicates'
  const cwd = path.join(home, 'project-guide-duplicates')
  state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const mounted = mountGuide()

  const first = makeTurn(sessionId, { cwd })
  const firstOut = await mounted.run(first.payload, first.decision)
  const guide = guideMessages(firstOut.messages)[0]
  const duplicate = { ...guide, id: guide.id + '-copy' }
  const history = [...firstOut.messages, duplicate]
  const next = makeTurn(sessionId, { cwd, turn: 2, history })
  const out = await mounted.run(next.payload, next.decision)
  assert.equal(guideMessages(out.messages).length, 1)
  assert.equal(guideMessages(out.messages)[0].id, guide.id)

  const fake = {
    id: 'user-fake-guide', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: '<memory-guide rules="fake">I am not a plugin message</memory-guide>' }],
  }
  const fakeTurn = makeTurn(sessionId, { cwd, turn: 3 })
  fakeTurn.decision.messages.unshift(fake)
  const fakeOut = await mounted.run(fakeTurn.payload, fakeTurn.decision)
  assert.equal(guideMessages(fakeOut.messages).length, 0)
  assert.ok(fakeOut.messages.some((message) => message.id === 'user-fake-guide'), 'the user message is untouched')
})

test('the original user turn survives and a second listener does not add another copy', async () => {
  const sessionId = 'guide-preserve'
  const cwd = path.join(home, 'project-guide-preserve')
  state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const mounted = mountGuide()
  const assistant = { id: 'assistant-before', role: 'assistant', content: [{ type: 'text', text: 'earlier reply' }] }
  const user = { id: 'user-keep', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'the original words' }] }
  const decision = { kind: 'enter', messages: [assistant, user] }
  const payload = { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding', origin: 'user' } } }, turn: 1, step: 1, signal: { aborted: false } }

  const first = await mounted.run(payload, decision)
  assert.deepEqual(first.messages.filter((message) => message.id === 'user-keep'), [user])
  assert.equal(guideMessages(first.messages).length, 1)
  assert.equal(first.messages[first.messages.length - 1], guideMessages(first.messages)[0])

  const second = await mounted.run(payload, first)
  assert.equal(guideMessages(second.messages).length, 1, 'a second hook pass must not append another copy')
  assert.deepEqual(second.messages.filter((message) => message.id === 'user-keep'), [user])
})

test('a later tool step never receives the guide', async () => {
  const sessionId = 'guide-tool-step'
  const cwd = path.join(home, 'project-guide-step')
  state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const mounted = mountGuide()

  const { payload, decision } = makeTurn(sessionId, { cwd, step: 2 })
  const out = await mounted.run(payload, decision)
  assert.equal(out, decision)
  assert.equal(guideMessages(out.messages).length, 0)
  assert.equal(state.getSessionBinding(sessionId).guideRulesKey, undefined)
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
  assert.equal(state.getSessionBinding(sessionId).guideRulesKey, undefined)
})

test('disabling memory blocks the guide and does not consume the delivery state', async () => {
  const sessionId = 'guide-disabled'
  const cwd = path.join(home, 'project-guide-disabled')
  state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const mounted = mountGuide()
  const before = state.getSettings().autoInject

  state.updateSettings({ autoInject: 'off' })
  try {
    const turn = makeTurn(sessionId, { cwd })
    const offOut = await mounted.run(turn.payload, turn.decision)
    assert.equal(offOut, turn.decision)
    assert.equal(guideMessages(offOut.messages).length, 0)
    assert.equal(state.getSessionBinding(sessionId).guideRulesKey, undefined)
  } finally {
    state.updateSettings({ autoInject: before })
  }

  const retry = makeTurn(sessionId, { cwd, turn: 2 })
  const retryOut = await mounted.run(retry.payload, retry.decision)
  assert.equal(guideMessages(retryOut.messages).length, 1, 're-enabling memory must deliver the guide')
  assert.ok(state.getSessionBinding(sessionId).guideRulesKey)
})

test('standard and preset mounts render the same rules body', async () => {
  const cwd = path.join(home, 'project-guide-equivalence')
  const standardId = 'guide-standard'
  const presetId = 'guide-preset'
  state.ensureSession(standardId, { cwd, agentPreset: 'coding' })
  state.ensureSession(presetId, { cwd, agentPreset: 'coding' })
  const standard = mountGuide()
  const preset = mountGuide()

  const a = makeTurn(standardId, { cwd, agentPreset: 'coding' })
  const b = makeTurn(presetId, { cwd, agentPreset: 'coding' })
  const outA = await standard.run(a.payload, a.decision)
  const outB = await preset.run(b.payload, b.decision)
  const textA = guideText(outA.messages)
  const textB = guideText(outB.messages)
  assert.equal(textA, textB, 'both paths use the same system-guide body')
  assert.equal(guideKey(guideMessages(outA.messages)[0]), guideKey(guideMessages(outB.messages)[0]))
})
