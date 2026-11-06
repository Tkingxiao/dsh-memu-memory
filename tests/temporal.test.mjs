import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseTemporalExpression,
  extractTemporalExpressions,
  resolveQueryDates,
  parseAbsoluteDate,
  hasTemporalHint,
} from '../lib/temporal.js'

// 2026-11-06 12:00 Asia/Shanghai (Friday).
const NOW = new Date('2026-11-06T04:00:00Z')

const parse = (text, options = {}) => parseTemporalExpression(text, { now: NOW, ...options })
const dateOf = (text, options = {}) => parse(text, options)?.absoluteDate ?? null

test('relative day words resolve against the scene time', () => {
  assert.equal(dateOf('今天'), '2026-11-06')
  assert.equal(dateOf('明天'), '2026-11-07')
  assert.equal(dateOf('后天'), '2026-11-08')
  assert.equal(dateOf('大后天'), '2026-11-09')
  assert.equal(dateOf('昨天'), '2026-11-05')
  assert.equal(dateOf('前天'), '2026-11-04')
  assert.equal(dateOf('大前天'), '2026-11-03')
  // A longer term wins over the shorter one inside it.
  const daHoutian = parse('大后天')
  assert.equal(daHoutian.sourceText, '大后天')
  assert.equal(daHoutian.precision, 'day')
  assert.equal(daHoutian.dateSource, 'relative')
})

test('relative days cross month, year and leap-day boundaries', () => {
  assert.equal(dateOf('明天', { now: new Date('2026-01-31T04:00:00Z') }), '2026-02-01')
  assert.equal(dateOf('明天', { now: new Date('2026-12-31T04:00:00Z') }), '2027-01-01')
  // 2028 is a leap year: Feb 28 + 1 = Feb 29, Feb 29 + 1 = Mar 1.
  assert.equal(dateOf('明天', { now: new Date('2028-02-28T04:00:00Z') }), '2028-02-29')
  assert.equal(dateOf('明天', { now: new Date('2028-02-29T04:00:00Z') }), '2028-03-01')
  assert.equal(dateOf('昨天', { now: new Date('2028-03-01T04:00:00Z') }), '2028-02-29')
})

test('week phrases use Monday-based weeks and never guess a bare weekday', () => {
  // 2026-11-06 is a Friday; this week's Monday is 2026-11-02.
  assert.equal(dateOf('这周三'), '2026-11-04')
  assert.equal(dateOf('本周日'), '2026-11-08')
  assert.equal(dateOf('下周一'), '2026-11-09')
  assert.equal(dateOf('下周三'), '2026-11-11')
  assert.equal(dateOf('下个星期天'), '2026-11-15')
  assert.equal(dateOf('上周六'), '2026-10-31')
  assert.equal(dateOf('上上礼拜一'), '2026-10-19')
  // Bare "周三" is ambiguous between this week and next; the module must not pick one.
  assert.equal(dateOf('周三见'), null)
})

test('month, month-end and year boundaries resolve to a concrete day', () => {
  assert.equal(dateOf('下个月15号'), '2026-12-15')
  assert.equal(dateOf('本月6号'), '2026-11-06')
  const monthEnd = parse('月底')
  assert.equal(monthEnd.absoluteDate, '2026-11-30')
  assert.equal(monthEnd.precision, 'month')
  assert.equal(dateOf('下月底'), '2026-12-31')
  const yearStart = parse('年初')
  assert.equal(yearStart.absoluteDate, '2026-01-01')
  assert.equal(yearStart.precision, 'year')
  assert.equal(dateOf('年底'), '2026-12-31')
})

test('impossible dates are refused instead of guessed', () => {
  assert.equal(dateOf('2026-02-30'), null)
  assert.equal(dateOf('2026-13-01'), null)
  // "下个月30号" said in January points at February 30th, which does not exist.
  assert.equal(dateOf('下个月30号', { now: new Date('2026-01-15T04:00:00Z') }), null)
  assert.equal(parseAbsoluteDate('2026-02-29'), null)
  assert.equal(parseAbsoluteDate('2028-02-29'), '2028-02-29')
  assert.equal(dateOf('下周'), null, 'a week without a weekday is not a day')
})

test('explicit dates win over relative words and keep their precision', () => {
  assert.equal(dateOf('2026-11-09 见面'), '2026-11-09')
  assert.equal(dateOf('约定在2026年12月1日'), '2026-12-01')
  assert.equal(dateOf('昨天说好下周三'), '2026-11-05', 'the first trustworthy expression is used for the entry date')
  const explicit = parse('2026-11-09')
  assert.equal(explicit.dateSource, 'explicit')
  assert.equal(explicit.precision, 'day')
})

test('offset days and English relative words', () => {
  assert.equal(dateOf('3天后'), '2026-11-09')
  assert.equal(dateOf('10天前'), '2026-10-27')
  assert.equal(dateOf('tomorrow'), '2026-11-07')
  assert.equal(dateOf('the day after tomorrow'), '2026-11-08')
  assert.equal(dateOf('yesterday'), '2026-11-05')
})

test('the time zone changes what "today" means', () => {
  // 16:30Z is already Nov 6 in Shanghai but still Nov 5 in New York.
  const instant = new Date('2026-11-05T16:30:00Z')
  assert.equal(dateOf('明天', { now: instant, timeZone: 'Asia/Shanghai' }), '2026-11-07')
  assert.equal(dateOf('明天', { now: instant, timeZone: 'America/New_York' }), '2026-11-06')
  // An unknown zone falls back instead of throwing: a bad setting must not fail a write.
  assert.equal(dateOf('明天', { now: instant, timeZone: 'Not/AZone' }), '2026-11-07')
})

test('all expressions can be extracted for query expansion', () => {
  const all = extractTemporalExpressions('昨天她说下周三见面，月底再确认', { now: NOW })
  assert.deepEqual(all.map((item) => item.sourceText), ['昨天', '下周三', '月底'])
  assert.deepEqual(resolveQueryDates('昨天她说下周三见面，月底再确认', { now: NOW }), ['2026-11-05', '2026-11-11', '2026-11-30'])
  assert.deepEqual(resolveQueryDates('没有日期的句子', { now: NOW }), [])
})

test('hasTemporalHint distinguishes a relative hint from ordinary text', () => {
  assert.equal(hasTemporalHint('下周再说'), true)
  assert.equal(hasTemporalHint('月底前给答复'), true)
  assert.equal(hasTemporalHint('tomorrow morning'), true)
  assert.equal(hasTemporalHint('窗外的雨停了'), false)
  assert.equal(hasTemporalHint(undefined), false)
})

test('empty and non-string input never throw', () => {
  for (const value of [null, undefined, '', '   ', 123, {}]) {
    assert.equal(parseTemporalExpression(value, { now: NOW }), null)
    assert.deepEqual(extractTemporalExpressions(value, { now: NOW }), [])
  }
})
