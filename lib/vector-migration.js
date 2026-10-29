import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { indexDir, librariesDir, ensureDir, readJsonStrict, writeJson, stamp } from './paths.js'
import {
  VECTOR_ERROR_CODES, vectorError,
  stableStringify, sha256Hex, resolveProfile, assertProfileVerified, vectorDbRelPath,
  resolveVectorPath, readVectorState, vectorState, activeDatabases, updateVectorStateSync,
  reserveShadowGeneration, updatePendingJournal, clearPendingJournal, pendingJournal,
  assertVectorWriteAllowed, captureGeneration, assertGeneration, vectorStatus, withVectorWriteFreeze, profileEnv, setRequestedProfile,
} from './vector-profile.js'

// §14.8 影子重建 / 追平 / 原子代际切换 / 回滚 / 启动恢复。
//
// 原则：
//   * 绝不原地重嵌入：每次都写到一个全新的影子库路径（代际号进文件名），旧库保持只读可用。
//   * 账本键 = profile fingerprint + libraryId + itemId + content hash。命中即跳过，
//     所以"再来一次 commit"不是"再来一次 embed"；内容变了才算重新嵌入。
//   * tombstone：从索引里消失的条目要真的从影子库里删掉并记账，断点续建不得把它复活。
//   * 切换只在最后短窗口里做同步 compare + 原子写 active 指针；之前的锁外工作可以失败，
//     失败就不动 active（§14.8 第 4/7/8 条）。
//   * 索引快照在追平前后必须一致；不一致说明追平已经过期，中止切换而不是切到半步状态。
//
// 依赖全部注入，便于 fixture 测试：
//   listLibraries()                      → [{ id }] | string[]
//   loadIndex(libraryId | null)          → { entries: { [itemId]: entry } }   (null = 全局库)
//   commit({ db, libraryId, item, entry, profile, generation }) → Promise
//   forget({ db, libraryId, itemId, profile, generation }) → Promise
//   listFiles({ db, libraryId, profile, generation }) → Promise<string[]>   （影子里已有的条目名/ id）
//   smoke({ profile, generation, databases, report })            → Promise<{ ok, checks? }>
// 主代理接 state.js/memu.js 时按上面的形状包一层即可。

export const VECTOR_LEDGER_PREFIX = 'vector-ledger.'
export const VECTOR_LEDGER_SCHEMA = 1

/** 这些状态不进入向量空间：重建不得把 held 的条目重新激活（§14.8 第 3 条）。 */
export const HELD_STATUSES = Object.freeze(['archived', 'suppressed', 'expired', 'pending_review', 'superseded', 'deleted'])

export function admitEntry(entry, nowMs = Date.now()) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  if (HELD_STATUSES.includes(String(entry.status || ''))) return false
  if (entry.expiresAt && !(Date.parse(entry.expiresAt) > nowMs)) return false
  return true
}

export function itemText(entry) {
  if (!entry || typeof entry !== 'object') return ''
  for (const key of ['text', 'content', 'body']) {
    if (typeof entry[key] === 'string' && entry[key].trim()) return entry[key]
  }
  return ''
}

/** 内容/版本哈希：只有正文（与 id）改变才算需要重新嵌入。 */
export function contentHash(id, text, version = null) {
  return sha256Hex(stableStringify({ id: String(id), text: String(text), version }))
}

/** 从插件 index 里取出"可写进向量空间"的条目（已按准入过滤，按 id 稳定排序）。 */
export function admittedItems(index, nowMs = Date.now()) {
  const entries = index && typeof index.entries === 'object' && index.entries ? index.entries : {}
  const items = []
  for (const [id, entry] of Object.entries(entries)) {
    if (!admitEntry(entry, nowMs)) continue
    const text = itemText(entry)
    if (!text.trim()) continue
    items.push({ id, text, hash: contentHash(id, text, entry.contentVersion ?? entry.version ?? entry.updatedAt ?? null), entry: structuredClone(entry) })
  }
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return items
}

function scopeSnapshotDigest(items) {
  return sha256Hex(stableStringify(items.map(item => [item.id, item.hash])))
}

export function ledgerFile(fingerprint, generation) {
  return path.join(indexDir(), VECTOR_LEDGER_PREFIX + String(fingerprint).slice(0, 8) + '.g' + Number(generation) + '.json')
}

function emptyLedger(fingerprint, generation) {
  return {
    version: VECTOR_LEDGER_SCHEMA,
    fingerprint,
    generation,
    createdAt: stamp(),
    updatedAt: stamp(),
    snapshot: null,
    libraries: {},
  }
}

export function loadLedger(fingerprint, generation) {
  const file = ledgerFile(fingerprint, generation)
  const result = readJsonStrict(file)
  if (!result.ok) {
    if (result.missing) return { ok: true, ledger: emptyLedger(fingerprint, generation) }
    return { ok: false, ledger: emptyLedger(fingerprint, generation), error: { code: result.kind === 'corrupt' ? 'VECTOR_LEDGER_CORRUPT' : 'VECTOR_LEDGER_UNREADABLE', file } }
  }
  const value = result.value
  if (!value || typeof value !== 'object' || value.fingerprint !== fingerprint || Number(value.generation) !== Number(generation)) {
    // 账本对不上代际/指纹：当作空账本重建（宁可贵一点，也不复用别人的进度）
    return { ok: true, ledger: emptyLedger(fingerprint, generation), restarted: true }
  }
  return {
    ok: true,
    ledger: {
      version: VECTOR_LEDGER_SCHEMA,
      fingerprint,
      generation: Number(generation),
      createdAt: value.createdAt || stamp(),
      updatedAt: value.updatedAt || stamp(),
      snapshot: value.snapshot || null,
      libraries: value.libraries && typeof value.libraries === 'object' ? value.libraries : {},
    },
  }
}

export function saveLedger(ledger) {
  ensureDir(indexDir())
  writeJson(ledgerFile(ledger.fingerprint, ledger.generation), ledger)
  return ledger
}

function ledgerBucket(ledger, key) {
  const existing = ledger.libraries[key]
  if (existing && typeof existing === 'object') {
    return ledger.libraries[key] = {
      items: existing.items && typeof existing.items === 'object' ? existing.items : {},
      tombstones: existing.tombstones && typeof existing.tombstones === 'object' ? existing.tombstones : {},
      snapshot: existing.snapshot || null,
    }
  }
  const bucket = { items: {}, tombstones: {}, snapshot: null }
  ledger.libraries[key] = bucket
  return bucket
}

export function ledgerSummary(ledger) {
  const out = { fingerprint: ledger.fingerprint, generation: ledger.generation, libraries: {}, committed: 0, tombstones: 0 }
  for (const [key, bucket] of Object.entries(ledger.libraries || {})) {
    const committed = Object.keys(bucket?.items || {}).length
    const tombstones = Object.keys(bucket?.tombstones || {}).length
    out.libraries[key] = { committed, tombstones }
    out.committed += committed
    out.tombstones += tombstones
  }
  out.snapshot = ledger.snapshot
  return out
}

function fileStats(absPath) {
  const buffer = fs.readFileSync(absPath)
  return { bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') }
}

// ---------------------------------------------------------------- 迁移器

const REQUIRED_DEPS = Object.freeze(['listLibraries', 'loadIndex', 'commit', 'forget', 'listFiles'])

/**
 * createVectorMigrator({ listLibraries, loadIndex, commit, forget, listFiles, smoke?, now?, log?, maxCatchUpAttempts?, itemRetries? })
 * 也接受 { deps: {...}, ... } 形式。所有副作用都经注入依赖，便于纯 fixture 测试。
 */
export function createVectorMigrator(options = {}) {
  const configured = options && typeof options.deps === 'object' && options.deps ? { ...options.deps, ...options } : { ...options }
  const impl = {
    listLibraries: configured.listLibraries,
    loadIndex: configured.loadIndex,
    commit: configured.commit,
    forget: configured.forget,
    listFiles: configured.listFiles ?? configured.list,
    retrieve: typeof configured.retrieve === 'function' ? configured.retrieve : null,
    smoke: typeof configured.smoke === 'function' ? configured.smoke : null,
  }
  for (const name of REQUIRED_DEPS) {
    if (typeof impl[name] !== 'function') throw new TypeError('createVectorMigrator requires a ' + name + '(… ) dependency')
  }
  const now = typeof configured.now === 'function' ? configured.now : () => new Date().toISOString()
  const log = typeof configured.log === 'function' ? configured.log : () => {}
  const onProgress = typeof configured.onProgress === 'function' ? configured.onProgress : null
  const maxCatchUpAttempts = Number.isSafeInteger(configured.maxCatchUpAttempts) && configured.maxCatchUpAttempts > 0 ? configured.maxCatchUpAttempts : 3
  const itemRetries = Number.isSafeInteger(configured.itemRetries) && configured.itemRetries >= 0 ? configured.itemRetries : 1

  function publishProgress(progress, { persist = true } = {}) {
    const snapshot = { ...progress, updatedAt: now() }
    if (persist) {
      updatePendingJournal(current => {
        if (current.generation !== snapshot.generation || current.fingerprint !== snapshot.fingerprint) throw vectorError(VECTOR_ERROR_CODES.STALE_GENERATION, 'progress belongs to a replaced shadow generation')
        return { ...current, report: { ...(current.report || {}), progress: snapshot } }
      })
    }
    if (onProgress) {
      try {
        const result = onProgress(structuredClone(snapshot))
        if (result && typeof result.then === 'function') result.catch(error => log('progress callback failed: ' + (error?.message || error)))
      } catch (error) {
        log('progress callback failed: ' + (error?.message || error))
      }
    }
    return snapshot
  }

  function idOf(value) {
    const id = typeof value === 'string' ? value : value?.id
    if (typeof id !== 'string' || !id || id === 'global') return null
    return id
  }

  async function resolveLibraryIds(libraries) {
    const raw = Array.isArray(libraries) ? libraries : await impl.listLibraries()
    const ids = []
    for (const item of raw ?? []) {
      const id = idOf(item)
      if (id && !ids.includes(id)) ids.push(id)
    }
    return ids
  }

  function scopesFor(databases) {
    const scopes = [{ key: 'global', libraryId: null, rel: databases.global.path, db: resolveVectorPath(databases.global.path) }]
    for (const [libraryId, entry] of Object.entries(databases.libraries || {})) {
      scopes.push({ key: libraryId, libraryId, rel: entry.path, db: resolveVectorPath(entry.path) })
    }
    return scopes
  }

  async function captureSnapshot(scopes) {
    const parts = []
    for (const scope of scopes) {
      const index = structuredClone(await impl.loadIndex(scope.libraryId))
      const items = admittedItems(index)
      parts.push({ key: scope.key, items, digest: sha256Hex(stableStringify({ index, admitted: scopeSnapshotDigest(items) })) })
    }
    return {
      digest: sha256Hex(stableStringify(parts.map(part => [part.key, part.digest]))),
      scopes: parts,
      at: now(),
    }
  }

  async function presentIds(scope, profile, generation) {
    const ids = new Set()
    if (!fs.existsSync(scope.db)) return ids
    const listed = await impl.listFiles({ db: scope.db, libraryId: scope.libraryId, profile, generation })
    if (!Array.isArray(listed) && !Array.isArray(listed?.recall_files)) throw vectorError('VECTOR_LIST_INVALID', 'shadow list returned an invalid result for ' + scope.key)
    const names = Array.isArray(listed) ? listed : Array.isArray(listed?.recall_files) ? listed.recall_files : []
    for (const value of names) {
      if (typeof value === 'string') ids.add(value)
      else if (value && typeof value === 'object') {
        const name = value.name ?? value.id
        if (typeof name === 'string') ids.add(name)
      }
    }
    return ids
  }

  async function commitItem(scope, item, profile, generation) {
    let lastError = null
    for (let attempt = 0; attempt <= itemRetries; attempt++) {
      try {
        // Failure may still persist a row. Forget first: unchanged-description
        // recommit is not proof that the backend regenerated an embedding.
        if ((await presentIds(scope, profile, generation)).has(item.id)) {
          await impl.forget({ db: scope.db, libraryId: scope.libraryId, itemId: item.id, profile, generation })
          if ((await presentIds(scope, profile, generation)).has(item.id)) throw vectorError('VECTOR_FORGET_FAILED', 'shadow item still exists after forget: ' + item.id)
        }
        await impl.commit({ db: scope.db, libraryId: scope.libraryId, item, entry: item.entry ?? null, profile, generation })
        if (!(await presentIds(scope, profile, generation)).has(item.id)) throw vectorError('VECTOR_READBACK_FAILED', 'committed item is missing from shadow: ' + item.id)
        if (impl.retrieve) {
          const result = await impl.retrieve({ db: scope.db, libraryId: scope.libraryId, itemId: item.id, item, profile, generation })
          if (result == null || result === false || result.ok === false) throw vectorError('VECTOR_READBACK_FAILED', 'cannot retrieve committed shadow item: ' + item.id)
        }
        return { ok: true }
      } catch (error) {
        lastError = error
        if (attempt < itemRetries) log('commit retry ' + scope.key + '/' + item.id + ' after ' + (error?.code || error?.message || error))
      }
    }
    return { ok: false, error: lastError }
  }

  // -------------------------------------------------------------- prepareShadow

  /**
   * 为一次重建分配"全新代际 + 全新影子路径"，并把 prepared journal 先落盘。
   * 不写 active 指针、不碰旧库。同指纹的未完成重建默认续建（同一代际、同一路径、账本跳过
   * 已嵌入条目）；fresh:true 则强制换新代际（= 真正重来一遍）。
   */
  async function prepareShadow(stepOptions = {}) {
    const profile = resolveProfile(stepOptions.profile ?? stepOptions.catalogId)
    const libraryIds = await resolveLibraryIds(stepOptions.libraries)
    const fresh = stepOptions.fresh === true
    const reason = typeof stepOptions.reason === 'string' ? stepOptions.reason : 'switch'
    const current = vectorState()
    const pending = current?.pending
    const resumable = !fresh && pending && pending.fingerprint === profile.fingerprint
      && (pending.status === 'preparing' || pending.status === 'prepared' || pending.status === 'failed')
    if (resumable) {
      // 续建：同一代际，只把新出现的库补进同一个 DB 集合（同一次原子切换里生效）
      const extended = updatePendingJournal(journal => {
        const libraries = { ...(journal.databases?.libraries || {}) }
        for (const id of libraryIds) {
          if (!libraries[id]) libraries[id] = { path: vectorDbRelPath({ libraryId: id, fingerprint: journal.fingerprint, generation: journal.generation }), bytes: null, sha256: null }
        }
        return { ...journal, databases: { ...journal.databases, libraries } }
      })
      try {
        ensureShadowFiles(extended.databases)
      } catch (error) {
        failPending(error?.code || 'VECTOR_PREPARE_FAILED', String(error?.message || error), {}, extended)
        throw error
      }
      setRequestedProfile(profile, { reason })
      log('resuming shadow generation ' + extended.generation + ' for ' + profile.catalogId)
      return describeShadow(extended, true)
    }
    const reservation = reserveShadowGeneration({ profile, libraryIds, reason })
    // 全新代际 = 全新空影子库。路径上已经有文件说明编号冲突，绝不覆盖/复用。
    try {
      ensureShadowFiles(reservation.databases, { refuseExisting: true })
    } catch (error) {
      failPending(error?.code || 'VECTOR_PREPARE_FAILED', String(error?.message || error), {}, reservation)
      throw error
    }
    setRequestedProfile(profile, { reason })
    log('prepared shadow generation ' + reservation.generation + ' for ' + profile.catalogId)
    return describeShadow(pendingJournal(), false)
  }

  /**
   * 影子库集合必须是"存在且为空"的：空 sqlite 文件是合法起点，缺文件会被误当成撕裂。
   * refuseExisting=true 用于全新代际——路径上已有文件说明编号被复用，直接拒绝。
   */
  function ensureShadowFiles(databases, { refuseExisting = false } = {}) {
    ensureDir(librariesDir())
    for (const scope of scopesFor(databases)) {
      ensureDir(path.dirname(scope.db))
      if (fs.existsSync(scope.db)) {
        if (refuseExisting) {
          throw vectorError(VECTOR_ERROR_CODES.SHADOW_PATH_TAKEN, 'the reserved shadow path already exists; refusing to reuse a database from another attempt', {
            path: scope.rel,
          })
        }
        continue
      }
      fs.writeFileSync(scope.db, '', { flag: 'wx' })
    }
  }

  function describeShadow(journal, resumed) {
    const scopes = scopesFor(journal.databases)
    return {
      generation: journal.generation,
      token: journal.token,
      fingerprint: journal.fingerprint,
      profile: journal.profile,
      status: journal.status,
      reason: journal.reason ?? null,
      resumed: Boolean(resumed),
      previousGeneration: journal.previousGeneration ?? null,
      databases: {
        global: scopes[0].db,
        libraries: Object.fromEntries(scopes.slice(1).map(scope => [scope.key, scope.db])),
      },
      env: profileEnv(journal.profile),
      relative: {
        global: journal.databases.global.path,
        libraries: Object.fromEntries(Object.entries(journal.databases.libraries || {}).map(([id, entry]) => [id, entry.path])),
      },
    }
  }

  // -------------------------------------------------------------- syncShadow

  /**
   * 把索引里所有准入条目写进影子库；命中账本的跳过（那已经是这一代的向量），
   * 消失的条目 forget + tombstone。返回追平报告与前后快照（快照不一致 = 追平已过期）。
   */
  // 只报"有几条失败"没法修：把前几条的 id/错误码/消息留下来。syncShadow 与
  // switchProfile 两处都要带，后者会覆盖前者的 pending.error。
  function syncFailureDetail(report) {
    return report.failed.slice(0, 10).map(item => ({
      libraryId: item.libraryId ?? null,
      itemId: item.itemId ?? null,
      code: item.code ?? 'VECTOR_COMMIT_FAILED',
      message: String(item.message ?? '').slice(0, 300),
    }))
  }

  async function syncShadow(stepOptions = {}) {
    const expected = pendingJournal()
    try {
      const report = await syncShadowImpl(stepOptions)
      if (report.failed.length) {
        // 只报"有几条失败"没法排查：把前几条的 id/错误码/消息留下来，日志里也打一行。
        // 现场（2026-10-29）9 条失败只显示一句"未覆盖全部记忆"，必须重放才知道原因。
        const failedItems = syncFailureDetail(report)
        log('rebuild sync failures: ' + failedItems.slice(0, 3).map(item => `${item.itemId || item.libraryId}:${item.code}:${item.message}`).join(' | '))
        failPending('VECTOR_SYNC_INCOMPLETE', 'the rebuild did not cover every admitted memory; the active generation is untouched', { failed: report.failed.length, failedItems }, expected)
      }
      return report
    } catch (error) {
      const matches = expected && (stepOptions.generation == null || stepOptions.generation === expected.generation)
        && (stepOptions.fingerprint == null || stepOptions.fingerprint === expected.fingerprint)
      if (matches) failPending(error?.code || 'VECTOR_SYNC_FAILED', String(error?.message || error), { causeCode: error?.code ?? null }, expected)
      throw error
    }
  }

  async function syncShadowImpl(stepOptions = {}) {
    const journal = pendingJournal()
    if (!journal) throw vectorError('VECTOR_PENDING_MISSING', 'there is no prepared rebuild to sync')
    const generation = Number.isSafeInteger(stepOptions.generation) ? stepOptions.generation : journal.generation
    const fingerprint = typeof stepOptions.fingerprint === 'string' ? stepOptions.fingerprint : journal.fingerprint
    if (journal.generation !== generation || journal.fingerprint !== fingerprint) {
      throw vectorError('VECTOR_PENDING_MISSING', 'the prepared rebuild belongs to a different generation', { generation, fingerprint, preparedGeneration: journal.generation })
    }
    if (journal.status === 'committed') throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'this generation is already committed; nothing to sync')
    const profile = assertProfileVerified(journal.profile)
    const scopes = scopesFor(journal.databases)
    if (Array.isArray(stepOptions.libraries)) {
      // 只追平指定的私有库；全局库永远在同一代际里（不能漏，否则新代缺全局空间）
      const wanted = new Set(stepOptions.libraries.map(idOf).filter(Boolean))
      if (wanted.size) {
        const libraries = Object.fromEntries(Object.entries(journal.databases.libraries || {}).filter(([id]) => wanted.has(id)))
        scopes.length = 0
        scopes.push(...scopesFor({ global: journal.databases.global, libraries }))
      }
    }
    const loaded = loadLedger(fingerprint, generation)
    const ledger = loaded.ledger
    if (loaded.error) log('ledger unreadable (' + loaded.error.code + '); rebuilding it from the index')
    const before = await captureSnapshot(scopes)
    const total = before.scopes.reduce((sum, scope) => sum + scope.items.length, 0)
    const report = { generation, fingerprint, committed: 0, skipped: 0, tombstoned: 0, failed: [], libraries: {}, restarted: Boolean(loaded.restarted || loaded.error) }
    const progress = { stage: 'syncing', generation, fingerprint, total, completed: 0, skipped: 0, committed: 0, tombstoned: 0, failed: 0, current: null }
    publishProgress(progress)
    for (let index = 0; index < scopes.length; index++) {
      const scope = scopes[index]
      const items = before.scopes[index].items
      const bucket = ledgerBucket(ledger, scope.key)
      ensureDir(path.dirname(scope.db))
      const present = await presentIds(scope, profile, generation)
      const known = new Set(items.map(item => item.id))
      for (const item of items) {
        const recorded = bucket.items[item.id]
        const tombstoned = bucket.tombstones[item.id]
        if (recorded && recorded.hash === item.hash && present.has(item.id) && !tombstoned) {
          report.skipped += 1
          progress.skipped = report.skipped
          progress.completed = report.committed + report.skipped
          progress.current = { stage: 'skipped', libraryId: scope.key, itemId: item.id }
          publishProgress(progress)
          continue
        }
        const outcome = await commitItem(scope, item, profile, generation)
        if (!outcome.ok) {
          const error = outcome.error
          report.failed.push({
            libraryId: scope.key,
            itemId: item.id,
            code: error?.code || 'VECTOR_COMMIT_FAILED',
            message: String(error?.message || error || 'commit failed'),
          })
          progress.failed = report.failed.length
          progress.completed = report.committed + report.skipped + progress.failed
          progress.current = { stage: 'failed', libraryId: scope.key, itemId: item.id, code: error?.code || 'VECTOR_COMMIT_FAILED' }
          publishProgress(progress)
          continue
        }
        bucket.items[item.id] = { hash: item.hash, at: now() }
        delete bucket.tombstones[item.id]
        report.committed += 1
        progress.committed = report.committed
        progress.completed = report.committed + report.skipped + progress.failed
        progress.current = { stage: 'committed', libraryId: scope.key, itemId: item.id }
        publishProgress(progress)
        ledger.updatedAt = now()
        saveLedger(ledger)
      }
      for (const name of present) {
        if (known.has(name)) continue
        try {
          await impl.forget({ db: scope.db, libraryId: scope.libraryId, itemId: name, profile, generation })
        } catch (error) {
          report.failed.push({ libraryId: scope.key, itemId: name, code: error?.code || 'VECTOR_FORGET_FAILED', message: String(error?.message || error || 'forget failed') })
          progress.failed = report.failed.length
          progress.completed = report.committed + report.skipped + report.tombstoned + progress.failed
          progress.current = { stage: 'failed', libraryId: scope.key, itemId: name, code: error?.code || 'VECTOR_FORGET_FAILED' }
          publishProgress(progress)
          continue
        }
        bucket.tombstones[name] = { hash: bucket.items[name]?.hash ?? null, at: now(), reason: 'absent-from-index' }
        delete bucket.items[name]
        report.tombstoned += 1
        progress.tombstoned = report.tombstoned
        progress.completed = report.committed + report.skipped + report.tombstoned + progress.failed
        progress.current = { stage: 'tombstoned', libraryId: scope.key, itemId: name }
        publishProgress(progress)
        ledger.updatedAt = now()
        saveLedger(ledger)
      }
      for (const [itemId, record] of Object.entries(bucket.items)) {
        // 索引里已经没有它、影子库里也没有：留 tombstone，避免断点续建把它复活。
        if (known.has(itemId) || present.has(itemId)) continue
        bucket.tombstones[itemId] = { hash: record?.hash ?? null, at: now(), reason: 'not-present' }
        delete bucket.items[itemId]
        report.tombstoned += 1
        progress.tombstoned = report.tombstoned
        progress.completed = report.committed + report.skipped + report.tombstoned + progress.failed
        progress.current = { stage: 'tombstoned', libraryId: scope.key, itemId }
        publishProgress(progress)
      }
      const verifiedPresent = await presentIds(scope, profile, generation)
      if (verifiedPresent.size !== known.size || [...known].some(id => !verifiedPresent.has(id))) {
        report.failed.push({ libraryId: scope.key, code: 'VECTOR_COVERAGE_FAILED', message: 'shadow membership differs from eligible index snapshot' })
      }
      bucket.snapshot = { digest: before.scopes[index].digest, items: items.length, at: before.at }
      report.libraries[scope.key] = { items: items.length, present: present.size, digest: before.scopes[index].digest }
      ledger.updatedAt = now()
      saveLedger(ledger)
    }
    const after = await captureSnapshot(scopes)
    const stable = after.digest === before.digest
    ledger.snapshot = { digest: before.digest, at: before.at, stable, libraries: report.libraries }
    ledger.updatedAt = now()
    saveLedger(ledger)
    report.snapshot = { digest: before.digest, at: before.at, libraries: report.libraries }
    report.afterDigest = after.digest
    report.stable = stable
    report.ledger = ledgerSummary(ledger)
    progress.stage = report.failed.length ? 'failed' : 'prepared'
    progress.failed = report.failed.length
    progress.completed = report.committed + report.skipped + report.tombstoned + progress.failed
    progress.current = null
    report.progress = publishProgress(progress)
    if (report.failed.length === 0) {
      updatePendingJournal(current => ({ ...current, status: 'prepared', preparedAt: now(), snapshot: report.snapshot, report: { committed: report.committed, skipped: report.skipped, tombstoned: report.tombstoned, libraries: report.libraries, progress: report.progress } }))
    }
    return report
  }

  // -------------------------------------------------------------- 切换

  function measureDatabases(databases) {
    const stats = {}
    for (const scope of scopesFor(databases)) {
      let info
      try {
        info = fileStats(scope.db)
      } catch (error) {
        throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'cannot read back shadow database ' + scope.rel + ' (' + (error?.code || error?.message || error) + ')', { path: scope.rel })
      }
      stats[scope.rel] = info
    }
    return stats
  }

  function failPending(code, message, extra = {}, expected = null) {
    let failedProgress = null
    updatePendingJournal(current => {
      if (expected && (current.token !== expected.token || current.generation !== expected.generation || current.fingerprint !== expected.fingerprint)) return null
      if (current.status === 'committed' || current.status === 'aborted') return null
      const prior = current.report?.progress || { generation: current.generation, fingerprint: current.fingerprint, total: 0, completed: 0, skipped: 0, committed: 0, tombstoned: 0, failed: 0, current: null }
      failedProgress = { ...prior, stage: 'failed', failed: Math.max(1, prior.failed || 0), current: { stage: 'failed', code }, updatedAt: now() }
      return { ...current, status: 'failed', error: { code, message, at: now(), ...extra }, report: { ...(current.report || {}), progress: failedProgress } }
    })
    if (failedProgress && onProgress) {
      try { onProgress(structuredClone(failedProgress)) } catch (error) { log('progress callback failed: ' + (error?.message || error)) }
    }
  }

  /**
   * 最后短窗口：锁内只做同步 compare（token/代际/文件大小）与一次原子指针写。
   * 这里没有 await，也不允许有（§14.8 第 5/7 条）。
   */
  function commitActiveGeneration({ profile, journal, sync, stats }) {
    const committedAt = now()
    return updateVectorStateSync(current => {
      const pending = current.pending
      if (!pending) {
        throw vectorError('VECTOR_PENDING_MISSING', 'the prepared rebuild disappeared before the switch', { generation: journal.generation })
      }
      if (pending.token !== journal.token || pending.generation !== journal.generation || pending.fingerprint !== profile.fingerprint) {
        throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'another rebuild replaced this prepared generation; refusing to switch', {
          prepared: { generation: journal.generation, token: journal.token }, currentPending: { generation: pending.generation, token: pending.token },
        })
      }
      if (pending.status !== 'prepared') throw vectorError('VECTOR_SYNC_INCOMPLETE', 'only a prepared shadow generation can be activated')
      const preparedAgainst = pending.previousGeneration ?? null
      const activeGeneration = current.active?.generation ?? null
      if (preparedAgainst !== activeGeneration) {
        throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'the active generation changed while the rebuild was prepared; refusing to switch', { activeGeneration, preparedAgainst })
      }
      for (const scope of scopesFor(pending.databases)) {
        let info
        try {
          info = fs.statSync(scope.db)
        } catch {
          throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'a shadow database vanished before the switch: ' + scope.rel, { path: scope.rel })
        }
        const expected = stats[scope.rel]
        if (!info.isFile() || !expected || info.size !== expected.bytes || fileStats(scope.db).sha256 !== expected.sha256) {
          throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'a shadow database changed after the final sync: ' + scope.rel, { path: scope.rel, expected: expected?.bytes ?? null, actual: info.size })
        }
      }
      const databases = {
        global: { path: pending.databases.global.path, bytes: stats[pending.databases.global.path].bytes, sha256: stats[pending.databases.global.path].sha256 },
        libraries: Object.fromEntries(Object.entries(pending.databases.libraries || {}).map(([libraryId, entry]) => [
          libraryId, { path: entry.path, bytes: stats[entry.path]?.bytes ?? null, sha256: stats[entry.path]?.sha256 ?? null },
        ])),
      }
      const previous = current.active ? {
        generation: current.active.generation,
        fingerprint: current.active.fingerprint,
        catalogId: current.active.profile?.catalogId ?? null,
        profile: current.active.profile,
        at: current.active.updatedAt ?? null,
      } : null
      return {
        ...current,
        generation: Math.max(current.generation || 0, pending.generation),
        // 切换成功后 requested 必须清空：它表示"待切换的另一个模型"。留着它，界面会
        // 同时显示"当前生效 + 待切换"，让人以为还有一步没做完（2026-10-30 现场）。
        requested: null,
        active: {
          status: 'active',
          generation: pending.generation,
          fingerprint: profile.fingerprint,
          profile,
          databases,
          snapshot: sync.snapshot ?? null,
          lastMigration: sync.progress ?? pending.report?.progress ?? null,
          previous,
          reason: pending.reason ?? null,
          updatedAt: committedAt,
        },
        pending: { ...pending, status: 'committed', databases, committedAt },
      }
    })
  }

  /**
   * 完整切换：prepare（全新代际/全新影子）→ 追平（快照必须稳定）→ smoke → 原子切指针。
   * 任一步失败都不动 active；同一空间已生效时直接返回 already-active（不重建、不重嵌入）。
   */
  async function switchProfile(stepOptions = {}) {
    const profile = resolveProfile(stepOptions.profile ?? stepOptions.catalogId)
    const state = vectorState()
    const active = state?.active
    if (stepOptions.force !== true && active && active.fingerprint === profile.fingerprint) {
      const allowed = assertVectorWriteAllowed()
      return {
        ok: true, status: 'already-active', switched: false,
        generation: allowed.generation, fingerprint: allowed.fingerprint, profile: allowed.profile,
        databases: allowed.databases, env: profileEnv(allowed.profile), previous: active.previous ?? null, report: null,
      }
    }
    const prepared = await prepareShadow({ profile, libraries: stepOptions.libraries, fresh: stepOptions.fresh === true, reason: stepOptions.reason ?? 'switch' })
    let sync = await syncShadow({ generation: prepared.generation, fingerprint: prepared.fingerprint })
    let attempt = 1
    while (!sync.stable && attempt < maxCatchUpAttempts) {
      attempt += 1
      log('index moved during catch-up; re-syncing generation ' + prepared.generation + ' (attempt ' + attempt + ')')
      sync = await syncShadow({ generation: prepared.generation, fingerprint: prepared.fingerprint })
    }
    if (!sync.stable) {
      const message = 'the memory index changed while catching up; the active generation is untouched'
      failPending('VECTOR_INDEX_MOVED', message, { before: sync.snapshot?.digest ?? null, after: sync.afterDigest ?? null }, prepared)
      throw vectorError('VECTOR_INDEX_MOVED', message, { generation: prepared.generation, before: sync.snapshot?.digest ?? null, after: sync.afterDigest ?? null })
    }
    if (sync.failed.length) {
      const message = 'the rebuild did not cover every admitted memory; the active generation is untouched'
      failPending('VECTOR_SYNC_INCOMPLETE', message, { failed: sync.failed.length, failedItems: syncFailureDetail(sync) }, prepared)
      throw vectorError('VECTOR_SYNC_INCOMPLETE', message, { generation: prepared.generation, failed: sync.failed })
    }
    if (impl.smoke) {
      let outcome
      try {
        outcome = await impl.smoke({ profile, generation: prepared.generation, databases: prepared.databases, relative: prepared.relative, report: sync })
      } catch (error) {
        failPending('VECTOR_SMOKE_FAILED', String(error?.message || error), {}, prepared)
        throw vectorError('VECTOR_SMOKE_FAILED', 'smoke failed for generation ' + prepared.generation + ': ' + (error?.message || error), { causeCode: error?.code ?? null })
      }
      if (!outcome || outcome.ok === false) {
        failPending('VECTOR_SMOKE_FAILED', 'smoke rejected generation ' + prepared.generation, {}, prepared)
        throw vectorError('VECTOR_SMOKE_FAILED', 'smoke rejected generation ' + prepared.generation, { smoke: outcome ?? null })
      }
    }
    let next
    try {
      next = await withVectorWriteFreeze(async () => {
        const journal = pendingJournal()
        if (journal?.token !== prepared.token) throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'the prepared shadow was replaced before final verification')
        const actualIds = (await resolveLibraryIds()).sort()
        const expectedIds = Object.keys(journal.databases.libraries).sort()
        if (stableStringify(actualIds) !== stableStringify(expectedIds)) throw vectorError('VECTOR_INDEX_MOVED', 'the library set changed after rebuild; active is untouched')
        const final = await captureSnapshot(scopesFor(journal.databases))
        if (final.digest !== sync.snapshot.digest) {
          failPending('VECTOR_INDEX_MOVED', 'the memory index changed after smoke; active is untouched', {}, prepared)
          throw vectorError('VECTOR_INDEX_MOVED', 'the memory index changed after smoke; active is untouched')
        }
        assertProfileVerified(profile)
        const stats = measureDatabases(journal.databases)
        // No await between final verified snapshot and atomic pointer swap.
        return commitActiveGeneration({ profile, journal: prepared, sync, stats })
      })
    } catch (error) {
      failPending(error?.code || 'VECTOR_SWITCH_FAILED', String(error?.message || error), {}, prepared)
      throw error
    }
    // 第二次极短原子写：清掉 committed journal。若在此崩溃，recoverProfile 仍能从 committed 记录认出新代。
    clearPendingJournal()
    log('activated vector generation ' + next.active.generation + ' (' + profile.catalogId + ')')
    return {
      ok: true,
      status: stepOptions.reason === 'rollback' ? 'rolled-back' : 'switched',
      switched: true,
      generation: next.active.generation,
      fingerprint: next.active.fingerprint,
      profile: next.active.profile,
      env: profileEnv(next.active.profile),
      databases: activeDatabases(),
      previous: next.active.previous ?? null,
      requested: next.requested ?? null,
      report: {
        committed: sync.committed,
        skipped: sync.skipped,
        tombstoned: sync.tombstoned,
        libraries: sync.libraries,
        snapshot: sync.snapshot,
        progress: sync.progress ?? null,
      },
    }
  }

  // -------------------------------------------------------------- 回滚

  /**
   * 回滚不是"恢复旧指针"：切换后的新写入也要回到旧代，所以走同一套重建流程，
   * 把**最新 index** 重放进旧 profile 的一个全新代际里，再原子切回去（§14.8 第 9 条）。
   */
  async function rollbackProfile(stepOptions = {}) {
    const state = vectorState()
    const active = state?.active
    const target = stepOptions.profile ?? stepOptions.catalogId ?? active?.previous?.profile
    if (!target) throw vectorError('VECTOR_NO_ROLLBACK_TARGET', 'there is no previous generation to roll back to')
    const profile = resolveProfile(target)
    if (active && active.fingerprint === profile.fingerprint) {
      throw vectorError('VECTOR_NO_ROLLBACK_TARGET', 'the rollback target is already the active profile', { catalogId: profile.catalogId })
    }
    const result = await switchProfile({
      profile,
      libraries: stepOptions.libraries,
      fresh: stepOptions.fresh !== false,
      force: true,
      reason: 'rollback',
    })
    return { ...result, status: 'rolled-back', replayed: true, rolledBackFrom: active ? { generation: active.generation, catalogId: active.profile?.catalogId ?? null } : null }
  }

  // -------------------------------------------------------------- 启动恢复

  /**
   * 读 journal 恢复：prepared 未切 → 继续旧代（不切）；committed → 认新代并清 journal；
   * 任何说不清的状态（journal 与指针矛盾、库文件缺失/变小、profile 不再有效）→ 抛 typed error，
   * 调用方必须退词法，不能猜最近文件，也不能回落 legacy 远端。
   */
  async function recoverProfile() {
    const state = readVectorState({ tolerateMissing: true }).state
    if (!state) return { status: 'absent', generation: null, fingerprint: null, profile: null, pending: null }
    const active = state.active
    const pending = state.pending
    if (pending && pending.status === 'committed') {
      if (!active || active.generation !== pending.generation) {
        throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'the commit journal and the active pointer disagree; refusing vectors', {
          pendingGeneration: pending.generation, activeGeneration: active?.generation ?? null,
        })
      }
      clearPendingJournal()
      const allowed = assertVectorWriteAllowed({ deep: true })
      return { status: 'committed', recovered: true, generation: allowed.generation, fingerprint: allowed.fingerprint, profile: allowed.profile, databases: allowed.databases, pending: null }
    }
    if (pending && (pending.status === 'preparing' || pending.status === 'prepared')) {
      const preparedAgainst = pending.previousGeneration ?? null
      const activeGeneration = active?.generation ?? null
      if (preparedAgainst !== activeGeneration) {
        throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'a rebuild was prepared against a generation that is no longer active; refusing vectors', {
          preparedAgainst, activeGeneration, pendingGeneration: pending.generation,
        })
      }
      if (!active) return { status: 'interrupted', generation: null, fingerprint: null, profile: null, pending: { generation: pending.generation, resume: true } }
      const allowed = assertVectorWriteAllowed({ deep: true })
      return {
        status: pending.status === 'prepared' ? 'prepared' : 'interrupted',
        recovered: false,
        generation: allowed.generation,
        fingerprint: allowed.fingerprint,
        profile: allowed.profile,
        databases: allowed.databases,
        pending: { generation: pending.generation, fingerprint: pending.fingerprint, token: pending.token, resume: pending.status === 'prepared', restart: pending.status === 'preparing' },
      }
    }
    if (pending && (pending.status === 'aborted' || pending.status === 'failed')) {
      clearPendingJournal()
    }
    if (!active) return { status: 'absent', generation: null, fingerprint: null, profile: null, pending: null }
    const allowed = assertVectorWriteAllowed({ deep: true })
    return {
      status: 'active',
      recovered: false,
      generation: allowed.generation,
      fingerprint: allowed.fingerprint,
      profile: allowed.profile,
      databases: allowed.databases,
      snapshot: allowed.snapshot,
      pending: null,
    }
  }

  /** 放弃一次未切换的重建；active 指针与旧库完全不动。 */
  function abortPending(reason = 'aborted by user') {
    const journal = pendingJournal()
    if (!journal) return { ok: true, aborted: false }
    if (journal.status === 'aborted' || journal.status === 'committed') return { ok: true, aborted: false }
    updatePendingJournal(current => ({ ...current, status: 'aborted', error: { code: 'VECTOR_BUILD_ABORTED', message: String(reason), at: now() } }))
    return { ok: true, aborted: true, generation: journal.generation, fingerprint: journal.fingerprint }
  }

  function readLedger(stepOptions = {}) {
    const journal = pendingJournal()
    const state = vectorState()
    const fingerprint = stepOptions.fingerprint ?? journal?.fingerprint ?? state?.active?.fingerprint
    const generation = Number.isSafeInteger(stepOptions.generation) ? stepOptions.generation : (journal?.generation ?? state?.active?.generation)
    if (!fingerprint || !Number.isSafeInteger(generation)) return null
    return loadLedger(fingerprint, generation).ledger
  }

  return {
    prepareShadow,
    syncShadow,
    switchProfile,
    rollbackProfile,
    recoverProfile,
    abortPending,
    status: () => vectorStatus(),
    pending: () => pendingJournal(),
    ledger: readLedger,
    /**
     * 当前生效代际里"哪些 id 已经写进向量库"（按 scope key：libraryId 或 'global'）。
     * 迁移写库时刻意不碰索引，所以索引里的老条目没有 entry.vector 戳；界面要回答
     * "这条在不在向量库"只能查账本。
     */
    membership: () => {
      const state = vectorState()
      const active = state?.active
      if (!active) return null
      const ledger = readLedger({ fingerprint: active.fingerprint, generation: active.generation })
      if (!ledger) return null
      const out = {}
      for (const scope of scopesFor(active.databases)) {
        const bucket = ledger.libraries?.[scope.key]
        out[scope.key] = bucket?.items && typeof bucket.items === 'object' ? Object.keys(bucket.items) : []
      }
      return out
    },
    ledgerSummary: stepOptions => {
      const ledger = readLedger(stepOptions)
      return ledger ? ledgerSummary(ledger) : null
    },
    captureGeneration,
    assertGeneration,
    assertVectorWriteAllowed,
    admittedItems,
    contentHash,
  }
}
