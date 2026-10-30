import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'

// commitCuratorOutput regressions :
//   1. A held clone created by a target-changed conflict must NOT inherit the
//      vector stamp of the batch commit (the batch committed `id`, not heldId),
//      and membership must not count either the clone or the unindexed `id` row.
//   2. A global-index write failure after the batch commit must be compensated:
//      every committed name receives a forget, and partial/complete outcomes are
//      recorded to the activity log (compensation design, not a transaction).
//
// No engine, no download: './memu.js' is replaced before production modules
// load (same pattern as tests/managed-memory.test.mjs), and './state.js' is
// wrapped with a one-shot updateGlobalIndex failure switch. Everything else is
// the real module stack against a temp DSH_MEMU_HOME.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-curator-commit-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const backend = {
  commits: [],
  forgets: [],
  onCommit: null,
}
globalThis.__curatorCommitTest = {
  async commit(args) {
    const names = (args.payload?.recall_files || []).map((file) => file.name)
    backend.commits.push({ names, route: args.route, db: args.db })
    if (backend.onCommit) await backend.onCommit()
    return { ok: true }
  },
  async forget(args) {
    backend.forgets.push({ name: args.name, db: args.db })
    return { deleted: 1, segments: 1 }
  },
  async retrieve() { return { files: [], segments: [], resources: [], raw: null } },
  async listFiles() { return { recall_files: [], resources: [], raw: null } },
}

// One-shot failure switch on updateGlobalIndex; every other state.js export is
// forwarded to the real module (local exports shadow the star re-export).
const indexHook = { failNext: 0, thrown: [] }
globalThis.__curatorIndexHook = indexHook

const realStateUrl = new URL('../lib/state.js', import.meta.url).href
const realMemuUrl = new URL('../lib/memu.js', import.meta.url).href
const memuSource = 'const bridge = globalThis.__curatorCommitTest;'
  + 'export const commit = (args) => bridge.commit(args), forget = (args) => bridge.forget(args),'
  + 'retrieve = (args) => bridge.retrieve(args), listFiles = (args) => bridge.listFiles(args);'
const stateSource = [
  `import * as real from ${JSON.stringify(realStateUrl)}`,
  'const hook = globalThis.__curatorIndexHook',
  'export function updateGlobalIndex(mutator) {',
  '  if (hook.failNext > 0) { hook.failNext -= 1; const error = new Error("disk full (simulated index failure)"); hook.thrown.push(String(error.message)); throw error }',
  '  return real.updateGlobalIndex(mutator)',
  '}',
  `export * from ${JSON.stringify(realStateUrl)}`,
].join('\n')
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './memu.js') return { url: 'data:text/javascript,' + encodeURIComponent(memuSource), shortCircuit: true }
    if (specifier === './state.js') return { url: 'data:text/javascript,' + encodeURIComponent(stateSource), shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const catalog = await import('../lib/embedding-catalog.js')
const vp = await import('../lib/vector-profile.js')
const vm = await import('../lib/vector-migration.js')
const curator = await import('../lib/curator.js')
const state = await import('../lib/state.js')
const activity = await import('../lib/activity-log.js')

const BGE = 'bge-small-zh-v1.5-int8'
// A second resolvable catalog entry so switchProfile has a verified profile to
// activate (same fixture trick as tests/vector-migration.test.mjs).
const baseEntry = catalog.getEmbeddingModel(BGE)
const altEntry = JSON.parse(JSON.stringify(baseEntry))
altEntry.id = 'bge-small-zh-v1.5-int8-alt'
altEntry.displayName = 'BGE alternative revision (curator commit fixture)'
altEntry.sources.modelscope.revision = 'c'.repeat(40)
altEntry.profileFingerprint = catalog.profileFingerprint(altEntry)
const models = { [BGE]: baseEntry, [altEntry.id]: altEntry }
vp.setCatalogEntryResolver((id) => models[id] ?? null)

state.updateSettings({ memoryBackend: 'api', vectorSource: 'local' })

const TARGET = 'gmem-target'
const TARGET_ENTRY = {
  track: 'memory', domain: 'general', title: '部署窗口约定',
  content: '每周四凌晨两点到四点是固定的部署窗口，窗口内只允许灰度发布。',
  confidence: 0.9, status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  evidence: [{ sessionId: 'old', quote: 'old quote' }],
}

function seedGlobalIndex(entries = {}) {
  state.saveGlobalIndex({ version: 1, entries: structuredClone(entries) })
}

async function activateVectorGeneration() {
  // In-memory stand-in for the sqlite vector store so the migration readback
  // (syncShadow verifies committed items via listFiles) is faithful.
  const dbs = new Map()
  const rowsOf = (db) => {
    if (!dbs.has(db)) dbs.set(db, new Map())
    return dbs.get(db)
  }
  const migrator = vm.createVectorMigrator({
    async listLibraries() { return [] },
    // membership() 的戳腿/账本腿读的是真实索引；这里直接转发到真 state.js。
    loadIndex(libraryId) {
      return libraryId ? state.loadPrivateIndex(libraryId) : state.loadGlobalIndex()
    },
    async commit({ db, item }) { rowsOf(db).set(item.id, item.text) },
    async forget({ db, itemId }) { rowsOf(db).delete(itemId) },
    async listFiles({ db }) { return [...rowsOf(db).keys()] },
    async smoke() { return { ok: true, checks: ['dimension=512'] } },
  })
  const switched = await migrator.switchProfile({ profile: BGE })
  assert.ok(['switched', 'already-active'].includes(switched.status), 'an active generation must be available')
  return { migrator, generation: switched.generation }
}

test.after(async () => {
  try { hooks.unregister?.() } catch {}
  vp.resetCatalogEntryResolver()
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

const mergeOutput = {
  memories: [{
    op: 'merge', domain: 'general', track: 'memory', target_id: TARGET,
    title: '部署窗口的合并版本',
    content: '每周四凌晨两点到四点是固定的部署窗口，窗口内只允许灰度发布，全量要等监控确认。',
    confidence: 0.9,
    evidence: [{ session_id: 's1', quote: '部署窗口只在周四凌晨' }],
  }],
}

test('a held clone from a target-changed conflict carries no vector stamp and membership counts neither it nor the committed id row', async () => {
  seedGlobalIndex({ [TARGET]: TARGET_ENTRY })
  const { migrator, generation } = await activateVectorGeneration()

  // The concurrent writer lands while the curator is between its index read and
  // its index write: the backend commit is the only async seam in between.
  backend.onCommit = async () => {
    state.updateGlobalIndex((fresh) => {
      fresh.entries[TARGET] = { ...fresh.entries[TARGET], content: '内容已被并发修改', updatedAt: '2026-02-02T00:00:00.000Z' }
    })
  }
  const result = await curator.commitCuratorOutput(structuredClone(mergeOutput), { job: { step: 'committing' } })
  backend.onCommit = null

  assert.equal(result.merged, 1, 'the merge update is still accounted as attempted')
  assert.equal(result.files.length, 1)
  const committedId = result.files[0].name
  assert.deepEqual(backend.commits.map((call) => call.names), [[committedId]], 'the batch committed exactly the new id')

  const index = state.loadGlobalIndex()
  // The held clone got its own id; the committed id row is NOT in the index.
  const heldId = Object.keys(index.entries).find((id) => index.entries[id]?.reviewReason === 'target changed while curator was running')
  assert.ok(heldId, 'the target-changed merge must be held for review')
  assert.notEqual(heldId, committedId)
  assert.equal(index.entries[committedId], undefined, 'the committed id must not land in the index when held')
  const held = index.entries[heldId]
  assert.equal(held.status, 'pending_review')
  assert.equal(held.conflictingWith, TARGET)
  // The regression: the clone spread `...entry` after the stamp loop stamped it.
  assert.equal(Object.hasOwn(held, 'vector'), false, 'a held clone never entered the vector store, so it must not carry the stamp')
  assert.equal(index.entries[TARGET].status, 'active', 'the untouched target is not superseded by a held clone')

  // membership: the ledger leg keeps TARGET; the stamp leg admits the new
  // create/update stamps only. Neither heldId (no stamp, not in ledger) nor the
  // committed `id` (row exists in the backend, but not in the index) may appear.
  const membership = migrator.membership()
  assert.ok(membership, 'an active generation must produce a membership map')
  const globalIds = membership.global || []
  assert.ok(globalIds.includes(TARGET), 'the migrated target stays counted')
  assert.ok(!globalIds.includes(heldId), 'the held clone is not counted as vector membership')
  assert.ok(!globalIds.includes(committedId), 'the backend row `id` must not be attributed to the index it never landed in')
})

test('a clean create still carries the current-generation stamp and is counted by membership', async () => {
  seedGlobalIndex({})
  const { migrator, generation } = await activateVectorGeneration()
  const output = {
    memories: [{
      op: 'create', domain: 'general', track: 'memory',
      title: '独立的全新事实',
      content: '用户倾向于在正式汇报里先给结论再给细节。',
      confidence: 0.9,
      evidence: [{ session_id: 's2', quote: '先说结论' }],
    }],
  }
  const result = await curator.commitCuratorOutput(output, { job: { step: 'committing' } })
  assert.equal(result.created, 1)
  const index = state.loadGlobalIndex()
  const entry = Object.values(index.entries)[0]
  assert.equal(entry.status, 'active')
  assert.equal(entry.vector?.route, 'managed-local')
  assert.equal(Number(entry.vector?.generation), generation, 'the stamp names the active generation')
  const membership = migrator.membership()
  assert.deepEqual(membership.global, [result.files[0].name])
})

test('a global-index write failure after the batch commit is compensated name by name and reported', async () => {
  seedGlobalIndex({})
  await activateVectorGeneration()
  const output = {
    memories: [
      { op: 'create', domain: 'general', track: 'memory', title: '第一条', content: '第一条全新事实的内容，足够长以通过校验。', confidence: 0.9, evidence: [{ session_id: 's3', quote: '一' }] },
      { op: 'create', domain: 'general', track: 'memory', title: '第二条', content: '第二条全新事实的内容，与第一条没有关系。', confidence: 0.9, evidence: [{ session_id: 's4', quote: '二' }] },
    ],
  }
  indexHook.failNext = 1
  await assert.rejects(
    curator.commitCuratorOutput(structuredClone(output), { job: { step: 'committing' } }),
    /disk full/,
    'the original index error must surface, not the compensation result',
  )
  const committedNames = backend.commits.at(-1).names
  assert.equal(committedNames.length, 2)
  // Compensation: every committed name received a forget against the global db.
  assert.deepEqual(
    backend.forgets.map((call) => call.name).sort(),
    [...committedNames].sort(),
    'each just-committed name must be forgotten',
  )
  assert.ok(backend.forgets.every((call) => call.db === state.globalDbPath()))
  // The index write failed, so nothing landed: the library must not gain entries
  // and the curation failure stays the job's error.
  assert.deepEqual(Object.keys(state.loadGlobalIndex().entries), [])
  // The compensation outcome is visible in the activity log, not swallowed.
  const event = activity.listEvents({ kind: 'curate' }).find((item) => item.level === 'error' || item.level === 'warn')
  assert.ok(event, 'the compensation must be recorded')
  assert.equal(event.ok, true, 'both names were compensated, so the record says so')
  assert.deepEqual(event.detail.compensated.sort(), [...committedNames].sort())
  assert.deepEqual(event.detail.failed, [])
  assert.match(event.message, /回滚|补偿/)
})

test('a compensation failure is reported per name and never hides the original error', async () => {
  seedGlobalIndex({})
  await activateVectorGeneration()
  // Make forget fail for the second name only: partial compensation must be
  // recorded name by name.
  const originalForget = globalThis.__curatorCommitTest.forget
  const forgetBaseline = backend.forgets.length
  globalThis.__curatorCommitTest.forget = async (args) => {
    if (backend.forgets.length > forgetBaseline) throw new Error('engine db is locked')
    return originalForget(args)
  }
  const output = {
    memories: [
      { op: 'create', domain: 'general', track: 'memory', title: '甲', content: '甲事实的内容，与乙无关。', confidence: 0.9, evidence: [{ session_id: 's5', quote: '甲' }] },
      { op: 'create', domain: 'general', track: 'memory', title: '乙', content: '乙事实的内容，与甲无关。', confidence: 0.9, evidence: [{ session_id: 's6', quote: '乙' }] },
    ],
  }
  indexHook.failNext = 1
  await assert.rejects(
    curator.commitCuratorOutput(structuredClone(output), { job: { step: 'committing' } }),
    /disk full/,
  )
  globalThis.__curatorCommitTest.forget = originalForget
  const event = activity.listEvents({ kind: 'curate' }).filter((item) => item.level === 'error').at(-1)
  assert.ok(event, 'a partial compensation must be recorded at error level')
  assert.equal(event.ok, false)
  assert.equal(event.detail.compensated.length, 1, 'the name whose forget succeeded is recorded as compensated')
  assert.equal(event.detail.failed.length, 1, 'the name whose forget failed is recorded with its reason')
  assert.match(event.detail.failed[0].error, /engine db is locked/)
  assert.match(event.message, /残留孤儿行/)
})
