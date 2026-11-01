#!/usr/bin/env node
// P0 校准（spec §4.13）：labeled pair fixture → pair features/score/decision →
// 阈值扫描 + 混淆矩阵 + 候选召回。数据是合成草稿（synthetic-draft-not-gold），
// 报告如实标注，不宣称生产金标。
//
// 用法：
//   node scripts/curator-pair-calibrate.mjs \
//     --fixture tests/fixtures/curator-pairs/labeled.v1.jsonl \
//     [--out artifacts/curator-pairs.json] [--json] [--from 0.50] [--to 0.95] [--step 0.01]
//
// 校准门（§4.13）：
//   absorb @0.82 precision ≥0.95；link @0.55 precision ≥0.85；
//   none 误报率 @0.55 ≤0.10；absorb 候选 recall@20 ≥0.95。
// 未达标先调权重/分词，不直接降阈值；吸收误合并比漏合并更贵。

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildCorpus, pairDecision, pairFeatures, pairScore, rankPairCandidates } from '../lib/text-retrieval.js'

export const MARK = 'synthetic-draft-not-gold'
export const LABELS = ['same-fact', 'related', 'none']
const POSITIVE_ABSORB = ['same-fact']
const POSITIVE_LINK = ['same-fact', 'related']

function parseArgs(argv) {
  const args = { fixture: 'tests/fixtures/curator-pairs/labeled.v1.jsonl', out: null, json: false, from: 0.5, to: 0.95, step: 0.01 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--fixture') args.fixture = argv[++i]
    else if (arg === '--out') args.out = argv[++i]
    else if (arg === '--json') args.json = true
    else if (arg === '--from') args.from = Number(argv[++i])
    else if (arg === '--to') args.to = Number(argv[++i])
    else if (arg === '--step') args.step = Number(argv[++i])
    else if (arg === '--help' || arg === '-h') args.help = true
  }
  return args
}

export function loadFixture(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const pairs = []
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const text = line.trim()
    if (!text || text.startsWith('//')) continue
    const pair = JSON.parse(text)
    pair.line = index + 1
    pairs.push(pair)
  }
  return pairs
}

/** features/score/decision for every pair — the single scoring pass all metrics share. */
export function scorePairs(pairs) {
  return pairs.map((pair) => {
    const features = pairFeatures(pair.a, pair.b)
    const score = pairScore(features)
    const decision = pairDecision(pair.a, pair.b, features)
    return { id: pair.id, label: pair.label, line: pair.line || null, tags: pair.tags || [], score, decision, features }
  })
}

function round4(value) {
  return Math.round(value * 10000) / 10000
}

/** One threshold row: precision/recall/F1 of `score >= threshold` against positiveLabels. */
export function sweepAt(results, positiveLabels, threshold) {
  let tp = 0
  let fp = 0
  let fn = 0
  for (const r of results) {
    const positive = positiveLabels.includes(r.label)
    const predicted = r.score >= threshold
    if (predicted && positive) tp += 1
    else if (predicted && !positive) fp += 1
    else if (!predicted && positive) fn += 1
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : null
  const recall = tp + fn > 0 ? tp / (tp + fn) : null
  const f1 = precision != null && recall != null && precision + recall > 0 ? 2 * precision * recall / (precision + recall) : null
  return { threshold, tp, fp, fn, precision: precision == null ? null : round4(precision), recall: recall == null ? null : round4(recall), f1: f1 == null ? null : round4(f1) }
}

export function sweepThresholds(results, positiveLabels, { from = 0.5, to = 0.95, step = 0.01 } = {}) {
  const rows = []
  for (let t = from; t <= to + 1e-9; t += step) {
    rows.push(sweepAt(results, positiveLabels, Math.round(t * 100) / 100))
  }
  return rows
}

/** label × decision matrix — where the decision bands actually land. */
export function confusionMatrix(results) {
  const decisions = [...new Set(results.map((r) => r.decision))].sort()
  const matrix = {}
  for (const label of LABELS) {
    matrix[label] = {}
    for (const decision of decisions) matrix[label][decision] = 0
  }
  for (const r of results) {
    if (!matrix[r.label]) matrix[r.label] = {}
    matrix[r.label][r.decision] = (matrix[r.label][r.decision] || 0) + 1
  }
  return { decisions, matrix }
}

/**
 * §4.13 candidate recall@20: every same-fact pair's a-side goes through
 * rankPairCandidates against the corpus of all unique fixture entries; the
 * b-side must appear in the top `limit`. This is the recall the curator's
 * duplicate/conflict gate actually sees.
 */
export function candidateRecall(pairs, { limit = 20 } = {}) {
  const unique = new Map()
  for (const pair of pairs) {
    for (const side of ['a', 'b']) {
      const entry = pair[side]
      if (entry && entry.id != null && !unique.has(entry.id)) unique.set(entry.id, entry)
    }
  }
  // fixture entries carry id/title/content/track/domain directly — buildCorpus's contract
  const corpus = buildCorpus([...unique.values()])
  let total = 0
  let hit = 0
  const misses = []
  for (const pair of pairs) {
    if (pair.label !== 'same-fact') continue
    total += 1
    const found = rankPairCandidates({ corpus, proposal: { ...pair.a, id: pair.a.id }, limit })
    if (found.some((c) => c.id === pair.b.id)) hit += 1
    else misses.push({ id: pair.id, expected: pair.b.id, best: found[0] ? { id: found[0].id, score: round4(found[0].score) } : null })
  }
  return { limit, total, hit, recall: total ? round4(hit / total) : 1, misses }
}

/** §4.13 gates — reported as data, never enforced as a CI gate (spec §8.2). */
export function evaluateGates({ absorbAt082, linkAt055, noneAt055, recall20 }) {
  return [
    {
      name: 'absorb precision @0.82',
      metric: absorbAt082.precision,
      floor: 0.95,
      pass: absorbAt082.precision != null && absorbAt082.precision >= 0.95,
    },
    {
      name: 'link precision @0.55',
      metric: linkAt055.precision,
      floor: 0.85,
      pass: linkAt055.precision != null && linkAt055.precision >= 0.85,
    },
    {
      name: 'none false-positive rate @0.55',
      metric: noneAt055.rate,
      ceiling: 0.1,
      pass: noneAt055.rate != null && noneAt055.rate <= 0.10,
    },
    {
      name: 'absorb candidate recall@20',
      metric: recall20.recall,
      floor: 0.95,
      pass: recall20.recall != null && recall20.recall >= 0.95,
    },
  ]
}

export function buildReport(pairs, options = {}) {
  const results = scorePairs(pairs)
  const absorbAt082 = sweepAt(results, POSITIVE_ABSORB, 0.82)
  const linkAt055 = sweepAt(results, POSITIVE_LINK, 0.55)
  const noneResults = results.filter((r) => r.label === 'none')
  const noneFlagged = noneResults.filter((r) => r.score >= 0.55).length
  const noneAt055 = { total: noneResults.length, flagged: noneFlagged, rate: noneResults.length ? round4(noneFlagged / noneResults.length) : 0 }
  const recall20 = candidateRecall(pairs, { limit: options.recallLimit || 20 })
  const gates = evaluateGates({ absorbAt082, linkAt055, noneAt055, recall20 })
  return {
    mark: MARK,
    note: 'synthetic draft fixture for threshold calibration; NOT a production gold set',
    counts: {
      pairs: pairs.length,
      'same-fact': results.filter((r) => r.label === 'same-fact').length,
      related: results.filter((r) => r.label === 'related').length,
      none: noneResults.length,
    },
    gates,
    absorb: { ...absorbAt082, positives: POSITIVE_ABSORB },
    link: { ...linkAt055, positives: POSITIVE_LINK },
    noneFalsePositive: noneAt055,
    candidateRecall: { limit: recall20.limit, total: recall20.total, hit: recall20.hit, recall: recall20.recall, misses: recall20.misses },
    sweep: {
      absorb: sweepThresholds(results, POSITIVE_ABSORB, options),
      link: sweepThresholds(results, POSITIVE_LINK, options),
    },
    confusion: confusionMatrix(results),
    pairs: results.map((r) => ({ id: r.id, label: r.label, score: round4(r.score), decision: r.decision, tags: r.tags })),
  }
}

function printReport(report) {
  const line = '─'.repeat(72)
  console.log(line)
  console.log(`curator pair calibration [${MARK}] — ${report.counts.pairs} pairs (${report.counts['same-fact']}/same-fact, ${report.counts.related}/related, ${report.counts.none}/none)`)
  console.log(line)
  console.log('gates (spec §4.13):')
  for (const gate of report.gates) {
    const bar = gate.pass ? 'PASS' : 'FAIL'
    const bound = gate.floor != null ? `floor ${gate.floor}` : `ceiling ${gate.ceiling}`
    console.log(`  [${bar}] ${gate.name}: ${gate.metric} (${bound})`)
  }
  console.log(`absorb @0.82: precision ${report.absorb.precision} recall ${report.absorb.recall} f1 ${report.absorb.f1} (tp ${report.absorb.tp} fp ${report.absorb.fp} fn ${report.absorb.fn})`)
  console.log(`link   @0.55: precision ${report.link.precision} recall ${report.link.recall} f1 ${report.link.f1} (tp ${report.link.tp} fp ${report.link.fp} fn ${report.link.fn})`)
  console.log(`none   @0.55: false positives ${report.noneFalsePositive.flagged}/${report.noneFalsePositive.total} (${report.noneFalsePositive.rate})`)
  console.log(`candidate recall@${report.candidateRecall.limit}: ${report.candidateRecall.hit}/${report.candidateRecall.total} (${report.candidateRecall.recall})`)
  if (report.candidateRecall.misses.length) {
    for (const miss of report.candidateRecall.misses.slice(0, 10)) {
      console.log(`  miss ${miss.id}: expected ${miss.expected}, best ${miss.best ? `${miss.best.id} @${miss.best.score}` : '(none)'}`)
    }
  }
  console.log('confusion (label × decision):')
  for (const [label, row] of Object.entries(report.confusion.matrix)) {
    console.log(`  ${label.padEnd(10)} ${JSON.stringify(row)}`)
  }
  const worst = [...report.pairs]
    .filter((p) => (p.label === 'same-fact' && p.score < 0.82) || (p.label === 'related' && !(p.score >= 0.55 && p.score < 0.82)) || (p.label === 'none' && p.score >= 0.55))
    .slice(0, 30)
  if (worst.length) {
    console.log('band outliers (same-fact <0.82 | related outside [0.55,0.82) | none ≥0.55):')
    for (const p of worst) console.log(`  ${p.id} [${p.label}] score ${p.score} decision ${p.decision} tags [${p.tags.join(',')}]`)
  }
  console.log(line)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('usage: node scripts/curator-pair-calibrate.mjs --fixture <jsonl> [--out report.json] [--json] [--from 0.5] [--to 0.95] [--step 0.01]')
    return
  }
  const fixturePath = path.resolve(args.fixture)
  const pairs = loadFixture(fixturePath)
  const report = buildReport(pairs, { from: args.from, to: args.to, step: args.step })
  report.fixture = args.fixture
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else printReport(report)
  if (args.out) {
    const outPath = path.resolve(args.out)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
    if (!args.json) console.log(`report written to ${outPath}`)
  }
  process.exitCode = report.gates.every((g) => g.pass) ? 0 : 1
}

// Direct-run detection that works on Windows paths too (no URL juggling).
const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (invoked && invoked === import.meta.url) {
  await main()
}
