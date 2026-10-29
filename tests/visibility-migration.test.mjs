import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-visibility-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const migrate = await import('../lib/migrate.js')
const visibility = await import('../lib/visibility.js')

test.after(() => {
  try { state.flushState() } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

const cwd = path.join(home, 'coding')
const library = state.createLibrary({ name: 'coding', scopeKey: cwd })
const execA = { agent: { session: { header: { id: 'conv-a', cwd } } } }
const execB = { agent: { session: { header: { id: 'conv-b', cwd } } } }
state.ensureSession('conv-a', { cwd })
state.ensureSession('conv-b', { cwd })

function indexFile(libraryId) {
  return path.join(home, 'index', `${libraryId}.json`)
}

function writeLegacy(entries) {
  fs.mkdirSync(path.join(home, 'index'), { recursive: true })
  fs.writeFileSync(indexFile(library.id), JSON.stringify({ version: 1, entries }, null, 2))
}

function legacyEntry(overrides = {}) {
  return {
    id: 'mem-legacy',
    title: '旧版本的会话记忆',
    content: '这条记忆属于一个已经不存在的会话。',
    visibility: 'session',
    sessionId: 'session-gone',
    context: {},
    status: 'active',
    layer: 'long_term',
    owner: 'me',
    source: 'inferred',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

test('the migration rule keeps context and drops the conversation', () => {
  const entry = legacyEntry({ context: { characterId: 'hero', branchId: 'main' } })
  assert.equal(visibility.isLegacySession(entry), true)
  assert.equal(visibility.migrateEntryVisibility(entry, '2026-10-29T00:00:00.000Z'), true)
  assert.equal(entry.visibility, 'shared')
  assert.equal('sessionId' in entry, false)
  assert.deepEqual(entry.context, { characterId: 'hero', branchId: 'main' }, 'context is the scope that survives')
  assert.equal(entry.migratedFromVisibility, 'session')
  assert.equal(entry.visibilityMigratedAt, '2026-10-29T00:00:00.000Z')
  assert.equal(visibility.migrateEntryVisibility(entry), false, 'already migrated entries are left alone')

  // Older writes also stamped `sessionId: null` onto ordinary entries. The field is dead
  // now, and leaving it would make the file look like it still had the level.
  const leftover = { id: 'mem-plain', visibility: 'shared', sessionId: null }
  assert.equal(visibility.migrateEntryVisibility(leftover), true)
  assert.equal('sessionId' in leftover, false)
  assert.equal(leftover.migratedFromVisibility, undefined, 'a plain entry is not marked as migrated')
})

test('reads normalize the removed level without waiting for a write', () => {
  writeLegacy({ 'mem-legacy': legacyEntry() })
  const index = state.loadPrivateIndex(library.id)
  assert.equal(index.entries['mem-legacy'].visibility, 'shared')
  assert.equal('sessionId' in index.entries['mem-legacy'], false)
})

test('the repair script path rewrites the file and can prove it', () => {
  const normal = legacyEntry({ id: 'mem-normal', visibility: 'secret' })
  delete normal.sessionId
  writeLegacy({ 'mem-legacy': legacyEntry(), 'mem-normal': normal })
  const scan = migrate.scanLegacyLibraries()
  assert.deepEqual(scan.map((s) => s.libraryId), [library.id])
  assert.equal(scan[0].legacy, 1, 'a secret entry is not counted')

  const report = migrate.migrateLibraries({ now: '2026-10-29T00:00:00.000Z' })
  assert.equal(report.length, 1)
  assert.equal(report[0].before, 1)
  assert.equal(report[0].after, 0)
  assert.equal(report[0].migrated, 1)

  const onDisk = JSON.parse(fs.readFileSync(indexFile(library.id), 'utf8'))
  assert.equal(onDisk.entries['mem-legacy'].visibility, 'shared')
  assert.equal('sessionId' in onDisk.entries['mem-legacy'], false)
  assert.equal(onDisk.entries['mem-normal'].visibility, 'secret', 'untouched entries keep their exact shape')

  assert.deepEqual(migrate.scanLegacyLibraries(), [], 'nothing left to do')
  assert.deepEqual(migrate.migrateLibraries(), [], 'a second run is a no-op')
})

test('the tool surface refuses the removed level with an explanation', async () => {
  await assert.rejects(
    () => memory.privateRemember({ exec: execA, title: 'x', content: 'y', visibility: 'session' }),
    /visibility 'session' was removed/,
  )
  const written = await memory.privateRemember({ exec: execA, title: '正常', content: '一条正常的共享记忆。' })
  assert.equal(written.entry.visibility, 'shared')
  assert.equal('sessionId' in written.entry, false)
  await assert.rejects(
    () => memory.privateUpdate({ exec: execA, id: written.id, visibility: 'session' }),
    /visibility 'session' was removed/,
  )
})

test('a blank context is one shared scope: another conversation reads even a secret', async () => {
  const secret = await memory.privateRemember({
    exec: execA,
    title: '空白作用域里的秘密',
    content: '这件事不要主动提，但同文件夹问起来要说。',
    visibility: 'secret',
  })
  const recalled = await memory.privateRecall({ exec: execB, query: '空白作用域里的秘密' })
  assert.ok(recalled.files.some((f) => f.name === secret.id), 'an explicit recall crosses conversations when the scope is blank')
  const listed = await memory.privateList({ exec: execB })
  assert.ok(listed.files.some((f) => f.name === secret.id), 'the sidebar lists it too')
})

test('a secret is still kept out of automatic surfaces', async () => {
  const secret = await memory.privateRemember({
    exec: execA,
    title: '只手动查的事',
    content: '不要自己冒出来。',
    visibility: 'secret',
  })
  const entry = state.loadPrivateIndex(library.id).entries[secret.id]
  assert.equal(memory.isMemoryEligible(entry, { automatic: true }), false)
  const automatic = await memory.privateRecall({ exec: execA, query: '只手动查的事', purpose: 'automatic' })
  assert.equal(automatic.files.some((f) => f.name === secret.id), false)
})

test('a filled context is still a boundary', async () => {
  state.setSessionBinding('conv-a', { memoryContext: { characterId: 'hero' } })
  state.setSessionBinding('conv-b', { memoryContext: { characterId: 'villain' } })
  const scoped = await memory.privateRemember({ exec: execA, title: '英雄知道的事', content: '只有 hero 这条线知道。' })
  assert.equal(scoped.entry.context.characterId, 'hero')
  const fromVillain = await memory.privateRecall({ exec: execB, query: '英雄知道的事' })
  assert.equal(fromVillain.files.some((f) => f.name === scoped.id), false, 'another character does not read it')
  const fromHero = await memory.privateRecall({ exec: execA, query: '英雄知道的事' })
  assert.ok(fromHero.files.some((f) => f.name === scoped.id))
})
