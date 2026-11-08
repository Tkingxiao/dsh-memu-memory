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
// autoReceipt=true 时成功路径不再要求模型写 JSON：插件会用库前后 diff 自动合成；
// 只有失败/工具缺失才需要模型明确说清 reasonCode。
export function receiptContractText({ jobId = null, snapshotHash = null, autoReceipt = false } = {}) {
  if (autoReceipt) {
    return [
      '[完成说明 · 1.3.1]',
      '成功时最后一条消息用一句话说明整理结果即可，不必输出 JSON 回执；插件会用库前后 diff 自动生成回执并对账。',
      '只有做不到（工具缺失、范围读不到、被中断）时，才输出：',
      RECEIPT_FENCE,
      '{',
      '  "status": "failed | deferred",',
      '  "reasonCode": "tools-unavailable | timeout | ..."',
      '}',
      FENCE,
    ].join('\n')
  }
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
 * 回执与库对账：引用的 id 必须真的存在；新增/更新由前后索引 diff 定，回执只提供
 * 状态、范围与写入意图。「模型说写了」不算数，「库里确实变了」才算数；但桶分错、
 * 同窗先建后改、重试时重复引用已落库的 id 都不会把一次真实整理判成无效。
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
  // 「暂扣」有两种可解释的落库形态：确实进了待复核，或带着冲突/重复标记。
  // worker 用词与库状态的对应关系到此为止；桶分得对不对不再决定整份回执的成败。
  const heldLike = (entry) => Boolean(entry) && (
    entry.status === 'pending_review' || Boolean(entry.conflictingWith || entry.duplicateOf || entry.reviewReason)
  )
  const pushOnce = (list, id) => { if (!list.includes(id)) list.push(id) }
  const classify = (id) => {
    if (!entries[id]) return
    if (heldLike(entries[id])) pushOnce(heldIds, id)
    else if (known && known.has(id)) pushOnce(updatedIds, id)
    else pushOnce(createdIds, id)
  }
  // 库 diff 是权威：本窗新出现的 id 无论 worker 记成 created 还是 updated，都是新记忆；
  // 窗前已存在且指纹变了的 id 才算更新。这样「同窗先新增后 update」不会被误判，
  // 也不再把一次真实整理按模型的自报台账判死。没有前置索引时不做 diff，只按回执认领。
  if (known) {
    for (const id of Object.keys(entries)) {
      if (!known.has(id)) classify(id)
      else if (changed(id)) classify(id)
    }
  }
  for (const id of receipt?.createdIds || []) {
    if (!entries[id]) { missing.push(id); continue }
    if (known && known.has(id)) {
      duplicateIds.push(id)
      if (changed(id)) classify(id)
      continue
    }
    classify(id)
  }
  for (const id of receipt?.updatedIds || []) {
    if (!entries[id]) { missing.push(id); continue }
    // 本窗内新建后又被 update 的条目按新增计；窗前已存在但没变化的声明只是空话，
    // 不再单独判失败——真正的谎由下面的「声称写了但库里没变」兜底。
    if (!known) continue
    if (!known.has(id)) classify(id)
    else if (changed(id)) classify(id)
  }
  for (const id of receipt?.heldIds || []) {
    if (!entries[id]) { missing.push(id); continue }
    // active 且没有任何冲突标记的条目：回执说「暂扣」但库是正常落库，按库为准，
    // 不把整份回执退回（S7.3 的口径由「必须 pending_review」放宽为「有暂扣证据」）。
    if (heldLike(entries[id])) pushOnce(heldIds, id)
  }
  if (missing.length > 0) problems.push('receipt cites ids that are not in the library: ' + missing.slice(0, 8).join(', '))
  // 兜底仍然只认库：声称 created/updated/mixed，但前后索引没有任何新增、变化或暂扣，
  // 说明这次「写入」只存在于回执里。
  if (known && prior && ['created', 'updated', 'mixed'].includes(receipt?.outcome)
      && createdIds.length === 0 && updatedIds.length === 0 && heldIds.length === 0) {
    problems.push('the receipt claims a write but the library has no verified post-worker change')
  }
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
 * 1.3.1 本地回执：成功路径不再要求模型输出 JSON。回执的范围、job 与快照来自插件，
 * 写入 id 由库前后 diff 决定（与 reconcileReceipt 同一权威），所以「模型说写了」
 * 仍然不算数。
 */
export function synthesizeReceipt({ jobId = null, snapshotHash = null, checkedRange = null, index = null, beforeIds = null, beforeEntries = null, text = '' } = {}) {
  const body = String(text || '')
  if (/tools?-unavailable|tools unavailable|没有\s*memu_private|工具不可用|工具缺失/i.test(body)) {
    return { ok: false, reasonCode: 'tools-unavailable', detail: 'the worker reported that memory write tools were unavailable' }
  }
  const probe = reconcileReceipt({
    receipt: { status: 'completed', outcome: 'no_value', checkedRange, createdIds: [], updatedIds: [], heldIds: [] },
    index,
    beforeIds,
    beforeEntries,
  })
  if (!probe.ok) return { ok: false, reasonCode: 'receipt-unverified', detail: probe.problems.join('; ') }
  const createdIds = probe.createdIds || []
  const updatedIds = probe.updatedIds || []
  const heldIds = probe.heldIds || []
  const noChange = createdIds.length === 0 && updatedIds.length === 0 && heldIds.length === 0
  if (!body && noChange) {
    return { ok: false, reasonCode: 'receipt-missing', detail: 'the worker produced no completion receipt and the library did not change' }
  }
  // 声称写了但库 diff 为零：自动回执不能把「只存在于模型嘴里」的写入记成完成。
  if (noChange && /写入|记下|记了|已记|新增|保存|整理完成|完成整理/i.test(body)
      && !/没有值得|没什么可写|无新增|没有新增|没有需要|无内容|无需记录|nothing to/i.test(body)) {
    return { ok: false, reasonCode: 'receipt-unverified', detail: 'the worker claims a write but the library has no verified change' }
  }
  const outcome = createdIds.length > 0 && updatedIds.length > 0 ? 'mixed'
    : createdIds.length > 0 ? 'created'
      : updatedIds.length > 0 ? 'updated'
        : 'no_value'
  const validated = validateReceipt({
    version: RECEIPT_CONTRACT_VERSION,
    jobId,
    snapshotHash,
    status: 'completed',
    outcome,
    checkedRange,
    createdIds,
    updatedIds,
    heldIds,
    retryable: true,
  })
  if (!validated.ok) return { ok: false, reasonCode: 'receipt-invalid', detail: validated.problems.join('; ') }
  return { ok: true, receipt: validated.receipt }
}

/**
 * 把「worker 说了什么 + 库里真的变了什么」折成一个可以结算的结论。
 * advance=true 才允许推进 checked 游标（完整覆盖 + 有凭证 / 有对账证据）。
 */
export function decideCompletion({ text = '', wrote = 0, index = null, beforeIds = null, beforeEntries = null, expectedJobId = null, expectedSnapshotHash = null, autoReceipt = null } = {}) {
  const body = String(text || '').trim()
  let parsed = null
  if (body) {
    const receiptBody = extractReceiptBody(body)
    if (receiptBody !== null) parsed = parseReceipt(body)
  }
  if (!parsed && autoReceipt) {
    const synthesized = synthesizeReceipt({
      ...autoReceipt, index, beforeIds, beforeEntries, text: body,
    })
    parsed = synthesized.ok
      ? { ok: true, receipt: synthesized.receipt }
      : { ok: false, reasonCode: synthesized.reasonCode, detail: synthesized.detail }
  }
  if (!parsed) {
    return {
      status: 'failed', outcome: null, advance: false, settled: false, retryable: true,
      reasonCode: 'receipt-missing',
      error: wrote > 0
        ? 'the worker wrote ' + wrote + ' new memories but returned no receipt; an unattributed write cannot settle a snapshot'
        : 'the consolidation worker produced no completion receipt; index differences alone cannot settle the snapshot',
      receipt: null,
    }
  }
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
  receiptContractText, extractReceiptBody, validateReceipt, parseReceipt, reconcileReceipt, synthesizeReceipt, decideCompletion,
}
