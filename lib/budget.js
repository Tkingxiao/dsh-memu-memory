// Token accounting for mixed Chinese/English text.
//
// The old rule everywhere in this plugin was `chars / 3`, which is an English
// assumption: one CJK character is roughly one token, so a pure-Chinese prompt
// overran its budget by about 3x while the logs said it fit. Everything that
// budgets prompt space has to go through this module instead.
const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/
// Average characters per token for Latin text. Prose is ~4, code and CJK-adjacent
// punctuation are worse, so 3.4 is a deliberately conservative middle.
const LATIN_CHARS_PER_TOKEN = 3.4

export function isWide(char) {
  return CJK.test(char)
}

export function cjkRatio(text) {
  const s = String(text || '')
  if (s.length === 0) return 0
  let wide = 0
  for (const char of s) if (isWide(char)) wide++
  return wide / [...s].length
}

export function estTokens(text) {
  const s = String(text || '')
  if (s.length === 0) return 0
  let wide = 0
  let narrow = 0
  for (const char of s) {
    if (isWide(char)) wide++
    else narrow++
  }
  return Math.ceil(wide + narrow / LATIN_CHARS_PER_TOKEN)
}

/** How many characters of a text shaped like `sample` fit in `tokens`. */
export function charsForTokens(tokens, sample = '') {
  const budget = Number(tokens)
  if (!Number.isFinite(budget) || budget <= 0) return 0
  const ratio = cjkRatio(sample)
  const perChar = ratio + (1 - ratio) / LATIN_CHARS_PER_TOKEN
  return Math.max(1, Math.floor(budget / perChar))
}

/**
 * Cut `text` so its estimate stays within `maxTokens`. Prefers the last newline
 * before the cut so entries are not sliced mid-line.
 */
export function truncateToTokens(text, maxTokens) {
  const s = String(text || '')
  const budget = Number(maxTokens)
  if (!Number.isFinite(budget) || budget <= 0) return ''
  if (estTokens(s) <= budget) return s
  let used = 0
  let cut = 0
  for (const char of s) {
    const cost = isWide(char) ? 1 : 1 / LATIN_CHARS_PER_TOKEN
    if (used + cost > budget - 1) break
    used += cost
    cut += char.length
  }
  const slice = s.slice(0, cut)
  const lastBreak = slice.lastIndexOf('\n')
  const trimmed = lastBreak > slice.length * 0.6 ? slice.slice(0, lastBreak) : slice
  return `${trimmed}…`
}

/**
 * Fill entries into a token budget, in the order given. The first entry is always
 * taken (truncated if it alone is too big) so a section never vanishes entirely;
 * later ones stop at the boundary. Returns only what actually made it in.
 */
export function packToBudget(items, maxTokens, render) {
  const budget = Math.max(0, Number(maxTokens) || 0)
  const lines = []
  const ids = []
  let used = 0
  for (const [id, item] of items) {
    if (budget <= used) break
    const line = render(item, id)
    const cost = estTokens(line) + (lines.length > 0 ? 1 : 0)
    if (lines.length > 0 && used + cost > budget) break
    if (lines.length === 0 && cost > budget) {
      const clipped = truncateToTokens(line, budget)
      if (!clipped.includes(`[${id}]`)) break
      lines.push(clipped)
      ids.push(id)
      used = estTokens(clipped)
      continue
    }
    lines.push(line)
    ids.push(id)
    used += cost
  }
  return { lines, ids, used, omitted: Math.max(0, items.length - ids.length) }
}
