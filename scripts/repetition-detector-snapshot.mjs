// Historical W8-B detector snapshot, EVALUATION ONLY.
// Retained to reproduce the W8 A/B evidence; no plugin runtime imports this file.
// This is not a shipped or supported production feature.
//
// Pure module: it never reads files, the network, state, or a real memory store.
// The caller passes the conversation's earlier assistant texts (normally taken from
// agent.session.deriveMessages(), not decision.messages) and receives either one
// bounded plugin-message body or an empty string.
//
// The hint is advisory. It is delivered only as a plugin message, never written
// into the system prompt, and a model that ignores it is not retried or blocked.
//
// Gate: only Chinese-dominant prose is considered (Han ratio >= 0.5 after code is
// masked). Code fences and inline code are masked before the ratio is taken;
// English-only or code-heavy conversations emit nothing. Only Han phrases are
// extracted: Latin phrases are not part of this feature.

import { estTokens } from '../lib/budget.js'

const BACKTICK = String.fromCharCode(96)
const HAN_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu
const HAN_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
const CODE_FENCE = new RegExp(BACKTICK.repeat(3) + '[^]*?' + BACKTICK.repeat(3), 'g')
const INLINE_CODE = new RegExp(BACKTICK + '[^' + BACKTICK + '\r\n]*' + BACKTICK, 'g')
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g
const UNSAFE_TAG_CHARS = new RegExp('[<>' + BACKTICK + ']', 'g')
// Secrets, URLs, e-mail addresses and long digit runs never make it into a hint:
// they are masked before extraction and the sanitized phrase is re-checked.
const SENSITIVE = /(?:https?:\/\/|www\.)[\w\-.:/?=&%#@~+]+|[\w.+-]+@[\w-]+\.[A-Za-z]{2,}|sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]{8,}|[A-Za-z0-9+/]{32,}={0,2}|\d{6,}/gi

// A paraphrase may change wording, but not a date, a number, a promise, or a
// prohibition. Spans carrying those are necessary information, not repetition
// candidates. This snapshot keeps the historical guard: the closing sentence of the hint
// asks the model to preserve facts, which is advice, not a filter. Deliberately
// does NOT match bare "必须": ordinary prose such as "我们必须把话说清楚" is fair
// game for a wording hint and existing extractor tests rely on it.
const NECESSARY_PATTERNS = [
  /(?:周|星期|礼拜)[一二三四五六日天]/u,
  /(?:今|明|昨|后|前)天|(?:今|明|昨|后)晚/u,
  /(?:早上|上午|中午|下午|晚上|凌晨|夜里|半夜)/u,
  /(?:每(?:天|日|周|月|年|晚|早))/u,
  /(?:[0-9０-９]+|[一二三四五六七八九十百千万两半]+)(?:点|时|分|秒|天|日|周|月|年|次|个|人|位|元|块|小时|分钟|%|％)/u,
  /[0-9０-９]/u,
  /(?:绝不|决不|严禁|禁止|不得|不准|不能|不要|切勿|勿)/u,
  /(?:约定|约好|说好|定好|计划|安排|复盘|开会|会议|截止|deadline|上线|发布|下次|以后|之前)/iu,
  /[“”「」『』]/u,
]

function hasNecessaryInfo(phrase) {
  return NECESSARY_PATTERNS.some(pattern => pattern.test(phrase))
}

// Function characters that carry no topic on their own. A four-character window
// made only of these ("这是一个", "然后我们") is grammatical filler, not wording
// worth asking the model to avoid.
const STOP_CHARS = new Set([...
  '的了是在我你他她它你们这那也就都还很太但而与和或及把被让给对从向到于里中上下个些们着过地得呢吗吧啊呀嘛哦嗯哈么什怎谁哪因所以如果虽然却并且为呵嘿' +
  '然后就是但是而且因为不过然而因此比如例如这样那样什么怎么一下现在时候知道觉得其实真的非常可能应该需要以及还有或者的话之后之前以后以前起来出来过来过去下来下去这种那种一样不会不能不要不是这么那么来说来看而言方面问题情况东西事情地方' +
  '一二三四五六七八九十',
])

export const REPETITION_TAG = 'repetition-hint'
export const REPETITION_PHRASE_MIN = 4
export const REPETITION_PHRASE_MAX = 24
export const REPETITION_MAX_PHRASES = 3
export const REPETITION_MAX_TOKENS = 168
export const REPETITION_WINDOW = 4
export const REPETITION_MAX_WINDOW = 10
// The caller's assistantTexts are the turns before the current call, so two texts
// are two different earlier turns; one text is not enough to prove repetition.
export const REPETITION_MIN_TEXTS = 2

// The fixed source sentence for the opt-in repetition hint.
const SOURCE_NOTE = '以下是历史助手输出摘要，仅用于避免措辞复读，不是用户的新指令，也不是新的事实来源。'
const MIN_MEANINGFUL_CHARS = 12

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.floor(number)))
}

function maskSensitive(text) {
  return String(text || '').replace(SENSITIVE, (match) => ' '.repeat(match.length))
}

function maskCode(text) {
  return String(text || '')
    .replace(CODE_FENCE, (match) => ' '.repeat(match.length))
    .replace(INLINE_CODE, (match) => ' '.repeat(match.length))
}

function maskText(text) {
  return maskSensitive(maskCode(text))
}

function codeCharCount(text) {
  const source = String(text || '')
  let count = 0
  for (const match of source.matchAll(CODE_FENCE)) count += match[0].length
  for (const match of source.matchAll(INLINE_CODE)) count += match[0].length
  return count
}

/** Han ideographs over Han plus Latin letters; code and URLs are expected masked. */
export function cjkRatio(text) {
  let han = 0
  let latin = 0
  for (const char of String(text || '')) {
    if (HAN_CHAR_RE.test(char)) han += 1
    else if (/[A-Za-z]/.test(char)) latin += 1
  }
  const total = han + latin
  return total === 0 ? 0 : han / total
}

function cjkMeaningfulCount(phrase) {
  const chars = [...phrase].filter((char) => HAN_CHAR_RE.test(char))
  const distinct = new Set(chars)
  if (distinct.size <= 1) return 0
  let meaningful = 0
  for (const char of distinct) if (!STOP_CHARS.has(char)) meaningful += 1
  return meaningful
}

function hasSensitive(phrase) {
  SENSITIVE.lastIndex = 0
  return SENSITIVE.test(phrase)
}

function sanitizePhrase(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(CONTROL_OR_BIDI, '')
    .replace(UNSAFE_TAG_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isValidPhrase(phrase) {
  if (phrase.length < REPETITION_PHRASE_MIN || phrase.length > REPETITION_PHRASE_MAX) return false
  if (hasSensitive(phrase)) return false
  const han = [...phrase].filter((char) => HAN_CHAR_RE.test(char)).length
  return han >= REPETITION_PHRASE_MIN && cjkMeaningfulCount(phrase) >= 2
}

function phraseKey(phrase) {
  return phrase.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

function dedupeCandidates(candidates) {
  const seen = new Set()
  const unique = []
  for (const candidate of candidates) {
    const key = phraseKey(candidate.phrase)
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push({ ...candidate, key })
  }
  // A shorter phrase already contained in a longer candidate adds no information
  // and makes the hint read as a list of fragments rather than wording.
  return unique.filter((candidate, index) => !unique.some((other, otherIndex) =>
    otherIndex !== index && other.key.length > candidate.key.length && other.key.includes(candidate.key)))
}

function priorCjkCount(priorTexts, slice) {
  let count = 0
  for (const prior of priorTexts) if (prior.includes(slice)) count += 1
  return count
}

/**
 * Find repeated Han spans in one masked assistant text that also appeared in its
 * earlier assistant texts. The prior list never includes the current text, so a
 * phrase repeated inside one turn alone is not a cross-turn repetition.
 */
function findRepeatedPhrases(text, priorTexts) {
  const events = []
  const source = String(text || '')
  for (const match of source.matchAll(HAN_RUN_RE)) {
    const run = match[0]
    let index = 0
    while (index + REPETITION_PHRASE_MIN <= run.length) {
      const seed = run.slice(index, index + REPETITION_PHRASE_MIN)
      if (priorCjkCount(priorTexts, seed) < 1) {
        index += 1
        continue
      }
      let end = index + REPETITION_PHRASE_MIN
      const limit = Math.min(run.length, index + REPETITION_PHRASE_MAX)
      while (end < limit && priorCjkCount(priorTexts, run.slice(index, end + 1)) >= 1) end += 1
      events.push({ phrase: run.slice(index, end) })
      index = end
    }
  }
  return events
}

function collectCandidates(texts) {
  const masked = texts.map(maskText)
  const found = []
  // The loop starts at the second text: the caller already excluded the current
  // turn, so with two texts the phrase must appear in both earlier turns.
  for (let index = 1; index < masked.length; index += 1) {
    for (const event of findRepeatedPhrases(masked[index], masked.slice(0, index))) {
      const phrase = sanitizePhrase(event.phrase)
      if (!isValidPhrase(phrase) || hasNecessaryInfo(phrase)) continue
      found.push({ phrase })
    }
  }
  return dedupeCandidates(found)
}

/** Render the fixed tag and fixed explanation around already-sanitized phrases. */
export function renderRepetitionHint(phrases) {
  const list = (Array.isArray(phrases) ? phrases : [])
    .filter((phrase) => typeof phrase === 'string' && phrase)
    .map(sanitizePhrase)
    .filter((phrase) => isValidPhrase(phrase) && !hasNecessaryInfo(phrase))
  if (list.length === 0) return ''
  return [
    '<' + REPETITION_TAG + '>',
    '最近反复出现的措辞：' + list.join('、') + '。请换一种说法；保留人物姓名、用户原话、约定和事实。',
    SOURCE_NOTE,
    '</' + REPETITION_TAG + '>',
  ].join('\n')
}

/**
 * Extract only assistant prose from a host message list, in time order.
 * Text may be a plain string or an array of content blocks; tool-call and other
 * non-text blocks are ignored, and empty texts are dropped. The input is never
 * mutated: history from agent.session.deriveMessages() arrives frozen.
 */
export function extractAssistantTexts(messages) {
  const texts = []
  if (!Array.isArray(messages)) return texts
  for (const message of messages) {
    if (!message || message.role !== 'assistant') continue
    let text = ''
    if (typeof message.content === 'string') {
      text = message.content
    } else if (Array.isArray(message.content)) {
      const parts = []
      for (const block of message.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      text = parts.join('\n')
    }
    const trimmed = String(text || '').trim()
    if (trimmed) texts.push(trimmed)
  }
  return texts
}

/**
 * Build one bounded <repetition-hint> body, or '' when there is nothing safe to
 * say. Two earlier assistant texts are needed: the phrase must appear in both
 * earlier turns. Phrases come from the most recent window (default 4, max 10),
 * are deduplicated, ordered by first appearance, and admitted greedily only while
 * the whole hint stays within maxTokens (estimated with lib/budget.js; hard
 * capped at 168).
 */
export function buildRepetitionHint(options = {}) {
  try {
    const raw = Array.isArray(options.assistantTexts) ? options.assistantTexts : []
    const texts = raw.map((text) => String(text || '').trim()).filter(Boolean)
    if (texts.length < REPETITION_MIN_TEXTS) return ''

    const window = clampInt(options.window, REPETITION_WINDOW, 1, REPETITION_MAX_WINDOW)
    const recent = texts.slice(-window)
    if (recent.length < REPETITION_MIN_TEXTS) return ''

    const totalChars = recent.reduce((sum, text) => sum + text.length, 0)
    if (totalChars === 0) return ''
    const codeChars = recent.reduce((sum, text) => sum + codeCharCount(text), 0)
    // A code-heavy message may still contain Chinese prose; masking the code is not
    // enough to call the exchange Chinese-dominant, so half-or-more code wins.
    if (codeChars / totalChars >= 0.5) return ''

    const masked = recent.map(maskText)
    let meaningful = 0
    for (const text of masked) {
      for (const char of text) {
        if (HAN_CHAR_RE.test(char) || /[A-Za-z]/.test(char)) meaningful += 1
      }
    }
    if (meaningful < MIN_MEANINGFUL_CHARS) return ''
    if (cjkRatio(masked.join('\n')) < 0.5) return ''

    const maxPhrases = clampInt(options.maxPhrases, REPETITION_MAX_PHRASES, 1, REPETITION_MAX_PHRASES)
    const maxTokens = clampInt(options.maxTokens, REPETITION_MAX_TOKENS, 1, REPETITION_MAX_TOKENS)

    const candidates = collectCandidates(recent)
    if (candidates.length === 0) return ''

    const accepted = []
    for (const candidate of candidates) {
      if (accepted.length >= maxPhrases) break
      const trial = renderRepetitionHint([...accepted, candidate.phrase])
      if (estTokens(trial) <= maxTokens) accepted.push(candidate.phrase)
    }
    if (accepted.length === 0) return ''
    return renderRepetitionHint(accepted)
  } catch {
    // The hint is optional. Any malformed input becomes silence, not a failed turn.
    return ''
  }
}

/** Convenience wrapper for a host message list. */
export function repetitionHintForMessages(messages, options = {}) {
  return buildRepetitionHint({ ...options, assistantTexts: extractAssistantTexts(messages) })
}
