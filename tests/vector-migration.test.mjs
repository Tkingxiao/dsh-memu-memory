import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-vector-migration-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const catalog = await import('../lib/embedding-catalog.js')
const vp = await import('../lib/vector-profile.js')
const vm = await import('../lib/vector-migration.js')

const BGE = 'bge-small-zh-v1.5-int8'
const ALT = 'bge-small-zh-v1.5-int8-alt'

// 第二个可用模型：目录里目前只有一个 verified 制品，切换/回滚必须有第二个空间才测得出来。
// 这里只替换"id → 哪份 manifest"的解析器，指纹与校验协议仍然是 embedding-catalog 的。
const baseEntry = catalog.getEmbeddingModel(BGE)
const altEntry = JSON.parse(JSON.stringify(baseEntry))
altEntry.id = ALT
altEntry.displayName = 'BGE alternative revision (test fixture)'
altEntry.sources.modelscope.revision = 'b'.repeat(40)
altEntry.profileFingerprint = catalog.profileFingerprint(altEntry)
const models = { [BGE]: baseEntry, [ALT]: altEntry }
vp.setCatalogEntryResolver(id => models[id] ?? null)

const librariesRoot = path.join(home, 'libraries')
const indexRoot = path.join(home, 'index')

test.after(() => {
  vp.resetCatalogEntryResolver()
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function resetAll() {
  fs.rmSync(indexRoot, { recursive: true, force: true })
  fs.rmSync(librariesRoot, { recursive: true, force: true })
}

// ---------------------------------------------------------------- fixture deps

function createFixture() {
  const dbs = new Map()
  const indexes = { global: { version: 1, entries: {} }, lib_a: { version: 1, entries: {} }, lib_b: { version: 1, entries: {} } }
  const calls = { commit: [], forget: [], smoke: [], profiles: [] }
  const behaviour = { failCommit: new Set(), failForget: new Set(), smokeOk: true, onCommit: null }
  const assertProfileArgs = (profile, generation) => {
    assert.ok(profile && typeof profile.fingerprint === 'string', 'migration backend must receive the verified profile')
    assert.ok(Number.isSafeInteger(generation), 'migration backend must receive the generation')
    calls.profiles.push({ fingerprint: profile.fingerprint, generation })
  }

  const dbOf = db => {
    if (!dbs.has(db)) dbs.set(db, new Map())
    return dbs.get(db)
  }

  const deps = {
    async listLibraries() {
      return [{ id: 'lib_a' }, { id: 'lib_b' }]
    },
    // 同步读：membership() 是同步接口（getSettingsState 心跳不能起 Promise 链），
    // 与 state.js 的真实 loadIndex 保持同一约定。
    loadIndex(libraryId) {
      return indexes[libraryId ?? 'global'] ?? { version: 1, entries: {} }
    },
    async commit({ db, libraryId, item }) {
      if (behaviour.failCommit.has(item.id)) {
        const error = new Error('embedding worker is down')
        error.code = 'EMBEDDING_WORKER_DOWN'
        throw error
      }
      dbOf(db).set(item.id, { hash: item.hash, text: item.text })
      calls.commit.push({ libraryId: libraryId ?? 'global', id: item.id, db })
      if (behaviour.onCommit) behaviour.onCommit({ libraryId, id: item.id, indexes })
    },
    async forget({ db, libraryId, itemId, profile, generation }) {
      assertProfileArgs(profile, generation)
      if (behaviour.failForget.has(itemId)) {
        const error = new Error('forget failed')
        error.code = 'MEMU_FORGET_FAILED'
        throw error
      }
      dbOf(db).delete(itemId)
      calls.forget.push({ libraryId: libraryId ?? 'global', id: itemId, db })
    },
    async listFiles({ db, profile, generation }) {
      assertProfileArgs(profile, generation)
      return [...dbOf(db).keys()]
    },
    async smoke({ generation, databases }) {
      calls.smoke.push({ generation, databases })
      return behaviour.smokeOk ? { ok: true, checks: ['dimension=512'] } : { ok: false, reason: 'dimension mismatch' }
    },
  }

  return {
    deps,
    indexes,
    calls,
    behaviour,
    dbs,
    setIndex(key, entries) {
      indexes[key] = { version: 1, entries }
    },
    entries(db) {
      return [...dbOf(db).entries()]
    },
    dbOf,
    migrator(overrides = {}) {
      return vm.createVectorMigrator({ ...deps, ...overrides })
    },
  }
}

function assertCode(fn, expected) {
  assert.throws(fn, error => {
    assert.equal(error.code, expected, 'expected ' + expected + ' but got ' + error.code + ' (' + error.message + ')')
    assert.equal(error.fallback, 'lexical')
    assert.equal(error.forbidLegacyRemote, true)
    return true
  })
}

async function assertCodeAsync(promise, expected) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, expected, 'expected ' + expected + ' but got ' + error.code + ' (' + error.message + ')')
    assert.equal(error.fallback, 'lexical')
    return true
  })
}

function liveEntries(db) {
  return [...(new Map(db)).entries()].map(([id, value]) => [id, value.hash])
}

// ---------------------------------------------------------------- prepareShadow

test('prepareShadow allocates a brand-new generation path and never switches by itself', async () => {
  resetAll()
  const fx = createFixture()
  const migrator = fx.migrator()
  const first = await migrator.prepareShadow({ profile: BGE })
  assert.equal(first.status, 'preparing')
  assert.ok(first.generation >= 1)
  assert.equal(path.dirname(first.databases.global), librariesRoot, 'global shadow lives under libraries/ so backups pick it up')
  assert.match(first.databases.global, /\.g1\.sqlite3$/)
  assert.equal(vp.activeProfile(), null, 'prepare must not activate anything')
  assert.equal(vp.activeProfile(), null)
  // requested 与 active 分离：prepare 只登记"用户要的模型"，生效仍需一次显式原子切换
  assert.equal(vp.requestedProfile().catalogId, BGE)
  assert.equal(vp.requestedProfile().fingerprint, vp.profileFromCatalog(BGE).fingerprint)
  assert.equal(vp.pendingJournal().generation, first.generation)
  assert.equal(vp.pendingJournal().fingerprint, vp.profileFromCatalog(BGE).fingerprint)

  // 同指纹默认续建（同一代际、同一路径），fresh 才换新代际/新路径
  const resumed = await migrator.prepareShadow({ profile: BGE })
  assert.equal(resumed.generation, first.generation)
  assert.equal(resumed.resumed, true)
  const fresh = await migrator.prepareShadow({ profile: BGE, fresh: true })
  assert.notEqual(fresh.generation, first.generation)
  assert.notEqual(fresh.databases.global, first.databases.global)
})

// ---------------------------------------------------------------- syncShadow

test('migration passes the verified profile and generation to list/read cleanup calls', async () => {
  resetAll()
  const fx = createFixture()
  fx.setIndex('lib_a', { m1: { text: 'profile contract', status: 'active' } })
  const migrator = fx.migrator()
  await migrator.prepareShadow({ profile: BGE })
  const report = await migrator.syncShadow()
  assert.equal(report.failed.length, 0)
  assert.ok(fx.calls.profiles.length >= 3)
  assert.ok(fx.calls.profiles.every(call => call.generation === vp.pendingJournal().generation))
  assert.ok(fx.calls.profiles.every(call => call.fingerprint === vp.pendingJournal().profile.fingerprint))
})

test('syncShadow writes only admitted memories and never re-embeds the same content twice', async () => {
  resetAll()
  const fx = createFixture()
  fx.setIndex('lib_a', {
    m1: { text: '用户喜欢深烘咖啡', status: 'active' },
    m2: { text: '等待复核的草稿', status: 'pending_review' },
    m3: { text: '过期了', status: 'active', expiresAt: '2000-01-01T00:00:00.000Z' },
    m4: { text: '已被取代', status: 'superseded' },
    m5: { text: '被归档', status: 'archived' },
  })
  fx.setIndex('global', { g1: { text: '全局：住在杭州', status: 'active' } })
  const migrator = fx.migrator()
  await migrator.prepareShadow({ profile: BGE })
  const first = await migrator.syncShadow()
  assert.equal(first.failed.length, 0)
  assert.equal(first.committed, 2, 'one private + one global entry')
  assert.equal(first.stable, true)
  assert.deepEqual(fx.calls.commit.map(call => call.id).sort(), ['g1', 'm1'])
  assert.equal(vp.pendingJournal().status, 'prepared')

  const second = await migrator.syncShadow()
  assert.equal(second.committed, 0)
  assert.equal(second.skipped, 2)
  assert.equal(fx.calls.commit.length, 2, 'a second sync is not a second embedding')
})

test('changed content is re-embedded, unchanged content is skipped (ledger hash key)', async () => {
  resetAll()
  const fx = createFixture()
  fx.setIndex('lib_a', { m1: { text: '第一版正文', status: 'active' }, m2: { text: '不要动我', status: 'active' } })
  const migrator = fx.migrator()
  await migrator.prepareShadow({ profile: BGE })
  await migrator.syncShadow()
  fx.setIndex('lib_a', { m1: { text: '第二版正文', status: 'active' }, m2: { text: '不要动我', status: 'active' } })
  const second = await migrator.syncShadow()
  assert.equal(second.committed, 1)
  assert.equal(second.skipped, 1)
  assert.deepEqual(fx.calls.commit.slice(2).map(call => call.id), ['m1'])
  const ledger = migrator.ledger()
  assert.equal(ledger.libraries.lib_a.items.m1.hash, vm.contentHash('m1', '第二版正文'))
  assert.equal(ledger.libraries.lib_a.items.m2.hash, vm.contentHash('m2', '不要动我'))
})

test('entries removed from the index are forgotten and tombstoned so a resume cannot resurrect them', async () => {
  resetAll()
  const fx = createFixture()
  fx.setIndex('lib_a', { m1: { text: '会被删掉', status: 'active' }, m2: { text: '保留', status: 'active' } })
  const migrator = fx.migrator()
  await migrator.prepareShadow({ profile: BGE })
  await migrator.syncShadow()
  fx.setIndex('lib_a', { m2: { text: '保留', status: 'active' } })
  const second = await migrator.syncShadow()
  assert.equal(second.tombstoned, 1)
  assert.deepEqual(fx.calls.forget.map(call => call.id), ['m1'])
  const ledger = migrator.ledger()
  assert.equal(ledger.libraries.lib_a.items.m1, undefined)
  assert.equal(ledger.libraries.lib_a.tombstones.m1.reason, 'absent-from-index')
  const db = vp.pendingJournal().databases
  const scopeDb = path.join(home, ...db.libraries.lib_a.path.split('/'))
  assert.deepEqual([...fx.dbOf(scopeDb).keys()], ['m2'])
})

test('a database that drifts (row without an index entry) is forgotten too', async () => {
  resetAll()
  const fx = createFixture()
  fx.setIndex('lib_a', { m1: { text: '正常', status: 'active' } })
  const migrator = fx.migrator()
  const prepared = await migrator.prepareShadow({ profile: BGE })
  const db = prepared.databases.libraries.lib_a
  fs.mkdirSync(path.dirname(db), { recursive: true })
  fx.dbOf(db).set('ghost', { hash: 'deadbeef', text: '不在索引里' })
  const report = await migrator.syncShadow()
  assert.equal(report.tombstoned, 1)
  assert.deepEqual(fx.calls.forget.map(call => call.id), ['ghost'])
  assert.equal(fx.dbOf(db).has('ghost'), false)
})

// ---------------------------------------------------------------- switchProfile

test('switchProfile atomically selects profile and database set, and is idempotent per space', async () => {
  resetAll()
  const fx = createFixture()
  fx.setIndex('lib_a', { m1: { text: '记得带伞', status: 'active' } })
  fx.setIndex('global', { g1: { text: '全局偏好：中文', status: 'active' } })
  const migrator = fx.migrator()
  const result = await migrator.switchProfile({ profile: BGE })
  assert.equal(result.ok, true)
  assert.equal(result.status, 'switched')
  assert.equal(result.previous, null)
  const active = vp.activeDatabases()
  assert.equal(active.generation, result.generation)
  assert.equal(active.fingerprint, result.fingerprint)
  assert.deepEqual(Object.keys(active.libraries).sort(), ['lib_a', 'lib_b'])
  assert.ok(active.libraries.lib_b.endsWith('.g' + result.generation + '.sqlite3'))
  assert.equal(path.dirname(active.libraries.lib_a), librariesRoot)
  assert.equal(vp.dbPathFor('lib_a'), active.libraries.lib_a)
  assert.equal(vp.dbPathFor(null), active.global)
  assert.equal(vp.pendingJournal(), null, 'the commit journal is settled after a successful switch')
  // 切换成功后 requested 必须清空：它表示"待切换的另一个模型"。留着会让界面同时显示
  // "当前生效 + 待切换"，也会让状态行读起来像还有一步没做完。
  assert.equal(vp.requestedProfile(), null, 'a completed switch leaves nothing pending to switch')
  assert.equal(vp.activeProfile().fingerprint, result.fingerprint)
  assert.equal(vp.assertVectorWriteAllowed().generation, active.generation)
  assert.equal(fx.calls.smoke.length, 1)

  // 同一空间再切一次：不重建、不重嵌入
  const commitsBefore = fx.calls.commit.length
  const again = await migrator.switchProfile({ profile: BGE })
  assert.equal(again.status, 'already-active')
  assert.equal(again.generation, result.generation)
  assert.equal(fx.calls.commit.length, commitsBefore)
})

test('membership reports which ids are actually inside the active generation', async () => {
  resetAll()
  const fx = createFixture()
  fx.setIndex('lib_a', { m1: { text: '记得带伞', status: 'active' }, m2: { text: '旧条目', status: 'archived' } })
  fx.setIndex('global', { g1: { text: '全局偏好', status: 'active' } })
  const migrator = fx.migrator()
  await migrator.switchProfile({ profile: BGE })
  const membership = migrator.membership()
  assert.deepEqual((membership.lib_a || []).sort(), ['m1'], 'archived entries are not admitted')
  assert.deepEqual((membership.global || []).sort(), ['g1'])
  assert.ok(Array.isArray(membership.lib_b), 'every scope in the generation gets a bucket')
})

test('membership grows with post-migration writes and shrinks with permanent deletes', async () => {
  resetAll()
  const fx = createFixture()
  fx.setIndex('lib_a', { m1: { text: '迁移时就有的', status: 'active' } })
  const migrator = fx.migrator()
  const { generation } = await migrator.switchProfile({ profile: BGE })
  assert.deepEqual(fx.migrator().membership().lib_a, ['m1'], 'the count starts at the migration ledger')

  // 切换之后聊天写入的记忆：索引条目带当前代际的戳（privateRemember 落盘），账本不知道。
  // 迁移账本永远停在 8/8 那一刻——这就是"当前已入向量库"只显示迁移数的根因。
  fx.indexes.lib_a.entries['mem-new'] = { text: '切换后写入', status: 'active', vector: { route: 'managed-local', generation } }
  let membership = fx.migrator().membership()
  assert.deepEqual((membership.lib_a || []).sort(), ['m1', 'mem-new'], 'a stamped post-migration write is counted')

  // 永久删除：引擎行和索引行都删了，但账本还挂着 m1 —— 必须从计数里扣掉。
  delete fx.indexes.lib_a.entries.m1
  membership = fx.migrator().membership()
  assert.deepEqual(membership.lib_a, ['mem-new'], 'a deleted migration item is not counted anymore')
})

test('membership ignores stamps that belong to another generation', async () => {
  resetAll()
  const fx = createFixture()
  fx.setIndex('lib_a', { m1: { text: '第一代写入', status: 'active' } })
  const migrator = fx.migrator()
  const first = await migrator.switchProfile({ profile: BGE })
  fx.indexes.lib_a.entries['mem-g1'] = { text: '第一代新写入', status: 'active', vector: { route: 'managed-local', generation: first.generation } }

  // 切到第二个模型：新代际把 m1 / mem-g1 全部重写进新空间（账本接管），新写入带新代际戳。
  const second = await migrator.switchProfile({ profile: ALT })
  assert.notEqual(second.generation, first.generation)
  fx.indexes.lib_a.entries['mem-g2'] = { text: '第二代写入', status: 'active', vector: { route: 'managed-local', generation: second.generation } }
  let membership = fx.migrator().membership()
  assert.deepEqual((membership.lib_a || []).sort(), ['m1', 'mem-g1', 'mem-g2'], 'the new space holds everything migrated into it plus new writes')

  // 第二代写入的条目随后被归档：回滚只重放可准入的条目，它留在旧空间里。
  // 回滚后的代际是全新编号，它身上的旧代际戳不得把它带进新计数。
  fx.indexes.lib_a.entries['mem-g2'].status = 'archived'
  await migrator.rollbackProfile()
  membership = fx.migrator().membership()
  assert.deepEqual((membership.lib_a || []).sort(), ['m1', 'mem-g1'], 'a held second-generation write stays out of the rolled-back count')
})

test('membership counts only managed-local stamps, not remote-api ones', async () => {
  resetAll()
  const fx = createFixture()
  fx.setIndex('global', { g1: { text: '全局偏好', status: 'active' } })
  const migrator = fx.migrator()
  const { generation } = await migrator.switchProfile({ profile: BGE })
  // remote-api 的戳描述的是远端空间；本地代际的计数不能把它算进来。
  fx.indexes.global.entries['mem-remote'] = { text: '远端写入', status: 'active', vector: { route: 'remote-api', generation } }
  const membership = fx.migrator().membership()
  assert.deepEqual(membership.global, ['g1'])
})

test('a legacy requested={"status":"active"} marker is not a pending switch', async () => {
  resetAll()
  const fx = createFixture()
  const migrator = fx.migrator()
  await migrator.switchProfile({ profile: BGE })
  // 旧代码切换成功后会把 requested 写成 status=active；读的时候必须当作没有待切换请求，
  // 否则界面永远同时显示"当前生效 + 待切换"。
  vp.updateVectorStateSync(current => ({ ...current, requested: { status: 'active', catalogId: BGE, fingerprint: current.active.fingerprint } }))
  assert.equal(vp.vectorStatus().requested, null)
})

test('a moving index aborts the switch instead of activating a half-caught-up generation', async () => {
  resetAll()
  const fx = createFixture()
  fx.setIndex('lib_a', { m1: { text: '初始', status: 'active' } })
  let churn = 0
  fx.behaviour.onCommit = ({ indexes }) => {
    churn += 1
    indexes.lib_a.entries['churn-' + churn] = { text: '并发写入 ' + churn, status: 'active' }
  }
  const migrator = fx.migrator({ maxCatchUpAttempts: 2 })
  await assertCodeAsync(migrator.switchProfile({ profile: BGE }), 'VECTOR_INDEX_MOVED')
  assert.equal(vp.activeProfile(), null, 'the active pointer must not move')
  const journal = vp.pendingJournal()
  assert.equal(journal.status, 'failed')
  assert.equal(journal.error.code, 'VECTOR_INDEX_MOVED')
})

test('a failed embedding leaves the active generation untouched and resumes from the ledger', async () => {
  resetAll()
  const fx = createFixture()
  fx.setIndex('lib_a', { m1: { text: '成功', status: 'active' }, m2: { text: '失败', status: 'active' } })
  const migrator = fx.migrator({ itemRetries: 0 })
  await migrator.switchProfile({ profile: BGE })
  const stillActive = vp.activeGeneration()
  fx.behaviour.failCommit.add('m3')
  fx.setIndex('lib_a', { m1: { text: '成功', status: 'active' }, m2: { text: '失败', status: 'active' }, m3: { text: '新的坏条目', status: 'active' } })
  await assertCodeAsync(migrator.switchProfile({ profile: ALT }), 'VECTOR_SYNC_INCOMPLETE')
  assert.equal(vp.activeGeneration(), stillActive, 'the old generation keeps serving')
  assert.equal(vp.activeProfile().fingerprint, vp.profileFromCatalog(BGE).fingerprint)
  const failedGeneration = vp.pendingJournal().generation
  const ledger = migrator.ledger({ generation: failedGeneration })
  assert.deepEqual(Object.keys(ledger.libraries.lib_a.items).sort(), ['m1', 'm2'])

  // 修好之后续建同一代际：只补失败的那条，成功的不重新嵌入
  fx.behaviour.failCommit.clear()
  const commitsBefore = fx.calls.commit.length
  const resumed = await migrator.switchProfile({ profile: ALT })
  assert.equal(resumed.status, 'switched')
  assert.equal(resumed.generation, failedGeneration, 'a failed build is resumed, not restarted')
  const newCommits = fx.calls.commit.slice(commitsBefore).map(call => call.id)
  assert.deepEqual(newCommits, ['m3'])
})

test('a failing smoke check never switches the active generation', async () => {
  resetAll()
  const fx = createFixture()
  fx.setIndex('lib_a', { m1: { text: '随便', status: 'active' } })
  fx.behaviour.smokeOk = false
  const migrator = fx.migrator()
  await assertCodeAsync(migrator.switchProfile({ profile: BGE }), 'VECTOR_SMOKE_FAILED')
  assert.equal(vp.activeProfile(), null)
  assert.equal(fx.calls.smoke.length, 1)
  assert.equal(vp.pendingJournal().error.code, 'VECTOR_SMOKE_FAILED')
})

// ---------------------------------------------------------------- 回滚

test('rollback replays the latest index into a new generation of the previous profile', async () => {
  resetAll()
  const fx = createFixture()
  fx.setIndex('lib_a', { m1: { text: '共同记忆', status: 'active' } })
  const migrator = fx.migrator()
  const first = await migrator.switchProfile({ profile: BGE })
  const second = await migrator.switchProfile({ profile: ALT })
  assert.notEqual(second.fingerprint, first.fingerprint)
  assert.equal(second.previous.fingerprint, first.fingerprint)
  const secondDb = vp.activeDatabases().libraries.lib_a
  assert.ok(secondDb.endsWith('.g' + second.generation + '.sqlite3'))

  // 切到新空间之后又写了记忆：回滚必须重放它，而不是把旧指针拨回去
  fx.setIndex('lib_a', { m1: { text: '共同记忆', status: 'active' }, m2: { text: '切换后新增', status: 'active' } })
  const back = await migrator.rollbackProfile()
  assert.equal(back.status, 'rolled-back')
  assert.equal(back.replayed, true)
  assert.equal(back.fingerprint, first.fingerprint)
  assert.ok(back.generation > second.generation, 'rollback uses a brand-new generation')
  assert.equal(vp.activeProfile().fingerprint, first.fingerprint)
  assert.equal(vp.activeGeneration(), back.generation)
  const replayedDb = vp.activeDatabases().libraries.lib_a
  assert.ok(replayedDb.endsWith('.g' + back.generation + '.sqlite3'))
  assert.notEqual(replayedDb, secondDb, 'never reuse the previous generation file in place')
  assert.deepEqual([...fx.dbOf(replayedDb).keys()].sort(), ['m1', 'm2'], 'writes made under the new profile are replayed back')

  // 还能再往回走一步（previous 在新代里重新指向刚离开的空间）
  const forward = await migrator.rollbackProfile()
  assert.equal(forward.fingerprint, second.fingerprint)
})

test('rollback without a previous generation is refused', async () => {
  resetAll()
  const fx = createFixture()
  const migrator = fx.migrator()
  await assertCodeAsync(migrator.rollbackProfile(), 'VECTOR_NO_ROLLBACK_TARGET')
  await migrator.switchProfile({ profile: BGE })
  await assertCodeAsync(migrator.rollbackProfile(), 'VECTOR_NO_ROLLBACK_TARGET')
})

// ---------------------------------------------------------------- 启动恢复

test('recoverProfile distinguishes absent / prepared / committed / torn without guessing', async () => {
  resetAll()
  const fx = createFixture()
  const migrator = fx.migrator()
  assert.equal((await migrator.recoverProfile()).status, 'absent')

  await migrator.switchProfile({ profile: BGE })
  const activeGeneration = vp.activeGeneration()
  assert.equal((await migrator.recoverProfile()).status, 'active')

  // prepared 但没切：继续旧代，新代只报告可续建
  fx.setIndex('lib_a', { m1: { text: '第二段', status: 'active' } })
  await migrator.prepareShadow({ profile: ALT })
  const synced = await migrator.syncShadow()
  assert.equal(synced.failed.length, 0)
  const prepared = await migrator.recoverProfile()
  assert.equal(prepared.status, 'prepared')
  assert.equal(prepared.recovered, false)
  assert.equal(prepared.generation, activeGeneration, 'the previous generation keeps serving until an explicit switch')
  assert.equal(prepared.pending.resume, true)
  assert.equal(vp.activeProfile().fingerprint, vp.profileFromCatalog(BGE).fingerprint)

  // committed 记录与指针一致 → 认新代并清 journal
  vp.updateVectorStateSync(state => ({
    ...state,
    pending: {
      status: 'committed',
      generation: state.active.generation,
      fingerprint: state.active.fingerprint,
      previousGeneration: state.active.previous?.generation ?? null,
      token: 'recovered-token',
      profile: state.active.profile,
      databases: state.active.databases,
    },
  }))
  const committed = await migrator.recoverProfile()
  assert.equal(committed.status, 'committed')
  assert.equal(committed.recovered, true)
  assert.equal(committed.generation, activeGeneration)
  assert.equal(vp.pendingJournal(), null)

  // committed 记录与指针矛盾 → 撕裂，退词法
  vp.updateVectorStateSync(state => ({
    ...state,
    pending: {
      status: 'committed',
      generation: state.active.generation + 3,
      fingerprint: state.active.fingerprint,
      previousGeneration: null,
      token: 'torn-token',
      profile: state.active.profile,
      databases: state.active.databases,
    },
  }))
  await assertCodeAsync(migrator.recoverProfile(), 'VECTOR_TORN_STATE')
  assertCode(() => vp.assertVectorWriteAllowed(), 'VECTOR_TORN_STATE')
})

test('recoverProfile refuses when a prepared build no longer matches the active generation', async () => {
  resetAll()
  const fx = createFixture()
  const migrator = fx.migrator()
  await migrator.switchProfile({ profile: BGE })
  // 切换成功后 requested 必须清空：它表示"待切换的另一个模型"，留着会让界面同时显示
  // "当前生效 + 待切换"。
  assert.equal(vp.vectorState().requested, null, 'a completed switch clears the pending request')
  await migrator.prepareShadow({ profile: ALT })
  await migrator.syncShadow()
  // 有人把 active 指针指到了别的代际（模拟撕裂/外部写入）
  vp.updateVectorStateSync(state => ({ ...state, active: { ...state.active, generation: state.active.generation + 1 } }))
  await assertCodeAsync(migrator.recoverProfile(), 'VECTOR_TORN_STATE')
})

test('abortPending discards an unswitched rebuild without touching the active generation', async () => {
  resetAll()
  const fx = createFixture()
  const migrator = fx.migrator()
  await migrator.switchProfile({ profile: BGE })
  const active = vp.activeDatabases()
  await migrator.prepareShadow({ profile: ALT })
  const prepared = vp.pendingJournal()
  const abort = migrator.abortPending('用户取消')
  assert.equal(abort.aborted, true)
  assert.equal(abort.generation, prepared.generation)
  assert.equal(vp.pendingJournal().status, 'aborted')
  assert.equal(vp.activeGeneration(), active.generation)
  assert.equal(vp.dbPathFor('lib_a'), active.libraries.lib_a)
  assert.deepEqual(migrator.abortPending(), { ok: true, aborted: false })
})

// ---------------------------------------------------------------- 护栏联动

test('the guard binds a turn to one generation across a profile switch', async () => {
  resetAll()
  const fx = createFixture()
  fx.setIndex('lib_a', { m1: { text: '这一代', status: 'active' } })
  const migrator = fx.migrator()
  await migrator.switchProfile({ profile: BGE })
  const captured = vp.captureGeneration()
  assert.equal(vp.assertGeneration(captured).generation, captured.generation)
  await migrator.switchProfile({ profile: ALT })
  assertCode(() => vp.assertGeneration(captured), 'VECTOR_STALE_GENERATION')
  // 新代自己的捕获是有效的
  const fresh = vp.captureGeneration()
  assert.equal(vp.assertGeneration(fresh).generation, fresh.generation)
  assert.notEqual(fresh.fingerprint, captured.fingerprint)
})

test('status() keeps requested, active and pending separately', async () => {
  resetAll()
  const fx = createFixture()
  const migrator = fx.migrator()
  vp.setRequestedProfile(ALT)
  assert.equal(vp.vectorStatus().status, 'absent')
  assert.equal(vp.vectorStatus().requested.catalogId, ALT)
  await migrator.switchProfile({ profile: BGE })
  await migrator.prepareShadow({ profile: ALT })
  const status = migrator.status()
  assert.equal(status.status, 'active')
  assert.equal(status.active.profile.catalogId, BGE)
  assert.equal(status.requested.catalogId, ALT, 'a requested model is not an active model')
  assert.equal(status.pending.generation, vp.pendingJournal().generation)
  assert.equal(status.pending.fingerprint, vp.profileFromCatalog(ALT).fingerprint)
})

test('the ledger file is generation-scoped and lives next to the active manifest', async () => {
  resetAll()
  const fx = createFixture()
  fx.setIndex('lib_a', { m1: { text: '记账', status: 'active' } })
  const migrator = fx.migrator()
  await migrator.prepareShadow({ profile: BGE })
  await migrator.syncShadow()
  const journal = vp.pendingJournal()
  const ledgerPath = path.join(indexRoot, 'vector-ledger.' + journal.fingerprint.slice(0, 8) + '.g' + journal.generation + '.json')
  assert.equal(fs.existsSync(ledgerPath), true)
  const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
  assert.equal(raw.fingerprint, journal.fingerprint)
  assert.equal(raw.generation, journal.generation)
  assert.equal(raw.libraries.lib_a.items.m1.hash, vm.contentHash('m1', '记账'))
  const summary = migrator.ledgerSummary()
  assert.equal(summary.committed, 1)
  assert.equal(summary.libraries.lib_a.committed, 1)
  // 另一个代际 = 另一份账本，绝不共用进度
  assert.notEqual(vm.ledgerFile(journal.fingerprint, journal.generation + 1), ledgerPath)
})

test('the migrator refuses to run without its index/memu dependencies', () => {
  assert.throws(() => vm.createVectorMigrator({}), /listLibraries/)
  assert.throws(() => vm.createVectorMigrator({ listLibraries: () => [] }), /loadIndex/)
})

test('admission mirrors the plugin index rules (held entries never become vectors)', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z')
  assert.equal(vm.admitEntry({ text: 'x', status: 'active' }, now), true)
  assert.equal(vm.admitEntry({ text: 'x' }, now), true)
  for (const status of ['archived', 'suppressed', 'expired', 'pending_review', 'superseded', 'deleted']) {
    assert.equal(vm.admitEntry({ text: 'x', status }, now), false, status + ' must stay out of the vector space')
  }
  assert.equal(vm.admitEntry({ text: 'x', status: 'active', expiresAt: '2020-01-01T00:00:00.000Z' }, now), false)
  assert.equal(vm.admitEntry(null, now), false)
  const items = vm.admittedItems({
    entries: {
      b: { text: '第二', status: 'active' },
      a: { text: '第一', status: 'active' },
      held: { text: '不要', status: 'pending_review' },
      empty: { status: 'active' },
    },
  }, now)
  assert.deepEqual(items.map(item => item.id), ['a', 'b'])
  assert.equal(items[0].hash, vm.contentHash('a', '第一'))
})

test('index metadata changed during smoke prevents stale activation', async () => {
  resetAll()
  const fx = createFixture()
  fx.setIndex('lib_a', { m1: { text: 'same text', status: 'active' } })
  fx.deps.smoke = async () => {
    fx.indexes.lib_a.entries.m1.disclosure = 'only_if_asked'
    return { ok: true }
  }
  await assertCodeAsync(fx.migrator().switchProfile({ profile: BGE }), 'VECTOR_INDEX_MOVED')
  assert.equal(vp.activeProfile(), null)
  assert.equal(vp.activeVectorState().writeGuard.frozen, null)
})

test('library-set movement after smoke prevents stale activation', async () => {
  resetAll()
  const fx = createFixture()
  let changed = false
  fx.deps.listLibraries = async () => changed ? ['lib_a', 'lib_b', 'new_library'] : ['lib_a', 'lib_b']
  fx.deps.smoke = async () => { changed = true; return { ok: true } }
  await assertCodeAsync(fx.migrator().switchProfile({ profile: BGE }), 'VECTOR_INDEX_MOVED')
  assert.equal(vp.activeProfile(), null)
})

test('in-flight write prevents switching and frozen final capture excludes new writes', async () => {
  resetAll()
  const fx = createFixture()
  const migrator = fx.migrator()
  await migrator.switchProfile({ profile: BGE })
  const before = vp.activeGeneration()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const write = vp.withVectorWrite(() => gate)
  await assertCodeAsync(migrator.switchProfile({ profile: ALT }), 'VECTOR_WRITE_BUSY')
  assert.equal(vp.activeGeneration(), before)
  release()
  await write
  let rejectedWrite = false
  const load = fx.deps.loadIndex
  fx.deps.loadIndex = async id => {
    if (vp.activeVectorState().writeGuard.frozen) {
      await assert.rejects(vp.withVectorWrite(() => {}), { code: 'VECTOR_WRITE_FROZEN' })
      rejectedWrite = true
    }
    return load(id)
  }
  await fx.migrator().switchProfile({ profile: ALT })
  assert.equal(rejectedWrite, true)
})

test('list failure and missing commit readback never activate shadows', async () => {
  resetAll()
  const fx = createFixture()
  fx.deps.listFiles = async () => { throw new Error('list unavailable') }
  await assert.rejects(fx.migrator().switchProfile({ profile: BGE }), /list unavailable/)
  assert.equal(vp.activeProfile(), null)
  assert.equal(vp.pendingJournal().status, 'failed')
  assert.equal(vp.pendingJournal().error.code, 'VECTOR_SYNC_FAILED')
  assert.equal(vp.pendingJournal().report.progress.stage, 'failed')
  resetAll()
  const missing = createFixture()
  missing.setIndex('lib_a', { m1: { text: 'readback required' } })
  missing.deps.commit = async () => {}
  await assertCodeAsync(missing.migrator({ itemRetries: 0 }).switchProfile({ profile: BGE }), 'VECTOR_SYNC_INCOMPLETE')
  assert.equal(vp.activeProfile(), null)
  // 失败明细必须落盘：只报"有几条失败"没法修（2026-10-30 现场）。
  const failure = vp.pendingJournal().error
  assert.equal(failure.code, 'VECTOR_SYNC_INCOMPLETE')
  assert.ok(Array.isArray(failure.failedItems) && failure.failedItems.length >= 1)
  assert.equal(failure.failedItems[0].itemId, 'm1')
  assert.match(failure.failedItems[0].code, /VECTOR_/)
  assert.ok(String(failure.failedItems[0].message).length > 0)
})

test('unchanged-description backend cannot fake reembedding after version changes', async () => {
  resetAll()
  const fx = createFixture()
  fx.setIndex('lib_a', { m1: { text: 'same description', version: 1 } })
  const migrator = fx.migrator({ itemRetries: 0 })
  await migrator.prepareShadow({ profile: BGE })
  await migrator.syncShadow()
  fx.indexes.lib_a.entries.m1.version = 2
  fx.deps.forget = async () => {} // simulate a backend that silently keeps rows
  // Dependencies were copied by migrator: use a new manager for the same shadow.
  const report = await fx.migrator({ itemRetries: 0 }).syncShadow()
  assert.equal(report.failed.some(item => item.code === 'VECTOR_FORGET_FAILED'), true)
  assert.equal(vp.activeProfile(), null)
})

test('injected retrieve failure is a failed migration, not an active profile', async () => {
  resetAll()
  const fx = createFixture()
  fx.setIndex('lib_a', { m1: { text: 'must retrieve' } })
  fx.deps.retrieve = async () => ({ ok: false })
  await assertCodeAsync(fx.migrator({ itemRetries: 0 }).switchProfile({ profile: BGE }), 'VECTOR_SYNC_INCOMPLETE')
  assert.equal(vp.activeProfile(), null)
})

test('progress is observable during rebuild and retained after atomic activation', async () => {
  resetAll()
  const fx = createFixture()
  fx.setIndex('lib_a', { m1: { text: 'one' }, m2: { text: 'two' } })
  const snapshots = []
  const migrator = fx.migrator({ onProgress(snapshot) {
    assert.deepEqual(vp.vectorStatus().pending.report.progress, snapshot)
    snapshots.push(structuredClone(snapshot))
    snapshot.completed = -100
  } })
  const result = await migrator.switchProfile({ profile: BGE })
  assert.equal(snapshots[0].stage, 'syncing')
  assert.equal(snapshots[0].total, 2)
  assert.ok(snapshots.some(item => item.completed === 1 && item.current.itemId === 'm1'))
  assert.equal(result.report.progress.completed, 2)
  assert.equal(result.report.progress.stage, 'prepared')
  assert.deepEqual(vp.vectorStatus().active.lastMigration, result.report.progress)
  assert.equal(vp.vectorStatus().pending, null)
})

test('failed progress and throwing observers never replace old active', async () => {
  resetAll()
  const fx = createFixture()
  await fx.migrator().switchProfile({ profile: BGE })
  const active = structuredClone(vp.activeVectorState().active)
  fx.setIndex('lib_a', { m1: { text: 'fails' } })
  fx.behaviour.failCommit.add('m1')
  const migrator = fx.migrator({ itemRetries: 0, onProgress() { throw new Error('observer failed') } })
  await assertCodeAsync(migrator.switchProfile({ profile: ALT }), 'VECTOR_SYNC_INCOMPLETE')
  assert.deepEqual(vp.activeVectorState().active, active)
  const progress = vp.vectorStatus().pending.report.progress
  assert.equal(progress.stage, 'failed')
  assert.ok(progress.failed >= 1)
  assert.equal(vp.pendingJournal().status, 'failed')
  assert.equal(vp.pendingJournal().error.code, 'VECTOR_SYNC_INCOMPLETE')
})

test('explicit migration profile guard binds profile database and pending token', async () => {
  resetAll()
  const fx = createFixture()
  const migrator = fx.migrator()
  const first = await migrator.prepareShadow({ profile: BGE })
  const captured = vp.assertMigrationProfile({ profile: first.profile, db: first.databases.global })
  assert.equal(captured.generation, first.generation)
  assert.equal(vp.assertMigrationProfile(captured).token, first.token)
  assertCode(() => vp.assertMigrationProfile({ profile: first.profile, db: path.join(home, 'unrelated.sqlite3') }), 'VECTOR_STALE_GENERATION')
  await migrator.prepareShadow({ profile: BGE, fresh: true })
  assertCode(() => vp.assertMigrationProfile(captured), 'VECTOR_STALE_GENERATION')
})
