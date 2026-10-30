# 检索 benchmark（W6，provisional）

> **状态：provisional baseline，不是金标。** 本目录的 42 条样本全部是**合成草稿（synthetic draft）**，没有经过人工确认，不能称为 gold set。本文的分数只说明当前 local-lexical 管线在一组刻意构造的样本上的行为，不能代表真实 RP 对话或语义检索质量。

- 工作包：W6 · 检索 benchmark（P1，W7 的前置）
- 基线时间：2026-10-29T09:39:30Z（测试运行时钟）
- 基线提交：`afc970f934df`（HEAD；W6 文件尚未提交，工作区为 dirty）
- 包版本：`dsh-memu-memory@1.1.2`
- 数据集：42 条 / 8 个文件，SHA-256 `4b3d01898071073f318d815346b1af2758878900a2685355f6bd40445531a2b0`
- 后端：`local-lexical`；没有启用真实 embedding 或真实向量服务

## 1. 结论（只读这一节）

本次 provisional baseline：

| 指标 | 候选 id（candidate） | 最终注入 id（final injected） | 显式探针（explicit） |
|---|---:|---:|---:|
| Recall@3 | 1.000000 | 1.000000 | 1.000000 |
| MRR@3 | 0.984848 | 0.984848 | 1.000000 |
| 无答案误召回率 | 0.000000 | 0.000000 | n/a（无无答案样本） |
| 隔离违规 | 0 | 0 | 0 |
| 可答样本分母 | 33 | 33 | 5 |
| 无答案分母 | 9 | 9 | 0 |

隔离违规总计 **0**。其中 forbidden id 检查次数：候选 20 + 最终注入 20 + 显式探针 0 = 40 次，命中 0 次。

这些数字是**合成草稿上的 provisional baseline**。样本的 query 与条目文本存在刻意保留的词面线索，local-lexical 接近满分是预期现象，不是“检索质量已经解决”的证据。

## 2. 运行方式

脚本：`scripts/recall-bench.mjs`

```bash
# 默认输出完整 JSON 到 stdout
node scripts/recall-bench.mjs

# 写出机器可读报告
node scripts/recall-bench.mjs --out artifacts/recall-bench.json

# 仅跑前 N 条；固定 seed；保留临时根用于检查
node scripts/recall-bench.mjs --samples 10 --seed 20261029 --work-root "$TMPDIR/recall-bench-inspect" --keep
```

参数：

| 参数 | 说明 |
|---|---|
| `--out FILE` | 写 JSON 报告；父目录自动创建。报告按 CRLF 写出 |
| `--work-root DIR` | 使用指定的空目录；必须是 `os.tmpdir()` 下的目录，否则拒绝运行 |
| `--seed N` | 替换 PRNG seed；默认 20261029 |
| `--samples N` | 只跑排序后的前 N 条；1..42 |
| `--keep` | 保留本次临时根（默认根在结束后删除；报告里的 `run.root` 可查看路径） |

测试命令：

```bash
node --import ./tests/loader-register.mjs --test tests/recall-bench.test.mjs
```

测试只验证 harness、样本结构、隔离、确定性和指标数学，不锁定上面的具体分数；分数变化不应让结构测试变成“追数字”。

## 3. 合成样本集

位置：`tests/fixtures/recall-bench/`，共 8 个 JSON 文件、42 条样本。每个 JSON 文件都带有 `status`，每条样本都带有 `draft`/`notGold`：

```json
{
  "status": "synthetic-draft-not-gold",
  "draft": true,
  "notGold": true
}
```

| 子类 | 样本数 | 覆盖点 |
|---|---:|---|
| `paraphrase` | 6 | 同义改写、指代和口语化问法 |
| `exact` | 5 | 精确 title、精确 memory id |
| `negation` | 4 | 否定、旧状态不得被当成当前状态 |
| `no-answer` | 6 | 英文 query 对中文小型库，必须返回空 top-3 |
| `conflict` | 5 | 新旧冲突、pending review 不得当作已确认 |
| `boundary` | 6 | channelId / characterId / worldId / branchId / knownBy 边界 |
| `secret` | 5 | secret 自动隐藏 vs 显式召回；含 3 条自动无答案 |
| `coding` | 5 | 少量 coding 约束，防跨域退化 |
| **合计** | **42** | |

每条的字段（脚本会逐项校验）：

| 字段 | 含义 |
|---|---|
| `query` | 检索 query |
| `context` | 会话上下文（可为空对象；边界样本使用 channelId/characterId/worldId/branchId/knownBy 等） |
| `time` | 固定时钟；条目 ageDays/updatedDaysAgo 相对此时间计算 |
| `expectedIds` | 期望命中的 id；无答案样本为空数组 |
| `forbiddenIds` | 禁止出现在任何 top-3 的 id；计入隔离违规 |
| `noAnswer` | true 表示该样本必须无召回；无答案样本的 expectedIds 必须为空 |
| `subclass` | 上表八个子类之一 |
| `library` | 该样本可用的小型 library 子集（1–10 个 id），样本之间不复用 library，避免互相污染 |
| `explicitExpectedIds` | 可选；显式召回探针的期望 id（用于 secret 自动/显式差异） |
| `explicitForbiddenIds` | 可选；显式召回探针的禁止 id |

数据是人工编写的合成内容（虚构人名、地点、约定），不包含真实聊天、真实用户记忆或可识别个人信息，可以安全入库。**它们仍不是人工确认样本。**

## 4. 隔离与可复现设计

每次 `runBenchmark`：

1. 在 `os.tmpdir()` 下新建（或使用调用者提供的空）根目录；`--work-root` 也必须在 tmpdir 下。
2. 把 `DSH_MEMU_HOME` 指向 `<root>/dsh-memu-home`，把 `DSH_MEMU_MEMORY_HOME` 指向 `<root>/dsh-memu-data`。结束后在 `finally` 中恢复原环境变量。
3. 不读取、不打开、不写入用户真实 `dataDir()`。harness 没有“指向用户库”的参数；要评估真实库，必须先另做只读快照设计，当前未实现。
4. 每条样本创建独立的 library（独立 `scopeKey`）和独立 session，写入独立 private index；样本声明的 `library` 子集只在本样本内可见。
5. secret 显式探针使用第二套独立 library/session，避免 `purpose='explicit'` 的 `touchAccessMany` 访问计数影响自动召回；所有 `accessCount`、`injectCount` 都从 0 开始且只存在临时状态中。
6. 固定时钟：`Date.now()` 被按样本 `time` 覆盖；固定随机：seeded mulberry32；默认 seed 20261029。
7. 默认运行结束删除临时根；传 `work-root` 时保留，便于检查 `state.json`。

**隔离证据**：测试在测试自己的 `DSH_MEMU_HOME` 下放 sentinel 文件，运行两次 benchmark 后检查 sentinel 内容未变、该 home 下没有生成 `state.json`；同时检查 run root 下存在 `dsh-memu-data/state.json`，且 `metrics.isolation.violations === 0`。完整证据由测试输出和报告 JSON 共同提供，不靠口头声明。

**确定性**：同一数据 SHA-256、同一 seed、同一 config 的两次运行，候选/最终/显式指标与逐样本 top-3 完全一致（测试比较时剔除天然波动的 `latencyMs`；`startedAt` 和临时根路径也不会相同）。延迟不能承诺逐次相同。

## 5. 指标定义

三个投影分别计算，且都只看**前 3 个 id**：

- **候选 id**：`privateRecall({ purpose: 'automatic', topK: 20 })` 返回的 id 顺序的前 3 个。`candidateTop3` 是候选阶段指标。
- **最终注入 id**：`buildRecall(...)` 返回的 `ids` 的前 3 个。它可能受 `dedupeTurns`、`useGlobal`、token budget 和格式渲染影响，因此必须与候选分开记录。
- **显式探针**：对声明了 `explicitExpectedIds` 的样本，用独立 library/session 调 `privateRecall({ purpose: 'explicit' })` 的前 3 个；只用于 secret 自动/显式差异，不混入自动指标。

定义与空集规则：

| 指标 | 分母 | 规则 |
|---|---|---|
| Recall@3 | `noAnswer=false` 的样本数（answerable） | 前 3 中至少有一个 `expectedIds` 即命中；命中样本数 / answerable |
| MRR@3 | 同上 | 第一个期望 id 的排名取倒数（1/rank）；前 3 没有则为 0；求和 / answerable |
| 无答案误召回率 | `noAnswer=true` 的样本数 | 前 3 非空即误召回；误召回样本数 / noAnswer |
| 隔离违规 | 不设 rate 分母；报告 forbidden 检查次数 | 每个 `forbiddenIds` 在每个投影的 top-3 中出现一次记一次；必须为 0 |

- 某个分母为 0 时，对应 rate 输出 `0`，并在 `emptySet` 中标记为 `true`；不会用 0 冒充“完美”。
- `noAnswer=true` 的样本即使有 `forbiddenIds`，也不会进入 Recall/MRR 分母；其 top-3 非空同时会造成无答案误召回。
- `isolation.violations` 是 candidate、finalInjected、explicitProbe 三个投影的违规总和；`forbiddenDenominator` 是三个投影的 forbidden 检查次数总和。隔离要求是精确 0，不是“低于某个率”。

## 6. Provisional baseline 明细

### 6.1 总体

| 投影 | answerable | Recall@3 | MRR@3 | noAnswer | 无答案误召回率 | 隔离违规 | forbidden 检查 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 候选 id | 33 | 1.000000 | 0.984848 | 9 | 0.000000 | 0 | 20 |
| 最终注入 id | 33 | 1.000000 | 0.984848 | 9 | 0.000000 | 0 | 20 |
| 显式探针 | 5 | 1.000000 | 1.000000 | 0 | n/a（空集） | 0 | 0 |

### 6.2 按子类

候选与最终注入在本次 baseline 中相同；下表列的是两者共同值（逐样本仍分别保存）。

| 子类 | 样本 | answerable / noAnswer | Recall@3 | MRR@3 | 无答案误召回 |
|---|---:|---:|---:|---:|---:|
| paraphrase | 6 | 6 / 0 | 1.000000 | 1.000000 | 0.000000 |
| exact | 5 | 5 / 0 | 1.000000 | 1.000000 | 0.000000 |
| negation | 4 | 4 / 0 | 1.000000 | 1.000000 | 0.000000 |
| no-answer | 6 | 0 / 6 | 0（空集） | 0（空集） | 0.000000 |
| conflict | 5 | 5 / 0 | 1.000000 | 0.900000 | 0.000000 |
| boundary | 6 | 6 / 0 | 1.000000 | 1.000000 | 0.000000 |
| secret | 5 | 2 / 3 | 1.000000 | 1.000000 | 0.000000 |
| coding | 5 | 5 / 0 | 1.000000 | 1.000000 | 0.000000 |

### 6.3 延迟与预算

延迟（`metrics.latency`）：

- 后端：`local-lexical`
- 样本数：42
- 口径：单 Node 进程，`performance.now()` 包住每条样本的 automatic `privateRecall` + `buildRecall`；不是服务延迟，也不是网络/磁盘全链路延迟
- 本次：median **25.618 ms**，p95 **33.959 ms**
- 延迟随机器和运行波动，不属于确定性断言

Token 预算（只能称 estimate）：

- 字段：`budget.estimate`（同时保留 `injectedTokenEstimateTotal` / `injectedTokenEstimateMean` 兼容字段）
- 方法：`lib/budget.js` 的 `estTokens`（CJK 约 1 token/字，Latin 约 3.4 字符/token）
- 本次：`injectedTokenTotal=4867`，`injectedTokenMeanPerSample=115.881`，`turnTokens=640`
- **这是估算，不是模型 tokenizer 的实测消耗。** 没有用真实 tokenizer；不得把它写成“实际用量”。

## 7. 机器可读输出

`runBenchmark()` 返回 / CLI `--out` 写出的 JSON 包含：

- `schemaVersion`、`kind`、`ok`、`status`
- `dataset`：status、draft、notGold、sampleCount、fileCount、sha256、files
- `code`：git commit、packageVersion、worktree 说明
- `run`：startedAt、root、clock、randomSeed、random、sampleLimit
- `config`：backend、candidateTopK=20、privateTopK=3、turnTokens=640、relevanceThreshold=0.4、dedupeTurns=16、vectorPath
- `metrics`：candidate、finalInjected、explicitProbe、isolation、latency、bySubclass
- `budget`：`estimateOnly=true`、`estimate` 对象、flat estimate 字段与 note
- `samples`：每条样本的 `candidateIds`/`candidateTop3`、`injectedIds`/`injectedTop3`、`explicitIds`/`explicitTop3`、估计 token、延迟与状态

## 8. 未验证项与限制

以下都**未验证**，不能从本 baseline 推出：

1. **人工金标**：42 条全是合成草稿，没有人工逐条核对、没有标注者一致性；不能叫 gold，也不能用作上线门槛。
2. **真实用户库**：harness 不读取真实 `dataDir()`，没有在真实记忆上跑过；真实库的规模、噪声、重复、历史状态会改变结果。
3. **真实语义/向量质量**：本次只有 local-lexical；`mockVectors` 仅标记管线接口，未调用真实 embedding。W7 的混合召回质量仍未验证。
4. **模型 tokenizer / 实际 token 用量**：预算只来自字符估算；没有 tokenizer 版本或实测对照。
5. **服务延迟**：25.618/33.959 ms 是本机单进程的 harness 耗时，不是 WebUI 或 API 后端服务延迟。
6. **跨平台/并发**：只在当前 Windows 工作区和单进程测试；没有并发写、崩溃恢复、多个 session 同时运行的覆盖。
7. **真实 RP 分布**：样本是人工设计的短查询，不能代表长篇 RP 的自然语言分布、长上下文和多轮注入历史。
8. **生产排序**：本包只 import 生产函数做只读调用，没有改 `lib/memory.js`、`lib/inject.js` 或任何生产排序/权重；因此不能声称生产召回已被优化。
9. **数据可迁移性**：样本只在小 library 子集（每条 1–10 条）内评测，不能外推到全局 library 排序。

## 9. 回退与数据影响

- **生产代码/配置**：无改动。没有改排序、阈值、默认 backend、schema 或共享 `/api`。
- **用户数据**：无接触、无迁移、无写入。所有 benchmark 状态在 `os.tmpdir()` 的临时根下，默认运行后删除；`--work-root` 仅供调试，且仍必须在 tmpdir 下。
- **回退方式**：删除本包新增的 `scripts/recall-bench.mjs`、`tests/fixtures/recall-bench/`、`tests/recall-bench.test.mjs`、本文档即可；没有数据库或运行时状态需要回滚。
- 若要把本包提交到版本库，应先按仓库流程单独提交；当前 W6 工作区改动尚未 commit（见 `code.worktree`）。

## 10. 人工金标候选（待审核，非 gold）

除默认 42 条 `synthetic-draft-not-gold` 外，W6 另有一套 **40 条人工审核候选**：

- 位置：`tests/fixtures/recall-bench-gold-candidates/`（8 个文件、8 个子类各 5 条、64 个库条目）。
- 状态：`gold-candidate-pending-review`；每条 `draft=true`、`notGold=true`、`gold=false`、`review=pending`。
- 数据集 SHA-256：`c6f3a5461de357d8d6fd5a89ada3a068e82b08cb047251258abc32c9919bc8cf`。
- 审核表与逐条勾选流程由维护者本地保存，不随仓库分发（其中含候选内容）。
- 运行候选集：`node --import ./tests/loader-register.mjs scripts/recall-bench.mjs --fixture-dir tests/fixtures/recall-bench-gold-candidates`。

候选集**不是** gold set。只有人工逐条确认、另行迁移状态并重算哈希后，才能讨论金标分数；当前测试只验证结构、隔离和 no-answer 空集，不锁定候选分数。默认数据集与默认 CLI 行为保持不变。

## 11. W7 评测证据与生产边界

旧 W7 混合召回设置 (`hybridRecall` / `hybridRecallMode`) 及其 LLM 重排生产接线已移除。当前 benchmark 只验证本地词法管线、候选资格/隔离、最终注入和预算估算；它不启用聊天/总结模型，也不把历史 LLM 实验当作生产路径。

默认数据集的 42 条 synthetic-draft 样本在 2026-10-29 复跑结果与 §5 基线一致：candidate / final-injected 的 Recall@3 = 1、MRR@3 = 0.984848、no-answer 误召回 = 0、隔离违规 = 0；预算估算 `injectedTokenTotal=4867`、mean=115.881、`turnTokens=640`；数据集 SHA-256 未变 `4b3d01898071073f318d815346b1af2758878900a2685355f6bd40445531a2b0`。

历史 W7 LLM 重排实验（2026-10-29，两轮；仅保留证据，不提供生产启用入口）：同一 42 条 synthetic-draft 数据集，candidate / final-injected 的 Recall@3 = 1、MRR@3 = 0.984848、no-answer 误召回 = 0、隔离违规 = 0，两轮返回 id 序列相同。31 条走 hybrid-llm-rrf、11 条保持 local（6 条 no-answer、3 条 automatic secret 空集、2 条 exact id）；55 个词法候选、32 个有效重排 id，23 个 local-only、0 个 semantic-only、32 个 shared，没有调用错误。4 条 top-3 顺序变化，top-1 不变。第一轮 median=4249.458 ms / p95=6102.986 ms，第二轮 median=4305.708 ms / p95=7804.750 ms；墙钟约 166 s / 184 s。预算仅估算：total=5096、mean=121.333、turnTokens=640（词法基线 total=4867、mean=115.881）；不是实际 token 消耗，也不是有效性或上线许可。

W8（助手重复提示）已决定不做，理由与结论见 `AGENTS.md`；证据文档已删除，旧 LLM/重复提示实验与当前生产召回路径解耦，不应再通过 benchmark CLI 重跑。

测试覆盖：`tests/hybrid-recall.test.mjs` 仅保留通用 RRF/fusion helper；managed vector 行为由 `tests/managed-memory.test.mjs` 覆盖。
