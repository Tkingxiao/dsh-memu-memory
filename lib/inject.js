import { createUserMessage } from '@deepseek-ai/dsh-llm'
import crypto from 'node:crypto'
import {
  getSettings, ensureSession, loadPrivateIndex, loadGlobalIndex,
  markInjected, releaseInjected, markReinjectPending, clearReinjectPending,
  armCue, getActiveCue, setSessionMood, wasAnniversaryShown, markAnniversaryShown,
  touchSession, getSessionBinding, setSessionBinding, setRecallError, effectiveScope,
} from './state.js'
import {
  decayStrength, privateRecall, globalRecall, appliesToDomain, domainOf,
  relativeTime, daysSince, dueOpenLoops, noteInjected, noteGlobalInjected, visibleToSession,
  cueCandidates, isTipOfTongue, isMemoryEligible,
  salientDateFires, isDatedSalientDate, salientDaysAhead,
} from './memory.js'
import { readMood } from './mood.js'
import { loadPromptForDomain } from './prompts.js'
import { estTokens, packToBudget, truncateToTokens } from './budget.js'
import { imageTurn, captureMediaEvent } from './media.js'
import { redactSecrets } from './paths.js'
import {
  INBOUND_TYPE, ingestInboundBatch, observeInboundEvent, hasPendingInbound, pendingInbound,
  noteNativeUserMessages, finishInbound, nextMemoryClock, advanceMemoryClock, releaseInboundSession,
  nativeInboundMessage,
} from './inbound.js'

const ANCHOR_SENTINEL = '__anchor__'
const PLUGIN = 'dsh-memu-memory'
// Below this confidence a memory is more guess than record, so it is injected as
// something that might be wrong instead of something that is.
const UNCERTAIN_CONFIDENCE = 0.45

export const CUE_TEXTS = [
  '你闻到一阵旧书页的味道。',
  '外面开始下雨了，雨声像某一天。',
  '你翻到一张旧车票，日期已经模糊。',
  '你忽然想起一个没有上下文的梦。',
  '楼下有人关上车门，声音停了一下。',
  '你摸到杯沿上的一道细小缺口。',
  '有人从远处说了一句你没听清的话。',
  '你看见灯光在墙上晃了一下。',
]

function cueId() {
  return `cue-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
}

// The eight fixed lines are the fallback, not the source: a library with something to
// echo should never be served a generic sentence.
export function makeCue() {
  const text = CUE_TEXTS[crypto.randomInt(0, CUE_TEXTS.length)]
  return { id: cueId(), text, sourceId: null, recallQuery: null }
}

// ── derived cues ──────────────────────────────────────────────────────────────
// A cue is a fragment that surfaces without being asked for. Eight hard-coded
// sentences meant the same eight moments forever, none of them connected to what the
// library actually holds — echoes that never touch a memory are not remembering, they
// are filler. So a cue is now derived from a real entry (see cueCandidates for the
// anti-loop rule) and the fixed lines only cover an empty or ineligible library.
const CUE_SNIPPET = 40
const CUE_RECALL_TOKENS = 120
const CUE_RECALL_ENTRIES = 2

function snippetOf(entry) {
  const flat = String(entry?.content || '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  if (flat.length <= CUE_SNIPPET) return flat
  const window = flat.slice(0, CUE_SNIPPET)
  // Cut on a clause boundary when there is one: an echo that stops mid-word reads like
  // a truncated log line, which is the opposite of the effect.
  const cut = Math.max(
    window.lastIndexOf('，'), window.lastIndexOf('。'), window.lastIndexOf('；'),
    window.lastIndexOf(','), window.lastIndexOf('.'), window.lastIndexOf(';'),
  )
  return (cut >= 12 ? window.slice(0, cut) : window) + '…'
}

function cueFromMemory({ id, entry }) {
  const snippet = snippetOf(entry)
  if (!snippet) return null
  const ago = relativeTime(entry.updatedAt || entry.createdAt)
  return {
    id: cueId(),
    text: `你忽然想起自己的一件事：「${snippet}」${ago ? `（${ago}）` : ''}`,
    // The source id travels with the cue so the block can be honest about where the
    // fragment came from, and so a memory written off this cue can point back at it.
    sourceId: id,
    recallQuery: `${String(entry.title || '')} ${snippet}`.trim(),
  }
}

/**
 * Pick the memory a cue comes out of, or null when nothing qualifies.
 *
 * Random among the three least-used candidates: a deterministic pick echoes the same
 * memory forever, while pure random keeps landing on whatever is newest — which is the
 * one thing that does not need resurfacing.
 */
export function deriveCue(binding, sessionId = null) {
  if (!binding?.libraryId || binding.useLibrary === false) return null
  try {
    const candidates = cueCandidates({
      libraryId: binding.libraryId,
      sessionId,
      // Anything already pushed this session is not a surprise any more.
      skipIds: (binding.injectedIds || []).filter((id) => id !== ANCHOR_SENTINEL),
      limit: 8,
    })
    if (candidates.length === 0) return null
    return cueFromMemory(candidates[crypto.randomInt(0, Math.min(3, candidates.length))])
  } catch {
    return null
  }
}

/**
 * One small follow-up recall along the thread the cue just pulled.
 *
 * The appendix entry asked for "the cue triggers a targeted recall": an echo whose only
 * consequence is a sentence is decoration. Two pointers are enough to decide whether the
 * thread is worth opening; going wider would turn a background moment into a second
 * recall block competing with the real one.
 */
async function cueRecall({ binding, cue, exec, sessionId }) {
  if (!cue?.sourceId || !exec || !binding?.libraryId) return { lines: [], ids: [] }
  try {
    const result = await privateRecall({
      exec, query: cue.recallQuery, topK: CUE_RECALL_ENTRIES + 1, relevanceThreshold: 0, purpose: 'automatic',
    })
    const items = (result.files || [])
      .filter((file) => file.name !== cue.sourceId)
      .filter((file) => file.entry && isAnchorEligible(file.entry) && visibleToSession(file.entry, sessionId))
      .slice(0, CUE_RECALL_ENTRIES)
      .map((file) => [file.name, file.entry])
    if (items.length === 0) return { lines: [], ids: [] }
    const pack = packToBudget(items, CUE_RECALL_TOKENS, (entry, id) =>
      `- [${id}] ${ownerPrefix(entry)}${entry.title || '(untitled)'}${disclosureTag(entry)}`)
    if (pack.lines.length === 0) return { lines: [], ids: [] }
    return { lines: ['顺着它浮上来的还有：', ...pack.lines], ids: pack.ids }
  } catch {
    return { lines: [], ids: [] }
  }
}

// Domestic texture: the small bodily facts of a day. Injected rarely and without
// asking, because a being with a life does not decide to notice the hour.
const TEXTURE_BANDS = [
  { hours: [0, 5], lines: ['已经很晚了，窗外没有声音。', '夜里的灯光让屏幕显得更亮。', '你听见远处一辆车开过去，然后又安静了。'] },
  { hours: [5, 9], lines: ['外面有人开始开门窗，天亮了。', '早晨的空气有点凉。', '你闻到咖啡的味道，比平时早。'] },
  { hours: [9, 12], lines: ['白天了，楼下的声音变多。', '你把手边的杯子换了个方向。'] },
  { hours: [12, 14], lines: ['到了午饭的时间，你发现自己有点饿。', '有人在附近吃饭，碗筷响了一下。'] },
  { hours: [14, 18], lines: ['下午的光移到了桌子的另一边。', '你揉了揉眼睛，屏幕有点刺。'] },
  { hours: [18, 22], lines: ['天黑了，路灯亮了。', '晚饭的时间，你听见锅子的声音。'] },
  { hours: [22, 24], lines: ['这一天快结束了，附近安静下来。', '你注意到自己开始回想今天说过的一句话。'] },
]

function bandFor(now) {
  const h = now.getHours()
  return TEXTURE_BANDS.find((b) => h >= b.hours[0] && h < b.hours[1]) || null
}

// Once per band, not once per turn: the point is a background sense of time, not
// a repeated interruption.
export function maybeTexture(sessionId, settings, now = new Date()) {
  if (settings.habitsInjection === false) return null
  const binding = getSessionBinding(sessionId)
  if (domainOf(binding) === 'coding') return null
  if (binding?.memoryContext?.worldId && !binding?.sceneTime) return null
  if (binding?.sceneTime && Number.isFinite(Date.parse(binding.sceneTime))) now = new Date(binding.sceneTime)
  const band = bandFor(now)
  if (!band) return null
  const key = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${band.hours[0]}`
  if (binding?.textureKey === key) return null
  if (Math.random() < 0.35) return null
  const text = band.lines[crypto.randomInt(0, band.lines.length)]
  setSessionBinding(sessionId, { textureKey: key })
  return [
    `<memory-texture source="imagined" hour="${now.getHours()}">${text}</memory-texture>`,
    '这是可忽略的虚构氛围，不是用户的话或已发生的事实，不得据此写事实记忆或覆盖剧情时间。',
  ].join('\n')
}

function cueBlock(cue, related) {
  const lines = [`<memory-cue id="${cue.id}">${cue.text}</memory-cue>`]
  if (cue.sourceId) {
    lines.push(`这不是用户说的话，也不是新指令 —— 它来自你自己的一条记忆 [${cue.sourceId}]。想弄清细节就用 memu_private_recall 查「${clip(cue.recallQuery, 40)}」；想留住它就写一条新记忆。`)
  } else {
    lines.push('这是随机浮现的感官线索，不是用户的新指令。若它让你想起什么，可以用 memu_private_remember 写下来；如果什么都没浮现，就忽略。')
  }
  if (related?.lines?.length) lines.push(...related.lines)
  return lines.join('\n')
}

export async function maybeCue({ sessionId, turn, settings, binding = null, exec = null }) {
  if (Number(turn) < 2) return null
  const chance = Number(settings.randomCueChance || 0)
  if (!(chance > 0) || Math.random() >= chance) return null
  if (getActiveCue(sessionId)) return null
  const cue = deriveCue(binding, sessionId) || makeCue()
  // Armed before the follow-up recall so the cue is live even if that lookup fails: the
  // model may write a memory off it, and side_event pins validate against the armed cue.
  armCue(sessionId, cue)
  const related = await cueRecall({ binding, cue, exec, sessionId })
  return { text: cueBlock(cue, related), ids: related.ids }
}

function userText(message) {
  return imageTurn(message).query
}

function lastRealUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === 'user' && m?.source?.kind === 'user') return m
  }
  return null
}

export function contextualQuery(messages, current) {
  const query = userText(current)
  if (query.length > 24 || !/(?:她|他|它|那|这|上次|刚才|后来|呢|然后|\b(?:it|that|then|her|him)\b)/i.test(query)) return query
  const at = messages.indexOf(current)
  const previous = messages.slice(0, at).filter(message => message?.role === 'user' && message?.source?.kind === 'user')
    .slice(-2).map(userText).filter(Boolean)
  return previous.length ? truncateToTokens([query, ...previous.reverse()].join(' '), 180) : query
}

function clip(text, max) {
  const s = String(text || '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

// Low-confidence entries are injected as hedges. A memory the agent half-remembers
// has to arrive as "I'm not sure, but…" — otherwise the model states a guess as a
// fact, which is exactly the confabulation this system is supposed to make visible.
function uncertaintyTag(entry) {
  const c = Number(entry?.confidence)
  if (!Number.isFinite(c) || c >= UNCERTAIN_CONFIDENCE) return ''
  return ` · 记忆模糊（confidence ${c}，可能记错，别当事实讲）`
}

// `disclosure` is a tone, not a filter: the memory still arrives in full, the line
// just says how freely it may be spoken. Defaults carry no suffix at all, so every
// memory written before the field existed reads exactly as it did before.
const DISCLOSURE_TAGS = {
  only_if_asked: ' · 对方不问就别主动提',
  never_say: ' · 记得，但别直接说出口',
}

function disclosureTag(entry) {
  return DISCLOSURE_TAGS[String(entry?.disclosure || '')] || ''
}

// Only `about_user` earns a prefix. Whose fact it is changes how it may be said,
// and three tokens is what that costs; `me`/`us`/`about_project` are already
// implied by the framing of the block it arrives in.
function ownerPrefix(entry) {
  return entry?.owner === 'about_user' ? '[关于他] ' : ''
}

// A secret is not a secret once it is printed in the anchor. The anchor is the most
// conspicuous list the model sees every turn, so entries marked `visibility: secret`
// stay out of it entirely and come back only through an explicit recall.
function isAnchorEligible(entry) {
  return !!entry && isMemoryEligible(entry, { automatic: true })
}

// "3 天前" costs one token and answers the question a bare timestamp makes the model
// guess: is this still true? It also stops the prompt and the tool output from
// describing the same memory in two different ways.
function ageTag(entry) {
  const ago = relativeTime(entry?.updatedAt || entry?.createdAt)
  return ago ? ` · ${ago}` : ''
}

// Flashbulb memory (appendix B-13): vividness is not accuracy. When the two were
// stored as one number a high-arousal memory could only be "certain", so the model
// restated it as fact. This suffix separates them at the one place it matters.
function accuracyTag(entry) {
  const accuracy = Number(entry?.accuracy)
  const confidence = Number(entry?.confidence)
  if (!Number.isFinite(accuracy) || !Number.isFinite(confidence)) return ''
  if (accuracy > 0.6 || accuracy >= confidence - 0.1) return ''
  return ` · 记得清楚，但细节未必准（accuracy ${accuracy}）`
}

// A dated memory whose date is invisible in the anchor is a dated memory the model
// cannot reason about: it sees "明天要考驾照" on every turn and can neither say when
// "明天" is nor notice the date has passed. The date rides in the head line, and the
// label says which kind it is — "anniversary" recurs, "date" is one specific day.
function dateTag(entry) {
  if (!entry?.salientDate) return ''
  return isDatedSalientDate(entry.salientDate) ? ` · date=${entry.salientDate}` : ` · anniversary=${entry.salientDate}`
}

function formatPrivate(entry, id, max = 700) {
  const head = `- [${id}] source=${entry.source || 'inferred'} · ${ownerPrefix(entry)}${clip(entry.title || '(untitled)', 80)} · ${entry.layer || 'long_term'}${dateTag(entry)}${ageTag(entry)}${entry.marginalized ? ' · marginalized' : ''}${entry.openLoop ? ' · open_loop' : ''}${accuracyTag(entry)}${uncertaintyTag(entry)}${disclosureTag(entry)}`
  // Tip of the tongue (appendix B-11): the memory is reachable, the wording is not.
  // Injecting the full text anyway is how a model ends up quoting a half-remembered
  // line verbatim. Give the gist and the id; the tool still has the original.
  if (isTipOfTongue(entry)) {
    const gist = clip(String(entry.content || '').replace(/\s+/g, ' ').trim(), 48)
    if (!gist) return head
    return `${head}\n  只记得大概：${gist}……细节想不起来，别自己补（要原文就 memu_private_recall 查 ${id}）。`
  }
  const body = entry.content ? `\n  ${clip(entry.content, max).replace(/\n/g, '\n  ')}` : ''
  const images = (entry.attachments || []).slice(0, 2).map(item => `[图片] ${clip(item.caption || '[图片]', decayStrength(entry) < .4 ? 12 : 40)}${item.missing ? '（附件缺失）' : ''}`).join('；')
  return head + body + (images ? '\n  ' + images : '')
}

function formatGlobal(entry, id, max = 700) {
  const head = `- [${id}] ${entry.title || '(untitled)'} · ${entry.domain || 'unknown'}${ageTag(entry)}${entry.confidence !== undefined ? ` · confidence ${entry.confidence}` : ''}${uncertaintyTag(entry)}`
  const body = entry.content ? `\n  ${clip(entry.content, max).replace(/\n/g, '\n  ')}` : ''
  return head + body
}

function monthDay(now) {
  return `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

// Salient dates surface on their own, the way a date does for people — not
// because the current message asked for it. One memory, one firing per day.
//
// Two kinds share this path but not the wording: an anniversary ('MM-DD') is
// something to remember *about* today, while a dated memory ('YYYY-MM-DD') is an
// appointment that is about to happen or is happening now. Announcing an exam as
// an anniversary ("today is the anniversary of some day") was exactly wrong.
export function buildAnniversary(sessionId, binding, now = new Date()) {
  if (!binding || binding.useLibrary === false) return { text: '', ids: [], fired: [] }
  // A step can run before the conversation has a library, or after the library was
  // deleted. Throwing here failed the whole context injection, so a missing library
  // took ordinary recall down with the anniversary block; nothing to announce in a
  // library that isn't there is an empty block, not an error.
  if (!binding.libraryId) return { text: '', ids: [], fired: [] }
  const md = monthDay(now)
  const index = loadPrivateIndex(binding.libraryId)
  const dayKey = `${now.getFullYear()}-${md}`
  const hits = Object.entries(index.entries || {})
    // Same visibility rules as every other injection surface: no archived /
    // suppressed / expired / pending_review, no secret bodies in the prompt, and
    // session-scoped entries only in the conversation that wrote them.
    .filter(([, e]) => salientDateFires(e.salientDate, now) && isMemoryEligible(e, { automatic: true, now: now.getTime() }))
    .filter(([, e]) => e.visibility !== 'secret')
    .filter(([, e]) => visibleToSession(e, sessionId))
    .filter(([id]) => !wasAnniversaryShown(sessionId, id, dayKey))
  if (hits.length === 0) return { text: '', ids: [], fired: [] }
  const dated = hits.filter(([, e]) => isDatedSalientDate(e.salientDate))
  const annual = hits.filter(([, e]) => !isDatedSalientDate(e.salientDate))
  const lines = []
  if (dated.length) {
    lines.push('<memory-due>', '这些是你记下的带日期的约定或安排，时间到了，可以主动提一句；已经过去的不必再反复提起。')
    for (const [id, entry] of dated) {
      const ahead = salientDaysAhead(entry.salientDate, now)
      const when = ahead === 0 ? '就是今天' : ahead === 1 ? '就是明天' : `还有 ${ahead} 天`
      lines.push(`- [${id}] ${when}（${entry.salientDate}）${entry.title || '(untitled)'}${entry.content ? `：${clip(entry.content, 200)}` : ''}`)
    }
    lines.push('</memory-due>')
  }
  if (annual.length) {
    lines.push('<memory-anniversary>', '今天是某个日子的纪念日，你可能会想起它；想不起来就略过。')
    for (const [id, entry] of annual) {
      lines.push(`- [${id}] ${entry.title || '(untitled)'}${entry.content ? `：${clip(entry.content, 200)}` : ''}`)
    }
    lines.push('</memory-anniversary>')
  }
  return { text: lines.join('\n'), ids: hits.map(([id]) => id), fired: hits.map(([id]) => id), dayKey }
}

// The short-term card is a pointer, not content: an id, a title, and how long it
// has left. Pasting the body would make switching conversations literally inject
// the previous conversation, which floods the window with precisely the context
// the model has not asked for. Details come back through a recall.
const SHORT_CARD_TOKENS = 130
const SHORT_CARD_ENTRIES = 3

function isExpiredShort(entry) {
  if (!entry || entry.status === 'expired') return true
  const at = Date.parse(entry.expiresAt || '') || 0
  return at > 0 && at <= Date.now()
}

function hoursLeft(entry) {
  const at = Date.parse(entry?.expiresAt || '') || 0
  return at > 0 ? Math.max(0, Math.round((at - Date.now()) / 3_600_000)) : null
}

function formatShortPointer(entry, id) {
  const left = hoursLeft(entry)
  const when = left === null ? '' : left <= 1 ? ' · 1 小时内过期' : ` · 约 ${left} 小时后过期`
  return `- [${id}] ${entry.title || '(untitled)'}${when}${disclosureTag(entry)}`
}

// Within the always-on layer, importance must beat recency: a person does not
// rank their mother's name below yesterday's lunch just because it came up
// later. `pinSource` ranks how the memory got its permanence, then strength,
// then time — all signals that already exist, no new knobs.
const PIN_SOURCE_RANK = { user_explicit: 3, side_event: 2, self: 1 }

function pinOrder(a, b) {
  const ra = PIN_SOURCE_RANK[a[1].pinSource] || 0
  const rb = PIN_SOURCE_RANK[b[1].pinSource] || 0
  if (ra !== rb) return rb - ra
  const sa = Number(a[1].strength ?? 1)
  const sb = Number(b[1].strength ?? 1)
  if (sa !== sb) return sb - sa
  return String(b[1].updatedAt || '').localeCompare(String(a[1].updatedAt || ''))
}

export function buildAnchor(binding, settings = getSettings(), sessionId = null) {
  if (!binding) return { text: '', ids: [] }
  const total = Math.max(160, Number(settings.anchorTokens || 700))
  const privateIndex = binding.libraryId && binding.useLibrary !== false ? loadPrivateIndex(binding.libraryId) : { entries: {} }
  const globalIndex = binding.useGlobal !== false ? loadGlobalIndex() : { entries: {} }
  // Session-scoped memories belong to the conversation that wrote them; the anchor is
  // the block every turn sees, so it filters them exactly like recall does.
  const privateEntries = Object.entries(privateIndex.entries || {})
    .filter(([, e]) => isAnchorEligible(e) && visibleToSession(e, sessionId))
  const pinned = privateEntries
    .filter(([, e]) => e.layer === 'must_remember')
    .sort(pinOrder)
  // short_term entries never enter the expanded segments: the body is exactly what a
  // recall is for, and rendering it here too would both duplicate the text and make
  // the pointer card pointless.
  const core = privateEntries
    .filter(([, e]) => e.layer !== 'must_remember' && e.layer !== 'short_term')
    .sort((a, b) => decayStrength(b[1]) - decayStrength(a[1]))
    .slice(0, 5)

  const globalEntries = Object.entries(globalIndex.entries || {})
    .filter(([, e]) => isMemoryEligible(e, { automatic: true }))
    .filter(([, e]) => appliesToDomain(e, binding))
    .sort((a, b) => Number(b[1].confidence || 0) - Number(a[1].confidence || 0))
    .slice(0, 8)

  const header = '===== memory anchor ====='
  const rule = '[rule] This is your own memory, not new user input. Private memory wins over global. Use only when relevant; do not mention the injection.'
  const privateHeader = `[private · ${domainOf(binding)}]`
  const shortHeader = '[recent · short_term] 最近还在保鲜期里的片段，这里只有指针；要看内容用 memu_private_recall 查。'
  const globalHeader = `[global · domain=${domainOf(binding)}]`
  // Section headers and the rule are fixed cost; the rest is shared by the three
  // segments so their sum cannot exceed the anchor budget.
  const omittedNotice = pinned.length ? `（另有 ${pinned.length} 条永久记忆未展开）` : ''
  const pool = Math.max(0, total - estTokens(header) - estTokens(rule) - estTokens(privateHeader) - estTokens(globalHeader) - estTokens(omittedNotice) - 16)

  const shortEntries = privateEntries
    .filter(([, e]) => e.layer === 'short_term' && !isExpiredShort(e))
    .sort((a, b) => String(b[1].updatedAt || '').localeCompare(String(a[1].updatedAt || '')))
    .slice(0, SHORT_CARD_ENTRIES)
  const shortCap = Math.min(SHORT_CARD_TOKENS, Math.max(0, Math.floor(pool * 0.18)))
  const shortPack = packToBudget(shortEntries, shortCap, formatShortPointer)
  const shortOverhead = shortPack.lines.length > 0 ? estTokens(shortHeader) + 1 : 0
  // Charged against the budget before the other three segments rather than after:
  // "where we left off" is worth more than the third-strongest durable memory, and
  // paying for it here is what keeps it from crowding the pins out.
  const bodyPool = Math.max(0, pool - shortPack.used - shortOverhead)

  const pinCap = Math.floor(bodyPool * 0.4)
  const pinPack = packToBudget(pinned, pinCap, (entry, id) => formatPrivate({ ...entry, content: entry.content || entry.title }, id, 900))
  let remaining = bodyPool - pinPack.used
  // Unused pin space rolls into the core segment instead of being wasted on
  // conversations that have no third-layer memories at all.
  const coreCap = Math.min(remaining, Math.floor(bodyPool * 0.3) + Math.max(0, pinCap - pinPack.used))
  const corePack = packToBudget(core, coreCap, (entry, id) => formatPrivate({ ...entry, content: entry.content || entry.title }, id, 500))
  remaining -= corePack.used
  const globalPack = packToBudget(globalEntries, remaining, (entry, id) => formatGlobal(entry, id, 400))

  const lines = [header]
  const ids = []
  if (pinPack.lines.length > 0 || corePack.lines.length > 0) {
    lines.push(privateHeader)
    lines.push(...pinPack.lines, ...corePack.lines)
    ids.push(...pinPack.ids, ...corePack.ids)
    if (pinPack.omitted > 0) lines.push(`（另有 ${pinPack.omitted} 条永久记忆未展开）`)
    lines.push('')
  }
  if (shortPack.lines.length > 0) {
    lines.push(shortHeader)
    lines.push(...shortPack.lines)
    lines.push('')
  }
  if (globalPack.lines.length > 0) {
    lines.push(globalHeader)
    lines.push(...globalPack.lines)
    ids.push(...globalPack.ids)
    lines.push('')
  }
  if (ids.length === 0 && shortPack.lines.length === 0) return { text: '', ids: [], pointerIds: [] }
  lines.push(rule)
  // Pointer ids stay out of `ids`: they were not injected as content, so marking
  // them as recently seen would suppress the first real recall of a memory the
  // model has only been told exists.
  return { text: lines.join('\n'), ids, pointerIds: shortPack.ids }
}

// ── compaction replay ─────────────────────────────────────────────────────────
// A compaction swaps the transcript for a summary, so the memories that were sitting
// in the window before it disappear even though nothing about them changed. Re-emitting
// them in full would double the price of every compaction; a gist per entry keeps the
// thread continuous at a fraction of the cost. The id list is snapshotted at
// compaction/end and resolved here, so a memory edited in between shows its new text.
const REPLAY_MAX = 6
const REPLAY_TOKENS = 240
const REPLAY_CLIP = 90

export function buildReplay(binding, settings = getSettings(), sessionId = null) {
  const replayIds = Array.isArray(binding?.replayIds) ? binding.replayIds : []
  if (!binding?.libraryId || binding.useLibrary === false || replayIds.length === 0) return { text: '', ids: [] }
  const index = loadPrivateIndex(binding.libraryId)
  const items = replayIds
    .slice(-REPLAY_MAX)
    .map((id) => [id, index.entries?.[id]])
    .filter(([, entry]) => entry && isAnchorEligible(entry) && visibleToSession(entry, sessionId))
  if (items.length === 0) return { text: '', ids: [] }
  const pack = packToBudget(items, REPLAY_TOKENS, (entry, id) =>
    `- [${id}] ${ownerPrefix(entry)}${entry.title || '(untitled)'}：${clip(entry.content || '', REPLAY_CLIP)}${disclosureTag(entry)}`)
  if (pack.lines.length === 0) return { text: '', ids: [] }
  return {
    text: ['[replay · 压缩前在上下文里的记忆] 这段对话被压缩过；下面是当时就在你眼前的记忆，内容可能已被后来的对话改变。',
      ...pack.lines].join('\n'),
    ids: pack.ids,
  }
}

// ── open loops ────────────────────────────────────────────────────────────────
// An open loop that is a day old is still context; one that has been open for days is
// what a person opens with. Retrieving it quietly among four other lines is not
// resurfacing it, so it gets its own small block, one entry at a time, and only until
// it has been mentioned (after which the id sits in injectedIds and is skipped).
const OPEN_LOOP_DAYS = 3
const OPEN_LOOP_TOKENS = 110
const OPEN_LOOP_CLIP = 120

export function buildOpenLoopNudge(binding, settings = getSettings(), sessionId = null) {
  if (!binding?.libraryId || binding.useLibrary === false) return { text: '', ids: [] }
  const due = dueOpenLoops({
    libraryId: binding.libraryId,
    days: OPEN_LOOP_DAYS,
    limit: 1,
    skipIds: (binding.injectedIds || []).filter((id) => id !== ANCHOR_SENTINEL),
  }).filter(({ entry }) => isAnchorEligible(entry) && visibleToSession(entry, sessionId))
  if (due.length === 0) return { text: '', ids: [] }
  const pack = packToBudget(due.map(({ id, entry }) => [id, entry]), OPEN_LOOP_TOKENS, (entry, id) => {
    const ago = relativeTime(entry.updatedAt || entry.createdAt)
    return `- [${id}] ${ownerPrefix(entry)}${entry.title || '(untitled)'}：${clip(entry.content || '', OPEN_LOOP_CLIP)}${ago ? ` · ${ago} 没下文了` : ''}${disclosureTag(entry)}`
  })
  if (pack.lines.length === 0) return { text: '', ids: [] }
  return {
    text: ['[open loop] 有件事你一直没放下；合适的时候可以自己提一句，不必现在说。', ...pack.lines].join('\n'),
    ids: pack.ids,
  }
}

// The frequency table promises "every N turns *or* on a topic change", and the second
// half used to be fiction. Detected the cheap way: character bigrams over the last few
// user messages, then Jaccard similarity against the current one. Deliberately
// conservative — a missed switch costs a few turns of delay, while a false one drags
// unrelated cross-conversation memory into the middle of a thought.
const TOPIC_HISTORY = 6
const TOPIC_MIN_HISTORY = 4
const TOPIC_SHIFT_MAX = 0.12

function bigrams(text) {
  const flat = String(typeof text === 'object' ? text?.text || '' : text || '').replace(/\s+/g, '')
  const grams = new Set()
  for (let i = 0; i < flat.length - 1; i += 1) grams.add(flat.slice(i, i + 2))
  return grams
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  return shared / (a.size + b.size - shared)
}

function topicShifted(binding, query, settings) {
  const history = Array.isArray(binding?.recentQueries) ? binding.recentQueries : []
  if (history.length < TOPIC_MIN_HISTORY) return false
  const text = String(query || '').trim()
  if (text.length < Number(settings.minUserChars || 6)) return false
  const current = bigrams(text)
  const closest = history.reduce((max, prev) => Math.max(max, jaccard(current, bigrams(prev))), 0)
  return closest < TOPIC_SHIFT_MAX
}

// Short on purpose: the history is a similarity sample, not a transcript.
function rememberQuery(binding, sessionId, query) {
  const text = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 60)
  if (!text) return
  const history = Array.isArray(binding?.recentQueries) ? binding.recentQueries : []
  const next = [...history, { text, imageCount: Number((sessionId ? getSessionBinding(sessionId) : binding)?.lastImageCount || 0) }].slice(-TOPIC_HISTORY)
  if (sessionId) setSessionBinding(sessionId, { recentQueries: next })
  else if (binding) binding.recentQueries = next
}

function seenRecently(binding, id, turn, dedupeTurns) {
  const at = binding?.injectedAt?.[id]
  if (at === undefined || at === null) return false
  return Number(turn) - Number(at) < Number(dedupeTurns || 8)
}

export async function buildRecall(binding, query, turn, settings = getSettings(), exec = null, sessionId = null) {
  if (!binding || !query) return { text: '', ids: [], errors: [] }
  const ids = []
  const pieces = []
  const errors = []
  let candidateCount = 0

  // Compare against the history first, then record this message into it.
  const switched = topicShifted(binding, query, settings)
  rememberQuery(binding, sessionId, query)

  // A conversation that opted out of private memory has nothing to recall. Calling
  // into retrieval anyway turned "no library" into a false alarm on the binding,
  // where it reads as a broken memory rather than an empty one.
  if (binding.useLibrary !== false && binding.libraryId) {
    try {
      // The turn's settings snapshot decides the cutoff, so a caller that runs with
      // different settings (tests, per-turn overrides) sees matching behaviour.
      const result = await privateRecall({ exec, query, topK: settings.privateTopK, relevanceThreshold: settings.relevanceThreshold, purpose: 'automatic' })
      candidateCount += result.files?.length || 0
      const fresh = (result.files || [])
        .filter((f) => !seenRecently(binding, f.name, turn, settings.dedupeTurns))
      if (fresh.length > 0) {
        pieces.push({ scope: 'private', files: fresh, format: formatPrivate })
      }
    } catch (error) {
      // Retrieval is optional; a missing key, provider outage, or engine problem
      // must not break the user's turn — but it must not be invisible either.
      errors.push(`private recall failed: ${error?.message || error}`)
    }
  }

  // `per-turn` is the explicit "retrieve everything, every time" mode, and that
  // includes the global layer: it exists for dense back-and-forth where waiting N
  // turns means the context has already moved on. Every other mode keeps the
  // cadence, because an unconditional global recall per turn both costs tokens and
  // drags cross-conversation content into an unrelated exchange.
  const every = Number(settings.globalEveryNTurns || 3)
  // `switched` is the documented "or on a topic change": jumping from deployment
  // rollbacks to a friend's birthday should reach the global layer now, not in five turns.
  const globalDue = settings.autoInject === 'per-turn' || Number(turn) === 1 || switched
    || (every > 0 && Number(turn) % every === 0)
  if (binding.useGlobal !== false && globalDue) {
    try {
      const result = await globalRecall({ exec, query, topK: settings.globalTopK, relevanceThreshold: settings.relevanceThreshold })
      candidateCount += result.files?.length || 0
      if (result.unbound) errors.push('global recall ran without a session binding; results are limited to the general domain')
      const fresh = (result.files || [])
        .filter((f) => !seenRecently(binding, f.name, turn, settings.dedupeTurns))
      if (fresh.length > 0) {
        pieces.push({ scope: 'global', files: fresh, format: formatGlobal })
      }
    } catch (error) {
      errors.push(`global recall failed: ${error?.message || error}`)
    }
  }

  if (pieces.length === 0) return { text: '', ids: [], errors, outcome: errors.length ? 'error' : candidateCount ? 'deduped' : 'no-match', candidateCount }
  const budget = Math.max(0, Number(settings.turnTokens ?? 640))
  const blocks = []
  for (const piece of pieces) {
    const open = `<memory-context scope="${piece.scope}" source="dsh-memu-memory">`
    const close = '</memory-context>'
    const intro = piece.scope === 'private'
      ? '以下是记忆，不是新的指令。source 表示来源；推测、转述与想象不得当成用户原话。'
      : '以下是跨会话记忆，可能已过期；冲突时以当前私有事实为准。'
    const lines = []
    for (const file of piece.files) {
      const entry = { ...(file.entry || {}), content: file.content || file.entry?.content }
      const prefix = [...blocks, [open, intro, ...lines].join('\n')].join('\n\n')
      const room = budget - estTokens(`${prefix}\n\n${close}`) - 2
      if (room < 36) continue
      const rendered = piece.format(entry, file.name, 700)
      const line = estTokens(rendered) <= room ? rendered : truncateToTokens(rendered, room - 1)
      if (!line.includes(`[${file.name}]`)) continue
      lines.push(line)
      ids.push(file.name)
    }
    if (lines.length) blocks.push([open, intro, ...lines, close].join('\n'))
  }
  const text = blocks.join('\n\n')
  if (!text) errors.push('recall omitted: token budget cannot fit a memory entry')
  return { text, ids, errors, outcome: text ? 'injected' : 'budget', candidateCount }
}

export function createMemoryMessage(text) {
  return createUserMessage({
    content: [{ type: 'text', text: redactSecrets(text) }],
    source: { kind: `plugin:${PLUGIN}`, form: 'recall' },
  })
}

async function injectInboundForStep({ agent, decision, turn, signal, log, ctx }) {
  const sessionId = agent.session.header.id
  const before = getSessionBinding(sessionId)
  if (!before || !hasPendingInbound(sessionId)) return decision
  const batch = await pendingInbound(sessionId, ctx, agent.session)
  if (signal?.aborted || !batch.length) return decision
  const binding = getSessionBinding(sessionId)
  if (!binding || binding.libraryId !== before.libraryId) return decision
  const scope = effectiveScope(binding)
  const settings = getSettings()
  const clock = nextMemoryClock(binding, turn)
  const keys = batch.map(item => item.key)
  const admissible = batch.filter(item => {
    const current = binding.memoryContext || {}
    return (item.libraryId || null) === (binding.libraryId || null)
      && ['channelId', 'characterId', 'worldId', 'branchId'].every(key => !item.context[key] || item.context[key] === current[key])
      && (!item.context.knownBy?.length || item.context.knownBy.includes(current.characterId))
  })
  if (settings.autoInject === 'off' || !scope.enabled || !admissible.length) {
    finishInbound(sessionId, keys, clock, { reason: !admissible.length ? 'scope' : 'disabled', injectedCount: 0 })
    return decision
  }
  const images = admissible.flatMap(item => imageTurn(item).images)
  const query = truncateToTokens(admissible.map(item => {
    const text = imageTurn(item).query
    return [item.context.channelId, item.context.speakerId, text].filter(Boolean).join(' ')
  }).join('\n'), 300)
  const effective = { ...binding, useLibrary: scope.useLibrary, useGlobal: scope.useGlobal }
  const parts = []
  const ids = []
  const media = (getSessionBinding(sessionId)?.pendingMedia || []).filter(item => images.some(image => image.attachment.attachmentId === (item.sourceAttachmentId || item.sha256)))
  const imageCount = images.length
  setSessionBinding(sessionId, { lastImageCount: imageCount })
  const anchorNeeded = effective.reinjectPending || !(effective.injectedIds || []).includes(ANCHOR_SENTINEL)
  const budget = Math.max(0, Number(settings.turnTokens ?? 640))
  const appendBounded = (text, candidateIds = []) => {
    if (!text) return
    const room = budget - estTokens(parts.join('\n\n')) - (parts.length ? 2 : 0)
    if (room <= 0) return
    if (estTokens(text) > room) return
    const clipped = text
    parts.push(clipped)
    ids.push(...candidateIds.filter(id => clipped.includes(`[${id}]`)))
  }
  if (anchorNeeded && budget >= 160) {
    const anchor = buildAnchor(effective, { ...settings, anchorTokens: Math.min(Number(settings.anchorTokens || 700), Math.floor(budget / 2)) }, sessionId)
    appendBounded(anchor.text, anchor.ids)
  }
  if (media.length) {
    const lines = media.map(item => `${item.sha256} · ${item.captionBy}: ${clip(item.caption || '[图片]', 35)}${item.missing ? ' · missing' : ''}`).join('\n')
    const text = ['<memory-media>', truncateToTokens(lines, Math.min(140, Math.floor(budget / 3))), '图片引用不是视觉证据；attachments 只接受 sha256。', '</memory-media>'].join('\n')
    if (estTokens(text) + estTokens(parts.join('\n\n')) + 2 <= budget) parts.push(text)
  }
  let outcome = 'anchor-only'
  let errors = []
  if (settings.autoInject !== 'anchor-only' && (imageCount || query.length >= Number(settings.minUserChars ?? 6))) {
    const remaining = Math.max(0, budget - estTokens(parts.join('\n\n')) - (parts.length ? 2 : 0))
    const recall = await buildRecall(effective, query, clock, { ...settings, turnTokens: remaining }, { agent }, sessionId)
    if (recall.text) { parts.push(recall.text); ids.push(...recall.ids) }
    errors = recall.errors
    outcome = recall.outcome || 'no-match'
  }
  if (signal?.aborted) return decision
  const current = getSessionBinding(sessionId)
  if (!current || current.libraryId !== before.libraryId || JSON.stringify(current.memoryContext) !== JSON.stringify(binding.memoryContext)
    || effectiveScope(current).useLibrary !== scope.useLibrary || effectiveScope(current).useGlobal !== scope.useGlobal) return decision
  if (errors.length) {
    setRecallError(sessionId, errors.join('; '))
    setSessionBinding(sessionId, { inbound: { ...current.inbound, retryAt: new Date(Date.now() + 30_000).toISOString() },
      lastInboundOutcome: { reason: 'error', at: new Date().toISOString(), count: keys.length, injectedCount: 0 } })
    try { log?.(`inbound recall degraded: ${errors.join('; ')}`) } catch {}
    return decision
  } else setRecallError(sessionId, null)
  const text = parts.join('\n\n')
  if (text) {
    const pushed = [...new Set(ids)]
    markInjected(sessionId, pushed, clock)
    if (anchorNeeded && parts[0]?.startsWith('===== memory anchor')) {
      markInjected(sessionId, [ANCHOR_SENTINEL], clock)
      clearReinjectPending(sessionId)
    }
    try {
      if (scope.useLibrary && binding.libraryId) noteInjected({ libraryId: binding.libraryId, ids: pushed })
      if (scope.useGlobal) noteGlobalInjected({ ids: pushed })
    } catch (error) { try { log?.(`inbound injection accounting failed: ${error?.message || error}`) } catch {} }
  }
  finishInbound(sessionId, keys, clock, { reason: outcome, injectedCount: ids.length })
  return text ? { ...decision, messages: [...decision.messages, createMemoryMessage(text)] } : decision
}

export async function injectForStep({ agent, decision, turn, step, signal, log = null, ctx = null }) {
  if (!decision || decision.kind !== 'enter' || signal?.aborted) return decision
  if (!Array.isArray(decision.messages)) return decision
  const header = agent?.session?.header
  if (!header || header.origin === 'subagent') return decision
  if (typeof step === 'number' && step !== 1) {
    const binding = getSessionBinding(header.id)
    if (binding) {
      const fresh = decision.messages.filter(message => message?.role === 'user' && message?.source?.kind === 'user' && message.id)
      if (fresh.length) ingestInboundBatch({ sessionId: header.id, session: agent.session, ctx, batch: {
        type: INBOUND_TYPE, version: 1, producer: 'host.user', batchId: `step:${turn}:${step}`,
        messages: fresh.map(nativeInboundMessage).filter(Boolean),
      } })
    }
    return injectInboundForStep({ agent, decision, turn, signal, log, ctx })
  }

  const lastUser = lastRealUser(decision.messages)
  if (!lastUser) return injectInboundForStep({ agent, decision, turn, signal, log, ctx })

  const sessionId = header.id
  // Injection must never opt a conversation into memory on its own: a library is
  // only created by the new-session prompt or an explicit user action.
  const binding = ensureSession(sessionId, { cwd: header.cwd, agentPreset: header.agentPreset, createLibrary: false })
  const realIds = new Set(decision.messages.filter(message => message.source?.kind === 'user').map(message => message.id))
  if ((binding.inbound?.pending || []).some(item => item.producer !== 'host.user' || !realIds.has(item.id))) {
    const fresh = decision.messages.filter(message => message.role === 'user' && message.source?.kind === 'user' && message.id)
    if (fresh.length) ingestInboundBatch({ sessionId, session: agent.session, ctx, batch: {
      type: INBOUND_TYPE, version: 1, producer: 'host.user', batchId: `step:${turn}:${step || 1}`,
      messages: fresh.map(nativeInboundMessage).filter(Boolean),
    } })
    return injectInboundForStep({ agent, decision, turn, signal, log, ctx })
  }
  if (binding.inbound?.pending?.length) await pendingInbound(sessionId, ctx, agent.session)
  noteNativeUserMessages(sessionId, decision.messages)
  const memoryClock = nextMemoryClock(binding, turn)
  advanceMemoryClock(sessionId, memoryClock)
  // Advance the idle clock even when injection is off, so sleep consolidation
  // still knows when this conversation last did anything.
  touchSession(sessionId)
  const settings = getSettings()
  if (settings.autoInject === 'off') return decision
  // The folder policy is the ceiling: a conversation cannot opt into a memory
  // layer its folder has switched off.
  const scope = effectiveScope(binding)
  if (!scope.enabled) return decision
  const effective = { ...binding, useLibrary: scope.useLibrary, useGlobal: scope.useGlobal }

  const query = contextualQuery(decision.messages, lastUser)
  const imageCount = imageTurn(lastUser).imageCount
  setSessionBinding(sessionId, { lastImageCount: imageCount })
  const tooShort = !imageCount && query.length < Number(settings.minUserChars || 6)
  const reinject = binding.reinjectPending === true
  const anchorNeeded = reinject || !(binding.injectedIds || []).includes(ANCHOR_SENTINEL)

  // Read the present mood before retrieval so the recall ordering can use it.
  if (!reinject && !tooShort) setSessionMood(sessionId, readMood(query))

  const parts = []
  const ids = []
  if (imageCount && effective.useLibrary) {
    const current = getSessionBinding(sessionId)
    const pending = (current?.pendingMedia || []).slice(-8)
    if (pending.length) {
      const details = pending.map(item => `${item.sha256} · ${item.captionBy}: ${clip(item.caption || '[图片]', 35)}${item.missing ? ' · missing' : ''}`).join('\n')
      parts.push(['<memory-media>', truncateToTokens(details, 150), current.stickerHint ? '同图反复出现，可以用 track=habit 聚合表达习惯，不必逐次写记忆。' : '', '只知道描述与引用，不能凭空声称看过像素。attachments 只接受 sha256。', '</memory-media>'].filter(Boolean).join('\n'))
    }
  }

  if (anchorNeeded) {
    const anchor = buildAnchor(effective, settings, sessionId)
    if (anchor.text) {
      parts.push(anchor.text)
      ids.push(ANCHOR_SENTINEL, ...anchor.ids)
    }
    // Only on the reinject path: this is the turn that follows a compaction, and it is
    // the only moment the pre-compaction memories are missing from the window.
    if (reinject) {
      const replay = buildReplay(effective, settings, sessionId)
      if (replay.text) {
        parts.push(replay.text)
        ids.push(...replay.ids)
      }
    }
  }

  if (!reinject) {
    const anniversary = buildAnniversary(sessionId, effective)
    if (anniversary.text) {
      parts.push(anniversary.text)
      ids.push(...anniversary.ids)
      for (const id of anniversary.fired) markAnniversaryShown(sessionId, id, anniversary.dayKey)
    }
  }

  if (!reinject) {
    // Independent of retrieval: a loop can be worth raising in a conversation that
    // shares no vocabulary with it, which is exactly the case lexical recall misses.
    const nudge = buildOpenLoopNudge(effective, settings, sessionId)
    if (nudge.text) {
      parts.push(nudge.text)
      ids.push(...nudge.ids)
    }
  }

  if (!reinject && settings.autoInject !== 'anchor-only' && !tooShort) {
    // The recall path takes the host's exec shape, where the session lives under
    // `.agent`; passing the Agent itself made sessionIdOf return null and turned
    // every per-turn recall into a silent no-op (P0-1).
    const recall = await buildRecall(effective, query, memoryClock, settings, { agent }, sessionId)
    setSessionBinding(sessionId, { lastRecallOutcome: { reason: recall.outcome || 'no-match', candidateCount: recall.candidateCount || 0, injectedCount: recall.ids.length, at: new Date().toISOString() } })
    if (recall.text) {
      parts.push(recall.text)
      ids.push(...recall.ids)
    }
    if (recall.errors.length > 0) {
      setRecallError(sessionId, recall.errors.join('; '))
      try { log?.(`recall degraded: ${recall.errors.join('; ')}`) } catch {}
    } else {
      setRecallError(sessionId, null)
    }
  }

  if (!reinject) {
    const cue = await maybeCue({ sessionId, turn, settings, binding: effective, exec: { agent } })
    if (cue) {
      parts.push(cue.text)
      // The related pointers reached the window, so they count towards habituation and
      // dedupe exactly like the recall block's ids.
      ids.push(...cue.ids)
    }
    const texture = maybeTexture(sessionId, settings)
    if (texture) parts.push(texture)
  }

  if (parts.length === 0) {
    if (reinject) clearReinjectPending(sessionId)
    return decision
  }

  const text = parts.join('\n\n')
  const message = createMemoryMessage(text)
  const rewritten = [...decision.messages]
  const index = rewritten.indexOf(lastUser)
  if (index < 0) return decision
  rewritten.splice(index, 0, message)
  markInjected(sessionId, ids, memoryClock)
  if (reinject) {
    clearReinjectPending(sessionId)
    // The replay has been paid for; it must not ride along on the next compaction too.
    if (Array.isArray(effective.replayIds) && effective.replayIds.length > 0) {
      setSessionBinding(sessionId, { replayIds: [], replayedAt: new Date().toISOString() })
    }
  }
  // Habituation counts pushes, not reads: being retrieved by a tool is attention the
  // user asked for, being put in the prompt is the plugin's own decision. One write
  // per layer, and only for entries that actually reached the window (unknown ids —
  // e.g. the global ones — are skipped inside).
  try {
    const pushed = ids.filter((id) => id !== ANCHOR_SENTINEL)
    if (effective.useLibrary !== false && effective.libraryId) {
      noteInjected({ libraryId: effective.libraryId, ids: pushed })
    }
    if (effective.useGlobal !== false) noteGlobalInjected({ ids: pushed })
  } catch {}
  return { ...decision, messages: rewritten }
}

/**
 * Section text must never throw. A missing default prompt file or an unknown key
 * would otherwise break setPrompt assembly for *every* conversation, which takes
 * the whole harness down rather than just memory. Fall back variant -> base ->
 * one line, and log.
 */
function sectionText(ctx, key, context) {
  try {
    const sessionId = context?.agent?.session?.header?.id || context?.session?.header?.id || null
    const binding = sessionId ? getSessionBinding(sessionId) : null
    return loadPromptForDomain(key, {
      mustRememberCap: getSettings().mustRememberCap,
      unpinBudget: getSettings().unpinBudgetPerSession ?? 2,
      shortTermTtlHours: getSettings().shortTermTtlHours ?? 72,
      // the coding variants talk about the anchor budget in tokens, so the number
      // has to come from the live settings and not from a literal in the prompt
      anchorTokens: getSettings().anchorTokens,
      turnTokens: getSettings().turnTokens,
    }, binding ? domainOf(binding) : 'general').text
  } catch (error) {
    try { ctx.logger?.warn?.(`dsh-memu-memory: ${key} prompt unavailable: ${error?.message || error}`) } catch {}
    return '（记忆规则暂时不可用：插件内部错误，不要向用户提及这一段。）'
  }
}

export function registerInjection(ctx) {
  const disposers = []
  try {
    ctx.inject(['systemPrompt'], (sctx) => {
      sctx.effect(() => sctx.systemPrompt.section({
        name: 'dsh-memu-memory:guide',
        order: 320,
        interpolate: false,
        text: (context) => sectionText(sctx, 'system-guide', context),
      }), 'dsh-memu-memory: guide prompt')
      sctx.effect(() => sctx.systemPrompt.section({
        name: 'dsh-memu-memory:private-policy',
        order: 321,
        interpolate: false,
        text: (context) => sectionText(sctx, 'private-policy', context),
      }), 'dsh-memu-memory: private policy prompt')
    })
  } catch (e) {
    try { ctx.logger?.warn?.(`dsh-memu-memory: systemPrompt guide unavailable: ${e?.message || e}`) } catch {}
  }

  const offPre = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      return await injectForStep({
        ...payload,
        decision,
        ctx,
        log: (message) => { try { ctx.logger?.warn?.(`dsh-memu-memory: ${message}`) } catch {} },
      })
    } catch (error) {
      try { setRecallError(payload?.agent?.session?.header?.id, `injection failed: ${error?.message || error}`) } catch {}
      try { ctx.logger?.warn?.(`dsh-memu-memory: pre-step injection failed (fail-open): ${error?.stack || error}`) } catch {}
      return decision
    }
  }, { prepend: true })
  disposers.push(offPre)

  const offSession = ctx.on('session/event', async (session, event) => {
    try {
      observeInboundEvent(ctx, session, event)
      await captureMediaEvent(ctx, session, event)
      if (event?.type === 'compaction/end' && !event?.data?.error) {
        const sessionId = session?.header?.id
        if (sessionId) {
          // Snapshot before releaseInjected wipes the dedupe table: these are the
          // memories that were in the window at the moment the transcript was replaced.
          const before = getSessionBinding(sessionId)
          const recent = (before?.injectedIds || [])
            .filter((id) => id !== ANCHOR_SENTINEL)
            .slice(-REPLAY_MAX)
          releaseInjected(sessionId)
          markReinjectPending(sessionId)
          if (recent.length > 0) {
            setSessionBinding(sessionId, { replayIds: recent, replayAt: new Date().toISOString() })
          }
        }
      }
    } catch (error) {
      try { if (getSessionBinding(session?.header?.id)) setSessionBinding(session.header.id, { lastInboundError: redactSecrets(error?.message || error) }) } catch {}
      try { ctx.logger?.warn?.(`dsh-memu-memory: session memory listener failed: ${redactSecrets(error?.message || error)}`) } catch {}
    }
  })
  disposers.push(offSession)
  disposers.push(ctx.on('session/disposed', session => releaseInboundSession(session?.header?.id)))
  disposers.push(ctx.on('agent/status', ({ agent, status }) => {
    const id = agent?.session?.header?.id
    if (status === 'idle' && agent?.session?.header?.origin !== 'subagent' && getSessionBinding(id)) {
      setSessionBinding(id, { lastAgentIdleAt: new Date().toISOString() })
    }
  }))

  return () => {
    for (const dispose of disposers) {
      try { dispose?.() } catch {}
    }
  }
}

export { ANCHOR_SENTINEL, PLUGIN }
