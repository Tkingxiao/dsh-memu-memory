// 词典频率先验：Wilson 下界、effective 因子进入 stableRank、
// hitCounts 写入 clamp、以及生命周期（active/archived）对频率证据的影响。所有断言
// 只依赖落盘数据，不依赖当前时间——排序的确定性在这里与 lexicon-inject 各钉一遍。
// 面板/卡片流（§2.4）的 UI 断言在 tests/lexicon-ui.test.mjs（G2b 重写），本文件只管
// 数据面：当前版本没有待审队列，所以这里也不再钉 pending 文案。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-lexicon-frequency-'))
process.env.DSH_MEMU_HOME = home

const paths = await import('../lib/paths.js')
const state = await import('../lib/state.js')
const lexicon = await import('../lib/lexicon.js')

test.after(() => {
  try { state.flushState() } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

let serial = 0
function setupLibrary(name, { terms = [] } = {}) {
  serial += 1
  const binding = state.ensureSession(`freq-${name}-${serial}`, { cwd: path.join(home, `project-${name}-${serial}`), agentPreset: 'rp' })
  for (const args of terms) lexicon.upsertLexiconTerm({ libraryId: binding.libraryId, ...args })
  return binding
}

function lexFile(libraryId) {
  return path.join(home, 'lexicon', `${libraryId}.json`)
}

/** 直改磁盘上的词条字段（hitCounts/strength/updatedAt），靠 mtime 失效重建索引。 */
function patchTerm(libraryId, term, patch) {
  const lex = lexicon.loadLexicon(libraryId)
  const normalized = lexicon.normalizeLexeme(term)
  const entry = Object.values(lex.terms).find(item => item.normalizedTerm === normalized)
  assert.ok(entry, `term ${term} must exist`)
  Object.assign(entry, patch)
  paths.writeJson(lexFile(libraryId), lex)
}

function termIdOf(libraryId, term) {
  const normalized = lexicon.normalizeLexeme(term)
  const lex = lexicon.loadLexicon(libraryId)
  return Object.entries(lex.terms).find(([, entry]) => entry.normalizedTerm === normalized)?.[0] || null
}

// ---- 1-2. Wilson 下界公式 ----

test('usageLowerBound: n=0 is 0, success is clamped to n, output stays in [0,1]', () => {
  assert.equal(lexicon.usageLowerBound({ candidate: 0, injection: 0, query: 0 }), 0, 'never-candidated terms carry no frequency evidence')
  assert.equal(lexicon.usageLowerBound(undefined), 0)
  assert.equal(lexicon.usageLowerBound(null), 0)
  assert.equal(lexicon.usageLowerBound({}), 0)
  assert.equal(lexicon.usageLowerBound({ candidate: -5, injection: 3 }), 0, 'negative denominator is treated as zero')
  // success 被 min(n, ...) 钳住：脏数据 injection > candidate 也不会把 p 抬过 1。
  const bounded = lexicon.usageLowerBound({ candidate: 10, injection: 50, query: 0 })
  const maxed = lexicon.usageLowerBound({ candidate: 10, injection: 10, query: 0 })
  assert.equal(bounded, maxed, 'success above n is clamped to n')
  for (const value of [bounded, maxed]) assert.ok(value >= 0 && value <= 1, 'the bound stays in [0,1]')
  // 1/1 的 Wilson 下界 ≈ 0.207：一次偶发命中拿不到多少先验。
  const single = lexicon.usageLowerBound({ candidate: 1, injection: 1, query: 0 })
  assert.ok(Math.abs(single - 0.207) < 0.01, `1/1 lower bound should be ~0.207, got ${single}`)
})

test('usageLowerBound: 10/9 ranks above 10/1 — a high miss rate is punished', () => {
  const good = lexicon.usageLowerBound({ candidate: 10, injection: 9, query: 0 })
  const bad = lexicon.usageLowerBound({ candidate: 10, injection: 1, query: 0 })
  assert.ok(good > bad, `9/10 (${good}) must beat 1/10 (${bad})`)
  // 大样本的稳定命中率高于小样本的同比率（Wilson 下界的意义所在）。
  const big = lexicon.usageLowerBound({ candidate: 120, injection: 100, query: 0 })
  const small = lexicon.usageLowerBound({ candidate: 10, injection: 8, query: 0 })
  assert.ok(big > small, '100/120 must exceed 8/10 despite the same ratio')
})

// ---- 3. 高 strength 零计数仍压过低 strength 高计数 ----

test('effective factor: high strength with zero hits still outranks low strength with heavy usage', () => {
  const binding = setupLibrary('strength-first', { terms: [
    { term: '强词先', kind: 'term', meaning: '强权重零计数' },
    { term: '弱词后', kind: 'term', meaning: '弱权重高计数' },
  ] })
  const lib = binding.libraryId
  patchTerm(lib, '强词先', { strength: 0.9, confidence: 0.8, updatedAt: '2026-01-01T00:00:00.000Z' })
  patchTerm(lib, '弱词后', { strength: 0.2, confidence: 0.8, updatedAt: '2026-01-01T00:00:00.000Z',
    hitCounts: { candidate: 1000, injection: 1000, query: 0 } })
  const hits = lexicon.matchLexiconHits(lib, '强词先和弱词后都出现在这句话里', binding.memoryContext)
  assert.equal(hits.length, 2)
  assert.equal(hits[0].term, '强词先', 'a bounded [0.85,1.00] prior must never overturn strength')
  assert.equal(hits[0].hitCounts.candidate, 0, 'the winner indeed has zero usage')
})

// ---- 4. 同 strength/confidence，注入率高的排前面 ----

test('effective factor: same strength and confidence, the heavily injected term ranks first', () => {
  const binding = setupLibrary('usage-first', { terms: [
    { term: '高频入', kind: 'term', meaning: '十次候选十次注入' },
    { term: '低频入', kind: 'term', meaning: '十次候选一次注入' },
  ] })
  const lib = binding.libraryId
  patchTerm(lib, '高频入', { strength: 0.5, confidence: 0.5, updatedAt: '2026-01-01T00:00:00.000Z',
    hitCounts: { candidate: 10, injection: 10, query: 0 } })
  patchTerm(lib, '低频入', { strength: 0.5, confidence: 0.5, updatedAt: '2026-01-01T00:00:00.000Z',
    hitCounts: { candidate: 10, injection: 1, query: 0 } })
  const hits = lexicon.matchLexiconHits(lib, '高频入和低频入都出现在这句话里', binding.memoryContext)
  assert.equal(hits.length, 2)
  assert.equal(hits[0].term, '高频入', 'Wilson lower bound lifts the term that really gets injected')
  assert.equal(hits[1].term, '低频入')
})

// ---- 5. 排序稳定：纯函数，与当前时间/调用次数无关 ----

test('ranking is a pure function of the stored data, stable across repeated calls', () => {
  const binding = setupLibrary('stable', { terms: [
    { term: '稳定甲', kind: 'term', meaning: '一' },
    { term: '稳定乙', kind: 'term', meaning: '二' },
    { term: '稳定丙', kind: 'term', meaning: '三' },
  ] })
  const lib = binding.libraryId
  patchTerm(lib, '稳定甲', { strength: 0.6, confidence: 0.6, updatedAt: '2026-01-02T00:00:00.000Z',
    hitCounts: { candidate: 4, injection: 1, query: 0 } })
  patchTerm(lib, '稳定乙', { strength: 0.6, confidence: 0.6, updatedAt: '2026-01-01T00:00:00.000Z',
    hitCounts: { candidate: 4, injection: 4, query: 0 } })
  patchTerm(lib, '稳定丙', { strength: 0.6, confidence: 0.6, updatedAt: '2026-01-01T00:00:00.000Z',
    hitCounts: { candidate: 4, injection: 4, query: 0 } })
  const text = '稳定甲稳定乙稳定丙同时出现'
  const first = lexicon.matchLexiconHits(lib, text, binding.memoryContext).map(hit => hit.term)
  assert.equal(first.length, 3)
  const second = lexicon.matchLexiconHits(lib, text, binding.memoryContext).map(hit => hit.term)
  assert.deepEqual(second, first, 'the order never depends on the clock or iteration order')
  // 稳定乙/丙同分同 updatedAt：并列对按 termId 字典序，稳定甲（低注入率）垫底。
  const idA = termIdOf(lib, '稳定乙')
  const idB = termIdOf(lib, '稳定丙')
  const tiePair = idA.localeCompare(idB) < 0 ? ['稳定乙', '稳定丙'] : ['稳定丙', '稳定乙']
  assert.deepEqual(first.slice(0, 2), tiePair, 'the tied pair falls back to the lexicographic termId')
  assert.equal(first[2], '稳定甲', 'the weak injection rate stays behind on the same strength')
})

// ---- 6. hitCounts 写入 clamp 到 1,000,000 ----

test('lexiconRecordHits clamps hitCounts at HIT_COUNT_CAP and keeps the prior bounded', () => {
  const binding = setupLibrary('clamp', { terms: [{ term: '爆表词', kind: 'term', meaning: '计数封顶' }] })
  const lib = binding.libraryId
  const id = termIdOf(lib, '爆表词')
  assert.ok(id)
  patchTerm(lib, '爆表词', { hitCounts: { candidate: 5_000_000, injection: 2_000_000, query: 3_000_000 } })
  const { counts } = lexicon.lexiconRecordHits(lib, [id], 'candidate')
  assert.equal(counts[id].candidate, lexicon.HIT_COUNT_CAP, 'candidate is clamped to 1,000,000 even after increment')
  assert.equal(counts[id].injection, lexicon.HIT_COUNT_CAP, 'pre-existing out-of-range values are pulled back in')
  assert.equal(counts[id].query, lexicon.HIT_COUNT_CAP)
  const lb = lexicon.usageLowerBound(counts[id])
  assert.ok(lb >= 0 && lb <= 1, `the factor input stays finite and bounded, got ${lb}`)
  assert.ok(lexicon.usageLowerBound({ candidate: lexicon.HIT_COUNT_CAP, injection: lexicon.HIT_COUNT_CAP }) > 0.9999, 'a perfect huge sample bounds just under 1 (Wilson never quite reaches it)')
  // 落盘值同样被封顶：下一次读取不会看到越界计数。
  const stored = Object.values(lexicon.loadLexicon(lib).terms).find(entry => entry.termId === id || entry.term === '爆表词')
  assert.equal(stored.hitCounts.candidate, lexicon.HIT_COUNT_CAP)
})

// ---- 7. 生命周期 × 频率先验（§2.1）：归档词条不再参与匹配/注入 ----

test('archived terms stop accruing frequency evidence and keep their stored counts', () => {
  const binding = setupLibrary('archived', { terms: [{ term: '归档频率词', kind: 'term', meaning: '归档后不再候选' }] })
  const lib = binding.libraryId
  const id = termIdOf(lib, '归档频率词')
  lexicon.lexiconRecordHit(lib, id, 'candidate')
  lexicon.lexiconRecordHit(lib, id, 'injection')
  lexicon.archiveLexiconTerm({ libraryId: lib, termId: id })
  // 归档后不再进匹配：没有 candidate/injection 可累积。
  assert.deepEqual(lexicon.matchLexiconHits(lib, '归档频率词出现在这句话里', binding.memoryContext), [])
  const stored = lexicon.loadLexicon(lib).terms[id]
  assert.deepEqual(stored.hitCounts, { candidate: 1, injection: 1, query: 0 }, 'the audit counts survive archiving unchanged')
  // 恢复后重新参与匹配（计数是历史，不是可见性开关）。
  lexicon.restoreLexiconTerm({ libraryId: lib, termId: id })
  assert.equal(lexicon.matchLexiconHits(lib, '归档频率词出现在这句话里', binding.memoryContext).length, 1)
})
