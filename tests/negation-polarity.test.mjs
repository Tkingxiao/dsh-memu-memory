import test from 'node:test'
import assert from 'node:assert/strict'
import {
  globalConflictCheck,
  negationPolarity,
  pairFeatures,
  polarityAt,
} from '../lib/text-retrieval.js'

// —— §4.8 冲突预筛 P1-2：子句级否定作用域（polarityAt）——
//
// 整文本 negationPolarity 有两类误报：无关子句的否定污染、双重否定。
// polarityAt 只判锚点所在子句，标记计数 mod 2，对比词切片段。

test('polarityAt: negation in the same clause hits across 12 chars (existing true positive)', () => {
  // 「不」在第 2 字，锚点「告警」在第 12 字附近——同一子句即算否定侧，
  // 这条是既有真阳性（curator-pairing 的告警对），不能丢。
  assert.equal(polarityAt('用户不希望每次部署失败都发告警通知', '告警'), true)
})

test('polarityAt: negation in an unrelated clause does not pollute the anchor clause', () => {
  // 「别」在第二个子句（别忘了），锚点「截止日期」在第一个子句——互不污染。
  assert.equal(polarityAt('项目截止日期是5月1日，别忘了', '截止日期'), false)
})

test('polarityAt: double negation flips back to positive (marker count mod 2)', () => {
  assert.equal(polarityAt('不是不喜欢香菜', '香菜'), false)
  // 多标记句：禁止 → 单个否定 → 否定侧
  assert.equal(polarityAt('禁止在-production 环境跑迁移', 'production'), true)
})

test('polarityAt: contrast structure frees the B side (不是A而是B)', () => {
  // 「不是 A 而是 B」里 B（队列）是肯定侧——这是 P1-2 要修的误报方向。
  assert.equal(polarityAt('不是缓存的问题而是队列的问题', '队列'), false)
  // A 侧（缓存）：按对比规则正文「不是 A 而是 B 里否定属于 A」，标记「不」与
  // 「缓存」之间没有对比词，否定仍属于 A → true。任务示例写的是「缓存 → false」，
  // 与规则正文矛盾；这里取规则正文，保住「问题是缓存」 vs 「不是缓存而是队列」
  // 这类真阳性。若要两侧皆 false，把含对比词子句里片段 0 的标记也跳过即可。
  assert.equal(polarityAt('不是缓存的问题而是队列的问题', '缓存'), true)
})

test('polarityAt: 而不是 passes the negation forward to what follows', () => {
  // 「而不是」引出的片段继承一个否定：队列是否定侧、缓存不是——
  // 「用缓存而不是队列」与「统一用缓存」不再误报冲突。
  assert.equal(polarityAt('用缓存而不是队列', '队列'), true)
  assert.equal(polarityAt('用缓存而不是队列', '缓存'), false)
})

test('polarityAt: English markers, word-bounded', () => {
  assert.equal(polarityAt('I no longer play tennis', 'tennis'), true)
  assert.equal(polarityAt('I play tennis every weekend', 'tennis'), false)
  // \b 生效：not 不命中 another 这类词内片段
  assert.equal(polarityAt('another deploy window', 'deploy'), false)
})

test('polarityAt: anchor absent or empty is false; deterministic on repeat', () => {
  assert.equal(polarityAt('用户不希望每次部署失败都发告警通知', '监控'), false, 'anchor not in text')
  assert.equal(polarityAt('用户不希望每次部署失败都发告警通知', ''), false, 'empty anchor')
  const once = polarityAt('项目截止日期是5月1日，别忘了', '截止日期')
  assert.equal(polarityAt('项目截止日期是5月1日，别忘了', '截止日期'), once, 'same input, same output')
})

test('polarityAt: multiple anchor occurrences — any negated clause wins (conservative)', () => {
  // 第一处出现在干净子句、第二处出现在否定子句 → 否定侧。
  assert.equal(polarityAt('部署窗口照旧，别改部署窗口', '部署窗口'), true)
})

// —— §4.8 negationPolarity（整文本口径，原样保留）——

test('negationPolarity: whole-text ruler unchanged', () => {
  assert.equal(negationPolarity('不发告警'), true)
  assert.equal(negationPolarity('每次都发告警'), false)
})

// —— §4.8 globalConflictCheck：锚点化 negation 分支 ——

// 误报修复对。实测 pairFeatures：charDice=0.625（≥0.55，走到 negation 分支）、
// containment=0（不触发豁免）、titleDice=0.333（<0.8，value 分支也不触发）。
// 旧口径下 a 侧整文本带「别」→ negationPolarity 为 true，b 侧 false → 误报
// 'negation'；新口径锚点（共享 token 里最长的 3 字 trigram）落在干净子句 → null。
test('globalConflictCheck: negation in an unrelated clause is no longer a conflict', () => {
  const a = { title: '备份日程', content: '项目截止日期是5月1日，别忘了' }
  const b = { title: '备份周期', content: '项目截止日期是5月10日' }
  const features = pairFeatures(a, b)
  // 门槛自证：这条用例确实走进了被改造的 negation 分支，且旧口径会误报。
  assert.ok(features.charDice >= 0.55 && features.charDice < 0.95, `charDice ${features.charDice}`)
  assert.ok(features.containment < 0.92, `containment ${features.containment}`)
  assert.notEqual(negationPolarity(a.content), negationPolarity(b.content), 'old ruler would flag this pair')
  assert.equal(globalConflictCheck(a, b), null)
})

// 真阳性保持对（与 curator-pairing 既有断言同一对，独立再放一份）。实测
// charDice=0.7568（≥0.55）、titleDice=0.333；锚点落在唯一子句，b 侧「不」
// 单标记 → 否定侧，a 侧无标记 → 极性不同 → 仍报 'negation'。
test('globalConflictCheck: same-clause negation stays a conflict (true positive)', () => {
  const a = { title: '告警偏好', content: '用户希望每次部署失败都发告警通知' }
  const b = { title: '告警设置', content: '用户不希望每次部署失败都发告警通知' }
  const features = pairFeatures(a, b)
  assert.ok(features.charDice >= 0.55 && features.charDice < 0.95, `charDice ${features.charDice}`)
  assert.equal(globalConflictCheck(a, b), 'negation')
})

// 双重否定对。实测 charDice=0.6875（≥0.55）；共享 token 最长者落在「不是
// 不喜欢」子句（「我对香菜」trigram），标记计数 2 → 偶数翻回肯定 → 双侧同
// 极性 → 不再误报。旧口径 a 侧整文本带「不」→ 误报 'negation'。
test('globalConflictCheck: double negation is not a conflict', () => {
  const a = { title: '饮食偏好', content: '我对香菜不是不喜欢，是能接受的' }
  const b = { title: '口味偏好', content: '我对香菜是喜欢，是能接受的' }
  const features = pairFeatures(a, b)
  assert.ok(features.charDice >= 0.55 && features.charDice < 0.95, `charDice ${features.charDice}`)
  assert.ok(features.containment < 0.92, `containment ${features.containment}`)
  assert.notEqual(negationPolarity(a.content), negationPolarity(b.content), 'old ruler would flag this pair')
  assert.equal(globalConflictCheck(a, b), null)
})

// 无共享锚点回退。实测 charDice=0.8333（≥0.55），但 tokenize 无任何共享 token
// （ab-cd vs ab / cd、ef-gh vs ef / gh，latin 连接符只在整 token 时保留）→
// 锚点为空 → 回退整文本 negationPolarity 对比 → b 侧 'not' → 仍报 'negation'。
test('globalConflictCheck: no shared token falls back to the whole-text ruler', () => {
  const a = { title: 'note', content: 'ab-cd ef gh' }
  const b = { title: 'note2', content: 'ab cd ef-gh not' }
  const features = pairFeatures(a, b)
  assert.ok(features.charDice >= 0.55 && features.charDice < 0.95, `charDice ${features.charDice}`)
  assert.notEqual(negationPolarity(a.content), negationPolarity(b.content), 'b side carries "not"')
  assert.equal(globalConflictCheck(a, b), 'negation')
})

test('globalConflictCheck: deterministic — same pair, same verdict twice', () => {
  const a = { title: '告警偏好', content: '用户希望每次部署失败都发告警通知' }
  const b = { title: '告警设置', content: '用户不希望每次部署失败都发告警通知' }
  assert.equal(globalConflictCheck(a, b), globalConflictCheck(a, b))
  const c = { title: '备份日程', content: '项目截止日期是5月1日，别忘了' }
  const d = { title: '备份周期', content: '项目截止日期是5月10日' }
  assert.deepEqual([globalConflictCheck(c, d), globalConflictCheck(c, d)], [null, null])
})
