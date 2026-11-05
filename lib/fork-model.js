// 整理 fork 的模型选择（后端半边）：三模式解析、自定义端点的宿主 route 生命周期、
// 宿主模型目录拉取与模型发现转发。纯逻辑 + 能力探测，全部可单测；本模块不 import
// 仓库内任何模块——settings 由调用方传入，宿主服务一律经 ctx 能力探测（AGENTS.md §1.1），
// 能力缺失返回结构化 not-ok 并由调用方 warn 一行降级，绝不 fail closed。
//
// 三模式（settings.consolidationModelMode）：
//   'inherit' 沿用父会话的 provider/model（现状，缺省值）；
//   'host'    用 settings.consolidationModel（"<provider>/<model>"，同 curatorModel 口径）
//             指名宿主已激活的 route；
//   'custom'  用 settings.consolidationCustom*（baseURL/api/key/model）在宿主 llm 注册表
//             注册本插件私有的 route（CONSOLIDATION_CUSTOM_ROUTE），fork 指名该 route。
// fork 的 AgentOptions 白名单只有 { provider, model, reasoningEffort?, maxTokens? }——
// 没有 baseURL/apiKey 通道，所以 custom 模式必须走注册 route，这是唯一合法通路。

/** 本插件在宿主 llm 注册表里拥有的私有 route 名。 */
export const CONSOLIDATION_CUSTOM_ROUTE = 'dsh-memu-custom'

/** custom 模式允许的线协议（PiAiAdapter profile.api 的合法值）。 */
export const CONSOLIDATION_CUSTOM_APIS = Object.freeze([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
])

// dsh-llm-pi-ai 的模型发现按 settings 命名空间注册（registerModelDiscovery），其发布包
// （0.2.2）在挂载时用常量 NS='llm-pi-ai' 固定注册。宿主差异走能力探测：discoverModels
// 方法不存在、或该命名空间没有注册发现（NO_DISCOVERY）时，RPC 返回结构化的
// no-discovery，UI 退回手工填写模型 id——只降级，不炸设置页。
const MODEL_DISCOVERY_NAMESPACE = 'llm-pi-ai'

/**
 * curator.js agentOptionsFor 的同口径解析："<provider>/<model>" → { provider, model }。
 * 复制而非复用是因为 curator.js 不导出它，且本模块刻意零仓库内依赖。
 */
function parseProviderModel(value) {
  const text = String(value || '').trim()
  if (!text) return null
  const slash = text.indexOf('/')
  if (slash <= 0 || slash === text.length - 1) return null
  const provider = text.slice(0, slash).trim()
  const model = text.slice(slash + 1).trim()
  if (!provider || !model) return null
  return { provider, model }
}

/** http(s) URL 且不带内嵌凭据——与 pipIndexes / vision endpoint 同一把尺。 */
function isPlainHttpUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  } catch {
    return false
  }
}

/** custom 模式的必填面：baseURL（http(s)）+ model 都在才算完整；apiKey 选填。 */
export function customRouteSpec(settings) {
  const baseURL = String(settings?.consolidationCustomBaseURL || '').trim()
  const model = String(settings?.consolidationCustomModel || '').trim()
  if (!baseURL || !isPlainHttpUrl(baseURL) || !model) return null
  return {
    baseURL,
    model,
    api: CONSOLIDATION_CUSTOM_APIS.includes(settings?.consolidationCustomApi) ? settings.consolidationCustomApi : 'openai-completions',
    apiKey: String(settings?.consolidationCustomApiKey || '').trim(),
  }
}

/**
 * 三模式解析（纯函数，同输入同输出）。inheritedOptions 是父会话的
 * inheritedAgentOptions 结果（{ provider, model, ... } 或 null）。
 * @returns {{ options: { provider: string, model: string } | null, reason: string }}
 *   reason ∈ 'inherit' | 'host' | 'custom' | 'no-inherited-route' |
 *            'invalid-consolidation-model' | 'custom-incomplete'
 */
export function resolveConsolidationAgentOptions(settings, inheritedOptions) {
  const mode = settings?.consolidationModelMode || 'inherit'
  if (mode === 'host') {
    const parsed = parseProviderModel(settings?.consolidationModel)
    if (!parsed) return { options: null, reason: 'invalid-consolidation-model' }
    return { options: parsed, reason: 'host' }
  }
  if (mode === 'custom') {
    const spec = customRouteSpec(settings)
    if (!spec) return { options: null, reason: 'custom-incomplete' }
    return { options: { provider: CONSOLIDATION_CUSTOM_ROUTE, model: spec.model }, reason: 'custom' }
  }
  // 'inherit' 与任何未知值都回到现状：能用父会话的 route 就用，不能用就拒绝。
  if (inheritedOptions) return { options: inheritedOptions, reason: 'inherit' }
  return { options: null, reason: 'no-inherited-route' }
}

// —— 自定义 route 生命周期 ————————————————————————————————————————————————
// PiAiAdapter 从 @deepseek-ai/dsh-llm-pi-ai 公开导出；其构造 options 里 resolveApiKey
// 是插件自己的回调——直接返回插件设置里的明文 key，不经过宿主 credentials（也不落
// 宿主凭据面）。profiles() 返回单个 route 的 profile。auth 是构造必填项（宿主 0.2.2）：
// 本插件的请求永远带显式 apiKey、不做登录/刷新，给一个空实现桩满足形状即可；真用到
// 时请求会失败并按既有失败路径退避重试，不会静默。
async function defaultLoadPiAi() {
  return import('@deepseek-ai/dsh-llm-pi-ai')
}

function customRouteProfile(spec) {
  return {
    provider: CONSOLIDATION_CUSTOM_ROUTE,
    displayName: CONSOLIDATION_CUSTOM_ROUTE,
    api: spec.api,
    baseURL: spec.baseURL,
    // 原始 profile 的模型名单口径；只声明这一个模型，fork 只会指名它。
    models: [{ id: spec.model }],
    modelErrors: new Map(),
    configuredMaxTokens: new Map(),
  }
}

function customRouteAuth() {
  return {
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => undefined,
      delete: async () => {},
    },
    authContext: {
      env: async () => undefined,
      fileExists: async () => false,
    },
  }
}

// 已注册的 handle（AdapterRegistrationHandle：可调用 disposer，带 .replace）。
// 进程内单例：custom 模式的 fork 全走这一个 route。plugin 卸载时由 rpc.js 的
// effect dispose（见 registerRpc 里的 'dsh-memu-memory: consolidation route'）。
let customRouteHandle = null

function llmServiceOf(ctx) {
  try {
    const llm = ctx?.get?.('llm')
    return llm && typeof llm === 'object' ? llm : null
  } catch {
    return null
  }
}

/**
 * 确保 custom 模式的 route 已在宿主 llm 注册表可用。每次调用都先卸旧再重挂（设置
 * 变更后自然换新配置）；注册后立即用 listModels 探测该 route 真的能出模型——探测
 * 不过就当场卸载并返回 not-ok，调用方 warn 一行、降级回 inherit 或拒绝本次整理。
 * @returns {{ ok: true, route: string, models: number }
 *          | { ok: false, reason: string, error?: string }}
 */
export async function ensureConsolidationRoute(ctx, settings, { loadPiAi = defaultLoadPiAi } = {}) {
  const llm = llmServiceOf(ctx)
  if (!llm || typeof llm.registerAdapter !== 'function' || typeof llm.listModels !== 'function') {
    return { ok: false, reason: 'llm-service-unavailable' }
  }
  const spec = customRouteSpec(settings)
  if (!spec) return { ok: false, reason: 'custom-incomplete' }
  let PiAiAdapter
  try {
    PiAiAdapter = (await loadPiAi())?.PiAiAdapter
  } catch {
    return { ok: false, reason: 'pi-ai-adapter-unavailable' }
  }
  if (typeof PiAiAdapter !== 'function') return { ok: false, reason: 'pi-ai-adapter-unavailable' }
  const profile = customRouteProfile(spec)
  const adapter = new PiAiAdapter({
    profiles: () => new Map([[CONSOLIDATION_CUSTOM_ROUTE, profile]]),
    // 明文 key 直进请求头，不写日志、不进回执、不经宿主 credentials（硬规则 §1.9）。
    resolveApiKey: async () => spec.apiKey,
    auth: customRouteAuth(),
  })
  // 先卸旧再注册（设置变更重挂）。旧 handle 卸掉后若注册失败，custom 模式本次不可用，
  // 调用方按 not-ok 降级——比留着一份过期配置继续用更诚实。
  disposeCustomRouteHandle()
  let handle
  try {
    handle = llm.registerAdapter([CONSOLIDATION_CUSTOM_ROUTE], adapter)
  } catch (error) {
    return { ok: false, reason: 'register-failed', error: String(error?.message || error) }
  }
  // 服务性探测：注册成功 ≠ 真能出模型。listModels 走 adapter 本地目录（无网络），拿
  // 不到模型说明这版宿主的 adapter 不认外部构造的 profile——当场卸载，留给调用方降级。
  try {
    const models = await llm.listModels(CONSOLIDATION_CUSTOM_ROUTE)
    if (!Array.isArray(models) || models.length === 0) throw new Error('route serves no models')
  } catch (error) {
    try { handle?.() } catch {}
    return { ok: false, reason: 'custom-route-unserviceable', error: String(error?.message || error) }
  }
  customRouteHandle = handle
  return { ok: true, route: CONSOLIDATION_CUSTOM_ROUTE, models: 1 }
}

function disposeCustomRouteHandle() {
  const handle = customRouteHandle
  customRouteHandle = null
  if (typeof handle === 'function') {
    try { handle() } catch {}
  }
}

/** plugin 卸载钩子：释放注册表里的私有 route。幂等。 */
export function disposeConsolidationRoute() {
  disposeCustomRouteHandle()
}

// —— 宿主模型目录（UI 的 provider/model 选择器数据源）——————————————————————

function normalizeModelEntry(entry) {
  if (typeof entry === 'string') return entry.trim() ? { id: entry.trim() } : null
  if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.trim()) {
    const item = { id: entry.id.trim() }
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (name) item.name = name
    return item
  }
  return null
}

/**
 * 宿主已激活 route 的 provider/model 目录。单个 provider 的 listModels 失败降级为空
 * 数组不炸整体；llm service 缺席返回空目录。customAvailable 是「这台宿主能不能挂
 * custom 模式」（registerAdapter + PiAiAdapter 都在），discoveryAvailable 是
 * 「能不能代拉远端模型列表」（discoverModels 方法在）。
 */
export async function listHostModelOptions(ctx, { loadPiAi = defaultLoadPiAi } = {}) {
  const llm = llmServiceOf(ctx)
  if (!llm || typeof llm.listProviders !== 'function') {
    return { providers: [], customAvailable: false, discoveryAvailable: false }
  }
  const providers = []
  let routes = []
  try { routes = await llm.listProviders() || [] } catch { routes = [] }
  for (const route of routes) {
    const id = typeof route === 'string' ? route.trim() : String(route?.id || '').trim()
    if (!id) continue
    const name = typeof route === 'object' && typeof route?.name === 'string' ? route.name : ''
    let models = []
    try { models = (await llm.listModels(id) || []).map(normalizeModelEntry).filter(Boolean) } catch { models = [] }
    providers.push(name && name !== id ? { id, name, models } : { id, models })
  }
  let customAvailable = typeof llm.registerAdapter === 'function'
  if (customAvailable) {
    try { customAvailable = typeof (await loadPiAi())?.PiAiAdapter === 'function' } catch { customAvailable = false }
  }
  return {
    providers,
    customAvailable,
    discoveryAvailable: typeof llm.discoverModels === 'function',
  }
}

/**
 * 「拉取模型列表」：把 UI 草稿端点转给宿主的模型发现（dsh-llm-pi-ai 按 baseURL 逐
 * 协议问 /models）。apiKey 是一次性草稿凭据，只进发现请求、绝不进日志或回包。
 * useStoredKey 时复用设置里已保存的 custom key。返回结构化结果，UI 直接渲染。
 */
export async function discoverForkModels(ctx, { baseURL, api, apiKey, useStoredKey } = {}, settings = null) {
  const llm = llmServiceOf(ctx)
  if (!llm || typeof llm.discoverModels !== 'function') {
    return { ok: false, reason: 'discovery-unavailable', models: [] }
  }
  const url = String(baseURL || '').trim()
  if (!isPlainHttpUrl(url)) return { ok: false, reason: 'invalid-base-url', models: [] }
  const key = String(apiKey || '').trim() || (useStoredKey === true ? String(settings?.consolidationCustomApiKey || '').trim() : '')
  const request = { baseURL: url }
  if (CONSOLIDATION_CUSTOM_APIS.includes(api)) request.api = api
  if (key) request.apiKey = key
  try {
    const models = await llm.discoverModels(MODEL_DISCOVERY_NAMESPACE, request)
    // 宿主的 discoverModels 已按端点序去重；这里防御性再走一遍同一规则，mock/旧宿主
    // 返回重复 id 时 UI 不会看到两行同一个模型。
    const seen = new Set()
    const out = []
    for (const entry of (Array.isArray(models) ? models : []).map(normalizeModelEntry)) {
      if (!entry || seen.has(entry.id)) continue
      seen.add(entry.id)
      out.push(entry)
    }
    return { ok: true, models: out }
  } catch (error) {
    const message = String(error?.message || error)
    // NO_DISCOVERY：这台宿主没在 'llm-pi-ai' 命名空间注册发现（版本差异/未挂载）。
    if (/no model discovery is registered/i.test(message)) return { ok: false, reason: 'no-discovery', models: [] }
    // 其余错误（端点拒绝、协议不可列举）原样带回——宿主的公共诊断信息不含凭据。
    return { ok: false, reason: 'discovery-failed', error: message.slice(0, 300), models: [] }
  }
}

// —— 回包打码 ————————————————————————————————————————————————————————————
// 任何 RPC 回包不回传 consolidationCustomApiKey 明文（硬规则 §1.9）。对齐
// getVisionConfig 的 hasKey 模式：has<…> 布尔 + 尾 4 位（key 过短时只给掩码，
// 不回明文）。undefined 字段经 JSON.stringify 自然消失，回包不带键名。

/** 尾 4 位打码：key 长于 8 才给尾 4 位，否则只回 '****' 占位。 */
export function maskApiKeyTail(key) {
  const value = String(key || '')
  if (!value) return ''
  return value.length > 8 ? value.slice(-4) : '****'
}

export function redactConsolidationSettings(settings) {
  if (!settings || typeof settings !== 'object') return settings
  const key = String(settings.consolidationCustomApiKey || '')
  return {
    ...settings,
    consolidationCustomApiKey: undefined,
    hasConsolidationCustomApiKey: Boolean(key),
    consolidationCustomApiKeyTail: maskApiKeyTail(key),
  }
}
