// Cheap, local, deterministic mood inference. No model call: the plugin needs a
// mood signal every turn for mood-congruent retrieval, and a round trip per turn
// would make injection slower than the memory it fetches.
//
// Scores are deliberately coarse (valence -1..1, arousal 0..1). A wrong read only
// nudges recall ordering; it is never stored as a fact about the user.

const VALENCE_WORDS = [
  [/开心|高兴|太好了|棒|喜欢|爱|满意|惊喜|顺利|爽|感谢|谢谢|amazing|great|happy|love|nice|awesome|thanks/i, 0.8],
  [/不错|还行|可以|有趣|好奇|舒服|ok|fine|good|interesting|curious/i, 0.4],
  [/有点|稍微|somewhat|kind of|a bit/i, 0.1],
  [/难受|难过|失望|烦|讨厌|累|困|郁闷|崩溃|糟糕|气|火|sad|upset|tired|annoying|awful|hate|frustrated|angry/i, -0.7],
  [/疼|痛|病|哭|害怕|慌|焦虑|压力|失眠|hurt|sick|cry|scared|anxious|stress|insomnia/i, -0.9],
]

const AROUSAL_WORDS = [
  [/(!{2,}|[!?]{2,}|太|超|巨|特别|疯狂|爆炸|never|always|everything|nothing)/i, 0.8],
  [/必须|一定|马上|立刻|不能|别|停止|紧急|must|need|stop|urgent|now/i, 0.7],
  [/可能|也许|大概|想想|不确定|maybe|perhaps|might|wonder/i, 0.25],
]

// Mood fades back to neutral on its own, so an old read does not tint the whole
// day's retrieval.
const MOOD_HALF_LIFE_MINUTES = 90
// A resting level, not zero: a calm stretch reads as calm-and-alert, which is what
// keeps the arousal term meaningful when nothing is happening.
export const BASE_AROUSAL = 0.35

export function readMood(text) {
  const source = String(text || '')
    .replace(/["“「][^"”」]*["”」]/g, '')
    .replace(/不开心|不高兴|不喜欢|不满意|not\s+happy|not\s+good|don't\s+like/gi, ' sad ')
    .replace(/不难过|不害怕|不焦虑|not\s+sad|not\s+afraid/gi, '')
  let valence = 0
  for (const [pattern, weight] of VALENCE_WORDS) {
    if (pattern.test(source)) valence = valence === 0 ? weight : (valence + weight) / 2
  }
  let arousal = 0.35
  for (const [pattern, weight] of AROUSAL_WORDS) {
    if (pattern.test(source)) arousal = Math.max(arousal, weight)
  }
  if (source.length > 600) arousal = Math.max(0.2, arousal - 0.15)
  return {
    valence: Math.max(-1, Math.min(1, valence)),
    arousal: Math.max(0, Math.min(1, arousal)),
  }
}

export function moodDecay(mood, now = Date.now()) {
  if (!mood || typeof mood.at !== 'number') return { valence: 0, arousal: BASE_AROUSAL }
  const minutes = Math.max(0, (now - mood.at) / 60_000)
  const fade = Math.pow(0.5, minutes / MOOD_HALF_LIFE_MINUTES)
  const arousal = Number(mood.arousal)
  return {
    valence: Number(mood.valence || 0) * fade,
    // Arousal relaxes back to the baseline instead of collapsing to zero, so a
    // calm stretch still reads as calm-but-alert rather than flat.
    arousal: BASE_AROUSAL + ((Number.isFinite(arousal) ? arousal : BASE_AROUSAL) - BASE_AROUSAL) * fade,
  }
}

// Congruence is |a·b| over signed valence: sad recalls sad, happy recalls happy,
// and a neutral present state recalls nothing extra.
export function moodCongruence(entryValence, currentValence) {
  const a = Number(entryValence || 0)
  const b = Number(currentValence || 0)
  if (!a || !b) return 0
  const same = Math.sign(a) === Math.sign(b)
  const agreement = Math.min(Math.abs(a), Math.abs(b))
  return same ? agreement : -agreement * 0.5
}
