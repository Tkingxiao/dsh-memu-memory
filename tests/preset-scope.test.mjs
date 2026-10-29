import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Attach tests use fake agents/fiber and never touch the real host. The temp home is
// still set so any incidental state read/write from the attached listeners stays in
// os.tmpdir(), matching the rest of the suite.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-preset-'))
process.env.DSH_MEMU_HOME = home

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

import { attachPresetAgents, registerPresetAttachment, sameScopeTree } from '../lib/preset-scope.js'

// CORDIS FIBERS
// =============
// The host instance of this plugin registers its pre-step listener on the host
// composition's context. A conversation whose preset lists its own plugins lives in a
// separate fiber tree, so that listener never fires and the conversation gets no memory.
// `sameScopeTree` is the whole guard against the opposite mistake — attaching a second
// listener to a conversation the host one already covers, which would inject twice.

function fiber(parent = null) {
  const node = { parent: parent ? { fiber: parent } : null }
  node.parent = parent ? { fiber: parent } : { fiber: node }
  return node
}

function chain(...nodes) {
  for (let i = 0; i < nodes.length - 1; i += 1) nodes[i].parent = { fiber: nodes[i + 1] }
  const last = nodes[nodes.length - 1]
  last.parent = { fiber: last }
  return nodes[0]
}

function fakeCtx({ agents = null, fiber: ownFiber = null, logger = null } = {}) {
  const handlers = []
  const injected = []
  return {
    fiber: ownFiber,
    logger,
    injected,
    inject(...args) {
      injected.push(args)
    },
    get(name) {
      if (name === 'agents') return agents
      return undefined
    },
    on(event, fn) {
      handlers.push({ event, fn })
      return () => {
        const index = handlers.findIndex((entry) => entry.fn === fn)
        if (index >= 0) handlers.splice(index, 1)
      }
    },
    handlers,
  }
}

function fakeAgents(list) {
  return { list: () => list.slice() }
}

test('an agent inside our own fiber chain is already covered', () => {
  const host = fiber()
  const child = fiber(host)
  assert.equal(sameScopeTree({ fiber: child }, { fiber: host }), true)
})

test('an agent in a sibling tree is not covered', () => {
  const host = fiber()
  const presetRoot = fiber()
  assert.equal(sameScopeTree({ fiber: presetRoot }, { fiber: host }), false)
})

test('a missing fiber on either side is "unknown", never "covered"', () => {
  assert.equal(sameScopeTree({}, { fiber: fiber() }), false)
  assert.equal(sameScopeTree({ fiber: fiber() }, {}), false)
  assert.equal(sameScopeTree(undefined, undefined), false)
})

test('a deep chain terminates and finds the host fiber', () => {
  const host = fiber()
  const deep = chain(fiber(), fiber(), fiber(), host)
  assert.equal(sameScopeTree({ fiber: deep }, { fiber: host }), true)
})

test('only preset conversations get attached, and only once', () => {
  const host = fiber()
  const presetAgent = fakeCtx({ fiber: fiber() })
  const normalAgent = fakeCtx({ fiber: fiber(host) })
  const logs = []
  const agents = fakeAgents([
    { ctx: presetAgent, session: { header: { id: 'preset-1', origin: 'main' } } },
    { ctx: normalAgent, session: { header: { id: 'normal-1', origin: 'main' } } },
  ])
  const ctx = fakeCtx({ agents, fiber: host, logger: { warn: (m) => logs.push(m) } })

  assert.equal(attachPresetAgents(ctx, { log: (m) => logs.push(m) }), 1)
  assert.equal(presetAgent.handlers.filter((entry) => entry.event === 'agent/pre-step').length, 1)
  assert.equal(normalAgent.handlers.length, 0)

  // Second pass over the same registry must not stack a second listener.
  assert.equal(attachPresetAgents(ctx, { log: (m) => logs.push(m) }), 0)
  assert.equal(presetAgent.handlers.filter((entry) => entry.event === 'agent/pre-step').length, 1)

  assert.ok(logs.some((line) => line.includes('attached memory injection to preset conversation preset-1')))
})

test('subagents and agents without a context are left alone, with a signal', () => {
  const host = fiber()
  const subAgent = fakeCtx({ fiber: fiber() })
  const logs = []
  const agents = fakeAgents([
    { ctx: subAgent, session: { header: { id: 'sub-1', origin: 'subagent' } } },
    { session: { header: { id: 'no-ctx', origin: 'main' } } },
  ])
  const ctx = fakeCtx({ agents, fiber: host, logger: { warn: (line) => logs.push(String(line)) } })
  assert.equal(attachPresetAgents(ctx, { log: (line) => logs.push(String(line)) }), 0)
  assert.equal(subAgent.handlers.length, 0)
  // Without this line the adaptation fails exactly like "nothing happened".
  assert.ok(logs.some((line) => line.includes('agents.list() exposed no agent context')))
})

test('a conversation that goes away is detached', () => {
  const host = fiber()
  const presetAgent = fakeCtx({ fiber: fiber() })
  const live = [{ ctx: presetAgent, session: { header: { id: 'preset-1', origin: 'main' } } }]
  const ctx = fakeCtx({ agents: fakeAgents(live), fiber: host })
  assert.equal(attachPresetAgents(ctx), 1)
  assert.equal(presetAgent.handlers.length, 4)

  live.length = 0
  assert.equal(attachPresetAgents(ctx), 0)
  assert.equal(presetAgent.handlers.length, 0)
})

test('a host without an agents service is not an error', () => {
  const ctx = fakeCtx({ agents: null, fiber: fiber() })
  assert.equal(attachPresetAgents(ctx), 0)
})

test('the attach loop runs immediately and can be stopped', () => {
  const host = fiber()
  const presetAgent = fakeCtx({ fiber: fiber() })
  const ctx = fakeCtx({ agents: fakeAgents([{ ctx: presetAgent, session: { header: { id: 'p', origin: 'main' } } }]), fiber: host })
  const stop = registerPresetAttachment(ctx, { intervalMs: 60_000 })
  assert.equal(presetAgent.handlers.length, 4)
  stop()
  assert.equal(presetAgent.handlers.length, 0)
})

// agents.list() is documented in two shapes on the host: the registry record and a
// bare agent. A bare entry may still have the model-facing context on the record that
// agents.get() returns. All three shapes must attach to the same agent-owned context.
test('records, bare agents and agents.get() fallbacks all provide the attach context', () => {
  const host = fiber()
  const recordCtx = fakeCtx({ fiber: fiber() })
  const bareCtx = fakeCtx({ fiber: fiber() })
  const fallbackCtx = fakeCtx({ fiber: fiber() })
  const live = [
    { ctx: recordCtx, session: { header: { id: 'record-1', origin: 'main' } } },
    { ctx: bareCtx, session: { header: { id: 'bare-1', origin: 'main' } } },
    { session: { header: { id: 'fallback-1', origin: 'main' } } },
  ]
  const agents = {
    list: () => live.slice(),
    get: (id) => (id === 'fallback-1' ? { ctx: fallbackCtx } : undefined),
  }
  const ctx = fakeCtx({ agents, fiber: host })
  assert.equal(attachPresetAgents(ctx), 3)
  for (const agentCtx of [recordCtx, bareCtx, fallbackCtx]) {
    assert.equal(agentCtx.handlers.filter((entry) => entry.event === 'agent/pre-step').length, 1)
    assert.deepEqual(agentCtx.injected, [], 'a preset gets the message path, not a system prompt section')
  }
})

// The plugin must not pretend that attaching an injection listener mounts tools. The
// tool surface is owned by the preset bundle: an explicitly listed preset has memu_*
// tools, an unlisted one has none. Both get the listener (the guide text tells the
// unlisted model to ignore the rules), and neither tool list is edited here.
test('the tool surface follows the preset bundle, while injection attaches to both', () => {
  const host = fiber()
  const listedCtx = fakeCtx({ fiber: fiber() })
  const unlistedCtx = fakeCtx({ fiber: fiber() })
  const listedTools = ['memu_private_recall', 'memu_private_remember', 'memu_status']
  const unlistedTools = ['bash', 'read_file']
  const live = [
    { ctx: listedCtx, session: { header: { id: 'listed-1', origin: 'main' } }, toolNames: listedTools.slice() },
    { ctx: unlistedCtx, session: { header: { id: 'unlisted-1', origin: 'main' } }, toolNames: unlistedTools.slice() },
  ]
  const ctx = fakeCtx({ agents: fakeAgents(live), fiber: host })
  assert.equal(attachPresetAgents(ctx), 2)
  assert.equal(listedCtx.handlers.filter((entry) => entry.event === 'agent/pre-step').length, 1)
  assert.equal(unlistedCtx.handlers.filter((entry) => entry.event === 'agent/pre-step').length, 1)
  assert.deepEqual(live[0].toolNames, listedTools, 'listing the plugin is what makes memu_* tools exist')
  assert.deepEqual(live[1].toolNames, unlistedTools, 'injection must not fabricate memu_* tools')
  assert.equal(live[1].toolNames.some((name) => name.startsWith('memu_')), false)
})

test('a throwing agents service is contained', () => {
  const ctx = fakeCtx({
    agents: { list() { throw new Error('registry unavailable') } },
    fiber: fiber(),
  })
  assert.equal(attachPresetAgents(ctx), 0)
})
