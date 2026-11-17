// The new-session prompt is mounted through ReactDOM.createRoot, which the settings
// render harness leaves stubbed out — so its cards were never exercised by any test.
// It is also the one screen where a wrong default silently decides whether a whole
// conversation remembers anything, so it gets its own harness.
import test from 'node:test'
import assert from 'node:assert/strict'

const roots = []

function makeElement(type, props, ...children) {
  return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }
}

let hooks = []
let refs = []
let cursor = 0
let effects = []
const committedEffects = new Map()
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))

function commitEffects() {
  const scheduled = effects
  effects = []
  for (const { fn, deps, index } of scheduled) {
    const previous = committedEffects.get(index)
    if (sameDeps(previous?.deps, deps)) continue
    previous?.cleanup?.()
    committedEffects.set(index, { deps, cleanup: fn() })
  }
}

function unmount() {
  for (const effect of committedEffects.values()) effect.cleanup?.()
  committedEffects.clear()
}

test.afterEach(unmount)

const React = {
  createElement: makeElement,
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const index = cursor++
    if (hooks[index] === undefined) hooks[index] = typeof initial === 'function' ? initial() : initial
    return [hooks[index], (next) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next }]
  },
  useCallback(fn, deps) { return React.useMemo(() => fn, deps) },
  useMemo(fn, deps) {
    const index = cursor++
    if (!sameDeps(hooks[index]?.deps, deps)) hooks[index] = { deps, value: fn() }
    return hooks[index].value
  },
  useEffect(fn, deps) { effects.push({ fn, deps, index: cursor++ }) },
  useLayoutEffect() {},
  // Refs must survive re-renders like real React: the gate's decided/deferred/
  // failures refs span renders, and a fresh-object-per-render stub would make
  // every cross-render scenario (稍后 → 切走 → 回来) a false pass.
  useRef(value) {
    const index = cursor++
    if (refs[index] === undefined) refs[index] = { current: value }
    return refs[index]
  },
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

const reactDom = {
  createRoot(container) {
    const root = { container, element: null }
    root.render = (element) => { root.element = element; roots.push(root) }
    root.unmount = () => {}
    return root
  },
}

globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      globalThis.__dshMemuExports = factory((name) => {
        if (name === 'react') return React
        if (name === 'react-dom/client') return reactDom
        throw new Error('unexpected require: ' + name)
      })
    },
  },
  addEventListener() {},
  removeEventListener() {},
}
globalThis.document = {
  createElement: () => ({ style: {}, attrs: {}, setAttribute(n, v) { this.attrs[n] = v }, appendChild() {}, remove() {} }),
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
  head: { appendChild() {} },
  body: { append(node) { return node } },
}

await import('../lib/client.js')
// A folder that keeps both layers, with a library already sitting in it.
const OPEN_FOLDER = {
  binding: null,
  shouldPrompt: true,
  libraries: [{ id: 'lib-1', name: 'demo', scopeKey: '/ws/demo' }],
  domains: ['rp', 'coding', 'general', 'mixed'],
  folder: { scopeKey: '/ws/demo', useLibrary: true, useGlobal: true },
  settings: { newSessionPromptDismissed: false, newSessionDefault: 'both' },
}

function buildCtx(promptState, opts = {}) {
  // The live session/summary state the gate reads through the host stores.
  // Mutable so a test can walk the exact issue #2 path: 新建会话 → 稍后 → 切走 →
  // 再新建会话 (the host reuses the same blank session id; see ui-workspace
  // navigation.ts "New Session returns to that blank").
  const runtime = {
    current: opts.current || 'sess-1',
    sessions: opts.sessions || { 'sess-1': { cwd: '/ws/demo', blank: true, origin: 'user' } },
    failEndpoints: new Set(opts.failEndpoints || []),
    stateCalls: 0,
  }
  lastRuntime = runtime
  const snapshot = () => ({
    byId: Object.fromEntries(Object.entries(runtime.sessions).map(([id, value]) => [id, { ...value }])),
    ids: Object.keys(runtime.sessions),
  })
  const connection = {
    rpc: {
      call: async (_path, endpoint, payload) => {
        if (endpoint === 'getSessionPromptState') runtime.stateCalls++
        if (runtime.failEndpoints.has(endpoint)) throw new Error('rpc failed: ' + endpoint)
        if (endpoint === 'getSessionPromptState') {
          return { ok: true, value: typeof promptState === 'function' ? await promptState(payload) : promptState }
        }
        if (endpoint === 'initSession' || endpoint === 'setSessionScope' || endpoint === 'setDomain' || endpoint === 'logClientEvent') {
          calls.push({ endpoint, payload })
          return { ok: true, value: {} }
        }
        throw new Error('unexpected rpc: ' + endpoint)
      },
    },
  }
  // This is the scope the gate is mounted with; the host passes an injected
  // sub-scope that can still reach the session and the RPC connection.
  const gateScope = {
    get: (name) => (name === 'uiSession'
      ? { adapter: { current: { subscribe: () => () => {}, getSnapshot: () => ({ key: runtime.current }) } } }
      : undefined),
    sessions: { list: { subscribe: () => () => {}, getSnapshot: snapshot } },
    connection,
    effect: (fn) => { try { fn() } catch {} },
  }
  return {
    effect: (fn) => { try { fn() } catch {} },
    locale: { register: () => () => {}, bind: () => (key) => key, get: () => 'zh' },
    connection,
    sessions: gateScope.sessions,
    get: gateScope.get,
    slots: {
      inject: (_name, callback) => { callback && callback(gateScope) },
      register: () => () => {},
    },
    inject: (deps, callback) => { if (Array.isArray(deps) && deps.includes('sessions')) callback(gateScope) },
  }
}

const calls = []
let lastRuntime = null

function renderGate(promptState, opts) {
  unmount()
  hooks = []
  refs = []
  calls.length = 0
  lastRuntime = null
  cursor = 0
  effects = []
  roots.length = 0
  globalThis.__dshMemuExports.apply(buildCtx(promptState, opts))
  assert.equal(roots.length, 1, 'the new-session gate was not mounted at all')
  return roots[0].element
}

// First pass renders nothing (no prompt yet), the mount effect fetches the state,
// the second pass renders the dialog with whatever the effect decided.
async function settle(element) {
  const first = paint(element)
  await tick()
  await tick()
  return { first, tree: paint(element) }
}

function treeText(node, depth = 0) {
  if (node === null || node === undefined || depth > 400) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => treeText(child, depth + 1)).join(' ')
  if (typeof node.type === 'function') return treeText(node.type(node.props), depth + 1)
  return treeText(node.props?.children, depth + 1)
}

function walk(node, visit, depth = 0) {
  if (node === null || node === undefined || depth > 400) return
  if (Array.isArray(node)) { for (const child of node) walk(child, visit, depth + 1); return }
  if (typeof node !== 'object') return
  visit(node)
  if (typeof node.type === 'function') { walk(node.type(node.props), visit, depth + 1); return }
  walk(node.props?.children, visit, depth + 1)
}

function cardsOf(tree) {
  const cards = []
  walk(tree, (node) => { if (node.props?.role === 'radio') cards.push(node) })
  return cards
}
test('the new-session prompt is four cards with consequences, and waits before showing', async () => {
  const element = renderGate(OPEN_FOLDER)
  const { first, tree } = await settle(element)
  // Nothing is known yet on the first pass, so there must be no empty dialog
  // flashing on every new conversation.
  assert.equal(first, null, 'the gate painted before the session state arrived')

  const cards = cardsOf(tree)
  assert.equal(cards.length, 4, 'the prompt is four cards, not four checkboxes')
  const titles = cards.map((card) => treeText(card.props.children).trim())
  assert.ok(titles[0].includes('memOffTitle'), 'the no-memory card lost its title')
  assert.ok(titles[1].includes('memPrivateTitle'), 'the private card lost its title')
  assert.ok(titles[2].includes('memGlobalTitle'), 'the global card lost its title')
  assert.ok(titles[3].includes('memBothTitle'), 'the both card lost its title')
  // Every card carries what happens next, not just a label.
  assert.ok(titles[0].includes('memOffDesc') && titles[1].includes('memPrivateDesc'))
  assert.ok(titles[2].includes('memGlobalDesc') && titles[3].includes('memBothDesc'))
  assert.ok(!cards.some((card) => card.props.disabled), 'a permissive folder disabled a card')

  let dialog = null
  walk(tree, (node) => { if (node.props?.role === 'dialog') dialog = node })
  assert.ok(dialog, 'the prompt has no dialog semantics')
  assert.equal(dialog.props['aria-modal'], 'true')

  const text = treeText(tree)
  for (const key of ['memoryPromptBody', 'domain', 'domainPromptHint', 'advanced', 'chooseLibrary', 'createLibrary', 'rememberChoice', 'later', 'confirm']) {
    assert.ok(text.includes(key), 'the prompt lost ' + key)
  }
  // The dismissed flag is not set yet, so nothing was committed behind the user.
  assert.equal(calls.length, 0, 'the prompt wrote a decision before the user answered')
})

test('a folder that switched a layer off greys the cards that need it', async () => {
  const blocked = {
    ...OPEN_FOLDER,
    folder: { scopeKey: '/ws/demo', useLibrary: false, useGlobal: false },
  }
  const { tree } = await settle(renderGate(blocked))
  const cards = cardsOf(tree)
  assert.equal(cards.length, 4)
  assert.ok(!cards[0].props.disabled, 'the no-memory card was disabled by the folder')
  for (const card of cards.slice(1)) {
    assert.equal(card.props.disabled, true, 'a blocked layer stayed clickable')
    assert.ok(treeText(card.props.children).includes('memBlockedByFolder'), 'a disabled card did not say why')
  }
})

test('a folder with memory switched off binds silently instead of asking', async () => {
  const off = {
    ...OPEN_FOLDER,
    shouldPrompt: false,
    folder: { scopeKey: '/ws/demo', useLibrary: false, useGlobal: false },
  }
  const { tree } = await settle(renderGate(off))
  assert.equal(tree, null, 'the prompt appeared for a folder whose memory is off')
  assert.deepEqual(calls.map((call) => call.endpoint), ['initSession', 'setSessionScope'])
  assert.equal(calls[0].payload.createLibrary, false, 'a library was created for a folder with memory off')
  const scope = calls[1].payload
  assert.equal(scope.useLibrary, false)
  assert.equal(scope.useGlobal, false)
})
// ---- the card is the answer; the sidebar just draws it -----------------------
// A card names a pair of switches, and those two switches are exactly what the
// sidebar renders afterwards. Writing only one of them (or, as the confirm
// branch once did, only the library) let ensureSession fill the other from the
// folder policy — which is how "private memory only" came back with both boxes
// ticked. These cases hold the three ideas together: card, binding, sidebar.

const CARD_ANSWERS = [
  { key: 'memOffTitle', layers: { useLibrary: false, useGlobal: false }, createLibrary: false },
  { key: 'memPrivateTitle', layers: { useLibrary: true, useGlobal: false }, createLibrary: true },
  { key: 'memGlobalTitle', layers: { useLibrary: false, useGlobal: true }, createLibrary: false },
  { key: 'memBothTitle', layers: { useLibrary: true, useGlobal: true }, createLibrary: true },
]

function paint(element) {
  cursor = 0
  effects = []
  const tree = element.type(element.props)
  commitEffects()
  return tree
}

function findNode(tree, predicate) {
  let hit = null
  walk(tree, (node) => { if (!hit && predicate(node)) hit = node })
  return hit
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

async function answerCard(cardKey) {
  const element = renderGate(OPEN_FOLDER)
  const { tree } = await settle(element)
  const card = cardsOf(tree).find((node) => treeText(node.props.children).includes(cardKey))
  assert.ok(card, 'the prompt has no card ' + cardKey)
  card.props.onClick()
  const painted = paint(element)
  const confirm = findNode(painted, (node) => node.props?.key === 'ok' && typeof node.props.onClick === 'function')
  assert.ok(confirm, 'the prompt has no confirm button')
  assert.equal(confirm.props.disabled, false, 'confirm was disabled for ' + cardKey)
  await confirm.props.onClick()
  await tick()
  await tick()
}

for (const { key, layers, createLibrary } of CARD_ANSWERS) {
  test('answering ' + key + ' writes both switches, not just the library', async () => {
    await answerCard(key)
    assert.deepEqual(
      calls.map((call) => call.endpoint),
      ['initSession', 'setSessionScope', 'setDomain'],
      key + ' did not bind first, scope second, and domain last',
    )
    const init = calls[0].payload
    assert.equal(init.createLibrary, createLibrary, key + ' created the wrong library')
    const scope = calls[1].payload
    assert.equal(scope.useLibrary, layers.useLibrary, key + ' left the private switch to the folder policy')
    assert.equal(scope.useGlobal, layers.useGlobal, key + ' left the global switch to the folder policy')
    assert.equal(calls[2].payload.domain, 'rp', key + ' did not write the default domain')
  })
}

// The remembered answer has to mean the same thing as the card did. This branch
// used to write only the library (or only the layers), so the answer the user
// gave and the two boxes the sidebar drew could differ.
const REMEMBERED = [
  ['off', { useLibrary: false, useGlobal: false }, false],
  ['auto', { useLibrary: true, useGlobal: false }, true],
  ['global', { useLibrary: false, useGlobal: true }, false],
  ['both', { useLibrary: true, useGlobal: true }, true],
]

for (const [preference, layers, createLibrary] of REMEMBERED) {
  test('a remembered "' + preference + '" answer is applied as both switches', async () => {
    const dismissed = {
      ...OPEN_FOLDER,
      settings: { newSessionPromptDismissed: true, newSessionDefault: preference },
    }
    const { tree } = await settle(renderGate(dismissed))
    assert.equal(tree, null, 'a remembered answer still opened the prompt')
    assert.deepEqual(calls.map((call) => call.endpoint), ['initSession', 'setSessionScope'])
    assert.equal(calls[0].payload.createLibrary, createLibrary, preference + ' created the wrong library')
    assert.equal(calls[1].payload.useLibrary, layers.useLibrary, preference + ' lost its private switch')
    assert.equal(calls[1].payload.useGlobal, layers.useGlobal, preference + ' lost its global switch')
  })
}

test('the advanced library pick changes where memory lives, not which layers', async () => {
  const element = renderGate(OPEN_FOLDER)
  const { tree } = await settle(element)
  const card = cardsOf(tree).find((node) => treeText(node.props.children).includes('memPrivateTitle'))
  card.props.onClick()
  let painted = paint(element)
  const radios = []
  walk(painted, (node) => {
    if (node.props?.type === 'radio' && node.props?.name === 'memu-library') radios.push(node)
  })
  assert.equal(radios.length, 3, 'the advanced block lost its library radios')
  // "create a new library" with an empty name cannot be confirmed yet.
  radios[2].props.onChange({ target: { checked: true } })
  painted = paint(element)
  const blocked = findNode(painted, (node) => node.props?.key === 'ok')
  assert.equal(blocked.props.disabled, true, 'an empty library name was confirmable')
  // Pointing the private layer at the folder's existing library must keep the
  // card's answer intact — this is the click that used to erase it.
  radios[1].props.onChange({ target: { checked: true } })
  painted = paint(element)
  const confirm = findNode(painted, (node) => node.props?.key === 'ok')
  assert.equal(confirm.props.disabled, false, 'a chosen existing library could not be confirmed')
  await confirm.props.onClick()
  await tick()
  await tick()
  assert.equal(calls[0].payload.libraryId, 'lib-1', 'the picked library was not bound')
  assert.equal('createLibrary' in calls[0].payload, false, 'picking a library created another one')
  assert.equal(calls[1].payload.useLibrary, true, 'the pick overwrote the private switch')
  assert.equal(calls[1].payload.useGlobal, false, 'the pick turned the global layer back on')
  assert.equal(calls[2].payload.domain, 'rp', 'the library pick lost the domain')
})

// The domain selector is the point of this prompt: an RP workspace used for a
// coding session must not silently keep RP prompts and RP memory filtering.
test('the prompt defaults the domain to RP and can switch it to Coding', async () => {
  const element = renderGate(OPEN_FOLDER)
  const { tree } = await settle(element)
  const select = findNode(tree, (node) => node.type === 'select')
  assert.ok(select, 'the prompt has no domain selector')
  assert.equal(select.props.value, 'rp', 'the domain did not default to the binding default')
  assert.deepEqual(select.props.children.map((option) => option.props.value), ['rp', 'coding', 'general', 'mixed'])
  select.props.onChange({ target: { value: 'coding' } })
  const painted = paint(element)
  const confirm = findNode(painted, (node) => node.props?.key === 'ok')
  await confirm.props.onClick()
  await tick()
  await tick()
  assert.deepEqual(calls.map((call) => call.endpoint), ['initSession', 'setSessionScope', 'setDomain'])
  assert.equal(calls[2].payload.domain, 'coding', 'the selected Coding domain was not written')
})

// ---- issue #2: 新会话弹窗在「点稍后 → 再新建会话」后不再出现 ------------------
// The host's New Session reuses the same blank session (ui-workspace
// navigation.ts), so a 稍后 that answered forever meant the blank conversation
// could never be asked again — and its first message silently bound RP.

async function live(element) {
  return (await settle(element)).tree
}

test('稍后 keeps the blank session askable: stay quiet, then ask again on reopen', async () => {
  const element = renderGate(OPEN_FOLDER, {
    sessions: {
      'sess-0': { cwd: '/ws/demo', blank: false, origin: 'user' }, // 已有的普通会话
      'sess-1': { cwd: '/ws/demo', blank: true, origin: 'user' },  // 新建的空白会话
    },
  })
  const { tree } = await settle(element)
  assert.ok(tree, 'the prompt did not appear for a fresh blank session')

  const laterButton = findNode(tree, (node) => node.props?.key === 'later' && typeof node.props?.onClick === 'function')
  assert.ok(laterButton, 'the prompt has no Later button')
  await laterButton.props.onClick()

  // 还停在这个会话上（列表刷新等导致的重渲染）：不重复打扰。
  const stayed = await live(element)
  assert.equal(stayed, null, '稍后 must suppress re-asking while the user stays on the session')

  // 切回另一个已有会话（有内容，本来就终局不问）。
  lastRuntime.current = 'sess-0'
  await live(element)

  // 再点「新建会话」——宿主复用同一个空白会话 sess-1：必须重新弹窗（issue #2）。
  lastRuntime.current = 'sess-1'
  const again = await live(element)
  assert.ok(again, 'the prompt never came back after 稍后 + New Session reuse')
})

test('a failed check logs and retries after backoff without a list refresh', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const element = renderGate(OPEN_FOLDER, { failEndpoints: ['getSessionPromptState'] })
  assert.equal((await settle(element)).tree, null)
  assert.equal(lastRuntime.stateCalls, 1)
  assert.ok(calls.some((call) => call.endpoint === 'logClientEvent' && call.payload.kind === 'error'))
  lastRuntime.failEndpoints.clear()
  t.mock.timers.tick(999)
  assert.equal(await live(element), null)
  assert.equal(lastRuntime.stateCalls, 1)
  t.mock.timers.tick(1)
  assert.ok(await live(element))
  assert.equal(lastRuntime.stateCalls, 2)
})

test('three failures remain retryable and reopening bypasses the old backoff', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const element = renderGate(OPEN_FOLDER, { failEndpoints: ['getSessionPromptState'] })
  await settle(element)
  for (const delay of [1000, 2000]) { t.mock.timers.tick(delay); await live(element) }
  assert.equal(lastRuntime.stateCalls, 3)
  lastRuntime.sessions['sess-0'] = { cwd: '/ws/demo', blank: false, origin: 'user' }
  lastRuntime.current = 'sess-0'
  await live(element)
  lastRuntime.failEndpoints.clear()
  lastRuntime.current = 'sess-1'
  assert.ok(await live(element), 'reopening a recovered session must ask without a remount')
  assert.equal(lastRuntime.stateCalls, 4)
  assert.equal(calls.filter((call) => call.endpoint === 'logClientEvent').length, 3)
})

test('repeated failures back off up to thirty seconds instead of giving up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const element = renderGate(OPEN_FOLDER, { failEndpoints: ['getSessionPromptState'] })
  await settle(element)
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const before = lastRuntime.stateCalls
    lastRuntime.sessions['sess-1'] = { ...lastRuntime.sessions['sess-1'], title: String(before) }
    await live(element)
    t.mock.timers.tick(delay - 1)
    await live(element)
    assert.equal(lastRuntime.stateCalls, before, 'a list refresh bypassed backoff')
    t.mock.timers.tick(1)
    await live(element)
    assert.equal(lastRuntime.stateCalls, before + 1)
  }
  lastRuntime.failEndpoints.clear()
  t.mock.timers.tick(30000)
  assert.ok(await live(element), 'the still-mounted gate did not recover')
})

test('a failed silent init also retains its backoff across successful state reads', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const element = renderGate({ ...OPEN_FOLDER, shouldPrompt: false }, { failEndpoints: ['initSession'] })
  await settle(element)
  for (const delay of [1000, 2000]) { t.mock.timers.tick(delay); await live(element) }
  assert.equal(lastRuntime.stateCalls, 3)
  t.mock.timers.tick(3999)
  await live(element)
  assert.equal(lastRuntime.stateCalls, 3)
  lastRuntime.failEndpoints.clear()
  t.mock.timers.tick(1)
  assert.equal(await live(element), null)
  assert.equal(lastRuntime.stateCalls, 4)
  assert.equal(calls.filter((call) => call.endpoint === 'setSessionScope').length, 1)
})

test('switching away or unmounting cancels retry timers even when logging fails', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const element = renderGate(OPEN_FOLDER, { failEndpoints: ['getSessionPromptState', 'logClientEvent'] })
  await settle(element)
  lastRuntime.current = null
  await live(element)
  t.mock.timers.tick(60000)
  await tick()
  assert.equal(lastRuntime.stateCalls, 1)
  lastRuntime.current = 'sess-1'
  await live(element)
  assert.equal(lastRuntime.stateCalls, 2)
  unmount()
  t.mock.timers.tick(60000)
  await tick()
  assert.equal(lastRuntime.stateCalls, 2)
})

test('an implicit binding still asks on a blank session; a chosen one does not', async () => {
  const implicit = {
    ...OPEN_FOLDER,
    binding: { scopeKey: '/ws/demo', domainOverride: 'rp', domainSource: 'auto', useLibrary: true, useGlobal: true, libraryId: 'lib-1' },
  }
  const { tree } = await settle(renderGate(implicit))
  assert.ok(tree, 'an implicit (injection-path) binding silenced the prompt on a still-blank session')

  const chosen = { ...implicit, binding: { ...implicit.binding, domainSource: 'chosen' } }
  const { tree: chosenTree } = await settle(renderGate(chosen))
  assert.equal(chosenTree, null, 'an explicitly chosen binding was asked again')
})

test('a first message before cwd arrives does not lose the pending domain question', async () => {
  const implicit = { ...OPEN_FOLDER, binding: { scopeKey: '/ws/demo', domainOverride: 'coding', domainSource: 'auto' } }
  const element = renderGate(implicit, { sessions: { 'sess-1': { blank: true, origin: 'user' } } })
  assert.equal(await live(element), null)
  assert.equal(lastRuntime.stateCalls, 0)
  lastRuntime.sessions['sess-1'] = { cwd: '/ws/demo', blank: false, origin: 'user' }
  const tree = await live(element)
  assert.ok(tree, 'blank=false must not discard a new session that has not answered')
  assert.equal(lastRuntime.stateCalls, 1)
  findNode(tree, (node) => node.type === 'select').props.onChange({ target: { value: 'coding' } })
  await findNode(paint(element), (node) => node.props?.key === 'ok').props.onClick()
  assert.equal(calls.find((call) => call.endpoint === 'setDomain')?.payload.domain, 'coding')
})

for (const summary of [{ blank: false, origin: 'user' }, { blank: true, origin: 'subagent' }]) {
  test('historical sessions and subagents do not become newly pending: ' + JSON.stringify(summary), async () => {
    const element = renderGate({ ...OPEN_FOLDER, binding: { domainSource: 'auto' } }, {
      sessions: { 'sess-1': { cwd: '/ws/demo', ...summary } },
    })
    assert.equal(await live(element), null)
    assert.equal(lastRuntime.stateCalls, 0)
  })
}

test('leaving the session view also releases a Later choice', async () => {
  const element = renderGate(OPEN_FOLDER)
  const tree = await live(element)
  await findNode(tree, (node) => node.props?.key === 'later').props.onClick()
  await live(element)
  lastRuntime.current = null
  assert.equal(await live(element), null)
  lastRuntime.current = 'sess-1'
  assert.ok(await live(element))
})

for (const outcome of ['resolve', 'reject']) {
  test('a late RPC ' + outcome + ' from a departed session cannot change the current prompt', async () => {
    let complete
    const element = renderGate(() => new Promise((resolve, reject) => {
      complete = () => outcome === 'resolve' ? resolve(OPEN_FOLDER) : reject(new Error('late failure'))
    }))
    await live(element)
    lastRuntime.sessions['sess-0'] = { cwd: '/ws/demo', blank: false, origin: 'user' }
    lastRuntime.current = 'sess-0'
    await live(element)
    complete()
    assert.equal(await live(element), null)
    assert.equal(calls.length, 0, 'a cancelled check must not log or commit a decision')
  })
}

test('summary refresh and the first message preserve an open prompt selection', async () => {
  const element = renderGate(OPEN_FOLDER)
  const tree = await live(element)
  findNode(tree, (node) => node.type === 'select').props.onChange({ target: { value: 'coding' } })
  lastRuntime.sessions['sess-1'] = { cwd: '/ws/demo', blank: false, origin: 'user', title: 'first message' }
  const refreshed = await live(element)
  assert.equal(findNode(refreshed, (node) => node.type === 'select').props.value, 'coding')
  assert.equal(lastRuntime.stateCalls, 1)
})

test('a remembered answer binds silently even when the binding is implicit', async () => {
  const remembered = {
    ...OPEN_FOLDER,
    binding: { scopeKey: '/ws/demo', domainOverride: 'rp', domainSource: 'auto', useLibrary: true, useGlobal: true, libraryId: 'lib-1' },
    settings: { newSessionPromptDismissed: true, newSessionDefault: 'both' },
  }
  const { tree } = await settle(renderGate(remembered))
  assert.equal(tree, null, 'the remembered answer still opened the prompt')
  assert.deepEqual(calls.map((call) => call.endpoint), ['initSession', 'setSessionScope'])
})
