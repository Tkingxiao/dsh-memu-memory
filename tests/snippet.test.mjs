import test from 'node:test'
import assert from 'node:assert/strict'

const { queryTerms, firstHit, centeredSnippet } = await import('../lib/snippet.js')

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
