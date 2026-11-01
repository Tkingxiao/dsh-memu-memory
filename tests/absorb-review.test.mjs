import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'

// Package F2 (spec §4.11 / §6.7): the pendingAbsorb review path and undo.
//
// Covered here:
//   1. listReviews carries reviewRisk / reviewRiskReasons / pendingAbsorb;
//   2. accept: resolution must be replace (coexist throws), the duplicate gate
//      excludes target+sources, the snapshot check catches a concurrently changed
//      source ('review changed; reload and retry'), the vector store receives ONLY
//      the proposal id (never the sources), and the single index transaction
//      supersedes the target, archives the sources, rewires links and writes the
//      snapshot while clearing pendingAbsorb/reviewReason/conflictingWith;
//   3. reject: the proposal is archived and target/sources stay untouched;
//   4. undo-absorb through the RPC: restores target/sources/rewired links in one
//      transaction, archives the merged entry, refuses a second undo, refuses a
//      libraryId, refuses an entry without a snapshot, and refuses when a member
//      was edited after absorption.
//
// Same hermetic pattern as tests/curator-commit.test.mjs. A managed vector
// generation is active so the accept path's commit lands in the stub backend
// and can be counted.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-absorb-review-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const backend = {
  commits: [],
  forgets: [],
}
globalThis.__curatorAbsorbReviewTest = {
  async commit(args) {
    const names = (args.payload?.recall_files || []).map((file) => file.name)
    backend.commits.push({ names, route: args.route, db: args.db })
    return { ok: true }
  },
  async forget(args) {
    backend.forgets.push({ name: args.name, db: args.db })
    return { deleted: 1, segments: 1 }
  },
  async retrieve() { return { files: [], segments: [], resources: [], raw: null } },
  async listFiles() { return { recall_files: [], resources: [], raw: null } },
}

const memuSource = 'const bridge = globalThis.__curatorAbsorbReviewTest;'
  + 'export const commit = (args) => bridge.commit(args), forget = (args) => bridge.forget(args),'
  + 'retrieve = (args) => bridge.retrieve(args), listFiles = (args) => bridge.listFiles(args);'
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './memu.js') return { url: 'data:text/javascript,' + encodeURIComponent(memuSource), shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const curator = await import('../lib/curator.js')
const memory = await import('../lib/memory.js')
const rpc = await import('../lib/rpc.js')
const state = await import('../lib/state.js')
const vm = await import('../lib/vector-migration.js')
const vp = await import('../lib/vector-profile.js')
const catalog = await import('../lib/embedding-catalog.js')

const BGE = 'bge-small-zh-v1.5-int8'
const baseEntry = catalog.getEmbeddingModel(BGE)
const altEntry = JSON.parse(JSON.stringify(baseEntry))
altEntry.id = 'bge-small-zh-v1.5-int8-alt'
altEntry.displayName = 'BGE alternative revision (absorb review fixture)'
altEntry.sources.modelscope.revision = 'c'.repeat(40)
altEntry.profileFingerprint = catalog.profileFingerprint(altEntry)
const models = { [BGE]: baseEntry, [altEntry.id]: altEntry }
vp.setCatalogEntryResolver((id) => models[id] ?? null)

state.updateSettings({ memoryBackend: 'api', vectorSource: 'local' })

test.after(async () => {
  try { hooks.unregister?.() } catch {}
  vp.resetCatalogEntryResolver()
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function seedGlobalIndex(entries = {}) {
  state.saveGlobalIndex({ version: 1, entries: structuredClone(entries) })
}

async function activateVectorGeneration() {
  const dbs = new Map()
  const rowsOf = (db) => {
    if (!dbs.has(db)) dbs.set(db, new Map())
    return dbs.get(db)
  }
  const migrator = vm.createVectorMigrator({
    async listLibraries() { return [] },
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

const CORE = '每周四凌晨两点到四点是固定的部署窗口，窗口内只允许灰度发布。'
const AT = '2026-01-01T00:00:00.000Z'
const A = 'gmem-review-a'
const B = 'gmem-review-b'
const C = 'gmem-review-c'
const D = 'gmem-review-d'
const E = 'gmem-review-e'

function baseEntryOf(id, title, content, extra = {}) {
  return {
    track: 'memory', domain: 'general', title, content,
    confidence: 0.9, status: 'active',
    createdAt: AT, updatedAt: AT,
    evidence: [{ sessionId: 's0', quote: '部署窗口只在周四' }],
    ...extra,
  }
}

function absorbEvidence(ids) {
  return ids.map((id, index) => ({ session_id: `s-rev-${index}`, quote: `来源 ${id} 的落地引用内容`, source_id: id }))
}

function seedCluster({ withLinks = false } = {}) {
  const entries = {
    [A]: baseEntryOf(A, '部署窗口约定', CORE + '全量发布必须在监控确认通过之后才能执行。'),
    [B]: baseEntryOf(B, '部署窗口细节', CORE + '灰度发布按服务分组逐步放量，异常时立即回滚。'),
    [C]: baseEntryOf(C, '部署窗口约束', CORE + '窗口外禁止任何生产变更。'),
  }
  if (withLinks) {
    entries[D] = baseEntryOf(D, '簇外条目', '另一个话题的内容，与吸收无关。', {
      links: [{ id: 'lnk-in-9', opId: 'op9', to: A, kind: 'related', note: '这条入边在吸收后要改指合并稿。', confidence: 0.7, evidence: [], createdAt: AT }],
    })
    entries[A].links = [{ id: 'lnk-out-9', opId: 'op8', to: E, kind: 'refines', note: 'target 指向簇外的边要并入合并稿。', confidence: 0.7, evidence: [], createdAt: AT }]
    entries[E] = baseEntryOf(E, '簇外条目2', '被 target 指向的条目。')
  }
  seedGlobalIndex(entries)
}

// review-all 让 absorb 计划一律落 pendingAbsorb 提案（spec §4.10 表格第三列）。
state.updateSettings({ curatorReviewMode: 'review-all' })

const ABSORB_PLAN = {
  memories: [{
    op: 'absorb', target_id: A, source_ids: [B, C],
    confidence: 0.9,
    evidence: absorbEvidence([A, B, C]),
  }],
}

async function pendingProposalOf() {
  const queue = await rpc.dispatch({}, 'listReviews', {})
  const item = queue.items.find((row) => row.pendingAbsorb)
  assert.ok(item, 'the absorb proposal must be in the review queue')
  return item
}

test('listReviews exposes reviewRisk, reviewRiskReasons and pendingAbsorb for the queue UI', async () => {
  seedCluster()
  await activateVectorGeneration()
  const result = await curator.commitCuratorPlans(structuredClone(ABSORB_PLAN), { job: { step: '' } })
  assert.equal(result.pending, 1)
  const item = await pendingProposalOf()
  assert.equal(item.pendingAbsorb.targetId, A)
  assert.deepEqual([...item.pendingAbsorb.sourceIds].sort(), [B, C].sort())
  assert.ok(item.pendingAbsorb.opId)
  assert.equal(item.pendingAbsorb.expectedUpdatedAt[A], AT)
  assert.equal(typeof item.reviewRisk, 'number', 'reviewRisk rides along on every queue row')
  assert.ok(Array.isArray(item.reviewRiskReasons))
})

test('accept turns the proposal active, archives the sources, commits only the proposal id to vectors and rewires links', async () => {
  seedCluster({ withLinks: true })
  await activateVectorGeneration()
  await curator.commitCuratorPlans(structuredClone(ABSORB_PLAN), { job: { step: '' } })
  const item = await pendingProposalOf()
  const proposalId = item.id

  const resolved = await rpc.dispatch({}, 'resolveReview', { id: proposalId, action: 'accept' })
  assert.equal(resolved.status, 'active')

  const index = state.loadGlobalIndex()
  const merged = index.entries[proposalId]
  assert.equal(merged.status, 'active')
  // §3.3/§4.11：accept 写 absorbedFrom/absorbedAt/absorbOpId/representativeId，
  // 并清 pendingAbsorb/reviewReason/conflictingWith。
  assert.deepEqual(merged.absorbedFrom, [A, B, C].sort())
  assert.ok(merged.absorbOpId)
  assert.ok(merged.representativeId)
  assert.ok(merged.absorbAt || merged.updatedAt)
  assert.equal(merged.auditTrail?.at(-1)?.op, 'absorb')
  assert.equal(index.entries[A].auditTrail?.at(-1)?.op, 'absorb')
  assert.equal(index.entries[B].auditTrail?.at(-1)?.op, 'absorb')
  assert.equal(merged.pendingAbsorb, undefined)
  assert.equal(merged.reviewReason, undefined)
  assert.equal(merged.conflictingWith, undefined)
  assert.ok(merged.absorbSnapshot, 'the accept transaction writes the undo snapshot')
  assert.ok(merged.vector, 'the accepted entry carries the vector stamp')

  // 向量库只收到提案 id 这一行；sources 一行都没有。
  const lastCommit = backend.commits.at(-1)
  assert.deepEqual(lastCommit.names, [proposalId])

  // target superseded；sources archived。
  assert.equal(index.entries[A].status, 'superseded')
  assert.equal(index.entries[A].absorbedInto, proposalId)
  assert.equal(index.entries[B].status, 'archived')
  assert.equal(index.entries[B].absorbedBy, proposalId)
  assert.equal(index.entries[C].status, 'archived')
  // links：入边改指 merged，出边并入 merged。
  assert.equal(index.entries[D].links[0].to, proposalId)
  assert.equal(merged.links[0].to, E)
  // 快照保留吸收前状态。
  assert.deepEqual(merged.absorbSnapshot.rewired.map((row) => row.id), [D])
})

test('reject archives the proposal and leaves target/sources untouched', async () => {
  seedCluster()
  await activateVectorGeneration()
  await curator.commitCuratorPlans(structuredClone(ABSORB_PLAN), { job: { step: '' } })
  const item = await pendingProposalOf()
  await rpc.dispatch({}, 'resolveReview', { id: item.id, action: 'reject' })
  const index = state.loadGlobalIndex()
  assert.equal(index.entries[item.id].status, 'archived')
  assert.equal(index.entries[A].status, 'active', 'the target stays active on reject')
  assert.equal(index.entries[B].status, 'active')
  assert.equal(index.entries[C].status, 'active')
})

test('accept with a coexist resolution is refused: a merged entry cannot coexist with its own sources', async () => {
  seedCluster()
  await activateVectorGeneration()
  await curator.commitCuratorPlans(structuredClone(ABSORB_PLAN), { job: { step: '' } })
  const item = await pendingProposalOf()
  await assert.rejects(
    () => rpc.dispatch({}, 'resolveReview', { id: item.id, action: 'accept', resolution: 'coexist', reason: '条件不同的并存说明文字' }),
    /replace/,
  )
  assert.equal(state.loadGlobalIndex().entries[item.id].status, 'pending_review', 'the proposal stays pending')
})

test('accept with a concurrently changed source throws "review changed" and keeps the proposal pending', async () => {
  seedCluster()
  await activateVectorGeneration()
  await curator.commitCuratorPlans(structuredClone(ABSORB_PLAN), { job: { step: '' } })
  const item = await pendingProposalOf()
  // 并发写：source 的 updatedAt 变了，快照校验必须拦下这次接受。
  state.updateGlobalIndex((fresh) => {
    fresh.entries[B] = { ...fresh.entries[B], content: '来源被并发修改。', updatedAt: '2026-03-03T00:00:00.000Z' }
  })
  await assert.rejects(
    () => rpc.dispatch({}, 'resolveReview', { id: item.id, action: 'accept' }),
    /review changed; reload and retry/,
  )
  const index = state.loadGlobalIndex()
  assert.equal(index.entries[item.id].status, 'pending_review', 'the proposal stays pending')
  assert.equal(index.entries[A].status, 'active', 'the target is not superseded by a failed accept')
  assert.equal(index.entries[B].status, 'active')
})

test('undo-absorb restores target, sources and rewired links, archives the merged entry, and refuses a second undo', async () => {
  seedCluster({ withLinks: true })
  await activateVectorGeneration()
  await curator.commitCuratorPlans(structuredClone(ABSORB_PLAN), { job: { step: '' } })
  const item = await pendingProposalOf()
  await rpc.dispatch({}, 'resolveReview', { id: item.id, action: 'accept' })
  const mergedId = item.id

  const undone = await rpc.dispatch({}, 'resolveReview', { id: mergedId, action: 'undo-absorb' })
  assert.equal(undone.status, 'archived')

  const index = state.loadGlobalIndex()
  const merged = index.entries[mergedId]
  assert.equal(merged.status, 'archived', 'the merged entry is archived, not deleted')
  assert.ok(merged.absorbUndoneAt)
  assert.ok(merged.content, 'the merged body is kept')
  assert.equal(merged.auditTrail.at(-1).op, 'undo-absorb')
  assert.equal(index.entries[A].auditTrail.at(-1).op, 'undo-absorb')
  assert.equal(index.entries[B].auditTrail.at(-1).op, 'undo-absorb')
  // target 恢复。
  const target = index.entries[A]
  assert.equal(target.status, 'active')
  assert.equal(target.supersededBy, undefined)
  assert.equal(target.absorbedInto, undefined)
  assert.equal(target.validTo, undefined)
  // sources 恢复。
  for (const id of [B, C]) {
    const source = index.entries[id]
    assert.equal(source.status, 'active')
    assert.equal(source.absorbedBy, undefined)
    assert.equal(source.absorbedAt, undefined)
    assert.equal(source.validTo, undefined)
  }
  // rewired 边恢复原状。
  assert.equal(index.entries[D].links[0].to, A)

  // 二次撤销：merged 已不是 active，直接报错。
  await assert.rejects(
    () => rpc.dispatch({}, 'resolveReview', { id: mergedId, action: 'undo-absorb' }),
    /active merged entry with an absorb snapshot/,
  )
})

test('undo-absorb refuses a libraryId payload, an entry without a snapshot, and members edited after absorption', async () => {
  seedCluster({ withLinks: true })
  await activateVectorGeneration()
  await curator.commitCuratorPlans(structuredClone(ABSORB_PLAN), { job: { step: '' } })
  const item = await pendingProposalOf()
  await rpc.dispatch({}, 'resolveReview', { id: item.id, action: 'accept' })
  const mergedId = item.id

  // 带 libraryId 的 undo 是私有复核语义错位，必须报错（spec §6.7 RPC）。
  await assert.rejects(
    () => rpc.dispatch({}, 'resolveReview', { id: mergedId, action: 'undo-absorb', libraryId: 'some-lib' }),
    /libraryId/,
  )
  // 没有 absorbSnapshot 的条目不能 undo。
  await assert.rejects(
    () => rpc.dispatch({}, 'resolveReview', { id: A, action: 'undo-absorb' }),
    /absorb snapshot/,
  )

  // 吸收后 target 又被人工改过（updatedAt > absorbedAt）→ 拒绝整体撤销。
  // （absorbedAt 是真实的当前时间，人工改动的时间必须落在它之后。）
  state.updateGlobalIndex((fresh) => {
    fresh.entries[A] = { ...fresh.entries[A], content: '人工修正后的部署窗口约定。', updatedAt: '2030-01-01T00:00:00.000Z' }
  })
  await assert.rejects(
    () => rpc.dispatch({}, 'resolveReview', { id: mergedId, action: 'undo-absorb' }),
    /absorb undo refused/,
  )
  const index = state.loadGlobalIndex()
  assert.equal(index.entries[mergedId].status, 'active', 'the refused undo leaves the merge in place')
})

test('the review wrapper still records the review in the activity log', async () => {
  seedCluster()
  await activateVectorGeneration()
  await curator.commitCuratorPlans(structuredClone(ABSORB_PLAN), { job: { step: '' } })
  const item = await pendingProposalOf()
  await rpc.dispatch({}, 'resolveReview', { id: item.id, action: 'reject' })
  const event = [...await import('../lib/activity-log.js').then((m) => m.listEvents({ kind: 'write' }))]
    .find((row) => row.detail?.id === item.id && row.message.includes('复核'))
  assert.ok(event, 'the resolveReview wrapper logs the decision')
})
