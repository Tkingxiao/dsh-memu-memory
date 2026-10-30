import path from 'node:path'
import { dataDir, readJson, writeJson, withFileLock, stamp, shortHash } from './paths.js'

// C 包：整理的持久账本。
//
// 旧的整理只有一条 lastSleepSeq：它同时承担了「收到多少证据」「检查到哪」「这次跑没跑完」
// 三种含义，于是任何一种失败都会把三种含义一起推错——失败被记成已整理，或者完成被记成没做。
// 这里把它们分开：
//   pending   收到但还没检查完的边界（有新证据就前进，失败不会丢）
//   checked   已经有凭证、确认覆盖过的边界（只有 completed/带 reasonCode 的 skipped 才前进）
//   inflight  进行中的快照 + 租约（jobId、scopeGeneration、leaseUntil），重启后按租约过期回收
// 账本是插件自己的最小状态，写在数据目录里（state.json 由 state.js 管，本包不越界改它）：
// 一个 JSON 文件、每次改动都走 withFileLock + tmp/rename，读到坏文件时禁止覆盖。

export const CONSOLIDATION_LEDGER_VERSION = 1
export const DEFAULT_LEASE_MS = 15 * 60_000
export const HISTORY_LIMIT = 12
export const OPERATION_LIMIT = 200
const LEDGER_FILE = 'consolidation.json'

export function ledgerPath() {
  return path.join(dataDir(), LEDGER_FILE)
}

function emptyLedger() {
  return { version: CONSOLIDATION_LEDGER_VERSION, sessions: {} }
}

export function loadLedger() {
  const raw = readJson(ledgerPath(), null)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyLedger()
  const sessions = raw.sessions && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions) ? raw.sessions : {}
  return { version: CONSOLIDATION_LEDGER_VERSION, sessions }
}

function writeLedger(ledger) {
  writeJson(ledgerPath(), ledger)
  return ledger
}

// 读-改-写必须在锁里完成：两个会话同时整理会各写一份完整文件，
// 后写的会把前一个的 inflight 抹掉，于是「同一段转录被 fork 两次」。
function mutateLedger(fn) {
  const box = { result: null }
  withFileLock(ledgerPath(), () => {
    const ledger = loadLedger()
    box.result = fn(ledger)
    writeLedger(ledger)
  })
  return box.result
}

function ensureEntry(ledger, sessionId) {
  const key = String(sessionId || '')
  const existing = ledger.sessions[key]
  const entry = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}
  entry.pending = entry.pending || null
  entry.checked = entry.checked || null
  entry.inflight = entry.inflight || null
  entry.history = Array.isArray(entry.history) ? entry.history : []
  entry.operations = entry.operations && typeof entry.operations === 'object' && !Array.isArray(entry.operations) ? entry.operations : {}
  entry.attempts = Number(entry.attempts) || 0
  ledger.sessions[key] = entry
  return entry
}

function clampText(value, max = 300) {
  const text = String(value || '')
  return text.length > max ? text.slice(0, max) : text
}

/**
 * 父授权指纹：库、文件夹、领域、开关、记忆上下文、记忆归属会话。
 * 任何一项变了，进行中的任务就不再代表父会话当下的授权，必须作废。
 */
export function scopeGenerationOf(binding) {
  if (!binding) return null
  const parts = [
    binding.scopeKey || '', binding.libraryId || '', binding.domainOverride || binding.domain || '',
    binding.useLibrary === false ? '0' : '1', binding.useGlobal === true ? 'g1' : 'g0',
    binding.memoryOwnerSessionId || '', JSON.stringify(binding.memoryContext || {}),
  ]
  return shortHash(parts.join('|'))
}

function pushHistory(entry, record) {
  entry.history.push(record)
  if (entry.history.length > HISTORY_LIMIT) entry.history = entry.history.slice(-HISTORY_LIMIT)
}

function retryAtFrom(now, attempts) {
  const minutes = Math.min(60, 2 ** Math.min(Math.max(1, attempts), 6))
  return new Date(now + minutes * 60_000).toISOString()
}

/** 只读视图：调用方拿不到可变对象，避免绕过锁改账本。 */
export function sessionState(sessionId, ledger = loadLedger()) {
  const entry = ledger.sessions?.[String(sessionId || '')]
  if (!entry) {
    return { sessionId: String(sessionId || ''), pending: null, checked: null, inflight: null, attempts: 0, retryAt: null, lastError: null, lastReasonCode: null, history: [] }
  }
  return structuredClone({
    sessionId: String(sessionId || ''),
    pending: entry.pending || null,
    checked: entry.checked || null,
    inflight: entry.inflight || null,
    attempts: Number(entry.attempts) || 0,
    retryAt: entry.retryAt || null,
    lastError: entry.lastError || null,
    lastReasonCode: entry.lastReasonCode || null,
    history: Array.isArray(entry.history) ? entry.history : [],
  })
}

/** 有新的事件批次到达：只前进 received/pending 边界，不碰 checked。 */
export function noteEvidence({ sessionId, throughSeq, fromSeq = null, at = Date.now() }) {
  const seq = Number(throughSeq)
  if (!Number.isSafeInteger(seq) || seq < 0) return null
  // 每次空闲扫描都会经过这里；边界没动就不要写盘（一个会话一次多余写盘在扫描里没有意义）。
  const seen = Number(loadLedger().sessions?.[String(sessionId || '')]?.pending?.throughSeq)
  if (Number.isSafeInteger(seen) && seen >= seq) {
    return { changed: false, pending: loadLedger().sessions?.[String(sessionId || '')]?.pending || null }
  }
  return mutateLedger((ledger) => {
    const entry = ensureEntry(ledger, sessionId)
    const checkedThrough = Number(entry.checked?.throughSeq)
    const floor = Number.isSafeInteger(checkedThrough) && checkedThrough >= 0 ? checkedThrough + 1 : 0
    const start = Number.isSafeInteger(Number(fromSeq)) && Number(fromSeq) >= 0 ? Math.max(Number(fromSeq), floor) : floor
    const previous = Number(entry.pending?.throughSeq)
    if (Number.isSafeInteger(previous) && previous >= seq) return { changed: false, pending: entry.pending }
    entry.pending = { fromSeq: start, throughSeq: seq, at: new Date(at).toISOString() }
    entry.updatedAt = stamp()
    return { changed: true, pending: entry.pending }
  })
}

/**
 * 开始一个任务。租约没到期就拒绝：这是「同一会话只有一个进行中任务」的持久化版本，
 * 进程重启后仍然有效（in-memory 的 inFlight Map 重启就没了）。
 */
export function beginJob({ sessionId, jobId, snapshot, binding, now = Date.now(), leaseMs = DEFAULT_LEASE_MS }) {
  return mutateLedger((ledger) => {
    const entry = ensureEntry(ledger, sessionId)
    const leaseUntil = Number(entry.inflight?.leaseUntil) || 0
    if (entry.inflight && leaseUntil > now && entry.inflight.jobId !== jobId) {
      return { ok: false, reasonCode: 'lease-held', jobId: entry.inflight.jobId, leaseUntil }
    }
    const generation = scopeGenerationOf(binding)
    entry.inflight = {
      jobId,
      snapshot: snapshot || null,
      startedAt: now,
      leaseUntil: now + leaseMs,
      scopeGeneration: generation,
      checkedVersion: JSON.stringify(entry.checked),
      libraryId: binding?.libraryId || null,
      scopeKey: binding?.scopeKey || null,
    }
    entry.updatedAt = stamp()
    return { ok: true, job: { ...entry.inflight } }
  })
}

export function renewLease({ sessionId, jobId, now = Date.now(), leaseMs = DEFAULT_LEASE_MS }) {
  return mutateLedger((ledger) => {
    const entry = ensureEntry(ledger, sessionId)
    if (!entry.inflight || entry.inflight.jobId !== jobId) return false
    entry.inflight.leaseUntil = now + leaseMs
    entry.updatedAt = stamp()
    return true
  })
}

function pendingFromSnapshot(snapshot, checked, pending) {
  const through = Number(snapshot?.throughSeq)
  if (!Number.isSafeInteger(through) || through < 0) return pending || null
  const checkedThrough = Number(checked?.throughSeq)
  const floor = Number.isSafeInteger(checkedThrough) && checkedThrough >= 0 ? checkedThrough + 1 : 0
  const from = Number.isSafeInteger(Number(snapshot?.fromSeq)) ? Math.max(Number(snapshot.fromSeq), floor) : floor
  const pendingThrough = Number(pending?.throughSeq)
  const finalThrough = Number.isSafeInteger(pendingThrough) ? Math.max(through, pendingThrough) : through
  if (from > finalThrough) return null
  return { fromSeq: from, throughSeq: finalThrough, at: stamp() }
}

function coveredRangeOf(covered, snapshot) {
  if (!covered || !snapshot || !Number.isSafeInteger(covered.fromSeq) || !Number.isSafeInteger(covered.throughSeq)) return null
  if (covered.fromSeq !== snapshot.fromSeq || covered.throughSeq !== snapshot.throughSeq) return null
  return { fromSeq: covered.fromSeq, throughSeq: covered.throughSeq }
}

/**
 * 结束一个任务。只有带凭证的 completed / 带 reasonCode 的 skipped 才推进 checked；
 * 其余（failed / deferred / 格式错误 / 工具不可用）保留 pending，等下一次。
 */
export function completeJob({
  sessionId, jobId, snapshot, covered = null, status, outcome = null,
  reasonCode = null, retryable = false, counts = null, receipt = null, now = Date.now(),
}) {
  return mutateLedger((ledger) => {
    const entry = ensureEntry(ledger, sessionId)
    const job = entry.inflight && entry.inflight.jobId === jobId ? entry.inflight : null
    if (!job || job.leaseUntil <= now || job.checkedVersion !== JSON.stringify(entry.checked)
      || (snapshot && (snapshot.hash !== job.snapshot?.hash || snapshot.fromSeq !== job.snapshot?.fromSeq || snapshot.throughSeq !== job.snapshot?.throughSeq))) {
      return { advanced: false, reasonCode: 'stale-job', checked: entry.checked, pending: entry.pending }
    }
    const jobSnapshot = job.snapshot
    const terminal = status === 'completed' || (status === 'skipped' && Boolean(reasonCode))
    if (job) entry.inflight = null
    entry.lastReasonCode = reasonCode || null
    if (terminal) {
      const range = coveredRangeOf(covered, jobSnapshot)
      const snapshotFrom = Number(jobSnapshot?.fromSeq)
      const snapshotThrough = Number(jobSnapshot?.throughSeq)
      const fullCoverage = range && Number.isSafeInteger(snapshotFrom) && Number.isSafeInteger(snapshotThrough)
        && range.fromSeq === snapshotFrom && range.throughSeq === snapshotThrough
      if (!fullCoverage) {
        entry.pending = pendingFromSnapshot(jobSnapshot, entry.checked, entry.pending)
        entry.lastError = 'a terminal receipt without a covered range cannot advance the checked cursor'
        pushHistory(entry, { jobId, status: 'failed', outcome, reasonCode: 'no-covered-range', at: stamp(), counts })
        entry.updatedAt = stamp()
        return { advanced: false, checked: entry.checked, pending: entry.pending }
      }
      entry.checked = {
        fromSeq: range.fromSeq,
        throughSeq: range.throughSeq,
        at: stamp(),
        status,
        outcome: outcome || 'no_value',
        jobId,
        reasonCode: reasonCode || null,
        snapshotHash: jobSnapshot?.hash || null,
        eventCount: jobSnapshot?.eventCount ?? null,
        receipt: receipt ? { status: receipt.status, outcome: receipt.outcome, reasonCode: receipt.reasonCode || null } : null,
      }
      const pendingThrough = Number(entry.pending?.throughSeq)
      if (entry.pending && (!Number.isSafeInteger(pendingThrough) || pendingThrough <= range.throughSeq)) entry.pending = null
      else if (entry.pending) entry.pending = { fromSeq: range.throughSeq + 1, throughSeq: pendingThrough, at: entry.pending.at }
      entry.attempts = 0
      entry.retryAt = null
      entry.lastError = null
      pushHistory(entry, { jobId, status, outcome: outcome || 'no_value', reasonCode: reasonCode || null, at: stamp(), counts })
      entry.updatedAt = stamp()
      return { advanced: true, checked: entry.checked, pending: entry.pending }
    }
    entry.pending = pendingFromSnapshot(jobSnapshot, entry.checked, entry.pending)
    entry.attempts = Number(entry.attempts) || 0
    if (retryable) {
      entry.attempts += 1
      entry.retryAt = retryAtFrom(now, entry.attempts)
    }
    entry.lastError = clampText(reasonCode || 'not advanced')
    pushHistory(entry, { jobId, status: status || 'failed', outcome, reasonCode, at: stamp(), counts })
    entry.updatedAt = stamp()
    return { advanced: false, checked: entry.checked, pending: entry.pending, retryAt: entry.retryAt || null }
  })
}

/** 失败：清掉 inflight、把范围退回 pending、按尝试次数退避。 */
export function failJob({ sessionId, jobId, reasonCode = 'failed', retryable = true, error = null, now = Date.now() }) {
  return mutateLedger((ledger) => {
    const entry = ensureEntry(ledger, sessionId)
    const job = entry.inflight && entry.inflight.jobId === jobId ? entry.inflight : null
    if (!job) return { stale: true, reasonCode: 'stale-job', pending: entry.pending, retryAt: entry.retryAt || null, attempts: entry.attempts }
    entry.inflight = null
    entry.pending = pendingFromSnapshot(job.snapshot, entry.checked, entry.pending)
    if (retryable) {
      entry.attempts = (Number(entry.attempts) || 0) + 1
      entry.retryAt = retryAtFrom(now, entry.attempts)
    } else {
      // 重试也不会变好（父授权变了、工具面不存在）：记下来但不要每小时再试一次。
      entry.retryAt = null
    }
    entry.lastReasonCode = reasonCode
    entry.lastError = clampText(error || reasonCode)
    pushHistory(entry, { jobId, status: 'failed', reasonCode, at: stamp() })
    entry.updatedAt = stamp()
    return { pending: entry.pending, retryAt: entry.retryAt || null, attempts: entry.attempts }
  })
}

/**
 * 僵尸清理：进程被杀之后 inflight 会留在账本里。租约到期就当成失败回收，
 * 把快照范围退回 pending，绝不假装那一段已经整理过。
 */
export function recoverStaleJobs({ now = Date.now(), leaseMs = DEFAULT_LEASE_MS } = {}) {
  return mutateLedger((ledger) => {
    const recovered = []
    for (const [sessionId, entry] of Object.entries(ledger.sessions || {})) {
      if (!entry || typeof entry !== 'object') continue
      const leaseUntil = Number(entry.inflight?.leaseUntil)
      if (!entry.inflight) continue
      if (Number.isSafeInteger(leaseUntil) && leaseUntil > now) continue
      const job = entry.inflight
      entry.inflight = null
      entry.pending = pendingFromSnapshot(job?.snapshot || null, entry.checked, entry.pending)
      entry.attempts = (Number(entry.attempts) || 0) + 1
      entry.retryAt = retryAtFrom(now, entry.attempts)
      entry.lastReasonCode = 'lease-expired'
      entry.lastError = 'a consolidation job was interrupted before it finished; its range is pending again'
      pushHistory(entry, { jobId: job?.jobId || null, status: 'failed', reasonCode: 'lease-expired', at: stamp() })
      entry.updatedAt = stamp()
      recovered.push({ sessionId, jobId: job?.jobId || null, leaseUntil: leaseUntil > 0 ? leaseUntil : null })
    }
    return recovered
  })
}

/**
 * 幂等键：同一份固定快照在同一库里只应当被结算一次。
 * 失败的部分写入靠这个键判同再试，而不是靠「同一个主题就跳过」。
 */
export function operationKey({ sessionId, libraryId = null, snapshotHash, scopeGeneration = '', kind = 'consolidate' }) {
  return shortHash([sessionId, libraryId || '', snapshotHash || '', scopeGeneration, kind].join('|'))
}

export function findOperation(sessionId, key, ledger = loadLedger()) {
  const entry = ledger.sessions?.[String(sessionId || '')]
  const found = entry?.operations?.[String(key || '')]
  return found && typeof found === 'object' ? structuredClone(found) : null
}

export function recordOperation({ sessionId, key, outcome, ids = [], at = Date.now() }) {
  return mutateLedger((ledger) => {
    const entry = ensureEntry(ledger, sessionId)
    entry.operations[String(key)] = { outcome, ids: Array.isArray(ids) ? ids.slice(0, 50) : [], at: new Date(at).toISOString() }
    const keys = Object.keys(entry.operations)
    if (keys.length > OPERATION_LIMIT) {
      for (const stale of keys.slice(0, keys.length - OPERATION_LIMIT)) delete entry.operations[stale]
    }
    entry.updatedAt = stamp()
    return entry.operations[String(key)]
  })
}

export function clearSessionState(sessionId) {
  return mutateLedger((ledger) => {
    delete ledger.sessions[String(sessionId || '')]
    return true
  })
}

export default {
  CONSOLIDATION_LEDGER_VERSION, DEFAULT_LEASE_MS, ledgerPath, loadLedger, sessionState, scopeGenerationOf,
  noteEvidence, beginJob, renewLease, completeJob, failJob, recoverStaleJobs, operationKey, findOperation,
  recordOperation, clearSessionState,
}