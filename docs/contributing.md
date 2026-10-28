# 改动与扩展 — dsh-memu-memory

改现有行为、加新东西、提交前自检时读这一份。排错 → `docs/troubleshooting.md`。

## 4. 改动流程（修改现有行为）

### 4.1 四步

1. **定位链路**：先用 §2.2 那条链找到「这个行为在哪一步决定」，再读那个函数，不要从 UI 往下猜。
2. **最小改动**：一次只改一个语义，schema/文案/UI 不混在一个提交里——出了事无法二分。
3. **三层验证**（§4.2）：语法 → 针对性单测 → 全量 + 验收 + 自检。**只跑自己新写的测试不够**，这个仓库多数回归是被别的文件抓到的。
4. **同步文档**（§4.4）。文档与代码不一致本身就是缺陷：读者照文档做就会出现「做了却不对」。

### 4.2 验证三件套

```bash
node --check lib/<改过的文件>.js     # 语法（源码是 ESM，别用 require 试）
npm test                             # 全量；真实引擎用例默认跳过
node scripts/acceptance-local.mjs    # 50/50；视觉证据只证明本次已审查，UI 改动仍须重新看图
npm run check                        # node --check + i18n 键对齐 + package.json 可解析
```

**结果口径**：以 `node --test` 输出的 `ℹ tests / pass / fail / skipped` 为准。用例数变了先问「是不是我加的」，失败先问「是不是并发写了同一个库」——这仓库真会多个会话同时改它。

### 4.3 每类改动的连带清单

| 改什么 | 必须一起看 | 覆盖它的测试 |
|---|---|---|
| 注入内容/顺序 | `budget.js` 换算、`injectedIds` 只在真正进文本后记、fail-open 信号 | `inject`、`snippet`、`appendix-b*` |
| 记忆字段/语义 | `checkEnums`、`privateRemember` 默认值、`decayStrength`/`recallScore`、旧条迁移 | `memory`、`humanlike`、`appendix-b*` |
| 更新侧/纠正入口 | `privateUpdate` 允许字段、`updateMemory` 的 `allowed`（未知键报错）、`tools.js` schema、`accuracy` 重算、`layer` 重复设置 | `update-fields`、`browser` |
| 工具入参/输出 | schema 描述（模型只看它）、`formatPrivateItem` 截断、错误码 | `tools` |
| RPC 方法 | `lib/rpc.js` case、客户端 `call()`（验收 G-2 逐个核对） | `storage`、`browser`、`sidebar*` |
| UI 任何东西 | §7 全部约定、zh/en 两字典、`renderXxxItem` 拆分 | `client-render`、`webui`、`new-session-gate` |
| 提示词正文 | 各类型页变体、`{{变量}}` 是否都在 vars、`files` 白名单 | `prompts` |
| 引擎/安装 | Python 顺序、镜像顺序、prune 白名单、备份内容、切换回滚 | `engine`、`backup` |
| 设置项 | `DEFAULT_SETTINGS`、设置页控件、WebUI `settingRow`、反面语义 `invert`、`memoryStamp` 覆盖 | `state`、`config`、`sidebar-beat` |
| 统计计数 | `bumpStats` 调用点（只有语义动作能加）、90 天裁剪、零值与降级、`getStats` 不建库 | `stats`、`client-render` |

### 4.4 文档同步规则

| 改动类别 | 要更新的文档 |
|---|---|
| 任何行为变化 | `README.md` 的能力/限制段（写「谁受益」不写「改了哪个函数」）+ `docs/troubleshooting.md` §3 对应小节的「会坏在哪」 |
| 设计决策 / 取舍 | `README.md` 限制段 + `docs/memory-semantics.md` §8（**只写为什么，不写施工流水**） |
| 影响验收方式 | 能自动化的进 `scripts/acceptance-local.mjs`，行为级的进 `tests/`；都进不了说明还没想清楚 |
| 新增能力 / 数据结构 | `README.md` 能力表 + `tests/` 或验收脚本 |
| 新的失效信号 | `docs/troubleshooting.md` §3 对应小节（补症状、落点或守卫）+ 文件开头的症状速查表加一行 |
| 改动硬规则本身 | `AGENTS.md` §1（精简）与 `docs/troubleshooting.md` 附录 E（全文）必须同改；G-1 会对比两边，AGENTS.md 另有 60000 字节预算闸门 |

---


## 5. 扩展点（新增功能）

每条按「文件顺序」写，照抄即可。**加完跑 §4.2。**

### 5.1 新增一个模型工具

1. `lib/tools.js`：`defineTool({ name, description, inputSchema, execute(args, exec) })`，会话 id 用 `exec.agent.session.header.id`（§6.3）。
2. **描述是给模型看的契约**：写清默认值、拒绝条件、返回形状——模型读不到代码。
3. 主 agent **不注册**全局写入类工具（§1.2）。
4. `lib/index.js` 注册；`README.md` 工具表加一行。
5. `tests/tools.test.mjs` 加「正确入参成功 / 错误入参给可读错误」。

### 5.2 新增一个记忆字段（最贵的一类，先想清楚）

1. **写入侧**：`privateRemember` 给默认值——**默认值就是语义**（`source` 默认 `user_said` 等于把模型推断系统性抬成「用户说的引语」，默认 `inferred` 才诚实）。
2. **校验**：封闭枚举进 `checkEnums`（拼错会静默失去语义，比抛错更危险）。
3. **更新侧**：`privateUpdate` 允许表 + `rpc.js` 的 `allowed` + `tools.js` schema 一起加，否则模型和 UI 都改不了；`allowed` 外必须报错、派生字段重算、`layer='short_term'` 重复设置 = re-arm（§3.15）。
4. **读取侧**：`formatPrivate`/`formatGlobal` 要不要显示；`decayStrength`/`recallScore` 要不要乘进去。
5. **旧数据**：字段缺失当「默认值」不当「假」，**不做历史回填**——回填等于替过去的话改口供。
6. **UI**：要不要显示（一个 `Tag` 就够）、要不要可编辑（表单 + i18n 两字典）。
7. 测试：默认值、非法值、旧数据缺字段、序列化往返。

### 5.3 新增一个 RPC 方法

1. `lib/rpc.js` 的 `switch` 加 case（共 72 个方法，按功能分组，别乱插）。
2. 返回**形状稳定**：客户端 `call()` 直接解构，列表类给 `{items, total}` 而不是裸数组。
3. `revisionOnly` 分支只回 `{revision, stamp}`、**不要求 sessionId**（三端轮询，设置页与独立页没会话）、**不塞业务数据**（每 2.5 秒一次）；顺带 `noteMemoryBeat()`，`memu_status` 靠它分「没写」与「没人轮询」。
4. 写成功后 `bumpMemoryRevision()`/`notifyMemoryWrite()`（§7）；能让 `state.json` 或索引落盘的写，`state.js` 自动记写事件供 `memu_status` 展示。
5. 跑 `tests/browser.test.mjs`；验收 G-2 会把每个 `call()` 与 case 对一遍。

### 5.4 新增一个设置项 / 设置页

1. `lib/state.js` 的 `DEFAULT_SETTINGS` 加键（**唯一权威**），`setSettings` 白名单 + 类型校验，需要 clamp 的在这里。
2. 设置页：`lib/client.js` 的 `pageDefs`/`pageBlocks`/`PAGE` 三处一致；每页拆 `xxxBlock` + `renderXxxItem`。
3. 文案 zh/en 两字典都加，跑 `node scripts/check-i18n.mjs`；反面语义 → WebUI `settingRow(..., { invert: true })`。
4. 独立页（`lib/webui/`）要同步显示就走 `BroadcastChannel` 的 `memory-write`，并让 WebUI `settingRow` 读同一份 `getSettingsState`。
5. **新增整页**：`PAGE` 加键 → `pageDefs` → `pageBlocks` → 导航图标 → 两处文案 → 渲染探针（`tests/client-render.test.mjs` 逐页渲染）。

### 5.5 新增一个提示词变体 / 类型页

1. 变体命名 `<name>.<domain>.md`，与基础稿同在 `lib/prompts/`。**只有三个 key 支持分域**：`system-guide`、`private-policy`、`private-consolidation`；`global-curator` 不分域（职责就是跨域整理）。
2. `package.json` 的 `files` 白名单必须覆盖 `lib/prompts/*.md`，否则 → `missing default prompt` → 会话崩（§3.7）。
3. 新增 `{{变量}}` 要同时改 `loadPromptForDomain` 的 vars（漏了会原样漏进提示词）。
4. 类型页是**数据**：`settings.promptDomains`，id 限 `[a-z0-9][a-z0-9_-]{0,23}`，`general` 内置不可删；新增页不要预建文件。
5. `manifest.json` 的键是解析后的键（如 `system-guide.rp`）；改 `syncPromptDefaults` 必须**先合并旧键**，否则清空用户覆盖记录。
6. 文案标准：一个鲜明特征 + 5~6 条可执行的行为指令 + 一条安全底线；禁止「更像角色一点」这类无法落地的描述，**安全底线不为风格让路**。

### 5.6 新增一个仿人偏置

先决定它挂哪儿：

| 挂点 | 作用 | 频率 | 代价 |
|---|---|---|---|
| `decayStrength`（`lib/memory.js`） | 改「这条还有多强」 | 每次读强度 | 影响一切下游，最容易过冲 |
| `recallScore`（`lib/memory.js`） | 改「这次谁排前面」 | 每次召回 | 只能重排，不能创造命中 |
| 注入渲染（`inject.js`/`snippet.js`） | 改「长什么样」 | 每次注入 | 只影响观感，最安全 |

纪律：**乘性因子限定在近似 1 的窄区间**（现有偏置多在 0.84–1.16），否则会压过语义命中，让检索变成「随机浮现」；写一条「语义明显更强时仍应胜出」的用例。还要问**它和已有偏置共线吗**——唤醒同调与情绪价偏置共线，实际只做到 ±16%，这种事要在注释里写清。

---


## 10. 提交前检查清单

有一条答不上就先别提交。每条后面括号里是**查哪一节**，理由不重复写。

**注入与召回**
- [ ] 传给 `buildRecall` / `privateRecall` / `globalRecall` 的 exec 是 `{ agent }`？（§6.3）
- [ ] 召回为空留了信号（`logger.warn` + `lastRecallError`）？（§1.10）
- [ ] `injectedIds` 记的是**真正进入文本**的条目？（§8.4）
- [ ] token 预算走 `lib/budget.js`，没有 `tokens * 3`？（§8.4）
- [ ] `pending_review` 被挡在注入与召回之外？（§3.9）
- [ ] 没有每步注入、动态记忆没进 system prompt？（§1.3、§1.4）

**数据安全**
- [ ] 读失败没被当成空数据（改名 `*.corrupt-<ts>` + 拒绝写入）？（§2.3 铁律一）
- [ ] `state.json` 合并写只用于记账字段，`index/*.json` 永远同步落盘？（§2.3 铁律三）
- [ ] 索引写入按 `libraryId` 串行化？（§2.3 铁律二）
- [ ] 旁路文件（`stats.js`）写坏只降级页面、不阻塞记忆读写、绝不抛错？
- [ ] 没有自动删除记忆；删会话只解绑不删库？（§1.5）
- [ ] 破坏性操作有二次确认，且确认前自动再备份？（§9.3）

**作用域**
- [ ] 文件夹 clamp 落在四处（`ensureSession` / `setSessionScope` / 注入准入 / 记忆读写）？（§2.3）
- [ ] 文件夹两开关都关 → 不弹窗、不建库、不注入？（§2.3）
- [ ] 纯读路径用 `peekBinding`，不是 `bindingFor`？（§2.3）

**消息与 source**
- [ ] 新消息点写 `plugin:dsh-memu-memory`，不是 `kind:plugin` + `plugin` 字段？（§3.2）
- [ ] 没有试图修复已落盘的 v4 污染行？（§3.2）
- [ ] `form: notice` 带了 `summary`？（§6.7）

**工具与 RPC**
- [ ] 工具描述写清了默认值、拒绝条件、返回形状？（§5.1）
- [ ] 主 agent 没有全局写入工具？（§1.2）
- [ ] 写成功后调了 `bumpMemoryRevision()` / `notifyMemoryWrite()`？（§5.3）
- [ ] `revisionOnly` 分支里没塞业务数据？（§5.3）
- [ ] 记忆浏览器的写只走白名单字段（`layer` / `pinReason` / `pinSource` 不许从浏览器写）？（§1.2）
- [ ] 新字段在 `privateUpdate` 与 `updateMemory` 的 `allowed` 里都有，未知键会报错？（§3.15）
- [ ] 改 `peak` / `arousal` / `confidence` 后 `accuracy` 重算了？`short_term` 重复设置是 re-arm？（§3.15）
- [ ] embedding 配置只回 `hasKey`，不回明文 key？（§6.1）

**UI**
- [ ] 没有新增内联 `S.*`，样式走 `dshm-`？（§7.3）
- [ ] `Button` 透传了 `title`？（§7.3）
- [ ] 「多选一」用 `.dshm-nav-list` / `.dshm-nav-item`，没写第二套？（§7.3）
- [ ] `<button>` 里没嵌 `role="button"`；破坏性操作用二次点击不是 `confirm`？（§7.3）
- [ ] 反面语义设置走了 `{ invert: true }`？（§7.4）
- [ ] `pageDefs` = `pageBlocks` = `PAGE` 三处一致，新增页过了渲染探针？（§7.5）
- [ ] 侧边栏首屏仍只有 1 个 RPC、不读记忆全文、不显示完整路径？（§7.4）
- [ ] 面板同步用 `useMemoryBeat`，心跳载荷仍只有 `{ revisionOnly: true }`？（§7.4）
- [ ] 写操作通知了别处，接收端不回播、不从消息取数据？（§7.4）

**提示词**
- [ ] 正文在 `lib/prompts/`，业务代码没硬编码？（§8.5）
- [ ] 新变体在 `package.json` 的 `files` 白名单里？（§5.5）
- [ ] 新 `{{变量}}` 在 `loadPromptForDomain` 的 vars 里传了？（§5.5）
- [ ] `syncPromptDefaults` 保留了 manifest 旧键？（§5.5）
- [ ] 「恢复默认」只删用户覆盖？（§8.5）

**引擎与安全**
- [ ] 没把 Python 装进系统解释器；venv 里没有 pip？（§1.6）
- [ ] 没自动追最新 MemU；prune 绕开了 current 与 recommended？（§9.3）
- [ ] 日志与提示词里没有 key？（§1.9）
- [ ] 没碰共享 `/api`？（§1.8）

**验证与文档**
- [ ] `node --check` 过了改的每个文件？
- [ ] `npm test` 全绿（允许 1 条真实引擎用例跳过）？新增行为有对应用例？
- [ ] `node scripts/acceptance-local.mjs` 是 50/50？
- [ ] `npm run check` 输出 `all checks passed`？
- [ ] 新文案同时进了 `zh` / `en`？
- [ ] `README.md` 能力/限制段同步了？「会坏在哪」补进了 §3 对应段？
