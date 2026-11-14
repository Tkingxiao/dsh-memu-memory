import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-turn-log-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const state = await import('../lib/state.js')
const turnLog = await import('../lib/turn-log.js')
const rpc = await import('../lib/rpc.js')
const { registerTurnLogRecorder } = await import('../lib/index.js')

test.after(() => {
  state.flushState()
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

// —— 宿主事件 fixture（形状与 consolidation-snapshot/private 的口径一致） ——————

let clock = 0
function userMessage(seq, text, { sceneTime, kind = 'user' } = {}) {
  clock += 1000
  return { type: 'user/message', seq, time: clock, data: { id: `u${seq}`, source: { kind }, content: [{ type: 'text', text }], ...(sceneTime ? { sceneTime } : {}) } }
}
function assistantMessage(seq, text, blocks = []) {
  clock += 1000
  return { type: 'assistant/message', seq, time: clock, data: { message: { content: [{ type: 'text', text }, ...blocks] } } }
}
function toolCallEvent(seq, callId, name, args) {
  return { type: 'tool/call', seq, time: clock, data: { callId, name, arguments: args } }
}
function toolResultEvent(seq, callId, text, { isError = false } = {}) {
  return { type: 'tool/result', seq, time: clock, data: { message: { callId, content: [{ type: 'text', text }], isError } } }
}
function turnStart(seq, turn = 1) {
  return { type: 'turn/start', seq, time: clock, data: { turn } }
}
function turnEnd(seq, { kind = 'completed', turn = 1, time } = {}) {
  return { type: 'turn/end', seq, ...(time !== undefined ? { time } : { time: (clock += 1000) }), data: { turn, reason: { kind } } }
}

function oneTurn({ user, assistant, scene, kind = 'completed', startSeq = 10, tools = [] } = {}) {
  const events = [turnStart(startSeq)]
  let seq = startSeq + 1
  if (user !== undefined) events.push(userMessage(seq++, user, { sceneTime: scene }))
  for (const [callId, name, args, result, isError] of tools) {
    events.push(assistantMessage(seq++, '', [{ type: 'tool-call', id: callId, name, arguments: args }]))
    events.push(toolCallEvent(seq++, callId, name, args))
    if (result !== undefined) events.push(toolResultEvent(seq++, callId, result, { isError }))
  }
  if (assistant !== undefined) events.push(assistantMessage(seq++, assistant))
  events.push(turnEnd(seq, { kind }))
  return events
}

// —— 记录规则（§3.1） ———————————————————————————————————————

test('one closed turn is one record: seq interval, scene, and the filtering rules', () => {
  const events = [
    turnStart(10),
    userMessage(11, '帮我看看明天要不要带伞', { sceneTime: '第三日夜' }),
    userMessage(12, '（插件注入的提示）', { kind: 'plugin:dsh-memu-memory' }),
    toolCallEvent(13, 'c1', 'weather', '{"city":"杭州"}'),
    assistantMessage(14, '明天有雨，建议带伞。'),
    toolResultEvent(15, 'c1', 'rain'),
    userMessage(16, '谢谢', { sceneTime: '第四日晨' }),
    turnEnd(17),
  ]
  const records = turnLog.buildTurnRecords(events)
  assert.equal(records.length, 1)
  assert.deepEqual(records[0].seq, [10, 17])
  // scene 取回合内最后一个带 sceneTime 的 user 事件值；插件注入不进 user 文本。
  assert.equal(records[0].scene, '第四日晨')
  assert.equal(records[0].user, '帮我看看明天要不要带伞\n谢谢')
  assert.equal(records[0].model, '明天有雨，建议带伞。')
  assert.equal(records[0].interrupted, undefined)
  assert.ok(records[0].at, 'the turn/end timestamp lands on the record')
})

test('an open tail turn and a heartbeat-only turn produce no record', () => {
  const openTail = oneTurn({ user: '未闭合的回合' })
  openTail.pop() // 拿掉 turn/end：半回合不产出记录
  assert.deepEqual(turnLog.buildTurnRecords(openTail), [])

  // 心跳/调度回合：没有真人消息也没有工具 → 不落行。
  const heartbeat = [turnStart(50), userMessage(51, 'heartbeat', { kind: 'plugin:heartbeat' }), turnEnd(52)]
  assert.deepEqual(turnLog.buildTurnRecords(heartbeat), [])
})

test('an aborted turn is marked interrupted', () => {
  const records = turnLog.buildTurnRecords(oneTurn({ user: '说到一半被打断', kind: 'aborted' }))
  assert.equal(records.length, 1)
  assert.equal(records[0].interrupted, true)
  assert.equal(records[0].seq[0], 10)
})

test('redactSecrets is applied to user, model and tool text at record time', () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456'
  const events = [
    turnStart(10),
    userMessage(11, `我的 key 是 ${secret} 别外传`),
    toolCallEvent(12, 'c1', 'deploy', '{}'),
    toolResultEvent(13, 'c1', `failed with ${secret}`, { isError: true }),
    assistantMessage(14, `收到，key ${secret} 已记下`),
    turnEnd(15),
  ]
  const records = turnLog.buildTurnRecords(events, { tools: 'errors' })
  assert.equal(records.length, 1)
  const flat = JSON.stringify(records[0])
  assert.ok(!flat.includes(secret), 'the raw secret must never reach the log')
  assert.ok(flat.includes('[REDACTED_KEY]'))
})

// —— 工具行三档（§3.1） ——————————————————————————————————————

const TOOL_FIXTURE = [
  ['c1', 'edit_memory', '{"id":"m1"}', '修改成功', false],
  ['c2', 'readSession', '{"path":"a.ts"}', 'not found', true],
]

test('tools mode none (the default) records pure dialogue without a tools field', () => {
  const events = oneTurn({ user: '改一下记忆', tools: TOOL_FIXTURE })
  const record = turnLog.buildTurnRecords(events)[0]
  assert.equal(record.tools, undefined)
  // 默认值走设置而不是参数：默认档就是 none。
  assert.equal(turnLog.buildTurnRecords(events)[0].tools, undefined)
})

test('tools mode errors keeps only the isError result line', () => {
  const record = turnLog.buildTurnRecords(oneTurn({ user: '查一下', tools: TOOL_FIXTURE }), { tools: 'errors' })[0]
  assert.equal(record.tools.length, 1)
  assert.match(record.tools[0], /readSession → 失败: not found/)
  assert.ok(!record.tools.some((line) => line.includes('edit_memory')), 'the successful call is not in errors mode')
})

test('tools mode summary pairs calls with results and flags calls without one', () => {
  const tools = [...TOOL_FIXTURE, ['c3', 'interruptedTool', '{"x":1}']] // 没有结果：被打断的调用
  const record = turnLog.buildTurnRecords(oneTurn({ user: '干活', tools }), { tools: 'summary' })[0]
  assert.equal(record.tools.length, 3)
  assert.match(record.tools[0], /edit_memory\(\{"id":"m1"\}\) → 成功/)
  assert.match(record.tools[1], /readSession\(\{"path":"a.ts"\}\) → 失败: not found/)
  assert.match(record.tools[2], /interruptedTool\(\{"x":1\}\) → 无结果/)
})

test('the assistant tool-call block is not double-counted next to its tool/call event', () => {
  const events = [
    turnStart(10),
    userMessage(11, '只算一次'),
    assistantMessage(12, '', [{ type: 'tool-call', id: 'c9', name: 'dupTool', arguments: '{}' }]),
    toolCallEvent(13, 'c9', 'dupTool', '{}'),
    toolResultEvent(14, 'c9', 'ok'),
    turnEnd(15),
  ]
  const record = turnLog.buildTurnRecords(events, { tools: 'summary' })[0]
  assert.equal(record.tools.length, 1)
  assert.match(record.tools[0], /dupTool\(\{\}\) → 成功/)
})

// —— 三层 caps（§3.1） ———————————————————————————————————————

test('user and model text are each capped at 2000 chars and always kept in full within that', () => {
  const longUser = 'u'.repeat(3000)
  const longModel = 'm'.repeat(3000)
  const record = turnLog.buildTurnRecords(oneTurn({ user: longUser, assistant: longModel }))[0]
  assert.ok(record.user.length <= turnLog.TURNLOG_USER_MODEL_CHARS + 1)
  assert.ok(record.user.startsWith('u'.repeat(50)))
  assert.ok(record.model.length <= turnLog.TURNLOG_USER_MODEL_CHARS + 1)
})

test('each tool line is capped at 160 chars', () => {
  const tools = [['c1', 'tool', '{}', 'e'.repeat(500), true]]
  const record = turnLog.buildTurnRecords(oneTurn({ user: 'hi', tools }), { tools: 'errors' })[0]
  assert.ok(record.tools[0].length <= turnLog.TURNLOG_TOOL_LINE_CHARS + 1)
})

test('the 4000-char record cap cuts tool lines from the tail, never user/model', () => {
  const pad = 'p'.repeat(130)
  const tools = Array.from({ length: 30 }, (_, i) => [`c${i}`, `tool${i}`, `{"n":${i},"pad":"${pad}"}`, `r${String(i).repeat(140)}`, false])
  const record = turnLog.buildTurnRecords(oneTurn({ user: '短问题', assistant: '短回答', tools }), { tools: 'summary' })[0]
  assert.ok(JSON.stringify(record).length <= turnLog.TURNLOG_RECORD_CHARS, 'the serialized record fits the total cap')
  assert.equal(record.user, '短问题')
  assert.equal(record.model, '短回答')
  const marker = record.tools[record.tools.length - 1]
  assert.match(marker, /…\[另有 \d+ 条工具调用已省略\]/)
  // 保留行按原始顺序装，来自头部；行格式与未超预算时一致（args 同样 120 字截断）。
  const kept = record.tools.slice(0, -1)
  const expectedLine = ([, name, args]) => `${name}(${args.length > 120 ? `${args.slice(0, 120)}…` : args}) → 成功`
  assert.deepEqual(kept, tools.slice(0, kept.length).map(expectedLine))
})

// —— 设置面（§10.1 / 构件 4） ———————————————————————————————————

test('the two new settings survive the setSettings allowlist and reset to their defaults', async () => {
  await rpc.dispatch({}, 'setSettings', { patch: { consolidationTurnLog: 'off', consolidationTurnLogTools: 'summary' } })
  assert.equal(state.getSettings().consolidationTurnLog, 'off')
  assert.equal(state.getSettings().consolidationTurnLogTools, 'summary')
  // 设置档驱动默认 tools 档（无参数调用读设置）。
  const record = turnLog.buildTurnRecords(oneTurn({ user: '看档位', tools: TOOL_FIXTURE }))[0]
  assert.equal(record.tools.length, 2, 'the settings-chosen summary mode is now the default')
  await assert.rejects(
    rpc.dispatch({}, 'setSettings', { patch: { consolidationTurnLogTools: 'all' } }),
    /invalid setting consolidationTurnLogTools/,
  )
  const reset = await rpc.dispatch({}, 'resetSettings', {})
  assert.equal(reset.consolidationTurnLog, 'on')
  assert.equal(reset.consolidationTurnLogTools, 'none')
})

// —— 落盘、增量读取与对账（§3.3） ————————————————————————————————

test('recordTurn appends one JSON line per turn and readIncrement returns whole turns only', () => {
  const sessionId = 'incr-turns'
  turnLog.recordTurn(sessionId, { seq: [0, 10], at: '2026-11-13T21:00:00.000Z', scene: null, user: '一', model: '甲' })
  turnLog.recordTurn(sessionId, { seq: [11, 20], at: '2026-11-13T21:01:00.000Z', scene: null, user: '二', model: '乙' })
  turnLog.recordTurn(sessionId, { seq: [21, 30], at: '2026-11-13T21:02:00.000Z', scene: null, user: '三', model: '丙' })

  // afterSeq 落在回合中间（15）：按 seqStart > afterSeq 过滤，[11,20] 整回合让位——
  // 返回的永远只有完整回合，绝无半回合。
  assert.deepEqual(turnLog.readIncrement(sessionId, 15).records.map((r) => r.seq), [[21, 30]])
  assert.deepEqual(turnLog.readIncrement(sessionId, 10).records.map((r) => r.seq), [[11, 20], [21, 30]])
  assert.deepEqual(turnLog.readIncrement(sessionId, 30).records, [])
  assert.equal(turnLog.readIncrement(sessionId, -1).records.length, 3)
  assert.equal(turnLog.readIncrement(sessionId, undefined).records.length, 3, 'a missing cursor reads the whole log')
})

test('recordTurn fills a missing timestamp and refuses records without a seq range', () => {
  const sessionId = 'at-fill'
  turnLog.recordTurn(sessionId, { seq: [0, 5], scene: null, user: 'a', model: 'b' })
  const line = fs.readFileSync(turnLog.turnLogPath(sessionId), 'utf8').trim().split('\n')[0]
  assert.ok(JSON.parse(line).at, 'recordTurn stamps the record when the turn/end had no time')
  assert.equal(turnLog.recordTurn(sessionId, { user: 'no seq' }), null, 'unanchorable records are rejected with a warn')
})

test('verifyGap finds holes between and around records', () => {
  const sessionId = 'gap-check'
  turnLog.recordTurn(sessionId, { seq: [0, 10], at: 't', scene: null, user: 'a', model: 'b' })
  turnLog.recordTurn(sessionId, { seq: [21, 30], at: 't', scene: null, user: 'c', model: 'd' })
  const hole = turnLog.verifyGap(sessionId, 0, 30)
  assert.equal(hole.ok, false)
  assert.deepEqual(hole.missingRanges, [[11, 20]])
  assert.equal(turnLog.verifyGap(sessionId, 0, 10).ok, true)
  const empty = turnLog.verifyGap('gap-never-written', 5, 50)
  assert.deepEqual(empty.missingRanges, [[5, 50]])
})

test('rebuildRange fills exactly the missing range from host events and is idempotent', () => {
  const sessionId = 'rebuild'
  const events = [
    ...oneTurn({ user: '第一回合', startSeq: 0 }),
    ...oneTurn({ user: '第二回合', startSeq: 40 }),
    ...oneTurn({ user: '第三回合', startSeq: 80 }),
  ]
  // 只记了第一回合，中间与尾部都是洞。
  turnLog.recordTurn(sessionId, { seq: [0, 17], at: 't', scene: null, user: '第一回合', model: '' })

  const first = turnLog.rebuildRange(sessionId, 18, 120, events)
  assert.equal(first.ok, true)
  assert.equal(first.rebuilt, 2)
  const { records } = turnLog.readIncrement(sessionId, 17)
  assert.deepEqual(records.map((r) => r.seq[0]), [40, 80])

  // 再跑一遍不产生重复行：重建幂等。
  const second = turnLog.rebuildRange(sessionId, 0, 120, events)
  assert.equal(second.rebuilt, 0)
  assert.equal(turnLog.readIncrement(sessionId, -1).records.length, 3)
  // 请求区间之外的事件不进日志。
  const outside = turnLog.rebuildRange(sessionId, 1000, 2000, events)
  assert.equal(outside.rebuilt, 0)
})

test('readers tolerate bad lines: skipped, counted, never thrown', () => {
  const sessionId = 'bad-lines'
  turnLog.recordTurn(sessionId, { seq: [0, 10], at: 't', scene: null, user: 'a', model: 'b' })
  fs.appendFileSync(turnLog.turnLogPath(sessionId), '{this is not json\n', 'utf8')
  turnLog.recordTurn(sessionId, { seq: [11, 20], at: 't', scene: null, user: 'c', model: 'd' })

  const inc = turnLog.readIncrement(sessionId, -1)
  assert.equal(inc.records.length, 2)
  assert.equal(inc.badLines, 1)
  assert.equal(turnLog.verifyGap(sessionId, 0, 20).badLines, 1)
  assert.equal(turnLog.tailSlice(sessionId, 10_000).records.length, 2)
})

// —— 头部裁剪（§3.4：绝不裁进未结算区间） ————————————————————————————

function writeBulkyTurns(sessionId, count) {
  for (let i = 0; i < count; i++) {
    turnLog.recordTurn(sessionId, { seq: [i * 10, i * 10 + 9], at: 't', scene: null, user: `回合${i}`.padEnd(40, '字'), model: '' })
  }
}

test('pruneHead drops settled head records down to the budget, never past lastSleepSeq', () => {
  const sessionId = 'prune-head'
  writeBulkyTurns(sessionId, 6)
  // lastSleepSeq = 49：前 5 条已结算，最后一条（seqEnd 59）未结算。
  const report = turnLog.pruneHead(sessionId, 300, 49)
  assert.ok(report.pruned > 0, 'settled head records were cut')
  assert.ok(report.charsAfter <= 300)
  const after = turnLog.readIncrement(sessionId, -1).records
  assert.deepEqual(after.map((r) => r.seq[0]), [30, 40, 50], 'the cut stops inside settled range only; the unsettled turn survives')
})

test('pruneHead lets the file stay over budget rather than cut into the unsettled range', () => {
  const sessionId = 'prune-head-over'
  writeBulkyTurns(sessionId, 6)
  // lastSleepSeq = 19：只有前两条可裁，预算再小也不越过 seqEnd 19。
  const report = turnLog.pruneHead(sessionId, 100, 19)
  assert.ok(report.pruned > 0)
  assert.ok(report.charsAfter > 100, 'the file may stay over budget instead of pruning unsettled turns')
  const after = turnLog.readIncrement(sessionId, -1).records
  assert.ok(after.every((r) => r.seq[0] >= 20), 'every settled head record was taken; the unsettled tail is intact')

  // 没有结算游标：整份日志都是未结算段，一条不裁。
  const sessionId2 = 'prune-head-unsettled'
  writeBulkyTurns(sessionId2, 3)
  const untouched = turnLog.pruneHead(sessionId2, 50, null)
  assert.equal(untouched.pruned, 0)
  assert.equal(turnLog.readIncrement(sessionId2, -1).records.length, 3)
})

test('pruneHead preserves bad lines instead of dropping what it could not read', () => {
  const sessionId = 'prune-bad'
  turnLog.recordTurn(sessionId, { seq: [0, 9], at: 't', scene: null, user: 'a'.repeat(60), model: '' })
  fs.appendFileSync(turnLog.turnLogPath(sessionId), 'garbage line\n', 'utf8')
  turnLog.recordTurn(sessionId, { seq: [10, 19], at: 't', scene: null, user: 'b'.repeat(60), model: '' })
  turnLog.pruneHead(sessionId, 80, 100)
  const raw = fs.readFileSync(turnLog.turnLogPath(sessionId), 'utf8')
  assert.ok(raw.includes('garbage line'), 'a bad line cannot be proven settled, so it is kept')
})

// —— tailSlice（§5.1 交接尾部的来源） ——————————————————————————————

test('tailSlice takes whole turns from the tail within the char budget', () => {
  const sessionId = 'tail'
  turnLog.recordTurn(sessionId, { seq: [0, 9], at: 't', scene: null, user: 'a'.repeat(100), model: '' })
  turnLog.recordTurn(sessionId, { seq: [10, 19], at: 't', scene: null, user: 'b'.repeat(100), model: '' })
  turnLog.recordTurn(sessionId, { seq: [20, 29], at: 't', scene: null, user: 'c'.repeat(100), model: '' })
  const slice = turnLog.tailSlice(sessionId, 400)
  assert.deepEqual(slice.records.map((r) => r.seq[0]), [10, 20], 'whole turns from the tail, chronological')
  assert.ok(slice.chars <= 400)
  assert.ok(!slice.text.includes('aaaa'), 'the oldest turn did not fit the budget and was left out')
  assert.equal(slice.text.split('\n').length, 2, 'the text is whole-turn JSONL from the tail')
})

// —— 删除与休眠 GC（§3.4） ——————————————————————————————————————

test('deleteTurnLog removes the file and tolerates a missing one', () => {
  const sessionId = 'delete-me'
  turnLog.recordTurn(sessionId, { seq: [0, 1], at: 't', scene: null, user: 'a', model: 'b' })
  assert.ok(fs.existsSync(turnLog.turnLogPath(sessionId)))
  assert.equal(turnLog.deleteTurnLog(sessionId).ok, true)
  assert.equal(fs.existsSync(turnLog.turnLogPath(sessionId)), false)
  assert.equal(turnLog.deleteTurnLog(sessionId).ok, true, 'deleting a missing log is a no-op')
})

test('gcTurnLogs deletes only when idle past the threshold AND fully settled', () => {
  const now = Date.now()
  const old = new Date(now - 40 * 86_400_000).toISOString()
  const fresh = new Date(now - 1 * 86_400_000).toISOString()
  const writeLog = (sessionId, lastSeqEnd) => {
    turnLog.recordTurn(sessionId, { seq: [0, lastSeqEnd], at: 't', scene: null, user: 'a', model: 'b' })
  }
  writeLog('gc-settled', 30)
  writeLog('gc-unsettled', 30)
  writeLog('gc-recent', 30)
  writeLog('gc-never-settled', 30)

  const bindings = [
    { sessionId: 'gc-settled', lastTurnAt: old, lastSleepSeq: 30 },
    { sessionId: 'gc-unsettled', lastTurnAt: old, lastSleepSeq: 10 },
    { sessionId: 'gc-recent', lastTurnAt: fresh, lastSleepSeq: 30 },
    { sessionId: 'gc-never-settled', lastTurnAt: old },
    { sessionId: 'gc-no-log', lastTurnAt: old, lastSleepSeq: 30 },
  ]
  const dry = turnLog.gcTurnLogs(bindings, { now, dryRun: true })
  assert.deepEqual(dry.deleted, ['gc-settled'])
  assert.ok(fs.existsSync(turnLog.turnLogPath('gc-settled')), 'dry-run must not delete')
  assert.ok(dry.kept.some((k) => k.sessionId === 'gc-unsettled' && k.reason === 'unsettled-increment'))
  assert.ok(dry.kept.some((k) => k.sessionId === 'gc-recent' && k.reason === 'recent-activity'))
  assert.ok(dry.kept.some((k) => k.sessionId === 'gc-never-settled' && k.reason === 'never-settled'))
  assert.ok(!dry.deleted.includes('gc-no-log') && !dry.kept.some((k) => k.sessionId === 'gc-no-log'), 'a session without a log is not reported')

  const applied = turnLog.gcTurnLogs(bindings, { now })
  assert.deepEqual(applied.deleted, ['gc-settled'])
  assert.equal(fs.existsSync(turnLog.turnLogPath('gc-settled')), false)
  assert.ok(fs.existsSync(turnLog.turnLogPath('gc-unsettled')), 'the unsettled log is the increment source and stays')
})

// —— 订阅接线（§3.2：session/event 全局订阅，worker 会话绝不记） ————————————

function fakeCtx() {
  const handlers = new Map()
  return {
    ctx: { on: (name, handler) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); return () => { handlers.set(name, handlers.get(name).filter((h) => h !== handler)) } } },
    emit(name, ...args) { for (const handler of handlers.get(name) || []) handler(...args) },
    off(name) { handlers.delete(name) },
  }
}

function bindSession(sessionId, { origin, useLibrary, sessionGone } = {}) {
  state.ensureSession(sessionId, { cwd: path.join(home, 'ws', sessionId) })
  const patch = {}
  if (useLibrary !== undefined) patch.useLibrary = useLibrary
  if (sessionGone !== undefined) patch.sessionGone = sessionGone
  if (Object.keys(patch).length > 0) state.setSessionBinding(sessionId, patch)
  return { header: { id: sessionId, origin, cwd: path.join(home, 'ws', sessionId) } }
}

test('the session/event recorder writes one line per turn for admitted sessions', () => {
  const { ctx, emit } = fakeCtx()
  const dispose = registerTurnLogRecorder(ctx)
  const session = bindSession('rec-on')
  emit('session/event', session, turnStart(0, 1))
  emit('session/event', session, userMessage(1, '记下这一句'))
  emit('session/event', session, assistantMessage(2, '好的。'))
  emit('session/event', session, turnEnd(3, { turn: 1 }))

  const { records } = turnLog.readIncrement('rec-on', -1)
  assert.equal(records.length, 1)
  assert.equal(records[0].user, '记下这一句')
  assert.equal(records[0].model, '好的。')
  dispose()
})

test('worker (subagent) sessions, unbound sessions and the off switch never record', () => {
  const { ctx, emit } = fakeCtx()
  const dispose = registerTurnLogRecorder(ctx)
  const subagent = bindSession('rec-subagent', { origin: 'subagent' })
  state.ensureSession('rec-subagent', { cwd: path.join(home, 'ws', 'rec-subagent') })
  emit('session/event', subagent, turnStart(0))
  emit('session/event', subagent, userMessage(1, 'worker 的回合'))
  emit('session/event', subagent, turnEnd(2))
  assert.equal(fs.existsSync(turnLog.turnLogPath('rec-subagent')), false, 'worker sessions are never recorded')

  const unbound = { header: { id: 'rec-unbound', origin: undefined } }
  emit('session/event', unbound, turnStart(0))
  emit('session/event', unbound, userMessage(1, '没有绑定'))
  emit('session/event', unbound, turnEnd(2))
  assert.equal(fs.existsSync(turnLog.turnLogPath('rec-unbound')), false)

  const offSession = bindSession('rec-off', { useLibrary: false })
  emit('session/event', offSession, turnStart(0))
  emit('session/event', offSession, userMessage(1, '库关了'))
  emit('session/event', offSession, turnEnd(2))
  assert.equal(fs.existsSync(turnLog.turnLogPath('rec-off')), false, 'useLibrary === false sessions are skipped')

  state.updateSettings({ consolidationTurnLog: 'off' })
  const switchOff = bindSession('rec-switch-off')
  emit('session/event', switchOff, turnStart(0))
  emit('session/event', switchOff, userMessage(1, '开关关了'))
  emit('session/event', switchOff, turnEnd(2))
  assert.equal(fs.existsSync(turnLog.turnLogPath('rec-switch-off')), false, 'the off switch stops the recorder')
  state.updateSettings({ consolidationTurnLog: 'on' })
  dispose()
})

test('a deleted session (sessionGone) loses its log on session/disposed', () => {
  const { ctx, emit } = fakeCtx()
  const dispose = registerTurnLogRecorder(ctx)
  const session = bindSession('rec-gone', { sessionGone: true })
  turnLog.recordTurn('rec-gone', { seq: [0, 5], at: 't', scene: null, user: 'a', model: 'b' })
  assert.ok(fs.existsSync(turnLog.turnLogPath('rec-gone')))
  emit('session/disposed', session)
  assert.equal(fs.existsSync(turnLog.turnLogPath('rec-gone')), false, 'sessionGone bindings get their log deleted')
  // 未标 sessionGone 的销毁（进程内卸载）不删：日志比会话活得长。
  const alive = bindSession('rec-alive')
  turnLog.recordTurn('rec-alive', { seq: [0, 5], at: 't', scene: null, user: 'a', model: 'b' })
  emit('session/disposed', alive)
  assert.ok(fs.existsSync(turnLog.turnLogPath('rec-alive')))
  dispose()
})
