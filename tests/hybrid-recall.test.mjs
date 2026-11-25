import { test } from 'node:test'
import assert from 'node:assert/strict'

const memory = await import('../lib/memory.js')

function entry(overrides = {}) {
  return { status: 'active', title: 'memory', content: 'memory body', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...overrides }
}

function indexOf(entries) {
  return { entries }
}

function closeTo(actual, expected, message) {
  assert.ok(Number.isFinite(actual), `${message}: expected a finite number, got ${actual}`)
  assert.ok(Math.abs(actual - expected) <= 1e-12, `${message}: expected ${expected}, got ${actual}`)
}

function freezeInput(value) {
  if (!value || typeof value !== 'object') return value
  for (const child of Object.values(value)) freezeInput(child)
  return Object.freeze(value)
}

function fuseUnchanged(options) {
  const before = structuredClone(options)
  freezeInput(options)
  const fused = memory.fuseRecallCandidates(options)
  assert.deepEqual(options, before, 'fusion must not mutate either route, candidate metadata, or the index')
  return fused
}

function assertNoDominance(fused) {
  for (const file of fused.files) {
    for (const key of ['lexicalDominant', 'lexicalDominantId', 'lexicalDiscount', 'dominanceStage']) {
      assert.equal(Object.hasOwn(file.fusion, key), false, `${file.name}: no blowout must omit ${key}`)
    }
    closeTo(file.retrievalScore, file.fusion.rawRetrievalScore, `${file.name}: no blowout must preserve its raw score`)
  }
  assert.equal(fused.debug.lexicalDominance, null)
}

function duplicateIndex() {
  return indexOf({
    'mem-a': entry({ title: 'deploy window', content: 'the deploy window is thursday two to four am, grey releases only' }),
    'mem-z': entry({ title: 'deploy window', content: 'the deploy window is thursday two to four am, grey releases only' }),
    'mem-other': entry({ title: 'reimbursement deadline', content: 'expense reports are due before the last working day of each month' }),
  })
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
  // Distinct bodies: near-identical candidates would fold into one cluster slot
  // (fact-level dedup), and this test is about the cap, not the folding.
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'
  const token = (n) => alphabet[n % 26] + alphabet[Math.floor(n / 26) % 26]
  for (let i = 0; i < 60; i += 1) {
    const id = 'mem-' + String(i).padStart(2, '0')
    entries[id] = entry({
      title: 'topic ' + token(180 + i),
      content: [token(3 * i), token(3 * i + 1), token(3 * i + 2)].join('of'),
    })
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

test('near-duplicate candidates fold into one candidate slot before the cap', () => {
  const entries = {}
  const local = []
  for (let i = 0; i < 12; i += 1) {
    const id = 'mem-dup-' + String(i).padStart(2, '0')
    entries[id] = entry({ title: 'deploy window ' + (i ? 'variant ' + i : ''), content: 'the deploy window is thursday two to four am, grey releases only' })
    local.push({ name: id })
  }
  entries['mem-real'] = entry({ title: 'reimbursement deadline', content: 'expense reports are due before the last working day of each month' })
  const fused = memory.fuseRecallCandidates({ local: [...local, { name: 'mem-real' }], semantic: [], index: indexOf(entries), limit: 12 })
  // The cluster spends one slot instead of twelve, so the real memory enters
  // even though 13 candidates competed for 12 places.
  assert.equal(fused.debug.localCandidates, 2)
  assert.deepEqual(fused.files.map((file) => file.name), ['mem-dup-00', 'mem-real'])
  assert.deepEqual(fused.debug.collapsed, [{ kept: 'mem-dup-00', dropped: local.slice(1).map((file) => file.name) }])
  assert.equal(fused.debug.clusterCount, 1)
})

test('equal fused scores fall back to the best rank and then the canonical id', () => {
  // Distinct texts: two byte-identical memories would fold as one fact before
  // the tie-break this test is about ever gets a chance to run.
  const index = indexOf({
    'mem-a': entry({ title: 'alpha topic', content: 'alpha body' }),
    'mem-b': entry({ title: 'beta topic', content: 'beta body' }),
  })
  const first = memory.fuseRecallCandidates({ local: [{ name: 'mem-a' }], semantic: [{ name: 'mem-b' }], index })
  const second = memory.fuseRecallCandidates({ local: [{ name: 'mem-a' }], semantic: [{ name: 'mem-b' }], index })
  assert.deepEqual(first.files.map((file) => file.name), ['mem-a', 'mem-b'])
  assert.deepEqual(first.files.map((file) => file.name), second.files.map((file) => file.name))
})

// 2026-11-18 排序修正：RRF 名次归一把"词法满分 vs 普通命中"的原始分差压成近平手
// （1.0 vs 0.95），±50% 的有界偏置（首因/峰终）随即把它顶到前面——运行时实测把
// lexical 219.5 的完美命中挤到 #8。词法巨无霸（topLex ≥ 24 且对第二名 ≥4 倍断层）
// 在场时，其余行的 share 按 max(1/(1+topLex/50), sqrt(lexical/topLex)) 折减，强命中保住头部。
test('a dominant lexical hit keeps its seat; the rank-flattened near-tie cannot be exploited by biases', () => {
  const index = indexOf({
    'mem-food': entry({ title: '主人是江南人，爱吃桂花糖糕和豆沙米糕', createdAt: '2026-11-17T00:00:00.000Z', updatedAt: '2026-11-17T00:00:00.000Z', strength: 0.8 }),
    'mem-meta': entry({ title: '运营值守安排', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', strength: 1 }),
  })
  const fused = memory.fuseRecallCandidates({
    // 词法腿：food 满分、meta 尾随；语义腿次序相反——正是运行时被压过的形态。
    local: [{ name: 'mem-food', lexical: 219.5 }, { name: 'mem-meta', lexical: 4 }],
    semantic: [{ name: 'mem-meta' }, { name: 'mem-food' }],
    index,
    limit: 12,
  })
  const food = fused.files.find((file) => file.name === 'mem-food')
  const meta = fused.files.find((file) => file.name === 'mem-meta')
  assert.equal(fused.files[0].name, 'mem-food', 'the dominant lexical hit must rank first')
  assert.equal(food.retrievalScore, 1)
  assert.ok(meta.retrievalScore < 0.2, 'the flattened near-tie must be broken, got ' + meta.retrievalScore)
  assert.equal(food.fusion.lexicalDominant, 219.5, 'the dominance is observable in fusion metadata')
  const floor = 1 / (1 + 219.5 / 50)
  closeTo(floor, 0.18552875695732837, '219.5-vs-4 uses the new floor, not the old sqrt-only discount')
  closeTo(meta.fusion.rawRetrievalScore, 1, 'meta keeps its original RRF share')
  closeTo(meta.fusion.lexicalDiscount, floor, '4/219.5 is below the lexical floor')
  closeTo(meta.retrievalScore, floor, 'the discounted meta score is exactly the floor')
  for (const file of [food, meta]) {
    assert.equal(file.fusion.lexicalDominantId, 'mem-food')
    assert.equal(file.fusion.dominanceStage, 'library')
  }
  assert.equal(food.fusion.lexicalDiscount, 1)
})

test('no lexical blowout means no discount: the human-like bias ordering is untouched', () => {
  const index = indexOf({
    'mem-x': entry({ title: 'x 记录', content: '甲项目上线时间表和回滚窗口安排', createdAt: '2026-10-01T00:00:00.000Z' }),
    'mem-y': entry({ title: 'y 记录', content: '乙仓库的镜像同步频率与带宽预算', createdAt: '2026-10-02T00:00:00.000Z' }),
  })
  const fused = memory.fuseRecallCandidates({
    local: [{ name: 'mem-x', lexical: 5 }, { name: 'mem-y', lexical: 4 }],
    semantic: [{ name: 'mem-y' }, { name: 'mem-x' }],
    index,
    limit: 12,
  })
  const x = fused.files.find((file) => file.name === 'mem-x')
  const y = fused.files.find((file) => file.name === 'mem-y')
  assert.ok(x && y, 'distinct texts must not fold into one cluster slot')
  assert.equal(x.fusion.lexicalDominant, undefined, 'a 5-vs-4 gap is not a blowout')
  assert.equal(x.retrievalScore, 1)
  assert.equal(y.retrievalScore, 1)
  assertNoDominance(fused)
})

// P2: tiny positive evidence must never score worse than zero evidence.
test('lexical dominance uses the exact floor and is monotone at zero, epsilon, 0.51, 5, and top', () => {
  const topLex = 1000
  const floor = 1 / (1 + topLex / 50)
  const scores = []
  const discounts = []
  for (const lexical of [0, Number.EPSILON, 0.51, 5]) {
    const fused = fuseUnchanged({
      local: [{ name: 'mem-a', lexical: topLex }, { name: 'mem-other', lexical }],
      semantic: [{ name: 'mem-other' }, { name: 'mem-a' }],
      index: duplicateIndex(),
    })
    const top = fused.files.find((file) => file.name === 'mem-a')
    const weak = fused.files.find((file) => file.name === 'mem-other')
    const expected = Math.max(floor, Math.sqrt(Math.min(1, lexical / topLex)))
    assert.equal(fused.files[0].name, 'mem-a', `lexical=${lexical}: the strong fact must stay first`)
    closeTo(top.fusion.rawRetrievalScore, 1, 'top keeps the undiscounted near-tie')
    closeTo(top.fusion.lexicalDiscount, 1, 'top evidence is never discounted')
    closeTo(top.retrievalScore, 1, 'top score remains one')
    closeTo(weak.fusion.rawRetrievalScore, 1, 'weak keeps the same raw score for the monotonic comparison')
    closeTo(weak.fusion.lexicalDiscount, expected, `lexical=${lexical}: exact max(floor, sqrt) discount`)
    closeTo(weak.retrievalScore, expected, `lexical=${lexical}: exact discounted retrieval`)
    for (const file of [top, weak]) {
      assert.equal(file.fusion.lexicalDominant, topLex)
      assert.equal(file.fusion.lexicalDominantId, 'mem-a')
      assert.equal(file.fusion.dominanceStage, 'library')
    }
    scores.push(weak.retrievalScore)
    discounts.push(weak.fusion.lexicalDiscount)
  }
  scores.push(1)
  discounts.push(1)
  closeTo(scores[0], 1 / 21, 'zero evidence uses the exact floor')
  closeTo(scores[1], scores[0], 'epsilon must not be punished relative to zero')
  closeTo(scores[2], scores[0], '0.51 remains protected by the floor')
  closeTo(scores[3], Math.sqrt(5 / topLex), '5 crosses the floor and takes the sqrt branch')
  for (let i = 1; i < scores.length; i += 1) {
    assert.ok(scores[i] >= scores[i - 1], 'more lexical evidence must never reduce the retrieval score')
    assert.ok(discounts[i] >= discounts[i - 1], 'more lexical evidence must never reduce the discount factor')
  }
})

for (const { label, topLex, second, dominant } of [
  { label: 'below 24 even with no runner-up evidence', topLex: 24 - 1e-6, second: 0, dominant: false },
  { label: 'at 24 with no runner-up evidence', topLex: 24, second: 0, dominant: true },
  { label: 'at both 24 and exactly four times the runner-up', topLex: 24, second: 6, dominant: true },
  { label: 'at 24 but just below the four-times ratio', topLex: 24, second: 6 + 1e-6, dominant: false },
]) {
  test(`lexical dominance threshold: ${label}`, () => {
    const fused = fuseUnchanged({
      local: [{ name: 'mem-a', lexical: topLex }, { name: 'mem-other', lexical: second }],
      semantic: [{ name: 'mem-other' }, { name: 'mem-a' }],
      index: duplicateIndex(),
    })
    assert.equal(fused.files.length, 2)
    if (!dominant) {
      assertNoDominance(fused)
      for (const file of fused.files) assert.equal(file.retrievalScore, 1)
      return
    }
    assert.equal(fused.files[0].name, 'mem-a')
    const other = fused.files.find((file) => file.name === 'mem-other')
    closeTo(other.fusion.lexicalDiscount, Math.max(1 / (1 + topLex / 50), Math.sqrt(second / topLex)), 'threshold discount')
    for (const file of fused.files) {
      assert.equal(file.fusion.lexicalDominant, topLex)
      assert.equal(file.fusion.lexicalDominantId, 'mem-a')
      assert.equal(file.fusion.dominanceStage, 'library')
      assert.equal(file.fusion.rawRetrievalScore, 1)
    }
    assert.equal(fused.debug.lexicalDominance.second, second)
  })
}

test('two equally strong but different facts prevent lexical dominance and keep raw RRF ordering', () => {
  const fused = fuseUnchanged({
    local: [{ name: 'mem-a', lexical: 100 }, { name: 'mem-other', lexical: 100 }],
    semantic: [],
    index: duplicateIndex(),
  })
  assert.deepEqual(fused.files.map((file) => file.name), ['mem-a', 'mem-other'])
  assert.equal(fused.files.length, 2, 'different facts must not fold despite equal lexical scores')
  assertNoDominance(fused)
  closeTo(fused.files[0].retrievalScore, 1, 'the leading local rank is unchanged')
  closeTo(fused.files[1].retrievalScore, 61 / 62, 'the second local rank is unchanged')
})

for (const route of ['local', 'semantic']) {
  test(`same-leg ${route} duplicate inherits the strongest lexical evidence without a second RRF contribution`, () => {
    const fused = fuseUnchanged({
      local: route === 'local' ? [{ name: 'mem-a', lexical: 0 }, { name: 'mem-z', lexical: 100 }, { name: 'mem-other', lexical: 20 }] : [],
      semantic: route === 'semantic' ? [{ name: 'mem-a', lexical: 0 }, { name: 'mem-z', lexical: 100 }, { name: 'mem-other', lexical: 20 }] : [],
      index: duplicateIndex(),
    })
    assert.deepEqual(fused.files.map((file) => file.name), ['mem-a', 'mem-other'])
    const representative = fused.files[0]
    const other = fused.files[1]
    assert.equal(representative.lexical, 100)
    assert.equal(representative.lexicalEvidence, 100, 'omitted lexicalEvidence must fall back to the absorbed lexical score')
    assert.equal(representative.fusion.lexicalDominant, 100)
    assert.equal(representative.fusion.lexicalDominantId, 'mem-a')
    assert.equal(representative.fusion.dominanceStage, 'library')
    assert.equal(representative.fusion.lexicalDiscount, 1, 'the representative must not be treated as zero-lexical evidence')
    assert.equal(representative.retrievalScore, 1)
    assert.deepEqual(representative.fusion.routes, [route])
    assert.equal(representative.fusion.localRank, route === 'local' ? 1 : null)
    assert.equal(representative.fusion.semanticRank, route === 'semantic' ? 1 : null)
    assert.equal(representative.fusion.bestRank, 1)
    closeTo(representative.fusion.rrf, 1 / 61, 'one route contributes once despite duplicate facts')
    closeTo(other.fusion.rrf, 1 / 62, 'the folded duplicate must not consume a route rank')
    closeTo(other.fusion.rawRetrievalScore, 61 / 62, 'normalization uses only surviving RRF contributions')
    closeTo(other.retrievalScore, (61 / 62) * Math.sqrt(20 / 100), 'the surviving weak fact is discounted once')
    assert.deepEqual(fused.debug.collapsed, [{ kept: 'mem-a', dropped: ['mem-z'] }])
    assert.equal(fused.debug[`${route}Candidates`], 2)
  })
}

for (const strongRoute of ['local', 'semantic']) {
  test(`cross-leg duplicate inherits ${strongRoute} evidence and each route's best rank exactly once`, () => {
    const fused = fuseUnchanged({
      local: [{ name: strongRoute === 'local' ? 'mem-z' : 'mem-a', lexical: strongRoute === 'local' ? 100 : 0 }, { name: 'mem-other', lexical: 20 }],
      semantic: [{ name: strongRoute === 'semantic' ? 'mem-z' : 'mem-a', lexical: strongRoute === 'semantic' ? 100 : 0 }, { name: 'mem-other' }],
      index: duplicateIndex(),
    })
    assert.deepEqual(fused.files.map((file) => file.name), ['mem-a', 'mem-other'])
    const representative = fused.files[0]
    const other = fused.files[1]
    assert.equal(representative.lexical, 100, 'the alphabetical representative must inherit the absorbed strong fact')
    assert.equal(representative.lexicalEvidence, 100)
    assert.deepEqual(representative.mergedTogether, ['mem-z'])
    assert.deepEqual([...representative.fusion.routes].sort(), ['local', 'semantic'])
    assert.equal(representative.fusion.localRank, 1)
    assert.equal(representative.fusion.semanticRank, 1)
    assert.equal(representative.fusion.bestRank, 1)
    closeTo(representative.fusion.rrf, 2 / 61, 'each distinct route contributes its best rank once')
    closeTo(representative.fusion.rawRetrievalScore, 1, 'the new representative normalizes against the surviving maximum')
    assert.equal(representative.fusion.lexicalDominant, 100)
    assert.equal(representative.fusion.lexicalDominantId, 'mem-a')
    assert.equal(representative.fusion.dominanceStage, 'library')
    assert.equal(representative.fusion.lexicalDiscount, 1, 'inherited local evidence must not be discounted as semantic-only')
    assert.equal(representative.retrievalScore, 1)
    closeTo(other.fusion.rrf, 2 / 62, 'the unrelated shared fact has only two contributions')
    closeTo(other.fusion.rawRetrievalScore, 61 / 62, 'cross-leg folding preserves raw rank shares')
    assert.equal(fused.debug.lexicalDominance.second, 20)
    assert.deepEqual(fused.debug.collapsed, [{ kept: 'mem-a', dropped: ['mem-z'] }])
  })
}

test('absorb regression: local z100,a100,other20 and semantic a,z,other leave a strong and first', () => {
  const fused = fuseUnchanged({
    local: [{ name: 'mem-z', lexical: 100 }, { name: 'mem-a', lexical: 100 }, { name: 'mem-other', lexical: 20 }],
    semantic: [{ name: 'mem-a' }, { name: 'mem-z' }, { name: 'mem-other' }],
    index: duplicateIndex(),
  })
  assert.deepEqual(fused.files.map((file) => file.name), ['mem-a', 'mem-other'])
  const representative = fused.files[0]
  const other = fused.files[1]
  assert.equal(representative.lexical, 100, 'a must inherit z rather than remain semantic-only')
  assert.equal(representative.lexicalEvidence, 100)
  assert.deepEqual(representative.mergedTogether, ['mem-z'])
  assert.deepEqual([...representative.fusion.routes].sort(), ['local', 'semantic'])
  assert.equal(representative.fusion.localRank, 1)
  assert.equal(representative.fusion.semanticRank, 1)
  assert.equal(representative.fusion.bestRank, 1)
  closeTo(representative.fusion.rrf, 2 / 61, 'both duplicate pairs still contribute just once per route')
  assert.equal(representative.fusion.rawRetrievalScore, 1)
  assert.equal(representative.fusion.lexicalDominant, 100, 'dominance is recomputed after a absorbs z')
  assert.equal(representative.fusion.lexicalDominantId, 'mem-a')
  assert.equal(representative.fusion.dominanceStage, 'library')
  assert.equal(representative.fusion.lexicalDiscount, 1)
  assert.equal(representative.retrievalScore, 1)
  assert.equal(fused.debug.lexicalDominance.second, 20, 'the absorbed 100 must not count as the runner-up')
  assert.equal(fused.debug.localCandidates, 2)
  assert.equal(fused.debug.semanticCandidates, 2)
  closeTo(other.fusion.rrf, 2 / 62, 'other has no duplicate RRF bonus')
  closeTo(other.fusion.rawRetrievalScore, 61 / 62, 'other keeps its undiscounted fused rank')
  closeTo(other.retrievalScore, (61 / 62) * Math.sqrt(20 / 100), 'other receives one survivor-stage discount')
})

test('cross-leg folding of overlapping route contributors keeps only the best rank per route', () => {
  // Dice is not transitive: the two shortened variants remain distinct on the
  // local leg, while the semantic bridge matches both. Disjoint bigram ranges
  // make that shape deterministic without depending on natural-language tokens.
  const common = Array.from({ length: 50 }, (_, i) => String.fromCharCode(0x3400 + i)).join('')
  const left = Array.from({ length: 20 }, (_, i) => String.fromCharCode(0x3500 + i)).join('')
  const right = Array.from({ length: 20 }, (_, i) => String.fromCharCode(0x3600 + i)).join('')
  const fused = fuseUnchanged({
    local: [{ name: 'mem-b', lexical: 0 }, { name: 'mem-c', lexical: 100 }, { name: 'mem-other', lexical: 20 }],
    semantic: [{ name: 'mem-a' }, { name: 'mem-other' }],
    index: indexOf({
      'mem-a': entry({ title: 'deployment', content: common + left + right }),
      'mem-b': entry({ title: 'deployment', content: common + left }),
      'mem-c': entry({ title: 'deployment', content: common + right }),
      'mem-other': duplicateIndex().entries['mem-other'],
    }),
  })
  assert.equal(fused.debug.localCandidates, 3, 'the two shortened variants must survive the same-leg fold')
  assert.equal(fused.debug.semanticCandidates, 2)
  assert.deepEqual(fused.files.map((file) => file.name), ['mem-a', 'mem-other'])
  const representative = fused.files[0]
  const other = fused.files[1]
  assert.deepEqual(representative.mergedTogether, ['mem-b', 'mem-c'])
  assert.deepEqual([...representative.fusion.routes].sort(), ['local', 'semantic'])
  assert.equal(representative.fusion.localRank, 1, 'absorbing local rank two must keep the better local rank one')
  assert.equal(representative.fusion.semanticRank, 1)
  assert.equal(representative.fusion.bestRank, 1)
  closeTo(representative.fusion.rrf, 2 / 61, 'the second local contributor must not add another RRF term')
  assert.equal(representative.lexical, 100)
  assert.equal(representative.lexicalEvidence, 100)
  assert.equal(representative.fusion.lexicalDominant, 100)
  assert.equal(representative.fusion.lexicalDominantId, 'mem-a')
  assert.equal(representative.fusion.lexicalDiscount, 1)
  assert.equal(representative.fusion.rawRetrievalScore, 1)
  assert.equal(representative.retrievalScore, 1)
  closeTo(other.fusion.rrf, 1 / 63 + 1 / 62, 'unrelated route ranks remain unchanged by cross-leg folding')
  closeTo(other.fusion.rawRetrievalScore, (1 / 63 + 1 / 62) / (2 / 61), 'survivor normalization excludes duplicate route terms')
  assert.deepEqual(fused.debug.collapsed, [{ kept: 'mem-a', dropped: ['mem-b', 'mem-c'] }])
})

test('the same canonical id across legs inherits evidence while keeping one contribution per route', () => {
  const fused = fuseUnchanged({
    local: [{ name: 'mem-a', lexical: 100, lexicalEvidence: 0 }, { name: 'mem-other', lexical: 4 }],
    semantic: [{ name: 'mem-a', lexical: 30, lexicalEvidence: 30 }, { name: 'mem-other' }],
    index: duplicateIndex(),
  })
  assert.deepEqual(fused.files.map((file) => file.name), ['mem-a', 'mem-other'])
  const representative = fused.files[0]
  assert.equal(representative.lexical, 100, 'the full-query local score remains the maximum')
  assert.equal(representative.lexicalEvidence, 30, 'the semantic object may supply stronger topic evidence')
  assert.deepEqual(representative.fusion.routes, ['local', 'semantic'])
  assert.equal(representative.fusion.localRank, 1)
  assert.equal(representative.fusion.semanticRank, 1)
  assert.equal(representative.fusion.bestRank, 1)
  closeTo(representative.fusion.rrf, 2 / 61, 'a canonical id receives only one RRF contribution from each leg')
  assert.equal(representative.fusion.rawRetrievalScore, 1)
  assert.equal(representative.fusion.lexicalDominant, 30)
  assert.equal(representative.fusion.lexicalDominantId, 'mem-a')
  assert.equal(representative.fusion.lexicalDiscount, 1)
  assert.equal(fused.debug.shared, 2)
  assert.equal(fused.debug.clusterCount, 0)
})

test('canonical names and .md aliases inherit their maximum evidence but never double-add RRF or consume ranks', () => {
  const fused = fuseUnchanged({
    local: [{ name: 'mem-a', lexical: 0 }, { name: 'mem-a.md', lexical: 100 }, { name: 'mem-other', lexical: 20 }],
    semantic: [{ name: 'mem-a.md' }, { name: 'mem-a' }, { name: 'mem-other.md' }],
    index: duplicateIndex(),
    limit: 2,
  })
  assert.deepEqual(fused.files.map((file) => file.name), ['mem-a', 'mem-other'])
  const representative = fused.files[0]
  const other = fused.files[1]
  assert.equal(representative.lexical, 100, 'the later alias still contributes its stronger lexical evidence')
  assert.equal(representative.lexicalEvidence, 100)
  assert.deepEqual(representative.fusion.routes, ['local', 'semantic'])
  assert.equal(representative.fusion.localRank, 1)
  assert.equal(representative.fusion.semanticRank, 1)
  assert.equal(representative.fusion.bestRank, 1)
  closeTo(representative.fusion.rrf, 2 / 61, 'alias repetitions do not create extra route contributions')
  assert.equal(representative.fusion.rawRetrievalScore, 1)
  assert.equal(representative.fusion.lexicalDominant, 100)
  assert.equal(representative.fusion.lexicalDominantId, 'mem-a')
  assert.equal(representative.fusion.lexicalDiscount, 1)
  assert.equal(other.fusion.localRank, 2)
  assert.equal(other.fusion.semanticRank, 2)
  closeTo(other.fusion.rrf, 2 / 62, 'aliases never consume the rank of an unrelated fact')
  closeTo(other.fusion.rawRetrievalScore, 61 / 62, 'aliases never inflate the normalization denominator')
  assert.equal(fused.debug.localCandidates, 2)
  assert.equal(fused.debug.semanticCandidates, 2)
  assert.equal(fused.debug.shared, 2)
})

test('duplicate folding merges full-query lexical and topic lexicalEvidence maxima independently', () => {
  const fused = fuseUnchanged({
    local: [{ name: 'mem-a', lexical: 200, lexicalEvidence: 0 }, { name: 'mem-z', lexical: 100, lexicalEvidence: 100 }, { name: 'mem-other', lexical: 20 }],
    semantic: [],
    index: duplicateIndex(),
  })
  assert.deepEqual(fused.files.map((file) => file.name), ['mem-a', 'mem-other'])
  const representative = fused.files[0]
  const other = fused.files[1]
  assert.equal(representative.lexical, 200, 'the full-query maximum belongs to the original representative')
  assert.equal(representative.lexicalEvidence, 100, 'the topic maximum belongs to the absorbed duplicate')
  assert.equal(representative.fusion.lexicalDominant, 100, 'dominance uses topic evidence, not the larger full-query score')
  assert.equal(representative.fusion.lexicalDominantId, 'mem-a')
  assert.equal(representative.fusion.lexicalDiscount, 1)
  closeTo(representative.fusion.rrf, 1 / 61, 'merging two lexical maxima does not add a second route score')
  closeTo(other.fusion.lexicalDiscount, Math.sqrt(20 / 100), 'the weak fact is compared to the topic maximum')
})

test('a strong candidate outside the actual per-leg survivors cannot trigger dominance', () => {
  const fused = fuseUnchanged({
    local: [{ name: 'mem-a', lexical: 5 }, { name: 'mem-other', lexical: 4 }, { name: 'mem-excluded', lexical: 1000 }],
    semantic: [],
    index: indexOf({
      ...duplicateIndex().entries,
      'mem-excluded': entry({ title: 'garden watering', content: 'water the bamboo garden at sunrise with rainwater' }),
    }),
    limit: 2,
  })
  assert.deepEqual(fused.files.map((file) => file.name), ['mem-a', 'mem-other'])
  assertNoDominance(fused)
  closeTo(fused.files[0].fusion.rawRetrievalScore, 1, 'the surviving first route rank stays intact')
  closeTo(fused.files[1].fusion.rawRetrievalScore, 61 / 62, 'the surviving second route rank stays intact')
})

test('explicit lexicalEvidence zero prevents a full-query template score of 100 from triggering topic dominance', () => {
  const fused = fuseUnchanged({
    local: [{ name: 'mem-a', lexical: 100, lexicalEvidence: 0 }, { name: 'mem-other', lexical: 4, lexicalEvidence: 4 }],
    semantic: [{ name: 'mem-a' }],
    index: duplicateIndex(),
  })
  assert.deepEqual(fused.files.map((file) => file.name), ['mem-a', 'mem-other'])
  const template = fused.files[0]
  const other = fused.files[1]
  assert.equal(template.lexical, 100, 'the complete-query score must not be rewritten to the topic score')
  assert.equal(template.lexicalEvidence, 0, 'explicit zero must not fall back to full-query lexical')
  assert.equal(other.lexical, 4)
  assert.equal(other.lexicalEvidence, 4)
  closeTo(template.fusion.rrf, 2 / 61, 'template still has its ordinary two-route RRF rank')
  closeTo(other.fusion.rrf, 1 / 62, 'other still has its ordinary local RRF rank')
  closeTo(template.fusion.rawRetrievalScore, 1, 'template raw ranking is retained')
  closeTo(other.fusion.rawRetrievalScore, 61 / 124, 'other raw ranking is retained')
  assertNoDominance(fused)
})

test('real topic evidence 30 beats template full-query lexical 100 and exposes the correct dominant id', () => {
  const fused = fuseUnchanged({
    local: [{ name: 'mem-a', lexical: 100, lexicalEvidence: 0 }, { name: 'mem-other', lexical: 40, lexicalEvidence: 30 }],
    semantic: [{ name: 'mem-a' }, { name: 'mem-other' }],
    index: duplicateIndex(),
  })
  assert.deepEqual(fused.files.map((file) => file.name), ['mem-other', 'mem-a'])
  const topic = fused.files[0]
  const template = fused.files[1]
  assert.equal(template.lexical, 100)
  assert.equal(template.lexicalEvidence, 0)
  assert.equal(topic.lexical, 40)
  assert.equal(topic.lexicalEvidence, 30)
  closeTo(template.fusion.rawRetrievalScore, 1, 'template keeps its original leading raw rank')
  closeTo(topic.fusion.rawRetrievalScore, 61 / 62, 'topic keeps its original trailing raw rank')
  closeTo(template.fusion.lexicalDiscount, 1 / (1 + 30 / 50), 'zero topic evidence takes the floor against 30')
  closeTo(template.retrievalScore, 0.625, 'template is discounted from raw one exactly once')
  assert.equal(topic.fusion.lexicalDiscount, 1)
  closeTo(topic.retrievalScore, 61 / 62, 'the real topic score is not discounted')
  for (const file of [topic, template]) {
    assert.equal(file.fusion.lexicalDominant, 30)
    assert.equal(file.fusion.lexicalDominantId, 'mem-other', 'top id must follow topic evidence, not full-query lexical')
    assert.equal(file.fusion.dominanceStage, 'library')
  }
  assert.equal(fused.debug.lexicalDominance.id, 'mem-other')
  assert.equal(fused.debug.lexicalDominance.topLex, 30)
  assert.equal(fused.debug.lexicalDominance.second, 0)
})

for (const { label, topLex, second, dominant } of [
  { label: 'a real survivor dominates', topLex: 100, second: 20, dominant: true },
  { label: 'no survivor dominates', topLex: 5, second: 4, dominant: false },
]) {
  test(`pending and automatic secret qualifiers do not participate in the lexical top: ${label}`, () => {
    const index = indexOf({
      ...duplicateIndex().entries,
      'mem-pending': entry({ status: 'pending_review', title: 'unreviewed voyage', content: 'the polar expedition awaits review of its glacier itinerary' }),
      'mem-secret': entry({ visibility: 'secret', title: 'private credential', content: 'the encrypted archive passphrase is reserved for explicit requests' }),
    })
    const fused = fuseUnchanged({
      local: [{ name: 'mem-pending', lexical: 10000, lexicalEvidence: 10000 }, { name: 'mem-secret', lexical: 9000, lexicalEvidence: 9000 }, { name: 'mem-a', lexical: topLex }, { name: 'mem-other', lexical: second }],
      semantic: [{ name: 'mem-secret', lexical: 9000 }, { name: 'mem-pending', lexical: 10000 }, { name: 'mem-other' }, { name: 'mem-a' }],
      index,
      automatic: true,
    })
    assert.deepEqual(fused.files.map((file) => file.name), ['mem-a', 'mem-other'])
    assert.equal(fused.debug.localCandidates, 2)
    assert.equal(fused.debug.semanticCandidates, 2)
    for (const file of fused.files) {
      closeTo(file.fusion.rrf, 1 / 61 + 1 / 62, 'excluded qualifiers cannot consume route ranks')
      assert.equal(file.fusion.rawRetrievalScore, 1)
    }
    if (!dominant) {
      assertNoDominance(fused)
      return
    }
    const top = fused.files[0]
    const other = fused.files[1]
    assert.equal(top.fusion.lexicalDiscount, 1)
    assert.equal(top.retrievalScore, 1)
    closeTo(other.fusion.lexicalDiscount, Math.sqrt(second / topLex), 'only eligible facts determine the gap')
    closeTo(other.retrievalScore, Math.sqrt(second / topLex), 'qualifier scores do not over-discount eligible facts')
    for (const file of fused.files) {
      assert.equal(file.fusion.lexicalDominant, topLex)
      assert.equal(file.fusion.lexicalDominantId, 'mem-a')
      assert.equal(file.fusion.dominanceStage, 'library')
    }
    assert.equal(fused.debug.lexicalDominance.topLex, topLex)
    assert.equal(fused.debug.lexicalDominance.second, second)
  })
}
