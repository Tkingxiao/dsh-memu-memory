// 相对日期 → 绝对日期。
//
// 相对日期不能靠模型心算。写入时按这一轮的逻辑时间（sceneTime）解析，
// 召回时也先把查询里的相对日期解析成绝对日期再拼检索词。这是个纯函数模块：
// 不做 IO、不读系统时钟（除非调用方不传 now），失败返回 null，绝不猜。

const DAY_MS = 86_400_000
const DEFAULT_TIME_ZONE = 'Asia/Shanghai'
const YEAR_MIN = 1900
const YEAR_MAX = 2999

const WEEKDAY_INDEX = new Map([
  ['一', 0], ['二', 1], ['三', 2], ['四', 3], ['五', 4], ['六', 5], ['日', 6], ['天', 6],
  ['1', 0], ['2', 1], ['3', 2], ['4', 3], ['5', 4], ['6', 5], ['7', 6],
])

const RELATIVE_DAY_TERMS = [
  ['大后天', 3], ['大前天', -3],
  ['后天', 2], ['前天', -2],
  ['明天', 1], ['昨天', -1], ['今天', 0],
  ['明日', 1], ['昨日', -1], ['今日', 0],
].sort((a, b) => b[0].length - a[0].length)

const EN_RELATIVE_DAYS = new Map([
  ['today', 0], ['tomorrow', 1], ['yesterday', -1],
  ['the day after tomorrow', 2], ['the day before yesterday', -2],
])

const formatterCache = new Map()

function pad2(value) {
  return String(value).padStart(2, '0')
}

function formatDate({ y, m, d }) {
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function validCalendar(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false
  if (y < YEAR_MIN || y > YEAR_MAX || m < 1 || m > 12 || d < 1) return false
  return d <= daysInMonth(y, m)
}

function addDays({ y, m, d }, days) {
  const at = new Date(Date.UTC(y, m - 1, d) + Number(days) * DAY_MS)
  return { y: at.getUTCFullYear(), m: at.getUTCMonth() + 1, d: at.getUTCDate() }
}

function weekdayMondayIndex({ y, m, d }) {
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
}

function mondayOfWeek({ y, m, d }) {
  return addDays({ y, m, d }, -weekdayMondayIndex({ y, m, d }))
}

function addMonths({ y, m }, months) {
  const at = new Date(Date.UTC(y, m - 1 + Number(months), 1))
  return { y: at.getUTCFullYear(), m: at.getUTCMonth() + 1 }
}

function formatterFor(timeZone) {
  const key = String(timeZone || '')
  if (formatterCache.has(key)) return formatterCache.get(key)
  let formatter
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: key || DEFAULT_TIME_ZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
    })
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: DEFAULT_TIME_ZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
    })
  }
  formatterCache.set(key, formatter)
  return formatter
}

function instantOf(now) {
  if (now instanceof Date) return Number.isFinite(now.getTime()) ? now : new Date()
  if (typeof now === 'number') {
    const at = new Date(now)
    return Number.isFinite(at.getTime()) ? at : new Date()
  }
  if (typeof now === 'string' && now.trim()) {
    const at = new Date(now)
    if (Number.isFinite(at.getTime())) return at
  }
  return new Date()
}

function zonedCalendar(instant, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(instant)
  const values = {}
  for (const part of parts) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') values[part.type] = Number(part.value)
  }
  if (!validCalendar(values.year, values.month, values.day)) {
    return { y: instant.getUTCFullYear(), m: instant.getUTCMonth() + 1, d: instant.getUTCDate() }
  }
  return { y: values.year, m: values.month, d: values.day }
}

function candidate(index, sourceText, calendar, precision, dateSource, priority) {
  if (!validCalendar(calendar.y, calendar.m, calendar.d)) return null
  return {
    absoluteDate: formatDate(calendar),
    precision,
    sourceText: String(sourceText || '').trim(),
    dateSource,
    index: Number(index) || 0,
    priority,
    calendar,
  }
}

function matchesOf(re, text, build) {
  const out = []
  re.lastIndex = 0
  let match
  while ((match = re.exec(text)) !== null) {
    const item = build(match)
    if (item) out.push(item)
    if (match[0].length === 0) re.lastIndex += 1
  }
  return out
}

function explicitCandidates(text, today) {
  // 只认完整年月日；不带年份的 MM-DD 是周年日，不是某一天。
  const re = /(?<![\d])(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[日号]?(?![\d])/g
  return matchesOf(re, text, (match) => candidate(
    match.index,
    match[0],
    { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) },
    'day',
    'explicit',
    0,
  ))
}

function relativeDayCandidates(text, today) {
  const out = []
  for (const [term, offset] of RELATIVE_DAY_TERMS) {
    let from = 0
    while (from < text.length) {
      const at = text.indexOf(term, from)
      if (at < 0) break
      // "大后天" 里的 "后天" 不单独算一次：长度更长的词优先。
      const longerBefore = at > 0 && RELATIVE_DAY_TERMS.some(([other]) => other.length > term.length
        && text.slice(Math.max(0, at - (other.length - term.length)), at + term.length) === other)
      const longerAt = RELATIVE_DAY_TERMS.some(([other]) => other.length > term.length
        && text.slice(at, at + other.length) === other)
      if (!longerBefore && !longerAt) {
        const item = candidate(at, term, addDays(today, offset), 'day', 'relative', 10)
        if (item) out.push(item)
      }
      from = at + term.length
    }
  }
  const en = /(?<![a-z])(the day after tomorrow|the day before yesterday|today|tomorrow|yesterday)(?![a-z])/gi
  for (const match of matchesOf(en, text, (item) => item)) {
    const offset = EN_RELATIVE_DAYS.get(match[0].toLowerCase())
    if (offset === undefined) continue
    const item = candidate(match.index, match[0], addDays(today, offset), 'day', 'relative', 10)
    if (item) out.push(item)
  }
  return out
}

function weekCandidates(text, today) {
  const re = /(上上|上|下个|下|这个|这|本)\s*(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/g
  return matchesOf(re, text, (match) => {
    const prefix = match[1]
    const weekday = WEEKDAY_INDEX.get(match[2])
    if (weekday === undefined) return null
    let weeks = 0
    if (prefix === '下' || prefix === '下个') weeks = 1
    else if (prefix === '上') weeks = -1
    else if (prefix === '上上') weeks = -2
    const monday = mondayOfWeek(today)
    return candidate(match.index, match[0], addDays(monday, weeks * 7 + weekday), 'day', 'relative', 20)
  })
}

function monthDayCandidates(text, today) {
  const re = /(下个?月|下月份?|本月|这个月份?)\s*(\d{1,2})\s*[号日]/g
  return matchesOf(re, text, (match) => {
    const day = Number(match[2])
    const month = match[1].startsWith('下') ? addMonths(today, 1) : { y: today.y, m: today.m }
    if (day < 1 || day > daysInMonth(month.y, month.m)) return null
    return candidate(match.index, match[0], { y: month.y, m: month.m, d: day }, 'day', 'relative', 30)
  })
}

function monthBoundaryCandidates(text, today) {
  const re = /(下个?月|下月份?|本月|这个月份?|月)\s*(?:底|末)/g
  return matchesOf(re, text, (match) => {
    const prefix = match[1]
    const month = prefix.startsWith('下') ? addMonths(today, 1) : { y: today.y, m: today.m }
    return candidate(match.index, match[0], { y: month.y, m: month.m, d: daysInMonth(month.y, month.m) }, 'month', 'relative', 40)
  })
}

function yearBoundaryCandidates(text, today) {
  const out = []
  for (const match of text.matchAll(/年初/g)) {
    const item = candidate(match.index, match[0], { y: today.y, m: 1, d: 1 }, 'year', 'relative', 50)
    if (item) out.push(item)
  }
  for (const match of text.matchAll(/(?:年底|年末)/g)) {
    const item = candidate(match.index, match[0], { y: today.y, m: 12, d: 31 }, 'year', 'relative', 50)
    if (item) out.push(item)
  }
  return out
}

function offsetDayCandidates(text, today) {
  const out = []
  const after = /(\d{1,3})\s*天\s*(?:之|以)?后/g
  for (const match of text.matchAll(after)) {
    const days = Number(match[1])
    if (!Number.isFinite(days)) continue
    const item = candidate(match.index, match[0], addDays(today, days), 'day', 'relative', 12)
    if (item) out.push(item)
  }
  const before = /(\d{1,3})\s*天\s*(?:之|以)?前/g
  for (const match of text.matchAll(before)) {
    const days = Number(match[1])
    if (!Number.isFinite(days)) continue
    const item = candidate(match.index, match[0], addDays(today, -days), 'day', 'relative', 12)
    if (item) out.push(item)
  }
  return out
}

function allCandidates(text, { now, timeZone } = {}) {
  const normalized = String(text ?? '').normalize('NFKC')
  if (!normalized.trim()) return []
  const today = zonedCalendar(instantOf(now), timeZone)
  const found = [
    ...explicitCandidates(normalized, today),
    ...relativeDayCandidates(normalized, today),
    ...weekCandidates(normalized, today),
    ...monthDayCandidates(normalized, today),
    ...monthBoundaryCandidates(normalized, today),
    ...yearBoundaryCandidates(normalized, today),
    ...offsetDayCandidates(normalized, today),
  ]
  // 同一位置同一句只留最具体的一条（显式日期 > 相对日 > 周 > 月日 > 月底 > 年）。
  const best = new Map()
  for (const item of found) {
    const key = `${item.index}:${item.sourceText}`
    const current = best.get(key)
    if (!current || item.priority < current.priority) best.set(key, item)
  }
  return [...best.values()].sort((a, b) => a.index - b.index || a.priority - b.priority)
}

/**
 * 解析文本里最可信的一个日期表达。
 * @returns {{absoluteDate: string, precision: 'day'|'month'|'year', sourceText: string,
 *   dateSource: 'explicit'|'relative', index: number}|null}
 */
export function parseTemporalExpression(text, { now = new Date(), timeZone = DEFAULT_TIME_ZONE } = {}) {
  const found = allCandidates(text, { now, timeZone })
  if (found.length === 0) return null
  const ordered = found.slice().sort((a, b) => a.priority - b.priority || a.index - b.index)
  const chosen = ordered[0]
  return {
    absoluteDate: chosen.absoluteDate,
    precision: chosen.precision,
    sourceText: chosen.sourceText,
    dateSource: chosen.dateSource,
    index: chosen.index,
  }
}

/** 文本里所有可解析的日期表达，按出现顺序。 */
export function extractTemporalExpressions(text, options = {}) {
  return allCandidates(text, options).map((item) => ({
    absoluteDate: item.absoluteDate,
    precision: item.precision,
    sourceText: item.sourceText,
    dateSource: item.dateSource,
    index: item.index,
  }))
}

/** 查询侧：文本里所有绝对日期，去重后按出现顺序。 */
export function resolveQueryDates(text, options = {}) {
  const dates = []
  for (const item of extractTemporalExpressions(text, options)) {
    if (!dates.includes(item.absoluteDate)) dates.push(item.absoluteDate)
  }
  return dates
}

/** 有相对时间词、但可能解析不出来（例如只说“下周”）。 */
export function hasTemporalHint(text) {
  const value = String(text ?? '').normalize('NFKC')
  return /大后天|大前天|后天|前天|明天|昨天|今天|今日|明日|昨日|下周|这周|本周|下周|上周|下个?月|本月|这个月|月底|月末|年初|年底|年末|\d\s*天\s*(?:之|以)?[前后]|(?<![a-z])(today|tomorrow|yesterday)(?![a-z])/i.test(value)
}

/** 严格 YYYY-MM-DD；非法日期返回 null（不猜）。 */
export function parseAbsoluteDate(value) {
  const text = String(value ?? '').trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  if (!validCalendar(y, m, d)) return null
  return formatDate({ y, m, d })
}

/** 某个瞬间在指定时区里的本地日期（YYYY-MM-DD）。 */
export function localDateKeyInZone(value = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  return formatDate(zonedCalendar(instantOf(value), timeZone))
}

/**
 * 宿主本地的日历日（YYYY-MM-DD）。
 *
 * 这一行原来在 state / stats / freshness / commitment / salient-wake / inject /
 * memory 里各写了一遍（8 处，padStart 与 pad2 两种风格混用，其中一处漏了补零）。
 * 它们算的是同一件事，只是各写各的；统一到这里以后，「本地日历日」只有一种写法。
 *
 * 与 localDateKeyInZone 的分工是**有意的**，不是重复实现：那个按指定时区算，用于
 * 解析记忆文本里的相对日期（默认 Asia/Shanghai，见 DEFAULT_TIME_ZONE）；这个按宿主
 * 时区算，用于「今天 / 连续多少天 / 统计桶」这类必须跟着用户本地时钟走的口径。两者
 * 在 UTC+8 上一致，在别的时区会相差一天——这条口径差目前是已知未收敛项，改动它等于
 * 改产品语义，不在这次清理范围内。
 */
export function localCalendarDay(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  const at = Number.isFinite(date.getTime()) ? date : new Date()
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`
}

export { DEFAULT_TIME_ZONE, DAY_MS }
