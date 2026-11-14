// T1 构件 2（设计文档 §4/§5/§15.1 构件 2）：持久整理 worker 的生命周期管理。
//
// 定位：worker 与 turn-log 一样是缓存，账本才算数（§0 铁律 1）。本模块只负责
// 「谁来写」与「喂什么」：三级试活（agents.get → agents.resume 能力探测 → 初生，
// §4.6）、epoch 记账与退役条件（只在 acquire 时检查，§4.5）、增量包/交接包组装
// （§4.2/§5.1）、超时计数与退役（§4.4）。每窗结算仍走 private.js 现有的
// decideCompletion/completeJob/lastSleepSeq/carry 链路，一行语义不改。
//
// 默认 consolidationRunner: 'fork'——本模块的全部路径只在设置显式切到 'worker'
// 时被 private.js 调用；'fork'（现状每窗新 fork）行为逐字节不变。
import { getSessionBinding, getSettings, setSessionBinding, deleteSessionBinding, loadPrivateIndex } from './state.js'
import { warn, shortHash } from './paths.js'
import { record } from './activity-log.js'
import { loadLedger, scopeGenerationOf } from './consolidation-ledger.js'
import { buildWorkerBrief, CORE_WRITE_TOOLS, WORKER_READ_TOOLS, WORKER_WRITE_TOOLS, WORKER_TOOL_ALLOW } from './consolidation-worker.js'
import { registerTools } from './tools.js'
import { tailSlice, readIncrement, rebuildRange, buildTurnRecords } from './turn-log.js'
import { condenseEvents } from './curator.js'

// —— epoch 预算分档（§4.5 条件 2/3）————————————————————————————————
// 按模型 maxContext 自动取档：≤128k 输入窗 → 120k 字符/8 窗；其余（含 ≥1M 旗舰）→ 200k/16。
// 大上下文模型不再放到 400k/32：P14 实测 32 窗会把 worker 上下文堆到 174k token，
// 而 96.9% 的整理 token 是历史重读；压到 200k 字符/16 窗可省约七成整理 token
// （§9.0：每窗含思考约 13-21k）。模型 maxContext 尽力从宿主模型发现取
// （probeModelMaxContext）；取不到按最保守的第一档。显式设置
// （workerEpochCharLimit / workerEpochMaxWindows（正整数，未来经 DEFAULT_SETTINGS
// 放开）覆盖自动档；本阶段这两个键不在设置面里，属于前向兼容钩子。
export const WORKER_EPOCH_TIERS = Object.freeze([
  Object.freeze({ maxContext: 131_072, charLimit: 120_000, maxWindows: 8 }),
  Object.freeze({ maxContext: 262_144, charLimit: 200_000, maxWindows: 16 }),
  Object.freeze({ maxContext: Number.MAX_SAFE_INTEGER, charLimit: 200_000, maxWindows: 16 }),
])
// 产出系数（§4.5 条件 2）：触发时「epoch 已累计 + 本窗增量 × 3 ≤ LIMIT」的粗估，
// 3 倍覆盖 worker 产出与思考；窗口跑完后按实际观测替换估算（recordEpochProgress）。
export const WORKER_OUTPUT_FACTOR = 3
// 条件 4（§4.5）：距上一窗 whenIdle 完成超过缓存 TTL 即换新。只在 acquire 时检查，
// 不做后台定时退役；TTL 是保守方向的启发式——早换新永不吃亏。
export const WORKER_EPOCH_IDLE_TTL_MS = 30 * 60_000
// 交接包尾部预算（§5.2）：min(20k, 连续回合)，tailSlice 保证整回合。
export const WORKER_HANDOFF_TAIL_CHARS = 20_000
// §4.4：超时不算失败；同一 worker 连续 2 次超时升级为退役。
export const WORKER_TIMEOUT_LIMIT = 2
// 退役时等 whenIdle 的上限：卡死的 worker 不能挂住下一次整理。
export const WORKER_RETIRE_IDLE_WAIT_MS = 5_000
// §3.3 回退路径的现场压缩预算（与 requestRemoteConsolidation 同款）。
export const WORKER_INCREMENT_FALLBACK_CHARS = 60_000

/** 按模型 maxContext 取档；未知模型回最保守的第一档；显式设置覆盖自动档。 */
export function epochBudget(binding, settings = null) {
  const explicitChars = Number(settings?.workerEpochCharLimit)
  const explicitWindows = Number(settings?.workerEpochMaxWindows)
  const maxContext = Number(binding?.workerEpoch?.modelMaxContext)
  const tier = WORKER_EPOCH_TIERS.find((row) => Number.isSafeInteger(maxContext) && maxContext > 0 && maxContext <= row.maxContext) || WORKER_EPOCH_TIERS[0]
  return {
    charLimit: Number.isSafeInteger(explicitChars) && explicitChars > 0 ? explicitChars : tier.charLimit,
    maxWindows: Number.isSafeInteger(explicitWindows) && explicitWindows > 0 ? explicitWindows : tier.maxWindows,
  }
}

/**
 * 预算合格制（§4.5 条件 2）：epoch 已累计 + 本窗增量 × 产出系数 ≤ 字符上限。
 * 触发时检查，粗估、宁可早换新；不做事件级精确记账（宿主 compaction 是溢出安全网）。
 */
export function budgetFit(epoch, incrementChars, settings = null) {
  const chars = Number(epoch?.chars) || 0
  const increment = Math.max(0, Number(incrementChars) || 0)
  return chars + increment * WORKER_OUTPUT_FACTOR <= epochBudget({ workerEpoch: epoch }, settings).charLimit
}

/** 宿主模型发现的 maxContext 尽力获取；拿不到返回 null（epochBudget 落第一档）。 */
export async function probeModelMaxContext(ctx, agentOptions) {
  const provider = typeof agentOptions?.provider === 'string' ? agentOptions.provider : ''
  const model = typeof agentOptions?.model === 'string' ? agentOptions.model : ''
  if (!provider || !model) return null
  const llm = (() => { try { return ctx?.get?.('llm') || null } catch { return null } })()
  if (!llm) return null
  // 首选 resolveModelInfo：宿主唯一的容量口径在 resolved.context.contextWindow。
  // listModels 的目录条目（LlmModelInfo）不带容量字段，读它永远落空（A4）。
  try {
    const resolved = await llm.resolveModelInfo?.(provider, model)
    const contextWindow = Number(resolved?.context?.contextWindow)
    if (Number.isSafeInteger(contextWindow) && contextWindow > 0) return contextWindow
  } catch { /* 探测失败降级，绝不阻断整理 */ }
  // 兜底：个别宿主/测试可能把容量直接挂在目录条目上。
  try {
    const models = await llm.listModels?.(provider)
    if (Array.isArray(models)) {
      const entry = models.find((item) => item && (item.id === model || item.name === model)) || null
      for (const key of ['maxContext', 'contextLength', 'contextWindow', 'maxInputTokens', 'maxContextTokens']) {
        const value = Number(entry?.[key])
        if (Number.isSafeInteger(value) && value > 0) return value
      }
    }
  } catch { /* 同上 */ }
  return null
}

// —— 工具面（自 private.js 迁入；'fork' 路径调用同一份实现，行为逐字节一致）—————

// PTC 兼容（2026-10-31 现场 worker-tools-ptc-only）：PTC 会话的 header 工具表只有
// run_code，其余工具走 run_code 程序里的 SDK 绑定（宿主 ptc.ts 用
// tools.schemas(agent, toolSet) 枚举"调用 agent 的可见面"）。preset 组合没列出本插件
// 时，fork 的注册表里根本没有 memu_*，worker 既不能原生调用也没有 SDK 绑定，回执只能
// 是 tools-unavailable。修法与 preset-scope.js 的注入挂载同构：把 worker 读写面挂进 fork
// 自己的 ctx scope —— 注册表按 scope 链取可见面，所以只对这个 worker 可见，不扩散到
// 其它会话；挂载点必须在 followup 之前（宿主在 step 开始时 resolve 一次 admitted set，
// 之后注册的工具不进本步）。失败不阻断整理：worker 会按任务书如实回执 tools-unavailable。
export async function attachWorkerTools(agents, childId, parentId) {
  const wanted = [...WORKER_WRITE_TOOLS, ...WORKER_READ_TOOLS]
  const ctxOf = (record) => {
    try { return record?.ctx || record?.agent?.ctx || null } catch { return null }
  }
  let parentHasCtx = null
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let record = null
    try { record = agents.get?.(childId) || null } catch { record = null }
    if (record) {
      const actx = ctxOf(record)
      // 有记录但没有 ctx：这版宿主不暴露 agent context（preset-scope.js 的同款限制），
      // 重试不会变出来。ctx 在但没有 tools 服务：组合里就没有。两者都直接放弃。
      if (!actx || !(actx.tools && typeof actx.tools.register === 'function')) break
      try {
        const dispose = registerTools(actx, { only: wanted })
        // tools.js 在 disposer 上附挂实际注册成功的名单（编译 + register 都过的那部分）。
        // 读它，不再把 wanted 全量当成"已挂载"——部分挂载必须结构化可见。
        const attached = Array.isArray(dispose?.attached) ? [...dispose.attached] : null
        return {
          dispose,
          attached,
          requested: wanted,
          // 名单缺失 = 无法证明挂全：partial 照实标 true，attached 落 null（与失败同口径）。
          partial: attached ? attached.length < wanted.length : true,
        }
      } catch (error) {
        warn('consolidation worker tool attach failed: ' + String(error?.message || error))
        return null
      }
    }
    // 子记录还没出现：只在这个宿主确实会暴露 ctx（父记录带 ctx）时才值得短退避等它。
    if (parentHasCtx === null) parentHasCtx = Boolean(ctxOf(agents.get?.(parentId)))
    if (!parentHasCtx) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  warn('consolidation worker has no tools service on its own context; the worker may be unable to write memories')
  return null
}

// 活动日志"整理已开始"条目的挂载元数据口径（workerTools* 三件，见 private.js workerToolsMeta）：
//   workerToolsAttached  实际注册成功的工具名数组；null = 挂载没有完成或无法确认。
//   workerToolsRequested 请求挂载的完整 wanted 名单；与 attached 全等才是全量挂载。
//   workerToolsPartial   true = 未证明 worker 拿到完整 wanted 集。
// A fork inherits the parent preset's plugin tools. `tools.restrict()` is scoped
// to the child agent, so this removes every plugin tool the worker never uses
// without touching the parent session. Restrict before followup: the host
// resolves the admitted set at step start.
export async function restrictWorkerTools(agents, childId, parentId) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let record = null
    try { record = agents.get?.(childId) || null } catch { record = null }
    const actx = record?.ctx || record?.agent?.ctx || null
    if (actx && actx.tools && typeof actx.tools.restrict === 'function') {
      try {
        const dispose = actx.tools.restrict({ allow: WORKER_TOOL_ALLOW })
        return { dispose, allowed: [...WORKER_TOOL_ALLOW] }
      } catch (error) {
        // A host missing one of the optional tools must not lose consolidation;
        // retry with the write/read core and let the brief tell the truth.
        const core = [...CORE_WRITE_TOOLS]
        try {
          return { dispose: actx.tools.restrict({ allow: core }), allowed: core }
        } catch (inner) {
          warn('consolidation worker tool restriction failed: ' + String(inner?.message || inner))
          return null
        }
      }
    }
    if (record || !(agents.get?.(parentId))) return null
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return null
}

// —— epoch 句柄注册表 ————————————————————————————————————————————
// attach/restrict 的 disposer 是插件侧闭包，必须活过整个 epoch（跨窗复用、退役时统一
// dispose）。进程内 Map：重启后注册表随进程消失，resume 回来的 worker 由 acquireWorker
// 重新挂一次工具面（宿主的工具注册也是进程内的，本来就非重挂不可）。
const epochDisposables = new Map()

function disposablesOf(forkId) {
  return epochDisposables.get(forkId) || null
}

// 有界等 whenIdle：返回是否真的落到 idle（true=可安全复用/已收敛；false=时限内仍忙）。
// whenIdle 缺失视为 idle（老宿主/mock 无此能力时不阻塞）；reject 也视为 idle（多半已 dispose）。
async function waitWorkerIdle(handle, idleWaitMs) {
  if (!handle?.agent || typeof handle.agent.whenIdle !== 'function') return true
  let idle = false
  let timer = null
  try {
    await Promise.race([
      Promise.resolve(handle.agent.whenIdle()).then(() => { idle = true }, () => { idle = true }),
      new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, Number(idleWaitMs) || 0)) }),
    ])
  } catch {} finally { if (timer) clearTimeout(timer) }
  return idle
}

// —— 退役（§4.5 退役动作）———————————————————————————————————————
// 先 abort epoch 控制器（取消在跑回合）→ 等 idle（有上限）→ dispose 工具 restriction/handle
// → dispose agent → 删子绑定 → 清父绑定 workerEpoch → 活动日志记 epoch 结束。
// reason ∈ 'scope-change' | 'char-limit' | 'window-limit' | 'idle-ttl' | 'failure' | 'timeout-x2'；
// scope-change / failure 不做交接（不带病工作），其余默认交接——交接包由下一窗初生时组装。
export async function retireWorker(ctx, forkId, reason, { handoff, now = Date.now(), idleWaitMs = WORKER_RETIRE_IDLE_WAIT_MS } = {}) {
  const agents = (() => { try { return ctx?.get?.('agents') || null } catch { return null } })()
  const binding = (() => { try { return getSessionBinding(forkId) } catch { return null } })()
  const epoch = binding?.workerEpoch && typeof binding.workerEpoch === 'object' ? binding.workerEpoch : null
  const parentSessionId = epoch?.parentSession || binding?.parentSessionId || null
  const disposables = disposablesOf(forkId)
  // 0. 先取消在跑回合：epoch 控制器绑定在 agent 生命周期上（A2），abort 才能让卡住的
  //    回合尽快收敛，下面的有界 whenIdle 才不会白等满时限。
  try { disposables?.abort?.abort() } catch {}
  // 1. 等 whenIdle（有上限）：超时退役后 worker 可能还在跑上一回合的工具。
  let handle = null
  try { handle = agents?.get?.(forkId) || null } catch { handle = null }
  await waitWorkerIdle(handle, idleWaitMs)
  // 2. dispose 工具面（本模块注册表）+ agent 本体。找不到 handle（已死/已重启）就跳过，
  //    剩下的清理照做——「视为已死，冷启动」（§4.5 非条件项）。
  epochDisposables.delete(forkId)
  try { disposables?.restriction?.dispose?.() } catch {}
  try { disposables?.tools?.dispose?.() } catch {}
  try { await ((handle?.agent) || handle)?.dispose?.() } catch {}
  // 3. 删子绑定；turn-log 不删（§3.4：日志比 worker 活得长）。
  try { deleteSessionBinding(forkId) } catch {}
  // 4. 父绑定 epoch 清零（binding.workerEpoch 清零 → 下窗走初生路径）。
  if (parentSessionId) {
    try {
      const parent = getSessionBinding(parentSessionId)
      if (parent?.workerEpoch?.forkSessionId === forkId) setSessionBinding(parentSessionId, { workerEpoch: null })
    } catch {}
  }
  // 5. 活动日志记 epoch 结束（退役是常规操作而非故障：qq-bridge 类长会话周期性到点换新，§6）。
  try {
    record({
      kind: 'check',
      scope: 'private',
      sessionId: parentSessionId || forkId,
      libraryId: binding?.libraryId || null,
      ok: true,
      message: '整理 worker 退役 · ' + String(reason || 'unknown')
        + (handoff === true ? ' · 交接（下窗交接包冷启动）' : ' · 不交接')
        + ' · epoch ' + (Number(epoch?.index) || '?') + ' · ' + (Number(epoch?.windows) || 0) + ' 窗 / ' + (Number(epoch?.chars) || 0) + ' 字符',
      detail: { forkId, reason: reason || null, handoff: handoff === true, epoch: epoch ? { index: epoch.index, chars: epoch.chars, windows: epoch.windows } : null },
    })
  } catch {}
  return { ok: true, forkId, reason, handoff: handoff === true, hadHandle: Boolean(handle) }
}

// —— epoch 记账 ——————————————————————————————————————————————————————
// 每窗一次：chars += 增量 + 观测到的 worker 产出（监听器顺手累计的 assistant/tool 体积）；
// windows += 1；结算成功清超时计数；超时 +1（连续 2 次 → 退役，§4.4）；idleAt 记
// whenIdle 完成时刻（条件 4 的 TTL 起算点）。binding 传父会话的（内部重读最新值再写，
// 避免覆盖并发的绑定补丁）；子绑定里的 epoch 副本同步刷新。
export function recordEpochProgress(binding, { incrementChars = 0, workerOutputChars = 0, idleAt = null, settled = false, timeout = false, progress = true, now = Date.now() } = {}) {
  const sessionId = binding?.sessionId
  if (!sessionId) return null
  const current = (() => { try { return getSessionBinding(sessionId) || binding } catch { return binding } })()
  const epoch = current?.workerEpoch
  if (!epoch || typeof epoch !== 'object' || !epoch.forkSessionId) return null
  const timeouts = Number(epoch.timeouts) || 0
  const next = {
    ...epoch,
    chars: Math.max(0, Number(epoch.chars) || 0)
      + (progress ? Math.max(0, Number(incrementChars) || 0) + Math.max(0, Number(workerOutputChars) || 0) : 0),
    windows: (Number(epoch.windows) || 0) + (progress ? 1 : 0),
    timeouts: timeout ? timeouts + 1 : (settled ? 0 : timeouts),
    lastIdleAt: idleAt ? new Date(Number(idleAt) || now).toISOString() : (epoch.lastIdleAt || null),
  }
  try { setSessionBinding(sessionId, { workerEpoch: next }) } catch (error) {
    try { warn('worker epoch progress write failed: ' + String(error?.message || error)) } catch {}
    return null
  }
  try {
    const child = getSessionBinding(epoch.forkSessionId)
    if (child) setSessionBinding(epoch.forkSessionId, { workerEpoch: next })
  } catch {}
  return next
}

// —— 三级试活（§4.6）———————————————————————————————————————————————
/**
 * 获取或初生持久 worker。退役条件全部只在 acquire 时检查（执行中不误杀，§4.5）：
 *   1. scope/库/域变化      → 立即退役，无交接（上下文已污染）
 *   2. 预算合格制（budgetFit）→ 换新，交接
 *   3. epoch 窗口数超限      → 换新，交接
 *   4. 距上一窗 idle 超 TTL   → 换新，交接
 * 条件 5（失败）与超时×2 是反应式退役，由 private.js 在结算失败/超时路径调用 retireWorker。
 *
 * 返回：
 *   { ok:true, forkId, handle, birth, reused, resumed, epoch, tools, restriction, epochAbort, retired, handoff }
 *   | { ok:false, reasonCode, error, retired? }
 * handoff = 本 次 获 取 是否允许交接包语义（退役原因决定；无退役的复用窗口为 false）。
 * epochAbort = 绑在 worker 生命周期上的控制器，供调用方硬停/重验时真正停住持久 worker（A2）。
 */
export async function acquireWorker(ctx, binding, {
  incrementChars = 0, settings = null, probe = null,
  agentOptions = null, header = null, now = Date.now(), idleWaitMs = WORKER_RETIRE_IDLE_WAIT_MS,
} = {}) {
  const sessionId = binding?.sessionId
  if (!sessionId) return { ok: false, reasonCode: 'no-binding', error: 'acquireWorker requires a session binding' }
  const agents = ctx?.get?.('agents')
  if (!agents || typeof agents.create !== 'function') {
    return { ok: false, reasonCode: 'no-agents-service', error: 'host has no agents.create; the consolidation worker cannot start' }
  }
  settings = settings || getSettings()
  const liveBinding = (() => { try { return getSessionBinding(sessionId) || binding } catch { return binding } })()
  const retired = []
  let epoch = liveBinding?.workerEpoch && typeof liveBinding.workerEpoch === 'object' ? liveBinding.workerEpoch : null
  let prevIndex = Number(epoch?.index) || 0
  let handoff = true // 初生包默认带交接上下文（§5.1：初生包与 handoff 包是同一个东西）

  // —— Stage A：退役条件（只在这里查）———————————————————————————————
  if (epoch?.forkSessionId) {
    const generation = scopeGenerationOf(liveBinding)
    const budget = epochBudget(liveBinding, settings)
    let reason = null
    if (!epoch.scopeGeneration || epoch.scopeGeneration !== generation) reason = 'scope-change'
    else if (epoch.lastIdleAt && now - (Date.parse(epoch.lastIdleAt) || 0) > WORKER_EPOCH_IDLE_TTL_MS) reason = 'idle-ttl'
    else if (!budgetFit(epoch, incrementChars, settings)) reason = 'char-limit'
    else if ((Number(epoch.windows) || 0) >= budget.maxWindows) reason = 'window-limit'
    if (reason) {
      // scope-change 不交接（§4.5 条件 1）；其余三个都交接（§5.2：上下文活在文件和账本里）。
      const withHandoff = reason !== 'scope-change'
      const result = await retireWorker(ctx, epoch.forkSessionId, reason, { handoff: withHandoff, now, idleWaitMs })
      retired.push({ forkId: epoch.forkSessionId, reason, handoff: withHandoff, ok: result?.ok === true })
      handoff = withHandoff
      epoch = null
    }
  }

  // —— Stage B：试活（get 进程内 → resume 跨重启 → 都失败视为已死）—————————————————
  // 句柄归一化（bench 实测 bug #1）：宿主 create 返回 handle 包装（{agent,...}），而
  // agents.get 返回**裸 Agent**——复用分支若把裸 Agent 当 handle 返回，派发处的
  // `handle.agent.followup` 会读 undefined 崩溃（bench arm B 实录：窗口 2 复用后
  // exception，后续窗口全部 already-exists）。归一成 create 同形状，三种来源统一。
  const toHandle = (raw) => (raw ? (raw.agent != null ? raw : { agent: raw }) : null)
  if (epoch?.forkSessionId) {
    let handle = null
    try { handle = (typeof agents.get === 'function' && toHandle(agents.get(epoch.forkSessionId))) || null } catch { handle = null }
    let resumed = false
    let resumeAbort = null
    if (!handle && typeof agents?.resume === 'function') {
      // 能力探测（任务约束）：resume 不可用/抛错都跳过此级，绝不抛错。
      // resume 的 signal 同样被宿主绑到 agent 生命周期（initializeAgent），作为新 epoch 的 abort。
      resumeAbort = new AbortController()
      try { handle = toHandle(await agents.resume({ resumeSessionId: epoch.forkSessionId, signal: resumeAbort.signal })) || null } catch { handle = null }
      resumed = Boolean(handle)
    }
    if (handle) {
      let disposables = disposablesOf(epoch.forkSessionId)
      if (resumed) {
        // 崩溃恢复（§4.6）：工具注册是进程内的，resume 回来的 worker 必须重挂读写面。
        const tools = probe?.hasWrite === true ? null : await attachWorkerTools(agents, epoch.forkSessionId, sessionId)
        const restriction = await restrictWorkerTools(agents, epoch.forkSessionId, sessionId)
        disposables = { tools, restriction, abort: resumeAbort }
        epochDisposables.set(epoch.forkSessionId, disposables)
      }
      // A1（设计 §4.4）：复用前必须等上一回合落地（有界）。超时废回合后 worker 可能还在跑，
      // 直接发下一窗会把上一回合的 turn/end/回执/工具轮灌进本窗监听器。等到 idle 才安全；
      // 等不到就是卡死——退役冷启动（宁可早换新），绝不把新回合塞进一个还在忙的 worker。
      const idle = await waitWorkerIdle(handle, idleWaitMs)
      if (idle) {
        return {
          ok: true, forkId: epoch.forkSessionId, handle,
          birth: false, reused: true, resumed, epoch, tools: disposables?.tools || null, restriction: disposables?.restriction || null,
          epochAbort: disposables?.abort || null,
          retired, handoff: false,
        }
      }
      const result = await retireWorker(ctx, epoch.forkSessionId, 'failure', { handoff: true, now, idleWaitMs })
      retired.push({ forkId: epoch.forkSessionId, reason: 'failure', handoff: true, stuck: true, ok: result?.ok === true })
      handoff = true
      epoch = null
    } else {
      // 死亡（重启后 resume 不可用/会话被删）：冷启动 + 交接包（§8）；worker 会话本身没有
      // 可等的回合，retire 只做清理与记账。
      const result = await retireWorker(ctx, epoch.forkSessionId, 'failure', { handoff: true, now, idleWaitMs })
      retired.push({ forkId: epoch.forkSessionId, reason: 'failure', handoff: true, gone: true, ok: result?.ok === true })
      handoff = true
      epoch = null
    }
  }

  // —— Stage C：初生（§4.1）———————————————————————————————————————————
  let index = prevIndex + 1
  let forkId = 'memu-worker-' + shortHash(sessionId) + '-' + index
  const modelMaxContext = await probeModelMaxContext(ctx, agentOptions)
  // A2：epoch 级 abort 控制器，绑到 agent 生命周期（宿主把 create.signal 永久接到 lifetime）。
  // 续窗的硬停/重验 abort 它才能真正停住持久 worker——窗口级 signal 只在出生那次被宿主接线。
  const epochAbort = new AbortController()
  // 无种子创建（宿主 0.2.2-rc.3 已核实 seed 可选）：初生包改为第一条 followup 消息，
  // worker 路径完全解除 buildForkSeed 依赖（§4.1）。
  // 同 id 撞车（bench 实测 bug）：窗口 2 派发崩溃 → retireWorker('failure') 清 epoch，
  // 但 dispose 只关句柄不删会话文件 → 下一窗初生用同一 forkId 被宿主拒绝
  // （worker-create-failed: already exists，bench 实测连挂 10 次）→ 增量永远整理不进库。
  // 撞车处理：先探测旧会话——**存活就收编**（重建 epoch 记账指向它，保留其累积上下文），
  // 已死才 index 顺延换新 id 创建（≤6 次，孤儿链上逐个跳过）。
  let handle = null
  for (let createAttempt = 0; createAttempt < 6; createAttempt += 1) {
    let collided = false
    try {
      handle = await agents.create({
        sessionId: forkId,
        meta: {
          cwd: header?.cwd,
          parentSession: sessionId,
          // Without this the worker is treated as an ordinary user conversation by
          // the injection path and the sidebar session lists（与 fork 同款隔离）。
          origin: 'subagent',
          agentPreset: header?.agentPreset,
        },
        agentOptions: agentOptions || undefined,
        signal: epochAbort.signal,
      })
    } catch (error) {
      const message = String(error?.message || error)
      if (!/already exist/i.test(message)) {
        return {
          ok: false, reasonCode: 'worker-create-failed', forkId, retired,
          error: 'the host rejected the consolidation worker: ' + message,
        }
      }
      collided = true
    }
    if (!collided) break
    // 撞车：探测旧会话——存活收编，死亡顺延换新 id。
    const orphan = (() => { try { return (typeof agents.get === 'function' && agents.get(forkId)) || null } catch { return null } })()
    if (orphan) {
      handle = toHandle(orphan)
      break
    }
    index += 1
    forkId = 'memu-worker-' + shortHash(sessionId) + '-' + index
  }
  // 工具面只在初生挂一次（§15.2 改动点 2）；标准 preset 的名单里已有 memu_* 时不重复挂。
  const tools = probe?.hasWrite === true ? null : await attachWorkerTools(agents, forkId, sessionId)
  const restriction = await restrictWorkerTools(agents, forkId, sessionId)
  epochDisposables.set(forkId, { tools, restriction, abort: epochAbort })
  const epochRecord = {
    forkSessionId: forkId,
    index,
    birthAt: new Date(Number(now) || Date.now()).toISOString(),
    chars: 0,
    windows: 0,
    timeouts: 0,
    scopeGeneration: scopeGenerationOf(liveBinding),
    parentSession: sessionId,
    modelMaxContext: modelMaxContext || null,
    lastIdleAt: null,
  }
  try {
    setSessionBinding(forkId, { consolidationFork: true, origin: 'subagent', workerEpoch: epochRecord })
    setSessionBinding(sessionId, { workerEpoch: epochRecord })
  } catch (error) {
    // epoch 记账写不进去就不该继续用持久 worker：这次整理按失败回 pending，下窗重试。
    try { epochAbort.abort() } catch {}
    try { await ((handle?.agent) || handle)?.dispose?.() } catch {}
    epochDisposables.delete(forkId)
    return {
      ok: false, reasonCode: 'worker-epoch-unavailable', forkId, retired,
      error: 'the worker epoch could not be persisted: ' + String(error?.message || error),
    }
  }
  return {
    ok: true, forkId, handle,
    birth: true, reused: false, resumed: false, epoch: epochRecord, tools, restriction,
    epochAbort,
    retired, handoff,
  }
}

// —— 增量读取与缺口重建（§3.3）———————————————————————————————————————
/**
 * 本窗增量的唯一入口：turn-log 优先，缺口 rebuildRange 补，重建失败退回现场
 * condenseEvents（不写日志，本窗结算语义不变）。回合是不可分单位：返回整回合记录。
 *
 * 缺口按"可记录回合"判定（A3）：期望记录 = 宿主事件经 buildTurnRecords 能产出的整回合；
 * 心跳/纯注入回合本就不落行，它们的 seq 区间不是洞，不能拿裸 seq 全覆盖去卡——否则
 * 带心跳的会话每窗都误判缺口、永远退回现场压缩。consolidationTurnLog=off 时不读不写
 * 日志，直接现场压缩（A7，设计 §10.1）。
 */
export function loadWorkerIncrement({ sessionId, binding = null, window = null, events = [] } = {}) {
  const fromSeq = Number(window?.fromSeq)
  const throughSeq = Number(window?.throughSeq)
  if (!Number.isSafeInteger(fromSeq) || !Number.isSafeInteger(throughSeq) || throughSeq < fromSeq) {
    return { records: [], text: '', chars: 0, source: 'empty', digest: null }
  }
  const eventsInWindow = (Array.isArray(events) ? events : []).filter((event) => {
    const seq = Number(event?.seq)
    return Number.isSafeInteger(seq) && seq >= fromSeq && seq <= throughSeq
  })
  const condenseFallback = (why) => {
    let text = ''
    try { text = condenseEvents(eventsInWindow, WORKER_INCREMENT_FALLBACK_CHARS) || '' } catch { text = '' }
    return { records: [], text: String(text), chars: String(text).length, source: 'fallback', digest: why }
  }
  // A7：off 时不读不写日志，直接现场压缩。
  let turnLogOn = true
  try { turnLogOn = getSettings().consolidationTurnLog !== 'off' } catch { turnLogOn = true }
  if (!turnLogOn) return condenseFallback('现场压缩（turn-log 已关闭）')

  const lastSleepSeq = Number(binding?.lastSleepSeq)
  const after = Number.isSafeInteger(lastSleepSeq) && lastSleepSeq >= 0 ? lastSleepSeq : -1
  const expected = buildTurnRecords(eventsInWindow)
  const logRows = () => { try { return readIncrement(sessionId, -1).records || [] } catch { return [] } }
  const covers = (rows, rec) => rows.some((row) => {
    const s = Number(row?.seq?.[0])
    const e = Number(row?.seq?.[1])
    return Number.isSafeInteger(s) && Number.isSafeInteger(e) && s <= rec.seq[0] && e >= rec.seq[1]
  })
  let source = 'turn-log'
  let rows = logRows()
  let missing = expected.filter((rec) => !covers(rows, rec))
  if (missing.length > 0) {
    try { rebuildRange(sessionId, fromSeq, throughSeq, events) } catch {}
    rows = logRows()
    missing = expected.filter((rec) => !covers(rows, rec))
    if (missing.length > 0) return condenseFallback('现场压缩（turn-log 缺口重建失败）')
    source = 'rebuilt'
  } else if (expected.length === 0 && eventsInWindow.length > 0) {
    // 没有可记录的闭合回合、日志也没覆盖：可能是开回合/裸转录，现场压缩兜底，
    // 避免把有内容的区间喂成空增量。
    const inWindow = rows.filter((row) => {
      const s = Number(row?.seq?.[0])
      const e = Number(row?.seq?.[1])
      return Number.isSafeInteger(s) && Number.isSafeInteger(e) && e > after && s <= throughSeq
    })
    if (inWindow.length === 0) return condenseFallback('现场压缩（无可记录回合）')
  }
  // 增量 = 尚未完整结算的整回合（seqEnd > lastSleepSeq）且起点在本窗内。窗口已在
  // worker 模式对齐到整回合边界（A5），正常不会有跨骑记录；此处仍按整回合过滤兜底。
  const records = rows.filter((row) => {
    const start = Number(row?.seq?.[0])
    const end = Number(row?.seq?.[1])
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > after && start <= throughSeq
  })
  const text = records.map((row) => JSON.stringify(row)).join('\n')
  const first = records.length > 0 ? Number(records[0]?.seq?.[0]) : null
  const last = records.length > 0 ? Number(records[records.length - 1]?.seq?.[1]) : null
  const digest = records.length > 0
    ? `${records.length} 回合 · seq ${first}–${last}${source === 'rebuilt' ? ' · 缺口重建' : ''}`
    : null
  return { records, text, chars: text.length, source, digest }
}

// —— 包组装（§4.2 续窗增量包 / §5.1 初生·交接包）——————————————————————————

const PENDING_OPEN = '--- 待处理回合 ---'
const PENDING_CLOSE = '--- 结束 ---'
const TAIL_OPEN = '--- 已结算参考（勿为其写新记忆，只处理待处理区间）---'
const TAIL_CLOSE = '--- 已结算参考结束 ---'

function renderRecords(records) {
  return (Array.isArray(records) ? records : []).map((row) => JSON.stringify(row)).join('\n')
}

function pendingNoteLine(pendingNote, pendingHash) {
  if (!pendingNote) return ''
  if (typeof pendingNote === 'string' && pendingNote.trim()) return pendingNote
  const prefix = typeof pendingHash === 'string' && pendingHash ? `（${pendingHash.slice(0, 12)}…）` : ''
  return `[上窗未结算${prefix}] 上一窗${prefix}未结算完成：先核对库内是否已写入，勿重复写；本包与上一窗是同一段待处理区间的重发，重复写入会被去重拦下，但请先核对再动手。`
}

function catalogTextOf(catalog) {
  if (!catalog) return ''
  if (typeof catalog === 'string') return catalog.trim()
  const blocks = Array.isArray(catalog?.data?.content) ? catalog.data.content : []
  return blocks.map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : '')).filter(Boolean).join('\n').trim()
}

function catalogIdsOf(catalogText) {
  const ids = new Set()
  for (const match of String(catalogText || '').matchAll(/^- \[([^\]\n]+)\]/gm)) ids.add(match[1])
  return ids
}

/** 必写候选（续窗包）：顺延候选 ≤4、总数 ≤8 的双闸在这里再兜一道（mergeMustCover 同语义）。 */
function renderCarry(rows, { max = 8, carriedMax = 4 } = {}) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) return ''
  const lines = ['[必写候选（先写这些；每条都必须落库，或在失败说明里写明为什么不写，不得静默跳过）]']
  let carried = 0
  let shown = 0
  for (const row of list) {
    if (shown >= Math.max(1, Number(max) || 8)) break
    const isCarried = row?.carried === true
    if (isCarried && carried >= Math.max(0, Number(carriedMax) || 0)) continue
    if (isCarried) carried += 1
    shown += 1
    const where = isCarried
      ? '顺延' + (row?.observedAt ? ' · 事件时间 ' + row.observedAt : '')
      : '第 ' + (Number.isSafeInteger(Number(row?.fromSeq)) ? row.fromSeq : '?') + '–'
        + (Number.isSafeInteger(Number(row?.throughSeq)) ? row.throughSeq : '?') + ' 条'
        + (row?.tag ? ' · ' + row.tag : '') + (row?.observedAt ? ' · 事件时间 ' + row.observedAt : '')
    lines.push(`${shown}. [${where}] ${String(row?.text || '').slice(0, 120)}`)
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

function sceneTimeLine(sceneTime) {
  const value = typeof sceneTime === 'string' ? sceneTime.trim() : ''
  if (!value) return ''
  return `[场景时间] ${value}（时间锚点：observed_at 与今天/明天/下周X 等相对日期按这个场景时间推算，不要用真实时钟。）`
}

/**
 * 已写入摘要（§4.2/§5.2）：账本 recordOperation 历史 → 最近 20 条 id+标题 +
 * 「另有 M 条均已在库」，与目录头按 id 去重。摘要只是省无效写入的成本优化，
 * 不是正确性防线（铁律 1：对账与库级去重兜底）。
 */
function writtenSummary(sessionId, binding, { writtenRows = null, writtenTotal = null, catalogIds = new Set(), limit = 20 } = {}) {
  let ids = []
  let total = null
  if (Array.isArray(writtenRows)) {
    ids = writtenRows.map((row) => String(row?.id || '')).filter(Boolean)
    total = Number.isSafeInteger(Number(writtenTotal)) ? Number(writtenTotal) : ids.length
  } else {
    let ops = []
    try { ops = Object.values(loadLedger().sessions?.[String(sessionId || '')]?.operations || {}) } catch { ops = [] }
    for (const op of ops.slice().sort((a, b) => String(b?.at || '').localeCompare(String(a?.at || '')))) {
      for (const id of Array.isArray(op?.ids) ? op.ids : []) {
        const key = String(id || '')
        if (key && !ids.includes(key)) ids.push(key)
      }
    }
    total = ids.length
  }
  const deduped = ids.filter((id) => !catalogIds.has(id))
  const shown = deduped.slice(0, Math.max(1, Number(limit) || 20))
  if (shown.length === 0) return ''
  const titles = new Map()
  if (Array.isArray(writtenRows)) {
    for (const row of writtenRows) titles.set(String(row?.id || ''), String(row?.title || '(untitled)').slice(0, 80))
  } else {
    try {
      const entries = loadPrivateIndex(binding?.libraryId)?.entries || {}
      for (const id of shown) titles.set(id, String(entries[id]?.title || '(untitled)').slice(0, 80))
    } catch { /* 索引缺失只降级标题，摘要照发 */ }
  }
  const lines = ['[已写入摘要（账本记录，防重复写；目录里已有的不再列出）]']
  for (const id of shown) lines.push(`- [${id}] ${titles.get(id) || '(untitled)'}`)
  const rest = Math.max(0, (Number(total) || deduped.length) - shown.length)
  if (rest > 0) lines.push(`另有 ${rest} 条均已在库。`)
  return lines.join('\n')
}

/** 交接尾部（§5.2）：tailSlice 整回合取尾，再滤掉未结算段（seqEnd ≤ lastSleepSeq）。 */
function tailSection(sessionId, { lastSleepSeq = null, tailChars = WORKER_HANDOFF_TAIL_CHARS } = {}) {
  const ceiling = Number.isSafeInteger(Number(lastSleepSeq)) && Number(lastSleepSeq) >= 0 ? Number(lastSleepSeq) : null
  // 没有结算游标 = 整份日志都是未结算增量，没有「已结算参考」可带（尾部会与增量整段重复）。
  if (ceiling === null) return ''
  let slice = null
  try { slice = tailSlice(sessionId, tailChars) } catch { return '' }
  const records = (Array.isArray(slice?.records) ? slice.records : []).filter((row) => {
    const end = Number(row?.seq?.[1])
    return Number.isSafeInteger(end) && end <= ceiling
  })
  if (records.length === 0) return ''
  return [TAIL_OPEN, renderRecords(records), TAIL_CLOSE].join('\n')
}

/**
 * 续窗增量包（§4.2）：分隔标记夹住的待处理回合 + 目录头（每窗都发）+ 必写候选
 * （顺延 ≤4）+ 回执契约 + 场景时间（每窗重读）。已写入摘要不发（worker 上下文里
 * 刚写过，续窗发是冗余）；上一窗未结算时开头带核对说明（§4.4）。
 */
export function buildIncrementPack({
  binding = null, incrementRecords = [], incrementText = null, catalog = null,
  digest = null, carry = [], contract = '', sceneTime = null,
  pendingNote = false, pendingHash = null, carryMax = 4,
} = {}) {
  const sections = []
  const note = pendingNoteLine(pendingNote, pendingHash)
  if (note) sections.push(note)
  if (digest) sections.push('[待处理增量] ' + String(digest))
  sections.push(PENDING_OPEN)
  const body = (typeof incrementText === 'string' && incrementText.trim()) ? incrementText : renderRecords(incrementRecords)
  sections.push(body || '（本窗没有可读的回合记录）')
  sections.push(PENDING_CLOSE)
  const catalogText = catalogTextOf(catalog)
  if (catalogText) sections.push(catalogText)
  const carryText = renderCarry(carry, { carriedMax: carryMax })
  if (carryText) sections.push(carryText)
  if (typeof contract === 'string' && contract.trim()) sections.push(contract)
  const sceneLine = sceneTimeLine(sceneTime)
  if (sceneLine) sections.push(sceneLine)
  return sections.join('\n')
}

/**
 * 初生包 = 交接包（§5.1）：身份/规则任务书（buildWorkerBrief，必写候选随它下发）+
 * 待处理回合 + 库目录头 + 已写入摘要（最近 20 条 + 计数，与目录去重）+ turn-log 尾部
 * （标注「已结算参考」，滤掉未结算段）+ 场景时间。退役原因 scope-change / failure 时
 * 由调用方传 includeTail: false / writtenRows: []——「不做 handoff」= 不带旧 epoch 的
 * 连续性材料，身份与目录照发。
 */
export function buildHandoffPack({
  sessionId = null, binding = null, snapshot = null, probe = null, jobId = null,
  reason = 'auto', singleOnly = false, mustCover = [], contract = '',
  incrementRecords = [], incrementText = null, digest = null,
  catalog = null, sceneTime = null, pendingNote = false, pendingHash = null,
  writtenRows = null, writtenTotal = null,
  lastSleepSeq = null, tailChars = WORKER_HANDOFF_TAIL_CHARS, includeTail = true,
} = {}) {
  const brief = buildWorkerBrief({ snapshot, probe, contract, reason, jobId, mustCover, autoReceipt: true, singleOnly })
  const sections = [brief]
  const note = pendingNoteLine(pendingNote, pendingHash)
  if (note) sections.push(note)
  if (digest) sections.push('[待处理增量] ' + String(digest))
  sections.push(PENDING_OPEN)
  const body = (typeof incrementText === 'string' && incrementText.trim()) ? incrementText : renderRecords(incrementRecords)
  sections.push(body || '（本窗没有可读的回合记录）')
  sections.push(PENDING_CLOSE)
  const catalogText = catalogTextOf(catalog)
  if (catalogText) sections.push(catalogText)
  const summary = writtenSummary(sessionId, binding, { writtenRows, writtenTotal, catalogIds: catalogIdsOf(catalogText) })
  if (summary) sections.push(summary)
  if (includeTail !== false && sessionId) {
    const tail = tailSection(sessionId, { lastSleepSeq, tailChars })
    if (tail) sections.push(tail)
  }
  const sceneLine = sceneTimeLine(sceneTime)
  if (sceneLine) sections.push(sceneLine)
  return sections.join('\n')
}

export default {
  WORKER_EPOCH_TIERS, WORKER_OUTPUT_FACTOR, WORKER_EPOCH_IDLE_TTL_MS, WORKER_HANDOFF_TAIL_CHARS,
  WORKER_TIMEOUT_LIMIT, WORKER_RETIRE_IDLE_WAIT_MS, WORKER_INCREMENT_FALLBACK_CHARS,
  epochBudget, budgetFit, probeModelMaxContext, attachWorkerTools, restrictWorkerTools,
  retireWorker, recordEpochProgress, acquireWorker, loadWorkerIncrement, buildIncrementPack, buildHandoffPack,
}
