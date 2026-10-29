import { createUserMessage } from '@deepseek-ai/dsh-llm'
import crypto from 'node:crypto'
import { getSessionBinding, getLibrary, getSettings, setSessionBinding, loadPrivateIndex, effectiveScope } from './state.js'
import { domainOf, privateRemember, isMemoryEligible, visibleToSession } from './memory.js'
import { loadPromptForDomain, CONSOLIDATION_CONTRACTS } from './prompts.js'
import { summarizeRemote } from './remote-summary.js'
import { condenseEvents, readSessionSnapshot } from './curator.js'
import { record } from './activity-log.js'

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
    for (const memory of memories) {
      await privateRemember({
        ...memory,
        exec: { agent: { session: { header: { id: sessionId } } } },
        content: memory.content,
        title: memory.title || memory.content,
        tags: memory.tags,
        openLoop: memory.openLoop,
        confidence: memory.confidence,
        source: memory.source || 'inferred',
      })
    }
    setSessionBinding(sessionId, { lastSleepSeq: events[events.length - 1]?.seq })
    const result = { ok: true, sessionId, backend: 'api', count: memories.length }
    record({
      kind: 'consolidate', scope: 'private', sessionId, libraryId: binding.libraryId || null, ok: true,
      message: `整理完成（远程）· 写入 ${memories.length}`,
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

const inFlight = new Map()

// Every agent-backend consolidation runs here, live sessions included: the same
// main agent, on a seeded copy of the transcript, writing into the library the
// original used. In-place consolidation would append a housekeeping turn to the
// user's own chat — a queued draft until it runs, then a permanent resident of
// that transcript — so the one visible difference between a live and a closed
// session is that a closed one has to be read back from disk first.
export async function requestHistoricalConsolidation(ctx, sessionId, { maxWaitMs = 180_000, force = false } = {}) {
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
  let turnEnd = null
  // 每次整理都要在活动日志里留一条：谁触发（手动/空闲）、fork 有没有建、结果是完成、
  // 超时还是失败。否则"点了没反应"只能靠翻会话文件才知道发生了什么。
  const finish = (result) => {
    const ok = result?.ok === true
    const skipped = Boolean(result?.skipped)
    record({
      kind: 'consolidate',
      scope: 'private',
      sessionId,
      libraryId: binding.libraryId || null,
      ok,
      level: ok ? (skipped ? 'info' : 'info') : (result?.timedOut ? 'warn' : 'error'),
      message: '整理' + (ok ? (skipped ? '跳过（没有值得记的内容）' : '完成') : (result?.timedOut ? '超时' : '失败'))
        + (force ? ' · 手动' : ' · 空闲')
        + (result?.childId ? ' · fork ' + result.childId.slice(-8) : '')
        + (result?.error ? '：' + String(result.error) : '')
        + (result?.count !== undefined ? ' · 写入 ' + result.count : ''),
      detail: { force, ...result },
      refs: [],
    })
    return result
  }
  try {
    const sessionQuery = ctx.get?.('sessionQuery')
    const agents = ctx.get?.('agents')
    if (!sessionQuery?.readSession || typeof agents?.create !== 'function') {
      return finish({ ok: false, error: 'host has no readSession / agents.create; historical consolidation is unavailable' })
    }
    const buildForkSeed = await loadBuildForkSeed()
    if (!buildForkSeed) return finish({ ok: false, error: 'dsh-session buildForkSeed is unavailable' })

    const childId = `memu-consolidate-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
    const snapshot = await sessionQuery.readSession(sessionId)
    const events = Array.isArray(snapshot?.events) ? snapshot.events : []
    const lastSeq = events[events.length - 1]?.seq
    if (events.length === 0 || lastSeq === undefined) return finish({ ok: false, error: 'this session has no content to consolidate' })
    // The scheduler asks "is this conversation idle", which is not the same as
    // "did anything happen that deserves a memory". Answer the second question
    // before paying for a fork; a manual consolidation passes force and skips it.
    if (!force) {
      const value = assessConsolidationValue(unconsolidatedEvents(binding, events))
      if (!value.worth) return finish({ ok: true, sessionId, skipped: value.reason, settled: true, assessment: value })
    }
    const header = snapshot?.session || {}

    const agentOptions = inheritedAgentOptions(ctx, sessionId, events)
    if (!agentOptions) return finish({ ok: false, error: 'cannot inherit the parent model/provider; consolidation fork was not created' })

    // `inheritedEventCount` is a TOP-LEVEL CreateAgentOptions field, NOT session
    // metadata: SessionStore.prepare() rebuilds the header from a fixed meta
    // whitelist (version, id, createdAt, cwd, parentSession, isSeeded, origin,
    // delegationDepth, agentPreset), so a count placed in `meta` is silently
    // dropped and Session's constructor then refuses the seeded session with
    // "seeded session requires an inherited event count". Every fork died there.
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
      // The fork is the parent's transcript, so it inherits every event through lastSeq.
      inheritedEventCount: lastSeq + 1,
      seed: buildForkSeed(events, lastSeq),
      agentOptions,
      signal: abort.signal,
    })

    // 先记"已开始"再等结果：一个大会话的 fork 可能跑好几分钟，没有这条记录，
    // 侧边栏和日志页在等待期间只会显示上一次的结果，用户会以为按钮没生效。
    record({
      kind: 'consolidate',
      scope: 'private',
      sessionId,
      libraryId: binding.libraryId || null,
      ok: true,
      message: '整理已开始 · ' + (force ? '手动' : '空闲') + ' · fork ' + childId.slice(-8) + ' · ' + events.length + ' 条事件',
      detail: { childId, force, events: events.length, phase: 'started' },
    })

    // turn/end is the authoritative outcome of the fork's first turn. whenIdle()
    // only means the driver stopped: an error turn also resolves it, so without
    // this check a failed consolidation would advance lastSleepSeq and look like
    // success to the idle sweep. The listener is public and session-scoped; we
    // register before followup so the event cannot race the wait.
    const childSession = handle?.agent?.session
    if (typeof ctx.on === 'function' && childSession) {
      try {
        offSession = ctx.on('session/event', (session, event) => {
          if (session !== childSession || event?.type !== 'turn/end') return
          turnEnd = event
        })
      } catch {}
    }

    // The fork must write into the parent's library, not derive one from its own
    // freshly minted session id.
    setSessionBinding(childId, {
      libraryId: binding.libraryId,
      scopeKey: binding.scopeKey,
      memoryOwnerSessionId: binding.memoryOwnerSessionId || sessionId,
      memoryContext: binding.memoryContext || {},
      useLibrary: true,
      useGlobal: binding.useGlobal === true,
      domain: binding.domain,
      domainOverride: binding.domainOverride || null,
    })

    handle.agent.followup(noticeMessage(buildPrivateConsolidationPrompt(sessionId), '整理这场对话的私有记忆'))
    // followup only queues. whenIdle says the driver stopped; turn/end says
    // whether that turn actually succeeded, so both are checked below.
    const idle = typeof handle.agent.whenIdle === 'function' ? handle.agent.whenIdle() : Promise.resolve()
    let timer = null
    let outcome
    try {
      const wait = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), maxWaitMs) })
      outcome = await Promise.race([idle.then(() => 'done'), wait])
    } finally { clearTimeout(timer) }
    // A timeout is not success: the fork may still be mid-write. Report it as
    // unsettled so the scheduler can retry, instead of silently dropping the
    // consolidation.
    // On success, the next assessment measures from here, not from this transcript top.
    if (outcome === 'done') {
      const failure = turnEndFailure(turnEnd)
      if (failure) return finish({ ok: false, error: 'consolidation fork failed: ' + failure, sessionId, childId, settled: false, timedOut: false })
      setSessionBinding(sessionId, { lastSleepSeq: lastSeq })
    }
    // A timeout is not success: the fork may still be mid-write. It has to come
    // back with a message, not just `timedOut` — the settings button renders
    // `result.error` and an empty string there is indistinguishable from a click
    // that did nothing at all (observed: two clicks, no feedback, no memories).
    if (outcome === 'timeout') {
      return finish({
        ok: false,
        sessionId,
        childId,
        settled: false,
        timedOut: true,
        error: `consolidation timed out after ${Math.round(maxWaitMs / 1000)}s; the fork was stopped (memories written before the timeout are kept). Retry, or consolidate a shorter conversation.`,
      })
    }
    return finish({ ok: outcome === 'done', sessionId, childId, settled: outcome === 'done', timedOut: false })
  } catch (error) {
    return finish({ ok: false, error: String(error?.message || error) })
  } finally {
    inFlight.delete(sessionId)
    abort.abort()
    try { offSession?.() } catch {}
    try { await handle?.dispose?.() } catch {}
  }
}

export function isConsolidating(sessionId) {
  return inFlight.has(sessionId)
}
