#!/usr/bin/env node
/**
 * 主动记忆金标 A/B 评测管线（F 包）与独立 worker/快照凭证契约（C 包接口侧）。
 *
 * 这个 harness 只做三件**确定性**的事：
 *   1. 把固定快照（fixture 内 events + throughSeq + sha256）展开并校验摘要；
 *   2. 用真实生产纯函数 lib/active-memory.js 复算触发计划（旧行为 / guide / guide+weighted）；
 *   3. 通过**可注入的 worker 适配器**跑检查，校验 §13.6 的凭证与游标规则，再算指标。
 *
 * 它**不调用任何模型、不联网、不读用户真实会话**。所有标注都是
 * annotationSource = "synthetic-proxy"：合成代理标签，不是人工金标。
 * 报告里 coverage 是适配器给的上界/下界区间，不是真实模型效果。
 * 真实模型调用必须由用户另行明确选择，本脚本没有实现该路径。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { estTokens } from '../lib/budget.js'
import {
  ACTIVE_MEMORY_POLICY,
  assessWake,
  collectEvidence,
  scoreEvidence,
  suppressionReason,
} from '../lib/active-memory.js'
import { parseReceipt, RECEIPT_FENCE } from '../lib/consolidation-receipt.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'active-memory-ab')
export const MANIFEST_FILE = 'manifest.json'
export const SCHEMA_VERSION = 1
export const CASE_KIND = 'active-memory-ab-case'
export const MANIFEST_KIND = 'active-memory-ab-manifest'
export const DATASET_STATUS = 'synthetic-proxy-not-gold'
export const REVIEW_STATUSES = Object.freeze(['pending', 'in-review', 'human-reviewed'])
export const ANNOTATION_SOURCES = Object.freeze(['synthetic-proxy', 'human'])
export const CONDITIONS = Object.freeze(['legacy', 'guide', 'guide-weighted'])
export const INTERFERENCE_LEVELS = Object.freeze(['off', 'relevant', 'irrelevant-conflict'])
export const LABEL_CLASSES = Object.freeze(['decision', 'preference', 'root-cause', 'promise', 'fiction-fact'])
export const CREDENTIAL_STATUSES = Object.freeze(['completed', 'skipped', 'deferred', 'failed'])
export const CREDENTIAL_OUTCOMES = Object.freeze(['created', 'updated', 'mixed', 'no_value'])
export const PADDING_GENERATOR = 'ab-polling-padding-v1'
export const LEGACY_IDLE_MINUTES = 3
export const GUIDE_RULES_SALT = 'active-memory-ab-guide-v1'
export const MEMORY_TOOL_NAMES = Object.freeze(['memu_remember', 'memu_update', 'memu_archive', 'memu_recall', 'memu_list', 'memu_status'])
export const MEMORY_WRITE_TOOL_NAMES = Object.freeze(['memu_remember', 'memu_update', 'memu_archive'])
export const ROWS = Object.freeze([
  Object.freeze({ id: 'legacy', condition: 'legacy', adapter: 'oracle', path: 'full-prefix-fork' }),
  Object.freeze({ id: 'guide', condition: 'guide', adapter: 'oracle', path: 'full-prefix-fork' }),
  Object.freeze({ id: 'guide-weighted:oracle', condition: 'guide-weighted', adapter: 'oracle', path: 'snapshot-worker' }),
  Object.freeze({ id: 'guide-weighted:no-value', condition: 'guide-weighted', adapter: 'no-value', path: 'snapshot-worker' }),
  // 第五行只走 C 包的回执格式：同样的调度，但凭证来自 parseReceipt，
  // 用来证明"真 worker 的产出形状"能被 §13.6 的凭证规则接受。默认不跑（见 DEFAULT_ROW_IDS）。
  Object.freeze({ id: 'guide-weighted:structural', condition: 'guide-weighted', adapter: 'worker-structural', path: 'snapshot-worker' }),
])
export const DEFAULT_ROW_IDS = Object.freeze(['legacy', 'guide', 'guide-weighted:oracle', 'guide-weighted:no-value'])
export const REAL_MODEL_FLAGS = Object.freeze(['--real-model', '--live', '--model', '--network', '--gold'])

function fixtureError(message) {
  throw new Error('active-memory-ab fixture: ' + message)
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function round(value, digits) {
  const scale = Math.pow(10, digits === undefined ? 3 : digits)
  return Math.round((Number(value) || 0) * scale) / scale
}

/** 稳定序列化：键名排序、数组保持顺序。摘要与快照身份都建在它上面。 */
export function canonicalJson(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(item => canonicalJson(item)).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
}

/** 快照摘要只覆盖 (fromSeq..throughSeq]：之后的事件是"尚未到达"，不属于本次固定快照。 */
export function computeSnapshotDigest(input) {
  const fromSeq = Number(input.fromSeq) || 0
  const throughSeq = Number(input.throughSeq) || 0
  const events = Array.isArray(input.events) ? input.events.slice(fromSeq, throughSeq + 1) : []
  return sha256(canonicalJson({ schemaVersion: SCHEMA_VERSION, fromSeq, throughSeq, events }))
}

export function eventText(event) {
  const type = event && event.type
  if (type === 'user/message') {
    const content = event.data && event.data.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content.filter(block => block && block.type === 'text' && typeof block.text === 'string').map(block => block.text).join(' ')
  }
  if (type === 'assistant/message') {
    const blocks = event.data && event.data.message && event.data.message.content
    if (!Array.isArray(blocks)) return ''
    return blocks.filter(block => block && block.type === 'text' && typeof block.text === 'string').map(block => block.text).join(' ')
  }
  if (type === 'tool/result') {
    const content = event.data && event.data.message && event.data.message.content
    if (!Array.isArray(content)) return ''
    return content.filter(block => block && block.type === 'text' && typeof block.text === 'string').map(block => block.text).join(' ')
  }
  return ''
}

function normalizeEvent(event, index, caseId, turnHint) {
  if (!isPlainObject(event)) fixtureError(caseId + ': events[' + index + '] must be an object')
  if (typeof event.type !== 'string' || !event.type.trim()) fixtureError(caseId + ': events[' + index + '].type must be a non-empty string')
  const at = Date.parse(event.at || '')
  if (!Number.isFinite(at)) fixtureError(caseId + ': events[' + index + '].at must be an ISO timestamp')
  if (Number.isInteger(event.seq) && event.seq !== index) fixtureError(caseId + ': events[' + index + '].seq must equal its assembled position')
  const out = { ...event, seq: index, at: new Date(at).toISOString() }
  if (turnHint !== undefined && out.turn === undefined) out.turn = turnHint
  return out
}

/** 确定性工具轮询填充：文本完全相同，所以去重后只算 1 个工作单元（§13.5 去噪）。 */
function generatePadding(padding, caseId) {
  const count = Number(padding.count)
  if (!Number.isInteger(count) || count < 1 || count > 20000) fixtureError(caseId + ': padding.count must be an integer 1..20000')
  const intervalMs = padding.intervalMs === undefined ? 1000 : Number(padding.intervalMs)
  if (!Number.isFinite(intervalMs) || intervalMs < 0) fixtureError(caseId + ': padding.intervalMs must be >= 0')
  const startAt = Date.parse(padding.startAt || '')
  if (!Number.isFinite(startAt)) fixtureError(caseId + ': padding.startAt must be an ISO timestamp')
  const text = typeof padding.text === 'string' && padding.text.trim() ? padding.text : 'polling: no change'
  const tool = typeof padding.tool === 'string' && padding.tool.trim() ? padding.tool : 'read'
  const out = []
  for (let index = 0; index < count; index += 1) {
    const at = new Date(startAt + index * intervalMs).toISOString()
    const toolCallId = 'pad-' + index
    out.push({ type: 'step/start', turn: 1, at })
    out.push({ type: 'tool/call', turn: 1, at, toolCallId, name: tool, arguments: { path: 'logs/run-' + index + '.log' } })
    out.push({ type: 'tool/result', turn: 1, at, toolCallId, data: { message: { isError: false, content: [{ type: 'text', text }] } } })
    out.push({ type: 'step/end', turn: 1, at })
  }
  return out
}

/**
 * 展开一个 case 的快照：把内联 padding 占位替换成确定性生成的事件，重新编 seq，
 * 再算摘要。摘要只覆盖 fromSeq..throughSeq，之后的事件属于"尚未到达"。
 */
export function expandCaseSnapshot(caseDef) {
  const caseId = caseDef && caseDef.id ? caseDef.id : 'case'
  const declared = caseDef && caseDef.snapshot && caseDef.snapshot.events
  if (!Array.isArray(declared) || declared.length === 0) fixtureError(caseId + ': snapshot.events must be a non-empty array')
  const assembled = []
  for (const event of declared) {
    if (isPlainObject(event) && event.type === 'padding') {
      for (const generated of generatePadding(event, caseId)) assembled.push(generated)
      continue
    }
    assembled.push(event)
  }
  const events = assembled.map((event, index) => normalizeEvent(event, index, caseId))
  const snapshotDecl = caseDef.snapshot
  const fromSeq = snapshotDecl.fromSeq === undefined ? 0 : Number(snapshotDecl.fromSeq)
  const throughSeq = snapshotDecl.throughSeq === undefined ? events.length - 1 : Number(snapshotDecl.throughSeq)
  if (!Number.isInteger(fromSeq) || fromSeq !== 0) fixtureError(caseId + ': snapshot.fromSeq must be 0 (harness reads one fixed prefix)')
  if (!Number.isInteger(throughSeq) || throughSeq < 0 || throughSeq >= events.length) {
    fixtureError(caseId + ': snapshot.throughSeq must be an integer 0..events.length-1')
  }
  const idleAtSnapshotEndMinutes = snapshotDecl.idleAtSnapshotEndMinutes === undefined ? 0 : Number(snapshotDecl.idleAtSnapshotEndMinutes)
  if (!Number.isFinite(idleAtSnapshotEndMinutes) || idleAtSnapshotEndMinutes < 0) fixtureError(caseId + ': snapshot.idleAtSnapshotEndMinutes must be >= 0')
  const lastInjectedAt = snapshotDecl.lastInjectedAt === undefined ? null : snapshotDecl.lastInjectedAt
  if (lastInjectedAt !== null && !Number.isFinite(Date.parse(lastInjectedAt))) fixtureError(caseId + ': snapshot.lastInjectedAt must be an ISO timestamp or null')
  const globalEntries = Array.isArray(snapshotDecl.globalEntries) ? snapshotDecl.globalEntries : []
  const conflicts = Array.isArray(snapshotDecl.conflicts) ? snapshotDecl.conflicts : []
  const scopeGeneration = snapshotDecl.scopeGeneration === undefined ? 1 : Number(snapshotDecl.scopeGeneration)
  if (!Number.isInteger(scopeGeneration) || scopeGeneration < 1) fixtureError(caseId + ': snapshot.scopeGeneration must be a positive integer')
  const snapshot = {
    caseId,
    fromSeq,
    throughSeq,
    events,
    tailEvents: events.length - throughSeq - 1,
    idleAtSnapshotEndMinutes,
    lastInjectedAt,
    globalEntries,
    conflicts,
    scopeGeneration,
    domain: typeof snapshotDecl.domain === 'string' ? snapshotDecl.domain : 'coding',
    pendingCheck: snapshotDecl.pendingCheck === true,
    // 默认 0：这些快照模拟「已经整理到区间起点、只有末尾这一点是新的」。
    // 生产里待整理区间是从上次游标算起，首轮大会话会被积压上界强制整理一次；
    // fixture 若也按「整段都未整理」算，每个 case 的第一次判定都会被积压放行，
    // 守卫就测不出来了。
    pendingEvents: Number.isFinite(Number(snapshotDecl.pendingEvents)) ? Math.max(0, Number(snapshotDecl.pendingEvents)) : 0,
    digest: computeSnapshotDigest({ fromSeq, throughSeq, events }),
    eventCount: throughSeq + 1,
  }
  snapshot.halfStep = detectHalfStep(events, throughSeq)
  return snapshot
}

/**
 * 工具调用 id 兼容两种形状：fixture 里是顶层 toolCallId；宿主转录里是
 * event.data.callId（tool/call）与 event.data.message.callId（tool/result）。
 * C 包的 lib/consolidation-snapshot.js 用的是宿主形状，这里同时认，方便以后接真转录。
 */
export function toolCallIdOf(event) {
  if (!event) return null
  if (typeof event.toolCallId === 'string' && event.toolCallId) return event.toolCallId
  const data = event.data
  if (data && typeof data.callId === 'string' && data.callId) return data.callId
  if (data && data.message && typeof data.message.callId === 'string' && data.message.callId) return data.message.callId
  return null
}

function openToolCallIds(event, index) {
  const ids = []
  if (event && event.type === 'tool/call') {
    const id = toolCallIdOf(event) || ('anon-' + index)
    ids.push(id)
  }
  if (event && event.type === 'assistant/message') {
    const blocks = event.data && event.data.message && event.data.message.content
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (!block || block.type !== 'tool-call') continue
        if (typeof block.id === 'string' && block.id) ids.push(block.id)
      }
    }
  }
  return ids
}

/** 事件尾部是否是半步：tool/call 没有配对的 tool/result（§13.6.1 不读半份转录）。 */
export function detectHalfStep(events, throughSeq) {
  const open = new Set()
  const limit = Math.min(Number(throughSeq) || 0, events.length - 1)
  for (let index = 0; index <= limit; index += 1) {
    const event = events[index]
    if (!event) continue
    for (const id of openToolCallIds(event, index)) open.add(id)
    if (event.type === 'tool/result') {
      const id = toolCallIdOf(event)
      if (id) open.delete(id)
      else if (open.size === 1) {
        const only = open.values().next().value
        open.delete(only)
      }
    }
  }
  return open.size > 0
}

function assertString(value, field, where) {
  if (typeof value !== 'string' || !value.trim()) fixtureError(where + ': ' + field + ' must be a non-empty string')
  return value
}

function assertStringArray(value, field, where) {
  if (!Array.isArray(value)) fixtureError(where + ': ' + field + ' must be an array')
  if (value.some(item => typeof item !== 'string' || !item.trim())) fixtureError(where + ': ' + field + ' must contain non-empty strings')
  if (new Set(value).size !== value.length) fixtureError(where + ': ' + field + ' contains duplicates')
  return value
}

export function validateManifest(manifest) {
  if (!isPlainObject(manifest)) fixtureError('manifest: must be an object')
  if (manifest.schemaVersion !== SCHEMA_VERSION) fixtureError('manifest: schemaVersion must be ' + SCHEMA_VERSION)
  if (manifest.kind !== MANIFEST_KIND) fixtureError('manifest: kind must be ' + MANIFEST_KIND)
  assertString(manifest.name, 'name', 'manifest')
  if (manifest.status !== DATASET_STATUS) fixtureError('manifest: status must be ' + DATASET_STATUS + ' (synthetic proxies are not a gold set)')
  if (manifest.draft !== true) fixtureError('manifest: draft must be true')
  if (manifest.notGold !== true) fixtureError('manifest: notGold must be true')
  if (manifest.gold !== false) fixtureError('manifest: gold must be false (no human review has happened)')
  if (!REVIEW_STATUSES.includes(manifest.review)) fixtureError('manifest: unknown review status ' + manifest.review)
  if (!Array.isArray(manifest.axes) || manifest.axes.length === 0) fixtureError('manifest: axes must be a non-empty array')
  for (const level of INTERFERENCE_LEVELS) {
    if (!manifest.axes.includes(level)) fixtureError('manifest: axes must declare interference level ' + level)
  }
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) fixtureError('manifest: cases must be a non-empty array')
  const seenId = new Set()
  const seenFile = new Set()
  for (let index = 0; index < manifest.cases.length; index += 1) {
    const entry = manifest.cases[index]
    const where = 'manifest.cases[' + index + ']'
    if (!isPlainObject(entry)) fixtureError(where + ': must be an object')
    assertString(entry.id, 'id', where)
    if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(entry.id)) fixtureError(where + ': invalid case id ' + entry.id)
    if (seenId.has(entry.id)) fixtureError(where + ': duplicate case id ' + entry.id)
    seenId.add(entry.id)
    assertString(entry.file, 'file', where)
    if (seenFile.has(entry.file)) fixtureError(where + ': duplicate case file ' + entry.file)
    seenFile.add(entry.file)
    if (!/^[a-f0-9]{64}$/.test(String(entry.snapshotSha256 || ''))) fixtureError(where + ': snapshotSha256 must be a sha256 hex digest')
    if (!Number.isInteger(entry.throughSeq) || entry.throughSeq < 0) fixtureError(where + ': throughSeq must be a non-negative integer')
    if (!INTERFERENCE_LEVELS.includes(entry.interference)) fixtureError(where + ': unknown interference level ' + entry.interference)
    if (entry.annotationSource === 'human' && entry.review !== 'human-reviewed') {
      fixtureError(where + ': human annotation requires review = human-reviewed (human review and gold gating are separate)')
    }
    if (entry.gold === true && entry.review !== 'human-reviewed') {
      fixtureError(where + ': gold = true requires human review; synthetic proxies can never be gold')
    }
  }
  return manifest
}

export function validateCaseShape(caseDef, where) {
  if (!isPlainObject(caseDef)) fixtureError(where + ': case must be an object')
  if (caseDef.schemaVersion !== SCHEMA_VERSION) fixtureError(where + ': schemaVersion must be ' + SCHEMA_VERSION)
  if (caseDef.kind !== CASE_KIND) fixtureError(where + ': kind must be ' + CASE_KIND)
  assertString(caseDef.id, 'id', where)
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(caseDef.id)) fixtureError(where + ': invalid case id ' + caseDef.id)
  if (caseDef.draft !== true) fixtureError(where + ': draft must be true')
  if (caseDef.notGold !== true) fixtureError(where + ': notGold must be true')
  if (caseDef.gold !== false) fixtureError(where + ': gold must be false; only human review can change that, and not in this harness')
  if (!REVIEW_STATUSES.includes(caseDef.review)) fixtureError(where + ': unknown review status ' + caseDef.review)
  if (!ANNOTATION_SOURCES.includes(caseDef.annotationSource)) fixtureError(where + ': unknown annotationSource ' + caseDef.annotationSource)
  if (caseDef.annotationSource === 'human' && caseDef.review !== 'human-reviewed') fixtureError(where + ': human annotation requires review = human-reviewed')
  if (caseDef.annotationSource === 'synthetic-proxy' && caseDef.gold === true) fixtureError(where + ': synthetic proxy labels can never be gold')
  if (!INTERFERENCE_LEVELS.includes(caseDef.interference)) fixtureError(where + ': interference must be one of ' + INTERFERENCE_LEVELS.join(','))
  if (!isPlainObject(caseDef.snapshot)) fixtureError(where + ': snapshot must be an object')
  if (!isPlainObject(caseDef.labels)) fixtureError(where + ': labels must be an object')
  const expected = caseDef.labels.expected
  if (!Array.isArray(expected)) fixtureError(where + ': labels.expected must be an array')
  const seen = new Set()
  for (let index = 0; index < expected.length; index += 1) {
    const label = expected[index]
    const labelWhere = where + ' labels.expected[' + index + ']'
    if (!isPlainObject(label)) fixtureError(labelWhere + ': must be an object')
    assertString(label.id, 'id', labelWhere)
    if (!/^mem-ab-[a-z0-9-]{2,60}$/.test(label.id)) fixtureError(labelWhere + ': invalid label id ' + label.id)
    if (seen.has(label.id)) fixtureError(labelWhere + ': duplicate label id ' + label.id)
    seen.add(label.id)
    if (!LABEL_CLASSES.includes(label.class)) fixtureError(labelWhere + ': unknown class ' + label.class)
    if (!Number.isInteger(label.sourceSeq) || label.sourceSeq < 0) fixtureError(labelWhere + ': sourceSeq must be a non-negative integer')
    assertString(label.note, 'note', labelWhere)
  }
  const mainProactive = caseDef.labels.mainProactive === undefined ? [] : caseDef.labels.mainProactive
  if (!Array.isArray(mainProactive)) fixtureError(where + ': labels.mainProactive must be an array of label ids')
  for (const id of assertStringArray(mainProactive, 'labels.mainProactive', where)) {
    if (!seen.has(id)) fixtureError(where + ': labels.mainProactive references unknown label ' + id)
  }
  const reminders = caseDef.labels.userReminders === undefined ? [] : caseDef.labels.userReminders
  if (!Array.isArray(reminders) || reminders.some(item => !Number.isInteger(item) || item < 0)) {
    fixtureError(where + ': labels.userReminders must be an array of non-negative seq integers')
  }
  for (const seq of reminders) {
    if (seq > (Number(caseDef.snapshot.throughSeq) || 0)) fixtureError(where + ': labels.userReminders seq ' + seq + ' is beyond the fixed snapshot')
  }
  if (caseDef.expect) {
    if (!isPlainObject(caseDef.expect)) fixtureError(where + ': expect must be an object')
    const allowedKeys = ['minBackgroundChecks', 'maxBackgroundChecks', 'deferredAtLeast', 'heldAtLeast', 'coveredLabelIds', 'uncoveredLabelIds', 'wakeReasons', 'blockedReasons', 'duplicatesReproposedAtLeast']
    for (const key of Object.keys(caseDef.expect)) {
      if (!allowedKeys.includes(key)) fixtureError(where + ': unknown expect key ' + key)
    }
  }
  return caseDef
}

export function loadDataset(options) {
  const settings = options || {}
  const dir = settings.fixtureDir ? path.resolve(settings.fixtureDir) : FIXTURE_DIR
  const manifestPath = path.join(dir, MANIFEST_FILE)
  if (!fs.existsSync(manifestPath)) fixtureError('missing manifest at ' + manifestPath)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  validateManifest(manifest)
  const cases = []
  const files = [{ file: MANIFEST_FILE, sha256: sha256(fs.readFileSync(manifestPath, 'utf8')) }]
  for (const entry of manifest.cases) {
    const casePath = path.join(dir, entry.file)
    if (!fs.existsSync(casePath)) fixtureError('manifest references missing case file ' + entry.file)
    const raw = fs.readFileSync(casePath, 'utf8')
    files.push({ file: entry.file, sha256: sha256(raw) })
    const caseDef = JSON.parse(raw)
    validateCaseShape(caseDef, entry.file)
    if (caseDef.id !== entry.id) fixtureError(entry.file + ': case id ' + caseDef.id + ' does not match the manifest entry ' + entry.id)
    if (caseDef.interference !== entry.interference) fixtureError(entry.file + ': interference must match the manifest entry')
    const snapshot = expandCaseSnapshot(caseDef)
    if (settings.verifyPins !== false) {
      if (snapshot.digest !== entry.snapshotSha256) {
        fixtureError(entry.file + ': snapshot digest ' + snapshot.digest + ' does not match the manifest pin ' + entry.snapshotSha256)
      }
      if (snapshot.throughSeq !== entry.throughSeq) fixtureError(entry.file + ': throughSeq ' + snapshot.throughSeq + ' does not match the manifest pin ' + entry.throughSeq)
    }
    cases.push({ id: caseDef.id, def: caseDef, snapshot, file: entry.file, manifest: entry })
  }
  return {
    dir,
    name: manifest.name,
    status: manifest.status,
    draft: true,
    notGold: true,
    gold: false,
    review: manifest.review,
    axes: manifest.axes.slice(),
    cases,
    files,
    digest: sha256(manifest.cases.map(entry => entry.snapshotSha256).join('|')),
    manifest,
  }
}

/* ------------------------------------------------------------------ */
/* 触发计划：生产纯函数 + 旧行为对照                                     */
/* ------------------------------------------------------------------ */

function indexOfLastEventAtOrBefore(events, seq, predicate) {
  for (let index = Math.min(seq, events.length - 1); index >= 0; index -= 1) {
    if (predicate(events[index], index)) return index
  }
  return -1
}

/** 该边界之后到下一个事件之间的空闲分钟数；快照末尾用 fixture 声明值。 */
export function idleMinutesAfter(events, boundary, throughSeq, snapshot) {
  const current = Date.parse(events[boundary] && events[boundary].at)
  if (!Number.isFinite(current)) return 0
  for (let index = boundary + 1; index <= throughSeq; index += 1) {
    const next = Date.parse(events[index].at)
    if (Number.isFinite(next) && next >= current) return (next - current) / 60000
  }
  const tail = snapshot && Number.isFinite(Number(snapshot.idleAtSnapshotEndMinutes)) ? Number(snapshot.idleAtSnapshotEndMinutes) : 0
  return tail
}

/** 主模型主动写：tool/call 带 memoryId，且后面跟着非错误结果。 */
export function mainDirectWrites(events, throughSeq) {
  const writes = []
  const limit = Math.min(Number(throughSeq) || 0, events.length - 1)
  for (let index = 0; index <= limit; index += 1) {
    const event = events[index]
    if (!event || event.type !== 'tool/call') continue
    const name = event.name || (event.data && event.data.name) || ''
    if (!MEMORY_WRITE_TOOL_NAMES.includes(name)) continue
    const args = event.arguments || (event.data && event.data.arguments) || {}
    const memoryId = typeof args.memoryId === 'string' ? args.memoryId : null
    let ok = false
    const toolCallId = toolCallIdOf(event)
    for (let cursor = index + 1; cursor <= limit; cursor += 1) {
      const next = events[cursor]
      if (!next) continue
      if (next.type === 'tool/call') break
      if (next.type !== 'tool/result') continue
      const resultId = toolCallIdOf(next)
      if (toolCallId && resultId && resultId !== toolCallId) continue
      ok = !(next.data && next.data.message && next.data.message.isError === true)
      break
    }
    writes.push({ seq: index, tool: name, memoryId, ok })
  }
  return writes
}

export function countMemoryToolCalls(events, throughSeq) {
  const limit = Math.min(Number(throughSeq) || 0, events.length - 1)
  let total = 0
  let writes = 0
  for (let index = 0; index <= limit; index += 1) {
    const event = events[index]
    if (!event || event.type !== 'tool/call') continue
    const name = event.name || (event.data && event.data.name) || ''
    if (!MEMORY_TOOL_NAMES.includes(name)) continue
    total += 1
    if (MEMORY_WRITE_TOOL_NAMES.includes(name)) writes += 1
  }
  return { total, writes }
}

export function countSteps(events, throughSeq) {
  const limit = Math.min(Number(throughSeq) || 0, events.length - 1)
  let steps = 0
  for (let index = 0; index <= limit; index += 1) if (events[index].type === 'step/start') steps += 1
  return steps
}

function humanTurnsBetween(events, fromSeq, toSeq) {
  let count = 0
  for (let index = fromSeq + 1; index <= toSeq && index < events.length; index += 1) {
    const event = events[index]
    if (event.type === 'user/message' && event.data && event.data.source && event.data.source.kind === 'user') count += 1
  }
  return count
}

/* ------------------------------------------------------------------ */
/* 全局干扰：独立维度，不进主表                                          */
/* ------------------------------------------------------------------ */

export function buildInterferenceInput(snapshot, caseDef) {
  const level = caseDef.interference
  const entries = snapshot.globalEntries
  let selected = []
  if (level === 'relevant') selected = entries.filter(entry => entry.relevant === true)
  else if (level === 'irrelevant-conflict') selected = entries.filter(entry => entry.relevant !== true)
  const ids = new Set(selected.map(entry => entry.id))
  const conflictLabelIds = []
  for (const conflict of snapshot.conflicts) {
    if (!ids.has(conflict.globalId)) continue
    if (!conflictLabelIds.includes(conflict.labelId)) conflictLabelIds.push(conflict.labelId)
  }
  const anchorText = selected.map(entry => String(entry.title || '') + ' ' + String(entry.content || '')).join(' ')
  return {
    level,
    globalIds: selected.map(entry => entry.id),
    conflictLabelIds,
    anchorTokens: estTokens(anchorText),
    anchorChars: anchorText.length,
  }
}

/* ------------------------------------------------------------------ */
/* worker 适配器契约（C 包接口依赖，可注入）                             */
/* ------------------------------------------------------------------ */

/**
 * 适配器输入 ctx：
 *   { caseId, rowId, condition, path, fromSeq, throughSeq, snapshotSha256, scopeGeneration,
 *     events（只含逻辑检查范围）, seedEvents（从 0 到 boundary 的完整连续前缀）,
 *     labels（全部）, labelsInRange, existingIds, interferenceInput,
 *     halfStep, now, transcriptEvents, evidence }
 * 适配器输出（凭证主体）：
 *   { status, outcome, createdIds, updatedIds, heldIds, reasonCode, retryable }
 * 边界身份（checked.*）由 harness 自己补，适配器不许自报。
 */
export function oracleWorker(ctx) {
  const created = []
  const updated = []
  const held = []
  for (const label of ctx.labelsInRange) {
    if (ctx.existingIds.includes(label.id)) continue
    if (ctx.interferenceInput.conflictLabelIds.includes(label.id)) held.push(label.id)
    else if (label.action === 'update') updated.push(label.id)
    else created.push(label.id)
  }
  const writes = created.length + updated.length
  let outcome = 'no_value'
  if (writes > 0 && held.length > 0) outcome = 'mixed'
  else if (created.length > 0 && updated.length > 0) outcome = 'mixed'
  else if (created.length > 0) outcome = 'created'
  else if (updated.length > 0) outcome = 'updated'
  return { status: 'completed', outcome, createdIds: created, updatedIds: updated, heldIds: held, reasonCode: outcome, retryable: false }
}

export function noValueWorker() {
  return { status: 'completed', outcome: 'no_value', createdIds: [], updatedIds: [], heldIds: [], reasonCode: 'no-candidate', retryable: false }
}

/* ------------------------------------------------------------------ */
/* 真 worker 结构行：回执 → 凭证                                       */
/* ------------------------------------------------------------------ */

/**
 * C 包的 receipt 走 ````memu-consolidation-receipt` 围栏，harness 的凭证是扁平对象。
 * 两者有三处语义差，这里一次性抹平，并把差异写成断言而不是悄悄吞掉：
 *   1. 非 terminal 的 outcome 在 C 包可以是 null，harness 要求枚举内 → 兜底 no_value；
 *   2. harness 规定非 completed 不得声称任何 id → 非 completed 一律清空三个桶；
 *   3. C 包的完成语义只为 created+updated 记 mixed（`consolidation-receipt.js:125-128`），
 *      而 oracle 适配器把 held 也算进 mixed。所以 held-only 的冲突会落成 created/updated，
 *      两条行的 outcomeCounts 会不同，但 coverage 必须一致（测试里断言这一点）。
 */
export function receiptToCredential(receipt) {
  const record = receipt && typeof receipt === 'object' ? receipt : {}
  const status = CREDENTIAL_STATUSES.includes(record.status) ? record.status : 'failed'
  const outcome = CREDENTIAL_OUTCOMES.includes(record.outcome) ? record.outcome : 'no_value'
  const reasonCode = typeof record.reasonCode === 'string' && record.reasonCode ? record.reasonCode : status
  const retryable = record.retryable === true
  const asIds = (value) => (Array.isArray(value) ? value.filter(id => typeof id === 'string' && id) : [])
  if (status !== 'completed') {
    return { status, outcome, createdIds: [], updatedIds: [], heldIds: [], reasonCode, retryable }
  }
  return { status, outcome, createdIds: asIds(record.createdIds), updatedIds: asIds(record.updatedIds), heldIds: asIds(record.heldIds), reasonCode, retryable }
}

/**
 * 脚本化的"worker 最终消息"。真实环境里这段文本来自
 * `lib/private.js` 的 followup + whenIdle 之后的 assistant 文本；harness 里换成
 * 确定性生成，好让回执解析与凭证校验这一段能被无网络地回归。
 * 决策与 oracleWorker 完全同源，唯一区别是它必须走 C 包的围栏格式。
 */
export function buildWorkerReceiptMessage(ctx, overrides = {}) {
  const created = []
  const updated = []
  const held = []
  for (const label of ctx.labelsInRange) {
    if (ctx.existingIds.includes(label.id)) continue
    if (ctx.interferenceInput.conflictLabelIds.includes(label.id)) held.push(label.id)
    else if (label.action === 'update') updated.push(label.id)
    else created.push(label.id)
  }
  // C 包的 mixed 只认 created + updated 同时非空，held 不参与。
  let outcome = 'no_value'
  if (created.length > 0 && updated.length > 0) outcome = 'mixed'
  else if (created.length > 0) outcome = 'created'
  else if (updated.length > 0) outcome = 'updated'
  const receipt = {
    version: 1,
    jobId: 'ab-' + String(ctx.caseId || 'case') + '-' + String(ctx.throughSeq),
    snapshotHash: ctx.snapshotSha256,
    status: 'completed',
    outcome,
    checkedRange: { fromSeq: ctx.fromSeq, throughSeq: ctx.throughSeq },
    createdIds: created,
    updatedIds: updated,
    heldIds: held,
    retryable: false,
    ...overrides,
  }
  return ['整理完成，回执如下。', RECEIPT_FENCE, JSON.stringify(receipt, null, 2), RECEIPT_FENCE].join('\n')
}

/** 真 worker 结构行：任意 worker 文本 → parseReceipt（生产纯函数）→ 凭证主体。 */
export function workerStructuralFromMessage(text) {
  const parsed = parseReceipt(text)
  if (!parsed.ok) {
    // 三类失败原样透传：receipt-missing / receipt-malformed / receipt-invalid。
    // 空输出不是 no_value：真实 worker 的空白/截断必须算失败并可重试。
    return { status: 'failed', outcome: 'no_value', createdIds: [], updatedIds: [], heldIds: [], reasonCode: parsed.reasonCode, retryable: true }
  }
  return receiptToCredential(parsed.receipt)
}

export function workerStructuralWorker(ctx) {
  return workerStructuralFromMessage(buildWorkerReceiptMessage(ctx))
}

export const WORKERS = Object.freeze({ oracle: oracleWorker, 'no-value': noValueWorker, 'worker-structural': workerStructuralWorker })

export function buildCredential(request, result) {
  const payload = result || {}
  return {
    checked: {
      fromSeq: request.fromSeq,
      throughSeq: request.throughSeq,
      snapshotSha256: request.snapshotSha256,
      scopeGeneration: request.scopeGeneration,
    },
    status: payload.status,
    outcome: payload.outcome,
    createdIds: Array.isArray(payload.createdIds) ? payload.createdIds.slice() : [],
    updatedIds: Array.isArray(payload.updatedIds) ? payload.updatedIds.slice() : [],
    heldIds: Array.isArray(payload.heldIds) ? payload.heldIds.slice() : [],
    reasonCode: typeof payload.reasonCode === 'string' ? payload.reasonCode : null,
    retryable: payload.retryable === true,
  }
}

/** 凭证校验：边界身份必须与请求一致，内部计数不能自相矛盾。 */
export function validateCredential(credential, request) {
  const problems = []
  if (!isPlainObject(credential)) return ['credential must be an object']
  const checked = credential.checked
  if (!isPlainObject(checked)) problems.push('credential.checked is missing')
  else {
    if (checked.fromSeq !== request.fromSeq) problems.push('checked.fromSeq ' + checked.fromSeq + ' != ' + request.fromSeq)
    if (checked.throughSeq !== request.throughSeq) problems.push('checked.throughSeq ' + checked.throughSeq + ' != ' + request.throughSeq)
    if (checked.snapshotSha256 !== request.snapshotSha256) problems.push('checked.snapshotSha256 does not match the fixed snapshot')
    if (checked.scopeGeneration !== request.scopeGeneration) problems.push('checked.scopeGeneration does not match')
  }
  if (!CREDENTIAL_STATUSES.includes(credential.status)) problems.push('unknown status ' + credential.status)
  if (!CREDENTIAL_OUTCOMES.includes(credential.outcome)) problems.push('unknown outcome ' + credential.outcome)
  for (const field of ['createdIds', 'updatedIds', 'heldIds']) {
    const value = credential[field]
    if (!Array.isArray(value)) problems.push(field + ' must be an array')
    else if (value.some(id => typeof id !== 'string' || !id.trim())) problems.push(field + ' must contain non-empty ids')
  }
  const created = Array.isArray(credential.createdIds) ? credential.createdIds : []
  const updated = Array.isArray(credential.updatedIds) ? credential.updatedIds : []
  const held = Array.isArray(credential.heldIds) ? credential.heldIds : []
  const overlap = created.filter(id => updated.includes(id) || held.includes(id)).concat(updated.filter(id => held.includes(id)))
  if (overlap.length > 0) problems.push('ids reported in more than one bucket: ' + overlap.join(','))
  if (new Set(created).size !== created.length) problems.push('createdIds contains duplicates')
  if (credential.status !== 'completed' && (created.length + updated.length + held.length) > 0) {
    problems.push('a ' + credential.status + ' credential must not claim written ids')
  }
  if (credential.status === 'completed' && credential.outcome === 'no_value' && (created.length + updated.length) > 0) {
    problems.push('outcome no_value with created/updated ids')
  }
  if (credential.status === 'completed' && credential.outcome !== 'no_value') {
    if ((created.length + updated.length) === 0 && held.length === 0) problems.push('outcome ' + credential.outcome + ' without any ids')
  }
  return problems
}

/** 只有带凭证的 completed（含 no_value）才推进游标（§13.6 游标与恢复）。 */
export function canAdvance(credential) {
  return isPlainObject(credential) && credential.status === 'completed' && CREDENTIAL_OUTCOMES.includes(credential.outcome)
}

/* ------------------------------------------------------------------ */
/* 条件执行                                                             */
/* ------------------------------------------------------------------ */

async function executeRow(input) {
  const { caseDef, snapshot, row, worker } = input
  const policy = ACTIVE_MEMORY_POLICY
  const events = snapshot.events
  const limit = snapshot.throughSeq
  const fullPrefix = row.path === 'full-prefix-fork'
  const guideDelivered = row.condition !== 'legacy'
  const interferenceInput = buildInterferenceInput(snapshot, caseDef)
  const interferenceIds = new Set(interferenceInput.globalIds)
  const labels = caseDef.labels.expected.map(label => ({ ...label }))
  const labelById = new Map(labels.map(label => [label.id, label]))

  const written = new Map()
  const mainWrites = mainDirectWrites(events, limit)
  for (const write of mainWrites) {
    if (write.ok && write.memoryId && labelById.has(write.memoryId)) written.set(write.memoryId, { by: 'main', seq: write.seq })
  }

  const boundaries = []
  for (let index = 0; index <= limit; index += 1) if (events[index].type === 'turn/end') boundaries.push(index)
  if (snapshot.pendingCheck && row.path === 'snapshot-worker' && (boundaries.length === 0 || boundaries[boundaries.length - 1] < limit)) boundaries.push(limit)

  const checks = []
  const blocked = []
  let cursor = snapshot.fromSeq
  let lastSleepAt = null
  let measuredAdapterMs = 0
  let leaks = 0
  let deferredCount = 0
  let skippedCount = 0
  let failedCount = 0
  let invalidCount = 0
  const deferredReasons = []

  for (const boundary of boundaries) {
    const fromSeq = fullPrefix ? snapshot.fromSeq : cursor
    if (!fullPrefix && fromSeq > boundary) continue
    const idle = idleMinutesAfter(events, boundary, limit, snapshot)
    const windowEvents = events.slice(fromSeq, boundary + 1)
    const evidence = collectEvidence(windowEvents, policy)
    const transcriptEvents = boundary + 1
    const now = Date.parse(events[boundary].at)
    const scored = scoreEvidence(evidence, policy)

    let trigger = null
    let blockedReason = null
    let verdictReason = null
    if (fullPrefix) {
      if (idle >= LEGACY_IDLE_MINUTES) trigger = 'legacy-idle'
      else blockedReason = 'no-idle-gap'
    } else {
      const suppressed = suppressionReason({
        now,
        lastSleepAt,
        lastInjectedAt: snapshot.lastInjectedAt,
        consolidatedCooldownMinutes: 0,
        recallCooldownMinutes: policy.recallCooldownMinutes,
      })
      if (suppressed) blockedReason = suppressed
      else {
        const verdict = assessWake({ evidence, starved: idle >= policy.starvationMinutes, transcriptEvents, pendingEvents: snapshot.pendingEvents, policy })
        verdictReason = verdict.reason
        if (verdict.wake) trigger = verdict.reason
        else blockedReason = verdict.reason
      }
    }
    if (!trigger) {
      blocked.push({
        throughSeq: boundary,
        fromSeq,
        reason: blockedReason,
        idleMinutes: round(idle, 3),
        transcriptEvents,
        humanTurns: evidence.humanTurns,
        score: scored.score,
      })
      continue
    }

    const labelsInRange = labels.filter(label => label.sourceSeq >= fromSeq && label.sourceSeq <= boundary)
    const halfStep = !fullPrefix && detectHalfStep(events, boundary)
    const seedEvents = events.slice(0, boundary + 1)
    const labelIdsInRange = new Set(labelsInRange.map(label => label.id))
    const existingIds = [...written.keys()].filter(id => labelIdsInRange.has(id))
    const ctx = {
      caseId: snapshot.caseId,
      rowId: row.id,
      condition: row.condition,
      path: row.path,
      fromSeq,
      throughSeq: boundary,
      snapshotSha256: snapshot.digest,
      scopeGeneration: snapshot.scopeGeneration,
      events: windowEvents.slice(),
      seedEvents: seedEvents.slice(),
      labels,
      labelsInRange,
      existingIds,
      interferenceInput,
      halfStep,
      now,
      transcriptEvents,
      evidence,
    }
    const request = { fromSeq, throughSeq: boundary, snapshotSha256: snapshot.digest, scopeGeneration: snapshot.scopeGeneration }
    const startedAt = process.hrtime.bigint()
    let adapterResult
    if (halfStep) adapterResult = { status: 'deferred', outcome: 'no_value', createdIds: [], updatedIds: [], heldIds: [], reasonCode: 'half-step', retryable: true }
    else adapterResult = await worker(ctx)
    measuredAdapterMs += Number(process.hrtime.bigint() - startedAt) / 1e6

    const credential = buildCredential(request, adapterResult)
    const problems = validateCredential(credential, request)
    const advanced = problems.length === 0 && canAdvance(credential)
    if (problems.length > 0) invalidCount += 1
    if (credential.status === 'deferred') deferredCount += 1
    if (credential.status === 'skipped') skippedCount += 1
    if (credential.status === 'failed') failedCount += 1
    if (credential.status === 'deferred') deferredReasons.push(credential.reasonCode || 'deferred')

    const proposed = labelsInRange.map(label => label.id)
    let reproposed = 0
    for (const id of proposed) if (written.has(id)) reproposed += 1
    let alreadyPresent = 0
    if (advanced) {
      for (const id of credential.createdIds) {
        if (!labelById.has(id)) continue
        written.set(id, { by: 'background', seq: boundary })
      }
      for (const id of credential.updatedIds) {
        if (written.has(id)) alreadyPresent += 1
        written.set(id, { by: 'background', seq: boundary })
      }
      for (const id of credential.heldIds) {
        if (!written.has(id)) written.set(id, { by: 'background-held', seq: boundary })
      }
      for (const id of [...credential.createdIds, ...credential.updatedIds, ...credential.heldIds]) {
        if (interferenceIds.has(id)) leaks += 1
      }
      cursor = boundary + 1
      lastSleepAt = new Date(now).toISOString()
    }

    // Eligibility stays on the logical cursor window, but production fork seeds are
    // always the complete contiguous prefix through this boundary.  Do not model a
    // windowed seed: private.js buildForkSeed(events, throughSeq) has no such mode.
    const seedText = seedEvents.map(event => eventText(event)).join(' ')
    checks.push({
      fromSeq,
      throughSeq: boundary,
      trigger,
      blockedReason,
      verdictReason,
      idleMinutes: round(idle, 3),
      transcriptEvents,
      starved: idle >= policy.starvationMinutes,
      score: scored.score,
      scoreParts: scored.parts,
      evidence,
      halfStep,
      status: credential.status,
      outcome: credential.outcome,
      reasonCode: credential.reasonCode,
      retryable: credential.retryable,
      createdIds: credential.createdIds,
      updatedIds: credential.updatedIds,
      heldIds: credential.heldIds,
      credentialValid: problems.length === 0,
      problems,
      cursorAdvanced: advanced,
      reproposed,
      alreadyPresent,
      seedTokens: estTokens(seedText),
      seedEvents: seedEvents.length,
    })
  }

  const labelsOut = labels.map(label => {
    const record = written.get(label.id)
    const coveredBy = record ? record.by : null
    let latency = null
    if (coveredBy && coveredBy !== 'background-held') {
      const writeSeq = record.seq
      latency = {
        humanTurns: humanTurnsBetween(events, label.sourceSeq, writeSeq),
        steps: 0,
      }
      for (let index = label.sourceSeq + 1; index <= writeSeq && index < events.length; index += 1) {
        if (events[index].type === 'step/end') latency.steps += 1
      }
    }
    return {
      id: label.id,
      class: label.class,
      sourceSeq: label.sourceSeq,
      covered: coveredBy === 'main' || coveredBy === 'background',
      coveredBy,
      latency,
    }
  })

  const guideTurnCount = boundaries.length === 0 ? 0 : (() => {
    let turns = 0
    for (let index = 0; index <= limit; index += 1) if (events[index].type === 'turn/start') turns += 1
    return turns
  })()

  const checksWithWrites = checks.filter(check => check.createdIds.length + check.updatedIds.length > 0).length
  const noValue = checks.filter(check => check.outcome === 'no_value' && check.status === 'completed').length
  const seedTokensTotal = checks.reduce((sum, check) => sum + check.seedTokens, 0)
  const toolCalls = countMemoryToolCalls(events, limit)
  return {
    caseId: snapshot.caseId,
    rowId: row.id,
    condition: row.condition,
    path: row.path,
    adapter: row.adapter,
    interference: interferenceInput.level,
    snapshot: {
      throughSeq: snapshot.throughSeq,
      eventCount: snapshot.eventCount,
      tailEvents: snapshot.tailEvents,
      sha256: snapshot.digest,
      scopeGeneration: snapshot.scopeGeneration,
      halfStep: snapshot.halfStep,
    },
    guide: {
      delivered: guideDelivered,
      deliveries: guideDelivered ? guideTurnCount : 0,
      rulesKey: guideDelivered ? sha256(GUIDE_RULES_SALT + '|' + snapshot.domain + '|' + caseDef.id).slice(0, 16) : null,
      note: guideDelivered ? 'rulesKey 是投放契约占位符，不是生产 guide 正文' : 'legacy 条件不投放 guide 消息',
    },
    checks,
    blocked,
    labels: labelsOut,
    labelsTotal: labelsOut.length,
    cursor: {
      mode: fullPrefix ? 'lastSleepSeq-full-prefix' : 'snapshot-credit-contiguous',
      startedAtSeq: snapshot.fromSeq,
      finalSeq: fullPrefix ? null : cursor,
      advanced: checks.some(check => check.cursorAdvanced),
    },
    calls: {
      memoryToolCalls: toolCalls.total,
      memoryWriteCalls: toolCalls.writes,
      backgroundChecks: checks.length,
      checksWithWrites,
      steps: countSteps(events, limit),
    },
    evidence: {
      humanTurns: collectEvidence(events.slice(snapshot.fromSeq, limit + 1), policy).humanTurns,
    },
    cost: {
      seedTokensTotal,
      seedTokensPerCheck: checks.length === 0 ? 0 : round(seedTokensTotal / checks.length, 1),
      estimateOnly: true,
    },
    blocking: {
      structural: 'parent-blocking-not-measured',
      mainSessionWaitForCheck: null,
      measuredAdapterMs: round(measuredAdapterMs, 3),
      note: 'both fork paths are represented structurally; parent-session blocking and wait duration were not measured',
    },
    outcomeCounts: { noValue, deferred: deferredCount, skipped: skippedCount, failed: failedCount, invalidCredential: invalidCount, deferredReasons },
    interferenceReport: {
      level: interferenceInput.level,
      globalIds: interferenceInput.globalIds,
      conflictLabelIds: interferenceInput.conflictLabelIds,
      anchorTokens: interferenceInput.anchorTokens,
      anchorChars: interferenceInput.anchorChars,
      leaks,
      heldIds: checks.flatMap(check => check.heldIds),
    },
  }
}

/* ------------------------------------------------------------------ */
/* 汇总                                                                 */
/* ------------------------------------------------------------------ */

function summarizeRow(runs) {
  const cases = runs.length
  let labelsTotal = 0
  let mainProactive = 0
  let background = 0
  let covered = 0
  let held = 0
  let uncovered = 0
  const latencies = []
  let checks = 0
  let noValue = 0
  let deferred = 0
  let failed = 0
  let invalid = 0
  let reproposed = 0
  let alreadyPresent = 0
  let seedTokens = 0
  let memoryToolCalls = 0
  let writeCalls = 0
  let steps = 0
  let humanTurns = 0
  let heldIds = []
  let leaks = 0
  let anchorTokens = 0
  const blockedByReason = {}
  const wakeTriggers = {}
  for (const run of runs) {
    for (const item of run.blocked) blockedByReason[item.reason] = (blockedByReason[item.reason] || 0) + 1
    for (const check of run.checks) wakeTriggers[check.trigger] = (wakeTriggers[check.trigger] || 0) + 1
    labelsTotal += run.labelsTotal
    for (const label of run.labels) {
      if (label.coveredBy === 'main') mainProactive += 1
      if (label.coveredBy === 'background') background += 1
      if (label.covered) covered += 1
      else if (label.coveredBy === 'background-held') held += 1
      else uncovered += 1
      if (label.latency) latencies.push(label.latency)
    }
    heldIds = heldIds.concat(run.interferenceReport.heldIds)
    checks += run.checks.length
    noValue += run.outcomeCounts.noValue
    deferred += run.outcomeCounts.deferred
    failed += run.outcomeCounts.failed
    invalid += run.outcomeCounts.invalidCredential
    seedTokens += run.cost.seedTokensTotal
    memoryToolCalls += run.calls.memoryToolCalls
    writeCalls += run.calls.memoryWriteCalls
    steps += run.calls.steps
    humanTurns += run.evidence.humanTurns
    leaks += run.interferenceReport.leaks
    anchorTokens += run.interferenceReport.anchorTokens
    for (const check of run.checks) {
      reproposed += check.reproposed
      alreadyPresent += check.alreadyPresent
    }
  }
  const humanTurnLatencies = latencies.map(item => item.humanTurns)
  const stepLatencies = latencies.map(item => item.steps)
  const sortedTurns = humanTurnLatencies.slice().sort((left, right) => left - right)
  return {
    row: runs.length > 0 ? runs[0].rowId : null,
    condition: runs.length > 0 ? runs[0].condition : null,
    adapter: runs.length > 0 ? runs[0].adapter : null,
    path: runs.length > 0 ? runs[0].path : null,
    cases,
    coverage: {
      labelsTotal,
      mainProactive,
      background,
      covered,
      held: heldIds.length,
      uncovered,
      rate: labelsTotal === 0 ? null : round(covered / labelsTotal, 4),
      interpretation: 'oracle 适配器给的是管线可行上界；no-value 适配器给下界。两者都不是模型实测。',
    },
    latency: {
      measuredOnLabels: latencies.length,
      meanHumanTurns: humanTurnLatencies.length === 0 ? null : round(humanTurnLatencies.reduce((sum, value) => sum + value, 0) / humanTurnLatencies.length, 3),
      maxHumanTurns: sortedTurns.length === 0 ? null : sortedTurns[sortedTurns.length - 1],
      medianHumanTurns: sortedTurns.length === 0 ? null : sortedTurns[Math.floor(sortedTurns.length / 2)],
      meanSteps: stepLatencies.length === 0 ? null : round(stepLatencies.reduce((sum, value) => sum + value, 0) / stepLatencies.length, 3),
      unit: 'human-turns / step-end（已完成步骤）between the labelled seq and the write',
    },
    noValue: { checks, noValueOutcomes: noValue, rate: checks === 0 ? null : round(noValue / checks, 4) },
    duplicates: { reproposed, alreadyPresent },
    held: { count: heldIds.length, ids: heldIds.slice(0, 40) },
    calls: {
      backgroundChecks: checks,
      memoryToolCalls,
      memoryWriteCalls: writeCalls,
      per1000Steps: steps === 0 ? null : round((checks * 1000) / steps, 3),
      steps,
    },
    evidence: { humanTurns },
    cost: {
      seedTokensTotal: seedTokens,
      seedTokensPerCheck: checks === 0 ? 0 : round(seedTokens / checks, 1),
      estimateOnly: true,
      method: 'lib/budget.js estTokens over all text in the complete contiguous seed prefix [0..throughSeq]',
    },
    blocking: {
      mainSessionWaitForCheck: null,
      note: 'parent-session blocking / wait is unknown and not measured; this harness has no duration observation',
    },
    scheduler: { blockedByReason, wakeTriggers },
    statuses: { deferred, failed, invalidCredential: invalid },
    interference: { anchorTokens, leaks },
  }
}

function delta(baseline, candidate) {
  const out = {}
  const keys = ['covered', 'rate', 'uncovered']
  for (const key of keys) {
    const before = baseline.coverage[key]
    const after = candidate.coverage[key]
    out[key] = before === null || after === null ? null : round(after - before, 4)
  }
  out.backgroundChecks = candidate.calls.backgroundChecks - baseline.calls.backgroundChecks
  out.seedTokensTotal = candidate.cost.seedTokensTotal - baseline.cost.seedTokensTotal
  out.reproposed = candidate.duplicates.reproposed - baseline.duplicates.reproposed
  return out
}

export async function runAb(options) {
  const settings = options || {}
  const startedAt = new Date().toISOString()
  const dataset = loadDataset({ fixtureDir: settings.fixtureDir })
  const rowIds = Array.isArray(settings.rowIds) && settings.rowIds.length > 0 ? settings.rowIds : DEFAULT_ROW_IDS
  const rows = ROWS.filter(row => rowIds.includes(row.id))
  for (const id of rowIds) if (!ROWS.some(row => row.id === id)) throw new Error('active-memory-ab: unknown row ' + id)
  const workers = { ...WORKERS, ...(settings.workers || {}) }
  const caseLimit = Number.isFinite(settings.caseLimit) ? Math.max(0, Math.min(settings.caseLimit, dataset.cases.length)) : dataset.cases.length
  const cases = dataset.cases.slice(0, caseLimit)
  const runs = []
  for (const entry of cases) {
    for (const row of rows) {
      const worker = workers[row.adapter]
      if (typeof worker !== 'function') throw new Error('active-memory-ab: unknown worker adapter ' + row.adapter)
      runs.push(await executeRow({ caseDef: entry.def, snapshot: entry.snapshot, row, worker }))
    }
  }

  const cleanRuns = runs.filter(run => run.interference === 'off')
  const mainAxisRows = rowIds.map(id => summarizeRow(cleanRuns.filter(run => run.rowId === id).length > 0 ? cleanRuns.filter(run => run.rowId === id) : []))
  const baseline = mainAxisRows.find(item => item.row === 'legacy')
  const deltas = mainAxisRows.filter(item => item.row !== 'legacy').map(item => ({
    row: item.row,
    versus: 'legacy',
    delta: baseline ? delta(baseline, item) : null,
  }))

  const interferenceRows = INTERFERENCE_LEVELS.map(level => {
    const levelRuns = runs.filter(run => run.interference === level && run.rowId === 'guide-weighted:oracle')
    const summary = summarizeRow(levelRuns)
    return {
      level,
      cases: summary.cases,
      backgroundChecks: summary.calls.backgroundChecks,
      anchorTokens: summary.interference.anchorTokens,
      leaks: summary.interference.leaks,
      held: summary.held.count,
      covered: summary.coverage.covered,
      uncovered: summary.coverage.uncovered,
    }
  })

  const structureChecks = []
  for (const run of runs) {
    let previous = run.cursor.startedAtSeq
    for (const check of run.checks) {
      if (check.fromSeq !== previous) structureChecks.push({ caseId: run.caseId, rowId: run.rowId, problem: 'range is not contiguous with the previous cursor', fromSeq: check.fromSeq, expected: previous })
      if (check.cursorAdvanced) previous = check.throughSeq + 1
    }
    if (run.interferenceReport.leaks !== 0) structureChecks.push({ caseId: run.caseId, rowId: run.rowId, problem: 'global entry leaked into a private write', leaks: run.interferenceReport.leaks })
    for (const check of run.checks) {
      if (!check.credentialValid) structureChecks.push({ caseId: run.caseId, rowId: run.rowId, problem: 'invalid credential', problems: check.problems })
    }
  }

  const reviewedCases = dataset.cases.filter(entry => entry.def.review === 'human-reviewed').length
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'active-memory-ab',
    ok: structureChecks.length === 0,
    status: dataset.status,
    gold: false,
    goldGating: {
      humanReviewRequired: true,
      goldAllowed: false,
      reviewedCases,
      candidateCases: dataset.cases.length - reviewedCases,
      note: '合成代理标注一律 notGold。人审候选与 gold gating 分开：review 只有在人工逐条确认后才改，且本 harness 不改它。',
    },
    dataset: {
      name: dataset.name,
      status: dataset.status,
      draft: true,
      notGold: true,
      gold: false,
      review: dataset.review,
      caseCount: dataset.cases.length,
      fileCount: dataset.files.length,
      casesDigest: dataset.digest,
      files: dataset.files,
    },
    model: {
      executed: false,
      networkCalls: 0,
      realModelCalls: 0,
      requiresUserOptIn: true,
      note: '本轮不做真实模型调用；真实模型 A/B 必须由用户明确选择后另行实现。',
    },
    pipeline: {
      note: '这里只证明调度/管线与凭证规则；不证明真实模型的主功率或记忆质量。',
      productionFunctions: ['lib/active-memory.js collectEvidence/scoreEvidence/assessWake/suppressionReason', 'lib/budget.js estTokens'],
    },
    run: {
      startedAt,
      clock: '固定：每个 case 用自己事件里的时间戳，末尾空闲用 fixture 声明值',
      rowIds,
      caseLimit,
    },
    config: {
      conditions: CONDITIONS.slice(),
      rows: ROWS.map(row => ({ id: row.id, condition: row.condition, adapter: row.adapter, path: row.path })),
      legacyIdleMinutes: LEGACY_IDLE_MINUTES,
      policy: {
        version: ACTIVE_MEMORY_POLICY.version,
        minScore: ACTIVE_MEMORY_POLICY.minScore,
        starvationMinutes: ACTIVE_MEMORY_POLICY.starvationMinutes,
        largeTranscriptEvents: ACTIVE_MEMORY_POLICY.largeTranscriptEvents,
        recallCooldownMinutes: ACTIVE_MEMORY_POLICY.recallCooldownMinutes,
        weights: { ...ACTIVE_MEMORY_POLICY.weights },
      },
    },
    mainAxis: {
      subset: 'interference = off（全局干扰是独立维度，不进这张表）',
      note: 'legacy 与 guide 在这些 fixture 上的调度完全相同：guide 只改变投放的规则消息，不改变什么时候检查。两者在真实会话里的差别只能由真实模型调用测出，本 harness 不作结论。',
      rows: mainAxisRows,
      deltas,
    },
    interferenceAxis: {
      subset: 'guide-weighted:oracle 行，按全局干扰等级分组',
      rows: interferenceRows,
    },
    bounds: {
      coverageUpper: 'guide-weighted:oracle（适配器是注解预言机，给管线可行上界）',
      coverageLower: 'guide-weighted:no-value（检查总返回 no_value 时的下界）',
      note: '真实模型落在两者之间，本 harness 未测。',
    },
    unmeasured: [
      '主模型主动率（需要真实模型调用与用户明确授权）',
      'guide 正文对模型遵从性的影响',
      '后台 worker 的语义判断质量（oracle 适配器是上界）',
      '真实 prompt 延迟与主任务阻塞耗时',
      '真实 token 消耗（这里只有 estimate）',
    ],
    structureChecks,
    cases: runs,
  }
}

export function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (REAL_MODEL_FLAGS.includes(arg)) {
      throw new Error('active-memory-ab: ' + arg + ' requires an explicit user decision and is not implemented; this harness never calls a model or the network')
    }
    if (arg === '--out') options.out = argv[++index]
    else if (arg === '--fixture-dir') {
      const dir = argv[++index]
      if (!dir || dir.startsWith('--')) throw new Error('active-memory-ab: --fixture-dir requires a directory')
      options.fixtureDir = dir
    }
    else if (arg === '--cases') {
      const limit = Number(argv[++index])
      if (!Number.isInteger(limit) || limit < 1) throw new Error('active-memory-ab: --cases requires a positive integer')
      options.caseLimit = limit
    }
    else if (arg === '--row') {
      const id = argv[++index]
      if (!ROWS.some(row => row.id === id)) throw new Error('active-memory-ab: unknown row ' + id)
      options.rowIds = (options.rowIds || []).concat([id])
    }
    else if (arg === '--digests') options.digests = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error('active-memory-ab: unknown argument ' + arg)
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: node scripts/active-memory-ab.mjs [--fixture-dir DIR] [--out report.json] [--cases N] [--row ID]')
    console.log('  Deterministic replay only: no model calls, no network, no user conversation text.')
    console.log('  Rows: ' + ROWS.map(row => row.id).join(', '))
    console.log('  --digests  只打印每个 case 的 throughSeq 与快照摘要，供人工重新钉 manifest（不会自动改写）')
    return
  }
  if (options.digests) {
    const dataset = loadDataset({ fixtureDir: options.fixtureDir, verifyPins: false })
    const lines = dataset.cases.map(entry => entry.id + '  throughSeq=' + entry.snapshot.throughSeq + '  sha256=' + entry.snapshot.digest + '  (manifest pin ' + (entry.snapshot.digest === entry.manifest.snapshotSha256 ? 'matches' : 'DIFFERS: ' + entry.manifest.snapshotSha256) + ')')
    console.log(lines.join('\r\n'))
    return
  }
  const report = await runAb(options)
  const json = JSON.stringify(report, null, 2)
  if (options.out) {
    const target = path.resolve(options.out)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, json.replace(/\r?\n/g, '\r\n'), 'utf8')
    console.log('active-memory-ab: wrote ' + target)
  } else {
    console.log(json)
  }
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url : false
if (invoked) {
  main().catch(error => {
    console.error(JSON.stringify({ ok: false, kind: 'active-memory-ab', error: error && error.message ? error.message : String(error) }, null, 2))
    process.exitCode = 1
  })
}
