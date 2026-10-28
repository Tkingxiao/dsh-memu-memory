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

---
