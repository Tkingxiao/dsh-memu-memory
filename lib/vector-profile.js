import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  dataDir, librariesDir, indexDir, ensureDir,
  readJsonStrict, writeJson, withFileLock, stamp, isSafeId,
} from './paths.js'
import {
  PROVIDER_ORDER, getEmbeddingModel, profileFingerprint, validateEmbeddingManifest,
} from './embedding-catalog.js'

// §14.8 向量空间身份、代际选择与写入护栏。
//
// 本模块只回答四件事：
//   1. 一个 profile 的身份是什么（fingerprint 直接复用 embedding-catalog 的协议，不另立一套）；
//   2. 当前 active 代际是哪一个（单个 index/vector-active.json 原子选择 profile + DB 集合）；
//   3. 用户"想要"的 profile（requested）与真正生效的 profile 分离；
//   4. 此刻允不允许写向量（护栏：未验证/未就绪/pending/撕裂一律拒绝，且拒绝必须可退词法，
//      绝不能悄悄回落成 legacy 远端嵌入）。
//
// 硬约束（来自 §14.8）：
//   * profile 只依赖 paths/catalog，不依赖 state.json；本模块不读 state。
//   * 文件锁只在最后短窗口内做同步 compare + 原子写指针；整个模块没有 await 跨锁。
//   * 所有 DB 路径都从 active manifest 的 database-set 一次性取得，避免逐个库换导致混空间。
//   * 全局库影子也放 librariesDir()：backupDatabases 只扫 libraries/*.sqlite3 与 index/*.json，
//     放 data 根目录会被备份漏掉（§14.9 第 6 条要求备份包含 vector active profile manifest）。

export const VECTOR_ACTIVE_FILE = 'vector-active.json'
export const VECTOR_ACTIVE_SCHEMA = 1

export const VECTOR_ERROR_CODES = Object.freeze({
  PROFILE_MISSING: 'VECTOR_PROFILE_MISSING',
  PROFILE_UNKNOWN: 'VECTOR_PROFILE_UNKNOWN',
  PROFILE_PENDING: 'VECTOR_PROFILE_PENDING',
  PROFILE_UNVERIFIED: 'VECTOR_PROFILE_UNVERIFIED',
  PROFILE_FINGERPRINT_MISMATCH: 'VECTOR_PROFILE_FINGERPRINT_MISMATCH',
  PROFILE_MANIFEST_CHANGED: 'VECTOR_PROFILE_MANIFEST_CHANGED',
  ACTIVE_CORRUPT: 'VECTOR_ACTIVE_CORRUPT',
  ACTIVE_UNREADABLE: 'VECTOR_ACTIVE_UNREADABLE',
  NOT_ACTIVE: 'VECTOR_NOT_ACTIVE',
  TORN_STATE: 'VECTOR_TORN_STATE',
  STALE_GENERATION: 'VECTOR_STALE_GENERATION',
  NO_GENERATION: 'VECTOR_NO_GENERATION',
  SHADOW_PATH_TAKEN: 'VECTOR_SHADOW_PATH_TAKEN',
  PATH_ESCAPE: 'VECTOR_PATH_ESCAPE',
  BAD_UPDATE: 'VECTOR_BAD_UPDATE',
})

/**
 * 向量状态错误：带 code + fallback='lexical' + forbidLegacyRemote。
 * 调用方一旦看到 isVectorStateError(e) 为真，就只能退化成词法召回，
 * 不允许把同一批查询发去 legacy/远端嵌入（那会把两种向量空间混在一个库里）。
 */
export class VectorStateError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'VectorStateError'
    this.code = code
    this.fallback = 'lexical'
    this.forbidLegacyRemote = true
    for (const [key, value] of Object.entries(extra)) if (value !== undefined) this[key] = value
  }
}

export function vectorError(code, message, extra) {
  return new VectorStateError(code, message, extra)
}

export function isVectorStateError(value) {
  if (value instanceof VectorStateError) return true
  return typeof value?.code === 'string' && value.code.startsWith('VECTOR_')
}

// ---------------------------------------------------------------- 规范化哈希

/**
 * 规范化 JSON 序列化：键排序、undefined 省略。与 embedding-catalog 内部 canonical()
 * 同一协议（那里没有导出），保证"同一个 manifest 在任何模块里哈希都相同"。
 */
export function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .filter(key => value[key] !== undefined)
      .map(key => JSON.stringify(key) + ':' + stableStringify(value[key]))
      .join(',') + '}'
  }
  return JSON.stringify(value === undefined ? null : value)
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/**
 * 完整 manifest 哈希：整个 manifest 的规范化摘要（只排除自引用的 profileFingerprint）。
 * profileFingerprint 描述"向量空间"，manifestDigest 描述"制品清单本身"；
 * 两者一起才能证明"这代向量是由这份制品算出来的"。
 */
// 摘要只覆盖"会改变向量空间或制品"的字段。之前它把 displayName/summary/参数说明这些
// 文案也算进去：改一句文档路径就能让用户已激活的 profile 判为"manifest 已变"，整个重建
// 白做（2026-10-30 现场）。文案不是制品身份。
const DIGEST_FIELDS = ['id', 'dimension', 'maxTokens', 'pooling', 'normalization', 'prefixes', 'quantization',
  'runtime', 'sources', 'files', 'graph', 'protocol', 'preprocessing', 'windowing', 'aggregation', 'tokenizer']

export function manifestDigest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null
  const subset = {}
  for (const key of DIGEST_FIELDS) if (manifest[key] !== undefined) subset[key] = manifest[key]
  return sha256Hex(stableStringify(subset))
}

/** 旧算法（全字段，除了它自己）。只用于兼容已经落盘的 profile。 */
export function legacyManifestDigest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null
  const copy = {}
  for (const key of Object.keys(manifest)) {
    if (key === 'profileFingerprint') continue
    copy[key] = manifest[key]
  }
  return sha256Hex(stableStringify(copy))
}

/** 已落盘摘要两种都认：新算法 + 旧算法，别因一句文案把用户的向量空间判废。 */
export function manifestDigestAccepted(stored, manifest) {
  if (typeof stored !== 'string' || !stored) return true
  return stored === manifestDigest(manifest) || stored === legacyManifestDigest(manifest)
}

/** 直接复用 embedding-catalog 的指纹协议（任何改变向量空间的字段都进指纹，§14.8）。 */
export { profileFingerprint }

export function profileShortFingerprint(profileOrEntry) {
  const fingerprint = typeof profileOrEntry === 'string'
    ? profileOrEntry
    : (profileOrEntry?.fingerprint || profileFingerprint(profileOrEntry))
  return String(fingerprint).slice(0, 8)
}

// ---------------------------------------------------------------- catalog 注入点

// 默认只认 embedding-catalog.js 的目录。测试（以及将来多目录场景）可以换一个解析器：
// 指纹/校验协议不变，只是"哪个 id 对应哪份 manifest"可以注入。
let catalogEntryResolver = id => getEmbeddingModel(id)

export function setCatalogEntryResolver(resolver) {
  catalogEntryResolver = typeof resolver === 'function' ? resolver : (id => getEmbeddingModel(id))
  return catalogEntryResolver
}

export function resetCatalogEntryResolver() {
  catalogEntryResolver = id => getEmbeddingModel(id)
}

/** 解析目录条目：只按稳定 id 取，未知 id 返回 null（不猜、不回退默认模型）。 */
export function resolveCatalogEntry(catalogId) {
  if (typeof catalogId !== 'string' || !catalogId) return null
  try {
    return catalogEntryResolver(catalogId) ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- profile 构造

function primarySourceOf(entry) {
  const sources = entry?.sources && typeof entry.sources === 'object' ? entry.sources : {}
  for (const id of PROVIDER_ORDER) {
    const source = sources[id]
    if (source && typeof source.revision === 'string') return { provider: id, repo: source.repo, revision: source.revision }
  }
  return { provider: null, repo: null, revision: null }
}

/**
 * 由 catalog/manifest 条目构造 profile。纯函数：不读 state、不写盘、不看当前 active。
 * 返回的对象冻结，避免调用方改到指纹依赖的字段。
 */
export function buildProfile(entry, installation = {}) {
  if (!entry || typeof entry !== 'object') throw vectorError(VECTOR_ERROR_CODES.PROFILE_MISSING, 'a catalog entry is required to build a vector profile')
  // 永远按 catalog 协议现场重算：条目里存的 profileFingerprint 只是个缓存，
  // 被改过的条目不能靠它冒充另一个向量空间。
  const fingerprint = profileFingerprint(entry)
  const source = primarySourceOf(entry)
  const files = (Array.isArray(entry.files) ? entry.files : []).map(file => Object.freeze({
    path: String(file.path), role: file.role ?? null, bytes: Number(file.bytes), sha256: String(file.sha256),
  }))
  const runtime = entry.runtime && typeof entry.runtime === 'object'
    ? Object.freeze({ engine: entry.runtime.engine ?? null, abi: entry.runtime.abi ?? null, version: entry.runtime.version ?? null, os: entry.runtime.os ?? null, arch: entry.runtime.arch ?? null })
    : null
  const quantization = entry.quantization && typeof entry.quantization === 'object'
    ? Object.freeze({ weights: entry.quantization.weights ?? null, scheme: entry.quantization.scheme ?? null })
    : null
  return Object.freeze({
    schema: VECTOR_ACTIVE_SCHEMA,
    catalogId: String(entry.id),
    manifest: structuredClone(entry),
    modelDir: installation.modelDir ?? entry.modelDir ?? null,
    runtimeDir: installation.runtimeDir ?? entry.runtimeDir ?? null,
    fingerprint,
    short: fingerprint.slice(0, 8),
    displayName: entry.displayName ?? String(entry.id),
    manifestDigest: manifestDigest(entry),
    provider: source.provider,
    repo: source.repo,
    revision: source.revision,
    dimension: entry.dimension ?? null,
    maxTokens: entry.maxTokens ?? null,
    pooling: entry.pooling ?? null,
    normalization: entry.normalization ?? null,
    prefixes: entry.prefixes ? Object.freeze({ query: entry.prefixes.query ?? '', document: entry.prefixes.document ?? '' }) : null,
    quantization,
    runtime,
    files: Object.freeze(files),
    graphSha256: files.find(file => file.role === 'graph')?.sha256 ?? null,
    tokenizerSha256: files.find(file => file.role === 'tokenizer')?.sha256 ?? null,
    verification: Object.freeze({
      status: entry.verification?.status ?? 'unverified',
      method: entry.verification?.method ?? null,
      checkedAt: entry.verification?.checkedAt ?? null,
    }),
  })
}

/**
 * 只校验 manifest 本身能不能用：pending（未核实制品）与未验证 manifest 都拒绝（§14.4 V0）。
 * 单独导出，便于"候选模型是否可启用"这类只读判断，也便于测试直接喂一份坏 manifest。
 */
export function assertManifestUsable(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw vectorError(VECTOR_ERROR_CODES.PROFILE_MISSING, 'a manifest entry is required')
  }
  if (entry.availability !== 'available') {
    throw vectorError(VECTOR_ERROR_CODES.PROFILE_PENDING, String(entry.id ?? 'unknown model') + ' has no verified artifact; pending models cannot be activated', {
      catalogId: entry.id ?? null,
      pendingReasons: [...(entry.pendingReasons || [])],
    })
  }
  if (entry.verification?.status !== 'verified') {
    throw vectorError(VECTOR_ERROR_CODES.PROFILE_UNVERIFIED, String(entry.id ?? 'unknown model') + ' is not verified; refusing to build a vector space on it', { catalogId: entry.id ?? null })
  }
  const report = validateEmbeddingManifest(entry)
  if (!report.ok) {
    throw vectorError(VECTOR_ERROR_CODES.PROFILE_UNVERIFIED, String(entry.id ?? 'unknown model') + ' manifest is not usable: ' + report.errors.map(item => item.code).join(', '), {
      catalogId: entry.id ?? null,
      errors: report.errors,
    })
  }
  return true
}

/**
 * 校验一个 profile 仍然被当前 catalog 认可：条目存在、指纹与完整 manifest 哈希都对得上、
 * 制品可用（availability === 'available'）、manifest 通过 validateEmbeddingManifest。
 * 未验证 manifest 与 pending 制品在这里就被拒绝（§14.4/§14.8）。
 */
export function assertProfileVerified(profile) {
  if (!profile || typeof profile !== 'object' || !profile.catalogId) {
    throw vectorError(VECTOR_ERROR_CODES.PROFILE_MISSING, 'no vector profile to verify')
  }
  const entry = resolveCatalogEntry(profile.catalogId)
  if (!entry) {
    throw vectorError(VECTOR_ERROR_CODES.PROFILE_UNKNOWN, 'the catalog no longer defines ' + profile.catalogId + '; refusing to use a vector space that cannot be reproduced', { catalogId: profile.catalogId })
  }
  const expected = profileFingerprint(entry)
  if (profile.fingerprint !== expected) {
    throw vectorError(VECTOR_ERROR_CODES.PROFILE_FINGERPRINT_MISMATCH, 'profile fingerprint does not match the catalog for ' + entry.id, { expected, actual: profile.fingerprint })
  }
  const digest = manifestDigest(entry)
  if (!manifestDigestAccepted(profile.manifestDigest, entry)) {
    throw vectorError(VECTOR_ERROR_CODES.PROFILE_MANIFEST_CHANGED, 'the manifest for ' + entry.id + ' changed after this profile was recorded', { expected: digest, actual: profile.manifestDigest })
  }
  // The persisted manifest and derived processing fields are execution inputs,
  // not harmless annotations. Reject tampering even if cached hashes survived.
  // 存储的 manifest 只需在"向量空间"上仍然一致；指纹已覆盖这些字段。
  if (!profile.manifest || profileFingerprint(profile.manifest) !== expected) {
    throw vectorError(VECTOR_ERROR_CODES.PROFILE_MANIFEST_CHANGED, 'the stored profile manifest no longer matches the catalog for ' + entry.id)
  }
  const rebuilt = buildProfile(entry)
  for (const field of ['schema', 'short', 'provider', 'repo', 'revision', 'dimension', 'maxTokens', 'pooling', 'normalization', 'prefixes', 'quantization', 'runtime', 'files', 'graphSha256', 'tokenizerSha256']) {
    if (stableStringify(profile[field]) !== stableStringify(rebuilt[field])) throw vectorError(VECTOR_ERROR_CODES.PROFILE_MANIFEST_CHANGED, 'the stored profile processing field changed: ' + field)
  }
  assertManifestUsable(entry)
  return profile
}

/** 按 catalog id 构造并验证 profile；pending/未知/未验证一律抛 typed error。 */
export function profileFromCatalog(catalogId, installation = {}) {
  const id = typeof catalogId === 'string' ? catalogId : String(catalogId ?? '')
  const entry = resolveCatalogEntry(id)
  if (!entry) throw vectorError(VECTOR_ERROR_CODES.PROFILE_UNKNOWN, 'unknown embedding model: ' + JSON.stringify(id), { catalogId: id })
  assertManifestUsable(entry)
  const profile = buildProfile(entry, installation)
  return assertProfileVerified(profile)
}

/** 接受 profile 对象 / catalog id / manifest 条目，统一成已验证 profile。 */
export function resolveProfile(value) {
  if (value && typeof value === 'object' && value.catalogId) return assertProfileVerified(value)
  if (value && typeof value === 'object' && value.id) return profileFromCatalog(value.id)
  return profileFromCatalog(value)
}

// ---------------------------------------------------------------- 路径与 DB 集合

/** 受管 DB 一律用 "libraries/<name>.<fp8>.g<gen>.sqlite3"：文件名自带代际，切换=换指针。 */
export function vectorDbRelPath({ libraryId = null, fingerprint, generation } = {}) {
  if (typeof fingerprint !== 'string' || !fingerprint) {
    throw vectorError(VECTOR_ERROR_CODES.BAD_UPDATE, 'vectorDbRelPath requires a fingerprint')
  }
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw vectorError(VECTOR_ERROR_CODES.BAD_UPDATE, 'vectorDbRelPath requires a positive generation')
  }
  const short = fingerprint.slice(0, 8)
  const gen = 'g' + generation
  if (libraryId === null || libraryId === undefined || libraryId === 'global') {
    return ['libraries', 'global.' + short + '.' + gen + '.sqlite3'].join('/')
  }
  if (!isSafeId(libraryId)) throw vectorError(VECTOR_ERROR_CODES.PATH_ESCAPE, 'unsafe library id: ' + JSON.stringify(libraryId), { libraryId })
  return ['libraries', libraryId + '.' + short + '.' + gen + '.sqlite3'].join('/')
}

/** 相对 dataDir 的受管路径 → 绝对路径；绝对路径与越界路径一律拒绝。 */
export function resolveVectorPath(relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw vectorError(VECTOR_ERROR_CODES.PATH_ESCAPE, 'vector storage path is missing', { path: relPath })
  }
  if (path.isAbsolute(relPath)) {
    throw vectorError(VECTOR_ERROR_CODES.PATH_ESCAPE, 'vector storage paths must be relative to the data root', { path: relPath })
  }
  const root = path.resolve(dataDir())
  const abs = path.resolve(root, ...relPath.split(/[\\/]+/).filter(Boolean))
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw vectorError(VECTOR_ERROR_CODES.PATH_ESCAPE, 'vector storage path escapes the data root', { path: relPath })
  }
  return abs
}

export function vectorDbAbsPath(options) {
  return resolveVectorPath(vectorDbRelPath(options))
}

/** 非受管模式（尚未启用本地向量）仍走原来的库路径。 */
export function legacyDbPath(libraryId = null) {
  if (libraryId === null || libraryId === undefined || libraryId === 'global') return path.join(dataDir(), 'global.sqlite3')
  if (!isSafeId(libraryId)) throw vectorError(VECTOR_ERROR_CODES.PATH_ESCAPE, 'unsafe library id: ' + JSON.stringify(libraryId), { libraryId })
  return path.join(librariesDir(), libraryId + '.sqlite3')
}

// ---------------------------------------------------------------- active manifest

export function vectorActiveFile() {
  return path.join(indexDir(), VECTOR_ACTIVE_FILE)
}

function emptyState() {
  return { version: VECTOR_ACTIVE_SCHEMA, generation: 0, requested: null, active: null, pending: null }
}

function validDatabases(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && value.global && typeof value.global === 'object'
    && value.libraries && typeof value.libraries === 'object' && !Array.isArray(value.libraries)
}

function validActive(active) {
  return Boolean(active) && typeof active === 'object'
    && active.status === 'active'
    && Number.isSafeInteger(active.generation) && active.generation >= 1
    && typeof active.fingerprint === 'string' && active.fingerprint.length > 0
    && active.profile && typeof active.profile === 'object'
    && validDatabases(active.databases)
}

const PENDING_STATUSES = Object.freeze(['preparing', 'prepared', 'committed', 'aborted', 'failed'])

function validPending(pending) {
  return Boolean(pending) && typeof pending === 'object'
    && PENDING_STATUSES.includes(pending.status)
    && Number.isSafeInteger(pending.generation)
    && typeof pending.fingerprint === 'string'
}

/**
 * 受管路由被选中了，是否真的有一代可用的向量空间。
 *
 * 只选了模型（state.requested）或 state 文件根本没写成时，写入没有可对齐的向量代际。
 * 调用方必须据此降级，而不是让整条写入链失败：索引 + 引擎才是权威，向量可以在下一次
 * 重建里补回来。active 存在但损坏（缺 DB、manifest 不全）仍然算"有"，那种情况必须
 * 大声失败，不能静默分叉。
 */
export function hasActiveVectorGeneration() {
  try {
    return Boolean(readVectorState({ tolerateMissing: true }).state?.active)
  } catch {
    return false
  }
}

/**
 * 读 active manifest。missing → { ok: true, state: null }；
 * 坏 JSON / 坏形状 → typed error（绝不把"读不懂"当成"没有"，更不猜最近文件）。
 */
export function readVectorState({ tolerateMissing = true } = {}) {
  const file = vectorActiveFile()
  const result = readJsonStrict(file)
  if (!result.ok) {
    if (result.missing) {
      if (tolerateMissing) return { ok: true, state: null, file }
      throw vectorError(VECTOR_ERROR_CODES.NOT_ACTIVE, 'no vector-active manifest yet', { file })
    }
    if (result.kind === 'corrupt') throw vectorError(VECTOR_ERROR_CODES.ACTIVE_CORRUPT, 'vector-active.json is not valid JSON; refusing to guess a generation', { file })
    throw vectorError(VECTOR_ERROR_CODES.ACTIVE_UNREADABLE, 'cannot read vector-active.json (' + (result.error?.code || 'io error') + ')', { file })
  }
  const state = result.value
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw vectorError(VECTOR_ERROR_CODES.ACTIVE_CORRUPT, 'vector-active.json is not an object', { file })
  }
  if (state.active !== null && state.active !== undefined && !validActive(state.active)) {
    throw vectorError(VECTOR_ERROR_CODES.ACTIVE_CORRUPT, 'vector-active.json has an invalid active block', { file, active: state.active })
  }
  if (state.pending !== null && state.pending !== undefined && !validPending(state.pending)) {
    throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'vector-active.json has an invalid pending journal', { file, pending: state.pending })
  }
  if (state.version !== VECTOR_ACTIVE_SCHEMA || !Number.isSafeInteger(state.generation) || state.generation < 0) throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'unsupported or invalid vector active schema/generation', { file })
  if (state.active) {
    const active = state.active
    if (active.fingerprint !== active.profile.fingerprint || state.generation < active.generation) throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'active profile and generation disagree', { file })
    const entries = [[null, active.databases.global], ...Object.entries(active.databases.libraries)]
    for (const [libraryId, entry] of entries) {
      if (!entry || typeof entry !== 'object' || entry.path !== vectorDbRelPath({ libraryId, fingerprint: active.fingerprint, generation: active.generation })) throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'active database mapping disagrees with its generation', { file, libraryId })
    }
  }
  if (state.pending?.status === 'committed' && (!state.active || state.pending.generation !== state.active.generation || state.pending.fingerprint !== state.active.fingerprint)) throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'committed journal disagrees with active generation', { file })
  return { ok: true, state: normalizeState(state), file }
}

function normalizeState(state) {
  return {
    version: VECTOR_ACTIVE_SCHEMA,
    generation: Number.isSafeInteger(state.generation) && state.generation >= 0 ? state.generation : 0,
    requested: state.requested && typeof state.requested === 'object' ? state.requested : null,
    active: state.active && typeof state.active === 'object' ? state.active : null,
    pending: state.pending && typeof state.pending === 'object' ? state.pending : null,
    writeGuard: state.writeGuard && typeof state.writeGuard === 'object' ? state.writeGuard : { frozen: null, leases: {} },
  }
}

/** 读当前 state；缺失返回 null，损坏抛 typed error。 */
export function vectorState() {
  return readVectorState({ tolerateMissing: true }).state
}

/**
 * 唯一写入口：文件锁内做同步 compare + 原子指针写。mutator 必须同步——
 * 绝不允许跨 await 持有文件锁（§14.8 第 5/7 条）。
 */
export function updateVectorStateSync(mutator) {
  if (typeof mutator !== 'function') throw vectorError(VECTOR_ERROR_CODES.BAD_UPDATE, 'updateVectorStateSync requires a mutator')
  const file = vectorActiveFile()
  ensureDir(indexDir())
  return withFileLock(file, () => {
    const result = readJsonStrict(file)
    let current
    if (result.ok) {
      if (!result.value || typeof result.value !== 'object' || Array.isArray(result.value)) {
        throw vectorError(VECTOR_ERROR_CODES.ACTIVE_CORRUPT, 'vector-active.json is not an object', { file })
      }
      current = readVectorState({ tolerateMissing: false }).state
    } else if (result.missing) {
      current = emptyState()
    } else if (result.kind === 'corrupt') {
      throw vectorError(VECTOR_ERROR_CODES.ACTIVE_CORRUPT, 'vector-active.json is not valid JSON; refusing to overwrite it', { file })
    } else {
      throw vectorError(VECTOR_ERROR_CODES.ACTIVE_UNREADABLE, 'cannot read vector-active.json', { file })
    }
    const next = mutator(current)
    if (next && typeof next.then === 'function') {
      throw vectorError(VECTOR_ERROR_CODES.BAD_UPDATE, 'updateVectorStateSync mutator must be synchronous: never hold the vector lock across an await')
    }
    if (!next) return current
    const payload = normalizeState(next)
    writeJson(file, payload)
    return payload
  })
}

/** requested 与 active 分离：用户"选了"不等于"生效了"（§14.6 第 2 条）。 */
export function requestedProfile() {
  const state = vectorState()
  const requested = state?.requested
  if (!requested || typeof requested !== 'object') return null
  return requested
}

export function setRequestedProfile(value, extra = {}) {
  const profile = resolveProfile(value)
  const at = stamp()
  const next = updateVectorStateSync(state => ({
    ...state,
    requested: { status: 'requested', catalogId: profile.catalogId, fingerprint: profile.fingerprint, profile, at, ...extra },
  }))
  return next.requested
}

export function clearRequestedProfile() {
  const next = updateVectorStateSync(state => ({ ...state, requested: null }))
  return next.requested
}

/** 当前生效的 profile；没有就返回 null（不猜、不回退默认模型）。 */
export function activeProfile() {
  const state = vectorState()
  if (!state?.active) return null
  assertProfileVerified(state.active.profile)
  return state.active.profile
}

export function activeGeneration() {
  const state = vectorState()
  return state?.active?.generation ?? null
}

/**
 * 条目级"已入向量库"戳（entry.vector）。迁移写库故意不碰索引，所以迁移写入的条目没有
 * 戳、只有账本知道；而迁移之后的每一次向量写入（remember/import/review/update/curator）
 * 都必须在提交成功后把这条戳落进索引。词法路径没写库，不戳；remote-api 沿用历史口径
 * （本地还留着 active 代际时照样记，界面只拿它回答"进没进向量后端"）。空间归属由
 * membership() 的戳腿自行过滤：只认 route === 'managed-local' 且代际匹配的戳。只读不抛错。
 */
export function activeEntryStamp(route) {
  if (route === 'lexical') return null
  try {
    const active = readVectorState({ tolerateMissing: true }).state?.active
    if (!active) return null
    return {
      route,
      model: active.profile?.catalogId || null,
      generation: active.generation,
      fingerprint: String(active.fingerprint || '').slice(0, 8),
      at: stamp(),
    }
  } catch {
    return null
  }
}

/** active manifest 里的 DB 集合，一次性取得（避免多库逐个换混空间）。 */
export function activeDatabases() {
  return databaseMapFor(vectorState()?.active)
}

function databaseMapFor(active) {
  if (!active) return null
  const databases = { global: resolveVectorPath(active.databases.global.path), libraries: {} }
  for (const [libraryId, entry] of Object.entries(active.databases.libraries || {})) {
    databases.libraries[libraryId] = resolveVectorPath(entry?.path)
  }
  return {
    generation: active.generation,
    fingerprint: active.fingerprint,
    profile: active.profile,
    snapshot: active.snapshot ?? null,
    global: databases.global,
    libraries: databases.libraries,
  }
}

/**
 * 非受管模式仍可用：有 active 代际就用它的路径，否则回落 legacy 路径。
 * 主代理把 state.js 的 memoryDbPath 指到这里即可。
 */
export function dbPathFor(libraryId = null) {
  const state = vectorState()
  const active = state?.active
  if (!active) return legacyDbPath(libraryId)
  assertProfileVerified(active.profile)
  const entry = libraryId === null || libraryId === undefined || libraryId === 'global'
    ? active.databases.global
    : active.databases.libraries?.[libraryId]
  if (!entry) throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'the active generation does not contain library ' + libraryId)
  return resolveVectorPath(entry.path)
}

/**
 * Register a genuinely empty new library in the current space, never legacy.
 * Call within withVectorWrite and before the first commit/index submission.
 * loadIndex must be synchronous; by default the authoritative raw index is read.
 * A nonempty, corrupt, quarantined or unknown-shaped index requires rebuilding.
 */
/**
 * Remove one library from the active database map under the manifest lock.
 * The caller owns filesystem cleanup; returning the captured absolute path keeps
 * the manifest mutation atomic without deleting a possibly newer generation.
 */
export function removeActiveLibrary(libraryId) {
  if (!isSafeId(libraryId) || libraryId === 'global') throw vectorError(VECTOR_ERROR_CODES.PATH_ESCAPE, 'unsafe private library id: ' + JSON.stringify(libraryId))
  let removed = null
  updateVectorStateSync(state => {
    const guard = liveGuard(state.writeGuard)
    if (guard.frozen || Object.keys(guard.leases).length) {
      throw vectorError('VECTOR_WRITE_BUSY', 'an in-flight vector write prevents deleting a library; retry shortly', { libraryId })
    }
    if (state.pending) {
      throw vectorError('VECTOR_WRITE_BUSY', 'a vector generation switch prevents deleting a library; retry shortly', { libraryId })
    }
    const active = state.active
    const entry = active?.databases?.libraries?.[libraryId]
    if (!active || !entry) return null
    removed = resolveVectorPath(entry.path)
    const libraries = { ...active.databases.libraries }
    delete libraries[libraryId]
    return { ...state, active: { ...active, databases: { ...active.databases, libraries } } }
  })
  return removed
}

export function enrollActiveLibrary(libraryId, { loadIndex } = {}) {
  if (!isSafeId(libraryId) || libraryId === 'global') throw vectorError(VECTOR_ERROR_CODES.PATH_ESCAPE, 'unsafe private library id: ' + JSON.stringify(libraryId))
  let db = null
  updateVectorStateSync(state => {
    if (!state.active) { db = legacyDbPath(libraryId); return null }
    const guard = liveGuard(state.writeGuard)
    if (guard.frozen) throw vectorError('VECTOR_WRITE_FROZEN', 'cannot enroll a library during a vector generation switch')
    if (!Object.values(guard.leases).some(lease => lease.pid === process.pid)) throw vectorError('VECTOR_WRITE_LEASE_REQUIRED', 'enrollActiveLibrary must run within withVectorWrite')
    assertProfileVerified(state.active.profile)
    const existing = state.active.databases.libraries[libraryId]
    if (existing) { db = resolveVectorPath(existing.path); return null }
    const indexFile = path.join(indexDir(), libraryId + '.json')
    return withFileLock(indexFile, () => {
      let index
      if (loadIndex) index = loadIndex(libraryId)
      else {
        const result = readJsonStrict(indexFile)
        if (result.ok) index = result.value
        else if (result.missing && !fs.readdirSync(indexDir()).some(name => name.startsWith(libraryId + '.json.corrupt-'))) index = { entries: {} }
        else throw vectorError('VECTOR_LIBRARY_REBUILD_REQUIRED', 'new library index cannot be proven empty; rebuild the vector generation', { libraryId })
      }
      if (index && typeof index.then === 'function') throw vectorError(VECTOR_ERROR_CODES.BAD_UPDATE, 'enrollActiveLibrary loadIndex must be synchronous')
      if (!index || typeof index !== 'object' || !index.entries || typeof index.entries !== 'object' || Array.isArray(index.entries) || Object.keys(index.entries).length) throw vectorError('VECTOR_LIBRARY_REBUILD_REQUIRED', 'a nonempty or invalid library index requires shadow rebuilding', { libraryId })
      const rel = vectorDbRelPath({ libraryId, fingerprint: state.active.fingerprint, generation: state.active.generation })
      db = resolveVectorPath(rel)
      ensureDir(path.dirname(db))
      try { fs.writeFileSync(db, '', { flag: 'wx' }) } catch (error) {
        throw vectorError(VECTOR_ERROR_CODES.SHADOW_PATH_TAKEN, 'new library vector path already exists or cannot be created; refusing to reuse it', { libraryId, causeCode: error?.code })
      }
      return { ...state, active: { ...state.active, databases: { ...state.active.databases, libraries: { ...state.active.databases.libraries, [libraryId]: { path: rel, bytes: 0, sha256: sha256Hex('') } } } } }
    })
  })
  return db
}

export function profileDatabaseMap(libraryIds = [], profile = activeProfile()) {
  const state = vectorState()
  const active = state?.active
  const out = {}
  for (const id of libraryIds) {
    if (active?.databases?.libraries?.[id]) out[id] = resolveVectorPath(active.databases.libraries[id].path)
    else if (profile) out[id] = vectorDbAbsPath({ libraryId: id, fingerprint: profile.fingerprint, generation: (active?.generation ?? 0) + 1 })
    else out[id] = legacyDbPath(id)
  }
  return out
}

/** memu 子进程需要的本地嵌入环境（不写 key 到磁盘，只在进程环境里传）。 */
export function profileEnv(profile, { baseUrl, token } = {}) {
  if (!profile) return {}
  const env = {
    MEMU_MEMORY_MODE: 'local',
    MEMU_EMBED_PROVIDER: 'openai',
    MEMU_EMBED_MODEL: String(profile.catalogId || profile.model || ''),
    MEMU_BASE_URL: String(baseUrl || '').replace(/\/$/, ''),
    MEMU_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
    MEMU_EVENTS_BASE_URL: '',
  }
  if (token) env.MEMU_API_KEY = String(token)
  return env
}

// ---------------------------------------------------------------- 代际与 pending journal

export function nextGeneration(state = null) {
  const current = state ?? vectorState()
  const active = Number.isSafeInteger(current?.active?.generation) ? current.active.generation : 0
  const pending = Number.isSafeInteger(current?.pending?.generation) ? current.pending.generation : 0
  const counter = Number.isSafeInteger(current?.generation) ? current.generation : 0
  return Math.max(active, pending, counter) + 1
}

export function buildDatabaseSet({ profile, generation, libraryIds = [] }) {
  const databases = {
    global: { path: vectorDbRelPath({ libraryId: null, fingerprint: profile.fingerprint, generation }), bytes: null, sha256: null },
    libraries: {},
  }
  for (const libraryId of libraryIds) {
    if (!isSafeId(libraryId)) throw vectorError(VECTOR_ERROR_CODES.PATH_ESCAPE, 'unsafe library id: ' + JSON.stringify(libraryId), { libraryId })
    databases.libraries[libraryId] = { path: vectorDbRelPath({ libraryId, fingerprint: profile.fingerprint, generation }), bytes: null, sha256: null }
  }
  return databases
}

/**
 * 为一次影子重建分配全新代际，并把 prepared journal 先持久化。
 * 这一步之后 DB 路径才存在，所以"每次重建都是全新路径"，绝不复用上一轮的影子库
 * （避免把一次 recommit 当成一次 reembedding，§14.8 第 2/4 条）。
 */
export function reserveShadowGeneration({ profile, libraryIds = [], reason = 'switch' } = {}) {
  const verified = assertProfileVerified(profile)
  const at = stamp()
  let reserved = null
  const state = updateVectorStateSync(current => {
    const generation = nextGeneration(current)
    const databases = buildDatabaseSet({ profile: verified, generation, libraryIds })
    const token = sha256Hex(stableStringify({ generation, fingerprint: verified.fingerprint, previousGeneration: current.active?.generation ?? null, at, reason }))
    reserved = { generation, token, databases, at }
    return {
      ...current,
      generation: Math.max(current.generation || 0, generation),
      pending: {
        status: 'preparing',
        generation,
        fingerprint: verified.fingerprint,
        catalogId: verified.catalogId,
        profile: verified,
        previousGeneration: current.active?.generation ?? null,
        previousFingerprint: current.active?.fingerprint ?? null,
        databases,
        reason,
        token,
        at,
        updatedAt: at,
        error: null,
        report: null,
      },
    }
  })
  return { ...reserved, state }
}

/** pending journal 的读取与更新（都在同一把同步锁里）。 */
export function pendingJournal() {
  const state = vectorState()
  return state?.pending ?? null
}

export function updatePendingJournal(mutator) {
  let result = null
  updateVectorStateSync(state => {
    if (!state.pending) return null
    const next = typeof mutator === 'function' ? mutator(state.pending) : { ...state.pending, ...mutator }
    if (!next) return null
    result = { ...next, updatedAt: stamp() }
    return { ...state, pending: result }
  })
  return result
}

export function clearPendingJournal() {
  const next = updateVectorStateSync(state => (state.pending ? { ...state, pending: null } : null))
  return next.pending ?? null
}

// ---------------------------------------------------------------- 写入护栏

function databasePaths(databases) {
  const paths = [resolveVectorPath(databases.global.path)]
  for (const entry of Object.values(databases.libraries || {})) paths.push(resolveVectorPath(entry?.path))
  return paths
}

/**
 * 护栏核心：此刻是否允许读/写向量。
 * deep=true 时额外核对文件大小（启动恢复/切换前用；运行期不查，因为 active 库会正常增长）。
 */
export function assertVectorWriteAllowed({ deep = false, readOnly = false } = {}) {
  const state = readVectorState({ tolerateMissing: false }).state
  if (!readOnly && liveGuard(state.writeGuard).frozen) throw vectorError('VECTOR_WRITE_FROZEN', 'vector writes are paused for the final generation switch; retry shortly')
  const active = state.active
  if (!active) throw vectorError(VECTOR_ERROR_CODES.NOT_ACTIVE, 'no active vector generation; use lexical recall')
  if (!validActive(active)) throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'the active vector manifest is incomplete; refusing vectors')
  if (state.pending?.status === 'committed' && state.pending.generation !== active.generation) {
    throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'the commit journal and the active pointer disagree about the generation; refusing vectors', {
      pendingGeneration: state.pending.generation, activeGeneration: active.generation,
    })
  }
  if (state.pending?.status === 'preparing' && state.pending.previousGeneration === null && !state.active) {
    throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'a build was reserved before any generation became active; refusing vectors')
  }
  // 未验证/未知/pending 的 manifest 一律拒绝，绝不拿旧向量空间继续算。
  assertProfileVerified(active.profile)
  let paths
  try {
    paths = databasePaths(active.databases)
  } catch (error) {
    if (isVectorStateError(error)) throw error
    throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'cannot resolve the active database set: ' + (error?.message || error))
  }
  for (let index = 0; index < paths.length; index++) {
    let info
    try { info = fs.statSync(paths[index]) } catch {
      throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'a database in the active generation is missing: ' + path.basename(paths[index]), { missing: paths[index] })
    }
    if (!info.isFile()) {
      throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'a database in the active generation is not a file: ' + path.basename(paths[index]), { path: paths[index] })
    }
    const recorded = index === 0 ? active.databases.global.bytes : Object.values(active.databases.libraries || {})[index - 1]?.bytes
    if (deep && Number.isSafeInteger(recorded) && recorded > 0 && info.size < recorded) {
      throw vectorError(VECTOR_ERROR_CODES.TORN_STATE, 'a database in the active generation shrank below its committed size: ' + path.basename(paths[index]), {
        path: paths[index], expected: recorded, actual: info.size,
      })
    }
  }
  return {
    generation: active.generation,
    fingerprint: active.fingerprint,
    profile: active.profile,
    databases: databaseMapFor(active),
    snapshot: active.snapshot ?? null,
    pending: state.pending ? { status: state.pending.status, generation: state.pending.generation, fingerprint: state.pending.fingerprint } : null,
  }
}

/** 回合开始捕获单代（§14.8 第 7 条）；失败返回 null，调用方退词法。 */
export function captureGeneration() {
  const allowed = assertVectorWriteAllowed({ readOnly: true })
  return Object.freeze({
    token: 'gen:' + allowed.generation + ':' + allowed.fingerprint.slice(0, 8),
    generation: allowed.generation,
    fingerprint: allowed.fingerprint,
    profile: allowed.profile,
    global: allowed.databases.global,
    libraries: Object.freeze({ ...allowed.databases.libraries }),
    snapshot: allowed.snapshot,
    capturedAt: stamp(),
  })
}

export function tryCaptureGeneration() {
  try { return captureGeneration() } catch { return null }
}

/**
 * 投放前重验：代际/指纹/路径必须与捕获时完全一致，否则抛 STALE_GENERATION
 * （in-flight 的旧代结果不得计入新代成功）。
 */
export function assertGeneration(captured) {
  if (!captured || typeof captured !== 'object') {
    throw vectorError(VECTOR_ERROR_CODES.NO_GENERATION, 'no captured vector generation for this turn; use lexical recall')
  }
  const allowed = assertVectorWriteAllowed({ readOnly: true })
  if (allowed.generation !== captured.generation || allowed.fingerprint !== captured.fingerprint) {
    throw vectorError(VECTOR_ERROR_CODES.STALE_GENERATION, 'the active vector generation changed during the turn; discard this result', {
      expected: { generation: captured.generation, fingerprint: captured.fingerprint },
      actual: { generation: allowed.generation, fingerprint: allowed.fingerprint },
    })
  }
  const currentGlobal = allowed.databases.global
  const capturedGlobal = captured.global
  if (capturedGlobal && currentGlobal !== capturedGlobal) {
    throw vectorError(VECTOR_ERROR_CODES.STALE_GENERATION, 'the active database set changed during the turn', { expected: capturedGlobal, actual: currentGlobal })
  }
  for (const [id, db] of Object.entries(captured.libraries || {})) {
    if (db !== allowed.databases.libraries[id]) throw vectorError(VECTOR_ERROR_CODES.STALE_GENERATION, 'a captured library path no longer belongs to the active generation', { libraryId: id })
  }
  const currentIds = Object.keys(allowed.databases.libraries).sort().join(',')
  const capturedIds = Object.keys(captured.libraries || {}).sort().join(',')
  if (currentIds !== capturedIds) {
    throw vectorError(VECTOR_ERROR_CODES.STALE_GENERATION, 'the active library set changed during the turn', { expected: capturedIds, actual: currentIds })
  }
  return allowed
}

/** Capture/revalidate an explicit shadow operation; never accept an arbitrary profile/DB. */
export function assertMigrationProfile({ profile, db, generation, token } = {}) {
  assertProfileVerified(profile)
  const state = vectorState()
  const pending = state?.pending
  const stale = () => vectorError(VECTOR_ERROR_CODES.STALE_GENERATION, 'the migration profile or database no longer belongs to the pending generation; discard this result')
  if (!pending || pending.status === 'committed' || pending.fingerprint !== profile.fingerprint || (generation !== undefined && pending.generation !== generation) || (token !== undefined && pending.token !== token)) throw stale()
  if ((pending.previousGeneration ?? null) !== (state.active?.generation ?? null) || (pending.previousFingerprint ?? null) !== (state.active?.fingerprint ?? null)) throw stale()
  const paths = databasePaths(pending.databases)
  if (typeof db !== 'string' || !paths.includes(path.resolve(db))) throw stale()
  return Object.freeze({ profile, db: path.resolve(db), generation: pending.generation, token: pending.token })
}

/** 只读状态汇总，供 RPC/UI 用；不抛错（损坏时给 status: 'torn'）。 */
export function vectorStatus() {
  let state
  try {
    state = vectorState()
  } catch (error) {
    return { status: 'torn', error: { code: error.code || 'VECTOR_UNKNOWN', message: String(error?.message || error) }, requested: null, active: null, pending: null }
  }
  if (!state) return { status: 'absent', requested: null, active: null, pending: null }
  // 旧版本在切换成功后会留下 requested = { status: 'active' }。那不是"待切换的另一个
  // 模型"，读的时候按没有请求处理，界面才不会同时显示"当前生效 + 待切换"。
  const requestedState = state.requested && typeof state.requested === 'object' && state.requested.status !== 'active'
    ? state.requested : null
  let status = 'absent'
  if (state.active) {
    try {
      assertVectorWriteAllowed({ readOnly: true })
      status = 'active'
    } catch (error) {
      return {
        status: 'torn',
        error: { code: error.code || 'VECTOR_UNKNOWN', message: String(error?.message || error) },
        requested: requestedState ? { catalogId: requestedState.catalogId, fingerprint: requestedState.fingerprint } : null,
        active: { generation: state.active.generation, fingerprint: state.active.fingerprint, catalogId: state.active.profile?.catalogId ?? null },
        pending: state.pending ? { status: state.pending.status, generation: state.pending.generation, fingerprint: state.pending.fingerprint } : null,
      }
    }
  }
  return {
    status,
    requested: requestedState ? { catalogId: requestedState.catalogId, fingerprint: requestedState.fingerprint, at: requestedState.at ?? null } : null,
    active: state.active ? {
      generation: state.active.generation,
      fingerprint: state.active.fingerprint,
      catalogId: state.active.profile?.catalogId ?? null,
      profile: state.active.profile,
      databases: activeDatabases(),
      previous: state.active.previous ?? null,
      lastMigration: state.active.lastMigration ?? null,
      updatedAt: state.active.updatedAt ?? null,
    } : null,
    pending: state.pending ? {
      status: state.pending.status,
      generation: state.pending.generation,
      fingerprint: state.pending.fingerprint,
      previousGeneration: state.pending.previousGeneration ?? null,
      report: state.pending.report ?? null,
      error: state.pending.error ?? null,
    } : null,
  }
}

// Leases are persisted under the same short synchronous manifest lock. No file
// lock spans the backend await; a final freeze fails fast while a writer runs.
function ownerAlive(owner) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return false
  try { process.kill(owner.pid, 0); return true } catch (error) { return error?.code !== 'ESRCH' }
}
function liveGuard(guard = {}) {
  return {
    frozen: ownerAlive(guard.frozen) ? guard.frozen : null,
    leases: Object.fromEntries(Object.entries(guard.leases || {}).filter(([, lease]) => ownerAlive(lease))),
  }
}
export async function withVectorWrite(action) {
  if (typeof action !== 'function') throw new TypeError('withVectorWrite requires an action')
  const token = crypto.randomUUID()
  let generation = null
  updateVectorStateSync(state => {
    const guard = liveGuard(state.writeGuard)
    if (guard.frozen) throw vectorError('VECTOR_WRITE_FROZEN', 'vector writes are paused for a generation switch; retry shortly')
    if (state.active) generation = assertVectorWriteAllowed()
    guard.leases[token] = { pid: process.pid, at: stamp() }
    return { ...state, writeGuard: guard }
  })
  try { return await action(generation) } finally {
    updateVectorStateSync(state => {
      const guard = liveGuard(state.writeGuard)
      delete guard.leases[token]
      return { ...state, writeGuard: guard }
    })
  }
}
export async function withVectorWriteFreeze(action) {
  if (typeof action !== 'function') throw new TypeError('withVectorWriteFreeze requires an action')
  const token = crypto.randomUUID()
  updateVectorStateSync(state => {
    const guard = liveGuard(state.writeGuard)
    if (guard.frozen || Object.keys(guard.leases).length) throw vectorError('VECTOR_WRITE_BUSY', 'an in-flight vector write prevents switching; retry shortly')
    return { ...state, writeGuard: { ...guard, frozen: { pid: process.pid, token, at: stamp() } } }
  })
  try { return await action() } finally {
    updateVectorStateSync(state => {
      const guard = liveGuard(state.writeGuard)
      if (guard.frozen?.token === token) guard.frozen = null
      return { ...state, writeGuard: guard }
    })
  }
}

export const activeVectorState = vectorState
export const memuDbFor = dbPathFor
export const memuGlobalDbFor = () => dbPathFor(null)
export const captureVectorGeneration = captureGeneration
export const assertVectorGeneration = assertGeneration