import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-backend-compensation-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const calls = []
let commitHook = null
let commitResult = null
let forgetHook = null
let vp

const backend = {
  async commit(args) {
    calls.push({ op: 'commit', ...args })
    if (commitHook) await commitHook(args)
    return commitResult || { ok: true }
  },
  async retrieve(args) {
    calls.push({ op: 'retrieve', ...args })
    return { files: [], segments: [], resources: [], raw: null }
  },
  async forget(args) {
    calls.push({ op: 'forget', ...args })
    if (forgetHook) return forgetHook(args)
    return { deleted: 1 }
  },
  async listFiles() {
    throw new Error('unexpected list engine call')
  },
}

globalThis.__backendCompensationTest = backend
const engineSource = 'const bridge = globalThis.__backendCompensationTest; export const commit = bridge.commit, retrieve = bridge.retrieve, forget = bridge.forget, listFiles = bridge.listFiles;'
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './memu.js') {
      return { url: 'data:text/javascript,' + encodeURIComponent(engineSource), shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const state = await import('../lib/state.js')
vp = await import('../lib/vector-profile.js')
const paths = await import('../lib/paths.js')
const memory = await import('../lib/memory.js')
const profile = vp.profileFromCatalog('bge-small-zh-v1.5-int8')
const activeFile = vp.vectorActiveFile()
let serial = 0

function entry(content, extra = {}) {
  return {
    status: 'active',
    title: content,
    content,
    layer: 'long_term',
    strength: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  }
}

function fixture(entries = {}) {
  serial += 1
  const sessionId = 'backend-compensation-' + serial
  const cwd = path.join(home, 'project-' + serial)
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  state.setSessionBinding(sessionId, { useLibrary: true, useGlobal: true, domainOverride: 'coding' })
  state.savePrivateIndex(binding.libraryId, { entries })
  return {
    sessionId,
    libraryId: binding.libraryId,
    exec: { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding' } } } },
  }
}

function activate(libraryIds = []) {
  const databases = vp.buildDatabaseSet({ profile, generation: 1, libraryIds })
  fs.mkdirSync(path.join(home, 'libraries'), { recursive: true })
  for (const row of [databases.global, ...Object.values(databases.libraries)]) {
    fs.writeFileSync(vp.resolveVectorPath(row.path), '')
  }
  vp.updateVectorStateSync(current => ({
    ...current,
    generation: 1,
    requested: null,
    pending: null,
    active: { status: 'active', generation: 1, fingerprint: profile.fingerprint, profile, databases },
  }))
  return databases
}

test.beforeEach(() => {
  fs.rmSync(activeFile, { force: true })
  state.updateSettings({ memoryBackend: 'api', vectorSource: 'local', relevanceThreshold: 0 })
  state.saveGlobalIndex({ entries: {} })
  calls.length = 0
  commitHook = null
  commitResult = null
  forgetHook = null
  paths.setWarnSink(() => {})
})

test.after(() => {
  hooks.deregister()
  delete globalThis.__backendCompensationTest
  paths.setWarnSink(null)
  fs.rmSync(home, { recursive: true, force: true })
})

test('remember commits a real backend row, then forgets it after a failed index CAS', async () => {
  const f = fixture()
  activate([f.libraryId])
  commitHook = async () => state.setSessionBinding(f.sessionId, { libraryId: 'rebound-library' })

  await assert.rejects(
    memory.privateRemember({ exec: f.exec, content: 'new backend fact', title: 'new backend title' }),
    error => error?.message === 'memory scope changed during write; retry',
  )

  assert.deepEqual(calls.map(call => call.op), ['commit', 'forget'])
  assert.equal(calls[0].route, 'managed-local')
  assert.equal(calls[0].db, vp.dbPathFor(f.libraryId))
  assert.equal(calls[0].payload.recall_files[0].name.startsWith('mem-'), true)
  assert.equal(calls[0].payload.recall_files[0].content, 'new backend fact')
  assert.deepEqual(calls[1], { op: 'forget', route: 'managed-local', db: vp.dbPathFor(f.libraryId), name: calls[0].payload.recall_files[0].name })
  assert.deepEqual(state.loadPrivateIndex(f.libraryId).entries, {})
})

test('update commits a new row, then forgets and restores the authoritative old payload', async () => {
  const old = entry('old authoritative fact', { title: 'old authoritative title', track: 'habit' })
  const f = fixture({ 'mem-live': old })
  activate([f.libraryId])
  commitHook = async () => state.setSessionBinding(f.sessionId, { libraryId: 'rebound-library' })

  await assert.rejects(
    memory.privateUpdate({ exec: f.exec, id: 'mem-live', content: 'new backend fact', title: 'new backend title' }),
    error => error?.message === 'memory scope changed during update; retry',
  )

  assert.deepEqual(calls.map(call => call.op), ['commit', 'forget', 'commit'])
  assert.equal(calls[0].payload.recall_files[0].content, 'new backend fact')
  assert.equal(calls[0].payload.recall_files[0].description, 'new backend title')
  assert.deepEqual(calls[1], { op: 'forget', route: 'managed-local', db: vp.dbPathFor(f.libraryId), name: 'mem-live' })
  assert.equal(calls[2].route, 'managed-local')
  assert.equal(calls[2].db, vp.dbPathFor(f.libraryId))
  assert.deepEqual(calls[2].payload.recall_files[0], {
    name: 'mem-live',
    track: 'habit',
    description: 'old authoritative title',
    content: 'old authoritative fact',
  })
  assert.deepEqual(state.loadPrivateIndex(f.libraryId).entries['mem-live'], old)
})

test('uncertain delete acknowledgement exposes compensation failure and preserves the original CAS cause', async () => {
  const f = fixture()
  activate([f.libraryId])
  commitHook = async () => state.setSessionBinding(f.sessionId, { libraryId: 'rebound-library' })
  forgetHook = () => ({ ok: false })

  await assert.rejects(
    memory.privateRemember({ exec: f.exec, content: 'delete acknowledgement is uncertain' }),
    error => error?.code === 'PRIVATE_BACKEND_COMPENSATION_FAILED'
      && /backend compensation delete was not acknowledged/.test(error.message)
      && error.cause?.message === 'memory scope changed during write; retry',
  )
  assert.deepEqual(calls.map(call => call.op), ['commit', 'forget'])
})

test('uncertain restore acknowledgement exposes compensation failure and preserves the original CAS cause', async () => {
  const old = entry('restore me', { title: 'restore title' })
  const f = fixture({ 'mem-live': old })
  activate([f.libraryId])
  let commits = 0
  commitHook = async () => {
    commits += 1
    if (commits === 1) state.setSessionBinding(f.sessionId, { libraryId: 'rebound-library' })
    else commitResult = { parseWarning: 'restore response was not parseable' }
  }
  forgetHook = () => ({ deleted: 1 })

  try {
    await assert.rejects(
      memory.privateUpdate({ exec: f.exec, id: 'mem-live', content: 'replacement' }),
      error => error?.code === 'PRIVATE_BACKEND_COMPENSATION_FAILED'
        && /backend compensation restore was not acknowledged/.test(error.message)
        && error.cause?.message === 'memory scope changed during update; retry',
    )
  } finally {
    commitResult = null
  }
  assert.deepEqual(calls.map(call => call.op), ['commit', 'forget', 'commit'])
})

test('metadata changed before compensation refuses repair instead of weakening the expectedEntry guard', async () => {
  const old = entry('authoritative body', { title: 'authoritative title' })
  const f = fixture({ 'mem-live': old })
  activate([f.libraryId])
  commitHook = async () => {
    state.updatePrivateIndex(f.libraryId, fresh => {
      fresh.entries['mem-live'].title = 'concurrent metadata winner'
    })
    state.setSessionBinding(f.sessionId, { libraryId: 'rebound-library' })
  }

  await assert.rejects(
    memory.privateUpdate({ exec: f.exec, id: 'mem-live', content: 'replacement' }),
    error => error?.code === 'PRIVATE_BACKEND_COMPENSATION_FAILED'
      && /memory changed before backend compensation/.test(error.message)
      && error.cause?.message === 'memory changed concurrently; reload and retry',
  )
  assert.deepEqual(calls.map(call => call.op), ['commit'])
  assert.equal(state.loadPrivateIndex(f.libraryId).entries['mem-live'].title, 'concurrent metadata winner')
})

test('same-library managed writes are serialized through the backend queue', async () => {
  const f = fixture()
  activate([f.libraryId])
  let active = 0
  let maximum = 0
  let commits = 0
  let entered
  let release
  const firstEntered = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  commitHook = async () => {
    commits += 1
    active += 1
    maximum = Math.max(maximum, active)
    if (commits === 1) {
      entered()
      await gate
    }
    active -= 1
  }

  const first = memory.privateRemember({ exec: f.exec, content: 'first queued fact' })
  await firstEntered
  const second = memory.privateRemember({ exec: f.exec, content: 'second queued fact' })
  await Promise.resolve()
  assert.equal(calls.filter(call => call.op === 'commit').length, 1)
  release()
  await Promise.all([first, second])
  assert.equal(maximum, 1)
  assert.equal(calls.filter(call => call.op === 'commit').length, 2)
})

test('a rejected write does not poison the same-library queue', async () => {
  const f = fixture()
  activate([f.libraryId])
  let commits = 0
  commitHook = async () => {
    commits += 1
    if (commits === 1) state.setSessionBinding(f.sessionId, { libraryId: 'rebound-library' })
  }

  await assert.rejects(memory.privateRemember({ exec: f.exec, content: 'first rejected fact' }), /memory scope changed during write; retry/)
  state.setSessionBinding(f.sessionId, { libraryId: f.libraryId, useLibrary: true, useGlobal: true })
  const second = await memory.privateRemember({ exec: f.exec, content: 'second healthy fact' })

  assert.ok(second.id)
  assert.deepEqual(calls.map(call => call.op), ['commit', 'forget', 'commit'])
  assert.equal(state.loadPrivateIndex(f.libraryId).entries[second.id].content, 'second healthy fact')
})
