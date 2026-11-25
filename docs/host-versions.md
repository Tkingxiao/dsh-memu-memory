# 宿主跨版本事实台账 — dsh-memu-memory

> **本文件是「哪个 DSH 构建被核对到哪一步、每个宿主面长什么样」的唯一归属。**
> 流程（怎么核对新宿主、真机怎么搭）在 `docs/host-adaptation.md`；宿主 API 的当前形状速查在
> `docs/host-api.md`；故障症状在 `docs/troubleshooting.md`。同一事实只写一次：那三份文件里凡是
> 逐版本的答案都指向本文，不再各存一份副本。
>
> 为什么需要它：`host-adaptation.md` 的 §2 版本列、§5 实测记录、§7 版本记录曾各自记录同一批
> 宿主面，结果 §7 断在 `0.2.2-rc.1`、§2 把 `connection.requestRejection` 写成「未变」，而它在
> `0.2.3-alpha.1` 就已被移除。**一份事实写三处，就一定会有两处是旧的。**

## 13.1 核对台账

一构建一行。「核对方式」只有三种取值：`真机`（跑过 `docs/host-adaptation.md` §3.5 四件套）、
`源码`（对该 tag 逐面重读 `git show <tag>:<path>`）、`未测`。**跨补丁线即使结论相同也另起一行**：
一行结论是**在那个 commit 上读出来的**，"这条线也一样"这句话必须由该行自己写一遍并带上依据。
「判定」：`exact` = 本行单独核对过；`line` = 同补丁线另一 tag 的结论沿用（必须在备注点名是哪个）；
`nearest` = 未核对，按最近一行执行。**这三档只是人工记账口径，代码不读它**（见 §13.6）。

| 宿主构建 | commit | 核对方式 | 判定 | 日期 | 结构指纹 | 未覆盖面 / 依据 |
|---|---|---|---|---|---|---|
| `0.2.0-rc.1` | `4878cdabd8` | 源码 | exact | 2026-11-26 | `rpcGuard=requestRejection;schedule=session;activation=nested;coldLog=session-query` | 真机、客户端面；早于 `engines.dsh` 下界，只作历史基线 |
| `0.2.1-rc.3` | `1f81c047fc` | 源码 | exact | 2026-11-26 | `rpcGuard=requestRejection;schedule=session;activation=nested;coldLog=session-query` | 真机；`docs/host-api.md` 的 2026-10-27 基线 |
| `0.2.1-rc.5` | `b830ec950f` | 源码 | exact | 2026-11-26 | `rpcGuard=requestRejection;schedule=session;activation=nested;coldLog=session-query` | 真机；0.2.1 线尾 |
| `0.2.2-alpha.3` | `05b1cae8db` | 源码 | exact | 2026-11-03 | `rpcGuard=requestRejection;schedule=global;activation=nested;coldLog=session-query` | 真机；schedule 新形状在此定型 |
| `0.2.2-rc.1` | `66491b05e3` | 真机 | exact | 2026-11-05 | `rpcGuard=requestRejection;schedule=global;activation=nested;coldLog=session-query` | 桌面壳标题栏、`startActivation` 全作业（§5.4） |
| `0.2.2-rc.2` | `ddac96760b` | 源码 | exact | 2026-11-26 | `rpcGuard=requestRejection;schedule=global;activation=flat;coldLog=session-query` | 真机；**扁平 `SubagentActivationSpec` 首发** |
| `0.2.2-rc.3` | `38a6a5c965` | 源码 | exact | 2026-11-26 | `rpcGuard=requestRejection;schedule=global;activation=flat;coldLog=session-query` | 真机；逐面重读与 rc.2 逐项相同（同线，但本行自带依据） |
| `0.2.2-rc.4` | `3f321d32bf` | 源码 | exact | 2026-11-26 | `rpcGuard=requestRejection;schedule=global;activation=flat;coldLog=session-query` | 真机；用户机器上无此 home |
| `0.2.2-rc.5` | `9c2670d3bc` | 源码 | exact | 2026-11-26 | `rpcGuard=requestRejection;schedule=global;activation=flat;coldLog=session-query` | **真机四件套未跑**（用户装有该 home） |
| `0.2.3-alpha.1` | `d98f5d6851` | 源码 | exact | 2026-11-26 | `rpcGuard=admit;schedule=global;activation=flat;coldLog=session-query` | 真机；**`requestRejection` 在此移除** |
| `0.2.3-alpha.2` | `4b399c39a6` | 源码 | exact | 2026-11-26 | `rpcGuard=admit;schedule=global;activation=flat;coldLog=session-query` | 真机；源码仓库 HEAD |

**这张表怎么读**：指纹相同 = 本插件的行为相同；指纹不同 = 必须看 §13.3 的那一行。
`0.2.2-rc.5` 与 `0.2.3-alpha.1` 只差一个 `rpcGuard`，但那正是「RPC 有没有越权守卫」的差别。

## 13.2 宿主面事实矩阵

一面一行。「落点」列是插件里的探测点，`scripts/check-doc-drift.mjs` Gate 4c 会核对它仍然存在；
「形状」列的取值域见 §13.3。新增一个探测面 = 加一行 + 在 §13.1 的指纹里带上它的键。

| 面ID | 宿主表面 | 探测判据 | 落点 | 缺失时的降级与信号 | 形状 |
|---|---|---|---|---|---|
| `rpcGuard` | RPC 入口的来源判定 | `requestRejection` → `admit` → `isTrustedApiRequest`（三级，均按存在性） | `lib/rpc.js:requestRejectionOf` | 三者都没有 = 放行 + 一次性 warn（不 fail closed） | `requestRejection` ≤0.2.2-rc.5 / `admit` ≥0.2.3-alpha.1 |
| `schedule` | `ctx.schedule` 定时器 | `typeof schedule.edit === 'function'` → 全局级，否则 `delete` → 会话级 | `lib/salient-wake.js:scheduleFlavor` | 都没有 = 跳过日期唤醒 + 一行日志，不每轮撞同一错误 | `session` ≤0.2.1-rc.5 / `global` ≥0.2.2-alpha.3 |
| `activation` | `subagents.startActivation` 规格 | `rootOf` 或 `namesOf` 存在 → 扁平；否则嵌套 | `lib/curator.js:activationUsesFlatSpec` | 形状猜错被 `TypeError` 拒绝时换另一形状重试一次 | `nested` ≤0.2.2-rc.1 / `flat` ≥0.2.2-rc.2 |
| `coldLog` | 冷读会话日志 | 候选模块逐个 import + 导出存在性 | `lib/consolidation-snapshot.js:COLD_LOG_MODULES` | 全部失败 = 只读活视图 + `COLD_LOG_READER_UNAVAILABLE` | `session-query`（0.2.0 → 0.2.3 全部命中第一候选） |
| `tools` | `defineTool` + `ctx.tools.register` | 方法存在性 | `lib/tools.js:toolBase` | 注册不上就少几个工具，不崩 | 全构建一致 |
| `preStep` | `agent/pre-step` payload | `payload.agent` 形状，不读版本号 | `lib/inject.js:registerInjection` | 取不到 session 就跳过注入并留 `lastRecallError` | 全构建一致（0.2.2 起多带 `modelSelection`，本插件不读） |
| `userMessage` | `createUserMessage` | 函数存在性 | `lib/inject.js:registerInjection` | 没有就无法注入，走 fail-open + warn | 全构建一致 |
| `sessions` | `sessionQuery` 的 list/read/observe | 方法存在性 | `lib/rpc.js:authorizeWithCapability` | 缺方法 = 该视图降级为空 + 可见告警 | 全构建一致 |
| `workspace` | `workspaceRegistry` + `domain/changed` | 服务与方法存在性 | `lib/rpc.js` + `lib/cycle.js:runLibraryHousekeeping` | 拿不到注册表 = 不归档（1.3.14 的在用判据兜住） | 全构建一致 |
| `attachment` | `attachments.readImage` | 方法存在性 | `lib/media.js:readImage` | 缺 = 图片不入库，正文照常 | 全构建一致 |

## 13.3 破坏性变更账本

只登记**确实改变插件行为**的项。「探测失效后果」写的是不修会怎样——这一列是这套探测存在的理由。

| 变更 | 首个构建 | 上一构建 | 新形状 | 旧形状 | 插件的探测分支 | 探测失效的后果 | 守卫用例 |
|---|---|---|---|---|---|---|---|
| `SubagentActivationSpec` 扁平化，同批新增树内省方法 | `0.2.2-rc.2` (`ddac96760b`) | `0.2.2-rc.1` (`66491b05e3`) | `parent`/`cwd`/`prompt`/`agentOptions` 平铺顶层；新增 `rootOf`/`namesOf`/`resolveName`/`waitForTreeWork` | `{ parent, request: { … } }` | `activationUsesFlatSpec()` 按标记方法选形，另带零副作用 `TypeError` 单次回退 | 每个整理 fork 种子被宿主拒收，整理静默停摆（1.2.6 真实中招） | `tests/curator-contract.test.mjs` |
| `ctx.schedule` 会话级 → 宿主级 | `0.2.2-alpha.3` (`05b1cae8db`) | `0.2.1-rc.5` (`b830ec950f`) | `create(request)`、`list()→{items}`、`edit({id, action:'delete'})` | `create(sessionId, request)`、`list({sessionId})→数组`、`delete({sessionId,id})` | `scheduleFlavor()` 返回 `global`/`session`/`null` | 把 sessionId 当 request 传 → 排到错误目标或每次 sweep 抛错 | `tests/salient-wake.test.mjs` |
| `connection.requestRejection` 移除 | `0.2.3-alpha.1` (`d98f5d6851`) | `0.2.2-rc.5` (`9c2670d3bc`) | 只剩 `admit(request): {peer} \| {rejection:401\|403\|503}`；`isTrustedApiRequest` 只在模块层 | `requestRejection(req)` 返回 401/403/undefined | `requestRejectionOf()` 三级探测（`admit` 一级新增） | **全部 RPC 路由对任何来源放行**，而日志一句错都没有 | `tests/webui-auth.test.mjs` |
| `decision.messages` 只在首次尝试追加 | 全构建（`agent-loop/src/agent.ts` 的 `firstAttempt`） | — | 压缩后重试不再重放 decision 消息 | — | 插件按「紧跟人类消息之后」落点，不依赖重放 | 以为规则消息每步都在，实际只在首轮 | `tests/injection-chain.test.mjs` |

**曾以为是变更、核对后不是的两条**（写在这里，免得下次再误判一遍）：

1. `@deepseek-ai/dsh-session-query` 的目录**从 0.2.0 起就是嵌套的**
   （`packages/session-query/session-query/src/cold-read.ts`），不是 0.2.3 才改的；上一轮按单层路径
   搜不到才误判成「包消失」。`COLD_LOG_MODULES` 的第一候选一直命中。
2. `connection.authorizeLibrary` **在任何已核对的宿主上都不存在**（8 个 tag 全量 0 命中）。
   它是插件为未来宿主预留的钩子，不是一道现有防线；`lib/rpc.js:authorizeWithCapability` 的日志
   文案已按这个事实改写。

## 13.4 装载与门禁

- 宿主在 `engines.dsh` 存在时**只看它**做加载门禁（`app-boot/plugin-compatibility.ts`），
  `peerDependencies` 里的 `@deepseek-ai/dsh-*` 不参与拦截。本插件 `engines.dsh` = `>=0.2.0-rc.1`。
- **红线：不收窄、不加下界、不 fail closed。** 门禁写错 = 插件整包不加载，且界面上没有提示。
- `dsh.compatibility.dshReleases` 是给人（和市场页）看的记录，**宿主产物里没有消费者**；值沿用
  §13.1 里判定为 `exact`/`line` 的构建，Gate 4f 保证两处不打架。
- 装或更新插件后必须**重启宿主**：兼容检查发生在组装 profile 时，不在更新时。
- `dsh.bundle.patch` 指向 `cordis.patch.yml`，其 `insert` 行必须保留显式 `id`（匿名行在父配置
  重写后会重启）。
- 新增运行时文件必须同时进 `package.json` 的 `files` 与 `exports`：本仓库 `lib/` 就是发布物。

## 13.5 未决与假设

| 假设 | 若错会怎样 | 怎么验证 |
|---|---|---|
| 0.2.3 线只改了 `rpcGuard`，其余面不变 | 新宿主上某条链路静默降级 | 在 `0.2.3-alpha.2` 上跑一次 §3.5 四件套，台账行改 `真机` |
| `admit(req)` 接受 Node `IncomingMessage`（`headers`/`method`/`url`/`socket` 字段够用） | 守卫恒放行或恒拒绝 | 真机一次 `curl` 对照；用例只证明插件侧的探测顺序 |
| `sessionPersistence` 的公开读侧与 `readColdSessionLog` 内部实现一致 | 冷读退化成活视图 → 快照冻结 | `docs/troubleshooting.md` §3.29 的路线；**原 §6.1 的"补一个读适配器"待办已判定不必做** |
| 预设工具面在真机上的可见边界 | 整理 worker 少工具 | `docs/host-api.md` §6.8 |

## 13.6 运行时结构指纹

台账是人工记账，代码不读版本号（AGENTS.md §1 规则 1）。为了让「这台宿主实际走了哪条分支」可核对，
`getState()` 返回一个只读 `hostSurface` 块（`lib/host-surface.js`），内容就是 §13.2 各探测面在本次
装载中真正命中的形状，键与台账的指纹列一一对应：
`{ rpcGuard:'admit', schedule:'global', activation:'flat', coldLog:'session-query' }`。

用法：在真机上核对一行台账——指纹对不上，就是 §13.1 那行写错了，而不是宿主行为变了。
值全部来自既有探测函数（`requestRejectionOf` 的三级判断、`scheduleFlavor`、
`activationUsesFlatSpec`、`COLD_LOG_MODULES` 的命中项），本模块不做任何分支、不读版本号，
没探到的面显示 `unknown`。WebUI 的诊断页顶部环境自检卡把它与引擎/向量代际并列显示。

## 13.7 维护本文件

1. **新构建发布**：先跑 `docs/host-adaptation.md` §3.1–§3.5；然后在本表加一行（commit 用
   `git rev-parse --short <tag>^{commit}`，不要写 HEAD），核对方式据实填。
2. 逐面重读时只对 §13.2 已注册的面取证；证据命令是 `git show <tag>:<path>`，**不要用当前
   checkout 回答旧 tag 的问题**（§13.3 的两条误判就是这么来的）。
3. 只有出现**新的探测分支**才动 §13.2/§13.3；指纹没变的新构建只加一行台账。
4. 新增宿主面 = §13.2 一行 + §13.1 每行指纹补一个键 + 一条探测用例。
5. 废弃旧构建要连根删：台账行、矩阵里的形状、`package.json` 的 `dshReleases`、README 兼容段落
   一起清，不留"引用了不存在事实"的行。
6. `npm run check` 的 Gate 4 会拦：文档提到了没有台账行的构建、台账行缺证据等级、探测点符号
   被改名、代码里混进**带预发布号的宿主构建名**（裸 `0.2.0` 不算——本仓库里它是别的工件的版本，
   比如 tokenizers crate）、指纹引用了未注册的面ID、`package.json` 的 `dshReleases` 与台账不一致。
