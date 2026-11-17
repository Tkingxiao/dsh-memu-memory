// 服务端注入与 RPC 集成；弹窗生命周期由 new-session-gate.test.mjs 独立验证。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-issue2-chain-'))
process.env.DSH_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const inject = await import('../lib/inject.js')
const rpc = await import('../lib/rpc.js')
const activity = await import('../lib/activity-log.js')
const { domainOf } = await import('../lib/memory.js')
const { loadPromptForDomain } = await import('../lib/prompts.js')

test.after(() => {
  try { state.flushState() } catch { }
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { }
})

// 「03_管理」：报告人的工作区名，不含任何 RP 关键词——detectDomain 判定为 coding。
const ws = path.join(home, '03_管理')
const RP_WS = path.join(home, '角色扮演-花园')

// 走生产的 pre-step 钩子路径（injectForStep + ensureUnifiedGuide），不是直接调
// 内部函数：guide 的投放与领域选择发生在钩子层，跳过它就不是「实际链路」。
const entries = []
{
  const ctx = {
    logger: { warn() { } },
    inject() { },
    on(event, fn) { entries.push({ event, fn }); return () => { } },
  }
  inject.registerInjection(ctx)
}
const preStep = entries.find((entry) => entry.event === 'agent/pre-step')
assert.ok(preStep, 'registerInjection must register the agent/pre-step listener')

const userText = (sessionId, text) => ({
  id: sessionId + '-user-1',
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text }],
})
const sessionEvent = entries.find((entry) => entry.event === 'session/event')
assert.ok(sessionEvent, 'registerInjection must register the session/event listener')
const sessions = new Map()
async function firstTurn(sessionId, cwd, text = '帮我整理一下这个月的待办') {
  const session = { header: { id: sessionId, cwd, agentPreset: null, origin: 'user' }, messages: [] }
  sessions.set(sessionId, session)
  const out = await preStep.fn({
    agent: { session },
    turn: 1,
    step: 1,
    signal: { aborted: false },
  }, async () => ({ kind: 'enter', messages: [userText(sessionId, text)] }))
  assert.ok(!state.getSessionBinding(sessionId)?.guideRulesKey, 'a proposed guide is not yet admitted')
  for (const message of out.messages) {
    assert.ok(message.id && message.role === 'user', 'Native DSL requires an identified UserMessage')
    if (!session.messages.some(item => item.id === message.id)) session.messages.push(message)
    await sessionEvent.fn(session, { type: 'user/message', data: message })
  }
  return out
}
// 领域以真实入史的 guide 正文及 binding 的接纳记录交叉验证，不把 proposed 日志当成功。
function guideDomainOf(sessionId) {
  const binding = state.getSessionBinding(sessionId)
  const guide = sessions.get(sessionId)?.messages.find(message =>
    message.source?.kind === 'plugin:dsh-memu-memory' && message.content?.[0]?.text?.startsWith('<memory-guide'))
  assert.ok(guide, 'the guide must exist in host history')
  assert.ok(binding.acceptedMemoryMessages?.some(record => record.messageId === guide.id && record.admittedAt),
    'the actual guide must have an admitted binding record')
  const text = guide.content[0].text
  assert.equal(/^<memory-guide rules="([^"]+)"/.exec(text)?.[1], binding.guideRulesKey)
  const domain = domainOf(binding)
  const settings = state.getSettings()
  const rendered = loadPromptForDomain('system-guide', {
    mustRememberCap: settings.mustRememberCap,
    unpinBudget: settings.unpinBudgetPerSession ?? 2,
    shortTermTtlHours: settings.shortTermTtlHours ?? 72,
    anchorTokens: settings.anchorTokens,
    turnTokens: settings.turnTokens,
  }, domain).text.trim()
  assert.ok(text.includes(rendered), 'the admitted guide content must match the binding domain')
  return domain
}

test('新建会话：空白、无绑定，弹窗有权询问', async () => {
  const st = await rpc.dispatch({}, 'getSessionPromptState', { sessionId: 'issue2-s1', cwd: ws })
  assert.equal(st.binding, null, 'a fresh blank session must arrive unbound')
  assert.equal(st.shouldPrompt, true)
  assert.equal(st.settings.newSessionPromptDismissed, false)
})

test('重复只读检查不会创建会话绑定', async () => {
  const st = await rpc.dispatch({}, 'getSessionPromptState', { sessionId: 'issue2-s1', cwd: ws })
  assert.equal(st.binding, null, '稍后 must not write anything server-side')
})

test('首条消息：注入路径隐式建绑定，领域跟随 detectDomain 而不是硬编码 rp', async () => {
  const out = await firstTurn('issue2-s1', ws)
  assert.ok(Array.isArray(out.messages) && out.messages.length, 'the first turn injected nothing')
  assert.ok(out.messages.some((message) => (message.content || []).some((part) => part?.type === 'text' && String(part.text).startsWith('<memory-guide'))),
    'the rules message was not delivered on the first turn')
  const binding = state.getSessionBinding('issue2-s1')
  assert.ok(binding, 'the injection path did not bind the session')
  assert.equal(binding.domainOverride, 'coding',
    'an unasked conversation in 03_管理 must not start on the RP track (issue #2)')
  assert.equal(binding.domainSource, 'auto', 'nobody answered yet: the binding stays implicit')
  assert.equal(guideDomainOf('issue2-s1'), 'coding', 'the injected guide variant must match the binding domain')
})

test('隐式绑定可读取，显式领域确认写入 chosen 凭据', async () => {
  const st = await rpc.dispatch({}, 'getSessionPromptState', { sessionId: 'issue2-s1', cwd: ws })
  assert.equal(st.binding.domainSource, 'auto', 'the binding must still look implicit')
  await rpc.dispatch({}, 'initSession', { sessionId: 'issue2-s1', cwd: ws, createLibrary: true })
  await rpc.dispatch({}, 'setSessionScope', { sessionId: 'issue2-s1', useLibrary: true, useGlobal: true })
  await rpc.dispatch({}, 'setDomain', { sessionId: 'issue2-s1', domain: 'coding' })
  const answered = state.getSessionBinding('issue2-s1')
  assert.equal(answered.domainOverride, 'coding')
  assert.equal(answered.domainSource, 'chosen', 'an explicit answer must leave the chosen marker')

  const after = await rpc.dispatch({}, 'getSessionPromptState', { sessionId: 'issue2-s1', cwd: ws })
  assert.equal(after.binding.domainSource, 'chosen', 'the gate reads the chosen marker back')
})

test('RP 工作区名仍判为 rp：detectDomain 的判定口径没有松动', async () => {
  await firstTurn('issue2-rp', RP_WS)
  const binding = state.getSessionBinding('issue2-rp')
  assert.equal(binding.domainOverride, 'rp', 'an RP-named folder must keep the RP track')
  assert.equal(guideDomainOf('issue2-rp'), 'rp')
})

test('显式选择 general 也是真实选项，不会被 detectDomain 冲掉', async () => {
  await firstTurn('issue2-general', ws)
  await rpc.dispatch({}, 'setDomain', { sessionId: 'issue2-general', domain: 'general' })
  const binding = state.getSessionBinding('issue2-general')
  assert.equal(binding.domainOverride, 'general')
  assert.equal(binding.domainSource, 'chosen')
  // 重走 ensureSession（每一轮注入都会跑）：显式答案必须存活。
  const rebound = state.ensureSession('issue2-general', { cwd: ws, createLibrary: false })
  assert.equal(rebound.domainOverride, 'general')
  assert.equal(rebound.domainSource, 'chosen')
})

test('RPC 失败不再被当成已答，错误经 logClientEvent 落入活动日志', async () => {
  const result = await rpc.dispatch({}, 'logClientEvent', {
    sessionId: 'issue2-s1',
    kind: 'error',
    message: '新会话记忆询问检查失败，本轮跳过',
    detail: 'Error: rpc failed: getSessionPromptState',
  })
  assert.ok(result.entry?.id, 'logClientEvent returned no entry')
  const events = activity.listEvents({ sessionId: 'issue2-s1', limit: 10 })
  assert.ok(events.some((event) => event.kind === 'error' && event.message.includes('新会话记忆询问检查失败')),
    'the client-side failure is missing from the activity log')
  // 奇异输入也不抛错——日志失败不能雪上加霜。
  const odd = await rpc.dispatch({}, 'logClientEvent', {})
  assert.ok(odd.entry?.id)
})

test('bindingView 把 domainSource 带给客户端（WebUI 与侧栏的读取口径）', async () => {
  const st = await rpc.dispatch({}, 'getState', { sessionId: 'issue2-s1' })
  assert.equal(st.binding.domainSource, 'chosen')
})
