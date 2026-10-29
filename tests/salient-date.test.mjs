import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-salient-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const inject = await import('../lib/inject.js')

test.after(() => {
  try { state.flushState() } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

const binding = state.ensureSession('salient', { cwd: path.join(home, 'coding') })
const exec = { agent: { session: { header: { id: 'salient', cwd: path.join(home, 'coding') } } } }
const local = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0)

test('a date with a year keeps it; a bare month-day stays annual', () => {
  assert.equal(memory.normalizeSalientDate('2026-10-29'), '2026-10-29')
  assert.equal(memory.normalizeSalientDate('2026/10/29'), '2026-10-29')
  assert.equal(memory.normalizeSalientDate('2026-10-29T08:00:00+08:00'), '2026-10-29')
  assert.equal(memory.normalizeSalientDate('10-29'), '10-29')
  assert.equal(memory.normalizeSalientDate('2024-02-29'), '2024-02-29', 'a leap day really exists')
  assert.equal(memory.normalizeSalientDate('2026-02-30'), null, 'an impossible date is refused, not rolled over')
  assert.equal(memory.normalizeSalientDate('2026-13-01'), null)
  assert.equal(memory.normalizeSalientDate('下次再说'), null)
  assert.equal(memory.normalizeSalientDate(null), null)
})

test('an anniversary recurs every year; a dated memory fires once and then is spent', () => {
  assert.equal(memory.salientDateFires('10-29', local(2026, 10, 29)), true)
  assert.equal(memory.salientDateFires('10-29', local(2031, 10, 29)), true, 'anniversaries recur')
  assert.equal(memory.salientDateFires('10-29', local(2026, 10, 30)), false)

  assert.equal(memory.salientDateFires('2026-10-29', local(2026, 10, 28)), true, 'the day before is the reminder')
  assert.equal(memory.salientDateFires('2026-10-29', local(2026, 10, 29)), true, 'the day itself')
  assert.equal(memory.salientDateFires('2026-10-29', local(2026, 10, 27)), false)
  assert.equal(memory.salientDateFires('2026-10-29', local(2026, 10, 30)), false, 'a one-off is spent once it has passed')
  assert.equal(memory.salientDateFires('2026-10-29', local(2027, 10, 28)), false, 'and never returns as an anniversary')
  assert.equal(memory.salientDateFires('2026-10-29', local(2027, 10, 29)), false)

  assert.equal(memory.salientDaysAhead('2026-10-29', local(2026, 10, 28)), 1)
  assert.equal(memory.salientDaysAhead('2026-10-29', local(2026, 10, 29)), 0)
  assert.equal(memory.salientDaysAhead('2026-10-29', local(2026, 10, 20)), 9)
  assert.equal(memory.salientDaysAhead('10-29', local(2026, 10, 28)), null)
})

test('a remembered appointment is stored with its year, and an unreadable date is refused', async () => {
  const saved = await memory.privateRemember({
    exec, title: '考驾照', content: '明天要去考驾照。', layer: 'long_term', salientDate: '2026-10-29',
  })
  assert.equal(saved.entry.salientDate, '2026-10-29')
  assert.ok(state.loadPrivateIndex(binding.libraryId).entries[saved.id].salientDate, 'the year survives the write to disk')
  await assert.rejects(
    () => memory.privateRemember({ exec, title: '坏日期', content: '日期写错了。', salientDate: '2026-02-30' }),
    /salient_date/,
    'a date that cannot be parsed is an error, not a silent drop',
  )
})

test('a stored date can be re-dated or cleared, and junk is refused', async () => {
  const saved = await memory.privateRemember({ exec, title: '周年', content: '每年都要记得的日子。', salientDate: '10-29' })
  const redated = await memory.privateUpdate({ exec, id: saved.id, salientDate: '2027-01-01' })
  assert.equal(redated.entry.salientDate, '2027-01-01')
  await assert.rejects(() => memory.privateUpdate({ exec, id: saved.id, salientDate: '2027-02-30' }), /salient_date/)
  const cleared = await memory.privateUpdate({ exec, id: saved.id, salientDate: null })
  assert.equal(cleared.entry.salientDate, undefined)
  const untouched = await memory.privateUpdate({ exec, id: saved.id, title: '周年（改名）' })
  assert.equal(untouched.entry.title, '周年（改名）', 'omitting salient_date leaves any date alone')
})

test('an appointment is announced as due, once per day, and never as an anniversary', () => {
  const lib = state.ensureSession('salient-due', { cwd: path.join(home, 'due') })
  const now = local(2026, 10, 28)
  const index = state.loadPrivateIndex(lib.libraryId)
  index.entries['mem-due'] = {
    track: 'memory', layer: 'must_remember', title: '考驾照', content: '明天要去考驾照。',
    status: 'active', salientDate: '2026-10-29', pinReason: '用户明确要求记住这件事', pinSource: 'user_explicit',
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  }
  state.savePrivateIndex(lib.libraryId, index)

  const due = inject.buildAnniversary('salient-due', lib, now)
  assert.match(due.text, /memory-due/)
  assert.match(due.text, /明天/)
  assert.doesNotMatch(due.text, /memory-anniversary/, 'an appointment is not a commemorative date')
  assert.deepEqual(due.ids, ['mem-due'])

  state.markAnniversaryShown('salient-due', 'mem-due', due.dayKey)
  assert.equal(inject.buildAnniversary('salient-due', lib, now).text, '', 'one firing per day')

  const onTheDay = inject.buildAnniversary('salient-due', lib, local(2026, 10, 29))
  assert.match(onTheDay.text, /就是今天/)
  assert.equal(inject.buildAnniversary('salient-due', lib, local(2026, 10, 30)).text, '', 'spent after it has passed')
  assert.equal(inject.buildAnniversary('salient-due', lib, local(2027, 10, 28)).text, '', 'and not next year')
})

test('an annual entry still surfaces as an anniversary block', () => {
  const lib = state.ensureSession('salient-annual', { cwd: path.join(home, 'annual') })
  const now = local(2026, 10, 29)
  const index = state.loadPrivateIndex(lib.libraryId)
  index.entries['mem-annual'] = {
    track: 'memory', layer: 'long_term', title: '第一次一起看海', content: '那天下着小雨。',
    status: 'active', salientDate: '10-29', createdAt: now.toISOString(), updatedAt: now.toISOString(),
  }
  state.savePrivateIndex(lib.libraryId, index)
  const block = inject.buildAnniversary('salient-annual', lib, now)
  assert.match(block.text, /memory-anniversary/)
  assert.doesNotMatch(block.text, /memory-due/)
});
test('a model that writes the date into the text still gets it stored', async () => {
  const written = await memory.privateRemember({
    exec,
    content: '测试记忆条目 3：2026-10-30（星期五），用户第三次要求再写一次。',
    title: '连续写入验证（2026-10-30 05:10）',
  })
  assert.equal(state.loadPrivateIndex(binding.libraryId).entries[written.id].salientDate, '2026-10-30')
})

test('two different dates in one memory are not guessed', async () => {
  const written = await memory.privateRemember({
    exec,
    content: '2026-10-30 开始改版，2026-11-05 上线。',
    title: '两个日期',
  })
  assert.equal(state.loadPrivateIndex(binding.libraryId).entries[written.id].salientDate, null)
})

test('an explicit salient_date still wins over the text', async () => {
  const written = await memory.privateRemember({
    exec,
    content: '正文提到 2026-10-30，但字段另有指定。',
    title: '字段优先',
    salientDate: '11-11',
  })
  assert.equal(state.loadPrivateIndex(binding.libraryId).entries[written.id].salientDate, '11-11')
})
