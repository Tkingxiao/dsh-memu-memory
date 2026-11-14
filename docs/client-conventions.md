# 客户端约定 — dsh-memu-memory

动 UI 时读这一份，全部是硬约束。

## 7. 客户端约定（硬约束）

### 7.1 两个壳、一份实现

设置页 = 左侧导航（158px + 品牌块 + 品牌色滑动指示条）+ 卡片式页面；侧边栏 `MemoryTab` = 顶部分段壳。**同一个 `SettingsPage` 也嵌进侧边栏**（`embedded` → `data-dshm-surface="sidebar"`），所以总设置只有一份实现，**不要另写一套侧边栏设置面板**。

结构契约：`.dshm-root > .dshm-shell > (.dshm-nav + .dshm-page)`；导航含 `.dshm-brand` / `.dshm-nav-ind`（`translateY(page * (38+4))`）/ `.dshm-nav-item`；页面含 `.dshm-head`（`.dshm-overline` + `.dshm-h1` + `.dshm-desc`）。`@container` 在 620px 以下把左导航塌成横向标签。

**`ctx` 是 Cordis 服务代理，不要读自定义属性。** 宿主里的 `ctx.standalone` 会抛 `cannot get property "standalone" without inject`，且是在 `useState` 初始化时抛，直接把整个设置页渲染成空白。独立页标识必须由 `mountStandalone` 作为 **prop** 传给 `SettingsPage`（`standalone: true`，默认 `false`）；`tests/webui.test.mjs` 静态拦复发。

### 7.2 颜色

只走**真实存在**的 DSH token：`bg-base`、`bg-layer-1..4`、`border-l1..l4`、`label-primary(-inverted)`、`label-secondary`、`label-error`、`brand-primary`、`brand-text`。写不存在的 token **不报错**，只会永远落到硬编码兜底色，换主题时特别难看。改色前先确认 token 名。

### 7.3 控件纪律

- **不新增内联 `S.*` 样式**（旧的在逐块删，不留双轨）；样式一律走 `dshm-` 作用域 CSS。
- 「这几项里选一个」= `.dshm-nav-list` + `.dshm-nav-item`（页内横排加 `is-row`）。**不写第二套分段/下划线样式**。
- 动作按钮 = `Button`（`.dshm-btn`，**必须透传 `title`**，漏掉整个界面的悬浮提示静默失效）；开关 = `Toggle`；行内删除/关闭 = `.dshm-x`。
- `<button>` 里**不许**再嵌 `role="button"`（键盘够不到）。
- 破坏性操作 = **二次点击**（文案变「确认…？」，2.5s 复原），不用 `globalThis.confirm`、不用 modal。
- **算法给的候选（实体合并、关联建议）只显示、永不自动执行**：列表来自只读 RPC，逐条二次点击确认才写；操作后用一行回执说清影响面（`S.muted` + `V.accent`，自清），数字取 RPC 返回值，**不估算**。参考节点图页的合并候选（`docs/memory-semantics.md` §8.14）。
- **失败只在 WebUI「全部日志」标红**：活动日志三档 = 失败（`ok===false` 或 `level==='error'`）/ 降级（`level==='warn'` 且没失败）/ 常规，判据集中在 `logRowState`；总日志页用作用域 CSS `.dshm-logrow.is-failed` / `.is-degraded`，并且**同时给文字 Tag**（`logStateFailed`/`logDegraded` + hover 说明）——颜色不能是唯一通道。**侧栏「整理记录」不放失败行**（它只显示正常流水；失败由上方跨会话的「整理提醒」负责，别在两处重复标红），所以侧栏既不过 `logRowClass` 也不上色。判据别写成只看 `level==='error'`：整理超时记的是 `warn + ok=false`，那样失败会长得和正常行一样（真出过）。
- 设置项 = 即时保存 + 250ms trailing debounce，一次重试 + `console.warn`，`pagehide` 时 flush。反馈用 toast（2.6s），不用常驻 error/notice 字符串。

### 7.4 数据与刷新

- **保存/设置类改动必须通知**：`notifyMemoryWrite(kind, libraryId)` 先跑同窗口监听（毫秒），再向 `BroadcastChannel("dsh-memu-memory")` 广播 `{ type: "memory-write", kind, libraryId, at }`，让另一份文档（WebUI 新标签 / overlay iframe / 另一个宿主窗口）立刻重取；本地已刷新的写（设置保存、复位、后端切换、文件夹策略）用 `broadcastMemoryWrite` 只通知别人，避免刷两遍。接收端只跑本地监听 / 重渲染，**不广播回去**、**不从消息取数据**——消息只叫醒心跳，事实永远从 RPC 取。
- **一切轮询走心跳**：面板同步一律 `useMemoryBeat`，不各写 `setInterval`。心跳载荷**只许** `{ revisionOnly: true }`，返回**只许** `{ revision, stamp }`。
- 侧边栏首屏只允许 **1 个 RPC**（`getSidebarState`）且不读记忆全文；其余分页懒加载，列表项预览就地截断。
- 筛选是**两个独立维度，各自独占**：池（在用 / 已归档）× 层（全部 / 永久 / 长期 / 短期 / 锚点）。**所有选项恒定列出，没有记忆显示 0**；归档不是叠加开关。两池同一次读取全拿到，切换/归档/恢复只改状态重绘。
- 反面语义设置项（如 `newSessionPromptDismissed`）在 WebUI 必须 `settingRow(..., { invert: true })`，否则开关显示与宿主页面相反。

### 7.5 文案与结构

- 文案同时进 `zh` / `en`；加 `t("key")` 后跑 `node scripts/check-i18n.mjs`。
- 列表会话一律 `sessionLabel(s)`，不铺 `session-…` 全长 id；侧边栏第一层只显示文件夹 **basename**（**不显示完整路径**）。
- 页序 = `pageDefs` = `pageBlocks` 三处一致。每页拆 `xxxBlock` + `renderXxxItem`，别在一个 `h(...)` 里堆几十层括号。
- `tests/client-render.test.mjs` 把 7 个页面和侧边栏各渲染一遍：渲染期抛错或文本出现 `[object Object]` 即失败。
- WebUI 打开路径只有一条 `openWebUiPage()`（先新标签，被拦截再用应用内 overlay）。**禁止同标签导航兜底**——会卸载宿主 SPA，「返回」变成整页刷新。

### 7.6 关系图谱工作台（`lib/webui/graph-view.js` + `GraphStudioPanel`）

- **物理不许读相机。** 力导向里的斥力、弹簧原长、硬分离阈值一律用**世界坐标 + 节点半径**；把缩放塞进物理（曾经的 `24 / clamp(viewScale, .06, 5)`）在最小缩放等于要求 400 世界像素间距，节点每帧互推、永不收敛，用户看到的就是「缩到最小后打架 / 闪现」。缩放只影响**绘制**与**命中半径**。`tests/graph-view.test.mjs` 钉死两件事：`setScale` 之类把相机交给物理的入口不许回来，`relayout()` 后位移必须逐窗衰减且不留重合。
- **改引擎必须重打包。** 浏览器加载的是 `lib/webui/graph-view.bundle.js`，不是源码；`npm run build:graph` 忘了跑，源码修复在真实页面上根本不存在，而单测照绿（它 import 的是源码）。`npm run check` 现在比对两者字节，漂移即红。
- **冷下来就要零帧。** 渲染循环只在 `layout.active`（alpha 高于地板）或交互期申请下一帧；呼吸微动也只在模拟活着时画。每帧无条件 `requestAnimationFrame` 会让 GPU 占用一路爬升且不回落。
- **命中判定带迟滞。** 最小缩放下相邻节点在屏幕上只差 1–2px，纯「最近距离」会在两者之间反复跳；`hit(p, prefer)` 必须优先保留上一个目标（`tests/graph-view.test.mjs` 用 1px 抖动断言）。
- **`is-graph-wide` 只属于独立外壳**（`standalone && page === PAGE.graph`）。那套样式为全屏画布把导航改成 158px 竖排，套到宿主设置页上就会把原本横排的导航整片掰竖。宿主那一页只给一个按钮，点了走 `openWebUiPage('graph')`。
- **缩到最小节点必然在屏幕上压在一起**：绘制半径有 2.5px 下限，而世界间距不变。这不是 bug，别去动物理补偿；要拉开簇就用「斥力 / 连线距离」滑杆，它们改的才是世界尺度。
- **缩略图只跟主画布重绘**：`createGraphView` 的 `onPaint` 计数不变就不 `drawImage`，否则缩略图按自己的节奏重画，和主画布对不上。
- **整理入口不新增 RPC**：「立即整理」= `listSessions`（带 `libraryId`）筛出该库绑定的会话，再逐个调用侧边栏同一个 `generatePrivate`，两段确认。UI 专用的写方法同时也是一条模型能调的写路径，能复用就别新开。

### 7.7 合成负载（GPU 占用）

WebUI 的 GPU 问题几乎从来不是算力，是**空闲期仍在持续产帧**：合成器每帧有活干，时钟就降不下来（外部实测：开面板 GPU 时钟 765→1950MHz、功耗 29→72W，util 却只有三四成；关面板立刻回落）。

- **装饰层不许有无限动画。** 全屏模糊光斑、品牌图标浮动、状态点脉冲这类 `animation: … infinite` 会让合成器永远不睡。要动效只给交互触发的一次性动画；boot 遮罩例外（ready 后 900ms 移除）。`will-change`  likewise 不许常驻在装饰层上。
- **模糊只给小 chrome。** `backdrop-filter` 只允许 topbar 与 boot 卡；rail、卡片、抽屉、全屏遮罩一律不用——背后只要有东西在动，这些面每帧重算模糊，成本相乘。遮罩用纯色 scrim 就够。
- **缩略图/副画布由主画布 `onPaint` 驱动**，不许自己 `setInterval` 轮询；主画布冷下来不重绘，副画布就一帧不画。
- **改完要量**：`node scripts/check-idle-compositing.mjs`（先起预览）用 CDP screencast 数帧 + `document.getAnimations()`，空闲 fps > 2 即 FAIL。静态守卫在 `tests/webui.test.mjs` 的 `the shell keeps no always-on compositor drivers`。
- **对照环境要先验**：若桌面本身被别的进程钉住时钟（不开浏览器也高频），真 GPU 前后对照在那台机器上无效；以帧计数为准，或到「关面板立刻回落」的宿主上复测。

---
