import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-coalesce-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')

const stateFile = path.join(home, 'state.json')

test.after(() => {
  try { state.flushState() } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function countWrites(match) {
  const original = fs.writeFileSync
  const hits = []
  fs.writeFileSync = function (file, ...rest) {
    if (String(file).includes(match)) hits.push(String(file))
    return original.call(this, file, ...rest)
  }
  return {
    hits,
    stop() { fs.writeFileSync = original },
  }
}

test('a turn of bookkeeping updates collapses into one disk write', () => {
  state.ensureSession('coalesce', { cwd: path.join(home, 'coalesce') })
  state.flushState()

  const spy = countWrites('state.json.tmp-')
  try {
    for (let i = 0; i < 10; i++) state.touchSession('coalesce')
    assert.equal(spy.hits.length, 0, 'nothing is written while the timer is pending')
    state.flushState()
    assert.equal(spy.hits.length, 1, 'all ten updates land in a single write')
  } finally {
    spy.stop()
  }
})

test('every coalesced change is present on disk afterwards', () => {
  state.ensureSession('coalesce-all', { cwd: path.join(home, 'coalesce-all') })
  state.markInjected('coalesce-all', ['mem-a', 'mem-b'], 3)
  state.setSessionMood('coalesce-all', { valence: 0.5, arousal: 0.6 })
  state.flushState()

  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const binding = raw.sessions['coalesce-all']
  assert.ok(binding)
  assert.ok(binding.injectedIds.includes('mem-a'))
  assert.ok(binding.injectedIds.includes('mem-b'))
  assert.equal(binding.lastInjectedTurn, 3)
  assert.equal(binding.mood.valence, 0.5)
})

test('memory indexes are never coalesced', () => {
  const binding = state.ensureSession('no-coalesce', { cwd: path.join(home, 'no-coalesce') })
  state.flushState()

  const spy = countWrites('.json.tmp-')
  try {
    state.savePrivateIndex(binding.libraryId, { version: 1, entries: { a: { id: 'a' } } })
    state.savePrivateIndex(binding.libraryId, { version: 1, entries: { a: { id: 'a' }, b: { id: 'b' } } })
    const indexWrites = spy.hits.filter((file) => file.includes(binding.libraryId))
    assert.equal(indexWrites.length, 2, 'a memory write hits disk immediately, every time')
  } finally {
    spy.stop()
  }
  assert.deepEqual(Object.keys(state.loadPrivateIndex(binding.libraryId).entries).sort(), ['a', 'b'])
})

test('a read-modify-write after an await keeps what landed during it', async () => {
  const binding = state.ensureSession('await-merge', { cwd: path.join(home, 'await-merge') })

  // A caller that reads first and awaits (a MemU commit, a consolidation job).
  const slowCaller = (async () => {
    const early = state.loadPrivateIndex(binding.libraryId)
    await new Promise((resolve) => setTimeout(resolve, 5))
    return early
  })()

  // Another writer lands inside that window.
  state.updatePrivateIndex(binding.libraryId, (index) => {
    index.entries['mem-other'] = { id: 'mem-other', content: 'other' }
  })
  const early = await slowCaller
  assert.equal(early.entries['mem-other'], undefined, 'the early snapshot really is stale')

  // The correct pattern re-reads instead of saving the stale snapshot.
  state.updatePrivateIndex(binding.libraryId, (index) => {
    index.entries['mem-mine'] = { id: 'mem-mine', content: 'mine' }
  })

  const after = state.loadPrivateIndex(binding.libraryId)
  assert.deepEqual(Object.keys(after.entries).sort(), ['mem-mine', 'mem-other'])
})

test('an externally modified state.json is picked up instead of the cache', () => {
  state.ensureSession('external', { cwd: path.join(home, 'external') })
  state.flushState()

  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  raw.sessions['external'].useGlobal = false
  fs.writeFileSync(stateFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')

  assert.equal(state.getSessionBinding('external').useGlobal, false)
})
