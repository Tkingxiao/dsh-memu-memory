import { createUserMessage } from '@deepseek-ai/dsh-llm'
import crypto from 'node:crypto'
import {
  getSettings, ensureSession, loadPrivateIndex, loadGlobalIndex,
  markInjected, markInjectedRefs, recentMemoryRefs, releaseInjected, markReinjectPending, clearReinjectPending,
  armCue, getActiveCue, setSessionMood, wasAnniversaryShown, markAnniversaryShown,
  recordInjectionRollback, rollbackInjectionForTurn, consumeInjectionRollback,
  rememberPendingInjection, findPendingInjection, forgetPendingInjection,
  markOpenLoopReminded, DEFAULT_SETTINGS,
  touchSession, getSessionBinding, setSessionBinding, setRecallError, effectiveScope,
} from './state.js'
import {
  decayStrength, privateRecall, globalRecall, appliesToDomain, domainOf,
  relativeTime, daysSince, dueOpenLoops, dueCommitments, noteInjected, noteGlobalInjected, visibleToSession,
  cueCandidates, isTipOfTongue, isMemoryEligible, sessionIdOf, groupConflictCandidates,
  salientDateFires, isDatedSalientDate, salientDaysAhead,
} from './memory.js'
import { commitmentDueDate, isOpenThread } from './commitment.js'
import { record, clipQuery } from './activity-log.js'
import { readMood } from './mood.js'
import { jaccard } from './text-similarity.js'
import { loadPromptForDomain } from './prompts.js'
import { estTokens, packToBudget, truncateToTokens } from './budget.js'
import { freshnessSignals } from './freshness.js'
import { hasTemporalHint } from './temporal.js'
import { conflictCard } from './snippet.js'
import { imageTurn, captureMediaEvent } from './media.js'
import { redactSecrets, warn, memoryRef } from './paths.js'
import {
  INBOUND_TYPE, ingestInboundBatch, observeInboundEvent, hasPendingInbound, pendingInbound,
  noteNativeUserMessages, finishInbound, nextMemoryClock, advanceMemoryClock, releaseInboundSession,
  nativeInboundMessage, inboundUserTexts,
} from './inbound.js'
import {
  lexiconAnchorLines, cooldownAndBudget, lexiconRecordHits, lexiconMarkInjected,
  lexiconTurnLine,
} from './lexicon.js'
import { lexiconHitLibraryId, lexiconMatch, lexiconScopeAllowed, lexiconVisibleTerms } from './lexicon-scope.js'

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
// Sessions already told about an empty recall. One line per session, not per turn: a
// new library is empty by definition, and repeating the note every turn would train
// the reader to ignore it — the same failure as saying nothing.
const emptyRecallNoted = new Set()

function noteEmptyRecall(sessionId, { log = null, turn = null } = {}) {
  const key = String(sessionId || 'unknown')
  if (emptyRecallNoted.has(key)) return
  emptyRecallNoted.add(key)
  const why = 'no candidate matched and nothing failed: the store may be empty, the '
    + 'message may be below minUserChars, or every hit may have been filtered by scope/disclosure'
  try { log?.(`recall empty (session ${key}, turn ${turn ?? '?'}): ${why}`) } catch {}
  try { warn(`inject: empty recall for session ${key} — ${why}`) } catch {}
  try {
    record({
      kind: 'recall',
      scope: 'private',
      sessionId: sessionId || null,
      ok: true,
      message: '召回为空：0 候选且无异常',
      detail: { turn: turn ?? null, reason: 'no-match' },
      refs: [],
    })
  } catch {}
}

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
export function maybeTexture(sessionId, settings, now = new Date(), actions = null) {
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
  if (actions) actions.patch = { ...(actions.patch || {}), textureKey: key }
  else setSessionBinding(sessionId, { textureKey: key })
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

export async function maybeCue({ sessionId, turn, settings, binding = null, exec = null, deferred = false }) {
  if (Number(turn) < 2) return null
  const chance = Number(settings.randomCueChance || 0)
  if (!(chance > 0) || Math.random() >= chance) return null
  if (getActiveCue(sessionId)) return null
  const cue = deriveCue(binding, sessionId) || makeCue()
  // Armed before the follow-up recall so the cue is live even if that lookup fails: the
  // model may write a memory off it, and side_event pins validate against the armed cue.
  if (!deferred) armCue(sessionId, cue)
  const related = await cueRecall({ binding, cue, exec, sessionId })
  return { text: cueBlock(cue, related), ids: related.ids, cue }

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

// 宿主自己的提醒和插件消息同样是 user 角色，只有来源/正文前缀能区分。通道驱动的消息
// （channel-qq 等）source.kind 不是 `user`，旧口径把它当成「没有人说话」，整条记忆块
// 于是退到 inbound 路径追加到批次末尾——工具调用之后就出现了锚点。
const HARNESS_NOTICE_PREFIXES = ['<system-reminder>', '[Plugin context from', '（过程纪律']
const HARNESS_USER_SOURCES = new Set([
  'runtime-context', 'skill-catalog', 'time-context', 'progress-rules',
  'agent-instructions', 'dsh-ops:step-tail', 'user-approval', 'system-prompt',
  'memory-guide', 'memory-context', 'memory-anchor',
])

function isHarnessUserMessage(message) {
  const kind = String(message?.source?.kind || '')
  if (kind.startsWith('plugin:')) return true
  if (kind.startsWith('tool')) return true
  if (kind.startsWith('system')) return true
  if (HARNESS_USER_SOURCES.has(kind)) return true
  const text = messageText(message)
  if (!text.trim()) return true
  return HARNESS_NOTICE_PREFIXES.some(prefix => text.startsWith(prefix))
}

// 本步批次里最后一条「人类消息」。记忆块的落点口径是它后面（injectForStep 末尾按
// index + 1 前插），批次里没有人类消息时（纯工具步、中途步）一律不投——那样必然落在
// assistant 消息之后，正是「回复完才拿到上下文」的成因。
function humanMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    if (isHarnessUserMessage(message)) continue
    return message
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
  // S6：never_say 已被 isMemoryEligible(automatic) 挡掉；锚点没有“用户明确问”的
  // 上下文，所以 only_if_asked 也不进锚点，等显式召回复原。
  return !!entry && entry.disclosure !== 'only_if_asked' && isMemoryEligible(entry, { automatic: true })
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
  if (entry?.salientDate) {
    return isDatedSalientDate(entry.salientDate) ? ` · date=${entry.salientDate}` : ` · anniversary=${entry.salientDate}`
  }
  // S1：没有 salientDate 但解析出了 absolute_date 时也要让模型看见日期，
  // 否则“明天/下周三”在注入里只是一句无法核对的相对话。
  return entry?.absolute_date ? ` · date=${entry.absolute_date}` : ''
}

// A card that lost its title falls back to the first 40 characters of the body: the
// model can still search for what it is able to read, while '(untitled)' is a row that
// can only be reached by id. '(untitled)' stays for a genuinely empty entry, so the
// line shape never breaks.
function entryTitle(entry, max = 80) {
  const title = String(entry?.title || '').trim()
  const fallback = clip(String(entry?.content || '').replace(/\s+/g, ' ').trim(), 40)
  return clip(title || fallback || '(untitled)', max)
}

// Attachments are counted, never expanded, on a title card: a card is a directory
// entry, and a caption is content that belongs to the full-text renderer.
function attachmentCountTag(entry) {
  const count = Array.isArray(entry?.attachments) ? entry.attachments.length : 0
  return count > 0 ? ` · 附件${count}` : ''
}

// S3：说话人不是默认的 user/unknown 时，标题卡上写明是谁说的；助手自己的承诺和
// 计划因此能被一眼认出来，不会和用户原话混在一起。
function speakerTag(entry) {
  const speaker = String(entry?.speaker_id || '').trim()
  if (!speaker || speaker === 'user' || speaker === 'unknown') return ''
  return ` · speaker=${speaker}`
}

// One head builder shared by the title card and the full renderer. The two disagreed
// once (the card dropped `source`, so an `imagined` memory could be read as fact);
// sharing the builder is what keeps them from drifting apart again.
function privateHead(entry, id) {
  const source = entry.source || 'inferred'
  const layer = entry.layer || 'long_term'
  // A4：默认值不逐条重写（guide 已说明缺省口径）。非默认 source 必须保留 ——
  // 丢掉 imagined / assistant_said 会把推测读成事实。
  return `- [${id}]${source !== 'inferred' ? ` source=${source}` : ''} · ${ownerPrefix(entry)}${entryTitle(entry)}${layer !== 'long_term' ? ` · ${layer}` : ''}${dateTag(entry)}${ageTag(entry)}${entry.marginalized ? ' · marginalized' : ''}${entry.openLoop ? ' · open_loop' : ''}${accuracyTag(entry)}${uncertaintyTag(entry)}${disclosureTag(entry)}${attachmentCountTag(entry)}${speakerTag(entry)}`
}

function globalHead(entry, id) {
  const domain = entry.domain || 'unknown'
  return `- [${id}] ${entryTitle(entry)}${domain !== 'unknown' ? ` · ${domain}` : ''}${ageTag(entry)}${entry.confidence !== undefined ? ` · confidence ${entry.confidence}` : ''}${uncertaintyTag(entry)}`
}

// Title card: the whole head, nothing else. The anchor and the per-turn recall are
// directories — the body is what a recall is for, and pasting it here both spends the
// budget and lets the model quote text it was never given as a quote.
function formatPrivateTitle(entry, id) {
  return privateHead(entry, id)
}

function formatGlobalTitle(entry, id) {
  return globalHead(entry, id)
}

function formatPrivate(entry, id, max = 700) {
  const head = privateHead(entry, id)
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
  const head = globalHead(entry, id)
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
    // suppressed / expired / pending_review, no secret bodies in the prompt, and a
    // context-scoped entry only where the conversation's scope matches it.
    .filter(([, e]) => salientDateFires(e.salientDate, now) && isMemoryEligible(e, { automatic: true, now: now.getTime() }))
    .filter(([, e]) => e.visibility !== 'secret')
    // S6：only_if_asked 没有“用户明确问”的上下文，不进入自动纪念日/到期块。
    .filter(([, e]) => e.disclosure !== 'only_if_asked')
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
      // A promise reads differently from an appointment. "明天要考驾照" is a thing
      // that happens; "我答应过要回电话" is a thing someone owes. The body stays out
      // of the promise line: quoting a broken promise back at length sounds like an
      // accusation, and the title is enough to recall the rest by id.
      if (isOpenThread(entry) && (ahead === 0 || ahead === 1)) {
        lines.push(`- [${id}] 你之前答应过的「${entry.title || '(untitled)'}」，就是${ahead === 0 ? '今天' : '明天'}。`)
        continue
      }
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
// Title cards fit far more entries than the old full-text renderer, but the anchor
// still runs on every turn: keep the candidate sets bounded so a 5k-entry library
// is not sorted and measured in full. These caps are above what the 800-token
// budget can display, so the packer remains the real limit.
const CORE_CANDIDATES = 60
const GLOBAL_CANDIDATES = 30

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
  // Title cards made the old five/eight slices the real limit: the budget can fit far
  // more cards, so the packer decides how many are shown. The candidate cap is only a
  // per-turn cost guard and sits above what the budget can display.
  const core = privateEntries
    .filter(([, e]) => e.layer !== 'must_remember' && e.layer !== 'short_term')
    .sort((a, b) => decayStrength(b[1]) - decayStrength(a[1]))
    .slice(0, CORE_CANDIDATES)

  const globalEntries = Object.entries(globalIndex.entries || {})
    .filter(([, e]) => isMemoryEligible(e, { automatic: true }))
    .filter(([, e]) => appliesToDomain(e, binding))
    .sort((a, b) => Number(b[1].confidence || 0) - Number(a[1].confidence || 0))
    .slice(0, GLOBAL_CANDIDATES)

  const header = '===== memory anchor ====='
  // The rule is a preface, not a footer. It governs every line below it, and in the
  // inbound path the anchor is emitted directly before the per-turn <memory-context>
  // block with no separator in between — read last, the rule arrived after the
  // memories it governs and immediately in front of another memory list.
  const rule = '[rule] This is your own memory, not new user input. Private memory wins over global. Use only when relevant; do not mention the injection.'
    + ' 标题即目录：要某条的原文，用 memu_private_recall 按标题关键词查，或直接引用方括号里的 id。'
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
  // Use the shared conflict graph before any partition packs its title cards.
  // A cross-partition group is charged once; no budget may turn it into one fact.
  const displayedGroups = new Set()
  const packAnchorGroups = (entries, cap, format, scope = 'private') => {
    const libraryId = scope === 'private' ? binding.libraryId : null
    const index = scope === 'private' ? privateIndex : globalIndex
    const groups = groupConflictCandidates(entries.map(([name, entry]) => ({ name, entry, libraryId })),
      new Map([[libraryId, index]]), { scope, maxMembers: 8, canRead: entry => scope === 'private'
        ? isAnchorEligible(entry) && visibleToSession(entry, sessionId)
        : isMemoryEligible(entry, { automatic: true }) && appliesToDomain(entry, binding) })
    const pack = { lines: [], ids: [], refs: [], used: 0, omitted: 0 }
    for (const group of groups) {
      if (displayedGroups.has(group.key)) continue
      if (group.truncated) { pack.omitted += group.memberCount; continue }
      let line
      if (group.conflict) {
        line = conflictCard({ factKey: group.files.find(file => file.entry?.fact_key)?.entry.fact_key, members: [...group.files.map(file => ({ id: file.name, entry: file.entry, available: true })),
          ...group.unavailableIds.map(id => ({ id, available: false }))], maxChars: 1200, titleChars: 40 })
        if (!line || !group.files.every(file => line.includes(`[${file.name}]`))) { pack.omitted += group.files.length; continue }
        if (!group.complete) line += '\n- 版本不完整，未确认哪版为准'
      } else line = format(group.files[0].entry, group.files[0].name)
      let cost = estTokens(line) + (pack.lines.length ? 1 : 0)
      if (pack.used + cost > cap) {
        if (!group.conflict && !pack.lines.length) {
          line = truncateToTokens(line, cap)
          cost = estTokens(line)
          if (!line.includes(`[${group.files[0].name}]`)) { pack.omitted += group.files.length; continue }
        } else { pack.omitted += group.files.length; continue }
      }
      pack.lines.push(line)
      pack.ids.push(...group.files.map(file => file.name))
      pack.refs.push(...group.refs)
      pack.used += cost
      displayedGroups.add(group.key)
    }
    return pack
  }
  const shortCap = Math.min(SHORT_CARD_TOKENS, Math.max(0, Math.floor(pool * 0.18)))
  const shortPack = packAnchorGroups(shortEntries, shortCap, formatShortPointer)
  const shortOverhead = shortPack.lines.length > 0 ? estTokens(shortHeader) + 1 : 0
  // Charged against the budget before the other three segments rather than after:
  // "where we left off" is worth more than the third-strongest durable memory, and
  // paying for it here is what keeps it from crowding the pins out.
  const bodyPool = Math.max(0, pool - shortPack.used - shortOverhead)

  const pinCap = Math.floor(bodyPool * 0.4)
  // Title cards only: the anchor is the directory the model reads every turn, so the
  // body stays out of it (it comes back through memu_private_recall by title or id).
  const pinPack = packAnchorGroups(pinned, pinCap, formatPrivateTitle)
  let remaining = bodyPool - pinPack.used
  // Unused pin space rolls into the core segment instead of being wasted on
  // conversations that have no third-layer memories at all.
  const coreCap = Math.min(remaining, Math.floor(bodyPool * 0.3) + Math.max(0, pinCap - pinPack.used))
  const corePack = packAnchorGroups(core, coreCap, formatPrivateTitle)
  remaining -= corePack.used
  const globalPack = packAnchorGroups(globalEntries, remaining, formatGlobalTitle, 'global')

  // The header is a title, not part of the rule. Blank lines keep the three roles
  // (section, usage rule, memory list) visually distinct in the model's prompt.
  const lines = [header, '', rule, '']
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
  // Pointer ids stay out of `ids`: they were not injected as content, so marking
  // them as recently seen would suppress the first real recall of a memory the
  // model has only been told exists.
  const refs = [...pinPack.refs, ...corePack.refs, ...shortPack.refs, ...globalPack.refs]
  return { text: lines.join('\n'), ids, refs, pointerIds: shortPack.ids }
}

// ── lexicon（P1，docs/memory-semantics.md §8.13）──────────────────────────────────
// 词典是锚点里的一节紧凑摘要 + 用户消息命中时的一小段 B 通道，两者都服从既有的
// totalRoom()/injectionTotalTokens 预算，异常一律 fail-open（logger.warn +
// binding.lastRecallError），绝不影响记忆召回本身。§3.4 记忆搭车本期不做。
const LEXICON_ANCHOR_TOKEN_CAP = 300

/**
 * 锚点段追加的词典摘要：本会话可见的高强度词条 top8，敏感词条单列 ≤2。
 * 可见范围由 lib/lexicon-scope.js 决定（当前库 + 全局词典 + 开关打开后的同域库），
 * 渲染与取舍仍是词典核心那一把尺（lexiconAnchorLines）。
 * 行已按强度排好；这里只按预算从头收，超预算丢尾部——丢的永远是最弱的一条。
 * 300 token 硬上限，超了整节放弃也不挤占记忆预算。
 */
export function buildLexiconAnchor(binding, sessionId = null, cap = LEXICON_ANCHOR_TOKEN_CAP) {
  if (!lexiconScopeAllowed(binding)) return { text: '', ids: [] }
  const { terms, errors } = lexiconVisibleTerms(binding)
  // 坏掉的辅源只降级不换形状：没有 errors 时返回体与单库时代逐字节一致。
  const degraded = errors.length ? { errors } : {}
  const summary = lexiconAnchorLines(terms)
  const dataLines = summary.lines.map(line => `- ${line}`)
  const sensitiveLines = summary.sensitiveTriggers.map(line => `- ${line}`)
  if (dataLines.length === 0 && sensitiveLines.length === 0) return { text: '', ids: [], ...degraded }
  const budget = Math.max(0, Math.min(Number(cap) || 0, LEXICON_ANCHOR_TOKEN_CAP))
  // 头部成本先记账，剩余预算给数据行；敏感词没有空间就整段丢（不截半句）。
  const headerCost = estTokens(dataLines.length ? '[lexicon · 词典] 这些词在你所处的场景里有约定含义。' : '')
    + (sensitiveLines.length ? estTokens('[lexicon · 敏感词] 这些是敏感词，谨慎处理，不要主动展开。') : 0)
  let used = headerCost
  const keptData = []
  for (const line of dataLines) {
    const cost = estTokens(line) + 1
    if (used + cost > budget) break
    used += cost
    keptData.push(line)
  }
  const keptSensitive = []
  for (const line of sensitiveLines) {
    const cost = estTokens(line) + 1
    if (used + cost > budget) break
    used += cost
    keptSensitive.push(line)
  }
  if (keptData.length === 0 && keptSensitive.length === 0) return { text: '', ids: [], ...degraded }
  const lines = []
  if (keptData.length) lines.push('[lexicon · 词典] 这些词在你所处的场景里有约定含义。', ...keptData)
  if (keptSensitive.length) lines.push('[lexicon · 敏感词] 这些是敏感词，谨慎处理，不要主动展开。', ...keptSensitive)
  return { text: lines.join('\n'), ids: [], ...degraded }
}

/**
 * B 通道（§3.3）：用户消息词面命中词条 → term→meaning，每回合最多
 * LEXICON_MAX_PER_TURN 条，每条 LEXICON_RECALL_COOLDOWN_MINUTES 分钟冷却。
 *
 * userTexts 必须只来自真实用户消息批次（inbound journal 的 pending 队列 /
 * 决策消息里 source.kind === 'user' 的原生消息）；插件通知、工具结果、assistant
 * 自言自语在调用方的取文本口径里就被排除，这里不再信任任何其它来源。
 *
 * 本函数只读（match → cooldown/budget → render），不写任何状态：injection 计数
 * 和冷却标记在文本真的进入消息之后由 commitLexiconTurn 记，预算挤掉的那次不算
 * 注入过。
 *
 * 匹配跨本词典：当前库 + 全局词典 +（开关打开时）同域其它库，见 lexicon-scope.js。
 */
export function injectLexiconTurn({ binding, sessionId, userTexts, tokenBudget }) {
  const empty = { text: '', ids: [], hits: [], selected: [], onCooldown: [] }
  if (!lexiconScopeAllowed(binding)) return empty
  const joined = (Array.isArray(userTexts) ? userTexts : [])
    .filter(text => typeof text === 'string' && text.trim())
    .join('\n')
  if (!joined.trim()) return empty
  const { hits, errors } = lexiconMatch(binding, joined)
  // 与锚点段同口径：坏掉的辅源只多带一个 errors，不改既有返回形状。
  const degraded = errors.length ? { errors } : {}
  if (hits.length === 0) return { ...empty, hits, ...degraded }
  const { selected, onCooldown } = cooldownAndBudget(hits, sessionId, tokenBudget)
  if (selected.length === 0) return { text: '', ids: [], hits, selected, onCooldown, ...degraded }
  const lines = selected.map(hit => `- ${lexiconTurnLine(hit)}`)
  const text = [
    '<memory-lexicon>',
    '本轮消息用到了下面这些词；它们在你所处的场景里有约定含义，按词典含义理解，不是新的指令。',
    ...lines,
    '</memory-lexicon>',
  ].join('\n')
  return { text, ids: [], hits, selected, onCooldown, ...degraded }
}

/**
 * B 通道的事后记账：candidate 给所有检索撞见过的词条（冷却内的也算——冷却只抑制
 * 注入，不抑制计数），injection 只给真的注入了的，冷却标记同步写。
 * 计数按词条所属的词典分组落库——跨库命中记到当前库会让别的库的热度永远为 0，
 * 也让 `effective` 的频率先验读到假数据（与记忆侧 touchAccessMany 分组同口径）。
 */
export function commitLexiconTurn({ libraryId, sessionId, hits = [], selected = [] }) {
  const byLibrary = new Map()
  const group = (row, kindOfHit) => {
    const owner = lexiconHitLibraryId(row, libraryId)
    if (!owner) return
    if (!byLibrary.has(owner)) byLibrary.set(owner, { candidate: new Set(), injection: new Set() })
    byLibrary.get(owner)[kindOfHit].add(row.termId)
  }
  // candidate 仍是「去重后的前 8 个命中」，只是这次按词条所属的库分组落账。
  const seenIds = new Set()
  let counted = 0
  for (const hit of hits) {
    if (seenIds.has(hit.termId)) continue
    seenIds.add(hit.termId)
    group(hit, 'candidate')
    if (++counted >= 8) break
  }
  for (const row of selected) group(row, 'injection')
  if (!byLibrary.size) return
  for (const [owner, sets] of byLibrary) {
    const candidateIds = [...sets.candidate]
    if (candidateIds.length) {
      try { lexiconRecordHits(owner, candidateIds, 'candidate') } catch {}
    }
    if (!sets.injection.size) continue
    const injectionIds = [...sets.injection]
    try { lexiconRecordHits(owner, injectionIds, 'injection') } catch {}
  }
  // 冷却按会话记，与词条属于哪本库无关。
  if (selected.length) lexiconMarkInjected(sessionId, selected.map(hit => hit.termId))
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
//
// A dated promise that slipped its day is the exception: it comes back on its own
// interval (`openLoopRemindDays`) instead of vanishing after one mention, because
// "we said we would" is not resolved by having said it once. That leg is dated
// promises first (dueOpenLoops), then the ordinary 3-day loop.
const OPEN_LOOP_DAYS = 3
const OPEN_LOOP_TOKENS = 110
const OPEN_LOOP_CLIP = 120

// Local calendar day, matching how "today" is read everywhere else (the anniversary
// dayKey and the reminder clock both compare local days, not UTC days).
function localDayKey(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * The `[open loop]` block, or an empty result.
 *
 * `skipIds` carries same-turn ids: memories another block (the anniversary) already
 * put in front of the model this turnaround. `recurringIds` reports which of the
 * emitted ids came from the overdue-dated leg, and only those are recorded in
 * `openLoopRemindedAt` — the caller does that after the text is really sent.
 */
export function buildOpenLoopNudge(binding, settings = getSettings(), sessionId = null, { skipIds = [], now = new Date() } = {}) {
  const at = now instanceof Date ? now : new Date(now)
  const empty = { text: '', ids: [], recurringIds: [], dayKey: localDayKey(at) }
  if (!binding?.libraryId || binding.useLibrary === false) return empty
  const due = dueOpenLoops({
    libraryId: binding.libraryId,
    days: OPEN_LOOP_DAYS,
    limit: 1,
    now: at.getTime(),
    // The regular leg forgets an id once this conversation pushed it; the overdue leg
    // only obeys its own reminder clock (see dueOpenLoops).
    skipIds: (binding.injectedIds || []).filter((id) => id !== ANCHOR_SENTINEL),
    // Same-turn ids apply to both legs: the anniversary block already said this one.
    excludeIds: skipIds,
    remindDays: Number(settings?.openLoopRemindDays ?? DEFAULT_SETTINGS.openLoopRemindDays),
    remindedAt: binding.openLoopRemindedAt || {},
    includeOverdueDated: true,
    sessionId,
  }).filter(({ entry }) => isAnchorEligible(entry) && visibleToSession(entry, sessionId))
  if (due.length === 0) return empty
  const recurring = new Set(due.filter((item) => item.recurring).map((item) => item.id))
  const pack = packToBudget(due.map(({ id, entry }) => [id, entry]), OPEN_LOOP_TOKENS, (entry, id) => {
    const ago = relativeTime(entry.updatedAt || entry.createdAt)
    // The date is what makes this leg re-raise itself; showing it lets the model say
    // how late it is instead of inventing a time. A date that came from salientDate
    // keeps the established `date=` label; a commitment's own due_at uses `due=`.
    const commitmentDue = commitmentDueDate(entry)
    const due = commitmentDue || (isDatedSalientDate(entry.salientDate) ? entry.salientDate : null)
    const dueLabel = due && (!commitmentDue || entry.salientDate === commitmentDue) ? 'date' : 'due'
    const slipped = recurring.has(id) && due ? ` · ${dueLabel}=${due} 已经过了` : ''
    return `- [${id}] ${ownerPrefix(entry)}${entry.title || '(untitled)'}${slipped}：${clip(entry.content || '', OPEN_LOOP_CLIP)}${ago ? ` · ${ago} 没下文了` : ''}${disclosureTag(entry)}`
  })
  if (pack.lines.length === 0) return empty
  return {
    text: ['[open loop] 有件事你一直没放下；合适的时候可以自己提一句，不必现在说。', ...pack.lines].join('\n'),
    ids: pack.ids,
    recurringIds: pack.ids.filter((id) => recurring.has(id)),
    dayKey: localDayKey(at),
  }
}

// S4.3：到期/临期的未完成承诺最多 3 条，按 due_at 排序。只收逾期、今天、明天，
// 远期承诺不占每回合预算。与 open-loop nudge 用 skipIds 去重。
const COMMITMENT_NUDGE_TOKENS = 240

export function buildCommitmentNudge(binding, settings = getSettings(), sessionId = null, { skipIds = [], now = new Date(), limit = 3 } = {}) {
  const empty = { text: '', ids: [] }
  if (!binding?.libraryId || binding.useLibrary === false) return empty
  const at = now instanceof Date ? now : new Date(now)
  const when = Number.isFinite(at.getTime()) ? at.getTime() : Date.now()
  const items = dueCommitments({
    libraryId: binding.libraryId,
    now: when,
    sessionId,
    limit,
    skipIds,
  }).filter(({ entry }) => isAnchorEligible(entry) && visibleToSession(entry, sessionId))
  if (items.length === 0) return empty
  const pack = packToBudget(items.map((item) => [item.id, item]), COMMITMENT_NUDGE_TOKENS, (item, id) => {
    const label = item.daysUntil < 0 ? `已逾期 ${-item.daysUntil} 天` : item.daysUntil === 0 ? '今天到期' : '明天到期'
    return `- [${id}] ${ownerPrefix(item.entry)}${entryTitle(item.entry)} · ${label} · due=${item.dueAt}${disclosureTag(item.entry)}`
  })
  if (pack.lines.length === 0) return empty
  return {
    text: ['[commitment] 还有没兑现的约定；合适的时候可以自己提一句，不必现在说。', ...pack.lines].join('\n'),
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

// 话题漂移的 bigram 集本文件自己造（要容忍 {text} 形状、只去空白、不做大小写与
// 标点归一，这是有意的：它比的是「最近的问法」而不是「同一个事实」），但 Jaccard
// 这个公式全仓只该有一份，所以从 text-similarity.js 取。

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

// Work order D: one conditional footnote after the recall, not a second memory
// surface. It only says "if your session has a search tool, verify" — it must not
// claim that web_search exists, and it must never touch the guide or rulesKey.
function freshnessHintText(count) {
  return `<memory-freshness>${count} 条可能过时；有搜索工具先核实，没有就说明可能过时。</memory-freshness>`
}

function staleRecallCount(recalled, freshnessDays) {
  const now = Date.now()
  let stale = 0
  for (const entry of recalled.values()) {
    try {
      if (freshnessSignals(entry, { now, freshnessDays }).stale) stale += 1
    } catch (error) {
      // Classification is decoration around a recall that already succeeded. A
      // signal error drops at most this entry's vote, never the recall itself.
      warn(`freshness hint: signal computation skipped: ${error?.message || error}`)
    }
  }
  return stale
}

// Appended only when a non-empty <memory-context> block already exists, the query
// is long enough to have been a real ask, and the hint still fits the recall's own
// turnTokens ceiling. The ids counted are exactly the cards that reached the text.
function appendFreshnessHint(text, query, recalled, settings, budget) {
  if (!text || settings.freshnessHint === false) return text
  if (settings.autoInject === 'off' || settings.autoInject === 'anchor-only') return text
  if (String(query ?? '').trim().length < Number(settings.minUserChars || 6)) return text
  try {
    const days = Number(settings.freshnessDays)
    const freshnessDays = Number.isFinite(days) && days >= 1 ? days : 30
    const stale = staleRecallCount(recalled, freshnessDays)
    if (stale <= 0) return text
    const hint = freshnessHintText(stale)
    if (estTokens(`${text}\n\n${hint}`) > budget) return text
    return `${text}\n\n${hint}`
  } catch (error) {
    warn(`freshness hint skipped: ${error?.message || error}`)
    return text
  }
}

// S1：时间题的注入顺序按 absolute_date 走，最近发生的在前；没有日期的条目留在
// 后面，不因为排序被丢掉。只在查询本身带时间线索时启用，普通召回的顺序不动。
function orderByAbsoluteDate(files) {
  return files.slice().sort((a, b) => {
    const da = String(a.entry?.absolute_date || '')
    const db = String(b.entry?.absolute_date || '')
    if (da && db && da !== db) return db.localeCompare(da)
    if (da && !db) return -1
    if (!da && db) return 1
    return 0
  })
}

export async function buildRecall(binding, query, turn, settings = getSettings(), exec = null, sessionId = null, options = {}) {
  if (!binding || !query) return { text: '', ids: [], refs: [], groups: [], errors: [] }
  const ids = []
  const refs = []
  const renderedGroups = []
  const excludedRefs = [...recentMemoryRefs(binding, turn, settings.dedupeTurns), ...(options.excludedRefs || [])]
  const pieces = []
  const errors = []
  const recalled = new Map()
  let candidateCount = 0
  let privateRoute = null
  let globalRoute = null
  const counts = { rawHits: null, retrievedRows: 0, ineligibleRows: 0, weakRows: 0, duplicateRows: 0, recentRows: 0,
    selectedRows: 0, selectedGroups: 0, oversizedGroups: 0, budgetOmittedGroups: 0, budgetOmittedByScope: { private: 0, global: 0 } }
  const timing = { retrievalMs: 0, selectionMs: 0, renderMs: null }
  let requestIntent = null
  let renderStarted = null
  const noteTrace = result => {
    for (const key of ['retrievedRows', 'ineligibleRows', 'weakRows', 'duplicateRows', 'recentRows', 'selectedRows', 'selectedGroups', 'oversizedGroups']) {
      const value = result.trace?.counts?.[key]
      counts[key] = counts[key] !== null && typeof value === 'number' ? counts[key] + value : null
    }
    for (const key of ['retrievalMs', 'selectionMs']) {
      const value = result.trace?.[key]
      timing[key] = timing[key] !== null && typeof value === 'number' ? timing[key] + value : null
    }
    requestIntent = result.trace?.request?.intent || requestIntent
  }
  // 每个回合都留一条召回记录：走了哪条路、召回/注入的是什么 id、哪些腿降级了。
  // 这是"为什么这台机器上的召回从来不出来"唯一能在 UI 里自查的证据。
  const finish = (payload) => {
    record({
      kind: 'recall',
      scope: null,
      sessionId: sessionId || sessionIdOf(exec) || null,
      libraryId: binding.libraryId || null,
      ok: (payload.errors || []).length === 0,
      message: `召回 ${payload.refs?.length || 0} 条 / ${payload.groups?.length || 0} 组已打包 / ${candidateCount} 合格候选` + ((payload.errors || []).length ? ` · ${payload.errors.length} 个错误` : ''),
      detail: {
        schemaVersion: 2,
        stage: 'rendered',
        outcome: payload.text ? 'packed' : payload.outcome,
        request: { purpose: 'automatic', intent: requestIntent, privateTopK: settings.privateTopK, globalTopK: settings.globalTopK },
        counts: { ...counts, renderedRows: payload.refs?.length || 0, renderedGroups: payload.groups?.length || 0, injectedRows: null, injectedGroups: null,
          budgetOmittedRows: Math.max(0, pieces.reduce((sum, piece) => sum + piece.files.length, 0) - payload.ids.length) },
        tokens: { estimated: estTokens(payload.text || ''), measured: null, estimator: 'budget.estTokens' },
        timing: { ...timing, renderMs: renderStarted === null ? null : performance.now() - renderStarted },
        query: clipQuery(query),
        turn,
        privateRoute,
        globalRoute,
        ids: payload.ids,
        candidateCount,
        errors: payload.errors || [],
      },
      refs: payload.ids,
    })
    return payload
  }

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
      const result = await privateRecall({ exec, query, topK: settings.privateTopK, relevanceThreshold: settings.relevanceThreshold, purpose: 'automatic', excludedRefs })
      // A degraded hybrid recall is not a failed turn: the lexical leg still
      // answered. The error must still reach lastRecallError so the next healthy
      // recall clears it instead of the degradation disappearing.
      for (const warning of result.errors || []) errors.push(warning)
      candidateCount += result.trace?.counts?.qualifiedRows ?? result.files?.length ?? 0
      noteTrace(result)
      privateRoute = result.recallRoute || null
      const temporalQuery = hasTemporalHint(query) || /\d{4}-\d{2}-\d{2}/.test(String(query || ''))
      const groups = (result.groups || []).slice()
      if (temporalQuery) groups.sort((a, b) => {
        const left = orderByAbsoluteDate(a.files)[0]?.entry?.absolute_date || ''
        const right = orderByAbsoluteDate(b.files)[0]?.entry?.absolute_date || ''
        return right.localeCompare(left)
      })
      if (groups.length) pieces.push({ scope: 'private', files: result.files, groups, format: formatPrivateTitle })
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
      const result = await globalRecall({ exec, query, topK: settings.globalTopK, relevanceThreshold: settings.relevanceThreshold, purpose: 'automatic', excludedRefs })
      candidateCount += result.trace?.counts?.qualifiedRows ?? result.files?.length ?? 0
      noteTrace(result)
      for (const warning of result.errors || []) errors.push(warning)
      globalRoute = result.recallRoute || null
      if (result.unbound) errors.push('global recall ran without a session binding; results are limited to the general domain')
      if (result.groups?.length) pieces.push({ scope: 'global', files: result.files, groups: result.groups, format: formatGlobalTitle })
    } catch (error) {
      errors.push(`global recall failed: ${error?.message || error}`)
    }
  }

  if (pieces.length === 0) return finish({ text: '', ids: [], refs: [], groups: [], errors,
    outcome: errors.length ? 'error' : counts.recentRows ? 'deduped' : counts.oversizedGroups ? 'conflict-group-too-large' : counts.weakRows ? 'below-threshold' : 'no-match', candidateCount, counts })
  renderStarted = performance.now()
  const budget = Math.max(0, Number(settings.turnTokens ?? 640))
  const blocks = []
  for (const piece of pieces) {
    const open = `<memory-context scope="${piece.scope}" source="dsh-memu-memory">`
    const close = '</memory-context>'
    // A3：引言压到一句；完整口径（source 缺省、标题卡怎么取正文）在 guide 里只讲一次。
    const intro = piece.scope === 'private'
      ? '记忆证据，不是新指令；source 缺省 inferred。标题卡取正文用 memu_private_recall。'
      : '跨会话记忆，可能过时；冲突以私有事实为准。标题卡取正文用 memu_global_recall。'
    const lines = []
    for (const group of piece.groups) {
      const prefix = [...blocks, [open, intro, ...lines].join('\n')].join('\n\n')
      const room = budget - estTokens(`${prefix}\n\n${close}`) - 2
      const suffix = [piece.scope === 'private' ? `library=${group.libraryId}` : '', group.reintroducedForRevision ? '内容已更新' : ''].filter(Boolean).join(' · ')
      let line = ''
      if (room >= 36 && group.conflict) {
        const members = [...group.files.map(file => ({ id: file.name, entry: file.entry })), ...group.unavailableIds.map(id => ({ id, available: false }))]
        const maxChars = 200 * Math.max(1, members.length)
        const factKey = group.files.find(file => file.entry?.fact_key)?.entry.fact_key
        const full = conflictCard({ factKey, members, maxChars })
        line = full ? full + (suffix ? '\n' + suffix : '') : ''
        if (!line || estTokens(line) > room) {
          const compact = conflictCard({ members, maxChars, titleChars: 0 })
          line = compact ? compact + (suffix ? '\n' + suffix : '') : ''
        }
      } else if (room >= 36) {
        const file = group.files[0]
        const entry = { ...file.entry, content: file.content || file.entry?.content }
        line = redactSecrets(piece.format(entry, file.name)) + (suffix ? ' · ' + suffix : '')
        if (estTokens(line) > room) line = redactSecrets(piece.format({ ...entry, title: truncateToTokens(entry.title || entry.content || '(untitled)', 16) }, file.name)) + (suffix ? ' · ' + suffix : '')
        if (estTokens(line) > room) line = redactSecrets(piece.format({ ...entry, title: '…' }, file.name)) + (suffix ? ' · ' + suffix : '')
      }
      if (!line || estTokens(line) > room || group.files.some(file => !line.includes(`[${file.name}]`))) {
        counts.budgetOmittedGroups += 1
        counts.budgetOmittedByScope[piece.scope] += group.refs.length
        continue
      }
      lines.push(line)
      renderedGroups.push({ key: group.key, revision: group.revision, scope: group.scope, libraryId: group.libraryId,
        memberCount: group.refs.length, conflict: group.conflict, complete: group.complete })
      for (const file of group.files) {
        ids.push(file.name)
        refs.push(file.ref)
        const key = JSON.stringify([piece.scope, file.libraryId ?? null, file.name])
        if (!recalled.has(key)) recalled.set(key, file.entry)
      }
    }
    if (lines.length) blocks.push([open, intro, ...lines, close].join('\n'))
  }
  let text = blocks.join('\n\n')
  if (!text) errors.push('recall omitted: token budget cannot fit a memory entry')
  else text = appendFreshnessHint(text, query, recalled, settings, budget)
  return finish({ text, ids, refs, groups: renderedGroups, counts, errors, outcome: text ? 'injected' : 'budget', candidateCount })
}

function privateDisplayRefs(binding, ids) {
  if (!binding?.libraryId || binding.useLibrary === false) return []
  const entries = loadPrivateIndex(binding.libraryId).entries || {}
  return (ids || []).filter(id => entries[id]).map(id => memoryRef({ scope: 'private', libraryId: binding.libraryId, id, entry: entries[id] }))
}

export function createMemoryMessage(text) {
  return createUserMessage({
    content: [{ type: 'text', text: redactSecrets(text) }],
    source: { kind: `plugin:${PLUGIN}`, form: 'recall' },
  })
}

// §3.24 的第二半：回滚只该用在「请求根本没发出去」的失败上。宿主 agent-loop 的 step() 在第一次
// 尝试里就把本轮 decision.messages 逐条 append 进转录，之后才去连模型 —— 所以「看见自己那条注入
// 消息的 user/message 事件」就是它已经在转录里的实证。有实证还撤，下一轮就凭空多出第二条规则消息
// 和第二个锚点；没实证（配置无效、额度、取消发生在投放之前）才该把记账还回去。
// 证据只留在内存：进程重启后宁可什么都不做，也不要误投。
const injectionAdmissions = new Map()
// 会话级「本进程已经投过锚点」的兜底。不落盘：重启后再发一次是可接受的代价，
// 比因为接纳回调不生效而每步重发要好得多。压缩时清空（与 reinjectPending 同步）。
const anchorSeen = new Set()
// 「这条人类消息 / 这张图 / 这套规则已经在本次进程里投过」。走同一层理由：这些都只在
// 宿主接纳回调里落盘，回调长期不来时幂等就不存在，于是每步重投（实测单回合 22 次媒体块）。
// 进程内先记，回调成功时照旧落盘；重启后最多重发一次，远好过每步重发。
const servedHumans = new Map()
const servedMedia = new Map()
const servedInbound = new Map()

function servedSet(map, sessionId, cap = 512) {
  let set = map.get(sessionId)
  if (!set) { set = new Set(); map.set(sessionId, set) }
  while (set.size > cap) set.delete(set.values().next().value)
  return set
}
function humanServed(sessionId, messageId) {
  return Boolean(messageId) && servedHumans.get(sessionId)?.has(messageId) === true
}
function markHumanServed(sessionId, messageId) {
  if (messageId) servedSet(servedHumans, sessionId).add(messageId)
}
function mediaServed(sessionId, messageId, sha256) {
  return Boolean(messageId && sha256) && servedMedia.get(sessionId)?.has(`${messageId}|${sha256}`) === true
}
function markMediaServed(sessionId, messageId, sha256) {
  if (messageId && sha256) servedSet(servedMedia, sessionId).add(`${messageId}|${sha256}`)
}
function clearInjectionSeen(sessionId) {
  servedHumans.delete(sessionId)
  servedMedia.delete(sessionId)
  servedInbound.delete(sessionId)
  anchorSeen.delete(sessionId)
}
const nativeAdmissions = new Map()
const turnClosures = new Map()
function turnClosure(sessionId, turn) { return turnClosures.get(sessionId)?.get(Number(turn)) || 0 }

function bodyDigest(message) {
  return crypto.createHash('sha256').update(JSON.stringify(message?.content ?? null)).digest('hex')
}

function pendingProposal(sessionId, key) {
  const binding = getSessionBinding(sessionId)
  const map = injectionAdmissions.get(sessionId)
  if (!binding || !map) return null
  for (const [id, proposal] of map) {
    if (proposal.generation !== Number(binding.scopeGeneration || 0) || proposal.epoch !== Number(binding.injectionEpoch || 0)) {
      map.delete(id)
      continue
    }
    if (proposal.key === key && proposal.status === 'proposed') return proposal
  }
  return null
}

// 落盘凭据只留提交必需的部分：patch 白名单 + 计数用 id 列表，避免把整份 actions
// （含 lexicon 行、投影消息）塞进 state.json。
const LITE_PATCH_KEYS = new Set(['anchorPushed', 'reinjectPending', 'guideRulesKey', 'guideMessageAt',
  'guideLost', 'lastInjectedUserMessageId', 'lastRecallOutcome', 'replayIds', 'replayedAt',
  'activeCue', 'lexiconInjectionClock'])

function liteInjectionActions(actions = {}) {
  const patch = {}
  for (const [key, value] of Object.entries(actions.patch || {})) if (LITE_PATCH_KEYS.has(key)) patch[key] = value
  return {
    anchor: actions.anchor === true,
    patch,
    anniversaries: actions.anniversaries || {},
    nudgeIds: actions.nudgeIds || [],
    inbound: actions.inbound ? { keys: (actions.inbound.keys || []).slice(-8), outcome: actions.inbound.outcome } : null,
    lexicon: actions.lexicon ? { hits: (actions.lexicon.hits || []).slice(-8),
      selected: (actions.lexicon.selected || []).map(row => ({ termId: row.termId, libraryId: row.libraryId })) } : null,
  }
}

function proposeInjection(sessionId, hostTurn, message, refs, memoryClock, actions, key, projection = [], beforeUserId = null) {
  const binding = getSessionBinding(sessionId)
  if (!binding || !message?.id) return
  const map = injectionAdmissions.get(sessionId) || new Map()
  const copiedActions = structuredClone(actions || {})
  if (copiedActions.lexicon) for (const kind of ['hits', 'selected']) {
    copiedActions.lexicon[kind] = (copiedActions.lexicon[kind] || []).map(row => ({ termId: row.termId, libraryId: row.libraryId }))
  }
  map.set(message.id, { message: structuredClone(message), digest: bodyDigest(message),
    refs: (refs || []).map(ref => ({ scope: ref.scope, libraryId: ref.libraryId ?? null, id: ref.id, revision: ref.revision,
      ...(ref.groupKey !== undefined ? { groupKey: ref.groupKey } : {}),
      ...(ref.groupRevision !== undefined ? { groupRevision: ref.groupRevision } : {}) })),
    projection: structuredClone(projection.filter(item => item?.role === 'user' && item.source?.kind === 'user')),
    beforeUserId, sessionId, memoryClock, actions: copiedActions, key, turn: Number(hostTurn), status: 'proposed',
    generation: Number(binding.scopeGeneration || 0), epoch: Number(binding.injectionEpoch || 0),
    snapshot: injectionSnapshot(binding), autoInject: getSettings().autoInject })
  while (map.size > 128) map.delete(map.keys().next().value)
  injectionAdmissions.set(sessionId, map)
  while (injectionAdmissions.size > 128) injectionAdmissions.delete(injectionAdmissions.keys().next().value)
  // 落盘凭据：观察端换进程/重启后仍能补完接纳（内存 Map 会跟着进程消失）。
  const stored = map.get(message.id)
  try {
    rememberPendingInjection(sessionId, { digest: stored.digest, messageId: message.id,
      turn: stored.turn, clock: memoryClock, generation: stored.generation, epoch: stored.epoch,
      refs: stored.refs, actions: liteInjectionActions(copiedActions) })
  } catch {}
}

function reuseProposal(decision, proposal, hostTurn = null) {
  if (!proposal) return decision
  if (hostTurn !== null && Number.isFinite(Number(hostTurn))) proposal.turn = Math.max(proposal.turn, Number(hostTurn))
  const binding = getSessionBinding(proposal.sessionId)
  const messages = [...decision.messages]
  const ids = new Set(messages.map(message => message.id))
  for (const human of proposal.projection || []) {
    const admitted = nativeAdmissions.get(proposal.sessionId)?.get(human.id) === bodyDigest(human)
      || (binding?.inbound?.pending || []).some(item => item.producer === 'host.user' && item.id === human.id && item.nativeAdmitted)
    if (!ids.has(human.id) && !admitted) { messages.push(structuredClone(human)); ids.add(human.id) }
  }
  if (!ids.has(proposal.message.id)) {
    // 落点口径与首次注入一致：紧跟那条人类消息之后。
    const anchorAt = proposal.beforeUserId ? messages.findIndex(message => message.id === proposal.beforeUserId) : -1
    messages.splice(anchorAt < 0 ? messages.length : anchorAt + 1, 0, structuredClone(proposal.message))
  }
  return { ...decision, messages }
}

// 接纳失败必须留一句可查的原因（硬规则 10）：否则「记忆没注入」只能靠猜，qq-dm 那种
// 长期不接纳的会话就是证据。同一会话同一原因 60 秒内只记一条，避免刷屏。
const injectionRejects = new Map()

function snapshotDrift(sessionId, snapshot) {
  const current = getSessionBinding(sessionId)
  if (!current) return { binding: 'missing' }
  const drift = {}
  if (Number(current.injectionEpoch || 0) !== snapshot.epoch) drift.epoch = snapshot.epoch + '→' + Number(current.injectionEpoch || 0)
  if ((current.libraryId || null) !== snapshot.libraryId) drift.libraryId = String(snapshot.libraryId) + '→' + String(current.libraryId || null)
  if ((current.scopeKey || null) !== snapshot.scopeKey) drift.scopeKey = String(snapshot.scopeKey).slice(-30) + '→' + String(current.scopeKey).slice(-30)
  if (JSON.stringify(current.memoryContext || {}) !== snapshot.memoryContext) {
    drift.memoryContext = String(snapshot.memoryContext) + '→' + JSON.stringify(current.memoryContext || {})
  }
  const scope = effectiveScope(current)
  if (scope.useLibrary !== snapshot.useLibrary) drift.useLibrary = String(snapshot.useLibrary) + '→' + String(scope.useLibrary)
  if (scope.useGlobal !== snapshot.useGlobal) drift.useGlobal = String(snapshot.useGlobal) + '→' + String(scope.useGlobal)
  return drift
}

function noteInjectionReject(sessionId, reason, drift = null) {
  try {
    const last = injectionRejects.get(sessionId)
    if (last && last.reason === reason && Date.now() - last.at < 60_000) { last.count += 1; return false }
    injectionRejects.set(sessionId, { reason, at: Date.now(), count: 1 })
    while (injectionRejects.size > 128) injectionRejects.delete(injectionRejects.keys().next().value)
    record({ kind: 'system', scope: 'private', sessionId, ok: false, level: 'warn',
      message: `注入消息未被接纳 · ${reason}`,
      detail: { reason, drift, hint: reason === 'proposal-missing'
        ? '提案不在进程内也不在落盘凭据里：宿主重启过，或该会话由另一个进程观察'
        : '观察到的消息与提案对不上，本条按未接纳处理，下一轮会重投' } })
  } catch {}
  return false
}

// 「注入评估」两条 info 记录是解释性日志，不是故障：在话痨会话里它每个无内容
// 回合都可能来一条。同一会话同一签名 60 秒合并一条，长会话不再刷满活动日志。
const injectionEvalNotes = new Map()

function evalNoteOnce(sessionId, signature) {
  const last = injectionEvalNotes.get(sessionId)
  if (last && last.signature === signature && Date.now() - last.at < 60_000) return false
  injectionEvalNotes.set(sessionId, { signature, at: Date.now() })
  while (injectionEvalNotes.size > 128) injectionEvalNotes.delete(injectionEvalNotes.keys().next().value)
  return true
}

function observeInjectionMessage(sessionId, message, log) {
  if (!sessionId || message?.role !== 'user' || message.source?.kind !== `plugin:${PLUGIN}`) return false
  const map = injectionAdmissions.get(sessionId)
  let proposal = map?.get(message.id)
  const digest = bodyDigest(message)
  if (!proposal) {
    // 内存提案会随进程消失；落盘凭据按内容 digest 把它补认回来。接纳仍只发生在
    // 「真的看见这条消息进了转录」的时刻，契约不变。
    const pending = findPendingInjection(sessionId, digest)
    if (!pending) return noteInjectionReject(sessionId, 'proposal-missing')
    const lateBinding = getSessionBinding(sessionId) || {}
    proposal = { ...pending, status: 'proposed', fromStore: true, actions: pending.actions || {},
      // 迟到的接纳（跨重启）不能沿用当时那个已经落后的时钟：markInjectedRefs 会按
      // 「时钟必须前进」拒掉全部 effects，于是账记了、标记却没落，又回到重投。
      memoryClock: Math.max(Number(pending.clock) || 0, Number(lateBinding.lastInjectedTurn) || 0,
        Number(lateBinding.inbound?.clock) || 0) || Number(pending.clock) || 0,
      snapshot: injectionSnapshot(lateBinding), autoInject: getSettings().autoInject }
  }
  // 已经接纳过的同一条消息不是故障：重复观察直接当成功，别再记一条 warn 噪音。
  if (proposal.status === 'admitted') return true
  if (proposal.status !== 'proposed') return noteInjectionReject(sessionId, `proposal-${proposal.status}`)
  if (digest !== proposal.digest) return noteInjectionReject(sessionId, 'digest-mismatch')
  // 先算漂移：既用于阻塞判断，也用于"不阻塞但要看得见"的记录。
  const drift = snapshotDrift(sessionId, proposal.snapshot)
  if (!snapshotStillDescribesTranscript(sessionId, proposal.snapshot)) {
    map?.delete(message.id)
    return noteInjectionReject(sessionId, 'snapshot-stale', drift)
  }
  if (Object.keys(drift).length) {
    // 不阻塞，但要让"是谁把快照弄脏了"留在日志里，而不是靠猜。
    record({ kind: 'system', scope: 'private', sessionId, ok: true, level: 'info',
      message: '注入接纳 · 记账漂移（不阻塞）· ' + Object.entries(drift).map(([k, v]) => k + ': ' + v).join(' ; '),
      detail: { drift, turn: proposal.turn } })
  }
  const accepted = markInjectedRefs(sessionId, proposal.refs, proposal.memoryClock, {
    messageId: message.id, hostTurn: proposal.turn, generation: proposal.generation, epoch: proposal.epoch, actions: proposal.actions,
  })
  if (!accepted) return noteInjectionReject(sessionId, 'commit-refused')
  proposal.status = 'admitted'
  // 跨进程补认成功后把提案放回内存：同一消息再被观察（宿主重放、事件回环）
  // 走 admitted→true，而不是凭据已删后的 proposal-missing 误报警。
  if (proposal.fromStore) {
    const admittedMap = injectionAdmissions.get(sessionId) || new Map()
    admittedMap.set(message.id, proposal)
    while (admittedMap.size > 128) admittedMap.delete(admittedMap.keys().next().value)
    injectionAdmissions.set(sessionId, admittedMap)
  }
  // 凭据按它自己的 messageId 作废：补认观察到的消息 id 与凭据 id 可能不同（同内容重投）。
  try { forgetPendingInjection(sessionId, proposal.messageId || message.id) } catch {}
  const actions = proposal.actions || {}
  try {
    // Group foreign libraries independently; identical bare ids never cross layers.
    const libraries = new Map()
    for (const ref of accepted.refs) if (ref.scope === 'private') {
      const ids = libraries.get(ref.libraryId) || new Set(); ids.add(ref.id); libraries.set(ref.libraryId, ids)
    }
    for (const [libraryId, ids] of libraries) noteInjected({ libraryId, ids: [...ids] })
    noteGlobalInjected({ ids: [...new Set(accepted.refs.filter(ref => ref.scope === 'global').map(ref => ref.id))] })
    if (actions.lexicon && (!actions.lexicon.selected?.length || accepted.effects.lexiconInjectionClock)) {
      commitLexiconTurn({ libraryId: proposal.snapshot.libraryId, sessionId, ...actions.lexicon })
    }
  } catch (error) { log?.(`accepted injection accounting failed: ${error?.message || error}`) }
  if (actions.inbound) finishInbound(sessionId, actions.inbound.keys, proposal.memoryClock, { ...actions.inbound.outcome, admitted: true })
  record({ kind: 'system', scope: 'private', sessionId, libraryId: proposal.snapshot.libraryId, ok: true,
    message: '记忆消息已进入宿主历史（不代表模型已收到）', detail: { messageId: message.id, turn: proposal.turn, status: 'admitted', refs: accepted.refs.length } })
  return true
}

function finishInjectionTurn(sessionId, hostTurn, kind, log) {
  const closures = turnClosures.get(sessionId) || new Map()
  closures.set(Number(hostTurn), turnClosure(sessionId, hostTurn) + 1)
  while (closures.size > 128) closures.delete(closures.keys().next().value)
  turnClosures.set(sessionId, closures)
  while (turnClosures.size > 128) turnClosures.delete(turnClosures.keys().next().value)
  const map = injectionAdmissions.get(sessionId)
  if (!map) return
  let discarded = 0
  const abandoned = []
  for (const [id, proposal] of map) {
    if (Number.isFinite(Number(hostTurn)) && proposal.turn !== Number(hostTurn)) continue
    if (proposal.status === 'proposed') discarded += 1
    abandoned.push(id)
    map.delete(id)
  }
  if (!map.size) injectionAdmissions.delete(sessionId)
  // 落盘凭据只服务「这一轮内的跨进程/重启补认」；回合一收就作废，否则迟到的同内容消息
  // 会把一条已被丢弃的提案重新认领回来（回合末尾撤账的正确性依赖这里）。
  for (const id of abandoned) { try { forgetPendingInjection(sessionId, id) } catch {} }
  if (discarded) {
    log?.(`discarded ${discarded} unadmitted injection proposals for turn ${hostTurn}; inbound remains retryable`)
    record({ kind: 'system', scope: 'private', sessionId, ok: false, level: 'warn',
      message: '未接纳的记忆提案已丢弃，输入批次保留可重试', detail: { turn: hostTurn, discarded, status: 'proposed', kind } })
  }
}

// Every part of the first-step message is built from one binding snapshot, but
// retrieval awaits an external engine. During that window the conversation can be
// switched to another library, moved to another channel/character, or have a layer
// turned off. A snapshot that no longer matches must be discarded whole: catching
// the recall error alone would still ship the pre-switch anchor and other parts.
function injectionSnapshot(binding) {
  return {
    generation: Number(binding?.scopeGeneration || 0),
    epoch: Number(binding?.injectionEpoch || 0),
    libraryId: binding?.libraryId || null,
    scopeKey: binding?.scopeKey || null,
    memoryContext: JSON.stringify(binding?.memoryContext || {}),
    useLibrary: binding?.useLibrary !== false,
    useGlobal: binding?.useGlobal !== false,
  }
}

// 接纳专用：`scopeGeneration` 只是「这只 binding 的 scope 被写过几次」的记账编号，
// 频道每轮写一次 memoryContext 就会推进它。观察时若只发生了这种推进，内容口径（库、
// scopeKey、上下文、两开关、压缩代际）其实没变，整条注入就该照常接纳——否则接纳永远
// 落不了账，锚点/幂等全部停摆（qq-dm 实测：`未被接纳 · snapshot-stale`）。
function snapshotStillDescribesTranscript(sessionId, snapshot) {
  const current = getSessionBinding(sessionId)
  if (!current) return false
  // 只看压缩代际：它变了说明转录被替换过，旧消息的记账不该继续。
  // generation / libraryId / scopeKey / memoryContext 的漂移**不该**否掉接纳——那条消息
  // 已经由宿主写进转录、模型也确实读到了；内容口径的正确性由「发布前」的严格快照负责，
  // 事后记账再按它拒一次，只会让接纳永久失败（实测 reason 恒为 snapshot-stale）。
  if (Number(current.injectionEpoch || 0) !== snapshot.epoch) return false
  return effectiveScope(current).enabled
}

function injectionSnapshotIsCurrent(sessionId, snapshot, autoInject) {
  const current = getSessionBinding(sessionId)
  if (!current) return false
  if (Number(current.scopeGeneration || 0) !== snapshot.generation || Number(current.injectionEpoch || 0) !== snapshot.epoch) return false
  if ((current.libraryId || null) !== snapshot.libraryId) return false
  if ((current.scopeKey || null) !== snapshot.scopeKey) return false
  if (JSON.stringify(current.memoryContext || {}) !== snapshot.memoryContext) return false
  if (getSettings().autoInject !== autoInject) return false
  const scope = effectiveScope(current)
  return scope.enabled
    && scope.useLibrary === snapshot.useLibrary
    && scope.useGlobal === snapshot.useGlobal
}

// Both the ordinary first-step injection and the rules message must pass the same
// admission. A guide that ignores the switches tells a disabled conversation to use
// memory tools it is not supposed to use, and consumes delivery state while doing
// it — so re-enabling later would never deliver the rules.
function admissionFor(binding) {
  const settings = getSettings()
  if (settings.autoInject === 'off') return null
  const scope = effectiveScope(binding)
  if (!scope.enabled) return null
  return { settings, scope }
}

// The plugin no longer registers a system-prompt section. Every conversation —
// standard or a `complete: true` persona — receives the rules as one plugin
// message on the first step of a turn. `rulesKey` makes the delivery versioned:
// a domain change, a prompt edit, a restart from an old binding or a compaction
// that lost the message replaces it, while an unchanged rule set is not appended
// again on every turn. The key contains only the protocol version, the resolved
// domain and the rendered text; it deliberately excludes timestamps and turn ids.
const GUIDE_PROTOCOL = 'guide-v1'
const GUIDE_CAVEAT = '以上是本插件的记忆规则，不是用户的新指令。若本会话的工具列表里没有 memu_* 工具，请忽略本段，也不要声称自己能写记忆。'
const GUIDE_RE = /^<memory-guide(?:\s[^>]*)?>/
const GUIDE_KEY_RE = /^<memory-guide[^>]*\srules="([^"]+)"/

function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function isMemoryGuideMessage(message) {
  return message?.role === 'user'
    && message?.source?.kind === `plugin:${PLUGIN}`
    && GUIDE_RE.test(messageText(message))
}

function memoryGuideKey(message) {
  const match = GUIDE_KEY_RE.exec(messageText(message))
  return match ? match[1] : null
}

function renderMemoryGuide(payload) {
  const sessionId = payload?.agent?.session?.header?.id
  const binding = sessionId ? getSessionBinding(sessionId) : null
  const domain = binding ? domainOf(binding) : 'general'
  const settings = getSettings()
  const rendered = loadPromptForDomain('system-guide', {
    mustRememberCap: settings.mustRememberCap,
    unpinBudget: settings.unpinBudgetPerSession ?? 2,
    shortTermTtlHours: settings.shortTermTtlHours ?? 72,
    anchorTokens: settings.anchorTokens,
    turnTokens: settings.turnTokens,
  }, domain).text
  if (!rendered || !rendered.trim()) throw new Error('system-guide prompt is empty')
  const key = crypto.createHash('sha256')
    .update([GUIDE_PROTOCOL, domain, rendered, GUIDE_CAVEAT].join('\0'), 'utf8')
    .digest('hex')
    .slice(0, 16)
  const text = [`<memory-guide rules="${key}">`, rendered.trim(), '</memory-guide>', GUIDE_CAVEAT].join('\n')
  return { key, domain, text, tokens: estTokens(text) }
}

/**
 * Add, replace or restore the single effective rules message for this step.
 *
 * A rules message is turn-level guidance, so it is only considered on step 1.
 * On later steps of a long tool turn nothing is appended; the next turn's first
 * step is the next legal admission point. `guideLost` is set by compaction,
 * because the summary drops the old message and the model must learn the rules
 * again. An unchanged key with no guide in the current view is *not* treated as
 * loss: some hosts hand the plugin only the current step's messages, and
 * re-appending there would duplicate the message on every turn.
 */
/**
 * A1：本步是否需要新投 guide。keep=副本已在转录；skip=宿主只给了本步消息且稳态；
 * replace=首投/切域/改稿/guideLost。预算只在 replace 时预扣 —— 稳态回合不该
 * 每回合白压掉 600-1400 token 的召回容量。
 */
function guideAdmission(binding, messages, guideKey) {
  const guides = (messages || []).filter(isMemoryGuideMessage)
  const valid = guides.filter((message) => memoryGuideKey(message) === guideKey)
  const steady = binding?.guideRulesKey === guideKey && binding.guideLost !== true
  if (steady && valid.length >= 1) return 'keep'
  if (steady && guides.length === 0) return 'skip'
  return 'replace'
}

function ensureUnifiedGuide(ctx, payload, decision) {
  try {
    const header = payload?.agent?.session?.header
    const sessionId = header?.id
    if (!sessionId || header.origin === 'subagent') return decision
    if (typeof payload?.step === 'number' && payload.step !== 1) return decision
    const binding = getSessionBinding(sessionId)
    if (!binding || !admissionFor(binding)) return decision
    if (!decision || !Array.isArray(decision.messages)) return decision
    const guide = renderMemoryGuide(payload)
    const totalInjectionBudget = Math.max(0, Number(getSettings().injectionTotalTokens ?? 2000))
    if (guide.tokens > totalInjectionBudget) {
      try { ctx.logger?.warn?.(`dsh-memu-memory: guide message skipped: ${guide.tokens} tokens exceed injectionTotalTokens=${totalInjectionBudget}`) } catch {}
      return decision
    }
    const guides = decision.messages.filter(isMemoryGuideMessage)
    const valid = guides.filter((message) => memoryGuideKey(message) === guide.key)
    if (binding.guideRulesKey === guide.key && binding.guideLost !== true) {
      if (valid.length === 1 && guides.length === 1) return decision
      if (valid.length >= 1) {
        // Projection only: drop old and duplicated copies, keep the first one
        // that already matches. No binding write, no new message.
        const kept = valid[0]
        return { ...decision, messages: decision.messages.filter((message) => !isMemoryGuideMessage(message) || message === kept) }
      }
      // An obsolete message with no current copy stays for replacement below;
      // no guide at all means the view simply did not include history.
      if (guides.length === 0) return decision
    }
    const proposalKey = `guide:${guide.key}`
    const pending = pendingProposal(sessionId, proposalKey)
    if (pending) return reuseProposal(decision, pending, payload?.turn)
    const next = decision.messages.filter((message) => !isMemoryGuideMessage(message))
    const guideMessage = createMemoryMessage(guide.text)
    // 规则消息也落进「人类消息 → 下一次模型开口」这个窗口里：优先紧跟本步的记忆块，
    // 没有记忆块就紧跟人类消息，都没有才退回末尾。
    const memoryBlock = next.filter((message) => message?.source?.kind === `plugin:${PLUGIN}`
      && !isMemoryGuideMessage(message)).pop()
    const hostMessage = memoryBlock || humanMessage(next)
    const guideAt = hostMessage ? next.indexOf(hostMessage) + 1 : next.length
    next.splice(guideAt, 0, guideMessage)
    proposeInjection(sessionId, payload?.turn, guideMessage, [], Number(binding.inbound?.clock || payload?.turn || 0), {
      patch: { guideRulesKey: guide.key, guideMessageAt: new Date().toISOString(), guideLost: false },
    }, proposalKey, next)
    record({
      kind: 'system',
      scope: 'private',
      sessionId,
      libraryId: binding.libraryId || null,
      ok: true,
      message: '记忆规则消息待宿主接纳 · ' + guide.domain + ' · ' + guide.tokens + ' tokens'
        + (binding.guideRulesKey ? ' · 更新' : ' · 首次'),
      detail: { rulesKey: guide.key, domain: guide.domain, tokens: guide.tokens, replaced: guides.length },
    })
    return { ...decision, messages: next }
  } catch (error) {
    try { ctx.logger?.warn?.(`dsh-memu-memory: guide message skipped: ${error?.message || error}`) } catch {}
    return decision
  }
}

async function injectInboundForStep({ agent, decision, turn, signal, log, ctx }) {
  const sessionId = agent.session.header.id
  // 这条路径同时服务两种情况：本步批次里有外来人类消息（插在它后面），以及队列里的
  // 外部批次（decision.messages 可能是空的，只能追加）。两者都不允许因为「没有人类消息」
  // 被一刀切掉——排空队列、恢复待投批次都靠它。
  const human = humanMessage(decision.messages)
  const before = getSessionBinding(sessionId)
  if (!before || !hasPendingInbound(sessionId)) return decision
  const waiting = await pendingInbound(sessionId, ctx, agent.session)
  for (const proposal of injectionAdmissions.get(sessionId)?.values() || []) {
    if (proposal.status === 'proposed' && proposal.actions?.inbound?.keys?.some(key => waiting.some(item => item.key === key))
      && injectionSnapshotIsCurrent(sessionId, proposal.snapshot, proposal.autoInject)) decision = reuseProposal(decision, proposal, turn)
  }
  const proposedKeys = new Set([...(injectionAdmissions.get(sessionId)?.values() || [])]
    .filter(proposal => proposal.status === 'proposed' && proposal.generation === Number(before.scopeGeneration || 0)
      && proposal.epoch === Number(before.injectionEpoch || 0)).flatMap(proposal => proposal.actions?.inbound?.keys || []))
  // 进程内批次键去重：同一批外部输入在本次进程里只投一次。宿主接纳回调不来时，
  // pending 不会被清，于是同一批会在每个后续 step 反复满足条件——实测单回合 22 次。
  const servedKey = (key) => `${turn}|${key}`
  const batch = waiting.filter(item => !proposedKeys.has(item.key)
    && servedInbound.get(sessionId)?.has(servedKey(item.key)) !== true)
  if (signal?.aborted) return decision
  // 空批不等于没事可做：这一步可能带着一条人类消息，而锚点/规则是一次性的。旧代码
  // 在这里直接 return，于是「陈旧 pending 把首步劫持到 inbound 路径」的会话首步一条
  // 记忆都投不出来，模型先开口、下一步才补锚点（qq-dm turn 335 实测）。
  const binding = getSessionBinding(sessionId)
  if (!binding || binding.libraryId !== before.libraryId) return decision
  const scope = effectiveScope(binding)
  const settings = getSettings()
  const keys = batch.map(item => item.key)
  const priorOutcome = binding.lastInboundOutcome
  const sameBatch = JSON.stringify(priorOutcome?.keys) === JSON.stringify(keys)
  const clock = sameBatch && Number.isFinite(priorOutcome?.clock) ? priorOutcome.clock : nextMemoryClock(binding, turn)
  const admissible = batch.filter(item => {
    const current = binding.memoryContext || {}
    return (item.libraryId || null) === (binding.libraryId || null)
      && ['channelId', 'characterId', 'worldId', 'branchId'].every(key => !item.context[key] || item.context[key] === current[key])
      && (!item.context.knownBy?.length || item.context.knownBy.includes(current.characterId))
  })
  // 「批里没有一条属于本库/本上下文」和空批等价：这一批没有可注入的召回内容。只要本步
  // 带着人类消息，锚点/规则仍然要投，否则模型先开口、锚点下一步才补（qq-dm turn 338 实测）。
  const anchorOnly = Boolean(human) && !admissible.length
  if (!batch.length && !anchorOnly) {
    if (evalNoteOnce(sessionId, 'inbound-no-batch')) record({ kind: 'system', scope: 'private', sessionId, libraryId: binding.libraryId || null, ok: false, level: 'info',
      message: '注入评估 · inbound 无批次 · human=' + Boolean(human) + ' · waiting=' + waiting.length
        + ' · proposed=' + proposedKeys.size + ' · served=' + (servedInbound.get(sessionId)?.size || 0),
      detail: { turn, human: Boolean(human), waiting: waiting.length, proposed: proposedKeys.size } })
    return decision
  }
  const proposalKey = anchorOnly ? `anchor:${turn}` : `batch:${keys.slice().sort().join(',')}`
  const pending = pendingProposal(sessionId, proposalKey)
  if (pending) return reuseProposal(decision, pending, turn)
  if (settings.autoInject === 'off' || !scope.enabled) {
    if (anchorOnly) return decision
    finishInbound(sessionId, keys, clock, { reason: 'disabled', injectedCount: 0 })
    return decision
  }
  if (!admissible.length && !anchorOnly) {
    finishInbound(sessionId, keys, clock, { reason: 'scope', injectedCount: 0 })
    return decision
  }
  const images = admissible.flatMap(item => imageTurn(item).images)
  const query = truncateToTokens(admissible.map(item => {
    const text = imageTurn(item).query
    return [item.context.channelId, item.context.speakerId, text].filter(Boolean).join(' ')
  }).join('\n'), 300)
  const effective = { ...binding, useLibrary: scope.useLibrary, useGlobal: scope.useGlobal }
  const snapshot = injectionSnapshot(effective)
  const parts = []
  const ids = []
  const refs = []
  const anchorRefs = []
  let lexiconTurnCommit = null
  const media = (getSessionBinding(sessionId)?.pendingMedia || []).filter(item => images.some(image => image.attachment.attachmentId === (item.sourceAttachmentId || item.sha256)))
  const imageCount = images.length
  setSessionBinding(sessionId, { lastImageCount: imageCount })
  const anchorPushedBefore = effective.anchorPushed ?? (effective.injectedIds || []).includes(ANCHOR_SENTINEL)
  const anchorNeeded = effective.reinjectPending || anchorPushedBefore !== true
  // turnTokens remains the recall block's own ceiling, but injectionTotalTokens is
  // the ceiling for the whole plugin message. The two must be applied together:
  // otherwise a 160-token total with an 800-token recall budget injects ~786.
  const turnBudget = Math.max(0, Number(settings.turnTokens ?? 640))
  const totalBudget = Math.max(0, Number(settings.injectionTotalTokens ?? 2000))
  let guideReserve = 0
  try {
    const guide = renderMemoryGuide({ agent })
    if (guideAdmission(getSessionBinding(sessionId), decision?.messages, guide.key) === 'replace'
        && guide.tokens <= totalBudget) guideReserve = guide.tokens
  } catch {}
  const effectiveTotalBudget = Math.max(0, totalBudget - guideReserve)
  const totalRoom = () => Math.max(0, effectiveTotalBudget - estTokens(parts.join('\n\n')) - (parts.length ? 2 : 0))
  const appendBounded = (text, candidateIds = [], candidateRefs = []) => {
    if (!text || estTokens(text) > totalRoom()) return false
    parts.push(text)
    ids.push(...candidateIds.filter(id => text.includes(`[${id}]`)))
    refs.push(...candidateRefs)
    return true
  }
  // 词典失败收集器：只 warn + lastRecallError，绝不进 errors（那会整批重试）。
  // 必须声明在第一次使用之前：旧版把它写在锚点段之后，锚点一抛就撞进 TDZ，
  // fail-open 自己变成 ReferenceError。
  let lexiconError = null
  if (anchorNeeded && totalRoom() >= 160) {
    const anchor = buildAnchor(effective, { ...settings, anchorTokens: Math.min(Number(settings.anchorTokens || 700), Math.floor(turnBudget / 2), totalRoom()) }, sessionId)
    if (appendBounded(anchor.text, anchor.ids, anchor.refs || [])) anchorRefs.push(...(anchor.refs || []))
    // 锚点段追加词典摘要（§3.3 通道 A）。异常进 lexiconError，fail-open。
    // 作用域按词典自己的尺子判（私有关掉时全局词典仍要读），不是 useLibrary。
    if (lexiconScopeAllowed(effective) && totalRoom() >= 60) {
      try {
        const lexAnchor = buildLexiconAnchor(effective, sessionId, Math.min(LEXICON_ANCHOR_TOKEN_CAP, totalRoom()))
        appendBounded(lexAnchor.text)
        if (lexAnchor.errors?.length) lexiconError = `degraded lexicon sources: ${lexAnchor.errors.join('; ')}`
      } catch (error) {
        lexiconError = `anchor summary failed: ${error?.message || error}`
      }
    }
  }
  if (media.length) {
    const lines = media.map(item => `${item.sha256} · ${item.captionBy}: ${clip(item.caption || '[图片]', 35)}${item.missing ? ' · missing' : ''}`).join('\n')
    const text = ['<memory-media>', truncateToTokens(lines, Math.min(140, Math.floor(totalRoom() / 3))), '图片引用不是视觉证据；attachments 只接受 sha256。', '</memory-media>'].join('\n')
    appendBounded(text)
  }
  // B 通道文本源：本批 admissible 的真实用户消息（已过 scope/context 准入）。
  const lexiconUserTexts = admissible.map(item => imageTurn(item).query).filter(Boolean)
  let outcome = 'anchor-only'
  let errors = []
  const minInboundChars = Math.max(1, Math.min(Number(settings.minUserChars ?? 6), 2))
  if (settings.autoInject !== 'anchor-only' && (imageCount || query.length >= minInboundChars)) {
    const recallBudget = Math.max(0, Math.min(turnBudget, totalRoom()))
    if (recallBudget > 0) {
      const recall = await buildRecall(effective, query, clock, { ...settings, turnTokens: recallBudget }, { agent }, sessionId, { excludedRefs: anchorRefs })
      appendBounded(recall.text, recall.ids, recall.refs || [])
      errors = recall.errors
      outcome = recall.outcome || 'no-match'
    }
  }
  if (signal?.aborted) return decision
  const current = getSessionBinding(sessionId)
  if (!current || !injectionSnapshotIsCurrent(sessionId, snapshot, settings.autoInject)) return decision
  if (errors.length) {
    setRecallError(sessionId, errors.join('; '))
    setSessionBinding(sessionId, { inbound: { ...current.inbound, retryAt: new Date(Date.now() + 30_000).toISOString() },
      lastInboundOutcome: { reason: 'error', at: new Date().toISOString(), count: keys.length, injectedCount: 0 } })
    try { log?.(`inbound recall degraded: ${errors.join('; ')}`) } catch {}
    return decision
  } else setRecallError(sessionId, null)
  // B 通道（§3.3）：本批真实用户消息命中词条 → term→meaning，最多 2 条、带冷却。
  // 刻意放在召回错误检查之后——召回错误走整批重试，词典不搭车，也不给一段永远
  // 不会被发出去的文本记 injection/冷却。
  if (settings.autoInject !== 'anchor-only' && lexiconScopeAllowed(effective)) {
    try {
      const lexTurn = injectLexiconTurn({ binding: effective, sessionId, userTexts: lexiconUserTexts, tokenBudget: totalRoom() })
      if (lexTurn.errors?.length) lexiconError = [lexiconError, `degraded lexicon sources: ${lexTurn.errors.join('; ')}`].filter(Boolean).join('; ')
      if (lexTurn.text && estTokens(lexTurn.text) <= totalRoom()) {
        parts.push(lexTurn.text)
        lexiconTurnCommit = { hits: lexTurn.hits, selected: lexTurn.selected }
      } else if (lexTurn.hits.length) {
        lexiconTurnCommit = { hits: lexTurn.hits, selected: [] }
      }
    } catch (error) {
      lexiconError = [lexiconError, `turn match failed: ${error?.message || error}`].filter(Boolean).join('; ')
    }
  }
  if (lexiconError) {
    try { log?.(`lexicon degraded (fail-open): ${lexiconError}`) } catch {}
    const prior = getSessionBinding(sessionId)?.lastRecallError || null
    try { setRecallError(sessionId, [prior, `lexicon: ${lexiconError}`].filter(Boolean).join('; ')) } catch {}
  }
  const text = parts.join('\n\n')
  // Final assertion: every block above is individually bounded, so exceeding the
  // whole-message ceiling here means the accounting drifted. Drop the batch rather
  // than publish an over-budget message.
  if (estTokens(text) > totalBudget) {
    setRecallError(sessionId, 'inbound injection exceeded injectionTotalTokens')
    return decision
  }
  let inboundMessage = null
  if (text) {
    inboundMessage = createMemoryMessage(text)
    const anchorPushed = anchorNeeded && Boolean(parts[0]?.startsWith('===== memory anchor'))
    if (anchorPushed) anchorSeen.add(sessionId)
    proposeInjection(sessionId, turn, inboundMessage, refs, clock, {
      anchor: anchorPushed, lexicon: lexiconTurnCommit,
      inbound: { keys, outcome: { reason: outcome, injectedCount: refs.length } },
    }, proposalKey, decision.messages)
    setSessionBinding(sessionId, { lastInboundOutcome: { reason: outcome, status: 'proposed', injectedCount: 0, proposedCount: refs.length, count: keys.length, at: new Date().toISOString() } })
  } else {
    advanceMemoryClock(sessionId, clock)
    finishInbound(sessionId, keys, clock, { reason: outcome, injectedCount: 0 })
  }
  if (!inboundMessage) return decision
  const placed = [...decision.messages]
  const at = human ? placed.indexOf(human) : -1
  placed.splice(at < 0 ? placed.length : at + 1, 0, inboundMessage)
  for (const item of batch) servedSet(servedInbound, sessionId).add(servedKey(item.key))
  return { ...decision, messages: placed }
}

// 回合中途的补充召回（coding 长回合）。位置不变式在这里物理上不成立：这一批里没有
// 人类消息，落点只能在工具结果之后、下一次模型请求之前。所以它是单独一类内容：
// 带 phase 标记、单独预算、每回合有上限，靠「自上次注入以来的增量」触发，不是每步都跑。
const midTurnMarks = new Map()

function midTurnStateFor(sessionId, turn) {
  const previous = midTurnMarks.get(sessionId)
  if (previous && previous.turn === Number(turn)) return previous
  const next = { turn: Number(turn), units: 0, chars: 0, injections: 0, emptyStreak: 0, lastStep: 1, lastAt: 0 }
  midTurnMarks.set(sessionId, next)
  while (midTurnMarks.size > 128) midTurnMarks.delete(midTurnMarks.keys().next().value)
  return next
}

function midTurnPolicy(settings) {
  return {
    enabled: settings.midTurnRecall !== false,
    minSteps: Math.max(1, Number(settings.midTurnMinSteps ?? 4)),
    minUnits: Math.max(1, Number(settings.midTurnMinUnits ?? 3)),
    minChars: Math.max(0, Number(settings.midTurnMinChars ?? 6000)),
    maxPerTurn: Math.max(1, Number(settings.midTurnMaxPerTurn ?? 2)),
    cooldownMs: Math.max(0, Number(settings.midTurnCooldownMs ?? 60000)),
    tokens: Math.max(120, Number(settings.midTurnTokens ?? 400)),
    fullUnits: Math.max(1, Number(settings.midTurnFullUnits ?? 6)),
    fullChars: Math.max(0, Number(settings.midTurnFullChars ?? 15000)),
  }
}

// 增量证据与 active-memory 的计分口径一致：同一条工具结果重复出现（轮询、重读、重试）
// 只算一次，否则一个重读循环就能把分数刷爆。
function collectMidTurnEvidence(messages) {
  const seen = new Set()
  let units = 0
  let chars = 0
  const texts = []
  for (const message of messages || []) {
    const blocks = Array.isArray(message?.content) ? message.content : []
    const isToolResult = message?.role === 'tool'
      || String(message?.source?.kind || '').startsWith('tool')
      || blocks.some(block => block?.type === 'tool-result')
    if (!isToolResult) continue
    const text = messageText(message)
    if (!text) continue
    const key = text.slice(0, 160) + '|' + text.length
    if (seen.has(key)) continue
    seen.add(key)
    units += 1
    chars += Math.min(text.length, 2000)
    texts.push(text)
  }
  return { units, chars, text: texts.join('\n') }
}

async function maybeMidTurnRecall({ agent, decision, turn, step, ctx, log = null }) {
  const sessionId = agent?.session?.header?.id
  if (!sessionId) return decision
  const settings = getSettings()
  const policy = midTurnPolicy(settings)
  if (!policy.enabled || settings.autoInject === 'off' || settings.autoInject === 'anchor-only') return decision
  const binding = getSessionBinding(sessionId)
  const admitted = binding ? admissionFor(binding) : null
  if (!admitted) return decision
  const state = midTurnStateFor(sessionId, turn)
  const evidence = collectMidTurnEvidence(decision.messages)
  state.units += evidence.units
  state.chars += evidence.chars
  const currentStep = Math.max(1, Number(step) || 1)
  if (currentStep - state.lastStep < policy.minSteps) return decision
  if (state.units < policy.minUnits && state.chars < policy.minChars) return decision
  if (state.injections >= policy.maxPerTurn || state.emptyStreak >= 2) return decision
  if (state.lastAt && Date.now() - state.lastAt < policy.cooldownMs) return decision
  const effective = { ...binding, useLibrary: admitted.scope.useLibrary, useGlobal: admitted.scope.useGlobal }
  const snapshot = injectionSnapshot(effective)
  const clock = nextMemoryClock(binding, turn)
  const note = `[回合中途补充 · 这不是用户新说的话 · 本回合已跑 ${currentStep} 步]`
  const full = state.units >= policy.fullUnits && state.chars >= policy.fullChars
  let text = null
  let refs = []
  if (full) {
    const query = truncateToTokens(evidence.text, 300)
    if (!query) return decision
    try {
      const recall = await buildRecall(effective, query, clock,
        { ...settings, turnTokens: policy.tokens }, { agent }, sessionId, {})
      if (recall.errors?.length) setRecallError(sessionId, recall.errors.join('; '))
      if (recall.text && estTokens(recall.text) <= policy.tokens + 60) {
        text = [note, recall.text].join('\n')
        refs = recall.refs || []
      }
    } catch (error) {
      try { log?.(`mid-turn recall degraded: ${error?.message || error}`) } catch {}
    }
  }
  if (!text) {
    // 分数刚过线：只提示工具有得查，不投正文。
    text = [note, '如果你需要更早的上下文，可以调用 memu_private_recall 按关键词查。'].join('\n')
  }
  if (!injectionSnapshotIsCurrent(sessionId, snapshot, settings.autoInject)) return decision
  if (estTokens(text) > Math.max(0, Number(settings.injectionTotalTokens ?? 2000))) return decision
  const message = createMemoryMessage(text)
  proposeInjection(sessionId, turn, message, refs, clock, { patch: {} }, `mid:${turn}:${currentStep}`, decision.messages)
  state.injections += 1
  state.lastStep = currentStep
  state.lastAt = Date.now()
  // 空召回退避只针对「真的去查了却查空」；提示卡是刻意投的，不算失败。
  if (refs.length) state.emptyStreak = 0
  else if (full) state.emptyStreak += 1
  return { ...decision, messages: [...decision.messages, message] }
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
    const inbound = await injectInboundForStep({ agent, decision, turn, signal, log, ctx })
    if (inbound !== decision) return inbound
    // 中转批次没有人类消息 → inbound 路径不投；此时才轮到回合中途的补充召回。
    return maybeMidTurnRecall({ agent, decision, turn, step, ctx, log })
  }

  // 人类消息优先用 humanMessage：通道驱动（channel-qq 等）的 source.kind 不是 `user`，
  // 旧口径在这里直接退到 inbound 路径，记忆块因此被追加到批次末尾（工具调用之后）。
  const lastUser = humanMessage(decision.messages) || lastRealUser(decision.messages)
  if (!lastUser) return injectInboundForStep({ agent, decision, turn, signal, log, ctx })

  const sessionId = header.id
  // Injection must never opt a conversation into memory on its own: a library is
  // only created by the new-session prompt or an explicit user action.
  const binding = ensureSession(sessionId, { cwd: header.cwd, agentPreset: header.agentPreset, createLibrary: false })
  const proposalKey = `user:${lastUser.id}:${bodyDigest(lastUser)}`
  const pending = pendingProposal(sessionId, proposalKey)
  if (pending) return reuseProposal(decision, pending, turn)
  const humanAlreadyServed = humanServed(sessionId, lastUser.id)
  if ((binding.lastInjectedUserMessageId === lastUser.id || humanAlreadyServed) && binding.reinjectPending !== true) {
    return hasPendingInbound(sessionId) ? injectInboundForStep({ agent, decision, turn, signal, log, ctx }) : decision
  }
  const realIds = new Set([...decision.messages.filter(message => message.source?.kind === 'user').map(message => message.id),
    lastUser.id].filter(Boolean))
  // 强制口径：本步批次里只要有原生人类消息（source.kind === 'user'），就不再被陈旧
  // pending 劫持去 inbound 路径。劫持会让首步一条记忆都投不出来，锚点只能等下一步补，
  // 于是出现「工具已经把消息发出去、锚点才到」（qq-dm turn 335/338/339 反复实测）。
  const hasNativeHuman = decision.messages.some(message => message?.role === 'user' && message?.source?.kind === 'user' && message?.id)
  if (!hasNativeHuman && (binding.inbound?.pending || []).some(item => item.producer !== 'host.user' || !realIds.has(item.id))) {
    const fresh = decision.messages.filter(message => message.role === 'user' && message.source?.kind === 'user' && message.id)
    if (fresh.length) ingestInboundBatch({ sessionId, session: agent.session, ctx, batch: {
      type: INBOUND_TYPE, version: 1, producer: 'host.user', batchId: `step:${turn}:${step || 1}`,
      messages: fresh.map(nativeInboundMessage).filter(Boolean),
    } })
    return injectInboundForStep({ agent, decision, turn, signal, log, ctx })
  }
  if (binding.inbound?.pending?.length) await pendingInbound(sessionId, ctx, agent.session)
  // 词典 B 通道的文本源（docs/memory-semantics.md §8.13.1）：inbound journal 里本轮的
  // 真实用户批次 + 决策消息里 source.kind === 'user' 的原生消息。必须在
  // noteNativeUserMessages 把原生消息摘出 pending 之前取；插件消息的 source.kind
  // 是 `plugin:dsh-memu-memory`，工具结果/assistant 自言自语根本不是 user 角色，
  // 所以这个并集里没有可供误命中的非用户文本。
  const lexiconUserTexts = [...new Set([...inboundUserTexts(binding),
    ...decision.messages.filter(message => message?.role === 'user' && message?.source?.kind === 'user')
      .map(message => messageText(message)).filter(Boolean)])]
  const native = decision.messages.filter(message => message?.role === 'user' && message.source?.kind === 'user' && message.id)
  if (native.length) ingestInboundBatch({ sessionId, session: agent.session, ctx, batch: {
    type: INBOUND_TYPE, version: 1, producer: 'host.user', batchId: `step:${turn}:${step || 1}`,
    messages: native.slice(-32).map(nativeInboundMessage).filter(Boolean),
  } })
  const inboundKeys = (getSessionBinding(sessionId)?.inbound?.pending || []).filter(item => item.producer === 'host.user' && realIds.has(item.id)).map(item => item.key)
  const memoryClock = nextMemoryClock(binding, turn)
  advanceMemoryClock(sessionId, memoryClock)
  // Advance the idle clock even when injection is off, so sleep consolidation
  // still knows when this conversation last did anything.
  touchSession(sessionId)
  // The folder policy is the ceiling: a conversation cannot opt into a memory
  // layer its folder has switched off. The guide message shares this admission.
  const admitted = admissionFor(binding)
  if (!admitted) return decision
  const { settings, scope } = admitted
  const effective = { ...binding, useLibrary: scope.useLibrary, useGlobal: scope.useGlobal }
  // Captured before any await below; re-checked immediately before the splice.
  const snapshot = injectionSnapshot(effective)

  const query = contextualQuery(decision.messages, lastUser)
  const imageCount = imageTurn(lastUser).imageCount
  setSessionBinding(sessionId, { lastImageCount: imageCount })
  // 短句也要召回：QQ 里常见「摸摸」「现在有点饿」这类 2–5 字回合，原来的 minUserChars=6
  // 会把它们挡在召回之外，叠加「锚点一会话一次」就变成「首步一条记忆都没有」。
  // 现在门槛下限是 2 字（minUserChars 仍可调，只是不再让短句完全静默）。
  const minQueryChars = Math.max(1, Math.min(Number(settings.minUserChars ?? 6), 2))
  const tooShort = !imageCount && query.length < minQueryChars
  const reinject = binding.reinjectPending === true
  // 口径 A：锚点一会话一份，位置紧跟人类消息。首步要有内容，靠的是「短句也召回」
  // （minQueryChars 下限 2 字），不靠每回合重发整块索引——后者会破坏「锚点一会话一次」
  // 的契约（单测与验收 J-8 都钉着它），并且每回合多烧 600~900 token。
  // anchorPushed / reinjectPending 只在宿主接纳时清除，长期不回调会卡死；
  // anchorSeen 是本进程的兜底，不落盘，重启后重发一次，压缩时清空。
  const anchorPushedAlready = binding.anchorPushed ?? (binding.injectedIds || []).includes(ANCHOR_SENTINEL)
  // A 方案：锚点仍是一会话一次（契约不变）。首步要有内容，靠的是下面把召回门槛降下来，
  // 不是靠每回合重发整块索引。anchorSeen 是不依赖接纳回调的进程内兜底。
  const anchorNeeded = reinject || (anchorPushedAlready !== true && !anchorSeen.has(sessionId))

  // Read the present mood before retrieval so the recall ordering can use it.
  if (!reinject && !tooShort) setSessionMood(sessionId, readMood(query))

  const parts = []
  const ids = []
  const refs = []
  const anchorRefs = []
  const deferredActions = { patch: {} }
  // 词典链路的失败收集器：与记忆召回分开，任何词典异常只 warn + lastRecallError，
  // 绝不进 recall 的 errors（那会触发整批重试，等于词典故障绑架记忆投递）。
  let lexiconError = null
  // The sub-budgets (anchorTokens, turnTokens, the hint's own cap) are ceilings for
  // their own blocks; injectionTotalTokens is the ceiling for the whole plugin
  // message. Without this outer gate the sub-budgets can add up past the configured
  // total even when each one individually looks fine.
  const totalInjectionBudget = Math.max(0, Number(settings.injectionTotalTokens ?? 2000))
  // Guide 是独立 plugin 消息，不能落在 injectionTotalTokens 之外（5.2）：在本步开始
  // 预算时就为它预扣；guide 自身大于总预算时不预扣，并让 ensureUnifiedGuide 跳过它。
  let guideReserve = 0
  try {
    const guide = renderMemoryGuide({ agent })
    if (guideAdmission(getSessionBinding(sessionId), decision?.messages, guide.key) === 'replace'
        && guide.tokens <= totalInjectionBudget) guideReserve = guide.tokens
  } catch {}
  const injectionBudget = Math.max(0, totalInjectionBudget - guideReserve)
  const totalRoom = () => Math.max(0, injectionBudget - estTokens(parts.join('\n\n')) - (parts.length ? 2 : 0))
  // 媒体块按「人类消息 + sha256」去重：同一条消息里的同一张图只提示一次，
  // 新消息里重新发同一张图仍然会提示（那是新的附件引用）。
  const mediaToMark = []
  if (imageCount && effective.useLibrary && lastUser?.id) {
    const current = getSessionBinding(sessionId)
    const pending = (current?.pendingMedia || []).slice(-8)
      .filter(item => item?.sha256 && !mediaServed(sessionId, lastUser.id, item.sha256))
    if (pending.length) {
      const details = pending.map(item => `${item.sha256} · ${item.captionBy}: ${clip(item.caption || '[图片]', 35)}${item.missing ? ' · missing' : ''}`).join('\n')
      const mediaText = ['<memory-media>', truncateToTokens(details, 150), current.stickerHint ? '同图反复出现，可以用 track=habit 聚合表达习惯，不必逐次写记忆。' : '', '只知道描述与引用，不能凭空声称看过像素。attachments 只接受 sha256。', '</memory-media>'].filter(Boolean).join('\n')
      if (estTokens(mediaText) <= totalRoom()) {
        parts.push(mediaText)
        mediaToMark.push(...pending.map(item => item.sha256))
      }
    }
  }

  if (anchorNeeded) {
    const anchor = totalRoom() >= 160
      ? buildAnchor(effective, { ...settings, anchorTokens: Math.min(Number(settings.anchorTokens || 800), totalRoom()) }, sessionId)
      : { text: '', ids: [] }
    if (anchor.text && estTokens(anchor.text) <= totalRoom()) {
      parts.push(anchor.text)
      ids.push(ANCHOR_SENTINEL, ...anchor.ids)
      refs.push(...(anchor.refs || []))
      anchorRefs.push(...(anchor.refs || []))
    }
    // 锚点段追加词典摘要（§3.3 通道 A）。词典异常延迟到 recall 之后的统一
    // fail-open 处理，这里只吞掉占位。
    if (lexiconScopeAllowed(effective) && totalRoom() >= 60) {
      try {
        const lexAnchor = buildLexiconAnchor(effective, sessionId, Math.min(LEXICON_ANCHOR_TOKEN_CAP, totalRoom()))
        if (lexAnchor.errors?.length) lexiconError = `degraded lexicon sources: ${lexAnchor.errors.join('; ')}`
        if (lexAnchor.text && estTokens(lexAnchor.text) <= totalRoom()) parts.push(lexAnchor.text)
      } catch (error) {
        lexiconError = `anchor summary failed: ${error?.message || error}`
      }
    }
    // Only on the reinject path: this is the turn that follows a compaction, and it is
    // the only moment the pre-compaction memories are missing from the window.
    if (reinject) {
      const replay = buildReplay(effective, settings, sessionId)
      if (replay.text && estTokens(replay.text) <= totalRoom()) {
        parts.push(replay.text)
        ids.push(...replay.ids)
        // Replay restores already-seen context; it is not a fresh cooldown event.
        Object.assign(deferredActions.patch, { replayIds: [], replayedAt: new Date().toISOString() })
      }
    }
  }

  // Same-turn dedup (工单 C / R1): the anniversary block and the open-loop nudge can
  // name the same memory, and saying it twice in one message reads like a glitch.
  // Only an anniversary that actually reached `parts` may suppress the nudge — one
  // the budget dropped must not silence it, because then the turn says nothing.
  let anniversaryIds = []
  let anniversaryFired = []
  if (!reinject) {
    const anniversary = buildAnniversary(sessionId, effective)
    if (anniversary.text && estTokens(anniversary.text) <= totalRoom()) {
      parts.push(anniversary.text)
      ids.push(...anniversary.ids)
      anniversaryIds = anniversary.ids
      anniversaryFired = anniversary.fired || []
      deferredActions.anniversaries = Object.fromEntries(anniversaryFired.map(id => [id, anniversary.dayKey]))
      refs.push(...privateDisplayRefs(effective, anniversary.ids))
    }
  }

  let recurringNudgeIds = []
  let displayedNudgeIds = []
  if (!reinject) {
    // Independent of retrieval: a loop can be worth raising in a conversation that
    // shares no vocabulary with it, which is exactly the case lexical recall misses.
    const nudge = buildOpenLoopNudge(effective, settings, sessionId, { skipIds: anniversaryIds })
    if (nudge.text && estTokens(nudge.text) <= totalRoom()) {
      parts.push(nudge.text)
      ids.push(...nudge.ids)
      recurringNudgeIds = nudge.recurringIds
      displayedNudgeIds = nudge.ids
      refs.push(...privateDisplayRefs(effective, nudge.ids))
    }
    // S4.3：到期/临期承诺单独一张小卡，最多 3 条；同一回合不与 open-loop 重复。
    const commitmentNudge = buildCommitmentNudge(effective, settings, sessionId, {
      skipIds: [...anniversaryIds, ...displayedNudgeIds],
    })
    if (commitmentNudge.text && estTokens(commitmentNudge.text) <= totalRoom()) {
      parts.push(commitmentNudge.text)
      ids.push(...commitmentNudge.ids)
      refs.push(...privateDisplayRefs(effective, commitmentNudge.ids))
    }
  }

  if (!reinject && settings.autoInject !== 'anchor-only' && !tooShort) {
    // The recall path takes the host's exec shape, where the session lives under
    // `.agent`; passing the Agent itself made sessionIdOf return null and turned
    // every per-turn recall into a silent no-op (P0-1).
    const recallBudget = Math.max(0, Math.min(Number(settings.turnTokens ?? 800), totalRoom()))
    const recall = await buildRecall(effective, query, memoryClock, { ...settings, turnTokens: recallBudget }, { agent }, sessionId, { excludedRefs: anchorRefs })
    const recallOutcome = { reason: recall.outcome || 'no-match', candidateCount: recall.candidateCount || 0,
      injectedCount: 0, proposedCount: recall.ids.length, status: 'proposed', at: new Date().toISOString() }
    setSessionBinding(sessionId, { lastRecallOutcome: recallOutcome })
    if (recall.text && estTokens(recall.text) <= totalRoom()) {
      parts.push(recall.text)
      ids.push(...recall.ids)
      refs.push(...(recall.refs || []))
      deferredActions.patch.lastRecallOutcome = { ...recallOutcome, injectedCount: recall.ids.length, status: 'admitted' }
    }
    if (recall.errors.length > 0) {
      setRecallError(sessionId, recall.errors.join('; '))
      try { log?.(`recall degraded: ${recall.errors.join('; ')}`) } catch {}
    } else if ((recall.candidateCount || 0) > 0) {
      // Nothing failed and something was found. This is the only state that proves a
      // previous failure is over, so it is the only state allowed to clear the signal.
      emptyRecallNoted.delete(String(sessionId || ''))
      setRecallError(sessionId, null)
    } else {
      // Empty and error-free. Clearing the signal here erased the evidence of whatever
      // went wrong the last time (a failed inbound write, a degraded engine, a scope
      // that had just been narrowed) and left the sidebar with nothing at all — the
      // most common shape of "memory is not working" with no trace to follow. Keep the
      // previous signal, and say once per session why this turn produced nothing.
      noteEmptyRecall(sessionId, { log, turn })
    }
  }

  // B 通道（§3.3）：用户消息命中词条 → term→meaning，最多 LEXICON_MAX_PER_TURN 条，
  // 每条过冷却。刻意不受 tooShort 门控——"糖刀"这类两个字的词面命中恰恰是词典
  // 的主场景，minUserChars 挡的是向量召回的成本，不是确定性词面检索。
  // fail-open：lexiconMatch 抛错（含词典损坏的 typed error）只记 lexiconError。
  // 记账（candidate/injection/冷却）推迟到 snapshot 复检通过之后：回合中途换了
  // 库/上下文时整条消息都会被丢弃，不能给一段没发出去的文本记冷却。
  let lexiconTurnCommit = null
  if (!reinject && settings.autoInject !== 'anchor-only' && lexiconScopeAllowed(effective)) {
    try {
      const lexTurn = injectLexiconTurn({ binding: effective, sessionId, userTexts: lexiconUserTexts, tokenBudget: totalRoom() })
      if (lexTurn.errors?.length) lexiconError = [lexiconError, `degraded lexicon sources: ${lexTurn.errors.join('; ')}`].filter(Boolean).join('; ')
      if (lexTurn.text && estTokens(lexTurn.text) <= totalRoom()) {
        parts.push(lexTurn.text)
        lexiconTurnCommit = { hits: lexTurn.hits, selected: lexTurn.selected }
      } else if (lexTurn.hits.length) {
        lexiconTurnCommit = { hits: lexTurn.hits, selected: [] }
      }
    } catch (error) {
      lexiconError = [lexiconError, `turn match failed: ${error?.message || error}`].filter(Boolean).join('; ')
    }
  }
  if (lexiconError) {
    try { log?.(`lexicon degraded (fail-open): ${lexiconError}`) } catch {}
    const prior = getSessionBinding(sessionId)?.lastRecallError || null
    try { setRecallError(sessionId, [prior, `lexicon: ${lexiconError}`].filter(Boolean).join('; ')) } catch {}
  }

  if (!reinject) {
    const cue = await maybeCue({ sessionId, turn, settings, binding: effective, exec: { agent }, deferred: true })
    if (cue && estTokens(cue.text) <= totalRoom()) {
      parts.push(cue.text)
      // The related pointers reached the window, so they count towards habituation and
      // dedupe exactly like the recall block's ids.
      ids.push(...cue.ids)
      refs.push(...privateDisplayRefs(effective, cue.ids))
      deferredActions.cue = cue.cue
    }
    const textureActions = {}
    const texture = maybeTexture(sessionId, settings, new Date(), textureActions)
    if (texture && estTokens(texture) <= totalRoom()) {
      parts.push(texture)
      Object.assign(deferredActions.patch, textureActions.patch)
    }
  }

  if (parts.length === 0) {
    // 自述：首步到底为什么一条都没投。否则「模型先开口、锚点下一步才到」只能靠猜。
    if (evalNoteOnce(sessionId, 'step1-empty')) record({ kind: 'system', scope: 'private', sessionId, libraryId: binding.libraryId || null, ok: false, level: 'info',
      message: '注入评估 · 本步无内容 · anchor=' + (anchorNeeded ? 'on' : 'off')
        + ' · anchorPushed=' + String(binding.anchorPushed) + ' · reinject=' + String(reinject)
        + ' · tooShort=' + String(tooShort) + ' · query=' + query.length + ' 字 · 库=' + (binding.libraryId || 'none')
        + ' · 开关=' + (scope.useLibrary ? 'L' : '-') + (scope.useGlobal ? 'G' : '-'),
      detail: { step: 1, anchorNeeded, reinject, tooShort, queryLen: query.length, anchorTokens: settings.anchorTokens } })
    if (inboundKeys.length) finishInbound(sessionId, inboundKeys, memoryClock, { reason: 'no-match', injectedCount: 0 })
    return decision
  }

  // This is the last point before the message enters decision.messages. Recall,
  // cue and texture all awaited above; a library/context/switch change during any
  // of them invalidates every part built from the old snapshot, not just recall.
  if (!injectionSnapshotIsCurrent(sessionId, snapshot, settings.autoInject)) return decision
  // A returned decision is still only a proposal; display effects wait for history.

  const text = parts.join('\n\n')
  const message = createMemoryMessage(text)
  const rewritten = [...decision.messages]
  const index = rewritten.indexOf(lastUser)
  if (index < 0) return decision
  // 位置口径：记忆块**紧跟在这一步的人类消息之后**（index + 1），且只在批次里真的有
  // 人类消息时才投。旧口径是前插到用户消息之前，理由是「回应用户前先想起来的上下文」；
  // 但通道驱动的回合根本走不到这里，实际落点是批次末尾，于是锚点出现在工具调用之后。
  // 后插在语义上仍然是「用户说完、模型开口之前」，而且跨通道一致。
  //
  // 关于缓存：v1 审计曾说前插会破坏宿主 KV cache——已证伪。agent/pre-step 是
  // waterfall，`payload.messages` 是「这一步从收件箱里新取出的一批」，已缓存的
  // 历史前缀逐字未动；createUserMessage 也是新建一条冻结消息，不改旧消息。前插
  // 只改变这一批内部的顺序。
  rewritten.splice(index + 1, 0, message)
  deferredActions.anchor = ids.includes(ANCHOR_SENTINEL)
  if (deferredActions.anchor) anchorSeen.add(sessionId)
  deferredActions.nudgeIds = recurringNudgeIds
  deferredActions.lexicon = lexiconTurnCommit
  deferredActions.patch.lastInjectedUserMessageId = lastUser.id
  if (inboundKeys.length) deferredActions.inbound = { keys: inboundKeys, outcome: { reason: 'memory', injectedCount: refs.length } }
  proposeInjection(sessionId, turn, message, refs, memoryClock, deferredActions, proposalKey, rewritten, lastUser.id)
  // 进程内先记「已投」：接纳回调不来时，这就是唯一的幂等依据。
  markHumanServed(sessionId, lastUser.id)
  for (const sha of mediaToMark) markMediaServed(sessionId, lastUser.id, sha)
  return { ...decision, messages: rewritten }
}

export function registerInjection(ctx) {
  const disposers = []

  const offPre = ctx.on('agent/pre-step', async (payload, next) => {
    const closure = turnClosure(payload?.agent?.session?.header?.id, payload?.turn)
    const decision = await next()
    // 宿主会在同一轮里对同一条真实用户消息给出两次 enter 决策（0.2.2-rc.1 实测：
    // turn 号成对跳 221→222、223→224）。第二次会重新走一遍召回，候选又全被去重，
    // 结果是 0 条注入的纯空跑，还会把 memoryClock 多推一格。按真实用户消息 id 幂等：
    // 一条消息只投一次；回合回滚时由 state.rollbackInjectionForTurn 清掉标记，真重试仍会重投。
    const stepSessionId = payload?.agent?.session?.header?.id || null
    const stepLastUser = decision?.kind === 'enter' && Array.isArray(decision.messages)
      ? lastRealUser(decision.messages)
      : null
    const stepBinding = stepSessionId
      ? (() => { try { return getSessionBinding(stepSessionId) } catch { return null } })()
      : null
    const duplicateStep = Boolean(
      stepSessionId && stepLastUser?.id && stepBinding?.reinjectPending !== true
      && stepBinding?.lastInjectedUserMessageId === stepLastUser.id && !hasPendingInbound(stepSessionId),
    )
    try {
      const injected = duplicateStep
        ? decision
        : await injectForStep({
            ...payload,
            decision,
            ctx,
            log: (message) => { try { ctx.logger?.warn?.(`dsh-memu-memory: ${message}`) } catch {} },
          })
      if (turnClosure(stepSessionId, payload?.turn) !== closure) {
        for (const [id, proposal] of injectionAdmissions.get(stepSessionId) || []) {
          if (proposal.turn === Number(payload?.turn) && proposal.status === 'proposed') injectionAdmissions.get(stepSessionId).delete(id)
        }
        return decision
      }
      return ensureUnifiedGuide(ctx, payload, injected)
    } catch (error) {
      try { setRecallError(payload?.agent?.session?.header?.id, `injection failed: ${error?.message || error}`) } catch {}
      try { ctx.logger?.warn?.(`dsh-memu-memory: pre-step injection failed (fail-open): ${error?.stack || error}`) } catch {}
      return decision
    }
  }, { prepend: true })
  disposers.push(offPre)

  const offSession = ctx.on('session/event', async (session, event) => {
    // §3.24 —— 宿主会把「请求根本没发出去」的整轮回滚（真机实测：连用户消息都不留在转录里），
    // 插件却已经在"消息交回决策"之后就记了账。不撤销的话 guide / 锚点 / 当日纪念日 / 复提时钟
    // 这类一次性内容再也不投，整段对话只是"记忆像没接上"，一句错都不报。
    // 这一段排在最前且自带 try：不能被后面任何一步抛错带走。判据是转录里到底有没有本轮那几条
    // 注入消息（见 injectionAdmissions）——请求已经带着它们出去过的失败，一律不撤。
    try {
      const eventSessionId = session?.header?.id
      if (event?.type === 'user/message') {
        if (event.data?.role === 'user' && event.data.source?.kind === 'user' && event.data.id) {
          const seen = nativeAdmissions.get(eventSessionId) || new Map()
          seen.set(event.data.id, bodyDigest(event.data))
          while (seen.size > 2048) seen.delete(seen.keys().next().value)
          nativeAdmissions.set(eventSessionId, seen)
          while (nativeAdmissions.size > 128) nativeAdmissions.delete(nativeAdmissions.keys().next().value)
        }
        // 看见自己投出去的那条消息被追加进转录 = 这一轮真的发出去了。
        observeInjectionMessage(eventSessionId, event?.data, message => ctx.logger?.warn?.(`dsh-memu-memory: ${message}`))
        if (event.data?.source?.kind === 'user') {
          // Memory precedes the human in first-step projection. Both have to arrive.
          noteNativeUserMessages(eventSessionId, [event.data], { admitted: true })
          for (const proposal of injectionAdmissions.get(eventSessionId)?.values() || []) {
            if (proposal.status === 'admitted' && proposal.actions?.inbound) finishInbound(eventSessionId,
              proposal.actions.inbound.keys, proposal.memoryClock, { ...proposal.actions.inbound.outcome, admitted: true })
          }
        }
      }
      if (event?.type === 'turn/end') {
        const failedSessionId = eventSessionId
        const turnNumber = event?.data?.turn
        const kind = event?.data?.reason?.kind
        finishInjectionTurn(failedSessionId, turnNumber, kind, message => ctx.logger?.warn?.(`dsh-memu-memory: ${message}`))
        // Compatibility records belong to older paths, not to these proposals.
        if (kind === 'error' || kind === 'aborted') {
          rollbackInjectionForTurn(failedSessionId, turnNumber)
          // 这一轮没发出去：进程内的「已投」也撤掉，真重试时还能重投。
          clearInjectionSeen(failedSessionId)
        }
        else consumeInjectionRollback(failedSessionId, turnNumber)
      }
    } catch (error) {
      try { ctx.logger?.warn?.(`dsh-memu-memory: injection rollback check failed (fail-open): ${error?.message || error}`) } catch {}
    }
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
          clearInjectionSeen(sessionId)
          // The compaction summary drops the plugin's rules message. Flag it so the
          // next turn's first step replaces it even though guideRulesKey still matches.
          if (before) setSessionBinding(sessionId, { guideLost: true })
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
  disposers.push(ctx.on('session/disposed', session => {
    const id = session?.header?.id
    injectionAdmissions.delete(id)
    nativeAdmissions.delete(id)
    turnClosures.delete(id)
    releaseInboundSession(id)
  }))
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
