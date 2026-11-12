import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-candidates-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const state = await import('../lib/state.js')
const graph = await import('../lib/graph.js')
const rpc = await import('../lib/rpc.js')
const terminology = await import('../lib/auto-link/terminology.js')
const candidates = await import('../lib/auto-link/candidates.js')

test.after(() => {
  try { state.flushState() } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

let counter = 0
function library(name) {
  counter += 1
  return state.ensureSession(`cand-${name}-${counter}`, { cwd: path.join(home, `ws-${name}-${counter}`), agentPreset: 'rp' }).libraryId
}

function entry(title, content, extra = {}) {
  return { title, content, status: 'active', visibility: 'shared', layer: 'long_term', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...extra }
}

function fixture() {
  return {
    'mem-1': entry('「小柚」今天来了', '她带着伞。'),
    'mem-2': entry('小柚的伞', '小柚把伞放在门口。'),
    'mem-3': entry('她叫阿兰', '阿兰是隔壁的邻居。'),
    'mem-4': entry('yuike_01 上线', 'yuike_01 又迟到了。'),
    'mem-5': entry('星港夜班', '今日星港开始检修，傍晚星港的风很大。'),
    'mem-6': entry('星港入口', '星港入口风很大。'),
    'mem-7': entry('值班记录', '这个记录写得很乱，这个本子也旧了。'),
    'mem-8': entry('阿兰的猫', '阿兰养了一只很凶的猫。'),
    'mem-9': entry('yuike_01 的工位', 'yuike_01 把工位收拾得很干净。'),
  }
}

test('term statistics carry df/titleDf/boundary/cohesion for real names and drop glue bigrams', () => {
  const rows = Object.entries(fixture()).map(([id, item]) => ({ id, title: item.title, text: `${item.title}\n${item.content}` }))
  const stats = terminology.buildTermStats(rows)
  const you = stats.get('小柚')
  assert.ok(you, '小柚 is a repeated bigram')
  assert.equal(you.df, 2)
  assert.equal(you.titleDf, 2)
  assert.ok(you.avLeft >= 2 && you.avRight >= 2, 'both boundaries vary: ' + you.avLeft + '/' + you.avRight)
  assert.ok(you.freedom >= 2)
  const alan = stats.get('阿兰')
  assert.ok(alan && alan.df >= 2)
  const star = stats.get('星港')
  assert.ok(star && star.df >= 2 && star.tf >= 4)
  assert.equal(terminology.looksGeneric('这个'), true, 'function characters disqualify a surface')
  assert.equal(terminology.looksGeneric('一条'), true, 'measure-word templates disqualify a surface')
  assert.equal(terminology.looksGeneric('小柚'), false)
})

test('ranking puts evidenced terms in tier 1 and pure statistics in tier 2', () => {
  const entries = Object.entries(fixture()).map(([id, item]) => ({ id, title: item.title, text: `${item.title}\n${item.content}` }))
  const stats = terminology.buildTermStats(entries)
  const ranked = terminology.rankCandidates(entries, stats)
  const tier1 = ranked.tier1.map(row => row.term)
  const tier2 = ranked.tier2.map(row => row.term)
  assert.ok(tier1.includes('小柚'), 'quoted name is tier 1: ' + tier1.join(','))
  assert.ok(tier1.includes('阿兰'), 'name-intro is tier 1: ' + tier1.join(','))
  assert.ok(tier1.includes('yuike_01'), 'mixed identifier is tier 1: ' + tier1.join(','))
  assert.ok(tier2.includes('星港'), 'statistical-only name stays tier 2: ' + tier2.join(','))
  assert.equal([...tier1, ...tier2].includes('这个'), false, 'glue bigram never becomes a candidate')
  assert.equal([...tier1, ...tier2].includes('2026'), false)
  assert.ok(ranked.tier1.find(row => row.term === '小柚').quoted)
})

test('the queue snapshot persists, maps existing entities and stays stable across reads', () => {
  const lib = library('snapshot')
  state.savePrivateIndex(lib, { version: 1, entries: fixture() })
  const alan = graph.createEntity({ libraryId: lib, name: '阿兰', kind: 'person' })
  const first = candidates.generateAnchorCandidates({ libraryId: lib })
  assert.ok(fs.existsSync(candidates.candidatesFile(lib)), 'the derived snapshot is written next to the index')
  const row = first.tiers.tier1.find(item => item.term === '阿兰')
  assert.ok(row, '阿兰 is nominated')
  assert.equal(row.entityId, alan.id, 'the row points at the existing entity')
  assert.equal(row.entityStatus, 'provisional')
  assert.ok(first.entities.provisional.some(item => item.id === alan.id))
  assert.equal(first.entities.confirmed.length, 0)
  assert.ok(first.totals.memories >= 7)
  const second = candidates.generateAnchorCandidates({ libraryId: lib })
  assert.deepEqual(second, first, 'an unchanged library returns the cached snapshot')
})

test('RPC confirm flips status and backfills mention edges in one action', async () => {
  const lib = library('confirm-rpc')
  state.savePrivateIndex(lib, { version: 1, entries: {
    'mem-a': entry('阿兰来了', '阿兰坐在门口。'),
    'mem-b': entry('阿兰的信', '阿兰寄来一封信。'),
  } })
  const alan = graph.createEntity({ libraryId: lib, name: '阿兰', kind: 'person' })
  const queue = await rpc.dispatch({}, 'getAnchorCandidates', { libraryId: lib })
  const rows = [...queue.tiers.tier1, ...queue.tiers.tier2]
  assert.ok(rows.some(row => row.term === '阿兰' && row.entityId === alan.id), 'queue exposes the entity link')
  const result = await rpc.dispatch({}, 'confirmEntities', { libraryId: lib, entityIds: [alan.id] })
  assert.deepEqual(result.confirmed, [alan.id])
  assert.equal(result.entities, 2)
  const index = state.loadPrivateIndex(lib)
  for (const id of ['mem-a', 'mem-b']) {
    assert.ok((index.entries[id].links || []).some(link => link.to === alan.id && link.evidence?.rule === 'entity-mention'), id + ' gained a mention edge')
  }
  const store = graph.graphExport(lib)
  assert.equal(store.entities[alan.id].status, 'confirmed')
  assert.equal(store.entities[alan.id].origin, 'user')
})

test('RPC createEntity confirms the new row and attaches mentions immediately', async () => {
  const lib = library('create-rpc')
  state.savePrivateIndex(lib, { version: 1, entries: {
    'mem-a': entry('周宁来了', '周宁坐在窗边。'),
  } })
  const created = await rpc.dispatch({}, 'createEntity', { libraryId: lib, name: '周宁', kind: 'person' })
  assert.equal(created.status, 'confirmed')
  assert.equal(created.origin, 'user')
  const index = state.loadPrivateIndex(lib)
  assert.ok((index.entries['mem-a'].links || []).some(link => link.to === created.id && link.evidence?.rule === 'entity-mention'))
})

test('legacy grading keeps asserted rows and downgrades everything else to provisional', () => {
  const lib = library('grade')
  const a = graph.createEntity({ libraryId: lib, name: '周宁', kind: 'person' })
  const b = graph.createEntity({ libraryId: lib, name: '群里', kind: 'person' })
  const c = graph.createEntity({ libraryId: lib, name: '许哥', kind: 'person' })
  state.savePrivateIndex(lib, { version: 1, entries: {
    'mem-a': entry('旧记录', '旧内容。', { links: [{ to: c.id, kind: 'person', note: '用户手动确认过的实体引用。', confidence: 0.9 }] }),
  } })
  // Simulate pre-status rows: strip the fields createEntity now writes.
  const file = path.join(home, 'index', `${lib}.entities.json`)
  const store = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const id of [a.id, b.id, c.id]) {
    delete store.entities[id].status
    delete store.entities[id].confirmedAt
    delete store.entities[id].confirmedBy
    delete store.entities[id].origin
  }
  store.entities[a.id].origin = 'user'
  fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8')

  const dry = graph.gradeLegacyEntities({ libraryId: lib, apply: false })
  assert.equal(dry.scanned, 3)
  assert.equal(dry.changed, 0)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entities[a.id].status, undefined, 'dry run writes nothing')

  const applied = graph.gradeLegacyEntities({ libraryId: lib, apply: true })
  assert.equal(applied.changed, 3)
  const graded = JSON.parse(fs.readFileSync(file, 'utf8')).entities
  assert.equal(graded[a.id].status, 'confirmed', 'origin protection')
  assert.equal(graded[c.id].status, 'confirmed', 'a non-auto inbound link protects the row')
  assert.equal(graded[b.id].status, 'provisional', 'garbage without evidence stays provisional')
})
