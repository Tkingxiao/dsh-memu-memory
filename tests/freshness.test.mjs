import test from 'node:test'
import assert from 'node:assert/strict'

import { freshnessSignals } from '../lib/freshness.js'

const DAY_MS = 86_400_000
// Local noon on 2026-11-15, so "today" is unambiguous in every timezone.
const NOW = new Date(2026, 10, 15, 12, 0, 0)
const daysAgo = (days) => new Date(NOW.getTime() - days * DAY_MS).toISOString()

function entry(patch = {}) {
  return { title: '普通记忆', content: '窗外的雨停了。', updatedAt: daysAgo(0), ...patch }
}

test('a one-off date is stale only after its local day has passed', () => {
  const cases = [
    ['2026-11-14', true, 'dated-past:2026-11-14'],
    ['2025-12-31', true, 'dated-past:2025-12-31'],
    ['2026-11-15', false],
    ['2026-11-16', false],
    // Annual MM-DD is a birthday, not an expiry — even when that day already passed.
    ['10-29', false],
    ['02-29', false],
    // Impossible or non-date-only values are ignored, never "expired".
    ['2026-02-30', false],
    ['2026-13-01', false],
    ['2026-11-14T00:00:00', false],
    ['', false],
    [null, false],
    [undefined, false],
  ]
  for (const [salientDate, stale, reason] of cases) {
    const result = freshnessSignals(entry({ salientDate }), { now: NOW })
    assert.equal(result.stale, stale, `salientDate=${String(salientDate)}`)
    if (stale) assert.deepEqual(result.reasons, [reason])
    else assert.deepEqual(result.reasons, [])
  }
})

test('the fixed freshness vocabulary matches title and content', () => {
  const terms = ['最新', '最近', '现在', '目前', '今年', '版本', '价格', '天气', '新闻', '比分', '汇率']
  for (const term of terms) {
    const inTitle = freshnessSignals(entry({ title: `关于${term}的记录` }), { now: NOW })
    assert.equal(inTitle.stale, true, `${term} in title`)
    assert.deepEqual(inTitle.reasons, [`freshness-term:${term}`])

    const inContent = freshnessSignals(entry({ title: '记录', content: `这条提到${term}。` }), { now: NOW })
    assert.equal(inContent.stale, true, `${term} in content`)
    assert.deepEqual(inContent.reasons, [`freshness-term:${term}`])
  }

  const both = freshnessSignals(entry({ title: '最新价格' }), { now: NOW })
  assert.deepEqual(both.reasons, ['freshness-term:最新', 'freshness-term:价格'])

  assert.deepEqual(freshnessSignals(entry({ title: 'latest price' }), { now: NOW }), { stale: false, reasons: [] })
})

test('age comes from updatedAt first and ignores project facts', () => {
  assert.deepEqual(
    freshnessSignals(entry({ updatedAt: daysAgo(45) }), { now: NOW }).reasons,
    ['age-days:45'],
  )
  // updatedAt wins over an older createdAt: an edited entry is current again.
  assert.deepEqual(
    freshnessSignals(entry({ updatedAt: daysAgo(1), createdAt: daysAgo(400) }), { now: NOW }).reasons,
    [],
  )
  assert.deepEqual(
    freshnessSignals(entry({ updatedAt: undefined, createdAt: daysAgo(45) }), { now: NOW }).reasons,
    ['age-days:45'],
  )
  // Project conclusions may age too, but a coding library where every card says
  // "old" is noise; the age leg stays off for them.
  assert.deepEqual(
    freshnessSignals(entry({ owner: 'about_project', updatedAt: daysAgo(400) }), { now: NOW }).reasons,
    [],
  )
  // Only the age leg is excluded: time-sensitive wording still counts.
  assert.deepEqual(
    freshnessSignals(entry({ owner: 'about_project', title: '版本', updatedAt: daysAgo(400) }), { now: NOW }).reasons,
    ['freshness-term:版本'],
  )
})

test('missing, invalid and future timestamps are not age signals', () => {
  const cases = [
    { updatedAt: undefined, createdAt: undefined },
    { updatedAt: null, createdAt: null },
    { updatedAt: '', createdAt: '' },
    { updatedAt: 'not-a-date', createdAt: 'also-not-a-date' },
    { updatedAt: NaN, createdAt: NaN },
    { updatedAt: daysAgo(-10), createdAt: daysAgo(-10) },
  ]
  for (const patch of cases) {
    assert.deepEqual(freshnessSignals(entry(patch), { now: NOW }), { stale: false, reasons: [] })
  }
})

test('the age boundary is inclusive at freshnessDays', () => {
  const exact = freshnessSignals({ updatedAt: new Date(NOW.getTime() - 30 * DAY_MS).toISOString() }, { now: NOW })
  assert.equal(exact.stale, true)
  assert.deepEqual(exact.reasons, ['age-days:30'])

  const justUnder = freshnessSignals({ updatedAt: new Date(NOW.getTime() - (30 * DAY_MS - 1)).toISOString() }, { now: NOW })
  assert.deepEqual(justUnder, { stale: false, reasons: [] })

  assert.equal(freshnessSignals({ updatedAt: daysAgo(89) }, { now: NOW, freshnessDays: 90 }).stale, false)
  assert.equal(freshnessSignals({ updatedAt: daysAgo(90) }, { now: NOW, freshnessDays: 90 }).stale, true)

  // An unusable threshold falls back to 30, not to "everything is stale".
  assert.equal(freshnessSignals({ updatedAt: daysAgo(31) }, { now: NOW, freshnessDays: NaN }).stale, true)
  assert.equal(freshnessSignals({ updatedAt: daysAgo(29) }, { now: NOW, freshnessDays: 'nope' }).stale, false)
})

test('signals compose and the reasons list names every one of them', () => {
  const all = freshnessSignals({
    title: '最新价格',
    content: '汇率也变了。',
    salientDate: '2026-11-01',
    updatedAt: daysAgo(60),
  }, { now: NOW })
  assert.equal(all.stale, true)
  assert.deepEqual(all.reasons, [
    'dated-past:2026-11-01',
    'freshness-term:最新',
    'freshness-term:价格',
    'freshness-term:汇率',
    'age-days:60',
  ])
})

test('bad entries and bad clocks never throw', () => {
  for (const value of [null, undefined, 42, 'memory']) {
    assert.deepEqual(freshnessSignals(value), { stale: false, reasons: [] })
  }
  for (const now of [NaN, 'not-a-date', new Date(NaN)]) {
    const result = freshnessSignals({ updatedAt: '2000-01-01T00:00:00Z' }, { now })
    assert.equal(result.stale, true, `now=${String(now)} must fall back to the wall clock`)
  }
})
