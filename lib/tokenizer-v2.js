/**
 * Tokenizer V2 — 智能分层分词器（召回升级 P0-1）。
 *
 * 相对 lib/text-retrieval.js 的 V1 口径（CJK 只出 bigram），V2 解决：
 * - R-01：CJK 只有 bigram，缺 unigram/trigram 层级，短查询命中不了子词；
 * - R-03：无实体保护，日期/周几/数字/邮箱/URL 被拆散。
 *
 * 设计原则：
 * 1. 英文与 latin 口径与 V1 完全一致（[a-z0-9]+(?:[._-][a-z0-9]+)*，≥2 字符）；
 * 2. CJK 输出 unigram + bigram + trigram 三层；完整 run 只在长度 ≤4 时保留，
 *    长句 run 的完整串是噪声且会抬高 BM25 文档长度，不收；
 * 3. 实体（日期/周几/数字/百分比/邮箱/URL）整体成 token，不被 n-gram 拆散；
 *    日期/周几正则与 text-retrieval.js 的 numericSet 同口径（周X/星期X 无空格）；
 * 4. 纯函数：No state, no IO, no clock——同输入同输出；去重用 Set 的插入序
 *    （先实体、后英文、后 CJK run，保留首次出现），不做任何排序。
 *
 * 集成方式（双轨制）：lib/text-retrieval.js 的 tokenize/tokenStream 按
 * lib/curator-policy.js 的 TOKENIZER_V2 开关委托到这里；开关关闭走 V1 原路径。
 */

// —— 规范化与清理——

/** NFKC 归一化 + 小写化（与 V1 的预处理一致）。 */
export function normalizeAndLower(text) {
  return String(text || '').normalize('NFKC').toLowerCase()
}

// —— 英文 tokenization（保持 V1 逻辑）——

/**
 * 英文与 latin：与 V1 完全同口径——[a-z0-9]+(?:[._-][a-z0-9]+)*，
 * 连接符词（dsh-memu-memory_v2.today）保持整 token，单字符丢弃（≥2 才收）。
 */
function tokenizeEnglishTokens(s) {
  const out = []
  for (const m of s.matchAll(/[a-z0-9]+(?:[._-][a-z0-9]+)*/g)) {
    if (m[0].length >= 2) out.push(m[0])
  }
  return out
}

// —— CJK tokenization（三层 n-gram + 完整 run 上限）——

/**
 * CJK 统一表意文字
 * \u3400-\u9fff: CJK Unified Ideographs
 * \uf900-\ufaff: CJK Compatibility Ideographs
 */
const CJK_RANGE = /[\u3400-\u9fff\uf900-\ufaff]+/g

// 完整 run token 的保留上限：run 恰为 4 字时补收完整串（≤3 字时完整串已经是
// unigram/bigram/trigram 之一，≥5 字的长 run 完整串是噪声，都不另收）。
const CJK_RUN_KEEP_MAX = 4

/**
 * CJK 字符序列的多层级 tokenization。
 *
 * - 单字 run → 只保留 unigram；
 * - 长度 2~3 的 run → unigram + bigram（+trigram），完整串即其中之一；
 * - 长度恰为 4 的 run → unigram + bigram + trigram + 完整 run token；
 * - 长度 >4 的 run → 只输出 unigram + bigram + trigram（长句完整串不收，
 *   避免噪声 token 抬高 BM25 文档长度）。
 *
 * 每层里同一个串只进流一次（无重复），tokenStreamV2 的 tf 不虚高。
 *
 * @param {string} run - CJK 字符序列
 * @returns {string[]} 分层 token 列表（含重复语义由调用方决定，本函数不重复收串）
 */
function tokenizeCJKRun(run) {
  const out = []
  if (run.length === 1) {
    out.push(run)
    return out
  }
  // Level 1: Unigram（每个字）
  for (let i = 0; i < run.length; i++) out.push(run[i])
  // Level 2: Bigram（相邻两个字）
  for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
  // Level 3: Trigram（相邻三个字）
  if (run.length >= 3) {
    for (let i = 0; i < run.length - 2; i++) out.push(run.slice(i, i + 3))
  }
  // Level 0: 完整 run——只在 4 字时是「额外」的一层（≤3 字已被上面覆盖）
  if (run.length === CJK_RUN_KEEP_MAX) out.push(run)
  return out
}

// —— 实体提取与保护——

// 数字边界：紧邻标识符连接字符的数字是标识符/日期的一部分，不作为独立数字
// 实体——'v2.today' 不拆出噪声 token '2'，'2026-11-05' 由完整日期实体覆盖而
// 不再拆出 '2026'/'11'/'05'。prev 看 [a-z0-9._-]（标识符内部），next 看
// [a-z0-9_-]（连字/日期连接；'.': 句点不拦，'85%.' 仍收 '85%'）。
const IDENT_PREV_BOUNDARY = /[a-z0-9._-]/
const IDENT_NEXT_BOUNDARY = /[a-z0-9_-]/

function numberStandalone(text, index, length) {
  const prev = index > 0 ? text[index - 1] : ''
  const next = index + length < text.length ? text[index + length] : ''
  if (IDENT_PREV_BOUNDARY.test(prev)) return false
  if (IDENT_NEXT_BOUNDARY.test(next)) return false
  return true
}

/**
 * 提取需要保护的实体模式（口径对齐 text-retrieval.js numericSet：
 * 周X/星期X 无空格、M月D日/号；在此之上保留完整 YYYY年M月D日）：
 * - 时间：YYYY-MM-DD、YYYY 年 M 月 D 日、M 月 D 日/号、周 X、星期 X
 * - 数字/数值：整数、小数、百分比（只收独立数字——标识符/日期内部的数字不算）
 * - 邮箱地址
 * - URL（简化版——仅协议开头；去掉句尾标点，避免把「。」带进索引）
 *
 * @param {string} text - 已规范化的文本
 * @returns {string[]} 提取的实体列表（按模式顺序，含重复）
 */
function extractEntities(text) {
  const entities = []

  // 1. 日期时间
  const datePatterns = [
    /\d{4}-\d{1,2}-\d{1,2}/g,      // YYYY-MM-DD
    /\d{4}年\d{1,2}月\d{1,2}日/g,  // YYYY 年 M 月 D 日
    /\d{1,2}月\d{1,2}[日号]/g,     // M 月 D 日/号（numericSet 同口径）
    /周[一二三四五六日天]/g,        // 周X（无空格——与 numericSet 对齐）
    /星期[一二三四五六日天]/g,      // 星期X（无空格——与 numericSet 对齐）
  ]
  for (const pattern of datePatterns) {
    for (const match of text.matchAll(pattern)) {
      entities.push(match[0])
    }
  }

  // 2. 数字（整数、小数）——独立数字才收
  const numberPattern = /\d+(?:\.\d+)?/g
  for (const match of text.matchAll(numberPattern)) {
    if (numberStandalone(text, match.index, match[0].length)) entities.push(match[0])
  }

  // 3. 百分比——同样要求独立（'v2%' 不拆出 '2%'）
  const percentPattern = /\d+(?:\.\d+)?%/g
  for (const match of text.matchAll(percentPattern)) {
    if (numberStandalone(text, match.index, match[0].length)) entities.push(match[0])
  }

  // 4. 邮箱地址（简化版）
  const emailPattern = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g
  for (const match of text.matchAll(emailPattern)) {
    entities.push(match[0])
  }

  // 5. URL（简化版——仅协议开头；剥掉句尾标点）
  const urlPattern = /https?:\/\/[^\s]+/g
  for (const match of text.matchAll(urlPattern)) {
    entities.push(match[0].replace(/[)\]}.,;:!?'"]*[。，、；：！？）》」』…]+$/, ''))
  }

  return entities
}

// —— 主接口——

/**
 * Tokenizer V2 — 主入口函数。
 *
 * 完整的 tokenization 流程：
 * 1. 规范化文本 (NFKC + lowercase)
 * 2. 提取并保护特殊实体（先占位——Set 插入序让实体 token 排在最前）
 * 3. 英文部分与 V1 同口径
 * 4. CJK 部分按 unigram+bigram+trigram 三层（4 字 run 另收完整串）
 * 5. Set 按插入序去重（保留首次出现，不排序——同输入同输出）
 *
 * @param {string} text - 输入文本
 * @returns {Set<string>} 去重后的 token 集合（插入序）
 *
 * @example
 * tokenizeV2('人工智能是一种技术')
 * // run '人工智能是一种技术' 长度 9 > 4：不出完整 run，只出三层 n-gram——
 * // 9 个 unigram（人/工/智/…）+ 8 个 bigram（人工/工智/智能/…）
 * // + 7 个 trigram（人工智/工智能/…），共 24 个 token，无重复。
 *
 * @example
 * tokenizeV2('2026-11-05 AI 技术很火，比如 Qwen3-Embedding')
 * // 输出包含：'2026-11-05'（实体，不被拆散）、'ai'、'qwen3-embedding'、
 * // '技'/'技术'/'技术很' 等 CJK 三层 token。
 */
export function tokenizeV2(text) {
  const normalized = normalizeAndLower(text)
  const out = []

  // Step 1: 提取并保护实体（先占位）
  out.push(...extractEntities(normalized))

  // Step 2: 英文部分 tokenization（与 V1 同口径）
  out.push(...tokenizeEnglishTokens(normalized))

  // Step 3: CJK 部分 tokenization（三层）
  for (const match of normalized.matchAll(CJK_RANGE)) {
    out.push(...tokenizeCJKRun(match[0]))
  }

  // Step 4: 去重——Set 保留插入序（首次出现），不做任何排序
  return new Set(out)
}

/**
 * Tokenize V2 的流式版本（用于 BM25 的 tf 计算）。
 * 不对 token 去重，保持频率信息；生成器与 tokenizeV2 完全一致，因此
 * tokenStreamV2 的去重集合恒等于 tokenizeV2 的集合（⊂ 语义上的同一性）。
 *
 * @param {string} text - 输入文本
 * @returns {string[]} 所有 token（含重复）
 */
export function tokenStreamV2(text) {
  const normalized = normalizeAndLower(text)
  const out = []

  // 提取实体（重复出现会多次记录）
  out.push(...extractEntities(normalized))

  // 英文部分（重复会出现多次）
  out.push(...tokenizeEnglishTokens(normalized))

  // CJK 部分（多层级 + 重复）
  for (const match of normalized.matchAll(CJK_RANGE)) {
    out.push(...tokenizeCJKRun(match[0]))
  }

  return out
}

// —— 向后兼容——

/**
 * 提供与 V1 调用点兼容的 tokenize 接口：
 * 内部调用 V2 实现并展开为数组（Set 的插入序）。
 */
export function tokenize(text) {
  return [...tokenizeV2(text)]
}

// —— 测试用工具函数——

/**
 * Token 统计信息：total 用数组 length 计（tokenize 返回数组），
 * byType 覆盖全部 token（unknown 兜底），两项之和恒相等。
 */
export function tokenizeStats(text) {
  const tokens = tokenize(text)
  const byType = new Map()

  for (const token of tokens) {
    let type = 'unknown'
    if (/^\d+$/.test(token)) type = 'number'
    else if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(token)) type = 'date_iso'
    else if (/^\d+(?:\.\d+)?%$/.test(token)) type = 'percent'
    else if (/^[0-9a-z._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(token)) type = 'email'
    else if (/^https?:\/\//i.test(token)) type = 'url'
    else if (/^[\u3400-\u9fff\uf900-\ufaff]$/.test(token)) type = 'cjk_unigram'
    else if (/^[\u3400-\u9fff\uf900-\ufaff]{2}$/.test(token)) type = 'cjk_bigram'
    else if (/^[\u3400-\u9fff\uf900-\ufaff]{3}$/.test(token)) type = 'cjk_trigram'
    else if (/^[\u3400-\u9fff\uf900-\ufaff]{4,}$/.test(token)) type = 'cjk_run'
    else if (/^[a-z0-9]+$/i.test(token)) type = 'english'

    byType.set(type, (byType.get(type) || 0) + 1)
  }

  return {
    total: tokens.length,
    byType: Object.fromEntries(byType),
  }
}
