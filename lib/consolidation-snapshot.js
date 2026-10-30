import crypto from 'node:crypto'
import { stamp } from './paths.js'

// C 包：把「读一份会话」从一个隐式的整段读盘，变成一个显式的、有身份的固定快照。
//
// 两条宿主路径都只用公开 API：
//   1) sessionQuery.observeSession(id, { projectionMode: 'none' }) —— 返回一个租约，
//      live 源的 events 在租约创建时就把 seq 钉住了（之后的追加不会漏进这份快照），
//      cursor 是这份快照的 throughSeq。这是唯一既能拿到「不变的 cut」又不碰宿主内部的方法。
//   2) sessionQuery.readSession(id) —— 宿主回放校验过的完整日志（缺失的半步已被
//      interruptedTurnClosers 补齐），没有租约，因此按「已验证日志」处理。
//
// Session.snapshotEvents() 在宿主里被标成 @deprecated「new calls are prohibited」，
// 所以这里不直接用它：租约负责 cut，本模块只负责「在没有租约时不要假装有」。
export const CONSOLIDATION_SNAPSHOT_VERSION = 1

const TURN_END = 'turn/end'
const STEP_START = 'step/start'
const STEP_END = 'step/end'
const TOOL_CALL = 'tool/call'
const TOOL_RESULT = 'tool/result'
const ASSISTANT_MESSAGE = 'assistant/message'

export function eventSeq(event) {
  const seq = Number(event?.seq)
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : null
}

// 工具调用与工具结果是两步落盘的：助手消息里先出现 tool-call 块，循环再补一条
// tool/call，结果落成 tool/result（message.toolCallId/source.callId 指回同一个 id；旧 fixture 的 message.callId 也兼容）。只认 turn/end
// 还不够——被中断的回合可能留下一个没有结果的调用，把这种半步喂给整理 worker 会
// 让它对「调用了但没发生」的事编出结论。
export function toolPairing(events) {
  const calls = new Map()
  const results = new Set()
  for (const event of events || []) {
    const seq = eventSeq(event)
    if (seq === null) continue
    if (event?.type === TOOL_CALL) {
      const id = event?.data?.callId
      if (typeof id === 'string' && id && !calls.has(id)) calls.set(id, seq)
    }
    if (event?.type === TOOL_RESULT) {
      const message = event?.data?.message
      const id = [message?.callId, message?.toolCallId, message?.source?.callId]
        .find((value) => typeof value === 'string' && value)
      if (id) results.add(id)
      continue
    }
    if (event?.type === ASSISTANT_MESSAGE) {
      const blocks = event?.data?.message?.content
      if (!Array.isArray(blocks)) continue
      for (const block of blocks) {
        if (block?.type !== 'tool-call') continue
        const id = block?.id
        if (typeof id === 'string' && id && !calls.has(id)) calls.set(id, seq)
      }
    }
  }
  const unpaired = [...calls.entries()]
    .filter(([id]) => !results.has(id))
    .map(([id, seq]) => ({ id, seq }))
    .sort((a, b) => a.seq - b.seq)
  return {
    calls: calls.size,
    results: results.size,
    unpaired,
    firstUnpairedSeq: unpaired.length > 0 ? unpaired[0].seq : null,
  }
}

export function lastClosedTurnSeq(events) {
  let closed = null
  for (const event of events || []) {
    if (event?.type !== TURN_END) continue
    const seq = eventSeq(event)
    if (seq !== null) closed = seq
  }
  return closed
}

// 尾部半步：最后一条 step/start 后面没有 step/end。turn/end 之后不会出现，
// 但已验证日志以外的来源（例如宿主将来换实现）不能想当然，所以显式检查。
function openStepSeq(window) {
  let open = null
  for (const event of window || []) {
    const seq = eventSeq(event)
    if (seq === null) continue
    if (event?.type === STEP_START) open = seq
    else if (event?.type === STEP_END && open !== null && seq > open) open = null
  }
  return open
}

/**
 * 从一段事件里切出可以安全喂给 worker 的前缀。
 *
 * requireClosedTurn=true（live 租约）：只到最后一个 turn/end 为止，否则 deferred。
 * requireClosedTurn=false（宿主回放校验过的日志）：整段可用，但仍然剥掉尾部未配对的
 * 工具调用和未闭合的步骤——这两件事在已校验日志里本不该出现，出现了就说明来源不可信。
 */
export function safePrefix(events, { requireClosedTurn = false } = {}) {
  const all = (Array.isArray(events) ? events : []).filter((event) => eventSeq(event) !== null)
  if (all.length === 0) return { ok: false, reasonCode: 'no-events', dropped: 0 }
  let window = all
  if (requireClosedTurn) {
    const closed = lastClosedTurnSeq(all)
    if (closed === null) return { ok: false, reasonCode: 'no-closed-turn', dropped: all.length }
    window = all.filter((event) => eventSeq(event) <= closed)
  }
  const pairing = toolPairing(window)
  if (pairing.firstUnpairedSeq !== null) {
    window = window.filter((event) => eventSeq(event) < pairing.firstUnpairedSeq)
    if (window.length === 0) return { ok: false, reasonCode: 'unpaired-tool-call', dropped: all.length }
    if (requireClosedTurn) {
      const closed = lastClosedTurnSeq(window)
      if (closed === null) return { ok: false, reasonCode: 'no-closed-turn', dropped: all.length }
      window = window.filter((event) => eventSeq(event) <= closed)
    }
  }
  const openStep = openStepSeq(window)
  if (openStep !== null) {
    const trimmed = window.filter((event) => eventSeq(event) < openStep)
    if (trimmed.length === 0) return { ok: false, reasonCode: 'half-step', dropped: all.length }
    if (requireClosedTurn) {
      const closed = lastClosedTurnSeq(trimmed)
      if (closed === null) return { ok: false, reasonCode: 'half-step', dropped: all.length }
      window = trimmed.filter((event) => eventSeq(event) <= closed)
    } else window = trimmed
  }
  // 砍掉半步之后再剥掉尾部的 turn/start：一个开了头但一条 step 都没有的回合同样是半份。
  while (window.length > 0 && window[window.length - 1]?.type === 'turn/start') window = window.slice(0, -1)
  if (window.length === 0) return { ok: false, reasonCode: 'no-closed-turn', dropped: all.length }
  const fromSeq = eventSeq(window[0])
  const throughSeq = eventSeq(window[window.length - 1])
  return {
    ok: true,
    events: window,
    fromSeq,
    throughSeq,
    eventCount: window.length,
    dropped: all.length - window.length,
    pairing: { calls: pairing.calls, results: pairing.results, unpaired: pairing.unpaired.length },
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item)).join(',') + ']'
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
}

/** Content-addressed fixed snapshot; only the digest is persisted, never its body. */
export function snapshotHash(events, fromSeq, throughSeq) {
  const hash = crypto.createHash('sha256').update(canonicalJson({ fromSeq, throughSeq }))
  // Stream events rather than stringify a second complete transcript in memory.
  for (const event of events || []) {
    const seq = eventSeq(event)
    if (seq === null || seq < Number(fromSeq) || seq > Number(throughSeq)) continue
    hash.update('\n').update(canonicalJson(event))
  }
  return hash.digest('hex')
}

function unavailable(reasonCode, message) {
  return { ok: false, code: 'unavailable', reasonCode, retryable: false, error: message }
}

function deferred(reasonCode, message, detail) {
  return { ok: false, code: 'deferred', reasonCode, retryable: true, error: message, ...(detail || {}) }
}

function failed(reasonCode, error) {
  return { ok: false, code: 'failed', reasonCode, retryable: true, error: String(error?.message || error) }
}

function buildSnapshot({ sessionId, source, events, header, inheritedEventCount, cursor, safe }) {
  const snapshot = {
    version: CONSOLIDATION_SNAPSHOT_VERSION,
    sessionId,
    source,
    fromSeq: safe.fromSeq,
    throughSeq: safe.throughSeq,
    eventCount: safe.eventCount,
    droppedEvents: safe.dropped,
    inheritedEventCount: Number.isSafeInteger(Number(inheritedEventCount)) ? Number(inheritedEventCount) : null,
    cursor: Number.isSafeInteger(Number(cursor)) ? Number(cursor) : null,
    cwd: typeof header?.cwd === 'string' ? header.cwd : null,
    agentPreset: typeof header?.agentPreset === 'string' ? header.agentPreset : null,
    hash: snapshotHash(safe.events, safe.fromSeq, safe.throughSeq),
    capturedAt: stamp(),
  }
  return snapshot
}

/**
 * 抓一份固定快照。返回 { ok:true, snapshot, events, header } 或一个显式失败：
 *   code: 'unavailable' —— 宿主没有这个能力（不要声称成功）
 *   code: 'deferred'    —— 现在拿不到安全前缀（回合未闭合/半步），下次再试
 *   code: 'failed'      —— 读失败，可重试
 */
export async function captureSessionSnapshot(ctx, sessionId, { signal } = {}) {
  if (!sessionId) return unavailable('no-session-id', 'a snapshot needs a session id')
  let sessionQuery = null
  try { sessionQuery = ctx?.get?.('sessionQuery') || null } catch { sessionQuery = null }
  if (!sessionQuery) return unavailable('no-session-query', 'the host exposes no sessionQuery service; a safe snapshot cannot be taken')

  if (typeof sessionQuery.observeSession === 'function') {
    let lease = null
    let events = null
    let source = 'lease-live'
    let header = {}
    let cursor = null
    let inheritedEventCount = null
    try {
      lease = await sessionQuery.observeSession(sessionId, { projectionMode: 'none', ...(signal ? { signal } : {}) })
      const raw = lease?.events
      events = Array.isArray(raw) ? [...raw] : []
      source = lease?.source === 'prepared' ? 'lease-prepared' : 'lease-live'
      header = lease?.header || {}
      cursor = lease?.cursor
      inheritedEventCount = lease?.inheritedEventCount
    } catch (error) {
      return failed('observe-failed', error)
    } finally {
      // 租约必须还回去，否则 prepared 条目会一直被 refs 钉在缓存里。
      try { lease?.[Symbol.dispose]?.(lease) } catch {}
    }
    const safe = safePrefix(events, { requireClosedTurn: source === 'lease-live' })
    if (!safe.ok) {
      return deferred(safe.reasonCode, safe.reasonCode === 'no-closed-turn'
        ? 'the live session has an open turn; a consolidation snapshot needs a closed turn boundary'
        : 'the transcript is not complete enough to snapshot (' + safe.reasonCode + ')',
        { observedEvents: events.length })
    }
    return {
      ok: true,
      events: safe.events,
      header,
      snapshot: buildSnapshot({ sessionId, source, events: safe.events, header, inheritedEventCount, cursor, safe }),
    }
  }

  if (typeof sessionQuery.readSession === 'function') {
    let snapshot = null
    try {
      snapshot = await sessionQuery.readSession(sessionId)
    } catch (error) {
      return failed('read-failed', error)
    }
    const events = Array.isArray(snapshot?.events) ? [...snapshot.events] : []
    const safe = safePrefix(events, { requireClosedTurn: false })
    if (!safe.ok) return deferred(safe.reasonCode, 'the stored transcript is not complete enough to snapshot (' + safe.reasonCode + ')', { observedEvents: events.length })
    const header = snapshot?.session || {}
    return {
      ok: true,
      events: safe.events,
      header,
      snapshot: buildSnapshot({
        sessionId,
        source: 'validated-log',
        events: safe.events,
        header,
        inheritedEventCount: snapshot?.inheritedEventCount,
        cursor: safe.throughSeq,
        safe,
      }),
    }
  }

  return unavailable('no-snapshot-api', 'sessionQuery exposes neither observeSession nor readSession; consolidation cannot read a safe snapshot')
}

export default { CONSOLIDATION_SNAPSHOT_VERSION, captureSessionSnapshot, safePrefix, snapshotHash, toolPairing, lastClosedTurnSeq, eventSeq }