import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-storage-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')

const indexDir = path.join(home, 'index')
const stateFile = path.join(home, 'state.json')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function quarantinedOf(base) {
  try {
    return fs.readdirSync(indexDir).filter((name) => name.startsWith(`${base}.corrupt-`))
  } catch {
    return []
  }
}

test('a missing index is not a failure and does not block the first write', () => {
  const libId = 'lib_missing'
  assert.deepEqual(state.loadPrivateIndex(libId).entries, {})
  state.savePrivateIndex(libId, { version: 1, entries: { 'mem-1': { id: 'mem-1', content: 'x' } } })
  assert.equal(state.loadPrivateIndex(libId).entries['mem-1'].content, 'x')
  assert.deepEqual(quarantinedOf(`${libId}.json`), [])
  assert.equal(state.storageHealth().issues.length, 0)
})

test('a corrupt index keeps its raw bytes and is not written over', () => {
  const libId = 'lib_corrupt'
  const file = path.join(indexDir, `${libId}.json`)
  const broken = '{ "entries": { "mem-9": { "content": "别丢" '
  fs.writeFileSync(file, broken, 'utf8')

  assert.deepEqual(state.loadPrivateIndex(libId).entries, {})

  const kept = quarantinedOf(`${libId}.json`)
  assert.equal(kept.length, 1)
  assert.equal(fs.readFileSync(path.join(indexDir, kept[0]), 'utf8'), broken)
  assert.equal(fs.existsSync(file), false)

  assert.throws(() => state.savePrivateIndex(libId, { entries: {} }), /earlier read failed/)
  // Recovery is explicit: restore a valid file, then the successful read lifts the barrier.
  fs.writeFileSync(file, JSON.stringify({ entries: { 'mem-recovered': { content: 'restored' } } }))
  assert.equal(state.loadPrivateIndex(libId).entries['mem-recovered'].content, 'restored')
  state.savePrivateIndex(libId, { version: 1, entries: { 'mem-2': { id: 'mem-2' } } })
  assert.equal(state.loadPrivateIndex(libId).entries['mem-2'].id, 'mem-2')
  assert.equal(fs.readFileSync(path.join(indexDir, kept[0]), 'utf8'), broken)
})

test('an unreadable index blocks writes until it reads cleanly again', () => {
  const libId = 'lib_busy'
  const file = path.join(indexDir, `${libId}.json`)
  // A directory where a file is expected makes readFileSync fail with EISDIR —
  // the same class as EBUSY/EMFILE: the bytes are fine, we just cannot see them.
  fs.mkdirSync(file, { recursive: true })

  assert.deepEqual(state.loadPrivateIndex(libId).entries, {})
  assert.deepEqual(quarantinedOf(`${libId}.json`), [], 'an I/O failure must not move the file aside')
  assert.equal(fs.existsSync(file), true)

  assert.throws(
    () => state.savePrivateIndex(libId, { version: 1, entries: {} }),
    (error) => error.code === 'dsh-memu-memory/read-failed',
  )
  assert.ok(state.storageHealth().issues.some((issue) => issue.file.includes(libId)))

  // Obstruction gone -> the next successful read lifts the barrier.
  fs.rmdirSync(file)
  state.loadPrivateIndex(libId)
  state.savePrivateIndex(libId, { version: 1, entries: { 'mem-3': { id: 'mem-3' } } })
  assert.equal(state.loadPrivateIndex(libId).entries['mem-3'].id, 'mem-3')
})

test('a corrupt state.json is quarantined instead of silently emptying the plugin', () => {
  state.setWorkspacePolicy(path.join(home, 'proj'), { useLibrary: false })
  assert.ok(Object.keys(state.loadState().workspacePolicies).length > 0)
  // Flush first: with local changes pending, the cache is authoritative by design
  // and an external rewrite would just be overwritten by our own flush.
  state.flushState()

  const broken = '{ "version": 1, "libraries": { '
  fs.writeFileSync(stateFile, broken, 'utf8')

  const recovered = state.loadState()
  assert.deepEqual(recovered.libraries, {})
  const kept = fs.readdirSync(home).filter((name) => name.startsWith('state.json.corrupt-'))
  assert.equal(kept.length, 1)
  assert.equal(fs.readFileSync(path.join(home, kept[0]), 'utf8'), broken)

  state.setWorkspacePolicy(path.join(home, 'proj'), { useGlobal: false })
  assert.equal(state.getWorkspacePolicy(path.join(home, 'proj')).useGlobal, false)
  assert.throws(() => state.flushState(), /earlier read failed/)
  assert.equal(fs.readFileSync(path.join(home, kept[0]), 'utf8'), broken)
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, libraries: {}, sessions: {}, workspacePolicies: {} }))
  state.flushState()
})

test('an unreadable state.json blocks writes rather than replacing it with defaults', () => {
  state.flushState()
  const saved = fs.readFileSync(stateFile, 'utf8')
  fs.rmSync(stateFile)
  fs.mkdirSync(stateFile)

  assert.deepEqual(state.loadState().libraries, {})
  assert.equal(state.storageHealth().issues[0].file, 'state.json')

  // Bookkeeping writes are deferred now, so the refusal surfaces on flush.
  state.setWorkspacePolicy(path.join(home, 'other'), { useLibrary: false })
  assert.throws(() => state.flushState(), (error) => error.code === 'dsh-memu-memory/read-failed')
  assert.ok(fs.statSync(stateFile).isDirectory(), 'the unreadable path was left untouched')

  fs.rmdirSync(stateFile)
  fs.writeFileSync(stateFile, saved, 'utf8')
  assert.equal(state.loadState().workspacePolicies != null, true)
  state.flushState()
  assert.equal(state.storageHealth().issues.length, 0)
})
