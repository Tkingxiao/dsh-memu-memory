// 帮助页与首次安装引导（施工稿 §6.5 包 E）+ 实体孤立分组的渲染断言（§6.4 包 D 第 5 条）。
// 沿用 client-render.test.mjs 的最小 React 运行时：一个在渲染期 throw 的页面块就是
// 白屏，必须在构建期失败而不是静默白板。每一页都渲染，因为块只在选中该页时挂载。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const clientSource = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function makeElement(type, props, ...children) {
  return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }
}

let hooks = []
let cursor = 0
let effects = []
let forcedList = []
let generation = 0

const React = {
  createElement: makeElement,
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const index = cursor++
    const generation_ = generation
    if (hooks[index] === undefined) hooks[index] = typeof initial === 'function' ? initial() : initial
    const forced = forcedList.find((entry) => entry.index === index)
    if (forced) hooks[index] = forced.value
    return [hooks[index], (next) => {
      if (generation_ !== generation) return
      hooks[index] = typeof next === 'function' ? next(hooks[index]) : next
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
  location: { hash: '', href: 'http://localhost/', search: '' },
  history: { replaceState() {} },
  __ModuleLoader__: {
    load({ factory }) {
      globalThis.__dshMemuHelpExports = factory((name) => {
        if (name === 'react') return React
        throw new Error(`unexpected require: ${name}`)
      })
    },
  },
  addEventListener() {},
  removeEventListener() {},
}
globalThis.document = {
  createElement: () => ({ style: {}, attrs: {}, children: [], setAttribute() {}, addEventListener() {}, appendChild(child) { return child }, remove() {}, click() {} }),
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
  head: { appendChild() {} },
  body: { appendChild() {}, style: {} },
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

const DEFAULT_ANSWERS = {
  getState: EMPTY_STATE,
  getSettingsState: EMPTY_STATE,
  getPrompts: { prompts: [] },
  listVersions: { ok: true, versions: [] },
  listBackups: { backups: [] },
  listFolders: { folders: [] },
  listLibraries: { libraries: [] },
  listSessions: { sessions: [] },
  getSidebarState: { binding: null, domain: 'general', folder: null, effective: {}, private: { items: [], active: 0, pinned: 0, total: 0 }, global: { items: [], active: 0, total: 0 }, domains: [] },
  jobStatus: null,
  browseWall: { items: [], total: 0 },
  browseLibrary: { source: 'engine', files: [] },
  getGraph: { nodes: [], edges: [], limit: 200, truncated: false, focusId: null },
  listEntities: { items: [], total: 0 },
}

const registrations = []
const rpcCalls = []

function fakeCtx(answers = {}) {
  const merged = { ...DEFAULT_ANSWERS, ...answers }
  return {
    effect: (fn) => { try { fn() } catch {} },
    locale: { register: () => () => {}, bind: () => (key) => key, get: () => 'zh' },
    connection: {
      rpc: {
        call: async (path, endpoint, payload) => {
          rpcCalls.push({ endpoint, payload })
          return { ok: true, value: merged[endpoint] ?? {} }
        },
      },
    },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: {}, ids: [] }) } },
    get: () => undefined,
    slots: {
      inject: (_name, callback) => callback(scope),
      register: (spec, component) => { registrations.push({ slot: spec.name, component }); return () => {} },
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
  register: (spec, component) => { registrations.push({ slot: spec.name, component }); return () => {} },
  inject: (_deps, callback) => callback(scope),
}

let pageHookIndex = -1

function collectPageHook() {
  const zeroes = hooks.map((value, index) => (value === 0 ? index : -1)).filter((index) => index >= 0)
  assert.equal(zeroes.length, 1, 'expected exactly one numeric-zero state (the page index)')
  pageHookIndex = zeroes[0]
}

async function mountAndSettle(component, props, { standalone = false } = {}) {
  hooks = []
  forcedList = []
  generation++
  pageHookIndex = -1
  effects = []
  cursor = 0
  const tree = component({ ...props, ...(standalone ? { standalone: true } : {}) })
  assert.ok(tree, 'component rendered nothing')
  for (const effect of effects) effect.fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  return tree
}

function renderAt(component, props, pageValue, extraForced = []) {
  effects = []
  cursor = 0
  forcedList = [{ index: pageHookIndex, value: pageValue }, ...extraForced]
  const tree = component(props)
  assert.ok(tree, 'component rendered nothing')
  return { tree, effects }
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

function settingsComponent() {
  const registration = registrations.filter((entry) => entry.slot === 'settings.section').pop()
  assert.ok(registration?.component, 'settings.section was not registered')
  return registration.component
}

test('all thirteen settings pages render, and the nav carries the help entry', async () => {
  const ctx = fakeCtx()
  globalThis.__dshMemuHelpExports.apply(ctx)
  const component = settingsComponent()
  const props = { ctx, t: (key) => key }

  await mountAndSettle(component, props)
  collectPageHook()

  const NAV = ['pageOverview', 'pageConnection', 'pageSettings', 'pageFolders', 'pageLibraries', 'pageBrowser', 'pageGlobal', 'pagePrompts', 'pageStats', 'pageMemories', 'pageLogs', 'pageLexicon', 'pageHelp']
  for (let page = 0; page < 13; page++) {
    const { tree } = renderAt(component, props, page)
    const text = treeText(tree)
    assert.match(String(tree.props?.className), /dshm-root/, `page ${page} did not render the shell`)
    assert.ok(NAV.every((key) => text.includes(key)), `page ${page} lost a nav entry (pageHelp included)`)
    assert.equal((text.match(/dshm-nav-ind/g) || []).length, 1, `page ${page} lost or duplicated its rail indicator`)
    assert.match(text, /dshm-page/, `page ${page} lost the content pane`)
    assert.ok(!text.includes('[object Object]'), `page ${page} rendered an object as text`)
  }
})

test('the deep link #/settings/help lands on the help page when standalone', async () => {
  const component = settingsComponent()
  const props = { ctx: fakeCtx(), t: (key) => key }
  window.location.hash = '#/settings/help'

  await mountAndSettle(component, props, { standalone: true })
  // hooks 已经带着 page=12（初始器读 hash）；再渲染一次即命中帮助页。
  forcedList = []
  effects = []
  cursor = 0
  const tree = component({ ...props, standalone: true })
  const text = treeText(tree)
  assert.match(text, /helpQuickStart/, 'the deep link must open the quick start section')
  assert.match(text, /helpFaq/, 'the deep link must open the FAQ section')
  assert.match(text, /helpFeedback/, 'the deep link must open the feedback section')
  window.location.hash = ''
})

test('the help page shows five steps, eleven FAQ details and the feedback actions', async () => {
  const component = settingsComponent()
  const props = { ctx: fakeCtx(), t: (key) => key }
  await mountAndSettle(component, props)
  collectPageHook()

  const { tree } = renderAt(component, props, 12)
  const text = treeText(tree)
  for (const step of [1, 2, 3, 4, 5]) assert.ok(text.includes(`helpStep${step}`), `quick start step ${step} is missing`)
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
    assert.ok(text.includes(`helpFaq${n}`), `FAQ item ${n} is missing`)
    assert.ok(text.includes(`helpFaq${n}A`), `FAQ answer ${n} is missing`)
  }
  assert.ok(text.includes('helpQuickStart') && text.includes('helpFaq') && text.includes('helpFeedback'), 'the three help sections are all present')
  assert.ok(text.includes('helpOpenIssue'), 'the issue button is missing')
  assert.ok(text.includes('helpCopyDiagnostics'), 'the copy-diagnostics button is missing')
  assert.ok(text.includes('helpDocs'), 'the docs link is missing')
  // FAQ 用 11 个 <details> 折叠；quick start 的每一步都带「前往 →」跳转按钮
  //（第 2 步是会话侧动作，只给文案，不带跳转 → 4 个按钮）。
  const details = []
  walkNodes(tree, (node) => {
    if (node.type === 'details') details.push(node)
  })
  assert.equal(details.length, 11, `expected eleven FAQ details, found ${details.length}`)
  assert.equal((text.match(/helpGoTo/g) || []).length, 4, 'four of the five steps jump, the bind step cannot')
  // 不新增 RPC：复制诊断只序列化 getSettingsState 的既有快照（state 优先，缺了才补拉）。
  const src = clientSource
  assert.ok(src.includes('https://github.com/Tkingxiao/dsh-memu-memory/issues/new'), 'the issue URL is wired')
  assert.ok(src.includes('https://github.com/Tkingxiao/dsh-memu-memory#readme'), 'the docs URL is wired')
  assert.match(src, /const snapshot = state \|\| await call\('getSettingsState', \{\}\)/, 'diagnostics reuse getSettingsState instead of a new RPC')
  assert.match(src, /helpStep1[\s\S]*PAGE\.libraries[\s\S]*helpStep3[\s\S]*PAGE\.settings[\s\S]*helpStep4[\s\S]*PAGE\.memories[\s\S]*helpStep5[\s\S]*PAGE\.lexicon/, 'the steps point at the documented pages')
  assert.match(src, /\{ key: 'helpStep2', to: null \}/, 'the bind step stays a text-only step')
})

test('the detailed help sections and label table render between quick start and FAQ', async () => {
  const component = settingsComponent()
  const props = { ctx: fakeCtx(), t: (key) => key }
  await mountAndSettle(component, props)
  collectPageHook()

  const { tree } = renderAt(component, props, 12)
  const text = treeText(tree)
  for (const section of ['helpScopes', 'helpTitleCards', 'helpArchiveDelete', 'helpVector', 'helpAutoLink', 'helpLabels', 'helpSidebar']) {
    assert.ok(text.includes(section), `help section ${section} is missing`)
  }
  // 四区详解必须夹在快速开始与 FAQ 之间，反馈块保持最后。
  const order = ['helpQuickStart', 'helpScopes', 'helpTitleCards', 'helpArchiveDelete', 'helpVector',
    'helpAutoLink', 'helpLabels', 'helpSidebar', 'helpFaq', 'helpFeedback'].map((key) => text.indexOf(key))
  assert.ok(order.every((index) => index >= 0), 'every help block must be present')
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'help blocks must render in the documented order')
  for (const key of [
    'helpScopesChain', 'helpScopesPrivate', 'helpScopesGlobal', 'helpScopesWhere',
    'helpScopesPitfall1', 'helpScopesPitfall2', 'helpScopesPitfall3',
    'helpTitleCardsBody', 'helpTitleCardsRecall', 'helpTitleCardsRule',
    'helpArchiveDeleteArchive', 'helpArchiveDeleteDelete', 'helpArchiveDeleteLexicon',
    'helpArchiveDeleteAbsorb', 'helpArchiveDeleteSessionGone',
    'helpVectorSetup', 'helpVectorCount', 'helpVectorFallback', 'helpVectorRebuild',
    'helpAutoLinkRule', 'helpAutoLinkHub', 'helpAutoLinkWorker', 'helpAutoLinkSafety',
    'helpSidebarAlerts', 'helpSidebarReview', 'helpSidebarRunLog', 'helpSidebarReviewMode',
    'helpSidebarFirstRun', 'helpSidebarFallback', 'helpSidebarScope',
  ]) assert.ok(text.includes(key), `help body ${key} is missing`)

  // 标注表固定 2 列 9 行：行上的 data-help-row 携带 i18n key，顺序即规范顺序。
  const tables = []
  const rows = []
  walkNodes(tree, (node) => {
    if (node.props?.['data-help-table'] === 'labels') tables.push(node)
    if (node.props?.['data-help-row']) rows.push(node.props['data-help-row'])
  })
  assert.equal(tables.length, 1, 'exactly one label cheat sheet')
  assert.deepEqual(rows, [
    'helpLabelSource', 'helpLabelLayer', 'helpLabelOpenLoop', 'helpLabelMarginalized', 'helpLabelDate',
    'helpLabelAttachment', 'helpLabelVector', 'helpLabelReviewRisk', 'helpLabelLexicon',
  ], 'the label table must carry nine rows in order')
  for (const key of rows) assert.ok(text.includes(key), `label row ${key} is missing its text`)
  for (const key of ['helpLabelSourceMeaning', 'helpLabelLayerMeaning', 'helpLabelOpenLoopMeaning',
    'helpLabelMarginalizedMeaning', 'helpLabelDateMeaning', 'helpLabelAttachmentMeaning',
    'helpLabelVectorMeaning', 'helpLabelReviewRiskMeaning', 'helpLabelLexiconMeaning']) {
    assert.ok(text.includes(key), `label meaning ${key} is missing`)
  }
})

test('the first-run card shows only when no library exists yet', async () => {
  // 没有库：卡片出现在 MemU 记忆页顶部，两个按钮分别指向建库页与帮助页。
  const component = settingsComponent()
  const emptyProps = { ctx: fakeCtx(), t: (key) => key }
  await mountAndSettle(component, emptyProps)
  collectPageHook()
  const emptyRun = renderAt(component, emptyProps, 9)
  const emptyText = treeText(emptyRun.tree)
  assert.match(emptyText, /firstRunTitle/, 'the first-run card is missing with zero libraries')
  assert.match(emptyText, /firstRunDesc/)
  assert.match(emptyText, /firstRunGoLibraries/, 'the create-library button is missing')
  assert.match(emptyText, /firstRunGuide/, 'the guide button is missing')

  // 已有库：卡片消失（不落 localStorage，库存在即退场）。
  const loaded = { ...EMPTY_STATE, libraries: [{ id: 'lib-1', name: 'demo', scopeKey: '/proj/demo', privateCount: 0 }] }
  const loadedProps = { ctx: fakeCtx({ getState: loaded, getSettingsState: loaded }), t: (key) => key }
  await mountAndSettle(component, loadedProps)
  collectPageHook()
  const loadedRun = renderAt(component, loadedProps, 9)
  assert.ok(!treeText(loadedRun.tree).includes('firstRunTitle'), 'the first-run card must disappear once a library exists')
})

// GraphPanel 只在 browserBlock 的 relations 视图挂载，而嵌套组件只在树被展开时
// 执行：先渲染并展开（初始化面板 hooks + 收集它的 fetch effects），跑完 effects
// 落定后再渲染展开一次。注意最终树只能展开一次——walkNodes 和 treeText 各展开
// 一遍会让第二次跑在错位的 hook 游标上，读出空状态。
function walkAndText(node, sink, depth = 0) {
  if (node === null || node === undefined || depth > 400) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => walkAndText(child, sink, depth + 1)).join(' ')
  if (typeof node.type === 'function') return walkAndText(node.type(node.props), sink, depth + 1)
  if (node.type === 'details' && String(node.props?.className || '').includes('dshm-graph-orphans')) sink.push(node)
  return `${node.props?.className || ''} ${walkAndText(node.props?.children, sink, depth + 1)}`
}

async function relationsTree(component, props, pageHook, viewIndex) {
  const forced = [{ index: pageHook, value: 5 }, { index: viewIndex, value: 'relations' }]
  effects = []
  cursor = 0
  forcedList = forced
  const mounted = component(props)
  assert.ok(mounted, 'relations view rendered nothing')
  treeText(mounted)
  for (const effect of effects) effect.fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  effects = []
  cursor = 0
  forcedList = forced
  const tree = component(props)
  const orphanDetails = []
  const text = walkAndText(tree, orphanDetails)
  return { text, orphanDetails }
}

test('orphan entities collapse into one details block; linked rows stay in the main list', async () => {
  const loaded = { ...EMPTY_STATE, libraries: [{ id: 'lib-1', name: 'demo', scopeKey: '/proj/demo', privateCount: 0 }] }
  const component = settingsComponent()
  const props = { ctx: fakeCtx({
    getState: loaded,
    getSettingsState: loaded,
    listEntities: {
      items: [
        { id: 'ent-linked', name: 'Linked', kind: 'person', aliases: [], linked: true },
        { id: 'ent-ghost', name: 'Ghost', kind: 'person', aliases: [], linked: false },
      ],
      total: 2,
    },
  }), t: (key) => key }

  await mountAndSettle(component, props)
  collectPageHook()
  const activeIndexes = hooks.map((value, index) => (value === 'active' ? index : -1)).filter((index) => index >= 0)
  assert.equal(activeIndexes.length, 1, 'expected exactly one "active" state (the browser view)')
  const { text, orphanDetails } = await relationsTree(component, props, pageHookIndex, activeIndexes[0])
  assert.equal(orphanDetails.length, 1, 'exactly one collapsed orphan group')
  const summary = treeText(orphanDetails[0])
  assert.match(summary, /orphanEntities/, 'the summary must carry the orphan label')
  assert.match(summary, /orphanPruneHint/, 'the group must note the startup prune')
  assert.match(summary, /entityDelete/, 'the orphan keeps its delete button inside the group')
  assert.match(text, /Linked/, 'the linked entity is rendered by name')
  assert.match(text, /Ghost/, 'the orphan entity is rendered by name')

  // 没有孤立实体：不渲染折叠区；没有实体：给出 entityEmpty 空态。
  const cleanProps = { ctx: fakeCtx({ getState: loaded, getSettingsState: loaded, listEntities: { items: [{ id: 'ent-ok', name: 'Ok', kind: 'person', aliases: [], linked: true }], total: 1 } }), t: (key) => key }
  await mountAndSettle(component, cleanProps)
  collectPageHook()
  const cleanIndexes = hooks.map((value, index) => (value === 'active' ? index : -1)).filter((index) => index >= 0)
  assert.equal(cleanIndexes.length, 1)
  const clean = await relationsTree(component, cleanProps, pageHookIndex, cleanIndexes[0])
  assert.equal(clean.orphanDetails.length, 0, 'no orphan group may render when every entity is linked')

  const noneProps = { ctx: fakeCtx({ getState: loaded, getSettingsState: loaded, listEntities: { items: [], total: 0 } }), t: (key) => key }
  await mountAndSettle(component, noneProps)
  collectPageHook()
  const noneIndexes = hooks.map((value, index) => (value === 'active' ? index : -1)).filter((index) => index >= 0)
  assert.equal(noneIndexes.length, 1)
  const none = await relationsTree(component, noneProps, pageHookIndex, noneIndexes[0])
  assert.match(none.text, /entityEmpty/, 'an empty entity list shows the empty state')
})
