// 承诺 / 欠账。
//
// `commitment.status` 是权威，`open_loop` 只保留做旧数据兼容：
//   open → 还没兑现；done → 已兑现；cancelled → 明确取消；expired → 过期未完成。
// due_at 接受 YYYY-MM-DD 或 ISO 时间；比较按“到期那一天”算，不按时分秒。

import { localCalendarDay } from './temporal.js'

export const COMMITMENT_STATUSES = ['open', 'done', 'cancelled', 'expired']

const DAY_MS = 86_400_000
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function cleanText(value, max) {
  if (value === undefined || value === null) return ''
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max)
}

function validDateOnly(text) {
  const match = DATE_ONLY_RE.exec(text)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1) return false
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** YYYY-MM-DD or an ISO timestamp; anything else is refused. */
export function normalizeDueAt(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  if (!text) return null
  if (DATE_ONLY_RE.test(text)) {
    if (!validDateOnly(text)) throw new Error('commitment.due_at must be YYYY-MM-DD or an ISO date/time')
    return text
  }
  const at = Date.parse(text)
  if (!Number.isFinite(at)) throw new Error('commitment.due_at must be YYYY-MM-DD or an ISO date/time')
  return new Date(at).toISOString()
}

function dueDateText(value) {
  if (!value) return null
  if (DATE_ONLY_RE.test(value)) return value
  const at = new Date(value)
  return Number.isFinite(at.getTime()) ? `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}` : null
}

function localDateKey(now) {
  return localCalendarDay(now)
}

function daysBetween(fromKey, toKey) {
  if (!fromKey || !toKey) return null
  const from = Date.UTC(...fromKey.split('-').map((part, index) => index === 1 ? Number(part) - 1 : Number(part)))
  const to = Date.UTC(...toKey.split('-').map((part, index) => index === 1 ? Number(part) - 1 : Number(part)))
  return Math.round((to - from) / DAY_MS)
}

/**
 * 归一一条承诺。显式传对象时字段错误会抛（写盘前拒绝，不静默改），
 * 读取旧数据用 commitmentOf 的宽容口径。
 */
export function normalizeCommitment(value, { fallbackAction = '', fallbackDueAt = null } = {}) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('commitment must be an object')
  const status = value.status === undefined || value.status === null || value.status === ''
    ? 'open' : String(value.status)
  if (!COMMITMENT_STATUSES.includes(status)) {
    throw new Error(`commitment.status must be ${COMMITMENT_STATUSES.join(', ')}`)
  }
  const action = cleanText(value.action ?? fallbackAction, 500)
  if (!action) throw new Error('commitment.action is required')
  const counterparty = cleanText(value.counterparty, 128) || null
  const due = value.due_at ?? value.dueAt ?? fallbackDueAt
  const dueAt = normalizeDueAt(due)
  const closedByRaw = value.closed_by ?? value.closedBy ?? null
  const evidenceRaw = value.evidence_seq ?? value.evidenceSeq ?? null
  return {
    counterparty,
    action,
    due_at: dueAt,
    status,
    closed_by: closedByRaw === null || closedByRaw === undefined || closedByRaw === ''
      ? null : String(closedByRaw).slice(0, 128),
    evidence_seq: evidenceRaw === null || evidenceRaw === undefined || evidenceRaw === ''
      ? null : (Number.isSafeInteger(Number(evidenceRaw)) ? Number(evidenceRaw) : String(evidenceRaw).slice(0, 128)),
  }
}

/** Tolerant read for stored entries; a malformed object never crashes recall. */
export function commitmentOf(entry) {
  if (!entry || typeof entry !== 'object' || !entry.commitment || typeof entry.commitment !== 'object') return null
  try {
    return normalizeCommitment(entry.commitment)
  } catch {
    return null
  }
}

/** open_loop 兼容口径：有 commitment 就看 status，没有才看旧布尔值。 */
export function isOpenThread(entry) {
  const commitment = commitmentOf(entry)
  if (commitment) return commitment.status === 'open'
  return entry?.openLoop === true
}

/** 承诺的到期日（YYYY-MM-DD）；没有 due_at 返回 null。 */
export function commitmentDueDate(entry) {
  const commitment = commitmentOf(entry)
  if (!commitment) return null
  return dueDateText(commitment.due_at)
}

/**
 * 到期状态。`dueSoon` 只覆盖今天和明天：一张每回合都出现的承诺卡会变成噪声，
 * 真正的“到期/逾期”才值得占预算。
 */
export function commitmentDueState(entryOrCommitment, { now = Date.now() } = {}) {
  const commitment = entryOrCommitment?.status && entryOrCommitment?.action
    ? entryOrCommitment
    : commitmentOf(entryOrCommitment)
  if (!commitment || commitment.status !== 'open' || !commitment.due_at) {
    return { open: commitment?.status === 'open', dueAt: null, daysUntil: null, overdue: false, dueSoon: false }
  }
  const dueAt = dueDateText(commitment.due_at)
  const daysUntil = daysBetween(localDateKey(now), dueAt)
  return {
    open: true,
    dueAt,
    daysUntil,
    overdue: daysUntil !== null && daysUntil < 0,
    dueSoon: daysUntil !== null && daysUntil <= 1,
  }
}

export { DAY_MS }
