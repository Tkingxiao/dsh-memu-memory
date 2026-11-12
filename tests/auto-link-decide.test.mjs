import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-autolink-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const graph = await import('../lib/graph.js')
const decide = await import('../lib/auto-link/decide.js')
const apply = await import('../lib/auto-link/apply.js')
const suppression = await import('../lib/auto-link/suppression.js')
const normalize = await import('../lib/auto-link/normalize.js')
const policy = await import('../lib/auto-link/policy.js')
const privateLinks = await import('../lib/private-links.js')
const rpc = await import('../lib/rpc.js')

test.after(() => {
  try { state.flushState() } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

let counter = 0
function library(name) {
  counter += 1
  const binding = state.ensureSession(`autolink-${name}-${counter}`, { cwd: path.join(home, `ws-${name}-${counter}`), agentPreset: 'rp' })
  return binding.libraryId
}

const at = (day) => `2026-11-${String(day).padStart(2, '0')}T00:00:00.000Z`

function entry(title, content, extra = {}) {
  return { title, content, status: 'active', visibility: 'shared', layer: 'long_term', createdAt: at(1), updatedAt: at(1), ...extra }
}

function index(entries) {
  return { version: 1, entries }
}

// ---------------------------------------------------------------- normalization

test('mentions are boundary-aware and punctuation-insensitive: CJK substrings, identifiers, NFKC folding', () => {
  assert.equal(normalize.mentionCount('yuike 和 yuikeee', 'yuike'), 1, 'Latin must not match a longer identifier')
  assert.equal(normalize.mentionCount('ＹＵＩＫＥ！来了', 'yuike'), 1, 'full-width and punctuation fold away')
  assert.equal(normalize.mentionCount('星宫雲来了，星宫雲走了', '星宫雲'), 2)
  // §8.1: NFKC + 去标点/空白 applies to the name as well as the text.
  assert.equal(normalize.mentionCount('小·柚来了', '小柚'), 1)
  assert.equal(normalize.mentionCount('小 柚来了', '小柚'), 1)
  assert.equal(normalize.mentionCount('小柚来了', '小 柚'), 1)
  // §2: code identifiers keep their punctuation and their word boundaries.
  assert.equal(normalize.mentionCount('Yuike_01 上线', 'Yuike_01'), 1)
  assert.equal(normalize.mentionCount('yuike.dev is down', 'yuike.dev'), 1)
  assert.equal(normalize.mentionCount('星宫雲-yuike 来了', '星宫雲-yuike'), 1)
  assert.equal(normalize.firstMention('猫娘yuike', 'yuike'), 2)
  assert.equal(normalize.firstMention('「小·柚」来了', '小柚'), 1, 'offset is the raw text position, not the compact index')
  assert.equal(normalize.isMentionSurface('小'), false, 'one CJK character is not a surface')
  assert.equal(normalize.isMentionSurface('小柚'), true)
  assert.equal(normalize.isMentionSurface('a'), false, 'one Latin character is not a surface')
})

test('punctuated and identifier surfaces produce mention edges with raw offsets', () => {
  const lib = library('punct')
  const you = graph.createEntity({ libraryId: lib, name: '小柚', kind: 'person', status: 'confirmed' })
  const yuike = graph.createEntity({ libraryId: lib, name: 'yuike_01', kind: 'person', status: 'confirmed' })
  const mixed = graph.createEntity({ libraryId: lib, name: '星宫雲-yuike', kind: 'person', status: 'confirmed' })
  const snapshot = index({
    'mem-a': entry('「小·柚」来了', '她带着伞。'),
    'mem-b': entry('yuike_01 上线', 'yuike_01 迟到了。'),
    'mem-c': entry('星宫雲-yuike 到访', '星宫雲-yuike 和 星宫雲 yuike 都来了。'),
  })
  const edges = decide.decideAutoLinks({ index: snapshot, entities: [you, yuike, mixed] })
  const mention = edges.filter(edge => edge.rule === 'entity-mention')
  assert.equal(mention.length, 3, JSON.stringify(mention.map(edge => `${edge.from}->${edge.to}`)))
  for (const edge of edges) assert.ok(policy.EVIDENCE_RULES.includes(edge.rule), 'only the declared rule vocabulary: ' + edge.rule)
  const byEntity = new Map(mention.map(edge => [edge.to, edge]))
  const youEdge = byEntity.get(you.id)
  assert.equal(youEdge.evidence.surface, '小柚')
  assert.equal(youEdge.evidence.offset, 1, 'raw offset inside 「小·柚」')
  assert.ok(byEntity.has(yuike.id), 'identifier with underscore is found')
  assert.ok(byEntity.has(mixed.id), 'mixed CJK-Latin name is found')
})

// ---------------------------------------------------------------- decision layer

test('only confirmed entities produce mention edges; provisional, archived and secret rows do not', () => {
  const lib = library('mention')
  const you = graph.createEntity({ libraryId: lib, name: '小柚', kind: 'person', aliases: ['柚子'], status: 'confirmed', confirmedBy: 'user' })
  graph.createEntity({ libraryId: lib, name: '未晞', kind: 'person' })
  graph.createEntity({ libraryId: lib, name: '阿兰', kind: 'person', status: 'archived' })
  const snapshot = index({
    'mem-a': entry('小柚今天来了', '她带了一篮柚子。'),
    'mem-b': entry('未晞的日记', '未晞写下了今天的安排。'),
    'mem-c': entry('阿兰回信', '阿兰说下周再联系。'),
    'mem-d': entry('小柚与秘密', '关于小柚的一件不能外传的事。', { visibility: 'secret' }),
    'mem-e': entry('小柚旧事', '小柚很久以前来过。', { status: 'archived' }),
  })
  const edges = decide.decideAutoLinks({ index: snapshot, entities: [you, { id: 'ent-provisional', name: '未晞', kind: 'person', status: 'provisional' }, { id: 'ent-archived', name: '阿兰', kind: 'person', status: 'archived' }] })
  const mention = edges.filter(edge => edge.rule === 'entity-mention')
  assert.equal(mention.length, 1, 'one eligible memory mentions the confirmed entity')
  assert.equal(mention[0].from, 'mem-a')
  assert.equal(mention[0].to, you.id)
  assert.equal(mention[0].kind, 'person')
  assert.equal(mention[0].confidence, 1)
  assert.equal(mention[0].schemaVersion, 2)
  assert.ok(mention[0].evidence.surface === '小柚' || mention[0].evidence.surface === '柚子')
  assert.equal(mention[0].evidence.entityId, you.id)
  assert.equal(mention[0].evidence.field, 'title')
  assert.equal(mention[0].evidence.offset, 0)
})

test('suppression removes a decided edge and decide stays pure', () => {
  const lib = library('suppress')
  const you = graph.createEntity({ libraryId: lib, name: '小柚', kind: 'person', status: 'confirmed' })
  const snapshot = index({ 'mem-a': entry('小柚来了', '小柚进门坐下。') })
  const first = decide.decideAutoLinks({ index: snapshot, entities: [you] })
  const second = decide.decideAutoLinks({ index: snapshot, entities: [you] })
  assert.deepEqual(second, first, 'same input -> same output')
  const key = suppression.suppressionKey(first[0])
  const suppressed = decide.decideAutoLinks({ index: snapshot, entities: [you], suppression: new Set([key]) })
  assert.deepEqual(suppressed, [])
})

test('field evidence builds conflict, supersede and fact-key edges without cliques', () => {
  const lib = library('fields')
  const snapshot = index({
    'mem-a': entry('说法一', '内容一。', { conflicts_with: 'mem-b' }),
    'mem-b': entry('说法二', '内容二。', { conflicts_with: 'mem-a' }),
    'mem-c': entry('新版本', '更新后的说法。', { supersedes: 'mem-d' }),
    'mem-d': entry('旧版本', '旧的说明。', { status: 'superseded' }),
    'mem-e': entry('同一事实 1', '第一版。', { fact_key: 'k1', context: { worldId: 'w1' }, createdAt: at(1), updatedAt: at(1), version: 1 }),
    'mem-f': entry('同一事实 2', '第二版。', { fact_key: 'k1', context: { worldId: 'w1' }, createdAt: at(2), updatedAt: at(2), version: 2 }),
    'mem-g': entry('同一事实 3', '第三版。', { fact_key: 'k1', context: { worldId: 'w1' }, createdAt: at(3), updatedAt: at(3), version: 3, conflicts_with: 'mem-f' }),
  })
  const edges = decide.decideAutoLinks({ index: snapshot, entities: [] })
  const conflicts = edges.filter(edge => edge.rule === 'conflict')
  assert.equal(conflicts.length, 3, 'a<->b plus g->f (the reverse f->g is not a field)')
  assert.ok(conflicts.some(edge => edge.from === 'mem-a' && edge.to === 'mem-b' && edge.kind === 'conflict'))
  assert.ok(conflicts.some(edge => edge.from === 'mem-b' && edge.to === 'mem-a'))
  assert.ok(conflicts.some(edge => edge.from === 'mem-g' && edge.to === 'mem-f'))
  const supersedes = edges.filter(edge => edge.rule === 'supersede')
  assert.deepEqual(supersedes.map(edge => `${edge.from}->${edge.to}:${edge.kind}`), ['mem-c->mem-d:supersede'])
  const factKey = edges.filter(edge => edge.rule === 'fact-key')
  assert.deepEqual(factKey.map(edge => `${edge.from}->${edge.to}`), ['mem-f->mem-e'], 'chain, not a clique; g-f is already a conflict')
})

// ---------------------------------------------------------------- write layer

test('apply writes evidence and never overwrites a manual edge', () => {
  const lib = library('apply')
  const you = graph.createEntity({ libraryId: lib, name: '小柚', kind: 'person', status: 'confirmed' })
  state.savePrivateIndex(lib, index({
    'mem-a': entry('小柚来了', '小柚进门坐下。'),
    'mem-b': entry('小柚与阿柚', '小柚提起阿柚。', {
      links: [{ to: you.id, kind: 'person', note: '用户手动确认过这条关系。', confidence: 0.9 }],
    }),
  }))
  const edges = decide.decideAutoLinks({ index: state.loadPrivateIndex(lib), entities: [you] })
  const applied = apply.applyAutoEdges({ libraryId: lib, edges, entities: [you] })
  assert.equal(applied.added, 1)
  assert.equal(applied.skippedManual, 1, 'the manual memory→entity edge wins')
  const after = state.loadPrivateIndex(lib)
  const link = after.entries['mem-a'].links[0]
  assert.equal(link.source, 'auto')
  assert.equal(link.confidence, 1)
  assert.equal(link.evidence.rule, 'entity-mention')
  assert.equal(link.evidence.entityId, you.id)
  assert.match(link.note, /已确认实体/)
  assert.equal(after.entries['mem-b'].links.length, 1)
  assert.equal(after.entries['mem-b'].links[0].source, undefined, 'the manual edge is untouched')
  const again = apply.applyAutoEdges({ libraryId: lib, edges, entities: [you] })
  assert.equal(again.added, 0, 'the same decision is a no-op')
  assert.equal(again.updated, 0)
})

// ---------------------------------------------------------------- entity lifecycle

test('confirming an entity flips its status and backfills mention edges immediately', () => {
  const lib = library('confirm')
  const you = graph.createEntity({ libraryId: lib, name: '小柚', kind: 'person' })
  assert.equal(you.status, 'provisional', 'creation alone does not confirm')
  state.savePrivateIndex(lib, index({
    'mem-a': entry('小柚来了', '小柚进门坐下。'),
    'mem-b': entry('小柚的伞', '小柚把伞落在门口。'),
  }))
  const confirmed = graph.confirmEntities({ libraryId: lib, entityIds: [you.id], by: 'user' })
  assert.deepEqual(confirmed.confirmed, [you.id])
  assert.equal(confirmed.entities, 2, 'both memories gained an edge in the same action')
  const store = graph.graphExport(lib)
  assert.equal(store.entities[you.id].status, 'confirmed')
  assert.equal(store.entities[you.id].confirmedBy, 'user')
  assert.ok(store.entities[you.id].confirmedAt)
  const rows = state.loadPrivateIndex(lib)
  assert.ok((rows.entries['mem-a'].links || []).some(link => link.to === you.id && link.evidence?.rule === 'entity-mention'))
  const again = graph.confirmEntities({ libraryId: lib, entityIds: [you.id], by: 'user' })
  assert.deepEqual(again.confirmed, [])
  assert.equal(again.entities, 0, 'confirming twice is a no-op')
})

test('renaming a confirmed entity retires stale mention edges and attaches the new surface', () => {
  const lib = library('rename')
  const you = graph.createEntity({ libraryId: lib, name: '小柚', kind: 'person' })
  state.savePrivateIndex(lib, index({
    'mem-a': entry('小柚来了', '小柚进门坐下。'),
    'mem-b': entry('柚子来了', '柚子带着伞。'),
  }))
  graph.confirmEntities({ libraryId: lib, entityIds: [you.id], by: 'user' })
  assert.ok((state.loadPrivateIndex(lib).entries['mem-a'].links || []).some(link => link.to === you.id))
  graph.renameEntity({ libraryId: lib, entityId: you.id, name: '柚子', aliases: [] })
  const rows = state.loadPrivateIndex(lib)
  assert.equal((rows.entries['mem-a'].links || []).some(link => link.to === you.id), false, 'old name no longer matches')
  assert.ok((rows.entries['mem-b'].links || []).some(link => link.to === you.id && link.evidence?.surface === '柚子'))
})

test('merging a confirmed source into a provisional target confirms it and remaps evidence', () => {
  const lib = library('merge')
  const source = graph.createEntity({ libraryId: lib, name: '小柚', kind: 'person' })
  state.savePrivateIndex(lib, index({ 'mem-a': entry('小柚来了', '小柚进门坐下。') }))
  graph.confirmEntities({ libraryId: lib, entityIds: [source.id], by: 'user' })
  const target = graph.createEntity({ libraryId: lib, name: '柚子', kind: 'person' })
  graph.mergeEntities({ libraryId: lib, targetId: target.id, sourceIds: [source.id] })
  const store = graph.graphExport(lib)
  assert.equal(store.entities[target.id].status, 'confirmed', 'a confirmed source confirms the surviving row')
  assert.deepEqual(store.entities[target.id].aliases, ['小柚'])
  const link = (state.loadPrivateIndex(lib).entries['mem-a'].links || []).find(item => item.to === target.id)
  assert.ok(link, 'the mention edge points at the merged row')
  assert.equal(link.evidence.entityId, target.id)
})

test('deleting an entity records suppression for the auto edges it collects', () => {
  const lib = library('delete')
  const you = graph.createEntity({ libraryId: lib, name: '小柚', kind: 'person' })
  state.savePrivateIndex(lib, index({ 'mem-a': entry('小柚来了', '小柚进门坐下。') }))
  graph.confirmEntities({ libraryId: lib, entityIds: [you.id], by: 'user' })
  graph.deleteEntity({ libraryId: lib, entityId: you.id, force: true })
  const store = suppression.readSuppression(lib)
  const keys = Object.keys(store.entries)
  assert.ok(keys.includes(`mem-a|${you.id}|person|entity-mention`), 'the collected edge key is suppressed: ' + keys.join(','))
})

test('removing an auto edge by hand suppresses it against the next recompute', () => {
  const lib = library('unlink')
  const you = graph.createEntity({ libraryId: lib, name: '小柚', kind: 'person' })
  state.savePrivateIndex(lib, index({ 'mem-a': entry('小柚来了', '小柚进门坐下。') }))
  graph.confirmEntities({ libraryId: lib, entityIds: [you.id], by: 'user' })
  const removed = graph.unlinkEntry({ libraryId: lib, fromId: 'mem-a', toId: you.id, kind: 'person' })
  assert.equal(removed.removed, 1)
  const set = suppression.suppressionSet(lib)
  assert.ok(set.has(`mem-a|${you.id}|person|entity-mention`))
  assert.ok(set.has(`mem-a|${you.id}|person|*`), 'the triple wildcard is written too')
  apply.refreshEntityMentions({ libraryId: lib, entity: graph.graphExport(lib).entities[you.id], suppression: set })
  assert.equal((state.loadPrivateIndex(lib).entries['mem-a'].links || []).some(link => link.to === you.id), false, 'suppressed edge stays gone')
})

test('deleting a legacy auto edge also blocks the later entity-mention edge (P6)', () => {
  const lib = library('legacy-suppress')
  const you = graph.createEntity({ libraryId: lib, name: '小柚', kind: 'person' })
  state.savePrivateIndex(lib, index({
    'mem-a': entry('小柚来了', '小柚进门坐下。', {
      links: [{ to: you.id, kind: 'person', note: '旧算法自动建立的实体枢纽。', confidence: 0.65, source: 'auto' }],
    }),
  }))
  const removed = graph.unlinkEntry({ libraryId: lib, fromId: 'mem-a', toId: you.id, kind: 'person' })
  assert.equal(removed.removed, 1)
  const set = suppression.suppressionSet(lib)
  assert.ok(set.has(`mem-a|${you.id}|person|auto`), 'the legacy edge had no rule')
  // Confirming the entity would normally rebuild the mention edge; the deleted
  // fact must stay deleted even though the rule string changed.
  const result = graph.confirmEntities({ libraryId: lib, entityIds: [you.id], by: 'user' })
  assert.equal(result.entities, 0)
  assert.equal((state.loadPrivateIndex(lib).entries['mem-a'].links || []).length, 0, 'the edge does not come back under entity-mention')
})

test('purgeAutoLinks removes only auto edges, keeps a manual edge byte-for-byte and suppresses', () => {
  const lib = library('purge')
  state.savePrivateIndex(lib, index({
    'mem-a': entry('a', 'a', {
      links: [
        { to: 'mem-b', kind: 'relation', note: '手动边，必须原样保留。', confidence: 0.7 },
        { to: 'mem-b', kind: 'event', note: '自动边，应被清理。', confidence: 1, source: 'auto', evidence: { rule: 'fact-key', field: 'fact_key' } },
      ],
    }),
    'mem-b': entry('b', 'b'),
  }))
  const before = JSON.parse(JSON.stringify(state.loadPrivateIndex(lib).entries['mem-a'].links[0]))
  const result = graph.purgeAutoLinks({ libraryId: lib })
  assert.equal(result.removed, 1)
  const after = state.loadPrivateIndex(lib).entries['mem-a'].links
  assert.equal(after.length, 1)
  assert.deepEqual(after[0], before, 'the manual edge object is untouched')
  assert.ok(suppression.suppressionSet(lib).has('mem-a|mem-b|event|*'), 'the removed pair is suppressed')
})

test('off mode closes explicit mention maintenance too, and apply rejects unknown rules', () => {
  const lib = library('off-mode')
  const you = graph.createEntity({ libraryId: lib, name: '小柚', kind: 'person' })
  state.savePrivateIndex(lib, index({ 'mem-a': entry('小柚来了', '小柚进门坐下。') }))
  state.updateSettings({ autoLinkMode: 'off' })
  try {
    const result = graph.confirmEntities({ libraryId: lib, entityIds: [you.id], by: 'user' })
    assert.deepEqual(result.confirmed, [you.id], 'status still changes')
    assert.equal(result.entities, 0, 'off writes no edge')
    assert.equal((state.loadPrivateIndex(lib).entries['mem-a'].links || []).length, 0)
    // A hand-supplied edge outside the evidence vocabulary is refused by the writer.
    state.savePrivateIndex(lib, index({ 'mem-a': entry('小柚来了', '小柚进门坐下。') }))
    const applied = apply.applyAutoEdges({
      libraryId: lib,
      entities: [you],
      edges: [{ from: 'mem-a', to: you.id, kind: 'person', rule: 'made-up', evidence: { rule: 'made-up' } }],
    })
    assert.equal(applied.skipped, 1)
    assert.equal((state.loadPrivateIndex(lib).entries['mem-a'].links || []).length, 0)
  } finally {
    state.updateSettings({ autoLinkMode: 'suggest' })
  }
})

test('clearLinkSuppression removes markers and the deterministic rebuild restores the edge', async () => {
  const lib = library('clear-suppress')
  const you = graph.createEntity({ libraryId: lib, name: '小柚', kind: 'person' })
  state.savePrivateIndex(lib, index({ 'mem-a': entry('小柚来了', '小柚进门坐下。') }))
  state.updateSettings({ autoLinkMode: 'deterministic' })
  try {
    graph.confirmEntities({ libraryId: lib, entityIds: [you.id], by: 'user' })
    graph.unlinkEntry({ libraryId: lib, fromId: 'mem-a', toId: you.id, kind: 'person' })
    assert.ok(suppression.suppressionSet(lib).size > 0)
    assert.equal((state.loadPrivateIndex(lib).entries['mem-a'].links || []).length, 0)
    const cleared = await rpc.dispatch({}, 'clearLinkSuppression', { libraryId: lib })
    assert.ok(cleared.cleared >= 1)
    assert.equal(suppression.suppressionSet(lib).size, 0)
    assert.ok((state.loadPrivateIndex(lib).entries['mem-a'].links || []).some(link => link.to === you.id), 'the full rebuild restores the deleted edge')
  } finally {
    state.updateSettings({ autoLinkMode: 'suggest' })
  }
})

test('switching to deterministic backfills entities confirmed while off', async () => {
  const lib = library('mode-switch')
  const you = graph.createEntity({ libraryId: lib, name: '小柚', kind: 'person' })
  state.savePrivateIndex(lib, index({ 'mem-a': entry('小柚来了', '小柚进门坐下。') }))
  state.updateSettings({ autoLinkMode: 'off' })
  try {
    const off = graph.confirmEntities({ libraryId: lib, entityIds: [you.id], by: 'user' })
    assert.equal(off.entities, 0)
    assert.equal((state.loadPrivateIndex(lib).entries['mem-a'].links || []).length, 0)
    await rpc.dispatch({}, 'setSettings', { patch: { autoLinkMode: 'deterministic' } })
    const links = state.loadPrivateIndex(lib).entries['mem-a'].links || []
    assert.ok(links.some(link => link.to === you.id && link.evidence?.rule === 'entity-mention'), 'the switch rebuilds missing mentions')
  } finally {
    state.updateSettings({ autoLinkMode: 'suggest' })
  }
})

test('re-confirming an already-confirmed entity backfills missing mentions', () => {
  const lib = library('reconfirm')
  const you = graph.createEntity({ libraryId: lib, name: '小柚', kind: 'person', status: 'confirmed' })
  state.savePrivateIndex(lib, index({ 'mem-a': entry('小柚来了', '小柚进门坐下。') }))
  const result = graph.confirmEntities({ libraryId: lib, entityIds: [you.id], by: 'user' })
  assert.deepEqual(result.confirmed, [], 'it was already confirmed')
  assert.equal(result.entities, 1, 'the refresh still runs and attaches the edge')
  assert.ok((state.loadPrivateIndex(lib).entries['mem-a'].links || []).some(link => link.to === you.id))
})

test('three automatic passes in suggest mode add no edges', async () => {
  state.updateSettings({ autoLinkMode: 'suggest' })
  try {
    const lib = library('suggest-three')
    graph.createEntity({ libraryId: lib, name: '小柚', kind: 'person', status: 'confirmed' })
    state.savePrivateIndex(lib, index({ 'mem-a': entry('小柚来了', '小柚进门坐下。') }))
    for (let pass = 0; pass < 3; pass += 1) {
      const result = await privateLinks.refreshPrivateAutoLinks({ libraryId: lib, ids: ['mem-a'] })
      assert.equal(result.skipped, 'suggest')
    }
    assert.equal((state.loadPrivateIndex(lib).entries['mem-a'].links || []).length, 0)
  } finally {
    state.updateSettings({ autoLinkMode: 'suggest' })
  }
})

test('confirming eight entities backfills all mentions in one batch (8 x 9 = 72)', () => {
  const lib = library('batch-confirm')
  const names = Array.from({ length: 8 }, (_, i) => `角色${i + 1}`)
  const entities = names.map(name => graph.createEntity({ libraryId: lib, name, kind: 'person' }))
  const entries = {}
  for (let i = 0; i < 9; i += 1) entries[`mem-${i}`] = entry(`第 ${i} 场`, names.join('、') + ' 都在场。')
  state.savePrivateIndex(lib, index(entries))
  const result = graph.confirmEntities({ libraryId: lib, entityIds: entities.map(entity => entity.id), by: 'user' })
  assert.equal(result.confirmed.length, 8)
  assert.equal(result.entities, 72, '9 memories x 8 entities')
  const second = graph.confirmEntities({ libraryId: lib, entityIds: entities.map(entity => entity.id), by: 'user' })
  assert.deepEqual(second.confirmed, [])
  assert.equal(second.entities, 0)
})

test('a broken entity store makes the automatic refresh fail open (warn, no throw)', async () => {
  const lib = library('broken-entities')
  state.savePrivateIndex(lib, index({ 'mem-a': entry('小柚来了', '小柚进门坐下。') }))
  const file = path.join(home, 'index', `${lib}.entities.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{not json', 'utf8')
  state.updateSettings({ autoLinkMode: 'deterministic' })
  try {
    const result = await privateLinks.refreshPrivateAutoLinks({ libraryId: lib, ids: ['mem-a'] })
    assert.equal(result.skipped, 'entities')
    assert.equal(result.applied, null)
  } finally {
    state.updateSettings({ autoLinkMode: 'suggest' })
    fs.rmSync(file, { force: true })
  }
})

test('field evidence stays linear: 10k full rebuild and a 10-id incremental stay in budget', () => {
  const entries = {}
  for (let i = 0; i < 10000; i += 1) {
    const id = `mem-${String(i).padStart(5, '0')}`
    const row = entry(`记忆 ${i}`, `第 ${i} 条正文。`, { createdAt: at(1), updatedAt: at(1) })
    if (i % 10 === 1) row.conflicts_with = `mem-${String(i - 1).padStart(5, '0')}`
    if (i % 20 === 1) {
      // 200-row fact families stress the grouping/sort path as well as the count.
      row.fact_key = `k${Math.floor(i / 200)}`
      row.context = { worldId: `w${Math.floor(i / 200)}` }
      row.version = i % 200
    }
    entries[id] = row
  }
  const snapshot = index(entries)
  const startedFull = performance.now()
  const full = decide.fieldEvidenceEdges(snapshot)
  const fullMs = performance.now() - startedFull
  const sample = Object.keys(entries).slice(0, 10)
  const startedInc = performance.now()
  const incremental = decide.fieldEvidenceEdgesFor(snapshot, sample)
  const incMs = performance.now() - startedInc
  assert.ok(full.length > 900, 'the fixture really produces conflict/fact-key edges: ' + full.length)
  assert.ok(incremental.length > 0)
  assert.ok(fullMs < 5000, `10k full rebuild took ${Math.round(fullMs)} ms (design budget <5000)`)
  assert.ok(incMs < 500, `10-id incremental took ${Math.round(incMs)} ms (design budget <50, allow CI slack)`)
})

// ---------------------------------------------------------------- write-path hooks

test('a private write carrying conflicts_with gets its evidence edges immediately', async () => {
  state.updateSettings({ autoLinkMode: 'deterministic' })
  try {
    const cwd = path.join(home, 'ws-write-hook')
    const binding = state.ensureSession('write-hook', { cwd, agentPreset: 'rp' })
    const exec = { agent: { session: { header: { id: 'write-hook', cwd, agentPreset: 'rp' } } } }
    const first = await memory.privateRemember({ exec, title: '周五安排', content: '旧说法：周五去书店。' })
    const second = await memory.privateRemember({ exec, title: '周五安排', content: '新说法：周五改去河边。', conflictsWith: first.id })
    assert.equal(second.conflictsWith, first.id)
    const index = state.loadPrivateIndex(binding.libraryId)
    const forward = (index.entries[second.id].links || []).find(link => link.to === first.id)
    assert.ok(forward, 'the new entry links to the conflicting version')
    assert.equal(forward.kind, 'conflict')
    assert.equal(forward.evidence?.rule, 'conflict')
    assert.equal(forward.confidence, 1)
    const reverse = (index.entries[first.id].links || []).find(link => link.to === second.id)
    assert.ok(reverse, 'memory.js writes the reverse field; the reverse edge follows')
    assert.equal(reverse.evidence?.rule, 'conflict')
  } finally {
    state.updateSettings({ autoLinkMode: 'suggest' })
  }
})

test('review accept refreshes the supersede edge immediately and stays silent in suggest mode', async () => {
  const lib = library('review-hook')
  const seed = () => index({
    'mem-old': entry('周五安排', '旧说法：周五去书店。'),
    'mem-new': entry('周五安排', '新说法：周五改去河边。', { status: 'pending_review', conflictingWith: 'mem-old' }),
  })
  state.savePrivateIndex(lib, seed())
  state.updateSettings({ autoLinkMode: 'deterministic' })
  try {
    await memory.resolveMemoryReview({ libraryId: lib, id: 'mem-new', action: 'accept', resolution: 'replace', sessionId: null })
    const links = state.loadPrivateIndex(lib).entries['mem-new'].links || []
    const edge = links.find(link => link.to === 'mem-old')
    assert.ok(edge, 'the supersede edge is written with the review commit')
    assert.equal(edge.kind, 'supersede')
    assert.equal(edge.evidence?.rule, 'supersede')

    state.savePrivateIndex(lib, seed())
    state.updateSettings({ autoLinkMode: 'suggest' })
    await memory.resolveMemoryReview({ libraryId: lib, id: 'mem-new', action: 'accept', resolution: 'replace', sessionId: null })
    const after = state.loadPrivateIndex(lib).entries['mem-new'].links || []
    assert.equal(after.some(link => link.evidence?.rule === 'supersede'), false, 'suggest mode never writes an edge')
  } finally {
    state.updateSettings({ autoLinkMode: 'suggest' })
  }
})

// ---------------------------------------------------------------- recall governance

test('recallRelations ignores entity-mention edges even at confidence 1.0 but keeps field evidence', () => {
  const lib = library('recall')
  const you = graph.createEntity({ libraryId: lib, name: '小柚', kind: 'person', status: 'confirmed' })
  state.savePrivateIndex(lib, index({
    'mem-a': entry('小柚来了', '小柚进门坐下。', {
      links: [
        { to: you.id, kind: 'person', note: '提及已确认实体「小柚」（标题）。', confidence: 1, source: 'auto', evidence: { rule: 'entity-mention', entityId: you.id, surface: '小柚', field: 'title', offset: 0 } },
        { to: 'mem-b', kind: 'conflict', note: '字段证据：conflicts_with 指向这条记忆。', confidence: 1, source: 'auto', evidence: { rule: 'conflict', field: 'conflicts_with' } },
      ],
    }),
    'mem-b': entry('另一种说法', '内容不同。'),
  }))
  const related = graph.recallRelations(lib, state.loadPrivateIndex(lib), 'mem-a', null)
  assert.deepEqual(related.map(item => item.id), ['mem-b'], 'the mention edge never takes a top-2 seat')
  assert.equal(related[0].kind, 'conflict')
})
