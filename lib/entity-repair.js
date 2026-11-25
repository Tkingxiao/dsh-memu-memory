// 实体碎片修复：规划 + 执行（docs/pending-work.md §14.2 P7、docs/host-versions.md §13 之外的数据侧）
//
// 为什么需要它：n-gram 滑窗曾把「一个名字的窗口片段」当成人物名建了节点（`南宫晚` /
// `宫晚晴` 其实是 `南宫晚晴`）。提名侧已修（lib/auto-link/terminology.js、
// lib/private-links.js），但**已落盘的碎片不会自己合**，而用户不会为了这件事去开终端跑脚本。
//
// 两类结论，处理方式完全不同（这是本模块唯一需要守住的界线）：
//   · attested —— 可证明：窗口片段首尾重叠重建出的更长名字**在正文里真的出现过**，或短名在
//     全库正文里**从未**独立于某个更长名字出现过。这类可以自动合并。
//   · similar  —— 只是相似：编辑距离 ≤2 或名字核重合（`顾清欢` 与 `顾清悦` 就是这么撞上的）。
//     这类**绝不自动写**，只在诊断页报数，由人点「需确认」的修复按钮。
//
// 写入只走 lib/graph.js 的 mergeEntities（别名并集、links 改指、evidence 改指、继承 confirmed、
// 清孤儿都在那条级联里），本模块不自建第二条写路径。合并前的全库备份由调用方负责。

import fs from 'node:fs'
import path from 'node:path'
import { indexDir, readJsonStrict, withFileLock, writeJson } from './paths.js'
import * as defaultGraph from './graph.js'
import { listLibraries as defaultListLibraries, loadPrivateIndex as defaultLoadPrivateIndex } from './state.js'

// mergeEntities 末尾的 pruneOrphanEntities 是全库清扫：它会把**任何**没被引用的实体删掉，
// 包括本次修复根本没碰的节点。修复不能顺手删东西，所以写入前后各读一次快照，把计划外的
// 行原样写回（硬规则 5）。
const ENTITIES_FILE = (libraryId) => path.join(indexDir(), `${libraryId}.entities.json`)
// 正文扫描上限：单库超过这个条目数时只取最近的这些，并在结论里标 `partial`。
const CORPUS_ENTRY_CAP = 3000

const normalized = (value) => String(value ?? '').normalize('NFKC').toLowerCase().trim()

function readEntityStore(file) {
  const result = readJsonStrict(file)
  if (result.missing) return { entities: {} }
  if (!result.ok) throw new Error('实体档案读不出来：' + (result.error?.code || result.kind || 'read failed'))
  const value = result.value && typeof result.value === 'object' ? result.value : {}
  if (!value.entities || typeof value.entities !== 'object' || Array.isArray(value.entities)) value.entities = {}
  return value
}

/** Overlap-merge two surfaces: `南宫晚` + `宫晚晴` → `南宫晚晴` (suffix equals prefix). */
function overlapJoin(left, right) {
  for (let size = Math.min(left.length, right.length); size >= 1; size -= 1) {
    if (left.slice(-size) === right.slice(0, size)) return left + right.slice(size)
  }
  return null
}

/** 全库正文（标题 + 正文，NFKC + 小写）。返回 {texts, partial}。 */
function corpusTexts(loadPrivateIndex, libraryId) {
  const entries = Object.values(loadPrivateIndex(libraryId).entries || {})
    .filter((entry) => entry && typeof entry === 'object')
  const sorted = entries.length > CORPUS_ENTRY_CAP
    ? [...entries].sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''))).slice(0, CORPUS_ENTRY_CAP)
    : entries
  return {
    texts: sorted.map((entry) => `${entry.title || ''}\n${entry.content || ''}`.normalize('NFKC').toLowerCase()),
    partial: entries.length > CORPUS_ENTRY_CAP,
  }
}

/**
 * 短名是否只是长名的窗口：短名在正文里的**每一次**出现都被某个长名覆盖。
 * 只要有一次独立出现（`化学` 单独出现在讲化学的句子里），就不能断定它是碎片。
 */
function onlyInsideCorpus(term, superstrings, texts) {
  const supersets = superstrings.filter((other) => other.length > term.length && other.includes(term))
  if (!supersets.length) return false
  let seen = 0
  for (const text of texts) {
    for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + term.length)) {
      seen += 1
      const covered = supersets.some((other) => {
        for (let start = Math.max(0, at - other.length + 1); start <= at; start += 1) {
          if (text.slice(start, start + other.length) === other) return true
        }
        return false
      })
      if (!covered) return false
    }
  }
  return seen > 0
}

function unionFind(ids) {
  const parent = new Map(ids.map((id) => [id, id]))
  const find = (id) => {
    let current = id
    while (parent.get(current) !== current) current = parent.get(current)
    let walk = id
    while (parent.get(walk) !== walk) { const next = parent.get(walk); parent.set(walk, current); walk = next }
    return current
  }
  const union = (a, b) => {
    const left = find(a)
    const right = find(b)
    if (left !== right) parent.set(left, right)
  }
  return { find, union }
}

/**
 * 规划一个库的修复。纯读：不开文件锁、不写任何字节。
 *
 * @param {string} libraryId
 * @param {{graph: object, loadPrivateIndex: Function}} deps 注入便于测试与脚本复用
 */
export function planLibraryRepair(libraryId, { graph = defaultGraph, loadPrivateIndex = defaultLoadPrivateIndex } = {}) {
  const listed = graph.listEntities({ libraryId }).items
    .filter((entity) => entity && entity.id && String(entity.status || 'provisional') !== 'archived')
  if (listed.length < 2) return { libraryId, groups: [], ambiguous: [], scanned: listed.length, partial: false }
  const { texts, partial } = corpusTexts(loadPrivateIndex, libraryId)
  const index = new Map(listed.map((entity) => [entity.id, entity]))
  const { find, union } = unionFind(listed.map((entity) => entity.id))
  const evidenceOf = new Map()

  for (const shorter of listed) {
    const key = normalized(shorter.name)
    if (key.length < 2) continue
    const longer = listed.find((entity) => entity !== shorter && entity.kind === shorter.kind
      && normalized(entity.name).length > key.length && normalized(entity.name).includes(key))
    if (!longer) continue
    union(shorter.id, longer.id)
    evidenceOf.set(shorter.id + '>' + longer.id, onlyInsideCorpus(key, [normalized(longer.name)], texts) ? 'attested' : 'similar')
  }
  for (const item of graph.suggestEntityMerges({ libraryId }).items) {
    if (!index.has(item.sourceId) || !index.has(item.targetId)) continue
    union(item.sourceId, item.targetId)
    if (!evidenceOf.has(item.sourceId + '>' + item.targetId)) evidenceOf.set(item.sourceId + '>' + item.targetId, 'similar')
  }

  const components = new Map()
  for (const entity of listed) {
    const root = find(entity.id)
    if (!components.has(root)) components.set(root, [])
    components.get(root).push(entity)
  }

  const groups = []
  const ambiguous = []
  for (const members of components.values()) {
    if (members.length < 2) continue
    const ordered = [...members].sort((a, b) => normalized(b.name).length - normalized(a.name).length
      || String(a.id).localeCompare(String(b.id)))
    const names = ordered.map((entity) => String(entity.name || ''))
    // 已经有完整名节点：直接把碎片并进去（前提是每个碎片都只是它的窗口）。
    const container = ordered.find((entity) => names.every((other) => other === entity.name
      || normalized(entity.name).includes(normalized(other))))
    if (container) {
      const allAttested = ordered
        .filter((entity) => entity.id !== container.id)
        .every((entity) => evidenceOf.get(entity.id + '>' + container.id) === 'attested'
          || onlyInsideCorpus(normalized(entity.name), [normalized(container.name)], texts))
      const group = {
        target: { id: container.id, name: container.name, kind: container.kind },
        sources: ordered.filter((entity) => entity.id !== container.id),
        creates: false,
        evidence: allAttested ? 'attested' : 'similar',
      }
      ;(group.evidence === 'attested' ? groups : ambiguous).push(group)
      continue
    }
    // 没有完整名节点：首尾重叠重建一个，并在正文里验到才算 attested。
    let rebuilt = null
    if (ordered[0].kind === 'person') {
      let best = null
      const extend = (used, current) => {
        if (current.length > 16) return
        if (used.size === names.length) {
          if (!best || current.length > best.length) best = current
          return
        }
        for (const name of names) {
          if (used.has(name)) continue
          const joined = overlapJoin(current, name)
          if (joined) { used.add(name); extend(used, joined); used.delete(name) }
        }
      }
      for (const name of names) extend(new Set([name]), name)
      if (best && best.length > Math.max(...names.map((name) => name.length))) {
        const needle = normalized(best)
        if (texts.some((text) => text.includes(needle))) rebuilt = best
      }
    }
    if (rebuilt) {
      groups.push({
        target: { id: null, name: rebuilt, kind: ordered[0].kind },
        sources: ordered,
        creates: true,
        evidence: 'attested',
      })
      continue
    }
    ambiguous.push({
      target: { id: ordered[0].id, name: ordered[0].name, kind: ordered[0].kind },
      sources: ordered.slice(1),
      creates: false,
      evidence: 'similar',
    })
  }
  return { libraryId, groups, ambiguous, scanned: listed.length, partial }
}

/** 所有未归档库的规划汇总。 */
export function planAllRepairs({ graph = defaultGraph, listLibraries = defaultListLibraries, loadPrivateIndex = defaultLoadPrivateIndex, libraryId = null } = {}) {
  const targets = libraryId ? [libraryId] : listLibraries().filter((library) => !library.archivedAt).map((library) => library.id)
  const plans = []
  const failures = []
  for (const id of targets) {
    try {
      plans.push(planLibraryRepair(id, { graph, loadPrivateIndex }))
    } catch (error) {
      failures.push({ libraryId: id, error: String(error?.message || error) })
    }
  }
  return {
    plans,
    failures,
    attested: plans.reduce((total, plan) => total + plan.groups.length, 0),
    similar: plans.reduce((total, plan) => total + plan.ambiguous.length, 0),
  }
}

/**
 * 执行一组计划。`groups` 只应包含 attested 类（调用方负责筛掉 similar）；
 * 写入前后各读一次实体快照，把 mergeEntities 级联清扫掉的计划外实体写回。
 */
export function applyRepairGroups(libraryId, groups, { graph = defaultGraph, merge = true } = {}) {
  const report = { libraryId, merged: 0, created: 0, restored: 0, failures: [] }
  if (!merge) return report
  for (const group of groups) {
    let before = { entities: {} }
    try {
      before = readEntityStore(ENTITIES_FILE(libraryId))
    } catch (error) {
      report.failures.push({ group: group.target.name, error: String(error?.message || error) })
      continue
    }
    try {
      let targetId = group.target.id
      if (group.creates) {
        const created = graph.createEntity({ libraryId, name: group.target.name, kind: group.target.kind, status: 'confirmed', confirmedBy: 'user' })
        targetId = created.id
        report.created += 1
      }
      graph.mergeEntities({ libraryId, targetId, sourceIds: group.sources.map((entity) => entity.id) })
      report.merged += 1
      report.restored += restoreSweptRows(libraryId, before, group)
    } catch (error) {
      report.failures.push({ group: group.target.name, error: String(error?.message || error) })
    }
  }
  return report
}

function restoreSweptRows(libraryId, before, group) {
  const file = ENTITIES_FILE(libraryId)
  const excluded = new Set([group.target.id, ...group.sources.map((entity) => entity.id)])
  return withFileLock(file, () => {
    const store = readEntityStore(file)
    const lost = Object.values(before.entities || {})
      .filter((entity) => entity && entity.id && !excluded.has(entity.id) && !store.entities[entity.id])
      .map((entity) => entity.id)
    for (const id of lost) store.entities[id] = before.entities[id]
    if (lost.length) writeJson(file, store)
    return lost.length
  })
}

/** 一份人类可读的规划摘要（诊断页与脚本共用，正文里没有真实记忆内容）。 */
export function summarizePlan(plan) {
  const lines = []
  for (const group of [...(plan.groups || []), ...(plan.ambiguous || [])]) {
    lines.push(`${group.target.name}${group.creates ? '（新建，正文里出现过）' : ''} ← `
      + group.sources.map((entity) => entity.name).join(' / ') + `  [${group.evidence}]`)
  }
  return lines
}

export function entityFileExists(libraryId) {
  try {
    return fs.existsSync(ENTITIES_FILE(libraryId))
  } catch {
    return false
  }
}
