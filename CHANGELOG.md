# 更新日志 / Changelog

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
