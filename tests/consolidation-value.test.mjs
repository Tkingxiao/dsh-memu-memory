import test from 'node:test'
import assert from 'node:assert/strict'

const { assessConsolidationValue, unconsolidatedEvents } = await import('../lib/private.js')

function human(seq, text) {
  return { seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

function notice(seq, text) {
  return { seq, type: 'user/message', data: { source: { kind: 'plugin:dsh-memu-memory' }, content: [{ type: 'text', text }] } }
}

function assistant(seq, blocks) {
  return { seq, type: 'assistant/message', data: { message: { content: blocks } } }
}

test('an empty tail is not worth a fork', () => {
  const value = assessConsolidationValue([])
  assert.equal(value.worth, false)
  assert.equal(value.reason, 'no-human-turn')
  assert.equal(value.humanTurns, 0)
})

test('plugin notices and tool chatter are not human turns', () => {
  const value = assessConsolidationValue([
    notice(0, '整理这场对话的私有记忆'),
    { seq: 1, type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
    notice(2, 'short_term · 快到期了'),
  ])
  assert.equal(value.worth, false)
  assert.equal(value.humanTurns, 0)
})

test('a bare thank-you is small talk', () => {
  const value = assessConsolidationValue([human(0, '谢谢'), assistant(1, [{ type: 'text', text: '不客气' }])])
  assert.equal(value.worth, false)
  assert.equal(value.reason, 'small-talk')
  assert.equal(value.humanTurns, 1)
})

test('one substantive message is enough', () => {
  const value = assessConsolidationValue([human(0, '以后发版前不要动 AGENTS.md 里那行预算，它一超就被静默截断，模型永远看不到后半段。')])
  assert.equal(value.worth, true)
  assert.equal(value.reason, 'substantive')
  assert.ok(value.humanChars >= 12)
})

test('tool work counts even when the person types little', () => {
  const value = assessConsolidationValue([
    human(0, '跑一下'),
    assistant(1, [{ type: 'tool-call', name: 'bash', arguments: '{"command":"npm test"}' }]),
    { seq: 2, type: 'tool/call', data: { name: 'bash', arguments: '{}' } },
  ])
  assert.equal(value.worth, true)
  assert.equal(value.toolCalls, 2, 'both shapes of tool call are counted')
})

test('a short message can be the whole point', () => {
  // Length is not substance: five characters are a durable preference.
  const value = assessConsolidationValue([human(0, '我不吃香菜')])
  assert.equal(value.worth, true)
  assert.equal(value.humanTurns, 1)
})

test('an acknowledgement is refused, a short question is not', () => {
  assert.equal(assessConsolidationValue([human(0, '好的，继续')]).worth, false)
  assert.equal(assessConsolidationValue([human(0, '这个怎么配')]).worth, true, 'a question is worth reading even when it is short')
  assert.equal(assessConsolidationValue([human(0, '这个怎么配'), human(1, '我按文档试了还是不行')]).worth, true)
})

test('only the events after the last consolidation are judged', () => {
  const events = [human(0, '很久以前的一次长对话，已经整理过了，内容足够长足够长足够长足够长。'), human(1, '谢谢')]
  // No marker recorded yet: the whole transcript is the tail, so the old material
  // still counts once. That is deliberate — the first pass after an upgrade should
  // not decide "small talk" from a transcript it has never read.
  assert.equal(unconsolidatedEvents({}, events).length, 2)
  assert.equal(assessConsolidationValue(unconsolidatedEvents({}, events)).worth, true)
  // Once a marker exists, the tail is only what came after it.
  const tail = unconsolidatedEvents({ lastSleepSeq: 0 }, events)
  assert.equal(tail.length, 1)
  assert.equal(assessConsolidationValue(tail).worth, false)
})

test('a zero marker is honoured (seq 0 is a real position)', () => {
  const events = [human(0, '旧消息'), human(1, '新的一次决定，内容足够长足够长足够长足够长足够长足够长。')]
  const tail = unconsolidatedEvents({ lastSleepSeq: 0 }, events)
  assert.deepEqual(tail.map((event) => event.seq), [1])
})
