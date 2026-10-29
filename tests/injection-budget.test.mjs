import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-injection-budget-'))
process.env.DSH_MEMU_HOME = home

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
