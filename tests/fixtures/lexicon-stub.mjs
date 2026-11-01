// 集成回归时移除：lib/lexicon.js 真身落地后，删除本文件、lexicon-stub-hooks.mjs 以及
// tests/lexicon-ui.test.mjs 顶部的 register 调用。
//
// 轻量替身：只覆盖 P3 消费的冻结签名与四条语义——非用户来源的普通词条直接 active、
// sensitive trigger 的模型/curator 提案 typed rejection、非用户改敏感字段 typed
// rejection、active/archived 生命周期（archive/restore）。不承诺与真核心一致的锁、
// CAS、原子写或容量上限；真实文件落在 dataDir()/lexicon/ 下，因此备份清单与 restore
// allowlist 测试仍然走真实磁盘。
import path from 'node:path'
import { dataDir, ensureDir, readJson, writeJson } from '../../lib/paths.js'

const KINDS = ['slang', 'meme', 'trigger', 'term']
// 公开生命周期（§2.1）：pending/rejected 只作为 legacy/墓碑数据存在，新写不产出。
const PUBLIC_STATUSES = ['active', 'archived']
const SENSITIVE_FIELDS = ['term', 'kind', 'sensitivity', 'context', 'meaning']
// 与设计 §1.2 同向的近似规范化：NFKC、大小写折叠、空白折叠、去标点/符号。
const normalizeLexeme = (value) => String(value ?? '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .replace(/[\p{P}\p{S}]+/gu, '')
  .trim()

const fileFor = (libraryId) => path.join(dataDir(), 'lexicon', `${libraryId}.json`)
const emptyStore = (libraryId) => ({ version: 1, revision: 0, libraryId, terms: {}, rejected: {} })

export function loadLexicon(libraryId) {
  const raw = readJson(fileFor(libraryId), null)
  if (!raw || typeof raw !== 'object' || raw.terms == null) return emptyStore(libraryId)
  return {
    version: 1,
    revision: Number(raw.revision) || 0,
    libraryId,
    terms: raw.terms && typeof raw.terms === 'object' ? raw.terms : {},
    rejected: raw.rejected && typeof raw.rejected === 'object' ? raw.rejected : {},
  }
}

function saveLexicon(store) {
  ensureDir(path.dirname(fileFor(store.libraryId)))
  writeJson(fileFor(store.libraryId), {
    version: store.version,
    revision: store.revision,
    libraryId: store.libraryId,
    terms: store.terms,
    rejected: store.rejected || {},
  })
}

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

// 与 lib/context.js 的 contextVisible 同语义的精简版：P3 只依赖"越界条目搜不到"。
function contextVisible(context, current) {
  if (!context) return true
  for (const key of ['channelId', 'characterId', 'worldId', 'branchId']) {
    if (context[key] && context[key] !== current?.[key]) return false
  }
  if (Array.isArray(context.knownBy) && context.knownBy.length && !context.knownBy.includes(current?.characterId)) return false
  return true
}

let seq = 0
const nextId = () => {
  seq += 1
  return `lex-stub-${String(seq).padStart(4, '0')}`
}

function sensitiveDelta(existing, next) {
  return SENSITIVE_FIELDS.filter((field) => {
    const before = field === 'context' ? JSON.stringify(existing.context || {}) : String(existing[field] ?? '')
    const after = field === 'context' ? JSON.stringify(next.context || {}) : String(next[field] ?? '')
    return before !== after
  })
}

/**
 * 写入/更新：与真核心同一套公开语义（§2.1）。created:false + notOwned:true 表示
 * 撞上了一条非用户来源不能动的词条（archived/rejected/legacy 修订草稿）。
 */
export function upsertLexiconTerm(options = {}) {
  const libraryId = String(options.libraryId || '')
  if (!libraryId) throw fail('LEXICON_LIBRARY_REQUIRED', 'libraryId is required')
  const term = String(options.term || '').trim()
  const kind = String(options.kind || 'term')
  const meaning = String(options.meaning || '').trim()
  if (!term) throw fail('LEXICON_TERM_REQUIRED', 'term is required')
  if (!meaning) throw fail('LEXICON_MEANING_REQUIRED', 'meaning is required')
  if (!KINDS.includes(kind)) throw fail('LEXICON_KIND_INVALID', `unknown lexicon kind: ${kind}`)
  const source = String(options.source || 'user')
  const isUser = source === 'user'
  // trigger 默认 sensitive（§1.2）。
  const sensitivity = kind === 'trigger' && options.sensitivity == null ? 'sensitive' : String(options.sensitivity || 'normal')
  // §2.1：非用户来源不能建 sensitive trigger —— typed rejection。
  if (!isUser && kind === 'trigger' && sensitivity === 'sensitive') {
    throw fail('LEXICON_SENSITIVE_FORBIDDEN', 'sensitive triggers are user-managed; model/curator proposals are rejected')
  }
  // pending/rejected 不可由新调用方设置：统一收口成 active（非用户来源也不可设 archived）。
  const requested = PUBLIC_STATUSES.includes(String(options.status)) ? String(options.status) : 'active'
  const wantedStatus = isUser ? requested : 'active'

  const store = loadLexicon(libraryId)
  const normalizedTerm = normalizeLexeme(term)
  const aliases = Array.isArray(options.aliases) ? options.aliases.map((a) => String(a)) : []
  const normalizedAliases = aliases.map(normalizeLexeme).filter(Boolean)
  const context = options.context && typeof options.context === 'object' ? { ...options.context } : {}
  const now = new Date().toISOString()
  // 冲突：同一规范词（term 或 alias）已存在时更新既有词条，不新建（§1.2 唯一性）。
  // 归档条目按 term 等值参与（includeArchived 口径）。
  let targetId = null
  for (const [id, e] of Object.entries(store.terms)) {
    const status = e?.status || 'active'
    const normalizedEntryTerm = normalizeLexeme(e?.term)
    if (status === 'archived') {
      if (normalizedEntryTerm === normalizedTerm) { targetId = id; break }
      continue
    }
    const keys = new Set([normalizedEntryTerm, ...(Array.isArray(e?.normalizedAliases) ? e.normalizedAliases : []).map((a) => String(a).toLowerCase())])
    if (keys.has(normalizedTerm) || normalizedAliases.some((a) => keys.has(a))) { targetId = id; break }
  }
  const created = targetId === null
  let revived = false
  if (!created) {
    const e = store.terms[targetId]
    const status = e.status || 'active'
    // archived / rejected / legacy 修订草稿：非用户来源不复活、不改写。
    const immutable = status === 'archived' || status === 'rejected' || (status === 'pending' && Boolean(e.revisionOf))
    if (immutable && !isUser) return { term: e, termId: targetId, created: false, notOwned: true }
    if (!isUser) {
      if (e.kind === 'trigger' && e.sensitivity === 'sensitive') {
        throw fail('LEXICON_SENSITIVE_FIELDS_FORBIDDEN', 'only the user manages sensitive triggers')
      }
      const changed = sensitiveDelta(e, { ...e, term, kind, sensitivity, context, meaning })
      if (changed.length) throw fail('LEXICON_SENSITIVE_FIELDS_FORBIDDEN', `non-user writes cannot change ${changed.join(', ')}`)
    }
    const revivedEntry = status !== 'active'
    e.term = term
    e.normalizedTerm = normalizedTerm
    e.kind = kind
    e.meaning = meaning
    if (options.usage != null) e.usage = String(options.usage)
    e.aliases = aliases
    e.normalizedAliases = normalizedAliases
    if (options.context !== undefined) e.context = context
    if (options.knownBy !== undefined) e.knownBy = Array.isArray(options.knownBy) ? options.knownBy.map(String) : []
    if (options.visibility != null) e.visibility = String(options.visibility)
    e.sensitivity = sensitivity
    if (typeof options.strength === 'number') e.strength = options.strength
    if (typeof options.confidence === 'number') e.confidence = options.confidence
    e.status = isUser ? wantedStatus : 'active'
    e.source = source
    if (options.evidence !== undefined) e.evidence = Array.isArray(options.evidence) ? options.evidence : []
    e.updatedAt = now
    revived = revivedEntry
    if (revivedEntry) {
      delete e.revisionOf
      delete e.previousRevision
      e.reviewedAt = now
      e.reviewedBy = source
      e.reviewReason = null
      if (status === 'rejected' && e.fingerprint) delete store.rejected[e.fingerprint]
    }
  } else {
    targetId = nextId()
    store.terms[targetId] = {
      term,
      normalizedTerm,
      kind,
      meaning,
      usage: options.usage == null ? '' : String(options.usage),
      examples: Array.isArray(options.examples) ? options.examples.map(String) : [],
      aliases,
      normalizedAliases,
      context,
      knownBy: Array.isArray(options.knownBy) ? options.knownBy.map(String) : [],
      visibility: String(options.visibility || 'shared'),
      sensitivity,
      strength: typeof options.strength === 'number' ? options.strength : 0.5,
      confidence: typeof options.confidence === 'number' ? options.confidence : null,
      status: wantedStatus,
      source,
      evidence: Array.isArray(options.evidence) ? options.evidence : [],
      sourceMemoryId: options.sourceMemoryId || null,
      createdAt: now,
      updatedAt: now,
      reviewedAt: null,
      reviewedBy: null,
      reviewReason: null,
      hitCounts: { candidate: 0, injection: 0, query: 0 },
      lastInjectedAt: null,
    }
  }
  store.revision += 1
  saveLexicon(store)
  return { term: store.terms[targetId], termId: targetId, created, ...(revived ? { revived: true } : {}) }
}

/** 归档（§2.1）：只有 active → archived；不写 rejected 墓碑。 */
export function archiveLexiconTerm({ libraryId, termId } = {}) {
  const store = loadLexicon(libraryId)
  const e = store.terms[termId]
  if (!e) throw fail('LEXICON_NOT_FOUND', 'unknown lexicon term')
  const status = e.status || 'active'
  if (status !== 'active') throw fail('LEXICON_INVALID_STATUS', `only active terms can be archived; ${termId} is ${status}`)
  e.status = 'archived'
  e.updatedAt = new Date().toISOString()
  store.revision += 1
  saveLexicon(store)
  return { term: e, termId, action: 'archive' }
}

/** 恢复（§2.1）：只有 archived → active；legacy 修订草稿拒绝独立恢复。 */
export function restoreLexiconTerm({ libraryId, termId } = {}) {
  const store = loadLexicon(libraryId)
  const e = store.terms[termId]
  if (!e) throw fail('LEXICON_NOT_FOUND', 'unknown lexicon term')
  const status = e.status || 'active'
  if (status !== 'archived') throw fail('LEXICON_INVALID_STATUS', `only archived terms can be restored; ${termId} is ${status}`)
  if (e.revisionOf && (store.terms[e.revisionOf]?.status || 'active') === 'active') {
    throw fail('LEXICON_REVISION_IMMUTABLE', 'a legacy revision draft cannot be restored on its own')
  }
  const normalizedTerm = normalizeLexeme(e.term)
  const aliases = Array.isArray(e.normalizedAliases) ? e.normalizedAliases : []
  for (const [id, other] of Object.entries(store.terms)) {
    if (id === termId) continue
    const otherStatus = other.status || 'active'
    if (otherStatus !== 'active' && otherStatus !== 'pending') continue
    const otherAliases = Array.isArray(other.normalizedAliases) ? other.normalizedAliases : []
    if (other.normalizedTerm === normalizedTerm || otherAliases.includes(normalizedTerm)
      || aliases.includes(other.normalizedTerm) || otherAliases.some((alias) => aliases.includes(alias))) {
      throw fail('LEXICON_ALIAS_CONFLICT', `restoring ${termId} would collide with ${id}`)
    }
  }
  e.status = 'active'
  e.updatedAt = new Date().toISOString()
  store.revision += 1
  saveLexicon(store)
  return { term: e, termId, action: 'restore' }
}

export function deleteLexiconTerm({ libraryId, termId } = {}) {
  const store = loadLexicon(libraryId)
  if (!store.terms[termId]) throw fail('LEXICON_TERM_NOT_FOUND', 'unknown lexicon term')
  delete store.terms[termId]
  store.revision += 1
  saveLexicon(store)
  return { termId, deleted: true }
}

export function searchLexicon(options = {}, opts = {}) {
  const libraryId = String(options.libraryId || '')
  const includeArchived = opts?.includeArchived === true || options.includeArchived === true
  const store = loadLexicon(libraryId)
  const query = normalizeLexeme(options.query)
  if (!query) return []
  const memoryContext = options.memoryContext || {}
  const hits = []
  for (const [termId, e] of Object.entries(store.terms)) {
    const status = e.status || 'active'
    if (status !== 'active' && !(includeArchived && status === 'archived')) continue
    if (!contextVisible(e.context, memoryContext)) continue
    const haystack = [normalizeLexeme(e.term), ...(Array.isArray(e.normalizedAliases) ? e.normalizedAliases : []).map(normalizeLexeme), normalizeLexeme(e.meaning)].filter(Boolean)
    if (!haystack.some((value) => value.includes(query) || query.includes(value))) continue
    hits.push({ id: termId, ...e, matchedBy: 'exact' })
    if (hits.length >= 8) break
  }
  return hits
}

/** 可见词条：active 默认；includeArchived 追加 archived（§2.1）。pending/rejected 永不返回。 */
export function visibleLexiconTerms(libraryId, memoryContext = {}, opts = {}) {
  const includeArchived = opts?.includeArchived === true
  const store = loadLexicon(libraryId)
  return Object.entries(store.terms)
    .filter(([, e]) => {
      const status = e.status || 'active'
      return status === 'active' || (includeArchived && status === 'archived')
    })
    .filter(([, e]) => contextVisible(e.context, memoryContext))
    .map(([id, e]) => ({ termId: id, id, ...e }))
}
