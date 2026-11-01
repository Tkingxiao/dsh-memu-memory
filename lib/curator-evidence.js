// Evidence grounding for the global curator (spec §4.6).
//
// A quote is only evidence if it can be replayed: normalized, it must be a
// substring of the normalized transcript of a session that was part of THIS
// curation run. Summaries may not masquerade as verbatim quotes; invented
// session ids fail the membership test. Two modes:
//   * strict   — sessionCorpus provided (production startGlobalCuration always
//                passes it): membership + substring checks apply, status
//                'grounded'.
//   * unverified — no sessionCorpus (tests / direct commitCuratorOutput calls):
//                shape checks only, status 'unverified'. The production caller
//                MUST pass the corpus; commitCuratorOutput treats a missing
//                corpus on the production path as its own risk, which is why
//                startGlobalCuration is wired to always build one.
//
// Every stored quote passes redactSecrets BEFORE storage, and the corpus
// transcripts are redacted too (condenseEvents), so a quote containing a raw
// secret fails the substring check instead of landing in the index.

import { redactSecrets } from './paths.js'
import {
  EVIDENCE_ELLIPSIS_MAX_SEGMENTS,
  EVIDENCE_ELLIPSIS_MIN_CHARS,
  EVIDENCE_MIN_CHARS,
  LINK_NOTE_MAX,
  LINK_NOTE_MIN,
} from './curator-policy.js'

/** NFKC → lowercase → strip whitespace/punctuation/symbols (§4.6). */
export function normalizeEvidenceText(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * sessions: [{ id, transcript }] (startGlobalCuration's condensed sessions).
 * Returns the shape groundEvidence expects: { ids: Set, text: Map<id, normalized> }.
 */
export function buildEvidenceCorpus(sessions) {
  const ids = new Set()
  const text = new Map()
  for (const session of sessions || []) {
    const id = String(session?.id || '').trim()
    if (!id) continue
    ids.add(id)
    text.set(id, normalizeEvidenceText(session?.transcript ?? session?.text ?? ''))
  }
  return { ids, text }
}

/** '…' / '...' segment split for elided quotes; runs ('……') count as one divider. */
function splitEllipsis(quote) {
  return String(quote || '').split(/…+|\.{3,}/)
}

/**
 * groundEvidence(evidence, sessionCorpus, { minChars }) →
 *   { valid: [{sessionId, quote, sourceId?}], invalid: [{sessionId, quote, reason}], status }
 *
 * Rules (§4.6, in order):
 *   1. session_id must belong to this curation's session set (strict mode).
 *   2. normalized quote ≥ minChars (default 6).
 *   3. normalized quote is a substring of the normalized transcript → valid.
 *   4. quotes containing …/... split into segments: every segment ≥4 normalized
 *      chars, at most 3 segments, every segment a substring.
 *   5. quotes are redactSecrets'd before storage.
 *   6. no sessionCorpus → items are shape-checked only, status 'unverified'.
 *   7. source_id (absorb provenance, consumed by F2) is passed through when present.
 */
export function groundEvidence(evidence, sessionCorpus, { minChars = EVIDENCE_MIN_CHARS } = {}) {
  const valid = []
  const invalid = []
  const strict = sessionCorpus != null
  const list = Array.isArray(evidence) ? evidence : []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const sessionId = String(raw.session_id ?? raw.sessionId ?? '').trim()
    const quoteRaw = String(raw.quote ?? '')
    const quote = redactSecrets(quoteRaw)
    const normalized = normalizeEvidenceText(quote)
    const pushInvalid = (reason) => invalid.push({ sessionId, quote: quoteRaw, reason })
    if (!sessionId) { pushInvalid('missing session_id'); continue }
    if (normalized.length < minChars) { pushInvalid(`quote shorter than ${minChars} chars`); continue }
    if (!strict) {
      valid.push({ sessionId, quote, ...(raw.source_id ? { sourceId: String(raw.source_id) } : {}) })
      continue
    }
    if (!sessionCorpus.ids.has(sessionId)) { pushInvalid('session not part of this curation'); continue }
    const transcript = sessionCorpus.text.get(sessionId) || ''
    if (!transcript) { pushInvalid('session transcript is empty'); continue }
    if (/…|\.\.\./.test(quoteRaw)) {
      const segments = splitEllipsis(quoteRaw)
      if (segments.length < 2 || segments.length > EVIDENCE_ELLIPSIS_MAX_SEGMENTS) {
        pushInvalid(`ellipsis quote must have 2-${EVIDENCE_ELLIPSIS_MAX_SEGMENTS} segments`)
        continue
      }
      const normalizedSegments = segments.map((segment) => normalizeEvidenceText(segment))
      if (normalizedSegments.some((segment) => segment.length < EVIDENCE_ELLIPSIS_MIN_CHARS)) {
        pushInvalid(`ellipsis segment shorter than ${EVIDENCE_ELLIPSIS_MIN_CHARS} chars`)
        continue
      }
      if (!normalizedSegments.every((segment) => transcript.includes(segment))) {
        pushInvalid('ellipsis segment not found in session')
        continue
      }
    } else if (!transcript.includes(normalized)) {
      pushInvalid('quote not found in session')
      continue
    }
    valid.push({ sessionId, quote, ...(raw.source_id ? { sourceId: String(raw.source_id) } : {}) })
  }
  return { valid, invalid, status: strict ? 'grounded' : 'unverified' }
}

/**
 * §4.9.4：link note 8-500 字（去空白计长），且必须原样包含至少一句落地 quote。
 * validEvidence 是 groundEvidence(...).valid。返回 { ok, reason }。
 */
export function groundLinkNote(note, validEvidence) {
  const noteText = String(note || '')
  const noteLen = noteText.replace(/\s+/g, '').length
  if (noteLen < LINK_NOTE_MIN || noteLen > LINK_NOTE_MAX) {
    return { ok: false, reason: `note length ${noteLen} outside ${LINK_NOTE_MIN}-${LINK_NOTE_MAX}` }
  }
  const normalizedNote = normalizeEvidenceText(noteText)
  if (!normalizedNote) return { ok: false, reason: 'note is empty after normalization' }
  for (const item of validEvidence || []) {
    const quote = normalizeEvidenceText(item?.quote)
    if (quote && normalizedNote.includes(quote)) return { ok: true, reason: null }
  }
  return { ok: false, reason: 'note must quote at least one grounded evidence verbatim' }
}
