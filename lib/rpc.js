import { ENGINE_VERSION, engineStatus, ensureEngine, switchEngineVersion, readInstallLogTail, fetchAvailableVersions, pruneEngineVersions, removeEngineVersion, engineVersionSizes } from './engine.js'
import {
  DEFAULT_SETTINGS, getSettings, updateSettings, loadState, listLibraries, listArchivedLibraries, getLibrary, createLibrary,
  renameLibrary, archiveLibrary, deleteLibrary, restoreLibrary, libraryScopeMissing, getSessionBinding, setSessionBinding, ensureSession,
  ensureLibraryForCwd, getMemoryBackend,
  deleteSessionBinding, releaseInjected, markReinjectPending, loadPrivateIndex, loadGlobalIndex, saveGlobalIndex, updatePrivateIndex, updateGlobalIndex,
  backupDatabases, listBackups, restoreBackup, deleteBackup, globalDbPath, normalizeCwd, getWorkspacePolicy, listWorkspacePolicies, setWorkspacePolicy,
  storageHealth, effectiveScope, summarizeIndex, getPromptDomains, addPromptDomain, removePromptDomain, memoryRevision, memoryStamp, noteMemoryBeat,
} from './state.js'
import { commit } from './memu.js'
import { privateList, privateUpdate, privateRemember, privateRecall, privateArchive, privateDelete, globalList, globalRecall, domainOf, decayStrength, appliesToDomain, importMemories, resolveMemoryReview, visibleToSession, isMemoryEligible } from './memory.js'
import { normalizeMemoryContext } from './context.js'
import { requestPrivateConsolidation } from './private.js'
import { startGlobalCuration, getCurationJob, cancelCurationJob, listCurationJobs } from './curator.js'
import { maybeMigrateLibraries } from './migrate.js'
import { getPromptStates, savePromptOverride, resetPrompt, resetAllPrompts } from './prompts.js'
import { statsView } from './stats.js'
import { getMemuConfig, saveMemuConfig, setEmbeddingSource, testMemuConfig, getSummaryConfig, getVisionConfig } from './memu-config.js'
import { getLocalVectorState, downloadLocalVectorModel, installLocalVectorRuntime, selectLocalVectorModel, switchLocalVectorProfile, rollbackLocalVectorProfile, abortLocalVectorMigration, testLocalVector } from './local-vector-service.js'
import { webUiHtml, WEBUI_PATH, standaloneHtml, standaloneAsset, SETTINGS_PATH } from './webui.js'
import { getGraph, listEntities, createEntity, renameEntity, deleteEntity, linkEntries, unlinkEntry, getRelationship, updateRelationship, graphExport, restoreGraphData } from './graph.js'
import { getAttachment, attachmentThumbnail, attachmentPreview, exportMediaBundle, importMediaBundle, streamMediaExport, importMediaStream } from './media.js'
import { listEvents, logStats, clearEvents } from './activity-log.js'

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

// List one library's memories. Retrieval needs the MemU engine, but the sidecar
// index holds the same rows, so an engine that is still installing (or broken)
// degrades to the index instead of failing the browser.
async function privateListView(scope) {
  const libraryId = scope.libraryId ?? getSessionBinding(scope.exec ? scope.exec?.agent?.session?.header?.id : null)?.libraryId
  const shape = (id, e, content) => ({
    id,
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
    attachments: attachmentPreview(libraryId, e || {}),
    context: e?.context || {},
    accessCount: e?.accessCount ?? 0,
    lastAccessAt: e?.lastAccessAt || null,
    createdAt: e?.createdAt || null,
    updatedAt: e?.updatedAt || e?.createdAt || null,
    content: String(content ?? e?.content ?? '').slice(0, 4000),
  })
  try {
    const result = await privateList({ ...scope, preferIndex: true })
    return {
      libraryId: result.libraryId,
      source: result.source || 'engine',
      files: (result.files || []).map((f) => shape(f.name, f.entry, f.content)),
    }
  } catch (error) {
    if (error?.code !== 'MEMU_ENGINE_NOT_READY') throw error
    const index = loadPrivateIndex(libraryId)
    return {
      libraryId,
      source: 'index',
      files: Object.entries(index.entries || {}).filter(([, entry]) => !scope.exec || (isMemoryEligible(entry) && visibleToSession(entry, scope.exec?.agent?.session?.header?.id))).map(([id, e]) => shape(id, e)),
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
    return {
      sessionQuery,
      byId: new Map(records.map((r) => [r.header.id, r])),
    }
  } catch {
    return null
  }
}

async function recentSessions(ctx, limitHint) {
  const catalog = await sessionCatalog(ctx)
  if (!catalog) return []
  const limit = Math.max(1, Math.min(200, Number(limitHint) || 60))
  const filtered = [...catalog.byId.values()].slice(0, limit)
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
        settings: getSettings(),
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
        private: binding?.libraryId && effective?.useLibrary ? preview(privateIndex) : null,
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
        settings: getSettings(),
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
      // even if it never had a library. Turning it off leaves the existing one alone.
      if (patch.useLibrary === true) ensureLibraryForCwd(scopeKey)
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
        'autoInject', 'privateTopK', 'globalTopK', 'anchorTokens', 'turnTokens', 'injectionTotalTokens', 'dedupeTurns',
        'globalEveryNTurns', 'minUserChars', 'mustRememberCap', 'randomCueChance',
        'autoInstallEngine', 'newSessionPromptDismissed', 'newSessionDefault', 'habitsInjection',
        'sleepConsolidation', 'sleepAfterIdleMinutes', 'autoCurateEveryHours',
        'autoCurateSessionLimit', 'purgeArchivedAfterDays', 'memoryMode',
        'shortTermTtlHours',
        'sidebarSettings', 'visionCaptionEnabled',
        'inboundToolNames',
      ]) patch[key] = DEFAULT_SETTINGS[key]
      return updateSettings(patch)
    }
    case 'setSettings': {
      const patch = payload?.patch && typeof payload.patch === 'object' ? payload.patch : {}
      const allowed = new Set([
        'autoInject', 'privateTopK', 'globalTopK', 'anchorTokens', 'turnTokens', 'injectionTotalTokens',
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
      ])
      const clean = {}
      for (const [k, v] of Object.entries(patch)) if (allowed.has(k)) clean[k] = v
      return updateSettings(clean)
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
      const safety = backupDatabases()
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
      return privateListView({ exec: execFor(sessionId) })
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
      // The payload may be the parsed export (memories array) or the raw file text.
      let memories = payload?.memories
      let graphData = payload?.graph || null
      let missingAttachments = 0
      if (payload?.archiveBase64) {
        const archive = importMediaBundle(id, Buffer.from(String(payload.archiveBase64), 'base64'))
        memories = archive.memories
        graphData = archive.graph
        missingAttachments = archive.missing
      }
      if (typeof memories === 'string') {
        let parsed = null
        try { parsed = JSON.parse(memories) } catch { throw new Error('that file is not valid JSON') }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          if (Array.isArray(parsed.memories)) { memories = parsed.memories; graphData = parsed.graph || null }
          else throw new Error('this JSON has no "memories" array')
        } else if (Array.isArray(parsed)) memories = parsed
        else throw new Error('this JSON has no "memories" array')
      }
      if (!Array.isArray(memories)) throw new Error('memories must be an array')
      const result = await importMemories({ libraryId: id, memories })
      if (graphData && result.idMap) restoreGraphData(id, graphData, result.idMap)
      return { libraryId: id, ...result, missingAttachments }
    }
    case 'exportLibrary': {
      const id = String(payload?.libraryId || '')
      const lib = getLibrary(id)
      if (!lib) throw new Error('library not found')
      const index = loadPrivateIndex(id)
      const exported = {
        format: 'dsh-memu-memory-library@1',
        exportedAt: new Date().toISOString(),
        library: { id: lib.id, name: lib.name, scopeKey: lib.scopeKey || null, domain: lib.domain || null },
        memories: Object.entries(index.entries || {}).map(([memId, e]) => ({ id: memId, ...e })),
        graph: graphExport(id),
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
      if (!libraryId) { try { collect(loadGlobalIndex(), null) } catch { errors.push({ libraryId: null, error: 'global index unavailable' }) } }
      items.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
      const limit = Math.max(1, Math.min(1000, Number(payload?.limit) || 300))
      return { items: items.slice(0, limit), total: items.length, libraries, errors }
    }
    case 'getGraph':
      return getGraph(payload || {})
    case 'listEntities':
      return listEntities(payload || {})
    case 'createEntity':
      return createEntity(payload || {})
    case 'renameEntity':
      return renameEntity(payload || {})
    case 'deleteEntity':
      return deleteEntity(payload || {})
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
            evidence: (e.evidence || []).slice(0, 6),
            updatedAt: e.updatedAt || null,
          })),
      }
    }
    case 'resolveReview': {
      return resolveMemoryReview({
        libraryId: payload?.libraryId ? String(payload.libraryId) : null,
        id: String(payload?.id || ''), action: String(payload?.action || ''),
        resolution: payload?.resolution || 'replace', reason: payload?.reason || '',
        content: payload?.content, title: payload?.title,
      })
    }
    case 'generatePrivate': {
      const sessionId = requireSessionId(payload)
      // Explicit button press: the user already decided this conversation is worth
      // summarizing, so the automatic "is there anything in it" gate does not apply.
      return requestPrivateConsolidation(ctx, sessionId, { force: true })
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
      const entry = loadPrivateIndex(libraryId).entries[id]
      if (!entry || !['archived', 'suppressed', 'expired'].includes(entry.status)) throw new Error('only archived memories can be deleted permanently; archive it first')
      const safety = backupDatabases()
      return { ...await privateDelete({ libraryId, id }), safety }
    }
    case 'setup': {
      const status = engineStatus()
      if (status.status !== 'installing') {
        void ensureEngine({ force: payload?.force === true, beforeSwitch: backupDatabases }).catch(() => {})
      }
      return { started: true, engine: engineView() }
    }
    case 'switchEngine': {
      const version = String(payload?.version || '')
      if (!version) throw new Error('version is required')
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
      const result = restoreBackup(String(payload?.name || ''), {
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
    case 'setEmbeddingSource':
      return setEmbeddingSource(String(payload?.source || ''))
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
      return await downloadLocalVectorModel(String(payload?.id || ''), { confirmed: payload?.confirmed === true })
    case 'selectLocalVectorModel':
      return selectLocalVectorModel(String(payload?.id || ''))
    case 'installLocalVectorRuntime':
      return await installLocalVectorRuntime({ modelId: payload?.id || null, confirmed: payload?.confirmed === true })
    case 'switchLocalVectorProfile':
      if (payload?.confirmed !== true) throw new Error('switching the local vector profile requires explicit confirmation')
      return await switchLocalVectorProfile({ id: payload?.id })
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
            const rejection = c.connection.requestRejection(req)
            if (rejection !== undefined) {
              res.writeHead(rejection)
              res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
              return
            }
            const pathname = new URL(req.url || '/', 'http://dsh.internal').pathname
              .replace(/^\/dsh-memu(?=\/|$)/, ENDPOINT)
            const exportMatch = /^\/dsh-memu-memory\/export\/([A-Za-z0-9._-]+)\.zip$/.exec(pathname)
            if (req.method === 'GET' && exportMatch) {
              try {
                const payload = await dispatch(ctx, 'exportLibrary', { libraryId: exportMatch[1] })
                await streamMediaExport(exportMatch[1], payload, res)
              } catch { if (!res.headersSent) { res.writeHead(400); res.end('attachment export unavailable') } }
              return
            }
            const importMatch = /^\/dsh-memu-memory\/import\/([A-Za-z0-9._-]+)\.zip$/.exec(pathname)
            if (req.method === 'POST' && importMatch) {
              try {
                const bundle = await importMediaStream(importMatch[1], req)
                const value = await dispatch(ctx, 'importMemories', { libraryId: importMatch[1], memories: bundle.memories, graph: bundle.graph })
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
                res.end(JSON.stringify({ ok: true, value: { ...value, missingAttachments: bundle.missing } }))
              } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
                res.end(JSON.stringify({ ok: false, error: { message: String(error.message || error) } }))
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
              try {
                const url = new URL(req.url, 'http://dsh.internal')
                const thumbnail = await attachmentThumbnail({ libraryId: attachment[1], sha256: attachment[2], sessionId: url.searchParams.get('sessionId') })
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
              try {
                result = { ok: true, value: await dispatch(ctx, endpoint, envelope.payload || {}) }
              } catch (error) {
                result = {
                  ok: false,
                  error: {
                    code: error?.code || 'dsh-memu-memory/error',
                    message: String(error?.message || error),
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
    })
  } catch (error) {
    try { ctx.logger?.warn?.(`dsh-memu-memory: rpc unavailable: ${error?.message || error}`) } catch {}
  }
}

export { ENDPOINT, dispatch }
