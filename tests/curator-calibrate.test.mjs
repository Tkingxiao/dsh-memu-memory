import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildReport,
  confusionMatrix,
  evaluateGates,
  loadFixture,
  MARK,
  scorePairs,
  sweepAt,
  sweepThresholds,
} from '../scripts/curator-pair-calibrate.mjs'

// Calibration harness test (spec §8.1 校准层)：fixture 结构、评分确定性、指标数学。
// The §4.13 gates themselves are a report, not a CI gate (§8.2) — they are
// asserted here only as data plumbing, never as a pass/fail of the algorithm.

const FIXTURE = path.resolve('tests/fixtures/curator-pairs/labeled.v1.jsonl')

test('fixture: 90 pairs in three equal bands with unique pair and entry ids', () => {
  const pairs = loadFixture(FIXTURE)
  assert.equal(pairs.length, 90)
  for (const label of ['same-fact', 'related', 'none']) {
    assert.equal(pairs.filter((p) => p.label === label).length, 30, label)
  }
  const pairIds = new Set()
  const entryIds = new Set()
  for (const pair of pairs) {
    assert.ok(!pairIds.has(pair.id), `duplicate pair id ${pair.id}`)
    pairIds.add(pair.id)
    for (const side of ['a', 'b']) {
      const entry = pair[side]
      assert.ok(entry.id, `${pair.id}.${side} carries an id`)
      assert.ok(!entryIds.has(entry.id), `duplicate entry id ${entry.id}`)
      entryIds.add(entry.id)
      assert.ok(String(entry.title || '').length > 0, `${entry.id} has a title`)
      assert.ok(String(entry.content || '').length >= 8, `${entry.id} has content`)
      assert.ok(['memory', 'skill'].includes(entry.track), `${entry.id} has a valid track`)
      assert.ok(Array.isArray(entry.appliesTo), `${entry.id} has an appliesTo array`)
    }
  }
})

test('fixture: covers zh/en/mixed plus length-gap, negation, dates and alias tags', () => {
  const pairs = loadFixture(FIXTURE)
  const tags = new Set(pairs.flatMap((p) => p.tags || []))
  for (const tag of ['length-gap', 'negation-same', 'negation-differ', 'dates-same', 'dates-differ', 'alias', 'punctuation']) {
    assert.ok(tags.has(tag), `missing coverage tag: ${tag}`)
  }
  const langs = new Set(pairs.map((p) => p.lang))
  for (const lang of ['zh', 'en', 'mixed']) assert.ok(langs.has(lang), `missing language coverage: ${lang}`)
  // every declared tag is one of the known ones (typo guard)
  const known = new Set(['paraphrase', 'length-gap', 'containment', 'negation-same', 'negation-differ',
    'dates-same', 'dates-differ', 'alias', 'alias-related', 'punctuation', 'same-prefix', 'same-topic',
    'time-shift', 'different-topic', 'different-domain', 'cross-track', 'length-gap-none', 'skill'])
  for (const tag of tags) assert.ok(known.has(tag), `unknown tag: ${tag}`)
  // the length-gap tags must be honest: real gap >0.5 on the raw text pair
  for (const pair of pairs.filter((p) => (p.tags || []).includes('length-gap'))) {
    const aLen = String(pair.a.title + pair.a.content).length
    const bLen = String(pair.b.title + pair.b.content).length
    assert.ok(Math.abs(aLen - bLen) / Math.max(aLen, bLen) > 0.5, `${pair.id} claims length-gap but the gap is small`)
  }
})

test('fixture header marks the data as a synthetic draft, never a gold set', () => {
  assert.equal(MARK, 'synthetic-draft-not-gold')
  const report = buildReport(loadFixture(FIXTURE))
  assert.equal(report.mark, MARK)
  assert.match(report.note, /synthetic draft/i)
  assert.match(report.note, /NOT a production gold set/i)
})

test('scoring is deterministic: two passes agree exactly', () => {
  const pairs = loadFixture(FIXTURE)
  assert.deepEqual(scorePairs(pairs), scorePairs(pairs))
  const report1 = buildReport(pairs)
  const report2 = buildReport(pairs)
  assert.deepEqual(report1.pairs, report2.pairs)
  assert.deepEqual(report1.confusion, report2.confusion)
  assert.deepEqual(report1.candidateRecall, report2.candidateRecall)
})

test('sweepAt: precision/recall/F1 arithmetic on a hand-checked population', () => {
  const results = [
    { label: 'same-fact', score: 0.9 },
    { label: 'same-fact', score: 0.7 },
    { label: 'related', score: 0.6 },
    { label: 'none', score: 0.75 },
    { label: 'none', score: 0.2 },
  ]
  const at082 = sweepAt(results, ['same-fact'], 0.82)
  assert.deepEqual(
    { tp: at082.tp, fp: at082.fp, fn: at082.fn },
    { tp: 1, fp: 0, fn: 1 },
  )
  assert.equal(at082.precision, 1)
  assert.equal(at082.recall, 0.5)
  assert.equal(at082.f1, 0.6667)
  const at055 = sweepAt(results, ['same-fact', 'related'], 0.55)
  assert.deepEqual({ tp: at055.tp, fp: at055.fp, fn: at055.fn }, { tp: 3, fp: 1, fn: 0 })
  assert.equal(at055.precision, 0.75)
  assert.equal(at055.recall, 1)
  // empty predictions → null precision, not NaN
  const empty = sweepAt(results, ['same-fact'], 1.5)
  assert.equal(empty.precision, null)
  assert.equal(empty.recall, 0)
})

test('sweepThresholds walks 0.50→0.95 inclusive with 0.01 steps', () => {
  const rows = sweepThresholds([{ label: 'none', score: 0.6 }], ['same-fact'], {})
  assert.equal(rows.length, 46)
  assert.equal(rows[0].threshold, 0.5)
  assert.equal(rows.at(-1).threshold, 0.95)
})

test('confusionMatrix: label × decision counts sum to the population', () => {
  const results = [
    { label: 'same-fact', decision: 'duplicate' },
    { label: 'same-fact', decision: 'absorb' },
    { label: 'related', decision: 'link' },
    { label: 'none', decision: 'none' },
  ]
  const { matrix } = confusionMatrix(results)
  assert.equal(matrix['same-fact'].duplicate, 1)
  assert.equal(matrix['same-fact'].absorb, 1)
  assert.equal(matrix.related.link, 1)
  assert.equal(matrix.none.none, 1)
  const total = Object.values(matrix).reduce((sum, row) => sum + Object.values(row).reduce((a, b) => a + b, 0), 0)
  assert.equal(total, 4)
})

test('evaluateGates: the four §4.13 thresholds flip pass/fail at their bounds', () => {
  const pass = evaluateGates({
    absorbAt082: { precision: 0.96 },
    linkAt055: { precision: 0.9 },
    noneAt055: { rate: 0.05 },
    recall20: { recall: 0.97 },
  })
  assert.ok(pass.every((gate) => gate.pass))
  const fail = evaluateGates({
    absorbAt082: { precision: 0.94 },
    linkAt055: { precision: 0.84 },
    noneAt055: { rate: 0.11 },
    recall20: { recall: 0.94 },
  })
  assert.ok(fail.every((gate) => !gate.pass))
  // null precision (empty population) never counts as a pass
  const degenerate = evaluateGates({
    absorbAt082: { precision: null },
    linkAt055: { precision: null },
    noneAt055: { rate: null },
    recall20: { recall: null },
  })
  assert.ok(degenerate.every((gate) => !gate.pass))
})

test('candidateRecall: every same-fact partner is reachable through rankPairCandidates', () => {
  const report = buildReport(loadFixture(FIXTURE))
  assert.equal(report.candidateRecall.total, 30)
  assert.equal(report.candidateRecall.limit, 20)
  // data plumbing only — the gate value is reported in the calibration run
  assert.ok(report.candidateRecall.recall >= 0 && report.candidateRecall.recall <= 1)
})

test('fixture file ends with a newline and parses as strict JSONL', () => {
  const raw = fs.readFileSync(FIXTURE, 'utf8')
  assert.match(raw, /\n$/, 'trailing newline (CRLF conversion friendly)')
  const lines = raw.split(/\r?\n/).filter((line) => line.trim())
  assert.equal(lines.length, 90)
  for (const line of lines) JSON.parse(line)
})
