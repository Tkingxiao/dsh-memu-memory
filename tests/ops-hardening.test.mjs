import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-ops-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const activity = await import('../lib/activity-log.js')
const media = await import('../lib/media.js')
const { zipSync, unzipSync } = await import('fflate')
const { dispatch } = await import('../lib/rpc.js')

test.after(() => {
  state.flushState()
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function session(name) {
  const cwd = path.join(home, 'ws', name)
  state.ensureSession(name, { cwd, agentPreset: 'coding' })
  return {
    libraryId: state.getSessionBinding(name).libraryId,
    exec: { agent: { session: { header: { id: name, cwd, agentPreset: 'coding' } } } },
  }
}

test('permanently deleting a host clears duplicateOf on its copies', async () => {
  const { libraryId, exec } = session('ops-delete')
  const now = new Date().toISOString()
  state.savePrivateIndex(libraryId, {
    entries: {
      'mem-host': { title: 'host', content: 'host body', status: 'archived', layer: 'long_term', createdAt: now, updatedAt: now },
      'mem-copy': { title: 'copy', content: 'copy body', status: 'active', layer: 'long_term', createdAt: now, updatedAt: now, duplicateOf: 'mem-host' },
    },
  })
  await memory.privateDelete({ exec, id: 'mem-host' })
  const entries = state.loadPrivateIndex(libraryId).entries
  assert.equal(entries['mem-host'], undefined)
  assert.equal(entries['mem-copy'].duplicateOf, undefined, 'a dangling duplicateOf must not keep the soft penalty')
  assert.equal(entries['mem-copy'].content, 'copy body')
})

test('clearing the activity log requires explicit confirmation', async () => {
  activity.clearEvents()
  activity.record({ kind: 'write', message: 'must survive an unconfirmed clear' })
  await assert.rejects(
    () => dispatch({}, 'clearActivityLog', {}),
    /explicit confirmation/,
  )
  assert.equal(activity.listEvents().length, 1, 'the unconfirmed call must not clear anything')
  await dispatch({}, 'clearActivityLog', { confirmed: true })
  assert.equal(activity.listEvents().length, 0)
})

test('delete preview is read-only and a permanent delete can be restored locally', async () => {
  const { libraryId } = session('ops-delete-restore')
  const now = new Date().toISOString()
  state.savePrivateIndex(libraryId, {
    entries: {
      'mem-restorable': {
        title: 'restorable', content: 'this body should come back', status: 'archived',
        layer: 'long_term', createdAt: now, updatedAt: now,
      },
    },
  })
  const preview = await dispatch({}, 'deleteMemory', { libraryId, id: 'mem-restorable', preview: true })
  assert.equal(preview.deletable, true)
  assert.equal(preview.plan.deleteFromIndex, true)
  assert.ok(state.loadPrivateIndex(libraryId).entries['mem-restorable'], 'preview must not write')

  await assert.rejects(
    () => dispatch({}, 'deleteMemory', { libraryId, id: 'mem-restorable' }),
    /explicit confirmation/,
    'an archived memory still needs consent before it is erased',
  )
  await dispatch({}, 'deleteMemory', { libraryId, id: 'mem-restorable', confirmed: true })
  assert.equal(state.loadPrivateIndex(libraryId).entries['mem-restorable'], undefined)
  const restored = await dispatch({}, 'deleteMemory', { libraryId, id: 'mem-restorable', restore: true })
  assert.equal(restored.entry.content, 'this body should come back')
  assert.equal(restored.entry.status, 'active')
  assert.equal(state.loadPrivateIndex(libraryId).entries['mem-restorable'].content, 'this body should come back')
  await assert.rejects(() => dispatch({}, 'deleteMemory', { libraryId, id: 'mem-nope', restore: true }), /no deleted memory/)
})

test('a memory bundle carries a memories checksum and rejects tampering', () => {
  const { libraryId } = session('ops-bundle')
  const bundle = media.exportMediaBundle(libraryId, {
    bundleId: 'bnd-test',
    memories: [{ title: 'bundle member', content: 'bundle member body' }],
    graph: null,
    lexicon: null,
  })
  const files = unzipSync(bundle)
  const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8'))
  assert.equal(manifest.bundleId, 'bnd-test')
  assert.match(manifest.memoriesSha256, /^[0-9a-f]{64}$/)
  const imported = media.importMediaBundle(libraryId, bundle)
  assert.equal(imported.bundleId, 'bnd-test')

  files['memories.json'] = Buffer.from(JSON.stringify({ bundleId: 'bnd-test', memories: [{ title: 'tampered', content: 'tampered' }] }))
  const tampered = Buffer.from(zipSync(files, { level: 0 }))
  assert.throws(() => media.importMediaBundle(libraryId, tampered), /memories\.json checksum mismatch/)
})

test('an import batch can be reverted without touching earlier memories', async () => {
  const { libraryId } = session('ops-revert')
  const now = new Date().toISOString()
  state.savePrivateIndex(libraryId, {
    entries: { 'mem-before': { title: 'before', content: 'before body', status: 'active', layer: 'long_term', createdAt: now, updatedAt: now } },
  })
  const imported = await dispatch({}, 'importMemories', {
    libraryId,
    bundleId: 'bnd-revert',
    memories: [{ title: 'bundle fact', content: 'this fact came from a bundle' }],
  })
  assert.equal(imported.importBatchId, 'bnd-revert')
  let entries = state.loadPrivateIndex(libraryId).entries
  assert.ok(Object.values(entries).some((entry) => entry.importedBundle === 'bnd-revert'))
  const reverted = await dispatch({}, 'importMemories', { libraryId, revertBatchId: 'bnd-revert' })
  assert.equal(reverted.removed, 1)
  entries = state.loadPrivateIndex(libraryId).entries
  assert.equal(entries['mem-before'].content, 'before body')
  assert.ok(!Object.values(entries).some((entry) => entry.importedBundle === 'bnd-revert'))
})


function bundleWithManifest(files, manifest) {
  return Buffer.from(zipSync({ ...files, 'manifest.json': Buffer.from(JSON.stringify(manifest)) }, { level: 0 }))
}

test('a v2 bundle rejects a removed, malformed or forged checksum', () => {
  const { libraryId } = session('ops-bundle-integrity')
  const files = unzipSync(media.exportMediaBundle(libraryId, {
    bundleId: 'bnd-integrity', memories: [{ title: 'kept', content: 'kept body' }], graph: null, lexicon: null,
  }))
  const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8'))
  assert.equal(manifest.format, 'dsh-memu-memory-media@2')
  assert.equal(media.importMediaBundle(libraryId, bundleWithManifest(files, manifest)).memories.length, 1)

  const removed = { ...manifest }
  delete removed.memoriesSha256
  assert.throws(() => media.importMediaBundle(libraryId, bundleWithManifest(files, removed)), /checksum missing/)
  assert.throws(() => media.importMediaBundle(libraryId, bundleWithManifest(files, { ...manifest, memoriesSha256: 'nope' })), /checksum is malformed/)
  assert.throws(() => media.importMediaBundle(libraryId, bundleWithManifest(files, { ...manifest, memoriesSha256: '0'.repeat(64) })), /checksum mismatch/)
})

test('legacy v1 archives without a checksum stay importable', () => {
  const { libraryId } = session('ops-bundle-legacy')
  const archive = Buffer.from(zipSync({
    'memories.json': Buffer.from(JSON.stringify({ memories: [{ title: 'legacy', content: 'legacy body' }] })),
    'manifest.json': Buffer.from(JSON.stringify({ format: 'dsh-memu-media@1', blobs: {} })),
  }, { level: 0 }))
  assert.equal(media.importMediaBundle(libraryId, archive).memories.length, 1)
})

test('streaming imports enforce the same checksum rule', async () => {
  const { Readable } = await import('node:stream')
  const { libraryId } = session('ops-bundle-stream')
  const files = unzipSync(media.exportMediaBundle(libraryId, {
    bundleId: 'bnd-stream', memories: [{ title: 'streamed', content: 'streamed body' }], graph: null, lexicon: null,
  }))
  const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8'))
  delete manifest.memoriesSha256
  await assert.rejects(
    media.importMediaStream(libraryId, Readable.from([bundleWithManifest(files, manifest)])),
    /checksum missing/,
  )
})

test('a corrupt manifest is reported as an invalid archive, not a raw SyntaxError', () => {
  const { libraryId } = session('ops-bundle-corrupt')
  const archive = Buffer.from(zipSync({
    'memories.json': Buffer.from('{ not json'),
    'manifest.json': Buffer.from('{ not json'),
  }, { level: 0 }))
  assert.throws(() => media.importMediaBundle(libraryId, archive), /invalid memory archive/)
})

test('an expired delete stash cannot be restored, is swept and never enters a backup', async () => {
  const { indexDir, writeJson } = await import('../lib/paths.js')
  const { libraryId, exec } = session('ops-delete-ttl')
  const now = new Date().toISOString()
  state.savePrivateIndex(libraryId, {
    entries: { 'mem-expired': { title: 'gone', content: 'PERMANENTLY-DELETED-BODY', status: 'archived', layer: 'long_term', createdAt: now, updatedAt: now } },
  })
  await memory.privateDelete({ exec, id: 'mem-expired' })
  const stashPath = path.join(indexDir(), `${libraryId}.deleted.json`)
  const stash = JSON.parse(fs.readFileSync(stashPath, 'utf8'))
  assert.ok(stash.items['mem-expired'], 'a fresh delete is still restorable')
  stash.items['mem-expired'].deletedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
  writeJson(stashPath, stash)
  await assert.rejects(() => memory.restoreDeleted({ libraryId, id: 'mem-expired' }), /no deleted memory/)

  const swept = memory.pruneDeletedStores()
  assert.ok(swept.removed >= 1, 'the startup sweep must drop expired stash entries')
  assert.ok(!JSON.parse(fs.readFileSync(stashPath, 'utf8')).items['mem-expired'])

  const dest = await state.backupDatabases()
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'))
  assert.deepEqual(
    Object.keys(manifest.files).filter(rel => rel.endsWith('.deleted.json')),
    [],
    'permanently deleted bodies must not leak into a backup',
  )
})
