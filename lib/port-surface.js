// 移植适配器的稳定入口（`package.json` exports: "./port"）。
//
// 为什么单独一个文件：MCP server / 脚本 / 其它宿主只需要「工具规格 + 记忆读写 +
// 库与索引」，不该为了这三样去读 tools.js 里三十段内联闭包，也不该依赖
// lib/index.js——那是宿主插件入口，注册的是 ctx 服务、注入钩子和 RPC。
//
// 无会话调用方（MCP server、CLI）：
//   const specs = collectToolSpecs()                 // 30 个 { name, description, parameters, execute }
//   await privateRecall({ libraryId, query, topK })  // 显式库，不需要会话
//   await privateRemember({ libraryId, content, title })
//   listLibraries() / loadPrivateIndex(libraryId)
//
// 有会话调用方照旧传 exec（{ agent: { session: { header: { id, cwd } } } }），行为与
// 插件内部完全一致。
//
// 两条必须知道的边界（都是刻意的）：
//   1. 无会话的 privateRecall 只读显式指定的那个库：跨库聚合、情绪、场景时间全部
//      退回中性值（见 lib/memory.js 里 scope 的注释）。要跨库请自己按库循环。
//   2. 没有会话就没有 memoryContext，所以带 channelId/characterId 等边界的记忆对
//      无会话调用方不可见（context.js 的 contextVisible）。这是安全默认，不是 bug。
//
// 本文件只做 re-export，不含逻辑；不要在这里加会改变内部状态的东西。
// 例外只有 toInputSchema：它是纯函数，存在的唯一目的是把宿主 schema 方言翻译成
// MCP / JSON Schema，避免每个适配器各写一遍、各错一遍。

export { collectToolSpecs } from './tools.js'

/**
 * 把宿主值 schema 方言的「属性映射」转成标准 JSON Schema 的 object 节点。
 *
 * 两者只差一处：宿主把必填写成属性上的 `required: true`，JSON Schema 要求父级
 * `required: [...]`。其余键（type/description/title/default/examples/enum/const/
 * properties/additionalProperties/items）语义一致，原样保留。
 *
 * @param {object} parameters `collectToolSpecs()` 里某个工具的 `parameters`
 * @returns {{type:'object', properties:object, required?:string[]}}
 */
export function toInputSchema(parameters) {
  const { properties, required } = convertProperties(parameters || {})
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

function convertProperties(map) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(map || {})) {
    if (!spec || typeof spec !== 'object') { properties[key] = spec; continue }
    const { required: isRequired, ...rest } = spec
    properties[key] = convertNode(rest)
    if (isRequired === true) required.push(key)
  }
  return { properties, required }
}

function convertNode(node) {
  if (Array.isArray(node)) return node.map(convertNode)
  if (!node || typeof node !== 'object') return node
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    // 嵌套属性映射同样把 required 提到该层 object 上。
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = convertProperties(value)
      out.properties = nested.properties
      if (nested.required.length) out.required = nested.required
      continue
    }
    out[key] = convertNode(value)
  }
  return out
}

export {
  privateRecall, privateList, privateRemember, privateUpdate, privateArchive, privateDelete,
  previewDelete, restoreDeleted, globalList, globalRecall, globalSetStatus, globalDelete,
  importMemories, domainOf, decayStrength, appliesToDomain, visibleToSession, isMemoryEligible,
} from './memory.js'

export {
  listLibraries, listLibrariesAll, getLibrary, createLibrary, ensureLibraryForCwd,
  getSessionBinding, ensureSession, effectiveScope,
  loadPrivateIndex, loadGlobalIndex,
} from './state.js'
