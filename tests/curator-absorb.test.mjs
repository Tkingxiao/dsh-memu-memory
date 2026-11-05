import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'

// Package F2 (spec §6.7 / §4.7 / §4.11): commitCuratorPlans — the absorb commit.
//
// Covered here:
//   1. three entries compose into one merged entry; sources are archived, never deleted;
//   2. the model's target is only provenance — the computed medoid becomes
//      representativeId when it differs;
//   3. pending_review / superseded members are demoted, never absorbed;
//   4. coverage below the auto band lands as a pendingAbsorb proposal (index only);
//   5. the same plan twice is idempotent through absorbOpId;
//   6. a concurrent source change holds a pending clone, does not land the merge
//      active, and best-effort forgets the committed vector row;
//   7. links pointing into the cluster are rewired to the merged id and the
//      pre-absorption state is captured in absorbSnapshot.
//   8. composeAbsorbContent unit behaviour: abstractive vs extractive, sentence
//      dedup, MMR truncation marks dropped key sentences.
//
// Same hermetic pattern as tests/curator-commit.test.mjs: './memu.js' is
// replaced before production modules load; everything else is the real module
// stack against a temp DSH_MEMU_HOME. Default settings keep the vector route
// lexical except where a test activates a managed generation explicitly.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-curator-absorb-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const backend = {
  commits: [],
  forgets: [],
  onCommit: null,
}
globalThis.__curatorAbsorbTest = {
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

const memuSource = 'const bridge = globalThis.__curatorAbsorbTest;'
  + 'export const commit = (args) => bridge.commit(args), forget = (args) => bridge.forget(args),'
  + 'retrieve = (args) => bridge.retrieve(args), listFiles = (args) => bridge.listFiles(args),'
  + 'closeMemuResident = () => 0, prewarmMemuResident = async () => false;'
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './memu.js') return { url: 'data:text/javascript,' + encodeURIComponent(memuSource), shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const curator = await import('../lib/curator.js')
const state = await import('../lib/state.js')
const activity = await import('../lib/activity-log.js')
const vm = await import('../lib/vector-migration.js')
const vp = await import('../lib/vector-profile.js')
const catalog = await import('../lib/embedding-catalog.js')

const BGE = 'bge-small-zh-v1.5-int8'
const baseEntry = catalog.getEmbeddingModel(BGE)
const altEntry = JSON.parse(JSON.stringify(baseEntry))
altEntry.id = 'bge-small-zh-v1.5-int8-alt'
altEntry.displayName = 'BGE alternative revision (curator absorb fixture)'
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
const X = '全量发布必须在监控确认通过之后才能执行。'
const Y = '灰度发布按服务分组逐步放量，异常时立即回滚。'
const AT = '2026-01-01T00:00:00.000Z'

function baseEntryOf(id, title, content, extra = {}) {
  return {
    track: 'memory', domain: 'general', title, content,
    confidence: 0.9, status: 'active',
    createdAt: AT, updatedAt: AT,
    evidence: [{ sessionId: 's0', quote: '部署窗口只在周四' }],
    ...extra,
  }
}

const A = 'gmem-absorb-a'
const B = 'gmem-absorb-b'
const C = 'gmem-absorb-c'

function absorbEvidence(ids) {
  return ids.map((id, index) => ({ session_id: `s-absorb-${index}`, quote: `来源 ${id} 的落地引用内容`, source_id: id }))
}

// —— composeAbsorbContent 单元行为（spec §4.7）——

test('composeAbsorbContent: a well-covering proposed draft becomes abstractive, a poor one falls back to extractive', () => {
  const target = { title: 't', content: CORE + X }
  const source = { title: 's', content: CORE + Y }
  const good = CORE + X + Y
  const composed = curator.composeAbsorbContent({ target, sources: [source], proposed: good })
  assert.equal(composed.mode, 'abstractive')
  assert.equal(composed.content, good)
  assert.ok(composed.coverage >= 0.75)

  const poor = curator.composeAbsorbContent({ target, sources: [source], proposed: '完全无关的一句话，跟部署窗口没有关系。' })
  assert.equal(poor.mode, 'extractive')
  // extractive union keeps every unique sentence, target first.
  assert.ok(poor.content.includes(CORE))
  assert.ok(poor.content.includes(X))
  assert.ok(poor.content.includes(Y))
  assert.equal(poor.truncated, false)
})

test('composeAbsorbContent: duplicate sentences are dropped and MMR truncation marks dropped key sentences', () => {
  const target = { title: 't', content: CORE + ' ' + X }
  const source = { title: 's', content: CORE + ' ' + Y + ' ' + '补充说明一。补充说明二。补充说明三。补充说明四。补充说明五。' }
  // maxChars forces MMR; the tiny budget cannot keep the target's second
  // sentence, which is a key sentence (all target sentences are key).
  const composed = curator.composeAbsorbContent({ target, sources: [source], maxChars: CORE.length + 2 })
  assert.equal(composed.mode, 'extractive')
  assert.ok(composed.content.length <= CORE.length + 2)
  assert.equal(composed.truncated, true)
  assert.ok(composed.omitted.length > 0, 'dropped key sentences must be reported')
})

// —— commitCuratorPlans：3 条合成 1 条 ——

test('an absorb plan merges three entries into one; sources are archived with bodies kept, never deleted', async () => {
  seedGlobalIndex({
    [A]: baseEntryOf(A, '部署窗口约定', CORE + X),
    [B]: baseEntryOf(B, '部署窗口细节', CORE + Y, { confidence: 0.85 }),
    [C]: baseEntryOf(C, '部署窗口约束', CORE + '窗口外禁止任何生产变更。', { confidence: 0.8 }),
  })
  const output = {
    memories: [{
      op: 'absorb', target_id: A, source_ids: [B, C],
      title: '部署窗口（模型给的标题，应被 target 标题压过）',
      content: '',
      confidence: 0.9,
      evidence: absorbEvidence([A, B, C]),
    }],
  }
  const result = await curator.commitCuratorPlans(structuredClone(output), { job: { step: '' } })
  assert.equal(result.absorbed, 1)
  assert.equal(result.pending, 0)
  assert.equal(result.skipped.length, 0)

  const index = state.loadGlobalIndex()
  const mergedId = Object.keys(index.entries).find((id) => index.entries[id]?.absorbedFrom)
  assert.ok(mergedId, 'the merged entry must be in the index')
  const merged = index.entries[mergedId]
  assert.equal(merged.status, 'active')
  assert.deepEqual(merged.absorbedFrom, [A, B, C].sort(), 'absorbedFrom is sorted target+sources')
  assert.match(merged.absorbOpId, /^[0-9a-f]{16}$/)
  assert.ok(merged.representativeId, 'the merged entry records the computed medoid')
  assert.equal(merged.title, '部署窗口约定', 'title comes from the target first')
  assert.equal(merged.mergeMode, 'extractive')
  assert.ok(merged.sourceCoverage >= 0.45 && merged.unionCoverage >= 0.60, 'clean coverage passes the auto band')
  // 内容是句级 union：target 的句子在前，来源句子去重并入，重复的 CORE 只出现一次。
  assert.ok(merged.content.includes(X))
  assert.ok(merged.content.includes(Y))
  assert.equal(merged.content.split(CORE.replace(/。$/, '')).length - 1, 1, 'the shared core sentence appears once')
  // 证据带 sourceId，覆盖每条 source。
  const evidenceSources = new Set(merged.evidence.map((item) => item.sourceId))
  for (const id of [A, B, C]) assert.ok(evidenceSources.has(id), `evidence must cover ${id}`)
  // absorbSnapshot 记录吸收前状态。
  assert.equal(merged.absorbSnapshot.target.id, A)
  assert.deepEqual(merged.absorbSnapshot.sources.map((s) => s.id), [B, C].sort())
  assert.ok(merged.absorbSnapshot.at)

  // target superseded；sources archived——正文保留，绝不删除。
  assert.equal(index.entries[A].status, 'superseded')
  assert.equal(index.entries[A].absorbedInto, mergedId)
  assert.equal(index.entries[A].supersededBy, mergedId)
  assert.ok(index.entries[A].validTo)
  for (const id of [B, C]) {
    assert.equal(index.entries[id].status, 'archived', `${id} is archived, not deleted`)
    assert.equal(index.entries[id].absorbedBy, mergedId)
    assert.ok(index.entries[id].absorbedAt)
    assert.ok(index.entries[id].content.includes(CORE), 'the archived source keeps its body')
  }
  // 词法路由下不提交向量；pending 之外没有多余条目。
  assert.equal(backend.commits.length, 0)
})

// —— medoid 纠正 ——

test('when the model target is not the medoid, representativeId records the medoid instead', async () => {
  // B is the bare core; A and C each append one long, mutually dissimilar
  // sentence. B sits between them, so B is the medoid even though the model
  // named A as target.
  seedGlobalIndex({
    [A]: baseEntryOf(A, '部署窗口约定', CORE + ' ' + '需求评审通过之后才允许进入发布队列，发布队列按优先级排序处理。'),
    [B]: baseEntryOf(B, '部署窗口核心', CORE),
    [C]: baseEntryOf(C, '部署窗口约束', CORE + ' ' + '窗口内的变更必须双人复核并且记录回滚预案到值班日志。'),
  })
  const output = {
    memories: [{
      op: 'absorb', target_id: A, source_ids: [B, C],
      confidence: 0.9,
      evidence: absorbEvidence([A, B, C]),
    }],
  }
  const result = await curator.commitCuratorPlans(structuredClone(output), { job: { step: '' } })
  assert.equal(result.absorbed, 1)
  const index = state.loadGlobalIndex()
  const merged = Object.values(index.entries).find((entry) => entry.absorbedFrom)
  assert.equal(merged.representativeId, B, 'the medoid becomes representativeId')
  assert.notEqual(merged.representativeId, A)
  assert.equal(merged.absorbSnapshot.target.id, A, 'the model target stays as provenance')
})

// —— pending/superseded 成员降级 ——

test('pending and superseded members are demoted out of the absorb set, never absorbed', async () => {
  const P = 'gmem-absorb-pending'
  const S = 'gmem-absorb-superseded'
  seedGlobalIndex({
    [A]: baseEntryOf(A, '部署窗口约定', CORE + X),
    [B]: baseEntryOf(B, '部署窗口细节', CORE + Y),
    [P]: baseEntryOf(P, '待审条目', CORE + '待审的说法。', { status: 'pending_review' }),
    [S]: baseEntryOf(S, '被取代条目', CORE + '旧的说法。', { status: 'superseded' }),
  })
  const output = {
    memories: [{
      op: 'absorb', target_id: A, source_ids: [P, S, B],
      confidence: 0.9,
      evidence: [...absorbEvidence([A, B]), { session_id: 's-x', quote: '无效来源的引用', source_id: P }],
    }],
  }
  const result = await curator.commitCuratorPlans(structuredClone(output), { job: { step: '' } })
  assert.equal(result.absorbed, 1)
  const demotedIds = result.demoted.map((item) => item.sourceId)
  assert.deepEqual(demotedIds.sort(), [P, S].sort())
  const index = state.loadGlobalIndex()
  const merged = Object.values(index.entries).find((entry) => entry.absorbedFrom)
  assert.deepEqual(merged.absorbedFrom, [A, B].sort(), 'only active members are absorbed')
  // 降级的成员状态原样。
  assert.equal(index.entries[P].status, 'pending_review')
  assert.equal(index.entries[S].status, 'superseded')
})

// —— 覆盖率不足 pending + 幂等 ——

test('coverage below the auto band lands as a pendingAbsorb proposal, and the same plan again is idempotent', async () => {
  const T2 = 'gmem-absorb-t2'
  const SAME = 'gmem-absorb-same'
  const LOW = 'gmem-absorb-low'
  // SAME 与 target 同文外加一句独有补充（句级去重后补充句保留，覆盖率 1.0）；LOW 的
  // 单句包含 target 的句子，整句被去重丢掉，覆盖率落到 skip 段之上、auto 段之下。
  // 两者合成后：sourceCoverage = min(1.0, ~0.28) ≥ 0.25 不过 skip 门；unionCoverage
  // ~0.5 落在 0.45–0.60 的 pending 段。三条同题——medoid 用 title+content 评估，
  // 异题会把包含关系的相似度打到 0。
  seedGlobalIndex({
    [T2]: baseEntryOf(T2, '发布审批约定', '上线前必须完成发布审批。'),
    [SAME]: baseEntryOf(SAME, '发布审批约定', '上线前必须完成发布审批。审批单需要写明影响范围与回滚预案。'),
    [LOW]: baseEntryOf(LOW, '发布审批约定', '上线前必须完成发布审批，审批通过后还要在值班表登记变更单号并通知全部值班同学确认。'),
  })
  const output = {
    memories: [{
      op: 'absorb', target_id: T2, source_ids: [SAME, LOW],
      confidence: 0.9,
      evidence: absorbEvidence([T2, SAME, LOW]),
    }],
  }
  const first = await curator.commitCuratorPlans(structuredClone(output), { job: { step: '' } })
  assert.equal(first.pending, 1, `expected a coverage pending, got ${JSON.stringify(first)}`)
  assert.equal(first.absorbed, 0)

  const index = state.loadGlobalIndex()
  const proposalEntry = Object.entries(index.entries).find(([, entry]) => entry.pendingAbsorb)
  assert.ok(proposalEntry, 'the pending absorb proposal is in the index')
  const [proposalId, proposal] = proposalEntry
  assert.equal(proposal.status, 'pending_review')
  assert.equal(proposal.reviewReason, 'absorb coverage')
  assert.equal(proposal.conflictingWith, T2)
  const pa = proposal.pendingAbsorb
  assert.equal(pa.targetId, T2)
  assert.deepEqual([...pa.sourceIds].sort(), [SAME, LOW].sort())
  assert.equal(pa.representativeId, T2)
  assert.equal(pa.expectedUpdatedAt[T2], AT)
  assert.equal(pa.expectedUpdatedAt[LOW], AT)
  assert.ok(pa.opId)

  // 同一提案再来一次：opId 已在（pendingAbsorb 里），幂等 skip，不再生成第二条。
  const second = await curator.commitCuratorPlans(structuredClone(output), { job: { step: '' } })
  assert.equal(second.pending, 0)
  assert.ok(second.skipped.some((item) => /duplicate absorb opId/.test(item.reason)))
  const indexAfter = state.loadGlobalIndex()
  assert.equal(Object.keys(indexAfter.entries).length, Object.keys(index.entries).length, 'no new entries on the idempotent run')
  assert.equal(indexAfter.entries[proposalId].status, 'pending_review')
})

// —— medoid 相似度过低整簇跳过 ——

test('a cluster whose medoid average is below the pair floor is skipped entirely', async () => {
  seedGlobalIndex({
    [A]: baseEntryOf(A, '部署窗口约定', '每周四凌晨两点到四点是固定的部署窗口，窗口内只允许灰度发布。'),
    [B]: baseEntryOf(B, '完全另一件事', '用户偏好深色主题的代码高亮配色。'),
    [C]: baseEntryOf(C, '又是另一件事', '会议纪要需要在当天归档到共享目录。'),
  })
  const output = {
    memories: [{
      op: 'absorb', target_id: A, source_ids: [B, C],
      confidence: 0.9,
      evidence: absorbEvidence([A, B, C]),
    }],
  }
  const result = await curator.commitCuratorPlans(structuredClone(output), { job: { step: '' } })
  assert.equal(result.absorbed, 0)
  assert.equal(result.pending, 0)
  assert.ok(result.skipped.some((item) => /below the pair floor/.test(item.reason)))
  const index = state.loadGlobalIndex()
  assert.equal(Object.keys(index.entries).length, 3, 'nothing was written')
})

// —— links rewire + snapshot ——

test('inbound links are rewired to the merged id, outbound links merge in, and the snapshot keeps pre-absorb state', async () => {
  const D = 'gmem-absorb-d'
  const E = 'gmem-absorb-e'
  const linkToA = { id: 'lnk-in-1', opId: 'op1', to: A, kind: 'related', note: '这条边指向 target，吸收后要改指合并稿。', confidence: 0.7, evidence: [], createdAt: AT }
  const linkFromA = { id: 'lnk-out-1', opId: 'op2', to: E, kind: 'refines', note: 'target 指向簇外的边要并入合并稿。', confidence: 0.7, evidence: [], createdAt: AT }
  seedGlobalIndex({
    [A]: baseEntryOf(A, '部署窗口约定', CORE + X, { links: [linkFromA] }),
    [B]: baseEntryOf(B, '部署窗口细节', CORE + Y),
    [C]: baseEntryOf(C, '部署窗口约束', CORE + '窗口外禁止任何生产变更。'),
    [D]: baseEntryOf(D, '簇外条目', '另一个话题的内容，与吸收无关。', { links: [linkToA] }),
    [E]: baseEntryOf(E, '簇外条目2', '被 target 指向的条目。'),
  })
  const output = {
    memories: [{
      op: 'absorb', target_id: A, source_ids: [B, C],
      confidence: 0.9,
      evidence: absorbEvidence([A, B, C]),
    }],
  }
  const result = await curator.commitCuratorPlans(structuredClone(output), { job: { step: '' } })
  assert.equal(result.absorbed, 1)
  const index = state.loadGlobalIndex()
  const mergedId = Object.keys(index.entries).find((id) => index.entries[id]?.absorbedFrom)
  const merged = index.entries[mergedId]
  // 入边改指 mergedId。
  assert.equal(index.entries[D].links[0].to, mergedId)
  assert.equal(index.entries[D].links[0].id, 'lnk-in-1', 'the edge keeps its id; only the endpoint moves')
  // 出边并入 merged（去重、cap 20）。
  assert.equal(merged.links.length, 1)
  assert.equal(merged.links[0].to, E)
  assert.equal(merged.links[0].kind, 'refines')
  // 快照保留吸收前状态。
  assert.deepEqual(merged.absorbSnapshot.rewired, [{ id: D, links: [linkToA] }])
  assert.deepEqual(merged.absorbSnapshot.mergedLinks, [{ ...linkFromA, to: E }])
  assert.equal(merged.absorbSnapshot.target.links.length, 1)
})

// —— 并发 source 变化 → held clone ——
test('a concurrent source change holds a pending clone, never lands the merge, and forgets the committed row', async () => {
  seedGlobalIndex({
    [A]: baseEntryOf(A, '部署窗口约定', CORE + X),
    [B]: baseEntryOf(B, '部署窗口细节', CORE + Y),
  })
  await activateVectorGeneration()

  // The concurrent writer lands while the curator sits between its index read
  // and its index write; the vector commit is the async seam in between.
  const changedAt = '2026-02-02T00:00:00.000Z'
  backend.onCommit = async () => {
    state.updateGlobalIndex((fresh) => {
      fresh.entries[B] = { ...fresh.entries[B], content: '来源内容被并发修改。', updatedAt: changedAt }
    })
  }
  const output = {
    memories: [{
      op: 'absorb', target_id: A, source_ids: [B],
      confidence: 0.9,
      evidence: absorbEvidence([A, B]),
    }],
  }
  const result = await curator.commitCuratorPlans(structuredClone(output), { job: { step: '' } })
  backend.onCommit = null

  assert.equal(result.held, 1)
  assert.equal(result.absorbed, 0)
  const index = state.loadGlobalIndex()
  const held = Object.values(index.entries).find((entry) => entry.pendingAbsorb)
  assert.ok(held, 'the held pending clone must be in the index')
  assert.equal(held.status, 'pending_review')
  assert.equal(held.reviewReason, 'cluster changed while curator was running')
  assert.equal(held.conflictingWith, A)
  // expectedUpdatedAt 刷新为当前值，accept 时再做快照校验。
  assert.equal(held.pendingAbsorb.expectedUpdatedAt[B], changedAt)
  // 已提交向量库的 mergedId 行被 best-effort forget。
  assert.deepEqual(backend.forgets.map((call) => call.name), backend.commits.at(-1).names)
  // 成员原样：target 仍 active，被改过的 source 仍 active。
  assert.equal(index.entries[A].status, 'active')
  assert.equal(index.entries[B].status, 'active')
  assert.equal(Object.values(index.entries).filter((entry) => entry.absorbedFrom && entry.status === 'active').length, 0,
    'no active merged entry landed')
  // 结果进活动日志。
  const event = activity.listEvents({ kind: 'curate' }).find((item) => item.detail?.op === 'absorb')
  assert.ok(event, 'the absorb run is recorded')
})
