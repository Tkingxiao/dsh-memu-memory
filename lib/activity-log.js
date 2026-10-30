import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { logsDir, ensureDir, redactSecrets, warn } from './paths.js'

// 记忆链路的活动日志：召回、写入、整理、向量。用途是回答"刚才那一下到底走了哪条路、
// 召回/写入了什么、为什么没写成"，而不是给开发者看堆栈。
//
// 三条硬约束：
// 1. 永不抛错。日志坏了不能把召回/写入一起弄坏（fail-open），失败只 warn 一次。
// 2. 永不无限增长。内存里保留最近 MAX_ENTRIES 条，文件超过 MAX_FILE_BYTES 时重写成
//    最近一半；这是本机诊断用的环形日志，不是审计材料。
// 3. 出盘前脱敏。message 与 detail 都过 redactSecrets；detail 只留诊断需要的字段，
//    正文最多 200 字符（召回查询、记忆标题），足够定位问题又不把整段对话抄进日志。

export const ACTIVITY_KINDS = Object.freeze(['recall', 'write', 'consolidate', 'curate', 'vector', 'error', 'system', 'check'])
const MAX_ENTRIES = 2000
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_MESSAGE_CHARS = 300
const MAX_DETAIL_CHARS = 4000
const MAX_QUERY_CHARS = 200

let cache = null
let loadWarned = false
let writeWarned = false

function activityFile() {
  return path.join(logsDir(), 'activity.jsonl')
}

function clamp(value, max) {
  const text = String(value ?? '')
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

function safeDetail(value) {
  if (value === undefined || value === null) return null
  let text
  try { text = JSON.stringify(value) } catch { text = JSON.stringify({ note: 'detail is not serializable' }) }
  text = redactSecrets(text)
  if (text.length > MAX_DETAIL_CHARS) text = text.slice(0, MAX_DETAIL_CHARS - 1) + '…'
  try { return JSON.parse(text) } catch { return { text: text.slice(0, MAX_DETAIL_CHARS - 20) } }
}

function normalize(event = {}) {
  const kind = ACTIVITY_KINDS.includes(event.kind) ? event.kind : 'system'
  const level = ['info', 'warn', 'error'].includes(event.level) ? event.level : (event.ok === false ? 'warn' : 'info')
  const at = typeof event.at === 'string' && !Number.isNaN(Date.parse(event.at)) ? event.at : new Date().toISOString()
  const refs = Array.isArray(event.refs) ? event.refs.filter(item => typeof item === 'string' && item).slice(0, 20) : []
  return {
    id: 'act-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'),
    at,
    kind,
    level,
    scope: event.scope === 'private' || event.scope === 'global' ? event.scope : null,
    sessionId: typeof event.sessionId === 'string' ? event.sessionId : null,
    libraryId: typeof event.libraryId === 'string' ? event.libraryId : null,
    message: redactSecrets(clamp(event.message, MAX_MESSAGE_CHARS)),
    detail: safeDetail(event.detail),
    refs,
    ok: event.ok !== false,
  }
}

function parseLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object' && typeof value.at === 'string') out.push(value)
    } catch {}
  }
  return out
}

function load() {
  if (cache) return cache
  cache = []
  try {
    const file = activityFile()
    if (fs.existsSync(file)) cache = parseLines(fs.readFileSync(file, 'utf8')).slice(-MAX_ENTRIES)
  } catch (error) {
    if (!loadWarned) {
      loadWarned = true
      try { warn('activity log could not be read: ' + (error?.message || error) + ' (recall and writes continue; the log starts empty)') } catch {}
    }
    cache = []
  }
  return cache
}

function rewrite(entries) {
  const file = activityFile()
  ensureDir(path.dirname(file))
  const temp = file + '.tmp-' + process.pid
  fs.writeFileSync(temp, entries.map(entry => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''), 'utf8')
  fs.renameSync(temp, file)
}

/** 记录一条活动。永不抛错；返回写入的条目（失败时返回 null）。 */
export function record(event) {
  try {
    const entry = normalize(event)
    const entries = load()
    entries.push(entry)
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
    try {
      const file = activityFile()
      ensureDir(path.dirname(file))
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8')
      let size = 0
      try { size = fs.statSync(file).size } catch {}
      if (size > MAX_FILE_BYTES) rewrite(entries.slice(-Math.floor(MAX_ENTRIES / 2)))
    } catch (error) {
      if (!writeWarned) {
        writeWarned = true
        try { warn('activity log could not be written: ' + (error?.message || error) + ' (memory operations are unaffected)') } catch {}
      }
    }
    return entry
  } catch {
    return null
  }
}

/**
 * 最近的活动，最新在前。`q` 只做字面包含匹配（大小写不敏感），不解释正则：
 * 这是给人看的筛选框，不是查询语言。
 */
export function listEvents({ limit = 200, kind = null, level = null, scope = null, sessionId = null, since = null, q = null } = {}) {
  const wanted = ACTIVITY_KINDS.includes(kind) ? kind : null
  const wantedLevel = ['info', 'warn', 'error'].includes(level) ? level : null
  const sinceTime = typeof since === 'string' && !Number.isNaN(Date.parse(since)) ? Date.parse(since) : null
  const needle = typeof q === 'string' && q.trim() ? q.trim().toLowerCase() : null
  const count = Math.max(1, Math.min(MAX_ENTRIES, Number(limit) || 200))
  const rows = []
  const entries = load()
  for (let index = entries.length - 1; index >= 0 && rows.length < count; index -= 1) {
    const entry = entries[index]
    if (wanted && entry.kind !== wanted) continue
    if (wantedLevel && entry.level !== wantedLevel) continue
    if (scope && entry.scope !== scope) continue
    if (sessionId && entry.sessionId !== sessionId) continue
    if (sinceTime && (Date.parse(entry.at) || 0) < sinceTime) continue
    if (needle) {
      const haystack = (entry.message + ' ' + JSON.stringify(entry.detail || {}) + ' ' + (entry.refs || []).join(' ')).toLowerCase()
      if (!haystack.includes(needle)) continue
    }
    rows.push(entry)
  }
  return rows
}

export function logStats() {
  const entries = load()
  const counts = {}
  for (const entry of entries) counts[entry.kind] = (counts[entry.kind] || 0) + 1
  let bytes = 0
  try { bytes = fs.statSync(activityFile()).size } catch {}
  return { total: entries.length, bytes, counts, file: activityFile(), capped: MAX_ENTRIES, maxBytes: MAX_FILE_BYTES }
}

/**
 * 清空日志。无参 = 全部清掉（显式操作，不是自动裁剪）；带过滤 = 只删匹配行
 * （整理失败提醒的"清除失败记录"用：{ kind: 'consolidate', ok: false }）。
 * 返回删除条数。永不抛错。
 */
export function clearEvents(filter = null) {
  const entries = load()
  const matches = (entry) => {
    if (!filter) return true
    if (filter.kind && entry.kind !== filter.kind) return false
    if (typeof filter.ok === 'boolean' && entry.ok !== filter.ok) return false
    return true
  }
  const kept = filter ? entries.filter(entry => !matches(entry)) : []
  let removed = entries.length - kept.length
  try {
    rewrite(kept)
    cache = kept
  } catch (error) {
    // 落盘失败就不动缓存：文件是权威，下次读盘仍是原样，别让内存和磁盘各说各话。
    removed = 0
    try { warn('activity log could not be cleared: ' + (error?.message || error)) } catch {}
  }
  return { ok: true, removed }
}

/** 导出为可直接贴进 issue 的 JSONL 文本。 */
export function exportEvents(options = {}) {
  return listEvents({ limit: Math.min(MAX_ENTRIES, Number(options.limit) || MAX_ENTRIES), ...options })
    .map(entry => JSON.stringify(entry))
    .join('\n')
}

/** 测试用：丢掉进程内缓存，下一次调用重新读盘。 */
export function resetActivityLogCache() {
  cache = null
  loadWarned = false
  writeWarned = false
}

// 一个自动裁剪的便捷入口：`query` 是召回/整理里最常要看的东西，统一截断。
export function clipQuery(value) {
  return clamp(redactSecrets(String(value ?? '')), MAX_QUERY_CHARS)
}
