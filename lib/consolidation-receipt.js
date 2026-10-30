// C 包：结构化完成凭证。
//
// whenIdle() 只说明 driver 停了，它不代表这一轮整理真的完成了什么——失败的回合同样会
// 让 whenIdle 解析。所以完成不再是「没报错」，而是一份可以核验的回执：状态、覆盖范围、
// 写入了哪些 id。回执是 worker 最后一条消息里的一个围栏块（围栏标记由代码拼出来，
// 目标文件里不出现字面反引号，避免和别的模板混在一起），解析失败就是失败，绝不猜测。
export const RECEIPT_CONTRACT_VERSION = 1

const TICK = String.fromCharCode(96)
const FENCE = TICK + TICK + TICK
export const RECEIPT_TAG = 'memu-consolidation-receipt'
export const RECEIPT_FENCE = FENCE + RECEIPT_TAG
export const RECEIPT_STATUSES = Object.freeze(['completed', 'skipped', 'deferred', 'failed'])
export const RECEIPT_OUTCOMES = Object.freeze(['created', 'updated', 'mixed', 'no_value'])
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/
const MAX_IDS = 50

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

export function entryFingerprint(entry) {
  return stableJson(entry)
}

const OPEN_RE = new RegExp(RECEIPT_FENCE + '[^\\n]*\\r?\\n([\\s\\S]*?)' + FENCE, 'g')
const TAG_RE = new RegExp('<' + RECEIPT_TAG + '>([\\s\\S]*?)</' + RECEIPT_TAG + '>', 'g')

// 回执契约正文：给 worker 的英文/中文混合说明，字段名固定。
export function receiptContractText({ jobId = null, snapshotHash = null } = {}) {
  return [
    '[完成回执 · 必须给出]',
    '最后一条消息里原样输出一个围栏块，块内只有一个 JSON 对象：',
    RECEIPT_FENCE,
    '{',
    '  "version": 1,',
    '  "jobId": ' + JSON.stringify(jobId || '复制本任务 jobId') + ',',
    '  "snapshotHash": ' + JSON.stringify(snapshotHash || '复制本任务 snapshotHash') + ',',
    '  "status": "completed | skipped | deferred | failed",',
    '  "outcome": "created | updated | mixed | no_value",',
    '  "checkedRange": { "fromSeq": 数字, "throughSeq": 数字 },',
    '  "createdIds": ["新增的 id"], "updatedIds": ["合并过的 id"], "heldIds": ["进待复核的 id"],',
    '  "reasonCode": "没有正常完成时必填，如 tools-unavailable / no-value / timeout",',
    '  "retryable": true',
    '}',
    FENCE,
    '规则：id 必须是你这次真的写入/更新/暂扣的 id，编造 id 会让整次整理判为无效。',
    'status=completed 且 outcome=no_value 表示「看过了，没有值得留的」，是正常结果；',
    '做不到（工具缺失、范围读不到、被中断）就用 failed/deferred 并写清 reasonCode，不要假装完成。',
  ].join('\n')
}

function lastMatch(re, text) {
  let found = null
  re.lastIndex = 0
  for (let match = re.exec(text); match !== null; match = re.exec(text)) found = match[1]
  return found
}

/** 从一段模型正文里取出回执 JSON 文本；没有就返回 null。 */
export function extractReceiptBody(text) {
  const body = String(text || '')
  if (!body) return null
  const fenced = lastMatch(OPEN_RE, body)
  if (fenced !== null) return fenced.trim()
  const tagged = lastMatch(TAG_RE, body)
  return tagged !== null ? tagged.trim() : null
}

function idList(value, field, problems) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    problems.push(field + ' must be an array of memory ids')
    return []
  }
  const out = []
  for (const entry of value.slice(0, MAX_IDS)) {
    if (typeof entry !== 'string' || !ID_RE.test(entry.trim())) {
      problems.push(field + ' contains a value that is not a memory id: ' + String(entry).slice(0, 40))
      continue
    }
    out.push(entry.trim())
  }
  return out
}

function seqOf(value) {
  const seq = Number(value)
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : null
}

/** 结构校验：任何一条不符都整份退回，不做「尽量接受」。 */
export function validateReceipt(value) {
  const problems = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, problems: ['the receipt must be a single JSON object'] }
  }
  const jobId = value.jobId ?? null
  const snapshotHash = value.snapshotHash ?? null
  if (jobId !== null && (typeof jobId !== 'string' || !ID_RE.test(jobId))) problems.push('jobId must be a task identifier')
  if (snapshotHash !== null && (typeof snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(snapshotHash))) problems.push('snapshotHash must be a SHA-256 digest')
  const status = typeof value.status === 'string' ? value.status.trim() : ''
  if (!RECEIPT_STATUSES.includes(status)) problems.push('status must be one of ' + RECEIPT_STATUSES.join(', '))
  const outcomeRaw = typeof value.outcome === 'string' ? value.outcome.trim() : ''
  const outcome = RECEIPT_OUTCOMES.includes(outcomeRaw) ? outcomeRaw : ''
  if (!outcome && (status === 'completed' || status === 'skipped')) problems.push('outcome must be one of ' + RECEIPT_OUTCOMES.join(', '))
  const createdIds = idList(value.createdIds, 'createdIds', problems)
  const updatedIds = idList(value.updatedIds, 'updatedIds', problems)
  const heldIds = idList(value.heldIds, 'heldIds', problems)
  let range = null
  if (value.checkedRange !== undefined && value.checkedRange !== null) {
    const fromSeq = seqOf(value.checkedRange?.fromSeq)
    const throughSeq = seqOf(value.checkedRange?.throughSeq)
    if (fromSeq === null || throughSeq === null) problems.push('checkedRange needs non-negative integer fromSeq and throughSeq')
    else if (fromSeq > throughSeq) problems.push('checkedRange.fromSeq must not exceed throughSeq')
    else range = { fromSeq, throughSeq }
  }
  if ((status === 'completed' || status === 'skipped') && !range) problems.push('terminal receipt needs checkedRange')
  const reasonCode = typeof value.reasonCode === 'string' && value.reasonCode.trim() ? value.reasonCode.trim().slice(0, 80) : null
  if (!reasonCode && status !== 'completed') problems.push('reasonCode is required for status ' + (status || '(missing)'))
  if (outcome === 'created' && createdIds.length === 0) problems.push('outcome created needs at least one createdIds entry')
  if (outcome === 'updated' && updatedIds.length === 0) problems.push('outcome updated needs at least one updatedIds entry')
  if (outcome === 'mixed' && (createdIds.length === 0 || updatedIds.length === 0)) problems.push('outcome mixed needs createdIds and updatedIds')
  if (outcome === 'no_value' && (createdIds.length > 0 || updatedIds.length > 0)) problems.push('outcome no_value cannot carry createdIds or updatedIds')
  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    receipt: {
      version: RECEIPT_CONTRACT_VERSION,
      jobId,
      snapshotHash,
      status,
      outcome: outcome || null,
      checkedRange: range,
      createdIds,
      updatedIds,
      heldIds,
      reasonCode,
      retryable: value.retryable === true,
    },
    problems: [],
  }
}

/** 解析正文里的回执。没有回执 / JSON 坏 / 结构不符各有自己的 reasonCode。 */
export function parseReceipt(text) {
  const body = extractReceiptBody(text)
  if (body === null) return { ok: false, reasonCode: 'receipt-missing', detail: 'the worker produced no completion receipt' }
  let value = null
  try {
    value = JSON.parse(body)
  } catch (error) {
    return { ok: false, reasonCode: 'receipt-malformed', detail: String(error?.message || error) }
  }
  const validated = validateReceipt(value)
  if (!validated.ok) return { ok: false, reasonCode: 'receipt-invalid', detail: validated.problems.join('; ') }
  return { ok: true, receipt: validated.receipt }
}

/**
 * 回执与库对账：id 必须真的存在，新增的必须真的是新的，暂扣的必须真的在待复核。
 * 这样「模型说写了」不算数，「库里确实有」才算数。
 */
export function reconcileReceipt({ receipt, index = null, beforeIds = null, beforeEntries = null } = {}) {
  const problems = []
  const entries = index?.entries || {}
  const known = beforeIds instanceof Set ? beforeIds : null
  const prior = beforeEntries && typeof beforeEntries === 'object' ? beforeEntries : null
  const createdIds = []
  const duplicateIds = []
  const updatedIds = []
  const heldIds = []
  const missing = []
  const changed = (id) => prior && Object.prototype.hasOwnProperty.call(prior, id) && prior[id] !== entryFingerprint(entries[id])
  for (const id of receipt?.createdIds || []) {
    if (!entries[id]) { missing.push(id); continue }
    if (known && known.has(id)) {
      duplicateIds.push(id)
      if (!changed(id)) problems.push('created id ' + id + ' already existed without a verified update')
      else updatedIds.push(id)
      continue
    }
    createdIds.push(id)
  }
  for (const id of receipt?.updatedIds || []) {
    if (!entries[id]) { missing.push(id); continue }
    if (!known || !known.has(id) || !changed(id)) {
      problems.push('updated id ' + id + ' has no verified post-worker change')
      continue
    }
    updatedIds.push(id)
  }
  for (const id of receipt?.heldIds || []) {
    const entry = entries[id]
    if (!entry) { missing.push(id); continue }
    if (entry.status !== 'pending_review') { problems.push('held id ' + id + ' is not pending_review'); continue }
    heldIds.push(id)
  }
  if (missing.length > 0) problems.push('receipt cites ids that are not in the library: ' + missing.slice(0, 8).join(', '))
  // 重复写回已有 id 不算新增：记下来，但按更新计入，免得「整理成功」把没发生的事算成新记忆。
  let outcome = receipt?.outcome || 'no_value'
  if (createdIds.length > 0 && updatedIds.length > 0) outcome = 'mixed'
  else if (createdIds.length > 0) outcome = 'created'
  else if (updatedIds.length > 0) outcome = 'updated'
  else outcome = 'no_value'
  if (problems.length > 0) return { ok: false, problems, createdIds, updatedIds, heldIds, duplicateIds, outcome }
  return { ok: true, problems: [], createdIds, updatedIds, heldIds, duplicateIds, outcome }
}

/**
 * 把「worker 说了什么 + 库里真的变了什么」折成一个可以结算的结论。
 * advance=true 才允许推进 checked 游标（完整覆盖 + 有凭证 / 有对账证据）。
 */
export function decideCompletion({ text = '', wrote = 0, index = null, beforeIds = null, beforeEntries = null, expectedJobId = null, expectedSnapshotHash = null } = {}) {
  const body = String(text || '').trim()
  if (!body) {
    return {
      status: 'failed', outcome: null, advance: false, settled: false, retryable: true,
      reasonCode: 'receipt-missing',
      error: wrote > 0
        ? 'the worker wrote ' + wrote + ' new memories but returned no receipt; an unattributed write cannot settle a snapshot'
        : 'the consolidation worker produced no completion receipt; index differences alone cannot settle the snapshot',
      receipt: null,
    }
  }
  const parsed = parseReceipt(body)
  if (!parsed.ok) {
    return {
      status: 'failed',
      outcome: null,
      advance: false,
      settled: false,
      retryable: true,
      reasonCode: parsed.reasonCode,
      error: 'the consolidation worker did not return a usable receipt: ' + parsed.detail,
      receipt: null,
    }
  }
  const receipt = parsed.receipt
  if ((expectedJobId !== null && receipt.jobId !== expectedJobId) ||
      (expectedSnapshotHash !== null && receipt.snapshotHash !== expectedSnapshotHash)) {
    return { status: 'failed', outcome: null, advance: false, settled: false, retryable: true,
      reasonCode: 'receipt-identity-mismatch',
      error: 'the completion receipt does not identify the current worker job and snapshot', receipt }
  }
  const reconciled = reconcileReceipt({ receipt, index, beforeIds, beforeEntries })
  if (!reconciled.ok) {
    return {
      status: 'failed',
      outcome: null,
      advance: false,
      settled: false,
      retryable: true,
      reasonCode: 'receipt-unverified',
      error: 'the receipt does not match the library: ' + reconciled.problems.join('; '),
      receipt,
    }
  }
  const advance = receipt.status === 'completed' || (receipt.status === 'skipped' && Boolean(receipt.reasonCode))
  return {
    status: receipt.status,
    outcome: reconciled.outcome,
    advance,
    settled: advance,
    retryable: !advance && receipt.status !== 'skipped',
    reasonCode: receipt.reasonCode || null,
    receipt,
    counted: { created: reconciled.createdIds.length, updated: reconciled.updatedIds.length, held: reconciled.heldIds.length },
    createdIds: reconciled.createdIds,
    updatedIds: reconciled.updatedIds,
    heldIds: reconciled.heldIds,
    duplicateIds: reconciled.duplicateIds,
    covered: receipt.checkedRange,
  }
}

export default {
  RECEIPT_CONTRACT_VERSION, RECEIPT_TAG, RECEIPT_FENCE, RECEIPT_STATUSES, RECEIPT_OUTCOMES,
  receiptContractText, extractReceiptBody, validateReceipt, parseReceipt, reconcileReceipt, decideCompletion,
}
