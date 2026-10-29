import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  privateRemember, privateRecall, privateList, privateUpdate, privateArchive,
  privateUnpin, globalRecall, globalList, bindingFor, peekBinding, sessionIdOf, domainOf, relativeTime,
  isDatedSalientDate,
} from './memory.js'
import { engineStatus, ENGINE_VERSION } from './engine.js'
import { centeredSnippet } from './snippet.js'
import { redactSecrets } from './paths.js'
import { linkEntries, createEntity, updateRelationship } from './graph.js'
import { getSettings, listLibraries, getLibrary, loadPrivateIndex, loadGlobalIndex, storageHealth, syncActivity } from './state.js'

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

function formatPrivateItem(item, index, options = {}) {
  const entry = item.entry || {}
  const lines = [
    `${index}. [${item.name}] ${entry.title || item.description || '(untitled)'}`,
    `   layer=${entry.layer || 'long_term'} status=${entry.status || 'active'}${entry.marginalized ? ' marginalized' : ''}${entry.openLoop ? ' open_loop' : ''}`,
    `   source=${entry.source || 'inferred'}`,
  ]
  // Same relative phrasing as the injected block: one memory must not read as
  // "2026-10-20" in a tool result and "8 天前" in the prompt.
  const when = relativeTime(entry.updatedAt || entry.createdAt)
  if (when) lines.push(`   updated=${when}`)
  if (entry.disclosure && entry.disclosure !== 'can_tell') lines.push(`   disclosure=${entry.disclosure}`)
  if (entry.owner && entry.owner !== 'me') lines.push(`   owner=${entry.owner}`)
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
  if (typeof entry.moodValence === 'number' && entry.moodValence !== 0) lines.push(`   mood=${entry.moodValence.toFixed(2)}`)
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
  const lines = [
    `${index}. [${item.name}] ${entry.title || item.description || '(untitled)'}`,
    `   domain=${entry.domain || 'unknown'} confidence=${entry.confidence ?? '?'}`,
  ]
  const when = relativeTime(entry.updatedAt || entry.createdAt)
  if (when) lines.push(`   updated=${when}`)
  if (Array.isArray(entry.appliesTo) && entry.appliesTo.length > 0) lines.push(`   applies_to=${entry.appliesTo.join(',')}`)
  if (item.content) {
    const body = options.query
      ? centeredSnippet(item.content, options.query)
      : truncate(item.content, 1200)
    lines.push('   ' + body.replace(/\n/g, '\n   '))
  }
  return lines.join('\n')
}

export function registerTools(ctx) {
  const tools = []
  registrationReport = { attempted: 0, registered: 0, failures: [] }
  tools.push(toolBase(
    'memu_private_link',
    'Connect two existing memories or a memory and an existing entity in the bound library. kind is relation, commitment, event, person or conflict. Requires an evidence note of 8-500 characters; confidence defaults to 0.7. Cannot delete links or cross conversation visibility boundaries.',
    {
      from: { type: 'string', description: 'Exact source memory id; required unless updating a relationship snapshot.' },
      to: { type: 'string', description: 'Exact target memory or entity id; required unless entity or relationship is supplied.' },
      kind: { type: 'string', description: 'relation, commitment, event, person or conflict; required when linking.' },
      note: { type: 'string', required: true, description: '8-500 character reason grounded in the conversation, not a guess.' },
      confidence: { type: 'number', description: '0-1 confidence, default 0.7.' },
      entity: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string' } }, additionalProperties: true, description: 'Optional named entity to create and link to instead of to. Use only an explicit identity, never infer a person from an ambiguous pronoun.' },
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
        return JSON.stringify(updateRelationship({ exec, fromId: relation.fromEntity, toId: relation.toEntity, state: relation.state, evidenceIds: relation.evidenceIds, reason: args.note }))
      }
      const toId = args.entity ? createEntity({ exec, name: args.entity.name, kind: args.entity.kind || 'person' }).id : args.to
      return JSON.stringify(linkEntries({ exec, fromId: args.from, toId, kind: args.kind, note: args.note, confidence: args.confidence }))
    },
  ))

  tools.push(toolBase(
    'memu_private_remember',
    'Write one useful private memory in the bound library. Match the domain: engineering facts, logic and verification in coding; grounded in-character experiences in RP; neutral facts and preferences in general. Do not copy a transcript or invent evidence. layer=must_remember requires pin_reason and pin_source (user_explicit, side_event, self).',
    {
      content: { type: 'string', required: true, description: 'Self-contained content appropriate to the domain. Coding: conclusion, scope/symbol, logic/conditions and verification; preserve necessary minimal code exactly. RP: an evidenced moment and its effect on later interaction, without invented facts.' },
      title: { type: 'string', description: 'Short title; defaults to the content.' },
      layer: { type: 'string', description: 'long_term (default), short_term, or must_remember. short_term is a draft with a deadline: it expires after shortTermTtlHours unless promoted to long_term before then. Use it for what only has to survive this stretch of conversation.' },
      pin_reason: { type: 'string', description: 'Required for must_remember; first-person reason.' },
      pin_source: { type: 'string', description: 'user_explicit, side_event, or self.' },
      side_event_id: { type: 'string', description: 'Required when pin_source=side_event.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
      open_loop: { type: 'boolean', description: 'Mark an unfinished promise/task/unsaid thing.' },
      disclosure: { type: 'string', description: 'can_tell, only_if_asked, or never_say.' },
      owner: { type: 'string', description: 'me, us, about_user, or about_project.' },
      visibility: { type: 'string', description: 'shared (default: the whole folder) or secret (kept out of the prompt and out of automatic recall; still readable by an explicit recall from the same folder). Scope a memory to one channel / character / world / branch with the context field instead of trying to hide it.' },
      source: {
        type: 'string',
        description: 'Where this came from: inferred (default — you concluded it), user_said (only when the words are actually theirs and quotable), imagined, or told.',
      },
      confidence: { type: 'number', description: '0-1 confidence in this memory. Below 0.45 it is injected as a hedge, so use it honestly.' },
      mood_valence: { type: 'number', description: 'How this moment felt, -1 (bad) to 1 (good). Omit to inherit the current conversation mood.' },
      arousal: { type: 'number', description: 'How strongly it hit, 0-1.' },
      peak: { type: 'boolean', description: 'A high point or low point of the arc — peaks and endings stay easier to recall.' },
      salient_date: { type: 'string', description: 'MM-DD for something that comes back every year (a birthday, an anniversary of an event); it resurfaces on that day each year. YYYY-MM-DD for a one-off dated commitment or appointment: it is raised the day before and on the day itself, and never again after it has passed. Use the annual form only when the day really does recur. A relative day (今天/明天/后天/today/tomorrow) must be resolved to the absolute date it points at: sending a bare MM-DD turns one appointment into a yearly reminder. If the content itself names a date, pass it here too: when this field is empty the plugin only falls back to a single unambiguous YYYY-MM-DD found in the text.' },
      track: { type: 'string', description: 'memory (default) or habit for an aggregated expression/sticker habit; do not write one habit per occurrence.' },
      attachments: { type: 'array', items: { type: 'object', properties: { sha256: { type: 'string', required: true } }, additionalProperties: true }, description: 'At most 8 sha256 references received in this conversation. Never supply paths or bytes. Ordinary image memories default to short_term if layer is omitted; choose long_term explicitly only when important.' },
      context: { type: 'object', properties: {
        speakerId: { type: 'string' }, channelId: { type: 'string' }, characterId: { type: 'string' }, worldId: { type: 'string' }, branchId: { type: 'string' },
        knownBy: { type: 'array', items: { type: 'string' } }, occurredAt: { type: 'string' },
      }, additionalProperties: true, description: 'Stable identities only; do not infer from a display name. Channel, character, world and branch inherit the configured conversation scope; cannot cross it. speakerId records whose words these were, knownBy limits character knowledge, occurredAt must be explicit.' },
    },
    async (args, exec) => {
      const result = await privateRemember({
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
        disclosure: args.disclosure,
        owner: args.owner,
        visibility: args.visibility,
        source: args.source,
        confidence: args.confidence,
        moodValence: args.mood_valence ?? null,
        arousal: args.arousal ?? null,
        peak: args.peak === true,
        salientDate: args.salient_date ?? null,
      })
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
      const header = `私有记忆（library=${binding?.libraryId || '?'}, domain=${domainOf(binding)}）`
      if (!result.files?.length) return `${header}\n没有命中。${warning}`
      return [header, ...result.files.map((f, i) => formatPrivateItem(f, i + 1, { query: args.query }))].join('\n\n') + warning
    },
    { isConcurrencySafe: () => true },
  ))

  tools.push(toolBase(
    'memu_private_list',
    'List private memory metadata for the library bound to this conversation. Does not return full bodies.',
    {},
    async (_args, exec) => {
      // A list is a pure read: if the conversation has no binding yet, say so
      // instead of ensureSession() silently creating a placeholder library.
      if (!peekBinding(exec)?.libraryId) return '当前对话没有绑定记忆库。'
      const result = await privateList({ exec })
      const warning = result.warning ? `\n注意：${result.warning}` : ''
      if (!result.files?.length) return `私有记忆库 ${result.libraryId} 为空。${warning}`
      const lines = [`私有记忆库 ${result.libraryId}（${result.files.length} 条）`]
      for (const file of result.files) {
        const e = file.entry || {}
        const tag = salientTag(e)
        lines.push(`- [${file.name}] ${e.title || file.description || '(untitled)'} · ${e.layer || 'long_term'} · ${e.status || 'active'}${e.marginalized ? ' · marginalized' : ''}${tag ? ` · ${tag}` : ''}`)
      }
      return lines.join('\n') + warning
    },
    { isConcurrencySafe: () => true },
  ))

  tools.push(toolBase(
    'memu_private_update',
    'Update a private memory in the bound library. Changing content rewrites the memory in MemU; metadata-only changes stay local.',
    {
      id: { type: 'string', required: true, description: 'Memory id.' },
      content: { type: 'string', description: 'New body.' },
      title: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      status: { type: 'string', description: 'active, archived, fragment, suppressed, or expired.' },
      layer: { type: 'string', description: 'long_term to promote a short_term draft once it has proven worth keeping, or short_term to re-arm the deadline. must_remember needs a pin_reason and is only writable through memu_private_remember.' },
      open_loop: { type: 'boolean' },
      disclosure: { type: 'string', description: 'can_tell, only_if_asked, or never_say. Changing this changes how the memory is phrased when it is injected.' },
      owner: { type: 'string', description: 'me, us, about_user, or about_project.' },
      visibility: { type: 'string', description: 'shared or secret. secret keeps it out of the prompt and out of automatic recall; an explicit recall from the same folder can still read it.' },
      confidence: { type: 'number' },
      // Provenance and track are claims about what a memory *is*; both were writable
      // in memory.js and the panel while staying unreachable from the tool surface,
      // so the agent could file a quote as an inference and never correct it.
      source: { type: 'string', description: 'user_said, inferred, imagined, or told. Only user_said may be repeated as the user\'s own words, so correct this rather than living with a wrong provenance.' },
      track: { type: 'string', description: 'memory or habit. habit folds repeat attachments of the same fact into one entry; a wrong track changes that aggregation and can now be corrected.' },
      peak: { type: 'boolean', description: 'Flashbulb flag: the moment was charged. Changing it recomputes accuracy.' },
      mood_valence: { type: 'number', description: 'How the moment felt, -1..1. Used as a retrieval lens; omitted keeps the stored value.' },
      arousal: { type: 'number', description: 'How charged the moment was, 0..1. Used as a retrieval lens; omitted keeps the stored value.' },
      salient_date: { type: 'string', description: 'Re-date the memory: MM-DD for an annual anniversary, YYYY-MM-DD for a one-off dated commitment, or an empty string to remove the date. Use this to repair a date that was stored without its year.' },
    },
    async (args, exec) => {
      const result = await privateUpdate({
        exec, id: args.id, content: args.content, title: args.title, tags: args.tags,
        status: args.status, openLoop: args.open_loop, disclosure: args.disclosure, confidence: args.confidence,
        layer: args.layer, owner: args.owner, visibility: args.visibility,
        source: args.source, track: args.track, peak: args.peak,
        moodValence: args.mood_valence, arousal: args.arousal,
        // Sentinel: absent means "leave the date as it is", '' means "clear it".
        salientDate: args.salient_date,
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
      const privateCount = Object.keys(privateIndex.entries || {}).filter((id) => privateIndex.entries[id].status !== 'archived').length
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
        `private: ${privateCount} active, ${pinned}/${settings.mustRememberCap} pinned`,
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

  const usable = tools.filter((tool) => tool)
  registrationReport.registered = usable.length
  if (registrationReport.failures.length > 0) {
    try {
      ctx?.logger?.warn?.(`dsh-memu-memory: host schema DSL refused ${registrationReport.failures.length} of ${registrationReport.attempted} tools: ${registrationReport.failures.map((failure) => `${failure.name} (${failure.message})`).join('; ')}`)
    } catch {}
  }
  const disposers = usable.map((tool) => ctx.tools.register(tool))
  return () => {
    for (const dispose of disposers) {
      try { dispose?.() } catch {}
    }
  }
}
