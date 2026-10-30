// Deletion cascade and entity lifecycle. The invariant under test: only the
// *permanent* delete path may lose graph structure. Archiving is reversible, so
// its links and entities must survive byte-for-byte (the boundary tests here
// exist to pin that against a well-meant "clean up while we are at it").
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-graph-cascade-'))
process.env.DSH_MEMU_HOME = home
const state = await import('../lib/state.js')
const graph = await import('../lib/graph.js')
const memory = await import('../lib/memory.js')
const { indexDir } = await import('../lib/paths.js')

test.after(() => { state.flushState(); fs.rmSync(home, { recursive: true, force: true }) })

const binding = state.ensureSession('cascade', { cwd: path.join(home, 'rp'), agentPreset: 'rp' })
const libraryId = binding.libraryId
const exec = { agent: { session: { header: { id: 'cascade' } } } }
const entitiesFile = path.join(indexDir(), `${libraryId}.entities.json`)
const readStore = () => JSON.parse(fs.readFileSync(entitiesFile, 'utf8'))

state.savePrivateIndex(libraryId, { entries: {
  'mem-root': { title: 'root', content: 'root scene', layer: 'long_term', status: 'archived', visibility: 'shared' },
  'mem-peer': { title: 'peer', content: 'peer scene', layer: 'long_term', status: 'active', visibility: 'shared' },
  'mem-side': { title: 'side', content: 'side scene', layer: 'long_term', status: 'active', visibility: 'shared' },
  'mem-free': { title: 'free', content: 'free scene', layer: 'long_term', status: 'active', visibility: 'shared' },
} })

test('permanent delete sweeps inbound links and collects the entity only that row kept alive', async () => {
  const lin = graph.createEntity({ libraryId, name: 'Lin' })
  state.updatePrivateIndex(libraryId, index => {
    index.entries['mem-root'].links = [
      { to: 'mem-peer', kind: 'event', note: 'The same event seen from another side.', confidence: 0.9 },
      { to: lin.id, kind: 'person', note: 'Lin is the person this scene is about.', confidence: 0.9 },
    ]
    index.entries['mem-peer'].links = [{ to: 'mem-root', kind: 'event', note: 'Back-reference to the very same event.', confidence: 0.8 }]
  })
  const result = await memory.privateDelete({ exec, id: 'mem-root' })
  assert.equal(result.deleted, true)
  const fresh = state.loadPrivateIndex(libraryId)
  assert.equal(fresh.entries['mem-root'], undefined, 'the row itself goes')
  assert.deepEqual(fresh.entries['mem-peer'].links, [], 'an inbound link from a surviving entry is swept')
  assert.equal(readStore().entities[lin.id], undefined, 'an entity nothing else points at is collected')
  const view = graph.getGraph({ libraryId })
  assert.ok(!view.nodes.some(node => node.id === 'mem-root'))
  assert.ok(!view.nodes.some(node => node.id === lin.id), 'no orphan placeholder node survives')
})

test('archiving keeps links and entities so the memory stays restorable', async () => {
  const yun = graph.createEntity({ libraryId, name: 'Yun' })
  graph.linkEntries({ libraryId, fromId: 'mem-side', toId: yun.id, kind: 'person', note: 'Yun is the person this scene is about.' })
  await memory.privateArchive({ exec, libraryId, id: 'mem-side' })
  assert.equal(state.loadPrivateIndex(libraryId).entries['mem-side'].links.length, 1, 'archiving must not sweep links')
  assert.ok(readStore().entities[yun.id], 'the referenced entity must survive an archive')
  // Restore brings the memory back with its graph intact — the reason the
  // archive path is forbidden from ever cascading.
  await memory.privateUpdate({ exec, libraryId, id: 'mem-side', status: 'active' })
  assert.equal(state.loadPrivateIndex(libraryId).entries['mem-side'].links.length, 1)
  assert.ok(graph.getGraph({ libraryId, focusId: yun.id, depth: 1 }).nodes.some(node => node.id === yun.id))
})

test('deleteEntity deletes an unreferenced entity and refuses a referenced one until force', () => {
  const solo = graph.createEntity({ libraryId, name: 'Solo' })
  const gone = graph.deleteEntity({ libraryId, entityId: solo.id })
  assert.equal(gone.deleted, true)
  assert.equal(readStore().entities[solo.id], undefined)
  assert.throws(() => graph.deleteEntity({ libraryId, entityId: solo.id }), /unknown entity/)

  const kept = graph.createEntity({ libraryId, name: 'Kept' })
  graph.linkEntries({ libraryId, fromId: 'mem-free', toId: kept.id, kind: 'person', note: 'Kept is the person this scene is about.' })
  assert.throws(() => graph.deleteEntity({ libraryId, entityId: kept.id }), /still referenced/)
  assert.ok(readStore().entities[kept.id], 'a refused delete leaves the entity in place')
  assert.equal(state.loadPrivateIndex(libraryId).entries['mem-free'].links.length, 1, 'and its links too')
  const forced = graph.deleteEntity({ libraryId, entityId: kept.id, force: true })
  assert.equal(forced.removedLinks, 1)
  assert.deepEqual(state.loadPrivateIndex(libraryId).entries['mem-free'].links, [])
  assert.equal(readStore().entities[kept.id], undefined)
})

test('force-delete drops relationship snapshots with the entity, and the freed endpoint is collectable', () => {
  const p = graph.createEntity({ libraryId, name: 'P' })
  const q = graph.createEntity({ libraryId, name: 'Q' })
  graph.updateRelationship({ libraryId, fromId: p.id, toId: q.id, state: { trust: .5 }, evidenceIds: ['mem-free'], reason: 'The scene itself is explicit evidence.' })
  assert.throws(() => graph.deleteEntity({ libraryId, entityId: p.id }), /relationship snapshot/)
  const forced = graph.deleteEntity({ libraryId, entityId: p.id, force: true })
  assert.equal(forced.removedRelationships, 1)
  assert.equal(graph.getRelationship({ libraryId, fromId: p.id, toId: q.id }).relationship, null)
  // q has no links and no snapshot left: a prune collects it, while Yun stays.
  const pruned = graph.pruneOrphanEntities(libraryId)
  assert.ok(pruned.removed.includes(q.id), 'the freed endpoint becomes an orphan')
  const yun = Object.values(readStore().entities).find(entity => entity.name === 'Yun')
  assert.ok(!pruned.removed.includes(yun.id), 'a still-linked entity is never collected')
})

test('restoreGraphData collects entities the restored memories do not refer to', () => {
  const before = Object.keys(readStore().entities)
  const data = {
    entities: {
      'ent-ghost': { id: 'ent-ghost', name: 'Ghost', kind: 'person', aliases: [] },
      'ent-real': { id: 'ent-real', name: 'Real', kind: 'person', aliases: [] },
    },
    relationships: {},
  }
  // mem-free's link to the backup's entity id gets remapped to the restored id,
  // which is what keeps 'Real' alive while 'Ghost' (nothing refers to it) goes.
  state.updatePrivateIndex(libraryId, index => {
    index.entries['mem-free'].links = [{ to: 'ent-real', kind: 'person', note: 'Real is the person this scene is about.', confidence: 0.9 }]
  })
  graph.restoreGraphData(libraryId, data, { 'mem-old': 'mem-free' })
  const after = readStore().entities
  assert.ok(before.every(id => after[id]), 'the restore must not touch pre-existing entities')
  assert.ok(!Object.values(after).some(entity => entity.name === 'Ghost'), 'an entity nothing restored refers to is collected')
  const real = Object.values(after).find(entity => entity.name === 'Real')
  assert.ok(real, 'an entity the restored link points at survives')
  assert.equal(state.loadPrivateIndex(libraryId).entries['mem-free'].links[0].to, real.id, 'the link is remapped to the new id')
})

test('the startup sweep collects old-format orphans and is a no-op on healthy data', () => {
  const sweepBinding = state.ensureSession('sweep', { cwd: path.join(home, 'ws-sweep'), agentPreset: 'coding' })
  const sweepLib = sweepBinding.libraryId
  state.savePrivateIndex(sweepLib, { entries: {
    'mem-s': { title: 's', content: 's scene', layer: 'long_term', status: 'active', visibility: 'shared',
      links: [{ to: 'ent-kept', kind: 'person', note: 'Kept is the person this scene is about.', confidence: 0.9 }] },
  } })
  const sweepFile = path.join(indexDir(), `${sweepLib}.entities.json`)
  fs.writeFileSync(sweepFile, JSON.stringify({ version: 1, entities: {
    'ent-kept': { id: 'ent-kept', name: 'Kept', kind: 'person', aliases: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    'ent-lorn': { id: 'ent-lorn', name: 'Lorn', kind: 'thing', aliases: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  }, relationships: {} }))
  const result = graph.pruneOrphanEntitiesAll()
  assert.equal(result.failed.length, 0)
  const store = JSON.parse(fs.readFileSync(sweepFile, 'utf8'))
  assert.ok(store.entities['ent-kept'], 'a referenced entity survives the sweep')
  assert.equal(store.entities['ent-lorn'], undefined, 'old-format orphans are collected')
  const healthy = fs.readFileSync(sweepFile, 'utf8')
  const again = graph.pruneOrphanEntitiesAll()
  assert.equal(again.removed, 0, 'healthy data is a no-op')
  assert.equal(fs.readFileSync(sweepFile, 'utf8'), healthy, 'the no-op never rewrites the file')
})

test('one corrupt entity store fails alone and never blocks the sweep', () => {
  const badBinding = state.ensureSession('sweep-bad', { cwd: path.join(home, 'ws-bad'), agentPreset: 'coding' })
  fs.writeFileSync(path.join(indexDir(), `${badBinding.libraryId}.entities.json`), '{ not json')
  const result = graph.pruneOrphanEntitiesAll()
  assert.ok(result.failed.some(failure => failure.libraryId === badBinding.libraryId), 'the corrupt library is reported')
  assert.equal(result.failed.length, 1, 'other libraries are unaffected')
  assert.throws(() => graph.pruneOrphanEntities(badBinding.libraryId), /entity store/)
})

test('getGraph hides orphan entities by default and reveals them on includeOrphans', () => {
  const lonely = graph.createEntity({ libraryId, name: 'Lonely' })
  const yun = Object.values(readStore().entities).find(entity => entity.name === 'Yun')
  const bare = graph.getGraph({ libraryId })
  assert.ok(!bare.nodes.some(node => node.id === lonely.id), 'an entity no edge points at is hidden by default')
  assert.ok(bare.nodes.some(node => node.id === yun.id), 'a linked entity stays visible')
  assert.ok(bare.edges.some(edge => edge.from === 'mem-side' && edge.to === yun.id))
  const wide = graph.getGraph({ libraryId, includeOrphans: true })
  const orphanNode = wide.nodes.find(node => node.id === lonely.id)
  assert.ok(orphanNode, 'includeOrphans reveals what old data left behind')
  assert.equal(orphanNode.degree, 0)
  graph.deleteEntity({ libraryId, entityId: lonely.id })
})

test('apply() schedules the sweep late, and a corrupt store only warns instead of blocking load', async () => {
  const badLib = state.ensureSession('sweep-bad', { cwd: path.join(home, 'ws-bad'), agentPreset: 'coding' }).libraryId
  fs.writeFileSync(path.join(indexDir(), `${badLib}.entities.json`), '{ still not json')
  const info = []
  const warn = []
  const tools = []
  const scope = {
    effect(fn) { fn() },
    tools: { register(tool) { tools.push(tool); return () => {} } },
    webServer: { register() { return () => {} } },
    connection: { requestRejection: () => undefined },
    interval() { return 1 },
    on() { return () => {} },
  }
  const ctx = { ...scope, logger: { info: (m) => info.push(m), warn: (m) => warn.push(m) }, inject(_deps, callback) { callback(scope) } }
  const plugin = await import('../lib/index.js')
  plugin.apply(ctx)
  assert.ok(info.some(message => message.startsWith('dsh-memu-memory: loaded')), 'activation itself is unaffected')
  assert.equal(warn.some(message => message.includes('orphan entity sweep')), false, 'scheduling must not run the sweep synchronously')
  await new Promise(resolve => setTimeout(resolve, 4600))
  assert.ok(warn.some(message => message.includes(`orphan entity sweep skipped ${badLib}`)), 'the sweep reports the corrupt library')
  assert.equal(warn.some(message => message.includes('orphan entity sweep failed')), false, 'per-library failures stay contained')
})
