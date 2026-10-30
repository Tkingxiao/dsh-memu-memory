# 情绪模型改造方案：四项构成与双辅助轴

状态：**已实施（P0–P3）**，WebUI 只读展示随 P2 落地  
版本：v3（2026-10-30）  
适用范围：私有记忆的本地情绪读取、记忆写入与召回排序；不扩展全局记忆。

> 本文仍是目标契约：实现应与本文一致；不一致时以本文为准并修实现。实施结果与三处已修正的偏差见 §10。

## 1. 目标与边界

### 1.1 目标

1. 在不调用模型的前提下，把当前单一 valence 扩展为四项情绪构成、arousal 和 dominance。
2. 保留现有 valence 读写兼容性，并为旧条目提供确定的降级路径。
3. 让情绪对召回的影响有界、可关闭、可回归测试。
4. 让后台整理、远程整理和前台写入明确区分情绪来源。

### 1.2 非目标

- 不给全局记忆增加情绪字段。
- 不把情绪写入注入文本或记忆正文。
- 不改变 peak、confidence、accuracyOf、negativityBias 的既有语义。
- 不引入模型调用或真实模型标注作为运行时依赖。
- 不在本阶段制作 WebUI 编辑控件；读取展示可以在后续阶段加入。

## 2. 当前实现事实

在开始实现前，以代码为准的现状是：

| 位置 | 当前行为 |
|---|---|
| lib/mood.js:29-71 | readMood、moodDecay、moodCongruence 只处理 valence/arousal |
| lib/state.js:893-900 | 会话 mood 只保存 valence/arousal/at |
| lib/memory.js:1135-1141 | 条目只写入 moodValence/arousal |
| lib/tools.js:190-193,309-320 | 工具尚无 emotion/dominance 参数 |
| lib/prompts.js:85-90 | 远程 JSON 契约尚无 emotion 字段 |
| lib/remote-summary.js:15-40 | 远程解析只保留现有 mood 字段 |
| lib/rpc.js:87-90 | RPC 只投影 moodValence/arousal |

本文中的路径和行号只用于定位现状；实现时应按符号搜索，不依赖固定行号。

## 3. 规范化数据契约

### 3.1 情绪构成

使用四个固定轴：joy、anger、sorrow、fear。

有效的非空 emotion 满足：
- 四个键都存在；值必须是有限数。
- 每个值必须大于等于 0。
- 四项之和必须大于 0；写入前归一化到和为 1。
- 归一化误差要求 abs(sum - 1) < 1e-9。

emotion: null 是规范的中性表示。为了兼容工具调用，显式全零对象也接受，但在校验后规范化为 null；它不能被当作四轴全都有少量情绪。

非法输入必须拒绝并在错误中包含 emotion：缺键、非有限数、负数、数组、字符串和非正和都不能静默修复。实现可对极小浮点误差使用固定容差，但不得把负数 clamp 成合法值。

### 3.2 强度与掌控感

| 字段 | 范围 | 缺失默认 | 说明 |
|---|---:|---:|---|
| arousal | 0..1 | 0.35 | 情绪激活程度；显式 0 保留为 0 |
| dominance | -1..1 | 0 | 主动/失控程度；显式 0 保留为 0 |

缺失和显式值必须区分：缺失使用默认值，显式 arousal: 0 或 dominance: 0 不得被 || 覆盖。

内部存储、工具和远程协议统一使用字段 dominance，不再引入 mood_dominance。若未来必须兼容该别名，只能在输入边界映射一次，内部和输出只保留 dominance。

### 3.3 记忆条目字段

| 字段 | 类型/范围 | 说明 |
|---|---|---|
| emotion | 四轴对象或 null | 事件的情绪构成 |
| arousal | 0..1 | 事件激活程度 |
| dominance | -1..1 | 事件中的主动/失控程度 |
| emotionSource | model/session/content/unknown | 系统审计字段 |
| moodValence | -1..1 | 派生的旧路径兼容投影 |
| peak | boolean | 保持现有语义 |

emotionSource 不属于普通用户可编辑字段：model 表示工具参数显式提供；session 表示允许继承当前会话 mood；content 表示从记忆正文读取；unknown 表示没有足够证据。

旧条目没有 emotion 时保持原样，不从旧 valence 反推四轴。

## 4. 本地读取算法

### 4.1 readMood 返回值

返回值必须继续包含 valence，并追加目标字段：

{ valence, emotion, arousal, dominance }

现有否定预处理必须保留。实现建议按句切分，在每句内取各轴的最大命中权重，再按规则合并；不得继续使用会把多个命中平均到接近中性的旧算法。

- 缓和词按所在分句生效：有点、稍微、一点点、a bit、somewhat。
- 一点都、一点也不、一点也没不属于缓和词。
- 强度词和重复标点可以提高 arousal，但必须有明确上限。
- 未命中可靠情绪词时返回 emotion: null，而不是强行生成均匀分布。

### 4.2 dominance

初始实现采用可解释的词表加构成先验：

dominance = clamp(lexicalDominance + 0.4 * (anger - fear), -1, 1)

词表中存在歧义词时，不能把结果宣称为事实；dominance 只作为有界排序辅助。词表测试必须覆盖高控制、低控制、怒和惧的相反方向。

### 4.3 派生 valence

必须先确定并测试纯轴结果，再实现公式。v3 采用以下固定系数：

raw = 0.8 * joy - 0.8 * anger - 0.8 * sorrow - 0.8 * fear
moodValence = clamp(raw, -1, 1)

这保证四个纯负轴都为负，纯喜为正；emotion 的构成仍由四轴本身表达，valence 只是旧路径的兼容投影。所有纯轴和代表性复合轴都必须有单元测试，不能同时保留与该结论冲突的经验公式。

### 4.4 衰减

情绪构成不按比例衰减；强度和掌控感衰减回基线：

fade = 0.5 ** (minutes / 90)
arousal = 0.35 + (arousal - 0.35) * fade
dominance = dominance * fade

当 fade < 0.35 时，emotion 变为 null。边界是严格小于；fade === 0.35 仍保留构成。即使 emotion 变为 null，arousal 和 dominance 仍返回并继续衰减。

## 5. 召回语义与兼容降级

### 5.1 新路径

双方都有合法 emotion 时：

overlap(p, q) = sum(min(p[i], q[i]))
moodBias = 1 + 0.3 * fab * (2 * overlap - 1)

moodBias 必须限制在 [0.7, 1.3]。dominance 双方都有有限值时：

domBias = 1 + 0.2 * (0.5 - abs(entry.dominance - context.dominance) / 2)

domBias 必须限制在 [0.9, 1.1]。任一 dominance 缺失或非法时，domBias 必须为 1，而不是传播 NaN。

### 5.2 旧路径

读路径必须使用唯一分流：
1. 双方都有合法 emotion：使用 overlap；
2. 否则双方都有可用 legacy valence：使用既有 moodCongruence/fadedValence；
3. 否则：情绪乘数为 1。

旧条目不反推 emotion。新字段接入召回后，必须验证旧条目、旧会话 mood 和缺失字段不会产生 NaN。

### 5.3 门控

门控是三条独立条件的 OR：

emotionActive = (emotion !== null && maxShare(emotion) >= 0.35) || abs(arousal - 0.35) >= 0.1 || abs(dominance) >= 0.25

emotion === null 只会关闭第一条，不会关闭 arousal 或 dominance 两条。必须测试 null+高 arousal 开启、null+高 dominance 开启、全基线关闭，以及非空低 share。

arousal intensity 代理应使用 max(arousal, maxShare(emotion), legacyValenceProxy, peak ? 1 : 0)；没有 emotion 时只使用旧字段和 arousal。

## 6. 写入、远程和 fork 语义

### 6.1 工具参数

memu_private_remember 和 memu_private_update 使用 emotion: object|null、arousal: number、dominance: number。

工具描述必须说明：emotion 描述记忆所述事件，不是整理时的心情；省略、null、全零的语义分别是继承、明确中性、规范化为 null。对工程事实（owner=about_project）默认使用 null。

更新操作单独定义：省略字段表示保留原值；显式 null 清除 emotion 并将来源设为 unknown；显式对象经过同一套校验和归一化。

### 6.2 远程 JSON

远程协议只输出一个 JSON 对象，字段使用统一名称：

{ memories: [{ title, content, emotion: null, arousal: 0.35, dominance: 0, mood_valence: 0, source: inferred, visibility: shared }] }

visibility 只允许当前代码支持的 shared 或 secret；不得再使用已废弃的 session。远程缺字段时回落到兼容默认；字段存在但非法时应记录可诊断错误并拒绝该条，不静默改成合法情绪。

### 6.3 后台整理 fork

后台 fork 不继承父会话的即时 mood。创建子 binding 时显式使用 mood: null，避免把整理时的心情误写成事件情绪。

写入来源优先级：模型显式 emotion -> model；允许继承且存在 session mood -> session；从该条 content 读取出可靠情绪 -> content；否则 emotion=null、dominance=0、arousal=0.35、source=unknown。工程事实固定使用中性。

## 7. 分期

### P0：本地读取，保持旧 API

只改 lib/mood.js 及其单元测试：四轴词表、校验/归一化、dominance、派生 valence、分句和衰减。返回值追加字段但保留 valence。P0 不是零召回行为变化：inject.js 会把读取结果写入 binding，arousal/valence 变化可能影响后续排序；若产品必须零变化，则 P0 必须由 feature flag 隔离新字段。

### P1：召回

在 lib/memory.js 接入 overlap、domBias、三腿门控和 intensity 代理；保留旧路径。补充 property tests、legacy fixtures 和 NaN 防护。

### P2：写入与协议

更新 state.js、memory.js、tools.js、prompts.js、remote-summary.js、rpc.js。完成 remember/list/update/recall 往返测试，确认缺失字段和旧 index 可读取。

### P3：来源与 fork

更新 private.js、整理提示词和来源审计；验证 fork 不继承即时 mood，验证 emotionSource 不可被普通 update 伪造。

### P4：展示与文档

更新 UI 只读展示、文档和 CHANGELOG。全局、图谱、备份和 active-memory A/B 不属于本功能范围。

## 8. 验收标准

- 有效 emotion 归一后和为 1，所有分量非负。
- 缺键、负数、非有限数、数组和非法 dominance 被拒绝。
- 全零输入规范化为 null；null 不生成均匀分布。
- 四个纯轴的 derived valence 方向正确；复合轴结果可复算。
- overlap 自反、对称且在 [0,1]；bias 范围始终满足上界。
- 门控测试覆盖 null、高 arousal、高 dominance 和低 share。
- decay 在 0.35 两侧有明确、稳定结果。
- readMood(...).valence 继续存在；旧 setSessionMood({ valence, arousal }) 继续可读。
- 旧条目无 emotion 时不反推四轴。
- 远程缺字段可解析，非法字段可诊断拒绝。
- fork 不继承父即时 mood；工程事实保持中性。
- remember -> list -> update -> recall 往返保留字段和来源。

项目门禁：node --check changed JS files；npm test 必须 exit 0（允许明确列出的 skipped）；node scripts/acceptance-local.mjs；npm run check；git diff --check。文档中的测试数字不是永久常量，报告必须记录本次实际结果，不得以 fail 0 替代成功退出。

## 9. 风险与默认决策

- 词典推断不是事实识别；dominance 只能作为低权重排序信号。
- 四轴归一化会丢失强弱，强弱由 arousal 承载。
- fade < 0.35 有离散边界；实现不得私自改变契约。
- 远程模型可能输出不符合协议的 JSON；严格校验优先于尽量解析。

默认决策：四轴为 joy/anger/sorrow/fear；保留 valence；dominance 参与 P1 召回；门控阈值 0.35；旧路径至少保留一个版本；WebUI 本轮只读；远程和工具统一使用 dominance。

## 附录 A：初始词表与测试样例

初始词表至少覆盖：
- joy：开心、高兴、太好了、喜欢、爱、满意、惊喜、谢谢、期待；
- anger：气、烦、讨厌、气死、烦死、离谱、凭什么、受不了、恨；
- sorrow：难过、失望、崩溃、委屈、心疼、累、困、没意思；
- fear：害怕、恐慌、焦虑、担心、紧张、慌、吓死、不敢、万一；
- compounds：尴尬、嫉妒等必须有明确词条或明确组合规则，不能只出现在测试期望中。

复合预设是可解释的初始建议，不是硬编码事实：

| 表达 | 建议构成 | 建议 dominance |
|---|---|---:|
| 委屈 | sorrow 0.70 / anger 0.30 | -0.4 |
| 尴尬 | sorrow 0.50 / fear 0.50 | -0.5 |
| 嫉妒 | anger 0.50 / sorrow 0.30 / fear 0.20 | -0.1 |
| 心疼 | sorrow 0.80 / joy 0.20 | -0.2 |
| 不甘 | anger 0.60 / sorrow 0.40 | +0.4 |

验收样例必须把期望写成可计算范围：分别统计主导轴准确率、null precision/recall、arousal 误差和 dominance 误差；复合情绪允许 top-2 轴集合匹配并记录容差。

## 附录 B：实施前检查清单

- [ ] 实现并测试 normalizeEmotion、derivedValence、overlap 和门控真值表。
- [ ] 决定 P0 是否启用 feature flag；不要同时声称改 mood.js 且零召回变化。
- [ ] 明确 remember/update 的 omitted/null/zero 语义。
- [ ] 统一远程字段名和 visibility 枚举。
- [ ] 为旧 index、旧 binding、后台 fork 增加兼容测试。
- [ ] 以 npm test 退出码作为门禁，不引用过时的 878/取消测试数字。
- [x] 实现完成后再更新本文状态、版本和变更日志。

## 10. 实施结果（2026-10-30）

| 阶段 | 落地位置 | 结果 |
|---|---|---|
| P0 | `lib/mood.js` 重写：四轴词表、`normalizeEmotion`、`derivedValence`（统一 0.8 系数）、`maxShare`、`overlap`、`dominanceBias`、`emotionActive`、分句读取、`moodDecay` 的 0.35 边界 | 完成 |
| P1 | `lib/memory.js` 召回：overlap 路径 + 旧 valence 回落、dominance 乘数、三腿门控、`arousalBias` 的强度代理纳入 `maxShare` | 完成；`moodBias` 实测边界 0.7 / 1.3 |
| P2 | `state.js` / `tools.js` / `prompts.js` / `remote-summary.js` / `rpc.js` / `client.js` | 完成；remember → list → update → recall 往返通过 |
| P3 | `private.js` fork 显式 `mood: null`；四份整理提示词按回合还原情绪 | 完成 |
| P4 | 文档与只读展示 | 完成；WebUI 编辑控件按 §1.2 不做 |

实现期间发现并修正的三处偏差，记在这里避免重犯：

1. **`derivedValence` 早期草稿把 anger 记成正贡献**，与"四个纯负轴都为负"冲突。统一为 `0.8 * (joy - anger - sorrow - fear)`。
2. **`emotion: null` 曾在工具层被 `?? null` 与"省略"合并**，导致"明确中性"被会话心情覆盖。现在三态分开：`undefined` = 继承，`null` = 明确中性，全零对象 = 规范化为 null。
3. **`dominanceBias(null, x)` 曾因 `Number(null) === 0` 返回 1.05**。现在缺失或非法一律返回 1。

验收：`tests/emotion-contract.test.mjs`（17 条，由独立验收者按 §8 编写，不迁就实现）+ 全量 `npm test` 944 / 942 pass / 0 fail / exit 0。

端到端链路验证覆盖 8 条：读取、写入四态来源、持久化、更新三态、召回、旧条目降级、展示与协议、远程清洗；36 项断言全通过。
