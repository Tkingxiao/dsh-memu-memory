import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'active-memory-ab.mjs')
const ab = await import(pathToFileURL(SCRIPT).href)
const activeMemory = await import(pathToFileURL(path.join(ROOT, 'lib', 'active-memory.js')).href)
const { estTokens } = await import(pathToFileURL(path.join(ROOT, 'lib', 'budget.js')).href)

const tempRoots = []
function tempRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-ab-' + label + '-'))
  tempRoots.push(dir)
  return dir
}
test.after(() => {
  for (const dir of tempRoots.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

const reportPromise = ab.runAb({})
const report = await reportPromise

function stable(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (key === 'measuredAdapterMs' || key === 'startedAt') return undefined
    return item
  }))
}

function runOf(caseId, rowId) {
  const found = report.cases.find(run => run.caseId === caseId && run.rowId === rowId)
  assert.ok(found, 'missing run ' + caseId + '/' + rowId)
  return found
}

function coveredLabelCount(run) {
  return run.labels.filter(label => label.covered).length
}

/* ---------------- 数据集、固定快照与 pin ---------------- */

test('fixture dataset loads with every case pinned by throughSeq and snapshot sha256', () => {
  const dataset = ab.loadDataset({})
  assert.equal(dataset.status, 'synthetic-proxy-not-gold')
  assert.equal(dataset.draft, true)
  assert.equal(dataset.notGold, true)
  assert.equal(dataset.gold, false)
  assert.equal(dataset.review, 'pending')
  assert.equal(dataset.cases.length, 14)
  assert.match(dataset.digest, /^[a-f0-9]{64}$/)
  for (const entry of dataset.cases) {
    assert.match(entry.snapshot.digest, /^[a-f0-9]{64}$/)
    assert.equal(entry.snapshot.digest, entry.manifest.snapshotSha256, entry.id + ' digest must equal the manifest pin')
    assert.equal(entry.snapshot.throughSeq, entry.manifest.throughSeq, entry.id + ' throughSeq must equal the manifest pin')
    const expectedTail = entry.def.snapshot.pendingCheck === true ? entry.snapshot.tailEvents : 0
    assert.equal(entry.snapshot.events.length, entry.snapshot.throughSeq + 1 + expectedTail, entry.id + ' only a pendingCheck case may carry a tail past the pinned snapshot')
    for (let index = 0; index < entry.snapshot.events.length; index += 1) {
      assert.equal(entry.snapshot.events[index].seq, index, entry.id + ' seq must equal the assembled position')
    }
  }
})

test('editing a case without re-pinning the digest fails loudly', () => {
  const copy = tempRoot('tamper')
  fs.cpSync(ab.FIXTURE_DIR, copy, { recursive: true })
  const file = path.join(copy, 'cases', '03-clean-starved-small.json')
  const caseDef = JSON.parse(fs.readFileSync(file, 'utf8'))
  caseDef.snapshot.events[1].data.content[0].text = caseDef.snapshot.events[1].data.content[0].text + '（改过）'
  fs.writeFileSync(file, JSON.stringify(caseDef, null, 2), 'utf8')
  assert.throws(() => ab.loadDataset({ fixtureDir: copy }), /does not match the manifest pin/)
  const lenient = ab.loadDataset({ fixtureDir: copy, verifyPins: false })
  assert.equal(lenient.cases.length, 14, 'a digest review pass can still read the dataset')
})

test('snapshot digest ignores events beyond throughSeq and reacts to real edits', () => {
  const dataset = ab.loadDataset({})
  const entry = dataset.cases[0]
  const events = entry.snapshot.events.map(event => ({ ...event }))
  const base = ab.computeSnapshotDigest({ fromSeq: entry.snapshot.fromSeq, throughSeq: entry.snapshot.throughSeq, events })
  assert.equal(base, entry.snapshot.digest)
  const tailOnly = events.concat([{ type: 'turn/end', seq: events.length, at: events[events.length - 1].at }])
  assert.equal(ab.computeSnapshotDigest({ fromSeq: 0, throughSeq: entry.snapshot.throughSeq, events: tailOnly }), base, 'a future event must not change the fixed snapshot')
  const edited = events.map((event, index) => index === 1 ? { ...event, at: '2026-10-30T03:00:00.000Z' } : event)
  assert.notEqual(ab.computeSnapshotDigest({ fromSeq: 0, throughSeq: entry.snapshot.throughSeq, events: edited }), base)
  assert.notEqual(ab.computeSnapshotDigest({ fromSeq: 0, throughSeq: entry.snapshot.throughSeq - 1, events }), base)
})

test('canonical serialization is key-order stable so digests survive formatting changes', () => {
  assert.equal(ab.canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), ab.canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }))
  assert.notEqual(ab.canonicalJson({ a: [1, 2] }), ab.canonicalJson({ a: [2, 1] }))
})

test('the padding generator is deterministic and its polling text dedupes to one work unit', () => {
  const dataset = ab.loadDataset({})
  const entry = dataset.cases.find(item => item.id === 'clean-large-thin')
  assert.ok(entry.snapshot.eventCount > 2000, 'large case must cross the large-transcript threshold, got ' + entry.snapshot.eventCount)
  const first = ab.expandCaseSnapshot(entry.def)
  const second = ab.expandCaseSnapshot(entry.def)
  assert.equal(first.digest, second.digest, 'padding expansion must be reproducible')
  const toolCalls = first.events.filter(event => event.type === 'tool/call').length
  assert.ok(toolCalls >= 520, 'padding should produce tool calls, got ' + toolCalls)
  const evidence = activeMemory.collectEvidence(first.events)
  assert.ok(evidence.toolUnits <= 3, 'identical polling results must collapse, got toolUnits=' + evidence.toolUnits)
})

/* ---------------- 不做金标、不做真实模型调用 ---------------- */

test('every fixture is an unconfirmed synthetic proxy, never a gold label', () => {
  const dataset = ab.loadDataset({})
  for (const entry of dataset.cases) {
    assert.equal(entry.def.annotationSource, 'synthetic-proxy', entry.id)
    assert.equal(entry.def.review, 'pending', entry.id)
    assert.equal(entry.def.gold, false, entry.id)
    assert.equal(entry.def.draft, true, entry.id)
    assert.equal(entry.def.notGold, true, entry.id)
    assert.match(entry.def.annotationNotes, /合成代理/, entry.id + ' must say the label is a synthetic proxy')
  }
})

test('gold gating rejects a synthetic label promoted to gold or a human label without review', () => {
  const dataset = ab.loadDataset({})
  const caseDef = dataset.cases[0].def
  assert.throws(() => ab.validateCaseShape({ ...caseDef, gold: true }, 'x'), /gold must be false/)
  assert.throws(() => ab.validateCaseShape({ ...caseDef, gold: true, annotationSource: 'human' }, 'x'), /gold must be false/)
  assert.throws(() => ab.validateCaseShape({ ...caseDef, annotationSource: 'human' }, 'x'), /human annotation requires review/)
  assert.throws(() => ab.validateCaseShape({ ...caseDef, review: 'approved' }, 'x'), /unknown review status/)
  const manifest = dataset.manifest
  assert.throws(() => ab.validateManifest({ ...manifest, gold: true }), /gold must be false/)
  assert.throws(() => ab.validateManifest({ ...manifest, status: 'gold-reviewed' }), /status must be/)
  assert.throws(() => ab.validateManifest({ ...manifest, notGold: false }), /notGold must be true/)
})

test('the report states that no model ran and keeps gold gating separate', () => {
  assert.equal(report.gold, false)
  assert.equal(report.model.executed, false)
  assert.equal(report.model.networkCalls, 0)
  assert.equal(report.model.realModelCalls, 0)
  assert.equal(report.model.requiresUserOptIn, true)
  assert.equal(report.goldGating.humanReviewRequired, true)
  assert.equal(report.goldGating.goldAllowed, false)
  assert.equal(report.goldGating.reviewedCases, 0)
  assert.equal(report.goldGating.candidateCases, 14)
  assert.ok(report.unmeasured.length >= 4)
  assert.match(report.pipeline.note, /调度/)
})

test('the harness source contains no network or model client code', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8')
  assert.ok(!/node:https?/.test(source), 'no http client')
  assert.ok(!/node:net/.test(source), 'no raw sockets')
  assert.ok(!/\bfetch\s*\(/.test(source), 'no fetch calls')
  assert.ok(!/openai|deepseek-ai\/dsh-llm|api\./i.test(source), 'no model client')
})

/* ---------------- 触发计划：旧行为 / guide / guide+weighted ---------------- */

test('a dense turn wakes the weighted gate on score while the idle-only path never checks', () => {
  const weighted = runOf('clean-dense-turn', 'guide-weighted:oracle')
  const legacy = runOf('clean-dense-turn', 'legacy')
  assert.ok(weighted.calls.backgroundChecks >= 1, 'weighted must check')
  assert.ok(weighted.checks.some(check => check.trigger === 'score'), 'wake reason must be score')
  assert.ok(weighted.checks[0].score >= activeMemory.ACTIVE_MEMORY_POLICY.minScore)
  assert.equal(legacy.calls.backgroundChecks, 0, 'no idle gap means the old path never checks')
  assert.ok(legacy.blocked.every(item => item.reason === 'no-idle-gap'))
  assert.equal(weighted.labels.filter(label => label.covered).length, 4)
  assert.equal(legacy.labels.filter(label => label.covered).length, 0)
})

test('guide delivery is recorded but does not change the schedule in these fixtures', () => {
  const legacy = runOf('clean-dense-turn', 'legacy')
  const guide = runOf('clean-dense-turn', 'guide')
  assert.equal(legacy.guide.delivered, false)
  assert.equal(legacy.guide.rulesKey, null)
  assert.equal(guide.guide.delivered, true)
  assert.match(guide.guide.rulesKey, /^[a-f0-9]{16}$/)
  assert.equal(guide.guide.deliveries > 0, true)
  assert.equal(guide.calls.backgroundChecks, legacy.calls.backgroundChecks, 'guide alone must not change when a check happens')
  assert.deepEqual(guide.blocked.map(item => item.reason), legacy.blocked.map(item => item.reason))
})

test('a thin turn stays unchecked, and pure tool traffic has no human turn to trigger on', () => {
  const thin = runOf('clean-thin-turn', 'guide-weighted:oracle')
  assert.equal(thin.calls.backgroundChecks, 0)
  assert.deepEqual(Object.keys(thin.blocked), ['0', '1'])
  assert.ok(thin.blocked.every(item => item.reason === 'low-score'))
  const noHuman = runOf('no-human-turn', 'guide-weighted:oracle')
  assert.equal(noHuman.calls.backgroundChecks, 0)
  assert.ok(noHuman.blocked.some(item => item.reason === 'no-human-turn'))
  assert.equal(noHuman.labelsTotal, 0)
})

test('starvation wakes a small session but not a large transcript', () => {
  const small = runOf('clean-starved-small', 'guide-weighted:oracle')
  assert.ok(small.checks.some(check => check.trigger === 'starved'))
  const large = runOf('clean-large-thin', 'guide-weighted:oracle')
  assert.equal(large.calls.backgroundChecks, 0)
  assert.ok(large.blocked.some(item => item.reason === 'large-transcript-thin'))
  const largeLegacy = runOf('clean-large-thin', 'legacy')
  assert.equal(largeLegacy.calls.backgroundChecks, 1, 'the idle-only path still forks')
  assert.ok(largeLegacy.cost.seedTokensTotal > small.cost.seedTokensTotal * 10, 'the large full-prefix seed costs more than the small full-prefix seed')
  assert.equal(largeLegacy.blocking.mainSessionWaitForCheck, null)
  assert.equal(large.blocking.mainSessionWaitForCheck, null)
})

test('a recent recall injection suppresses the check instead of recording no_value', () => {
  const weighted = runOf('clean-recent-recall', 'guide-weighted:oracle')
  assert.equal(weighted.calls.backgroundChecks, 0, 'suppression is not a check')
  assert.ok(weighted.blocked.some(item => item.reason === 'recent-recall'))
  assert.equal(weighted.outcomeCounts.deferred, 0)
  assert.equal(weighted.cursor.finalSeq, 0)
  const legacy = runOf('clean-recent-recall', 'legacy')
  assert.equal(legacy.calls.backgroundChecks, 1, 'the old path has no suppression')
})

/* ---------------- 凭证、游标与半步 ---------------- */

test('a half-step snapshot defers and never advances the cursor', () => {
  const run = runOf('clean-half-step', 'guide-weighted:oracle')
  assert.equal(run.checks.length, 1)
  assert.equal(run.checks[0].halfStep, true)
  assert.equal(run.checks[0].status, 'deferred')
  assert.equal(run.checks[0].reasonCode, 'half-step')
  assert.equal(run.checks[0].cursorAdvanced, false)
  assert.deepEqual(run.checks[0].createdIds, [])
  assert.equal(run.cursor.finalSeq, 0, 'a deferred range must not move the cursor')
  assert.equal(run.labels.filter(label => label.covered).length, 0)
})

test('the worker receives the logical range and a complete contiguous seed, never the undelivered tail', () => {
  const seen = []
  return ab.runAb({
    rowIds: ['guide-weighted:no-value'],
    workers: {
      'no-value': ctx => {
        seen.push({
          caseId: ctx.caseId,
          fromSeq: ctx.fromSeq,
          throughSeq: ctx.throughSeq,
          events: ctx.events.length,
          lastSeq: ctx.events[ctx.events.length - 1].seq,
          seedEvents: ctx.seedEvents.length,
          seedLastSeq: ctx.seedEvents[ctx.seedEvents.length - 1].seq,
        })
        return { status: 'completed', outcome: 'no_value', createdIds: [], updatedIds: [], heldIds: [], reasonCode: 'no-candidate', retryable: false }
      },
    },
  }).then(inner => {
    assert.ok(seen.length > 0)
    for (const call of seen) {
      assert.equal(call.events, call.throughSeq - call.fromSeq + 1, 'ctx.events must cover exactly the requested logical range')
      assert.equal(call.lastSeq, call.throughSeq)
      assert.equal(call.seedEvents, call.throughSeq + 1, 'ctx.seedEvents must be the complete contiguous prefix')
      assert.equal(call.seedLastSeq, call.throughSeq, 'the complete prefix must end at the checked boundary')
      const entry = inner.cases.find(run => run.caseId === call.caseId && run.rowId === 'guide-weighted:no-value')
      assert.ok(entry.snapshot.tailEvents >= 0)
      if (call.caseId === 'clean-half-step') assert.ok(entry.snapshot.tailEvents > 0, 'the half-step case must keep a tail outside the snapshot')
    }
  })
})

test('later logical checks still seed and estimate the full prefix in every arm', async () => {
  const dir = tempRoot('full-prefix-seed')
  fs.cpSync(ab.FIXTURE_DIR, dir, { recursive: true })
  const manifestFile = path.join(dir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  manifest.cases = manifest.cases.filter(entry => entry.id === 'clean-starved-small')
  const entry = manifest.cases[0]
  const caseFile = path.join(dir, entry.file)
  const caseDef = JSON.parse(fs.readFileSync(caseFile, 'utf8'))
  const originalEvents = caseDef.snapshot.events
  const laterEvents = originalEvents.map(event => ({
    ...event, at: new Date(Date.parse(event.at) + 60 * 60 * 1000).toISOString(),
  }))
  caseDef.snapshot.events = originalEvents.concat(laterEvents)
  caseDef.labels.expected.push({
    ...caseDef.labels.expected[0], id: 'mem-ab-later-rule', sourceSeq: originalEvents.length + 1,
  })
  delete caseDef.expect
  const snapshot = ab.expandCaseSnapshot(caseDef)
  entry.throughSeq = snapshot.throughSeq
  entry.snapshotSha256 = snapshot.digest
  fs.writeFileSync(caseFile, JSON.stringify(caseDef), 'utf8')
  fs.writeFileSync(manifestFile, JSON.stringify(manifest), 'utf8')

  const seen = []
  const capture = worker => ctx => { seen.push(ctx); return worker(ctx) }
  const result = await ab.runAb({ fixtureDir: dir, workers: {
    oracle: capture(ab.oracleWorker), 'no-value': capture(ab.noValueWorker),
  } })
  for (const run of result.cases) {
    assert.equal(run.checks.length, 2, run.rowId)
    const contexts = seen.filter(ctx => ctx.rowId === run.rowId)
    assert.equal(contexts.length, 2, run.rowId)
    for (const [index, check] of run.checks.entries()) {
      const ctx = contexts[index]
      const prefix = snapshot.events.slice(0, check.throughSeq + 1)
      assert.deepEqual(ctx.seedEvents, prefix, run.rowId + ' actual seed')
      assert.equal(check.seedEvents, prefix.length)
      assert.equal(check.seedTokens, estTokens(prefix.map(ab.eventText).join(' ')))
      assert.deepEqual(ctx.events, snapshot.events.slice(check.fromSeq, check.throughSeq + 1))
      assert.deepEqual(ctx.evidence, activeMemory.collectEvidence(ctx.events))
      assert.deepEqual(ctx.labelsInRange.map(label => label.id), caseDef.labels.expected
        .filter(label => label.sourceSeq >= check.fromSeq && label.sourceSeq <= check.throughSeq)
        .map(label => label.id))
    }
    const last = contexts[1]
    if (run.path === 'snapshot-worker') {
      assert.equal(last.fromSeq, originalEvents.length)
      assert.ok(last.seedEvents.length > last.events.length, 'not a windowed seed')
      assert.deepEqual(last.labelsInRange.map(label => label.id), ['mem-ab-later-rule'])
      assert.deepEqual(last.existingIds, [], 'old seed content is not newly eligible')
      assert.ok(run.checks[1].seedTokens > estTokens(last.events.map(ab.eventText).join(' ')))
    } else {
      assert.equal(last.fromSeq, 0)
      assert.deepEqual(last.seedEvents, last.events)
    }
    assert.equal(run.cost.seedTokensTotal, run.checks.reduce((sum, check) => sum + check.seedTokens, 0))
  }
})

test('both fork paths leave parent blocking and wait counts unmeasured', () => {
  assert.deepEqual(new Set(report.cases.map(run => run.path)), new Set(['full-prefix-fork', 'snapshot-worker']))
  for (const run of report.cases) {
    assert.equal(run.blocking.structural, 'parent-blocking-not-measured')
    assert.equal(run.blocking.mainSessionWaitForCheck, null)
    assert.match(run.blocking.note, /not measured/)
  }
  for (const summary of report.mainAxis.rows) {
    assert.equal(summary.blocking.mainSessionWaitForCheck, null)
    assert.match(summary.blocking.note, /not measured/)
  }
  for (const item of report.mainAxis.deltas) assert.equal(Object.hasOwn(item.delta, 'mainSessionWaitForCheck'), false)
})

test('credential validation rejects mismatched identity and contradictory buckets', () => {
  const request = { fromSeq: 4, throughSeq: 9, snapshotSha256: 'a'.repeat(64), scopeGeneration: 1 }
  const good = {
    checked: { fromSeq: 4, throughSeq: 9, snapshotSha256: 'a'.repeat(64), scopeGeneration: 1 },
    status: 'completed',
    outcome: 'created',
    createdIds: ['mem-ab-x'],
    updatedIds: [],
    heldIds: [],
    reasonCode: 'created',
    retryable: false,
  }
  assert.deepEqual(ab.validateCredential(good, request), [])
  assert.equal(ab.canAdvance(good), true)

  const wrongDigest = { ...good, checked: { ...good.checked, snapshotSha256: 'b'.repeat(64) } }
  assert.match(ab.validateCredential(wrongDigest, request).join(';'), /snapshotSha256/)
  const wrongRange = { ...good, checked: { ...good.checked, throughSeq: 10 } }
  assert.match(ab.validateCredential(wrongRange, request).join(';'), /throughSeq/)
  const wrongScope = { ...good, checked: { ...good.checked, scopeGeneration: 2 } }
  assert.match(ab.validateCredential(wrongScope, request).join(';'), /scopeGeneration/)

  const badStatus = { ...good, status: 'done' }
  assert.match(ab.validateCredential(badStatus, request).join(';'), /unknown status/)
  const doubleBucket = { ...good, heldIds: ['mem-ab-x'] }
  assert.match(ab.validateCredential(doubleBucket, request).join(';'), /more than one bucket/)
  const deferredWithIds = { ...good, status: 'deferred' }
  assert.match(ab.validateCredential(deferredWithIds, request).join(';'), /must not claim written ids/)
  const emptyNoValue = { ...good, outcome: 'no_value' }
  assert.match(ab.validateCredential(emptyNoValue, request).join(';'), /no_value with created/)
  const claimedButEmpty = { ...good, createdIds: [] }
  assert.match(ab.validateCredential(claimedButEmpty, request).join(';'), /without any ids/)

  assert.equal(ab.canAdvance({ ...good, status: 'deferred' }), false)
  assert.equal(ab.canAdvance({ ...good, status: 'failed' }), false)
  assert.equal(ab.canAdvance({ ...good, status: 'skipped' }), false)
  assert.equal(ab.canAdvance({ ...good, outcome: 'no_value', createdIds: [], reasonCode: 'no-candidate' }), true, 'a completed no_value is a normal result')
})

test('an injected worker that reports skipped tools keeps the cursor where it was', async () => {
  const inner = await ab.runAb({
    rowIds: ['guide-weighted:no-value'],
    workers: {
      'no-value': () => ({ status: 'skipped', outcome: 'no_value', createdIds: [], updatedIds: [], heldIds: [], reasonCode: 'unsupported-tools', retryable: true }),
    },
  })
  const skipped = inner.cases.filter(run => run.checks.length > 0)
  assert.ok(skipped.length > 0)
  for (const run of skipped) {
    for (const check of run.checks) {
      if (check.halfStep) continue
      assert.equal(check.status, 'skipped')
      assert.equal(check.cursorAdvanced, false)
      assert.deepEqual(check.problems, [])
    }
    assert.equal(run.cursor.finalSeq, 0)
    if (run.checks.some(check => !check.halfStep)) assert.ok(run.outcomeCounts.skipped > 0, 'the injected worker reported skipped')
  }
})

test('checked ranges are contiguous and every credential is valid', () => {
  assert.deepEqual(report.structureChecks, [])
  assert.equal(report.ok, true)
  for (const run of report.cases) {
    let expectedFrom = run.cursor.startedAtSeq
    for (const check of run.checks) {
      assert.equal(check.fromSeq, expectedFrom, run.caseId + '/' + run.rowId + ' range must continue from the cursor')
      assert.equal(check.credentialValid, true)
      if (check.cursorAdvanced) expectedFrom = check.throughSeq + 1
    }
    if (run.cursor.mode === 'snapshot-credit-contiguous') {
      assert.equal(run.cursor.finalSeq, expectedFrom)
      if (run.checks.length > 0 && run.checks[run.checks.length - 1].cursorAdvanced) {
        assert.equal(run.cursor.finalSeq, run.checks[run.checks.length - 1].throughSeq + 1)
      }
    }
  }
})

/* ---------------- 覆盖、延迟、重复、held、成本 ---------------- */

test('coverage is a bounded interval, not a model measurement', () => {
  const rows = report.mainAxis.rows
  const oracle = rows.find(row => row.row === 'guide-weighted:oracle')
  const lower = rows.find(row => row.row === 'guide-weighted:no-value')
  const legacy = rows.find(row => row.row === 'legacy')
  assert.ok(oracle.coverage.covered >= lower.coverage.covered)
  assert.equal(lower.coverage.background, 0, 'a worker that always answers no_value adds no background coverage')
  assert.equal(lower.coverage.covered, lower.coverage.mainProactive, 'only main-model writes remain covered under the lower bound')
  // The scale gradient (clean-scale-100/1000/5000/20000) shows the guard trades
  // coverage for cost above largeTranscriptEvents: below it the weighted path checks
  // once like legacy does, above it the thin turn is suppressed entirely and only the
  // old idle path still forks. So there is no global "weighted covers more than
  // legacy" ordering — asserting one was only ever true of the original 8-case mix.
  for (const id of ['clean-scale-100', 'clean-scale-1000']) {
    assert.equal(runOf(id, 'guide-weighted:oracle').calls.backgroundChecks, 1, id + ' is still under the large-transcript guard')
    assert.equal(runOf(id, 'legacy').calls.backgroundChecks, 1, id + ' forks on the idle path too')
    assert.equal(coveredLabelCount(runOf(id, 'guide-weighted:oracle')), coveredLabelCount(runOf(id, 'legacy')), id + ' covers the same under both conditions')
  }
  for (const id of ['clean-scale-5000', 'clean-scale-20000']) {
    assert.equal(runOf(id, 'guide-weighted:oracle').calls.backgroundChecks, 0, id + ' is suppressed by the large-transcript guard')
    assert.equal(runOf(id, 'legacy').calls.backgroundChecks, 1, id + ' still forks: the old path has no guard')
    assert.ok(coveredLabelCount(runOf(id, 'guide-weighted:oracle')) < coveredLabelCount(runOf(id, 'legacy')), id + ' is the measured cost of the guard')
  }
  assert.equal(oracle.coverage.labelsTotal, lower.coverage.labelsTotal)
  assert.match(report.bounds.coverageUpper, /oracle/)
  assert.match(report.bounds.coverageLower, /no-value/)
  assert.match(oracle.coverage.interpretation, /上界/)
  assert.equal(oracle.cost.estimateOnly, true)
  assert.match(oracle.cost.method, /estTokens/)
})

test('coverage counts main-model writes separately and never as background coverage', () => {
  const run = runOf('clean-duplicate-reread', 'guide-weighted:oracle')
  const main = run.labels.find(label => label.id === 'mem-ab-dup-no-window')
  assert.equal(main.coveredBy, 'main')
  const background = run.labels.find(label => label.id === 'mem-ab-dup-credential-fields')
  assert.equal(background.coveredBy, 'background')
  assert.ok(run.checks[0].reproposed >= 1, 'a full-prefix replay re-proposes what main already wrote')
  assert.equal(run.calls.memoryToolCalls, 1)
  assert.equal(run.calls.memoryWriteCalls, 1)
})

test('held conflicts are reported separately and excluded from coverage', () => {
  const run = runOf('global-irrelevant-conflict', 'guide-weighted:oracle')
  const conflict = run.labels.find(label => label.id === 'mem-ab-global-backup-change')
  assert.equal(conflict.coveredBy, 'background-held')
  assert.equal(conflict.covered, false)
  assert.equal(conflict.latency, null)
  assert.ok(run.checks[0].heldIds.includes('mem-ab-global-backup-change'))
  assert.equal(run.checks[0].outcome, 'mixed')
  const port = run.labels.find(label => label.id === 'mem-ab-global-port')
  assert.equal(port.coveredBy, 'background')
  assert.ok(port.latency.humanTurns >= 0)
})

test('latency, no_value rate, calls per step and cost are all recorded', () => {
  const run = runOf('clean-starved-small', 'guide-weighted:oracle')
  assert.equal(run.checks.length, 1)
  assert.equal(run.checks[0].outcome, 'created')
  assert.ok(run.checks[0].evidence.humanTurns >= 1)
  assert.ok(run.checks[0].seedTokens > 0)
  const label = run.labels.find(item => item.covered)
  assert.ok(label.latency && Number.isFinite(label.latency.humanTurns))
  const row = report.mainAxis.rows.find(item => item.row === 'guide-weighted:oracle')
  assert.ok(Number.isFinite(row.noValue.rate))
  assert.ok(Number.isFinite(row.calls.per1000Steps))
  assert.ok(row.calls.backgroundChecks > 0)
  assert.ok(row.evidence.humanTurns > 0)
  assert.ok(row.cost.seedTokensTotal > 0)
  assert.equal(row.statuses.invalidCredential, 0)
  assert.equal(row.statuses.failed, 0)
  assert.match(row.blocking.note, /unknown and not measured/)
})

test('fixture expectations match what the weighted row actually produces', () => {
  const dataset = ab.loadDataset({})
  for (const entry of dataset.cases) {
    const expect = entry.def.expect
    assert.ok(expect, entry.id + ' must declare expect')
    const run = runOf(entry.id, 'guide-weighted:oracle')
    const where = entry.id + ': '
    if (expect.minBackgroundChecks !== undefined) {
      assert.ok(run.calls.backgroundChecks >= expect.minBackgroundChecks, where + 'expected at least ' + expect.minBackgroundChecks + ' checks, got ' + run.calls.backgroundChecks)
    }
    if (expect.maxBackgroundChecks !== undefined) {
      assert.ok(run.calls.backgroundChecks <= expect.maxBackgroundChecks, where + 'expected at most ' + expect.maxBackgroundChecks + ' checks, got ' + run.calls.backgroundChecks)
    }
    if (expect.wakeReasons) {
      for (const reason of expect.wakeReasons) {
        assert.ok(run.checks.some(check => check.trigger === reason), where + 'missing wake reason ' + reason)
      }
    }
    if (expect.blockedReasons) {
      for (const reason of expect.blockedReasons) {
        assert.ok(run.blocked.some(item => item.reason === reason), where + 'missing blocked reason ' + reason)
      }
    }
    if (expect.deferredAtLeast !== undefined) {
      assert.ok(run.outcomeCounts.deferred >= expect.deferredAtLeast, where + 'expected deferred decisions')
    }
    if (expect.heldAtLeast !== undefined) {
      const held = run.checks.reduce((sum, check) => sum + check.heldIds.length, 0)
      assert.ok(held >= expect.heldAtLeast, where + 'expected held ids, got ' + held)
    }
    if (expect.duplicatesReproposedAtLeast !== undefined) {
      const reproposed = run.checks.reduce((sum, check) => sum + check.reproposed, 0)
      assert.ok(reproposed >= expect.duplicatesReproposedAtLeast, where + 'expected re-proposed ids, got ' + reproposed)
    }
    for (const id of expect.coveredLabelIds || []) {
      const label = run.labels.find(item => item.id === id)
      assert.ok(label, where + 'unknown label ' + id)
      assert.equal(label.covered, true, where + 'expected ' + id + ' to be covered')
    }
    for (const id of expect.uncoveredLabelIds || []) {
      const label = run.labels.find(item => item.id === id)
      assert.ok(label, where + 'unknown label ' + id)
      assert.equal(label.covered, false, where + 'expected ' + id + ' to stay uncovered')
    }
  }
})

/* ---------------- 全局干扰是独立维度 ---------------- */

test('global interference is its own axis and never mixes into the main table', () => {
  const levels = report.interferenceAxis.rows.map(row => row.level)
  assert.deepEqual(levels, ['off', 'relevant', 'irrelevant-conflict'])
  const offCases = report.cases.filter(run => run.interference === 'off' && run.rowId === 'guide-weighted:oracle').length
  const weightedRow = report.mainAxis.rows.find(row => row.row === 'guide-weighted:oracle')
  assert.equal(weightedRow.cases, offCases, 'the main axis must be computed on interference = off only')
  assert.equal(report.cases.filter(run => run.interference !== 'off').length > 0, true)
  const relevant = report.interferenceAxis.rows.find(row => row.level === 'relevant')
  const off = report.interferenceAxis.rows.find(row => row.level === 'off')
  assert.ok(relevant.anchorTokens > off.anchorTokens, 'relevant global entries cost budget')
  assert.equal(off.anchorTokens, 0, 'interference = off injects nothing')
  for (const row of report.interferenceAxis.rows) assert.equal(row.leaks, 0)
})

test('global entries never leak into private writes', () => {
  for (const run of report.cases) {
    assert.equal(run.interferenceReport.leaks, 0, run.caseId + '/' + run.rowId + ' leaked a global entry')
    const globalIds = new Set((run.def_globalIds || run.interferenceReport.globalIds) || [])
    for (const check of run.checks) {
      for (const id of check.createdIds) assert.ok(!globalIds.has(id))
      for (const id of check.heldIds) assert.ok(!globalIds.has(id))
    }
  }
  const relevant = runOf('global-relevant', 'guide-weighted:oracle')
  assert.deepEqual(relevant.interferenceReport.globalIds, ['mem-gb-relevant-curator', 'mem-gb-relevant-scope'])
  const conflict = runOf('global-irrelevant-conflict', 'guide-weighted:oracle')
  assert.deepEqual(conflict.interferenceReport.conflictLabelIds, ['mem-ab-global-backup-change'])
})

/* ---------------- 可复现与 CLI ---------------- */

test('two runs of the harness produce identical reports apart from measured timings', async () => {
  const again = await ab.runAb({})
  assert.deepEqual(stable(again), stable(report))
})

test('caseLimit and row selection keep the run small and still well formed', async () => {
  const inner = await ab.runAb({ caseLimit: 2, rowIds: ['legacy', 'guide-weighted:no-value'] })
  assert.equal(inner.cases.length, 4)
  assert.deepEqual(inner.mainAxis.rows.map(row => row.row), ['legacy', 'guide-weighted:no-value'])
  assert.equal(inner.cases.filter(run => run.caseId === 'clean-dense-turn').length, 2)
})

test('parseArgs accepts the documented flags and refuses anything that would call a model', () => {
  const options = ab.parseArgs(['--cases', '3', '--row', 'legacy', '--out', 'x.json', '--digests'])
  assert.equal(options.caseLimit, 3)
  assert.deepEqual(options.rowIds, ['legacy'])
  assert.equal(options.out, 'x.json')
  assert.equal(options.digests, true)
  assert.throws(() => ab.parseArgs(['--samples', '1']), /unknown argument/)
  for (const flag of ab.REAL_MODEL_FLAGS) {
    assert.throws(() => ab.parseArgs([flag]), /explicit user decision and is not implemented/)
  }
  assert.throws(() => ab.parseArgs(['--row', 'nope']), /unknown row/)
  assert.throws(() => ab.parseArgs(['--cases', '0']), /positive integer/)
})

test('the CLI writes a CRLF JSON report and prints the pinned digests on request', () => {
  const dir = tempRoot('cli')
  const out = path.join(dir, 'report.json')
  const stdout = execFileSync(process.execPath, [SCRIPT, '--out', out], { encoding: 'utf8', cwd: ROOT })
  assert.match(stdout, /wrote/)
  const raw = fs.readFileSync(out, 'utf8')
  assert.ok(raw.includes('\r\n'), 'report must be written with CRLF')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.kind, 'active-memory-ab')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.status, 'synthetic-proxy-not-gold')
  assert.equal(parsed.model.executed, false)
  const digests = execFileSync(process.execPath, [SCRIPT, '--digests'], { encoding: 'utf8', cwd: ROOT })
  assert.match(digests, /throughSeq=\d+ {2}sha256=[a-f0-9]{64} {2}\(manifest pin matches\)/)
})

test('the harness never touches a user memory directory', async () => {
  const home = tempRoot('home')
  const sentinel = path.join(home, 'sentinel.txt')
  fs.writeFileSync(sentinel, 'do not touch the user library\n', 'utf8')
  const before = fs.readdirSync(home).sort()
  const previousHome = process.env.DSH_MEMU_HOME
  const previousMemoryHome = process.env.DSH_MEMU_MEMORY_HOME
  process.env.DSH_MEMU_HOME = home
  process.env.DSH_MEMU_MEMORY_HOME = home
  try {
    const inner = await ab.runAb({ caseLimit: 3 })
    assert.equal(inner.ok, true)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_MEMU_HOME
    else process.env.DSH_MEMU_HOME = previousHome
    if (previousMemoryHome === undefined) delete process.env.DSH_MEMU_MEMORY_HOME
    else process.env.DSH_MEMU_MEMORY_HOME = previousMemoryHome
  }
  assert.deepEqual(fs.readdirSync(home).sort(), before)
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'do not touch the user library\n')
})

/* ---------------- 真 worker 结构行：回执 → 凭证 ---------------- */

test('the structural row validates its credential and reproduces the oracle row', async () => {
  const both = await ab.runAb({ rowIds: ['guide-weighted:oracle', 'guide-weighted:structural'] })
  assert.equal(both.ok, true, 'no structural violation in either row')
  assert.deepEqual(both.structureChecks, [], 'both rows keep the checked cursor contiguous')

  const oracleRow = both.mainAxis.rows.find(row => row.row === 'guide-weighted:oracle')
  const structuralRow = both.mainAxis.rows.find(row => row.row === 'guide-weighted:structural')
  assert.ok(oracleRow && structuralRow)
  // 回执走的是 C 包的 parseReceipt，凭证结论必须与注解预言机逐项相同：
  // 否则说明"真 worker 的产出形状"和 §13.6 的凭证规则对不上。
  assert.equal(structuralRow.coverage.covered, oracleRow.coverage.covered)
  assert.equal(structuralRow.coverage.labelsTotal, oracleRow.coverage.labelsTotal)
  assert.equal(structuralRow.calls.backgroundChecks, oracleRow.calls.backgroundChecks)
  assert.equal(structuralRow.cost.seedTokensTotal, oracleRow.cost.seedTokensTotal)

  for (const id of new Set(both.cases.map(run => run.caseId))) {
    const oracle = both.cases.find(run => run.caseId === id && run.rowId === 'guide-weighted:oracle')
    const structural = both.cases.find(run => run.caseId === id && run.rowId === 'guide-weighted:structural')
    const covered = run => run.labels.filter(label => label.covered).map(label => label.id).sort()
    assert.deepEqual(covered(structural), covered(oracle), id + ' covers the same labels through the receipt path')
    assert.equal(structural.calls.backgroundChecks, oracle.calls.backgroundChecks, id + ' checks the same number of times')
  }
})

test('a deferred or skipped receipt never claims ids and never advances the cursor', () => {
  const skipped = ab.receiptToCredential({ status: 'skipped', outcome: 'held', reasonCode: 'conflict', createdIds: ['x'], updatedIds: ['y'], heldIds: ['z'] })
  assert.equal(skipped.outcome, 'no_value', 'an outcome outside the enum falls back instead of failing the whole credential')
  assert.deepEqual(skipped.createdIds, [], 'harness rule: a non-completed status claims no ids')
  assert.deepEqual(skipped.updatedIds, [])
  assert.deepEqual(skipped.heldIds, [])
  assert.equal(ab.canAdvance(skipped), false, 'skipped does not advance the cursor in this harness')

  const deferredNull = ab.receiptToCredential({ status: 'deferred', outcome: null, reasonCode: 'half-step' })
  assert.equal(deferredNull.outcome, 'no_value')
  assert.equal(deferredNull.status, 'deferred')
  assert.equal(ab.canAdvance(deferredNull), false)

  const completed = ab.receiptToCredential({ status: 'completed', outcome: 'created', createdIds: ['a'], updatedIds: [], heldIds: [] })
  assert.deepEqual(completed.createdIds, ['a'])
  assert.equal(ab.canAdvance(completed), true)
})

test('a missing, malformed or invalid receipt is a retryable failure, never no_value', () => {
  const missing = ab.workerStructuralFromMessage('整理完了，没有值得记的。')
  assert.equal(missing.status, 'failed')
  assert.equal(missing.reasonCode, 'receipt-missing')
  assert.equal(missing.retryable, true)
  assert.equal(ab.canAdvance(missing), false)

  const malformed = ab.workerStructuralFromMessage('```memu-consolidation-receipt\n{ not json\n```')
  assert.equal(malformed.status, 'failed')
  assert.equal(malformed.reasonCode, 'receipt-malformed')
  assert.equal(malformed.retryable, true)

  const invalid = ab.workerStructuralFromMessage('```memu-consolidation-receipt\n' + JSON.stringify({
    version: 1, status: 'completed', outcome: 'created', createdIds: ['a'],
  }) + '\n```')
  assert.equal(invalid.status, 'failed', 'a terminal receipt without a checkedRange is invalid')
  assert.equal(invalid.reasonCode, 'receipt-invalid')
  assert.equal(invalid.retryable, true)
})

test('the structural row is opt-in and does not change the default report', () => {
  assert.deepEqual(ab.DEFAULT_ROW_IDS, ['legacy', 'guide', 'guide-weighted:oracle', 'guide-weighted:no-value'])
  const rows = report.mainAxis.rows.map(row => row.row)
  assert.equal(rows.includes('guide-weighted:structural'), false, 'the structural row must not enter the default report')
  assert.equal(ab.ROWS.length, 5, 'the row exists in the registry for explicit selection')
})

test('the contract the worker is told to satisfy is the one this harness parses', async () => {
  const worker = await import(pathToFileURL(path.join(ROOT, 'lib', 'consolidation-worker.js')).href)
  const receipt = await import(pathToFileURL(path.join(ROOT, 'lib', 'consolidation-receipt.js')).href)

  const snapshot = { fromSeq: 0, throughSeq: 97, eventCount: 98, hash: 'a'.repeat(64) }
  const contract = receipt.receiptContractText({ jobId: 'ab-contract', snapshotHash: snapshot.hash })
  const brief = worker.buildWorkerBrief({ snapshot, probe: { tools: ['memu_private_remember', 'memu_private_recall'] }, contract })

  assert.ok(brief.includes(contract), 'the brief must carry the receipt contract verbatim')
  assert.ok(brief.includes(String(snapshot.throughSeq)), 'the brief must state the snapshot range')
  assert.ok(brief.includes('memu_private_remember'), 'the brief must name the write tool it expects')
  assert.match(brief, /没有回执视为本次整理失败/)

  // 把 brief 要求的字段原样交回去，必须能被 parseReceipt 接受：
  // 否则 worker 按任务书写出的东西，harness 读不了。
  const text = [receipt.RECEIPT_FENCE, JSON.stringify({
    version: 1,
    jobId: 'ab-contract',
    snapshotHash: snapshot.hash,
    status: 'completed',
    outcome: 'created',
    checkedRange: { fromSeq: snapshot.fromSeq, throughSeq: snapshot.throughSeq },
    createdIds: ['mem-ab-scale-plan-scope'],
    updatedIds: [],
    heldIds: [],
    retryable: false,
  }), receipt.RECEIPT_FENCE].join('\n')
  const parsed = receipt.parseReceipt(text)
  assert.equal(parsed.ok, true, 'a receipt written to the brief contract must parse: ' + (parsed.problems || parsed.detail || ''))

  const credential = ab.receiptToCredential(parsed.receipt)
  assert.equal(ab.canAdvance(credential), true)
  assert.deepEqual(credential.createdIds, ['mem-ab-scale-plan-scope'])
})
