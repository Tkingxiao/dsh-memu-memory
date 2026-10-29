import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-human-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const inject = await import('../lib/inject.js')
const rpc = await import('../lib/rpc.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function execFor(sessionId, cwd) {
  return { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding' } } } }
}

function ageEntry(libraryId, id, days) {
  const index = state.loadPrivateIndex(libraryId)
  const at = new Date(Date.now() - days * 86_400_000).toISOString()
  index.entries[id].updatedAt = at
  index.entries[id].createdAt = at
  state.savePrivateIndex(libraryId, index)
}

test('relative time reads like a person, not like a timestamp', () => {
  const now = Date.parse('2026-10-27T12:00:00.000Z')
  const ago = (ms) => new Date(now - ms).toISOString()
  assert.equal(memory.relativeTime(ago(30_000), now), '刚刚')
  assert.equal(memory.relativeTime(ago(5 * 60_000), now), '5 分钟前')
  assert.equal(memory.relativeTime(ago(3 * 3_600_000), now), '3 小时前')
  assert.equal(memory.relativeTime(ago(2 * 86_400_000), now), '2 天前')
  assert.equal(memory.relativeTime(ago(40 * 86_400_000), now), '1 个月前')
  // An unparseable stamp must not paint "NaN 天前" into the prompt.
  assert.equal(memory.relativeTime('not a date', now), '')
})

test('the injected line carries how old the memory is', async () => {
  const cwd = path.join(home, 'proj-age')
  const sessionId = 'age-1'
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const exec = execFor(sessionId, cwd)
  const { id } = await memory.privateRemember({
    exec, content: 'The rollback drill runs every Friday afternoon.', title: 'rollback drill',
  })
  ageEntry(binding.libraryId, id, 4)
  const anchor = inject.buildAnchor(binding, { ...state.getSettings(), anchorTokens: 700 })
  assert.ok(anchor.text.includes('4 天前'), anchor.text)
})

test('near-duplicate memories stop eating the recall budget', async () => {
  const cwd = path.join(home, 'proj-mmr')
  const sessionId = 'mmr-1'
  const exec = execFor(sessionId, cwd)
  const written = []
  for (const [title, content] of [
    ['hero plan', 'pricing page rewrite plan for the landing hero'],
    ['hero plan b', 'pricing page rewrite plan for the landing hero section'],
    ['hero plan c', 'pricing page rewrite plan for the landing hero area'],
    ['pricing doc', 'pricing page rewrite plan is written down in docs/pricing.md'],
  ]) {
    const { id } = await memory.privateRemember({ exec, content, title })
    written.push(id)
  }
  const result = await memory.privateRecall({
    exec, query: 'pricing page rewrite plan', topK: 2, relevanceThreshold: 0,
  })
  const names = result.files.map((file) => file.name)
  assert.equal(names.length, 2)
  assert.ok(names.includes(written[3]), `the distinct memory must survive the near-duplicates, got ${names.join(',')}`)
})

test('a memory that keeps being pushed fades, and editing it brings it back', async () => {
  const cwd = path.join(home, 'proj-habit')
  const sessionId = 'habit-1'
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const exec = execFor(sessionId, cwd)
  const { id } = await memory.privateRemember({
    exec, content: 'Deploy window notes: staging turns over at noon.', title: 'deploy window',
  })
  const scoreOf = async () => {
    const res = await memory.privateRecall({ exec, query: 'deploy window notes', topK: 3, relevanceThreshold: 0 })
    const hit = res.files.find((file) => file.name === id)
    return hit ? hit.score : 0
  }
  const fresh = await scoreOf()
  memory.noteInjected({ libraryId: binding.libraryId, ids: [id] })
  memory.noteInjected({ libraryId: binding.libraryId, ids: [id] })
  const dulled = await scoreOf()
  assert.ok(dulled < fresh, `repeated injection should lower the score (${fresh} -> ${dulled})`)

  // Rewriting the body is the signal that this memory is worth keeping current.
  await memory.privateUpdate({ exec, id, content: 'Deploy window notes: staging turns over at noon, prod at six.' })
  const refreshed = await scoreOf()
  assert.ok(refreshed > dulled, `an edit must clear the habituation (${dulled} -> ${refreshed})`)
})

test('a context-scoped memory stays inside its character until the user widens it', async () => {
  const cwd = path.join(home, 'proj-scope')
  const mine = 'scope-a'
  const other = 'scope-b'
  const binding = state.ensureSession(mine, { cwd, agentPreset: 'coding' })
  const execMine = execFor(mine, cwd)
  const execOther = execFor(other, cwd)
  state.ensureSession(other, { cwd, agentPreset: 'coding' })
  // Both conversations live in one folder. The only thing that may separate them is the
  // scope: `session` used to, and it did so by making the memory disappear for everyone.
  state.setSessionBinding(mine, { memoryContext: { characterId: 'hero' } })
  state.setSessionBinding(other, { memoryContext: { characterId: 'villain' } })

  const { id } = await memory.privateRemember({
    exec: execMine,
    content: 'The seal number for this thread is 4471.',
    title: 'seal number',
  })
  const seenByMine = await memory.privateRecall({ exec: execMine, query: 'seal number', topK: 3, relevanceThreshold: 0 })
  assert.ok(seenByMine.files.some((file) => file.name === id), 'the writing conversation must still see it')

  const seenByOther = await memory.privateRecall({ exec: execOther, query: 'seal number', topK: 3, relevanceThreshold: 0 })
  assert.equal(seenByOther.files.some((file) => file.name === id), false, 'another character must not see it')
  const anchorForOther = inject.buildAnchor(state.getSessionBinding(other), { ...state.getSettings(), anchorTokens: 700 }, other)
  assert.equal(anchorForOther.text.includes(id), false)

  // Only the user can widen a stored boundary; the memory wall has no conversation and
  // therefore no scope to defend. Widening drops the pointer, it does not copy the entry.
  await rpc.dispatch({}, 'updateMemory', { libraryId: binding.libraryId, id, patch: { context: {} } })
  assert.deepEqual(state.loadPrivateIndex(binding.libraryId).entries[id].context, {})
  const seenAgain = await memory.privateRecall({ exec: execOther, query: 'seal number', topK: 3, relevanceThreshold: 0 })
  assert.ok(seenAgain.files.some((file) => file.name === id), 'once the user widens it, the folder can read it')
})

test('an old open loop is raised once, then left alone', async () => {
  const cwd = path.join(home, 'proj-loop')
  const sessionId = 'loop-1'
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const exec = execFor(sessionId, cwd)
  const { id } = await memory.privateRemember({
    exec,
    content: 'He asked whether the salary review letter ever went out; I never answered.',
    title: 'salary review letter',
    openLoop: true,
  })
  ageEntry(binding.libraryId, id, 6)

  const first = inject.buildOpenLoopNudge(state.getSessionBinding(sessionId))
  assert.ok(first.text.includes('[open loop]'), first.text)
  assert.ok(first.text.includes(id))
  assert.ok(first.text.includes('没下文了'))

  state.markInjected(sessionId, [id], 3)
  const second = inject.buildOpenLoopNudge(state.getSessionBinding(sessionId))
  assert.equal(second.text, '', 'once it has been said, it stops being a nudge')
})

test('compaction replay replays gists, never whole bodies, and skips secrets', async () => {
  const cwd = path.join(home, 'proj-replay')
  const sessionId = 'replay-1'
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const exec = execFor(sessionId, cwd)
  const long = 'X'.repeat(400)
  const { id: plain } = await memory.privateRemember({
    exec, content: `BODY-START ${long}`, title: 'long one',
  })
  const { id: secret } = await memory.privateRemember({
    exec, content: 'SECRET-BODY that must stay out of the prompt', title: 'secret one', visibility: 'secret',
  })
  state.setSessionBinding(sessionId, { replayIds: [plain, secret] })
  const replay = inject.buildReplay(state.getSessionBinding(sessionId), state.getSettings(), sessionId)
  assert.ok(replay.text.includes('[replay'), replay.text)
  assert.ok(replay.text.includes(plain))
  assert.equal(replay.text.includes('X'.repeat(120)), false, 'a replay is a gist, not the body')
  assert.equal(replay.text.includes(secret), false)
  assert.equal(replay.text.includes('SECRET-BODY'), false)
  assert.ok(binding.libraryId)
})

test('import restores what can travel and reports what cannot', async () => {
  const cwd = path.join(home, 'proj-import')
  const sessionId = 'import-1'
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const exec = execFor(sessionId, cwd)
  // Already here: the duplicate check has to look at the target library, not just the file.
  await memory.privateRemember({ exec, content: 'pricing thread body about the hero', title: 'pricing thread' })

  const result = await memory.importMemories({
    libraryId: binding.libraryId,
    memories: [
      { id: 'old-1', title: 'pricing thread', content: 'pricing thread body about the hero', layer: 'long_term' },
      { id: 'old-2', title: 'pricing thread copy', content: 'pricing thread body about the hero' },
      { id: 'old-3', title: 'archived one', content: 'dead content', status: 'archived' },
      { id: 'old-4', title: 'session note', content: 'session bound body', visibility: 'session' },
      { id: 'old-5', content: '   ' },
      { id: 'old-6', title: 'draft', content: 'draft body that expires', layer: 'short_term', expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
      { id: 'old-7', title: 'unique', content: 'a body nobody here has ever written' },
    ],
  })

  assert.equal(result.imported, 3, JSON.stringify(result.counts))
  assert.equal(result.counts.duplicate, 2)
  assert.equal(result.counts.dead, 1)
  assert.equal(result.counts.invalid, 1)
  // A `session` entry from an older export lands as `shared` with the same marker a stored
  // entry gets: dropping it silently would be the very data loss this upgrade prevents,
  // and the report still has to say that its reader went from one conversation to a folder.
  assert.equal(result.counts.downgraded, 1)

  const index = state.loadPrivateIndex(binding.libraryId)
  const entries = Object.entries(index.entries)
  const restored = entries.filter(([, entry]) => entry.importedFrom)
  assert.equal(restored.length, 3)
  const kept = state.loadPrivateIndex(binding.libraryId).entries
  const fromSession = Object.values(kept).find((entry) => entry.importedFrom === 'old-4')
  assert.equal(fromSession.visibility, 'shared', 'the removed level has to come back as shared')
  assert.equal(fromSession.migratedFromVisibility, 'session')
  assert.equal('sessionId' in fromSession, false)
  assert.ok(result.examples.downgraded.some((line) => line.includes('session note')), 'the report has to name what changed level')
  assert.ok(result.examples.downgraded.some((line) => line.includes('session -> shared')))
  const draft = restored.find(([, entry]) => entry.importedFrom === 'old-6')
  assert.equal(draft[1].layer, 'short_term')
  const hours = (Date.parse(draft[1].expiresAt) - Date.now()) / 3_600_000
  assert.ok(hours > 0 && hours <= 1, `the earlier deadline wins, got ${hours}h`)
  const unique = restored.find(([, entry]) => entry.importedFrom === 'old-7')
  assert.ok(unique[1].content.includes('a body nobody here has ever written'), 'the body has to survive the restore')

  const recall = await memory.privateRecall({ exec, query: 'body nobody ever written', topK: 3, relevanceThreshold: 0 })
  assert.ok(recall.files.some((file) => file.name === unique[0]), 'a restored memory must be retrievable')
})
