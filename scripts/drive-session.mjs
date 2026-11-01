#!/usr/bin/env node
/**
 * EVALUATION ONLY — drive one bound conversation through the public Session
 * remote for work order B. Never imported by runtime code.
 *
 * Public request shape (verified against the host source on 2026-11-01):
 *
 *   packages/api/session-controller/src/types.ts
 *     interface SessionPromptRequest {
 *       requestId: SessionRequestId
 *       sessionId: SessionId
 *       mode: 'queue' | 'steer'
 *       content: readonly PromptContentPart[]   // {type:'text', text}
 *       clientTimeZone?: string                 // 'UTC' or a valid IANA name
 *     }
 *
 *   packages/api/session-controller/src/index.ts
 *     @Remote('prompt') prompt(request, signal) -> { accepted: true }
 *
 * Transport rule
 * --------------
 * The generated client calls this unary method through the Connection RPC
 * carrier; its documented wire form is (docs/api-gateway.md):
 *
 *   POST <base>/api/session/prompt
 *   {
 *     "type": "client-request",
 *     "rpcId": "<connection correlation id>",
 *     "method": "session/prompt",
 *     "payload": { "args": { "request": <SessionPromptRequest> } }
 *   }
 *   ->
 *   { "type": "server-response", "rpcId": "<same>", "result": { "ok": true, "value": { "accepted": true } } }
 *
 * There is no stream-carrier form for this method: the API Gateway rejects a
 * unary method opened through /api/remote.mux with gateway/signature-invalid.
 *
 * Work order B forbids silently calling the shared /api route. Therefore this
 * script deliberately REFUSES to send anything unless --allow-api-route is
 * passed together with --base. Without that explicit opt-in it prints the exact
 * requests as a manual fallback and exits non-zero (code 3). This is not a
 * missing feature; it is the rule.
 *
 * Authentication assumption: the Host's /api route is behind its persistent
 * browser authentication (connection.admit() returns 401 without a valid
 * cookie). If the target Host enforces it, pass --cookie-file with the single
 * Cookie header value copied from the authenticated browser session. This
 * harness never prints or stores that value, and it sends no other credentials.
 * A non-loopback --base would additionally need the Host's trustedHosts setup;
 * the harness warns but does not bypass it.
 *
 * Completion is observed from the public persisted session log
 * (<DSH_HOME>/sessions/<project>/<sessionId>/session.v4.jsonl.zstd), the same
 * artifact docs/host-api.md §6.8 describes. No private endpoint and no plugin
 * RPC is called. A turn counts as done only when a turn/end for this prompt
 * reports reason.kind === 'completed'.
 *
 * Usage:
 *   node scripts/drive-session.mjs --session <id> --turns 50 \
 *     --base http://127.0.0.1:<host-gateway-port> --allow-api-route \
 *     --requests-out ./requests.jsonl
 *   node scripts/drive-session.mjs --session <id> --turns 5 --dry-run
 *
 * Exit codes:
 *   0  all requested turns completed
 *   1  a turn or the transport failed (the first failure stops the run)
 *   2  usage error
 *   3  manual fallback: nothing was sent (no approved transport)
 *   4  preflight failure: the session log needed to observe turn/end is absent
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_USAGE = 2
const EXIT_MANUAL = 3
const EXIT_PREFLIGHT = 4

const DEFAULT_TURNS = 50
const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_POLL_MS = 400

/**
 * Neutral prompts used only when neither --prompt nor --text-file is supplied.
 * They contain no user data and are cycled to reach --turns.
 */
const DEFAULT_PROMPTS = Object.freeze([
  '今天有点累，随便聊聊吧。',
  '你还记得我昨天提到的那件事吗？',
  '帮我把今天要做的事理一理。',
  '我们上次说到哪儿了？',
  '明天有什么安排吗？',
  '我想起一个很久以前的小事。',
  '给我讲讲你最近在忙什么。',
  '如果要去一个陌生的城市，你会先做什么？',
  '今天天气怎么样？凭记忆回答就好。',
  '晚安，明天见。',
])

const USAGE = `EVALUATION ONLY — drive one conversation through the public Session prompt remote.

Usage:
  node scripts/drive-session.mjs --session <id> [options] [--prompt <text> ...]

Required:
  --session <id>            Target SessionId (the conversation must already be
                            bound to the test library).

Transport:
  --base <url>              Host gateway base, e.g. http://127.0.0.1:3000
                            (the Host's own port, not the mock LLM port).
  --allow-api-route         Explicitly permit the documented public Connection RPC
                            carrier POST <base>/api/session/prompt. Without this
                            flag and --base, nothing is sent: the script prints a
                            manual fallback and exits 3 (work order B rule).
  --cookie-file <p>         File holding one Cookie header value for /api. The
                            Host browser-authenticates /api, so a real Host
                            usually returns 401 without it. The value is never
                            printed or stored by this script.

Turns:
  --turns <n>               Number of prompts. Default: ${DEFAULT_TURNS}.
  --prompt <text>           One prompt; repeatable. Positional text after options
                            is also accepted as prompts.
  --text-file <p>           .json array of strings / {text|prompt|content} objects,
                            or one prompt per non-empty line. Optional: without it
                            the built-in neutral prompts are cycled.
  --interval-ms <n>         Wait between completed turns. Default: 0.
  --timeout-ms <n>          Per-turn send + completion budget. Default: ${DEFAULT_TIMEOUT_MS}.
  --poll-ms <n>             Session-log poll interval. Default: ${DEFAULT_POLL_MS}.
  --client-time-zone <iana> IANA name sent as clientTimeZone. Default: system zone.

Observation:
  --session-log <p>         Exact session log path (skips discovery).
  --dsh-home <p>            DSH home used for discovery. Default: $DSH_HOME or ~/.dsh.

Output:
  --requests-out <p>        Write the exact request objects as JSONL before sending.
                            This file contains the prompt text; delete it after use
                            and do not commit it.
  --dry-run                 Print the requests and exit 0 without sending.
  -h, --help                Show this text.

Public request sent for every turn:
  sessionController.prompt({
    requestId: '<unique per turn>',
    sessionId: '<--session>',
    mode: 'queue',
    content: [{ type: 'text', text: '<prompt>' }],
    clientTimeZone: '<IANA>'
  })

The run stops on the first failure. A timeout or a non-completed turn/end is a
failure and is not counted as a valid turn. No /api call is made without
--allow-api-route.
`

function failUsage(message) {
  console.error('drive-session: ' + message + '\n')
  console.error(USAGE)
  return EXIT_USAGE
}

function parseArgs(argv) {
  const options = {
    base: null,
    session: null,
    turns: DEFAULT_TURNS,
    intervalMs: 0,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollMs: DEFAULT_POLL_MS,
    textFile: null,
    prompts: [],
    clientTimeZone: null,
    sessionLog: null,
    dshHome: null,
    requestsOut: null,
    cookieFile: null,
    allowApiRoute: false,
    dryRun: false,
    help: false,
  }
  const take = (index, name) => {
    const value = argv[index]
    if (value === undefined || value.startsWith('--')) throw new Error(name + ' requires a value')
    return value
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '-h') {
      options.help = true
      continue
    }
    if (!token.startsWith('--')) {
      options.prompts.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const name = eq === -1 ? token : token.slice(0, eq)
    const inline = eq === -1 ? null : token.slice(eq + 1)
    switch (name) {
      case '--help':
        options.help = true
        break
      case '--base':
        options.base = inline ?? take(++i, '--base')
        break
      case '--session':
        options.session = inline ?? take(++i, '--session')
        break
      case '--turns':
        options.turns = positiveInt(inline ?? take(++i, '--turns'), '--turns')
        break
      case '--interval-ms':
        options.intervalMs = nonNegativeInt(inline ?? take(++i, '--interval-ms'), '--interval-ms')
        break
      case '--timeout-ms':
        options.timeoutMs = positiveInt(inline ?? take(++i, '--timeout-ms'), '--timeout-ms')
        break
      case '--poll-ms':
        options.pollMs = positiveInt(inline ?? take(++i, '--poll-ms'), '--poll-ms')
        break
      case '--text-file':
        options.textFile = inline ?? take(++i, '--text-file')
        break
      case '--prompt':
        options.prompts.push(inline ?? take(++i, '--prompt'))
        break
      case '--client-time-zone':
        options.clientTimeZone = inline ?? take(++i, '--client-time-zone')
        break
      case '--session-log':
        options.sessionLog = inline ?? take(++i, '--session-log')
        break
      case '--dsh-home':
        options.dshHome = inline ?? take(++i, '--dsh-home')
        break
      case '--requests-out':
        options.requestsOut = inline ?? take(++i, '--requests-out')
        break
      case '--cookie-file':
        options.cookieFile = inline ?? take(++i, '--cookie-file')
        break
      case '--allow-api-route':
        if (inline !== null) throw new Error('--allow-api-route does not take a value')
        options.allowApiRoute = true
        break
      case '--dry-run':
        if (inline !== null) throw new Error('--dry-run does not take a value')
        options.dryRun = true
        break
      default:
        throw new Error('unknown option: ' + token)
    }
  }
  return options
}

function positiveInt(value, name) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(name + ' must be a positive integer')
  return number
}

function nonNegativeInt(value, name) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(name + ' must be a non-negative integer')
  return number
}

function defaultClientTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone ? zone : 'UTC'
  } catch {
    return 'UTC'
  }
}

function readTextFilePrompts(file) {
  const raw = fs.readFileSync(file, 'utf8')
  if (path.extname(file).toLowerCase() === '.json') {
    let value
    try { value = JSON.parse(raw) } catch (error) { throw new Error('--text-file is not valid JSON: ' + error.message) }
    if (!Array.isArray(value)) throw new Error('--text-file JSON must be an array')
    const prompts = value.map((item, index) => textOfPromptItem(item, index)).filter(Boolean)
    if (prompts.length === 0) throw new Error('--text-file JSON array contains no prompts')
    return prompts
  }
  const prompts = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  if (prompts.length === 0) throw new Error('--text-file contains no non-empty lines')
  return prompts
}

function textOfPromptItem(item, index) {
  if (typeof item === 'string') return item.trim()
  if (!item || typeof item !== 'object') throw new Error('--text-file item ' + (index + 1) + ' is not a string or object')
  const candidate = item.text ?? item.prompt ?? item.content
  if (typeof candidate === 'string') return candidate.trim()
  if (Array.isArray(candidate)) {
    const text = candidate
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim()
    if (text) return text
  }
  throw new Error('--text-file item ' + (index + 1) + ' has no text/prompt/content string')
}

function resolvePrompts(options) {
  const prompts = [...options.prompts]
  if (options.textFile) prompts.push(...readTextFilePrompts(options.textFile))
  const list = prompts.length > 0 ? prompts.map((text) => String(text).trim()).filter(Boolean) : [...DEFAULT_PROMPTS]
  if (list.length === 0) throw new Error('no prompts resolved')
  return list
}

function buildRequests({ sessionId, turns, prompts, clientTimeZone }) {
  const runId = 'memu-eval-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
    + '-' + crypto.randomBytes(2).toString('hex')
  const requests = []
  for (let turn = 1; turn <= turns; turn += 1) {
    const text = prompts[(turn - 1) % prompts.length]
    // One identity, generated once: the log matcher and the wire request must
    // agree, and a retried request must not reuse it.
    const requestId = runId + '-' + String(turn).padStart(3, '0') + '-' + crypto.randomBytes(2).toString('hex')
    requests.push({
      turn,
      requestId,
      request: {
        requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone,
      },
    })
  }
  return requests
}

function writeRequests(file, requests) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  const body = requests.map((item) => JSON.stringify({ turn: item.turn, requestId: item.requestId, request: item.request })).join('\n') + '\n'
  fs.writeFileSync(file, body, 'utf8')
}

function printManualFallback({ reason, requests, requestsOut }) {
  const sample = requests[0]?.request
  console.error('MANUAL FALLBACK — nothing was sent.')
  console.error('')
  console.error('Reason: ' + reason)
  console.error('')
  console.error('This harness only calls the public remote below, and it will not touch the')
  console.error('shared /api route on its own:')
  console.error('')
  console.error('  sessionController.prompt({')
  console.error('    requestId, sessionId, mode: \'queue\',')
  console.error('    content: [{ type: \'text\', text }], clientTimeZone')
  console.error('  })')
  console.error('')
  console.error('Deliver each request with an approved client that can call that remote, then')
  console.error('read the mock-llm JSONL log with:')
  console.error('')
  console.error('  node scripts/mock-llm.mjs --report <mock-llm.jsonl> > mock-llm-report-YYYY-MM-DD.md')
  console.error('')
  console.error('If you explicitly accept the documented public Connection RPC carrier, re-run with:')
  console.error('')
  console.error('  --base <host gateway> --allow-api-route')
  console.error('')
  console.error('That carrier is POST <base>/api/session/prompt with a client-request envelope;')
  console.error('it is the same public remote the official browser client uses, not a private')
  console.error('endpoint. Without the opt-in flag this driver refuses to POST /api.')
  console.error('The Host browser-authenticates /api: add --cookie-file <path> (one Cookie')
  console.error('header value) if the carrier answers 401/403.')
  if (requestsOut) console.error('')
  if (requestsOut) console.error('All ' + requests.length + ' request objects were written to ' + path.resolve(requestsOut) + '.')
  else if (requests.length > 5) console.error('Rerun with --requests-out <path> to write all ' + requests.length + ' request objects as JSONL.')
  console.error('')
  if (!requestsOut && requests.length <= 5) {
    for (const item of requests) {
      console.error('turn ' + item.turn + ':')
      console.error(JSON.stringify(item.request, null, 2))
    }
  } else {
    console.error('First request (' + requests.length + ' total):')
    console.error(JSON.stringify(sample, null, 2))
  }
}

/**
 * Encode one Session id as the persistence layer does (host format.ts
 * encodeSegment). Kept local so the harness imports no host or plugin code.
 */
function encodeSegment(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const ch = String.fromCharCode(raw.charCodeAt(i))
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

const LOG_SUFFIXES = ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl.zstd', 'session.jsonl']

function locateSessionLog({ explicit, dshHome, sessionId }) {
  if (explicit) {
    const resolved = path.resolve(explicit)
    return fs.existsSync(resolved) ? resolved : null
  }
  const root = path.join(dshHome, 'sessions')
  let projects
  try { projects = fs.readdirSync(root, { withFileTypes: true }) } catch { return null }
  const encoded = encodeSegment(sessionId)
  for (const project of projects) {
    if (!project.isDirectory()) continue
    for (const dirName of [sessionId, encoded]) {
      const dir = path.join(root, project.name, dirName)
      for (const suffix of LOG_SUFFIXES) {
        const candidate = path.join(dir, suffix)
        if (fs.existsSync(candidate)) return candidate
      }
    }
  }
  return null
}

const ZSTD_MAGIC = 0xFD2FB528

/**
 * Locate complete Zstandard frames in a concatenated log.
 *
 * Mirrors the structural scan in the host's session-persistence-jsonl package
 * (src/zstd.ts) because Node's one-shot decompressor stops after the first
 * frame and this harness must not import host packages. The final frame may be
 * torn while the host is writing; it is left for the next poll.
 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('corrupt session log: bad zstd magic at byte ' + offset)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error('corrupt session log: reserved frame-header bit')
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error('corrupt session log: reserved block type')
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

function readSessionEvents(file) {
  const raw = fs.readFileSync(file)
  let text
  if (file.endsWith('.zstd')) {
    const { frames } = scanZstdFrames(raw)
    const parts = []
    for (const frame of frames) {
      try {
        parts.push(zlib.zstdDecompressSync(raw.subarray(frame.start, frame.end)))
      } catch (error) {
        throw new Error('cannot decompress session log frame at byte ' + frame.start + ': ' + error.message)
      }
    }
    text = Buffer.concat(parts).toString('utf8')
  } else {
    text = raw.toString('utf8')
  }
  const events = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object') events.push(value)
    } catch {
      // The host appends complete JSON lines; a torn line is retried next poll.
    }
  }
  return events
}

/**
 * Index of the durable user/message that claims this requestId.
 *
 * The inbox `agent/inbox/spliced` event proves admission but not that a turn
 * consumed the prompt, so it is deliberately not used as the anchor. A
 * `user/message` appears inside the turn that actually claims the prompt, which
 * is what lets the wait below pair it with the right turn/end.
 */
function promptClaimIndex(events, requestId) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'user/message' && event?.data?.source?.rpcId === requestId) return i
  }
  return -1
}

/** Whether the host durably admitted this requestId (before a turn claims it). */
function promptAdmitted(events, requestId) {
  return events.some((event) => event?.type === 'agent/inbox/spliced'
    && Array.isArray(event?.data?.inserted)
    && event.data.inserted.some((item) => item?.source?.rpcId === requestId))
}

/** Turn number of the `turn/start` that encloses one claimed user message. */
function enclosingTurn(events, claimIndex) {
  for (let i = claimIndex - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'turn/start') {
      const turn = Number(event?.data?.turn)
      return Number.isSafeInteger(turn) ? turn : null
    }
    if (event?.type === 'turn/end') return null
  }
  return null
}

/**
 * Read the public session log until the prompt's own turn/end appears.
 *
 * A queued prompt may be claimed in the middle of an existing long turn, so the
 * enclosing turn is read from the log instead of assuming a fresh turn starts.
 * Only `reason.kind === 'completed'` counts as success.
 *
 * @returns {{state:'completed'|'failed'|'timeout', reason:string, waitedMs:number}}
 */
async function waitForTurn({ logPath, requestId, timeoutMs, pollMs }) {
  const started = Date.now()
  const deadline = started + timeoutMs
  let admitted = false
  let lastReadError = null
  while (Date.now() < deadline) {
    try {
      const events = readSessionEvents(logPath)
      if (!admitted && promptAdmitted(events, requestId)) admitted = true
      const claim = promptClaimIndex(events, requestId)
      if (claim >= 0) {
        const turn = enclosingTurn(events, claim)
        for (let i = claim + 1; i < events.length; i += 1) {
          const event = events[i]
          if (event?.type !== 'turn/end') continue
          const endedTurn = Number(event?.data?.turn)
          if (turn !== null && Number.isSafeInteger(endedTurn) && endedTurn !== turn) {
            return {
              state: 'failed',
              reason: 'turn/end turn=' + endedTurn + ' does not match the claiming turn=' + turn,
              waitedMs: Date.now() - started,
            }
          }
          const reason = event?.data?.reason?.kind
          if (reason === 'completed') {
            return { state: 'completed', reason: 'completed', waitedMs: Date.now() - started }
          }
          return {
            state: 'failed',
            reason: 'turn/end reason=' + String(reason || 'unknown'),
            waitedMs: Date.now() - started,
          }
        }
      }
      lastReadError = null
    } catch (error) {
      lastReadError = error?.message || String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))))
  }
  if (lastReadError) {
    return { state: 'timeout', reason: 'cannot read session log: ' + lastReadError, waitedMs: timeoutMs }
  }
  return {
    state: 'timeout',
    reason: admitted ? 'prompt was admitted but no turn claimed it before the deadline' : 'prompt not observed in the session log',
    waitedMs: timeoutMs,
  }
}

function joinUrl(base, suffix) {
  return String(base).replace(/\/+$/, '') + suffix
}

/**
 * The Connection RPC carrier wraps each Remote method parameter by **name**, so a
 * single-argument remote must go out as `{ args: { request: <SessionPromptRequest> } }`.
 * Sending the request fields directly is rejected before the host ever sees them
 * (`gateway/arguments-invalid: missing "request"`) — which is what this file did until it
 * actually met a real host.
 */
export function buildPromptEnvelope(request, rpcId = crypto.randomUUID()) {
  return {
    type: 'client-request',
    rpcId,
    method: 'session/prompt',
    payload: { args: { request } },
  }
}

async function sendPrompt({ base, request, timeoutMs, cookie }) {
  const url = joinUrl(base, '/api/session/prompt')
  const envelope = buildPromptEnvelope(request)
  const headers = { 'content-type': 'application/json' }
  if (cookie) headers.cookie = cookie
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(Math.min(timeoutMs, 2_147_483_647)),
    })
  } catch (error) {
    throw new Error('transport failure for ' + url + ': ' + (error?.message || error))
  }
  const text = await response.text()
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403
      ? ' (the Host authenticates /api; pass --cookie-file with the browser session cookie)'
      : ''
    throw new Error('HTTP ' + response.status + ' from ' + url + hint + ': ' + text.slice(0, 240))
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error('response is not JSON (expected a Connection RPC envelope)')
  }
  if (!body || body.type !== 'server-response' || body.rpcId !== envelope.rpcId) {
    throw new Error('response is not the matching Connection RPC envelope')
  }
  if (!body.result || body.result.ok !== true) {
    const failure = body.result?.error || {}
    throw new Error('session/prompt rejected: ' + String(failure.code || 'unknown') + ': ' + String(failure.message || 'no message'))
  }
  if (body.result.value?.accepted !== true) {
    throw new Error('session/prompt did not return { accepted: true }')
  }
  return { rpcId: envelope.rpcId }
}

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}

async function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    return failUsage(error.message)
  }
  if (options.help) {
    process.stdout.write(USAGE)
    return EXIT_OK
  }
  if (!options.session || !String(options.session).trim()) {
    return failUsage('--session is required')
  }
  if (options.base) {
    let parsed
    try { parsed = new URL(options.base) } catch { return failUsage('--base is not a valid URL') }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return failUsage('--base must be http(s)')
    if (!isLoopbackHost(parsed.hostname)) {
      console.error('drive-session: warning: --base is not loopback (' + parsed.hostname + '); the harness sends no credentials, so an authenticated host will reject it')
    }
  }

  const clientTimeZone = options.clientTimeZone || defaultClientTimeZone()
  let prompts
  try {
    prompts = resolvePrompts(options)
  } catch (error) {
    return failUsage(error.message)
  }
  const requests = buildRequests({
    sessionId: String(options.session).trim(),
    turns: options.turns,
    prompts,
    clientTimeZone,
  })

  let cookie = null
  if (options.cookieFile) {
    try {
      cookie = fs.readFileSync(options.cookieFile, 'utf8').trim()
    } catch (error) {
      return failUsage('cannot read --cookie-file: ' + error.message)
    }
    if (!cookie || /[\r\n]/.test(cookie)) {
      return failUsage('--cookie-file must contain exactly one Cookie header value (no line breaks)')
    }
  }

  if (options.requestsOut) {
    try { writeRequests(options.requestsOut, requests) } catch (error) {
      console.error('drive-session: cannot write --requests-out: ' + error.message)
      return EXIT_FAILED
    }
  }

  if (options.dryRun) {
    for (const item of requests) {
      process.stdout.write(JSON.stringify({ turn: item.turn, request: item.request }) + '\n')
    }
    console.log('drive-session: dry run — ' + requests.length + ' request(s) generated, nothing sent')
    return EXIT_OK
  }

  if (!options.allowApiRoute) {
    printManualFallback({
      reason: 'no approved public-remote carrier. Work order B forbids silently POSTing /api.',
      requests,
      requestsOut: options.requestsOut,
    })
    return EXIT_MANUAL
  }
  if (!options.base) {
    printManualFallback({
      reason: '--allow-api-route needs --base <host gateway>; there is nowhere to send the public remote.',
      requests,
      requestsOut: options.requestsOut,
    })
    return EXIT_MANUAL
  }

  const dshHome = options.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const sessionLog = locateSessionLog({
    explicit: options.sessionLog,
    dshHome,
    sessionId: String(options.session).trim(),
  })
  if (!sessionLog) {
    console.error('drive-session: preflight failed — no session log for ' + options.session)
    console.error('  looked under: ' + path.join(dshHome, 'sessions'))
    console.error('  Pass --session-log <path> with the exact session.v4.jsonl.zstd file,')
    console.error('  or --dsh-home <path> if DSH_HOME is not ' + dshHome + '.')
    console.error('  Nothing was sent: without the public session log a turn cannot be observed as completed.')
    return EXIT_PREFLIGHT
  }
  try {
    readSessionEvents(sessionLog)
  } catch (error) {
    console.error('drive-session: preflight failed — cannot read ' + sessionLog + ': ' + error.message)
    console.error('  Nothing was sent.')
    return EXIT_PREFLIGHT
  }

  console.log('drive-session: ' + requests.length + ' turn(s) → session ' + options.session)
  console.log('  base: ' + joinUrl(options.base, '/api/session/prompt') + ' (explicit --allow-api-route)')
  console.log('  session log: ' + sessionLog)
  console.log('  clientTimeZone: ' + clientTimeZone)
  console.log('  cookie: ' + (cookie ? 'supplied via --cookie-file (not printed)' : 'none (a Host with browser auth will answer 401)'))
  if (options.requestsOut) console.log('  requests: ' + path.resolve(options.requestsOut))

  const started = Date.now()
  let completed = 0
  let failed = 0
  let lastFailure = null
  for (const item of requests) {
    const turnStarted = Date.now()
    try {
      await sendPrompt({ base: options.base, request: item.request, timeoutMs: options.timeoutMs, cookie })
    } catch (error) {
      failed += 1
      lastFailure = { turn: item.turn, stage: 'send', reason: error.message }
      console.error('turn ' + item.turn + '/' + requests.length + ' SEND FAILED: ' + error.message)
      break
    }
    // One per-turn budget: admission time is charged against completion time.
    const remaining = Math.max(1_000, options.timeoutMs - (Date.now() - turnStarted))
    const waited = await waitForTurn({
      logPath: sessionLog,
      requestId: item.request.requestId,
      timeoutMs: remaining,
      pollMs: options.pollMs,
    })
    if (waited.state !== 'completed') {
      failed += 1
      lastFailure = { turn: item.turn, stage: 'wait', reason: waited.state + ': ' + waited.reason }
      console.error('turn ' + item.turn + '/' + requests.length + ' WAIT FAILED: ' + waited.state + ' (' + waited.reason + ')')
      break
    }
    completed += 1
    const elapsed = Date.now() - turnStarted
    console.log('turn ' + item.turn + '/' + requests.length + ' completed in ' + elapsed + 'ms (requestId ' + item.request.requestId + ')')
    if (options.intervalMs > 0 && item.turn < requests.length) {
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs))
    }
  }

  const totalMs = Date.now() - started
  console.log('')
  console.log('summary: sent+completed=' + completed + ' failed=' + failed + ' requested=' + requests.length + ' elapsed=' + totalMs + 'ms')
  if (lastFailure) {
    console.log('first failure: turn ' + lastFailure.turn + ' (' + lastFailure.stage + ') ' + lastFailure.reason)
    return EXIT_FAILED
  }
  if (completed !== requests.length) {
    console.log('run stopped before every requested turn completed')
    return EXIT_FAILED
  }
  console.log('all requested turns completed')
  return EXIT_OK
}

const invokedDirectly = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false
if (invokedDirectly) {
  main().then((code) => { process.exitCode = typeof code === 'number' ? code : EXIT_FAILED }).catch((error) => {
    console.error('drive-session: ' + (error?.stack || error))
    process.exitCode = EXIT_FAILED
  })
}

export {
  DEFAULT_PROMPTS,
  buildRequests,
  encodeSegment,
  enclosingTurn,
  locateSessionLog,
  parseArgs,
  promptAdmitted,
  promptClaimIndex,
  readSessionEvents,
  scanZstdFrames,
  sendPrompt,
  textOfPromptItem,
  waitForTurn,
}
