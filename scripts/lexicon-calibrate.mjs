#!/usr/bin/env node
// scripts/lexicon-calibrate.mjs — Dice 阈值标定脚手架（docs/lexicon-design.md §10 P2）
//
// 内置一组人工标注样本（正例对 ≥15：同词变体/别名命中/例句命中；负例对 ≥15：无关词/
// 同主题不同词/形近词），对每对跑 matchLexiconHits 的完整流水线（独立临时库，互不干扰），
// 输出每对的 dice 值、在候选阈值下的判定 vs 标注，以及各阈值的 precision/recall/FP/FN。
//
// 本脚本只出报告，**绝不自动改 LEXICON_DICE_THRESHOLD**——阈值调整是人看了报告之后的决定。
// 指标只陈述「这套样本上的表现」，不外推为线上分布。
//
// 用法：node scripts/lexicon-calibrate.mjs [--threshold=0.55,0.6,0.65,0.7,0.75]
//   --threshold 接受一个或多个（逗号分隔）0..1 之间的值；缺省扫 0.55..0.75 步长 0.05。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 标定在自己的一次性 DSH_MEMU_HOME 里跑：绝不读写真实数据目录。
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-lexicon-calibrate-'))
process.env.DSH_MEMU_HOME = tempHome

const DEFAULT_THRESHOLDS = [0.55, 0.6, 0.65, 0.7, 0.75]

/**
 * 标注样本。dice 值是设计出来的已知值（2×共享 bigram ÷ 两侧 bigram 数），注释给出
 * 预期分数，跑出来的表应当能对上；对不上时说明匹配算法变了，报告会直接显示。
 * 每对 = { label, note, term: {term, aliases}, text }；pair 之间用独立临时库隔离。
 */
const POSITIVE = [
  { note: '同词变体（末字异写，预期 dice≈0.667）', term: { term: '糖刀文学' }, text: '这段糖刀文雪啊' },
  { note: '同词变体（刀锋样本：预期 dice≈0.60，恰在候选阈值上）', term: { term: '贴贴抱抱举起' }, text: '贴贴抱抱捏捏' },
  { note: '同词变体（预期 dice≈0.75）', term: { term: '雾夜航行记' }, text: '今晚雾夜航行迟了' },
  { note: '同词变体（预期 dice≈0.80）', term: { term: '霓虹深海怪谈' }, text: '传言是霓虹深海怪人' },
  { note: '同词变体·拉丁（预期 dice≈0.667）', term: { term: 'teatime' }, text: 'teatyme with friends' },
  { note: '同词变体（预期 dice≈0.667）', term: { term: '破防时刻' }, text: '这段剧情让我破防时该' },
  { note: '同词变体（预期 dice≈0.667）', term: { term: '塌房现场' }, text: '这里简直塌房现成' },
  { note: '同词变体（预期 dice≈0.80）', term: { term: '贴贴文学鉴赏' }, text: '简直是贴贴文学鉴尝' },
  { note: '别名命中（exact-alias，score=1）', term: { term: '糖刀', aliases: ['糖里藏刀'] }, text: '这不就是糖里藏刀吗' },
  { note: '别名命中（exact-alias，score=1）', term: { term: 'moonfall', aliases: ['坠月'] }, text: '听说昨晚有坠月异象' },
  { note: '别名命中（短 alias 的包含，score=1）', term: { term: '咖啡上头', aliases: ['上头'] }, text: '喝三杯就上头' },
  { note: '例句命中（文本包含词面，exact-term，score=1）', term: { term: '霓虹深海' }, text: '今晚的街道是典型的霓虹深海氛围' },
  { note: '例句命中（exact-term，score=1）', term: { term: '回声体' }, text: '他说话一股回声体的味道' },
  { note: '整句等值（exact-term，score=1）', term: { term: '茶里茶气' }, text: '茶里茶气' },
  { note: '例句命中（exact-term，score=1）', term: { term: '月引仪式' }, text: '按照月引仪式的流程走完' },
  { note: '前缀截断（短文本 vs 长词条，预期 dice≈0.667；是否算命中本身值得人review）', term: { term: '回声体' }, text: '回声' },
]

const NEGATIVE = [
  { note: '无关词', term: { term: '糖刀文学' }, text: '今天天气不错' },
  { note: '无关词·拉丁', term: { term: 'teatime' }, text: 'hello world' },
  { note: '同主题不同词（夜航 ≠ 雾夜航行）', term: { term: '雾夜航行' }, text: '夜航模式开启' },
  { note: '同主题不同词', term: { term: '破防时刻' }, text: '破大防了' },
  { note: '同主题不同词', term: { term: '塌房现场' }, text: '文塌了' },
  { note: '同主题不同词', term: { term: '月引仪式' }, text: '霜露降在桥边' },
  { note: '形近词（预期 dice≈0.333）', term: { term: '贴贴抱抱' }, text: '贴贴报抱' },
  { note: '形近词（预期 dice≈0.333）', term: { term: '糖刀文学' }, text: '糖刀桌子' },
  { note: '形近词（预期 dice≈0.2）', term: { term: '贴贴抱抱举起' }, text: '贴贴报抱拍拍' },
  { note: '形近词（共享单字但无共享 bigram，dice=0）', term: { term: '红牌' }, text: '红树牌楼' },
  { note: '形近词·拉丁（预期 dice≈0.43）', term: { term: 'moonfall' }, text: 'moonrise' },
  { note: '形近词·拉丁（预期 dice≈0.31）', term: { term: 'teatime' }, text: 'tea party' },
  { note: '同主题形近（候选入桶但预期 dice≈0.333）', term: { term: '咖啡上头' }, text: '咖啡因过量' },
  { note: '形近词·三字（预期 dice=0.5，刀锋负例）', term: { term: '破大防' }, text: '破大房' },
  { note: '词面前缀出现在句中但整词不在（预期 dice≈0.25）', term: { term: '贴贴抱抱举起' }, text: '我们贴贴猫吧' },
  { note: '同主题改写（无词面重叠）', term: { term: '糖里藏刀' }, text: '他藏着刀' },
]

function normalizeLexeme(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function buildEntry(pair, termId) {
  const term = pair.term.term
  const aliases = Array.isArray(pair.term.aliases) ? pair.term.aliases : []
  return {
    term,
    normalizedTerm: normalizeLexeme(term),
    kind: 'term',
    meaning: '标定样本词条',
    usage: '',
    aliases,
    normalizedAliases: aliases.map(normalizeLexeme).filter(Boolean),
    examples: [],
    context: {},
    visibility: 'shared',
    sensitivity: 'normal',
    strength: 0.6,
    confidence: 0.8,
    status: 'active',
    source: 'user',
    evidence: [],
    fingerprint: `fp-${termId}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    hitCounts: { candidate: 0, injection: 0, query: 0 },
    lastInjectedAt: null,
  }
}

function parseThresholds(args) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    let raw = null
    if (arg.startsWith('--threshold=')) raw = arg.slice('--threshold='.length)
    else if (arg === '--threshold') raw = args[++i] || ''
    if (raw === null) continue
    for (const piece of String(raw).split(',')) {
      const value = Number(piece)
      if (Number.isFinite(value) && value > 0 && value < 1) out.push(value)
    }
  }
  if (!out.length) return [...DEFAULT_THRESHOLDS]
  return [...new Set(out)].sort((a, b) => a - b)
}

async function run() {
  const { dataDir, writeJson } = await import('../lib/paths.js')
  const lexicon = await import('../lib/lexicon.js')
  const { bigrams, dice } = await import('../lib/text-similarity.js')
  const thresholds = parseThresholds(process.argv.slice(2))
  const primary = thresholds.includes(0.6) ? 0.6 : thresholds[0]

  // matchLexiconHits 只会返回 score ≥ LEXICON_DICE_THRESHOLD 的 dice 命中，低于阈值的
  // 候选分数被丢弃——而标定恰恰要看那些"差一点"的值。这里按 lib/diceFallback 同一
  // 滑窗口径（词面前 2 字定位、等长窗口、取最大；候选资格也同 lib：词面前缀必须落
  // 在文本前 16 个互异 2 字窗口内）重算**原始 dice**，阈值判定由报告按各候选阈值给出。
  function rawDiceScore(entry, text) {
    const normalized = normalizeLexeme(text)
    const exact = normalized === entry.normalizedTerm
      || (entry.normalizedAliases || []).includes(normalized)
      || [entry.normalizedTerm, ...(entry.normalizedAliases || [])].some(surface =>
        surface.length >= 2 && normalized.includes(surface))
    if (exact) return { score: 1, exact: true }
    const surfaces = [entry.normalizedTerm, ...(entry.normalizedAliases || [])]
    // 候选资格：文本前 16 个互异 2 字窗口里必须出现某词面的前 2 字（LEXICON_MAX_BUCKETS）。
    const windows = []
    const seen = new Set()
    for (let i = 0; i + 2 <= normalized.length && windows.length < 16; i++) {
      const key = normalized.slice(i, i + 2)
      if (seen.has(key)) continue
      seen.add(key)
      windows.push(key)
    }
    const surfaceList = surfaces.filter(surface => surface && surface.length >= 2)
    if (!surfaceList.length) return { score: 0, exact: false }
    if (!windows.some(key => surfaceList.some(surface => surface.slice(0, 2) === key))) {
      return { score: 0, exact: false }
    }
    let best = 0
    for (const surface of surfaceList) {
      const key = surface.slice(0, 2)
      let pos = normalized.indexOf(key)
      while (pos >= 0) {
        const window = normalized.slice(pos, pos + surface.length)
        const score = dice(bigrams(window), bigrams(surface))
        if (score > best) best = score
        if (best >= 1) break
        pos = normalized.indexOf(key, pos + 1)
      }
      if (best >= 1) break
    }
    return { score: best, exact: false }
  }

  const pairs = [
    ...POSITIVE.map(pair => ({ ...pair, expect: 'pos' })),
    ...NEGATIVE.map(pair => ({ ...pair, expect: 'neg' })),
  ]
  const results = []
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]
    const termId = 'lex-cal-1'
    const libraryId = `calibrate-${String(i + 1).padStart(2, '0')}`
    const file = path.join(dataDir(), 'lexicon', `${libraryId}.json`)
    writeJson(file, { version: 1, revision: 1, libraryId, terms: { [termId]: buildEntry(pair, termId) }, rejected: {} })
    const hits = lexicon.matchLexiconHits(libraryId, pair.text, {})
    const hit = hits.find(item => item.termId === termId) || null
    const raw = rawDiceScore(buildEntry(pair, termId), pair.text)
    results.push({
      id: `${pair.expect === 'pos' ? 'P' : 'N'}${String((pair.expect === 'pos' ? i + 1 : i + 1 - POSITIVE.length)).padStart(2, '0')}`,
      expect: pair.expect,
      note: pair.note,
      term: pair.term.term,
      text: pair.text,
      score: raw.score,
      kindOfHit: hit ? hit.kindOfHit : 'miss',
    })
  }

  console.log('lexicon-calibrate — Dice 阈值标定报告（只出报告，不自动改 LEXICON_DICE_THRESHOLD）')
  console.log(`样本：正例 ${POSITIVE.length} 对，负例 ${NEGATIVE.length} 对；每对独立临时库。dice 列是与 lib 同口径滑窗重算的原始值（lib 会丢弃阈值以下的分数，标定需要看见它们）。`)
  console.log('')
  console.log(`pair  标注  判定@${primary.toFixed(2)}  dice   lib@0.60      term ← 文本 — 说明`)
  for (const row of results) {
    const predicted = row.score >= primary ? 'pos' : 'neg'
    const verdict = row.expect === 'pos'
      ? (predicted === 'pos' ? 'TP' : 'FN')
      : (predicted === 'pos' ? 'FP' : 'TN')
    console.log(`${row.id}   ${row.expect}    ${verdict}       ${row.score.toFixed(3)}  ${row.kindOfHit.padEnd(12)}  ${row.term} ← ${row.text} — ${row.note}`)
  }
  console.log('')
  console.log('汇总（各候选阈值）：')
  console.log('threshold  TP  FP  TN  FN  precision  recall')
  for (const threshold of thresholds) {
    let tp = 0, fp = 0, tn = 0, fn = 0
    for (const row of results) {
      const predicted = row.score >= threshold ? 'pos' : 'neg'
      if (row.expect === 'pos' && predicted === 'pos') tp += 1
      else if (row.expect === 'neg' && predicted === 'pos') fp += 1
      else if (row.expect === 'neg' && predicted === 'neg') tn += 1
      else fn += 1
    }
    const precision = tp + fp ? tp / (tp + fp) : 0
    const recall = tp + fn ? tp / (tp + fn) : 0
    console.log(`${threshold.toFixed(2)}      ${String(tp).padStart(3)}  ${String(fp).padStart(3)}  ${String(tn).padStart(3)}  ${String(fn).padStart(3)}  ${precision.toFixed(3)}      ${recall.toFixed(3)}`)
  }
  const at = results.filter(row => row.expect === 'pos' && row.score >= primary).length
  const fpAt = results.filter(row => row.expect === 'neg' && row.score >= primary).length
  const fnAt = POSITIVE.length - at
  const tnAt = NEGATIVE.length - fpAt
  const precisionAt = at + fpAt ? at / (at + fpAt) : 0
  const recallAt = at + fnAt ? at / (at + fnAt) : 0
  console.log('')
  console.log(`当前 ${primary.toFixed(2)} 下的指标：precision=${precisionAt.toFixed(3)} recall=${recallAt.toFixed(3)} FP=${fpAt} FN=${fnAt} TN=${tnAt}（样本 ${results.length} 对；只代表本标注集，不外推为线上分布；调整阈值前先看刀锋样本 P02/N14）`)
}

try {
  await run()
} finally {
  try { fs.rmSync(tempHome, { recursive: true, force: true }) } catch {}
}
