// Cutting a memory down for a search result.
//
// A tool result used to be `truncate(content, 1200)`, i.e. the head. For a search
// hit that is the wrong 1200 characters: the passage that matched may sit in the
// middle of a long entry, and the model is then handed a snippet that does not
// explain why this entry came back. So when we know the query, cut around the
// hit instead — a little before it for context, more after it, because that is
// the direction the answer usually continues in.

import { redactSecrets } from './paths.js'

const ELLIPSIS = '…'

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Query terms worth looking for, longest first. Single characters are dropped:
 * in Chinese one character matches almost everywhere and "centring" on it just
 * means "cut from the head", which is what we are trying to avoid.
 */
export function queryTerms(query) {
  const raw = String(query ?? '').trim()
  if (!raw) return []
  const pieces = raw
    .toLowerCase()
    .split(/[\s,.;:!?、，。；：！？"'“”‘’()（）\[\]【】/\\|·—-]+/)
    .filter(Boolean)
  const terms = new Set(pieces.filter((p) => p.length >= 2))
  // A long natural-language query may be one unsegmented Chinese run; keep the
  // whole string as a last-resort term so a verbatim quote still hits.
  if (raw.length >= 4) terms.add(raw.toLowerCase())
  return [...terms].sort((a, b) => b.length - a.length)
}

/** Index of the first query term in `text`, or -1. Case-insensitive, literal. */
export function firstHit(text, terms) {
  const haystack = String(text ?? '').toLowerCase()
  let best = -1
  for (const term of terms) {
    const at = haystack.indexOf(term)
    if (at >= 0 && (best < 0 || at < best)) best = at
  }
  return best
}

/**
 * Snippet centred on the first hit. `before`/`after` are character counts around
 * the hit (default 40 / 120, per DESIGN). With no hit, or no query, this degrades
 * to a head cut of the same total width so callers never need two code paths.
 */
export function centeredSnippetWindow(text, query, { before = 40, after = 120 } = {}) {
  const body = String(text ?? '')
  const points = Array.from(body)
  const width = Math.max(1, before + after)
  const hit = firstHit(body, queryTerms(query))
  // firstHit returns a UTF-16 index; pagination and slicing use code points.
  const hitPoint = hit < 0 ? -1 : Array.from(body.slice(0, hit)).length
  const start = points.length <= width || hitPoint < 0 ? 0 : Math.max(0, hitPoint - before)
  const end = Math.min(points.length, start + width)
  const truncated = start > 0 || end < points.length
  return {
    body: (start > 0 ? ELLIPSIS : '') + points.slice(start, end).join('') + (end < points.length ? ELLIPSIS : ''),
    start, end, returnedChars: end - start, totalChars: points.length, truncated,
  }
}

export function centeredSnippet(text, query, options = {}) {
  return centeredSnippetWindow(text, query, options).body
}

/**
 * S2/S6 冲突卡：两条对同一事实的不同说法并排，不替模型裁决。
 * 单卡 200 字以内；两个 id 都必须出现，否则调用方应丢弃这张卡。
 * P1-2: A/B 顺序只按本地 fact_authority + 时间排，不增加任何文字。
 */
const FACT_AUTHORITY = { user_said: 3, tool: 2, told: 2, inferred: 1, imagined: 0 }

function authorityOf(entry) {
  const explicit = Number(entry?.fact_authority)
  if (Number.isFinite(explicit)) return explicit
  return FACT_AUTHORITY[entry?.source_kind || entry?.source] ?? 0
}

function observedOf(entry) {
  return String(entry?.observed_at || entry?.updatedAt || entry?.createdAt || '')
}

export function conflictCard({ factKey, left, right, members = null, maxChars = 200, titleChars = 40 } = {}) {
  if (!members && (!left?.id || !right?.id)) return ''
  const ordered = (members || [left, right]).filter(item => item?.id).slice().sort((a, b) => Number(a.available === false) - Number(b.available === false)
    || authorityOf(b.entry) - authorityOf(a.entry) || observedOf(b.entry).localeCompare(observedOf(a.entry)) || String(a.id).localeCompare(String(b.id)))
  if (!ordered.length) return ''
  const cut = (value, count) => {
    const points = Array.from(redactSecrets(value).replace(/\s+/g, ' ').trim())
    return points.length <= count ? points.join('') : count > 0 ? points.slice(0, count - 1).join('') + ELLIPSIS : ''
  }
  const titles = ordered.map(item => item.available === false ? '' : item.entry?.title || item.entry?.content || '(untitled)')
  const widths = titles.map(title => Math.min(titleChars, Array.from(title).length))
  const flags = ordered.map(item => {
    if (item.available === false) return ''
    const entry = item.entry || {}
    const source = entry.source || 'inferred'
    return [source !== 'inferred' ? `source=${source}` : '', entry.source_kind && entry.source_kind !== source ? `source_kind=${entry.source_kind}` : '',
      entry.disclosure && entry.disclosure !== 'can_tell' ? `disclosure=${entry.disclosure}` : '',
      entry.speaker_id ? `speaker=${entry.speaker_id}` : ''].filter(Boolean).map(value => redactSecrets(value)).join(' · ')
  })
  const render = header => [`冲突 · ${header}`, ...ordered.map((item, i) => {
    const label = String.fromCharCode(65 + i)
    if (item.available === false) return `- ${label} 另有不可见/不可用版本`
    const date = item.entry?.absolute_date ? `（${redactSecrets(item.entry.absolute_date)}）` : ''
    const title = cut(titles[i], widths[i])
    return `- ${label} [${item.id}]${title ? ' ' + title : ''}${date}${flags[i] ? ' · ' + flags[i] : ''}`
  }), '- 未确认哪版为准'].join('\n')
  let header = cut(factKey || '同一事实', 60)
  let text = render(header)
  while (Array.from(text).length > maxChars && widths.some(width => width > 0)) {
    const largest = widths.indexOf(Math.max(...widths))
    widths[largest] -= 1
    text = render(header)
  }
  if (Array.from(text).length > maxChars) { header = '同一事实'; text = render(header) }
  return Array.from(text).length <= maxChars ? text : ''
}
