// The activation line is the only place that answers "is memory actually on" without
// a debugger, and the silent-recall bug (P0-1) would have been visible from it. It was
// written by hand into a doc as an acceptance step nobody could run, because the host
// keeps no log on disk. So the line is asserted here instead: apply() runs against a
// fake context and the message has to match the live settings, not a stale copy.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-activation-'))
process.env.DSH_MEMU_HOME = home

const plugin = await import('../lib/index.js')
const { ENGINE_VERSION } = await import('../lib/engine.js')
const { getSettings, getMemoryBackend } = await import('../lib/state.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function fakeCtx() {
  const info = []
  const warn = []
  const tools = []
  const disposers = []
  const handlers = []
  const scope = {
    effect(fn, _label) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    tools: { register(tool) { tools.push(tool); return () => {} } },
    webServer: { register() { return () => {} } },
    connection: { requestRejection: () => undefined },
    interval() { return 1 },
    // cordis event API: everything this plugin hangs off the agent loop arrives here.
    on(event, handler) { handlers.push({ event, handler }); return () => {} },
  }
  const ctx = {
    ...scope,
    logger: { info: (m) => info.push(m), warn: (m) => warn.push(m) },
    inject(_deps, callback) { callback(scope) },
  }
  return { ctx, info, warn, tools, disposers, handlers }
}
const LOADED = /^dsh-memu-memory: loaded \(engine (\S+)\) backend=(\S+) autoInject=(\S+) anchorTokens=(\d+) turnTokens=(\d+) mustRememberCap=(\d+) unpinBudget=(\d+)$/

test('the activation line reports the live configuration', () => {
  const { ctx, info, warn } = fakeCtx()
  plugin.apply(ctx)
  const line = info.find((message) => message.startsWith('dsh-memu-memory: loaded'))
  assert.ok(line, 'apply() must log the activation line')
  const match = LOADED.exec(line)
  assert.ok(match, 'the line must keep the shape the docs promise: ' + line)

  const settings = getSettings()
  assert.equal(match[1], ENGINE_VERSION, 'the engine version must be the one the code expects')
  assert.equal(match[2], getMemoryBackend(), 'the backend must be the live one')
  assert.equal(match[3], settings.autoInject)
  assert.equal(Number(match[4]), settings.anchorTokens, 'the budget is config, not a hard-coded number')
  assert.equal(Number(match[5]), settings.turnTokens)
  assert.equal(Number(match[6]), settings.mustRememberCap)
  assert.equal(Number(match[7]), settings.unpinBudgetPerSession)
  assert.equal(warn.filter((m) => m.includes('startup summary failed')).length, 0, 'the summary must not fall back to a warning')
})

test('a changed budget shows up in the next activation', async () => {
  const state = await import('../lib/state.js')
  state.updateSettings({ anchorTokens: 512, turnTokens: 320, mustRememberCap: 7 })
  try {
    const { ctx, info } = fakeCtx()
    plugin.apply(ctx)
    const match = LOADED.exec(info.find((message) => message.startsWith('dsh-memu-memory: loaded')))
    assert.equal(Number(match[4]), 512, 'the line reads the setting, so a tuning change is visible in the log')
    assert.equal(Number(match[5]), 320)
    assert.equal(Number(match[6]), 7)
  } finally {
    state.updateSettings({ anchorTokens: 800, turnTokens: 800, mustRememberCap: 12 })
  }
})

test('a second apply() on the same context warns instead of registering twice', () => {
  const { ctx, tools, warn } = fakeCtx()
  plugin.apply(ctx)
  const first = tools.length
  const infoAfterFirst = warn.length
  plugin.apply(ctx)
  assert.equal(tools.length, first, 'tools must not be registered twice')
  assert.ok(warn.slice(infoAfterFirst).some((m) => /already ran/.test(m)), 'the guard must say so')
})
