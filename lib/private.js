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
// 是 tools-unavailable。修法与 preset-scope.js 的注入挂载同构：把读写四件挂进 fork
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

// 这里的 import 刻意写在语句之后：lib/binding-diagnostics.js 的 RUNTIME_STATE 把 `inFlight`
// 的 file:line 当成诊断契约（当前 lib/private.js:336），修改位置时同步更新该诊断映射，
// 而那是别人的文件、本包不改。ESM 的 import 声明是提升的，写在语句之后合法。
import { warn } from './paths.js'
import { captureSessionSnapshot } from './consolidation-snapshot.js'
import {
  beginJob, completeJob, failJob, findOperation, noteEvidence, operationKey,
  recoverStaleJobs, recordOperation, scopeGenerationOf,
} from './consolidation-ledger.js'
import { decideCompletion, receiptContractText } from './consolidation-receipt.js'
import { buildWorkerBrief, probeToolSurface, WORKER_READ_TOOLS, WORKER_WRITE_TOOLS } from './consolidation-worker.js'
import { registerTools } from './tools.js'

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
    record({
      kind: 'consolidate',
      scope: 'private',
      sessionId,
      libraryId: binding.libraryId || null,
      ok,
      level: ok ? 'info' : (result?.timedOut ? 'warn' : 'error'),
      message: '整理' + (ok ? (skipped ? '跳过（没有值得记的内容）' : '完成') : (result?.timedOut ? '超时' : '失败'))
        + (force ? ' · 手动' : ' · 空闲')
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
      return finish({
        ok: false, sessionId, code: captured.code, reasonCode: captured.reasonCode, settled: false,
        retryable: captured.retryable === true, error: captured.error,
      })
    }
    const snapshot = captured.snapshot
    const events = captured.events
    const snapshotMeta = snapshotMetaOf(snapshot)
    const generationAtStart = scopeGenerationOf(binding)
    // 待检查边界与已确认边界分开记：证据到达就记一次，失败不回退。
    safeLedger(() => noteEvidence({ sessionId, fromSeq: snapshot.fromSeq, throughSeq: snapshot.throughSeq }))
    if (events.length === 0) return finish({ ok: false, sessionId, reasonCode: 'empty-snapshot', settled: false, error: 'this session has no content to consolidate' })

    // The scheduler asks "is this conversation idle", which is not the same as
    // "did anything happen that deserves a memory". Answer the second question
    // before paying for a fork; a manual consolidation passes force and skips it.
    if (!force) {
      const fresh = unconsolidatedEvents(binding, events)
      const value = assessConsolidationValue(fresh)
      // 这一批里没有真人回合、或只有一句「好的继续」：这一段确实没什么可整理的，
      // 是终态而不是 deferral——否则空闲扫描会为同一句寒暄一直重扫。
      // 没有真人回合、或只有一句「谢谢」：这一段确实没有可整理的证据，是终态而不是 deferral。
      // 写成 deferred 会让空闲扫描为同一句寒暄每轮重扫（tests/cycle.test.mjs 的寒暄用例钉住这一点）。
      if (!value.worth) return finish({ ok: true, sessionId, skipped: value.reason, settled: false, deferred: true, reasonCode: value.reason, assessment: value, snapshot: snapshotMeta })
      // 加权判定：短空闲要求分数达标，长空闲（饥饿阈值）无条件放行；
      // 阈值与权重集中在 lib/active-memory.js，可根据回放标定。
      const settings = getSettings()
      const idleMinutes = binding.lastTurnAt ? (Date.now() - (Date.parse(binding.lastTurnAt) || Date.now())) / 60_000 : Infinity
      const starved = idleMinutes >= Number(settings.activeMemoryStarvationMinutes ?? ACTIVE_MEMORY_POLICY.starvationMinutes)
      const evidence = collectEvidence(fresh)
      const wake = assessWake({
        evidence,
        starved,
        transcriptEvents: events.length,
        // 「待整理区间有多大」是守卫唯一该看的规模信号：守卫要躲的是为一句轻话重种
        // 整段转录，而不是把一个从没整理过的大会话永远挡在门外。
        pendingEvents: fresh.length,
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
          + ' · 快照 ' + snapshot.hash,
        detail: { trigger: 'auto', reason: wake.reason, score: wake.score, parts: wake.parts, starved, transcriptEvents: events.length, snapshot: snapshotMeta },
      })
      if (!wake.wake) return finish({ ok: true, sessionId, skipped: 'low-score', settled: false, assessment: value, score: wake.score, parts: wake.parts, snapshot: snapshotMeta })
    }

    // 幂等：同一份固定快照已经结算过就不再 fork 一次（失败的部分写入靠操作键判同再试，
    // 而不是靠"同一个主题就跳过"）。
    const opKey = operationKey({ sessionId, libraryId: binding.libraryId, snapshotHash: snapshot.hash, scopeGeneration: generationAtStart })
    const previous = safeLedger(() => findOperation(sessionId, opKey))
    if (previous && (previous.outcome === 'completed' || previous.outcome === 'skipped')) {
      return finish({ ok: true, sessionId, skipped: 'already-consolidated', settled: true, snapshot: snapshotMeta, credential: previous })
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
    const freshCount = unconsolidatedEvents(binding, events).length
    let beforeIds = null
    let beforeEntries = null
    try {
      const beforeIndex = loadPrivateIndex(binding.libraryId)
      beforeIds = new Set(Object.keys(beforeIndex.entries))
      beforeEntries = Object.fromEntries(Object.entries(beforeIndex.entries).map(([id, entry]) => [id, entryFingerprint(entry)]))
    } catch { beforeIds = null; beforeEntries = null }

    const agentOptions = inheritedAgentOptions(ctx, sessionId, events)
    if (!agentOptions) {
      safeLedger(() => failJob({ sessionId, jobId, reasonCode: 'no-parent-route', retryable: true, error: 'cannot inherit the parent model/provider' }))
      return finish({ ok: false, sessionId, reasonCode: 'no-parent-route', settled: false, error: 'cannot inherit the parent model/provider; consolidation fork was not created' })
    }

    childId = 'memu-consolidate-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex')
    // `inheritedEventCount` is a TOP-LEVEL CreateAgentOptions field, NOT session
    // metadata: SessionStore.prepare() rebuilds the header from a fixed meta
    // whitelist (version, id, createdAt, cwd, parentSession, isSeeded, origin,
    // delegationDepth, agentPreset), so a count placed in `meta` is silently
    // dropped and Session's constructor then refuses the seeded session with
    // "seeded session requires an inherited event count". Every fork died there.
    //
    // 种子只种到快照的 throughSeq：worker 看到的世界就是它要对账的那一段，
    // 快照之后新发生的事件留给下一批。
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
      inheritedEventCount: snapshot.throughSeq + 1,
      seed: buildForkSeed(events, snapshot.throughSeq),
      agentOptions,
      signal: abort.signal,
    })

    // header 无法证明 worker 有写工具时（PTC 会话名单只有 run_code / 旧会话没有名单），
    // 把读写四件挂进 fork 自己的 scope，保证 SDK 面（PTC）与原生面（普通会话）都真能写入。
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
      message: '整理已开始 · ' + (force ? '手动' : '空闲') + ' · fork ' + childId.slice(-8) + ' · ' + events.length + ' 条事件 · 快照 ' + snapshot.hash,
      detail: { childId, jobId, force, events: events.length, phase: 'started', snapshot: snapshotMeta,
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
      parentSessionId: sessionId,
      parentScopeGeneration: generationAtStart,
      snapshotHash: snapshot.hash,
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
    const idle = typeof handle.agent.whenIdle === 'function' ? handle.agent.whenIdle() : Promise.resolve()
    let timer = null
    let outcome
    try {
      const wait = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), maxWaitMs) })
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
    }
    // A timeout is not success: the fork may still be mid-write. It has to come
    // back with a message, not just `timedOut` — the settings button renders
    // `result.error` and an empty string there is indistinguishable from a click
    // that did nothing at all (observed: two clicks, no feedback, no memories).
    if (outcome === 'timeout') {
      safeLedger(() => failJob({ sessionId, jobId, reasonCode: 'timeout', error: 'timed out before a receipt' }))
      return finish({
        ok: false,
        sessionId,
        childId,
        settled: false,
        timedOut: true,
        reasonCode: 'timeout',
        error: 'consolidation timed out after ' + Math.round(maxWaitMs / 1000) + 's; the fork was stopped (memories written before the timeout are kept). Retry, or consolidate a shorter conversation.',
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
      scanned: events.length,
      fresh: freshCount,
      wrote,
    })
  } catch (error) {
    if (jobId) safeLedger(() => failJob({ sessionId, jobId, reasonCode: 'exception', error: String(error?.message || error) }))
    return finish({ ok: false, sessionId, settled: false, reasonCode: 'exception', error: String(error?.message || error) })
  } finally {
    inFlight.delete(sessionId)
    abort.abort()
    try { offSession?.() } catch {}
    try { workerTools?.dispose?.() } catch {}
    try { await handle?.dispose?.() } catch {}
    try { if (childId) deleteSessionBinding(childId) } catch {}
  }
}
export function isConsolidating(sessionId) {
  return inFlight.has(sessionId)
}
