// Cheap, local, deterministic affect inference. No model call: the plugin needs an
// affect signal every turn for affect-congruent retrieval, and a round trip per turn
// would make injection slower than the memory it fetches.
//
// Model: four shares on the simplex (joy / anger / sorrow / fear) + two auxiliary
// axes — arousal (how loud) and dominance (who is in control). Shares answer "which
// feeling, in what proportion"; arousal answers "how loud"; dominance answers "who is
// steering". Normalising the shares throws intensity away, which is exactly why
// arousal has to stay a separate field rather than being folded into the four.
//
// Scores are deliberately coarse. A wrong read only nudges recall ordering; it is
// never stored as a fact about the user.

export const EMOTION_AXES = Object.freeze(['joy', 'anger', 'sorrow', 'fear'])

// Mood fades back to neutral on its own, so an old read does not tint the whole
// day's retrieval.
export const MOOD_HALF_LIFE_MINUTES = 90
// A resting level, not zero: a calm stretch reads as calm-and-alert, which is what
// keeps the arousal term meaningful when nothing is happening.
export const BASE_AROUSAL = 0.35
// Below this share no single axis is dominant enough to call the reading a mood.
export const EMOTION_MIN_SHARE = 0.35
// The composition stops being worth anything once the whole reading has faded this
// far; arousal and dominance keep decaying and are still reported.
export const EMOTION_FADE_FLOOR = 0.35
// How much anger-vs-fear moves dominance on its own. Anger carries agency, fear does
// not, and neither phrase usually contains a control word.
export const DOMINANCE_PRIOR_WEIGHT = 0.4
// Every axis projects onto the legacy valence with the same magnitude; only joy is
// positive. Anger is *not* a mild positive — it pulls the projection down as hard as
// sorrow does.
export const VALENCE_SCALE = 0.8

const NEGATION_AS_SAD = /不开心|不高兴|不喜欢|不满意|不顺利|not\s+happy|not\s+good|don't\s+like/gi
const NEGATION_TO_NEUTRAL = /不难过|不害怕|不焦虑|不生气|not\s+sad|not\s+afraid|not\s+anxious/gi

const AXIS_PATTERNS = Object.freeze({
  joy: [
    [/开心|高兴|太好了|喜欢|爱你|满意|惊喜|谢谢|感谢|期待|幸福|欣慰|兴奋|激动|雀跃/, 0.9],
    [/不错|还行|顺利|爽|安心|踏实|棒|有趣|舒服/, 0.6],
  ],
  anger: [
    [/气死|烦死|受不了|离谱|凭什么|恨|火大|欺人太甚/, 0.9],
    [/生气|气|烦|讨厌|恶心|无语|恼火|不满|angry|annoying|hate|furious/, 0.6],
  ],
  sorrow: [
    [/崩溃|难受|心疼|失望透顶|想哭|哭|心碎/, 0.9],
    // `sad` is not decoration: the negation rules below rewrite 不开心/不高兴 into the
    // word `sad`, so dropping English here silently turns a negated positive into a
    // neutral reading instead of a negative one.
    [/难过|失望|委屈|郁闷|累|困|没意思|算了|沮丧|孤独|sad|unhappy|upset|tired|miserable/, 0.6],
  ],
  fear: [
    [/吓死|害怕|恐慌|焦虑|绝望|惊恐|发抖/, 0.9],
    [/担心|紧张|慌|不敢|万一|怕|不安|忐忑|afraid|scared|anxious|worried|nervous/, 0.6],
  ],
})

// Compound expressions are mixtures, not new axes. Each entry is a named point on the
// simplex plus the dominance that usually comes with it.
export const COMPOUND_PRESETS = Object.freeze({
  委屈: Object.freeze({ emotion: Object.freeze({ joy: 0, anger: 0.3, sorrow: 0.7, fear: 0 }), dominance: -0.4 }),
  尴尬: Object.freeze({ emotion: Object.freeze({ joy: 0, anger: 0, sorrow: 0.5, fear: 0.5 }), dominance: -0.5 }),
  嫉妒: Object.freeze({ emotion: Object.freeze({ joy: 0, anger: 0.5, sorrow: 0.3, fear: 0.2 }), dominance: -0.1 }),
  心疼: Object.freeze({ emotion: Object.freeze({ joy: 0.2, anger: 0, sorrow: 0.8, fear: 0 }), dominance: -0.2 }),
  不甘: Object.freeze({ emotion: Object.freeze({ joy: 0, anger: 0.6, sorrow: 0.4, fear: 0 }), dominance: 0.4 }),
})

const COMPOUND_PATTERN = new RegExp(Object.keys(COMPOUND_PRESETS).join('|'))
const HEDGE_PATTERN = /有点|稍微|一点点|a bit|somewhat/i
// "一点都不好" is an intensifier, not a hedge: it must never damp what follows.
const HEDGE_SKEW_GUARD = /一点都|一点也不|一点也没|一点没有/
const INTENSITY_PATTERN = /死|疯了|极了|受不了|爆|炸|太|超|巨|特别|疯狂/
const REPEATED_PUNCT = /[!！?？]{2,}/

const HIGH_DOMINANCE = /凭什么|我决定|不许|听我的|我不在乎|随便你|必须|轮不到|说了算|懒得|我才不/g
const LOW_DOMINANCE = /不敢|没办法|只能|求|拜托|对不起|是我错|控制不住|万一|怎么办|逃|来不及|都怪我/g

const CLAUSE_SPLIT = /([，。！？；,.!?;]+)/

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

/**
 * Normalise a four-axis composition.
 *
 * Returns null for "no mood". An explicit all-zero object normalises to null too: it
 * is the tool-friendly way of saying neutral, not a reading where all four are faintly
 * present. Anything malformed is rejected instead of being repaired — silently
 * clamping a negative share into a legal one would hide a caller bug forever.
 */
export function normalizeEmotion(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('emotion must be an object with joy, anger, sorrow, fear')
  const values = {}
  for (const axis of EMOTION_AXES) {
    if (!Object.prototype.hasOwnProperty.call(raw, axis)) throw new Error('emotion is missing the ' + axis + ' share')
    const value = raw[axis]
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('emotion.' + axis + ' must be a finite number')
    if (value < 0) throw new Error('emotion.' + axis + ' must not be negative')
    values[axis] = value
  }
  const sum = EMOTION_AXES.reduce((total, axis) => total + values[axis], 0)
  if (!(sum > 0)) return null
  const normalized = {}
  for (const axis of EMOTION_AXES) normalized[axis] = values[axis] / sum
  return normalized
}

/** The legacy single-number projection. Joy is the only axis that points up. */
export function derivedValence(emotion) {
  if (!emotion) return 0
  const raw = VALENCE_SCALE * (emotion.joy - emotion.anger - emotion.sorrow - emotion.fear)
  return clamp(Number.isFinite(raw) ? raw : 0, -1, 1)
}

/** The largest single share; 0 for a neutral reading. */
export function maxShare(emotion) {
  if (!emotion) return 0
  return EMOTION_AXES.reduce((best, axis) => Math.max(best, Number(emotion[axis]) || 0), 0)
}

/** How much of the present composition a memory still shares. 0..1, symmetric. */
export function overlap(left, right) {
  if (!left || !right) return 0
  let total = 0
  for (const axis of EMOTION_AXES) {
    const a = Number(left[axis]) || 0
    const b = Number(right[axis]) || 0
    if (a > 0 && b > 0) total += Math.min(a, b)
  }
  return clamp(total, 0, 1)
}

/**
 * Dominance similarity, mapped to a bounded multiplier. A missing or illegal value on
 * either side is "no signal", never NaN: callers multiply by this result directly.
 */
export function dominanceBias(entryDominance, contextDominance) {
  // Number(null) is 0, so a missing value must be rejected before coercion — otherwise
  // "we do not know" quietly becomes "slightly in control" and still moves the ranking.
  if (entryDominance === null || entryDominance === undefined) return 1
  if (contextDominance === null || contextDominance === undefined) return 1
  const a = Number(entryDominance)
  const b = Number(contextDominance)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1
  return 1 + 0.2 * (0.5 - Math.abs(clamp(a, -1, 1) - clamp(b, -1, 1)) / 2)
}

/**
 * Whether the affect terms are worth applying at all. Three independent legs: a clear
 * composition, an arousal away from rest, or a clear sense of control. A null
 * composition only closes the first leg.
 */
export function emotionActive({ emotion = null, arousal = BASE_AROUSAL, dominance = 0 } = {}) {
  if (emotion !== null && emotion !== undefined && maxShare(emotion) >= EMOTION_MIN_SHARE) return true
  const arousalValue = Number(arousal)
  if (Number.isFinite(arousalValue) && Math.abs(arousalValue - BASE_AROUSAL) >= 0.1) return true
  const dominanceValue = Number(dominance)
  if (Number.isFinite(dominanceValue) && Math.abs(dominanceValue) >= 0.25) return true
  return false
}

function clausesOf(source) {
  return String(source || '')
    .split(CLAUSE_SPLIT)
    .map((part) => part.trim())
    .filter((part) => part && !/^[，。！？；,.!?;]+$/.test(part))
}

function compoundIn(clause) {
  const hit = COMPOUND_PATTERN.exec(clause)
  return hit ? COMPOUND_PRESETS[hit[0]] : null
}

function axisHits(clause) {
  const hits = {}
  for (const axis of EMOTION_AXES) {
    let best = 0
    for (const [pattern, weight] of AXIS_PATTERNS[axis]) {
      if (pattern.test(clause)) best = Math.max(best, weight)
    }
    if (best > 0) hits[axis] = best
  }
  return hits
}

/**
 * Read the present affect state out of one user turn.
 *
 * Kept text-only and deterministic. `.valence` stays on the return value because the
 * legacy retrieval path and its tests read it directly; `emotion`/`dominance` are
 * additive, so a caller that only knows about valence keeps working.
 */
export function readMood(text) {
  const source = String(text || '')
    .replace(/["“「][^"”」]*["”」]/g, '')
    .replace(NEGATION_AS_SAD, ' sad ')
    .replace(NEGATION_TO_NEUTRAL, '')
  const clauses = clausesOf(source)

  const raw = { joy: 0, anger: 0, sorrow: 0, fear: 0 }
  let compoundDominance = null
  let peakIntensity = 0
  let hedged = false

  for (const clause of clauses) {
    const hedge = HEDGE_PATTERN.test(clause) && !HEDGE_SKEW_GUARD.test(clause)
    if (hedge) hedged = true
    const scale = hedge ? 0.6 : 1
    const compound = compoundIn(clause)
    if (compound) {
      for (const axis of EMOTION_AXES) raw[axis] += compound.emotion[axis] * scale
      if (compoundDominance === null) compoundDominance = compound.dominance
    } else {
      const hits = axisHits(clause)
      for (const axis of EMOTION_AXES) if (hits[axis]) raw[axis] += hits[axis] * scale
    }
    if (INTENSITY_PATTERN.test(clause) || REPEATED_PUNCT.test(clause)) peakIntensity = Math.max(peakIntensity, 0.75)
    if (REPEATED_PUNCT.test(clause)) peakIntensity = Math.max(peakIntensity, 0.8)
  }

  for (const axis of EMOTION_AXES) raw[axis] = Math.min(1, raw[axis])
  const emotion = normalizeEmotion(raw)

  let arousal = BASE_AROUSAL
  if (emotion !== null) arousal = Math.max(arousal, peakIntensity)
  if (source.length > 600) arousal = Math.max(0.2, arousal - 0.15)

  const high = (source.match(HIGH_DOMINANCE) || []).length
  const low = (source.match(LOW_DOMINANCE) || []).length
  const lexical = clamp(0.5 * (high - low), -1, 1)
  const prior = emotion === null ? 0 : DOMINANCE_PRIOR_WEIGHT * (emotion.anger - emotion.fear)
  const dominance = clamp(lexical + prior + (compoundDominance === null ? 0 : compoundDominance * 0.5), -1, 1)

  return {
    valence: derivedValence(emotion),
    emotion,
    arousal: clamp(arousal, 0, 1),
    dominance: hedged ? clamp(dominance * 0.8, -1, 1) : dominance,
  }
}

/**
 * Fade a reading toward neutral.
 *
 * The composition does not decay proportionally — proportions sum to 1, so scaling
 * them changes nothing. What fades is how much of it is left: arousal returns to rest,
 * dominance returns to zero, and once the whole reading has faded past the floor the
 * composition is dropped. Arousal and dominance keep decaying past that point.
 */
export function moodDecay(mood, now = Date.now()) {
  const hasStamp = Boolean(mood) && typeof mood.at === 'number'
  const minutes = hasStamp ? Math.max(0, (now - mood.at) / 60_000) : 0
  const fade = hasStamp ? Math.pow(0.5, minutes / MOOD_HALF_LIFE_MINUTES) : 0

  const emotion = hasStamp && mood.emotion ? mood.emotion : null
  const keptEmotion = fade < EMOTION_FADE_FLOOR ? null : emotion
  const arousalValue = Number(mood && mood.arousal)
  const dominanceValue = Number(mood && mood.dominance)
  const legacyValence = Number(mood && mood.valence)

  return {
    valence: (keptEmotion ? derivedValence(keptEmotion) : (Number.isFinite(legacyValence) ? legacyValence : 0)) * (hasStamp ? fade : 0),
    emotion: keptEmotion,
    arousal: BASE_AROUSAL + ((Number.isFinite(arousalValue) ? arousalValue : BASE_AROUSAL) - BASE_AROUSAL) * fade,
    dominance: (Number.isFinite(dominanceValue) ? dominanceValue : 0) * fade,
  }
}

// Congruence is |a·b| over signed valence: sad recalls sad, happy recalls happy,
// and a neutral present state recalls nothing extra. Kept for the legacy path.
export function moodCongruence(entryValence, currentValence) {
  const a = Number(entryValence || 0)
  const b = Number(currentValence || 0)
  if (!a || !b) return 0
  const same = Math.sign(a) === Math.sign(b)
  const agreement = Math.min(Math.abs(a), Math.abs(b))
  return same ? agreement : -agreement * 0.5
}

export default {
  EMOTION_AXES,
  MOOD_HALF_LIFE_MINUTES,
  BASE_AROUSAL,
  EMOTION_MIN_SHARE,
  EMOTION_FADE_FLOOR,
  COMPOUND_PRESETS,
  normalizeEmotion,
  derivedValence,
  maxShare,
  overlap,
  dominanceBias,
  emotionActive,
  readMood,
  moodDecay,
  moodCongruence,
}
