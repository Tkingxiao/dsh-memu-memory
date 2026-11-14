import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-salience-'))
process.env.DSH_MEMU_HOME = home

const { salienceScore, mustCoverCandidates, candidateSeedEvents } = await import('../lib/private.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

// —— §6.1 回归：general/rp/默认参数下，中文文本得分与旧全域表逐条一致 ——
test('Chinese text scores identically to the legacy global table (general/rp/default)', () => {
  const legacy = new Map([
    ['说好周末拿给阿兰换伞骨，记得带过去。', 5],
    ['今天天气不错。', 2],
    ['她讨厌被叫错名字，更喜欢被称作阿兰。', 4],
    ['我欠你一顿饭，月底之前还。', 6],
    ['明天下午三点到期的账单别忘了。', 6],
    ['阿兰说他下周要接手这份工作。', 4],
    ['你好。', 0],
  ])
  for (const [text, expected] of legacy) {
    assert.equal(salienceScore(text), expected, `default: ${text}`)
    assert.equal(salienceScore(text, 'general'), expected, `general: ${text}`)
    assert.equal(salienceScore(text, 'rp'), expected, `rp: ${text}`)
  }
})

// —— §6.1 验收：同一段中英混排 coding 文本得分 ≥3 ——
test('mixed-script coding text clears the must-cover bar', () => {
  const text = '修复了 login bug 并部署到 staging，shipped v2.3.1'
  assert.ok(salienceScore(text, 'coding') >= 3)
  assert.ok(salienceScore(text, 'mixed') >= 3)
  assert.ok(salienceScore(text, 'mixed') >= salienceScore(text, 'coding'), 'mixed covers coding signals')
})

// —— §6.1 匹配规则：Latin 必须 \b 词边界，fix 不命中 fixture/prefix ——
test('Latin words respect word boundaries', () => {
  assert.equal(salienceScore('fixture list and prefix tree', 'coding'), 0)
  assert.equal(salienceScore('the environment and database', 'coding'), 0, 'env must not hit environment')
  assert.equal(salienceScore('fix the typo', 'coding'), 2, 'bare fix still hits')
})

// —— §6.1 匹配规则：大小写不敏感（FIX/Fixed 要命中）——
test('Latin patterns are case-insensitive', () => {
  assert.equal(salienceScore('FIX the fixture', 'coding'), 2, 'FIX hits, fixture does not')
  assert.equal(salienceScore('FIXED and shipped v2.3.1', 'coding'), 4)
  assert.equal(salienceScore('OPTIMIZE the build, renamed the config', 'coding'), 4)
})

// —— §6.1 验收：英文 coding 文本得分 ——
test('plain-English coding turns score above the must-cover bar', () => {
  assert.ok(salienceScore('fixed the login bug and shipped v2.3.1', 'coding') >= 3)
  assert.equal(salienceScore('Deployed the hotfix after a crash', 'coding'), 6)
  assert.ok(salienceScore('breaking change in the API config, root cause was a migration', 'coding') >= 3)
  assert.equal(salienceScore('we are still discussing the refactor plan', 'coding'), 1, 'weak-only signal scores 1')
})

// —— §6.1 rp 行：剧情词/英文同人词只属于 rp，general 不受影响 ——
test('rp extras score in rp and mixed but stay out of general', () => {
  assert.equal(salienceScore('人设和世界观都更新了', 'rp'), 2)
  assert.equal(salienceScore('人设和世界观都更新了', 'general'), 0)
  assert.equal(salienceScore('her persona is canon, out of character moment', 'rp'), 3)
  assert.equal(salienceScore('人设更新：她讨厌甜食，设定里不吃辣。', 'mixed'), 4, 'mixed keeps rp weak words')
  assert.ok(salienceScore('修复了人设相关的 bug，明天发布', 'mixed') >= salienceScore('修复了人设相关的 bug，明天发布', 'coding'), 'mixed keeps coding strong words')
})

// —— §6.1 匹配规则：未知域回退 general ——
test('unknown domains fall back to general', () => {
  const text = '生日快乐，记得还书。'
  assert.equal(salienceScore(text, 'totally-new-domain'), salienceScore(text, 'general'))
  assert.equal(salienceScore(text, 'totally-new-domain'), 6)
  assert.notEqual(salienceScore(text, 'coding'), salienceScore(text, 'general'), 'domains separate real signals')
})

// —— 回归：mustCoverCandidates 不传 domain 时与旧代码一致 ——
test('mustCoverCandidates without domain behaves like the legacy code', () => {
  const events = [
    { seq: 0, type: 'turn/start', data: {} },
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '说好周末拿给阿兰换伞骨，记得带过去。' }] } },
    { seq: 2, type: 'turn/end', data: {} },
    { seq: 3, type: 'turn/start', data: {} },
    { seq: 4, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '今天天气不错。' }] } },
    { seq: 5, type: 'turn/end', data: {} },
  ]
  const rows = mustCoverCandidates(events)
  assert.equal(rows.length, 1, 'a turn below minScore is not a must-cover candidate')
  assert.equal(rows[0].fromSeq, 0)
  assert.equal(rows[0].throughSeq, 2)
  assert.equal(rows[0].score, 5)
  assert.equal(rows[0].tag, '人物/关系')
})

// —— §6.1 缺口修复：英文 coding 会话的必写候选不再塌方 ——
test('English coding turns produce must-cover candidates under the coding domain', () => {
  const events = [
    { seq: 0, type: 'turn/start', data: {} },
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'fixed the login bug and shipped v2.3.1' }] } },
    { seq: 2, type: 'turn/end', data: {} },
    { seq: 3, type: 'turn/start', data: {} },
    { seq: 4, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'deploying to staging now, hotfix for the crash' }] } },
    { seq: 5, type: 'turn/end', data: {} },
  ]
  const rows = mustCoverCandidates(events, { domain: 'coding' })
  assert.equal(rows.length, 2)
  assert.ok(rows.every((row) => row.score >= 3))
  assert.deepEqual(rows.map((row) => row.fromSeq), [0, 3])
  assert.deepEqual(mustCoverCandidates(events), [], 'without domain the legacy gap still applies')
})

// —— 签名透传：candidateSeedEvents 按域保留回合，默认行为不变 ——
test('candidateSeedEvents honours domain without changing defaults', () => {
  const events = [
    { seq: 0, type: 'turn/start', data: {} },
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '今天天气不错。' }] } },
    { seq: 2, type: 'turn/end', data: {} },
    { seq: 3, type: 'turn/start', data: {} },
    { seq: 4, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'fixed the login bug and shipped v2.3.1' }] } },
    { seq: 5, type: 'turn/end', data: {} },
    { seq: 6, type: 'turn/start', data: {} },
    { seq: 7, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '嗯。' }] } },
    { seq: 8, type: 'turn/end', data: {} },
    { seq: 9, type: 'turn/start', data: {} },
    { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '先这样。' }] } },
    { seq: 11, type: 'turn/end', data: {} },
    { seq: 12, type: 'turn/start', data: {} },
    { seq: 13, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '回头再说。' }] } },
    { seq: 14, type: 'turn/end', data: {} },
  ]
  const general = candidateSeedEvents(events)
  assert.deepEqual(general.map((event) => event.seq), [0, 1, 2, 3, 4, 5], 'general keeps only the Chinese turn and its neighbour')
  const coding = candidateSeedEvents(events, { domain: 'coding' })
  assert.deepEqual(coding.map((event) => event.seq), [0, 1, 2, 3, 4, 5, 6, 7, 8], 'coding keeps the English turn and its neighbours')
})
