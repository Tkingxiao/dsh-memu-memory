// Task E: the settings pane used to hear only about writes made in this document,
// and only through a manual reload after a tool call or another window changed
// something. It now shares the sidebar's heartbeat — poll a two-field marker,
// refetch only when it moves, send nothing while hidden — and wakes immediately
// on the cross-window channel without echoing back. These cases drive the real
// SettingsPage with a fake hook runtime.
import test from 'node:test'
import assert from 'node:assert/strict'

const registrations = []

function makeElement(type, props, ...children) {
  return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }
}

let hooks = []
let cursor = 0
let effects = []

const React = {
  createElement: makeElement,
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const index = cursor++
    if (hooks[index] === undefined) hooks[index] = typeof initial === "function" ? initial() : initial
    return [hooks[index], (next) => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next }]
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useEffect(fn, deps) { effects.push({ fn, deps }) },
  useLayoutEffect() {},
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

const intervals = []
globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length }
globalThis.clearInterval = () => {}

const visibilityListeners = new Set()
globalThis.document = {
  visibilityState: 'visible',
  addEventListener(name, fn) { if (name === "visibilitychange") visibilityListeners.add(fn) },
  removeEventListener(name, fn) { if (name === "visibilitychange") visibilityListeners.delete(fn) },
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {}, click() {} }),
  querySelector: () => null,
  head: { appendChild() {} },
  body: { appendChild() {} },
}

// The channel is how another document announces a write. The fake records posts so
// the test can prove an inbound message is never re-announced.
const channels = []
class FakeChannel {
  constructor(name) { this.name = name; this.posted = []; channels.push(this) }
  postMessage(data) { this.posted.push(data) }
  unref() {}
  close() {}
}
globalThis.BroadcastChannel = FakeChannel

globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      globalThis.__dshMemuExports = factory((name) => {
        if (name === "react") return React
        throw new Error("unexpected require: " + name)
      })
    },
  },
  addEventListener() {},
  removeEventListener() {},
}

await import('../lib/client.js')

function makeSettingsState(server) {
  return {
    engine: { status: 'ready', versions: [], currentVersion: '0.11.0b3', recommendedVersion: '0.11.0b3', installed: true, state: {} },
    settings: { autoInject: 'smart', memoryBackend: 'agent', libraries: [] },
    memuConfig: { provider: 'openai' },
    summaryConfig: {},
    libraries: [],
    archivedLibraries: [],
    revision: server.revision,
    stamp: server.stamp,
  }
}

function makeCtx() {
  const calls = []
  const server = { revision: 1, stamp: 'state:10:1' }
  const call = async (_path, endpoint, payload) => {
    calls.push({ endpoint, payload })
    if (endpoint === 'getSettingsState') return { ok: true, value: makeSettingsState(server) }
    if (endpoint === 'getSidebarState') {
      if (payload?.revisionOnly === true) return { ok: true, value: { revision: server.revision, stamp: server.stamp } }
      return { ok: true, value: {} }
    }
    return { ok: true, value: {} }
  }
  const ctx = {
    effect: (fn) => { try { fn() } catch {} },
    locale: { register: () => () => {}, bind: () => (key) => key, get: () => 'zh' },
    connection: { rpc: { call } },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: {}, ids: [] }) } },
    get: () => undefined,
    slots: { inject: (_name, callback) => callback({}), register: (spec, component) => { registrations.push({ spec, component }); return () => {} } },
    inject: (_deps, callback) => callback({
      effect: (fn) => { try { fn() } catch {} },
      sidebarRightTabs: { register: () => () => {} },
      get: () => undefined,
    }),
  }
  return { ctx, calls, server }
}

const tick = async (times = 4) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
const settingsCalls = (calls) => calls.filter((c) => c.endpoint === 'getSettingsState')
const beatCalls = (calls) => calls.filter((c) => c.endpoint === 'getSidebarState')

async function paintSettings(api = globalThis.__dshMemuExports) {
  hooks = []
  cursor = 0
  effects = []
  intervals.length = 0
  visibilityListeners.clear()
  registrations.length = 0
  const harness = makeCtx()
  api.apply(harness.ctx)
  const registration = registrations.filter((r) => r.spec?.name === 'settings.section').at(-1)
  assert.ok(registration?.component, 'the settings section was not registered')
  const tree = registration.component({ ctx: harness.ctx, t: (key) => key })
  assert.ok(tree, 'the settings page rendered nothing')
  for (const effect of effects.slice()) effect.fn()
  await tick()
  return { ...harness, tree }
}

test('the settings pane arms one heartbeat and seeds it from its first paint', async () => {
  const page = await paintSettings()
  assert.equal(settingsCalls(page.calls).length, 1, 'the first paint is one fetch')
  assert.equal(intervals.length, 1, 'exactly one heartbeat interval is armed on the settings page')
  assert.ok(intervals[0].ms > 0 && intervals[0].ms <= 5000, 'the beat is seconds apart, not minutes')
  assert.equal(visibilityListeners.size, 1, 'returning to the window is listened for')

  // The first beat must compare against the revision/stamp that came with the
  // paint. If the paint did not seed the marker, this would refetch needlessly.
  await intervals[0].fn()
  await tick()
  assert.equal(beatCalls(page.calls).length, 1, 'one cheap beat was sent')
  assert.equal(settingsCalls(page.calls).length, 1, 'an unchanged marker does not refetch')
  const beat = beatCalls(page.calls).at(-1)
  assert.deepEqual(Object.keys(beat.payload).sort(), ['revisionOnly'], 'the beat stays a bare marker')
})

test('a settings write from another window lands within one beat', async () => {
  const page = await paintSettings()
  // Exactly what an out-of-process write looks like here: settings live in
  // state.json, so only the on-disk stamp moves; this process's counter stands still.
  page.server.stamp = 'state:11:1'
  await intervals[0].fn()
  await tick()
  assert.equal(page.server.revision, 1, 'the in-process counter deliberately did not move')
  assert.equal(settingsCalls(page.calls).length, 2, 'the stamp alone must trigger a refetch')
})

test('a channel message wakes the pane immediately and is never echoed back', async () => {
  const page = await paintSettings()
  const channel = channels.at(-1)
  assert.ok(channel, 'the client listens on the shared channel')

  channel.onmessage({ data: { type: 'memory-write', kind: 'settings', libraryId: null, at: new Date().toISOString() } })
  await tick()
  assert.equal(settingsCalls(page.calls).length, 2, 'an announced write refetches without waiting for a beat')
  assert.equal(channel.posted.length, 0, 'the receiver must not announce the write again')
})

test('a hidden pane sends no beats, and coming back refetches once', async () => {
  const page = await paintSettings()
  await intervals[0].fn()
  await tick()
  assert.equal(beatCalls(page.calls).length, 1, 'the visible pane polls')

  globalThis.document.visibilityState = 'hidden'
  await intervals[0].fn()
  await tick()
  assert.equal(beatCalls(page.calls).length, 1, 'a hidden pane sends no beats at all')
  for (const listener of visibilityListeners) listener()
  await tick()
  assert.equal(settingsCalls(page.calls).length, 1, 'a hidden pane does not refetch on the event either')

  globalThis.document.visibilityState = 'visible'
  for (const listener of visibilityListeners) listener()
  await tick()
  assert.equal(settingsCalls(page.calls).length, 2, 'returning to the window refetches')
})

test('without BroadcastChannel the heartbeat alone keeps the pane honest', async () => {
  // Host differences are not defects: a blocked channel must degrade to the beat,
  // not throw or silently stop syncing (TASKS E, acceptance 3).
  const saved = globalThis.BroadcastChannel
  const savedApi = globalThis.__dshMemuExports
  try {
    globalThis.BroadcastChannel = undefined
    await import('../lib/client.js?nochannel')
    const api = globalThis.__dshMemuExports
    assert.notEqual(api, savedApi, 'a fresh module instance was loaded')

    const page = await paintSettings(api)
    page.server.stamp = 'state:12:1'
    await intervals[0].fn()
    await tick()
    assert.equal(settingsCalls(page.calls).length, 2, 'the beat still hears the write')
  } finally {
    globalThis.BroadcastChannel = saved
    globalThis.__dshMemuExports = savedApi
  }
})
