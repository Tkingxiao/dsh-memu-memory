import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-lexicon-inject-'))
process.env.DSH_MEMU_HOME = home

const paths = await import('../lib/paths.js')
const state = await import('../lib/state.js')
const lexicon = await import('../lib/lexicon.js')
const inject = await import('../lib/inject.js')
const inbound = await import('../lib/inbound.js')
const { estTokens } = await import('../lib/budget.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

let serial = 0
function setupSession(name, { terms = [], memories = [] } = {}) {
  serial += 1
  const sessionId = `inject-${name}-${serial}`
  const cwd = path.join(home, `project-${name}-${serial}`)
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'rp' })
  if (memories.length) {
    const index = state.loadPrivateIndex(binding.libraryId)
    for (const { id, entry } of memories) index.entries[id] = entry
    state.savePrivateIndex(binding.libraryId, index)
  }
  for (const args of terms) lexicon.upsertLexiconTerm({ libraryId: binding.libraryId, ...args })
  // state.js 的 binding 不带 sessionId；测试里补上，方便把 binding/session 一起传。
  return { ...binding, sessionId }
}

function agentFor(binding) {
  return { session: { header: { id: binding.sessionId, cwd: path.join(home, 'cwd-' + binding.sessionId), agentPreset: 'rp', origin: 'user' } } }
}

function userMessage(id, text) {
  return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

function pluginTexts(out) {
  return out.messages
    .filter(message => message?.source?.kind === 'plugin:dsh-memu-memory')
    .map(message => Array.isArray(message.content) ? message.content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : String(message.content || ''))
}

function lexFile(libraryId) {
  return path.join(home, 'lexicon', `${libraryId}.json`)
}

function setStrength(libraryId, term, strength) {
  const lex = lexicon.loadLexicon(libraryId)
  for (const entry of Object.values(lex.terms)) {
    if (entry.normalizedTerm === lexicon.normalizeLexeme(term)) entry.strength = strength
  }
  paths.writeJson(lexFile(libraryId), lex)
}

// ---- 匹配流水线（§3.1） ----

test('exact layer: term containment and whole-message equality both hit as exact-term', () => {
  const binding = setupSession('exact', { terms: [{ term: '糖刀', kind: 'meme', meaning: '表面发糖、实际虐心' }] })
  const hits = lexicon.matchLexiconHits(binding.libraryId, '这段太糖刀了', binding.memoryContext)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].kindOfHit, 'exact-term')
  assert.equal(hits[0].term, '糖刀')
  assert.equal(hits[0].meaning, '表面发糖、实际虐心')
  const whole = lexicon.matchLexiconHits(binding.libraryId, '糖刀', binding.memoryContext)
  assert.equal(whole[0].kindOfHit, 'exact-term')
})

test('exact layer: aliases hit as exact-alias and fold onto the same term', () => {
  const binding = setupSession('alias', { terms: [{ term: '糖刀', kind: 'meme', meaning: '表面发糖', aliases: ['糖里藏刀'] }] })
  const hits = lexicon.matchLexiconHits(binding.libraryId, '这不就是糖里藏刀吗', binding.memoryContext)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].kindOfHit, 'exact-alias')
  assert.equal(hits[0].term, '糖刀')
})

test('dice fallback: a fuzzy variant inside the prefix bucket hits with score >= threshold; unrelated text does not', () => {
  const binding = setupSession('dice', { terms: [{ term: '糖刀文学', kind: 'term', meaning: '又甜又虐的写法' }] })
  const hits = lexicon.matchLexiconHits(binding.libraryId, '这段糖刀文雪啊', binding.memoryContext)
  assert.equal(hits.length, 1, '糖刀文雪 vs 糖刀文学 shares the 糖刀 bucket and dices to 2/3')
  assert.equal(hits[0].kindOfHit, 'dice')
  assert.ok(hits[0].score >= lexicon.LEXICON_DICE_THRESHOLD)
  assert.deepEqual(lexicon.matchLexiconHits(binding.libraryId, '今天天气不错', binding.memoryContext), [])
})

test('dice fallback: a typo at the end of a long message still recalls the term (windows by hit count, not order)', () => {
  const binding = setupSession('dice-tail', { terms: [{ term: '糖刀文学', kind: 'term', meaning: '又甜又虐的写法' }] })
  // 40 字闲聊 + 末尾错字变体：旧实现按出现顺序只取前 16 个不同窗口，糖刀这个
  // 前缀窗口落在第 17 个之后，模糊层收不到候选；现在窗口按命中词条数排序。
  const chatter = '今晚的雾夜灯桥边茶铺霜露未散他忽然提起那些旧梗台词接得毫无痕迹我们笑作一团后来月影移过柳岸'
  const text = `${chatter}糖刀文雪`
  const normalized = lexicon.normalizeLexeme(text)
  const windows = []
  for (let i = 0; i + 2 <= normalized.length; i++) {
    const key = normalized.slice(i, i + 2)
    if (!windows.includes(key)) windows.push(key)
  }
  assert.ok(!windows.slice(0, lexicon.LEXICON_MAX_BUCKETS).includes('糖刀'),
    'fixture guard: the matching window must sit beyond the old 16-window cut')
  const hits = lexicon.matchLexiconHits(binding.libraryId, text, binding.memoryContext)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].term, '糖刀文学')
  assert.equal(hits[0].kindOfHit, 'dice')
  assert.ok(hits[0].score >= lexicon.LEXICON_DICE_THRESHOLD)
})

test('active and restored terms match; archived and rejected never match or search', () => {
  const binding = setupSession('status', {})
  const lib = binding.libraryId
  // 用户写入直接 active（没有审核门）。
  const archivedSeed = lexicon.upsertLexiconTerm({ libraryId: lib, term: '归档词', kind: 'term', meaning: '会被归档' })
  assert.equal(archivedSeed.term.status, 'active')
  assert.equal(lexicon.matchLexiconHits(lib, '来点归档词', binding.memoryContext).length, 1)
  // 归档：退出匹配/注入/检索/锚点摘要。
  lexicon.archiveLexiconTerm({ libraryId: lib, termId: archivedSeed.term.termId })
  assert.deepEqual(lexicon.matchLexiconHits(lib, '来点归档词', binding.memoryContext), [], 'archived terms leave the matching pipeline')
  assert.deepEqual(lexicon.searchLexicon({ libraryId: lib, query: '归档词', memoryContext: binding.memoryContext }), [], 'archived terms are not searchable')
  assert.ok(!lexicon.visibleLexiconTerms(lib, binding.memoryContext).some(entry => entry.term === '归档词'))
  assert.ok(!lexicon.lexiconAnchorSummary(lib, {}).lines.join('\n').includes('归档词'), 'archived terms stay out of the anchor summary')
  // 恢复：重新参与注入与检索。
  lexicon.restoreLexiconTerm({ libraryId: lib, termId: archivedSeed.term.termId })
  assert.equal(lexicon.matchLexiconHits(lib, '来点归档词', binding.memoryContext).length, 1, 'restored terms rejoin injection')
  assert.equal(lexicon.searchLexicon({ libraryId: lib, query: '归档词', memoryContext: binding.memoryContext }).length, 1)
  // 模型提案同样直接 active，没有 pending / 审核步骤。
  const proposal = lexicon.upsertLexiconTerm({ libraryId: lib, term: '提案词', kind: 'term', meaning: '直接生效', source: 'model-proposal' })
  assert.equal(proposal.term.status, 'active', 'model proposals are active immediately')
  assert.equal(lexicon.matchLexiconHits(lib, '来点提案词', binding.memoryContext).length, 1)
  // rejected 是内部墓碑（没有公开 API 产出它）：永不匹配、永不检索。
  const tombstone = lexicon.upsertLexiconTerm({ libraryId: lib, term: '墓碑词', kind: 'term', meaning: '内部墓碑' })
  const file = lexFile(lib)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  raw.terms[tombstone.term.termId].status = 'rejected'
  paths.writeJson(file, raw)
  assert.deepEqual(lexicon.matchLexiconHits(lib, '来点墓碑词', binding.memoryContext), [], 'rejected tombstones never match')
  assert.deepEqual(lexicon.searchLexicon({ libraryId: lib, query: '墓碑词', memoryContext: binding.memoryContext }), [], 'rejected tombstones never search')
  assert.equal(lexicon.matchLexiconHits(lib, '来点归档词', binding.memoryContext).length, 1, 'the restored term still matches')
})

test('stableRank: sensitive trigger > exact term > dice, then strength×confidence, deterministic across runs', () => {
  const binding = setupSession('rank', { terms: [
    { term: '敏感词甲', kind: 'trigger', meaning: '触发' },     // trigger 默认 sensitive
    { term: '普通词乙', kind: 'meme', meaning: '普通' },
    { term: '糖刀文学', kind: 'term', meaning: '模糊' },
  ] })
  const lib = binding.libraryId
  setStrength(lib, '敏感词甲', 0.1)
  setStrength(lib, '普通词乙', 0.9)
  setStrength(lib, '糖刀文学', 0.5)
  const hits = lexicon.matchLexiconHits(lib, '敏感词甲和普通词乙加糖刀文雪', binding.memoryContext)
  assert.deepEqual(hits.map(hit => hit.term), ['敏感词甲', '普通词乙', '糖刀文学'],
    'sensitive trigger first, then exact by strength, dice last — despite strength order')
  const again = lexicon.matchLexiconHits(lib, '敏感词甲和普通词乙加糖刀文雪', binding.memoryContext)
  assert.deepEqual(again, hits, 'the ranking is a pure function of the data, not of time or iteration order')
})

test('stableRank: final tie-break is the lexicographic id, never the clock', () => {
  const binding = setupSession('tie', { terms: [
    { term: '双生甲', kind: 'term', meaning: '同分一' },
    { term: '双生乙', kind: 'term', meaning: '同分二' },
  ] })
  // 两个词条完全同分（strength/confidence/updatedAt 手工抹平）：顺序只能由 termId 决定。
  const lex = lexicon.loadLexicon(binding.libraryId)
  for (const entry of Object.values(lex.terms)) {
    entry.strength = 0.5
    entry.confidence = 0.5
    entry.updatedAt = '2026-01-01T00:00:00.000Z'
  }
  paths.writeJson(lexFile(binding.libraryId), lex)
  const hits = lexicon.matchLexiconHits(binding.libraryId, '双生甲和双生乙都在这句话里', binding.memoryContext)
  assert.equal(hits.length, 2)
  assert.deepEqual(hits.map(hit => hit.termId), [...hits.map(hit => hit.termId)].sort((a, b) => a.localeCompare(b)))
  const onceMore = lexicon.matchLexiconHits(binding.libraryId, '双生甲和双生乙都在这句话里', binding.memoryContext)
  assert.deepEqual(onceMore.map(hit => hit.termId), hits.map(hit => hit.termId))
})

// ---- 冷却与回合预算（§3.3） ----

test('cooldownAndBudget: at most LEXICON_MAX_PER_TURN terms per turn, token budget respected', () => {
  const binding = setupSession('budget', { terms: [
    { term: '预算词甲', kind: 'term', meaning: '甲' },
    { term: '预算词乙', kind: 'term', meaning: '乙' },
    { term: '预算词丙', kind: 'term', meaning: '丙' },
  ] })
  setStrength(binding.libraryId, '预算词甲', 0.9)
  setStrength(binding.libraryId, '预算词乙', 0.6)
  setStrength(binding.libraryId, '预算词丙', 0.3)
  lexicon.lexiconCooldownStore.clear()
  const hits = lexicon.matchLexiconHits(binding.libraryId, '预算词甲预算词乙预算词丙', binding.memoryContext)
  assert.equal(hits.length, 3)
  const { selected, onCooldown } = lexicon.cooldownAndBudget(hits, binding.sessionId, 10_000)
  assert.equal(selected.length, lexicon.LEXICON_MAX_PER_TURN)
  assert.deepEqual(selected.map(hit => hit.term), ['预算词甲', '预算词乙'], 'highest strength first; the third waits for the next turn')
  assert.deepEqual(onCooldown, [])
  // 预算小到一行都放不下：一个都不选，hits 原样保留给 candidate 计数。
  const squeezed = lexicon.cooldownAndBudget(hits, binding.sessionId, 3)
  assert.deepEqual(squeezed.selected, [])
})

test('cooldown: within 30 minutes a term is counted as candidate but never injected again', () => {
  const binding = setupSession('cooldown', { terms: [{ term: '冷却词', kind: 'term', meaning: '含义' }] })
  lexicon.lexiconCooldownStore.clear()
  const lib = binding.libraryId
  // loadLexicon 返回原始 terms 表，termId 就是键名。
  const entryId = () => Object.keys(lexicon.loadLexicon(lib).terms)[0]

  const first = inject.injectLexiconTurn({ binding, sessionId: binding.sessionId, userTexts: ['这句话提到冷却词'], tokenBudget: 10_000 })
  assert.equal(first.selected.length, 1)
  inject.commitLexiconTurn({ libraryId: lib, sessionId: binding.sessionId, hits: first.hits, selected: first.selected })
  assert.ok(lexicon.lexiconCooldownStore.get(binding.sessionId)?.has(entryId()), 'the cooldown store remembers the injection per binding')

  const second = inject.injectLexiconTurn({ binding, sessionId: binding.sessionId, userTexts: ['冷却词又出现了'], tokenBudget: 10_000 })
  assert.equal(second.text, '', 'no B-channel text while cooling down')
  assert.equal(second.selected.length, 0)
  assert.equal(second.onCooldown.length, 1)
  inject.commitLexiconTurn({ libraryId: lib, sessionId: binding.sessionId, hits: second.hits, selected: second.selected })

  const entry = lexicon.loadLexicon(lib).terms[entryId()]
  assert.deepEqual(entry.hitCounts, { candidate: 2, injection: 1, query: 0 },
    'cooldown suppresses injection only; the candidate still counts')
  assert.ok(lexicon.lexiconOnCooldown(binding.sessionId, entryId()))
  assert.equal(lexicon.LEXICON_RECALL_COOLDOWN_MINUTES, 30)
  assert.equal(lexicon.LEXICON_MAX_PER_TURN, 2)
})

test('cooldown does not leak across bindings', () => {
  const binding = setupSession('cooldown-scope', { terms: [{ term: '跨会话词', kind: 'term', meaning: '含义' }] })
  lexicon.lexiconCooldownStore.clear()
  const first = inject.injectLexiconTurn({ binding, sessionId: binding.sessionId, userTexts: ['跨会话词'], tokenBudget: 10_000 })
  inject.commitLexiconTurn({ libraryId: binding.libraryId, sessionId: binding.sessionId, hits: first.hits, selected: first.selected })
  const other = inject.injectLexiconTurn({ binding, sessionId: 'another-binding', userTexts: ['跨会话词'], tokenBudget: 10_000 })
  assert.equal(other.selected.length, 1, 'another session has its own cooldown window')
})

// ---- 锚点摘要（通道 A） ----

test('buildLexiconAnchor packs to the 300-token hard cap and drops the weakest lines first', () => {
  const terms = []
  for (let i = 0; i < 9; i++) terms.push({ term: `词条甲乙丙${i}`, kind: 'term', meaning: '长'.repeat(400) })
  const binding = setupSession('anchor-cap', { terms })
  const lib = binding.libraryId
  const lex = lexicon.loadLexicon(lib)
  const ids = Object.keys(lex.terms)
  ids.forEach((id, i) => { lex.terms[id].strength = (i + 1) / ids.length })
  paths.writeJson(lexFile(lib), lex)

  // 300 硬上限：8 条上限 + 超预算丢尾部（最弱的一条先丢）。每条 meaning 截到
  // 80 字 ≈ 86 token，300 的预算装得下 3 条。
  const full = inject.buildLexiconAnchor(binding, binding.sessionId, 300)
  assert.ok(full.text.length > 0)
  assert.ok(estTokens(full.text) <= 300, `anchor section must fit 300 tokens, got ${estTokens(full.text)}`)
  assert.ok(!full.text.includes('词条甲乙丙0'), 'the weakest term is the first dropped')
  const summary = lexicon.lexiconAnchorSummary(lib, {})
  assert.equal(summary.lines.length, 8, 'at most 8 summary lines even with 9 candidates')
  assert.match(summary.lines[0], /词条甲乙丙8/, 'strongest first')

  // 更小的预算：只有最强的几行能留下。
  const tight = inject.buildLexiconAnchor(binding, binding.sessionId, 200)
  assert.ok(estTokens(tight.text) <= 200, `tight section must fit 200 tokens, got ${estTokens(tight.text)}`)
  assert.ok(tight.text.includes('词条甲乙丙8'))
  assert.ok(!tight.text.includes('词条甲乙丙2'))
  // 预算为 0：整节放弃，不挤占记忆预算。
  assert.deepEqual(inject.buildLexiconAnchor(binding, binding.sessionId, 0), { text: '', ids: [] })
})

test('the anchor section lists sensitive triggers separately with cap 2', () => {
  const terms = []
  for (let i = 0; i < 4; i++) terms.push({ term: `触发词组${i}`, kind: 'trigger', meaning: `触发${i}` })
  terms.push({ term: '普通展示词', kind: 'term', meaning: '普通' })
  const binding = setupSession('anchor-sensitive', { terms })
  const lib = binding.libraryId
  const lex = lexicon.loadLexicon(lib)
  // 拉开梯度，避免同分 tie-break 让"前两名"变成随机对。
  const strengths = { 触发词组0: 0.9, 触发词组1: 0.8, 触发词组2: 0.7, 触发词组3: 0.6, 普通展示词: 0.1 }
  for (const entry of Object.values(lex.terms)) entry.strength = strengths[entry.term] ?? 0.5
  paths.writeJson(lexFile(lib), lex)
  const section = inject.buildLexiconAnchor(binding, binding.sessionId, 300)
  assert.match(section.text, /\[lexicon · 敏感词\]/)
  const sensitivePart = section.text.split('[lexicon · 敏感词]')[1] || ''
  assert.ok(sensitivePart.includes('触发词组0') && sensitivePart.includes('触发词组1'))
  assert.ok(!sensitivePart.includes('触发词组2'), 'at most 2 sensitive triggers in the anchor')
  assert.ok(section.text.includes('普通展示词'), 'normal terms still appear in the main lines')
})

// ---- 端到端：injectForStep（原生用户消息路径） ----

test('injectForStep appends the anchor lexicon summary and the B-channel hit block', async () => {
  const binding = setupSession('e2e', {
    terms: [
      { term: '糖刀', kind: 'meme', meaning: '表面发糖、实际虐心' },
      { term: '锚点常驻词', kind: 'term', meaning: '常驻含义' },
    ],
    memories: [{
      id: 'mem-pin',
      entry: {
        track: 'memory', layer: 'must_remember', title: '凉茶', content: '今天他走的时候没看我。',
        status: 'active', pinSource: 'user_explicit', pinReason: '记得', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    }],
  })
  const agent = agentFor(binding)
  // 真实用户消息先走 inbound journal（与宿主事件路径同构），再进入决策消息。
  inbound.ingestInboundBatch({
    sessionId: binding.sessionId, session: agent.session, ctx: null,
    batch: { type: inbound.INBOUND_TYPE, version: 1, producer: 'host.user', batchId: 'user:u1',
      messages: [{ id: 'u1', role: 'user', context: {}, content: [{ type: 'text', text: '这段太糖刀了' }] }] },
  })
  const decision = { kind: 'enter', messages: [userMessage('u1', '这段太糖刀了')] }
  const out = await inject.injectForStep({ agent, decision, turn: 1, step: 1, signal: { aborted: false }, log: () => {}, ctx: null })
  const texts = pluginTexts(out)
  assert.equal(texts.length, 1, 'one plugin message carries anchor + lexicon')
  assert.match(texts[0], /===== memory anchor/)
  assert.match(texts[0], /凉茶/, 'memory recall itself is untouched')
  assert.match(texts[0], /\[lexicon · 词典\]/, 'anchor lexicon summary rides the anchor block')
  assert.match(texts[0], /锚点常驻词/)
  assert.match(texts[0], /<memory-lexicon>/, 'the B-channel hit block is in the same message')
  assert.match(texts[0], /糖刀」：表面发糖、实际虐心/)

  // 注入记账：candidate + injection 各一次，冷却已记。
  const lib = binding.libraryId
  const [entryId, entry] = Object.entries(lexicon.loadLexicon(lib).terms).find(([, t]) => t.normalizedTerm === '糖刀')
  assert.deepEqual(entry.hitCounts, { candidate: 1, injection: 1, query: 0 })
  assert.ok(lexicon.lexiconOnCooldown(binding.sessionId, entryId))
})

test('the second turn inside the cooldown window injects no lexicon block but still counts candidates', async () => {
  const binding = setupSession('e2e-cooldown', { terms: [{ term: '冷却验证词', kind: 'term', meaning: '含义' }] })
  const agent = agentFor(binding)
  const send = async (id, text, turn) => {
    inbound.ingestInboundBatch({
      sessionId: binding.sessionId, session: agent.session, ctx: null,
      batch: { type: inbound.INBOUND_TYPE, version: 1, producer: 'host.user', batchId: `user:${id}`,
        messages: [{ id, role: 'user', context: {}, content: [{ type: 'text', text }] }] },
    })
    return inject.injectForStep({ agent, decision: { kind: 'enter', messages: [userMessage(id, text)] }, turn, step: 1, signal: { aborted: false }, log: () => {}, ctx: null })
  }
  await send('c1', '关于冷却验证词', 1)
  const second = await send('c2', '再说一次冷却验证词', 2)
  const texts = pluginTexts(second)
  assert.ok(!texts.some(text => text.includes('<memory-lexicon>')), 'cooldown blocks the repeat injection')
  const entry = Object.values(lexicon.loadLexicon(binding.libraryId).terms)[0]
  assert.deepEqual(entry.hitCounts, { candidate: 2, injection: 1, query: 0 })
})

// ---- 端到端：inbound 批次路径（桥接 producer，无原生用户消息的回合） ----

test('the B channel also rides the real inbound batch path', async () => {
  const binding = setupSession('e2e-bridge', { terms: [{ term: '糖刀', kind: 'meme', meaning: '表面发糖、实际虐心' }] })
  const agent = agentFor(binding)
  inbound.ingestInboundBatch({
    sessionId: binding.sessionId, session: agent.session, ctx: null,
    batch: { type: inbound.INBOUND_TYPE, version: 1, producer: 'friend-app', batchId: 'bridge:1',
      messages: [{ id: 'bridge-1', role: 'user', context: {}, content: [{ type: 'text', text: '这段太糖刀了' }] }] },
  })
  const out = await inject.injectForStep({ agent, decision: { kind: 'enter', messages: [] }, turn: 1, step: 1, signal: { aborted: false }, log: () => {}, ctx: null })
  const texts = pluginTexts(out)
  assert.equal(texts.length, 1)
  assert.match(texts[0], /<memory-lexicon>/)
  assert.match(texts[0], /表面发糖、实际虐心/)
  const entry = Object.values(lexicon.loadLexicon(binding.libraryId).terms)[0]
  assert.deepEqual(entry.hitCounts, { candidate: 1, injection: 1, query: 0 })
})

test('plugin notices, tool results and assistant text are not lexicon text sources', async () => {
  const binding = setupSession('e2e-sources', { terms: [{ term: '糖刀', kind: 'meme', meaning: '表面发糖' }] })
  const agent = agentFor(binding)
  // 决策消息里只有插件消息与 assistant 自言自语；没有真实用户消息。
  const pluginNotice = {
    id: 'notice-1', role: 'user', source: { kind: 'plugin:dsh-memu-memory' },
    content: [{ type: 'text', text: '糖刀糖刀糖刀' }],
  }
  const assistant = {
    id: 'a1', role: 'assistant', content: [{ type: 'text', text: '我自己提到了糖刀' }],
  }
  const out = await inject.injectForStep({ agent, decision: { kind: 'enter', messages: [pluginNotice, assistant] }, turn: 1, step: 1, signal: { aborted: false }, log: () => {}, ctx: null })
  const texts = pluginTexts(out)
  assert.ok(!texts.some(text => text.includes('<memory-lexicon>')), 'no lexicon hit may come from non-user text')
  const entry = Object.values(lexicon.loadLexicon(binding.libraryId).terms)[0]
  assert.deepEqual(entry.hitCounts, { candidate: 0, injection: 0, query: 0 })
})

// ---- fail-open（§3.3） ----

test('a broken lexicon degrades with logger.warn + lastRecallError and never blocks memory recall', async () => {
  const binding = setupSession('failopen', {
    terms: [{ term: '糖刀', kind: 'meme', meaning: '表面发糖' }],
    memories: [{
      id: 'mem-pin',
      entry: {
        track: 'memory', layer: 'must_remember', title: '凉茶', content: '今天他走的时候没看我。',
        status: 'active', pinSource: 'user_explicit', pinReason: '记得', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    }],
  })
  // 词典文件损坏：loadLexicon 抛 LEXICON_CORRUPT，注入链必须吞掉并继续。
  fs.writeFileSync(lexFile(binding.libraryId), '{ this is not json')
  const warnings = []
  const agent = agentFor(binding)
  inbound.ingestInboundBatch({
    sessionId: binding.sessionId, session: agent.session, ctx: null,
    batch: { type: inbound.INBOUND_TYPE, version: 1, producer: 'host.user', batchId: 'user:u1',
      messages: [{ id: 'u1', role: 'user', context: {}, content: [{ type: 'text', text: '这段太糖刀了' }] }] },
  })
  const out = await inject.injectForStep({
    agent, decision: { kind: 'enter', messages: [userMessage('u1', '这段太糖刀了')] },
    turn: 1, step: 1, signal: { aborted: false },
    log: (message) => warnings.push(String(message)), ctx: null,
  })
  const texts = pluginTexts(out)
  assert.equal(texts.length, 1, 'the plugin message still exists')
  assert.match(texts[0], /===== memory anchor/, 'memory recall output survived')
  assert.match(texts[0], /凉茶/, 'the pinned memory is still injected')
  assert.ok(!texts[0].includes('<memory-lexicon>'), 'no lexicon block when the lexicon is broken')
  assert.ok(warnings.some(w => /lexicon degraded/.test(w)), 'the failure is logged, not swallowed silently')
  const current = state.getSessionBinding(binding.sessionId)
  assert.match(String(current.lastRecallError || ''), /lexicon/, 'binding.lastRecallError records the degradation')
  // 记忆召回的错误面没有被词典污染成"召回失败"。
  assert.ok(!/private recall failed/.test(String(current.lastRecallError || '')))
})

test('a corrupt lexicon still surfaces a typed error for readers', () => {
  const binding = setupSession('failopen-read', {})
  fs.writeFileSync(lexFile(binding.libraryId), 'not json at all')
  assert.throws(() => lexicon.loadLexicon(binding.libraryId), (error) => error.code === 'LEXICON_CORRUPT')
})
