// Cutting a memory down for a search result.
//
// A tool result used to be `truncate(content, 1200)`, i.e. the head. For a search
// hit that is the wrong 1200 characters: the passage that matched may sit in the
// middle of a long entry, and the model is then handed a snippet that does not
// explain why this entry came back. So when we know the query, cut around the
// hit instead — a little before it for context, more after it, because that is
// the direction the answer usually continues in.

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
export function centeredSnippet(text, query, { before = 40, after = 120 } = {}) {
  const body = String(text ?? '')
  const width = Math.max(1, before + after)
  if (body.length <= width + 1) return body
  const terms = queryTerms(query)
  const hit = firstHit(body, terms)
  if (hit < 0) return body.slice(0, width) + ELLIPSIS
  const start = Math.max(0, hit - before)
  const end = Math.min(body.length, start + width)
  const head = start > 0 ? ELLIPSIS : ''
  const tail = end < body.length ? ELLIPSIS : ''
  return head + body.slice(start, end) + tail
}

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + ELLIPSIS
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

export function conflictCard({ factKey, left, right } = {}) {
  if (!left?.id || !right?.id) return ''
  const side = (item, label) => {
    const entry = item.entry || {}
    const title = entry.title || entry.content || '(untitled)'
    const date = entry.absolute_date ? `（${entry.absolute_date}）` : ''
    return `- ${label} [${item.id}] ${clip(title, 40)}${date}`
  }
  const ordered = [left, right].sort((a, b) => authorityOf(b.entry) - authorityOf(a.entry)
    || observedOf(b.entry).localeCompare(observedOf(a.entry))
    || String(a.id).localeCompare(String(b.id)))
  return clip([
    `冲突 · ${clip(factKey || '同一事实', 60)}`,
    side(ordered[0], 'A'),
    side(ordered[1], 'B'),
    '- 未确认哪版为准',
  ].join('\n'), 200)
}
