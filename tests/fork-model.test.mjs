import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 整理 fork 的模型选择（后端）：三模式解析矩阵、自定义 route 生命周期、settings 校验、
// RPC allowlist 与 apiKey 打码。private 侧的三模式接线（fork 真被建/被拒）在
// consolidation-fork.test.mjs 里断言，这里只测 lib/fork-model.js 的纯逻辑与生命周期。

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-fork-model-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const rpc = await import('../lib/rpc.js')
const forkModel = await import('../lib/fork-model.js')
const { CONSOLIDATION_CUSTOM_ROUTE, resolveConsolidationAgentOptions, ensureConsolidationRoute, disposeConsolidationRoute, listHostModelOptions, discoverForkModels, customRouteSpec, redactConsolidationSettings } = forkModel

test.after(() => {
  disposeConsolidationRoute()
  state.flushState()
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

const CUSTOM_SETTINGS = {
  consolidationModelMode: 'custom',
  consolidationCustomBaseURL: 'http://127.0.0.1:9100/v1',
  consolidationCustomModel: 'gateway-model',
  consolidationCustomApiKey: 'sk-custom-1234567890',
  consolidationCustomApi: 'openai-completions',
}

// ---------------------------------------------------------------- 解析矩阵
test('resolveConsolidationAgentOptions: the full mode matrix, deterministically', () => {
  const inherited = { provider: 'parent', model: 'parent-model', reasoningEffort: 'high' }
  // inherit：有父 route 原样透传；没有就拒绝（reason 与旧口径对应）。
  assert.deepEqual(resolveConsolidationAgentOptions({ consolidationModelMode: 'inherit' }, inherited), { options: inherited, reason: 'inherit' })
  assert.deepEqual(resolveConsolidationAgentOptions({ consolidationModelMode: 'inherit' }, null), { options: null, reason: 'no-inherited-route' })
  assert.deepEqual(resolveConsolidationAgentOptions({}, inherited), { options: inherited, reason: 'inherit' }, 'missing mode reads as inherit')
  assert.deepEqual(resolveConsolidationAgentOptions({ consolidationModelMode: 'nonsense' }, null), { options: null, reason: 'no-inherited-route' }, 'unknown mode degrades to inherit, never to a guess')
  // host：合法 "<provider>/<model>"；坏格式一律 null + reason，不猜。
  assert.deepEqual(resolveConsolidationAgentOptions({ consolidationModelMode: 'host', consolidationModel: 'prov/mesh-7b' }, inherited), { options: { provider: 'prov', model: 'mesh-7b' }, reason: 'host' })
  assert.deepEqual(resolveConsolidationAgentOptions({ consolidationModelMode: 'host', consolidationModel: 'prov/a/b' }, inherited), { options: { provider: 'prov', model: 'a/b' }, reason: 'host' }, 'nested model ids keep everything after the first slash')
  for (const bad of [null, '', 'nomodel', '/leading', 'trailing/', ' / ', 42]) {
    const resolved = resolveConsolidationAgentOptions({ consolidationModelMode: 'host', consolidationModel: bad }, inherited)
    assert.deepEqual(resolved, { options: null, reason: 'invalid-consolidation-model' }, 'bad host model: ' + String(bad))
  }
  // custom：route 固定，model 来自设置；必填缺失回 custom-incomplete。
  assert.deepEqual(resolveConsolidationAgentOptions({ ...CUSTOM_SETTINGS }, inherited), { options: { provider: CONSOLIDATION_CUSTOM_ROUTE, model: 'gateway-model' }, reason: 'custom' })
  assert.deepEqual(resolveConsolidationAgentOptions({ ...CUSTOM_SETTINGS, consolidationCustomModel: '' }, inherited), { options: null, reason: 'custom-incomplete' })
  assert.deepEqual(resolveConsolidationAgentOptions({ ...CUSTOM_SETTINGS, consolidationCustomBaseURL: '' }, inherited), { options: null, reason: 'custom-incomplete' })
  assert.deepEqual(resolveConsolidationAgentOptions({ ...CUSTOM_SETTINGS, consolidationCustomBaseURL: 'ftp://x/y' }, inherited), { options: null, reason: 'custom-incomplete' })
  assert.deepEqual(resolveConsolidationAgentOptions({ ...CUSTOM_SETTINGS, consolidationCustomBaseURL: 'http://user:pw@h/v1' }, inherited), { options: null, reason: 'custom-incomplete' }, 'embedded credentials are not a usable endpoint')
  // apiKey 选填：没有 key 的 custom 配置照样解析出 route。
  assert.deepEqual(resolveConsolidationAgentOptions({ ...CUSTOM_SETTINGS, consolidationCustomApiKey: '' }, null), { options: { provider: CONSOLIDATION_CUSTOM_ROUTE, model: 'gateway-model' }, reason: 'custom' })
  // 确定性：同输入同输出。
  const once = resolveConsolidationAgentOptions({ ...CUSTOM_SETTINGS }, inherited)
  const twice = resolveConsolidationAgentOptions({ ...CUSTOM_SETTINGS }, inherited)
  assert.deepEqual(once, twice)
  assert.deepEqual(JSON.parse(JSON.stringify(once)), JSON.parse(JSON.stringify(resolveConsolidationAgentOptions({ ...CUSTOM_SETTINGS }, inherited))))
})

test('customRouteSpec normalizes the custom connection fields', () => {
  const spec = customRouteSpec(CUSTOM_SETTINGS)
  assert.deepEqual(spec, { baseURL: 'http://127.0.0.1:9100/v1', model: 'gateway-model', api: 'openai-completions', apiKey: 'sk-custom-1234567890' })
  assert.equal(customRouteSpec({ consolidationCustomBaseURL: ' https://gw.example/v1 ', consolidationCustomModel: ' m2 ' }).baseURL, 'https://gw.example/v1')
  assert.equal(customRouteSpec({ consolidationCustomBaseURL: 'https://x/v1', consolidationCustomModel: 'm', consolidationCustomApi: 'anthropic-messages' }).api, 'anthropic-messages')
  assert.equal(customRouteSpec({ consolidationCustomBaseURL: 'https://x/v1', consolidationCustomModel: 'm', consolidationCustomApi: 'bogus' }).api, 'openai-completions', 'unknown protocol falls back to the default, not to garbage')
  assert.equal(customRouteSpec({}), null)
})

// ---------------------------------------------------------------- route 生命周期
function sequenceLlm({ serveModels = true, failRegister = false, noListModels = false } = {}) {
  const rec = { events: [], adapters: [] }
  const llm = {
    registerAdapter: (routes, adapter) => {
      if (failRegister) throw new Error('an adapter for provider "' + routes[0] + '" is already registered')
      rec.events.push({ op: 'register', routes: [...routes] })
      rec.adapters.push(adapter)
      const handle = () => { rec.events.push({ op: 'dispose', routes: [...routes] }) }
      handle.replace = () => {}
      return handle
    },
    ...(noListModels ? {} : {
      listModels: async (provider) => (serveModels || provider !== CONSOLIDATION_CUSTOM_ROUTE)
        ? [{ provider, id: 'mock-model', name: 'Mock Model', inputModalities: ['text'] }]
        : [],
    }),
  }
  return { llm, rec }
}

function mockCtx(llm) {
  return { get: (name) => (name === 'llm' ? llm : undefined) }
}

const failingLoader = async () => { throw new Error('Cannot find package') }

test('ensureConsolidationRoute registers one route with the configured profile and key', async () => {
  const { llm, rec } = sequenceLlm()
  const ctx = mockCtx(llm)
  const result = await ensureConsolidationRoute(ctx, CUSTOM_SETTINGS, { loadPiAi: async () => ({ PiAiAdapter: class MockAdapter { constructor(options) { rec.adapterOptions = options } } }) })
  assert.deepEqual(result, { ok: true, route: CONSOLIDATION_CUSTOM_ROUTE, models: 1 })
  assert.deepEqual(rec.events, [{ op: 'register', routes: [CONSOLIDATION_CUSTOM_ROUTE] }])
  assert.deepEqual(rec.adapterOptions.profiles().get(CONSOLIDATION_CUSTOM_ROUTE), {
    provider: CONSOLIDATION_CUSTOM_ROUTE,
    displayName: CONSOLIDATION_CUSTOM_ROUTE,
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:9100/v1',
    models: [{ id: 'gateway-model' }],
    modelErrors: new Map(),
    configuredMaxTokens: new Map(),
  })
  // resolveApiKey 是插件自己的回调：返回设置里的明文 key（或空串），不碰宿主凭据。
  assert.equal(await rec.adapterOptions.resolveApiKey(CONSOLIDATION_CUSTOM_ROUTE, {}), 'sk-custom-1234567890')
  assert.equal(await rec.adapterOptions.resolveApiKey(CONSOLIDATION_CUSTOM_ROUTE, { apiKeyEnv: undefined }), 'sk-custom-1234567890')
  // auth 是构造必填（宿主 0.2.2），空实现桩满足形状：本插件的请求永远带显式 key。
  assert.equal(typeof rec.adapterOptions.auth.credentials.read, 'function')
  assert.equal(typeof rec.adapterOptions.auth.authContext.env, 'function')
})

test('ensureConsolidationRoute disposes the previous handle before re-registering', async () => {
  const { llm, rec } = sequenceLlm()
  const ctx = mockCtx(llm)
  const loader = async () => ({ PiAiAdapter: class MockAdapter { constructor(options) { rec.adapterOptions = options } } })
  await ensureConsolidationRoute(ctx, CUSTOM_SETTINGS, { loadPiAi: loader })
  assert.deepEqual(rec.events.map((e) => e.op), ['register'])
  await ensureConsolidationRoute(ctx, { ...CUSTOM_SETTINGS, consolidationCustomApi: 'anthropic-messages' }, { loadPiAi: loader })
  assert.deepEqual(rec.events.map((e) => e.op), ['register', 'dispose', 'register'], 'the old handle is released before the new registration')
  assert.deepEqual(rec.events[1].routes, [CONSOLIDATION_CUSTOM_ROUTE])
  assert.notEqual(rec.adapters[1], rec.adapters[0], 'each registration builds its own adapter instance')
  // 设置变更后的 profile 反映新配置。
  const profile = rec.adapterOptions.profiles().get(CONSOLIDATION_CUSTOM_ROUTE)
  assert.equal(profile.api, 'anthropic-messages')
  disposeConsolidationRoute()
  assert.deepEqual(rec.events.map((e) => e.op), ['register', 'dispose', 'register', 'dispose'], 'plugin-stop dispose releases the live handle')
  disposeConsolidationRoute()
  assert.equal(rec.events.length, 4, 'dispose is idempotent')
})

test('ensureConsolidationRoute degrades with a reason instead of throwing', async () => {
  // llm service 缺席 / 缺 registerAdapter / 缺 listModels：能力探测，不抛。
  assert.deepEqual(await ensureConsolidationRoute({}, CUSTOM_SETTINGS, { loadPiAi: failingLoader }), { ok: false, reason: 'llm-service-unavailable' })
  assert.deepEqual(await ensureConsolidationRoute(mockCtx({}), CUSTOM_SETTINGS, { loadPiAi: failingLoader }), { ok: false, reason: 'llm-service-unavailable' })
  assert.deepEqual(await ensureConsolidationRoute(mockCtx({ registerAdapter: () => {} }), CUSTOM_SETTINGS, { loadPiAi: failingLoader }), { ok: false, reason: 'llm-service-unavailable' })
  // PiAiAdapter 模块加载失败 / 导出缺失：宿主差异，不抛。
  assert.deepEqual(await ensureConsolidationRoute(mockCtx(sequenceLlm().llm), CUSTOM_SETTINGS, { loadPiAi: failingLoader }), { ok: false, reason: 'pi-ai-adapter-unavailable' })
  assert.deepEqual(await ensureConsolidationRoute(mockCtx(sequenceLlm().llm), CUSTOM_SETTINGS, { loadPiAi: async () => ({}) }), { ok: false, reason: 'pi-ai-adapter-unavailable' })
  // custom 配置不完整：在碰模块之前就拦下（loader 若被调到这里就会失败）。
  assert.deepEqual(await ensureConsolidationRoute(mockCtx(sequenceLlm().llm), { consolidationModelMode: 'custom' }, { loadPiAi: failingLoader }), { ok: false, reason: 'custom-incomplete' })
  // registerAdapter 抛（DUPLICATE_ADAPTER 等）：register-failed。
  const failing = sequenceLlm({ failRegister: true })
  assert.equal((await ensureConsolidationRoute(mockCtx(failing.llm), CUSTOM_SETTINGS, { loadPiAi: async () => ({ PiAiAdapter: class {} }) })).reason, 'register-failed')
  // 注册成功但 route 出不了模型（服务性探测）：当场卸载，custom-route-unserviceable。
  const silent = sequenceLlm({ serveModels: false })
  const blocked = await ensureConsolidationRoute(mockCtx(silent.llm), CUSTOM_SETTINGS, { loadPiAi: async () => ({ PiAiAdapter: class {} }) })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'custom-route-unserviceable')
  assert.deepEqual(silent.rec.events.map((e) => e.op), ['register', 'dispose'], 'the unserviceable registration is rolled back')
  // 探测用的 listModels 都不在的宿主：入口能力探测就拦下（无法验证服务性）。
  const bare = sequenceLlm({ noListModels: true })
  assert.equal((await ensureConsolidationRoute(mockCtx(bare.llm), CUSTOM_SETTINGS, { loadPiAi: async () => ({ PiAiAdapter: class {} }) })).reason, 'llm-service-unavailable')
  // key 缺失也是合法 custom 配置（本地网关）：能注册成功。
  const keyless = sequenceLlm()
  const okKeyless = await ensureConsolidationRoute(mockCtx(keyless.llm), { ...CUSTOM_SETTINGS, consolidationCustomApiKey: '' }, { loadPiAi: async () => ({ PiAiAdapter: class Mock { constructor(o) { keyless.rec.adapterOptions = o } } }) })
  assert.equal(okKeyless.ok, true)
  assert.equal(await keyless.rec.adapterOptions.resolveApiKey(CONSOLIDATION_CUSTOM_ROUTE, {}), '')
  disposeConsolidationRoute()
})

// ---------------------------------------------------------------- 宿主模型目录
test('listHostModelOptions merges listProviders with per-provider listModels and degrades per provider', async () => {
  const llm = {
    listProviders: () => [{ id: 'prov-a', name: 'Provider A' }, 'prov-b', { name: 'no id' }],
    listModels: async (provider) => {
      if (provider === 'prov-a') return [{ provider, id: 'm1', name: 'Model One', inputModalities: ['text'] }, { provider, id: 'm2' }]
      if (provider === 'prov-b') throw new Error('route went away')
      return []
    },
    registerAdapter: () => {},
    discoverModels: async () => [],
  }
  const options = await listHostModelOptions(mockCtx(llm), { loadPiAi: async () => ({ PiAiAdapter: class {} }) })
  assert.deepEqual(options, {
    providers: [
      { id: 'prov-a', name: 'Provider A', models: [{ id: 'm1', name: 'Model One' }, { id: 'm2' }] },
      { id: 'prov-b', models: [] },
    ],
    customAvailable: true,
    discoveryAvailable: true,
  })
  // 单个 provider 的 listModels 失败降级为空数组，不炸整体（上面 prov-b 已验证）。
  assert.equal(options.providers[1].models.length, 0)
})

test('listHostModelOptions probes capabilities and survives an absent llm service', async () => {
  assert.deepEqual(await listHostModelOptions({}, { loadPiAi: failingLoader }), { providers: [], customAvailable: false, discoveryAvailable: false })
  // registerAdapter 在但 PiAiAdapter 拉不到：customAvailable=false，目录照常返回。
  const partial = {
    listProviders: () => [{ id: 'p', name: 'P' }],
    listModels: async () => [{ id: 'm' }],
    registerAdapter: () => {},
  }
  const options = await listHostModelOptions(mockCtx(partial), { loadPiAi: failingLoader })
  assert.deepEqual(options, { providers: [{ id: 'p', name: 'P', models: [{ id: 'm' }] }], customAvailable: false, discoveryAvailable: false })
  // listProviders 本身炸了：空目录，不抛。customAvailable 仍会尝试拉 PiAiAdapter——
  // 这个测试进程装不了宿主包（failingLoader），所以是 false。
  const broken = { listProviders: () => { throw new Error('remote dead') }, registerAdapter: () => {} }
  assert.deepEqual(await listHostModelOptions(mockCtx(broken), { loadPiAi: failingLoader }), { providers: [], customAvailable: false, discoveryAvailable: false })
})

test('discoverForkModels forwards the draft endpoint and never echoes the key', async () => {
  assert.deepEqual(await discoverForkModels({}, { baseURL: 'https://x/v1' }), { ok: false, reason: 'discovery-unavailable', models: [] })
  const seen = []
  const llm = {
    discoverModels: async (ns, request) => {
      seen.push({ ns, request })
      return [{ id: 'm1', name: 'M One' }, { id: 'm1' }, { id: 'm2', contextWindow: 8192 }]
    },
  }
  const settings = { consolidationCustomApiKey: 'sk-stored-987654321' }
  const ok = await discoverForkModels(mockCtx(llm), { baseURL: 'https://gw.example/v1', api: 'openai-completions', useStoredKey: true }, settings)
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.models, [{ id: 'm1', name: 'M One' }, { id: 'm2' }], 'dedup to endpoint order, plain metadata out')
  assert.equal(seen[0].ns, 'llm-pi-ai')
  assert.equal(seen[0].request.apiKey, 'sk-stored-987654321', 'the stored key rides the one-shot discovery request')
  assert.equal(JSON.stringify(ok).includes('sk-stored'), false, 'the reply never echoes the key')
  // 端点缺失/非法：结构化拒绝。
  assert.equal((await discoverForkModels(mockCtx(llm), {})).reason, 'invalid-base-url')
  assert.equal((await discoverForkModels(mockCtx(llm), { baseURL: 'http://u:p@h/v1' })).reason, 'invalid-base-url')
  // 宿主没在 'llm-pi-ai' 命名空间注册发现：no-discovery，UI 退回手工填写。
  const noDiscovery = { discoverModels: async () => { throw new Error('no model discovery is registered for "llm-pi-ai"') } }
  assert.equal((await discoverForkModels(mockCtx(noDiscovery), { baseURL: 'https://x/v1' })).reason, 'no-discovery')
  // 其余错误原样带回（宿主公共诊断不含凭据）。
  const refused = { discoverModels: async () => { throw new Error('endpoint refused the request') } }
  const failed = await discoverForkModels(mockCtx(refused), { baseURL: 'https://x/v1' })
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, 'discovery-failed')
  assert.match(failed.error, /endpoint refused/)
})

// ---------------------------------------------------------------- settings 校验
test('updateSettings validates the six consolidation model keys', () => {
  const legal = {
    consolidationModelMode: 'host',
    consolidationModel: 'prov/model-a',
    consolidationCustomBaseURL: 'https://gateway.local/v1',
    consolidationCustomApiKey: 'sk-x-1234567890',
    consolidationCustomModel: 'vendor/model-b',
    consolidationCustomApi: 'anthropic-messages',
  }
  const saved = state.updateSettings(legal)
  for (const [key, value] of Object.entries(legal)) assert.equal(saved[key], value)
  // 空串与 null 是合法配置（未填状态）。
  assert.equal(state.updateSettings({ consolidationModelMode: 'inherit' }).consolidationModelMode, 'inherit')
  assert.equal(state.updateSettings({ consolidationModel: null }).consolidationModel, null)
  assert.equal(state.updateSettings({ consolidationCustomBaseURL: '' }).consolidationCustomBaseURL, '')
  assert.equal(state.updateSettings({ consolidationCustomApiKey: '' }).consolidationCustomApiKey, '')
  assert.equal(state.updateSettings({ consolidationCustomModel: '' }).consolidationCustomModel, '')
  assert.equal(state.updateSettings({ consolidationCustomApi: 'openai-completions' }).consolidationCustomApi, 'openai-completions')
  // 非法值在设置页就拒绝，风格与 salientWakeHour 分支一致。
  for (const [patch, pattern] of [
    [{ consolidationModelMode: 'always' }, /invalid setting consolidationModelMode/],
    [{ consolidationCustomApi: 'grpc' }, /invalid setting consolidationCustomApi/],
    [{ consolidationModel: 42 }, /invalid consolidation model/],
    [{ consolidationModel: 'x'.repeat(201) }, /invalid consolidation model/],
    [{ consolidationCustomBaseURL: 'not a url' }, /consolidationCustomBaseURL must be an HTTP/],
    [{ consolidationCustomBaseURL: 'ftp://h/v1' }, /consolidationCustomBaseURL must be an HTTP/],
    [{ consolidationCustomBaseURL: 'https://u:p@h/v1' }, /without embedded credentials/],
    [{ consolidationCustomApiKey: 7 }, /invalid consolidation custom api key/],
    [{ consolidationCustomApiKey: 'k'.repeat(501) }, /invalid consolidation custom api key/],
    [{ consolidationCustomModel: 7 }, /invalid consolidation custom model/],
    [{ consolidationCustomModel: 'm'.repeat(201) }, /invalid consolidation custom model/],
  ]) {
    assert.throws(() => state.updateSettings(patch), pattern, JSON.stringify(patch).slice(0, 60))
  }
  // 还原缺省，别污染其他用例。
  state.updateSettings({ consolidationModelMode: 'inherit', consolidationModel: null, consolidationCustomBaseURL: '', consolidationCustomApiKey: '', consolidationCustomModel: '', consolidationCustomApi: 'openai-completions' })
})

// ---------------------------------------------------------------- RPC 面
test('setSettings carries the new keys and resetSettings restores their defaults', async () => {
  const patch = { ...CUSTOM_SETTINGS, consolidationModelMode: 'custom' }
  const saved = await rpc.dispatch({}, 'setSettings', { patch })
  assert.equal(saved.consolidationModelMode, 'custom')
  assert.equal(saved.consolidationCustomBaseURL, patch.consolidationCustomBaseURL)
  assert.equal(saved.consolidationCustomModel, patch.consolidationCustomModel)
  assert.equal(saved.consolidationCustomApi, patch.consolidationCustomApi)
  // allowlist 语义保持：未登记的键静默丢弃（与既有 setSettings 一致），不会写入未知设置。
  const dropped = await rpc.dispatch({}, 'setSettings', { patch: { consolidationModelModeIs: 'custom', consolidationCustomApiKey: 'sk-rotated-9911' } })
  assert.equal(dropped.consolidationModelModeIs, undefined)
  assert.equal(dropped.consolidationCustomApiKey, undefined, 'the key is never echoed back in plaintext')
  const reset = await rpc.dispatch({}, 'resetSettings', {})
  // 回包是打码视图：key 字段被剥掉（undefined），不是明文也不是空串。
  assert.deepEqual(
    { mode: reset.consolidationModelMode, model: reset.consolidationModel, url: reset.consolidationCustomBaseURL, key: reset.consolidationCustomApiKey, cm: reset.consolidationCustomModel, api: reset.consolidationCustomApi },
    { mode: 'inherit', model: null, url: '', key: undefined, cm: '', api: 'openai-completions' },
    'reset returns to the inherit default, no host/custom residue, key stripped',
  )
})

test('RPC settings replies mask the custom api key (getState, getSettingsState, setSettings)', async () => {
  await rpc.dispatch({}, 'setSettings', { patch: { consolidationModelMode: 'custom', consolidationCustomBaseURL: 'http://127.0.0.1:9100/v1', consolidationCustomApiKey: 'sk-secret-1234567890', consolidationCustomModel: 'gateway-model' } })
  for (const endpoint of ['getState', 'getSettingsState']) {
    const reply = await rpc.dispatch({}, endpoint, endpoint === 'getState' ? {} : {})
    const settings = reply.settings
    assert.equal(settings.consolidationCustomApiKey, undefined, endpoint + ' never returns the plaintext key')
    assert.equal(settings.hasConsolidationCustomApiKey, true)
    assert.equal(settings.consolidationCustomApiKeyTail, '7890', endpoint + ' shows the masked tail (VisionConfig hasKey 口径对齐)')
    assert.equal(JSON.stringify(reply).includes('sk-secret'), false, endpoint + ' reply carries no plaintext anywhere')
    // 其它六个键原样可用，UI 正常渲染。
    assert.equal(settings.consolidationModelMode, 'custom')
    assert.equal(settings.consolidationCustomBaseURL, 'http://127.0.0.1:9100/v1')
  }
  const saved = await rpc.dispatch({}, 'setSettings', { patch: { consolidationCustomApiKey: 'sk-rotated-abcdef11' } })
  assert.equal(saved.consolidationCustomApiKey, undefined)
  assert.equal(saved.hasConsolidationCustomApiKey, true)
  assert.equal(saved.consolidationCustomApiKeyTail, 'ef11')
  // 短 key 只给掩码，不给明文尾巴。
  const short = redactConsolidationSettings({ consolidationCustomApiKey: 'abc' })
  assert.equal(short.consolidationCustomApiKeyTail, '****')
  assert.equal(short.hasConsolidationCustomApiKey, true)
  // 还原。
  await rpc.dispatch({}, 'setSettings', { patch: { consolidationModelMode: 'inherit', consolidationCustomApiKey: '', consolidationCustomBaseURL: '', consolidationCustomModel: '' } })
})

test('listForkModelOptions and discoverForkModels are reachable through the RPC registry', async () => {
  // 无宿主：空目录 + 能力位全 false，设置页照常渲染。
  assert.deepEqual(await rpc.dispatch({}, 'listForkModelOptions', {}), { providers: [], customAvailable: false, discoveryAvailable: false })
  const llm = {
    listProviders: () => [{ id: 'prov', name: 'Prov' }],
    listModels: async () => [{ id: 'm1', name: 'M One' }],
    registerAdapter: () => {},
    discoverModels: async () => [{ id: 'm9' }],
  }
  const options = await rpc.dispatch({ get: (name) => (name === 'llm' ? llm : undefined) }, 'listForkModelOptions', {})
  assert.deepEqual(options.providers, [{ id: 'prov', name: 'Prov', models: [{ id: 'm1', name: 'M One' }] }])
  // customAvailable 探测拉 PiAiAdapter：测试进程里由 loader 桩（tests/stubs/dsh-llm-pi-ai.js）
  // 提供，registerAdapter 在 → true。
  assert.equal(options.customAvailable, true)
  assert.equal(options.discoveryAvailable, true)
  const discovery = await rpc.dispatch({ get: (name) => (name === 'llm' ? llm : undefined) }, 'discoverForkModels', { baseURL: 'https://gw.example/v1' })
  assert.equal(discovery.ok, true)
  assert.deepEqual(discovery.models, [{ id: 'm9' }])
})
