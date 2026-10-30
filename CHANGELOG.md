# 更新日志 / Changelog

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
