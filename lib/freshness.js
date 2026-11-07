// Freshness signals for a recalled memory (work order D).
//
// The hint that buildRecall appends is only as good as this classification, so the
// rules stay small and local:
//   1. a one-off salient date (YYYY-MM-DD) has already passed;
//   2. the title or body names something time-sensitive (最新 / 价格 / ...);
//   3. the entry itself is old enough (`updatedAt || createdAt` >= freshnessDays),
//      except project facts, whose staleness is better judged against the code.
//
// An annual MM-DD date is a birthday, not an expiry: it never goes stale by itself.
// The word list is fixed on purpose — exposing it as a setting would create a second
// vocabulary system, and this is a nudge, not a filter.

import { localCalendarDay } from './temporal.js'
const DAY_MS = 86_400_000
const DEFAULT_FRESHNESS_DAYS = 30
// Fixed first-version vocabulary (plan D.2). Keep it separate from the lexicon.
const FRESHNESS_TERMS = ['最新', '最近', '现在', '目前', '今年', '版本', '价格', '天气', '新闻', '比分', '汇率']
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

// `now` accepts a Date, epoch milliseconds or a parsable stamp. Anything invalid
// falls back to the wall clock so a caller mistake cannot crash a recall.
function baseTime(now) {
  let date
  if (now instanceof Date) date = now
  else if (typeof now === 'number') date = new Date(now)
  else date = new Date(now ?? Date.now())
  const time = date instanceof Date ? date.getTime() : NaN
  return Number.isFinite(time) ? time : Date.now()
}

// Strict `YYYY-MM-DD` in local time. Returns null for MM-DD (annual), malformed
// strings and impossible dates such as 2026-02-30; those must never read as expired.
function datedValue(value) {
  const text = String(value ?? '').trim()
  const match = DATE_RE.exec(text)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  date.setHours(0, 0, 0, 0)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return { text: `${match[1]}-${match[2]}-${match[3]}`, time: date.getTime() }
}

function timestampMs(value) {
  if (value === undefined || value === null || value === '') return null
  const at = typeof value === 'number' ? value : Date.parse(String(value))
  return Number.isFinite(at) ? at : null
}

function localDateKey(now) {
  return localCalendarDay(baseTime(now))
}

/**
 * S1 的有效窗口：`valid_from <= scene day <= valid_to`。两个字段缺失都不影响召回
 * （旧数据没有它们）；只有显式写下的窗口才能把条目挡在召回之外。
 * 返回的 reasons 用于活动日志/测试，调用方只关心 valid。
 */
export function validitySignals(entry, { now = Date.now() } = {}) {
  const reasons = []
  if (!entry || typeof entry !== 'object') return { valid: true, reasons }
  const today = localDateKey(now)
  // S1 用 snake_case；旧复核路径写过 validFrom/validTo，两个都要认。
  const from = datedValue(entry.valid_from ?? entry.validFrom)
  const to = datedValue(entry.valid_to ?? entry.validTo)
  // An unfinished/invalid window is ignored rather than treated as "always valid":
  // a repair should never make a memory vanish for the rest of the day.
  if (from && today < from.text) reasons.push(`valid-from-future:${from.text}`)
  if (to && today > to.text) reasons.push(`valid-to-past:${to.text}`)
  return { valid: reasons.length === 0, reasons }
}

function thresholdDays(value) {
  const days = Number(value)
  return Number.isFinite(days) && days >= 0 ? days : DEFAULT_FRESHNESS_DAYS
}

/**
 * Classify one recalled entry.
 *
 * @param {object} entry memory entry; `title`/`content` are scanned for terms.
 * @param {{now?: Date|number, freshnessDays?: number}} [options]
 * @returns {{stale: boolean, reasons: string[]}}
 */
export function freshnessSignals(entry, { now = Date.now(), freshnessDays = DEFAULT_FRESHNESS_DAYS } = {}) {
  const reasons = []
  if (!entry || typeof entry !== 'object') return { stale: false, reasons }
  const nowMs = baseTime(now)
  const todayStart = new Date(nowMs)
  todayStart.setHours(0, 0, 0, 0)
  const todayMs = todayStart.getTime()

  // (a) A one-off date strictly before local today. Today itself still counts as
  // current; only tomorrow and later are future.
  const dated = datedValue(entry.salientDate)
  if (dated && dated.time < todayMs) reasons.push(`dated-past:${dated.text}`)

  // (b) Time-sensitive wording in the title or body. Every matched term is kept so
  // the reason list is auditable instead of a single opaque boolean.
  const text = `${entry.title ?? ''}\n${entry.content ?? ''}`
  for (const term of FRESHNESS_TERMS) if (text.includes(term)) reasons.push(`freshness-term:${term}`)

  // (c) Age since the last edit. `updatedAt` wins over `createdAt`; missing or
  // invalid stamps contribute nothing, and future stamps are not "old". Project
  // facts are excluded on purpose — most coding memories would otherwise always
  // trip this leg.
  if (entry.owner !== 'about_project') {
    const at = timestampMs(entry.updatedAt || entry.createdAt)
    if (at !== null) {
      const age = (nowMs - at) / DAY_MS
      if (Number.isFinite(age) && age >= thresholdDays(freshnessDays)) reasons.push(`age-days:${Math.floor(age)}`)
    }
  }

  return { stale: reasons.length > 0, reasons }
}
