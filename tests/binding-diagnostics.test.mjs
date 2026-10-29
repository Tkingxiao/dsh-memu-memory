import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CANDIDATE_KINDS as KINDS,
  INSPECTION_DAYS,
  REFUSALS,
  RUNTIME_STATE,
  SCHEMA,
  analyzeBindings,
  bindingFacts,
  diagnoseBindings,
  normalizeHost,
  readBindingSnapshot,
} from '../lib/binding-diagnostics.js'

const NOW = Date.parse('2026-10-29T09:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const iso = (at) => new Date(at).toISOString()

function binding(overrides = {}) {
  return {
    scopeKey: 'C:/work/alpha',
    useLibrary: true,
    useGlobal: true,
    domain: 'coding',
    domainOverride: 'rp',
    injectedIds: [],
    injectedAt: {},
    lastInjectedTurn: 0,
    reinjectPending: false,
    activeCue: null,
    ...overrides,
  }
}

function stateWith(sessions, { libraries = {}, workspacePolicies = {} } = {}) {
  return { version: 1, settings: {}, libraries, workspacePolicies, sessions }
}

function registry(sessions) {
  return {
    status: 'ok',
    source: 'session-registry',
    sessions: sessions.map(item => (typeof item === 'string' ? { id: item } : item)),
  }
}

function kindsOf(analysis, sessionId) {
  return analysis.candidates.filter(candidate => candidate.sessionId === sessionId).map(candidate => candidate.kind)
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-binding-diag-'))
}

function runCli(args) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'diagnose-bindings.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  })
}

test('same sessionId reconnecting reuses exactly one binding', () => {
  const state = stateWith({ s1: binding({ lastTurnAt: iso(NOW - 1000) }) })
  const frozen = structuredClone(state)
  const first = analyzeBindings(state, { now: NOW, host: registry(['s1']) })
  const second = analyzeBindings(state, { now: NOW, host: registry(['s1']) })
  assert.equal(first.summary.bindings, 1)
  assert.deepEqual(first.bindings.map(item => item.sessionId), ['s1'])
  assert.deepEqual(first.bindings, second.bindings)
  assert.deepEqual(first.candidates, second.candidates)
  assert.deepEqual(state, frozen)
})

test('an agent context replacement is a runtime listener, not a binding', () => {
  const state = stateWith({ s1: binding({ lastTurnAt: iso(NOW - 1000) }) })
  const base = { now: NOW, host: registry(['s1']) }
  const beforeSwap = analyzeBindings(state, { ...base, runtime: { source: 'plugin-process', presetAttachments: 0 } })
  const afterSwap = analyzeBindings(state, { ...base, runtime: { source: 'plugin-process', presetAttachments: 1 } })
  assert.deepEqual(beforeSwap.bindings, afterSwap.bindings)
  assert.deepEqual(beforeSwap.candidates, afterSwap.candidates)
  assert.equal(beforeSwap.summary.runtime.runtimeListeners, 0)
  assert.equal(afterSwap.summary.runtime.runtimeListeners, 1)
  const listener = RUNTIME_STATE.find(item => item.name === 'attachments')
  assert.equal(listener.layer, 'runtime-listener')
  assert.equal(listener.file, 'lib/preset-scope.js:19')
  const blind = analyzeBindings(state, base)
  assert.equal(blind.summary.runtime, null)
  assert.ok(blind.unknowns.some(item => item.code === 'runtime-layers-not-inspectable'))
})

test('two sessions that share a title stay separate and unmergeable', () => {
  const libraries = {
    'lib-a': { id: 'lib-a', scopeKey: 'C:/work/a' },
    'lib-b': { id: 'lib-b', scopeKey: 'C:/work/b' },
  }
  const state = stateWith({
    s1: binding({ libraryId: 'lib-a', scopeKey: 'C:/work/a', lastTurnAt: iso(NOW - 1000) }),
    s2: binding({ libraryId: 'lib-b', scopeKey: 'C:/work/b', lastTurnAt: iso(NOW - 2000) }),
  }, { libraries })
  const host = registry([
    { id: 's1', title: 'night flight' },
    { id: 's2', title: 'night flight' },
    { id: 's3', title: 'solo' },
  ])
  const analysis = analyzeBindings(state, { now: NOW, host })
  assert.equal(analysis.sameTitleGroups.length, 1)
  const [group] = analysis.sameTitleGroups
  assert.deepEqual(group.sessionIds, ['s1', 's2'])
  assert.equal(group.mergeable, false)
  assert.equal(group.identity, 'sessionId')
  assert.equal(group.bound, 2)
  assert.equal(group.titleLength, 'night flight'.length)
  assert.deepEqual(analysis.bindings.map(item => item.library.id), ['lib-a', 'lib-b'])
  assert.equal(JSON.stringify(analysis).includes('night flight'), false)
  assert.equal(analysis.candidates.length, 0)
})

test('a preset that disappears and returns never duplicates the binding', () => {
  const state = stateWith({ s1: binding({
    lastTurnAt: iso(NOW - 1000),
    inbound: { pending: [{ key: 'h1', text: 'hello' }], seen: [], claimed: [], clock: 1, retryAt: null },
  }) })
  const present = registry([{ id: 's1', title: 'kept', agentPreset: 'p1' }])
  const gone = { status: 'ok', source: 'agents', sessions: [] }
  const first = analyzeBindings(state, { now: NOW, host: present })
  const missing = analyzeBindings(state, { now: NOW, host: gone })
  const again = analyzeBindings(state, { now: NOW, host: present })
  assert.equal(first.summary.bindings, 1)
  assert.equal(missing.summary.bindings, 1)
  assert.equal(first.summary.host.complete, true)
  assert.equal(missing.summary.host.complete, false)
  assert.equal(first.summary.inbound.pendingMessages, 1)
  assert.equal(missing.summary.inbound.pendingMessages, 1)
  assert.equal(again.summary.inbound.pendingMessages, 1)
  assert.equal(missing.candidates.filter(candidate => candidate.kind === KINDS.HOST_MISSING).length, 0)
  assert.ok(missing.unknowns.some(item => item.code === 'host-partial'))
  assert.deepEqual(missing.candidates, first.candidates)
  assert.deepEqual(again.bindings, first.bindings)
  assert.deepEqual(again.candidates, first.candidates)
})

test('a deleted session keeps its scope and queue for a later restore', () => {
  const libraries = { 'lib-1': { id: 'lib-1', scopeKey: 'C:/work/alpha' } }
  const shared = {
    libraryId: 'lib-1',
    scopeKey: 'C:/work/alpha',
    memoryContext: { channelId: 'c1', characterId: 'ch1' },
    lastTurnAt: iso(NOW - 60_000),
    inbound: { pending: [{ key: 'h1', text: 'still here' }], seen: ['a'], claimed: [], clock: 4, retryAt: null },
  }
  const deleted = stateWith({ s1: binding({ ...shared, sessionGone: true, sessionGoneAt: iso(NOW - 10_000) }) }, { libraries })
  const restored = stateWith({ s1: binding({ ...shared, sessionGone: false, sessionGoneAt: null }) }, { libraries })
  const before = analyzeBindings(deleted, { now: NOW })
  const after = analyzeBindings(restored, { now: NOW })
  assert.deepEqual(kindsOf(before, 's1'), [KINDS.SESSION_GONE, KINDS.PENDING_INBOUND])
  assert.equal(before.summary.inbound.pendingMessages, 1)
  assert.equal(before.summary.unfinished.pendingSessions, 1)
  assert.equal(before.bindings[0].library.id, 'lib-1')
  assert.deepEqual(before.bindings[0].memoryContext.scopeKeys, ['channelId', 'characterId'])
  assert.equal(kindsOf(after, 's1').includes(KINDS.SESSION_GONE), false)
  assert.equal(after.summary.bindings, before.summary.bindings)
  assert.equal(after.summary.inbound.pendingMessages, before.summary.inbound.pendingMessages)
  assert.equal(after.bindings[0].library.id, before.bindings[0].library.id)
  for (const candidate of before.candidates) {
    assert.equal(candidate.inspectionOnly, true)
    assert.equal(candidate.action, 'inspect')
  }
})

test('a failed, partial or not-yet-loaded host query never becomes a deletion', () => {
  const state = stateWith({ s1: binding({ lastTurnAt: iso(NOW - 1000) }) })
  const cases = [
    { label: 'absent', host: undefined, code: 'host-unavailable' },
    { label: 'not-loaded', host: { status: 'not-loaded', source: 'session-registry', sessions: [] }, code: 'host-not-loaded' },
    { label: 'active-agents', host: { status: 'ok', source: 'agents', sessions: [{ id: 'other' }] }, code: 'host-partial' },
    { label: 'unknown-source', host: { status: 'ok', sessions: [{ id: 'other' }] }, code: 'host-partial' },
    { label: 'empty-registry', host: { status: 'ok', source: 'session-registry', sessions: [] }, code: 'host-partial' },
  ]
  for (const item of cases) {
    const analysis = analyzeBindings(state, { now: NOW, host: item.host })
    assert.deepEqual(analysis.candidates.filter(candidate => candidate.kind === KINDS.HOST_MISSING), [], item.label)
    assert.ok(analysis.unknowns.some(unknown => unknown.code === item.code), item.label + ' -> ' + item.code)
    assert.equal(analysis.summary.host.complete, false, item.label)
    assert.equal(analysis.summary.bindings, 1, item.label)
  }
  const authoritative = analyzeBindings(state, { now: NOW, host: registry([{ id: 'other' }]) })
  assert.deepEqual(kindsOf(authoritative, 's1'), [KINDS.HOST_MISSING])
})

test('30 days is an inspection threshold, never a deletion trigger', () => {
  const oldAnalysis = analyzeBindings(stateWith({ s1: binding({ lastTurnAt: iso(NOW - 31 * DAY) }) }), { now: NOW, host: registry(['s1']) })
  const freshAnalysis = analyzeBindings(stateWith({ s2: binding({ lastTurnAt: iso(NOW - 29 * DAY) }) }), { now: NOW, host: registry(['s2']) })
  assert.deepEqual(kindsOf(oldAnalysis, 's1'), [KINDS.IDLE_INSPECTION])
  assert.deepEqual(kindsOf(freshAnalysis, 's2'), [])
  const candidate = oldAnalysis.candidates[0]
  assert.equal(candidate.evidence.thresholdDays, INSPECTION_DAYS)
  assert.equal(candidate.evidence.idleDays, 31)
  assert.equal(candidate.inspectionOnly, true)
  const dir = tempRoot()
  try {
    const report = diagnoseBindings({ stateFile: path.join(dir, 'state.json'), now: NOW })
    assert.equal(report.thresholds.idleIsDeletionTrigger, false)
    assert.ok(report.refusals.includes('delete-binding'))
    assert.ok(report.refusals.includes('gc'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('unfinished work is counted: queue, dedupe counters, retry, guide, switches', () => {
  const state = stateWith({
    s1: binding({
      useLibrary: false,
      useGlobal: false,
      libraryId: null,
      guideMessageAt: iso(NOW - 5000),
      memoryContext: { channelId: 'c1', characterId: 'ch1', worldId: 'w1', branchId: 'b1' },
      activeCue: { createdAt: iso(NOW - 60_000), text: 'cue' },
      injectedIds: ['m1', 'm2'],
      lastInjectedTurn: 7,
      reinjectPending: true,
      lastRecallError: 'engine unavailable',
      inbound: {
        pending: [{ key: 'k1', text: 'a' }, { key: 'k2', text: 'b' }],
        seen: ['s1', 's2', 's3'],
        claimed: ['c1'],
        clock: 9,
        retryAt: iso(NOW + 30_000),
      },
      sleepRetryAt: iso(NOW + 60_000),
      sleepAttempts: 2,
      lastSleepError: 'session gone',
    }),
  })
  const analysis = analyzeBindings(state, { now: NOW, host: registry(['s1']) })
  const kinds = kindsOf(analysis, 's1')
  for (const kind of [KINDS.PENDING_INBOUND, KINDS.SLEEP_RETRY, KINDS.FAILED_RECALL, KINDS.REINJECT_PENDING]) {
    assert.ok(kinds.includes(kind), kind)
  }
  const summary = analysis.summary
  assert.equal(summary.inbound.sessionsWithPending, 1)
  assert.equal(summary.inbound.pendingMessages, 2)
  assert.equal(summary.inbound.seenTotal, 3)
  assert.equal(summary.inbound.claimedTotal, 1)
  assert.equal(summary.inbound.retrying, 1)
  assert.equal(summary.memoryContext.present, 1)
  assert.equal(summary.memoryContext.scoped, 1)
  assert.deepEqual(analysis.bindings[0].memoryContext.scopeKeys, ['channelId', 'characterId', 'worldId', 'branchId'])
  assert.equal(summary.guide.sent, 1)
  assert.equal(summary.switches.bothDisabled, 1)
  assert.equal(summary.sleep.retryScheduled, 1)
  assert.equal(summary.sleep.failed, 1)
  assert.equal(summary.unfinished.reinjectPending, 1)
  assert.equal(analysis.bindings[0].injection.cueLive, true)
  assert.equal(kinds.includes(KINDS.UNBOUND_ENABLED), false)
  const facts = bindingFacts('s1', state.sessions.s1, { now: NOW })
  assert.equal('detail' in facts, false)
})

test('a folder policy is a ceiling on both switches', () => {
  const policies = { 'C:/work/alpha': { useLibrary: false, useGlobal: true } }
  const libraries = { 'lib-1': { id: 'lib-1', scopeKey: 'C:/work/alpha' } }
  const state = stateWith({ s1: binding({ libraryId: 'lib-1', scopeKey: 'C:/work/alpha' }) }, { workspacePolicies: policies, libraries })
  const analysis = analyzeBindings(state, { now: NOW, host: registry(['s1']) })
  const [facts] = analysis.bindings
  assert.equal(facts.switches.useLibrary, true)
  assert.equal(facts.effective.useLibrary, false)
  assert.equal(facts.effective.useGlobal, true)
  assert.equal(facts.folder.blocksLibrary, true)
  assert.equal(facts.folder.blocksGlobal, false)
  assert.equal(analysis.summary.switches.folderBlockedLibrary, 1)
  assert.equal(analysis.summary.switches.folderBlockedGlobal, 0)
  const unbound = analyzeBindings(stateWith({ s1: binding({ scopeKey: 'C:/work/alpha', libraryId: null }) }, { workspacePolicies: policies }), { now: NOW, host: registry(['s1']) })
  assert.equal(kindsOf(unbound, 's1').includes(KINDS.UNBOUND_ENABLED), false)
  const disabled = analyzeBindings(stateWith({ s1: binding({ scopeKey: 'C:/work/alpha', useLibrary: false, libraryId: null }) }), { now: NOW, host: registry(['s1']) })
  assert.equal(disabled.bindings[0].effective.useLibrary, false)
  assert.equal(disabled.summary.switches.libraryDisabled, 1)
})

test('a dangling library pointer is reported, never rewritten', () => {
  const state = stateWith({ s1: binding({ libraryId: 'lib-gone', scopeKey: 'C:/work/alpha', lastTurnAt: iso(NOW - 1000) }) })
  const missing = analyzeBindings(state, { now: NOW, host: registry(['s1']) })
  assert.deepEqual(kindsOf(missing, 's1'), [KINDS.LIBRARY_MISSING])
  assert.equal(missing.candidates[0].evidence.libraryId, 'lib-gone')
  const restored = analyzeBindings(stateWith(
    { s1: binding({ libraryId: 'lib-gone', scopeKey: 'C:/work/alpha', lastTurnAt: iso(NOW - 1000) }) },
    { libraries: { 'lib-gone': { id: 'lib-gone', scopeKey: 'C:/work/alpha' } } },
  ), { now: NOW, host: registry(['s1']) })
  assert.deepEqual(kindsOf(restored, 's1'), [])
  assert.equal(restored.bindings[0].library.sameScope, true)
})

test('an archived library is inspected, not unbound', () => {
  const state = stateWith(
    { s1: binding({ libraryId: 'lib-1', scopeKey: 'C:/work/alpha' }) },
    { libraries: { 'lib-1': { id: 'lib-1', scopeKey: 'C:/work/alpha', archived: true } } },
  )
  const analysis = analyzeBindings(state, { now: NOW, host: registry(['s1']) })
  assert.deepEqual(kindsOf(analysis, 's1'), [KINDS.LIBRARY_ARCHIVED])
  assert.equal(analysis.summary.libraries.archived, 1)
  assert.equal(analysis.bindings[0].library.exists, true)
})

test('a state read is byte-for-byte read-only', () => {
  const dir = tempRoot()
  try {
    const file = path.join(dir, 'state.json')
    const state = stateWith(
      { s1: binding({ inbound: { pending: [{ key: 'h1', text: 'hi' }], seen: [], claimed: [], clock: 3, retryAt: null }, memoryContext: { channelId: 'c1' } }) },
      { libraries: { 'lib-1': { id: 'lib-1', scopeKey: 'C:/work/alpha' } } },
    )
    fs.writeFileSync(file, JSON.stringify(state, null, 2))
    const beforeStat = fs.statSync(file)
    const beforeBytes = fs.readFileSync(file)
    const report = diagnoseBindings({ stateFile: file, now: NOW, host: registry([{ id: 's1', title: 'kept' }]) })
    const afterStat = fs.statSync(file)
    const afterBytes = fs.readFileSync(file)
    assert.equal(report.readOnlyProof.unchanged, true)
    assert.equal(report.readOnlyProof.sha256Before, report.readOnlyProof.sha256After)
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs)
    assert.deepEqual(afterBytes, beforeBytes)
    assert.deepEqual(fs.readdirSync(dir), ['state.json'])
    assert.equal(report.analysis.summary.bindings, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt state file is reported and left in place', () => {
  const dir = tempRoot()
  try {
    const file = path.join(dir, 'state.json')
    const broken = '{"version":1,"sessions":'
    fs.writeFileSync(file, broken)
    const report = diagnoseBindings({ stateFile: file, now: NOW })
    assert.equal(report.state.status, 'corrupt')
    assert.equal(report.analysis, null)
    assert.equal(report.unknowns[0].code, 'state-corrupt')
    assert.equal(report.readOnlyProof.unchanged, true)
    assert.deepEqual(fs.readdirSync(dir), ['state.json'])
    assert.equal(fs.readFileSync(file, 'utf8'), broken)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing state file is not created', () => {
  const dir = tempRoot()
  try {
    const file = path.join(dir, 'state.json')
    const report = diagnoseBindings({ stateFile: file, now: NOW })
    assert.equal(report.state.status, 'missing')
    assert.equal(report.analysis, null)
    assert.equal(report.unknowns[0].code, 'state-missing')
    assert.deepEqual(fs.readdirSync(dir), [])
    assert.equal(fs.existsSync(file), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a redacted report omits ids, titles and folder paths', () => {
  const dir = tempRoot()
  try {
    const file = path.join(dir, 'state.json')
    const state = stateWith({ 's1-secret-id': binding({ scopeKey: 'C:/Users/someone/private/project', lastTurnAt: iso(NOW - 1000) }) })
    fs.writeFileSync(file, JSON.stringify(state))
    const report = diagnoseBindings({
      stateFile: file,
      now: NOW,
      redactIds: true,
      host: registry([{ id: 's1-secret-id', title: 'my private chat' }]),
    })
    const text = JSON.stringify(report)
    assert.equal(text.includes('s1-secret-id'), false)
    assert.equal(text.includes('private/project'), false)
    assert.equal(text.includes('my private chat'), false)
    assert.match(report.analysis.bindings[0].sessionId, /^session-[0-9a-f]{12}$/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the snapshot reader parses without repairing', () => {
  const dir = tempRoot()
  try {
    const file = path.join(dir, 'state.json')
    fs.writeFileSync(file, JSON.stringify(stateWith({ s1: binding() })))
    const snapshot = readBindingSnapshot({ stateFile: file })
    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.kind, 'ok')
    assert.equal(snapshot.value.sessions.s1.useLibrary, true)
    assert.equal(snapshot.bytes, fs.statSync(file).size)
    assert.equal(snapshot.sha256.length, 64)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('host normalization refuses to trust a live-agent list', () => {
  const agents = normalizeHost({
    status: 'ok',
    source: 'agents',
    sessions: [{ id: 'a', title: '  t  ' }, { id: 'a', title: 'dup' }, { id: '' }, null],
  })
  assert.equal(agents.status, 'partial')
  assert.equal(agents.complete, false)
  assert.equal(agents.total, 1)
  assert.equal(agents.duplicates, 1)
  assert.equal(agents.sessions[0].title, 't')
  assert.match(agents.reason, /live-agent/)
  const absent = normalizeHost(undefined)
  assert.equal(absent.status, 'unavailable')
  assert.equal(absent.complete, false)
})

test('the contract pins a read-only role: no gc, no deletion', () => {
  for (const action of ['gc', 'delete-binding', 'delete-session', 'delete-library', 'write-state']) {
    assert.ok(REFUSALS.includes(action), action)
  }
  assert.equal(REFUSALS.includes('inspect'), false)
  assert.equal(SCHEMA, 'dsh-memu-memory/binding-diagnostics@1')
  for (const item of RUNTIME_STATE) {
    assert.ok(item.layer)
    assert.ok(item.name)
    assert.match(item.file, /^lib\/.+:\d+$/)
  }
  assert.ok(RUNTIME_STATE.some(item => item.file === 'lib/preset-scope.js:19' && item.layer === 'runtime-listener'))
  assert.ok(RUNTIME_STATE.some(item => item.file === 'lib/inbound.js:14'))
})

test('a file-level reconnect is idempotent and leaves the snapshot untouched', () => {
  const dir = tempRoot()
  try {
    const file = path.join(dir, 'state.json')
    const state = stateWith(
      { s1: binding({ libraryId: 'lib-1', lastTurnAt: iso(NOW - 1000) }) },
      { libraries: { 'lib-1': { id: 'lib-1', scopeKey: 'C:/work/alpha' } } },
    )
    fs.writeFileSync(file, JSON.stringify(state, null, 2))
    const beforeBytes = fs.readFileSync(file)
    const beforeMtime = fs.statSync(file).mtimeMs

    const first = diagnoseBindings({ stateFile: file, now: NOW, host: registry([{ id: 's1', title: 'kept' }]) })
    const second = diagnoseBindings({ stateFile: file, now: NOW, host: registry([{ id: 's1', title: 'kept' }]) })

    assert.equal(first.analysis.summary.bindings, 1)
    assert.deepEqual(second.analysis.bindings, first.analysis.bindings)
    assert.deepEqual(second.analysis.candidates, first.analysis.candidates)
    assert.equal(first.readOnlyProof.unchanged, true)
    assert.equal(second.readOnlyProof.unchanged, true)
    assert.equal(second.readOnlyProof.sha256Before, first.readOnlyProof.sha256After)
    assert.deepEqual(fs.readdirSync(dir), ['state.json'])
    assert.deepEqual(fs.readFileSync(file), beforeBytes)
    assert.equal(fs.statSync(file).mtimeMs, beforeMtime)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a context replacement changes only the runtime layer in a file report', () => {
  const dir = tempRoot()
  try {
    const file = path.join(dir, 'state.json')
    const state = stateWith(
      { s1: binding({ libraryId: 'lib-1', lastTurnAt: iso(NOW - 1000) }) },
      { libraries: { 'lib-1': { id: 'lib-1', scopeKey: 'C:/work/alpha' } } },
    )
    fs.writeFileSync(file, JSON.stringify(state))

    const beforeSwap = diagnoseBindings({
      stateFile: file,
      now: NOW,
      host: registry(['s1']),
      runtime: { source: 'plugin-process', presetAttachments: 0 },
    })
    const afterSwap = diagnoseBindings({
      stateFile: file,
      now: NOW,
      host: registry(['s1']),
      runtime: { source: 'plugin-process', presetAttachments: 1, inboundSessions: 1 },
    })

    assert.deepEqual(afterSwap.analysis.bindings, beforeSwap.analysis.bindings)
    assert.deepEqual(afterSwap.analysis.candidates, beforeSwap.analysis.candidates)
    assert.equal(beforeSwap.analysis.summary.runtime.runtimeListeners, 0)
    assert.equal(afterSwap.analysis.summary.runtime.runtimeListeners, 1)
    assert.equal(afterSwap.analysis.summary.runtime.temporaryMaps, 1)
    assert.equal(afterSwap.analysis.summary.bindings, 1)
    assert.equal(afterSwap.analysis.runtime.status, 'provided')
    assert.equal(afterSwap.analysis.runtime.layers.length, 2)
    assert.equal(beforeSwap.readOnlyProof.unchanged, true)
    assert.equal(afterSwap.readOnlyProof.unchanged, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a shared title with different ids keeps one bound and one unbound session', () => {
  const libraries = { 'lib-a': { id: 'lib-a', scopeKey: 'C:/work/a' } }
  const state = stateWith({ s1: binding({ libraryId: 'lib-a', scopeKey: 'C:/work/a', lastTurnAt: iso(NOW - 1000) }) }, { libraries })
  const host = registry([
    { id: 's1', title: 'night flight' },
    { id: 's2', title: 'night flight' },
  ])
  const analysis = analyzeBindings(state, { now: NOW, host })

  assert.equal(analysis.summary.bindings, 1)
  assert.deepEqual(analysis.bindings.map(item => item.sessionId), ['s1'])
  assert.equal(analysis.summary.host.unboundHostSessions, 1)
  assert.equal(analysis.sameTitleGroups.length, 1)
  const [group] = analysis.sameTitleGroups
  assert.deepEqual(group.sessionIds, ['s1', 's2'])
  assert.equal(group.bound, 1)
  assert.deepEqual(group.libraries, ['lib-a', null])
  assert.equal(group.mergeable, false)
  assert.equal(group.identity, 'sessionId')
  assert.equal(analysis.candidates.length, 0)
  assert.equal(JSON.stringify(analysis).includes('night flight'), false)
})

test('a full delete and restore cycle keeps one binding, its scope and its queue', () => {
  const libraries = { 'lib-1': { id: 'lib-1', scopeKey: 'C:/work/alpha' } }
  const shared = {
    libraryId: 'lib-1',
    scopeKey: 'C:/work/alpha',
    memoryContext: { channelId: 'c1', characterId: 'ch1' },
    lastTurnAt: iso(NOW - 60_000),
    inbound: { pending: [{ key: 'h1', text: 'still here' }], seen: ['a'], claimed: [], clock: 4, retryAt: null },
  }
  const liveState = stateWith({ s1: binding(shared) }, { libraries })
  const deletedState = stateWith({ s1: binding({ ...shared, sessionGone: true, sessionGoneAt: iso(NOW - 10_000) }) }, { libraries })
  const restoredState = stateWith({ s1: binding({ ...shared, sessionGone: false, sessionGoneAt: null }) }, { libraries })

  const live = analyzeBindings(liveState, { now: NOW, host: registry(['s1']) })
  const deleted = analyzeBindings(deletedState, { now: NOW, host: registry([{ id: 'other' }]) })
  const restored = analyzeBindings(restoredState, { now: NOW, host: registry(['s1']) })

  assert.deepEqual(kindsOf(live, 's1'), [KINDS.PENDING_INBOUND])
  assert.deepEqual(kindsOf(deleted, 's1'), [KINDS.SESSION_GONE, KINDS.HOST_MISSING, KINDS.PENDING_INBOUND])
  assert.deepEqual(kindsOf(restored, 's1'), [KINDS.PENDING_INBOUND])
  for (const analysis of [live, deleted, restored]) {
    assert.equal(analysis.summary.bindings, 1)
    assert.equal(analysis.summary.inbound.pendingMessages, 1)
    assert.equal(analysis.summary.unfinished.pendingSessions, 1)
    assert.equal(analysis.bindings[0].library.id, 'lib-1')
    assert.deepEqual(analysis.bindings[0].memoryContext.scopeKeys, ['channelId', 'characterId'])
  }
  assert.equal(restored.bindings[0].sleep.sessionGone, false)
  for (const candidate of deleted.candidates) {
    assert.equal(candidate.inspectionOnly, true)
    assert.equal(candidate.action, 'inspect')
  }
})

test('persistent, runtime-listener and temporary-map counts never mix', () => {
  const state = stateWith({ s1: binding({ lastTurnAt: iso(NOW - 1000) }) })
  const base = { now: NOW, host: registry(['s1']) }
  const persistent = analyzeBindings(state, base)
  const withRuntime = analyzeBindings(state, {
    ...base,
    runtime: {
      presetAttachments: 2,
      inboundMediaJobs: 3,
      inboundCalls: 4,
      inboundSessions: 5,
      mediaCaptures: 6,
      privateInFlight: 7,
      curatorJobs: 8,
    },
  })

  assert.deepEqual(withRuntime.bindings, persistent.bindings)
  assert.deepEqual(withRuntime.candidates, persistent.candidates)
  assert.equal(persistent.summary.runtime, null)
  assert.deepEqual(withRuntime.summary.runtime, { runtimeListeners: 2, temporaryMaps: 33 })
  assert.equal(withRuntime.summary.bindings, 1)
  assert.equal(withRuntime.summary.candidates.total, 0)
  assert.equal('runtime' in withRuntime.bindings[0], false)
  assert.equal(RUNTIME_STATE.filter(item => item.layer === 'runtime-listener').length, 1)
  assert.equal(RUNTIME_STATE.filter(item => item.layer === 'temporary-map').length, 6)
  assert.equal(RUNTIME_STATE.filter(item => item.layer === 'cache').length, 2)

  // The declared file:line positions are part of the diagnostic contract. If a source
  // edit moves a map without updating RUNTIME_STATE, this guard fails instead of silently
  // printing a stale map location.
  for (const item of RUNTIME_STATE) {
    const match = /^(lib\/[^:]+):(\d+)$/.exec(item.file)
    assert.ok(match, item.file)
    const source = fs.readFileSync(path.join(ROOT, match[1]), 'utf8').split(/\r?\n/)
    const line = source[Number(match[2]) - 1]
    assert.ok(line && line.includes(item.name), item.file + ' should declare ' + item.name)
  }
})

test('a failed host query keeps the queue, scope and library pointer', () => {
  const libraries = { 'lib-1': { id: 'lib-1', scopeKey: 'C:/work/alpha' } }
  const state = stateWith({
    s1: binding({
      libraryId: 'lib-1',
      scopeKey: 'C:/work/alpha',
      memoryContext: { channelId: 'c1', characterId: 'ch1' },
      lastTurnAt: iso(NOW - 1000),
      inbound: { pending: [{ key: 'h1', text: 'hello' }], seen: [], claimed: [], clock: 2, retryAt: null },
    }),
  }, { libraries })
  const frozen = structuredClone(state)
  const cases = [
    { label: 'absent', host: undefined, code: 'host-unavailable' },
    { label: 'not-loaded', host: { status: 'not-loaded', source: 'session-registry', sessions: [] }, code: 'host-not-loaded' },
    { label: 'partial', host: { status: 'partial', source: 'session-registry', reason: 'query failed', sessions: [] }, code: 'host-partial' },
    { label: 'active-agents', host: { status: 'ok', source: 'agents', sessions: [] }, code: 'host-partial' },
  ]
  for (const item of cases) {
    const analysis = analyzeBindings(state, { now: NOW, host: item.host })
    assert.equal(analysis.summary.bindings, 1, item.label)
    assert.equal(analysis.bindings[0].library.id, 'lib-1', item.label)
    assert.deepEqual(analysis.bindings[0].memoryContext.scopeKeys, ['channelId', 'characterId'], item.label)
    assert.equal(analysis.summary.inbound.pendingMessages, 1, item.label)
    assert.equal(analysis.summary.unfinished.pendingSessions, 1, item.label)
    assert.ok(analysis.unknowns.some(unknown => unknown.code === item.code), item.label + ' -> ' + item.code)
    assert.equal(analysis.candidates.filter(candidate => candidate.kind === KINDS.HOST_MISSING).length, 0, item.label)
    assert.deepEqual(state, frozen, item.label)
  }
})

test('exactly 30 days is not reported; one millisecond over is', () => {
  const libraries = { 'lib-1': { id: 'lib-1', scopeKey: 'C:/work/alpha' } }
  const exactly = analyzeBindings(
    stateWith({ s1: binding({ libraryId: 'lib-1', lastTurnAt: iso(NOW - 30 * DAY) }) }, { libraries }),
    { now: NOW, host: registry(['s1']) },
  )
  assert.equal(exactly.bindings[0].activity.idleMs, 30 * DAY)
  assert.equal(exactly.bindings[0].activity.idleDays, 30)
  assert.deepEqual(kindsOf(exactly, 's1'), [])

  const justOver = analyzeBindings(
    stateWith({ s1: binding({ libraryId: 'lib-1', lastTurnAt: iso(NOW - 30 * DAY - 1) }) }, { libraries }),
    { now: NOW, host: registry(['s1']) },
  )
  assert.equal(justOver.bindings[0].activity.idleMs, 30 * DAY + 1)
  assert.deepEqual(kindsOf(justOver, 's1'), [KINDS.IDLE_INSPECTION])
  assert.equal(justOver.candidates[0].evidence.thresholdDays, INSPECTION_DAYS)
  assert.equal(justOver.candidates[0].evidence.idleMs, 30 * DAY + 1)
})

test('the CLI returns 0/1/2/3 and never creates a directory or writes state', () => {
  const dir = tempRoot()
  try {
    const cleanFile = path.join(dir, 'clean.json')
    const cleanState = stateWith(
      { s1: binding({ libraryId: 'lib-1', lastTurnAt: iso(NOW - 1000) }) },
      { libraries: { 'lib-1': { id: 'lib-1', scopeKey: 'C:/work/alpha' } } },
    )
    fs.writeFileSync(cleanFile, JSON.stringify(cleanState))
    const cleanBytes = fs.readFileSync(cleanFile)
    const cleanMtime = fs.statSync(cleanFile).mtimeMs

    const clean = runCli(['--state', cleanFile, '--now', iso(NOW)])
    assert.equal(clean.status, 0, clean.stderr)
    assert.match(clean.stdout, /bindings: 1/)
    assert.match(clean.stdout, /read-only proof: bytes and mtime identical/)
    assert.match(clean.stdout, /runtime layers not readable from this process: 9 declared \(unknown\)/)

    const candidateFile = path.join(dir, 'candidate.json')
    const candidateState = stateWith({
      s1: binding({
        lastTurnAt: iso(NOW - 1000),
        inbound: { pending: [{ key: 'h1', text: 'hello' }], seen: [], claimed: [], clock: 1, retryAt: null },
      }),
    })
    fs.writeFileSync(candidateFile, JSON.stringify(candidateState))
    const candidateBytes = fs.readFileSync(candidateFile)
    const candidateMtime = fs.statSync(candidateFile).mtimeMs

    const candidate = runCli(['--state', candidateFile, '--now', iso(NOW)])
    assert.equal(candidate.status, 1, candidate.stderr)
    assert.match(candidate.stdout, /pending-inbound/)
    assert.match(candidate.stdout, /inspection candidates/)

    const candidateJson = runCli(['--state', candidateFile, '--now', iso(NOW), '--json'])
    assert.equal(candidateJson.status, 1, candidateJson.stderr)
    const parsed = JSON.parse(candidateJson.stdout)
    assert.equal(parsed.analysis.summary.candidates.total, 1)

    for (const args of [['--nope'], ['--now', 'not-a-date']]) {
      const usage = runCli(args)
      assert.equal(usage.status, 2, args.join(' '))
      assert.match(usage.stderr, /error:/)
    }
    const help = runCli(['--help'])
    assert.equal(help.status, 0)

    const missingDir = path.join(dir, 'nested')
    const missing = runCli(['--state', path.join(missingDir, 'state.json'), '--now', iso(NOW)])
    assert.equal(missing.status, 3, missing.stderr)
    assert.equal(fs.existsSync(missingDir), false)

    assert.deepEqual(fs.readdirSync(dir).sort(), ['candidate.json', 'clean.json'])
    assert.deepEqual(fs.readFileSync(cleanFile), cleanBytes)
    assert.equal(fs.statSync(cleanFile).mtimeMs, cleanMtime)
    assert.deepEqual(fs.readFileSync(candidateFile), candidateBytes)
    assert.equal(fs.statSync(candidateFile).mtimeMs, candidateMtime)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('analysis rejects a state that is not an object', () => {
  for (const value of [null, [], 'x', 3]) {
    assert.throws(() => analyzeBindings(value), /parsed state object/)
  }
})
