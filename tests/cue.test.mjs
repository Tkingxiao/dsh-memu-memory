import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-cue-'))
process.env.DSH_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const inject = await import('../lib/inject.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

test('random cue is injected once and armed', async () => {
  state.updateSettings({ randomCueChance: 1 })
  const cwd = path.join(home, 'project-cue')
  state.ensureSession('cue-session', { cwd, agentPreset: 'rp' })
  const user = {
    id: 'u-cue', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '今天发生了什么，你还记得吗？' }],
  }
  const decision = { kind: 'enter', messages: [user] }
  const agent = { session: { header: { id: 'cue-session', cwd, agentPreset: 'rp' }, messages: [] } }
  const handlers = new Map()
  const ctx = { logger: { warn() {} }, on(event, fn) { handlers.set(event, fn); return () => {} } }
  inject.registerInjection(ctx)
  const sessionEvent = handlers.get('session/event')
  assert.equal(typeof sessionEvent, 'function')
  const out = await inject.injectForStep({ agent, decision, turn: 2, step: 1, signal: { aborted: false }, ctx })
  const pluginMessage = out.messages.find(message => message?.source?.kind === 'plugin:dsh-memu-memory')
  const text = pluginMessage?.content?.[0]?.text || ''
  assert.ok(text.includes('<memory-cue id="'))
  assert.equal(state.getActiveCue('cue-session'), null, 'a proposal must not arm the cue')
  for (const message of out.messages) {
    assert.ok(message.id && message.role === 'user', 'Native DSL requires an identified UserMessage')
    if (!agent.session.messages.some(item => item.id === message.id)) agent.session.messages.push(message)
    await sessionEvent(agent.session, { type: 'user/message', data: message })
  }
  const active = state.getActiveCue('cue-session')
  assert.ok(active && active.id)

  const again = await inject.injectForStep({ agent, decision, turn: 3, step: 1, signal: { aborted: false } })
  const textAgain = again.messages?.[0]?.content?.[0]?.text || ''
  assert.ok(!textAgain.includes('<memory-cue id="'))
  assert.equal(state.consumeCue('cue-session', active.id), true)
  assert.equal(state.getActiveCue('cue-session'), null)
})

test('makeCue returns a stable shape', () => {
  const cue = inject.makeCue()
  assert.match(cue.id, /^cue-/)
  assert.ok(cue.text.length > 0)
  assert.ok(inject.CUE_TEXTS.includes(cue.text))
})
