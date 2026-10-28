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

---
