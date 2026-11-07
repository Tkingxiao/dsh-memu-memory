import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-slots-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const similarity = await import('../lib/text-similarity.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

let seq = 0
function session(name) {
  seq += 1
  const cwd = path.join(home, 'ws', `${name}-${seq}`)
  const sessionId = `${name}-${seq}`
  state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  return {
    sessionId,
    libraryId: state.getSessionBinding(sessionId).libraryId,
    exec: { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding' } } } },
  }
}

const LOAN_A = '图书馆借阅规则：每人每次最多借五本书，借期十四天，可以续借一次，逾期按天收取滞纳金，闭馆日不办理。'
const LOAN_B = '图书馆借阅规则：每人每次最多借七本书，借期十四天，可以续借一次，逾期按天收取滞纳金，闭馆日不办理。'

test('numbers, dates, times, weekdays and quoted names are slot conflicts', () => {
  const cases = [
    [LOAN_A, LOAN_B],
    ['复诊安排在2026-11-08上午十点。', '复诊安排在2026-11-15上午十点。'],
    ['每周一上午九点开会。', '每周二上午九点开会。'],
    ['他说“林眠”明天会来，而且会带伞。', '他说“Yuike”明天会来，而且会带伞。'],
  ]
  for (const [a, b] of cases) {
    const detail = similarity.similarityDetail(a, b)
    assert.equal(detail.slotConflict, true, a.slice(0, 18))
    assert.ok(detail.dice >= similarity.TOPIC_DICE, 'fixture must be similar enough to inspect slots')
    assert.ok(similarity.similarTexts(a, b) < similarity.TOPIC_DICE, 'slot conflict must fall below the topic band')
  }
  assert.deepEqual(similarity.slotSignature('借五本书，等十五天').numbers.sort(), ['15', '5'])
})

test('same slots and added numbers are not capped', () => {
  assert.equal(similarity.similarityDetail(LOAN_A, LOAN_A).slotConflict, false)
  const same = '图书馆借阅规则：每人每次最多借五本书，借期十四天。'
  const added = '图书馆借阅规则：每人每次最多借五本书，借期十四天，押金二十元，每人限办一张卡。'
  const detail = similarity.similarityDetail(same, added)
  assert.equal(detail.slotConflict, false, 'an added number is an enrichment, not a contradiction')
  assert.equal(similarity.similarTexts(same, added), Math.max(detail.dice, detail.containment))
  // Totally unrelated text never pays for slot extraction and is not a conflict.
  assert.equal(similarity.similarityDetail('窗外的雨停了。', '图书馆周三闭馆。').slotConflict, false)
})

test('different-title facts that only change a number both stay active', async () => {
  const { exec, libraryId } = session('slot-write')
  const first = await memory.privateRemember({ exec, title: '借阅上限', content: LOAN_A })
  const raw = similarity.similarityDetail(LOAN_A, LOAN_B)
  assert.ok(raw.dice >= similarity.DUP_REJECT_DICE, 'fixture must sit in the old reject band, got ' + raw.dice)
  assert.equal(raw.slotConflict, true)
  const second = await memory.privateRemember({ exec, title: '借阅额度', content: LOAN_B })
  assert.equal(second.deduped, undefined)
  assert.equal(second.entry.status, 'active')
  assert.equal(second.entry.duplicateOf, undefined)
  const index = state.loadPrivateIndex(libraryId)
  assert.equal(Object.keys(index.entries).length, 2)
  assert.equal(index.entries[first.id].status, 'active')
  assert.equal(index.entries[second.id].content, LOAN_B)
})

test('same title + changed number is held as a conflict, not swallowed as duplicate', async () => {
  const { exec, libraryId } = session('slot-same-title')
  const first = await memory.privateRemember({ exec, title: '借阅上限', content: LOAN_A })
  const second = await memory.privateRemember({ exec, title: '借阅上限', content: LOAN_B })
  assert.equal(second.conflict, first.id, 'same-title slot correction must be a conflict')
  const index = state.loadPrivateIndex(libraryId)
  assert.equal(index.entries[second.id].status, 'pending_review')
  assert.match(index.entries[second.id].reviewReason, /slot|说法|同题/)
  assert.equal(index.entries[second.id].content, LOAN_B, 'the corrected text is preserved')
})

test('an update that only changes a number is not refused as a duplicate', async () => {
  const { exec, libraryId } = session('slot-update')
  const index = state.loadPrivateIndex(libraryId)
  const now = new Date().toISOString()
  index.entries['mem-host'] = {
    title: '借阅上限', content: LOAN_A,
    status: 'active', layer: 'long_term', createdAt: now, updatedAt: now,
  }
  index.entries['mem-target'] = {
    title: '借阅额度备注', content: '这条先占位，稍后改成正式规则。',
    status: 'active', layer: 'long_term', createdAt: now, updatedAt: now,
  }
  state.savePrivateIndex(libraryId, index)
  const updated = await memory.privateUpdate({ exec, id: 'mem-target', content: LOAN_B })
  assert.equal(updated.entry.content, LOAN_B)
  assert.equal(updated.entry.status, 'active')
  assert.equal(updated.entry.duplicateOf, undefined, 'a slot change is a different fact, not a duplicate')
})

test('recall keeps same-template different-number facts in separate seats', async () => {
  const { exec, libraryId } = session('slot-recall')
  const index = state.loadPrivateIndex(libraryId)
  const now = new Date().toISOString()
  index.entries['mem-five'] = {
    title: '借阅上限五本', content: LOAN_A,
    status: 'active', layer: 'long_term', createdAt: now, updatedAt: now,
  }
  index.entries['mem-seven'] = {
    title: '借阅上限七本', content: LOAN_B,
    status: 'active', layer: 'long_term', createdAt: now, updatedAt: now,
  }
  state.savePrivateIndex(libraryId, index)
  const raw = similarity.similarityDetail(LOAN_A, LOAN_B)
  assert.ok(raw.dice >= similarity.DUP_DICE, 'fixture must be in the old folding band')
  const recalled = await memory.privateRecall({ exec, query: '图书馆借阅规则', topK: 10, relevanceThreshold: 0 })
  const ids = recalled.files.map((file) => file.name)
  assert.ok(ids.includes('mem-five') && ids.includes('mem-seven'), 'distinct facts must keep two seats')
  assert.deepEqual(recalled.dedup?.collapsed || [], [], 'the pair must not be folded')
})

test('A-10: similarity thresholds have a single source; compat exports keep their values', () => {
  assert.deepEqual(similarity.SIMILARITY_THRESHOLDS, {
    duplicateDice: 0.82,
    rejectDice: 0.90,
    topicDice: 0.55,
    lengthPruneRatio: 0.5,
    containmentFloor: 0.92,
    probeMinChars: 6,
    probeMaxChars: 240,
  })
  assert.equal(similarity.DUP_DICE, similarity.SIMILARITY_THRESHOLDS.duplicateDice)
  assert.equal(similarity.DUP_REJECT_DICE, similarity.SIMILARITY_THRESHOLDS.rejectDice)
  assert.equal(similarity.TOPIC_DICE, similarity.SIMILARITY_THRESHOLDS.topicDice)
  assert.equal(similarity.LENGTH_PRUNE_RATIO, similarity.SIMILARITY_THRESHOLDS.lengthPruneRatio)
  assert.equal(similarity.CONTAINMENT_FLOOR, similarity.SIMILARITY_THRESHOLDS.containmentFloor)
  assert.equal(similarity.CORE_COVER_FLOOR, similarity.SIMILARITY_THRESHOLDS.rejectDice)
  for (const value of [similarity.DUP_DICE, similarity.DUP_REJECT_DICE, similarity.TOPIC_DICE, similarity.CONTAINMENT_FLOOR]) {
    assert.equal(typeof value, 'number', 'compat exports stay plain numbers')
  }
})

test('D-21: jaccard is exported from the shared ruler with the old formula', () => {
  assert.equal(similarity.jaccard(new Set(), new Set(['a'])), 0)
  assert.equal(similarity.jaccard(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3)
  assert.equal(similarity.jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1)
})
