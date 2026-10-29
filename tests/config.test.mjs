import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-config-'))
process.env.DSH_MEMU_HOME = home
process.env.MEMU_CONFIG = path.join(home, 'config.env')

const config = await import('../lib/memu-config.js')
const remote = await import('../lib/remote-summary.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

test('writes and reads embedding config without leaking the key', () => {
  const saved = config.saveMemuConfig({
    provider: 'jina',
    model: 'jina-embeddings-v3',
    baseUrl: 'https://api.jina.ai/v1',
    apiKey: 'secret-key',
  })
  assert.equal(saved.provider, 'jina')
  assert.equal(saved.model, 'jina-embeddings-v3')
  assert.equal(saved.hasKey, true)
  assert.ok(!JSON.stringify(saved).includes('secret-key'))
  const text = fs.readFileSync(process.env.MEMU_CONFIG, 'utf8')
  assert.ok(text.includes('MEMU_EMBED_PROVIDER=jina'))
  assert.ok(text.includes('MEMU_API_KEY=secret-key'))
})

test('clearKey removes the key', () => {
  config.saveMemuConfig({ clearKey: true })
  assert.equal(config.getMemuConfig().hasKey, false)
  const text = fs.readFileSync(process.env.MEMU_CONFIG, 'utf8')
  assert.ok(!text.includes('MEMU_API_KEY='))
})

test('source follows vectorSource independently of the saved API endpoint', async () => {
  const state = await import('../lib/state.js')
  state.updateSettings({ memoryBackend: 'api', vectorSource: 'api' })
  config.saveMemuConfig({ provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'custom-local-api' })
  assert.equal(config.getMemuConfig().source, 'api')
  assert.equal(state.effectiveVectorRoute(), 'remote-api')
  state.updateSettings({ vectorSource: 'local' })
  config.saveMemuConfig({ baseUrl: 'https://api.openai.com/v1' })
  assert.equal(config.getMemuConfig().source, 'local')
  assert.equal(state.effectiveVectorRoute(), 'managed-local')
})

test('local/api source round trips preserve the complete saved API configuration', async () => {
  const state = await import('../lib/state.js')
  config.saveMemuConfig({ provider: 'voyage', baseUrl: 'https://api.voyageai.com/v1', apiKey: 'keep-me', model: 'voyage-3' })
  const before = fs.readFileSync(process.env.MEMU_CONFIG, 'utf8')
  for (const source of ['local', 'api', 'local', 'remote']) {
    const normalized = source === 'remote' ? 'api' : source
    const after = config.setEmbeddingSource(source)
    assert.equal(after.source, normalized)
    assert.equal(state.getSettings().vectorSource, normalized)
    assert.equal(after.provider, 'voyage')
    assert.equal(after.baseUrl, 'https://api.voyageai.com/v1')
    assert.equal(after.model, 'voyage-3')
    assert.equal(after.hasKey, true)
    assert.ok(!JSON.stringify(after).includes('keep-me'))
    assert.equal(fs.readFileSync(process.env.MEMU_CONFIG, 'utf8'), before)
  }
})

test('an API localhost endpoint remains configured without a vendor key', () => {
  config.setEmbeddingSource('api')
  config.saveMemuConfig({
    provider: 'openai',
    model: 'custom-local-api',
    baseUrl: 'http://localhost:1234/v1',
    clearKey: true,
  })
  const local = config.getMemuConfig()
  assert.equal(local.source, 'api')
  assert.equal(local.baseUrl, 'http://localhost:1234/v1')
  assert.equal(local.hasKey, false)
})

test('an unknown source is rejected without modifying saved settings or configuration', async () => {
  const state = await import('../lib/state.js')
  const before = fs.readFileSync(process.env.MEMU_CONFIG, 'utf8')
  const source = state.getSettings().vectorSource
  assert.throws(() => config.setEmbeddingSource('sideways'), /local or api/)
  assert.equal(state.getSettings().vectorSource, source)
  assert.equal(fs.readFileSync(process.env.MEMU_CONFIG, 'utf8'), before)
})

test('storage mode follows the setting instead of being pinned to local', async () => {
  const state = await import('../lib/state.js')
  state.updateSettings({ memoryMode: 'cloud' })
  config.saveMemuConfig({ provider: 'openai' })
  assert.equal(config.getMemuConfig().mode, 'cloud')
  state.updateSettings({ memoryMode: 'local' })
  config.saveMemuConfig({ provider: 'openai' })
  assert.equal(config.getMemuConfig().mode, 'local')
})

test('summary config is stored and read without leaking its key', () => {
  config.saveMemuConfig({
    summaryModel: 'deepseek-chat',
    summaryBaseUrl: 'https://api.deepseek.com/v1/',
    summaryApiKey: 'summary-secret',
  })
  const summary = config.getSummaryConfig()
  assert.equal(summary.model, 'deepseek-chat')
  assert.equal(summary.baseUrl, 'https://api.deepseek.com/v1')
  assert.equal(summary.hasKey, true)
  assert.equal(summary.ready, true)
  assert.ok(!JSON.stringify(summary).includes('summary-secret'))
})

test('remote summary parses model-written memories from chat completions', async () => {
  config.saveMemuConfig({
    summaryModel: 'deepseek-chat',
    summaryBaseUrl: 'https://api.deepseek.com/v1',
    summaryApiKey: 'summary-secret',
  })
  const originalFetch = globalThis.fetch
  let seen = null
  globalThis.fetch = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              memories: [
                { title: '香菜', content: '他记得我不吃香菜。', tags: ['food'], open_loop: true, confidence: 0.7 },
                { title: '', content: '', tags: [] },
              ],
            }),
          },
        }],
      }),
    }
  }
  try {
    const memories = await remote.summarizeRemote({
      transcript: '用户说他不吃香菜', libraryName: '测试库', domain: 'general',
    })
    assert.equal(seen.url, 'https://api.deepseek.com/v1/chat/completions')
    assert.equal(seen.init.headers.authorization, 'Bearer summary-secret')
    assert.equal(seen.body.model, 'deepseek-chat')
    assert.equal(memories.length, 1)
    assert.equal(memories[0].title, '香菜')
    assert.equal(memories[0].openLoop, true)
    assert.equal(memories[0].confidence, 0.7)
  } finally {
    globalThis.fetch = originalFetch
  }
})
