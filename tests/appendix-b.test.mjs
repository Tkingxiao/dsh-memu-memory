import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-appb-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const inject = await import('../lib/inject.js')
const mood = await import('../lib/mood.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function execFor(sessionId, cwd) {
  return { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding' } } } }
}

function setup(name) {
  const cwd = path.join(home, 'proj-' + name)
  const sessionId = 'appb-' + name
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  return { cwd, sessionId, binding, exec: execFor(sessionId, cwd) }
}

// ---- source: default, explicit, and illegal ----

test('source defaults to inferred, not user_said', async () => {
  const { exec, binding } = setup('source')
  const { id } = await memory.privateRemember({ exec, content: 'The build script probably wipes dist before bundling.', title: 'build wipe' })
  const entry = state.loadPrivateIndex(binding.libraryId).entries[id]
  // Defaulting to user_said made every model conclusion read as a quotable quote.
  assert.equal(entry.source, 'inferred')

  const quoted = await memory.privateRemember({ exec, content: 'He said the ledger lives in docs/ledger.md.', title: 'ledger', source: 'user_said' })
  assert.equal(state.loadPrivateIndex(binding.libraryId).entries[quoted.id].source, 'user_said')
})

test('an unknown source is refused instead of stored', async () => {
  const { exec } = setup('source-bad')
  await assert.rejects(
    () => memory.privateRemember({ exec, content: 'x', title: 'x', source: 'user-stated' }),
    /source must be/,
  )
})

// ---- cue derivation ----

test('cue candidates skip side-event, unspeakable, secret, and too-new entries', async () => {
  const { sessionId, binding, exec } = setup('candidates')
  const old = new Date(Date.now() - 40 * 3600_000).toISOString()
  const keep = await memory.privateRemember({ exec, content: 'The hiss of the kettle at four in the morning.', title: 'kettle' })
  // A cue-born memory is a side_event pin, which the host only accepts while that
  // exact cue is still alive — so the cue has to be armed first.
  state.armCue(sessionId, { id: 'cue-seed', text: 'a seed cue', createdAt: new Date().toISOString() })
  const fromCue = await memory.privateRemember({
    exec, content: 'A memory born of a cue.', title: 'born',
    layer: 'must_remember', pinReason: '它一直挥之不去，我放不下那只杯子。', pinSource: 'side_event', sideEventId: 'cue-seed',
  })
  const silent = await memory.privateRemember({ exec, content: 'Cannot be told.', title: 'silent', disclosure: 'never_say' })
  const secret = await memory.privateRemember({ exec, content: 'Hidden body.', title: 'secret', visibility: 'secret' })
  const fresh = await memory.privateRemember({ exec, content: 'Just written a moment ago.', title: 'fresh' })

  // Age everything so the 12h gate is what decides, except the fresh one.
  const index = state.loadPrivateIndex(binding.libraryId)
  for (const id of [keep.id, fromCue.id, silent.id, secret.id]) index.entries[id].updatedAt = old
  state.savePrivateIndex(binding.libraryId, index)

  const ids = memory.cueCandidates({ libraryId: binding.libraryId, sessionId }).map((c) => c.id)
  assert.ok(ids.includes(keep.id))
  assert.ok(!ids.includes(fromCue.id), 'a cue-born memory must not become a cue source')
  assert.ok(!ids.includes(silent.id), 'disclosure never_say cannot surface as a cue')
  assert.ok(!ids.includes(secret.id))
  assert.ok(!ids.includes(fresh.id), 'a memory needs some age before it can echo')

  // skipIds has to win over everything else.
  const skipped = memory.cueCandidates({ libraryId: binding.libraryId, sessionId, skipIds: [keep.id] }).map((c) => c.id)
  assert.ok(!skipped.includes(keep.id))
})

test('cue candidates put the least-used memory first', async () => {
  const { sessionId, binding, exec } = setup('order')
  const old = new Date(Date.now() - 40 * 3600_000).toISOString()
  const used = await memory.privateRemember({ exec, content: 'The noisy one.', title: 'used' })
  const quiet = await memory.privateRemember({ exec, content: 'The quiet one.', title: 'quiet' })
  const index = state.loadPrivateIndex(binding.libraryId)
  index.entries[used.id].updatedAt = old
  index.entries[quiet.id].updatedAt = old
  index.entries[used.id].accessCount = 9
  index.entries[used.id].injectCount = 4
  state.savePrivateIndex(binding.libraryId, index)

  const ids = memory.cueCandidates({ libraryId: binding.libraryId, sessionId }).map((c) => c.id)
  assert.equal(ids[0], quiet.id, 'an echo is more interesting when it was forgotten')
})

test('deriveCue returns a memory-backed cue, or null when it has nothing', async () => {
  const { sessionId, binding } = setup('derive')
  assert.deepEqual(inject.deriveCue({ libraryId: null }, sessionId), null)
  assert.deepEqual(inject.deriveCue({ libraryId: binding.libraryId, useLibrary: false }, sessionId), null)
  assert.deepEqual(inject.deriveCue(binding, sessionId), null, 'no aged memory means no derived cue')

  const exec = execFor(sessionId, path.join(home, 'proj-derive'))
  const { id } = await memory.privateRemember({ exec, content: 'The cat knocked the cup off the desk and just watched it fall.', title: 'the cup' })
  const index = state.loadPrivateIndex(binding.libraryId)
  index.entries[id].updatedAt = new Date(Date.now() - 30 * 3600_000).toISOString()
  state.savePrivateIndex(binding.libraryId, index)

  const cue = inject.deriveCue(binding, sessionId)
  assert.ok(cue, 'an aged memory should be derivable')
  assert.equal(cue.sourceId, id)
  assert.match(cue.id, /^cue-/)
  assert.ok(cue.text.includes('knocked the cup'), 'the cue quotes the memory, not a fixed sentence')
  assert.ok(!inject.CUE_TEXTS.includes(cue.text))
  assert.ok(cue.recallQuery.includes('the cup'))
})

test('maybeCue arms the cue with its source and returns related ids', async () => {
  const { sessionId, binding } = setup('maybe')
  state.updateSettings({ randomCueChance: 1 })
  const exec = execFor(sessionId, path.join(home, 'proj-maybe'))
  const { id } = await memory.privateRemember({ exec, content: 'The lamp buzzed all evening and nobody fixed it.', title: 'the lamp' })
  const index = state.loadPrivateIndex(binding.libraryId)
  index.entries[id].updatedAt = new Date(Date.now() - 30 * 3600_000).toISOString()
  state.savePrivateIndex(binding.libraryId, index)

  const out = await inject.maybeCue({ sessionId, turn: 2, settings: { ...state.getSettings(), randomCueChance: 1 }, binding, exec })
  assert.ok(out && typeof out.text === 'string')
  assert.ok(Array.isArray(out.ids))
  const armed = state.getActiveCue(sessionId)
  assert.equal(armed.sourceId, id, 'the cue records where it came from')
  assert.ok(armed.recallQuery.includes('lamp'))
  assert.ok(out.text.includes('这不是用户说的话'), 'a derived cue says so instead of claiming a random sense impression')
})

test('maybeCue falls back to a fixed sentence when no memory qualifies', async () => {
  const { sessionId, binding } = setup('fallback')
  const out = await inject.maybeCue({ sessionId, turn: 2, settings: { ...state.getSettings(), randomCueChance: 1 }, binding, exec: null })
  assert.ok(inject.CUE_TEXTS.some((t) => out.text.includes(t)), 'the fixed pool still backs the feature')
  const armed = state.getActiveCue(sessionId)
  assert.equal(armed.sourceId, null)
})

// ---- arousal in retrieval ----

test('a tense room pulls charged memories further ahead than a quiet one', async () => {
  const { sessionId, exec } = setup('arousal')
  // 两条正文词面不同（dice 0.512，低于 TOPIC_DICE）：事实级去重上线后，同文改标题的
  // 旧写法会被写入侧打标/召回侧折叠，唤醒度因子就测不到了。语义并行 + 显式 arousal
  // 仍然隔离这个因子。
  const calm = await memory.privateRemember({
    exec, content: 'The hallway smelled of rain on warm stone.', title: 'hallway calm', arousal: 0.1, moodValence: 0.05,
  })
  const loud = await memory.privateRemember({
    exec, content: 'Rain hammered the hallway stones while voices echoed off the walls.', title: 'hallway loud', arousal: 0.95, moodValence: 0.05,
  })

  async function gapAt(arousal) {
    state.setSessionMood(sessionId, { valence: 0, arousal })
    const out = await memory.privateRecall({ exec, query: 'hallway rain stone', topK: 2, relevanceThreshold: 0 })
    const byId = new Map((out.files || []).map((f) => [f.name, f.score]))
    assert.deepEqual(new Set(byId.keys()), new Set([calm.id, loud.id]), 'both stay in range: arousal only reorders')
    return byId.get(loud.id) / byId.get(calm.id)
  }

  const tense = await gapAt(0.95)
  const quiet = await gapAt(0.1)
  // The factor is bounded, so it must never invert the ranking — it only changes
  // how far ahead the charged memory sits.
  assert.ok(tense > 1 && quiet > 1, 'the charged memory wins in both rooms')
  assert.ok(tense > quiet, 'a tense present favours the charged memory more than a calm one')
})

test('arousal cannot outrank a clearly better semantic hit', async () => {
  const { sessionId, exec } = setup('arousal-weak')
  const relevant = await memory.privateRemember({
    exec, content: 'The deployment key is stored in the vault under dsh-memu-memory-prod.', title: 'deployment key', arousal: 0.05,
  })
  const charged = await memory.privateRemember({
    exec, content: 'A door slammed somewhere in the building.', title: 'a door', arousal: 1, peak: true,
  })
  state.setSessionMood(sessionId, { valence: 0, arousal: 1 })
  const out = await memory.privateRecall({ exec, query: 'where is the deployment key for dsh-memu-memory-prod', topK: 2, relevanceThreshold: 0 })
  const ids = (out.files || []).map((f) => f.name)
  assert.equal(ids[0], relevant.id, 'intensity is a nudge, not a trump card')
  assert.ok(ids.includes(charged.id))
})

test('a mood that is tense but neither good nor bad still counts as a mood', async () => {
  const { sessionId, exec } = setup('tense')
  // 正文词面不同（dice 0.514）：同文会被事实级去重拒绝，这里改写保持语义并行。
  const flat = await memory.privateRemember({ exec, content: 'The invoice is due on the fourteenth.', title: 'invoice', arousal: 0.1, moodValence: 0 })
  const edge = await memory.privateRemember({ exec, content: 'The invoice payment must arrive by the fourteenth without fail.', title: 'invoice edge', arousal: 0.9, moodValence: 0 })
  // valence is exactly neutral here, so without the arousal gate this room would be
  // treated as "no mood at all" and arousal would never reach recallScore.
  state.setSessionMood(sessionId, { valence: 0, arousal: 0.9 })
  const tense = await memory.privateRecall({ exec, query: 'invoice due fourteenth', topK: 2, relevanceThreshold: 0 })
  const tenseScores = new Map((tense.files || []).map((f) => [f.name, f.score]))
  assert.deepEqual(new Set(tenseScores.keys()), new Set([flat.id, edge.id]))
  const ratio = tenseScores.get(edge.id) / tenseScores.get(flat.id)

  state.setSessionMood(sessionId, { valence: 0, arousal: 0.1 })
  const calm = await memory.privateRecall({ exec, query: 'invoice due fourteenth', topK: 2, relevanceThreshold: 0 })
  const calmScores = new Map((calm.files || []).map((f) => [f.name, f.score]))
  const calmRatio = calmScores.get(edge.id) / calmScores.get(flat.id)
  assert.ok(ratio > calmRatio, 'the tense read widens the same gap')
})

test('BASE_AROUSAL is exported and is a real baseline, not zero', () => {
  assert.equal(typeof mood.BASE_AROUSAL, 'number')
  assert.ok(mood.BASE_AROUSAL > 0 && mood.BASE_AROUSAL < 1)
})
