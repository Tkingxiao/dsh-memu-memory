import test from 'node:test'
import assert from 'node:assert/strict'

import { vectorGcCandidates } from '../lib/vector-profile.js'

const DAY = 86_400_000
const NOW = 1_800_000_000_000

test('vector GC keeps active/pending paths and the last N generations', () => {
  const old = NOW - 40 * DAY
  const files = [
    { file: 'global.aaaa.g1.sqlite3', generation: 1, bytes: 10, mtimeMs: old },
    { file: 'global.aaaa.g2.sqlite3', generation: 2, bytes: 10, mtimeMs: old },
    { file: 'global.aaaa.g3.sqlite3', generation: 3, bytes: 10, mtimeMs: old },
    { file: 'vector-ledger.aaaa.g1.json', generation: 1, bytes: 10, mtimeMs: old },
    { file: 'legacy.sqlite3', generation: null, bytes: 10, mtimeMs: old },
  ]
  const candidates = vectorGcCandidates({
    files, activeGeneration: 3, keepGenerations: 2, olderThanDays: 7, now: NOW,
  })
  assert.deepEqual(candidates.map((item) => item.file).sort(), [
    'global.aaaa.g1.sqlite3',
    'vector-ledger.aaaa.g1.json',
  ])

  const kept = vectorGcCandidates({
    files, activeGeneration: 3, keepGenerations: 2, olderThanDays: 7, now: NOW,
    keepPaths: ['global.aaaa.g1.sqlite3'],
  })
  assert.deepEqual(kept.map((item) => item.file), ['vector-ledger.aaaa.g1.json'])

  const recent = vectorGcCandidates({
    files: [{ file: 'global.aaaa.g1.sqlite3', generation: 1, bytes: 10, mtimeMs: NOW - DAY }],
    activeGeneration: 3, keepGenerations: 2, olderThanDays: 7, now: NOW,
  })
  assert.deepEqual(recent, [], 'a recent old generation is left for the retention window')
})
