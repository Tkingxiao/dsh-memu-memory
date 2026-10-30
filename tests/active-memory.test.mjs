import test from 'node:test'
import assert from 'node:assert/strict'

const { ACTIVE_MEMORY_POLICY, assessWake, collectEvidence, scoreEvidence, suppressionReason } = await import('../lib/active-memory.js')

// 2026-10-30 的现场：长会话里连续触发整理，每次都把整段转录种进 fork，重复付 token。
// 这组用例钉住"什么时候值得唤醒"和"什么时候必须抑制"。

const human = text => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const pluginNotice = text => ({ type: 'user/message', data: { source: { kind: 'plugin:other' }, content: [{ type: 'text', text }] } })
const assistant = (blocks) => ({ type: 'assistant/message', data: { message: { content: blocks } } })
const toolResult = (text, extra = {}) => ({ type: 'tool/result', data: { message: { isError: false, content: [{ type: 'text', text }], ...extra } } })

test('evidence only counts what a person actually typed, plus deduped work', () => {
  const evidence = collectEvidence([
    human('帮我看一下这个 fork 为什么建不起来'),
    pluginNotice('（插件提示：本轮召回 3 条）'),
    assistant([{ type: 'text', text: '看到了，是模型路由没继承。' }, { type: 'tool-call', name: 'read' }]),
    toolResult('文件内容 A'.repeat(100)),
    toolResult('文件内容 A'.repeat(100)),
    toolResult('   '),
    { type: 'tool/result', data: { message: { isError: true, content: [{ type: 'text', text: 'boom' }] } } },
  ])
  assert.equal(evidence.humanTurns, 1)
  assert.equal(evidence.toolCalls, 1)
  assert.equal(evidence.toolUnits, 1, 'polling repeats and error results are not work units')
  assert.ok(evidence.toolChars > 0 && evidence.toolChars <= ACTIVE_MEMORY_POLICY.toolResultCharsCap)
  assert.ok(evidence.assistantChars > 0)
})

test('each score part is capped so tool spam cannot reach the threshold alone', () => {
  const manyTools = { humanTurns: 0, humanChars: 0, assistantChars: 0, toolChars: 200_000, toolUnits: 500 }
  const scored = scoreEvidence(manyTools)
  assert.equal(scored.parts.tool, ACTIVE_MEMORY_POLICY.partCap)
  const absent = assessWake({ evidence: manyTools })
  assert.equal(absent.wake, false)
  assert.equal(absent.reason, 'no-human-turn')
})

test('a real long turn clears the threshold, a greeting does not', () => {
  const longTurn = collectEvidence([
    human('把 managed vector 的切换重建链路再核一遍，尤其是回读和失败回滚'),
    assistant([{ type: 'text', text: '结论：回读缺失会导致整代重建作废。'.repeat(40) }, { type: 'tool-call', name: 'read' }]),
    toolResult('daemon 日志与调用链摘要'.repeat(80)),
    toolResult('测试输出摘要'.repeat(80)),
    toolResult('配置摘要'.repeat(40)),
    toolResult('失败明细样例'.repeat(60)),
    toolResult('迁移账本摘要'.repeat(60)),
    human('继续，把失败明细也加上'),
    toolResult('权限矩阵摘要'.repeat(50)),
    toolResult('重建进度样例'.repeat(50)),
    human('再补一版日志页的筛选项'),
  ])
  const wake = assessWake({ evidence: longTurn })
  assert.equal(wake.wake, true)
  assert.ok(wake.score >= ACTIVE_MEMORY_POLICY.minScore)

  const greeting = assessWake({ evidence: collectEvidence([human('早'), assistant([{ type: 'text', text: '早！' }])]) })
  assert.equal(greeting.wake, false)
  assert.equal(greeting.reason, 'low-score')
})

test('starvation wakes a quiet-but-long small session, not a large transcript', () => {
  const thin = collectEvidence([human('嗯，继续')])
  assert.equal(assessWake({ evidence: thin }).wake, false)
  const starved = assessWake({ evidence: thin, starved: true })
  assert.equal(starved.wake, true)
  assert.equal(starved.reason, 'starved')
  // 真机会话 5913 条事件：fork 要把整段转录重新种一遍，薄回合不能靠饥饿放行。
  const largeThin = assessWake({ evidence: thin, starved: true, transcriptEvents: 5913 })
  assert.equal(largeThin.wake, false)
  assert.equal(largeThin.reason, 'large-transcript-thin')
  assert.equal(assessWake({ evidence: thin, starved: false, transcriptEvents: 5913 }).reason, 'low-score')
})

test('a dense turn still wakes a large transcript on merit', () => {
  const dense = collectEvidence([
    human('把这次重建失败的原因和回滚步骤记下来'),
    assistant([{ type: 'text', text: '根因是提交载荷少了 recall_files。'.repeat(300) }, { type: 'tool-call', name: 'read' }]),
    ...Array.from({ length: 20 }, (_, i) => toolResult(('回读失败明细 ' + i + ' ').repeat(200))),
    human('还有迁移账本和失败明细'),
    human('最后给我一版回滚步骤'),
  ])
  const wake = assessWake({ evidence: dense, starved: true, transcriptEvents: 5913 })
  assert.equal(wake.wake, true)
  assert.equal(wake.reason, 'score')
  assert.ok(wake.score >= ACTIVE_MEMORY_POLICY.minScore)
  assert.equal(ACTIVE_MEMORY_POLICY.largeTranscriptEvents, 2000, 'threshold is part of the calibrated policy')
})

test('recent consolidation or a recent recall suppresses the idle fork', () => {
  const now = Date.parse('2026-10-30T05:00:00.000Z')
  assert.equal(suppressionReason({ now, lastSleepAt: '2026-10-30T04:50:00.000Z' }), 'recent-consolidation')
  assert.equal(suppressionReason({ now, lastInjectedAt: '2026-10-30T04:55:00.000Z' }), 'recent-recall')
  assert.equal(suppressionReason({ now, lastSleepAt: '2026-10-30T03:00:00.000Z', lastInjectedAt: '2026-10-30T04:00:00.000Z' }), null)
  assert.equal(suppressionReason({ now, lastSleepAt: '2026-10-30T04:50:00.000Z', consolidatedCooldownMinutes: 5 }), null, 'cooldown is configurable')
  // 没有时间戳 = 从未整理/注入，不抑制。
  assert.equal(suppressionReason({ now }), null)
})

test('a large unconsolidated backlog wakes even when the turn itself is thin', () => {
  // 守卫的理由是「为一句轻话重种整段转录不划算」。但当整段转录本身还没整理过，
  // 那不是重种，是欠着：没有积压上界，一个 20k 事件的会话只要每轮都说「继续」，
  // 它的早期决定就永远进不了记忆——延迟没有上界，等于丢失。
  const thin = collectEvidence([
    human('继续'),
    assistant([{ type: 'text', text: '还在跑。' }]),
  ])
  const blocked = assessWake({ evidence: thin, starved: true, transcriptEvents: 20_000, pendingEvents: 0 })
  assert.equal(blocked.wake, false)
  assert.equal(blocked.reason, 'large-transcript-thin')

  const owed = assessWake({ evidence: thin, starved: true, transcriptEvents: 20_000, pendingEvents: 900 })
  assert.equal(owed.wake, true)
  assert.equal(owed.reason, 'backlog')

  // 边界：正好达到上界就放行，且没有真人回合时积压不构成理由（那是 no-human-turn）。
  assert.equal(assessWake({ evidence: thin, starved: true, transcriptEvents: 20_000, pendingEvents: 600 }).reason, 'backlog')
  assert.equal(assessWake({ evidence: thin, starved: true, transcriptEvents: 20_000, pendingEvents: 599 }).reason, 'large-transcript-thin')
  const noHuman = collectEvidence([assistant([{ type: 'text', text: '还在跑。' }])])
  assert.equal(assessWake({ evidence: noHuman, starved: true, transcriptEvents: 20_000, pendingEvents: 900 }).reason, 'no-human-turn')
})

test('the backlog bound stays out of the way for a session that is already up to date', () => {
  const thin = collectEvidence([human('继续'), assistant([{ type: 'text', text: '好。' }])])
  // 已整理到最新：待整理区间很小，规则回到原来的分数/饥饿判定。
  assert.equal(assessWake({ evidence: thin, starved: false, transcriptEvents: 20_000, pendingEvents: 3 }).wake, false)
  assert.equal(assessWake({ evidence: thin, starved: true, transcriptEvents: 900, pendingEvents: 3 }).reason, 'starved')
})
