#!/usr/bin/env node
/**
 * EVALUATION ONLY — 离线注入模拟器（工单 B 量具的一半，与 mock-llm 配套）。
 *
 * 它回答的问题：注入管线**在当前设置下**每回合真的往模型请求里新加了哪些块、加了几次。
 * 与真机跑（scripts/drive-session.mjs）的分工：这里用真实的 lib/inject.js、真实的
 * registerInjection('agent/pre-step') 与真实的 lib/state.js 索引，但宿主侧的消息组装、
 * 真实模型的 tool 轮**不在**覆盖范围内。产数是"插件自己决定了什么"，不是"真实装机上
 * 模型收到了什么"；两者对不上时以真机为准。
 *
 * 为什么不碰真实数据：记忆库写进一个临时 DSH_MEMU_HOME（或 --home 指定的空目录），模型请求
 * 打到只监听 127.0.0.1 的 mock-llm，日志仍只有长度/哈希/标记计数。
 *
 * 转录是累积的（和宿主一样把已发过的插件消息留在上下文里）。这不是偷懒的反面：
 * ensureUnifiedGuide 会检查 decision.messages 里有没有当前规则的 guide，历史里没有 guide
 * 就每轮重投一条，guide 计数会变成 50/50 而不是 1/50 —— 那种数只能证明驱动错了。
 *
 * Usage:
 *   node scripts/simulate-injection.mjs                        # 50 轮，cue 概率置 0 便于复现
 *   node scripts/simulate-injection.mjs --turns 20 --out ./sim-run
 *   node scripts/simulate-injection.mjs --cue 0.02 --home ./sim-home
 *
 * Options:
 *   --turns <n>   轮数，1..500。默认 50。
 *   --home <p>    当 DSH_MEMU_HOME 用的目录（不存在则创建）。默认临时目录。
 *   --out <p>     产物目录（report.md / mock-llm.jsonl / settings-snapshot.json）。默认临时目录。
 *   --port <n>    伪端点端口，0 = 系统分配。默认 0。
 *   --cue <p>     覆盖 settings.randomCueChance。默认 0（出货默认是 0.02，随机会让跑数不可复现）。
 *   --json        只打印一行 JSON 摘要。
 *
 * Exit codes: 0 ok / 2 usage error / 3 注入链路报了 warn（模拟器把 warn 当失败，不当噪声）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'

const REPO_URL = new URL('../', import.meta.url)

function parseArgs(argv) {
  const options = { turns: 50, home: null, out: null, port: 0, cue: 0, json: false }
  const take = (index) => {
    const value = argv[index]
    if (value === undefined || value.startsWith('--')) throw new Error('missing value')
    return value
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--turns': options.turns = Number(take(++i)); break
      case '--home': options.home = path.resolve(take(++i)); break
      case '--out': options.out = path.resolve(take(++i)); break
      case '--port': options.port = Number(take(++i)); break
      case '--cue': options.cue = Number(take(++i)); break
      case '--json': options.json = true; break
      case '-h':
      case '--help':
        console.log(`EVALUATION ONLY — offline injection simulator (pairs with scripts/mock-llm.mjs).

  node scripts/simulate-injection.mjs [--turns 50] [--home <dir>] [--out <dir>]
    [--port <n>] [--cue <chance>] [--json]

Drives the real lib/inject.js through registerInjection('agent/pre-step') against a seeded
library in a throwaway DSH_MEMU_HOME, and posts every assembled request to a loopback mock
LLM. Writes report.md, mock-llm.jsonl and settings-snapshot.json under --out, plus a JSON
summary on stdout. Not real-engine evidence: host-side assembly and real tool rounds are
out of scope.`)
        process.exit(0)
        break
      default: throw new Error('unknown option ' + arg)
    }
  }
  if (!Number.isInteger(options.turns) || options.turns < 1 || options.turns > 500) throw new Error('--turns must be 1..500')
  if (!Number.isFinite(options.cue) || options.cue < 0 || options.cue > 1) throw new Error('--cue must be 0..1')
  return options
}

let parsed
try {
  parsed = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error('simulate-injection: ' + error.message)
  process.exit(2)
}

const work = parsed.home || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-sim-'))
const outDir = parsed.out || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-sim-out-'))
fs.mkdirSync(work, { recursive: true })
fs.mkdirSync(outDir, { recursive: true })
process.env.DSH_MEMU_HOME = work
process.env.DSH_MEMU_MEMORY_HOME = work

// lib/inject.js imports the host's createUserMessage; reuse the test stubs so this runs
// straight from a checkout with no host present.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-llm') return { url: new URL('tests/stubs/dsh-llm.js', REPO_URL).href, shortCircuit: true }
    if (specifier === '@deepseek-ai/dsh-tools') return { url: new URL('tests/stubs/dsh-tools.js', REPO_URL).href, shortCircuit: true }
    if (specifier === '@deepseek-ai/dsh-session') return { url: new URL('tests/stubs/dsh-session.js', REPO_URL).href, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const state = await import(new URL('lib/state.js', REPO_URL))
const inject = await import(new URL('lib/inject.js', REPO_URL))
const mock = await import(new URL('scripts/mock-llm.mjs', REPO_URL))

const SESSION = 'sim-session'
const cwd = path.join(work, 'project')
const binding = state.ensureSession(SESSION, { cwd, agentPreset: 'rp' })
const libraryId = binding.libraryId
state.setSessionBinding(SESSION, { useLibrary: true, useGlobal: false })
state.updateSettings({ randomCueChance: parsed.cue })

const day = (offset, hour = 12) => {
  const value = new Date()
  value.setDate(value.getDate() + offset)
  value.setHours(hour, 0, 0, 0)
  return value
}
const ymd = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
const mmdd = (value) => `${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`

let seeded = 0
function seed(patch) {
  const id = `mem-sim-${String(++seeded).padStart(2, '0')}`
  state.updatePrivateIndex(libraryId, (index) => {
    index.entries[id] = {
      id,
      track: 'memory',
      layer: 'long_term',
      title: id,
      content: `${id} 的正文，涉及林眠、老周与城南那家咖啡店。`,
      status: 'active',
      disclosure: 'can_tell',
      visibility: 'shared',
      owner: 'me',
      createdAt: day(-40).toISOString(),
      updatedAt: day(-40).toISOString(),
      ...patch,
    }
  })
  return id
}

// 播种库是量具，不是任何人生活的样本：每种可注入的块都刻意放一条，报告里出现 0 才意味着
// "管线这次没选它"，而不是"库里没有可说的"。
function seedScenario() {
  seed({ title: '明天要还给林眠的相机镜头', salientDate: ymd(day(1)), openLoop: true, updatedAt: day(-2).toISOString(), createdAt: day(-2).toISOString() })
  seed({ title: '今天答应陪老周体检', salientDate: ymd(day(0)), openLoop: true, updatedAt: day(-1).toISOString(), createdAt: day(-1).toISOString() })
  seed({ title: '上周说过要回复的合同修改意见', salientDate: ymd(day(-6)), openLoop: true, updatedAt: day(-7).toISOString(), createdAt: day(-7).toISOString() })
  seed({ title: '答应给林眠带城南的咖啡豆，一直没做', openLoop: true, updatedAt: day(-5).toISOString(), createdAt: day(-5).toISOString() })
  seed({ title: '答应陪林眠去看海，日期未定', openLoop: true, updatedAt: day(-9).toISOString(), createdAt: day(-9).toISOString() })
  seed({ title: '一起看海的纪念日', salientDate: mmdd(day(0)), updatedAt: day(-200).toISOString(), createdAt: day(-200).toISOString() })
  seed({ title: '林眠说她的最新版本渲染器会崩', content: '林眠反馈最新版本渲染器崩溃，日志里是显存不足。', updatedAt: day(-3).toISOString(), createdAt: day(-3).toISOString() })
  seed({ title: '城南咖啡店最近的豆子价格', content: '城南咖啡店最近的豆子价格：半磅 88 元，现在是活动价。', updatedAt: day(-4).toISOString(), createdAt: day(-4).toISOString() })
  seed({ title: '老周现在的治疗方案的最新结论', content: '老周目前的治疗方案，医生给的最新结论是保守观察。', updatedAt: day(-8).toISOString(), createdAt: day(-8).toISOString() })
  seed({ title: '四个月前记下的相机型号对比', content: '四个月前对比过两台机器的宽容度与价格。', updatedAt: day(-120).toISOString(), createdAt: day(-120).toISOString() })
  seed({ title: '林眠讨厌在别人讲故事时看手机', updatedAt: day(-60).toISOString(), createdAt: day(-60).toISOString() })
  seed({ title: '老周的女儿今年高考', updatedAt: day(-30).toISOString(), createdAt: day(-30).toISOString() })
  // 近似重复的一对主题：该只回一次，不该连着推两次。
  seed({ title: '林眠的相机镜头跑焦问题', updatedAt: day(-15).toISOString(), createdAt: day(-15).toISOString() })
  seed({ title: '林眠镜头跑焦的维修报价', updatedAt: day(-16).toISOString(), createdAt: day(-16).toISOString() })
  for (let index = 15; index <= 26; index += 1) {
    seed({ title: `日常片段 ${index}：和老周下棋、给植物浇水、整理书架`, updatedAt: day(-index).toISOString(), createdAt: day(-index).toISOString() })
  }
}
seedScenario()

const PROMPTS = [
  '我们上次说到哪儿了？',
  '你还记得林眠的相机吗？',
  '明天有什么我要办的事？',
  '嗯',
  '城南那家店现在豆子多少钱？',
  '老周最近怎么样？',
  '帮我理一下今天要做的事。',
  '我是不是答应过你什么事没做？',
  '林眠说的渲染器最新版本靠谱吗？',
  '聊聊别的，比如我最近在读的书。',
  '体检那件事后来怎么处理的？',
  '你还记得我们约好看海吗？',
  '把上次那个合同的事再说一遍。',
  '今天有点累，随便聊聊吧。',
]

const SYSTEM_PROMPT = '你是这个角色扮演与陪伴对话里的助手。请按用户的请求自然回应，必要时使用记忆。'
const REPLY = mock.DEFAULT_REPLY

const warns = []
const handlers = new Map()
const ctx = {
  on: (topic, handler) => { handlers.set(topic, handler); return () => {} },
  get: () => undefined,
  logger: { warn: (message) => warns.push(String(message)), info: () => {}, error: (message) => warns.push(String(message)) },
  effect: (fn) => { try { fn() } catch {} },
  slots: { inject: () => {} },
  webServer: { register: () => {} },
}
const disposeInjection = inject.registerInjection(ctx)
const preStep = handlers.get('agent/pre-step')
if (typeof preStep !== 'function') throw new Error('agent/pre-step handler was not registered')

const logPath = path.join(outDir, 'mock-llm.jsonl')
const instance = await mock.startMockLlm({ port: parsed.port, log: logPath, reply: REPLY })

const agent = { session: { header: { id: SESSION, cwd, agentPreset: 'rp', origin: 'user' } } }
const textOf = (message) => (typeof message?.content === 'string'
  ? message.content
  : (message?.content || []).map((part) => part?.text || '').join(''))

const deltaTotals = Object.fromEntries(mock.MARKER_KEYS.map((key) => [key, 0]))
const roundsWithBlock = Object.fromEntries(mock.MARKER_KEYS.map((key) => [key, 0]))
let roundsWithInjection = 0
let titleCardBodyLineMax = 0
let sendFailures = 0

let history = []
for (let turn = 1; turn <= parsed.turns; turn += 1) {
  const known = new Set(history)
  history = [...history, {
    id: `u-${turn}`,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: PROMPTS[(turn - 1) % PROMPTS.length] }],
  }]
  const out = await preStep({ agent, turn, step: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: history }))
  const messages = Array.isArray(out?.messages) ? out.messages : history
  if (messages.length > history.length) roundsWithInjection += 1
  for (const message of messages.filter((item) => !known.has(item))) {
    const analysis = mock.analyzeMessage({ role: 'user', content: textOf(message) })
    for (const key of mock.MARKER_KEYS) {
      const count = Number(analysis.markers?.[key] || 0)
      if (!count) continue
      deltaTotals[key] += count
      roundsWithBlock[key] += 1
    }
    titleCardBodyLineMax = Math.max(titleCardBodyLineMax, Number(analysis.context?.bodyLines || 0))
  }
  history = messages
  const payload = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages.map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: textOf(message) })),
  ]
  const response = await fetch(`${instance.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: instance.model, stream: true, messages: payload }),
  })
  if (!response.ok) sendFailures += 1
  await response.text()
  history = [...history, { id: `a-${turn}`, role: 'assistant', content: [{ type: 'text', text: REPLY }] }]
}

instance.close()
try { disposeInjection() } catch {}

const settings = state.getSettings()
const finalBinding = state.getSessionBinding(SESSION)
const uniqueInjected = (finalBinding?.injectedIds || []).filter((id) => id !== inject.ANCHOR_SENTINEL).length
const snapshotPath = path.join(outDir, 'settings-snapshot.json')
fs.writeFileSync(snapshotPath, JSON.stringify({
  takenAt: new Date().toISOString(),
  note: '报告证明不了设置值，这份快照就是读数口径',
  run: { turns: parsed.turns, entries: seeded, session: SESSION, agentPreset: 'rp', driver: "registerInjection('agent/pre-step')" },
  settings: {
    autoInject: settings.autoInject, privateTopK: settings.privateTopK, globalTopK: settings.globalTopK,
    anchorTokens: settings.anchorTokens, turnTokens: settings.turnTokens, injectionTotalTokens: settings.injectionTotalTokens,
    dedupeTurns: settings.dedupeTurns, minUserChars: settings.minUserChars, randomCueChance: settings.randomCueChance,
    openLoopRemindDays: settings.openLoopRemindDays, freshnessHint: settings.freshnessHint, freshnessDays: settings.freshnessDays,
    salientWake: settings.salientWake,
  },
}, null, 2))

const reportPath = path.join(outDir, 'report.md')
fs.writeFileSync(reportPath, mock.renderReport(fs.readFileSync(logPath, 'utf8'), { logPath }))

const summary = {
  turns: parsed.turns,
  roundsWithInjection,
  injectionRate: Math.round((roundsWithInjection / parsed.turns) * 100) / 100,
  deltaTotals,
  roundsWithBlock,
  titleCardBodyLineMax,
  uniqueInjectedIds: uniqueInjected,
  sendFailures,
  warnCount: warns.length,
  firstWarns: warns.slice(0, 3),
  entries: seeded,
  home: work,
  out: outDir,
  reportPath,
  logPath,
  snapshotPath,
}
console.log(parsed.json ? JSON.stringify(summary) : JSON.stringify(summary, null, 2))

if (warns.length > 0) process.exitCode = 3
