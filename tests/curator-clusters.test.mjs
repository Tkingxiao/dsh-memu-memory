import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'

// Candidate clusters (spec §4.4) + curator context packing (§4.5).
//
// buildCandidateClusters is pure (text-retrieval), but packCuratorIndexContext /
// packCuratorClusterContext live in curator.js, which pulls the module stack —
// so this file uses the same hermetic rig as tests/curator-commit.test.mjs:
// './memu.js' is replaced before production modules load and DSH_MEMU_HOME
// points at a temp root.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-clusters-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

globalThis.__curatorClusterTest = {
  async commit() { return { ok: true } },
  async forget() { return { deleted: 1, segments: 1 } },
  async retrieve() { return { files: [], segments: [], resources: [], raw: null } },
  async listFiles() { return { recall_files: [], resources: [], raw: null } },
}
const memuSource = 'const bridge = globalThis.__curatorClusterTest;'
  + 'export const commit = (args) => bridge.commit(args), forget = (args) => bridge.forget(args),'
  + 'retrieve = (args) => bridge.retrieve(args), listFiles = (args) => bridge.listFiles(args),'
  + 'closeMemuResident = () => 0, prewarmMemuResident = async () => false;'
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './memu.js') return { url: 'data:text/javascript,' + encodeURIComponent(memuSource), shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const { buildCandidateClusters } = await import('../lib/text-retrieval.js')
const curator = await import('../lib/curator.js')

test.after(async () => {
  try { hooks.unregister?.() } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

const entryOf = (id, title, content, extra = {}) => ({
  id, track: 'memory', domain: 'general', status: 'active',
  title, content, updatedAt: '2026-01-01T00:00:00.000Z', ...extra,
})

const index = (entries) => ({ version: 1, entries: Object.fromEntries(entries.map((e) => [e.id, e])) })

// —— blocking ——

// 1440 distinct CJK words; each filler picks 6 with its own PRNG stream, so two
// fillers share at most a stray bigram (never enough Dice for an edge) and the
// pair under test is the only real signal in the corpus. The one-char title
// keeps both probe entries' token sets to their content words ('x' is dropped
// by tokenize) while the title bigrams keep Dice high.
const VOCAB = []
for (const first of '甲乙丙丁戊己庚辛壬癸') {
  for (const second of '子丑寅卯辰巳午未申酉戌亥') {
    for (const third of '東南西北中發白裏乾坤') VOCAB.push(`词${first}${second}${third}`)
  }
}
function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function fillers(count, from = 0) {
  const out = []
  for (let i = from + 1; i <= from + count; i++) {
    const random = mulberry32(i * 7919)
    const deck = [...VOCAB.keys()]
    const words = []
    for (let t = 0; t < 6; t++) {
      const pick = Math.floor(random() * deck.length)
      words.push(VOCAB[deck.splice(pick, 1)[0]])
    }
    out.push(entryOf(`filler-${i}`, 'x', words.join('、') + '。'))
  }
  return out
}

test('N=300 exact all-pairs still cluster a high-Dice one-shared-token pair', () => {
  const entries = [
    entryOf('deploy-a', 'x', 'deploy cache'),
    entryOf('deploy-b', 'x', 'redeploy cache'),
    ...fillers(298),
  ]
  const { clusters } = buildCandidateClusters(index(entries))
  const pair = clusters.find((c) => c.members.some((m) => m.id === 'deploy-a'))
  assert.ok(pair, 'at N<=300 the exact pass scores every same-track pair')
  assert.deepEqual(pair.members.map((m) => m.id).sort(), ['deploy-a', 'deploy-b'])
})

test('N=301 switches to inverted blocking: the same pair shares only 1 token and must not cluster', () => {
  const entries = [
    entryOf('deploy-a', '部署', 'deploy cache'),
    entryOf('deploy-b', '锚点', 'redeploy cache'),
    ...fillers(299),
  ]
  const { clusters } = buildCandidateClusters(index(entries))
  assert.equal(clusters.length, 0, 'shared token count 1 < blockMinShared 2 keeps the pair out')
})

// —— all-pairs clique growth ——

// A-B ≈0.68, B-C ≈0.82, A-C ≈0.39: whichever edge seeds the cluster, the third
// member always violates the all-pairs constraint against the opposite side.
const chainIndex = () => index([
  entryOf('A', '站会要点', '站会先过昨日进展，再排今日任务，最后收集阻塞。'),
  entryOf('B', '站会要点', '站会先过昨日进展，然后直接进入深挖环节，限时十分钟。'),
  entryOf('C', '站会要点', '站会先过昨日进展，然后直接进入深挖环节。'),
])

test('all-pairs constraint: an A-B-C chain never becomes one cluster', () => {
  const { clusters } = buildCandidateClusters(chainIndex())
  assert.ok(clusters.length >= 1, 'the two strong edges must form at least one cluster')
  for (const cluster of clusters) {
    const ids = cluster.members.map((m) => m.id)
    assert.ok(!ids.includes('A') || !ids.includes('C'), `A and C must never cohabit: ${ids.join(',')}`)
  }
  // every kept edge honours the floor pair-wise, not just transitively
  for (const cluster of clusters) {
    for (const [key, score] of Object.entries(cluster.pair_scores)) {
      assert.ok(score >= 0.55, `in-cluster pair ${key} below floor: ${score}`)
    }
  }
})

test('all-pairs constraint: deterministic across runs', () => {
  assert.deepEqual(buildCandidateClusters(chainIndex()), buildCandidateClusters(chainIndex()))
})

// —— medoid ——

test('medoid is the member with the highest average pairwise score; ties break updatedAt desc then id asc', () => {
  const entries = [
    entryOf('t1', '缓存策略', 'Redis 缓存统一设置 30 秒过期，过期回源并写回缓存。', { updatedAt: '2026-01-01T00:00:00.000Z' }),
    entryOf('t2', '缓存策略', 'Redis 缓存统一设置 30 秒过期，过期回源并写回缓存集合。', { updatedAt: '2026-01-02T00:00:00.000Z' }),
    entryOf('t3', '缓存策略', 'Redis 缓存统一设置 30 秒过期，过期回源写回缓存集合。', { updatedAt: '2026-01-03T00:00:00.000Z' }),
  ]
  const { clusters } = buildCandidateClusters(index(entries))
  assert.equal(clusters.length, 1)
  const cluster = clusters[0]
  assert.equal(cluster.members.length, 3)
  // medoid: recompute averages from the published upper-triangle pair scores
  const scores = cluster.pair_scores
  const pairsOf = (id) => Object.entries(scores).filter(([key]) => key.includes(id))
  const avg = (id) => pairsOf(id).reduce((sum, [, value]) => sum + value, 0) / pairsOf(id).length
  const best = cluster.members.map((m) => m.id).sort((x, y) => avg(y) - avg(x) || String(y).localeCompare(String(x)))[0]
  assert.equal(cluster.medoid_id, best)
  assert.ok(cluster.avg_score >= 0.82, `a tight triple must average in the absorb band, got ${cluster.avg_score}`)
  assert.equal(cluster.suggested_op, 'absorb', '3 members, same domain, avg >=0.82')
  assert.equal(cluster.cluster_id, 'cl-1')
  assert.equal(Object.keys(scores).length, 3, 'upper triangle only')
})

test('a 2-member cluster never suggests absorb even at duplicate-level similarity', () => {
  const { clusters } = buildCandidateClusters(index([
    entryOf('p1', '发布清单', '发版前按清单逐项确认版本号、changelog 和回归标记。'),
    entryOf('p2', '发布清单', '发版前按清单逐项确认版本号、changelog与回归标记。'),
  ]))
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0].members.length, 2)
  assert.equal(clusters[0].suggested_op, 'link')
})

test('medoid average below the pair floor drops the whole cluster (defensive, via lowered minPairScore)', () => {
  const { clusters } = buildCandidateClusters(index([
    entryOf('w1', '杂项', '条目甲的内容讲预算审批流程。'),
    entryOf('w2', '杂项', '条目甲的内容讲预算审批与报销流程。'),
    entryOf('w3', '杂项', '条目甲的内容讲报销与发票流程。'),
  ]), { minPairScore: 0.3 })
  for (const cluster of clusters) {
    assert.ok(cluster.avg_score >= 0.55 || cluster.medoid_avg_dropped !== true)
  }
  // with the floor at 0.3 edges form, but a medoid averaging <0.55 must be dropped
  const weak = clusters.filter((c) => c.avg_score < 0.55)
  assert.equal(weak.length, 0, 'no cluster below the 0.55 output floor survives')
})

test('clusters never span tracks', () => {
  const { clusters } = buildCandidateClusters(index([
    entryOf('m1', '发布清单', '发版前按清单逐项确认版本号、changelog 和回归标记。', { track: 'memory' }),
    entryOf('s1', '发布清单', '发版前按清单逐项确认版本号、changelog 与回归标记。', { track: 'skill' }),
  ]))
  assert.equal(clusters.length, 0)
})

test('>12 clusters are truncated by avg_score desc', () => {
  const entries = []
  for (let i = 1; i <= 15; i++) {
    entries.push(entryOf(`pair-${i}-a`, `主题${i}`, `主题甲${i}：独有词${i}${i}的内容陈述。`))
    entries.push(entryOf(`pair-${i}-b`, `主题${i}`, `主题甲${i}：独有词${i}${i}的内容陈述变体。`))
  }
  const { clusters } = buildCandidateClusters(index(entries))
  assert.equal(clusters.length, 12)
  const avgs = clusters.map((c) => c.avg_score)
  assert.deepEqual([...avgs].sort((a, b) => b - a), avgs, 'output stays avg_score-descending')
  for (const cluster of clusters) assert.equal(cluster.suggested_op, 'link')
})

test('recentLimit cuts the pool to the most recent entries and flags truncation', () => {
  const partner = entryOf('partner-old', '旧站会', '站会先过昨日进展，再排今日任务，最后收集阻塞。', { updatedAt: '2025-06-01T00:00:00.000Z' })
  const seed = entryOf('seed-new', '旧站会', '站会先过昨日进展，再排今日任务，最后收集阻塞项。', { updatedAt: '2026-06-01T00:00:00.000Z' })
  const entries = [partner, seed, ...fillers(58)]
  const result = buildCandidateClusters(index(entries), { recentLimit: 30 })
  assert.equal(result.truncated, true)
  assert.equal(result.scanned, 30)
  assert.equal(result.clusters.length, 0, 'the older partner fell outside the recent window')
})

// —— §4.5 context packing ——

test('packCuratorIndexContext: deterministic, budgeted, BM25-ordered, archived out / pending in', () => {
  const entries = {
    'gmem-hot': entryOf('gmem-hot', '部署窗口', '每周四凌晨两点到四点是固定的部署窗口，窗口内只允许灰度发布。'),
    'gmem-cold': entryOf('gmem-cold', '摄影器材', '用户的相机是全画幅微单，常用 35mm 定焦。'),
    'gmem-pending': entryOf('gmem-pending', '部署告警', '部署失败要发告警到值班群。', { status: 'pending_review', updatedAt: '2026-02-01T00:00:00.000Z' }),
    'gmem-archived': entryOf('gmem-archived', '旧部署窗口', '旧窗口已废弃不用。', { status: 'archived' }),
    'gmem-linked': entryOf('gmem-linked', '回滚流程', '窗口结束前完成回滚。', { links: [{ id: 'lnk_1', to: 'gmem-hot', kind: 'related' }, { id: 'lnk_2', to: 'gmem-x', kind: 'refines' }] }),
  }
  const sessionText = '这次会话都在讨论部署窗口与灰度发布的安排'
  const pack1 = curator.packCuratorIndexContext({ index: { entries }, sessionText })
  const pack2 = curator.packCuratorIndexContext({ index: { entries }, sessionText })
  assert.deepEqual(pack1, pack2)
  const ids = pack1.entries.map((e) => e.id)
  assert.ok(ids.includes('gmem-hot'), 'the BM25-best entry ranks first')
  assert.equal(ids[0], 'gmem-hot')
  assert.ok(ids.includes('gmem-pending'), 'pending_review stays in the pool')
  assert.ok(!ids.includes('gmem-archived'), 'archived entries are filtered')
  const linked = pack1.entries.find((e) => e.id === 'gmem-linked')
  assert.equal(linked.linkCount, 2)
  assert.deepEqual(linked.linkedTo, [
    { to: 'gmem-hot', kind: 'related' },
    { to: 'gmem-x', kind: 'refines' },
  ], 'linkedTo carries the first 5 links without notes')
  const hot = pack1.entries.find((e) => e.id === 'gmem-hot')
  assert.ok(hot.content.includes('灰度发布'), 'content survives truncation at 900/600 chars')
  assert.ok(pack1.tokens <= 4000, `index budget respected, got ${pack1.tokens}`)
})

test('packCuratorIndexContext: a tiny budget drops low-scoring entries instead of truncating JSON', () => {
  const entries = {
    'gmem-a': entryOf('gmem-a', '部署窗口', '每周四凌晨两点到四点是固定的部署窗口，窗口内只允许灰度发布。'),
    'gmem-b': entryOf('gmem-b', '摄影器材', '用户的相机是全画幅微单，常用 35mm 定焦。'),
    'gmem-c': entryOf('gmem-c', '咖啡偏好', '用户下午的咖啡只喝美式，上午喝拿铁。'),
  }
  const packed = curator.packCuratorIndexContext({ index: { entries }, sessionText: '部署窗口 灰度发布', tokenBudget: 120 })
  assert.ok(packed.entries.length < 3, `a 120-token budget must drop entries, kept ${packed.entries.length}`)
  assert.equal(packed.entries[0].id, 'gmem-a', 'the best-scoring entry survives a tiny budget')
  assert.equal(packed.omitted, 3 - packed.entries.length)
})

test('packCuratorClusterContext: budget 2000 keeps whole clusters, drops the lowest scores', () => {
  const clusterResult = buildCandidateClusters(index([
    entryOf('k1', '缓存策略', 'Redis 缓存统一设置 30 秒过期，过期回源并写回缓存。'),
    entryOf('k2', '缓存策略', 'Redis 缓存统一设置 30 秒过期，过期回源并写回缓存集合。'),
    entryOf('k3', '缓存策略', 'Redis 缓存统一设置 30 秒过期，过期回源写回缓存集合。'),
    entryOf('j1', '发布清单', '发版前按清单逐项确认版本号、changelog 和回归标记。'),
    entryOf('j2', '发布清单', '发版前按清单逐项确认版本号、changelog与回归标记。'),
  ]))
  assert.equal(clusterResult.clusters.length, 2)
  const packed = curator.packCuratorClusterContext(clusterResult)
  assert.deepEqual(packed.clusters.map((c) => c.cluster_id), clusterResult.clusters.map((c) => c.cluster_id))
  assert.ok(packed.tokens <= 2000)
  assert.equal(packed.truncated, false)
  const rendered = packed.clusters[0]
  assert.ok(rendered.members[0].content.length <= 301, 'cluster member content is cut to 300 chars')
  for (const score of Object.values(rendered.pair_scores)) {
    assert.equal(Math.round(score * 100) / 100, score, 'pair_scores keep 2 decimals')
  }
  const squeezed = curator.packCuratorClusterContext(clusterResult, { tokenBudget: 100 })
  assert.equal(squeezed.clusters.length, 1, 'a 100-token budget keeps only the best cluster')
  assert.equal(squeezed.omitted, 1)
  assert.equal(squeezed.truncated, true)
})
