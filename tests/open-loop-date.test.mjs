import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-loop-date-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const inject = await import('../lib/inject.js')
const { estTokens } = await import('../lib/budget.js')

test.after(() => {
  try { state.flushState() } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

const DAY = 86_400_000
const local = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0)
const pad = (n) => String(n).padStart(2, '0')

function newSession(id) {
  const cwd = path.join(home, 'proj-' + id)
  const binding = state.ensureSession(id, { cwd, agentPreset: 'coding' })
  return { sessionId: id, binding, cwd }
}

// Entries are written straight into the index: the point of these cases is the
// injection side (date + open_loop + reminder clock), not the write path.
function putEntry(libraryId, id, patch = {}) {
  const index = state.loadPrivateIndex(libraryId)
  index.entries[id] = {
    track: 'memory',
    layer: 'long_term',
    title: id,
    content: `content of ${id}`,
    status: 'active',
    createdAt: local(2026, 10, 1).toISOString(),
    updatedAt: local(2026, 10, 1).toISOString(),
    ...patch,
  }
  state.savePrivateIndex(libraryId, index)
  return index.entries[id]
}

function nudge(sessionId, now, extra = {}) {
  return inject.buildOpenLoopNudge(state.getSessionBinding(sessionId), state.getSettings(), sessionId, { now, ...extra })
}

function setRemindDays(value) {
  return state.updateSettings({ openLoopRemindDays: value })
}

test('the setting defaults to 7 days and clamps to [1,365]', () => {
  assert.equal(state.DEFAULT_SETTINGS.openLoopRemindDays, 7)
  assert.equal(state.getSettings().openLoopRemindDays, 7)
  try {
    assert.equal(setRemindDays(0).openLoopRemindDays, 1, 'zero is clamped to one day, not disabled')
    assert.equal(setRemindDays(999).openLoopRemindDays, 365)
    assert.throws(() => state.updateSettings({ openLoopRemindDays: 'weekly' }), /finite number/)
  } finally {
    setRemindDays(7)
  }
})

// ── R3: the overdue leg ───────────────────────────────────────────────────────

test('a promise due yesterday is raised without waiting three days', () => {
  const { sessionId, binding } = newSession('loop-yesterday')
  const now = local(2026, 11, 2)
  putEntry(binding.libraryId, 'mem-promise', {
    title: '回电话', content: '答应了昨天回电话。', openLoop: true,
    salientDate: '2026-11-01', updatedAt: now.toISOString(), createdAt: now.toISOString(),
  })
  const first = nudge(sessionId, now)
  assert.match(first.text, /\[open loop\]/)
  assert.ok(first.text.includes('mem-promise'))
  assert.match(first.text, /date=2026-11-01/, 'the overdue line says how late it is')
  assert.deepEqual(first.recurringIds, ['mem-promise'], 'this came from the dated leg, not the 3-day rule')
  assert.equal(first.dayKey, '2026-11-02')
})

test('it repeats on its interval: once a day, then only after openLoopRemindDays', () => {
  const { sessionId, binding } = newSession('loop-interval')
  const now = local(2026, 11, 2)
  putEntry(binding.libraryId, 'mem-interval', {
    openLoop: true, salientDate: '2026-11-01', updatedAt: now.toISOString(), createdAt: now.toISOString(),
  })
  assert.deepEqual(nudge(sessionId, now).recurringIds, ['mem-interval'])

  // Exactly what the injector does once the nudge is published: the id goes into the
  // session dedupe list and the reminder clock starts. Only the second one may decide
  // when this repeats.
  state.markInjected(sessionId, ['mem-interval'], 1)
  state.markOpenLoopReminded(sessionId, 'mem-interval', now)
  assert.equal(state.wasOpenLoopRemindedToday(sessionId, 'mem-interval', now), true)
  assert.equal(state.wasOpenLoopRemindedToday(sessionId, 'mem-interval', local(2026, 11, 3)), false)

  assert.equal(nudge(sessionId, now).text, '', 'the same day never repeats it')
  assert.equal(nudge(sessionId, new Date(now.getTime() + 6 * DAY + 3_600_000)).text, '',
    'one hour short of seven days is still inside the window')
  const again = nudge(sessionId, new Date(now.getTime() + 7 * DAY))
  assert.ok(again.text.includes('mem-interval'), 'the seventh day raises it again')
  assert.deepEqual(again.recurringIds, ['mem-interval'])
})

test('openLoopRemindDays 1 and 365 are the real boundaries', () => {
  const { sessionId, binding } = newSession('loop-bound')
  const now = local(2026, 11, 2)
  putEntry(binding.libraryId, 'mem-bound', {
    openLoop: true, salientDate: '2026-10-01', updatedAt: now.toISOString(), createdAt: now.toISOString(),
  })
  // Keep the regular 3-day leg out of the way: this case is only about the clock.
  state.markInjected(sessionId, ['mem-bound'], 1)
  state.markOpenLoopReminded(sessionId, 'mem-bound', now)
  const at = (days, hours = 0) => new Date(now.getTime() + days * DAY + hours * 3_600_000)
  try {
    setRemindDays(1)
    assert.equal(nudge(sessionId, at(0, 23)).text, '', '23 hours is younger than one day')
    assert.ok(nudge(sessionId, at(1)).text.includes('mem-bound'), 'exactly one day is due again')

    state.markOpenLoopReminded(sessionId, 'mem-bound', now)
    setRemindDays(365)
    assert.equal(nudge(sessionId, at(364)).text, '')
    assert.ok(nudge(sessionId, at(365)).text.includes('mem-bound'))
  } finally {
    setRemindDays(7)
  }
})

test('once injected, the dated leg still comes back; the undated leg does not', () => {
  const { sessionId, binding } = newSession('loop-vs-regular')
  const now = local(2026, 11, 2)
  putEntry(binding.libraryId, 'mem-dated', {
    openLoop: true, salientDate: '2026-10-30', updatedAt: new Date(now.getTime() - 4 * DAY).toISOString(),
  })
  putEntry(binding.libraryId, 'mem-plain', {
    openLoop: true, updatedAt: new Date(now.getTime() - 4 * DAY).toISOString(),
  })
  // The session already pushed both ids in earlier turns.
  state.markInjected(sessionId, ['mem-dated'], 1)
  state.markInjected(sessionId, ['mem-plain'], 1)
  const only = nudge(sessionId, now)
  assert.ok(only.text.includes('mem-dated'), 'injectedIds is not a permanent silence for a slipped promise')
  assert.equal(only.text.includes('mem-plain'), false, 'the ordinary loop stays silent once said')
  assert.deepEqual(only.recurringIds, ['mem-dated'])
})

test('undated open loops keep the 3-day gate and the permanent silence', () => {
  const { sessionId, binding } = newSession('loop-undated')
  const now = local(2026, 11, 2)
  putEntry(binding.libraryId, 'mem-undated', {
    openLoop: true, updatedAt: new Date(now.getTime() - 2 * DAY).toISOString(),
  })
  assert.equal(nudge(sessionId, now).text, '', 'two days is context, not a nudge')

  putEntry(binding.libraryId, 'mem-undated', {
    openLoop: true, updatedAt: new Date(now.getTime() - 4 * DAY).toISOString(),
  })
  const raised = nudge(sessionId, now)
  assert.ok(raised.text.includes('mem-undated'))
  assert.deepEqual(raised.recurringIds, [], 'an undated loop is not on the reminder clock')

  state.markInjected(sessionId, ['mem-undated'], 3)
  assert.equal(nudge(sessionId, now).text, '', 'once said, it stays quiet')
})

test('archived, secret, invisible and annual entries never join the overdue leg', () => {
  const { sessionId, binding } = newSession('loop-excluded')
  const now = local(2026, 11, 2)
  const recent = now.toISOString()
  putEntry(binding.libraryId, 'mem-archived', { openLoop: true, salientDate: '2026-10-20', status: 'archived', updatedAt: recent })
  putEntry(binding.libraryId, 'mem-secret', { openLoop: true, salientDate: '2026-10-21', visibility: 'secret', updatedAt: recent })
  putEntry(binding.libraryId, 'mem-hidden', {
    openLoop: true, salientDate: '2026-10-19', context: { characterId: 'someone-else' }, updatedAt: recent,
  })
  putEntry(binding.libraryId, 'mem-annual', { openLoop: true, salientDate: '10-20', updatedAt: recent })
  assert.equal(nudge(sessionId, now).text, '')

  // The hidden one sorts first (oldest date) but must not eat the single slot.
  putEntry(binding.libraryId, 'mem-visible', { openLoop: true, salientDate: '2026-10-25', updatedAt: recent })
  const visible = nudge(sessionId, now)
  assert.ok(visible.text.includes('mem-visible'))
  assert.equal(visible.text.includes('mem-hidden'), false)
})

test('a slipped date outranks an ordinary old loop, and still limit 1', () => {
  const { sessionId, binding } = newSession('loop-priority')
  const now = local(2026, 11, 2)
  putEntry(binding.libraryId, 'mem-old-loop', {
    openLoop: true, updatedAt: new Date(now.getTime() - 30 * DAY).toISOString(),
  })
  putEntry(binding.libraryId, 'mem-late-date', {
    openLoop: true, salientDate: '2026-10-30', updatedAt: new Date(now.getTime() - 1 * DAY).toISOString(),
  })
  const raised = nudge(sessionId, now)
  assert.ok(raised.text.includes('mem-late-date'), raised.text)
  assert.equal(raised.text.includes('mem-old-loop'), false, 'limit 1: the dated promise wins the slot')
  assert.deepEqual(raised.ids, ['mem-late-date'])

  const direct = memory.dueOpenLoops({
    libraryId: binding.libraryId, days: 3, limit: 1, now: now.getTime(),
    includeOverdueDated: true, remindDays: 7,
  })
  assert.deepEqual(direct.map((item) => [item.id, item.recurring]), [['mem-late-date', true]])

  // The overdue leg is opt-in at the dueOpenLoops level: the old call shape keeps the
  // old answer (only the 3-day regular loop).
  assert.deepEqual(memory.dueOpenLoops({ libraryId: binding.libraryId, days: 3, limit: 1, now: now.getTime() })
    .map((item) => item.id), ['mem-old-loop'])

  // The regular leg is still reachable once the dated one is out of the way.
  putEntry(binding.libraryId, 'mem-late-date', { openLoop: false, salientDate: '2026-10-30', updatedAt: new Date(now.getTime() - 1 * DAY).toISOString() })
  const regular = nudge(sessionId, now)
  assert.ok(regular.text.includes('mem-old-loop'))
  assert.deepEqual(regular.recurringIds, [])
})

test('the overdue leg honours same-turn skipIds but not the injectedIds list', () => {
  const { sessionId, binding } = newSession('loop-skip')
  const now = local(2026, 11, 2)
  putEntry(binding.libraryId, 'mem-both', {
    openLoop: true, salientDate: '2026-11-01', updatedAt: now.toISOString(),
  })
  assert.equal(nudge(sessionId, now, { skipIds: ['mem-both'] }).text, '')
})

// ── legacy bindings and the reminder map ──────────────────────────────────────

test('a binding without openLoopRemindedAt reminds normally and the map is pruned', () => {
  const { sessionId, binding } = newSession('loop-legacy')
  const now = local(2026, 11, 2)
  putEntry(binding.libraryId, 'mem-legacy', {
    openLoop: true, salientDate: '2026-11-01', updatedAt: now.toISOString(),
  })
  assert.equal(state.getSessionBinding(sessionId).openLoopRemindedAt, undefined, 'old bindings have no map')
  assert.equal(state.wasOpenLoopRemindedToday(sessionId, 'mem-legacy', now), false)
  assert.ok(nudge(sessionId, now).text.includes('mem-legacy'))

  state.markOpenLoopReminded(sessionId, 'mem-legacy', now)
  state.markOpenLoopReminded(sessionId, 'mem-stale', new Date(now.getTime() - 120 * DAY))
  state.markOpenLoopReminded(sessionId, 'mem-kept', new Date(now.getTime() - 10 * DAY))
  const map = state.getSessionBinding(sessionId).openLoopRemindedAt
  assert.ok(map['mem-legacy'])
  assert.ok(map['mem-kept'])
  assert.equal(map['mem-stale'], undefined, 'keys older than 90 days are dropped on write')
  assert.equal(state.wasOpenLoopRemindedToday(sessionId, 'mem-legacy', now), true)
})

test('a missing session or memory id is not an error', () => {
  assert.equal(state.wasOpenLoopRemindedToday(null, 'mem-x'), false)
  assert.equal(state.wasOpenLoopRemindedToday('nobody-here', 'mem-x'), false)
  assert.equal(state.markOpenLoopReminded(null, 'mem-x'), null)
  assert.equal(state.markOpenLoopReminded('nobody-here', null), null)
})

// ── R2: promise wording in the due block ─────────────────────────────────────

test('an open_loop dated today or tomorrow reads as a promise, with no body', () => {
  const { sessionId, binding } = newSession('loop-wording')
  const today = local(2026, 11, 2)
  putEntry(binding.libraryId, 'mem-today', {
    title: '交周报', content: 'BODY-TODAY 答应了周一交周报。', openLoop: true, salientDate: '2026-11-02',
  })
  putEntry(binding.libraryId, 'mem-tomorrow', {
    title: '回电话', content: 'BODY-TOMORROW 答应明天回电话。', openLoop: true, salientDate: '2026-11-03',
  })
  const due = inject.buildAnniversary(sessionId, binding, today)
  assert.ok(due.text.includes('你之前答应过的「交周报」，就是今天。'), due.text)
  assert.ok(due.text.includes('你之前答应过的「回电话」，就是明天。'), due.text)
  assert.equal(due.text.includes('BODY-TODAY'), false, 'a promise line carries the title, not the body')
  assert.equal(due.text.includes('BODY-TOMORROW'), false)
  assert.deepEqual(due.ids.sort(), ['mem-today', 'mem-tomorrow'])

  // A dated entry that is not a promise keeps the old appointment shape.
  putEntry(binding.libraryId, 'mem-exam', {
    title: '考驾照', content: '明天要去考驾照。', salientDate: '2026-11-03',
  })
  const mixed = inject.buildAnniversary('loop-wording-2', binding, today)
  assert.ok(mixed.text.includes('明天要去考驾照。'), 'a plain appointment still shows its body')
  assert.ok(mixed.text.includes('就是明天（2026-11-03）'))
})

// ── R1: one memory, one block per turn ────────────────────────────────────────

test('the anniversary ids suppress the nudge for the same memory', () => {
  const { sessionId, binding } = newSession('loop-dedup')
  const now = local(2026, 11, 2)
  putEntry(binding.libraryId, 'mem-both', {
    title: '交周报', content: '答应了周一交周报。', openLoop: true, salientDate: '2026-11-02',
    updatedAt: new Date(now.getTime() - 5 * DAY).toISOString(),
  })
  const anniversary = inject.buildAnniversary(sessionId, binding, now)
  assert.match(anniversary.text, /你之前答应过的「交周报」，就是今天。/)
  assert.deepEqual(anniversary.ids, ['mem-both'])

  const plain = nudge(sessionId, now)
  assert.ok(plain.text.includes('mem-both'), 'without dedup the nudge would repeat it')
  assert.equal(nudge(sessionId, now, { skipIds: anniversary.ids }).text, '')
})

test('a budget-dropped anniversary does not silence the nudge (injectForStep)', async () => {
  const sessionId = 'loop-budget'
  const cwd = path.join(home, 'proj-loop-budget')
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const today = new Date()
  const dated = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  const annual = `${pad(today.getMonth() + 1)}-${pad(today.getDate())}`

  putEntry(binding.libraryId, 'mem-said', {
    title: '回电话', content: '答应过回电话。', openLoop: true, salientDate: dated,
    updatedAt: new Date(today.getTime() - 5 * DAY).toISOString(),
  })
  // Makes the anniversary block big enough that a small budget drops it whole.
  putEntry(binding.libraryId, 'mem-long', {
    title: '长备注', content: '长'.repeat(200), salientDate: annual, updatedAt: today.toISOString(),
  })

  const step = (text) => ({
    agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding', origin: 'user' } } },
    decision: {
      kind: 'enter',
      messages: [{ id: `u-${Math.random().toString(36).slice(2)}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
    },
  })
  const pluginText = (out) => out.messages
    .filter((message) => message?.source?.kind === 'plugin:dsh-memu-memory')
    .map((message) => (message.content || []).map((part) => part.text || '').join('\n'))
    .join('\n\n')

  const anniversaryTokens = estTokens(inject.buildAnniversary(sessionId, state.getSessionBinding(sessionId), new Date()).text)
  const nudgeTokens = estTokens(inject.buildOpenLoopNudge(state.getSessionBinding(sessionId), state.getSettings(), sessionId, { now: new Date() }).text)
  assert.ok(anniversaryTokens > 160, `the anniversary block must not fit a 160-token budget (got ${anniversaryTokens})`)
  assert.ok(nudgeTokens <= 160, `the nudge must fit that budget (got ${nudgeTokens})`)

  // The anchor is a separate block with its own room; mark it as already delivered so
  // the whole 160-token budget is left to the anniversary/nudge decision under test.
  state.setSessionBinding(sessionId, {
    injectedIds: ['__anchor__'], injectedAt: {}, anniversariesShown: {}, openLoopRemindedAt: {},
  })
  state.updateSettings({ injectionTotalTokens: 160, randomCueChance: 0 })
  try {
    const out = await inject.injectForStep({ ...step('今天有什么要注意的吗'), turn: 1, step: 1, signal: { aborted: false } })
    const text = pluginText(out)
    assert.equal(text.includes('<memory-due>'), false, 'the anniversary block was dropped by the budget')
    assert.match(text, /\[open loop\]/, 'the nudge still gets its turn')
    assert.ok(text.includes('mem-said'))
    assert.equal(state.getSessionBinding(sessionId).openLoopRemindedAt?.['mem-said'], undefined,
      'the regular leg does not write the recurring clock')
  } finally {
    state.updateSettings({ injectionTotalTokens: 2000 })
  }

  // Same turn shape with a normal budget: the anniversary fits, so the nudge stays out.
  state.setSessionBinding(sessionId, {
    injectedIds: ['__anchor__'], injectedAt: {}, anniversariesShown: {}, openLoopRemindedAt: {},
  })
  try {
    const out = await inject.injectForStep({ ...step('今天有什么要注意的吗'), turn: 1, step: 1, signal: { aborted: false } })
    const text = pluginText(out)
    assert.match(text, /<memory-due>/, text)
    assert.ok(text.includes('你之前答应过的「回电话」，就是今天。'))
    assert.equal(text.includes('[open loop]'), false, 'one memory, one block per turn')
  } finally {
    state.updateSettings({ randomCueChance: 0.02 })
  }
})

test('injectForStep records the overdue reminder only after the block is really sent', async () => {
  const sessionId = 'loop-commit'
  const cwd = path.join(home, 'proj-loop-commit')
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const today = new Date()
  const yesterday = new Date(today.getTime() - DAY)
  const dated = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`
  putEntry(binding.libraryId, 'mem-recurring', {
    title: '交周报', content: '昨天该交的周报还没交。', openLoop: true, salientDate: dated,
    updatedAt: today.toISOString(),
  })
  state.updateSettings({ randomCueChance: 0 })
  const step = {
    agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding', origin: 'user' } } },
    decision: {
      kind: 'enter',
      messages: [{ id: 'u-commit', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '今天有什么要注意的吗' }] }],
    },
  }
  const out = await inject.injectForStep({ ...step, turn: 1, step: 1, signal: { aborted: false } })
  const text = (out.messages || [])
    .filter((message) => message?.source?.kind === 'plugin:dsh-memu-memory')
    .map((message) => (message.content || []).map((part) => part.text || '').join('\n'))
    .join('\n\n')
  assert.match(text, /\[open loop\]/)
  assert.ok(text.includes('mem-recurring'))
  assert.equal(state.wasOpenLoopRemindedToday(sessionId, 'mem-recurring', new Date()), true,
    'the clock starts once the reminder reached the prompt')

  const again = await inject.injectForStep({ ...step, turn: 2, step: 1, signal: { aborted: false } })
  const againText = (again.messages || [])
    .filter((message) => message?.source?.kind === 'plugin:dsh-memu-memory')
    .map((message) => (message.content || []).map((part) => part.text || '').join('\n'))
    .join('\n\n')
  assert.equal(againText.includes('[open loop]'), false, 'not twice on the same day')
})
