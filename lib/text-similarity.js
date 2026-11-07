// One ruler for "do these two memories say the same thing".
//
// 5: the recall side (candidate folding, MMR hard skip) and the
// write side (the duplicate gate) must measure with the same formula, or recall
// folds what write kept and vice versa. Everything here is deliberately
// dependency-free — two bigram sets and the Dice coefficient — and the text
// preprocessing is the one the contradiction check always used (lowercase, strip
// whitespace/punctuation/symbols), so findConflict's behaviour is unchanged by
// this extraction.

// —— 相似度阈值的唯一表（A-10）——
// 本文件是「相似度尺度」阈值的唯一来源：Dice 分带、长度剪枝比、包含探针的下限与
// 窗口都在 SIMILARITY_THRESHOLDS 里。curator-policy.js 只消费这些常量来组成策展
// 策略（absorb/link/duplicate 的落点），不自己内联相似度数字。
// 下面的具名常量是兼容导出：调用点全部按名字 import，数值与语义保持不变。
export const SIMILARITY_THRESHOLDS = Object.freeze({
  // 同一事实：召回簇只留一条候选，MMR 硬跳过其余。
  duplicateDice: 0.82,
  // 写入侧拒绝：新记忆与已有记忆近到这个程度直接拒绝。
  rejectDice: 0.90,
  // 同主题不同事实：召回侧软惩罚带，写入侧打 duplicateOf 标签。
  topicDice: 0.55,
  // 写入侧剪枝：长度差超过较长者这个比例就跳过 bigram 全套计算。
  lengthPruneRatio: 0.5,
  // 长度悬殊时的包含探针下限（逐字包含）。
  containmentFloor: 0.92,
  // 探针窗口：短文本清洗后低于 MIN 信号不足，高于 MAX 超出探针预算。
  probeMinChars: 6,
  probeMaxChars: 240,
})

// Same fact: a recall cluster keeps one candidate, MMR hard-skips the rest.
export const DUP_DICE = SIMILARITY_THRESHOLDS.duplicateDice
// Write-side reject: a new memory this close to an existing one is refused.
export const DUP_REJECT_DICE = SIMILARITY_THRESHOLDS.rejectDice
// Same topic, different fact: soft-penalty band on recall, duplicateOf tag on write.
export const TOPIC_DICE = SIMILARITY_THRESHOLDS.topicDice
// Write-side pruning: skip the bigram pass when two texts differ in length by more
// than this fraction of the longer one. At this ratio Dice cannot reach the reject
// band even with zero unique bigrams on the short side.
export const LENGTH_PRUNE_RATIO = SIMILARITY_THRESHOLDS.lengthPruneRatio

// Length-disparate pairs (gap > LENGTH_PRUNE_RATIO) do not go through Dice — the
// ratio math makes a reject-band Dice impossible, which is exactly the hole a
// "rewrite it much longer" evader walks through. Two cheap containment probes
// close the hole without paying the full bigram pass:
//   * verbatim containment — the short cleaned text is a substring of the long one;
//   * core coverage — every character bigram of the short text occurs somewhere in
//     the long one ("核心词全含"), probed with String.includes so the long side is
//     never materialised into a bigram set and a miss fails fast on the first
//     absent gram.
// Both are strictly stronger signals than Dice ≥ DUP_REJECT_DICE (a verbatim or
// all-grams-contained overlap cannot be an accident), so they report a floor in
// the reject band instead of a made-up Dice value. Partial coverage deliberately
// reports 0: with a >0.5 length gap there is no honest way to say "same topic",
// and a false reject on the write side is worse than a rare paraphrase bypass —
// the residual risk (heavily reworded padding) is documented in 
export const CONTAINMENT_FLOOR = SIMILARITY_THRESHOLDS.containmentFloor
export const CORE_COVER_FLOOR = SIMILARITY_THRESHOLDS.rejectDice
// Below this many cleaned characters the probe has too little signal (a 4-char
// string and its bigrams occur in unrelated texts all the time); above the max the
// probe budget is exceeded and both sides are substantial enough to trust the
// length prune again. Bounds keep the write-side gate O(|short|·|long|) native
// scans per pruned pair instead of O(N²) bigram-set construction.
export const PROBE_MIN_CHARS = SIMILARITY_THRESHOLDS.probeMinChars
export const PROBE_MAX_CHARS = SIMILARITY_THRESHOLDS.probeMaxChars

/** The one text preprocessing every measurement here shares. */
export function clean(text) {
  return String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** Lowercase, strip whitespace/punctuation/symbols, then collect character bigrams. */
export function bigrams(text) {
  const c = clean(text)
  const out = new Set()
  for (let i = 0; i < c.length - 1; i += 1) out.add(c.slice(i, i + 2))
  return out
}

// —— Slot guard ——
//
// Dice over character bigrams cannot tell "五本" from "七本", "11-08" from
// "11-15", or "喜欢" from "不喜欢": the sentences are otherwise identical, so a
// revised fact looks like a paraphrased duplicate and gets refused/folded. The
// slot signature compares only the parts that change the claim: numbers, dates,
// times, weekdays and quoted names. If both sides carry the same slot type and
// disagree, the pair is a different fact; the score is capped below the topic
// band so it cannot be rejected, tagged duplicateOf, or folded in recall.
// Unquoted Chinese personal names still need NER; quoted/@ names are covered.
// Predicate negation stays with findConflict, whose clause-level check already
// decides "likes" vs "doesn't like" without mistaking "免费" / "不用付费" for a
// contradiction.

const SLOT_DATE_RE = /(?:\d{4}[-/]\d{1,2}[-/]\d{1,2})|(?:\d{1,2}月\d{1,2}[日号]?)/g
const SLOT_TIME_RE = /(?:\d{1,2}[:：]\d{2})|(?:\d{1,2}点(?:\d{1,2}分|半)?)/g
const SLOT_WEEKDAY_RE = /(?:周|星期|礼拜)[一二三四五六日天1-7]/g
const SLOT_NUMBER_RE = /\d+(?:\.\d+)?/g
const SLOT_CN_NUMBER_RE = /[零一二三四五六七八九十百千万亿两]+(?=本|个|次|天|月|日|号|岁|年|点|分|元|块|张|条|人|位|小时|分钟|周|份|杯|瓶|只|家|件|场|门|层|楼|页)/g
const SLOT_QUOTED_RE = /["“”「」『』]([^"“”「」『』]{2,30})["“”「」『』]/g
const SLOT_AT_RE = /@([\w\u4e00-\u9fff-]{2,30})/g

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const CN_UNITS = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 }
const WEEKDAY_NUMBER = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 }

function pad2(value) {
  return String(value).padStart(2, '0')
}

function chineseNumber(text) {
  let total = 0
  let section = 0
  let number = 0
  for (const char of String(text || '')) {
    if (CN_DIGITS[char] !== undefined) {
      number = CN_DIGITS[char]
      continue
    }
    const unit = CN_UNITS[char]
    if (unit === undefined) return null
    if (unit >= 10000) {
      section = (section + number) * unit
      total += section
      section = 0
      number = 0
    } else {
      section += (number || 1) * unit
      number = 0
    }
  }
  return total + section + number
}

function normalizeNumber(raw) {
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const value = Number(raw)
    return Number.isFinite(value) ? String(value) : raw
  }
  const value = chineseNumber(raw)
  return value === null ? raw : String(value)
}

function normalizeDate(raw) {
  const absolute = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(raw)
  if (absolute) return `${absolute[1]}-${pad2(absolute[2])}-${pad2(absolute[3])}`
  const monthDay = /^(\d{1,2})月(\d{1,2})[日号]?$/.exec(raw)
  if (monthDay) return `${pad2(monthDay[1])}-${pad2(monthDay[2])}`
  return raw
}

function normalizeTime(raw) {
  const colon = /^(\d{1,2})[:：](\d{2})$/.exec(raw)
  if (colon) return `${pad2(colon[1])}:${colon[2]}`
  const dot = /^(\d{1,2})点(?:(\d{1,2})分|半)?$/.exec(raw)
  if (!dot) return raw
  const minute = dot[2] !== undefined ? pad2(dot[2]) : (raw.endsWith('半') ? '30' : '00')
  return `${pad2(dot[1])}:${minute}`
}

function normalizeWeekday(raw) {
  const char = raw.slice(-1)
  const day = WEEKDAY_NUMBER[char]
  return day === undefined ? raw : `weekday:${day}`
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

/** The slots that can change what a sentence claims, without changing its shape. */
export function slotSignature(text) {
  const value = String(text || '')
  const numbers = []
  for (const match of value.matchAll(SLOT_NUMBER_RE)) numbers.push(normalizeNumber(match[0]))
  for (const match of value.matchAll(SLOT_CN_NUMBER_RE)) numbers.push(normalizeNumber(match[0]))
  const dates = [...value.matchAll(SLOT_DATE_RE)].map((match) => normalizeDate(match[0]))
  const times = [...value.matchAll(SLOT_TIME_RE)].map((match) => normalizeTime(match[0]))
  const weekdays = [...value.matchAll(SLOT_WEEKDAY_RE)].map((match) => normalizeWeekday(match[0]))
  const quoted = []
  for (const match of value.matchAll(SLOT_QUOTED_RE)) quoted.push(match[1].trim().toLowerCase())
  for (const match of value.matchAll(SLOT_AT_RE)) quoted.push(match[1].trim().toLowerCase())
  return {
    numbers: unique(numbers),
    dates: unique(dates),
    times: unique(times),
    weekdays: unique(weekdays),
    quoted: unique(quoted),
  }
}

function setDiffers(a, b) {
  if (a.length === 0 || b.length === 0) return false
  // An added number/date is an enrichment, not a contradiction: {2,4} vs
  // {1,2,4} must not be capped. A replacement or a disjoint set is a different
  // claim: {5} vs {7}, {2,4} vs {2,5}.
  const aContainsB = b.every((value) => a.includes(value))
  const bContainsA = a.every((value) => b.includes(value))
  return !aContainsB && !bContainsA
}

/** True only when both sides carry a slot type and the values disagree. */
export function slotsConflict(a, b) {
  if (!a || !b) return false
  return setDiffers(a.numbers, b.numbers)
    || setDiffers(a.dates, b.dates)
    || setDiffers(a.times, b.times)
    || setDiffers(a.weekdays, b.weekdays)
    || setDiffers(a.quoted, b.quoted)
}

/** Dice coefficient over two bigram sets; 0 when either side is empty. */
export function dice(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  return (2 * shared) / (a.size + b.size)
}

/**
 * Set Jaccard；任一侧为空返回 0。与 text-retrieval 的 pairFeatures 同口径——
 * 这里只提供一份实现，避免两处逐字重复后悄悄漂移。
 */
export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const item of a) if (b.has(item)) shared += 1
  return shared / (a.size + b.size - shared)
}

/** |len(A)-len(B)| / max(len); 0 when both sides are empty. */
export function lengthGap(aText, bText) {
  const a = String(aText || '').length
  const b = String(bText || '').length
  return Math.abs(a - b) / Math.max(a, b, 1)
}

/**
 * The full probe result behind similarTexts. `dice` is the plain bigram Dice
 * when the pair is length-comparable; when the length prune fires, `dice` is 0
 * and `containment` carries whichever probe (verbatim CONTAINMENT_FLOOR or
 * core-coverage CORE_COVER_FLOOR) closed the hole, else 0. `lengthGap` is the
 * raw length ratio the prune decision was made on.
 *
 * similarTexts stays `max(dice, containment)` — call sites that need to know
 * *why* two texts matched read the fields instead of reverse-engineering the
 * max (the curator pair features keep "verbatim containment" apart from "high
 * Dice" so the §4.8 conflict carve-outs can tell duplication from rewriting).
 */
export function similarityDetail(aText, bText) {
  const a = String(aText || '')
  const b = String(bText || '')
  const gap = lengthGap(a, b)
  let diceScore = 0
  let containment = 0
  if (gap > LENGTH_PRUNE_RATIO) {
    const aClean = clean(a)
    const bClean = clean(b)
    if (aClean && bClean) {
      const shortClean = aClean.length <= bClean.length ? aClean : bClean
      const longClean = aClean.length <= bClean.length ? bClean : aClean
      if (shortClean.length >= PROBE_MIN_CHARS && shortClean.length <= PROBE_MAX_CHARS) {
        // Probe 1: verbatim containment of the short text inside the long one.
        if (longClean.includes(shortClean)) {
          containment = CONTAINMENT_FLOOR
        } else {
          // Probe 2: core coverage — every character bigram of the short text occurs
          // somewhere in the long one. A miss fails fast on the first absent gram.
          containment = CORE_COVER_FLOOR
          for (let i = 0; i < shortClean.length - 1; i += 1) {
            if (!longClean.includes(shortClean.slice(i, i + 2))) { containment = 0; break }
          }
        }
      }
    }
  } else {
    diceScore = dice(bigrams(a), bigrams(b))
  }
  const raw = Math.max(diceScore, containment)
  // Slot extraction is only paid for pairs that could actually be folded or
  // rejected; the write gate scans a whole library on every write.
  const slotConflict = raw >= TOPIC_DICE && slotsConflict(slotSignature(a), slotSignature(b))
  // `raw` is the similarity on the shared ruler: max(dice, containment). Callers that
  // only reason about "how similar are these two" must use it instead of `dice`,
  // which reads 0 for every length-disparate pair by design.
  return { dice: diceScore, containment, raw, lengthGap: gap, slotConflict }
}

/**
 * Dice over raw texts with the write-side length pruning applied: pairs whose
 * lengths differ too much return 0 without paying for the bigram build (the
 * gate runs over the whole library on every write). 0 can never win a
 * max-similarity scan, so pruned pairs simply never become the best match —
 * unless they hit one of the two containment probes below, which are the only
 * way a length-disparate pair reaches the reject band.
 *
 * A hard slot disagreement caps the result below TOPIC_DICE: the pair is a
 * different fact (five books vs seven, 11-08 vs 11-15, likes vs doesn't), so it
 * must not be refused, tagged duplicateOf, or folded into one recall seat.
 */
export function similarTexts(aText, bText) {
  const detail = similarityDetail(aText, bText)
  const raw = Math.max(detail.dice, detail.containment)
  return detail.slotConflict ? Math.min(raw, TOPIC_DICE - 1e-6) : raw
}
