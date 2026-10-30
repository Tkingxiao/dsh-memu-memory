# 绑定生命周期 — dsh-memu-memory

> 本文对应 W9 只读诊断。实现：`lib/binding-diagnostics.js`；CLI：`scripts/diagnose-bindings.mjs`；测试：`tests/binding-diagnostics.test.mjs`。诊断只读取磁盘上的持久层，不创建、不修复、不删除、不 GC、不写回。

## 12. 绑定生命周期

### 12.1 三层状态：哪些在磁盘上，哪些只在进程里

一个会话的记忆状态分成三层。只有第一层能被另一个进程从磁盘读到，后两层由运行中的插件进程持有；诊断报告把后两层明确标成不可观察，而不是猜成 0。

| 层 | 内容 | 生命周期 | 诊断可见性 |
|---|---|---|---|
| 1. 持久绑定 | `state.json` 的 `sessions[sessionId]`：`scopeKey`、`libraryId`、开关、`memoryContext`、`inbound.pending/seen/claimed/clock`、`sleepRetryAt`、注入标记等 | 跨重启、fork、插件重载保留；只有显式状态写入才改变 | 只读快照可读；报告的核心对象 |
| 2. 运行时监听器 | `lib/preset-scope.js:19` 的 `attachments`，按 **agent context 对象** 键控 | 随 context 存在；context 被替换时旧监听器应释放，下一次 attach 重新挂载 | 跨进程不可读，声明为 `runtime-listener` |
| 3. 临时映射/缓存 | `lib/inbound.js:12-14` 的 `mediaJobs`/`calls`/`sessions`、`lib/media.js:19` 的 `captures`、`lib/private.js:213` 的 `inFlight`、`lib/curator.js:11` 的 `jobs`、`lib/state.js:938` 的 `indexCache`、`lib/paths.js:52` 的 `readFailures` | 随 promise settle、turn/end、session/disposed、下一次成功读取或下一次加载清理 | 跨进程不可读，声明为 `temporary-map` 或 `cache` |

**三层不混算。** `summary.bindings`、`summary.inbound`、`summary.unfinished` 只统计持久绑定；`summary.runtime` 只在调用方提供了进程内快照时出现，分别是 `runtimeListeners` 和 `temporaryMaps` 的合计。runtime 计数不会加进 binding 数，也不会把“持久层零候选”解释成“运行时没有残留”。同一份 state 在提供/不提供 runtime 快照时，`bindings` 与 `candidates` 必须完全一致。

`RUNTIME_STATE` 里的 `file:line` 是诊断契约的一部分。测试会逐条打开源文件、检查对应行确实声明了该名字；源文件移动后必须同步更新 `RUNTIME_STATE`，否则测试直接失败，避免报告印出过期位置。

### 12.2 生命周期各阶段

- **首次绑定**：会话第一次进入记忆流程时创建 `sessions[sessionId]`。同一 `sessionId` 重连只复用这一条绑定，不按标题、不按 agent 实例、不按时间新建。文件级重复读取也必须幂等：同一 `state.json` 连续诊断两次，`bindings` 与 `candidates` 相同，字节和 mtime 不变。
- **开关打开但还没有库**：`useLibrary: true` 且 `libraryId: null` 本身不是故障。文件夹没有库时，注入路径用 `createLibrary: false` 延迟创建，这是文档化的形状。只有快照里存在“完成过注入”的证据（`injectedIds` 非空或 `lastInjectedTurn > 0`）时，才把 `library-enabled-but-unbound` 作为候选；否则只计入 `unbound-basis-unknown` 未知项，不虚增候选。
- **ctx 替换**：agent context 被替换只影响第 2 层监听器，不应改写 `sessions[sessionId]`。替换前后持久绑定的 `bindings`、队列、作用域和候选必须相同；变化只出现在 runtime 的 `presetAttachments` 计数上。
- **同标题不同 id**：标题只是标签，`sessionId` 才是身份。两个会话可以标题完全相同但一个是已绑定、一个是未绑定；`sameTitleGroups` 会把它们放在同一组，给出 `bound` 数量、各自的 `libraries`（未绑定位置为 `null`）、`mergeable: false`、`identity: "sessionId"`，并且从不输出标题原文。诊断不会因为标题相同就合并、复制或删除绑定。
- **预设消失又出现**：`agents` 是活 agent 视图，只能证明“在场”，不能证明“缺席”。预设从列表消失时 `host.status` 变为 `partial`（或 `not-loaded`），`host-session-missing` 被扣住；绑定、作用域和待注入队列原样保留。预设回来时仍是同一条绑定，不产生重复。
- **删除会话**：睡眠整理报告会话已删除时，绑定保留并打上 `sessionGone`。这是“保留以便恢复”的标记，不是删除指令。若宿主会话注册表同时权威地不列出该 id，会额外出现 `host-session-missing`；它是两个独立事实，和 `pending-inbound` 可以同时存在。作用域、`libraryId`、待注入消息都不因删除标记而丢失。
- **恢复会话**：同一 `sessionId` 恢复后，`sessionGone` 应为 `false`，绑定继续使用原来的库、作用域和队列；诊断只观察这个状态，不负责清除标记，也不写回。恢复后的候选只剩仍然存在的独立事实（例如队列里的待注入消息）。
- **宿主查询失败**：`host` 缺失、`not-loaded`、`partial`、空权威列表、活 agent 列表或未知来源都不能推出“会话不存在”。报告保留全部绑定、`libraryId`、`memoryContext.scopeKeys`、`inbound.pending`，只增加 `host-unavailable`/`host-not-loaded`/`host-partial` 等未知项，绝不下发 `host-session-missing` 删除信号。
- **库指针异常**：`libraryId` 指向不存在的库时报告 `library-missing`，但不改写指针；库被归档时报告 `library-archived`，但归档库仍在磁盘上，不等于可以解绑。

### 12.3 诊断字段

`diagnoseBindings()` 返回一个 JSON-safe 报告：

| 字段 | 含义 |
|---|---|
| `schema` | `dsh-memu-memory/binding-diagnostics@1` |
| `generatedAt` | 报告生成时刻（由 `now` 决定，便于测试） |
| `readOnly` / `mode` | 固定 `true` / `report-only` |
| `refusals` | 明确拒绝的动作：`gc`、`delete-binding`、`delete-session`、`delete-library`、`write-state` 等 |
| `thresholds` | `{ idleInspectionDays: 30, idleIsDeletionTrigger: false }` |
| `state` | 快照文件 `file`、`status`（ok/missing/corrupt/unreadable）、`bytes`、`mtimeMs`、`sha256` |
| `analysis` | 文件不可读时为 `null`；可读时为下面的分析对象 |
| `unknowns` | 不可观察或不可判定的项，带 `code`、`detail`、`keeps` |
| `readOnlyProof` | 读取前后的 sha256、字节数、mtime 对比和 `unchanged` |

`analysis.summary` 的计数：`bindings`、`host`（status/source/complete/sessions/unboundHostSessions）、`switches`、`libraries`、`memoryContext`、`guide`、`inbound`、`sleep`、`unfinished`、`runtime`（无进程内快照时为 `null`）、`candidates`、`sameTitleGroups`。

每个 `analysis.bindings[]`（由 `bindingFacts` 产生）包含：`sessionId`、`switches`、`effective`、`folder`（仅 `scopeKeyHash`，不含路径）、`domain`、`library`、`memoryContext`（仅 `present` 和 `scopeKeys`）、`guide`、`inbound`、`sleep`、`recall`、`injection`、`activity`。`activity` 同时给出精确的 `idleMs` 和仅用于展示的 `idleDays`（四舍五入到 1 位小数）。默认不输出错误原文；`--redact` 时连 session id 也做伪名化，标题和文件夹路径从不输出。

每个候选形如 `{ sessionId, kind, inspectionOnly: true, action: "inspect", reason, evidence }`。候选种类包括 `session-gone`、`host-session-missing`、`library-missing`、`library-archived`、`library-enabled-but-unbound`、`pending-inbound`、`sleep-retry`、`recall-degraded`、`reinject-pending`、`idle-inspection`。**候选是“请人工看一眼”的提示，不是删除队列。**

`analysis.runtime`：调用方提供进程内快照时为 `{ status: "provided", source, layers }`；未提供时为 `{ status: "unknown", reason, layers }`，其中 `layers` 仍列出 `RUNTIME_STATE` 声明的层，但不含任何进程内计数。

### 12.4 30 天阈值：检查线，不是删除触发器

`INSPECTION_DAYS = 30`。只有 `activity.idleMs > 30 * 24 * 60 * 60 * 1000` 才产生 `idle-inspection` 候选；**恰好 30 天不报，超过 1 毫秒才报**。判定使用精确毫秒 `idleMs`，`idleDays` 只用于展示，不能反过来参与比较。

这条线只回答“要不要人工检查”。它不会：

- 删除会话、绑定、记忆或库；
- 自动解绑或清空待注入队列；
- 重置 `sleepRetryAt`、`lastTurnAt` 或其他时间戳；
- 触发 GC、flush、mark-injected 或任何状态写入。

报告的 `thresholds.idleIsDeletionTrigger` 固定为 `false`，`REFUSALS` 固定包含 `gc` 与各类删除动作。即使报告里出现 `idle-inspection`，也只是提示。

### 12.5 自动 GC 必须另行确认

W9 的交付范围是只读诊断，**不包含自动 GC**。将来若要做自动回收，必须作为独立工作包另行获得用户确认，并至少满足：

1. 宿主权威确认目标会话确实已删除，而不是仅凭标题、超时或本地快照推断；
2. 有可恢复的备份，且备份本身不被同一次清理覆盖；
3. 在事务中重读最新状态、重新校验绑定与队列，避免用过期快照删除新数据；
4. 留下可审计记录，说明删了什么、依据是什么、如何恢复；
5. 永不删除记忆库本身，永不丢失 `inbound.pending`，恢复会话时永不丢失作用域。

在这些条件满足前，诊断报告只做候选标记；任何“清理”“解绑”“删库”都需要用户显式操作。

### 12.6 CLI 与只读证据

```bash
node scripts/diagnose-bindings.mjs --state <state.json> [--json] [--redact] [--now <ISO>]
```

退出码：

| 码 | 含义 |
|---|---|
| 0 | 成功生成报告，没有检查候选 |
| 1 | 成功生成报告，有检查候选（仍只是提示，没有改动任何东西） |
| 2 | 用法错误（未知参数、非法 `--now`） |
| 3 | 没有报告：state.json 缺失、损坏或不可读；没有创建目录、没有修复文件 |

CLI 只写 stdout/stderr。它不创建父目录，不创建缺失的 `state.json`，不隔离损坏文件，不更新时间戳；文本报告会打印 `readOnlyProof`。测试覆盖 0/1/2/3 四种退出码、缺失路径不建目录、已有文件字节与 mtime 不变。

`readBindingSnapshot()` 直接 `fs.readFileSync`，不调用会修复文件的 `loadState()`；`diagnoseBindings()` 在分析后再哈希一次并比较 mtime，形成 `readOnlyProof`。缺失或损坏时 `analysis` 为 `null`，报告只说明状态并保持现场。
