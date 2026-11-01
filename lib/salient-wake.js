// 工单 E：纪念日到点唤醒（todolist #1）。
//
// 用宿主公开的 `ctx.schedule` 在**投递时区**（`salientWakeTimeZone`，留空跟随系统）的今天/
// 明天到点时，给绑定会话排一条一次性任务。日期与「这一刻过去了吗」都按那个时区算，不然配置
// 时区与机器时区不一致时会排错一天，或把还没到的时刻当成已过而静默跳过。
// schedule 的投递是 `agent.followup(createUserMessage({source:{kind:'schedule'}}))`，
// 会开一整回合，而本插件的注入只认 `source.kind === 'user'` 的真实用户消息 —— 所以
// 这一回合拿不到锚点、召回或纪念日块，prompt 必须自包含。
//
// 这个 pass 只做三件事：读索引找出今天/明天要提的日期记忆、按 `memu:due:` 标题做
// 幂等、把任务交给宿主。它从不抛错（宿主可能根本没有 schedule 服务），也从不覆盖
// 用户的显式操作（暂停的任务不恢复），更不会把正文写进 prompt。没有任何会话需要
// 提醒时它连 `schedule.list` 都不发——空闲装机不该每 5 分钟碰一次宿主的任务表。
//
// 返回值有两种形状，调用方要同时接受：
//   - 整个 pass 没跑：`{ skipped: '<off|service|timezone|time>' }`
//   - 跑过一轮：`{ created, cleaned, skipped, errors }`（都是计数）
import { getSettings, listSessionBindings, loadPrivateIndex, effectiveScope } from './state.js'
import {
  isDatedSalientDate, isMemoryEligible, salientDateFires, salientDaysAhead, visibleToSession,
} from './memory.js'
import { record } from './activity-log.js'

const DEFAULT_HOUR = '09:00'
const HOUR_RE = /^([01]\d|2[0-3]):[0-5]\d$/
// 宿主 list 的上限是 500（types.ts `ScheduleListRequest.limit` 1-500）。一次 sweep
// 只读一页：这插件每会话每天最多两条任务，500 条已经远超正常装机量。
const LIST_LIMIT = 500
// 一条 prompt 最多列这么多条日期；其余用一句话指回 memu_private_recall，避免一个
// 大库把 schedule 回合的开场白撑成一页目录。
const MAX_LINES = 8
// 宿主拒绝投递的错误码里，这两种是"这个目标本来就不该有提醒"，不是故障。
const SKIP_CODES = new Set(['subagent_session', 'invalid_rule'])
const KNOWN_CODES = [
  'subagent_session', 'invalid_rule', 'invalid_time_zone', 'not_future', 'invalid_selector',
  'invalid_prompt', 'time_out_of_range', 'frequency_too_high', 'internal_error',
]

// "一次 warn"：宿主没有 schedule 服务是装机事实，不必每 5 分钟重复一遍日志。
let serviceWarned = false
// 坏时区按取值去重：同一串坏配置只吵一次，换成另一串再吵。
let zoneWarnedFor = null

function pad2(value) {
  return String(value).padStart(2, '0')
}

// 墙上时刻读取按 zone 复用 formatter：这条 pass 每 5 分钟跑一次，构造 Intl 对象不是免费的。
const wallFormatters = new Map()

function wallParts(instant, zone) {
  let fmt = wallFormatters.get(zone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    wallFormatters.set(zone, fmt)
  }
  const parts = {}
  for (const part of fmt.formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return parts
}

/**
 * 某个绝对时刻在指定时区里落在哪个日历日，以及那天的「今天/明天」载体。
 *
 * 日期必须按**投递时区**算，不是系统时区：`salientWakeTimeZone` 填了 UTC 而机器在上海时，
 * 用系统墙钟得到的「今天」比配置时区早一天，今天 09:00(UTC) 明明还没到也会被当成已过而静默跳过。
 * 载体 Date 只用来喂 `salientDateFires`/`salientDaysAhead`（它们读 getMonth/getDate），正午锚点
 * 避开夏令时在午夜附近造出的「这一天不存在 00:00」。
 */
export function dayInZone(instant, zone, offsetDays = 0) {
  const w = wallParts(instant, zone)
  const day = new Date(w.year, w.month - 1, w.day + offsetDays, 12, 0, 0, 0)
  return { day, date: `${day.getFullYear()}-${pad2(day.getMonth() + 1)}-${pad2(day.getDate())}` }
}

/**
 * 「该时区的 dateKey hour」对应的绝对毫秒。先把它当 UTC 猜一次，再用该时区在那个瞬间的偏移
 * 修正；迭代到不动为止（DST 跳变时第二次才收敛），三次是上限兜底。
 * 严格未来判断必须用它：宿主要按 `at.time_zone` 解释日期与时分。
 */
export function instantInZone(dateKey, hour, zone) {
  const [year, month, day] = String(dateKey).split('-').map(Number)
  const [hh, mm] = String(hour).split(':').map(Number)
  const target = Date.UTC(year, month - 1, day, hh, mm, 0, 0)
  if (!Number.isFinite(target)) return NaN
  let instant = target
  for (let i = 0; i < 3; i += 1) {
    const w = wallParts(instant, zone)
    const offset = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - instant
    const next = target - offset
    if (next === instant) break
    instant = next
  }
  return instant
}

// 时区：显式配置优先，空串跟随系统。空或无效一律返回 null —— 少一条提醒，不是把
// 宿主的时间算错。
function resolveZone(settings) {
  const configured = typeof settings?.salientWakeTimeZone === 'string' ? settings.salientWakeTimeZone.trim() : ''
  let zone = configured
  if (!zone) {
    try { zone = String(Intl.DateTimeFormat().resolvedOptions().timeZone || '') } catch { zone = '' }
  }
  if (!zone) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return zone
  } catch {
    return null
  }
}

function resolveHour(settings) {
  const hour = String(settings?.salientWakeHour ?? '')
  if (HOUR_RE.test(hour)) return { hour, fallback: false }
  return { hour: DEFAULT_HOUR, fallback: true }
}

// 宿主会把这些拒绝原样抛成 `ScheduleInputError`（本地服务）或带 details 的
// `RemoteError`（远程传输），两边的 code 位置不同，所以逐个探。
function scheduleErrorCode(error) {
  for (const value of [error?.code, error?.details?.code, error?.data?.code]) {
    if (typeof value === 'string' && value) return value
  }
  const text = String(error?.message || error || '')
  return KNOWN_CODES.find((code) => text.includes(code)) || ''
}

function safeTitle(entry) {
  // 标题进的是另一回合的开场白：压平换行，别让一条记忆在 prompt 里伪造出新的行。
  const text = String(entry?.title || '').replace(/\s+/g, ' ').trim()
  return (text || '(untitled)').slice(0, 120)
}

// 相对"投递日"的措辞：ahead 0 = 今天，ahead 1 = 明天（保留提前一天的语义）。
// 年度日期只在当天触发，因此永远是"今天"。
function whenLabel(entry, day) {
  if (!isDatedSalientDate(entry?.salientDate)) return '今天'
  return salientDaysAhead(entry.salientDate, day) === 1 ? '明天' : '今天'
}

function entryLine({ entry }, day) {
  const when = whenLabel(entry, day)
  const annual = !isDatedSalientDate(entry?.salientDate)
  const date = annual ? `每年 ${String(entry?.salientDate || '')}` : String(entry?.salientDate || '')
  const title = safeTitle(entry)
  // 承诺和日程的语气不同，与 lib/inject.js 的 `<memory-due>` 保持一致：答应了又
  // 没做的事听起来是欠账，不是事件。正文一律不进 prompt —— 标题就是目录。
  if (entry?.openLoop === true) return `- ${when}：你之前答应过的「${title}」，就是${when}（${date}）。`
  return `- ${when}：${title}（${date}）。`
}

function buildPrompt({ dateKey, day, hits }) {
  const lines = [`[dsh-memu-memory 日期提醒] 本轮日期 ${dateKey}。今天/明天是：`]
  for (const hit of hits.slice(0, MAX_LINES)) lines.push(entryLine(hit, day))
  if (hits.length > MAX_LINES) lines.push(`- 另有 ${hits.length - MAX_LINES} 条日期记忆，用 memu_private_recall 查。`)
  // schedule 回合不触发本插件注入，所以这句是唯一的上下文来源；"不要重复"是宿主
  // at-least-once 投递的唯一缓冲。
  lines.push('这是记忆里记下的日期；需要细节用 memu_private_recall 查。若你已经说过，不要重复。')
  return lines.join('\n')
}

// 与 `buildAnniversary` 同一套门：可自动注入、非 secret 正文、对本会话可见。
function dueEntries(index, sessionId, day, nowMs) {
  const hits = []
  for (const [id, entry] of Object.entries(index?.entries || {})) {
    if (!entry || typeof entry !== 'object') continue
    if (!entry.salientDate) continue
    if (entry.visibility === 'secret') continue
    if (!salientDateFires(entry.salientDate, day)) continue
    if (!isMemoryEligible(entry, { automatic: true, now: nowMs })) continue
    try {
      if (!visibleToSession(entry, sessionId)) continue
    } catch {
      continue
    }
    hits.push({ id, entry })
  }
  hits.sort((a, b) => String(a.entry.salientDate).localeCompare(String(b.entry.salientDate))
    || String(a.entry.title || '').localeCompare(String(b.entry.title || '')))
  return hits
}

function byTitleIndex(items) {
  const map = new Map()
  for (const item of items) {
    if (!item || typeof item.title !== 'string') continue
    const list = map.get(item.title) || []
    list.push(item)
    map.set(item.title, list)
  }
  return map
}

/**
 * One sweep of the salient-date wake pass (work order E).
 *
 * Creates one host schedule task per conversation and target date, titled
 * `memu:due:<sessionId>:<YYYY-MM-DD>`, so a second sweep is a no-op. Never throws;
 * a host without the optional `schedule` service is a skip, not a failure.
 *
 * @param {object} ctx host context (`ctx.get('schedule')` is optional)
 * @param {{ now?: Date|number, log?: (message: string) => void }} [options]
 * @returns {{ skipped: string } | { created: number, cleaned: number, skipped: number, errors: number }}
 */
export async function runSalientWakePass(ctx, { now = new Date(), log = () => {} } = {}) {
  const notify = (message) => { try { log(message) } catch {} }
  const stats = { created: 0, cleaned: 0, skipped: 0, errors: 0 }
  try {
    const settings = getSettings()
    if (settings.salientWake !== 'schedule') return { skipped: 'off' }

    let schedule = null
    try { schedule = ctx?.get?.('schedule') || null } catch { schedule = null }
    if (!schedule || typeof schedule.create !== 'function' || typeof schedule.list !== 'function') {
      if (!serviceWarned) {
        serviceWarned = true
        notify('salient wake is enabled but this host exposes no schedule service; skipping')
        record({
          kind: 'wake', level: 'warn', ok: false,
          message: '日期唤醒已启用，但宿主没有 schedule 服务；本轮跳过',
          detail: { trigger: 'wake', stage: 'service' },
        })
      }
      return { skipped: 'service' }
    }

    const when = now instanceof Date ? now : new Date(now)
    if (!Number.isFinite(when.getTime())) return { skipped: 'time' }

    const zone = resolveZone(settings)
    if (!zone) {
      const key = String(settings?.salientWakeTimeZone ?? '')
      if (zoneWarnedFor !== key) {
        zoneWarnedFor = key
        notify(`salient wake skipped: no usable IANA time zone (configured ${JSON.stringify(key)})`)
        record({
          kind: 'wake', level: 'warn', ok: false,
          message: '日期唤醒已跳过：时区为空或无效',
          detail: { trigger: 'wake', stage: 'timezone', zone: key || null },
        })
      }
      return { skipped: 'timezone' }
    }

    const { hour, fallback } = resolveHour(settings)
    if (fallback) notify(`salient wake: invalid salientWakeHour ${JSON.stringify(settings?.salientWakeHour)}; using ${DEFAULT_HOUR}`)

    // 先把"要提醒什么"算完：没有会话需要提醒时，一次宿主调用都不发。
    const today = dayInZone(when.getTime(), zone, 0)
    const tomorrow = dayInZone(when.getTime(), zone, 1)
    const nowMs = when.getTime()
    const plans = []
    for (const binding of listSessionBindings()) {
      const sessionId = binding?.sessionId
      if (!sessionId || !binding.libraryId) continue
      if (binding.useLibrary === false) continue
      try {
        if (!effectiveScope(binding).useLibrary) continue
      } catch {
        continue
      }
      let index
      try {
        index = loadPrivateIndex(binding.libraryId)
      } catch (error) {
        // 库没了/索引坏了：这一个会话跳过，其他会话照跑。
        stats.errors += 1
        const message = String(error?.message || error)
        notify(`salient wake: cannot read library ${binding.libraryId}: ${message}`)
        record({
          kind: 'wake', scope: 'private', sessionId, libraryId: binding.libraryId, level: 'warn', ok: false,
          message: '日期唤醒：读取记忆库失败：' + message,
          detail: { trigger: 'wake', stage: 'index' },
        })
        continue
      }
      for (const target of [today, tomorrow]) {
        const hits = dueEntries(index, sessionId, target.day, nowMs)
        if (hits.length === 0) continue
        plans.push({ sessionId, libraryId: binding.libraryId, target: { ...target, hits } })
      }
    }
    if (plans.length === 0) return stats

    let items = []
    try {
      const page = await schedule.list({ limit: LIST_LIMIT })
      items = Array.isArray(page?.items) ? page.items : []
    } catch (error) {
      const message = String(error?.message || error)
      stats.errors += 1
      notify(`salient wake: schedule.list failed: ${message}`)
      record({
        kind: 'wake', level: 'warn', ok: false,
        message: '日期唤醒：读取定时任务失败：' + message,
        detail: { trigger: 'wake', stage: 'list', code: scheduleErrorCode(error) || null },
      })
      return stats
    }
    const byTitle = byTitleIndex(items)

    for (const plan of plans) {
      const { sessionId, libraryId, target } = plan
      const title = `memu:due:${sessionId}:${target.date}`
      const existing = byTitle.get(title) || []
      // ended 的任务说明这一天的投递已经发生过（at-least-once），清掉即可，不再补建。
      const ended = existing.filter((item) => item?.status === 'ended')
      for (const item of ended) {
        if (!item?.id) continue
        try {
          await schedule.edit({ id: item.id, action: 'delete' })
          stats.cleaned += 1
          notify(`salient wake: removed ended task ${item.id} (${title})`)
        } catch (error) {
          const message = String(error?.message || error)
          stats.errors += 1
          notify(`salient wake: could not remove ended task ${item.id}: ${message}`)
          record({
            kind: 'wake', scope: 'private', sessionId, libraryId, level: 'warn', ok: false,
            message: '日期唤醒：清理已结束任务失败：' + message,
            detail: { trigger: 'wake', stage: 'cleanup', title, code: scheduleErrorCode(error) || null },
          })
        }
      }
      // active 是幂等的证据；paused 是用户的显式暂停，绝不擅自恢复。
      if (existing.some((item) => item?.status === 'active') || existing.some((item) => item?.status === 'paused')) {
        stats.skipped += 1
        continue
      }
      if (ended.length > 0) {
        stats.skipped += 1
        continue
      }
      // 严格未来：今天的 09:00 已经过去就不排今天（被动注入仍然会提），明天照排。
      // 严格未来：按**投递时区**判断这一刻有没有过去。今天的 09:00 已经过去就不排今天
      // （被动注入仍然会提），明天照排。
      if (!(instantInZone(target.date, hour, zone) > when.getTime())) {
        stats.skipped += 1
        continue
      }
      const prompt = buildPrompt({ dateKey: target.date, day: target.day, hits: target.hits })
      try {
        const created = await schedule.create({
          title,
          prompt,
          timing: { kind: 'at', at: { date: target.date, time: hour, time_zone: zone } },
          target: { kind: 'session', sessionId },
        })
        stats.created += 1
        byTitle.set(title, [...existing, created || { title, status: 'active' }])
        notify(`salient wake: scheduled ${title} at ${target.date} ${hour} ${zone}`)
        record({
          kind: 'wake', scope: 'private', sessionId, libraryId, ok: true,
          message: `日期唤醒已排程：${target.date} ${hour}（${target.hits.length} 条）`,
          detail: {
            trigger: 'wake', stage: 'create', date: target.date, hour, zone,
            ids: target.hits.map((hit) => hit.id).slice(0, 20), taskId: created?.id || null,
          },
        })
      } catch (error) {
        const code = scheduleErrorCode(error)
        const message = String(error?.message || error)
        if (SKIP_CODES.has(code)) {
          stats.skipped += 1
          notify(`salient wake: ${title} skipped (${code})`)
          record({
            kind: 'wake', scope: 'private', sessionId, libraryId, ok: true,
            message: `日期唤醒跳过（${code}）：该目标不收 schedule 投递`,
            detail: { trigger: 'wake', stage: 'create', title, code },
          })
        } else {
          stats.errors += 1
          notify(`salient wake: ${title} failed: ${message}`)
          record({
            kind: 'wake', scope: 'private', sessionId, libraryId, level: 'warn', ok: false,
            message: '日期唤醒排程失败：' + message,
            detail: { trigger: 'wake', stage: 'create', title, code: code || null },
          })
        }
      }
    }
    return stats
  } catch (error) {
    // 兜底：这个 pass 的最后一道保险。循环里的每一步已经各自 try 过，走到这里说明
    // 是没预料到的形状（例如 state.json 读到一半坏了），不能让 cycle 的 await 炸掉。
    stats.errors += 1
    notify(`salient wake pass failed: ${error?.message || error}`)
    record({
      kind: 'wake', level: 'warn', ok: false,
      message: '日期唤醒整体失败：' + String(error?.message || error),
      detail: { trigger: 'wake', stage: 'pass' },
    })
    return stats
  }
}
