# 环境与命令 — dsh-memu-memory

搭环境、跑命令、装引擎时读这一份。

## 9. 环境与命令

### 9.1 跑命令（Windows 实测口径）

`process.env` 在工具化执行里是**空的**，直接 `execFile` 子进程会拿到残缺环境。固定用这套 env：

```js
const env = {
  ELECTRON_RUN_AS_NODE: "1", SystemDrive: "C:", SystemRoot: "C:/Windows",
  PATH: "C:/Windows/system32",
  TEMP: "C:/Users/<you>/AppData/Local/Temp", TMP: <同上>,
  USERPROFILE: "C:/Users/<you>", APPDATA: ..., LOCALAPPDATA: ..., HOME: ...
};
execFile(process.execPath, ["--check", "lib/x.js"], { cwd, env });
```

**Windows 坑**：`git` 不在 PATH（用文件 mtime 代替 `git status`）；`tasklist` / `taskkill` 要给全路径 `C:/Windows/system32/`；`os.tmpdir()` 可能返回带反斜杠的怪值，临时目录用显式绝对路径；模板字符串里的路径用正斜杠。

**源码是 CRLF**：任何补丁都按「读 → `split("\r\n").join("\n")` → 断言 `from` 命中 **1 次** → 替换 → 写回还原 `\r\n`」。命中 0 或 >1 次先停下看，不要盲写。（`tests/webui.test.mjs` 是 LF，别套 CRLF。）

### 9.1.1 链路回放巡检

```bash
npm run replay
```

`scripts/replay.mjs`：不走测试框架，按生产代码路径端到端重放七条链路（事实级去重工具层、PTC 整理成功/失败、整理提醒与日志页数据、侧边栏提醒块真实渲染、向量计数账本+戳、MemU 记忆页分组/多选/查看跳转）。只有 MemU 引擎子进程换成内存桩，其余全是真实模块；退出码 0 = 全部检查点通过。改动整理/去重/向量计数/提醒任一链路后跑一次，比单测更接近「用户点下去会发生什么」。

### 9.2 本地 link 到 DSH profile

`~/.dsh/profiles/<profile>/package.json` 里 `"dsh-memu-memory": "link:D:/Code/dsh-plugin/dsh-memu-memory"` 并加入 `dsh.profile.bundles`。是符号链接 → 改源码即刻生效（无 bundle 缓存）。`lstat` 验证是否 symlink（§3.10）。

### 9.3 引擎安装

**Python 解析顺序**：① `engine/current.json` 指向的 venv ② `DSH_MEMU_PYTHON` ③ `py -3.13` / `-3.12` / `-3.11` ④ DSH 自带 Python（实测 3.12.14 可装 0.11.0b3）⑤ `python3` / `python` ⑥ `py -3.14`（最后，wheel 可能滞后）。

**镜像顺序**：用户配置 → `https://pypi.tuna.tsinghua.edu.cn/simple` → `https://mirrors.aliyun.com/pypi/simple/` → `https://pypi.org/simple`。报错先看这三处：镜像顺序、venv 里是否残留 pip、`downloads/` 失败后是否被清。

**Lean venv**：`python -m venv --without-pip <venv>` + 基础 Python 的 `pip --python <venv python> install -r requirements.lock`，带 `--no-cache-dir`、`--only-binary=:all:`、`--disable-pip-version-check`。成功删 `downloads/`；失败删失败版本目录与 downloads。

**成功判定 `ready`**：依赖装好 + `import memu` 成功 + `memu --help` 含必需命令 + 空库 `list-files --json` 成功 + 记录版本/镜像/日志路径。embedding 检索要 API key，**不作为安装成功条件**。

**升级 / 切换 / 回滚**：新版装新目录，smoke 过才切换；**切换前对真实库做只读 smoke** 并**先备份**（必须含 `state.json` + `index/*.json`，只备 sqlite 等于没备）、写 `manifest.json`；schema 版本变化 UI 明示「X → Y」并二次确认，**降级默认拒绝**；失败删失败目录 + `current.json` 回写 + `history.json` 记 `attempts:[{at, ok:false, error}]`；成功留最近 3 版（`pruneEngineVersions({ keep = 3 })`，硬编码、不是设置项），prune **永不删** current 与 recommended、持锁跳过。`memu.js` 每次重读 `current.json`，**切换无需重启 DSH**。

### 9.4 MemU CLI 事实（2026-10-27）

- `memu-cli` 是 **PyPI 上的 Python 包，不是 npm 包**；锁定 `0.11.0b3`。
- 发布版 `memu --help` 只有 `retrieve, search, list-files, commit`；源码里的 `memorize prepare/commit` **尚未发布**，**不要依赖 `memorize`**——当可选能力（启动探测 `memu memorize --help`，成功才注册入口，失败隐藏不报错）。
- 必需命令 `retrieve` / `list-files` / `commit`；必需 flag `--json` / `--db` / `--provider` / `--embed-model` / `--api-key` / `--base-url`。**所有 CLI 字符串只在 `lib/memu.js`**。

```bash
python -m memu retrieve "query" --json --db <db>
python -m memu list-files --json --db <db>
python -m memu commit payload.json --json --db <db>
```

`commit` payload：`{ recall_files: [{ name, track: memory, description, content }], resource: [], user: {} }`。

### 9.5 本地向量模型与运行时（受管，2026-10-30 / 2026-11-02）

**不再需要手工环境变量**：运行时（`onnxruntime-node` 1.31.1 + `onnxruntime-common` + `@huggingface/tokenizers`）由插件按 catalog pin 装进 `<dataDir>/downloads/embeddings/runtime/`，规格见 §14.13。`DSH_MEMU_EMBED_RUNTIME_DIR` 只剩「显式覆盖」用途：指向的目录里没有那三个包时会被忽略（`warn`）并回落到受管目录；也不需要 Ollama。

```bash
node scripts/local-runtime-install.mjs                      # 只读：打印 pin 的制品、状态、已装 checks
node scripts/local-runtime-install.mjs --download           # 显式联网装（≈ 设置页「安装运行时」）
node scripts/local-runtime-install.mjs --download --cache <dir>   # 用离线 tarball 装，仍按 pin 校验 bytes/sha256
node scripts/local-runtime-install.mjs --target <dir> --platform win32-x64 --id <modelId> --shallow
```

状态 `installed / absent / unsupported / downloading / paused / stopped / verifying / installing / failed / cancelled`；`unsupported` = catalog 没 pin 该平台原生库（如 `darwin-x64`）。装失败只 `warn` + 回词法召回，不会自动改用云端 embedding。

**下载源与续传（设置页）**：运行时三个 tarball 默认从 `npmjs` 取，也可选 `npmmirror（国内镜像）`；每个源都必须返回与 catalog pin 一致的 `bytes`/`sha256`，换源不会换运行时树。下载进度显示百分比、已下载/总量（MB）与实时速度（MB/s）。`暂停`/`停止`只中断传输、不发布 active；已下载字节保存在 `<runtimeRoot>/.cache/<artifact>-<sha256>.tgz.part`，继续/换源/重启后用 HTTP `Range` 从该偏移续传。旧版本留在 `.staging/install-*/.artifacts/*.tgz` 的部分下载会在下一次安装时被接管；校验失败才删除坏 part。

#### 9.5.1 五条已核实模型（2026-11-02）

每条都 pin 在来源仓库的 HEAD commit，逐文件 `bytes/sha256` 与文件清单双向核对一致，再用受管 ORT 树真跑推理（单位范数、重复编码余弦 1.0）。BGE / MiniLM / e5 走 ModelScope 直连（2026-10-30 的核实口径）；两张 Qwen3 卡片的导出仓库在 ModelScope 上不存在（只读核对 `record not found`），所以走 hf-mirror，`huggingface.co` 源站作为可选项。

| catalog id | 制品 | 维度 / 窗口 | pooling | 前缀 | 加载 | 一次编码 29 / 380 / 1520 字 | 实测（42 条 recall-bench 草稿，33 条可答） |
|---|---:|---|---|---|---:|---|---|
| `bge-small-zh-v1.5-int8` | 24.6 MB | 512 / 512 | cls + L2 | 无 | 254 ms | 5 / 17 / 22 ms | R@1 0.6667 · R@3 0.9697 · MRR 0.8106 |
| `all-minilm-l6-v2-int8` | 23.9 MB | 384 / 512 | mean + L2 | 无 | 122 ms | 5 / 17 / 30 ms | R@1 0.5455 · R@3 1.0000 · MRR 0.7525 |
| `multilingual-e5-small` | 135.4 MB | 384 / 512 | mean + L2 | `query: ` / `passage: ` | 787 ms | 6 / 19 / 47 ms | R@1 0.6667 · R@3 1.0000 · MRR 0.8182 |
| `qwen3-embedding-0.6b-int8` | 600.2 MB | 1024 / 4096 | last + L2 | 官方 `Instruct: …\nQuery:` / 无 | 2.06 s | 91 / 437 / 4286 ms | 带前缀 R@1 0.6970 · R@3 0.9697 · MRR 0.8359；裸文本 0.6667 · 0.9394 · 0.8081 |
| `qwen3-embedding-0.6b-q4f16` | 541.8 MB | 1024 / 4096 | last + L2 | 同上 | 11.4 s | 110 / 870 / 5863 ms | 带前缀 R@1 0.7273 · R@3 0.9697 · MRR 0.8510；裸文本 0.6667 · 0.9394 · 0.8081 |

延迟那一列是**同一批文本、同一个受管 ORT 树**上重测的（29 / 380 / 1520 字三段中文），所以五行之间可以直接比：Qwen3 int8 一次编码是另外三款的 18–195 倍，q4f16 还要再慢一截、加载慢 5.5 倍。

**这些数字是同一份合成草稿上的横向对照，不是质量结论**（草稿带刻意保留的词面线索，`docs/recall-benchmark.md` 自己声明它不是金标；33 条可答样本上 0.03 的差就是 1 条）。表里读得出的只有相对关系：e5 与 BGE 同级、MiniLM 在中文上明显弱；Qwen3 两个变体在草稿上略高，但一次编码慢 18–195 倍。英文 paraphrase 余弦 MiniLM 0.62/0.70、BGE 0.65/0.64、e5 0.91/0.93。q4f16 在这份草稿上没有比 int8 差（0.7273 对 0.6970）——差一个样本，不足以给两个变体排质量，能当依据的只有实测到的「加载慢 5.5 倍 + 依赖 com.microsoft 贡献算子」。

**角色通道**（e5 与两张 Qwen3 卡片都需要；为什么必须存在、为什么不是猜）：MemU 的 embeddings 信封只有 `{model, input, encoding_format}`，没有 role 字段。非对称前缀意味着同一句话有两种读法，所以角色由**启动子进程的一方**写在 model 字符串上——`retrieve` 用 `<id>@<rev>+<proto>:query`，`commit` / `list-files` 用 `:passage`；worker 解析后缀并按 profile 的 `prefixes` 施加前缀，**裸 model id 对这种 profile 直接 400 `LOCAL_VECTOR_ROLE_REQUIRED`**，绝不"默认成文档"。两边同前缀的模型（BGE/MiniLM）保持原样，裸 id 照旧可用。派生规则是 `prefixesRequireRole(entry)` = `prefixes.query !== prefixes.document`，前缀本身在指纹里，所以「要不要角色通道」和「这个向量空间长什么样」永远来自同一份事实（§14.8）。前缀不是装饰：实测同一句话加/不加前缀的余弦，e5 是 0.9811，Qwen3 int8 只有 **0.8284**（q4f16 0.8203）——Qwen3 的 Instruct 前缀真的把向量挪开了，草稿上的读数也对应得上（带前缀比裸前缀 R@1 高 0.03、MRR 高 0.028）。真机验证：五路互切 `MiniLM(g1) → Qwen3-int8(g2) → Qwen3-q4f16(g3) → e5(g4) → BGE(g5)` 各 6/6 条重建、0 失败，每次切换后中英查询都能召回，回滚回到上一空间。

**下载来源（provider）**：不传就取目录顺序里第一个已固定的来源，所以 Qwen3 卡片的默认是 **hf-mirror**；`huggingface.co` 源站是同 commit 的同一批文件，可选。选源只走那一个、失败也不回退到别的源（`download(id, { provider })` → RPC `downloadLocalVectorModel` 的 `provider` → 设置页在「有多于一个已固定来源」的卡片上给一行 `is-row` 选择，只有一个来源就不出现「选」这件事）。换源不改向量空间：provider 不进指纹，每个文件落盘前都要过目录里 pin 的同一个 `sha256`。两个真实踩到的坑记在这里：① hf-mirror 对小文件用 chunked 传输、**不发 `content-length`**，头缺失必须当「未知」而不是 0，否则每个小文件都被误判成大小不符（第一次真装 Qwen3 就是被这条挡住的）；② 见证制品（基座仓库的 `1_Pooling/config.json`）默认绑死它被核实的那个 provider，多镜像来源要用 `origin.providers` 显式声明，否则换源会把整条封掉。

**两张 Qwen3 卡片是两个向量空间**：int8 是 `quantize_dynamic`（QInt8），图侧核实 196/196 个 `MatMulInteger` 的 scale/zero_point 都是 rank-0 标量、per-channel scale 向量为 0 → **per-tensor**，和另外三款 per-channel 不是同一个空间；q4f16 是 `com.microsoft.MatMulNBits`（int4、block_size=128）+ float16 激活，图输出 dtype 也是 float16。`quantization` 进指纹，所以分条目、分 DB，不能混用。两者都是 opset 21 的因果 LM：只有 `input_ids` + `attention_mask`（没有 `token_type_ids`），池化取**最后一个非 pad token**（`pooling=last`，官方 `1_Pooling` 声明 `pooling_mode_lasttoken=true`），且图**导出时固定 batch=1**——一次只能喂一行，worker 的 adapter 本来就逐行编码。分窗取 4096 而不是制品支持的 32768：1520 字实测已 4.29 s，按 32k 跑一条长记忆会直接顶到 worker 的 120 s 请求超时；窗口是指纹字段，所以这是写明的策略而不是疏漏。

```bash
node scripts/local-vector-verify.mjs                                        # 只读：五条目录条目的 manifest/来源/已装 deep 校验
node scripts/local-vector-verify.mjs --download --id all-minilm-l6-v2-int8   # 显式联网装该模型（默认落 .tmp-* 临时根）
node scripts/local-vector-verify.mjs --download --id qwen3-embedding-0.6b-int8 --target <dataDir>/downloads/embeddings
```

`--target` 指到插件数据目录就等于设置页的「下载并校验」；该脚本从不写 active profile，切换仍然只能走设置页的「切换并重建」。

### 9.6 注入实测台（工单 B，仅评测用）

**目的**：注入「发了什么」不等于「模型收到了什么」。这三件脚本只量最后一环——真正发给模型的请求里出现了哪些记忆块、出现几次。它们**不是运行时依赖**，`lib/` 永不 import，日志只记长度/哈希与标记计数（不记正文）。

| 工具 | 量的是 | 覆盖不到 |
|---|---|---|
| `scripts/simulate-injection.mjs` | 插件自己决定了什么：真实 `lib/inject.js` + 真实 `registerInjection('agent/pre-step')`，打在临时库与临时 `DSH_MEMU_HOME` 上 | 宿主的消息组装、真实模型的 tool 轮 |
| `scripts/mock-llm.mjs` | 收到请求时数标记 + `--report` 出「每轮 × 块矩阵」 | 它只是端点，不产生轮次 |
| `scripts/drive-session.mjs` | 真机上把轮次灌进绑定会话 | 需要宿主用假模型（见下） |

```bash
npm run simulate:injection                              # 50 轮离线基线，临时目录，cue 概率置 0 便于复现
node scripts/simulate-injection.mjs --turns 20 --out ./sim-run --json
node scripts/mock-llm.mjs --port 8123 --log ./mock-llm-<日期>.jsonl      # 伪 OpenAI 端点，只监听 127.0.0.1，无鉴权
node scripts/mock-llm.mjs --reply-file ./tests/fixtures/mock-llm/reply.txt --port 8123 --log ./mock.jsonl
node scripts/mock-llm.mjs --report ./mock-llm-<日期>.jsonl > mock-llm-report-<日期>.md
node scripts/drive-session.mjs --session <id> --turns 50 --dry-run       # 只打印将要发的请求，不发
node scripts/drive-session.mjs --session <id> --turns 50 \
  --base http://127.0.0.1:<gateway 端口> --allow-api-route --requests-out ./requests.jsonl
```

- **离线模拟器**（1.2.4）在临时 `DSH_MEMU_HOME` 里播种一份"每种块各有一条"的库（明天/今天/已过期的带日期未了之事、年度纪念日、时效词、四个月前的旧条目、近似重复主题对），跑 N 轮，把每次组装好的请求打给本地伪端点，产出 `report.md` / `mock-llm.jsonl` / `settings-snapshot.json` 与一行 JSON 摘要。退出码 `0` / `2` 用法错 / `3` **注入链路自己报了 warn**（模拟器把 warn 当失败，不当噪声）。它**不是真机证据**：宿主侧的折叠、真实模型的 tool 轮都不在里面；两边对不上时以真机为准。
- 真机用法：DSH 的 provider profile 把 `baseURL` 指到 `http://127.0.0.1:8123/v1`（provider 配置在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的 `llm-pi-ai`，`- id/config` 是**整份替换不是合并**，改完要重启该 profile 的宿主），测试会话绑定一个手写播种库，再用 `drive-session.mjs` 灌轮数。
- 标记表 pin 在 `scripts/mock-llm.mjs` 的 `MARKERS`（`MARKER_SET_VERSION` 记插件版本）。**改 `lib/inject.js` 的块标记必须同处更新并 bump 版本**，否则报告把新块记成 0。回归见 `tests/simulate-injection.test.mjs`：它钉的是量具属性（guide 只在首轮一次、标题卡 `body lines` 必须为 0、日志里不许出现正文），不是某次的注入计数。
- `drive-session.mjs` 走宿主公开的 `sessionController.prompt`（`POST <base>/api/session/prompt` 的 Connection carrier 形状），并且**默认拒绝发送**：没有 `--allow-api-route` 就打印等价的手工请求并退出码 3。轮结束只认持久 session log 里本轮 `turn/end` 的 `reason.kind === 'completed'`。
- 退出码：`0` 全部完成 / `1` 某轮或传输失败 / `2` 用法错 / `3` 未授权传输（手工降级）/ `4` 观察不到 session log。
- **真机 50 轮已跑过（2026-11-01，隔离实例）**：`DSH_HOME` 指到 launcher 的独立 home（`…/in.dsh-plug.dsh-launcher/homes/<version>`），profile 只加一个 `dsh-memu-memory` junction，provider 用 `mock-llm` 起在 8090，`dsh --profile <p> --no-open --port 0` 打印带 token 的 URL → `GET /` 303 换 cookie → `drive-session --cookie-file` 灌 50 轮。读数（51 个请求、2 个会话指纹）：`guide / anchor / due / anniversary / openLoop / texture` 各 **1** 次（都只在首轮），`ctx` Δ **27** 跨 **26/50** 轮（注入率 52%），`freshness` Δ **18** 跨 17 轮，`media / lexicon / cue / replay` 为 0（无附件、词典空、cue 概率 0、无压缩）；标题卡 `bodyLines` 全 0；12 条播种条目全部浮现过（`uniqueIds` max 12）。
- **离线对照**（同一份 `registerInjection` 代码，`scripts/simulate-injection.mjs`，50 轮）：注入 18/50 轮、`ctx` Δ18、`freshness` Δ11、其余块各 1、`bodyLines` 全 0。两边方向一致（首轮一次、逐回合召回、时效提示按需），绝对值不同——真机的转录更长、每轮都会重投新的召回，所以离线数只能读作"插件的决策"，不能当装机读数。
- 这条链上有两个坑，踩过一次写在这里：① `- id/config` 是**整份替换**，profile 里声明 provider 就得把 `providers` 写全；非推理模型的 `reasoningEfforts` 必须是 `false`，写成 `{off: null}` 会被判 `INVALID_CONFIG`（**回合在发出请求前就中止，所以零花费、零外发**，但看着像"没反应"）。② 宿主源码树 `packages/boot/app-boot/lib/` 是过期构建（`src` 支持 patch 路径列表，`lib` 不支持）→ 从源码起会崩；用已安装版本目录里的 `@deepseek-ai/dsh/lib/bin.js`。
- 这条链还顺手抓出一个行为缺口并修了（1.2.4）：**从未到达模型的失败回合会消耗掉首轮的一次性内容**（guide / 锚点 / 当日纪念日 / 复提时钟）。插件现在把该轮消费的东西记在 `injectionRollback` 上，并按"本轮注入消息有没有进转录"决定撤不撤：配置无效（`INVALID_CONFIG`）时撤回、下一轮重新投，上游 500 时消息还在转录里就保住记账不重投。机制与边界 → `docs/troubleshooting.md` §3.24。
- 数据是**要丢弃的**：报告文件名带日期，别把捕获的对话提交进仓库，也别把伪端点当日常后端。

---
