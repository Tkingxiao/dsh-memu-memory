import { registerTools } from './tools.js'
import { registerInjection } from './inject.js'
import { registerPresetAttachment } from './preset-scope.js'
import { registerRpc } from './rpc.js'
import { registerCycle } from './cycle.js'
import { syncPromptDefaults } from './prompts.js'
import { ensureEngine, engineStatus, ENGINE_VERSION } from './engine.js'
import { getSettings, getMemoryBackend, backupDatabases, flushState } from './state.js'
import { closeEmbeddingWorkers } from './local-embedding-manager.js'
import { bootstrapLocalVector } from './local-vector-service.js'
import { vectorStatus } from './vector-profile.js'
import { setWarnSink } from './paths.js'

export const name = 'dsh-memu-memory'
// `timer` backs ctx.interval, used by the idle/auto-curation sweep. Reading an
// injected service without declaring it throws at activation, so it is listed here.
export const inject = ['tools', 'timer']

const applied = new WeakSet()

// 首用引导（§14.13）：本地向量模式且已有（或待切换）受管模型时，启动后把受管运行时复用起来、
// 拉起 loopback worker 并健康检查 /v1/embeddings。这里不下载：没有确认的联网动作留给她在
// 设置页点按钮，启动路径只做 reuse + 健康检查。失败只 warn（召回照旧退词法）。
function startLocalVectorBootstrap(ctx) {
  try {
    if (getMemoryBackend() !== 'api') return
    if (getSettings().vectorSource !== 'local') return
    const state = vectorStatus()
    const catalogId = state?.active?.profile?.catalogId || state?.requested?.catalogId || null
    if (!catalogId) return
    const timer = setTimeout(() => {
      void bootstrapLocalVector({ confirmed: false }).then((ready) => {
        try { ctx.logger?.info?.(`dsh-memu-memory: managed local embedding runtime ready (${String(ready?.model || catalogId)} ${Number(ready?.dimension) || '?'}d)`) } catch {}
      }).catch((error) => {
        try { ctx.logger?.warn?.(`dsh-memu-memory: local embedding bootstrap skipped: ${error?.message || error}`) } catch {}
      })
    }, 2500)
    timer.unref?.()
  } catch (error) {
    try { ctx.logger?.warn?.(`dsh-memu-memory: local embedding bootstrap skipped: ${error?.message || error}`) } catch {}
  }
}

function startEngineBootstrap(ctx) {
  try {
    const settings = getSettings()
    // Local agent mode reads and writes the JSON index directly; installing a
    // Python/MemU runtime would only burn time and disk for nothing.
    if (getMemoryBackend() === 'agent') return
    if (settings.autoInstallEngine === false) return
    const status = engineStatus()
    if (status.status === 'ready' && status.current?.version === ENGINE_VERSION) return
    if (status.status === 'installing') return
    const timer = setTimeout(() => {
      void ensureEngine({ beforeSwitch: backupDatabases }).catch((error) => {
        try { ctx.logger?.warn?.(`dsh-memu-memory: engine bootstrap failed: ${error?.message || error}`) } catch {}
      })
    }, 1500)
    timer.unref?.()
  } catch (error) {
    try { ctx.logger?.warn?.(`dsh-memu-memory: engine bootstrap skipped: ${error?.message || error}`) } catch {}
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

  setWarnSink((message) => { try { ctx.logger?.warn?.(`dsh-memu-memory: ${message}`) } catch {} })

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
    startEngineBootstrap(ctx)
    startLocalVectorBootstrap(ctx)
  }

  // The embedding worker is a process-global singleton, so it outlives any single
  // acquire() and would keep a native session and a loopback port alive after this
  // instance is unloaded. Preset mounts share that same worker, so only the instance
  // that owns the process-global surfaces may close it. Recall degrades to lexical
  // afterwards instead of failing.
  if (!inPreset && typeof ctx.effect === 'function') {
    ctx.effect(() => () => { closeEmbeddingWorkers() }, 'dsh-memu-memory: embedding workers')
  }

  const disposeCycle = inPreset ? null : registerCycle(ctx, {
    log: (message) => { try { ctx.logger?.warn?.(`dsh-memu-memory: ${message}`) } catch {} },
  })
  if (disposeCycle && typeof ctx.effect === 'function') {
    ctx.effect(() => disposeCycle, 'dsh-memu-memory: cycle')
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
