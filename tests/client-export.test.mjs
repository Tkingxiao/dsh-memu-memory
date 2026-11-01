// Package B (spec §6.2): export/import contract + success notices.
//
// The export contract is behavioral: exportLibraryNow/importLibraryNow take an
// options object whose libraryId defaults to the browsed library but must be
// the id that reaches the exportLibrary payload, the fallback download name
// and the ZIP upload URL. The notices are the other half: every browser row
// action answers with its own success message through the page's notice slot
// while failures keep using setError.
//
// Same fake-React harness as tests/client-render.test.mjs, plus two seams the
// old harness never needed: captured createElement nodes (the file input and
// the download anchors) and stubbed fetch/URL.createObjectURL.
import test from 'node:test'
import assert from 'node:assert/strict'

const createdNodes = []
const fetchCalls = []
const realFetch = globalThis.fetch
const realCreateObjectURL = URL.createObjectURL
const realRevokeObjectURL = URL.revokeObjectURL

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
  addEventListener() {},
  removeEventListener() {},
}
globalThis.document = {
  createElement: (tag) => {
    const node = {
      tag,
      style: {},
      attrs: {},
      children: [],
      href: '',
      download: '',
      textContent: '',
      setAttribute(name, value) { node.attrs[name] = value },
      addEventListener() {},
      appendChild(child) { node.children.push(child); return child },
      remove() { node.removed = true },
      click() { node.clicked = true },
    }
    createdNodes.push(node)
    return node
  },
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
  head: { appendChild() {} },
  body: { appendChild() {} },
}

// The import ZIP path POSTs to a host route; record instead of hitting nothing.
globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url: String(url), options })
  return { json: async () => ({ ok: true, value: { imported: 2, counts: {} } }) }
}
URL.createObjectURL = () => 'blob:fixture'
URL.revokeObjectURL = () => {}

await import('../lib/client.js')

const EMPTY_STATE = {
  engine: { status: 'ready', versions: [], currentVersion: '0.11.0b3', recommendedVersion: '0.11.0b3', installed: true, state: {} },
  settings: { autoInject: 'smart', mustRememberCap: 16, unpinBudgetPerSession: 2 },
  libraries: [{ id: 'lib-1', name: 'demo', scopeKey: '/proj/demo', privateCount: 2 }],
  archivedLibraries: [],
  memuConfig: { provider: 'openai' },
  summaryConfig: {},
  binding: null,
  privateCount: 2,
  pinnedCount: 0,
  globalCount: 0,
  jobs: [],
}

const BROWSE_FILES = [
  { id: 'mem-live', title: 'live entry', content: 'an active body', layer: 'long_term', status: 'active', decay: 0.9 },
  { id: 'mem-gone', title: 'archived entry', content: 'an archived body', layer: 'long_term', status: 'archived', decay: 0.4 },
]

const WALL_ITEM = {
  id: 'mem-wall', libraryId: 'lib-1', title: 'walled entry', preview: 'a body',
  layer: 'long_term', status: 'active', decay: 0.9,
}

function makeAnswers(over = {}) {
  return {
    getState: EMPTY_STATE,
    getSettingsState: EMPTY_STATE,
    listLibraries: { libraries: EMPTY_STATE.libraries },
    listSessions: { sessions: [] },
    listVersions: { ok: true, versions: [] },
    listBackups: { backups: [] },
    listFolders: { folders: [] },
    getSidebarState: {
      binding: null, domain: 'general', folder: null,
      effective: { useLibrary: false, useGlobal: false, enabled: false },
      private: { items: [], active: 0, pinned: 0, total: 0 },
      global: { items: [], active: 0, total: 0 },
      domains: [],
    },
    jobStatus: null,
    browseLibrary: { source: 'engine', files: structuredClone(BROWSE_FILES) },
    browseWall: { items: [structuredClone(WALL_ITEM)], total: 1, errors: [] },
    getMemory: { id: 'mem-wall', libraryId: 'lib-1', entry: { title: 'walled entry', content: 'a body', layer: 'long_term', status: 'active', confidence: 0.8, tags: [] }, attachments: [] },
    ...over,
  }
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
          return { ok: true, value: answers[endpoint] ?? {} }
        },
      },
    },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: {}, ids: [] }) } },
    get: (name) => (name === 'uiSession'
      ? { adapter: { current: { getSnapshot: () => ({ key: 'probe-session' }) } } }
      : undefined),
    slots: {
      inject: (_name, callback) => callback(scope),
      register: (spec, component) => { registrations.push({ slot: spec.name, id: spec.id, component }); return () => {} },
    },
    inject: (_deps, callback) => callback({
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
  const zeroes = hooks.map((value, index) => (value === 0 ? index : -1)).filter((index) => index >= 0)
  assert.equal(zeroes.length, 1, 'expected exactly one numeric-zero state (the page index)')
  pageHookIndex = zeroes[0]
}

function treeText(node, depth = 0) {
  if (node === null || node === undefined || depth > 400) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => treeText(child, depth + 1)).join(' ')
  if (typeof node.type === 'function') return treeText(node.type(node.props), depth + 1)
  return `${node.props?.className || ''} ${treeText(node.props?.children, depth + 1)}`
}

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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

// Renders the settings page, waits for the mount fetches, jumps to the browser
// page (5), selects lib-1 in the picker and (optionally) presses reload so the
// rows are painted. Returns render/rerender helpers plus the collected calls.
async function openBrowserPage(t, { reload = true, answers = {} } = {}) {
  const rpcCalls = []
  const ctx = fakeCtx({ answers: makeAnswers(answers), rpcCalls })
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
  await settle()
  await settle()

  let tree = (await renderPage(settings.component, props, 5)).tree
  let picker = []
  walkNodes(tree, (node) => {
    const options = Array.isArray(node.props?.children) ? node.props.children : []
    if (node.type === 'select' && options.some((option) => option?.props?.value === 'lib-1')) picker.push(node)
  })
  assert.equal(picker.length, 1, 'the library picker did not render')
  picker[0].props.onChange({ target: { value: 'lib-1' } })

  const rerender = async () => {
    const { tree, effects } = await renderPage(settings.component, props, 5)
    const nodes = []
    walkNodes(tree, (node) => { nodes.push(node) })
    return { tree, nodes, text: treeText(tree), effects }
  }
  let view = await rerender()

  if (reload) {
    const reloadButtons = view.nodes.filter((node) => typeof node.type === 'function' && node.props?.children === 'reload')
    assert.equal(reloadButtons.length, 1, 'the reload button did not render')
    reloadButtons[0].props.onClick()
    await settle()
    await settle()
    view = await rerender()
  }
  const findButtons = (label) => view.nodes.filter((node) => typeof node.type === 'function' && node.props?.children === label)
  return { ctx, rpcCalls, rerender, view, findButtons }
}

test.after(() => {
  globalThis.fetch = realFetch
  URL.createObjectURL = realCreateObjectURL
  URL.revokeObjectURL = realRevokeObjectURL
})

test('the JSON export sends the browsed libraryId and reports exportStarted with the filename', async (t) => {
  createdNodes.length = 0
  const { rpcCalls, rerender, findButtons } = await openBrowserPage(t, {
    reload: false,
    answers: { exportLibrary: { filename: 'lib-1.json', base64: Buffer.from('hello').toString('base64') } },
  })
  const exportButtons = findButtons('export')
  assert.equal(exportButtons.length, 1, 'the JSON export button did not render')
  exportButtons[0].props.onClick()
  await settle()
  await settle()

  const call = rpcCalls.find((entry) => entry.endpoint === 'exportLibrary')
  assert.ok(call, 'exportLibrary was not called')
  assert.equal(call.payload.libraryId, 'lib-1', 'the payload must carry the selected library id')
  assert.equal(call.payload.includeAttachments, false)
  assert.equal(call.payload.delivery, undefined)
  const anchor = createdNodes.find((node) => node.tag === 'a' && node.clicked)
  assert.ok(anchor, 'the download anchor was created and clicked')
  assert.equal(anchor.href, 'blob:fixture')
  assert.equal(anchor.download, 'lib-1.json', 'the fallback download name uses the served filename')
  const { text } = await rerender()
  assert.ok(text.includes('exportStarted'), 'the export notice did not appear')
  assert.ok(!text.includes('exportImages'), 'the renamed copy key leaked back in')
})

test('the ZIP export passes includeAttachments with delivery download and offers the served URL', async (t) => {
  createdNodes.length = 0
  const { rpcCalls, rerender, findButtons } = await openBrowserPage(t, {
    reload: false,
    answers: { exportLibrary: { filename: 'lib-1-with-attachments.zip', downloadUrl: 'http://host/exports/lib-1-with-attachments.zip' } },
  })
  const zipButtons = findButtons('exportZip')
  assert.equal(zipButtons.length, 1, 'the ZIP export button did not render')
  zipButtons[0].props.onClick()
  await settle()
  await settle()

  const call = rpcCalls.find((entry) => entry.endpoint === 'exportLibrary')
  assert.equal(call.payload.includeAttachments, true, 'the ZIP button must request attachments')
  assert.equal(call.payload.delivery, 'download')
  assert.equal(call.payload.libraryId, 'lib-1')
  const anchor = createdNodes.find((node) => node.tag === 'a' && node.clicked)
  assert.ok(anchor, 'the downloadUrl branch still downloads through an anchor')
  assert.equal(anchor.href, 'http://host/exports/lib-1-with-attachments.zip')
  const { text } = await rerender()
  assert.ok(text.includes('exportStarted'), 'a served URL export also reports exportStarted')
})

test('the ZIP import posts to the selected library id and lands back in that library', async (t) => {
  createdNodes.length = 0
  fetchCalls.length = 0
  const { rpcCalls, rerender, findButtons } = await openBrowserPage(t, { reload: false })
  const importButtons = findButtons('importJson')
  assert.equal(importButtons.length, 1, 'the import button did not render')
  importButtons[0].props.onClick()
  const input = createdNodes.find((node) => node.tag === 'input' && node.type === 'file')
  assert.ok(input, 'the import file picker was created')
  input.files = [{ name: 'lib-1.zip' }]
  await input.onchange()
  await settle()
  await settle()

  assert.equal(fetchCalls.length, 1, 'the ZIP import must go through the host route')
  assert.ok(
    fetchCalls[0].url.startsWith('/dsh-memu-memory/import/lib-1.zip'),
    `the ZIP URL must use the selected library id, got ${fetchCalls[0].url}`,
  )
  const { text } = await rerender()
  assert.ok(text.includes('importDone'), 'the import success notice did not appear')
  // After a successful import the browser reloads the same library.
  const browsed = rpcCalls.filter((entry) => entry.endpoint === 'browseLibrary')
  assert.ok(browsed.some((entry) => entry.payload.libraryId === 'lib-1'), 'the browser reloaded the imported library')
})

test('each browser row action answers with its own success notice', async (t) => {
  createdNodes.length = 0
  // A server with state: the row actions mutate the served inventory, so the
  // archived tab really gains/loses rows as the test drives it. Function
  // answers must hand back the full RPC envelope (ok/value) themselves.
  const files = structuredClone(BROWSE_FILES)
  const { rpcCalls, rerender, view, findButtons } = await openBrowserPage(t, {
    reload: true,
    answers: {
      browseLibrary: () => ({ ok: true, value: { source: 'engine', files: structuredClone(files) } }),
      addMemory: async () => ({ ok: true, value: { id: 'mem-added' } }),
      updateMemory: async (payload) => {
        const row = files.find((file) => file.id === payload.id)
        if (row) Object.assign(row, payload.patch)
        return { ok: true, value: {} }
      },
      archiveMemory: async (payload) => {
        const row = files.find((file) => file.id === payload.id)
        if (row) row.status = 'archived'
        return { ok: true, value: {} }
      },
      deleteMemory: async (payload) => {
        const at = files.findIndex((file) => file.id === payload.id)
        if (at >= 0) files.splice(at, 1)
        return { ok: true, value: {} }
      },
    },
  })

  // addMemory → memorySaved
  const contentBox = view.nodes.find((node) => node.type === 'textarea' && node.props?.placeholder === 'memoryContent')
  assert.ok(contentBox, 'the new-memory form did not render')
  contentBox.props.onChange({ target: { value: 'a fresh fact worth keeping' } })
  let next = await rerender()
  const addButtons = next.nodes.filter((node) => typeof node.type === 'function' && node.props?.children === 'add')
  assert.equal(addButtons.length, 1)
  addButtons[0].props.onClick()
  await settle(); await settle()
  next = await rerender()
  assert.ok(next.text.includes('memorySaved'), 'addMemory did not report memorySaved')
  assert.ok(rpcCalls.some((call) => call.endpoint === 'addMemory' && call.payload.libraryId === 'lib-1'))

  // saveMemory → memorySaved (the row editor needs a non-empty draft first)
  const titleInput = next.nodes.find((node) => node.type === 'input' && node.props?.placeholder === 'name')
  assert.ok(titleInput, 'the row editor did not render')
  titleInput.props.onChange({ target: { value: 'renamed entry' } })
  next = await rerender()
  const saveButtons = next.nodes.filter((node) => typeof node.type === 'function' && node.props?.children === 'save')
  assert.equal(saveButtons.length, 1, 'the row save button did not render')
  saveButtons[0].props.onClick()
  await settle(); await settle()
  next = await rerender()
  assert.ok(next.text.includes('memorySaved'), 'saveMemory did not report memorySaved')
  assert.ok(rpcCalls.some((call) => call.endpoint === 'updateMemory' && call.payload.id === 'mem-live'))

  // archiveMemory → memoryArchived (the active row's archive button)
  const archiveButtons = next.nodes.filter((node) => typeof node.type === 'function' && node.props?.children === 'archive')
  assert.equal(archiveButtons.length, 1, 'the active row archive button did not render')
  archiveButtons[0].props.onClick()
  await settle(); await settle()
  next = await rerender()
  assert.ok(next.text.includes('memoryArchived'), 'archiveMemory did not report memoryArchived')
  assert.ok(rpcCalls.some((call) => call.endpoint === 'archiveMemory' && call.payload.id === 'mem-live'))

  // The archived tab now holds both rows; restore → memoryRestored.
  const archivedTab = next.nodes.filter((node) => node.props?.role === 'tab'
    && String(node.props?.children || '').startsWith('browseArchivedTab'))
  assert.equal(archivedTab.length, 1)
  archivedTab[0].props.onClick()
  next = await rerender()
  const restoreButtons = next.nodes.filter((node) => typeof node.type === 'function' && node.props?.children === 'restore')
  assert.equal(restoreButtons.length, 2, 'both archived rows offer restore')
  restoreButtons[1].props.onClick()
  await settle(); await settle()
  next = await rerender()
  assert.ok(next.text.includes('memoryRestored'), 'restoreMemory did not report memoryRestored')
  assert.ok(rpcCalls.some((call) => call.endpoint === 'updateMemory' && call.payload.id === 'mem-gone' && call.payload.patch.status === 'active'))

  // deleteMemoryForever → memoryDeleted (two-step confirm on the last archived row)
  const armButtons = next.nodes.filter((node) => typeof node.type === 'function' && node.props?.children === 'deleteForever')
  assert.ok(armButtons.length >= 1, 'the archived delete button did not render')
  armButtons[0].props.onClick()
  next = await rerender()
  const confirmButtons = next.nodes.filter((node) => typeof node.type === 'function' && node.props?.children === 'confirmDelete')
  assert.equal(confirmButtons.length, 1, 'the armed confirm did not render')
  confirmButtons[0].props.onClick()
  await settle(); await settle()
  next = await rerender()
  assert.ok(next.text.includes('memoryDeleted'), 'deleteMemoryForever did not report memoryDeleted')
  assert.ok(rpcCalls.some((call) => call.endpoint === 'deleteMemory' && call.payload.id === 'mem-live'))
})

test('the memory wall reports save, archive and bulk outcomes through onNotice', async (t) => {
  createdNodes.length = 0
  const rpcCalls = []
  const ctx = fakeCtx({ answers: makeAnswers(), rpcCalls })
  globalThis.__dshMemuExports.apply(ctx)
  const settings = registrations.filter((r) => r.slot === 'settings.section').pop()
  const props = { ctx, t: (key) => key }
  const first = await renderPage(settings.component, props, undefined, { remount: true })
  collectPageHook()
  for (const effect of first.effects) effect.fn()
  await settle(); await settle()

  const rerenderAt = async (page) => {
    const { tree, effects } = await renderPage(settings.component, props, page)
    const nodes = []
    walkNodes(tree, (node) => { nodes.push(node) })
    return { tree, nodes, text: treeText(tree), effects }
  }
  // Jump to the wall page and let its own effects fetch; browseWall is
  // effect-driven, unlike the browser page's handler-driven reload.
  let view = await rerenderAt(9)
  for (const effect of view.effects) effect.fn()
  await settle(); await settle()
  view = await rerenderAt(9)
  const wallItems = view.nodes.filter((node) => node.type === 'button' && String(node.props?.className || '').includes('dshm-wall-item'))
  assert.equal(wallItems.length, 1, 'the wall item did not render')
  wallItems[0].props.onClick()
  await settle(); await settle()
  view = await rerenderAt(9)

  // The drawer is open and editable: save → memorySaved.
  const saveButtons = view.nodes.filter((node) => typeof node.type === 'function' && node.props?.children === 'save')
  assert.equal(saveButtons.length, 1, 'the drawer save button did not render')
  saveButtons[0].props.onClick()
  await settle(); await settle()
  view = await rerenderAt(9)
  assert.ok(view.text.includes('memorySaved'), 'the wall save did not reach the page notice')

  // Archive from the drawer → memoryArchived.
  const archiveButtons = view.nodes.filter((node) => typeof node.type === 'function' && node.props?.children === 'archive')
  assert.equal(archiveButtons.length, 1, 'the drawer archive button did not render')
  archiveButtons[0].props.onClick()
  await settle(); await settle()
  view = await rerenderAt(9)
  assert.ok(view.text.includes('memoryArchived'), 'the wall archive did not reach the page notice')

  // Close the drawer, enter multi-select, select all, bulk archive → bulkDone.
  const closeButtons = view.nodes.filter((node) => typeof node.type === 'function' && node.props?.children === 'close')
  assert.ok(closeButtons.length >= 1)
  closeButtons[closeButtons.length - 1].props.onClick()
  view = await rerenderAt(9)
  const multiButtons = view.nodes.filter((node) => typeof node.type === 'function' && node.props?.children === 'multiSelect')
  assert.equal(multiButtons.length, 1, 'the multi-select entry did not render')
  multiButtons[0].props.onClick()
  view = await rerenderAt(9)
  const selectAll = view.nodes.filter((node) => typeof node.type === 'function' && node.props?.children === 'wallSelectAll')
  assert.equal(selectAll.length, 1)
  selectAll[0].props.onClick()
  view = await rerenderAt(9)
  const bulkArchive = view.nodes.filter((node) => typeof node.type === 'function' && node.props?.children === 'archive (1)')
  assert.equal(bulkArchive.length, 1, 'the bulk archive button did not render')
  bulkArchive[0].props.onClick()
  await settle(); await settle()
  view = await rerenderAt(9)
  assert.ok(view.text.includes('bulkDone'), 'the bulk success notice did not appear')
  assert.ok(rpcCalls.some((call) => call.endpoint === 'updateMemory' && call.payload.id === 'mem-wall' && call.payload.patch.status === 'archived'))
})
