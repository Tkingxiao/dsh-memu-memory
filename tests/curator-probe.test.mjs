// W5 probe: which layers of global curation carry content from each channel.
//
// Six synthetic channels, each with its own unique marker:
//   1. secretAuto   secret auto-injection (plugin message in the user role, form=anchor;
//                   hypothetical shape: production secrets are not auto-injected)
//   2. recallSecret tool/result of an explicit memu_private_recall (secret body)
//   3. toolArgs     tool-call arguments (assistant/message tool-call + tool/call event)
//   4. recallPlain  ordinary private recall auto-injection (plugin message, form=recall)
//   5. assistant    assistant text (paraphrase)
//   6. user         user/message with source.kind === 'user'
//
// For each channel this file reports whether the marker reaches:
//   (a) the condensed transcript,
//   (b) the real prompt passed to subagents.startActivation,
//   (c) the simulated curator output,
//   (d) the committed global index.
//
// Every value below is synthetic. This file never reads or writes the real
// ~/.dsh/dsh-memu tree: DSH_MEMU_HOME points at an os.tmpdir() root before the
// plugin modules are imported and the root is removed afterwards. The clock,
// Math.random and crypto.randomBytes are fixed so ids and timestamps are
// reproducible.
//
// What it can prove: a marker placed in a given input channel does or does not
// reach each layer, and that the commit layer checks neither provenance nor
// secret visibility. What it cannot prove: that a real model would copy a
// secret into its output, or that a leak happened on a real machine.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-probe-'))
delete process.env.DSH_MEMU_MEMORY_HOME
process.env.DSH_MEMU_HOME = home

// Fixed clock and random sources. newMemoryId() uses Date.now() plus
// crypto.randomBytes(), while job ids use Date.now() plus Math.random().
const RealDate = Date
const FIXED_NOW = RealDate.parse('2026-01-02T03:04:05.000Z')
class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FIXED_NOW)
    else super(...args)
  }
  static now() { return FIXED_NOW }
}
globalThis.Date = FixedDate
const realRandom = Math.random
let randomState = 0x5eed1234
Math.random = () => {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
  return randomState / 0x100000000
}
const realRandomBytes = crypto.randomBytes
let randomByte = 0x40
crypto.randomBytes = (size) => {
  const buffer = Buffer.alloc(size)
  for (let i = 0; i < size; i += 1) buffer[i] = (randomByte + i) & 0xff
  randomByte = (randomByte + size) & 0xff
  return buffer
}

const {
  startGlobalCuration, commitCuratorOutput, getCurationJob, condenseEvents,
} = await import('../lib/curator.js')
const { loadGlobalIndex, saveGlobalIndex } = await import('../lib/state.js')
const { dataDir } = await import('../lib/paths.js')

test.after(() => {
  globalThis.Date = RealDate
  Math.random = realRandom
  crypto.randomBytes = realRandomBytes
  fs.rmSync(home, { recursive: true, force: true })
})

const M = {
  secretAuto: 'W5PROBE-SECRET-AUTOINJECT-8f3a',
  recallSecret: 'W5PROBE-RECALL-RESULT-SECRET-8f3a',
  toolArgs: 'W5PROBE-TOOLCALL-ARGS-8f3a',
  recallPlain: 'W5PROBE-RECALL-PLAIN-8f3a',
  assistant: 'W5PROBE-ASSISTANT-PARAPHRASE-8f3a',
  user: 'W5PROBE-USER-ORIGINAL-8f3a',
  toolTail: 'W5PROBE-TOOLTAIL-8f3a',
  existing: 'W5PROBE-EXISTING-8f3a',
  archived: 'W5PROBE-ARCHIVED-8f3a',
  pending: 'W5PROBE-PENDING-8f3a',
  modelOnly: 'W5PROBE-MODEL-ONLY-8f3a',
  invalidDomain: 'W5PROBE-COMMIT-SKIPPED-8f3a',
  credential: 'sk-W5PROBEfakeCredential1234',
}

const CHANNELS = [
  { key: 'secretAuto', shape: 'plugin anchor message (user role)', layers: [false, false, false, false] },
  { key: 'recallSecret', shape: 'tool/result from memu_private_recall', layers: [true, true, true, true] },
  { key: 'toolArgs', shape: 'assistant tool-call arguments + tool/call event', layers: [true, true, true, true] },
  { key: 'recallPlain', shape: 'plugin recall message (user role)', layers: [false, false, false, false] },
  { key: 'assistant', shape: 'assistant text (paraphrase)', layers: [true, true, true, true] },
  { key: 'user', shape: 'user/message with source.kind=user', layers: [true, true, true, true] },
]

const HEADER = {
  id: 'probe-session',
  title: 'Synthetic probe session',
  createdAt: '2026-01-01T00:00:00.000Z',
  cwd: path.join(home, 'project'),
  agentPreset: 'coding',
}

// The six channels share one transcript, so a single full-chain run can report
// all of them against the same prompt and the same commit.
function probeEvents() {
  return [
    // 1. Automatic anchor injection: a plugin message, not a user message.
    {
      type: 'user/message',
      data: {
        source: { kind: 'plugin:dsh-memu-memory', form: 'anchor' },
        content: [{ type: 'text', text: '<memory-context scope="private">- [pmem-1] ' + M.secretAuto + ' auto-injected secret body</memory-context>' }],
      },
    },
    // 4. Ordinary automatic recall: same plugin-message shape, different form.
    {
      type: 'user/message',
      data: {
        source: { kind: 'plugin:dsh-memu-memory', form: 'recall' },
        content: [{ type: 'text', text: '<memory-context scope="private">- [pmem-2] ' + M.recallPlain + ' ordinary private body</memory-context>' }],
      },
    },
    // 6. The user's own words.
    {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: M.user + ' the user original words' }] },
    },
    // 5 + 3. Assistant paraphrase and the recall query it issued.
    {
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'text', text: M.assistant + ' assistant paraphrase' },
            { type: 'tool-call', name: 'memu_private_recall', arguments: JSON.stringify({ query: M.toolArgs, visibility: 'secret' }) },
          ],
        },
      },
    },
    // 2. The result of that explicit recall (a secret entry body).
    {
      type: 'tool/result',
      data: { message: { content: [{ type: 'text', text: M.recallSecret + ' explicit recall of a secret entry' }] } },
    },
    // 3b. The host's standalone tool/call event shape.
    {
      type: 'tool/call',
      data: { name: 'memu_private_remember', arguments: JSON.stringify({ content: M.toolArgs }) },
    },
    // Not a channel: a long tool result is cut at 400 chars, so this tail dies.
    {
      type: 'tool/result',
      data: { message: { content: [{ type: 'text', text: 'x'.repeat(500) + M.toolTail }] } },
    },
  ]
}

function sessionQueryFor(events) {
  return {
    listSessions: async () => [{ header: HEADER, live: false }],
    readTitleSnapshots: async () => [],
    readSession: async (id) => {
      assert.equal(id, HEADER.id)
      return { session: HEADER, events, inheritedEventCount: 0 }
    },
  }
}

function ctxFor(events, onActivation) {
  const parent = { id: 'parent', session: { header: { cwd: path.join(home, 'project') } } }
  return {
    get(name) {
      if (name === 'sessionQuery') return sessionQueryFor(events)
      if (name === 'agents') return { get: (id) => (id === 'parent' ? parent : undefined) }
      if (name === 'subagents') return { startActivation: onActivation }
      return undefined
    },
  }
}

function promptInput(prompt) {
  // The template ends with the pretty-printed JSON input.
  const start = prompt.lastIndexOf('{\n  "sessions"')
  assert.ok(start >= 0, 'the curator prompt should embed the JSON input')
  return JSON.parse(prompt.slice(start))
}

async function waitJob(id) {
  for (let i = 0; i < 200; i += 1) {
    const job = getCurationJob(id)
    if (job && job.status !== 'running') return job
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('curation job did not settle')
}

function seedGlobalIndex() {
  saveGlobalIndex({
    version: 1,
    entries: {
      'gmem-existing': {
        track: 'memory', domain: 'general', title: 'Existing global entry',
        content: M.existing + ' already in the global index',
        confidence: 0.9, status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        evidence: [{ sessionId: 'older', quote: 'older' }],
      },
      'gmem-archived': {
        track: 'memory', domain: 'general', title: 'Archived global entry',
        content: M.archived + ' archived entry', confidence: 0.9, status: 'archived',
      },
      'gmem-pending': {
        track: 'memory', domain: 'general', title: 'Pending global entry',
        content: M.pending + ' pending entry', confidence: 0.5, status: 'pending_review',
      },
    },
  })
}

test('probe writes only under the DSH_MEMU_HOME temp root', () => {
  assert.equal(path.resolve(dataDir()), path.resolve(home))
  assert.ok(path.resolve(dataDir()).startsWith(path.resolve(os.tmpdir()) + path.sep))
})

test('condenseEvents keeps user/assistant/tool shapes and drops every plugin message', () => {
  const transcript = condenseEvents(probeEvents())
  const reached = new Map(CHANNELS.map((channel) => [channel.key, transcript.includes(M[channel.key])]))
  assert.deepEqual([...reached.values()], CHANNELS.map((channel) => channel.layers[0]))
  assert.ok(transcript.startsWith('User: ' + M.user), 'the user original words survive')
  assert.ok(!transcript.includes('memory-context'), 'plugin message wrappers are dropped whole')
  assert.equal((transcript.match(new RegExp(M.toolArgs, 'g')) || []).length, 2,
    'both tool-call argument shapes survive')
  assert.ok(!transcript.includes(M.toolTail), 'tool results are cut at 400 chars')
})

test('six channels, layer by layer: transcript -> prompt -> simulated output -> committed index', async (t) => {
  seedGlobalIndex()
  const events = probeEvents()
  let captured = null
  let outputText = ''

  const onActivation = async (spec) => {
    captured = spec
    const input = promptInput(spec.request.prompt[0].text)
    const transcript = input.sessions[0].transcript
    const existing = JSON.stringify(input.existing_global_index)
    // A strict copy-through model: it can only echo markers that its prompt
    // actually contains. Anything absent from the prompt is not invented here;
    // the provenance-blind commit path is covered by the next test.
    const memories = []
    for (const [key, value] of Object.entries(M)) {
      if (key === 'credential') continue
      if (!transcript.includes(value) && !existing.includes(value)) continue
      memories.push({
        op: 'create', domain: 'general', track: 'memory',
        title: 'Copied ' + key,
        content: 'curator copied ' + value + ' from its input',
        confidence: 0.8,
        evidence: [{ session_id: HEADER.id, quote: value }],
      })
    }
    const output = {
      sessions: [{ id: HEADER.id, domain: 'other', reason: 'synthetic' }],
      memories,
      domain_summary: { general: 'synthetic' },
      skipped: [],
    }
    outputText = JSON.stringify(output)
    return {
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: outputText }] }),
      dispose: async () => {},
    }
  }

  const queued = startGlobalCuration(ctxFor(events, onActivation), {
    sessionIds: [HEADER.id], parentSessionId: 'parent',
  })
  const job = await waitJob(queued.id)
  assert.equal(job.status, 'completed', job.error || '')

  assert.ok(captured, 'startGlobalCuration should reach subagents.startActivation')
  assert.equal(captured.provider, 'spawn')
  assert.equal(captured.delivery, 'caller')
  assert.equal(captured.request.prompt.length, 1)
  assert.equal(captured.request.parent.session.header.cwd, path.join(home, 'project'))

  const prompt = captured.request.prompt[0].text
  assert.match(prompt, /全局记忆提炼任务/)
  const input = promptInput(prompt)
  assert.deepEqual(Object.keys(input).sort(), ['existing_global_index', 'sessions'])
  assert.equal(input.sessions.length, 1)
  assert.deepEqual(
    Object.keys(input.sessions[0]).sort(),
    ['agentPreset', 'createdAt', 'cwd', 'id', 'live', 'title', 'transcript'],
  )
  const transcript = input.sessions[0].transcript
  assert.equal(transcript, condenseEvents(events, 14000), 'the prompt must carry the condensed transcript itself')
  assert.equal(input.sessions[0].live, false)
  assert.equal(input.sessions[0].title, HEADER.title)
  assert.equal(input.sessions[0].cwd, path.join(home, 'project'))
  assert.equal(input.sessions[0].agentPreset, 'coding')

  // existing_global_index: archived entries are filtered out, pending_review stays.
  const existingIds = input.existing_global_index.map((entry) => entry.id)
  assert.ok(existingIds.includes('gmem-existing'))
  assert.ok(existingIds.includes('gmem-pending'))
  assert.ok(!existingIds.includes('gmem-archived'))
  const existingJson = JSON.stringify(input.existing_global_index)
  assert.match(existingJson, new RegExp(M.existing))
  assert.match(existingJson, new RegExp(M.pending))
  assert.doesNotMatch(existingJson, new RegExp(M.archived))
  assert.match(prompt, new RegExp(M.existing))
  assert.doesNotMatch(prompt, new RegExp(M.archived))

  const committedJson = JSON.stringify(loadGlobalIndex())
  const rows = CHANNELS.map((channel) => ({
    channel: channel.key,
    shape: channel.shape,
    transcript: transcript.includes(M[channel.key]),
    prompt: prompt.includes(M[channel.key]),
    output: outputText.includes(M[channel.key]),
    committed: committedJson.includes(M[channel.key]),
  }))
  t.diagnostic('W5 channel matrix ' + JSON.stringify(rows))
  assert.deepEqual(
    rows.map((row) => [row.transcript, row.prompt, row.output, row.committed]),
    CHANNELS.map((channel) => channel.layers),
  )

  // The simulated model echoed only what reached the prompt: four transcript
  // channels plus the two visible existing-index entries.
  assert.equal(job.result.created, 6)
  for (const key of ['user', 'assistant', 'toolArgs', 'recallSecret', 'existing', 'pending']) {
    const entry = Object.values(loadGlobalIndex().entries).find((item) => item.title === 'Copied ' + key)
    assert.ok(entry, 'expected a committed entry copied from ' + key)
    assert.equal(entry.status, 'active')
    assert.match(entry.content, new RegExp(M[key]))
  }
  const secretEntry = Object.values(loadGlobalIndex().entries).find((item) => item.title === 'Copied recallSecret')
  assert.match(JSON.stringify(secretEntry.evidence), new RegExp(M.recallSecret))
  for (const key of ['secretAuto', 'recallPlain', 'toolTail', 'archived', 'modelOnly', 'invalidDomain']) {
    assert.equal(
      Object.values(loadGlobalIndex().entries).some((item) => item.title === 'Copied ' + key),
      false,
      'no entry should be copied from ' + key,
    )
  }
})

test('commit accepts model output without provenance or secret filtering', async () => {
  saveGlobalIndex({ version: 1, entries: {} })
  const output = {
    memories: [
      {
        op: 'create', domain: 'general', track: 'memory', title: 'Active from tool result',
        content: 'copied: ' + M.recallSecret, confidence: 0.9,
        evidence: [{ session_id: 'probe-session', quote: M.recallSecret }],
      },
      {
        op: 'create', domain: 'general', track: 'memory', title: 'Held for review',
        content: 'no evidence supplied', confidence: 0.9, evidence: [],
      },
      {
        op: 'create', domain: 'not-a-domain', track: 'memory', title: 'Invalid domain',
        content: M.invalidDomain, evidence: [{ session_id: 'probe-session', quote: 'q' }],
      },
      {
        op: 'create', domain: 'general', track: 'memory', title: 'Secret flagged',
        content: 'secret-marked but accepted: ' + M.recallSecret,
        visibility: 'secret',
        source: { kind: 'plugin:dsh-memu-memory', form: 'recall' },
        confidence: 0.9,
        evidence: [{ session_id: 'probe-session', quote: M.recallSecret }],
      },
      {
        op: 'create', domain: 'general', track: 'memory', title: 'Model-only provenance',
        content: 'never appeared in the prompt: ' + M.modelOnly,
        confidence: 0.9,
        evidence: [{ session_id: 'probe-session', quote: 'invented' }],
      },
      {
        op: 'create', domain: 'general', track: 'memory', title: 'Credential shaped',
        content: 'api key: ' + M.credential,
        confidence: 0.9,
        evidence: [{ session_id: 'probe-session', quote: 'q' }],
      },
    ],
  }
  const result = await commitCuratorOutput(output, { job: { step: 'committing' } })
  assert.equal(result.created, 4)
  assert.equal(result.pending, 1)
  assert.equal(result.skipped.length, 1)
  assert.match(result.skipped[0].reason, /invalid domain/)

  const index = loadGlobalIndex()
  const entries = Object.values(index.entries)
  assert.equal(entries.length, 5)
  const active = entries.find((entry) => entry.title === 'Active from tool result')
  assert.equal(active.status, 'active')
  const secret = entries.find((entry) => entry.title === 'Secret flagged')
  assert.equal(secret.status, 'active')
  assert.equal(Object.hasOwn(secret, 'visibility'), false)
  const held = entries.find((entry) => entry.title === 'Held for review')
  assert.equal(held.status, 'pending_review')
  assert.match(held.reviewReason, /missing evidence/)
  const modelOnly = entries.find((entry) => entry.title === 'Model-only provenance')
  assert.match(modelOnly.content, new RegExp(M.modelOnly))
  const credential = entries.find((entry) => entry.title === 'Credential shaped')
  assert.match(credential.content, /\[REDACTED_KEY\]/)
  assert.doesNotMatch(credential.content, new RegExp(M.credential))
  assert.doesNotMatch(JSON.stringify(index), new RegExp(M.invalidDomain))
})

test('condense keeps private prose; redaction only covers credential-shaped strings', () => {
  const text = condenseEvents([
    {
      type: 'tool/result',
      data: { message: { content: [{ type: 'text', text: M.recallSecret + ' Authorization: Bearer abcdefghijklmnopqrstuvwxyz' }] } },
    },
  ])
  assert.match(text, new RegExp(M.recallSecret))
  assert.match(text, /Bearer \[REDACTED_KEY\]/)
  assert.doesNotMatch(text, /abcdefghijklmnopqrstuvwxyz/)
})
