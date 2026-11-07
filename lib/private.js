import { createUserMessage } from '@deepseek-ai/dsh-llm'
import crypto from 'node:crypto'
import { getSessionBinding, getLibrary, getSettings, setSessionBinding, deleteSessionBinding, loadPrivateIndex, effectiveScope } from './state.js'
import { domainOf, privateRemember, isMemoryEligible, visibleToSession } from './memory.js'
import { loadPromptForDomain, CONSOLIDATION_CONTRACTS } from './prompts.js'
import { summarizeRemote } from './remote-summary.js'
import { condenseEvents, readSessionSnapshot } from './curator.js'
import { record } from './activity-log.js'
import { ACTIVE_MEMORY_POLICY, assessWake, collectEvidence } from './active-memory.js'
import { entryFingerprint } from './consolidation-receipt.js'
import { DEFAULT_TIME_ZONE } from './temporal.js'

// The consolidation worker only sees the transcript as text. Without a visible
// per-turn clock it falls back to the wall clock (or a single batch sceneTime),
// which is exactly how "前天" gets written months away from the scene. The seed
// event keeps the replayed logical time; surface it as a leading text block so
// the worker can pass that turn's observed_at to the write tools.
function eventTimeLabel(event) {
  const explicit = event?.data?.sceneTime
  const at = explicit ? new Date(explicit) : (Number.isFinite(event?.time) ? new Date(event.time) : null)
  if (!at || !Number.isFinite(at.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at)
  const pick = (type) => parts.find((part) => part.type === type)?.value || ''
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`
}

// Short-term entries expire on a clock, so the idle pass is the last moment anyone
// can decide what they were worth. The list is generated in code rather than added
// to the editable prompt body: it is per-library data plus a protocol (which tool
// call means "promote"), and a user editing the template must not be able to break
// the tool names the model is told to use.
export function shortTermBrief(binding, { now = Date.now() } = {}) {
  if (!binding?.libraryId || binding.useLibrary === false) return ''
  let index = null
  try { index = loadPrivateIndex(binding.libraryId) } catch { return '' }
  const rows = Object.entries(index.entries || {})
    .filter(([, e]) => e && e.layer === 'short_term' && isMemoryEligible(e, { automatic: true, now }) && visibleToSession(e, binding.sessionId))
    .map(([id, e]) => ({
      id,
      title: e.title || '(untitled)',
      left: Math.max(0, Math.round(((Date.parse(e.expiresAt || '') || 0) - now) / 3_600_000)),
    }))
    .filter((row) => row.left > 0)
    .sort((a, b) => a.left - b.left)
    .slice(0, 20)
  if (rows.length === 0) return ''
  return [
    '[short_term · 快到期了]',
    '下面这些是你近期记下的短期条目，到期会自己消失。逐条决定：',
    '值得留下的升级 —— memu_private_update id=<id> layer=long_term（要补充的正文这次一并写上）；',
    '不重要的归档 —— memu_private_archive id=<id>；',
    '还说不清的别动，它自己会过期。',
    ...rows.map((row) => `- [${row.id}] ${row.title} · 约 ${row.left} 小时后过期`),
  ].join('\n')
}

export function buildPrivateConsolidationPrompt(sessionId) {
  const binding = getSessionBinding(sessionId)
  const library = binding?.libraryId ? getLibrary(binding.libraryId) : null
  const settings = getSettings()
  // One shared body for both backends; only the output contract differs.
  return [
    loadPromptForDomain('private-consolidation', {
      libraryName: library ? `${library.name} (${library.id})` : '(unbound)',
      domain: domainOf(binding),
      mustRememberCap: settings.mustRememberCap,
      shortTermTtlHours: settings.shortTermTtlHours ?? 72,
    }, domainOf(binding)).text,
    '',
    CONSOLIDATION_CONTRACTS.local,
    shortTermBrief({ ...binding, sessionId }),
  ].filter((part) => part && part.trim()).join('\n')
}

function noticeMessage(text, summary) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:dsh-memu-memory', form: 'notice', summary },
  })
}

// "There were new turns" is not the same question as "there is something worth
// keeping". A conversation of greetings, acknowledgements and one-line lookups costs
// a fork (a whole seeded transcript, one model turn) and returns nothing; doing that
// after every idle window is how an automatic pass becomes noise the user turns off.
// This answers the cheap half of the question locally, before a fork exists: is the
// part of the transcript since the last consolidation substantive at all? It has to
// err on the side of running — a false "worth it" costs one model turn, a false
// "skip" silently throws away the only record of a decision — so the bar is low and
// deliberately structural rather than semantic: a single short human message with no
// tool work in it is the only thing it refuses.
// The gate this replaces counted characters. That was wrong in the one direction
// that matters: "我不吃香菜" is five characters and is exactly the kind of durable
// fact the library exists to keep, while "好的，继续" is also short and is worth
// nothing. Length is not the signal — an acknowledgement is. So this is a shape
// match on the *only* message in the tail, not a size test, and anything that is not
// literally an acknowledgement goes to the fork and lets the prompt decide.
const SMALL_TALK = /^(谢(谢|了)?|多谢|感谢|好(的|吧|嘞)?|ok|okay|收到|明白(了)?|了解(了)?|嗯+|哦+|啊+|行|可以|没问题|继续|你好|hi|hello|hey|thanks?(you)?|thx)+$/i
const ASSESS_MIN_HUMAN_CHARS = 4

function isSmallTalk(text) {
  // Punctuation and spacing are not content: "好的，继续" is one acknowledgement, not
  // two words with a comma in the middle.
  return SMALL_TALK.test(String(text || '').replace(/[\s!！。.,，、~～👍]/g, ''))
}

function textOfContent(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
    .join(' ')
    .trim()
}

// Only the events after the last consolidation: a session that has been asleep once
// already keeps all of its old material in the transcript, and scoring the whole file
// again would make every later turn "worth it" forever.
export function unconsolidatedEvents(binding, events) {
  const since = Number(binding?.lastSleepSeq)
  if (!Number.isFinite(since) || since < 0) return Array.isArray(events) ? events : []
  return (events || []).filter((event) => Number(event?.seq) > since)
}

export function assessConsolidationValue(events) {
  let humanTurns = 0
  let humanChars = 0
  let humanText = ''
  let toolCalls = 0
  for (const event of events || []) {
    if (event?.type === 'user/message') {
      // The same rule the transcript condenser uses: only a message the person
      // actually typed counts. Plugin notices, tool output and heartbeats all arrive
      // as messages too, and none of them is a reason to spend a fork.
      if (event.data?.source?.kind !== 'user') continue
      const text = textOfContent(event.data?.content)
      if (!text) continue
      humanTurns += 1
      humanChars += text.length
      humanText = text
      continue
    }
    if (event?.type === 'assistant/message') {
      const blocks = event.data?.message?.content
      if (Array.isArray(blocks)) toolCalls += blocks.filter((block) => block?.type === 'tool-call').length
      continue
    }
    if (event?.type === 'tool/call') toolCalls += 1
  }
  const facts = { humanTurns, humanChars, toolCalls }
  if (humanTurns === 0) return { worth: false, reason: 'no-human-turn', ...facts }
  if (toolCalls === 0 && humanTurns === 1 && (isSmallTalk(humanText) || humanChars < ASSESS_MIN_HUMAN_CHARS)) {
    return { worth: false, reason: 'small-talk', ...facts }
  }
  return { worth: true, reason: 'substantive', ...facts }
}

// ---- incremental consolidation window --------------------------------------
// A consolidation fork used to seed the whole transcript up to the snapshot cut,
// so every run re-read the same old tool logs and the model's attention spread
// thinner as the conversation grew (the 56-turn QQ session was re-read 6-10
// times). The policy below keeps each fork bounded: seed only the unconsolidated
// tail, compact the noise, and leave the rest for the next window.
export const CONSOLIDATION_BACKLOG_EVENTS = 200
export const CONSOLIDATION_BACKLOG_TURNS = 10
export const CONSOLIDATION_WINDOW_EVENTS = 300
export const CONSOLIDATION_PROBE_MINUTES = 15
export const CONSOLIDATION_SNAPSHOT_FAILURE_LIMIT = 2
const SEED_TOOL_RESULT_CHARS = 1_600
const SEED_TOOL_CALL_CHARS = 800
const SEED_TEXT_CHARS = 20_000
const SEED_CATALOG_ENTRIES = 60

// Types that carry conversation, plus the structural events a seeded Session
// replays. Everything else is host bookkeeping: request headers, permissions,
// runtime snapshots and the plugin's own recall messages. Feeding those to the
// summarizer is how a memory ends up citing its own earlier injection as a user
// fact, so they never enter the seed.
const SEED_EVENT_TYPES = new Set([
  'user/message', 'assistant/message', 'tool/call', 'tool/result',
  'turn/start', 'turn/end', 'step/start', 'step/end',
])

function capSeedText(value, limit = SEED_TEXT_CHARS) {
  const text = String(value ?? '')
  return text.length > limit ? text.slice(0, limit) + '…[已截断]' : text
}

function cloneSeedBlocks(blocks, caps = {}, seenToolText = null) {
  const textCap = Number(caps.text) > 0 ? Number(caps.text) : SEED_TEXT_CHARS
  const toolCap = Number(caps.tool) > 0 ? Number(caps.tool) : SEED_TOOL_CALL_CHARS
  const out = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'reasoning') continue
    if (block.type === 'image') { out.push({ type: 'text', text: '[图片/附件]' }); continue }
    if (block.type !== 'text' && block.type !== 'tool-call') { out.push(block); continue }
    if (block.type === 'tool-call') {
      out.push({ ...block, arguments: capSeedText(block.arguments, toolCap) })
      continue
    }
    const text = String(block.text || '')
    // Role cards, emoji catalogs and full unread snapshots repeat verbatim across
    // turns; one copy is enough to summarise what the tool returned.
    if (seenToolText && text && seenToolText.has(text)) {
      out.push({ ...block, text: '[与前面相同的工具输出，已省略]' })
      continue
    }
    if (seenToolText && text) seenToolText.add(text)
    out.push({ ...block, text: capSeedText(text, textCap) })
  }
  return out
}

/**
 * Build the seed body for one window: only conversation events, with reasoning /
 * replay state / repeated tool output removed, then renumbered seq 0..n so
 * Session's "contiguous from zero" rule holds. The optional catalog event takes
 * seq 0 and is the only synthetic message.
 */
export function compactSeedEvents(events, catalogEvent = null) {
  const kept = []
  const seenToolText = new Set()
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object' || !SEED_EVENT_TYPES.has(event.type)) continue
    if (event.type === 'user/message' && event.data?.source?.kind !== 'user') continue
    const clone = { ...event, data: { ...(event.data || {}) } }
    if (event.type === 'assistant/message') {
      const message = { ...(event.data?.message || {}) }
      const source = { ...(message.source || {}) }
      // The replay state duplicates the response body; it is not conversation.
      delete source.replayState
      message.source = source
      message.content = cloneSeedBlocks(message.content, { text: SEED_TEXT_CHARS, tool: SEED_TOOL_CALL_CHARS })
      if (message.content.length === 0) message.content = [{ type: 'text', text: '（本轮没有可读的正文）' }]
      clone.data.message = message
      // data.stream is the raw chunk log, not the message the model saw. It must
      // stay present as an (empty) array: DSH 0.2.2-rc.1's seed validation
      // (assertAssistantSettlementShape) requires data.stream to be an array, and
      // deleting it made every consolidation fork seed fail with "invalid
      // settlement fields". An empty array keeps the noise-down intent — the
      // chunks never enter the seed — while satisfying the newer host check;
      // older hosts don't validate the field at all, so this is inert there.
      // 实测（0.2.2-rc.1 自带 Session + 真实会话事件）：删 stream → 拒；[] → 过。
      clone.data.stream = []
    } else if (event.type === 'tool/result') {
      const message = { ...(event.data?.message || {}) }
      message.content = cloneSeedBlocks(message.content, { text: SEED_TOOL_RESULT_CHARS, tool: SEED_TOOL_CALL_CHARS }, seenToolText)
      if (message.content.length === 0) message.content = [{ type: 'text', text: '[空工具输出]' }]
      clone.data.message = message
    } else if (event.type === 'tool/call') {
      clone.data.arguments = capSeedText(event.data?.arguments, SEED_TOOL_CALL_CHARS)
    } else if (event.type === 'user/message') {
      clone.data.content = cloneSeedBlocks(event.data?.content, { text: SEED_TEXT_CHARS })
      const timeLabel = eventTimeLabel(event)
      if (timeLabel) clone.data.content.unshift({ type: 'text', text: `[事件时间 ${timeLabel}]` })
    }
    kept.push(clone)
  }

  const mapping = new Map()
  kept.forEach((event, index) => mapping.set(Number(event.seq), index + (catalogEvent ? 1 : 0)))
  const out = catalogEvent ? [{ ...catalogEvent, seq: 0 }] : []
  kept.forEach((event, index) => {
    const next = { ...event, seq: index + (catalogEvent ? 1 : 0) }
    if (Array.isArray(next.sourceEventSeqs)) {
      const mapped = [...new Set(next.sourceEventSeqs
        .map(value => mapping.get(Number(value)))
        .filter(value => Number.isInteger(value) && value < next.seq))]
        .sort((a, b) => a - b)
      if (mapped.length) next.sourceEventSeqs = mapped
      else delete next.sourceEventSeqs
    }
    // A surface replace cites the nodes it shadows; if any citation was dropped
    // with the noise filter, replaying it would fail validation. Dropping the
    // whole patch is the safe choice — the seed is evidence, not state.
    if (next.surfaceOp && typeof next.surfaceOp === 'object' && !Array.isArray(next.sourceEventSeqs)) return
    out.push(next)
  })
  return out
}

/** Existing entries, compact, for dedupe/update instead of duplicate writes. */
export function memoryCatalogEvent(binding, now = Date.now()) {
  if (!binding?.libraryId) return null
  let entries = []
  try { entries = Object.entries(loadPrivateIndex(binding.libraryId).entries || {}) } catch { return null }
  const rows = entries
    .filter(([, entry]) => entry && isMemoryEligible(entry, { automatic: true, now }))
    .filter(([, entry]) => visibleToSession(entry, binding.sessionId))
    .sort((a, b) => String(b[1].updatedAt || b[1].createdAt || '').localeCompare(String(a[1].updatedAt || a[1].createdAt || '')))
    .slice(0, SEED_CATALOG_ENTRIES)
    .map(([id, entry]) => `- [${id}] ${capSeedText(entry.title || '(untitled)', 120)} · ${entry.layer || 'long_term'} · ${entry.status || 'active'}`)
  if (rows.length === 0) return null
  const text = [
    '[memory-catalog · 已有记忆目录（只读上下文，不是用户发言，也不属于本轮转录）]',
    '下面这些是本次整理之前已经写入本库的条目。不要当作用户说过的话，也不要重复创建；同一事实用 memu_private_update id=<id> 合并，真正新增的内容才用 memu_private_remember。',
    ...rows,
  ].join('\n')
  return {
    type: 'user/message',
    seq: 0,
    time: now,
    data: createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin:dsh-memu-memory', form: 'notice', summary: 'memory-catalog' },
    }),
    surfaceOp: 'append',
  }
}

/** First `limit` events, trimmed back to a complete turn so a fork never sees half a step. */
export function selectConsolidationWindow(events, limit = CONSOLIDATION_WINDOW_EVENTS) {
  const list = (Array.isArray(events) ? events : []).filter(event => eventSeq(event) !== null)
  if (list.length === 0) return { events: [], fromSeq: null, throughSeq: null, remaining: 0 }
  if (list.length <= limit) return { events: list, fromSeq: eventSeq(list[0]), throughSeq: eventSeq(list[list.length - 1]), remaining: 0 }
  const cutSeq = eventSeq(list[Math.max(0, limit - 1)])
  const sliced = list.filter(event => eventSeq(event) <= cutSeq)
  const safe = safePrefix(sliced, { requireClosedTurn: false })
  const window = safe.ok && safe.events.length > 0 ? safe.events : sliced
  const throughSeq = eventSeq(window[window.length - 1])
  return {
    events: window,
    fromSeq: eventSeq(window[0]),
    throughSeq,
    remaining: list.filter(event => eventSeq(event) > throughSeq).length,
  }
}

/** Last complete turn window, for a manual re-check when the cursor is already at the end. */
export function selectTailTurnWindow(events, limit = CONSOLIDATION_WINDOW_EVENTS) {
  const list = (Array.isArray(events) ? events : []).filter(event => eventSeq(event) !== null)
  const slice = list.slice(-limit)
  if (slice.length === 0) return { events: [], fromSeq: null, throughSeq: null, remaining: 0 }
  let start = slice.findIndex(event => event.type === 'turn/start')
  if (start < 0) start = slice.findIndex(event => event.type === 'user/message')
  if (start < 0) return { events: [], fromSeq: null, throughSeq: null, remaining: 0 }
  for (let i = start - 1; i >= 0; i -= 1) {
    if (slice[i].type === 'user/message' && slice[i].data?.source?.kind === 'user') { start = i; break }
    if (slice[i].type === 'turn/end' || slice[i].type === 'turn/start') break
  }
  const window = slice.slice(start)
  const safe = safePrefix(window, { requireClosedTurn: false })
  const chosen = safe.ok && safe.events.length > 0 ? safe.events : window
  return { events: chosen, fromSeq: eventSeq(chosen[0]), throughSeq: eventSeq(chosen[chosen.length - 1]), remaining: 0 }
}

export async function requestPrivateConsolidation(ctx, sessionId, options = {}) {
  const binding = getSessionBinding(sessionId)
  if (!binding) return { ok: false, error: 'session is not bound to a memory library; bind it first' }
  if (!binding.libraryId || !effectiveScope(binding).useLibrary) return { ok: false, error: 'private memory is disabled for this session or folder' }
  // Always a fork, never the live session's own inbox. `agent.followup` on the
  // chat the user is looking at does queue a real turn — but the host renders a
  // queued next-turn message as a pending draft above the composer (editable,
  // deletable, sent on demand), and once it runs it stays in that transcript
  // forever, re-sent on every later turn. A live session is no exception: the
  // fork seeds the same transcript, so recall quality is unchanged, while the
  // housekeeping turn lands in a scratch subagent session (origin: subagent —
  // out of the window list and out of the injection path) that is disposed.
  return requestHistoricalConsolidation(ctx, sessionId, options)
}

// Remote mode: the configured remote chat endpoint writes the memories, then they
// are committed through the same backend. No local agent or tool chain is touched.
export async function requestRemoteConsolidation(ctx, sessionId, { signal, timeoutMs, force = false } = {}) {
  const binding = getSessionBinding(sessionId)
  if (!binding) return { ok: false, error: 'session is not bound to a memory library; bind it first' }
  if (!binding.libraryId || !effectiveScope(binding).useLibrary) return { ok: false, error: 'private memory is disabled for this session or folder' }
  const sessionQuery = ctx.get?.('sessionQuery')
  if (!sessionQuery) return { ok: false, error: 'host has no sessionQuery; cannot read this conversation' }
  try {
    const snapshot = await readSessionSnapshot(sessionQuery, sessionId)
    const events = Array.isArray(snapshot?.events) ? snapshot.events : []
    if (events.length === 0) return { ok: false, error: 'this session has no content to consolidate' }
    const fresh = unconsolidatedEvents(binding, events)
    if (!force) {
      const value = assessConsolidationValue(fresh)
      if (!value.worth) return { ok: true, sessionId, backend: 'api', count: 0, skipped: value.reason, assessment: value }
    }
    const transcript = condenseEvents(fresh, 60_000)
    const library = binding.libraryId ? getLibrary(binding.libraryId) : null
    const memories = await summarizeRemote({
      transcript,
      libraryName: library ? `${library.name} (${library.id})` : '(unbound)',
      domain: domainOf(binding),
      signal,
      timeoutMs,
    })
    // 写入计数必须说真话：`memories` 是模型给的清单，逐条 privateRemember 可能被
    // 事实级去重拒绝（deduped，不落库）或因矛盾暂扣（pending_review，仅入索引）。
    // count 只数真正落库的；被拒/暂扣分列进 detail，否则"写入 N 条"就是误报。
    let written = 0
    let deduped = 0
    let held = 0
    for (const memory of memories) {
      const outcome = await privateRemember({
        ...memory,
        exec: { agent: { session: { header: { id: sessionId } } } },
        content: memory.content,
        title: memory.title || memory.content,
        tags: memory.tags,
        openLoop: memory.openLoop,
        confidence: memory.confidence,
        source: memory.source || 'inferred',
      })
      if (outcome?.deduped === true) deduped += 1
      else if (outcome?.entry?.status === 'pending_review') held += 1
      else written += 1
    }
    setSessionBinding(sessionId, { lastSleepSeq: events[events.length - 1]?.seq })
    const result = { ok: true, sessionId, backend: 'api', count: written, deduped, held }
    record({
      kind: 'consolidate', scope: 'private', sessionId, libraryId: binding.libraryId || null, ok: true,
      message: `整理完成（远程）· 写入 ${written}`
        + (deduped ? ` · 去重拦下 ${deduped}` : '')
        + (held ? ` · 待复核 ${held}` : ''),
      detail: { ...result, forced: force },
    })
    return result
  } catch (error) {
    record({
      kind: 'consolidate', scope: 'private', sessionId, libraryId: binding.libraryId || null, ok: false, level: 'error',
      message: '整理失败（远程）：' + String(error?.message || error),
      detail: { forced: force },
    })
    return { ok: false, error: String(error?.message || error) }
  }
}

// `buildForkSeed` lives in dsh-session, which this plugin does not need for
// anything else. Imported lazily so a host that does not expose it loses only
// historical consolidation, not the whole plugin half.
async function loadBuildForkSeed() {
  try {
    const mod = await import('@deepseek-ai/dsh-session')
    return typeof mod?.buildForkSeed === 'function' ? mod.buildForkSeed : null
  } catch {
    return null
  }
}

function agentOptionsFromConfig(config) {
  if (!config || typeof config !== 'object') return null
  const provider = typeof config.provider === 'string' ? config.provider.trim() : ''
  const model = typeof config.model === 'string' ? config.model.trim() : ''
  if (!provider || !model) return null
  const options = { provider, model }
  if (typeof config.reasoningEffort === 'string' && config.reasoningEffort) options.reasoningEffort = config.reasoningEffort
  if (Number.isSafeInteger(config.maxTokens) && config.maxTokens > 0) options.maxTokens = config.maxTokens
  return options
}

// A fork starts a fresh agent loop, so it does not inherit the parent's Agent options.
// The parent's live request header is the route that actually served its latest turn;
// an older request/header event is the only equivalent for a closed session. Without
// one of these, the standard preset cannot resolve {{model}} and every fork dies before
// its first step, so refuse to create that fork instead of queueing another doomed seed.
function inheritedAgentOptions(ctx, sessionId, events) {
  let live
  try { live = ctx.get?.('agents')?.get?.(sessionId) } catch {}
  try {
    const fromRequest = agentOptionsFromConfig(live?.session?.requestHeader?.()?.config)
    if (fromRequest) return fromRequest
  } catch {}
  const fromLive = agentOptionsFromConfig(live?.options)
  if (fromLive) return fromLive
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type !== 'request/header') continue
    const fromEvent = agentOptionsFromConfig(events[i]?.data?.header?.config)
    if (fromEvent) return fromEvent
  }
  return null
}

function turnEndFailure(event) {
  const reason = event?.data?.reason
  if (!reason || typeof reason !== 'object') return 'the fork produced no turn/end event'
  if (reason.kind === 'completed') return null
  const message = reason?.error?.message || reason?.reason?.message || reason?.message
  return 'the fork turn ended ' + (reason.kind || 'without a reason') + (message ? ': ' + message : '')
}

// PTC 兼容（2026-10-31 现场 worker-tools-ptc-only）：PTC 会话的 header 工具表只有
// run_code，其余工具走 run_code 程序里的 SDK 绑定（宿主 ptc.ts 用
// tools.schemas(agent, toolSet) 枚举"调用 agent 的可见面"）。preset 组合没列出本插件
// 时，fork 的注册表里根本没有 memu_*，worker 既不能原生调用也没有 SDK 绑定，回执只能
// 是 tools-unavailable。修法与 preset-scope.js 的注入挂载同构：把 worker 读写面挂进 fork
// 自己的 ctx scope —— 注册表按 scope 链取可见面，所以只对这个 worker 可见，不扩散到
// 其它会话；挂载点必须在 followup 之前（宿主在 step 开始时 resolve 一次 admitted set，
// 之后注册的工具不进本步）。失败不阻断整理：worker 会按任务书如实回执 tools-unavailable。
async function attachWorkerTools(agents, childId, parentId) {
  const wanted = [...WORKER_WRITE_TOOLS, ...WORKER_READ_TOOLS]
  const ctxOf = (record) => {
    try { return record?.ctx || record?.agent?.ctx || null } catch { return null }
  }
  let parentHasCtx = null
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let record = null
    try { record = agents.get?.(childId) || null } catch { record = null }
    if (record) {
      const actx = ctxOf(record)
      // 有记录但没有 ctx：这版宿主不暴露 agent context（preset-scope.js 的同款限制），
      // 重试不会变出来。ctx 在但没有 tools 服务：组合里就没有。两者都直接放弃。
      if (!actx || !(actx.tools && typeof actx.tools.register === 'function')) break
      try {
        const dispose = registerTools(actx, { only: wanted })
        // tools.js 在 disposer 上附挂实际注册成功的名单（编译 + register 都过的那部分）。
        // 读它，不再把 wanted 全量当成"已挂载"——部分挂载必须结构化可见。
        const attached = Array.isArray(dispose?.attached) ? [...dispose.attached] : null
        return {
          dispose,
          attached,
          requested: wanted,
          // 名单缺失 = 无法证明挂全：partial 照实标 true，attached 落 null（与失败同口径）。
          partial: attached ? attached.length < wanted.length : true,
        }
      } catch (error) {
        warn('consolidation worker tool attach failed: ' + String(error?.message || error))
        return null
      }
    }
    // 子记录还没出现：只在这个宿主确实会暴露 ctx（父记录带 ctx）时才值得短退避等它。
    if (parentHasCtx === null) parentHasCtx = Boolean(ctxOf(agents.get?.(parentId)))
    if (!parentHasCtx) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  warn('consolidation worker has no tools service on its own context; the worker may be unable to write memories')
  return null
}

// 活动日志"整理已开始"条目的挂载元数据口径（workerTools* 三件）：
//   workerToolsAttached  实际注册成功的工具名数组；null = 挂载没有完成或无法确认
//                        （fork ctx 无 tools 服务、register 抛错、宿主没回名单），
//                        与"挂全了"严格区分——这正是旧字段把 wanted 全量误报成
//                        已挂载的教训。
//   workerToolsRequested 请求挂载的完整 wanted 名单；与 attached 全等才是全量挂载。
//   workerToolsPartial   true = 未证明 worker 拿到完整 wanted 集（子集、空集、或挂载
//                        整体失败）。刻意把"一件都没挂上"也标 true：若失败标 false，
//                        false 会被一眼读成"全量挂载"，元数据又不准了。
function workerToolsMeta(workerTools) {
  const wanted = [...WORKER_WRITE_TOOLS, ...WORKER_READ_TOOLS]
  if (!workerTools) {
    return { workerToolsAttached: null, workerToolsRequested: wanted, workerToolsPartial: true }
  }
  return {
    workerToolsAttached: Array.isArray(workerTools.attached) ? workerTools.attached : null,
    workerToolsRequested: Array.isArray(workerTools.requested) ? workerTools.requested : wanted,
    workerToolsPartial: workerTools.partial === true,
  }
}

const inFlight = new Map()
// How long a cancelled fork gets to finish the tool call it was in the middle of.
// Bounded on purpose: a child that ignores the cancel must not hang the sweep, and
// the alternative — disposing immediately — is what let a write land after the range
// was already handed back to pending.
const WORKER_STOP_GRACE_MS = 5_000

// 这里的 import 刻意写在语句之后：lib/binding-diagnostics.js 的 RUNTIME_STATE 把 `inFlight`
// 的 file:line 当成诊断契约（当前 lib/private.js:535），修改位置时同步更新该诊断映射，
// 而那是别人的文件、本包不改。ESM 的 import 声明是提升的，写在语句之后合法。
import { warn } from './paths.js'
import { captureSessionSnapshot, eventSeq, safePrefix, snapshotHash } from './consolidation-snapshot.js'
import {
  beginJob, completeJob, failJob, findOperation, noteEvidence, operationKey,
  recoverStaleJobs, recordOperation, scopeGenerationOf, clearSessionState, skipRange,
} from './consolidation-ledger.js'
import { decideCompletion, receiptContractText } from './consolidation-receipt.js'
import { buildWorkerBrief, probeToolSurface, WORKER_READ_TOOLS, WORKER_WRITE_TOOLS } from './consolidation-worker.js'
import { isGoneSessionError } from './cycle.js'
import { autoLinkPrivateMemories } from './private-links.js'
import { registerTools } from './tools.js'
import { resolveConsolidationAgentOptions, ensureConsolidationRoute } from './fork-model.js'

// 账本异常必须可见；调用方只有拿到明确的持久租约才可启动 worker。
// 其余读写失败返回保守结果，不得据此推进已确认边界。
function safeLedger(action, fallback = null) {
  try {
    return action()
  } catch (error) {
    try { warn('consolidation ledger: ' + String(error?.message || error)) } catch {}
    return fallback
  }
}

// 交给结果日志的快照身份：有 hash、有边界、没有正文。
function snapshotMetaOf(snapshot) {
  if (!snapshot) return null
  return {
    hash: snapshot.hash,
    source: snapshot.source,
    fromSeq: snapshot.fromSeq,
    throughSeq: snapshot.throughSeq,
    eventCount: snapshot.eventCount,
    droppedEvents: snapshot.droppedEvents,
    capturedAt: snapshot.capturedAt,
  }
}

// Every agent-backend consolidation runs here, live sessions included: the same
// main agent, on a seeded copy of the transcript, writing into the library the
// original used. In-place consolidation would append a housekeeping turn to the
// user's own chat — a queued draft until it runs, then a permanent resident of
// that transcript — so the one visible difference between a live and a closed
// session is that a closed one has to be read back from disk first.
// 一次整理要等多长时间，取决于它要读多少转录：fork 的种子是整段会话，worker 读完才
// 开始写。实测（2026-11-02，935 条事件的会话）：第一次 180 s 到点时刚写完 3 条、
// 退避重试 131 s 完成——即约 0.14–0.2 s/事件。这里按 0.35 s/事件（≈2 倍余量）推预算，
// 并夹在 [420 s, 600 s]：慢推理模型（GLM-5.3-Flash 实测）单次 worker 回合就能吃满
// 180 s 旧下限且一个工具都没调（1.2.7 后内部评测复现），下限抬到 7 分钟给长思考留
// 余量；600 s 封顶不变，卡死的 fork 仍会在 10 分钟内被收掉。显式传 maxWaitMs 的
// 调用（含工具/测试）原样生效。
export const CONSOLIDATION_WAIT_POLICY = Object.freeze({
  baseMs: 120_000,
  perEventMs: 350,
  minMs: 420_000,
  maxMs: 600_000,
})

export function consolidationWaitBudget(eventCount, policy = CONSOLIDATION_WAIT_POLICY) {
  const count = Number.isFinite(Number(eventCount)) ? Math.max(0, Math.floor(Number(eventCount))) : 0
  const raw = policy.baseMs + count * policy.perEventMs
  return Math.min(policy.maxMs, Math.max(policy.minMs, raw))
}

export async function requestHistoricalConsolidation(ctx, sessionId, options = {}) {
  const { maxWaitMs = null, force = false, trigger = null } = options
  const binding = getSessionBinding(sessionId)
  if (!binding) return { ok: false, error: 'session is not bound to a memory library; bind it first' }
  if (!binding.libraryId || !effectiveScope(binding).useLibrary) return { ok: false, error: 'private memory is disabled for this session or folder' }
  if (inFlight.has(sessionId)) return { ok: false, error: 'this session is already being consolidated', running: true }

  // The session is claimed before the first await. readSession and agents.create
  // both yield, so two callers arriving in the same tick used to pass the guard
  // together and fork the same transcript twice.
  const abort = new AbortController()
  inFlight.set(sessionId, abort)
  let handle = null
  let offSession = null
  let idle = null
  // Stopped once, callable twice: the timeout path and `finally` both need it.
  let stopped = false
  // The host's own order is cancel -> whenIdle -> dispose. dispose() alone does not
  // wait for a tool call in flight, and this fork writes memories *through tools*, so
  // "the fork was stopped" was not true when the timeout path returned: failJob had
  // already handed the range back and the next pass could fork the same window while
  // the old child was still writing. Bounded, because a child that ignores the cancel
  // must not hang the sweep.
  const stopWorker = async () => {
    if (stopped) return
    stopped = true
    try { abort.abort() } catch {}
    try { offSession?.() } catch {}
    if (idle) {
      try {
        await Promise.race([
          idle.then(() => {}, () => {}),
          // Deliberately NOT unref'd: this promise is what we are awaiting, so an
          // unref'd timer lets the event loop drain while the await is still pending
          // and the caller (or the test runner) is left holding a promise that can
          // never settle. A <=5s hold on the loop is the correct trade.
          new Promise((resolve) => setTimeout(resolve, WORKER_STOP_GRACE_MS)),
        ])
      } catch {}
    }
    try { await handle?.dispose?.() } catch {}
  }
  let turnEnd = null
  let jobId = null
  let scopeChanged = null
  let workerTools = null
  const assistantTexts = []
  let childId = null
  // 每次整理都要在活动日志里留一条：谁触发（手动/空闲）、fork 有没有建、结果是完成、
  // 超时还是失败。否则"点了没反应"只能靠翻会话文件才知道发生了什么。
  const finish = (result) => {
    const ok = result?.ok === true
    const skipped = Boolean(result?.skipped)
    const skipText = !skipped
      ? ''
      : (['small-talk', 'no-human-turn', 'no-value', 'no-new-events'].includes(result.skipped)
        ? '跳过（没有值得记的内容）'
        : '跳过 · ' + result.skipped)
    record({
      kind: 'consolidate',
      scope: 'private',
      sessionId,
      libraryId: binding.libraryId || null,
      ok,
      level: ok ? 'info' : (result?.timedOut ? 'warn' : 'error'),
      message: '整理' + (ok ? (skipped ? skipText : '完成') : (result?.timedOut ? '超时' : '失败'))
        + (force ? ' · 手动' : (options.trigger === 'backlog' ? ' · 水位' : ' · 空闲'))
        + (result?.childId ? ' · fork ' + result.childId.slice(-8) : '')
        + (result?.reasonCode ? ' · ' + result.reasonCode : '')
        + (result?.error ? '：' + String(result.error) : '')
        + (result?.count !== undefined ? ' · 写入 ' + result.count : '')
        + (result?.wrote !== null && result?.wrote !== undefined ? ' · 索引 +' + result.wrote : '')
        + (result?.scanned !== undefined ? ' · 扫描 ' + result.scanned + ' 事件 / 新 ' + (result.fresh ?? '?') : ''),
      detail: { force, jobId, ...result },
      refs: [],
    })
    return result
  }
  try {
    // 僵尸租约先回收：进程被杀之后 inflight 会留在账本里，不能让一条死记录永久挡住这个会话。
    safeLedger(() => {
      const recovered = recoverStaleJobs()
      if (recovered.length > 0) {
        record({ kind: 'check', scope: 'private', ok: true, message: '回收 ' + recovered.length + ' 个过期整理租约', detail: { recovered } })
      }
      return recovered
    })

    // 读不到会话就什么都不用谈，所以先确认快照能力，再确认 fork 能力——
    // 失败信息要说清缺的是哪一个（readSession/observeSession 还是 agents.create）。
    const sessionQuery = (() => { try { return ctx.get?.('sessionQuery') || null } catch { return null } })()
    if (!sessionQuery || (typeof sessionQuery.readSession !== 'function' && typeof sessionQuery.observeSession !== 'function')) {
      return finish({
        ok: false, sessionId, code: 'unavailable', reasonCode: 'no-session-query', settled: false,
        error: 'host has no sessionQuery.readSession / observeSession; historical consolidation is unavailable',
      })
    }
    const agents = ctx.get?.('agents')
    if (typeof agents?.create !== 'function') {
      return finish({ ok: false, sessionId, code: 'unavailable', reasonCode: 'no-agents-service', settled: false, error: 'host has no agents.create; historical consolidation is unavailable' })
    }
    const buildForkSeed = await loadBuildForkSeed()
    if (!buildForkSeed) {
      return finish({ ok: false, sessionId, code: 'unavailable', reasonCode: 'no-fork-seed', settled: false, error: 'dsh-session buildForkSeed is unavailable' })
    }

    // 安全快照：cut 固定、身份可核验。未闭合的回合、没配对的工具调用、半截 step 在这里就被挡住，
    // 而不是被当成内容喂给 worker（C 包第 1、2 条）。拿不到就 deferred，不收编。
    const captured = await captureSessionSnapshot(ctx, sessionId, { signal: abort.signal })
    if (!captured.ok) {
      if (captured.code === 'deferred') {
        return finish({ ok: true, sessionId, skipped: captured.reasonCode, settled: false, deferred: true, reasonCode: captured.reasonCode, detail: captured.error })
      }
      // 会话已被删除（host 回答 not found）是正常生命周期，不是整理故障：标记
      // sessionGone（空闲扫描从此跳过）、记 info 级 check 而不是 error——删除的
      // 对话不该在整理提醒里挂一条失败（2026-10-31 用户报告）。
      if (isGoneSessionError(captured.error)) {
        setSessionBinding(sessionId, { sessionGone: true, sessionGoneAt: new Date().toISOString(), sleepRetryAt: null, sleepAttempts: 0, lastSleepError: null })
        try { clearSessionState(sessionId) } catch {}
        record({
          kind: 'check', scope: 'private', sessionId, libraryId: binding.libraryId || null, ok: true,
          message: '对话已删除，不再整理（session not found）',
          detail: { reasonCode: 'session-gone' },
        })
        return { ok: false, sessionId, code: 'session-gone', reasonCode: 'session-gone', settled: false, retryable: false, error: captured.error }
      }
      return finish({
        ok: false, sessionId, code: captured.code, reasonCode: captured.reasonCode, settled: false,
        retryable: captured.retryable === true, error: captured.error,
      })
    }
    const fullSnapshot = captured.snapshot
    const events = captured.events
    const fresh = unconsolidatedEvents(binding, events)
    if (events.length === 0) return finish({ ok: false, sessionId, reasonCode: 'empty-snapshot', settled: false, error: 'this session has no content to consolidate' })
    // A manual click on an already-settled session still re-checks the tail instead
    // of replaying megabytes; automatic runs only look at what the cursor has not
    // covered. Either way the fork gets one bounded window, not the whole log.
    const candidateEvents = force && fresh.length === 0 ? selectTailTurnWindow(events).events : fresh
    if (candidateEvents.length === 0) {
      return finish({ ok: true, sessionId, skipped: 'no-new-events', settled: true, snapshot: snapshotMetaOf(fullSnapshot) })
    }
    const generationAtStart = scopeGenerationOf(binding)
    // 待检查边界与已确认边界分开记：证据到达就记一次，失败不回退。
    safeLedger(() => noteEvidence({ sessionId, fromSeq: fullSnapshot.fromSeq, throughSeq: fullSnapshot.throughSeq }))

    let value = null
    if (!force) {
      value = assessConsolidationValue(candidateEvents)
      // 这一批里没有真人回合、或只有一句「好的继续」：这一段确实没什么可整理的，
      // 是终态而不是 deferral——写入完成边界由 cycle 落到 lastSleepAt，下一次真人
      // 消息到达前不再重扫同一个寒暄窗口。
      if (!value.worth) {
        // A terminal policy skip advances the coarse cursor and checked range:
        // otherwise the same greetings stay pending forever and the sweep keeps
        // treating them as a real backlog.
        safeLedger(() => skipRange({ sessionId, snapshot: fullSnapshot, reasonCode: value.reason }))
        setSessionBinding(sessionId, { lastSleepSeq: fullSnapshot.throughSeq })
        return finish({
          ok: true, sessionId, skipped: value.reason, settled: true, deferred: false,
          reasonCode: value.reason, assessment: value, snapshot: snapshotMetaOf(fullSnapshot),
        })
      }
      const settings = getSettings()
      // 事件/回合水位：积压到一定规模就直接整理，不再等评分。它和空闲触发是
      // 两条腿：空闲保证收尾，水位保证一场持续几小时的会话不会攒到几千条才动。
      const backlog = candidateEvents.length >= CONSOLIDATION_BACKLOG_EVENTS
        || Number(value.humanTurns) >= CONSOLIDATION_BACKLOG_TURNS
      if (options.trigger === 'backlog' && !backlog) {
        return finish({
          ok: true, sessionId, skipped: 'backlog-below-threshold', settled: false, deferred: true,
          reasonCode: 'backlog-below-threshold', assessment: value, snapshot: snapshotMetaOf(fullSnapshot),
          trigger: options.trigger,
        })
      }
      if (!backlog) {
        // 加权判定：短空闲要求分数达标，长空闲（饥饿阈值）无条件放行；
        // 阈值与权重集中在 lib/active-memory.js，可根据回放标定。
        const idleMinutes = binding.lastTurnAt ? (Date.now() - (Date.parse(binding.lastTurnAt) || Date.now())) / 60_000 : Infinity
        const starved = idleMinutes >= Number(settings.activeMemoryStarvationMinutes ?? ACTIVE_MEMORY_POLICY.starvationMinutes)
        const evidence = collectEvidence(candidateEvents)
        const wake = assessWake({
          evidence,
          starved,
          transcriptEvents: events.length,
          pendingEvents: candidateEvents.length,
          policy: { ...ACTIVE_MEMORY_POLICY, minScore: Number(settings.activeMemoryMinScore ?? ACTIVE_MEMORY_POLICY.minScore) },
        })
        record({
          kind: 'check',
          scope: 'private',
          sessionId,
          libraryId: binding.libraryId || null,
          ok: wake.wake,
          message: (wake.wake ? '主动检查触发' : '主动检查跳过')
            + ' · score ' + wake.score
            + ' · ' + wake.reason
            + ' · 空闲 ' + (Number.isFinite(idleMinutes) ? Math.round(idleMinutes) + ' 分钟' : '未知')
            + ' · 会话 ' + events.length + ' 事件'
            + ' · 待整理 ' + candidateEvents.length + ' 事件'
            + ' · 快照 ' + fullSnapshot.hash,
          detail: { trigger: options.trigger || 'idle', reason: wake.reason, score: wake.score, parts: wake.parts, starved, transcriptEvents: events.length, pendingEvents: candidateEvents.length, snapshot: snapshotMetaOf(fullSnapshot) },
        })
        if (!wake.wake) return finish({ ok: true, sessionId, skipped: 'low-score', settled: false, assessment: value, score: wake.score, parts: wake.parts, snapshot: snapshotMetaOf(fullSnapshot) })
      }
    }

    // One bounded window per run: the next sweep continues from the new cursor.
    const window = selectConsolidationWindow(candidateEvents)
    if (window.events.length === 0) {
      return finish({ ok: true, sessionId, skipped: 'empty-window', settled: true, snapshot: snapshotMetaOf(fullSnapshot) })
    }
    const windowSnapshot = {
      ...fullSnapshot,
      fromSeq: window.fromSeq,
      throughSeq: window.throughSeq,
      eventCount: window.events.length,
      hash: snapshotHash(window.events, window.fromSeq, window.throughSeq),
    }
    const snapshot = windowSnapshot
    const snapshotMeta = snapshotMetaOf(windowSnapshot)
    // 范围大小决定等多久：显式给了就听调用方的，没给按这一窗的事件数推。
    const budgetMs = Number.isInteger(maxWaitMs) && maxWaitMs > 0 ? maxWaitMs : consolidationWaitBudget(window.events.length)
    const seedEvents = compactSeedEvents(window.events, memoryCatalogEvent({ ...binding, sessionId }))
    if (seedEvents.length === 0) {
      return finish({ ok: true, sessionId, skipped: 'empty-seed', settled: true, snapshot: snapshotMeta })
    }

    // 幂等：同一份固定快照已经结算过就不再 fork 一次（失败的部分写入靠操作键判同再试，
    // 而不是靠"同一个主题就跳过"）。
    const opKey = operationKey({ sessionId, libraryId: binding.libraryId, snapshotHash: windowSnapshot.hash, scopeGeneration: generationAtStart })
    const previous = safeLedger(() => findOperation(sessionId, opKey))
    if (previous && (previous.outcome === 'completed' || previous.outcome === 'skipped')) {
      return finish({ ok: true, sessionId, skipped: 'already-consolidated', settled: true, snapshot: snapshotMeta, credential: previous })
    }
    // 同一份快照连续失败到上限就不再重跑：窗口已经很小，重试成本可控，但
    // 没有新事件的同一段转录不值得无限重试。新消息会改变快照哈希，重新获得机会。
    if (previous?.outcome === 'failed' && Number(previous.failures) >= CONSOLIDATION_SNAPSHOT_FAILURE_LIMIT) {
      return finish({
        ok: true, sessionId, skipped: 'snapshot-failed', settled: true, reasonCode: 'snapshot-failed-too-many',
        snapshot: snapshotMeta, failures: Number(previous.failures) || 0,
      })
    }

    // 工具面必须可验证：父会话这一轮真实发给模型的工具表里若没有记忆写工具，
    // fork 同样不会有——那就不 fork，明确 unavailable（C 包第 3 条）。
    const probe = probeToolSurface({ ctx, sessionId, events })
    if (!probe.ok) {
      return finish({
        ok: false, sessionId, code: 'unavailable', reasonCode: probe.reasonCode, settled: false, retryable: false,
        toolSurface: probe.tools || null, ptc: probe.ptcObserved === true,
        error: 'this conversation exposes no memory write tool to the model (' + String(probe.source || 'unknown') + '), so a consolidation worker could not write anything; consolidation is unavailable until the session has memu_private_remember / memu_private_update',
      })
    }

    jobId = 'cons-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex')
    const begun = safeLedger(() => beginJob({ sessionId, jobId, snapshot, binding }))
    if (!begun) {
      return finish({
        ok: false, sessionId, settled: false, retryable: true, reasonCode: 'ledger-unavailable',
        error: 'the consolidation lease could not be persisted; no worker was created',
      })
    }
    if (begun.ok !== true) {
      return finish({
        ok: false, sessionId, running: true, settled: false, reasonCode: 'lease-held',
        error: 'this session already holds a consolidation lease (' + String(begun.jobId) + ' until ' + new Date(begun.leaseUntil).toISOString() + '); the previous run is still unaccounted for',
      })
    }

    const header = captured.header || {}
    // 每次整理都留"看了多少、新的多少、真正写了几条"，否则"0 记忆"无法定位是
    // 没触发、被门挡住还是提取空转。
    const freshCount = fresh.length
    let beforeIds = null
    let beforeEntries = null
    try {
      const beforeIndex = loadPrivateIndex(binding.libraryId)
      beforeIds = new Set(Object.keys(beforeIndex.entries))
      beforeEntries = Object.fromEntries(Object.entries(beforeIndex.entries).map(([id, entry]) => [id, entryFingerprint(entry)]))
    } catch { beforeIds = null; beforeEntries = null }

    // 整理 fork 的模型选择（三模式，lib/fork-model.js）。inherit 保持原路径逐字节一致；
    // host 直接指名宿主已激活 route；custom 要先在宿主 llm 注册表确认本插件私有 route
    // 可用（能力缺失/注册失败/服务性探测不过 → 降级回 inherit 或拒绝本次整理，warn 一
    // 行，绝不 fail closed）。fork 的 AgentOptions 没有 baseURL/apiKey 通道，custom 的
    // 自定义端点只能走注册 route。
    const settings = getSettings()
    const inherited = inheritedAgentOptions(ctx, sessionId, events)
    const resolved = resolveConsolidationAgentOptions(settings, inherited)
    let agentOptions = resolved.options
    let modelMode = resolved.reason
    if (!agentOptions) {
      // no-inherited-route 与旧失败路径逐字节一致（inherit 模式语义不变）；host/custom
      // 的坏配置各自带 reasonCode，整理提醒能直接说清是哪个配置面写错了。
      if (resolved.reason === 'no-inherited-route') {
        safeLedger(() => failJob({ sessionId, jobId, reasonCode: 'no-parent-route', retryable: true, error: 'cannot inherit the parent model/provider' }))
        return finish({ ok: false, sessionId, reasonCode: 'no-parent-route', settled: false, error: 'cannot inherit the parent model/provider; consolidation fork was not created' })
      }
      safeLedger(() => failJob({ sessionId, jobId, reasonCode: resolved.reason, retryable: true, error: 'cannot resolve the consolidation model (' + resolved.reason + ')' }))
      return finish({ ok: false, sessionId, reasonCode: resolved.reason, settled: false, error: 'cannot resolve the consolidation model (' + resolved.reason + '); consolidation fork was not created' })
    }
    if (resolved.reason === 'custom') {
      // 每次整理都重挂一次（先卸旧再注册，设置变更自然生效）；成功后才允许 fork 指名
      // dsh-memu-custom。失败降级：有父 route 就回 inherit，没有就只能拒绝。
      const ensured = await ensureConsolidationRoute(ctx, settings)
      if (!ensured.ok) {
        warn('consolidation custom model route unavailable (' + ensured.reason + (ensured.error ? ': ' + ensured.error : '') + '); falling back to the inherited route')
        if (inherited) {
          agentOptions = inherited
          modelMode = 'inherit-fallback'
        } else {
          safeLedger(() => failJob({ sessionId, jobId, reasonCode: 'custom-route-unavailable', retryable: true, error: 'the custom consolidation route is unavailable (' + ensured.reason + ')' }))
          return finish({ ok: false, sessionId, reasonCode: 'custom-route-unavailable', settled: false, error: 'the custom consolidation route is unavailable (' + ensured.reason + '); consolidation fork was not created' })
        }
      }
    }

    childId = 'memu-consolidate-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex')
    // 种子只种这一窗：worker 看到的世界就是它要对账的那一段，窗口之外的事件
    // 留给下一批。seq 已按 compactSeedEvents 重排成从 0 连续，inheritedEventCount
    // 必须等于种子长度（不是父会话的 throughSeq），否则宿主会拒绝这份种子。
    handle = await agents.create({
      sessionId: childId,
      meta: {
        cwd: header.cwd,
        parentSession: sessionId,
        isSeeded: true,
        // Without this the fork is treated as an ordinary user conversation by
        // the injection path and the sidebar session lists.
        origin: 'subagent',
        agentPreset: header.agentPreset,
      },
      inheritedEventCount: seedEvents.length,
      seed: buildForkSeed(seedEvents, seedEvents.length - 1),
      agentOptions,
      signal: abort.signal,
    })

    // header 无法证明 worker 有写工具时（PTC 会话名单只有 run_code / 旧会话没有名单），
    // 把 worker 读写面挂进 fork 自己的 scope，保证 SDK 面（PTC）与原生面（普通会话）都真能写入。
    // 标准 preset 的 fork 名单里已有 memu_*（probe.hasWrite === true），不重复挂。
    if (probe.hasWrite !== true) {
      workerTools = await attachWorkerTools(agents, childId, sessionId)
    }

    // 先记"已开始"再等结果：一个大会话的 fork 可能跑好几分钟，没有这条记录，
    // 侧边栏和日志页在等待期间只会显示上一次的结果，用户会以为按钮没生效。
    record({
      kind: 'consolidate',
      scope: 'private',
      sessionId,
      libraryId: binding.libraryId || null,
      ok: true,
      message: '整理已开始 · ' + (force ? '手动' : (options.trigger === 'backlog' ? '水位' : '空闲'))
        + ' · fork ' + childId.slice(-8)
        + ' · 窗口 ' + window.events.length + ' 条事件（父会话 ' + events.length + ' 条 / 新 ' + freshCount + ' 条）'
        + (window.remaining > 0 ? ' · 还余 ' + window.remaining : '')
        + ' · 预算 ' + Math.round(budgetMs / 1000) + 's · 快照 ' + snapshot.hash,
      detail: { childId, jobId, force, trigger: options.trigger || 'idle', events: window.events.length, transcriptEvents: events.length, fresh: freshCount, remaining: window.remaining, budgetMs, phase: 'started', snapshot: snapshotMeta,
        modelMode,
        probe: { source: probe.source, hasWrite: probe.hasWrite, ptc: probe.ptcObserved === true },
        ...workerToolsMeta(workerTools) },
    })

    // turn/end 是这一轮的唯一权威结果；whenIdle 只说明 driver 停了（失败的回合也停）。
    // 顺带从同一个公共事件流里收三样东西：worker 的正文（回执在里面）、
    // 它的工具动作（用来在写入途中重验父授权），以及父会话自己是否动过。
    const childSession = handle?.agent?.session
    const parentAgent = (() => { try { return agents.get?.(sessionId) || null } catch { return null } })()
    const parentLive = parentAgent?.session || null
    const isParentSession = (session) => session === parentLive || (session && parentLive === null && session?.id === sessionId)
    const revalidate = (source) => {
      if (scopeChanged) return
      const now = scopeGenerationOf(getSessionBinding(sessionId))
      if (!generationAtStart || now === generationAtStart) return
      scopeChanged = { source, expected: generationAtStart, actual: now }
      record({
        kind: 'consolidate', scope: 'private', sessionId, libraryId: binding.libraryId || null, ok: false, level: 'warn',
        message: '整理作废：父会话授权变化（' + source + '）',
        detail: { jobId, childId, ...scopeChanged },
      })
      try { abort.abort() } catch {}
    }
    if (typeof ctx.on === 'function' && childSession) {
      try {
        offSession = ctx.on('session/event', (session, event) => {
          if (session === childSession) {
            if (event?.type === 'turn/end') { turnEnd = event; return }
            if (event?.type === 'assistant/message') {
              const blocks = event?.data?.message?.content
              if (Array.isArray(blocks)) {
                for (const block of blocks) {
                  if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) assistantTexts.push(block.text)
                }
              }
              return
            }
            // 工具动作是写入的落点：每出现一次就重验一次父授权，变了立刻停掉这条 fork。
            if (event?.type === 'tool/call' || event?.type === 'tool/result' || event?.type === 'tool/ptc-dispatch' || event?.type === 'tool/ptc-dispatch-start') {
              revalidate('worker-write')
              return
            }
            return
          }
          // 用户又说话了：父会话的库/域/上下文可能已经被切换，重新比一次指纹。
          if (isParentSession(session) && (event?.type === 'turn/start' || event?.type === 'user/message')) revalidate('parent-activity')
        })
      } catch {}
    }

    // The fork must write into the parent's library, not derive one from its own
    // freshly minted session id.
    setSessionBinding(childId, {
      libraryId: binding.libraryId,
      consolidationFork: true,
      // 整理发生在几小时后，父会话此刻的心境不是这段转录里那件事的情绪，所以 fork
      // 不继承 mood。显式写 null 而不是留空：缺字段和「这一刻是中性」在写入时都走
      // 同一条兜底，但只有 null 能把「后台 worker 没有当下心境」说清楚。
      mood: null,
      // The fork writes memories on the same logical clock as its parent. Without
      // this the worker falls back to the wall clock at fork time; the per-turn
      // [事件时间] markers in the seed remain the authoritative override.
      sceneTime: binding.sceneTime || null,
      parentSessionId: sessionId,
      parentScopeGeneration: generationAtStart,
      snapshotHash: snapshot.hash,
      // 调试/测试用：worker 的回执范围必须和这两项一致，否则 completeJob 不会推进。
      snapshotFromSeq: snapshot.fromSeq,
      snapshotThroughSeq: snapshot.throughSeq,
      snapshotEventCount: snapshot.eventCount,
      jobId,
      scopeKey: binding.scopeKey,
      memoryOwnerSessionId: binding.memoryOwnerSessionId || sessionId,
      memoryContext: binding.memoryContext || {},
      useLibrary: true,
      useGlobal: binding.useGlobal === true,
      domain: binding.domain,
      domainOverride: binding.domainOverride || null,
    })

    // 写入前最后一次重验：这次的授权还成立吗？不成立就别把 prompt 发出去。
    revalidate('pre-dispatch')
    if (scopeChanged) {
      safeLedger(() => failJob({ sessionId, jobId, reasonCode: 'parent-scope-changed', retryable: false, error: 'the parent conversation changed scope before dispatch' }))
      return finish({
        ok: false, sessionId, childId, settled: false, retryable: false, reasonCode: 'parent-scope-changed',
        error: 'the parent conversation switched library, scope or memory context before the worker was dispatched; nothing was credited',
      })
    }

    const brief = buildWorkerBrief({ snapshot, probe, contract: receiptContractText({ jobId, snapshotHash: snapshot.hash }), reason: force ? 'manual' : 'auto', jobId })
    handle.agent.followup(noticeMessage([buildPrivateConsolidationPrompt(sessionId), '', brief].join('\n'), '整理这场对话的私有记忆'))
    // followup only queues. whenIdle says the driver stopped; turn/end says
    // whether that turn actually succeeded, so both are checked below.
    idle = typeof handle.agent.whenIdle === 'function' ? handle.agent.whenIdle() : Promise.resolve()
    let timer = null
    let outcome
    try {
      const wait = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), budgetMs) })
      outcome = await Promise.race([idle.then(() => 'done'), wait])
    } finally { clearTimeout(timer) }

    let wrote = null
    let decision = null
    let completion = null
    if (outcome === 'done') {
      const failure = turnEndFailure(turnEnd)
      if (failure) {
        safeLedger(() => failJob({ sessionId, jobId, reasonCode: 'fork-turn-failed', error: failure }))
        return finish({ ok: false, error: 'consolidation fork failed: ' + failure, sessionId, childId, settled: false, timedOut: false })
      }
      // 父授权重验：写入可能已经落了一部分，但凭证只有在授权还成立时才算数。
      const generationNow = scopeGenerationOf(getSessionBinding(sessionId))
      if (scopeChanged || (generationAtStart && generationNow !== generationAtStart)) {
        safeLedger(() => failJob({ sessionId, jobId, reasonCode: 'parent-scope-changed', retryable: false, error: 'the parent conversation changed scope during consolidation' }))
        return finish({
          ok: false, sessionId, childId, settled: false, retryable: false, reasonCode: 'parent-scope-changed',
          error: 'the parent conversation switched library, scope or memory context while the worker was running; the result was not credited (writes that already landed stay in the library, the range stays pending)',
        })
      }
      // 兼容字段 lastSleepSeq 只能跟着凭证走：没有对账过的结果就不算整理过，
      // 否则旧游标会把「失败」记成「已整理」，正是 C 包要消灭的那类谎。
      if (beforeIds) {
        try {
          const afterIds = Object.keys(loadPrivateIndex(binding.libraryId).entries)
          wrote = afterIds.filter((id) => !beforeIds.has(id)).length
        } catch { wrote = null }
      }
      let index = null
      try { index = loadPrivateIndex(binding.libraryId) } catch { index = null }
      // 完成不是"没报错"：worker 的回执 + 库里的真实变化，两边对上才结算。
      const workerText = assistantTexts.join('\n')
      decision = decideCompletion({ text: workerText, wrote, index, beforeIds, beforeEntries, expectedJobId: jobId, expectedSnapshotHash: snapshot.hash })

      if (!decision.advance) {
        safeLedger(() => failJob({
          sessionId, jobId, reasonCode: decision.reasonCode || 'not-settled',
          retryable: decision.retryable !== false, error: decision.error || null,
        }))
        return finish({
          ok: false, sessionId, childId, settled: false, retryable: decision.retryable !== false,
          status: decision.status, outcome: decision.outcome, reasonCode: decision.reasonCode,
          counts: decision.counted || null, snapshot: snapshotMeta,
          error: decision.error || ('consolidation result was not verified: ' + String(decision.reasonCode || 'unknown')),
        })
      }
      completion = safeLedger(() => completeJob({
        sessionId, jobId, snapshot,
        covered: decision.covered,
        status: decision.status,
        outcome: decision.outcome,
        reasonCode: decision.reasonCode,
        retryable: decision.retryable === true,
        counts: decision.counted,
        receipt: decision.receipt,
      }))
      if (!completion?.advanced) {
        return finish({ ok: false, sessionId, childId, settled: false, retryable: true,
          reasonCode: 'ledger-not-advanced', snapshot: snapshotMeta,
          error: 'the consolidation ledger could not verify the covered snapshot range' })
      }
      setSessionBinding(sessionId, { lastSleepSeq: snapshot.throughSeq })
      safeLedger(() => recordOperation({ sessionId, key: opKey, outcome: decision.status, ids: decision.createdIds || [] }))
      // 私有自动关联（§5.6 兜底）：只在整理真的对账并推进边界之后跑，纯算法，
      // 0 token。worker 若已调用 memu_private_link_suggest，这一遍是幂等的（已有的
      // relation/person 边会跳过）。link 只是图元数据：失败只记 warn，绝不能让一次
      // 已经成功的整理变成失败；timeout / unsettled / ledger-not-advanced 三条路径
      // 走不到这里，所以它们不会触发自动关联。
      const linkIds = [...(decision.createdIds || []), ...(decision.updatedIds || [])]
      if (linkIds.length) {
        try {
          await autoLinkPrivateMemories({ libraryId: binding.libraryId, sessionId, ids: linkIds })
        } catch (error) {
          // autoLinkPrivateMemories 自己已捕获操作性失败；这里只兜"意料之外"的抛错。
          try { warn('private auto-link after consolidation skipped: ' + String(error?.message || error)) } catch {}
        }
      }
    }
    // A timeout is not success: the fork may still be mid-write. It has to come
    // back with a message, not just `timedOut` — the settings button renders
    // `result.error` and an empty string there is indistinguishable from a click
    // that did nothing at all (observed: two clicks, no feedback, no memories).
    if (outcome === 'timeout') {
      // Stop the writer before releasing the range, not after. Waiting matters here
      // because a tool call already in flight can still land a memory on disk, and the
      // range going back to pending is what lets the next pass redo this window.
      await stopWorker()
      safeLedger(() => failJob({ sessionId, jobId, reasonCode: 'timeout', error: 'timed out before a receipt; the worker was stopped first, but a tool call already in flight may have written' }))
      return finish({
        ok: false,
        sessionId,
        childId,
        settled: false,
        timedOut: true,
        reasonCode: 'timeout',
        // The next pass must not assume this window left nothing behind: the range is
        // pending again and some writes may already have landed.
        partialWritesPossible: true,
        error: 'consolidation timed out after ' + Math.round(budgetMs / 1000) + 's over ' + window.events.length + ' events; the fork was stopped before the range was released (memories written before the timeout are kept). Retry, or consolidate a shorter conversation.',
      })
    }
    return finish({
      ok: outcome === 'done',
      sessionId,
      childId,
      settled: outcome === 'done',
      timedOut: false,
      status: decision?.status || null,
      outcome: decision?.outcome || null,
      reasonCode: decision?.reasonCode || null,
      counts: decision?.counted || null,
      createdIds: decision?.createdIds || [],
      updatedIds: decision?.updatedIds || [],
      heldIds: decision?.heldIds || [],
      receipt: decision?.receipt
        ? { status: decision.receipt.status, outcome: decision.receipt.outcome, reasonCode: decision.receipt.reasonCode }
        : null,
      credential: completion?.checked ? { checked: completion.checked, pending: completion.pending } : null,
      snapshot: snapshotMeta,
      scanned: window.events.length,
      fresh: freshCount,
      remaining: window.remaining,
      window: { fromSeq: window.fromSeq, throughSeq: window.throughSeq },
      wrote,
    })
  } catch (error) {
    if (jobId) safeLedger(() => failJob({ sessionId, jobId, reasonCode: 'exception', error: String(error?.message || error) }))
    return finish({ ok: false, sessionId, settled: false, reasonCode: 'exception', error: String(error?.message || error) })
  } finally {
    inFlight.delete(sessionId)
    try { await stopWorker() } catch {}
    try { workerTools?.dispose?.() } catch {}
    try { if (childId) deleteSessionBinding(childId) } catch {}
  }
}
export function isConsolidating(sessionId) {
  return inFlight.has(sessionId)
}
