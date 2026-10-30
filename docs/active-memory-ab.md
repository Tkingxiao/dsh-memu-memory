# 主动记忆 A/B 评测与快照凭证（F 包，provisional）

> **状态：provisional，不是金标。** 确定性 harness 不调用模型；§9 另有一轮真实模型 live 运行（工具调用协议），它回答的是「协议下产出可不可用、省多少 token」，不是主功率提升，也不是 gold。数据集里 14 个 case 仍全部是**合成代理标注**（`annotationSource: "synthetic-proxy"`，`review: "pending"`，`gold: false`），没有人工逐条确认。
>
> 实测日期 2026-10-30（Asia/Shanghai）。测试数字与摘要都是**带日期的快照**，改动 fixture 或规则后必须重跑并更新，不能当永久保证。

- 工作包：§13.9 F 包（回放与验收）+ §13.6 C 包的**接口侧**（快照身份、凭证、游标规则）
- 脚本：`scripts/active-memory-ab.mjs`（确定性回放，§2）+ `scripts/active-memory-ab-live.mjs`（真实模型，§9）
- 测试：`tests/active-memory-ab.test.mjs`（38 个用例，38 pass；含结构行回执→凭证 5 条）
- 数据集：`tests/fixtures/active-memory-ab/`（14 个 case，15 个文件；含 4 个规模梯度 case，见 §5.2）
- 确定性 harness 模型/网络调用：**0 次**；真实模型调用只在 `--live` 下发生，报告不落盘、不留模型原文（§9）

---

## 1. 这一页回答什么

| 问题 | 本文的回答 | 不能从这里得出的结论 |
|---|---|---|
| 快照是不是固定的？ | 是。每个 case 有 `throughSeq` + 快照 `sha256` pin，改动未重新钉会被拒绝加载 | 不代表快照里的对话是真实用户会话（它是合成的） |
| 三种条件（旧行为 / guide / guide+weighted）在调度上有什么差别？ | 有确定结论：见 §5 | 不代表 guide 对模型行为有/没有效果（未测） |
| 检查结果能不能被凭证校验、游标会不会乱走？ | 能，且失败/半步/不支持工具都不前移游标 | 不代表后台 worker 的语义判断质量（oracle 适配器给的是上界） |
| 覆盖率是多少？ | 只给**区间**：oracle 上界 / no-value 下界 | 不能写成「覆盖率提升 X%」这种点估计 |
| 全局干扰有没有把私有写污染？ | 泄漏 0，冲突进 held | 不代表真实全局库内容与真实干扰强度 |

---

## 2. 运行方式

```bash
# 全量确定性回放，JSON 打到 stdout
node scripts/active-memory-ab.mjs

# 写机器可读报告（CRLF）
node scripts/active-memory-ab.mjs --out artifacts/active-memory-ab.json

# 只跑前 3 个 case / 只跑某一行
node scripts/active-memory-ab.mjs --cases 3
node scripts/active-memory-ab.mjs --row guide-weighted:oracle

# 人工重新钉 manifest 前先看当前摘要（不会自动改写 pin）
node scripts/active-memory-ab.mjs --digests
```

测试：

```bash
node --import ./tests/loader-register.mjs --test tests/active-memory-ab.test.mjs
```

**确定性脚本没有任何参数能开启真实模型调用**：`--real-model`、`--live`、`--model`、`--network`、`--gold` 一律直接报错退出。真实模型有独立的一支运行器（`scripts/active-memory-ab-live.mjs`），用法、两臂定义与实测结果见 §9；它同样不把 synthetic-proxy 数据集升级为 gold。

---

## 3. 数据集与固定快照

### 3.1 十四个 case

| case | 干扰维度 | 它在测什么 |
|---|---|---|
| `clean-dense-turn` | off | 密集回合：分数达标就检查，不等空闲 |
| `clean-thin-turn` | off | 薄回合：没有空闲窗口，也不该唤醒 |
| `clean-starved-small` | off | 小会话饥饿：空闲到阈值无条件检查一次 |
| `clean-large-thin` | off | 大 transcript（2090 事件）薄回合：不吃饥饿豁免 |
| `clean-half-step` | off | throughSeq 停在 `tool/call` 上：半步 → deferred，不推进游标 |
| `clean-duplicate-reread` | off | 主模型已写过一条 + 重复轮询：重复/已存在怎么算 |
| `clean-recent-recall` | off | 刚注入过记忆：抑制，而不是"检查过没东西" |
| `global-relevant` | relevant | 相关全局条目可以进上下文，但不许复制进私有写 |
| `global-irrelevant-conflict` | irrelevant-conflict | 无关且冲突的全局条目：只进 held，不进可召回覆盖 |
| `no-human-turn` | off | 纯工具轮询：`no-human-turn` 与"没有新事实"是两回事 |
| `clean-scale-100` | off | 规模梯度最小档（98 事件）：低于阈值，饥饿豁免生效 |
| `clean-scale-1000` | off | 规模梯度（998 事件）：仍在阈值下，行为与上一档一致 |
| `clean-scale-5000` | off | 规模梯度（4998 事件）：越过阈值，薄回合不再吃饥饿豁免 |
| `clean-scale-20000` | off | 规模梯度上限区（19998 事件）：验证阈值以上不再有豁免 |

### 3.2 pin（`tests/fixtures/active-memory-ab/manifest.json`）

快照摘要 = `sha256(canonicalJson({ schemaVersion, fromSeq, throughSeq, events[fromSeq..throughSeq] }))`。`throughSeq` 之后的事件是"尚未到达"，**不进摘要、不进逻辑检查范围，也不进 worker seed**；实际 seed 仍是从 0 到当前 `throughSeq` 的完整连续前缀。

| case | throughSeq | 事件数 | 快照 sha256（前 12 位） |
|---|---:|---:|---|
| clean-dense-turn | 22 | 23 | `01b63a470444` |
| clean-thin-turn | 9 | 10 | `73cfdd46eb46` |
| clean-starved-small | 9 | 10 | `49145876868c` |
| clean-large-thin | 2089 | 2090 | `e828cde9d7ee` |
| clean-half-step | 3 | 4（+8 尾事件） | `c6eb87ef6767` |
| clean-duplicate-reread | 13 | 14 | `d48163e03141` |
| clean-recent-recall | 9 | 10 | `2ea689efcda4` |
| global-relevant | 4 | 5 | `0f4d97adf484` |
| global-irrelevant-conflict | 9 | 10 | `0a1d5e3a7396` |
| no-human-turn | 5 | 6 | `851fa7965cbe` |
| clean-scale-100 | 97 | 98 | `ec6180fcd444` |
| clean-scale-1000 | 997 | 998 | `04510b40d08e` |
| clean-scale-5000 | 4997 | 4998 | `dc9095796c6c` |
| clean-scale-20000 | 19997 | 19998 | `400e916841df` |

数据集级 `casesDigest`（所有 pin 的 sha256）：`8f44dfa8e4ab7818a1e750e9f2e26c8b71e97e00e3cb5967294a3f29ef9c0d75`（14 个 case 版本；加入规模梯度前的 10-case 版本是 `93e1f663…`）。

大 transcript 那个 case 用确定性填充（`ab-polling-padding-v1`）：520 组完全相同的轮询结果，展开成 2080 个事件后参与摘要，因此既可复现又能跨过 2000 事件阈值；这些结果去重后只算 **1 个工作单元**（测试里有断言）。

---

## 4. 三组条件与四行

| 行 | 条件 | 检查时机 | 逻辑检查范围 / 实际 seed | 有无 guide |
|---|---|---|---|---|
| `legacy` | 旧行为 | 只有空闲 ≥ 3 分钟 | 整段前缀；实际 seed 为完整连续前缀 `[0..boundary]` | 无 |
| `guide` | 统一 guide | 同 legacy（guide 只改投放的规则消息） | 整段前缀；实际 seed 为完整连续前缀 `[0..boundary]` | 有（`rulesKey` 占位符） |
| `guide-weighted:oracle` | guide + 加权检查 + 快照 worker | `assessWake`（分数/饥饿/大 transcript）+ 抑制 | 逻辑资格范围是游标之后的范围；实际 seed 仍为完整连续前缀 `[0..boundary]` | 有 |
| `guide-weighted:no-value` | 同上，但 worker 总返回 `no_value` | 同上 | 同上；**没有 windowed seed** | 有 |

后两行是**同一调度、不同适配器**：oracle 给覆盖上界，no-value 给下界。真实模型落在两者之间，本 harness 不测。

触发计划全部由生产纯函数复算（`lib/active-memory.js` 的 `collectEvidence / scoreEvidence / assessWake / suppressionReason`），没有另写一套阈值；旧行为那 3 分钟空闲常量在脚本里是 `LEGACY_IDLE_MINUTES`，只用于对照。

---

## 5. 实测结果（2026-10-30，合成代理集，interference = off 的 12 个 case）

| 指标 | legacy | guide | guide-weighted:oracle | guide-weighted:no-value |
|---|---:|---:|---:|---:|
| 覆盖 | 14/20（main 1 / 后台 13） | 14/20（同左） | **11/20**（main 1 / 后台 10） | 1/20（只有 main 1） |
| 未覆盖 | 6 | 6 | 9 | 19 |
| 延迟（人类回合）mean/median/max | 0.643 / 1 / 1 | 0.643 / 1 / 1 | 1.182 / 1 / 3 | 0 / 0 / 0（n=1） |
| no_value 率 | 1/9 = 0.111 | 1/9 = 0.111 | 0/6 = 0 | 5/6 = 0.833 |
| 重复提议 / 已存在 | 1 / 0 | 1 / 0 | 1 / 0 | 1 / 0 |
| 后台检查次数 | 9 | 9 | 6 | 6 |
| 每千步骤检查次数 | 1.280 | 1.280 | 0.853 | 0.853 |
| 种子 token 估算（总/每次） | 46019 / 5113.2 | 46019 / 5113.2 | **4240 / 706.7** | 4240 / 706.7 |
| 父会话等待（未测） | 未测（null） | 未测（null） | 未测（null） | 未测（null） |
| 被拦原因分布 | `no-idle-gap` × 12 | 同左 | `low-score` × 10, `large-transcript-thin` × 3, `recent-recall` × 2, `no-human-turn` × 1 | 同左 |
| 唤醒触发 | `legacy-idle` × 9 | 同左 | `score` × 1, `starved` × 5 | 同左 |
| deferred / failed / 凭证不合法 | 0 / 0 / 0 | 0 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |

标签总数 20，来自 12 个 interference = off 的 case（`global-relevant` / `global-irrelevant-conflict` 不进主表）。

相对 legacy 的差（同一批 case）：

| 行 | 覆盖差 | 未覆盖差 | 检查次数差 | 种子 token 差 |
|---|---:|---:|---:|---:|
| guide | 0 | 0 | 0 | 0 |
| guide-weighted:oracle | −3 | +3 | −3 | −41779（约 −91%；检查次数/边界不同；每次 seed 仍是完整前缀） |
| guide-weighted:no-value | −13 | +13 | −3 | −41779（检查次数/边界不同；每次 seed 仍是完整前缀） |

**覆盖反转**：`guide-weighted:oracle` 现在是 11/20，**低于** legacy 的 14/20。原先那张表里加权比 legacy 多 1 条，那个结论不再成立。逐 case 拆开是：

| case | legacy | 加权 oracle | 差 | 原因 |
|---|---:|---:|---:|---|
| `clean-dense-turn` | 0/4 | 4/4 | +4 | 分数达标就检查，不等空闲 |
| `clean-large-thin` | 2/2 | 0/2 | −2 | `large-transcript-thin` 拦停 |
| `clean-scale-5000` | 2/2 | 0/2 | −2 | 同上（新增档） |
| `clean-scale-20000` | 2/2 | 0/2 | −2 | 同上（新增档） |
| `clean-recent-recall` | 1/1 | 0/1 | −1 | `recent-recall` 抑制 |

净 −3。原先「加权覆盖更好」只在 8-case 混比下成立，是 fixture 规模的产物，不是规则属性：那批 case 里只有 1 个超过 2000 事件阈值，而今天有 3 个。规则实际在做的事是拿覆盖换 seed 成本，换多少取决于 transcript 规模分布，不取决于规则本身。

### 5.1 全局干扰（独立维度，只取 guide-weighted:oracle 行）

| 干扰等级 | case 数 | 后台检查 | 锚点 token 估算 | 泄漏 | held | 覆盖/未覆盖 |
|---|---:|---:|---:|---:|---:|---|
| off | 12 | 6 | 0 | 0 | 0 | 11 / 9 |
| relevant | 1 | 1 | 82 | 0 | 0 | 1 / 0 |
| irrelevant-conflict | 1 | 1 | 41 | 0 | 1 | 1 / 0 |

- 主表**只**用 interference = off 的 case 计算（测试里有断言），所以"全局干扰"不会被算进主调度效果，也不会替主调度背锅。
- 泄漏检查是"全局 id 出现在 `createdIds`/`updatedIds`/`heldIds`"，三行都是 0。
- 冲突 case 的 `outcome` 是 `mixed`：一条正常写入 + 一条进 `heldIds`，held 不算可召回覆盖。

---

### 5.2 规模梯度：阈值切换点与它的代价

四个规模 case 与 `clean-large-thin` 同源：标签、证据、分数逐项相同，唯一变量是 `padding.count`（98 / 998 / 4998 / 19998 事件）。数字直接取自报告 `cases[]`，按 `caseId` + `rowId` 取。

| case | 事件数 | legacy 检查 | legacy 覆盖 | legacy 种子 token | oracle 检查 | oracle 覆盖 | oracle 种子 token |
|---|---:|---:|---:|---:|---:|---:|---:|
| `clean-scale-100` | 98 | 1 | 2/2 | 176 | 1 | 2/2 | 176 |
| `clean-scale-1000` | 998 | 1 | 2/2 | 1632 | 1 | 2/2 | 1632 |
| `clean-scale-5000` | 4998 | 1 | 2/2 | 8103 | 0 | 0/2 | 0 |
| `clean-scale-20000` | 19998 | 1 | 2/2 | 32368 | 0 | 0/2 | 0 |

- **切换点正好落在 2000。** 998 事件仍然检查（`starved`，1 次 completed）；4998 事件完全不检查（0 次）。两档的 `evidence` 一致（humanTurns 2、toolUnits 1、score 0.249），legacy 也各检查 1 次，所以差异只能来自 `transcriptEvents > 2000`。2090 事件的 `clean-large-thin` 同样在加权行被拦成 0 次，与这条阈值一致。
- **守卫的代价可以量化。** 19,998 事件下一次 fork 的种子 token 估算 32,368（约 3.2 万），守卫把它降到 0；同一 case 的标签覆盖同时从 2/2 掉到 0/2。2090 事件档同理：3399 → 0，2/2 → 0/2。省下的是整个 fork，不是更便宜的 fork。
- **每次 seed 成本随事件数近似线性。** 四档折算每事件 176/98 = 1.80、1632/998 = 1.64、8103/4998 = 1.62、32368/19998 = 1.62 token。98 → 19998 多出的 19,900 个事件多花 32,192 token，边际 1.62 token/事件；98 档偏高是小档固定开销（约 17 token）。
- **边界。** 这证明的是**触发规则**在阈值上下的差异，不证明漏记问题被解决；种子仍是完整连续前缀 `[0..throughSeq]`，不是 windowed seed。守卫把 seed 变成 0，不是因为 seed 变短了。

---

## 6. 指标定义（照抄，避免下次改口径）

| 指标 | 定义 | 口径警告 |
|---|---|---|
| 覆盖 coverage | 有标签的 id 里，被"主模型主动写"或"后台写"覆盖的比例；按 `mainProactive / background / held / uncovered` 分开计 | oracle 适配器给上界，不是模型实测 |
| 延迟 latency | 标签的 `sourceSeq` 到首次写入边界之间的**人类回合数**与 **step/end（已完成步骤）数** | 不是毫秒；本 harness 不测真实 prompt 延迟 |
| no_value 率 | `status = completed` 且 `outcome = no_value` 的比例；分母是所有已执行的 checks（含 deferred） | 只有 completed/no_value 进分子；抑制不产生 check，`skipped`、`failed`、`deferred` 仍留在 checks 分母 |
| 重复 duplicates | 已写过的 id 再次出现在检查窗口里（`reproposed`）与重复 update（`alreadyPresent`） | 重复写不算新增覆盖 |
| held | `heldIds` 条数；与可召回覆盖分开 | held ≠ 覆盖，也 ≠ no_value |
| 调用 calls | 后台检查次数、每千 step/end 的检查次数、主模型记忆工具调用数 | 调用数不等于写入成功数 |
| 证据 evidence | 窗口内真人回合数（以及 `collectEvidence` 的字符/工作单元分项） | 轮询重复只算一次 |
| 成本 cost | `lib/budget.js estTokens` 对每次检查实际送进 worker 的完整连续前缀 `[0..throughSeq]` 事件文本求和；总量只累加实际触发的 checks | `estimateOnly: true`，不是实际 token 用量；总量差异可能只来自检查次数/边界，不是 windowed seed |
| 阻塞 blocking | 主会话等待没有持续时间观测，报告固定为 `mainSessionWaitForCheck: null` / unknown | 不是实测的阻塞耗时；不能写成 0 |

---

## 7. 怎么读这些数字（重要）

1. **oracle 上界与 no-value 下界之间的差，是"模型有没有找到应记事实"的空间，不是本 harness 的结果。** 真实模型落在中间某处，本 harness 不给点估计。
2. **guide 行与 legacy 行完全相同**：在这批 fixture 上，guide 只改变投放的规则消息，不改变什么时候检查。guide 对模型遵从性的影响只能由真实模型调用测出；本文不作结论。
3. **加权这一行的总估算较低，不代表每次 seed 变短**：检查次数 −3、总种子 token −41779（约 −91%），因为触发的检查次数/边界不同；每次实际 seed 仍是完整连续前缀。父会话阻塞与等待时长均未测，报告为 unknown / `null`，因此不能推导阻塞改善或等待差异；覆盖净 −3 是两股力量对冲的结果：`clean-dense-turn` 的 +4 来自"密集回合也能检查"，三个越阈值 case 的 −6 与 `recent-recall` 的 −1 来自守卫和抑制，不是来自更好的语义判断。
4. **no-value 下界说明"更省"不等于"更好"**：同调度、worker 总是空返回时覆盖从 6 掉到 1。两边必须一起看。
5. **大 transcript 那个 case 是这一轮的核心里程碑**：旧路径在薄回合上仍 fork（1 次，完整前缀 seed 3399 token 估算），加权路径按 `large-transcript-thin` 拦住（0 次）。这只证明**触发规则**生效，不证明漏记问题被解决；它不是 windowed-seed 的收益。

---

## 8. 人审候选与 gold gating 是两件事

- 候选：case 存在、标签写了 `sourceSeq`、有人读过 → 仍只是 `review: "pending"`。
- 金标：需要人工逐条确认后把 `review` 改成 `human-reviewed`。**本 harness 不改它**，报告里 `goldGating.reviewedCases` 恒为设备实际值（今天是 0），`goldGating.goldAllowed === false`。
- 结构校验强制这条纪律：`annotationSource: "human"` 但 `review` 不是 `human-reviewed` → 直接 fixture 错误；任何 `gold: true` 的合成代理 case → 直接 fixture 错误。
- 报告的 `status` 恒为 `synthetic-proxy-not-gold`，`gold` 恒为 `false`。要改这两项只能改数据集的机器可读状态，而那是人审之后的事。

---

## 9. 真实模型 A/B：工具调用协议下的双臂实测（2026-10-30）

`scripts/active-memory-ab-live.mjs` 用工具调用协议跑真实模型：模型 `deepseek-flash`，OpenAI 兼容接口 `https://api.deepseek.com`。旧的 JSON 协议运行器已随 1.2.0 删除：它测的是无工具环境的降级路径，75 次请求全部 `candidates-invalid`，不产生任何可评分信号。

```bash
# 只看计划，不联网
node --import ./tests/loader-register.mjs scripts/active-memory-ab-live.mjs --dry-run
# 真跑（key 只从环境变量读）
ACTIVE_MEMORY_AB_API_KEY=... node --import ./tests/loader-register.mjs scripts/active-memory-ab-live.mjs --live --arm both --out report.json
```

两臂只差一个变量：**baseline** 每个 case 都送模型；**weighted** 只送生产调度器判定要检查的 case（`assessWake` + 抑制），其余记 `scheduled-out`。提示词（system-guide + private-consolidation + 本地工具契约 + 任务书）、工具表、转录在两臂之间完全相同。半步（`tool/call` 无配对结果）由硬守卫挡住，两臂都不发请求，所以 baseline 是 13 次调用而不是 14 次。

同一配置连跑两遍（报告是仓库外的临时 JSON，不提交）：

| 指标 | baseline | weighted |
|---|---:|---:|
| 实际调用 | 13 | 8（5 个 scheduled-out）|
| 参与统计的标签 | 22 | 15 |
| 覆盖（第 1 / 第 2 遍） | 11 / 9 | 7 / 9 |
| 覆盖率 | 0.50 / 0.41 | 0.47 / 0.60 |
| 写出的记忆条数 | 11 / 9 | 7 / 9 |
| **precision（写出即命中）** | **1.00 / 1.00** | **1.00 / 1.00** |
| prompt tokens | 36,392 | 23,107（−37%）|
| 填了 emotion 的条数 | 3 / 3 | 4 / 5 |
| 填了 dominance 的条数 | 0 / 0 | 0 / 0 |

**协议对了，产出就可用了。** 同一批 case，JSON 协议下 0 条可解析；工具调用下每一次调用都写出了合法记忆，且**写出即命中**（precision 1.00，两遍都是）——没有一条是凭空编的。此前 0.77–0.80 的 precision 是漏了整理提示词的产物，不是模型行为。

**守卫的账可以算清。** 把两臂对齐到同 8 个 case，覆盖是 10 对 8（标签基数 15），差异落在下面的方差内；被跳过的 5 个 case 共 7 条标签，baseline 在那里平均只覆盖 1 条。也就是说：**−37% prompt token 换约 1/22 条标签的延迟**，不是覆盖的永久损失——游标不前移，内容仍在 pending。

**情绪只在人物侧生效。** 工程类 fixture 上 emotion 只填在涉及人的条目（3–5 条），dominance 全为 0——这正是提示词要求的：工程事实固定中性，dominance 只跟人物侧 emotion 一起填。不要把这读成「模型没填」。

边界：

- 覆盖是**词面匹配**（overlap ≥ 0.3 或命中拉丁/数字强标记），不是语义判断，也不是人工金标；
- 标签仍是 `synthetic-proxy`，0 条人审；
- **n = 2**，两遍差异可达 ±2 条，任何小于这个幅度的改动都不可分辨；
- 与生产仍有唯一一处差异：生产把转录作为 fork 的种子会话传入，运行器把转录渲染成带 seq 的文本附在消息里。

---

## 10. C 包接口（可注入适配器）

F 包与 C 包并行开发，接口先按契约落地，C 的真实现只要满足这两条就能接进来，不需要改 harness：

### 10.1 适配器输入 / 输出

适配器是 `async (ctx) => credentialPayload`，通过 `runAb({ workers: { 'no-value': fn } })` 注入（`rowIds` 可只选一行）。

`ctx`：

```text
caseId, rowId, condition, path ('full-prefix-fork' | 'snapshot-worker')
fromSeq, throughSeq, snapshotSha256, scopeGeneration        // 固定快照身份
events                                                       // 逻辑检查范围 [fromSeq, throughSeq]
seedEvents                                                   // 实际 worker seed：完整连续前缀 [0, throughSeq]
labels, labelsInRange, existingIds                           // 已有 id 不能再算新增
interferenceInput { level, globalIds, conflictLabelIds, anchorTokens }
halfStep, now, transcriptEvents, evidence
```

返回（**边界身份必须由 harness 填，适配器不许自报**）：

```text
status: completed | skipped | deferred | failed
outcome: created | updated | mixed | no_value
createdIds / updatedIds / heldIds / reasonCode / retryable
```

### 10.2 凭证与游标规则（`validateCredential` / `canAdvance`）

- `checked.{fromSeq, throughSeq, snapshotSha256, scopeGeneration}` 必须与请求逐项相同，否则凭证不合法；
- 同一 id 不能出现在两个桶里；非 `completed` 不得声称写入了任何 id；`no_value` 不得带 created/updated；
- **只有** `completed`（含 `no_value`）前移游标；`deferred / skipped / failed / 凭证不合法` 一律不动游标；半步（`tool/call` 没有配对 `tool/result`）由 harness 直接判 `deferred: half-step`，worker 不参与；
- 相邻检查的 `fromSeq` 必须等于上一段是否推进后的游标，报告 `structureChecks` 为空才算 `ok: true`。

### 10.3 与 C 实现的边界

- 本 harness **不** fork、**不**写库、**不**读 `state.json`、不创建任何用户目录（测试里用 sentinel 断言）；§9 的 live 运行器遵守同一组边界，且不留模型原文、不留转录正文、不落 key；
- C 的真实 worker（专用整理职责、真实工具面、真实 CAS）接进来时，只要按 §10.1 返回，就能拿到同一批指标；
- 现在这两行适配器是**注解预言机**与**空返回**，它们量的是"管线的上/下界"，不是 worker 质量；适配器收到的 `seedEvents` 也遵循生产的完整前缀语义。

---

### 10.4 与 C 包实现的字段对齐（并行开发，只读核对）

C 包的 `lib/consolidation-receipt.js` 与 `lib/consolidation-snapshot.js` 用同一套枚举与同一段覆盖范围，可以直接接进来：

| 本文 adapter payload | C 包 receipt | 说明 |
|---|---|---|
| `status` | `RECEIPT_STATUSES` = `completed \| skipped \| deferred \| failed` | 同集合 |
| `outcome` | `RECEIPT_OUTCOMES` = `created \| updated \| mixed \| no_value` | 同集合 |
| `checked.{fromSeq, throughSeq}` | `checkedRange.{fromSeq, throughSeq}` | 字段名不同，值语义相同 |
| `createdIds / updatedIds / heldIds / reasonCode / retryable` | 同名 | 一致 |
| `checked.snapshotSha256` | 由 `snapshotHash` / `captureSessionSnapshot` 持有，回执里**不含** | 一致的分工：凭证身份不能由 worker 自报 |

两个形状差异记在这里，避免以后接真转录时猜：

1. **工具调用 id 的位置**：fixture 用顶层 `toolCallId`；宿主转录用 `event.data.callId`（`tool/call`）与 `event.data.message.callId`（`tool/result`），助手消息里的 `tool-call` 块用 `block.id`。本文的 `toolCallIdOf()` 与 `detectHalfStep()` 两种都认，所以半步判定在真转录上同样成立。
2. **半步判定**：两边都只看"有没有配对的 `tool/result`"，都不读半份转录；C 包另外会补 `interruptedTurnClosers`，本文不做这件事——它只判 `deferred`，把"补齐"留给读盘的实现方。

接入方式：C 的 worker 跑完后用 `parseReceipt` 拿到 receipt，映射成本文 §10.1 的 payload，再 `runAb({ workers: { 'no-value': adapter } })` 注入即可；本文的凭证校验与游标规则会**再**检查一遍，不信任 worker 自报。

### 10.5 结构行：回执 → 凭证的回归

第五行 `guide-weighted:structural` 只换凭证来源，不换调度：worker 产出 C 包围栏格式的回执文本，`lib/consolidation-receipt.js` 的 `parseReceipt` 解析，`receiptToCredential` 映射成 §10.1 的 payload，之后照旧走 `validateCredential` / `canAdvance`。适配器自报的 id 仍不被信任。

- **默认不跑。** 默认报告仍是四行；结构行要用 `--row guide-weighted:structural` 显式指定，避免每次全量回放都多跑一遍回执编解码。
- **实测（2026-10-30）与 oracle 行逐 case 完全一致。** 14 个 case 的覆盖、检查次数、种子 token 全部相等（12 个 off case 合计 11/20 覆盖、6 次检查、4240 token；`deferred` 1、`failed` 0、凭证不合法 0）。也就是说，真 worker 的产出形状（回执 + 围栏）经 `parseReceipt` 后能被 §13.6 的凭证规则无损接受，不需要为它放宽规则。

三种失败映射：

| `parseReceipt` 结果 | 映射后 status | retryable | 落点 |
|---|---|---:|---|
| `receipt-missing`（没有回执） | `failed` | true | 游标不动 |
| `receipt-malformed`（围栏内 JSON 坏） | `failed` | true | 游标不动 |
| `receipt-invalid`（结构/枚举不符） | `failed` | true | 游标不动 |

三者都**不降级成 `no_value`**。理由是语义不同：`no_value` 表示"检查过、没有新事实"，按 §10.2 会推进游标；空白或截断表示"没有结论"，必须可重试，否则一次坏输出会被记成一次空检查，永久跳过那段范围。

一次完整 live 执行由两臂相加：baseline **13 次** + weighted **8 次** = **21 次 HTTP**。14 个 case 里，`clean-half-step` 两臂都被硬守卫挡住，weighted 另有 5 个 `scheduled-out`。任何真实模型复跑的成本都按这个数估。

已知语义分歧：C 包的 `decideCompletion` 认为带 `reasonCode` 的 `skipped` 也可以推进游标，本 harness 只认 `completed`。映射层因此把非 `completed` 的 id 桶一律清空——`skipped` 即使带了 `createdIds` 也不保留，`heldIds` 同样丢弃。这是有意的保守：宁可丢弃一次本可结算的 `skipped`，也不让未完成的检查被计成覆盖。接真 worker 时若要改这条，应当先改 §10.2 的游标规则，而不是在映射层偷偷放行。

## 11. 已知边界与未测项

- 主模型主动率（需要真实模型调用与用户明确授权）；
- guide 正文对模型遵从性的影响；
- 后台 worker 的语义判断质量（oracle 适配器是上界；§9 的 precision 是词面匹配，不是语义判断）；
- 真实 prompt 延迟与主任务阻塞耗时；
- 真实 token 消耗：确定性回放只有 estimate（按每次完整前缀 seed 累加）；§9 的 prompt token 来自 provider usage，但只覆盖那一轮 fixture；
- 窗口化 seed 不是本 harness 的语义：生产 `private.js` 以完整连续前缀 `[0..throughSeq]` 作为 seed；逻辑资格范围仍单独由 `events` / `fromSeq..throughSeq` 表示；
- D 包的合并账本、跨重启恢复的真实案例未覆盖：这里的"重启后同一份快照"只体现为凭证身份校验，不是真机重放。

### 11.1 积压上界（`maxPendingEvents: 600`）

`assessWake` 新增 `pendingEvents` 维度：待整理区间达到 `maxPendingEvents`（默认 600 事件）时，在真人回合这道硬门槛之后、分数与大 transcript 守卫之前，无条件是检查一次，`reason` 为 `backlog`。

这条规则给延迟加上界，而不是放宽守卫。守卫要挡的是「为一句轻话重种整段转录」，不是「把从没整理过的大会话永远挡在门外」：没有上界的话，一个大会话只要每轮都是轻话，早期决定就永远等不到检查。被守卫跳过的区间游标不前移、内容仍在 pending，所以被跳过的是延迟而不是内容；`backlog` 只是把这段延迟封顶在 600 事件。

fixture 的 `snapshot.pendingEvents` 默认为 0，表示「已整理到区间起点、只有薄增量是新的」，因此 §5 的数字不受这条规则影响。

---

## 12. 本轮验证（2026-10-30）

```text
node --check scripts/active-memory-ab.mjs                      ok
node --check scripts/active-memory-ab-live.mjs                 ok
node --check tests/active-memory-ab.test.mjs                   ok
node --import ./tests/loader-register.mjs --test tests/active-memory-ab.test.mjs
  ℹ tests 38 / pass 38 / fail 0 / skipped 0
node scripts/active-memory-ab.mjs                              ok:true, structureChecks 为空, 14 cases
node scripts/active-memory-ab.mjs --row guide-weighted:structural
                                                               ok:true, 与 oracle 行逐 case 一致
node --import ./tests/loader-register.mjs scripts/active-memory-ab-live.mjs --dry-run
                                                               ok:true, dryRun:true, 14 cases, 计划 13 + 8 = 21 次
```

回归测试另外构造临时双检查 fixture（不改固定数据集）：第二次 weighted 逻辑检查从 seq 10 开始，但所有 arm 的 seed 都是 `[0..19]` 完整连续前缀；同时断言 token 估算来自该前缀，证据与标签资格仍限于逻辑范围。两条 fork 路径的父会话等待都断言为 `null`，且 delta 中不允许伪造等待差异。

报告本身（`report.ok`）为 `true` 的含义只是：**没有结构违规**——区间连续、凭证合法、全局条目零泄漏。它**不**表示"主动记忆效果已通过验收"。
