# 记忆与提示词口径 — dsh-memu-memory

语义规范：分层、写入、注入、提示词管理。

## 8. 记忆与提示词口径

### 8.1 三层

`LAYERS = [long_term, short_term, must_remember]`（`lib/memory.js:33`），三层**都已实现**：

| 层 | 半衰 | 特点 |
|---|---|---|
| `short_term` | 1 天（`SHORT_TERM_HALF_LIFE_DAYS`） | 带到期日（`shortTermTtlHours` 默认 72），过期由 `cycle.js` 处理；可被 `privateUpdate` 晋升为 `long_term`（记 `promotedFrom`） |
| `long_term` | 常规半衰 | 主体 |
| `must_remember` | 365 天 + **0.35 强度地板** | 只来自用户明确要求、随机侧事件、极少数自我判断；软上限 `mustRememberCap` |

### 8.2 私有记忆的写入规则

- 主 agent 自己写；**不做「你是她的记忆」的二次人格**。`must_remember` **满了也不许为腾名额而 unpin**。
- 移出永久记忆 = **边缘化**：`marginalized=true`、`strength × 0.2`、`recallPenalty + 0.2`，**不删除**；条目仍在库里，`marginalReason` 在侧边栏可见（替代人类闸门的**事后**监督）。
- **unpin 由模型自己判断，侧边栏没有标记按钮、用户不参与。** 三重护栏：① `reason` 必填、第一人称、去空白后 ≥ 20 字符；② 每会话配额 `unpinBudgetPerSession`（默认 2）；③ 冷却 `unpinCooldownMinutes`（默认 3）。放行后记 `unpinnedBy: model`、`unpinnedAt`、`originalPinSource`（保留原 pinSource 以便复 pin）。
- 正当的 unpin 只有两种：想起它本身正在伤人；它已经不再是我的一部分。不正当的：inconvenient、不想面对、用户这轮没提、永久记忆快满了。**这个区别要写进提示词。**
- 矛盾检测：同库同题改写或说法相反 → 新条挂 `pending_review` + `reviewReason` + `conflictingWith`，**不进注入不进召回**，等 `listReviews` / `resolveReview` 裁决（§3.9）。

### 8.3 全局记忆

只有 curator 写，主 agent 只读。domain：`universal / coding / rp / project:<name> / tooling / personal`，**RP 与 coding 冲突分域存，不合并**。RP 剧情事实、关系进度、临时情绪**不写全局**；每条必须有 `evidence` + `confidence`。

### 8.4 注入

- 静态 guide 与动态记忆都走 plugin 消息；当前版本不再注册本插件的 system prompt 段。所有会话（含 `persona` `complete: true`）统一由 `lib/inject.js` 的 `ensureUnifiedGuide` 在**回合首步**投放一条 `<memory-guide rules="…">` 插件消息；`rulesKey` 由协议版本、domain 和实际渲染正文计算，domain/覆盖/默认稿变化或压缩丢失（`guideLost`）时在下一个合法首步替换，同一规则不逐回合重复。旧 binding 只有 `guideMessageAt`、没有 `guideRulesKey` 时视为旧版，补投一次；失败 fail-open，不写新版本。
- 首轮锚点 + 每用户回合最多一次；长工具回合仅有新的真实人类消息批次时追加一次，普通工具步骤不触发。私有优先、全局补充；冲突时私有胜。
- **`injectedIds` 只能记真正进入文本的条目**，否则从未展示的记忆被白白压制 8 轮。
- 锚点分段预算 pin 40% / core 30% / global 30%；pin 装不下时末尾明示「另有 N 条未展开」，**不静默丢弃**。
- 预算单位是**模型 token**不是字符：中文 ≈1 字符/token、英文 ≈3.4，一律走 `lib/budget.js`，**不要再用 `tokens * 3`**（英文口径，中文超支约 3 倍）。
- 压缩后下一条用户消息重注入锚点；子代理不注入。文件夹两开关都关 → 不注入（看 clamp 后生效值，不是 binding 原始值）。召回为空必须留信号（§1.10）。
- **召回排序的准确口径**：`privateWeighted` 只服务**私有召回流水线**（`privateRecall` 调用它）；全局召回（`globalRecall`）走 `localRecall`，不经过它。cue 会经 `cueRecall` **间接**调用 `privateRecall`，所以**不能**概括成「cue 不走私有排序」。排序里的心境项默认关闭——`privateWeighted` 自己的缺省上下文就是 `moodEnabled: false`，真正打开它的是 `privateRecall`，条件是 `|valence| ≥ MOOD_MIN_STRENGTH` 或 `|arousal − BASE_AROUSAL| ≥ 0.1`（`BASE_AROUSAL` 来自 `lib/mood.js`）；平缓对话里两项乘数恒为 1。`privateRecall` 的 topK 兜底是「传入 topK → `settings.privateTopK`（默认 5）→ 4」：引用 3 或 4 时必须说清是**设置默认值**还是**代码兜底值**，两个数不是同一个。
- **情绪模型（v3）**：一条记忆的情绪由四项构成 `joy / anger / sorrow / fear`（归一后和为 1）、强度 `arousal` 与掌控感 `dominance` 组成，`moodValence` 只是四轴在旧路径上的兼容投影。门控是三条**独立**条件的 OR：主导项 share ≥ 0.35、`|arousal − 0.35| ≥ 0.1`、`|dominance| ≥ 0.25`——「没有情绪构成」只关掉第一条，高唤起或明确的掌控感仍会打开排序项。双方都有合法 emotion 时用 overlap（各轴取较小值再求和）算一致性，任一侧缺失就回落到旧的 valence 路径；旧条目不从 valence 反推四轴。情绪只影响排序权重，不写进注入文本，也不进记忆正文。

### 8.5 提示词管理

- 默认稿在 `lib/prompts/*.md`（随包）；用户覆盖在 `~/.dsh/dsh-memu-memory/prompts/*.md`；`manifest.json` 记 `defaultHash / userHash / defaultUpdated`。运行时统一 `lib/prompts.js` 的 `loadPrompt(key, vars)` / `loadPromptForDomain(key, vars, domain)`，**业务代码里不许硬编码正文**。
- 规则消息每次首步重新渲染；`rulesKey` 只含版本、domain 和渲染后的正文，不含时间/回合，避免每轮不同。`private-policy` 模板保留供查阅和覆盖记录，但当前版本不再自动投放主会话；字段契约由工具 schema 与运行校验提供。
- 模板只做单趟 `{{variable}}` 替换，变量值里的 `{{` 不会被二次展开——所以把记忆正文当变量塞进模板是安全的。**改成多趟插值前先想清楚这点。**
- 恢复默认 = 只删用户覆盖；全部恢复 = 清空覆盖目录。升级后：无覆盖用新默认，有覆盖保留并标 `defaultUpdated`。
- 分层：**作用域 → 类型页 → 项**。类型页是数据（`settings.promptDomains`，默认 `[rp, coding, mixed]` 全启用；`domainOverride` 默认 `rp`），`general` 内置不可删。变体 `<name>.<domain>.md` 由 `resolveDef` 解析：domain 在列表内且变体文件存在（默认**或**覆盖目录）→ 用变体，否则回落基础稿。
- **职责分工**：`system-guide.*` 是唯一常驻规则，只写领域行为、检索时机、回答口径；`private-policy.*` 保留为字段规约参考，不再投放，避免两套常驻文本互相漂移。
- **只有三个 key 分域**：`system-guide`、`private-policy`、`private-consolidation`；`global-curator` 不分域。
- **远程与本地共用一份 `private-consolidation`**：正文讲「记什么、字段怎么填」，差异只有输出协议（`CONSOLIDATION_CONTRACTS.local` 调工具 / `.remote` 返回 JSON，代码追加）。不要拆第二份。
- RP 与 coding 是**内容**差异：coding 记事实（决定、约束、踩过的坑、工程偏好），召回当「可能过期的事实」，与代码冲突时以代码为准；rp 记经验（具体瞬间、半句原话、身体感觉、没说出口的话），允许模糊记错，不确定就标低 `confidence`。
- **KV cache**：section 文本随 domain 变，但同一会话内恒定，缓存不受影响；中途改 domain 会让该会话失效一次缓存。别在文档里写「文本恒定」。

### 8.6 可见范围只剩两档，它决定「自动浮现」而不是「谁能读」

- `shared`（默认）：库级，整个文件夹共用。`secret`：只是「不自动推给你」的开关，**不是保险箱**。
- 按通道分开看：

| 通道 | `shared` | `secret` |
|---|---|---|
| 每回合锚点 / pin / 纪念日 | ✅ | ❌ |
| 自动召回注入 | ✅ | ❌ |
| 随机回响 cue / 短期到期提示 | ✅ | ❌ |
| 模型主动 `memu_private_recall` | ✅ | ✅ |
| `memu_private_list` / 侧边栏 / 记忆墙 | ✅ | ✅ |
| 附件像素 | ✅ | ❌（`hidden: true`；`never_say` 的 caption 也不回显） |

- 所以 `secret` 的实际边界是「**不被自动注入、不当回响源、附件不出像素**」；同一文件夹里另一个会话**主动检索时照样能拿到**。它挡的是「自己冒出来」，不是「别人查到」。要「跨会话绝不外泄」，靠 §8.7 的上下文边界，不是 `secret`。
- 「只有我知道」= `disclosure: never_say`（不许说出口）+ `secret`（不许自动浮现）两个字段的组合，不是加密。侧边栏和记忆墙始终能看到正文——这是**事后监督**的设计，不是疏漏。
- 全局 curator 读的是会话日志与全局库，不读私有库条目（`compactGlobalIndex`），所以 `secret` 不会被复制进「每会话都注入」的全局记忆；跨文件夹（不同库）之间也读不到。

### 8.7 上下文作用域：`channelId / characterId / worldId / branchId` + `knownBy`

- 边界是这四个字段（`lib/context.js` 的 `BOUNDARIES`）；`speakerId` 只是身份标签，**不参与可见性**；`knownBy` 是「谁知道」的白名单，按当前 `characterId` 判。
- 会话侧是 `binding.memoryContext`（+ `sceneTime`），入口 RPC `setMemoryContext`（侧边栏「记忆上下文」表单，`lib/client.js` 的 `contextScope`）。**它不由宿主自动提供**：没填就是 `{}`，等于整个文件夹共享——两个会话都没填，它们在记忆层就是同一个上下文。
- 写端只能收紧：`{...binding.memoryContext, ...传入 context}`；改边界或放宽一律 `memory context cannot widen or change the bound conversation`（传空字符串也算放宽）。
- 读端严格相等：条目有某边界字段 → 必须等于当前会话同名字段；条目没有 → 不限制；`knownBy` 有值且不含当前角色 → 不可见。**宽会话看不到窄条目**（条目 `characterId=hero`、会话没设角色 → 不等 → 看不到）。
- **存储不按上下文分库**：一个文件夹 = 一个库 = `index/<libraryId>.json` 一个文件，所有上下文条目同库共存，靠每条 entry 的 `context` 字段区分、读取时过滤。于是「同群组不同角色」是同一个文件里 `characterId` 不同的两条，「不同群组同角色」是 `channelId` 不同的两条，互相都看不到。
- 去重与矛盾检测也按上下文分组（`sameFactContext` = 五个 IDENTITY 全等）：只有 context 完全一致才算「同一件事」；不同 `speakerId` 的同标题不算矛盾，不同世界/分支的两种说法可以并存。
- 记忆墙 `browseLibrary` 不带 session，显示整库——这是唯一能编辑「别处上下文」条目的通路，也是修可见范围的兜底入口。

### 8.8 `session` 级别已删除，老数据升级为 `shared`
- 曾经有第三档 `visibility: 'session'`：条目绑定写下它的那段对话，只有那段对话能召回。**它在三种状态下都错**：①会话还在——同文件夹的其它对话读不到，而「同文件夹共享」正是这个插件存在的理由；②会话被删——条目变成谁也读不到的孤儿（侧边栏空白、记忆凭空消失就是这么来的）；③想让人读到——模型只能改成 `shared`，于是「作用域」变成了一次性开关，而不是约束。真正需要「只给某个角色/某条世界线看」的场景由 §8.7 的 `context` 表达，那一维是可读、可审计、可放宽的。
- 升级：读到 `visibility: 'session'` 一律当 `shared`（`lib/visibility.js` 的 `migrateEntryVisibility`），**`context` 原封不动**——原本限定在某个角色/分支的条目，升级后仍然只有那个上下文看得到，丢掉的只是「哪段对话写的」这一维（以及 `sessionId` 字段）。标记 `migratedFromVisibility: 'session'` + `visibilityMigratedAt`，便于事后审计。
- 落在哪一层：`lib/state.js` 的 `loadPrivateIndex` 在读取时升级视图（所有读写都经过这里，消费者不必知道该级别存在），基线仍是磁盘原文，所以下一次普通写入就会把升级落盘；`lib/migrate.js` 的周期巡检与侧边栏轮询（60 秒节流）把没人再写的库也重写掉。
- 手工/一次性：`node scripts/migrate-visibility.mjs`（默认只报告，`--apply` 先 `backupDatabases()` 再写，`--json` 机器可读）。退出码 3 = 有老数据待转换，1 = 转换失败。
- 导入导出：老版本导出的 `session` 条目按 `shared` 导入（同 `migratedFromVisibility` 标记），报告里记在 `downgraded` 并写明「session -> shared，要收窄请补 context」——丢一条记忆比放宽一条更糟，但「读者从一段对话变成整个文件夹」必须让用户看得见。
- 工具面：`visibility` 只接受 `shared` / `secret`，传 `session` 会得到解释性报错（而不是静默降级）；面板下拉与中英文标签同步删掉了这一档。

### 8.9 空闲整理：什么时候跑，以及为什么可以什么都不写
- 触发：`settings.sleepConsolidation` 开着时，每 5 分钟扫一遍（`lib/cycle.js` 的 `runSleepPass`），挑「`lastTurnAt` 早于 `lastSleepAt` 且已经安静 ≥ `sleepAfterIdleMinutes`」的会话，交给 `requestPrivateConsolidation` 起一个 fork 去读转录、写记忆。**默认 3 分钟**（`lib/state.js` 的 `DEFAULT_SETTINGS`）；旧值 8/20 的安装保留原选择，只是新装默认更短。
- 应用启动后 8 秒补跑一次（`STARTUP_SWEEP_MS`），因为定时器只在应用开着时存在：一段对话如果是在应用关着的时候结束的，它永远等不到那个「空闲窗口」——用户一回来发消息，`lastTurnAt` 就被顶新了。补偿每次最多处理 **2 个**会话（`runSleepPass` 的 `limit`），按最近活动排序。
- **有新回合 ≠ 该写记忆。** 进 fork 之前先做两道本地评估（只看 `lastSleepSeq` 之后的转录）：① `assessConsolidationValue` 的硬门槛——没有任何人类消息（只有插件通知、工具结果、心跳）→ 跳过；只有一条**纯应答**（「谢谢」「好的」「ok」「收到」，且没有任何工具调用）→ 跳过。**这里刻意不按字数判断**：字数少的偏好句（「我不吃香菜」）比一千字的闲聊更该留，长度是坏代理。② `assessWake` 的加权分（`lib/active-memory.js`）：`H` 真人回合、`C` 真人文字 + 助手正文 + 去重后的成功工具结果（每个结果最多 2000 字符）、`U` 去重后的有效工具单元；`score = 0.35*min(H/3,2) + 0.45*min(C/4000,2) + 0.20*min(U/20,2)`，默认 `activeMemoryMinScore = 0.8`。空闲未到 `activeMemoryStarvationMinutes`（默认 15 分钟）时分数必须达标；到了饥饿阈值，**小于 2000 条事件的会话**无条件唤醒，**大 transcript 不吃饥饿豁免**——fork 的 seed 是整段前缀（真机 5913 条事件约 26MB），宿主虽然会压缩上下文，实测一次整理仍要约 4~22 万 input tokens（含缓存读，主要取决于记忆工具步数）；一个「继续」级薄回合只有 0.14~0.43 分，不能靠饥饿反复付这笔钱；大会话里的密集回合仍按分数正常触发。
- **近期触发过记忆就不 fork。** `runSleepPass` 先看 `suppressionReason`：距上次整理不足 `activeMemoryCooldownMinutes`（默认 0）或距上次**注入过记忆**不足 `activeMemoryRecallCooldownMinutes`（默认 15 分钟）→ 跳过并发 `check` 日志。被抑制或低分跳过的回合返回 `settled: false`，不推进 `lastSleepSeq`/`lastSleepAt`；下一轮扫描重新评估，等真正有密集新内容再整理。
- 评估通过但整理写了 0 条 = 正常成功（`lastSleepAt` 前移），不会每小时重来。整理日志额外记录 `scanned/fresh/index +N`（扫描多少事件、上次游标后新增多少、索引实际新增多少），`check` 日志记录 `score/reason/parts/空闲分钟/会话事件数`，用来区分「没触发、被门挡住、提取空转」。
- 会话被删：host 对 `readSession` 报 `session "…" not found`，这是**不变量**而不是瞬时故障。`runSleepPass` 一旦看到就把 binding 标 `sessionGone: true` 并清掉重试计数，此后直接跳过（以前会按 2 的幂退避、封顶 1 小时，永远重试）；同名会话后来真的收到新消息时（`lib/inbound.js`）会清掉这个标记。**"读不出来"不是"被删了"**：转录读失败（例如 `ENOENT`）由快照层显式标成可重试（`lib/consolidation-snapshot.js` 的 `failed()` → `retryable: true`），`runSleepPass` 只按退避重试、不打 `sessionGone`——`isGoneSessionError` 只认宿主那句 `session "…" not found` / `no such session`。
- 手动「整理这场对话」（RPC `generatePrivate`）带 `force: true`，跳过上面两道评估与抑制：用户已经决定了。

---

### 8.10 人格预设（agent preset）会话：注入要另挂，工具面按预设清单

预设会话的「模型可见插件集」不是 host composition，而是它自己那份 `cordis.yml`——整棵子树是独立 scope，`agent/pre-step` 只向自己的祖先冒泡，到不了部署级实例的监听器。所以预设会话最初的表现是「连 binding 都没有」，不是「写了没读到」。

插件侧的处理（`lib/preset-scope.js`）：每 10 秒枚举 `ctx.get('agents').list()`，沿 `agent.ctx.fiber` 往上找本插件的 fiber——找不到（= 不在自己这棵树里）才在该 agent 自己的 ctx（`lib/preset-scope.js:71` 取 `raw?.ctx || agent?.ctx || agents.get(sessionId)?.ctx`）上补挂 `registerInjection(actx, { guide: false, guideMessage: true })`（`lib/preset-scope.js:79`）。**首参必须是这个 agent 自己的 ctx**，不是部署级实例的 ctx，否则绑定与注入会挂错会话。`guide: false` 只表示**不注册 system prompt 的 guide 段**（预设未列本插件时没有 `memu_*` 工具；即便列了，`persona` 的 `complete: true` 也会丢弃该段），规则改由 `guideMessage: true` 用一次性消息投放，正文自带「工具列表里没有 `memu_*` 就忽略本段」。同树的正常会话跳过，避免注入两遍；agent 消失就卸载。

**提示词怎么办**：所有会话现在都走同一条消息路径，预设的 `complete: true` 不再造成投放差异；`ensureUnifiedGuide` 在回合首步追加 `<memory-guide rules="…">`，文末提示「工具列表里没有 `memu_*` 就忽略本段」。切域、改稿、默认稿升级和压缩丢失由 `rulesKey`/`guideLost` 处理；旧会话只有 `guideMessageAt` 时补投一次。

**边界要分三件事讲**：① **注入监听**——补挂到 agent 自己的 ctx 后，锚点与召回上下文能送达；② **guide 投放**——首步一条 `<memory-guide>` 消息，规则变化或压缩丢失时替换，不是每回合重复；正文自己声明「没有工具就忽略」；③ **最终工具面**——由该预设自己的 `cordis.yml` 清单与宿主 scope 决定，本插件**不能**从「有没有列上它」推断出一定有或一定没有。历史记录里曾出现过某些 RP 会话工具链含 `memu_private_*`，但 2026-10-29 复核无法把它归到本机 `yuike` bundle（该 bundle 未列本插件，且本机无 `agentPreset=yuike` 的真机会话），只能保留为未复核历史观察；**逐预设的真实工具名单仍须真机核实（W3）**，核实前不要写成「只有注入、没有工具」，也不要反过来写成「列上插件就一定可用」。真要在没有工具的会话里写记忆，进一次标准会话仍是最直接的办法——但如果该预设确实列了本插件且工具注册成功，记忆可以直接在那个会话里写。**不要为了这个去改别人的人格插件**：预设文件属于它的维护者，插件只能在自己的 scope 里做适配。

### 8.11 全局整理的间接输入边界

`startGlobalCuration` 不直接读私有 index：curator 输入里的 `existing_global_index` 来自 `compactGlobalIndex()`，只含全局条目（`archived` 被滤掉、`pending_review` 保留，正文截 600 字符）。但同一份输入还包含每个会话经 `condenseEvents`（`lib/curator.js:27`）压缩后的转录，这条是**内容级**通路，不按 `visibility` 过滤：

- 保留：`source.kind === 'user'` 的用户原话、助手正文、工具调用参数（截 300 字符）、工具结果正文（截 400 字符）。`memu_private_recall` 的 secret 条目正是从工具结果进入转录的，助手也可能在正文里转述它。
- 丢弃：所有插件消息（`source.kind` 不是 `user`），包括自动锚点与自动召回注入。原因是来源类型，**不是因为条目带 `secret`**；即便构造一条带 secret 的自动注入消息，它也止步于转录之前（`secret` 本身并不会自动注入，这不是一条生产通路）。
- 唯一的字符串过滤是 `redactSecrets`（`lib/paths.js`）：只遮 `sk-…`、`Bearer …`、`api_key=…`、URL 内嵌凭据这类**凭据形状**，不识别普通私密叙述，也不看 `visibility`；提交层同样只过这一道，不校验内容来源。

因此 **`secret` 不是保险箱**：能进入 curator prompt 的内容，理论上也能被模型抄进输出并落到全局 index。合成探针已证明到「输入通道存在」，未证明真实模型会照抄，也未证明真机发生过泄漏。本次**不新增**防泄漏、来源追踪或输入白名单，止于「探针 + 文档」；哪些层必须剥离什么、助手/用户转述如何处理、失败与重试是否同样拦截，属于强契约，留待用户决定后单独实施。

探针：`tests/curator-probe.test.mjs` 用六通道各自唯一的合成标记，逐层断言压缩转录 → 真实 curator prompt → 模拟输出 → 提交后的全局 index；只写 `os.tmpdir()` + `DSH_MEMU_HOME`，不读取真实私有库。

### 8.12 向量来源与受管召回（MemU 路径）

默认 `memoryBackend="agent"` 的有效路由是 `lexical`，不调用 embedding。启用向量库（`memoryBackend="api"`）后，`vectorSource="local"` 对应 `managed-local`，`vectorSource="api"` 对应 `remote-api`；API 来源也可配置 localhost 端点。两者复用 MemU 存储与检索，不维护平行向量数据库。`memoryMode`（`local` / `cloud`）仅保留 MemU 存储兼容语义，不是 embedding 开关，也不覆盖来源选择。旧 `hybridRecall` / `hybridRecallMode` 生产开关已移除。

总结生成与向量路由解耦：常规私有整理通过 Agent fork；显式远程总结动作调用配置的聊天端点，其产物同样经 `privateRemember` 提交。启用向量不自动启用远程总结；聊天/总结模型不参与召回重排，也不作为向量失败回退。

受管召回只在候选阶段把词法结果与 MemU semantic retrieve 结果按 RRF（k=60）融合：先按 `isMemoryEligible`、`visibleToSession`、自动召回的 `secret` 排除及 context/scope 过滤，再按 canonical id 去重与候选上限处理。显式与自动召回共用候选融合；`touchAccessMany` 仍只对显式召回执行。精确记忆 id 走直达路径，切库期间中止以避免混合两个库。

服务不可用时仅回退词法并保留可见错误信号；不暗切远端、不调用 LLM。真实 embedding 质量、延迟和跨模型收益仍需单独评测；W8（助手重复提示）已决定不做，结论与理由见 `AGENTS.md`。

模型下载、进度与 profile 切换/迁移已有实现，但真实模型/runtime 下载、原生推理及切换全链路在本轮仍未验证。candidate / `pending` artifact 不是可用制品，必须通过制品、校验与迁移门槛后才可进入可用/激活状态。

回归与管线测试：`tests/hybrid-recall.test.mjs` 仅保留 RRF、去重、稳定排序、资格过滤与候选上限等通用融合 helper 覆盖；managed vector 行为由 `tests/managed-memory.test.mjs` 覆盖。

---

