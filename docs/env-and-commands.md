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

### 9.5 本地向量运行时（受管，2026-10-30）

**不再需要手工环境变量**：运行时（`onnxruntime-node` 1.31.1 + `onnxruntime-common` + `@huggingface/tokenizers`）由插件按 catalog pin 装进 `<dataDir>/downloads/embeddings/runtime/`，规格见 §14.13。`DSH_MEMU_EMBED_RUNTIME_DIR` 只剩「显式覆盖」用途：指向的目录里没有那三个包时会被忽略（`warn`）并回落到受管目录；也不需要 Ollama。

```bash
node scripts/local-runtime-install.mjs                      # 只读：打印 pin 的制品、状态、已装 checks
node scripts/local-runtime-install.mjs --download           # 显式联网装（≈ 设置页「安装运行时」）
node scripts/local-runtime-install.mjs --download --cache <dir>   # 用离线 tarball 装，仍按 pin 校验 bytes/sha256
node scripts/local-runtime-install.mjs --target <dir> --platform win32-x64 --id <modelId> --shallow
```

状态 `installed / absent / unsupported / downloading / verifying / installing / failed / cancelled`；`unsupported` = catalog 没 pin 该平台原生库（如 `darwin-x64`）。装失败只 `warn` + 回词法召回，不会自动改用云端 embedding。

---
