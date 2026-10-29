import { test } from 'node:test'
import assert from 'node:assert/strict'

const memory = await import('../lib/memory.js')

function entry(overrides = {}) {
  return { status: 'active', title: 'memory', content: 'memory body', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...overrides }
}

function indexOf(entries) {
  return { entries }
}

test('RRF keeps one canonical id when both routes find it and preserves the best order', () => {
  const index = indexOf({
    'mem-a': entry({ title: 'alpha' }),
    'mem-b': entry({ title: 'beta' }),
    'mem-c': entry({ title: 'gamma' }),
  })
  const fused = memory.fuseRecallCandidates({
    local: [{ name: 'mem-a' }, { name: 'mem-b' }],
    semantic: [{ name: 'mem-b.md' }, { name: 'mem-c' }],
    index,
    limit: 12,
  })
  assert.deepEqual(fused.files.map((file) => file.name), ['mem-b', 'mem-a', 'mem-c'])
  assert.equal(fused.files[0].retrievalScore, 1)
  assert.deepEqual(fused.files[0].fusion.routes, ['local', 'semantic'])
  assert.equal(fused.debug.shared, 1)
  assert.equal(fused.debug.localOnly, 1)
  assert.equal(fused.debug.semanticOnly, 1)
  assert.equal(fused.debug.fused, 3)
})

test('duplicate names within one route cannot double-score or consume a candidate slot', () => {
  const index = indexOf({ 'mem-a': entry({ title: 'alpha' }), 'mem-b': entry({ title: 'beta' }) })
  const fused = memory.fuseRecallCandidates({
    local: [{ name: 'mem-a' }, { name: 'mem-a.md' }, { name: 'mem-b' }],
    semantic: [],
    index,
    limit: 2,
  })
  assert.deepEqual(fused.files.map((file) => file.name), ['mem-a', 'mem-b'])
  assert.equal(fused.debug.localCandidates, 2)
  const first = fused.files.find((file) => file.name === 'mem-a')
  assert.equal(first.fusion.rrf, 1 / 61)
  assert.equal(first.fusion.bestRank, 1)
  assert.equal(first.fusion.localRank, 1)
})

test('eligibility and context are applied before the candidate cap', () => {
  const index = indexOf({
    'mem-pending': entry({ status: 'pending_review' }),
    'mem-secret': entry({ visibility: 'secret' }),
    'mem-ok': entry({ title: 'ok' }),
  })
  const fused = memory.fuseRecallCandidates({
    local: [{ name: 'mem-pending' }, { name: 'mem-secret' }, { name: 'mem-ok' }],
    semantic: [{ name: 'mem-secret' }],
    index,
    limit: 12,
    automatic: true,
  })
  assert.deepEqual(fused.files.map((file) => file.name), ['mem-ok'])
  assert.equal(fused.debug.localCandidates, 1)
  assert.equal(fused.debug.semanticCandidates, 0)
})

test('the per-route candidate cap is bounded and deterministic', () => {
  const entries = {}
  const local = []
  for (let i = 0; i < 60; i += 1) {
    const id = 'mem-' + String(i).padStart(2, '0')
    entries[id] = entry({ title: 'memory ' + i })
    local.push({ name: id })
  }
  assert.equal(memory.hybridCandidateLimit(1), 12)
  assert.equal(memory.hybridCandidateLimit(3), 12)
  assert.equal(memory.hybridCandidateLimit(8), 32)
  assert.equal(memory.hybridCandidateLimit(50), 40)
  const fused = memory.fuseRecallCandidates({ local, semantic: [], index: indexOf(entries), limit: memory.hybridCandidateLimit(3) })
  assert.equal(fused.files.length, 12)
  assert.deepEqual(fused.files.map((file) => file.name), local.slice(0, 12).map((file) => file.name).sort((a, b) => a.localeCompare(b)))
})

test('equal fused scores fall back to the best rank and then the canonical id', () => {
  const index = indexOf({ 'mem-a': entry(), 'mem-b': entry() })
  const first = memory.fuseRecallCandidates({ local: [{ name: 'mem-a' }], semantic: [{ name: 'mem-b' }], index })
  const second = memory.fuseRecallCandidates({ local: [{ name: 'mem-a' }], semantic: [{ name: 'mem-b' }], index })
  assert.deepEqual(first.files.map((file) => file.name), ['mem-a', 'mem-b'])
  assert.deepEqual(first.files.map((file) => file.name), second.files.map((file) => file.name))
})
