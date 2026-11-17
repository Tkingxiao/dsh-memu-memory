import test from 'node:test'
import assert from 'node:assert/strict'

const { queryTerms, firstHit, centeredSnippet, centeredSnippetWindow } = await import('../lib/snippet.js')

test('query terms drop noise and keep the long phrase as a fallback', () => {
  const terms = queryTerms('where a is the deploy key?')
  assert.ok(terms.includes('deploy'))
  // Single characters are noise; two-character words stay because they are real
  // words in Chinese queries (需求, 计划).
  assert.ok(!terms.includes('a'))
  assert.ok(queryTerms('改 需求').includes('需求'))
  assert.equal(terms[0], 'where a is the deploy key?', 'the whole query survives as the longest fallback term')
  assert.deepEqual(queryTerms('   '), [])
})

test('a hit is shown with room on both sides', () => {
  const text = 'A'.repeat(200) + '不想再改需求' + 'B'.repeat(200)
  const out = centeredSnippet(text, '不想再改需求')
  assert.ok(out.includes('不想再改需求'), 'the hit itself is always inside the snippet')
  assert.ok(out.length < 200, 'the two hundred As are not the interesting part')
  assert.ok(out.startsWith('…') && out.endsWith('…'), 'both ends were cut')
  // 40 before plus the hit plus 120 after, plus the two ellipses.
  assert.ok(out.length >= 160 && out.length <= 165)
})

test('a query with no hit falls back to the head instead of an empty string', () => {
  const text = 'A'.repeat(300)
  const out = centeredSnippet(text, 'mysql replication lag')
  assert.equal(out, 'A'.repeat(160) + '…')
})

test('a hit near the start does not open with an ellipsis', () => {
  const out = centeredSnippet('deploy key is in the vault ' + 'B'.repeat(300), 'deploy')
  assert.ok(out.startsWith('deploy key'), 'nothing was cut from the left, so nothing is claimed to be')
})

test('short text is returned whole', () => {
  assert.equal(centeredSnippet('the kettle boils slowly', 'kettle'), 'the kettle boils slowly')
  assert.equal(centeredSnippet('', 'kettle'), '')
})

test('firstHit is case-insensitive and picks the earliest term', () => {
  const terms = queryTerms('Vault Ops')
  assert.equal(firstHit('the vault was rotated', terms), 4)
  assert.equal(firstHit('nothing here', terms), -1)
})

test('160 is whole but 161 has explicit truncation and a strict 160-codepoint payload', () => {
  const whole = centeredSnippetWindow('甲'.repeat(160), 'missing')
  assert.equal(whole.body, '甲'.repeat(160))
  assert.deepEqual([whole.start, whole.end, whole.returnedChars, whole.totalChars, whole.truncated], [0, 160, 160, 160, false])
  const clipped = centeredSnippetWindow('甲'.repeat(161), 'missing')
  assert.equal(clipped.body, '甲'.repeat(160) + '…')
  assert.deepEqual([clipped.start, clipped.end, clipped.returnedChars, clipped.totalChars, clipped.truncated], [0, 160, 160, 161, true])
})

test('snippet windows count emoji as codepoints and never cut surrogate pairs', () => {
  const body = '😀'.repeat(200) + '部署条件' + '🚀'.repeat(200)
  const snippet = centeredSnippetWindow(body, '部署条件')
  assert.equal(snippet.start, 160)
  assert.equal(snippet.end, 320)
  assert.equal(snippet.returnedChars, 160)
  assert.equal(snippet.totalChars, 404)
  assert.equal(snippet.truncated, true)
  assert.equal(snippet.body, '…' + Array.from(body).slice(160, 320).join('') + '…')
  assert.equal(snippet.body.isWellFormed(), true)
  const head = centeredSnippet('😀'.repeat(169), 'missing')
  assert.equal(head, '😀'.repeat(160) + '…')
  assert.equal(Array.from(head).length, 161)
})

test('short Unicode text and empty windows report exact payload counts without ellipses', () => {
  const body = '😀尾部🚀'
  assert.equal(centeredSnippet(body, ''), body)
  const snippet = centeredSnippetWindow(body, '')
  assert.deepEqual([snippet.returnedChars, snippet.totalChars, snippet.truncated], [4, 4, false])
  assert.deepEqual(centeredSnippetWindow('', ''), { body: '', start: 0, end: 0, returnedChars: 0, totalChars: 0, truncated: false })
})
