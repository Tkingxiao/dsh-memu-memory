import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memu-corpus-gate-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home
const state = await import('../lib/state.js')
const { privateRecall } = await import('../lib/memory.js')
test.after(() => { state.flushState(); fs.rmSync(home, { recursive: true, force: true }) })

for (const backend of ['agent', 'api', 'api-fallback']) {
  for (const [kind, hidden] of Object.entries({
    secret: { visibility: 'secret' },
    context: { context: { characterId: 'someone-else' } },
    never: { disclosure: 'never_say' },
    asked: { disclosure: 'only_if_asked' },
  })) {
    test('single-library ' + backend + ' excludes ' + kind + ' from BM25 statistics', async () => {
      const sessionId = backend + '-' + kind
      const cwd = path.join(home, sessionId)
      state.ensureSession(sessionId, { cwd })
      const libraryId = state.getSessionBinding(sessionId).libraryId
      state.updateSettings({ memoryBackend: backend === 'agent' ? 'agent' : 'api', vectorSource: 'api', crossLibraryRecall: false })
      const entries = {}
      const entry = (title, extra = {}) => ({ title, content: title, layer: 'long_term', status: 'active', createdAt: new Date().toISOString(), ...extra })
      entries['mem-target'] = entry('zxquartz')
      for (let i = 0; i < 7; i++) entries['mem-filler-' + i] = entry('unrelated' + i)
      state.savePrivateIndex(libraryId, { entries })
      const exec = { agent: { session: { header: { id: sessionId } } } }
      // Empty semantic results exercise the production mixed recall lexical leg.
      const recall = (query = 'zxquartz', purpose = 'automatic') => privateRecall({ exec, query, purpose, topK: 5, relevanceThreshold: 0, retrieveImpl: async () => { if (backend === 'api-fallback') throw new Error('simulated vector outage'); return { files: [] } } })
      const before = await recall()
      assert.equal(before.recallRoute, backend === 'api-fallback' ? 'local-fallback' : backend === 'api' ? 'managed-vector-rrf' : 'local')
      assert.deepEqual(before.files.map(f => f.name), ['mem-target'])
      for (let i = 0; i < 12; i++) entries['mem-hidden-' + i] = entry('zxquartz', hidden)
      state.savePrivateIndex(libraryId, { entries })
      const after = await recall()
      assert.equal(after.recallRoute, backend === 'api-fallback' ? 'local-fallback' : backend === 'api' ? 'managed-vector-rrf' : 'local')
      assert.deepEqual(after.files.map(f => f.name), ['mem-target'], 'ineligible documents must not prune the visible query term')
      if (backend === 'agent') assert.equal(after.files[0].lexical, before.files[0].lexical, 'visible corpus statistics stay unchanged')
      // Explicit exact-id reads retain their existing permission contract.
      if (kind !== 'context') {
        const exact = await recall('mem-hidden-0', 'explicit')
        assert.deepEqual(exact.files.map(f => f.name), ['mem-hidden-0'])
      }
    })
  }
}
