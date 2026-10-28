<p align="center">
  <img src="assets/icon-256.png" width="88" height="88" alt="dsh-memu-memory">
</p>

<h1 align="center">dsh-memu-memory</h1>

<p align="center">
  给 <b>DeepSeek Harness</b> 的本地优先记忆插件 —— 按文件夹共享、按对话绑定、由 agent 自己写、
  在后台整理，并且对「它不知道的事」保持诚实。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-memu-memory"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-memu-memory?color=4d6bfe"></a>
  <a href="https://www.npmjs.com/package/dsh-memu-memory"><img alt="npm monthly downloads" src="https://img.shields.io/npm/dm/dsh-memu-memory?color=4d6bfe"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/npm/l/dsh-memu-memory?color=4d6bfe"></a>
  <a href="package.json"><img alt="DSH: >=0.2.0-rc.1" src="https://img.shields.io/badge/DSH-%E2%89%A50.2.0--rc.1-4d6bfe"></a>
  <a href="package.json"><img alt="Node: >=20.9" src="https://img.shields.io/badge/Node-%E2%89%A520.9-4d6bfe"></a>
</p>

<p align="center">
  <a href="README.md">English</a> | 中文
</p>

---

`dsh-memu-memory` 面向长篇 RP 与陪伴对话，给 DSH 一份「像记忆」的记忆，而不是一本日志：三种留存层会淡；首轮有锚点，之后每个用户回合最多召回一次；来源不能被悄悄从「我推断」升级成「对方说过」；互相矛盾的记忆会挂起等待裁决，而不是两条都被当成真的；关系可以是一条带证据的边。说话人、角色、世界线与剧情分支构成硬边界，角色「知道什么」与实际发生过什么分开保存。

默认**本地优先**。`agent` 后端把完整正文放在 JSON 索引里、用词法检索——不需要 Python、embedding 服务或 API key。`api` 后端才把检索交给可选的、锁定版本的 MemU 引擎（向量）。MemU 是「想要就用」的后端，不是插件能否启动的前提。

> **状态：** 1.0.1。首个公开发布版本为 1.0.0。升级前请备份 `~/.dsh/dsh-memu-memory`；如果要存无法重建的数据，请先读[兼容性与边界](#兼容性与边界)。

## 界面

以下截图均为真实 WebUI 在隔离示例数据上的画面，不是任何人的真实记忆。

<table>
  <tr>
    <td align="center"><img src="assets/screenshots/webui-memory.jpg" width="470" alt="记忆墙"><br/><em>MemU WebUI · 跨库记忆墙</em></td>
    <td align="center"><img src="assets/screenshots/drawer.jpg" width="470" alt="原地详情"><br/><em>不离开记忆墙就能编辑、归档、恢复</em></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/screenshots/relations.jpg" width="470" alt="关系图与邻接列表"><br/><em>关系图与邻接列表在同一视图里</em></td>
    <td align="center"><img src="assets/screenshots/settings.jpg" width="470" alt="设置"><br/><em>注入、预算、留存与自动化</em></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/screenshots/stats.jpg" width="470" alt="统计"><br/><em>每日活跃、命中分布与归档候选</em></td>
    <td align="center"><img src="assets/screenshots/webui-dark.jpg" width="470" alt="深色主题"><br/><em>深色主题 · 同一套层次与动效</em></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><img src="assets/screenshots/mobile.jpg" width="360" alt="窄屏"><br/><em>窄屏 · 侧栏折成横向标签</em></td>
  </tr>
</table>

## 它记住什么

- **三层，一条时间线。** `short_term` 草稿默认 72 小时到期；`long_term` 是记忆主体；`must_remember` 需要理由与来源，按 365 天半衰并带 0.35 强度地板，可以**边缘化**，但不会为腾名额被自动删除。
- **召回是一个瞬间，不是一次倾倒。** 新会话或压缩后的第一个回合得到锚点块（pin / core / global 分段预算）；之后每个用户回合最多一次召回。去重与 token 预算由代码执行，不交给提示词自觉。
- **记忆会不均匀地淡。** 新近、访问次数、唤醒度、情绪同调、峰终、首因、习惯化、闪光灯记忆的准确度共同参与强度；一条生动但可能记错的记忆会显示「细节未必准」，而不是假装确定。
- **来源是事实，不是文风。** 每条记忆带 `source`（`user_said` / `inferred` / `imagined` / `told`）、`confidence`、`accuracy` 与说出口径。模糊的推断不能冒充原话。
- **矛盾先挂起。** 与已有记忆同题改写或说法相反的新条进入 `pending_review`：不注入、不召回，只出现在复核队列，等人或整理作业裁决。
- **秘密不进自动召回。** `session` 可见性、`secret`、群聊频道、角色、世界线、剧情分支与 `knownBy` 共同约束读写；`secret` 永远不会被自动注入。
- **人与故事是有结构的。** 群聊用稳定的 `speakerId` / `channelId`，不拿显示名当身份；RP 用 `characterId` / `worldId` / `branchId` 隔离知识。关系边有理由和置信度，实体改名不动记忆正文，关系当前状态（熟悉、信任、温度、边界、承诺）是带证据和历史快照。
- **图片是指针加描述，不是假装能看图。** 附件按 SHA-256 去重、有配额、分三级留存；没有描述时只记「收到一张图片」，绝不编造画面。
- **整理在后台。** 整理跑在种子 fork 子会话里，不会在你的待发区多出一轮；失败退避重试，不伪记成功。

## 一个 WebUI

侧边栏只留**一个**入口：**MemU WebUI**。记忆墙与全部设置在同一套导航内，支持深链，如 `#/settings/memories`、`#/settings/folders`、`#/settings/stats`。

**原地操作。** 点记忆卡片会从右侧滑出详情抽屉：完整正文，以及决定它行为的字段——标题、正文、标签、说出口径、置信度、未了之事——外加保存、归档、恢复，以及需要重编辑时的「在记忆浏览中打开」。已归档的记忆可以直接在抽屉里删除：第一次点击只是准备，第二次才真正删除。全局记忆在抽屉里只读，并给出跳转。筛选条件与滚动位置保持不动。带图片的卡片会把第一张可用附件作为封面，抽屉里展开完整图片组；`secret` 与 `never_say` 条目不会拿到像素 URL，只显示标签占位。

**关系图与邻接列表一起看。** 「关系」页签把关系画布与邻接列表并排显示（窄屏上下堆叠），焦点选择在上方，建边/实体/关系状态工具在下方；没有需要记得切换的模式。

图谱使用本地打包的 D3 力导向布局，后台数据刷新保留节点位置与视角。支持拖拽节点、空白处平移、滚轮/双指缩放、适应全图与关联高亮；标签自动避让，设置中可调整斥力、连线距离，以及关闭标签或动态布局。图谱布局只表达已记录的关联，不会推断或写入新的关系。

| 页面 | 用途 |
|---|---|
| MemU 记忆 | 跨库记忆墙、来源/状态/库名/预览、原地详情、关系统一视图 |
| 引擎与连接 | 可选 MemU 引擎的安装与切换、embedding 配置、备份恢复 |
| 记忆设置 | 注入模式、token 预算、topK、相关度下限、留存与自动化 |
| 文件夹 | 文件夹级私有/全局上限，展开对话修改各自选择 |
| 记忆库 | 新建、改名、归档、恢复、显式删除 |
| 记忆浏览 | 全文编辑、附件、复核池、有界图谱、JSON/ZIP 导入导出 |
| 全局记忆 | 分域全局记忆、证据、复核队列与独立 curator |
| 提示词 | 通用 / RP / Coding / Mixed 变体，覆盖与单项恢复 |
| 统计 | 每日活跃、命中分布、库健康度、最久没被想起的 5 条、7 天写读比 |

设置项即时保存（250ms 防抖），跨窗口约 2.5 秒同步；工具调用或另一个窗口的写入也会被心跳发现。WebUI 优先在新标签页打开，被拦截时退回应用内 overlay，不卸载宿主 SPA。支持浅色、深色、减少动效与窄屏。

### 领域提示词

常驻指南、写入策略和整理提示词按当前会话领域选择；本地工具整理和远程 JSON 整理共用领域正文，各自使用实际支持的输出协议。

| 领域 | 记忆重点 |
|---|---|
| Coding | 需求/验收、接口与调用链、不变量、根因与方案取舍、验证状态和接续点；工程笔记不写角色心理。必要代码保留最小片段与精确语义，不整页复制源码，也不因字数裁掉关键条件。 |
| RP | 有依据的瞬间、人物自己的反应、称呼与习惯、承诺、界限和关系修复；让回忆影响当下选择，不机械复述，不编造事实或自动升级亲密。 |
| Mixed | 模板要求按当前事项分开处理技术、人物与 OOC；不会自动更改会话领域。tags 只辅助检索，不代替 context 权限与知情边界。 |
| 通用 | 中性的事实、偏好、决定及理由、承诺与限制，不默认进入 RP。 |

新版默认提示词不会覆盖已有自定义文本；「默认已更新」提示会一直保留到保存该项或恢复默认。在「提示词」中逐项比较、合并或恢复，不必清空记忆库。领域路由和输出协议有自动回归测试，实际“人味”和长期记忆质量仍需真实对话评估，不能由模板测试保证。

## 安装

### 环境要求

| | |
|---|---|
| DSH | `>=0.2.0-rc.1`（web profile） |
| Node.js | `>=20.9` |
| 操作系统 | Windows / macOS / Linux（跟随 DSH web 宿主） |
| 可选引擎 | 仅在选择向量后端时需要 Python 3.11+。默认后端不需要 Python、embedding 服务或 API key。 |

### 方式一 — npm（推荐）

```sh
dsh plugin --profile web add dsh-memu-memory
dsh web
```

安装或更新后**重启宿主**。插件会出现在 **设置 → MemU**，右侧栏会出现 **MemU WebUI** 按钮。

> 如果你用的不是 `web` profile，把 `web` 换成你的 profile 名。较旧的 DSH CLI 也接受不带 profile 的 `dsh plugin add dsh-memu-memory`。

### 方式二 — npx（不全局安装）

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-memu-memory
npx @deepseek-ai/dsh web
```

### 方式三 — 本地源码（开发）

本仓库**没有构建步骤**，`lib/` 就是运行时代码。克隆后把 checkout link 进 DSH profile，并加入 bundle：

```sh
git clone <本仓库地址> dsh-memu-memory
cd dsh-memu-memory
npm ci --legacy-peer-deps
```

在 profile 的 `package.json` 中：

```json
{
  "dependencies": {
    "dsh-memu-memory": "link:/你的绝对路径/dsh-memu-memory"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-memu-memory"]
    }
  }
}
```

然后重启 DSH。符号链接的 checkout 重启即生效，没有 bundle 缓存。

### 可选 — 向量引擎（MemU）

默认 `agent` 后端不用这一步也能完整使用。可在 **设置 → MemU → 引擎与连接** 里安装，或在终端运行：

```sh
npx --package dsh-memu-memory dsh-memu-memory-setup
```

它会：

- 把锁定版本 `memu-cli==0.11.0b3` 装进 `~/.dsh/dsh-memu-memory/engine/<version>/venv`；
- 不装进系统 Python 或用户 site-packages，venv 里不留 `pip`；
- 按顺序尝试 PyPI 镜像（用户配置 → 清华 → 阿里 → pypi.org）；
- 没有可用 Python/pip 时，使用放在插件目录里的**锁定版本 uv**，不改系统 `PATH`；
- 下载约 150 MB，跑真实 smoke，并保留上一版本以便回滚。

选择 `api` 后端时，把向量服务指向一个 OpenAI 兼容的 **embedding** 端点（例如本机 Ollama：`http://localhost:11434`）。DSH 自身没有 embedding 能力，所以「本地向量」指的是你自己跑在本机的服务；本机服务不需要 key。云端 MemU 不在支持范围内。

## 第一次使用

1. 安装后重启 DSH。
2. 从右侧栏打开 **MemU WebUI**（或设置 → MemU）。
3. 新会话会问一次：这个对话要不要记忆——只用私有 / 只用全局 / 私有 + 全局 / 不用。「记住我的选择」之后不再问。
4. 如果想按文件夹设上限，去 **文件夹**：文件夹可以禁止私有或全局记忆，对话里的开关会受这个上限约束。
5. 正常对话。私有记忆由 agent 自己写；**MemU 记忆** 墙用来审阅、编辑、归档、连边和导出。

文件夹策略是**上限，不是初值**：关掉文件夹开关会立刻夹住其中所有对话，重新打开则恢复每个对话自己的选择。两个开关都关的文件夹不弹窗、不建库、不注入。

## 模型工具

| 工具 | 作用 |
|---|---|
| `memu_private_remember` | 写私有记忆，支持来源、留存层、说出口径、可见性、标签、未了之事与附件引用 |
| `memu_private_recall` | 自然语言或精确 id 召回；结果最多附两条关系指针 |
| `memu_private_list` | 列出当前作用域可用的记忆 |
| `memu_private_update` | 编辑，但不能绕过永久准入、复核或可见性规则 |
| `memu_private_archive` | 归档，不删除 |
| `memu_private_unpin` | 用第一人称理由、配额和冷却边缘化一条永久记忆 |
| `memu_private_link` | 用证据连接记忆/实体，或更新关系快照；不能删边 |
| `memu_global_recall` / `memu_global_list` | 按 domain 读取全局记忆 |
| `memu_status` | 存储健康、同步心跳、召回状态与图片回合状态 |

主 agent **没有**全局写入工具；全局记忆只由独立的 curator 生产。

## 隐私、权限与数据

**存在哪里。** 所有数据都在 `~/.dsh/dsh-memu-memory/`（或 `$DSH_MEMU_MEMORY_HOME`；没有新 `state.json` 时仍兼容旧的 `$DSH_MEMU_HOME` 与 `~/.dsh/dsh-memu`）：

```text
~/.dsh/dsh-memu-memory/
├─ state.json                 设置、文件夹策略、会话绑定
├─ index/<libraryId>.json     私有记忆正文（唯一真相源）
├─ index/global.json          全局记忆
├─ index/*.stats.json         按日计数（90 天滚动）
├─ index/*.media.json         附件元数据与引用计数
├─ index/*.entities.json      实体与关系快照
├─ attachments/<libId>/<sha256>.<ext>
├─ libraries/*.sqlite3        可选向量层（加速，不是真相）
├─ engine/<version>/venv      可选 MemU 引擎
├─ prompts/                   用户提示词覆盖
├─ backups/                   显式备份与切换前快照
└─ logs/                      仅安装日志
```

- **正文与图片在磁盘上不加密。** 目录位于你的 home 下。如果这不可接受，请不要把秘密写进记忆，并给磁盘开启系统级加密。
- **图片是用户主动选择的隐私数据。** 只采集宿主已准入的附件；`secret` 条目的附件不会通过只读路由返回；`never_say` 的 caption 不会回显。可选的视觉服务只在你明确启用并配置端点后，才把图片发往该端点，可能产生费用；不会自动使用宿主凭据。
- **网络。** 没有遥测。外部请求只发生在：(a) 可选引擎安装器从你配置的镜像下载 Python 包/uv；(b) 你配置的 embedding 端点；(c) 可选的远程总结模型；(d) 你启用的视觉端点。默认后端的记忆操作不发起外部请求。
- **Shell 与文件系统。** 可选引擎安装器在私有 venv 里使用 Python/pip（必要时用插件目录内的锁定 uv），不修改系统 Python、不装全局包、不改 `PATH`。记忆写入只发生在数据目录内；配置写入使用临时文件 + rename。
- **删除。** 归档只是移出检索；永久删除是另一个受保护的、只对已归档条目开放的动作。删除对话只解绑，不删除记忆库。删除记忆库需要确认，并会先备份。

## 长工具回合中的外部消息

第三方工具可以持续 waiting，让一个宿主 turn 保持打开。收到一批新的真实人类消息后，
本插件在下一次模型步骤前做一次有预算的增量召回，不另起模型调用，也不强制结束大回合。
同回合中的原生用户消息直接支持；普通日志、sleep 完成文本、失败工具结果和空轮询不触发。
这里不依赖或修改某个具体 waiting 插件。

推荐由接收插件在其自有 `ToolResult.meta.memoryInbound` 中提供这个完整对象：

```js
const batch = {
  type: 'dsh-memu-memory/inbound-batch',
  version: 1,
  producer: 'my-message-transport',
  batchId: 'delivery-42',
  messages: [{
    id: 'remote-message-18',
    role: 'user',
    context: { channelId: 'room-1', speakerId: 'person-7' },
    content: [{ type: 'text', text: '上次说的部署脚本在哪里？' }],
  }],
}
// 保留原始模型可见内容和原有元信息，不伪造一条 user/message。
return { content: originalContent, meta: { ...originalMeta, memoryInbound: batch } }
```

频道、角色、世界线和分支必须匹配会话已配置的记忆作用域；不知道的身份不要猜。
图片只能使用宿主已经准入的 `{ type: 'image', attachment: hostAdmittedRef }`，不传路径、URL 或像素字节。
若接收工具无法返回 meta，可把完整协议对象作为 JSON 文本返回，并在**外部消息工具白名单**里填写准确工具名。
不会从日志、代码围栏或未获准工具中抽取协议。

进程内也可导入 `dsh-memu-memory/integration` 的 `ingestInboundBatch`，
调用 `ingestInboundBatch({ sessionId, batch, ctx, session })`。
这只登记记忆工作：接收插件仍负责向模型交付原始新消息，不唤醒 agent、不新建用户回合、不替 agent 写事实记忆。

去重按 producer、频道、说话人和消息 id；换 batchId 重发不会重复处理同一消息。
去重窗口及全局 N 轮节奏按人类消息批次推进，不依赖一直不变的宿主 turn。
队列最多 32 条消息 / 8 张图 / 96 KB，单个外部文本块最多 4000 字符；超限明确拒绝，不静默丢旧消息，发送方应拆批。
召回失败保留队列并退避 30 秒，取消的步骤不消费；处理中又到达的新消息留给下一步。
运行中的 agent（包括 waiting 工具）和有待处理消息的会话不做睡眠整理；
静默窗口从真实消息活动或 agent 回到 idle 起算。
`memu_status` 的 `inbound` 显示待处理数量、逻辑计数与最近结果，`inbound_error` 显示降级原因。

## 兼容性与边界

- **宿主：** DSH `>=0.2.0-rc.1`，只使用公开扩展点（工具、注入、会话查询、子代理、slot、带前缀的 HTTP 路由），不修改宿主源码。
- **召回质量：** 默认后端是词法检索。语义召回取决于可选引擎和你选择的 embedding 模型；插件无法提升一个它不拥有的模型。没有跑过 LongMemEval、长期群聊/RP A/B 或「拟人度」评分——测试数量不是质量分数。
- **没有云同步、账号或跨设备同步。** 这是本地插件，没有服务端身份。
- **没有视觉时：** 图片记忆只是「指针 + 人写的描述」。插件不会声称看过像素。
- **v4 污染会话：** 历史 `format v4 message requires a producer-owned source kind` 行只能诊断，不能改写；插件不会编辑私有会话文件。
- **不在范围：** 云端 MemU 联调、旧条目的 source 回填、已写坏 v4 消息的自动修复。

## 开发与验证

```sh
npm ci --legacy-peer-deps
npm test                                  # 全量测试；真实引擎用例在未配置时按设计跳过
npm run check                             # 语法 + i18n 键对齐 + package.json
npm run build:graph                       # 修改图谱源码后重建随包分发的离线资源
node scripts/acceptance-local.mjs         # 50 条自动验收
node --import ./tests/loader-register.mjs scripts/preview.mjs --port 7789
```

预览会在隔离示例数据上启动真实 WebUI：`http://127.0.0.1:7789/dsh-memu-memory/ui#/settings/memories`。

预览运行后，可在另一终端执行 `npm run test:graph-browser -- http://127.0.0.1:7789/dsh-memu-memory/ui#/settings/memories`，验证 200 节点、桌面/窄屏、拖拽、刷新稳定性、主题与加载重试。首次使用需执行 `npx playwright install chromium`；Windows 也可设置 `GRAPH_BROWSER_CHANNEL=msedge` 使用已安装的 Edge。压力数据仅在测试浏览器内拦截，不写入记忆库。图谱运行时不依赖 CDN，D3 许可随资源保存在 `lib/webui/graph-LICENSE.txt`。

测试包含一条真实引擎集成用例，未设置 `DSH_MEMU_TEST_ENGINE_PYTHON` 时按设计跳过；50 条自动验收全部通过。可选引擎已在隔离目录安装并跑通锁定 wheel 的 smoke；embedding 测试使用本机确定性服务，只证明协议可用，不证明语义质量。

## 文档

[`AGENTS.md`](AGENTS.md) 是给改这个仓库的人的操作手册：排错、修改路径与宿主事实。

## 许可

[MIT](LICENSE) © dsh-memu-memory contributors。

可以自由使用、修改、分发和商用，只需保留版权声明与许可声明。软件按**现状**提供，不附带任何担保。

---

如果这个插件对你有用，欢迎带着宿主版本与最小复现来提 issue——记忆问题在同时有对话记录与存储状态时最好定位。
