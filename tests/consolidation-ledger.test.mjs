import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-cons-ledger-'))
process.env.DSH_MEMU_HOME = home

const ledger = await import('../lib/consolidation-ledger.js')
const receipt = await import('../lib/consolidation-receipt.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

let counter = 0
function binding(patch = {}) {
  counter += 1
  return {
    scopeKey: 'd:/proj',
    libraryId: 'lib_test',
    domain: 'rp',
    useLibrary: true,
    useGlobal: false,
    memoryOwnerSessionId: 'owner-' + counter,
    memoryContext: { channelId: 'ch-' + counter },
    ...patch,
  }
}

function snapshot(through = 20, from = 0) {
  return { hash: 'hash-' + through + '-' + from, fromSeq: from, throughSeq: through, eventCount: through - from + 1, source: 'lease-live' }
}

// C 包第 5 条：checked/pending/inflight 三个边界分开记，一个失败不能把三个一起推错。

test('a job holds a lease and a second job is refused while it is live', () => {
  const sessionId = 'led-lease'
  const first = ledger.beginJob({ sessionId, jobId: 'job-1', snapshot: snapshot(20), binding: binding() })
  assert.equal(first.ok, true)
  assert.ok(first.job.leaseUntil > Date.now())
  assert.equal(first.job.scopeGeneration.length, 8)
  const second = ledger.beginJob({ sessionId, jobId: 'job-2', snapshot: snapshot(20), binding: binding() })
  assert.equal(second.ok, false)
  assert.equal(second.reasonCode, 'lease-held')
  assert.equal(second.jobId, 'job-1')
})

test('evidence advances the pending boundary only, never the checked one', () => {
  const sessionId = 'led-pending'
  const first = ledger.noteEvidence({ sessionId, fromSeq: 0, throughSeq: 12 })
  assert.equal(first.changed, true)
  assert.equal(first.pending.throughSeq, 12)
  ledger.noteEvidence({ sessionId, fromSeq: 0, throughSeq: 30 })
  const state = ledger.sessionState(sessionId)
  assert.equal(state.pending.throughSeq, 30)
  assert.equal(state.checked, null)
  // 回退不会发生：更小的边界不会把 pending 拉回去。
  ledger.noteEvidence({ sessionId, fromSeq: 0, throughSeq: 10 })
  assert.equal(ledger.sessionState(sessionId).pending.throughSeq, 30)
})

test('a completed job advances checked and clears pending', () => {
  const sessionId = 'led-complete'
  ledger.noteEvidence({ sessionId, throughSeq: 18 })
  ledger.beginJob({ sessionId, jobId: 'job-c', snapshot: snapshot(20), binding: binding() })
  const done = ledger.completeJob({
    sessionId, jobId: 'job-c', snapshot: snapshot(20),
    covered: { fromSeq: 0, throughSeq: 20 },
    status: 'completed', outcome: 'created', counts: { created: 2 },
    receipt: { status: 'completed', outcome: 'created', reasonCode: null },
  })
  assert.equal(done.advanced, true)
  assert.equal(done.checked.throughSeq, 20)
  assert.equal(done.checked.status, 'completed')
  assert.equal(done.checked.snapshotHash, 'hash-20-0')
  assert.equal(done.pending, null, 'the whole pending range was covered')
  const state = ledger.sessionState(sessionId)
  assert.equal(state.inflight, null)
  assert.equal(state.attempts, 0)
  assert.equal(state.history.at(-1).status, 'completed')
})

test('a failed job keeps the range pending and backs off', () => {
  const sessionId = 'led-fail'
  ledger.beginJob({ sessionId, jobId: 'job-f', snapshot: snapshot(20), binding: binding() })
  const failed = ledger.failJob({ sessionId, jobId: 'job-f', reasonCode: 'fork-turn-failed', error: 'boom' })
  assert.equal(failed.pending.throughSeq, 20)
  assert.ok(failed.retryAt, 'a retryable failure schedules a retry')
  const state = ledger.sessionState(sessionId)
  assert.equal(state.checked, null, 'a failure never advances the checked cursor')
  assert.equal(state.lastReasonCode, 'fork-turn-failed')
  assert.equal(state.attempts, 1)
})

test('only completed and reasoned skipped receipts may advance', () => {
  for (const [status, reasonCode, expected] of [['completed', null, true], ['skipped', 'no-value', true], ['skipped', null, false], ['failed', 'receipt-missing', false], ['deferred', 'open-turn', false]]) {
    const sessionId = 'led-status-' + status + '-' + String(reasonCode)
    ledger.beginJob({ sessionId, jobId: 'job-s', snapshot: snapshot(9), binding: binding() })
    const done = ledger.completeJob({ sessionId, jobId: 'job-s', snapshot: snapshot(9), covered: { fromSeq: 0, throughSeq: 9 }, status, outcome: 'no_value', reasonCode, retryable: true })
    assert.equal(done.advanced, expected, status + '/' + String(reasonCode) + ' advance=' + expected)
    const state = ledger.sessionState(sessionId)
    assert.equal(state.checked === null, !expected)
    if (!expected) assert.equal(state.pending.throughSeq, 9, 'the range stays pending for the next attempt')
  }
})

test('a receipt cannot claim more than the snapshot covered', () => {
  const sessionId = 'led-clamp'
  ledger.beginJob({ sessionId, jobId: 'job-k', snapshot: snapshot(20), binding: binding() })
  const done = ledger.completeJob({
    sessionId, jobId: 'job-k', snapshot: snapshot(20),
    covered: { fromSeq: 0, throughSeq: 99 },
    status: 'completed', outcome: 'no_value',
  })
  assert.equal(done.advanced, false, 'out-of-range coverage is rejected, never clamped')
  assert.equal(done.checked, null)
})

test('a partial cover keeps the rest pending', () => {
  const sessionId = 'led-partial'
  ledger.noteEvidence({ sessionId, throughSeq: 40 })
  ledger.beginJob({ sessionId, jobId: 'job-p', snapshot: snapshot(40), binding: binding() })
  const done = ledger.completeJob({ sessionId, jobId: 'job-p', snapshot: snapshot(40), covered: { fromSeq: 0, throughSeq: 25 }, status: 'completed', outcome: 'no_value' })
  assert.equal(done.advanced, false)
  assert.equal(done.checked, null, 'partial coverage must not advance checked')
  assert.equal(done.pending.throughSeq, 40)
  assert.equal(done.pending.fromSeq, 0)
})

test('an expired lease is recovered as a failure, not as a completed run', () => {
  const sessionId = 'led-zombie'
  const started = Date.now() - 60_000
  ledger.beginJob({ sessionId, jobId: 'job-z', snapshot: snapshot(12), binding: binding(), now: started, leaseMs: 1_000 })
  const recovered = ledger.recoverStaleJobs({ now: Date.now() })
  assert.ok(recovered.some((row) => row.sessionId === sessionId))
  const state = ledger.sessionState(sessionId)
  assert.equal(state.inflight, null)
  assert.equal(state.checked, null, 'an interrupted job proves nothing')
  assert.equal(state.pending.throughSeq, 12, 'its range is pending again')
  assert.equal(state.lastReasonCode, 'lease-expired')
})

test('a live lease is not recovered', () => {
  const sessionId = 'led-live-lease'
  ledger.beginJob({ sessionId, jobId: 'job-live', snapshot: snapshot(4), binding: binding() })
  ledger.recoverStaleJobs({ now: Date.now() })
  assert.ok(ledger.sessionState(sessionId).inflight, 'a job inside its lease keeps the session')
})

test('the operation key is stable and records what was settled', () => {
  const args = { sessionId: 'led-op', libraryId: 'lib_test', snapshotHash: 'hash-20-0' }
  const key = ledger.operationKey(args)
  assert.equal(key, ledger.operationKey({ ...args }))
  assert.notEqual(key, ledger.operationKey({ ...args, snapshotHash: 'hash-21-0' }))
  assert.equal(ledger.findOperation('led-op', key), null)
  ledger.recordOperation({ sessionId: 'led-op', key, outcome: 'completed', ids: ['mem-1'] })
  const found = ledger.findOperation('led-op', key)
  assert.equal(found.outcome, 'completed')
  assert.deepEqual(found.ids, ['mem-1'])
})

test('two sessions do not overwrite each other in the ledger', () => {
  ledger.beginJob({ sessionId: 'led-a', jobId: 'job-a', snapshot: snapshot(3), binding: binding() })
  ledger.beginJob({ sessionId: 'led-b', jobId: 'job-b', snapshot: snapshot(7), binding: binding() })
  assert.equal(ledger.sessionState('led-a').inflight.jobId, 'job-a')
  assert.equal(ledger.sessionState('led-b').inflight.jobId, 'job-b')
})

test('the scope generation changes with the parent authorization', () => {
  const base = binding()
  const first = ledger.scopeGenerationOf(base)
  assert.equal(first, ledger.scopeGenerationOf({ ...base }))
  assert.notEqual(first, ledger.scopeGenerationOf({ ...base, libraryId: 'lib_other' }))
  assert.notEqual(first, ledger.scopeGenerationOf({ ...base, useLibrary: false }))
  assert.notEqual(first, ledger.scopeGenerationOf({ ...base, memoryContext: { channelId: 'other' } }))
  assert.equal(ledger.scopeGenerationOf(null), null)
})

test('a corrupt ledger blocks writes instead of silently replacing it', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-cons-corrupt-'))
  const previous = process.env.DSH_MEMU_HOME
  process.env.DSH_MEMU_HOME = other
  try {
    fs.writeFileSync(path.join(other, 'consolidation.json'), '{ not json', 'utf8')
    assert.throws(() => ledger.beginJob({ sessionId: 'led-corrupt', jobId: 'job-x', snapshot: snapshot(1), binding: binding() }), /refusing to overwrite|not valid JSON|busy/i)
    assert.equal(ledger.sessionState('led-corrupt').inflight, null)
  } finally {
    process.env.DSH_MEMU_HOME = previous
    try { fs.rmSync(other, { recursive: true, force: true }) } catch {}
  }
})

// ---- 结构化回执 ----

function fence(json) {
  const tick = String.fromCharCode(96)
  return [tick + tick + tick + receipt.RECEIPT_TAG, JSON.stringify(json, null, 2), tick + tick + tick].join('\n')
}

test('a receipt without its fence block is missing, never guessed', () => {
  const parsed = receipt.parseReceipt('我整理完了，写了两条记忆。')
  assert.equal(parsed.ok, false)
  assert.equal(parsed.reasonCode, 'receipt-missing')
})

test('malformed JSON and invalid shapes are distinguishable failures', () => {
  const tick = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96)
  const broken = [tick + receipt.RECEIPT_TAG, '{ "status": "completed", ', tick].join('\n')
  assert.equal(receipt.parseReceipt(broken).reasonCode, 'receipt-malformed')
  const badStatus = receipt.parseReceipt(fence({ status: 'done', outcome: 'created', createdIds: ['mem-1'] }))
  assert.equal(badStatus.reasonCode, 'receipt-invalid')
  assert.match(badStatus.detail, /status must be one of/)
})

test('created without ids, or skipped without a reasonCode, is invalid', () => {
  assert.equal(receipt.parseReceipt(fence({ status: 'completed', outcome: 'created', createdIds: [] })).reasonCode, 'receipt-invalid')
  assert.equal(receipt.parseReceipt(fence({ status: 'skipped', outcome: 'no_value' })).reasonCode, 'receipt-invalid')
  const ok = receipt.parseReceipt(fence({ status: 'skipped', outcome: 'no_value', reasonCode: 'no-value', checkedRange: { fromSeq: 0, throughSeq: 4 } }))
  assert.equal(ok.ok, true)
})

test('no_value cannot smuggle in written ids', () => {
  const parsed = receipt.parseReceipt(fence({ status: 'completed', outcome: 'no_value', createdIds: ['mem-1'], checkedRange: { fromSeq: 0, throughSeq: 4 } }))
  assert.equal(parsed.reasonCode, 'receipt-invalid')
})

test('the receipt is reconciled against the library, not taken on trust', () => {
  const index = { entries: { 'mem-1': { status: 'active' }, 'mem-held': { status: 'pending_review' } } }
  const parsed = receipt.parseReceipt(fence({
    status: 'completed', outcome: 'created', createdIds: ['mem-1', 'mem-ghost'], checkedRange: { fromSeq: 0, throughSeq: 8 },
  }))
  assert.equal(parsed.ok, true)
  const reconciled = receipt.reconcileReceipt({ receipt: parsed.receipt, index, beforeIds: new Set() })
  assert.equal(reconciled.ok, false)
  assert.match(reconciled.problems.join(' '), /mem-ghost/)
})

test('rewriting an existing id is an update, not a new memory', () => {
  const index = { entries: { 'mem-1': { status: 'active', content: 'after' } } }
  const parsed = receipt.parseReceipt(fence({ status: 'completed', outcome: 'created', createdIds: ['mem-1'], checkedRange: { fromSeq: 0, throughSeq: 4 } }))
  const reconciled = receipt.reconcileReceipt({ receipt: parsed.receipt, index, beforeIds: new Set(['mem-1']), beforeEntries: { 'mem-1': receipt.entryFingerprint({ status: 'active', content: 'before' }) } })
  assert.equal(reconciled.ok, true)
  assert.deepEqual(reconciled.createdIds, [])
  assert.deepEqual(reconciled.duplicateIds, ['mem-1'])
  assert.equal(reconciled.outcome, 'updated')
})

test('an unchanged existing id cannot prove an update', () => {
  const index = { entries: { 'mem-unchanged': { status: 'active', content: 'same' } } }
  const parsed = receipt.parseReceipt(fence({ status: 'completed', outcome: 'updated', updatedIds: ['mem-unchanged'], checkedRange: { fromSeq: 0, throughSeq: 4 } }))
  const reconciled = receipt.reconcileReceipt({
    receipt: parsed.receipt,
    index,
    beforeIds: new Set(['mem-unchanged']),
    beforeEntries: { 'mem-unchanged': receipt.entryFingerprint(index.entries['mem-unchanged']) },
  })
  assert.equal(reconciled.ok, false)
  assert.match(reconciled.problems.join(' '), /no verified post-worker change/)
})

test('a held id must really be pending_review', () => {
  const index = { entries: { 'mem-1': { status: 'active' } } }
  const parsed = receipt.parseReceipt(fence({ status: 'completed', outcome: 'no_value', heldIds: ['mem-1'], checkedRange: { fromSeq: 0, throughSeq: 4 } }))
  const reconciled = receipt.reconcileReceipt({ receipt: parsed.receipt, index })
  assert.equal(reconciled.ok, false)
  assert.match(reconciled.problems.join(' '), /not pending_review/)
})

test('decideCompletion: proof advances, guesswork does not', () => {
  const index = { entries: { 'mem-7': { status: 'active' } } }
  const good = receipt.decideCompletion({
    text: fence({ status: 'completed', outcome: 'created', createdIds: ['mem-7'], checkedRange: { fromSeq: 0, throughSeq: 9 } }),
    wrote: 1, index, beforeIds: new Set(),
  })
  assert.equal(good.advance, true)
  assert.equal(good.outcome, 'created')
  assert.deepEqual(good.counted, { created: 1, updated: 0, held: 0 })
  const unverified = receipt.decideCompletion({ text: fence({ status: 'completed', outcome: 'created', createdIds: ['mem-404'], checkedRange: { fromSeq: 0, throughSeq: 9 } }), wrote: 0, index, beforeIds: new Set() })
  assert.equal(unverified.advance, false)
  assert.equal(unverified.reasonCode, 'receipt-unverified')
  const silent = receipt.decideCompletion({ text: '我做了不少事情。', wrote: 0, index, beforeIds: new Set() })
  assert.equal(silent.advance, false)
  assert.equal(silent.reasonCode, 'receipt-missing')
})

test('decideCompletion never settles a silent worker on its own', () => {
  // 结算空正文的规则已经上移到 private.js 的调用点：那里知道「worker 一个字没说、库里也没
  // 多出条目」这一种情形（见 tests/consolidation-fork.test.mjs 与 tests/cycle.test.mjs）。
  // 模块层只保留一个方向的保证：没有回执就不给凭证。
  const silent = receipt.decideCompletion({ text: '', wrote: 0 })
  assert.equal(silent.advance, false)
  assert.equal(silent.reasonCode, 'receipt-missing')
  const unattributed = receipt.decideCompletion({ text: '', wrote: 2 })
  assert.equal(unattributed.advance, false)
  assert.match(unattributed.error, /receipt|cannot settle/i)
})