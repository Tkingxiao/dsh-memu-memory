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

test('deleteEntity tolerates a corrupt relationship key and never loses a readable snapshot', () => {
  const target = graph.createEntity({ libraryId, name: 'CorruptTarget' })
  const other = graph.createEntity({ libraryId, name: 'CorruptOther' })
  const outsider = graph.createEntity({ libraryId, name: 'CorruptOutsider' })
  const targetKey = JSON.stringify([target.id, other.id])
  const unrelatedKey = JSON.stringify([other.id, outsider.id])
  const corruptKey = 'not-json\u0000relationship'
  const store = readStore()
  store.relationships[targetKey] = { fromId: target.id, toId: other.id, state: { trust: 0.5 }, history: [], evidenceIds: ['mem-free'] }
  store.relationships[unrelatedKey] = { fromId: other.id, toId: outsider.id, state: { trust: 0.4 }, history: [], evidenceIds: ['mem-free'] }
  store.relationships[corruptKey] = { fromId: 'x', toId: 'y', state: {}, history: [], evidenceIds: [] }
  fs.writeFileSync(entitiesFile, JSON.stringify(store))
  // 未 force：损坏 key 只是读不懂的历史，不能把「仍被引用」的拒绝变成 SyntaxError。
  assert.throws(() => graph.deleteEntity({ libraryId, entityId: target.id }), /relationship snapshot/)
  // force：只删除可读且真的指向 target 的快照；损坏 key 与无关好边原样保留。
  const forced = graph.deleteEntity({ libraryId, entityId: target.id, force: true })
  assert.equal(forced.removedRelationships, 1)
  const after = readStore()
  assert.equal(after.relationships[targetKey], undefined, 'the readable edge to the target is gone')
  assert.ok(after.relationships[unrelatedKey], 'an unrelated readable edge is never silently dropped')
  assert.ok(after.relationships[corruptKey], 'the corrupt key is preserved, not deleted as a side effect')
  // 清理，避免坏 key 影响本文件后续的 prune/list 断言。
  delete after.relationships[unrelatedKey]
  delete after.relationships[corruptKey]
  delete after.entities[other.id]
  delete after.entities[outsider.id]
  fs.writeFileSync(entitiesFile, JSON.stringify(after))
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

test('apply() schedules the sweep late, and a corrupt store only warns instead of blocking load', async () => {  const badLib = state.ensureSession('sweep-bad', { cwd: path.join(home, 'ws-bad'), agentPreset: 'coding' }).libraryId
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

// ---- §6.4 包 D：linked 派生字段与删除路径的一致性 ----
// 只有 relationship、没有 memory link 的实体是历史，不是孤儿——linked 必须为
// true，启动 prune 也必须放行它；判定口径与 pruneOrphanEntities 完全一致。

test('a relationship-only entity is linked, not an orphan, and prune agrees', () => {
  const soloA = graph.createEntity({ libraryId, name: 'RelOnlyA' })
  const soloB = graph.createEntity({ libraryId, name: 'RelOnlyB' })
  graph.updateRelationship({ libraryId, fromId: soloA.id, toId: soloB.id, state: { familiarity: 0.4 }, evidenceIds: ['mem-free'], reason: 'The free scene is explicit evidence.' })
  const rows = graph.listEntities({ libraryId }).items
  const rowA = rows.find(entity => entity.id === soloA.id)
  const rowB = rows.find(entity => entity.id === soloB.id)
  assert.ok(rowA && rowB, 'no session means the pair comes back with everyone else')
  assert.equal(rowA.linked, true, 'a snapshot endpoint is a reference even without any memory link')
  assert.equal(rowB.linked, true)
  const pruned = graph.pruneOrphanEntities(libraryId)
  assert.ok(!pruned.removed.includes(soloA.id) && !pruned.removed.includes(soloB.id),
    'the prune must share the linked judgement, never collect snapshot-referenced entities')
})

test('the linked flag tracks a refused delete through force, and cleanup drops the row', () => {
  const kept = graph.createEntity({ libraryId, name: 'FlagKept' })
  graph.linkEntries({ libraryId, fromId: 'mem-free', toId: kept.id, kind: 'person', note: 'FlagKept is the person this scene is about.' })
  let row = graph.listEntities({ libraryId }).items.find(entity => entity.id === kept.id)
  assert.equal(row.linked, true, 'an inbound link shows up as linked before any delete')
  assert.throws(() => graph.deleteEntity({ libraryId, entityId: kept.id }), /still referenced/, 'the refusal keeps both the row and its link')
  assert.ok(graph.listEntities({ libraryId }).items.some(entity => entity.id === kept.id))
  const forced = graph.deleteEntity({ libraryId, entityId: kept.id, force: true })
  assert.equal(forced.deleted, true)
  assert.equal(forced.removedLinks, 1, 'force sweeps the inbound link')
  assert.ok(state.loadPrivateIndex(libraryId).entries['mem-free'].links.every(link => link.to !== kept.id), 'the forced delete sweeps the inbound link of this entity')
  row = graph.listEntities({ libraryId }).items.find(entity => entity.id === kept.id)
  assert.equal(row, undefined, 'after the force delete the entity is gone from the listing too')
})

// ---------------------------------------------------------------- 实体碎片修复
// 老版本把中文名的滑窗片段建成了独立节点。这里的不变量有两条：可证明的才自动合，
// 相似的绝不动；而且合并级联的全库清扫不能顺手删掉计划外的节点（硬规则 5）。
const repair = await import('../lib/entity-repair.js')
const repairLibrary = (name, entries, entities) => {
  const id = state.createLibrary({ name, cwd: path.join(home, name) }).id
  for (const entity of entities) graph.createEntity({ libraryId: id, name: entity, kind: 'person', status: 'confirmed' })
  state.savePrivateIndex(id, { entries })
  return id
}
const scene = (title, content) => ({ title, content, status: 'active', visibility: 'shared', layer: 'long_term' })

test('the fragment plan separates provable windows from merely similar names', () => {
  const attestedRebuild = repairLibrary('repair-rebuild',
    { 'mem-1': scene('南宫晚晴的午后', '南宫晚晴坐在窗边讲这件事。') },
    ['南宫晚', '宫晚晴'])
  const plan = repair.planLibraryRepair(attestedRebuild, { graph, loadPrivateIndex: state.loadPrivateIndex })
  assert.equal(plan.groups.length, 1, 'the two windows rebuild into one provable group')
  assert.equal(plan.groups[0].creates, true, 'no full-name node exists yet, so the reconstructed one is created')
  assert.equal(plan.groups[0].target.name, '南宫晚晴')
  assert.deepEqual(plan.ambiguous, [], 'nothing here rests on similarity alone')

  const independent = repairLibrary('repair-independent',
    { 'mem-1': scene('化学课', '今天讲化学，顺带写了化学式。') },
    ['化学式', '化学'])
  const second = repair.planLibraryRepair(independent, { graph, loadPrivateIndex: state.loadPrivateIndex })
  assert.deepEqual(second.groups, [], 'a name that appears on its own is never treated as a window')
  assert.equal(second.ambiguous.length, 1)
  assert.equal(second.ambiguous[0].evidence, 'similar')

  const lookalike = repairLibrary('repair-lookalike',
    { 'mem-1': scene('两个称呼', '顾清欢也叫顾清悦，其实指的是不同的两只。') },
    ['顾清欢', '顾清悦'])
  const third = repair.planLibraryRepair(lookalike, { graph, loadPrivateIndex: state.loadPrivateIndex })
  assert.deepEqual(third.groups, [], 'edit distance is not evidence: nothing is auto-merged')
  assert.equal(third.ambiguous.length, 1, 'but the pair is still reported for a human decision')
})

test('applying the plan folds fragments into the reconstructed name and leaves memory bodies alone', () => {
  const id = repairLibrary('repair-apply',
    { 'mem-1': scene('南宫晚晴的午后', '南宫晚晴坐在窗边，南宫晚先到。') },
    ['南宫晚', '宫晚晴'])
  const before = Object.entries(state.loadPrivateIndex(id).entries)
    .map(([key, entry]) => [key, entry.title, entry.content])
  const plan = repair.planLibraryRepair(id, { graph, loadPrivateIndex: state.loadPrivateIndex })
  const result = repair.applyRepairGroups(id, plan.groups, { graph })
  assert.equal(result.merged, 1)
  assert.equal(result.created, 1)
  assert.deepEqual(result.failures, [])
  assert.deepEqual(Object.entries(state.loadPrivateIndex(id).entries)
    .map(([key, entry]) => [key, entry.title, entry.content]), before,
  'the repair never rewrites a memory title or body; it only re-points entity links')

  const after = graph.listEntities({ libraryId: id }).items
  assert.equal(after.length, 1, 'one surviving node: ' + after.map(entity => entity.name).join(','))
  assert.equal(after[0].name, '南宫晚晴')
  assert.deepEqual(after[0].aliases.sort(), ['南宫晚', '宫晚晴'])

  // 幂等：合过之后再规划，没有可证明的组，也没有相似组。
  const again = repair.planLibraryRepair(id, { graph, loadPrivateIndex: state.loadPrivateIndex })
  assert.deepEqual(again.groups, [])
  assert.deepEqual(again.ambiguous, [])
})

test('the merge cascade never deletes an entity the repair did not plan to touch', () => {  const id = repairLibrary('repair-collateral',
    { 'mem-1': scene('南宫晚晴与旁观者', '南宫晚晴坐在窗边，旁观者路过。') },
    ['南宫晚', '宫晚晴', '旁观者'])
  state.updatePrivateIndex(id, index => {
    index.entries['mem-1'].links = [{ to: 'ent-unknown', kind: 'person', note: 'placeholder', confidence: 0.6 }]
  })
  const plan = repair.planLibraryRepair(id, { graph, loadPrivateIndex: state.loadPrivateIndex })
  const result = repair.applyRepairGroups(id, plan.groups, { graph })
  assert.equal(result.merged, 1)
  assert.ok(result.restored >= 1, 'the unreferenced bystander was swept by pruneOrphanEntities and written back')
  const names = graph.listEntities({ libraryId: id, }).items.map(entity => entity.name)
  assert.ok(names.includes('南宫晚晴'), 'the repaired hub survives')
  assert.ok(names.includes('旁观者'), 'an entity outside the plan is still there: ' + names.join(','))
})

test('the upgrade pass merges provable fragments once, leaves similar names for a human, and says so', async () => {
  const { runEntityRepairPass } = await import('../lib/index.js')
  const provable = repairLibrary('upgrade-provable',
    { 'mem-1': scene('南宫晚晴的午后', '南宫晚晴坐在窗边讲这件事。') },
    ['南宫晚', '宫晚晴'])
  const similar = repairLibrary('upgrade-similar',
    { 'mem-1': scene('两个称呼', '顾清欢也叫顾清悦，其实指的是不同的两只。') },
    ['顾清欢', '顾清悦'])
  const events = []
  const first = await runEntityRepairPass({ diagnose: (row) => events.push(row) })
  assert.equal(first.deferred, false, 'the backup is available here, so the pass is allowed to write')
  assert.ok(first.merged >= 1, 'the provable pair is folded without asking: ' + JSON.stringify(first))
  assert.ok(first.similar >= 1, 'similar pairs are counted, never merged: ' + JSON.stringify(first))
  assert.ok(graph.listEntities({ libraryId: provable }).items.some((entity) => entity.name === '南宫晚晴'))
  assert.equal(graph.listEntities({ libraryId: similar }).items.length, 2, 'similar names are left exactly as they were')
  assert.ok(events.some((row) => row.code === 'ENTITY_FRAGMENT_REPAIRED'), 'what got folded is recorded, not silent')
  assert.ok(events.some((row) => row.code === 'ENTITY_FRAGMENT_SUSPECTED' && row.manual === true),
    'the leftover is recorded as needing confirmation')
  assert.ok(state.getCycleState().entityRepairVersion >= 1, 'the pass marks itself done so it never repeats')

  const second = await runEntityRepairPass({ diagnose: (row) => events.push(row) })
  assert.deepEqual(second, { skipped: 'done' }, 'one pass per install, no repeated writes on every start')

  // 开关必须是可写且真起作用的：把标记抹掉、关掉开关，重跑就不能动任何数据。
  const before = graph.listEntities({ libraryId: provable }).items.map((entity) => entity.name).join(',')
  state.setCycleState({ entityRepairVersion: 0 })
  state.updateSettings({ autoRepairEntityFragments: false })
  const third = await runEntityRepairPass({ diagnose: () => {} })
  assert.deepEqual(third, { skipped: 'setting' }, 'off means even the provable class waits for a human')
  assert.equal(graph.listEntities({ libraryId: provable }).items.map((entity) => entity.name).join(','), before)
})
