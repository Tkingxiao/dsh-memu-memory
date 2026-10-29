import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-recall-bench-'))
const previousHome = process.env.DSH_MEMU_HOME
const previousMemoryHome = process.env.DSH_MEMU_MEMORY_HOME
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const bench = await import('../scripts/recall-bench.mjs')
const roots = [home]
const sentinel = path.join(home, 'sentinel.txt')
fs.writeFileSync(sentinel, 'do not touch the user library\n', 'utf8')

test.after(() => {
  if (previousHome === undefined) delete process.env.DSH_MEMU_HOME
  else process.env.DSH_MEMU_HOME = previousHome
  if (previousMemoryHome === undefined) delete process.env.DSH_MEMU_MEMORY_HOME
  else process.env.DSH_MEMU_MEMORY_HOME = previousMemoryHome
  for (const root of roots.splice(0)) {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  }
})

function freshRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-memu-recall-bench-${label}-`))
  roots.push(root)
  return root
}

function stableReport(report) {
  return {
    dataset: report.dataset,
    code: report.code,
    config: report.config,
    metrics: {
      ...report.metrics,
      latency: null,
    },
    budget: report.budget,
    samples: report.samples.map(({ latencyMs: _latencyMs, ...rest }) => rest),
  }
}

test('CLI parses sample limits and rejects removed or unknown flags', () => {
  assert.equal(bench.parseArgs(['--samples', '1']).sampleLimit, 1)
  assert.throws(() => bench.parseArgs(['--hybrid-llm']), /unknown argument/)
  assert.throws(() => bench.parseArgs(['--not-a-flag']), /unknown argument/)
})

test('synthetic fixtures are explicitly drafts, structurally valid, and cover every requested subclass', () => {
  const dataset = bench.loadDataset()
  assert.equal(dataset.status, 'synthetic-draft-not-gold')
  assert.equal(dataset.draft, true)
  assert.equal(dataset.notGold, true)
  assert.equal(dataset.samples.length, 42)
  assert.equal(dataset.files.length, 8)
  assert.match(dataset.sha256, /^[a-f0-9]{64}$/)

  const counts = {}
  for (const sample of dataset.samples) {
    assert.equal(sample.draft, true, sample.id + ' must be marked draft')
    assert.equal(sample.notGold, true, sample.id + ' must be marked notGold')
    assert.ok(bench.SUBCLASSES.includes(sample.subclass))
    assert.ok(typeof sample.query === 'string' && sample.query.length > 0)
    assert.ok(sample.context && typeof sample.context === 'object' && !Array.isArray(sample.context))
    assert.ok(Number.isFinite(Date.parse(sample.time)))
    assert.ok(Array.isArray(sample.expectedIds))
    assert.ok(Array.isArray(sample.forbiddenIds))
    assert.ok(Array.isArray(sample.library) && sample.library.length > 0 && sample.library.length <= 10)
    assert.equal(typeof sample.noAnswer, 'boolean')
    if (sample.noAnswer) assert.equal(sample.expectedIds.length, 0)
    else assert.ok(sample.expectedIds.length > 0)
    for (const id of [...sample.expectedIds, ...sample.forbiddenIds]) {
      assert.ok(sample.library.includes(id), sample.id + ' id outside library: ' + id)
    }
    for (const id of sample.expectedIds) assert.ok(!sample.forbiddenIds.includes(id))
    counts[sample.subclass] = (counts[sample.subclass] || 0) + 1
  }
  assert.deepEqual(counts, {
    paraphrase: 6,
    exact: 5,
    negation: 4,
    'no-answer': 6,
    conflict: 5,
    boundary: 6,
    secret: 5,
    coding: 5,
  })
})

test('sample validation fails closed on a false answerable marker and on an out-of-library id', () => {
  const base = {
    id: 'rb-invalid',
    draft: true,
    notGold: true,
    subclass: 'paraphrase',
    query: '一个查询',
    context: {},
    time: '2026-01-01T00:00:00Z',
    expectedIds: [],
    forbiddenIds: [],
    noAnswer: false,
    library: ['mem-rb-invalid'],
  }
  assert.throws(() => bench.validateSampleShape(base, 'bad'), /answerable sample requires expectedIds/)
  assert.throws(() => bench.validateSampleShape({ ...base, expectedIds: ['mem-rb-other'] }, 'bad'), /outside the declared library/)
  assert.throws(() => bench.validateSampleShape({ ...base, draft: false, expectedIds: ['mem-rb-invalid'] }, 'bad'), /draft must be true/)
})

test('metric math uses explicit denominators and scores empty top-3 as a no-answer success', () => {
  const metrics = bench.computeMetrics([
    { id: 'a', noAnswer: false, expectedIds: ['e1'], forbiddenIds: ['f'], top3: ['x', 'e1'] },
    { id: 'b', noAnswer: false, expectedIds: ['e2'], forbiddenIds: ['f'], top3: ['e2'] },
    { id: 'c', noAnswer: true, expectedIds: [], forbiddenIds: ['f'], top3: ['f'] },
    { id: 'd', noAnswer: true, expectedIds: [], forbiddenIds: [], top3: [] },
  ])
  assert.equal(metrics.recallAt3, 1)
  assert.equal(metrics.mrrAt3, 0.75)
  assert.equal(metrics.noAnswerFalseRecallRate, 0.5)
  assert.equal(metrics.isolationViolations, 1)
  assert.deepEqual(metrics.denominators, { answerable: 2, noAnswer: 2, forbiddenChecked: 3 })
  assert.equal(metrics.violations[0].sampleId, 'c')

  const empty = bench.computeMetrics([
    { id: 'only-no-answer', noAnswer: true, expectedIds: [], forbiddenIds: [], top3: [] },
  ])
  assert.equal(empty.recallAt3, 0)
  assert.equal(empty.mrrAt3, 0)
  assert.equal(empty.noAnswerFalseRecallRate, 0)
  assert.equal(empty.emptySet.recallAt3, true)
  assert.equal(empty.emptySet.noAnswerFalseRecallRate, false)
})

test('benchmark runs in isolated temp roots, scores candidate and final ids, keeps isolation at zero, and is deterministic', async () => {
  const firstRoot = freshRoot('run1')
  const secondRoot = freshRoot('run2')
  const first = await bench.runBenchmark({ workRoot: firstRoot, seed: 4242 })
  const second = await bench.runBenchmark({ workRoot: secondRoot, seed: 4242 })

  assert.equal(first.ok, true)
  assert.equal(first.status, 'synthetic-draft-not-gold')
  assert.equal(first.dataset.sampleCount, 42)
  assert.equal(first.dataset.sha256, second.dataset.sha256)
  assert.equal(first.metrics.candidate.denominators.answerable, 33)
  assert.equal(first.metrics.candidate.denominators.noAnswer, 9)
  assert.equal(first.metrics.finalInjected.denominators.answerable, 33)
  assert.equal(first.metrics.finalInjected.denominators.noAnswer, 9)
  assert.equal(first.metrics.explicitProbe.denominators.answerable, 5)
  assert.equal(first.metrics.isolation.violations, 0)
  assert.equal(first.metrics.isolation.mustBeZero, true)
  assert.equal(first.metrics.isolation.candidate, 0)
  assert.equal(first.metrics.isolation.finalInjected, 0)
  assert.equal(first.metrics.isolation.explicitProbe, 0)
  assert.ok(first.samples.every(sample => sample.candidateTop3.length <= 3 && sample.injectedTop3.length <= 3))

  // No-answer and boundary samples must actually be scored, not skipped.
  const noAnswer = first.samples.filter(sample => sample.subclass === 'no-answer')
  assert.equal(noAnswer.length, 6)
  assert.ok(noAnswer.every(sample => sample.candidateTop3.length === 0 && sample.injectedTop3.length === 0))
  const boundary = first.samples.filter(sample => sample.subclass === 'boundary')
  assert.equal(boundary.length, 6)
  assert.ok(boundary.every(sample => sample.candidateTop3.length <= 3))

  // Secret entries disappear from automatic recall but appear when explicitly requested.
  const budget = first.samples.find(sample => sample.id === 'rb-sec-budget')
  assert.deepEqual(budget.candidateTop3, [])
  assert.ok(budget.explicitTop3.includes('mem-rb-sec-secret-budget'))
  const diary = first.samples.find(sample => sample.id === 'rb-sec-diary')
  assert.deepEqual(diary.candidateTop3, [])
  assert.ok(diary.explicitTop3.includes('mem-rb-sec-secret-diary'))

  // The run used a fresh root, and the test's own home stayed untouched.
  assert.ok(first.run.root.startsWith(path.resolve(os.tmpdir())))
  assert.ok(fs.existsSync(path.join(first.run.root, 'dsh-memu-data', 'state.json')))
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'do not touch the user library\n')
  assert.equal(fs.existsSync(path.join(home, 'state.json')), false)

  // Token budget is only an estimate, never an actual usage claim.
  assert.equal(first.budget.estimateOnly, true)
  assert.equal(first.budget.field, 'estimate')
  assert.equal(typeof first.budget.injectedTokenEstimateTotal, 'number')
  assert.equal(first.budget.estimate.injectedTokenTotal, first.budget.injectedTokenEstimateTotal)
  assert.equal(first.budget.estimate.turnTokens, 640)
  assert.match(first.budget.note, /estimate/i)

  assert.deepEqual(stableReport(first), stableReport(second))

  console.log('RECALL_BENCH_SUMMARY ' + JSON.stringify({
    dataset: { sampleCount: first.dataset.sampleCount, fileCount: first.dataset.fileCount, sha256: first.dataset.sha256 },
    candidate: first.metrics.candidate,
    finalInjected: first.metrics.finalInjected,
    explicitProbe: first.metrics.explicitProbe,
    isolation: first.metrics.isolation,
    latency: first.metrics.latency,
    bySubclass: first.metrics.bySubclass,
    budget: first.budget,
    startedAt: first.run.startedAt,
  }))
})

test('candidate pack loads 40 pending-review samples with complete metadata and balanced subclasses', () => {
  const dataset = bench.loadDataset(bench.CANDIDATE_FIXTURE_DIR)
  assert.equal(dataset.name, 'recall-bench-gold-candidates')
  assert.equal(dataset.status, bench.CANDIDATE_STATUS)
  assert.equal(dataset.status, 'gold-candidate-pending-review')
  assert.equal(dataset.draft, true)
  assert.equal(dataset.notGold, true)
  assert.equal(dataset.gold, false)
  assert.equal(dataset.review, 'pending')
  assert.equal(dataset.samples.length, 40)
  assert.equal(dataset.files.length, 8)
  assert.equal(dataset.entries.size, 64)
  assert.match(dataset.sha256, /^[a-f0-9]{64}$/)

  const counts = {}
  for (const sample of dataset.samples) {
    assert.equal(sample.status, 'gold-candidate-pending-review', sample.id + ' must stay pending review')
    assert.equal(sample.draft, true, sample.id + ' must be marked draft')
    assert.equal(sample.notGold, true, sample.id + ' must be marked notGold')
    assert.equal(sample.gold, false, sample.id + ' must not be marked gold')
    assert.equal(sample.review, 'pending', sample.id + ' must have a pending review status')
    assert.ok(bench.SUBCLASSES.includes(sample.subclass))
    assert.ok(typeof sample.query === 'string' && sample.query.trim().length > 0)
    assert.ok(sample.context && typeof sample.context === 'object' && !Array.isArray(sample.context))
    assert.ok(Number.isFinite(Date.parse(sample.time)))
    assert.ok(Array.isArray(sample.expectedIds))
    assert.ok(Array.isArray(sample.forbiddenIds))
    assert.ok(Array.isArray(sample.library) && sample.library.length >= 4 && sample.library.length <= 10)
    assert.equal(typeof sample.noAnswer, 'boolean')
    counts[sample.subclass] = (counts[sample.subclass] || 0) + 1
  }
  assert.deepEqual(counts, {
    paraphrase: 5,
    exact: 5,
    negation: 5,
    'no-answer': 5,
    conflict: 5,
    boundary: 5,
    secret: 5,
    coding: 5,
  })
  for (const file of dataset.files) assert.match(file.sha256, /^[a-f0-9]{64}$/)
})

test('candidate pack keeps ids indexed, libraries self-contained, and queries distinct from the synthetic draft', () => {
  const dataset = bench.loadDataset(bench.CANDIDATE_FIXTURE_DIR)
  const defaultDataset = bench.loadDataset()
  const defaultQueries = new Set(defaultDataset.samples.map(sample => sample.query))
  const sampleIds = new Set()
  const queries = new Set()
  for (const sample of dataset.samples) {
    assert.equal(sampleIds.has(sample.id), false, 'duplicate sample id ' + sample.id)
    sampleIds.add(sample.id)
    assert.equal(queries.has(sample.query), false, 'duplicate sample query ' + sample.id)
    queries.add(sample.query)
    assert.equal(defaultQueries.has(sample.query), false, sample.id + ' copies a synthetic-draft query')
    assert.equal(new Set(sample.library).size, sample.library.length, sample.id + ' library has duplicate ids')
    assert.ok(sample.library.length >= 4, sample.id + ' library must have at least four entries')
    assert.equal(sample.noAnswer, sample.expectedIds.length === 0, sample.id + ' expectedIds/noAnswer mismatch')
    for (const id of sample.expectedIds) assert.ok(sample.library.includes(id), sample.id + ' expected id outside library: ' + id)
    for (const id of sample.forbiddenIds) {
      assert.ok(sample.library.includes(id), sample.id + ' forbidden id outside library: ' + id)
      assert.equal(sample.expectedIds.includes(id), false, sample.id + ' id is both expected and forbidden: ' + id)
    }
    for (const id of sample.library) {
      const entry = dataset.entries.get(id)
      assert.ok(entry, sample.id + ' references unknown entry ' + id)
      assert.equal(entry.id, id)
      assert.ok(typeof entry.title === 'string' && entry.title.trim().length > 0)
      assert.ok(typeof entry.content === 'string' && entry.content.trim().length > 0)
      assert.ok(Array.isArray(entry.tags) && entry.tags.length > 0)
      assert.ok(Number.isFinite(entry.ageDays) && entry.ageDays >= 0)
    }
  }
  assert.equal(sampleIds.size, 40)
  assert.equal(queries.size, 40)
})

test('candidate validation fails closed on gold, review, and draft status leaks', () => {
  const dataset = bench.loadDataset(bench.CANDIDATE_FIXTURE_DIR)
  const sample = dataset.samples.find(item => item.subclass === 'paraphrase')
  const options = { status: bench.CANDIDATE_STATUS }
  assert.throws(() => bench.validateSampleShape({ ...sample, gold: true }, 'candidate', options), /gold must not be marked/)
  assert.throws(() => bench.validateSampleShape({ ...sample, review: 'approved' }, 'candidate', options), /review must be pending/)
  assert.throws(() => bench.validateSampleShape({ ...sample, status: bench.DEFAULT_STATUS }, 'candidate', options), /candidate sample status/)
  assert.throws(() => bench.validateSampleShape({ ...sample, draft: false }, 'candidate', options), /draft must be true/)
  assert.throws(() => bench.validateSampleShape({ ...sample, notGold: false }, 'candidate', options), /notGold must be true/)
})

test('candidate no-answer top-3 emptiness and forbidden isolation hold without locking scores', async () => {
  const report = await bench.runBenchmark({ fixtureDir: bench.CANDIDATE_FIXTURE_DIR, workRoot: freshRoot('candidate'), seed: 4242 })
  assert.equal(report.status, 'gold-candidate-pending-review')
  assert.equal(report.gold, false)
  assert.equal(report.review, 'pending')
  assert.equal(report.dataset.sampleCount, 40)
  assert.equal(report.dataset.sha256, bench.loadDataset(bench.CANDIDATE_FIXTURE_DIR).sha256)
  assert.equal(report.metrics.isolation.violations, 0)
  const noAnswer = report.samples.filter(sample => sample.noAnswer)
  assert.equal(noAnswer.length, 8)
  assert.ok(noAnswer.every(sample => sample.candidateTop3.length === 0 && sample.injectedTop3.length === 0))
  // Deliberately no recall/MRR assertion: these are pending-review candidates, not gold scores.
})
