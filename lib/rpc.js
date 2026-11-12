import { ENGINE_VERSION, engineStatus, ensureEngine, switchEngineVersion, readInstallLogTail, fetchAvailableVersions, pruneEngineVersions, removeEngineVersion, engineVersionSizes } from './engine.js'
import {
  DEFAULT_SETTINGS, getSettings, updateSettings, loadState, listLibraries, listArchivedLibraries, getLibrary, createLibrary,
  renameLibrary, archiveLibrary, deleteLibrary, restoreLibrary, libraryScopeMissing, getSessionBinding, setSessionBinding, ensureSession,
  ensureLibraryForCwd, getMemoryBackend,
  deleteSessionBinding, releaseInjected, markReinjectPending, loadPrivateIndex, loadGlobalIndex, saveGlobalIndex, updatePrivateIndex, updateGlobalIndex,
  backupDatabases, listBackups, restoreBackup, deleteBackup, globalDbPath, normalizeCwd, getWorkspacePolicy, listWorkspacePolicies, setWorkspacePolicy,
  storageHealth, effectiveScope, summarizeIndex, getPromptDomains, addPromptDomain, removePromptDomain, memoryRevision, memoryStamp, noteMemoryBeat,
} from './state.js'
import { commit, closeMemuResident, prewarmMemuResident } from './memu.js'
import { privateList, privateUpdate, privateRemember, privateRecall, privateArchive, privateDelete, previewDelete, restoreDeleted, globalList, globalRecall, domainOf, decayStrength, appliesToDomain, importMemories, recordImportBatch, revertImportBatch, resolveMemoryReview, visibleToSession, isMemoryEligible } from './memory.js'
import { normalizeMemoryContext } from './context.js'
import { requestPrivateConsolidation } from './private.js'
import { listHostModelOptions, discoverForkModels, redactConsolidationSettings, disposeConsolidationRoute } from './fork-model.js'
import { startGlobalCuration, getCurationJob, cancelCurationJob, listCurationJobs, undoGlobalAbsorb } from './curator.js'
import { maybeMigrateLibraries } from './migrate.js'
import { getPromptStates, savePromptOverride, resetPrompt, resetAllPrompts } from './prompts.js'
import { statsView } from './stats.js'
import { recallCacheStats } from './recall-cache.js'
import { getMemuConfig, saveMemuConfig, setEmbeddingSource, testMemuConfig, getSummaryConfig, getVisionConfig } from './memu-config.js'
import { getLocalVectorState, downloadLocalVectorModel, installLocalVectorRuntime, selectLocalVectorModel, switchLocalVectorProfile, rollbackLocalVectorProfile, abortLocalVectorMigration, testLocalVector } from './local-vector-service.js'
import { webUiHtml, WEBUI_PATH, standaloneHtml, standaloneAsset, SETTINGS_PATH } from './webui.js'
import { getGraph, listEntities, createEntity, confirmEntities, renameEntity, deleteEntity, mergeEntities, suggestEntityMerges, linkEntries, unlinkEntry, purgeAutoLinks, getRelationship, updateRelationship, graphExport, restoreGraphData } from './graph.js'
import { generateAnchorCandidates, resetAnchorCandidatesCache } from './auto-link/candidates.js'
import { refreshPrivateAutoLinks } from './private-links.js'
import { refreshEntityMentions } from './auto-link/apply.js'
import { clearSuppression, suppressionSet } from './auto-link/suppression.js'
import { getAttachment, attachmentThumbnail, attachmentPreview, exportMediaBundle, importMediaBundle, streamMediaExport, importMediaStream } from './media.js'
import { listEvents, logStats, clearEvents } from './activity-log.js'
import { redactSecrets, warn } from './paths.js'
import { GLOBAL_LEXICON_ID } from './lexicon.js'
import { lexiconSearch, lexiconSources } from './lexicon-scope.js'

const ENDPOINT = '/dsh-memu-memory'

function bindingView(binding) {
  if (!binding) return null
  const { inbound, ...value } = binding
  return inbound ? { ...value, inbound: {
    clock: inbound.clock || 0, pendingCount: inbound.pending?.length || 0, retryAt: inbound.retryAt || null,
  } } : value
}

function execFor(sessionId) {
  const binding = getSessionBinding(sessionId)
  const library = binding?.libraryId ? getLibrary(binding.libraryId) : null
  return {
    agent: {
      session: {
        header: {
          id: sessionId,
          cwd: library?.scopeKey || '',
          agentPreset: null,
        },
      },
    },
  }
}

function requireSessionId(payload) {
  const id = payload?.sessionId
  if (typeof id !== 'string' || !id.trim()) throw new Error('sessionId is required')
  return id.trim()
}

// Browser-facing library routes are authorized at the HTTP boundary. Direct
// dispatch callers intentionally keep the historical API and do not pass an
// authorization context. A session id is only trusted when its existing host
// binding names the exact target library; requests without a session id must
// go through the host's standalone/transfer callback.
//
// The map is the complete audit of library-addressed endpoints (§10 P0): every
// entry's dispatch consumes `payload.libraryId` — or, for updateMemory and
// archiveMemory, falls back to the same persisted session binding that
// `routeLibraryId` resolves — so the target authorized here is exactly the
// target dispatch works on. Endpoints that are session- or host-scoped
// (getState, getSidebarState, initSession, setLibrary, setFolderPolicy, engine
// and settings management, …) are not library-addressed: their credential is
// the host's own requestRejection plus, for session-scoped reads, the session
// id the host itself provided.
const LIBRARY_ROUTE_OPERATIONS = new Map([
  ['renameLibrary', 'rename'], ['archiveLibrary', 'archive'], ['deleteLibrary', 'delete'], ['restoreLibrary', 'restore'],
  ['browseLibrary', 'read'], ['getMemory', 'read'], ['getStats', 'read'], ['addMemory', 'write'], ['updateMemory', 'write'],
  ['importMemories', 'import'], ['exportLibrary', 'export'], ['getAttachment', 'attachment.read'],
  ['browseWall', 'read'], ['getGraph', 'read'], ['listEntities', 'read'], ['createEntity', 'write'], ['renameEntity', 'write'],
  ['deleteEntity', 'write'], ['mergeEntities', 'write'], ['suggestEntityMerges', 'read'],
  // 自动关联的候选队列与实体确认同样按库鉴权：未登记的端点会被直接放行。
  ['getAnchorCandidates', 'read'], ['confirmEntities', 'write'], ['purgeAutoLinks', 'write'], ['clearLinkSuppression', 'write'],
  ['linkEntries', 'write'], ['unlinkEntry', 'write'], ['getRelationship', 'read'], ['updateRelationship', 'write'],
  ['listReviews', 'read'], ['resolveReview', 'write'], ['lexiconList', 'read'], ['lexiconSearch', 'read'], ['lexiconAdd', 'write'],
  ['lexiconUpdate', 'write'], ['lexiconDelete', 'write'], ['lexiconArchive', 'write'], ['lexiconRestore', 'write'],
  ['archiveMemory', 'archive'], ['deleteMemory', 'delete'],
])

function routeLibraryId(endpoint, payload) {
  const explicit = typeof payload?.libraryId === 'string' ? payload.libraryId.trim() : ''
  if (explicit) return explicit
  // These endpoints deliberately support session-scoped operation without an
  // explicit libraryId. Resolve the target only from the persisted binding.
  if (payload?.sessionId !== undefined) {
    if (typeof payload.sessionId !== 'string' || !payload.sessionId.trim()) return null
    return getSessionBinding(payload.sessionId.trim())?.libraryId || null
  }
  return null
}

let capabilityAbsentWarned = false

// Everything that leaves this file as an error string goes through here.
//
// The RPC boundary is the one place a message reaches a renderer, a log file and a
// bug report at once, and the errors that flow through it are not all ours: a
// provider SDK quotes the request URL and sometimes the Authorization header, a
// Python traceback can echo a connection string, and a config error can print the
// key it choked on. `memu.js` already redacts per command line; this is the same rule
// applied once at the exit, so no single forgotten path can leak. The length cap
// keeps a wall of traceback out of the UI as well.
const RPC_ERROR_MAX_CHARS = 600
function rpcErrorMessage(error) {
  const raw = String(error?.message || error || 'unknown error')
  try { return redactSecrets(raw).slice(0, RPC_ERROR_MAX_CHARS) } catch { return raw.slice(0, RPC_ERROR_MAX_CHARS) }
}

// One capability gate for both routes: absent callback falls back to the HTTP
// boundary (requestRejection) and warns once; a present callback is strict true.
// Keeping one helper makes the session-first / capability-second order identical
// in the global queue and the library routes.
async function authorizeWithCapability(connection, req, { libraryId, operation, label }) {
  if (typeof connection?.authorizeLibrary !== 'function') {
    if (!capabilityAbsentWarned) {
      capabilityAbsentWarned = true
      try { warn(`dsh-memu-memory: host does not implement connection.authorizeLibrary; ${label} falls back to the HTTP boundary (requestRejection)`) } catch {}
    }
    return true
  }
  try {
    return (await connection.authorizeLibrary(req, { libraryId, operation })) === true
  } catch {
    return false
  }
}

// Global review queue (listReviews/resolveReview without an explicit libraryId)
// has no private-library target, so it cannot be authorized as a library route.
// Embedded requests keep the session-level semantics: the queue is visible to
// conversations, and a write (resolveReview) additionally demands the session
// exists and is still bound. In both scopes a session id is only a credential
// while its persisted binding names a library — an empty or dangling id is
// never one. Standalone requests are the management plane and fail closed on
// the host's `review.manage` grant: a missing callback (current host) falls back
// to the HTTP boundary, while a present callback must return strict true.
async function authorizeGlobalReviewRoute(connection, req, endpoint, payload) {
  if (payload?.sessionId !== undefined) {
    if (typeof payload.sessionId !== 'string' || !payload.sessionId.trim()) return false
    return Boolean(getSessionBinding(payload.sessionId.trim())?.libraryId)
  }
  return authorizeWithCapability(connection, req, { libraryId: null, operation: 'review.manage', label: 'global review queue' })
}

// The global lexicon (lib/lexicon.js GLOBAL_LEXICON_ID) is one shared store, not a
// library: like listGlobal and removeGlobalLink it is governed by the plugin's own
// HTTP boundary, so a standalone request never consults authorizeLibrary. A session
// id is still a credential — the conversation must exist, and the folder/session
// ceiling must still let it see the global layer, or there is no global lexicon to
// read or write from that conversation.
async function authorizeGlobalLexiconRoute(connection, req, endpoint, payload) {
  if (payload?.sessionId === undefined) return true
  if (typeof payload.sessionId !== 'string' || !payload.sessionId.trim()) return false
  const binding = getSessionBinding(payload.sessionId.trim())
  if (!binding) return false
  return effectiveScope(binding).useGlobal !== false
}

async function authorizeLibraryRoute(connection, req, endpoint, payload, libraryId = routeLibraryId(endpoint, payload)) {
  // Review endpoints are dual-scope: without an explicit libraryId they address
  // the global curator queue, which follows its own management model.
  if ((endpoint === 'listReviews' || endpoint === 'resolveReview') && !String(payload?.libraryId || '').trim()) {
    return authorizeGlobalReviewRoute(connection, req, endpoint, payload)
  }
  // The global lexicon is a reserved store name, not a private library: the host
  // must never be asked to authorize a library that does not exist, and a bound
  // session must not be denied for naming it instead of its own library.
  if (libraryId === GLOBAL_LEXICON_ID) return authorizeGlobalLexiconRoute(connection, req, endpoint, payload)
  if (!LIBRARY_ROUTE_OPERATIONS.has(endpoint)) return true
  // Session-bound requests are checked first: a valid binding must name the exact
  // target library, and a present-but-unresolvable session is a bad credential
  // (never a reason to fall back to the host callback). Without a session, the
  // capability decides — including the explicit no-library aggregate read.
  if (payload?.sessionId !== undefined) {
    if (typeof payload.sessionId !== 'string' || !payload.sessionId.trim()) return false
    if (!libraryId) return false
    const binding = getSessionBinding(payload.sessionId.trim())
    return Boolean(binding?.libraryId && binding.libraryId === libraryId)
  }
  return authorizeWithCapability(connection, req, {
    libraryId,
    operation: LIBRARY_ROUTE_OPERATIONS.get(endpoint),
    label: 'library-level authorization',
  })
}

function rejectLibraryRoute(res) {
  if (res.headersSent) return
  // JSON 信封而非裸文本：standalone fetch 客户端会 response.json()，裸 "forbidden"
  // 抛 SyntaxError（Unexpected token），用户只看到白屏而不是可读错误。
  res.writeHead(403, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: { code: 'dsh-memu-memory/forbidden', message: 'forbidden', details: {} } }))
}

// 词典核心（lib/lexicon.js）按需加载：路由注册与既有 86 个
// case 不能被一个尚未落地的模块卡死，集成落地后这里可以改回静态 import。
let lexiconModulePromise = null
function lexiconApi() {
  if (!lexiconModulePromise) {
    lexiconModulePromise = import('./lexicon.js').catch((error) => {
      lexiconModulePromise = null
      throw error
    })
  }
  return lexiconModulePromise
}

// 全局图（lib/global-graph.js，F1 包）：resolveReview 的 unlink 动作按需加载。
// 与词典核心同样的按需模式——F1 未落地时路由注册不被卡死，unlink 返回可读错误。
let globalGraphModulePromise = null
function globalGraphApi() {
  if (!globalGraphModulePromise) {
    globalGraphModulePromise = import('./global-graph.js').then((mod) => {
      if (typeof mod.removeGlobalLink !== 'function') throw new Error('removeGlobalLink not exported yet')
      if (typeof mod.getGlobalGraph !== 'function') throw new Error('getGlobalGraph not exported yet')
      return mod
    }).catch((error) => {
      globalGraphModulePromise = null
      throw error
    })
  }
  return globalGraphModulePromise
}

// 词典 RPC 的库映射（§4.1）：显式 libraryId 必须是已存在的库——不信任客户端任意
// id——否则回落到会话绑定，与 case 'listReviews' 的入口模式一致。
// 全局词典是个保留存储名（lib/lexicon.js GLOBAL_LEXICON_ID），不是私有库，所以它
// 绕开 getLibrary 校验；带 sessionId 也不按会话的 useGlobal 收窄——那是注入的天花板，
// 不是用户维护共享词典的天花板。
function lexiconLibraryId(payload) {
  const id = String(payload?.libraryId || '').trim()
  if (id === GLOBAL_LEXICON_ID) return GLOBAL_LEXICON_ID
  if (id) {
    if (!getLibrary(id)) throw new Error('library not found')
    if (payload?.sessionId !== undefined) {
      const sessionId = requireSessionId(payload)
      const binding = getSessionBinding(sessionId)
      if (binding?.libraryId !== id) throw new Error('session is not authorized for this memory library')
    }
    return id
  }
  const binding = getSessionBinding(requireSessionId(payload))
  if (!binding?.libraryId || !getLibrary(binding.libraryId)) throw new Error('session is not bound to a memory library')
  return binding.libraryId
}

function lexiconTermView(e) {
  return {
    id: e.id,
    term: e.term,
    kind: e.kind || 'term',
    meaning: String(e.meaning || '').slice(0, 2000),
    usage: String(e.usage || '').slice(0, 800),
    aliases: Array.isArray(e.aliases) ? e.aliases.slice(0, 20) : [],
    examples: Array.isArray(e.examples) ? e.examples.slice(0, 8) : [],
    context: e.context || {},
    knownBy: Array.isArray(e.knownBy) ? e.knownBy : [],
    visibility: e.visibility || 'shared',
    sensitivity: e.sensitivity || 'normal',
    strength: typeof e.strength === 'number' ? e.strength : null,
    confidence: typeof e.confidence === 'number' ? e.confidence : null,
    status: e.status || 'active',
    source: e.source || 'user',
    evidence: Array.isArray(e.evidence) ? e.evidence.slice(0, 6) : [],
    sourceMemoryId: e.sourceMemoryId || null,
    hitCounts: e.hitCounts && typeof e.hitCounts === 'object' ? e.hitCounts : { candidate: 0, injection: 0, query: 0 },
    lastInjectedAt: e.lastInjectedAt || null,
    createdAt: e.createdAt || null,
    updatedAt: e.updatedAt || null,
    reviewedAt: e.reviewedAt || null,
    reviewedBy: e.reviewedBy || null,
  }
}

// 导入合并（§4.4）。冲突判定用核心层自己的 normalizeLexeme（与存储同源，零漂移）：
// 先在本侧把包内词面对到既有词条，active 且 sensitive 的既有词条永不覆盖——跳过并
// 在结果里报告 skipped。导入以用户来源写入，所以其余词条直接应用字段（§2.1 起不再
// 产生 pending revision）；真正需要守的是墓碑：rejected 是内部防重放墓碑，导入既不
// 恢复背包里的 rejected 行，也不复活库里已有的 rejected 词条。legacy pending 按启动
// 迁移的同一口径收口（新提案 → active、敏感 → archived、revision 草稿 → archived）。
const LEXICON_KINDS = ['slang', 'meme', 'trigger', 'term']
// 导入包里可能出现的状态：pending/rejected 是 legacy/墓碑，只用于识别并按下面的口径
// 收口；公开生命周期只有 active / archived。
const LEXICON_STATUSES = ['pending', 'active', 'rejected', 'archived']
const LEXICON_PUBLIC_STATUSES = ['active', 'archived']
// 字段长度策略与核心 lib/lexicon.js 的直接写入完全统一（§10 P2：同一把尺）：
// meaning/usage/aliases/examples 超长一律按核心的 clip 落地，导入分支不再做自己的
// 长度拒绝；唯一例外是 term 本身——term 是唯一键，截断会破坏唯一性，所以超长或
// 规范化后为空的 term 由核心 upsert 抛 typed error（LEXICON_INVALID_TERM），该条
// 进 failed。

async function mergeLexiconImport(libraryId, member) {
  if (!member || typeof member !== 'object' || Array.isArray(member)) throw new Error('lexicon member must be an object')
  if (!Array.isArray(member.terms)) throw new Error('lexicon member has no "terms" array')
  if (member.terms.length > 5000) throw new Error('lexicon member has too many terms')
  const lexicon = await lexiconApi()
  const normalize = typeof lexicon.normalizeLexeme === 'function' ? lexicon.normalizeLexeme : (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  const data = lexicon.loadLexicon(libraryId)
  const byKey = new Map()
  for (const [termId, e] of Object.entries(data.terms || {})) {
    for (const key of [...new Set([String(e?.normalizedTerm || ''), ...((Array.isArray(e?.normalizedAliases) ? e.normalizedAliases : []).map((a) => String(a)))])].filter(Boolean)) {
      if (!byKey.has(key)) byKey.set(key, { termId, entry: e })
    }
  }
  // `addedTermIds` is what makes the import reversible: a term created by this package
  // has no memory id to find it by later, and an updated one must not be deleted on
  // revert (it existed before). Only creations are recorded.
  const report = { version: 1, applied: 0, added: 0, updated: 0, revisions: 0, addedTermIds: [], skipped: [], failed: [] }
  for (const raw of member.terms) {
    const label = typeof raw?.term === 'string' ? raw.term : ''
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('term entry must be an object')
      const term = String(raw.term || '').trim()
      const meaning = String(raw.meaning || '').trim()
      if (!term) throw new Error('term is required')
      if (!meaning) throw new Error('meaning is required')
      // 长度不再在本侧拒绝：clip 与 reject 都以核心 upsert 的策略为准（见上方注释）。
      // term 超长/规范化为空由 upsert 抛 LEXICON_INVALID_TERM，整条进 failed。
      const kind = raw.kind == null || raw.kind === '' ? 'term' : String(raw.kind)
      if (!LEXICON_KINDS.includes(kind)) throw new Error(`unknown lexicon kind: ${kind}`)
      const aliases = raw.aliases == null ? undefined : raw.aliases
      const examples = raw.examples == null ? undefined : raw.examples
      const keys = [...new Set([String(raw.normalizedTerm || ''), normalize(term), ...((Array.isArray(raw.aliases) ? raw.aliases : []).map(normalize))])].filter(Boolean)
      const target = keys.map((key) => byKey.get(key)).find(Boolean) || null
      const status = raw.status == null || raw.status === '' ? 'active' : String(raw.status)
      if (!LEXICON_STATUSES.includes(status)) throw new Error(`unknown lexicon status: ${status}`)
      // 墓碑（§2.1）：rejected 是内部防重放墓碑，导入是恢复路径也不能把它洗回生命周期；
      // 库里已有同词墓碑时同样跳过——用户来源的 upsert 会复活它并清掉拒绝指纹。
      if (status === 'rejected') {
        report.skipped.push({ term: label || term, reason: 'rejected terms are internal tombstones and are not restored by import' })
        continue
      }
      const targetStatus = target ? (target.entry?.status || 'active') : null
      if (targetStatus === 'rejected') {
        report.skipped.push({ term: label || term, termId: target.termId, reason: 'a rejected tombstone is never resurrected by import' })
        continue
      }
      if (targetStatus === 'active' && target.entry?.sensitivity === 'sensitive') {
        report.skipped.push({ term: label || term, termId: target.termId, reason: 'an active sensitive term is never overwritten by import' })
        continue
      }
      // legacy pending 与 migrateLegacyLexiconStatuses 同一口径（§2.1）：新提案 → active
      // （敏感 → archived），revision 草稿 → archived。新写只有公开两态。
      const sensitive = raw.sensitivity === 'sensitive' || (kind === 'trigger' && raw.sensitivity !== 'normal')
      const effectiveStatus = status === 'pending' ? (raw.revisionOf || sensitive ? 'archived' : 'active') : status
      // 收口成 archived 的 legacy 行如果撞上同词的 active 正条，user upsert 会把正条改写
      // 并归档（撞线语义）——迁移会保留正条，这里也跳过草稿，不让它覆盖正条。
      if (status === 'pending' && effectiveStatus === 'archived' && targetStatus === 'active') {
        report.skipped.push({ term: label || term, termId: target.termId, reason: 'legacy pending draft skipped: its active target must not be overwritten by import' })
        continue
      }
      const out = await lexicon.upsertLexiconTerm({
        libraryId,
        term,
        kind,
        meaning,
        usage: raw.usage ?? undefined,
        aliases,
        examples,
        context: raw.context ?? undefined,
        knownBy: raw.knownBy ?? undefined,
        visibility: raw.visibility ?? undefined,
        sensitivity: raw.sensitivity ?? undefined,
        confidence: raw.confidence ?? undefined,
        evidence: raw.evidence ?? undefined,
        source: 'user',
        status: effectiveStatus,
      })
      report.applied += 1
      if (out?.created === false) report.updated += 1
      else {
        report.added += 1
        const termId = out?.term?.id || out?.term?.termId || null
        if (termId) report.addedTermIds.push(String(termId))
      }
      // revisions 在当前生命周期恒为 0（§2.1 不再生成 pending revision）；字段保留只为报告
      // 形状稳定，旧客户端继续拿到一个数字。
    } catch (error) {
      report.failed.push({ term: label, reason: rpcErrorMessage(error).slice(0, 300) })
    }
  }
  return report
}

// List one library's memories. Retrieval needs the MemU engine, but the sidecar
// index holds the same rows, so an engine that is still installing (or broken)
// degrades to the index instead of failing the browser.
async function privateListView(scope, { limit = null, previewChars = 4000 } = {}) {
  const libraryId = scope.libraryId ?? getSessionBinding(scope.exec ? scope.exec?.agent?.session?.header?.id : null)?.libraryId
  const contentLimit = Math.max(40, Math.min(4000, Number(previewChars) || 4000))
  const itemLimit = Number.isInteger(limit) && limit > 0 ? Math.min(500, limit) : null
  const shape = (fileLibraryId, id, e, content, libraryName = null) => ({
    id,
    libraryId: fileLibraryId,
    ...(libraryName ? { libraryName } : {}),
    title: e?.title || '',
    layer: e?.layer || 'long_term',
    status: e?.status || 'active',
    marginalized: e?.marginalized === true,
    openLoop: e?.openLoop === true,
    // Tone and provenance, not content. The browser needs them to explain why a
    // memory reads the way it does once it is injected.
    disclosure: e?.disclosure || 'can_tell',
    owner: e?.owner || 'me',
    visibility: e?.visibility || 'shared',
    // Where the memory came from: user_said / inferred / imagined / told. The
    // browser shows it as a tag so a mislabelled quote stops being invisible.
    source: e?.source || 'inferred',
    expiresAt: e?.expiresAt || null,
    tags: Array.isArray(e?.tags) ? e.tags : [],
    confidence: e?.confidence ?? null,
    // Vividness vs accuracy (appendix B-13): shown side by side so a confidently
    // remembered but probably-off entry is visible as such.
    accuracy: e?.accuracy ?? null,
    strength: e?.strength ?? null,
    // 0..1 of the live recall strength, so the UI can draw a decay bar without
    // re-implementing the half-life math.
    decay: Math.min(1, Math.max(0, decayStrength(e) / 1.5)),
    moodValence: e?.moodValence ?? null,
    arousal: e?.arousal ?? null,
    // 构成与掌控感分开投影：同一个 valence 说得出"多难过"，说不出"是怒还是怕"。
    emotion: e?.emotion ?? null,
    dominance: e?.dominance ?? null,
    // 来源是审计字段，只读：面板显示"这个情绪是谁给的"，不给改。
    emotionSource: e?.emotionSource ?? null,
    peak: e?.peak === true,
    salientDate: e?.salientDate || null,
    attachments: attachmentPreview(fileLibraryId, e || {}),
    context: e?.context || {},
    accessCount: e?.accessCount ?? 0,
    lastAccessAt: e?.lastAccessAt || null,
    createdAt: e?.createdAt || null,
    updatedAt: e?.updatedAt || e?.createdAt || null,
    content: String(content ?? e?.content ?? '').slice(0, contentLimit),
  })
  try {
    const result = await privateList({ ...scope, preferIndex: true })
    const files = (result.files || []).map((f) => shape(f.libraryId || libraryId, f.name, f.entry, f.content, f.libraryName))
    return {
      libraryId: result.libraryId,
      ...(result.libraries ? { libraries: result.libraries } : {}),
      source: result.source || 'engine',
      files: itemLimit ? files.slice(0, itemLimit) : files,
    }
  } catch (error) {
    if (error?.code !== 'MEMU_ENGINE_NOT_READY') throw error
    const index = loadPrivateIndex(libraryId)
    return {
      libraryId,
      source: 'index',
      files: Object.entries(index.entries || {}).filter(([, entry]) => !scope.exec || (isMemoryEligible(entry) && visibleToSession(entry, scope.exec?.agent?.session?.header?.id))).map(([id, e]) => shape(libraryId, id, e)),
    }
  }
}

function promptMeta(states) {
  return states.map((s) => ({
    key: s.key,
    baseKey: s.baseKey,
    domain: s.domain,
    scope: s.scope,
    inheritedFrom: s.inheritedFrom,
    title: s.title,
    description: s.description,
    variables: s.variables,
    source: s.source,
    defaultUpdated: s.defaultUpdated === true,
    updatedAt: s.updatedAt,
  }))
}

function engineView() {
  const status = engineStatus()
  return {
    status: status.status,
    recommendedVersion: ENGINE_VERSION,
    installed: Boolean(status.current),
    currentVersion: status.current?.version || null,
    currentInstalledAt: status.current?.installedAt || null,
    currentMirror: status.current?.mirror || null,
    python: status.current?.python || null,
    commands: status.current?.commands || [],
    versions: status.versions || [],
    log: status.log,
    updateWarning: '只安装插件声明的推荐版本。直接升级到未经验证的最新版可能导致 CLI 变化、JSON 形状变化或检索失败。',
    state: {
      step: status.state?.step || null,
      error: status.state?.error || null,
      startedAt: status.state?.startedAt || null,
      finishedAt: status.state?.finishedAt || null,
      updatedAt: status.state?.updatedAt || null,
    },
    // Only read the log when it can matter; a ready engine would pay for a file
    // read on every settings load for nothing.
    logTail: status.status === 'installing' || status.status === 'error'
      ? readInstallLogTail(12)
      : [],
  }
}

function libraryStats(lib, state = loadState()) {
  const index = loadPrivateIndex(lib.id)
  const entries = Object.values(index.entries || {})
  const active = entries.filter(e => isMemoryEligible(e))
  const pinned = active.filter((e) => e.layer === 'must_remember').length
  // Old auto-created libraries still carry the placeholder name. Their folder is
  // the real identity, so the list and every library picker show the leaf name.
  const storedName = String(lib.name || '').trim()
  const placeholder = !storedName || storedName === 'Default' || storedName === '__default__'
  const scopeLeaf = String(lib.scopeKey || '').split(/[\\/]/).filter(Boolean).pop() || ''
  return {
    ...lib,
    name: placeholder && lib.scopeKey !== '__default__' ? (scopeLeaf || storedName || 'Default') : storedName,
    privateCount: active.length,
    pinnedCount: pinned,
    cleanupDue: lib.archived === true && Number(state.settings?.purgeArchivedAfterDays) > 0 && Date.now() - Date.parse(lib.archivedAt || '') >= Number(state.settings.purgeArchivedAfterDays) * 86_400_000,
    boundSessions: Object.entries(state.sessions || {}).filter(([, b]) => b.libraryId === lib.id).length,
    // Surfaced so the UI can say why a library was auto-archived, and so a folder
    // that comes back is visibly different from one that is really gone.
    scopeMissing: libraryScopeMissing(lib),
  }
}

function libraryView() {
  // One state read for the whole list: with many libraries the per-item read
  // dominated settings load time.
  const state = loadState()
  return listLibraries().map((lib) => libraryStats(lib, state))
}

function archivedLibraryView() {
  const state = loadState()
  return listArchivedLibraries().map((lib) => libraryStats(lib, state))
}

// The settings page lists folders, not libraries: a folder can exist in DSH before
// the user has ever agreed to keep memory for it, and its two switches must be
// visible either way. Registry order wins (it matches the sidebar); libraries whose
// folder left DSH are appended so their policy stays reachable.
function folderView(ctx) {
  const state = loadState()
  const policies = new Map(listWorkspacePolicies().map((p) => [p.scopeKey, p]))
  const byScope = new Map()
  for (const [id, lib] of Object.entries(state.libraries || {})) {
    if (lib.archived === true) continue
    if (!byScope.has(lib.scopeKey)) byScope.set(lib.scopeKey, { id, ...lib })
  }
  let workspaces = []
  try {
    const registry = ctx.get?.('workspaceRegistry')
    if (registry && typeof registry.list === 'function') workspaces = registry.list() || []
  } catch {}
  const items = []
  const seen = new Set()
  const push = ({ id = null, path = '', title = '', registered = false }) => {
    const scopeKey = normalizeCwd(path) || '__default__'
    if (seen.has(scopeKey)) return
    seen.add(scopeKey)
    const library = byScope.get(scopeKey) || null
    const policy = policies.get(scopeKey) || {}
    items.push({
      id,
      path,
      title: title || path.split(/[\\/]/).filter(Boolean).pop() || path || scopeKey,
      scopeKey,
      registered,
      libraryId: library?.id || null,
      privateCount: library ? summarizeIndex(loadPrivateIndex(library.id)).active : 0,
      useLibrary: policy.useLibrary !== false,
      useGlobal: policy.useGlobal !== false,
    })
  }
  for (const ws of workspaces) {
    push({ id: ws?.id || null, path: ws?.path || '', title: ws?.title || ws?.name || '', registered: true })
  }
  for (const lib of byScope.values()) {
    if (seen.has(lib.scopeKey)) continue
    push({ path: lib.scopeKey === '__default__' ? '' : lib.scopeKey, title: lib.name, registered: false })
  }
  return { folders: items, hasRegistry: workspaces.length > 0 }
}

async function readSessionTitles(sessionQuery, ids) {
  const titles = new Map()
  if (!Array.isArray(ids) || ids.length === 0) return titles
  try {
    if (typeof sessionQuery?.readTitleSnapshots === 'function') {
      // One result per requested id: `{ sessionId, status, value: { session, title? } }`.
      for (const r of await sessionQuery.readTitleSnapshots(ids) || []) {
        if (r?.status !== 'fulfilled' || !r.sessionId) continue
        const title = r.value?.title?.title || r.value?.session?.title
        if (title && String(title).trim()) titles.set(r.sessionId, String(title).trim())
      }
    }
  } catch {}
  return titles
}

// 日志行原本只有 sessionId/libraryId 裸 id：日志页和侧边栏提醒要回答"这是哪个对话、
// 哪个文件夹"，得在服务端把标题与库名拼上。标题走宿主 readTitleSnapshots（批量一次），
// 查不到的行保留 null，客户端回退到短 id。
async function decorateLogRows(ctx, rows) {
  const ids = [...new Set(rows.map(row => row?.sessionId).filter(Boolean))]
  const titles = await readSessionTitles(ctx?.get?.('sessionQuery'), ids)
  return rows.map(row => ({
    ...row,
    sessionTitle: row?.sessionId ? (titles.get(row.sessionId) || null) : null,
    libraryName: row?.libraryId ? (getLibrary(row.libraryId)?.name || null) : null,
  }))
}

// 侧边栏"整理提醒"的数据源：跨会话（不按当前对话过滤），失败/成功两列分开，
// 每列只取最新 limit 条。失败的行带会话标题与库名，客户端用它挂跳转按钮。
async function consolidationFeed(ctx, payload = {}) {
  const perColumn = Math.max(1, Math.min(20, Number(payload?.limit) || 6))
  const rows = await decorateLogRows(ctx, listEvents({ kind: 'consolidate', limit: 80 }))
  const slim = ({ detail, ...row }) => ({
    ...row,
    reasonCode: detail?.reasonCode || detail?.code || null,
    timedOut: detail?.timedOut === true,
    count: detail?.count ?? null,
    force: detail?.force === true,
  })
  return {
    failures: rows.filter(row => row.ok === false).slice(0, perColumn).map(slim),
    successes: rows.filter(row => row.ok !== false).slice(0, perColumn).map(slim),
  }
}

// The host's session corpus is the authority for "this conversation still
// exists". A binding in state.json is deliberately kept after a conversation is
// deleted so its memory library survives; it must not keep the dead row visible.
async function sessionCatalog(ctx) {
  const sessionQuery = ctx.get?.('sessionQuery')
  if (!sessionQuery?.listSessions) return null
  try {
    const records = (await sessionQuery.listSessions() || [])
      .filter((r) => r?.header?.origin !== 'subagent')
    // `listSessions()` also returns conversations the user archived or whose
    // workspace was removed from DSH: the session log survives both. The global
    // curation picker must apply the same visibility rules as the folder sidebar,
    // otherwise a deleted conversation stays selectable for extraction forever.
    let archived = new Set()
    let members = null
    try {
      const registry = ctx.get?.('workspaceRegistry')
      archived = new Set((registry?.archivedSessionIds || []).map(String))
      const union = new Set()
      for (const workspace of registry?.list?.() || []) {
        for (const id of workspace?.sessionIds || []) union.add(String(id))
      }
      // An empty registry means "no membership information", not "hide everything".
      if (union.size > 0) members = union
    } catch {}
    return {
      sessionQuery,
      byId: new Map(records.map((r) => [r.header.id, r])),
      archived,
      members,
    }
  } catch {
    return null
  }
}

async function recentSessions(ctx, limitHint) {
  const catalog = await sessionCatalog(ctx)
  if (!catalog) return []
  const limit = Math.max(1, Math.min(200, Number(limitHint) || 60))
  const filtered = [...catalog.byId.values()]
    .filter((r) => {
      const id = String(r.header.id)
      if (catalog.archived.has(id)) return false
      if (catalog.members && !catalog.members.has(id)) return false
      return true
    })
    .slice(0, limit)
  const titles = await readSessionTitles(catalog.sessionQuery, filtered.map((r) => r.header.id))
  return filtered.map((r) => ({
    id: r.header.id,
    title: titles.get(r.header.id) || r.header.title || '',
    cwd: r.header.cwd || '',
    createdAt: r.header.createdAt || null,
    agentPreset: r.header.agentPreset || '',
    origin: r.header.origin || null,
    live: r.live === true,
    persisted: r.persisted === true,
  }))
}

async function dispatch(ctx, endpoint, payload = {}) {
  switch (endpoint) {
    case 'getState': {
      const sessionId = payload?.sessionId || null
      const binding = sessionId ? getSessionBinding(sessionId) : null
      const privateIndex = binding?.libraryId ? loadPrivateIndex(binding.libraryId) : { entries: {} }
      const globalIndex = loadGlobalIndex()
      const privateEntries = Object.values(privateIndex.entries || {})
      const globalEntries = Object.values(globalIndex.entries || {})
      return {
        engine: engineView(),
        memuConfig: getMemuConfig(),
        summaryConfig: getSummaryConfig(),
        settings: redactConsolidationSettings(getSettings()),
        libraries: libraryView(),
        archivedLibraries: archivedLibraryView(),
        binding: bindingView(binding),
        domain: binding ? domainOf(binding) : 'general',
        folder: binding?.scopeKey ? getWorkspacePolicy(binding.scopeKey) : null,
        effective: binding ? effectiveScope(binding) : null,
        privateCount: privateEntries.filter((e) => e.status !== 'archived' && e.status !== 'suppressed').length,
        pinnedCount: privateEntries.filter((e) => e.layer === 'must_remember' && e.status !== 'archived').length,
        globalCount: globalEntries.filter((e) => (e.status || 'active') === 'active').length,
        jobs: listCurationJobs().slice(-10),
        recallCache: recallCacheStats(),
      }
    }
    case 'diagnoseSession': {
      // Read-only by design: it must not bind, create a library, or repair
      // anything. Poisoned v4 rows already on disk cannot be fixed from here.
      const sessionId = String(payload?.sessionId || '')
      if (!sessionId) throw new Error('diagnoseSession requires a sessionId')
      const binding = getSessionBinding(sessionId)
      const privateIndex = binding?.libraryId ? loadPrivateIndex(binding.libraryId) : { entries: {} }
      const entries = Object.values(privateIndex.entries || {})
      const health = storageHealth()
      const policy = binding?.scopeKey ? getWorkspacePolicy(binding.scopeKey) : null
      const effective = {
        useLibrary: policy ? policy.useLibrary && binding?.useLibrary !== false : binding?.useLibrary !== false,
        useGlobal: policy ? policy.useGlobal && binding?.useGlobal !== false : binding?.useGlobal !== false,
      }
      return {
        sessionId,
        bound: Boolean(binding),
        libraryId: binding?.libraryId || null,
        libraryName: binding?.libraryId ? getLibrary(binding.libraryId)?.name || null : null,
        domain: binding ? domainOf(binding) : 'general',
        scopeKey: binding?.scopeKey || null,
        folderPolicy: policy,
        sessionSwitches: { useLibrary: binding?.useLibrary !== false, useGlobal: binding?.useGlobal !== false },
        effective,
        counts: {
          active: entries.filter((e) => e.status !== 'archived' && e.status !== 'suppressed').length,
          pinned: entries.filter((e) => e.layer === 'must_remember' && e.status !== 'archived').length,
          marginalized: entries.filter((e) => e.marginalized === true).length,
          openLoop: entries.filter((e) => e.openLoop === true && e.status !== 'archived').length,
          archived: entries.filter((e) => e.status === 'archived').length,
        },
        injection: {
          lastTurnAt: binding?.lastTurnAt || null,
          injectedIds: (binding?.injectedIds || []).length,
          injectedAt: Object.keys(binding?.injectedAt || {}).length,
          reinjectPending: binding?.reinjectPending === true,
          lastRecallError: binding?.lastRecallError || null,
          lastRecallErrorAt: binding?.lastRecallErrorAt || null,
        },
        storage: health,
        prompts: promptMeta(getPromptStates()),
      }
    }
    case 'getSidebarState': {
      // The sidebar's first screen in one round trip. It used to be four calls
      // (state + both full-text lists + sessions) and shipped every memory body;
      // previews are capped here and the browser page fetches full text on demand.
      const sessionId = payload?.sessionId || null
      // Heartbeat for every open pane. A pane paints a snapshot and has no way to
      // hear about a write made by a tool call, a curator job, or another window,
      // so it polls this marker and refetches only when it moves. The marker is
      // plugin-wide, not per conversation: the settings page and the standalone
      // WebUI poll it too and neither owns a session. The answer stays tiny — one
      // counter plus one file fingerprint, no entries and no index parsed.
      // `stamp` is the cross-process half: the counter only moves in the process
      // that did the write, the fingerprint moves on disk for everyone.
      if (payload?.revisionOnly === true) {
        noteMemoryBeat()
        return { revision: memoryRevision(), stamp: memoryStamp() }
      }
      if (!sessionId) throw new Error('getSidebarState requires a sessionId')
      // An older version could still be on disk (the user upgraded without restarting).
      // Reads are already correct — `loadPrivateIndex` normalizes the removed `session`
      // level — but opening the sidebar is a good moment to persist the conversion so the
      // files stop disagreeing with what is displayed. Throttled, no-op when clean.
      maybeMigrateLibraries()
      const binding = getSessionBinding(sessionId)
      const folder = binding?.scopeKey ? getWorkspacePolicy(binding.scopeKey) : null
      const effective = binding ? effectiveScope(binding, folder) : null
      const privateIndex = binding?.libraryId ? loadPrivateIndex(binding.libraryId) : { entries: {} }
      const globalIndex = loadGlobalIndex()
      const previewChars = Math.max(40, Math.min(400, Number(payload?.previewChars) || 160))
      const previewLimit = Math.max(1, Math.min(300, Number(payload?.limit) || 120))

      const preview = (index, { domainFiltered = false } = {}) => {
        const rows = Object.entries(index.entries || {})
          .filter(([, e]) => isMemoryEligible(e) && (domainFiltered || visibleToSession(e, sessionId)))
          .filter(([, e]) => !domainFiltered || !binding || appliesToDomain(e, binding))
          .sort((a, b) => String(b[1].updatedAt || b[1].createdAt || '').localeCompare(String(a[1].updatedAt || a[1].createdAt || '')))
        return {
          ...summarizeIndex({ entries: Object.fromEntries(rows) }),
          shown: Math.min(rows.length, previewLimit),
          items: rows.slice(0, previewLimit).map(([id, e]) => ({
            id,
            title: e.title || '',
            layer: e.layer || 'long_term',
            status: e.status || 'active',
            domain: e.domain || null,
            openLoop: e.openLoop === true,
            marginalized: e.marginalized === true,
            source: e.source || 'inferred',
            marginalReason: e.marginalReason || null,
            unpinnedBy: e.unpinnedBy || null,
            confidence: e.confidence,
            createdAt: e.createdAt || null,
            updatedAt: e.updatedAt || null,
            decay: decayStrength(e),
            preview: String(e.content || '').slice(0, previewChars),
          })),
        }
      }

      // The sidebar preview must follow the same cross-library scope as recall.
      // `privateList` owns that rule (explicit library browsing stays single);
      // the old local `preview(privateIndex)` only read the bound library.
      let privatePreview = null
      if (binding?.libraryId && effective?.useLibrary) {
        if (getSettings().crossLibraryRecall === true) {
          try {
            const listed = await privateList({ exec: execFor(sessionId), preferIndex: true })
            const rows = (listed.files || []).map((file) => {
              const entry = file.entry || {}
              const ownerId = file.libraryId || listed.libraryId
              return {
                id: file.name,
                libraryId: ownerId,
                libraryName: file.libraryName || getLibrary(ownerId)?.name || null,
                title: entry.title || '',
                layer: entry.layer || 'long_term',
                status: entry.status || 'active',
                domain: entry.domain || null,
                openLoop: entry.openLoop === true,
                marginalized: entry.marginalized === true,
                source: entry.source || 'inferred',
                marginalReason: entry.marginalReason || null,
                unpinnedBy: entry.unpinnedBy || null,
                confidence: entry.confidence,
                createdAt: entry.createdAt || null,
                updatedAt: entry.updatedAt || null,
                decay: decayStrength(entry),
                preview: String(entry.content || '').slice(0, previewChars),
                entry,
              }
            }).sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
            privatePreview = {
              ...summarizeIndex({ entries: Object.fromEntries(rows.map((row, index) => [`${row.libraryId || 'x'}:${row.id}:${index}`, row.entry])) }),
              crossLibrary: true,
              shown: Math.min(rows.length, previewLimit),
              items: rows.slice(0, previewLimit).map(({ entry, ...item }) => item),
            }
          } catch {
            privatePreview = preview(privateIndex)
          }
        } else {
          privatePreview = preview(privateIndex)
        }
      }
      return {
        binding: bindingView(binding),
        domain: binding ? domainOf(binding) : 'general',
        folder,
        effective,
        // So the reader can tell whether a polled heartbeat is already painted.
        revision: memoryRevision(),
    stamp: memoryStamp(),
        // Only what the first screen paints. The conversation list and the
        // curation-job scan are what made opening the sidebar take seconds; the
        // list is fetched by `listSessions` when the Global tab is opened.
        private: privatePreview,
        global: preview(effective?.useGlobal ? globalIndex : { entries: {} }, { domainFiltered: true }),
        domains: getPromptDomains(),
        sidebarSettings: getSettings().sidebarSettings === true,
        lastRecallError: binding?.lastRecallError || null,
      }
    }
    case 'listFolderSessions': {
      const scopeKey = normalizeCwd(payload?.scopeKey) || '__default__'
      const state = loadState()
      const catalog = await sessionCatalog(ctx)
      let archived = new Set()
      let members = null
      try {
        const registry = ctx.get?.('workspaceRegistry')
        archived = new Set((registry?.archivedSessionIds || []).map(String))
        const workspace = (registry?.list?.() || []).find((w) => normalizeCwd(w?.path) === scopeKey)
        if (workspace && Array.isArray(workspace.sessionIds)) members = new Set(workspace.sessionIds.map(String))
      } catch {}
      const rows = Object.entries(state.sessions || {})
        .map(([sessionId, binding]) => {
          if (binding.consolidationFork) return null
          const inFolder = binding.scopeKey === scopeKey
            || (binding.libraryId && state.libraries?.[binding.libraryId]?.scopeKey === scopeKey)
          if (!inFolder) return null
          // The host's workspace membership is the display authority: a session
          // removed from the folder is gone from the list even though its log and
          // its memory library still exist. No host catalog means the sidebar is
          // running against an older host; keep old behaviour rather than hide all.
          if (catalog && (!catalog.byId.has(sessionId)
            || archived.has(String(sessionId))
            || (members && !members.has(String(sessionId))))) return null
          const effective = effectiveScope(binding, getWorkspacePolicy(scopeKey))
          return {
            sessionId,
            title: binding.title || binding.label || null,
            libraryId: binding.libraryId || null,
            domain: domainOf(binding),
            useLibrary: binding.useLibrary !== false,
            useGlobal: binding.useGlobal !== false,
            effective,
            lastTurnAt: binding.lastTurnAt || null,
          }
        })
        .filter(Boolean)
        .sort((a, b) => String(b.lastTurnAt || '').localeCompare(String(a.lastTurnAt || '')))
      if (catalog && rows.length > 0) {
        const titles = await readSessionTitles(catalog.sessionQuery, rows.map((r) => r.sessionId))
        for (const row of rows) {
          const title = titles.get(row.sessionId)
          if (title) row.title = title
        }
      }
      return { scopeKey, sessions: rows }
    }
    case 'getSettingsState': {
      // Settings never shows a conversation's own counts or the curation job list,
      // so it skips both indexes, the job directory scan, and the binding lookup.
      return {
        engine: engineView(),
        memuConfig: getMemuConfig(),
        summaryConfig: getSummaryConfig(),
        visionConfig: getVisionConfig(),
        localVector: getLocalVectorState(),
        settings: redactConsolidationSettings(getSettings()),
        libraries: libraryView(),
        archivedLibraries: archivedLibraryView(),
        // Seeds the settings pane's heartbeat with the paint it just made, so the
        // next beat can tell "this is still what I show" from "someone wrote".
        revision: memoryRevision(),
        stamp: memoryStamp(),
      }
    }
    case 'listVersions': {
      const result = await fetchAvailableVersions({ force: payload?.force === true })
      return {
        ...result,
        installed: engineStatus().current?.version || null,
        recommendedVersion: ENGINE_VERSION,
      }
    }
    case 'getSessionPromptState': {
      // Reusing `getState` here meant every conversation click paid for both memory
      // indexes and the full archive scan.
      const sessionId = payload?.sessionId || null
      const cwd = String(payload?.cwd || '').trim()
      const scopeKey = normalizeCwd(cwd) || '__default__'
      const folder = getWorkspacePolicy(scopeKey)
      const binding = sessionId ? getSessionBinding(sessionId) : null
      return {
        binding: bindingView(binding),
        settings: {
          newSessionPromptDismissed: getSettings().newSessionPromptDismissed === true,
          newSessionDefault: getSettings().newSessionDefault || 'both',
        },
        libraries: listLibraries().map(({ id, name, scopeKey: key }) => ({ id, name, scopeKey: key })),
        // Memory domains accepted by setDomain. Prompt page types are a different
        // concept (getPromptDomains), so this stays a fixed list.
        domains: ['rp', 'coding', 'general', 'mixed'],
        // A folder with both layers off never prompts: there is nothing to ask.
        folder,
        shouldPrompt: folder.useLibrary !== false || folder.useGlobal !== false,
      }
    }
    case 'listFolders':
      return folderView(ctx)
    case 'setFolderPolicy': {
      const scopeKey = normalizeCwd(payload?.scopeKey) || '__default__'
      const patch = {}
      for (const key of ['useLibrary', 'useGlobal']) {
        if (typeof payload?.[key] === 'boolean') patch[key] = payload[key]
      }
      // Turning the private switch on should make the folder usable immediately,
      // even if it never had a library. Also backfill conversations in this folder
      // that already opted into private memory but were left without a library
      // (they were created while the folder switch was off). Turning it off leaves
      // the existing library and bindings alone.
      if (patch.useLibrary === true) {
        const library = ensureLibraryForCwd(scopeKey)
        for (const [sessionId, binding] of Object.entries(loadState().sessions || {})) {
          if (binding.libraryId || binding.useLibrary === false || normalizeCwd(binding.scopeKey) !== scopeKey) continue
          setSessionBinding(sessionId, { libraryId: library.id, useLibrary: true })
        }
      }
      const policy = setWorkspacePolicy(scopeKey, patch)
      return { policy, folders: folderView(ctx).folders }
    }
    // "Restore defaults" is server-owned on purpose: the UI must not keep its own
    // copy of the numbers, or the two drift and a reset writes last release's
    // tuning. Only the knobs this page shows are reset — backend, credentials,
    // prompt pages and per-folder policies are user setup, not tuning.
    case 'resetSettings': {
      const patch = {}
      for (const key of [
        'autoInject', 'privateTopK', 'globalTopK', 'crossLibraryRecall', 'anchorTokens', 'turnTokens', 'injectionTotalTokens', 'dedupeTurns',
        'globalEveryNTurns', 'minUserChars', 'mustRememberCap', 'randomCueChance',
        'autoInstallEngine', 'newSessionPromptDismissed', 'newSessionDefault', 'habitsInjection',
        'sleepConsolidation', 'sleepAfterIdleMinutes', 'autoCurateEveryHours',
        'autoCurateSessionLimit', 'purgeArchivedAfterDays', 'memoryMode',
        'shortTermTtlHours',
        'sidebarSettings', 'visionCaptionEnabled',
        'inboundToolNames',
        // 全局提炼的审核模式（spec §6.1）：恢复默认 = 回到 auto，不保留全审状态。
        'curatorReviewMode',
        // 工单 C/D/E 的调参：没进这张表的 key 会被静默丢弃，设置页就成了死控件。
        'openLoopRemindDays', 'freshnessHint', 'freshnessDays',
        'salientWake', 'salientWakeHour', 'salientWakeTimeZone',
        // 整理 fork 的模型选择（三模式）：恢复默认 = 回到 inherit，不留 host/custom 残配置。
        'consolidationModelMode', 'consolidationModel', 'consolidationReasoningEffort',
        'consolidationCustomBaseURL', 'consolidationCustomApiKey', 'consolidationCustomModel', 'consolidationCustomApi',
        // 自动关联：恢复默认 = 回到 suggest（只出候选、不写边）。
        'autoLinkMode', 'allowWorkerAssertion',
      ]) patch[key] = DEFAULT_SETTINGS[key]
      return redactConsolidationSettings(updateSettings(patch))
    }
    case 'setSettings': {
      const patch = payload?.patch && typeof payload.patch === 'object' ? payload.patch : {}
      const allowed = new Set([
        'autoInject', 'privateTopK', 'globalTopK', 'crossLibraryRecall', 'anchorTokens', 'turnTokens', 'injectionTotalTokens',
        'relevanceThreshold', 'dedupeTurns', 'globalEveryNTurns', 'minUserChars',
        // newSessionDefault has to be writable here: "remember my choice" stores
        // it, and a dropped patch silently turned every remembered answer into
        // the 'both' fallback that the dismissed branch then applied.
        'mustRememberCap', 'randomCueChance', 'newSessionPromptDismissed', 'newSessionDefault', 'curatorModel',
        'autoInstallEngine', 'pipIndexes',
        'sleepConsolidation', 'sleepAfterIdleMinutes', 'autoCurateEveryHours', 'autoCurateSessionLimit',
        'memoryMode', 'memoryBackend', 'habitsInjection', 'purgeArchivedAfterDays',
        'shortTermTtlHours',
        'sidebarSettings', 'visionCaptionEnabled', 'inboundToolNames',
        // 全局提炼的审核模式（spec §6.1）：不进 allowlist 的 patch 会被静默丢弃。
        'curatorReviewMode',
        // 工单 C/D/E：未了之事复提节奏、时效提示、日期唤醒。缺一个就是设置页写了不生效。
        'openLoopRemindDays', 'freshnessHint', 'freshnessDays',
        'salientWake', 'salientWakeHour', 'salientWakeTimeZone',
        // 整理 fork 的模型选择：三模式开关 + host 指名 + custom 连接面（含明文 key 的
        // 写入；回包经 redactConsolidationSettings 打码，明文只落 state.json）。
        'consolidationModelMode', 'consolidationModel', 'consolidationReasoningEffort',
        'consolidationCustomBaseURL', 'consolidationCustomApiKey', 'consolidationCustomModel', 'consolidationCustomApi',
        // 自动关联的写入门控（DESIGN §6.4）：suggest / deterministic / off。
        'autoLinkMode', 'allowWorkerAssertion',
      ])
      const clean = {}
      for (const [k, v] of Object.entries(patch)) if (allowed.has(k)) clean[k] = v
      const beforeMode = getSettings().autoLinkMode
      const saved = redactConsolidationSettings(updateSettings(clean))
      // 切换到确定性写边时补一次全量重算：off/suggest 期间确认过的实体状态已是
      // confirmed，日常按 ids 的增量不会碰它们，否则提及边会永久缺失。
      if (clean.autoLinkMode === 'deterministic' && beforeMode !== 'deterministic') {
        try {
          for (const lib of listLibraries()) {
            await refreshPrivateAutoLinks({ libraryId: lib.id, full: true })
          }
        } catch (error) {
          try { warn('auto-link rebuild after mode switch skipped: ' + (error?.message || error)) } catch {}
        }
      }
      return saved
    }
    case 'listForkModelOptions': {
      // 整理 fork 模型选择器的数据源：宿主已激活 route 的 provider/model 目录 +
      // custom/discovery 能力位。llm service 缺席返回空目录，设置页照常渲染。
      return await listHostModelOptions(ctx)
    }
    case 'discoverForkModels': {
      // UI「拉取模型列表」：把草稿端点转给宿主模型发现（dsh-llm-pi-ai）。apiKey 是
      // 一次性草稿凭据（或 useStoredKey 复用已保存的 custom key），只进发现请求，
      // 不进日志、不进回包；结果/错误都是结构化的，UI 直接渲染。
      return await discoverForkModels(ctx, {
        baseURL: payload?.baseURL,
        api: payload?.api,
        apiKey: payload?.apiKey,
        useStoredKey: payload?.useStoredKey === true,
      }, getSettings())
    }
    case 'setSessionScope': {
      const sessionId = requireSessionId(payload)
      const patch = {}
      for (const key of ['useLibrary', 'useGlobal']) {
        if (typeof payload?.[key] === 'boolean') patch[key] = payload[key]
      }
      const before = getSessionBinding(sessionId)
      if (!before) throw new Error('session is not bound to a memory library')
      // The folder policy is the ceiling: a conversation may narrow its own
      // switches but never widen them past the folder. Report the clamp so the UI
      // can say why a toggle snapped back.
      const scope = effectiveScope(before, getWorkspacePolicy(before.scopeKey))
      const clamped = []
      if (patch.useLibrary === true && scope.libraryBlocked) {
        delete patch.useLibrary
        clamped.push({ field: 'useLibrary', reason: 'folder' })
      }
      if (patch.useGlobal === true && scope.globalBlocked) {
        delete patch.useGlobal
        clamped.push({ field: 'useGlobal', reason: 'folder' })
      }
      // Turning private memory on must also create/adopt the folder library. The
      // old path only flipped the switch, leaving libraryId null forever when the
      // conversation had been created while private memory was off.
      if (patch.useLibrary === true && before.scopeKey) {
        const current = before.libraryId ? getLibrary(before.libraryId) : null
        if (!current || current.archived === true) {
          const ensured = ensureLibraryForCwd(before.scopeKey)
          patch.libraryId = ensured.id
        }
      }
      const binding = setSessionBinding(sessionId, patch)
      return { binding: bindingView(binding), effective: effectiveScope(binding), clamped }
    }
    case 'setMemoryContext': {
      const sessionId = requireSessionId(payload)
      if (!getSessionBinding(sessionId)) throw new Error('no bound session')
      const context = normalizeMemoryContext(payload?.context)
      const sceneTime = payload?.sceneTime || null
      if (sceneTime && !Number.isFinite(Date.parse(sceneTime))) throw new Error('sceneTime must be an explicit ISO date/time')
      releaseInjected(sessionId)
      markReinjectPending(sessionId)
      return bindingView(setSessionBinding(sessionId, { memoryContext: context, sceneTime }))
    }
    case 'initSession': {
      const sessionId = requireSessionId(payload)
      const cwd = String(payload?.cwd || '').trim()
      // A library is a folder. Without one there is nothing to bind, and creating
      // the placeholder bucket would pollute the library list with a fake workspace.
      if (!cwd || cwd === '__default__') throw new Error('this conversation has no workspace folder yet; pick a folder first')
      const binding = ensureSession(sessionId, {
        cwd,
        agentPreset: payload?.agentPreset,
        libraryId: payload?.libraryId ? String(payload.libraryId) : null,
        // The prompt's "no memory" answer must not create a library as a side
        // effect; only an explicit create/auto choice passes createLibrary.
        createLibrary: payload?.createLibrary !== false,
      })
      return { binding: bindingView(binding), libraries: libraryView() }
    }
    case 'setDomain': {
      const sessionId = requireSessionId(payload)
      const domain = payload?.domain
      const allowed = ['rp', 'coding', 'general', 'mixed']
      if (domain !== null && !allowed.includes(domain) && !String(domain || '').startsWith('project:')) {
        throw new Error('invalid domain')
      }
      return bindingView(setSessionBinding(sessionId, { domainOverride: domain }))
    }
    case 'setLibrary': {
      const sessionId = requireSessionId(payload)
      const libraryId = String(payload?.libraryId || '')
      if (!getLibrary(libraryId)) throw new Error('library not found')
      releaseInjected(sessionId)
      markReinjectPending(sessionId)
      return bindingView(setSessionBinding(sessionId, { libraryId }))
    }
    case 'unbindSession': {
      const sessionId = requireSessionId(payload)
      deleteSessionBinding(sessionId)
      return { ok: true }
    }
    case 'listLibraries':
      return libraryView()
    case 'createLibrary': {
      const name = String(payload?.name || '').trim()
      if (!name) throw new Error('name is required')
      return createLibrary({ name, cwd: payload?.cwd })
    }
    case 'renameLibrary': {
      const id = String(payload?.libraryId || '')
      if (!getLibrary(id)) throw new Error('library not found')
      return renameLibrary(id, payload?.name)
    }
    case 'archiveLibrary': {
      const id = String(payload?.libraryId || '')
      if (!getLibrary(id)) throw new Error('library not found')
      return { ok: archiveLibrary(id), archived: archivedLibraryView() }
    }
    case 'listArchivedLibraries':
      return { libraries: archivedLibraryView() }
    case 'deleteLibrary': {
      const id = String(payload?.libraryId || '')
      if (!getLibrary(id)) throw new Error('library not found')
      if (getLibrary(id).archived !== true) throw new Error('archive the library before deleting it')
      const safety = await backupDatabases()
      const result = deleteLibrary(id)
      if (!result.ok) throw new Error(result.error)
      return { ok: true, safety, archived: archivedLibraryView() }
    }
    case 'restoreLibrary': {
      const id = String(payload?.libraryId || '')
      const result = restoreLibrary(id)
      if (!result.ok) throw new Error(result.error)
      // Restoring a library whose folder is really gone is allowed, but the UI has
      // to say so: it will not pick up new conversations until the path exists again.
      return { ok: true, scopeMissing: libraryScopeMissing(result.library), archived: archivedLibraryView() }
    }
    case 'listSessions': {
      return { sessions: await recentSessions(ctx, payload?.limit) }
    }
    case 'listPrivate': {
      const sessionId = requireSessionId(payload)
      const binding = getSessionBinding(sessionId)
      if (!binding) return { files: [] }
      return privateListView({ exec: execFor(sessionId) }, {
        limit: payload?.limit,
        previewChars: payload?.previewChars,
      })
    }
    case 'browseLibrary': {
      const id = String(payload?.libraryId || '')
      if (!getLibrary(id)) throw new Error('library not found')
      return privateListView({ libraryId: id })
    }
    case 'getMemory': {
      // One entry, for the memory wall's in-place drawer. Reading the whole library
      // just to show one card was the reason the wall used to bounce to the browser.
      const libraryId = String(payload?.libraryId || '')
      if (!libraryId) throw new Error('getMemory requires a libraryId')
      if (!getLibrary(libraryId)) throw new Error('library not found')
      const id = String(payload?.id || '')
      const index = loadPrivateIndex(libraryId)
      const entry = index.entries?.[id]
      if (!entry) throw new Error('unknown memory')
      return { id, libraryId, entry, attachments: attachmentPreview(libraryId, entry) }
    }
    case 'getStats': {
      // Read-only: the statistics page must not create a library, and the counters
      // are a sidecar — a damaged one degrades the page, never the memories.
      const id = String(payload?.libraryId || '')
      if (!id) throw new Error('getStats requires a libraryId')
      if (!getLibrary(id)) throw new Error('library not found')
      const index = loadPrivateIndex(id)
      return statsView({
        libraryId: id,
        entries: index.entries || {},
        days: payload?.days,
        strengthOf: decayStrength,
      })
    }
    case 'addMemory': {
      const id = String(payload?.libraryId || '')
      if (!getLibrary(id)) throw new Error('library not found')
      const layer = payload?.layer || 'long_term'
      if (layer === 'must_remember' && !String(payload?.pinReason || '').trim()) {
        throw new Error('pinReason is required for must_remember')
      }
      return privateRemember({
        libraryId: id,
        content: payload?.content,
        title: payload?.title,
        layer,
        pinReason: payload?.pinReason,
        pinSource: payload?.pinSource,
        tags: Array.isArray(payload?.tags) ? payload.tags : [],
        openLoop: payload?.openLoop === true,
        disclosure: payload?.disclosure || 'can_tell',
        owner: payload?.owner || 'me',
        visibility: payload?.visibility || 'shared',
        confidence: payload?.confidence,
        // Left undefined when the panel does not send it, so privateRemember keeps
        // its `inferred` default. A human typing a memory is not the user saying it.
        source: payload?.source || undefined,
        // A date typed into the panel is a commitment the user wants raised, so it
        // is passed straight through; privateRemember validates and rejects junk.
        salientDate: payload?.salientDate ?? null,
      })
    }
    case 'updateMemory': {
      const id = String(payload?.id || '')
      if (!id) throw new Error('id is required')
      const patch = payload?.patch || {}
      // `layer` is here so the browser can promote a short_term draft to long_term,
      // which is the one upgrade path memory.js supports in place.
      // `source` is writable: correcting provenance is the point of showing it.
      // `salientDate` is writable for the same reason: an entry whose year was
      // dropped has to be repairable from the browser, not only from JSON.
      // `emotion`/`dominance` 可写：面板修的是那条记忆所述事件的感受。
      // `emotionSource` 故意不在名单里：来源是审计结论，能改就等于能伪造。
      const allowed = ['content', 'title', 'tags', 'status', 'openLoop', 'disclosure', 'confidence', 'owner', 'visibility', 'layer', 'source', 'salientDate', 'track', 'peak', 'moodValence', 'arousal', 'emotion', 'dominance', 'attachments', 'context']
      // An unknown key used to be dropped in silence, so a typo here or in a script
      // came back as a successful save that changed nothing. Refuse instead: the
      // caller can only fix a field name it is told is wrong.
      const unknown = Object.keys(patch).filter((key) => !allowed.includes(key))
      if (unknown.length) throw new Error(`unknown memory field: ${unknown.join(', ')}; editable: ${allowed.join(', ')}`)
      // The browser edit form must not offer must_remember: granting permanence
      // needs a pin reason, which only the creation path collects. Promoting to
      // must_remember here would hit privateUpdate's refusal anyway.
      if (patch?.layer === 'must_remember') throw new Error('must_remember needs a pin_reason; write it with memu_private_remember from a conversation')
      const args = { id }
      for (const key of allowed) if (patch[key] !== undefined) args[key] = patch[key]
      if (payload?.libraryId) args.libraryId = String(payload.libraryId)
      else args.exec = execFor(requireSessionId(payload))
      return privateUpdate(args)
    }
    case 'importMemories': {
      const id = String(payload?.libraryId || '')
      if (!getLibrary(id)) throw new Error('library not found')
      if (payload?.revertBatchId) {
        const reverted = await revertImportBatch({ libraryId: id, batchId: String(payload.revertBatchId) })
        // Lexicon terms live behind a lazily loaded module that memory.js must not
        // reach across for, so the undo happens here, where the api already exists.
        let lexiconReverted = 0
        if (reverted.lexiconTermIds?.length) {
          try {
            const lexicon = await lexiconApi()
            for (const termId of reverted.lexiconTermIds) {
              try { lexicon.deleteLexiconTerm({ libraryId: id, termId }); lexiconReverted += 1 } catch (error) {
                warn(`revert import: lexicon term ${termId} kept: ${error?.message || error}`)
              }
            }
          } catch (error) {
            warn(`revert import: lexicon module unavailable, terms kept: ${error?.message || error}`)
          }
        }
        return { ...reverted, lexiconReverted }
      }
      // The payload may be the parsed export (memories array) or the raw file text.
      let memories = payload?.memories
      let graphData = payload?.graph || null
      let lexiconData = payload?.lexicon && typeof payload.lexicon === 'object' && !Array.isArray(payload.lexicon) ? payload.lexicon : null
      let missingAttachments = 0
      let bundleId = payload?.bundleId ? String(payload.bundleId) : null
      if (payload?.archiveBase64) {
        const archive = importMediaBundle(id, Buffer.from(String(payload.archiveBase64), 'base64'))
        memories = archive.memories
        graphData = archive.graph
        missingAttachments = archive.missing
        bundleId = bundleId || archive.bundleId || null
      }
      if (typeof memories === 'string') {
        let parsed = null
        try { parsed = JSON.parse(memories) } catch { throw new Error('that file is not valid JSON') }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          if (Array.isArray(parsed.memories)) {
            memories = parsed.memories
            graphData = parsed.graph || null
            bundleId = bundleId || (parsed.bundleId ? String(parsed.bundleId) : null)
            lexiconData = lexiconData || (parsed.lexicon && typeof parsed.lexicon === 'object' && !Array.isArray(parsed.lexicon) ? parsed.lexicon : null)
          }
          else throw new Error('this JSON has no "memories" array')
        } else if (Array.isArray(parsed)) memories = parsed
        else throw new Error('this JSON has no "memories" array')
      }
      if (!Array.isArray(memories)) throw new Error('memories must be an array')
      // One batch id per install: every entry created by this import carries it, so
      // `revertBatchId` can undo exactly this package without touching old rows.
      const importBatchId = bundleId || (payload?.importBatchId ? String(payload.importBatchId) : `bnd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
      const result = await importMemories({ libraryId: id, memories, importBatchId })
      const graphRestore = graphData && result.idMap ? restoreGraphData(id, graphData, result.idMap, { origin: importBatchId }) : null
      // 词典是版本化 member（§4.4）：包里带了才合并恢复；term 冲突（规范化后同词）
      // 更新既有词条，active+sensitive 一律跳过并上报，超长字段按核心 clip 落地、
      // term 本身越界/归一化为空才进 failed。
      const lexiconReport = lexiconData ? await mergeLexiconImport(id, lexiconData) : null
      // Record the manifest before answering: an import whose ledger is missing still
      // reverts its memories (index tag), but loses the graph and lexicon halves.
      recordImportBatch({
        libraryId: id,
        batchId: importBatchId,
        memories: result.ids || [],
        entities: graphRestore?.createdEntityIds || [],
        lexicon: lexiconReport?.addedTermIds || [],
      })
      const value = { libraryId: id, ...result, missingAttachments, importBatchId }
      return lexiconReport ? { ...value, lexicon: lexiconReport } : value
    }
    case 'exportLibrary': {
      const id = String(payload?.libraryId || '')
      const lib = getLibrary(id)
      if (!lib) throw new Error('library not found')
      const index = loadPrivateIndex(id)
      // §4.4：导出包带上版本化词典 member。词典核心暂时不可用（未落地/文件损坏）
      // 时导出不能整个失败——报 unavailable，让导入端知道这份包没有词典。
      let lexiconMember = { version: 1, terms: [], unavailable: null }
      try {
        const lexicon = await lexiconApi()
        const data = lexicon.loadLexicon(id)
        lexiconMember = { version: 1, terms: Object.entries(data.terms || {}).map(([termId, e]) => ({ id: termId, ...e })) }
      } catch (error) {
        lexiconMember.unavailable = rpcErrorMessage(error).slice(0, 300)
      }
      const exported = {
        format: 'dsh-memu-memory-library@1',
        bundleId: `bnd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        exportedAt: new Date().toISOString(),
        library: { id: lib.id, name: lib.name, scopeKey: lib.scopeKey || null, domain: lib.domain || null },
        memories: Object.entries(index.entries || {}).map(([memId, e]) => ({ id: memId, ...e })),
        graph: graphExport(id),
        lexicon: lexiconMember,
      }
      if (payload?.includeAttachments === true) {
        if (payload?.delivery === 'download') return { filename: `${id}.zip`, downloadUrl: `/dsh-memu-memory/export/${id}.zip` }
        return { format: 'dsh-memu-memory-library-zip@1', filename: `${id}.zip`, base64: exportMediaBundle(id, exported).toString('base64') }
      }
      return exported
    }
    case 'getAttachment':
      return getAttachment(payload || {})
    case 'browseWall': {
      const libraryId = payload?.libraryId ? String(payload.libraryId) : null
      const libraries = libraryId ? [getLibrary(libraryId)] : listLibraries()
      if (libraries.some(library => !library)) throw new Error('library not found')
      const items = []
      const errors = []
      const collect = (index, lib) => {
        for (const [id, entry] of Object.entries(index.entries || {})) {
          items.push({
            id, title: entry.title || '', preview: String(entry.content || '').slice(0, 180),
            libraryId: lib?.id || null, libraryName: lib?.name || 'global',
            layer: entry.layer || 'long_term', status: entry.status || 'active',
            source: entry.source || 'inferred', confidence: entry.confidence ?? null,
            accuracy: entry.accuracy ?? null, createdAt: entry.createdAt || null, updatedAt: entry.updatedAt || null,
            expiresAt: entry.expiresAt || null, openLoop: entry.openLoop === true,
            marginalized: entry.marginalized === true, decay: Math.min(1, decayStrength(entry)),
            tags: Array.isArray(entry.tags) ? entry.tags : [], attachmentCount: entry.attachments?.length || 0,
            // Global entries carry F1/F2 metadata; the wall drawer reads it from the
            // same bounded item payload instead of a second full-body request.
            ...(lib ? {} : {
              links: Array.isArray(entry.links) ? entry.links : [],
              absorbedFrom: Array.isArray(entry.absorbedFrom) ? entry.absorbedFrom : [],
              absorbedAt: entry.absorbedAt || null,
              representativeId: entry.representativeId || null,
              absorbOpId: entry.absorbOpId || null,
            }),
            // The first usable image becomes the card cover; the drawer requests
            // the full gallery from getMemory. Secret entries come back hidden
            // (no url), so the wall never fetches their pixels.
            attachments: lib && entry.attachments?.length ? attachmentPreview(lib.id, entry) : [],
          })
        }
      }
      for (const library of libraries) {
        try { collect(loadPrivateIndex(library.id), library) } catch { errors.push({ libraryId: library.id, error: 'memory index unavailable' }) }
      }
      // Global memory is shared across libraries and the wall always exposes a
      // global scope. Include it even when a single private library was selected:
      // the single-library authorization covers that library's private rows, and
      // global rows are not library-private data. Without this, the standalone
      // single-library fallback (hosts that deny the all-libraries read) shows an
      // empty global scope.
      try { collect(loadGlobalIndex(), null) } catch { errors.push({ libraryId: null, error: 'global index unavailable' }) }
      items.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
      const limit = Math.max(1, Math.min(1000, Number(payload?.limit) || 300))
      return { items: items.slice(0, limit), total: items.length, libraries, errors }
    }
    case 'getGraph':
      // Reuse the private graph endpoint instead of adding a second read method:
      // the authorization map and RPC method count stay unchanged. Global edges
      // have no entity store, so the module is loaded lazily like unlink.
      if (payload?.scope === 'global') {
        const globalGraph = await globalGraphApi()
        return globalGraph.getGlobalGraph(payload || {})
      }
      return getGraph(payload || {})
    case 'listEntities':
      return listEntities(payload || {})
    case 'createEntity': {
      // 手工创建就是一次用户断言：直接 confirmed，并立刻挂上提及边。
      const entity = createEntity({ ...(payload || {}), status: 'confirmed', confirmedBy: 'user', origin: 'user' })
      if (entity?.status === 'confirmed') {
        let suppression = null
        try { suppression = suppressionSet(payload?.libraryId) } catch {}
        try {
          refreshEntityMentions({ libraryId: payload?.libraryId, entity, suppression, operation: 'auto-link-create' })
        } catch {}
        resetAnchorCandidatesCache()
      }
      return entity
    }
    case 'renameEntity':
      return renameEntity(payload || {})
    case 'deleteEntity':
      return deleteEntity(payload || {})
    case 'mergeEntities':
      return mergeEntities(payload || {})
    case 'suggestEntityMerges':
      return suggestEntityMerges(payload || {})
    case 'getAnchorCandidates':
      // 派生数据：只读记忆/实体/词典，生成本库的待确认队列快照。
      return generateAnchorCandidates({ libraryId: payload?.libraryId, force: payload?.force === true })
    case 'confirmEntities': {
      // 人工确认是唯一入口：确认后同步补挂提及边（增量 R1），不等下次整理。
      const result = confirmEntities({ libraryId: payload?.libraryId, entityIds: payload?.entityIds, by: 'user' })
      resetAnchorCandidatesCache()
      return result
    }
    case 'purgeAutoLinks': {
      // 关系图的“删除全部自动边”：只删 source:'auto'，并写抑制键防复活。
      const result = purgeAutoLinks({ libraryId: payload?.libraryId })
      resetAnchorCandidatesCache()
      return result
    }
    case 'clearLinkSuppression': {
      // 反向操作：清除本库的删除标记；deterministic 模式下顺带全量重算一次。
      const result = clearSuppression(payload?.libraryId)
      let rebuilt = null
      try {
        rebuilt = await refreshPrivateAutoLinks({ libraryId: payload?.libraryId, full: true })
      } catch (error) {
        try { warn('auto-link rebuild after suppression clear skipped: ' + (error?.message || error)) } catch {}
      }
      resetAnchorCandidatesCache()
      return { ...result, rebuilt: rebuilt?.applied ? (rebuilt.applied.added + rebuilt.applied.updated) : 0, skipped: rebuilt?.skipped || null }
    }
    case 'linkEntries':
      return linkEntries(payload || {})
    case 'unlinkEntry':
      return unlinkEntry(payload || {})
    case 'getRelationship':
      return getRelationship(payload || {})
    case 'updateRelationship':
      return updateRelationship(payload || {})
    case 'listGlobal': {
      const sessionId = payload?.sessionId || null
      const exec = sessionId ? execFor(sessionId) : { agent: null }
      try {
        const result = await globalList({ exec, domain: payload?.domain, preferIndex: true })
        return {
          warning: result.warning || null,
          source: result.source || null,
          files: (result.files || []).map((f) => ({
            id: f.name,
            title: f.entry?.title || f.description || '',
            domain: f.entry?.domain || 'unknown',
            appliesTo: f.entry?.appliesTo || [],
            confidence: f.entry?.confidence ?? null,
            evidence: f.entry?.evidence || [],
            layer: f.entry?.layer || 'long_term',
            decay: decayStrength(f.entry),
            createdAt: f.entry?.createdAt || null,
            updatedAt: f.entry?.updatedAt || null,
            source: f.entry?.source || 'inferred',
            status: f.entry?.status || 'active',
            content: String(f.content || '').slice(0, 600),
            // F1/F2 metadata: the global page renders link/absorb tags and the undo
            // button from these fields; without them every tag is silently absent.
            links: Array.isArray(f.entry?.links) ? f.entry.links : [],
            absorbedFrom: Array.isArray(f.entry?.absorbedFrom) ? f.entry.absorbedFrom : [],
            absorbedAt: f.entry?.absorbedAt || null,
            representativeId: f.entry?.representativeId || null,
            absorbOpId: f.entry?.absorbOpId || null,
          })),
        }
      } catch (error) {
        if (error?.code !== 'MEMU_ENGINE_NOT_READY') throw error
        const index = loadGlobalIndex()
        return {
          files: Object.entries(index.entries || {}).filter(([, e]) => (!payload?.domain || e.domain === payload.domain)
            && (!sessionId || (isMemoryEligible(e) && appliesToDomain(e, getSessionBinding(sessionId))))).map(([id, e]) => ({
            id, title: e.title || '', domain: e.domain || 'unknown', appliesTo: e.appliesTo || [],
            confidence: e.confidence ?? null, status: e.status || 'active', content: String(e.content || '').slice(0, 600),
            evidence: e.evidence || [], layer: e.layer || 'long_term', decay: decayStrength(e),
            createdAt: e.createdAt || null, updatedAt: e.updatedAt || null, source: e.source || 'inferred',
            links: Array.isArray(e.links) ? e.links : [],
            absorbedFrom: Array.isArray(e.absorbedFrom) ? e.absorbedFrom : [],
            absorbedAt: e.absorbedAt || null,
            representativeId: e.representativeId || null,
            absorbOpId: e.absorbOpId || null,
          })),
        }
      }
    }
    case 'listReviews': {
      // Two queues now: the global curator's and each private library's own
      // (appendix B-14 — a private memory that contradicts an older one lands in
      // pending_review instead of being appended as equally true).
      const libraryId = payload?.libraryId ? String(payload.libraryId) : null
      const index = libraryId
        ? (getLibrary(libraryId) ? loadPrivateIndex(libraryId) : null)
        : loadGlobalIndex()
      if (libraryId && !index) throw new Error('library not found')
      return {
        scope: libraryId ? 'private' : 'global',
        libraryId,
        items: Object.entries(index.entries || {})
          .filter(([, e]) => e.status === 'pending_review')
          .sort((a, b) => String(b[1].updatedAt || '').localeCompare(String(a[1].updatedAt || '')))
          .map(([id, e]) => ({
            id,
            libraryId,
            title: e.title || '',
            content: String(e.content || '').slice(0, 4000),
            domain: e.domain || (libraryId ? 'private' : 'unknown'),
            confidence: e.confidence ?? null,
            reviewReason: e.reviewReason || '',
            conflictingWith: e.conflictingWith || null,
            // 包 F2（spec §6.7）：风险分与 pendingAbsorb 随队列下发，供 UI 打
            // 「集合吸收」Tag、列出来源标题并按风险排序；旧条目按缺省读取。
            reviewRisk: e.reviewRisk ?? null,
            reviewRiskReasons: Array.isArray(e.reviewRiskReasons) ? e.reviewRiskReasons : [],
            pendingAbsorb: e.pendingAbsorb || null,
            evidence: (e.evidence || []).slice(0, 6),
            updatedAt: e.updatedAt || null,
          })),
      }
    }
    case 'resolveReview': {
      // 包 F2（spec §6.7）：unlink / undo-absorb 是两个全局元数据动作，不是内容复核
      // ——都不新增路由，仍走 resolveReview 已在的全局复核授权路径；但它们只作用于
      // 全局队列，带 libraryId 的调用是私有复核语义错位，直接报错。
      const reviewAction = String(payload?.action || '')
      if (reviewAction === 'unlink' || reviewAction === 'undo-absorb') {
        if (String(payload?.libraryId || '').trim()) {
          throw new Error(`${reviewAction} is a global review action; pass no libraryId`)
        }
        if (reviewAction === 'unlink') {
          // lib/global-graph.js（F1 包）的 removeGlobalLink，按需加载——与词典核心
          // 同一模式；模块缺席或未导出时抛固定错误（spec §6.7 RPC 约定）。
          try {
            const globalGraph = await globalGraphApi()
            return globalGraph.removeGlobalLink({
              linkId: payload?.linkId, fromId: payload?.fromId, toId: payload?.toId, kind: payload?.kind,
            })
          } catch (error) {
            if (globalGraphModulePromise) throw error
            throw new Error('link removal lands with F1')
          }
        }
        return undoGlobalAbsorb({ id: String(payload?.id || '') })
      }
      return resolveMemoryReview({
        libraryId: payload?.libraryId ? String(payload.libraryId) : null,
        id: String(payload?.id || ''), action: reviewAction,
        resolution: payload?.resolution || 'replace', reason: payload?.reason || '',
        content: payload?.content, title: payload?.title,
        sessionId: payload?.sessionId ? String(payload.sessionId) : null,
      })
    }
    // —— 词典：每本私有库一份；入口先由显式 id（须存在）或会话映射到库 ——
    case 'lexiconList': {
      const libraryId = lexiconLibraryId(payload)
      const lexicon = await lexiconApi()
      const data = lexicon.loadLexicon(libraryId)
      // 公开两态（§2.1）：pending/rejected 是内部状态与墓碑，列表永不返回。status 只接受
      // active / archived——未知值明确报错，别静默当成“全都要”把墓碑带出去。
      const requestedStatus = String(payload?.status || '').trim()
      if (requestedStatus && !LEXICON_PUBLIC_STATUSES.includes(requestedStatus)) {
        throw new Error(`unknown lexicon status: ${requestedStatus}; expected active or archived`)
      }
      // 默认 active；includeArchived 只把默认视图扩大成 active + archived，显式 status 优先。
      const includeArchived = payload?.includeArchived === true
      const status = requestedStatus || (includeArchived ? '' : 'active')
      const kind = String(payload?.kind || '')
      const sensitivity = String(payload?.sensitivity || '')
      const q = String(payload?.q || '').trim().toLowerCase()
      const rows = Object.entries(data.terms || {})
        .map(([termId, e]) => ({ ...e, id: termId, status: e?.status || 'active' }))
        .filter((e) => LEXICON_PUBLIC_STATUSES.includes(e.status))
      // 页签计数（§2.4）在 kind / 搜索 / 状态筛选之前算好：标签数字不随筛选跳动。
      const statusCounts = { active: 0, archived: 0 }
      for (const e of rows) statusCounts[e.status] += 1
      const selected = rows
        .filter((e) => !status || e.status === status)
        .filter((e) => !sensitivity || e.sensitivity === sensitivity)
        .filter((e) => !q || [e.term, e.meaning, e.usage, ...(Array.isArray(e.aliases) ? e.aliases : [])].join('\n').toLowerCase().includes(q))
      // 总览计数行只跟随 kind 以外的过滤：kind 标签上的数字才是"点了会变"的实时数。
      const counts = { slang: 0, meme: 0, trigger: 0, term: 0 }
      for (const e of selected) if (counts[e.kind] !== undefined) counts[e.kind] += 1
      // updatedAt 倒序；同一时间戳按 id 兜底——分页与多端渲染的顺序必须可复现。
      const filtered = selected.filter((e) => !kind || e.kind === kind)
        .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''))
          || String(a.id).localeCompare(String(b.id)))
      const pageSize = Math.max(1, Math.min(200, Number(payload?.pageSize) || 50))
      const total = filtered.length
      const pages = Math.max(1, Math.ceil(total / pageSize))
      const page = Math.min(pages, Math.max(1, Number(payload?.page) || 1))
      return {
        libraryId,
        scope: libraryId === GLOBAL_LEXICON_ID ? 'global' : 'private',
        version: data.version ?? null,
        items: filtered.slice((page - 1) * pageSize, page * pageSize).map(lexiconTermView),
        total,
        page,
        pages,
        pageSize,
        counts,
        statusCounts,
      }
    }
    case 'lexiconSearch': {
      const explicit = String(payload?.libraryId || '').trim()
      const libraryId = lexiconLibraryId(payload)
      const query = String(payload?.q ?? payload?.query ?? '').trim()
      if (!query) throw new Error('q is required')
      // 会话路径带着该会话的 memoryContext 做可见过滤；设置页显式选库时是管理视角，
      // 与 browseLibrary 一样不按场景收窄，也**不**跨库——「我在查哪本词典」要有答案。
      // 没显式选库 = 会话视角，作用域与注入、与 memu_lexicon_search 同一条尺：
      // 当前库 + 全局词典 +（开了跨库开关时）同领域其它库（§8.15）。
      const binding = explicit ? null : getSessionBinding(requireSessionId(payload))
      const lexicon = await lexiconApi()
      const includeArchived = payload?.includeArchived === true
      const hits = binding
        ? (lexiconSources(binding).length
          ? lexiconSearch(binding, query, { includeArchived }).items
          : [])
        : await lexicon.searchLexicon(
          { libraryId, query, memoryContext: {} },
          { includeArchived },
        )
      return {
        libraryId,
        ...(binding ? { scope: 'session' } : {}),
        items: (Array.isArray(hits) ? hits : []).map((hit) => {
          const e = hit?.entry && typeof hit.entry === 'object' ? hit.entry : hit
          return {
            id: hit?.id || hit?.termId || null,
            ...(hit?.libraryId ? { libraryId: hit.libraryId, libraryName: hit.libraryName || null, lexiconScope: hit.lexiconScope || 'private' } : {}),
            term: e?.term,
            kind: e?.kind || 'term',
            meaning: String(e?.meaning || '').slice(0, 2000),
            usage: String(e?.usage || '').slice(0, 800),
            aliases: Array.isArray(e?.aliases) ? e.aliases.slice(0, 20) : [],
            sensitivity: e?.sensitivity || 'normal',
            status: e?.status || 'active',
            strength: typeof e?.strength === 'number' ? e.strength : null,
            evidence: Array.isArray(e?.evidence) ? e.evidence.slice(0, 6) : [],
            sourceMemoryId: e?.sourceMemoryId || null,
          }
        }),
      }
    }
    case 'lexiconAdd': {
      const libraryId = lexiconLibraryId(payload)
      const term = String(payload?.term || '').trim()
      const kind = String(payload?.kind || '').trim()
      const meaning = String(payload?.meaning || '').trim()
      if (!term) throw new Error('term is required')
      if (!kind) throw new Error('kind is required')
      if (!meaning) throw new Error('meaning is required')
      const lexicon = await lexiconApi()
      // 领域戳只打给私有库：全局词典是跨领域共享的词汇表，把它戳成当前领域就等于
      // 降级成某一次会话的私有词。没有会话上下文（standalone 管理面）也不戳。
      const stampDomain = libraryId !== GLOBAL_LEXICON_ID && typeof payload?.sessionId === 'string' && payload.sessionId.trim()
        ? domainOf(getSessionBinding(requireSessionId(payload)))
        : null
      const result = await lexicon.upsertLexiconTerm({
        libraryId,
        term,
        kind,
        meaning,
        usage: payload?.usage,
        aliases: Array.isArray(payload?.aliases) ? payload.aliases : undefined,
        examples: Array.isArray(payload?.examples) ? payload.examples : undefined,
        context: payload?.context,
        knownBy: payload?.knownBy,
        visibility: payload?.visibility,
        sensitivity: payload?.sensitivity,
        confidence: payload?.confidence,
        evidence: payload?.evidence,
        ...(stampDomain ? { domain: stampDomain } : {}),
        // 面板/管理入口是"用户"来源，直接落 active；敏感字段校验在核心层。
        source: 'user',
        status: 'active',
      })
      return { libraryId, ...result }
    }
    case 'lexiconUpdate': {
      const libraryId = lexiconLibraryId(payload)
      const termId = String(payload?.termId || '').trim()
      if (!termId) throw new Error('termId is required')
      const patch = payload?.patch && typeof payload.patch === 'object' && !Array.isArray(payload.patch) ? payload.patch : {}
      // 只开放内容与观感字段；生命周期（归档/恢复）走 lexiconArchive / lexiconRestore，
      // 来源与类型不在这里改。
      // 与 updateMemory 同一规矩：名单外的键明确报错，不静默丢弃。
      const allowed = ['meaning', 'usage', 'aliases', 'examples', 'sensitivity', 'strength', 'visibility', 'context', 'knownBy']
      const unknown = Object.keys(patch).filter((key) => !allowed.includes(key))
      if (unknown.length) throw new Error(`unknown lexicon field: ${unknown.join(', ')}; editable: ${allowed.join(', ')}`)
      const lexicon = await lexiconApi()
      const data = lexicon.loadLexicon(libraryId)
      const existing = (data.terms || {})[termId]
      if (!existing) throw new Error('unknown lexicon term')
      // 用户来源直接应用字段（含敏感字段）；同规范词的撞线语义由核心层管。
      const result = await lexicon.upsertLexiconTerm({
        libraryId,
        term: existing.term,
        kind: existing.kind,
        meaning: patch.meaning ?? existing.meaning,
        usage: patch.usage ?? existing.usage,
        aliases: patch.aliases ?? existing.aliases,
        examples: patch.examples ?? existing.examples,
        context: patch.context ?? existing.context,
        knownBy: patch.knownBy ?? existing.knownBy,
        visibility: patch.visibility ?? existing.visibility,
        sensitivity: patch.sensitivity ?? existing.sensitivity,
        strength: patch.strength ?? existing.strength,
        confidence: existing.confidence,
        evidence: existing.evidence,
        source: 'user',
      })
      return { libraryId, termId, ...result }
    }
    case 'lexiconDelete': {
      const libraryId = lexiconLibraryId(payload)
      const termId = String(payload?.termId || '').trim()
      if (!termId) throw new Error('termId is required')
      const lexicon = await lexiconApi()
      const result = await lexicon.deleteLexiconTerm({ libraryId, termId })
      return { libraryId, ...result }
    }
    // 归档 / 恢复（§2.3）：公开生命周期的两个用户动作，只承认 active↔archived；
    // legacy pending 由迁移收口，rejected 是墓碑（核心 typed 拒绝）。
    case 'lexiconArchive': {
      const libraryId = lexiconLibraryId(payload)
      const termId = String(payload?.termId || '').trim()
      if (!termId) throw new Error('termId is required')
      const lexicon = await lexiconApi()
      const result = await lexicon.archiveLexiconTerm({ libraryId, termId })
      return { libraryId, ...result }
    }
    case 'lexiconRestore': {
      const libraryId = lexiconLibraryId(payload)
      const termId = String(payload?.termId || '').trim()
      if (!termId) throw new Error('termId is required')
      const lexicon = await lexiconApi()
      const result = await lexicon.restoreLexiconTerm({ libraryId, termId })
      return { libraryId, ...result }
    }
    case 'generatePrivate': {
      const sessionId = requireSessionId(payload)
      // Explicit button press: the user already decided this conversation is worth
      // summarizing, so the automatic "is there anything in it" gate does not apply.
      // 评测/联调可显式指定 trigger：trigger='backlog' + force=false 时走积压口径
      // （事件 ≥200 或人类回合 ≥10 才放行），用来验证水位触发本身。
      return requestPrivateConsolidation(ctx, sessionId, {
        force: payload?.force !== false,
        ...(payload?.trigger ? { trigger: String(payload.trigger) } : {}),
      })
    }
    case 'generateGlobal': {
      const sessionId = requireSessionId(payload)
      const sessionIds = Array.isArray(payload?.sessionIds) ? payload.sessionIds : []
      return startGlobalCuration(ctx, {
        sessionIds,
        parentSessionId: sessionId,
        model: payload?.model,
      })
    }
    case 'jobStatus': {
      const jobId = String(payload?.jobId || '')
      return getCurationJob(jobId)
    }
    case 'cancelJob': {
      const jobId = String(payload?.jobId || '')
      return { ok: cancelCurationJob(jobId) }
    }
    case 'listJobs':
      return { jobs: listCurationJobs() }
    case 'archiveMemory': {
      const id = String(payload?.id || '')
      if (!id) throw new Error('memory id is required')
      if (payload?.libraryId) return privateArchive({ libraryId: String(payload.libraryId), id })
      return privateArchive({ exec: execFor(requireSessionId(payload)), id })
    }
    case 'deleteMemory': {
      // Deliberately library-scoped and never session-scoped: the browser is the only
      // caller, and a model-driven delete with no library argument would be one
      // hallucinated id away from erasing a memory it never read.
      const id = String(payload?.id || '')
      if (!id) throw new Error('memory id is required')
      const libraryId = String(payload?.libraryId || '')
      if (!libraryId) throw new Error('libraryId is required')
      if (!getLibrary(libraryId)) throw new Error('library not found')
      if (payload?.preview === true) return previewDelete({ libraryId, id })
      if (payload?.restore === true) return restoreDeleted({ libraryId, id })
      const entry = loadPrivateIndex(libraryId).entries[id]
      if (!entry || !['archived', 'suppressed', 'expired'].includes(entry.status)) throw new Error('only archived memories can be deleted permanently; archive it first')
      // Same gate every other irreversible operation in this file uses. The status check
      // above is a lifecycle rule, not consent: a caller that reached this line by
      // accident should not be able to erase a memory just because it happened to be
      // archived. Order matters — keeping this after the status check preserves the
      // "archive it first" refusal old callers depend on.
      if (payload?.confirmed !== true) throw new Error('permanently deleting a memory requires explicit confirmation')
      const safety = await backupDatabases()
      return { ...await privateDelete({ libraryId, id }), safety }
    }
    case 'setup': {
      const status = engineStatus()
      if (status.status !== 'installing') {
        // A reinstall may replace the venv the resident interpreter is running from;
        // stop it first so Windows can rename/delete the old engine directory.
        closeMemuResident()
        void ensureEngine({ force: payload?.force === true, beforeSwitch: backupDatabases }).catch(() => {})
      }
      return { started: true, engine: engineView() }
    }
    case 'switchEngine': {
      const version = String(payload?.version || '')
      if (!version) throw new Error('version is required')
      closeMemuResident()
      const result = await switchEngineVersion(version, {
        beforeSwitch: backupDatabases,
        force: payload?.force === true,
        log: (message) => { try { ctx.logger?.info?.(`dsh-memu-memory engine: ${message}`) } catch {} },
      })
      if (!result.ok) throw new Error(result.error || 'switch failed')
      return { current: result.current?.version || version, unchanged: result.unchanged === true, engine: engineView() }
    }
    case 'pruneEngineVersions': {
      const result = pruneEngineVersions({ keep: Number(payload?.keep) || 3 })
      return { ...result, engine: engineView() }
    }
    case 'removeEngineVersion': {
      const result = removeEngineVersion(String(payload?.version || ''))
      return { ...result, engine: engineView() }
    }
    case 'listBackups':
      return { backups: listBackups() }
    case 'deleteBackup': {
      const result = deleteBackup(String(payload?.name || ''))
      return { ...result, backups: listBackups() }
    }
    case 'restoreBackup': {
      const result = await restoreBackup(String(payload?.name || ''), {
        // Take a fresh backup of the live data before anything is replaced, so a
        // mistaken restore is itself reversible.
        beforeRestore: () => backupDatabases(),
      })
      return { ...result, engine: engineView() }
    }
    case 'testRetrieval': {
      const sessionId = requireSessionId(payload)
      const query = String(payload?.query || 'test memory').trim() || 'test memory'
      const exec = execFor(sessionId)
      const scope = payload?.scope === 'global' ? 'global' : 'private'
      const result = scope === 'global'
        ? await globalRecall({ exec, query, topK: 5 })
        : await privateRecall({ exec, query, topK: 5 })
      return {
        scope,
        domain: result.domain || domainOf(getSessionBinding(sessionId)),
        files: (result.files || []).map((f) => ({
          id: f.name, title: f.entry?.title || f.description || '',
          content: String(f.content || '').slice(0, 500),
        })),
      }
    }
    case 'getPrompts': {
      // The page list is data, so it comes back with the prompts instead of being
      // duplicated in the client.
      return { prompts: getPromptStates(), domains: getPromptDomains() }
    }
    case 'addPromptDomain': {
      const domains = addPromptDomain(String(payload?.domain || ''))
      return { domains, prompts: promptMeta(getPromptStates()) }
    }
    case 'removePromptDomain': {
      const domains = removePromptDomain(String(payload?.domain || ''))
      return { domains, prompts: promptMeta(getPromptStates()) }
    }
    case 'getMemuConfig':
      return getMemuConfig()
    case 'setEmbeddingSource': {
      const config = setEmbeddingSource(String(payload?.source || ''))
      // 两条向量路线现在共用同一个常驻解释器：切回远程 API 不应释放它，
      // 否则下一次召回又会重新付一遍 Python 导入链的冷启动。
      if (config?.source === 'local') void prewarmMemuResident()
      return config
    }
    case 'saveMemuConfig':
      return saveMemuConfig({
        provider: payload?.provider,
        model: payload?.model,
        baseUrl: payload?.baseUrl,
        apiKey: payload?.apiKey,
        clearKey: payload?.clearKey === true,
        summaryModel: payload?.summaryModel,
        summaryBaseUrl: payload?.summaryBaseUrl,
        summaryApiKey: payload?.summaryApiKey,
        clearSummaryKey: payload?.clearSummaryKey === true,
        visionModel: payload?.visionModel,
        visionBaseUrl: payload?.visionBaseUrl,
        visionApiKey: payload?.visionApiKey,
        clearVisionKey: payload?.clearVisionKey === true,
      })
    case 'testMemuConfig':
      return testMemuConfig()
    case 'getLocalVectorState':
      return getLocalVectorState()
    case 'downloadLocalVectorModel':
      return await downloadLocalVectorModel(String(payload?.id || ''), {
        confirmed: payload?.confirmed === true,
        ...(payload?.provider ? { provider: String(payload.provider) } : {}),
      })
    case 'selectLocalVectorModel':
      return selectLocalVectorModel(String(payload?.id || ''))
    case 'installLocalVectorRuntime':
      return await installLocalVectorRuntime({
        modelId: payload?.id || null,
        confirmed: payload?.confirmed === true,
        source: payload?.source || null,
        action: payload?.action || 'start',
      })
    case 'switchLocalVectorProfile':
      if (payload?.confirmed !== true) throw new Error('switching the local vector profile requires explicit confirmation')
      return await switchLocalVectorProfile({ id: payload?.id, force: payload?.force === true })
    case 'rollbackLocalVectorProfile':
      if (payload?.confirmed !== true) throw new Error('rolling back the local vector profile requires explicit confirmation')
      return await rollbackLocalVectorProfile()
    case 'abortLocalVectorMigration':
      return abortLocalVectorMigration()
    case 'testLocalVector':
      return await testLocalVector()
    case 'savePrompt': {
      const key = String(payload?.key || '')
      const text = String(payload?.text ?? '')
      return { prompt: savePromptOverride(key, text), prompts: promptMeta(getPromptStates()) }
    }
    case 'resetPrompt': {
      const key = String(payload?.key || '')
      return { prompt: resetPrompt(key), prompts: promptMeta(getPromptStates()) }
    }
    case 'resetAllPrompts': {
      return { prompts: resetAllPrompts().map((s) => ({ ...s })) }
    }
    case 'getEngineSizes':
      // Deliberately separate from getState: walking a venv is slow, and the
      // settings page must paint before it finishes.
      return { sizes: engineVersionSizes() }
    case 'getEngine':
      return engineView()
    case 'getActivityLog':
      return {
        events: await decorateLogRows(ctx, listEvents({
          limit: payload?.limit,
          kind: payload?.kind,
          level: payload?.level,
          scope: payload?.scope,
          sessionId: payload?.sessionId,
          since: payload?.since,
          q: payload?.q,
        })),
        stats: logStats(),
      }
    case 'getConsolidationFeed':
      return await consolidationFeed(ctx, payload)
    case 'clearConsolidationFailures': {
      // 侧边栏失败提醒的"清除"：只删 consolidate 且 ok=false 的行。返回删除条数和
      // 清除后的新 feed，客户端直接回填，不用二次拉取。
      const cleared = clearEvents({ kind: 'consolidate', ok: false })
      return { cleared: cleared.removed, feed: await consolidationFeed(ctx, payload) }
    }
    case 'clearActivityLog':
      // Bulk diagnostic evidence removal is destructive; the adjacent delete /
      // archive paths require an explicit confirmation and this one used to be a
      // single accidental click away.
      if (payload?.confirmed !== true) throw new Error('clearing the activity log requires explicit confirmation')
      return clearEvents()
    default:
      throw new Error(`unknown endpoint: ${endpoint}`)
  }
}

export function registerRpc(ctx) {
  try {
    ctx.inject(['connection', 'webServer'], (c) => {
      c.effect(
        () => {
          const route = {
          kind: 'prefix',
          path: ENDPOINT,
          handler: async (req, res) => {
            // Capability probe, not a version check: `requestRejection` exists on
            // 0.1.2-rc.x and later of dsh-client-connection and not at all on the rc.8
            // / 0.1.1-rc.2 copies, where the service only exposes
            // `isTrustedApiRequest`. Calling it blindly threw a TypeError out of the
            // request handler, which the host turns into a 500 — an unauthenticated
            // caller then learned the route exists instead of being refused.
            const rejection = typeof c.connection?.requestRejection === 'function'
              ? c.connection.requestRejection(req)
              : undefined
            if (rejection !== undefined) {
              const status = rejection === 401 ? 401 : 403
              res.writeHead(status)
              res.end(status === 401 ? 'unauthorized' : 'forbidden')
              return
            }
            const requestUrl = new URL(req.url || '/', 'http://dsh.internal')
            const pathname = requestUrl.pathname
              .replace(/^\/dsh-memu(?=\/|$)/, ENDPOINT)
            // Entry inventory (§10 P0 audit): dispatch is reachable from exactly
            // three places, each behind authorizeLibraryRoute — the export/import
            // URL routes below (authorized before any body or media read), the
            // GET attachment route (same), and the generic POST gate after the
            // envelope parse. Every other GET here serves static UI bytes or 405s;
            // no handler code path reaches dispatch without passing one gate.
            const exportMatch = /^\/dsh-memu-memory\/export\/([A-Za-z0-9._-]+)\.zip$/.exec(pathname)
            if (req.method === 'GET' && exportMatch) {
              const sessionId = requestUrl.searchParams.has('sessionId') ? requestUrl.searchParams.get('sessionId') : undefined
              if (!await authorizeLibraryRoute(c.connection, req, 'exportLibrary', { libraryId: exportMatch[1], ...(sessionId !== undefined ? { sessionId } : {}) })) {
                rejectLibraryRoute(res)
                return
              }
              try {
                const payload = await dispatch(ctx, 'exportLibrary', { libraryId: exportMatch[1] })
                await streamMediaExport(exportMatch[1], payload, res)
              } catch { if (!res.headersSent) { res.writeHead(400); res.end('attachment export unavailable') } }
              return
            }
            const importMatch = /^\/dsh-memu-memory\/import\/([A-Za-z0-9._-]+)\.zip$/.exec(pathname)
            if (req.method === 'POST' && importMatch) {
              const sessionId = requestUrl.searchParams.has('sessionId') ? requestUrl.searchParams.get('sessionId') : undefined
              if (!await authorizeLibraryRoute(c.connection, req, 'importMemories', { libraryId: importMatch[1], ...(sessionId !== undefined ? { sessionId } : {}) })) {
                rejectLibraryRoute(res)
                return
              }
              try {
                const bundle = await importMediaStream(importMatch[1], req)
                const value = await dispatch(ctx, 'importMemories', { libraryId: importMatch[1], memories: bundle.memories, graph: bundle.graph })
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
                res.end(JSON.stringify({ ok: true, value: { ...value, missingAttachments: bundle.missing } }))
              } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
                res.end(JSON.stringify({ ok: false, error: { message: rpcErrorMessage(error) } }))
              }
              return
            }
            if (req.method === 'GET' && pathname.startsWith('/dsh-memu-memory/ui-assets/')) {
              const asset = standaloneAsset(pathname)
              const type = pathname.endsWith('.png') ? 'image/png' : pathname.endsWith('.svg') ? 'image/svg+xml' : 'application/javascript; charset=utf-8'
              res.writeHead(asset === null ? 404 : 200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' })
              res.end(asset || '')
              return
            }
            if (req.method === 'GET' && (pathname === SETTINGS_PATH || pathname === `${SETTINGS_PATH}/`)) {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
              res.end(standaloneHtml())
              return
            }
            const attachment = /^\/dsh-memu-memory\/attachment\/([A-Za-z0-9._-]+)\/([a-f0-9]{64})$/.exec(pathname)
            if (req.method === 'GET' && attachment) {
              const sessionId = requestUrl.searchParams.has('sessionId') ? requestUrl.searchParams.get('sessionId') : undefined
              if (!await authorizeLibraryRoute(c.connection, req, 'getAttachment', { libraryId: attachment[1], ...(sessionId !== undefined ? { sessionId } : {}) })) {
                rejectLibraryRoute(res)
                return
              }
              try {
                const thumbnail = await attachmentThumbnail({ libraryId: attachment[1], sha256: attachment[2], sessionId: sessionId ?? null })
                if (!thumbnail) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end('attachment missing'); return }
                res.writeHead(200, { 'Content-Type': thumbnail.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' })
                res.end(thumbnail.data)
              } catch (error) {
                res.writeHead(error.status || 503, { 'Cache-Control': 'no-store' })
                res.end(error.status === 403 ? 'forbidden' : 'attachment unavailable')
              }
              return
            }
            // The standalone memory wall. Same origin, so the RPC below passes the
            // same auth check the host's own client does.
            if (req.method === 'GET' && (pathname === WEBUI_PATH || pathname === `${WEBUI_PATH}/`)) {
              res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
              })
              res.end(webUiHtml())
              return
            }
            if (req.method !== 'POST') {
              res.writeHead(405, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: { code: 'dsh-memu-memory/bad-request', message: 'expected POST', details: {} } }))
              return
            }
            const endpoint = pathname.startsWith(`${ENDPOINT}/`)
              ? pathname.slice(ENDPOINT.length + 1)
              : undefined
            if (!endpoint) {
              res.writeHead(404)
              res.end()
              return
            }
            const chunks = []
            let size = 0
            for await (const chunk of req) {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
              size += buf.byteLength
              if (size > 2 * 1024 * 1024) {
                res.writeHead(413, { 'Content-Type': 'application/json', connection: 'close' })
                res.end(JSON.stringify({ ok: false, error: { code: 'dsh-memu-memory/too-large', message: 'body too large', details: {} } }))
                req.destroy()
                return
              }
              chunks.push(buf)
            }
            let envelope
            try {
              envelope = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: { code: 'dsh-memu-memory/bad-request', message: 'body is not JSON', details: {} } }))
              return
            }
            if (!envelope || envelope.type !== 'client-request' || typeof envelope.rpcId !== 'string' || typeof envelope.method !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: { code: 'dsh-memu-memory/bad-request', message: 'invalid client-request envelope', details: {} } }))
              return
            }
            let result
            if (envelope.method !== endpoint) {
              result = {
                ok: false,
                error: {
                  code: 'dsh-memu-memory/bad-request',
                  message: `method ${envelope.method} does not match endpoint ${endpoint}`,
                  details: {},
                },
              }
            } else {
              const payload = envelope.payload || {}
              if (!await authorizeLibraryRoute(c.connection, req, endpoint, payload)) {
                rejectLibraryRoute(res)
                return
              }
              try {
                result = { ok: true, value: await dispatch(ctx, endpoint, payload) }
              } catch (error) {
                result = {
                  ok: false,
                  error: {
                    code: error?.code || 'dsh-memu-memory/error',
                    message: rpcErrorMessage(error),
                    details: {},
                  },
                }
              }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result }))
          },
          }
          const disposers = [c.webServer.register(route), c.webServer.register({ ...route, path: '/dsh-memu' })]
          return () => { for (const dispose of disposers) dispose?.() }
        },
        'dsh-memu-memory: rpc',
      )
      try { c.logger?.info?.(`dsh-memu-memory: rpc route ${ENDPOINT} registered`) } catch {}
      // 自定义整理 route 的进程级清理（lib/fork-model.js）：plugin 卸载/停用时把在宿主
      // llm 注册表挂的 dsh-memu-custom route 卸下来。幂等；未注册时是 no-op。这里没有
      // index.js 的改动额度，registerRpc 恰好拥有一个随宿主作用域 dispose 的 effect 面，
      // 生命周期跟随 RPC 注册体走是等价的。
      if (typeof c.effect === 'function') {
        c.effect(() => disposeConsolidationRoute, 'dsh-memu-memory: consolidation route')
      }
    })
  } catch (error) {
    try { ctx.logger?.warn?.(`dsh-memu-memory: rpc unavailable: ${error?.message || error}`) } catch {}
  }
}

export { ENDPOINT, dispatch }
