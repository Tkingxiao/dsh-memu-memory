import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-migration-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const state = await import('../lib/state.js')
const graph = await import('../lib/graph.js')
const { runRebuildAutoLinks, parseArgs } = await import('../scripts/rebuild-auto-links.mjs')

test.after(() => {
  try { state.flushState() } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function entry(title, content, links = []) {
  return { title, content, status: 'active', visibility: 'shared', layer: 'long_term', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...(links.length ? { links } : {}) }
}

test('argument parsing defaults to a dry run', () => {
  assert.deepEqual(parseArgs(['node', 'script']), { apply: false, json: false, library: null, home: null, estimateTop: 8, includeArchived: false })
  const applied = parseArgs(['node', 'script', '--apply', '--library', 'lib_x', '--estimate-top', '10', '--include-archived'])
  assert.equal(applied.apply, true)
  assert.equal(applied.includeArchived, true)
  assert.throws(() => parseArgs(['node', 'script', '--nope']), /unknown argument/)
})

test('one corrupt library is reported without stopping the rest', async () => {
  const good = state.ensureSession('migration-good', { cwd: path.join(home, 'ws-good'), agentPreset: 'rp' }).libraryId
  state.savePrivateIndex(good, { version: 1, entries: { 'mem-good': entry('正常库', '正常内容。') } })
  const bad = state.ensureSession('migration-bad', { cwd: path.join(home, 'ws-bad'), agentPreset: 'rp' }).libraryId
  state.savePrivateIndex(bad, { version: 1, entries: { 'mem-bad': entry('坏库', '坏内容。') } })
  const badStore = path.join(home, 'index', `${bad}.entities.json`)
  fs.mkdirSync(path.dirname(badStore), { recursive: true })
  fs.writeFileSync(badStore, '{not json', 'utf8')
  try {
    const report = await runRebuildAutoLinks({ apply: false, json: true, log: () => {} })
    assert.equal(report.ok, false)
    assert.ok(report.failures.some(item => item.libraryId === bad), 'the corrupt library is reported: ' + JSON.stringify(report.failures))
    assert.ok(report.libraries.some(item => item.libraryId === good), 'the healthy library still ran')
  } finally {
    fs.rmSync(badStore, { force: true })
  }
})

test('dry run reports legacy edges and writes no entity status or edge', async () => {
  const binding = state.ensureSession('migration-dry', { cwd: path.join(home, 'ws-dry'), agentPreset: 'rp' })
  const lib = binding.libraryId
  const legacyEntity = graph.createEntity({ libraryId: lib, name: '旧实体', kind: 'person' })
  // Simulate pre-status rows again (createEntity now always writes a status).
  const file = path.join(home, 'index', `${lib}.entities.json`)
  const store = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete store.entities[legacyEntity.id].status
  fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8')
  state.savePrivateIndex(lib, { version: 1, entries: {
    'mem-a': entry('旧记录', '旧内容。', [
      { to: 'mem-b', kind: 'relation', note: '旧的词面自动关联，没有任何证据字段。', confidence: 0.66, source: 'auto' },
      { to: 'mem-b', kind: 'event', note: '用户手动建立的一条边，不能被迁移删掉。', confidence: 0.8 },
    ]),
    'mem-b': entry('另一条旧记录', '另一个内容。'),
  } })
  const report = await runRebuildAutoLinks({ apply: false, json: true, log: () => {} })
  const row = report.libraries.find(item => item.libraryId === lib)
  assert.equal(row.legacyAutoEdges, 1)
  assert.equal(row.nonAutoEdges, 1)
  assert.equal(row.grading.provisional, 1, 'the status-less row is planned as provisional')
  const after = state.loadPrivateIndex(lib)
  assert.equal((after.entries['mem-a'].links || []).filter(link => link.source === 'auto').length, 1, 'dry run keeps edges')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entities[legacyEntity.id].status, undefined, 'dry run keeps statuses')
})

test('apply backs up, removes legacy auto edges, grades rows and rebuilds confirmed mentions', async () => {
  const binding = state.ensureSession('migration-apply', { cwd: path.join(home, 'ws-apply'), agentPreset: 'rp' })
  const lib = binding.libraryId
  const confirmed = graph.createEntity({ libraryId: lib, name: '小柚', kind: 'person', status: 'confirmed' })
  const provisional = graph.createEntity({ libraryId: lib, name: '未晞', kind: 'person' })
  state.savePrivateIndex(lib, { version: 1, entries: {
    'mem-a': entry('小柚来了，未晞也在', '小柚进门，未晞在窗边。', [
      { to: 'mem-b', kind: 'relation', note: '旧的词面自动关联，没有任何证据字段。', confidence: 0.66, source: 'auto' },
      { to: 'mem-b', kind: 'event', note: '用户手动建立的一条边，不能被迁移删掉。', confidence: 0.8 },
    ]),
    'mem-b': entry('另一条记录', '只有小柚出现。'),
  } })
  const report = await runRebuildAutoLinks({ apply: true, json: true, log: () => {} })
  assert.ok(report.backup, 'apply takes a backup first')
  assert.ok(fs.existsSync(report.backup), 'the backup directory exists')
  // Rollback material: the pre-migration index (legacy edge included) is in the backup.
  const backupIndex = path.join(report.backup, 'index', `${lib}.json`)
  assert.ok(fs.existsSync(backupIndex), 'the backup carries this library index')
  const beforeIndex = JSON.parse(fs.readFileSync(backupIndex, 'utf8'))
  assert.ok((beforeIndex.entries['mem-a'].links || []).some(link => link.source === 'auto' && !link.evidence?.rule), 'the backup still holds the legacy edge')
  const row = report.libraries.find(item => item.libraryId === lib)
  assert.equal(row.legacyRemoved, 1)
  assert.equal(row.remainingLegacyAutoEdges, 0, 'no marker-less auto edge survives')
  assert.ok(row.rebuiltAutoEdges >= 2, 'confirmed entity mentions are rebuilt: ' + row.rebuiltAutoEdges)
  const index = state.loadPrivateIndex(lib)
  const links = index.entries['mem-a'].links || []
  assert.equal(links.some(link => link.source === 'auto' && !link.evidence?.rule), false)
  assert.equal(links.some(link => link.kind === 'event' && link.source === undefined), true, 'manual edge untouched')
  assert.ok(links.some(link => link.to === confirmed.id && link.evidence?.rule === 'entity-mention'))
  assert.equal(links.some(link => link.to === provisional.id), false, 'provisional entities produce no edges')
  const store = graph.graphExport(lib)
  assert.equal(store.entities[provisional.id].status, 'provisional')
  assert.equal(store.entities[confirmed.id].status, 'confirmed')
})

test('a second dry run after apply sees no legacy edges (idempotent)', async () => {
  const report = await runRebuildAutoLinks({ apply: false, json: true, log: () => {} })
  for (const row of report.libraries) {
    assert.equal(row.legacyAutoEdges, 0, row.libraryId + ' still has legacy auto edges')
  }
})

test('archived libraries are skipped by default and counted, included on request', async () => {
  const lib = state.ensureSession('migration-archived', { cwd: path.join(home, 'ws-archived'), agentPreset: 'rp' }).libraryId
  state.savePrivateIndex(lib, { version: 1, entries: {
    'mem-a': entry('旧记录', '旧内容。', [
      { to: 'mem-b', kind: 'relation', note: '旧的词面自动关联，没有任何证据字段。', confidence: 0.6, source: 'auto' },
    ]),
    'mem-b': entry('另一条', '另一个内容。'),
  } })
  state.archiveLibrary(lib)
  const dry = await runRebuildAutoLinks({ apply: false, json: true, log: () => {} })
  assert.ok(dry.skippedArchived.libraries >= 1)
  assert.ok(dry.skippedArchived.legacyAutoEdges >= 1)
  assert.equal(dry.libraries.some(row => row.libraryId === lib), false, 'archived library is not migrated by default')
  const withArchived = await runRebuildAutoLinks({ apply: false, json: true, includeArchived: true, log: () => {} })
  assert.ok(withArchived.libraries.some(row => row.libraryId === lib), '--include-archived reaches it')
})
