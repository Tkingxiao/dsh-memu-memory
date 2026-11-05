import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-salient-wake-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const wake = await import('../lib/salient-wake.js')
const activity = await import('../lib/activity-log.js')
const { fakeScheduleService, fakeSessionScheduleService, wakeContext, scheduleError } = await import('./stubs/dsh-schedule.js')

test.after(() => {
  try { state.flushState() } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

// The pass sweeps *every* binding, so a leftover conversation from an earlier test
// would be armed again under this test's schedule and skew the counts. Each test
// starts with no conversations and the shipped defaults.
test.afterEach(() => {
  for (const binding of state.listSessionBindings()) state.deleteSessionBinding(binding.sessionId)
  state.updateSettings({ salientWake: 'off', salientWakeHour: '09:00', salientWakeTimeZone: '' })
})

const local = (y, m, d, h = 8, min = 0) => new Date(y, m - 1, d, h, min, 0, 0)

function newSession(id) {
  const binding = state.ensureSession(id, { cwd: path.join(home, 'proj-' + id), agentPreset: 'coding' })
  return { sessionId: id, binding }
}

// Entries go straight into the index: this file tests the wake pass, not the write path.
function putEntry(libraryId, id, patch = {}) {
  const index = state.loadPrivateIndex(libraryId)
  index.entries[id] = {
    track: 'memory',
    layer: 'long_term',
    title: id,
    content: `body of ${id} — must not reach the prompt`,
    status: 'active',
    createdAt: local(2026, 10, 1, 12).toISOString(),
    updatedAt: local(2026, 10, 1, 12).toISOString(),
    ...patch,
  }
  state.savePrivateIndex(libraryId, index)
  return index.entries[id]
}

const run = (schedule, now, log = () => {}) => wake.runSalientWakePass(wakeContext(schedule), { now, log })
const titles = (schedule) => schedule.calls.create.map((call) => call.title)

test('the settings gate accepts the documented shapes and nothing else', () => {
  assert.equal(state.DEFAULT_SETTINGS.salientWake, 'off')
  assert.equal(state.DEFAULT_SETTINGS.salientWakeHour, '09:00')
  assert.equal(state.DEFAULT_SETTINGS.salientWakeTimeZone, '')
  assert.equal(state.getSettings().salientWake, 'off', 'a fresh install never wakes a conversation')

  assert.equal(state.updateSettings({ salientWake: 'schedule' }).salientWake, 'schedule')
  assert.throws(() => state.updateSettings({ salientWake: 'on' }), /invalid setting salientWake/)

  assert.equal(state.updateSettings({ salientWakeHour: '07:05' }).salientWakeHour, '07:05')
  assert.equal(state.updateSettings({ salientWakeHour: '00:00' }).salientWakeHour, '00:00')
  assert.equal(state.updateSettings({ salientWakeHour: '23:59' }).salientWakeHour, '23:59')
  assert.throws(() => state.updateSettings({ salientWakeHour: '7:05' }), /HH:mm/)
  assert.throws(() => state.updateSettings({ salientWakeHour: '24:00' }), /HH:mm/)
  assert.throws(() => state.updateSettings({ salientWakeHour: 9 }), /HH:mm/)

  assert.equal(state.updateSettings({ salientWakeTimeZone: 'Asia/Shanghai' }).salientWakeTimeZone, 'Asia/Shanghai')
  assert.equal(state.updateSettings({ salientWakeTimeZone: '' }).salientWakeTimeZone, '', 'empty means "follow the system"')
  assert.equal(state.updateSettings({ salientWakeTimeZone: '   ' }).salientWakeTimeZone, '', 'whitespace is empty, not a zone')
  assert.throws(() => state.updateSettings({ salientWakeTimeZone: 'Mars/Olympus' }), /invalid salientWakeTimeZone/)

  state.updateSettings({ salientWake: 'off', salientWakeHour: '09:00', salientWakeTimeZone: '' })
})

test('off by default: a sweep creates nothing and never asks the host', async () => {
  const { binding } = newSession('wake-off')
  putEntry(binding.libraryId, 'mem-off', { salientDate: '2026-11-02' })
  const schedule = fakeScheduleService()
  const result = await run(schedule, local(2026, 11, 2))
  assert.deepEqual(result, { skipped: 'off' })
  assert.equal(schedule.calls.list.length, 0)
  assert.equal(schedule.calls.create.length, 0)
  assert.equal(schedule.calls.edit.length, 0)
})

test('a host without a schedule service warns once and does not throw', async () => {
  state.updateSettings({ salientWake: 'schedule' })
  const logs = []
  const log = (message) => logs.push(String(message))
  assert.deepEqual(await wake.runSalientWakePass({ get: () => undefined }, { now: local(2026, 11, 2), log }), { skipped: 'service' })
  assert.equal(logs.length, 1)
  assert.match(logs[0], /schedule service/)

  // A second sweep, and a ctx whose probe itself throws, are both still just a skip.
  assert.deepEqual(await wake.runSalientWakePass({ get: () => undefined }, { now: local(2026, 11, 2), log }), { skipped: 'service' })
  assert.deepEqual(await wake.runSalientWakePass({ get: () => { throw new Error('service "schedule" is not injected') } }, { now: local(2026, 11, 2), log }), { skipped: 'service' })
  assert.equal(logs.length, 1, 'reported once per process, not every five minutes')

  const events = activity.listEvents({ limit: 50 })
  assert.ok(events.some((event) => event.detail?.trigger === 'wake' && event.detail?.stage === 'service' && event.level === 'warn'))
  state.updateSettings({ salientWake: 'off' })
})

test('a session-scoped schedule API is skipped with one warning, never called', async () => {
  state.updateSettings({ salientWake: 'schedule' })
  const { binding } = newSession('wake-session-api')
  putEntry(binding.libraryId, 'mem-session-api', { salientDate: '2026-11-02' })
  const schedule = fakeSessionScheduleService()
  const logs = []
  const log = (message) => logs.push(String(message))
  assert.deepEqual(await run(schedule, local(2026, 11, 2), log), { skipped: 'schedule-api' })
  assert.equal(schedule.calls.list.length, 0, 'the old list needs a sessionId; calling it with { limit } would be a wrong-shaped request')
  assert.equal(schedule.calls.create.length, 0)
  assert.equal(schedule.calls.delete.length, 0)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /host-wide schedule API/)

  const events = activity.listEvents({ limit: 50 })
  assert.ok(events.some((event) => event.detail?.trigger === 'wake' && event.detail?.stage === 'schedule-api' && event.level === 'warn'))
  state.updateSettings({ salientWake: 'off' })
})

test('scheduleFlavor distinguishes the host-wide and session-scoped APIs structurally', () => {
  assert.equal(wake.scheduleFlavor(null), null)
  assert.equal(wake.scheduleFlavor({}), null)
  assert.equal(wake.scheduleFlavor({ create() {}, list() {} }), null)
  assert.equal(wake.scheduleFlavor(fakeScheduleService()), 'global')
  assert.equal(wake.scheduleFlavor(fakeSessionScheduleService()), 'session')
})

test('today and tomorrow each get one task whose prompt is self-contained', async () => {
  state.updateSettings({ salientWake: 'schedule', salientWakeHour: '09:00', salientWakeTimeZone: '' })
  const { sessionId, binding } = newSession('wake-main')
  putEntry(binding.libraryId, 'mem-today', { title: '回电话', salientDate: '2026-11-02', openLoop: true })
  putEntry(binding.libraryId, 'mem-tomorrow', { title: '考驾照', salientDate: '2026-11-03' })
  putEntry(binding.libraryId, 'mem-annual', { title: '一起看海', salientDate: '11-02' })
  const schedule = fakeScheduleService()
  const result = await run(schedule, local(2026, 11, 2, 8))

  assert.deepEqual(result, { created: 2, cleaned: 0, skipped: 0, errors: 0 })
  assert.deepEqual(titles(schedule).sort(), [
    `memu:due:${sessionId}:2026-11-02`,
    `memu:due:${sessionId}:2026-11-03`,
  ])

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const today = schedule.calls.create.find((call) => call.title.endsWith(':2026-11-02'))
  assert.deepEqual(today.timing, { kind: 'at', at: { date: '2026-11-02', time: '09:00', time_zone: zone } })
  assert.deepEqual(today.target, { kind: 'session', sessionId })

  assert.match(today.prompt, /^\[dsh-memu-memory 日期提醒\]/)
  assert.ok(today.prompt.includes('2026-11-02'), 'the delivery day is stated')
  assert.ok(today.prompt.includes('回电话'))
  assert.match(today.prompt, /今天：你之前答应过的「回电话」，就是今天（2026-11-02）/, 'a promise keeps the promise wording')
  assert.match(today.prompt, /明天：考驾照（2026-11-03）/, 'the lead day is shown on the previous day')
  assert.match(today.prompt, /今天：一起看海（每年 11-02）/, 'an annual date says it recurs')
  assert.ok(today.prompt.includes('memu_private_recall'), 'a schedule turn gets no injection, so the prompt points at recall')
  assert.ok(today.prompt.includes('不要重复'))
  assert.ok(!today.prompt.includes('must not reach the prompt'), 'the memory body never lands in the prompt')

  const tomorrow = schedule.calls.create.find((call) => call.title.endsWith(':2026-11-03'))
  assert.deepEqual(tomorrow.timing.at, { date: '2026-11-03', time: '09:00', time_zone: zone })
  assert.match(tomorrow.prompt, /今天：考驾照（2026-11-03）/, "tomorrow's own task reads from tomorrow's calendar")
  assert.ok(!tomorrow.prompt.includes('回电话'), 'a date that already passed relative to that day is not repeated')
})

test('a second sweep of the same day is idempotent', async () => {
  state.updateSettings({ salientWake: 'schedule' })
  const { sessionId, binding } = newSession('wake-again')
  putEntry(binding.libraryId, 'mem-again', { salientDate: '2026-11-02' })
  const schedule = fakeScheduleService()
  assert.equal((await run(schedule, local(2026, 11, 2, 8))).created, 1)
  const created = schedule.calls.create.length
  const second = await run(schedule, local(2026, 11, 2, 8))
  assert.equal(second.created, 0)
  assert.equal(second.skipped, 1, 'the armed task is the proof, not a reason to arm another')
  assert.equal(schedule.calls.create.length, created)
  assert.equal(schedule.calls.edit.length, 0)
  assert.equal(schedule.tasks.filter((task) => task.title === `memu:due:${sessionId}:2026-11-02`).length, 1)
})

test('an ended task is cleaned up and not re-armed for a slot that has passed', async () => {
  state.updateSettings({ salientWake: 'schedule', salientWakeHour: '09:00' })
  const { sessionId, binding } = newSession('wake-ended')
  putEntry(binding.libraryId, 'mem-ended', { salientDate: '2026-11-02' })
  const schedule = fakeScheduleService()
  const now = local(2026, 11, 2, 10)
  const title = `memu:due:${sessionId}:2026-11-02`
  const ended = schedule.seed({ title, status: 'ended' })

  const result = await run(schedule, now)
  assert.equal(result.cleaned, 1)
  assert.equal(result.created, 0, 'ended means this date already delivered; do not arm it twice')
  assert.equal(schedule.taskByTitle(title), null)
  assert.deepEqual(schedule.calls.edit, [{ id: ended.id, action: 'delete' }])

  const again = await run(schedule, now)
  assert.equal(again.created, 0)
  assert.equal(again.skipped, 1, 'the 09:00 slot is in the past, so cleanup is final')
})

test('a paused task is neither rebuilt nor resumed', async () => {
  state.updateSettings({ salientWake: 'schedule', salientWakeHour: '09:00' })
  const { sessionId, binding } = newSession('wake-paused')
  putEntry(binding.libraryId, 'mem-paused', { salientDate: '2026-11-02' })
  const schedule = fakeScheduleService()
  const title = `memu:due:${sessionId}:2026-11-02`
  const paused = schedule.seed({ title, status: 'paused' })

  const result = await run(schedule, local(2026, 11, 2, 8))
  assert.equal(result.created, 0)
  assert.equal(result.skipped, 1)
  assert.equal(result.cleaned, 0)
  assert.equal(schedule.calls.create.length, 0)
  assert.equal(schedule.calls.edit.length, 0, 'the sweep does not touch a paused task at all')
  assert.equal(schedule.taskByTitle(title).status, 'paused', 'a user pause is not the sweep’s to undo')
  assert.equal(paused.status, 'paused')
})

test('archived, secret, pending, superseded, expired, undated and hidden memories arm nothing', async () => {
  state.updateSettings({ salientWake: 'schedule' })
  const { binding } = newSession('wake-filters')
  putEntry(binding.libraryId, 'mem-archived', { salientDate: '2026-11-02', status: 'archived' })
  putEntry(binding.libraryId, 'mem-secret', { salientDate: '2026-11-02', visibility: 'secret' })
  putEntry(binding.libraryId, 'mem-pending', { salientDate: '2026-11-02', status: 'pending_review' })
  putEntry(binding.libraryId, 'mem-superseded', { salientDate: '2026-11-02', status: 'superseded' })
  putEntry(binding.libraryId, 'mem-expired', { salientDate: '2026-11-02', status: 'expired' })
  putEntry(binding.libraryId, 'mem-plain', { title: '普通记忆' })
  putEntry(binding.libraryId, 'mem-far', { salientDate: '2026-12-24' })
  putEntry(binding.libraryId, 'mem-hidden', { salientDate: '2026-11-02', context: { characterId: 'someone-else' } })

  const schedule = fakeScheduleService()
  const result = await run(schedule, local(2026, 11, 2, 8))
  assert.equal(result.created, 0)
  assert.equal(schedule.calls.create.length, 0)
  assert.equal(schedule.calls.list.length, 0, 'nothing qualified, so the host is not asked for its task table')

  // A conversation with its private library switched off is not a delivery target either.
  const other = newSession('wake-switched-off')
  putEntry(other.binding.libraryId, 'mem-off-switch', { salientDate: '2026-11-02' })
  state.setSessionBinding('wake-switched-off', { useLibrary: false })
  const after = await run(schedule, local(2026, 11, 2, 8))
  assert.equal(after.created, 0)
  assert.deepEqual(titles(schedule), [])
})

test('an annual MM-DD date fires on its own day, not before', async () => {
  state.updateSettings({ salientWake: 'schedule' })
  const { sessionId, binding } = newSession('wake-annual')
  putEntry(binding.libraryId, 'mem-birthday', { title: '生日', salientDate: '11-03' })
  const schedule = fakeScheduleService()
  const result = await run(schedule, local(2026, 11, 2, 8))
  assert.equal(result.created, 1, 'only tomorrow’s task qualifies: an annual date has no lead day')
  assert.deepEqual(titles(schedule), [`memu:due:${sessionId}:2026-11-03`])
  assert.match(schedule.calls.create[0].prompt, /今天：生日（每年 11-03）/)
})

test('a slot that already passed today skips today but still arms tomorrow', async () => {
  state.updateSettings({ salientWake: 'schedule', salientWakeHour: '09:00' })
  const { sessionId, binding } = newSession('wake-late')
  putEntry(binding.libraryId, 'mem-late-today', { salientDate: '2026-11-02' })
  putEntry(binding.libraryId, 'mem-late-tomorrow', { salientDate: '2026-11-03' })
  const schedule = fakeScheduleService()
  const result = await run(schedule, local(2026, 11, 2, 10))
  assert.equal(result.created, 1)
  assert.equal(result.skipped, 1)
  assert.deepEqual(titles(schedule), [`memu:due:${sessionId}:2026-11-03`], 'today is past 09:00; the passive injection still covers it')
})

test('an unusable time zone warns once, skips, and does not throw', async () => {
  state.updateSettings({ salientWake: 'schedule', salientWakeTimeZone: '' })
  const { binding } = newSession('wake-zone')
  putEntry(binding.libraryId, 'mem-zone', { salientDate: '2026-11-02' })

  // Straight into state.json: updateSettings refuses this value, but a hand-edited
  // file (or a future host with no resolved zone) must not crash the sweep.
  state.flushState()
  const file = path.join(home, 'state.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  raw.settings.salientWakeTimeZone = 'Mars/Olympus'
  fs.writeFileSync(file, JSON.stringify(raw), 'utf8')
  state.clearCaches()

  const schedule = fakeScheduleService()
  const logs = []
  const log = (message) => logs.push(String(message))
  assert.deepEqual(await run(schedule, local(2026, 11, 2, 8), log), { skipped: 'timezone' })
  assert.equal(schedule.calls.list.length, 0, 'nothing is asked of the host without a usable zone')
  assert.equal(schedule.calls.create.length, 0)
  assert.ok(logs.some((line) => /time zone/.test(line)))
  assert.equal(logs.filter((line) => /time zone/.test(line)).length, 1)

  await run(schedule, local(2026, 11, 2, 8), log)
  assert.equal(logs.filter((line) => /time zone/.test(line)).length, 1, 'the same bad value is reported once')

  state.updateSettings({ salientWakeTimeZone: '' })
  assert.equal(state.getSettings().salientWakeTimeZone, '')
})

test('refused targets are skipped, real failures are recorded, other sessions continue', async () => {
  state.updateSettings({ salientWake: 'schedule', salientWakeTimeZone: '' })
  const now = local(2026, 11, 2, 8)
  const subagent = newSession('wake-subagent')
  putEntry(subagent.binding.libraryId, 'mem-sub', { salientDate: '2026-11-02' })
  const archived = newSession('wake-archived')
  putEntry(archived.binding.libraryId, 'mem-arch', { salientDate: '2026-11-02' })
  const broken = newSession('wake-broken')
  putEntry(broken.binding.libraryId, 'mem-broken', { salientDate: '2026-11-02' })
  const healthy = newSession('wake-healthy')
  putEntry(healthy.binding.libraryId, 'mem-healthy', { salientDate: '2026-11-02' })

  const schedule = fakeScheduleService({
    createError: (request) => {
      if (request.title.includes('wake-subagent')) return scheduleError('subagent_session', 'This Session belongs to subagent routing, which never receives reminder delivery.')
      if (request.title.includes('wake-archived')) return scheduleError('invalid_rule', 'target Session "wake-archived" is archived.')
      if (request.title.includes('wake-broken')) throw new Error('schedule domain is closed')
      return null
    },
  })
  const result = await run(schedule, now)
  assert.equal(result.created, 1)
  assert.equal(result.skipped, 2)
  assert.equal(result.errors, 1)
  assert.equal(schedule.calls.create.length, 4, 'every conversation got its own attempt')
  assert.ok(schedule.taskByTitle('memu:due:wake-healthy:2026-11-02'), 'the healthy session still got its task')
  assert.equal(schedule.taskByTitle('memu:due:wake-subagent:2026-11-02'), null)

  const events = activity.listEvents({ limit: 100 })
  assert.ok(events.some((event) => event.sessionId === 'wake-broken' && event.ok === false && event.detail?.stage === 'create'))
  assert.ok(events.some((event) => event.detail?.code === 'subagent_session' && event.detail?.trigger === 'wake'))
  assert.ok(events.some((event) => event.detail?.code === 'invalid_rule' && event.detail?.trigger === 'wake'))
})

test('a failing list is recorded and reported, not thrown', async () => {
  state.updateSettings({ salientWake: 'schedule' })
  const { binding } = newSession('wake-list-fails')
  putEntry(binding.libraryId, 'mem-list-fails', { salientDate: '2026-11-02' })
  const schedule = fakeScheduleService({ listError: new Error('storage domain is closed') })
  const logs = []
  const result = await run(schedule, local(2026, 11, 2, 8), (message) => logs.push(String(message)))
  assert.deepEqual(result, { created: 0, cleaned: 0, skipped: 0, errors: 1 })
  assert.ok(logs.some((line) => /schedule\.list failed/.test(line)))
  const events = activity.listEvents({ limit: 50 })
  assert.ok(events.some((event) => event.detail?.stage === 'list' && event.ok === false))
})

// 投递按 `at.time_zone` 解释日期与时分，所以「今天是哪天」和「这一刻过去了吗」都必须按那个
// 时区算。曾按系统墙钟算：配置 UTC 而机器在上海时，今天被算成次日，或把还没到的 09:00(UTC)
// 当成已过而静默不排。以下三条与时区无关（断言的是绝对瞬间与配置时区的日历日）。
test('the scheduled instant is the wall clock in the delivery zone, not the machine zone', () => {
  assert.equal(wake.instantInZone('2026-11-01', '09:00', 'UTC'), Date.UTC(2026, 10, 1, 9, 0, 0, 0))
  assert.equal(wake.instantInZone('2026-11-01', '09:00', 'Asia/Shanghai'), Date.UTC(2026, 10, 1, 1, 0, 0, 0))
  // 夏令时：柏林 7 月是 UTC+2、1 月是 UTC+1，同一个 HH:mm 落在不同的绝对瞬间。
  assert.equal(wake.instantInZone('2026-07-15', '09:00', 'Europe/Berlin'), Date.UTC(2026, 6, 15, 7, 0, 0, 0))
  assert.equal(wake.instantInZone('2026-01-15', '09:00', 'Europe/Berlin'), Date.UTC(2026, 0, 15, 8, 0, 0, 0))
})

test('the swept calendar day belongs to the delivery zone', () => {
  const at = Date.UTC(2026, 9, 31, 20, 0, 0, 0)
  assert.equal(wake.dayInZone(at, 'UTC', 0).date, '2026-10-31')
  assert.equal(wake.dayInZone(at, 'UTC', 1).date, '2026-11-01')
  assert.equal(wake.dayInZone(at, 'Asia/Shanghai', 0).date, '2026-11-01', 'the same instant is already the next day there')
})

test('a delivery zone other than the machine still arms today there', async () => {
  state.updateSettings({ salientWake: 'schedule', salientWakeHour: '21:00', salientWakeTimeZone: 'UTC' })
  const { sessionId, binding } = newSession('wake-zone-utc-today')
  putEntry(binding.libraryId, 'mem-utc-today', { title: '交周报', salientDate: '2026-10-31' })
  const schedule = fakeScheduleService()
  const result = await run(schedule, new Date(Date.UTC(2026, 9, 31, 20, 0, 0, 0)))
  assert.equal(result.created, 1, '21:00 UTC is still ahead, so the day must be armed')
  assert.ok(schedule.taskByTitle(`memu:due:${sessionId}:2026-10-31`), 'the task date is today in the configured zone')
  const created = schedule.calls.create.find((call) => call.title.endsWith(':2026-10-31'))
  assert.deepEqual(created.timing, { kind: 'at', at: { date: '2026-10-31', time: '21:00', time_zone: 'UTC' } })
})

test('a slot already past in the delivery zone is skipped, not sent for rejection', async () => {
  state.updateSettings({ salientWake: 'schedule', salientWakeHour: '19:00', salientWakeTimeZone: 'UTC' })
  const { binding } = newSession('wake-zone-utc-past')
  putEntry(binding.libraryId, 'mem-utc-past', { title: '交周报', salientDate: '2026-10-31' })
  const schedule = fakeScheduleService()
  const result = await run(schedule, new Date(Date.UTC(2026, 9, 31, 20, 0, 0, 0)))
  assert.equal(result.created, 0, '19:00 UTC on 10-31 already passed; passive injection still covers it')
  assert.equal(result.skipped, 1)
})
