import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-short-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const inject = await import('../lib/inject.js')
const privateMod = await import('../lib/private.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function execFor(sessionId, cwd) {
  return { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding' } } } }
}

function rewindDeadline(libraryId, id, ms = 60_000) {
  const index = state.loadPrivateIndex(libraryId)
  index.entries[id].expiresAt = new Date(Date.now() - ms).toISOString()
  state.savePrivateIndex(libraryId, index)
}

test('short_term writes carry a deadline, and the sweep expires them instead of deleting', async () => {
  const cwd = path.join(home, 'proj-ttl')
  const sessionId = 'short-ttl'
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const exec = execFor(sessionId, cwd)

  const { id, entry } = await memory.privateRemember({
    exec,
    content: 'Staging token rotation is due Friday.',
    title: 'staging token rotation',
    layer: 'short_term',
  })
  assert.equal(entry.layer, 'short_term')
  const hours = (Date.parse(entry.expiresAt) - Date.now()) / 3_600_000
  assert.ok(hours > 71 && hours <= 72, `expected a ~72h deadline, got ${hours}`)

  rewindDeadline(binding.libraryId, id)
  const sweep = memory.expireShortTerm()
  assert.ok(sweep.expired.some((row) => row.id === id), 'the sweep must pick up the past-due entry')

  const after = state.loadPrivateIndex(binding.libraryId).entries[id]
  assert.equal(after.status, 'expired')
  assert.ok(after.content.includes('Staging token rotation'), 'the body survives — promotion is still possible from the archive view')
})

test('an expired short_term entry leaves the anchor and the recall path', async () => {
  const cwd = path.join(home, 'proj-gone')
  const sessionId = 'short-gone'
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const exec = execFor(sessionId, cwd)

  const { id } = await memory.privateRemember({
    exec,
    content: 'The migration checklist lives in docs/migrate.md.',
    title: 'migration checklist',
    layer: 'short_term',
  })
  const before = inject.buildAnchor(binding, { ...state.getSettings(), anchorTokens: 700 })
  assert.ok(before.pointerIds.includes(id))
  const recalled = await memory.privateRecall({ exec, query: 'migration checklist', topK: 5 })
  assert.ok(recalled.files.some((file) => file.name === id))

  // Expired by the clock alone, before any sweep has run: the deadline itself has
  // to be authoritative, otherwise a dead draft rides along for up to five minutes.
  rewindDeadline(binding.libraryId, id, 1_000)
  const after = inject.buildAnchor(binding, { ...state.getSettings(), anchorTokens: 700 })
  assert.equal(after.pointerIds.includes(id), false)
  assert.equal(after.text.includes(id), false)
  const recalledAgain = await memory.privateRecall({ exec, query: 'migration checklist', topK: 5 })
  assert.equal(recalledAgain.files.some((file) => file.name === id), false)
})

test('the anchor shows short_term as a pointer card, never as body text', async () => {
  const cwd = path.join(home, 'proj-card')
  const sessionId = 'short-card'
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const exec = execFor(sessionId, cwd)

  const { id } = await memory.privateRemember({
    exec,
    content: 'BODY-MARKER: the whole argument about the pricing page, in detail.',
    title: 'pricing thread',
    layer: 'short_term',
  })
  const anchor = inject.buildAnchor(binding, { ...state.getSettings(), anchorTokens: 700 })
  assert.ok(anchor.text.includes('[recent · short_term]'))
  assert.ok(anchor.text.includes(`[${id}]`))
  assert.ok(anchor.text.includes('pricing thread'))
  assert.ok(anchor.text.includes('小时后过期'))
  assert.equal(anchor.text.includes('BODY-MARKER'), false, 'switching conversations must not inject the previous conversation')
  // A pointer is not content, so it must not be marked as already injected: that
  // would suppress the first real recall of a memory the model was only told about.
  assert.equal(anchor.ids.includes(id), false)
})

test('promoting a short_term draft clears its deadline; must_remember stays out of update', async () => {
  const cwd = path.join(home, 'proj-promote')
  const sessionId = 'short-promote'
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const exec = execFor(sessionId, cwd)

  const { id } = await memory.privateRemember({
    exec,
    content: 'He said the anniversary matters more than the launch date.',
    title: 'anniversary over launch',
    layer: 'short_term',
  })
  const promoted = await memory.privateUpdate({ exec, id, layer: 'long_term' })
  assert.equal(promoted.entry.layer, 'long_term')
  assert.equal(promoted.entry.expiresAt, undefined)
  assert.equal(promoted.entry.promotedFrom, 'short_term')
  assert.equal(promoted.entry.status, 'active')

  rewindDeadline(binding.libraryId, id, 1_000)
  const sweep = memory.expireShortTerm()
  assert.equal(sweep.expired.some((row) => row.id === id), false, 'a promoted entry is no longer on a clock')

  await assert.rejects(
    () => memory.privateUpdate({ exec, id, layer: 'must_remember' }),
    /pin_reason/,
  )
})

test('the idle pass is told which drafts are about to expire', async () => {
  const cwd = path.join(home, 'proj-brief')
  const sessionId = 'short-brief'
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const exec = execFor(sessionId, cwd)

  const { id } = await memory.privateRemember({
    exec,
    content: 'We were still deciding whether to ship on Monday.',
    title: 'ship date undecided',
    layer: 'short_term',
  })
  const brief = privateMod.shortTermBrief(state.getSessionBinding(sessionId))
  assert.ok(brief.includes('[short_term · 快到期了]'))
  assert.ok(brief.includes(id))
  assert.ok(brief.includes('memu_private_update'))
  const prompt = privateMod.buildPrivateConsolidationPrompt(sessionId)
  assert.ok(prompt.includes(id), 'the consolidation prompt must carry the decision list')
})

test('with shortTermTtlHours=0 the layer is closed instead of silently permanent', async () => {
  const cwd = path.join(home, 'proj-off')
  const sessionId = 'short-off'
  state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const exec = execFor(sessionId, cwd)
  state.updateSettings({ shortTermTtlHours: 0 })
  try {
    await assert.rejects(
      () => memory.privateRemember({ exec, content: 'Temporary note.', layer: 'short_term' }),
      /disabled/,
    )
  } finally {
    state.updateSettings({ shortTermTtlHours: 72 })
  }
})
