/**
 * 环境自检与修复入口（启动自检 + 设置页"诊断"里的手动入口共用）。
 *
 * 为什么要把这件事单独做成一个模块：2026-11-21 那次故障里，三个坏掉的东西
 * （向量 profile 摘要、runtimeDir 指向已删除目录、遗留 0 字节锁文件）全都只表现成
 * "召回降级"或"整理没跑"，插件自己既不检查也不报告，只能靠人去翻 node_modules 源码。
 * 这里把"插件跑得起来需要哪些前提"写成可枚举的检查项，每项都带 level / 证据 / 修复动作，
 * 让启动路径能自动修掉安全的部分、把危险的留给设置页按钮。
 *
 * 设计约束：
 * - 检查必须只读、快、绝不抛错：它跑在启动路径上，任何一项失败都只是"这一项不健康"。
 * - 修复必须显式确认（`confirmed === true`）才联网或改 profile；启动路径只自动跑
 *   SAFE_REPAIRS 里的动作（释放遗弃锁 / 重签摘要 / 重指 runtime 目录）。
 * - 修复过程本身失败也是诊断（recordRepair 负责落盘），不能静默。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataDir, ensureDir, scanMemoryLocks, releaseStaleLocks } from './paths.js'
import { engineStatus, ensureEngine, ENGINE_VERSION } from './engine.js'
import { getSettings, getMemoryBackend, backupDatabases, listLibraries, loadPrivateIndex } from './state.js'
import { planAllRepairs, applyRepairGroups } from './entity-repair.js'
import {
  activeProfile, requestedProfile, resignVectorProfile, repointVectorRuntimeDir,
  runtimeDirCandidates, vectorActiveFile, VECTOR_ERROR_CODES,
} from './vector-profile.js'
import { hasEmbeddingRuntimePackages, installLocalVectorRuntime, downloadLocalVectorModel } from './local-vector-service.js'
import { embeddingWorkerManager } from './local-embedding-manager.js'
import { recordRepair } from './diagnostics.js'

// 启动路径可以自己跑的修复：都不联网、都不改变制品身份，最坏情况只是白跑一次。
export const SAFE_REPAIRS = Object.freeze(['release-stale-locks', 'resign-vector-profile', 'repoint-runtime-dir'])

// 需要人点按钮（联网下载 / 重算全部向量 / 动引擎目录 / 改实体图）的修复。
export const MANUAL_REPAIRS = Object.freeze(['reinstall-runtime', 'reinstall-model', 'rebuild-vector-index', 'reinstall-engine', 'merge-entity-fragments'])

export const REPAIR_LABELS = Object.freeze({
  'release-stale-locks': '释放遗留锁文件',
  'resign-vector-profile': '重签向量 profile 摘要',
  'repoint-runtime-dir': '重指向量运行时目录',
  'reinstall-runtime': '重新安装向量运行时',
  'reinstall-model': '重新下载向量模型',
  'rebuild-vector-index': '重建向量索引',
  'reinstall-engine': '重新安装 MemU 引擎',
  'merge-entity-fragments': '合并可证明的实体名字碎片',
})

const MODEL_REQUIRED_FILES = ['config.json', 'tokenizer.json']

function item(id, level, title, extra = {}) {
  return { id, level, ok: level === 'ok' || level === 'skipped', title, detail: '', hint: '', repair: null, auto: false, manual: false, ...extra }
}

/** dataDir 可写：连自检结果都落不了盘的时候，别的检查也没有意义。 */
function checkDataDir(items) {
  try {
    const dir = dataDir()
    ensureDir(dir)
    const probe = path.join(dir, `.health-${process.pid}-${Date.now()}`)
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    items.push(item('data-dir', 'ok', '数据目录可读可写', { detail: dir }))
    return true
  } catch (error) {
    items.push(item('data-dir', 'error', '数据目录不可写', {
      detail: String(error?.message || error),
      hint: '检查磁盘权限/剩余空间；$DSH_HOME 指到只读位置时插件无法保存任何记忆。',
    }))
    return false
  }
}

/** 遗留锁：0 字节 / 进程已死 / 事务超龄，都算遗弃（判据在 paths.js 的 inspectLock）。 */
function checkLocks(items) {
  let scanned = []
  try { scanned = scanMemoryLocks({ root: dataDir() }) } catch (error) {
    items.push(item('locks', 'warn', '无法扫描锁文件', { detail: String(error?.message || error) }))
    return
  }
  const stale = scanned.filter(lock => lock.stale)
  const held = scanned.filter(lock => !lock.stale)
  if (stale.length) {
    const sample = stale[0]
    items.push(item('locks', 'warn', `${stale.length} 个遗弃锁文件挡住了写入路径`, {
      detail: `${sample.rel}（原因 ${sample.reason || 'unknown'}${sample.owner == null ? '' : `，pid ${sample.owner}`}${sample.ageMs == null ? '' : `，已 ${Math.round(sample.ageMs / 1000)}s`}）`,
      hint: '持有它的进程已经不在，或内容是空的；释放后整理任务与写入才会恢复。',
      repair: 'release-stale-locks',
      auto: true,
      files: stale.map(lock => lock.rel),
    }))
  } else if (held.length) {
    items.push(item('locks', 'ok', `${held.length} 个锁正被占用（有活进程持有）`, { detail: held.map(lock => lock.rel).join('、') }))
  } else {
    items.push(item('locks', 'ok', '没有遗留锁文件'))
  }
}

function checkEngine(items) {
  let backend
  try { backend = getMemoryBackend() } catch { backend = null }
  if (backend === 'agent') { items.push(item('engine', 'skipped', '本地 agent 模式不依赖 MemU 引擎')); return }
  let status
  try { status = engineStatus() } catch (error) {
    items.push(item('engine', 'error', '读不到引擎状态', { detail: String(error?.message || error), repair: 'reinstall-engine', manual: true }))
    return
  }
  if (status?.status === 'installing') { items.push(item('engine', 'skipped', '引擎正在安装中')); return }
  if (status?.status === 'ready') {
    const version = status.current?.version || ''
    if (version !== ENGINE_VERSION) {
      items.push(item('engine', 'warn', `引擎版本不是当前插件要的 ${ENGINE_VERSION}（现在是 ${version || '未知'}）`, {
        detail: status.current?.python || '',
        hint: '版本漂移时召回仍可用，但新命令（search / memorize）会缺失。',
        repair: 'reinstall-engine',
        auto: getSettingsSafe().autoInstallEngine !== false,
        manual: true,
      }))
    } else {
      items.push(item('engine', 'ok', `引擎就绪（${version}）`, { detail: status.current?.python || '' }))
    }
    return
  }
  items.push(item('engine', 'error', `引擎不可用（${status?.status || 'unknown'}）`, {
    detail: String(status?.error?.message || status?.reason || ''),
    hint: '缺 Python venv 或引擎包损坏时，语义召回与整理都会退化成词法/跳过。',
    repair: 'reinstall-engine',
    auto: getSettingsSafe().autoInstallEngine !== false,
    manual: true,
  }))
}

function getSettingsSafe() {
  try { return getSettings() || {} } catch { return {} }
}

function vectorEnabled() {
  try { return getMemoryBackend() === 'api' && getSettings().vectorSource === 'local' } catch { return false }
}

/**
 * 向量 profile：指纹 / 摘要 / 落盘目录三件事一起看。
 * 摘要只"元数据漂移"时 profile 仍然可用（assertProfileVerified 已放宽），这里只在真的
 * 校验失败时报，避免自检本身制造噪音。
 */
function checkVectorProfile(items) {
  if (!vectorEnabled()) { items.push(item('vector-profile', 'skipped', '未启用本地向量召回')); return null }
  let profile = null
  try {
    profile = activeProfile()
  } catch (error) {
    const code = String(error?.code || '')
    if (code === VECTOR_ERROR_CODES.PROFILE_PENDING || code === VECTOR_ERROR_CODES.NOT_ACTIVE || code === VECTOR_ERROR_CODES.PROFILE_MISSING) {
      items.push(item('vector-profile', 'skipped', '还没有激活的向量代际（首次使用/未建库属正常）', { detail: code }))
      return null
    }
    const resignable = code === VECTOR_ERROR_CODES.PROFILE_MANIFEST_CHANGED || code === VECTOR_ERROR_CODES.PROFILE_UNKNOWN
    items.push(item('vector-profile', code ? 'error' : 'warn', `向量 profile 校验失败（${code || 'unknown'}）`, {
      detail: String(error?.message || error),
      hint: resignable
        ? '制品清单只是元数据变了（镜像源、文案），重签摘要即可，已算好的向量不用重算。'
        : '制品身份变了或索引文件损坏，需要重建向量代际（会重算全部条目）。',
      repair: resignable ? 'resign-vector-profile' : 'rebuild-vector-index',
      auto: resignable,
      manual: true,
      changedFields: Array.isArray(error?.changedFields) ? error.changedFields : undefined,
    }))
    return null
  }
  if (!profile) { items.push(item('vector-profile', 'ok', '没有向量 profile')); return null }
  items.push(item('vector-profile', 'ok', `向量 profile 校验通过（${profile.catalogId}，generation ${profile.generation ?? '?'}）`, {
    detail: path.basename(String(vectorActiveFile())),
  }))

  // 运行时目录：profile 记的路径必须真的装着 onnxruntime-node。
  const runtimeDir = profile.runtimeDir || ''
  if (!hasEmbeddingRuntimePackages(runtimeDir)) {
    const candidates = (() => { try { return runtimeDirCandidates() } catch { return [] } })()
    items.push(item('vector-runtime', candidates.length ? 'warn' : 'error', candidates.length
      ? '向量运行时目录失效（本机已有可用目录）'
      : '向量运行时没有安装', {
      detail: runtimeDir ? `${runtimeDir} 里没有 onnxruntime-node` : 'profile 没有记录 runtimeDir',
      hint: candidates.length
        ? `把它重指到已有的运行时目录（${path.basename(candidates[0].dir)}）即可，不需要重新下载。`
        : '需要联网下载 pin 住的运行时制品（约 40MB）。',
      repair: candidates.length ? 'repoint-runtime-dir' : 'reinstall-runtime',
      auto: candidates.length > 0,
      manual: true,
    }))
  }
  const modelDir = profile.modelDir || ''
  const missing = MODEL_REQUIRED_FILES.filter(name => {
    try { return !fs.statSync(path.join(modelDir, name)).isFile() } catch { return true }
  })
  if (missing.length) {
    items.push(item('vector-model', 'error', '向量模型文件缺失', {
      detail: modelDir ? `${modelDir} 缺 ${missing.join('、')}` : 'profile 没有记录 modelDir',
      hint: '模型目录被清理或下载中断时需要重新下载；已算好的向量会失效。',
      repair: 'reinstall-model',
      manual: true,
    }))
  }
  return profile
}

function checkWorker(items) {
  let status = null
  try { status = embeddingWorkerManager().status() } catch { status = null }
  if (!status) return
  if (status.tripped) {
    items.push(item('vector-worker', 'warn', '嵌入 worker 反复崩溃已被熔断', {
      detail: '本次会话内不再尝试拉起，召回退化为词法。',
      hint: '看完诊断里的 stderr 尾巴，修好原因后重启 DSH 即可恢复。',
    }))
    return
  }
  if (status.running) items.push(item('vector-worker', 'ok', '嵌入 worker 在运行'))
}

/**
 * 实体名字碎片（docs/pending-work.md §14.2 P7）。
 *
 * 启动时的一次性修复只处理**可证明**的那一类（窗口重建 + 正文里出现过完整名）。剩下的是
 * "只是相似"：编辑距离 ≤2 或名字核重合——`顾清欢` 与 `顾清悦` 就是被编辑距离撞到一起的。
 * 这类绝不自动写：只在这里报数，按钮标"需确认"（MANUAL_REPAIRS），由人核对。
 */
function checkEntityFragments(items) {
  let plan = null
  try {
    plan = planAllRepairs({ loadPrivateIndex, listLibraries })
  } catch (error) {
    items.push(item('entity-fragments', 'warn', '实体碎片检查没跑成', {
      detail: String(error?.message || error),
      hint: '检查是只读的；跑不成通常是某个库的实体档案读不出来。可以先跑 scripts/entity-dedupe.mjs 看细节。',
    }))
    return
  }
  const similar = plan.similar
  const attested = plan.attested
  if (plan.failures.length) {
    for (const failure of plan.failures) {
      items.push(item('entity-fragments', 'warn', `某个库的碎片检查失败：${failure.libraryId}`, {
        detail: failure.error, hint: '修好该库的档案后重新检查即可，其它库不受影响。',
      }))
    }
  }
  if (!similar && !attested) {
    items.push(item('entity-fragments', 'ok', '没有待确认的实体碎片候选'))
    return
  }
  if (!similar) {
    items.push(item('entity-fragments', 'warn', `发现 ${attested} 组可证明的名字碎片，等启动自愈或手动合并`, {
      detail: '这些片段的每一次出现都在更长的名字里面，且那个长名字在正文里出现过。',
      hint: '升级到本版本后的第一次启动会自动合并（先备份）；不想等可以点下面的修复。',
      repair: 'merge-entity-fragments', manual: true,
    }))
    return
  }
  items.push(item('entity-fragments', 'warn', `发现 ${similar} 组实体只是名字相似，未自动合并`, {
    detail: attested ? `另有 ${attested} 组可证明的碎片。` : '相似不等于同一人：可能是两个不同的称呼。',
    hint: '请到关系图谱逐个核对候选再合并；批量按钮只处理可证明的那一类，不会按编辑距离替你决定谁是谁。',
    repair: 'merge-entity-fragments', manual: true,
  }))
}

/**
 * 跑一遍自检。
 * @param {{deep?: boolean}} options deep=true 时把引擎 / 运行时状态连"检查命令"一起做。
 */
export function runEnvironmentCheck({ deep = false } = {}) {
  const items = []
  const writable = checkDataDir(items)
  if (writable) {
    checkLocks(items)
    checkEngine(items)
    const profile = checkVectorProfile(items)
    checkWorker(items)
    checkEntityFragments(items)
    if (deep && profile) {
      try {
        const status = engineStatus({ withSize: true })
        items.push(item('engine-size', 'ok', '引擎占用已统计', { detail: `${status?.current?.bytes ?? 0} 字节` }))
      } catch {}
    }
  }
  const counts = { ok: 0, warn: 0, error: 0, skipped: 0 }
  for (const entry of items) counts[entry.level] = (counts[entry.level] || 0) + 1
  const failed = items.filter(entry => entry.level === 'error' || entry.level === 'warn')
  const repairs = []
  for (const entry of failed) if (entry.repair && !repairs.includes(entry.repair)) repairs.push(entry.repair)
  return {
    checkedAt: new Date().toISOString(),
    ok: counts.error === 0,
    attention: failed.length > 0,
    items,
    counts,
    repairs,
    autoRepairs: failed.filter(entry => entry.repair && entry.auto).map(entry => entry.repair),
    manualRepairs: failed.filter(entry => entry.repair && entry.manual).map(entry => entry.repair),
  }
}

async function runRepairAction(action) {
  switch (action) {
    case 'release-stale-locks': {
      const result = releaseStaleLocks({ root: dataDir() })
      return { detail: `释放 ${result.released.length} 个，保留 ${result.kept.length} 个`, data: result }
    }
    case 'resign-vector-profile': {
      const result = resignVectorProfile({})
      if (!result.changed) return { detail: `无需重签（${result.reason}）`, data: result }
      return { detail: `重签 ${result.slots.map(slot => slot.slot).join('/')}：${(result.slots[0]?.changedFields || []).join('、') || 'metadata'}`, data: result }
    }
    case 'repoint-runtime-dir': {
      const result = repointVectorRuntimeDir({})
      if (!result.changed) return { detail: `无需重指（${result.reason}）`, data: result }
      return { detail: `重指到 ${path.basename(result.next)}`, data: result }
    }
    case 'reinstall-runtime': {
      const result = await installLocalVectorRuntime({ action: 'start', confirmed: true })
      return { detail: `运行时安装 ${result?.status || 'done'}`, data: result }
    }
    case 'reinstall-model': {
      const state = (() => { try { return activeProfile() } catch { return null } })() || (() => { try { return requestedProfile() } catch { return null } })()
      if (!state?.catalogId) throw new Error('没有可重新下载的模型（profile 缺失）')
      const result = await downloadLocalVectorModel(state.catalogId, { confirmed: true })
      return { detail: `模型下载 ${result?.status || 'done'}`, data: result }
    }
    case 'rebuild-vector-index': {
      const { maybeAutoRebuildVectorGeneration } = await import('./local-vector-service.js')
      const result = await maybeAutoRebuildVectorGeneration()
      return { detail: `重建 ${result?.rebuilt ? '已排队' : '未触发'}`, data: result ?? null }
    }
    case 'reinstall-engine': {
      const result = await ensureEngine({ force: true, beforeSwitch: backupDatabases })
      return { detail: `引擎 ${result?.status || 'done'}`, data: result }
    }
    case 'merge-entity-fragments': {
      // 只合"可证明"的那一类；相似候选留给关系图谱里逐个确认。备份在任何写之前。
      const plan = planAllRepairs({ loadPrivateIndex, listLibraries })
      if (!plan.attested) return { detail: `没有可证明的碎片可合并（相似候选 ${plan.similar} 组需要人工核对）`, data: plan }
      await backupDatabases({ label: 'entity-repair' })
      let merged = 0
      let created = 0
      const failures = []
      for (const entry of plan.plans) {
        if (!entry.groups.length) continue
        const applied = applyRepairGroups(entry.libraryId, entry.groups)
        merged += applied.merged
        created += applied.created
        for (const failure of applied.failures) failures.push(`${entry.libraryId}/${failure.group}: ${failure.error}`)
      }
      return {
        detail: `合并 ${merged} 组（新建完整名 ${created} 个），相似候选 ${plan.similar} 组未动${failures.length ? '，失败 ' + failures.length + ' 组' : ''}`,
        data: { merged, created, similar: plan.similar, failures },
      }
    }
    default:
      throw new Error('unknown repair action: ' + action)
  }
}

/**
 * 执行修复。`confirmed === true` 是硬门槛：这些动作会联网、改 profile 或重算向量。
 * 每一步的结果都写进诊断（成功也算），失败时连同错误一起，方便下次直接看见"修过但没好"。
 */
export async function repairEnvironment({ actions = [], confirmed = false } = {}) {
  if (confirmed !== true) throw new Error('repairEnvironment requires confirmed === true')
  const requested = Array.isArray(actions) && actions.length ? actions : []
  if (!requested.length) return { ok: true, results: [], skipped: 'no-action' }
  const results = []
  for (const action of requested) {
    const startedAt = new Date().toISOString()
    try {
      const result = await runRepairAction(action)
      recordRepair({ action, ok: true, detail: result.detail, message: `repair ${action}: ${result.detail}` })
      results.push({ action, ok: true, detail: result.detail, startedAt })
    } catch (error) {
      const detail = String(error?.message || error)
      recordRepair({ action, ok: false, detail, message: `repair ${action} failed: ${detail}`, error })
      results.push({ action, ok: false, detail, code: String(error?.code || ''), startedAt })
    }
  }
  const after = runEnvironmentCheck()
  return { ok: results.every(result => result.ok), results, after }
}

/** 启动路径用：只跑安全修复，跑完复检一次并返回结论。 */
export async function autoRepairEnvironment({ actions = null } = {}) {
  const before = runEnvironmentCheck()
  const candidates = (Array.isArray(actions) && actions.length ? actions : before.autoRepairs)
    .filter(action => SAFE_REPAIRS.includes(action))
  if (!candidates.length) return { changed: false, before, after: before, results: [] }
  const outcome = await repairEnvironment({ actions: [...new Set(candidates)], confirmed: true })
  return { changed: true, before, after: outcome.after, results: outcome.results }
}
