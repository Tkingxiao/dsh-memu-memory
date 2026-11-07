import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bm25,
  buildCorpus,
  globalConflictCheck,
  negationPolarity,
  numericSetsDiffer,
  pairDecision,
  pairFeatures,
  pairScore,
  rankPairCandidates,
  tokenize,
} from '../lib/text-retrieval.js'
import { similarityDetail, similarTexts, bigrams, dice } from '../lib/text-similarity.js'
import { RRF_K, RRF_W_BM25, RRF_W_DICE, RRF_W_ENTITY } from '../lib/curator-policy.js'

// —— §4.1 tokenize ——

test('tokenize: latin runs of >=2 chars keep ._ - joins, single chars drop', () => {
  assert.deepEqual(tokenize('use dsh-memu-memory_v2.today ok'), ['use', 'dsh-memu-memory_v2.today', 'ok'])
  assert.deepEqual(tokenize('a b cd'), ['cd'])
  assert.deepEqual(tokenize('per-turn retry'), ['per-turn', 'retry'])
})

// P0-1 双轨切换（TOKENIZER_V2=true 默认）：CJK 从「只出 bigram」升级为
// unigram+bigram+trigram 三层，4 字 run 另收完整串——断言按新口径更新，
// 「孤立单字保留、跨标点 run 独立」的意图不变。
test('tokenize: CJK runs become layered n-grams (V2), isolated chars stay single', () => {
  assert.deepEqual(tokenize('部署窗口'), [
    '部', '署', '窗', '口',
    '部署', '署窗', '窗口',
    '部署窗', '署窗口',
    '部署窗口',
  ])
  assert.deepEqual(tokenize('猫'), ['猫'])
  // two CJK runs separated by latin/punct stay separate runs
  assert.deepEqual(tokenize('猫。狗'), ['猫', '狗'])
})

test('tokenize: NFKC folds full-width forms, lowercases, dedupes', () => {
  assert.deepEqual(tokenize('ＲＩＳＣＶ ＣＡＣＨＥ CACHE'), ['riscv', 'cache'])
  // V2 去重后仍只保留一次出现；unigram 是新增层（'缓存' bigram 依旧在）
  assert.deepEqual(tokenize('缓存 缓存'), ['缓', '存', '缓存'])
})

// —— §4.1 buildCorpus + bm25 ——

function corpusFor() {
  return buildCorpus([
    { id: 'a', title: '部署窗口', content: '每周四凌晨部署窗口只做灰度', track: 'memory', domain: 'general' },
    { id: 'b', title: '缓存策略', content: 'Redis 缓存统一 30 秒过期', track: 'memory', domain: 'coding' },
    { id: 'c', title: '站会安排', content: '每周一上午十点开站会', track: 'memory', domain: 'general' },
  ])
}

test('buildCorpus: tf/df/avgdl account for every doc and term', () => {
  const corpus = corpusFor()
  assert.equal(corpus.size, 3)
  assert.equal(corpus.df.get('缓存'), 1)
  assert.equal(corpus.df.get('每周'), 2)
  const doc = corpus.docs.get('a')
  assert.equal(doc.tf.get('部署'), 2)
  assert.equal(doc.len, [...doc.tf.values()].reduce((sum, n) => sum + n, 0))
  assert.ok(corpus.avgdl > 0)
})

test('bm25: docs containing query terms outscore non-matching docs', () => {
  const corpus = corpusFor()
  const query = tokenize('缓存 过期')
  const scores = ['a', 'b', 'c'].map((id) => bm25(query, corpus.docs.get(id), corpus))
  assert.ok(scores[1] > scores[0] && scores[1] > scores[2])
  assert.equal(scores[2], 0)
})

test('bm25: queries wider than 64 terms keep the matching terms (junk never evicts them)', () => {
  const corpus = corpusFor()
  const junk = [...Array(80).keys()].map((i) => `raretoken${i}`)
  const query = [...junk, '缓存']
  // Absent terms carry the highest nominal IDF but zero scoring mass; the top-64
  // quota must not spend itself on them and drop the one term that can score.
  const hits = query.filter((t) => (corpus.df.get(t) || 0) > 0)
  assert.equal(bm25(query, corpus.docs.get('b'), corpus), bm25(hits, corpus.docs.get('b'), corpus))
  assert.ok(bm25(hits, corpus.docs.get('b'), corpus) > 0)
})
test('bm25: a corpus-wide high-frequency character is dropped from the query instead of pulling the whole library in', () => {
  const entries = []
  for (let i = 1; i <= 40; i += 1) {
    entries.push({
      id: `freq-${i}`,
      title: `记录 ${i}`,
      content: `第 ${i} 条记录的内容里都带着这个高频字：的。${i === 1 ? '另外还有一个独角兽专属词。' : ''}`,
    })
  }
  const corpus = buildCorpus(entries)
  assert.ok(corpus.df.get('的') >= 40, 'the fixture must make 的 a corpus-wide term')
  const doc = corpus.docs.get('freq-1')
  // A-2：df > dfCap 的 term 整条不参与打分。旧实现给出一个很小的正数，于是
  // 查「的」能把全库都拉进候选池；现在它不产生任何分数。
  assert.equal(bm25(tokenize('的'), doc, corpus), 0)
  // 真正的稀有 term 不受影响——闸门只剔高频词，不改正常词的分值口径。
  assert.ok(bm25(tokenize('独角兽'), doc, corpus) > 0)
})

test('bm25: query term frequency is preserved (qtf multiplies that term\'s contribution)', () => {
  const corpus = corpusFor()
  const doc = corpus.docs.get('b')
  const once = bm25(['缓存'], doc, corpus)
  const twice = bm25(['缓存', '缓存'], doc, corpus)
  assert.ok(once > 0)
  assert.ok(Math.abs(twice - 2 * once) < 1e-12, `qtf=2 must double the contribution: ${once} -> ${twice}`)
})

// —— §4.2 similarityDetail / pairFeatures / pairScore ——

test('similarityDetail: length-comparable pairs report dice, pruned pairs report the containment floor', () => {
  const near = similarityDetail('每周四凌晨部署窗口只做灰度', '每周四凌晨部署窗口只做灰度发布')
  assert.equal(near.containment, 0)
  assert.ok(near.dice > 0.9)
  const contained = similarityDetail('Redis 缓存统一设置 30 秒过期。', 'Redis 缓存统一设置 30 秒过期。过期之后直接回源查询并把回源结果写回缓存，缓存击穿时用互斥锁保护。')
  assert.equal(contained.dice, 0)
  assert.equal(contained.containment, 0.92)
  // similarTexts stays the max of the two — the pre-existing ruler, unchanged
  assert.equal(similarTexts('每周四凌晨部署窗口只做灰度', '每周四凌晨部署窗口只做灰度发布'), near.dice)
  assert.equal(similarTexts('Redis 缓存统一设置 30 秒过期。', 'Redis 缓存统一设置 30 秒过期。过期之后直接回源查询并把回源结果写回缓存，缓存击穿时用互斥锁保护。'), 0.92)
  assert.ok(dice(bigrams('缓存策略'), bigrams('缓存策略')) > 0.99)
})

test('pairFeatures: entityJaccard is 0.5 neutral when both sides are empty, 1 when identical', () => {
  const bothEmpty = pairFeatures({ title: 'A', content: '缓存策略内容' }, { title: 'A', content: '缓存策略内容' })
  assert.equal(bothEmpty.entityJaccard, 0.5)
  assert.equal(bothEmpty.titleExact, true)
  const same = pairFeatures(
    { title: 'A', content: '缓存策略内容', appliesTo: ['Deploy', ' coding '] },
    { title: 'A', content: '缓存策略内容', appliesTo: ['deploy', 'CODING'] },
  )
  assert.equal(same.entityJaccard, 1)
  const disjoint = pairFeatures(
    { title: 'A', content: '缓存策略内容', appliesTo: ['deploy'] },
    { title: 'A', content: '缓存策略内容', appliesTo: ['backend'] },
  )
  assert.equal(disjoint.entityJaccard, 0)
})

test('pairScore: weighted sum 0.50 lexical + 0.20 token + 0.15 title + 0.15 entity', () => {
  const features = { lexical: 1, tokenJaccard: 1, titleDice: 1, entityJaccard: 1 }
  assert.ok(Math.abs(pairScore(features) - 1) < 1e-9)
  assert.ok(Math.abs(pairScore({ ...features, entityJaccard: 0.5 }) - 0.925) < 1e-9)
  // entries form is accepted too
  const entryScore = pairScore(
    { title: '缓存策略', content: '缓存策略内容一致', appliesTo: ['x'] },
    { title: '缓存策略', content: '缓存策略内容一致', appliesTo: ['x'] },
  )
  assert.ok(entryScore > 0.95)
})

// —— §4.2 pairDecision ——

const base = { track: 'memory', domain: 'general', title: '缓存策略', content: 'Redis 缓存统一 30 秒过期', appliesTo: [] }

test('pairDecision: different track is always none, even at identical text', () => {
  const b = { ...base, track: 'skill' }
  assert.equal(pairDecision(base, b), 'none')
})

test('pairDecision: cross-domain links only at >=0.65, never absorbs, rp<->coding never links', () => {
  const same = { ...base, domain: 'coding', title: '缓存策略', content: 'Redis 缓存统一 30 秒过期，额外上下文让分数降下来一些' }
  const d = pairDecision(base, same)
  assert.ok(['link', 'none'].includes(d), `cross-domain must be link/none, got ${d}`)
  const coding = { ...base, domain: 'coding' }
  const rp = { ...base, domain: 'rp', title: '缓存策略', content: 'Redis 缓存统一 30 秒过期' }
  assert.equal(pairDecision(coding, rp), 'none', 'rp and coding never link')
})

test('pairDecision: same-title different-body is conflict; identical text is duplicate', () => {
  const different = { ...base, title: '缓存策略', content: '缓存全部走内存队列，不落 Redis' }
  assert.equal(pairDecision(base, different), 'conflict')
  assert.equal(pairDecision(base, { ...base }), 'duplicate')
})

test('pairDecision: band boundaries 0.90/0.82/0.55 come from the policy table', () => {
  const probe = (tweakA, tweakB) => {
    const a = { ...base, ...tweakA }
    const b = { ...base, ...tweakB }
    return { score: pairScore(pairFeatures(a, b)), decision: pairDecision(a, b) }
  }
  // construct scores inside each band by mixing known-similar/known-different text
  const absorbish = probe(
    { content: 'Redis 缓存统一设置 30 秒过期，命中直接返回' },
    { content: 'Redis 缓存统一设置 30 秒过期，命中直接返回数据' },
  )
  assert.ok(absorbish.score >= 0.82 && absorbish.score < 0.90, `expected absorb band, got ${absorbish.score}`)
  assert.equal(absorbish.decision, 'absorb')
})

// —— §4.3 rankPairCandidates ——

function bigCorpus({ withTarget = true } = {}) {
  // 301 fillers push the corpus past the exact-pair limit → blocking only.
  const entries = []
  for (let i = 1; i <= 301; i++) {
    entries.push({
      id: `filler-${i}`,
      track: 'memory',
      domain: 'filler',
      title: `填充条目 ${i}`,
      content: `这是第 ${i} 条填充记忆，用于撑大语料规模，内容彼此不同填充。`,
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
  }
  if (withTarget) {
    entries.push({ id: 'target', track: 'memory', domain: 'general', title: '缓存过期', content: 'Redis 缓存统一设置 30 秒过期，命中直接返回，不做全量。', appliesTo: ['deploy'], updatedAt: '2026-01-02T00:00:00.000Z' })
    entries.push({ id: 'title-only', track: 'memory', domain: 'general', title: '缓存过期', content: '完全不同的词汇组织起来的另一段内容。', updatedAt: '2026-01-03T00:00:00.000Z' })
    entries.push({ id: 'single-token', track: 'memory', domain: 'elsewhere', title: '咖啡豆', content: 'sync 每周补货一次。', updatedAt: '2026-01-04T00:00:00.000Z' })
  }
  return buildCorpus(entries)
}

test('rankPairCandidates: blocking finds the shared-token target in a >300 corpus', () => {
  const corpus = bigCorpus()
  assert.ok(corpus.size > 300, 'corpus must exceed the exact-pair limit')
  const proposal = { id: 'p', track: 'memory', domain: 'general', title: '缓存过期', content: 'Redis 缓存统一设置 30 秒过期，命中直接返回。', appliesTo: ['deploy'] }
  const found = rankPairCandidates({ corpus, proposal, limit: 20 })
  const ids = found.map((c) => c.id)
  assert.ok(ids.includes('target'), `shared >=2 rare tokens must block, got ${ids.join(',')}`)
  const target = found.find((c) => c.id === 'target')
  assert.ok(['duplicate', 'absorb'].includes(target.decision), `same-fact band decision, got ${target.decision}`)
  assert.ok(target.score >= 0.82)
})

test('rankPairCandidates: exact-title entries enter even without shared tokens', () => {
  const corpus = bigCorpus()
  const proposal = { id: 'p', track: 'memory', domain: 'general', title: '缓存过期', content: '完全无重叠词元的新内容组合安排 sync。', appliesTo: [] }
  const found = rankPairCandidates({ corpus, proposal, limit: 20 })
  assert.ok(found.some((c) => c.id === 'title-only'))
})

test('rankPairCandidates: a one-shared-token candidate outside the proposal domain stays out', () => {
  const corpus = bigCorpus()
  const proposal = { id: 'p', track: 'memory', domain: 'general', title: '缓存过期', content: '完全无重叠词元的新内容组合安排 sync。', appliesTo: [] }
  const found = rankPairCandidates({ corpus, proposal, limit: 20 })
  // 'single-token' shares exactly one rare token (sync) with the proposal and
  // sits in a different domain: blocking needs >=2 shared tokens and the
  // same-domain backfill never reaches a foreign domain. 共享词刻意选 latin——
  // V2 分词会把 CJK 共享词拆出 unigram（安排 → 安排+安+排），latin token 不拆，
  // 「只共享一个词不进候选」的意图在两种分词口径下都成立。
  assert.ok(!found.some((c) => c.id === 'single-token'))
})

test('rankPairCandidates: small corpora score every same-track entry and rank the partner first', () => {
  const corpus = buildCorpus([
    { id: 'partner', track: 'memory', domain: 'general', title: '部署窗口约定', content: '每周四凌晨两点到四点是固定的部署窗口，窗口内只允许灰度发布。', appliesTo: ['deploy'] },
    { id: 'other', track: 'memory', domain: 'general', title: '咖啡偏好', content: '用户下午的咖啡只喝美式，上午喝拿铁。', appliesTo: [] },
  ])
  const proposal = { id: 'p', track: 'memory', domain: 'general', title: '部署窗口约定', content: '每周四凌晨两点到四点是固定部署窗口，窗口里只允许灰度发布操作。', appliesTo: ['deploy'] }
  const found = rankPairCandidates({ corpus, proposal, limit: 20 })
  assert.equal(found[0].id, 'partner')
  assert.equal(found[0].decision, 'absorb')
  assert.ok(found.some((c) => c.id === 'other'), 'same-domain backfill keeps the weak partner visible')
})

test('rankPairCandidates: deterministic — same input, same output', () => {
  const corpus = bigCorpus()
  const proposal = { id: 'p', track: 'memory', domain: 'general', title: '缓存过期', content: 'Redis 缓存统一设置 30 秒过期。', appliesTo: [] }
  const run1 = rankPairCandidates({ corpus, proposal, limit: 20 })
  const run2 = rankPairCandidates({ corpus, proposal, limit: 20 })
  assert.deepEqual(run1, run2)
})

// —— §4.3 边界带（P0-1 回归修复的守卫）：代理切分 → pairScore 真尺终选 ——
//
// 手算秩结构（A-12 之后并列共享名次，fixture 不再靠 id tiebreak 制造分差）：
//   cand-a: 与 proposal 文本全同、appliesTo 不相交 → bm1, di1, en2
//           rrf = 0.5/61 + 0.3/61 + 0.2/62（切点）
//   cand-b: 文本只多一个词、appliesTo 相同 → bm2, di2, en1
//           rrf = 0.5/62 + 0.3/62 + 0.2/61
//   差值 = 0.6×(1/61−1/62) = 1.58e-4 ≤ RRF_SLICE_BAND(2.5e-4)，所以 b 落在带内。
// pairScore：b（entity 1.0）明显高于 a（entity 0）——pre-cut=limit=1 只评分 a，
// 边界带把 b 并入评分集后真尺终选翻到 b：准入从 RRF 代理换成 pairScore 真尺。
test('rankPairCandidates: the slice boundary band admits a better-pairScore candidate the RRF proxy dropped', () => {
  const proposal = { title: '缓存过期', content: 'Redis 缓存统一设置 30 秒过期，命中直接返回。', appliesTo: ['deploy'], track: 'memory', domain: 'general' }
  const corpus = buildCorpus([
    { id: 'cand-a', title: '缓存过期', content: proposal.content, appliesTo: [], track: 'memory', domain: 'general' },
    { id: 'cand-b', title: '缓存过期', content: 'Redis 缓存统一设置 30 秒过期，命中直接返回数据。', appliesTo: ['deploy'], track: 'memory', domain: 'general' },
  ])
  const found = rankPairCandidates({ corpus, proposal, limit: 1 })
  // 真尺终选：数量语义不变（≤max），赢家是带内 rescue 的高 pairScore 候选
  assert.equal(found.length, 1)
  assert.equal(found[0].id, 'cand-b')
  // 赢家的 rrf 严格低于切点（cand-a 的手算 rrf）——证明它来自边界带而非 pre-cut
  const cutRrf = (RRF_W_BM25 + RRF_W_DICE) / (RRF_K + 1) + RRF_W_ENTITY / (RRF_K + 2)
  assert.ok(found[0].rrf < cutRrf, `winner rrf ${found[0].rrf} must sit below the pre-cut line ${cutRrf}`)
  assert.ok(cutRrf - found[0].rrf <= 2.5e-4, 'and the gap must stay inside the slice band')
  // 被切掉的 cand-a 在真尺上确实更差（低 pairScore 者按 pairScore 出局）
  const loserScore = pairScore(pairFeatures(proposal, corpus.docs.get('cand-a').entry))
  assert.ok(found[0].score > loserScore, `band winner ${found[0].score} must beat the displaced candidate ${loserScore}`)
})

// —— A-12：同分文档共享名次，RRF 贡献相等 ——
test('rankPairCandidates: two tied documents contribute the same RRF (competition ranking)', () => {
  const text = 'Redis 缓存统一设置 30 秒过期，命中直接返回。'
  const proposal = { title: '缓存过期', content: text, appliesTo: [], track: 'memory', domain: 'general' }
  const corpus = buildCorpus([
    { id: 'twin-b', title: '缓存过期', content: text, appliesTo: [], track: 'memory', domain: 'general' },
    { id: 'twin-a', title: '缓存过期', content: text, appliesTo: [], track: 'memory', domain: 'general' },
  ])
  const found = rankPairCandidates({ corpus, proposal, limit: 20 })
  const a = found.find((item) => item.id === 'twin-a')
  const b = found.find((item) => item.id === 'twin-b')
  assert.ok(a && b)
  // 三路全部并列 rank 1：rrf = (0.5+0.3+0.2)/(K+1)。旧实现给同分者 1/2 名，
  // 两者的 rrf 会不相等（1/61 vs 1/62）。
  assert.equal(a.rrf, b.rrf)
  assert.ok(Math.abs(a.rrf - (RRF_W_BM25 + RRF_W_DICE + RRF_W_ENTITY) / (RRF_K + 1)) < 1e-15)
})

// —— §4.8 全局冲突预筛 ——

test('globalConflictCheck: same title + different body is same_title; negation flips conflict', () => {
  const a = { title: '缓存策略', content: 'Redis 缓存统一设置 30 秒过期' }
  const b = { title: '缓存策略', content: '缓存全部走内存队列不落 Redis' }
  assert.equal(globalConflictCheck(a, b), 'same_title')
  // different titles (so same_title cannot fire first) + one side negated
  const c = { title: '告警偏好', content: '用户希望每次部署失败都发告警通知' }
  const d = { title: '告警设置', content: '用户不希望每次部署失败都发告警通知' }
  assert.equal(globalConflictCheck(c, d), 'negation')
  assert.equal(negationPolarity('不发告警'), true)
  assert.equal(negationPolarity('每次都发告警'), false)
})

test('globalConflictCheck: differing numbers on similar titles raise value, containment exempts', () => {
  const a = { title: '备份保留', content: '备份保留 14 天后轮转删除' }
  const b = { title: '备份保留期', content: '备份保留 90 天后轮转删除' }
  assert.equal(numericSetsDiffer(a.content, b.content), true)
  assert.equal(globalConflictCheck(a, b), 'value')
  const superset = { title: '备份保留', content: '备份保留 14 天后轮转删除，删除前先校验快照完整性' }
  const detail = globalConflictCheck(a, superset)
  assert.notEqual(detail, 'value', 'a long refinement of the same fact is not a value conflict')
})
