import { createUserMessage } from '@deepseek-ai/dsh-llm'
import crypto from 'node:crypto'
import { getSessionBinding, getLibrary, getSettings, setSessionBinding, getMemoryBackend, loadPrivateIndex, effectiveScope } from './state.js'
import { domainOf, privateRemember, isMemoryEligible, visibleToSession } from './memory.js'
import { loadPromptForDomain, CONSOLIDATION_CONTRACTS } from './prompts.js'
import { summarizeRemote } from './remote-summary.js'
import { condenseEvents, readSessionSnapshot } from './curator.js'

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

export async function requestPrivateConsolidation(ctx, sessionId) {
  const binding = getSessionBinding(sessionId)
  if (!binding) return { ok: false, error: 'session is not bound to a memory library; bind it first' }
  if (!binding.libraryId || !effectiveScope(binding).useLibrary) return { ok: false, error: 'private memory is disabled for this session or folder' }
  if (getMemoryBackend() === 'api') return requestRemoteConsolidation(ctx, sessionId)
  // Always a fork, never the live session's own inbox. `agent.followup` on the
  // chat the user is looking at does queue a real turn — but the host renders a
  // queued next-turn message as a pending draft above the composer (editable,
  // deletable, sent on demand), and once it runs it stays in that transcript
  // forever, re-sent on every later turn. A live session is no exception: the
  // fork seeds the same transcript, so recall quality is unchanged, while the
  // housekeeping turn lands in a scratch subagent session (origin: subagent —
  // out of the window list and out of the injection path) that is disposed.
  return requestHistoricalConsolidation(ctx, sessionId)
}

// Remote mode: the configured remote chat endpoint writes the memories, then they
// are committed through the same backend. No local agent or tool chain is touched.
export async function requestRemoteConsolidation(ctx, sessionId, { signal, timeoutMs } = {}) {
  const binding = getSessionBinding(sessionId)
  if (!binding) return { ok: false, error: 'session is not bound to a memory library; bind it first' }
  if (!binding.libraryId || !effectiveScope(binding).useLibrary) return { ok: false, error: 'private memory is disabled for this session or folder' }
  const sessionQuery = ctx.get?.('sessionQuery')
  if (!sessionQuery) return { ok: false, error: 'host has no sessionQuery; cannot read this conversation' }
  try {
    const snapshot = await readSessionSnapshot(sessionQuery, sessionId)
    const events = Array.isArray(snapshot?.events) ? snapshot.events : []
    if (events.length === 0) return { ok: false, error: 'this session has no content to consolidate' }
    const transcript = condenseEvents(events, 60_000)
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
    return { ok: true, sessionId, backend: 'api', count: memories.length }
  } catch (error) {
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

const inFlight = new Map()

// Every agent-backend consolidation runs here, live sessions included: the same
// main agent, on a seeded copy of the transcript, writing into the library the
// original used. In-place consolidation would append a housekeeping turn to the
// user's own chat — a queued draft until it runs, then a permanent resident of
// that transcript — so the one visible difference between a live and a closed
// session is that a closed one has to be read back from disk first.
export async function requestHistoricalConsolidation(ctx, sessionId, { maxWaitMs = 180_000 } = {}) {
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
  try {
    const sessionQuery = ctx.get?.('sessionQuery')
    const agents = ctx.get?.('agents')
    if (!sessionQuery?.readSession || typeof agents?.create !== 'function') {
      return { ok: false, error: 'host has no readSession / agents.create; historical consolidation is unavailable' }
    }
    const buildForkSeed = await loadBuildForkSeed()
    if (!buildForkSeed) return { ok: false, error: 'dsh-session buildForkSeed is unavailable' }

    const childId = `memu-consolidate-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
    const snapshot = await sessionQuery.readSession(sessionId)
    const events = Array.isArray(snapshot?.events) ? snapshot.events : []
    const lastSeq = events[events.length - 1]?.seq
    if (events.length === 0 || lastSeq === undefined) return { ok: false, error: 'this session has no content to consolidate' }
    const header = snapshot?.session || {}

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
      signal: abort.signal,
    })

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
    // followup only queues, so idle is the only signal that the work actually ran
    // before the scratch fork is thrown away.
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
    return { ok: outcome === 'done', sessionId, childId, settled: outcome === 'done', timedOut: outcome === 'timeout' }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  } finally {
    inFlight.delete(sessionId)
    abort.abort()
    try { await handle?.dispose?.() } catch {}
  }
}

export function isConsolidating(sessionId) {
  return inFlight.has(sessionId)
}
