import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 工单 F：实体主节点合并（§9）。断言针对库内实体文件与私有索引的真实落盘状态，
// 不 mock 存储层——合并的价值就在于两个文件一起收敛，且中途失败不能留下悬空边。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-entity-merge-'))
process.env.DSH_MEMU_HOME = home
const state = await import('../lib/state.js')
const graph = await import('../lib/graph.js')
const { indexDir } = await import('../lib/paths.js')
const { listEvents } = await import('../lib/activity-log.js')

test.after(() => { state.flushState(); fs.rmSync(home, { recursive: true, force: true }) })

function newLibrary(name) {
  return state.ensureSession(name, { cwd: path.join(home, name), agentPreset: 'rp' }).libraryId
}
const entitiesFile = (libraryId) => path.join(indexDir(), `${libraryId}.entities.json`)
const readStore = (libraryId) => JSON.parse(fs.readFileSync(entitiesFile(libraryId), 'utf8'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('mergeEntities remaps every link to the target, dedupes (to, kind) and deletes the sources', () => {
  const libraryId = newLibrary('merge-core')
  const target = graph.createEntity({ libraryId, name: 'Lin Mian', kind: 'person', aliases: ['Mian'] })
  const source1 = graph.createEntity({ libraryId, name: 'Lin', kind: 'person', aliases: ["Mian'er"] })
  const source2 = graph.createEntity({ libraryId, name: 'Mian', kind: 'person', aliases: ['Lin Mian'] })
  state.savePrivateIndex(libraryId, { entries: {
    'mem-merge-a': { title: 'a', content: 'a scene', status: 'active', visibility: 'shared', links: [
      { to: source1.id, kind: 'person', note: 'Lin is the person this scene is about.', confidence: 0.9 },
      { to: target.id, kind: 'person', note: 'The pre-existing target edge wins the dedupe.', confidence: 0.4 },
      { to: source1.id, kind: 'relation', note: 'Lin is related to the events in this scene.', confidence: 0.5 },
      { to: 'mem-merge-b', kind: 'event', note: 'The same event seen from another side.', confidence: 0.6 },
    ] },
    'mem-merge-b': { title: 'b', content: 'b scene', status: 'active', visibility: 'shared', links: [
      { to: source2.id, kind: 'person', note: 'Mian is the person this scene is about.', confidence: 0.8, source: 'auto' },
      { to: source1.id, kind: 'person', note: 'The same person named Lin again.', confidence: 0.7 },
    ] },
  } })

  const result = graph.mergeEntities({ libraryId, targetId: target.id, sourceIds: [source1.id, source2.id] })
  assert.equal(result.targetId, target.id)
  assert.deepEqual(result.merged, [source1.id, source2.id])
  assert.equal(result.remappedLinks, 4, 'every link that pointed at a source is redirected')
  assert.equal(result.duplicateLinks, 2, 'the second (to, kind) pair per entry is dropped')
  assert.deepEqual(result.relationships, { moved: 0, conflicts: [] })
  assert.deepEqual(result.droppedAliases, [])
  assert.deepEqual(result.aliases, ['Mian', 'Lin', "Mian'er", 'Lin Mian'])

  const index = state.loadPrivateIndex(libraryId)
  const allLinks = Object.values(index.entries).flatMap(entry => entry.links || [])
  assert.ok(allLinks.every(link => link.to !== source1.id && link.to !== source2.id), 'no link survives pointing at a merged source')
  const aLinks = index.entries['mem-merge-a'].links
  assert.equal(aLinks.filter(link => link.to === target.id && link.kind === 'person').length, 1)
  assert.equal(aLinks.find(link => link.to === target.id && link.kind === 'person').note, 'The pre-existing target edge wins the dedupe.')
  assert.equal(aLinks.find(link => link.to === target.id && link.kind === 'relation').confidence, 0.5)
  const bLinks = index.entries['mem-merge-b'].links
  assert.equal(bLinks.length, 1, 'the duplicate source edge is dropped')
  assert.equal(bLinks[0].to, target.id)
  assert.equal(bLinks[0].source, 'auto', 'auto metadata survives the merge')

  const store = graph.graphExport(libraryId)
  assert.equal(store.entities[source1.id], undefined)
  assert.equal(store.entities[source2.id], undefined)
  assert.equal(store.entities[target.id].name, 'Lin Mian', 'the target name stays the display name')
  assert.deepEqual(store.entities[target.id].aliases, ['Mian', 'Lin', "Mian'er", 'Lin Mian'])

  const view = graph.getGraph({ libraryId, focusId: 'mem-merge-b', depth: 1 })
  assert.ok(view.nodes.some(node => node.id === target.id && node.title === 'Lin Mian'))
  assert.ok(!view.nodes.some(node => node.id === source1.id || node.id === source2.id), 'getGraph resolves the merged ids, not placeholders')

  const events = listEvents({ limit: 100, kind: 'write' })
  const event = events.find(item => item.detail?.op === 'entity-merge' && item.detail?.targetId === target.id)
  assert.ok(event, 'the merge is recorded in the activity log')
  assert.deepEqual(event.refs, [target.id, source1.id, source2.id])
  assert.equal(event.ok, true)
})

test('mergeEntities unions aliases, caps at 30 and reports the dropped tail', () => {
  const libraryId = newLibrary('merge-aliases')
  const targetAliases = Array.from({ length: 10 }, (_, index) => `target-alias-${index}`)
  const source1Aliases = Array.from({ length: 25 }, (_, index) => `source-one-alias-${index}`)
  const source2Aliases = Array.from({ length: 10 }, (_, index) => `source-two-alias-${index}`)
  const target = graph.createEntity({ libraryId, name: 'Alias Target', kind: 'person', aliases: targetAliases })
  const source1 = graph.createEntity({ libraryId, name: 'Alias Source One', kind: 'person', aliases: source1Aliases })
  const source2 = graph.createEntity({ libraryId, name: 'Alias Source Two', kind: 'person', aliases: source2Aliases })
  const union = [...targetAliases, 'Alias Source One', ...source1Aliases, 'Alias Source Two', ...source2Aliases]

  const result = graph.mergeEntities({ libraryId, targetId: target.id, sourceIds: [source1.id, source2.id] })
  assert.equal(result.aliases.length, 30)
  assert.deepEqual(result.aliases, union.slice(0, 30))
  assert.deepEqual(result.droppedAliases, union.slice(30))
  assert.equal(result.droppedAliases.length, union.length - 30)
  const stored = readStore(libraryId).entities[target.id]
  assert.ok(stored, 'the merge target is never collected by the safety-net prune, even while unreferenced')
  assert.equal(stored.name, 'Alias Target')
  assert.deepEqual(stored.aliases, union.slice(0, 30))
})

test('mergeEntities rejects kind mismatches, self-sources, empty lists and unknown ids without writing', () => {
  const libraryId = newLibrary('merge-validation')
  const otherLibraryId = newLibrary('merge-validation-other')
  const keep = graph.createEntity({ libraryId, name: 'Keep', kind: 'person' })
  const otherKind = graph.createEntity({ libraryId, name: 'Keep Place', kind: 'place' })
  const peer = graph.createEntity({ libraryId, name: 'Peer', kind: 'person' })
  const foreign = graph.createEntity({ libraryId: otherLibraryId, name: 'Foreign', kind: 'person' })
  state.savePrivateIndex(libraryId, { entries: {
    'mem-validation': { title: 'validation', content: 'validation scene', status: 'active', visibility: 'shared', links: [
      { to: peer.id, kind: 'person', note: 'Peer is the person this scene is about.', confidence: 0.9 },
    ] },
  } })
  const before = fs.readFileSync(entitiesFile(libraryId), 'utf8')
  assert.throws(() => graph.mergeEntities({ libraryId, targetId: keep.id, sourceIds: [otherKind.id] }), /different kinds/)
  assert.throws(() => graph.mergeEntities({ libraryId, targetId: keep.id, sourceIds: [keep.id] }), /own sources/)
  assert.throws(() => graph.mergeEntities({ libraryId, targetId: keep.id, sourceIds: [] }), /non-empty array/)
  assert.throws(() => graph.mergeEntities({ libraryId, targetId: keep.id }), /non-empty array/)
  assert.throws(() => graph.mergeEntities({ libraryId, targetId: keep.id, sourceIds: [peer.id, 'ent-ghost'] }), /unknown entity/)
  assert.throws(() => graph.mergeEntities({ libraryId, targetId: keep.id, sourceIds: [foreign.id] }), /unknown entity/, 'an id that lives in another library is not mergeable here')
  assert.throws(() => graph.mergeEntities({ libraryId, targetId: 'ent-ghost', sourceIds: [peer.id] }), /unknown entity/)
  assert.throws(() => graph.mergeEntities({ targetId: keep.id, sourceIds: [peer.id] }), /no bound session/)
  assert.equal(fs.readFileSync(entitiesFile(libraryId), 'utf8'), before, 'a rejected merge never rewrites the entity store')
  const links = state.loadPrivateIndex(libraryId).entries['mem-validation'].links
  assert.deepEqual(links.map(link => link.to), [peer.id])
})

test('mergeEntities re-keys relationship snapshots, preserves the target side and reports conflicts', () => {
  const libraryId = newLibrary('merge-relationships')
  const target = graph.createEntity({ libraryId, name: 'Target', kind: 'person' })
  const source1 = graph.createEntity({ libraryId, name: 'Source One', kind: 'person' })
  const source2 = graph.createEntity({ libraryId, name: 'Source Two', kind: 'person' })
  const buddy = graph.createEntity({ libraryId, name: 'Buddy', kind: 'person' })
  const companion = graph.createEntity({ libraryId, name: 'Companion', kind: 'person' })
  const orphan = graph.createEntity({ libraryId, name: 'Orphan', kind: 'person' })
  state.savePrivateIndex(libraryId, { entries: {
    'mem-rel-evidence': { title: 'evidence', content: 'evidence scene', status: 'active', visibility: 'shared' },
  } })
  graph.updateRelationship({ libraryId, fromId: target.id, toId: buddy.id, state: { trust: 0.2 }, evidenceIds: ['mem-rel-evidence'], reason: 'The target-side snapshot is the older evidence.' })
  graph.updateRelationship({ libraryId, fromId: source1.id, toId: buddy.id, state: { trust: 0.9 }, evidenceIds: ['mem-rel-evidence'], reason: 'The source-side snapshot is the newer evidence.' })
  graph.updateRelationship({ libraryId, fromId: buddy.id, toId: source1.id, state: { warmth: 0.4 }, evidenceIds: ['mem-rel-evidence'], reason: 'The reverse direction is its own snapshot.' })
  graph.updateRelationship({ libraryId, fromId: buddy.id, toId: source1.id, state: { warmth: 0.5 }, evidenceIds: ['mem-rel-evidence'], reason: 'A second revision gives the snapshot history.' })
  graph.updateRelationship({ libraryId, fromId: source1.id, toId: source2.id, state: { trust: 0.3 }, evidenceIds: ['mem-rel-evidence'], reason: 'A source-only snapshot becomes a self loop.' })
  graph.updateRelationship({ libraryId, fromId: source2.id, toId: companion.id, state: { familiarity: 0.6 }, evidenceIds: ['mem-rel-evidence'], reason: 'A source behind the relationship moves with it.' })

  const result = graph.mergeEntities({ libraryId, targetId: target.id, sourceIds: [source1.id, source2.id] })
  assert.deepEqual(result.relationships, {
    moved: 2,
    conflicts: [
      { key: JSON.stringify([source1.id, buddy.id]), reason: 'existing-target', keptKey: JSON.stringify([target.id, buddy.id]) },
      { key: JSON.stringify([source1.id, source2.id]), reason: 'self' },
    ],
  })
  const kept = graph.getRelationship({ libraryId, fromId: target.id, toId: buddy.id }).relationship
  assert.equal(kept.state.trust, 0.2, 'the existing target-side snapshot is not overwritten')
  assert.equal(kept.revision, 1)
  const moved = graph.getRelationship({ libraryId, fromId: buddy.id, toId: target.id }).relationship
  assert.equal(moved.fromId, buddy.id)
  assert.equal(moved.toId, target.id)
  assert.equal(moved.state.warmth, 0.5)
  assert.equal(moved.history.length, 1, 'history moves with the snapshot')
  assert.equal(moved.revision, 2)
  const movedOut = graph.getRelationship({ libraryId, fromId: target.id, toId: companion.id }).relationship
  assert.equal(movedOut.state.familiarity, 0.6)
  assert.equal(graph.getRelationship({ libraryId, fromId: source1.id, toId: buddy.id }).relationship, null, 'no old source key survives')
  const store = graph.graphExport(libraryId)
  assert.ok(Object.keys(store.relationships).every(key => !key.includes(source1.id) && !key.includes(source2.id)))
  assert.equal(store.entities[orphan.id], undefined, 'the prune safety net collected the unrelated orphan')
  assert.ok(store.entities[target.id], 'the target itself stays')
})

test('suggestEntityMerges: containment and normalization produce shorter→longer pairs', () => {
  const libraryId = newLibrary('suggest-names')
  const lin = graph.createEntity({ libraryId, name: 'Lin', kind: 'person' })
  const linMian = graph.createEntity({ libraryId, name: 'Lin Mian', kind: 'person' })
  const lower = graph.createEntity({ libraryId, name: 'lin', kind: 'person' })
  const yuike = graph.createEntity({ libraryId, name: 'YUIKE', kind: 'person' })
  const tanaka = graph.createEntity({ libraryId, name: 'ｙｕｉｋｅ tanaka', kind: 'person' })
  const place = graph.createEntity({ libraryId, name: 'Lin Road', kind: 'place' })

  const { items } = graph.suggestEntityMerges({ libraryId })
  const pair = (source, target) => items.find(item => item.sourceId === source.id && item.targetId === target.id)
  assert.ok(pair(lin, linMian), 'the shorter normalized name folds into the longer one')
  assert.ok(pair(lower, linMian))
  assert.equal(pair(lin, linMian).reason, 'containment')
  assert.ok(pair(yuike, tanaka), 'NFKC/case folding finds the full-width variant')
  assert.ok(!items.some(item => (item.sourceId === lin.id && item.targetId === lower.id) || (item.sourceId === lower.id && item.targetId === lin.id)),
    'identical normalized names are not a candidate')
  assert.ok(!items.some(item => (item.sourceId === place.id && item.targetId === lin.id) || (item.sourceId === lin.id && item.targetId === place.id)),
    'different kinds never pair up')
  assert.ok(!items.some(item => item.sourceId === place.id || item.targetId === place.id), 'the place has no same-kind candidate')
})

test('suggestEntityMerges: near-miss spellings within two edits are candidates, with a stable direction', async () => {
  const libraryId = newLibrary('suggest-edit')
  const kyle = graph.createEntity({ libraryId, name: 'Kyle', kind: 'person' })
  await sleep(5)
  const kile = graph.createEntity({ libraryId, name: 'Kile', kind: 'person' })
  await sleep(5)
  const marcus = graph.createEntity({ libraryId, name: 'Marcus', kind: 'person' })
  await sleep(5)
  const marcos = graph.createEntity({ libraryId, name: 'Marcos', kind: 'person' })

  const first = graph.suggestEntityMerges({ libraryId })
  const second = graph.suggestEntityMerges({ libraryId })
  assert.deepEqual(first, second, 'suggestion order is deterministic')
  assert.equal(first.items.length, 2)
  assert.ok(first.items.every(item => item.reason === 'edit-distance'))
  assert.deepEqual(first.items.find(item => [item.sourceId, item.targetId].includes(kyle.id)),
    { sourceId: kile.id, targetId: kyle.id, reason: 'edit-distance' }, 'equal length folds into the older id')
  assert.deepEqual(first.items.find(item => [item.sourceId, item.targetId].includes(marcus.id)),
    { sourceId: marcos.id, targetId: marcus.id, reason: 'edit-distance' })
})

test('suggestEntityMerges: kind mismatch and identical folded names yield no candidates', () => {
  const libraryId = newLibrary('suggest-filter')
  graph.createEntity({ libraryId, name: 'Aria', kind: 'person' })
  graph.createEntity({ libraryId, name: 'Ariadne', kind: 'place' })
  graph.createEntity({ libraryId, name: 'Mika', kind: 'person' })
  graph.createEntity({ libraryId, name: 'MIKA', kind: 'person' })
  assert.deepEqual(graph.suggestEntityMerges({ libraryId }), { items: [] })
})

test('suggestEntityMerges: unrelated names yield an empty list', () => {
  const libraryId = newLibrary('suggest-none')
  graph.createEntity({ libraryId, name: 'Zephyr', kind: 'person' })
  graph.createEntity({ libraryId, name: 'Quartz', kind: 'person' })
  assert.deepEqual(graph.suggestEntityMerges({ libraryId }).items, [])
})

test('suggestEntityMerges caps the list at 20 and never writes', () => {
  const libraryId = newLibrary('suggest-cap')
  for (let index = 0; index < 25; index += 1) {
    const suffix = String(index).padStart(2, '0')
    graph.createEntity({ libraryId, name: `NestBase${suffix}`, kind: 'person' })
    graph.createEntity({ libraryId, name: `NestBase${suffix}Extra`, kind: 'person' })
  }
  const file = entitiesFile(libraryId)
  const before = fs.readFileSync(file, 'utf8')
  const first = graph.suggestEntityMerges({ libraryId })
  const second = graph.suggestEntityMerges({ libraryId })
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'suggesting is a pure read')
  assert.deepEqual(second, first)
  assert.equal(first.items.length, 20)
  assert.ok(first.items.every(item => item.sourceId && item.targetId && item.sourceId !== item.targetId))
  assert.ok(first.items.every(item => item.reason === 'containment' || item.reason === 'edit-distance'))
})

test('the RPC cases take exactly the payload the graph panel sends', async () => {
  const libraryId = newLibrary('rpc-shape')
  const target = graph.createEntity({ libraryId, name: '林眠儿', kind: 'person' })
  const source = graph.createEntity({ libraryId, name: '林眠', kind: 'person' })
  const rpc = await import('../lib/rpc.js')
  const suggested = await rpc.dispatch({}, 'suggestEntityMerges', { libraryId })
  assert.deepEqual(suggested.items, [{ sourceId: source.id, targetId: target.id, reason: 'containment' }])
  // 面板一次只确认一对：sourceIds 是数组，但 UI 传的就是单个来源。
  const merged = await rpc.dispatch({}, 'mergeEntities', { libraryId, targetId: target.id, sourceIds: [source.id] })
  assert.equal(merged.targetId, target.id)
  assert.deepEqual(merged.merged, [source.id])
  assert.ok(merged.aliases.includes('林眠'), 'the source name becomes an alias of the main node')
})
