import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { dataDir, ensureDir, warn, redactSecrets, isSafeId, shortHash, stamp } from './paths.js'
import { getSettings, getSessionBinding } from './state.js'

// T0 构件 1（设计文档 §3）：增量回合日志。
//
// 定位是纯旁路缓存，不是账本（§0 铁律 1）：每行一个宿主 turn/end 的 seq 区间，
// 记录规则与 condenseEvents 同口径（§3.1，不发明新规则）。任何失败只 warn，
// 绝不影响主会话；正确性永远由宿主转录 + 缺口重建兜底（§3.3）。
//
// 三层 caps（§3.1）：user/model 各 2000 字全保；工具行 160 字；整条记录 4000 字
// 总闸——超预算只砍 tools 行（按序装、砍尾并标注省略数），user/model 不动。

export const TURNLOG_USER_MODEL_CHARS = 2000
export const TURNLOG_TOOL_LINE_CHARS = 160
export const TURNLOG_RECORD_CHARS = 4000
export const TURNLOG_KEEP_CHARS = 200_000
export const TURNLOG_GC_DAYS = 30

const TURNLOG_SUFFIX = '.turnlog.jsonl'

function truncate(text, max) {
  const s = String(text || '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function firstLine(text) {
  const s = String(text || '').replace(/\r/g, '')
  const nl = s.indexOf('\n')
  return (nl >= 0 ? s.slice(0, nl) : s).trim()
}

function textOfBlocks(blocks) {
  if (typeof blocks === 'string') return blocks.trim()
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
}

function argsText(value) {
  if (value == null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * 会话 id 直接拼进文件名。宿主 id 是安全字符集；防御性兜底把任何奇怪 id 哈希成
 * 固定名（缓存可重建，哈希碰撞的最坏结果是两段日志混在一个文件里，可接受）。
 */
function logFileName(sessionId) {
  const raw = String(sessionId || '')
  return (isSafeId(raw) ? raw : `sid-${shortHash(raw)}`) + TURNLOG_SUFFIX
}

export function turnLogPath(sessionId) {
  return path.join(ensureDir(path.join(dataDir(), 'sessions')), logFileName(sessionId))
}

function safeSeqRange(record) {
  const seq = record?.seq
  if (!Array.isArray(seq) || seq.length !== 2) return null
  const start = Number(seq[0])
  const end = Number(seq[1])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return null
  return [start, end]
}

// —— 记录规则（§3.1，与 condenseEvents 同口径） ————————————————

function toolCallIdOfResult(event) {
  const message = event?.data?.message
  return [message?.callId, message?.toolCallId, message?.source?.callId]
    .find((value) => typeof value === 'string' && value) || null
}

function toolLine(name, args, status, errorText) {
  const head = `${name || '?'}${args ? `(${truncate(args, 120)})` : ''}`
  const tail = status === 'ok' ? ' → 成功'
    : status === 'error' ? ` → 失败: ${firstLine(errorText)}`
    : ' → 无结果'
  // 工具行与对话文本同一待遇：先脱敏再截断（§3.1「记录时应用 redactSecrets」）。
  return truncate(redactSecrets(head + tail), TURNLOG_TOOL_LINE_CHARS)
}

/**
 * 'summary' 档工具行：调用 + 结果按 callId 配对。tool/call 事件是权威侧
 * （assistant 消息里的 tool-call 块是同一次调用的双写，不单独成行——condenseEvents C2 同款）。
 */
function summaryToolLines(events) {
  const lines = []
  const calls = new Map() // callId -> line entry
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    const id = typeof event?.data?.callId === 'string' && event.data.callId ? event.data.callId : null
    if (id && calls.has(id)) continue // 同一 callId 双写去重
    const entry = { name: event?.data?.name || '?', args: argsText(event?.data?.arguments), status: 'pending', errorText: '' }
    if (id) calls.set(id, entry)
    lines.push(entry)
  }
  for (const event of events) {
    if (event?.type !== 'tool/result') continue
    const id = toolCallIdOfResult(event)
    const entry = id ? calls.get(id) : null
    const isError = event?.data?.message?.isError === true
    const text = textOfBlocks(event?.data?.message?.content)
    if (entry && !entry.done) {
      entry.status = isError ? 'error' : 'ok'
      entry.errorText = text
      entry.done = true
    } else if (!entry) {
      // 结果先于调用可见（乱序/旧 fixture）：结果行自己成行，错误结果在 errors 档也要可见。
      lines.push({ name: '?', args: '', status: isError ? 'error' : 'ok', errorText: text, done: true })
    }
  }
  return lines.map((entry) => toolLine(entry.name, entry.args, entry.status === 'pending' ? 'none' : entry.status, entry.errorText))
}

/** 'errors' 档：只收 isError 的工具结果行——失败尝试是漏网事实的最廉价来源（§3.1）。 */
function errorToolLines(events) {
  const names = new Map()
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    const id = typeof event?.data?.callId === 'string' && event.data.callId ? event.data.callId : null
    if (id && !names.has(id)) names.set(id, event?.data?.name || '?')
  }
  const lines = []
  for (const event of events) {
    if (event?.type !== 'tool/result' || event?.data?.message?.isError !== true) continue
    const id = toolCallIdOfResult(event)
    const name = (id && names.get(id)) || '?'
    lines.push(toolLine(name, '', 'error', textOfBlocks(event?.data?.message?.content)))
  }
  return lines
}

function joinParts(parts, max) {
  return truncate(redactSecrets(parts.join('\n')), max)
}

/**
 * 把一段宿主事件流转成回合记录数组（纯函数：同输入同输出）。
 *
 * 分组与 candidateSeedEvents 同款：turn/start 开组（或流中途无组时首个事件开组），
 * turn/end 封组；尾部没有 turn/end 的半回合不产出记录（未结算）。
 * options.tools 覆盖设置档（测试用），默认读 consolidationTurnLogTools。
 */
export function buildTurnRecords(events, options = {}) {
  let toolsMode = options.tools
  if (toolsMode === undefined) {
    try { toolsMode = getSettings().consolidationTurnLogTools } catch { toolsMode = undefined }
  }
  if (toolsMode !== 'errors' && toolsMode !== 'summary') toolsMode = 'none'

  const groups = []
  let current = null
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event.type !== 'string') continue
    if (event.type === 'turn/start' || current === null) {
      current = []
      groups.push(current)
    }
    current.push(event)
    if (event.type === 'turn/end') current = null
  }

  const records = []
  for (const group of groups) {
    const end = group[group.length - 1]
    if (end?.type !== 'turn/end') continue // 未闭合的半回合留给下一窗对账重建
    const startSeq = Number(group[0]?.seq)
    const endSeq = Number(end?.seq)
    if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq) || startSeq < 0 || endSeq < startSeq) continue

    const userParts = []
    const modelParts = []
    let scene = null
    for (const event of group) {
      if (event.type === 'user/message') {
        // 只收真人消息：插件注入 / 调度 / 心跳一律不记（§3.1 过滤口径）。
        if (event?.data?.source?.kind !== 'user') continue
        const text = textOfBlocks(event?.data?.content)
        if (text) userParts.push(text)
        const sceneTime = event?.data?.sceneTime
        if (typeof sceneTime === 'string' && sceneTime.trim()) scene = sceneTime
      } else if (event.type === 'assistant/message') {
        // assistant 只收 text 块：reasoning / tool-call 块不进对话记录。
        const text = textOfBlocks(event?.data?.message?.content)
        if (text) modelParts.push(text)
      }
    }

    const record = {
      seq: [startSeq, endSeq],
      at: Number.isFinite(end?.time) ? new Date(end.time).toISOString() : null,
      scene,
      user: joinParts(userParts, TURNLOG_USER_MODEL_CHARS),
      model: joinParts(modelParts, TURNLOG_USER_MODEL_CHARS),
    }
    const kind = end?.data?.reason?.kind
    if (kind && kind !== 'completed') record.interrupted = true

    let toolLines = []
    if (toolsMode === 'summary') toolLines = summaryToolLines(group)
    else if (toolsMode === 'errors') toolLines = errorToolLines(group)
    if (toolLines.length > 0) record.tools = toolLines

    // 空回合（纯注入/心跳/无对话无工具）不落行。
    if (!record.user && !record.model && !(record.tools && record.tools.length > 0)) continue

    applyRecordCap(record)
    records.push(record)
  }
  return records
}

/** 4000 字总闸：超预算只砍 tools 尾部（user/model 在各自 2000 内全保）。 */
function applyRecordCap(record) {
  const tools = record.tools
  if (!Array.isArray(tools) || tools.length === 0) return
  if (JSON.stringify(record).length <= TURNLOG_RECORD_CHARS) return
  const marker = (n) => `…[另有 ${n} 条工具调用已省略]`
  let kept = tools.length
  while (kept >= 0) {
    record.tools = tools.slice(0, kept)
    if (kept < tools.length) record.tools.push(marker(tools.length - kept))
    if (JSON.stringify(record).length <= TURNLOG_RECORD_CHARS || kept === 0) return
    kept -= 1
  }
}

// —— 落盘与读取 ————————————————————————————————————————————

function scanTurnLog(sessionId) {
  const file = turnLogPath(sessionId)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    // ENOENT = 空日志（正常）；其他读失败当作不可读：绝不在没读到的地方重写。
    if (error?.code !== 'ENOENT') warn(`turn-log read failed for ${logFileName(sessionId)}: ${error?.message || error}`)
    return { file, entries: [], badLines: 0, unreadable: error?.code !== 'ENOENT' }
  }
  const entries = []
  let badLines = 0
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let record = null
    try { record = JSON.parse(trimmed) } catch { badLines += 1 }
    entries.push({ raw: trimmed, record })
  }
  return { file, entries, badLines, unreadable: false }
}

/** 坏行原样保留地原子重写（Windows 上 rename 的 EPERM/EBUSY 重试用 paths.js 同款节奏）。 */
function rewriteTurnLog(file, lines) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`
  try {
    fs.writeFileSync(tmp, lines.length > 0 ? lines.join('\n') + '\n' : '', 'utf8')
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(tmp, file); break } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt >= 5) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8 * (attempt + 1))
      }
    }
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }) } catch {}
    throw error
  }
}

/**
 * 重建补洞会把旧回合追加到文件尾部，打乱"文件序 = 时间序"的不变量（读取侧
 * readIncrement/tailSlice/pruneHead 都按文件序工作）。这里把有效记录按 seq 排回
 * 升序；坏行 seq 未知，原样保留在尾部。仅在确实乱序时重写，append-only 常态零开销。
 */
function sortTurnLogBySeq(sessionId) {
  const scan = scanTurnLog(sessionId)
  if (scan.unreadable || scan.entries.length === 0) return
  const valid = []
  const bad = []
  for (const entry of scan.entries) {
    if (safeSeqRange(entry.record)) valid.push(entry)
    else bad.push(entry)
  }
  let ordered = true
  for (let i = 1; i < valid.length; i += 1) {
    if (valid[i].record.seq[0] < valid[i - 1].record.seq[0]) { ordered = false; break }
  }
  if (ordered) return
  valid.sort((a, b) => a.record.seq[0] - b.record.seq[0] || a.record.seq[1] - b.record.seq[1])
  try {
    rewriteTurnLog(scan.file, [...valid, ...bad].map((entry) => entry.raw))
  } catch (error) {
    warn(`turn-log sort failed for ${logFileName(sessionId)}: ${error?.message || error}`)
  }
}

/**
 * 追加一行回合记录。记录器是旁路：任何失败只 warn，绝不抛给主会话（§3.2）。
 * 落盘后顺带做一次头部裁剪（§3.4：只裁已结算段）。
 */
export function recordTurn(sessionId, record) {
  try {
    if (!safeSeqRange(record)) {
      warn(`turn-log record rejected for ${logFileName(sessionId)}: missing a valid seq range`)
      return null
    }
    const line = JSON.stringify({ ...record, at: record.at || stamp() })
    fs.appendFileSync(turnLogPath(sessionId), line + '\n', 'utf8')
    try {
      let lastSleepSeq = null
      try { lastSleepSeq = getSessionBinding(String(sessionId))?.lastSleepSeq ?? null } catch {}
      pruneHead(String(sessionId), TURNLOG_KEEP_CHARS, lastSleepSeq)
    } catch {}
    return line
  } catch (error) {
    warn(`turn-log append failed for ${logFileName(String(sessionId))}: ${error?.message || error}`)
    return null
  }
}

/**
 * 自 afterSeq 之后的增量回合。回合是不可分单位（§3.3）：记录天然整回合，
 * 所以按 seqStart > afterSeq 过滤即可，不存在半回合重复读。
 * 注意：worker 增量入口 loadWorkerIncrement 用 readIncrement(-1) 读全量后自行按
 * seqEnd > lastSleepSeq 过滤（跨骑回合整条收），本函数的 afterSeq 过滤只服务直接调用方。
 */
export function readIncrement(sessionId, afterSeq) {
  const scan = scanTurnLog(sessionId)
  const after = Number(afterSeq)
  const from = Number.isSafeInteger(after) ? after : -1
  const records = scan.entries
    .map((entry) => entry.record)
    .filter((record) => {
      const range = safeSeqRange(record)
      return range && range[0] > from
    })
  return { records, badLines: scan.badLines }
}

/**
 * 校验 [fromSeq, throughSeq] 的日志覆盖与连续性（§3.3）。
 * missingRanges 是窗口内没有被任何记录盖住的 seq 子区间（含记录之间的空洞）。
 */
export function verifyGap(sessionId, fromSeq, throughSeq) {
  const scan = scanTurnLog(sessionId)
  const from = Number(fromSeq)
  const through = Number(throughSeq)
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(through) || from > through) {
    return { ok: true, missingRanges: [], badLines: scan.badLines }
  }
  const covered = scan.entries
    .map((entry) => entry.record)
    .map((record) => safeSeqRange(record))
    .filter((range) => range && range[1] >= from && range[0] <= through)
    .sort((a, b) => a[0] - b[0])
  const missingRanges = []
  let cursor = from
  for (const [start, end] of covered) {
    if (start > cursor) missingRanges.push([cursor, start - 1])
    if (end + 1 > cursor) cursor = end + 1
  }
  if (cursor <= through) missingRanges.push([cursor, through])
  return { ok: missingRanges.length === 0, missingRanges, badLines: scan.badLines }
}

/**
 * 用宿主事件重建 [fromSeq, throughSeq] 的缺失回合（§3.3：绝不假设日志完整）。
 * 只补洞：与现有记录重叠的区间跳过，重复调用幂等。
 */
export function rebuildRange(sessionId, fromSeq, throughSeq, events) {
  const from = Number(fromSeq)
  const through = Number(throughSeq)
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(through) || from > through) {
    return { ok: false, rebuilt: 0, reason: 'invalid range' }
  }
  const slice = (Array.isArray(events) ? events : []).filter((event) => {
    const seq = Number(event?.seq)
    return Number.isSafeInteger(seq) && seq >= from && seq <= through
  })
  const candidates = buildTurnRecords(slice).filter((record) => {
    const [start, end] = safeSeqRange(record) || [NaN, NaN]
    return start >= from && end <= through
  })
  const scan = scanTurnLog(sessionId)
  const existing = scan.entries.map((entry) => safeSeqRange(entry.record)).filter(Boolean)
  let rebuilt = 0
  for (const record of candidates) {
    const [start, end] = record.seq
    if (existing.some(([s, e]) => start <= e && end >= s)) continue
    if (recordTurn(sessionId, record)) rebuilt += 1
  }
  // 补洞追加的旧回合可能落在文件尾部，排回时间序，保证增量/尾部/裁剪口径一致。
  if (rebuilt > 0) sortTurnLogBySeq(sessionId)
  return { ok: true, rebuilt, requested: [from, through], records: candidates }
}

/**
 * 取尾部整回合，总量（序列化后）≤ maxChars。回合不可分：最新一回合即使超预算
 * 也整条返回（截了就不是完整证据）；再往前按预算装。
 */
export function tailSlice(sessionId, maxChars) {
  const scan = scanTurnLog(sessionId)
  const budget = Math.max(0, Number(maxChars) || 0)
  const records = []
  let used = 0
  for (let i = scan.entries.length - 1; i >= 0; i--) {
    const record = scan.entries[i].record
    const range = record ? safeSeqRange(record) : null
    if (!range) continue
    const len = JSON.stringify(record).length
    if (records.length > 0 && used + len > budget) break
    records.unshift(record)
    used += len
  }
  return { records, text: records.map((record) => JSON.stringify(record)).join('\n'), chars: used, badLines: scan.badLines }
}

/**
 * 头部裁剪（§3.4）：只裁 seqEnd ≤ lastSleepSeq 的**已结算**记录。未结算段超上限
 * 就让文件暂超——裁进未结算区间等于把缺口推进需要重建的地方，绝不这么干。
 * 坏行 seq 未知、无法证明已结算，同样保留。
 */
export function pruneHead(sessionId, keepChars = TURNLOG_KEEP_CHARS, lastSleepSeq = null) {
  const scan = scanTurnLog(sessionId)
  const charsOf = (entry) => entry.raw.length + 1
  const total = scan.entries.reduce((sum, entry) => sum + charsOf(entry), 0)
  const budget = Number(keepChars) > 0 ? Number(keepChars) : TURNLOG_KEEP_CHARS
  const settledThrough = Number.isSafeInteger(Number(lastSleepSeq)) ? Number(lastSleepSeq) : null
  if (scan.unreadable || total <= budget || settledThrough === null) {
    // 读失败绝不重写；没超预算不用动；没有结算游标时整份日志都是未结算段，暂超就暂超。
    return { pruned: 0, charsBefore: total, charsAfter: total, unreadable: scan.unreadable }
  }
  const keep = [...scan.entries]
  let keptTotal = total
  let pruned = 0
  while (keep.length > 0 && keptTotal > budget) {
    const range = keep[0].record ? safeSeqRange(keep[0].record) : null
    if (!range || range[1] > settledThrough) break // 未结算/坏行：到此为止
    keptTotal -= charsOf(keep[0])
    keep.shift()
    pruned += 1
  }
  if (pruned === 0) return { pruned: 0, charsBefore: total, charsAfter: total }
  try {
    rewriteTurnLog(scan.file, keep.map((entry) => entry.raw))
  } catch (error) {
    warn(`turn-log head prune failed for ${logFileName(sessionId)}: ${error?.message || error}`)
    return { pruned: 0, charsBefore: total, charsAfter: total, error: String(error?.message || error) }
  }
  const charsAfter = keep.reduce((sum, entry) => sum + charsOf(entry), 0)
  return { pruned, charsBefore: total, charsAfter }
}

/**
 * 休眠 GC（§3.4）：日志无未结算增量（max seqEnd ≤ lastSleepSeq）且会话 ≥30 天
 * 无活动 → 删文件。缓存级操作；复活后交接尾部/增量走重建路径自动补。
 * 两个条件都满足才删：有未结算增量（整理没做完）的日志是增量来源，保留。
 */
export function gcTurnLogs(bindings, { now = Date.now(), olderThanDays = TURNLOG_GC_DAYS, dryRun = false } = {}) {
  const deleted = []
  const kept = []
  const days = Number(olderThanDays) > 0 ? Number(olderThanDays) : TURNLOG_GC_DAYS
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    const sessionId = binding?.sessionId
    if (!sessionId) continue
    let stat = null
    try { stat = fs.statSync(turnLogPath(sessionId)) } catch { continue } // 没有日志，无事可做
    const lastTurnAt = Date.parse(binding.lastTurnAt || '') || 0
    if (!(lastTurnAt > 0) || now - lastTurnAt < days * 86_400_000) {
      kept.push({ sessionId, reason: 'recent-activity', lastTurnAt: binding.lastTurnAt || null })
      continue
    }
    const lastSleepSeq = Number(binding.lastSleepSeq)
    if (!Number.isSafeInteger(lastSleepSeq) || lastSleepSeq < 0) {
      kept.push({ sessionId, reason: 'never-settled', size: stat.size })
      continue
    }
    const scan = scanTurnLog(sessionId)
    if (scan.unreadable) {
      kept.push({ sessionId, reason: 'unreadable' })
      continue
    }
    let maxSeqEnd = -1
    for (const entry of scan.entries) {
      const range = entry.record ? safeSeqRange(entry.record) : null
      if (range && range[1] > maxSeqEnd) maxSeqEnd = range[1]
    }
    if (maxSeqEnd > lastSleepSeq) {
      kept.push({ sessionId, reason: 'unsettled-increment', maxSeqEnd, lastSleepSeq })
      continue
    }
    if (dryRun) {
      deleted.push(sessionId)
      continue
    }
    try {
      fs.rmSync(scan.file, { force: true })
      deleted.push(sessionId)
    } catch (error) {
      kept.push({ sessionId, reason: `delete-failed: ${error?.code || error}` })
    }
  }
  return { deleted, kept }
}

export function deleteTurnLog(sessionId) {
  try {
    const file = turnLogPath(sessionId)
    fs.rmSync(file, { force: true })
    return { ok: true, file }
  } catch (error) {
    warn(`turn-log delete failed for ${logFileName(String(sessionId))}: ${error?.message || error}`)
    return { ok: false, error: String(error?.message || error) }
  }
}
