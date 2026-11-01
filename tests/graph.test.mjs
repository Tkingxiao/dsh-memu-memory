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

test('an explicit link source persists on the record and surfaces on graph edges', () => {
  state.updatePrivateIndex(libraryId, index => {
    index.entries['mem-src-a'] = { title: 'alpha note', content: 'alpha body', status: 'active', visibility: 'shared' }
    index.entries['mem-src-b'] = { title: 'beta note', content: 'beta body', status: 'active', visibility: 'shared' }
    index.entries['mem-src-c'] = { title: 'gamma note', content: 'gamma body', status: 'active', visibility: 'shared' }
  })
  const linked = graph.linkEntries({
    libraryId, fromId: 'mem-src-a', toId: 'mem-src-b', kind: 'relation',
    note: 'Auto-linked because both memories share the stable name Alpha.', source: 'auto',
  })
  assert.equal(linked.source, 'auto')
  const stored = () => state.loadPrivateIndex(libraryId).entries['mem-src-a'].links
  assert.equal(stored().find(link => link.to === 'mem-src-b').source, 'auto', 'auto is persisted, not only returned')

  // Replacement stays idempotent and the source survives the rewrite.
  graph.linkEntries({
    libraryId, fromId: 'mem-src-a', toId: 'mem-src-b', kind: 'relation',
    note: 'Re-linked after a rerun with the same evidence.', source: 'auto',
  })
  const replaced = stored().filter(link => link.to === 'mem-src-b')
  assert.equal(replaced.length, 1, 'the same (to, kind) pair is replaced in place')
  assert.equal(replaced[0].source, 'auto')

  // Only auto/user are meaningful; anything else is omitted rather than stored.
  graph.linkEntries({
    libraryId, fromId: 'mem-src-b', toId: 'mem-src-c', kind: 'event',
    note: 'The same event seen from another side.', source: 'robot',
  })
  assert.equal(state.loadPrivateIndex(libraryId).entries['mem-src-b'].links[0].source, undefined)

  const view = graph.getGraph({ libraryId, focusId: 'mem-src-b', depth: 1 })
  const autoEdge = view.edges.find(edge => edge.from === 'mem-src-a' && edge.to === 'mem-src-b')
  assert.equal(autoEdge.source, 'auto', 'the UI can tag an auto link')
  assert.equal(autoEdge.kind, 'relation', 'link semantics are unchanged')
  const plainEdge = view.edges.find(edge => edge.from === 'mem-src-b')
  assert.equal(plainEdge.source, null, 'a link without a source reports null, not undefined')
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

// ---- §6.4 包 D：listEntities 的 linked 派生字段与孤立判定 ----
// 前提（合并稿 0.2 纠正）：无 session 本来就返回全部实体——不"放开过滤"，
// 只加 linked 标记；有 session 才按可见引用收窄。

test('listEntities: without a session every entity returns, with a correct derived linked flag', () => {
  const binding = state.ensureSession('vis-all', { cwd: path.join(home, 'ws-vis-all'), agentPreset: 'rp' })
  const lib = binding.libraryId
  const anchored = graph.createEntity({ libraryId: lib, name: 'Anchored' })
  const drifting = graph.createEntity({ libraryId: lib, name: 'Drifting' })
  state.savePrivateIndex(lib, { entries: {
    'mem-anchored': { title: 'anchored', content: 'scene', layer: 'long_term', status: 'active', visibility: 'shared',
      links: [{ to: anchored.id, kind: 'person', note: 'Anchored is the person this scene is about.', confidence: 0.9 }] },
  } })
  const all = graph.listEntities({ libraryId: lib })
  assert.equal(all.items.length, 2, 'without a session the full entity list comes back')
  assert.equal(all.total, 2)
  const anchoredRow = all.items.find(entity => entity.id === anchored.id)
  const driftingRow = all.items.find(entity => entity.id === drifting.id)
  assert.equal(anchoredRow.linked, true, 'a link target is linked')
  assert.equal(driftingRow.linked, false, 'an entity nothing points at is unlinked')
  // linked 是运行时派生字段：实体文件里绝不出现它，启动 prune 的判定不受污染。
  assert.equal(graph.graphExport(lib).entities[drifting.id].linked, undefined, 'the derived flag is never written back')
})

test('listEntities: with a session only visible references count, and relationship evidence is session-filtered too', () => {
  const binding = state.ensureSession('vis-scoped', { cwd: path.join(home, 'ws-vis-scoped'), agentPreset: 'rp' })
  const lib = binding.libraryId
  const exec = { agent: { session: { header: { id: 'vis-scoped' } } } }
  const linked = graph.createEntity({ libraryId: lib, name: 'Linked' })
  const secretTarget = graph.createEntity({ libraryId: lib, name: 'SecretTarget' })
  const relVisible = graph.createEntity({ libraryId: lib, name: 'RelVisible' })
  const relHidden = graph.createEntity({ libraryId: lib, name: 'RelHidden' })
  const lonely = graph.createEntity({ libraryId: lib, name: 'Lonely' })
  state.savePrivateIndex(lib, { entries: {
    'mem-open': { title: 'open', content: 'open scene', layer: 'long_term', status: 'active', visibility: 'shared',
      links: [{ to: linked.id, kind: 'person', note: 'Linked is the person this scene is about.', confidence: 0.9 }] },
    'mem-hidden': { title: 'hidden', content: 'secret scene', layer: 'long_term', status: 'active', visibility: 'secret', context: { characterId: 'other' },
      links: [{ to: secretTarget.id, kind: 'person', note: 'Secret is the person this scene is about.', confidence: 0.9 }] },
  } })
  // 关系快照也算引用：evidence 指向本会话可见记忆的算，指不可见记忆的不算。
  graph.updateRelationship({ libraryId: lib, fromId: linked.id, toId: relVisible.id, state: { trust: 0.5 }, evidenceIds: ['mem-open'], reason: 'The open scene is explicit evidence.' })
  graph.updateRelationship({ libraryId: lib, fromId: secretTarget.id, toId: relHidden.id, state: { trust: 0.5 }, evidenceIds: ['mem-hidden'], reason: 'The hidden scene is the only evidence here.' })
  const scoped = graph.listEntities({ exec, libraryId: lib })
  const ids = scoped.items.map(entity => entity.id).sort()
  assert.deepEqual(ids, [linked.id, relVisible.id].sort(),
    'a visible entry link and a relationship with visible evidence both count; secret-referenced and orphan entities do not')
  assert.ok(scoped.items.every(entity => entity.linked === true), 'every session-visible row is linked by construction')
  // 无 session：全量计入（两条快照都算引用），Linked/RelVisible/SecretTarget/RelHidden
  // 都是 linked=true，只有 Lonely 是孤立。
  const all = graph.listEntities({ libraryId: lib })
  assert.equal(all.items.length, 5, 'no session means every entity, referenced or not')
  const linkedMap = Object.fromEntries(all.items.map(entity => [entity.id, entity.linked]))
  for (const entity of [linked, relVisible, secretTarget, relHidden]) {
    assert.equal(linkedMap[entity.id], true, `${entity.name} is referenced and must not be misjudged as an orphan`)
  }
  assert.equal(linkedMap[lonely.id], false, 'the untouched entity stays unlinked')
})
