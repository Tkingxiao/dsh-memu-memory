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

// —— 外部追加恢复：活视图落后于持久日志 ————————————————————————————————
// sessionQuery 的 observeSession / readSession 都是 live-preferred：同一会话在宿主
// 里有活对象时，它们读活对象，不再看持久日志。宿主的活会话只随它自己的事件流增长；
// 如果另一个进程/导入路径直接改写了会话日志（bench 的 seed-session 就是直接重写
// session.v4.jsonl.zstd 来追加历史），活视图会冻结在旧前缀。这里只在活视图确实
// 落后于持久日志时改用冷读结果；正常活会话（含尚未落盘的尾部）永远保留活视图。
const COLD_PROBE_TTL_MS = 60_000
const COLD_PROBE_CACHE_LIMIT = 64
const coldProbeCache = new Map()

function lastSeqOf(events) {
  const list = Array.isArray(events) ? events : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const seq = Number(list[i]?.seq)
    if (Number.isSafeInteger(seq)) return seq
  }
  return -1
}

function rememberColdProbe(sessionId, liveLast, coldLast) {
  coldProbeCache.set(sessionId, { liveLast, coldLastSeq: coldLast, at: Date.now() })
  if (coldProbeCache.size <= COLD_PROBE_CACHE_LIMIT) return
  const oldest = coldProbeCache.keys().next().value
  if (oldest !== undefined) coldProbeCache.delete(oldest)
}

async function defaultLoadColdLogModule() {
  return import('@deepseek-ai/dsh-session-query')
}

/**
 * 持久日志比活视图更靠后时，返回冷读的完整日志；否则 null。
 *
 * 只在活视图路径调用。冷读模块（readColdSessionLog）来自宿主公开导出；拿不到持久
 * 化服务或模块时静默降级，绝不影响现有快照路径。短 TTL 缓存避免正常长会话每窗
 * 都做一次整份冷读：冷日志不领先时，60 秒内不重复探测。
 */
export async function reconcilePersistedAhead({
  persistence = null, sessionId = null, liveEvents = [], liveHeader = null,
  signal, loadModule = defaultLoadColdLogModule,
} = {}) {
  if (!persistence || typeof persistence.open !== 'function' || !sessionId) return null
  const key = String(sessionId)
  const liveLast = lastSeqOf(liveEvents)
  const cached = coldProbeCache.get(key)
  if (cached && cached.coldLastSeq <= liveLast && Date.now() - cached.at < COLD_PROBE_TTL_MS) return null
  let mod = null
  try { mod = await loadModule() } catch { return null }
  if (typeof mod?.readColdSessionLog !== 'function') return null
  let log = null
  try { log = await mod.readColdSessionLog(persistence, sessionId, signal) } catch { return null }
  if (!Array.isArray(log?.events)) return null
  const coldLast = lastSeqOf(log.events)
  if (!Number.isSafeInteger(coldLast)) return null
  rememberColdProbe(key, liveLast, coldLast)
  if (coldLast <= liveLast) return null
  // 同一逻辑会话的身份必须一致；不一致说明不是同一份日志，宁可保留活视图。
  try {
    if (liveHeader && typeof mod.assertSessionHeadersCompatible === 'function') {
      mod.assertSessionHeadersCompatible(liveHeader, log.header)
    }
  } catch { return null }
  return {
    source: 'persisted-ahead',
    events: log.events,
    header: log.header || {},
    inheritedEventCount: log.inheritedEventCount,
    cursor: coldLast,
  }
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
export async function captureSessionSnapshot(ctx, sessionId, { signal, loadColdLogModule } = {}) {
  if (!sessionId) return unavailable('no-session-id', 'a snapshot needs a session id')
  let sessionQuery = null
  try { sessionQuery = ctx?.get?.('sessionQuery') || null } catch { sessionQuery = null }
  if (!sessionQuery) return unavailable('no-session-query', 'the host exposes no sessionQuery service; a safe snapshot cannot be taken')
  const persistence = (() => { try { return ctx?.get?.('sessionPersistence') || null } catch { return null } })()
  const persistedAhead = (events, header) => reconcilePersistedAhead({
    persistence, sessionId, liveEvents: events, liveHeader: header, signal,
    ...(loadColdLogModule ? { loadModule: loadColdLogModule } : {}),
  })

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
    // 活视图可能被宿主的缓存钉住，而持久日志已被外部追加（bench 种子写入）。
    // 只在持久日志确实更靠后时切换，正常活会话不受影响。
    if (source === 'lease-live') {
      const ahead = await persistedAhead(events, header)
      if (ahead) {
        events = ahead.events
        header = ahead.header
        cursor = ahead.cursor
        inheritedEventCount = ahead.inheritedEventCount
        source = ahead.source
      }
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
    let events = Array.isArray(snapshot?.events) ? [...snapshot.events] : []
    let header = snapshot?.session || {}
    let inheritedEventCount = snapshot?.inheritedEventCount
    // readSession 也是 live-preferred；同一条外部追加恢复路径。
    const ahead = await persistedAhead(events, header)
    if (ahead) {
      events = ahead.events
      header = ahead.header
      inheritedEventCount = ahead.inheritedEventCount
    }
    const safe = safePrefix(events, { requireClosedTurn: false })
    if (!safe.ok) return deferred(safe.reasonCode, 'the stored transcript is not complete enough to snapshot (' + safe.reasonCode + ')', { observedEvents: events.length })
    return {
      ok: true,
      events: safe.events,
      header,
      snapshot: buildSnapshot({
        sessionId,
        source: 'validated-log',
        events: safe.events,
        header,
        inheritedEventCount,
        cursor: safe.throughSeq,
        safe,
      }),
    }
  }

  return unavailable('no-snapshot-api', 'sessionQuery exposes neither observeSession nor readSession; consolidation cannot read a safe snapshot')
}

export default { CONSOLIDATION_SNAPSHOT_VERSION, captureSessionSnapshot, reconcilePersistedAhead, safePrefix, snapshotHash, toolPairing, lastClosedTurnSeq, eventSeq }