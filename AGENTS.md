# AGENTS.md — dsh-memu-memory

给**改这个仓库的人和 agent** 的操作手册。它只回答三个问题：出问题去哪儿看、改某个行为要动哪些文件、加个东西从哪儿下手。

不回答的问题在别处：这个插件能做什么、有什么限制 → `README.md`；踩过什么坑、怎么改这个仓库 → 本文件（§3 排错索引 + 各节操作路径）。

仓库事实：纯 JS、ESM、**无构建步骤**；源码与测试**全 CRLF**；测试全量 + 验收 50 条（全部由脚本核对）；版本 1.0.0；MIT。

2026-10-28 更新：项目包名为 `dsh-memu-memory`，仓库目录仍由用户手动改名。旧 `/dsh-memu` 路由兼容正式前缀；已有旧数据目录在没有新 state.json 时原地使用，不自动搬迁。WebUI 的 MemU 记忆墙与九页设置为同一个 SettingsPage，仅一个入口；图标用 `assets`。旧“整理失败也标记已睡”的口径作废，失败必须退避重试。关系见 `lib/graph.js`，图片见 `lib/media.js`，身份/世界线边界见 `lib/context.js`，托管运行时见 `lib/managed-runtime.js`。

---

## 0. 三条路

| 你要做的 | 从哪开始 |
|---|---|
| 现象不对、有报错 | **§3 排错索引**，按症状查；每条都给了「先确认什么」 |
| 改现有行为 | **§4 改动流程**：四步 + 每类改动的连带清单 |
| 加工具 / 字段 / RPC / 页面 / 提示词 / 偏置 | **§5 扩展点**，每条有要碰的文件清单 |
| 忘了宿主 API 长什么样 | **§6 宿主事实**（含三种 exec 形状表，踩过两次的坑） |
| 动 UI | **§7 客户端约定**，是硬约束，别绕过 |
| 改提示词正文 | **§8 记忆与提示词口径** |
| 命令忘了、跑不起来 | **§9 环境与命令**（含 Windows 坑） |
| 提交前 | **§10 检查清单** |

---

## 1. 硬规则（不放宽）

1. **不改 DSH 源码。** 只用插件、公开 service、RPC、slot。
2. **只使用公开扩展点。** 工具、注入、会话读取、子代理、UI 都走公开面。
3. **不让主 agent 写全局记忆。** 全局只由 curator 写，主 agent 只读。
4. **不把动态记忆写进 system prompt。** 静态 guide 可以；动态内容走独立 plugin 消息（保护 KV cache，也让注入可折叠）。
5. **不每步注入。** 普通回合首步注入；长工具回合只有出现尚未处理的真实人类消息批次时，才在下一步额外注入一次。不得把工具日志/心跳猜成人类消息。
6. **不自动删除记忆。** 永久记忆移出 = 边缘化；库删除必须显式确认；删会话默认只解绑。
7. **不把 Python 装进系统解释器 / 用户 site-packages。** 只装 `engine/<version>/venv`。
8. **venv 里不留 pip。** 用 `python -m venv --without-pip` 建，再用基础 Python 的 `pip --python` 指进去安装。
9. **不自动追最新 MemU。** 只装插件声明的版本；升级走新 venv + smoke + 切换 + 保留旧版。
10. **不碰共享 `/api` 通道。** RPC 只走 `/dsh-memu-memory` 前缀（`webServer.register` + `connection.requestRejection`）。
11. **日志与提示词里不放 API key。**
12. **注入失败 fail-open，但必须留可观测信号。**
    - 规则：注入路径抛错不许改变宿主的 turn 错误语义，吞掉是允许的。
    - 代价：fail-open 会把真实 bug 一起吞掉。曾经 `inject.js` 把 pre-step 的 `agent` 直接当 `exec` 传给 `buildRecall`（正确形状是 `{ agent }`，见 §6.3），`privateRecall` 抛出的 `no bound session` 被空 catch 吃掉——**每回合召回一直静默失效，只有锚点在注入**，日志里一个字都没有。
    - 所以 fail-open 必须配信号：`logger.warn` + binding 上的 `lastRecallError`（侧边栏可见）；单测要断言**召回到的 id**，不能只断言「消息插进去了」。**不能靠「没报错就是好了」。**

---

## 2. 五分钟认路

### 2.1 模块地图

| 文件 | 职责 | 什么时候碰它 |
|---|---|---|
| `lib/index.js` | 宿主入口：`apply()`、注册工具/RPC/slot、打激活日志、装引擎 | 加新钩子、改启动顺序 |
| `lib/inject.js` | 静态 guide + `agent/pre-step` 注入、锚点/回合检索门、类人偏置的应用 | 改注入内容、改召回策略 |
| `lib/inbound.js` | 通用外部人类消息批次协议、排队去重与长工具回合逻辑时钟；公开 `./integration` | 适配接收类工具，不依赖具体 waiting 插件 |
| `lib/memory.js` | 分层、`decayStrength`、`recallScore`、边缘化、领域过滤、`privateRemember/Recall/Update` | 改记忆语义（最需要小心的地方） |
| `lib/stats.js` | 私有库的旁路计数（`written/injected/recalled/archived`，90 天滚动）与统计页聚合；读失败只降级页面，不碰记忆 | 改统计口径、加计数 |
| `lib/state.js` | `state.json` 与 `index/*.json` 原子读写、合并写、`memoryRevision`/`memoryStamp`、心跳与写事件观测（`syncActivity`）、设置默认值 | 改持久化、加设置项、排查同步 |
| `lib/paths.js` | 读失败隔离：`readJsonStrict`、`*.corrupt-*` 副本、写屏障 | 改文件 IO 口径 |
| `lib/tools.js` | 10 个 `defineTool` 工具面、工具输出格式化 | 加/改工具 |
| `lib/private.js` | 私有记忆整理：当前对话、历史 fork、notice 消息 | 改整理触发与文案 |
| `lib/curator.js` | 全局 curator 子代理、矛盾挂起 `pending_review` | 改全局提炼 |
| `lib/cycle.js` | 空闲整理 pass：过期、降级、晋升、自动整理 | 改后台作业 |
| `lib/mood.js` | 情绪价、峰值、`BASE_AROUSAL` 与半衰 | 改情绪偏置 |
| `lib/budget.js` | token 预算换算（中文 ≈1 字符/token，英文 ≈3.4） | 任何涉及 token 的地方 |
| `lib/snippet.js` | 注入片段裁剪、命中点居中摘要 | 改注入正文形状 |
| `lib/rpc.js` | `/dsh-memu-memory` 的 72 个方法，旧路由别名仍同一鉴权 | 加/改 RPC |
| `lib/client.js` | 客户端入口：九页总设置（含记忆墙）+ 侧边栏 `MemoryTab` + 新会话弹窗 + 共用 `useMemoryBeat` | 改所有 UI、改同步 |
| `lib/webui.js` + `lib/webui/standalone.js` | 独立壳挂载原 SettingsPage，不复制设置实现；同源受鉴权 React/图标资源 | 改挂载与资源 |
| `lib/graph.js` / `lib/context.js` | 关系边、实体、关系状态；说话人、频道、角色、世界线与知情边界 | 改关系或隔离 |
| `lib/media.js` | 宿主附件采集、去重、配额、缩略图、受保护路由、GC 与流式 ZIP | 改图片 |
| `lib/prompts.js` + `lib/prompts/` | 提示词加载/覆盖/恢复/domain 变体解析 | 改提示词机制 |
| `lib/engine.js` | Python 引擎安装、探测、切换、回滚、prune | 改装机逻辑 |
| `lib/memu.js` | MemU CLI 适配层（**所有 CLI 字符串只在这里**） | 改 api 后端 |
| `lib/memu-config.js` | `~/.memu/config.env` 的 embedding 配置 | 改 embedding 设置 |
| `lib/remote-summary.js` | 远程摘要 | — |

### 2.2 一次注入的调用链

```text
agent/pre-step (source.kind=user, decision=enter, 每回合第一步)
  └ inject.js injectForStep({ agent })
      ├ ensureSession / clamp（文件夹上限 && 对话开关）
      ├ 首轮或压缩后 → 锚点块（pin 40% / core 30% / global 30%，budget.js 换算）
      ├ 之后每回合 → buildRecall（privateRecall + globalRecall，MMR λ=0.72，injectedIds 去重）
      └ 可能 cue（随机侧事件，反环规则见 private.js）
  └ createUserMessage({ content, source: { kind: plugin:dsh-memu-memory, form: recall } })
      宿主自己把它渲染成可折叠的「上下文注入」行，插件不做折叠
```

长工具回合另有入口：`tool/result.meta.memoryInbound` / 白名单完整协议 / `./integration`
→ `lib/inbound.js` 有界队列 → 下一次 enter 的 pre-step（允许 step>1）→ 按逻辑消息批次召回。
不解析任意日志；协议见中英文 README 的外部消息节；回归为 `tests/inbound.test.mjs`。

三点容易记反的：**注入是新增一条消息、不改用户消息**；**折叠是宿主做的**；**召回为空必须留信号**。

### 2.3 数据布局与三条写入铁律

```text
~/.dsh/dsh-memu-memory/
├─ state.json              设置 + 文件夹策略 + 会话绑定（记账字段可合并写）
├─ index/<libId>.json      私有记忆全文（唯一真相源，同步落盘）
├─ index/global.json       全局记忆
├─ engine/<version>/venv
├─ engine/current.json     + history.json
├─ libraries/<libId>.sqlite3  仅 api 后端的向量层（加速，不是真相）
├─ prompts/                用户覆盖 + manifest.json（变体命名 <name>.<domain>.md）
├─ downloads/ logs/ backups/
```

**铁律一：读失败不得当成空数据。** `readJson` 的空 catch 会把 JSON 语法错、`EBUSY`（Windows 杀软/索引服务持句柄）、`EMFILE` 全吞成 null；于是 `loadPrivateIndex` 给出 `{entries:{}}`，紧接着一次 load→mutate→save 就把整库**原子地覆盖成空的**，日志里一行错误都没有。规则：读失败把原文件改名 `*.corrupt-<ts>` 保住，**拒绝后续写入**（抛错让调用方 fail-open），并暴露可见告警。`ENOENT` 不算读失败（首启、新库是正常的「还没有」）。

**铁律二：索引写入按 `libraryId` 串行化。** curator 子代理、种子 fork、主 agent 会并发对同一个 `index/*.json` 做 load→await→mutate→save，`await` 边界上后写者覆盖前写者，丢的是记忆本身。

**铁律三：`state.json` 可合并写，`index/*.json` 永远同步。** 崩一次丢 50ms 的「上次注入到哪了」没关系，丢一条记忆不行。

**两层作用域：文件夹是上限，不是初值。**

```text
文件夹 workspacePolicies[scopeKey] = { useLibrary, useGlobal }   ← 上限
对话   sessions[sessionId]         = { useLibrary, useGlobal }   ← 各自的选择
生效值 = 文件夹 && 对话
```

- **clamp 必须落在四处**，漏一处等于没有：`ensureSession`（绑定）、`setSessionScope`（改写）、注入准入（`inject.js`）、记忆读写（`privateRemember` / `privateRecall` / `globalRecall`）。
- `setWorkspacePolicy` **不改写**已有 binding 的开关值（只在打开时补齐缺失的 `libraryId`）：关掉靠 clamp 立刻生效，重开恢复每个对话自己的选择。
- 文件夹两个开关都关 → 新对话**不弹窗、不建库、不注入**，侧边栏显示「没有启用文件夹记忆」。
- 纯读路径用 `peekBinding` / `getSessionBinding`，**不要**用 `bindingFor` / `ensureSession`——后者会顺手建库。
---

## 3. 排错索引

先按症状查表，再进小节。**每条都先说「怎么确认」**——没有确认就改代码，是在猜。

| 症状 | 先确认什么 | 常见原因 | 详节 |
|---|---|---|---|
| 记忆从不出现，只有锚点 | 单测里断言过召回 id 吗？`lastRecallError` 有值吗 | exec 形状错（传了 `agent` 而不是 `{ agent }`），错被 fail-open 吞掉 | §3.1 |
| 打开会话就报 `format v4 message requires a producer-owned source kind` | 是谁写的 `source` | 历史行里是 v3 的裸 `kind:plugin` | §3.2 |
| 整个库忽然空了 | 索引目录里有 `*.corrupt-*` 吗 | 读失败被当成空数据，然后被覆盖写 | §3.3 |
| 明明写了却少一条 | 有并发写同一个库吗（整理作业 + 主 agent） | 索引没串行化，后写覆盖前写 | §3.4 |
| 侧边栏要手点刷新才更新 | 指纹 stamp 变了吗 | 只比进程内计数器 | §3.5 |
| 设置页错位 / 按钮挤成竖排 / 悬停提示没了 | 有没有内联 `S.*`、`Button` 有没有透传 `title` | 违规新增样式或漏 prop | §3.6 |
| 提示词改了不生效 / 整个会话打不开 | `loadPrompt` 报错了吗、`package.json` 的 files 白名单覆盖了吗 | section 没包 try/catch、变体文件没随包 | §3.7 |
| 引擎装不上 / 切换后检索变差 | 镜像、venv 里的 pip、真实库 smoke 跑过吗 | 装进系统 Python、空库自检代替真库验证 | §3.8 |
| 待复核的记忆既注入了又召回了 | 条目 `status` 是什么 | `pending_review` 没被过滤 | §3.9 |
| 改了源码但应用行为没变 | profile 里的 node_modules 是符号链接还是拷贝 | 是拷贝 → 改的不是在跑的那份 | §3.10 |

### 3.1 召回静默失效（最常见的「没反应」）

**确认顺序**：① 单测是否断言了召回条目的 id（不是「消息插进去了」）；② binding 上的 `lastRecallError`；③ `logger.warn` 有没有输出；④ 手工在 REPL 里用 `{ agent }` 调一次 `privateRecall`。

**根因通常是三种之一**：exec 形状错（见 §6.3 三形状表）；`injectedIds` 记了没真正进入文本的条目（见 §8）；token 预算把结果截空。

**修法不是加日志就完**：fail-open 的 catch 里必须留 `lastRecallError`，并让侧边栏能看见。

### 3.2 会话打不开：v4 要求 producer-owned source kind

**报错原文**：`format v4 message requires a producer-owned source kind`（`SessionFormatError`，dsh core 的 session-format 模块）。

**触发点**：`assertReleasedV4Relationships()` 在**读取/扫描 v4 会话 artifact** 时逐条校验消息的 `source`。满足任一即抛：`source` 不是 JSON 对象；`kind` 缺失/非字符串/空串；`kind === plugin`（v3 裸包装，v4 已作废）。**症状是会话打不开，不是某次调用失败。**

**正确写法**：用 `plugin:<插件名>`，并删掉 `plugin` 字段。

```js
// ❌ v3，v4 拒收
{ kind: "plugin", plugin: "dsh-memu-memory", form: "recall" }
// ✅ v4
{ kind: "plugin:dsh-memu-memory", form: "recall" }
```

**本插件只有两个产出点**，改 source 时一起改：`lib/inject.js`（`form: recall`）、`lib/private.js`（`form: notice` + `summary`）。全仓无第三处 `createUserMessage`。

**为什么是 `plugin:<名>`**：dsh core 的 v3→v4 迁移 `producerKind()` 对未知插件正是派生 `plugin:<name>`（另有重命名表 `compact→compact-checkpoint`、`tools-ptc`/`tools-code-mode→ptc-mode`、`dsh-compaction-basic→compact-basic`、`@deepseek-ai/dsh-system-prompt→runtime-context`，以及同名白名单 `user-approval`/`team-message`/`schedule`/`skill-invocation`）。用同一形态，历史行和今后新行能统一读回。

**最容易踩的坑**：

- **迁移只处理 v3 行。** 已经落盘的 v4 会话里若有 `kind:plugin` 行，改代码也救不回来——那类会话要改数据或让用户重开线程。插件只能诊断（`diagnoseSession`），不解析私有的 `session.v4.jsonl.zstd`。
- **不要改成 `kind:user` 绕过校验。** 会被当真实用户消息，破坏注入路径里 `source.kind === user` 的判定，也污染历史语义。同理不要自造宿主已占用的 kind。
- **`source` 是持久化的**：落盘就是会话格式的一部分。改完要拿旧会话回读（`sessionQuery.readSession()` 能读回才算过）。
- TS 插件需要往 `MessageSourceMap` 做 declaration merging；本插件纯 JS，运行时只校验「非空字符串且不等于 `plugin`」。

**守卫**：`tests/source-kind.test.mjs` 静态扫描 `lib/**/*.js`，断言无裸 `kind:plugin`、无 `plugin:` 字段、每个 `form` 在 `KNOWN_FORMS` 内、`form: notice` 必带 `summary`。加新消息点它会替你把关。

### 3.3 记忆被清空（读失败当空数据）

见 §2.3 铁律一。**确认**：索引目录里是否出现 `*.corrupt-<ts>`；`paths.readFailure(file)` 返回的 `kind`（`io` / `corrupt`）。

**注意区分**：只有 `kind: corrupt` 才会被 `quarantine()` 搬走；`kind: io`（如 Windows 上把文件换成同名目录会得到 `EISDIR`）不搬，但同样**拒绝写入**并抛 `dsh-memu-memory/read-failed`。`scripts/acceptance-local.mjs` 的 A-3 就是用 EISDIR 造这个场景的。

### 3.4 记忆神秘消失 / 后写覆盖

**确认**：是不是发生在整理作业、curator、或第二个窗口同时写同一个库的时候。**根因**：load→await→mutate→save 的 await 边界。**修法**：按 `libraryId` 串行化（§2.3 铁律二）。

> 已经发生过一次「条目凭空消失、无法归因」的事故（库 25→23，最后靠会话记录逐字恢复）。当时排除了三种解释：`resolveEntryId` 不支持模糊匹配、`privateDelete` 只删指定 id、`state.js` 没有任何修剪逻辑。**这正好说明「数据消失」类问题必须先有并发写串行化和写后校验，否则只能猜。**

### 3.5 侧边栏 / 设置页不自动刷新

**确认**：`getSidebarState({ revisionOnly: true })` 返回什么。它现在回 `{ revision, stamp }` 两半：`revision` 是进程内计数器（`memoryRevision()`），`stamp` 是磁盘指纹（`memoryStamp()`，`state.json` + `index/*.json` 的 `label:size:mtime`）。三端比 `${revision}|${stamp}`，任一半变就重拉，外加 `visibilitychange` 回场补刷。

**三端同一套心跳**：侧边栏、宿主设置、独立 WebUI 都用 `useMemoryBeat({ call, markerRef, onBeat })`。心跳**不需要 sessionId**，完整侧栏首屏仍必须带会话；首份 marker 从实际响应播种，刷新失败不采纳，下一拍重试。

**只比计数器会漏**：写入若发生在另一个 module 实例/进程（工具调用、整理作业、另一窗口），RPC 侧计数器不动，心跳永远认为「没变」。**这就是「每次都要手点刷新」的根因。**

**独立页的采纳顺序**：`reloadCurrent()` 先取 marker、**渲染成功后才采纳**。反过来（先渲染后取 marker）会让 marker 比屏幕新，藏住渲染期间的写入；渲染失败就采纳则会让下一次心跳不再重试。

**诚实边界**：2.5 秒上限；面板隐藏时不轮询；指纹只覆盖索引与 state 的体积和 mtime，不覆盖正文；同一毫秒内同尺寸的两次写可能漏一次（下一次写补上）。`memu_status` 的 `sync:` 行是排查入口——`heartbeat never` 说明根本没有面板在轮询，`last write` 太久远说明是没人写。

### 3.6 UI 错位 / 样式异常

对照 §7 的硬约定。三个最常见：内联 `S.*` 样式复活；`Button` 漏传 `title`；把「多种选一个」写成第二套分段控件。另外**长文本挤按钮**是 flex 缺 `minWidth:0`，**勾选框跑到别人文字旁边**是复用了带 `minWidth:132` 的 `Field` 标签列——这类结构问题优先换组件（用 `CheckRow`），不要靠调 margin。

### 3.7 提示词不生效 / 会话崩

**确认**：`loadPrompt(key, vars)` 抛错了吗（两个 throw：key 不认识、`missing default prompt`）；`~/.dsh/dsh-memu-memory/prompts/manifest.json` 里有没有用户覆盖挡住默认稿；渲染结果里是否残留 `{{变量}}`（未知变量会原样保留）。

**必须记住**：section 的 `text(context)` 抛错会炸掉**整个 prompt 装配**，不只是记忆功能——`package.json` 的 `files` 白名单漏一个变体文件就够触发。所以 section 必须整体 try/catch，回落顺序 `.rp`/`.coding` → `general` → 一句降级文案。

### 3.8 引擎装不上 / 切换后检索变差

**装不上**：按 §9.1 的 Python 顺序与镜像顺序排查；确认没装进系统 Python、venv 里没有 pip、`downloads/` 失败后被清。

**切换后变差**：`verifyEngine` 用的是 `os.tmpdir()` 里的**空库**，一个打不开真实 DB 的版本也能过它。所以**切换前必须对真实库做只读 smoke**（`list-files --json --db <real>`），并且**切换前先备份**（含 `state.json` + `index/*.json`，不是只有 sqlite）。在备份存在之前，**不跑任何可能触发 alembic 迁移的命令**——只读探测只用 `list-files` / `retrieve`。

### 3.9 pending_review 泄漏

矛盾挂起的条目（`status: pending_review`）**不许进注入、不许进召回**，只许出现在复核队列（`listReviews` / `resolveReview`）。这类泄漏曾真实发生过（在锚点与召回里同时出现），修完后由 `tests/audit-regression.test.mjs` 守着。写新查询路径时，凡是「列出可用条目」的地方都要带上状态过滤。

### 3.10 改了源码应用却没变

**先确认部署，不要先怀疑代码**：`~/.dsh/profiles/<profile>/node_modules/dsh-memu-memory` 是不是**符号链接**指向仓库（`lstat` 看）。是符号链接 → 改源码即刻生效，没有 bundle 缓存；是拷贝 → 你改的不是在跑的那份。`package.json` 的 `exports` 里 `./client → ./lib/client.js`、`main → ./lib/index.js`、`dsh.client.platform: web`。

宿主**默认不落盘插件运行日志**（`~/.dsh/logs/` 只有启动诊断，`~/.dsh/dsh-memu-memory/logs/` 只有 `install.log`）。要验证激活那行，跑一个假 ctx 调 `apply()` 断言输出的字符串，别去翻日志——`tests/activation.test.mjs` 就是这么做的。
### 3.11 整理提示冒出在输入框上方

**症状**：待发区里出现一句「整理这场对话的私有记忆」，可编辑、可删，跑完还留下，之后每一轮都重发。

**根因**：宿主**没有静默入队**——`followup` / `steer` / `inject` 三个 API 都会把消息画进待发区（`followup` 还是「下一轮」，因此会一直重发）。界面上天然不可见的路径只有 origin 为 subagent 的 fork 子会话。

**口径（v0.4 已生效）**：`lib/private.js` 的 `requestPrivateConsolidation()` 在 agent 后端一律走 `requestHistoricalConsolidation()`——同一份 transcript 做种子 → fork → 跑完 dispose；`lib/cycle.js` 的睡眠整理也走这一条；api 后端仍走远端调用。**不要为了省一次 fork 就退回 followup**：省下的是几 KB 种子复制，赔上的是用户会话里永久多出的一轮。用例见 `tests/consolidation-fork.test.mjs`（断言 liveFollowups 为 0）。

---

## 4. 改动流程（修改现有行为）

### 4.1 四步

1. **定位链路**：先用 §2.2 那条链找到「这个行为是在哪一步决定的」，再读那个函数。不要从 UI 往下猜。
2. **最小改动**：一次只改一个语义。改 schema、改文案、改 UI 不要混在一个提交里——出问题时无法二分。
3. **三层验证**（见 §4.2）：语法 → 针对性单测 → 全量 + 验收 + 自检。**只跑自己新写的测试是不够的**，这个仓库的多数回归是被别的文件抓到的。
4. **同步文档**：按 §4.4 的表改对应段落。文档与代码不一致本身就是一个缺陷（这次清理就是因为积累了太多）。

### 4.2 验证三件套

```bash
node --check lib/<改过的文件>.js          # 语法（源码是 ESM，别用 require 试）
npm test                                  # 全量测试；真实引擎用例默认跳过（本轮已单独跑过）
node scripts/acceptance-local.mjs         # 50/50，视觉证据只证明本次已审查，未来 UI 改动仍须重新看图
npm run check                             # 每个 .js 的 node --check + i18n 键对齐 + package.json 可解析
```

**读测试结果的口径**：`node --test` 输出的 `ℹ tests / pass / fail / skipped` 才是权威。用例数变了先问「是不是我加的」，失败先问「是不是并发写了同一个库」——这个仓库真的有多个会话同时改它的时候。

### 4.3 每类改动的连带清单

| 改什么 | 必须一起看 | 覆盖它的测试 |
|---|---|---|
| 注入内容/顺序 | `budget.js` 换算、`injectedIds` 只在真正进文本后记、fail-open 信号 | `inject.test.mjs`、`snippet.test.mjs`、`appendix-b*.test.mjs` |
| 记忆字段或语义 | `checkEnums`、`privateRemember` 默认值、`decayStrength`/`recallScore`、迁移对旧条的处理 | `memory`/`humanlike`/`appendix-b*.test.mjs` |
| 工具入参/输出 | `tools.js` schema 描述（模型看的是它）、`formatPrivateItem` 截断、工具错误码 | `tools.test.mjs` |
| RPC 方法 | `lib/rpc.js` case、客户端 `call()`（验收 G-2 会核对每个调用都有 case） | `storage`/`browser`/`sidebar*.test.mjs` |
| UI 任何东西 | §7 全部约定、zh/en 两个字典、`renderXxxItem` 拆分 | `client-render.test.mjs`、`webui.test.mjs`、`new-session-gate.test.mjs` |
| 提示词正文 | 每个类型页的变体是否都要改、`{{变量}}` 是否都在 vars 里、`files` 白名单 | `prompts.test.mjs` |
| 引擎/安装 | Python 顺序、镜像顺序、prune 白名单、备份内容、切换回滚 | `engine.test.mjs`、`backup.test.mjs` |
| 设置项 | `DEFAULT_SETTINGS`、设置页控件、WebUI `settingRow`、反面语义要 `invert`、`memoryStamp` 是否覆盖 | `state`/`config`/`sidebar-beat.test.mjs` |
| 统计计数 | `stats.js` 的 `bumpStats` 调用点（只有语义动作能加）、90 天裁剪、页面零值与降级、`getStats` 不建库 | `stats.test.mjs`、`client-render.test.mjs` |

### 4.4 文档同步规则

| 改动类别 | 要更新的文档 |
|---|---|
| 任何行为变化 | `README.md` 的能力/限制段（写「谁受益」而不是「改了哪个函数」）；踩过的坑补进本文件 §3 |
| 设计决策 / 取舍 | `README.md` 的限制段 + 本文件 §8 的记忆/提示词口径（**只写为什么，不写施工流水**） |
| 影响验收方式 | 能自动化的进 `scripts/acceptance-local.mjs`，行为级的进 `tests/`；两者都进不了说明这条还没想清楚 |
| 新增能力 / 数据结构 | `README.md` 的能力表；可自动化的行为进 `tests/` 或验收脚本 |
| 排错经验 / 新坑 | 本文件 §3（加一行症状，或一节） |
| 用户可见能力变化 | `README.md`（能力表、限制段） |

---

## 5. 扩展点（新增功能）

每一条都按「文件顺序」写，照抄即可。**加完记得跑 §4.2。**

### 5.1 新增一个模型工具

1. `lib/tools.js`：`defineTool({ name, description, inputSchema, execute(args, exec) })`，`execute` 里用 `exec.agent.session.header.id` 取会话（§6.3）。
2. **描述是给模型看的契约**：写清楚默认值、拒绝条件、返回形状。模型读不到代码，只读你这段字。
3. 权限：主 agent **不注册**全局写入类工具（§1.3）。
4. `lib/index.js` 注册；`README.md` 的模型工具表加一行。
5. 测试：`tests/tools.test.mjs` 加一条「正确入参成功 / 错误入参给出可读错误」。

### 5.2 新增一个记忆字段（最贵的一类，先想清楚）

1. **写入侧**：`lib/memory.js` 的 `privateRemember` 里给默认值——**默认值就是语义**。曾经 `source` 默认 `user_said`，等于把模型的全部推断系统性抬成「用户说的引语」；改成 `inferred` 才是诚实的。
2. **校验**：字段是封闭枚举就进 `checkEnums`（拼错会静默失去语义，比抛错危险得多）。
3. **更新侧**：`privateUpdate` 的允许字段表 + `lib/rpc.js` `updateMemory` 的 `allowed` 一起加，否则 UI 改不了。
4. **读取侧**：`inject.js` 的 `formatPrivate` / `formatGlobal` 要不要用它；`decayStrength`/`recallScore` 要不要乘进去。
5. **旧数据**：字段缺失要当成「默认值」而不是「假」。**不做历史回填**——回填等于替过去的话改口供（`source` 就是这么决策的）。
6. **UI**：要不要显示（一个 `Tag` 就够）、要不要可编辑（编辑表单 + i18n 两个字典）。
7. 测试：默认值、非法值、旧数据缺字段、序列化往返。

### 5.3 新增一个 RPC 方法

1. `lib/rpc.js` 的 `switch` 加 case（共 72 个方法，按功能分组，别乱插）。
2. 返回**形状要稳定**：客户端 `call()` 直接解构。列表类方法给 `{items, total}` 而不是裸数组。
3. 注意 `revisionOnly` 分支只回 `{revision, stamp}`、**不要求 sessionId**（三端都在轮询它，设置页与独立页没有会话），**别往里塞业务数据**——它每 2.5 秒跑一次。顺带记一个心跳（`noteMemoryBeat()`），`memu_status` 靠它分清「没写」与「没人轮询」。
4. 写操作成功后要 `bumpMemoryRevision()` / `notifyMemoryWrite()`（§7）；能让 `state.json` 或索引落盘的写，`state.js` 会自动记一条写事件供 `memu_status` 展示。
5. 客户端 `call()` 是它唯一的调用方，加完跑 `tests/browser.test.mjs`；验收 G-2 会把每个 `call()` 名字和 case 对一遍。

### 5.4 新增一个设置项 / 一个设置页

1. `lib/state.js` 的 `DEFAULT_SETTINGS` 加键（**这是唯一权威**，文档示例都以它为准）。
2. `setSettings` 白名单 + 类型校验；需要 clamp 的在这里 clamp。
3. 设置页：`lib/client.js` 的 `pageDefs`/`pageBlocks` 与 `PAGE` 映射三处必须一致；每页拆 `xxxBlock` + `renderXxxItem`。
4. 文案：`zh` / `en` 两个字典都加，然后 `node scripts/check-i18n.mjs`。
5. 反面语义（名字是「已关闭」这种）→ WebUI 里必须 `settingRow(..., { invert: true })`。
6. 独立页设置（`lib/webui/`）要不要同步显示？要的话走 `BroadcastChannel` 的 `memory-write` 消息，并让 WebUI 的 `settingRow` 读同一份 `getSettingsState`。
7. **新增整页**时：`PAGE` 加键 → `pageDefs` 加项 → `pageBlocks` 加块 → 导航图标 → 两处文案 → 渲染探针（`tests/client-render.test.mjs` 会逐个渲染每页）。

### 5.5 新增一个提示词变体 / 类型页

1. 变体命名 `<name>.<domain>.md`，与基础稿同目录（`lib/prompts/`）。**只有三个 key 支持分域**：`system-guide`、`private-policy`、`private-consolidation`；`global-curator` 不分域（curator 的职责就是跨域整理）。
2. `package.json` 的 `files` 白名单必须覆盖 `lib/prompts/*.md`，否则随包缺失 → `missing default prompt` → 会话崩（§3.7）。
3. `{{变量}}` 必须在调用处传进去；新增变量名要同时改 `loadPromptForDomain` 的 vars（漏了就会原样漏进提示词——`{{anchorTokens}}` 踩过一次）。
4. 类型页是**数据**：`settings.promptDomains`，id 限制 `[a-z0-9][a-z0-9_-]{0,23}`，`general` 是内置页不能删。新增页不要预建文件。
5. `manifest.json` 的键是解析后的键（如 `system-guide.rp`）；改 `syncPromptDefaults` 时必须**先合并旧键**，否则清空用户覆盖记录。
6. 文案标准：一个鲜明特征 + 5~6 条具体可执行的行为指令 + 一条安全底线；禁止「更像角色一点」这类无法落地的描述；**安全底线不为风格让路**。

### 5.6 新增一个仿人偏置

先决定它挂哪儿，三选一：

| 挂点 | 作用 | 频率 | 代价 |
|---|---|---|---|
| `decayStrength`（`lib/memory.js`） | 改「这条还有多强」 | 每次读强度 | 影响一切下游，最容易过冲 |
| `recallScore`（`lib/memory.js`） | 改「这次谁排前面」 | 每次召回 | 只能重排，不能创造命中 |
| 注入渲染（`lib/inject.js` / `snippet.js`） | 改「长什么样」 | 每次注入 | 只影响观感，最安全 |

纪律：**乘性因子要限定在近似 1 的窄区间**（现有偏置多在 0.84–1.16），否则会压过语义命中，让「检索」变成「随机浮现」。写测试时给一个「语义明显更强时仍应胜出」的用例。

还要问一句：**它和已有偏置共线吗？** 唤醒同调与情绪价偏置共线，所以实际只做到 ±16%——这种事要在注释里写清，别让下一个人以为它该更强。
---

## 6. 宿主事实与 API 速查（2026-10-27 实测，DSH 0.2.1-rc.3）

### 6.1 DSH 没有 embedding 能力

`ctx.llm`（`LlmRuntime`）只有 `stream` / providers / model discovery，**没有 `embed`**；全 store 的 `@deepseek-ai` 类型与实现里 `embeddings` / `/v1/embeddings` / `createEmbedding` 命中数为 0；DeepSeek provider 目录只有 chat 模型；`dsh-api-gateway` 是 Typert RPC 复用（就是不许碰的 `/api`），不是 OpenAI 兼容 REST。

- 所以「本地 embedding」**不可能由 DSH 承担**。MemU 自身也只有 doubao/jina/openai/openrouter/voyage 五个远端后端，没有 torch/onnx/sentence-transformers/ollama 依赖。
- 本地化的唯一真实形态是「指向本机跑的 OpenAI 兼容 embedding 服务」（自起的 ollama / text-embeddings-inference），MemU 会回落到 OpenAI 兼容 `/embeddings`，`api_key` 可为空。插件只能预填 baseURL + 空 key，**不能声称离线可用**。
- 宿主凭据 `ctx.credentials.resolve("DEEPSEEK_API_KEY")` 存在但对 embedding 无用。远程模式继续用插件自己的 `~/.memu/config.env`，**不要读宿主 keychain**。

### 6.2 工作区注册表在宿主侧可读

`ctx.workspaceRegistry`：`list()`（同步）/ `get(id)` / `resolveByPath(path)` / `delete(id)` / `realpathNormalize`；`Workspace.path` 是 create 时 `fs.realpath` 规范化的值，与 `normalizeCwd` 同口径；`status()` 返回 `ok | missing-dir`，只查不改。

**关键**：从 DSH 删除工作区**不删任何磁盘数据**（目录和 session log 都在），只是取消注册。所以**记忆库归档必须以 registry 里还在不在为准，绝不能用 `fs.existsSync` 判存在**——文件夹被删 ≠ 从 DSH 移除，反之亦然。

订阅：`ctx.on("domain/changed", ...)`（`dsh-storage-domain`），`change.domain === "workspace"` 时 `deleted` / order-put 就是移除信号。客户端侧服务名 `workspaceController`，命名空间 `workspace`，**没有 remote `list()`**，只有 `follow(signal)`。

### 6.3 取 sessionId 的三种形状（踩过两次，务必对照）

| 场景 | 拿到的对象 | 正确路径 |
|---|---|---|
| 工具 `execute(args, exec)` | `ToolExecution`（`agent?` 在**顶层**） | `exec.agent.session.header.id` |
| `agent/pre-step` 的 payload | `{ agent, messages, turn, step, signal }` | `payload.agent.session.header.id` |
| system prompt section 的 `text(context)` | `AssembleContext`，实际是 `{ agent, scope: agent, signal }` | `context.agent.session.header.id` |

`Agent` 自身**没有** `.agent` 字段。把 pre-step 的 `agent` 直接当 `exec` 传给 `memory.js` → `sessionIdOf` 得 `null` → `privateRecall` 抛 `no bound session` → 被注入路径的空 catch 吞掉 → **每回合召回静默失效**（§3.1）。注入路径必须传 `{ agent }`。

section 的 `text(context)` 能拿到 `context.agent`，所以 system prompt **可以按会话 domain 分层**；但它抛错会炸掉整个 prompt 装配，取值必须整体 try/catch 并回落 `general`。

### 6.4 读历史会话与标题

- `ctx.sessionQuery.listSessions()` / `readSession()` / `observeSession()`。
- `SessionRecord` 只有 `{ header, live, persisted, formatStatus }`，**没有 title**。
- 标题走 `readTitleSnapshots(ids)` → 每项 `{ sessionId, status, value: { session, title? } }`，文本在 `value.title.title`；`status === "rejected"` 的项只有 `reason`。未命名会话没有 title 事件，UI 必须准备短 id 回退。

### 6.5 fork、followup 与「等它跑完」

- 会话 fork：`ctx.sessions.fork(source, boundary?, childSessionId?)`——**source 必须 live**，同步返回 `Session`，不自己启动 agent，没有 parent/delivery。错误码 `SESSION_NOT_FOUND | SESSION_NOT_LIVE | SESSION_ALREADY_EXISTS | INVALID_BOUNDARY`。
- 历史会话整理走**种子重建**：`sessionQuery.readSession(id)` → `{ session, events, inheritedEventCount }` → `buildForkSeed(events, lastSeq)`（`@deepseek-ai/dsh-session`，可选 peer，动态 import）→ `ctx.agents.create({ sessionId, meta: { cwd, parentSession, isSeeded, agentPreset }, seed, signal })` → `{ agent, dispose }`。
- `agent.followup(msg)` 只入队并唤醒 driver，**返回 void**；要等它真跑完只能 `await agent.whenIdle()`。fork 整理必须 `whenIdle` 后再 `dispose`。
- **注意 followup 的语义**：它是「排队等 agent 空闲后当作一轮输入提交」，宿主会把它画在输入框上方（可编辑/可删）。这就是「整理提示出现在待发消息栏」的原因——**所以 v0.4 起所有整理都走 fork（见 §3.11），后台作业一律不碰 followup**。

### 6.6 定时器

宿主有 `ctx.schedule`（`@deepseek-ai/dsh-schedule`：create/list/catalog/history/delete/update，`every_seconds | daily | weekly | cron`，最小 60s），但它**绑定单个 sessionId、往该会话投递 prompt**、需要 sessionPersistence、且拒绝 subagent 会话——**不适合插件级全局清扫**。插件自己的清扫用 `ctx.interval`（cordis 随作用域回收），没有才退回 unref 的 `setInterval`。

事件：`ctx.on("agent/status", { agent, status })`，`AgentStatus = idle | running`；另有 `session/created`、`session/disposed`、`session/flush`；事件类型含 `turn/start|turn/end(step/*、user/message…)` 与 `compaction/*`。**`turn/end` 不 await flush，不要在那里读存储。**

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
- producer label 就是 **kind 原文**（如 `plugin:dsh-memu-memory`），不可自定义。`form: recall` 只有在 `kind: session-reference` + `references[].label` 时才走专门的召回正文；本插件用 `recall` 只是拿一个折叠行。要一行可读的折叠摘要就用 `form: notice` + `source.summary`。

---

## 7. 客户端约定（硬约束）

### 7.1 两个壳、一份实现

设置页 = 左侧导航（158px + 品牌块 + 品牌色滑动指示条）+ 卡片式页面；侧边栏 `MemoryTab` = 顶部分段壳。**同一个 `SettingsPage` 也会嵌进侧边栏**（`embedded` → `data-dshm-surface="sidebar"`），所以「总设置」只有一份实现，**不要另写一套侧边栏设置面板**。

结构契约：`.dshm-root > .dshm-shell > (.dshm-nav + .dshm-page)`；导航含 `.dshm-brand` / `.dshm-nav-ind`（`translateY(page * (38+4))`）/ `.dshm-nav-item`；页面含 `.dshm-head`（`.dshm-overline` + `.dshm-h1` + `.dshm-desc`）。`@container` 在 620px 以下把左导航塌成横向标签。

**`ctx` 是 Cordis 服务代理，不要读自定义属性。** 宿主里的 `ctx.standalone` 会抛 `cannot get property "standalone" without inject`，而且是在 `useState` 初始化时抛，直接把整个设置页渲染成空白（已真实发生过）。独立页的标识必须由 `mountStandalone` 作为 **prop** 传给 `SettingsPage`（`standalone: true`，默认 `false`）；`tests/webui.test.mjs` 会静态拦住 `ctx.standalone` 复发。

### 7.2 颜色

只走**真实存在**的 DSH token：`bg-base`、`bg-layer-1..4`、`border-l1..l4`、`label-primary(-inverted)`、`label-secondary`、`label-error`、`brand-primary`、`brand-text`。写不存在的 token **不会报错**，只会永远落到硬编码兜底色，换主题时特别难看。改色前先确认 token 名。

### 7.3 控件纪律

- **不再新增内联 `S.*` 样式对象**（旧的在逐块删，不留双轨）；所有样式走 `dshm-` 作用域 CSS。
- 「在这几项里选一个」= `.dshm-nav-list` + `.dshm-nav-item`（页内横排加 `is-row`）。**不要写第二套分段/下划线样式**。
- 动作按钮 = `Button`（`.dshm-btn`，**必须透传 `title`**，漏掉整个界面的悬浮提示静默失效）；开关 = `Toggle`；行内删除/关闭 = `.dshm-x`。
- `<button>` 里**不许**再嵌 `role="button"`（键盘够不到）。
- 破坏性操作 = **二次点击**（文案变「确认…？」，2.5s 复原作者），不用 `globalThis.confirm`、不用 modal。
- 设置项 = 即时保存 + 250ms trailing debounce，一次重试 + `console.warn`，`pagehide` 时 flush。
- 反馈用 toast（2.6s 自动消失），不用常驻的 error/notice 字符串。

### 7.4 数据与刷新

- **保存/设置类改动必须通知**：`notifyMemoryWrite(kind, libraryId)` 先跑同窗口监听（毫秒），再向 `BroadcastChannel("dsh-memu-memory")` 广播 `{ type: "memory-write", kind, libraryId, at }`，让另一份文档（WebUI 新标签 / overlay iframe / 另一个宿主窗口）立刻重取。本地已经刷新过的写（设置保存、复位、后端切换、文件夹策略）用 `broadcastMemoryWrite` 只通知别人，避免同一窗口刷两遍。接收端只跑本地监听 / 重渲染，**不再广播回去**，也**不从消息里取数据**——消息只叫醒心跳，事实永远从 RPC 重新取。
- **一切轮询走心跳**：新增面板同步一律用 `useMemoryBeat`，不要各写一套 `setInterval`。心跳载荷**只许** `{ revisionOnly: true }`，返回**只许** `{ revision, stamp }`。
- 侧边栏首屏只允许 **1 个 RPC**（`getSidebarState`），且不得读记忆全文；其余分页懒加载，列表项预览就地截断。
- 筛选是**两个独立维度，各自独占**：池（在用 / 已归档）× 层（全部 / 永久 / 长期 / 短期 / 锚点）。**所有选项恒定列出，没有记忆就显示 0**；不要把归档做成叠加开关。两个池在同一次读取里全部拿到，切换/归档/恢复只改状态重绘。
- 存反面语义的设置项（如 `newSessionPromptDismissed`）在 WebUI 里必须 `settingRow(..., { invert: true })`，否则开关显示与宿主页面相反。

### 7.5 文案与结构

- 所有文案同时进 `zh` / `en` 两个字典；加 `t("key")` 后跑 `node scripts/check-i18n.mjs`。
- 列表里的会话一律 `sessionLabel(s)`，不要铺 `session-…` 全长 id；侧边栏第一层只显示文件夹 **basename**（**不显示完整路径**）。
- 页序 = `pageDefs` = `pageBlocks`，三处必须一致。每页拆 `xxxBlock` + `renderXxxItem`，避免一个 `h(...)` 里堆几十层括号。
- `tests/client-render.test.mjs` 会把 7 个页面和侧边栏各渲染一遍：渲染期抛错或文本里出现 `[object Object]` 都会失败。
- WebUI 打开路径只有一条：`openWebUiPage()`（先新标签，被拦截再用应用内 overlay）。**禁止同标签导航兜底**——那会卸载宿主 SPA，「返回」变成整页刷新。
---

## 8. 记忆与提示词口径

### 8.1 三层

`LAYERS = [long_term, short_term, must_remember]`（`lib/memory.js:33`），三层**都已实现**：

| 层 | 半衰 | 特点 |
|---|---|---|
| `short_term` | 1 天（`SHORT_TERM_HALF_LIFE_DAYS`） | 带到期日（`shortTermTtlHours`，默认 72），过期由 `cycle.js` 处理；可被 `privateUpdate` 晋升为 `long_term`（记 `promotedFrom`） |
| `long_term` | 常规半衰 | 主体 |
| `must_remember` | 365 天 + **0.35 强度地板** | 只来自用户明确要求、随机侧事件、极少数自我判断；软上限 `mustRememberCap` |

> 旧文档写过「short 是设计保留、无实现」——那是 v1 的事实，**现在过期了**。改这块之前先读 `lib/memory.js` 与 `tests/short-term.test.mjs`。

### 8.2 私有记忆的写入规则

- 主 agent 自己写；**不做「你是她的记忆」的二次人格**。
- `must_remember` **满了也不许为了腾名额而 unpin**。
- 移出永久记忆 = **边缘化**：`marginalized=true`、`strength × 0.2`、`recallPenalty + 0.2`，**不删除**；条目仍在库里，`marginalReason` 在侧边栏可见（这是替代人类闸门的**事后**监督）。
- **unpin 由模型自己判断，侧边栏没有标记按钮、用户不参与。** 人类闸门换成三重护栏：① `reason` 必填、第一人称、去空白后 ≥ 20 字符；② 每会话配额 `unpinBudgetPerSession`（默认 2）；③ 冷却 `unpinCooldownMinutes`（默认 3）。放行后记 `unpinnedBy: model`、`unpinnedAt`、`originalPinSource`（保留原 pinSource 以便复 pin）。
- 正当的 unpin 只有两种：想起它本身正在伤人；它已经不再是我的一部分。不正当的：inconvenient、不想面对、用户这轮没提、永久记忆快满了。**这个区别要写在提示词里。**
- 矛盾检测：同库同题改写或说法相反 → 新条挂 `pending_review` + `reviewReason` + `conflictingWith`，**不进注入不进召回**，等 `listReviews` / `resolveReview` 裁决（§3.9）。

### 8.3 全局记忆

- 只有 curator 写，主 agent 只读。
- domain：`universal / coding / rp / project:<name> / tooling / personal`；**RP 与 coding 冲突分域存，不合并**。
- RP 剧情事实、关系进度、临时情绪**不写全局**。每条必须有 `evidence` + `confidence`。

### 8.4 注入

- 静态 guide 在 system prompt（按 domain 选变体）；动态记忆走 plugin 消息。
- 首轮锚点 + 每用户回合最多一次；长工具回合仅在有新的真实人类消息批次时追加一次，普通工具步骤不触发。私有优先、全局补充；冲突时私有胜。
- **`injectedIds` 只能记真正进入文本的条目**，否则从未展示的记忆会被白白压制 8 轮。
- 锚点分段预算 pin 40% / core 30% / global 30%；pin 装不下时在末尾明示「另有 N 条未展开」，**不静默丢弃**。
- 预算单位是**模型 token**，不是字符：中文 ≈1 字符/token、英文 ≈3.4，一律走 `lib/budget.js`，**不要再用 `tokens * 3`**（那是英文口径，中文会超支约 3 倍）。
- 压缩后下一条用户消息重注入锚点；子代理不注入。
- 文件夹策略两个开关都关 → 不注入（看 clamp 后的生效值，不是 binding 原始值）。
- 召回为空必须留信号（§1.12）。

### 8.5 提示词管理

- 默认稿在 `lib/prompts/*.md`（随包）；用户覆盖在 `~/.dsh/dsh-memu-memory/prompts/*.md`；`manifest.json` 记 `defaultHash / userHash / defaultUpdated`。
- 运行时统一 `lib/prompts.js` 的 `loadPrompt(key, vars)` / `loadPromptForDomain(key, vars, domain)`，**业务代码里不许硬编码提示词正文**。
- system prompt 的 section `text` 必须是函数（每次装配重读文件，保存后下一轮生效），且**整体包 try/catch**（§3.7）。
- 模板只做单趟 `{{variable}}` 替换，变量值里的 `{{` 不会被二次展开——所以把记忆正文当变量塞进模板是安全的。**改成多趟插值之前先想清楚这一点。**
- 恢复默认 = 只删用户覆盖；全部恢复默认 = 清空覆盖目录。插件升级后：无覆盖的自动用新默认，有覆盖的保留并标记 `defaultUpdated`。
- 分层：**作用域 → 类型页 → 项**。类型页是数据（`settings.promptDomains`，默认 `[rp, coding, mixed]`），`general` 内置不可删。变体命名 `<name>.<domain>.md`，解析走 `resolveDef`：domain 在列表内且变体文件存在（默认目录**或**覆盖目录）→ 用变体，否则回落基础稿。
- **只有三个 key 分域**：`system-guide`、`private-policy`、`private-consolidation`。`global-curator` 不分域。
- **远程与本地共用一份 `private-consolidation`**：正文讲「记什么、字段怎么填」，两边差异只有输出协议（`CONSOLIDATION_CONTRACTS.local` 调工具 / `.remote` 返回 JSON，由代码追加）。不要拆第二份。
- RP 与 coding 的差异是**内容**差异：coding 记事实（决定、约束、踩过的坑、工程偏好），召回内容当「可能过期的事实」，与代码冲突时以代码为准、不要用记忆代替读文件；rp 记经验（具体瞬间、半句原话、身体感觉、没说出口的话、当时误以为的事），允许模糊和记错、不确定就把 `confidence` 标低。
- **KV cache**：section 文本随会话 domain 变化 —— 同一会话内恒定，缓存不受影响；中途改 domain 会让该会话缓存失效一次。可接受，但别在文档里写「文本恒定」。

---

## 9. 环境与命令

### 9.1 跑命令（Windows，这个仓库的实测口径）

`process.env` 在工具化执行里是**空的**，直接 `execFile` 子进程会拿到残缺环境。固定用这套 env：

```js
const env = {
  ELECTRON_RUN_AS_NODE: "1", SystemDrive: "C:", SystemRoot: "C:/Windows",
  PATH: "C:/Windows/system32",
  TEMP: "C:/Users/<you>/AppData/Local/Temp", TMP: <同上>,
  USERPROFILE: "C:/Users/<you>", APPDATA: ..., LOCALAPPDATA: ..., HOME: ...
};
execFile(process.execPath, ["--check", "lib/x.js"], { cwd, env });
```

**Windows 坑**：`git` 不在 PATH 上（用文件 mtime 代替 `git status`）；`tasklist` / `taskkill` 要给全路径 `C:/Windows/system32/`；`os.tmpdir()` 可能返回带反斜杠的怪值，临时目录用显式绝对路径；模板字符串里的路径用正斜杠。

**源码是 CRLF**：任何补丁都按「读 → `split("\r\n").join("\n")` → 断言 `from` 命中 **1 次** → 替换 → 写回时还原 `\r\n`」。命中 0 次或 >1 次都要停下来看，不要盲写。（`tests/webui.test.mjs` 是 LF，别套 CRLF。）

### 9.2 本地 link 到 DSH profile

```text
~/.dsh/profiles/<profile>/package.json:
  "dsh-memu-memory": "link:D:/Code/dsh-plugin/dsh-memu-memory"
并加入 dsh.profile.bundles
```

是符号链接 → 改源码即刻生效（无 bundle 缓存）。验证：`lstat` 看是否 symlink（§3.10）。

### 9.3 引擎安装

**Python 解析顺序**：① `engine/current.json` 指向的 venv ② `DSH_MEMU_PYTHON` ③ `py -3.13` / `-3.12` / `-3.11` ④ DSH 自带 Python（实测 3.12.14 可装 0.11.0b3）⑤ `python3` / `python` ⑥ `py -3.14`（最后，wheel 可能滞后）。

**报错先看这三处**：镜像顺序（用户配置 → 清华 → 阿里 → pypi.org）、venv 里是否残留 pip、`downloads/` 失败后是否被清。

**镜像顺序**：用户配置 → `https://pypi.tuna.tsinghua.edu.cn/simple` → `https://mirrors.aliyun.com/pypi/simple/` → `https://pypi.org/simple`。

**Lean venv**：`python -m venv --without-pip <venv>` + 基础 Python 的 `pip --python <venv python> install -r requirements.lock`，带 `--no-cache-dir`、`--only-binary=:all:`、`--disable-pip-version-check`。成功后删 `downloads/`；失败删失败版本目录与 downloads。

**成功判定 `ready`**：依赖装好 + `import memu` 成功 + `memu --help` 含必需命令 + 空库 `list-files --json` 成功 + 记录版本/镜像/日志路径。embedding 检索测试要 API key，**不作为安装成功条件**。

**升级 / 切换 / 回滚**：新版本装新目录，smoke 过才切换；**切换前对真实库做只读 smoke**、**先备份**（必须含 `state.json` + `index/*.json`，只备 sqlite 等于没备）、备份目录写 `manifest.json`；schema 版本变化要在 UI 明示「X → Y」并二次确认，**降级默认拒绝**；失败则删失败目录 + `current.json` 回写 + `history.json` 记一条 `attempts:[{at, ok:false, error}]`；成功则保留最近 3 个版本（`pruneEngineVersions({ keep = 3 })`，**硬编码默认值，不是设置项**），prune **永不删** current 与 recommended，持锁时跳过。`memu.js` 每次调用重读 `current.json`，所以**切换无需重启 DSH**。

### 9.4 MemU CLI 事实（2026-10-27）

- `memu-cli` 是 **PyPI 上的 Python 包，不是 npm 包**；锁定版本 `0.11.0b3`。
- 发布版 `memu --help` 只有：`retrieve, search, list-files, commit`。仓库源码里的 `memorize prepare/commit` **尚未发布**，所以**不要依赖 `memorize`**；把它当可选能力（启动时探测 `memu memorize --help`，成功才注册入口，失败就隐藏、不报错）。
- 必需命令：`retrieve` / `list-files` / `commit`；必需 flag：`--json` / `--db` / `--provider` / `--embed-model` / `--api-key` / `--base-url`。
- **所有 CLI 字符串只在 `lib/memu.js`**，不许散落。

```bash
python -m memu retrieve "query" --json --db <db>
python -m memu list-files --json --db <db>
python -m memu commit payload.json --json --db <db>
```

`commit` payload：`{ recall_files: [{ name, track: memory, description, content }], resource: [], user: {} }`。
---

## 10. 提交前检查清单

按类别分，**有一条答不上就先别提交**。括号里是违反之后会发生什么。

### 注入与召回

- [ ] 传给 `buildRecall` / `privateRecall` / `globalRecall` 的 exec 是 `{ agent }` 形状？（直接传 `agent` 会让召回**静默失效**，§6.3）
- [ ] 召回为空留了信号（`logger.warn` + `lastRecallError`）？（否则「没报错就是好了」）
- [ ] `injectedIds` 记的是**真正进入文本**的条目？（截断前 push 会白白压制未展示的记忆 8 轮）
- [ ] token 预算走 `lib/budget.js`？（`tokens * 3` 是英文口径，中文超支约 3 倍）
- [ ] `pending_review` 条目被挡在注入与召回之外？（§3.9）
- [ ] 没有每步注入、没有把动态记忆塞进 system prompt？（§1.4、§1.5）

### 数据安全

- [ ] 读失败没被当成空数据？（必须改名 `*.corrupt-<ts>` + 拒绝写入，§2.3）
- [ ] `state.json` 的合并写只用于记账字段？`index/*.json` 永远同步落盘？（§2.3）
- [ ] 统计等旁路文件写坏只降级页面，不阻塞记忆读写？（`stats.js` 绝不抛错）
- [ ] 索引写入按 `libraryId` 串行化？（并发 load→await→save 会丢记忆）
- [ ] 没有自动删除记忆；删会话只解绑不删库？（§1.6）
- [ ] 破坏性操作有二次确认，且确认前自动再备份？（§9.3）

### 作用域

- [ ] 文件夹 clamp 落在四处（`ensureSession` / `setSessionScope` / 注入准入 / 记忆读写）？（漏一处等于没有）
- [ ] 文件夹两个开关都关 → 不弹窗、不建库、不注入？（§2.3）
- [ ] 纯读路径用 `peekBinding` 而不是 `bindingFor`？（后者会替未绑定对话造库）

### 消息与 source

- [ ] 新消息点的 `source` 写成 `plugin:dsh-memu-memory`，**不是** `kind:plugin` + `plugin` 字段？（否则读 v4 会话直接抛错，§3.2；`tests/source-kind.test.mjs` 会拦）
- [ ] 没有试图修复已落盘的 v4 污染行？（只能诊断）
- [ ] `form: notice` 带了 `summary`？（折叠行才有一行可读摘要）

### 工具与 RPC

- [ ] 工具描述写清了默认值、拒绝条件、返回形状？（模型只读这段字）
- [ ] 主 agent 没有全局写入工具？（§1.3）
- [ ] 写操作成功后调了 `bumpMemoryRevision()` / `notifyMemoryWrite()`？
- [ ] 没往 `revisionOnly` 分支里塞业务数据？（它每 2.5 秒跑一次）
- [ ] 记忆浏览器的写操作只走白名单字段？（`layer` / `pinReason` / `pinSource` 不许从浏览器写，否则永久记忆准入被绕过）
- [ ] embedding 配置只回 `hasKey`，不回明文 key？

### UI

- [ ] 没有新增内联 `S.*` 样式？所有样式走 `dshm-` 作用域 CSS？
- [ ] `Button` 透传了 `title`？（漏掉整个界面悬浮提示静默失效）
- [ ] 「多种选一个」用的是 `.dshm-nav-list` / `.dshm-nav-item`，没写第二套？
- [ ] `<button>` 里没有嵌 `role="button"`；破坏性操作是二次点击不是 `confirm`？
- [ ] WebUI 里反面语义设置走了 `{ invert: true }`？
- [ ] 页序 `pageDefs` = `pageBlocks` = `PAGE` 三处一致？新增页在渲染探针里能过？
- [ ] 侧边栏首屏仍然只有 1 个 RPC、且不读记忆全文？
- [ ] 侧边栏没显示完整路径？（只 basename + 会话标题）
- [ ] 新增的面板同步用的是 `useMemoryBeat`，心跳载荷仍只有 `{ revisionOnly: true }`？
- [ ] 写操作通知了别处（`notifyMemoryWrite` / `broadcastMemoryWrite`），接收端没有回播、也没从消息里取数据？

### 提示词

- [ ] 正文在 `lib/prompts/`，业务代码里没有硬编码？
- [ ] 新增变体在 `package.json` 的 `files` 白名单里？（漏了 → `missing default prompt` → **整个会话崩**）
- [ ] 新 `{{变量}}` 在 `loadPromptForDomain` 的 vars 里传了？（漏了会原样漏进提示词）
- [ ] `syncPromptDefaults` 保留了 manifest 旧键？（否则清空用户覆盖记录）
- [ ] 「恢复默认」只删用户覆盖？

### 引擎与安全

- [ ] 没把 Python 装进系统解释器；venv 里没有 pip？（§1.7、§1.8）
- [ ] 没自动追最新 MemU；prune 绕开了 current 与 recommended？
- [ ] 日志与提示词里没有 key？
- [ ] 没碰共享 `/api`？（§1.10）

### 验证与文档

- [ ] `node --check` 过了改的每个文件？
- [ ] `npm test` 全绿（允许 1 条真实引擎用例跳过）？新增行为有对应用例？
- [ ] `node scripts/acceptance-local.mjs` 是 50/50？
- [ ] `npm run check` 输出 `all checks passed`？
- [ ] 新文案同时进了 `zh` / `en`？
- [ ] `README.md` 的能力/限制段同步了？踩过的坑补进了 §3？
