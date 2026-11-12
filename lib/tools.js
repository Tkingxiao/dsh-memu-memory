import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  privateRemember, privateRecall, privateList, privateUpdate, privateArchive,
  privateUnpin, globalRecall, globalList, bindingFor, peekBinding, sessionIdOf, domainOf, relativeTime,
  isDatedSalientDate,
} from './memory.js'
import { engineStatus, ENGINE_VERSION } from './engine.js'
import { centeredSnippet } from './snippet.js'
import { redactSecrets } from './paths.js'
import { linkEntries, createEntity, listEntities, updateRelationship } from './graph.js'
import { normalizeEntityName } from './private-links.js'
import { autoLinkPrivateMemories } from './private-links.js'
import { getSettings, listLibraries, getLibrary, loadPrivateIndex, loadGlobalIndex, storageHealth, syncActivity } from './state.js'
import { lexiconSearch, lexiconSources } from './lexicon-scope.js'

function text(value) {
  return String(value ?? '')
}

function truncate(value, max = 1600) {
  const s = text(value)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function errorText(error) {
  const message = error?.message || String(error)
  if (error?.code === 'MEMU_ENGINE_NOT_READY') {
    return [
      'MemU 引擎还没就绪（安装中或未安装）。',
      '请到 DSH 设置 → MemU 查看进度，或运行 `npx dsh-memu-memory-setup`。',
    ].join('\n')
  }
  if (error?.code === 'MEMU_COMMAND_FAILED') {
    return `MemU 命令失败：${message}`
  }
  return `dsh-memu-memory error: ${message}`
}

// 词典核心（lib/lexicon.js）按需加载：工具注册面不能被一个
// 尚未落地的模块卡死；集成落地后这里可以改回静态 import。
let lexiconModulePromise = null
function lexiconApi() {
  if (!lexiconModulePromise) {
    lexiconModulePromise = import('./lexicon.js').catch((error) => {
      lexiconModulePromise = null
      throw error
    })
  }
  return lexiconModulePromise
}

// Registration is per-tool fail-open. defineTool compiles the schema the moment it
// is called, and the first throw used to abort registerTools() before a single
// register() ran — so one schema the host DSL rejects silently removed all ten
// tools. The refusal is stored here instead, and memu_status reports it: a
// contained failure still has to leave a signal.
let registrationReport = { attempted: 0, registered: 0, failures: [] }

function toolBase(name, description, parameters, execute, options = {}) {
  registrationReport.attempted += 1
  try {
    return defineTool({
      name,
      description,
      parameters,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      timeoutMs: options.timeoutMs ?? 60_000,
      isConcurrencySafe: options.isConcurrencySafe ?? (() => false),
      async execute(args, exec) {
        try {
          return await execute(args || {}, exec)
        } catch (error) {
          try { exec?.logger?.warn?.(`dsh-memu-memory ${name}: ${error?.stack || error}`) } catch {}
          return errorText(error)
        }
      },
    })
  } catch (error) {
    registrationReport.failures.push({ name, message: String(error?.message || error) })
    return null
  }
}

/**
 * `options.query` is the search that produced this hit. When present the body is
 * cut around the match instead of from the head, so a result explains itself.
 */
// One entry, one date label, one spelling. Recall, the panel and the list are three
// surfaces over the same field, so a date rendered by only two of them reads as
// "this memory has no date" from the third.
function salientTag(entry) {
  if (!entry || !entry.salientDate) return ''
  return isDatedSalientDate(entry.salientDate) ? `date=${entry.salientDate}` : `anniversary=${entry.salientDate}`
}

// 四轴名在展示层就地映射：这是给人读的一行摘要，不是本地化词条。
const EMOTION_LABELS = { joy: '喜', anger: '怒', sorrow: '哀', fear: '惧' }
const EMOTION_AXES_IN_ORDER = ['joy', 'anger', 'sorrow', 'fear']

// 只留够显眼的份额，最多两项：四项全列会把一行标签读成噪声。
function emotionBrief(entry) {
  const emotion = entry.emotion
  if (!emotion || typeof emotion !== 'object') return ''
  const shares = EMOTION_AXES_IN_ORDER
    .map((axis) => ({ axis, share: Number(emotion[axis]) || 0 }))
    .filter((item) => item.share >= 0.05)
    .sort((a, b) => b.share - a.share)
    .slice(0, 2)
  if (!shares.length) return ''
  const parts = shares.map((item) => `${EMOTION_LABELS[item.axis]}${item.share.toFixed(2)}`)
  const dominance = Number(entry.dominance)
  if (Number.isFinite(dominance)) parts.push(`dom${dominance >= 0 ? '+' : ''}${dominance.toFixed(2)}`)
  const arousal = Number(entry.arousal)
  if (Number.isFinite(arousal)) parts.push(`a${arousal.toFixed(2)}`)
  return parts.join(' · ')
}

function formatPrivateItem(item, index, options = {}) {
  const entry = item.entry || {}
  const layer = entry.layer || 'long_term'
  const status = entry.status || 'active'
  const source = entry.source || 'inferred'
  // B7：默认值不逐条重写（guide 已说明缺省口径），非默认 layer/status/source 仍必须输出。
  const flags = [
    layer !== 'long_term' ? `layer=${layer}` : '',
    status !== 'active' ? `status=${status}` : '',
    entry.marginalized ? 'marginalized' : '',
    entry.openLoop ? 'open_loop' : '',
  ].filter(Boolean).join(' ')
  const lines = [`${index}. [${item.name}] ${entry.title || item.description || '(untitled)'}`]
  if (flags) lines.push(`   ${flags}`)
  if (source !== 'inferred') lines.push(`   source=${source}`)
  // Same relative phrasing as the injected block: one memory must not read as
  // "2026-10-20" in a tool result and "8 天前" in the prompt.
  const when = relativeTime(entry.updatedAt || entry.createdAt)
  if (when) lines.push(`   updated=${when}`)
  if (entry.disclosure && entry.disclosure !== 'can_tell') lines.push(`   disclosure=${entry.disclosure}`)
  if (entry.owner && entry.owner !== 'me') lines.push(`   owner=${entry.owner}`)
  // Cross-library recall is read-only: the id is real, but updates/archives
  // still resolve against the bound library. Say where it lives so the model
  // does not treat "unknown memory" as "it was deleted".
  if (options.homeLibraryId && item.libraryId && item.libraryId !== options.homeLibraryId) {
    lines.push(`   library=${item.libraryId}（跨库只读；写入仍落在当前库）`)
  }
  if (entry.visibility && entry.visibility !== 'shared') {
    // 'secret' is a presentation rule, not a lock: it stays out of the prompt and out of
    // automatic recall, but anyone in the same folder can still pull it up on purpose.
    // Saying so is what keeps the model from treating it as a private vault.
    const note = entry.visibility === 'secret'
      ? '（不进提示词、不会自动浮现；同文件夹里主动检索仍可读到，别在正文里复述）'
      : ''
    lines.push(`   visibility=${entry.visibility}${note}`)
  }
  if (entry.peak === true) lines.push('   peak')
  // A dated memory is an appointment, not an anniversary; labelling both the same
  // way made "the test is tomorrow" read like a recurring commemorative date.
  const tag = salientTag(entry)
  if (tag) lines.push(`   ${tag}`)
  // 有构成就讲构成：同一个 valence 可能来自怒，也可能来自哀，一个数字分不出来。
  const brief = emotionBrief(entry)
  if (brief) lines.push(`   emo=${brief}`)
  else if (typeof entry.moodValence === 'number' && entry.moodValence !== 0) lines.push(`   mood=${entry.moodValence.toFixed(2)}`)
  if (item.content) {
    const body = options.query
      ? centeredSnippet(item.content, options.query)
      : truncate(item.content, 1200)
    lines.push('   ' + body.replace(/\n/g, '\n   '))
  }
  for (const related of item.related || []) lines.push(`   related: [${related.id}] ${related.title} (${related.kind})`)
  for (const image of entry.attachments || []) lines.push(`   image: ${image.sha256} ${image.caption || '[图片]'}${image.missing ? ' [missing]' : ''} (${image.captionBy || 'none'})`)
  return redactSecrets(lines.join('\n'))
}

function formatGlobalItem(item, index, options = {}) {
  const entry = item.entry || {}
  const domain = entry.domain || 'unknown'
  // B7：unknown 域是默认值，省略后模型仍能按 guide 的缺省口径理解；confidence 保留。
  const head = [
    domain !== 'unknown' ? `domain=${domain}` : '',
    entry.confidence !== undefined ? `confidence=${entry.confidence}` : '',
  ].filter(Boolean).join(' ')
  const lines = [`${index}. [${item.name}] ${entry.title || item.description || '(untitled)'}`]
  if (head) lines.push(`   ${head}`)
  const when = relativeTime(entry.updatedAt || entry.createdAt)
  if (when) lines.push(`   updated=${when}`)
  if (Array.isArray(entry.appliesTo) && entry.appliesTo.length > 0) lines.push(`   applies_to=${entry.appliesTo.join(',')}`)
  if (item.content) {
    const body = options.query
      ? centeredSnippet(item.content, options.query)
      : truncate(item.content, 1200)
    lines.push('   ' + body.replace(/\n/g, '\n   '))
  }
  return redactSecrets(lines.join('\n'))
}

/**
 * 1.3.1：单条 remember 与批量 remember_batch 共用同一套参数映射，避免两处字段漂移。
 * 批量工具把重复率最高的公共字段放在 defaults 里，每条 item 只补差异字段。
 */
async function rememberFromArgs(exec, args = {}) {
  return privateRemember({
    exec,
    content: args.content,
    title: args.title,
    layer: args.layer,
    track: args.track,
    attachments: args.attachments,
    context: args.context,
    pinReason: args.pin_reason,
    pinSource: args.pin_source,
    sideEventId: args.side_event_id,
    tags: args.tags,
    openLoop: args.open_loop,
    commitment: args.commitment,
    factKey: args.fact_key ?? null,
    conflictsWith: args.conflicts_with ?? null,
    supersedes: args.supersedes ?? null,
    disclosure: args.disclosure,
    owner: args.owner,
    visibility: args.visibility,
    source: args.source,
    sourceKind: args.source_kind,
    speakerId: args.speaker_id ?? null,
    quoteSpan: args.quote_span ?? null,
    storylineId: args.storyline_id,
    branchId: args.branch_id,
    knownBy: args.known_by,
    confidence: args.confidence,
    moodValence: args.mood_valence ?? null,
    arousal: args.arousal ?? null,
    emotion: args.emotion,
    dominance: args.dominance ?? null,
    peak: args.peak === true,
    salientDate: args.salient_date ?? null,
    observedAt: args.observed_at ?? null,
    absoluteDate: args.absolute_date ?? null,
    validFrom: args.valid_from,
    validTo: args.valid_to,
    datePrecision: args.date_precision,
    allowDuplicate: args.allow_duplicate === true,
  })
}

/** 把 privateRemember 的结果压成 worker 能直接读的一行/一段；去重与冲突必须显式说。 */
function describeRememberResult(result, label = '') {
  const prefix = label ? label + ': ' : ''
  if (result?.deduped === true) {
    return `${prefix}未写入：库内已有几乎相同的记忆 [${result.existingId}]（相似度 ${(Number(result.similarity) || 0).toFixed(2)}）；要补充请用 memu_private_update id=${result.existingId}。`
  }
  const entry = result?.entry
  if (result?.conflict) {
    return `${prefix}已记录但与 [${result.conflict}] 冲突，进入待复核（id=${entry?.id}）；复核前不会出现在召回或注入里。`
  }
  return `${prefix}已写入私有记忆：${result?.id} · layer=${entry?.layer || 'long_term'} · title=${entry?.title || ''}`
}

async function rememberOneOutcome(exec, args) {
  try {
    const result = await rememberFromArgs(exec, args)
    return { ok: true, result, text: describeRememberResult(result) }
  } catch (error) {
    return { ok: false, text: '未写入：' + errorText(error).replace(/\n/g, ' ') }
  }
}


export function registerTools(ctx, { only = null } = {}) {
  const tools = []
  // 全量注册（宿主装载）才更新全局 registrationReport：整理 worker 的按需挂载
  // （private.js attachWorkerTools，only=worker 读写面）不能把 memu_status 的注册清单
  // 覆盖成 4/4，否则其它会话看到的是 worker 的子集，可观测性就断了。
  const reportSaved = only ? registrationReport : null
  if (!only) registrationReport = { attempted: 0, registered: 0, failures: [] }
  tools.push(toolBase(
    'memu_private_link',
    'Connect two existing memories or a memory and an existing entity in the bound library. kind is relation, commitment, event, person or conflict. Requires an evidence note of 8-500 characters; confidence defaults to 0.7. This is also the adjudication tool for memu_private_link_suggest candidates: link a pair only when the note cites concrete evidence of the same entity or event, and pass entity {name, kind} to create or reuse that named entity. Cannot delete links or cross conversation visibility boundaries.',
    {
      from: { type: 'string', description: 'Exact source memory id; required unless updating a relationship snapshot.' },
      to: { type: 'string', description: 'Exact target memory or entity id; required unless entity or relationship is supplied.' },
      kind: { type: 'string', description: 'relation, commitment, event, person or conflict; required when linking.' },
      note: { type: 'string', required: true, description: '8-500 character reason grounded in the conversation, not a guess. For a memu_private_link_suggest candidate, quote the transcript line that proves the same entity or event.' },
      confidence: { type: 'number', description: '0-1 confidence, default 0.7.' },
      entity: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string' } }, additionalProperties: true, description: 'Optional named entity to create and link to instead of to; an entity with the same normalized name is reused (case/width-insensitive). Use only an explicit identity, never infer a person from an ambiguous pronoun.' },
      relationship: { type: 'object', properties: {
        fromEntity: { type: 'string' }, toEntity: { type: 'string' },
        evidenceIds: { type: 'array', items: { type: 'string' } },
        state: { type: 'object', properties: { trust: { type: 'number' }, warmth: { type: 'number' }, familiarity: { type: 'number' },
          boundaries: { type: 'array', items: { type: 'string' } }, callbacks: { type: 'array', items: { type: 'string' } }, openPromises: { type: 'array', items: { type: 'string' } } }, additionalProperties: true },
      }, additionalProperties: true, description: 'Optional complete relationship snapshot between two existing entities, with 1-20 visible evidenceIds. Unknown dimensions stay null. Never infer affection from turn counts; preserve boundaries and concrete promises.' },
    },
    (args, exec) => {
      if (args.relationship) {
        const relation = args.relationship
        const updated = updateRelationship({ exec, fromId: relation.fromEntity, toId: relation.toEntity, state: relation.state, evidenceIds: relation.evidenceIds, reason: args.note })
        const r = updated?.relationship || updated || {}
        // 完整 history（≤50 版）不进模型上下文：只回一行，需要细节时再查。
        return `已更新关系 ${r.fromId ?? relation.fromEntity}→${r.toId ?? relation.toEntity} · revision ${r.revision ?? '?'} · evidence ${Array.isArray(r.evidenceIds) ? r.evidenceIds.length : 0}`
      }
      let toId = args.to
      if (args.entity) {
        const name = String(args.entity.name || '').trim()
        const kind = args.entity.kind || 'person'
        const normalized = normalizeEntityName(name)
        const existing = listEntities({ exec }).items.find((item) => normalizeEntityName(item.name) === normalized
          || (Array.isArray(item.aliases) && item.aliases.some((alias) => normalizeEntityName(alias) === normalized)))
        if (existing) {
          if (existing.kind !== kind) throw new Error(`entity "${name}" already exists as ${existing.kind}; use that kind instead of ${kind}`)
          toId = existing.id
        } else {
          // worker 显式点名只创建实体与一条非 auto 边，不等于确认：
          // allowWorkerAssertion 在 v3 是预留开关，确认仍由用户完成。
          toId = createEntity({ exec, name, kind, status: 'provisional', origin: 'worker' }).id
        }
      }
      return JSON.stringify(linkEntries({ exec, fromId: args.from, toId, kind: args.kind, note: args.note, confidence: args.confidence }))
    },
  ))

  tools.push(toolBase(
    'memu_private_link_suggest',
    'Local algorithm pass over the memories this consolidation just wrote. It refreshes only deterministic evidence edges (mentions of confirmed entities, conflicts_with / supersedes / same fact_key) and returns uncertain statistical pairs for you to adjudicate with memu_private_link. Similarity and shared tokens never create an edge. Call it once after writing, with the ids you created or updated; it needs no extra transcript read and never returns full memory bodies.',
    {
      ids: {
        type: 'array',
        items: { type: 'string' },
        // 宿主 schema DSL 不允许在数组节点上写 required（与 tags/aliases 同），
        // 所以"必填"由描述 + 运行时校验表达，schema 面只能标成可选。
        description: 'Required: ids created or updated in this consolidation, 1-20. Only the entries this run touched need to be listed.',
      },
    },
    async (args, exec) => {
      // Read-only for the binding itself: an unbound chat gets an answer, not a library.
      const binding = peekBinding(exec)
      if (!binding?.libraryId) return '当前对话没有绑定记忆库，无法计算私有自动关联候选。'
      const ids = (Array.isArray(args.ids) ? args.ids : [])
        .map((id) => String(id ?? '').trim())
        .filter(Boolean)
        .slice(0, 20)
      if (!ids.length) return '没有可关联的 id：请传本轮创建/更新的记忆 id（1-20 个）。'
      const result = await autoLinkPrivateMemories({
        libraryId: binding.libraryId,
        sessionId: sessionIdOf(exec),
        ids,
      })
      // Compact contract: what was already linked, then the uncertain pairs. A run
      // with no candidates still reports autoLinked so "nothing applied" and
      // "nothing needed" stay distinguishable.
      return JSON.stringify({ autoLinked: result.autoLinked || [], candidates: result.candidates || [] })
    },
    { isConcurrencySafe: () => false, timeoutMs: 120_000 },
  ))

  tools.push(toolBase(
    'memu_private_remember',
    'Write one durable private memory. Match the domain; never copy a transcript or invent evidence. layer=must_remember requires pin_reason and pin_source.',
    {
      content: { type: 'string', required: true, description: 'Self-contained 50-170 char body: people, place, time, event, exact words. Coding keeps conclusion and verification; RP keeps evidenced moments, no invented facts.' },
      title: { type: 'string', description: '8-40 chars naming the concrete fact; title is a permanent index, the anchor shows only titles WITHOUT the body. No empty labels. Defaults to content.' },
      layer: { type: 'string', description: 'long_term (default), short_term, must_remember. short_term expires unless promoted.' },
      pin_reason: { type: 'string', description: 'Required for must_remember; first-person reason.' },
      pin_source: { type: 'string', description: 'user_explicit, side_event, or self.' },
      side_event_id: { type: 'string', description: 'Required when pin_source=side_event.' },
      fact_key: { type: 'string', description: 'Optional stable key. Reusing it marks another version of the same fact (conflict pair unless supersedes).' },
      conflicts_with: { type: 'string', description: 'Existing memory id with a different version of the same fact; both stay active and recall together.' },
      supersedes: { type: 'string', description: 'Existing memory id this explicitly replaces; old text stays but is retired.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
      open_loop: { type: 'boolean', description: 'Unfinished promise/task; prefer commitment.' },
      commitment: {
        type: 'object',
        properties: {
          counterparty: { type: 'string' },
          action: { type: 'string' },
          due_at: { type: 'string' },
          status: { type: 'string' },
          closed_by: { type: 'string' },
          evidence_seq: { type: 'integer' },
        },
        additionalProperties: false,
        description: 'Promise: counterparty, action, due_at (YYYY-MM-DD/ISO), status (open/done/cancelled/expired), closed_by/evidence_seq.',
      },
      disclosure: { type: 'string', description: 'can_tell, only_if_asked, never_say.' },
      owner: { type: 'string', description: 'me, us, about_user, about_project.' },
      visibility: { type: 'string', description: 'shared (default) or secret (no automatic injection/recall).' },
      source: {
        type: 'string',
        description: 'inferred (default), user_said (quotable), assistant_said, imagined, told, tool.',
      },
      source_kind: { type: 'string', description: 'Same values as source; assistant promises/plans must not be user_said.' },
      speaker_id: { type: 'string', description: 'user, assistant, character:<id>, group:<id>; never infer from a name.' },
      quote_span: {
        type: 'object',
        properties: { seq: { type: 'integer' }, turn: { type: 'integer' }, textHash: { type: 'string' } },
        additionalProperties: false,
        description: 'Optional source pointer; do not paste the whole quote.',
      },
      storyline_id: { type: 'string', description: 'Optional storyline id.' },
      branch_id: { type: 'string', description: 'Optional branch id.' },
      known_by: { type: 'array', items: { type: 'string' }, description: 'Character ids that know this fact.' },
      confidence: { type: 'number', description: '0-1; below 0.45 is injected as a hedge.' },
      mood_valence: { type: 'number', description: '-1..1; omit to inherit the conversation reading.' },
      arousal: { type: 'number', description: '0-1 intensity.' },
      emotion: {
        type: 'object',
        properties: { joy: { type: 'number' }, anger: { type: 'number' }, sorrow: { type: 'number' }, fear: { type: 'number' } },
        // 四个轴是封闭集合：多写的键只会被误当成第五种情绪。
        additionalProperties: false,
        description: 'joy/anger/sorrow/fear for the remembered event, not the consolidation mood. Omit to inherit; all-zero is neutral.',
      },
      dominance: { type: 'number', description: '-1..1; omit to inherit.' },
      peak: { type: 'boolean', description: 'High/low point of the arc.' },
      allow_duplicate: { type: 'boolean', description: 'Only for a genuinely independent second observation; default false refuses near-duplicates.' },
      salient_date: { type: 'string', description: 'MM-DD for yearly recurrence; YYYY-MM-DD for a one-off appointment. Resolve 今天/明天/下周 to the absolute date; never send a bare MM-DD for a one-off.' },
      observed_at: { type: 'string', description: 'ISO scene time of this statement; relative dates resolve against it, never the wall clock. Omit to use the conversation sceneTime.' },
      absolute_date: { type: 'string', description: 'YYYY-MM-DD this fact is about; omit to let the plugin resolve observed_at + relative wording.' },
      valid_from: { type: 'string', description: 'Optional YYYY-MM-DD when the fact starts.' },
      valid_to: { type: 'string', description: 'Optional YYYY-MM-DD after which it no longer holds.' },
      date_precision: { type: 'string', description: 'day, month, year, or unknown.' },
      track: { type: 'string', description: 'memory (default) or habit (aggregated repeated expression).' },
      attachments: { type: 'array', items: { type: 'object', properties: { sha256: { type: 'string', required: true } }, additionalProperties: true }, description: 'At most 8 sha256 refs received in this conversation; never paths or bytes.' },
      context: { type: 'object', properties: {
        speakerId: { type: 'string' }, channelId: { type: 'string' }, characterId: { type: 'string' }, worldId: { type: 'string' }, branchId: { type: 'string' },
        knownBy: { type: 'array', items: { type: 'string' } }, occurredAt: { type: 'string' },
      }, additionalProperties: true, description: 'Stable identities only; scope inherits the conversation and cannot widen it.' },
    },
    async (args, exec) => {
      // D4：与 remember_batch 共用同一套参数映射，避免两处字段漂移。
      const result = await rememberFromArgs(exec, args)
      // 事实级去重：几乎相同的重写被拒，返回的是
      // { deduped, existingId, hint }，没有 entry——必须先接住，否则 result.entry.layer 抛错。
      if (result.deduped === true) {
        return [
          `未写入：库内已有几乎相同的记忆 [${result.existingId}]（相似度 ${(Number(result.similarity) || 0).toFixed(2)}）。`,
          `要补充内容请改用 memu_private_update 传该 id 合并；若确属两次独立观测，带 allow_duplicate=true 重写。`,
        ].join('\n')
      }
      const entry = result.entry
      if (result.conflict) {
        // The entry is held (pending_review): it is stored, but excluded from
        // recall and injection until the review is accepted. Saying just "已写入"
        // here taught the model to rely on a memory it can never retrieve.
        return [
          `已记录但与现有记忆 [${result.conflict}] 冲突，进入待复核（pending_review）。`,
          `复核接受之前它不会出现在召回或注入里；如需要可查看复核队列并裁决。`,
          `layer=${entry.layer} title=${entry.title}`,
        ].join('\n')
      }
      return [
        `已写入私有记忆：${result.id}`,
        `layer=${entry.layer} title=${entry.title}`,
        entry.expiresAt ? `expires_at=${entry.expiresAt}（到期前用 memu_private_update layer=long_term 可升级）` : '',
        entry.pinReason ? `pin_reason=${entry.pinReason}` : '',
      ].filter(Boolean).join('\n')
    },
    { timeoutMs: 180_000 },
  ))

  tools.push(toolBase(
    'memu_private_remember_batch',
    'Write several private memories in one call. Put shared fields in defaults and only per-item differences in items; each item is one fact. Use this instead of calling memu_private_remember once per entry. Items that dedupe or conflict are reported per line.',
    {
      defaults: {
        type: 'object',
        properties: {
          speaker_id: { type: 'string' },
          source_kind: { type: 'string' },
          source: { type: 'string' },
          owner: { type: 'string' },
          confidence: { type: 'number' },
          observed_at: { type: 'string' },
          absolute_date: { type: 'string' },
          date_precision: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          layer: { type: 'string' },
        },
        additionalProperties: true,
        description: 'Shared fields for every item; per-item values override these.',
      },
      items: {
        type: 'array',
        description: '1-8 facts. Each item needs title + content; only include fields that differ from defaults.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', required: true },
            content: { type: 'string', required: true },
            observed_at: { type: 'string' },
            absolute_date: { type: 'string' },
            date_precision: { type: 'string' },
            speaker_id: { type: 'string' },
            source_kind: { type: 'string' },
            source: { type: 'string' },
            owner: { type: 'string' },
            confidence: { type: 'number' },
            tags: { type: 'array', items: { type: 'string' } },
            emotion: {
              type: 'object',
              properties: { joy: { type: 'number' }, anger: { type: 'number' }, sorrow: { type: 'number' }, fear: { type: 'number' } },
              additionalProperties: false,
            },
            commitment: { type: 'object', additionalProperties: true },
            conflicts_with: { type: 'string' },
            salient_date: { type: 'string' },
            open_loop: { type: 'boolean' },
            layer: { type: 'string' },
          },
          additionalProperties: true,
        },
      },
    },
    async (args, exec) => {
      const defaults = args?.defaults && typeof args.defaults === 'object' ? args.defaults : {}
      const items = Array.isArray(args?.items) ? args.items.slice(0, 8) : []
      if (items.length === 0) return '未写入：items 为空；每条至少需要 title 和 content。'
      const lines = []
      let written = 0
      let deduped = 0
      let held = 0
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]
        if (!item || typeof item !== 'object') {
          lines.push(`${index + 1}. 未写入：item 不是对象`)
          continue
        }
        const outcome = await rememberOneOutcome(exec, { ...defaults, ...item })
        lines.push(`${index + 1}. ${outcome.text}`)
        if (!outcome.ok) continue
        if (outcome.result?.deduped === true) deduped += 1
        else if (outcome.result?.entry?.status === 'pending_review' || outcome.result?.conflict) held += 1
        else written += 1
      }
      return [`批量写入完成：新增 ${written} · 去重 ${deduped} · 待复核 ${held}`, ...lines].join('\n')
    },
    { timeoutMs: 300_000 },
  ))

  tools.push(toolBase(
    'memu_private_recall',
    'Retrieve relevant private memories from the library bound to this conversation. Use it when the user refers to something from before, asks you to remember, or the current task may depend on earlier context.',
    {
      query: { type: 'string', required: true, description: 'Natural-language query.' },
      topK: { type: 'integer', description: 'Max entries; default from settings.' },
    },
    async (args, exec) => {
      const result = await privateRecall({ exec, query: args.query, topK: args.topK })
      // Surface a degraded semantic leg on the explicit tool path too; silently
      // returning fewer hits would make a failed backend look like an empty library.
      const warning = (result.errors || []).length ? `\n注意：本次召回已降级：${(result.errors || []).join('; ')}` : ''
      // Read-only: never materialize a binding/library from a recall header.
      const binding = peekBinding(exec)
      const foreign = (result.libraries || []).filter((id) => id !== binding?.libraryId)
      const header = `私有记忆（library=${binding?.libraryId || '?'}, domain=${domainOf(binding)}${foreign.length ? `，跨库=${foreign.join(',')}` : ''}）`
      if (!result.files?.length) return `${header}\n没有命中。${warning}`
      return [header, ...result.files.map((f, i) => formatPrivateItem(f, i + 1, { query: args.query, homeLibraryId: binding?.libraryId || null }))].join('\n\n') + warning
    },
    { isConcurrencySafe: () => true },
  ))

  tools.push(toolBase(
    'memu_private_list',
    'List private memory metadata for the library bound to this conversation. When cross-library recall is on, same-domain libraries are included too. Does not return full bodies. Paged: default 50 rows, use offset to continue.',
    {
      limit: { type: 'number', description: 'Rows in this page; default 50, max 200.' },
      offset: { type: 'number', description: '0-based row offset; for the next page pass the last returned offset + count.' },
    },
    async (args, exec) => {
      // A list is a pure read: if the conversation has no binding yet, say so
      // instead of ensureSession() silently creating a placeholder library.
      if (!peekBinding(exec)?.libraryId) return '当前对话没有绑定记忆库。'
      const limit = Math.min(200, Math.max(1, Math.floor(Number(args?.limit) || 50)))
      const offset = Math.max(0, Math.floor(Number(args?.offset) || 0))
      const result = await privateList({ exec, limit, offset })
      const warning = result.warning ? `\n注意：${result.warning}` : ''
      const foreign = (result.libraries || []).filter((library) => library.id !== result.libraryId)
      const scopeNote = foreign.length ? `，跨库=${foreign.map((library) => library.name || library.id).join(',')}` : ''
      const total = Number.isFinite(result.total) ? result.total : (result.files?.length || 0)
      if (!total) return `私有记忆库 ${result.libraryId} 为空${scopeNote}。${warning}`
      const pageEnd = offset + (result.files?.length || 0)
      const lines = [`私有记忆库 ${result.libraryId}（共 ${total} 条，本页 ${offset + 1}-${pageEnd}${scopeNote}）`]
      for (const file of result.files) {
        const e = file.entry || {}
        const tag = salientTag(e)
        const owner = file.libraryId && file.libraryId !== result.libraryId
          ? ` · lib=${file.libraryName || file.libraryId}`
          : ''
        lines.push(`- [${file.name}] ${e.title || file.description || '(untitled)'} · ${e.layer || 'long_term'} · ${e.status || 'active'}${e.marginalized ? ' · marginalized' : ''}${tag ? ` · ${tag}` : ''}${owner}`)
      }
      const more = pageEnd < total ? `\n还有 ${total - pageEnd} 条：用 offset=${pageEnd} 继续。` : ''
      return redactSecrets(lines.join('\n')) + more + warning
    },
    { isConcurrencySafe: () => true },
  ))

  tools.push(toolBase(
    'memu_private_update',
    'Update a private memory. Content changes rewrite the stored body; metadata-only changes stay local. Rewrite the title when the new body no longer fits it.',
    {
      id: { type: 'string', required: true, description: 'Memory id.' },
      content: { type: 'string', description: 'New 50-170 char body.' },
      title: { type: 'string', description: '8-40 chars naming the concrete fact; title is a permanent index, the anchor shows only titles WITHOUT the body. No empty labels. Omit to keep.' },
      tags: { type: 'array', items: { type: 'string' } },
      status: { type: 'string', description: 'active, archived, fragment, suppressed, expired.' },
      layer: { type: 'string', description: 'long_term (promote), short_term (re-arm expiry); must_remember only via remember.' },
      open_loop: { type: 'boolean' },
      commitment: {
        type: 'object',
        properties: {
          counterparty: { type: 'string' },
          action: { type: 'string' },
          due_at: { type: 'string' },
          status: { type: 'string' },
          closed_by: { type: 'string' },
          evidence_seq: { type: 'integer' },
        },
        additionalProperties: false,
        description: 'Replace commitment; status=done/cancelled/expired closes it.',
      },
      disclosure: { type: 'string', description: 'can_tell, only_if_asked, never_say.' },
      owner: { type: 'string', description: 'me, us, about_user, about_project.' },
      visibility: { type: 'string', description: 'shared or secret.' },
      confidence: { type: 'number' },
      // Provenance and track are claims about what a memory *is*; both were writable
      // in memory.js and the panel while staying unreachable from the tool surface,
      // so the agent could file a quote as an inference and never correct it.
      source: { type: 'string', description: 'user_said, assistant_said, told, imagined, inferred, tool.' },
      source_kind: { type: 'string', description: 'Same values as source; keep in sync.' },
      speaker_id: { type: 'string', description: 'user, assistant, character:<id>, group:<id>; empty clears.' },
      quote_span: { type: 'object', properties: { seq: { type: 'integer' }, turn: { type: 'integer' }, textHash: { type: 'string' } }, additionalProperties: false, description: 'Source pointer; omit to keep, null to clear.' },
      storyline_id: { type: 'string', description: 'Storyline id; empty clears.' },
      branch_id: { type: 'string', description: 'Branch id; empty clears.' },
      known_by: { type: 'array', items: { type: 'string' }, description: 'Character ids; empty clears.' },
      track: { type: 'string', description: 'memory or habit.' },
      peak: { type: 'boolean', description: 'Flashbulb flag.' },
      mood_valence: { type: 'number', description: '-1..1 retrieval lens; omit keeps.' },
      arousal: { type: 'number', description: '0..1 retrieval lens; omit keeps.' },
      emotion: {
        type: 'object',
        properties: { joy: { type: 'number' }, anger: { type: 'number' }, sorrow: { type: 'number' }, fear: { type: 'number' } },
        additionalProperties: false,
        description: 'Omit keeps; null clears; object replaces after normalisation. Event feeling, not current mood.',
      },
      dominance: { type: 'number', description: '-1..1; omit keeps.' },
      salient_date: { type: 'string', description: 'MM-DD yearly or YYYY-MM-DD one-off; empty clears.' },
      observed_at: { type: 'string', description: 'ISO scene time for this edit; omit uses conversation sceneTime.' },
      absolute_date: { type: 'string', description: 'YYYY-MM-DD; omit re-derives, empty clears.' },
      valid_from: { type: 'string', description: 'YYYY-MM-DD start; empty clears.' },
      valid_to: { type: 'string', description: 'YYYY-MM-DD end; empty clears.' },
    },
    async (args, exec) => {
      const result = await privateUpdate({
        exec, id: args.id, content: args.content, title: args.title, tags: args.tags,
        status: args.status, openLoop: args.open_loop, commitment: args.commitment, disclosure: args.disclosure, confidence: args.confidence,
        layer: args.layer, owner: args.owner, visibility: args.visibility,
        source: args.source, track: args.track, peak: args.peak,
        sourceKind: args.source_kind, speakerId: args.speaker_id,
        quoteSpan: args.quote_span, storylineId: args.storyline_id,
        branchId: args.branch_id, knownBy: args.known_by,
        moodValence: args.mood_valence, arousal: args.arousal,
        // undefined 就是"省略"，必须原样传下去；换成 null 会把保留变成清除。
        emotion: args.emotion, dominance: args.dominance,
        // Sentinel: absent means "leave the date as it is", '' means "clear it".
        salientDate: args.salient_date,
        observedAt: args.observed_at,
        absoluteDate: args.absolute_date,
        validFrom: args.valid_from,
        validTo: args.valid_to,
      })
      return `已更新 ${result.id}: ${result.entry.title} (${result.entry.layer}, ${result.entry.status})`
    },
    { timeoutMs: 180_000 },
  ))

  tools.push(toolBase(
    'memu_private_archive',
    'Archive a private memory. It stays in the library but is filtered out of normal retrieval.',
    { id: { type: 'string', required: true } },
    async (args, exec) => {
      const result = privateArchive({ exec, id: args.id })
      return `已归档 ${result.id}。`
    },
  ))

  tools.push(toolBase(
    'memu_private_unpin',
    'Move a must_remember memory back to long_term as marginalized when its constraint or lasting significance has genuinely changed. Requires a first-person reason of at least 20 characters with evidence of that change; no invented emotional event is needed. Per-conversation quota and cooldown apply. Do not unpin effective constraints just for space or age.',
    {
      id: { type: 'string', required: true },
      reason: { type: 'string', required: true, description: 'First-person reason for letting it go.' },
    },
    async (args, exec) => {
      const result = privateUnpin({ exec, id: args.id, reason: args.reason })
      return `已移出永久记忆并边缘化：${result.id}\n${result.entry.marginalReason}`
    },
  ))

  tools.push(toolBase(
    'memu_lexicon_search',
    'Search the ACTIVE lexicon (user-coined slang, memes, triggers and terms) this conversation can see: the bound library plus the global lexicon, and — when cross-library recall is on — other same-domain libraries; archived entries are excluded. Read-only. When a user-coined word or phrase appears and you are not sure what it means, look it up here before asking or guessing; returns term → meaning/usage with short evidence. Hits from outside the bound library are read-only: writing still lands in the bound library.',
    {
      query: { type: 'string', required: true, description: 'The word or phrase to look up. Exact term/alias match first with a bounded fuzzy fallback; short queries work best.' },
    },
    async (args, exec) => {
      // Read-only: never materialize a binding or a library from a lexicon query,
      // same rule as memu_private_recall.
      const binding = peekBinding(exec)
      if (!binding?.libraryId) return '当前对话没有绑定记忆库，无法查询词典。请先初始化或绑定记忆库。'
      const { items, errors } = lexiconSearch(binding, String(args.query || ''))
      const warning = errors.length ? `\n注意：本次词典查询已降级：${errors.join('; ')}` : ''
      // 作用域头：当前库 + 全局（+ 开关打开时的同域库）。同词面只留优先级最高的一份
      // （lexicon-scope 的源序：当前库 → 同域库 → 全局）。
      const foreign = lexiconSources(binding).filter((source) => !source.primary && source.scope === 'private')
      const scopeSuffix = foreign.length ? `，跨库=${foreign.map((source) => source.name || source.libraryId).join(',')}` : ''
      const scopeLabel = `library=${binding.libraryId} + 全局${scopeSuffix}`
      if (!items.length) return `词典（${scopeLabel}）没有命中「${truncate(args.query, 80)}」。${warning}`
      const lines = [`词典命中（${scopeLabel}，${items.length} 条）`]
      for (const [index, hit] of items.entries()) {
        const e = hit?.entry && typeof hit.entry === 'object' ? hit.entry : hit
        const evidence = (Array.isArray(e.evidence) ? e.evidence : []).slice(0, 2)
          .map((item) => String(item?.quote || item?.id || '')).filter(Boolean).join(' / ')
        const home = hit.lexiconScope === 'global'
          ? '   home=全局词典（只读；写入仍落在当前库）'
          : hit.libraryId && hit.libraryId !== binding.libraryId
            ? `   home=${hit.libraryName || hit.libraryId}（跨库只读；写入仍落在当前库）`
            : ''
        lines.push([
          `${index + 1}. [${e.term || '?'}] kind=${e.kind || 'term'} status=${e.status || 'active'}`,
          home,
          `   meaning=${truncate(e.meaning, 300)}`,
          e.usage ? `   usage=${truncate(e.usage, 200)}` : '',
          evidence ? `   evidence=${truncate(evidence, 200)}` : '',
        ].filter(Boolean).join('\n'))
      }
      return redactSecrets(lines.join('\n')) + warning
    },
    { isConcurrencySafe: () => true },
  ))

  tools.push(toolBase(
    'memu_lexicon_propose',
    'Write one lexicon entry (slang / meme / term) for the library bound to this conversation. The entry becomes ACTIVE immediately: there is no pending state and no human review, and it is injected from the next turn. term is the index key, meaning is the explanation. Search first with memu_lexicon_search and propose only what this conversation evidences, one entry per term. Sensitive triggers cannot be created or updated by the model — those stay user-managed. There is no lexicon delete from the model side.',
    {
      term: { type: 'string', required: true, description: 'The index key / title of the entry: short, stable, spelled the way the user actually writes it (normally 1-12 characters, at most a short phrase). Not a sentence and not the explanation — that goes in meaning.' },
      kind: { type: 'string', required: true, description: 'slang, meme, trigger, or term. trigger is rejected here: sensitive triggers are user-managed.' },
      meaning: { type: 'string', required: true, description: 'The explanation of term: what it means in this library, in one or two sentences.' },
      usage: { type: 'string', description: 'When or how the word is used.' },
      aliases: { type: 'array', items: { type: 'string' }, description: 'Alternative spellings or short forms, at most 20.' },
      examples: { type: 'array', items: { type: 'string' }, description: 'Short real quotes from this conversation showing the usage, at most 8. Never invent quotes.' },
      evidence: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, id: { type: 'string' }, quote: { type: 'string' } }, additionalProperties: true }, description: 'Where the meaning came from: short quotes with stable ids only, no full transcripts.' },
      confidence: { type: 'number', description: '0-1; how sure you are of the meaning. Use it honestly — it sets the entry display strength.' },
    },
    async (args, exec) => {
      const binding = peekBinding(exec)
      if (!binding?.libraryId) return '当前对话没有绑定记忆库，无法写入词条。请先初始化或绑定记忆库。'
      const lexicon = await lexiconApi()
      let result
      try {
        result = await lexicon.upsertLexiconTerm({
          libraryId: binding.libraryId,
          term: args.term,
          kind: args.kind,
          meaning: args.meaning,
          usage: args.usage,
          aliases: args.aliases,
          examples: args.examples,
          // 词条继承当前会话的场景身份；没有场景就是空 context（全场景可见）。
          context: binding.memoryContext || {},
          // 领域戳：跨库召回判「同域」靠它（§8.15），与 privateRemember 同一口径。
          domain: domainOf(binding),
          evidence: args.evidence,
          confidence: args.confidence,
          // 来源固定 model-proposal；普通词条直接 active（§2.1），sensitive trigger 由
          // 核心层 typed 拒绝。
          source: 'model-proposal',
        })
      } catch (error) {
        // typed rejection 翻译：sensitive trigger 不允许模型写入是核心层的硬规则，
        // 原始错误码对模型没有行动价值，翻成"该让用户做什么"。
        const code = String(error?.code || '')
        const message = String(error?.message || error)
        if (/sensitive/i.test(code) || (/sensitive/i.test(message) && /trigger/i.test(message))) {
          return '未写入：sensitive trigger 不能由模型写入或修改。这类触发词请让用户在词典页手动添加。'
        }
        throw error
      }
      // 核心返回 { term: 词条对象(含 termId), created, notOwned? }。
      const termLabel = result?.term && typeof result.term === 'object' ? String(result.term.term || args.term) : String(result?.term || args.term)
      if (result?.created === false) {
        // 没新建：要么词条归用户（归档/墓碑/草稿），要么同名 active 词条被原地更新。
        if (result?.notOwned === true) {
          return `未改动：词条「${termLabel}」已归档或归用户管理，模型不能覆盖它。如需恢复或编辑请让用户在词典页操作。`
        }
        return `已更新现有生效词条「${termLabel}」（status=active）；若字段与原来一致则等于没变。sensitive trigger 只能由用户手动管理。`
      }
      return [
        `已写入词条「${termLabel}」（status=active，下一回合起参与注入）。`,
        '词条已自动生效，无需用户审核；sensitive trigger 只能由用户手动添加。',
      ].join('\n')
    },
  ))

  tools.push(toolBase(
    'memu_global_recall',
    'Retrieve cross-session global memories applicable to the current domain. Global memory is read-only for the main agent.',
    {
      query: { type: 'string', required: true },
      topK: { type: 'integer' },
    },
    async (args, exec) => {
      const result = await globalRecall({ exec, query: args.query, topK: args.topK })
      if (!result.files?.length) return `全局记忆（domain=${result.domain}）没有命中。`
      return [
        `全局记忆（domain=${result.domain}）`,
        ...result.files.map((f, i) => formatGlobalItem(f, i + 1, { query: args.query })),
      ].join('\n\n')
    },
    { isConcurrencySafe: () => true },
  ))

  tools.push(toolBase(
    'memu_global_list',
    'List global memory metadata. Global memory is read-only for the main agent.',
    { domain: { type: 'string', description: 'Optional domain filter.' } },
    async (args, exec) => {
      const result = await globalList({ exec, domain: args.domain })
      if (!result.files?.length) return '全局记忆为空。'
      const lines = [`全局记忆（${result.files.length} 条）`]
      for (const file of result.files) {
        const e = file.entry || {}
        lines.push(`- [${file.name}] ${e.title || file.description || '(untitled)'} · ${e.domain || 'unknown'} · ${e.status || 'active'}`)
      }
      return lines.join('\n')
    },
    { isConcurrencySafe: () => true },
  ))

  tools.push(toolBase(
    'memu_status',
    'Show MemU engine, memory library, session binding, and injection status. Use it when memory is unavailable or the user asks what you remember.',
    {},
    async (_args, exec) => {
      const engine = engineStatus()
      // Status is a read: never let answering "what do you remember" create a
      // binding (and potentially a placeholder library) for an unbound chat.
      const binding = peekBinding(exec)
      const settings = getSettings()
      const libraries = listLibraries()
      const library = binding?.libraryId ? getLibrary(binding.libraryId) : null
      const privateIndex = binding?.libraryId ? loadPrivateIndex(binding.libraryId) : { entries: {} }
      const globalIndex = loadGlobalIndex()
      const pinned = Object.values(privateIndex.entries || {}).filter((e) => e.layer === 'must_remember' && e.status !== 'archived').length
      const activeEntries = Object.values(privateIndex.entries || {}).filter((e) => !['archived', 'suppressed', 'expired'].includes(e.status))
      const shortCount = activeEntries.filter((e) => e.layer === 'short_term').length
      const globalCount = Object.keys(globalIndex.entries || {}).filter((id) => ['active'].includes(globalIndex.entries[id].status || 'active')).length
      const health = storageHealth()
      const storageLines = []
      if (health.issues.length > 0) {
        storageLines.push(`storage: ${health.issues.length} unreadable file(s), writes blocked — ${health.issues.map((i) => `${i.file} (${i.code || i.message})`).join('; ')}`)
      }
      if (health.quarantined.length > 0) {
        storageLines.push(`storage: quarantined copies kept — ${health.quarantined.join(', ')}`)
      }
      const recallLines = binding?.lastRecallError
        ? [`recall: degraded at ${binding.lastRecallErrorAt || '?'} — ${binding.lastRecallError}`]
        : []
      // Separates "nothing was written" from "the panes were never told": a write
      // with no heartbeat means no surface is polling; a heartbeat after a write
      // means the write was visible within one beat.
      const sync = syncActivity()
      const ago = (at) => {
        if (!at) return 'never'
        const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
        if (seconds < 120) return `${seconds}s ago`
        const minutes = Math.round(seconds / 60)
        return minutes < 120 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`
      }
      const write = sync.lastWrite
      const syncLine = `sync: heartbeat ${ago(sync.lastBeatAt)}, last write ${write ? `${write.kind}${write.libraryId ? `@${write.libraryId}` : ''} ${ago(write.at)}` : 'none since startup'}`
      return [
        `engine: ${engine.status} (recommended ${ENGINE_VERSION}, current ${engine.current?.version || 'none'})`,
        `python: ${engine.current?.python || 'none'}`,
        `tools: ${registrationReport.registered}/${registrationReport.attempted} registered${registrationReport.failures.length ? ` (refused: ${registrationReport.failures.map((failure) => failure.name).join(', ')})` : ''}`,
        `session: ${sessionIdOf(exec) || '?'}`,
        `library: ${library ? `${library.name} (${library.id})` : 'none'}`,
        `domain: ${domainOf(binding)}`,
        `useLibrary=${binding?.useLibrary !== false} useGlobal=${binding?.useGlobal !== false} autoInject=${settings.autoInject}`,
        `private: ${activeEntries.length} active, ${pinned}/${settings.mustRememberCap} pinned`,
        `short_term: ${shortCount} active (ttl ${Number(settings.shortTermTtlHours) || 0}h)`,
        `global: ${globalCount} active`,
        `libraries: ${libraries.length}`,
        ...storageLines,
        ...recallLines,
        syncLine,
        binding?.inbound || binding?.lastInboundOutcome ? `inbound: pending=${binding.inbound?.pending?.length || 0}, logical=${binding.inbound?.clock || 0}, last=${binding.lastInboundOutcome?.reason || 'none'}` : '',
        binding?.lastInboundError ? `inbound_error: ${redactSecrets(binding.lastInboundError)}` : '',
        binding?.lastRecallOutcome ? `recall_outcome: ${binding.lastRecallOutcome.reason}, candidates=${binding.lastRecallOutcome.candidateCount}, injected=${binding.lastRecallOutcome.injectedCount}` : '',
        binding?.lastImageCount ? `image_turn: ${binding.lastImageCount} image(s); pending ${(binding.pendingMedia || []).length}` : '',
        engine.status !== 'ready'
          ? 'warning: engine is not ready; run `npx dsh-memu-memory-setup` or open Settings → MemU.'
          : `injection: smart, privateTopK=${settings.privateTopK}, globalTopK=${settings.globalTopK}`,
      ].join('\n')
    },
    { isConcurrencySafe: () => true },
  ))

  // 整理 worker 的挂载面（private.js 的 fork 兼容）：只挂 WORKER_WRITE_TOOLS +
  // WORKER_READ_TOOLS（记忆读写 + 关联裁决/候选 + 词典检索/写入），不把
  // archive/delete/unpin 这些破坏性工具暴露给一个后台子会话。
  const wanted = Array.isArray(only) && only.length > 0 ? only : null
  const usable = tools.filter((tool) => tool && (!wanted || wanted.includes(tool.name)))
  if (only) {
    registrationReport = reportSaved
    if (usable.length !== wanted.length) {
      try {
        ctx?.logger?.warn?.(`dsh-memu-memory: worker tool mount compiled ${usable.length}/${wanted.length}: ${wanted.join(', ')}`)
      } catch {}
    }
  } else {
    registrationReport.registered = usable.length
    if (registrationReport.failures.length > 0) {
      try {
        ctx?.logger?.warn?.(`dsh-memu-memory: host schema DSL refused ${registrationReport.failures.length} of ${registrationReport.attempted} tools: ${registrationReport.failures.map((failure) => `${failure.name} (${failure.message})`).join('; ')}`)
      } catch {}
    }
  }
  // register 这一步也逐件 fail-open（与 toolBase 的编译 fail-open 同一哲学）：宿主
  // 注册表拒一件（重名、scope 锁定）不能掀翻整组挂载——原来的 `.map()` 一件抛错就连
  // 前面已注册成功的 disposer 一起丢掉，在 worker scope 上留下卸不掉的常驻注册。
  const disposers = []
  const attached = []
  const refused = []
  for (const tool of usable) {
    try {
      const dispose = ctx.tools.register(tool)
      disposers.push(typeof dispose === 'function' ? dispose : null)
      attached.push(tool.name)
    } catch (error) {
      refused.push(`${tool.name} (${String(error?.message || error)})`)
      // 全量装载（宿主）才进 registrationReport：memu_status 的 refused 清单要如实反映
      // 编译 + register 两道关都被拒了谁；worker 的按需挂载照旧不碰全局报告。
      if (!only) registrationReport.failures.push({ name: tool.name, message: String(error?.message || error) })
    }
  }
  if (refused.length > 0) {
    if (!only) registrationReport.registered = attached.length
    try {
      ctx?.logger?.warn?.(`dsh-memu-memory: tool mount refused ${refused.length}/${usable.length} at register: ${refused.join('; ')}`)
    } catch {}
  }
  // 返回值仍是可直接调用的 disposer（private.js attachWorkerTools 与宿主装载都这么用），
  // 但附挂结构化名单：attached = 编译 + register 都真正成功的工具名；requested = 请求
  // 名单（宿主全量装载没有 only，为 null）。部分编译/注册失败时调用方据此写活动日志，
  // 不再把 wanted 全量误报成已挂载。
  const disposeAll = () => {
    for (const dispose of disposers) {
      try { dispose?.() } catch {}
    }
  }
  disposeAll.attached = attached
  disposeAll.requested = wanted
  return disposeAll
}
