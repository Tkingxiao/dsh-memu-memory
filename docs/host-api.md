# 宿主事实与 API 速查 — dsh-memu-memory

2026-10-27 实测，DSH 0.2.1-rc.3。查的时候才翻。

> §6.3「取 sessionId 的三种形状」是排错高频项，放在 `docs/troubleshooting.md` 附录 D。

## 6. 宿主事实与 API 速查（2026-10-27 实测，DSH 0.2.1-rc.3）


### 6.1 DSH 没有 embedding 能力

`ctx.llm`（`LlmRuntime`）只有 `stream` / providers / model discovery，**没有 `embed`**；`@deepseek-ai` 全 store 里 `embeddings` / `/v1/embeddings` / `createEmbedding` 命中数为 0；DeepSeek provider 只有 chat 模型；`dsh-api-gateway` 是 Typert RPC 复用（就是不许碰的 `/api`），不是 OpenAI 兼容 REST。所以「本地 embedding」**不可能由 DSH 承担**：MemU 自身也只有 doubao/jina/openai/openrouter/voyage 五个远端后端，无 torch/onnx/sentence-transformers/ollama。

本地化的唯一真实形态是「指向本机 OpenAI 兼容 embedding 服务」（自起 ollama / text-embeddings-inference），MemU 回落 `/embeddings`，`api_key` 可为空；插件只能预填 baseURL + 空 key，**不能声称离线可用**。宿主凭据 `ctx.credentials.resolve("DEEPSEEK_API_KEY")` 存在但对 embedding 无用；远程模式继续用插件自己的 `~/.memu/config.env`，**不读宿主 keychain**。


### 6.2 工作区注册表在宿主侧可读

`ctx.workspaceRegistry`：`list()`（同步）/ `get(id)` / `resolveByPath(path)` / `delete(id)` / `realpathNormalize`；`Workspace.path` 是 create 时 `fs.realpath` 规范化的值，与 `normalizeCwd` 同口径；`status()` 返回 `ok | missing-dir`，只查不改。

**关键**：从 DSH 删工作区**不删任何磁盘数据**（目录和 session log 都在），只取消注册。所以**记忆库归档必须看 registry 里还在不在，绝不能用 `fs.existsSync`**——文件夹被删 ≠ 从 DSH 移除，反之亦然。订阅 `ctx.on("domain/changed", ...)`（`dsh-storage-domain`），`change.domain === "workspace"` 时 `deleted` / order-put 就是移除信号。客户端侧服务名 `workspaceController`、命名空间 `workspace`，**没有 remote `list()`**，只有 `follow(signal)`。


### 6.4 读历史会话与标题

- `ctx.sessionQuery.listSessions()` / `readSession()` / `observeSession()`。
- `SessionRecord` 只有 `{ header, live, persisted, formatStatus }`，**没有 title**。
- 标题走 `readTitleSnapshots(ids)` → 每项 `{ sessionId, status, value: { session, title? } }`，文本在 `value.title.title`；`status === "rejected"` 的项只有 `reason`。未命名会话没有 title 事件，UI 必须准备短 id 回退。


### 6.5 fork、followup 与「等它跑完」

- 会话 fork：`ctx.sessions.fork(source, boundary?, childSessionId?)`——**source 必须 live**，同步返回 `Session`，不自己启动 agent，没有 parent/delivery。错误码 `SESSION_NOT_FOUND | SESSION_NOT_LIVE | SESSION_ALREADY_EXISTS | INVALID_BOUNDARY`。
- 历史会话整理走**种子重建**：`sessionQuery.readSession(id)` → `{ session, events, inheritedEventCount }` → `buildForkSeed(events, lastSeq)`（`@deepseek-ai/dsh-session`，可选 peer，动态 import）→ `ctx.agents.create({ sessionId, meta: { cwd, parentSession, isSeeded, agentPreset }, inheritedEventCount: lastSeq + 1, seed, agentOptions, signal })` → `{ agent, dispose }`。
- **fork 不继承父 Agent 的 options**：`agentOptions` 必须显式传顶层字段（不是 `meta`）。活跃会话取 `ctx.get("agents").get(id).session.requestHeader().config`；关闭会话取事件里最后一条 `request/header` 的 `data.header.config`。至少要有 `provider` / `model`（可带 `reasoningEffort`、`maxTokens`）；两处都没有就不要创建 fork，否则标准预设会在首步因 `{{model}}` 无值而死。
- `agent.followup(msg)` 只入队并唤醒 driver，**返回 void**；`await agent.whenIdle()` 只表示 driver 停了，**不代表这一轮成功**。followup 前订阅 `ctx.on("session/event", (session, event) => ...)`，只认 `session === agent.session` 且 `event.type === "turn/end"`；`whenIdle` 后检查 `event.data.reason.kind === "completed"`，`error` / `aborted` / 没有 `turn/end` 都按失败处理，不能推进整理游标。fork 整理必须 `whenIdle` 后再 `dispose`。
- **followup 会把消息画在输入框上方**（可编辑/可删）——这就是「整理提示出现在待发栏」的原因。**v0.4 起所有整理走 fork（§3.11），后台作业一律不碰 followup**。


### 6.6 定时器

`ctx.schedule`（`@deepseek-ai/dsh-schedule`：create/list/catalog/history/delete/update，`every_seconds | daily | weekly | cron`，最小 60s）**绑定单个 sessionId、往该会话投递 prompt**、需要 sessionPersistence、且拒绝 subagent 会话——**不适合插件级全局清扫**。插件自己的清扫用 `ctx.interval`（cordis 随作用域回收），没有才退回 unref 的 `setInterval`。

事件：`ctx.on("agent/status", { agent, status })`，`AgentStatus = idle | running`；另有 `session/created`、`session/disposed`、`session/flush`；事件类型含 `turn/start`、`turn/end`（`step/*`、`user/message…`）与 `compaction/*`。**`turn/end` 不 await flush，不要在那里读存储；判 fork 成败只读事件对象本身。**


### 6.7 RPC、slot 与注入折叠

```js
ctx.inject([connection, webServer], c => c.effect(() =>
  c.webServer.register({ kind: prefix, path: /dsh-memu-memory, handler })));
// handler 内做 connection.requestRejection + envelope 编解码
ctx.slots.inject(settings.section, ...)              // 设置页
ctx.inject([sidebarRightTabs], ...) + ctx.slots.register({ name: sidebar.right.pane.tab, key })
```

- 客户端当前 session：`sidebar.right.pane.tab` body 的 `sessionId` prop；客户端会话列表：`ctx.sessions.list`（`ObservableSnapshot`）。
- **注入折叠是宿主自带的，不要自己做。** `dsh-client-ui-chat` 用 `ContextInjectionRow`（一个 `DisclosureRow`）渲染所有带 `source.kind` 的消息：折叠标题 `message.contextInjection`（跨会话召回为 `message.contextRecall`）。宿主认识的 `KNOWN_FORMS = instructions | catalog | snapshot | notice | relay | recall`；表外的 form 走 opaque，仍会折叠。
- producer label 就是 **kind 原文**（如 `plugin:dsh-memu-memory`），不可自定义。`form: recall` 只有在 `kind: session-reference` + `references[].label` 时才走专门的召回正文；本插件用 `recall` 只是拿一个折叠行，要一行可读的折叠摘要就用 `form: notice` + `source.summary`。

---

### 6.8 预设工具面与 guide 的真机证据边界（2026-10-29）

本节只记录**本轮可复核的真机事实**。证据来自本机 DSH Desktop `0.2.1-rc.3`（`resources/app.asar/package.json`）、插件 `1.1.2` 的 v4 会话日志；日志是多个 zstd frame 拼接，必须解完所有 frame 再计数。计数口径是**唯一 plugin 消息 id / `request/header.data.header.tools` 的实际工具名**，不是字符串出现次数，也不读取聊天正文。

#### 已证实：标准会话

- 标准会话 `session-<redacted-standard-a>`（`agentPreset: "standard"`，21 个非 session 事件）：模型请求头 `request/header` 的工具表为 **82 个工具**，首尾两次一致；其中 `memu_*` 共 **10 个**：`memu_private_list`、`memu_private_recall`、`memu_private_remember`、`memu_private_update`、`memu_private_archive`、`memu_private_link`、`memu_private_unpin`、`memu_global_list`、`memu_global_recall`、`memu_status`。同一会话中 `===== memory anchor =====` 出现 1 次，锚点内是真实私有 id。
- 标准会话 `session-<redacted-standard-b>`（`agentPreset: "standard"`，本轮扫描时 1737 个非 session 事件）：`<memory-guide>` 只对应 **1 个** plugin 消息 id（`<redacted-plugin-message-id>`），锚点 1 次。该 id 在多个快照/工具记录里重复出现是日志回放，不是重复投放。
- 因此“标准会话的工具表里有 `memu_*`”“标准会话 anchor/guide 只投放一次”是**已证实**；标准会话的 guide 走 system prompt 段，不必然出现 `<memory-guide>` 消息。

#### 仅机制 + mock：独立人格预设 `yuike`

- 预设来源：`~/.dsh/.agent-presets/yuike/agent.cordis.yml`，15,645 bytes，mtime `2026-10-20T16:33:05Z`，sha256 `a5a978ab5cf62d24b3061bef5560ba7abfb84a635b73d8500fd893fe0fa1422e`；32 个 `name:` 条目中 **0 处 `memu`**，即该 bundle **没有列入 `dsh-memu-memory`**。
- 本机 95 个持久会话里 **没有 `agentPreset: "yuike"` 的会话**；报告中的“yuike 会话只有 1 行空壳”也无法作为真实对话证据。另有 3 个 `agentPreset: "yuike-ptc"` 会话（来自另一份 `dsh-yuike-ptc` bundle），13 次带工具表的请求头均无 `memu_*`，且日志中 `<memory-guide>`、`<memory-anchor>`、`<memory-context` 均为 0；这只能说明那个**不同 preset** 的历史状态，不能替代 `yuike` 的真机验证。
- 结论：`yuike` 的 guide 投放、anchor 送达、最终工具面**均只有 `tests/inject-guide.test.mjs` / `tests/preset-scope.test.mjs` 的 fake agents/fiber 机制证据**，真实会话未验证；不得写成“yuike 已验证有/没有 `memu_*` 工具”。

#### 未验证：显式列入本插件的预设

- 本机 `~/.dsh/.agent-presets/` 只有 `yuike` 这一份 agent preset；没有任何预设 bundle 显式列入 `dsh-memu-memory`。因此“预设显式列出本插件时工具可用”只有 mock 证据，本机没有可核对的真实会话。
- `lib/preset-scope.js` 的 `agents.list()` 真机形状本轮未直接采样；代码兼容 `{ agent, owner, ctx }` record、裸 agent、以及 `agents.get(sessionId)?.ctx` 回退，三种形状由 `tests/preset-scope.test.mjs` 的 fake agents 覆盖。真实宿主若只返回裸 agent 且无 `agents.get()` 上下文，仍会走“无 ctx”日志分支，不能当作已适配成功。

#### 不可推断

- **不能从“预设类型”推断工具面。** 最终工具名单由该预设自己的 `cordis.yml` 清单和宿主 scope 决定；本插件只能补注入监听，不能挂载工具，也不修改别人的预设文件。
- **工具已注册 ≠ 已向当前模型暴露。** 上文的工具名单取自 `request/header.data.header.tools`；没有该字段或只有标题请求的会话，不能拿插件侧注册表冒充模型可见工具。
- **guide 有 `<memory-guide>` ≠ 有 `memu_*`。** 正文自带“若本会话的工具列表里没有 `memu_*` 工具，请忽略本段”，它只声明规则可用性，不证明工具存在。

复核方法：用 `zlib.zstdDecompressSync` 逐 frame 解压 `~/.dsh/sessions/<bucket>/<id>/session.v4.jsonl.zstd`；只统计 `request/header` 的工具名、`session.v4` 消息 id 和 `<memory-guide>`/`===== memory anchor =====` 标签。不要打印会话正文，不要把同一消息在快照中的重复出现计成多次投放。

---
