# AGENTS.md — dsh-memu-memory

给**改这个仓库的人和 agent** 的**索引**：只答「去哪份文件找」。细节全在 `docs/`，本文件刻意短。

仓库事实：纯 JS、ESM、**无构建步骤**；源码与测试**全 CRLF**；全量测试 + 验收 50 条（均由脚本核对）；版本见 `package.json`；MIT。

2026-10-28：包名 `dsh-memu-memory`（目录仍由用户手动改名）。旧 `/dsh-memu` 路由兼容正式前缀；旧数据目录在没有新 `state.json` 时原地使用，不自动搬迁。WebUI 的 MemU 记忆墙与九页设置是同一个 SettingsPage，仅一个入口。旧「整理失败也标记已睡」的口径作废，失败必须退避重试。能力与限制 → `README.md`。

> **本文件吃宿主预算。** `@deepseek-ai/dsh-agent-instructions` 的 `maxBytes` 是 65536 字节，只算 `AGENTS.md`/`CLAUDE.md`（项目各级目录 + `~/.dsh/AGENTS.md` + `.local` overlay）**渲染后的整条基线消息**；超了会**静默截断尾部**——只发一条通知、不报错，被切掉的部分模型永远看不到。`docs/` 不在预算里。所以：**本文件只做索引，细节写进 `docs/`**，`npm run check` 有 60000 字节闸门。

---

## 1. 硬规则（不放宽）

1. **不改 DSH 源码**，只用插件、公开 service、RPC、slot；只用公开扩展点。
2. **不让主 agent 写全局记忆**：全局只由 curator 写，主 agent 只读。
3. **动态记忆不进 system prompt**（静态 guide 可以）：走独立 plugin 消息，保护 KV cache 也让注入可折叠。
4. **不每步注入**：普通回合首步注入；长工具回合只在出现尚未处理的真实人类消息批次时追加一次。工具日志、心跳不算人类消息。
5. **不自动删除记忆**：永久记忆移出 = 边缘化；删库必须显式确认；删会话默认只解绑。
6. **Python 不装进系统解释器 / 用户 site-packages**，只装 `engine/<version>/venv`，且 venv 里不留 pip（`--without-pip` 建，再用基础 Python 的 `pip --python` 指进去装）。
7. **不自动追最新 MemU**：只装声明版本，升级走新 venv + smoke + 切换 + 保留旧版。
8. **不碰共享 `/api`**：RPC 只走 `/dsh-memu-memory` 前缀（`webServer.register` + `connection.requestRejection`）。
9. **日志与提示词里不放 API key。**
10. **注入失败 fail-open，但必须留可观测信号。** 吞掉异常是允许的，但**不许把真实故障一起吞**：fail-open 必配 `logger.warn` + binding 上的 `lastRecallError`（侧边栏可见），单测断言**召回到的 id**，不能只断言「消息插进去了」。**不能靠「没报错就是好了」。** 成因与守卫 → `docs/troubleshooting.md` §3.1。

---

## 2. 三条路

| 你要做的 | 去哪 |
|---|---|
| 现象不对、有报错 | `docs/troubleshooting.md`（先看症状速查表） |
| 改现有行为 / 加新东西 / 提交前自检 | `docs/contributing.md` |
| 忘了宿主 API 长什么样 | `docs/host-api.md`；三种 exec 形状在 `docs/troubleshooting.md` 附录 D |
| 动 UI | `docs/client-conventions.md` |
| 改记忆语义 / 提示词正文 | `docs/memory-semantics.md` |
| 搭环境 / 装引擎 / 跑命令 | `docs/env-and-commands.md` |

症状速查（细节在各小节）：
```text
只剩锚点 / 召回从不出现 → T3.1     会话打不开 → T3.2, T3.7
整库变空 → T3.3                    明明写了少一条 → T3.4
面板不刷新 → T3.5                  UI 错位 / 悬停提示没了 → T3.6
提示词改了不生效 → T3.7            引擎装不上 / 检索变差 → T3.8
待复核的记忆被用上 → T3.9          改了没反应 / 没有 memu_* → T3.10
待发区冒出整理提示 → T3.11         新对话读不到文件夹记忆 → T3.12
注入整段没了 → T3.13               日期语义错 / 看不见日期 → T3.14
保存成功但没变 / 字段改不回来 → T3.15   记忆凭空消失 / 侧边栏空 → T3.17
弹窗选了却两侧都勾上 → T3.16            聊很久一条记忆都没写 → T3.18
人格预设会话里完全没有记忆 → T3.19
```

---

## 3. 验证（四件，缺一条不许提交）

```bash
node --check lib/<改过的文件>.js     # 语法（源码是 ESM，别用 require 试）
npm test                             # 全量；真实引擎用例默认跳过
node scripts/acceptance-local.mjs    # 50/50
npm run check                        # node --check + i18n + package.json + 文档预算
```

**结果口径**：以 `node --test` 输出的 `ℹ tests / pass / fail / skipped` 为准。用例数变了先问「是不是我加的」，失败先问「是不是并发写了同一个库」——这仓库真会多个会话同时改它。提交前逐条对 `docs/contributing.md` §10。

---

## 4. 文档索引

| 文件 | 内容 |
|---|---|
| `docs/troubleshooting.md` | §3 全部症状/落点/守卫 + 症状速查表 + 守卫索引表 + 附录（模块地图 §2.1、调用链 §2.2、数据铁律 §2.3、三种 exec 形状 §6.3、硬规则全文 §1） |
| `docs/contributing.md` | §4 改动流程（四步 / 验证三件套 / 连带清单 / 文档同步）+ §5 六个扩展点 + §10 提交前清单 |
| `docs/host-api.md` | §6.1 / 6.2 / 6.4–6.7：embedding、workspaceRegistry、历史会话与标题、fork/followup、定时器、RPC+slot+折叠 |
| `docs/client-conventions.md` | §7：两个壳一份实现、颜色 token、控件纪律、数据与刷新、文案与结构 |
| `docs/memory-semantics.md` | §8：三层、写入规则、全局记忆、注入、提示词管理 |
| `docs/env-and-commands.md` | §9：Windows 跑命令的 env、CRLF 补丁法、本地 link、引擎安装与回滚、MemU CLI 事实 |

节号跨文件不变：看到「（§8.4）」就去 `docs/memory-semantics.md` 找 §8.4。

## 5. 三条容易记反的

- **注入是新增一条消息**（`source.kind = plugin:dsh-memu-memory`），不改用户消息。
- **折叠是宿主做的**，插件不做折叠。
- **召回为空必须留信号**（§1 规则 10）。

## 6. 改这份索引本身

加内容前先问「这条属不属于索引」：只有**必须每回合都知道、且不知道就会做错**的才留在这里。其余写进 `docs/` 对应文件，并在上面两张表里加指针。改完跑 `npm run check`（超 60000 字节会红）。
