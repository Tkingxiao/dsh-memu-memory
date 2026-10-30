// 独立验收：按 docs/emotion-model-spec.md v3 §8 写的一组黑盒契约测试。
//
// 这些断言只走公开入口（lib/mood.js 的纯函数、lib/state.js 的会话 mood、
// lib/memory.js 的写入/更新/召回），不读实现私有字段，也不为了迁就现有行为
// 而放宽期望：实现与 spec 不一致时，这里就应该失败。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-emotion-contract-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const mood = await import('../lib/mood.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

const AXES = ['joy', 'anger', 'sorrow', 'fear']
const shareSum = (emotion) => AXES.reduce((total, axis) => total + Number(emotion[axis]), 0)
const close = (a, b, epsilon = 1e-9) => Math.abs(a - b) < epsilon
const emptyEmotion = () => ({ joy: 0, anger: 0, sorrow: 0, fear: 0 })

function execFor(sessionId, cwd) {
  return { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding' } } } }
}

function setup(name) {
  const cwd = path.join(home, 'proj-' + name)
  const sessionId = 'emotion-' + name
  const binding = state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  return { cwd, sessionId, binding, exec: execFor(sessionId, cwd) }
}

function entryOf(binding, id) {
  return state.loadPrivateIndex(binding.libraryId).entries[id]
}

/**
 * 反解一个让 fade 正好等于 target 的时刻。
 *
 * fade = 0.5 ** (minutes / 90)，所以先求出实数解，再在相邻 double 上搜一个
 * 让 Math.pow 的结果精确落在 target 上的取值——「fade === 0.35 仍保留」这条
 * 边界只有拿到精确相等才验证得了。
 */
function timeAtFade(target) {
  const base = (Math.log(target) / Math.log(0.5)) * 90 * 60_000
  for (let i = -20_000; i <= 20_000; i += 1) {
    const now = base + i * Number.EPSILON * base
    if (Math.pow(0.5, (now / 60_000) / 90) === target) return now
  }
  return null
}

// ---- §8 第一条：归一化 ----

test('normalizeEmotion 归一后和为 1，所有分量非负', () => {
  const samples = [
    { joy: 3, anger: 1, sorrow: 0, fear: 0 },
    { joy: 0.1, anger: 0.2, sorrow: 0.3, fear: 0.4 },
    { joy: 0.0001, anger: 0.0002, sorrow: 0.0003, fear: 0.0004 },
    { joy: 1_000_000, anger: 1, sorrow: 1, fear: 1 },
  ]
  for (const raw of samples) {
    const normalized = mood.normalizeEmotion(raw)
    assert.ok(normalized && typeof normalized === 'object', `合法输入 ${JSON.stringify(raw)} 必须归一化成一个对象`)
    for (const axis of AXES) {
      assert.ok(Number.isFinite(normalized[axis]), `归一化后的 ${axis} 必须是有限数，否则下游 valence/overlap 会传播 NaN`)
      assert.ok(normalized[axis] >= 0, `归一化后的 ${axis} 不得为负：负数只能来自调用方 bug，不能在这里被 clamp 成合法值`)
    }
    assert.ok(
      Math.abs(shareSum(normalized) - 1) < 1e-9,
      `构成必须落在单纯形上（误差 < 1e-9），实际 sum=${shareSum(normalized)}；份额不归一，overlap 就不再有 [0,1] 的语义`,
    )
  }
  assert.ok(close(mood.normalizeEmotion({ joy: 3, anger: 1, sorrow: 0, fear: 0 }).joy, 0.75, 1e-12))
})

test('normalizeEmotion 拒绝缺键、负数、非有限数、数组和字符串，错误信息含 emotion', () => {
  const cases = [
    ['缺少 joy 键', { anger: 1, sorrow: 0, fear: 0 }],
    ['joy 为负数', { joy: -1, anger: 2, sorrow: 0, fear: 0 }],
    ['joy 为 NaN', { joy: NaN, anger: 1, sorrow: 0, fear: 0 }],
    ['fear 为 Infinity', { joy: 1, anger: 0, sorrow: 0, fear: Infinity }],
    ['传入数组', [1, 0, 0, 0]],
    ['传入字符串', 'joy:1'],
    ['轴是字符串数字', { joy: '1', anger: 0, sorrow: 0, fear: 0 }],
    ['传入数字', 1],
  ]
  for (const [label, input] of cases) {
    assert.throws(
      () => mood.normalizeEmotion(input),
      /emotion/,
      `${label} 必须被拒绝，且错误里要出现 emotion：静默修复会把调用方 bug 永久藏起来`,
    )
  }
  // null / undefined 是规范的中性表示，不是非法输入。
  assert.strictEqual(mood.normalizeEmotion(null), null)
  assert.strictEqual(mood.normalizeEmotion(undefined), null)
})

test('全零输入规范化为 null，不会被当成均匀分布', async () => {
  const zero = mood.normalizeEmotion(emptyEmotion())
  assert.strictEqual(zero, null, '全零代表「明确中性」；返回 {0.25,0.25,0.25,0.25} 会让召回把中性当成一种情绪')
  assert.notDeepEqual(zero, { joy: 0.25, anger: 0.25, sorrow: 0.25, fear: 0.25 })

  // 会话读数和条目写入都必须走同一个规范化，而不是各写一份。
  const { sessionId, exec, binding } = setup('zeros')
  state.setSessionMood(sessionId, { emotion: emptyEmotion(), arousal: 0.35, dominance: 0 })
  assert.strictEqual(state.getSessionMood(sessionId).emotion, null, 'setSessionMood 也要把全零折成 null')

  const { id } = await memory.privateRemember({ exec, content: 'The invoice is due on the fourteenth.', title: 'invoice', emotion: emptyEmotion() })
  assert.strictEqual(entryOf(binding, id).emotion, null, '写入路径同样不得把全零存成四轴均匀分布')
})

// ---- §8 第二条：派生 valence ----

test('四个纯轴的派生 valence 方向正确且量级一致（统一系数 0.8）', () => {
  const pureAxis = (axis) => ({ ...emptyEmotion(), [axis]: 1 })

  const joyValence = mood.derivedValence(pureAxis('joy'))
  assert.ok(joyValence > 0, '纯喜悦必须投影为正，否则旧路径的快乐记忆会被推下去')
  assert.ok(close(joyValence, 0.8, 1e-12), `纯轴的系数是 0.8，实际 ${joyValence}`)

  for (const axis of ['anger', 'sorrow', 'fear']) {
    const valence = mood.derivedValence(pureAxis(axis))
    assert.ok(valence < 0, `纯 ${axis} 必须投影为负；愤怒不是「轻微正面」，它和悲伤一样往下拉`)
    assert.ok(close(Math.abs(valence), Math.abs(joyValence), 1e-12), `纯 ${axis} 的量级必须与纯 joy 一致`)
  }

  // 复合结果按 spec 的公式可复算：0.8*(joy - anger - sorrow - fear)
  assert.ok(close(mood.derivedValence({ joy: 0.5, anger: 0, sorrow: 0.5, fear: 0 }), 0, 1e-12), 'joy 0.5 + sorrow 0.5 必须互相抵消为 0')
  assert.ok(close(mood.derivedValence({ joy: 0.75, anger: 0.25, sorrow: 0, fear: 0 }), 0.4, 1e-12), '0.8*(0.75-0.25)=0.4，复合轴要能逐项复算')
  assert.ok(close(mood.derivedValence(mood.normalizeEmotion({ joy: 3, anger: 1, sorrow: 0, fear: 0 })), 0.4, 1e-12), '归一化后的构成同样要能复算')
})

// ---- §8 第三条：overlap ----

test('overlap 自反、对称、落在 [0,1]，不相交与 null 输入为 0', () => {
  const p = { joy: 0.5, anger: 0.5, sorrow: 0, fear: 0 }
  const q = { joy: 0.2, anger: 0.3, sorrow: 0.5, fear: 0 }
  const disjoint = { joy: 0, anger: 0, sorrow: 0, fear: 1 }

  assert.ok(close(mood.overlap(p, p), 1, 1e-12), '自反：同一份心情必须 100% 重叠，否则「心情一致」永远拿不到满权重')
  assert.ok(close(mood.overlap(p, q), mood.overlap(q, p), 1e-12), '对称：p 对 q 与 q 对 p 必须相等')
  assert.ok(close(mood.overlap(p, q), 0.5, 1e-12), 'sum(min(p,q)) = min(.5,.2)+min(.5,.3) = 0.5')
  assert.strictEqual(mood.overlap(p, disjoint), 0, '没有任何共同轴时不能凭空产生重叠')
  assert.strictEqual(mood.overlap(null, p), 0, '没有情绪的一侧应被视为「无信号」，而不是 0.5')
  assert.strictEqual(mood.overlap(p, null), 0)
  assert.strictEqual(mood.overlap(null, null), 0)

  for (const [left, right] of [[p, q], [p, disjoint], [q, disjoint], [p, p]]) {
    const value = mood.overlap(left, right)
    assert.ok(value >= 0 && value <= 1, `overlap 必须落在 [0,1]，实际 ${value}；它直接乘进 moodBias，越界就会放大成排序事故`)
  }
})

// ---- §8 第四条：bias 界 ----

test('dominanceBias 始终落在 [0.9,1.1]，缺失或非法值是 1 而不是 NaN', () => {
  for (const entryDominance of [-1, -0.7, -0.2, 0, 0.4, 1]) {
    for (const contextDominance of [-1, -0.3, 0, 0.6, 1]) {
      const bias = mood.dominanceBias(entryDominance, contextDominance)
      assert.ok(Number.isFinite(bias), `dominanceBias(${entryDominance}, ${contextDominance}) 不能是 NaN`)
      assert.ok(bias >= 0.9 && bias <= 1.1, `dominanceBias 必须被限制在 [0.9,1.1]，实际 ${bias}`)
    }
  }
  assert.ok(close(mood.dominanceBias(0.3, 0.3), 1.1, 1e-12), '完全同向时取上界 1.1')
  assert.ok(close(mood.dominanceBias(-1, 1), 0.9, 1e-12), '完全反向时取下界 0.9')

  assert.strictEqual(mood.dominanceBias(undefined, 0.5), 1, '旧条目没有 dominance：这是「无信号」，不能参与打分')
  assert.strictEqual(mood.dominanceBias(null, 0.5), 1, 'spec §5.1：缺失的 dominance 必须是无信号；Number(null) === 0 会把它伪装成一个真实的「零掌控」读数')
  assert.strictEqual(mood.dominanceBias(0.5, NaN), 1, '非法 dominance 必须退回 1，绝不能把 NaN 乘进分数')
  assert.strictEqual(mood.dominanceBias(Infinity, 0), 1)
})

test('召回里的 moodBias 实测被限制在 [0.7,1.3]', async () => {
  const { sessionId, exec } = setup('mood-bias')
  const { id } = await memory.privateRemember({
    exec,
    content: 'The kestrel ledger was found under the ninth stair.',
    title: 'kestrel ledger',
    emotion: { joy: 0, anger: 0, sorrow: 1, fear: 0 },
    arousal: 0.35,
    // dominance 取 1、会话取 0：dominanceBias 恰好是 1（|1-0|/2 = 0.5），
    // 这样三次召回的分差里只剩 moodBias，不会混进 ±10% 的掌控感项。
    dominance: 1,
  })

  // 三次召回只改会话情绪，条目本身完全不变；因此分差只能来自 moodBias。
  // purpose=automatic 会跳过 touchAccess，accessCount 不会在三次之间变动。
  async function scoreWith(moodShape) {
    state.setSessionMood(sessionId, moodShape)
    const out = await memory.privateRecall({ exec, query: 'kestrel ledger ninth stair', topK: 1, relevanceThreshold: 0, purpose: 'automatic' })
    const hit = (out.files || []).find((file) => file.name === id)
    assert.ok(hit, '同一查询必须能召回这条记忆，否则比值无从谈起')
    return hit.score
  }

  const neutral = await scoreWith({ emotion: null, arousal: 0.35, dominance: 0 })
  const congruent = await scoreWith({ emotion: { joy: 0, anger: 0, sorrow: 1, fear: 0 }, arousal: 0.35, dominance: 0 })
  const incongruent = await scoreWith({ emotion: { joy: 1, anger: 0, sorrow: 0, fear: 0 }, arousal: 0.35, dominance: 0 })

  // 条目刚写入，fade 因子 ≈ 1，所以正向重叠应拿到 1+0.3，反向重叠应拿到 1-0.3。
  const up = congruent / neutral
  const down = incongruent / neutral
  assert.ok(up >= 0.7 && up <= 1.3, `moodBias 上界必须是 1.3，实测 ${up}`)
  assert.ok(down >= 0.7 && down <= 1.3, `moodBias 下界必须是 0.7，实测 ${down}`)
  assert.ok(close(up, 1.3, 0.005), `完全重叠时应接近 1.3，实测 ${up}；偏差过大说明公式或衰减因子被改动`)
  assert.ok(close(down, 0.7, 0.005), `完全相反时应接近 0.7，实测 ${down}`)
})

// ---- §8 第五条：门控 ----

test('emotionActive 真值表：null 只关闭第一腿，高 arousal / 高 dominance 仍开启', () => {
  const baseline = { emotion: null, arousal: 0.35, dominance: 0 }
  assert.strictEqual(mood.emotionActive(baseline), false, '全基线必须是关闭状态，否则每条记忆都带着无意义的情绪乘数')
  assert.strictEqual(mood.emotionActive(), false, '默认参数同样是全基线')

  assert.strictEqual(mood.emotionActive({ ...baseline, arousal: 0.9 }), true, 'null + 高 arousal 必须开启：紧张但没有明确好坏也是一种心情')
  assert.strictEqual(mood.emotionActive({ ...baseline, arousal: 0.05 }), true, '低于基线的 arousal 同样偏离休息位')
  assert.strictEqual(mood.emotionActive({ ...baseline, dominance: 0.3 }), true, 'null + 高 dominance 必须开启')
  assert.strictEqual(mood.emotionActive({ ...baseline, dominance: -0.4 }), true, '失控方向同样算高掌控感')

  assert.strictEqual(mood.emotionActive({ ...baseline, arousal: 0.44 }), false, 'arousal 门槛是 0.1：0.44 距基线只有 0.09')
  assert.strictEqual(mood.emotionActive({ ...baseline, dominance: 0.24 }), false, 'dominance 门槛是 0.25')

  const lowShare = { joy: 0.2, anger: 0.2, sorrow: 0.2, fear: 0.2 }
  assert.strictEqual(mood.emotionActive({ ...baseline, emotion: lowShare }), false, '非空但主导 share 只有 0.2，不能算明确情绪')
  const uniform = { joy: 0.25, anger: 0.25, sorrow: 0.25, fear: 0.25 }
  assert.strictEqual(mood.emotionActive({ ...baseline, emotion: uniform }), false, '归一化后的均匀构成最大 share 是 0.25，同样低于 0.35 门槛')
  const dominant = { joy: 0.5, anger: 0.2, sorrow: 0.2, fear: 0.1 }
  assert.strictEqual(mood.emotionActive({ ...baseline, emotion: dominant }), true, '主导 share 0.5 必须开启')
})

// ---- §8 第六条：decay 边界 ----

test('moodDecay 在 fade 0.35 两侧行为稳定，清空后 arousal/dominance 仍继续衰减', () => {
  const boundary = timeAtFade(0.35)
  assert.ok(boundary !== null, '需要先构造出 Math.pow 精确等于 0.35 的时刻，才能验证「严格小于」的边界')
  const reading = { emotion: { joy: 0, anger: 0, sorrow: 1, fear: 0 }, arousal: 0.9, dominance: 0.8, at: 0 }

  const exact = mood.moodDecay(reading, boundary)
  assert.deepEqual(exact.emotion, reading.emotion, 'spec 写成严格小于：fade === 0.35 仍保留构成，<= 会在这里提前清空')
  assert.ok(close(exact.arousal, 0.35 + 0.55 * 0.35, 1e-12))
  assert.ok(close(exact.dominance, 0.8 * 0.35, 1e-12))

  const above = mood.moodDecay(reading, boundary - 60_000)
  assert.deepEqual(above.emotion, reading.emotion, 'fade 略大于 0.35 时必须保留构成')

  const below = mood.moodDecay(reading, boundary + 60_000)
  assert.strictEqual(below.emotion, null, 'fade 略小于 0.35 时必须清空构成')
  assert.ok(below.arousal > 0.35, '构成清空不等于情绪轴清空：arousal 仍要返回并高于基线')
  assert.ok(below.arousal < above.arousal, '清空后 arousal 仍在向基线衰减')
  assert.ok(below.dominance > 0 && below.dominance < above.dominance, '清空后 dominance 仍在向 0 衰减')

  const later = mood.moodDecay(reading, boundary + 60 * 60_000)
  assert.strictEqual(later.emotion, null)
  assert.ok(later.arousal < below.arousal, '更晚的时刻 arousal 必须更接近 0.35')
  assert.ok(later.dominance < below.dominance, '更晚的时刻 dominance 必须更接近 0')
})

// ---- §8 第七条：兼容 ----

test('readMood(...).valence 继续存在，旧形状的会话 mood 可读回', () => {
  const read = mood.readMood('今天太开心了，测试全部通过')
  assert.strictEqual(typeof read.valence, 'number', 'valence 是旧召回路径直接读取的字段，不能因为新增 emotion 就消失')
  assert.ok(read.valence > 0, '旧路径的语义不能变：这句话仍然读成正面')
  assert.ok('emotion' in read && 'arousal' in read && 'dominance' in read, 'spec §4.1 的四个字段必须同时返回')

  const { sessionId } = setup('compat')
  state.setSessionMood(sessionId, { valence: -0.6, arousal: 0.8 })
  const stored = state.getSessionMood(sessionId)
  assert.strictEqual(stored.valence, -0.6, '旧形状 { valence, arousal } 必须原样可读')
  assert.strictEqual(stored.arousal, 0.8)
  assert.strictEqual(stored.emotion, null, '只有 valence 的旧读数不得反推四轴')
  assert.strictEqual(typeof stored.at, 'number')
})

// ---- §8 第八条：旧条目不反推 ----

test('旧条目没有 emotion 时不反推四轴，也不产生 NaN', async () => {
  const { binding, exec, sessionId } = setup('legacy')
  const stamp = new Date().toISOString()
  const index = state.loadPrivateIndex(binding.libraryId)
  index.entries['mem-legacy-harbour'] = {
    track: 'memory',
    layer: 'long_term',
    title: 'Harbour bell at dusk',
    content: 'The harbour bell rang twice at dusk.',
    status: 'active',
    owner: 'me',
    visibility: 'shared',
    source: 'user_said',
    moodValence: -0.8,
    arousal: 0.6,
    peak: false,
    confidence: 0.8,
    createdAt: stamp,
    updatedAt: stamp,
  }
  state.savePrivateIndex(binding.libraryId, index)

  // 新路径在场（会话有四轴情绪），旧条目仍必须走 legacy valence 分流。
  state.setSessionMood(sessionId, { emotion: { joy: 0, anger: 0, sorrow: 1, fear: 0 }, arousal: 0.35, dominance: 0 })
  const out = await memory.privateRecall({ exec, query: 'harbour bell dusk', topK: 1, relevanceThreshold: 0, purpose: 'automatic' })
  const hit = (out.files || []).find((file) => file.name === 'mem-legacy-harbour')
  assert.ok(hit, '没有 emotion 的旧条目仍然必须能被召回')
  assert.ok(Number.isFinite(hit.score) && hit.score > 0, `旧条目缺 emotion/dominance 时打分不能变成 NaN，实测 ${hit.score}`)
  assert.strictEqual(hit.entry.emotion, undefined, 'spec §3.3：旧条目没有 emotion 就保持原样，不能从 moodValence 反推四轴')
  assert.strictEqual(
    state.loadPrivateIndex(binding.libraryId).entries['mem-legacy-harbour'].emotion,
    undefined,
    '召回本身也不能把推断出的构成写回索引',
  )
})

// ---- §8 第九条：显式 0 ----

test('显式 arousal: 0 与 dominance: 0 写入后读回仍是 0', async () => {
  const { exec, binding, sessionId } = setup('explicit-zero')
  const { id } = await memory.privateRemember({
    exec,
    content: 'The gauge read zero at noon.',
    title: 'gauge zero',
    arousal: 0,
    dominance: 0,
  })
  const entry = entryOf(binding, id)
  assert.strictEqual(entry.arousal, 0, 'spec §3.2：显式 0 是读数的一部分，不能被 || 0.35 覆盖')
  assert.strictEqual(entry.dominance, 0, 'dominance 的显式 0 同样不能被默认值吞掉')

  state.setSessionMood(sessionId, { valence: 0, arousal: 0, dominance: 0 })
  const stored = state.getSessionMood(sessionId)
  assert.strictEqual(stored.arousal, 0, '会话 mood 的显式 0 也必须保留')
  assert.strictEqual(stored.dominance, 0)
})

// ---- §8 最后一条：remember -> list -> update -> recall 往返 ----

test('remember 带 emotion：归一化、来源 model、moodValence 等于派生值', async () => {
  const { exec, binding } = setup('remember')
  const { id } = await memory.privateRemember({
    exec,
    content: 'We argued about the broken deploy until midnight.',
    title: 'midnight deploy',
    emotion: { joy: 0.5, anger: 0.5, sorrow: 0, fear: 0 },
  })
  const entry = entryOf(binding, id)
  assert.ok(close(shareSum(entry.emotion), 1, 1e-9), '存下来的构成必须已经归一化，读回时不能再做一次隐式缩放')
  assert.ok(close(entry.emotion.joy, 0.5, 1e-12) && close(entry.emotion.anger, 0.5, 1e-12), '0.5/0.5 归一化后仍是 0.5/0.5')
  assert.strictEqual(entry.emotionSource, 'model', '工具参数显式给了 emotion，来源必须是 model，否则审计分不清事实与推断')
  assert.ok(close(entry.moodValence, mood.derivedValence(entry.emotion), 1e-12), 'moodValence 是构成的兼容投影，必须与 derivedValence 一致')

  // 0 == 0 的断言是空洞的，再写一条非零投影的。
  const second = await memory.privateRemember({
    exec,
    content: 'The release finally shipped clean.',
    title: 'clean release',
    emotion: { joy: 0.75, anger: 0.25, sorrow: 0, fear: 0 },
  })
  assert.ok(close(entryOf(binding, second.id).moodValence, 0.4, 1e-12), '0.8*(0.75-0.25)=0.4')
})

test('update 三态：省略保留、null 清空并标 unknown、新对象整份替换', async () => {
  const { exec, binding } = setup('update')
  const { id } = await memory.privateRemember({
    exec,
    content: 'The roof leaked through the night.',
    title: 'roof leak',
    emotion: { joy: 0, anger: 0, sorrow: 0.75, fear: 0.25 },
  })
  const before = entryOf(binding, id).emotion

  await memory.privateUpdate({ exec, id, title: 'roof leak (edited)' })
  assert.deepEqual(entryOf(binding, id).emotion, before, '省略 emotion 表示保留：只改标题不能把情绪弄丢')

  await memory.privateUpdate({ exec, id, emotion: null })
  const cleared = entryOf(binding, id)
  assert.strictEqual(cleared.emotion, null, '显式 null 表示清除构成')
  assert.strictEqual(cleared.emotionSource, 'unknown', '清除后来源必须是 unknown，不能再声称是 model 读到的')

  await memory.privateUpdate({ exec, id, emotion: { joy: 1, anger: 0, sorrow: 0, fear: 0 } })
  const replaced = entryOf(binding, id)
  assert.deepEqual(replaced.emotion, { joy: 1, anger: 0, sorrow: 0, fear: 0 }, '新对象必须整份替换旧构成，不能按轴合并')
  assert.strictEqual(replaced.emotionSource, 'model')
  assert.ok(close(replaced.moodValence, 0.8, 1e-12), '替换后兼容投影要跟着重算')
})

test('update 的非法 emotion 必须 reject，错误含 emotion，且不留下半截修改', async () => {
  const { exec, binding } = setup('update-bad')
  const { id } = await memory.privateRemember({
    exec,
    content: 'The invoice arrived twice.',
    title: 'invoice twice',
    emotion: { joy: 0, anger: 0, sorrow: 1, fear: 0 },
  })
  const before = entryOf(binding, id).emotion

  await assert.rejects(
    () => memory.privateUpdate({ exec, id, emotion: { joy: 1, anger: -1, sorrow: 0, fear: 0 } }),
    /emotion/,
    'spec §3.1：负数份额只能拒绝，不能 clamp 成合法值；错误信息必须点明 emotion',
  )
  assert.deepEqual(entryOf(binding, id).emotion, before, '被拒绝的更新不能改动已存构成')
})

test('about_project 的条目在没有显式 emotion 时保持中性', async () => {
  const { exec, binding, sessionId } = setup('project')
  // 会话此刻很兴奋：工程事实仍然不能被染色。
  state.setSessionMood(sessionId, { emotion: { joy: 1, anger: 0, sorrow: 0, fear: 0 }, arousal: 0.9, dominance: 0.5 })

  const { id } = await memory.privateRemember({
    exec,
    content: 'Node 22 的构建终于通过了，我特别开心。',
    title: 'build green on Node 22',
    owner: 'about_project',
  })
  const entry = entryOf(binding, id)
  assert.strictEqual(entry.emotion, null, 'spec §6.1/§6.3：工程事实固定中性；bug 难修不是项目在难过')
  assert.strictEqual(entry.emotionSource, 'unknown', '没有证据就必须标 unknown，不能借会话心情冒充推断')
  assert.strictEqual(entry.dominance, 0, '工程事实不继承会话的掌控感')
  assert.ok(Number.isFinite(entry.moodValence), '中性也要给出可用的兼容投影，而不是 NaN')
})

test('remember 的显式 emotion: null 表示明确中性（spec §6.1），不继承会话心情', async () => {
  const { exec, binding, sessionId } = setup('remember-null')
  state.setSessionMood(sessionId, { emotion: { joy: 1, anger: 0, sorrow: 0, fear: 0 }, arousal: 0.9, dominance: 0.4 })

  const { id } = await memory.privateRemember({
    exec,
    content: 'The build passed.',
    title: 'build passed',
    emotion: null,
  })
  assert.strictEqual(
    entryOf(binding, id).emotion,
    null,
    'spec §6.1：省略=继承、null=明确中性。把 null 当成省略会把整理时的心情写进事件本身',
  )
})
