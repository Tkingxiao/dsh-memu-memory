// Text normalization shared by the deterministic auto-link rules. Language
// agnostic: NFKC + case fold + strip punctuation/symbols/format characters and
// whitespace. Kana and Latin diacritics survive because only P/S/Cf/space are
// removed, so the same rule serves CJK, Latin and code identifiers.

export function normalizeForIndex(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}\p{Cf}]+/gu, '')
}

/** Same bytes as the index form; named for the substring rule it serves. */
export function compact(text) {
  return normalizeForIndex(text)
}

const LATIN_WORD = /^[a-z0-9][a-z0-9._-]*$/i
const CJK_CHAR = /[\u3400-\u9fff\uf900-\ufaff]/

export function isLatinToken(token) {
  return LATIN_WORD.test(String(token || ''))
}

export function hasCjk(token) {
  return CJK_CHAR.test(String(token || ''))
}

/**
 * Compact form plus each output code unit's position in the normalized source.
 * `firstMention` needs the raw offset, and the compact index alone is wrong as
 * soon as punctuation is removed (「小·柚」 -> 小柚 shifts by two).
 */
export function compactWithMap(text) {
  const normalized = String(text || '').normalize('NFKC').toLowerCase()
  let out = ''
  const map = []
  for (const match of normalized.matchAll(/[^\s\p{P}\p{S}\p{Cf}]/gu)) {
    out += match[0]
    map.push(match.index)
  }
  return { text: out, map }
}

/**
 * Count occurrences of `name` in `text`.
 *  - A name containing CJK is matched as a substring of the compact text, so
 *    「小·柚」, 小 柚 and 小柚 are the same surface (§8.1 NFKC + 去标点/空白).
 *  - A Latin / identifier name is matched literally (dots, underscores and
 *    hyphens are part of it) on word boundaries, so `yuike` never matches
 *    `yuikeee`, while `yuike.dev` stays one identifier.
 */
export function mentionCount(text, name) {
  const raw = String(name || '').normalize('NFKC').toLowerCase().trim()
  const key = normalizeForIndex(raw)
  if (!key) return 0
  if (hasCjk(key)) {
    const source = compact(text)
    if (!source) return 0
    let count = 0
    let at = source.indexOf(key)
    while (at !== -1) { count += 1; at = source.indexOf(key, at + key.length) }
    return count
  }
  const source = String(text || '').normalize('NFKC').toLowerCase()
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!escaped) return 0
  const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'g')
  return (source.match(re) || []).length
}

/** Offset of the first mention in the raw text, or -1. */
export function firstMention(text, name) {
  const raw = String(name || '').normalize('NFKC').toLowerCase().trim()
  const key = normalizeForIndex(raw)
  if (!key) return -1
  if (hasCjk(key)) {
    const { text: compacted, map } = compactWithMap(text)
    const at = compacted.indexOf(key)
    return at === -1 ? -1 : (map[at] ?? -1)
  }
  const source = String(text || '').normalize('NFKC').toLowerCase()
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!escaped) return -1
  const match = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).exec(source)
  return match ? match.index : -1
}

/**
 * A mention surface must carry identifying power: CJK needs >= 2 characters and
 * Latin needs >= 2 boundary-safe characters. Single-character aliases would
 * match half the library, which is the noise this layer exists to remove.
 */
export function isMentionSurface(name) {
  const key = normalizeForIndex(name)
  if (!key) return false
  if (hasCjk(key)) return [...key].length >= 2
  return isLatinToken(key) && key.length >= 2
}
