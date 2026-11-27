# 移植到 MCP / 其它宿主

给**想把这个插件搬到 MCP server、CLI 或别的 agent 宿主的人**看的。目标只有一个：让适配器复用这里的记忆实现，而不是 fork 一份再各改各的。

结论先放前面：**工具面和存储层已经可以复用，注入层和界面层不可能复用**——这不是工程量问题，是协议边界。

---

## 1. MCP 能接手什么，接不了什么

| 插件里的东西 | MCP 能否接手 | 说明 |
|---|---|---|
| 记忆读写、召回、库管理 | ✅ 能 | 走 `dsh-memu-memory/port`，见 §2 |
| 工具声明的 name / description / inputSchema | ✅ 能 | `collectToolSpecs()` 直接给，`toInputSchema()` 转格式 |
| MemU 引擎（Python CLI） | ✅ 能 | 引擎本来就用 `MEMU_*` 环境变量自持配置，不依赖宿主 |
| **逐轮自动注入** | ❌ 不能 | MCP 只有 tools/resources/prompts；`agent/pre-step` 那种「每轮往上下文插一条消息」没有对应通道 |
| **会话身份** | ❌ 不能 | `tools/call` 只发 `{ name, arguments }`，没有 `_meta`、没有 sessionId、没有 cwd |
| **宿主模型路由** | ❌ 不能 | MCP server 是外部进程，拿不到宿主的 `llm` 服务；得自己配 key |
| **WebUI / 设置页** | ❌ 不能 | 那是宿主 RPC + slot + React 组件 |

所以现实的做法是**双形态**：MCP server 提供工具，宿主插件保留注入与界面。两边共用 `port` 入口和同一份数据目录。

---

## 2. 现成入口：`dsh-memu-memory/port`

```js
const {
  collectToolSpecs, toInputSchema,          // 工具声明
  privateRecall, privateList, privateRemember, privateUpdate, privateArchive,
  privateDelete, globalRecall, globalList,   // 记忆读写
  listLibraries, getLibrary, loadPrivateIndex, // 库与索引
} = await import('dsh-memu-memory/port')
```

`lib/port-surface.js` 只做 re-export 加一个纯函数，不含状态逻辑。**适配器只依赖它，不要 import `lib/index.js`**——那是宿主插件入口，注册的是 ctx 服务、注入钩子和 RPC。

### 工具声明怎么拿

```js
const specs = collectToolSpecs()   // 14 个：私有读写 + 词典 + 全局 + status
// specs[i] = { name, description, parameters, execute, output, timeoutMs, ... }

const tools = specs.map((spec) => ({
  name: spec.name,
  description: spec.description,
  inputSchema: toInputSchema(spec.parameters),
}))
```

`parameters` 是**宿主的值 schema 方言**，和标准 JSON Schema 只差一处：必填写成属性上的 `required: true`，而 JSON Schema 要父级 `required: [...]`。`toInputSchema()` 就是干这个的，别再自己写一遍。

`collectToolSpecs()` 内部用一个只收集不注册的假 ctx 跑一遍 `registerTools`，跑完还原注册报告，所以**调用它不会影响 `memu_status` 的注册清单**。

---

## 3. 最小的适配器骨架

```js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { collectToolSpecs, toInputSchema, privateRecall, privateRemember } from 'dsh-memu-memory/port'

const LIBRARY = process.env.MEMU_LIBRARY_ID   // 适配器自己的作用域来源

const server = new McpServer({ name: 'memu', version: '1.0.0' })

for (const spec of collectToolSpecs()) {
  server.tool(spec.name, spec.description, toInputSchema(spec.parameters), async (args) => {
    // 无会话调用：显式传 libraryId，不要用 spec.execute(args, {})（见 §4）
    const result = await runWithoutHost(spec.name, args)
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] }
  })
}

async function runWithoutHost(name, args) {
  if (name === 'memu_private_recall') {
    const scored = await privateRecall({ libraryId: LIBRARY, query: args.query, topK: args.topK })
    return scored.files.map((file) => `${file.name}  ${file.entry?.title || ''}`).join('\n') || '（无命中）'
  }
  if (name === 'memu_private_remember') {
    return await privateRemember({ libraryId: LIBRARY, content: args.content, title: args.title })
  }
  throw new Error(`${name} 还没有无会话实现`)
}
```

**先说清楚**：上面这 14 个工具里，目前只有读写/库管理这批能直接无会话调用；`memu_status`、词典工具、`link_suggest` 这些要么依赖会话诊断，要么需要补充作用域参数。移植时按需逐个接，别指望一次全通。

---

## 4. 三个必须知道的边界（都是刻意的）

**① 无会话的 `privateRecall` 只读显式指定的那一个库。**
跨库聚合、情绪衰减、场景时间全部退回中性值。要跨库请自己按库循环——别指望它替你扫全部库。

**② 带边界标记的记忆对无会话调用方不可见。**
`contextVisible` 在没有 `memoryContext` 时会拒绝有 `channelId` / `characterId` / `worldId` 边界的条目。这是**安全默认**：没有身份就不给看跨角色隐私。要走通就得让适配器自己提供等价的身份维度（目前没有公开入口）。

**③ `spec.execute(args, {})` 不会抛错，而是返回一段错误文本。**
因为 `toolBase` 统一做了 fail-open 包装，实测返回 `"dsh-memu-memory error: no bound session"`。适配器**不要**把 `spec.execute` 直接当 MCP handler，否则每个调用都会"成功"返回一句错误。handler 请走 §3 那种显式库函数。

**④ 无会话不做会话级授权，但库级约束仍然生效。**
`libraryId` 必须真实存在（否则 `unknown library`），且该库所属文件夹在设置里被关掉时会拒绝读写（`private memory is disabled for this folder`）。换句话说：能拿到 `libraryId` 就能操作那一个库，但**不会**因为「调用方没有会话」而绕开用户关掉的开关。这是刻意的——适配器不该替用户重新打开他关掉的记忆。

---

## 5. MCP 配置的两个坑

**环境变量会被清洗。** DSH 的 MCP stdio 客户端 spawn 子进程时，会删掉所有匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的环境变量名——`MEMU_API_KEY` 正好中招。所以必须显式传：

```yaml
- id: mcp-memu
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: memu
    transport: stdio
    command: node
    args: ['D:/path/to/memu-mcp/server.js']
    expandTemplates: true
    env:
      MEMU_API_KEY: '${credential:MEMU_API_KEY}'
```

不这么做，引擎会静默落到无 key 状态（召回降级、整理不可用），而界面上看不出原因。

**工具名会带前缀。** 在 DSH 里它们显示为 `mcp__memu__memu_private_recall`。前缀是 `mcp__<serverName>__`，建议 `serverName: memu`。

---

## 6. 别做的事

- **别为了 MCP 去抽象 `ctx`。** 那会牵动 600KB 的 `client.js` 和整条注入路径，收益为零。
- **别给工具加 `sessionId` 参数。** 那是把宿主概念漏进协议，而且模型根本不知道自己的 sessionId。
- **别试图用 MCP 复刻注入。** `agent/pre-step` 往上下文插消息这件事，MCP 协议里没有对应物；写 `AGENTS.md` 也不行——DSH 的 `agent-instructions` 不监视外部编辑，只在成功的 `read`/`write`/`edit` 或恢复会话时才重新对账。

---

## 7. 相关代码位置

| 想改什么 | 去哪 |
|---|---|
| 工具定义与 handler | `lib/tools.js`（`registerTools` / `collectToolSpecs`） |
| 召回、读写、库解析 | `lib/memory.js`（`privateRecall` 的 `scope` 分支是给无会话调用方的） |
| 移植入口 | `lib/port-surface.js` |
| 引擎与凭据 | `lib/memu.js`、`lib/memu-config.js`、`requirements.lock` |
| 宿主集成点全貌 | `lib/index.js`（服务注册）、`lib/inject.js`（注入）、`lib/rpc.js`（WebUI） |
