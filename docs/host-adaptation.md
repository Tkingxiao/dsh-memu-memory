# 宿主版本适配手册 — dsh-memu-memory

给下一次「DSH 又发新版本了」用。目标是把适配变成一份可重复的检查表：**先读宿主、再跑真机、最后只改证据支持的地方**。
2026-11-05 用 `0.2.2-rc.1` 完整走了一遍，实测记录在 §5。

> 这份文档只讲**宿主版本之间的适配流程**。逐构建的核对台账、逐宿主面的形状矩阵、破坏性变更账本在
> `docs/host-versions.md`（§13）；改记忆语义、RPC、UI 的常规流程在 `docs/contributing.md`；
> 宿主 API 的当前事实速查在 `docs/host-api.md`。同一事实只写一次，冲突时以 §13 为准。

---

## 1. 结论先行（2026-11-05，DSH 0.2.2-rc.1）

- **核心面无需改动**：13 个 `memu_*` 工具进入模型请求的 `request/header`；`<memory-guide>` 首轮注入 1 次；`turn/end` 为 `completed`；设置页「MemU 记忆」、右侧栏「MemU 记忆」、新会话弹窗、`/dsh-memu-memory` RPC 全部正常；浏览器控制台 0 error。
- **0.2.2-alpha.3 → 0.2.2-rc.1 在 memu 用到的宿主 `src` 上零改动**。rc.1 的 cordis 4.1 / timer 1.2 / include 1.1 升级没有影响本插件。
- **唯一发现的真实版本差异是 `ctx.schedule`**：`0.2.2+` 是宿主级任务表，`0.2.0`–`0.2.1` 是会话级提醒。日期唤醒只实现前者；现在用 `scheduleFlavor()` 结构探测，旧宿主返回 `{skipped:'schedule-api'}` 并只 warn 一次（1.2.6）。
- **不按版本号分支**：memu 没有 `versions/` 适配目录。宿主差异一律用能力探测（方法/字段存在性）或直接读公开形状；样式/逻辑代码里不出现 `semver` 比较。

---

## 2. memu 的宿主面清单（每次升级逐项过）

> 下表的「0.2.2-rc.1 核对结果」只是**当初那一版**的快照，不随后续宿主更新。**逐版本的当前答案在
> `docs/host-versions.md` §13.2**；两处冲突以 §13.2 为准。本节回答「有哪些面要过」，§13 回答「每个面在各版本长什么样」。

### 2.1 Node 半侧

| 面 | memu 里的落点 | 0.2.2-rc.1 核对结果 |
|---|---|---|
| `ctx.tools.register` + `defineTool` | `lib/tools.js` `toolBase()` | 未变；13 个工具全部注册，`request/header` 可见 |
| `agent/pre-step` | `lib/inject.js` `registerInjection()` | 未变；payload 新增 `modelSelection`（本插件不读） |
| `agent/status` / `session/event` / `session/disposed` | `lib/inject.js`、`lib/inbound.js` | 未变 |
| `ctx.get('agents')`（`list()` / `get()` / `create()`） | `lib/preset-scope.js`、`lib/private.js`、`lib/curator.js` | 未变；`Agent.ctx` 仍在 |
| `ctx.get('sessionQuery')`（`listSessions` / `readSession` / `observeSession` / `readTitleSnapshots`） | `lib/rpc.js`、`lib/private.js`、`lib/curator.js` | 包源码未变 |
| `ctx.get('workspaceRegistry')` / `domain/changed` | `lib/rpc.js`、`lib/cycle.js` | 未变 |
| `ctx.get('subagents').startActivation` | `lib/curator.js` | **0.2.2-rc.2 起形状变了**：`SubagentActivationSpec` 扁平化（`parent`/`cwd`/`prompt`/`agentOptions` 平铺顶层，移除 `request` 外层），同批新增树内省方法 `rootOf`/`namesOf`/`resolveName`/`waitForTreeWork`。插件按 §3.4 用标记方法做结构探测选形态，另带零副作用 `TypeError` 单次回退兜底（两代宿主都在任何副作用之前抛 `TypeError`）；覆盖两代契约的用例在 `tests/curator-contract.test.mjs`。结果 `stopReason`/`output` 未变 |
| `ctx.get('attachments').readImage` | `lib/media.js` | 未变 |
| `ctx.get('schedule')` | `lib/salient-wake.js` | **变了**：见 §6.1 |
| `connection.requestRejection` / `authorizeLibrary` / `webServer.register` | `lib/rpc.js` | rc.1 当时是 `kind:'prefix'` + `handler`，守卫走 `requestRejection`；**`requestRejection` 自 `0.2.3-alpha.1` 起已从宿主移除，`authorizeLibrary` 任何版本都没有** → §13.3 |
| `ctx.interval` / `ctx.effect` / `ctx.on(..., {prepend})` | `lib/cycle.js`、`lib/index.js`、注入/监听 | cordis 4.1 未破坏这些用法 |
| `buildForkSeed`（动态 import `@deepseek-ai/dsh-session`） | `lib/private.js` | 仍从包根导出 |
| `createUserMessage({source:{kind:'plugin:dsh-memu-memory', form:'recall'}})` | `lib/inject.js` | 未变；`plugin:` 前缀仍被宿主接受 |

### 2.2 Client 半侧

| 面 | memu 里的落点 | 0.2.2-rc.1 核对结果 |
|---|---|---|
| `window.__ModuleLoader__.load({id, factory})` | `lib/client.js` 包壳 | 未变；宿主启动图里有 `dsh-memu-memory` |
| `ctx.slots.inject('settings.section')` + `register` | `lib/client.js` `apply()` | 未变；设置页出现「MemU 记忆」 |
| `ctx.slots.inject('sidebar.right.pane.tab')` + `register` | 同上 | 未变；右侧栏出现「MemU 记忆」 |
| `ctx.inject(['sidebarRightTabs'])` + `sidebarRightTabs.register({id,kind,title,guide})` | 同上 | 未变 |
| `ctx.inject(['betterSidebar'])`（可选第三方） | 同上 | 仍按可选服务处理 |
| `ctx.locale.register(NS, {zh,en})` / `bind` | 同上 | 运行时仍只要求两条基线语言 |
| `ctx.connection.rpc.call(prefix, method, payload)` | 同上 | 未变 |
| `ctx.sessions.list`（`byId` / `ids` 快照） | 同上 | 契约未变 |
| `ctx.get('sidebarRight').mounted` / `uiSession.adapter.current` | 同上 | 未变（仍作为当前会话来源） |
| `dsh.client` 清单（`platform:'web'`、`inject`、`immediately`） | `package.json` | 字段仍被识别；`inject` 里没有启动图行的包会被忽略（不是错误） |

### 2.3 装载与打包

| 面 | 检查点 |
|---|---|
| `engines.dsh` / `peerDependencies` | 宿主门禁在 `engines.dsh` 存在时只看它；**不要收窄、不要加下界到新版本**，否则旧宿主整包不加载 |
| `dsh.bundle.patch` | `cordis.patch.yml` 的 `insert` 行仍被 include 1.1 接受；显式 `id` 必须保留（匿名行在父配置重写后会重启） |
| `files` / `exports` | 新增运行时文件必须两处都进；`lib/` 是提交内容（本仓库无构建步骤，改 `lib/` 就是改发布物） |
| `dsh.client` | `platform:'web'` + `exports['./client']`；客户端包只在 `platform` 匹配时进入启动图 |

---

## 3. 新宿主发布时的标准流程

### 3.1 固定目标构建

先确认「新版本」到底是哪个构建：npm `dist-tags`（`latest` / `next` / `alpha`）与用户实际安装的 launcher `versions/<v>` 可能不是同一个。优先用**用户机器上真实存在的那个版本目录**做真机验证。

```bash
npm view @deepseek-ai/dsh dist-tags
ls "<launcher>/versions/"            # 真机事实
```

源码事实用 tag 固定，不要用浮动 master：

```bash
cd D:/Code/deepseek-harness
git fetch origin tag dsh-v0.2.2-rc.1 --no-tags
git rev-parse dsh-v0.2.2-rc.1^{commit}
```

### 3.2 只 diff memu 用到的包

先看规模，再读文件。测试目录的变更不算事实：

```bash
git diff --stat dsh-v0.2.2-rc.5 dsh-v0.2.3-alpha.1 -- \
  'packages/core/tools/src/**' 'packages/core/session/src/**' \
  'packages/core/agent/src/**' 'packages/core/agent-loop/src/**' \
  'packages/llm/llm/src/**' 'packages/session-query/*/src/**' \
  'packages/schedule/schedule/src/**' 'packages/subagent/subagent/src/**' \
  'packages/attachment/attachment/src/**' 'packages/host/webserver/src/**' \
  'packages/client/modules/src/**' 'packages/client/locale/src/**' \
  'packages/client/connection/src/**' 'packages/client/ui-settings/src/**' \
  'packages/client/ui-chat/src/**' 'packages/client/remote-connection/src/**' \
  'packages/client/ui-sidebar-right/src/**' 'packages/workspace/*/src/**' \
  'packages/session/*/src/**' 'packages/api/session-controller/src/**'
```

路径必须兼容**两层包目录**：本仓库既有 `packages/core/tools/src/**`，也有
`packages/session-query/session-query/src/**` 和 `packages/workspace/workspace/src/**`。
只写单层会漏整包——§5.5 第 1 条的「包消失」误判就是这么来的（所以下面用 `*` 占中间一层）。

再跑一次全量比对，确认上面这张清单没有漏掉真正改动的包：

```bash
git diff --stat <旧tag> <新tag> -- 'packages/*/src/**' 'packages/*/*/src/**' \
  ':(exclude)packages/*/vendor/**' ':(exclude)packages/*/*/vendor/**' | tail -1
```

两个数字差得远 = 清单漏了包，把漏掉的包补进上面那条命令再来一遍。读的时候按
「导出/契约/服务方法/事件 payload」四类看，不要逐行读实现；测试目录的变更不算事实。
**跨 tag 往往只有 `package.json` 版本号变化**：`0.2.2-alpha.3 → 0.2.2-rc.1` 在 memu 用到的全部
`src` 上就是零改动（vendor 代码在 alpha.3 已定型）。

### 3.3 四个装载门

1. `engines.dsh` 与 peers 是否仍满足（不要改门禁）。
2. `dsh.bundle.patch` 的 `insert` 行是否仍被解析（`--dump-config` 看得到 `dsh-memu-memory`）。
3. `dsh.client` 是否仍进入启动图（页面里的 `window.__DSH_BOOT__` / `plugins/??…`）。
4. 工具 DSL 是否仍接受 `lib/tools.js` 的 schema（真机 `request/header` 的工具名是最硬的证据）。

### 3.4 服务 / 事件 / 字段

按 §2 的表逐项问「这个名字还在吗、参数形状变了吗、返回值形状变了吗」。形状变化用**能力探测**处理：

- 首选「新方法存在与否」（如 `schedule.edit`）；
- 其次「返回值是数组还是 `{items}`」；
- 最后才是「字段可选性」（`?.` + 默认值）。

不要写 `if (version >= '0.2.2')`。版本号解析在 Node 半边也拿不到客户端宿主版本，客户端更拿不到。

### 3.5 真机四件套

1. `--dump-config`：确认插件行在组合里。
2. 浏览器：页面能开、`style[data-dsh-memu-memory="ui"]` 在、设置页有「MemU 记忆」、右侧栏有「MemU 记忆」、新会话弹窗能关。
3. 页面内 RPC：`fetch('/dsh-memu-memory/getSettingsState', …)` 返回 `{ok:true}`。
4. Headless + mock LLM：跑一轮真实回合，断言 13 个工具 + guide 1 次 + `turn/end completed`。

搭法见 §4。**四条都跑过才算「适配完成」**；只跑 `npm test` 不算（它用 fake 宿主）。

### 3.6 记录

- `README.md` / `README.zh.md` 的兼容性表加「verified on …」。
- `docs/host-api.md` 更新对应小节；新发现的事实写进 §6.9。
- `CHANGELOG.md` 写清「验证了哪个构建、哪些面、哪些没测」。
- 本文件 §7 加一行。

---

## 4. 真机环境搭法（Windows）

### 4.1 用 launcher 的安装，不要临时 npm 装

`<launcher>/versions/<v>/node_modules/@deepseek-ai/dsh/lib/bin.js` 是完整宿主。临时 `npm install @deepseek-ai/dsh` 会拖入可选 AWS SDK（几百个包、几分钟到几十分钟），还容易被文件锁打断（`ENOTEMPTY` 半装）。适配验证优先用 launcher 已装版本。

### 4.2 隔离 home + 最小 profile

不要碰 `~/.dsh` 的真实记忆库。用 launcher 的独立 home：

```text
<launcher>/homes/0.2.2-rc.1/
  profiles/memutest/            # 只放 dsh-memu-memory
  profiles/memutest-headless/   # base + headless + memu，跑真实回合
```

profile 的 `package.json` 只列 memu；`@deepseek-ai/dsh-base` / `dsh-web-app` 由宿主安装解析。把插件**复制**到 `profiles/<p>/node_modules/dsh-memu-memory`（不要 junction，Windows 权限与清理更麻烦；复制也避免测试时改到源码）。

### 4.3 配一个本地假模型

`profiles/<p>/cordis.patch.yml`：

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      memu-mock:
        displayName: MemU Mock
        api: openai-completions
        baseURL: http://127.0.0.1:8090/v1
        headers:
          Authorization: Bearer local-mock
        models:
          - id: dsh-mock-llm
            name: MemU Mock (eval only)
            contextWindow: 128000
            maxTokens: 4096
            reasoningEfforts: false
- id: agent-default-model
  config:
    provider: memu-mock
    model: dsh-mock-llm
```

`- id/config` 是**整份替换**，不是合并；`provider`/`model` 必须写在 `config:` 下。非推理模型必须 `reasoningEfforts: false`，否则 `INVALID_CONFIG`（回合在发请求前中止，看起来像“没反应”）。

启动假端点：

```bash
node scripts/mock-llm.mjs --port 8090 --log ./mock.jsonl
```

### 4.4 Web 宿主与浏览器

```bash
DSH_HOME="<launcher>/homes/0.2.2-rc.1" \
  node "<launcher>/versions/0.2.2-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  memutest --no-open --port 39430
```

- stdout 只打印一行 `dsh web: http://…/?token=…`；用唯一日志文件接住，别让后续启动把它截断。
- `GET /?token=…` 返回 303 换会话 cookie；curl 要 `-L -c/-b`。
- 页面里的 `plugins/??<pkg>/client.js&rev=…` 是**组合 URL**；直接请求 `/plugins/<pkg>/client.js` 可能 404，属正常。
- Playwright 自带的浏览器版本可能与本机已装版本对不上（例如要 1248、只有 1194）；用系统 Chrome：
  `chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })`。
- 首次启动会叠三个弹窗：宿主「预览版说明」、宿主「开始使用 / 登录或 API Key」、本插件的新会话弹窗。断言前先按文本关掉；它们不是插件缺陷。
- 本插件的新会话弹窗是 `[data-dsh-memu-memory-gate]` 下的 `[role=dialog]`，出现是设计行为。

### 4.5 读会话日志

会话日志在 `<home>/sessions/<project>/<sessionId>/session.v4.jsonl.zstd`，是**多个 zstd frame 拼接**；Node 的 `zstdDecompressSync` 一次性调用只解第一帧。用 `scripts/drive-session.mjs` 里的 `scanZstdFrames` 逐帧解。

断言的锚点：

- `request/header` → `data.header.tools` 的名字（数 `memu_*`）；
- `user/message` → `source.kind === 'plugin:dsh-memu-memory'`、`source.form`、正文前缀 `<memory-guide` / `===== memory anchor =====`；
- `turn/end` → `data.reason.kind === 'completed'`。

### 4.6 Headless 跑一轮

```bash
DSH_HOME="<launcher>/homes/0.2.2-rc.1" \
  node "<launcher>/versions/0.2.2-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  memutest-headless --json "hello, please remember that my cat is named Mochi"
```

headless 会禁用 `deepseek-account`；没有配假模型时会以 `MISSING_CREDENTIAL` 结束（不是插件问题）。

---

## 5. 0.2.2-rc.1 实测记录（2026-11-05）

环境：launcher `versions/0.2.2-rc.1` + 独立 home；profile 只加 `dsh-memu-memory`；provider 为本地 `mock-llm`。

### 5.1 页面 / RPC

- `GET /?token=…` 303 → 200，页面 40,428 bytes。
- 启动图：`{"id":"dsh-memu-memory", … "inject":[client-store, locale, connection, ui-settings, ui-sidebar-right], "immediately":true}`。
- 浏览器执行后：`style[data-dsh-memu-memory="ui"]` 存在；控制台 0 error、0 warning。
- 页面内 `fetch('/dsh-memu-memory/getSettingsState')` → 200 `{ok:true, value:{engine:…, memuConfig:…}}`。

### 5.2 UI 入口

- 设置页：导航出现「MemU 记忆」。
- 右侧栏：出现「MemU 记忆 / 记忆库、注入与全局记忆」。
- 新会话弹窗：正常显示「这次对话要使用记忆吗？」并可关闭。

### 5.3 一轮真实回合（headless + mock）

- 会话 `session-565ffa44-…`：21 个事件。
- `request/header`：`provider=memu-mock`、`model=dsh-mock-llm`、**36 个工具**，其中 13 个 `memu_*`：`memu_global_list`、`memu_global_recall`、`memu_lexicon_propose`、`memu_lexicon_search`、`memu_private_archive`、`memu_private_link`、`memu_private_link_suggest`、`memu_private_list`、`memu_private_recall`、`memu_private_remember`、`memu_private_unpin`、`memu_private_update`、`memu_status`。
- 插件消息：1 条 `source.kind='plugin:dsh-memu-memory'`、`form='recall'`，正文 `<memory-guide rules="…">`。
- `turn/end`：`completed`；无 error 事件。
- mock LLM 记录：首请求 `markers.guide=1`，其余块为 0（空库、默认设置）。

### 5.4 没测的

- 桌面壳（Windows 标题栏、原生按钮区）——本插件不写 DOM app-region，但仍未在 0.2.2 桌面上跑过。
- ~~全局整理（`subagents.startActivation`）与历史会话 fork（`agents.create` + `followup`）只核对了类型/源码，没有在 0.2.2 真机上跑完一整次作业。~~ **1.2.7 实证补记**：这条漏测面被内部真机评测击中——rc.1 的种子校验（`assertAssistantSettlementShape`）要求 `assistant/message.data.stream` 是数组，而插件种子清噪曾直接删除该字段，**0.2.2-rc.1 上每个整理 fork 种子必被拒**（1.2.6 已发布版中招）。已修：种子携带**空 stream 数组**（`lib/private.js` compactSeedEvents），并用 `node scripts/check-seed-compat.mjs --session-pkg <宿主 dsh-session 的 lib/index.js>` 固化为**每个新宿主版本适配检查表的必跑项**（PASS 后再跑完整整理作业）。全局整理（startActivation）仍属源码核对面。
- 日期唤醒的**真实投递**没有等 5 分钟周期；只核对了 `ctx.schedule` 的 rc.1 类型与单测。
- 从 0.2.1 升级上来的旧库/旧 state.json：未在 0.2.2 上做迁移回归（数据格式未变，但不宣称已测）。

---

## 5.5 0.2.2-rc.5 / 0.2.3-alpha.1 / 0.2.3-alpha.2 源码核对（2026-11-23 起，逐 tag 复核于 2026-11-26）

逐面结论与 commit 已迁到 `docs/host-versions.md` §13.1–§13.3。这里只留两条**流程层面**的教训：

1. **包目录形状要先怀疑自己的搜法**：`@deepseek-ai/dsh-session-query` 的源码目录从 0.2.0 起就是
   嵌套的（`packages/session-query/session-query/src/**`）。第一轮按单层路径搜不到，就把「包消失」
   记成了事实。§3.2 的 diff 清单因此改成兼容嵌套的写法。
2. **「没报错」不等于「守卫还在」**：RPC 入口守卫的两级探测（`requestRejection` →
   `isTrustedApiRequest`）在 `0.2.3-alpha.1` 之后同时落空——后者是模块级函数，不挂在 service 上。
   现已补第三级 `connection.admit(request)`（返回 `{peer}` 或 `{rejection}`），并在
   `tests/webui-auth.test.mjs` 钉住「只有 admit 的宿主仍然被守住」。试过 fail-closed，被 21 个
   RPC 守卫用例否掉：仓库的语义是「没有守卫就放行 + 留一行 warn」。

**原待办已判定不必做**：「新宿主只暴露 `sessionPersistence.open(id,'read')` 时要补读适配器」——
`readColdSessionLog` 内部本来就用 read 模式打开会话（`cold-read.ts` 的 `persistence.open(id, 'read')`），
插件侧的候选探测与 `COLD_LOG_READER_UNAVAILABLE` 降级分支保留即可。

---

## 6. 已知陷阱与取舍

### 6.1 `ctx.schedule` 两代 API

| 构建 | 方法形状 | 状态 |
|---|---|---|
| `0.2.2+` | `create(request)`、`list(request) -> {items}`、`edit({id, action:'delete'})` | memu 的日期唤醒使用这一代 |
| `0.2.0`–`0.2.1` | `create(sessionId, request)`、`list({sessionId}) -> 数组`、`delete({sessionId, id})` | 结构探测为 `session`，跳过并只 warn 一次 |

识别用 `scheduleFlavor()`（`lib/salient-wake.js`）：有 `edit` → `global`；否则有 `delete` → `session`。**不要**用版本号；宿主可能回移/改名服务。

旧宿主上的行为是**有意降级**：返回 `{skipped:'schedule-api'}`，写一条 `stage:'schedule-api'` 的活动日志，被动注入仍然工作。不要为了“让旧宿主也能排程”去改 `create` 的参数形状——旧 API 的 `list` 必须逐会话调用，混用会把请求发给错误的目标。

### 6.2 首启弹窗不是插件故障

宿主会按本地状态弹「预览版说明」「开始使用」。它们都有全屏 mask，会拦截 Playwright 点击。先按文本点「继续」/关闭，再做断言。把这类环境弹窗误判成插件 bug 会浪费一整轮。

### 6.3 zstd 只解第一帧

`zlib.zstdDecompressSync` 一次性调用只返回第一帧；会话日志是多帧拼接。用 `scanZstdFrames`（`scripts/drive-session.mjs`）逐帧解，否则会得到「21 个事件只看到 1 个」的假象。

### 6.4 客户端启动图是组合 URL

页面里的 `plugins/??pkg/client.js,@…&rev=…` 是组合请求；单个包的直链 404 不代表没加载。看 `window.__DSH_BOOT__` 或启动图 JSON。

### 6.5 profile patch 的层级

`- id/config` 整份替换；`agent-default-model` 的 `provider`/`model` 在 `config` 下，不在条目顶层。写错层级不会报错，只会继续用默认 provider（然后 `MISSING_CREDENTIAL`）。

### 6.6 临时 npm 安装的代价

`@deepseek-ai/dsh` 的可选依赖会拖入 AWS SDK；`--omit=optional` 也未必完全跳过。用 launcher 已装版本，省时且与用户一致。

### 6.7 能力探测优先于版本判断

本插件已有的例子：`scheduleFlavor()`、`sessionQuery.observeSession` 存在性、`betterSidebar` 存在性、`sidebarRight.mounted` / `uiSession.adapter.current` 的逐级回退。新差异优先补一条这样的探测，而不是引入 `semver`。

---

## 7. 版本记录

**已迁出**：逐构建的核对台账、逐宿主面的形状矩阵、破坏性变更账本统一写在
`docs/host-versions.md` §13.1–§13.3，本文件不再保存副本（原表断在 `0.2.2-rc.1`，而 §2 的
「核对结果」列又把 `connection.requestRejection` 说成「未变」——同一事实两处新旧不一，正是迁移的原因）。
本文只负责**怎么核对**：流程在 §3，真机搭法在 §4，陷阱在 §6。

---

## 8. 维护本文件

本文件讲流程，事实进 `docs/host-versions.md`。每适配一个新宿主：

1. 在 `docs/host-versions.md` §13.1 加一行（commit 取自 tag，核对方式据实填），并按 §13.7 的规则
   决定是否要动 §13.2/§13.3。`npm run check` 的 Gate 4 会拦住漏行、漏证据等级和失效的探测点引用。
2. 若新增了宿主能力探测，补一条单测（例如 `tests/salient-wake.test.mjs` 的 `scheduleFlavor`），
   并在 §13.2 注册这个面。
3. 若发现新的装载门或客户端契约，补进本文 §2 / §3 的清单，事实本身写进 §13.2。
4. 若某个旧结论被证明是错的，直接改 `docs/host-versions.md` 的正文并在 CHANGELOG 里说明，
   不要留两套说法——**也不要在这份流程文档里另抄一份结论**。
