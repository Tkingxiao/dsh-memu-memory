// dsh-memu-memory 链路回放巡检 — 不走测试框架，按生产代码路径端到端重放五条链路。
//
//   npm run replay
//
// 与 npm test 的分工：测试钉住单元与契约，这里回答"五条真实链路在当前代码下还能不能
// 一口气走通"。只有 Python 引擎子进程换成内存桩（证明链路通路，不证明 embedding 本身），
// 其余全是生产模块：真实工具层、真实迁移账本落盘、真实活动日志、真实 React 渲染。
// 退出码 0 = 全部检查点通过；失败会列出每个 FAIL 的检查点名。
import { registerHooks } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO_URL = new URL('../', import.meta.url)
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-replay-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const results = []
function check(name, cond, extra = '') {
  results.push({ name, ok: Boolean(cond) })
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '  << ' + extra))
}
async function phase(title, fn) {
  console.log('\n== ' + title + ' ==')
  try { await fn() } catch (error) { check(title + '（阶段异常）', false, error?.stack || String(error)) }
}

// ---------------------------------------------------------------- 引擎桩
// memu.js 的 Python 子进程整只换成内存行存：commit/forget/listFiles 都记账，
// 向量回放用它证明"引擎写入真发生了"。
const memuRows = new Map()
const memuCalls = { commit: [], forget: [], listFiles: 0 }
globalThis.__memuRows = memuRows
globalThis.__memuCalls = memuCalls
const engineSource = `
const rows = globalThis.__memuRows, calls = globalThis.__memuCalls
export const commit = async ({ payload, db }) => {
  calls.commit.push({ db, names: payload.recall_files.map(r => r.name) })
  for (const row of payload.recall_files) rows.set(db + '|' + row.name, row)
  return { ok: true }
}
export const retrieve = async () => ({ files: [] })
export const forget = async ({ db, name }) => {
  calls.forget.push({ db, name })
  rows.delete(db + '|' + name)
  return { deleted: 1, segments: 1 }
}
export const listFiles = async ({ db }) => {
  calls.listFiles += 1
  return [...rows.keys()].filter(k => k.startsWith(db + '|')).map(k => k.split('|')[1])
}
`
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './memu.js') return { url: 'data:text/javascript,' + encodeURIComponent(engineSource), shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const state = (await import(new URL('lib/state.js', REPO_URL)))
const memory = (await import(new URL('lib/memory.js', REPO_URL)))
const tools = await import(new URL('lib/tools.js', REPO_URL))
const privateMod = await import(new URL('lib/private.js', REPO_URL))
const rpcMod = await import(new URL('lib/rpc.js', REPO_URL))
const activity = await import(new URL('lib/activity-log.js', REPO_URL))
const vm = await import(new URL('lib/vector-migration.js', REPO_URL))
const vp = await import(new URL('lib/vector-profile.js', REPO_URL))
const { resetActivityLogCache, listEvents } = activity
const { dispatch } = rpcMod

const execFor = (sessionId, preset = 'standard') => {
  const b = state.getSessionBinding(sessionId)
  return { agent: { session: { header: { id: sessionId, cwd: b?.scopeKey || '', agentPreset: preset } } } }
}

// ---------------------------------------------------------------- 通用：抓真实工具面
function captureTools() {
  const map = new Map()
  const dispose = tools.registerTools({ tools: { register: (tool) => { map.set(tool.name, tool); return () => {} } }, logger: { warn: () => {} } })
  return { map, dispose }
}

// ================================================================ 回放 1：dedup
await phase('回放 1 · 事实级去重：真实工具层写入 → 拒绝 → 逃生口 → 召回折叠', async () => {
  resetActivityLogCache()
  state.updateSettings({ memoryBackend: 'agent', vectorSource: 'local' })
  state.ensureSession('dup-session', { cwd: path.join(home, 'proj-dup'), agentPreset: 'standard' })
  const exec = execFor('dup-session')
  const { map } = captureTools()
  const remember = map.get('memu_private_remember')
  const libId = state.getSessionBinding('dup-session').libraryId

  const first = await remember.execute({ content: '我不吃香菜，闻到就难受。', title: '口味' }, exec)
  const firstId = /已写入私有记忆：(mem-\S+)/.exec(String(first))?.[1]
  check('第一次写入成功并返回 id', Boolean(firstId), String(first).slice(0, 120))

  const second = await remember.execute({ content: '我不吃香菜，闻到就难受。', title: '口味' }, exec)
  check('第二次几乎相同 → 工具层明确拒绝并给 existingId', /未写入/.test(String(second)) && String(second).includes(firstId), String(second).slice(0, 160))
  check('库内条数仍是 1（没有写进重复条目）', Object.keys(state.loadPrivateIndex(libId).entries).length === 1)
  const dupRow = listEvents({ kind: 'write', limit: 3 })[0]
  check('活动日志留了"拒绝重复写入"信号', /拒绝重复写入/.test(dupRow?.message || ''))

  const third = await remember.execute({ content: '我不吃香菜，闻到就难受。', title: '口味', allow_duplicate: true }, exec)
  const thirdId = /已写入私有记忆：(mem-\S+)/.exec(String(third))?.[1]
  check('allow_duplicate 逃生口：确属独立观测时放行', Boolean(thirdId) && thirdId !== firstId, String(third).slice(0, 120))
  check('库内条数 2', Object.keys(state.loadPrivateIndex(libId).entries).length === 2)

  const recalled = await memory.privateRecall({ exec, query: '香菜 过敏 难受', topK: 5, relevanceThreshold: 0 })
  const ids = (recalled.files || []).map(f => f.name)
  check('召回侧按簇折叠：两条同事实只出 1 条', ids.length === 1 && (ids[0] === firstId || ids[0] === thirdId), 'ids=' + JSON.stringify(ids))
})

// ================================================================ 回放 2/3：PTC 整理
const childCtxs = new Map()
function ptcHost({ workerReceipt = true } = {}) {
  const rec = { created: [], registered: [], disposed: [], toolCalls: [] }
  const ctx = {
    rec,
    on: (name, handler) => { if (name !== 'session/event') return () => {}; (rec.handlers ??= []).push(handler); return () => {} },
    get: (name) => {
      if (name === 'agents') {
        return {
          get: (id) => {
            if (childCtxs.has(id)) return { ctx: childCtxs.get(id) }
            return { session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' }, tools: [{ name: 'run_code' }] }) } }
          },
          create: async (spec) => {
            rec.created.push(spec)
            // 子会话 ctx：worker 的工具就挂在这里 —— 用一个真注册表接住 attachWorkerTools
            // 的注册，"run_code 程序"从里面按名字取工具执行（= 宿主 SDK 绑定的行为）。
            const registry = new Map()
            childCtxs.set(spec.sessionId, {
              tools: { register: (tool) => { registry.set(tool.name, tool); rec.registered.push(tool.name); return () => { rec.disposed.push(tool.name) } } },
            })
            const childSession = { id: spec.sessionId }
            // followup 只入队（生产契约），whenIdle 才等真正跑完：work promise 承载 worker 的异步过程。
            let work = Promise.resolve()
            return {
              agent: {
                session: childSession,
                followup: (message) => {
                  work = (async () => {
                    // —— 模拟 PTC worker：在 run_code 里调 tools.memu_private_remember ——
                    const remember = registry.get('memu_private_remember')
                    const childBinding = state.getSessionBinding(spec.sessionId)
                    let createdId = null
                    if (remember) {
                      const text = await remember.execute({ content: 'PTC 会话整理出的记忆：部署密钥放在保险柜。', title: 'ptc-整理' }, { agent: { session: { header: { id: spec.sessionId, cwd: childBinding.scopeKey, agentPreset: 'yuike-ptc' } } } })
                      createdId = /已写入私有记忆：(mem-\S+)/.exec(String(text))?.[1] || null
                      rec.toolCalls.push({ tool: 'memu_private_remember', text: String(text).slice(0, 60) })
                    }
                    if (workerReceipt && createdId) {
                      const fence = ['```memu-consolidation-receipt', JSON.stringify({ version: 1, jobId: childBinding.jobId, snapshotHash: childBinding.snapshotHash, status: 'completed', outcome: 'created', checkedRange: { fromSeq: 0, throughSeq: 4 }, createdIds: [createdId], updatedIds: [], heldIds: [], reasonCode: null, retryable: false }), '```'].join('\n')
                      for (const handler of rec.handlers ?? []) handler(childSession, { type: 'assistant/message', seq: 90, data: { message: { content: [{ type: 'text', text: fence }] } } })
                    }
                    for (const handler of rec.handlers ?? []) handler(childSession, { type: 'turn/end', seq: 91, data: { turn: 1, reason: { kind: 'completed' } } })
                  })()
                },
                whenIdle: () => work,
              },
              dispose: async () => { rec.disposedChild = true },
            }
          },
        }
      }
      if (name === 'sessionQuery') {
        return {
          readSession: async () => ({
            events: [
              { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我记一下密钥放哪了' }] } },
              { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的' }] } } },
              { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
              { seq: 3, type: 'tool/ptc-dispatch', data: { rootCallId: 'r1', parentCallId: 'r1', subCallId: 'r1:ptc:1', name: 'read', arguments: {}, isError: false, content: [] } },
              { seq: 4, type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' }, tools: [{ name: 'run_code' }] } } },
            ],
            session: { cwd: path.join(home, 'proj-ptc'), agentPreset: 'yuike-ptc' },
          }),
        }
      }
      return undefined
    },
  }
  return ctx
}

await phase('回放 2 · PTC 整理成功链路：probe → fork → 挂载 → worker 真调工具 → 回执凭证', async () => {
  resetActivityLogCache()
  state.updateSettings({ memoryBackend: 'agent', vectorSource: 'local' })
  state.ensureSession('ptc-live', { cwd: path.join(home, 'proj-ptc'), agentPreset: 'yuike-ptc' })
  const ctx = ptcHost({})
  const result = await privateMod.requestPrivateConsolidation(ctx, 'ptc-live', { force: true })
  check('run_code-only header 不再被拒（旧版报 worker-tools-ptc-only）', ctx.rec.created.length === 1, result.error || '')
  check('worker 面只挂读写四件', JSON.stringify([...ctx.rec.registered].sort()) === JSON.stringify(['memu_private_list', 'memu_private_recall', 'memu_private_remember', 'memu_private_update']), JSON.stringify(ctx.rec.registered))
  check('worker 真的通过挂载的工具写入了', ctx.rec.toolCalls.length === 1 && /已写入/.test(ctx.rec.toolCalls[0].text), JSON.stringify(ctx.rec.toolCalls))
  check('回执被对账为完成（settled，写入 1 条）', result.ok === true && result.settled === true && result.wrote === 1, JSON.stringify({ ok: result.ok, reasonCode: result.reasonCode, error: result.error }))
  check('整理游标推进', (state.getSessionBinding('ptc-live')?.lastSleepSeq ?? 0) === 4)
  const started = listEvents({ kind: 'consolidate', limit: 5 }).find(r => (r.detail || {}).phase === 'started')
  check('开始日志带 probe 证据（ptc-header）', started?.detail?.probe?.source === 'ptc-header' && started?.detail?.probe?.ptc === true, JSON.stringify(started?.detail?.probe))
  check('开始日志带挂载清单', Array.isArray(started?.detail?.workerToolsAttached) && started.detail.workerToolsAttached.length === 4)
  check('整理结束挂载已卸载（不留常驻注册）', ctx.rec.disposed.length === 4)
})

await phase('回放 3 · PTC 整理失败链路：无回执 → 诚实失败 → 失败可观测', async () => {
  state.ensureSession('ptc-fail', { cwd: path.join(home, 'proj-ptc-fail'), agentPreset: 'yuike-ptc' })
  const ctx = ptcHost({ workerReceipt: false })
  const result = await privateMod.requestPrivateConsolidation(ctx, 'ptc-fail', { force: true })
  check('fork 照常创建（不因 PTC 拒绝）', ctx.rec.created.length === 1)
  check('无回执 = 诚实的 receipt-missing 失败', result.ok === false && result.reasonCode === 'receipt-missing', JSON.stringify({ reasonCode: result.reasonCode }))
  const errRow = listEvents({ kind: 'consolidate', level: 'error', limit: 5 })[0]
  check('失败进了活动日志（error 级）', errRow?.ok === false && /receipt-missing/.test(errRow?.message || ''))
})

// ================================================================ 回放 4：提醒 + 日志页
const titledCtx = {
  get: (name) => (name === 'sessionQuery'
    ? { readTitleSnapshots: async (ids) => ids.map((id) => ({
        sessionId: id,
        status: 'fulfilled',
        value: { title: { title: id === 'ptc-live' ? '公主的深夜备份会话' : 'PTC 失败的会话' } },
      })) }
    : undefined),
}

await phase('回放 4 · 整理提醒 + 日志页数据链路：失败/成功分列、标题与库名、瘦身', async () => {
  const feed = await dispatch(titledCtx, 'getConsolidationFeed', { limit: 6 })
  const failRow = (feed.failures || []).find(r => r.sessionId === 'ptc-fail')
  const okRow = (feed.successes || []).find(r => r.sessionId === 'ptc-live')
  check('失败列里有 ptc-fail，且带会话标题', failRow && failRow.sessionTitle === 'PTC 失败的会话', JSON.stringify(feed.failures?.map(r => [r.sessionId, r.sessionTitle])))
  check('失败行带库名与 reasonCode（跳转与提示的数据都在）', Boolean(failRow?.libraryName) && failRow.reasonCode === 'receipt-missing')
  check('成功列里有 ptc-live（与失败分列）', Boolean(okRow) && okRow.ok !== false)
  check('回执 detail 不整包透传（行已瘦身）', failRow && failRow.detail === undefined)
  const logs = await dispatch(titledCtx, 'getActivityLog', { kind: 'consolidate', limit: 20 })
  check('日志页行带会话标题与库名', logs.events.every(r => typeof r.sessionTitle === 'string' || r.sessionTitle === null) && logs.events.some(r => r.libraryName))
})

// ---- 客户端真实渲染回放（与 tests/client-render 同款最小 React 运行时）----
const registrations = []
const jumpTargets = []
let localeDict = null
let reactHooks = []
let forced = null
let cursor = 0
let effects = []
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }),
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const i = cursor++
    if (forced && forced.index === i) reactHooks[i] = forced.value
    else if (reactHooks[i] === undefined) reactHooks[i] = typeof initial === 'function' ? initial() : initial
    return [reactHooks[i], (next) => { reactHooks[i] = typeof next === 'function' ? next(reactHooks[i]) : next }]
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useEffect(fn) { effects.push(fn) },
  useLayoutEffect() {},
  useRef: (v) => ({ current: v }),
  useSyncExternalStore: (_s, snap) => snap(),
}
globalThis.window = {
  __ModuleLoader__: { load({ factory }) { globalThis.__dshMemuExports = factory((name) => { if (name === 'react') return React; throw new Error('unexpected require: ' + name) }) } },
  addEventListener() {}, removeEventListener() {},
  open: (url) => { jumpTargets.push(url); return { focus() {}, closed: false } },
  location: { href: 'http://127.0.0.1:8787/' },
}
globalThis.document = {
  visibilityState: 'visible',
  createElement: (tag) => ({ tag, style: {}, attrs: {}, children: [], textContent: '', setAttribute(n, v) { this.attrs[n] = v }, addEventListener() {}, appendChild(c) { this.children.push(c); return c }, remove() {} }),
  querySelector: () => null, addEventListener() {}, removeEventListener() {},
  head: { appendChild() {} }, body: { appendChild() {} },
}
const realSetInterval = globalThis.setInterval
globalThis.setInterval = (fn, ms) => ({ unref() {} })
globalThis.clearInterval = () => {}
await import(new URL('lib/client.js', REPO_URL))
globalThis.setInterval = realSetInterval

function treeWalk(node, fn, depth = 0) {
  if (node === null || node === undefined || depth > 500) return
  fn(node)
  if (Array.isArray(node)) { for (const c of node) treeWalk(c, fn, depth + 1); return }
  if (typeof node === 'object') {
    if (typeof node.type === 'function') { treeWalk(node.type(node.props), fn, depth + 1); return }
    treeWalk(node.props?.children, fn, depth + 1)
  }
}

await phase('回放 5 · 侧边栏提醒块真实渲染：默认收起一条 → 展开 → 清除失败 → 跳转深链', async () => {
  const fakeCtx = {
    effect: (fn) => { try { fn() } catch {} },
    // register(NS, {zh, en}) 把真实词典交给 bind —— t 返回真文案，不是 key。
    locale: { register: (_ns, dict) => { localeDict = dict?.zh || null; return () => {} }, bind: () => (key) => (localeDict?.[key] || key), get: () => 'zh' },
    connection: { rpc: { call: async (_p, endpoint) => {
      // 客户端 rpc() 的契约是信封 { ok, value }：套一层再回。
      let value
      if (endpoint === 'getConsolidationFeed') value = await dispatch(titledCtx, 'getConsolidationFeed', { limit: 6 })
      else if (endpoint === 'clearConsolidationFailures') value = await dispatch(titledCtx, 'clearConsolidationFailures', { limit: 6 })
      else if (endpoint === 'getActivityLog') value = await dispatch(titledCtx, 'getActivityLog', { sessionId: 'ptc-live', limit: 12 })
      else if (endpoint === 'getSidebarState') value = {
        revision: 1, stamp: 's', domain: 'general',
        // 提醒块挂在 bindingBlock 的"已绑定"分支（记忆设置卡之下），fake 要给真绑定。
        binding: { sessionId: 'ptc-live', libraryId: 'lib-replay', useLibrary: true, useGlobal: true, scopeKey: '/proj/ptc', domain: 'general' },
        folder: { scopeKey: '/proj/ptc', useLibrary: true, useGlobal: true },
        effective: { useLibrary: true, useGlobal: true, enabled: true, folder: { scopeKey: '/proj/ptc', useLibrary: true, useGlobal: true } },
        private: { items: [], active: 0, pinned: 0, total: 0 },
        global: { items: [], active: 0, total: 0 },
        domains: [],
      }
      else if (endpoint === 'listSessions') value = { sessions: [] }
      else value = {}
      return { ok: true, value }
    } } },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: {}, ids: [] }) } },
    get: () => undefined,
    slots: { inject: (_n, cb) => cb({ effect: (fn) => fn(), register: (spec, component) => { registrations.push({ slot: spec.name, component }) } }), register: (spec, component) => { registrations.push({ slot: spec.name, component }); return () => {} } },
    inject: (_d, cb) => cb({ effect: (fn) => { try { fn() } catch {} }, sidebarRightTabs: { register: () => () => {} }, get: () => undefined }),
  }
  globalThis.__dshMemuExports.apply(fakeCtx)
  const tab = registrations.find(r => r.slot === 'sidebar.right.pane.tab')
  check('侧边栏 tab 已注册', Boolean(tab?.component))

  // tab.component() 只生成元素壳；函数组件是在 treeWalk 展开时才真正执行的，
  // 所以时序必须是：展开（注册 effects）→ 跑 effects → 等异步落地 → 再展开收集。
  async function paint() {
    effects = []; cursor = 0
    const shell = tab.component({ ctx: fakeCtx, t: (k) => k, sessionId: 'ptc-live' })
    treeWalk(shell, () => {})
    for (const effect of effects) { try { await effect() } catch {} }
    effects = []; cursor = 0
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    return tab.component({ ctx: fakeCtx, t: (k) => k, sessionId: 'ptc-live' })
  }
  function inspect(tree) {
    let text = ''
    let jumpButton = null
    let toggle = null
    let clearButton = null
    treeWalk(tree, (node) => {
      if (typeof node === 'string' || typeof node === 'number') { text += String(node) + ' '; return }
      if (typeof node !== 'object' || !node.props) return
      if (node.props.children === '↗') jumpButton = node
      if (node.props['aria-expanded'] !== undefined) toggle = node
      if (node.props.children === '清除失败记录') clearButton = node
    })
    return { text, jumpButton, toggle, clearButton }
  }

  // —— 默认收起：只有一条，双列不可见 ——
  const collapsed = inspect(await paint())
  check('提醒块默认收起：只有最新一条（失败优先）', collapsed.jumpButton !== null && !collapsed.clearButton, collapsed.text.slice(0, 200))
  check('收起态不显示成功列', !/成功/.test(collapsed.text), collapsed.text.slice(0, 160))
  check('收起的那条挂的是会话标题（不是裸 id）', /PTC 失败的会话/.test(collapsed.text) && !/ptc-fail/.test(collapsed.text))
  if (collapsed.jumpButton?.props?.onClick) collapsed.jumpButton.props.onClick()
  check('收起态也能跳转深链（?libraryId=…#/settings/browser）', jumpTargets.some(u => /\/dsh-memu-memory\/ui\?libraryId=[^#]+#\/settings\/browser/.test(u)), JSON.stringify(jumpTargets))

  // —— 点击头部展开：失败/成功两列 + 清除按钮 ——
  collapsed.toggle?.props?.onClick?.()
  const opened = inspect(await paint())
  check('展开后双列可见（失败 + 成功）', /失败/.test(opened.text) && /成功/.test(opened.text) && /公主的深夜备份会话/.test(opened.text), opened.text.slice(0, 240))
  check('展开后挂清除失败记录按钮', Boolean(opened.clearButton))

  // —— 清除：只删失败行，成功流水与其它日志不动 ——
  const beforeFeed = await dispatch(titledCtx, 'getConsolidationFeed', { limit: 6 })
  const beforeOthers = listEvents({}).length
  opened.clearButton?.props?.onClick?.()
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  const cleared = inspect(await paint())
  const afterFeed = await dispatch(titledCtx, 'getConsolidationFeed', { limit: 6 })
  check('清除后失败列变空', (afterFeed.failures || []).length === 0 && (beforeFeed.failures || []).length > 0)
  check('成功流水与其它日志保留', (afterFeed.successes || []).length === (beforeFeed.successes || []).length
    && listEvents({}).length === beforeOthers - (beforeFeed.failures || []).length)
  // —— 清除后收起：展开态保持（组件语义），收起回落为最新成功，失败痕迹全部消失 ——
  // 注意：成功行的会话标题本身可以叫"…失败的会话"，所以断言打在失败计数标记上。
  cleared.toggle?.props?.onClick?.()
  const recollapsed = inspect(await paint())
  check('清除后收起：无失败计数、无清除按钮、只剩成功流水', !/失败 \d/.test(recollapsed.text) && !recollapsed.clearButton && /完成/.test(recollapsed.text) && /整理提醒/.test(recollapsed.text), recollapsed.text.slice(0, 200))
})

// ================================================================ 回放 7：MemU 记忆页分组/多选/查看跳转
await phase('回放 7 · MemU 记忆页：私有/全局分组 → 多选批量 → 全局"查看此记忆"跳转', async () => {
  const rpcOps = [] // updateMemory / deleteMemory 的审计记录
  const wallItems = [
    { id: 'mem-a', libraryId: 'lib-r', libraryName: '回放库', title: '私有A', preview: 'pa', layer: 'long_term', status: 'active', source: 'inferred', decay: 0.5, tags: [] },
    { id: 'mem-b', libraryId: 'lib-r', libraryName: '回放库', title: '私有B', preview: 'pb', layer: 'long_term', status: 'archived', source: 'inferred', decay: 0.4, tags: [] },
    { id: 'gmem-x', libraryId: null, libraryName: 'global', title: '全局X', preview: 'gx', layer: 'long_term', status: 'active', source: 'inferred', decay: 0.3, tags: [] },
  ]
  const wallCtx = {
    effect: (fn) => { try { fn() } catch {} },
    locale: { register: (_ns, dict) => { localeDict = dict?.zh || null; return () => {} }, bind: () => (key) => (localeDict?.[key] || key), get: () => 'zh' },
    connection: { rpc: { call: async (_p, endpoint, payload) => {
      let value
      if (endpoint === 'getState') value = {
        engine: { status: 'ready', currentVersion: '0.11.0b3', recommendedVersion: '0.11.0b3', installed: true, versions: [], state: {} },
        settings: { autoInject: 'smart', mustRememberCap: 16, unpinBudgetPerSession: 2 },
        libraries: [{ id: 'lib-r', name: '回放库', scopeKey: '/proj/r' }], archivedLibraries: [],
        memuConfig: { provider: 'openai' }, summaryConfig: {}, binding: null,
        private: { items: [], active: 2, pinned: 0, total: 2 }, global: { items: [], active: 1, total: 1 }, domains: [],
      }
      else if (endpoint === 'browseWall') value = { items: wallItems, total: wallItems.length, libraries: [{ id: 'lib-r', name: '回放库', scopeKey: '/proj/r' }], errors: [] }
      else if (endpoint === 'getMemory') value = { id: payload?.id, libraryId: payload?.libraryId, entry: { title: 'x', content: 'c', layer: 'long_term', status: payload?.id === 'mem-b' ? 'archived' : 'active' }, attachments: [] }
      else if (endpoint === 'updateMemory') {
        rpcOps.push({ op: 'updateMemory', ...payload })
        // 与真实后端同口径：patch.status 真的改变条目状态，池归属随之变化。
        const it = wallItems.find(item => item.id === payload?.id)
        if (it && payload?.patch?.status) it.status = payload.patch.status
        value = { ok: true }
      }
      else if (endpoint === 'deleteMemory') { rpcOps.push({ op: 'deleteMemory', ...payload }); value = { ok: true } }
      else if (endpoint === 'listGlobal') value = { files: [{ id: 'gmem-x', title: '全局X', content: 'gx', domain: 'general' }] }
      else if (endpoint === 'getPrompts') value = { prompts: [] }
      else if (endpoint === 'listVersions') value = { ok: true, versions: [] }
      else if (endpoint === 'listBackups') value = { backups: [] }
      else if (endpoint === 'listFolders') value = { folders: [] }
      else if (endpoint === 'listLibraries') value = { libraries: [{ id: 'lib-r', name: '回放库', scopeKey: '/proj/r' }] }
      else value = {}
      return { ok: true, value }
    } } },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: {}, ids: [] }) } },
    get: () => undefined,
    slots: { inject: (_n, cb) => cb({ effect: (fn) => fn(), register: (spec, component) => { registrations.push({ slot: spec.name, component }) } }), register: (spec, component) => { registrations.push({ slot: spec.name, component }); return () => {} } },
    inject: (_d, cb) => cb({ effect: (fn) => { try { fn() } catch {} }, sidebarRightTabs: { register: () => () => {} }, get: () => undefined }),
  }
  // 必须用本阶段自己的 ctx apply：settings.section 若被前一个回放注册过，find 会拿到
  // 旧组件（RPC 词表不对）——所以无条件 apply 并取最后一次注册。
  globalThis.__dshMemuExports.apply(wallCtx)
  const settings = [...registrations].reverse().find(r => r.slot === 'settings.section')
  check('设置页组件已注册', Boolean(settings?.component))

  // 渲染 → 展开（注册 effects）→ 跑 effects → 找到唯一的数字 0 hook（page 索引）→ 强制换页。
  let pageHookIndex = -1
  let lastPaintedPage = undefined
  async function paintPage(pageValue = undefined) {
    console.log('PAINT page=' + pageValue + ' pageHookIndex=' + pageHookIndex + ' hooks=' + reactHooks.length + ' state0=' + JSON.stringify(reactHooks[0] && typeof reactHooks[0] === 'object' ? Object.keys(reactHooks[0]).slice(0, 3) : reactHooks[0]) + ' globalFiles=' + JSON.stringify(reactHooks[3] ?? null))
    effects = []; cursor = 0
    forced = pageValue === undefined ? null : { index: pageHookIndex, value: pageValue }
    // 单数组 shim 的错位防护：SettingsPage 自身的 hook（含 wallFocus/page）位置稳定，
    // 嵌套组件（墙）的 hook 槽位随页面形状变化 —— 换页时清掉 page hook 之后的陈旧槽位，
    // 组件按 undefined 重新初始化；同页内的交互状态（多选/展开）照常保留。
    if (pageHookIndex !== -1 && pageValue !== undefined && pageValue !== lastPaintedPage) {
      reactHooks = reactHooks.slice(0, pageHookIndex + 1)
    }
    if (pageValue !== undefined) lastPaintedPage = pageValue
    const shell = settings.component({ ctx: wallCtx, t: (k) => k })
    treeWalk(shell, () => {})
    if (pageHookIndex === -1) {
      const zeroes = reactHooks.map((v, i) => (v === 0 ? i : -1)).filter(i => i >= 0)
      if (zeroes.length === 1) pageHookIndex = zeroes[0]
    }
    for (const effect of effects) { try { await effect() } catch {} }
    effects = []; cursor = 0
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    try { return settings.component({ ctx: wallCtx, t: (k) => (localeDict?.[k] || k) }) } catch (e) { console.log('PAINT-CRASH page=' + pageValue + ': ' + (e && e.stack || e).slice(0, 80)); throw e }
  }
  function inspect(tree) {
    let text = ''
    const buttons = []
    treeWalk(tree, (node) => {
      if (typeof node === 'string' || typeof node === 'number') { text += String(node) + ' '; return }
      if (typeof node === 'object' && node.type === 'button') buttons.push(node)
    })
    const byText = (needle) => buttons.find(b => {
      let t2 = ''; treeWalk(b, n => { if (typeof n === 'string' || typeof n === 'number') t2 += String(n) })
      return t2.includes(needle)
    })
    return { text, buttons, byText }
  }

  // 清场：shim 的 hooks 数组还留着回放 5 MemoryTab 的状态，直接渲染 SettingsPage 会
  // 整体错位。先全清，再暖启动一轮 page 0 让 zero-scan 探测到 page hook。
  reactHooks = []
  await paintPage()

  // —— 默认私有块靠前且生效：全局条目不可见 ——
  let view = inspect(await paintPage(9))
  check('分组默认私有：私有 tab 在前且选中', /私有 \(/.test(view.text) && /全局 \(/.test(view.text)
    && view.buttons.findIndex(b => { let t2 = ''; treeWalk(b, n => { if (typeof n === 'string') t2 += String(n) }); return /私有 \(/.test(t2) && b.props['aria-selected'] === true })
      < view.buttons.findIndex(b => { let t2 = ''; treeWalk(b, n => { if (typeof n === 'string') t2 += String(n) }); return /全局 \(/.test(t2) }),
    view.text.slice(0, 200))
  check('私有块不显示全局条目', /私有A/.test(view.text) && !/全局X/.test(view.text), view.text.slice(0, 200))

  // —— 切到全局块：全局条目可见、多选按钮不存在（全局只读）——
  view = inspect(await paintPage(9)); view.byText('全局 (')?.props?.onClick?.()
  view = inspect(await paintPage(9))
  check('全局块显示全局条目、隐藏私有条目', /全局X/.test(view.text) && !/私有A/.test(view.text), view.text.slice(0, 200))
  check('全局块没有多选入口（只读）', !view.byText('多选'))

  // —— 回到私有块，多选 → 批量归档 ——
  view.byText('私有 (')?.props?.onClick?.()
  view = inspect(await paintPage(9))
  view.byText('多选')?.props?.onClick?.()
  view = inspect(await paintPage(9))
  view.byText('私有A')?.props?.onClick?.() // 多选模式下点卡片 = 勾选
  view = inspect(await paintPage(9))
  check('多选工具条出现且计数正确', /已选 1 条/.test(view.text) && /归档 \(1\)/.test(view.text), view.text.slice(0, 160))
  view.byText('归档 (1)')?.props?.onClick?.()
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  const archiveOp = rpcOps.filter(op => op.op === 'updateMemory').at(-1)
  check('批量归档走 updateMemory 且 status=archived', archiveOp && archiveOp.id === 'mem-a' && archiveOp.patch?.status === 'archived', JSON.stringify(archiveOp))

  // —— 已归档池：多选恢复 + 两段式删除 ——
  view = inspect(await paintPage(9))
  view.byText('已归档 (2)')?.props?.onClick?.()
  view = inspect(await paintPage(9))
  view.byText('私有A')?.props?.onClick?.()
  view = inspect(await paintPage(9))
  check('恢复按钮按选中计数出现', /恢复 \(1\)/.test(view.text), view.text.slice(0, 160))
  view.byText('恢复 (1)')?.props?.onClick?.()
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  check('批量恢复走 updateMemory 且 status=active', rpcOps.some(op => op.op === 'updateMemory' && op.id === 'mem-a' && op.patch?.status === 'active'))
  view = inspect(await paintPage(9))
  view.byText('私有B')?.props?.onClick?.()
  view = inspect(await paintPage(9))
  const armDelete = view.byText('彻底删除 (1)')
  check('已归档条目出现永久删除入口（两段式）', Boolean(armDelete))
  armDelete?.props?.onClick?.()
  view = inspect(await paintPage(9))
  view.byText('确认删除 (1)')?.props?.onClick?.()
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  check('批量删除走 deleteMemory', rpcOps.some(op => op.op === 'deleteMemory' && op.id === 'mem-b'))

  // —— 全局页"查看此记忆"：接力棒切到记忆页并直接开抽屉 ——
  view = inspect(await paintPage(6))
  check('全局记忆页每条有查看按钮', Boolean(view.byText('查看此记忆')), view.text.slice(0, 120))
  view.byText('查看此记忆')?.props?.onClick?.()
  // setPage(9) 已写进 page hook：强制值跟随，走 effects 让 focus 打开抽屉。
  view = inspect(await paintPage(reactHooks[pageHookIndex]))
  check('查看跳到 MemU 记忆页并打开对应记忆抽屉', view.text.includes('全局X') && view.text.includes('全局记忆 ·'), view.text.slice(0, 200))
})

// ================================================================ 回放 6：向量计数链路
await phase('回放 6 · 向量计数链路：迁移账本 + 写入戳 → 计数随真实增减走', async () => {
  resetActivityLogCache()
  state.updateSettings({ memoryBackend: 'api', vectorSource: 'local' })
  state.ensureSession('vec-session', { cwd: path.join(home, 'proj-vec'), agentPreset: 'standard' })
  const libId = state.getSessionBinding('vec-session').libraryId
  const exec = execFor('vec-session')
  await memory.privateRemember({ exec, content: '迁移时就有的记忆一', title: 'm1' })
  await memory.privateRemember({ exec, content: '迁移时就有的记忆二', title: 'm2' })

  const dbs = new Map()
  const migrator = vm.createVectorMigrator({
    listLibraries: () => state.listLibraries().map(l => l.id),
    loadIndex: (id) => (id == null ? state.loadGlobalIndex() : state.loadPrivateIndex(id)),
    commit: async ({ db, item }) => { dbs.set(db + '|' + item.id, item.text) },
    forget: async ({ db, itemId }) => { dbs.delete(db + '|' + itemId) },
    listFiles: async ({ db }) => [...dbs.keys()].filter(k => k.startsWith(db + '|')).map(k => k.split('|')[1]),
    smoke: async () => ({ ok: true }),
  })
  const sw = await migrator.switchProfile({ profile: vp.profileFromCatalog('bge-small-zh-v1.5-int8') })
  const idsOf = (scope) => ((migrator.membership() || {})[scope] || []).sort()
  const migrated = idsOf(libId)
  check('切换时写入 2/2：计数从迁移账本出发', migrated.length === 2, JSON.stringify(migrated))

  const w = await memory.privateRemember({ exec, content: '切换之后新写的记忆', title: 'post' })
  check('切换后写入带当前代际戳', state.loadPrivateIndex(libId).entries[w.id]?.vector?.generation === sw.generation, JSON.stringify(state.loadPrivateIndex(libId).entries[w.id]?.vector))
  check('计数跟随真实写入增长（旧 bug：冻在 2）', idsOf(libId).length === 3 && idsOf(libId).includes(w.id), JSON.stringify(idsOf(libId)))
  check('引擎写入真发生了（memu commit 被调）', memuCalls.commit.some(c => c.names.includes(w.id)))

  await memory.privateArchive({ exec, id: migrated[0] })
  await memory.privateDelete({ exec, id: migrated[0] })
  const after = idsOf(libId)
  check('永久删除后计数扣掉该条（账本腿的删除检查）', after.length === 2 && !after.includes(migrated[0]), JSON.stringify(after))
  check('回滚代际的旧戳不泄漏：计数值与新代际一致', sw.generation === 1 && after.length + 1 === 3)
})

// ================================================================ 汇总
const failed = results.filter(r => !r.ok)
console.log('\n======== 回放汇总 ========')
console.log('检查点 ' + results.length + ' 个，通过 ' + (results.length - failed.length) + '，失败 ' + failed.length)
for (const f of failed) console.log('  FAIL: ' + f.name)
try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
process.exit(failed.length ? 1 : 0)
