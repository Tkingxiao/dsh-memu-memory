import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  dataDir, librariesDir, indexDir, backupsDir,
  ensureDir, readJson, readFailure, readFailuresUnder, writeJson, withFileLock, assertJsonShape, warn, stamp, shortHash, libraryIdForScope, isSafeId,
} from './paths.js'
import {
  createBackup, deleteBackupEntry, listBackupEntries, restoreFromBackup,
} from './backup.js'
import { migrateIndexVisibility } from './visibility.js'
import { memuDbFor, memuGlobalDbFor, removeActiveLibrary } from './vector-profile.js'
import { normalizeEmotion, derivedValence } from './mood.js'
import { localCalendarDay } from './temporal.js'

const STATE_FILE = () => path.join(dataDir(), 'state.json')
const GLOBAL_DB = () => path.join(dataDir(), 'global.sqlite3')
const GLOBAL_INDEX = () => path.join(indexDir(), 'global.json')

// Observable outcome of the last backup action; see listBackupEntries().
let lastBackupReport = null

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
  privateTopK: 5,
  globalTopK: 5,
  // Cross-library recall: merge private candidates from other libraries that use
  // the same memory domain. Reading across folders changes the isolation boundary,
  // so it is opt-in; writes still target the bound library only.
  crossLibraryRecall: false,
  anchorTokens: 800,
  // 800 tokens for one recall block. A dense chat calls recall on almost every
  // message, so the injected block has to stay clearly smaller than the message it
  // serves. This is the recall budget, not the whole plugin-message ceiling.
  turnTokens: 800,
  // Whole plugin-message ceiling: anchor + recall + optional cue/texture. It must
  // be at least the sum of the sub-budgets the user wants to allow; the default leaves
  // room for the default anchor and recall blocks.
  injectionTotalTokens: 2000,
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
  // 条件式时效提示（工单 D）：召回块里出现可能过时的记忆时，在末尾追加一个
  // <memory-freshness>，让有搜索工具的模型先核实，没有就如实说明。默认开；
  // freshnessDays 是"写得够久"的口径，不在模块里另设默认。
  freshnessHint: true,
  freshnessDays: 30,
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
  // Group chat arrives in bursts, but a burst is seconds apart and the per-turn
  // timestamps already cover that. Two idle minutes still separates "reading a
  // diff / thinking" from "gone", and keeps the per-run window small.
  sleepAfterIdleMinutes: 2,
  // 主动记忆：分数门槛、饥饿阈值（空闲超过它无条件检查）、两种抑制冷却（分钟；整理冷却默认 0，
  // 薄证据的重复 fork 由评分拦截，只有用户显式配置才启用硬冷却）。
  activeMemoryMinScore: 0.8,
  activeMemoryStarvationMinutes: 15,
  activeMemoryCooldownMinutes: 0,
  activeMemoryRecallCooldownMinutes: 15,
  // 全局提炼的审核放行（§4.10）：'auto' 只暂扣冲突、缺证据与高风险改写；
  // 'review-all' 把全部内容操作送进复核。硬门在两档下都生效。
  curatorReviewMode: 'auto',
  autoCurateEveryHours: 0,
  autoCurateSessionLimit: 8,
  // 'local' keeps every memory on this machine; 'cloud' hands MemU's own backend
  // the storage, which is the vendor path and off by default.
  memoryMode: 'local',
  // Who turns a conversation into memory. 'agent' means the conversation's own
  // agent writes and summarizes into the JSON index, with no MemU engine and no
  // embedding API. 'api' hands the work to the configured remote MemU service.
  memoryBackend: 'agent',
  vectorSource: 'local',
  habitsInjection: true,
  // 一次性的带日期承诺过期之后的复提间隔（天）。带日期 + open_loop 的过期条目不走
  // 3 天年龄门槛，也不会因为“提过一次”永久沉默；它按这个间隔重复，直到被关闭或归档。
  // 它和普通 3 天腿共用每回合 limit 1，dated 过期腿优先。
  openLoopRemindDays: 7,
  // 工单 E：纪念日到点唤醒。它真的会改变宿主行为——用公开的 ctx.schedule 在绑定会话里
  // 开一整回合——所以默认关闭，必须由用户显式打开。salientWakeHour 是该回合的本地墙上
  // 时间（HH:mm）；salientWakeTimeZone 为空表示跟随系统时区，非空必须是有效 IANA 区。
  salientWake: 'off',
  salientWakeHour: '09:00',
  salientWakeTimeZone: '',
  // 整理 fork 的模型选择（三模式）。'inherit' 沿用父会话的 provider/model；'host' 用
  // consolidationModel（"<provider>/<model>"，同 curatorModel 的解析口径）指名宿主已
  // 激活的 route；'custom' 用 consolidationCustom* 在宿主 llm 注册表挂本插件私有 route
  // （lib/fork-model.js CONSOLIDATION_CUSTOM_ROUTE）。fork 的 AgentOptions 没有
  // baseURL/apiKey 通道，自定义端点只能走注册 route，所以 custom 的连接四件套存在这里。
  // apiKey 落盘在 state.json（与 ~/.memu/config.env 的 0600 同一信任域），但任何 RPC
  // 回包只给 has/tail 打码视图——rpc.js 的 redactConsolidationSettings。
  consolidationModelMode: 'inherit',
  consolidationModel: null,
  // 1.3.1：整理 fork 的思考强度独立于父会话。'inherit' 保持旧行为；'off' /
  // 'medium' / 'low' / 'high' 直接覆盖，用于成本/质量的 A/B。
  consolidationReasoningEffort: 'medium',
  consolidationCustomBaseURL: '',
  consolidationCustomApiKey: '',
  consolidationCustomModel: '',
  consolidationCustomApi: 'openai-completions',
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
  const rawSettings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {}
  const legacyVectorSource = rawSettings.vectorSource === 'api' || rawSettings.vectorSource === 'local'
    ? rawSettings.vectorSource
    : (rawSettings.memoryMode === 'cloud' ? 'api' : 'local')
  return {
    ...base,
    ...raw,
    settings: { ...base.settings, ...rawSettings, vectorSource: legacyVectorSource },
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

// Codes that mean "the store was momentarily unavailable", not "this write can never
// succeed". Only these are re-armed; a read-only filesystem or a corrupt path would
// otherwise retry forever at FLUSH_MS.
const RETRYABLE_FLUSH_CODES = ['DSH_MEMU_STORE_BUSY', 'EPERM', 'EBUSY', 'EACCES']

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    try {
      flushState()
    } catch (error) {
      warnSinkSafe(`state flush failed: ${error?.message || error}`)
      if (RETRYABLE_FLUSH_CODES.includes(error?.code)) scheduleFlush()
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
  try {
    return withFileLock(STATE_FILE(), flushStateLocked)
  } catch (error) {
    // S-10: the timer was already cleared above, so a failed flush used to leave the
    // pending bookkeeping dirty with nothing scheduled — one busy lock was enough to
    // strand inbound pending / lastRecallError / sleepRetryAt in memory until the next
    // unrelated write (or a crash). Re-arm before rethrowing so the batch is retried;
    // the caller still sees the error.
    warnSinkSafe(`state flush failed: ${error?.message || error}`)
    if (RETRYABLE_FLUSH_CODES.includes(error?.code)) scheduleFlush()
    throw error
  }
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

// Single route authority for automatic memory reads and writes.
export function effectiveVectorRoute(settings = loadState().settings) {
  if (settings?.memoryBackend !== 'api') return 'lexical'
  return settings?.vectorSource === 'api' ? 'remote-api' : 'managed-local'
}

export function vectorBackendEnabled(settings = loadState().settings) {
  return effectiveVectorRoute(settings) !== 'lexical'
}

export function updateSettings(patch) {
  const clean = {}
  const ranges = {
    privateTopK: [1, 20], globalTopK: [1, 20], anchorTokens: [160, 8000], turnTokens: [80, 8000],
    injectionTotalTokens: [160, 16000],
    relevanceThreshold: [0, 1], dedupeTurns: [0, 200], globalEveryNTurns: [0, 200], minUserChars: [0, 1000],
    freshnessDays: [1, 3650],
    mustRememberCap: [1, 100], randomCueChance: [0, 1], shortTermTtlHours: [0, 8760],
    unpinBudgetPerSession: [1, 20], unpinCooldownMinutes: [0, 1440], sleepAfterIdleMinutes: [1, 1440],
    openLoopRemindDays: [1, 365],
    autoCurateEveryHours: [0, 8760], autoCurateSessionLimit: [1, 10], purgeArchivedAfterDays: [0, 36500],
    activeMemoryMinScore: [0, 10], activeMemoryStarvationMinutes: [1, 1440],
    activeMemoryCooldownMinutes: [0, 10080], activeMemoryRecallCooldownMinutes: [0, 10080],
  }
  const enums = { autoInject: ['smart', 'anchor-only', 'per-turn', 'off'], memoryMode: ['local', 'cloud'], memoryBackend: ['agent', 'api'], vectorSource: ['local', 'api'], newSessionDefault: ['off', 'auto', 'global', 'both'], curatorReviewMode: ['auto', 'review-all'], salientWake: ['off', 'schedule'], consolidationModelMode: ['inherit', 'host', 'custom'], consolidationReasoningEffort: ['inherit', 'off', 'low', 'medium', 'high'], consolidationCustomApi: ['openai-completions', 'openai-responses', 'anthropic-messages'] }
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
    } else if (key === 'consolidationModel') {
      // host 模式的 "<provider>/<model>"。格式本身留给 lib/fork-model.js 的解析口径
      // （与 curatorModel 一致：这里只挡类型与超长），写错的值会在 fork 创建时被
      // invalid-consolidation-model 拒绝并在活动日志里说清，设置页先存的草稿不该被卡死。
      if (value !== null && (typeof value !== 'string' || value.length > 200)) throw new Error('invalid consolidation model')
      clean[key] = value
    } else if (key === 'consolidationCustomBaseURL') {
      // custom 模式的端点。空串是「还没填」，合法；非空必须是不带内嵌凭据的 http(s)
      // URL——与 pipIndexes / vision endpoint 同一把尺（宿主请求头进不了带凭据的 URL）。
      if (typeof value !== 'string') throw new Error('setting consolidationCustomBaseURL must be a string')
      const trimmed = value.trim()
      if (trimmed) {
        try {
          const url = new URL(trimmed)
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('bad protocol')
        } catch {
          throw new Error('consolidationCustomBaseURL must be an HTTP(S) URL without embedded credentials')
        }
      }
      clean[key] = trimmed
    } else if (key === 'consolidationCustomApiKey') {
      // custom 模式选填的明文 key（本地网关可以没有）。落盘在 state.json，回包只给
      // 打码视图（rpc.js）；这里只挡类型与荒谬长度，两头空白顺手去掉。
      if (typeof value !== 'string' || value.length > 500) throw new Error('invalid consolidation custom api key')
      clean[key] = value.trim()
    } else if (key === 'consolidationCustomModel') {
      // custom 模式必填的模型 id。允许 '/'（openrouter 风格的嵌套 id），只挡类型与长度。
      if (typeof value !== 'string' || value.length > 200) throw new Error('invalid consolidation custom model')
      clean[key] = value.trim()
    } else if (key === 'salientWakeHour') {
      // 定时唤醒的本地墙上时间。只收 HH:mm，不收 "9:00"：宿主的 at 输入按 HH:mm[:ss]
      // 解释，少一位会被拒或读成别的时刻，宁可在设置页就拒绝。
      if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('setting salientWakeHour must be HH:mm')
      clean[key] = value
    } else if (key === 'salientWakeTimeZone') {
      // 空串是"跟随系统"，是合法配置，不在这里解析成具体城市；非空必须是有效 IANA 区，
      // 否则宿主的 at 计时会在投递时被拒（invalid_time_zone），排了也不会响。
      if (typeof value !== 'string' || value.length > 100) throw new Error('invalid salientWakeTimeZone')
      const zone = value.trim()
      if (zone) {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: zone })
        } catch {
          throw new Error(`invalid salientWakeTimeZone: ${zone}`)
        }
      }
      clean[key] = zone
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
  const activeVectorDb = removeActiveLibrary(id)
  const legacyVectorDb = path.join(librariesDir(), id + '.sqlite3')
  delete state.libraries[id]
  for (const [sessionId, binding] of Object.entries(state.sessions || {})) {
    if (binding?.libraryId === id) delete state.sessions[sessionId]
  }
  saveState(state)
  const removed = []
  const vectorPrefix = id + '.'
  const vectorGenerationFiles = fs.existsSync(librariesDir())
    ? fs.readdirSync(librariesDir()).filter(name => name.startsWith(vectorPrefix) && name.endsWith('.sqlite3')).map(name => path.join(librariesDir(), name))
    : []
  for (const file of [activeVectorDb, legacyVectorDb, ...vectorGenerationFiles, ...['json', 'entities.json', 'media.json', 'stats.json'].map(suffix => path.join(indexDir(), `${id}.${suffix}`))]) {
    if (!file) continue
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
    // 锚点哨兵不进 injectedIds：它是一份常驻提示，不是会被 400 条上限挤掉的记忆 id。
    // 单独记 anchorPushed，避免长会话里周期性把 ~800 token 的锚点当新消息重投。
    const incoming = ids || []
    // 旧 binding 可能把哨兵存在 injectedIds 里：迁移为 anchorPushed，之后只按标记判断。
    const anchor = incoming.includes('__anchor__') || (binding.injectedIds || []).includes('__anchor__')
    const merged = [...new Set([
      ...(binding.injectedIds || []).filter((id) => id !== '__anchor__'),
      ...incoming.filter((id) => id !== '__anchor__'),
    ])]
    binding.injectedIds = merged.slice(-400)
    if (anchor) binding.anchorPushed = true
    const at = { ...(binding.injectedAt || {}) }
    for (const id of incoming) at[id] = turn ?? Date.now()
    binding.injectedAt = at
    binding.lastInjectedTurn = turn ?? binding.lastInjectedTurn ?? 0
    // 主动记忆抑制要一个"最近一次真正注入了记忆"的墙钟时间；turn 号不能跨会话比较。
    binding.lastInjectedAt = stamp()
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

// The session's running mood is a retrieval lens on the binding, not a fact about
// the user: it must never be recalled as a stored memory.
export function setSessionMood(sessionId, mood) {
  // 给了 emotion 就以四轴为准，valence 只是投影；只有 valence 的旧形状原样存，不反推四轴。
  const emotion = normalizeEmotion(mood?.emotion ?? null)
  const bounded = (raw, min, max) => Math.max(min, Math.min(max, Number.isFinite(raw) ? raw : 0)) // 显式 0 是读数的一部分，不能用 `|| 默认值`
  return setSessionBinding(sessionId, { mood: {
    valence: emotion ? derivedValence(emotion) : bounded(mood?.valence, -1, 1),
    emotion, arousal: bounded(mood?.arousal, 0, 1), dominance: bounded(mood?.dominance, -1, 1), at: Date.now(),
  } })
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

// ── repeated open loops ────────────────────────────────────────────────────────
// A dated promise that has already slipped its day keeps coming back on an interval
// instead of being forgotten. The regular 3-day nudge records its ids in
// `injectedIds`, which is right for "I already mentioned this once" and wrong for
// "it was never closed"; that is why the overdue leg keeps its own clock.
//
// `openLoopRemindedAt` maps memoryId -> ISO timestamp of the last time the overdue
// nudge actually reached the prompt. Entries older than 90 days are dropped on
// write so the map cannot grow without bound (an old key would not suppress
// anything anyway — the interval has long elapsed).
const OPEN_LOOP_REMIND_PRUNE_MS = 90 * 86_400_000

function localDayKeyOf(date) {
  return localCalendarDay(date)
}

function prunedOpenLoopReminded(sessionId, now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now)
  const nowMs = nowDate.getTime()
  const map = getSessionBinding(sessionId)?.openLoopRemindedAt
  const fresh = {}
  if (!map || typeof map !== 'object') return fresh
  for (const [memoryId, iso] of Object.entries(map)) {
    const at = Date.parse(String(iso || ''))
    if (!Number.isFinite(at)) continue
    if (nowMs - at > OPEN_LOOP_REMIND_PRUNE_MS) continue
    fresh[memoryId] = map[memoryId]
  }
  return fresh
}

/**
 * Whether an overdue open loop was already repeated on this local calendar day.
 * A session binding written before this field existed has no map: it is a first
 * reminder, not an error.
 */
export function wasOpenLoopRemindedToday(sessionId, memoryId, now = new Date()) {
  if (!sessionId || !memoryId) return false
  const iso = getSessionBinding(sessionId)?.openLoopRemindedAt?.[memoryId]
  const at = Date.parse(String(iso || ''))
  if (!Number.isFinite(at)) return false
  return localDayKeyOf(at) === localDayKeyOf(now)
}

export function markOpenLoopReminded(sessionId, memoryId, at = new Date()) {
  if (!sessionId || !memoryId) return null
  // No binding means no conversation to remind; creating a stub from here would
  // write half a session into state.json.
  if (!getSessionBinding(sessionId)) return null
  const when = at instanceof Date ? at : new Date(at)
  const reminded = prunedOpenLoopReminded(sessionId, when)
  reminded[memoryId] = when.toISOString()
  return setSessionBinding(sessionId, { openLoopRemindedAt: reminded })
}

/**
 * 记下"这一回合投放了哪些一次性内容"，供宿主把整轮回滚时撤销记账（§3.24）。
 * 同一个 hostTurn 多次调用会把 ids 并起来：一步里可能同时投了锚点、纪念日与 nudge。
 */
export function recordInjectionRollback(sessionId, { hostTurn, ids = [], guideKey = null, nudgeIds = [], anniversaryIds = [] } = {}) {
  const turn = Number(hostTurn)
  if (!sessionId || !Number.isSafeInteger(turn) || turn < 0) return null
  if (!getSessionBinding(sessionId)) return null
  return updateState((state) => {
    const binding = state.sessions[sessionId]
    if (!binding) return state
    const previous = binding.injectionRollback
    const same = previous && previous.hostTurn === turn ? previous : { ids: [], nudgeIds: [], anniversaryIds: [] }
    binding.injectionRollback = {
      hostTurn: turn,
      ids: [...new Set([...(same.ids || []), ...ids])].slice(-400),
      nudgeIds: [...new Set([...(same.nudgeIds || []), ...nudgeIds])].slice(-40),
      anniversaryIds: [...new Set([...(same.anniversaryIds || []), ...anniversaryIds])].slice(-40),
      guideKey: guideKey || same.guideKey || null,
    }
    return state
  }).sessions[sessionId].injectionRollback
}

/**
 * §3.24 —— 宿主会把「请求根本没发出去」的整轮回滚（连用户消息都不留在转录里，真机实测如此），
 * 可插件在"消息交回决策"之后就记账了：于是 guide 与锚点这类一次性内容**再也不会投**，整段对话
 * 直到下次压缩都没有记忆总览，且一声不吭。回合失败时把那一轮写下的记账撤回来。
 * 只有与 `recordInjectionRollback` 记的同一个 hostTurn 对得上才生效；「该不该撤」由调用方按
 * 转录实证判定（inject.js 的 injectionAdmissions），所以走到这里的内容确实没进转录，
 * 下一轮重投不会出现第二份。返回撤回了什么，供活动日志留信号。
 */
export function rollbackInjectionForTurn(sessionId, hostTurn) {
  const turn = Number(hostTurn)
  if (!sessionId || !Number.isSafeInteger(turn)) return null
  let rolled = null
  updateState((state) => {
    const binding = state.sessions[sessionId]
    const record = binding?.injectionRollback
    if (!binding || !record || record.hostTurn !== turn) return state
    const ids = new Set(record.ids || [])
    if (ids.size) {
      binding.injectedIds = (binding.injectedIds || []).filter((id) => !ids.has(id))
      if (binding.injectedAt) for (const id of ids) delete binding.injectedAt[id]
    }
    // 哨兵已不再进 injectedIds，必须单独撤掉它的"已投"标记，否则回滚后锚点不再重投。
    if (ids.has('__anchor__')) delete binding.anchorPushed
    if (record.guideKey && binding.guideRulesKey === record.guideKey) {
      delete binding.guideRulesKey
      delete binding.guideMessageAt
    }
    if (binding.anniversariesShown) for (const id of record.anniversaryIds || []) delete binding.anniversariesShown[id]
    if (binding.openLoopRemindedAt) for (const id of record.nudgeIds || []) delete binding.openLoopRemindedAt[id]
    rolled = {
      ids: [...ids],
      guideKey: record.guideKey || null,
      anniversaries: (record.anniversaryIds || []).length,
      nudges: (record.nudgeIds || []).length,
    }
    delete binding.injectionRollback
    return state
  })
  return rolled
}

/**
 * 回合收尾、但那份记账不该作废时消费掉它（正常完成，或失败时注入的消息其实已经进了转录）：
 * 东西已经投出去了，之后再来一条迟到的 error 事件也不该把它撤回（否则就是凭空的第二次锚点/规则消息）。
 */
export function consumeInjectionRollback(sessionId, hostTurn) {
  const turn = Number(hostTurn)
  if (!sessionId || !Number.isSafeInteger(turn)) return false
  let consumed = false
  updateState((state) => {
    const binding = state.sessions[sessionId]
    if (!binding?.injectionRollback || binding.injectionRollback.hostTurn !== turn) return state
    delete binding.injectionRollback
    consumed = true
    return state
  })
  return consumed
}

export function memoryDbPath(libraryId) {
  ensureDir(librariesDir())
  return effectiveVectorRoute() === 'managed-local' ? memuDbFor(libraryId) : path.join(librariesDir(), `${libraryId}.sqlite3`)
}

export function globalDbPath() {
  ensureDir(dataDir())
  return effectiveVectorRoute() === 'managed-local' ? memuGlobalDbFor() : GLOBAL_DB()
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

/**
 * Persist one library index.
 *
 * `bumpRevision: false` exists for writes that cannot change what recall would find:
 * the injector's own bookkeeping (injectCount / lastInjectAt) runs *after* every
 * successful injection, so bumping the revision there guaranteed that the next turn's
 * recall and BM25 corpus both missed. The write still happens, still notifies
 * listeners and still records the write event — only the "something a cached result
 * depends on changed" claim is withheld, because it is not true.
 */
export function savePrivateIndex(libraryId, index, { bumpRevision = true } = {}) {
  if (!isSafeId(libraryId)) throw new Error('invalid library id')
  if (!validIndex(index)) throw new Error('invalid memory index shape')
  const file = path.join(indexDir(), `${libraryId}.json`)
  const saved = writeIndex(file, index)
  if (bumpRevision) bumpMemoryRevision()
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

export function saveGlobalIndex(index, { bumpRevision = true } = {}) {
  if (!validIndex(index)) throw new Error('invalid memory index shape')
  writeIndex(GLOBAL_INDEX(), index)
  if (bumpRevision) bumpMemoryRevision()
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

/**
 * Creates a managed backup of the local memory stores (plugin state, indexes,
 * prompts, attachments, the vector journal and every MemU database), then keeps
 * the newest BACKUP_KEEP complete ones. Retention, staging, checksums, atomic
 * publish and the shared lock all live in lib/backup.js so there is exactly one
 * place that decides what a backup is and which backup may be deleted.
 *
 * Returns the published directory: callers (engine switch, library delete,
 * scripts) treat the return value as a path.
 */
export async function backupDatabases(options = {}) {
  // Pending bookkeeping changes live in memory for up to 50ms; a backup taken
  // before a flush would silently capture the previous state.
  let report
  try {
    report = await createBackup({ ...options, flushState })
  } catch (error) {
    // A refusal is the safety property working, not something to swallow: a
    // database the engine could not snapshot aborts the backup, and the reason
    // has to stay visible on the same channel the panel already reads.
    lastBackupReport = {
      at: stamp(),
      action: 'create',
      status: 'failed',
      code: error?.code || null,
      error: String(error?.message || error),
      name: null,
      dir: null,
      files: 0,
      bytes: 0,
      snapshots: [],
      pruned: [],
      pruneFailed: [],
      pendingCleanup: 0,
      notice: null,
    }
    throw error
  }
  lastBackupReport = { at: stamp(), action: 'create', ...report }
  return report.dir
}

/** What the last backup/restore/prune did, so the outcome stays observable. */
export function lastBackupReportView() {
  return lastBackupReport ? { ...lastBackupReport } : null
}

/** Newest first, including entries that failed to complete (reported, never deleted). */
export function listBackups() {
  return listBackupEntries()
}

/** Removes one backup directory. The name is validated, never used as a path. */
export function deleteBackup(name) {
  const result = deleteBackupEntry(name)
  lastBackupReport = { at: stamp(), action: 'delete', ...result }
  return { deleted: result.deleted, status: result.status }
}

/**
 * Puts a backup back. The target is leased and its whole inventory is verified
 * before anything is written; the live root is saved as a safety backup next;
 * only then are files replaced. Failure leaves a recovery path: the safety
 * backup holds the state that was replaced and retention may not delete it.
 * A backup that predates the vector journal also retires the stale live
 * vector-active pointer, so recall falls back to text instead of querying
 * databases that no longer match the restored index.
 */
export async function restoreBackup(name, { beforeRestore = null, keep = undefined } = {}) {
  const result = await restoreFromBackup(name, { beforeRestore, flushState, clearCaches, keep })
  lastBackupReport = { at: stamp(), action: 'restore', ...result }
  return result
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

/**
 * P2-5: explicit session-binding GC. Idle time is not an automatic deletion
 * trigger (docs/binding-lifecycle.md); this is a dry-run-first maintenance call.
 * A binding with no parseable lastTurnAt is never a candidate.
 */
/**
 * Session-binding garbage collection.
 *
 * This deletes bindings, which is not recoverable. Three guards, because the old
 * version had none and a `--days 0` invocation wiped every binding in the store:
 *
 *   · `olderThanDays` must be strictly positive. Zero/negative is a mistake, not a
 *     "clean everything" request, so it throws instead of quietly becoming one.
 *   · `isBusy(sessionId)` lets the caller veto a candidate: a session with a live
 *     consolidation lease is in the middle of writing, and lastTurnAt is not the only
 *     clock that matters.
 *   · the apply pass re-reads each candidate inside `updateState`. A dry-run and an
 *     apply are two separate loads, and a conversation that woke up in between must
 *     not be deleted on the strength of the earlier snapshot.
 */
export function pruneSessionBindings({ olderThanDays = 30, dryRun = true, now = Date.now(), isBusy = null } = {}) {
  const days = Number(olderThanDays)
  if (!Number.isFinite(days) || days <= 0) throw new Error('olderThanDays must be a positive number of days')
  const cutoff = Number(now) - days * 86_400_000
  const state = loadState()
  const candidates = []
  const skipped = []
  for (const [sessionId, binding] of Object.entries(state.sessions || {})) {
    const at = Date.parse(String(binding?.lastTurnAt || ''))
    if (!Number.isFinite(at) || at >= cutoff) continue
    if (typeof isBusy === 'function') {
      let busy = false
      try { busy = isBusy(sessionId) === true } catch (error) {
        // An unreadable lease file is not permission to delete: treat it as busy.
        busy = true
        warn(`prune-session-bindings: liveness check failed for ${sessionId} (${error?.message || error}); kept`)
      }
      if (busy) {
        skipped.push({ sessionId, reason: 'a consolidation lease is still live' })
        continue
      }
    }
    candidates.push({ sessionId, lastTurnAt: binding.lastTurnAt, libraryId: binding.libraryId || null })
  }
  const base = {
    dryRun: dryRun !== false,
    olderThanDays: days,
    cutoff: new Date(cutoff).toISOString(),
    candidates,
    skipped,
  }
  if (dryRun !== false || candidates.length === 0) return { ...base, removed: [] }
  const removed = []
  const revalidated = []
  updateState((next) => {
    for (const item of candidates) {
      const current = next.sessions?.[item.sessionId]
      if (!current) continue
      const at = Date.parse(String(current.lastTurnAt || ''))
      // Same predicate as the candidate pass, on the fresh copy: `at < cutoff` alone
      // would still delete a binding that just came back with a stale lastTurnAt.
      if (!Number.isFinite(at) || at >= cutoff) { revalidated.push(item.sessionId); continue }
      delete next.sessions[item.sessionId]
      removed.push(item.sessionId)
    }
    return next
  })
  return { ...base, removed, revalidated }
}
