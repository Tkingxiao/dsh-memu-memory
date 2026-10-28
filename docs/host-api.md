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
- 历史会话整理走**种子重建**：`sessionQuery.readSession(id)` → `{ session, events, inheritedEventCount }` → `buildForkSeed(events, lastSeq)`（`@deepseek-ai/dsh-session`，可选 peer，动态 import）→ `ctx.agents.create({ sessionId, meta: { cwd, parentSession, isSeeded, agentPreset }, seed, signal })` → `{ agent, dispose }`。
- `agent.followup(msg)` 只入队并唤醒 driver，**返回 void**；要等它真跑完只能 `await agent.whenIdle()`，fork 整理必须 `whenIdle` 后再 `dispose`。
- **followup 会把消息画在输入框上方**（可编辑/可删）——这就是「整理提示出现在待发栏」的原因。**v0.4 起所有整理走 fork（§3.11），后台作业一律不碰 followup**。


### 6.6 定时器

`ctx.schedule`（`@deepseek-ai/dsh-schedule`：create/list/catalog/history/delete/update，`every_seconds | daily | weekly | cron`，最小 60s）**绑定单个 sessionId、往该会话投递 prompt**、需要 sessionPersistence、且拒绝 subagent 会话——**不适合插件级全局清扫**。插件自己的清扫用 `ctx.interval`（cordis 随作用域回收），没有才退回 unref 的 `setInterval`。

事件：`ctx.on("agent/status", { agent, status })`，`AgentStatus = idle | running`；另有 `session/created`、`session/disposed`、`session/flush`；事件类型含 `turn/start`、`turn/end`（`step/*`、`user/message…`）与 `compaction/*`。**`turn/end` 不 await flush，不要在那里读存储。**


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
