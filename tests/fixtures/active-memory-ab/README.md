# tests/fixtures/active-memory-ab

主动记忆金标 A/B 的**候选集**。这里全部是**合成代理标注（synthetic proxy）**，不是人工金标。

## 状态

| 项 | 值 | 含义 |
|---|---|---|
| status | `synthetic-proxy-not-gold` | 数据集不是 gold set |
| draft / notGold | `true` | 草稿，未确认 |
| gold | `false` | 只有人工逐条确认后、并且 review 改成 `human-reviewed`，才可能进入金标 |
| review | `pending` | 全部 case 仍在待审 |

**人审候选与 gold gating 是两件事**：把一条 case 标成候选（存在这里、有人读过）不等于它已成为金标。`scripts/active-memory-ab.mjs` 的结构校验会**拒绝** `annotationSource: "human"` 但 `review` 不是 `human-reviewed` 的 case，也拒绝任何 `gold: true` 的合成代理 case。

## 目录

```text
manifest.json          数据集清单 + 每个 case 的 throughSeq 与快照 sha256（pin）
cases/*.json           一个 case = 一份固定快照 + 标签 + 期望
```

## 固定快照与 pin

- `snapshot.events` 是**手写事件**，`seq` 由 harness 按数组位置分配（不要手写 `seq`）。
- `snapshot.throughSeq` 指向快照的**最后一个事件**；它之后的事件属于“尚未到达”，**不进入** worker 输入，也**不进入**摘要。
- 快照摘要 = `sha256(canonicalJson({schemaVersion, fromSeq, throughSeq, events[fromSeq..throughSeq]}))`。manifest 里的 `snapshotSha256` 是 pin；改了 case 就必须重新钉，否则加载直接失败。
- 重新钉 pin 的方法（**不自动改写**，要人工看 diff）：

  ```bash
  node scripts/active-memory-ab.mjs --digests
  ```

- `snapshot.padding`/`{ "type": "padding", ... }` 占位符由 `ab-polling-padding-v1` 确定性展开成工具轮询事件（文本完全相同，因此去重后只算 1 个工作单元）。生成规则固定在脚本里，展开结果参与摘要，所以同样可复现。

## 标签

- `labels.expected[]`：`{ id: "mem-ab-…", class, sourceSeq, note }`。`class` 取 `decision | preference | root-cause | promise | fiction-fact`。`sourceSeq` 指向“若由人来标也应记”的那个事件。
- `labels.mainProactive[]`：主模型**自己**写过的条目 id（快照里能看到 `memu_remember`/`memu_update` 的成功 `tool/call`）。后台检查再遇到它只能算重复，不能算新增覆盖。
- `labels.userReminders[]`：用户主动提醒的 seq。
- `snapshot.globalEntries[]` + `snapshot.conflicts[]`：全局干扰维度的输入（合成数据，只用于量预算与泄漏）。
- `expect`：这个 case 的可断言期望（`tests/active-memory-ab.test.mjs` 会逐条核对）。

## 加一条 case

1. 新建 `cases/NN-<id>.json`，`id` 用 `^[a-z0-9][a-z0-9-]{2,80}$`，`annotationSource` 保持 `synthetic-proxy`、`review` 保持 `pending`、`gold` 保持 `false`。
2. 跑 `node scripts/active-memory-ab.mjs --digests`，把打印出来的 `throughSeq` 与 `sha256` 手工写进 `manifest.json` 的对应条目（`file` 写相对路径 `cases/NN-<id>.json`）。
3. 跑 `node --test tests/active-memory-ab.test.mjs`。

**不要**为了让测试变绿去改既有 case 的标签或期望；先问“是我的改动错了，还是标签本来就该这样”。

## 明确不做

- 不放真实会话正文、真实路径、密钥。
- 不把合成代理标注说成人工金标，不报“真实模型主功率提升”。
- 不在本目录引入任何需要联网或调用模型的资产。
