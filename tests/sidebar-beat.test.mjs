// The sidebar heartbeat used to compare an in-process counter. A write served by a
// different module instance — the model calling memu_private_remember mid-turn, a
// curator job, a second window — moved the index on disk but never the counter, so
// the panel sat stale until someone pressed Refresh by hand. These cases drive the
// real MemoryTab with a fake hook runtime and prove the panel now refetches when
// only the on-disk stamp moved.
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

// setInterval is the heartbeat itself: the test keeps the callback and fires it by hand,
// so no fake clock and no real 2.5s wait.
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
const SNAPSHOT = {
  binding: { sessionId: 'beat-session', libraryId: 'lib-1', useLibrary: true, useGlobal: true, scopeKey: 'demo' },
  domain: 'coding',
  folder: { scopeKey: 'demo', useLibrary: true, useGlobal: true },
  effective: { useLibrary: true, useGlobal: true, enabled: true, folder: { scopeKey: 'demo', useLibrary: true, useGlobal: true } },
  private: { items: [], active: 0, pinned: 0, total: 0 },
  global: { items: [], active: 0, total: 0 },
  domains: ['rp', 'coding'],
}

// The mock server answers the beat and the full read separately, and the test can
// move the stamp without touching the counter — exactly the out-of-process write
// the old heartbeat was blind to.
function makeCtx() {
  const calls = []
  const server = { revision: 1, stamp: 'state:10:1|index-a' }
  const call = async (_path, endpoint, payload) => {
    calls.push({ endpoint, payload })
    if (endpoint === 'getSidebarState') {
      if (payload?.revisionOnly === true) return { ok: true, value: { revision: server.revision, stamp: server.stamp } }
      return { ok: true, value: { ...SNAPSHOT, revision: server.revision, stamp: server.stamp } }
    }
    return { ok: true, value: {} }
  }
  const ctx = {
    effect: (fn) => { try { fn() } catch {} },
    locale: { register: () => () => {}, bind: () => (key) => key, get: () => 'zh' },
    connection: { rpc: { call } },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: {}, ids: [] }) } },
    get: (name) => (name === 'uiSession'
      ? { adapter: { current: { getSnapshot: () => ({ key: 'beat-session' }), subscribe: () => () => {} } } }
      : (name === 'sidebarRight' ? undefined : undefined)),
    slots: { inject: (_name, callback) => callback({}), register: (spec, component) => { registrations.push({ spec, component }); return () => {} } },
    // The plugin registers the tab inside inject(): the scope has to run effects now,
    // or the registration never happens and there is nothing to mount.
    inject: (_deps, callback) => callback({
      effect: (fn) => { try { fn() } catch {} },
      sidebarRightTabs: { register: () => () => {} },
      get: () => undefined,
    }),
  }
  return { ctx, calls, server }
}

const fullCalls = (calls) => calls.filter((c) => c.endpoint === 'getSidebarState' && c.payload?.revisionOnly !== true)
const beatCalls = (calls) => calls.filter((c) => c.payload?.revisionOnly === true)

async function mountTab() {
  const harness = makeCtx()
  globalThis.__dshMemuExports.apply(harness.ctx)
  // A later paint must not reuse an earlier mount's registration: its ctx owns a
  // different call log, and the assertions would silently read the wrong one.
  const registration = registrations.filter((r) => r.spec?.name === 'sidebar.right.pane.tab').at(-1)
  assert.ok(registration?.component, 'the memory tab was not registered into the sidebar slot')
  return { component: registration.component, ...harness }
}

function expand(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 200) return
  if (Array.isArray(node)) { for (const child of node) expand(child, depth + 1); return }
  if (typeof node.type === 'function') { expand(node.type(node.props), depth + 1); return }
  expand(node.props?.children, depth + 1)
}

const tick = async (times = 3) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

// Mount, run every effect the tab registered (mount fetch, write listener,
// heartbeat, visibility listener), and let the first fetch settle.
async function paintTab() {
  hooks = []
  cursor = 0
  effects = []
  intervals.length = 0
  visibilityListeners.clear()
  registrations.length = 0
  const tab = await mountTab()
  // The registered body is one wrapper element around MemoryTab; function components
  // are not executed by createElement, so the tree has to be walked for the hooks and
  // effects to exist at all.
  expand(tab.component({ ctx: tab.ctx, t: (key) => key, sessionId: 'beat-session' }))
  const started = effects.slice()
  for (const effect of started) effect.fn()
  await tick()
  return { ...tab, started }
}

test('mounting paints once and arms exactly one heartbeat', async () => {
  const tab = await paintTab()
  assert.equal(fullCalls(tab.calls).length, 1, 'the panel fetches the first screen once on mount')
  // 两个定时器：记忆心跳（秒级）+ 整理提醒的慢轮询（20s，跨会话失败提醒的数据源）。
  // 真正的 beat 只允许有一个，且必须是秒级。
  assert.equal(intervals.length, 2, 'the beat plus the consolidation-feed poll, nothing else')
  assert.equal(intervals.filter(interval => interval.ms <= 5000).length, 1, 'exactly one short heartbeat interval is armed')
  assert.equal(intervals[0].ms, Math.min(...intervals.map(interval => interval.ms)), 'the beat is the first timer, so intervals[0] targets it')
  assert.ok(intervals[0].ms > 0 && intervals[0].ms <= 5000, 'the beat is seconds apart, not minutes')
  assert.equal(visibilityListeners.size, 1, 'returning to the window is listened for')
})

test('an unchanged marker does not refetch', async () => {
  const tab = await paintTab()
  await intervals[0].fn()
  await tick()
  assert.equal(beatCalls(tab.calls).length, 1, 'one cheap beat was sent')
  assert.equal(fullCalls(tab.calls).length, 1, 'nothing moved, so nothing was refetched')
})

// The regression this file exists for: another process saved the index. The counter
// this process holds does not move, only the on-disk stamp does.
test('a stamp-only change refetches, even when the counter stands still', async () => {
  const tab = await paintTab()
  tab.server.stamp = 'state:10:1|index-a:bumped'
  await intervals[0].fn()
  await tick()
  assert.equal(tab.server.revision, 1, 'the in-process counter deliberately did not move')
  assert.equal(fullCalls(tab.calls).length, 2, 'the panel must refetch on the stamp alone')
  const last = fullCalls(tab.calls).at(-1)
  assert.equal(last.payload.revisionOnly, undefined, 'the refetch is the full first screen')
})

test('a counter move still refetches, and the beat carries no entries', async () => {
  const tab = await paintTab()
  tab.server.revision = 2
  await intervals[0].fn()
  await tick()
  assert.equal(fullCalls(tab.calls).length, 2, 'a new revision must still refetch')
  const beat = beatCalls(tab.calls).at(-1)
  assert.deepEqual(Object.keys(beat.payload).sort(), ['revisionOnly'], 'the beat stays a bare marker')
})

test('becoming visible refetches once, and a hidden panel does not', async () => {
  const tab = await paintTab()
  for (const listener of visibilityListeners) listener()
  await tick()
  assert.equal(fullCalls(tab.calls).length, 2, 'returning to the window refetches')

  globalThis.document.visibilityState = 'hidden'
  await intervals[0].fn()
  await tick()
  assert.equal(beatCalls(tab.calls).length, 0, 'a hidden panel sends no beats at all')
  for (const listener of visibilityListeners) listener()
  await tick()
  assert.equal(fullCalls(tab.calls).length, 2, 'a hidden panel does not refetch on the event either')
  globalThis.document.visibilityState = 'visible'
})
