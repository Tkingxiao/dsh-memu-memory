import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { dataDir, ensureDir, redactSecrets, stamp, setLockEventSink } from './paths.js'

// 诊断面（§15）：插件内部的失败从"只有一行 warn"变成一条可检索、可修复的记录。
//
// 刻意与 `logs/activity.jsonl` 分开：activity 是"记忆运行日志"（有 kind/ok/降级语义，
// 展示在 WebUI 日志页）；这里是"插件内部故障档案"，只放错误/警告 + 修复线索，独立页面
// 展示、独立清理。manifest 摘要、运行时目录、死锁这类内部报错**不进**日志页——那条
// 通道已经够吵，而诊断需要的是"为什么坏、怎么修、能不能一键修"。
//
// 另一个刻意的取舍：诊断写入永远不抛错、不 warn（会递归），失败就静默放弃。诊断自己
// 坏掉不能连累记忆主路径。
const MAX_BYTES = 2 * 1024 * 1024
const RING_LIMIT = 500
const DEDUPE_WINDOW_MS = 60_000
const MAX_MESSAGE = 2000
const LEVELS = new Set(['error', 'warn', 'info'])

export function diagnosticsDir() {
  return path.join(dataDir(), 'diagnostics')
}

function eventsFile() {
  return path.join(diagnosticsDir(), 'events.jsonl')
}

function rotatedFile() {
  return path.join(diagnosticsDir(), 'events.1.jsonl')
}

function ackFile() {
  return path.join(diagnosticsDir(), 'acknowledged.json')
}

// 进程内环形缓冲：最新在后。落盘是为了跨重启仍能回答"上次为什么坏"，内存是为了
// 页面轮询不必每次读盘。
let ring = []
let loaded = false
let bytesCache = null
const lastByKey = new Map()
const ack = new Map()
let ackLoaded = false

function keyOf(entry) {
  return [entry.scope, entry.code, entry.message].join('\u0000')
}

/** 稳定短哈希：确认状态按"同一类问题"记账，不按随机事件 id。 */
export function diagnosticKeyHash(entry) {
  return crypto.createHash('sha256').update([entry?.scope, entry?.code, entry?.message].join('\u0000')).digest('hex').slice(0, 16)
}

function pruneValue(value, depth) {
  if (depth > 3) return '[depth]'
  if (typeof value === 'string') return redactSecrets(value).slice(0, 2000)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (value === undefined) return null
  if (Array.isArray(value)) return value.slice(0, 20).map(item => pruneValue(item, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).slice(0, 40)) out[key] = pruneValue(value[key], depth + 1)
    return out
  }
  return String(value)
}

/** 只保留可 JSON 化、已脱敏、已限长的 detail。 */
export function shapeDetail(detail) {
  if (detail === undefined || detail === null) return null
  try {
    const pruned = pruneValue(detail, 0)
    return pruned && typeof pruned === 'object' ? pruned : { value: pruned }
  } catch {
    return null
  }
}

function normalize(input) {
  if (!input || typeof input !== 'object') return null
  const level = LEVELS.has(input.level) ? input.level : 'error'
  const scope = String(input.scope || 'plugin').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'plugin'
  const code = String(input.code || 'MEMU_DIAGNOSTIC').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 64) || 'MEMU_DIAGNOSTIC'
  const rawMessage = String(input.message ?? '').trim()
  const message = (redactSecrets(rawMessage || code)).slice(0, MAX_MESSAGE)
  const at = stamp()
  return {
    id: crypto.randomUUID(),
    at,
    lastAt: at,
    level,
    scope,
    code,
    message,
    detail: shapeDetail(input.detail),
    hint: input.hint ? redactSecrets(String(input.hint)).slice(0, 1000) : null,
    repair: input.repair ? String(input.repair).slice(0, 64) : null,
    manual: input.manual === true,
    // 启动弹窗只看 alert 条目：error 默认弹，warn 只有明确要求才弹（避免一开机就一屏）。
    alert: input.alert === undefined ? level === 'error' : input.alert === true,
    count: 1,
    source: input.source ? String(input.source).slice(0, 60) : null,
  }
}

function fileBytes() {
  if (bytesCache !== null) return bytesCache
  try { bytesCache = fs.statSync(eventsFile()).size } catch { bytesCache = 0 }
  return bytesCache
}

function rotateIfNeeded() {
  if (fileBytes() <= MAX_BYTES) return
  try { fs.renameSync(eventsFile(), rotatedFile()) } catch {}
  bytesCache = 0
}

function appendLine(entry) {
  ensureDir(diagnosticsDir())
  rotateIfNeeded()
  const line = JSON.stringify({ ...entry, lastAt: entry.lastAt }) + '\n'
  fs.writeFileSync(eventsFile(), line, { flag: 'a', mode: 0o600 })
  bytesCache = null
}

/**
 * 写一条诊断。同一 (scope, code, message) 在 60 秒内重复只在内存里记 count，
 * 不再追加行——一次召回风暴不该把 2MB 的档案写完。
 */
export function recordDiagnostic(input) {
  try {
    const entry = normalize(input)
    if (!entry) return null
    const key = keyOf(entry)
    const nowMs = Date.now()
    const last = lastByKey.get(key)
    if (last && nowMs - last.lastAtMs < DEDUPE_WINDOW_MS) {
      last.count += 1
      last.lastAt = entry.at
      last.lastAtMs = nowMs
      // 内存里的这条已经是环形缓冲的一员（引用），页面下一轮就会看到 count 变大。
      return last
    }
    entry.lastAtMs = nowMs
    appendLine(entry)
    ring.push(entry)
    while (ring.length > RING_LIMIT) ring.shift()
    lastByKey.set(key, entry)
    return entry
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 错误归类

/**
 * 已知故障码 → 诊断语义（范围、修复动作、修复提示）。
 *
 * 这张表是"诊断信息"的核心：同一个错误在日志里只是字符串，在这里才回答
 * "这是哪一层坏了、能不能自动修、修之前会不会丢数据"。
 */
const KNOWN_CODES = Object.freeze({
  VECTOR_PROFILE_MANIFEST_CHANGED: {
    scope: 'vector',
    repair: 'resign-vector-profile',
    hint: 'The catalog manifest of the active embedding profile changed after it was recorded. When only mirror metadata (runtime/sources) moved, re-signing keeps existing vectors usable; a real artifact change requires a rebuild.',
  },
  VECTOR_PROFILE_FINGERPRINT_MISMATCH: {
    scope: 'vector',
    repair: 'rebuild-vector-index',
    manual: true,
    hint: 'The vector space itself changed (dimension/pooling/prefixes/files). Existing vectors cannot be reused; rebuild the local vector index from the memory index.',
  },
  VECTOR_PROFILE_UNKNOWN: {
    scope: 'vector',
    repair: 'resign-vector-profile',
    hint: 'The active catalog id is no longer defined by this plugin version. Switch the vector profile or reinstall the embedding model bundle.',
  },
  VECTOR_PROFILE_PENDING: {
    scope: 'vector',
    manual: true,
    hint: 'The catalog entry has no verified artifact yet. Download and verify the model before activating it.',
  },
  VECTOR_ACTIVE_CORRUPT: {
    scope: 'vector',
    repair: 'repoint-runtime-dir',
    manual: true,
    hint: 'index/vector-active.json is not valid JSON. It is never overwritten automatically; restore it from index/vector-active.json.bak-* or delete it to re-activate a profile.',
  },
  LOCAL_VECTOR_RUNTIME_UNAVAILABLE: {
    scope: 'vector',
    repair: 'repoint-runtime-dir',
    hint: 'The recorded runtime directory does not contain the pinned onnxruntime artifacts. Point the profile at a complete runtime directory under downloads/runtime instead of downloading at run time.',
  },
  LOCAL_VECTOR_MANIFEST_INCOMPLETE: {
    scope: 'vector',
    repair: 'resign-vector-profile',
    hint: 'The active profile lost its stable model id or dimension; re-signing restores both from the catalog.',
  },
  LOCAL_VECTOR_WORKER_EXITED: {
    scope: 'vector',
    repair: 'reinstall-runtime',
    hint: 'The embedding worker process exited before reporting ready. The last stderr lines are captured under detail.stderrTail; a missing or mismatched native module is the usual cause.',
  },
  LOCAL_VECTOR_BAD_READY: {
    scope: 'vector',
    repair: 'reinstall-runtime',
    hint: 'The worker answered but its readiness line did not match the active profile. Reinstall the runtime so the worker and the profile agree.',
  },
  LOCAL_VECTOR_SPAWN_FAILED: {
    scope: 'vector',
    repair: 'reinstall-runtime',
    hint: 'The worker could not be spawned at all (missing interpreter or blocked executable).',
  },
  LOCAL_VECTOR_START_TIMEOUT: {
    scope: 'vector',
    hint: 'The worker never became ready within the boot timeout. Recall falls back to lexical until it does.',
  },
  LOCAL_VECTOR_RESTART_FUSED: {
    scope: 'vector',
    hint: 'The worker crashed repeatedly inside the restart window and the fuse tripped. Wait for the cooldown, then run the environment check to find the cause.',
  },
  DSH_MEMU_STORE_BUSY: {
    scope: 'store',
    repair: 'release-stale-locks',
    hint: 'A *.lock file is held by a process that no longer exists (or holds an unparseable payload). Releasing stale locks is safe: an owner that is still alive is never touched.',
  },
  ENGINE_MISSING: {
    scope: 'engine',
    repair: 'reinstall-engine',
    hint: 'The managed Python engine directory is gone or empty. Reinstalling rebuilds it under engine/<version>/venv.',
  },
  ENGINE_BROKEN: {
    scope: 'engine',
    repair: 'reinstall-engine',
    hint: 'The engine venv exists but cannot import memu. Reinstalling rebuilds the venv and keeps a backup first.',
  },
  ENGINE_VERSION_MISMATCH: {
    scope: 'engine',
    repair: 'reinstall-engine',
    hint: 'The installed engine is not the version this plugin requires; the next bootstrap switches it.',
  },
})

export function classifyError(error) {
  const code = String(error?.code || error?.name || 'MEMU_ERROR').toUpperCase()
  const known = KNOWN_CODES[code] || null
  const message = String(error?.message || error || 'unknown failure')
  const detail = {}
  if (error?.detail && typeof error.detail === 'object') Object.assign(detail, error.detail)
  // VectorStateError 把 extra 摊在自己身上；只挑诊断需要的几个字段，别把整个 error 塞进去。
  for (const field of ['expected', 'actual', 'changedFields', 'catalogId', 'file', 'lockPath', 'owner', 'ageMs', 'libraryId', 'sessionId', 'stderrTail']) {
    if (error?.[field] !== undefined) detail[field] = error[field]
  }
  return {
    scope: known?.scope || 'plugin',
    code,
    message,
    detail: Object.keys(detail).length ? detail : null,
    hint: known?.hint || null,
    repair: known?.repair || null,
    manual: known?.manual === true,
  }
}

/** 记一个异常；未知错误也记（诊断页要能看见"没归类"的故障）。 */
export function recordErrorDiagnostic(error, context = {}) {
  const classified = classifyError(error)
  return recordDiagnostic({
    ...classified,
    level: context.level || 'error',
    source: context.source || null,
    detail: { ...(classified.detail || {}), ...(context.detail || {}) },
    hint: context.hint || classified.hint,
    repair: context.repair || classified.repair,
    message: context.message || classified.message,
  })
}

// ---------------------------------------------------------------- 读取

function parseLine(line) {
  const text = String(line || '').trim()
  if (!text) return null
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || !value.code) return null
    return {
      id: value.id || crypto.randomUUID(),
      at: value.at || stamp(),
      lastAt: value.lastAt || value.at || stamp(),
      level: LEVELS.has(value.level) ? value.level : 'error',
      scope: String(value.scope || 'plugin'),
      code: String(value.code),
      message: String(value.message || value.code),
      detail: value.detail ?? null,
      hint: value.hint ?? null,
      repair: value.repair ?? null,
      manual: value.manual === true,
      alert: value.alert === true,
      count: Number.isFinite(value.count) && value.count > 0 ? value.count : 1,
      source: value.source ?? null,
    }
  } catch {
    return null
  }
}

function readTail(file, maxBytes = 512 * 1024) {
  try {
    const stat = fs.statSync(file)
    const start = Math.max(0, stat.size - maxBytes)
    const fd = fs.openSync(file, 'r')
    try {
      const length = stat.size - start
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, start)
      return { text: buffer.toString('utf8'), truncated: start > 0 }
    } finally { fs.closeSync(fd) }
  } catch {
    return { text: '', truncated: false }
  }
}

function ensureLoaded() {
  if (loaded) return
  loaded = true
  try {
    const current = readTail(eventsFile())
    const lines = current.text.split('\n')
    // 只有真的从中间截断时才丢第一行（那半条 JSON 解析不出来，丢了也不冤）。
    // 早先这里无条件 shift：文件小到能整段读进内存时，第一行是完整的记录，
    // 却因为 split 出来的末位空串让 length > 1 而被丢掉——诊断页于是永远空白。
    if (current.truncated && lines.length > 1) lines.shift()
    const parsed = []
    for (const line of lines) {
      const entry = parseLine(line)
      if (entry) parsed.push(entry)
    }
    const rotated = readTail(rotatedFile(), 128 * 1024).text.split('\n').map(parseLine).filter(Boolean)
    ring = [...rotated, ...parsed].slice(-RING_LIMIT)
    for (const entry of ring) lastByKey.set(keyOf(entry), entry)
  } catch {
    ring = []
  }
}

function ensureAckLoaded() {
  if (ackLoaded) return
  ackLoaded = true
  try {
    const value = JSON.parse(fs.readFileSync(ackFile(), 'utf8'))
    for (const [key, count] of Object.entries(value?.counts || {})) {
      if (Number.isFinite(count)) ack.set(key, Number(count))
    }
  } catch {}
}

function persistAck() {
  try {
    ensureDir(diagnosticsDir())
    const counts = {}
    for (const [key, count] of ack.entries()) counts[key] = count
    fs.writeFileSync(ackFile(), JSON.stringify({ version: 1, counts }, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch {}
}

/** 最新在前；detail 原样返回（已脱敏、已限长）。 */
export function listDiagnostics(filter = {}) {
  ensureLoaded()
  const limit = Math.max(1, Math.min(500, Number(filter.limit) || 200))
  const level = LEVELS.has(filter.level) ? filter.level : null
  const scope = filter.scope ? String(filter.scope) : null
  const query = filter.q ? String(filter.q).toLowerCase() : null
  const since = filter.since ? Date.parse(filter.since) : null
  const counts = { error: 0, warn: 0, info: 0 }
  for (const entry of ring) counts[entry.level] = (counts[entry.level] || 0) + 1
  const items = ring
    .filter(entry => (level ? entry.level === level : true))
    .filter(entry => (scope ? entry.scope === scope : true))
    .filter(entry => (since && Number.isFinite(since) ? Date.parse(entry.lastAt || entry.at) >= since : true))
    .filter(entry => (query
      ? [entry.code, entry.message, entry.hint, entry.source, entry.scope].join(' ').toLowerCase().includes(query)
      : true))
    .slice(-limit)
    .reverse()
  return { items, total: items.length, counts, capped: ring.length >= RING_LIMIT }
}

export function diagnosticStats() {
  ensureLoaded()
  const counts = { error: 0, warn: 0, info: 0 }
  for (const entry of ring) counts[entry.level] = (counts[entry.level] || 0) + 1
  return {
    total: ring.length,
    counts,
    bytes: fileBytes(),
    maxBytes: MAX_BYTES,
    repaired: ring.filter(entry => entry.repair && entry.code === 'MEMU_DIAGNOSTIC_REPAIRED').length,
    path: diagnosticsDir(),
  }
}

/**
 * 启动弹窗要看的那几条：error 级、alert 未关，且"出现次数比上次确认时更多"。
 * 一条问题修好后不再重复弹，再次出现才弹——否则用户每天开机都要关一次同一个提示。
 */
export function diagnosticAlerts() {
  ensureLoaded()
  ensureAckLoaded()
  const grouped = new Map()
  for (const entry of ring) {
    if (!entry.alert) continue
    if (entry.level !== 'error' && entry.level !== 'warn') continue
    const key = diagnosticKeyHash(entry)
    const current = grouped.get(key)
    if (current) {
      current.count += entry.count
      if (Date.parse(entry.lastAt) > Date.parse(current.lastAt)) current.lastAt = entry.lastAt
      continue
    }
    grouped.set(key, {
      key,
      code: entry.code,
      scope: entry.scope,
      message: entry.message,
      hint: entry.hint,
      repair: entry.repair,
      manual: entry.manual,
      level: entry.level,
      count: entry.count,
      lastAt: entry.lastAt,
      acknowledged: ack.get(key) || 0,
    })
  }
  const alerts = [...grouped.values()].filter(alert => alert.count > alert.acknowledged)
  return { alerts, checkedAt: stamp() }
}

/** 确认（= 知道这件事了）。按同类问题的当前次数记账，不再弹直到它再次出现。 */
export function acknowledgeDiagnostics({ keys = [], codes = [] } = {}) {
  ensureLoaded()
  ensureAckLoaded()
  const wantKeys = new Set((Array.isArray(keys) ? keys : []).map(String))
  const wantCodes = new Set((Array.isArray(codes) ? codes : []).map(code => String(code).toUpperCase()))
  let changed = 0
  for (const entry of ring) {
    if (!entry.alert) continue
    const key = diagnosticKeyHash(entry)
    if (wantKeys.size && !wantKeys.has(key)) continue
    if (wantCodes.size && !wantCodes.has(String(entry.code).toUpperCase())) continue
    if (!wantKeys.size && !wantCodes.size) continue
    const previous = ack.get(key) || 0
    if (entry.count > previous) { ack.set(key, entry.count); changed += 1 }
  }
  if (changed) persistAck()
  return { acknowledged: changed, remaining: diagnosticAlerts().alerts.length }
}

/** 记录一次自动修复的结果——修复本身也要留痕，成功失败都算。 */
// detail 允许是字符串（修好/没修好的一句话）或对象；字符串直接展开会碎成字符键。
function detailFields(detail) {
  if (!detail) return {}
  if (typeof detail === 'string') return { message: detail }
  if (typeof detail !== 'object' || Array.isArray(detail)) return { message: String(detail) }
  return detail
}

export function recordRepair({ action, ok, detail, message }) {
  return recordDiagnostic({
    level: ok ? 'info' : 'error',
    scope: 'repair',
    code: ok ? 'MEMU_DIAGNOSTIC_REPAIRED' : 'MEMU_DIAGNOSTIC_REPAIR_FAILED',
    message: message || (ok ? `auto repair applied: ${action}` : `auto repair failed: ${action}`),
    detail: { action, ...detailFields(detail) },
    hint: ok ? null : 'The manual repair entry on the diagnostics page runs the same action; a repeated failure usually means a permission or disk problem.',
    repair: ok ? null : action,
    alert: !ok,
    source: 'repair',
  })
}

export function clearDiagnostics() {
  ensureLoaded()
  const removed = ring.length
  ring = []
  lastByKey.clear()
  ack.clear()
  ackLoaded = true
  persistAck()
  try { fs.rmSync(eventsFile(), { force: true }) } catch {}
  try { fs.rmSync(rotatedFile(), { force: true }) } catch {}
  bytesCache = 0
  return { removed }
}

// ---------------------------------------------------------------- 锁事件接线

// paths.js 不 import 本模块（否则成环），它只把锁事件扔进 sink，方向永远是单向的。
setLockEventSink(event => {
  recordDiagnostic({
    level: event?.level || 'warn',
    scope: 'store',
    code: event?.code || 'MEMU_LOCK_EVENT',
    message: event?.message || 'memory store lock event',
    detail: event?.detail || null,
    hint: event?.hint || null,
    repair: event?.repair || null,
    alert: false,
    source: 'paths.withFileLock',
  })
})
