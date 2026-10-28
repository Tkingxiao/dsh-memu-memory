import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  dataDir, librariesDir, indexDir, backupsDir,
  ensureDir, readJson, readFailure, readFailuresUnder, writeJson, withFileLock, assertJsonShape, warn, stamp, shortHash, libraryIdForScope, isSafeId,
} from './paths.js'
import { migrateIndexVisibility } from './visibility.js'

const STATE_FILE = () => path.join(dataDir(), 'state.json')
const GLOBAL_DB = () => path.join(dataDir(), 'global.sqlite3')
const GLOBAL_INDEX = () => path.join(indexDir(), 'global.json')

export const DEFAULT_SETTINGS = {
  sidebarSettings: false,
  visionCaptionEnabled: true,
  // Only these named tools may carry the explicit inbound protocol in model text.
  // Producer-owned tool meta is the preferred integration and needs no allowlist.
  inboundToolNames: [],
  autoInject: 'smart',
  // These defaults are tuned for high-density chat — a QQ-style group where many
  // short messages arrive per minute, in fragments rather than sentences, and the
  // topic drifts every few of them. Under that cadence the failure mode is not
  // "too little memory", it is noise: a per-turn block sized for paragraph-long
  // prompts drowns the conversation it was meant to help. So the per-turn budgets
  // are small, and the windows that stop repetition are measured in many turns.
  privateTopK: 3,
  globalTopK: 2,
  anchorTokens: 700,
  // 640 tokens per user turn. A dense chat calls recall on almost every message,
  // so the injected block has to stay clearly smaller than the message it serves.
  turnTokens: 640,
  relevanceThreshold: 0.4,
  // 16 turns is a couple of minutes of group traffic. The old 8 expired inside a
  // single burst, so the same entry came back every minute or two.
  dedupeTurns: 16,
  // Every 6 turns instead of 3: the global layer is cross-conversation and drags
  // foreign context in, and three turns of dense chat is nothing at all.
  globalEveryNTurns: 6,
  // 6 characters is about one short CJK clause. 12 skipped most of what a group
  // chat actually says — recall was off in exactly the conversations that wanted
  // it. "嗯" / "好" / "收到" (2-3 chars) still skip.
  minUserChars: 6,
  // Keep the always-on layer tight: dense chat generates many small candidates,
  // and 16 pins would eat the anchor budget before the anchor starts.
  mustRememberCap: 12,
  // Short-term layer: a memory that only has to survive the arc of one
  // conversation. It expires rather than being deleted, so the idle
  // consolidation pass still gets to promote it to long_term before it goes. 72h
  // spans "we talked about this over the weekend"; 0 disables the layer, and a
  // write with layer=short_term is then refused instead of silently becoming
  // permanent.
  shortTermTtlHours: 72,
  // Prompt pages beyond 通用. Each one owns a set of `<key>.<domain>.md` overrides
  // and can be assigned to a conversation, so the list is data, not code.
  // All shipped pages stay enabled; a new conversation starts on RP via the
  // binding's domainOverride. Every enabled domain is also offered by the session
  // picker, so these two lists cannot drift apart.
  promptDomains: ['rp', 'coding', 'mixed'],
  // Unpin is the model's own call (see memory.js privateUnpin). These two are the
  // guardrails that replaced the human marker: a per-conversation quota and a
  // cooldown, both small on purpose.
  unpinBudgetPerSession: 2,
  unpinCooldownMinutes: 3,
  // Rolled once per user turn: at dense cadence 5% means a cue every ~20 turns,
  // which reads as constant interruption. 2% keeps it rare.
  randomCueChance: 0.02,
  newSessionPromptDismissed: false,
  // What "remember my choice" stores: off | auto | both.
  newSessionDefault: 'both',
  curatorModel: null,
  autoInstallEngine: true,
  pipIndexes: [],
  // Fresh installs start with the plugin fully alive: auto-install, the
  // new-session prompt, domestic texture, and idle consolidation are all on.
  // These stay ordinary switches, and an existing saved choice is preserved.
  sleepConsolidation: true,
  // Group chat arrives in bursts. 8 idle minutes is long enough to know a burst
  // ended, short enough that fragments do not sit unconsolidated all day.
  sleepAfterIdleMinutes: 8,
  autoCurateEveryHours: 0,
  autoCurateSessionLimit: 8,
  // 'local' keeps every memory on this machine; 'cloud' hands MemU's own backend
  // the storage, which is the vendor path and off by default.
  memoryMode: 'local',
  // Who turns a conversation into memory. 'agent' means the conversation's own
  // agent writes and summarizes into the JSON index, with no MemU engine and no
  // embedding API. 'api' hands the work to the configured remote MemU service.
  memoryBackend: 'agent',
  habitsInjection: true,
  // A positive age marks cleanup candidates; deletion always needs a user action.
  purgeArchivedAfterDays: 0,
}

function defaultState() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    libraries: {},
    sessions: {},
    // Per-folder memory switches. Keyed by the normalized scope key (the same key
    // a library uses), so a folder keeps its choice even before it has a library.
    workspacePolicies: {},
  }
}

function mergeState(raw) {
  const base = defaultState()
  if (!raw || typeof raw !== 'object') return base
  return {
    ...base,
    ...raw,
    settings: { ...base.settings, ...(raw.settings || {}) },
    libraries: raw.libraries && typeof raw.libraries === 'object' ? raw.libraries : {},
    sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
    workspacePolicies: raw.workspacePolicies && typeof raw.workspacePolicies === 'object' ? raw.workspacePolicies : {},
  }
}

// A user turn touches the bookkeeping fields 6-7 times (see P0-4). Each write
// used to be a full read + full rewrite of state.json. The cache below coalesces
// those into one trailing write; memory indexes deliberately do NOT go through
// it, because losing a memory is not the same as losing "which turn injected
// what". Cache validity is checked against mtime+size so an external writer
// (backup, another profile) is never silently shadowed.
const FLUSH_MS = 50
let cache = null
let dirty = false
let flushTimer = null

function statOf(file) {
  try { return fs.statSync(file) } catch { return null }
}

function adoptCache(state, fromReadFailure = false, base = null) {
  const stat = statOf(STATE_FILE())
  cache = {
    dir: dataDir(),
    state,
    base: structuredClone(base || state),
    // True when this cache content is a *fallback* built from defaults because
    // the file could not be read — not the on-disk truth. A fallback must never
    // be written back: that would replace real bindings/libraries with defaults.
    fromReadFailure,
    mtimeMs: stat ? stat.mtimeMs : 0,
    size: stat ? stat.size : -1,
  }
  return state
}

export function loadState() {
  const dir = dataDir()
  if (cache && cache.dir === dir) {
    if (dirty) return cache.state
    const stat = statOf(STATE_FILE())
    if (!stat) {
      // Gone from disk while we hold a good copy: keep it and put it back.
      dirty = true
      scheduleFlush()
      return cache.state
    }
    // A fallback cache never satisfies the mtime check: it is not the on-disk
    // truth, so keep re-reading until the file reads cleanly again.
    if (!cache.fromReadFailure && stat.mtimeMs === cache.mtimeMs && stat.size === cache.size) return cache.state
  }
  dirty = false
  let raw = readJson(STATE_FILE(), null)
  if (raw !== null) raw = assertJsonShape(STATE_FILE(), raw, value => value && typeof value === 'object' && !Array.isArray(value)
    && ['libraries', 'sessions', 'settings', 'workspacePolicies'].every(key => value[key] === undefined || value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])))
  // Distinguish "no file yet" (writing defaults is harmless) from "read failed"
  // (writing defaults would destroy the real state still on disk).
  const failed = readFailure(STATE_FILE()) !== null
  return adoptCache(mergeState(raw), failed)
}

export function saveState(state) {
  // Carry the fallback marker over: saving new content does not make a
  // previously-failed read trustworthy.
  const previous = cache?.dir === dataDir() ? cache : null
  adoptCache(state, previous?.fromReadFailure === true, previous?.base)
  if (previous) { cache.mtimeMs = previous.mtimeMs; cache.size = previous.size }
  dirty = true
  bumpMemoryRevision()
  flushState()
  return state
}

export function updateState(fn) {
  const state = structuredClone(loadState())
  const next = fn(state) || state
  if (cache) cache.state = next
  dirty = true
  scheduleFlush()
  return next
}

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    try {
      flushState()
    } catch (error) {
      warnSinkSafe(`state flush failed: ${error?.message || error}`)
      if (['DSH_MEMU_STORE_BUSY', 'EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) scheduleFlush()
    }
  }, FLUSH_MS)
  flushTimer.unref?.()
}

/** Writes any pending bookkeeping change now. Safe to call when clean. */
export function flushState() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!dirty || !cache) return
  return withFileLock(STATE_FILE(), flushStateLocked)
}

function mergeChanges(base, local, disk) {
  if (JSON.stringify(base) === JSON.stringify(local)) return structuredClone(disk)
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!object(base) || !object(local) || !object(disk)) return structuredClone(local)
  const next = { ...disk }
  for (const key of new Set([...Object.keys(base), ...Object.keys(local)])) {
    if (JSON.stringify(base[key]) === JSON.stringify(local[key])) continue
    if (!Object.hasOwn(local, key)) delete next[key]
    else next[key] = mergeChanges(base[key], local[key], disk[key])
  }
  return next
}

function flushStateLocked() {
  if (!cache.fromReadFailure) {
    // A read can race another process's rename before its post-read stat.
    // Always merge the disk truth under the lock; mtime/size is not a transaction.
    const disk = readJson(STATE_FILE(), null)
    if (readFailure(STATE_FILE())) throw new Error('state.json changed but could not be read; pending changes retained')
    cache.state = mergeChanges(cache.base, cache.state, mergeState(disk))
  }
  try {
    writeJson(STATE_FILE(), cache.state)
  } catch (error) {
    if (error?.code !== 'dsh-memu-memory/read-failed') throw error
    // The write barrier is set only while the file is unreadable. Re-probe: a
    // successful read clears it, so a transient EBUSY does not freeze the plugin
    // until restart. If it is still unreadable this write throws again.
    const diskRaw = readJson(STATE_FILE(), null)
    if (readFailure(STATE_FILE()) !== null) throw error
    if (cache.fromReadFailure) {
      // The pending write was built on top of a *fallback* state, not the real
      // one. Writing it now would overwrite good data with defaults. Adopt the
      // disk truth instead and drop the pending fallback write.
      warn('state.json read failed earlier; discarding changes made against the fallback state to avoid overwriting real data')
      adoptCache(mergeState(diskRaw), false)
      dirty = false
      return
    }
    writeJson(STATE_FILE(), cache.state)
  }
  dirty = false
  noteMemoryWrite('state', null)
  const stat = statOf(STATE_FILE())
  cache.mtimeMs = stat ? stat.mtimeMs : 0
  cache.size = stat ? stat.size : -1
  cache.base = structuredClone(cache.state)
}

function warnSinkSafe(message) {
  warn(message)
}

export function getSettings() {
  return loadState().settings
}

/**
 * Files that failed to read and are now write-protected, plus quarantined
 * copies left behind. Surfaced by `memu_status` so a silent storage fault is
 * visible instead of becoming "my memories vanished".
 */
export function storageHealth() {
  const issues = readFailuresUnder(dataDir()).map((failure) => {
    const relative = path.relative(dataDir(), failure.file).replace(/\\/g, '/')
    const { file, ...rest } = failure
    return { file: relative, ...rest }
  })
  const quarantined = []
  for (const [dir, prefix] of [[dataDir(), ''], [indexDir(), 'index/']]) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.includes('.corrupt-')) quarantined.push(`${prefix}${name}`)
      }
    } catch {}
  }
  return { issues, quarantined }
}

// The default is deliberately the self-contained path: a fresh install must be
// able to remember without MemU, Ollama, or any vendor key.
export function getMemoryBackend() {
  return loadState().settings?.memoryBackend === 'api' ? 'api' : 'agent'
}

export function updateSettings(patch) {
  const clean = {}
  const ranges = {
    privateTopK: [1, 20], globalTopK: [1, 20], anchorTokens: [160, 8000], turnTokens: [80, 8000],
    relevanceThreshold: [0, 1], dedupeTurns: [0, 200], globalEveryNTurns: [0, 200], minUserChars: [0, 1000],
    mustRememberCap: [1, 100], randomCueChance: [0, 1], shortTermTtlHours: [0, 8760],
    unpinBudgetPerSession: [1, 20], unpinCooldownMinutes: [0, 1440], sleepAfterIdleMinutes: [1, 1440],
    autoCurateEveryHours: [0, 8760], autoCurateSessionLimit: [1, 10], purgeArchivedAfterDays: [0, 36500],
  }
  const enums = { autoInject: ['smart', 'anchor-only', 'per-turn', 'off'], memoryMode: ['local', 'cloud'], memoryBackend: ['agent', 'api'], newSessionDefault: ['off', 'auto', 'global', 'both'] }
  for (const [key, value] of Object.entries(patch || {})) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) continue
    if (enums[key]) {
      if (!enums[key].includes(value)) throw new Error(`invalid setting ${key}`)
      clean[key] = value
    } else if (ranges[key]) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`setting ${key} must be a finite number`)
      const [min, max] = ranges[key]
      clean[key] = Math.max(min, Math.min(max, value))
    } else if (typeof DEFAULT_SETTINGS[key] === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`setting ${key} must be boolean`)
      clean[key] = value
    } else if (key === 'curatorModel') {
      if (value !== null && (typeof value !== 'string' || value.length > 200)) throw new Error('invalid curator model')
      clean[key] = value
    } else if (key === 'pipIndexes' || key === 'promptDomains' || key === 'inboundToolNames') {
      if (!Array.isArray(value) || value.length > 20 || value.some(item => typeof item !== 'string')) throw new Error(`invalid setting ${key}`)
      if (key === 'promptDomains' && value.some(item => !/^[a-z0-9][a-z0-9_-]{0,23}$/.test(item))) throw new Error('invalid domain id')
      if (key === 'inboundToolNames' && value.some(item => !/^[A-Za-z0-9_.:/-]{1,160}$/.test(item))) throw new Error('invalid inbound tool name')
      if (key === 'pipIndexes' && value.some(item => {
        try { const url = new URL(item); return !['http:', 'https:'].includes(url.protocol) || url.username || url.password } catch { return true }
      })) throw new Error('pip indexes must be HTTP(S) URLs without credentials')
      clean[key] = value.slice()
    }
  }
  return updateState((state) => {
    state.settings = { ...state.settings, ...clean }
    return state
  }).settings
}

/**
 * The prompt pages a user can edit and assign. Ids are used as file suffixes and
 * as session domains, so they are restricted to a slug alphabet; `general` is
 * implicit (the base prompt) and never appears here.
 */
export function getPromptDomains() {
  const raw = loadState().settings?.promptDomains
  const list = Array.isArray(raw) ? raw : DEFAULT_SETTINGS.promptDomains
  const seen = new Set()
  const out = []
  for (const value of list) {
    const id = String(value || '').trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9_-]{0,23}$/.test(id) || id === 'general' || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export function addPromptDomain(id) {
  const value = String(id || '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{0,23}$/.test(value)) throw new Error('domain id must be 1-24 chars: a-z, 0-9, - or _')
  if (value === 'general') throw new Error('"general" is the built-in 通用 page')
  const list = getPromptDomains()
  if (list.includes(value)) return list
  return updateSettings({ promptDomains: [...list, value] }).promptDomains
}

export function removePromptDomain(id) {
  const value = String(id || '').trim().toLowerCase()
  const list = getPromptDomains()
  if (!list.includes(value)) return list
  return updateSettings({ promptDomains: list.filter((item) => item !== value) }).promptDomains
}

// Both switches default to on: that is the behaviour every existing folder had
// before this setting existed. Turning the private switch off means "this folder
// keeps no private library", not "delete the one it has" — nothing is ever deleted
// by a switch.
export const DEFAULT_FOLDER_POLICY = { useLibrary: true, useGlobal: true }

function policyFor(state, scopeKey) {
  return { ...DEFAULT_FOLDER_POLICY, ...(state.workspacePolicies?.[scopeKey] || {}) }
}

export function getWorkspacePolicy(scopeKey) {
  const key = normalizeCwd(scopeKey) || '__default__'
  return { scopeKey: key, ...policyFor(loadState(), key) }
}

/**
 * The folder policy is a ceiling, not an initial value. `sessions[].useLibrary`
 * records what the user chose for that conversation; the folder decides how far
 * that choice can go. Storing the wish and computing the effect separately is
 * what lets re-enabling a folder restore each conversation's own choice instead
 * of flipping everything back on.
 */
export function effectiveScope(binding, policy = null) {
  const folder = policy || (binding?.scopeKey ? getWorkspacePolicy(binding.scopeKey) : { ...DEFAULT_FOLDER_POLICY })
  const wantsLibrary = binding ? binding.useLibrary !== false : folder.useLibrary !== false
  const wantsGlobal = binding ? binding.useGlobal !== false : folder.useGlobal !== false
  return {
    folder,
    useLibrary: folder.useLibrary !== false && wantsLibrary,
    useGlobal: folder.useGlobal !== false && wantsGlobal,
    libraryBlocked: folder.useLibrary === false,
    globalBlocked: folder.useGlobal === false,
    enabled: (folder.useLibrary !== false && wantsLibrary) || (folder.useGlobal !== false && wantsGlobal),
  }
}

export function listWorkspacePolicies() {
  const state = loadState()
  return Object.entries(state.workspacePolicies || {})
    .map(([scopeKey, policy]) => ({ scopeKey, ...DEFAULT_FOLDER_POLICY, ...policy }))
}

export function setWorkspacePolicy(scopeKey, patch = {}) {
  const key = normalizeCwd(scopeKey) || '__default__'
  const state = updateState((draft) => {
    draft.workspacePolicies = draft.workspacePolicies || {}
    const next = { ...DEFAULT_FOLDER_POLICY, ...(draft.workspacePolicies[key] || {}) }
    for (const field of ['useLibrary', 'useGlobal']) {
      if (typeof patch[field] === 'boolean') next[field] = patch[field]
    }
    draft.workspacePolicies[key] = { ...next, updatedAt: stamp() }
    const library = Object.entries(draft.libraries)
      .find(([, lib]) => lib.scopeKey === key && lib.archived !== true)
    // Existing conversations are deliberately NOT edited: their switches record
    // what the user chose for that chat, and the folder policy above already
    // clamps them at read time. The only repair worth doing is pointing a
    // conversation at its folder's library once one exists again.
    if (patch.useLibrary === true) {
      for (const binding of Object.values(draft.sessions || {})) {
        const inFolder = binding.scopeKey === key
          || (binding.libraryId && draft.libraries[binding.libraryId]?.scopeKey === key)
        if (inFolder && !binding.libraryId && library) binding.libraryId = library[0]
      }
    }
    return draft
  })
  return { scopeKey: key, ...policyFor(state, key) }
}

export function normalizeCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return ''
  // The no-workspace placeholder is a key, not a path. Resolving it would produce
  // a machine-dependent scope like `d:/somewhere/__default__` and leak a junk
  // library into the list every time a session starts without a folder.
  if (cwd === '__default__') return '__default__'
  let resolved
  try { resolved = path.resolve(cwd) } catch { resolved = cwd }
  let text = resolved.replace(/\\/g, '/').replace(/\/+$/, '')
  if (process.platform === 'win32') text = text.toLowerCase()
  return text
}

export function detectDomain({ agentPreset, cwd } = {}) {
  const text = `${agentPreset || ''} ${cwd || ''}`.toLowerCase()
  if (/(roleplay|role-play|character|persona|rp[-_ ]|沉浸|角色扮演)/.test(text)) return 'rp'
  if (cwd) return 'coding'
  return 'general'
}

export function listLibraries() {
  const state = loadState()
  return Object.entries(state.libraries)
    .filter(([, lib]) => lib.archived !== true)
    .map(([id, lib]) => ({ id, ...lib }))
    .sort((a, b) => String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || '')))
}

export function listLibrariesAll() {
  const state = loadState()
  return Object.entries(state.libraries).map(([id, lib]) => ({ id, ...lib }))
}

export function listArchivedLibraries() {
  const state = loadState()
  return Object.entries(state.libraries)
    .filter(([, lib]) => lib.archived === true)
    .map(([id, lib]) => ({ id, ...lib }))
    // Oldest archived first: the ones nobody revived are the deletion candidates.
    .sort((a, b) => String(a.archivedAt || '').localeCompare(String(b.archivedAt || '')))
}

// A library's scope folder is gone from disk. `__default__` has no folder to check,
// so it never counts as missing.
export function libraryScopeMissing(lib) {
  const key = lib?.scopeKey
  if (!key || key === '__default__') return false
  try {
    return !fs.existsSync(key)
  } catch {
    return false
  }
}

// Hard delete: the sqlite store and its sidecar index leave with the state entry.
// Only ever called on an already-archived library, so the caller had to confirm twice.
export function deleteLibrary(id) {
  if (!isSafeId(id)) throw new Error('invalid library id')
  const state = loadState()
  if (!state.libraries[id]) return { ok: false, error: 'library not found' }
  if (state.libraries[id].archived !== true) return { ok: false, error: 'archive the library before deleting it' }
  delete state.libraries[id]
  for (const [sessionId, binding] of Object.entries(state.sessions || {})) {
    if (binding?.libraryId === id) delete state.sessions[sessionId]
  }
  saveState(state)
  const removed = []
  for (const file of [memoryDbPath(id), ...['json', 'entities.json', 'media.json', 'stats.json'].map(suffix => path.join(indexDir(), `${id}.${suffix}`))]) {
    try {
      if (fs.existsSync(file)) { fs.rmSync(file, { force: true }); removed.push(file) }
    } catch {}
  }
  const attachments = path.join(dataDir(), 'attachments', id)
  if (!path.resolve(attachments).startsWith(path.resolve(dataDir(), 'attachments') + path.sep)) throw new Error('attachment path escaped')
  if (fs.existsSync(attachments)) fs.rmSync(attachments, { recursive: true, force: true })
  return { ok: true, id, removed }
}

export function getLibrary(id) {
  if (!id) return null
  const lib = loadState().libraries[id]
  return lib ? { id, ...lib } : null
}

function uniqueLibraryId(state, scopeKey) {
  let id = libraryIdForScope(scopeKey)
  if (state.libraries[id] && state.libraries[id].scopeKey !== scopeKey) {
    id = `${id}-${shortHash(scopeKey)}`
  }
  return id
}

export function createLibrary({ name, scopeKey, cwd } = {}) {
  const key = normalizeCwd(scopeKey || cwd || name || '__default__')
  const state = loadState()
  const id = uniqueLibraryId(state, key)
  if (state.libraries[id]) return { id, ...state.libraries[id] }
  state.libraries[id] = {
    name: String(name || path.basename(key) || 'Default').slice(0, 80),
    scopeKey: key,
    createdAt: stamp(),
    lastUsedAt: stamp(),
  }
  saveState(state)
  ensureDir(librariesDir())
  return { id, ...state.libraries[id] }
}

export function ensureLibraryForCwd(cwd) {
  const scopeKey = normalizeCwd(cwd) || '__default__'
  const state = loadState()
  const found = Object.entries(state.libraries).find(([, lib]) => lib.scopeKey === scopeKey)
  if (found) {
    found[1].lastUsedAt = stamp()
    // The folder came back: re-binding it revives the library instead of silently
    // writing new memories into an archived one.
    if (found[1].archived) {
      found[1].archived = false
      found[1].archivedAt = null
      found[1].revivedAt = stamp()
    }
    saveState(state)
    return { id: found[0], ...found[1] }
  }
  return createLibrary({ scopeKey, name: scopeKey === '__default__' ? 'Default' : path.basename(scopeKey) })
}

export function renameLibrary(id, name) {
  const state = loadState()
  if (!state.libraries[id]) return null
  state.libraries[id].name = String(name || '').trim().slice(0, 80) || state.libraries[id].name
  saveState(state)
  return { id, ...state.libraries[id] }
}

// A pre-folder build could bind a conversation before its cwd was known, leaving
// one shared "Default" bucket for every workspace. The conversation is the only
// place that still knows the real folder, so when it is opened with a cwd we
// promote that bucket in place: same id, so its memories and index stay attached,
// but the name and scope become the folder a human expects to see.
export function adoptDefaultLibrary(libraryId, cwd) {
  const key = normalizeCwd(cwd)
  if (!key || key === '__default__') return null
  const state = loadState()
  const lib = state.libraries[libraryId]
  if (!lib || normalizeCwd(lib.scopeKey || '') !== '__default__') return null
  const existing = Object.entries(state.libraries)
    .find(([id, other]) => id !== libraryId && other.scopeKey === key && other.archived !== true)
  if (existing) {
    for (const binding of Object.values(state.sessions || {})) {
      if (binding.libraryId === libraryId) {
        binding.libraryId = existing[0]
        binding.scopeKey = key
      }
    }
    // Keep the old bucket recoverable but out of the way when nothing points at it
    // any more. It is never deleted: a mis-detected cwd must not destroy memories.
    const stillBound = Object.values(state.sessions || {}).some((b) => b.libraryId === libraryId)
    if (!stillBound) {
      lib.archived = true
      lib.archivedAt = stamp()
      lib.adoptedInto = existing[0]
    }
    saveState(state)
    return { id: existing[0], ...existing[1], adopted: true, reused: true }
  }
  lib.scopeKey = key
  lib.name = key.split(/[\\/]/).filter(Boolean).pop() || lib.name || 'Default'
  lib.updatedAt = stamp()
  for (const binding of Object.values(state.sessions || {})) {
    if (binding.libraryId === libraryId) binding.scopeKey = key
  }
  saveState(state)
  return { id: libraryId, ...lib, adopted: true }
}

export function archiveLibrary(id) {
  const state = loadState()
  if (!state.libraries[id]) return false
  state.libraries[id].archived = true
  state.libraries[id].archivedAt = stamp()
  saveState(state)
  return true
}

// Registry presence is the signal for both directions: the sweep only calls this for
// a scope that just came back into the workspace list. Checking the disk here would
// contradict the archive rule (removing a workspace keeps its folder on disk, and a
// folder can be absent for reasons that have nothing to do with DSH).
export function restoreLibrary(id) {
  const state = loadState()
  const lib = state.libraries[id]
  if (!lib) return { ok: false, error: 'library not found' }
  lib.archived = false
  lib.archivedAt = null
  lib.revivedAt = stamp()
  lib.lastUsedAt = stamp()
  saveState(state)
  return { ok: true, id, library: { id, ...lib } }
}

export function getSessionBinding(sessionId) {
  if (!sessionId) return null
  const state = loadState()
  return state.sessions[sessionId] || null
}

export function setSessionBinding(sessionId, patch) {
  return updateState((state) => {
    const previous = state.sessions[sessionId] || {}
    state.sessions[sessionId] = { ...previous, ...(patch || {}) }
    return state
  }).sessions[sessionId]
}

export function ensureSession(sessionId, { cwd, agentPreset, libraryId = null, createLibrary = true } = {}) {
  if (!sessionId) throw new Error('ensureSession requires a sessionId')
  const initial = loadState()
  const previous = initial.sessions[sessionId]
  if (previous?.libraryId && initial.libraries[previous.libraryId]) {
    const boundLibrary = initial.libraries[previous.libraryId]
    const libraryScope = normalizeCwd(boundLibrary.scopeKey || '')
    // Repair the old placeholder bucket as soon as the live conversation reveals
    // its folder. Without this, every historical Default library stays mislabelled
    // even though new conversations are correct.
    if (libraryScope === '__default__' && normalizeCwd(cwd)) {
      const adopted = adoptDefaultLibrary(previous.libraryId, cwd)
      if (adopted) {
        const repaired = loadState().sessions[sessionId]
        if (repaired) return repaired
      }
    }
    // A library that already knows its folder but still carries the placeholder
    // name should show the folder too; this is the case the old repair missed.
    const placeholderName = !boundLibrary.name || boundLibrary.name === 'Default' || boundLibrary.name === '__default__'
    if (libraryScope && libraryScope !== '__default__' && placeholderName) {
      boundLibrary.name = libraryScope.split(/[\\/]/).filter(Boolean).pop() || boundLibrary.name || 'Default'
      boundLibrary.updatedAt = stamp()
    }
    boundLibrary.lastUsedAt = stamp()
    saveState(initial)
    return previous
  }
  const scopeKey = normalizeCwd(cwd) || '__default__'
  const policy = policyFor(initial, scopeKey)
  const requested = libraryId && initial.libraries[libraryId] ? libraryId : null
  // A per-conversation switch is the user's choice and must survive every turn:
  // `ensureSession` runs on each step, so overwriting it from the folder policy
  // here used to reset the sidebar toggle constantly. The folder still clamps at
  // read time via effectiveScope().
  const existingBinding = initial.sessions[sessionId]
  const wantsLibrary = existingBinding ? existingBinding.useLibrary !== false : policy.useLibrary !== false
  const wantsGlobal = existingBinding ? existingBinding.useGlobal !== false : policy.useGlobal !== false
  let lib = null
  if (requested) lib = { id: requested, ...initial.libraries[requested] }
  // `createLibrary` governs *creating* a library, never *adopting* one. Tying both
  // to it meant a folder that already had a library still started every new
  // conversation with `libraryId === null` whenever the caller passed
  // `createLibrary: false` — the exact shape of "my memories are gone in a new
  // chat". Re-using the folder's library is not a side effect; it is the point of
  // the folder policy. Archived libraries are skipped here (reviving one is a
  // deliberate act) and creation still needs the switch.
  else if (policy.useLibrary && wantsLibrary) {
    const folder = Object.entries(initial.libraries).find(([, l]) => l.scopeKey === scopeKey && l.archived !== true)
    if (folder) lib = { id: folder[0], ...folder[1] }
    else if (createLibrary) lib = ensureLibraryForCwd(cwd || '__default__')
  }
  const state = loadState()
  const existing = state.sessions[sessionId]
  const binding = {
    ...(existing || {}),
    useLibrary: requested ? true : wantsLibrary,
    useGlobal: wantsGlobal,
    scopeKey,
    domain: existing?.domain || detectDomain({ agentPreset, cwd }),
    // Memory starts on RP unless this conversation already chose a domain. The
    // selector writes an explicit `general` instead of null, so "general" remains
    // a real choice rather than falling back to detection.
    domainOverride: existing?.domainOverride ?? 'rp',
    injectedIds: existing?.injectedIds || [],
    injectedAt: existing?.injectedAt || {},
    lastInjectedTurn: existing?.lastInjectedTurn ?? 0,
    reinjectPending: existing?.reinjectPending || false,
    activeCue: existing?.activeCue || null,
    libraryId: existing?.libraryId && state.libraries[existing.libraryId]
      ? existing.libraryId
      : (lib?.id || null),
  }
  state.sessions[sessionId] = binding
  saveState(state)
  return binding
}

export function deleteSessionBinding(sessionId) {
  return updateState((state) => {
    delete state.sessions[sessionId]
    return state
  })
}

export function markInjected(sessionId, ids, turn) {
  if (!sessionId) return
  return updateState((state) => {
    const binding = state.sessions[sessionId]
    if (!binding) return state
    const merged = [...new Set([...(binding.injectedIds || []), ...(ids || [])])]
    binding.injectedIds = merged.slice(-400)
    const at = { ...(binding.injectedAt || {}) }
    for (const id of ids || []) at[id] = turn ?? Date.now()
    binding.injectedAt = at
    binding.lastInjectedTurn = turn ?? binding.lastInjectedTurn ?? 0
    return state
  })
}

/**
 * Records why the last per-turn recall produced nothing usable. A degraded
 * recall used to be swallowed by an empty catch, which made "memory is dead"
 * indistinguishable from "nothing was relevant" (P0-1).
 */
export function setRecallError(sessionId, message) {
  if (!sessionId) return
  const next = message ? String(message).slice(0, 500) : null
  return updateState((state) => {
    const binding = state.sessions[sessionId]
    if (!binding) return state
    if (next === null) {
      // Only clear when something is there, so a healthy turn costs no write.
      if (binding.lastRecallError) {
        delete binding.lastRecallError
        delete binding.lastRecallErrorAt
      }
      return state
    }
    if (binding.lastRecallError === next) return state
    binding.lastRecallError = next
    binding.lastRecallErrorAt = stamp()
    return state
  })
}

export function releaseInjected(sessionId) {  return updateState((state) => {
    const binding = state.sessions[sessionId]
    if (binding) {
      binding.injectedIds = []
      binding.injectedAt = {}
    }
    return state
  })
}

export function markReinjectPending(sessionId) {
  return setSessionBinding(sessionId, { reinjectPending: true })
}

export function clearReinjectPending(sessionId) {
  return setSessionBinding(sessionId, { reinjectPending: false })
}

export function getActiveCue(sessionId) {
  const binding = getSessionBinding(sessionId)
  const cue = binding?.activeCue
  if (!cue || typeof cue.id !== 'string') return null
  const at = Date.parse(cue.createdAt || '') || 0
  if (!at || Date.now() - at > 30 * 60 * 1000) return null
  return cue
}

export function armCue(sessionId, cue) {
  return setSessionBinding(sessionId, {
    activeCue: {
      id: String(cue.id),
      text: String(cue.text || '').slice(0, 500),
      // A derived cue remembers the memory it came out of. Kept on the binding so the
      // source is auditable while the cue is live, and so the anti-loop rule (a cue-born
      // memory never sources another cue) can be checked against what actually happened.
      sourceId: cue.sourceId ? String(cue.sourceId) : null,
      recallQuery: cue.recallQuery ? String(cue.recallQuery).slice(0, 200) : null,
      createdAt: stamp(),
    },
  })
}

export function consumeCue(sessionId, cueId) {
  const binding = getSessionBinding(sessionId)
  if (!binding?.activeCue || binding.activeCue.id !== cueId) return false
  setSessionBinding(sessionId, { activeCue: null })
  return true
}

// The session's running mood, kept on the binding rather than in a memory entry:
// it is a retrieval lens, not a fact about the user, and must never be recalled
// as a stored memory.
export function setSessionMood(sessionId, mood) {
  return setSessionBinding(sessionId, {
    mood: {
      valence: Math.max(-1, Math.min(1, Number(mood?.valence) || 0)),
      arousal: Math.max(0, Math.min(1, Number(mood?.arousal) || 0)),
      at: Date.now(),
    },
  })
}

export function getSessionMood(sessionId) {
  return getSessionBinding(sessionId)?.mood || null
}

export function setLastSleepAt(sessionId, at) {
  return setSessionBinding(sessionId, { lastSleepAt: at || stamp() })
}

export function getLastSleepAt(sessionId) {
  return getSessionBinding(sessionId)?.lastSleepAt || null
}

export function listSessionBindings() {
  const state = loadState()
  return Object.entries(state.sessions || {}).map(([sessionId, binding]) => ({ sessionId, ...binding }))
}

// The idle clock that sleep consolidation measures against: the last turn the
// plugin actually saw for this session.
export function touchSession(sessionId) {
  return setSessionBinding(sessionId, { lastTurnAt: stamp() })
}

export function getCycleState() {
  return loadState().cycle || {}
}

export function setCycleState(patch) {
  return updateState((state) => {
    state.cycle = { ...(state.cycle || {}), ...(patch || {}) }
    return state
  }).cycle
}

// An anniversary fires once per calendar day per memory, otherwise every turn of
// the day would reopen the same feeling.
export function wasAnniversaryShown(sessionId, memoryId, dayKey) {
  const shown = getSessionBinding(sessionId)?.anniversariesShown
  return Boolean(shown && shown[memoryId] === dayKey)
}

export function markAnniversaryShown(sessionId, memoryId, dayKey) {
  const binding = getSessionBinding(sessionId)
  const shown = { ...(binding?.anniversariesShown || {}) }
  // Keep only the current day's keys so the map cannot grow without bound.
  const fresh = Object.fromEntries(Object.entries(shown).filter(([, v]) => v === dayKey))
  fresh[memoryId] = dayKey
  return setSessionBinding(sessionId, { anniversariesShown: fresh })
}

export function memoryDbPath(libraryId) {
  ensureDir(librariesDir())
  return path.join(librariesDir(), `${libraryId}.sqlite3`)
}

export function globalDbPath() {
  ensureDir(dataDir())
  return GLOBAL_DB()
}

// Index files are parsed on every folder in the sidebar, and the parse (full
// memory text) is the expensive part. Validity is mtime+size, so an external
// change is always picked up. Callers mutate the returned object and save it
// straight away — that is the shape every writer already had.
const indexCache = new Map()
const indexBases = new WeakMap()

// The sidebar paints a snapshot of both indexes, and nothing used to tell it when
// that snapshot had gone stale: a memory written by a tool call, or from the
// settings pane, stayed invisible until the tab was remounted. Readers poll this
// counter and refetch only when it moves, so the cheap path is a single number —
// no entry bodies, no disk read. In-process only; it resets on restart, and that
// is fine because readers compare it against the number they last painted.
let sidebarRevision = 0

function bumpMemoryRevision() {
  sidebarRevision += 1
  return sidebarRevision
}

/** Monotonic within this process; see bumpMemoryRevision. */
export function memoryRevision() {
  return sidebarRevision
}

// Task E observability. A heartbeat is a client poll; a write event is a save that
// actually reached disk. Both are in-process timestamps (they reset with the host),
// and `memu_status` prints them so "the pane is stale" can be told apart from
// "nothing was written" and from "the pane never polled".
let lastBeatAt = null
let lastWriteEvent = null

export function noteMemoryBeat() {
  lastBeatAt = Date.now()
}

function noteMemoryWrite(kind, libraryId) {
  lastWriteEvent = { kind, libraryId: libraryId || null, at: Date.now() }
}

export function syncActivity() {
  return { lastBeatAt, lastWrite: lastWriteEvent }
}

// The counter above is per-process, and not every write happens in this process:
// a tool call served by another module instance, a curator job, or a second window
// can save an index while this counter stays put. That is exactly how the sidebar
// ended up needing a manual Refresh — the heartbeat compared a number only the
// writer's process could move. This fingerprint is the half both processes share:
// size and mtime of every file a memory write touches. A handful of statSync calls
// is cheaper than parsing one index, and it cannot go stale.
export function memoryStamp() {
  const parts = []
  const add = (file, label) => {
    try {
      const info = fs.statSync(file)
      parts.push(label + ":" + info.size + ":" + Math.round(info.mtimeMs))
    } catch {
      parts.push(label + ":-")
    }
  }
  add(STATE_FILE(), "state")
  add(GLOBAL_INDEX(), "global")
  let names = []
  try { names = fs.readdirSync(indexDir()).filter((name) => name.endsWith(".json")).sort() } catch {}
  for (const name of names) add(path.join(indexDir(), name), name)
  return parts.join("|")
}

function cachedIndex(file, loader, normalize) {
  const cached = indexCache.get(file)
  const stat = statOf(file)
  if (cached && stat && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return indexSnapshot(cached.index, normalize)
  const index = loader()
  // Never cache a fallback produced by a failed read: it would keep shadowing the
  // real file (whose mtime/size did not change) even after the read recovers.
  if (stat && !readFailure(file)) indexCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, index })
  return indexSnapshot(index, normalize)
}

// `normalize` upgrades the *view* (a level an older version stored), while the baseline
// stays exactly what is on disk. That split is what lets an ordinary write persist the
// upgrade: `writeIndex` diffs against the baseline, sees the change, and checks the file
// still matches what we read before accepting it.
function indexSnapshot(index, normalize) {
  const baseline = structuredClone(index)
  const copy = structuredClone(index)
  if (normalize) normalize(copy)
  indexBases.set(copy, baseline)
  return copy
}

function rememberIndex(file, index) {
  const stat = statOf(file)
  if (stat) indexCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, index: structuredClone(index) })
}

const indexWriteListeners = new Set()
export function onPrivateIndexWrite(listener) {
  indexWriteListeners.add(listener)
  return () => indexWriteListeners.delete(listener)
}

function writeIndex(file, index) {
  return withFileLock(file, () => {
    const base = indexBases.get(index)
    let next = index
    if (base) {
      const fresh = readJson(file, { version: 1, entries: {} })
      if (!validIndex(fresh)) {
        assertJsonShape(file, fresh, validIndex)
        throw new Error('memory index changed to an invalid shape; restore it before writing')
      }
      next = { ...fresh, entries: { ...(fresh.entries || {}) } }
      const before = base.entries || {}
      for (const id of new Set([...Object.keys(before), ...Object.keys(index.entries || {})])) {
        const value = index.entries?.[id]
        if (JSON.stringify(before[id]) === JSON.stringify(value)) continue
        if (JSON.stringify(before[id]) !== JSON.stringify(next.entries[id])) {
          const error = new Error(`memory ${id} changed concurrently; reload and retry`)
          error.code = 'DSH_MEMU_CONCURRENT_MODIFICATION'
          throw error
        }
        if (value === undefined) delete next.entries[id]
        else next.entries[id] = structuredClone(value)
      }
    }
    writeJson(file, next)
    rememberIndex(file, next)
    return next
  })
}

export function loadPrivateIndex(libraryId) {
  if (!isSafeId(libraryId)) throw new Error('invalid library id')
  const file = path.join(indexDir(), `${libraryId}.json`)
  return cachedIndex(file, () => {
    let raw = readJson(file, null)
    if (raw !== null) raw = assertJsonShape(file, raw, validIndex)
    return raw && typeof raw === 'object' ? { version: 1, entries: raw.entries || {} } : { version: 1, entries: {} }
  }, (index) => {
    // An older version stored `visibility: 'session'` (a lease on one conversation).
    // That level is gone; libraries written by it are read as `shared` here — the one
    // chokepoint every reader and writer passes through — so no consumer has to know
    // the level ever existed. Only the view is upgraded; the baseline stays the raw file
    // so the next ordinary write persists the conversion (see `indexSnapshot`).
    migrateIndexVisibility(index, stamp())
  })
}

export function savePrivateIndex(libraryId, index) {
  if (!isSafeId(libraryId)) throw new Error('invalid library id')
  if (!validIndex(index)) throw new Error('invalid memory index shape')
  const file = path.join(indexDir(), `${libraryId}.json`)
  const saved = writeIndex(file, index)
  bumpMemoryRevision()
  noteMemoryWrite('private', libraryId)
  for (const listener of indexWriteListeners) {
    try { listener(libraryId, saved) } catch (error) { warn(`memory sidecar update failed: ${error?.message || error}`) }
  }
}

export function loadGlobalIndex() {
  return cachedIndex(GLOBAL_INDEX(), () => {
    let raw = readJson(GLOBAL_INDEX(), null)
    if (raw !== null) raw = assertJsonShape(GLOBAL_INDEX(), raw, validIndex)
    return raw && typeof raw === 'object' ? { version: 1, entries: raw.entries || {} } : { version: 1, entries: {} }
  })
}

function validIndex(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.entries && typeof value.entries === 'object' && !Array.isArray(value.entries)
    && Object.values(value.entries).every(entry => entry && typeof entry === 'object' && !Array.isArray(entry))
}

export function saveGlobalIndex(index) {
  if (!validIndex(index)) throw new Error('invalid memory index shape')
  writeIndex(GLOBAL_INDEX(), index)
  bumpMemoryRevision()
  noteMemoryWrite('global', null)
}

/** Counts only — no titles, no text. Cheap enough to call per folder. */
export function summarizeIndex(index) {
  const entries = Object.values(index?.entries || {})
  const live = entries.filter((e) => e && !['archived', 'suppressed', 'expired', 'pending_review', 'superseded'].includes(e.status)
    && (!e.expiresAt || Date.parse(e.expiresAt) > Date.now()))
  return {
    total: entries.length,
    active: live.length,
    pinned: live.filter((e) => e.layer === 'must_remember').length,
    marginalized: entries.filter((e) => e.marginalized === true).length,
    openLoop: live.filter((e) => e.openLoop === true).length,
    archived: entries.filter((e) => e.status === 'archived').length,
  }
}

/**
 * Read-modify-write of one library index. The mutator is synchronous, so two
 * calls can never interleave. Callers that await a backend write (MemU commit,
 * a consolidation job) must reach for this *after* the await — reading before it
 * and saving after is the lost-update window this exists to close (P0-4).
 */
export function updatePrivateIndex(libraryId, mutator) {
  if (!isSafeId(libraryId)) throw new Error('invalid library id')
  return withFileLock(path.join(indexDir(), `${libraryId}.json`), () => {
    indexCache.delete(path.join(indexDir(), `${libraryId}.json`))
    const index = loadPrivateIndex(libraryId)
    const next = mutator(index) || index
    if (next?.then) throw new Error('index mutators must be synchronous')
    savePrivateIndex(libraryId, next)
    return next
  })
}

export function updateGlobalIndex(mutator) {
  return withFileLock(GLOBAL_INDEX(), () => {
    indexCache.delete(GLOBAL_INDEX())
    const index = loadGlobalIndex()
    const next = mutator(index) || index
    if (next?.then) throw new Error('index mutators must be synchronous')
    saveGlobalIndex(next)
    return next
  })
}

export function newMemoryId(prefix = 'mem') {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
}

export function backupDatabases() {
  // Pending bookkeeping changes live in memory for up to 50ms; a backup taken
  // before a flush would silently capture the previous state.
  flushState()
  const dest = path.join(backupsDir(), stamp().replace(/[:.]/g, '-'))
  ensureDir(dest)
  ensureDir(path.join(dest, 'libraries'))
  ensureDir(path.join(dest, 'index'))
  // The prompt manifest copy below silently no-opped without this directory —
  // an empty catch swallowed the ENOENT and backups shipped without it.
  ensureDir(path.join(dest, 'prompts'))
  const copy = (from, to) => {
    let info
    try { info = fs.lstatSync(from) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    if (!info.isFile()) throw new Error(`backup refuses non-file: ${path.basename(from)}`)
    fs.copyFileSync(from, to)
  }
  copy(STATE_FILE(), path.join(dest, 'state.json'))
  copy(GLOBAL_DB(), path.join(dest, 'global.sqlite3'))
  copy(GLOBAL_INDEX(), path.join(dest, 'index', 'global.json'))
  copy(path.join(dataDir(), 'prompts', 'manifest.json'), path.join(dest, 'prompts', 'manifest.json'))
  try {
    for (const name of fs.readdirSync(librariesDir())) {
      if (name.endsWith('.sqlite3') || name.endsWith('.sqlite3-wal') || name.endsWith('.sqlite3-shm')) {
        copy(path.join(librariesDir(), name), path.join(dest, 'libraries', name))
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  try {
    for (const name of fs.readdirSync(indexDir())) {
      if (name.endsWith('.json')) copy(path.join(indexDir(), name), path.join(dest, 'index', name))
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const copyTree = (source, target) => {
    let names
    try { names = fs.readdirSync(source, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    ensureDir(target)
    for (const item of names) {
      if (item.isSymbolicLink()) throw new Error('backup refuses symbolic links')
      if (item.isDirectory()) copyTree(path.join(source, item.name), path.join(target, item.name))
      else copy(path.join(source, item.name), path.join(target, item.name))
    }
  }
  copyTree(path.join(dataDir(), 'attachments'), path.join(dest, 'attachments'))
  copyTree(path.join(dataDir(), 'prompts'), path.join(dest, 'prompts'))

  // A backup whose integrity nobody can check is only a hope. Hash every file so
  // a restore can refuse a truncated or half-written copy.
  const files = {}
  const walk = (dir, prefix = '') => {
    let names = []
    try { names = fs.readdirSync(dir) } catch { return }
    for (const name of names) {
      const full = path.join(dir, name)
      let stat = null
      try { stat = fs.statSync(full) } catch { continue }
      if (stat.isDirectory()) { walk(full, `${prefix}${name}/`); continue }
      let sha256 = null
      try { sha256 = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') } catch {}
      files[`${prefix}${name}`] = { bytes: stat.size, sha256 }
    }
  }
  walk(dest)
  const current = engineCurrentSafe()
  writeJson(path.join(dest, 'manifest.json'), {
    version: 1,
    createdAt: stamp(),
    engine: current ? { version: current.version, schemaVersion: current.schemaVersion || null } : null,
    files,
  })
  return dest
}

function engineCurrentSafe() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), 'engine', 'current.json'), 'utf8'))
  } catch {
    return null
  }
}

export function listBackups() {
  let names = []
  try { names = fs.readdirSync(backupsDir()) } catch { return [] }
  return names
    .map((name) => {
      const dir = path.join(backupsDir(), name)
      let stat = null
      try { stat = fs.statSync(dir) } catch { return null }
      if (!stat.isDirectory()) return null
      const manifest = readJson(path.join(dir, 'manifest.json'), null)
      const fileCount = manifest?.files ? Object.keys(manifest.files).length : null
      const bytes = manifest?.files
        ? Object.values(manifest.files).reduce((sum, f) => sum + Number(f.bytes || 0), 0)
        : null
      return {
        name,
        dir,
        createdAt: manifest?.createdAt || stat.mtime.toISOString(),
        engine: manifest?.engine || null,
        files: fileCount,
        bytes,
        hasManifest: Boolean(manifest),
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.name).localeCompare(String(a.name)))
}

/** Removes one backup directory. The name is validated, never used as a path. */
export function deleteBackup(name) {
  if (!isSafeId(name)) throw new Error('invalid backup name')
  const dir = path.join(backupsDir(), name)
  if (!fs.existsSync(dir)) throw new Error(`backup not found: ${name}`)
  fs.rmSync(dir, { recursive: true, force: true })
  return { deleted: name }
}

/**
 * Puts a backup back. The current state is backed up first, so a restore is
 * itself reversible. Nothing is written until the target verifies, and the
 * in-memory caches are dropped so the next read sees the restored files.
 */
export function restoreBackup(name, { beforeRestore = null } = {}) {
  if (!isSafeId(name)) throw new Error('invalid backup name')
  const dir = path.join(backupsDir(), name)
  if (!fs.existsSync(dir)) throw new Error(`backup not found: ${name}`)
  const manifest = readJson(path.join(dir, 'manifest.json'), null)
  if (manifest?.files) {
    for (const [rel, info] of Object.entries(manifest.files)) {
      const full = path.join(dir, rel)
      if (!full.startsWith(path.resolve(dir) + path.sep) || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error('invalid backup manifest path')
      if (!fs.existsSync(full)) throw new Error(`backup is incomplete: ${rel} is missing`)
      if (info.sha256) {
        const actual = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
        if (actual !== info.sha256) throw new Error(`backup is corrupt: ${rel} failed its checksum`)
      }
    }
  }
  const safety = typeof beforeRestore === 'function' ? beforeRestore() : backupDatabases()
  const copy = (from, to) => {
    if (!fs.existsSync(from)) return
    ensureDir(path.dirname(to))
    fs.copyFileSync(from, to)
  }
  copy(path.join(dir, 'state.json'), STATE_FILE())
  copy(path.join(dir, 'global.sqlite3'), GLOBAL_DB())
  copy(path.join(dir, 'index', 'global.json'), GLOBAL_INDEX())
  copy(path.join(dir, 'prompts', 'manifest.json'), path.join(dataDir(), 'prompts', 'manifest.json'))
  for (const [sub, target] of [['index', indexDir()], ['libraries', librariesDir()]]) {
    let names = []
    try { names = fs.readdirSync(path.join(dir, sub)) } catch { continue }
    for (const file of names) copy(path.join(dir, sub, file), path.join(target, file))
  }
  const restoreTree = (from, target) => {
    let items
    try { items = fs.readdirSync(from, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const item of items) {
      if (item.isSymbolicLink()) throw new Error('restore refuses symbolic links')
      if (item.isDirectory()) restoreTree(path.join(from, item.name), path.join(target, item.name))
      else copy(path.join(from, item.name), path.join(target, item.name))
    }
  }
  restoreTree(path.join(dir, 'attachments'), path.join(dataDir(), 'attachments'))
  restoreTree(path.join(dir, 'prompts'), path.join(dataDir(), 'prompts'))
  // The restored files are the truth now; anything cached describes the state
  // that was just replaced.
  clearCaches()
  return { restored: name, safety }
}

/** Drops the in-memory mirrors so the next read comes from disk. */
export function clearCaches() {
  cache = null
  dirty = false
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  indexCache.clear()
  // A restore or an external edit replaced the files under us; the sidebar must
  // not keep painting what it read before.
  bumpMemoryRevision()
  noteMemoryWrite('restore', null)
}
