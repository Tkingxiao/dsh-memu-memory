import crypto from 'node:crypto'
import { getSessionBinding, setSessionBinding, getSettings, effectiveScope, flushState } from './state.js'
import { normalizeMemoryContext, contextVisible } from './context.js'
import { captureMessageMedia } from './media.js'
import { redactSecrets } from './paths.js'

export const INBOUND_TYPE = 'dsh-memu-memory/inbound-batch'
const MAX_MESSAGES = 32
const MAX_TEXT = 4000
const MAX_PENDING_BYTES = 96 * 1024
const MAX_SEEN = 2048
const mediaJobs = new Map()
const calls = new Map()
const sessions = new Map()

function identity(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\u0000-\u001f]/.test(value)) throw new Error(`${label} must be a stable 1-160 character id`)
  return value
}

export function normalizeInboundBatch(batch) {
  if (!batch || batch.type !== INBOUND_TYPE || batch.version !== 1) throw new Error('unsupported inbound message protocol')
  const batchId = identity(batch.batchId, 'batchId')
  const producer = identity(batch.producer, 'producer')
  if (!Array.isArray(batch.messages) || batch.messages.length > MAX_MESSAGES) throw new Error('inbound batch must contain at most 32 messages')
  const messages = batch.messages.map(message => {
    if (message?.role !== 'user') throw new Error('only explicit human user messages can trigger continuation memory')
    const id = identity(message.id, 'message id')
    const context = normalizeMemoryContext(message.context)
    if (!Array.isArray(message.content) || message.content.length > 16) throw new Error('inbound message content must contain at most 16 blocks')
    const content = message.content.map(block => {
      if (block?.type === 'text' && typeof block.text === 'string') {
        if (block.text.length > MAX_TEXT) throw new Error('inbound text exceeds 4000 characters; split the message batch')
        return { type: 'text', text: redactSecrets(block.text) }
      }
      if (block?.type === 'image' && block.attachment) {
        const ref = block.attachment
        identity(ref.attachmentId, 'attachmentId')
        if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(ref.mediaType)
          || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0
          || !Number.isSafeInteger(ref.width) || ref.width <= 0 || !Number.isSafeInteger(ref.height) || ref.height <= 0) throw new Error('image must use a host-admitted attachment reference')
        return { type: 'image', attachment: {
          attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height,
          ...(typeof ref.name === 'string' ? { name: ref.name.slice(0, 120) } : {}),
        } }
      }
      throw new Error('inbound content only accepts text and host image references, not paths, URLs, tool logs or instructions')
    })
    if (!content.some(block => block.type === 'image' || block.text.trim())) throw new Error('inbound messages must not be empty')
    return { id, role: 'user', context, content, producer }
  })
  if (Buffer.byteLength(JSON.stringify(messages)) > MAX_PENDING_BYTES) throw new Error('inbound batch exceeds the 96 KB queue limit')
  return { type: INBOUND_TYPE, version: 1, producer, batchId, messages }
}

function messageKey(message) {
  return crypto.createHash('sha256').update(JSON.stringify([
    message.producer || 'host.user', message.context?.channelId || '', message.context?.speakerId || '', message.id,
  ])).digest('hex')
}

function deliveryClaim(batch) {
  return crypto.createHash('sha256').update(JSON.stringify([batch.producer, batch.batchId])).digest('hex')
}

function journal(binding) {
  return { seen: [], claimed: [], pending: [], clock: 0, ...(binding?.inbound || {}) }
}

export function nativeInboundMessage(message) {
  let images = 0
  const content = (message?.content || []).filter(block => block?.type === 'text' || block?.type === 'image')
    .filter(block => block.type !== 'image' || ++images <= 8).slice(0, 16)
    .map(block => block.type === 'text' ? { type: 'text', text: String(block.text || '').slice(0, MAX_TEXT) } : block)
  return content.some(block => block.type === 'image' || block.text.trim()) ? { id: message.id, role: 'user', content } : null
}

function currentSession(sessionId, session) {
  return session || sessions.get(sessionId) || { header: { id: sessionId } }
}

function beginCapture(ctx, sessionId, session, items) {
  if (!ctx || !items.some(item => item.content.some(block => block.type === 'image'))) return
  const previous = mediaJobs.get(sessionId) || Promise.resolve()
  const task = previous.catch(() => {}).then(async () => {
    for (const item of items) {
      const binding = getSessionBinding(sessionId)
      if (!binding || binding.libraryId !== item.libraryId || !effectiveScope(binding).useLibrary
        || !contextVisible(item.context, binding.memoryContext)) continue
      await captureMessageMedia(ctx, currentSession(sessionId, session), item, { eventKey: item.mediaEventKey || `inbound:${item.key}` })
    }
  }).catch(error => {
    if (getSessionBinding(sessionId)) setSessionBinding(sessionId, { lastInboundError: `attachment capture failed: ${redactSecrets(error?.message || error)}` })
  })
  mediaJobs.set(sessionId, task)
  void task.finally(() => { if (mediaJobs.get(sessionId) === task) mediaJobs.delete(sessionId) })
}

/** Explicit producer bridge. No model invocation, inbox message or memory creation. */
export function ingestInboundBatch({ sessionId, batch, session, ctx, now = Date.now(), mediaEventKey = null }) {
  const binding = getSessionBinding(sessionId)
  if (!binding) throw new Error('bind the conversation before submitting an inbound batch')
  if (session?.header?.origin === 'subagent') throw new Error('subagents cannot submit external human message batches')
  const normalized = normalizeInboundBatch(batch)
  const before = journal(binding)
  const claim = deliveryClaim(normalized)
  if (before.claimed.includes(claim)) return { accepted: 0, duplicate: normalized.messages.length, pending: before.pending.length }
  const seen = new Set(before.seen)
  const existing = new Set(before.pending.map(item => item.key))
  const accepted = []
  for (const message of normalized.messages) {
    const context = { ...binding.memoryContext, ...message.context }
    // A producer cannot use the bridge to move a conversation across worlds/groups.
    if (!contextVisible({ ...context, knownBy: [] }, binding.memoryContext)
      || ['channelId', 'characterId', 'worldId', 'branchId'].some(key => binding.memoryContext?.[key] && context[key] !== binding.memoryContext[key])) throw new Error('inbound message is outside the conversation memory context')
    const item = { ...message, context, libraryId: binding.libraryId || null, batchId: normalized.batchId, ...(mediaEventKey ? { mediaEventKey } : {}) }
    item.key = messageKey(item)
    if (!seen.has(item.key) && !existing.has(item.key)) { accepted.push(item); existing.add(item.key) }
  }
  if (!accepted.length) return { accepted: 0, duplicate: normalized.messages.length, pending: before.pending.length }
  const pending = [...before.pending, ...accepted]
  const imageCount = pending.reduce((count, item) => count + item.content.filter(block => block.type === 'image').length, 0)
  if (pending.length > MAX_MESSAGES || imageCount > 8 || Buffer.byteLength(JSON.stringify(pending)) > MAX_PENDING_BYTES) throw new Error('inbound queue is full; drain it before submitting another batch (32 messages / 8 images / 96 KB)')
  const at = new Date(now).toISOString()
  setSessionBinding(sessionId, {
    inbound: { ...before, pending, retryAt: null }, lastInboundAt: at, lastTurnAt: at,
    lastInboundError: null,
    // A message just came out of this conversation, so it exists. Clears the mark
    // the sleep pass puts on a session the host reported as deleted (a fork/session
    // can be recreated under the same id after a restore).
    sessionGone: false, sessionGoneAt: null,
  })
  flushState()
  if (session) sessions.set(sessionId, session)
  if (effectiveScope(binding).useLibrary) beginCapture(ctx, sessionId, session, accepted)
  return { accepted: accepted.length, duplicate: normalized.messages.length - accepted.length, pending: pending.length }
}

export function noteNativeUserMessages(sessionId, messages, { now = Date.now() } = {}) {
  const binding = getSessionBinding(sessionId)
  if (!binding) return
  const before = journal(binding)
  const keys = messages.filter(message => message?.source?.kind === 'user' && message.role === 'user' && typeof message.id === 'string')
    .map(message => messageKey({ id: message.id, context: binding.memoryContext }))
  const seen = [...new Set([...before.seen, ...keys])].slice(-MAX_SEEN)
  setSessionBinding(sessionId, {
    inbound: { ...before, seen, pending: before.pending.filter(item => !keys.includes(item.key)) },
    lastTurnAt: new Date(now).toISOString(),
    sessionGone: false, sessionGoneAt: null,
  })
}

export function hasPendingInbound(sessionId) {
  const inbound = getSessionBinding(sessionId)?.inbound
  return Boolean(inbound?.pending?.length) && !(Date.parse(inbound.retryAt || '') > Date.now())
}

export async function pendingInbound(sessionId, ctx, session) {
  const first = journal(getSessionBinding(sessionId)).pending
  // Persisted queues can recover media collection after a restart.
  beginCapture(ctx, sessionId, session, first)
  await mediaJobs.get(sessionId)
  const stillPending = new Set(journal(getSessionBinding(sessionId)).pending.map(item => item.key))
  return first.filter(item => stillPending.has(item.key))
}

export function finishInbound(sessionId, keys, clock, outcome) {
  const binding = getSessionBinding(sessionId)
  if (!binding) return
  const before = journal(binding)
  const done = new Set(keys)
  const claims = before.pending.filter(item => done.has(item.key)).map(item => deliveryClaim({ producer: item.producer, batchId: item.batchId }))
  setSessionBinding(sessionId, {
    inbound: { ...before, seen: [...new Set([...before.seen, ...keys])].slice(-MAX_SEEN), claimed: [...new Set([...before.claimed, ...claims])].slice(-MAX_SEEN), pending: before.pending.filter(item => !done.has(item.key)), clock, retryAt: null },
    lastInboundOutcome: { ...outcome, at: new Date().toISOString(), count: keys.length },
  })
  flushState()
}

export function nextMemoryClock(binding, turn) {
  const prior = Math.max(0, Number(binding?.inbound?.clock || 0), Number(binding?.lastInjectedTurn || 0),
    ...Object.values(binding?.injectedAt || {}).map(value => Number(value) || 0))
  return Math.max(Number(turn) || 0, prior + 1)
}

export function advanceMemoryClock(sessionId, clock) {
  const binding = getSessionBinding(sessionId)
  if (binding) setSessionBinding(sessionId, { inbound: { ...journal(binding), clock } })
}

export function inboundProtocolFromResult(event, toolName) {
  const message = event?.data?.message
  if (message?.isError || message?.role !== 'tool') return null
  // Metadata belongs to the producing tool, unlike a JSON snippet quoted in a log.
  const declared = event.data?.meta?.memoryInbound
  if (declared !== undefined) return normalizeInboundBatch(declared)
  const allowed = Array.isArray(getSettings().inboundToolNames) ? getSettings().inboundToolNames : []
  if (!toolName || !allowed.includes(toolName)) return null
  const text = (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
  if (!text || text.length > MAX_PENDING_BYTES) return null
  let value
  try { value = JSON.parse(text) } catch { return null }
  // Never search inside arbitrary logs/code fences or guess that sleep text is speech.
  return value?.type === INBOUND_TYPE ? normalizeInboundBatch(value) : null
}

export function observeInboundEvent(ctx, session, event) {
  const id = session?.header?.id
  if (!id || session.header.origin === 'subagent') return
  sessions.set(id, session)
  if (event?.type === 'tool/call') {
    const map = calls.get(id) || new Map()
    map.set(event.data.callId, event.data.name)
    if (map.size > 128) map.delete(map.keys().next().value)
    calls.set(id, map)
  } else if (event?.type === 'tool/result') {
    const callId = event.data?.message?.toolCallId || event.data?.message?.source?.callId
    const name = calls.get(id)?.get(callId)
    try {
      const batch = inboundProtocolFromResult(event, name)
      if (batch) ingestInboundBatch({ sessionId: id, batch, session, ctx })
      else if (getSessionBinding(id) && (getSettings().inboundToolNames || []).includes(name)) {
        setSessionBinding(id, { lastInboundOutcome: {
          reason: event.data?.message?.isError ? 'tool-error' : 'unstructured-tool-result',
          at: new Date().toISOString(), count: 0, injectedCount: 0,
        } })
      }
    } finally { calls.get(id)?.delete(callId) }
  } else if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
    const binding = getSessionBinding(id)
    if (!binding || !event.data.id) return
    const message = nativeInboundMessage(event.data)
    if (!message) { noteNativeUserMessages(id, [event.data]); return }
    ingestInboundBatch({ sessionId: id, session, ctx, batch: {
      type: INBOUND_TYPE, version: 1, producer: 'host.user', batchId: `user:${event.data.id}`,
      messages: [message],
    }, mediaEventKey: event.seq !== undefined ? `seq:${event.seq}` : `id:${event.data.id}` })
  } else if (event?.type === 'turn/end') {
    calls.delete(id)
  }
}

export function releaseInboundSession(sessionId) {
  calls.delete(sessionId)
  sessions.delete(sessionId)
  mediaJobs.delete(sessionId)
}
