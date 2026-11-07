// 词典 revision-keyed 内存索引（§10 P1）的性能基准与等价性对拍。
//
// 两件事：
//   1. N=5000 词条时 matchLexiconHits 在 ~100 字用户消息上的耗时 p95 < 20ms。
//      这个数字是**本机回归上界，不是 SLA**：绝对值随机器/Node 版本浮动，断言的
//      意义是「索引化之后仍远低于注入路径的一次预算粒度」，防止有人把每次匹配
//      改回全量 parse / 全表重建桶。预热 5 轮后测 50 轮取 p95。
//   2. 索引化实现与「无缓存直接全量扫」的参照实现在 100 个随机 query 上逐字段
//      一致（matchLexiconHits / searchLexicon / visibleLexiconTerms 各对拍一组）。
//      参照实现是改造前算法的忠实拷贝（见本文件底部），刻意独立于 lib/lexicon.js
//      的内部实现，防止两边一起改错。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-lexicon-perf-'))
process.env.DSH_MEMU_HOME = home

const paths = await import('../lib/paths.js')
const state = await import('../lib/state.js')
const lexicon = await import('../lib/lexicon.js')
const inject = await import('../lib/inject.js')
const { estTokens } = await import('../lib/budget.js')
const { bigrams, dice } = await import('../lib/text-similarity.js')
const { contextVisible } = await import('../lib/context.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

// ---- 程序化词条生成：term/aliases/examples 多样，status/scope/敏感度有分布 ----

const CJK = '糖刀月影雾灯茶雪夜星风花竹鹤泉溪桥柳岸莺燕蝶霜露雷霆云霞暮晓辰舟'.split('')
const LATIN = ['teatime', 'moonfall', 'embers', 'willow', 'cinder', 'harbor', 'lantern', 'quietus']

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 生成 count 条词条的 terms 表（直接写盘，绕过 5000 次锁内 CAS——基准只关心读路径）。 */
function generateTerms(count, seed) {
  const rand = mulberry32(seed)
  const pick = () => CJK[Math.floor(rand() * CJK.length)]
  const used = new Set()
  const terms = {}
  for (let i = 0; i < count; i++) {
    let term
    do {
      if (i % 5 === 0) {
        term = LATIN[i % LATIN.length] + '-' + i
      } else {
        // 30^4 ≈ 81 万组合空间：5000 条只有零星碰撞，do/while 消费 rand 重画即可。
        term = pick() + pick() + pick() + pick()
      }
    } while (used.has(term))
    used.add(term)
    const normalizedTerm = lexicon.normalizeLexeme(term)
    const aliases = []
    const aliasCount = i % 4 === 0 ? 2 : i % 3 === 0 ? 1 : 0
    for (let a = 0; a < aliasCount; a++) {
      const alias = term.slice(0, 2) + CJK[(i + a * 9 + 3) % CJK.length] + (a ? '儿' : '子')
      if (lexicon.normalizeLexeme(alias) !== normalizedTerm) aliases.push(alias)
    }
    const kind = ['term', 'slang', 'meme', 'trigger'][i % 4]
    const status = i % 50 === 0 ? 'pending' : i % 47 === 0 ? 'rejected' : i % 97 === 0 ? 'archived' : 'active'
    const meaning = '压测词条的含义说明，用来撑起锚点摘要与 B 通道的真实 token 成本测量。'.repeat(1) + `编号${i}。`
    const context = i % 7 === 0 ? { worldId: `w${i % 3}` } : {}
    terms[`lex-perf-${i}`] = {
      term,
      normalizedTerm,
      kind,
      meaning,
      usage: i % 2 ? `谈${term}的时候用` : '',
      aliases,
      normalizedAliases: aliases.map(lexicon.normalizeLexeme).filter(Boolean),
      examples: i % 3 === 0 ? [`这句话里有${term}`] : [],
      context,
      visibility: 'shared',
      sensitivity: kind === 'trigger' ? 'sensitive' : 'normal',
      strength: Math.round(((i * 0.6180339887) % 1) * 100) / 100,
      confidence: 0.5 + (i % 5) / 10,
      status,
      source: 'user',
      evidence: [],
      fingerprint: `fp-${i}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      hitCounts: { candidate: 0, injection: 0, query: 0 },
      lastInjectedAt: null,
    }
  }
  return terms
}

function writePerfLibrary(libraryId, terms) {
  paths.writeJson(path.join(home, 'lexicon', `${libraryId}.json`), {
    version: 1,
    revision: 1,
    libraryId,
    terms,
    rejected: {},
  })
}

const perfLibrary = state.createLibrary({ name: 'lexicon-perf', cwd: path.join(home, 'perf') })
const PERF_TERMS = generateTerms(5000, 20261031)
writePerfLibrary(perfLibrary.id, PERF_TERMS)
const activeTerms = Object.values(PERF_TERMS).filter(entry => entry.status === 'active' && !entry.context.worldId)
const FILLER = '今晚的雾夜灯桥边茶铺霜露未散他忽然提起那些旧梗台词接得毫无痕迹我们笑作一团后来月影移过柳岸鹤鸣惊起溪桥下打盹的猫谁也没接话只是把茶续上灯花爆了一下'
// ~100 字消息：埋 2 个精确词面 + 1 个只差末字的 dice 变体，其余是共享前缀池的填充。
const PERF_MESSAGE = `${activeTerms[0].term}这句真是${activeTerms[1].term}，${FILLER.slice(0, 30)}${activeTerms[2].term.slice(0, -1)}雪，${FILLER.slice(30)}`

// ---- 1) N=5k 基准：p95 < 20ms（回归上界，不是 SLA） ----

test('matchLexiconHits at N=5000: 50-round CPU batch under the regression bound', () => {
  // 预热：首访触发建索引（一次全量 parse + 派生），其后是 stat 比对 + 缓存命中。
  for (let i = 0; i < 5; i++) lexicon.matchLexiconHits(perfLibrary.id, PERF_MESSAGE, {})
  // 断言用「50 轮 CPU 总量」而非墙钟或单次 CPU：npm test 并行跑十几个文件时机器
  // 满载，墙钟被调度抖动顶爆（实测 2.15ms 单跑 → 满载 >20ms）；而 Windows 的
  // CPU 计时器有 ~16ms 粒度，单次采样会量化成 0/16ms 跳变。批总量把量化误差
  // 摊薄且与并行负载无关（CPU 时间 = 真实计算量）。索引化实现 50 轮 CPU 约几毫秒；
  // 若有人改回全量 parse/全表重建，单轮就要 100ms+，批总量轻松越界。墙钟只打印。
  const wallSamples = []
  const before = process.cpuUsage()
  for (let i = 0; i < 50; i++) {
    const wallStart = performance.now()
    const hits = lexicon.matchLexiconHits(perfLibrary.id, PERF_MESSAGE, {})
    wallSamples.push(performance.now() - wallStart)
    assert.ok(Array.isArray(hits))
  }
  const used = process.cpuUsage(before)
  const batchCpuMs = (used.user + used.system) / 1000
  wallSamples.sort((a, b) => a - b)
  const pick = (samples, q) => samples[Math.min(samples.length - 1, Math.max(0, Math.ceil(samples.length * q) - 1))]
  const wallP95 = pick(wallSamples, 0.95)
  const hits = lexicon.matchLexiconHits(perfLibrary.id, PERF_MESSAGE, {})
  console.log(`[lexicon-perf] N=5000, message=${[...PERF_MESSAGE].length} chars, hits=${hits.length}; `
    + `cpu batch(50 rounds)=${batchCpuMs.toFixed(2)}ms avg=${(batchCpuMs / 50).toFixed(3)}ms/call `
    + `wall p95=${wallP95.toFixed(2)}ms `
    + `(CPU batch is the asserted metric — quantization-amortized and load-independent; regression upper bound, not an SLA)`)
  assert.ok(hits.length >= 2, 'the message embeds exact terms, the pipeline must see them')
  assert.ok(batchCpuMs < 1000, `50-round cpu batch ${batchCpuMs.toFixed(2)}ms must stay under the 1000ms regression upper bound (indexed implementation sits in single-digit ms)`)
})

// ---- 2) 等价性对拍：索引化实现 vs 无缓存全量扫参照实现 ----

const diffLibrary = state.createLibrary({ name: 'lexicon-diff', cwd: path.join(home, 'diff') })
const DIFF_TERMS = generateTerms(260, 777)
writePerfLibrary(diffLibrary.id, DIFF_TERMS)
// 参照实现用的快照一次性取好：match/visible 不写盘，search 的记账写盘只动
// hitCounts，对拍投影不包含它。
const DIFF_DATA = lexicon.loadLexicon(diffLibrary.id).terms

test('matchLexiconHits agrees with the naive full-scan reference on 100 random queries', () => {
  const rand = mulberry32(424242)
  const termList = Object.values(DIFF_TERMS)
  const queries = []
  for (let i = 0; i < 100; i++) {
    const entry = termList[Math.floor(rand() * termList.length)]
    const mode = i % 10
    if (mode === 0) queries.push(entry.term)
    else if (mode === 1) queries.push(`「${entry.term}」！！`)
    else if (mode === 2) queries.push(entry.term.slice(1, -1)) // term 的中段子串
    else if (mode === 3) queries.push(entry.term.slice(0, -1) + CJK[i % CJK.length]) // dice 变体
    else if (mode === 4) queries.push(entry.normalizedAliases[0] || entry.term)
    else if (mode === 5) queries.push(FILLER.slice(i % 10) + entry.term + FILLER.slice(0, i % 7))
    else if (mode === 6) queries.push(FILLER.slice((i * 3) % 20, (i * 3) % 20 + 40)) // 无关句
    else if (mode === 7) queries.push(entry.term[1]) // 单字：search 反向包含路径
    else if (mode === 8) queries.push(entry.term + termList[(i + 1) % termList.length].term) // 双词连排
    else queries.push(`zz${i}qq`) // latin 乱码：无命中
  }
  const contexts = [{}, { worldId: 'w1' }, { worldId: 'w0', characterId: 'c1' }]
  let dicePaths = 0
  for (let i = 0; i < queries.length; i++) {
    const memoryContext = contexts[i % contexts.length]
    const indexed = lexicon.matchLexiconHits(diffLibrary.id, queries[i], memoryContext)
    const naive = naiveMatch(DIFF_DATA, queries[i], memoryContext)
    const project = hits => hits.map(hit => ({ termId: hit.termId, term: hit.term, kindOfHit: hit.kindOfHit, score: hit.score }))
    assert.deepEqual(project(indexed), project(naive), `query #${i}: ${JSON.stringify(queries[i])}`)
    if (indexed.some(hit => hit.kindOfHit === 'dice')) dicePaths += 1
  }
  assert.ok(dicePaths >= 5, `the query mix must exercise the dice fallback (${dicePaths} did)`)
  console.log(`[lexicon-perf] matchLexiconHits对拍: 100/100 identical to the naive full-scan reference (${dicePaths} queries hit the dice path)`)
})

test('searchLexicon and visibleLexiconTerms agree with the naive full-scan reference', () => {
  const rand = mulberry32(909090)
  const termList = Object.values(DIFF_TERMS)
  for (let i = 0; i < 100; i++) {
    const entry = termList[Math.floor(rand() * termList.length)]
    const mode = i % 8
    const query = mode === 0 ? entry.term
      : mode === 1 ? `前缀${entry.term}后缀`
        : mode === 2 ? entry.term.slice(0, 2)
          : mode === 3 ? entry.term.slice(-2)
            : mode === 4 ? (entry.normalizedAliases[0] || entry.term).slice(0, -1)
              : mode === 5 ? entry.term[0]
                : mode === 6 ? FILLER.slice(i % 11, (i % 11) + 12)
                  : `q${i}`
    const memoryContext = i % 3 === 0 ? { worldId: 'w1' } : {}
    // 生命周期 includeArchived（§2.1）：false 只看 active，true 追加 archived；
    // pending/rejected 两种模式都不出现。
    const includeArchived = i % 4 === 0
    const project = rows => rows.map(row => ({ termId: row.termId, term: row.term, matchedBy: row.matchedBy }))
    assert.deepEqual(
      project(lexicon.searchLexicon({ libraryId: diffLibrary.id, query, memoryContext }, { includeArchived })),
      project(naiveSearch(DIFF_DATA, query, memoryContext, includeArchived)),
      `search query #${i}: ${JSON.stringify(query)}`,
    )
    const projectVisible = rows => rows.map(row => row.termId)
    assert.deepEqual(
      projectVisible(lexicon.visibleLexiconTerms(diffLibrary.id, memoryContext, { includeArchived })),
      projectVisible(naiveVisible(DIFF_DATA, memoryContext, includeArchived)),
      `visible query #${i}`,
    )
  }
  console.log('[lexicon-perf] searchLexicon/visibleLexiconTerms对拍: 100/100 identical to the naive full-scan reference')
})

// ---- 3) token 成本：锚点摘要（A 通道）与 B 通道各产出一次真实输出 ----

test('token cost of the A/B channel outputs on the 5k library (printed; anchor capped at 300)', () => {
  const binding = state.ensureSession('lexicon-perf-session', { cwd: path.join(home, 'perf') })
  const anchor = inject.buildLexiconAnchor(binding, binding.sessionId, 300)
  const anchorTokens = estTokens(anchor.text)
  const turn = inject.injectLexiconTurn({ binding, sessionId: binding.sessionId, userTexts: [PERF_MESSAGE], tokenBudget: 300 })
  const turnTokens = estTokens(turn.text)
  console.log(`[lexicon-perf] token cost on N=5000: anchor(A) estTokens=${anchorTokens} (${anchor.text.split('\n').length} lines), `
    + `B-channel estTokens=${turnTokens} (${turn.selected.length} of ${turn.hits.length} hits selected)`)
  assert.ok(anchorTokens <= 300, `anchor section must fit the 300-token hard cap, got ${anchorTokens}`)
  assert.ok(turnTokens <= 300, 'the B channel is budget-bounded by construction')
  assert.ok(turn.selected.length >= 1, 'the message embeds real terms; budget 300 must fit at least one line')
})

// ---- 参照实现：改造前「无缓存全量扫」算法的忠实拷贝（lib/lexicon.js 旧 match/
// search/visible 逐行同构）。刻意复制而非 import：lib 内部已索引化，这份拷贝是
// 独立的第二实现，两边一致才说明索引没有改变语义。唯一的刻意差异是 sensitivity
//Rank 用统一后的定义（sensitivity === 'sensitive'），与当前 lib 保持一致。 ----

const LEXICON_DICE_THRESHOLD = lexicon.LEXICON_DICE_THRESHOLD
const LEXICON_MAX_BUCKETS = lexicon.LEXICON_MAX_BUCKETS
const LEXICON_MAX_CANDIDATES = lexicon.LEXICON_MAX_CANDIDATES
const LEXICON_MAX_TERMS = lexicon.LEXICON_MAX_TERMS
const LEXICON_MIN_INCLUDE_LEN = lexicon.LEXICON_MIN_INCLUDE_LEN
const BUCKET_WIDTH = 2

function naiveDisplayRank(a, b) {
  return (Number(b.strength) || 0) - (Number(a.strength) || 0)
    || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
    || String(a.termId).localeCompare(String(b.termId))
}

function naiveVisible(terms, memoryContext, includeArchived) {
  const out = []
  for (const [termId, entry] of Object.entries(terms)) {
    const status = entry.status || 'active'
    if (status !== 'active' && !(includeArchived && status === 'archived')) continue
    if (!contextVisible(entry.context, memoryContext)) continue
    out.push({ termId, ...entry })
  }
  out.sort((a, b) => naiveDisplayRank(a, b))
  return out
}

function naiveBucketKeysOf(entry) {
  const keys = new Set()
  for (const text of [entry.normalizedTerm, ...(entry.normalizedAliases || [])]) {
    if (text && text.length >= BUCKET_WIDTH) keys.add(text.slice(0, BUCKET_WIDTH))
    else if (text) keys.add(text)
  }
  return [...keys]
}

// 窗口顺序与 lib 的 textBuckets 同口径：按桶命中词条数降序（A-8），而不是
// 按出现顺序取前 16 个。bucketSizeOf 用全量词条桶（含不可见词条）计算，与
// 索引里的 prefixBuckets.size 一致。
function naiveTextBuckets(normalizedText, bucketSizeOf, maxBuckets = LEXICON_MAX_BUCKETS) {
  const keys = []
  const seen = new Set()
  for (let i = 0; i + BUCKET_WIDTH <= normalizedText.length; i++) {
    const key = normalizedText.slice(i, i + BUCKET_WIDTH)
    if (seen.has(key)) continue
    seen.add(key)
    keys.push(key)
  }
  return keys
    .map((key, order) => ({ key, order, hits: bucketSizeOf(key) }))
    .sort((a, b) => b.hits - a.hits || a.order - b.order)
    .slice(0, maxBuckets)
    .map(item => item.key)
}

function naiveDiceFallback(normalizedText, candidates, { threshold = LEXICON_DICE_THRESHOLD, maxCandidates = LEXICON_MAX_CANDIDATES, maxTerms = LEXICON_MAX_TERMS } = {}) {
  const textGrams = bigrams(normalizedText)
  if (!textGrams.size) return []
  const scored = []
  for (const hit of candidates.slice(0, maxCandidates)) {
    let best = 0
    for (const surface of [hit.normalizedTerm, ...(hit.normalizedAliases || [])]) {
      if (!surface || surface.length < BUCKET_WIDTH) continue
      const key = surface.slice(0, BUCKET_WIDTH)
      let pos = normalizedText.indexOf(key)
      while (pos >= 0) {
        const window = normalizedText.slice(pos, pos + surface.length)
        const score = dice(bigrams(window), bigrams(surface))
        if (score > best) best = score
        if (best >= 1) break
        pos = normalizedText.indexOf(key, pos + 1)
      }
      if (best >= threshold) break
    }
    if (best >= threshold) scored.push({ ...hit, kindOfHit: 'dice', score: best })
  }
  scored.sort((a, b) => (b.score - a.score)
    || (Number(b.strength) || 0) * (Number(b.confidence) || 0) - (Number(a.strength) || 0) * (Number(a.confidence) || 0)
    || String(a.termId).localeCompare(String(b.termId)))
  return scored.slice(0, maxTerms)
}

function naiveHitOf(entry, termId, kindOfHit, score) {
  return {
    termId, term: entry.term, normalizedTerm: entry.normalizedTerm, kind: entry.kind,
    meaning: entry.meaning, usage: entry.usage, sensitivity: entry.sensitivity,
    strength: entry.strength, confidence: entry.confidence, context: entry.context,
    updatedAt: entry.updatedAt, status: entry.status, kindOfHit, score,
  }
}

function naiveExactHits(terms, normalizedText, visibleIds) {
  const hits = []
  for (const termId of visibleIds) {
    const entry = terms[termId]
    if (normalizedText === entry.normalizedTerm) { hits.push(naiveHitOf(entry, termId, 'exact-term', 1)); continue }
    if ((entry.normalizedAliases || []).includes(normalizedText)) { hits.push(naiveHitOf(entry, termId, 'exact-alias', 1)); continue }
    const surfaces = [entry.normalizedTerm, ...(entry.normalizedAliases || [])]
    let matched = null
    for (const surface of surfaces) {
      if (surface.length >= LEXICON_MIN_INCLUDE_LEN && normalizedText.includes(surface)) { matched = surface; break }
    }
    if (matched) hits.push(naiveHitOf(entry, termId, entry.normalizedTerm === matched ? 'exact-term' : 'exact-alias', 1))
  }
  return hits
}

function naiveSensitivityRank(hit) {
  return hit.sensitivity === 'sensitive' ? 1 : 0
}

function naiveExactRank(kindOfHit) {
  if (kindOfHit === 'exact-term') return 3
  if (kindOfHit === 'exact-alias') return 2
  return 1
}

function naiveScopeSpecificity(context) {
  if (!context || typeof context !== 'object') return 0
  return ['channelId', 'speakerId', 'characterId', 'worldId', 'branchId'].filter(key => context[key]).length
}

function naiveStableRank(hits) {
  return [...hits].sort((a, b) => {
    const sa = naiveSensitivityRank(a), sb = naiveSensitivityRank(b)
    if (sa !== sb) return sb - sa
    const ea = naiveExactRank(a.kindOfHit), eb = naiveExactRank(b.kindOfHit)
    if (ea !== eb) return eb - ea
    if (ea === 1 && Math.abs((b.score || 0) - (a.score || 0)) > 1e-9) return (b.score || 0) - (a.score || 0)
    const wa = (Number(a.strength) || 0) * (Number(a.confidence) || 0)
    const wb = (Number(b.strength) || 0) * (Number(b.confidence) || 0)
    if (Math.abs(wb - wa) > 1e-9) return wb - wa
    const ga = naiveScopeSpecificity(a.context), gb = naiveScopeSpecificity(b.context)
    if (ga !== gb) return gb - ga
    const ta = String(a.updatedAt || ''), tb = String(b.updatedAt || '')
    if (ta !== tb) return tb.localeCompare(ta)
    return String(a.termId).localeCompare(String(b.termId))
  })
}

function naiveMatch(terms, userText, memoryContext) {
  const normalizedText = lexicon.normalizeLexeme(userText)
  if (!normalizedText) return []
  const visibleIds = []
  const byBucket = new Map()
  const allBucketSizes = new Map()
  for (const [termId, entry] of Object.entries(terms)) {
    for (const key of naiveBucketKeysOf(entry)) {
      allBucketSizes.set(key, (allBucketSizes.get(key) || 0) + 1)
    }
    if ((entry.status || 'active') !== 'active') continue
    if (!contextVisible(entry.context, memoryContext)) continue
    visibleIds.push(termId)
    for (const key of naiveBucketKeysOf(entry)) {
      if (!byBucket.has(key)) byBucket.set(key, [])
      byBucket.get(key).push(termId)
    }
  }
  const exact = naiveExactHits(terms, normalizedText, visibleIds)
  const exactIds = new Set(exact.map(hit => hit.termId))
  // 候选按「与 query 共享的 gram 数」降序（A-8）；strength 与 termId 只做
  // 确定性 tiebreak。共享 gram 按整段 query 与每个词面计算（与 lib 同口径）。
  const candidateIds = new Set()
  for (const key of naiveTextBuckets(normalizedText, k => allBucketSizes.get(k) || 0)) {
    for (const termId of new Set(byBucket.get(key) || [])) {
      if (exactIds.has(termId)) continue
      candidateIds.add(termId)
    }
  }
  const textGrams = bigrams(normalizedText)
  const sharedGramCount = termId => {
    let best = 0
    for (const surface of [terms[termId].normalizedTerm, ...(terms[termId].normalizedAliases || [])]) {
      if (!surface) continue
      let shared = 0
      for (const gram of bigrams(surface)) if (textGrams.has(gram)) shared += 1
      if (shared > best) best = shared
    }
    return best
  }
  const weightOf = termId => (Number(terms[termId].strength) || 0) * (Number(terms[termId].confidence) || 0)
  const candidates = [...candidateIds]
    .map(termId => ({ termId, shared: sharedGramCount(termId) }))
    .sort((a, b) => b.shared - a.shared
      || weightOf(b.termId) - weightOf(a.termId)
      || String(a.termId).localeCompare(String(b.termId)))
    .map(({ termId }) => naiveHitOf(terms[termId], termId, 'dice', 0))
  const fuzzy = naiveDiceFallback(normalizedText, candidates)
  return naiveStableRank([...exact, ...fuzzy])
}

function naiveSearch(terms, query, memoryContext, includeArchived) {
  const normalizedQuery = lexicon.normalizeLexeme(query)
  const out = []
  if (!normalizedQuery) return out
  const matched = []
  for (const [termId, entry] of Object.entries(terms)) {
    const status = entry.status || 'active'
    if (status !== 'active' && !(includeArchived && status === 'archived')) continue
    if (!contextVisible(entry.context, memoryContext)) continue
    let matchedBy = null
    if (entry.normalizedTerm === normalizedQuery) matchedBy = 'term'
    else if ((entry.normalizedAliases || []).includes(normalizedQuery)) matchedBy = 'alias'
    else if (entry.normalizedTerm.length >= LEXICON_MIN_INCLUDE_LEN
      && (normalizedQuery.includes(entry.normalizedTerm) || entry.normalizedTerm.includes(normalizedQuery))) matchedBy = 'contains'
    else if ((entry.normalizedAliases || []).some(alias => alias.length >= LEXICON_MIN_INCLUDE_LEN
      && (normalizedQuery.includes(alias) || alias.includes(normalizedQuery)))) matchedBy = 'alias-contains'
    if (!matchedBy) continue
    matched.push({ termId, ...entry, matchedBy })
  }
  matched.sort((a, b) => {
    const ra = a.matchedBy === 'term' ? 3 : a.matchedBy === 'alias' ? 2 : 1
    const rb = b.matchedBy === 'term' ? 3 : b.matchedBy === 'alias' ? 2 : 1
    if (ra !== rb) return rb - ra
    return String(a.termId).localeCompare(String(b.termId))
  })
  return matched
}
