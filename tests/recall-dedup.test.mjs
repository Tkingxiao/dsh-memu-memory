import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'

// Fact-level dedup .
// No engine, no download: the MemU boundary is replaced before any production
// module is imported, exactly like tests/managed-memory.test.mjs does.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-recall-dedup-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

let semanticFiles = []
const commitCalls = []
globalThis.__recallDedupTest = {
  async commit(args) { commitCalls.push(args); return { ok: true } },
  async retrieve() {
    return { files: semanticFiles.map((name) => ({ name })), segments: [], resources: [], raw: null }
  },
  async forget() { return { deleted: 1, segments: 1 } },
  async listFiles() { return { recall_files: [], resources: [], raw: null } },
}
const engineSource = 'const bridge = globalThis.__recallDedupTest; export const commit = bridge.commit, retrieve = bridge.retrieve, forget = bridge.forget, listFiles = bridge.listFiles;'
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './memu.js') {
      return { url: 'data:text/javascript,' + encodeURIComponent(engineSource), shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const state = await import('../lib/state.js')
const paths = await import('../lib/paths.js')
const memory = await import('../lib/memory.js')
const activity = await import('../lib/activity-log.js')
const similarity = await import('../lib/text-similarity.js')

const BODY_A = '项目部署约定：每周四凌晨两点到四点是固定的部署窗口，窗口内只允许灰度发布，全量上线要等值班的人确认监控没有异常之后才能继续，紧急修复也要先在群里报备。'
const BODY_B = BODY_A.slice(0, 55) + '变更流程另见发布手册第四章，联系人轮值表每月更新一次，遇到节假日的调整以公告为准，请留意。'
const REAL_A = '每个月的报销单要在最后一个工作日之前提交，超期的票据并入下月批次，特殊情况提前找主管签批。'
const CLUSTER_TITLES = ['部署窗口约定', '部署窗口的约定', '上线窗口约定', '窗口约定', '部署约定', '发布窗口约定',
  '灰度窗口约定', '窗口时间约定', '部署时段约定', '上线时段约定', '发布时段约定', '灰度发布约定']

let serial = 0
function entry(title, content, extra = {}) {
  return { status: 'active', title, content, layer: 'long_term', strength: 1,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...extra }
}
function fixture(entries = {}) {
  serial += 1
  const sessionId = 'dedup-' + serial
  const cwd = path.join(home, 'project-' + serial)
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  state.setSessionBinding(sessionId, { useLibrary: true, useGlobal: true, domainOverride: 'coding' })
  state.savePrivateIndex(binding.libraryId, { entries })
  return { sessionId, libraryId: binding.libraryId, exec: { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding' } } } } }
}
const clusterEntries = (titles) => Object.fromEntries(titles.map((title, i) => ['mem-dup' + (i + 1), entry(title, BODY_A)]))

test.beforeEach(() => {
  semanticFiles = []
  commitCalls.length = 0
  state.updateSettings({ memoryBackend: 'api', vectorSource: 'api', relevanceThreshold: 0, privateTopK: 5 })
})

test('shared metric module: constants and preprocessing stay in one place', () => {
  assert.equal(similarity.DUP_DICE, 0.82)
  assert.equal(similarity.TOPIC_DICE, 0.55)
  assert.equal(similarity.DUP_REJECT_DICE, 0.90)
  assert.equal(similarity.dice(similarity.bigrams(''), similarity.bigrams('x')), 0)
  // Same preprocessing as the old findConflict ruler: punctuation and case are noise.
  assert.equal(similarity.dice(similarity.bigrams('Hello, WORLD!'), similarity.bigrams('hello world')), 1)
  assert.ok(similarity.lengthGap('aaaa', 'aa') <= 0.5)
  assert.ok(similarity.lengthGap('aaaaa', 'aa') > 0.5)
  // Length pruning: a pair this unequal can never reach the reject band, so it is
  // reported as 0 without building bigrams at all.
  assert.equal(similarity.similarTexts('a'.repeat(100), 'b'), 0)
  assert.equal(similarity.similarTexts(BODY_A, BODY_A), 1)
})

test('three near-duplicates leave one seat and both real memories stay in top5', async () => {
  const f = fixture({
    ...clusterEntries(CLUSTER_TITLES.slice(0, 3)),
    'mem-realA': entry('报销截止日', REAL_A),
    'mem-realB': entry('值班接龙安排', '每周四凌晨的值班安排要提前一天在群里接龙，缺席要找替班的人。'),
  })
  semanticFiles = ['mem-dup1', 'mem-dup2', 'mem-dup3', 'mem-realA', 'mem-realB']
  const result = await memory.privateRecall({ exec: f.exec, query: '部署窗口', topK: 5 })
  // Assertions land on concrete ids (§1.10): exactly one cluster member survives,
  // and both real memories are recalled, not crowded out.
  assert.deepEqual(result.files.map((file) => file.name), ['mem-dup1', 'mem-realA', 'mem-realB'])
  assert.deepEqual(result.dedup.collapsed, [{ kept: 'mem-dup1', dropped: ['mem-dup2', 'mem-dup3'] }])
  assert.equal(result.dedup.clusterCount, 1)
  // The observation signal must exist and name the survivors (§13.5 观测).
  const event = activity.listEvents({ kind: 'recall' }).find((e) => e.detail?.clusterCount >= 1)
  assert.ok(event, 'a recall event with dedup detail must be recorded')
  assert.deepEqual(event.detail.collapsed, [{ kept: 'mem-dup1', dropped: ['mem-dup2', 'mem-dup3'] }])
})

test('a vector leg returning 12 same-cluster hits cannot starve real candidates (fold ①)', () => {
  const titles = CLUSTER_TITLES
  const index = { entries: { ...clusterEntries(titles), 'mem-realA': entry('报销截止日', REAL_A), 'mem-realB': entry('独立事实', '另一件完全不同的事情，关于差旅住宿发票的开具流程与注意事项。') } }
  const fused = memory.fuseRecallCandidates({
    local: [],
    semantic: [...titles.map((_, i) => ({ name: 'mem-dup' + (i + 1) })), { name: 'mem-realA' }, { name: 'mem-realB' }],
    index,
    limit: memory.hybridCandidateLimit(3), // 12: without folding the reals are cut here
  })
  assert.equal(fused.debug.candidateLimit, 12)
  assert.equal(fused.files.length, 3)
  assert.ok(fused.files.some((file) => file.name === 'mem-realA'), 'real candidate must survive the cap')
  assert.ok(fused.files.some((file) => file.name === 'mem-realB'))
  assert.equal(fused.files.filter((file) => file.name.startsWith('mem-dup')).length, 1)
  assert.deepEqual(fused.debug.collapsed, [{ kept: 'mem-dup1', dropped: titles.slice(1).map((_, i) => 'mem-dup' + (i + 2)) }])
  assert.equal(fused.files[0].mergedTogether, undefined, 'fold ① is candidate-level; mergedTogether belongs to fold ②')
})

test('the same fact arriving on both legs is folded once, keeping the highest-rrf id (fold ②)', () => {
  const index = { entries: {
    'mem-dup1': entry('部署窗口约定', BODY_A),
    'mem-dup3': entry('上线窗口约定', BODY_A),
    'mem-other': entry('独立事实', '另一件完全不同的事情，关于差旅住宿发票的开具流程与注意事项。'),
  } }
  const fused = memory.fuseRecallCandidates({
    local: [{ name: 'mem-dup1' }, { name: 'mem-other' }],
    semantic: [{ name: 'mem-dup3' }],
    index,
    limit: 12,
  })
  assert.deepEqual(fused.files.map((file) => file.name), ['mem-dup1', 'mem-other'])
  assert.deepEqual(fused.files[0].mergedTogether, ['mem-dup3'])
  assert.deepEqual(fused.debug.collapsed, [{ kept: 'mem-dup1', dropped: ['mem-dup3'] }])
})

test('a write with dice ≈ 0.93 is refused as a duplicate and the library does not grow', async () => {
  const f = fixture()
  const first = await memory.privateRemember({ exec: f.exec, title: '部署窗口约定', content: BODY_A })
  const measured = similarity.dice(similarity.bigrams('部署窗口的约定 ' + BODY_A), similarity.bigrams('部署窗口约定 ' + BODY_A))
  assert.ok(measured >= 0.90, 'fixture pair must sit in the reject band, got ' + measured)
  const second = await memory.privateRemember({ exec: f.exec, title: '部署窗口的约定', content: BODY_A })
  assert.equal(second.deduped, true)
  assert.equal(second.existingId, first.id)
  assert.match(second.hint, /memu_private_update/)
  const index = state.loadPrivateIndex(f.libraryId)
  assert.equal(Object.keys(index.entries).length, 1, 'the duplicate write must not land in the library')
  assert.equal(index.entries[first.id].content, BODY_A, 'the original must be untouched')
  const written = activity.listEvents({ kind: 'write' })[0]
  assert.match(written.message, /拒绝重复写入/)
  assert.equal(written.detail.existingId, first.id)
})

test('a write with dice ≈ 0.60 creates a new entry tagged duplicateOf', async () => {
  const f = fixture()
  const first = await memory.privateRemember({ exec: f.exec, title: '部署窗口约定', content: BODY_A })
  const measured = similarity.dice(similarity.bigrams('部署安排与变更 ' + BODY_B), similarity.bigrams('部署窗口约定 ' + BODY_A))
  assert.ok(measured >= 0.55 && measured < 0.90, 'fixture pair must sit in the tag band, got ' + measured)
  const second = await memory.privateRemember({ exec: f.exec, title: '部署安排与变更', content: BODY_B })
  assert.notEqual(second.id, first.id)
  assert.equal(second.deduped, undefined)
  assert.equal(second.entry.duplicateOf, first.id)
  assert.equal(second.entry.status, 'active')
  const index = state.loadPrivateIndex(f.libraryId)
  assert.equal(Object.keys(index.entries).length, 2, 'a tagged entry is still written')
  assert.equal(index.entries[second.id].duplicateOf, first.id)
})

// Length-gap bypass : padding a short
// memory into a much longer rewrite used to skip the comparison entirely — the
// prune reported 0 and the duplicate landed. Two containment probes close it.
test('containment probes catch length-disparate pairs that plain dice cannot see', () => {
  const short = '他只喝黑咖啡不加糖'
  // Probe 1 fires: the short cleaned text is a verbatim substring of the long one.
  const appended = short + '，从小就是这样，早上晚上各一杯，出差也自带豆子。'
  assert.ok(similarity.lengthGap(short, appended) > similarity.LENGTH_PRUNE_RATIO)
  assert.equal(similarity.similarTexts(short, appended), similarity.CONTAINMENT_FLOOR)
  // Probe 2 fires: every short-side bigram occurs in the long text, but the short
  // text itself is not contiguous in it (咖啡从不… breaks the verbatim containment;
  // the spanning 啡不 junction appears in the tail clause instead).
  const reworded = '他只喝黑咖啡，从不加糖也不加奶，只喝黑咖啡不加糖。'
  assert.ok(!similarity.clean(reworded).includes(similarity.clean(short)), 'fixture must not be a verbatim containment')
  assert.equal(similarity.similarTexts(short, reworded), similarity.CORE_COVER_FLOOR)
  // Unrelated long text: probe fails fast on the first absent bigram.
  assert.equal(similarity.similarTexts(short, '图书馆周三下午闭馆整理新到的书，借阅上限是五本。'), 0)
  // Probe budget: a tiny short side has too little signal to reject a write on.
  assert.equal(similarity.similarTexts('a'.repeat(100), 'b'), 0)
  // Within the prune ratio nothing changed: dice stays the only ruler.
  assert.equal(similarity.similarTexts(BODY_A, BODY_A), 1)
})

test('a short memory padded into a much longer rewrite is refused, not slipped past the gate', async () => {
  const f = fixture()
  const first = await memory.privateRemember({ exec: f.exec, content: '他只喝黑咖啡' })
  const padded = '他只喝黑咖啡。他从小到大就只喝黑咖啡，早上要喝一杯，晚上也要喝一杯，加班的时候更要喝，出去吃饭也只点黑咖啡，从来不加糖也从不加奶，换过很多家咖啡馆都一样。'
  // Prove this is a genuine prune-band bypass pair: plain dice sits far below
  // even the tag band, and the raw length gap exceeds the prune ratio.
  const unit1 = '他只喝黑咖啡 他只喝黑咖啡'
  const unit2 = padded + ' ' + padded
  const plainDice = similarity.dice(similarity.bigrams(unit1), similarity.bigrams(unit2))
  assert.ok(plainDice < 0.55, 'plain dice must miss this pair, got ' + plainDice)
  assert.ok(similarity.lengthGap(unit1, unit2) > similarity.LENGTH_PRUNE_RATIO, 'the pair must sit in the pruned band')
  const second = await memory.privateRemember({ exec: f.exec, content: padded })
  assert.equal(second.deduped, true)
  assert.equal(second.existingId, first.id)
  assert.ok(second.similarity >= similarity.DUP_REJECT_DICE, 'the probe floor lands in the reject band, got ' + second.similarity)
  const index = state.loadPrivateIndex(f.libraryId)
  assert.equal(Object.keys(index.entries).length, 1, 'the padded rewrite must not land in the library')
})

test('a genuinely different longer fact against a short entry is still written', async () => {
  const f = fixture()
  const first = await memory.privateRemember({ exec: f.exec, content: '他只喝黑咖啡' })
  const second = await memory.privateRemember({ exec: f.exec, content: '图书馆周三下午闭馆整理新书，借阅上限是五本，超期按天收取滞纳金，续借要在到期日之前操作。' })
  assert.equal(second.deduped, undefined)
  assert.notEqual(second.id, first.id)
  assert.equal(second.entry.duplicateOf, undefined, 'an unrelated fact is not tagged as a duplicate')
  const index = state.loadPrivateIndex(f.libraryId)
  assert.equal(Object.keys(index.entries).length, 2)
})

test('allowDuplicate: true writes a second independent observation without a tag', async () => {
  const f = fixture()
  const first = await memory.privateRemember({ exec: f.exec, title: '部署窗口约定', content: BODY_A })
  const second = await memory.privateRemember({ exec: f.exec, title: '部署窗口的约定', content: BODY_A, allowDuplicate: true })
  assert.notEqual(second.id, first.id)
  assert.equal(second.deduped, undefined)
  assert.equal(second.entry.duplicateOf, undefined)
  const index = state.loadPrivateIndex(f.libraryId)
  assert.equal(Object.keys(index.entries).length, 2)
})

test('same title + clearly different body still lands as pending_review, not deduped', async () => {
  const f = fixture()
  const first = await memory.privateRemember({ exec: f.exec, title: 'ZK', content: 'alpha body text one' })
  const second = await memory.privateRemember({ exec: f.exec, title: 'ZK', content: 'alpha body text two' })
  // The conflict gate must win: a contradictory same-title rewording is a held
  // claim for review, never a silent duplicate swallow (§13.5 顺序约束).
  assert.equal(second.conflict, first.id)
  assert.equal(second.entry.status, 'pending_review')
  assert.equal(second.entry.duplicateOf, undefined)
  assert.equal(second.deduped, undefined)
})

test('negation conflicts survive the duplicate gate byte-for-byte', async () => {
  const f = fixture()
  const first = await memory.privateRemember({ exec: f.exec, title: '行踪', content: '周五下午他不在家' })
  const second = await memory.privateRemember({ exec: f.exec, title: '行踪记录', content: '周五下午他在家' })
  const measured = similarity.dice(similarity.bigrams('周五下午他不在家'), similarity.bigrams('周五下午他在家'))
  assert.ok(measured >= 0.55, 'the pair must clear the topic band so the legacy branch fires')
  assert.equal(second.conflict, first.id)
  assert.match(second.entry.reviewReason, /说法相反/)
  assert.equal(second.entry.status, 'pending_review')
  assert.equal(second.deduped, undefined)
})

test('the lexical route folds its cluster at the ranking stage and reports it (fold ③)', async () => {
  const f = fixture({
    ...clusterEntries(CLUSTER_TITLES.slice(0, 3)),
    'mem-realA': entry('部署值班安排', '每周四凌晨的部署值班要提前一天在群里接龙，缺席要找替班的人。'),
  })
  state.updateSettings({ memoryBackend: 'agent' })
  try {
    // No semantic leg runs on the agent backend, so folds ①/② never see these —
    // mmrSelect's hard skip is the only seat limit left for the lexical route.
    const result = await memory.privateRecall({ exec: f.exec, query: '部署窗口', topK: 5 })
    assert.deepEqual(result.files.map((file) => file.name), ['mem-dup1', 'mem-realA'])
    assert.deepEqual(result.dedup.collapsed, [{ kept: 'mem-dup1', dropped: ['mem-dup2', 'mem-dup3'] }])
    assert.equal(result.fusion, undefined, 'the lexical route has no fusion stage')
    const event = activity.listEvents({ kind: 'recall' }).find((e) => e.detail?.clusterCount >= 1)
    assert.ok(event, 'the lexical fold must be observable too')
  } finally {
    state.updateSettings({ memoryBackend: 'api' })
  }
})

test('an entry tagged duplicateOf is recalled below the original it copies', async () => {
  const f = fixture({
    'mem-x': entry('咖啡偏好', '他只喝黑咖啡，不加糖。'),
    'mem-y': entry('咖啡口味', '他只喝拿铁，加燕麦奶。', { duplicateOf: 'mem-x', updatedAt: '2026-10-02T00:00:00.000Z' }),
  })
  // Both legs rank mem-y first (fresher + listed first): without the 0.7 factor
  // the tagged copy would outrank the memory it duplicates.
  semanticFiles = ['mem-y', 'mem-x']
  const result = await memory.privateRecall({ exec: f.exec, query: '咖啡', topK: 5 })
  assert.deepEqual(result.files.map((file) => file.name), ['mem-x', 'mem-y'])
  assert.equal(result.files[1].entry.duplicateOf, 'mem-x')
  assert.equal(result.dedup.clusterCount, 0, 'the pair is below the fold threshold; only the down-weight applies')
})

// ---------------------------------------------------------------- update/review gate
// 写入侧近似门同样盖住 privateUpdate 与 review accept：
// 把旧记忆改写成与另一条几乎相同、或接受一条与库内第三条几乎相同的复核，都不能
// 从这两条路径绕开写入侧的门。口径与 remember 相同：≥ 0.90 拒绝，[0.55, 0.90) 打标。
const BODY_DEPLOY = '每周四凌晨两点到四点是固定的部署窗口，窗口内只允许灰度发布，全量上线要等值班的人确认监控平稳之后才能继续。'
const BODY_COFFEE = '茶水间的咖啡机每天下午三点以后免费使用，用完要自己清洗滤网并补充咖啡豆。'

test('updating a memory into a near-duplicate of another entry is refused, not merged', async () => {
  const f = fixture({
    'mem-host': entry('部署窗口约定', BODY_DEPLOY),
    'mem-t': entry('占位记录', '这条只是个占位，与部署无关。'),
  })
  await assert.rejects(
    memory.privateUpdate({ exec: f.exec, libraryId: f.libraryId, id: 'mem-t', content: BODY_DEPLOY }),
    (error) => {
      assert.match(error.message, /update refused/)
      assert.match(error.message, /mem-host/, 'the refusal must name the existing entry')
      return true
    },
  )
  const index = state.loadPrivateIndex(f.libraryId)
  assert.equal(index.entries['mem-t'].content, '这条只是个占位，与部署无关。', 'the refused update changes nothing')
  assert.equal(index.entries['mem-host'].content, BODY_DEPLOY, 'the existing entry is untouched')
  assert.equal(commitCalls.length, 0, 'the refusal happens before any backend commit')
  const event = activity.listEvents({ kind: 'write' }).find((item) => item.detail?.deduped === true && item.detail?.id === 'mem-t')
  assert.ok(event, 'the refusal must be observable in the activity log')
  assert.equal(event.detail.existingId, 'mem-host')
})

test('rewriting an entry close to its own previous text is not a duplicate (self excluded)', async () => {
  const f = fixture({
    'mem-t': entry('占位记录', '这条只是个占位，内容与部署无关，写得随便一点。'),
  })
  const result = await memory.privateUpdate({
    exec: f.exec, libraryId: f.libraryId, id: 'mem-t',
    content: '这条只是个占位，内容与部署无关，写得随便一些。',
  })
  assert.equal(result.entry.content, '这条只是个占位，内容与部署无关，写得随便一些。')
  assert.equal(result.entry.duplicateOf, undefined)
})

test('an update landing in the topic band tags duplicateOf instead of refusing', async () => {
  const f = fixture({
    'mem-host': entry('部署窗口约定', BODY_DEPLOY),
    'mem-t': entry('占位记录', '这条只是个占位，与部署无关。'),
  })
  const measured = similarity.dice(
    similarity.bigrams('占位记录 ' + BODY_DEPLOY.slice(0, 40) + '变更流程另见发布手册第四章，联系人轮值表每月更新一次。'),
    similarity.bigrams('部署窗口约定 ' + BODY_DEPLOY),
  )
  assert.ok(measured >= 0.55 && measured < 0.90, 'fixture pair must sit in the tag band, got ' + measured)
  const result = await memory.privateUpdate({
    exec: f.exec, libraryId: f.libraryId, id: 'mem-t',
    content: BODY_DEPLOY.slice(0, 40) + '变更流程另见发布手册第四章，联系人轮值表每月更新一次。',
  })
  assert.equal(result.entry.status, 'active')
  assert.equal(result.entry.duplicateOf, 'mem-host')
})

test('an update may keep converging on the entry it is already tagged duplicateOf', async () => {
  const f = fixture({
    'mem-host': entry('咖啡口味', '他只喝黑咖啡，从不加糖也从不加奶，只喝现磨的。'),
    'mem-copy': entry('口味备注', '他只喝黑咖啡。', { duplicateOf: 'mem-host' }),
  })
  const result = await memory.privateUpdate({
    exec: f.exec, libraryId: f.libraryId, id: 'mem-copy',
    content: '他只喝黑咖啡，不加糖也不加奶。',
  })
  assert.equal(result.entry.duplicateOf, 'mem-host', 'the tag survives: the text is still on-topic with the host')
  // Rewriting to an unrelated fact drops the basis of the tag, so the stale tag goes.
  const rewritten = await memory.privateUpdate({
    exec: f.exec, libraryId: f.libraryId, id: 'mem-copy',
    content: '图书馆周三下午闭馆整理新书，借阅上限是五本，超期按天收取滞纳金。',
  })
  assert.equal(rewritten.entry.duplicateOf, undefined, 'a tag whose textual basis is gone must not stay')
})

test('review accept that would duplicate a third entry is refused and the review stays pending', async () => {
  const f = fixture({
    'mem-third': entry('茶水间约定', BODY_COFFEE),
    'mem-c': entry('部署窗口约定', BODY_DEPLOY),
    'mem-p': entry('茶水间的约定', '茶水间自动售货机经常卡币的说法待定。', { status: 'pending_review', conflictingWith: 'mem-c', reviewReason: 'conflict' }),
  })
  await assert.rejects(
    memory.resolveMemoryReview({ libraryId: f.libraryId, id: 'mem-p', action: 'accept', content: BODY_COFFEE }),
    (error) => {
      assert.match(error.message, /review accept refused/)
      assert.match(error.message, /mem-third/)
      return true
    },
  )
  const index = state.loadPrivateIndex(f.libraryId)
  assert.equal(index.entries['mem-p'].status, 'pending_review', 'the review stays resolvable')
  assert.equal(index.entries['mem-c'].status, 'active', 'a refused accept supersedes nothing')
})

test('review accept in the topic band lands active tagged duplicateOf; replace semantics unchanged', async () => {
  const f = fixture({
    'mem-third': entry('茶水间约定', BODY_COFFEE),
    'mem-c': entry('部署窗口约定', BODY_DEPLOY),
    'mem-p': entry('茶水间自动售货', '茶水间的自动售货机经常卡币。', { status: 'pending_review', conflictingWith: 'mem-c', reviewReason: 'conflict' }),
  })
  const accepted = await memory.resolveMemoryReview({
    libraryId: f.libraryId, id: 'mem-p', action: 'accept',
    content: '茶水间的咖啡机下午三点以后不用付费，用完要自己清洗滤网。',
  })
  assert.equal(accepted.status, 'active')
  const index = state.loadPrivateIndex(f.libraryId)
  assert.equal(index.entries['mem-p'].duplicateOf, 'mem-third')
  assert.equal(index.entries['mem-c'].status, 'superseded', 'resolution=replace still supersedes the conflicting entry')
  assert.equal(index.entries['mem-p'].supersedes, 'mem-c')
})

test('review accept matching only its own conflictingWith entry is not a duplicate', async () => {
  const f = fixture({
    'mem-c': entry('部署窗口约定', BODY_DEPLOY),
    'mem-p': entry('部署窗口的复核', '这是待复核的另一个说法。', { status: 'pending_review', conflictingWith: 'mem-c', reviewReason: 'conflict' }),
  })
  const accepted = await memory.resolveMemoryReview({
    libraryId: f.libraryId, id: 'mem-p', action: 'accept', content: BODY_DEPLOY,
  })
  assert.equal(accepted.status, 'active')
  const index = state.loadPrivateIndex(f.libraryId)
  assert.equal(index.entries['mem-p'].duplicateOf, undefined)
  assert.equal(index.entries['mem-c'].status, 'superseded')
})
