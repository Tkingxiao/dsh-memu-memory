import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-update-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const inject = await import('../lib/inject.js')
const rpc = await import('../lib/rpc.js')

test.after(() => {
  try { state.flushState() } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

const binding = state.ensureSession('upd', { cwd: path.join(home, 'coding') })
const exec = { agent: { session: { header: { id: 'upd', cwd: path.join(home, 'coding') } } } }
const local = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0)

// The write side settles a relative day into a real date, and the repair side has to
// agree with it: re-submitting "10-29" for a body that says 明天 would otherwise
// re-create exactly the yearly anniversary the repair was meant to remove.
test('a relative day settles the year, a month-day that does not match is left alone', () => {
  const now = local(2026, 10, 28)
  assert.equal(memory.reconcileSalientDate('10-29', '明天要去考驾照', now), '2026-10-29')
  assert.equal(memory.reconcileSalientDate('10-30', '后天出发', now), '2026-10-30')
  assert.equal(memory.reconcileSalientDate('10-30', '明天要去考驾照', now), '10-30', 'a month-day the text does not point at must not be rewritten')
  assert.equal(memory.reconcileSalientDate('10-28', '用户的生日是 10 月 28 日', now), '10-28', 'no relative day, so it stays annual')
  assert.equal(memory.reconcileSalientDate('10-29', '定在 2027-10-29 见面', now), '2027-10-29', 'an explicit full date in the text wins')
  assert.equal(memory.reconcileSalientDate('2026-10-29', '明天', now), '2026-10-29', 'an already-dated value is never rewritten')
  assert.equal(memory.reconcileSalientDate('', '明天', now), '')
})

test('the write path stores the settled date, not a yearly anniversary', async () => {
  const dated = await memory.privateRemember({ exec, title: '面试', content: '面试定在 2027-03-05 上午。', salientDate: '03-05' })
  assert.equal(dated.entry.salientDate, '2027-03-05')
  const annual = await memory.privateRemember({ exec, title: '生日', content: '用户的生日是 10 月 28 日。', salientDate: '10-28' })
  assert.equal(annual.entry.salientDate, '10-28')
})

// A dated memory the anchor does not date is a memory the model cannot reason about:
// it reads "明天要考驾照" every turn and cannot tell when 明天 is, or that it passed.
test('the anchor line carries the date and says which kind it is', () => {
  const lib = state.ensureSession('upd-anchor', { cwd: path.join(home, 'anchor') })
  const now = local(2026, 10, 29)
  const index = state.loadPrivateIndex(lib.libraryId)
  const base = { track: 'memory', status: 'active', createdAt: now.toISOString(), updatedAt: now.toISOString(), confidence: 0.8 }
  index.entries['mem-dated'] = { ...base, layer: 'must_remember', title: '考驾照', content: '明天要去考驾照。', salientDate: '2026-10-29', pinReason: '用户明确要求记住这件事', pinSource: 'user_explicit' }
  index.entries['mem-annual'] = { ...base, layer: 'long_term', title: '第一次一起看海', content: '那天下着小雨。', salientDate: '10-29' }
  index.entries['mem-plain'] = { ...base, layer: 'long_term', title: '普通记忆', content: '没有日期。' }
  state.savePrivateIndex(lib.libraryId, index)
  const anchor = inject.buildAnchor(lib, state.getSettings(), 'upd-anchor')
  assert.match(anchor.text, /mem-dated[^\n]* · date=2026-10-29/)
  assert.match(anchor.text, /mem-annual[^\n]* · anniversary=10-29/)
  assert.doesNotMatch(anchor.text, /mem-dated[^\n]*anniversary=/, 'a one-off is not labelled as a recurring date')
  assert.doesNotMatch(anchor.text, /mem-plain[^\n]* · (date|anniversary)=/, 'an undated entry grows no label')
})

test('provenance and track can be corrected after the fact', async () => {
  const saved = await memory.privateRemember({ exec, title: '引用', content: '用户说他不喜欢远程办公。' })
  assert.equal(saved.entry.source, 'inferred')
  const fixed = await memory.privateUpdate({ exec, id: saved.id, source: 'user_said', track: 'habit' })
  assert.equal(fixed.entry.source, 'user_said', 'a quote filed as an inference must be repairable')
  assert.equal(fixed.entry.track, 'habit')
  await assert.rejects(() => memory.privateUpdate({ exec, id: saved.id, source: 'hearsay' }), /source/)
  await assert.rejects(() => memory.privateUpdate({ exec, id: saved.id, track: 'hunch' }), /track/)
})

// A value the caller supplied is accepted or refused, never ignored: the old code
// answered `confidence: 'high'` with success and changed nothing at all.
test('dirty numbers are refused, out-of-range numbers are clamped', async () => {
  const saved = await memory.privateRemember({ exec, title: '情绪', content: '那天很吵。' })
  await assert.rejects(() => memory.privateUpdate({ exec, id: saved.id, confidence: 'high' }), /confidence/)
  await assert.rejects(() => memory.privateUpdate({ exec, id: saved.id, moodValence: 'sad' }), /moodValence/)
  await assert.rejects(() => memory.privateUpdate({ exec, id: saved.id, arousal: NaN }), /arousal/)
  const clamped = await memory.privateUpdate({ exec, id: saved.id, moodValence: 3, arousal: 2 })
  assert.equal(clamped.entry.moodValence, 1)
  assert.equal(clamped.entry.arousal, 1)
})

// accuracy is derived; correcting the charge must move it too, otherwise the repair
// only changes how the entry is stored and not how far it is trusted when recalled.
test('accuracy is recomputed when the charged fields change', async () => {
  const saved = await memory.privateRemember({ exec, title: '闪光灯记忆', content: '那一刻所有人都愣住了。', confidence: 0.8 })
  assert.equal(saved.entry.accuracy, 0.8)
  const charged = await memory.privateUpdate({ exec, id: saved.id, arousal: 0.9 })
  assert.equal(charged.entry.accuracy, memory.accuracyOf({ peak: false, arousal: 0.9, confidence: 0.8 }))
  assert.ok(charged.entry.accuracy < 0.8, 'a charged memory is vivid, not automatically accurate')
  const peaked = await memory.privateUpdate({ exec, id: saved.id, peak: true })
  assert.equal(peaked.entry.peak, true)
  assert.equal(peaked.entry.accuracy, memory.accuracyOf({ peak: true, arousal: 0.9, confidence: 0.8 }))
})

// The tool description has promised "short_term to re-arm the deadline" since the
// tool existed, while the code skipped the whole block when the layer did not change.
test('asking for short_term again re-arms the deadline instead of doing nothing', async () => {
  const saved = await memory.privateRemember({ exec, title: '草稿', content: '还在整理的想法。', layer: 'short_term' })
  assert.equal(saved.entry.layer, 'short_term')
  const first = saved.entry.expiresAt
  assert.ok(first, 'a short_term entry carries a deadline')
  await new Promise(resolve => setTimeout(resolve, 12))
  const rearmed = await memory.privateUpdate({ exec, id: saved.id, layer: 'short_term' })
  assert.ok(Date.parse(rearmed.entry.expiresAt) > Date.parse(first), 'the deadline moves forward')
  assert.equal(rearmed.entry.promotedFrom, undefined, 'a re-arm is not a promotion')
  const promoted = await memory.privateUpdate({ exec, id: saved.id, layer: 'long_term' })
  assert.equal(promoted.entry.layer, 'long_term')
  assert.equal(promoted.entry.expiresAt, undefined)
  assert.equal(promoted.entry.promotedFrom, 'short_term')
})

test('an attachment list can only reference files this library received', async () => {
  const saved = await memory.privateRemember({ exec, title: '照片', content: '一张照片的记忆。' })
  const missing = 'a'.repeat(64)
  await assert.rejects(() => memory.privateUpdate({ exec, id: saved.id, attachments: [missing] }), /attachment/)
})

// The panel and any script talk to updateMemory, where an unknown key used to be
// dropped in silence: a typo came back as a successful save that changed nothing.
test('the RPC refuses unknown fields and accepts the newly editable ones', async () => {
  const saved = await memory.privateRemember({ exec, title: '面板', content: '从面板改的记忆。' })
  await assert.rejects(
    () => rpc.dispatch({}, 'updateMemory', { libraryId: binding.libraryId, id: saved.id, patch: { salientdate: '2026-10-29' } }),
    /unknown memory field/,
    'a near miss in the field name must not look like a successful save',
  )
  const applied = await rpc.dispatch({}, 'updateMemory', {
    libraryId: binding.libraryId,
    id: saved.id,
    patch: { salientDate: '2026-10-29', source: 'user_said', track: 'habit' },
  })
  assert.equal(applied.entry.salientDate, '2026-10-29')
  assert.equal(applied.entry.source, 'user_said')
  assert.equal(applied.entry.track, 'habit')
})
