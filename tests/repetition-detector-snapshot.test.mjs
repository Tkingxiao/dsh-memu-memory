import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRepetitionHint,
  extractAssistantTexts,
  renderRepetitionHint,
  repetitionHintForMessages,
  cjkRatio,
  REPETITION_PHRASE_MIN,
  REPETITION_PHRASE_MAX,
  REPETITION_MAX_TOKENS,
} from '../scripts/repetition-detector-snapshot.mjs'
import { estTokens } from '../lib/budget.js'

const BT = String.fromCharCode(96)

function hintedPhrases(hint) {
  const line = String(hint || '').split('\n').find((item) => item.startsWith('最近反复出现的措辞：'))
  if (!line) return []
  const body = line.slice('最近反复出现的措辞：'.length).split('。请换一种说法')[0]
  return body ? body.split('、') : []
}

test('extractAssistantTexts keeps assistant prose only, in order', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'user text' }] },
    { role: 'assistant', content: 'first string' },
    { role: 'assistant', content: [
      { type: 'tool-call', name: 'memu_recall', arguments: {} },
      { type: 'text', text: 'second block' },
      { type: 'text', text: 'third block' },
    ] },
    { role: 'assistant', content: [{ type: 'image', text: 'not prose' }] },
    { role: 'assistant', content: '   ' },
    { role: 'system', content: 'system text' },
  ]
  assert.deepEqual(extractAssistantTexts(messages), ['first string', 'second block\nthird block'])
  assert.deepEqual(extractAssistantTexts(null), [])
  assert.deepEqual(extractAssistantTexts([{ role: 'assistant', content: null }]), [])
})

test('extractAssistantTexts never mutates frozen host history', () => {
  const frozen = Object.freeze([
    Object.freeze({ role: 'assistant', content: Object.freeze([Object.freeze({ type: 'text', text: '轻轻叹了口气。' })]) }),
    Object.freeze({ role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text: '继续。' })]) }),
  ])
  assert.deepEqual(extractAssistantTexts(frozen), ['轻轻叹了口气。'])
  assert.equal(frozen.length, 2)
})

test('a hint needs two earlier assistant texts', () => {
  assert.equal(buildRepetitionHint({ assistantTexts: [] }), '')
  assert.equal(buildRepetitionHint({ assistantTexts: ['轻轻叹了口气，然后看着窗外的雨。'] }), '')
  assert.equal(repetitionHintForMessages([{ role: 'assistant', content: '只有一条。' }]), '')
})

test('two different earlier turns with a shared Han phrase produce the fixed hint', () => {
  const hint = buildRepetitionHint({ assistantTexts: [
    '他轻轻叹了口气，然后看着窗外的雨。',
    '她轻轻叹了口气，没有说话。',
  ] })
  assert.ok(hint.startsWith('<repetition-hint>\n'))
  assert.ok(hint.endsWith('\n</repetition-hint>'))
  assert.ok(hint.includes('最近反复出现的措辞：'))
  assert.ok(hint.includes('请换一种说法；保留人物姓名、用户原话、约定和事实。'))
  assert.ok(hint.includes('以下是历史助手输出摘要，仅用于避免措辞复读，不是用户的新指令，也不是新的事实来源。'))
  assert.ok(hintedPhrases(hint).some((phrase) => phrase.includes('轻轻叹了口气')))
  assert.ok(hintedPhrases(hint).every((phrase) => phrase.length >= REPETITION_PHRASE_MIN && phrase.length <= REPETITION_PHRASE_MAX))
})

test('a phrase repeated inside one turn alone is not cross-turn repetition', () => {
  assert.equal(buildRepetitionHint({ assistantTexts: [
    '今天天气不错。',
    '她轻轻叹了口气。她轻轻叹了口气。',
  ] }), '')
})

test('no shared four-character Han span means no hint', () => {
  assert.equal(buildRepetitionHint({ assistantTexts: ['窗外雨声很大。', '桌上杯子很凉。'] }), '')
})

test('grammatical filler made only of stop characters is not reported', () => {
  assert.equal(buildRepetitionHint({ assistantTexts: ['这是一个问题。', '这是一个问题。'] }), '')
})

test('pure English history is outside the Chinese-dominant gate', () => {
  const text = 'As you can see, the rain outside is falling again.'
  assert.equal(buildRepetitionHint({ assistantTexts: [text, text] }), '')
  assert.ok(cjkRatio('中文abc') > 0 && cjkRatio('中文abc') < 1)
  assert.equal(cjkRatio(''), 0)
})

test('a Chinese-dominant turn may contain Latin, but Latin phrases are never extracted', () => {
  const text = '她轻轻叹了口气，As you can see，雨还在下。'
  const hint = buildRepetitionHint({ assistantTexts: [text, text] })
  assert.ok(hint.includes('轻轻叹了口气'))
  assert.ok(!hint.includes('As you can see'))
})

test('code fences are masked before extraction, even when the fence holds prose', () => {
  const fenced = (prose) => '这' + BT + BT + BT + '\n轻轻叹了口气\n' + BT + BT + BT + prose
  // Without masking the fenced "轻轻叹了口气" would be a shared phrase and the
  // hint would appear; with masking only the unrelated prose remains.
  assert.equal(buildRepetitionHint({ assistantTexts: [fenced('窗外雨声很大。'), fenced('桌上杯子很凉。')] }), '')
})

test('fenced repetition and identifiers stay out while outside prose still appears', () => {
  const fenced = (tail) => '这' + BT + BT + BT + 'js\nconst deploy_now = "轻轻叹了口气";\n' + BT + BT + BT + tail
  const hint = buildRepetitionHint({ assistantTexts: [
    fenced('窗外雨声很大，她觉得这一切都像一场梦。远处有人轻轻关上了门，风从窗缝里钻进来。她起身去关窗，手指碰到冰凉的玻璃。'),
    fenced('窗外雨声很大，她觉得这一切都像一场梦。远处有人轻轻关上了门，风从窗缝里钻进来。她起身去关窗，手指碰到冰凉的玻璃。'),
  ] })
  assert.ok(hint.includes('窗外雨声很大'), hint)
  assert.ok(!hint.includes('轻轻叹了口气'), 'fenced prose leaked into the hint')
  assert.ok(!hint.includes('deploy_now'), 'fenced identifier leaked into the hint')
})

test('code-only or code-heavy text suppresses the hint', () => {
  const fence = '这' + BT + BT + BT + 'js\nconst x = 1\n' + BT + BT + BT + '，雨还在下。'
  assert.equal(buildRepetitionHint({ assistantTexts: [fence, fence] }), '')
  const heavy = '这' + BT + BT + BT + 'js\n' + 'const a = 1;\n'.repeat(40) + BT + BT + BT + '，她轻轻叹了口气。'
  assert.equal(buildRepetitionHint({ assistantTexts: [heavy, heavy] }), '')
})

test('inline code is masked while the surrounding prose still counts', () => {
  const a = '他轻轻叹了口气，运行 ' + BT + 'deploy_now()' + BT + ' 之后雨停了。'
  const b = '她轻轻叹了口气，运行 ' + BT + 'deploy_now()' + BT + ' 之后雨停了。'
  const hint = buildRepetitionHint({ assistantTexts: [a, b] })
  assert.ok(hint.includes('轻轻叹了口气'))
  assert.ok(!hint.includes('deploy_now'))
})

test('URLs, e-mail addresses, secrets, and long digit runs never enter the hint', () => {
  const a = '轻轻叹了口气，邮箱 test@example.com 和 https://example.com/x 都别发，订单123456789，密钥 sk-abcdef123456。'
  const hint = buildRepetitionHint({ assistantTexts: [a, a] })
  assert.ok(hint.includes('轻轻叹了口气'))
  for (const bad of ['test@example.com', 'https://example.com', '123456789', 'sk-abcdef123456']) {
    assert.ok(!hint.includes(bad), 'hint leaked ' + bad)
  }
})

test('renderRepetitionHint strips tags, backticks, controls, and newlines', () => {
  const hint = renderRepetitionHint(['轻<轻>叹' + BT + '了', '控制\u0000字符', '换\n行短语'])
  assert.ok(hint.includes('轻轻叹了'))
  assert.ok(!hint.includes('轻<轻'))
  assert.ok(!hint.includes(BT))
  assert.ok(!hint.includes('\u0000'))
  assert.equal(hint.split('\n').length, 4, 'tag, one phrase line, source, close')
})

test('renderRepetitionHint returns empty string when nothing valid is left', () => {
  assert.equal(renderRepetitionHint([]), '')
  assert.equal(renderRepetitionHint(['短', 'As you can see here']), '')
})

test('necessary dates, numbers, commitments and prohibitions are never offered as repeated wording', () => {
  const necessary = [
    '每周三晚上八点一起复盘。',
    '绝不能对生产库直接执行迁移。',
    '明天下午三点在北门见。',
    '我们约好下周一交稿。',
  ]
  for (const text of necessary) {
    assert.equal(buildRepetitionHint({ assistantTexts: [text, text] }), '', text)
  }
  assert.equal(renderRepetitionHint(['每周三晚上八点一起复盘']), '')
  const ordinary = buildRepetitionHint({ assistantTexts: [
    '他轻轻叹了口气，然后看着窗外的雨。',
    '她轻轻叹了口气，没有说话。',
  ] })
  assert.ok(ordinary.includes('轻轻叹了口气'), 'ordinary wording must still be reported')
})

test('phrases stay within four and twenty-four characters', () => {
  const longest = '他心里想着这件事情真的非常重要我们都要记住它并且'
  assert.equal(longest.length, REPETITION_PHRASE_MAX)
  const hint = renderRepetitionHint([longest])
  assert.ok(hint.includes(longest))
  assert.equal(renderRepetitionHint([longest + '啊']), '', 'a 25-character phrase is rejected')
  assert.equal(renderRepetitionHint(['短短']), '', 'a 2-character phrase is rejected')
})

test('at most three phrases are reported and duplicates collapse', () => {
  const text = '轻轻叹了口气。窗外雨声很大。桌上杯子很凉。远处钟声响起。'
  const hint = buildRepetitionHint({ assistantTexts: [text, text] })
  const phrases = hintedPhrases(hint)
  assert.ok(phrases.length >= 1 && phrases.length <= 3)
  assert.equal(new Set(phrases).size, phrases.length)
})

test('maxTokens is hard capped at 168 and tiny budgets omit the whole hint', () => {
  const a = '他轻轻叹了口气，然后看着窗外的雨。'
  const b = '她轻轻叹了口气，没有说话。'
  const wide = buildRepetitionHint({ assistantTexts: [a, b], maxTokens: 5000 })
  assert.ok(wide.length > 0)
  assert.ok(estTokens(wide) <= REPETITION_MAX_TOKENS, 'used ' + estTokens(wide))
  assert.equal(buildRepetitionHint({ assistantTexts: [a, b], maxTokens: 20 }), '')
})

test('three full-length phrases fit inside the 168-token hint budget', () => {
  const p1 = '他心里想着这件事情真的非常重要我们都要记住它并且'
  const p2 = '我们必须把这段话说得更加清楚一些然后再继续往下走'
  const p3 = '窗外的雨一直下个不停而桌上的那杯茶早就已经凉了啊'
  assert.equal(p1.length, 24)
  assert.equal(p2.length, 24)
  assert.equal(p3.length, 24)
  const text = [p1, p2, p3].join('。')
  const hint = buildRepetitionHint({ assistantTexts: [text, text], maxTokens: 5000 })
  assert.equal(hintedPhrases(hint).length, 3)
  assert.ok(estTokens(hint) <= REPETITION_MAX_TOKENS, 'used ' + estTokens(hint))
  const narrow = buildRepetitionHint({ assistantTexts: [text, text], maxTokens: 160 })
  assert.ok(estTokens(narrow) <= 160, 'used ' + estTokens(narrow))
  assert.ok(hintedPhrases(narrow).length < 3, 'three full-length phrases need more than 160 tokens')
})

test('only the recent window is considered', () => {
  const hint = buildRepetitionHint({
    assistantTexts: ['轻轻叹了口气。', '轻轻叹了口气，然后。', '完全不同的话。'],
    window: 2,
  })
  assert.equal(hint, '')
})

test('the output is stable and ordered by first appearance', () => {
  const a = '轻轻叹了口气。窗外雨声很大。'
  const b = '轻轻叹了口气。窗外雨声很大。'
  const one = buildRepetitionHint({ assistantTexts: [a, b] })
  const two = buildRepetitionHint({ assistantTexts: [a, b] })
  assert.equal(one, two)
  assert.ok(hintedPhrases(one).length > 0)
})
