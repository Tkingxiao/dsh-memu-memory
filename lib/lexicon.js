// ── 词典层（Lexicon）核心：P0 存储安全 + 生命周期 active/archived + P1 读取检索 ──
// 契约：docs/memory-semantics.md §8.13（当前生命周期与注入语义）。
// 词典不替代记忆、不触发下载、不接 settings：冷却与预算全部用本模块常量 + 模块内
// 状态（见 lexiconCooldownStore）。
//
// 存储安全不变量（§1-§2，每一条都有对应测试）：
//   * 路径只能是 dataDir()/lexicon/<libraryId>.json，libraryId 过 isSafeId（拒绝
//     绝对路径、..、路径分隔符——isSafeId 的白名单字符集天然挡掉它们）。
//   * 读：缺失 → 空结构；损坏/IO 失败/曾 quarantined → typed error，绝不当空处理
//     （paths.readJsonStrict 的口径：吞掉的读失败会把下一次写变成整库覆盖）。
//   * 写：一切写函数在 withFileLock 内重读磁盘上的最新 revision 再改（CAS），
//     revision 单调 +1 后 writeJson 原子替换（tmp + fsync + rename）。锁是同步作用
//     域，从不跨 await。调用方手里的任何旧副本都写不回磁盘——写路径不接受外部对象。
//   * 记录格式 §1.2：normalizedTerm/normalizedAliases、evidence 短证据、hitCounts
//     三计数（candidate/injection/query）。
//   * 生命周期（§2.1）：公开两态 active/archived；`pending` 只作为旧版的 legacy
//     数据被读（迁移见 migrateLegacyLexiconStatuses），`rejected` 只作为内部墓碑 +
//     fingerprint 存在（永不注入、永不列出、永不计数）。新写路径不再产出这两种状态。
//   * 读路径（§10 P1）：每本词典一份 revision-keyed 内存快照 + 派生索引，见
//     lexiconIndexCache 的注释——JSON 是唯一主事实，索引永远是可重建的派生物。
import fs from 'node:fs'
import path from 'node:path'
import { dataDir, readJsonStrict, readFailure, writeJson, withFileLock, isSafeId, shortHash, warn, stamp } from './paths.js'
import { normalizeMemoryContext, contextVisible, sameFactContext } from './context.js'
import { bigrams, dice } from './text-similarity.js'
import { estTokens } from './budget.js'

// 容量与长度上限（§1.2）。刻意不接 settings：容量是存储安全边界，不该被运行时配置放宽。
export const LEXICON_CAP = 5000
const TERM_MAX_CHARS = 80
const MEANING_MAX_CHARS = 500
const USAGE_MAX_CHARS = 300
const ALIAS_MAX_COUNT = 8
const ALIAS_MAX_CHARS = 80
const EXAMPLE_MAX_COUNT = 5
const EXAMPLE_MAX_CHARS = 200
const EVIDENCE_MAX_COUNT = 10
const EVIDENCE_QUOTE_MAX_CHARS = 200

// 匹配流水线常量（§3.1-§3.2）。threshold 0.60 是起步标定值，P4 用标注样本复核。
export const LEXICON_DICE_THRESHOLD = 0.6
export const LEXICON_MAX_BUCKETS = 16
export const LEXICON_MAX_CANDIDATES = 64
export const LEXICON_MAX_TERMS = 8
// 词面包含（includes）命中的最小规范化长度：单字词在 CJK 里到处出现，放进精确层
// 只会制造噪声。等值匹配（整句恰好等于词条）不受此限制。
export const LEXICON_MIN_INCLUDE_LEN = 2
// 前缀桶宽度：词条侧取 normalizedTerm 的前 2 字符做桶键，文本侧穷举 2 字符窗口。
const BUCKET_WIDTH = 2

// 冷却与回合预算（§3.3）。冷却按 binding/session 记，选择"模块内 Map"而不是
// binding 字段：binding 持久化在 state.json，注入路径每回合都写会把状态文件变成
// 热路径，而冷却丢一批（进程重启）最坏只是同一个词多注入一次，代价不对称。
// key = binding 的 sessionId（一个 session 只有一个 binding → 一本私有库）。
export const LEXICON_RECALL_COOLDOWN_MINUTES = 30
export const LEXICON_MAX_PER_TURN = 2
export const lexiconCooldownStore = new Map() // key: sessionKey → Map(termId → lastInjectedAt ms)

// 频率先验：三计数的写入上限与 Wilson 下界的 z 值。上限挡住
// 病态数据把 effective 因子顶出 [0.85,1.00] 的界；z=1.96 即 95% 单侧置信。
export const HIT_COUNT_CAP = 1_000_000
export const WILSON_Z = 1.96

const KINDS = ['slang', 'meme', 'trigger', 'term']
// 公开生命周期只有两态（§2.1）。pending/rejected 仍是磁盘上可能存在的 legacy 状态，
// 但新调用方不能把词条写成它们（见 upsertLexiconTerm 的 status 收口）。
const PUBLIC_STATUSES = ['active', 'archived']
const SOURCES = ['user', 'curator', 'model-proposal']

function lexiconError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function clip(text, max) {
  const s = String(text ?? '')
  return s.length > max ? s.slice(0, max) : s
}

/**
 * 词条词面的统一规范化：NFKC → 大小写折叠 → 去空白/标点/符号。
 * 与 lib/text-similarity.js clean()（memory.js 矛盾检测的既有预处理）同风格，
 * 只多一步 NFKC：全角/半角和兼容字符必须折叠成同一个词面，否则唯一性约束会被
 * 「糖刀」和「糖刀」（全角感叹号）绕开。
 */
export function normalizeLexeme(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function lexiconDir() {
  return path.join(dataDir(), 'lexicon')
}

// 全局词典与私有词典同格式、同锁、同缓存，只是占一个保留的存储名。
// 私有库 id 一律是 `lib_<hex>`（state.js libraryIdForScope），所以 `global` 不可能
// 是某本私有库——`data/lexicon/global.json` 与 `index/global.json`（全局记忆）对齐。
export const GLOBAL_LEXICON_ID = 'global'

function lexiconFile(libraryId) {
  // isSafeId 只放行 [A-Za-z0-9._-]{1,128} 且拒绝 . / ..：绝对路径、反斜杠、
  // ../ 和任意文件名在这里就死掉，不会拼进路径。
  if (!isSafeId(libraryId)) throw lexiconError('LEXICON_INVALID_LIBRARY_ID', `invalid lexicon library id: ${clip(libraryId, 40)}`)
  return path.join(lexiconDir(), `${libraryId}.json`)
}

function emptyLexicon(libraryId) {
  return { version: 1, revision: 0, libraryId, terms: {}, rejected: {} }
}

function readLexiconStrict(file, libraryId) {
  // 曾被 quarantine（读失败被挪走）的库不能当空库处理：读回来是"空"的下一个写
  // 就会把整本词典覆盖掉。这里宁可 typed error 也绝不静默清零。
  const failure = readFailure(file)
  if (failure) {
    throw lexiconError('LEXICON_READ_FAILED', `lexicon ${libraryId} is write-protected by an earlier read failure (${failure.code || failure.message})`)
  }
  const result = readJsonStrict(file)
  if (result.missing) return emptyLexicon(libraryId)
  if (!result.ok) {
    const error = lexiconError('LEXICON_CORRUPT', `lexicon ${libraryId} could not be read (${result.kind === 'corrupt' ? 'invalid JSON' : result.error?.code || 'read failed'}); nothing is treated as empty and writes stay blocked until it is restored`)
    if (result.error) error.cause = result.error
    throw error
  }
  const value = result.value
  // 形状校验：合法 JSON 但不是词典（数组、version 不对、terms 不是对象表、行不是
  // 对象）同样是"损坏"——照单全收会让下一次写把陌生形状固化下来。
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value.version !== undefined && value.version !== 1)
    || !value.terms || typeof value.terms !== 'object' || Array.isArray(value.terms)) {
    throw lexiconError('LEXICON_CORRUPT', `lexicon ${libraryId} has an invalid data shape; refusing to treat it as empty`)
  }
  for (const [termId, entry] of Object.entries(value.terms)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw lexiconError('LEXICON_CORRUPT', `lexicon ${libraryId} entry ${termId} is not an object`)
    }
  }
  return {
    version: 1,
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    libraryId,
    terms: value.terms,
    rejected: value.rejected && typeof value.rejected === 'object' && !Array.isArray(value.rejected) ? value.rejected : {},
  }
}

// ── revision-keyed 内存索引（§10 P1 / §8.2 的 O(N) 优化项）───────────────────
// 每本词典在进程内保留一份「读取快照 + 派生索引」，key = `${libraryId}@${revision}`：
//   data              严格读取出的词典对象（JSON 永远是主事实，快照只是派生物）
//   activeEntries / archivedEntries / pendingEntries   构建时分好 status 并按展示序
//                     排好的词条；archived 里可能包含 legacy revision 草稿（带 revisionOf，
//                     由 restoreLexiconTerm 拒绝恢复）；pendingEntries 只服务迁移/审计，
//                     任何注入/检索/列表面都不读它；rejected 不进任何列表（墓碑）。
//   byNormalizedTerm / byAlias       等值查询：Map<规范化词面, termId[]>
//   prefixBuckets     Map<词面前 BUCKET_WIDTH 字, Set<termId>>（dice 候选 + 正向包含候选）
//   grams             Map<词面任意 2 字 gram, Set<termId>>（searchLexicon 反向包含候选）
//   surfacesByTerm    Map<termId, [{ surface, via }]>（term 在前、aliases 随后，含/等值判定用）
//
// 失效策略（正确性红线：任何绕过本进程的文件改动不得让缓存返回旧数据）：
//   * 进程内一切写都走 mutateLexicon → 写成功后立即用刚落盘的对象重建快照
//     （revision 已 +1，旧 key 随之作废）。
//   * 进程外的改动（测试直写 paths.writeJson、backup 恢复、手工修复文件）：缓存
//     命中前对文件 stat 一次并比对 mtimeMs + size。一次 stat（µs 级）远比全量
//     JSON.parse（N=5k 时 ms 级）便宜；mtime 与 size 同时不变的覆写只剩「同毫秒内
//     等字节覆写」一条理论缝，在 NTFS/APFS/ext4（亚毫秒 mtime 精度）上实际不可达。
//     选 stat 比对而不是 revision 校验：revision 在 JSON 内部，读它就得先 parse，
//     等于放弃缓存。quarantine 把文件挪走 → stat 失败 → 必然 miss 回严格读取，
//     typed error 语义不变。
//   * 文件缺失（空库）不缓存：外部新建的文件必须立刻被下一次读取看见。
const lexiconIndexCache = new Map() // key: `${libraryId}@${revision}` → snapshot
const lexiconIndexHint = new Map() // libraryId → { key, mtimeMs, size }

// 展示序：strength → updatedAt → termId（构建索引与 merged 列表共用同一把尺）。
function displayRank(a, b) {
  return (Number(b.entry.strength) || 0) - (Number(a.entry.strength) || 0)
    || String(b.entry.updatedAt || '').localeCompare(String(a.entry.updatedAt || ''))
    || String(a.termId).localeCompare(String(b.termId))
}

function buildLexiconIndex(data) {
  const byNormalizedTerm = new Map()
  const byAlias = new Map()
  const prefixBuckets = new Map()
  const grams = new Map()
  const surfacesByTerm = new Map()
  const activeEntries = []
  const archivedEntries = []
  const pendingEntries = []
  for (const [termId, entry] of Object.entries(data.terms)) {
    const status = entry.status || 'active'
    if (status === 'active') activeEntries.push({ termId, entry })
    else if (status === 'archived') archivedEntries.push({ termId, entry })
    else if (status === 'pending') pendingEntries.push({ termId, entry })
    const surfaces = []
    if (entry.normalizedTerm) surfaces.push({ surface: entry.normalizedTerm, via: 'term' })
    const aliases = Array.isArray(entry.normalizedAliases) ? entry.normalizedAliases : []
    for (const alias of aliases) {
      if (alias && alias !== entry.normalizedTerm) surfaces.push({ surface: alias, via: 'alias' })
    }
    if (surfaces.length) surfacesByTerm.set(termId, surfaces)
    for (const { surface, via } of surfaces) {
      const target = via === 'term' ? byNormalizedTerm : byAlias
      let ids = target.get(surface)
      if (!ids) { ids = []; target.set(surface, ids) }
      ids.push(termId)
      // 前缀桶：与原 bucketKeysOf 同口径——词面前 BUCKET_WIDTH 字，过短词面用自身。
      const prefixKey = surface.length >= BUCKET_WIDTH ? surface.slice(0, BUCKET_WIDTH) : surface
      let bucket = prefixBuckets.get(prefixKey)
      if (!bucket) { bucket = new Set(); prefixBuckets.set(prefixKey, bucket) }
      bucket.add(termId)
      // gram 倒排：searchLexicon 的反向包含（query ⊆ 词面）靠它收候选。正向包含
      // （词面 ⊆ query）也可以用它，但前缀桶的候选集更小（词面必须以该窗口开头），
      // 所以正向走前缀桶。
      for (let i = 0; i + BUCKET_WIDTH <= surface.length; i++) {
        const gram = surface.slice(i, i + BUCKET_WIDTH)
        let set = grams.get(gram)
        if (!set) { set = new Set(); grams.set(gram, set) }
        set.add(termId)
      }
    }
  }
  // 展示序在构建时定死（strength → updatedAt → termId）：过滤是保序的，调用方
  // 不必再对可见子集排序——排序键全是静态字段，与可见性无关，两个顺序等价。
  activeEntries.sort(displayRank)
  archivedEntries.sort(displayRank)
  pendingEntries.sort(displayRank)
  return { data, activeEntries, archivedEntries, pendingEntries, byNormalizedTerm, byAlias, prefixBuckets, grams, surfacesByTerm }
}

function storeLexiconIndex(libraryId, file, data) {
  const snapshot = buildLexiconIndex(data)
  const key = `${libraryId}@${data.revision}`
  const previous = lexiconIndexHint.get(libraryId)
  if (previous) lexiconIndexCache.delete(previous.key)
  let stat = null
  try { stat = fs.statSync(file) } catch {}
  if (stat) {
    lexiconIndexCache.set(key, snapshot)
    lexiconIndexHint.set(libraryId, { key, mtimeMs: stat.mtimeMs, size: stat.size })
  } else {
    // 空库（文件还不存在）不缓存缺失状态。
    lexiconIndexHint.delete(libraryId)
  }
  return snapshot
}

/** 带缓存的内部读取：命中走 stat 比对，未命中走严格读取 + 建索引。 */
function lexiconIndex(libraryId) {
  const file = lexiconFile(libraryId)
  // quarantine（读失败保护）优先于一切缓存：曾 quarantined 的库必须继续 typed error。
  const failure = readFailure(file)
  if (failure) {
    throw lexiconError('LEXICON_READ_FAILED', `lexicon ${libraryId} is write-protected by an earlier read failure (${failure.code || failure.message})`)
  }
  const hint = lexiconIndexHint.get(libraryId)
  if (hint) {
    let stat = null
    try { stat = fs.statSync(file) } catch {}
    if (stat && stat.mtimeMs === hint.mtimeMs && stat.size === hint.size) {
      const snapshot = lexiconIndexCache.get(hint.key)
      if (snapshot) return snapshot
    }
  }
  const data = readLexiconStrict(file, libraryId)
  return storeLexiconIndex(libraryId, file, data)
}

/**
 * 读一本词典。缺失 → 空结构（revision 0）；损坏 → LEXICON_CORRUPT，绝不当空处理。
 * 命中缓存时返回快照的浅拷贝：顶层字段与 terms 表逐键复制，防止调用方增删键污染
 * 缓存；词条对象按只读契约共享——库内全部读路径都不改词条对象，测试里「改完立刻
 * 写盘」的直改模式由 mtime 失效兜底（写盘 ⇒ 下一次 stat 必不匹配 ⇒ 重建）。
 */
export function loadLexicon(libraryId) {
  const snapshot = lexiconIndex(libraryId)
  return { ...snapshot.data, terms: { ...snapshot.data.terms } }
}

/**
 * 一切写操作的唯一入口：锁内重读最新 revision（CAS）→ mutator 同步改 → revision+1
 * → writeJson 原子替换。mutator 必须同步（withFileLock 的锁不能跨 await）。
 * 写成功后用刚落盘的对象重建内存索引：省掉下一次读取的整个 JSON.parse，重建成本
 * 与建索引同阶且本来就在锁内。
 *
 * `onlyWhenChanged` 给迁移类写用（migrateLegacyLexiconStatuses）：mutator 通过
 * `changed === true` 声明真的改了数据；否则不落盘、不 bump revision——没有变化的
 * 迁移不该把文件变成热写（revision 是别的进程判新的依据，空转 +1 只会制造噪声）。
 */
function mutateLexicon(libraryId, mutator, { onlyWhenChanged = false } = {}) {
  const file = lexiconFile(libraryId)
  return withFileLock(file, () => {
    const current = readLexiconStrict(file, libraryId)
    const outcome = mutator(current) || {}
    if (onlyWhenChanged && outcome.changed !== true) return outcome
    current.revision = (Number(current.revision) || 0) + 1
    current.libraryId = libraryId
    current.version = 1
    writeJson(file, current)
    storeLexiconIndex(libraryId, file, current)
    return outcome
  })
}

function withTermId(entry, termId) {
  return { termId, ...entry }
}

function normalizeEvidence(evidence) {
  if (evidence === undefined || evidence === null) return []
  if (!Array.isArray(evidence)) throw lexiconError('LEXICON_INVALID_EVIDENCE', 'evidence must be an array of { kind, id, quote }')
  return evidence
    .filter(item => item && typeof item === 'object')
    .map(item => ({
      kind: clip(typeof item.kind === 'string' ? item.kind : 'message', 40),
      id: clip(typeof item.id === 'string' ? item.id : '', 160),
      quote: clip(typeof item.quote === 'string' ? item.quote : '', EVIDENCE_QUOTE_MAX_CHARS),
    }))
    .filter(item => item.quote.trim() || item.id)
    .slice(0, EVIDENCE_MAX_COUNT)
}

function normalizeStringList(value, { maxCount, maxChars, label }) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw lexiconError(`LEXICON_INVALID_${label}`, `${label} must be an array of strings`)
  return value
    .map(item => clip(String(item ?? ''), maxChars))
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, maxCount)
}

/**
 * 同一规范化 term/alias 在同一可见范围内的冲突检查。返回撞线的既有条目或 null。
 * 可见范围 = sameFactContext（channel/speaker/character/world/branch 身份组一致）。
 *
 * 状态口径（§2.1）：
 *   * includeArchived=false：归档条目完全不参与（旧口径；恢复检查用）。
 *   * includeArchived=true：归档条目按 term 等值参与（via: 'archived'）——归档不占
 *     别名位置，但同规范词的新写入必须看见它，否则用户/模型会在归档条目旁边建出
 *     一条同词重复，之后 restore 必然撞线。
 *   * skipRejected=true：rejected 是墓碑，不占命名空间（恢复一个归档条目时，墓碑
 *     不该阻止它回到 active）。
 *   * legacy revision 草稿（带 revisionOf）排在普通词条之后：同词同时存在目标与草稿
 *     时，撞线对象永远是目标词条，草稿只作为兜底被看见。
 */
function findScopeCollision(terms, {
  normalizedTerm, normalizedAliases, context, ignoreTermId = null, includeArchived = false, skipRejected = false,
}) {
  let best = null
  let bestRank = Infinity
  for (const [termId, entry] of Object.entries(terms)) {
    if (termId === ignoreTermId) continue
    const status = entry.status || 'active'
    let via = null
    if (status === 'archived') {
      if (!includeArchived) continue
      if (entry.normalizedTerm === normalizedTerm) via = 'archived'
    } else if (status === 'rejected' && skipRejected) {
      continue
    } else if (sameFactContext(entry.context || {}, context || {})) {
      if (entry.normalizedTerm === normalizedTerm) via = 'term'
      else if ((entry.normalizedAliases || []).includes(normalizedTerm)) via = 'alias'
      else if (normalizedAliases.includes(entry.normalizedTerm)) via = 'new-alias-is-term'
      else if ((entry.normalizedAliases || []).some(alias => normalizedAliases.includes(alias))) via = 'alias'
    }
    if (!via) continue
    const rank = (status === 'archived' ? 1 : 0) + (entry.revisionOf ? 2 : 0)
    if (rank < bestRank) { best = { termId, entry, via }; bestRank = rank }
  }
  return best
}

// active 条目的敏感字段（§2.3 + 契约）：这些字段变化时不许非用户来源静默覆盖。
// usage/aliases/examples/confidence/strength/evidence 属于非敏感字段，原地更新。
const SENSITIVE_FIELDS = ['term', 'kind', 'sensitivity', 'context', 'meaning']

function sensitiveDelta(existing, next) {
  const changed = []
  for (const field of SENSITIVE_FIELDS) {
    const before = field === 'context' ? JSON.stringify(existing.context || {}) : String(existing[field] ?? '')
    const after = field === 'context' ? JSON.stringify(next.context || {}) : String(next[field] ?? '')
    if (before !== after) changed.push(field)
  }
  return changed
}

/**
 * 写入/更新一个词条（§2 统一 op 的落点）。
 *
 * 公开生命周期只有 active / archived（§2.1）；pending / rejected 只作为 legacy 数据
 * 与内部墓碑存在，任何新写都不会产出它们：
 *   * 来源 'user'：用户显式操作，字段（含敏感字段）直接生效。显式 status:'archived'
 *     允许；pending/rejected 一律收口成 active。撞上 archived / rejected / legacy
 *     pending 词条 = 复活并应用字段（rejected 同时清掉拒绝指纹）。
 *   * 来源 'model-proposal' / 'curator'：普通词条直接 active（不再 pending、不再
 *     needs_review）。sensitive trigger 一律 typed 拒绝（LEXICON_SENSITIVE_FORBIDDEN）；
 *     已存在的 sensitive trigger 的任何更新同样拒绝——只有用户能管敏感词。
 *   * 非用户更新 active / legacy pending 普通词条：敏感字段（term/kind/sensitivity/
 *     context/meaning）有任何变化 → typed 拒绝（LEXICON_SENSITIVE_FIELDS_FORBIDDEN），
 *     绝不生成 pending revision；非敏感字段（usage/aliases/examples/confidence/
 *     strength/evidence）原地更新。visibility 也不归非用户改（secret 是披露边界，
 *     不在 §2.1 的非敏感名单里）。legacy pending 被非用户写入时收口为 active。
 *   * 撞上 archived 词条：非用户不复活、不新建（notOwned）；撞上 rejected 墓碑：
 *     model-proposal 仍是 LEXICON_PROPOSAL_REJECTED，curator 得到 notOwned；
 *     撞上 legacy revision 草稿（revisionOf）：非用户不复活（notOwned）。
 *   * 同规范词（term）在 sameFactContext 作用域内唯一；别名撞线仍是
 *     LEXICON_ALIAS_CONFLICT（不静默合并——合并会改写别人的记录）。
 *   * `domain` 是写入会话的领域戳（跨库召回判同域用，§8.15）：给了就覆盖，没给就
 *     保留既有条目的原值。归档 / 恢复 / 删除这些生命周期动作不碰它。
 */
export function upsertLexiconTerm({
  libraryId, term, kind = 'term', meaning = '', usage = '', aliases = [], examples = [],
  context = {}, knownBy = [], visibility = 'shared', sensitivity, confidence, strength,
  evidence = [], source = 'user', status, domain,
}) {
  if (!SOURCES.includes(source)) throw lexiconError('LEXICON_INVALID_SOURCE', `lexicon source must be one of ${SOURCES.join(', ')}`)
  const isUser = source === 'user'
  const rawTerm = String(term ?? '').trim()
  if (!rawTerm) throw lexiconError('LEXICON_INVALID_TERM', 'lexicon term must be a non-empty string')
  if (rawTerm.length > TERM_MAX_CHARS) throw lexiconError('LEXICON_INVALID_TERM', `lexicon term exceeds ${TERM_MAX_CHARS} characters`)
  if (!KINDS.includes(kind)) throw lexiconError('LEXICON_INVALID_KIND', `lexicon kind must be one of ${KINDS.join(', ')}`)
  if (!['shared', 'secret'].includes(visibility)) throw lexiconError('LEXICON_INVALID_VISIBILITY', 'lexicon visibility must be shared or secret')
  // trigger 默认 sensitive（§1.2）；显式传值也只接受两个档位。
  const resolvedSensitivity = sensitivity === undefined || sensitivity === null
    ? (kind === 'trigger' ? 'sensitive' : 'normal')
    : String(sensitivity)
  if (!['normal', 'sensitive'].includes(resolvedSensitivity)) throw lexiconError('LEXICON_INVALID_SENSITIVITY', 'lexicon sensitivity must be normal or sensitive')
  // 敏感触发词不允许模型/curator 猜（§0.2 / §2.1）：非用户来源建 sensitive trigger
  // 直接 typed 拒绝，只有用户能管理敏感词。
  if (!isUser && kind === 'trigger' && resolvedSensitivity === 'sensitive') {
    throw lexiconError('LEXICON_SENSITIVE_FORBIDDEN', `${source} cannot create sensitive triggers; sensitive vocabulary is user-managed`)
  }
  const normalizedContext = normalizeMemoryContext(context && typeof context === 'object' ? context : {})
  const normalizedKnownBy = normalizeStringList(knownBy, { maxCount: 30, maxChars: 128, label: 'KNOWNBY' })
  if (normalizedKnownBy.length) normalizedContext.knownBy = normalizedKnownBy
  const normalizedTerm = normalizeLexeme(rawTerm)
  if (!normalizedTerm) throw lexiconError('LEXICON_INVALID_TERM', 'lexicon term normalizes to empty')
  const aliasList = normalizeStringList(aliases, { maxCount: ALIAS_MAX_COUNT, maxChars: ALIAS_MAX_CHARS, label: 'ALIASES' })
  const normalizedAliases = aliasList.map(normalizeLexeme).filter(Boolean)
    .filter(alias => alias !== normalizedTerm)
  const resolvedConfidence = Number.isFinite(Number(confidence)) ? Math.max(0, Math.min(1, Number(confidence))) : 0.8
  // strength 是展示权重不是语义字段（不在 SENSITIVE_FIELDS）：改它走原地更新。
  // 未提供时保留既有值/默认 0.6。
  const resolvedStrength = Number.isFinite(Number(strength)) ? Math.max(0, Math.min(1, Number(strength))) : null
  // 公开两态（§2.1）：pending/rejected 不再由新调用方可设，统一收口为 active；
  // 非用户来源连 archived 也不能设（归档是用户动作）。
  const explicitStatus = status !== undefined && status !== null && String(status).trim() !== ''
  const requestedStatus = PUBLIC_STATUSES.includes(String(status ?? '')) ? String(status) : 'active'
  const wantedStatus = isUser ? requestedStatus : 'active'
  // 输入侧归一化一次，创建与更新共用（敏感字段比较用同一份结果）。
  const fields = {
    kind,
    meaning: clip(String(meaning ?? ''), MEANING_MAX_CHARS),
    usage: clip(String(usage ?? ''), USAGE_MAX_CHARS),
    aliases: aliasList,
    normalizedAliases,
    examples: normalizeStringList(examples, { maxCount: EXAMPLE_MAX_COUNT, maxChars: EXAMPLE_MAX_CHARS, label: 'EXAMPLES' }),
    context: normalizedContext,
    visibility,
    sensitivity: resolvedSensitivity,
    confidence: resolvedConfidence,
    evidence: normalizeEvidence(evidence),
  }

  // domain 是「哪个领域写得了这条词」的戳，跨库召回靠它判是否同域（§8.15）。
  // 它不是敏感字段（不进 SENSITIVE_FIELDS）：非用户来源也能带它落库；未提供时
  // 保留既有条目的原值，绝不清空。
  const normalizedDomain = String(domain ?? '').trim().slice(0, 40)
  const domainStamp = normalizedDomain ? { domain: normalizedDomain } : null

  return mutateLexicon(libraryId, (lex) => {
    const terms = lex.terms
    // 同 fingerprint 的 model-proposal 再来 → 直接拒绝（§2.3）：rejected 留指纹就是
    // 为了让同一句错话不要每轮重放。
    const fingerprint = shortHash(normalizedTerm)
    if (source === 'model-proposal' && lex.rejected?.[fingerprint]) {
      const prior = lex.rejected[fingerprint]
      throw lexiconError('LEXICON_PROPOSAL_REJECTED', `this normalized term was already rejected${prior?.reason ? `: ${prior.reason}` : ''}`)
    }
    const collision = findScopeCollision(terms, {
      normalizedTerm, normalizedAliases, context: normalizedContext, includeArchived: true,
    })
    const now = stamp()

    if (collision && (collision.via === 'term' || collision.via === 'archived')) {
      const { termId, entry } = collision
      const entryStatus = entry.status || 'active'
      // 兜底的指纹拦截：rejected 留在 terms 表里，指纹表缺失（手工修复过的文件）时
      // 也不能让 model-proposal 把一条被拒的词条洗回生命周期。
      if (source === 'model-proposal' && entryStatus === 'rejected') {
        throw lexiconError('LEXICON_PROPOSAL_REJECTED', 'this normalized term was already rejected; resubmission is blocked')
      }
      // 归档 / 墓碑 / 修订草稿：非用户来源一律不复活、不改写，返回既有条目并标
      // notOwned —— 这些状态只由用户（或迁移）处置。
      const immutable = entryStatus === 'archived' || entryStatus === 'rejected'
        || (entryStatus === 'pending' && Boolean(entry.revisionOf))
      if (immutable && !isUser) {
        return { term: withTermId(entry, termId), created: false, notOwned: true }
      }
      if (!isUser) {
        // 已存在的 sensitive trigger：所有非用户更新都拒绝（conservative，§2.1）。
        if (entry.kind === 'trigger' && entry.sensitivity === 'sensitive') {
          throw lexiconError('LEXICON_SENSITIVE_FIELDS_FORBIDDEN', `${source} cannot update the sensitive trigger "${entry.term}"; only the user manages sensitive entries`)
        }
        // visibility 不在"非敏感字段"名单里（§2.1 只列 usage/aliases/examples/
        // confidence/strength/evidence）：secret 是披露边界，模型/curator 不得通过更新
        // 把一条 secret 词条洗成 shared。沉默忽略也不好——调用方会以为写成功了。
        if ((entry.visibility || 'shared') !== visibility) {
          throw lexiconError('LEXICON_SENSITIVE_FIELDS_FORBIDDEN', `${source} cannot change the visibility of "${entry.term}" (${entry.visibility || 'shared'} → ${visibility}); only the user can`)
        }
        const next = {
          ...entry, ...fields, updatedAt: now, strength: resolvedStrength ?? (Number(entry.strength) || 0.6),
          ...(domainStamp || {}),
        }
        // 敏感字段变化 → typed 拒绝（§2.1：不再生成 pending revision 等人审）。
        const changedSensitive = sensitiveDelta(entry, next)
        if (changedSensitive.length) {
          throw lexiconError('LEXICON_SENSITIVE_FIELDS_FORBIDDEN', `${source} cannot change sensitive fields (${changedSensitive.join(', ')}) of the existing term "${entry.term}"; ask the user to edit it`)
        }
        // legacy pending 普通词条：非用户写入直接收口为 active（迁移前的过渡路径）。
        if (entryStatus === 'pending') next.status = 'active'
        next.normalizedTerm = normalizedTerm
        terms[termId] = next
        return { term: withTermId(next, termId), created: false }
      }
      // 用户：直接应用（含敏感字段）。编辑一条已归档词条不应等于悄悄恢复：
      // 只有显式 status（或 restoreLexiconTerm）才把它带回 active。显式 status 的
      // 复活会断开草稿链（revisionOf 是"某条 active 的下一版草稿"的标记）。
      const userStatus = entryStatus === 'archived' && !explicitStatus ? 'archived' : wantedStatus
      const next = {
        ...entry,
        ...fields,
        updatedAt: now,
        strength: resolvedStrength ?? (Number(entry.strength) || 0.6),
        status: userStatus,
        normalizedTerm,
        fingerprint,
        ...(domainStamp || {}),
      }
      delete next.revisionOf
      delete next.previousRevision
      const revived = entryStatus !== 'active' && userStatus === 'active'
      if (revived) {
        next.reviewedAt = now
        next.reviewedBy = source
        next.reviewReason = null
        // rejected 的翻案：清掉拒绝指纹，同词的 model-proposal 不再被无限拦截。
        if (entry.fingerprint && lex.rejected?.[entry.fingerprint]) delete lex.rejected[entry.fingerprint]
      }
      terms[termId] = next
      return { term: withTermId(next, termId), created: false, ...(revived ? { revived: true } : {}) }
    }

    if (collision) {
      // 新词条的 alias 撞了别的词条：宁可报错也不静默合并——合并会改写别人的记录。
      throw lexiconError('LEXICON_ALIAS_CONFLICT', `normalized alias collides with existing term "${collision.entry.term}" (${collision.termId})`)
    }

    if (Object.keys(terms).length >= LEXICON_CAP) {
      throw lexiconError('LEXICON_CAP_REACHED', `lexicon ${libraryId} is at its ${LEXICON_CAP} term capacity; archive or delete before adding`)
    }

    const termId = newTermId()
    const entry = {
      term: rawTerm,
      normalizedTerm,
      ...fields,
      strength: resolvedStrength ?? 0.6,
      status: wantedStatus,
      source,
      fingerprint,
      createdAt: now,
      updatedAt: now,
      reviewedAt: null,
      reviewedBy: null,
      reviewReason: null,
      hitCounts: { candidate: 0, injection: 0, query: 0 },
      lastInjectedAt: null,
      ...(domainStamp || {}),
    }
    terms[termId] = entry
    return { term: withTermId(entry, termId), created: true }
  })
}

function newTermId() {
  return `lex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 归档（§2.1 / §2.3）：只有 active → archived；其余状态 typed 拒绝（legacy pending
 * 先走迁移收口，rejected 是墓碑、没有归档语义）。归档不写 rejected 指纹——归档是
 * 可恢复的退场，不是拒绝。
 */
export function archiveLexiconTerm({ libraryId, termId }) {
  return mutateLexicon(libraryId, (lex) => {
    const entry = lex.terms[termId]
    if (!entry) throw lexiconError('LEXICON_NOT_FOUND', `lexicon term ${termId} does not exist in ${libraryId}`)
    const status = entry.status || 'active'
    if (status !== 'active') throw lexiconError('LEXICON_INVALID_STATUS', `only active terms can be archived; ${termId} is ${status}`)
    const now = stamp()
    entry.status = 'archived'
    entry.updatedAt = now
    return { term: withTermId(entry, termId), termId, action: 'archive' }
  })
}

/**
 * 恢复（§2.1 / §2.3）：只有 archived → active。两条硬拒绝：
 *   * legacy revision 草稿（revisionOf 指向仍 active 的目标）不能独立恢复——它是
 *     目标词条的下一版草稿，不是词条（LEXICON_REVISION_IMMUTABLE）。
 *   * 恢复会与同作用域的 active 词条撞同一个规范词面/别名 → LEXICON_ALIAS_CONFLICT
 *     （不制造同词重复；用户想合并就在两个词条上分别编辑）。
 * 墓碑（rejected）不参与撞线：它不占命名空间。
 */
export function restoreLexiconTerm({ libraryId, termId }) {
  return mutateLexicon(libraryId, (lex) => {
    const entry = lex.terms[termId]
    if (!entry) throw lexiconError('LEXICON_NOT_FOUND', `lexicon term ${termId} does not exist in ${libraryId}`)
    const status = entry.status || 'active'
    if (status !== 'archived') throw lexiconError('LEXICON_INVALID_STATUS', `only archived terms can be restored; ${termId} is ${status}`)
    if (entry.revisionOf && (lex.terms[entry.revisionOf]?.status || 'active') === 'active') {
      throw lexiconError('LEXICON_REVISION_IMMUTABLE', `lexicon term ${termId} is a legacy revision draft of ${entry.revisionOf}; edit the active term instead`)
    }
    const normalizedAliases = Array.isArray(entry.normalizedAliases) ? entry.normalizedAliases : []
    const collision = findScopeCollision(lex.terms, {
      normalizedTerm: entry.normalizedTerm,
      normalizedAliases,
      context: entry.context || {},
      ignoreTermId: termId,
      skipRejected: true,
    })
    if (collision) {
      throw lexiconError('LEXICON_ALIAS_CONFLICT', `restoring "${entry.term}" would collide with active term "${collision.entry.term}" (${collision.termId})`)
    }
    const now = stamp()
    entry.status = 'active'
    entry.updatedAt = now
    return { term: withTermId(entry, termId), termId, action: 'restore' }
  })
}

/**
 * 删除词条。刻意只暴露给管理面（RPC/UI/P3）：模型没有任何删除路径——
 * tools.js 的模型工具面拿不到这个函数，curator op 白名单里也没有 delete。
 */
export function deleteLexiconTerm({ libraryId, termId }) {
  return mutateLexicon(libraryId, (lex) => {
    const entry = lex.terms[termId]
    if (!entry) throw lexiconError('LEXICON_NOT_FOUND', `lexicon term ${termId} does not exist in ${libraryId}`)
    delete lex.terms[termId]
    if (entry.fingerprint && lex.rejected?.[entry.fingerprint]?.termId === termId) {
      delete lex.rejected[entry.fingerprint]
    }
    return { deleted: true, termId, term: entry.term }
  })
}

/**
 * §1.3 / §2.1：可见词条，逐条过与记忆同一把尺子（contextVisible）。过滤失败的绝不返回。
 * 默认只有 active；`includeArchived: true`（管理面/浏览器）追加已归档词条（含 legacy
 * revision 草稿）。pending/rejected 永远不出现——前者只服务迁移，后者是内部墓碑。
 * 状态分组与展示序都在索引构建时定好，这里只剩 contextVisible 过滤本身；active 与
 * archived 混排时重排一次（两段各自有序，合并后必须保持同一把展示序）。
 */
export function visibleLexiconTerms(libraryId, memoryContext, { includeArchived = false } = {}) {
  const index = lexiconIndex(libraryId)
  const out = []
  for (const { termId, entry } of index.activeEntries) {
    if (!contextVisible(entry.context, memoryContext)) continue
    out.push(withTermId(entry, termId))
  }
  if (includeArchived) {
    for (const { termId, entry } of index.archivedEntries) {
      if (!contextVisible(entry.context, memoryContext)) continue
      out.push(withTermId(entry, termId))
    }
    out.sort((a, b) => (Number(b.strength) || 0) - (Number(a.strength) || 0)
      || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
      || String(a.termId).localeCompare(String(b.termId)))
  }
  return out
}

function clamp01(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

/**
 * Wilson 下界（§6.3 包 C 的有界频率先验）：hitCounts 三计数（candidate/injection/
 * query）→ 95% Wilson 置信下界。n=candidate 是分母（候选池大小），成功 =
 * injection+query（真的注入了 / 被显式查过），恒 ≤ n。设计约束：
 *   * n=0 → 0（从未候选过的词条没有任何频率证据，因子取下限 0.85）。
 *   * 1/1 的下界 ≈ 0.207，因子最多 ~3% 差距——一条偶发命中压不过长期稳定使用的词。
 *   * 100/120 的下界明显更高——长期被真正使用的词条温和提升。
 *   * 输出 clamp 到 [0,1]，与 strength/confidence 的 clamp01 同口径；乘上
 *     (0.85 + 0.15 * lb) 后 effective 因子恒在 [0.85,1.00]，不 runaway。
 */
export function usageLowerBound(counts) {
  const n = Math.max(0, Math.floor(Number(counts?.candidate) || 0))
  if (n === 0) return 0
  const success = Math.min(n, Math.max(0, (Number(counts?.injection) || 0) + (Number(counts?.query) || 0)))
  const p = success / n
  const z = WILSON_Z, z2 = z * z
  const lb = (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n)
  return clamp01(lb)
}

/**
 * effective 展示权重（§6.3 排序键）：strength × confidence × (0.85 + 0.15 × Wilson
 * 下界)。因子固定在 [0.85,1.00]，只做温和的先验，绝不压过 exact/alias/Dice 的
 * 匹配层级——那三层在 stableRank 里先于 effective 生效。
 */
function effectiveWeight(hit) {
  return clamp01(hit.strength) * clamp01(hit.confidence) * (0.85 + 0.15 * usageLowerBound(hit.hitCounts))
}

/** §3.2 稳定排序：排序键固定，末位 id 字典序，绝不用当前时间或遍历序做 tie-break。 */
function stableRank(hits) {
  return [...hits].sort((a, b) => {
    const sa = sensitivityRank(a), sb = sensitivityRank(b)
    if (sa !== sb) return sb - sa
    const ea = exactRank(a.kindOfHit), eb = exactRank(b.kindOfHit)
    if (ea !== eb) return eb - ea
    if (ea === 1 && Math.abs((b.score || 0) - (a.score || 0)) > 1e-9) return (b.score || 0) - (a.score || 0)
    const wa = effectiveWeight(a), wb = effectiveWeight(b)
    if (Math.abs(wb - wa) > 1e-9) return wb - wa
    const ga = scopeSpecificity(a.context), gb = scopeSpecificity(b.context)
    if (ga !== gb) return gb - ga
    const ta = String(a.updatedAt || ''), tb = String(b.updatedAt || '')
    if (ta !== tb) return tb.localeCompare(ta)
    return String(a.termId).localeCompare(String(b.termId))
  })
}

// 敏感优先的定义（§8.3 统一项）：与锚点摘要（lexiconAnchorSummary 按
// sensitivity === 'sensitive' 单列）同一把尺——sensitivity 即敏感，不再要求
// kind === 'trigger'。旧实现 B 通道只抬 trigger+sensitive、锚点按全部 sensitive
// 分组，两条通道对"敏感"的判定不一致；统一为「只要 sensitive 就优先」，与
// §8.1「敏感词安全高于自动化」一致，也和写入侧 trigger 默认 sensitive 的口径互补。
function sensitivityRank(hit) {
  return hit.sensitivity === 'sensitive' ? 1 : 0
}

// exact term > exact alias > dice（§3.2 的 2-4 键）。
function exactRank(kindOfHit) {
  if (kindOfHit === 'exact-term') return 3
  if (kindOfHit === 'exact-alias') return 2
  return 1
}

// 作用域具体度（§3.2 排序键之一，显式定义）：词条 context 里已定义的身份字段个数。
// 字段集与 lib/context.js 的 IDENTITIES 完全同组（channelId/speakerId/characterId/
// worldId/branchId），非空数越多越具体，具体者优先。knownBy 是可见性边界
// （contextVisible 的事），不是作用域，不计入；空白 context = 全场景共享，具体度
// 0，排在任何带作用域的词条之后。
function scopeSpecificity(context) {
  if (!context || typeof context !== 'object') return 0
  return ['channelId', 'speakerId', 'characterId', 'worldId', 'branchId'].filter(key => context[key]).length
}

/** 文本侧：穷举 BUCKET_WIDTH 字符窗口，按出现顺序去重，上限 MAX_BUCKETS。 */
function textBuckets(normalizedText, maxBuckets = LEXICON_MAX_BUCKETS) {
  const keys = []
  const seen = new Set()
  for (let i = 0; i + BUCKET_WIDTH <= normalizedText.length; i++) {
    const key = normalizedText.slice(i, i + BUCKET_WIDTH)
    if (seen.has(key)) continue
    seen.add(key)
    keys.push(key)
    if (keys.length >= maxBuckets) break
  }
  return keys
}

/**
 * 桶内 dice 兜底：对每个候选词条，在文本里定位它桶键的出现位置，取等长窗口算
 * Dice，取最大值。候选 ≤ maxCandidates、命中 ≤ maxTerms，O(C) 有界（§6）。
 */
function diceFallback(normalizedText, candidates, { threshold = LEXICON_DICE_THRESHOLD, maxCandidates = LEXICON_MAX_CANDIDATES, maxTerms = LEXICON_MAX_TERMS } = {}) {
  const textGrams = bigrams(normalizedText)
  if (!textGrams.size) return []
  const scored = []
  for (const hit of candidates.slice(0, maxCandidates)) {
    let best = 0
    for (const surface of [hit.normalizedTerm, ...(hit.normalizedAliases || [])]) {
      if (!surface || surface.length < BUCKET_WIDTH) continue
      const key = surface.slice(0, BUCKET_WIDTH)
      let pos = normalizedText.indexOf(key)
      while (pos >= 0) {
        const window = normalizedText.slice(pos, pos + surface.length)
        const score = dice(bigrams(window), bigrams(surface))
        if (score > best) best = score
        if (best >= 1) break
        pos = normalizedText.indexOf(key, pos + 1)
      }
      if (best >= threshold) break
    }
    if (best >= threshold) scored.push({ ...hit, kindOfHit: 'dice', score: best })
  }
  scored.sort((a, b) => (b.score - a.score)
    || (Number(b.strength) || 0) * (Number(b.confidence) || 0) - (Number(a.strength) || 0) * (Number(a.confidence) || 0)
    || String(a.termId).localeCompare(String(b.termId)))
  return scored.slice(0, maxTerms)
}

function hitOf(entry, termId, kindOfHit, score) {
  return {
    termId,
    term: entry.term,
    normalizedTerm: entry.normalizedTerm,
    kind: entry.kind,
    meaning: entry.meaning,
    usage: entry.usage,
    sensitivity: entry.sensitivity,
    strength: entry.strength,
    confidence: entry.confidence,
    // 频率先验（§6.3）的输入：stableRank 的 effective 因子按三计数算 Wilson 下界。
    hitCounts: entry.hitCounts && typeof entry.hitCounts === 'object' ? entry.hitCounts : { candidate: 0, injection: 0, query: 0 },
    context: entry.context,
    updatedAt: entry.updatedAt,
    status: entry.status,
    kindOfHit,
    score,
  }
}

/**
 * §3.1-§3.2 匹配流水线：精确（等值/包含）→ 前缀桶 → 桶内 dice 兜底 → stableRank。
 * 只读不写：candidate/injection 计数由调用方（inject.js）在真正发生时记。
 * 只匹配 active 词条：archived 已退场、rejected 是墓碑、legacy pending 等迁移收口，
 * 三种状态都不进注入（§2.1）。
 *
 * 全部走 revision-keyed 索引（§10 P1）：等值 O(1) 查 Map；包含层用「词面 ⊆ 文本
 * ⇒ 词面前缀 = 文本某个 2 字窗口」的性质从前缀桶收候选（窗口穷举不设 16 上限——
 * 16 上限只属于 dice 候选，精确层语义从来没有窗口上限）；dice 兜底仍按桶扫且
 * C ≤ 64 不变（§6）。可见性（status + contextVisible）在收候选时逐个复核。
 */
export function matchLexiconHits(libraryId, userText, memoryContext) {
  const normalizedText = normalizeLexeme(userText)
  if (!normalizedText) return []
  const index = lexiconIndex(libraryId)
  const data = index.data
  const isVisible = termId => {
    const entry = data.terms[termId]
    return Boolean(entry) && (entry.status || 'active') === 'active' && contextVisible(entry.context, memoryContext)
  }
  // 精确层·等值：Map 直查（同库同词面可有多条跨 scope 词条，值是 termId 列表）。
  const hits = []
  const exactIds = new Set()
  const pushExact = (termId, kindOfHit) => {
    if (exactIds.has(termId) || !isVisible(termId)) return
    exactIds.add(termId)
    hits.push(hitOf(data.terms[termId], termId, kindOfHit, 1))
  }
  for (const termId of index.byNormalizedTerm.get(normalizedText) || []) pushExact(termId, 'exact-term')
  for (const termId of index.byAlias.get(normalizedText) || []) pushExact(termId, 'exact-alias')
  // 精确层·包含：词面（≥MIN_INCLUDE_LEN）出现在文本里。前缀桶给出候选超集，
  // 逐候选复核 includes 并保留原判定序（term 在前、aliases 随后，第一个命中的
  // 词面决定 exact-term / exact-alias 标签）。
  const containIds = []
  for (let i = 0; i + BUCKET_WIDTH <= normalizedText.length; i++) {
    for (const termId of index.prefixBuckets.get(normalizedText.slice(i, i + BUCKET_WIDTH)) || []) {
      if (!exactIds.has(termId) && !containIds.includes(termId)) containIds.push(termId)
    }
  }
  for (const termId of containIds) {
    if (!isVisible(termId)) continue
    const entry = data.terms[termId]
    let matched = null
    for (const item of index.surfacesByTerm.get(termId) || []) {
      if (item.surface.length >= LEXICON_MIN_INCLUDE_LEN && normalizedText.includes(item.surface)) { matched = item; break }
    }
    if (matched) {
      exactIds.add(termId)
      hits.push(hitOf(entry, termId, matched.via === 'term' ? 'exact-term' : 'exact-alias', 1))
    }
  }
  // dice 候选：仍按 textBuckets 的 16 窗口上限收（§4.2 的 C≤64 语义不变）。
  const candidateIds = []
  for (const key of textBuckets(normalizedText)) {
    for (const termId of index.prefixBuckets.get(key) || []) {
      if (exactIds.has(termId) || candidateIds.includes(termId) || !isVisible(termId)) continue
      candidateIds.push(termId)
    }
  }
  const candidates = candidateIds
    .map(termId => hitOf(data.terms[termId], termId, 'dice', 0))
    .sort((a, b) => (Number(b.strength) || 0) * (Number(b.confidence) || 0) - (Number(a.strength) || 0) * (Number(a.confidence) || 0))
  const fuzzy = diceFallback(normalizedText, candidates)
  // stableRank 的末位 tie-break 是唯一 termId，命中顺序不影响最终排序。
  return stableRank([...hits, ...fuzzy])
}

/**
 * 精确层检索（§3.3 通道 C 的数据面）：等值 + includes，不做 dice、不做语义。
 * 默认只回 active；`includeArchived: true` 让管理面/浏览器显式看到归档词条。
 * pending（迁移前的老提案）与 rejected（墓碑）在任何模式下都不出现。
 * 走 revision-keyed 索引：等值 O(1) 查 Map；正向包含（词面 ⊆ query）用前缀桶
 * 收候选（穷举窗口、不设 16 上限——精确层语义没有窗口上限）；反向包含
 * （query ⊆ 词面）用 gram 倒排收候选。两个候选集都是超集，逐候选复核原始谓词。
 */
export function searchLexicon({ libraryId, query, memoryContext }, { includeArchived = false } = {}) {
  const normalizedQuery = normalizeLexeme(query)
  const out = []
  if (!normalizedQuery) return out
  const index = lexiconIndex(libraryId)
  const data = index.data
  const matched = []
  const considered = new Set()
  const consider = termId => {
    if (considered.has(termId)) return
    considered.add(termId)
    const entry = data.terms[termId]
    const status = entry.status || 'active'
    if (status !== 'active' && !(includeArchived && status === 'archived')) return
    if (!contextVisible(entry.context, memoryContext)) return
    const aliases = Array.isArray(entry.normalizedAliases) ? entry.normalizedAliases : []
    let matchedBy = null
    if (entry.normalizedTerm === normalizedQuery) matchedBy = 'term'
    else if (aliases.includes(normalizedQuery)) matchedBy = 'alias'
    else if (entry.normalizedTerm.length >= LEXICON_MIN_INCLUDE_LEN
      && (normalizedQuery.includes(entry.normalizedTerm) || entry.normalizedTerm.includes(normalizedQuery))) matchedBy = 'contains'
    else if (aliases.some(alias => alias.length >= LEXICON_MIN_INCLUDE_LEN
      && (normalizedQuery.includes(alias) || alias.includes(normalizedQuery)))) matchedBy = 'alias-contains'
    if (matchedBy) matched.push({ ...withTermId(entry, termId), matchedBy })
  }
  for (const termId of index.byNormalizedTerm.get(normalizedQuery) || []) consider(termId)
  for (const termId of index.byAlias.get(normalizedQuery) || []) consider(termId)
  if (normalizedQuery.length >= BUCKET_WIDTH) {
    const forward = new Set()
    const reverse = new Set()
    for (let i = 0; i + BUCKET_WIDTH <= normalizedQuery.length; i++) {
      const window = normalizedQuery.slice(i, i + BUCKET_WIDTH)
      for (const termId of index.prefixBuckets.get(window) || []) {
        if (!considered.has(termId)) forward.add(termId)
      }
      for (const termId of index.grams.get(window) || []) {
        if (!considered.has(termId) && !forward.has(termId)) reverse.add(termId)
      }
    }
    for (const termId of forward) consider(termId)
    for (const termId of reverse) consider(termId)
  } else {
    // 单字 query 没有 2 字窗口，反向包含（词面含该字）退化为对索引词面表的全扫：
    // 原生 includes 逐词面跑，N=5k 时仍是毫秒级；语义与逐条扫描完全一致。
    for (const [termId, surfaces] of index.surfacesByTerm) {
      if (considered.has(termId)) continue
      if (surfaces.some(item => item.surface.length >= LEXICON_MIN_INCLUDE_LEN && item.surface.includes(normalizedQuery))) {
        consider(termId)
      }
    }
  }
  matched.sort((a, b) => {
    const ra = a.matchedBy === 'term' ? 3 : a.matchedBy === 'alias' ? 2 : 1
    const rb = b.matchedBy === 'term' ? 3 : b.matchedBy === 'alias' ? 2 : 1
    if (ra !== rb) return rb - ra
    return String(a.termId).localeCompare(String(b.termId))
  })
  // query 计数（§3.3 三计数之一）：显式查询是注意力，best-effort 记账，失败不影响
  // 结果。只给 active 记账——管理面翻归档（includeArchived）不是"这次检索用到了它"，
  // 归档词条不进注入，给它加 query 计数只会污染频率先验。一次批量记账 = 一次锁内
  // CAS 写，不把检索变成 N 次磁盘写。
  const countable = matched.filter(item => (item.status || 'active') === 'active').slice(0, 20)
  if (countable.length) {
    try { lexiconRecordHits(libraryId, countable.map(item => item.termId), 'query') } catch (error) {
      warn(`lexicon query accounting failed: ${error?.message || error}`)
    }
  }
  return matched
}

/**
 * B 通道的渲染与成本共用同一把尺：cooldownAndBudget 按 estTokens(line) 扣预算。
 * “词典也是标题”（§2.2）：term 是标题（≤40 字），meaning/usage 只给短义（≤80 字），
 * 不展开 usage/examples——注入行永远是「标题 + 短释义」。
 */
export function lexiconTurnLine(hit) {
  const body = clip(String(hit.meaning || hit.usage || ''), 80)
  return `「${clip(String(hit.term || ''), 40)}」${body ? `：${body}` : ''}`
}

/**
 * 冷却 + 每回合预算（§3.3）：冷却内的词条仍出现在 hits 里（可计 candidate），
 * 但不进 selected（不计 injection）。预算按渲染行的 estTokens 顺序扣，扣不动就停。
 * bindingState 传 sessionId（string）或带 sessionId 的 binding 对象。
 */
export function cooldownAndBudget(hits, bindingState, tokenBudget) {
  const sessionKey = typeof bindingState === 'string' ? bindingState : String(bindingState?.sessionId || '')
  const now = Date.now()
  const cooldownMs = LEXICON_RECALL_COOLDOWN_MINUTES * 60_000
  const last = lexiconCooldownStore.get(sessionKey)
  const selected = []
  const onCooldown = []
  let used = 0
  const budget = Math.max(0, Number(tokenBudget) || 0)
  for (const hit of hits) {
    const injectedAt = last?.get(hit.termId) || 0
    if (injectedAt && now - injectedAt < cooldownMs) { onCooldown.push(hit); continue }
    if (selected.length >= LEXICON_MAX_PER_TURN) continue
    const cost = estTokens(lexiconTurnLine(hit)) + (selected.length ? 1 : 0)
    if (used + cost > budget) continue
    used += cost
    selected.push(hit)
  }
  return { selected, onCooldown, used }
}

/** 注入真的发生之后才调用：记冷却，下一次同词在冷却窗口内只做 candidate。 */
export function lexiconMarkInjected(bindingKey, termIds, now = Date.now()) {
  const sessionKey = String(bindingKey || '')
  if (!sessionKey || !Array.isArray(termIds) || termIds.length === 0) return
  let last = lexiconCooldownStore.get(sessionKey)
  if (!last) { last = new Map(); lexiconCooldownStore.set(sessionKey, last) }
  for (const termId of termIds) last.set(termId, now)
  // Map 只增不减会陪着进程活着变大；词条冷却窗口 30 分钟，过期键在读取时本就无效，
  // 这里顺手把整本已过期的 session 键清掉，成本 O(sessions)。
  if (lexiconCooldownStore.size > 512) {
    for (const [key, value] of lexiconCooldownStore) {
      const freshest = Math.max(...value.values())
      if (now - freshest >= cooldownWindowMs()) lexiconCooldownStore.delete(key)
    }
  }
}

function cooldownWindowMs() { return LEXICON_RECALL_COOLDOWN_MINUTES * 60_000 }

export function lexiconOnCooldown(bindingKey, termId, now = Date.now()) {
  const last = lexiconCooldownStore.get(String(bindingKey || ''))?.get(termId) || 0
  return last > 0 && now - last < cooldownWindowMs()
}

/**
 * 三计数分开累加（§3.3）：candidate（进过匹配结果）/ injection（真的注入了）/
 * query（显式检索命中）。写路径走 mutateLexicon（锁内 CAS + revision+1）。
 */
export function lexiconRecordHit(libraryId, termId, kindOfHit) {
  if (!['candidate', 'injection', 'query'].includes(kindOfHit)) {
    throw lexiconError('LEXICON_INVALID_HIT_KIND', 'hit kind must be candidate, injection or query')
  }
  const result = lexiconRecordHits(libraryId, [termId], kindOfHit)
  return { termId, hitCounts: result.counts[termId] }
}

/** 一次锁内写累加多个词条的同一类计数；未知词条抛 LEXICON_NOT_FOUND。 */
export function lexiconRecordHits(libraryId, termIds, kindOfHit) {
  return mutateLexicon(libraryId, (lex) => {
    const counts = {}
    for (const termId of termIds) {
      const entry = lex.terms[termId]
      if (!entry) throw lexiconError('LEXICON_NOT_FOUND', `lexicon term ${termId} does not exist in ${libraryId}`)
      entry.hitCounts = entry.hitCounts && typeof entry.hitCounts === 'object'
        ? entry.hitCounts
        : { candidate: 0, injection: 0, query: 0 }
      // 计数上限（§6.3 HIT_COUNT_CAP）：累加后 clamp 到 1,000,000——既有值越界
      // （手工修复/损坏数据）也在同一步被拉回界内，effective 因子的输入永远有界。
      for (const key of ['candidate', 'injection', 'query']) {
        entry.hitCounts[key] = Math.min(HIT_COUNT_CAP, Math.max(0, Number(entry.hitCounts[key]) || 0))
      }
      entry.hitCounts[kindOfHit] = Math.min(HIT_COUNT_CAP, (Number(entry.hitCounts[kindOfHit]) || 0) + 1)
      if (kindOfHit === 'injection') entry.lastInjectedAt = stamp()
      counts[termId] = { ...entry.hitCounts }
    }
    return { counts }
  })
}

/** §3.2 稳定排序的对外出口：跨源合并后必须用同一把尺重排，不许调用方自定排序。 */
export function rankLexiconHits(hits) {
  return stableRank(hits)
}

/**
 * 锚点摘要（§3.3 通道 A 的数据面）：top 8 by strength；敏感词条单列且 ≤2。
 * 行已按优先级排好——inject.js 超 300 token 时从尾部丢，丢的永远是最弱的一条。
 *
 * visibility 与记忆同一套语义（lib/memory.js visibleToSession 的契约：secret 只是
 * "不主动浮出"，不改变"被点名时"的可见性）：锚点是主动浮出，secret 词条不进摘要；
 * B 通道是用户消息点到了词面（等价于按词点名），secret 词条仍然命中并解释。
 *
 * 入参是「已按可见性过滤好的词条」，所以单库摘要与跨源合并摘要共用同一份渲染与
 * 取舍规则（lexiconAnchorSummary 是本函数在单库上的包装）。
 */
export function lexiconAnchorLines(entries) {
  const anchorable = (Array.isArray(entries) ? entries : []).filter(entry => entry.visibility !== 'secret')
  const sensitive = anchorable.filter(entry => entry.sensitivity === 'sensitive')
  const normal = anchorable.filter(entry => entry.sensitivity !== 'sensitive')
  const line = entry => `「${clip(String(entry.term || ''), 40)}」(${entry.kind})${entry.meaning ? ` ${clip(String(entry.meaning), 80)}` : ''}`
  const byStrength = list => [...list].sort((a, b) => (Number(b.strength) || 0) - (Number(a.strength) || 0)
    || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
    || String(a.termId).localeCompare(String(b.termId)))
  return {
    lines: byStrength(normal).slice(0, 8).map(line),
    sensitiveTriggers: byStrength(sensitive).slice(0, 2).map(line),
  }
}

export function lexiconAnchorSummary(libraryId, memoryContext) {
  return lexiconAnchorLines(visibleLexiconTerms(libraryId, memoryContext))
}

/**
 * legacy 生命周期迁移（§2.1）：旧版 pending 在当前生命周期不再存在，读到就跑一次收口。
 *   * pending 且 !revisionOf（老提案）→ active；敏感词 → archived（敏感词只能由用户
 *     显式管理，不能因为迁移悄悄进入注入面）。legacy 数据缺 sensitivity 的 trigger
 *     默认按 sensitive 处理（§1.2 的缺省值），同样归档。
 *   * pending 且 revisionOf（老修订草稿）→ archived：目标词条不动，草稿留审计。
 *   * rejected → 原样保留（内部墓碑 + fingerprint 不变）。
 * 只写有变化的文件：没有 pending 时直接返回，不 bump revision（迁移是巡检常客，
 * 空转写盘会让 revision 变成噪声，也会把没改过的文件推成热文件）。
 * 返回 { libraryId, migrated, details? }；损坏/读失败仍是 typed error（调用方决定
 * 是否吞掉——lib/migrate.js 的巡检按库 catch）。
 */
export function migrateLegacyLexiconStatuses(libraryId) {
  // 快速路径：索引已经知道有没有 legacy pending；没有就不进锁、不写盘。
  const index = lexiconIndex(libraryId)
  if (!index.pendingEntries.length) return { libraryId, migrated: 0 }
  const outcome = mutateLexicon(libraryId, (lex) => {
    const now = stamp()
    const details = []
    for (const [termId, entry] of Object.entries(lex.terms)) {
      if ((entry.status || 'active') !== 'pending') continue
      // trigger 的 sensitivity 缺省是 sensitive（§1.2）；legacy 数据可能没写这个字段。
      const sensitive = entry.sensitivity === 'sensitive'
        || (entry.kind === 'trigger' && entry.sensitivity !== 'normal')
      const next = entry.revisionOf || sensitive ? 'archived' : 'active'
      entry.status = next
      entry.migratedFromStatus = 'pending'
      entry.statusMigratedAt = now
      details.push({
        termId,
        status: next,
        reason: entry.revisionOf ? 'revision-draft' : sensitive ? 'sensitive' : 'proposal',
        ...(entry.revisionOf ? { revisionOf: entry.revisionOf } : {}),
      })
    }
    return { changed: details.length > 0, migrated: details.length, details }
  }, { onlyWhenChanged: true })
  return { libraryId, migrated: outcome.migrated, details: outcome.details }
}
