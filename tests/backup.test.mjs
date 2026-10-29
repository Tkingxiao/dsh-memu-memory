import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-backup-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')

test.after(() => {
  try { state.flushState() } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

test('a backup carries every store and a checksum manifest', () => {
  const binding = state.ensureSession('backup-session', { cwd: path.join(home, 'proj') })
  state.updatePrivateIndex(binding.libraryId, (index) => {
    index.entries['mem-keep'] = { id: 'mem-keep', content: '别丢', layer: 'long_term', status: 'active' }
  })
  state.setWorkspacePolicy(path.join(home, 'proj'), { useLibrary: true })

  const dest = state.backupDatabases()
  assert.ok(fs.existsSync(path.join(dest, 'state.json')))
  assert.ok(fs.existsSync(path.join(dest, 'index', `${binding.libraryId}.json`)))

  const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'))
  assert.ok(manifest.createdAt)
  assert.ok(manifest.files['state.json'].sha256)
  assert.ok(manifest.files[`index/${binding.libraryId}.json`].sha256)
})

test('restore puts the backed-up content back and keeps a safety copy', () => {
  const binding = state.getSessionBinding('backup-session')
  const backups = state.listBackups()
  assert.ok(backups.length >= 1)
  const target = backups[0]
  assert.equal(target.hasManifest, true)

  // Change the live data after the backup was taken.
  state.updatePrivateIndex(binding.libraryId, (index) => {
    index.entries['mem-after'] = { id: 'mem-after', content: '后来才写的', layer: 'long_term', status: 'active' }
  })
  assert.ok(state.loadPrivateIndex(binding.libraryId).entries['mem-after'])

  const result = state.restoreBackup(target.name)
  assert.ok(result.safety, 'a restore backs the live data up first')
  const restored = state.loadPrivateIndex(binding.libraryId)
  assert.ok(restored.entries['mem-keep'], 'the backed-up entry is back')
  assert.equal(restored.entries['mem-after'], undefined, 'the later write is gone')
})

test('a backup with a broken checksum is refused', () => {
  const backups = state.listBackups()
  const target = backups[0]
  const manifestPath = path.join(target.dir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.files['state.json'].sha256 = '0'.repeat(64)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  assert.throws(() => state.restoreBackup(target.name), /corrupt|checksum/i)
})

test('an incomplete backup is refused', () => {
  const dest = state.backupDatabases()
  const name = path.basename(dest)
  fs.rmSync(path.join(dest, 'state.json'))
  assert.throws(() => state.restoreBackup(name), /incomplete/i)
})

test('backup names that try to escape the backups directory are rejected', () => {
  assert.throws(() => state.restoreBackup('../../etc'), /invalid backup name/i)
  assert.throws(() => state.deleteBackup('../../etc'), /invalid backup name/i)
})

test('a backup can be deleted, and only that one', () => {
  const keep = state.backupDatabases()
  const drop = state.backupDatabases()
  const before = state.listBackups().length
  assert.equal(state.deleteBackup(path.basename(drop)).deleted, path.basename(drop))
  assert.equal(fs.existsSync(drop), false)
  assert.equal(fs.existsSync(keep), true, 'other backups are untouched')
  assert.equal(state.listBackups().length, before - 1)
  assert.throws(() => state.deleteBackup(path.basename(drop)), /not found/i)
})

// ---------------------------------------------------------------------------
// Retention, staging and recovery (本地向量施工文档 §14.9).
// Every test below runs in its own temporary data root: no real user backup is
// created, pruned or restored by this file.
// ---------------------------------------------------------------------------
const backup = await import('../lib/backup.js')

function tempRoot(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-' + tag + '-'))
  process.env.DSH_MEMU_HOME = dir
  delete process.env.DSH_MEMU_BACKUP_NO_PYTHON
  delete process.env.DSH_MEMU_PYTHON
  backup.resetBackupPythonProbe()
  state.clearCaches()
  return dir
}

function releaseRoot(dir) {
  state.clearCaches()
  process.env.DSH_MEMU_HOME = home
  delete process.env.DSH_MEMU_BACKUP_NO_PYTHON
  delete process.env.DSH_MEMU_PYTHON
  backup.resetBackupPythonProbe()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

function seed(root, text) {
  fs.mkdirSync(path.join(root, 'index'), { recursive: true })
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ version: 1, marker: text }))
  fs.writeFileSync(path.join(root, 'index', 'lib-a.json'), JSON.stringify({ marker: text, entries: {} }))
  return root
}

function completeNames() {
  return backup.scanBackups({ verify: true }).filter((entry) => entry.status === 'complete').map((entry) => entry.name)
}

function statusOf(name) {
  const entry = backup.scanBackups().find((item) => item.name === name)
  return entry ? entry.status : null
}

test('retention keeps only the newest three complete backups', () => {
  const root = tempRoot('keep3')
  try {
    seed(root, 'v0')
    assert.deepEqual(backup.pruneBackups().deleted, [], 'an empty root prunes nothing')
    const made = []
    for (let round = 1; round <= 6; round += 1) {
      seed(root, 'v' + round)
      made.push(backup.createBackup().name)
      const complete = completeNames()
      assert.ok(complete.length <= 3, 'at most three complete backups after ' + round + ' creations')
      assert.deepEqual(complete.slice().sort(), made.slice(-3).slice().sort(), 'the newest three are the ones kept')
    }
    assert.equal(made.length, 6)
    for (const old of made.slice(0, 3)) assert.equal(fs.existsSync(path.join(root, 'backups', old)), false, 'older backups are cleaned up')
    for (const kept of made.slice(3)) assert.equal(fs.existsSync(path.join(root, 'backups', kept)), true)
  } finally { releaseRoot(root) }
})

test('backups created in the same millisecond stay distinct and ordered', () => {
  const root = tempRoot('samems')
  try {
    seed(root, 'same')
    const first = backup.createBackup().name
    const second = backup.createBackup().name
    assert.notEqual(first, second, 'the name is unique even within one millisecond')
    const entries = backup.scanBackups()
    assert.equal(entries.length, 2)
    assert.notEqual(entries[0].uniqueId, entries[1].uniqueId)
    assert.deepEqual(entries.map((entry) => entry.name), [second, first].sort().reverse(), 'newest first and deterministic')
    assert.match(entries[0].name, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z/)
  } finally { releaseRoot(root) }
})

test('a failed creation publishes nothing and deletes no usable backup', () => {
  const root = tempRoot('failed-create')
  try {
    seed(root, 'good')
    const kept = backup.createBackup().name
    // A directory where a file belongs: the copy must fail, not paper over it.
    fs.mkdirSync(path.join(root, 'prompts', 'manifest.json'), { recursive: true })
    assert.throws(() => backup.createBackup(), /non-file|symbolic/i)
    assert.deepEqual(completeNames(), [kept], 'the previous backup is intact')
    assert.equal(backup.scanBackups().length, 1, 'nothing was published')
    assert.deepEqual(fs.readdirSync(path.join(root, 'backups', '.staging')), [], 'the staging directory was discarded')
  } finally { releaseRoot(root) }
})

test('leftovers of a crashed run are reclaimed, never published', () => {
  const root = tempRoot('crash')
  try {
    seed(root, 'crash')
    const backups = path.join(root, 'backups')
    const abandoned = path.join(backups, '.staging', '2020-01-01T00-00-00-000Z.999999.crashed')
    fs.mkdirSync(abandoned, { recursive: true })
    fs.writeFileSync(path.join(abandoned, 'state.json'), '{}')
    // Power loss between copying the stores and writing the completion marker.
    const unpublished = path.join(backups, '2020-01-01T00-00-00-000Z-powerloss')
    fs.mkdirSync(unpublished, { recursive: true })
    fs.writeFileSync(path.join(unpublished, 'state.json'), '{}')
    const created = backup.createBackup()
    assert.equal(fs.existsSync(abandoned), false, 'staging of a dead process is reclaimed')
    assert.equal(fs.existsSync(unpublished), true, 'an unpublished directory is reported, never deleted')
    assert.equal(statusOf(path.basename(unpublished)), 'unknown')
    assert.equal(statusOf(created.name), 'complete')
    const pruned = backup.pruneBackups({ keep: 1 })
    assert.deepEqual(pruned.deleted, [], 'an unpublished directory never counts as a backup')
    assert.equal(fs.existsSync(unpublished), true)
    assert.ok(pruned.skipped.some((item) => item.name === path.basename(unpublished)), 'it is reported as skipped')
  } finally { releaseRoot(root) }
})

test('a backup whose bytes drifted is not counted as valid, and is not silently deleted', () => {
  const root = tempRoot('corrupt')
  try {
    seed(root, 'one')
    const first = backup.createBackup({ keep: 10 }).name
    seed(root, 'two')
    backup.createBackup({ keep: 10 })
    seed(root, 'three')
    backup.createBackup({ keep: 10 })
    seed(root, 'four')
    const newest = backup.createBackup({ keep: 10 }).name
    const victim = path.join(root, 'backups', first, 'state.json')
    const original = fs.readFileSync(victim, 'utf8')
    const flipped = original.slice(0, -2) + (original.slice(-2) === '1}' ? '2}' : '1}')
    assert.equal(Buffer.byteLength(flipped), Buffer.byteLength(original), 'same size, different bytes')
    fs.writeFileSync(victim, flipped)
    assert.throws(() => backup.restoreFromBackup(first, { keep: 10 }), /corrupt|checksum/i)
    const pruned = backup.pruneBackups()
    assert.equal(fs.existsSync(path.join(root, 'backups', first)), true, 'a corrupt backup is reported, not quietly removed')
    assert.ok(pruned.skipped.some((item) => item.name === first && item.status === 'corrupt'), 'it is reported as corrupt')
    assert.equal(completeNames().length, 3, 'only intact backups occupy the three slots')
    assert.ok(completeNames().includes(newest))
  } finally { releaseRoot(root) }
})

test('unknown and legacy directories survive retention untouched', () => {
  const root = tempRoot('foreign')
  try {
    seed(root, 'x')
    const good = backup.createBackup({ keep: 10 }).name
    const backups = path.join(root, 'backups')
    const handMade01 = path.join(backups, 'my-own-backup')
    fs.mkdirSync(handMade01, { recursive: true })
    fs.writeFileSync(path.join(handMade01, 'state.json'), '{}')
    // A backup written by an older engine: manifest without the completion marker.
    const legacyName = '2020-01-01T00-00-00-000Z-legacy'
    const legacy = path.join(backups, legacyName)
    fs.mkdirSync(legacy, { recursive: true })
    fs.writeFileSync(path.join(legacy, 'state.json'), '{}')
    fs.writeFileSync(path.join(legacy, 'manifest.json'), JSON.stringify({ version: 1, createdAt: '2020-01-01T00:00:00.000Z', files: { 'state.json': { bytes: 2, sha256: 'x' } } }))
    const pruned = backup.pruneBackups({ keep: 0 })
    assert.deepEqual(pruned.deleted, [good])
    assert.equal(fs.existsSync(handMade01), true, 'an unmanaged directory is never deleted')
    assert.equal(fs.existsSync(legacy), true, 'an incomplete backup is never deleted')
    assert.equal(statusOf('my-own-backup'), 'unknown')
    assert.equal(statusOf(legacyName), 'incomplete')
  } finally { releaseRoot(root) }
})

test('a backup that cannot be deleted safely is reported and left in place', () => {
  const root = tempRoot('delete-fail')
  try {
    seed(root, 'a')
    const older = backup.createBackup({ keep: 10 }).name
    seed(root, 'b')
    const newer = backup.createBackup({ keep: 10 }).name
    const nested = path.join(root, 'backups', older, 'attachments')
    fs.mkdirSync(nested, { recursive: true })
    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'important')
    // A junction inside the backup makes a recursive delete unsafe.
    fs.symlinkSync(outside, path.join(nested, 'link'), 'junction')
    const pruned = backup.pruneBackups({ keep: 1 })
    assert.deepEqual(pruned.deleted, [])
    assert.equal(pruned.failed.length, 1, 'the refusal is reported')
    assert.match(pruned.failed[0].error, /link/i)
    assert.equal(fs.existsSync(path.join(root, 'backups', older)), true, 'nothing was deleted')
    assert.equal(fs.existsSync(path.join(root, 'backups', newer)), true)
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'important', 'the link target is untouched')
  } finally { releaseRoot(root) }
})

test('one lock serializes create, restore, delete and prune', () => {
  const root = tempRoot('lock')
  try {
    seed(root, 'lock')
    // Reentrant: a restore makes its own safety backup while holding the lock.
    const inner = backup.withBackupLock(() => backup.createBackup({ keep: 10 }).name)
    assert.ok(inner)
    const lock = path.join(root, 'backups', '.backup.lock')
    fs.writeFileSync(lock, String(process.pid))
    try {
      assert.throws(() => backup.createBackup(), /busy/i)
    } finally { fs.rmSync(lock, { force: true }) }
    let deadPid = null
    for (let candidate = 999999; candidate < 1000100 && deadPid === null; candidate += 1) {
      try { process.kill(candidate, 0) } catch (error) { if (error && error.code === 'ESRCH') deadPid = candidate }
    }
    if (deadPid !== null) {
      fs.writeFileSync(lock, String(deadPid))
      const recovered = backup.createBackup({ keep: 10 })
      assert.ok(fs.existsSync(recovered.dir), 'a lock left by a dead process is reclaimed')
      assert.equal(fs.existsSync(lock), false, 'the lock is released')
    }
  } finally { releaseRoot(root) }
})

test('restoring the oldest of four keeps the target and its safety backup', () => {
  const root = tempRoot('restore-oldest')
  try {
    seed(root, 'oldest')
    const target = backup.createBackup({ keep: 10, label: 'manual' }).name
    for (const text of ['second', 'third', 'fourth']) {
      seed(root, text)
      backup.createBackup({ keep: 10 })
    }
    assert.equal(completeNames().length, 4)
    const result = backup.restoreFromBackup(target, { keep: 3 })
    assert.equal(result.restored, target)
    assert.ok(result.safety, 'a safety backup was made')
    assert.equal(fs.existsSync(path.join(root, 'backups', path.basename(result.safety))), true)
    assert.equal(fs.existsSync(path.join(root, 'backups', target)), true, 'the restore target is never pruned')
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).marker, 'oldest', 'the backed-up text is back')
    assert.equal(completeNames().length, 4, 'target plus safety may exceed three during the restore')
    const pruned = backup.pruneBackups({ keep: 3 })
    assert.equal(pruned.kept.length, 3, 'retention is reclaimed right after the operation')
    assert.equal(pruned.pendingCleanup, 0)
  } finally { releaseRoot(root) }
})

test('a restore validates the whole inventory before it writes anything', () => {
  const root = tempRoot('restore-guard')
  try {
    seed(root, 'backup')
    const name = backup.createBackup({ keep: 10 }).name
    seed(root, 'live')
    const liveBefore = fs.readFileSync(path.join(root, 'state.json'), 'utf8')
    const liveIndex = fs.readFileSync(path.join(root, 'index', 'lib-a.json'), 'utf8')
    fs.rmSync(path.join(root, 'backups', name, 'index', 'lib-a.json'))
    assert.throws(() => backup.restoreFromBackup(name, { keep: 10 }), /incomplete/i)
    assert.equal(fs.readFileSync(path.join(root, 'state.json'), 'utf8'), liveBefore, 'the live root is untouched')
    assert.equal(fs.readFileSync(path.join(root, 'index', 'lib-a.json'), 'utf8'), liveIndex)
    assert.equal(fs.existsSync(path.join(root, 'backups', name, 'state.json')), true)
  } finally { releaseRoot(root) }
})

test('a restore that fails while writing stays recoverable through its safety backup', () => {
  const root = tempRoot('restore-fail')
  try {
    seed(root, 'backup')
    fs.mkdirSync(path.join(root, 'attachments'), { recursive: true })
    fs.writeFileSync(path.join(root, 'attachments', 'a.txt'), 'attachment')
    const name = backup.createBackup({ keep: 10 }).name
    seed(root, 'live')
    fs.writeFileSync(path.join(root, 'attachments', 'a.txt'), 'attachment')
    // Make one restore target unwritable after the safety backup exists.
    fs.rmSync(path.join(root, 'attachments'), { recursive: true, force: true })
    fs.writeFileSync(path.join(root, 'attachments'), 'not a directory')
    let caught = null
    try { backup.restoreFromBackup(name, { keep: 10 }) } catch (error) { caught = error }
    assert.ok(caught, 'the restore failed')
    assert.equal(caught.code, 'DSH_MEMU_BACKUP_RESTORE_FAILED')
    assert.ok(caught.safety, 'the failure names the safety backup it kept')
    assert.match(caught.message, /saved as/i)
    const safety = path.join(root, 'backups', caught.safety)
    assert.equal(fs.existsSync(path.join(safety, 'state.json')), true)
    // Recovery: repair the obstacle, then roll back with the safety backup.
    fs.rmSync(path.join(root, 'attachments'), { force: true })
    fs.mkdirSync(path.join(root, 'attachments'), { recursive: true })
    const rollback = backup.restoreFromBackup(caught.safety, { keep: 10 })
    assert.equal(rollback.restored, caught.safety)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).marker, 'live')
  } finally { releaseRoot(root) }
})

test('a backup from before the vector journal retires the stale live pointer', () => {
  const root = tempRoot('vector')
  try {
    seed(root, 'text-only')
    const name = backup.createBackup({ keep: 10 }).name
    const live = path.join(root, 'index', 'vector-active.json')
    fs.writeFileSync(live, JSON.stringify({
      version: 1,
      generation: 2,
      active: {
        status: 'active',
        generation: 2,
        fingerprint: 'abcdef01',
        profile: { id: 'small' },
        databases: { global: { path: 'libraries/global.abcdef01.g2.sqlite3' }, libraries: {} },
      },
    }))
    const result = backup.restoreFromBackup(name, { keep: 10 })
    assert.equal(result.vectorActive, 'cleared')
    assert.equal(fs.existsSync(live), false, 'the stale pointer is gone')
    assert.ok(fs.readdirSync(path.join(root, 'index')).some((file) => file.indexOf('vector-active.json.stale-') === 0), 'it was moved aside, not lost')
  } finally { releaseRoot(root) }
})

test('retention and restore refuse paths that leave the data root', () => {
  const root = tempRoot('traversal')
  try {
    seed(root, 'tv')
    const name = backup.createBackup({ keep: 10 }).name
    const manifestPath = path.join(root, 'backups', name, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.files['../escaped.json'] = { bytes: 2, sha256: 'x' }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    assert.throws(() => backup.restoreFromBackup(name, { keep: 10 }), /invalid backup manifest path/)
    assert.throws(() => backup.deleteBackupEntry('..'), /invalid backup name/)
    assert.throws(() => backup.deleteBackupEntry('.staging'), /invalid backup name/)
    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    const linkedName = '2020-01-01T00-00-00-000Z-linked'
    fs.symlinkSync(outside, path.join(root, 'backups', linkedName), 'junction')
    assert.equal(statusOf(linkedName), 'unknown', 'a link is never treated as a backup')
    const pruned = backup.pruneBackups({ keep: 0 })
    assert.deepEqual(pruned.deleted, [], 'a manifest with an escaping path is never deleted')
    assert.ok(pruned.skipped.some((item) => item.name === name), 'and it is reported instead')
    assert.equal(fs.existsSync(path.join(root, 'backups', linkedName)), true, 'the link is not followed or deleted')
    assert.equal(fs.existsSync(outside), true)
  } finally { releaseRoot(root) }
})

test('the state API keeps its shape and reports the retention policy', () => {
  const root = tempRoot('api')
  try {
    const binding = state.ensureSession('api-session', { cwd: path.join(root, 'proj') })
    state.updatePrivateIndex(binding.libraryId, (index) => {
      index.entries['mem-api'] = { id: 'mem-api', content: '接口', layer: 'long_term', status: 'active' }
    })
    const dir = state.backupDatabases()
    assert.equal(typeof dir, 'string')
    assert.ok(fs.existsSync(path.join(dir, 'manifest.json')))
    for (let round = 0; round < 4; round += 1) state.backupDatabases()
    const listed = state.listBackups()
    assert.ok(Array.isArray(listed))
    assert.ok(listed.length >= 1)
    assert.ok(listed.filter((item) => item.status === 'complete').length <= 3, 'at most three complete backups')
    for (const item of listed) {
      assert.equal(typeof item.name, 'string')
      assert.equal(typeof item.dir, 'string')
      assert.ok(item.createdAt)
      assert.equal(typeof item.files, 'number')
      assert.equal(typeof item.bytes, 'number')
      assert.equal(typeof item.hasManifest, 'boolean')
    }
    const report = state.lastBackupReportView()
    assert.equal(report.action, 'create')
    assert.match(report.notice, /at most 3/)
    const oldest = listed[listed.length - 1]
    const restored = state.restoreBackup(oldest.name)
    assert.equal(restored.restored, oldest.name)
    assert.ok(restored.safety)
    assert.ok(state.loadPrivateIndex(binding.libraryId).entries['mem-api'], 'the restored library is readable')
  } finally { releaseRoot(root) }
})

test('the backup manifest carries identity, never a credential', () => {
  const root = tempRoot('secrets')
  try {
    seed(root, 'secret')
    fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({
      version: 1,
      settings: { apiKey: 'sk-abcdef0123456789abcdef', endpoint: 'https://user:pw@example.invalid/v1' },
    }))
    const name = backup.createBackup({ keep: 10 }).name
    const manifestText = fs.readFileSync(path.join(root, 'backups', name, 'manifest.json'), 'utf8')
    assert.equal(manifestText.indexOf('sk-abcdef0123456789abcdef'), -1, 'no key in the manifest')
    assert.equal(manifestText.indexOf('user:pw'), -1, 'no credential in a URL')
    const manifest = JSON.parse(manifestText)
    assert.equal(manifest.complete, true)
    assert.equal(typeof manifest.uniqueId, 'string')
    assert.ok(manifest.files['state.json'].sha256, 'the state file itself is still backed up')
  } finally { releaseRoot(root) }
})
// ---------------------------------------------------------------------------
// Live SQLite snapshotting (本地向量施工文档 §14.9, rule 2).
//
// A non-empty database may only be snapshotted by SQLite's own backup API, run
// by the plugin's isolated engine/<version>/venv interpreter. These tests prove
// the two halves of that rule: the engine snapshot is what lands in the backup,
// and every path where the engine cannot prove a snapshot FAILS CLOSED - no
// byte copy, no db+wal copy, no global Python, nothing published.
// ---------------------------------------------------------------------------

// 16 bytes of SQLite magic: enough for the header check, never a real database.
function sqliteFile(extra = '') {
  return Buffer.concat([Buffer.from('SQLite format 3', 'latin1'), Buffer.from([0]), Buffer.from(extra || 'x', 'latin1')])
}

function seedDatabase(root, rel, bytes) {
  const full = path.join(root, rel.split('/').join(path.sep))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, bytes)
  return full
}

/** An engine install as engine.js leaves it: venv on disk plus current.json. */
function fakeEngine(root, version = '9.9.9') {
  const venv = path.join(root, 'engine', version, 'venv')
  const bin = process.platform === 'win32' ? path.join(venv, 'Scripts') : path.join(venv, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const python = path.join(bin, process.platform === 'win32' ? 'python.exe' : 'python3')
  fs.writeFileSync(python, '')
  fs.writeFileSync(path.join(root, 'engine', 'current.json'), JSON.stringify({ version, venv, python }))
  return { venv, python }
}

/**
 * Stands in for the venv interpreter. A two-argument call is the probe, a
 * four-argument call is the backup API. \`snapshot\` selects the behaviour.
 */
function fakeInterpreter(venv, { snapshot = 'ok', calls = [] } = {}) {
  return (cmd, args) => {
    calls.push({ cmd, args })
    if (args.length === 2) {
      return { status: 0, stdout: JSON.stringify({ ok: true, prefix: venv, sqlite: '3.45.0' }), stderr: '' }
    }
    const target = args[3]
    if (snapshot === 'ok') {
      fs.writeFileSync(target, Buffer.concat([sqliteFile(), Buffer.from('ENGINE-SNAPSHOT', 'latin1')]))
      return { status: 0, stdout: JSON.stringify({ ok: true, quickCheck: 'ok' }), stderr: '' }
    }
    if (snapshot === 'io-error') return { status: 0, stdout: JSON.stringify({ ok: false, error: 'disk I/O error' }), stderr: '' }
    if (snapshot === 'bad-check') {
      fs.writeFileSync(target, sqliteFile())
      return { status: 0, stdout: JSON.stringify({ ok: true, quickCheck: 'database disk image is malformed' }), stderr: '' }
    }
    if (snapshot === 'no-header') {
      fs.writeFileSync(target, 'not a database')
      return { status: 0, stdout: JSON.stringify({ ok: true, quickCheck: 'ok' }), stderr: '' }
    }
    return { status: 2, stdout: '', stderr: 'Traceback: interpreter crashed' }
  }
}

function stagedFiles(root) {
  return fs.readdirSync(path.join(root, 'backups', '.staging'))
}

test('a non-empty database is snapshotted by the engine, never copied', () => {
  const root = tempRoot('engine-snapshot')
  try {
    seed(root, 'live')
    const live = seedDatabase(root, 'libraries/lib-a.sqlite3', sqliteFile('LIVE-BYTES-ONLY'))
    seedDatabase(root, 'libraries/lib-a.sqlite3-wal', Buffer.alloc(64, 7))
    const engine = fakeEngine(root)
    const calls = []
    const created = backup.createBackup({ keep: 10, pythonExec: fakeInterpreter(engine.venv, { calls }) })

    const copy = fs.readFileSync(path.join(created.dir, 'libraries', 'lib-a.sqlite3'))
    assert.equal(copy.toString('latin1').includes('ENGINE-SNAPSHOT'), true, 'the published file is the engine snapshot')
    assert.equal(copy.toString('latin1').includes('LIVE-BYTES-ONLY'), false, 'the live bytes were not copied')
    assert.equal(fs.existsSync(path.join(created.dir, 'libraries', 'lib-a.sqlite3-wal')), false, 'no WAL sidecar is published')
    assert.equal(fs.readFileSync(live, 'latin1').includes('LIVE-BYTES-ONLY'), true, 'the live database is untouched')

    const manifest = JSON.parse(fs.readFileSync(path.join(created.dir, 'manifest.json'), 'utf8'))
    const snapshot = manifest.snapshot.databases.find((item) => item.file === 'libraries/lib-a.sqlite3')
    assert.equal(snapshot.mode, 'sqlite-backup-api')
    assert.equal(snapshot.quickCheck, 'ok')
    assert.equal(snapshot.engine, '9.9.9', 'the manifest names the engine that took the snapshot')
    assert.equal(created.snapshots[0].engine, '9.9.9')
    assert.ok(calls.some((call) => call.args.length === 4), 'the engine interpreter ran the backup API')
    assert.ok(calls.every((call) => call.cmd === engine.python), 'and it is the venv interpreter, not something else')
  } finally { releaseRoot(root) }
})

test('without a verified engine the backup fails and publishes nothing', () => {
  const root = tempRoot('no-engine')
  try {
    seed(root, 'live')
    const live = seedDatabase(root, 'libraries/lib-a.sqlite3', sqliteFile('LIVE-BYTES'))
    const before = fs.readFileSync(live)
    let caught = null
    try { backup.createBackup({ keep: 10 }) } catch (error) { caught = error }
    assert.ok(caught, 'the backup refused')
    assert.equal(caught.code, 'DSH_MEMU_BACKUP_ENGINE_REQUIRED')
    assert.match(caught.message, /engine/)
    assert.match(caught.message, /Nothing was copied/)
    assert.equal(backup.scanBackups().length, 0, 'no backup directory appeared')
    assert.deepEqual(stagedFiles(root), [], 'the staging directory was discarded')
    assert.deepEqual(fs.readFileSync(live), before, 'the live database was not touched')
  } finally { releaseRoot(root) }
})

test('a global interpreter is never borrowed, and a shim is caught by sys.prefix', () => {
  const root = tempRoot('global-python')
  try {
    seed(root, 'live')
    seedDatabase(root, 'libraries/lib-a.sqlite3', sqliteFile('LIVE-BYTES'))
    const engine = fakeEngine(root)
    // DSH_MEMU_PYTHON is what the old resolution order trusted first. It must
    // not even be consulted now.
    const decoy = path.join(root, 'global-python.exe')
    fs.writeFileSync(decoy, '')
    process.env.DSH_MEMU_PYTHON = decoy
    const calls = []
    // A venv python that hands the work to the global interpreter reports the
    // global sys.prefix, which is the proof the isolation check needs.
    const outside = path.join(os.tmpdir(), 'not-an-engine')
    fs.mkdirSync(outside, { recursive: true })
    const shim = (cmd, args) => {
      calls.push({ cmd, args })
      if (args.length === 2) return { status: 0, stdout: JSON.stringify({ ok: true, prefix: outside, sqlite: '3.45.0' }), stderr: '' }
      fs.writeFileSync(args[3], sqliteFile('WRONG'))
      return { status: 0, stdout: JSON.stringify({ ok: true, quickCheck: 'ok' }), stderr: '' }
    }
    let caught = null
    try { backup.createBackup({ keep: 10, pythonExec: shim }) } catch (error) { caught = error }
    assert.ok(caught, 'the backup refused')
    assert.equal(caught.code, 'DSH_MEMU_BACKUP_ENGINE_REQUIRED')
    assert.match(caught.message, /sys\.prefix/)
    assert.ok(calls.every((call) => call.cmd !== decoy), 'the decoy interpreter was never executed')
    assert.ok(calls.every((call) => call.args.length === 2), 'no snapshot was attempted through the shim')
    assert.equal(backup.scanBackups().length, 0)
    assert.equal(fs.existsSync(path.join(root, 'backups', 'libraries')), false)
  } finally { releaseRoot(root) }
})

test('an engine that cannot prove its snapshot fails the whole backup', () => {
  for (const [snapshot, expected] of [
    ['io-error', /disk I\/O error/],
    ['bad-check', /quick_check/],
    ['no-header', /no SQLite database header/],
    ['crashes', /interpreter crashed/],
  ]) {
    const root = tempRoot('snapshot-' + snapshot)
    try {
      seed(root, snapshot)
      seedDatabase(root, 'libraries/lib-a.sqlite3', sqliteFile('LIVE-BYTES'))
      const engine = fakeEngine(root)
      let caught = null
      try { backup.createBackup({ keep: 10, pythonExec: fakeInterpreter(engine.venv, { snapshot }) }) } catch (error) { caught = error }
      assert.ok(caught, snapshot + ': the backup refused')
      assert.equal(caught.code, 'DSH_MEMU_BACKUP_SNAPSHOT_FAILED', snapshot + ': the refusal names the snapshot step')
      assert.match(caught.message, expected)
      assert.equal(backup.scanBackups().length, 0, snapshot + ': nothing was published')
      assert.deepEqual(stagedFiles(root), [], snapshot + ': no partial snapshot is left behind')
      assert.equal(fs.existsSync(path.join(root, 'backups', 'libraries')), false, snapshot + ': no torn copy exists anywhere')
    } finally { releaseRoot(root) }
  }
})

test('a zero-byte placeholder is copied and needs no engine', () => {
  const root = tempRoot('placeholder')
  try {
    seed(root, 'empty')
    seedDatabase(root, 'global.sqlite3', Buffer.alloc(0))
    const created = backup.createBackup({ keep: 10 })
    const manifest = JSON.parse(fs.readFileSync(path.join(created.dir, 'manifest.json'), 'utf8'))
    const snapshot = manifest.snapshot.databases.find((item) => item.file === 'global.sqlite3')
    assert.equal(snapshot.mode, 'empty-placeholder')
    assert.equal(snapshot.quickCheck, 'empty')
    assert.equal(fs.statSync(path.join(created.dir, 'global.sqlite3')).size, 0)
  } finally { releaseRoot(root) }
})

test('a non-empty file that is not SQLite is refused instead of copied', () => {
  const root = tempRoot('not-sqlite')
  try {
    seed(root, 'junk')
    seedDatabase(root, 'global.sqlite3', Buffer.alloc(4096, 65))
    let caught = null
    try { backup.createBackup({ keep: 10 }) } catch (error) { caught = error }
    assert.ok(caught)
    assert.equal(caught.code, 'DSH_MEMU_BACKUP_NOT_SQLITE')
    assert.match(caught.message, /neither an empty placeholder nor a SQLite database/)
    assert.equal(backup.scanBackups().length, 0)
  } finally { releaseRoot(root) }
})

test('even with an installed engine, force-unavailable sqlite refuses rather than copies', () => {
  const root = tempRoot('no-python-switch')
  try {
    seed(root, 'live')
    seedDatabase(root, 'libraries/lib-a.sqlite3', sqliteFile('LIVE-BYTES'))
    const engine = fakeEngine(root)
    process.env.DSH_MEMU_BACKUP_NO_PYTHON = '1'
    backup.resetBackupPythonProbe()
    let caught = null
    try { backup.createBackup({ keep: 10, pythonExec: fakeInterpreter(engine.venv) }) } catch (error) { caught = error }
    assert.ok(caught, 'the forced-unavailable engine refuses')
    assert.equal(caught.code, 'DSH_MEMU_BACKUP_ENGINE_REQUIRED')
    assert.equal(backup.scanBackups().length, 0)
  } finally { releaseRoot(root) }
})

test('a refused backup is visible through the state API, not swallowed', () => {
  const root = tempRoot('refusal-report')
  try {
    seed(root, 'live')
    seedDatabase(root, 'libraries/lib-a.sqlite3', sqliteFile('LIVE-BYTES'))
    assert.throws(() => state.backupDatabases(), /engine/i)
    const report = state.lastBackupReportView()
    assert.equal(report.action, 'create')
    assert.equal(report.status, 'failed')
    assert.equal(report.code, 'DSH_MEMU_BACKUP_ENGINE_REQUIRED')
    assert.match(report.error, /engine/)
    assert.equal(report.dir, null)
  } finally { releaseRoot(root) }
})
// Opt-in end-to-end proof against a real venv and a real WAL database:
//   DSH_MEMU_BACKUP_REAL_ENGINE=1 npm test
// It is skipped by default for the same reason every other real-engine case in
// this repo is: it needs a base Python to create the venv with (the venv is
// built exactly the way lib/engine.js builds it) and it takes a few seconds.
test('a real venv interpreter folds a real live WAL into the backup', (t) => {
  if (process.env.DSH_MEMU_BACKUP_REAL_ENGINE !== '1') {
    t.skip('set DSH_MEMU_BACKUP_REAL_ENGINE=1 to run the real-engine case')
    return
  }
  const base = [
    process.platform === 'win32' ? ['py', ['-3']] : ['python3', []],
    ['python3', []],
    ['python', []],
  ].map(([cmd, prefix]) => ({ cmd, prefix })).find((candidate) => {
    try {
      const probe = spawnSync(candidate.cmd, candidate.prefix.concat(['-c', 'import sqlite3, sys']), { encoding: 'utf8', windowsHide: true })
      return probe.status === 0
    } catch { return false }
  })
  if (!base) { t.skip('no base Python available to build a venv'); return }

  const root = tempRoot('real-engine')
  try {
    const version = '9.9.9'
    const venv = path.join(root, 'engine', version, 'venv')
    const built = spawnSync(base.cmd, base.prefix.concat(['-m', 'venv', '--without-pip', venv]), { encoding: 'utf8', windowsHide: true })
    assert.equal(built.status, 0, 'the venv was created: ' + String(built.stderr || ''))
    const python = process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python3')
    assert.equal(fs.existsSync(python), true)
    fs.writeFileSync(path.join(root, 'engine', 'current.json'), JSON.stringify({ version, venv, python }))

    seed(root, 'real')
    const db = seedDatabase(root, 'libraries/lib-real.sqlite3', '')
    const made = spawnSync(python, ['-c', [
      'import os, sqlite3',
      'conn = sqlite3.connect(os.environ["DB"])',
      'conn.execute("pragma journal_mode=wal")',
      'conn.execute("create table t (id integer primary key, v text)")',
      'conn.executemany("insert into t (v) values (?)", [("a",), ("b",), ("c",)])',
      'conn.commit()',
      'os._exit(0)',
    ].join(String.fromCharCode(10))], { encoding: 'utf8', windowsHide: true, env: { ...process.env, DB: db } })
    assert.equal(made.status, 0, 'the live database was written: ' + String(made.stderr || ''))
    assert.ok(fs.statSync(db + '-wal').size > 0, 'the database really has a live WAL to fold in')

    const created = backup.createBackup({ keep: 10 })
    const manifest = JSON.parse(fs.readFileSync(path.join(created.dir, 'manifest.json'), 'utf8'))
    const snapshot = manifest.snapshot.databases.find((item) => item.file === 'libraries/lib-real.sqlite3')
    assert.equal(snapshot.mode, 'sqlite-backup-api')
    assert.equal(snapshot.quickCheck, 'ok')
    assert.equal(snapshot.engine, version)
    assert.equal(fs.existsSync(path.join(created.dir, 'libraries', 'lib-real.sqlite3-wal')), false, 'the WAL was folded in, not copied beside it')

    // The published file must be a self-contained database holding the rows
    // that were still in the WAL when the backup started.
    const read = spawnSync(python, ['-c', [
      'import os, sqlite3',
      'conn = sqlite3.connect("file:" + os.environ["DB"] + "?mode=ro", uri=True)',
      'print(conn.execute("pragma quick_check").fetchone()[0])',
      'print(conn.execute("select count(*) from t").fetchone()[0])',
      'conn.close()',
    ].join(String.fromCharCode(10))], { encoding: 'utf8', windowsHide: true, env: { ...process.env, DB: path.join(created.dir, 'libraries', 'lib-real.sqlite3') }, cwd: path.join(created.dir, 'libraries') })
    const lines = String(read.stdout || '').trim().split(/\r?\n/)
    assert.equal(lines[0], 'ok', 'the snapshot passes quick_check')
    assert.equal(lines[1], '3', 'every committed row made it in, including the WAL frames')
  } finally { releaseRoot(root) }
})
test('an engine still installing (venv.tmp-*) can take the snapshot too', () => {
  // The repair path: lib/engine.js backs up with beforeSwitch while the new
  // venv is still `venv.tmp-*` and current.json still points at the broken one.
  const root = tempRoot('repair')
  try {
    seed(root, 'live')
    seedDatabase(root, 'libraries/lib-a.sqlite3', sqliteFile('LIVE-BYTES'))
    const venv = path.join(root, 'engine', '0.11.0b3', 'venv.tmp-' + process.pid + '-1')
    const bin = process.platform === 'win32' ? path.join(venv, 'Scripts') : path.join(venv, 'bin')
    fs.mkdirSync(bin, { recursive: true })
    const python = path.join(bin, process.platform === 'win32' ? 'python.exe' : 'python3')
    fs.writeFileSync(python, '')
    const created = backup.createBackup({ keep: 10, pythonExec: fakeInterpreter(venv) })
    const manifest = JSON.parse(fs.readFileSync(path.join(created.dir, 'manifest.json'), 'utf8'))
    const snapshot = manifest.snapshot.databases.find((item) => item.file === 'libraries/lib-a.sqlite3')
    assert.equal(snapshot.mode, 'sqlite-backup-api')
    assert.equal(snapshot.engine, '0.11.0b3')
  } finally { releaseRoot(root) }
})

test('lib/backup.js cannot reach a global interpreter or a copy fallback', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'backup.js'), 'utf8')
  assert.equal(src.includes('DSH_MEMU_PYTHON'), false, 'the env override is not consulted at all')
  assert.equal(src.includes('pythonCandidates'), false, 'the PATH/py-launcher candidate list is gone')
  assert.equal(src.includes("'-3'"), false, 'no py-launcher flag survives')
  assert.ok(src.includes("path.join(venv, 'bin', 'python3')"), true, 'the only interpreter is the one inside the venv')
  assert.equal(src.includes('COPY_ATTEMPTS'), false, 'the retry-copy loop is gone')
  assert.equal(src.includes('guarded-copy'), false, 'and so is the guarded copy mode')
  assert.equal(src.includes('signatureOf'), false, 'nor the size+mtime stability check that used to justify a copy')
});
