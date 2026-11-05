import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'

// Global links (spec §3.2/§4.9/§6.6): symmetric/directed writes, opId
// idempotency, caps, evidence grounding, cross-domain rules, review-mode
// behaviour, and removal. Unit level through lib/global-graph.js, integration
// level through commitCuratorOutput's link branch — same hermetic rig as
// tests/curator-commit.test.mjs.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-curator-link-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

globalThis.__curatorLinkTest = {
  async commit() { return { ok: true } },
  async forget() { return { deleted: 1, segments: 1 } },
  async retrieve() { return { files: [], segments: [], resources: [], raw: null } },
  async listFiles() { return { recall_files: [], resources: [], raw: null } },
}
const memuSource = 'const bridge = globalThis.__curatorLinkTest;'
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
const graph = await import('../lib/global-graph.js')
const evidence = await import('../lib/curator-evidence.js')
const activity = await import('../lib/activity-log.js')

test.after(async () => {
  try { hooks.unregister?.() } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

const sessionCorpus = evidence.buildEvidenceCorpus([
  { id: 's1', transcript: 'User: 部署窗口只在周四凌晨两点到四点开放，其余时间不发版。' },
])

const A = () => ({
  track: 'memory', domain: 'general', status: 'active', title: '部署窗口约定',
  content: '每周四凌晨两点到四点是固定的部署窗口，窗口内只允许灰度发布。',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const B = (over = {}) => ({
  track: 'memory', domain: 'general', status: 'active', title: '灰度发布规则',
  content: '窗口内的发布全部走灰度，全量要等监控确认。',
  createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...over,
})

function seed(entries) {
  state.saveGlobalIndex({ version: 1, entries: structuredClone(entries) })
}

const linkOp = (over = {}) => ({
  op: 'link', from_id: 'gmem-a', to_id: 'gmem-b', kind: 'related',
  note: '两条记忆同讲部署窗口：部署窗口只在周四凌晨两点到四点开放',
  confidence: 0.8,
  evidence: [{ session_id: 's1', quote: '部署窗口只在周四凌晨两点到四点开放' }],
  ...over,
})

const validateArgs = (over = {}) => ({
  index: state.loadGlobalIndex(),
  fromId: 'gmem-a', toId: 'gmem-b', kind: 'related',
  note: '两条记忆同讲部署窗口：部署窗口只在周四凌晨两点到四点开放',
  confidence: 0.8,
  evidence: [{ session_id: 's1', quote: '部署窗口只在周四凌晨两点到四点开放' }],
  sessionCorpus,
  ...over,
})

// —— validateGlobalLink ——

test('validateGlobalLink: related is symmetric — both ends carry the same id and opId', () => {
  seed({ 'gmem-a': A(), 'gmem-b': B() })
  const verdict = graph.validateGlobalLink(validateArgs())
  assert.equal(verdict.ok, true, verdict.reason || '')
  const writes = [verdict]
  const { applied } = graph.applyGlobalLinks(JSON.parse(JSON.stringify(state.loadGlobalIndex().entries)), writes)
  assert.equal(applied.length, 1)
  seed({
    'gmem-a': { ...A(), links: [{ ...verdict.link, to: 'gmem-b' }] },
    'gmem-b': { ...B(), links: [{ ...verdict.link, to: 'gmem-a' }] },
  })
  const a = state.loadGlobalIndex().entries['gmem-a']
  const b = state.loadGlobalIndex().entries['gmem-b']
  assert.equal(a.links[0].id, b.links[0].id)
  assert.equal(a.links[0].opId, b.links[0].opId)
  assert.equal(a.links[0].to, 'gmem-b')
  assert.equal(b.links[0].to, 'gmem-a')
  assert.match(a.links[0].id, /^lnk_[0-9a-f]{16}$/)
})

test('validateGlobalLink: a contradictory pair is rejected instead of becoming a link', () => {
  const sameTitle = A().title
  seed({
    'gmem-a': A(),
    'gmem-b': B({ title: sameTitle, content: '部署窗口在周五，窗口内禁止任何灰度发布。' }),
  })
  const verdict = graph.validateGlobalLink(validateArgs())
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /conflict pair detected/)
})

test('link writes an audit trail on both ends; unlink appends a removal event', () => {
  seed({ 'gmem-a': A(), 'gmem-b': B() })
  const verdict = graph.validateGlobalLink(validateArgs())
  assert.equal(verdict.ok, true, verdict.reason || '')
  const entries = JSON.parse(JSON.stringify(state.loadGlobalIndex().entries))
  graph.applyGlobalLinks(entries, [verdict])
  assert.equal(entries['gmem-a'].auditTrail?.at(-1)?.op, 'link')
  assert.equal(entries['gmem-b'].auditTrail?.at(-1)?.op, 'link')
  assert.equal(entries['gmem-a'].auditTrail.at(-1).linkId, verdict.link.id)
  state.saveGlobalIndex({ version: 1, entries })
  const removed = graph.removeGlobalLink({ linkId: verdict.link.id })
  assert.equal(removed.removed, 2)
  const index = state.loadGlobalIndex()
  assert.equal(index.entries['gmem-a'].auditTrail.at(-1).op, 'unlink')
  assert.equal(index.entries['gmem-b'].auditTrail.at(-1).op, 'unlink')
})

test('validateGlobalLink: refines/supports are directed — only the source end stores the edge', () => {
  seed({ 'gmem-a': A(), 'gmem-b': B() })
  const verdict = graph.validateGlobalLink(validateArgs({ kind: 'supports' }))
  assert.equal(verdict.ok, true, verdict.reason || '')
  assert.equal(verdict.symmetric, false)
  const entries = { 'gmem-a': A(), 'gmem-b': B() }
  const { applied } = graph.applyGlobalLinks(entries, [verdict])
  assert.equal(applied.length, 1)
  assert.equal(entries['gmem-a'].links.length, 1)
  assert.equal(entries['gmem-b'].links, undefined, 'the target end gains nothing for a directed edge')
  // opId uses the ordered pair, so swapping ends changes it
  const swapped = graph.validateGlobalLink(validateArgs({ kind: 'supports', fromId: 'gmem-b', toId: 'gmem-a' }))
  assert.notEqual(swapped.link.opId, verdict.link.opId)
})

test('validateGlobalLink: rejections — endpoints, self, kinds, note bounds, confidence, evidence', () => {
  seed({ 'gmem-a': A(), 'gmem-b': B(), 'gmem-dead': B({ status: 'archived' }) })
  const cases = [
    [{ ...validateArgs(), fromId: 'gmem-missing' }, /endpoint not found/],
    [{ ...validateArgs(), toId: 'gmem-dead' }, /endpoint not active/],
    [{ ...validateArgs(), fromId: 'gmem-a', toId: 'gmem-a' }, /self link/],
    [{ ...validateArgs(), kind: 'contradicts' }, /unknown kind/],
    [{ ...validateArgs(), note: '短' }, /note length 1 outside 8-500/],
    [{ ...validateArgs(), note: 'x'.repeat(501) }, /note length 501 outside 8-500/],
    [{ ...validateArgs(), confidence: 0.4 }, /confidence 0.4 outside 0.5-1/],
    [{ ...validateArgs(), evidence: [] }, /evidence must be 1-3/],
    [{ ...validateArgs(), evidence: [{ session_id: 's1', quote: 'nope' }, { session_id: 's1', quote: '部署窗口只在周四凌晨两点到四点开放' }, { session_id: 's1', quote: '部署窗口只在周四凌晨两点到四点开放' }, { session_id: 's1', quote: '部署窗口只在周四凌晨两点到四点开放' }] }, /evidence must be 1-3/],
    [{ ...validateArgs(), evidence: [{ session_id: 's9', quote: '部署窗口只在周四凌晨两点到四点开放' }] }, /evidence not grounded/],
    [{ ...validateArgs(), note: '这句注记没有引用任何原话内容' }, /note must quote at least one grounded evidence verbatim/],
  ]
  for (const [args, expected] of cases) {
    const verdict = graph.validateGlobalLink(args)
    assert.equal(verdict.ok, false, `${JSON.stringify(args.note || args.kind)} should be rejected`)
    assert.match(verdict.reason, expected)
  }
})

test('validateGlobalLink: cross-domain links must be related; rp and coding never link', () => {
  seed({
    'gmem-a': A(),
    'gmem-b': B({ domain: 'coding' }),
    'gmem-rp': B({ domain: 'rp' }),
  })
  const refines = graph.validateGlobalLink(validateArgs({ kind: 'refines', toId: 'gmem-b' }))
  assert.equal(refines.ok, false)
  assert.match(refines.reason, /cross-domain links must be related/)
  const clash = graph.validateGlobalLink(validateArgs({ toId: 'gmem-rp' }))
  assert.equal(clash.ok, true, 'general↔rp cross-domain related is allowed')
  const rpCoding = graph.validateGlobalLink(validateArgs({ fromId: 'gmem-b', toId: 'gmem-rp' }))
  assert.equal(rpCoding.ok, false)
  assert.match(rpCoding.reason, /rp and coding never link/)
})

test('applyGlobalLinks: (to,kind) idempotent; cap 20 per end; one full end blocks a symmetric pair', () => {
  const third = B({ title: '第三条', content: '另一条不相关的记忆内容，用来测上限。' })
  seed({ 'gmem-a': A(), 'gmem-b': B(), 'gmem-c': third })
  const first = graph.validateGlobalLink(validateArgs())
  const entries = { 'gmem-a': A(), 'gmem-b': B(), 'gmem-c': structuredClone(third) }
  graph.applyGlobalLinks(entries, [first])
  // same (to, kind) again → skipped
  const again = graph.applyGlobalLinks(entries, [first])
  assert.equal(again.applied.length, 0)
  assert.match(again.skipped[0].reason, /duplicate link/)
  // fill gmem-a to 20 links → the next link out of gmem-a hits the cap
  entries['gmem-a'].links.push(...Array.from({ length: 19 }, (_, i) => ({ id: `lnk_pad_${i}`, to: `pad-${i}`, kind: 'related' })))
  assert.equal(entries['gmem-a'].links.length, 20)
  const capped = graph.validateGlobalLink(validateArgs({ index: { entries }, toId: 'gmem-c' }))
  assert.equal(capped.ok, false)
  assert.match(capped.reason, /link cap reached on gmem-a/)
  // a forced write against the full end blocks BOTH ends of a symmetric pair
  const forced = { fromId: 'gmem-a', toId: 'gmem-b', kind: 'related', symmetric: true, link: first.link }
  const blocked = graph.applyGlobalLinks(entries, [forced])
  assert.equal(blocked.applied.length, 0)
  assert.equal(entries['gmem-b'].links.length, 1, 'the non-full end gains nothing when the other end is full')
})

test('applyGlobalLinks: directed edges reject cycles within depth 3', () => {
  const entries = {
    'n1': { ...A(), links: [{ id: 'lnk_1', to: 'n2', kind: 'refines' }] },
    'n2': { ...B(), links: [{ id: 'lnk_2', to: 'n3', kind: 'refines' }] },
    'n3': { ...B({ title: 'C' }), links: [] },
  }
  // n3 → n1 would close n1→n2→n3→n1
  const cyclic = { fromId: 'n3', toId: 'n1', kind: 'refines', symmetric: false, link: { id: 'lnk_x', opId: 'x', to: 'n1', kind: 'refines', note: 'x', confidence: 0.8, evidence: [], createdAt: 'now' } }
  const { applied, skipped } = graph.applyGlobalLinks(entries, [cyclic])
  assert.equal(applied.length, 0)
  assert.match(skipped[0].reason, /directed cycle/)
  // depth 4 is out of the check's reach by design (§4.9: depth ≤3)
  const deep = {
    'd1': { ...A(), links: [{ id: 'l1', to: 'd2', kind: 'refines' }] },
    'd2': { ...B(), links: [{ id: 'l2', to: 'd3', kind: 'refines' }] },
    'd3': { ...B(), links: [{ id: 'l3', to: 'd4', kind: 'refines' }] },
    'd4': { ...B(), links: [] },
  }
  assert.equal(graph.directedReaches(deep, 'd4', 'd1', 3), false, 'a depth-4 path is beyond the cycle check')
})

test('removeGlobalLink: deletes both ends of a symmetric edge and only metadata', () => {
  seed({
    'gmem-a': { ...A(), links: [{ id: 'lnk_sym', opId: 'op1', to: 'gmem-b', kind: 'related' }, { id: 'lnk_keep', to: 'gmem-c', kind: 'related' }] },
    'gmem-b': { ...B(), links: [{ id: 'lnk_sym', opId: 'op1', to: 'gmem-a', kind: 'related' }] },
  })
  const result = graph.removeGlobalLink({ linkId: 'lnk_sym' })
  assert.equal(result.removed, 2)
  assert.deepEqual(result.entries.sort(), ['gmem-a', 'gmem-b'])
  const index = state.loadGlobalIndex()
  assert.deepEqual(index.entries['gmem-a'].links, [{ id: 'lnk_keep', to: 'gmem-c', kind: 'related' }])
  assert.equal(index.entries['gmem-b'].links.length, 0)
  assert.equal(index.entries['gmem-a'].status, 'active', 'removal never touches entry status')
  const miss = graph.removeGlobalLink({ linkId: 'lnk_absent' })
  assert.equal(miss.removed, 0)
})

// —— commitCuratorOutput link branch ——

test('commitCuratorOutput: a grounded link lands in both modes and never enters files', async () => {
  seed({ 'gmem-a': A(), 'gmem-b': B() })
  state.updateSettings({ curatorReviewMode: 'review-all' })
  const result = await curator.commitCuratorOutput({ memories: [linkOp()] }, { job: { step: 'committing' }, sessionCorpus })
  assert.equal(result.linked, 1)
  assert.equal(result.files.length, 0, 'links never enter the vector commit')
  assert.equal(result.pending, 0, 'review-all does not hold links (C2)')
  const index = state.loadGlobalIndex()
  assert.equal(index.entries['gmem-a'].links[0].to, 'gmem-b')
  const event = activity.listEvents({ kind: 'curate' }).find((item) => item.detail?.op === 'link')
  assert.ok(event, 'each applied link gets its own activity record')
  assert.equal(event.detail.kind, 'related')
  assert.equal(event.detail.from, 'gmem-a')
  assert.match(event.detail.linkId, /^lnk_/)
  state.updateSettings({ curatorReviewMode: 'auto' })
})

test('commitCuratorOutput: ungrounded evidence means no edge and a skipped entry (C10)', async () => {
  seed({ 'gmem-a': A(), 'gmem-b': B() })
  // grounded corpus present but the quote is fabricated
  const bad = await curator.commitCuratorOutput({
    memories: [linkOp({ evidence: [{ session_id: 's1', quote: '凭空编造的引用根本不在会话里' }] })],
  }, { job: { step: 'committing' }, sessionCorpus })
  assert.equal(bad.linked, 0)
  assert.equal(bad.skipped.length, 1)
  assert.match(bad.skipped[0].reason, /link rejected/)
  // no corpus at all (direct call): shape-valid evidence stays unverified and lands
  const direct = await curator.commitCuratorOutput({ memories: [linkOp()] }, { job: { step: 'committing' } })
  assert.equal(direct.linked, 1)
  // empty evidence is always rejected
  const empty = await curator.commitCuratorOutput({ memories: [linkOp({ evidence: [] })] }, { job: { step: 'committing' } })
  assert.equal(empty.linked, 0)
  assert.match(empty.skipped[0].reason, /evidence must be 1-3/)
})

test('commitCuratorOutput: duplicate (to,kind) is idempotent and links ride the same transaction as content', async () => {
  seed({ 'gmem-a': A(), 'gmem-b': B(), 'gmem-c': B({ title: '第三条', content: '另一条不相关的记忆内容，用来测上限。' }) })
  const firstOutput = { memories: [structuredClone(linkOp())] }
  const result = await curator.commitCuratorOutput(firstOutput, { job: { step: 'committing' }, sessionCorpus })
  assert.equal(result.linked, 1)
  const again = await curator.commitCuratorOutput(firstOutput, { job: { step: 'committing' }, sessionCorpus })
  assert.equal(again.linked, 0, 'the second run is fully idempotent')
  assert.equal(again.skipped.length, 1)
  // links + a create share one commit (same updateGlobalIndex transaction)
  const mixed = await curator.commitCuratorOutput({
    memories: [
      linkOp({ from_id: 'gmem-b', to_id: 'gmem-c' }),
      {
        op: 'create', domain: 'general', track: 'memory', title: '全新独立事实',
        content: '用户倾向在代码评审里先看测试再看过渡逻辑。',
        confidence: 0.9,
        evidence: [{ session_id: 's1', quote: '部署窗口只在周四凌晨两点到四点开放' }],
      },
    ],
  }, { job: { step: 'committing' }, sessionCorpus })
  assert.equal(mixed.linked, 1)
  assert.equal(mixed.created, 1)
})

test('commitCuratorOutput: absorb ops now flow into commitCuratorPlans (wired; missing target skips)', async () => {
  // F2 接线后：absorb 不再走 relay skip，而是由 commitCuratorPlans 直接提交。
  // 空索引里 target 不存在 → 提交层按校验顺序跳过（不是 create，也不是 relay）。
  seed({})
  const result = await curator.commitCuratorOutput({
    memories: [{ op: 'absorb', target_id: 'gmem-a', source_ids: ['gmem-b'], title: 'x', content: 'y', confidence: 0.9, evidence: [{ session_id: 's1', quote: 'zzzzzz' }] }],
  }, { job: { step: 'committing' } })
  assert.equal(result.created, 0, 'absorb never falls through to create')
  assert.equal(Object.keys(state.loadGlobalIndex().entries).length, 0, 'nothing lands without a real target')
  assert.ok(result.skipped.length >= 1, 'the dead-end absorb is reported in skipped')
  assert.ok(!result.skipped.some((item) => /absorb lands in a later pass/.test(item.reason)), 'the relay reason is gone: absorb is wired')
})
