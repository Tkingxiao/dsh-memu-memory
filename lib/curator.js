import {
  globalDbPath, loadGlobalIndex, updateGlobalIndex, newMemoryId, getSettings, getMemoryBackend,
} from './state.js'
import { commit } from './memu.js'
import { loadPrompt } from './prompts.js'
import { retryStoreWrite, redactSecrets } from './paths.js'

const MAX_SESSIONS = 10
const MAX_TOTAL_CHARS = 90_000
const MAX_SESSION_CHARS = 14_000
const jobs = new Map()

function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
}

function truncate(text, max) {
  const s = String(text || '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

export function condenseEvents(events, maxChars = MAX_SESSION_CHARS) {
  const lines = []
  for (const event of events || []) {
    try {
      const type = event?.type
      if (type === 'user/message') {
        if (event.data?.source?.kind !== 'user') continue
        const text = textOf(event.data?.content)
        if (text) lines.push(`User: ${text}`)
        continue
      }
      if (type === 'assistant/message') {
        const blocks = event.data?.message?.content || []
        const texts = textOf(blocks)
        if (texts) lines.push(`Assistant: ${texts}`)
        for (const b of blocks) {
          if (b?.type === 'tool-call') {
            lines.push(`Tool call: ${b.name}${b.arguments ? ` ${truncate(String(b.arguments), 300)}` : ''}`)
          }
        }
        continue
      }
      if (type === 'tool/result') {
        const text = textOf(event.data?.message?.content)
        if (text) lines.push(`Tool result${event.data?.message?.isError ? ' (error)' : ''}: ${truncate(text, 400)}`)
        continue
      }
      if (type === 'tool/call') {
        lines.push(`Tool call: ${event.data?.name || '?'} ${truncate(String(event.data?.arguments || ''), 300)}`)
      }
    } catch {}
  }
  let joined = redactSecrets(lines.join('\n'))
  if (joined.length > maxChars) {
    const head = joined.slice(0, Math.floor(maxChars * 0.6))
    const tail = joined.slice(-Math.floor(maxChars * 0.35))
    joined = `${head}\n...[truncated ${joined.length - maxChars} chars]...\n${tail}`
  }
  return joined
}

function compactGlobalIndex(index) {
  return Object.entries(index.entries || {})
    .filter(([, e]) => e.status !== 'archived')
    .slice(0, 200)
    .map(([id, e]) => ({
      id,
      track: e.track || 'memory',
      domain: e.domain || 'unknown',
      applies_to: Array.isArray(e.appliesTo) ? e.appliesTo : [],
      title: e.title || '',
      content: truncate(e.content || '', 600),
      confidence: e.confidence ?? null,
      status: e.status || 'active',
    }))
}

async function readSession(sessionQuery, id) {
  if (typeof sessionQuery.readSession === 'function') {
    const snapshot = await sessionQuery.readSession(id)
    return {
      events: snapshot?.events || [],
      header: snapshot?.session || null,
      inheritedEventCount: snapshot?.inheritedEventCount ?? null,
    }
  }
  if (typeof sessionQuery.observeSession === 'function') {
    const observation = await sessionQuery.observeSession(id, { projectionMode: 'none' })
    try {
      return {
        events: observation?.events || [],
        header: observation?.header || null,
        inheritedEventCount: observation?.inheritedEventCount ?? null,
      }
    } finally {
      try { observation?.[Symbol.dispose]?.() } catch {}
    }
  }
  throw new Error('sessionQuery has neither readSession nor observeSession')
}

async function readSessionMeta(sessionQuery, ids) {
  const out = new Map()
  try {
    const records = await sessionQuery.listSessions()
    for (const record of records || []) {
      // `SessionRecord` carries only header + liveness; the title arrives from
      // readTitleSnapshots below, so keep the record and a mutable title slot.
      out.set(record.header?.id, { ...record, title: record.header?.title || '' })
    }
  } catch {}
  try {
    if (typeof sessionQuery.readTitleSnapshots === 'function') {
      // One result per requested id: `{ sessionId, status, value: { session, title? } }`.
      const titles = await sessionQuery.readTitleSnapshots(ids)
      for (const r of titles || []) {
        if (r?.status !== 'fulfilled' || !r.sessionId || !out.has(r.sessionId)) continue
        const title = r.value?.title?.title || r.value?.session?.title
        if (title) out.get(r.sessionId).title = title
      }
    }
  } catch {}
  return out
}

function parseJsonObject(text) {
  const raw = String(text || '').trim()
  try { return JSON.parse(raw) } catch {}
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)) } catch {}
  }
  return null
}

function validDomain(domain) {
  const d = String(domain || '').trim()
  return d === 'universal' || d === 'coding' || d === 'rp' || d === 'tooling' || d === 'personal' || d === 'general' || d.startsWith('project:')
}

function agentOptionsFor(model) {
  const value = String(model || '').trim()
  if (!value) return undefined
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

export function listCurationJobs() {
  return [...jobs.values()].map((j) => ({
    id: j.id, status: j.status, step: j.step, createdAt: j.createdAt, endedAt: j.endedAt,
    error: j.error || null, result: j.result || null,
  }))
}

export function getCurationJob(id) {
  const job = jobs.get(id)
  if (!job) return null
  return {
    id: job.id,
    status: job.status,
    step: job.step,
    logs: job.logs.slice(-80),
    createdAt: job.createdAt,
    endedAt: job.endedAt || null,
    error: job.error || null,
    result: job.result || null,
  }
}

export function cancelCurationJob(id) {
  const job = jobs.get(id)
  if (!job) return false
  try { job.abort.abort(new Error('cancelled by user')) } catch {}
  return true
}

// Exported for the audit regression suite: merging the commit decision logic
// into startGlobalCuration would require standing up subagents to test it.
export async function commitCuratorOutput(output, { job }) {
  const memories = Array.isArray(output?.memories) ? output.memories : []
  if (memories.length === 0) return { files: [], created: 0, merged: 0, superseded: 0, pending: 0, skipped: [] }
  const index = loadGlobalIndex()
  const files = []
  const updates = []
  const skipped = []
  const pending = []
  const now = new Date().toISOString()

  for (const m of memories) {
    // 'conflict' is the curator admitting two sessions disagree. Auto-picking a
    // winner would silently rewrite shared memory, so it waits for a human.
    const evidence = Array.isArray(m?.evidence) ? m.evidence.filter(item => typeof item?.session_id === 'string' && item.session_id && typeof item?.quote === 'string' && item.quote.trim()).slice(0, 20) : []
    const wantsReview = m?.op === 'conflict' || m?.needs_review === true || !evidence.length
    const op = ['create', 'merge', 'supersede', 'noop', 'conflict'].includes(m?.op) ? m.op : 'create'
    if (op === 'noop') continue
    const domain = String(m?.domain || '').trim()
    if (!validDomain(domain)) {
      skipped.push({ title: m?.title, reason: `invalid domain: ${domain}` })
      continue
    }
    const track = m?.track === 'skill' ? 'skill' : 'memory'
    const title = String(m?.title || '').trim()
    const content = String(m?.content || '').trim()
    if (!title || !content) {
      skipped.push({ title, reason: 'missing title or content' })
      continue
    }
    const targetId = String(m?.target_id || '').trim()
    let id
    let previous = null
    if ((op === 'merge' || op === 'supersede') && targetId && index.entries[targetId]) {
      previous = index.entries[targetId]
      // A reviewed (held) entry must never occupy the target's id: rejecting the
      // review would archive the only copy and the original active memory would
      // be gone. Held entries always get their own id; only a clean merge writes
      // in place.
      id = newMemoryId('gmem')
    } else {
      if (op === 'merge' || op === 'supersede') {
        skipped.push({ title, reason: `target not found: ${targetId || '(empty)'}` })
      }
      id = newMemoryId('gmem')
    }
    const entry = {
      track,
      domain,
      appliesTo: Array.isArray(m?.applies_to) ? m.applies_to.slice(0, 20) : [],
      title: truncate(title, 180),
      content: redactSecrets(content),
      confidence: Number.isFinite(Number(m?.confidence)) ? Math.max(0, Math.min(1, Number(m.confidence))) : 0.6,
      evidence: evidence.map((e) => ({
          sessionId: String(e?.session_id || ''),
          quote: truncate(e?.quote || '', 500),
        })),
      status: 'active',
      supersedes: op === 'supersede' ? targetId || null : previous?.supersedes || null,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    }
    if (wantsReview) {
      // Held in the index only: never committed to MemU, so a contested claim
      // cannot be recalled as shared memory until someone decides.
      entry.status = 'pending_review'
      entry.reviewReason = !evidence.length ? 'missing evidence' : op === 'conflict' ? 'conflict' : String(m?.review_reason || 'low confidence')
      entry.conflictingWith = targetId || previous?.id || null
      pending.push({ id, entry })
      continue
    }
    files.push({ name: id, track, description: truncate(title, 180), content })
    updates.push({ id, entry, op, targetId, previous })
  }

  if (files.length === 0) {
    if (pending.length) await retryStoreWrite(() => updateGlobalIndex(fresh => {
      for (const { id, entry } of pending) fresh.entries[id] = entry
    }))
    return { files: [], created: 0, merged: 0, superseded: 0, pending: pending.length, skipped }
  }

  job.step = `committing ${files.length} global memories`
  // In agent mode the JSON index is the store. Only the explicit remote backend
  // needs MemU's database, so local curation stays fast and key-free.
  if (getMemoryBackend() === 'api') {
    await commit({
      payload: { recall_files: files, resource: [], user: {} },
      db: globalDbPath(),
    })
  }

  if (job?.abort?.signal?.aborted) throw new Error('cancelled by user')
  await retryStoreWrite(() => updateGlobalIndex(fresh => {
    for (const { id, entry } of pending) fresh.entries[id] = entry
    for (const { id, entry, op, targetId, previous } of updates) {
    if (previous && JSON.stringify(fresh.entries[targetId]) !== JSON.stringify(previous)) {
      const heldId = newMemoryId('gmem')
      fresh.entries[heldId] = { ...entry, status: 'pending_review', conflictingWith: targetId, reviewReason: 'target changed while curator was running' }
      continue
    }
    if (op === 'merge' && previous) {
      entry.content = entry.content || previous.content
      entry.title = entry.title || previous.title
      entry.evidence = [...(previous.evidence || []), ...(entry.evidence || [])].slice(-40)
    }
    fresh.entries[id] = entry
    if ((op === 'supersede' || op === 'merge') && targetId && fresh.entries[targetId]) {
      fresh.entries[targetId].status = 'superseded'
      fresh.entries[targetId].supersededBy = id
      fresh.entries[targetId].validTo = now
      fresh.entries[targetId].updatedAt = now
    }
    }
  }))
  return {
    files,
    created: updates.filter((u) => u.op === 'create').length,
    merged: updates.filter((u) => u.op === 'merge').length,
    superseded: updates.filter((u) => u.op === 'supersede').length,
    pending: pending.length,
    skipped,
  }
}

export function startGlobalCuration(ctx, { sessionIds, parentSessionId, model } = {}) {
  const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).filter((s) => typeof s === 'string' && s.trim()))]
  const jobId = `curate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const abort = new AbortController()
  const job = {
    id: jobId,
    status: 'running',
    step: 'queued',
    logs: [],
    createdAt: new Date().toISOString(),
    endedAt: null,
    error: null,
    result: null,
    abort,
  }
  jobs.set(jobId, job)
  const log = (line) => {
    job.logs.push(`[${new Date().toISOString()}] ${line}`)
    if (job.logs.length > 200) job.logs.splice(0, job.logs.length - 200)
  }

  void (async () => {
    try {
      if (ids.length === 0) throw new Error('select at least one conversation')
      if (ids.length > MAX_SESSIONS) throw new Error(`at most ${MAX_SESSIONS} conversations per curation`)
      const sessionQuery = ctx.get?.('sessionQuery')
      if (!sessionQuery) throw new Error('sessionQuery is unavailable')
      const agents = ctx.get?.('agents')
      const parent = agents?.get?.(parentSessionId)
      if (!parent) throw new Error('the current conversation is not live; open a live conversation and retry')
      const subagents = ctx.get?.('subagents')
      if (!subagents?.startActivation) throw new Error('subagents service is unavailable')

      job.step = 'reading sessions'
      log(`reading ${ids.length} session(s)`)
      const meta = await readSessionMeta(sessionQuery, ids)
      const sessions = []
      let total = 0
      for (const id of ids) {
        if (abort.signal.aborted) throw new Error('cancelled by user')
        const snapshot = await readSession(sessionQuery, id)
        const record = meta.get(id)
        const header = snapshot.header || record?.header || {}
        const remaining = Math.max(2000, Math.min(MAX_SESSION_CHARS, MAX_TOTAL_CHARS - total))
        const transcript = condenseEvents(snapshot.events, remaining)
        total += transcript.length
        sessions.push({
          id,
          title: record?.title || record?.displayTitle || header.title || '',
          createdAt: header.createdAt || null,
          cwd: header.cwd || '',
          agentPreset: header.agentPreset || '',
          live: record?.live === true,
          transcript,
        })
        if (total >= MAX_TOTAL_CHARS) break
      }

      const existing = compactGlobalIndex(loadGlobalIndex())
      const input = JSON.stringify({ sessions, existing_global_index: existing }, null, 2)
      const prompt = loadPrompt('global-curator', { input }).text
      job.step = 'curator running'
      log('starting non-main curator subagent')
      const activation = await subagents.startActivation({
        provider: 'spawn',
        label: 'dsh-memu-memory global curator',
        delivery: 'caller',
        signal: abort.signal,
        request: {
          parent,
          cwd: parent.session?.header?.cwd,
          prompt: [{ type: 'text', text: prompt }],
          ...(agentOptionsFor(model || getSettings().curatorModel)
            ? { agentOptions: agentOptionsFor(model || getSettings().curatorModel) }
            : {}),
        },
      })
      let result
      try {
        result = await activation.result
      } finally {
        try { await activation.dispose() } catch {}
      }
      if (result?.stopReason !== 'completed') {
        throw new Error(`curator stopped: ${result?.stopReason || 'unknown'}`)
      }
      const text = textOf(result.output)
      const output = parseJsonObject(text)
      if (!output || !Array.isArray(output.memories)) {
        throw new Error(`curator did not return valid JSON: ${truncate(text, 800)}`)
      }
      job.step = 'committing'
      const committed = await commitCuratorOutput(output, { job })
      job.status = 'completed'
      job.endedAt = new Date().toISOString()
      job.result = {
        sessions: output.sessions || [],
        domainSummary: output.domain_summary || {},
        created: committed.created,
        merged: committed.merged,
        superseded: committed.superseded,
        skipped: committed.skipped,
      }
      log(`done: ${committed.created} created, ${committed.merged} merged, ${committed.superseded} superseded`)
    } catch (error) {
      const aborted = abort.signal.aborted || /cancelled by user/.test(String(error?.message || ''))
      job.status = aborted ? 'cancelled' : 'error'
      job.error = String(error?.message || error)
      job.endedAt = new Date().toISOString()
      log(`${job.status}: ${job.error}`)
    }
  })()

  return getCurationJob(jobId)
}

export { readSession as readSessionSnapshot }
