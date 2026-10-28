# 排错手册 — dsh-memu-memory

`AGENTS.md` 是索引，本文件是它的展开：**只在真的排错时读**。

**用法**：先在下面的症状速查表里认出是哪一段，再跳小节。每节固定三段——**症状**（大症状，不拆细）、**落点，可能的原因**（链到哪一段、哪个文件函数、可能坏在哪、往哪修）、**守卫**（哪条用例或信号拦住复发，怎么确认）。都是真发生过的，不写设想。

## 节号对照（本文件沿用原手册的节号）

| 节号 | 在哪个文件 |
|---|---|
| §1 硬规则（全文） | `AGENTS.md` 一句话版 + 本文件附录 E 全文 |
| §2.1 模块地图 · §2.2 调用链 · §2.3 数据铁律 | 本文件 附录 A / B / C |
| §3 出过的问题（3.0–3.15） | 本文件 |
| §4 改动流程 · §5 扩展点 · §10 提交前清单 | `docs/contributing.md` |
| §6 宿主事实与 API 速查（6.1–6.7，除 6.3） | `docs/host-api.md` |
| §6.3 三种 exec 形状 | 本文件 附录 D |
| §7 客户端约定 | `docs/client-conventions.md` |
| §8 记忆与提示词口径 | `docs/memory-semantics.md` |
| §9 环境与命令 | `docs/env-and-commands.md` |

## 症状速查

```text
只剩锚点 / 召回从不出现 → §3.1     会话打不开 → §3.2, §3.7
整库变空 → §3.3                    明明写了少一条 → §3.4
面板不刷新 → §3.5                  UI 错位 / 悬停提示没了 → §3.6
提示词改了不生效 → §3.7            引擎装不上 / 检索变差 → §3.8
待复核的记忆被用上 → §3.9          改了没反应 / 没有 memu_* → §3.10
待发区冒出整理提示 → §3.11         新对话读不到文件夹记忆 → §3.12
注入整段没了 → §3.13               日期语义错 / 看不见日期 → §3.14
保存成功但没变 / 字段改不回来 → §3.15
同文件夹里某条记忆凭空消失 / 新会话侧边栏空 → §3.17
聊很久一条记忆都没写 → §3.18
人格预设会话里完全没有记忆 → §3.19
```

## 3. 出过的问题：症状 → 落点 → 守卫

**用法**：先按 §3.0 认出段，再进对应小节。每节三件事：**症状**（大症状，不拆细）、**落点，可能的原因**（链到哪一段、哪个文件函数、可能坏在哪、往哪修）、**守卫**（哪条用例或信号拦住复发，怎么确认）。都是真发生过的，不写设想。

### 3.0 注入链路分段

一条记忆从写入到被模型读到只走这条链，**故障一定落在某一段**：

```text
S0 加载生效  profile node_modules → package.json exports → index.js apply() → 注册工具/注入/RPC
S1 会话绑定  inject.js ensureSession/bindingFor → state.js：scopeKey → libraryId + 两个开关 + autoInject
S2 写入      tools.js → privateRemember/privateUpdate/importMemories → checkEnums → reconcileSalientDate → accuracyOf
S3 落盘      state.js 记账 + index/<libId>.json → readFailure/quarantine → 按 libraryId 串行化
S4 选料      buildRecall → privateRecall/globalRecall → recallScore → MMR → injectedIds 去重
S5 预算      budget.js 换算 → snippet.js 裁剪 → pin/core/global 分段
S6 渲染      formatPrivate/dateTag/buildAnniversary → createUserMessage（plugin:dsh-memu-memory）
S7 宿主流    pre-step 钩子、compaction 重注入、会话 v4 校验、整理作业 fork
S8 展示回写  client.js 面板 + useMemoryBeat 心跳 + rpc.js allowed + tools.js schema
```

文件清单见 §2.1。总览：记忆不出现 / 只剩锚点 / 注入整段没了 → §3.1、§3.13；会话或设置页打不开、报格式错 → §3.2、§3.7；记忆变少或整库变空 → §3.3、§3.4；面板不刷新、UI 错位 → §3.5、§3.6；引擎、检索质量、复核泄漏 → §3.8、§3.9；改了没反应、新对话读不到记忆 → §3.10、§3.12；输入框上方冒出整理提示 → §3.11；日期语义错、改了保存不上 → §3.14、§3.15；弹窗答了侧边栏却两边都勾上 → §3.16。

### 3.1 记忆不出现，只剩锚点（S4 → S6）

**症状**：每回合只有锚点在注入，召回从不出现，也没有报错。

**落点，可能的原因**：pre-step → `buildRecall` → `privateRecall`/`globalRecall` → `formatPrivate` → `createUserMessage`。① exec 形状错：把 pre-step 的 `agent` 当 `exec` 传，`sessionIdOf` 得 `null`，`no bound session` 被空 catch 吞掉（正确形状 `{ agent }`，§6.3）；② `injectedIds` 记了没进文本的条目，后续 8 轮被白白压制（§8.4）；③ 预算把结果截空。修法：注入路径一律传 `{ agent }`，catch 必须写 `lastRecallError` 并 `logger.warn`。

**守卫**：`tests/inject.test.mjs` 断言的是**召回 id**，不是「消息插进去了」；手工用 `{ agent }` 调一次 `privateRecall`，看 `lastRecallError` / `logger.warn`。

### 3.2 会话打不开：v4 拒收裸 `kind:plugin`（S7）

**症状**：打开会话就抛错，整条会话读不出来（不是某次调用失败）。

**落点，可能的原因**：`assertReleasedV4Relationships()` 逐条校验 `source`，三条任一即抛 `format v4 message requires a producer-owned source kind`：`source` 不是对象；`kind` 缺失/非字符串/空串；`kind === plugin`（v3 裸包装）。修法：写 `{ kind: "plugin:dsh-memu-memory", form: "recall" }`，删掉 `plugin` 字段——core 的迁移 `producerKind()` 对未知插件就派生 `plugin:<name>`，历史行与新行同形态才读得回。产出点只有两处：`lib/inject.js`（`form: recall`）、`lib/private.js`（`form: notice` + `summary`）。别改成 `kind:user` 绕过（破坏 `source.kind === user` 判定）；迁移只处理 v3 行，已落盘的 v4 污染行只能改数据或重开线程。

**守卫**：`tests/source-kind.test.mjs` 静态扫 `lib/**/*.js`（无裸 `kind:plugin`、无 `plugin:` 字段、`form` 在 `KNOWN_FORMS` 内、`notice` 必带 `summary`）；改完拿旧会话 `readSession()` 回读。

### 3.3 记忆变少、整库变空（S3 读失败）

**症状**：条目凭空消失，`index/<libId>.json` 变成 `{"entries":{}}`，日志里一行错都没有。

**落点，可能的原因**：`paths.readJson` 的空 catch 把 JSON 语法错、`EBUSY`、`EMFILE` 全吞成 null → `loadPrivateIndex` 给出 `{entries:{}}` → 下一次 load→mutate→save 把整库原子覆盖成空。修法：读失败把原文件改名 `*.corrupt-<ts>` 保住并**拒绝写入**（抛 `dsh-memu-memory/read-failed` 让调用方 fail-open），暴露可见告警；`ENOENT` 不算读失败。

**守卫**：`scripts/acceptance-local.mjs` A-3（EISDIR 造 `kind: io`，`kind: corrupt` 由 `quarantine()` 搬走）；看索引目录有没有 `*.corrupt-<ts>`、`paths.readFailure()` 的 `kind`。

### 3.4 明明写了却少一条（S3 并发）

**症状**：库里写过，条目数却少一条，消失时间和整理作业或另一个窗口重合。

**落点，可能的原因**：`load → await → mutate → save` 的 await 边界——整理作业、curator、第二窗口同时写同一个 `index/*.json`，中间读到旧快照，后写覆盖前写。修法：索引写入按 `libraryId` 串行化（§2.3 铁律二），save 后回读校验。「数据消失」不许靠逐字比对会话记录反推，先有串行化和写后校验才谈得上归因。

**守卫**：同库连续两次写后条目数对不上即可确认；并发用例见 `tests/storage.test.mjs`。

### 3.5 面板不自动刷新（S8 心跳）

**症状**：侧边栏 / 设置页要手点刷新才更新，心跳却一直在跑。

**落点，可能的原因**：`getSidebarState({ revisionOnly: true })` 的标记。`memoryRevision()` 是**进程内**计数器，`memoryStamp()` 是**磁盘**指纹（`state.json` + `index/*.json` 的 `label:size:mtime`）。只比 `revision` 时，来自另一个 module 实例/进程的写入（工具调用、整理作业、另一窗口）计数器不动，心跳永远认为没变。修法：用 `revision|stamp` 组合键，任一半变就重拉，加 `visibilitychange` 补刷；三端统一 `useMemoryBeat({ call, markerRef, onBeat })`，独立页 `reloadCurrent()` 先取 marker、渲染成功后才采纳。

**守卫**：`tests/sidebar-beat.test.mjs`；入口是 `memu_status` 的 `sync:` 行——`heartbeat never` = 没有面板在轮询，`last write` 太久远 = 没人写。边界：2.5 秒上限、面板隐藏不轮询、指纹不覆盖正文。

### 3.6 UI 错位 / 样式异常（S8 面板）

**症状**：设置页错位、按钮挤成竖排、悬停提示没了、勾选框串位。

**落点，可能的原因**：客户端样式与组件层——内联 `S.*` 样式复活；`Button` 漏传 `title`（整个界面悬浮提示静默失效）；「多种选一个」被写成第二套分段控件；长文本挤按钮是 flex 缺 `minWidth:0`；勾选框串位是复用了带 `minWidth:132` 的 `Field` 标签列。修法：按 §7 用 `dshm-` 作用域 CSS，结构问题优先换组件（`CheckRow`），别调 margin。

**守卫**：`tests/client-render.test.mjs` 逐页渲染（抛错或 `[object Object]` 即失败）、`tests/webui.test.mjs` 静态拦 `ctx.standalone`；UI 改动须重新看图确认。

### 3.7 提示词改了不生效 / 会话打不开（S6 提示词装配）

**症状**：改提示词下一轮没变；或整个会话、设置页直接打不开。

**落点，可能的原因**：section 的 `text(context)` 抛错会**炸掉整个 prompt 装配**，不只是记忆功能。两个 throw：key 不认识、`missing default prompt`——后者常见成因是 `package.json` 的 `files` 白名单漏了 `lib/prompts/*.md`（全局安装时必现）。修法：section 整体 try/catch，回落 `.rp`/`.coding` → `general` → 一句降级文案；`text` 必须是函数；白名单覆盖 `lib/prompts/*.md`。

**守卫**：`tests/prompts.test.mjs`；看 `loadPrompt` 是否抛错、`prompts/manifest.json` 有没有用户覆盖挡住默认稿、渲染结果里是否残留 `{{变量}}`。

### 3.8 引擎装不上 / 换版本后检索变差（S4 引擎后端）

**症状**：安装失败；或换了引擎版本召回质量掉下来。

**落点，可能的原因**：`lib/engine.js` 的安装链（Python 顺序、镜像顺序、venv 残留 pip、`downloads/` 未清）；以及 `verifyEngine` 用的是 `os.tmpdir()` 里的**空库**，一个打不开真实 DB 的版本也能过它。修法：**切换前对真实库做只读 smoke**（`list-files --json --db <real>`）并**先备份**（含 `state.json` + `index/*.json`，只备 sqlite 等于没备）；备份存在前不跑任何可能触发 alembic 迁移的命令。

**守卫**：`tests/engine.test.mjs`、`tests/backup.test.mjs`；排查按 §9.3。

### 3.9 待复核的记忆被用上（S4 状态过滤）

**症状**：还挂在矛盾复核队列里的条目，既进了注入又被召回了。

**落点，可能的原因**：凡是「列出可用条目」的查询路径没带状态过滤。修法：`status: pending_review` 不许进注入、不许进召回，只许出现在复核队列（`listReviews` / `resolveReview`）。

**守卫**：`tests/audit-regression.test.mjs` 断言锚点与召回两处都不出现它。

### 3.10 改了没反应（S0 加载）

**症状**：改了 `lib/` 下的代码，应用行为还是旧的；或工具面里根本没有 `memu_*`。

**落点，可能的原因**：先看部署再看代码——`~/.dsh/profiles/<profile>/node_modules/dsh-memu-memory` 是**符号链接**还是**拷贝**（`lstat` 看）；`package.json` 的 `exports` 应是 `./client → ./lib/client.js`、`main → ./lib/index.js`、`dsh.client.platform: web`。是拷贝 → 改的不是在跑的那份。宿主**默认不落盘插件运行日志**，要验证激活那行就跑假 ctx 调 `apply()` 断言输出。**工具注册同理**：注册失败必须出现在会话可见处——`Object.keys(tools)` 有没有 `memu_*`、`memu_status` 的 `tools: N/N registered` 报了几个；只进日志的失败等于没有信号。

**守卫**：`tests/activation.test.mjs`；部署自检用 `lstat` + 一次工具面清点。

### 3.11 输入框上方冒出整理提示（S7 宿主流）

**症状**：待发区出现「整理这场对话的私有记忆」，可编辑可删，跑完还留着，之后每轮重发。

**落点，可能的原因**：宿主**没有静默入队**——`followup` / `steer` / `inject` 三个 API 都会画进待发区（`followup` 还是「下一轮」，所以一直重发）；界面上天然不可见的只有 origin 为 subagent 的 fork 子会话。修法：`lib/private.js` 的 `requestPrivateConsolidation()` 在 agent 后端一律走 `requestHistoricalConsolidation()`（transcript 做种子 → fork → `whenIdle` 后 dispose），`lib/cycle.js` 的睡眠整理同一条；不要为省一次 fork 退回 followup。

**守卫**：`tests/consolidation-fork.test.mjs` 断言 `liveFollowups` 为 0。

### 3.12 新对话读不到文件夹已有的记忆（S1 绑定）

**症状**：新会话注入是空的、侧边栏像没有记忆，而文件夹里明明已经有库。

**落点，可能的原因**：库解析只按「创建」条件走——`createLibrary && policy.useLibrary && wantsLibrary` 才调 `ensureLibraryForCwd`；宿主常传 `createLibrary:false`（提示词自动选择），于是即使已有库 `libraryId` 也是 `null`。修法：`createLibrary` 只管创建不管采纳——已有库必须复用，只有确实没有库且开关允许时才建；已归档的库不在此处复活。

**守卫**：`tests/injection-chain.test.mjs`；看 `state.json` 里该 `scopeKey` 是否已有库、新 binding 的 `libraryId` 是否 `null`。

### 3.13 注入整段没了（S6 无库早退）

**症状**：某次注入什么都没进来，binding 上记着 `injection failed: invalid library id`，平时召回正常。

**落点，可能的原因**：`buildAnniversary` 直接用 `binding.libraryId` 调 `loadPrivateIndex`，后者对空 id 抛错；它在 pre-step 里，一个 throw 被 fail-open 接住 → 整条注入（含普通召回）全放弃。修法：**无库不是错误**——没有库就没有纪念日，返回空块；召回层遇到无库跳过而不是尝试，否则「没有库」被记成「召回失败」。

**守卫**：看 binding 的 `libraryId` 是否 `null`（刚解绑/删库时常见）；用例见 `tests/injection-chain.test.mjs`。

### 3.14 日期语义错 / 日期看不见（S2 语义 → S6 展示）

**症状**：说「明天（2026-10-29）要去考驾照」那条记忆每年这天都冒出来；锚点行上看不到日期，模型只读到一句无法定年的「明天」。

**落点，可能的原因**：写入侧把「明天」解析成 `MM-DD` 交回来，而 `MM-DD` 的语义就是「每年这一天」，约定变成周年；展示侧漏渲染该字段。修法（写入）：`memory.js` 的 `reconcileSalientDate` 在写入侧结算——有相对日（今天/明天/后天/today/tomorrow）且 MM-DD 正好等于那天 → 存带年份日期；有明确日期 → 以它为锚；真纪念日（生日）保持 `MM-DD`；对不上不改写。三条路径都过它（`privateRemember`/`privateUpdate`/`importMemories`），四个 `private-consolidation*.md` 与 `tools.js` 的 `salient_date` 描述同步写明两种形态。修法（展示）：三个展示面都要给同一个标签——锚点行 `inject.js` 的 `dateTag`、召回与列表 `tools.js` 的 `salientTag`（`formatPrivateItem` 与 `memu_private_list` 共用）、面板 `client.js` 的 `dueDateTag`/`anniversaryTag`；形态 `date=YYYY-MM-DD` 为一次性，`anniversary=MM-DD` 为每年复现。少写一处，那个面上看起来就是「这条没有日期」。

**守卫**：`tests/injection-chain.test.mjs`、`tests/tools.test.mjs`（列表行必须与召回同标签）；看条目 `salientDate` 是 `MM-DD` 还是 `YYYY-MM-DD`、锚点行与列表行里有没有 `date=`/`anniversary=`。

### 3.15 保存成功但没变 / 字段改不回来（S8 → S2 更新层）

**症状**：面板或脚本报「保存成功」，条目一个字都没变；或字段写错改不回来，唯一补救是归档重写（会改掉 `createdAt` 和 `strength`）。

**落点，可能的原因**：写入侧丰富、更新侧贫瘠——字段只在 `privateRemember` 里赋值，`privateUpdate` 不认；未知键被静默丢弃；派生字段没重算；`layer !== target.layer` 把整个分支挡成 no-op。三条硬口径：① 未知字段必须报错（`unknown memory field: x; editable: …`）；② `accuracy` 由 `peak`/`arousal`/`confidence` 推出，改原料必须重算；③ `layer='short_term'` 重复设置 = **re-arm 截止时间**。字段要同时进 `privateUpdate` 允许表 + `rpc.js` 的 `allowed` + `tools.js` schema；UI 侧 `draftOf`/`saveDetail`/新建表单要能编辑，zh/en 两字典都加键。

**守卫**：`tests/update-fields.test.mjs`、`tests/browser.test.mjs`；确认顺序：`unknown memory field` → `allowed` 与 `privateUpdate` 签名 → `memu_private_update` schema → `accuracyOf` 是否重算。

### 3.16 弹窗选了「只私有」，侧边栏两个开关还是都勾上（S1 绑定 → S8 展示）

**症状**：新会话弹窗选了「只用私有记忆」（或「只用全局」），确认后侧边栏「使用私有记忆 / 使用全局记忆」两个 switch 仍然都勾着；勾了「记住我的选择」也一样，下次进新会话还是两个都勾。

**落点，可能的原因**：弹窗写了「库」，没写「两个开关」。`initSession` → `state.js` 的 `ensureSession` 在一个还没有 binding 的会话上按**文件夹策略**填两个开关（`policy.useLibrary !== false`），所以任何没被显式写入的开关都会回到文件夹默认值（默认两个都开）。旧 `confirm` 里「只私有」（`auto`）与「选已有库/新建库」三条分支只调了 `initSession`、没调 `setSessionScope`，两个开关就由策略落成 `true`——这就是「选了只私有，侧边栏却两个都勾上」。另一半：高级区块的库单选和卡片共用同一个 `choice`，点一下「选已有记忆库」把整卡答案改写成 `existing`，`confirm` 更没有可写的层。修法：卡片与库选择拆成两个状态（`choice` / `pick`），`LAYERS_OF` 一处定义「卡片 → 两个开关」，`confirm` 的每条分支（含已记住的选择）都以 `setSessionScope(..., ...layers)` 收尾，`createLibrary` 只跟私有层走；`rememberChoice` 的偏好表补 `global`，`rpc.js` 的 `allowed` 与 `state.js` 的 enums 同步接受它——否则「记住」被静默丢弃，`ensureSession` 又会按策略填回两个 `true`。

**守卫**：`tests/new-session-gate.test.mjs`——四张卡各点一遍，断言 `setSessionScope` 收到的 `useLibrary/useGlobal` 与卡片一致；四种「记住的选择」各跑一遍；高级区块换库后卡片答案不变、`initSession` 只带 `libraryId`。手工核对：看 `state.json` 里该 binding 的两个布尔值是否等于你点的那张卡。

### 3.17 同文件夹里某条记忆凭空消失 / 新会话侧边栏空白（S2 可见范围）

**症状**：同一个文件夹（同一个库）里，老会话看得见的某条记忆，在新会话的侧边栏里没有、注入里也没有，工具也读不到；而文件夹里其它记忆一切正常。`index/<libraryId>.json` 里条目还在。

**落点，可能的原因**：这版之前的条目可能被写成了 `visibility: 'session'`（会话级，模型自己填的），而 `sessionId` 指向的会话已被删除——那种条目谁也不是，读不到也改不了，正是「记忆凭空消失」的成因。**该级别已经从代码里删掉**：读到就按 `shared` 处理，`context`（channel/character/world/branch）原样保留，落盘时补 `migratedFromVisibility: 'session'` + `visibilityMigratedAt` 并删掉 `sessionId`。读路径在 `loadPrivateIndex`（`lib/state.js`）+ 迁移规则在 `lib/visibility.js`；没人再写的库由 `lib/migrate.js` 的周期巡检与侧边栏轮询（60 秒节流）重写。

**还有一种「消失」，不是 bug**：条目带着 `context`（例如 `characterId=hero`、`branchId=主线`），而当前会话的 `memoryContext` 是空白或另一套值。宽会话看不到窄条目，这是设计。核对方法：看条目 JSON 的 `context` 与侧边栏「记忆上下文」表单是否一致；只有记忆墙（`browseLibrary`，不带会话）能改别处上下文的条目。

**守卫**：`tests/visibility-migration.test.mjs`（迁移保留 context、读时归一、落盘可证、二次运行幂等、工具面拒绝 `session`、空白作用域跨会话可读 secret、secret 不进自动通道、`context` 仍隔离）+ `tests/context-scope.test.mjs`；手工核对：`node scripts/migrate-visibility.mjs`（默认只报告，退出码 3 = 有老数据待转换，`--apply` 才写且先备份），条目上出现 `migratedFromVisibility: 'session'` 就是升级过。

### 3.18 聊了一整晚，一条记忆都没写（S7 空闲整理 → S2 写入）

**症状**：会话里明明发生了很多事，`memu_status` 的 `inbound` 计数也涨了，但库里一条新条目都没有；`state.json` 里该 binding 的 `lastSleepAt` 停在前一天。

**落点，按概率排**：
- **回合内没有人调用 `memu_private_remember`。** 插件不会每轮自动写记忆——每回合的写入是模型的决定，空闲整理只是兜底。`memu_status` 的 `injectedIds`、`lastInjectedTurn` 正常、`inbound` 计数正常，就说明注入没坏，是「没写」而不是「没读到」。
- **空闲窗口没落在应用开着的时候。** 巡检定时器只在应用运行时存在；应用关掉时结束的对话等不到那次 `runSleepPass`，而用户一回来发消息，`lastTurnAt` 就被顶新了。现在启动后 8 秒会补跑一次（最多 2 个会话），默认空闲阈值也从 8 分钟降到 3 分钟。
- **新回合被评估为「不值得整理」。** `assessConsolidationValue` 只拒绝两种：`lastSleepSeq` 之后没有任何人类消息；或只有一条纯应答（「谢谢」「好的」「ok」，无工具调用）。其余都会进 fork，由整理提示词决定写不写——**写 0 条是合法结果**，不是故障。
- **整理失败一直退避。** 看 binding 的 `lastSleepError` / `sleepRetryAt` / `sleepAttempts`。会话被删会得到 `session "…" not found`，现在会标 `sessionGone: true` 并停止重试（以前会每小时重来）。

**守卫**：`tests/cycle.test.mjs`（空闲阈值、启动补偿、`sessionGone` 只标记一次、寒暄不 fork）+ `tests/consolidation-value.test.mjs`（评估边界：插件通知不算人类消息、纯应答跳过、「我不吃香菜」这种五个字的偏好必须留下、`lastSleepSeq` 之后的尾巴才算）。手工核对：`state.json` 里 `lastSleepAt` / `lastSleepSeq` / `sessionGone` / `sleepAttempts` 四个字段。

### 3.19 人格预设（agent preset）的会话里完全没有记忆（S1 绑定 → S4 注入）

**症状**：切到「完整人格」类预设（例如 `i-am-yuike`、`yuike-standard`、`yuike-ptc`）之后，那个会话里既没有 `<memory-anchor>`、也没有 `memu_*` 工具，`state.json` 的 `sessions` 里连这个会话的 binding 都没有（不是「写了没读到」，是「从来没接上」）。

**落点**：预设会话的「模型可见插件集」是它自己那份 `cordis.yml` 清单，整棵子树是独立 scope——`agent/pre-step` 只会向自己的祖先冒泡，永远到不了部署级实例的监听器，于是 `ensureSession` 从不执行。`persona` 的 `complete: true` 只是把 system prompt 段剥掉，**不是原因**；所以「把 memu 加进预设」和「改预设的 cordis.patch.yml」都不是本插件该做的事（那是别人的人格插件）。

**人格把提示词吃掉了**：`persona` 的 `complete: true` 会把本插件注入的 system prompt 段整段丢弃（实测 `E:p` 的会话 `system/message` 只有人格正文，但工具链里 `memu_private_*` 是在的）。仅靠 system prompt 段的话，模型有工具却不知道可以主动写。现在改为**首步用消息投放一次 `<memory-guide>`**（`binding.guideMessageAt` 去重），并在文末提示「没有 `memu_*` 工具就忽略本段」。

**现在的做法**：`lib/preset-scope.js` 每 10 秒枚举 `ctx.get('agents').list()`，对**不在本插件 scope 树里**的会话（判据是沿 `agent.ctx.fiber` 往上找本插件的 fiber，找不到才算），在它**自己的 ctx** 上补挂 `registerInjection(ctx, { guide: false })`——只给记忆锚点，不承诺预设没有的工具。已挂过的按 agent ctx 记在进程级登记表里，会话消失就卸载；正常会话（同一棵树）跳过，避免注入两遍。

**边界**：这样接上的会话**只有注入，没有 `memu_*` 工具**（工具面由预设的清单决定，宿主的 tool registry 全局层对这些会话是空的）。要写记忆得让它进一次标准会话，或等该预设的维护者自己列上这个插件。

**守卫**：`tests/preset-scope.test.mjs`（同树跳过、兄弟树挂上、只挂一次、agent 消失就卸载、子 agent 与无 ctx 的条目跳过、无 `agents` 服务不算错）。手工核对：日志里有 `attached memory injection to preset conversation <id>`，且 `state.json` 的 `sessions` 出现该会话。

---


## 守卫索引表

正文只留「症状 + 落点」；拦复发的测试与信号集中在这里。

| 小节 | 症状 | 守卫 |
|---|---|---|
| §3.0 | 注入链路分段 |  |
| §3.1 | 记忆不出现，只剩锚点 | `tests/inject.test.mjs` 断言的是**召回 id**，不是「消息插进去了」；手工用 `{ agent }` 调一次 `privateRecall`，看 `lastRecallError` / `logger.warn`。 |
| §3.2 | 会话打不开：v4 拒收裸 `kind:plugin` | `tests/source-kind.test.mjs` 静态扫 `lib/**/*.js`（无裸 `kind:plugin`、无 `plugin:` 字段、`form` 在 `KNOWN_FORMS` 内、`notice` 必带 `summary`）；改完拿旧会话 `readSession()` 回读。 |
| §3.3 | 记忆变少、整库变空 | `scripts/acceptance-local.mjs` A-3（EISDIR 造 `kind: io`，`kind: corrupt` 由 `quarantine()` 搬走）；看索引目录有没有 `*.corrupt-<ts>`、`paths.readFailure()` 的 `kind`。 |
| §3.4 | 明明写了却少一条 | 同库连续两次写后条目数对不上即可确认；并发用例见 `tests/storage.test.mjs`。 |
| §3.5 | 面板不自动刷新 | `tests/sidebar-beat.test.mjs`；入口是 `memu_status` 的 `sync:` 行——`heartbeat never` = 没有面板在轮询，`last write` 太久远 = 没人写。边界：2.5 秒上限、面板隐藏不轮询、指纹不覆盖正文。 |
| §3.6 | UI 错位 / 样式异常 | `tests/client-render.test.mjs` 逐页渲染（抛错或 `[object Object]` 即失败）、`tests/webui.test.mjs` 静态拦 `ctx.standalone`；UI 改动须重新看图确认。 |
| §3.7 | 提示词改了不生效 / 会话打不开 | `tests/prompts.test.mjs`；看 `loadPrompt` 是否抛错、`prompts/manifest.json` 有没有用户覆盖挡住默认稿、渲染结果里是否残留 `{{变量}}`。 |
| §3.8 | 引擎装不上 / 换版本后检索变差 | `tests/engine.test.mjs`、`tests/backup.test.mjs`；排查按 §9.3。 |
| §3.9 | 待复核的记忆被用上 | `tests/audit-regression.test.mjs` 断言锚点与召回两处都不出现它。 |
| §3.10 | 改了没反应 | `tests/activation.test.mjs`；部署自检用 `lstat` + 一次工具面清点。 |
| §3.11 | 输入框上方冒出整理提示 | `tests/consolidation-fork.test.mjs` 断言 `liveFollowups` 为 0。 |
| §3.12 | 新对话读不到文件夹已有的记忆 | `tests/injection-chain.test.mjs`；看 `state.json` 里该 `scopeKey` 是否已有库、新 binding 的 `libraryId` 是否 `null`。 |
| §3.13 | 注入整段没了 | 看 binding 的 `libraryId` 是否 `null`（刚解绑/删库时常见）；用例见 `tests/injection-chain.test.mjs`。 |
| §3.14 | 日期语义错 / 日期看不见 | `tests/injection-chain.test.mjs`、`tests/tools.test.mjs`（列表行必须与召回同标签）；看条目 `salientDate` 是 `MM-DD` 还是 `YYYY-MM-DD`、锚点行与列表行里有没有 `date=`/`anniversary=`。 |
| §3.15 | 保存成功但没变 / 字段改不回来 | `tests/update-fields.test.mjs`、`tests/browser.test.mjs`；确认顺序：`unknown memory field` → `allowed` 与 `privateUpdate` 签名 → `memu_private_update` schema → `accuracyOf` 是否重算。 |
| §3.16 | 弹窗选了却两边都勾上 | `tests/new-session-gate.test.mjs`（四张卡 + 四种「记住的选择」都断言 `useLibrary`/`useGlobal`，且换库不改层）；看 `state.json` 里该 binding 的两个布尔值是否等于卡片。 |
| §3.17 | 同文件夹里某条记忆凭空消失 | `tests/visibility-migration.test.mjs`（迁移保留 context / 读时归一 / 落盘可证 / 幂等 / 拒绝 session / 空白作用域互读 / secret 不自动注入 / context 隔离）+ `tests/context-scope.test.mjs`；手工跑 `node scripts/migrate-visibility.mjs`，看条目上有没有 `migratedFromVisibility: 'session'`，以及 `context` 与当前会话是否一致。 |
| §3.18 | 聊很久一条记忆都没写 | `tests/cycle.test.mjs`（阈值 / 启动补偿 / `sessionGone` 只标一次 / 寒暄不 fork）+ `tests/consolidation-value.test.mjs`（评估边界）；手工看 `state.json` 的 `lastSleepAt`/`lastSleepSeq`/`sessionGone`/`sleepAttempts`。 |
| §3.19 | 人格预设会话里完全没有记忆 | `tests/preset-scope.test.mjs`（同树跳过 / 兄弟树挂上 / 只挂一次 / agent 消失就卸载 / 子 agent 跳过）；日志 `attached memory injection to preset conversation`；`state.json` 里该会话出现 binding。 |

## 附录 A · 模块地图（原 §2.1）

### 2.1 模块地图

| 文件 | 职责 / 什么时候碰它 |
|---|---|
| `lib/index.js` | 宿主入口 `apply()`：注册工具/RPC/slot、激活日志、装引擎 |
| `lib/inject.js` | 锚点与回合注入、检索门、类人偏置应用、`formatPrivate`/`dateTag` |
| `lib/inbound.js` | 外部人类消息批次协议、排队去重与逻辑时钟；公开 `./integration` |
| `lib/memory.js` | 分层、`decayStrength`、`recallScore`、边缘化、领域过滤、`privateRemember/Recall/Update`（改语义最需小心） |
| `lib/state.js` | `state.json` 与 `index/*.json` 原子读写、合并写、`memoryRevision`/`memoryStamp`、`syncActivity`、`DEFAULT_SETTINGS` |
| `lib/paths.js` | 读失败隔离：`readJsonStrict`、`*.corrupt-*`、写屏障 |
| `lib/tools.js` | 10 个 `defineTool` 工具、输出格式化 |
| `lib/private.js` | 私有整理：当前对话、历史 fork、notice 消息 |
| `lib/curator.js` / `lib/cycle.js` | 全局 curator 与 `pending_review`；空闲整理 pass（过期/降级/晋升/自动整理） |
| `lib/mood.js` / `lib/budget.js` / `lib/snippet.js` | 情绪价与峰值；token 换算（中文≈1 字符/token、英文≈3.4，任何 token 都走它）；注入片段裁剪 |
| `lib/rpc.js` / `lib/client.js` / `lib/webui.js` + `lib/webui/standalone.js` | `/dsh-memu-memory` 的 72 个方法（旧路由别名同一鉴权）；九页设置 + 侧边栏 `MemoryTab` + `useMemoryBeat`；独立壳挂载同一 SettingsPage，不复制实现 |
| `lib/graph.js` / `lib/context.js` / `lib/media.js` | 关系边与实体；说话人/频道/角色/世界线/知情边界；附件采集、缩略图、受保护路由、ZIP |
| `lib/prompts.js` + `lib/prompts/` | 提示词加载/覆盖/恢复/domain 变体解析 |
| `lib/engine.js` / `lib/memu.js` / `lib/memu-config.js` | Python 引擎安装探测切换回滚；MemU CLI 适配（**所有 CLI 字符串只在这里**）；`~/.memu/config.env` 的 embedding |
| `lib/stats.js` | 私有库旁路计数（`written/injected/recalled/archived`，90 天滚动）；读失败只降级页面，不碰记忆 |
| `lib/remote-summary.js` | 远程摘要 |


## 附录 B · 一次注入的调用链（原 §2.2）

### 2.2 一次注入的调用链

```text
agent/pre-step（source.kind=user, decision=enter, 每回合第一步）
  └ inject.js injectForStep({ agent })
      ├ ensureSession / clamp（文件夹上限 && 对话开关）
      ├ 首轮或压缩后 → 锚点块（pin 40% / core 30% / global 30%，budget.js 换算）
      ├ 之后每回合 → buildRecall（privateRecall + globalRecall，MMR λ=0.72，injectedIds 去重）
      └ 可能 cue（随机侧事件，反环规则见 private.js）
  └ createUserMessage({ content, source: { kind: plugin:dsh-memu-memory, form: recall } })
      宿主自己渲染成可折叠的「上下文注入」行，插件不做折叠
```

长工具回合另一入口：`tool/result.meta.memoryInbound` / 白名单完整协议 / `./integration` → `lib/inbound.js` 有界队列 → 下一次 enter 的 pre-step（允许 step>1）→ 按逻辑消息批次召回。不解析任意日志；协议见中英文 README 外部消息节，回归 `tests/inbound.test.mjs`。

三点容易记反：**注入是新增一条消息、不改用户消息**；**折叠是宿主做的**；**召回为空必须留信号**。


## 附录 C · 数据布局与三条写入铁律（原 §2.3）

### 2.3 数据布局与三条写入铁律

```text
~/.dsh/dsh-memu-memory/
├─ state.json               设置 + 文件夹策略 + 会话绑定（记账字段可合并写）
├─ index/<libId>.json       私有记忆全文（唯一真相源，同步落盘）
├─ index/global.json        全局记忆
├─ engine/<version>/venv    + current.json + history.json
├─ libraries/<libId>.sqlite3  仅 api 后端的向量层（加速，不是真相）
├─ prompts/                 用户覆盖 + manifest.json（变体 <name>.<domain>.md）
└─ downloads/ logs/ backups/
```

**铁律一：读失败不得当成空数据。** `readJson` 的空 catch 会把 JSON 语法错、`EBUSY`（Windows 杀软/索引持句柄）、`EMFILE` 全吞成 null → `loadPrivateIndex` 给出 `{entries:{}}` → 紧接着一次 load→mutate→save 把整库**原子覆盖成空**，日志一行错都没有。规则：读失败把原文件改名 `*.corrupt-<ts>` 保住、**拒绝后续写入**（抛错让调用方 fail-open）、暴露可见告警。`ENOENT` 不算读失败（首启、新库是正常的「还没有」）。

**铁律二：索引写入按 `libraryId` 串行化。** curator、种子 fork、主 agent 会并发对同一个 `index/*.json` 做 load→await→mutate→save，`await` 边界上后写覆盖前写，丢的是记忆本身。

**铁律三：`state.json` 可合并写，`index/*.json` 永远同步。** 崩一次丢 50ms 的「上次注入到哪了」没关系，丢一条记忆不行。

**两层作用域：文件夹是上限，不是初值。**

```text
文件夹 workspacePolicies[scopeKey] = { useLibrary, useGlobal }   ← 上限
对话   sessions[sessionId]         = { useLibrary, useGlobal }   ← 各自的选择
生效值 = 文件夹 && 对话
```

- **clamp 必须落在四处**，漏一处等于没有：`ensureSession`（绑定）、`setSessionScope`（改写）、注入准入（`inject.js`）、记忆读写（`privateRemember`/`privateRecall`/`globalRecall`）。
- `setWorkspacePolicy` **不改写**已有 binding 的开关（只在打开时补齐缺失的 `libraryId`）：关掉靠 clamp 立刻生效，重开恢复每个对话自己的选择。
- 文件夹两个开关都关 → 新对话**不弹窗、不建库、不注入**，侧边栏显示「没有启用文件夹记忆」。
- 纯读路径用 `peekBinding`/`getSessionBinding`，**不要**用 `bindingFor`/`ensureSession`——后者会顺手建库。

---


## 附录 D · 取 sessionId 的三种形状（原 §6.3）

### 6.3 取 sessionId 的三种形状（务必对照）

| 场景 | 拿到的对象 | 正确路径 |
|---|---|---|
| 工具 `execute(args, exec)` | `ToolExecution`（`agent?` 在**顶层**） | `exec.agent.session.header.id` |
| `agent/pre-step` 的 payload | `{ agent, messages, turn, step, signal }` | `payload.agent.session.header.id` |
| system prompt section 的 `text(context)` | `AssembleContext`，实际是 `{ agent, scope: agent, signal }` | `context.agent.session.header.id` |

`Agent` 自身**没有** `.agent` 字段。把 pre-step 的 `agent` 直接当 `exec` 传给 `memory.js` → `sessionIdOf` 得 `null` → `no bound session` → 被注入路径的空 catch 吞掉 → **每回合召回静默失效**（§3.1）。注入路径必须传 `{ agent }`。

section 的 `text(context)` 能拿到 `context.agent`，所以 system prompt **可以按会话 domain 分层**；但它抛错会炸掉整个 prompt 装配，取值必须整体 try/catch 并回落 `general`。


## 附录 E · 硬规则全文（原 §1）

`AGENTS.md` §1 是这十条的精简版（索引必须短）；**规则 10 的成因只在这一份里**，两边改一处就得改另一处，`acceptance-local.mjs` 的 G-1 会对比。

## 1. 硬规则（不放宽）

1. **不改 DSH 源码**，只用插件、公开 service、RPC、slot；只用公开扩展点。
2. **不让主 agent 写全局记忆**：全局只由 curator 写，主 agent 只读。
3. **动态记忆不进 system prompt**（静态 guide 可以）：走独立 plugin 消息，保护 KV cache 也让注入可折叠。
4. **不每步注入**：普通回合首步注入；长工具回合只在出现尚未处理的真实人类消息批次时追加一次。工具日志、心跳不算人类消息。
5. **不自动删除记忆**：永久记忆移出 = 边缘化；删库必须显式确认；删会话默认只解绑。
6. **Python 不装进系统解释器 / 用户 site-packages**，只装 `engine/<version>/venv`，且 venv 里不留 pip（`--without-pip` 建，再用基础 Python 的 `pip --python` 指进去装）。
7. **不自动追最新 MemU**：只装声明版本，升级走新 venv + smoke + 切换 + 保留旧版。
8. **不碰共享 `/api`**：RPC 只走 `/dsh-memu-memory` 前缀（`webServer.register` + `connection.requestRejection`）。
9. **日志与提示词里不放 API key。**
10. **注入失败 fail-open，但必须留可观测信号。** 抛错不许改变宿主的 turn 错误语义（吞掉是允许的），代价是真实故障一起被吞：`inject.js` 若把 pre-step 的 `agent` 当 `exec` 传给 `buildRecall`（正确形状 `{ agent }`，§6.3），`no bound session` 就只被空 catch 吃掉——**每回合召回静默失效、只剩锚点、日志一个字都没有**。所以 fail-open 必配 `logger.warn` + binding 上的 `lastRecallError`（侧边栏可见），单测断言**召回到的 id**，不能只断言「消息插进去了」。**不能靠「没报错就是好了」。**

---
