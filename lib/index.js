import { registerTools } from './tools.js'
import { registerInjection } from './inject.js'
import { registerPresetAttachment } from './preset-scope.js'
import { registerRpc } from './rpc.js'
import { registerCycle } from './cycle.js'
import { syncPromptDefaults } from './prompts.js'
import { ensureEngine, engineStatus, ENGINE_VERSION } from './engine.js'
import { getSettings, getMemoryBackend, backupDatabases, flushState } from './state.js'
import { setWarnSink } from './paths.js'

export const name = 'dsh-memu-memory'
// `timer` backs ctx.interval, used by the idle/auto-curation sweep. Reading an
// injected service without declaring it throws at activation, so it is listed here.
export const inject = ['tools', 'timer']

const applied = new WeakSet()

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
