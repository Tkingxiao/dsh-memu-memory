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

- 静态 guide 在 system prompt（按 domain 选变体）；动态记忆走 plugin 消息。
- 首轮锚点 + 每用户回合最多一次；长工具回合仅有新的真实人类消息批次时追加一次，普通工具步骤不触发。私有优先、全局补充；冲突时私有胜。
- **`injectedIds` 只能记真正进入文本的条目**，否则从未展示的记忆被白白压制 8 轮。
- 锚点分段预算 pin 40% / core 30% / global 30%；pin 装不下时末尾明示「另有 N 条未展开」，**不静默丢弃**。
- 预算单位是**模型 token**不是字符：中文 ≈1 字符/token、英文 ≈3.4，一律走 `lib/budget.js`，**不要再用 `tokens * 3`**（英文口径，中文超支约 3 倍）。
- 压缩后下一条用户消息重注入锚点；子代理不注入。文件夹两开关都关 → 不注入（看 clamp 后生效值，不是 binding 原始值）。召回为空必须留信号（§1.10）。

### 8.5 提示词管理

- 默认稿在 `lib/prompts/*.md`（随包）；用户覆盖在 `~/.dsh/dsh-memu-memory/prompts/*.md`；`manifest.json` 记 `defaultHash / userHash / defaultUpdated`。运行时统一 `lib/prompts.js` 的 `loadPrompt(key, vars)` / `loadPromptForDomain(key, vars, domain)`，**业务代码里不许硬编码正文**。
- system prompt 的 section `text` 必须是函数（每次装配重读文件，保存后下一轮生效）且**整体包 try/catch**（§3.7）。
- 模板只做单趟 `{{variable}}` 替换，变量值里的 `{{` 不会被二次展开——所以把记忆正文当变量塞进模板是安全的。**改成多趟插值前先想清楚这点。**
- 恢复默认 = 只删用户覆盖；全部恢复 = 清空覆盖目录。升级后：无覆盖用新默认，有覆盖保留并标 `defaultUpdated`。
- 分层：**作用域 → 类型页 → 项**。类型页是数据（`settings.promptDomains`，默认 `[rp, coding, mixed]` 全启用；`domainOverride` 默认 `rp`），`general` 内置不可删。变体 `<name>.<domain>.md` 由 `resolveDef` 解析：domain 在列表内且变体文件存在（默认**或**覆盖目录）→ 用变体，否则回落基础稿。
- **职责分工**：`system-guide.*` 只写领域行为、检索时机、回答口径；字段定义、层级、复核、预算、unpin 只写在 `private-policy.*`。同一规则不要两份都写——重复撑长常驻提示词，改一处还留下另一半旧口径。
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

---
