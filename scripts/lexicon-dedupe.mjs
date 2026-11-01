#!/usr/bin/env node
// scripts/lexicon-dedupe.mjs — 历史重复词条迁移工具（docs/lexicon-design.md §10 P2）
//
// 背景：词条冲突检查（findScopeCollision）落地之前的历史数据可能存在「同一作用域
// 内同规范词多条」的重复。本工具扫描 data/lexicon/*.json，按 normalizedTerm +
// sameFactContext 作用域找重复组，dry-run（默认）只打印报告，--apply 才执行合并。
//
// 判定与核心写入侧（lib/lexicon.js findScopeCollision）同口径：
//   * 组键 = normalizedTerm + IDENTITIES（channelId/speakerId/characterId/worldId/
//     branchId），与 lib/context.js sameFactContext 完全一致；knownBy 是可见性边界
//     （contextVisible），不算作用域。
//   * archived 条目不参与：归档不占用冲突位置（与核心一致）。
//   * pending 且带 revisionOf 的条目不参与：它是某个 active 词条的待审修订草稿，
//     与其目标同词同 scope 是设计内的，不是重复。
//
// 保留规则：status active > pending > rejected（未知 status 按 rejected 档）；
// 同档 updatedAt 新者优先；再按 termId 字典序收尾（结果稳定、可复算）。
// 合并规则（写入前按核心 lib/lexicon.js 的 §1.2 上限裁剪）：
//   * meaning 取组内最长（clip 500）；usage 保留保留条目的；
//   * aliases / examples 并集去重（按规范化形式 / 原文），clip 8×80 / 5×200；
//   * strength / confidence 取 max；evidence 合并去重，clip 10 条 × quote 200；
//   * hitCounts 三计数求和（审计历史不丢），lastInjectedAt 取最新；
//   * status / kind / sensitivity / visibility / context 沿用保留条目（context 含
//     knownBy，不并集——并集会放宽可见边界，交集会无故收紧，都不是"合并"该做的事）；
//   * createdAt 取组内最早（首次出现的时间）；updatedAt = 本次合并时间；
//   * 被并条目删除前，其 id 记入保留条目的 mergedFrom: []（可审计）；指向被并
//     条目的 rejected 指纹改指保留条目（拒绝记忆不丢）。
// active+sensitive 的词条永不触碰：所在组整体跳过并报告。
//
// 用法：node scripts/lexicon-dedupe.mjs [--apply] [--library <id>]
//   --apply          执行合并（默认 dry-run 只报告）
//   --library <id>   只处理指定库（默认扫 data/lexicon/ 下全部安全命名的文件）
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { dataDir, readJsonStrict, readFailure, writeJson, withFileLock, isSafeId, shortHash, stamp } from '../lib/paths.js'

// 与 lib/context.js IDENTITIES 同组：作用域身份字段（knownBy 不在内）。
const IDENTITIES = ['channelId', 'speakerId', 'characterId', 'worldId', 'branchId']
// 核心 §1.2 上限（与 lib/lexicon.js 常量一致；这里不复用模块私有常量，写死并注释同源）。
const CAPS = { meaning: 500, usage: 300, aliases: 8, alias: 80, examples: 5, example: 200, evidence: 10, evidenceQuote: 200 }
const STATUS_RANK = { active: 3, pending: 2, rejected: 1 }
const STATUS_LABEL = { active: 'active', pending: 'pending', rejected: 'rejected' }

function clip(text, max) {
  const s = String(text ?? '')
  return s.length > max ? s.slice(0, max) : s
}

/** 严格读取（与 lib/lexicon.js readLexiconStrict 同口径的本地副本，不走读缓存）。 */
function strictReadLexicon(file) {
  const failure = readFailure(file)
  if (failure) throw new Error(`write-protected by an earlier read failure (${failure.code || failure.message})`)
  const result = readJsonStrict(file)
  if (result.missing) return null
  if (!result.ok) throw new Error(`could not be read (${result.kind === 'corrupt' ? 'invalid JSON' : result.error?.code || 'read failed'})`)
  const value = result.value
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value.version !== undefined && value.version !== 1)
    || !value.terms || typeof value.terms !== 'object' || Array.isArray(value.terms)) {
    throw new Error('has an invalid data shape')
  }
  for (const [termId, entry] of Object.entries(value.terms)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`entry ${termId} is not an object`)
    }
  }
  return value
}

function scopeKeyOf(entry) {
  return IDENTITIES.map(key => String(entry?.context?.[key] || '')).join('\u0001')
}

function scopeLabelOf(entry) {
  const parts = IDENTITIES.filter(key => entry?.context?.[key]).map(key => `${key}=${entry.context[key]}`)
  return parts.length ? parts.join(', ') : '(全场景)'
}

/**
 * 判定词条是否参与重复分组。返回 null 表示排除（排除原因用于报告）。
 */
function participation(entry) {
  const status = entry.status || 'active'
  if (status === 'archived') return 'archived（不占用冲突位置，跳过）'
  if (status === 'pending' && entry.revisionOf) return 'pending revision 草稿（active 词条的待审修订，跳过）'
  if (!String(entry.normalizedTerm || '')) return '缺少 normalizedTerm，跳过'
  return null
}

/** 扫描一本词典，返回 duplicate 组列表（每组 ≥2 条可参与成员）。 */
export function scanDuplicateGroups(data) {
  const groups = new Map()
  for (const [termId, entry] of Object.entries(data.terms || {})) {
    const excluded = participation(entry)
    if (excluded) continue
    const key = `${String(entry.normalizedTerm)}\u0000${scopeKeyOf(entry)}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ termId, entry })
  }
  return [...groups.values()].filter(members => members.length >= 2)
}

/** 保留规则：active > pending > rejected → updatedAt 新者 → termId 字典序。 */
function keptFirst(a, b) {
  const ra = STATUS_RANK[a.entry.status || 'active'] || 1
  const rb = STATUS_RANK[b.entry.status || 'active'] || 1
  if (ra !== rb) return rb - ra
  const ta = String(a.entry.updatedAt || ''), tb = String(b.entry.updatedAt || '')
  if (ta !== tb) return tb.localeCompare(ta)
  return String(a.termId).localeCompare(String(b.termId))
}

/** 为一个组产出合并计划；含 active+sensitive 成员的组整组跳过。 */
export function planGroup(members) {
  const sensitiveMember = members.find(m => (m.entry.status || 'active') === 'active' && m.entry.sensitivity === 'sensitive')
  if (sensitiveMember) {
    return { skip: true, reason: `含 active+sensitive 词条 ${sensitiveMember.termId}，工具永不触碰，整组跳过` }
  }
  const ordered = [...members].sort(keptFirst)
  const kept = ordered[0]
  const removed = ordered.slice(1)
  const keptEntry = kept.entry
  const normalizedTerm = String(keptEntry.normalizedTerm)

  // meaning 取组内最长；usage 沿用保留条目。
  let meaning = String(keptEntry.meaning || '')
  for (const { entry } of removed) {
    if (String(entry.meaning || '').length > meaning.length) meaning = String(entry.meaning || '')
  }
  meaning = clip(meaning.trim(), CAPS.meaning)

  // aliases/examples 并集去重（aliases 按规范化形式去重，examples 按原文去重）。
  const aliases = []
  const seenAlias = new Set()
  for (const { entry } of ordered) {
    for (const alias of (Array.isArray(entry.aliases) ? entry.aliases : [])) {
      const text = clip(String(alias ?? '').trim(), CAPS.alias)
      const normalized = text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
      if (!text || normalized === normalizedTerm || seenAlias.has(normalized)) continue
      seenAlias.add(normalized)
      aliases.push(text)
      if (aliases.length >= CAPS.aliases) break
    }
    if (aliases.length >= CAPS.aliases) break
  }
  const examples = []
  const seenExample = new Set()
  for (const { entry } of ordered) {
    for (const example of (Array.isArray(entry.examples) ? entry.examples : [])) {
      const text = clip(String(example ?? '').trim(), CAPS.example)
      if (!text || seenExample.has(text)) continue
      seenExample.add(text)
      examples.push(text)
      if (examples.length >= CAPS.examples) break
    }
    if (examples.length >= CAPS.examples) break
  }

  // strength/confidence 取 max；evidence 合并去重；三计数求和；lastInjectedAt 取最新。
  const numOf = value => (Number.isFinite(Number(value)) ? Number(value) : null)
  let strength = numOf(keptEntry.strength)
  let confidence = numOf(keptEntry.confidence)
  const hitCounts = { candidate: 0, injection: 0, query: 0 }
  let lastInjectedAt = keptEntry.lastInjectedAt || null
  let createdAt = String(keptEntry.createdAt || '')
  const evidence = []
  const seenEvidence = new Set()
  for (const { entry } of ordered) {
    strength = Math.max(strength ?? 0, numOf(entry.strength) ?? 0)
    confidence = Math.max(confidence ?? 0, numOf(entry.confidence) ?? 0)
    for (const key of Object.keys(hitCounts)) {
      hitCounts[key] += Number(entry.hitCounts?.[key]) || 0
    }
    if (entry.lastInjectedAt && (!lastInjectedAt || String(entry.lastInjectedAt) > String(lastInjectedAt))) {
      lastInjectedAt = entry.lastInjectedAt
    }
    const entryCreated = String(entry.createdAt || '')
    if (entryCreated && (!createdAt || entryCreated < createdAt)) createdAt = entryCreated
    for (const item of (Array.isArray(entry.evidence) ? entry.evidence : [])) {
      if (!item || typeof item !== 'object') continue
      const quote = clip(typeof item.quote === 'string' ? item.quote : '', CAPS.evidenceQuote)
      const id = clip(typeof item.id === 'string' ? item.id : '', 160)
      const kind = clip(typeof item.kind === 'string' ? item.kind : 'message', 40)
      if (!quote.trim() && !id) continue
      const sig = JSON.stringify([kind, id, quote])
      if (seenEvidence.has(sig)) continue
      seenEvidence.add(sig)
      evidence.push({ kind, id, quote })
      if (evidence.length >= CAPS.evidence) break
    }
    if (evidence.length >= CAPS.evidence) break
  }

  const merged = {
    ...keptEntry,
    meaning,
    aliases,
    normalizedAliases: aliases.map(alias => alias.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')).filter(Boolean),
    examples,
    strength: strength ?? 0.6,
    confidence: confidence ?? 0.8,
    evidence,
    hitCounts,
    lastInjectedAt,
    createdAt: createdAt || keptEntry.createdAt,
    fingerprint: keptEntry.fingerprint || shortHash(normalizedTerm),
    // 被并条目的 id 记入保留条目，历史可审计。
    mergedFrom: [...(Array.isArray(keptEntry.mergedFrom) ? keptEntry.mergedFrom : []), ...removed.map(item => item.termId)],
  }
  return { skip: false, keptId: kept.termId, keptEntry, removeIds: removed.map(item => item.termId), merged }
}

/** 把计划应用到词典对象上（CAS：调用方必须在 withFileLock 内对最新读取执行）。 */
export function applyPlans(data, plans, now = stamp()) {
  for (const plan of plans) {
    if (plan.skip) continue
    for (const removeId of plan.removeIds) {
      const removed = data.terms[removeId]
      if (removed?.fingerprint && data.rejected && data.rejected[removed.fingerprint]?.termId === removeId) {
        // 拒绝指纹改指保留条目：同一规范词的 model-proposal 依旧被拦。
        data.rejected[removed.fingerprint].termId = plan.keptId
      }
      delete data.terms[removeId]
    }
    data.terms[plan.keptId] = { ...plan.merged, updatedAt: now }
  }
  data.revision = (Number(data.revision) || 0) + 1
  data.version = 1
  return data
}

function listLibraryFiles(onlyId) {
  const dir = path.join(dataDir(), 'lexicon')
  if (onlyId) {
    if (!isSafeId(onlyId)) throw new Error(`invalid library id: ${clip(onlyId, 40)}`)
    const file = path.join(dir, `${onlyId}.json`)
    if (!fs.existsSync(file)) throw new Error(`lexicon file not found: ${onlyId}.json`)
    return [{ libraryId: onlyId, file }]
  }
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.json') && isSafeId(name.slice(0, -'.json'.length)))
    .sort()
    .map(name => ({ libraryId: name.slice(0, -'.json'.length), file: path.join(dir, name) }))
}

function reportLibrary({ libraryId, file }, apply) {
  const data = strictReadLexicon(file)
  if (!data) {
    console.log(`${libraryId}: 无文件，跳过`)
    return { groups: 0, merges: 0, skipped: 0 }
  }
  const groups = scanDuplicateGroups(data)
  const plans = groups.map(members => ({ label: `${String(members[0].entry.normalizedTerm)} @ ${scopeLabelOf(members[0].entry)}`, plan: planGroup(members) }))
  const mergePlans = plans.filter(item => !item.plan.skip)
  console.log(`${libraryId}: revision ${data.revision ?? 0}，词条 ${Object.keys(data.terms || {}).length} 条，重复组 ${groups.length} 组`)
  for (const { label, plan } of plans) {
    if (plan.skip) {
      console.log(`  [跳过] ${label}：${plan.reason}`)
      continue
    }
    console.log(`  [合并] ${label}：${plan.removeIds.length + 1} 条 → 保留 ${plan.keptId} (${plan.keptEntry.status || 'active'}, updatedAt ${plan.keptEntry.updatedAt || 'null'})`)
    console.log(`         并入并删除: ${plan.removeIds.join(', ')}`)
    console.log(`         meaning 取最长(${plan.merged.meaning.length} 字), aliases 并集 ${plan.merged.aliases.length}, examples 并集 ${plan.merged.examples.length}, strength max ${plan.merged.strength}, evidence ${plan.merged.evidence.length} 条`)
    console.log(`         mergedFrom 记入: [${plan.merged.mergedFrom.join(', ')}]`)
  }
  if (groups.length === 0) console.log('  无历史重复')
  if (apply && mergePlans.length) {
    withFileLock(file, () => {
      // CAS：锁内重读最新落盘内容再套用计划，plan 基于「扫描时快照」之外的变化重算。
      const fresh = strictReadLexicon(file)
      if (!fresh) throw new Error('disappeared during apply')
      const freshPlans = scanDuplicateGroups(fresh).map(members => planGroup(members))
      applyPlans(fresh, freshPlans)
      writeJson(file, fresh)
      console.log(`  [写入] revision → ${fresh.revision}，词条 ${Object.keys(fresh.terms).length} 条`)
    })
  }
  return { groups: groups.length, merges: apply ? mergePlans.length : 0, skipped: plans.filter(item => item.plan.skip).length }
}

function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const libraryFlagIndex = args.indexOf('--library')
  const onlyId = libraryFlagIndex >= 0 ? String(args[libraryFlagIndex + 1] || '').trim() : null
  if (args.some(arg => arg === '--help' || arg === '-h')) {
    console.log('用法: node scripts/lexicon-dedupe.mjs [--apply] [--library <id>]')
    console.log('  默认 dry-run 只打印报告；--apply 才执行合并。')
    process.exit(0)
  }
  console.log(apply ? 'lexicon-dedupe: --apply（将执行合并）' : 'lexicon-dedupe: dry-run（加 --apply 执行合并）')
  let files
  try {
    files = listLibraryFiles(onlyId)
  } catch (error) {
    console.error(`lexicon-dedupe: ${String(error?.message || error)}`)
    process.exit(2)
  }
  let totals = { groups: 0, merges: 0, skipped: 0 }
  for (const entry of files) {
    try {
      const result = reportLibrary(entry, apply)
      totals.groups += result.groups
      totals.merges += result.merges
      totals.skipped += result.skipped
    } catch (error) {
      console.log(`${entry.libraryId}: 读取失败，跳过（${String(error?.message || error)}）`)
    }
  }
  console.log(`汇总: 重复组 ${totals.groups}，${apply ? `已合并 ${totals.merges}` : 'dry-run 未写入'}，含 active+sensitive 跳过 ${totals.skipped} 组`)
}

/* istanbul ignore next */
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
}
