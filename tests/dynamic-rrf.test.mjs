import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RRF_DYNAMIC,
  RRF_K,
  RRF_W_BM25,
  RRF_W_DICE,
  RRF_W_ENTITY,
  RECENCY_TERMS,
  computeRRFWeights,
} from '../lib/curator-policy.js'
import { buildCorpus, rankPairCandidates } from '../lib/text-retrieval.js'

// —— 召回升级 P0-2：动态 RRF 权重 ——
// 权重数字单一来源 lib/curator-policy.js；开关 RRF_DYNAMIC 恒为 const，
// ESM 不可运行时翻转，因此「开关关闭 = 静态路径」的等效性用两条证据覆盖：
// (1) computeRRFWeights 对普通查询精确返回静态表常量（动态路径退化为静态）；
// (2) rankPairCandidates 在普通查询下产出的 rrf 与静态三路公式逐位相等。

const STATIC_WEIGHTS = { bm25: RRF_W_BM25, dice: RRF_W_DICE, entity: RRF_W_ENTITY }

function sumOf(weights) {
  return Object.values(weights).reduce((a, b) => a + b, 0)
}

// —— computeRRFWeights：权重形状 ——

test('近期查询返回含 recency 的权重组且和为 1（设计稿 §4.2 数值）', () => {
  const weights = computeRRFWeights({ title: '最近的部署', content: '昨天更新了缓存策略' }, { size: 3 })
  assert.deepEqual(weights, { bm25: 0.3, dice: 0.3, entity: 0.2, recency: 0.2 })
  assert.ok(Math.abs(sumOf(weights) - 1) < 1e-9)
})

test('近期词典（中英）逐词都能触发 recency 通道，且不依赖分词开关口径', () => {
  for (const term of RECENCY_TERMS) {
    const weights = computeRRFWeights({ title: term, content: '其他内容' }, { size: 3 })
    assert.ok(weights.recency != null, `词条 ${term} 必须触发 recency`)
    assert.ok(Math.abs(sumOf(weights) - 1) < 1e-9, `词条 ${term} 权重和必须为 1`)
  }
})

test('coding 域 entity 提权：×1.5 后归一化，entity 追平 dice、bm25 降权', () => {
  const weights = computeRRFWeights({ title: '部署脚本', content: 'redis 配置调整', domain: 'coding' }, { size: 3 })
  assert.ok(weights.entity > 0.25, `entity 应从 0.2 提到 ~0.2727，got ${weights.entity}`)
  assert.ok(Math.abs(weights.entity - weights.dice) < 1e-9, 'entity 与 dice 同为 0.3/1.1')
  assert.ok(weights.bm25 < RRF_W_BM25, '归一化后 bm25 低于静态值')
  assert.ok(weights.recency == null, '非近期查询不加第四路')
  assert.ok(Math.abs(sumOf(weights) - 1) < 1e-9)
})

test('近期 + coding 叠加：四路权重 clamp/归一化后和仍为 1', () => {
  const weights = computeRRFWeights({ title: '最近的部署脚本', content: '昨天改了配置', domain: 'coding' }, { size: 3 })
  assert.ok(weights.recency != null)
  for (const value of Object.values(weights)) {
    assert.ok(value >= 0.05 - 1e-12 && value <= 0.6 + 1e-12, `每个权重落在 [0.05, 0.6]，got ${value}`)
  }
  assert.ok(Math.abs(sumOf(weights) - 1) < 1e-9)
})

test('普通查询回退静态权重：精确等于常量表三路，无 recency 键', () => {
  const weights = computeRRFWeights({ title: '缓存策略', content: 'Redis 缓存统一 30 秒过期' }, { size: 3 })
  assert.deepEqual(weights, STATIC_WEIGHTS)
})

// —— computeRRFWeights：异常输入 fallback（风险表：权重边界 + fallback）——

test('异常输入 fallback：proposal/corpus 非对象或字段不可分词都回静态', () => {
  const corpus = { size: 3 }
  assert.deepEqual(computeRRFWeights(null, corpus), STATIC_WEIGHTS)
  assert.deepEqual(computeRRFWeights(undefined, corpus), STATIC_WEIGHTS)
  assert.deepEqual(computeRRFWeights(42, corpus), STATIC_WEIGHTS)
  assert.deepEqual(computeRRFWeights('x', corpus), STATIC_WEIGHTS)
  assert.deepEqual(computeRRFWeights({ title: '缓存' }, null), STATIC_WEIGHTS)
  assert.deepEqual(computeRRFWeights({ title: '缓存' }, undefined), STATIC_WEIGHTS)
  // 读取字段时抛错（getter 异常）也不往上传，按 fallback 处理
  assert.deepEqual(computeRRFWeights({ get title() { throw new Error('bad') } }, corpus), STATIC_WEIGHTS)
  // 近期词在 content 里同样能触发，但异常 proposal 压过一切
  assert.deepEqual(computeRRFWeights(null, { title: '最近的部署' }), STATIC_WEIGHTS)
})

test('纯函数：同输入同输出，返回对象是独立副本（改写不影响下次调用）', () => {
  const proposal = { title: '最近的部署', content: '昨天更新了缓存策略' }
  const corpus = { size: 3 }
  const a = computeRRFWeights(proposal, corpus)
  const b = computeRRFWeights(proposal, corpus)
  assert.deepEqual(a, b)
  a.bm25 = 999
  a.recency = 999
  assert.deepEqual(computeRRFWeights(proposal, corpus), b)
})

// —— rankPairCandidates：动态路径与静态路径的等效与提升 ——

function equivalenceCorpus() {
  return buildCorpus([
    { id: 'doc-1', track: 'memory', domain: 'general', title: '缓存过期', content: 'Redis 缓存统一设置 30 秒过期，命中直接返回。', appliesTo: ['deploy'], updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'doc-2', track: 'memory', domain: 'general', title: '咖啡拿铁', content: '用户下午只喝美式咖啡。', appliesTo: ['coffee'], updatedAt: '2026-01-02T00:00:00.000Z' },
  ])
}

test('开关关闭等效：普通查询下 rrf 与静态三路公式逐位相等（权重无 recency 时动态路径退化为静态）', () => {
  const corpus = equivalenceCorpus()
  const proposal = { id: 'p', track: 'memory', domain: 'general', title: '缓存过期', content: 'Redis 缓存统一设置 30 秒过期，命中直接返回。', appliesTo: ['deploy'] }
  const found = rankPairCandidates({ corpus, proposal, limit: 20 })
  assert.equal(found.length, 2)
  // doc-1 文本与 proposal 全同 → 三路都是 rank 1；doc-2 全不相干 → 三路都是 rank 2
  assert.equal(found[0].id, 'doc-1')
  assert.equal(found[1].id, 'doc-2')
  // 与「开关关」分支同一表达式、同一权重常量 → 严格相等
  assert.equal(found[0].rrf, RRF_W_BM25 / (RRF_K + 1) + RRF_W_DICE / (RRF_K + 1) + RRF_W_ENTITY / (RRF_K + 1))
  assert.equal(found[1].rrf, RRF_W_BM25 / (RRF_K + 2) + RRF_W_DICE / (RRF_K + 2) + RRF_W_ENTITY / (RRF_K + 2))
  assert.equal(RRF_DYNAMIC, true, '本测试锚定开关当前默认值：开 + 静态权重 ≡ 关')
})

function recentCorpus() {
  return buildCorpus([
    { id: 'a-old', track: 'memory', domain: 'general', title: '缓存过期', content: '缓存过期提醒每日检查', appliesTo: [], updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b-new', track: 'memory', domain: 'general', title: '缓存过期', content: '缓存过期提醒每日检查', appliesTo: [], updatedAt: '2026-06-01T00:00:00.000Z' },
  ])
}

test('recency 查询下 updatedAt 更新的候选相对提升：rrf 差距收窄、新者增益为正、旧者为负', () => {
  const corpus = recentCorpus()
  const proposal = { track: 'memory', domain: 'general', title: '缓存过期', content: '昨天 缓存过期提醒每日检查' }
  const found = rankPairCandidates({ corpus, proposal, limit: 20 })
  assert.equal(found.length, 2)
  // 文本全同 → 三路 tie 由 idAsc 定序：a-old 三路 rank1、b-new rank2；
  // recency 通道按 updatedAt 降序：b-new rank1、a-old rank2。
  const rrfOld = found.find((c) => c.id === 'a-old').rrf
  const rrfNew = found.find((c) => c.id === 'b-new').rrf
  // 静态口径的期望值（同一表达式、rank 1/2）
  const statOld = RRF_W_BM25 / (RRF_K + 1) + RRF_W_DICE / (RRF_K + 1) + RRF_W_ENTITY / (RRF_K + 1)
  const statNew = RRF_W_BM25 / (RRF_K + 2) + RRF_W_DICE / (RRF_K + 2) + RRF_W_ENTITY / (RRF_K + 2)
  // 新者的 rrf 相对静态严格提升，旧者严格下降 → 相对排名提升
  assert.ok(rrfNew > statNew, `新者应增益：${rrfNew} > ${statNew}`)
  assert.ok(rrfOld < statOld, `旧者应减益：${rrfOld} < ${statOld}`)
  // 两者差距收窄（0.8δ → 0.6δ），即 recency 把新者往前拉
  assert.ok(rrfOld - rrfNew < statOld - statNew)
  // recency 权重不足以翻转文本三路的合计优势（0.6δ > 0），排序仍稳定
  assert.equal(found[0].id, 'a-old')
  assert.equal(found[1].id, 'b-new')
})

test('非近期查询下同一 corpus 不受 recency 影响：rrf 与静态公式逐位相等', () => {
  const corpus = recentCorpus()
  const proposal = { track: 'memory', domain: 'general', title: '缓存过期', content: '缓存过期提醒每日检查' }
  const found = rankPairCandidates({ corpus, proposal, limit: 20 })
  assert.equal(found[0].rrf, RRF_W_BM25 / (RRF_K + 1) + RRF_W_DICE / (RRF_K + 1) + RRF_W_ENTITY / (RRF_K + 1))
  assert.equal(found[1].rrf, RRF_W_BM25 / (RRF_K + 2) + RRF_W_DICE / (RRF_K + 2) + RRF_W_ENTITY / (RRF_K + 2))
})

test('结果确定性：同输入两次 rankPairCandidates / computeRRFWeights 完全一致', () => {
  const corpus = recentCorpus()
  const proposal = { track: 'memory', domain: 'general', title: '缓存过期', content: '昨天 缓存过期提醒每日检查' }
  assert.deepEqual(rankPairCandidates({ corpus, proposal, limit: 20 }), rankPairCandidates({ corpus, proposal, limit: 20 }))
  const big = equivalenceCorpus()
  const bigProposal = { id: 'p', track: 'memory', domain: 'general', title: '缓存过期', content: 'Redis 缓存统一设置 30 秒过期，命中直接返回。', appliesTo: ['deploy'] }
  assert.deepEqual(rankPairCandidates({ corpus: big, proposal: bigProposal, limit: 20 }), rankPairCandidates({ corpus: big, proposal: bigProposal, limit: 20 }))
})

test('结果确定性（边界带开启）：切点附近有带内候选时同输入两次 run 完全一致', () => {
  // 与 tests/curator-pairing.test.mjs 的边界带守卫同一 fixture：cand-a/cand-b
  // rrf 差 5.78e-5，limit=1 时 band 把 cand-b 并入评分集——这个新增分支同样
  // 必须完全确定。
  const twin = 'Redis 缓存统一设置 30 秒过期，命中直接返回。Redis 缓存统一设置 30 秒过期，命中直接返回。'
  const tail = '。另有运维值班轮换表与告警升级路径的完整说明，这里补足长度让长度剪枝生效并保持逐字包含。'
  const proposal = { title: '缓存过期', content: 'Redis 缓存统一设置 30 秒过期，命中直接返回。', appliesTo: ['deploy'], track: 'memory', domain: 'general' }
  const corpus = buildCorpus([
    { id: 'cand-a', title: '缓存过期', content: twin, appliesTo: [], track: 'memory', domain: 'general' },
    { id: 'cand-b', title: '缓存过期', content: twin, appliesTo: ['deploy'], track: 'memory', domain: 'general' },
    { id: 'cand-c', title: '缓存过期', content: proposal.content + tail, appliesTo: [], track: 'memory', domain: 'general' },
    { id: 'cand-d', title: '缓存过期', content: proposal.content + tail, appliesTo: [], track: 'memory', domain: 'general' },
  ])
  const run1 = rankPairCandidates({ corpus, proposal, limit: 1 })
  const run2 = rankPairCandidates({ corpus, proposal, limit: 1 })
  assert.deepEqual(run1, run2)
  assert.equal(run1.length, 1)
  assert.equal(run1[0].id, 'cand-b')
})
