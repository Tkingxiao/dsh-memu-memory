// A settings pane that throws during render shows up as a blank panel with no
// error anywhere — exactly what happened when an effect referenced a callback
// declared further down (temporal dead zone). This harness runs the real client
// component with a minimal hook runtime, so a render-time throw fails the build
// instead of silently blanking the UI. Every page is rendered, because a block
// only runs when its page is selected.
import test from 'node:test'
import assert from 'node:assert/strict'

const registrations = []

function makeElement(type, props, ...children) {
  return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }
}

let hooks = []
let cursor = 0
let effects = []
let dirty = false
let forced = null
let generation = 0

const React = {
  createElement: makeElement,
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const index = cursor++
    // A setter captured by a component from an earlier test must not write into
    // the hook array this test is using: async effects from a previous render can
    // resolve late, and without this the second test renders with the first one's
    // state.
    const generation_ = generation
    if (hooks[index] === undefined) hooks[index] = typeof initial === 'function' ? initial() : initial
    if (forced && forced.index === index) hooks[index] = forced.value
    return [hooks[index], (next) => {
      if (generation_ !== generation) return
      hooks[index] = typeof next === 'function' ? next(hooks[index]) : next
      dirty = true
    }]
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useEffect(fn, deps) { effects.push({ fn, deps, index: cursor++ }) },
  useLayoutEffect() {},
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      globalThis.__dshMemuExports = factory((name) => {
        if (name === 'react') return React
        throw new Error(`unexpected require: ${name}`)
      })
    },
  },
  // The overlay listens for its close message and for Escape.
  addEventListener() {},
  removeEventListener() {},
}
// The WebUI button falls back to an in-app overlay when popups are blocked; the
// stub records what got attached so the test can assert the current tab is never
// navigated (that would unload the app and look like a forced refresh).
const appendedNodes = []
globalThis.document = {
  createElement: (tag) => {
    const node = {
      tag,
      style: {},
      attrs: {},
      children: [],
      href: '',
      textContent: '',
      setAttribute(name, value) { node.attrs[name] = value },
      addEventListener() {},
      appendChild(child) { node.children.push(child); return child },
      remove() { node.removed = true },
      click() { node.clicked = true },
    }
    return node
  },
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
  head: { appendChild() {} },
  body: { appendChild(node) { appendedNodes.push(node); return node } },
}

await import('../lib/client.js')

const EMPTY_STATE = {
  engine: { status: 'ready', versions: [], currentVersion: '0.11.0b3', recommendedVersion: '0.11.0b3', installed: true, state: {} },
  settings: { autoInject: 'smart', mustRememberCap: 16, unpinBudgetPerSession: 2 },
  libraries: [],
  archivedLibraries: [],
  memuConfig: { provider: 'openai' },
  summaryConfig: {},
  binding: null,
  privateCount: 0,
  pinnedCount: 0,
  globalCount: 0,
  jobs: [],
}

const RPC_ANSWERS = {
  getState: EMPTY_STATE,
  getSettingsState: EMPTY_STATE,
  getPrompts: { prompts: [
    { key: 'system-guide', title: 'guide', description: '', variables: ['mustRememberCap'], source: 'default', text: 'a', scope: 'private', domain: null },
    { key: 'system-guide.rp', title: 'guide rp', description: '', variables: [], source: 'default', text: 'b', scope: 'private', domain: 'rp' },
    { key: 'global-curator', title: 'curator', description: '', variables: ['input'], source: 'default', text: 'c', scope: 'global', domain: null },
  ] },
  listVersions: { ok: true, versions: [] },
  listBackups: { backups: [] },
  listFolders: { folders: [] },
  listLibraries: { libraries: [] },
  listSessions: { sessions: [] },
  getSidebarState: {
    binding: { sessionId: 'probe-session', libraryId: 'lib-1', useLibrary: true, useGlobal: true, scopeKey: '/proj/demo', domain: 'coding' },
    domain: 'coding',
    folder: { scopeKey: '/proj/demo', useLibrary: true, useGlobal: true },
    effective: { useLibrary: true, useGlobal: true, enabled: true, folder: { scopeKey: '/proj/demo', useLibrary: true, useGlobal: true } },
    private: { items: [], active: 0, pinned: 0, total: 0 },
    global: { items: [], active: 0, total: 0 },
    domains: ['rp', 'coding'],
  },
  jobStatus: null,
}

function fakeCtx({ answers = {}, rpcCalls = [] } = {}) {
  return {
    effect: (fn) => { try { fn() } catch {} },
    locale: { register: () => () => {}, bind: () => (key) => key, get: () => 'zh' },
    connection: {
      rpc: {
        call: async (path, endpoint, payload) => {
          rpcCalls.push({ path, endpoint, payload })
          if (typeof answers[endpoint] === 'function') return answers[endpoint](payload)
          return { ok: true, value: answers[endpoint] ?? RPC_ANSWERS[endpoint] ?? {} }
        },
      },
    },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: {}, ids: [] }) } },
    // The sidebar tab asks for the current conversation through one of these.
    get: (name) => (name === 'uiSession'
      ? { adapter: { current: { getSnapshot: () => ({ key: 'probe-session' }) } } }
      : undefined),
    slots: {
      inject: (_name, callback) => callback(scope),
      register: (spec, component) => { registrations.push({ slot: spec.name, id: spec.id, component }); return () => {} },
    },
    inject: (_deps, callback) => callback({
      // Run the effect body: that is where the tab body registers itself.
      effect: (fn) => { try { fn() } catch {} },
      sidebarRightTabs: { register: () => () => {} },
      get: () => undefined,
    }),
  }
}

const scope = {
  effect: (fn) => { try { fn() } catch {} },
  register: (spec, component) => { registrations.push({ slot: spec.name, id: spec.id, component }); return () => {} },
  inject: (_deps, callback) => callback(scope),
}

async function renderPage(component, props, pageValue, { remount = false } = {}) {
  if (remount) { hooks = []; generation++ }
  effects = []
  cursor = 0
  forced = pageValue === undefined ? null : { index: pageHookIndex, value: pageValue }
  const tree = component(props)
  assert.ok(tree, 'component rendered nothing')
  return { tree, effects }
}

let pageHookIndex = -1

function collectPageHook() {
  // The page state is the only one initialised to the number 0.
  const zeroes = hooks.map((value, index) => (value === 0 ? index : -1)).filter((index) => index >= 0)
  assert.equal(zeroes.length, 1, 'expected exactly one numeric-zero state (the page index)')
  pageHookIndex = zeroes[0]
}

function treeText(node, depth = 0) {
  if (node === null || node === undefined || depth > 400) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => treeText(child, depth + 1)).join(' ')
  // Function components are expanded so their bodies are exercised too — a throw
  // inside Section/Button counts the same as one inside the page.
  if (typeof node.type === 'function') return treeText(node.type(node.props), depth + 1)
  return `${node.props?.className || ''} ${treeText(node.props?.children, depth + 1)}`
}

test('the settings page renders every page instead of a blank panel', async () => {
  const ctx = fakeCtx()
  globalThis.__dshMemuExports.apply(ctx)
  const settings = registrations.find((r) => r.slot === 'settings.section')
  assert.ok(settings?.component, 'settings.section was not registered')

  // First render: state is still null, which is the loading branch.
  const first = await renderPage(settings.component, { ctx, t: (key) => key }, undefined, { remount: true })
  collectPageHook()
  assert.match(treeText(first.tree), /loading|dshm-settings/)

  // Let the mount effects fetch and settle, then render with data. Hooks survive
  // between renders, which is how the fetched state reaches the next pass.
  for (const effect of first.effects) effect.fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))

  for (let page = 0; page < 11; page++) {
    const { tree } = await renderPage(settings.component, { ctx, t: (key) => key }, page)
    const text = treeText(tree)
    assert.match(String(tree.props?.className), /dshm-root/, `page ${page} did not render the shell`)
    // The rail is the nav: every page label has to be there. Counting the shared
    // dshm-nav-item class instead would also pick up the in-page tab strips (memory
    // backend, prompt scope, browser view), which use the same widget on purpose.
    const NAV = ['pageOverview', 'pageConnection', 'pageSettings', 'pageFolders', 'pageLibraries', 'pageBrowser', 'pageGlobal', 'pagePrompts', 'pageStats', 'pageMemories', 'pageLogs']
    assert.ok(NAV.every((key) => text.includes(key)), `page ${page} lost a nav entry`)
    assert.equal((text.match(/dshm-nav-ind/g) || []).length, 1, `page ${page} lost or duplicated its rail indicator`)
    assert.match(text, /dshm-page/, `page ${page} lost the content pane`)
    // Passing a labels map where an id was expected stringifies to this, which is
    // exactly how the sidebar domain picker broke.
    assert.ok(!text.includes('[object Object]'), `page ${page} rendered an object as text`)
  }
})

test('the sidebar tab renders with the two-layer header', async () => {
  const ctx = fakeCtx()
  const tab = registrations.find((r) => r.slot === 'sidebar.right.pane.tab')
  assert.ok(tab?.component, 'sidebar.right.pane.tab was not registered')

  // The registered body is a thin wrapper around MemoryTab; hooks only run in the
  // inner component, so unwrap it before rendering.
  const props = { ctx, t: (key) => key, sessionId: 'probe-session' }
  const wrapper = tab.component(props)
  const component = typeof wrapper.type === 'function' ? wrapper.type : tab.component
  const innerProps = typeof wrapper.type === 'function' ? wrapper.props : props

  hooks = []
  pageHookIndex = -1
  const first = await renderPage(component, innerProps, undefined, { remount: true })
  assert.ok(first.tree, 'sidebar tab rendered nothing')

  // Feed the fetched state back in, the same way the host would.
  for (const effect of first.effects) effect.fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))

  const { tree } = await renderPage(component, innerProps)
  const text = treeText(tree)
  assert.match(text, /layerFolder|layerConversation|noBinding|loading/, 'sidebar lost its two-layer header')
  assert.ok(!text.includes('[object Object]'), 'sidebar rendered an object as text')
  // The domain picker lists ids, translated through the label map.
  assert.match(text, /dmCoding/, 'domain picker did not render its options')
})

// The browser row is the only place a human can see that a memory is marked
// "never say this out loud" or "secret" without opening the JSON. The badges are
// driven by fields that used to be stored and ignored, so a regression here is
// silent: the data stays correct and the warning disappears.
function walkNodes(node, visit, depth = 0) {
  if (node === null || node === undefined || depth > 400) return
  if (Array.isArray(node)) {
    for (const child of node) walkNodes(child, visit, depth + 1)
    return
  }
  if (typeof node !== 'object') return
  if (visit(node, depth) === false) return
  if (typeof node.type === 'function') {
    walkNodes(node.type(node.props), visit, depth + 1)
    return
  }
  walkNodes(node.props?.children, visit, depth + 1)
}

test('the memory browser badges what a memory is allowed to say', async () => {
  const ctx = fakeCtx()
  const originalGetState = RPC_ANSWERS.getState
  const originalSettingsState = RPC_ANSWERS.getSettingsState
  const originalLibraries = RPC_ANSWERS.listLibraries
  const loaded = {
    ...EMPTY_STATE,
    libraries: [{ id: 'lib-1', name: 'demo', scopeKey: '/proj/demo', privateCount: 2 }],
  }
  // The pane reads the library list through both endpoints depending on the page.
  RPC_ANSWERS.getState = loaded
  RPC_ANSWERS.getSettingsState = loaded
  RPC_ANSWERS.browseLibrary = {
    source: 'engine',
    files: [
      {
        id: 'mem-quiet',
        title: 'the attic',
        content: 'he never told his brother',
        layer: 'short_term',
        status: 'active',
        decay: 0.5,
        disclosure: 'never_say',
        visibility: 'secret',
        owner: 'about_user',
        expiresAt: '2026-11-01T09:30:00.000Z',
      },
      { id: 'mem-loud', title: 'shared fact', content: 'anything', layer: 'long_term', status: 'active', decay: 0.9, disclosure: 'can_tell', visibility: 'shared', owner: 'me' },
    ],
  }
  try {
    globalThis.__dshMemuExports.apply(ctx)
    const settings = registrations.filter((r) => r.slot === 'settings.section').pop()
    assert.ok(settings?.component, 'settings.section was not registered')

    const first = await renderPage(settings.component, { ctx, t: (key) => key }, undefined, { remount: true })
    collectPageHook()
    for (const effect of first.effects) effect.fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Open the library the way a click would: pick it, then press reload.
    let tree = (await renderPage(settings.component, { ctx, t: (key) => key }, 5)).tree
    const picker = []
    walkNodes(tree, (node) => {
      // The layer picker of the new-memory form is also a <select>; only this one
      // lists libraries.
      const options = Array.isArray(node.props?.children) ? node.props.children : []
      if (node.type === 'select' && options.some((option) => option?.props?.value === 'lib-1')) picker.push(node)
    })
    assert.equal(picker.length, 1, 'the library picker did not render')
    picker[0].props.onChange({ target: { value: 'lib-1' } })

    tree = (await renderPage(settings.component, { ctx, t: (key) => key }, 5)).tree
    const reload = []
    walkNodes(tree, (node) => {
      if (typeof node.type === 'function' && node.props?.children === 'reload') reload.push(node)
    })
    assert.equal(reload.length, 1, 'the reload button did not render')
    reload[0].props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    tree = (await renderPage(settings.component, { ctx, t: (key) => key }, 5)).tree
    const text = treeText(tree)
    // Every row carries three editor selects, so each enum label also appears in the
    // option lists: two rows = 2 occurrences. A badge is the third.
    const count = (needle) => text.split(needle).length - 1
    assert.match(text, /layerShortTerm/, 'a short-term entry renders its layer instead of an empty tag')
    assert.equal(count('discNeverSay'), 3, 'never_say is visible without opening the entry')
    assert.equal(count('discCanTell'), 2, 'the default say-ability stays quiet — options only')
    assert.equal(count('visSecret'), 3, 'a secret is flagged while scanning')
    assert.equal(count('visShared'), 2, 'and so does the default visibility')
    assert.equal(count('ownerAboutUser'), 3, 'whose fact it is shows up too')
    assert.equal(count('shortTermExpires'), 1, 'and a draft shows when it dies')
    assert.ok(!text.includes('[object Object]'), 'a badge rendered an object as text')
  } finally {
    RPC_ANSWERS.getState = originalGetState
    RPC_ANSWERS.getSettingsState = originalSettingsState
    RPC_ANSWERS.listLibraries = originalLibraries
    delete RPC_ANSWERS.browseLibrary
  }
})

test('the WebUI buttons open a new tab and never navigate this one', async () => {
  const opened = []
  const navigated = []
  const originalWindow = { open: globalThis.window.open, location: globalThis.window.location }
  globalThis.window.location = { href: 'http://host/app', assign: (url) => navigated.push(url) }
  try {
    const ctx = fakeCtx()
    globalThis.__dshMemuExports.apply(ctx)
    const settings = registrations.filter((r) => r.slot === 'settings.section').pop()
    assert.ok(settings?.component, 'settings.section was not registered')

    const first = await renderPage(settings.component, { ctx, t: (key) => key }, undefined, { remount: true })
    collectPageHook()
    for (const effect of first.effects) effect.fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const buttons = []
    walkNodes((await renderPage(settings.component, { ctx, t: (key) => key }, 0)).tree, (node) => {
      if (node.type === 'button' && node.props?.children === 'openMemu') buttons.push(node)
    })
    assert.equal(buttons.length, 1, 'the WebUI button did not render')

    globalThis.window.open = (url) => { opened.push(url); return { focus() {}, opener: null } }
    buttons[0].props.onClick()
    assert.equal(opened.length, 1, 'a popup was requested')
    assert.ok(opened[0].endsWith('/dsh-memu-memory/ui#/settings/engine'), `unexpected url: ${opened[0]}`)
    assert.deepEqual(navigated, [], 'no fallback navigation while the popup works')

    // Blocked popups return null: fall back to an in-app overlay. Navigating this
    // tab would unload the app and look like a forced refresh on the way back.
    appendedNodes.length = 0
    globalThis.window.open = () => null
    buttons[0].props.onClick()
    assert.equal(appendedNodes.length, 1, 'blocked popups open an in-app overlay')
    const overlay = appendedNodes[0]
    assert.equal(overlay.attrs['data-dsh-memu-memory-webui'], '', 'the overlay is marked')
    const frame = overlay.children.find((child) => child.tag === 'iframe')
    assert.ok(frame, 'the overlay hosts an iframe')
    assert.ok(String(frame.src).endsWith('/dsh-memu-memory/ui#/settings/engine'), `unexpected url: ${frame.src}`)
    assert.deepEqual(navigated, [], 'the current tab is never navigated')
    // The close control lives inside the page; the overlay only waits for its message.
    assert.equal(overlay.children.length, 1, 'no floating chrome outside the panel')
  } finally {
    globalThis.window.open = originalWindow.open
    globalThis.window.location = originalWindow.location
  }
})

test('the sidebar and the settings page hand out the same WebUI button', async () => {
  // Two spellings of one action is how the panes drift: the sidebar used to label
  // this button openSettingsShort while the settings page used openWebUi. Both
  // surfaces now render the same widget with the same label, hint and handler, and
  // the embedded settings page drops its own copy so the sidebar never shows two.
  async function renderSurface(component, props, page) {
    hooks = []
    pageHookIndex = -1
    const first = await renderPage(component, props, page, { remount: true })
    if (page !== undefined) collectPageHook()
    for (const effect of first.effects) effect.fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const tree = (await renderPage(component, props, page)).tree
    const found = []
    walkNodes(tree, (node) => {
      if (node.type === 'button' && node.props?.children === 'openMemu') found.push(node)
    })
    return { tree, found }
  }

  const ctx = fakeCtx()
  globalThis.__dshMemuExports.apply(ctx)
  const settings = registrations.filter((r) => r.slot === 'settings.section').pop()
  const tab = registrations.filter((r) => r.slot === 'sidebar.right.pane.tab').pop()
  assert.ok(settings?.component && tab?.component, 'both surfaces are registered')

  const inSettings = await renderSurface(settings.component, { ctx, t: (key) => key }, 0)
  assert.equal(inSettings.found.length, 1, 'the settings page lost its WebUI button')

  const props = { ctx, t: (key) => key, sessionId: 'probe-session' }
  const wrapper = tab.component(props)
  const inner = typeof wrapper.type === 'function' ? wrapper.type : tab.component
  const innerProps = typeof wrapper.type === 'function' ? wrapper.props : props
  const inSidebar = await renderSurface(inner, innerProps, undefined)
  assert.equal(inSidebar.found.length, 1, 'the sidebar lost its WebUI button')
  assert.ok(!treeText(inSidebar.tree).includes('openSettings'), 'a second settings entry must not return')

  // The panel returns early while the conversation is still unknown, before its
  // `pages` array is built. Effects scheduled by that render still run, and one of
  // them reads `pages` — touching it then is a temporal-dead-zone error that the
  // sidebar surfaces as "dsh-better-sidebar: Cannot access 'pages' before
  // initialization". Rendering without a session must stay quiet.
  for (const empty of [null, undefined]) {
    const quiet = await renderSurface(inner, { ...innerProps, sessionId: empty }, undefined)
    assert.ok(treeText(quiet.tree).includes('loading'), 'the unbound panel shows its loading state')
  }

  for (const node of [...inSettings.found, ...inSidebar.found]) {
    assert.equal(node.props.className, 'dshm-btn', 'the button bypasses the shared widget')
    assert.equal(node.props.title, 'openWebUiHint', 'the button carries a different hint')
    assert.equal(typeof node.props.onClick, 'function', 'the button has no handler')
  }
  // The old keys are gone rather than kept around as a second spelling.
  const text = `${treeText(inSettings.tree)} ${treeText(inSidebar.tree)}`
  assert.ok(!text.includes('openSettingsShort'), 'the second WebUI label came back')
})

test('every pick-one-of-these control uses the same tab strip', async () => {
  // The settings rail, the prompt scope, the browser's active/archived split and
  // the memory backend are one widget (dshm-nav-item). They used to be three
  // widgets with three different hover and focus states, which is what read as
  // "the sidebar and the settings page do not match".
  const ctx = fakeCtx()
  globalThis.__dshMemuExports.apply(ctx)
  const settings = registrations.filter((r) => r.slot === 'settings.section').pop()

  const first = await renderPage(settings.component, { ctx, t: (key) => key }, undefined, { remount: true })
  collectPageHook()
  for (const effect of first.effects) effect.fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))

  const orphans = []
  for (let page = 0; page < 11; page++) {
    const { tree } = await renderPage(settings.component, { ctx, t: (key) => key }, page)
    walkNodes(tree, (node) => {
      if (node.type !== 'button') return
      const className = String(node.props?.className || '')
      if (node.props?.role === 'tab' && !className.includes('dshm-nav-item')) {
        orphans.push(`page ${page}: ${JSON.stringify(node.props?.children)}`)
      }
      if (className.includes('dshm-nav-item')) {
        assert.equal(typeof node.props.onClick, 'function', `page ${page} lost a tab handler`)
      }
    })
  }
  assert.deepEqual(orphans, [], 'a tab strip sits outside the shared widget')
})

// Task C: the statistics page is data-driven, so it only paints after two lazy
// loads (pick the first library, then read its stats). The charts are hand-written
// SVG — counting nodes is the honest check that thirty bars and one dot per memory
// actually reached the DOM, and that an empty day did not become NaN.
test('the statistics page draws the daily bars, the scatter and the shortlist', async () => {
  const ctx = fakeCtx()
  const originalState = RPC_ANSWERS.getSettingsState
  RPC_ANSWERS.getSettingsState = {
    ...EMPTY_STATE,
    libraries: [{ id: 'lib-1', name: 'demo', scopeKey: '/proj/demo' }],
  }
  RPC_ANSWERS.getStats = {
    libraryId: 'lib-1',
    available: true,
    keptDays: 90,
    windowDays: 30,
    days: Array.from({ length: 30 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, '0')}`,
      written: i === 29 ? 2 : 0,
      injected: i % 3,
      recalled: 0,
      archived: 0,
    })),
    totals: { written: 2, injected: 30, recalled: 4, archived: 1 },
    ratio: { windowDays: 7, written: 2, injected: 9 },
    health: { total: 2, active: 2, marginalized: 0, archived: 0, pendingReview: 0, avgStrength: 0.71 },
    distribution: [
      { id: 'mem-a', title: 'often recalled', layer: 'long_term', ageDays: 3, injectCount: 4, accessCount: 2 },
      { id: 'mem-b', title: 'never recalled', layer: 'long_term', ageDays: 9, injectCount: 0, accessCount: 0 },
    ],
    distributionTotal: 2,
    stale: [{ id: 'mem-b', title: 'never recalled', daysSinceTouch: 9 }],
  }
  const run = async (effectsToRun) => {
    for (const effect of effectsToRun) effect.fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  try {
    globalThis.__dshMemuExports.apply(ctx)
    const settings = registrations.filter((r) => r.slot === 'settings.section').pop()
    const first = await renderPage(settings.component, { ctx, t: (key) => key }, undefined, { remount: true })
    collectPageHook()
    await run(first.effects)

    let pass = await renderPage(settings.component, { ctx, t: (key) => key }, 8)
    await run(pass.effects)
    pass = await renderPage(settings.component, { ctx, t: (key) => key }, 8)
    await run(pass.effects)
    const { tree } = await renderPage(settings.component, { ctx, t: (key) => key }, 8)

    const counts = { rects: 0, circles: 0 }
    walkNodes(tree, (node) => {
      if (node.type === 'rect') counts.rects += 1
      if (node.type === 'circle') counts.circles += 1
    })
    assert.equal(counts.rects, 30, 'thirty daily bars, including the quiet days')
    assert.equal(counts.circles, 2, 'one scatter dot per memory')
    const text = treeText(tree)
    assert.match(text, /statsWritten/, 'the window totals render')
    assert.match(text, /statsStaleDays/, 'the archive shortlist renders')
    assert.ok(!text.includes('NaN'), 'an empty day must not paint NaN')
    assert.ok(!text.includes('[object Object]'), 'the page rendered an object as text')
  } finally {
    RPC_ANSWERS.getSettingsState = originalState
    delete RPC_ANSWERS.getStats
  }
})

test('the memory tab is registered exactly once, with or without better-sidebar', () => {
  function appCtx(initialBetter) {
    const seen = { native: [], better: [], pending: {} }
    let better = initialBetter
    const slotsScope = { effect: (fn) => { try { fn() } catch {} }, register: () => () => {}, inject: (_n, cb) => cb(slotsScope) }
    const scope = {
      effect: (fn) => { const dispose = fn(); return () => { try { dispose?.() } catch {} } },
      get: (name) => (name === 'betterSidebar' ? better : undefined),
      sidebarRightTabs: {
        register: (spec) => {
          seen.native.push(spec)
          return () => { const at = seen.native.indexOf(spec); if (at >= 0) seen.native.splice(at, 1) }
        },
      },
      slots: { inject: (_n, cb) => cb(slotsScope), register: () => () => {} },
    }
    const ctx = {
      effect: () => {},
      locale: { register: () => () => {}, bind: () => (key) => key, get: () => 'zh' },
      connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
      sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: {}, ids: [] }) } },
      get: (name) => (name === 'betterSidebar' ? better : undefined),
      slots: { inject: (_n, cb) => cb(scope), register: () => () => {} },
      inject: (deps, callback) => {
        const key = deps[0]
        seen.pending[key] = callback
        if (key === 'betterSidebar' && !better) return
        callback(scope)
      },
    }
    return {
      ctx,
      seen,
      later(service) { better = service; seen.pending.betterSidebar(scope) },
    }
  }

  let betterCalls = 0
  const betterService = () => ({ registerTab: () => { betterCalls += 1; return () => {} } })

  // No better-sidebar: the native tab is the only entry.
  const a = appCtx(null)
  globalThis.__dshMemuExports.apply(a.ctx)
  assert.equal(a.seen.native.length, 1, 'native tab registered when better-sidebar is absent')
  assert.equal(a.seen.better.length, 0)

  // Installed up front: only its tab, otherwise the start list shows two.
  const b = appCtx(betterService())
  globalThis.__dshMemuExports.apply(b.ctx)
  assert.equal(b.seen.native.length, 0, 'native tab must not register when better-sidebar exists')
  assert.equal(betterCalls, 1, 'its own tab is registered instead')

  // Installed after us: the native tab we already registered has to go.
  const c = appCtx(null)
  globalThis.__dshMemuExports.apply(c.ctx)
  assert.equal(c.seen.native.length, 1)
  let betterRegistrations = 0
  c.later({ registerTab: () => { betterRegistrations += 1; return () => {} } })
  assert.equal(c.seen.native.length, 0, 'late better-sidebar removes the native tab')
  assert.equal(betterRegistrations, 1, 'and registers its own')
})

// Exercise the actual settings component, not source-text matches: stale vector
// configuration must not escape the Agent gate, and rendering must never install.
async function renderVectorSettings(t, overrides = {}, answers = {}, pageValue = 1) {
  const loaded = {
    ...EMPTY_STATE,
    ...overrides,
    settings: { ...EMPTY_STATE.settings, ...overrides.settings },
    memuConfig: { ...EMPTY_STATE.memuConfig, ...overrides.memuConfig },
  }
  const rpcCalls = []
  const ctx = fakeCtx({ answers: { getSettingsState: loaded, ...answers }, rpcCalls })
  globalThis.__dshMemuExports.apply(ctx)
  const settings = registrations.filter((r) => r.slot === 'settings.section').pop()
  assert.ok(settings?.component, 'settings.section was not registered')
  const props = { ctx, t: (key) => key }
  const first = await renderPage(settings.component, props, undefined, { remount: true })
  collectPageHook()
  const cleanups = []
  t.after(() => { for (const cleanup of cleanups.reverse()) cleanup() })
  for (const effect of first.effects) {
    const cleanup = effect.fn()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  const tree = (await renderPage(settings.component, props, pageValue)).tree
  const nodes = []
  walkNodes(tree, (node) => { nodes.push(node) })
  const rerender = async () => {
    const { tree, effects } = await renderPage(settings.component, props, pageValue)
    const nodes = []
    walkNodes(tree, node => { nodes.push(node) })
    return { tree, nodes, effects }
  }
  return { tree, nodes, rpcCalls, rerender }
}

const VECTOR_CATALOG_FIXTURE = {
  catalog: [
    { id: 'fixture-download', displayName: 'Fixture Download Model', availability: 'available', dimension: 384, totalBytes: 100 },
    { id: 'fixture-pending', displayName: 'Fixture Pending Model', availability: 'pending', pendingReasons: ['SHA-256 pending'], dimension: 384 },
    { id: 'fixture-installed', displayName: 'Fixture Installed Model', availability: 'available', dimension: 384 },
  ],
  installations: { 'fixture-installed': { installed: true, fingerprintMatches: true, status: 'installed' } },
  vector: {},
}

test('the default Agent backend hides vector source, catalog and API configuration', async (t) => {
  const { tree, nodes, rpcCalls } = await renderVectorSettings(t, {
    memuConfig: { source: 'api', model: 'stale-api-model' },
    localVector: VECTOR_CATALOG_FIXTURE,
  })
  const text = treeText(tree)
  assert.match(text, /backendAgent/)
  assert.ok(nodes.some((node) => node.type === 'button' && node.props.children === 'backendAgent' && node.props['aria-selected'] === true))
  for (const hidden of ['vectorSource', 'managedVector', 'Fixture Download Model', 'summaryModel']) {
    assert.ok(!text.includes(hidden), hidden + ' escaped the default Agent gate')
  }
  assert.ok(!nodes.some((node) => node.type === 'input' && node.props.value === 'stale-api-model'))
  assert.ok(!rpcCalls.some((call) => /downloadLocalVector|setEmbeddingSource|switchLocalVector/.test(call.endpoint)))
})

test('local vector settings render catalog controls and native download and migration progress', async (t) => {
  const { tree, nodes, rpcCalls } = await renderVectorSettings(t, {
    settings: { memoryBackend: 'api', vectorSource: 'local' },
    localVector: {
      ...VECTOR_CATALOG_FIXTURE,
      installations: {
        ...VECTOR_CATALOG_FIXTURE.installations,
        'fixture-download': { status: 'downloading', progress: { files: 2, done: 1, bytes: 25, totalBytes: 100, current: 'model.onnx' } },
      },
      vector: {
        active: { catalogId: 'previous-model' },
        requested: { catalogId: 'fixture-installed' },
        pending: { report: { progress: { completed: 2, total: 8, generation: 3, stage: 'embedding', current: { itemId: 'memory-2' } } } },
      },
    },
  })
  const text = treeText(tree)
  for (const visible of ['vectorSourceLocal', 'Fixture Download Model', 'Fixture Pending Model', 'SHA-256 pending', 'managedVectorDownload', 'managedVectorSelect', 'managedVectorSwitch', 'managedVectorRollback', 'model.onnx', 'memory-2']) {
    assert.ok(text.includes(visible), visible + ' did not render')
  }
  const download = nodes.filter((node) => node.type === 'button' && node.props.children === 'managedVectorDownload')
  assert.equal(download.length, 1, 'a pending manifest must not get a download button')
  const progress = nodes.filter((node) => node.type === 'progress')
  assert.equal(progress.length, 2)
  assert.ok(progress.some((node) => node.props['aria-label'] === 'managedVectorProgress' && node.props.value === 25 && node.props.max === 100))
  assert.ok(progress.some((node) => node.props['aria-label'] === 'managedVectorRebuilding' && node.props.value === 2 && node.props.max === 8))
  assert.equal(nodes.filter((node) => node.props?.role === 'status' && node.props['aria-live'] === 'polite').length, 2)
  assert.ok(!nodes.some((node) => node.type === 'input' && node.props.type === 'password'), 'API key fields leaked into local source')
  assert.ok(!rpcCalls.some((call) => /downloadLocalVector|selectLocalVector|switchLocalVector/.test(call.endpoint)), 'rendering performed a model operation')
})

test('migration with unknown total renders indeterminate native progress', async (t) => {
  const { tree, nodes } = await renderVectorSettings(t, {
    settings: { memoryBackend: 'api', vectorSource: 'local' },
    localVector: { catalog: [], installations: {}, vector: { pending: { report: { progress: { completed: 0, total: 0, generation: 4, stage: 'preparing' } } } } },
  })
  const progress = nodes.filter((node) => node.type === 'progress')
  assert.equal(progress.length, 1)
  assert.equal(progress[0].props.value, undefined, 'unknown work must not look complete')
  assert.equal(progress[0].props.max, 1)
  assert.match(treeText(tree), /managedVectorGeneration 4/)
  assert.ok(!treeText(tree).includes('NaN'))
})

test('switch waits for two clicks, reports in-flight work, and keeps a failed operation visible', async (t) => {
  let finish
  const response = new Promise(resolve => { finish = resolve })
  const view = await renderVectorSettings(t, {
    settings: { memoryBackend: 'api', vectorSource: 'local' },
    localVector: {
      ...VECTOR_CATALOG_FIXTURE,
      runtime: { status: 'installed', ready: true, path: 'runtime' },
      vector: { requested: { catalogId: 'fixture-installed' }, active: { catalogId: 'old-model' } },
    },
  }, { switchLocalVectorProfile: () => response })
  const button = current => current.nodes.find(node => node.type === 'button' && node.props.title === 'managedVectorSwitch')
  await button(view).props.onClick()
  assert.equal(view.rpcCalls.filter(call => call.endpoint === 'switchLocalVectorProfile').length, 0)
  const armed = await view.rerender()
  assert.equal(button(armed).props.children, 'confirmAction')
  const operation = button(armed).props.onClick()
  const waiting = await view.rerender()
  assert.equal(button(waiting).props.disabled, true)
  assert.ok(waiting.nodes.some(node => node.props?.role === 'status' && treeText(node).includes('managedVectorStatus: managedVectorSwitch')))
  assert.match(treeText(waiting.tree), /managedVectorPrerequisites/)
  finish({ ok: false, error: { code: 'LOCAL_VECTOR_RUNTIME_UNAVAILABLE', message: 'a verified managed runtime is required before switching local embeddings' } })
  await operation
  const failed = await view.rerender()
  assert.equal(button(failed).props.disabled, false)
  assert.ok(failed.nodes.some(node => node.props?.role === 'alert' && treeText(node).includes('verified managed runtime')))
  assert.match(treeText(failed.tree), /old-model/)
  assert.match(treeText(failed.tree), /managedVectorRequested/)
  assert.equal(view.rpcCalls.filter(call => call.endpoint === 'switchLocalVectorProfile').length, 1)
})

test('pending manifests show verification and size reasons; persisted migration failures remain visible', async (t) => {
  const { tree, nodes } = await renderVectorSettings(t, {
    settings: { memoryBackend: 'api', vectorSource: 'local' },
    localVector: {
      ...VECTOR_CATALOG_FIXTURE,
      installations: { ...VECTOR_CATALOG_FIXTURE.installations, 'fixture-pending': { status: 'absent' } },
      vector: { pending: { status: 'failed', error: {
        code: 'VECTOR_SYNC_FAILED',
        message: 'cannot list shadow database',
        failedItems: [{ itemId: 'mem-failed-1', code: 'VECTOR_READBACK_FAILED', message: 'committed item is missing from shadow' }],
      } } },
    },
  })
  assert.match(treeText(tree), /managedVectorSizePending/)
  assert.match(treeText(tree), /managedVectorPending/)
  assert.match(treeText(tree), /SHA-256 pending/)
  assert.ok(treeText(tree).includes('managedVectorSizePending'), 'pending artifacts must not display a guessed byte count')
  assert.equal(nodes.filter(node => node.type === 'button' && node.props.title === 'managedVectorDownload').length, 1)
  assert.ok(nodes.some(node => node.props?.role === 'alert' && treeText(node).includes('cannot list shadow database')))
  // 重建失败必须说清是哪一条、为什么：只报"未覆盖全部记忆"根本没法修。
  const failedText = treeText(tree)
  assert.match(failedText, /mem-failed-1/)
  assert.match(failedText, /VECTOR_READBACK_FAILED/)
  assert.match(failedText, /committed item is missing from shadow/)
})

test('a finished rebuild reads as switched, not as a running progress bar', async (t) => {
  const { tree } = await renderVectorSettings(t, {
    settings: { memoryBackend: 'api', vectorSource: 'local' },
    localVector: {
      ...VECTOR_CATALOG_FIXTURE,
      runtime: { status: 'installed', ready: true, path: 'runtime' },
      vector: {
        active: { catalogId: 'fixture-installed', generation: 1, fingerprint: '47511436abcdef', lastMigration: { committed: 8, total: 8, generation: 1 } },
        indexed: { global: ['a', 'b'], lib: ['c', 'd', 'e'] },
      },
    },
  })
  const text = treeText(tree)
  assert.match(text, /vectorStageCommitted/)
  assert.match(text, /vectorSwitchDoneHint/)
  assert.doesNotMatch(text, /managedVectorRebuilding/, 'a committed generation must not keep the running label')
  assert.match(text, /vectorRouteLocal/, 'the header must say which route recall uses')
  assert.match(text, /vectorIndexedNow/, 'the card must show the live indexed count, not only the switch snapshot')
  assert.match(text, /vectorIndexedNow 5 vectorIndexedUnit/, 'two global + three library ids')
})

test('API vector settings render provider fields and hide the managed local catalog', async (t) => {
  const { tree, nodes } = await renderVectorSettings(t, {
    settings: { memoryBackend: 'api', vectorSource: 'api' },
    memuConfig: { source: 'api', provider: 'jina', model: 'fixture-api-model', baseUrl: 'https://example.invalid/v1', hasKey: true },
    summaryConfig: { model: 'fixture-summary-model' },
    localVector: VECTOR_CATALOG_FIXTURE,
  })
  const text = treeText(tree)
  for (const visible of ['vectorSourceApi', 'provider', 'model', 'baseUrl', 'apiKey', 'summaryModel']) {
    assert.ok(text.includes(visible), visible + ' did not render')
  }
  assert.ok(nodes.some((node) => node.type === 'select' && node.props.value === 'jina'))
  assert.ok(nodes.some((node) => node.type === 'input' && node.props.value === 'fixture-api-model'))
  assert.ok(nodes.some((node) => node.type === 'input' && node.props.value === 'https://example.invalid/v1'))
  assert.equal(nodes.filter((node) => node.type === 'input' && node.props.type === 'password').length, 2)
  assert.ok(!text.includes('Fixture Download Model'))
  assert.ok(!text.includes('managedVectorDownload'))
  assert.ok(!nodes.some((node) => node.type === 'progress'))
})

test('clicking the API source tab sends the explicit setEmbeddingSource RPC only', async (t) => {
  const { nodes, rpcCalls } = await renderVectorSettings(t, {
    settings: { memoryBackend: 'api', vectorSource: 'local' },
    localVector: VECTOR_CATALOG_FIXTURE,
  })
  const apiTab = nodes.filter((node) => node.type === 'button' && node.props.children === 'vectorSourceApi')
  assert.equal(apiTab.length, 1)
  assert.equal(apiTab[0].props['aria-selected'], false)
  assert.equal(apiTab[0].props.disabled, false)
  assert.equal(rpcCalls.filter((call) => call.endpoint === 'setEmbeddingSource').length, 0)
  await apiTab[0].props.onClick()
  assert.deepEqual(rpcCalls.filter((call) => call.endpoint === 'setEmbeddingSource'), [
    { path: '/dsh-memu-memory', endpoint: 'setEmbeddingSource', payload: { source: 'api' } },
  ])
  assert.ok(!rpcCalls.some((call) => /downloadLocalVector|selectLocalVector|switchLocalVector/.test(call.endpoint)))
})

test('the log page renders rows with copy, download and locate actions', async () => {
  const event = {
    id: 'act-fixture', at: '2026-10-30T03:00:00.000Z', kind: 'consolidate', level: 'warn',
    scope: 'private', sessionId: 'session-abcdef', libraryId: 'lib-1',
    message: '整理超时：fork 已停止', detail: { timedOut: true, childId: 'memu-consolidate-x' }, refs: [], ok: false,
  }
  const ctx = fakeCtx({
    answers: { getActivityLog: { events: [event], stats: { total: 1, capped: 2000, bytes: 512 } } },
  })
  globalThis.__dshMemuExports.apply(ctx)
  const settings = registrations.filter((r) => r.slot === 'settings.section').pop()
  const first = await renderPage(settings.component, { ctx, t: (key) => key }, undefined, { remount: true })
  collectPageHook()
  for (const effect of first.effects) effect.fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  // The log page's own effect only exists once that page renders, so it needs one
  // more render + effect pass before the data is in the hook.
  const mid = await renderPage(settings.component, { ctx, t: (key) => key }, 10)
  for (const effect of mid.effects) effect.fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  const { tree } = await renderPage(settings.component, { ctx, t: (key) => key }, 10)
  const text = treeText(tree)
  assert.match(text, /整理超时/)
  assert.match(text, /logCopyAll/)
  assert.match(text, /logDownload/)
  assert.match(text, /logLocate/, 'a row with a library id offers the correction entry point')
  assert.match(text, /pageLogs/)
})
