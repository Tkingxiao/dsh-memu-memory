import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-graph-'))
process.env.DSH_MEMU_HOME = home
const state = await import('../lib/state.js')
const graph = await import('../lib/graph.js')
const memory = await import('../lib/memory.js')
test.after(() => { state.flushState(); fs.rmSync(home, { recursive: true, force: true }) })
const binding = state.ensureSession('graph', { cwd: path.join(home, 'rp'), agentPreset: 'rp' })
const libraryId = binding.libraryId
const exec = { agent: { session: { header: { id: 'graph' } } } }
const entries = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`mem-${i}`, { title: `person ${i}`, content: `scene ${i}`, layer: 'long_term', status: 'active', visibility: 'shared' }]))
state.savePrivateIndex(libraryId, { entries })

test('graph stores one direction but queries both within bounded hops', () => {
  for (let i = 0; i < 9; i++) graph.linkEntries({ libraryId, fromId: `mem-${i}`, toId: `mem-${i + 1}`, kind: 'event', note: 'The same event seen from another side.' })
  const result = graph.getGraph({ libraryId, focusId: 'mem-4', depth: 1 })
  assert.deepEqual(new Set(result.nodes.map(node => node.id)), new Set(['mem-3', 'mem-4', 'mem-5']))
  assert.equal(result.edges.length, 2)
  assert.equal(state.loadPrivateIndex(libraryId).entries['mem-5'].links.length, 1)
})

test('deleted memories remain gray dangling nodes rather than hiding the edge', () => {
  state.updatePrivateIndex(libraryId, index => { delete index.entries['mem-1'] })
  const result = graph.getGraph({ libraryId, focusId: 'mem-0', depth: 1 })
  assert.equal(result.nodes.find(node => node.id === 'mem-1').missing, true)
  assert.equal(result.edges.length, 1)
})

test('entity rename changes all references without rewriting memory text', async () => {
  const entity = graph.createEntity({ libraryId, name: 'Old Zhou' })
  graph.linkEntries({ libraryId, fromId: 'mem-2', toId: entity.id, kind: 'person', note: 'Old Zhou is the person mentioned here.' })
  graph.renameEntity({ libraryId, entityId: entity.id, name: 'Zhou', aliases: ['Old Zhou'] })
  assert.equal(graph.getGraph({ libraryId, focusId: entity.id }).nodes.find(node => node.id === entity.id).title, 'Zhou')
  assert.equal(state.loadPrivateIndex(libraryId).entries['mem-2'].content, 'scene 2')
  assert.equal((await memory.privateRecall({ exec, query: 'mem-2' })).files[0].related.find(item => item.id === entity.id).title, 'Zhou')
})

test('invalid kinds, empty reasons and out-of-scope private links are rejected', () => {
  assert.throws(() => graph.linkEntries({ libraryId, fromId: 'mem-2', toId: 'mem-3', kind: 'typo', note: 'explanation' }), /link kind/)
  assert.throws(() => graph.linkEntries({ libraryId, fromId: 'mem-2', toId: 'mem-3', kind: 'event', note: '' }), /8-500/)
  // The remaining boundary is the context scope: this entry belongs to another character,
  // and this conversation has no context at all, so it must stay unreachable.
  state.updatePrivateIndex(libraryId, index => { index.entries.secret = { title: 'private title', status: 'active', visibility: 'secret', context: { characterId: 'other' } } })
  assert.throws(() => graph.linkEntries({ exec, fromId: 'mem-2', toId: 'secret', kind: 'event', note: 'a very long explanation' }), /inaccessible/)
  assert.ok(!JSON.stringify(graph.getGraph({ exec })).includes('private title'))
})

test('graphs cap nodes at 200 and the recall carries at most two pointers', async () => {
  state.updatePrivateIndex(libraryId, index => {
    for (let i = 10; i < 400; i++) index.entries[`mem-${i}`] = { title: `node ${i}`, status: 'active', content: 'node' }
  })
  const result = graph.getGraph({ libraryId, limit: 5000 })
  assert.equal(result.nodes.length, 200)
  assert.equal(result.truncated, true)
  assert.ok((await memory.privateRecall({ exec, query: 'mem-2' })).files[0].related.length <= 2)
})

test('relationship snapshots preserve unknowns, evidence, boundaries and previous versions', () => {
  const a = graph.createEntity({ libraryId, name: 'A' })
  const b = graph.createEntity({ libraryId, name: 'B' })
  const initial = graph.updateRelationship({ libraryId, fromId: a.id, toId: b.id,
    state: { trust: .7, boundaries: ['Do not volunteer private stories.'], openPromises: ['Answer on Friday.'] },
    evidenceIds: ['mem-2'], reason: 'Friday promise is explicit evidence.' }).relationship
  assert.equal(initial.state.warmth, null, 'unknown is not a neutral or affectionate score')
  graph.updateRelationship({ libraryId, fromId: a.id, toId: b.id,
    state: { trust: .75, boundaries: initial.state.boundaries, callbacks: ['the station roof'], openPromises: [] },
    evidenceIds: ['mem-2'], reason: 'The answer was delivered explicitly.' })
  const next = graph.getRelationship({ libraryId, fromId: a.id, toId: b.id }).relationship
  assert.equal(next.history.length, 1)
  assert.deepEqual(next.history[0].state.openPromises, ['Answer on Friday.'])
  assert.ok(next.history[0].validTo)
  assert.throws(() => graph.updateRelationship({ libraryId, fromId: a.id, toId: b.id, state: {}, evidenceIds: [], reason: 'no evidence' }), /evidence/)
})

test('a dangling edge is reported as missing, matching the graph view placeholder', () => {
  // mem-1 was deleted from the index in an earlier test; its inbound edge from
  // mem-0 remains. getGraph renders a [deleted] placeholder for it, so recall
  // must report the same edge with the same missing mark instead of dropping it.
  const view = graph.getGraph({ libraryId, focusId: 'mem-0', depth: 1 })
  assert.equal(view.nodes.find(node => node.id === 'mem-1').missing, true)
  const related = graph.recallRelations(libraryId, state.loadPrivateIndex(libraryId), 'mem-0', null)
  const dangling = related.find(item => item.id === 'mem-1')
  assert.ok(dangling, 'the edge must be reported, not silently dropped')
  assert.equal(dangling.missing, true)
  assert.equal(dangling.title, '[deleted]')
  // mem-2 still links at the Zhou entity: a resolvable relation is marked false.
  const zhou = Object.values(graph.graphExport(libraryId).entities).find(entity => entity.name === 'Zhou')
  const healthy = graph.recallRelations(libraryId, state.loadPrivateIndex(libraryId), 'mem-2', null)
  assert.equal(healthy.find(item => item.id === zhou.id).missing, false)
})
