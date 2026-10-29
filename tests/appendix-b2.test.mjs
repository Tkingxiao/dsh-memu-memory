import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-appb2-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const inject = await import('../lib/inject.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function execFor(sessionId, cwd) {
  return { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding' } } } }
}

function setup(name) {
  const cwd = path.join(home, 'proj-' + name)
  const sessionId = 'appb2-' + name
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  return { cwd, sessionId, binding, exec: execFor(sessionId, cwd) }
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString()
}

// ---- 10: negativity bias and self-reference stretch the half-life ----

test('an unpleasant memory fades slower than a neutral one of the same age', () => {
  const plain = { layer: 'long_term', strength: 1, createdAt: daysAgo(60), moodValence: 0 }
  const sore = { layer: 'long_term', strength: 1, createdAt: daysAgo(60), moodValence: -0.9 }
  // Both change how long it lives, never the score today.
  assert.ok(memory.decayStrength(sore) > memory.decayStrength(plain))
  assert.ok(memory.negativityBias(plain) === 1, 'a neutral memory gets no bonus')
  assert.ok(memory.negativityBias(sore) > 1 && memory.negativityBias(sore) <= 1.3)
  assert.ok(memory.negativityBias({ moodValence: -0.05 }) === 1, 'a trace of displeasure is not a bias')
})

test('memories about me or us outlive memories about the world', () => {
  // Kept well inside the 14-day half-life, or the 0.05 floor flattens the difference.
  const theirs = { layer: 'long_term', strength: 1, createdAt: daysAgo(10), owner: 'them' }
  const mine = { layer: 'long_term', strength: 1, createdAt: daysAgo(10), owner: 'me' }
  const ours = { layer: 'long_term', strength: 1, createdAt: daysAgo(10), owner: 'us' }
  assert.ok(memory.decayStrength(mine) > memory.decayStrength(theirs))
  assert.ok(memory.decayStrength(ours) > memory.decayStrength(theirs))
  assert.equal(memory.selfReferenceBias({ owner: 'them' }), 1)
})

// ---- 11: a pinned memory still fades, and the tip-of-the-tongue effect ----

test('must_remember decays on a one-year half-life but never below the floor', () => {
  const fresh = { layer: 'must_remember', strength: 1, createdAt: daysAgo(0) }
  const twoYears = { layer: 'must_remember', strength: 1, createdAt: daysAgo(730) }
  const tenYears = { layer: 'must_remember', strength: 1, createdAt: daysAgo(3650) }
  assert.ok(Math.abs(memory.decayStrength(fresh) - 1) < 1e-7)
  assert.ok(memory.decayStrength(twoYears) < 1, 'permanent stopped meaning verbatim forever')
  assert.ok(memory.decayStrength(tenYears) >= 0.35, 'the floor keeps a pin from evaporating')
})

test('tip-of-tongue is about reachability, not importance', () => {
  assert.equal(memory.isTipOfTongue({ layer: 'must_remember', confidence: 0.1 }), false, 'a pin is never half-remembered')
  assert.equal(memory.isTipOfTongue({ layer: 'long_term', marginalized: true, confidence: 0.9 }), true)
  assert.equal(memory.isTipOfTongue({ layer: 'long_term', confidence: 0.3 }), true)
  assert.equal(memory.isTipOfTongue({ layer: 'long_term', confidence: 0.9, strength: 1, createdAt: daysAgo(1) }), false)
})

test('injection gives the gist, not the wording, when a memory is half-remembered', async () => {
  const { sessionId, binding, exec } = setup('tongue')
  const content = '周四晚上在厨房，他一边擦杯子一边说那句关于不要再改需求的话，说完就把杯子放回架子上，转身去阳台抽了一支烟，很久都没有再开口，客厅的电视一直在放同一档节目。'
  const saved = await memory.privateRemember({ exec, content, title: '厨房里那句话', confidence: 0.3 })
  const index = state.loadPrivateIndex(binding.libraryId)
  index.entries[saved.id].confidence = 0.3
  state.savePrivateIndex(binding.libraryId, index)

  const out = await inject.buildRecall(binding, '厨房 那句话', 1, { ...state.getSettings(), privateTopK: 3, relevanceThreshold: 0 }, exec, sessionId)
  assert.ok(out.text.includes('只记得大概'), 'the model is told it only remembers the gist')
  assert.ok(!out.text.includes('客厅的电视一直在放同一档节目'), 'the exact wording must not be handed over as if quoted')
  assert.ok(out.text.includes(saved.id), 'the id and the tool are how the original is still reachable')
})

// ---- 12: fading affect bias ----

test('a bad feeling goes neutral faster than a good one', () => {
  const grudge = { moodValence: -0.8, updatedAt: daysAgo(60) }
  const fondness = { moodValence: 0.8, updatedAt: daysAgo(60) }
  const fadedGrudge = Math.abs(memory.fadedValence(grudge))
  const fadedFondness = Math.abs(memory.fadedValence(fondness))
  assert.ok(fadedGrudge < fadedFondness, 'the event stays, the sting fades')
  assert.ok(fadedGrudge < 0.2)
  // Fresh memories keep their colour.
  assert.ok(Math.abs(memory.fadedValence({ moodValence: -0.8, updatedAt: daysAgo(0) }) - -0.8) < 0.05)
})

// ---- 13: vividness is not accuracy ----

test('high arousal discounts accuracy while leaving confidence alone', () => {
  const calm = memory.accuracyOf({ peak: false, arousal: 0.2, confidence: 0.9 })
  assert.equal(calm, 0.9, 'an ordinary memory is as accurate as it is confident')
  const flash = memory.accuracyOf({ peak: true, arousal: 0.95, confidence: 0.9 })
  assert.ok(flash < calm, 'a flashbulb memory is vivid, not precise')
  assert.ok(flash >= 0.2)
  assert.equal(memory.accuracyOf({ peak: true, arousal: 0.95, confidence: 0.1 }), 0.2, 'the floor is 0.2')
})

test('a remembered memory stores accuracy next to confidence', async () => {
  const { exec, binding } = setup('accuracy')
  const saved = await memory.privateRemember({
    exec, content: 'The siren woke the whole street at 3am.', title: 'the siren', peak: true, arousal: 0.95, confidence: 0.9,
  })
  const entry = state.loadPrivateIndex(binding.libraryId).entries[saved.id]
  assert.equal(entry.confidence, 0.9)
  assert.ok(entry.accuracy < entry.confidence)
})

// ---- 14: contradiction detection inside one library ----

test('a same-title rewrite is queued for review instead of being appended', async () => {
  const { exec, binding } = setup('conflict-same')
  const first = await memory.privateRemember({ exec, content: '部署密钥放在 vault 里的 dsh-memu-memory-prod 下面。', title: '部署密钥位置' })
  const second = await memory.privateRemember({ exec, content: '部署密钥改成放在 1Password 的 ops 保险库里了。', title: '部署密钥位置' })
  const entry = state.loadPrivateIndex(binding.libraryId).entries[second.id]
  assert.equal(entry.status, 'pending_review', 'two answers to one question cannot both be active')
  assert.equal(entry.conflictingWith, first.id)
  assert.match(entry.reviewReason, /同题/)
  assert.equal(second.conflict, first.id)
})

test('a flipped claim is caught even under a different title', async () => {
  const { exec, binding } = setup('conflict-negation')
  const first = await memory.privateRemember({ exec, content: 'We always deploy on Friday afternoons.', title: 'deploy window' })
  const second = await memory.privateRemember({ exec, content: 'We never deploy on Friday afternoons.', title: 'release rule' })
  const entry = state.loadPrivateIndex(binding.libraryId).entries[second.id]
  assert.equal(entry.status, 'pending_review')
  assert.equal(entry.conflictingWith, first.id)
  assert.match(entry.reviewReason, /相反/)
})

test('unrelated memories are not flagged', async () => {
  const { exec, binding } = setup('conflict-clean')
  await memory.privateRemember({ exec, content: '他喜欢周五下午整理下周计划。', title: '周五习惯' })
  const other = await memory.privateRemember({ exec, content: 'The kettle in the office kitchen boils slowly.', title: 'the kettle' })
  const entry = state.loadPrivateIndex(binding.libraryId).entries[other.id]
  assert.equal(entry.status, 'active', 'a heuristic this loose would bury the queue in noise')
  assert.equal(other.conflict, null)
})

test('a claim under review never reaches the prompt or a recall', async () => {
  const { exec, binding } = setup('pending-hidden')
  await memory.privateRemember({ exec, content: 'We always deploy on Friday afternoons.', title: 'deploy window' })
  const second = await memory.privateRemember({ exec, content: 'We never deploy on Friday afternoons.', title: 'deploy window' })
  assert.equal(second.entry.status, 'pending_review')
  const anchor = inject.buildAnchor(binding, state.getSettings(), null)
  // Both halves of a contradiction in one prompt is worse than neither: the model
  // would pick a side and sound certain about it.
  assert.ok(!anchor.text.includes('never deploy'), 'a pending entry stays out of the anchor')
  assert.ok(!anchor.ids.includes(second.id))
  const recall = await inject.buildRecall(binding, 'deploy on Friday', 3, state.getSettings(), exec, null)
  assert.ok(!recall.ids.includes(second.id), 'and out of the recall list')
  assert.ok(!String(recall.text).includes('never deploy'))
})
