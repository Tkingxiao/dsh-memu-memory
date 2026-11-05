import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'

// Package A (spec §6.1): curator review mode + risk score + input fixes.
//
// One entry of `memories` must land in exactly one of three states — active
// (committed), pending_review (index-only, held), or skipped — and the
// decision must follow §4.10: hard gates (conflict / missing evidence /
// invalid rewrite target) are pending in BOTH modes, `auto` passes clean
// creates and passes rewrites below the 0.70 risk threshold, `review-all`
// holds every content op. Unknown ops and invalid merge targets are skipped
// and never degrade into a create (the §0.2 bug).
//
// Same hermetic pattern as tests/curator-commit.test.mjs: './memu.js' is
// replaced before production modules load; everything else is the real module
// stack against a temp DSH_MEMU_HOME. Default settings keep the vector route
// lexical, so nothing here talks to an engine.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-curator-review-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

globalThis.__curatorReviewTest = {
  async commit() { return { ok: true } },
  async forget() { return { deleted: 1, segments: 1 } },
  async retrieve() { return { files: [], segments: [], resources: [], raw: null } },
  async listFiles() { return { recall_files: [], resources: [], raw: null } },
}

const memuSource = 'const bridge = globalThis.__curatorReviewTest;'
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
const rpc = await import('../lib/rpc.js')

test.after(async () => {
  try { hooks.unregister?.() } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

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

// Every test sets the mode it means to exercise; nothing relies on leftover
// settings from a previous case.
function setMode(mode) {
  state.updateSettings({ curatorReviewMode: mode })
}

const cleanCreate = (over = {}) => ({
  op: 'create', domain: 'general', track: 'memory',
  title: '独立的全新事实',
  content: '用户倾向于在正式汇报里先给结论再给细节。',
  confidence: 0.9,
  evidence: [
    { session_id: 's1', quote: '先说结论再说细节' },
    { session_id: 's2', quote: '汇报的时候结论在前' },
  ],
  ...over,
})

function entryOf(index, predicate) {
  return Object.values(index.entries).find(predicate) || null
}

test('auto + clean create with two evidence lands active with reviewRisk 0', async () => {
  seedGlobalIndex({})
  setMode('auto')
  const result = await curator.commitCuratorOutput({ memories: [cleanCreate()] }, { job: { step: 'committing' } })
  assert.equal(result.created, 1)
  assert.equal(result.pending, 0)
  assert.equal(result.files.length, 1)
  // The risk summary is part of the contract: every written entry is counted.
  assert.deepEqual(result.reviewRisk, { max: 0, flagged: 0, reasons: {} })
  const index = state.loadGlobalIndex()
  const entry = entryOf(index, (e) => e.title === '独立的全新事实')
  assert.ok(entry, 'the create must land in the index')
  assert.equal(entry.status, 'active')
  assert.equal(entry.reviewRisk, 0)
  assert.deepEqual(entry.reviewRiskReasons, [])
})

test('auto + create with needs_review still lands active; the flag only feeds the risk score', async () => {
  seedGlobalIndex({})
  setMode('auto')
  const result = await curator.commitCuratorOutput({
    memories: [cleanCreate({ needs_review: true, review_reason: '一次口误，证据偏薄' })],
  }, { job: { step: 'committing' } })
  assert.equal(result.created, 1, 'auto passes a flagged create by default')
  const entry = entryOf(state.loadGlobalIndex(), (e) => e.title === '独立的全新事实')
  assert.equal(entry.status, 'active')
  // needs_review 0.70 + review_reason 0.20 + single-evidence 0.10 was avoided by
  // passing two evidence items, so 0.70 + 0.20 = 0.90 exactly.
  assert.equal(entry.reviewRisk, 0.9)
  assert.ok(entry.reviewRiskReasons.includes('needs_review'))
  assert.ok(entry.reviewRiskReasons.includes('review_reason'))
  assert.equal(entry.reviewReason, undefined, 'an active entry carries no reviewReason')
  assert.equal(result.reviewRisk.flagged, 1, 'the >=0.70 entry is flagged in the summary')
  assert.equal(result.reviewRisk.max, 0.9)
})

test('auto + create with confidence 0.4 still lands active; low confidence only raises the risk score', async () => {
  seedGlobalIndex({})
  setMode('auto')
  const result = await curator.commitCuratorOutput({
    memories: [cleanCreate({ confidence: 0.4 })],
  }, { job: { step: 'committing' } })
  assert.equal(result.created, 1)
  const entry = entryOf(state.loadGlobalIndex(), (e) => e.title === '独立的全新事实')
  assert.equal(entry.status, 'active')
  assert.equal(entry.reviewRisk, 0.7, 'confidence<0.50 is +0.70; the two evidence items avoid the single-evidence bump')
  assert.ok(entry.reviewRiskReasons.includes('confidence<0.50'))
})

test('auto + merge with needs_review is held pending', async () => {
  seedGlobalIndex({ [TARGET]: TARGET_ENTRY })
  setMode('auto')
  const result = await curator.commitCuratorOutput({
    memories: [{
      op: 'merge', domain: 'general', track: 'memory', target_id: TARGET,
      title: '部署窗口的合并版本',
      content: '每周四凌晨两点到四点是固定的部署窗口，窗口内只允许灰度发布，全量要等监控确认。',
      confidence: 0.9, needs_review: true, review_reason: '模型标记待复核',
      evidence: [{ session_id: 's3', quote: '部署窗口只在周四凌晨' }],
    }],
  }, { job: { step: 'committing' } })
  assert.equal(result.merged, 0, 'a held merge is not counted as merged')
  assert.equal(result.pending, 1)
  assert.equal(result.files.length, 0, 'pending entries are never committed to the vector store')
  const index = state.loadGlobalIndex()
  const held = entryOf(index, (e) => e.status === 'pending_review')
  assert.ok(held, 'the merge must be held for review')
  assert.equal(held.conflictingWith, TARGET)
  // non-hard pending: the model's own reason wins over the generic fallback.
  assert.equal(held.reviewReason, '模型标记待复核')
  assert.equal(held.reviewRisk, 1.2, 'needs_review 0.70 + merge 0.20 + review_reason 0.20 + single evidence 0.10')
  assert.equal(index.entries[TARGET].status, 'active', 'a held merge never touches the target')
})

test('auto + conflict is pending in both modes with the hard reason', async () => {
  seedGlobalIndex({ [TARGET]: TARGET_ENTRY })
  setMode('auto')
  const result = await curator.commitCuratorOutput({
    memories: [{
      op: 'conflict', domain: 'general', track: 'memory', target_id: TARGET,
      title: '部署窗口的两个说法', content: '两个会话对部署窗口的说法不一致。',
      confidence: 0.9,
      evidence: [{ session_id: 's4', quote: '部署窗口是周四' }, { session_id: 's5', quote: '部署窗口是周五' }],
    }],
  }, { job: { step: 'committing' } })
  assert.equal(result.pending, 1)
  assert.equal(result.created, 0)
  const held = entryOf(state.loadGlobalIndex(), (e) => e.status === 'pending_review')
  assert.ok(held, 'a conflict is always held')
  assert.equal(held.reviewReason, 'conflict')
  assert.equal(held.reviewRisk, 2)
  assert.deepEqual(held.reviewRiskReasons, ['conflict'])
  assert.equal(held.conflictingWith, TARGET)
})

test('auto + missing evidence is pending with the hard reason', async () => {
  seedGlobalIndex({})
  setMode('auto')
  const result = await curator.commitCuratorOutput({
    memories: [{ op: 'create', domain: 'general', track: 'memory', title: '没有证据的说法', content: '模型没给引用。', confidence: 0.9 }],
  }, { job: { step: 'committing' } })
  assert.equal(result.created, 0)
  assert.equal(result.pending, 1)
  const held = entryOf(state.loadGlobalIndex(), (e) => e.status === 'pending_review')
  assert.ok(held)
  assert.equal(held.reviewReason, 'missing evidence')
  assert.equal(held.reviewRisk, 2)
})

test('review-all holds even a clean create', async () => {
  seedGlobalIndex({})
  setMode('review-all')
  const result = await curator.commitCuratorOutput({ memories: [cleanCreate()] }, { job: { step: 'committing' } })
  assert.equal(result.created, 0)
  assert.equal(result.pending, 1)
  const held = entryOf(state.loadGlobalIndex(), (e) => e.status === 'pending_review')
  assert.ok(held)
  // Not a hard gate and the model gave no reason: the generic threshold note.
  assert.equal(held.reviewReason, 'risk threshold')
  assert.equal(held.reviewRisk, 0, 'a clean hold carries risk 0, the mode alone caused the hold')
})

test('merge with a nonexistent target is skipped and never degrades into a create', async () => {
  seedGlobalIndex({ [TARGET]: TARGET_ENTRY })
  setMode('auto')
  const result = await curator.commitCuratorOutput({
    memories: [{
      op: 'merge', domain: 'general', track: 'memory', target_id: 'gmem-missing',
      title: '没有落点的合并', content: '这段内容绝不能变成一条新记忆。',
      confidence: 0.9,
      evidence: [{ session_id: 's6', quote: '合并的目标丢了' }],
    }],
  }, { job: { step: 'committing' } })
  assert.equal(result.created, 0, 'the §0.2 bug: a skipped merge must not continue as a create')
  assert.equal(result.merged, 0)
  assert.equal(result.pending, 0)
  assert.equal(result.files.length, 0)
  assert.equal(result.skipped.length, 1)
  assert.match(result.skipped[0].reason, /target not found: gmem-missing/)
  const index = state.loadGlobalIndex()
  assert.equal(entryOf(index, (e) => e.title === '没有落点的合并'), null, 'no new entry was written')
  assert.deepEqual(Object.keys(index.entries), [TARGET], 'the index gained nothing')
})

test('an unknown op is skipped instead of being forced into a create', async () => {
  seedGlobalIndex({})
  setMode('auto')
  const result = await curator.commitCuratorOutput({
    memories: [
      { op: 'frobnicate', domain: 'general', track: 'memory', title: '未知操作', content: '模型写错了 op 名。', confidence: 0.9, evidence: [{ session_id: 's7', quote: '未知' }] },
      // link 在 当前版本已进 OPS_ALLOWLIST（F1 落地），不再是 unknown op 的代表；
      // 这里改用真正不在名单里的 op，测试意图不变：未知 op 不得默认 create。
      { op: 'delete', domain: 'general', track: 'memory', title: '未接线的关联', content: '模型写错了另一个 op 名。', confidence: 0.9, evidence: [{ session_id: 's8', quote: '删除操作的原话记录' }] },
    ],
  }, { job: { step: 'committing' } })
  assert.equal(result.created, 0, 'unknown ops must not default to create')
  assert.equal(result.skipped.length, 2)
  assert.ok(result.skipped.every((item) => /unknown op/.test(item.reason)))
  assert.deepEqual(Object.keys(state.loadGlobalIndex().entries), [], 'nothing was written')
})

test('setSettings rejects a bogus curatorReviewMode and accepts review-all', async () => {
  await assert.rejects(
    () => rpc.dispatch({}, 'setSettings', { patch: { curatorReviewMode: 'bogus' } }),
    /invalid setting/,
    'the enum gate must reject unknown modes',
  )
  const accepted = await rpc.dispatch({}, 'setSettings', { patch: { curatorReviewMode: 'review-all' } })
  assert.equal(accepted.curatorReviewMode, 'review-all', 'the allowlisted mode persists')
  setMode('auto')
})

test('entries written before this version carry no reviewRisk and still read cleanly', async () => {
  seedGlobalIndex({ [TARGET]: TARGET_ENTRY })
  setMode('auto')
  const result = await curator.commitCuratorOutput({
    memories: [{
      op: 'supersede', domain: 'general', track: 'memory', target_id: TARGET,
      title: '部署窗口的替代版本', content: '部署窗口调整为周四凌晨的整段灰度时段。',
      confidence: 0.92,
      evidence: [{ session_id: 's9', quote: '窗口改成周四凌晨' }, { session_id: 's10', quote: '整段灰度时段一次性放开' }],
    }],
  }, { job: { step: 'committing' } })
  assert.equal(result.superseded, 1)
  const index = state.loadGlobalIndex()
  const oldEntry = index.entries[TARGET]
  assert.ok(oldEntry, 'the old entry is still there (superseded, never deleted)')
  assert.equal(Object.hasOwn(oldEntry, 'reviewRisk'), false, 'the old entry keeps its old shape')
  assert.equal(Object.hasOwn(oldEntry, 'reviewRiskReasons'), false)
  assert.equal(oldEntry.status, 'superseded')
  // Reading the mixed index through the default-value convention must not throw.
  for (const entry of Object.values(index.entries)) {
    assert.equal(typeof (entry.reviewRisk ?? 0), 'number')
    assert.ok(Array.isArray(entry.reviewRiskReasons ?? []))
  }
  const fresh = entryOf(index, (e) => e.status === 'active')
  assert.ok(fresh, 'the replacement landed active (risk 0.20 < 0.70)')
  assert.equal(fresh.reviewRisk, 0.2, 'supersede adds 0.20; two evidence items avoid the single-evidence bump')
})

test('reviewDecision unit: absorb risk and skip reasons follow §4.10 verbatim', () => {
  const index = { entries: { 'gmem-a': { status: 'active' } } }
  // absorb with >3 sources: +0.20; clean otherwise → auto passes at 0.20.
  const absorb = curator.reviewDecision({
    m: { confidence: 0.9, source_ids: ['a', 'b', 'c', 'd'] },
    op: 'absorb', evidence: [{ session_id: 's', quote: 'q' }, { session_id: 's2', quote: 'q2' }],
    targetId: 'gmem-a', index, mode: 'auto',
  })
  assert.equal(absorb.review, false)
  assert.equal(absorb.risk, 0.2)
  assert.ok(absorb.reasons.includes('absorb>3 sources'))
  // absorb with a missing target is a skip, never a pending.
  const noTarget = curator.reviewDecision({
    m: { confidence: 0.9 }, op: 'absorb',
    evidence: [{ session_id: 's', quote: 'q' }],
    targetId: '', index, mode: 'auto',
  })
  assert.equal(noTarget.skip, true)
  assert.match(noTarget.reason, /target not found: \(empty\)/)
  // Hard gates cap at risk 2 regardless of mode.
  const conflictReviewAll = curator.reviewDecision({
    m: {}, op: 'conflict', evidence: [{ session_id: 's', quote: 'q' }],
    targetId: 'gmem-a', index, mode: 'review-all',
  })
  assert.equal(conflictReviewAll.review, true)
  assert.equal(conflictReviewAll.risk, 2)
  assert.equal(conflictReviewAll.hard, true)
})
