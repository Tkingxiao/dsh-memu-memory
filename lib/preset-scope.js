// Preset conversations (an `agentPreset` whose cordis.yml lists its own model-facing
// plugins) live in a scope subtree the host composition cannot see: `agent/pre-step`
// never reaches the host-level listener, so no binding is ever created and the memory
// anchor never appears. Nothing in the host API lets a plugin append rows to someone
// else's preset, so the only way in is the agent's *own* context — the same object the
// runtime hands to `agents.get(id)?.ctx`.
//
// The trap is double injection: for a normal conversation the host-level listener
// already covers it, and attaching again on the agent ctx would inject twice. The test
// is structural, not aesthetic — walk the agent's fiber chain and ask whether our own
// fiber is in it. Same tree means "already covered; do not attach".

import { registerInjection } from './inject.js'

export const ATTACH_MS = 10_000

// One registry per process: attachPresetAgents must see what previous passes attached,
// otherwise every tick would stack another listener. Keyed by agent context.
const attachments = new Map()
let warnedNoCtx = false

/**
 * True when `agentCtx` sits inside the caller's own scope tree — the case the host
 * listener already serves. Walks `fiber.parent.fiber`, stopping at the root.
 */
export function sameScopeTree(agentCtx, hostCtx) {
  let fiber = agentCtx?.fiber
  const own = hostCtx?.fiber
  if (!fiber || !own) return false
  for (let depth = 0; depth < 64; depth += 1) {
    if (fiber === own) return true
    const parent = fiber.parent?.fiber
    if (!parent || parent === fiber) return false
    fiber = parent
  }
  return false
}

/**
 * Attach the memory pre-step listener to every live conversation that the host
 * listener cannot see. Idempotent: one disposal per agent context, dropped when the
 * agent goes away.
 *
 * Returns the number of conversations newly attached this pass.
 */
export function attachPresetAgents(ctx, { log = () => {}, attached = attachments } = {}) {
  let agents
  try {
    agents = ctx.get('agents')
  } catch {
    return 0
  }
  if (!agents?.list) return 0
  let live = []
  try {
    live = agents.list() || []
  } catch {
    return 0
  }
  const seen = new Set()
  let added = 0
  let resolved = 0
  for (const raw of live) {
    // `agents.list()` may hand back bare agent objects or the registry's
    // `{ agent, owner, ctx }` records, and `agent.ctx` is only guaranteed on the
    // record. Accept both shapes instead of betting on one host version.
    const agent = raw?.agent && raw?.ctx ? raw.agent : raw
    const sessionId = agent?.session?.header?.id
    if (!sessionId) continue
    if (agent?.session?.header?.origin === 'subagent') continue
    const actx = raw?.ctx || agent?.ctx || (() => {
      try { return agents.get?.(sessionId)?.ctx } catch { return undefined }
    })()
    if (!actx) continue
    resolved += 1
    seen.add(actx)
    if (!attached.has(actx) && !sameScopeTree(actx, ctx)) {
      try {
        const dispose = registerInjection(actx)
        attached.set(actx, dispose)
        added += 1
        log(`attached memory injection to preset conversation ${sessionId}`)
      } catch (error) {
        log(`could not attach memory injection to ${sessionId}: ${error?.message || error}`)
      }
    }
  }
  for (const [key, dispose] of attached.entries()) {
    if (seen.has(key)) continue
    try { dispose?.() } catch {}
    attached.delete(key)
  }
  // One quiet line the first time the host hands us agents without a context: without
  // it the whole adaptation fails silently and looks exactly like "nothing happened".
  if (live.length > 0 && resolved === 0 && !warnedNoCtx) {
    warnedNoCtx = true
    log('agents.list() exposed no agent context on this host; preset conversations cannot be attached')
  }
  return added
}

/** Start the attach loop; returns a disposer that stops it and detaches every agent. */
export function registerPresetAttachment(ctx, { log = () => {}, intervalMs = ATTACH_MS } = {}) {
  const attached = attachments
  const run = () => {
    try {
      attachPresetAgents(ctx, { log, attached })
    } catch (error) {
      log(`preset attachment pass failed: ${error?.message || error}`)
    }
  }
  run()
  const timer = setInterval(run, intervalMs)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    for (const [, dispose] of attached.entries()) {
      try { dispose?.() } catch {}
    }
  }
}
