import test from 'node:test'
import assert from 'node:assert/strict'
import { buildEvidenceCorpus, groundEvidence, groundLinkNote, normalizeEvidenceText } from '../lib/curator-evidence.js'

const transcript = [
  'User: 我们把每周的部署窗口定在周四凌晨两点到四点，只允许灰度发布。',
  'Assistant: 好的，部署窗口已记录：周四 02:00-04:00，灰度 only。',
  'User: 另外我的 api_key 是 sk-abcdef1234567890abcdef，别外传。',
].join('\n')

const corpus = buildEvidenceCorpus([{ id: 's1', transcript }])

test('normalizeEvidenceText: NFKC + lowercase + strip whitespace/punctuation/symbols', () => {
  assert.equal(normalizeEvidenceText('部署窗口！Ａｐｉ＿Key…'), '部署窗口ａｐｉkey'.replace('ａｐｉ', 'api'))
  assert.equal(normalizeEvidenceText('  Hello, World! '), 'helloworld')
  assert.equal(normalizeEvidenceText('灰度-发布_v2'), '灰度发布v2')
})

test('groundEvidence: exact quote grounds; punctuation differences do not block', () => {
  const exact = groundEvidence([{ session_id: 's1', quote: '周四凌晨两点到四点' }], corpus)
  assert.equal(exact.status, 'grounded')
  assert.equal(exact.valid.length, 1)
  assert.deepEqual(exact.invalid, [])
  const punctuated = groundEvidence([{ session_id: 's1', quote: '部署窗口定在周四凌晨两点到四点，只允许灰度发布。' }], corpus)
  assert.equal(punctuated.valid.length, 1, 'punctuation is stripped on both sides before matching')
})

test('groundEvidence: a fabricated quote fails grounding', () => {
  const fabricated = groundEvidence([{ session_id: 's1', quote: '周五凌晨五点才部署呢' }], corpus)
  assert.equal(fabricated.valid.length, 0)
  assert.match(fabricated.invalid[0].reason, /not found in session/)
})

test('groundEvidence: session_id must belong to this curation', () => {
  const stranger = groundEvidence([{ session_id: 's-other', quote: '周四凌晨两点到四点' }], corpus)
  assert.equal(stranger.valid.length, 0)
  assert.match(stranger.invalid[0].reason, /not part of this curation/)
})

test('groundEvidence: quotes shorter than 6 normalized chars are rejected', () => {
  const short = groundEvidence([{ session_id: 's1', quote: '周四' }], corpus)
  assert.equal(short.valid.length, 0)
  assert.match(short.invalid[0].reason, /shorter than 6/)
})

test('groundEvidence: ellipsis quotes split into 2-3 segments, each >=4 chars and found', () => {
  const ok = groundEvidence([{ session_id: 's1', quote: '周四凌晨两点到四点……只允许灰度发布' }], corpus)
  assert.equal(ok.valid.length, 1, 'a two-segment ellipsis quote with both halves present grounds')
  const missing = groundEvidence([{ session_id: 's1', quote: '周四凌晨两点到四点……周五凌晨五点开工' }], corpus)
  assert.equal(missing.valid.length, 0)
  assert.match(missing.invalid[0].reason, /ellipsis segment not found/)
  const tooShort = groundEvidence([{ session_id: 's1', quote: '周四凌晨两点到四点……灰度' }], corpus)
  assert.equal(tooShort.valid.length, 0)
  assert.match(tooShort.invalid[0].reason, /ellipsis segment shorter than 4/)
  const tooMany = groundEvidence([{ session_id: 's1', quote: '我们……周四凌晨……灰度发布……记录' }], corpus)
  assert.equal(tooMany.valid.length, 0)
  assert.match(tooMany.invalid[0].reason, /2-3 segments/)
})

test('groundEvidence: quotes are redactSecrets-ed before storage', () => {
  // The transcript above contains a raw key; quoting it verbatim must fail the
  // substring check (the corpus is redacted), and the stored quote is redacted.
  const leaked = groundEvidence([{ session_id: 's1', quote: 'sk-abcdef1234567890abcdef' }], corpus)
  assert.equal(leaked.valid.length, 0, 'a raw secret is not in the redacted corpus, so it cannot ground')
  const mixed = groundEvidence([{ session_id: 's1', quote: 'api_key 是 sk-abcdef1234567890abcdef，别外传' }], corpus)
  assert.equal(mixed.valid.length, 0, 'the secret-bearing span cannot ground either')
  // Direct redaction check: groundEvidence never stores an unredacted secret.
  const unverifiedCorpus = buildEvidenceCorpus([{ id: 'x', transcript: 'token sk-zzzz1111222233334444 inside' }])
  const got = groundEvidence([{ session_id: 'x', quote: 'token sk-zzzz1111222233334444 inside' }], unverifiedCorpus)
  assert.equal(got.valid.length, 0, 'even a self-consistent corpus fails when the quote redacts away')
})

test('groundEvidence: no sessionCorpus means shape-checked unverified, not rejected', () => {
  const got = groundEvidence([{ session_id: 's9', quote: '完全没有出处的引用也可以' }], null)
  assert.equal(got.status, 'unverified')
  assert.equal(got.valid.length, 1)
  assert.deepEqual(got.invalid, [])
  const malformed = groundEvidence([{ session_id: '', quote: '完全没有出处的引用也可以' }], null)
  assert.equal(malformed.valid.length, 0)
  assert.match(malformed.invalid[0].reason, /missing session_id/)
})

test('buildEvidenceCorpus: ids and normalized transcripts; empty ids skipped', () => {
  const c = buildEvidenceCorpus([
    { id: 'a', transcript: '部署窗口！' },
    { id: '', transcript: 'ignored' },
    { id: 'b', text: 'second channel' },
  ])
  assert.deepEqual([...c.ids].sort(), ['a', 'b'])
  assert.equal(c.text.get('a'), '部署窗口')
  assert.equal(c.text.get('b'), 'secondchannel')
})

test('groundLinkNote: 8-500 chars and must contain one grounded quote verbatim', () => {
  const evidence = [{ sessionId: 's1', quote: '周四凌晨两点到四点' }]
  assert.equal(groundLinkNote('部署窗口与告警规则相关联', evidence).ok, false, 'note without the quote is rejected')
  const ok = groundLinkNote('两条记忆都源于部署窗口的约定：周四凌晨两点到四点', evidence)
  assert.equal(ok.ok, true, 'note quoting the evidence grounds')
  assert.equal(groundLinkNote('太短了', evidence).ok, false)
  assert.equal(groundLinkNote('x'.repeat(501), evidence).ok, false)
  assert.equal(groundLinkNote('八到五百之间的正常说明文字', []).ok, false, 'no evidence, no note grounding')
})
