# 推迟与未做清单 — dsh-memu-memory

> **本文件只回答一个问题**：「文档里那些『本版未做 / 后续 / 待办 / 尚未验证』的话，现在还算不算数？」
> 每次要动某条链路前先来这里对一遍，别把已经做完的当未做重做一遍，也别把仍然成立的当已解决。
>
> 每条都带**核对日期**和**核对依据**。结论变了要同时改出处文档与本表。CHANGELOG 里的历史叙述不动——
> 它是当时那一版的记录，本表才是当前状态；两者冲突时以本表 + 代码为准。

## 14. 推迟项台账

### 14.1 已经做完，不要再当待办重做

| 项 | 出处 | 现在的事实 | 核对 |
|---|---|---|---|
| snapshot-failed 冻结期需要「冻结感知且不惩罚新活动」的独立退避字段 | CHANGELOG 1.3.9 段（「…故本版未做」） | 已做：`cycle.js:196` 在 `snapshot-failed-too-many` 时写 `patch.sleepFrozenUntil = result.cooldownUntil`，独立于 `sleepRetryAt`，不占 budget 名额 | 2026-11-26 读 `lib/cycle.js`；1.3.10 发布说明 |
| 0.2.3 宿主上恢复 RPC 入口守卫 | `docs/host-adaptation.md` 原 §6.1 待办 | 已做：`lib/rpc.js:requestRejectionOf` 三级探测（`requestRejection` → `admit` → `isTrustedApiRequest`），`admit` 一级带守卫用例 | 2026-11-26 `tests/webui-auth.test.mjs` |
| 「新宿主只暴露 `sessionPersistence.open(id,'read')` 时要补冷读适配器」 | 同上 | **不必做**：`readColdSessionLog` 内部本来就以 read 模式打开会话；插件侧的候选探测与 `COLD_LOG_READER_UNAVAILABLE` 降级保留即可 | 2026-11-26 宿主源码 `packages/session-query/session-query/src/cold-read.ts` |
| `npm run test:chain` 的 manual / idle 六格失败 | CHANGELOG 1.2.x 验证口径段 | **诊断变了**：崩溃点是 `scripts/chain-matrix.mjs` 合成的 `./memu.js` 桩缺 `closeMemuResident` / `prewarmMemuResident` 两个导出（`lib/rpc.js` 1.3.x 起新增的导入），整套矩阵在导入期就死。桩补齐后 10/10 全绿 | 2026-11-26 `node scripts/chain-matrix.mjs` → `matrix: 10/10 chains walked, 0 failed` |

### 14.2 仍然成立，等条件或等你决定

| # | 项 | 出处 | 为什么没做 | 建议方案 | 前置条件 |
|---|---|---|---|---|---|
| P1 | 完整性能实验（注入预算/打包收益的量化）与「真实宿主 + 真实服务商成本对照」 | CHANGELOG 1.3.8 O1 段、1.3.9 worker 超限段、`docs/memory-semantics.md` §8.18 | 离线 harness 只能证明插件侧决策，证不了 token 与费用 | 走 `docs/active-memory-ab.md` 的隔离真机路线：launcher home + `scripts/mock-llm.mjs` 或真实 provider + `scripts/drive-session.mjs` 灌 50 轮，产出每轮块标记矩阵与 token Δ；两次双臂（fork / worker）各 50 轮 | 要你授权跑真机并指定用哪个 provider（会真实计费） |
| P2 | `npm run replay` 的 5 个检查点 | CHANGELOG 1.2.x 验证口径段 | 与本仓库环境绑定：`lib/tools.js` 需要宿主包可解析 | 按 `docs/env-and-commands.md` 的本地 link 步骤把 `@deepseek-ai/*` link 进来再跑；跑不动就让脚本在开头**明确报「缺宿主 link」**而不是抛 `ERR_MODULE_NOT_FOUND` | 一次 link；或接受把 replay 标为「仅开发机可跑」 |
| P3 | `secret` 的分层剥离口径（哪一层剥什么、转述与失败重试是否同拦） | `docs/memory-semantics.md` §8.10 | 合成探针只证明「输入通道存在」，产品语义要你定 | 先定「剥离发生在进 prompt 前还是在落盘时」这一条，再决定是否加来源追踪；不加白名单（会误伤） | 你的产品决定 |
| P4 | 主动记忆 A/B 数据集 14 个 case 仍是合成代理标注（`annotationSource: synthetic-proxy`、`review: pending`、`gold: false`） | `docs/active-memory-ab.md` 头部与 §8 | 没做人工逐条确认 | 要么人工复核升 gold，要么在文档与报告口径里继续只当**合成代理集**引用；不要为凑 gold 补合成标注 | 人工复核时间 |
| P5 | 召回相关度与偏置（强度/首因/峰终）边界的独立评测 | `docs/troubleshooting.md` §3 混合召回守卫段末 | 现有用例只锁公式，没量过「偏置会不会盖掉更相关的那条」 | 用 `scripts/recall-bench.mjs` 的语料加一组「偏置对照」场景（同相关度不同首因/峰终），先出数再谈改排序 | 需要一份贴近真实的语料；纯合成语料证不了 |
| P6 | `0.2.2-rc.5` 与 `0.2.3-alpha.*` 的**真机**四件套 | `docs/host-versions.md` §13.1 | 这三行是按 tag 逐面读源码得来的，没在真实进程上冒烟 | 按 `docs/host-adaptation.md` §3.5 + `scripts/check-seed-compat.mjs` 跑一次，台账的核对方式改 `真机` | 你要装/起对应版本的宿主 |
| P7 | 实体存量碎片修复 | 本次会话（用户本机 home 的数据） | 提名侧已修（见 §14.3），但已落盘的碎片不会自己合 | **已完成**：`lib/entity-repair.js` + 升级后一次性自愈（`lib/index.js:runEntityRepairPass`，标记 `state.cycle.entityRepairVersion`）。**可证明**的那一类（片段首尾重叠重建出正文里出现过的完整名，或短名在正文里从未独立于长名出现）自动合并：写入前先图备份，只走 `graph.mergeEntities` 那条级联，`pruneOrphanEntities` 误伤的计划外实体原样写回。**只是相似**的（编辑距离、名字核）绝不自动写，只在诊断页报数并挂"需确认"按钮（`MANUAL_REPAIRS` 的 `merge-entity-fragments`）。备份失败就整体顺延（`ENTITY_REPAIR_DEFERRED`），标记不写，下次启动再试。副本实测：5 组自动合并（含 2 个重建主节点）、0 副带删除、第二次跑 attested=0（幂等）。命令行等价物 `scripts/entity-dedupe.mjs` | 只剩 `similar` 档等人工确认；跨库与全局↔私有不合并（§8.16） |
| P8 | `allowWorkerAssertion`（worker 点名即确认实体） | `docs/memory-semantics.md` §8.13、`lib/state.js:32` | 是 v3 预留开关，本版按设计不读取 | 保持不动；真要开时先改 §8.13 的口径与 `tests/auto-link-decide.test.mjs` 的 provisional 无边不变量 | 产品决定 |

### 14.3 本轮已修，但只修了「以后不再发生」

| 项 | 落点 |
|---|---|
| 中文人名被 n-gram 滑窗拆成两个节点（`南宫晚` / `宫晚晴`） | `lib/auto-link/terminology.js:rankCandidates`（同段更长表面优先）、`lib/private-links.js:suggestPrivateLinks`（窗口片段不再当实体名）、`CANDIDATE_VERSION` 升到 3 让旧快照重建 |
| 同一个人的不同写法之间没有任何合并线索（`顾清欢` / `欢欢` / `欢`） | `lib/graph.js:suggestEntityMerges` 新增 `name-core` 理由（仍**永不自动合并**，UI 两次点击确认） |
| 按域看不了、筛不了、卡片不显示域 | `lib/global-graph.js` + `lib/rpc.js`（`browseWall`/`privateListView` 带 `domain` 与 `domains`）、`lib/client.js`（全局图传域、图节点检查器、记忆墙域筛选、卡片与抽屉的域标签） |

**这两条只是没修**：已落盘数据里的碎片要靠 P7；`decide.js` 的跨实体「最长表面优先」没做——新数据不再产生片段，所以它只在存量库上才有意义，等 P7 之后再评估是否需要。

### 14.4 明确不做（防止重做）

| 项 | 结论与依据 |
|---|---|
| W8 助手重复提示 | 已决定不做，不再重做。120 次合成 A/B 未证明改善重复回答率，事实词面完整性反而下降；证据文档已删除，不得据此宣称「已证明任何防复读技术无效」（`AGENTS.md` §4） |
| 情绪四轴的 WebUI 编辑控件 | `docs/emotion-model-spec.md` §1.2 定为非目标；只读展示随 P2 落地 |
| 跨库与全局↔私有的实体归并 | `docs/memory-semantics.md` §8.16 明确不做；没有 undo，回退走备份 |
| 超时推进 `lastSleepSeq` | 没有回执就证明不了覆盖了哪一段，改成部分推进可能漏事件（CHANGELOG 1.3.x「明确没做的事」） |
| 关系图按域分色/分块布局 | 需要重打图谱 bundle 且引擎按设计对域无感知（`docs/client-conventions.md` §7.6）；本轮只做过滤与显示 |
