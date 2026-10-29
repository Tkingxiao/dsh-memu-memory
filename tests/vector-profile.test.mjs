import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-vector-profile-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const catalog = await import('../lib/embedding-catalog.js')
const vp = await import('../lib/vector-profile.js')

const BGE = 'bge-small-zh-v1.5-int8'
const entry = catalog.getEmbeddingModel(BGE)
const profile = vp.profileFromCatalog(BGE)
const librariesRoot = path.join(home, 'libraries')
const activeFile = path.join(home, 'index', 'vector-active.json')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function resetHome() {
  fs.rmSync(path.join(home, 'index'), { recursive: true, force: true })
  fs.rmSync(librariesRoot, { recursive: true, force: true })
}

function makeDatabases(fp, generation, libraryIds = []) {
  const databases = {
    global: { path: vp.vectorDbRelPath({ libraryId: null, fingerprint: fp, generation }), bytes: 6, sha256: null },
    libraries: {},
  }
  for (const id of libraryIds) {
    databases.libraries[id] = { path: vp.vectorDbRelPath({ libraryId: id, fingerprint: fp, generation }), bytes: 6, sha256: null }
  }
  return databases
}

function touchDatabases(databases) {
  fs.mkdirSync(librariesRoot, { recursive: true })
  for (const item of [databases.global, ...Object.values(databases.libraries)]) {
    fs.writeFileSync(path.join(home, ...item.path.split('/')), 'sqlite')
  }
}

function activate({ fp = profile.fingerprint, generation = 1, libraryIds = ['lib_a'], previous = null, pending = null, profileValue = profile } = {}) {
  const databases = makeDatabases(fp, generation, libraryIds)
  touchDatabases(databases)
  vp.updateVectorStateSync(current => ({
    ...current,
    generation,
    active: {
      status: 'active',
      generation,
      fingerprint: fp,
      profile: profileValue,
      databases,
      snapshot: { digest: 'snapshot-' + generation, at: new Date(0).toISOString() },
      previous,
      updatedAt: new Date(0).toISOString(),
    },
    pending,
  }))
  return databases
}

function code(fn) {
  try {
    fn()
  } catch (error) {
    return error.code
  }
  return null
}

function assertCode(fn, expected) {
  assert.throws(fn, error => {
    assert.equal(error.code, expected, 'expected ' + expected + ' but got ' + error.code + ' (' + error.message + ')')
    return true
  })
}

// ---------------------------------------------------------------- 身份

test('profile fingerprint is the catalog protocol, not a local reimplementation', () => {
  const built = vp.buildProfile(entry)
  assert.equal(built.fingerprint, entry.profileFingerprint)
  assert.equal(built.fingerprint, catalog.profileFingerprint(entry))
  assert.match(built.fingerprint, /^[0-9a-f]{64}$/)
  assert.equal(built.schema, 1)
  assert.equal(built.dimension, 512)
  assert.equal(built.maxTokens, 512)
  assert.equal(built.pooling, 'cls')
  assert.equal(built.normalization, 'l2')
  assert.equal(built.provider, 'modelscope')
  assert.equal(built.revision, '313386ad7ffad360a4870fd1910f8ecaf1a05151')
  assert.equal(built.graphSha256, entry.files.find(file => file.role === 'graph').sha256)
  assert.ok(Object.isFrozen(built))
  assert.ok(Object.isFrozen(built.files))
  // 任何改变向量空间的字段都必须改变指纹（catalog 协议）
  assert.notEqual(vp.buildProfile({ ...entry, pooling: 'mean' }).fingerprint, built.fingerprint)
  assert.notEqual(vp.buildProfile({ ...entry, prefixes: { query: 'q: ', document: 'd: ' } }).fingerprint, built.fingerprint)
  assert.notEqual(vp.buildProfile({ ...entry, dimension: 384 }).fingerprint, built.fingerprint)
})

test('manifestDigest covers artifacts, not prose', () => {
  const digest = vp.manifestDigest(entry)
  assert.match(digest, /^[0-9a-f]{64}$/)
  assert.equal(digest, vp.manifestDigest({ ...clone(entry), profileFingerprint: 'f'.repeat(64) }))
  // 改说明文字/显示名不能判废用户已激活的 profile（2026-10-30 现场：改了 catalog 里一句
  // 文档路径，manifest digest 变化，整个向量空间被拒不使用）。
  assert.equal(digest, vp.manifestDigest({ ...clone(entry), displayName: 'renamed', summary: '新说明', parameterSource: 'x' }))
  // 制品字节变了才算变。
  const tampered = clone(entry)
  tampered.files[0].sha256 = 'f'.repeat(64)
  assert.notEqual(digest, vp.manifestDigest(tampered))
  assert.equal(vp.manifestDigest(null), null)
})

test('a legacy full-manifest digest written by an older build is still accepted', () => {
  const legacy = vp.legacyManifestDigest(entry)
  assert.equal(vp.manifestDigestAccepted(legacy, entry), true)
  assert.equal(vp.manifestDigestAccepted(vp.manifestDigest(entry), entry), true)
  assert.equal(vp.manifestDigestAccepted('0'.repeat(64), entry), false)
  assert.equal(vp.manifestDigestAccepted(undefined, entry), true, 'profiles from before the digest existed')
})

test('profile depends on the catalog only: it never touches state', () => {
  resetHome()
  const built = vp.buildProfile(entry)
  assert.equal(fs.existsSync(path.join(home, 'index')), false, 'building a profile must not write the active manifest')
  assert.equal(built.fingerprint, vp.buildProfile(entry).fingerprint)
})

// ---------------------------------------------------------------- 拒绝

test('a pending model is refused instead of guessed', () => {
  assertCode(() => vp.profileFromCatalog('multilingual-e5-small'), 'VECTOR_PROFILE_PENDING')
  assertCode(() => vp.profileFromCatalog('all-minilm-l6-v2-int8'), 'VECTOR_PROFILE_PENDING')
  assertCode(() => vp.profileFromCatalog('nope-not-in-catalog'), 'VECTOR_PROFILE_UNKNOWN')
  assertCode(() => vp.profileFromCatalog(null), 'VECTOR_PROFILE_UNKNOWN')
})

test('an unverified manifest is refused', () => {
  const unverified = clone(entry)
  unverified.verification = { ...unverified.verification, status: 'unverified' }
  assertCode(() => vp.assertManifestUsable(unverified), 'VECTOR_PROFILE_UNVERIFIED')
  const noFiles = clone(entry)
  noFiles.files = []
  noFiles.graph = null
  assertCode(() => vp.assertManifestUsable(noFiles), 'VECTOR_PROFILE_UNVERIFIED')
  const tampered = clone(entry)
  tampered.profileFingerprint = '0'.repeat(64)
  assertCode(() => vp.assertManifestUsable(tampered), 'VECTOR_PROFILE_UNVERIFIED')
})

test('a profile whose catalog entry changed or vanished is refused', () => {
  assertCode(() => vp.assertProfileVerified({ ...profile, fingerprint: 'a'.repeat(64) }), 'VECTOR_PROFILE_FINGERPRINT_MISMATCH')
  assertCode(() => vp.assertProfileVerified({ ...profile, manifestDigest: 'b'.repeat(64) }), 'VECTOR_PROFILE_MANIFEST_CHANGED')
  assertCode(() => vp.assertProfileVerified({ ...profile, catalogId: 'gone-model' }), 'VECTOR_PROFILE_UNKNOWN')
  assertCode(() => vp.assertProfileVerified(null), 'VECTOR_PROFILE_MISSING')
  assert.equal(vp.assertProfileVerified(profile), profile)
})

// ---------------------------------------------------------------- 路径

test('database paths are generation-scoped and live under librariesDir', () => {
  const fp = profile.fingerprint
  const short = fp.slice(0, 8)
  assert.equal(vp.vectorDbRelPath({ fingerprint: fp, generation: 3 }), 'libraries/global.' + short + '.g3.sqlite3')
  assert.equal(vp.vectorDbRelPath({ libraryId: 'lib_a', fingerprint: fp, generation: 3 }), 'libraries/lib_a.' + short + '.g3.sqlite3')
  const glob = vp.vectorDbAbsPath({ fingerprint: fp, generation: 3 })
  assert.equal(path.dirname(glob), librariesRoot, 'the global shadow must be scanned by backups')
  assert.equal(vp.vectorDbAbsPath({ libraryId: null, fingerprint: fp, generation: 1 }), vp.vectorDbAbsPath({ fingerprint: fp, generation: 1 }))
  assert.notEqual(vp.vectorDbAbsPath({ fingerprint: fp, generation: 1 }), vp.vectorDbAbsPath({ fingerprint: fp, generation: 2 }))
  assertCode(() => vp.vectorDbRelPath({ libraryId: '../escape', fingerprint: fp, generation: 1 }), 'VECTOR_PATH_ESCAPE')
  assertCode(() => vp.vectorDbRelPath({ fingerprint: fp, generation: 0 }), 'VECTOR_BAD_UPDATE')
})

test('stored paths cannot escape the data root', () => {
  assertCode(() => vp.resolveVectorPath('../outside.sqlite3'), 'VECTOR_PATH_ESCAPE')
  assertCode(() => vp.resolveVectorPath('libraries/../../outside.sqlite3'), 'VECTOR_PATH_ESCAPE')
  assertCode(() => vp.resolveVectorPath(path.join(home, 'absolute.sqlite3')), 'VECTOR_PATH_ESCAPE')
  assertCode(() => vp.resolveVectorPath(''), 'VECTOR_PATH_ESCAPE')
  assert.equal(vp.resolveVectorPath('libraries/x.sqlite3'), path.join(librariesRoot, 'x.sqlite3'))
})

test('without an active generation the plugin keeps the legacy library paths', () => {
  resetHome()
  assert.equal(vp.dbPathFor('lib_a'), path.join(librariesRoot, 'lib_a.sqlite3'))
  assert.equal(vp.dbPathFor(null), path.join(home, 'global.sqlite3'))
  assert.equal(vp.activeProfile(), null)
  assertCode(() => vp.assertVectorWriteAllowed(), 'VECTOR_NOT_ACTIVE')
  assert.equal(vp.tryCaptureGeneration(), null)
})

// ---------------------------------------------------------------- 代际选择

test('one atomic manifest selects profile and database set together', () => {
  resetHome()
  const databases = activate({ generation: 2, libraryIds: ['lib_a', 'lib_b'] })
  const active = vp.activeDatabases()
  assert.equal(active.generation, 2)
  assert.equal(active.fingerprint, profile.fingerprint)
  assert.equal(active.global, path.join(home, ...databases.global.path.split('/')))
  assert.equal(active.libraries.lib_a, path.join(home, ...databases.libraries.lib_a.path.split('/')))
  assert.equal(active.libraries.lib_b, path.join(home, ...databases.libraries.lib_b.path.split('/')))
  // 每个库都在同一个代际里（不会出现新旧混空间的中间态）
  assert.match(active.libraries.lib_a, /\.g2\.sqlite3$/)
  assert.match(active.libraries.lib_b, /\.g2\.sqlite3$/)
  assert.equal(vp.dbPathFor('lib_a'), active.libraries.lib_a)
  assert.equal(vp.dbPathFor('lib_b'), active.libraries.lib_b)
  // active 代际里没有的库不猜路径：绝不再回落到 legacy 库或远端（那样写入会落在未受管的库里）
  assertCode(() => vp.dbPathFor('lib_unknown'), 'VECTOR_TORN_STATE')
  assert.equal(vp.activeGeneration(), 2)
  assert.equal(vp.activeProfile().fingerprint, profile.fingerprint)
})

test('requested stays separate from active until a switch happens', () => {
  resetHome()
  assert.equal(vp.requestedProfile(), null)
  vp.setRequestedProfile(BGE)
  assert.equal(vp.requestedProfile().catalogId, BGE)
  assert.equal(vp.requestedProfile().fingerprint, profile.fingerprint)
  assert.equal(vp.activeProfile(), null, 'requesting a model must not activate it')
  activate({ generation: 1 })
  assert.equal(vp.requestedProfile().catalogId, BGE, 'activation keeps the requested record')
  assert.equal(vp.activeGeneration(), 1)
  vp.clearRequestedProfile()
  assert.equal(vp.requestedProfile(), null)
  assert.equal(vp.activeGeneration(), 1, 'clearing requested must not disturb the active generation')
  assert.equal(vp.nextGeneration(), 2)
})

test('a torn active manifest is refused instead of guessed', () => {
  resetHome()
  const databases = activate({ generation: 4 })
  // 缺库
  fs.rmSync(path.join(home, ...databases.libraries.lib_a.path.split('/')))
  assertCode(() => vp.assertVectorWriteAllowed(), 'VECTOR_TORN_STATE')
  assert.equal(vp.vectorStatus().status, 'torn')
  // 补回来又好了
  touchDatabases(databases)
  assert.equal(vp.assertVectorWriteAllowed().generation, 4)
  // journal 说别的代际已提交
  vp.updateVectorStateSync(state => ({ ...state, pending: { status: 'committed', generation: 9, fingerprint: profile.fingerprint, token: 't', previousGeneration: 4, profile, databases: state.active.databases } }))
  assertCode(() => vp.assertVectorWriteAllowed(), 'VECTOR_TORN_STATE')
})

test('invalid or corrupt manifests are typed errors, never a silent fallback', () => {
  resetHome()
  fs.mkdirSync(path.join(home, 'index'), { recursive: true })
  fs.writeFileSync(activeFile, '{ not json')
  assertCode(() => vp.vectorState(), 'VECTOR_ACTIVE_CORRUPT')
  assertCode(() => vp.assertVectorWriteAllowed(), 'VECTOR_ACTIVE_CORRUPT')
  assertCode(() => vp.updateVectorStateSync(() => ({ version: 1 })), 'VECTOR_ACTIVE_CORRUPT')
  fs.writeFileSync(activeFile, JSON.stringify({ version: 1, active: { status: 'active', generation: 1 } }))
  assertCode(() => vp.vectorState(), 'VECTOR_ACTIVE_CORRUPT')
  fs.writeFileSync(activeFile, JSON.stringify({ version: 1, active: null, pending: { status: 'weird' } }))
  assertCode(() => vp.vectorState(), 'VECTOR_TORN_STATE')
})

test('paths recorded in the manifest cannot escape the data root', () => {
  resetHome()
  const good = activate({ generation: 3 })
  vp.updateVectorStateSync(state => ({
    ...state,
    active: { ...state.active, databases: { global: { path: '../global.sqlite3' }, libraries: good.libraries } },
  }))
  assertCode(() => vp.assertVectorWriteAllowed(), 'VECTOR_TORN_STATE')
})

test('the manifest lock never spans an await', () => {
  resetHome()
  activate({ generation: 1 })
  assertCode(() => vp.updateVectorStateSync(async state => state), 'VECTOR_BAD_UPDATE')
})

// ---------------------------------------------------------------- 护栏

test('guard captures one generation per turn and rejects stale ones', () => {
  resetHome()
  activate({ generation: 5, libraryIds: ['lib_a'] })
  const captured = vp.captureGeneration()
  assert.equal(captured.generation, 5)
  assert.equal(captured.token, 'gen:5:' + profile.fingerprint.slice(0, 8))
  assert.deepEqual(vp.assertGeneration(captured).generation, 5)
  // 回合进行中切换了代际：in-flight 结果不得计入新代
  activate({ generation: 6, libraryIds: ['lib_a'] })
  assertCode(() => vp.assertGeneration(captured), 'VECTOR_STALE_GENERATION')
  assertCode(() => vp.assertGeneration(null), 'VECTOR_NO_GENERATION')
  // 库集合变了也算过期
  const latest = vp.captureGeneration()
  activate({ generation: 7, libraryIds: ['lib_a', 'lib_b'] })
  assertCode(() => vp.assertGeneration(latest), 'VECTOR_STALE_GENERATION')
})

test('guard refuses vectors when the profile itself is no longer verified', () => {
  resetHome()
  activate({ generation: 2 })
  vp.updateVectorStateSync(state => ({ ...state, active: { ...state.active, profile: { ...state.active.profile, manifestDigest: 'c'.repeat(64) } } }))
  assertCode(() => vp.assertVectorWriteAllowed(), 'VECTOR_PROFILE_MANIFEST_CHANGED')
  vp.updateVectorStateSync(state => ({ ...state, active: { ...state.active, profile: { ...state.active.profile, manifestDigest: profile.manifestDigest, catalogId: 'ghost' } } }))
  assertCode(() => vp.assertVectorWriteAllowed(), 'VECTOR_PROFILE_UNKNOWN')
})

test('deep guard catches a database that shrank below its committed size', () => {
  resetHome()
  const databases = activate({ generation: 2 })
  const target = path.join(home, ...databases.libraries.lib_a.path.split('/'))
  fs.writeFileSync(target, 'sq')
  assert.equal(vp.assertVectorWriteAllowed().generation, 2, 'runtime checks do not compare sizes')
  assertCode(() => vp.assertVectorWriteAllowed({ deep: true }), 'VECTOR_TORN_STATE')
})

test('every vector error is a typed lexical-fallback error', () => {
  const error = vp.vectorError('VECTOR_TEST', 'boom')
  assert.equal(error.code, 'VECTOR_TEST')
  assert.equal(error.fallback, 'lexical')
  assert.equal(error.forbidLegacyRemote, true)
  assert.equal(vp.isVectorStateError(error), true)
  assert.equal(vp.isVectorStateError(new Error('plain')), false)
  assert.equal(vp.isVectorStateError({ code: 'VECTOR_ACTIVE_CORRUPT' }), true)
  assert.equal(code(() => vp.assertProfileVerified(null)), vp.VECTOR_ERROR_CODES.PROFILE_MISSING)
})

test('profileEnv and profileDatabaseMap describe the active generation without secrets', () => {
  resetHome()
  activate({ generation: 1, libraryIds: ['lib_a'] })
  const env = vp.profileEnv(profile, { baseUrl: 'http://127.0.0.1:8123/', token: 'local-token' })
  assert.equal(env.MEMU_EMBED_MODEL, BGE)
  assert.equal(env.MEMU_BASE_URL, 'http://127.0.0.1:8123')
  assert.equal(env.MEMU_API_KEY, 'local-token')
  assert.equal(env.MEMU_TELEMETRY, '0')
  const map = vp.profileDatabaseMap(['lib_a', 'lib_b'])
  assert.equal(map.lib_a, vp.dbPathFor('lib_a'))
  assert.match(map.lib_b, /lib_b\.[0-9a-f]{8}\.g\d+\.sqlite3$/)
  assert.deepEqual(vp.profileEnv(null), {})
})

test('persisted manifest and derived protocol tampering are rejected', () => {
  const changed = structuredClone(profile)
  changed.manifest.pooling = 'mean'
  assertCode(() => vp.assertProfileVerified(changed), 'VECTOR_PROFILE_MANIFEST_CHANGED')
  assertCode(() => vp.assertProfileVerified({ ...profile, dimension: 12 }), 'VECTOR_PROFILE_MANIFEST_CHANGED')
})

test('async write leases and freezes exclude each other without holding filesystem locks', async () => {
  resetHome()
  activate()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const write = vp.withVectorWrite(async captured => {
    assert.equal(captured.generation, 1)
    await gate
  })
  assert.equal(fs.existsSync(activeFile + '.lock'), false)
  await assert.rejects(vp.withVectorWriteFreeze(() => {}), { code: 'VECTOR_WRITE_BUSY' })
  release()
  await write
  await vp.withVectorWriteFreeze(async () => {
    assert.equal(fs.existsSync(activeFile + '.lock'), false)
    await assert.rejects(vp.withVectorWrite(() => {}), { code: 'VECTOR_WRITE_FROZEN' })
    assertCode(() => vp.assertVectorWriteAllowed(), 'VECTOR_WRITE_FROZEN')
    assert.equal(vp.captureVectorGeneration().generation, 1)
  })
  assert.equal(vp.activeVectorState().writeGuard.frozen, null)
  assert.deepEqual(vp.activeVectorState().writeGuard.leases, {})
})

test('exceptional write and freeze release all guards', async () => {
  resetHome()
  await assert.rejects(vp.withVectorWrite(async () => { throw new Error('write failed') }), /write failed/)
  await assert.rejects(vp.withVectorWriteFreeze(async () => { throw new Error('freeze failed') }), /freeze failed/)
  assert.equal(vp.activeVectorState().writeGuard.frozen, null)
  assert.deepEqual(vp.activeVectorState().writeGuard.leases, {})
})

test('empty new library enrollment stays in current generation and is idempotent', async () => {
  resetHome()
  activate()
  assertCode(() => vp.memuDbFor('new_library'), 'VECTOR_TORN_STATE')
  assertCode(() => vp.enrollActiveLibrary('new_library'), 'VECTOR_WRITE_LEASE_REQUIRED')
  const before = vp.captureVectorGeneration()
  await vp.withVectorWrite(async () => {
    const db = vp.enrollActiveLibrary('new_library')
    assert.equal(vp.enrollActiveLibrary('new_library'), db)
    assert.equal(fs.statSync(db).size, 0)
    assert.equal(vp.memuDbFor('new_library'), db)
    assert.equal(vp.activeGeneration(), before.generation)
    assert.equal(vp.memuGlobalDbFor(), before.global)
    assert.equal(vp.activeProfile().fingerprint, before.fingerprint)
  })
})

test('nonempty corrupt and quarantined library indexes cannot enroll empty databases', async () => {
  resetHome()
  activate()
  await vp.withVectorWrite(async () => {
    for (const entries of [{ held: { text: 'held', status: 'pending_review' } }, { live: { text: 'live' } }]) {
      assertCode(() => vp.enrollActiveLibrary('existing', { loadIndex: () => ({ entries }) }), 'VECTOR_LIBRARY_REBUILD_REQUIRED')
    }
    assertCode(() => vp.enrollActiveLibrary('async_index', { loadIndex: async () => ({ entries: {} }) }), 'VECTOR_BAD_UPDATE')
    fs.writeFileSync(path.join(home, 'index', 'corrupt.json'), '{bad')
    fs.writeFileSync(path.join(home, 'index', 'quarantined.json.corrupt-example'), '{bad')
    for (const id of ['corrupt', 'quarantined']) assertCode(() => vp.enrollActiveLibrary(id), 'VECTOR_LIBRARY_REBUILD_REQUIRED')
  })
  assert.deepEqual(Object.keys(vp.activeVectorState().active.databases.libraries), ['lib_a'])
})

test('library enrollment never reuses preexisting generation database bytes', async () => {
  resetHome()
  activate()
  const db = vp.vectorDbAbsPath({ libraryId: 'orphan', fingerprint: profile.fingerprint, generation: 1 })
  fs.writeFileSync(db, 'do not overwrite')
  await vp.withVectorWrite(async () => {
    assertCode(() => vp.enrollActiveLibrary('orphan'), 'VECTOR_SHADOW_PATH_TAKEN')
  })
  assert.equal(fs.readFileSync(db, 'utf8'), 'do not overwrite')
})
