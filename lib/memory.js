import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { STORED_VISIBILITIES, LEGACY_SESSION } from './visibility.js'
import {
  ensureSession, getSessionBinding, memoryDbPath, globalDbPath,
  loadPrivateIndex, savePrivateIndex, loadGlobalIndex, saveGlobalIndex,
  updatePrivateIndex, updateGlobalIndex,
  newMemoryId, getSettings, getMemoryBackend, getActiveCue, consumeCue,
  getLibrary, setSessionBinding, effectiveScope, listLibrariesAll,
} from './state.js'
import { stamp, redactSecrets, retryStoreWrite } from './paths.js'
import { BASE_AROUSAL, moodCongruence, moodDecay } from './mood.js'
import { commit, retrieve, listFiles, forget } from './memu.js'
import { bumpStats } from './stats.js'
import { recallRelations } from './graph.js'
import { attachmentRefs } from './media.js'
import { normalizeMemoryContext, contextVisible, sameFactContext } from './context.js'

const HALF_LIFE_DAYS = 14
// A short-term entry is meant to live for the length of a conversation, not a
// season, so it fades on its own short half-life: by the time it reaches the
// anchor as a pointer it is already weak, and it never outranks a durable memory
// of the same age. Anything worth keeping has to be promoted before it expires.
const SHORT_TERM_HALF_LIFE_DAYS = 1
// Habituation: a memory pushed into the prompt three turns in a row stops being
// news. The penalty is bounded and self-clearing — it lifts as soon as the entry is
// edited (it became new information again) or once the window passes, which is the
// "de-habituation" half of the pair. Without this the same two memories fill the
// block every turn and the model learns to skim past them.
const HABITUATION_WINDOW_MS = 12 * 3_600_000
const HABITUATION_STEP = 0.12
const HABITUATION_FLOOR = 0.5
// Maximal marginal relevance. Retrieval optimises "relevant", not "different", so a
// library with three variants of the same decision would spend the whole block on it.
// The top hit is always kept; later picks pay lambda x max-similarity-to-what-is-in.
const MMR_LAMBDA = 0.72
const LAYERS = ['long_term', 'short_term', 'must_remember']
// These three are read back by the injector to decide how a memory may be spoken and
// where it may appear. An unchecked typo would silently mean "no suffix at all", so
// they are validated on the way in rather than trusted on the way out.
const DISCLOSURES = ['can_tell', 'only_if_asked', 'never_say']
const OWNERS = ['me', 'us', 'about_user', 'about_project']
// `session` used to be a third level here. It is gone: see `lib/visibility.js` for why
// a lease on one conversation could not express anything useful, and what replaced it
// (`context`: channel / character / world / branch). Legacy entries are read as shared.
const VISIBILITIES = STORED_VISIBILITIES
// Where the memory came from. This is not decoration: 'user_said' means the words are
// quotable, everything else means they are our own reconstruction and must be hedged
// when repeated. Defaulting to 'user_said' labelled every model-inferred memory as a
// quote, which systematically inflated confidence in things nobody had said.
const SOURCES = ['user_said', 'inferred', 'imagined', 'told']

function checkEnums({ disclosure, owner, visibility, source }) {
  if (disclosure !== undefined && !DISCLOSURES.includes(disclosure)) {
    throw new Error(`disclosure must be ${DISCLOSURES.join(', ')}`)
  }
  if (owner !== undefined && !OWNERS.includes(owner)) {
    throw new Error(`owner must be ${OWNERS.join(', ')}`)
  }
  if (visibility !== undefined && !VISIBILITIES.includes(visibility)) {
    // A model that remembers the old level needs to be told what replaced it, or it will
    // simply retry the same value: `session` was removed because it could not express
    // "readable by this character in another conversation" — that is `context`.
    if (visibility === LEGACY_SESSION) {
      throw new Error("visibility 'session' was removed: use 'shared' (the whole folder) or 'secret' (recall only, never auto-injected), and scope a memory to a channel/character/world/branch with the context fields")
    }
    throw new Error(`visibility must be ${VISIBILITIES.join(', ')}`)
  }
  if (source !== undefined && !SOURCES.includes(source)) {
    throw new Error(`source must be ${SOURCES.join(', ')}`)
  }
}
// Below this, the present-mood read is noise and must not bend retrieval at all.
const MOOD_MIN_STRENGTH = 0.15
// Long enough that the reason has to say what happened and why it can be let go,
// not just "让它过去吧".
const UNPIN_MIN_REASON = 20

// Three host shapes reach this function: a ToolExecution / pre-step payload /
// system-prompt context (`{ agent }`), and — on the injection path — the Agent
// itself. The Agent has no `.agent`, so reading only the first shape returned
// null there and made every per-turn recall fail silently. See P0-1.
export function sessionIdOf(exec) {
  return exec?.agent?.session?.header?.id
    || exec?.session?.header?.id
    || exec?.agent?.id
    || null
}

export function bindingFor(exec) {
  const sessionId = sessionIdOf(exec)
  if (!sessionId) return null
  const header = exec?.agent?.session?.header || {}
  return ensureSession(sessionId, { cwd: header.cwd, agentPreset: header.agentPreset })
}

// Read-only twin of `bindingFor`. The agent-facing paths want `ensureSession`
// because a first write should auto-bind the conversation to its folder's library;
// pure reads must not create anything, since an RPC that invents an empty cwd
// would otherwise materialize a placeholder library for an unbound conversation.
export function peekBinding(exec) {
  const sessionId = sessionIdOf(exec)
  return sessionId ? getSessionBinding(sessionId) : null
}

function memorySessionId(exec) {
  return peekBinding(exec)?.memoryOwnerSessionId || sessionIdOf(exec)
}

export function domainOf(binding) {
  return binding?.domainOverride || binding?.domain || 'general'
}

// The memory browser works on a library directly, with no session in hand, while
// every agent-facing path resolves through the session binding.
export function resolveLibrary({ exec, libraryId, readOnly = false }) {
  const id = libraryId === undefined || libraryId === null || libraryId === '' ? null : String(libraryId)
  if (id !== null) {
    const lib = getLibrary(id)
    if (!lib) throw new Error(`unknown library: ${id}`)
    const binding = peekBinding(exec)
    if (sessionIdOf(exec) && (!binding || binding.libraryId !== id)) throw new Error('library is not bound to this conversation')
    if (binding) assertScopeEnabled(binding)
    return { libraryId: lib.id, binding }
  }
  const binding = readOnly ? peekBinding(exec) : bindingFor(exec)
  if (!binding) throw new Error('no bound session')
  // A binding without a library means the conversation explicitly opted out of
  // private memory. Writing through it used to land in `index/null.json` — a
  // "successful" write that can never be recalled. Refuse with an actionable
  // message instead.
  if (!binding.libraryId) {
    throw new Error('this conversation has no memory library; enable private memory in Settings → Folders or pick a library for the new session')
  }
  return { libraryId: binding.libraryId, binding }
}

// The sidebar switches (and the folder ceiling behind them) must constrain tool
// calls too, not just injection. One gate, sourced from `effectiveScope` so the
// folder policy is always part of the answer.
function assertScopeEnabled(binding, { layer = 'library' } = {}) {
  if (!binding) return
  const scope = effectiveScope(binding)
  if (layer === 'library' && !scope.useLibrary) {
    throw new Error(scope.libraryBlocked
      ? 'private memory is disabled for this folder; enable it in Settings → Folders first'
      : 'private memory is turned off for this conversation')
  }
  if (layer === 'global' && !scope.useGlobal) {
    throw new Error(scope.globalBlocked
      ? 'global memory is disabled for this folder; enable it in Settings → Folders first'
      : 'global memory is turned off for this conversation')
  }
}

function clampText(text, max) {
  const s = String(text || '')
  return s.length > max ? s.slice(0, max) : s
}

/**
 * Accepts a full id, or an unambiguous prefix of one. Models mistype long ids;
 * failing the whole call over one character costs a retry and the tokens that go
 * with it, while an ambiguous prefix can safely list its candidates.
 */
export function resolveEntryId(index, ref) {
  const clean = String(ref || '').trim().replace(/\.md$/, '')
  if (!clean) throw new Error('id is required')
  if (index.entries?.[clean]) return clean
  const matches = Object.keys(index.entries || {}).filter((id) => id.startsWith(clean))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    throw new Error(`ambiguous id "${ref}"; candidates: ${matches.slice(0, 8).join(', ')}${matches.length > 8 ? ', …' : ''}`)
  }
  throw new Error(`unknown memory: ${ref}`)
}

// A salient date is one of two different things, and conflating them lost data:
//   'MM-DD'     an anniversary — the same day comes back every year (a birthday).
//   'YYYY-MM-DD' a dated memory — one specific day ("the driving test is on
//               2026-10-29"). Dropping the year turned that into an anniversary
//               that fires every 29 October forever and never announced the exam.
// Anything unparseable is rejected rather than guessed, because a wrong date is
// worse than none — but silently dropping a date the caller did supply looked
// like success while throwing away the only part it cared about, so callers now
// get an error instead (see privateRemember / privateUpdate).
const SALIENT_SHORT = /^(\d{1,2})-(\d{1,2})$/
const SALIENT_FULL = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s].*)?$/

function pad2(n) {
  return String(n).padStart(2, '0')
}

// Day 0 of the following month is the last day of this one; UTC so a DST change
// cannot move the answer.
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function normalizeSalientDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const text = value.trim()
  const short = SALIENT_SHORT.exec(text)
  if (short) {
    const month = Number(short[1])
    const day = Number(short[2])
    if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null
    return `${pad2(month)}-${pad2(day)}`
  }
  // A calendar date is read as text, never through Date.parse: parsing shifts
  // across the local/UTC boundary ('2026-1-5' came back as 01-04) and silently
  // rolls impossible dates over ('2026-02-30' became 03-02).
  const full = SALIENT_FULL.exec(text)
  if (!full) return null
  const year = Number(full[1])
  const month = Number(full[2])
  const day = Number(full[3])
  if (!(month >= 1 && month <= 12)) return null
  if (!(day >= 1 && day <= daysInMonth(year, month))) return null
  // The year is kept: a dated memory is checked against the calendar once.
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`
}

export function isDatedSalientDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

// "明天要去考驾照" is one appointment, not something that recurs every year. An
// extractor that resolves 明天 to 10-29 and hands back MM-DD turns the appointment
// into a yearly anniversary that resurfaces every 29 October forever — the memory
// says "tomorrow" and the schedule says "every year". The write side settles it:
// when the text names a relative day and the MM-DD matches that day, store the
// fully dated form, which injects as a due date instead of an anniversary.
const RELATIVE_DAY_OFFSETS = [
  [/the\s+day\s+after\s+tomorrow/i, 2], [/后天/, 2], [/次日/, 1],
  [/tomorrow/i, 1], [/明天|明日/, 1], [/tonight/i, 0], [/today/i, 0], [/今天|今晚/, 0],
]

export function reconcileSalientDate(value, text, now = new Date()) {
  if (!SALIENT_SHORT.test(String(value || ''))) return value
  const body = String(text || '')
  if (!body) return value
  const short = String(value)
  // An explicit full date in the same memory wins: it is the anchor the text itself
  // committed to, and it settles the year without guessing.
  for (const match of body.matchAll(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/g)) {
    if (`${pad2(match[2])}-${pad2(match[3])}` === short) return `${match[1]}-${pad2(match[2])}-${pad2(match[3])}`
  }
  const offset = RELATIVE_DAY_OFFSETS.find(([pattern]) => pattern.test(body))?.[1]
  if (offset === undefined) return value
  // Only convert when the stated month-day is the day the relative word points at.
  // A mismatch means the date came from somewhere else and must not be rewritten.
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
  if (`${pad2(target.getMonth() + 1)}-${pad2(target.getDate())}` !== short) return value
  return `${target.getFullYear()}-${pad2(target.getMonth() + 1)}-${pad2(target.getDate())}`
}

// How many days ahead today is from a dated memory (0 = due today, negative =
// already past). An anniversary has no distance: it is true every year.
export function salientDaysAhead(salientDate, now = new Date()) {
  if (!isDatedSalientDate(salientDate)) return null
  const parts = salientDate.split('-').map(Number)
  const due = Date.UTC(parts[0], parts[1] - 1, parts[2])
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((due - today) / 86_400_000)
}

// One day of warning: a dated memory is useful the day before ("it is tomorrow")
// and useful on the day itself. A window rather than a single match because the
// conversation that needs the reminder may not be happening on the exact date.
export const SALIENT_DUE_LEAD_DAYS = 1

// The single place that decides whether a salient date surfaces on `now`. Both
// the injector and any future surface must ask this, so a one-off can never be
// read as an anniversary by one path and as an appointment by another.
export function salientDateFires(salientDate, now = new Date()) {
  const value = normalizeSalientDate(salientDate)
  if (!value) return false
  if (!isDatedSalientDate(value)) {
    return value === `${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
  }
  const ahead = salientDaysAhead(value, now)
  return ahead !== null && ahead >= 0 && ahead <= SALIENT_DUE_LEAD_DAYS
}

// A pinned memory still fades — just slowly enough that it never becomes noise.
// Without a half-life it stayed at 1.0 forever, which made "permanent" mean
// "verbatim forever"; the floor is what keeps the tip-of-the-tongue effect
// (below) from eating details of things that must not be forgotten.
const MUST_REMEMBER_HALF_LIFE_DAYS = 365
const MUST_REMEMBER_FLOOR = 0.35

// Negativity bias: unpleasant memories are rehearsed more, so they hold on
// longer. Self-reference does the same for anything about me or us. Both are
// multipliers on the half-life rather than on the score, because they change how
// long a memory lives, not how loudly it competes right now.
const NEGATIVE_HALF_LIFE_FACTOR = 0.30
const SELF_HALF_LIFE_FACTOR = 0.15

/** How much longer an unpleasant memory lives, 1..1.30. Below -0.2 to trigger. */
export function negativityBias(entry) {
  const valence = Number(entry?.moodValence || 0)
  if (!(valence <= -0.2)) return 1
  return 1 + Math.min(NEGATIVE_HALF_LIFE_FACTOR, Math.abs(valence) * NEGATIVE_HALF_LIFE_FACTOR)
}

/** Memories about me/us last longer than memories about the world, 1..1.15. */
export function selfReferenceBias(entry) {
  return entry?.owner === 'me' || entry?.owner === 'us' ? 1 + SELF_HALF_LIFE_FACTOR : 1
}

export function decayStrength(entry) {
  if (!entry) return 1
  if (entry.marginalized) return 0.2
  const base = typeof entry.strength === 'number' ? entry.strength : 1
  const updated = Date.parse(entry.updatedAt || entry.createdAt || '') || Date.now()
  const days = Math.max(0, (Date.now() - updated) / 86_400_000)
  const access = 1 + Math.min(0.5, (entry.accessCount || 0) * 0.05)
  if (entry.layer === 'must_remember') {
    const decay = Math.pow(0.5, days / MUST_REMEMBER_HALF_LIFE_DAYS)
    return Math.max(MUST_REMEMBER_FLOOR, Math.min(1.5, base * decay * access))
  }
  const halfLife = entry.layer === 'short_term' ? SHORT_TERM_HALF_LIFE_DAYS : HALF_LIFE_DAYS
  const biased = halfLife * negativityBias(entry) * selfReferenceBias(entry)
  const decay = Math.pow(0.5, days / biased)
  return Math.max(0.05, Math.min(1.5, base * decay * access))
}

// Fading affect bias: the feeling of a bad memory goes neutral faster than the
// feeling of a good one. The events keep their place in the library; what bleeds
// away is the tint, which is why this returns a valence and not a strength.
const FAB_HALF_LIFE_DAYS = { negative: 21, positive: 120 }

/**
 * The valence this memory still carries today. Negative tints decay 6x faster
 * than positive ones (21 vs 120 days), so an old grudge reads milder than it did
 * while an old fondness keeps its colour.
 */
export function fadedValence(entry, now = Date.now()) {
  const valence = Number(entry?.moodValence || 0)
  if (!valence) return 0
  const updated = Date.parse(entry?.updatedAt || entry?.createdAt || '') || now
  const days = Math.max(0, (now - updated) / 86_400_000)
  const halfLife = valence < 0 ? FAB_HALF_LIFE_DAYS.negative : FAB_HALF_LIFE_DAYS.positive
  return valence * Math.pow(0.5, days / halfLife)
}

/**
 * Flashbulb memory: high arousal makes a memory feel vivid, and vividness is not
 * accuracy. `confidence` stays what the model said it was sure of; `accuracy` is
 * our own estimate, discounted by arousal and peakness. The two are stored apart
 * so a memory can be "clearly remembered, possibly wrong" — a state people are
 * in all the time and that a single confidence number cannot express.
 */
export function accuracyOf({ peak = false, arousal = 0.35, confidence = 0.8 } = {}) {
  const confRaw = Number(confidence)
  const conf = Math.max(0, Math.min(1, Number.isFinite(confRaw) ? confRaw : 0.8))
  const charge = Math.max(0, Math.min(1, Number(arousal) || 0))
  const heightened = peak === true || charge > 0.7
  if (!heightened) return conf
  // The higher the charge, the wider the gap between "vivid" and "correct".
  const discount = Math.min(0.5, Math.max(0, charge - 0.5) * 1.2)
  return Math.round(Math.max(0.2, conf * (1 - discount)) * 100) / 100
}

/**
 * Tip of the tongue: the memory is reachable but the wording is not. True for
 * anything we are unsure of, and for anything old enough to have worn down — but
 * never for must_remember, whose whole point is that the wording survives.
 */
export function isTipOfTongue(entry) {
  if (!entry) return false
  if (entry.layer === 'must_remember') return false
  if (entry.marginalized) return true
  const confidence = Number(entry.confidence)
  if (Number.isFinite(confidence) && confidence < 0.5) return true
  return decayStrength(entry) < 0.4
}

// ---- Contradiction detection (appendix B-14) ----
// Not semantic entailment: two bigram sets and a negation test. It only has to be
// good enough to stop "he likes tea" and "he hates tea" from sitting side by side
// as equally true, and quiet enough that ordinary rewordings do not trip it.
function bigrams(text) {
  const clean = String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  const out = new Set()
  for (let i = 0; i < clean.length - 1; i += 1) out.add(clean.slice(i, i + 2))
  return out
}

function dice(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  return (2 * shared) / (a.size + b.size)
}

const NEGATION_RE = /不|没|别|无|never|not|no longer|doesn't|don't/i

/**
 * Same subject, opposite claim. Returns the entry it collides with, or null.
 * Two tests, in order of confidence:
 *   1. same normalised title and clearly different body → conflict
 *   2. similar body but only one side carries a negation → conflict
 */
export function findConflict(entries, candidate) {
  const title = String(candidate?.title || '').trim().toLowerCase()
  const body = String(candidate?.content || '')
  const grams = bigrams(body)
  const candidateNegated = NEGATION_RE.test(body)
  for (const [id, entry] of Object.entries(entries || {})) {
    if (!entry || entry.status === 'archived' || entry.status === 'suppressed') continue
    if (!sameFactContext(entry.context, candidate?.context)) continue
    if (entry.status === 'pending_review' || entry.status === 'superseded') continue
    const otherTitle = String(entry.title || '').trim().toLowerCase()
    const otherBody = String(entry.content || '')
    if (title && title === otherTitle) {
      if (dice(grams, bigrams(otherBody)) < 0.95) return { id, entry, reason: 'same_title' }
      continue
    }
    const similarity = dice(grams, bigrams(otherBody))
    if (similarity < 0.55) continue
    if (candidateNegated !== NEGATION_RE.test(otherBody)) {
      return { id, entry, reason: 'negation' }
    }
  }
  return null
}

function mirrorContent(file) {
  const raw = file?.content
  if (typeof raw === 'string' && raw.trim()) return raw
  const filePath = file?.path
  if (typeof filePath !== 'string' || !filePath) return ''
  try {
    const resolved = path.resolve(filePath)
    const allowedRoots = [path.join(os.homedir(), '.memu'), path.join(os.homedir(), '.dsh', 'dsh-memu-memory')]
    if (!allowedRoots.some((root) => resolved.startsWith(path.resolve(root) + path.sep))) return ''
    return fs.readFileSync(resolved, 'utf8')
  } catch {
    return ''
  }
}

function enrichFiles(result, index) {
  const files = Array.isArray(result?.files) ? result.files : []
  const segments = Array.isArray(result?.segments) ? result.segments : []
  const byName = index?.entries || {}
  return {
    files: files.map((file) => {
      const entry = byName[file.name] || null
      return {
        ...file,
        content: entry ? String(entry.content || '') : '',
        entry,
        strength: decayStrength(entry),
        createdAtIdentity: entry?.createdAt || null,
      }
    }),
    segments,
    resources: Array.isArray(result?.resources) ? result.resources : [],
    raw: result?.raw,
    parseWarning: result?.parseWarning,
  }
}

export function isMemoryEligible(entry, { automatic = false, now = Date.now() } = {}) {
  if (!entry) return false
  // pending_review is a held claim: it must not compete in recall or reach a
  // prompt until a human (or the next consolidation pass) settles it — same rule
  // as the anchor and the anniversary injections.
  if (entry.status === 'archived' || entry.status === 'suppressed' || entry.status === 'expired' || entry.status === 'pending_review') return false
  // A claim waiting for review is not yet a memory. Injecting it before a human
  // settles the conflict would put both halves of a contradiction into the prompt
  // and let the model pick a side on its own.
  if (entry.status === 'superseded') return false
  // Defensive second gate: the sweep runs on a timer, so between two sweeps the
  // deadline itself has to be authoritative. An expired draft must never reach a
  // prompt just because the cleaner has not run yet.
  if (entry.expiresAt && (Date.parse(entry.expiresAt) || 0) <= now) return false
  if (automatic && entry.visibility === 'secret') return false
  return true
}

const isActive = (entry) => isMemoryEligible(entry)

function assertEntryAccess(entry, exec) {
  if (sessionIdOf(exec) && !visibleToSession(entry, memorySessionId(exec))) {
    throw new Error('memory is not visible to this conversation')
  }
}

// Local mode has no embedding service to rank candidates, so the index itself is
// the retrieval source. The tokenizer is deliberately small and dependency-free:
// Latin words plus CJK unigrams/bigrams, which is enough for the short, concrete
// memories this plugin stores and works identically on every platform.
function queryTokens(query) {
  const text = String(query || '').toLowerCase()
  const tokens = new Set(text.match(/[a-z0-9_]+/g) || [])
  for (const run of text.match(/[\u3400-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length; i += 1) {
      tokens.add(run[i])
      if (i + 1 < run.length) tokens.add(run.slice(i, i + 2))
    }
  }
  return [...tokens].filter(Boolean)
}

function lexicalScore(entry, tokens) {
  if (!tokens.length) return 0
  const title = String(entry?.title || '').toLowerCase()
  const content = [entry?.content || '', ...(entry?.attachments || []).map(item => `${item.caption || ''} 图片 ${item.kind || 'image'}`)].join(' ').toLowerCase()
  const tags = (Array.isArray(entry?.tags) ? entry.tags : []).join(' ').toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (title.includes(token)) score += 4
    if (tags.includes(token)) score += 2
    if (content.includes(token)) score += 1
  }
  // Longer queries should not win just by having more tokens in common; the
  // average keeps scores comparable across one-word and sentence queries.
  return score / tokens.length
}

function localIndexFiles(index) {
  return Object.entries(index?.entries || {}).map(([name, entry]) => ({
    name,
    description: entry?.title || '',
    content: String(entry?.content || ''),
    entry,
    strength: decayStrength(entry),
    createdAtIdentity: entry?.createdAt || null,
  }))
}

function localRecall(index, query, filter = () => true) {
  const files = localIndexFiles(index).filter((file) => isActive(file.entry) && filter(file))
  if (/^(?:g?mem)[-_][a-z0-9_-]+(?:\.md)?$/i.test(String(query || '').trim())) {
    const id = resolveEntryId(index, String(query).trim())
    return { files: files.filter(file => file.name === id).map(file => ({ ...file, lexical: 5 })), segments: [], resources: [], raw: null, parseWarning: null }
  }
  const tokens = queryTokens(query)
  const ordered = tokens.length === 0
    ? files.sort((a, b) => String(b.entry?.updatedAt || b.entry?.createdAt || '')
      .localeCompare(String(a.entry?.updatedAt || a.entry?.createdAt || '')))
    : files
      .map((file) => ({ ...file, lexical: lexicalScore(file.entry, tokens) }))
      .filter((file) => file.lexical > 0)
      .sort((a, b) => b.lexical - a.lexical
        || String(b.entry?.updatedAt || b.entry?.createdAt || '')
          .localeCompare(String(a.entry?.updatedAt || a.entry?.createdAt || '')))
  return {
    files: ordered,
    segments: [],
    resources: [],
    raw: null,
    parseWarning: null,
  }
}

// Human-like recall ordering. Retrieval answers first (semantic match is still
// the primary signal, which is why it stays a rank decay), then these biases
// re-order within that set:
//   · mood-congruent  — a sad present state pulls up sad memories
//   · peak-end        — emotionally strong moments and the newest ones stand out
//   · primacy         — the earliest memories of a library stay easy to reach
// Every factor is bounded so no bias can outrank a good semantic hit by luck.
function recallScore(file, rank, context) {
  const entry = file.entry || {}
  const retrieval = 1 / (rank + 1)
  const strengthTerm = 0.6 + 0.4 * file.strength
  const marginal = entry.marginalized ? 0.35 : 1

  // Fading affect bias: what pulls is the tint the memory still carries today, not
  // the one it was written with. Old grievances quieten down; old fondness does not.
  const moodBias = context.moodEnabled
    ? 1 + 0.3 * moodCongruence(fadedValence(entry, context.now), context.moodValence)
    : 1
  const peak = entry.peak === true ? 1 : Math.max(0, Number(entry.arousal || 0))
  const end = context.lastCreatedAt && file.createdAtIdentity === context.lastCreatedAt ? 1 : 0
  const peakEnd = 1 + 0.25 * Math.max(peak, end)
  const primacy = context.firstCreatedAt && file.createdAtIdentity === context.firstCreatedAt ? 1.2 : 1
  // Arousal narrows recall: a charged present pulls up the charged memories, a calm
  // one favours the quiet ones. Same family as mood-congruence but on intensity rather
  // than valence, which is why it is bounded tighter (+-16%) and rides on the same
  // "there is a mood worth using" gate. peakEnd below asks "was this moment loud?";
  // this asks "does its loudness match the room right now?" — different questions that
  // only look like duplicates.
  const arousalTerm = context.moodEnabled ? arousalBias(entry, context) : 1
  // An open loop is an unfinished thread — a promise, a question, a plan nobody
  // closed. Those are what a person brings up unprompted, so they get a nudge and not
  // a trump card: 1.25 still loses to a clearly better semantic hit.
  const openLoopBias = entry.openLoop ? 1.25 : 1
  const habituation = habituationFactor(entry, context.now)

  return retrieval * strengthTerm * marginal * moodBias * peakEnd * primacy * openLoopBias * habituation * arousalTerm
}

/**
 * How well a memory's emotional intensity fits the present state.
 *
 * drive = present arousal above/below the resting baseline. intensity = how charged the
 * memory itself was written (peak flags, stored arousal, or a strong valence as proxy).
 * Both are pushed to [-0.5, 0.5] before multiplying, so the factor stays within
 * 0.84..1.16 and can never outrank a semantic hit — it only reorders near-ties.
 */
function arousalBias(entry, context) {
  const present = Number(context.arousal == null ? BASE_AROUSAL : context.arousal)
  const drive = Math.max(-0.35, Math.min(0.65, present - BASE_AROUSAL))
  const intensity = Math.max(
    entry.peak === true ? 1 : 0,
    Math.min(1, Math.max(0, Number(entry.arousal || 0))),
    Math.min(1, Math.abs(Number(entry.moodValence || 0)) * 0.8),
  )
  return 1 + 0.5 * drive * (intensity - 0.5)
}

/** How worn out a memory is; 1 = fresh, floor-bounded. */
function habituationFactor(entry, now = Date.now()) {
  const count = Number(entry?.injectCount || 0)
  if (!(count > 1)) return 1
  const last = Date.parse(entry?.lastInjectAt || '') || 0
  if (last && now - last > HABITUATION_WINDOW_MS) return 1
  // Edited since the last injection: it says something new, so the wear resets.
  const updated = Date.parse(entry?.updatedAt || '') || 0
  if (updated && last && updated > last) return 1
  return Math.max(HABITUATION_FLOOR, 1 - HABITUATION_STEP * (count - 1))
}

// `relevanceThreshold` is relative, not absolute: recallScore is a product of
// bounded biases, so its scale depends on the library and a fixed cutoff would mean
// different things in different conversations. "Keep what scores within N of the best
// hit" is scale-free, and 0 turns the filter off entirely.
function cutWeakScores(files, threshold) {
  const cut = Number(threshold)
  if (!Number.isFinite(cut) || cut <= 0) return files
  const best = Number(files[0]?.score || 0)
  if (best <= 0) return files
  return files.filter((f) => Number(f.score || 0) >= best * cut)
}

function privateWeighted(result, max, context = {}) {
  const ctx = {
    moodEnabled: false,
    moodValence: 0,
    arousal: BASE_AROUSAL,
    firstCreatedAt: null,
    lastCreatedAt: null,
    sessionId: null,
    now: Date.now(),
    ...context,
  }
  const items = (result.files || [])
    .filter((f) => isMemoryEligible(f.entry, { automatic: ctx.automatic, now: ctx.now }))
    // Context is the only scope left: a memory written inside a channel / character /
    // world / branch is recalled only inside that same scope, and a blank scope (`{}`)
    // is one shared scope, so conversations that filled nothing in read each other's
    // memories. Filtering here keeps the anchor and the recall block in agreement.
    .filter((f) => visibleToSession(f.entry, ctx.sessionId))
    .filter((f) => !ctx.automatic || f.entry?.visibility !== 'secret')
    .map((f, i) => ({ ...f, score: recallScore(f, i, ctx) }))
    .sort((a, b) => b.score - a.score)
  return { ...result, files: mmrSelect(cutWeakScores(items, ctx.relevanceThreshold), max) }
}

/**
 * Greedy maximal marginal relevance over already-scored files.
 *
 * Similarity is lexical (queryTokens + Jaccard) on purpose: it must be cheap enough
 * to run on every recall and predictable enough to explain. An embedding version
 * would need a second engine round trip just to de-duplicate four lines.
 */
function mmrSelect(items, max, lambda = MMR_LAMBDA) {
  const limit = Number(max || 0)
  if (!(limit > 0)) return items
  if (items.length <= 1) return items.slice(0, limit)
  const chosen = []
  const pool = items.slice()
  const tokenCache = new Map()
  const tokensOf = (file) => {
    const key = file.name
    if (tokenCache.has(key)) return tokenCache.get(key)
    const set = new Set(queryTokens(String(file.entry?.title || '') + ' ' + String(file.entry?.content || '')))
    tokenCache.set(key, set)
    return set
  }
  // Anchor the penalty to the best raw score so the diversity term is on the same
  // scale as relevance instead of being dominated by it.
  const ceiling = Number(items[0]?.score || 0) || 1
  while (pool.length > 0 && chosen.length < limit) {
    let bestIdx = 0
    let bestScore = -Infinity
    for (let i = 0; i < pool.length; i += 1) {
      let overlap = 0
      for (const picked of chosen) overlap = Math.max(overlap, jaccard(tokensOf(pool[i]), tokensOf(picked)))
      const adjusted = Number(pool[i].score || 0) - lambda * overlap * ceiling
      if (adjusted > bestScore) { bestScore = adjusted; bestIdx = i }
    }
    chosen.push(pool.splice(bestIdx, 1)[0])
  }
  return chosen
}

/** Jaccard overlap of two token sets; 0 when either side is empty. */
function jaccard(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}

/**
 * Whether a memory may be recalled in this conversation.
 *
 * Context is the only scope left. `shared` and `secret` are both library-wide; `secret`
 * only changes whether the memory may surface on its own (it stays out of the anchor and
 * out of automatic recall), never who may recall it on purpose. A blank `context` is one
 * shared scope, which is why conversations that filled nothing in can read each other's
 * memories — including the secret ones, on an explicit recall.
 *
 * The removed `session` level is normalized to `shared` before it ever reaches this
 * function (`lib/state.js` on load, `lib/visibility.js` for the rule), so there is no
 * per-conversation branch to check here anymore.
 */
export function visibleToSession(entry, sessionId) {
  if (!entry) return true
  const binding = getSessionBinding(sessionId)
  return contextVisible(entry.context, binding?.memoryContext)
}

// The library's span endpoints, used by the primacy and end effects.
function createdAtSpan(files) {
  const stamps = files
    .map((f) => f.entry?.createdAt)
    .filter((v) => typeof v === 'string' && v)
    .sort()
  return { first: stamps[0] || null, last: stamps[stamps.length - 1] || null }
}

export async function privateRemember({
  exec, libraryId, content, title, layer, pinReason = null, pinSource = null,
  sideEventId = null, tags = [], openLoop = false, disclosure = 'can_tell',
  owner = 'me', visibility = 'shared', source = 'inferred', confidence = 0.8,
  moodValence = null, arousal = null, peak = false, salientDate = null,
  attachments, track = 'memory',
  context,
}) {
  const scope = resolveLibrary({ exec, libraryId })
  const binding = scope.binding
  const memoryContext = normalizeMemoryContext({ ...binding?.memoryContext, ...context })
  if (sessionIdOf(exec) && ['channelId', 'characterId', 'worldId', 'branchId'].some(key => binding?.memoryContext?.[key] && memoryContext[key] !== binding.memoryContext[key])) throw new Error('memory context cannot widen or change the bound conversation')
  if (sessionIdOf(exec) && !contextVisible({ ...memoryContext, knownBy: [] }, binding?.memoryContext)) {
    throw new Error('set the conversation memory context before writing into a different channel, character, world or branch')
  }
  const media = attachmentRefs(scope.libraryId, attachments)
  if (track !== 'memory' && track !== 'habit') throw new Error('track must be memory or habit')
  if (layer === undefined) layer = media.length && track !== 'habit' ? 'short_term' : 'long_term'
  if (sessionIdOf(exec) && media.length) {
    const known = new Set((binding?.pendingMedia || []).map(item => item.sha256))
    for (const entry of Object.values(loadPrivateIndex(scope.libraryId).entries)) {
      if (visibleToSession(entry, memorySessionId(exec))) for (const item of entry.attachments || []) known.add(item.sha256)
    }
    if (media.some(item => !known.has(item.sha256))) throw new Error('attachment was not received in this conversation')
  }
  // The folder switch is the ceiling and the conversation switch is the floor:
  // if either has private memory off, a write must be refused rather than
  // quietly landing in a library nobody reads.
  if (binding) assertScopeEnabled(binding)
  if (!content || !String(content).trim()) throw new Error('content is required')
  // An unreadable date is refused instead of dropped. Dropping it looked like
  // success to the caller while losing the only part of the memory it asked for:
  // a date that never fires is indistinguishable from no date at all.
  const normalizedSalientDate = reconcileSalientDate(normalizeSalientDate(salientDate), `${title || ''} ${content || ''}`)
  if (normalizedSalientDate === null && salientDate !== null && salientDate !== undefined && String(salientDate).trim()) {
    throw new Error('salient_date must be MM-DD (recurs every year) or YYYY-MM-DD (one specific day)')
  }
  content = redactSecrets(content)
  if (title !== undefined) title = redactSecrets(title)
  if (!LAYERS.includes(layer)) throw new Error(`unknown layer: ${layer}; use ${LAYERS.join(', ')}`)
  checkEnums({ disclosure, owner, visibility, source })
  // A short-term entry is a draft with a deadline. With the layer switched off the
  // write is refused rather than quietly upgraded to permanent memory, because the
  // model asked for something disposable and would otherwise pollute the durable
  // layer without either of us noticing.
  let expiresAt = null
  if (layer === 'short_term') {
    const ttl = Number(getSettings().shortTermTtlHours || 0)
    if (!(ttl > 0)) throw new Error('short-term memory is disabled (shortTermTtlHours=0); write long_term instead')
    expiresAt = new Date(Date.now() + ttl * 3_600_000).toISOString()
  }
  if (layer === 'must_remember') {
    if (!pinReason || !String(pinReason).trim()) throw new Error('pin_reason is required for must_remember')
    if (!['user_explicit', 'side_event', 'self'].includes(pinSource)) {
      throw new Error('pin_source must be user_explicit, side_event or self')
    }
    if (pinSource === 'side_event' && !sideEventId) throw new Error('side_event_id is required for side_event pins')
    const index = loadPrivateIndex(scope.libraryId)
    const pinned = Object.values(index.entries).filter((e) => e.layer === 'must_remember' && e.status !== 'archived').length
    if (pinSource === 'side_event') {
      const active = getActiveCue(sessionIdOf(exec))
      if (!active || active.id !== sideEventId) {
        throw new Error('side_event_id does not match an active side-event cue')
      }
    }
    const cap = Number(getSettings().mustRememberCap || 12)
    if (pinned >= cap && pinSource === 'self') {
      throw new Error(`must_remember soft cap reached (${cap}); merge, marginalize, or use user_explicit`)
    }
  }

  const index = loadPrivateIndex(scope.libraryId)
  const previousHabit = track === 'habit' && media.length
    ? Object.entries(index.entries).find(([, item]) => item.track === 'habit' && isMemoryEligible(item)
      && sameFactContext(item.context, memoryContext) && visibleToSession(item, memorySessionId(exec))
      && (item.attachments || []).some(attachment => media.some(candidate => candidate.sha256 === attachment.sha256)))
    : null
  const id = previousHabit?.[0] || newMemoryId('mem')
  const entry = {
    ...(previousHabit?.[1] || {}),
    track,
    attachments: media,
    context: memoryContext,
    layer,
    title: clampText(title || content, 120),
    content: String(content),
    pinReason: layer === 'must_remember' ? String(pinReason) : null,
    pinSource: layer === 'must_remember' ? pinSource : null,
    sideEventId: layer === 'must_remember' ? sideEventId : null,
    // Only short_term carries a deadline; privateUpdate can promote it later.
    expiresAt,
    createdAt: previousHabit?.[1]?.createdAt || stamp(),
    updatedAt: stamp(),
    lastAccessAt: null,
    accessCount: previousHabit?.[1]?.accessCount || 0,
    strength: layer === 'must_remember' ? 1 : 0.8,
    marginalized: false,
    openLoop: !!openLoop,
    disclosure,
    owner,
    visibility,
    source,
    // An explicit 0 is a real answer ("I am sure this is unreliable") and must
    // survive; only a missing / non-numeric value falls back to the default.
    confidence: (() => { const v = Number(confidence); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.8 })(),
    status: 'active',
    tags: Array.isArray(tags) ? tags.slice(0, 20) : [],
    // Retrieval lens + resurface metadata. When the agent does not state a mood,
    // the current session read is stored instead, so a memory written during a
    // hard conversation is tinted by it without the model having to name it.
    moodValence: moodValence === null || moodValence === undefined
      ? (binding?.mood ? Number(binding.mood.valence) || 0 : 0)
      : Math.max(-1, Math.min(1, Number(moodValence) || 0)),
    arousal: arousal === null || arousal === undefined
      ? (binding?.mood ? Number(binding.mood.arousal) || 0.35 : 0.35)
      : Math.max(0, Math.min(1, Number(arousal) || 0)),
    peak: peak === true,
    salientDate: normalizedSalientDate,
  }
  // Flashbulb memory: store vividness and accuracy separately. `confidence` is
  // what the model claims; `accuracy` is what a charged moment is actually worth.
  entry.accuracy = accuracyOf({ peak: entry.peak, arousal: entry.arousal, confidence: entry.confidence })
  // Contradiction check (appendix B-14). A memory that argues with one already in
  // the library is not silently appended: it lands as pending_review with the id it
  // collides with, so the conflict surfaces instead of both copies being read as
  // true. Same mechanism the global curator uses; until now the private side had none.
  const conflict = findConflict(Object.fromEntries(Object.entries(index.entries).filter(([key]) => key !== id)), entry)
  if (conflict) {
    entry.status = 'pending_review'
    entry.conflictingWith = conflict.id
    entry.reviewReason = conflict.reason === 'same_title'
      ? `与已有记忆「${clampText(conflict.entry.title || conflict.id, 60)}」同题但内容不同`
      : `与已有记忆「${clampText(conflict.entry.title || conflict.id, 60)}」说法相反`
  }
  const payload = {
    recall_files: [{
      name: id,
      track: 'memory',
      description: clampText(entry.title, 180),
      content: String(content),
    }],
    resource: [],
    user: {},
  }
  // A held (pending_review) claim stays index-only: committing it to MemU now
  // would make a contested memory retrievable before anyone decided it. Accepting
  // the review later is what commits it (see resolveReview → privateUpdate).
  const result = getMemoryBackend() === 'api' && !conflict
    ? await commit({ payload, db: memoryDbPath(scope.libraryId) })
    : { ok: true, backend: getMemoryBackend(), held: conflict ? true : undefined }
  // Re-read after the await: a curator job or another turn may have written in
  // the meantime, and saving the pre-await snapshot would erase it.
  await retryStoreWrite(() => updatePrivateIndex(scope.libraryId, (fresh) => {
    const currentBinding = peekBinding(exec)
    if (sessionIdOf(exec) && (!currentBinding || currentBinding.libraryId !== scope.libraryId)) throw new Error('memory scope changed during write; retry')
    if (currentBinding) assertScopeEnabled(currentBinding)
    if (previousHabit && JSON.stringify(fresh.entries[id]) !== JSON.stringify(previousHabit[1])) throw new Error('habit changed concurrently; recall and retry')
    const latestConflict = findConflict(Object.fromEntries(Object.entries(fresh.entries).filter(([key]) => key !== id)), entry)
    if (latestConflict && !conflict) {
      entry.status = 'pending_review'
      entry.conflictingWith = latestConflict.id
      entry.reviewReason = 'concurrent conflicting memory; review required'
    }
    if (layer === 'must_remember' && pinSource === 'self') {
      const pinned = Object.values(fresh.entries).filter(e => e.layer === 'must_remember' && isMemoryEligible(e)).length
      if (pinned >= Number(getSettings().mustRememberCap || 12)) throw new Error('must_remember soft cap reached; retry as long_term')
    }
    fresh.entries[id] = entry
  }))
  if (!previousHabit) bumpStats(scope.libraryId, 'written')
  if (layer === 'must_remember' && pinSource === 'side_event') {
    consumeCue(sessionIdOf(exec), sideEventId)
  }
  return { id, entry, result, conflict: entry.conflictingWith || null }
}

// Bulk restore of an exported library. This is a *restore*, not a decision, so it
// writes the index directly instead of going through privateRemember: the pin cap,
// the short-term deadline and the "no duplicate text" check would otherwise turn a
// faithful restore into a pile of downgrades.
export async function importMemories({ libraryId, memories, maxFiles = 2000, now = Date.now() }) {
  const library = getLibrary(libraryId)
  if (!library) throw new Error('library not found')
  const list = Array.isArray(memories) ? memories : []
  if (list.length === 0) throw new Error('nothing to import')
  if (list.length > maxFiles) throw new Error("too many memories in one import (" + list.length + " > " + maxFiles + "); split the file")
  const settings = getSettings()
  const ttlHours = Number(settings.shortTermTtlHours ?? 72)
  const index = loadPrivateIndex(libraryId)
  const fingerprint = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase()
  const seen = new Set()
  for (const entry of Object.values(index.entries || {})) {
    if (!entry) continue
    if (entry.status === 'archived' || entry.status === 'suppressed' || entry.status === 'expired') continue
    seen.add(fingerprint(entry.content))
  }
  // A `session` entry from an older export is imported as shared and counted under
  // `downgraded`: the file should not silently lose a memory, but the report has to say
  // that a reader who was scoped to one conversation now shares the folder.
  const counts = { imported: 0, duplicate: 0, invalid: 0, dead: 0, expired: 0, downgraded: 0 }
  const examples = { duplicate: [], invalid: [], expired: [], downgraded: [] }
  const note = (bucket, text) => {
    counts[bucket] += 1
    if (examples[bucket] && examples[bucket].length < 5) examples[bucket].push(text)
  }
  const isoOr = (value, fallback) => {
    const stamp = Date.parse(String(value || ""))
    return Number.isFinite(stamp) ? new Date(stamp).toISOString() : fallback
  }
  const entries = []
  for (const item of list) {
    if (!item || typeof item !== "object") { note("invalid", "not an object"); continue }
    const content = String(item.content || "").trim()
    if (!content) { note('invalid', String(item.id || item.title || 'untitled') + ': empty content'); continue }
    const title = String(item.title || content.slice(0, 60)).slice(0, 180)
    if (['archived', 'suppressed', 'expired', 'pending_review', 'superseded'].includes(item.status)) { note('dead', title); continue }
    const originalExpiry = item.expiresAt ? Date.parse(String(item.expiresAt)) : NaN
    if (Number.isFinite(originalExpiry) && originalExpiry <= now) { note("expired", title); continue }
    const print = fingerprint(content)
    if (seen.has(print)) { note("duplicate", title); continue }
    seen.add(print)
    let layer = LAYERS.includes(item.layer) ? item.layer : 'long_term'
    let pinReason = typeof item.pinReason === "string" ? item.pinReason.trim() : ""
    let pinSource = ['user_explicit', 'side_event', 'self'].includes(item.pinSource) ? item.pinSource : 'self'
    if (layer === 'must_remember' && (!pinReason || pinSource === 'side_event')) {
      // A pin without a reason (or one that refers to a side event we no longer have)
      // would sit in the anchor as a permanent promise nobody can explain.
      layer = 'long_term'
      pinReason = ""
      pinSource = null
      note("downgraded", title + ": must_remember -> long_term")
    }
    let expiresAt = null
    if (layer === 'short_term') {
      if (ttlHours > 0) {
        const expiry = Number.isFinite(originalExpiry) ? Math.min(originalExpiry, now + ttlHours * 3_600_000) : now + ttlHours * 3_600_000
        expiresAt = new Date(expiry).toISOString()
      } else {
        layer = 'long_term'
        note("downgraded", title + ": short_term -> long_term (short layer disabled)")
      }
    }
    // An export from an older version can still say `session`. That level is gone. Dropping
    // the entry would look exactly like the data loss this upgrade exists to stop, so it
    // lands as `shared` with the same marker a stored entry gets — and the report says so,
    // because the reader goes from "one conversation" to "the whole folder". Anything that
    // must stay narrower is expressed with `context`, not with a level.
    const legacySession = item.visibility === LEGACY_SESSION
    if (legacySession) note('downgraded', title + ': session -> shared (that level was removed; use context to narrow it)')
    const visibility = legacySession || !VISIBILITIES.includes(item.visibility) ? 'shared' : item.visibility
    const createdAt = isoOr(item.createdAt, new Date(now).toISOString())
    const updatedAt = isoOr(item.updatedAt, createdAt)
    entries.push({
      id: newMemoryId(),
      entry: {
        title,
        track: item.track === 'habit' ? 'habit' : 'memory',
        context: normalizeMemoryContext(item.context),
        description: String(item.description || content).slice(0, 180),
        layer,
        createdAt,
        updatedAt,
        expiresAt,
        pinReason: pinReason || null,
        pinSource,
        sideEventId: null,
        tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === "string").slice(0, 20) : [],
        openLoop: item.openLoop === true,
        // Access counters carry meaning only inside the library that produced them.
        accessCount: 0,
        lastAccessAt: null,
        strength: layer === 'must_remember' ? 1 : 0.8,
        marginalized: false,
        disclosure: DISCLOSURES.includes(item.disclosure) ? item.disclosure : "can_tell",
        owner: OWNERS.includes(item.owner) ? item.owner : "me",
        visibility,
        ...(legacySession ? { migratedFromVisibility: LEGACY_SESSION, visibilityMigratedAt: new Date(now).toISOString() } : {}),
        source: typeof item.source === "string" && item.source ? item.source : "imported",
        confidence: Number.isFinite(Number(item.confidence)) ? Math.max(0, Math.min(1, Number(item.confidence))) : 0.8,
        status: "active",
        moodValence: Number.isFinite(Number(item.moodValence)) ? Math.max(-1, Math.min(1, Number(item.moodValence))) : 0,
        arousal: Number.isFinite(Number(item.arousal)) ? Math.max(0, Math.min(1, Number(item.arousal))) : 0.35,
        peak: item.peak === true,
        // An imported entry usually carries an already settled date, but a legacy
        // "10-29" whose body says 明天 was never settled at all. Settling it on the
        // way in keeps the appointment from arriving as a yearly anniversary.
        salientDate: reconcileSalientDate(normalizeSalientDate(item.salientDate), `${title} ${content}`),
        injected: null,
        importedFrom: typeof item.id === "string" ? item.id : null,
        importedAt: new Date(now).toISOString(),
        content,
        links: Array.isArray(item.links) ? item.links.filter(link => ['relation', 'commitment', 'event', 'person', 'conflict'].includes(link?.kind)
          && typeof link.to === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(link.to) && typeof link.note === 'string').slice(0, 100)
          .map(link => ({ to: link.to, kind: link.kind, note: link.note.slice(0, 500), confidence: Number.isFinite(link.confidence) ? Math.max(0, Math.min(1, link.confidence)) : .7, createdAt: isoOr(link.createdAt, updatedAt) })) : [],
        attachments: Array.isArray(item.attachments) ? item.attachments.slice(0, 8).filter(media => /^[a-f0-9]{64}$/.test(media?.sha256)).map(media => {
          try { return attachmentRefs(libraryId, [{ sha256: media.sha256 }])[0] } catch {
            return { kind: media.kind === 'sticker' ? 'sticker' : 'image', sha256: media.sha256, caption: String(media.caption || '[图片]').slice(0, 160), captionBy: 'context', missing: true }
          }
        }) : [],
      },
    })
    counts.imported += 1
  }
  if (entries.length === 0) {
    return { imported: 0, ids: [], counts, examples, engineWarning: null }
  }
  // With the api backend recall goes through MemU, so the restored bodies have to be
  // committed there too or they would only show up in the browser. Best effort: a
  // failed commit must not roll back a restore that already passed validation.
  let engineWarning = null
  if (getMemoryBackend() === "api") {
    try {
      await commit({
        payload: {
          recall_files: entries.map(({ id, entry }) => ({
            name: id,
            track: "memory",
            description: clampText(entry.title, 180),
            content: entry.content,
          })),
          resource: [],
          user: {},
        },
        db: memoryDbPath(libraryId),
      })
    } catch (error) {
      engineWarning = String(error?.message || error)
    }
  }
  const idMap = Object.fromEntries(entries.filter(item => item.entry.importedFrom).map(item => [item.entry.importedFrom, item.id]))
  await retryStoreWrite(() => updatePrivateIndex(libraryId, (fresh) => {
    for (const { id, entry } of entries) {
      // The body stays in the index (that is what recall reads from); a restore that
      // dropped it would leave titles pointing at nothing.
      fresh.entries[id] = { ...entry, links: entry.links.map(link => ({ ...link, to: idMap[link.to] || link.to })), description: entry.description || clampText(entry.content, 180) }
    }
  }))
  bumpStats(libraryId, 'written', entries.length)
  return { imported: entries.length, ids: entries.map((item) => item.id), idMap, counts, examples, engineWarning }
}
export async function privateRecall({ exec, query, topK, relevanceThreshold, purpose = 'explicit' }) {
  // Reads must not materialize a library; only the explicit new-session choice
  // (or a user-initiated write) is allowed to create one.
  const binding = peekBinding(exec)
  if (!binding) throw new Error('no bound session')
  // An opt-out is not a missing binding. Reporting both as "no bound session" sent
  // the reader looking for a broken session when the conversation simply has no
  // library to read.
  if (!binding.libraryId) throw new Error('this conversation has no memory library')
  assertScopeEnabled(binding)
  const settings = getSettings()
  // The caller may hand in its own settings snapshot (injection carries one for the
  // turn); falling back to the stored defaults keeps tool-initiated reads identical.
  const threshold = relevanceThreshold === undefined ? settings.relevanceThreshold : relevanceThreshold
  let index = loadPrivateIndex(binding.libraryId)
  const byId = /^(?:g?mem)[-_][a-z0-9_-]+(?:\.md)?$/i.test(String(query || '').trim())
  const result = getMemoryBackend() === 'api' && !byId
    ? await retrieve({ query, db: memoryDbPath(binding.libraryId) })
    : localRecall(index, query)
  const current = peekBinding(exec)
  if (!current || current.libraryId !== binding.libraryId) throw new Error('memory scope changed during recall; retry')
  assertScopeEnabled(current)
  index = loadPrivateIndex(binding.libraryId)
  const enriched = enrichFiles(result, index)
  const span = createdAtSpan(Object.values(index.entries || {}).map((entry) => ({ entry })))
  const mood = moodDecay(binding.mood)
  const scored = privateWeighted(enriched, Number(topK || settings.privateTopK || 4), {
    // Arousal is used even when valence is near neutral: a tense room with no clear
    // good/bad reading still changes which memories come up.
    moodEnabled: Math.abs(mood.valence) >= MOOD_MIN_STRENGTH || Math.abs(mood.arousal - BASE_AROUSAL) >= 0.1,
    moodValence: mood.valence,
    arousal: mood.arousal,
    firstCreatedAt: span.first,
    lastCreatedAt: span.last,
    relevanceThreshold: threshold,
    // The asking conversation's context is what memories are filtered against; the id is
    // only how that context is looked up.
    sessionId: memorySessionId(exec),
    automatic: purpose === 'automatic',
  })
  // Being recalled is being used, and a memory that keeps being used should not fade
  // like one nobody ever touches. Batched into a single index write.
  if (purpose !== 'automatic') touchAccessMany({ libraryId: binding.libraryId, ids: (scored.files || []).map((f) => f.name) })
  bumpStats(binding.libraryId, 'recalled', (scored.files || []).length)
  for (const file of scored.files || []) {
    if (file.entry?.attachments?.length) {
      file.entry = { ...file.entry, attachments: file.entry.attachments.map(item => {
        try { return { ...item, ...attachmentRefs(binding.libraryId, [{ sha256: item.sha256 }])[0] } } catch { return { ...item, missing: true } }
      }) }
    }
    try { file.related = recallRelations(binding.libraryId, index, file.name, memorySessionId(exec)) } catch { file.related = [] }
  }
  return scored
}

export async function privateList({ exec, libraryId }) {
  const scope = resolveLibrary({ exec, libraryId, readOnly: true })
  if (scope.binding) assertScopeEnabled(scope.binding)
  const index = loadPrivateIndex(scope.libraryId)
  const allowed = (entry) => !!entry && (!sessionIdOf(exec) || (isMemoryEligible(entry) && visibleToSession(entry, memorySessionId(exec))))
  if (getMemoryBackend() === 'agent') {
    return {
      libraryId: scope.libraryId,
      source: 'index',
      files: localIndexFiles(index).filter(file => allowed(file.entry)).map((file) => ({
        name: file.name,
        description: file.description,
        content: file.content,
        entry: file.entry,
      })),
      raw: null,
      parseWarning: null,
    }
  }
  const result = await listFiles({ db: memoryDbPath(scope.libraryId) })
  const files = Array.isArray(result?.recall_files) ? result.recall_files : []
  return {
    libraryId: scope.libraryId,
    source: 'engine',
    files: files.filter(file => allowed(index.entries[file.name])).map((file) => ({
      ...file,
      entry: index.entries[file.name] || null,
      content: String(index.entries[file.name]?.content || ''),
    })),
    raw: result?.raw,
    parseWarning: result?.parseWarning,
  }
}

// Everything a memory *is* stays editable, not only its words: `track`, `peak`, the
// mood lens and the attachment list all change how an entry is scored, aggregated or
// rendered, so a wrong value in any of them was a permanent mis-filing that could
// only be undone by archiving the memory and writing it again.
export async function privateUpdate({ exec, libraryId, id, content, title, tags, status, openLoop, disclosure, confidence, layer, owner, visibility, source, salientDate, track, peak, moodValence, arousal, attachments, context }) {
  // `source` is editable because it is a claim about provenance, and claims get
  // corrected: a memory the model first filed as `inferred` may turn out to be
  // something the user actually said. Enum-checked like the rest — a typo here
  // silently downgrades a quote into an inference.
  checkEnums({ disclosure, owner, visibility, source })
  const scope = resolveLibrary({ exec, libraryId })
  if (scope.binding) assertScopeEnabled(scope.binding)
  const index = loadPrivateIndex(scope.libraryId)
  const id_ = resolveEntryId(index, id)
  const entry = index.entries[id_]
  assertEntryAccess(entry, exec)
  if (layer !== undefined && (!LAYERS.includes(layer) || layer === 'must_remember' && entry.layer !== layer)) throw new Error('invalid layer update; must_remember needs a pin_reason')
  if (status !== undefined && !['active', 'archived', 'fragment', 'suppressed', 'expired', 'pending_review', 'superseded'].includes(status)) throw new Error('invalid memory status')
  if (status === 'active' && ['pending_review', 'superseded'].includes(entry.status)) throw new Error('held or superseded memories require review')
  // Same rule as the write path: a value the caller did supply is either accepted or
  // refused, never quietly dropped. `confidence: 'high'` used to come back as a
  // successful update that changed nothing at all.
  if (track !== undefined && track !== 'memory' && track !== 'habit') throw new Error('track must be memory or habit')
  if (confidence !== undefined && !Number.isFinite(Number(confidence))) throw new Error('confidence must be a number between 0 and 1')
  if (moodValence !== undefined && !Number.isFinite(Number(moodValence))) throw new Error('moodValence must be a number between -1 and 1')
  if (arousal !== undefined && !Number.isFinite(Number(arousal))) throw new Error('arousal must be a number between 0 and 1')
  // Throws for anything the library never received: an attachment list you cannot
  // correct would leave a mis-filed image attached forever.
  const nextAttachments = attachments === undefined ? undefined : attachmentRefs(scope.libraryId, attachments)
  // Archiving through an edit is the same act as the archive button, so it counts
  // the same way. Capture before the update: `entry` is the pre-update snapshot.
  const wasArchived = entry.status === 'archived'
  const nextContent = content === undefined ? undefined : redactSecrets(content)
  if (nextContent !== undefined && entry.status !== 'pending_review') {
    const others = Object.fromEntries(Object.entries(index.entries).filter(([key]) => key !== id_))
    const conflict = findConflict(others, { ...entry, title: title ?? entry.title, content: nextContent })
    if (conflict) throw new Error(`content conflicts with ${conflict.id}; write a new memory for review`)
  }
  if (nextContent !== undefined) {
    const payload = {
      recall_files: [{
        name: id_,
        track: entry.track || 'memory',
        description: clampText(title || entry.title || nextContent, 180),
        content: nextContent,
      }],
      resource: [],
      user: {},
    }
    if (getMemoryBackend() === 'api') {
      await commit({ payload, db: memoryDbPath(scope.libraryId) })
    }
  }
  const updated = await retryStoreWrite(() => updatePrivateIndex(scope.libraryId, (fresh) => {
    const target = fresh.entries[id_]
    if (!target) throw new Error(`unknown memory: ${id_}`)
    if (JSON.stringify(target) !== JSON.stringify(entry)) throw new Error('memory changed concurrently; reload and retry')
    assertEntryAccess(target, exec)
    const currentBinding = peekBinding(exec)
    if (sessionIdOf(exec) && (!currentBinding || currentBinding.libraryId !== scope.libraryId)) throw new Error('memory scope changed during update; retry')
    if (currentBinding) assertScopeEnabled(currentBinding)
    if (title !== undefined) target.title = clampText(title, 120)
    if (nextContent !== undefined) target.content = nextContent
    if (tags !== undefined) target.tags = Array.isArray(tags) ? tags.slice(0, 20) : target.tags
    if (status !== undefined) target.status = status
    if (openLoop !== undefined) target.openLoop = !!openLoop
    if (disclosure !== undefined) target.disclosure = disclosure
    if (source !== undefined) target.source = source
    if (salientDate !== undefined) {
      // undefined leaves it alone, null or '' clears it, a value re-dates it. Re-
      // dating has to be possible: before this, a memory filed as an anniversary
      // whose year was silently dropped could only be repaired by editing JSON.
      if (salientDate === null || (typeof salientDate === 'string' && !salientDate.trim())) {
        delete target.salientDate
      } else {
        const normalized = normalizeSalientDate(salientDate)
        if (!normalized) throw new Error('salient_date must be MM-DD (recurs every year) or YYYY-MM-DD (one specific day)')
        // Re-dating goes through the same settlement as a fresh write. A repair that
        // re-submits "10-29" for a body that says 明天 would otherwise re-create the
        // annual entry it was meant to fix.
        target.salientDate = reconcileSalientDate(normalized, `${target.title || ''} ${target.content || ''}`)
      }
    }
    if (context !== undefined) {
      const nextContext = normalizeMemoryContext(context)
      if (sessionIdOf(exec) && ['channelId', 'characterId', 'worldId', 'branchId'].some(key => (target.context?.[key] || '') !== (nextContext[key] || ''))) throw new Error('only the user can change a stored memory boundary')
      if (sessionIdOf(exec) && !contextVisible({ ...nextContext, knownBy: [] }, peekBinding(exec)?.memoryContext)) throw new Error('memory context is outside this conversation')
      target.context = nextContext
    }
    if (owner !== undefined) target.owner = owner
    if (visibility !== undefined) target.visibility = visibility
    if (confidence !== undefined) target.confidence = Math.max(0, Math.min(1, Number(confidence)))
    if (track !== undefined) target.track = track
    if (peak !== undefined) target.peak = peak === true
    if (moodValence !== undefined) target.moodValence = Math.max(-1, Math.min(1, Number(moodValence)))
    if (arousal !== undefined) target.arousal = Math.max(0, Math.min(1, Number(arousal)))
    if (nextAttachments !== undefined) target.attachments = nextAttachments
    // Vividness and accuracy are derived, not typed in: correcting the peak flag or
    // the arousal reading has to move `accuracy` too, otherwise the repair would only
    // change how the entry is stored and not how much it is trusted when recalled.
    if (peak !== undefined || arousal !== undefined || confidence !== undefined) {
      target.accuracy = accuracyOf({
        peak: target.peak === true,
        arousal: Number(target.arousal) || 0.35,
        confidence: Number(target.confidence),
      })
    }
    if (layer !== undefined) {
      if (!LAYERS.includes(layer)) throw new Error(`unknown layer: ${layer}; use ${LAYERS.join(', ')}`)
      // Permanence is not something an update can grant: it needs a reason and a
      // source, and it counts against the soft cap. That path stays in remember.
      if (layer === 'must_remember') throw new Error('must_remember needs a pin_reason; write it with memu_private_remember')
      if (layer === 'short_term') {
        const ttl = Number(getSettings().shortTermTtlHours || 0)
        if (!(ttl > 0)) throw new Error('short-term memory is disabled (shortTermTtlHours=0)')
        // Asking for short_term again is a re-arm, not a no-op: the tool description
        // already promised "re-arm the deadline", but the whole block used to be
        // skipped when the layer did not change, so the only way to extend a draft
        // was to promote it to long_term first — which also stamped promotedFrom and
        // claimed the entry had proven worth keeping.
        target.expiresAt = new Date(Date.now() + ttl * 3_600_000).toISOString()
      } else if (layer !== target.layer) {
        // Promotion — the decision the idle pass exists to make: this entry outlived
        // the conversation that produced it, so it stops being disposable.
        delete target.expiresAt
        if (target.layer === 'short_term') {
          target.promotedFrom = 'short_term'
          target.promotedAt = stamp()
          target.strength = Math.max(Number(target.strength) || 0, 0.8)
        }
      }
      if (layer !== target.layer) target.layer = layer
    }
    target.updatedAt = stamp()
  }))
  if (status === 'archived' && !wasArchived) bumpStats(scope.libraryId, 'archived')
  return { id: id_, entry: updated.entries[id_] }
}

/** Review activation and invalidation of the previous claim are one index commit. */
export async function resolveMemoryReview({ libraryId = null, id, action, resolution = 'replace', reason = '', content, title }) {
  if (!['accept', 'reject'].includes(action)) throw new Error('action must be accept or reject')
  if (!['replace', 'coexist'].includes(resolution)) throw new Error('resolution must be replace or coexist')
  if (resolution === 'coexist' && String(reason).trim().length < 8) throw new Error('coexist needs a reason describing the distinct conditions (at least 8 characters)')
  if (libraryId && !getLibrary(libraryId)) throw new Error('library not found')
  const index = libraryId ? loadPrivateIndex(libraryId) : loadGlobalIndex()
  const entry = index.entries[id]
  if (!entry || entry.status !== 'pending_review') throw new Error('no such pending review')
  const next = { ...entry }
  if (action === 'accept') {
    if (typeof content === 'string' && content.trim()) next.content = content
    if (typeof title === 'string' && title.trim()) next.title = title
    if (getMemoryBackend() === 'api') {
      await commit({
        payload: { recall_files: [{ name: id, track: next.track || 'memory', description: clampText(next.title, 180), content: next.content }], resource: [], user: {} },
        db: libraryId ? memoryDbPath(libraryId) : globalDbPath(),
      })
    }
  }
  const mutate = fresh => {
    if (JSON.stringify(fresh.entries[id]) !== JSON.stringify(entry)
      || JSON.stringify(fresh.entries[entry.conflictingWith]) !== JSON.stringify(index.entries[entry.conflictingWith])) {
      throw new Error('review changed; reload and retry')
    }
    const at = stamp()
    next.status = action === 'accept' ? 'active' : 'archived'
    next.reviewedAt = at
    next.updatedAt = at
    next.reviewResolution = resolution
    if (reason) next.reviewNote = String(reason).trim().slice(0, 1000)
    if (action === 'accept') {
      const previous = fresh.entries[entry.conflictingWith]
      if (previous && resolution === 'replace') {
        previous.status = 'superseded'
        previous.supersededBy = id
        previous.validTo = at
        next.supersedes = entry.conflictingWith
      }
      next.validFrom = at
      delete next.reviewReason
    }
    fresh.entries[id] = next
  }
  await retryStoreWrite(() => libraryId ? updatePrivateIndex(libraryId, mutate) : updateGlobalIndex(mutate))
  if (libraryId && action === 'reject') bumpStats(libraryId, 'archived')
  return { id, status: next.status, resolution }
}

/**
 * Short-term entries expire instead of being deleted. Deleting would throw away the
 * only copy before the consolidation pass could decide what it was worth; flipping
 * the status keeps the text for the archive view while taking it out of retrieval,
 * the anchor, and the counts in one place.
 */
export function expireShortTerm({ now = Date.now() } = {}) {
  const expired = []
  const libraries = []
  let skipped = 0
  for (const lib of listLibrariesAll()) {
    let index = null
    try { index = loadPrivateIndex(lib.id) } catch { skipped += 1; continue }
    let changed = false
    for (const [id, entry] of Object.entries(index.entries || {})) {
      if (!entry || entry.layer !== 'short_term') continue
      if (entry.status === 'archived' || entry.status === 'suppressed' || entry.status === 'expired') continue
      const at = Date.parse(entry.expiresAt || '') || 0
      // A short_term entry saved before the deadline existed has no expiry to
      // enforce; it is left alone rather than being expired on a guess.
      if (!at || at > now) continue
      entry.status = 'expired'
      entry.expiredAt = stamp()
      entry.updatedAt = stamp()
      changed = true
      expired.push({ libraryId: lib.id, id })
    }
    if (changed) {
      try {
        savePrivateIndex(lib.id, index)
        libraries.push(lib.id)
      } catch {
        skipped += 1
      }
    }
  }
  return { expired, libraries, skipped }
}

export function privateArchive({ exec, libraryId, id }) {
  const scope = resolveLibrary({ exec, libraryId })
  if (scope.binding) assertScopeEnabled(scope.binding)
  const index = loadPrivateIndex(scope.libraryId)
  const id_ = resolveEntryId(index, id)
  const entry = index.entries[id_]
  assertEntryAccess(entry, exec)
  if (!entry) throw new Error(`unknown memory: ${id}`)
  const wasArchived = entry.status === 'archived'
  entry.status = 'archived'
  entry.updatedAt = stamp()
  savePrivateIndex(scope.libraryId, index)
  if (!wasArchived) bumpStats(scope.libraryId, 'archived')
  return { id: id_, entry }
}

/**
 * Permanent deletion, and the only path in this plugin that actually loses text.
 * Everything else (archive, suppress, expire) keeps the body and only changes what
 * the entry is allowed to do, because a memory you cannot re-read is a memory you
 * cannot correct. Deleting is therefore gated: only an entry that is already out of
 * retrieval (archived / suppressed / expired) can go, so a live memory cannot be
 * destroyed by one click on the wrong row.
 *
 * Order matters. The engine row is removed first: if the engine refuses, the index
 * keeps the entry and the user sees an error instead of a half-deleted memory. If
 * the index save fails after the engine row is gone, the worst case is a body that
 * is still in the index and no longer in the engine — visible in the browser, still
 * deletable, never recalled from a ghost row.
 */
export async function privateDelete({ exec, libraryId, id }) {
  const scope = resolveLibrary({ exec, libraryId })
  if (scope.binding) assertScopeEnabled(scope.binding)
  const index = loadPrivateIndex(scope.libraryId)
  const id_ = resolveEntryId(index, id)
  const entry = index.entries[id_]
  assertEntryAccess(entry, exec)
  if (!entry) throw new Error(`unknown memory: ${id}`)
  if (!['archived', 'suppressed', 'expired'].includes(entry.status)) {
    throw new Error('only archived memories can be deleted permanently; archive it first')
  }
  const backend = getMemoryBackend()
  let engine = null
  if (backend === 'api') {
    engine = await forget({ db: memoryDbPath(scope.libraryId), name: id_ })
  }
  await retryStoreWrite(() => updatePrivateIndex(scope.libraryId, (fresh) => {
    if (JSON.stringify(fresh.entries[id_]) !== JSON.stringify(entry)) throw new Error('memory changed during deletion; reload and retry')
    delete fresh.entries[id_]
  }))
  return { id: id_, libraryId: scope.libraryId, deleted: true, backend, engine }
}

/**
 * Taking a memory out of permanent memory is the model's own call. A person does
 * not stamp their own grief before letting something go, so the human gate that
 * used to live in the sidebar is gone; what replaces it is visibility after the
 * fact (`marginalReason` is shown in the sidebar) plus three guardrails: a real
 * reason, a per-conversation quota, and a cooldown.
 */
export function privateUnpin({ exec, id, reason }) {
  const sessionId = sessionIdOf(exec)
  const binding = sessionId ? getSessionBinding(sessionId) : null
  if (!binding) throw new Error('no bound session')
  assertScopeEnabled(binding)

  const text = String(reason || '').trim()
  if (text.replace(/\s/g, '').length < UNPIN_MIN_REASON) {
    throw new Error(`unpin needs a first-person reason of at least ${UNPIN_MIN_REASON} characters: what the blow was and why it can be let go now`)
  }

  const settings = getSettings()
  const budget = Math.max(1, Number(settings.unpinBudgetPerSession ?? 2))
  const cooldownMs = Math.max(0, Number(settings.unpinCooldownMinutes ?? 3)) * 60 * 1000
  const used = Number(binding.unpinCount || 0)
  if (used >= budget) {
    throw new Error(`unpin quota for this conversation is used up (${used}/${budget}); memories stay permanent`)
  }
  const lastAt = Date.parse(binding.lastUnpinAt || '') || 0
  const waitMs = lastAt + cooldownMs - Date.now()
  if (lastAt > 0 && waitMs > 0) {
    throw new Error(`unpin is on cooldown for another ${Math.ceil(waitMs / 1000)}s; do not reach for it in the middle of the same feeling`)
  }

  let resolvedId = id
  const updated = updatePrivateIndex(binding.libraryId, (index) => {
    const entryId = resolveEntryId(index, id)
    resolvedId = entryId
    const entry = index.entries[entryId]
    assertEntryAccess(entry, exec)
    if (entry.layer !== 'must_remember') throw new Error('memory is not in must_remember')
    entry.layer = 'long_term'
    entry.marginalized = true
    entry.marginalReason = text.slice(0, 500)
    entry.originalPinReason = entry.pinReason
    entry.originalPinSource = entry.pinSource
    entry.pinReason = null
    entry.pinSource = null
    entry.sideEventId = null
    entry.strength = Math.max(0.05, (entry.strength || 1) * 0.2)
    entry.recallPenalty = 0.2
    entry.unpinnedBy = 'model'
    entry.unpinnedAt = stamp()
    entry.updatedAt = entry.unpinnedAt
  })

  setSessionBinding(sessionId, {
    unpinCount: used + 1,
    lastUnpinAt: stamp(),
  })
  return { id: resolvedId, entry: updated.entries[resolvedId], remaining: Math.max(0, budget - used - 1) }
}

export function appliesToDomain(entry, binding) {
  const domain = domainOf(binding)
  if (!entry) return domain === 'general'
  const entryDomain = entry.domain || 'unknown'
  if (entryDomain === 'universal' || entryDomain === 'personal') return true
  if (entryDomain === domain) return true
  if (entryDomain.startsWith('project:')) {
    const project = entryDomain.slice('project:'.length)
    const cwd = binding?.scopeKey || ''
    return project && cwd.toLowerCase().includes(project.toLowerCase())
  }
  const applies = Array.isArray(entry.appliesTo) ? entry.appliesTo : []
  if (applies.includes('all') || applies.includes(domain)) return true
  return false
}

export async function globalRecall({ exec, query, topK, relevanceThreshold }) {
  // peek, not ensure: injection has already bound any live session before a tool
  // can run, so a missing binding here means a read from an unbound conversation.
  // That fallback quietly narrows results to the `general` domain, so it is
  // reported instead of being invisible.
  const peeked = peekBinding(exec)
  const binding = peeked || { domain: 'general' }
  // The global switch is enforced here too: a conversation that turned global
  // memory off must not get it back by asking the tool.
  if (peeked) assertScopeEnabled(peeked, { layer: 'global' })
  const settings = getSettings()
  const threshold = relevanceThreshold === undefined ? settings.relevanceThreshold : relevanceThreshold
  let index = loadGlobalIndex()
  const result = getMemoryBackend() === 'api'
    ? await retrieve({ query, db: globalDbPath() })
    : localRecall(index, query, (file) => appliesToDomain(file.entry, binding))
  if (peeked) {
    const current = peekBinding(exec)
    if (!current) throw new Error('memory binding changed during recall; retry')
    assertScopeEnabled(current, { layer: 'global' })
  }
  index = loadGlobalIndex()
  const enriched = enrichFiles(result, index)
  const filtered = enriched.files
    .filter((f) => isMemoryEligible(f.entry, { automatic: true }))
    .filter((f) => appliesToDomain(f.entry, binding))
    .map((f, i) => ({
      ...f,
      // Local lexical rank is already meaningful; confidence still nudges ties, and
      // a cross-session fact that has been injected three turns running gets the same
      // wear penalty as a private one.
      score: (f.lexical > 0 ? f.lexical : 1 / (i + 1))
        * (0.85 + 0.15 * Number(f.entry.confidence ?? 0.5))
        * habituationFactor(f.entry),
    }))
    .sort((a, b) => b.score - a.score)
  return {
    ...enriched,
    files: mmrSelect(cutWeakScores(filtered, threshold), Number(topK || settings.globalTopK || 3)),
    domain: domainOf(binding),
    unbound: !peeked,
  }
}

export async function globalList({ exec, domain }) {
  const binding = peekBinding(exec)
  if (binding) assertScopeEnabled(binding, { layer: 'global' })
  const index = loadGlobalIndex()
  // The domain parameter is a filter, not just a label: the tool schema promises
  // "Optional domain filter", so a caller asking for one domain must not get all.
  const domainFilter = (file) => (!domain || (file.entry?.domain || 'unknown') === domain)
    && (!sessionIdOf(exec) || (isMemoryEligible(file.entry) && appliesToDomain(file.entry, binding || { domain: 'general' })))
  if (getMemoryBackend() === 'agent') {
    const files = localIndexFiles(index)
    return {
      domain: domain || (binding ? domainOf(binding) : 'general'),
      source: 'index',
      files: (domainFilter ? files.filter(domainFilter) : files).map((file) => ({
        name: file.name,
        description: file.description,
        content: file.content,
        entry: file.entry,
      })),
      raw: null,
      parseWarning: null,
    }
  }
  const result = await listFiles({ db: globalDbPath() })
  const files = Array.isArray(result?.recall_files) ? result.recall_files : []
  const enriched = files.map((file) => ({
    ...file,
    entry: index.entries[file.name] || null,
    content: mirrorContent(file),
  }))
  return {
    domain: domain || (binding ? domainOf(binding) : 'general'),
    source: 'engine',
    files: domainFilter ? enriched.filter(domainFilter) : enriched,
    raw: result?.raw,
    parseWarning: result?.parseWarning,
  }
}

// One load, one write. Recalls used to bump counters entry by entry, which rewrote the
// index once per hit; more importantly, nothing ever called the single-id version, so
// `accessCount` never moved and the +50% strength bonus in decayStrength was dead
// weight. This is what makes that bonus real.
export function touchAccessMany({ libraryId, ids = [] }) {
  if (!libraryId || !ids || ids.length === 0) return 0
  const index = loadPrivateIndex(libraryId)
  let touched = 0
  for (const id of ids) {
    const entry = index.entries?.[id]
    if (!entry) continue
    entry.accessCount = (entry.accessCount || 0) + 1
    entry.lastAccessAt = stamp()
    touched += 1
  }
  if (touched > 0) savePrivateIndex(libraryId, index)
  return touched
}

export function touchAccess({ exec, id, scope = 'private' }) {
  const binding = bindingFor(exec)
  if (!binding || !id) return null
  if (scope === 'global') {
    const index = loadGlobalIndex()
    const entry = index.entries[id]
    if (!entry) return null
    entry.updatedAt = entry.updatedAt || stamp()
    saveGlobalIndex(index)
    return entry
  }
  const index = loadPrivateIndex(binding.libraryId)
  const entry = index.entries[id]
  if (!entry) return null
  entry.accessCount = (entry.accessCount || 0) + 1
  entry.lastAccessAt = stamp()
  savePrivateIndex(binding.libraryId, index)
  return entry
}

/**
 * How long ago something happened, in the words a person would use.
 *
 * Two formatters were drifting apart: the injector printed layer/confidence while the
 * tools printed dates, so the same memory read differently in the prompt and in a tool
 * result. One function keeps them honest — and relative time is what actually tells the
 * model whether "已经改过了" is this morning or last spring.
 * @param iso - ISO timestamp (or anything Date.parse understands).
 * @param now - reference instant, injectable for tests.
 * @returns a short human phrase, or '' when the stamp is unusable.
 */
export function relativeTime(iso, now = Date.now()) {
  const at = Date.parse(String(iso || ''))
  if (!Number.isFinite(at)) return ''
  const ms = Math.max(0, now - at)
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return minutes + ' 分钟前'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + ' 小时前'
  const days = Math.floor(hours / 24)
  if (days < 30) return days + ' 天前'
  const months = Math.floor(days / 30)
  if (months < 12) return months + ' 个月前'
  return Math.floor(days / 365) + ' 年前'
}

/** Days since a stamp, or null when unknown. Used for the "this thread is old" nudge. */
export function daysSince(iso, now = Date.now()) {
  const at = Date.parse(String(iso || ''))
  if (!Number.isFinite(at)) return null
  return Math.max(0, Math.floor((now - at) / 86_400_000))
}

/**
 * Record that these memories were injected, which is what makes habituation possible.
 *
 * Kept separate from touchAccessMany on purpose: being retrieved (a tool call, a
 * search) is attention the user asked for and should raise strength, while being
 * *pushed* into the prompt is attention the plugin decided on and should wear off.
 * One batched index write, same as the access touch.
 */
export function noteInjected({ libraryId, ids = [], at = stamp() }) {
  if (!libraryId || !ids.length) return 0
  const index = loadPrivateIndex(libraryId)
  let touched = 0
  for (const id of ids) {
    const entry = index.entries?.[id]
    if (!entry) continue
    entry.injectCount = (Number(entry.injectCount) || 0) + 1
    entry.lastInjectAt = at
    touched += 1
  }
  if (touched > 0) savePrivateIndex(libraryId, index)
  if (touched > 0) bumpStats(libraryId, 'injected', touched)
  return touched
}

/** Same, for the global layer (which lives in its own index file). */
export function noteGlobalInjected({ ids = [], at = stamp() }) {
  if (!ids.length) return 0
  const index = loadGlobalIndex()
  let touched = 0
  for (const id of ids) {
    const entry = index.entries?.[id]
    if (!entry) continue
    entry.injectCount = (Number(entry.injectCount) || 0) + 1
    entry.lastInjectAt = at
    touched += 1
  }
  if (touched > 0) saveGlobalIndex(index)
  return touched
}

/**
 * Unfinished threads old enough to be worth raising.
 *
 * An open loop that was mentioned yesterday is still context; one that has been open
 * for a week is the thing a friend opens with ("那个 review 后来呢?"). Silently
 * retrieving it among four other lines is not the same as resurfacing it, so the
 * injector gets its own small query for this — sorted oldest-first, and never the ones
 * that were already pushed this session.
 */
/**
 * Memories a sensory cue may be derived from.
 *
 * A cue used to be one of eight hard-coded sentences, so the "something surfaces from
 * nowhere" moment was the same eight moments forever, unrelated to what the library
 * actually holds. The echo should come out of a real memory instead.
 *
 * Exclusions are the anti-loop: an entry that was itself written off a cue
 * (`sideEventId` set, or pinned as `side_event`) never sources a new cue, so
 * memory -> cue -> memory cannot feed itself. Fresh entries are skipped too — something
 * written five minutes ago is still in the window, so echoing it is just repetition,
 * not resurfacing. And a memory that may not be spoken (`never_say`, `secret`) never
 * becomes a cue: the cue text is a fragment of its body.
 */
export function cueCandidates({ libraryId, sessionId = null, now = Date.now(), minAgeHours = 12, skipIds = [], limit = 8 }) {
  if (!libraryId) return []
  const index = loadPrivateIndex(libraryId)
  const skip = new Set(skipIds || [])
  const minAgeMs = Math.max(0, Number(minAgeHours) || 0) * 3_600_000
  return Object.entries(index.entries || {})
    .filter(([id, entry]) => {
      if (!entry || skip.has(id)) return false
      if (!isActive(entry)) return false
      if (!visibleToSession(entry, sessionId)) return false
      if (entry.sideEventId || entry.pinSource === 'side_event') return false
      if (entry.disclosure === 'never_say') return false
      if (entry.visibility === 'secret') return false
      if (!String(entry.content || '').trim()) return false
      const at = Date.parse(entry.updatedAt || entry.createdAt || '')
      if (!Number.isFinite(at)) return false
      return now - at >= minAgeMs
    })
    .map(([id, entry]) => ({
      id,
      entry,
      // Least-used first: an echo is most interesting when it is something we had
      // stopped thinking about, not the entry we already paste every turn.
      weight: 1 + Math.min(20, Number(entry.accessCount) || 0) + (Number(entry.injectCount) || 0),
    }))
    .sort((a, b) => a.weight - b.weight || String(b.entry.updatedAt || b.entry.createdAt || '')
      .localeCompare(String(a.entry.updatedAt || a.entry.createdAt || '')))
    .slice(0, Math.max(0, Number(limit) || 0))
}

export function dueOpenLoops({ libraryId, days = 3, limit = 1, now = Date.now(), skipIds = [] }) {
  if (!libraryId) return []
  const index = loadPrivateIndex(libraryId)
  const skip = new Set(skipIds || [])
  return Object.entries(index.entries || {})
    .filter(([id, entry]) => {
      if (!entry || skip.has(id)) return false
      if (!entry.openLoop || entry.marginalized) return false
      if (!isActive(entry)) return false
      const age = daysSince(entry.updatedAt || entry.createdAt, now)
      return age !== null && age >= days
    })
    .sort((a, b) => String(a[1].updatedAt || a[1].createdAt || '').localeCompare(String(b[1].updatedAt || b[1].createdAt || '')))
    .slice(0, Math.max(0, Number(limit) || 0))
    .map(([id, entry]) => ({ id, entry }))
}
