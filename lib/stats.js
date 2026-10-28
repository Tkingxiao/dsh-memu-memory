// Per-day counters for one library. A sidecar on purpose: statistics are
// disposable, so a bad read or a half-written file must never touch the memory
// index (AGENTS §2.3 separates the two deliberately). `keptDays` rolls forward;
// no timer runs — every bump trims.
//
// Nothing here throws. A counter that cannot be written is a lost number, not a
// failed memory write.
import fs from 'node:fs'
import path from 'node:path'
import { indexDir, readJsonStrict, writeJson, withFileLock, warn, isSafeId } from './paths.js'

export const STATS_KEPT_DAYS = 90
export const STATS_KINDS = ['written', 'injected', 'recalled', 'archived']

export function statsPath(libraryId) {
  if (!isSafeId(libraryId)) throw new Error('invalid library id')
  return path.join(indexDir(), `${libraryId}.stats.json`)
}

function emptyCounter() {
  return { written: 0, injected: 0, recalled: 0, archived: 0 }
}

function sanitize(raw) {
  const counters = {}
  const days = raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object' ? raw.days : {}
  for (const [key, value] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
    if (!value || typeof value !== 'object') continue
    const row = {}
    let any = false
    for (const kind of STATS_KINDS) {
      const n = Number(value[kind])
      if (Number.isFinite(n) && n > 0) { row[kind] = Math.floor(n); any = true } else row[kind] = 0
    }
    if (any) counters[key] = row
  }
  return counters
}

/**
 * `available: false` means the file exists but could not be read. The page says so
 * instead of drawing a confident zero; the bytes are left alone.
 */
export function loadStats(libraryId) {
  const file = statsPath(libraryId)
  try {
    const result = readJsonStrict(file)
    if (result.missing) return { available: true, days: {}, keptDays: STATS_KEPT_DAYS, missing: true }
    if (!result.ok) return { available: false, days: {}, keptDays: STATS_KEPT_DAYS, error: result.error }
    const keptDays = Math.min(STATS_KEPT_DAYS, Math.max(1, Number(result.value?.keptDays) || STATS_KEPT_DAYS))
    return { available: true, days: sanitize(result.value), keptDays }
  } catch {
    return { available: false, days: {}, keptDays: STATS_KEPT_DAYS }
  }
}

function dayKey(now) {
  const date = new Date(now)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function keepWindow(days, keptDays) {
  const keys = Object.keys(days).sort()
  if (keys.length <= keptDays) return days
  const kept = {}
  for (const key of keys.slice(keys.length - keptDays)) kept[key] = days[key]
  return kept
}

/**
 * `kind` is one of STATS_KINDS; `delta` is clamped to a small positive integer so a
 * bug cannot write a nonsense count. Safe to call on a hot path.
 */
export function bumpStats(libraryId, kind, delta = 1, now = Date.now()) {
  if (!libraryId || !STATS_KINDS.includes(kind)) return false
  const n = Math.floor(Number(delta))
  if (!Number.isFinite(n) || n <= 0) return false
  try {
    return withFileLock(statsPath(libraryId), () => {
    const current = loadStats(libraryId)
    if (!current.available) return false
    const days = { ...current.days }
    const key = dayKey(now)
    const row = { ...emptyCounter(), ...(days[key] || {}) }
    row[kind] += n
    days[key] = row
    writeJson(statsPath(libraryId), {
      version: 1,
      keptDays: STATS_KEPT_DAYS,
      days: keepWindow(days, STATS_KEPT_DAYS),
    })
    return true
    })
  } catch (error) {
    try { warn(`stats bump failed for ${libraryId}: ${error?.message || error}`) } catch {}
    return false
  }
}

const DAY_MS = 86_400_000

function dayStart(now) {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date
}

/** The last `days` local dates, oldest first, zero-filled. */
function dateSeries(days, now) {
  const out = []
  const start = dayStart(now)
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() - i)
    out.push(dayKey(d))
  }
  return out
}

function daysSince(iso, now) {
  const at = Date.parse(String(iso || ''))
  if (!Number.isFinite(at)) return null
  return Math.max(0, Math.floor((now - at) / DAY_MS))
}

function live(entry) {
  return entry && !['archived', 'suppressed', 'expired', 'pending_review', 'superseded'].includes(entry.status)
    && (!entry.expiresAt || Date.parse(entry.expiresAt) > Date.now())
}

/**
 * The whole statistics page in one read: the daily series, the health block, the
 * scatter, and the 7-day write/read ratio. `strengthOf` is injected because decay
 * lives in memory.js and stats must not import the memory layer back.
 */
export function statsView({ libraryId, entries = {}, days = 30, now = Date.now(), strengthOf = null }) {
  const stats = loadStats(libraryId)
  const windowDays = Math.max(1, Math.min(STATS_KEPT_DAYS, Math.floor(Number(days) || 30)))
  const keptDays = stats.keptDays || STATS_KEPT_DAYS
  const series = dateSeries(Math.min(windowDays, keptDays), now).map((date) => ({
    date,
    ...emptyCounter(),
    ...(stats.days[date] || {}),
  }))

  const all = Object.entries(entries || {})
  const alive = all.filter(([, entry]) => live(entry))
  const archived = all.filter(([, entry]) => entry?.status === 'archived')
  const pendingReview = all.filter(([, entry]) => entry?.status === 'pending_review')
  const marginalized = alive.filter(([, entry]) => entry?.marginalized === true)
  const strengths = alive
    .map(([, entry]) => {
      try {
        const value = strengthOf ? Number(strengthOf(entry)) : Number(entry?.strength)
        return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null
      } catch {
        return null
      }
    })
    .filter((value) => value !== null)
  const avgStrength = strengths.length === 0
    ? 0
    : Math.round((strengths.reduce((sum, value) => sum + value, 0) / strengths.length) * 100) / 100

  const touches = alive.map(([id, entry]) => {
    const created = Date.parse(String(entry?.createdAt || '')) || null
    const updated = Date.parse(String(entry?.updatedAt || '')) || null
    const lastAccess = Date.parse(String(entry?.lastAccessAt || '')) || null
    const lastInject = Date.parse(String(entry?.lastInjectAt || '')) || null
    const lastTouch = Math.max(created || 0, updated || 0, lastAccess || 0, lastInject || 0) || null
    return {
      id,
      title: String(entry?.title || ''),
      layer: String(entry?.layer || 'long_term'),
      createdAt: entry?.createdAt || null,
      lastAccessAt: entry?.lastAccessAt || null,
      lastInjectAt: entry?.lastInjectAt || null,
      ageDays: created ? Math.max(0, Math.floor((now - created) / DAY_MS)) : null,
      daysSinceTouch: lastTouch ? Math.max(0, Math.floor((now - lastTouch) / DAY_MS)) : null,
      injectCount: Number(entry?.injectCount) || 0,
      accessCount: Number(entry?.accessCount) || 0,
    }
  })

  // The scatter wants one point per memory; the cap keeps the page light on a big
  // library. Dropping the quietest points first keeps the interesting half.
  const distributionTotal = touches.length
  const distribution = [...touches]
    .sort((a, b) => b.injectCount - a.injectCount || (b.ageDays || 0) - (a.ageDays || 0))
    .slice(0, 300)

  // "Longest not thought of" is the archive shortlist: live entries whose last
  // touch — written, recalled, or injected — is furthest in the past.
  const stale = [...touches]
    .filter((row) => row.daysSinceTouch !== null)
    .sort((a, b) => b.daysSinceTouch - a.daysSinceTouch)
    .slice(0, 5)

  const ratioWindow = series.slice(-Math.min(7, series.length))
  const ratio = ratioWindow.reduce((acc, row) => ({
    written: acc.written + row.written,
    injected: acc.injected + row.injected,
  }), { written: 0, injected: 0 })

  return {
    libraryId,
    available: stats.available,
    keptDays,
    windowDays: series.length,
    days: series,
    totals: series.reduce((acc, row) => ({
      written: acc.written + row.written,
      injected: acc.injected + row.injected,
      recalled: acc.recalled + row.recalled,
      archived: acc.archived + row.archived,
    }), emptyCounter()),
    ratio: {
      windowDays: ratioWindow.length,
      written: ratio.written,
      injected: ratio.injected,
    },
    health: {
      total: all.length,
      active: alive.length,
      marginalized: marginalized.length,
      archived: archived.length,
      pendingReview: pendingReview.length,
      avgStrength,
    },
    distribution: distribution.map(({ id, title, layer, ageDays, injectCount, accessCount }) => ({
      id, title, layer, ageDays, injectCount, accessCount,
    })),
    distributionTotal,
    stale,
  }
}
