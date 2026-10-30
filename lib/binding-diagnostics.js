// Read-only binding lifecycle diagnostics (W9).
//
// A conversation's memory state lives in three layers, and only the first is on disk:
//   1. persistent binding - state.json sessions[sessionId]; survives restarts, forks and
//      a plugin reload.
//   2. runtime listeners  - preset-scope attachments keyed by an *agent context object*;
//      they exist only inside the running plugin process and die with that context.
//   3. temporary maps     - inbound per-session maps, in-flight guards, caches; cleared
//      by session/disposed, turn/end or a successful pass.
//
// This module reads layer 1 through a snapshot it never writes or repairs, names layers
// 2 and 3 as unobservable from another process instead of guessing, and refuses every
// action that would delete, unbind or create anything. A candidate is a prompt to look,
// never a deletion queue. See docs/binding-lifecycle.md.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from './paths.js'

export const SCHEMA = 'dsh-memu-memory/binding-diagnostics@1'
// Only an inspection threshold. It never becomes an age at which something is dropped.
export const INSPECTION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const SCOPE_KEYS = ['channelId', 'characterId', 'worldId', 'branchId']

// Every report repeats what it refuses to do, so a count of candidates can never be
// mistaken for a plan to delete them.
export const REFUSALS = Object.freeze([
  'delete-session', 'delete-binding', 'unbind-session', 'delete-library',
  'delete-memory', 'create-library', 'write-state', 'rename-state',
  'gc', 'mark-injected', 'flush',
])

// Inspection buckets. None of them is an action.
export const CANDIDATE_KINDS = Object.freeze({
  SESSION_GONE: 'session-gone',
  HOST_MISSING: 'host-session-missing',
  LIBRARY_MISSING: 'library-missing',
  LIBRARY_ARCHIVED: 'library-archived',
  UNBOUND_ENABLED: 'library-enabled-but-unbound',
  PENDING_INBOUND: 'pending-inbound',
  SLEEP_RETRY: 'sleep-retry',
  FAILED_RECALL: 'recall-degraded',
  REINJECT_PENDING: 'reinject-pending',
  IDLE_INSPECTION: 'idle-inspection',
})

// Runtime layers a second process cannot read. Naming them keeps "zero candidates" from
// meaning "nothing to see": these are precisely the states an in-process bug would leak.
export const RUNTIME_STATE = Object.freeze([
  { layer: 'runtime-listener', file: 'lib/preset-scope.js:19', name: 'attachments', keyedBy: 'agent context object', clearedBy: 'the next attach pass when the context disappears; registerPresetAttachment disposer on unload' },
  { layer: 'temporary-map', file: 'lib/inbound.js:12', name: 'mediaJobs', keyedBy: 'sessionId', clearedBy: 'settled capture promise' },
  { layer: 'temporary-map', file: 'lib/inbound.js:13', name: 'calls', keyedBy: 'sessionId', clearedBy: 'tool/result or turn/end' },
  { layer: 'temporary-map', file: 'lib/inbound.js:14', name: 'sessions', keyedBy: 'sessionId', clearedBy: 'session/disposed (releaseInboundSession)' },
  { layer: 'temporary-map', file: 'lib/media.js:19', name: 'captures', keyedBy: 'sessionId', clearedBy: 'capture settle' },
  { layer: 'temporary-map', file: 'lib/private.js:347', name: 'inFlight', keyedBy: 'sessionId', clearedBy: 'consolidation settle' },
  { layer: 'temporary-map', file: 'lib/curator.js:13', name: 'jobs', keyedBy: 'job id', clearedBy: 'curation settle' },
  { layer: 'cache', file: 'lib/state.js:967', name: 'indexCache', keyedBy: 'libraryId', clearedBy: 'next load / external write' },
  { layer: 'cache', file: 'lib/paths.js:52', name: 'readFailures', keyedBy: 'absolute file', clearedBy: 'a later successful read' },
])

const UNKNOWN = Object.freeze({
  HOST_UNAVAILABLE: 'host-unavailable',
  HOST_NOT_LOADED: 'host-not-loaded',
  HOST_PARTIAL: 'host-partial',
  HOST_SOURCE_UNTRUSTED: 'host-source-untrusted',
  HOST_LIST_EMPTY: 'host-list-empty',
  HOST_DUPLICATE_IDS: 'host-duplicate-session-ids',
  RUNTIME_NOT_INSPECTABLE: 'runtime-layers-not-inspectable',
  STATE_MISSING: 'state-missing',
  STATE_CORRUPT: 'state-corrupt',
  STATE_UNREADABLE: 'state-unreadable',
  IDLE_BASIS_MISSING: 'idle-basis-missing',
  BINDINGS_NOT_OBJECT: 'bindings-not-an-object',
  UNBOUND_BASIS_UNKNOWN: 'unbound-basis-unknown',
})
export const UNKNOWN_CODES = Object.freeze(UNKNOWN)

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function timeOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : null
}

function isoAt(value) {
  const at = timeOf(value)
  return at === null ? null : new Date(at).toISOString()
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12)
}

function clip(value, max = 160) {
  const text = String(value === undefined || value === null ? '' : value)
  return text.length > max ? text.slice(0, max) + '...' : text
}

// "The switch is on but there is no library" is NOT by itself a fault. lib/inject.js runs
// ensureSession(..., { createLibrary: false }) on every turn, and lib/state.js only adopts a
// library the folder already has; a conversation in a folder without one therefore lives with
// useLibrary: true and libraryId: null for its whole life. That is the documented
// deferred-creation shape, not a lost pointer. The only snapshot evidence that a pointer once
// existed is a completed injection pass: markInjected() runs only after recall, and recall
// needs somewhere to recall from. Without that evidence the report says so as an unknown
// instead of filing a candidate — a candidate count is a to-do list, and inflating it is how a
// diagnostic stops being read.
export function unboundEvidence(facts) {
  const priorInjection = Boolean(facts && facts.injection && (facts.injection.injected > 0 || facts.injection.lastTurn > 0))
  return {
    priorInjection,
    basis: priorInjection
      ? 'a completed injection pass is recorded, so this conversation had a library and the pointer is gone now'
      : 'no injection has completed, so this is indistinguishable from a deliberately deferred library creation (createLibrary: false)',
  }
}

export function defaultStateFile() {
  // Mirrors lib/state.js STATE_FILE without loading that module: loadState() rewrites a
  // missing file and quarantines a corrupt one, and a diagnostic must do neither.
  return path.join(dataDir(), 'state.json')
}

/**
 * Read state.json once, byte for byte, with no interpretation beyond JSON.parse.
 *
 * Deliberately not readJson()/loadState(): those repair the file they read (quarantine a
 * corrupt one, recreate a missing one), which is exactly what a read-only report must
 * not do. The sha256 and mtime are returned so a caller can prove the file did not move.
 */
export function readBindingSnapshot({ stateFile = defaultStateFile() } = {}) {
  const file = stateFile
  let buffer
  try {
    buffer = fs.readFileSync(file)
  } catch (error) {
    const missing = error && error.code === 'ENOENT'
    return {
      ok: false, kind: missing ? 'missing' : 'unreadable', missing, file,
      bytes: null, mtimeMs: null, sha256: null,
      error: String((error && (error.code || error.message)) || error),
    }
  }
  let stat = null
  try { stat = fs.statSync(file) } catch {}
  const base = {
    file,
    bytes: buffer.length,
    mtimeMs: stat ? stat.mtimeMs : null,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  }
  try {
    return { ok: true, kind: 'ok', missing: false, value: JSON.parse(buffer.toString('utf8')), ...base }
  } catch (error) {
    return { ok: false, kind: 'corrupt', missing: false, error: 'invalid JSON', detail: clip(error && error.message, 200), ...base }
  }
}

/**
 * The facts a binding carries, without any memory text, folder path or session title.
 * Paths and titles are user data; they appear as hashes or not at all.
 */
export function bindingFacts(sessionId, binding, { libraries = {}, policies = {}, now = Date.now(), includeDetails = false } = {}) {
  const b = isObject(binding) ? binding : {}
  const scopeKey = typeof b.scopeKey === 'string' ? b.scopeKey : null
  const folder = { useLibrary: true, useGlobal: true, ...(scopeKey && isObject(policies[scopeKey]) ? policies[scopeKey] : {}) }
  const wantsLibrary = b.useLibrary !== false
  const wantsGlobal = b.useGlobal !== false
  const useLibrary = folder.useLibrary !== false && wantsLibrary
  const useGlobal = folder.useGlobal !== false && wantsGlobal
  const libraryId = typeof b.libraryId === 'string' && b.libraryId ? b.libraryId : null
  const library = libraryId && isObject(libraries[libraryId]) ? libraries[libraryId] : null
  const inbound = isObject(b.inbound) ? b.inbound : {}
  const pending = Array.isArray(inbound.pending) ? inbound.pending : []
  const retryAt = timeOf(inbound.retryAt)
  let pendingBytes = null
  try { pendingBytes = Buffer.byteLength(JSON.stringify(pending)) } catch {}
  const context = isObject(b.memoryContext) ? b.memoryContext : null
  const lastTurnAt = timeOf(b.lastTurnAt)
  const lastInboundAt = timeOf(b.lastInboundAt)
  const lastAgentIdleAt = timeOf(b.lastAgentIdleAt)
  const lastActivityAt = Math.max(lastTurnAt || 0, lastInboundAt || 0, lastAgentIdleAt || 0) || null
  const idleMs = lastActivityAt ? Math.max(0, now - lastActivityAt) : null
  const sleepRetryAt = timeOf(b.sleepRetryAt)
  const cueAt = timeOf(b.activeCue && b.activeCue.createdAt)
  const injectedIds = Array.isArray(b.injectedIds) ? b.injectedIds : []
  return {
    sessionId,
    switches: { useLibrary: wantsLibrary, useGlobal: wantsGlobal },
    effective: { useLibrary, useGlobal, enabled: useLibrary || useGlobal },
    folder: {
      scopeKeyHash: scopeKey ? hash(scopeKey) : null,
      blocksLibrary: folder.useLibrary === false,
      blocksGlobal: folder.useGlobal === false,
    },
    domain: {
      detected: typeof b.domain === 'string' ? b.domain : null,
      override: typeof b.domainOverride === 'string' ? b.domainOverride : null,
    },
    library: {
      id: libraryId,
      exists: Boolean(library),
      archived: Boolean(library && library.archived === true),
      sameScope: Boolean(library && scopeKey && library.scopeKey === scopeKey),
    },
    memoryContext: {
      present: Boolean(context),
      scopeKeys: context ? SCOPE_KEYS.filter(key => typeof context[key] === 'string' && context[key]) : [],
    },
    guide: {
      sent: Boolean(b.guideMessageAt),
      sentAt: isoAt(b.guideMessageAt),
      rulesKey: typeof b.guideRulesKey === 'string' ? b.guideRulesKey : null,
      lost: b.guideLost === true,
    },
    inbound: {
      pending: pending.length,
      pendingBytes,
      retrying: Boolean(retryAt && retryAt > now),
      retryAt: isoAt(retryAt),
      seen: Array.isArray(inbound.seen) ? inbound.seen.length : 0,
      claimed: Array.isArray(inbound.claimed) ? inbound.claimed.length : 0,
      clock: numberOrNull(inbound.clock),
      hasError: typeof b.lastInboundError === 'string' && b.lastInboundError.length > 0,
    },
    sleep: {
      lastSleepAt: isoAt(b.lastSleepAt),
      retryAt: isoAt(sleepRetryAt),
      retryDue: Boolean(sleepRetryAt && sleepRetryAt <= now),
      attempts: numberOrNull(b.sleepAttempts) || 0,
      hasError: typeof b.lastSleepError === 'string' && b.lastSleepError.length > 0,
      sessionGone: b.sessionGone === true,
      sessionGoneAt: isoAt(b.sessionGoneAt),
    },
    recall: {
      degraded: typeof b.lastRecallError === 'string' && b.lastRecallError.length > 0,
      errorLength: typeof b.lastRecallError === 'string' ? b.lastRecallError.length : 0,
    },
    injection: {
      injected: injectedIds.length,
      lastTurn: numberOrNull(b.lastInjectedTurn),
      reinjectPending: b.reinjectPending === true,
      cueLive: Boolean(cueAt && now - cueAt <= 30 * 60 * 1000),
    },
    activity: {
      lastTurnAt: isoAt(lastTurnAt),
      lastInboundAt: isoAt(lastInboundAt),
      lastAgentIdleAt: isoAt(lastAgentIdleAt),
      lastActivityAt: isoAt(lastActivityAt),
      // Exact milliseconds decide the threshold; idleDays is rounded for display only.
      idleMs,
      idleDays: idleMs === null ? null : Math.round(idleMs / DAY_MS * 10) / 10,
    },
    ...(includeDetails ? {
      detail: {
        inboundError: clip(b.lastInboundError),
        sleepError: clip(b.lastSleepError),
      },
    } : {}),
  }
}

/**
 * Host authority. Only a full session registry may say "this session does not exist".
 * The agents list is a live-agent view: it proves presence, never absence, so it is
 * downgraded to partial even when the caller labels it ok.
 */
export function normalizeHost(host) {
  if (!isObject(host) || !Array.isArray(host.sessions)) {
    return {
      status: 'unavailable', source: 'unknown', complete: false, sessions: [], total: 0, duplicates: 0,
      reason: isObject(host) ? 'host supplied no session array' : 'no host session list was supplied',
    }
  }
  const source = host.source === 'session-registry' || host.source === 'agents' ? host.source : 'unknown'
  const notes = []
  let status = ['ok', 'partial', 'unavailable', 'not-loaded'].includes(host.status) ? host.status : 'unknown'
  const byId = new Map()
  let duplicates = 0
  for (const raw of host.sessions) {
    const record = isObject(raw) ? raw : null
    if (!record || typeof record.id !== 'string' || !record.id) continue
    if (byId.has(record.id)) { duplicates += 1; continue }
    byId.set(record.id, {
      id: record.id,
      title: typeof record.title === 'string' && record.title.trim() ? record.title.trim() : null,
      agentPreset: typeof record.agentPreset === 'string' ? record.agentPreset : null,
    })
  }
  if (source === 'agents' && status === 'ok') {
    status = 'partial'
    notes.push('the agents list is a live-agent view, not the full session history')
  }
  if (source === 'unknown' && status === 'ok') {
    status = 'partial'
    notes.push('the session list has no declared source, so completeness cannot be trusted')
  }
  if (status === 'ok' && byId.size === 0) {
    status = 'partial'
    notes.push('an authoritative host list was empty while bindings may exist; treating it as incomplete')
  }
  return {
    status,
    source,
    complete: status === 'ok',
    sessions: [...byId.values()],
    total: byId.size,
    duplicates,
    reason: typeof host.reason === 'string' && host.reason ? host.reason : (notes.join('; ') || null),
  }
}

function normalizeRuntime(runtime) {
  if (!isObject(runtime)) return { provided: false, layers: [], totals: null }
  const layers = []
  const add = (name, layer) => {
    const count = runtime[name]
    if (Number.isInteger(count) && count >= 0) layers.push({ name, layer, count })
  }
  add('presetAttachments', 'runtime-listener')
  for (const name of ['inboundMediaJobs', 'inboundCalls', 'inboundSessions', 'mediaCaptures', 'privateInFlight', 'curatorJobs']) add(name, 'temporary-map')
  const sum = (layer) => layers.filter(item => item.layer === layer).reduce((total, item) => total + item.count, 0)
  return {
    provided: true,
    source: typeof runtime.source === 'string' && runtime.source ? runtime.source : 'caller',
    layers,
    totals: { runtimeListeners: sum('runtime-listener'), temporaryMaps: sum('temporary-map') },
  }
}

function sameTitleGroups(host, factsByRaw) {
  const groups = new Map()
  for (const session of host.sessions) {
    if (!session.title) continue
    const key = hash(session.title)
    const group = groups.get(key) || { key, titleLength: session.title.length, sessions: [] }
    group.sessions.push(session)
    groups.set(key, group)
  }
  return [...groups.values()].filter(group => group.sessions.length > 1).map(group => {
    const ids = group.sessions.map(session => session.id)
    const boundLibraries = [...new Set(group.sessions.map(session => {
      const facts = factsByRaw.get(session.id)
      return facts && facts.library.id ? facts.library.id : null
    }))]
    return {
      titleHash: group.key,
      titleLength: group.titleLength,
      sessionIds: ids.slice().sort(),
      bound: group.sessions.filter(session => factsByRaw.has(session.id)).length,
      libraries: boundLibraries,
      mergeable: false,
      identity: 'sessionId',
      reason: 'a title is a label, not an identity: a fork, a restore or a fresh chat can reuse it, and every id owns its own binding, library and inbound queue',
    }
  })
}

/**
 * Pure analysis of an already parsed state object. Never mutates its input, never reads
 * or writes a file. Host and runtime observations are optional; absent ones become
 * explicit unknowns instead of assumptions.
 */
export function analyzeBindings(state, options = {}) {
  if (!isObject(state)) throw new TypeError('analyzeBindings requires a parsed state object')
  const now = numberOrNull(options.now) === null ? Date.now() : options.now
  const redact = options.redactIds === true
  const includeDetails = !redact
  const rawSessions = isObject(state.sessions) ? state.sessions : {}
  const libraries = isObject(state.libraries) ? state.libraries : {}
  const policies = isObject(state.workspacePolicies) ? state.workspacePolicies : {}
  const host = normalizeHost(options.host)
  const runtime = normalizeRuntime(options.runtime)
  const display = new Map()
  const displayId = (id) => {
    if (!redact) return id
    if (!display.has(id)) display.set(id, 'session-' + hash(id))
    return display.get(id)
  }
  const factsList = Object.keys(rawSessions).map(rawId => ({
    rawId,
    facts: bindingFacts(displayId(rawId), rawSessions[rawId], { libraries, policies, now, includeDetails }),
  }))
  const factsByRaw = new Map(factsList.map(item => [item.rawId, item.facts]))
  const hostIds = new Set(host.sessions.map(session => session.id))
  const candidates = []
  const unknownMap = new Map()
  const unknown = (code, detail, extra = {}) => {
    if (!unknownMap.has(code)) unknownMap.set(code, { code, detail, keeps: 'persistent bindings and their queues', ...extra })
  }

  if (!isObject(state.sessions)) unknown(UNKNOWN.BINDINGS_NOT_OBJECT, 'state.sessions is not an object, so no binding could be analysed')

  let idleBasisMissing = 0
  let unboundWithoutEvidence = 0
  let unboundHostSessions = 0
  for (const session of host.sessions) if (!factsByRaw.has(session.id)) unboundHostSessions += 1

  for (const { rawId, facts } of factsList) {
    const kinds = []
    const report = (kind, reason, evidence = {}) => {
      kinds.push(kind)
      candidates.push({ sessionId: facts.sessionId, kind, inspectionOnly: true, action: 'inspect', reason, evidence })
    }
    if (facts.sleep.sessionGone) {
      report(CANDIDATE_KINDS.SESSION_GONE,
        'the host reported this conversation as deleted during sleep consolidation; the binding is kept so a restored or recreated session resumes with its scope and queue',
        { sessionGoneAt: facts.sleep.sessionGoneAt })
    }
    if (host.complete && !hostIds.has(rawId)) {
      report(CANDIDATE_KINDS.HOST_MISSING,
        'the host session registry does not list this id; the binding is kept until the host confirms deletion, and a title match is not such a confirmation',
        { hostSessions: host.total, lastActivityAt: facts.activity.lastActivityAt })
    }
    if (facts.library.id && !facts.library.exists) {
      report(CANDIDATE_KINDS.LIBRARY_MISSING,
        'libraryId points at a library that is not in this state file; the pointer is reported, never rewritten, because the library may live in another profile or a backup',
        { libraryId: facts.library.id })
    }
    if (facts.library.exists && facts.library.archived) {
      report(CANDIDATE_KINDS.LIBRARY_ARCHIVED,
        'the bound library is archived; an archived library is kept on disk, so this is a pointer to inspect, not a reason to unbind',
        { libraryId: facts.library.id })
    }
    if (facts.effective.useLibrary && !facts.library.id) {
      const evidence = unboundEvidence(facts)
      if (evidence.priorInjection) {
        report(CANDIDATE_KINDS.UNBOUND_ENABLED, evidence.basis, {
          folderBlocksLibrary: facts.folder.blocksLibrary,
          injected: facts.injection.injected,
          lastInjectedTurn: facts.injection.lastTurn,
        })
      } else {
        unboundWithoutEvidence += 1
      }
    }
    if (facts.inbound.pending > 0) {
      report(CANDIDATE_KINDS.PENDING_INBOUND,
        'human messages are waiting for injection and must survive any cleanup; a pending queue is unfinished work, not garbage',
        { messages: facts.inbound.pending, bytes: facts.inbound.pendingBytes, retrying: facts.inbound.retrying, retryAt: facts.inbound.retryAt })
    }
    if (facts.sleep.retryAt || facts.sleep.attempts > 0) {
      report(CANDIDATE_KINDS.SLEEP_RETRY,
        'sleep consolidation is deferred or has failed before; the retry clock is host-independent state and must not be reset by a diagnostic',
        { retryAt: facts.sleep.retryAt, retryDue: facts.sleep.retryDue, attempts: facts.sleep.attempts, hasError: facts.sleep.hasError })
    }
    if (facts.recall.degraded) {
      report(CANDIDATE_KINDS.FAILED_RECALL,
        'the last per-turn recall recorded an error; injection stays fail-open, so this is the only trace that memory was degraded',
        { errorLength: facts.recall.errorLength })
    }
    if (facts.injection.reinjectPending) {
      report(CANDIDATE_KINDS.REINJECT_PENDING,
        'a compaction asked for the anchor to be re-sent and the flag has not been cleared yet; a live step normally clears it',
        { lastTurn: facts.injection.lastTurn })
    }
    if (facts.activity.idleMs !== null && facts.activity.idleMs > INSPECTION_DAYS * DAY_MS) {
      report(CANDIDATE_KINDS.IDLE_INSPECTION,
        'no recorded activity for more than the ' + INSPECTION_DAYS + '-day inspection threshold; the threshold only marks what to look at and never schedules a deletion',
        { idleDays: facts.activity.idleDays, idleMs: facts.activity.idleMs, thresholdDays: INSPECTION_DAYS, thresholdMs: INSPECTION_DAYS * DAY_MS, lastActivityAt: facts.activity.lastActivityAt })
    }
    if (facts.activity.lastActivityAt === null) idleBasisMissing += 1
  }

  if (!runtime.provided) {
    unknown(UNKNOWN.RUNTIME_NOT_INSPECTABLE,
      'preset-scope attachments and inbound per-session maps live in the plugin process; a separate process reads only the persisted layer and must not report them as zero',
      { layers: RUNTIME_STATE.map(item => item.file + ' ' + item.name) })
  }
  if (host.status === 'unavailable') {
    unknown(UNKNOWN.HOST_UNAVAILABLE, 'no host session list was supplied; every binding is kept because absence is unproven and an active-agent list is not history')
  } else if (host.status === 'not-loaded') {
    unknown(UNKNOWN.HOST_NOT_LOADED, 'the host session list was not loaded yet; nothing is inferred about missing sessions')
  } else if (host.status === 'partial') {
    unknown(UNKNOWN.HOST_PARTIAL, 'the host session list is incomplete (' + (host.reason || 'no reason given') + '); missing-session candidates are withheld and no state is touched')
  } else if (host.status === 'unknown' || host.status === 'unreadable') {
    unknown(UNKNOWN.HOST_SOURCE_UNTRUSTED, 'the host session list has an unrecognised status; nothing is inferred from it')
  }
  if (host.duplicates > 0) unknown(UNKNOWN.HOST_DUPLICATE_IDS, host.duplicates + ' duplicate host session id(s) were ignored; ids are the only identity')
  if (idleBasisMissing > 0) {
    unknown(UNKNOWN.IDLE_BASIS_MISSING, idleBasisMissing + ' binding(s) carry no turn, inbound or idle timestamp, so their idle age is unknown rather than zero')
  }
  if (unboundWithoutEvidence > 0) {
    unknown(UNKNOWN.UNBOUND_BASIS_UNKNOWN, unboundWithoutEvidence + ' binding(s) want private memory (effective useLibrary: true) and have no libraryId, but record no completed injection, so the snapshot cannot separate a deferred creation from a lost pointer; they are counted, not filed as candidates')
  }

  const groups = host.complete ? sameTitleGroups(host, factsByRaw) : []
  const byKind = {}
  for (const candidate of candidates) byKind[candidate.kind] = (byKind[candidate.kind] || 0) + 1
  const pendingSessions = factsList.filter(item => item.facts.inbound.pending > 0)
  const summary = {
    bindings: factsList.length,
    host: { status: host.status, source: host.source, complete: host.complete, sessions: host.total, unboundHostSessions },
    switches: {
      libraryDisabled: factsList.filter(item => !item.facts.switches.useLibrary).length,
      globalDisabled: factsList.filter(item => !item.facts.switches.useGlobal).length,
      bothDisabled: factsList.filter(item => !item.facts.switches.useLibrary && !item.facts.switches.useGlobal).length,
      folderBlockedLibrary: factsList.filter(item => item.facts.folder.blocksLibrary).length,
      folderBlockedGlobal: factsList.filter(item => item.facts.folder.blocksGlobal).length,
    },
    libraries: {
      bound: factsList.filter(item => Boolean(item.facts.library.id)).length,
      enabledButUnbound: factsList.filter(item => item.facts.effective.useLibrary && !item.facts.library.id).length,
      missing: factsList.filter(item => item.facts.library.id && !item.facts.library.exists).length,
      archived: factsList.filter(item => item.facts.library.exists && item.facts.library.archived).length,
    },
    memoryContext: {
      present: factsList.filter(item => item.facts.memoryContext.present).length,
      absent: factsList.filter(item => !item.facts.memoryContext.present).length,
      scoped: factsList.filter(item => item.facts.memoryContext.scopeKeys.length > 0).length,
    },
    guide: {
      sent: factsList.filter(item => item.facts.guide.sent).length,
      notSent: factsList.filter(item => !item.facts.guide.sent).length,
    },
    inbound: {
      sessionsWithPending: pendingSessions.length,
      pendingMessages: pendingSessions.reduce((total, item) => total + item.facts.inbound.pending, 0),
      retrying: factsList.filter(item => item.facts.inbound.retrying).length,
      seenTotal: factsList.reduce((total, item) => total + item.facts.inbound.seen, 0),
      claimedTotal: factsList.reduce((total, item) => total + item.facts.inbound.claimed, 0),
    },
    sleep: {
      retryScheduled: factsList.filter(item => Boolean(item.facts.sleep.retryAt)).length,
      sessionGone: factsList.filter(item => item.facts.sleep.sessionGone).length,
      failed: factsList.filter(item => item.facts.sleep.hasError).length,
    },
    unfinished: {
      pendingSessions: pendingSessions.length,
      pendingMessages: pendingSessions.reduce((total, item) => total + item.facts.inbound.pending, 0),
      reinjectPending: factsList.filter(item => item.facts.injection.reinjectPending).length,
      sleepRetryDue: factsList.filter(item => item.facts.sleep.retryDue).length,
      sessionGone: factsList.filter(item => item.facts.sleep.sessionGone).length,
    },
    runtime: runtime.provided ? runtime.totals : null,
    candidates: { total: candidates.length, byKind },
    sameTitleGroups: groups.length,
  }
  return {
    now: new Date(now).toISOString(),
    idsRedacted: redact,
    summary,
    bindings: factsList.map(item => item.facts),
    candidates,
    sameTitleGroups: groups,
    unknowns: [...unknownMap.values()],
    runtime: runtime.provided
      ? { status: 'provided', source: runtime.source, layers: runtime.layers }
      : {
          status: 'unknown',
          reason: 'runtime layers cannot be read from this process',
          layers: RUNTIME_STATE.map(item => ({ layer: item.layer, name: item.name, file: item.file, declared: true })),
        },
  }
}

function proofOf(file, before) {
  let after = null
  let mtimeMs = null
  try {
    const buffer = fs.readFileSync(file)
    after = { sha256: crypto.createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length }
  } catch {}
  try { mtimeMs = fs.statSync(file).mtimeMs } catch {}
  const beforeSha = before && before.sha256 ? before.sha256 : null
  const beforeMtime = before && typeof before.mtimeMs === 'number' ? before.mtimeMs : null
  const unchanged = after && beforeSha
    ? after.sha256 === beforeSha && mtimeMs === beforeMtime
    : !after && !beforeSha
  return {
    file,
    sha256Before: beforeSha,
    sha256After: after ? after.sha256 : null,
    bytesBefore: before && typeof before.bytes === 'number' ? before.bytes : null,
    bytesAfter: after ? after.bytes : null,
    mtimeMsBefore: beforeMtime,
    mtimeMsAfter: mtimeMs,
    unchanged: Boolean(unchanged),
    verified: 'the file was re-hashed after analysis; a read-only report must leave bytes and mtime untouched',
  }
}

/**
 * Read a snapshot, analyse it, then re-hash it. The report is JSON-safe and carries no
 * memory text, titles or folder paths; ids are pseudonymised when redactIds is set.
 */
export function diagnoseBindings(options = {}) {
  const now = numberOrNull(options.now) === null ? Date.now() : options.now
  const snapshot = readBindingSnapshot({ stateFile: options.stateFile })
  const report = {
    schema: SCHEMA,
    generatedAt: new Date(now).toISOString(),
    readOnly: true,
    mode: 'report-only',
    refusals: REFUSALS,
    thresholds: { idleInspectionDays: INSPECTION_DAYS, idleIsDeletionTrigger: false },
    state: {
      file: snapshot.file,
      status: snapshot.ok ? 'ok' : snapshot.kind,
      bytes: snapshot.bytes,
      mtimeMs: snapshot.mtimeMs,
      sha256: snapshot.sha256,
    },
    analysis: null,
    unknowns: [],
    readOnlyProof: null,
  }
  if (!snapshot.ok) {
    const code = snapshot.missing ? UNKNOWN.STATE_MISSING
      : snapshot.kind === 'corrupt' ? UNKNOWN.STATE_CORRUPT
        : UNKNOWN.STATE_UNREADABLE
    report.unknowns = [{
      code,
      detail: snapshot.missing
        ? 'no state file exists; nothing was created, because creating one is a write'
        : 'the file could not be parsed; it was left exactly as found and not renamed or quarantined',
      keeps: 'the file on disk',
    }]
    report.readOnlyProof = proofOf(snapshot.file, snapshot)
    return report
  }
  report.analysis = analyzeBindings(snapshot.value, { now, host: options.host, runtime: options.runtime, redactIds: options.redactIds })
  report.unknowns = report.analysis.unknowns
  report.readOnlyProof = proofOf(snapshot.file, snapshot)
  return report
}
