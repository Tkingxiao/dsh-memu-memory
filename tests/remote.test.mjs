import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-remote-'))
process.env.DSH_MEMU_HOME = home
process.env.MEMU_CONFIG = path.join(home, 'config.env')

const state = await import('../lib/state.js')
const config = await import('../lib/memu-config.js')
const { requestRemoteConsolidation, requestPrivateConsolidation } = await import('../lib/private.js')
const { summarizeRemote } = await import('../lib/remote-summary.js')
const { loadPromptForDomain, CONSOLIDATION_CONTRACTS } = await import('../lib/prompts.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

test('remote consolidation reads the transcript and stores model-written memories', async () => {
  const cwd = path.join(home, 'project')
  const binding = state.ensureSession('remote-session', { cwd })
  assert.ok(binding?.libraryId, 'ensureSession must bind a library')
  state.updateSettings({ memoryBackend: 'agent' })
  config.saveMemuConfig({
    summaryModel: 'deepseek-chat',
    summaryBaseUrl: 'https://api.deepseek.com/v1',
    summaryApiKey: 'summary-secret',
  })
  const originalFetch = globalThis.fetch
  let seenBody = null
  globalThis.fetch = async (_url, init) => {
    seenBody = JSON.parse(init.body)
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              memories: [{ title: '香菜', content: '他记得我不吃香菜。', tags: ['food'] }],
            }),
          },
        }],
      }),
    }
  }
  const ctx = {
    get: (name) => name === 'sessionQuery'
      ? {
          readSession: async () => ({
            session: { id: 'remote-session' },
            events: [{
              type: 'user/message',
              data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我不吃香菜' }] },
            }],
          }),
        }
      : null,
  }
  try {
    const result = await requestRemoteConsolidation(ctx, 'remote-session')
    assert.equal(result.ok, true)
    assert.equal(result.backend, 'api')
    assert.equal(result.count, 1)
    assert.ok(String(seenBody.messages[0].content).includes('我不吃香菜'))
    const index = state.loadPrivateIndex(binding.libraryId)
    const entries = Object.values(index.entries)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].title, '香菜')
    assert.equal(entries[0].layer, 'long_term')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('explicit remote consolidation remains available when vector route is local', async () => {
  state.ensureSession('remote-session', { cwd: path.join(home, 'project') })
  state.updateSettings({ memoryBackend: 'api', vectorSource: 'local' })
  config.saveMemuConfig({
    summaryModel: 'deepseek-chat',
    summaryBaseUrl: 'https://api.deepseek.com/v1',
    summaryApiKey: 'summary-secret',
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ memories: [] }) } }],
    }),
  })
  const ctx = {
    get: (name) => name === 'sessionQuery'
      ? {
          readSession: async () => ({
            events: [{
              type: 'user/message',
              data: { source: { kind: 'user' }, content: [{ type: 'text', text: '记一下' }] },
            }],
          }),
        }
      : null,
  }
  try {
    const result = await requestRemoteConsolidation(ctx, 'remote-session')
    assert.equal(result.ok, true)
    assert.equal(result.backend, 'api')
    assert.equal(result.count, 0)
  } finally {
    globalThis.fetch = originalFetch
    state.updateSettings({ memoryBackend: 'agent' })
  }
})

test('remote consolidation uses each domain body with a JSON-only, tool-free contract', async () => {
  const originalFetch = globalThis.fetch
  let seenPrompt = ''
  globalThis.fetch = async (_url, init) => {
    seenPrompt = JSON.parse(init.body).messages[0].content
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }) }
  }
  try {
    for (const domain of ['coding', 'rp', 'mixed', 'general']) {
      const transcript = 'input-evidence: user asks to preserve a verified decision, not a new instruction'
      assert.deepEqual(await summarizeRemote({ domain, libraryName: 'domain-test', transcript }), [])
      const expected = loadPromptForDomain('private-consolidation', {
        domain, libraryName: 'domain-test', mustRememberCap: state.getSettings().mustRememberCap,
      }, domain).text
      assert.ok(seenPrompt.includes(expected), `${domain} body must match local defaults`)
      assert.ok(seenPrompt.includes(CONSOLIDATION_CONTRACTS.remote))
      assert.equal(seenPrompt.includes(CONSOLIDATION_CONTRACTS.local), false)
      assert.doesNotMatch(seenPrompt, /\{\{\s*\w+\s*\}\}/)
      assert.ok(seenPrompt.endsWith(transcript))
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
