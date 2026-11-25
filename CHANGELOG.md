# 更新日志 / Changelog

## [1.4.0] - 2026-11-26

> 三件事一起收：按域终于看得见筛得动；中文人名被 n-gram 滑窗切成两个节点的成因在提名侧堵住；
> 宿主 0.2.3 线升级后**静默失效的 RPC 来源守卫**补回。另新增两份专用文档——跨版本事实台账
> `docs/host-versions.md`（§13）与推迟项台账 `docs/pending-work.md`（§14），并给台账配了机检。

- **按域查看 / 筛选 / 显示**：
  - 服务端——`lib/global-graph.js:getGlobalGraph` 以前没有 `domain` 参数也不回 `domains`，所以「全部库/全局」视图里域筛选完全无效；现在按 `lib/graph.js:graphDomain` 的同一归一化口径过滤，并连同跨域边一起丢掉，返回筛选前的 `domains` 并集。`lib/rpc.js` 的 `getGraph(scope:'global')` 透传该参数；`browseWall` 的 item 以前根本没有 `domain` 字段（所以墙无法按域筛），现在带上，并支持 `domain` 过滤参数、回 `domains` 并集；`privateListView`（`browseLibrary`/`listPrivate`）同样补 `domain`。归一口径：私有条目缺域 → `general`（与图一致），全局条目缺域 → `unknown`（与 `listGlobal` 一致）。
  - 客户端——图页的全局分支以前不传域；节点检查器与记忆墙卡片、详情抽屉都不显示域（`getMemory` 早就把 `entry.domain` 发到手上了，纯属没渲染）。记忆墙新增域下拉（选项来自服务端 `domains`，与图页同口径），筛选交给服务端而不是在 300 条里前端裁。域值一律走既有 `DOMAIN_LABELS`/`domainText()`，未新增中文映射。
  - 守卫：`tests/global-graph.test.mjs`（全局图按域过滤且并集不缩）、`tests/global-lifecycle.test.mjs`（`browseWall` 的 `domain` 字段/过滤/计数）、`tests/client-render.test.mjs`（墙域筛选发出 `domain` 请求 + 卡片显示域 + 全局图分支转发域）。
- **中文人名被拆成两个节点**（现场：`…/homes/0.2.2-rc.2` 的 `南宫晚` + `宫晚晴` 实为 `南宫晚晴`，另有 `洛云澜`/`云澜`、`出现`/`首次`/`游戏`/`群里`/`记账` 等同类碎片）：
  - `lib/auto-link/terminology.js:rankCandidates` 的碎片抑制以前只在「引号/引入语」场景生效（`fragments` 只由这两类表面填），纯散文里的名字三 gram 直接进 tier2，UI 点一下就用 `row.term` 建成 confirmed 实体。现在补一条**同证据强度下的最长表面优先**：一个统计词若被另一个 df 不低于它的候选词完整包含，就不再提名；整段本就是 2 字的名字（`星港`、`阿兰`、`小檀`）不受影响。
  - `lib/private-links.js:suggestPrivateLinks` 以前把 tokenizer-v2 的 trigram 窗口当实体名（`南宫晚`/`宫晚晴` 都进了 `suggestedEntity.name` 喂给 worker），而 `docs/memory-semantics.md` §8.15 本意是「V2 额外层只喂 BM25」。现在同一组件里窗口片段不再命名实体，长表面按分组数取胜。
  - `lib/graph.js:suggestEntityMerges` 新增第三种理由 `name-core`：`顾清欢` / `欢欢` / `欢` 这类「一个名字的全称、昵称、单字称呼」以前既不落在 containment（短方需 ≥2 字）也不落在 edit-distance（`顾清欢`↔`欢欢` 距离 3），于是三个孤岛永不连线。现在按「一端收尾、另一端起头」的共享字串提议合并（并要求去掉重叠后长侧还剩 ≥2 字，`空气`/`气候` 这种共用一个字的普通词不提议）。**仍然永不自动合并**，UI 两次点击确认；理由标签走新增的 `mergeReasonNameCore`。
  - `lib/auto-link/candidates.js` 的 `CANDIDATE_VERSION` 升到 3，让已被污染的 `anchor-candidates.json` 快照重建。
  - 存量数据 + **升级后自动跑一次**：新增 `lib/entity-repair.js`（规划与执行同源）与 `lib/index.js:runEntityRepairPass`，挂在启动后 5 秒的一次性钩子上，标记写进 `state.cycle.entityRepairVersion`（与 `lastCurateAt` 同族，不新造机制）。理由是**新库不再产生碎片，但老发布版本留下的碎片节点不会因为升级就变干净**。只自动处理**可证明**的那一类：片段首尾重叠重建出的完整名在该库正文里真的出现过，或短名在正文里的每一次出现都在某个更长名字里面。
  - **为什么不能整类自动合**：dry 报告里出现过 `顾清欢 ← 顾清悦` —— 编辑距离 ≤2 把两个不同称呼撞成一对。相似不是证据，所以 `similar` 档绝不自动写，只在诊断页报数并挂一个「需确认」按钮（`MANUAL_REPAIRS` 的 `merge-entity-fragments`，**不在 `SAFE_REPAIRS`**），启动自愈也不会碰它。`docs/troubleshooting.md` §3.44 原来的口径「此修复不改写现有实体」据此作废并改写。
  - 安全边界三条：写入前先图备份（`backupDatabases`），**备份失败就一个字节都不写**、记 `ENTITY_REPAIR_DEFERRED` 且标记不写、下次启动重试；`mergeEntities` 末尾的 `pruneOrphanEntities` 是全库清扫，会删掉任何无引用实体，故写入前后各读一次快照，把**计划外**的行原样写回；合并只改实体行与指向，记忆正文一字不动。整轮只跑一次，第二次直接返回 `skipped:'done'`。
  - 新设置 `autoRepairEntityFragments`（默认开；关掉 = 连可证明的也不动），三处同步注册（`DEFAULT_SETTINGS` / `setSettings` allowlist / `resetSettings`），`tests/settings-plumbing.test.mjs` 钉住它确实可写——1.3.15 的 `midTurnRecall` 教训不再重演。
  - 命令行等价物 `scripts/entity-dedupe.mjs`（默认 dry-run；`--apply` 先备份；`--include-similar` 才把相似候选一起交给人批量决定）。
  - 副本实测（复制用户 home 的 `state.json` + `index/` 到临时目录跑，原件未动）：`attested=5`（其中 2 组是重建主节点）、`similar=3` 留在待确认、副带删除 0、失败 0，第二次规划 `attested=0` 即幂等。守卫用例：`tests/graph-cascade.test.mjs`（分档 / 应用与别名并集 / 计划外实体不被删 / 升级只跑一次且尊重开关）、`tests/environment-check.test.mjs`（检查项存在且标 manual、修复动作幂等、绝不进 SAFE 名单）。
  - 守卫：`tests/auto-link-candidates.test.mjs`（窗口片段不提名、`星港` 仍在 tier2）、`tests/private-links.test.mjs`（四字词名的窗口不再各成 hub）、`tests/entity-merge.test.mjs`（`name-core` 的给出与不给出）。
- **宿主 0.2.3 线的 RPC 守卫**：`requestRejectionOf()` 原以为两级探测够用，实际在 `0.2.3-alpha.1` 起**两级同时落空**——`requestRejection` 在该版被移除（文档误记为 alpha.2），而 `isTrustedApiRequest` 是模块级函数、不挂在 connection 服务上，探测恒为 false。现在补第三级 `connection.admit(request)`（返回 `{peer}` 或 `{rejection:401|403|503}`，8 个 tag 全部核对过：`admit` 一直存在，`requestRejection` 只在 ≤rc.5 存在），并把两处互相指认的 warn 文案改成实话（`authorizeLibrary` 在任何宿主上都不存在，所以那行 warn 是唯一的越权信号）。试过 fail-closed，仍被 21 条 RPC 守卫用例否掉，保持仓库「降级 + 留信号」的取舍。
- **文档**：
  - 新增 `docs/host-versions.md`（§13）——逐构建核对台账（11 行，含 commit、核对方式真机/源码/未测、判定 exact/line/nearest、结构指纹、未覆盖面）、宿主面 × 版本矩阵（10 个面 + 探测点 + 缺失降级）、破坏性变更账本（`startActivation` 扁平化 / `ctx.schedule` 两代 / `requestRejection` 移除 / `decision.messages` 只在 `firstAttempt`），并纠正两条「曾以为是变更」的误判（`dsh-session-query` 目录从 0.2.0 起就是嵌套的；`authorizeLibrary` 从未存在）。`docs/host-adaptation.md` 的 §2 版本列、原 §6.1、§7 版本记录改为指向 §13——同一事实写三处正是它断更的原因。
  - 新增 `docs/pending-work.md`（§14）——把散在 CHANGELOG/docs 里的「本版未做 / 后续 / 待办 / 尚未验证」逐条核对：**4 条已完成或不必做**（含 `docs/host-adaptation.md` 原 §6.1 的冷读待办），**8 条仍成立**并各附建议方案与前置条件，**5 条明确不做**防止重做。
  - `scripts/check-doc-drift.mjs` 新增 Gate 4（五条：文档提到的构建必须有台账行 / 行必须带证据等级与 commit 与日期 / 探测点符号必须仍存在 / 代码里不得出现带预发布号的宿主构建名 / `dshReleases` 与台账一致），`tests/doc-drift.test.mjs` 补 12 条用例。`package.json` 新增 `dsh.compatibility.dshReleases`（宿主无消费者，纯人读记录，`engines.dsh` 不动）。
  - `docs/host-versions.md` §13.6 + `lib/host-surface.js`：`getState()` 增加只读 `hostSurface`，诊断页环境卡顶部显示 `rpcGuard=… schedule=… activation=… coldLog=…`，用于在真机核对台账行——值全部来自既有探测，插件不据此分支、不读宿主版本号。
- **去隐私化**：仓库里（含本 CHANGELOG、docs、lib 注释、tests fixture）散落着从本机记忆数据里抄来的真实人名、昵称、QQ 号与一条真实对话正文——它们随 npm 包一起发布。本轮统一换成合成样本（保持长度、词元结构、CJK 连续段形状不变，所以 BM25/提及边的断言仍在测同一件事）：`lib/auto-link/decide.js`、`lib/auto-link/normalize.js`、`lib/state.js`、`docs/troubleshooting.md`、`tests/managed-memory.test.mjs`、`tests/hybrid-recall.test.mjs`、`tests/auto-link-*.test.mjs` 等 20 余个文件。**今后写 fixture 一律用合成名字**，真机取证的数据只写形态、不写正文。
- **验证**：`npm test` 2003 tests / 2001 pass / 0 fail / 2 skipped（两条真实引擎用例按设计跳过）；`node scripts/acceptance-local.mjs` 50/50；`npm run check` 全绿（含 Gate 4）。**本轮顺带修好**：`node scripts/chain-matrix.mjs` 此前整体崩在导入期——脚本合成的 `./memu.js` 桩缺 `closeMemuResident` / `prewarmMemuResident` 两个导出（1.3.15 起 `lib/rpc.js` 新增的导入），补齐后 10/10 全绿。CHANGELOG 里「manual/idle 六格失败」那条待办因此作废，见 `docs/pending-work.md` §14.1。
- **仍待你决定**：home 实体数据修复的执行授权（P7）、`0.2.2-rc.5` / `0.2.3-alpha.*` 的真机四件套（P6）、性能与成本对照实验（P1）。

## [1.3.15] - 2026-11-23

> 注入的位置与幂等：记忆块从"插在用户话之前"改成"紧跟用户话之后"，并让"投过"的记账不再只依赖宿主接纳回调——修掉长会话里锚点每步重投（单会话 5 次）与媒体块每步重投（单回合 22 次）。独立审核后修正：mid-turn 设置键未注册导致「可关」不可达、跨进程补认的凭据边角与诊断噪音。

- **落点口径统一**（`lib/inject.js`）：step-1 路径与 inbound 路径都改为 `splice(humanIndex + 1)`；`reuseProposal` 复用提案同样落在人类消息之后。通道驱动（`channel-qq` 等）的消息不再因为 `source.kind !== 'user'` 被当成"没人说话"，因此不再退到批次末尾、出现在工具调用之后。
- **人类消息判定**：新增 `humanMessage()` / `isHarnessUserMessage()`，把插件消息、宿主提醒（`runtime-context` / `skill-catalog` / `time-context` / `progress-rules` / `agent-instructions` / `dsh-ops:step-tail` / `user-approval`）与 `tool*` / `system*` 排除在外。
- **进程内记账兜底**：`anchorSeen` / `servedHumans` / `servedMedia` / `servedInbound`。宿主接纳回调长期不来时，`anchorPushed` / `lastInjectedUserMessageId` / `pendingMedia` 的幂等本来全线失效；现在先记进程内（键含 turn 或人类消息 id），压缩与回合失败（`error` / `aborted`）时清空，重启后最多重发一次。
- **回合中途补充召回（新）**：coding 这类多步回合不再"首步之后就没有记忆"。按增量重要性（复用 `active-memory` 计分口径：去重工具单元 + 封顶字符 + 步数）触发，标记 `[回合中途补充 · 这不是用户新说的话]`，独立预算 `midTurnTokens`(400)、每回合上限 `midTurnMaxPerTurn`(2)、冷却 `midTurnCooldownMs`(60s)；刚过线只投提示卡，明显过线才投正文召回；`midTurnRecall: false` 可关。
- **待接纳提案落盘**（`lib/state.js` 新增 `rememberPendingInjection` / `findPendingInjection` / `forgetPendingInjection`）：`injectionAdmissions` 只是进程内 Map，宿主重启或另一个进程观察时提案会消失，于是接纳永不发生——qq-dm 会话 333 个回合里 `acceptedMemoryMessages` 一次都没出现（同库 qq-group 正常）。现在提案同时落一份最小凭据（按内容 digest 匹配、最多 8 条），观察端换进程也能补认；迟到接纳把时钟抬到 `max(当时, lastInjectedTurn, inbound.clock)` 以满足「时钟必须前进」；回合一收立即作废，避免迟到消息复活已丢弃提案。
- **短句也召回（A 方案，取代曾试过的"每回合重发锚点"）**：召回门槛下限改为 2 字（`minUserChars` 仍可调高）。此前 2–5 字的回合（"摸摸"/"现在有点饿"）被 6 字门槛挡掉，叠加"锚点一会话一次"，首步就一条记忆都没有，锚点只能落到下一条模型消息之后。锚点频率**保持不变**（单测与验收 J-8 都钉着它）。
- **接纳诊断到字段级**：`snapshot-stale` 现在带 `drift`（`epoch/libraryId/scopeKey/memoryContext/useLibrary/useGlobal` 的 `旧→新`）；不阻塞的漂移单独记一条 `注入接纳 · 记账漂移（不阻塞）`，这样"是谁把快照弄脏了"直接可读。
- **接纳失败可查**：新增 `注入消息未被接纳 · <reason>` warn 记录（同会话同原因 60 秒合并），reason 取 `proposal-missing` / `proposal-<status>` / `digest-mismatch` / `snapshot-stale`。此前这条链路静默失败，只能靠猜（硬规则 10）。
- **RPC 守卫补探针**：rc.5 仍有 `connection.requestRejection`；HEAD 0.2.3-alpha.2 已移除它，旧探针在那种宿主上会静默放行。`requestRejectionOf()` 改为两级探测（`requestRejection` → `isTrustedApiRequest`），两者都没有时保持放行并 warn 一次（fail-closed 会否掉 21 个 RPC 守卫用例，且违背仓库「不 fail closed」的取舍）。
- **宿主适配（0.2.2-rc.5 / 0.2.3-alpha.2 源码核对）**：Node 半侧无破坏性变化（`createUserMessage` / `defineTool` / `ctx.tools.register` / `agent/pre-step` payload / `decision.messages` 落盘顺序 / `readColdSessionLog` 均不变；`dsh-session-query` 只是目录改成嵌套，按单层路径搜会误判成「包消失」）。`defaultLoadColdLogModule` 保留能力探测 + `COLD_LOG_READER_UNAVAILABLE` 诊断（真导入失败时才触发）。记录写在 `docs/host-adaptation.md` §6.1。
- **守卫**：`tests/inject.test.mjs` / `injection-chain` / `injection-rollback` / `memory-chain` / `media` / `cue` 改为断言"紧跟人类消息之后"，并覆盖 inbound 批次键去重与中途补充分档；`binding-diagnostics` 的 `RUNTIME_STATE` file:line 契约随 `lib/state.js` 行号同步。
- **审核修正（1.3.15）**：① `midTurnRecall` 等 9 个键此前不在 `DEFAULT_SETTINGS`，`updateSettings` 对未知键静默丢弃——文档承诺的「可关」不可达；现已注册默认值 + `updateSettings` 范围校验 + RPC `setSettings` 白名单，并补 `tests/injection-chain.test.mjs` 两条分档/开关守卫。② 落盘凭据补认成功后回写进程内提案表（同消息再观察走 admitted→true，不再误报 `proposal-missing`）；凭据按自身 `messageId` 作废；读取按 30 分钟 TTL 过滤并取最新同 digest 匹配，写入时顺手清扫过期项（`tests/pending-injection.test.mjs` 两条新守卫）。③ 两条「注入评估」info 记录加同会话同签名 60 秒合并，话痨会话不再逐步刷日志。④ step-1 的 `minUserChars` 读取从 `||` 统一为 `??`（0 不再被当成 6）。⑤ 改名 `pre-human ordering` 测试为 `post-human`。审核确认：宽松接纳不产生越权记账——真实口径变化一律推进 `scopeGeneration`，`markInjectedRefs`（state.js）按 generation/epoch 硬闸整笔拒收。

## [1.3.14] - 2026-11-22

> 归档不再误伤在用的库：scope 不在 DSH 工作区注册表只说明"这不是工作区"，不说明"没人用"。修掉"库被自动归档、绑定会话却继续读写 9 小时"的自相矛盾状态，并堵住它带来的误删风险。

- **归档判定补上"在用"这一半**（`lib/cycle.js` `runLibraryHousekeeping`）：`lib/state.js` 新增 `inUseLibraryIds()` / `isLibraryInUse()`，按存活绑定（`sessionGone !== true`）判定；扫描对仍被会话绑定的库不再归档，并在返工结果里给出 `skippedInUse`，同一库只提示一次。外部报告的现场正是这条路径：IM 插件数据目录建库后 176 秒被归档，之后 9 小时 172 条活动、6 次召回全部成功，而 UI 里库已消失。
- **旧数据的收窄**：1.3.13 及更早的归档没有 `archivedBy`，事后分不清「用户点的归档」和「老扫描误归档」。所以对这类库只复活「还热」的（`lastUsedAt` 在 14 天内）；冷归档保持归档——本机实测 `rp`（14 个绑定）与 `另一个工作区库`（4 个）正属后者。
- **误归档自愈**：`archiveLibrary(id, { by })` 记录归档来源（`sweep` / `user`）。扫描遇到「已归档但仍有存活绑定且不是用户归档」的库会就地复活（`revived`），不再要求 scope 回到工作区注册表——那条件对 `.dsh/im`、profile 目录这类路径永不满足。
- **用户意图优先**：`archivedBy === 'user'` 的归档不会被扫描复活；`ensureSession` 快路径对误归档库（非 user）就地复活，避免"已绑定会话继续读写归档库"的旧形态。
- **误删风险关掉**：`deleteLibrary(id, { force })` 只拒绝「危险归档 + 仍在用」这一类（扫描误归档 = `archivedWhileInUse`，与自愈共用同一判据）；用户主动归档、以及冷数据的旧归档照旧可删，删不掉的老库不会出现。RPC 仅在 `confirmed` 时透传 `force`；`purgeArchivedAfterDays` 的清理候选排除在用库（此前只看年龄）。
- 守卫：`tests/cycle.test.mjs` 新增 9 条——在用库跨三轮 sweep 不归档且仍在列表、无人用的库照常归档且 `archivedBy='sweep'`、误归档在用库被复活、用户归档不被复活、冷/热两种旧归档的复活判据、purge 不把在用库列入候选、删除在用库被拒（解绑后放行）、快路径复活。
- 文档同步：`docs/troubleshooting.md` 新增 §3.46（症状/根因/守卫）与症状速查一行。

## [1.3.13] - 2026-11-21

> 诊断体系：插件内部故障有了自己的出口（诊断页 + 启动弹窗 + 自动/手动修复），并修掉三类会让召回静默降级的真实故障——摘要把镜像元数据算成"制品已变"、运行时目录失效、0 字节遗留锁永不自愈。

- **诊断存储（与活动日志分开）**：新增 `lib/diagnostics.js`，写 `diagnostics/events.jsonl`（2MB 轮转）+ `acknowledged.json`，内存环形 500 条；同 `(scope, code, message)` 60 秒内只累加 `count`；`detail` 统一脱敏。`KNOWN_CODES` 把故障码映射成「哪一层坏了 / 能不能自动修 / 修之前会不会丢数据」。
- **诊断页（设置 → 诊断，`#/settings/diagnostics`）**：上半张环境自检（数据目录、遗留锁、引擎、向量 profile、运行时、模型、worker），每项给证据与建议并配按钮（可自动修的给按钮，破坏性的标"需手动"）；下半张按 level/关键词过滤诊断记录，可整页复制。独立 WebUI 的 `PAGE_NAMES` 同步。
- **启动检查 + 主页弹窗**：启动 6 秒后跑一次自检，error/warn 项落诊断（`ENV_*`）；主页顶部弹出提醒卡（`getDiagnosticAlerts`，最多 4 条按 code 汇总），点"稍后/打开诊断"即 `acknowledgeDiagnostics`，同一问题不再天天弹、再次发生才重新提醒。
- **修复：自动只做安全项**：`SAFE_REPAIRS`＝释放可证明遗弃的锁（`release-stale-locks`）、重签摘要（`resign-vector-profile`）、重指运行时目录（`repoint-runtime-dir`），受 `autoInstallEngine` 开关约束；`MANUAL_REPAIRS`＝重装运行时/模型、重建向量代际、重装引擎，只能手动、且 `confirmed === true`。每步无论成败都记 `MEMU_DIAGNOSTIC_REPAIRED` / `MEMU_DIAGNOSTIC_REPAIR_FAILED`。
- **锁加固**：`withFileLock` 载荷改成 `pid\nISO`（兼容旧的一行裸 pid），EEXIST 时先判定遗弃（无法解析且≥10s / 自身 pid 但无事务且≥10s / 死 pid 立即 / ≥60s 超龄），遗弃则就地释放重试并发 `MEMU_LOCK_BROKEN` 事件。真实事故：0 字节 `consolidation.json.lock` 里 `Number('')===0` 永不满足清理条件，整理连败 84 次。
- **摘要改成身份视图**：`manifestDigest` 只摘 `runtime` 的身份字段（engine/abi/version/os/arch 与制品 name/version/sha256/integrity），镜像源与文案（`sources`/`label`/`displayName`/`summary`）不再入摘要，字典与数组两种制品形态都剥；老算法继续接受；`manifestDrift` 区分"只有元数据漂移（warn 一次、继续用）"与"身份变了（抛错、要重建）"；逐字段一致却摘要对不上仍按不可信处理。
- **重签与重指**：`resignVectorProfile` 拒绝身份变更，改前备份 `vector-active.json.bak-resign-*`；`repointVectorRuntimeDir` 备份 `.bak-runtimedir-*`，候选目录同时扫 `downloads/embeddings/runtime`（真实布局）与旧 `downloads/runtime`，且要求 `onnxruntime-node/package.json` 真在（只剩 `bin/` 的空壳不算候选）。
- **整理收尾失败带原因**：worker 收尾 followup 失败原先只写 `consolidation wrapup followup failed`，诊断页照着查不到任何东西；现在带 `code: message`（`describeError`），并在 `lib/binding-diagnostics.js` 的 `RUNTIME_STATE` 里同步 `inFlight` 的源码位置。
- **worker 可观测**：`local-embedding-manager` 不再丢弃子进程 stderr（脱敏后保留末 4000 字），失败时挂 `error.embedding = {stderrTail, modelDir, runtimeDir}` 并通过 `setEmbeddingFailureSink` 写诊断——「worker exited before it became ready」从此带原因。
- **读盘修复**：`ensureLoaded` 只有在真的从中间截断时才丢第一行；此前无条件 `shift()`，导致"落盘了但重启后诊断页永远空白"。
- 守卫：`tests/diagnostics.test.mjs`（去重/独立落盘/脱敏/确认后不再弹/修复双向记账/锁四判据/三算法兼容/drift 分类/重启后可读）、`tests/environment-check.test.mjs`（检查项形状、遗弃锁可见、`confirmed` 门禁、失败也记账、安全名单不可越界、运行时目录发现）、`tests/client-render.test.mjs` 逐页探针 13 → 14 页。
- 文档同步：`docs/contributing.md` §5.4.1（诊断/修复扩展点）、`docs/troubleshooting.md` §3.29（三类真实故障的症状→根因→诊断码→修复动作）。

## [1.3.12] - 2026-11-20

> 全局记忆生命周期与私有同权：记忆墙全局块多选批量归档/恢复/删除、抽屉与全局记忆页的归档/恢复/两段确认永久删除补齐；内容仍由 curator 书写。

- **管理面 RPC（不新增方法）**：既有 `archiveMemory` / `updateMemory` / `deleteMemory` 支持显式 `scope:'global'`。全局 `updateMemory` 只接受 `{status:'active'}` 恢复补丁，其余字段一律拒绝（内容写入仍归 curator，硬规则 2 不变）；`scope:'global'` 与 `libraryId` 同现是作用域冲突，鉴权层直接拒。鉴权与全局复核队列同口径：embedded 要活绑定，standalone 走 `libraryId=null` 的 `review.manage` capability。
- **归档即生效**：`globalSetStatus` 只改 status——召回/锚点/注入统一过 `isMemoryEligible`，archived 立即自动排除，不动向量行（与 privateArchive 同口径）。`pending_review` 必须先走复核队列；`superseded` 可归档但不能直接恢复。
- **永久删除**：只开放 archived/suppressed/expired，需显式确认 + 删除前整库备份；先删引擎/向量行再单事务删行，级联清他条 `links[].to` 与 `duplicateOf/relatedTo/conflictingWith/supersededBy/absorbedBy` 指针。合并稿（带 `absorbedFrom`）与活跃合并的来源拒删——`absorbSnapshot` 是撤销合并的唯一依据。全局删除没有 preview/restore 撤销缓冲（明确报错，不静默）。
- **UI 统一**：记忆墙全局块启用多选（批量归档/恢复/两段删除，逐条失败一次性报错口径与私有一致）；抽屉全局条目内容只读但生命周期按钮齐全（待复核条目不显示归档，走复核裁决）；全局记忆页每条带状态 Tag 与归档/恢复/两段删除。侧栏会话视图保持只读。
- 守卫：`tests/global-lifecycle.test.mjs`（状态机/召回排除/级联/合并守卫/管理视图/私有回归）、`tests/webui-auth.test.mjs` 全局生命周期凭据矩阵、`tests/client-render.test.mjs` 全局块多选与抽屉两段删除；`tests/webui.test.mjs` 抽屉删除静态守卫更新为双作用域形状。
- 文档同步：README（中英）抽屉口径、`docs/memory-semantics.md` §8.3 生命周期管理面、`docs/troubleshooting.md` §3.42。

## [1.3.11] - 2026-11-20

> 隐藏记忆不再经词法统计挤掉可见召回；必写候选核验改为保守证据比对，同日不同事/极性相反/数值改变不再被误判「已覆盖」。

- **召回语料资格前移**：私库纯词法与混合召回的词法支路在构建 BM25 语料**之前**应用会话可见性、自动资格、披露与说话人过滤（此前只在最终融合时过滤，隐藏条目仍污染 DF/avgdl，甚至触发高频词剪枝把可见命中裁掉）。精确 id 直达与全局域路由契约不变，显式读取保留原资格。语料缓存按过滤后文件集指纹隔离，资格变化即失效；缓存 key 追加 `auto/explicit : asked/plain : speaker` 标志，自动/显式交替不再每次重建语料（跨库 key 同步补说话人标志）。守卫：`tests/recall-corpus-eligibility.test.mjs`（3 后端 × secret/错角色/never_say/only_if_asked，断言可见命中与词法分数不变、精确 id 仍可读）。
- **必写候选保守核验**：`candidateCovered` 不再凭日期相同或两个共享 bigram 结算。日期从文本重合证据中剔除；要求 ≥2 个有效 token、重合数达 min(3, 候选 token 数) 且覆盖率 ≥55%，候选的汉字/Latin 词与数值集合须在同一条新增/更新记忆中保留，共享 token 的子句否定极性须一致；不足以证明时留在 carry 下窗顺延。仍是词法近似，可能保守保留已写入的同义改写（明说的取舍：误判覆盖会静默丢事实，误判未覆盖只是有界重写）。守卫：`tests/consolidation-fork.test.mjs` 新增同日不同事件/极性相反/动作改变/数值改变/日期单独命中反例与真实改写正例。
- **评测口径**：`scripts/recall-bench.mjs` 新增 `allExpectedAt3`（前三名须包含全部预期 id），冲突题仅命中一方不再被 `recallAt3` 误读为完整覆盖。
- 文档同步：README（含中文版特性条目）、`docs/memory-semantics.md`、`docs/troubleshooting.md` §3.41、绑定生命周期行号引用；`logs/` 加入 .gitignore。

## [1.3.10] - 2026-11-19

> 冻结退避优化（1.3.9 复审建议级项落地）：snapshot-failed 熔断期不再每 5 分钟重读快照/种子、不占整理 budget，且冻结后到来的新真人回合立即让路。

- **冻结会话退避**：熔断回执补 `frozenAt`（连同已有 `cooldownUntil`），`cycle.js` 据此写独立持久字段 `sleepFrozenUntil`/`sleepFrozenAt`，候选阶段守卫跳过「仍在冻结期且无新活动」的重复扫入——省去冻结期每扫的快照捕获 + 种子召回与 budget 名额占用。刻意不复用 `sleepRetryAt`：它不因新消息清零，复用会挡死冻结期到来的新活动。
- **新活动让路**：守卫在 `lastTurnAt` 越过 `frozenAt` 时立即放行——新事件改快照哈希、闸门本就放行，退避只挡无新活动的重复扫入，不惩罚新活动。成功结算与 sessionGone 路径清零冻结字段；非冻结 deferral 顺手清残留。
- 用例：`tests/regression-sweep.test.mjs` 新增「冻结期退避 + 新真人回合立即让路」（以探针时间戳判定是否重入，对守卫缺失敏感）；冷却到期用例同步拨动绑定侧 `sleepFrozenUntil`，与账本冷却同时到期。

## [1.3.9] - 2026-11-19

> 联合扫雷 #3 / #4 / #5：全局提炼兼容两代宿主激活契约、空闲整理不再被熔断/多窗尾段/归档会话/冷 inbound 残骸永久卡死。附带复审修正与保守死代码清理。

- **#3 全局提炼兼容两代宿主契约**：`@deepseek-ai/dsh-subagent` 0.2.2-rc.2 把 `SubagentActivationSpec` 扁平化（移除 `request` 外层），0.2.2-rc.2+ 上全局提炼（手动 + 每 6 小时自动）100% 崩溃（`Cannot read properties of undefined (reading 'id')`）。现按 `docs/host-adaptation.md` §3.4 约定用结构探测（`rootOf`/`namesOf` 标记方法）选形态，另带零副作用 `TypeError` 单次回退兜底（核对过两代宿主，均在任何副作用之前抛错）；提炼失败现在落 `activity.jsonl`（此前只存内存，重启无痕）。用例：`tests/curator-contract.test.mjs`（flat/nested/双向回退/失败日志四条）；`tests/curator.test.mjs`、`tests/curator-probe.test.mjs` 主链路同步改走扁平契约。
- **#4-1 snapshot-failed 熔断不再假装完工**：同一快照失败达上限的熔断此前返回 `ok:true, settled:true`，`cycle.js` 把游标推平 → 安静会话永久静默、`lastSleepError` 被清、1.3.7 的 `effortRefusal` 自愈结构性失效。现返回 `settled:false`（走 deferred 路径：不推游标、不清错误），熔断加 6 小时冷却（到期清零连击、放行一次真实重试），冻结期内重复扫入不再刷活动日志（同一冻结记录只落一条）。
- **#4-2 多窗尾段不再悬空**：多窗整理的 `settled` 是「本窗完成」语义，`cycle.js` 却直接推平粗游标——尾段 <200 事件（够不着 backlog 水位）的会话被永久跳过。现仅 `remaining === 0` 时推 `lastSleepAt`；`lastSleepSeq` 本就随回执逐窗推进，不会重扫。
- **#4-3 归档会话事前跳过**：宿主在 `agent/pre-step` 拒绝祖先含归档会话的 subagent，撞两次就踩进熔断。现 `cycle.js` 候选阶段跳过（不占 budget、不计失败、不推游标），`private.js` 入口拦手动调用并返回 `reasonCode: 'session-archived'`。
- **#5 冷掉的 inbound 残骸不再永久阻断**：召回异常留下的 `inbound.pending` 只有用户再次发言才被排空，旧代码在候选阶段无条件跳过导致「一次召回异常 + 用户不再发言 = 永不整理且零日志」。现改为热窗判断（队列非空 **且** 最近入站活动 < 15 分钟才让路）。注意不能换用 `hasPendingInbound()`——其语义是「不在 30s 退避期内」，`retryAt` 过期后恒为 true，仍会永久挡死。
- 全链路回归：`tests/regression-sweep.test.mjs` 7 条（热队列让路 / 冷残骸放行 / 归档候选跳过 / 手动归档拒绝 / 熔断 settled:false + 日志去重 / 冷却放行 / 多窗尾段收口），均走 `runSleepPass → requestPrivateConsolidation → fork → 回执 → 账本` 真实链路；三条 A/B 对照（还原旧代码各跑一次）确认每条用例都能抓住对应旧缺陷。
- 复审修正与保守清理：拆分 `startGlobalCuration` 合并行；宿主契约注释改引 §3.4 与 src 抛点行号；`inFlight` 诊断行号注释同步 1014；冷却到期去掉与下方共用的重复 `recordOperation`；`cycle.js` 复用 `archivedSessionIdsOf` 消除重复读法。删除死代码 `entryText`（auto-link/decide.js，与 `eligibleEntries` 内联重复）与零引用测试助手 `resetLocalVectorService`。curator-policy 规格常量表、`candidateConfirmationTarget` 等有意单点定义/功能钩子按设计保留。后续：snapshot-failed 冻结回执已带 `cooldownUntil`，据此退避可省冻结期每扫重读快照/种子，但需「冻结感知且不惩罚新活动」的独立字段——直接写 `sleepRetryAt` 会把冻结期到来的新活动一并挡死，故本版未做。

## [1.3.8] - 2026-11-18

> 修复新会话领域弹窗失效（issue #2）：点「稍后」的空白会话在「再点新建会话」后永不再问、首轮注入静默按 RP 兜底提炼。附带：RPC 失败不再被当成"已答"、错误落活动日志、隐式绑定可重问、未询问会话的领域兜底跟随 detectDomain。同版并入召回与整理链路优化（R1–R4 / W1/W2 / O1）。

### 召回与整理链路优化（R1–R4 / W1/W2 / O1）

- **R1 完整读取**：recall 的关键词搜索仍返回短片段，精确 id 默认读取脱敏正文页；`view`、`offset`、`limitChars`、`revision` 控制读取，续页验证正文版本，私有 `libraryId` 仅用于允许范围内的来源定位。仍为字符串输出，不扩大状态/披露/领域权限。
- **R2 显式数量**：显式 `topK` 是 1–20 行硬上限，专项意图扩候选而不扩最终行数；冲突另一版只附来源关系指针。自动注入按设置的事实组数封顶，冲突多版本占一组，专项意图只扩大候选；原 token 预算不变。
- **O1 诊断**：活动日志扩展实际过滤/渲染数量、阶段耗时、估算 token 和结果原因，汇总全局降级；打包并不等于宿主接纳，未知注入量保留 null。近期补位和冲突原子打包已接线；完整性能实验仍属于后续阶段。
- **W1/W2**：worker 不再依赖 fork 专属种子前置，fork/新 worker 用目录 stat 验证 cwd；死 cwd 的恢复 worker 保守退役。完整派发/收尾包、JSON 参数、PTC 结果及迟到产出纳入计量，事件去重；usage 的非缓存输入、缓存读写、输出和推理分开，未知请求不计为零。仍使用既有字符/窗口/TTL 预算，估算 token 不擅自成为新的默认容量门槛。
- **worker 超限**：旧计量 epoch 在下次 acquire 保守换新，完整首包仍超限则 `packet-too-large` 并保持 pending，不无限重建或截断。getConsolidationFeed 暴露精简 runner/计量，原始参数与包正文不进入这份视图；真实宿主与成本对照尚未验证。

- **输出截断恢复**：按宿主公开的 `max-tokens` 单列 `model-output-limit`，保留 pending、拒绝结算并退役失败 worker；相同配置仍受失败上限约束，输出预算/模型/思考档位改变后可受控重试同一快照。冻结的输出失败不再标为 settled，不静默提升父配置或猜模型输出能力。

- **R3 接纳与补位**：按 scope/library/id 与稳定内容版本记录实际进入宿主历史的消息，proposed 不消耗冷却/规则/提醒；每消息独立接纳、拒绝后保留重试、迟到回滚不擦新 owner。近期排除位于既有相关度阈值之后、MMR之前，补位不提升弱候选；冲突整组可紧凑显示，仍放不下就整组略，未知版本明确未定，循环大小有界。

- **R4 跨库身份与授权语料**：跨库候选按复合 `[libraryId,id]` 身份合并，两库同 id 是两条事实，不再按裸 id 早折叠或做主库替换；精确 id 召回保留各库文档，本库优先只定顺序。资格过滤先于语料构建，不可见条目不能经 IDF 影响可见条目分数；词法腿用统一授权 BM25 语料一次评分，跨库分数可比。向量腿原始相似度齐全且同代际才按分融合，否则整腿显式 rank-only，不伪造可比性；RRF 只用于词法/向量方法间融合，不再逐库榜单投票。MMR 文本缓存同样按复合身份区分。单库路径字节级不变，`crossLibraryRecall` 默认仍关闭。

### WebUI 复核入口与首屏加载

- **待复核记忆就地拍板**：记忆墙抽屉（私有与全局条目）和记忆浏览页的复核池新增「接受/丢弃」按钮，走与全局页复核队列同一个 `resolveReview` RPC；接受转活跃（replace 时旧冲突版转 superseded），丢弃转归档可恢复，结果有明确通知。此前只有全局记忆页的队列能复核，墙和浏览页看得到待复核条目却无处下手。
- **首屏少发两个 RPC**：引擎体积（`getEngineSizes`，冷启动要遍历 venv 目录）与可安装版本（`listVersions`）只在总览页引擎卡消费，改为打开总览页才请求，不再与记忆墙首屏争抢宿主 RPC 通道。
- **UI 资源 304 复用**：`/ui-assets/*` 按 mtime+size 缓存内容并发 ETag，命中 `If-None-Match` 回 304 空体；此前 no-cache 无校验器，每次打开都全量重传约 800KB 脚本。插件更新改文件 mtime 即失效。
- 守卫：`tests/client-render.test.mjs` 新增浏览页/记忆墙抽屉复核按钮两条（真实组件渲染 + RPC 载荷断言）；`tests/webui.test.mjs` 新增 ETag/304/过期校验器一条。浏览器实测：私有接受（冲突旧版转已失效）、全局丢弃（转已归档）、浏览页接受、重载 304、总览页延迟请求均通过，无控制台错误。

### 新会话询问门（NewSessionGate）

- **稍后 ≠ 永不问（issue #2 主因）**：DSH 宿主的「新建会话」会复用同工作区的空白会话（`ui-workspace/navigation.ts`："New Session returns to that blank"），旧实现把「稍后」写进 `decided`（本次窗口内永不再问），于是「稍后 → 切走 → 再新建会话」复用同一 id 直接跳过询问，首条消息后由注入路径静默绑定 RP。现在「稍后」只压制本次停留（`deferred`），切走再回到该空白会话必重新弹窗。
- **失败 ≠ 已答**：检查失败不写 `decided`，按 1、2、4 秒递增、最长 30 秒自动重试；重新进入会话立即重试，离开或卸载取消定时器和过期响应。包括静默初始化失败在内，每次失败经 `logClientEvent` 进入活动日志；列表刷新不绕过退避，也不重置正在选择的领域。
- **隐式绑定不挡询问**：绑定新增 `domainSource: 'auto' | 'chosen'`，弹窗确认或侧栏选择器写入 `chosen`。首次观察为空白但尚未作答的会话，即使首条消息先于 cwd 到达、已成为 `blank=false`，也保留询问资格；历史会话和子代理不补弹。文件夹关闭和已记住的全局选择仍优先。
- **领域兜底不再硬编码 RP**：未被询问的新会话 `domainOverride` 兜底从 `'rp'` 改为 `detectDomain({ agentPreset, cwd })`——与 binding 的 `domain` 元数据同一口径（RP 名工作区仍 rp，普通目录 coding，无目录 general）。RP 工作区行为不变；通用宿主的"记些莫名其妙的东西"（RP 口径提炼）由此止血。

### 测试

- `tests/issue2-chain.test.mjs`（新增）：服务端集成——只读检查不建绑定、生产 pre-step 隐式建绑定并注入正确 guide、显式作答写 `chosen`、日志上报可读。
- `tests/new-session-gate.test.mjs`：React 桩保留 ref/memo，按依赖变化清理 effect；覆盖稍后重问、首条消息/cwd 竞态、三连失败后恢复、30 秒退避上限、离开与卸载取消、迟到响应、历史会话排除与选项保留。
- `tests/state.test.mjs`：`rp` 兜底用例改钉新语义（detectDomain 兜底 + `domainSource` 标记）。
- `tests/consolidation-fork.test.mjs`：新增 cwd 保留/回退与工具限制成功、缺失、失败时均不覆盖宿主权限的测试。

### 整理 fork

- 父会话 cwd 不再存在时回退插件数据目录；撤除无条件 `danger-full-access` 覆盖，工具白名单能力缺失或失败时也不自动提权。
- **思考强度拒绝学习表持久化**：反代服务商签名各异（raccoon/sn-deepseek-v4-1-flash-1017 拒 `reasoning effort "medium"` 实测），学习表原先只在进程内存活，每次重启后的第一次整理都会再吃一次 fork-turn-failed——用户侧表现为"反代服务商老是失败"。现在拒绝组合落盘 `<dataDir>/effort-refusals.json`，最终路由确定后移除已拒档位，包含父会话 inherit 与 custom 路由回退；不修改父 options。文件按当前 home 惰性读取，锁内合并最新键并原子写入；读错不覆盖，写失败可由同键学习或下次查询补写。注意：这是参数不匹配，不是服务商不可达；新组合首次仍可能失败一次才学习。
- **向量降级诊断降噪**：跨库召回扫到"有向量库缺席"的库时才记 `向量库未生成，召回降级 local-only`；索引为空的库（旧工作区遗留，如 group_893418498）local-only 与语义召回的结果都是空，不再每轮刷 warn、也不再触发追平探测。有内容而缺库的库行为不变（诊断 + 自动 force 重建）。判空复用召回上游已经加载的完整索引，不再因降级判断重复 stat/双克隆/归一化；跨库和全局都在筛域之前判整库为空，避免把「当前领域无内容」误认为空库。
- 回归：空库静默、非空 warn/日志/追平次数与召回 id、筛域前判空、全局边界和 stat/clone 开销（managed-memory）；fork/worker 真正重试完成、真实新进程读表、读写故障恢复、坏格式保护、双进程合并与 home 隔离（consolidation-fork）。

### 召回排序

- **强词法命中不再被名次归一与偏置埋没**：词法主题证据 topLex ≥ 24 且对第二名 ≥4 倍时，折减系数为 `max(1/(1+topLex/50), sqrt(min(1, lexicalEvidence/topLex)))`。微弱词法证据不比零证据更差；无断层仍保留原偏置排序。
- **样板不作为断层证据**：保留完整查询的原始 `lexical` 和语义请求，仅在 `lexicalEvidence` 中排除可识别的 QQ 包装/尾部提示和纯中英文回复风格指令；保留标识符、URL、小数及换行，主题证据不含日期加权。包含实际主题的指令与仅询问风格的查询不清空。仍为启发式，不宣称识别所有语言或样板。
- **折叠先于断层判定**：同事实代表继承最强词法证据及各路最佳 rank，不重复计算同路贡献；断层只由最终保留的候选判定，被移除的条目不能成为幽灵强命中。跨库同 id 合并口径见 R4。
- **折减只应用一次**：外层 RRF 使用未折减的库内排序，最后的授权/披露/说话人过滤后从 `fusion.rawRetrievalScore` 重算折减。诊断包含 `lexicalDominant`、触发 ID、折减系数与阶段，区分原始 RRF 和最终分值。
- 回归覆盖样板污染、微弱词法连续性、同腿/跨腿折叠证据、跨库同 ID、双层重算、双强命中及真实运行时副本的 topK=5/20 对照回放。

### WebUI 侧边栏

- **「整理提醒」展开后溢出卡片右缘**：zh/en 语言表里 `consolidateDone` 被定义了两次——侧栏提醒行的短标签「完成」被整理按钮的结果通知长模板（"已发起整理 {started} 个对话…"）在对象字面量里静默覆盖，长药丸不可收缩，把整行撑出卡片。拆分同名键：通知模板改 `consolidateStarted`，`deleteForever` 同样双定义（浏览页两步删除的「删除」被库页的「彻底删除」覆盖，帮助文案与按钮名对不上）拆出 `deleteLibrary`。提醒区按可用宽度自动从两列切为单列，状态与会话标题一行、时间和跳转按钮另一行；标题省略号和完整 tooltip、错误消息两行截断，不再裁剪整行操作。`check-i18n` 新增同表重复键硬门禁，此类事故进 `check-all`。

## [1.3.7] - 2026-11-16

> 联合扫雷 + 交互修复：整理 worker 的 link 工具断链、整理超时/租约/冻结三族、召回常驻错误与向量代际缺库自愈、抽屉排版。另含「全部词典」聚合浏览。

### 整理（consolidation）

- **link 工具挂回整理 worker**：`memu_private_link` / `memu_private_link_suggest` 在裁剪"未使用工具"时被误伤——worker 没有这两件，link 维护（含整理期间）结构性停摆。任务书新增裁决步骤与触发时机（同事实新版本→取代；同实体多记忆→挂实体；承诺→commitment；互斥→conflict；候选逐条裁决）。工具描述同步。
- **思考强度被模型拒自动降档**：`provider/model does not support reasoning effort "X"` 的 fork 失败被学习（进程内拒绝表），之后同组合不再带档起 fork；同时清该快照失败连击——冻结闸门由此放行，已冻结的会话自愈。冻结跳过日志带上账本 `lastError`（此前只报结论不报原因）。
- **整理预算抬到 600s**：慢推理模型下 420s 不够（实测 500 事件窗两次超时）；`CONSOLIDATION_WAIT_POLICY` 定为 flat 600s。
- **租约跟随预算**：`beginJob` 的租约 = 预算 + 90s（原固定 15 分钟）——走不到超时路径就死的任务（重启/外杀）不再阻塞重试到 15 分钟，由 `recoverStaleJobs` 在真死后 ~90s 自愈回收。
- **冻结日志可诊断**：`snapshot-failed-too-many` 跳过记录带上账本 `lastError`。

### 向量与召回

- **召回 no-database 静默降级**：库的向量库不在当前代际时（持久状态）不再每轮召回挂常驻错误，降级 local-only + vector 域诊断记录；该库向量生成入册后语义腿自动恢复。
- **向量代际缺库自动追平**：`getMissingVectorLibraries()`（索引非空但不在代际）+ `maybeAutoRebuildVectorGeneration()`（向量已启用且无迁移在途时自动 force 重建，每代际 ≤2 次、并发闸）。`memu_status` 新增 `vector_missing:` 行、`getLocalVectorState().vector.missingLibraries` 给 WebUI/RPC。
- **worker 环境凭据剥离泛化**：`childEnvironment` 按意图剥离任何 `*_API_KEY`（原厂商前缀名单漏 `glm_` 等）。

### WebUI

- **词典/记忆编辑抽屉排版修复**：纵向表单字段不再 flex-grow 拉伸（抽屉下半大片空白的真凶），标签左对齐，`说出口径/置信度/开关` 行底对齐输入行（standalone.css 的 `html[data-standalone]` 覆盖层与 client.js 嵌入壳基础层同步）。抽屉保持全高侧边栏形态。
- **「全部词典」聚合浏览**：`ALL_LEXICON_ID = all` 聚合视图（只读合并全局词典与全部私有库，写操作按词条所属库路由）。

### 文档与测试

- `docs/troubleshooting.md` 新增 §3.32（link 断链/整理超时/租约/召回错误四族）、§3.33（思考强度拒绝冻结）；`AGENTS.md` 硬规则 13。
- 契约测试同步：worker 工具清单、brief 教学契约（link_suggest 从 doesNotMatch 改 match）、`RUNTIME_STATE` 行号、思考强度拒绝学习/降档/闸门重置守卫、预算常量。
- 实测快照：1681 tests / 1679 pass / 0 fail / 2 skipped（真实引擎用例按设计跳过）。

## [1.3.6] - 2026-11-15

> 修复 macOS 一键安装 MemU 引擎失败（issue #1）：受管 Python（python-build-standalone）带 Developer ID 签名 + hardened runtime，macOS 库校验拒绝加载 PyPI wheel 里 ad-hoc 签名的 `pydantic_core` 二进制（dlopen 报 "different Team IDs"），所有候选解释器连环失败。

### 引擎安装

- **macOS 签名校验自修复**：`installEngine` / `switchEngineVersion` / `ensureEngine` 的 verify 统一走 `verifyEngineRepaired`——错误文本命中签名校验形状时（`isMacOSLibraryValidationError`），对 venv 解释器的 realpath 执行 `codesign --force --sign -` ad-hoc 重签（去掉 hardened runtime 标志）并重试一次，仅 darwin 生效；已有安装下次 ensure 时同样自愈。
- **受管 Python 主动重签**：`ensureManagedPython` 装好自己的受管解释器后立即 ad-hoc 重签，在任何 venv 创建之前摘掉 hardened runtime。
- **可读的失败出口**：全部候选失败且错误呈签名形状时，错误末尾附用户侧旁路提示（`DSH_MEMU_PYTHON` 指向 Homebrew/官方 Python，或手动 codesign）。空目录说明：失败的 tmp venv 会被清理，属预期，不是数据丢失。

### 文档与测试

- `docs/troubleshooting.md` 新增 §3.31（症状 / 落点 / 守卫）与症状速查入口。
- `tests/engine.test.mjs` 新增签名错误识别用例（issue #1 原文命中、普通 ImportError 不误触发重签）。

## [1.3.5] - 2026-11-14

> 修复宿主对同一条用户消息给出两次 `agent/pre-step` 时的重复注入：第二次召回会把已投候选全去重、注入 0 条，还多推一格 memoryClock。现在按真实用户消息 id 幂等，一条消息只注入一次；回合回滚时清标记，真重试仍会重投。

### 注入

- **一条用户消息只跑一次注入**：`registerInjection` 记录 `lastInjectedUserMessageId`；同一 session 收到同一条用户消息的第二次 enter 决策时只保留 guide 检查，不再召回。压缩后的 reinject（`reinjectPending`）不参与该幂等。
- **回滚清标记**：`rollbackInjectionForTurn` 撤回本轮账目时一并删除标记，宿主重试同一条消息仍会正常注入。

### 文档与测试

- `docs/troubleshooting.md` 新增 §3.30（症状 / 根因 / 守卫）与症状速查入口。
- `tests/injection-rollback.test.mjs` 新增两条：两次 enter 决策只注入一次（memoryClock 不前进、去重账目不增加）；回合回滚后重试重投。

## [1.3.4] - 2026-11-14

> 整理执行器（实验功能）与增量回合日志：设置页可选 fork / 持久 worker（worker 按 200k 字符 / 16 窗换新，窗内批量写）；整理快照增加持久日志交叉核对，修掉外部追加不可见导致的整理冻结；WebUI 空闲合成负载归零。产品文档移除 benchmark 记录与文档（测试资产不进产品文档）。

### 整理（实验功能）

- **设置页可选「整理执行器」**：设置 → 记忆维护 →「整理执行器」，红色「实验功能」标记。`fork`（默认）= 每个窗口新建一次整理会话；`worker` = 跨窗复用同一后台会话，按模型上下文分档换新（≤128k 上下文 → 120k 字符/8 窗，其余 → 200k 字符/16 窗），新 epoch 用交接包接续。切换从下一窗生效，无需重启；「恢复默认」回到 fork，数据层没有依赖。
- **窗口内批量写**：worker 任务书要求把本窗新增条目合并成一次 `memu_private_remember_batch` 提交，只有 1 条时才逐条写；更新也合并在同一轮。原有「批量参数畸形 → 下一轮退回逐条写」的回退保留。
- **增量回合日志（`lib/turn-log.js`）**：按回合落盘，作为持久 worker 的上下文缓存；`consolidationTurnLog=off` 时退回现场压缩。配套 `scripts/prune-turnlogs.mjs` 清理旧日志。

### 整理可靠性

- **快照冷日志交叉核对**：`captureSessionSnapshot` 的活视图落后于持久日志时，用 `sessionPersistence` + `readColdSessionLog` 冷读取更长的一份（source `persisted-ahead`，60s TTL 缓存），避免外部追加不可见导致的快照冻结与整理洪水。
- **不无意义 resume**：`consolidationModelMode` 为 `host` / `custom` 时不再探测父会话 route，避免把父会话钉成活视图。

### WebUI

- **空闲合成负载归零**：装饰层去掉无限动画与常驻 `will-change`，`backdrop-filter` 只保留 topbar 与 boot 卡，缩略图改由主画布 `onPaint` 驱动；新增 `scripts/check-idle-compositing.mjs` 真机数帧（空闲 fps > 2 即 FAIL）与 `tests/webui.test.mjs` 静态守卫。

### 文档

- `docs/memory-semantics.md` 新增 §8.18：整理执行器的作用、fork 与 worker 的差异、epoch/交接/批量写边界与回滚方式。
- `docs/troubleshooting.md` 新增 §3.28（WebUI 空闲合成负载）与 §3.29（外部追加导致快照冻结）；`docs/client-conventions.md` 新增 §7.7（合成负载约定）。
- `AGENTS.md` §4 增加实验功能指针；移除 benchmark 实测引用。
- `README.md` / `README.zh.md` 移除 Benchmark/基准测试章节与交叉引用；`CHANGELOG.md` 移除历史 benchmark 成绩记录；删除 `docs/recall-benchmark.md`。测试与 harness 代码保留在仓库内，产品文档不再包含 benchmark 记录。

## [1.3.3] - 2026-11-13

> 小修复与体验优化版本：关系图谱最小缩放下「节点打架 / 闪现」的根因修掉（分离阈值曾跟缩放挂钩），开着图谱不再白吃 GPU，宿主设置页导航不再被掰竖；记忆库与记忆浏览新增「立即整理」与库内搜索；图谱产物纳入 `npm run check` 漂移闸门，README 截图与图注重录。

### 关系图谱

- **修掉最小缩放打架**：硬分离阈值原写为 `24 / clamp(viewScale, .06, 5)`，缩到最小（k≈.06）等于要求每对节点保持 400 世界像素间距，斥力与弹簧在 alpha 落地板后已经消失，于是每帧只剩分离力互推、永不收敛。现在阈值只看**世界坐标 + 节点半径**，完全重合时按 id 哈希给确定方向岔开；`viewScale` / `setScale` 一并删除——物理拿不到相机才是根本解。真实浏览器复测（60 节点、k=0.06、点「重新布局」）：每 250ms 最大位移 5.92 → 0.02 屏幕像素，静置后漂移 0.06px。
- 「重新布局」同时重记弹簧原长，避免新位置配旧原长又拉成一团。
- **冷下来零帧**：模拟落回 alpha 地板后不再申请下一帧，呼吸微动也只在模拟活着时画——WebUI 开着图谱 GPU 占用一路爬升的问题随之消失。
- 最小缩放的命中迟滞：相邻节点在屏幕上只差 1–2px 时，悬停不再随 1px 抖动来回跳。
- 缩略图只在主画布真正重绘后才更新（`onPaint` 计数），不再与画布各画各的。
- 设置里的「关系图谱」改为**一个按钮**，点击直达 WebUI 全屏图谱页；`is-graph-wide` 只在独立外壳生效，宿主设置页保持原本的横排导航。

### 记忆库与记忆浏览

- 新增「立即整理」：记忆库每一行、记忆浏览页头各一个按钮，两段确认。它复用侧边栏同一条通道——`listSessions`（本次起返回每个会话绑定的 `libraryId`）筛出该库的会话，再逐个调用 `generatePrivate`，**不新增 RPC 方法**；单轮最多起 5 个整理，其余留给下一次扫描，回执说明已开始 / 在跑 / 失败条数。
- 「当前记忆库」下方新增搜索框：按标题、正文、ID、标签即时过滤当前已加载的库，页签计数与「命中 / 总数」同步，切换记忆库自动清空；关系视图下不显示。

### 工程与文档

- `npm run check` 新增 **graph bundle 漂移闸门**：`node scripts/build-graph.mjs --check` 把源码重打包到内存与 `lib/webui/graph-view.bundle.js` 逐字节比对。此前改完引擎忘了 `npm run build:graph`，浏览器加载的还是旧产物，会出现「单测全绿、页面照旧」（单测 import 源码，浏览器加载 bundle）。生产安装没有 esbuild 时该项自动 skip，不算失败。
- 新增 `scripts/make-readme-shots.mjs`：对着隔离数据预览用无头浏览器重录 README 的七张截图；本轮截图与图注已更新（关系图谱独立成页、自研连续力导向引擎、bundle 无第三方运行时），并清掉了残留的「D3 力导向」表述。
- 文档：`AGENTS.md` 仓库事实改为「只有一个构建步骤」并加 §3.27 指针；`docs/client-conventions.md` 新增 §7.6 图谱工作台约定（物理不读相机、改引擎必重打包、冷下来零帧、命中迟滞、外壳归属、最小缩放必然压住不是 bug、整理不新增 RPC）；`docs/troubleshooting.md` 新增 §3.27；`docs/contributing.md` §4.1–§4.4 补构建步骤与截图连带项。

### 测试

- 引擎：`relayout cools down and separates instead of shoving nodes forever`（位移逐窗衰减 + 零重合 + 物理拿不到相机）、`a cooled layout stops requesting frames even while motion is enabled`、`hover keeps its target through 1px jitter at minimum zoom`。
- 客户端渲染：`the immersive graph shell stays with the standalone WebUI`、`the manual consolidation button rides the sidebar channel, not a new RPC`、`the browse search box filters the loaded library in place`。
- `listSessions` 返回库绑定由 `tests/browser.test.mjs` 覆盖。

## [1.3.2] - 2026-11-10

> 独立「关系图谱」页与确定性自动关联：记忆墙里的内嵌节点图升级为侧边栏独立页面（自研力导向引擎，移除 d3 运行时依赖）；自动关联改为断言驱动（已确认实体提及 / 字段证据），默认只出候选，旧库可用脚本迁移。

### 关系图谱（WebUI）

- 新增独立「关系图谱」导航页（在「MemU 记忆」之后）；「MemU 记忆」页不再内嵌节点图，只保留记忆墙。
- 引擎换为自研力导向（空间网格近程斥力 + 连线弹簧 + 可选向心力），**移除 d3-force 运行时依赖**；持续轻微呼吸，空闲降频，管理视图/页面隐藏自动暂停。
- 拖动节点即固定（fx/fy），邻居被弹簧链牵动，松手不回弹；拖动期间只模拟所连簇，其他簇冻结但作为障碍排斥，避免重合；Shift 拖整簇、右键解固定、双击聚焦。
- 力参数滑杆（斥力 / 连线距离 / 向心力），规则筛选（提及 / 冲突 / 取代 / 同键 / 引文），标签随缩放渐隐，全高画布与缩略图；配色跟随 DSH token。
- 管理视图支持新增/删除节点：可新增记忆或实体（「全部记忆库」模式下可选目标库）；删除为两段确认，实体被引用时再确认一次即连同关联边删除。
- 管理视图支持编辑已有节点：记忆可改标题/内容/层级（层级只开放后端允许的路径——短期升长期、永久可降级，提升为永久仍须走带 pin 理由的写入口），实体可改名称与别名（保存时带回当前别名，避免被整体替换清空）；保存走 `updateMemory` / `renameEntity`，写完立即重取图。
- 旧版自动边（无 `evidence.rule`）在规则筛选里归入「旧版自动」桶，老数据不再显示「没有规则」；过滤与边标签统一走可读规则名。

### 自动关联

- `autoLinkMode` 默认 `suggest`：本地零 Token 出候选、不写边，候选在关系图谱页审核；`deterministic` 只写断言型边。
- 确定性边只来自：已确认实体的 `entity-mention`，以及 `conflicts_with` / `supersedes` / 同 `fact_key` 的字段证据；词面相似、共享 token、向量永远不建边。
- 实体确认/改名/合并/删除即时维护提及边；删除的自动边写入抑制表防复活。
- 新增 `memu_private_link_suggest` 工具与按本轮 id 的增量刷新；新增 `node scripts/rebuild-auto-links.mjs`（默认 dry-run，`--apply` 先备份再清理重建旧统计边）。

### 其它

- 常驻 Python worker 统一用于所有路由：API 模式不再每条命令冷启动解释器。
- `getGraph` 为旧自动边补稳定的 `rule:'auto'` 显示桶；节点图规则筛选按显示层 rule 过滤。
- 依赖：移除 `d3-force`，graph bundle 无第三方运行时依赖（许可证文件同步）。

## [1.3.1] - 2026-11-08

> 整理成本与注入瘦身：worker 只留写工具、回执本地合成、批量写、最小整理回合顺延；注入侧修 guide 预算与锚点重投；工具返回值脱敏与分页。

### 整理

- worker 工具面改为 `remember` / `remember_batch` / `update`，读工具为空；记忆目录与 BM25 召回由插件在种子开头注入（零模型调用）。
- 回执改为库前后 diff 本地合成，新增 `receipt-unverified` 守卫；batch 参数 JSON 畸形时下一轮降级为逐条 remember。
- 新增 `consolidationReasoningEffort`（默认 **medium**）；实测 off 省 47% 整理成本但 50 题 40/50，medium 48/50。
- 最小整理回合：增量 <3 个真人回合先顺延，累计 ≥10 回合或 ≥200 事件强制整理；首次整理与饥饿放行。
- 种子 caps：工具结果 1200→1100、工具调用 600→500，正文 12000 不变。

### 注入

- guide 只在“本步真投”时预扣预算；锚点哨兵改为 `anchorPushed` 独立记账，不再被 400 条上限挤出重投。
- 召回引言压缩、标题卡省略默认 `source`/`layer`、时效提示压到一行；guide 渲染加文件签名缓存。

### 工具与后台

- `memu_private_list` 默认分页 50（上限 200）；relationship 只回一行摘要；全局召回与词典输出统一脱敏；召回结果省略默认 `layer`/`status`/`source` 与 `domain=unknown`（非默认值仍输出，sha256 保持完整）。
- engine 版本探测修正 info-only 响应；`autoCurateSessionLimit` UI 与 state/curator 对齐为 10。
- 文档：更新 §8.13 worker 工具面与 `link_suggest` 描述。

## [1.3.0] - 2026-11-08

> 整理成本与可靠性：worker 工具面 14 → 6、remember/update schema 压缩、窗口 500 事件 / 每窗上限 8 条；新增本地零 Token 的“必写候选”与跨窗顺延；回执对账改为以库 diff 为权威，`snapshot-failed` 不再被当成完成。

### 整理成本

- **worker 工具面 14 → 6**：只挂 `remember` / `update` / `link_suggest` / `list` / `recall` / `status`，schema 从 22,217 字符降到 10,283；`remember` 9,105 → 5,449，`update` 4,756 → 3,224。
- **窗口与条数**：`CONSOLIDATION_WINDOW_EVENTS` 300 → **500**；每窗最多新增 **8** 条，正文 50–170 字；结束条件从“每窗 10 条长文”改为“有明确事实就写、宁可短而准”。
- **必写候选（本地零 Token）**：整理前按 salience ≥3 抽最多 8 条带 seq 的候选注入任务书；本窗没写进库的候选记入账本 `carry`，下一窗优先带 4 条、其余名额留给新候选，最后一窗也在同一份任务书里看到它们——不额外开补写 fork。
- **候选核验**：日期命中或 ≥2 个有效 bigram（带停用词表）判定覆盖，纯本地比对，不增加模型调用。
- **RP 页与任务书对齐**：`private-consolidation.rp.md` 的 10 条 → 8 条、正文 60–180 → 50–170；“宁可少写”改为只约束单条正文精度，不再暗示少记事实；人物首次出现/换人接手/称呼变化必须单独成条。

### 整理可靠性

- **回执以库 diff 为权威**：本窗新建后再 update、重试重复引用已落库 id、active 条目被写成 held，都不再让整份回执作废；仍拦“引用不存在的 id”和“声称写了但库里零变化”。
- **`snapshot-failed` 不再算完成**：失败上限只约束自动触发，`force: true` 的手动/评测重试可以越过；评测端遇到 `snapshot-failed` 直接报错，不再静默截断游标。
- **held 语义放宽**：`pending_review` 或带 `conflictingWith` / `duplicateOf` / `reviewReason` 都算“暂扣证据”，不再要求必须是 `pending_review`。

### 门禁

- `npm test`：**1532 tests / 1530 pass / 0 fail / 2 skipped**；`node scripts/acceptance-local.mjs`：**50/50**；`npm run check`：全部通过。

## [1.2.9] - 2026-11-07

> 召回质量与运维硬化：本地词法腿换 BM25、槽位感知去重；图扩展只补空位、事实账本排序；记忆包校验/整批回滚、删除可预演可恢复、绑定与向量代际 GC；并修复大屏/全屏 MemU WebUI 切换记忆库时的闪烁与卡片丢失。无新增 LLM 调用、提示词或注入 token，topK 与预算默认值不变。

### 召回与去重

- **本地 BM25 词法腿**（`lib/text-retrieval.js` / `lib/memory.js`）：本地 `localRecall` 的 `includes` 计数换成 BM25（IDF、长度归一、dfCap、按库语料缓存，60s TTL 兜底外部编辑）；`DSH_MEMU_RECALL_LEXICAL=includes` 可回退旧口径。对照：8 个罕见词 MRR 0.188→1.000、Recall@5 2/8→8/8；2000 条语料 p95 +4%。
- **槽位感知去重**（`lib/text-similarity.js`）：数字/日期/时间/星期/引号人名形成槽位签名；槽位不同不再按近重复折叠，子集视为补充、替换/不相交视为冲突。否定口径仍由 `findConflict` 判断，避免「免费 / 不用付费」这类误报。
- **预算内图扩展**：关联扩展只填未满的 topK 座位，topK 已满时不再追加，不增加注入 token。
- **事实账本**：写入派生 `fact_authority` / `fact_evidence`；冲突卡只按 authority → observed_at → id 调整 A/B 顺序，不增加卡片文字。
- **可选动态阈值**：`cutWeakScores` 支持 percentile，仅 `DSH_MEMU_RECALL_PERCENTILE=1` 启用，默认关闭，且不会保底塞满。

### 数据安全与生命周期

- **记忆包完整性**：v2 包 `memories.json` 写 SHA-256，导入强制校验；旧 v1 包保持可导入。导入批次记录 `bundleId`，`importMemories({ revertBatchId })` 可整批回滚。
- **删除可预演/可恢复**：`deleteMemory({ preview: true })` 只返回计划；永久删除写本地 `.deleted.json` 撤销缓冲，`restore: true` 恢复为 active；同时清理其他条目的 `duplicateOf`。撤销缓冲不进入备份。
- **向量降级**：managed-local 提交失败时仍写索引并标 `vectorPending`，下一次成功提交自动清除，不再出现「索引成功但向量永远缺席」的静默状态。
- **关系生命周期**：关系快照增加 `retention_strength` / `last_access_at` / `next_review_at`；关系 history 上限 50。
- **GC 工具**：`state.pruneSessionBindings`（默认 dry-run）+ `scripts/prune-sessions.mjs`；`vectorGcCandidates` / `pruneVectorArtifacts`（保留活动与待切换路径、最后 N 代、时间窗）+ `scripts/prune-vectors.mjs`，默认 dry-run，显式确认才删除。

### 稳定性与性能

- 下载/安装 fetch 增加总超时；备份与引擎切换改用异步子进程，不再用 `spawnSync` 冻结事件循环。
- 整理簇构建增加 dfCap，消除 N=500 时的 O(N²) 卡顿；MMR 只在命中集合上运行，空查询不再返回全库。
- 召回缓存键修正，避免每轮必然失效；本地词料缓存按库失效。
- `clearActivityLog` 要求 `confirmed: true`；永久删除不再让正文通过自动备份扩散。

### 界面

- **修复全屏/最大化 MemU WebUI 切换记忆库后鼠标移动闪烁、卡片成片消失**：墙卡片移除逐卡 `backdrop-filter`，屏外行改用 `content-visibility`；覆盖层去掉全屏 `backdrop-filter` 并使用不透明主题底色；鼠标聚光灯只在独立标签页启用，且只更新聚光灯元素，不再整文档失效样式。
- 记忆墙/浏览器/复核/统计的请求加单调代次，快速切换记忆库后旧响应不会覆盖新结果；403 回退不再把用户刚选的新库改回第一个库。
- 记忆设置页所有布尔勾选统一为开关；跨库召回说明收进开关同一行的短提示（完整说明在悬停提示里）；图片描述服务改为与其他设置一致的字段布局。
- 设置保存失败不再把失败值写回后续心跳快照，改为「未保存」标记 + 重试/丢弃；901–1120px 导航遮挡、卡片圆角、宿主颜色 token 与稳定 key 等界面问题一并修正。

### 门禁

- `npm test`：**1524 tests / 1522 pass / 0 fail / 2 skipped**；`node scripts/acceptance-local.mjs`：**50/50**；`npm run check`：全部通过。
- 未新增任何 LLM 调用、rerank、提示词或注入 token；`anchorTokens` / `turnTokens` / `injectionTotalTokens` / topK 默认值不变。

## [1.2.8] - 2026-11-06

> 记忆语义升级：时间落绝对日期、同一事实保留多版本、说话人/来源可区分、承诺可追踪；召回按查询意图取数，注入按边界过滤。另修复本地向量「切换并重建」的 `residentRecord is not defined`。

### 时间、版本、来源与承诺

- **时间规范化（`lib/temporal.js`）**：写入时按本轮 `sceneTime`（其次 `context.occurredAt`）解析今天/明天/后天/下周X/月底/年初/N天后等相对日期，落 `event_time` / `observed_at` / `absolute_date` / `date_precision` / `date_source`；无法解析不猜，标 `date_precision=unknown`。原文保留在 `content`。`valid_from` / `valid_to` 作为可选有效窗口参与召回过滤；查询里的相对日期先解析成绝对日期再检索，时间题按 `absolute_date` 最近优先注入。
- **版本化事实（`lib/memory.js`）**：新条目落 `fact_key` 与 `version`。显式 `conflicts_with` 或同一显式 `fact_key` 的再次写入让新旧两条都保持 active、互指并成对召回，注入为一张 200 字内冲突卡；显式 `supersedes` 才退休旧条（正文与标题不删，落 `valid_to`）。兼容补充仍走 `memu_private_update`，保留原 id。旧的无关系字段冲突仍进 `pending_review`。
- **说话人与来源**：新增 `speaker_id` / `source_kind` / `quote_span` / `storyline_id` / `branch_id` / `known_by`；来源枚举增加 `assistant_said` 与 `tool`。助手自己的承诺和计划不再被记成用户原话；查询「我说过/你说过/他说的」按 speaker 过滤，缺字段的旧条目保留。
- **承诺与 open loop（`lib/commitment.js`）**：新增 `commitment = {counterparty, action, due_at, status, closed_by, evidence_seq}`，`status` 为权威，`open_loop` 兼容跟随。逾期/今天/明天到期的未完成承诺最多 3 条按 `due_at` 注入；`dueOpenLoops` 也以 commitment 为准。

### 召回、注入与提示词

- **查询意图（`detectQueryIntent` / `decomposeQuery`）**：区分 `date` / `entity` / `conflict` / `commitment` / `boundary` / `general`，拆分绝对日期与引号/`@`/已知实体名；按意图提高候选上限（时间/实体 8、冲突 6、承诺/边界 5，封顶 20）。命中条目沿显式 `links` 扩展一跳。
- **注入边界**：`never_say` 不再进入任何自动注入面（锚点、自动召回、纪念日/到期提醒、cue）；`only_if_asked` 只在 boundary 意图的查询里自动放行；显式 `memu_private_recall` 仍可读两者。
- **提示词**：RP guide/policy/consolidation 与整理 worker 任务书补上绝对日期、`conflicts_with` / `supersedes`、`speaker_id` / `source_kind`、`commitment` 与「助手说过的话也要写」的字段要求。
- **可观测性**：召回缓存增加 `staleSkipped`，`getState` 暴露 `recallCache` 段（hits/misses/evictions/errors/staleSkipped）。

### 修复与稳定性

- **修复：本地向量「切换并重建」必报 `residentRecord is not defined`**——`lib/memu.js` 的常驻引擎进程级单例从 1.2.6 起只在 `stopResident` / `ensureResident` / `closeMemuResident` 等处被引用、却漏了模块级声明；ESM 严格模式下只有真正拉起 resident 进程时才抛 `ReferenceError`，普通召回与状态读取不触发。修复为模块顶部的 `let residentRecord = null`，新增 `tests/memu-resident.test.mjs`（声明位置守卫 + close/prewarm 不再抛错）。
- 整理等待预算下限从 180s 调整到 420s，慢推理模型的单次 worker 回合不会必然撞墙；上限仍为 600s。
- 本地向量切换支持显式 `force`：同一个 profile 已 active 时也可重建一代，用于库集合变化后把索引追平；`switchLocalVectorProfile` 与 RPC 均透传。
- 整理触发支持显式 `force` / `trigger`：手动按钮仍强制，积压口径可用 `trigger=backlog` 验证水位触发。
- 整理回执 `heldIds` 恢复「仅 pending_review」口径；已 active 的矛盾条目应放进 `createdIds/updatedIds`。

### 评测

- 全量 **1473 tests / 1471 pass / 0 fail / 2 skipped**、acceptance 50/50、`npm run check` 全绿。
- 升级兼容：旧条目缺新字段按空处理，不强制迁移；`disclosure` 行为有变（`never_say` / `only_if_asked` 不再自动注入），需要它们自动出现的旧用法请改回 `can_tell`。

## [1.2.7] - 2026-11-06

> 召回管线升级（分层分词、动态融合、召回缓存、子句级冲突检测）+ 整理模型可选（宿主 provider 或自定义接入点）+ 设置页分组重构 + 修复 0.2.2-rc.1 整理 fork 种子校验拒绝。

### 召回管线升级（P0/P1）

- **智能分词器（`lib/tokenizer-v2.js`）**：CJK unigram+bigram+trigram 三层特征 + 日期/数字/邮箱/URL 实体保护（数字边界规则：紧邻标识符的数字不拆出噪声 token）。**分层消费纪律**：三层 token 只进 BM25 的 tf/idf 流；idf 盲集合运算（blocking 共享计数、`tokenJaccard`、候选簇倒排）固定 V1 口径（bigram+latin）——unigram 对 idf 盲通道是稀释源，实测混用时 Recall@10 掉 13 个百分点。双轨开关 `TOKENIZER_V2` 默认开，关闭路径字节级不变。
- **动态 RRF 权重（`computeRRFWeights`）**：近期语义词查询启用第四路 recency 排名（`{bm25:0.3, dice:0.3, entity:0.2, recency:0.2}`），coding 域 entity 提权；每通道 clamp [0.05,0.6] 后归一化，异常输入回退静态。开关 `RRF_DYNAMIC` 默认开；候选簇构建保持静态三路。
- **RRF 切片边界带**：`rankPairCandidates` 前 20 切片的准入从 RRF 代理换 pairScore 真尺——与切点 rrf 之差 ≤`RRF_SLICE_BAND`(2.5e-4) 的候选并入评分集（≤`RRF_SLICE_BAND_CAP`×max），按真分数终选。修复近重复簇里 len 归一噪声把 pairScore 更优候选挤出切片的刀锋误伤。
- **召回缓存（`lib/recall-cache.js`）**：`managedRecall` 成功语义召回段进程内 LRU（256 条 / 120s），键含 `memoryRevision()`（全部索引/状态落盘自增，写后无 stale）+ 向量代数 + domain/sessionId/context 等九分量；fail-open + `warn` 留痕，降级/fallback 结果一律不缓存。显式召回命中率 ~0 属正确行为（touchAccess 参与 decay 加成）。文档见 `docs/memory-semantics.md` §8.12。
- **冲突检测增强**：新增 `polarityAt` 子句级否定作用域（双重否定、对比结构分段、无关子句隔离），`globalConflictCheck` 改用共享锚点双侧极性对比（无共享词回退整文本口径）；修复「截止日期 5月1日，别忘了」类无关子句否定与「不是不喜欢」双重否定两类误报。`negationPolarity` 原口径与导出不变。
- **修复：整理 fork 在 DSH 0.2.2-rc.1 上必挂**——rc.1 的种子校验（`assertAssistantSettlementShape`）要求 `assistant/message.data.stream` 是数组，而插件种子清噪曾直接删除该字段，导致 0.2.2-rc.1 上每个整理 fork 种子被拒（"invalid settlement fields"；**1.2.6 已发布版同样中招**——`host-adaptation.md` §5.4 声明的未测面被内部真机评测实证）。修复：种子携带**空 stream 数组**（清噪初衷不变——分块日志不进种子；旧宿主不校验该字段，惰性兼容）。新增 `scripts/check-seed-compat.mjs`（用目标宿主自己的 dsh-session 包验证种子兼容性），列入宿主适配检查表必跑项。
- **守卫**：新增 4 个测试文件共 58 条（tokenizer-v2 17、dynamic-rrf 11、recall-cache 14、negation-polarity 14、边界带守卫 2）；阈值常量零改动。

### RP/混合提示词：生活日常采集线

- **寒暄口径收紧为「寒暄不留，寒暄里夹的事实要留」**：对方主动说出的现实生活事实（作息、行程、口味、健康、家人朋友、正在忙的事）要求独立成条——`owner=about_user`、30–80 字平实短条、不需要「瞬间+影响」模板；剧情与现实条分开写、不互相合并吸收。单次提及低 confidence 或 `short_term`，重复出现才升 `long_term`；「一次客套不推导长期偏好」护栏原样保留。
- **落点**：`private-policy.rp.md`（写入口径）、`private-consolidation.rp.md`（整理采集线）及各自 `.mixed` 变体；`docs/memory-semantics.md` §8.5 同步口径。
- **动机**：真机会话核查（QQ 陪伴场景）发现日常事实被三道闸门里的前两道拦掉（写入口径的「瞬间」标准、整理稿的活人感框架）；第三道注入偏置是刻意设计不动，靠本版分词升级（P0-1）改善生活事实的主题召回。
- **守卫**：`tests/prompts.test.mjs`（变体加载/回退）与 `tests/doc-drift.test.mjs` 通过；提示词默认哈希启动时现算，已自定义提示词的安装会在下次启动标记 `defaultUpdated` 供复核。

## [1.2.6] - 2026-11-05

> 一版「宿主适配」：在 DSH `0.2.2-rc.1` 上完成真机核对，核心行为无需改动；旧宿主（`0.2.0`–`0.2.1`）的会话级 schedule API 现在被结构性识别并明确跳过，不再每 5 分钟刷一条失败日志。新增 `docs/host-adaptation.md`，把下一次宿主升级变成一份可重复的检查表。

### DSH 0.2.2-rc.1 适配

- **真机核对**（launcher 的 `versions/0.2.2-rc.1` + 独立 home）：13 个 `memu_*` 工具进入 `request/header`；`<memory-guide>` 首轮注入 1 次；`turn/end` 为 `completed`；设置页「MemU 记忆」、右侧栏「MemU 记忆」、新会话弹窗、`/dsh-memu-memory` RPC 全部正常；浏览器控制台 0 error、0 warning。
- **源码面**：`0.2.2-alpha.3 → 0.2.2-rc.1` 在 memu 用到的宿主 `src` 上零改动；rc.1 的 cordis 4.1 / timer 1.2 / include 1.1 升级没有影响本插件。工具 DSL、`agent/pre-step`、`sessionQuery`、`subagents.startActivation`、`attachments.readImage`、客户端 slots / sessions / RPC 契约均保持兼容。
- **`ctx.schedule` 有两代 API**：`0.2.2+` 是宿主级任务表（`create(request)` / `list→{items}` / `edit`），`0.2.0–0.2.1` 是会话级提醒（`create(sessionId,request)` / `list({sessionId})` / `delete`）。新增 `scheduleFlavor()` 结构探测：旧宿主上 `runSalientWakePass()` 返回 `{skipped:'schedule-api'}`、写一条 `stage:'schedule-api'` 的活动日志并只 warn 一次；被动注入不受影响。
- **文档**：新增 `docs/host-adaptation.md`（事实来源、memu 的宿主面清单、检查流程、隔离真机搭法、0.2.2-rc.1 实测记录、踩坑）；`docs/host-api.md` §6.6 更正 schedule 的版本事实并新增 §6.9 版本记录；`docs/troubleshooting.md` §3.21 补 `schedule-api` 降级口径；`AGENTS.md` 索引与硬规则同步。
- **守卫**：`tests/salient-wake.test.mjs` 新增「旧会话级 API 只 warn 一次且一次都不调用」与 `scheduleFlavor()` 两种形状两条用例，共 19 条。

### 本地向量模式常驻 MemU 引擎

- `memoryBackend=api` 且 `vectorSource=local` 时，`lib/memu.js` 只启动一个常驻 Python 解释器：`import memu.cli` 付一次，之后 `retrieve` / `list-files` / `commit` 通过 JSON 行协议复用，去掉每条命令约 2 s 的导入链；每条命令结束显式 `database.close()`，空闲期不占 sqlite 句柄。
- 远端 API 路由不变（每条命令一个进程）。插件卸载、引擎安装/切换前关闭常驻进程；进程异常退出后下一条命令冷启动，召回照旧 fail-open。

### 私有整理：增量窗口、水位触发与清噪

- **不再整段重种**：`requestPrivateConsolidation` 每次只取 `lastSleepSeq` 之后的增量，切成 ≤300 事件、尾部对齐完整回合的一窗（`selectConsolidationWindow`）；`lastSleepSeq` 随回执前进，剩余事件留给下一次扫描。56 回合、3233 事件的群聊不再每次重读全史。
- **种子清噪 + 已有记忆目录**：`compactSeedEvents` 只保留真人消息 / 助手正文 / 工具调用与结果，删 reasoning、`source.replayState`、`data.stream`、插件召回、`runtime-context`、`request/header`；工具结果截 1600 字、重复输出只留一份；窗口开头插 `[memory-catalog]`（id + 标题 + layer + status）供 worker 去重/合并。
- **水位触发**：`runSleepPass` 新增「pending ≥ 200 事件」的 backlog 腿和 15 分钟一次的探针腿，不再只等空闲；候选排序 backlog → idle → probe。`sleepAfterIdleMinutes` 默认 3 → **2**。
- **small-talk 结案**：`small-talk` / `no-human-turn` / `no-new-events` 返回 `settled: true` 并推进 `lastSleepAt`，不再每 5 分钟重扫同一段寒暄；政策跳过不计入 `ran`。
- **失败上限**：`failJob` 按窗口 `snapshotHash` 记失败次数；连续 2 次后返回 `skipped: 'snapshot-failed'`，同段转录不再无限重跑，新事件会改变哈希重新获得机会。
- **守卫**：`tests/consolidation-fork.test.mjs` 新增 seed 清噪、窗口切分、失败上限三条；`tests/cycle.test.mjs` 的寒暄用例改为断言终态。

### 验证口径（本机 2026-11-05 实测）

`npm test` 1349 tests / 1347 pass / 0 fail / 2 skipped；`acceptance-local` 50/50；`npm run check` 全绿。真机：0.2.2-rc.1 headless + mock LLM 一轮，13 个 `memu_*` 工具、guide=1、`turn/end completed`；web 页面 boot graph 含 `dsh-memu-memory`，设置页与右侧栏均出现「MemU 记忆」。未测：0.2.2 桌面壳、全局整理/历史 fork 的完整真机作业、日期唤醒的真实到点投递。

---

## [1.2.5] - 2026-11-05

> 一版把「同一个开关到底管多大一片」讲清楚：跨库召回不再只管记忆——词典的锚点摘要、本回合匹配与 `memu_lexicon_search` 走同一条作用域，并新增一本**全局词典**；节点图的范围选择器加上全局记忆。另一侧是本地向量运行时的下载体验：npmjs / npmmirror 双源、百分比与 MB/s、暂停 / 停止 / 续传。RPC 方法数仍是 **95**（全局图与全局词典都复用既有端点，加的是 payload 而不是方法）。

### 跨库召回：记忆与词典一条尺子（§8.15 / §8.16，默认关闭）

- `settings.crossLibraryRecall` 打开后，`privateRecall` 合并**同领域**的其它私有库候选；自动召回、`memu_private_recall`、`memu_private_list` 与侧栏私有列表同一套作用域。候选库资格：至少一个非整理 fork 会话绑定且 `domainOf()` 等于当前领域、文件夹 `useLibrary` 没关、库未归档；当前绑定库始终参与且不按 domain 过滤。逐库候选用 RRF（k=60）合并，命中带 `libraryId`，`touchAccessMany` 与统计按所属库分组落账——否则那本库的热度永远记不到头上。
- 新写入的私有词条落 `domain` 戳（记忆与词典同一来源：`domainOf(binding)`）；戳之前的旧条目按「该库的绑定会话领域已匹配」放行。显式传 `libraryId` 的库浏览仍只看那一本，否则「我正在看哪个库」没有答案。`memu_private_update` / `archive` / `delete` 只解析当前库，跨库命中标 `library=…（跨库只读）`，避免把「查不到」读成「被删了」。
- **词典跟上了同一条作用域**（这是 1.2.4 那次改动漏掉的另一半）：新增 `lib/lexicon-scope.js` 一处回答「这个会话看得见哪些词典」= 当前库 → 同域其它库 → 全局词典，候选库资格直接复用 `crossLibrarySources`，所以不会出现「记忆跨文件夹、词典不跨」的半套同步。B 通道跨源命中用词典核心的 `rankLexiconHits` 重排（排序尺子仍只有那一把），同词面**私有压全局**、注入里一行不重复；candidate / injection 计数按词条所属词典分别落库。
- **全局词典**（`data/lexicon/global.json`，保留存储名 `global`，与 `index/global.json` 对齐；私有库 id 恒为 `lib_<hex>`，撞不上）：与全局记忆同构——每个会话都读得到，**只有用户能写**。全局 curator 见到词典 op 照旧拒绝，`memu_lexicon_propose` 没有全局路径（§1 硬规则二）。它不看跨库开关，只看 `useGlobal` 天花板；私有记忆整个关掉时，这一页只剩全局词典。条目过滤复用 `appliesToDomain`（`universal` / `personal` 恒可见，无 domain 按通用处理）。
- 坏一本不塌整段：辅源（同域库、全局词典）读失败只降级成 `errors` 并落 `lastRecallError`（`lexicon: degraded lexicon sources: …`），主源读失败继续抛给既有的 fail-open。没有降级时返回体与单库时代逐字节一致。
- 全局词典**不走库级授权**：`authorizeGlobalLexiconRoute` 与 `listGlobal` / `removeGlobalLink` 同规格由 HTTP 边界把关，绝不要求宿主 `authorizeLibrary` 去授权一本根本不存在的库；带会话的请求仍认凭证（会话存在 + 全局层没被关掉），悬空 sessionId 一律 403。

### WebUI

- 词典页范围选择器加「全局词典」第一项（照搬节点图全局视图的写法，不新增第二套控件），并写清口径差异：**页是浏览面，选一本看一本**，合并只发生在注入与模型检索。没有私有库时这一页照样可用（全局词典由用户手写，不依赖任何库）；全局词条跳记忆墙时 `libraryId` 落回 `null`，不把保留字当库 id。
- 节点图范围选择器加**全局记忆**：`getGraph({ scope: 'global' })` 读 `global.json` 的 `entries[id].links[]`，节点是全局条目（`kind: 'global'`，独立配色 `#8b7bd8`），`suppressed` / `expired` 隐藏、指向已删除目标的边保留占位节点；全局视图只读，移除边仍在全局记忆列表完成。
- 本地向量运行时：下载源可选 npmjs / npmmirror（每个源都必须返回 catalog pin 住的 `bytes`/`sha256`，**换源不换向量空间**），进度带百分比、已下载/总量与实时 MB/s（后端没给速度时前端按相邻采样算），支持暂停 / 停止 / 继续；已下字节留在 `<runtimeRoot>/.cache/*.part`，换源或重启后按 HTTP `Range` 从偏移续传。同指纹的 pending 账本还多了 `manifestDigest` 校验——目录改了制品清单就不续旧账，起新一代（否则到 `syncShadowImpl` 才炸）。
- 打开某文件夹的私有记忆开关时会顺手补建/接管库，并把该文件夹里「已 opting-in 却没有库」的历史会话回填上；单个会话把 `useLibrary` 打开同样走 `ensureLibraryForCwd`，不再留下 `libraryId` 永远为空的绑定。全局提炼的会话选择器按 `workspaceRegistry` 的归档集合与工作区成员过滤，已删除的对话不再能被选去提炼。
- 侧栏私有行与 `listPrivate` 支持 `limit` / `previewChars`（首屏仍只 1 个 RPC、不发全文请求）；跨库时私有行带库名 Tag。

### 修掉一个能把整批注入打死的 fail-open 自伤

`injectInboundForStep` 把 `let lexiconError = null` 写在锚点段之后，而锚点的 `catch` 在它之前赋值 → 命中 TDZ：**词典文件一坏，`catch` 自己抛 `ReferenceError`，整批 inbound 注入没投出去**（决策路径那份声明在前，所以只有 inbound 撞）。声明已提前，并写进 `docs/troubleshooting.md` 的改动注意。

### 守卫与文档

- 新增 `tests/lexicon-scope.test.mjs`（16 条：源序与优先级、`useGlobal`/`useLibrary` 两层天花板、条目级 domain、`appliesToDomain`、词面去重、计数分库、辅源降级留信号、主源抛错、备份同权、模型侧只读标注、领域戳）；`tests/webui-auth.test.mjs` 加全局词典授权 1 条；`tests/lexicon-ui.test.mjs` 加「前后端把全局 id 拼成同一个字符串」的防漂移 1 条；`tests/cross-library-recall.test.mjs`、`tests/global-graph.test.mjs`（新）、`tests/embedding-runtime.test.mjs`、`tests/vector-migration.test.mjs`、`tests/browser.test.mjs`、`tests/client-render.test.mjs`、`tests/settings-plumbing.test.mjs` 随改动扩。
- 文档：`docs/memory-semantics.md` 新增 §8.16（词典作用域）并回指 §8.13 / §8.15 / §8.4；`docs/troubleshooting.md` 补跨库与全局词典四条症状 + 授权模型一条；`docs/env-and-commands.md` §9.5 补下载源与续传；README / README.zh 两页表行同步。
- 验证口径（本机 2026-11-05 实测）：`npm test` 1343 tests / 1341 pass / 0 fail / 2 skipped（两条真实引擎用例按设计跳过），`acceptance-local` 50/50，`npm run check` 全绿（含 rpc-method-count 95、i18n、AGENTS.md 预算）。**已知待办，非本版引入**：`npm run test:chain` 的 manual / idle 六格与 `npm run replay` 的 5 个检查点，在 1.2.4 的干净代码副本上复现同样结果（整理凭证与空闲 sweep 的 harness 侧问题），本版未动它们。

---

## [1.2.4] - 2026-11-02

> 一整版「量具 + 适配」：注入实测台补上离线可复现的那一半并修掉真机抓出的 §3.24 缺口；本地向量从 1 个模型扩到 5 个（新增 MiniLM、e5、Qwen3 int8/q4f16 两张卡），补上非对称前缀需要的角色通道与下载来源选择；整理超时改为按转录规模推预算；总日志里的失败行终于像失败（红色只在 WebUI 总日志页；侧栏整理记录只留正常流水，失败由「整理提醒」负责）。不加依赖、不加构建步骤；`bge-small-zh-v1.5-int8` 的 manifest 一个字节未改。

### 两条目录条目从 pending 转为可用

- `all-minilm-l6-v2-int8`（23.9 MB，384 维，mean + L2）与 `multilingual-e5-small`（135.4 MB，384 维，mean + L2）现在带着固定 commit、逐文件 `bytes/sha256`、图描述符（opset 11 / 3 个 int64 输入 / `last_hidden_state float32[batch,seq,384]` / 自包含）、量化事实与许可证来源。这三条仍只固定 ModelScope 的 revision（2026-10-30 的核实口径：当时 `huggingface.co` 超时、`hf-mirror` 没取到可核对的固定 commit，所以其余来源保持「不生成 URL」）。2026-11-02 复查发现 **hf-mirror 其实可用**（它重定向到自己的 resolve-cache，不经过 huggingface.co，两条 Qwen3 卡片就走它），但没有回填到这三条：换源不是免费的，要重新逐字节核对一遍 hash，而那三条的 ModelScope 源本来就在正常工作。
- 每条事实都有出处，不写推测值：pooling 取自官方仓库的 `1_Pooling/config.json`（作为 `origin` 固定的见证制品，不冒充导出仓库），`mean_tokens=true` 且 `word_embedding_dimension=384`；量化方案对两个图都做了结构核验——`MatMulInteger` + `DynamicQuantizeLinear`，且 MiniLM 39/39、e5 75/75 个 int8/uint8 二维权重都存在长度=输出通道数的一维 float32 scale（标量 scale=0），即 per-channel 权重 + 动态激活量化；e5 另有仓库自带的 `quant_config.json` 佐证 `reduce_range=true`。
- `maxTokens` 按制品本身取 512（`config.max_position_embeddings`、`tokenizer_config.model_max_length`、图输出维度三处一致），不按 sentence-transformers wrapper 的 `max_seq_length=256` 收窄——那只是 SB 的窗口，写进目录会把分窗口径变成模型属性。参数量同样来自图内 initializer 元素计数（22,565,376 / 117,505,920），不是模型页上的约数。
- 三条 `runtime` 事实抽出成共享的 `PINNED_ONNX_RUNTIME`：三个模型 pin 的是同一棵受管 ORT 树，复制三遍只会让哪天改漏一份。改动前后 `bge-small-zh-v1.5-int8` 的 `profileFingerprint` 与 `manifestDigest` 逐字节相同（`47511436…` / `c18f4719…`），已装好的 BGE 库不会因此对不上号。

### 非对称前缀需要角色通道，而不是猜（§14.4 / §14.8）

- worker 此前完全不施加 `manifest.prefixes`，所以 e5 这类模型即使装了也会用错读法。现在前缀由 worker 按请求角色施加，角色走 model 字符串后缀（`:query` / `:passage`）：MemU 的信封只有 `{model, input, encoding_format}`，没有 role 字段，而**知道这条文本是查询还是被存进的条目的一方只有启动子进程的插件**，所以 `retrieve` 注入 `:query`、`commit` / `list-files` 注入 `:passage`。
- 裸 model id 对非对称 profile 一律 400 `LOCAL_VECTOR_ROLE_REQUIRED`，不"默认成文档"：默认错一边就得到一个指纹声称不是这个空间的向量空间，而 HTTP 还是 200。是否要角色由 `prefixesRequireRole(entry)`（即 `prefixes.query !== prefixes.document`）派生，前缀本身在指纹里，因此不引入第二个可配置开关。BGE/MiniLM 两侧同前缀，行为与请求字节完全不变。
- `prefixesRequireRole` 只从前缀派生；`/health` 现在报告 `rolesRequired`，worker endpoint 也把它带回给调用方，`healthCheckLocalVector` 用文档角色探测。
- 实测过再写进目录：`query:` 与 `passage:` 下同一句话的余弦 0.9811（确实是两个向量），前缀策略 A/B（同一份草稿）asym R@1 0.6667 / MRR 0.8182 / 分离度 0.1230，sym-passage 0.6364 / 0.8030 / 0.0867，sym-query 0.6667 / 0.8157 / 0.1155，无前缀 0.6364 / 0.8030 / 0.1139。差异只有一个样本量级，所以结论是"对称前缀不是不能活，而是没有理由用一个更差的"，不是"非对称被证明显著更好"。
- 真机端到端（隔离 home + junction 复用已装引擎与制品，不碰真实记忆库）：`MiniLM(g1) → e5(g2) → BGE(g3)` 三次切换各 6/6 条重建、0 失败，库文件名带各自指纹+代际（`global.<fp8>.g<n>.sqlite3`），切换后中英查询均召回，回滚回到上一空间。这一跑同时坐实了 MemU 会把带后缀的 model 原样回传（`memu/embedding/backends/openai.py` 发 `{"model": embed_model, "input": inputs}`）。

### 守卫与界面

- `tests/embedding-catalog.test.mjs`：三条目的指纹钉死（改目录必须是有意识地来这里更新）；新增"两条已核实条目"与"只有非对称前缀需要角色通道"两组断言；pending 的口径改用合成条目验证。
- 新增 `tests/local-embedding-env.test.mjs`（3 条）：角色→model 字符串的映射、对称模型逐字节不变、strict-local 信封未被角色改动带走。`tests/local-embedding-worker.test.mjs` 加 1 条：前缀确实到达推理、裸 id 被拒且**没有进推理**、`/health` 报告 `rolesRequired`。`tests/local-embedding-protocol.test.mjs` 加 1 条角色解析与拒绝。`tests/embedding-runtime.test.mjs` 的"完整运行时"断言从只看 BGE 扩成遍历三条目 × 五个平台。
- 设置页模型卡多一个语言 Tag（`en` / `zh · en · multilingual`），因为现在有三条可选，"这只在英文上强"是选择时必须看得见的信息；`getLocalVectorState().catalog` 随之透出 `languages` 与 `rolesRequired`。
- 文档：`docs/env-and-commands.md` 新增 §9.5.1（三条模型的制品事实、实测横向对照、角色通道的为什么与命令）。

### Qwen3-Embedding-0.6B 两张卡片（int8 默认 + q4f16）

- 目录新增 `qwen3-embedding-0.6b-int8`（`onnx/model_quantized.onnx`，600.2 MB，默认下载的那张）与 `qwen3-embedding-0.6b-q4f16`（541.8 MB）。逐文件 `bytes/sha256` 与 HF 文件树的 `lfs.oid` 逐字节对上；图头是 opset 21、只有 `input_ids` + `attention_mask`（因果 LM 没有 `token_type_ids`）、输出 `last_hidden_state[1, sequence_length, 1024]`——**batch 维是导出时写死的 1**，所以一次只能喂一行。
- **两种量化 = 两个向量空间 = 两张卡片**：int8 是 `quantize_dynamic`，图侧核实 196/196 个 `MatMulInteger` 的 scale/zero_point 都是 rank-0 标量、per-channel scale 向量为 0 → **per-tensor**，与 BGE/MiniLM/e5 的 per-channel 不是同一个空间；q4f16 是 `com.microsoft.MatMulNBits`（int4、block_size=128）+ float16 激活、图输出 dtype 也是 float16。`quantization` 进指纹，所以分条目、分 DB，不许一个条目挂两个图文件让用户以为能混用。
- 新增 **last-token pooling**（`pooling: 'last'`）：因果 LM 按 `attention_mask` 累加和定位最后一个非 pad token，与官方 `1_Pooling(pooling_mode_lasttoken=true)` 同口径。校验器的 pooling 白名单加 `last`（`max` 仍是「可以声明、执行侧没实现」，所以没有任何 available 条目用它）。
- 窗口与上限：`maxTokens` 合法范围从 8192 放宽到 32768（Qwen3 制品的 `max_position_embeddings`），但卡片按实测延迟取 **4096**——1520 字实测已 4.29 s，按 32k 跑一条长记忆会直接顶到 worker 的 120 s 请求超时。`verifyStagedArtifacts` 因此从「窗口必须等于制品上限」改成「不得超过制品上限」：超过必炸，小于是指纹里写明的策略。单文件下载上限 512 MiB → 1 GiB（否则装不下这条已逐字节核实的 600 MB 制品）。
- 查询侧用官方 `Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:` 前缀、document 侧官方明确不加指令 → 非对称，复用上一节那条角色通道，无需新概念。实测同一句话加/不加前缀余弦只有 **0.8284**（q4f16 0.8203），比 e5 的 0.9811 挪动得多——前缀在这款模型上是真的换空间。
- 实测（同一批文本、同一棵受管 ORT 树，五行可以直接比）：加载 int8 2.06 s / q4f16 11.4 s；一次编码 29 / 380 / 1520 字 = int8 91 / 437 / 4286 ms，q4f16 110 / 870 / 5863 ms，而 BGE 是 5 / 17 / 22 ms。草稿集（33 条可答）int8 带前缀 R@1 0.6970 / MRR 0.8359、裸文本 0.6667 / 0.8081；q4f16 带前缀 0.7273 / 0.8510。**q4f16 没有比 int8 差**，差一个样本不足以排质量；能当依据的只有加载慢 5.5 倍与贡献算子依赖，所以默认仍是 int8。
- 真机端到端：五路互切 `MiniLM(g1) → Qwen3-int8(g2) → Qwen3-q4f16(g3) → e5(g4) → BGE(g5)` 各 6/6 条重建、0 失败，每个代际一份指纹命名的库，切换后中英查询均召回，回滚回到上一空间。

### 整理超时不再是必然事件：预算随转录规模走

- 真实读数（2026-11-02，935 条事件的会话）：整理 fork 开始后 **125 s 才写出第一条记忆**，180 s 到点只写完 3 条 → 超时；退避重试 131 s 完成。**不是卡死，也没丢东西**——那 3 条在 `index/lib_256e5cb7.json` 与向量库里都核到了。根因是 fork 的种子是整段会话，worker 读完整段才开始写，而预算是写死的 180 s。
- 现在按范围推：`consolidationWaitBudget(eventCount)` = `120 s + 0.35 s/事件`，夹在 `[180 s, 600 s]`（斜率取自实测的 0.14–0.2 s/事件，留约 2 倍余量）。小会话仍是 3 分钟，935 条拿到 447 s，再大也不会超过 10 分钟——卡死的 fork 仍然会被收掉。显式 `maxWaitMs` 的调用方行为完全不变（既有 30 ms 超时用例照旧过）。
- 可见性：`整理已开始` 日志带上「预算 Ns」，超时文案带上「over N events」，失败行用上一节的红色 + `失败` 标签——下次看到就能判断是不是范围太大。
- 明确没做的事：**超时仍然不推进 `lastSleepSeq`**。没有回执就不能证明覆盖了哪一段，重试必须重读同一段；为了省时间改成部分推进等于可能漏事件，不做。
- 守卫：`tests/consolidation-fork.test.mjs` 新增预算缩放用例（0/100/200/935/5000/非法值）。
### 总日志里的失败行终于像失败了

- 现象：WebUI ›「全部日志」里，整理超时/失败与正常流水**长得一模一样**。判据写的是 `level === 'error'` 才上色，而活动日志的超时路径记的是 `level: 'warn'` + `ok: false`（`lib/private.js`），归一化器又只在没显式给 level 时才从 `ok===false` 推成 warn——于是这条真实失败永远走不到那个分支。
- 改成三档判定 `logRowState`：**失败**（`ok === false || level === 'error'`，红左边条 + 浅红底 + `失败` Tag）/ **降级**（`level === 'warn'` 且没失败，例如「向量未激活，写入已降级为索引+引擎」「自动关联跳过」，橙边 + `降级` Tag）/ 常规（不标）。失败与降级不同色是刻意的：都标红会让真失败被降级噪声淹没。
- **标红只发生在总日志页**。侧栏「整理记录」不再显示失败行（过滤掉，空态按过滤后算）——失败已经由它上方跨会话的「整理提醒」负责（可清除、可跳转），5 行摘要里再挤一遍红字只会把正常流水挤走。
- 不只靠颜色（配色对色觉障碍与灰度截图无效），Tag 带 hover 解释；样式走作用域 CSS `.dshm-logrow.is-failed` / `.is-degraded`，没有新增内联样式。
- 守卫：`tests/client-render.test.mjs` 新增一条行为用例（总日志页三行 fixture 分别断言 class 与文字标签，hover 必须存在）；静态断言钉住「侧栏先过滤失败行」「只有总日志页用 `logRowClass`」「旧的 `level === 'error' ? 'warn'` 不许回来」。做过变异验证：把判定改回只看 `level === 'error'` 时行为用例立刻红。
### 下载来源可选：默认 hf-mirror，源站可切

- `download(id, { provider })`：不传就取目录顺序里第一个已固定的来源（Qwen3 卡片因此默认 **hf-mirror**），传了就只用那一个、解析不出可用来源时如实报错而**不回退**到别的源。RPC `downloadLocalVectorModel` 透传 `provider`；设置页只在「有多于一个已固定来源」的卡片上给一行 `is-row` 选择，只有一个来源就不出现「选」这件事。换源不改向量空间——provider 不进指纹，每个文件落盘前都要过目录 pin 的同一个 `sha256`。
- 见证制品（基座仓库的 `1_Pooling/config.json`）原本绑死它被核实的那个 provider，换源会被这条规则整条封掉；新增 `origin.providers` 显式声明合法的镜像集合（默认仍是单 provider，三条老条目行为不变）。
- **第一次真装 Qwen3 抓到的真 bug**：hf-mirror 对小文件用 chunked 传输、**不发 `content-length`**，而下载器把 `Number(null) = 0` 当成「声明了 0 字节」，于是每个小文件都被误判成 `EMBEDDING_SIZE_MISMATCH`。现在头缺失等于「未知」，判断交给落盘的字节数与 sha256。第二个由测试抓到：`embedding-download.js` 用了 `PROVIDERS` 却没 import。
- 目录构建器顺手去掉一条自找麻烦的断言：`totalBytes` 只在**与文件之和不符**时报错——它本来就是同一份事实的两种写法，旧规则逼着手写清单里那条要么删掉要么预先算对。
- 文档：`docs/env-and-commands.md` §9.5.1 改为五行对照（含延迟列的同一批文本口径）并新增「下载来源」一段；`docs/troubleshooting.md` §3.25 覆盖 Qwen3 专属坑（固定 batch=1、贡献算子域、延迟、选源与 chunked 头）。
- 守卫：`tests/embedding-catalog.test.mjs`（五指纹钉死、两张 Qwen3 卡片是两个空间、默认来源必须是 hf-mirror 且源站同 commit 同 sha256）、`tests/embedding-download.test.mjs`（缺失 content-length 不误判、显式选源不回退、两种错码分开、last-pooling/float16/窗口上限的装机校验）、`tests/local-embedding-worker.test.mjs`（cls / mean / last 在同一份 hidden state 上各算各的，padding 不参与 last 的定位）。

### 注入离线模拟器

- 新增 `scripts/simulate-injection.mjs`（`npm run simulate:injection`，EVALUATION ONLY）：挂真实的 `registerInjection('agent/pre-step')`，在临时 `DSH_MEMU_HOME` 里播种一份「每种可注入块各有一条」的库——明天/今天/已过期的带日期未了之事、年度纪念日、含时效词的条目、四个月前的旧条目、近似重复的主题对——跑 N 轮，把每次组装好的请求打给只监听 127.0.0.1 的伪端点，产出 `report.md` / `mock-llm.jsonl` / `settings-snapshot.json` 与一行 JSON 摘要。
- 转录是**累积**的（已发过的插件消息留在上下文里，和宿主一样）。这不是省事：`ensureUnifiedGuide` 会检查 `decision.messages` 里有没有当前规则的 guide，历史里没有就每轮重投，`guide` 计数会变成 50/50 而不是 1/50——那种数只证明驱动写错了。
- 默认 `randomCueChance=0`（出货默认 0.02），让跑数可复现；`--cue` 可还原。`--turns/--home/--out/--port/--json`；退出码 `0` / `2` 用法错 / `3` **注入链路自己报了 warn**（模拟器把 warn 当失败，不当噪声）。
- 覆盖范围写死在文档与脚本头里：它量的是**插件决定了什么**，不含宿主的折叠与真实模型的 tool 轮；与真机（`scripts/drive-session.mjs`）对不上时以真机为准。
- 新增 `tests/simulate-injection.test.mjs`（3 条）：钉的是量具属性而非某次计数——guide 只在首轮一次、锚点只在首轮一次、标题卡 `body lines` 必须为 0、JSONL 里不许出现记忆正文或标题词、设置快照带 C/D 的读数口径、用法错误退码 2。
- 第一批离线基线（2026-11-01，50 轮，设置见快照：`autoInject=smart`、`dedupeTurns=16`、`turnTokens=800`、`injectionTotalTokens=2000`、`freshnessHint=on`、`freshnessDays=30`、`openLoopRemindDays=7`、`salientWake=off`）：注入 **18/50 轮（36%）**；按块的 Δ 计数 `guide 1 / anchor 1 / due 1 / anniversary 1 / texture 1 / openLoop 1 / context 18 / freshness 11`，`media / lexicon / cue / replay` 为 0（无附件、词典为空、cue 概率置 0、没有压缩事件）；标题卡 `body lines` 全部 0；0 warn；整场只推过 16 个不同 id。32 个 0 注入轮归因到 `dedupeTurns=16` 的窗口，这与报告的“本轮没有新块”一致，但**离线报告本身证明不了这一点**——真机要靠 session log 对账坐实。
- `docs/env-and-commands.md` §9.6 改为「三件工具各量什么、覆盖不到什么」的分工表，并记下真机前提：provider 配置在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的 `llm-pi-ai`，`- id/config` 是**整份替换不是合并**，改完要重启该 profile 的宿主。
- **真机 50 轮跑了（2026-11-01，隔离实例）**：`DSH_HOME` 用 launcher 自己的 home，profile 只加一个 `dsh-memu-memory` junction，provider 指向 8090 的伪端点，`dsh --profile … --port 0` 打印的 token 换 cookie 后由 `drive-session` 灌轮。读数（51 请求 / 2 会话指纹）：`guide`、`anchor`、`due`、`anniversary`、`openLoop`、`texture` **各 1 次**（都只在首轮），`ctx` Δ **27** 跨 **26/50 轮（52%）**，`freshness` Δ **18** 跨 17 轮，`media/lexicon/cue/replay` 为 0；标题卡 `bodyLines` 全 0；12 条播种条目全部浮现过。离线对照同码 50 轮：18/50 轮、`ctx` 18、`freshness` 11——方向一致，绝对值不同，离线数只读作"插件的决策"。
- 真机这一跑顺带抓出 **`drive-session.mjs` 的两个传输层 bug**（此前没有任何测试碰过这个脚本）：① RPC carrier 按**参数名**包参数，脚本却把请求字段直接铺在 `payload.args` 上，宿主在到达业务代码前就拒（`gateway/arguments-invalid: missing "request"`）；② 修 ① 时删掉了局部变量却留下 `return { rpcId }` 引用。现在 `buildPromptEnvelope()` 明确按 `{args:{request}}` 发，并新增 `tests/drive-session.test.mjs`（7 条）：envelope 形状、每轮 id 唯一、完成只认转录里的 `turn/end`、路径段编码、text-file 各形状，以及用 loopback 假网关跑 `sendPrompt`（校验请求体、cookie 透传、相关 id 不符要报错、401 要提示 `--cookie-file`）。
- 顺手修好一个装机事实：`~/.dsh/profiles/memutest` 的 bundle 名还指着改名前的 `dsh-memu`（链接已悬空 → 该 profile 起来根本不带插件），改为 `dsh-memu-memory` 并重建链接，同时给它一份只指伪端点的 provider 清单（非推理模型的 `reasoningEfforts` 必须写 `false`，`{off: null}` 会被判 `INVALID_CONFIG`）。这属于用户机器上的 profile 配置，不在本仓库版本内。

### 失败回合的注入记账撤回（§3.24）

- **修掉真机跑出来的第一个缺口（§3.24）**：宿主会把失败的整轮回滚——真机转录证明连用户消息都不留——而插件在"消息交回决策"之后就记了账，于是 `guide`、锚点、当日纪念日、复提时钟这些**一次性内容再也不投**，整段对话只是"记忆像没接上"、一句错都不报（那 51 个请求里 guide/anchor 一次都没有，逐回合召回与时效提示照常，binding 却写着"已投放"）。现在投放时把该轮消费的东西记在 `injectionRollback` 上，并在内存里留下本轮注入消息的 id；宿主 `step()` 是**先把消息追加进转录、再去连模型**的，所以 `turn/end` 到达时"见过这条消息的 `user/message` 事件"就是它已经在转录里的实证：没见过实证且 `kind` 为 `error`/`aborted` 才撤回这一轮的记账（`lib/state.js` 的 `recordInjectionRollback` / `rollbackInjectionForTurn`），下一轮重新投；见过实证或回合正常收尾则消费掉记录、记账保住，迟到的旧事件撤不动它。监听段排在最前并自带 try，不会被别的步骤抛错带走，回滚写活动日志与一条 warn。**边界**：只有"请求根本没发出去"那类失败需要它——上游 500、流式中断时消息已经在转录里，撤回只会凭空多出第二个锚点，所以不撤；实证只在内存里，进程恰好在回合中间重启就宁可漏撤也不误投。守卫：`tests/injection-rollback.test.mjs`（6 条）。

- 门禁（2026-11-02 实测）：`npm test` **1311 tests / 1309 pass / 0 fail / 2 skipped**（两条真实引擎用例按设计跳过）、`node scripts/acceptance-local.mjs` **50/50**、`npm run check` 全绿（含 i18n、文档预算、test-tracking 与 loader-stubs）。

## [1.2.3] - 2026-11-01

> `todolist.txt` 六条设想的施工版本（工单 A–F）。行为变化集中在注入与整理两侧，都不删记忆；工单 E 默认关闭，等真机验收。

### 情绪四轴上卡片（工单 A）

- 记忆卡片与详情抽屉现在显示 `arousal`（激活）与 `dominance`（掌控）以及情绪来源（模型标注 / 会话心情 / 正文识别 / 未知）；旧条目缺这两个字段就整行不出现，**不从 valence 反推**。
- 卡片的情绪 Tag 加悬停提示，展开四轴构成与来源。仍是只读：情绪不是编辑项（`docs/emotion-model-spec.md` §1.2 边界不变），全局条目不带情绪（§1.1 非目标）。

### 未了之事与日期联动（工单 C）

- **过期即复提**：带 `YYYY-MM-DD` 且已过期的 `open_loop` 条目不再受「静置 3 天」门槛限制，进入 `[open loop]` 候选并标注 `date=… 已经过了`，让模型说得清晚了多久。
- **节奏由自己的提醒时钟决定**：binding 记 `openLoopRemindedAt`，同一条每隔 `openLoopRemindDays`（默认 7 天，`[1,365]`）复提一次，同日不重复；90 天未命中的记录自动清理。常规腿（无日期承诺）行为完全不变：3 天门槛 + 提过即静默。每回合仍最多 1 条。
- **同回合不重复念**：纪念日块（`<memory-anniversary>` / `<memory-due>`）真正进入文本时，同一条目从两条腿都剔除；预算不够没注入时不会连带沉默未了之事。到期当天的措辞在 `<memory-due>` 内升级，不新开块。
- 闭环仍只有用户能做：不自动检测承诺、不自动关闭，关闭走 `memu_private_update`。

### 条件式时效提示（工单 D）

- 召回块尾部按需追加一条 `<memory-freshness>`：当至少一条**进入文本**的条目带时间敏感信号——已过期的 `YYYY-MM-DD`、标题/正文命中固定词表（最新/最近/现在/目前/今年/版本/价格/天气/新闻/比分/汇率）、或条目年龄 ≥ `freshnessDays`（默认 30 天）——提示模型「若会话里有可用的搜索工具，回答当前状态前先核实；没有就如实说明可能过时」。
- 判定是新增 `lib/freshness.js` 的**只读纯函数**，不加字段、不改存储；`owner=about_project` 的工程事实不按年龄算陈旧；年度 `MM-DD` 永不过期。
- 与召回共用 `turnTokens` 预算，装不下就丢提示、召回照常（fail-open，异常只 `warn`）；`anchor-only` 模式与 `autoInject=off` 不出。措辞刻意是条件式：插件无法确知本会话的工具面（`docs/host-api.md` §6.8）。
- 设置：`freshnessHint`（默认开）、`freshnessDays`（默认 30，`[1,3650]`）。不改 4 份 system-guide，不动 `rulesKey`。

### 纪念日到点唤醒（工单 E，实验特性，默认关闭）

- `salientWake='schedule'` 时，整理周期新增 `lib/salient-wake.js` pass：按**投递时区**扫今天/明天命中的 salient date，用宿主公开的 `ctx.schedule` 给绑定会话排一次性任务（`timing.at = {date,time,time_zone}`，`target={kind:'session',sessionId}`，时刻 `salientWakeHour` 默认 `09:00`，`salientWakeTimeZone` 留空跟随系统）。
- 到点是 `agent.followup`，**新开一整回合**；而本插件的注入只认真实用户消息，所以那一回合拿不到锚点/召回/纪念日块——唤醒 prompt 自带日期、措辞与 `memu_private_recall` 指引，并声明「已说过不要重复」。
- 幂等靠 `schedule.list` 对账：同名 active 跳过、paused 不动、已 `ended` 删除、过期槽位不补建；subagent 与归档会话只跳过并记信号；宿主没有 schedule 服务时 warn 一次并降级为被动注入。失败留 `kind:'wake'` 活动日志，不让周期失败。日历日与「这一刻是否已过」按**投递时区**计算（`dayInZone` / `instantInZone`）：早先按机器墙钟算，配置时区与系统时区不一致时会排错一天，或把那个时区里还没到的时刻当成已过而静默不排。
- 边界（写进 `docs/`）：宿主进程必须活着；at-least-once 可能重复投递；用户手删任务下轮重建；任务在宿主 schedule UI 可见。**真机验收前默认 off。**

### 实体主节点合并（工单 F）

- `lib/graph.js` 新增 `mergeEntities({libraryId,targetId,sourceIds})`：实体文件锁内一次完成——别名取并集（含来源名字）cap 30 并报告丢弃项、私有索引 `links[].to` 全量改指主节点（同 `(to,kind)` 去重）、关系快照按端点对重键（与主节点侧冲突时保留主节点侧并计入回执）、删除来源实体并 prune 孤立项。**只改指向，不删记忆**；活动日志记 `op:'entity-merge'`。kind 不同、自指、未知 id 一律拒绝且不留半成品。
- `suggestEntityMerges({libraryId})` 是纯读候选：同 kind 且「归一化后互相包含（短方 ≥2 字）」或「编辑距离 ≤2（短方 ≥3 字）」，稳定排序、上限 20，**永不自动合并**。
- WebUI 节点图页新增「合并候选」区：显示双方名字与理由，两次点击确认，合并后回执写明改指多少条链接、并入多少别名、丢了多少。RPC 新增 `mergeEntities` / `suggestEntityMerges`（方法数 93 → 95，走同一库级授权）。
- 不做跨库与全局↔私有归并；没有 undo，回退走既有备份。

### 注入实测台（工单 B，仅评测用）

- 新增 `scripts/mock-llm.mjs`：只监听 127.0.0.1 的伪 OpenAI 兼容端点，把每次模型请求的**块标记命中**（guide / anchor / due / anniversary / cue / texture / media / lexicon / context / open loop / freshness / replay）记成 JSONL，`--report` 输出「每轮 × 标记矩阵 + 汇总」。日志只有长度、哈希与计数，永不落正文。
- 新增 `scripts/drive-session.mjs`：走宿主公开的 `sessionController.prompt` 灌轮数，只认持久 session log 里本轮 `turn/end` 的 `reason.kind==='completed'`；没有 `--allow-api-route` 明确授权时**拒绝发送**并打印等价手工请求（退出码 3）。
- 标记表 pin 到本版本（`MARKER_SET_VERSION='1.2.3'`），改 `lib/inject.js` 的块标记必须同处更新。两个脚本都不被 `lib/` import，属测量工具而非运行时能力。
- 用法与退出码见 `docs/env-and-commands.md` §9.6；50 轮基线对比留给后续调参（C/D/E 的行为变化以它作度量）。

### 验证与迁移

- 帮助页 FAQ 从 10 条增至 **11 条**（中英同步）：新增「对话里为什么会主动提『那个日子已经过了』『这条可能过时了』」，把 C/D/E 三处会话侧可见行为写成人能读懂的原因，并说明三者都只是提示、不自动写入或删除；`docs/client-conventions.md` §7.3 记下「候选只显示 + 二次确认 + 回执数字取实值」的约定。
- 全量 `npm test`（2026-11-01 实测）：**1277 tests / 1275 pass / 0 fail / 2 skipped**（两条按设计跳过：curator 真实引擎用例、备份 venv/WAL 用例，均需 opt-in 真机环境）；`scripts/acceptance-local.mjs` **50/50**；`npm run check` 的 i18n / package / rpc-method-count(95) / test-tracking / loader-stubs 全部通过。
- 新增 `tests/entity-merge.test.mjs`、`tests/open-loop-date.test.mjs`、`tests/freshness.test.mjs`、`tests/salient-wake.test.mjs`、`tests/mock-llm.test.mjs`、`tests/settings-plumbing.test.mjs` 与 `tests/stubs/dsh-schedule.js`；扩展 inject / injection-chain / prompts / emotion / client-render / webui-auth / activity-log 等套件。
- 顺手修掉两处会在别人机器上闪红的地方：`tests/sidebar.test.mjs` 的大库首屏预算 500ms → 1500ms（守的是秒级病理形状，空载实测 378–448ms、并行整包曾到 1808ms）；`tests/client-render.test.mjs` 的短条目过期时刻改为相对时间（曾 pin 在当天 09:30Z，下午必红）。
- 修复一处静默失败面：`openLoopRemindDays` / `freshnessHint` / `freshnessDays` / `salientWake` / `salientWakeHour` / `salientWakeTimeZone` 必须进 `setSettings` allowlist 与 `resetSettings` key 表，否则设置页写了不生效（`tests/settings-plumbing.test.mjs` 拦回归）。
- 活动日志新增 `wake` kind；词典生命周期等处的过期计数表述改为引用 rpc-method-count 标记，不再散写数字。
- 无数据迁移：新设置项走默认值，唤醒默认关闭。依赖、构建步骤与网络要求均未增加。

## [1.2.2] - 2026-11-01

> 本版本把此前未单独发布的内部变更合并为正式版 1.2.2；下方「同版基线」保留原详细记录。

### 注入标题卡与标题提示词

- **锚点/召回改为标题卡**：`formatPrivateTitle` / `formatGlobalTitle` 只输出 `[id]`、标题、来源、owner、layer、日期/年龄、marginalized/open_loop、accuracy/uncertainty/disclosure 与附件计数；正文和附件 caption 不再进入 prompt。完整标签保留，`imagined` 不会被当成事实，`never_say` 不会丢失。
- **标题就是目录**：rule 移到锚点头部、所有记忆之前，并追加「标题即目录：要原文用 `memu_private_recall` 按标题关键词查，或直接引用方括号里的 id」。工具与抽屉仍返回全文。
- **预算不变，容量自然扩增**：anchorTokens/turnTokens/injectionTotalTokens 默认值不动，inbound 的 `floor(turnBudget/2)` 保留；移除 core≤5 / global≤8 的预先切片，由 packToBudget 决定条数。标题缺失回退正文前 40 字。
- **提示词**：`memu_private_remember` / `memu_private_update` 的 title、global curator 与四份私有整理稿统一要求 8–40 字、具体人名/物名/事件/结论关键词、禁止空标题；吸收/合并稿标题覆盖全部来源关键词。远程整理 JSON 契约的 title 上限同步为 8–40；四份领域正文不再包含 `memu_*` 工具工作流（远程整理没有工具），词典/关联的工具调用流程只留在本地 worker 任务书，领域稿仅保留“可抽什么词”的差异；修正“锚点/召唤”错字并在 `<memory-context>` 开头补“条目是标题卡，正文用 recall 取”。

### 词典自动入库与卡片管理

- **公开生命周期改为 active / archived**：模型提案与 curator 抽取普通词条直接 active，不再进人工审核；sensitive trigger 的新建/修改仍被硬拒，只有用户能管理敏感词；模型修改敏感字段不再生成 pending revision，而是 typed 拒绝。
- **legacy 迁移**：启动/周期巡检把 legacy pending 新提案转 active（敏感转 archived）、pending revision 转 archived；rejected 只保留内部墓碑与 fingerprint，UI/注入/计数均隐藏。迁移只写有变化的文件。
- **RPC**：删除 `lexiconReview`，新增 `lexiconArchive` / `lexiconRestore`；`lexiconList` 默认 active、支持 archived 页签与稳定 `statusCounts`，`lexiconSearch` 支持 `includeArchived`；方法计数 92 → 93。
- **词典页改为卡片流**：`使用中/已归档` 两页签、kind 筛选、搜索、新建、多选；卡片含 term 大字标题、kind/sensitive Tag、120 字释义、usage/aliases、hitCount 与 strength Bar、来源记忆跳转，以及编辑/归档或恢复/两段删除。批量归档/恢复/删除，部分成功分开显示。
- **词典注入仍保留 term + 短义**：`lexiconTurnLine` 短义从 120 字收紧到 80 字；锚点摘要仍只收 active top8，敏感词单列。模型提案工具描述与回执去掉 pending/人审，worker 增加 `memu_lexicon_search` / `memu_lexicon_propose`。

### 私有自动关联与实体枢纽

- **算法先筛，0 token**：整理结算后，对 created/updated 条目做同库、同 context/track、可见非 secret 的候选；共享稀有 name-like token、pairScore < 0.82 且无冲突时直接建立 memory↔memory `relation`，写 `source:'auto'`。
- **实体枢纽**：≥2 条记忆共享稀有 name-like token 时复用/创建实体；人物信号明确建 `person`，拉丁名无人物信号保守建 `thing`；归一化名称比较避免 `Yuike`/`yuike` 双实体。类型拿不准或已有实体 kind 冲突时转不确定候选。
- **不确定候选交本次 worker**：新增工具 `memu_private_link_suggest({ids})`，本地先落高置信链接/枢纽，只返回 ≤8 对候选卡；worker 用 `memu_private_link` 带证据裁决，不另起整理、不重读转录；每轮最多确认 5 条。`lib/private.js` 结算后兜底调用同一算法，失败只 warn，不影响整理成功。
- **图元数据**：`linkEntries` 持久化 `source:'auto'`，`getGraph` 边带 source；关系图显示「自动」Tag 与移除按钮。自动关联不改正文、不写向量、不删除。worker 写工具由 2 件扩到 5 件（remember/update/link/link_suggest/lexicon_propose），读工具 3 件；探测仍要求 remember/update 才算有写能力。

### 帮助页 v2

- 快速开始 5 步补「在哪里 / 成功的样子」；新增私有与全局判断链、标题卡与召回、归档/删除/撤回、向量库、私有自动关联/实体枢纽、侧边栏地图、九行标注速查表。
- FAQ 从 6 条扩到 10 条：标题卡正文、词典自动生效/归档、自动关联撤销、备份 vs 导出 ZIP、删除对话不再整理、向量未激活回退等；中英同步。

### WebUI 布局与选择器优化

- 记忆页：记忆库选择并入「范围」行，搜索独占一行，多选/批量操作独占一行；多选按钮点击后原地变为「退出多选」，批量按钮排列在右侧。
- 库选择器显示「库名 · 文件夹名」，同名库才追加短 id，完整路径放入悬停提示；所有 select 统一箭头、高度、圆角与焦点样式，修复 standalone 主题覆盖导致箭头消失。
- 侧栏作用域卡改为全宽、两列等宽、不可被 flex 压缩；整理记录默认显示最新 5 条，点击标题打开 WebUI 日志页。

### 验证与迁移

- 全量 `npm test`：1210 tests / 1208 pass / 2 skipped；`scripts/acceptance-local.mjs` 50/50；`npm run check` 静态/i18n/RPC 计数与 test-tracking 全部通过。
- 新增 `tests/private-links.test.mjs`；inject/lexicon/worker/RPC/UI/help 套件同步改写；B-4/H-5 验收改为标题卡口径。
- 依赖、构建步骤与网络要求均未增加。

### 同版基线：curator 三段式、全局关联与词典库

#### curator 三段式流水线（主动关联 · 综合整理 · 集合记忆）

- **候选检索**：倒排阻塞 + BM25 + 字符 Dice + token/entity Jaccard + 加权 RRF（k=60，权重 0.5/0.3/0.2）；N>300 走倒排、>2000 截断最近并标记；候选 ≤20/提案，簇 ≤12。
- **候选簇**：全对贪心团（禁传递闭包）、medoid 代表、簇 <3 条不建议 absorb、medoid 平均 <0.55 丢簇；候选簇随 prompt 给模型（索引 4000 + 候选 2000 token 预算，超预算丢低分）。
- **全局关联 link**：curator 可输出 `related/refines/supports` 三种边（对称双写同 opId、有向 DFS 防环 ≤3、每端 ≤20、跨域只 related 且 rp↔coding 禁止）；note 必须含会话转录逐字引用（证据落地校验，伪造/未落地不落边）；幂等 opId；移除只删边不删记忆。
- **absorb 集合记忆**：多条碎片合成一条集合记忆——target superseded、sources archived（**不删除**，可还原）、absorbSnapshot 支持一键撤销；合并稿句级去重 + 抽取/摘要双模 + 覆盖率三段（不足 skip/pending）；opId 幂等；簇外重复 ≥0.90 转 pending。
- **审核模式**：`curatorReviewMode` 设置（默认 auto=提炼自动通过，review-all=全部进人审）；硬门恒人审（conflict/无证据）；rewrite 操作风险 ≥0.70 在 auto 下也暂扣；风险分与原因写到全部条目供审计。
- **证据落地**：quote 必须是所策划会话转录的规范化子串（省略号分段校验、先脱敏）；无证据/未落地恒 pending 或不落库；修复"非法 merge target 继续创建"与"未知 op 默认 create"两个输入 bug。
- **全局页/复核队列 UI**：关联 Tag + 跳转 + 移除；「集合记忆 · N 条来源」Tag + 一键撤销合并；复核队列显示风险分与原因、pendingAbsorb 来源清单。

#### 词典库（Lexicon）

- 独立存储（`data/lexicon/<libraryId>.json`，CAS + 原子写 + withFileLock，容量 5000）与第 12 页卡片流管理界面（active/archived 两页签、搜索、编辑、归档/恢复、两段删除、来源记忆跳转）。
- 注入：首轮锚点词典摘要（top 8 + 敏感触发词单列警示）+ 用户消息词面命中 B 通道（30 分钟冷却、单回合 2 条）；fail-open 不阻断记忆召回。
- 生命周期：模型/curator 普通词条直接 active；sensitive trigger 仅用户可管；归档可恢复，rejected 只作内部墓碑；legacy pending 自动迁移。
- 备份/导出/导入含词典；RPC 方法 93 个（archive/restore），模型工具 13 个（含 lexicon search/propose 与 link_suggest）；Wilson 频率先验参与排序（0.85–1.00 因子不压过匹配层级）。

#### 修复

- 事实级去重：写入近似门（≥0.90 拒绝 / 0.55–0.90 打标 / allow_duplicate 逃生口）+ 召回按簇折叠 + duplicateOf 降权；update 与评审接受走同一道门；长度剪枝带补探针防绕过。
- 库级 HTTP 路由授权：31 个库寻址端点按 session 绑定精确比较或宿主 capability 回调（fail-closed），ZIP 导入先授权后读 body；修复悬空 sessionId 可写全局审核队列的真实洞。
- 「当前已入向量库」计数跟随真实增减；四条漏戳写入路径补齐。
- PTC（run_code）会话整理可用；挂载子集结构化上报；远程整理写入计数只数真实落库。
- 修复"非法 merge target 继续创建"、"未知 op 默认 create"、register disposer 泄漏三个输入 bug。

#### 界面与可观测性

- 帮助页（第 13 页）：快速上手 5 步、分区详解、FAQ 10 条、反馈三入口；无库时记忆总览页显示首次安装卡。
- 实体删除文字化 + 孤立实体折叠区（启动扫描自动回收老版本孤立节点）。
- 成功提示全通道补齐（保存/归档/恢复/删除/批量/导出）。

## [1.2.1] - 2026-10-31

### 事实级去重

- 写入侧近似门：与库内既有记忆 dice ≥ 0.90 的改写直接拒绝并返回 existingId，0.55–0.90 打 `duplicateOf` 标签；`allow_duplicate` 为"同一天两次独立观测"留逃生口。门在 redactSecrets 与矛盾检测之后，同题矛盾句不会被吞。
- 召回侧止血（对已污染的库立即生效）：候选收集按簇限额折叠、跨腿融合折叠（保留 rrf 最高、落 `mergedTogether`）、`mmrSelect` 对 ≥0.82 的重合硬跳过（0.55–0.82 保留软罚）；`cutWeakScores` 支持绝对下限 `retrievalFloor`（默认 0 关闭）。
- 观测：召回活动日志记录 `collapsed` / `clusterCount`，阈值误伤事后可查。
- 降权：带 `duplicateOf` 的条目召回 ×0.7，打断"重复簇越用越活"的自我强化。
- update / 评审接受走同一道门：≥0.90 拒绝（update 零 backend commit、review 保持待复核），0.55–0.90 接受并打标；排除自身与既有 duplicateOf 宿主。
- 长度剪枝防绕过：剪枝带内补包含与核心词全含双探针（0.92 / 0.90），"短改长"不再整对跳过；部分覆盖一律 0，宁漏勿误拒。
- 写入计数说真话：远程整理的 `count` 只数真实落库，去重拦下与待复核分列进日志。

### PTC（run_code）会话整理

- header 工具表只有 `run_code` 不再被当作"没有写工具"：PTC 的可写面在注册表里，fork 时把读写四件挂进 worker 自己的 scope（仅对该一次性 worker 可见，结束即卸载），任务书写明 `await tools.memu_private_remember({...})` 调用形态。
- 挂载元数据结构化：活动日志记 `workerToolsAttached`（实际子集）/ `workerToolsRequested` / `workerToolsPartial`；部分挂载不再被误报为完整挂载。
- 修掉一个真实泄漏：register 单件抛错会丢弃已注册的 disposer，在 worker scope 留下卸不掉的常驻注册（改为逐件 fail-open）。
- 混合工具面（原生 memu_* 与 run_code 同现）有测试钉住：任务书既列原生名单也带 SDK 调用形态。

### 整理提醒与日志

- 侧边栏新增跨会话的「整理提醒」（记忆设置卡之下、整理记录之上）：默认收起只显示最新一条，点击展开失败/成功两列（各最新 6 条），失败行带会话标题、原因与跳转按钮（直达对应库）。
- 失败记录可一键清除：只删 `consolidate` 且 `ok=false` 的行，成功流水与其它日志不动；落盘成功才更新缓存。
- WebUI 清空日志通过共享通道即时广播，侧边栏提醒同帧清空，不再等下一轮 20s 轮询。
- 日志页整理 / 提炼行带会话标题与文件夹名，裸 id 只作回退。

### 记忆页与全局记忆

- 「MemU 记忆」页按私有 / 全局分组（默认私有、私有靠前），计数分块；私有块支持多选批量归档 / 恢复 / 彻底删除（两段确认，逐条走既有 RPC，部分失败如实上报）。
- 「全局记忆」页每条记忆新增「查看此记忆」，一键跳到 MemU 记忆页对应条目并直接打开抽屉。

### 关系图

- 永久删除记忆级联清理：同事务剔除指向它的入边，删除后回收孤儿实体；归档（软删）不级联，还原后边还在——边界有测试钉住。
- 新增 `deleteEntity`：仍被引用时默认拒绝并说明引用数，`force` 连同入边与关系快照一起删（先清索引后删行）；图谱实体行带删除入口。
- 悬空边策略统一：getGraph 占位与 recallRelations 都标 `missing: true`，不再一边占位一边静默丢弃。
- 恢复备份后自动回收孤儿实体；插件启动延迟 4 秒全库扫描老版本遗留的孤立节点（幂等、健康数据零写入、失败只 warn），新安装为 no-op。

### 本地向量

- 「当前已入向量库 N 条」跟随真实增减：迁移账本（扣除已删除）∪ 当前代际写入戳合成，切换后新写入实时计入、永久删除即扣、回滚代际不串空间。
- 四条漏戳的写入路径补齐（批量导入 / 评审接受 / 编辑重提交 / 全局整理），此后"进没进向量库"每条都有凭证。

### 修复

- held-clone 虚假向量戳：整理冲突产生的 pending_review 克隆不再继承从未属于它的 `entry.vector`，membership 不再虚计。
- curator 提交成功后的索引失败现在逐条 forget 补偿（尽力而为且逐条可见：compensated / failed 进活动日志）；标注为补偿设计而非事务。
- `registerTools` 单件抛错不再丢弃已注册的 disposer（worker scope 常驻注册泄漏）。
- 整理 worker 的工具挂载在宿主不暴露 ctx 时如实上报（attached=null + partial），不再误报为已挂全。
- 事实级去重同口径盖住 update / review 后，远程整理写入计数同步修正（见上）。

## [1.2.0] - 2026-10-30

### 情绪模型（四项构成 + 双辅助轴）

- `readMood` 从单一 valence 扩展为四项构成（joy/anger/sorrow/fear，和为 1）+ arousal（强度）+ dominance（掌控感）；返回值继续带 `valence`，旧调用不受影响。
- 复合情绪不再是新维度，而是单纯形上的具名点：委屈/尴尬/嫉妒/心疼/不甘各有明确词条与默认掌控感。
- 召回新增 overlap 一致性路径（±30%）与 dominance 乘数（±10%），旧条目无 `emotion` 时回落原 valence 路径，不反推四轴。
- 门控改为三条独立条件的 OR：主导项 share ≥ 0.35、`|arousal − 0.35| ≥ 0.1`、`|dominance| ≥ 0.25`。
- 写入区分三种语义：省略=继承会话心情，`null`=明确中性，对象=模型读数；`emotionSource` 记录来源（model/session/content/unknown）。
- 后台整理 fork 显式不继承父会话心境，四份整理提示词要求按事件所在回合还原情绪。
- 修掉派生 valence 把 anger 记为正、`emotion: null` 被继承覆盖、`dominanceBias(null)` 返回 1.05 三处偏差。

### 主动记忆 A/B 数据集

- 新增 4 个规模梯度 case（98 / 998 / 4998 / 19998 事件），用既有 padding 生成器产出，零手写事件；数据集 10 → 14 个 case。
- 梯度暴露了一个此前被 fixture 规模掩盖的事实：`guide-weighted` 的覆盖在阈值以上低于 legacy（11/20 vs 14/20），守卫在 2000 事件处把薄回合的覆盖换成 seed 成本（19,998 事件一次 fork 约 32k token → 0）。
- 新增 `guide-weighted:structural` 行，用 `lib/consolidation-receipt.js` 的 `parseReceipt` 把 C 包回执映射成凭证；14 个 case 与 oracle 行逐条一致。
- 真实模型运行器的 dry-run 计划从 20 个请求变为 28 个（14 case × 2 臂）。

## [1.1.3] - 2026-10-30

### 本地向量（受管）

- 重建提交改用 MemU 的 `recall_files` 信封，修复"每条都 `VECTOR_READBACK_FAILED`、整次重建作废"的根因。
- 重建进度独立成块：明确区分准备中 / 写入向量 / 已切换 / 失败 / 已停止；失败时列出 `itemId · code · message`。
- 切换成功后清空"待切换"标记；旧标记 `{status:'active'}` 兼容读取，不再同时显示"当前生效 + 待切换"。
- 记忆详情显示向量归属：新写入带模型与代际，迁移条目按账本显示"已入向量库（迁移）"。
- 列表接口在向量启用后直接读索引：归档 / 还原与记忆墙刷新从秒级降到毫秒级。
- 未激活向量时，写入 / 列表 / 全局列表降级为索引 + 引擎，不再抛 `VECTOR_NOT_ACTIVE` 卡死整理。

### 记忆

- 模型把日期写进正文但漏填 `salient_date` 时，从唯一的 `YYYY-MM-DD` 兜底；出现多个日期则不猜。
- 默认 `privateTopK` / `globalTopK` 调整为 5 / 5。

### 可观测性与界面

- 新增活动日志（召回 / 写入 / 整理 / 提炼 / 向量）与「日志」页：筛选、复制、下载、定位记忆。
- 侧边栏整理结果改为按钮下方的「整理记录」，不再在顶部显示 fork 提示；作用域卡片下移。
- 「连接与向量」重做为分步卡片：运行环境 → 模型 → 切换并重建，主操作更醒目。
- 修复日志页 hook 顺序导致的设置 / WebUI 白屏（React #310）。

### 工程

- Windows 子进程补齐 `SystemDrive` / `SystemRoot` / `windir`，避免字面量 `%SystemDrive%` 目录。
- `manifestDigest` 只覆盖制品与向量空间字段，改说明文字不再判废已激活的向量空间。
- 新增链路矩阵 `npm run test:chain`（3 后端 × 3 触发 + 降级，10/10）；测试总数 702 → 761。

## [1.1.2] - 2026-10-29

- 人格预设会话的锚点与召回送达（`preset-scope`），complete 预设用一次性 `<memory-guide>` 消息投放规则。
- 启动时补扫空闲整理；跳过已不存在的对话；fork 前先判断回合是否有值得整理的内容。
- 修复面板的 TDZ 崩溃（引用未初始化回调导致整块空白）。
