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
- 移出永久记忆 = **边缘化**：`marginalized=true`、`strength × 0.2`、召回排序里 `marginalized` 乘以 0.35（`recallPenalty` 字段仅作历史记录，当前不参与排序），**不删除**；条目仍在库里，`marginalReason` 在侧边栏可见（替代人类闸门的**事后**监督）。
- **unpin 由模型自己判断，侧边栏没有标记按钮、用户不参与。** 三重护栏：① `reason` 必填、第一人称、去空白后 ≥ 20 字符；② 每会话配额 `unpinBudgetPerSession`（默认 2）；③ 冷却 `unpinCooldownMinutes`（默认 3）。放行后记 `unpinnedBy: model`、`unpinnedAt`、`originalPinSource`（保留原 pinSource 以便复 pin）。
- 正当的 unpin 只有两种：想起它本身正在伤人；它已经不再是我的一部分。不正当的：inconvenient、不想面对、用户这轮没提、永久记忆快满了。**这个区别要写进提示词。**
- 矛盾检测：同库同题改写或说法相反 → 新条挂 `pending_review` + `reviewReason` + `conflictingWith`，**不进注入不进召回**，等 `listReviews` / `resolveReview` 裁决（§3.9）。写入方显式用 `conflicts_with`（或同一显式 `fact_key` 再次写入）声明“同一事实的两个版本”时是例外：两条都保持 active、互指并成对召回，注入为冲突卡（§8.17）；明确取代用 `supersedes`。

### 8.3 全局记忆

只有 curator 写，主 agent 只读。domain：`universal / coding / rp / project:<name> / tooling / personal`，**RP 与 coding 冲突分域存，不合并**。RP 剧情事实、关系进度、临时情绪**不写全局**；每条必须有 `evidence` + `confidence`。

**审核模式（`curatorReviewMode`）**：`auto`（默认）= 有落地证据的提炼结果自动通过；`review-all` = 提炼产物一律进待复核。`conflict`（说法矛盾）与无证据的条目在任何模式下都进人审；rewrite 类操作（merge/supersede/absorb）在 auto 下风险 ≥0.70 也暂扣。每条都带 `reviewRisk/reviewRiskReasons` 供审计与复核排序。

**证据落地（grounding）**：evidence 的 quote 必须是本次策划所含会话转录的规范化子串（≥6 字，省略号分段校验，先脱敏）——模型编造的"原话"进不了库；未落地恒 pending 或不落库。

**全局关联（link）**：curator 可给两条全局记忆连边（`related/refines/supports`），note 必须含转录逐字引用；每端 ≤20 条、有向边防环、移除只删边不删记忆。前端只读展示，不支持手动全局关联。

**全局节点图**：WebUI 记忆墙 → 节点图 → 范围选择「全局记忆」。`getGraph({scope:'global'})` 读 `global.json` 的 `entries[id].links[]`：节点是全局条目（`kind:'global'`，单独配色），边是 `related/refines/supports`；`suppressed/expired` 条目隐藏，但指向已删除目标的那条边保留占位节点。全局视图只读，移除边仍在全局记忆列表里完成。它与私有节点图共用同一个 `getGraph` RPC，不新增方法。

**集合记忆（absorb）**：多条碎片合成一条集合记忆——合并稿 active、target superseded（absorbedInto）、sources archived（absorbedBy，**不删除**，可还原）；`absorbSnapshot` 支持一键撤销合并（人工改动过的条目拒绝撤销）；簇外重复 ≥0.90 的合并稿转人审。

### 8.4 注入

- 静态 guide 与动态记忆都走 plugin 消息；当前版本不再注册本插件的 system prompt 段。所有会话（含 `persona` `complete: true`）统一由 `lib/inject.js` 的 `ensureUnifiedGuide` 在**回合首步**投放一条 `<memory-guide rules="…">` 插件消息；`rulesKey` 由协议版本、domain 和实际渲染正文计算，domain/覆盖/默认稿变化或压缩丢失（`guideLost`）时在下一个合法首步替换，同一规则不逐回合重复。旧 binding 只有 `guideMessageAt`、没有 `guideRulesKey` 时视为旧版，补投一次；失败 fail-open，不写新版本。
- 首轮锚点 + 每用户回合最多一次；长工具回合仅有新的真实人类消息批次时追加一次，普通工具步骤不触发。私有优先、全局补充；冲突时私有胜。
- **锚点和本回合召回只放标题卡**（1.2.2）：`formatPrivateTitle` / `formatGlobalTitle` 输出 `[id]`、标题、`source`、owner、layer、日期/年龄、marginalized/open_loop、accuracy/uncertainty/disclosure 与附件计数，**不输出正文与附件 caption**。工具返回、记忆抽屉与浏览器仍是全文；要正文就按标题关键词或方括号里的 id 调 `memu_private_recall` / `memu_global_recall`。标题为空时回退正文前 40 字；`imagined` 等语义标签不能因为标题化而丢失。`never_say` 不进入自动注入面，`only_if_asked` 只在 boundary 查询里自动放行（§8.17）；显式召回仍可读两者。跨库召回开启时（§8.15），private 标题卡可能来自其它同领域库；id 仍全局唯一，按 id 取正文仍走 `memu_private_recall`，写入仍只落在当前库。
- **条件式时效提示（工单 D）**：本回合召回块已经生成后，若其中至少一条真正进入文本的条目带时间敏感信号——`salientDate` 是已过去的 `YYYY-MM-DD`（年度 `MM-DD` 不算）、标题/正文命中固定词表 `最新|最近|现在|目前|今年|版本|价格|天气|新闻|比分|汇率`、或 `updatedAt||createdAt` 距现在 ≥ `freshnessDays`（`owner=about_project` 的工程事实不算年龄）——且 `freshnessHint !== false`、用户文本长度 ≥ `minUserChars`，就在最后一个 `</memory-context>` 之后追加**一个** `<memory-freshness>` 块，N 为去重后的 stale 条数。提示与召回共用 `turnTokens` 预算：放不下就丢弃提示，召回本身仍成功（fail-open，计算异常只 `warn`）。它只说「若你的会话里有可用的搜索工具就先核实」，**不声称** `web_search` 一定存在（工具面不确定性见 `docs/host-api.md` §6.8），也不改 `<memory-guide>`/`rulesKey`。`freshnessDays` 默认 30，范围 `[1,3650]`；`freshnessHint` 默认开。
- **rule 是前言，不是页脚**：`buildAnchor` 先输出锚点头与 `[rule]`，再输出 private/global/short_term 各段；inbound 路径的锚点之后直接衔接 `<memory-context>`，中间不再隔一条规则。
- **`injectedIds` 只能记真正进入文本的条目**，否则从未展示的记忆被白白压制 8 轮。
- 锚点分段预算 pin 40% / core 30% / global 30%；pin 装不下时末尾明示「另有 N 条未展开」，**不静默丢弃**。1.2.2 移除了 core≤5 / global≤8 的预先切片：标题卡比正文短，条数应由预算打包器决定，而不是固定上限；`anchorTokens` / `turnTokens` / `injectionTotalTokens` 默认值不变，inbound 的 `floor(turnBudget/2)` 保留。
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
- **1.2.2 起整理稿负责标题质量**：title 按「只看标题就知道具体事实」写（8–40 字、具体关键词、集合稿覆盖全部来源），`global-curator` 同一口径。词典/关联的工具调用属于**本地工作流**：领域整理稿与远程 JSON 路径共用，因此不写 `memu_*` 工具名；领域稿只保留「可抽什么词」的差异，稳定复用的黑话/梗/术语先 `memu_lexicon_search` 再 `memu_lexicon_propose`、写完用 `memu_private_link_suggest` 裁决候选的工具流程只出现在 local worker brief。远程契约明确「没有工具」，title 长度同样是 8–40 字。
- RP 与 coding 是**内容**差异：coding 记事实（决定、约束、踩过的坑、工程偏好），召回当「可能过期的事实」，与代码冲突时以代码为准；rp 记经验（具体瞬间、半句原话、身体感觉、没说出口的话），允许模糊记错，不确定就标低 `confidence`。rp/mixed 同时收对方主动给出的**现实生活事实**（作息、行程、口味、健康、家人朋友、在忙的事）：`about_user` 平实短条（30–80 字），不需要「瞬间+影响」模板，剧情与现实条分开写、不互相合并；单次提及低 confidence 或 `short_term`，重复出现才升 `long_term`（`寒暄不留`的口径只拦寒暄本身，不拦寒暄里夹带的事实）。
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
- 「只有我知道」= `disclosure: never_say`（不进入任何自动注入面，显式召回仍可读）+ `secret`（不自动浮现、附件不出像素）两个字段的组合，不是加密。侧边栏和记忆墙始终能看到正文——这是**事后监督**的设计，不是疏漏。
- 全局 curator 读的是会话日志与全局库，不读私有库条目（`compactGlobalIndex`），所以 `secret` 不会被复制进「每会话都注入」的全局记忆；跨文件夹（不同库）之间的私有召回**默认隔离**，只有显式打开 `crossLibraryRecall` 才会合并同领域库，且只读——见 §8.15。

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
- 触发：`settings.sleepConsolidation` 开着时，每 5 分钟扫一遍（`lib/cycle.js` 的 `runSleepPass`）。候选有三条腿：① 空闲 ≥ `sleepAfterIdleMinutes`（**默认 2 分钟**，`lib/state.js` 的 `DEFAULT_SETTINGS`）；② **水位**——账本里 pending 积压 ≥ 200 事件，不依赖空闲；③ 新活动但水位不足时的**探针**（最多每 15 分钟一次，读转录并评估，不 fork）。排序是 backlog → idle → probe，扫描每次最多处理 **2 个**会话。
- 应用启动后 8 秒补跑一次（`STARTUP_SWEEP_MS`），因为定时器只在应用开着时存在：一段对话如果是在应用关着的时候结束的，它永远等不到那个「空闲窗口」——用户一回来发消息，`lastTurnAt` 就被顶新了。
- **有新回合 ≠ 该写记忆。** 进 fork 之前先做两道本地评估（只看 `lastSleepSeq` 之后的转录）：① `assessConsolidationValue` 的硬门槛——没有任何人类消息（只有插件通知、工具结果、心跳）→ 跳过；只有一条**纯应答**（「谢谢」「好的」「ok」「收到」，且没有任何工具调用）→ 跳过。**这里刻意不按字数判断**：字数少的偏好句（「我不吃香菜」）比一千字的闲聊更该留，长度是坏代理。② 水位优先级高于 `assessWake` 加权分：pending ≥ 200 事件或 ≥10 个真人回合直接整理；水位以下才走 `score = 0.35*min(H/3,2) + 0.45*min(C/4000,2) + 0.20*min(U/20,2)`（`H` 真人回合、`C` 真人文字 + 助手正文 + 去重工具结果、`U` 去重有效工具单元），默认 `activeMemoryMinScore = 0.8`、`activeMemoryStarvationMinutes = 15`。
- **每次只种一窗。** `requestPrivateConsolidation` 只把 `lastSleepSeq` 之后的增量切成一个 ≤500 事件、尾部对齐完整回合的窗口（`selectConsolidationWindow`）；种子经 `compactSeedEvents` 清噪：只留真人消息 / 助手正文 / 工具调用与结果，删 reasoning、`source.replayState`、`data.stream`、插件召回、`runtime-context`、`request/header` 等后台事件；工具结果截 1200 字、重复输出只留一份。窗口开头插一条 `[memory-catalog]` 已有记忆目录（最多 18 条：id + 标题 + layer + status），worker 用它合并/去重，不再为旧库重读历史。剩余事件留到下一次扫描，`lastSleepSeq` 只随对账回执前进。
- **近期触发过记忆就不 fork。** `runSleepPass` 先看 `suppressionReason`：距上次整理不足 `activeMemoryCooldownMinutes`（默认 0）或距上次**注入过记忆**不足 `activeMemoryRecallCooldownMinutes`（默认 15 分钟）→ 跳过并发 `check` 日志。探针/水位可绕过「刚注入过」这一条（它们先评估、不直接 fork）；被抑制或低分跳过的回合返回 `settled: false`，不推进 `lastSleepSeq`/`lastSleepAt`。
- **寒暄与无新事件是终态。** `small-talk` / `no-human-turn` / `no-new-events` 返回 `settled: true` 并写入 `lastSleepAt`，下一次真人消息到达前不再重扫同一段；政策跳过不计入 `ran`（没有 worker 回执）。
- **同一快照失败有上限（仅自动触发）。** `failJob` 按窗口 `snapshotHash` 记 `failures`；连续 2 次失败后下一次**自动**请求返回 `skipped: 'snapshot-failed'`（`settled: true`），不再重复付同一段的 fork 成本。手动整理（`force: true`）是明确的一次再决定，不受该上限约束；新事件也会改变哈希，让自动路径重新获得机会。
- 评估通过但整理写了 0 条 = 正常成功（`lastSleepAt` 前移），不会每小时重来。整理日志额外记录 `scanned/fresh/index +N`（`scanned` 现在是**这一窗**的事件数，`fresh` 是游标后的总增量）和 `remaining`（还余多少事件），`check` 日志记录 `score/reason/parts/空闲分钟/会话事件数/待整理事件数`。
- 会话被删：host 对 `readSession` 报 `session "…" not found`，这是**不变量**而不是瞬时故障。`runSleepPass` 一旦看到就把 binding 标 `sessionGone: true` 并清掉重试计数，此后直接跳过（以前会按 2 的幂退避、封顶 1 小时，永远重试）；同名会话后来真的收到新消息时（`lib/inbound.js`）会清掉这个标记。**"读不出来"不是"被删了"**：转录读失败（例如 `ENOENT`）由快照层显式标成可重试（`lib/consolidation-snapshot.js` 的 `failed()` → `retryable: true`），`runSleepPass` 只按退避重试、不打 `sessionGone`——`isGoneSessionError` 只认宿主那句 `session "…" not found` / `no such session`。
- 手动「整理这场对话」（RPC `generatePrivate`）带 `force: true`，跳过上面两道评估与抑制：用户已经决定了。若游标已经到末尾，手动整理只重查最后 ≤300 个事件，不再重放整段历史。
- **必写候选跨窗顺延。** 每窗本地抽 salience ≥3 的轮次（最多 8 条）作为必写清单；本窗没写进库的候选记入账本 `carry`，下一窗优先带 4 条、其余名额留给新候选。核验是纯本地 token 比对（日期命中或 ≥2 个有效 bigram），不额外调模型；最后一窗也会在同一份任务书里看到顺延候选，不需要为补写再开一次整窗 fork。

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

**语义召回缓存（1.2.7）**：`managedRecall` 的成功语义召回段被 `lib/recall-cache.js` 的进程内 LRU 缓存（max=256、TTL 120s）包住，命中直接复用融合结果，词面 localRecall 仍每轮计算。只缓存成功路径：`byId` 直达、local-fallback、带 `errors` 的降级结果一律不缓存（fail-open 信号不能被缓存吞掉）。缓存键含 `memoryRevision()`（state.js 的每次索引/状态落盘自增，自动覆盖 remember/update/整理提交/graph/迁移全部写路径）+ 向量代数 token + query/topK/libraryId/domain/sessionId/context/automatic，写记忆后下一轮键即变化、无 stale；跨进程写入靠 TTL 兜底（revision 是进程内的）。缓存自身故障按未命中处理并 `warn` 留痕（`stats()` 暴露 hits/misses/errors）。显式召回（`memu_private_recall`）命中率为 ~0 是正确行为：其 `touchAccess` 写会推进 revision 使键失效，accessCount 参与 decay 加成不能被缓存短路。

模型下载、进度与 profile 切换/迁移已有实现，但真实模型/runtime 下载、原生推理及切换全链路在本轮仍未验证。candidate / `pending` artifact 不是可用制品，必须通过制品、校验与迁移门槛后才可进入可用/激活状态。

回归与管线测试：`tests/hybrid-recall.test.mjs` 仅保留 RRF、去重、稳定排序、资格过滤与候选上限等通用融合 helper 覆盖；managed vector 行为由 `tests/managed-memory.test.mjs` 覆盖。

### 8.13 标题卡、词典生命周期与私有自动关联（1.2.2）

**标题卡与标题写作。** 锚点/召回的可见单位从正文改为标题卡，标题因此成为索引而不是装饰：提示词要求 8–40 字、含具体人名/物名/事件/结论关键词，禁止「一些事」「那段对话」「关于 XX 的事」；合并/吸收稿的标题要覆盖全部来源关键词。Lexicon 的注入行仍保留「term + ≤80 字短义」（不是裸词），因为词典的唯一价值是解释；UI 卡片也是 term 标题 + meaning 正文。

**词典生命周期。** 公开状态只有 `active` / `archived`：用户新建、模型 `memu_lexicon_propose`、curator 带证据抽取都直接 active；`archiveLexiconTerm` / `restoreLexiconTerm` 负责可逆退场，删除只属于管理面。`rejected` 只作为 legacy 墓碑/指纹留在数据里，UI、注入、检索与计数都看不到；`pending` 只作为旧版本迁移输入：新提案 → active（敏感 → archived），revision 草稿 → archived。敏感 trigger 的新建/修改只能由用户完成，模型/curator 得到 typed 拒绝；非用户修改普通 active 词条的敏感字段也直接拒绝，不再生成 pending revision。RPC 的 `lexiconReview` 已删除（方法数见 `docs/contributing.md` 的 rpc-method-count 标记）。**哪些词条进得来**是另一层：全局词典 + 同域跨库，见 §8.16。

**私有自动关联。** 整理结算后 `lib/private-links.js` 只做本地算法：同库、同 context/track、可见非 secret、标题共享稀有 name-like token、pairScore < 0.82 且无冲突时，建立 memory↔memory `relation` 并写 `source:'auto'`；≥2 条记忆共享该 token 时复用/创建实体枢纽（人物信号 → `person`，无信号的拉丁名保守 → `thing`，CJK 无信号或 kind 冲突 → 不确定候选）。高置信写库在算法侧完成；1.3.1 起整理 worker 不再接收 `link_suggest`，不确定候选只留在本地算法结果里，需要时由主会话用 `memu_private_link` 裁决；不另起整理、不重读转录。算法/写入失败只记 warn，不能让已经成功的整理失败；自动关联不改正文、不写向量、不删除，边可在关系图移除。worker 写工具为 remember/remember_batch/update，读工具为空（记忆目录与本地召回由插件在种子开头注入），但「有没有写能力」仍只由 remember/update 判定。

### 8.14 日期联动、到点唤醒与实体合并（1.2.3）

**未了之事与纪念日联动（工单 C）。** `[open loop]` 的常规腿不变：无日期的 `openLoop` 条目要静置满 `OPEN_LOOP_DAYS`（3 天）才提，且**提过一次就永久静默**（走 `injectedIds`）。新增的是过期日期腿：`salientDate` 是已过去的 `YYYY-MM-DD`、条目仍 `openLoop` 且 active 时，**不看 3 天门槛**直接进入候选，文案带上 `date=… 已经过了`，让模型能说清晚了多久而不是编时间。这条腿不受「提过即静默」约束，只受自己的提醒节奏约束：binding 记 `openLoopRemindedAt`（`entryId → ISO 时间戳`，判定时才换算成本地日历日比较），同一条每隔 `openLoopRemindDays`（默认 7，`[1,365]`）复提一次，同日不二提；90 天没再命中的记录会被清掉。每回合仍最多 1 条，优先级是「过期日期 → 常规」。同回合里纪念日块（`<memory-anniversary>` / `<memory-due>`）已经点过名的条目，作为 `excludeIds` 从两条腿都剔掉——且**只有 anniversary 文本真的进入消息才剔**，预算装不下时不该把未了之事一起沉默。到期当天的措辞升级（「今天就是日子」）在 `<memory-due>` 里完成，不新开块。闭环仍然只有用户能做：不自动检测承诺、不自动关闭，关闭走 `memu_private_update`。

**纪念日到点唤醒（工单 E，默认关闭）。** `settings.salientWake === 'schedule'` 时，整理周期里的 `runSalientWakePass` 会按**投递时区**（`salientWakeTimeZone`，留空跟随系统）扫描今天/明天命中的 salient date，给每个绑定会话通过宿主公开的 `ctx.schedule` 建一条一次性任务：标题 `memu:due:<sessionId>:<YYYY-MM-DD>`，`timing: { kind:'at', at:{date,time,time_zone} }`（时刻取 `salientWakeHour`，默认 `09:00`；时区留空跟随系统，非空必须是有效 IANA 区），`target: { kind:'session', sessionId }`。**日历日与「这一刻过去了吗」都按投递时区算**（`dayInZone` / `instantInZone`，用 `Intl` 取该时区墙上钟再换算绝对瞬间）：按机器墙钟算会在配置时区与系统时区不一致时排错一天，或把那个时区里还没到的时刻当成已过而静默不排。幂等靠 `schedule.list` 对账而不是往 binding 写任务 id：同名 active 任务跳过、paused 不动、ended 删除、已过时刻的当天槽位不补建。投递是 `agent.followup`，**会新开一整回合**，而本插件的注入管线只认 `source.kind==='user'` 的真实用户消息——所以那条回合拿不到锚点、召回和纪念日块，**唤醒 prompt 必须自带正文**（日期、升级措辞、`memu_private_recall` 指引、「已说过不要重复」）。宿主没有 schedule 服务、subagent 会话（`subagent_session`）、已归档会话（`invalid_rule`）都只记 `kind:'wake'` 的活动日志并跳过，不能让整个周期失败。边界：宿主进程必须活着；at-least-once 可能重复投递；用户手删任务下一轮会重建；任务在宿主的定时任务界面可见。真机验证前默认 `off`。

**实体主节点合并（工单 F）。** 同一记忆库里写法不同的实体（`林眠` / `林眠儿`）可以由用户合并到主节点。`suggestEntityMerges({libraryId})` 是纯读：同 `kind` 且「归一化后短方（≥2 字）被包含」或「短方 ≥3 字且编辑距离 ≤2」时给出 `{sourceId(短), targetId(长), reason}`，稳定排序、上限 20，**永不自动合并**。`mergeEntities({libraryId,targetId,sourceIds})` 在实体文件锁内一次完成：别名取并集（含来源实体的名字）并 cap 30（超出部分在返回值 `droppedAliases` 里报告，不静默丢）；私有索引里所有 `links[].to === sourceId` 改指 target，同 `(to, kind)` 冲突按既有替换规则去重；关系快照按端点对重键，与主节点侧冲突时**保留主节点侧**并计入 `relationships.conflicts`；来源实体删除后再 `pruneOrphanEntities` 兜底（主节点受保护）。合并**不删除任何记忆**，只改指向；活动日志记 `kind:'write' op:'entity-merge'`，失败留 warn。kind 不同的合并请求直接拒绝。WebUI 节点图页给出候选、两次点击确认、合并后回执（改指多少条链接、并入多少别名、丢了多少别名与冲突快照）。跨库、全局↔私有归并不做。

### 8.15 跨库召回（默认关闭）

`settings.crossLibraryRecall` 打开后，`privateRecall` 会把**同领域**的其它私有库候选合并进本次召回；自动召回（`buildRecall`）、`memu_private_recall`、`memu_private_list` 与侧栏私有列表走同一套作用域，因此一次开关同时覆盖它们。**词典走同一条作用域**（锚点摘要、本回合匹配、`memu_lexicon_search`）——见 §8.16。显式传 `libraryId` 的库浏览器（`browseLibrary` / 记忆浏览）仍只显示该库，否则“我正在看哪个库”就没有答案。

- **候选库资格**：该库至少有一个非整理 fork 的会话绑定，且绑定的 `domainOf()` 等于当前会话领域；文件夹策略 `useLibrary === false` 的库排除；归档库排除。当前绑定库**始终参与**，且它的条目不按 domain 过滤（保持旧行为）。
- **条目过滤**：其它库的条目若带 `domain` 必须等于当前领域；旧条目没有 `domain` 字段时，按「该库的绑定会话领域已匹配」放行。新写入的私有条目会带 `domain`（`privateRememberImpl` 从当前 binding 取）。
- **合并**：逐库候选用 RRF（k=60）合并，每个命中保留 `libraryId`；`retrievalScore` 由跨库 RRF 归一化，保证后续心境/衰减排序仍以跨库结果为先验。`touchAccessMany` 与 `stats` 按命中所在库分组，不再全部记到当前库。
- **边界不变**：`visibleToSession` 仍按当前会话的 `memoryContext` 过滤；`secret` 在自动召回里仍被排除，显式召回仍可读；`knownBy` 规则不变。
- **只读**：`memu_private_update` / `memu_private_archive` / `memu_private_delete` 仍只解析当前绑定库。跨库命中在工具结果里标 `library=…（跨库只读；写入仍落在当前库）`，避免把「unknown memory」误读成「已被删除」。
- **单库不换路**：只有一个候选库时走原路径，结果形状与旧版一致；只有真正存在第二个合格库时才返回 `recallRoute: 'cross-library'` 与 `libraries`。

---

### 8.16 词典作用域：全局词典与同域跨库

词典与记忆是两条链（锚点摘要 / B 通道匹配 / `memu_lexicon_search` 对 `privateRecall`），但「这个会话看得见哪些词条」必须与 §8.15 同一个答案，否则同一个开关下记忆跨文件夹、词典不跨，用户读到的是半套同步。作用域由 `lib/lexicon-scope.js` 一处回答，三份数据、三套过滤：

- **当前绑定库**：主源。条目**不**按 domain 过滤（保持旧行为），也是模型与整理链路**唯一**的写入目标。
- **全局词典**：`data/lexicon/global.json`，保留存储名 `global`（`lexicon.GLOBAL_LEXICON_ID`；私有库 id 恒为 `lib_<hex>`，撞不上）。与全局记忆同构——每个会话都读得到，**只有用户能写**：全局 curator 见到词典 op 一律拒绝（§8.3），`memu_lexicon_propose` 没有全局路径。开关是 `useGlobal`（文件夹 + 会话两层天花板），与 `crossLibraryRecall` 无关；私有记忆整个关掉时，这一页仍只剩全局词典可读。条目过滤复用 `appliesToDomain`：`universal` / `personal` 恒可见，写了别的领域的词条只在那个领域可见，**没有 domain 的词条按通用处理**（全局词典由用户手写，不戳领域）。
- **同域其它库**：只有 `crossLibraryRecall === true` 才进候选，资格判定直接复用 `memory.js` 的 `crossLibrarySources`（同领域、非整理 fork、文件夹没关私有记忆、未归档），条目再按 `entry.domain` 过滤——与 §8.15「旧条目没有 domain 时随库放行」同口径。新词条落 `domain`：`memu_lexicon_propose` 恒打当前会话领域；RPC `lexiconAdd` 只在带 `sessionId` 且写私有库时打，写全局词典不打。

**合并与优先级**：源序 = 当前库 → 同域库 → 全局（「私有优先、全局补充」）。同一个规范词面只保留第一份，所以全局词典与私有库撞词时私有解释胜出，注入里一行不重复。B 通道的跨源命中用词典核心的 `rankLexiconHits` 重排——排序尺子仍只有那一把，合并方不自定顺序。只有一个来源时不去重（一本词典内部允许同词面跨 scope 共存），保持旧行为。

**计数落库**：candidate / injection 按词条所属词典分组落账，同 §8.15 的 `touchAccessMany` 分组一个道理——跨库命中不把热度全记到当前库，否则那本库的频率先验永远读不到真实使用。冷却按会话记，与来源无关。

**只读边界**：`lexiconUpdate` / `Delete` / `Archive` / `Restore` 与 `memu_lexicon_propose` 只作用于显式选中的那一本；`memu_lexicon_search` 给外来命中标 `home=…（跨库只读；写入仍落在当前库）`，全局命中标 `home=全局词典`。词典页是**浏览面**：选一本看一本（与记忆浏览器、与 `browseLibrary` 一致），合并只发生在注入与模型检索；页顶的口径说明就是为这句差异写的。RPC 层 `lexiconSearch` 不带 `libraryId` 时是会话视角（跨源），带 `libraryId`（含传 `global`）时只看那一本。

**坏一本不塌整段**：辅源（同域库、全局词典）读失败只降级成 `errors`，锚点与匹配照常出；主源读失败继续抛，由调用方按 §1-规则 10 记 `logger.warn` + `lastRecallError`。`errors` 非空时才多带这一个字段——没有降级时返回体与单库时代逐字节一致。

守卫：`tests/lexicon-scope.test.mjs`（源序、`useGlobal`/`useLibrary` 天花板、条目级 domain、`appliesToDomain`、词面去重、计数落库、辅源降级、主源抛错、备份同权、只读标注）；`tests/lexicon-ui.test.mjs`（全局 id 前后端同拼法）。

---


---

### 8.17 1.2.8：时间、版本、来源、承诺与召回意图

这一节只描述新增字段与策略，不改原有三层、可见范围与注入纪律。所有字段对旧数据都是**可选**：缺字段按空处理，不强制迁移，写入时补齐。

**时间**：写入时按这一轮的逻辑时间解析相对日期，落在 `event_time` / `observed_at`（ISO）、`absolute_date`（YYYY-MM-DD）、`date_precision`（`day|month|year|unknown`）、`date_source`（`explicit|relative`）。逻辑时间优先 `context.occurredAt`，其次会话 `sceneTime`，最后才是墙上时钟；解析失败不猜，只有确实出现相对时间词时才标 `date_precision=unknown`。原文保留在 `content`，不改写用户原话。`valid_from` / `valid_to` 是可选的有效窗口（`valid_from <= 今天 <= valid_to`），缺字段的旧条目照常召回；旧复核路径写的 `validFrom/validTo` 也会被识别。召回查询里的“明天/下周三/月底”同样先解析成绝对日期再检索，时间题注入按 `absolute_date` 最近优先排序。

**版本与冲突**：每条新记忆都有 `fact_key`（显式传入或由 `owner + 标题` 归一化）与 `version`。显式 `conflicts_with` 或“同一显式 fact_key 的再次写入”会让新旧两条都保持 `active`、互指 `conflicts_with`，召回命中一侧时另一侧成对带回，注入成一张 200 字内的冲突卡（“未确认哪版为准”）。显式 `supersedes` 才是取代：旧条 `status=superseded`、`valid_to` 落日期、正文与标题不删不改。兼容补充仍走 `memu_private_update`，保留原 id，不增加版本。旧的无关系字段的冲突仍按原路径进入 `pending_review`，行为不变。

**来源**：新增 `speaker_id`、`source_kind`（`user_said|assistant_said|told|imagined|inferred|tool`）、`quote_span`（`{seq, turn, textHash}`）、`storyline_id`、`branch_id`、`known_by`。`speaker_id` 显式 > `context.speakerId` > 按 `source_kind` 的 `user/assistant/tool/unknown`；不猜。助手自己的承诺、计划、事实用 `assistant_said`，不能记成用户说的。查询“我说过/你说过/他说的”时按说话人过滤：只排除明确属于别人的条目，缺 speaker 的旧条目保留。注入标题卡会显示非默认的 `speaker=`。

**承诺**：`commitment = {counterparty, action, due_at, status, closed_by, evidence_seq}`，`status` 是 `open|done|cancelled|expired`，也是权威；`open_loop` 只做兼容并随 `status` 同步。`open_loop=true` 的旧写法会派生一条 `open` 承诺，`due_at` 取本轮已解析日期。到期/临期（逾期、今天、明天）的未完成承诺最多 3 条、按 `due_at` 升序进一张 `[commitment]` 小卡；远期承诺不占每回合预算。`dueOpenLoops` 也优先看 `commitment.status` 与 `due_at`。

**召回意图**：`lib/text-retrieval.js` 的 `detectQueryIntent` / `decomposeQuery` 把查询分成 `date|entity|conflict|commitment|boundary|general`；日期与引号/`@`/已知实体名会被拆成可检索词。各意图的候选上限见 `lib/budget.js` 的 `RECALL_INTENT_TOPK`（general 5、date/entity 8、conflict 6、commitment/boundary 5），调用方显式给的更大 topK 不被压低，封顶 20。命中条目沿 `links` 扩展一跳（最多 2 条，实体题 3 条），只沿显式关系走。`disclosure` 现在是“何时能自动出现”的门：`never_say` 不进任何自动注入面（锚点、自动召回、提醒），`only_if_asked` 只在 `boundary` 意图的查询里自动放行；显式 `memu_private_recall` 仍可读两者。

**可观测性**：`getState` 增加 `recallCache` 段（`hits/misses/evictions/errors/staleSkipped/generations/...`）；`staleSkipped` 统计 TTL 过期、代数清理与按 query 失效时被丢弃的缓存条目。

守卫：`tests/temporal.test.mjs`、`tests/memory-fields.test.mjs`、`tests/fact-version.test.mjs`、`tests/inject-conflict.test.mjs`、`tests/speaker-provenance.test.mjs`、`tests/commitment.test.mjs`、`tests/query-decompose.test.mjs`、`tests/recall-intent.test.mjs`、`tests/injection-intent-budget.test.mjs`、`tests/memory-chain.test.mjs`。
