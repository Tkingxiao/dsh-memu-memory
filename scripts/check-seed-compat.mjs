// 种子兼容检查 — 验证本插件的整理 fork 种子能被目标宿主的 Session 校验接受。
//
//   node scripts/check-seed-compat.mjs --session-pkg <@deepseek-ai/dsh-session/lib/index.js 路径>
//
// 背景（1.2.7 实测）：DSH 0.2.2-rc.1 的种子校验（assertAssistantSettlementShape）
// 要求 assistant/message 的 data.stream 是数组，而插件曾直接 delete 该字段，导致
// 0.2.2-rc.1 上每个整理 fork 种子都被拒（"invalid settlement fields"）。修复后种子
// 携带空数组。本脚本把「compactSeedEvents 产物 → 宿主 Session.create」这一环固化成
// 可重复执行的真机检查：新宿主版本的适配检查表（docs/host-adaptation.md §5.4）应
// 先跑这一步，再跑完整整理作业。
//
// 退出码：0 = 种子被宿主接受；1 = 被拒或环境问题（错误里说明是哪一环）。

import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { registerHooks } from 'node:module'

// 插件 lib 的导入链里有宿主 peer（@deepseek-ai/*），脱离宿主运行时需要测试桩。
// 但桩必须**按导入方作用域**生效：被检查的宿主真包自己也 import @deepseek-ai/dsh-llm，
// 无条件映射会拦掉真包之间的依赖（实测报 does not provide an export named …）。
// 因此只有 parentURL 落在本仓库 lib/ 内的导入才映射到桩；宿主包相互导入走真解析。
const STUBS = {
  '@deepseek-ai/dsh-tools': 'dsh-tools.js',
  '@deepseek-ai/dsh-llm': 'dsh-llm.js',
  '@deepseek-ai/dsh-session': 'dsh-session.js',
  '@deepseek-ai/dsh-llm-pi-ai': 'dsh-llm-pi-ai.js',
}
registerHooks({
  resolve(specifier, context, next) {
    const parent = String(context.parentURL || '')
    const stub = STUBS[specifier]
    if (stub && parent.includes('/dsh-memu-memory/lib/')) {
      return { url: new URL('../tests/stubs/' + stub, import.meta.url).href, shortCircuit: true }
    }
    return next(specifier, context)
  },
})

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--session-pkg') out.sessionPkg = argv[++i]
  }
  return out
}

const args = parseArgs(process.argv)
if (!args.sessionPkg) {
  console.error('用法: node scripts/check-seed-compat.mjs --session-pkg <…/node_modules/@deepseek-ai/dsh-session/lib/index.js>')
  console.error('路径在启动器安装里通常是 versions/<版本>/node_modules/@deepseek-ai/dsh-session/lib/index.js（pnpm 树内用 find 定位）。')
  process.exit(1)
}
if (!fs.existsSync(args.sessionPkg)) {
  console.error('session 包不存在: ' + args.sessionPkg)
  process.exit(1)
}

// compactSeedEvents 会写 consolidation.json 之外还可能触达插件状态面：隔离到临时目录，
// 与 npm run replay 同一手法。检查本身是纯内存的，这只是防御。
process.env.DSH_MEMU_MEMORY_HOME = process.env.DSH_MEMU_HOME =
  fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-seed-compat-'))

const { Session, buildForkSeed } = await import(pathToFileURL(args.sessionPkg).href)
const { compactSeedEvents } = await import(new URL('../lib/private.js', import.meta.url).href)

// 真实形状的事件（字段取自 0.2.x 真机会话，正文已替换为探针文本）：宿主校验只看
// 形状（id / source / turn / step / stream），不看内容。assistant 必须带 message.id
//（缺了会报 "lacks an identified message"，那是事件形状问题，不是插件种子问题）。
const T = 1793700000000
const events = [
  {
    type: 'user/message', seq: 0, time: T,
    data: { content: [{ type: 'text', text: '探针：请记住这件事。' }], source: { kind: 'user' }, role: 'user', id: 'probe-user-1' },
    surfaceOp: 'append',
  },
  {
    type: 'assistant/message', seq: 1, time: T,
    data: {
      message: {
        id: 'probe-asst-1', role: 'assistant',
        // source 必须是完整的 model 来源形状（provider/model 缺一不可——宿主校验
        // "message must have model source"），replayState 会被 compactSeedEvents 摘除。
        content: [{ type: 'text', text: '探针回复，正文不重要。' }],
        source: { kind: 'model', provider: 'probe', model: 'probe-model' },
      },
      turn: 0, step: 0,
      usage: {},
      stream: [{ type: 'text', text: '探针回复，正文不重要。' }],
    },
    surfaceOp: 'append',
  },
]

let hostVersion = 'unknown'
try {
  const require_ = createRequire(pathToFileURL(args.sessionPkg).href)
  hostVersion = require_('@deepseek-ai/dsh-session/package.json')?.version || 'unknown'
} catch {}

const compacted = compactSeedEvents(events)
const streamShape = compacted.find(e => e.type === 'assistant/message')?.data?.stream
console.log(`宿主 dsh-session: ${hostVersion}`)
console.log(`compactSeedEvents 产出的 assistant data.stream: ${Array.isArray(streamShape) ? `数组（${streamShape.length} 项）` : JSON.stringify(streamShape)}`)

try {
  const seed = buildForkSeed(compacted, compacted.length - 1)
  const header = { version: 4, id: 'dsh-memu-seed-compat', createdAt: T, cwd: process.cwd(), isSeeded: true }
  Session.create('dsh-memu-seed-compat', seed, header, compacted.length)
  console.log('结果: PASS —— 整理 fork 种子被该宿主接受。')
  process.exit(0)
} catch (error) {
  console.error('结果: FAIL —— 种子被宿主拒绝:', error?.message || error)
  console.error('排查方向: 宿主种子校验（assertAssistantSettlementShape 一类）与 lib/private.js compactSeedEvents 的事件形状假设出现漂移。')
  process.exit(1)
}
