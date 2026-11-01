#!/usr/bin/env node
/**
 * EVALUATION ONLY — local fake OpenAI-compatible endpoint for work order B.
 *
 * This file is a developer measurement harness. It is never imported by
 * lib/, never shipped as runtime behaviour, and must not be pointed at real
 * user conversations that should be kept. It listens on 127.0.0.1 only, has no
 * authentication, and stores only lengths, hashes and marker counts — never
 * message bodies.
 *
 * Why it exists: the mock sees the exact model request the host builds, so the
 * injection report can state which memory blocks (and how many) reached the
 * model on each request. The marker set is pinned to plugin 1.2.3
 * (lib/inject.js); update MARKERS together with that file, not from memory.
 *
 * Usage:
 *   node scripts/mock-llm.mjs --port 8123 --log ./mock-llm-2026-11-01.jsonl
 *   node scripts/mock-llm.mjs --reply-file ./tests/fixtures/mock-llm/reply.txt \
 *     --port 8123 --log ./mock-llm-2026-11-01.jsonl
 *   node scripts/mock-llm.mjs --report ./mock-llm-2026-11-01.jsonl > mock-llm-report-2026-11-01.md
 *
 * Endpoints:
 *   POST /v1/chat/completions   (also /chat/completions for a root base URL)
 *   GET  /v1/models             (also /models)
 *   GET  /health                (liveness only)
 *
 * The SSE reply is deliberately plain text: it never claims a tool call, so a
 * measurement run cannot turn into a fake tool round.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

/** One JSONL schema version; bump only for a breaking field change. */
export const LOG_VERSION = 1

/** Model id served by GET /v1/models unless --model overrides it. */
export const DEFAULT_MODEL = 'dsh-mock-llm'

/** Reply used when --reply-file is absent. */
export const DEFAULT_REPLY = '（测试回复）'

/** Plugin version whose injection markers are pinned below. */
export const MARKER_SET_VERSION = '1.2.3'

const MAX_BODY_BYTES = 16 * 1024 * 1024

/**
 * The 1.2.3 injection markers, in report order.
 *
 * Source of truth: lib/inject.js (verified 2026-11-01 / 1.2.3).
 * - `<memory-guide` is a prefix because the open tag carries rules="…".
 * - `<memory-cue` / `<memory-texture` / `<memory-context` carry attributes.
 * - The replay line is matched literally, including the U+00B7 middle dot.
 *
 * Adding, renaming or dropping a block in lib/inject.js means changing this table
 * in the same commit and bumping MARKER_SET_VERSION; a stale table reports a real
 * block as zero injections, which is worse than no measurement.
 */
export const MARKERS = Object.freeze([
  { key: 'guide', column: 'guide', marker: '<memory-guide', meaning: 'rules guide message (first step / rules change)' },
  { key: 'anchor', column: 'anchor', marker: '===== memory anchor =====', meaning: 'anchor title card (no body in 1.2.3)' },
  { key: 'due', column: 'due', marker: '<memory-due>', meaning: 'dated memory due today/tomorrow' },
  { key: 'anniversary', column: 'anniv', marker: '<memory-anniversary>', meaning: 'annual anniversary block' },
  { key: 'cue', column: 'cue', marker: '<memory-cue', meaning: 'random/source cue' },
  { key: 'texture', column: 'texture', marker: '<memory-texture', meaning: 'imagined texture line' },
  { key: 'media', column: 'media', marker: '<memory-media>', meaning: 'image reference block' },
  { key: 'lexicon', column: 'lexicon', marker: '<memory-lexicon>', meaning: 'lexicon B channel' },
  { key: 'context', column: 'ctx', marker: '<memory-context', meaning: 'per-turn recall title card' },
  { key: 'openLoop', column: 'loop', marker: '[open loop]', meaning: 'open-loop nudge' },
  { key: 'freshness', column: 'fresh', marker: '<memory-freshness>', meaning: 'time-sensitivity hint under a recall block' },
  { key: 'replay', column: 'replay', marker: '[replay · 压缩前在上下文里的记忆]', meaning: 'post-compaction replay' },
])

/** Marker key order used by the matrix and totals. */
export const MARKER_KEYS = Object.freeze(MARKERS.map((item) => item.key))

const USAGE = `EVALUATION ONLY — local fake OpenAI-compatible server for injection measurement.

Usage:
  node scripts/mock-llm.mjs [options]
  node scripts/mock-llm.mjs --report [file] [--log file]

Options:
  --port <n>          Loopback port, 0 asks the OS. Default: 8123.
  --model <id>        Model id served by GET /v1/models and echoed in frames.
                      Default: ${DEFAULT_MODEL}.
  --reply-file <p>    Plain-text assistant reply. Default: ${JSON.stringify(DEFAULT_REPLY)}.
  --log <p>           Append one JSONL record per request (lengths + markers only).
  --report [p]        Do not start a server; read a JSONL log and print a markdown
                      report. The path defaults to --log.
  -h, --help          Show this text.

Safety:
  * Binds 127.0.0.1 only; there is no authentication.
  * Message bodies are never written. Only role, character length, a content
    hash and marker counts are logged.
  * Rotate/delete logs and reports; do not commit captured conversation data.

Marker set (plugin 1.2.3, lib/inject.js):
${MARKERS.map((item) => `  ${item.column.padEnd(8)} ${item.marker}`).join('\n')}
`

/** Count non-overlapping occurrences of one literal marker. */
export function countOccurrences(text, needle) {
  if (typeof text !== 'string' || text.length === 0 || !needle) return 0
  let count = 0
  let at = text.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = text.indexOf(needle, at + needle.length)
  }
  return count
}

/** Count every pinned 1.2.3 marker in one block of text. */
export function countMemoryMarkers(text) {
  const counts = {}
  for (const item of MARKERS) counts[item.key] = countOccurrences(text, item.marker)
  return counts
}

/** Sum marker maps, ignoring unknown keys. */
function sumMarkers(list) {
  const total = {}
  for (const key of MARKER_KEYS) total[key] = 0
  for (const counts of list) {
    for (const key of MARKER_KEYS) total[key] += Number(counts?.[key] || 0)
  }
  return total
}

/**
 * Extract text from an OpenAI chat message or an Anthropic-shaped block list.
 * Image/tool blocks contribute no text; the caller counts them structurally.
 */
export function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part.text === 'string') return part.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** Hash that lets a report diff requests without storing their text. */
function contentHash(role, text) {
  return crypto.createHash('sha256').update(String(role) + '\u0000' + String(text), 'utf8').digest('hex').slice(0, 16)
}

const CONTEXT_RE = /<memory-context\b([^>]*)>([\s\S]*?)<\/memory-context>/g
const CARD_LINE_RE = /^\s*-\s+\[([^\]]+)\]/

/**
 * Structural facts about `<memory-context>` blocks in one message.
 *
 * `bodyLines` counts indented continuation lines. 1.2.3 renders title cards as
 * one line per entry; a positive count means body text leaked into the prompt.
 */
export function analyzeMemoryContext(text, idSink = null) {
  const stats = {
    blocks: 0,
    ids: 0,
    uniqueIds: 0,
    cardLines: 0,
    bodyLines: 0,
    scopes: { private: 0, global: 0, other: 0 },
  }
  if (typeof text !== 'string' || !text.includes('<memory-context')) return stats
  const ids = new Set()
  CONTEXT_RE.lastIndex = 0
  let block
  while ((block = CONTEXT_RE.exec(text)) !== null) {
    stats.blocks += 1
    const scope = /scope="([^"]+)"/.exec(block[1] || '')?.[1]
    if (scope === 'private' || scope === 'global') stats.scopes[scope] += 1
    else stats.scopes.other += 1
    for (const line of block[2].split(/\r?\n/)) {
      const card = CARD_LINE_RE.exec(line)
      if (card) {
        stats.cardLines += 1
        stats.ids += 1
        ids.add(card[1])
        if (idSink) idSink.add(card[1])
        continue
      }
      if (/^\s{2,}\S/.test(line)) stats.bodyLines += 1
    }
  }
  stats.uniqueIds = ids.size
  return stats
}

/** Analyse one message: role, length, hash, markers and context structure. */
export function analyzeMessage(message, roleOverride = null, idSink = null) {
  const role = roleOverride || String(message?.role || 'unknown')
  const text = messageText(message)
  const context = analyzeMemoryContext(text, idSink)
  // The guide message talks *about* `<memory-context>` in its prose
  // (system-guide.md). Counting that sentence as a recall block would put a
  // phantom ctx hit on every guided turn, so a guide carrier counts only the
  // guide tag itself; every other message is counted literally.
  const guideCarrier = /^\s*<memory-guide\b/.test(text)
  const counts = guideCarrier
    ? { guide: countOccurrences(text, '<memory-guide') }
    : countMemoryMarkers(text)
  const part = {
    role,
    chars: text.length,
    hash: contentHash(role, text),
    markers: Object.fromEntries(Object.entries(counts).filter(([, value]) => value > 0)),
  }
  if (context.blocks > 0) part.context = context
  return part
}

/** Analyse a chat-completions request body without retaining any message text. */
export function analyzeRequestBody(body, model) {
  const rawMessages = Array.isArray(body?.messages) ? body.messages : []
  const parts = []
  const allContextIds = new Set()
  // OpenAI chat requests carry the system prompt inside messages. Anthropic's
  // Messages shape keeps it top-level; counting it keeps the delta stable if a
  // provider base URL is pointed at this mock by mistake.
  if (typeof body?.system === 'string' && body.system.trim()) {
    parts.push(analyzeMessage({ role: 'system', content: body.system }, 'system', allContextIds))
  }
  for (const message of rawMessages) parts.push(analyzeMessage(message, null, allContextIds))
  const markers = sumMarkers(parts.map((part) => part.markers))
  const context = {
    blocks: parts.reduce((sum, part) => sum + (part.context?.blocks || 0), 0),
    ids: parts.reduce((sum, part) => sum + (part.context?.ids || 0), 0),
    uniqueIds: allContextIds.size,
    cardLines: parts.reduce((sum, part) => sum + (part.context?.cardLines || 0), 0),
    bodyLines: parts.reduce((sum, part) => sum + (part.context?.bodyLines || 0), 0),
    scopes: {
      private: parts.reduce((sum, part) => sum + (part.context?.scopes?.private || 0), 0),
      global: parts.reduce((sum, part) => sum + (part.context?.scopes?.global || 0), 0),
      other: parts.reduce((sum, part) => sum + (part.context?.scopes?.other || 0), 0),
    },
  }
  const chars = parts.reduce((sum, part) => sum + part.chars, 0)
  const first = parts[0]
  const firstNonSystem = parts.find((part) => part.role !== 'system')
  // Conversation identity: the system prompt, the first non-system message and
  // the model. A single mock instance normally serves one session, but two
  // sessions can share a system prompt, so the first user message is part of
  // the key that keeps their deltas apart.
  const conversation = contentHash(
    'conversation:' + (body?.model || model || ''),
    [first ? first.hash : 'no-system', firstNonSystem ? firstNonSystem.hash : 'no-user'].join(':'),
  )
  return {
    model: typeof body?.model === 'string' && body.model ? body.model : model,
    messages: rawMessages.length,
    chars,
    markers,
    context,
    parts,
    conversation,
  }
}

function splitReply(text) {
  const chars = Array.from(String(text))
  if (chars.length === 0) return []
  // 24 frames is enough to exercise incremental delivery; larger replies grow
  // the chunk size instead of the frame count.
  const chunkSize = Math.max(8, Math.ceil(chars.length / 24))
  const chunks = []
  for (let i = 0; i < chars.length; i += chunkSize) chunks.push(chars.slice(i, i + chunkSize).join(''))
  return chunks
}

function completionChunk({ id, created, model, delta, finishReason = null }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

function writeSse(res, payload) {
  if (res.destroyed || res.writableEnded) return false
  res.write('data: ' + JSON.stringify(payload) + '\n\n')
  return true
}

function sendJson(res, status, value, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-mock-llm': 'evaluation-only',
    ...extraHeaders,
  })
  res.end(body)
}

function sendError(res, status, message, code = 'invalid_request_error', extraHeaders = {}) {
  sendJson(res, status, { error: { message, type: code, code } }, extraHeaders)
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        settled = true
        const error = new Error('request body exceeds the mock limit')
        error.status = 413
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    req.on('aborted', () => {
      if (settled) return
      settled = true
      const error = new Error('client aborted the request body')
      error.status = 400
      reject(error)
    })
  })
}

function appendJsonl(logPath, record) {
  if (!logPath) return
  fs.mkdirSync(path.dirname(path.resolve(logPath)), { recursive: true })
  fs.appendFileSync(logPath, JSON.stringify(record) + '\n', 'utf8')
}

function nowIso() {
  return new Date().toISOString()
}

/**
 * Start one loopback-only mock server.
 *
 * @param {object} [options]
 * @param {number} [options.port] TCP port; 0 asks the OS.
 * @param {string} [options.model] Model id to advertise.
 * @param {string} [options.reply] Plain-text assistant reply.
 * @param {string|null} [options.log] JSONL path to append; null disables it.
 * @returns {Promise<{url:string,port:number,model:string,log:string|null,server:http.Server,close:()=>Promise<void>}>}
 */
export async function startMockLlm(options = {}) {
  const port = Number.isInteger(options.port) ? options.port : 0
  if (port < 0 || port > 65535) throw new Error('port must be 0..65535')
  const model = typeof options.model === 'string' && options.model.trim() ? options.model.trim() : DEFAULT_MODEL
  const reply = typeof options.reply === 'string' ? options.reply : DEFAULT_REPLY
  const log = options.log ? path.resolve(options.log) : null
  const state = { seq: 0 }

  const server = http.createServer((req, res) => {
    void handleRequest({ req, res, state, model, reply, log })
  })

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  return {
    server,
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    model,
    log,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}

async function handleRequest({ req, res, state, model, reply, log }) {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const pathname = url.pathname

  if (pathname === '/health') {
    if (req.method !== 'GET') return sendError(res, 405, 'GET only', 'method_not_allowed', { allow: 'GET' })
    return sendJson(res, 200, { ok: true, model, evaluationOnly: true })
  }

  if (pathname === '/v1/models' || pathname === '/models') {
    if (req.method !== 'GET') return sendError(res, 405, 'GET only', 'method_not_allowed', { allow: 'GET' })
    return sendJson(res, 200, {
      object: 'list',
      data: [{ id: model, object: 'model', created: 0, owned_by: 'dsh-mock-llm' }],
    })
  }

  const knownChat = pathname === '/v1/chat/completions' || pathname === '/chat/completions'
  if (!knownChat) return sendError(res, 404, 'not found: ' + pathname, 'not_found')
  if (req.method !== 'POST') return sendError(res, 405, 'POST only', 'method_not_allowed', { allow: 'POST' })

  let raw
  try {
    raw = await readBody(req)
  } catch (error) {
    if (!res.destroyed) sendError(res, error.status || 400, error.message)
    return
  }

  let body
  try {
    body = JSON.parse(raw.toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be a JSON object')
  } catch (error) {
    // Safe status: a bad body is the caller's error, never a partial reply.
    sendError(res, 400, 'invalid JSON body: ' + error.message)
    return
  }

  const analysis = analyzeRequestBody(body, model)
  // Reserve the sequence before streaming: concurrent requests must not share
  // an id or a JSONL seq even though the append happens at completion.
  state.seq += 1
  const seq = state.seq
  const id = 'chatcmpl-mock-' + seq
  const created = Math.floor(Date.now() / 1000)
  const started = Date.now()
  const aborted = { value: false }
  const frames = { sent: 0 }
  let status = 200

  req.on('aborted', () => { aborted.value = true })
  req.on('error', () => { aborted.value = true })
  res.on('error', () => { aborted.value = true })
  res.on('close', () => { if (!res.writableEnded) aborted.value = true })

  const recordBase = {
    v: LOG_VERSION,
    event: 'request',
    time: nowIso(),
    seq,
    model: analysis.model,
    conversation: analysis.conversation,
    messages: analysis.messages,
    chars: analysis.chars,
    markers: analysis.markers,
    context: analysis.context,
    parts: analysis.parts,
  }

  try {
    if (body.stream === false) {
      const completion = {
        id,
        object: 'chat.completion',
        created,
        model: analysis.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: reply },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 0,
          completion_tokens: Array.from(reply).length,
          total_tokens: Array.from(reply).length,
        },
      }
      sendJson(res, 200, completion)
    } else {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-mock-llm': 'evaluation-only',
      })
      const base = { id, created, model: analysis.model }
      if (writeSse(res, completionChunk({ ...base, delta: { role: 'assistant', content: '' } }))) frames.sent += 1
      for (const text of splitReply(reply)) {
        if (aborted.value || res.destroyed) break
        if (writeSse(res, completionChunk({ ...base, delta: { content: text } }))) frames.sent += 1
      }
      if (!aborted.value && !res.destroyed) {
        // Explicit stop; no tool_calls are ever fabricated.
        writeSse(res, completionChunk({ ...base, delta: {}, finishReason: 'stop' }))
        frames.sent += 1
        res.write('data: [DONE]\n\n')
        res.end()
      }
    }
  } catch (error) {
    aborted.value = true
    if (!res.headersSent) {
      status = 500
      sendError(res, 500, 'mock stream failed: ' + error.message, 'server_error')
    } else {
      res.destroy()
    }
  } finally {
    try {
      appendJsonl(log, {
        ...recordBase,
        reply: { mode: body.stream === false ? 'json' : 'sse', chars: Array.from(reply).length, frames: frames.sent },
        status,
        aborted: aborted.value,
        durationMs: Date.now() - started,
      })
    } catch (error) {
      console.error('mock-llm: failed to append JSONL: ' + error.message)
    }
  }
}

function isoTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toISOString().slice(11, 19) + 'Z'
}

function shortestId(value) {
  const text = String(value || '?')
  return text.length > 8 ? text.slice(0, 8) : text
}

function markersFromParts(parts) {
  return sumMarkers(parts.map((part) => part.markers || {}))
}

function hasAnyMarker(markers) {
  return MARKER_KEYS.some((key) => Number(markers?.[key] || 0) > 0)
}

/**
 * Build the markdown report for one JSONL log.
 *
 * Per-request deltas are computed from the per-message hashes: the current
 * request's messages are compared with the previous request of the same
 * conversation as a multiset. When the message list is not a prefix of the new
 * one (compaction, transcript rewrite), the round is marked `rebased` and is
 * excluded from zero-injection attribution: the delta cannot be trusted.
 *
 * @param {string} jsonl raw log contents.
 * @param {{logPath?:string}} [options]
 * @returns {string} markdown
 */
export function renderReport(jsonl, options = {}) {
  const lines = String(jsonl || '').split(/\r?\n/).filter((line) => line.trim())
  const records = []
  let skipped = 0
  for (const line of lines) {
    let value
    try { value = JSON.parse(line) } catch { skipped += 1; continue }
    if (!value || typeof value !== 'object') { skipped += 1; continue }
    if (value.event !== undefined && value.event !== 'request') continue
    if (!value.markers || !Array.isArray(value.parts)) { skipped += 1; continue }
    records.push(value)
  }

  const out = []
  const conversationCount = new Set(records.map((record) => record.conversation || 'unknown')).size
  out.push('# Mock LLM injection report')
  out.push('')
  out.push('> EVALUATION ONLY. Generated from request metadata (lengths, hashes, marker counts); no message body is stored in the log.')
  out.push('')
  if (options.logPath) out.push(`- log: \`${options.logPath}\``)
  out.push(`- generated: ${new Date().toISOString().slice(0, 10)} (UTC)`)
  out.push(`- requests: ${records.length}`)
  out.push(`- conversations: ${conversationCount}`)
  out.push(`- marker set: plugin ${MARKER_SET_VERSION} (${MARKER_KEYS.length} markers)`)
  if (skipped) out.push(`- skipped/foreign JSONL lines: ${skipped}`)
  if (records.length > 1 && conversationCount === records.length) {
    out.push('- warning: every request has a different conversation fingerprint; the delta is not comparable (a changing system prompt, such as a timestamp, breaks the grouping).')
  }
  out.push('')
  out.push('## Legend')
  out.push('')
  out.push('| col | marker | meaning |')
  out.push('| --- | --- | --- |')
  for (const item of MARKERS) out.push(`| ${item.column} | \`${item.marker}\` | ${item.meaning} |`)
  out.push('')
  out.push('`Δ` below counts markers in messages that are **new relative to the previous request of the same conversation**. `·` means zero. `—` in a `rebased` row means the transcript changed shape and the delta is not reliable.')
  out.push('')

  const states = []
  let previousByConversation = new Map()
  let round = 0
  for (const record of records) {
    round += 1
    const conversation = record.conversation || 'unknown'
    const parts = Array.isArray(record.parts) ? record.parts : []
    const previous = previousByConversation.get(conversation) || null
    let mode = 'first'
    let newParts = parts
    if (previous) {
      const previousHashes = previous.map((part) => part.hash)
      const currentHashes = parts.map((part) => part.hash)
      const prefix = previousHashes.length <= currentHashes.length
        && previousHashes.every((hash, index) => hash === currentHashes[index])
      mode = prefix ? 'delta' : 'rebased'
      if (mode === 'delta') {
        const remaining = new Map()
        for (const hash of previousHashes) remaining.set(hash, (remaining.get(hash) || 0) + 1)
        newParts = []
        for (const part of parts) {
          const left = remaining.get(part.hash) || 0
          if (left > 0) remaining.set(part.hash, left - 1)
          else newParts.push(part)
        }
      }
    }
    previousByConversation.set(conversation, parts)
    const delta = markersFromParts(newParts)
    const unreliable = mode === 'rebased'
    states.push({
      round,
      conversation,
      record,
      mode,
      unreliable,
      parts,
      newParts,
      delta,
      zero: !unreliable && !hasAnyMarker(delta),
    })
  }

  out.push('## Per-request marker matrix')
  out.push('')
  out.push('`#` is the log order (not the per-process `seq`).')
  out.push('')
  const header = ['#', 'conv', 'time', 'msgs', 'Δmsgs', ...MARKERS.map((item) => item.column), 'ctxIds']
  out.push('| ' + header.join(' | ') + ' |')
  out.push('| ' + header.map(() => '---').join(' | ') + ' |')
  for (const state of states) {
    const record = state.record
    const cells = []
    if (state.unreliable) {
      for (let i = 0; i < MARKERS.length; i += 1) cells.push('—')
      cells.push('—')
    } else {
      for (const item of MARKERS) cells.push(state.delta[item.key] ? String(state.delta[item.key]) : '·')
      cells.push(state.mode === 'first' ? String(record.context?.ids || 0) : String(sumContextIds(state.newParts)))
    }
    const row = [
      String(state.round),
      shortestId(state.conversation),
      isoTime(record.time),
      String(record.messages ?? 0),
      state.unreliable ? '—' : String(state.newParts.length),
      ...cells,
    ]
    out.push('| ' + row.join(' | ') + ' |')
  }
  out.push('')

  out.push('## Totals by block')
  out.push('')
  out.push('| col | marker | rounds with Δ>0 | Δ total | requests containing (sum, history included) |')
  out.push('| --- | --- | --- | --- | --- |')
  for (const item of MARKERS) {
    let roundsWithDelta = 0
    let deltaTotal = 0
    let presentTotal = 0
    for (const state of states) {
      if (!state.unreliable && Number(state.delta[item.key] || 0) > 0) roundsWithDelta += 1
      if (!state.unreliable) deltaTotal += Number(state.delta[item.key] || 0)
      presentTotal += Number(state.record.markers?.[item.key] || 0)
    }
    out.push(`| ${item.column} | \`${item.marker}\` | ${roundsWithDelta} | ${deltaTotal} | ${presentTotal} |`)
  }
  out.push('')

  const contextStates = states.filter((state) => !state.unreliable && (state.record.context?.blocks || 0) > 0)
  out.push('## `<memory-context>` title cards')
  out.push('')
  if (contextStates.length === 0) {
    out.push('None.')
  } else {
    out.push('| # | conv | blocks | private | global | ids | unique | card lines | body lines |')
    out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const state of contextStates) {
      const context = state.record.context
      out.push(`| ${state.round} | ${shortestId(state.conversation)} | ${context.blocks || 0} | ${context.scopes?.private || 0} | ${context.scopes?.global || 0} | ${context.ids || 0} | ${context.uniqueIds || 0} | ${context.cardLines || 0} | ${context.bodyLines || 0} |`)
    }
    out.push('')
    out.push('This table shows request totals (history included), not per-turn deltas. `body lines` counts indented continuation lines inside the block: 1.2.3 title cards should keep it at 0, and a positive number means body text reached the prompt.')
  }
  out.push('')

  const zero = states.filter((state) => state.zero)
  out.push('## Zero-injection requests')
  out.push('')
  out.push(`Count: **${zero.length}** of ${states.length} requests.`)
  out.push('')
  if (zero.length > 0) {
    out.push('| # | conv | msgs | Δmsgs | hint |')
    out.push('| --- | --- | --- | --- | --- |')
    for (const state of zero) {
      out.push(`| ${state.round} | ${shortestId(state.conversation)} | ${state.record.messages ?? 0} | ${state.newParts.length} | ${zeroHint(state)} |`)
    }
    out.push('')
    out.push('Attribution is limited to what the model request itself can prove. Unless a session log is reconciled separately (plan B.6), an unexplained row is a **data gap**, not "no memory was due".')
  } else {
    out.push('None.')
  }
  out.push('')

  const rebased = states.filter((state) => state.unreliable)
  if (rebased.length > 0) {
    out.push('## Rebased requests (delta unavailable)')
    out.push('')
    out.push(`Count: **${rebased.length}** (transcript was not a prefix of the previous request: compaction or rewrite).`)
    out.push('')
    out.push('| # | conv | msgs |')
    out.push('| --- | --- | --- |')
    for (const state of rebased) out.push(`| ${state.round} | ${shortestId(state.conversation)} | ${state.record.messages ?? 0} |`)
    out.push('')
  }

  out.push('## Notes')
  out.push('')
  out.push('- The log records request metadata only; it cannot name settings (`autoInject`, `dedupeTurns`, budgets). Record that snapshot beside the run (plan B.4).')
  out.push('- `requests containing (sum)` double-counts blocks that stayed in the transcript; use `Δ total` for per-turn injection counts.')
  out.push('- A separate model call (title generation, summarization) gets its own `conv` fingerprint; filter those rows before reading a conversation\'s injection rate.')
  out.push('- Do not commit captured logs or this report when they came from a real conversation.')
  out.push('')
  return out.join('\n')
}

function sumContextIds(parts) {
  return parts.reduce((sum, part) => sum + Number(part.context?.ids || 0), 0)
}

function zeroHint(state) {
  if (state.unreliable) return 'rebased: delta unreliable (data gap)'
  if (state.newParts.length === 0) return 'no new message (retry or intra-turn step)'
  if (!state.newParts.some((part) => part.role === 'system' || part.role === 'user')) return 'new messages carry no user/system text'
  const all = state.record.markers || {}
  const delta = state.delta || {}
  // These are hints read from the request itself, not causes: the mock cannot
  // see settings, dedupe state or the plugin activity log.
  if (!all.guide && !all.anchor) return 'no guide/anchor anywhere in the request: injection may be off, unbound, or compacted away (data gap)'
  if (all.context && !delta.context) return 'history has a recall block but no new one: possible no-match, dedupe, budget or tooShort (needs session log)'
  if (all.anchor && !delta.anchor && !delta.guide) return 'anchor already delivered and no new block: possible anchor-only step, no-match or budget (needs session log)'
  return 'data gap: no pinned marker in new messages'
}

function parseArgs(argv) {
  const options = {
    port: 8123,
    model: DEFAULT_MODEL,
    replyFile: null,
    log: null,
    report: null,
    help: false,
  }
  const take = (index, name) => {
    const value = argv[index]
    if (value === undefined || value.startsWith('--')) throw new Error(name + ' requires a value')
    return value
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    const eq = token.indexOf('=')
    const name = eq === -1 ? token : token.slice(0, eq)
    const inline = eq === -1 ? null : token.slice(eq + 1)
    switch (name) {
      case '-h':
      case '--help':
        options.help = true
        break
      case '--port': {
        const value = inline ?? take(++i, '--port')
        const port = Number(value)
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer 0..65535')
        options.port = port
        break
      }
      case '--model':
        options.model = inline ?? take(++i, '--model')
        break
      case '--reply-file':
        options.replyFile = inline ?? take(++i, '--reply-file')
        break
      case '--log':
        options.log = inline ?? take(++i, '--log')
        break
      case '--report':
        if (inline !== null) options.report = inline
        else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) options.report = argv[++i]
        else options.report = true
        break
      default:
        throw new Error('unknown option: ' + token)
    }
  }
  return options
}

async function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error('mock-llm: ' + error.message + '\n')
    console.error(USAGE)
    return 2
  }
  if (options.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (options.report !== null) {
    const reportPath = options.report === true ? options.log : options.report
    if (!reportPath) {
      console.error('mock-llm: --report needs a path (or pass --log with the same run)')
      return 2
    }
    let raw
    try {
      raw = fs.readFileSync(reportPath, 'utf8')
    } catch (error) {
      console.error('mock-llm: cannot read log ' + reportPath + ': ' + error.message)
      return 1
    }
    process.stdout.write(renderReport(raw, { logPath: path.resolve(reportPath) }))
    return 0
  }

  let reply = DEFAULT_REPLY
  if (options.replyFile) {
    try {
      reply = fs.readFileSync(options.replyFile, 'utf8')
    } catch (error) {
      console.error('mock-llm: cannot read --reply-file: ' + error.message)
      return 1
    }
  }

  let instance
  try {
    instance = await startMockLlm({ port: options.port, model: options.model, reply, log: options.log })
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      console.error(`mock-llm: port ${options.port} is already in use; pick another --port or use --port 0`)
      return 1
    }
    console.error('mock-llm: failed to listen: ' + (error?.message || error))
    return 1
  }
  console.log('mock-llm (EVALUATION ONLY) listening on ' + instance.url)
  console.log('  POST ' + instance.url + '/v1/chat/completions')
  console.log('  GET  ' + instance.url + '/v1/models')
  if (instance.log) console.log('  JSONL log: ' + instance.log)
  else console.log('  JSONL log: disabled (pass --log <path> to record)')
  console.log('  No message bodies are stored. Do not expose this port; it is loopback-only and unauthenticated.')

  await new Promise((resolve) => {
    const stop = () => resolve()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  await instance.close()
  return 0
}

const invokedDirectly = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    console.error('mock-llm: ' + (error?.stack || error))
    process.exitCode = 1
  })
}
