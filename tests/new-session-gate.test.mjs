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
let cursor = 0
let effects = []

const React = {
  createElement: makeElement,
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const index = cursor++
    if (hooks[index] === undefined) hooks[index] = typeof initial === 'function' ? initial() : initial
    return [hooks[index], (next) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next }]
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useEffect(fn, deps) { effects.push({ fn, deps, index: cursor++ }) },
  useLayoutEffect() {},
  useRef: (value) => ({ current: value }),
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

function buildCtx(promptState) {
  const snapshot = { byId: { 'sess-1': { cwd: '/ws/demo', blank: true, origin: 'user' } }, ids: ['sess-1'] }
  const connection = {
    rpc: {
      call: async (_path, endpoint, payload) => {
        if (endpoint === 'getSessionPromptState') return { ok: true, value: promptState }
        if (endpoint === 'initSession' || endpoint === 'setSessionScope' || endpoint === 'setDomain') {
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
      ? { adapter: { current: { subscribe: () => () => {}, getSnapshot: () => ({ key: 'sess-1' }) } } }
      : undefined),
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => snapshot } },
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

function renderGate(promptState) {
  hooks = []
  calls.length = 0
  cursor = 0
  effects = []
  roots.length = 0
  globalThis.__dshMemuExports.apply(buildCtx(promptState))
  assert.equal(roots.length, 1, 'the new-session gate was not mounted at all')
  return roots[0].element
}

// First pass renders nothing (no prompt yet), the mount effect fetches the state,
// the second pass renders the dialog with whatever the effect decided.
async function settle(element) {
  effects = []
  cursor = 0
  const first = element.type(element.props)
  for (const effect of effects) effect.fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  effects = []
  cursor = 0
  return { first, tree: element.type(element.props) }
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

// Re-run the component with the current hook state but WITHOUT replaying the
// mount effect: the effect re-fetches the state and would reset the card the
// test just clicked.
function paint(element) {
  cursor = 0
  effects = []
  return element.type(element.props)
}

function findNode(tree, predicate) {
  let hit = null
  walk(tree, (node) => { if (!hit && predicate(node)) hit = node })
  return hit
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

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
