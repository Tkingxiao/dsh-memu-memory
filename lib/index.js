import { registerTools } from './tools.js'
import { registerInjection } from './inject.js'
import { registerPresetAttachment } from './preset-scope.js'
import { registerRpc } from './rpc.js'
import { registerCycle } from './cycle.js'
import { syncPromptDefaults } from './prompts.js'
import { ensureEngine, engineStatus, ENGINE_VERSION } from './engine.js'
import { getSettings, getMemoryBackend, backupDatabases, flushState, listLibraries, getSessionBinding, getCycleState, setCycleState, loadPrivateIndex } from './state.js'
import { buildTurnRecords, recordTurn, deleteTurnLog, turnLogLimits } from './turn-log.js'
import { pruneOrphanEntitiesAll } from './graph.js'
import { pruneDeletedStores } from './memory.js'
import { closeEmbeddingWorkers, setEmbeddingFailureSink } from './local-embedding-manager.js'
import { bootstrapLocalVector, closeLocalVectorService } from './local-vector-service.js'
import { closeMemuResident, prewarmMemuResident } from './memu.js'
import { vectorStatus } from './vector-profile.js'
import { setWarnSink, warn } from './paths.js'
import { recordDiagnostic, recordErrorDiagnostic } from './diagnostics.js'
import { autoRepairEnvironment, runEnvironmentCheck } from './environment-check.js'
import { planAllRepairs, applyRepairGroups } from './entity-repair.js'

export const name = 'dsh-memu-memory'
// `timer` backs ctx.interval, used by the idle/auto-curation sweep. Reading an
// injected service without declaring it throws at activation, so it is listed here.
export const inject = ['tools', 'timer']

const applied = new WeakSet()

/**
 * Defer startup work without leaking it past unload.
 *
 * Activation must not block — an engine install can take minutes and the vector
 * bootstrap touches a native runtime — so all three sweeps below run on a delay. A
 * bare `setTimeout` is not enough: `unref()` only stops the timer from keeping the
 * process alive, it does not cancel the callback, so a plugin unloaded inside the
 * window still ran engine installs and vector bootstraps against a disposed fiber.
 * The host's own guidance is the cordis timer service, which it disposes with the
 * plugin; the raw fallback is unref'd *and* returns a canceller the caller registers
 * through `ctx.effect`.
 */
function scheduleStartup(ctx, delay, label, run) {
  const guarded = () => {
    try { run() } catch (error) {
      try { ctx.logger?.warn?.(`dsh-memu-memory: ${label} failed: ${error?.message || error}`) } catch {}
    }
  }
  // Property access on an uninjected service throws in cordis, so the probe is guarded.
  let scoped = null
  try { scoped = typeof ctx.timeout === 'function' ? ctx : null } catch { scoped = null }
  if (scoped) {
    try {
      scoped.timeout(guarded, delay)
      return () => {}
    } catch {}
  }
  const timer = setTimeout(guarded, delay)
  timer.unref?.()
  return () => { try { clearTimeout(timer) } catch {} }
}

// 首用引导（§14.13）：本地向量模式且已有（或待切换）受管模型时，启动后把受管运行时复用起来、
// 拉起 loopback worker 并健康检查 /v1/embeddings。这里不下载：没有确认的联网动作留给她在
// 设置页点按钮，启动路径只做 reuse + 健康检查。失败只 warn（召回照旧退词法）。
function startLocalVectorBootstrap(ctx) {
  try {
    if (getMemoryBackend() !== 'api') return null
    if (getSettings().vectorSource !== 'local') return null
    const state = vectorStatus()
    const catalogId = state?.active?.profile?.catalogId || state?.requested?.catalogId || null
    if (!catalogId) return null
    return scheduleStartup(ctx, 2500, 'local embedding bootstrap', () => {
      // The resident interpreter only pays the MemU import once; it does not wait
      // for the embedding worker, so warming it in parallel with the runtime
      // bootstrap is safe and keeps the first recall from paying the cold start.
      void prewarmMemuResident()
      void bootstrapLocalVector({ confirmed: false }).then((ready) => {
        try { ctx.logger?.info?.(`dsh-memu-memory: managed local embedding runtime ready (${String(ready?.model || catalogId)} ${Number(ready?.dimension) || '?'}d)`) } catch {}
      }).catch((error) => {
        try { ctx.logger?.warn?.(`dsh-memu-memory: local embedding bootstrap skipped: ${error?.message || error}`) } catch {}
        recordErrorDiagnostic(error, { source: 'vector-bootstrap' })
      })
    })
  } catch (error) {
    try { ctx.logger?.warn?.(`dsh-memu-memory: local embedding bootstrap skipped: ${error?.message || error}`) } catch {}
    return null
  }
}

function startEngineBootstrap(ctx) {
  try {
    const settings = getSettings()
    // Local agent mode reads and writes the JSON index directly; installing a
    // Python/MemU runtime would only burn time and disk for nothing.
    if (getMemoryBackend() === 'agent') return null
    if (settings.autoInstallEngine === false) return null
    const status = engineStatus()
    if (status.status === 'ready' && status.current?.version === ENGINE_VERSION) return null
    if (status.status === 'installing') return null
    return scheduleStartup(ctx, 1500, 'engine bootstrap', () => {
      void ensureEngine({ beforeSwitch: backupDatabases }).catch((error) => {
        try { ctx.logger?.warn?.(`dsh-memu-memory: engine bootstrap failed: ${error?.message || error}`) } catch {}
        recordErrorDiagnostic(error, { source: 'engine-bootstrap' })
      })
    })
  } catch (error) {
    try { ctx.logger?.warn?.(`dsh-memu-memory: engine bootstrap skipped: ${error?.message || error}`) } catch {}
    return null
  }
}

// 兜底扫描（老数据升级）：旧版本的永久删除只删条目本身，别的条目 links 里指向它的
// 入边和 entities.json 里的实体节点会留下来，restoreGraphData 的部分恢复也会。这里在
// 启动后延迟跑一次全库 pruneOrphanEntitiesAll。选「每次启动延迟扫」而不是「首次
// getGraph + 持久化已清理标记」：扫描只是对小 JSON 文件的读 + 偶尔一次原子写，健康
// 数据零写入（no-op），幂等且能在任何一次删除路径将来回归时自愈；持久化标记省不下
// 多少成本，反而多一个「标记存在但数据又坏了」的状态要维护。延迟 4 秒（在 1.5s 引擎
// 引导与 2.5s 向量引导之后）让激活路径零阻塞；新安装没有库、没有实体，扫描直接 no-op。
// 单库失败只收集不抛出，整段失败只 warn —— 加载绝不能被一次清理绊倒。
function startOrphanEntitySweep(ctx) {
  try {
    return scheduleStartup(ctx, 4000, 'orphan entity sweep', () => {
      try {
        const deleted = pruneDeletedStores()
        for (const failure of deleted.failed) {
          try { ctx.logger?.warn?.(`dsh-memu-memory: deleted stash sweep skipped ${failure.libraryId}: ${failure.error}`) } catch {}
        }
        const result = pruneOrphanEntitiesAll()
        for (const failure of result.failed) {
          try { ctx.logger?.warn?.(`dsh-memu-memory: orphan entity sweep skipped ${failure.libraryId}: ${failure.error}`) } catch {}
        }
        if (result.removed > 0) {
          try { ctx.logger?.info?.(`dsh-memu-memory: orphan entity sweep collected ${result.removed} node(s) across ${result.scanned} library(ies)`) } catch {}
        }
      } catch (error) {
        try { ctx.logger?.warn?.(`dsh-memu-memory: orphan entity sweep failed: ${error?.message || error}`) } catch {}
      }
    })
  } catch (error) {
    try { ctx.logger?.warn?.(`dsh-memu-memory: orphan entity sweep skipped: ${error?.message || error}`) } catch {}
    return null
  }
}

// 一次性实体碎片修复（docs/pending-work.md §14.2 P7）：老版本把 n-gram 滑窗的窗口片段当成
// 人名建了节点（`南宫晚` / `宫晚晴` 其实是 `南宫晚晴`）。提名侧已修，但已落盘的碎片不会自己合，
// 也不会因为升级就变干净——所以新版本启动后自动跑一次。
//
// 界线（本函数唯一需要守住的）：
//   · attested（可证明）——窗口首尾重叠重建出的完整名**在正文里出现过**，或短名在全库正文里
//     从未独立于某个更长名字出现 → 自动合并。
//   · similar（只是相似）——编辑距离 ≤2 或名字核重合（`顾清欢` 与 `顾清悦` 就是这么撞上的）→
//     **一律不动**，只在诊断页报数并给一个「需确认」的修复按钮（environment-check 的 MANUAL 面）。
//
// 只跑一次：标记写进 `state.cycle.entityRepairVersion`（与 lastCurateAt 同族，不新造机制）。
// 幂等：合过的库第二次规划不出 attested 组；no-op 时一个字节都不写。
// 写入前先备份（合并级联不改记忆正文，但撤销要靠这份快照）。任何失败只 warn/记诊断，
// 加载绝不能被它绊住（硬规则 10：降级必须留可见信号）。
const ENTITY_REPAIR_VERSION = 1

/**
 * 升级自愈的执行体。单独导出是为了让测试能不开定时器、不装假 ctx 就直接跑同一段代码
 * （startEntityRepairPass 只负责"延迟 5 秒 + 只跑一次"这两件事）。
 */
export async function runEntityRepairPass({ note = () => {}, warn = () => {}, diagnose = () => {} } = {}) {
  let settings = null
  try { settings = getSettings() } catch {}
  let cycle = null
  try { cycle = getCycleState() } catch {}
  if (Number(cycle?.entityRepairVersion || 0) >= ENTITY_REPAIR_VERSION) return { skipped: 'done' }
  if (settings?.autoRepairEntityFragments === false) {
    note('entity repair skipped (autoRepairEntityFragments=off)')
    return { skipped: 'setting' }
  }
  const plan = planAllRepairs({ listLibraries, loadPrivateIndex })
  if (!plan.attested && !plan.similar && !plan.failures.length) {
    setCycleState({ entityRepairVersion: ENTITY_REPAIR_VERSION, entityRepairAt: new Date().toISOString() })
    return { skipped: 'clean', plan }
  }
  const results = []
  let deferred = false
  if (plan.attested > 0) {
    // 备份失败就一个字节都不写：合并级联会改实体指向，没有可撤销的快照就不许动手。
    // 标记此时保持未写，下次启动再试一次。
    let backedUp = true
    try {
      await backupDatabases({ label: 'entity-repair' })
    } catch (error) {
      backedUp = false
      deferred = true
      warn(`entity repair deferred: no backup available (${error?.code || error?.message || error})`)
      diagnose({
        level: 'warn', scope: 'graph', code: 'ENTITY_REPAIR_DEFERRED', alert: false,
        message: '实体碎片修复顺延：图备份没成功',
        hint: '备份可用后（下一次启动，或诊断页手动触发）再合并；本次没有写入任何改动。',
        detail: { attested: plan.attested, similar: plan.similar },
        source: 'entity-repair',
      })
    }
    if (backedUp) {
      for (const entry of plan.plans) {
        if (!entry.groups.length) continue
        results.push(applyRepairGroups(entry.libraryId, entry.groups))
      }
    }
  }
  const merged = results.reduce((total, row) => total + row.merged, 0)
  const created = results.reduce((total, row) => total + row.created, 0)
  const protectedRows = results.reduce((total, row) => total + row.restored, 0)
  const failures = [...plan.failures, ...results.flatMap((row) => row.failures || [])]
  if (!deferred) {
    setCycleState({
      entityRepairVersion: ENTITY_REPAIR_VERSION,
      entityRepairAt: new Date().toISOString(),
      entityRepairMerged: merged,
      entityRepairPending: plan.similar,
    })
  }
  if (merged || created) {
    note(`entity repair merged ${merged} group(s), created ${created} reconstructed node(s)`)
    diagnose({
      level: 'warn', scope: 'graph', code: 'ENTITY_FRAGMENT_REPAIRED', alert: true,
      message: `升级后自动合并了 ${merged} 组名字碎片（其中 ${created} 组新建了正文里出现过的完整名）`,
      hint: '原图已先行备份；记忆正文与条目本身没有被修改，只改了实体指向。',
      detail: { merged, created, protectedRows, libraries: results.map((row) => row.libraryId) },
      source: 'entity-repair',
    })
  }
  if (plan.similar > 0) {
    diagnose({
      level: 'warn', scope: 'graph', code: 'ENTITY_FRAGMENT_SUSPECTED', alert: true, manual: true,
      repair: 'merge-entity-fragments',
      message: `另有 ${plan.similar} 组实体只是名字相似，未自动合并`,
      hint: '相似不等于同一人：请到「设置 · 诊断」核对候选，确认后手动触发合并。',
      detail: { similar: plan.similar, libraries: plan.plans.filter((entry) => entry.ambiguous.length).length },
      source: 'entity-repair',
    })
  }
  for (const failure of failures) warn(`entity repair skipped ${failure.libraryId || ''} ${failure.group || ''}: ${failure.error}`)
  return { merged, created, protectedRows, similar: plan.similar, failures, deferred }
}

function startEntityRepairPass(ctx) {
  try {
    return scheduleStartup(ctx, 5000, 'entity repair pass', () => {
      void runEntityRepairPass({
        note: (message) => { try { ctx.logger?.info?.(`dsh-memu-memory: ${message}`) } catch {} },
        warn: (message) => { try { ctx.logger?.warn?.(`dsh-memu-memory: ${message}`) } catch {} },
        diagnose: recordDiagnostic,
      }).catch((error) => { recordErrorDiagnostic(error, { source: 'entity-repair' }) })
    })
  } catch (error) {
    try { ctx.logger?.warn?.(`dsh-memu-memory: entity repair pass skipped: ${error?.message || error}`) } catch {}
    return null
  }
}

// T0 构件 1（设计文档 §3.2）：增量回合日志的订阅接线。纯旁路记录器——任何失败只
// warn，绝不改变或阻断现有整理行为；正确性永远由宿主转录 + 缺口重建兜底。
//
// 按 turn/start..turn/end 攒批：一回合一行。缓冲对全会话开放（新会话的绑定要到
// 本回合中段的 ensureSession 才出现，闸门放在 turn/end 结算时判，首轮才不会漏记），
// turn/end 时只对满足条件的会话落盘：有 binding、useLibrary、origin !== 'subagent'
// （worker/fork 会话绝不记），且开关 on。
const TURNLOG_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/start', 'turn/end'])
const TURNLOG_BUFFER_LIMIT = 4000

function turnLogAdmitted(session) {
  const header = session?.header
  const sessionId = header?.id
  if (!sessionId || header?.origin === 'subagent') return false
  const binding = getSessionBinding(sessionId)
  if (!binding || binding.useLibrary === false) return false
  const settings = getSettings()
  if (settings.consolidationTurnLog !== 'on') return false
  // 回滚开关（§8）：T1 起 consolidationRunner 有默认值 'fork'（行为零变化）。「记录器
  // 随开关自动停」的语义以显式关闭 consolidationTurnLog 为准（§8 的「除非显式 on」
  // 例外）——默认 on 的旁路日志在 fork 路径下照常运行，关记录器请显式
  // consolidationTurnLog: 'off'（上一行闸门就是唯一开关）。runner 键缺失（T0 期）
  // 与显式 'fork' 在这里等价：记录器的启停不随执行器变化。
  return true
}

// 导出给 tests/turn-log.test.mjs：订阅行为（闸门/缓冲/sessionGone 清理）直接可测。
export function registerTurnLogRecorder(ctx) {
  const buffers = new Map() // sessionId -> 该回合已缓冲的宿主事件
  const offSession = ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session?.header?.id
      const type = event?.type
      if (!sessionId || !TURNLOG_EVENT_TYPES.has(type)) return
      if (type === 'turn/start') {
        buffers.set(sessionId, [event])
        return
      }
      if (type === 'turn/end') {
        const buffer = buffers.get(sessionId)
        buffers.delete(sessionId)
        if (!buffer || !turnLogAdmitted(session)) return
        buffer.push(event)
        const binding = getSessionBinding(sessionId)
        const limits = turnLogLimits(binding?.domainOverride || binding?.domain || 'general')
        for (const record of buildTurnRecords(buffer, limits)) recordTurn(sessionId, record)
        return
      }
      const buffer = buffers.get(sessionId)
      if (!buffer) return
      buffer.push(event)
      // 失控回合防御：单回合事件数超出常理就放弃本回合（缺口走重建路径自愈）。
      if (buffer.length > TURNLOG_BUFFER_LIMIT) buffers.delete(sessionId)
    } catch (error) {
      try { warn(`turn-log recorder dropped an event: ${error?.message || error}`) } catch {}
    }
  })
  // 会话被删除（binding 已标 sessionGone）时随绑定清理日志文件（§3.4 删除时机表）。
  const offDisposed = ctx.on('session/disposed', (session) => {
    try {
      const sessionId = session?.header?.id
      if (!sessionId) return
      buffers.delete(sessionId)
      if (getSessionBinding(sessionId)?.sessionGone) deleteTurnLog(sessionId)
    } catch {}
  })
  return () => {
    try { offSession?.() } catch {}
    try { offDisposed?.() } catch {}
  }
}

// 启动自检（§14.14）：把"插件能不能正常工作"的前提逐项查一遍。
//
// 排在三个引导之后（6s）是刻意的：引擎引导可能正在装、向量引导可能正在拉起 worker，
// 自检要看到它们的结果才有意义。安全修复（释放遗弃锁 / 重签摘要 / 重指运行时目录）
// 直接做——它们不联网、不改制品身份；其余的只写诊断，等她在诊断页点按钮。
// 之所以不再往 WebUI 的活动日志里塞：那里的每一条都是"记忆活动"，故障取证需要
// stderr 尾巴、目录、修复动作，那是诊断页的内容。
function startEnvironmentHealthCheck(ctx) {
  try {
    return scheduleStartup(ctx, 6000, 'environment health check', () => {
      // 自检永远跑（它只读），但"自动动手"跟着 autoInstallEngine 开关走：
      // 关掉自动准备引擎的用户，通常也不想让插件在启动时替他们清锁/改 profile。
      let autoRepair = true
      try { autoRepair = getSettings()?.autoInstallEngine !== false } catch {}
      const pass = autoRepair
        ? autoRepairEnvironment()
        : Promise.resolve({ changed: false, results: [], before: runEnvironmentCheck(), after: null })
      void pass.then((outcome) => {
        for (const result of outcome.results) {
          try { ctx.logger?.warn?.(`dsh-memu-memory: ${result.ok ? 'repaired' : 'repair failed'}: ${result.action} (${result.detail})`) } catch {}
        }
        const after = outcome.after || outcome.before
        for (const entry of after.items || []) {
          if (entry.level !== 'error' && entry.level !== 'warn') continue
          recordDiagnostic({
            level: entry.level,
            scope: 'environment',
            code: `ENV_${String(entry.id).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
            message: entry.title,
            detail: { detail: entry.detail, repair: entry.repair, files: entry.files },
            hint: entry.hint,
            repair: entry.repair,
            manual: entry.manual,
            source: 'startup-check',
          })
        }
      }).catch((error) => { recordErrorDiagnostic(error, { source: 'startup-check' }) })
    })
  } catch (error) {
    try { ctx.logger?.warn?.(`dsh-memu-memory: environment health check skipped: ${error?.message || error}`) } catch {}
    return null
  }
}

export function apply(ctx, config) {
  // A conversation that names an agent preset composes its model-facing plugin set from
  // that preset's cordis.yml alone, and that subtree never delivers `agent/pre-step` to
  // this instance — so nothing here runs for those conversations. `lib/preset-scope.js`
  // walks the live agent registry and attaches the injection listener on each such
  // agent's own context instead. No preset file is touched.
  //
  // `config.preset === true` remains for the opposite case: a user who *does* list this
  // plugin inside a preset gets a second instance in the same process, and that instance
  // must not re-register the process-global surfaces (RPC prefix, idle sweep, engine
  // installer). The tools and the pre-step hook are what such a mount needs.
  const inPreset = config?.preset === true
  if (applied.has(ctx)) {
    try { ctx.logger?.warn?.('dsh-memu-memory: apply() already ran on this context; skipping') } catch {}
    return
  }
  applied.add(ctx)

  setWarnSink((message) => {
    try { ctx.logger?.warn?.(`dsh-memu-memory: ${message}`) } catch {}
    // 同一条 warn 也进诊断档案：活动日志记的是"记忆活动"，插件内部故障需要集中取证。
    // recordDiagnostic 自己做 60 秒去重，反复出现的同一句只累加 count。
    recordDiagnostic({ level: 'warn', scope: 'plugin', code: 'MEMU_WARNING', message, source: 'warn-sink' })
  })

  // 嵌入 worker 的失败以前只剩一句"worker exited before it became ready"（stderr 被整个
  // 丢掉）。接进诊断后，那条记录带着 stderr 尾巴与两个目录，能直接看出是缺原生模块
  // 还是 runtimeDir 指错了。
  setEmbeddingFailureSink((payload) => {
    const error = Object.assign(new Error(payload?.message || 'embedding worker failed'), {
      code: payload?.code || 'LOCAL_VECTOR_WORKER_EXITED',
      detail: { stderrTail: payload?.stderrTail || '' },
    })
    recordErrorDiagnostic(error, {
      source: 'embedding-worker',
      detail: { modelDir: payload?.modelDir || '', runtimeDir: payload?.runtimeDir || '' },
    })
  })

  // Bookkeeping writes are coalesced on a 50ms timer (P0-4). Anything still
  // pending has to reach disk before the process goes away.
  const flush = () => { try { flushState() } catch (error) { try { ctx.logger?.warn?.(`dsh-memu-memory: final flush failed: ${error?.message || error}`) } catch {} } }
  try { process.once('beforeExit', flush) } catch {}
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try { process.removeListener('beforeExit', flush) } catch {}
      flush()
    }, 'dsh-memu-memory: state flush')
  }

  try { syncPromptDefaults() } catch (error) {
    try { ctx.logger?.warn?.(`dsh-memu-memory: prompt default sync failed: ${error?.message || error}`) } catch {}
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (scope) => {
      scope.effect(() => registerTools(scope), 'dsh-memu-memory: tools')
    })
  } else if (ctx.tools) {
    ctx.effect(() => registerTools(ctx), 'dsh-memu-memory: tools')
  }

  const disposeInjection = registerInjection(ctx)
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => disposeInjection, 'dsh-memu-memory: injection')
  }

  const disposeAttach = registerPresetAttachment(ctx, {
    log: (message) => { try { ctx.logger?.warn?.(`dsh-memu-memory: ${message}`) } catch {} },
  })
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => disposeAttach, 'dsh-memu-memory: preset attachment')
  }

  if (!inPreset) {
    registerRpc(ctx)
    // 进程级清理：preset 挂载共享同一个数据目录，只由拥有全局表面的实例扫一次。
    // Each starter returns either a canceller (raw timer fallback) or a no-op (the
    // cordis timer service already cancels with the fiber); unload inside the delay
    // window must not run any of them against a disposed context.
    const startupCancels = [
      startEngineBootstrap(ctx),
      startLocalVectorBootstrap(ctx),
      startOrphanEntitySweep(ctx),
      startEntityRepairPass(ctx),
      startEnvironmentHealthCheck(ctx),
    ].filter(Boolean)
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        for (const cancel of startupCancels) { try { cancel() } catch {} }
      }, 'dsh-memu-memory: startup timers')
    }
  }

  // The embedding worker is a process-global singleton, so it outlives any single
  // acquire() and would keep a native session and a loopback port alive after this
  // instance is unloaded. Preset mounts share that same worker, so only the instance
  // that owns the process-global surfaces may close it. Recall degrades to lexical
  // afterwards instead of failing.
  if (!inPreset && typeof ctx.effect === 'function') {
    ctx.effect(() => () => { closeEmbeddingWorkers() }, 'dsh-memu-memory: embedding workers')
    // The resident interpreter is also process-global; leaving it behind would keep
    // a Python process (and its sqlite handles) alive after this plugin unloads.
    ctx.effect(() => () => { closeMemuResident() }, 'dsh-memu-memory: memu resident engine')
    // The download/install service owned a loopback port and an in-flight job queue
    // with no close call site at all: after an unload it kept downloading, and the
    // BUSY state then refused a restart from the next instance.
    ctx.effect(() => () => { try { closeLocalVectorService() } catch (error) { try { ctx.logger?.warn?.(`dsh-memu-memory: closing the local vector service failed: ${error?.message || error}`) } catch {} } }, 'dsh-memu-memory: local vector service')
  }

  const disposeCycle = inPreset ? null : registerCycle(ctx, {
    log: (message) => { try { ctx.logger?.warn?.(`dsh-memu-memory: ${message}`) } catch {} },
  })
  if (disposeCycle && typeof ctx.effect === 'function') {
    ctx.effect(() => disposeCycle, 'dsh-memu-memory: cycle')
  }

  // 回合日志记录器与 RPC/cycle 一样是进程全局面：preset 挂载共享同一数据目录，
  // 双实例订阅会双写日志，所以只在拥有全局面的实例上注册。
  if (!inPreset && typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => registerTurnLogRecorder(ctx), 'dsh-memu-memory: turn-log recorder')
    } catch (error) {
      try { ctx.logger?.warn?.(`dsh-memu-memory: turn-log recorder unavailable: ${error?.message || error}`) } catch {}
    }
  }

  try {
    const settings = getSettings()
    // One line that answers "is memory actually on?" without a debugger. The
    // silent-recall bug (P0-1) would have been obvious from this.
    ctx.logger?.info?.(
      `dsh-memu-memory: loaded (engine ${ENGINE_VERSION}) backend=${getMemoryBackend()} autoInject=${settings.autoInject} `
      + `anchorTokens=${settings.anchorTokens} turnTokens=${settings.turnTokens} mustRememberCap=${settings.mustRememberCap} `
      + `unpinBudget=${settings.unpinBudgetPerSession ?? 2}`,
    )
  } catch (error) {
    try { ctx.logger?.warn?.(`dsh-memu-memory: startup summary failed: ${error?.message || error}`) } catch {}
  }
}
