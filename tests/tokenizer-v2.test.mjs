import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeAndLower,
  tokenize,
  tokenizeStats,
  tokenizeV2,
  TEST_CASES,
  tokenStreamV2,
} from '../lib/tokenizer-v2.js'

// —— 召回升级 P0-1：Tokenizer V2（CJK 三层 n-gram + 实体保护）——
// 开关在 lib/curator-policy.js（TOKENIZER_V2）；这里测 V2 本身的行为契约。

test('normalizeAndLower: NFKC 折叠全角并小写化', () => {
  assert.equal(normalizeAndLower('ＡＢｃ ＤＥＦ'), 'abc def')
  assert.equal(normalizeAndLower('Cache-COHERENCE'), 'cache-coherence')
  assert.equal(normalizeAndLower(null), '')
})

test('纯中文短句：4 字 run 出 unigram+bigram+trigram+完整 run，插入序确定', () => {
  // Level 1 unigram → Level 2 bigram → Level 3 trigram → 完整 run 收尾
  assert.deepEqual(tokenize('部署窗口'), [
    '部', '署', '窗', '口',
    '部署', '署窗', '窗口',
    '部署窗', '署窗口',
    '部署窗口',
  ])
})

test('纯中文短句：2 字 run 不重复收 bigram（流里 tf 不虚高）', () => {
  assert.deepEqual(tokenize('缓存 缓存'), ['缓', '存', '缓存'])
})

test('中英混合：日期实体完整保留、英文同 V1 口径、CJK 三层展开', () => {
  const tokens = tokenize('2026-11-05 AI 技术在快速发展')
  // 实体：完整日期，不被拆散（Set 插入序让实体排最前）
  assert.ok(tokens.includes('2026-11-05'))
  // 英文：≥2 字符的 latin 词
  assert.ok(tokens.includes('ai'))
  // CJK：unigram/bigram/trigram 三层都在
  assert.ok(tokens.includes('技') && tokens.includes('技术') && tokens.includes('速发展'))
  // 长句 run（7 字 > 4）不出完整 run token
  assert.ok(!tokens.includes('技术在快速发展'))
})

test('日期/时间实体：周一 / 星期一 / 周日 都能成整 token（空格 bug 已修）', () => {
  assert.equal(tokenize('周一开会')[0], '周一')
  assert.ok(tokenize('星期一例会').includes('星期一'))
  assert.ok(tokenize('周日 拖地').includes('周日'))
  assert.ok(tokenize('星期天大扫除').includes('星期天'))
})

test('日期/时间实体：YYYY-MM-DD 整体保留；M月D日 成整 token', () => {
  assert.deepEqual(tokenize('截止 2026-11-05 完成'), ['2026-11-05', '截', '止', '截止', '完', '成', '完成'])
  assert.ok(tokenize('11月5日 提交').includes('11月5日'))
})

test('数字/百分比：独立数字与百分比都成 token；标识符内部的数字不拆出噪声', () => {
  assert.deepEqual(tokenize('增长 85%').slice(0, 2), ['85', '85%'])
  // 'v2.today' 不拆出 '2'；'30-40' 由英文连接词口径整收
  assert.deepEqual(tokenize('use dsh-memu-memory_v2.today ok'), ['use', 'dsh-memu-memory_v2.today', 'ok'])
  assert.ok(!tokenize('Qwen3-Embedding 在 2026 年发布').includes('3'))
  assert.ok(tokenize('Qwen3-Embedding 在 2026 年发布').includes('2026'))
  // 完整日期的子串（2026/11/05）不再作为数字实体重复出现
  assert.ok(!tokenize('2026-11-05 提交').includes('2026'))
})

test('邮箱与 URL：整体成 token；URL 句尾标点被剥掉', () => {
  assert.ok(tokenize('发到 user@example.com 即可').includes('user@example.com'))
  assert.ok(tokenize('看 https://example.com/docs。').includes('https://example.com/docs'))
  assert.ok(!tokenize('看 https://example.com/docs。').includes('https://example.com/docs。'))
})

test('单字 run：只保留 unigram；跨标点的 run 各自独立', () => {
  assert.deepEqual([...tokenizeV2('猫')], ['猫'])
  assert.deepEqual(tokenize('猫。狗'), ['猫', '狗'])
})

test('长 run 的 trigram 边界：>4 字不出完整 run，首尾 trigram 都在', () => {
  const tokens = tokenize('人工智能技术') // 6 字
  assert.ok(tokens.includes('人工智'), '首个 trigram')
  assert.ok(tokens.includes('能技术'), '末尾 trigram')
  assert.ok(!tokens.includes('人工智能技术'), '长 run 不收完整串')
  // 4 字 run 是唯一补收完整串的长度
  assert.ok(tokenize('部署窗口').includes('部署窗口'))
})

test('英文与 NFKC 口径与 V1 完全一致：连接词、全角折叠、单字符丢弃', () => {
  assert.deepEqual(tokenize('use dsh-memu-memory_v2.today ok'), ['use', 'dsh-memu-memory_v2.today', 'ok'])
  assert.deepEqual(tokenize('a b cd'), ['cd'])
  assert.deepEqual(tokenize('per-turn retry'), ['per-turn', 'retry'])
  assert.deepEqual(tokenize('ＲＩＳＣＶ ＣＡＣＨＥ CACHE'), ['riscv', 'cache'])
})

test('去重确定性：同输入两次调用结果一致（含 TEST_CASES 全部场景）', () => {
  for (const { input } of TEST_CASES) {
    assert.deepEqual(tokenize(input), tokenize(input), input)
    assert.deepEqual([...tokenizeV2(input)], [...tokenizeV2(input)], input)
  }
})

test('tokenize 兼容接口：返回数组，且与 tokenizeV2 的 Set 展开一致', () => {
  assert.equal(Array.isArray(tokenize('部署窗口')), true)
  assert.deepEqual(tokenize('部署窗口'), [...tokenizeV2('部署窗口')])
})

test('tokenStreamV2 与 tokenizeV2 一致：流的去重集合 ⊆/＝ V2 的 Set，且含重复语义', () => {
  const stream = tokenStreamV2('缓存 2026-11-05 缓存过期')
  const set = tokenizeV2('缓存 2026-11-05 缓存过期')
  for (const token of stream) assert.equal(set.has(token), true, `流 token ${token} 必须在 Set 中`)
  assert.ok(stream.length >= set.size, '流不去重，长度不小于集合')
  // 同一生成器：流去重后与 Set 完全相等
  assert.deepEqual(new Set(stream), set)
  // 重复出现的词在流里保留频率（BM25 tf 的来源）
  const repeated = tokenStreamV2('缓存缓存')
  assert.ok(repeated.filter((t) => t === '缓存').length >= 2)
})

test('tokenizeStats：total 正确计数（数组 length），byType 覆盖全部 token', () => {
  const stats = tokenizeStats('猫 2026-11-05 user@example.com https://a.io 85% 部署窗')
  assert.equal(stats.total, 16)
  const sum = Object.values(stats.byType).reduce((a, b) => a + b, 0)
  assert.equal(sum, stats.total, 'byType 各类之和必须等于 total')
  assert.equal(stats.byType.date_iso, 1)
  assert.equal(stats.byType.email, 1)
  assert.equal(stats.byType.url, 1)
  assert.equal(stats.byType.percent, 1)
  assert.equal(stats.byType.number, 1) // 85（日期子串不再算数字）
  assert.equal(stats.byType.cjk_unigram, 4) // 猫/部/署/窗
  assert.equal(stats.byType.cjk_bigram, 2) // 部署/署窗
  assert.equal(stats.byType.cjk_trigram, 1) // 部署窗
})

test('TEST_CASES 导出形状不变：input/description 字段齐全且可分词', () => {
  assert.ok(Array.isArray(TEST_CASES) && TEST_CASES.length >= 4)
  for (const item of TEST_CASES) {
    assert.equal(typeof item.input, 'string')
    assert.equal(typeof item.description, 'string')
    assert.ok(tokenizeV2(item.input).size > 0)
  }
})
