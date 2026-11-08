import { createHash } from 'node:crypto'
import {
  globalDbPath, loadGlobalIndex, updateGlobalIndex, newMemoryId, getSettings, effectiveVectorRoute,
} from './state.js'
import { commit, forget } from './memu.js'
import { loadPrompt } from './prompts.js'
import { retryStoreWrite, redactSecrets, warn, isSafeId } from './paths.js'
import { record } from './activity-log.js'
import { activeEntryStamp, assertVectorWriteAllowed, hasActiveVectorGeneration, readVectorState, withVectorWrite } from './vector-profile.js'
import { upsertLexiconTerm } from './lexicon.js'
import { clean, bigrams, dice, similarTexts, DUP_REJECT_DICE, TOPIC_DICE } from './text-similarity.js'
import { estTokens } from './budget.js'
// —— 包 F1（spec §4.1-§4.9/§6.6）：候选检索、证据落地、全局 link ——
import {
  buildCandidateClusters,
  buildCorpus,
  bm25,
  globalConflictCheck,
  pairFeatures,
  pairScore,
  rankPairCandidates,
  tokenize,
} from './text-retrieval.js'
import { buildEvidenceCorpus, groundEvidence } from './curator-evidence.js'
import { applyGlobalLinks, validateGlobalLink, appendAudit } from './global-graph.js'
import {
  ABSORB_ABSTRACTIVE_COVERAGE,
  ABSORB_AUTO_SOURCE_COVERAGE,
  ABSORB_AUTO_UNION_COVERAGE,
  ABSORB_MAX_CHARS,
  ABSORB_MAX_SOURCES,
  ABSORB_MIN_LENGTH_RATIO,
  ABSORB_REVIEW_SOURCE_COVERAGE,
  ABSORB_REVIEW_UNION_COVERAGE,
  CLUSTER_MIN_PAIR,
  CURATOR_CLUSTER_TOKENS,
  CURATOR_INDEX_MAX_ENTRIES,
  CURATOR_INDEX_TOKENS,
  CURATOR_MAX_LINK_ABSORB,
  EVIDENCE_MAX,
  PAIR_ABSORB_MIN,
  PAIR_DUPLICATE_MIN,
  PAIR_LINK_MIN,
  PAIR_SCAN_LIMIT,
} from './curator-policy.js'

const MAX_SESSIONS = 10
const MAX_TOTAL_CHARS = 90_000
const MAX_SESSION_CHARS = 14_000
// C2：转录同时受字符预算与 token 预算约束。字符预算保留原有行为；token 预算
// 按 estTokens 累计，超过 30k 就停——中文转录的字符数≈token 数，只靠 90k 字符
// 在上限时仍会送出约 90k token。
const MAX_TRANSCRIPT_TOKENS = 30_000
// C3：curator 输出上限收紧到 24 条（提示词同口径）。超出的条目在提交前丢弃并记日志。
const MAX_CURATOR_MEMORIES = 24
const jobs = new Map()

function managedVectorIntent() {
  if (effectiveVectorRoute() !== 'managed-local') return false
  try {
    const state = readVectorState({ tolerateMissing: true }).state
    return Boolean(state && (state.active || state.requested || state.pending))
  } catch {
    return true
  }
}

// 与 memory.js 同一条口径：受管路由还没有代际时，引擎这一步按词法处理（索引照写），
// 否则 MemU 会以 "managed local vector profile is not active" 拒绝整次提炼。
function engineRoute() {
  const route = effectiveVectorRoute()
  return route === 'managed-local' && !hasActiveVectorGeneration() ? 'lexical' : route
}

async function withManagedCuratorWrite(action) {
  if (!managedVectorIntent()) return action()
  // Same rule as the private write path: requested-but-never-migrated has no
  // generation to stay consistent with, so the global index + engine still get
  // the memories. Failing here would throw away a whole curation run.
  if (!hasActiveVectorGeneration()) {
    warn('managed vector write degraded to index+engine: no active vector generation; run the profile switch to enable vectors')
    record({ kind: 'vector', level: 'warn', scope: 'global', message: '向量未激活，全局提炼已降级为索引+引擎', detail: { reason: 'no active vector generation' } })
    return action()
  }
  return withVectorWrite(async () => { assertVectorWriteAllowed(); return action() })
}

function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
}

function truncate(text, max) {
  const s = String(text || '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function argsText(value) {
  if (value == null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function toolCallKey(name, args) {
  return `${name || '?'}\u0000${argsText(args)}`
}

function blockCallId(block) {
  return typeof block?.id === 'string' && block.id ? block.id : null
}

function eventCallId(event) {
  return typeof event?.data?.callId === 'string' && event.data.callId ? event.data.callId : null
}

/**
 * 转录压缩。C2：assistant/message 的 tool-call 块与独立 tool/call 事件是同一
 * 次调用的双写，以 tool/call 事件为准——块只在没有对应事件时保留（先按 callId
 * 配对；两侧都没有 id 时按 name+arguments 计数配对，支持重复调用）。字符预算
 * 保留原行为，另加可选 token 预算（累计 estTokens 超预算即停）。
 */
export function condenseEvents(events, maxChars = MAX_SESSION_CHARS, { maxTokens = Infinity } = {}) {
  // 事件侧先收一遍：callId 集合 + (name, arguments) 计数，供块侧配对。
  const eventCallIds = new Set()
  const eventSignatures = new Map()
  for (const event of events || []) {
    if (event?.type !== 'tool/call') continue
    const id = eventCallId(event)
    if (id) eventCallIds.add(id)
    const key = toolCallKey(event.data?.name, event.data?.arguments)
    eventSignatures.set(key, (eventSignatures.get(key) || 0) + 1)
  }
  const claimedSignatures = new Map()
  const lines = []
  for (const event of events || []) {
    try {
      const type = event?.type
      if (type === 'user/message') {
        if (event.data?.source?.kind !== 'user') continue
        const text = textOf(event.data?.content)
        if (text) lines.push(`User: ${text}`)
        continue
      }
      if (type === 'assistant/message') {
        const blocks = event.data?.message?.content || []
        const texts = textOf(blocks)
        if (texts) lines.push(`Assistant: ${texts}`)
        for (const b of blocks) {
          if (b?.type !== 'tool-call') continue
          const id = blockCallId(b)
          if (id && eventCallIds.has(id)) continue
          // 无 id 或 id 未配对：用 name+arguments 计数配对，事件侧有几个就吸收几个块。
          const key = toolCallKey(b.name, b.arguments)
          const available = (eventSignatures.get(key) || 0) - (claimedSignatures.get(key) || 0)
          if (available > 0) {
            claimedSignatures.set(key, (claimedSignatures.get(key) || 0) + 1)
            continue
          }
          lines.push(`Tool call: ${b.name}${b.arguments ? ` ${truncate(argsText(b.arguments), 300)}` : ''}`)
        }
        continue
      }
      if (type === 'tool/result') {
        const text = textOf(event.data?.message?.content)
        if (text) lines.push(`Tool result${event.data?.message?.isError ? ' (error)' : ''}: ${truncate(text, 400)}`)
        continue
      }
      if (type === 'tool/call') {
        lines.push(`Tool call: ${event.data?.name || '?'} ${truncate(argsText(event.data?.arguments), 300)}`)
      }
    } catch {}
  }
  let kept = lines
  let tokenTruncated = false
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    kept = []
    let used = 0
    for (const line of lines) {
      const cost = estTokens(line) + (kept.length > 0 ? 1 : 0)
      // 永远保留第一行（与 budget.packToBudget 同口径），之后累计超预算即停。
      if (kept.length > 0 && used + cost > maxTokens) { tokenTruncated = true; break }
      kept.push(line)
      used += cost
    }
  }
  let joined = redactSecrets(kept.join('\n'))
  if (tokenTruncated) {
    joined += `\n...[truncated ${lines.length - kept.length} lines over token budget ${maxTokens}]...`
  }
  if (joined.length > maxChars) {
    const head = joined.slice(0, Math.floor(maxChars * 0.6))
    const tail = joined.slice(-Math.floor(maxChars * 0.35))
    joined = `${head}\n...[truncated ${joined.length - maxChars} chars]...\n${tail}`
  }
  return joined
}

// —— §4.5 curator 上下文打包（包 F1）——
// 旧 compactGlobalIndex 是"插入顺序前 200 条 ×600 字"的平铺，第 201 条后永远不可见、
// 无预算。这里改为：BM25(会话文本) top80 → 追加最近 30 / universal 10 / pending 10，
// 去重后按 BM25 desc → updatedAt desc → id 排序，estTokens 累计超预算即停（丢低分，
// 不截断 JSON）。同输入同输出，不依赖对象插入顺序。
function renderIndexEntry(id, entry, contentCap) {
  const links = Array.isArray(entry?.links) ? entry.links : []
  const item = {
    id,
    track: entry?.track || 'memory',
    domain: entry?.domain || 'unknown',
    applies_to: Array.isArray(entry?.appliesTo) ? entry.appliesTo.slice(0, 20) : [],
    title: entry?.title || '',
    content: truncate(entry?.content || '', contentCap),
    confidence: entry?.confidence ?? null,
    status: entry?.status || 'active',
    updatedAt: entry?.updatedAt || null,
    linkCount: links.length,
    linkedTo: links.slice(0, 5).map((l) => ({ to: l?.to || null, kind: l?.kind || null })),
  }
  if (Array.isArray(entry?.absorbedFrom) && entry.absorbedFrom.length) item.absorbedFrom = entry.absorbedFrom
  return item
}

export function packCuratorIndexContext({ index, sessionText, tokenBudget = CURATOR_INDEX_TOKENS, maxEntries = CURATOR_INDEX_MAX_ENTRIES } = {}) {
  const pool = []
  for (const [id, entry] of Object.entries(index?.entries || {})) {
    if (!entry || entry.status === 'archived') continue
    if (entry.reviewKind) continue // 本版没有 link 伪条目；防御性过滤
    pool.push({ id, entry, updatedAt: String(entry.updatedAt || ''), score: 0 })
  }
  if (pool.length) {
    const corpus = buildCorpus(pool.map((p) => ({ ...p.entry, id: p.id })))
    const query = tokenize(sessionText || '')
    for (const p of pool) {
      const doc = corpus.docs.get(p.id)
      p.score = doc ? bm25(query, doc, corpus) : 0
    }
  }
  const byScore = [...pool].sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt) || (a.id < b.id ? -1 : 1))
  const byRecent = [...pool].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || (a.id < b.id ? -1 : 1))
  const selected = new Map()
  const take = (list) => { for (const p of list) if (!selected.has(p.id)) selected.set(p.id, p) }
  take(byScore.slice(0, 80)) // BM25 top 80
  take(byRecent.slice(0, 30)) // 最近 30
  take(byRecent.filter((p) => (p.entry?.domain || '') === 'universal').slice(0, 10)) // universal 10
  take(pool.filter((p) => (p.entry?.status || '') === 'pending_review' && (p.entry?.track || 'memory') === 'memory')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || (a.id < b.id ? -1 : 1)).slice(0, 10)) // pending_review 记忆 10

  const ordered = [...selected.values()].sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt) || (a.id < b.id ? -1 : 1))
  const entries = []
  let tokens = 0
  for (let i = 0; i < ordered.length && entries.length < maxEntries; i++) {
    const item = renderIndexEntry(ordered[i].id, ordered[i].entry, i < 20 ? 900 : 600)
    const cost = estTokens(JSON.stringify(item))
    if (entries.length > 0 && tokens + cost > tokenBudget) break
    entries.push(item)
    tokens += cost
  }
  return { entries, tokens, omitted: Math.max(0, ordered.length - entries.length), includedIds: entries.map((e) => e.id) }
}

// candidate_clusters 的 prompt 打包（§4.5）：预算 2000 tokens，簇内正文截 300 字，
// pair_scores 保留 2 位；簇已按 avg_score 降序，超预算丢低分簇。
export function packCuratorClusterContext(clusterResult, { tokenBudget = CURATOR_CLUSTER_TOKENS } = {}) {
  const clusters = []
  let tokens = 0
  for (const cluster of clusterResult?.clusters || []) {
    const rendered = {
      cluster_id: cluster.cluster_id,
      suggested_op: cluster.suggested_op,
      medoid_id: cluster.medoid_id,
      avg_score: cluster.avg_score,
      pair_scores: cluster.pair_scores,
      members: (cluster.members || []).map((m) => ({
        id: m.id, title: m.title || '', track: m.track || 'memory',
        domain: m.domain || 'unknown', updatedAt: m.updatedAt || null,
        content: truncate(m.content || '', 300),
      })),
    }
    const cost = estTokens(JSON.stringify(rendered))
    if (clusters.length > 0 && tokens + cost > tokenBudget) break
    clusters.push(rendered)
    tokens += cost
  }
  const total = clusterResult?.clusters?.length || 0
  return {
    clusters,
    tokens,
    omitted: Math.max(0, total - clusters.length),
    truncated: (clusterResult?.truncated === true) || (total - clusters.length) > 0,
  }
}

async function readSession(sessionQuery, id) {
  if (typeof sessionQuery.readSession === 'function') {
    const snapshot = await sessionQuery.readSession(id)
    return {
      events: snapshot?.events || [],
      header: snapshot?.session || null,
      inheritedEventCount: snapshot?.inheritedEventCount ?? null,
    }
  }
  if (typeof sessionQuery.observeSession === 'function') {
    const observation = await sessionQuery.observeSession(id, { projectionMode: 'none' })
    try {
      return {
        events: observation?.events || [],
        header: observation?.header || null,
        inheritedEventCount: observation?.inheritedEventCount ?? null,
      }
    } finally {
      try { observation?.[Symbol.dispose]?.() } catch {}
    }
  }
  throw new Error('sessionQuery has neither readSession nor observeSession')
}

async function readSessionMeta(sessionQuery, ids) {
  const out = new Map()
  try {
    const records = await sessionQuery.listSessions()
    for (const record of records || []) {
      // `SessionRecord` carries only header + liveness; the title arrives from
      // readTitleSnapshots below, so keep the record and a mutable title slot.
      out.set(record.header?.id, { ...record, title: record.header?.title || '' })
    }
  } catch {}
  try {
    if (typeof sessionQuery.readTitleSnapshots === 'function') {
      // One result per requested id: `{ sessionId, status, value: { session, title? } }`.
      const titles = await sessionQuery.readTitleSnapshots(ids)
      for (const r of titles || []) {
        if (r?.status !== 'fulfilled' || !r.sessionId || !out.has(r.sessionId)) continue
        const title = r.value?.title?.title || r.value?.session?.title
        if (title) out.get(r.sessionId).title = title
      }
    }
  } catch {}
  return out
}

function parseJsonObject(text) {
  const raw = String(text || '').trim()
  try { return JSON.parse(raw) } catch {}
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)) } catch {}
  }
  return null
}

function validDomain(domain) {
  const d = String(domain || '').trim()
  return d === 'universal' || d === 'coding' || d === 'rp' || d === 'tooling' || d === 'personal' || d === 'general' || d.startsWith('project:')
}

function agentOptionsFor(model) {
  const value = String(model || '').trim()
  if (!value) return undefined
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

export function listCurationJobs() {
  return [...jobs.values()].map((j) => ({
    id: j.id, status: j.status, step: j.step, createdAt: j.createdAt, endedAt: j.endedAt,
    error: j.error || null, result: j.result || null,
  }))
}

export function getCurationJob(id) {
  const job = jobs.get(id)
  if (!job) return null
  return {
    id: job.id,
    status: job.status,
    step: job.step,
    logs: job.logs.slice(-80),
    createdAt: job.createdAt,
    endedAt: job.endedAt || null,
    error: job.error || null,
    result: job.result || null,
  }
}

export function cancelCurationJob(id) {
  const job = jobs.get(id)
  if (!job) return false
  try { job.abort.abort(new Error('cancelled by user')) } catch {}
  return true
}

// 孤儿窗口补偿（这是补偿设计，不是事务）：curator 是 commit-before-index —— 批量提交
// 成功而全局索引写失败时，引擎库里会留下索引不认识的孤儿行。这里对刚提交的每个 name
// 逐个 forget，尽力撤销；这是尽力而为，不是回滚保证：删不掉的必须可见。补偿结果（包括
// 哪些补上了、哪些没补上）逐条记录进活动日志 kind:'curate'，绝不吞掉。
async function compensateCuratorCommit(originalError, { files, route }) {
  const db = globalDbPath()
  const compensated = []
  const failed = []
  for (const file of files) {
    try {
      const result = await forget({ db, name: file.name })
      if (!result || typeof result !== 'object' || result.ok === false || result.error || result.parseWarning
        || !Number.isSafeInteger(result.deleted) || result.deleted < 0) {
        throw new Error('backend compensation delete was not acknowledged')
      }
      compensated.push(file.name)
    } catch (compensationError) {
      failed.push({ name: file.name, error: String(compensationError?.message || compensationError) })
    }
  }
  if (failed.length) {
    record({
      kind: 'curate', scope: 'global', ok: false, level: 'error',
      message: `全局提炼索引写失败后的补偿不完整：${compensated.length}/${files.length} 条已从向量库撤销，${failed.length} 条撤销失败（引擎库残留孤儿行，需手动清理）`,
      detail: { route, compensated, failed: failed.slice(0, 20), originalError: String(originalError?.message || originalError) },
      refs: files.map((file) => file.name).slice(0, 20),
    })
  } else {
    record({
      kind: 'curate', scope: 'global', ok: true, level: 'warn',
      message: `全局提炼索引写失败，已从向量库回滚刚提交的 ${compensated.length} 条记忆（补偿成功；索引未变，重跑提炼即可）`,
      detail: { route, compensated, failed: [], originalError: String(originalError?.message || originalError) },
      refs: files.map((file) => file.name).slice(0, 20),
    })
  }
}

// 词典 op 识别（§2.1）：op 显式标 'lexicon'，或任何带 libraryId / term+kind 的提案。
// 全局 curator 的输出里出现这些字段只能说明模型越权，拒绝而不是猜它的意图。
function isLexiconOp(memory) {
  if (!memory || typeof memory !== 'object') return false
  if (memory.op === 'lexicon') return true
  if (typeof memory.libraryId === 'string' && memory.libraryId.trim()) return true
  return typeof memory.term === 'string' && memory.term.trim() && ['slang', 'meme', 'trigger', 'term'].includes(memory.kind)
}

/**
 * 私有整理链路的词典写入（§2.1-§2.2）：validated ops 白名单校验 + 落库。
 *
 * 锁顺序（刻意注释，谁改谁读）：本函数先拿 curator 侧的 managed 写闸
 * （withManagedCuratorWrite —— 受管向量代际一致性），**在其内部**再让
 * upsertLexiconTerm 拿词典自己的 withFileLock。两把锁的嵌套只有一个方向：
 * curator(vector) → lexicon(file)；lexicon.js 从不回头拿向量锁，所以无死锁环。
 * 词典写从不跨 await 持锁——withFileLock 的 action 是同步的。
 *
 * 校验规则（§2.1 curator 行 + 契约）：
 *   * 只接受 { op:'lexicon', action:'upsert', ... }；action 其它值（尤其 delete）
 *     一律拒绝——删除是用户/管理操作，模型没有删除路径。
 *   * 必须 evidence（quote 或 id 至少其一非空），无证据直接拒绝；
 *     "同一转录同词 ≥2 次才建议"是提示词层的事，代码层只验证据存在。
 *   * libraryId 必须显式给出且过 isSafeId；op 里带了别的 libraryId 视为越权拒绝。
 *   * needs_review === true → status:'pending'，否则 'active'。
 *   * sensitive trigger 由 lexicon.js 的 LEXICON_SENSITIVE_FORBIDDEN 兜底（curator
 *     来源理论上不该提，但来源字段在模型手里，存储层必须自己设防）。
 */
export async function commitPrivateLexiconOps(ops, { libraryId, job } = {}) {
  const list = Array.isArray(ops) ? ops : [ops]
  const committed = []
  const rejected = []
  const skipped = []
  if (!isSafeId(libraryId)) {
    for (const raw of list) rejected.push({ term: raw?.term || null, code: 'LEXICON_INVALID_LIBRARY_ID', reason: 'lexicon ops need a valid private library id' })
    return { committed, rejected, skipped }
  }
  const run = async () => {
    for (const raw of list) {
      const op = raw && typeof raw === 'object' ? raw : null
      if (!op || op.op !== 'lexicon') {
        skipped.push({ term: op?.term || null, reason: 'not a lexicon op (op must be "lexicon")' })
        continue
      }
      if (op.action !== 'upsert') {
        rejected.push({ term: op.term || null, code: 'LEXICON_ACTION_FORBIDDEN', reason: `lexicon action "${op.action}" is not allowed for consolidation; only upsert, never delete` })
        continue
      }
      const evidence = Array.isArray(op.evidence)
        ? op.evidence.filter(item => item && typeof item === 'object' && ((typeof item.quote === 'string' && item.quote.trim()) || (typeof item.id === 'string' && item.id.trim())))
        : []
      if (!evidence.length) {
        rejected.push({ term: op.term || null, code: 'LEXICON_EVIDENCE_REQUIRED', reason: 'lexicon upserts need evidence from the transcript' })
        continue
      }
      if (typeof op.libraryId === 'string' && op.libraryId && op.libraryId !== libraryId) {
        rejected.push({ term: op.term || null, code: 'LEXICON_LIBRARY_MISMATCH', reason: `lexicon op targets library ${op.libraryId}, but this consolidation is bound to ${libraryId}` })
        continue
      }
      // 敏感触发词不允许模型猜（§0.2/§2.1）：curator 也是模型，整理链路一律不给
      // sensitive trigger（trigger 缺省就是 sensitive，除非显式降为 normal）。
      if (op.kind === 'trigger' && op.sensitivity !== 'normal') {
        rejected.push({ term: op.term || null, code: 'LEXICON_SENSITIVE_FORBIDDEN', reason: 'consolidation cannot create sensitive triggers; sensitive vocabulary needs an explicit user write' })
        continue
      }
      try {
        const result = await upsertLexiconTerm({
          libraryId,
          term: op.term,
          kind: op.kind,
          meaning: op.meaning,
          usage: op.usage,
          aliases: op.aliases,
          examples: op.examples,
          context: op.context,
          knownBy: op.knownBy,
          visibility: op.visibility,
          sensitivity: op.sensitivity,
          confidence: op.confidence,
          evidence,
          source: 'curator',
          status: op.needs_review === true ? 'pending' : 'active',
        })
        committed.push({
          termId: result.term.termId,
          term: result.term.term,
          status: result.term.status,
          created: result.created === true,
          notOwned: result.notOwned === true,
          pendingRevision: result.pendingRevision === true,
        })
      } catch (error) {
        rejected.push({ term: op.term || null, code: error?.code || 'LEXICON_OP_FAILED', reason: String(error?.message || error) })
      }
    }
    return { committed, rejected, skipped }
  }
  if (job) job.step = 'committing lexicon ops'
  // 先过 curator 侧 managed 写闸，再进词典自己的文件锁（顺序见函数头注释）。
  return withManagedCuratorWrite(run)
}

/**
 * 审核决策（spec §4.10）：硬门 + 风险分。
 *
 * 硬门恒 pending，不因审核模式放宽：conflict（模型自己承认两段会话打架）、
 * 证据为空（可回放性是底线）、merge/supersede/absorb 的 target 不存在。
 * 非法 target 在这里返回 skip——调用方必须跳过该提案并且**不得**用同一份内容
 * 继续 create（旧代码缺 continue，会把失败的合并悄悄变成一条重复记忆，§0.2）。
 *
 * 风险分只拦"会改写既有内容"的操作：merge/supersede/absorb 在 auto 下风险
 * ≥0.70 才 pending；create 默认通过，needs_review/低置信只记进 risk 供审计与
 * 复核排序。review-all 把全部内容操作都送进复核。风险分上限 2。
 *
 * @returns {{ review: boolean, risk: number, reasons: string[], hard?: boolean } |
 *           { skip: true, reason: string }}
 */
export function reviewDecision({ m, op, evidence, targetId, index, mode }) {
  // 硬门（恒 pending；不因 mode 放宽）
  if (op === 'conflict') return { review: true, hard: true, risk: 2, reasons: ['conflict'] }
  if (!evidence.length) return { review: true, hard: true, risk: 2, reasons: ['missing evidence'] }
  if (op === 'merge' || op === 'supersede' || op === 'absorb') {
    if (!targetId || !index.entries[targetId]) {
      return { skip: true, reason: `target not found: ${targetId || '(empty)'}` }
    }
  }
  // 风险分
  let risk = 0
  const reasons = []
  if (m?.needs_review === true) { risk += 0.70; reasons.push('needs_review') }
  if (Number(m?.confidence) < 0.50) { risk += 0.70; reasons.push('confidence<0.50') }
  else if (Number(m?.confidence) < 0.60) { risk += 0.20; reasons.push('confidence<0.60') }
  if (op === 'merge' || op === 'supersede') { risk += 0.20; reasons.push(op) }
  if (op === 'absorb' && (m?.source_ids?.length || 0) > 3) { risk += 0.20; reasons.push('absorb>3 sources') }
  if (m?.review_reason) { risk += 0.20; reasons.push('review_reason') }
  if (evidence.length === 1) { risk += 0.10; reasons.push('single evidence') }

  const rewrite = op === 'merge' || op === 'supersede' || op === 'absorb'
  const review = mode === 'review-all' || (mode === 'auto' && rewrite && risk >= 0.70)
  return { review, risk: Math.min(2, Number(risk.toFixed(2))), reasons }
}

// —— §4.8 去重门/冲突门（包 F1）——
// 门语料只含 active + pending_review：archived/superseded 不是"已存在的事实"，
// 不该拦 create，也不该成为 best。LLM 只裁决；提交层用同一把 pair 尺子复核。
// buildCorpus 的约定是条目自带 id/title/content（track/domain/appliesTo 等
// 随条目一起落在 doc.entry 上），所以这里直接展开索引条目再补 id。
function buildGateCorpus(index) {
  const rows = []
  for (const [id, entry] of Object.entries(index?.entries || {})) {
    if (!entry || (entry.status !== 'active' && entry.status !== 'pending_review')) continue
    rows.push({ ...entry, id })
  }
  return buildCorpus(rows)
}

const OPS_ALLOWLIST = ['create', 'merge', 'supersede', 'noop', 'conflict', 'link', 'absorb']
const SCORE_EPSILON = 1e-9

/**
 * 规划阶段（spec §7.2 planCuratorOps）：把模型输出拆成 writes / pendings / links /
 * skipped 四类计划；全部语义复核在此完成，提交阶段只做事务。逐条流程：
 *   lexicon op → skipped；unknown op → skipped（绝不降级 create）；noop → 静默跳过；
 *   link → validateGlobalLink 预检（快照索引 + 证据落地），事务内再复核并发面；
 *   absorb → skipped 'absorb lands in a later pass'（F2 的 commitCuratorPlans 负责，
 *   它直接从原始输出里取 absorb ops，不受这里的 skip 影响）；
 *   create/merge/supersede/conflict → 证据落地（§4.6）→ reviewDecision（§4.10）→
 *   §4.8 候选门（rankPairCandidates top1）：
 *     create ≥0.90 同 track/domain → skip 'duplicate of <id>'（pending 同域 →
 *       'duplicate of pending <id>'），warn 日志；
 *     create conflict（pairDecision 或 globalConflictCheck 预筛，absorb 带不重复查）→
 *       pending 'conflict detected'；
 *     create 0.82-0.90 → duplicateOf+relatedTo；0.55-0.82 → relatedTo；
 *     merge/supersede best 是另一条且高 ≥0.05 → pending 'closest target differs'；
 *     conflict 恒 pending，target 缺失时用 best。
 */
export function planCuratorOps(memories, { index, mode, corpus, sessionCorpus = null, now }) {
  const writes = []
  const pendings = []
  const links = []
  const skipped = []
  const entries = index?.entries || {}
  for (const m of memories) {
    // 词典 op 是私有整理的专属面（§2.1）：全局 curator 只写全局记忆。带 libraryId /
    // lexicon 标记的条目在这里一律拒绝——不进向量提交、不进全局索引，只在 skipped 里
    // 留下可读的原因。私有写入走 commitPrivateLexiconOps。
    if (isLexiconOp(m)) {
      skipped.push({ title: m?.term || m?.title, reason: 'lexicon op rejected: the global curator only writes global memory; lexicon ops belong to the private consolidation chain' })
      continue
    }
    // 未知 op 一律拒绝（§4.8）：allowlist 之外的 op 不得静默降级成 create——
    // 模型写错 op 名时，降级会凭空写条目。'noop' 是模型的"无可奉告"，直接跳过。
    const op = OPS_ALLOWLIST.includes(m?.op) ? m.op : null
    if (op === 'noop') continue
    if (!op) {
      skipped.push({ title: m?.title, reason: `unknown op: ${m?.op ?? '(missing)'}` })
      continue
    }
    // —— link 分支（§4.9，包 F1）：预检通过才进 links 计划；落库在提交事务里，
    // 与普通 updates 同一次 updateGlobalIndex；不进 files、不触发向量提交。
    if (op === 'link') {
      const verdict = validateGlobalLink({
        index,
        fromId: m?.from_id,
        toId: m?.to_id,
        kind: m?.kind,
        note: m?.note,
        confidence: m?.confidence,
        evidence: Array.isArray(m?.evidence) ? m.evidence : [],
        sessionCorpus,
      })
      if (!verdict.ok) {
        skipped.push({ title: m?.note || m?.to_id || m?.title, reason: `link rejected: ${verdict.reason}` })
        continue
      }
      links.push({ fromId: verdict.fromId, toId: verdict.toId, kind: verdict.kind, symmetric: verdict.symmetric, link: verdict.link })
      continue
    }
    // absorb 提交属于 F2 的 commitCuratorPlans（从原始 output 自取 absorb ops）；
    // 这里显式跳过——planCuratorOps 不把 absorb 当成 create 走内容提交。
    // 注意：absorb 已接线（commitCuratorOutput 里调用 commitCuratorPlans），
    // 这个 skip 只是内容半边的路由，不是"未实现"。
    if (op === 'absorb') {
      skipped.push({ title: m?.title, reason: 'absorb handled by commitCuratorPlans' })
      continue
    }

    // 证据落地（§4.6）：quote 必须能回放到本次策划的会话转录；无 corpus（测试/直呼）
    // 时只做形状校验，status='unverified'。有效证据为空是硬门（reviewDecision）。
    const grounded = groundEvidence(Array.isArray(m?.evidence) ? m.evidence : [], sessionCorpus)
    const evidence = grounded.valid.slice(0, EVIDENCE_MAX)
      .map((item) => ({ sessionId: item.sessionId, quote: truncate(item.quote, 500) }))
    const domain = String(m?.domain || '').trim()
    if (!validDomain(domain)) {
      skipped.push({ title: m?.title, reason: `invalid domain: ${domain}` })
      continue
    }
    const track = m?.track === 'skill' ? 'skill' : 'memory'
    const title = String(m?.title || '').trim()
    const content = String(m?.content || '').trim()
    if (!title || !content) {
      skipped.push({ title, reason: 'missing title or content' })
      continue
    }
    const targetId = String(m?.target_id || '').trim()
    const decision = reviewDecision({ m, op, evidence, targetId, index, mode })
    if (decision.skip) {
      // 非法 merge/supersede target 到此为止（§0.2 修复）：skipped + continue，
      // 绝不带着同一份内容继续 create。
      skipped.push({ title, reason: decision.reason })
      continue
    }

    // —— §4.8 候选复核门：每次规划用同一语料、同一把尺子。——
    const proposal = {
      id: '__curator_proposal__',
      title, content, track, domain,
      appliesTo: Array.isArray(m?.applies_to) ? m.applies_to : [],
    }
    const candidates = corpus && corpus.size ? rankPairCandidates({ corpus, proposal, limit: PAIR_SCAN_LIMIT }) : []
    const best = candidates[0] || null
    let review = decision.review
    // reviewReason 优先级：硬门 > 候选门（conflict detected / closest target differs）
    // > 模型 review_reason > 'risk threshold'。
    let reviewReason = decision.hard
      ? decision.reasons[0]
      : (String(m?.review_reason || '').trim() || 'risk threshold')
    let conflictingWith = targetId || null
    const tags = {}
    if (op === 'create' && best) {
      if (best.score >= PAIR_DUPLICATE_MIN
        && (best.entry?.track || 'memory') === track
        && (best.entry?.domain || 'unknown') === domain) {
        const isPending = best.entry?.status === 'pending_review'
        warn(`curator: create skipped, ${isPending ? 'duplicate of pending' : 'duplicate of'} ${best.id} (pair score ${best.score.toFixed(2)})`)
        skipped.push({ title, reason: isPending ? `duplicate of pending ${best.id}` : `duplicate of ${best.id}` })
        continue
      }
      // 冲突检测：pairDecision 的 conflict（同标题正文迥异），或 §4.8 预筛
      // （negation/value/same_title）。duplicate/absorb 带（≥0.82）不重复查——
      // 同标题高相似是同一事实的改写，不是冲突（§4.8 豁免条款的推广）。
      const conflictHit = best.decision === 'conflict' || (best.score < PAIR_ABSORB_MIN
        && globalConflictCheck(proposal, best.entry, best.features))
      if (conflictHit) {
        review = true
        reviewReason = 'conflict detected'
        conflictingWith = best.id
      } else if (best.score >= PAIR_ABSORB_MIN) {
        tags.duplicateOf = best.id
        tags.relatedTo = best.id
      } else if (best.score >= PAIR_LINK_MIN) {
        tags.relatedTo = best.id
      }
    }
    if ((op === 'merge' || op === 'supersede') && best) {
      // best 是另一条且分数比模型 target 高 ≥0.05 → 最近目标存疑，转人审。
      const targetEntry = entries[targetId]
      const targetScore = targetEntry ? pairScore(pairFeatures(proposal, targetEntry)) : 0
      if (best.id !== targetId && best.score >= targetScore + 0.05 - SCORE_EPSILON) {
        review = true
        reviewReason = 'closest target differs'
        conflictingWith = targetId
      }
    }
    if (op === 'conflict' && !targetId && best) conflictingWith = best.id

    const previous = (op === 'merge' || op === 'supersede') && targetId && entries[targetId] ? entries[targetId] : null
    // A reviewed (held) entry must never occupy the target's id: rejecting the
    // review would archive the only copy and the original active memory would
    // be gone. Held entries always get their own id; only a clean merge writes
    // in place.
    const id = newMemoryId('gmem')
    const entry = {
      track,
      domain,
      appliesTo: Array.isArray(m?.applies_to) ? m.applies_to.slice(0, 20) : [],
      title: truncate(title, 180),
      content: redactSecrets(content),
      confidence: Number.isFinite(Number(m?.confidence)) ? Math.max(0, Math.min(1, Number(m.confidence))) : 0.6,
      evidence: evidence.map((e) => ({
          sessionId: String(e?.sessionId || ''),
          quote: truncate(e?.quote || '', 500),
        })),
      status: 'active',
      supersedes: op === 'supersede' ? targetId || null : previous?.supersedes || null,
      // 风险分写到所有条目（active 也写，§4.10）：它是审计/复核排序的统一口径，
      // 不是 pending 的专属属性。旧条目没有这两个字段时按缺省读取，不需要迁移。
      reviewRisk: decision.risk,
      reviewRiskReasons: decision.reasons,
      // 证据是否通过 grounding（§3.1）：unverified（直呼/测试）时为 false。
      evidenceVerified: grounded.status === 'grounded',
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    }
    if (tags.duplicateOf) entry.duplicateOf = tags.duplicateOf
    if (tags.relatedTo) entry.relatedTo = tags.relatedTo
    if (review) {
      // Held in the index only: never committed to MemU, so a contested claim
      // cannot be recalled as shared memory until someone decides.
      entry.status = 'pending_review'
      entry.reviewReason = reviewReason
      entry.conflictingWith = conflictingWith
      pendings.push({ id, entry })
      continue
    }
    writes.push({
      id, entry, op, targetId, previous,
      file: { name: id, track, description: truncate(title, 180), content },
    })
  }
  return { writes, pendings, links, skipped }
}

// Exported for the audit regression suite: merging the commit decision logic
// into startGlobalCuration would require standing up subagents to test it.
export async function commitCuratorOutput(output, { job, sessionCorpus = null } = {}) {
  const returned = Array.isArray(output?.memories) ? output.memories : []
  // C3：提示词已把上限压到 24；模型仍超量时在提交前截断（超出部分直接丢弃），并
  // 留一条可观测日志——静默截断会让「为什么少了几条」永远查不到。
  const memories = returned.slice(0, MAX_CURATOR_MEMORIES)
  if (returned.length > MAX_CURATOR_MEMORIES) {
    warn(`curator: output truncated to ${MAX_CURATOR_MEMORIES} memories (${returned.length} returned)`)
    record({
      kind: 'curate', scope: 'global', ok: true, level: 'warn',
      message: `全局提炼输出超过上限，已截断 ${returned.length} → ${MAX_CURATOR_MEMORIES} 条`,
      detail: { op: 'output-truncated', returned: returned.length, kept: memories.length, limit: MAX_CURATOR_MEMORIES },
    })
  }
  if (memories.length === 0) {
    return { files: [], created: 0, merged: 0, superseded: 0, pending: 0, linked: 0, skipped: [], reviewRisk: { max: 0, flagged: 0, reasons: {} } }
  }
  const index = loadGlobalIndex()
  // 模式只在循环外读一次（§4.10）：一次策划运行用同一个口径，中途改设置不影响本批。
  const mode = getSettings().curatorReviewMode || 'auto'
  const gateCorpus = buildGateCorpus(index)
  const plan = planCuratorOps(memories, { index, mode, corpus: gateCorpus, sessionCorpus, now: new Date().toISOString() })
  const contentResult = await commitPlannedOps(plan, { job })
  // absorb 半边（F2）：planCuratorOps 对 absorb 显式 skip（避免在内容提交里被误当成
  // create），absorb ops 由 commitCuratorPlans 从原始 output 自取并直接提交；这里传
  // 截断后的 memories，保证 24 条上限对 absorb 同样生效。
  const absorbResult = await commitCuratorPlans({ ...(output || {}), memories }, { job })
  return {
    ...contentResult,
    absorbed: absorbResult.absorbed,
    pending: contentResult.pending + absorbResult.pending,
    held: absorbResult.held,
    demoted: absorbResult.demoted,
    skipped: [...contentResult.skipped, ...absorbResult.skipped],
  }
}

/**
 * 提交阶段（spec §7.2 commitCuratorPlans 的内容操作半边；absorb 半边是 F2 的
 * 同名函数，直接吃原始 output）。单次 updateGlobalIndex 事务内按序应用：
 * pendings（索引 only）→ writes（held clone 检查 / merge 兜底 / supersede）→
 * links（applyGlobalLinks，只有 link 时也要走一次索引事务，§4.9）。
 * link 不进 files、不触发向量提交；两档审核模式都自动应用（C2）。
 */
async function commitPlannedOps({ writes, pendings, links, skipped }, { job }) {
  const files = writes.map((w) => w.file)
  const now = new Date().toISOString()

  // 风险统计（§4.10）：本批所有写入条目（active + pending）的审计口径——最高分、
  // 达到复核阈值（≥0.70）的条目数、每类原因出现的次数。
  const written = [...writes.map((w) => w.entry), ...pendings.map((p) => p.entry)]
  const riskReasons = {}
  for (const entry of written) {
    for (const reason of entry.reviewRiskReasons || []) riskReasons[reason] = (riskReasons[reason] || 0) + 1
  }
  const reviewRiskSummary = {
    max: written.length ? Math.max(...written.map((entry) => Number(entry.reviewRisk) || 0)) : 0,
    flagged: written.filter((entry) => (Number(entry.reviewRisk) || 0) >= 0.70).length,
    reasons: riskReasons,
  }

  // 单事务：pendings + writes + links 一次落索引。返回本事务实际落地的 link 列表，
  // 供活动日志逐条记录（retry 重跑时以成功那次的返回为准）。
  const applyPlan = (fresh) => {
    for (const { id, entry } of pendings) fresh.entries[id] = entry
    for (const { id, entry, op, targetId, previous } of writes) {
      if (previous && JSON.stringify(fresh.entries[targetId]) !== JSON.stringify(previous)) {
        const heldId = newMemoryId('gmem')
        // 提交成功的只有 `id` 这一行，held 克隆从未进过向量库——它绝不能继承
        // "提交成功即落戳"的 entry.vector：向量库里的行名是 `id` 而不是 heldId，
        // 带戳会让 membership 把一条不存在的行计进来，而真实存在的 `id` 行反而
        // 无处归属（它根本不会按这个克隆写进索引）。
        const held = { ...entry, status: 'pending_review', conflictingWith: targetId, reviewReason: 'target changed while curator was running' }
        delete held.vector
        fresh.entries[heldId] = held
        continue
      }
      if (op === 'merge' && previous) {
        entry.content = entry.content || previous.content
        entry.title = entry.title || previous.title
        entry.evidence = [...(previous.evidence || []), ...(entry.evidence || [])].slice(-40)
      }
      fresh.entries[id] = entry
      if ((op === 'supersede' || op === 'merge') && targetId && fresh.entries[targetId]) {
        fresh.entries[targetId].status = 'superseded'
        fresh.entries[targetId].supersededBy = id
        fresh.entries[targetId].validTo = now
        fresh.entries[targetId].updatedAt = now
      }
    }
    return applyGlobalLinks(fresh.entries, links, { now })
  }

  if (files.length === 0) {
    let linkResult = { applied: [], skipped: [] }
    if (pendings.length || links.length) {
      // 只有 pending/link 时同样要走一次索引事务（§4.9：只有 link 也要调一次
      // updateGlobalIndex）；withManagedCuratorWrite 闸门照过，保持锁纪律一致。
      await withManagedCuratorWrite(() => retryStoreWrite(() => updateGlobalIndex((fresh) => {
        linkResult = applyPlan(fresh)
      })))
    }
    for (const applied of linkResult.applied) {
      record({ kind: 'curate', scope: 'global', ok: true, message: `全局关联已落地：${applied.fromId} -(${applied.kind})-> ${applied.toId}`, detail: { op: 'link', from: applied.fromId, to: applied.toId, kind: applied.kind, linkId: applied.linkId } })
    }
    return {
      files: [], created: 0, merged: 0, superseded: 0, pending: pendings.length,
      linked: linkResult.applied.length, skipped, reviewRisk: reviewRiskSummary,
    }
  }

  job.step = `committing ${files.length} global memories`
  let linkResult = { applied: [], skipped: [] }
  await withManagedCuratorWrite(async () => {
    // Managed agent mode still commits the exact same files to the active local
    // vector database; only pending_review entries remain index-only.
    const route = engineRoute()
    let committedToBackend = false
    try {
      if (route !== 'lexical') {
        await commit({
          payload: { recall_files: files, resource: [], user: {} },
          route, db: globalDbPath(),
        })
        committedToBackend = true
        // 整理写入与单条写入同口径：提交成功就在条目上落"已入向量库"戳，否则这批
        // 全局记忆在向量计数（membership 的戳腿）里永远缺失。pending 不提交，不戳。
        const vector = activeEntryStamp(route)
        if (vector) for (const write of writes) write.entry.vector = vector
      }

      if (job?.abort?.signal?.aborted) throw new Error('cancelled by user')
      await retryStoreWrite(() => updateGlobalIndex((fresh) => {
        linkResult = applyPlan(fresh)
      }))
    } catch (error) {
      // 提交成功之后（abort 检查 / 索引写）的任何失败都会留下孤儿行：尽力撤销。
      if (committedToBackend) await compensateCuratorCommit(error, { files, route })
      throw error
    }
  })
  for (const applied of linkResult.applied) {
    record({ kind: 'curate', scope: 'global', ok: true, message: `全局关联已落地：${applied.fromId} -(${applied.kind})-> ${applied.toId}`, detail: { op: 'link', from: applied.fromId, to: applied.toId, kind: applied.kind, linkId: applied.linkId } })
  }
  const summary = {
    files,
    created: writes.filter((w) => w.op === 'create').length,
    merged: writes.filter((w) => w.op === 'merge').length,
    superseded: writes.filter((w) => w.op === 'supersede').length,
    pending: pendings.length,
    linked: linkResult.applied.length,
    skipped,
    reviewRisk: reviewRiskSummary,
  }
  record({
    kind: 'curate',
    scope: 'global',
    ok: true,
    message: `全局提炼：新增 ${summary.created} / 合并 ${summary.merged} / 待复核 ${summary.pending}`
      + (summary.linked ? ` / 关联 ${summary.linked}` : '')
      + (summary.skipped.length ? ` / 跳过 ${summary.skipped.length}` : ''),
    detail: { ...summary, skipped: summary.skipped.slice(0, 20) },
    refs: files.map((file) => file.name).slice(0, 20),
  })
  return summary
}

// ============================================================================
// 包 F2（spec §4.7/§4.11/§6.7）：absorb 合并稿、提交事务、复核与撤销。
// ============================================================================

// —— absorb 常量（spec §4.12）——单点定义在 lib/curator-policy.js（文件头部 import）。
// 句级去重的 charDice 阈值只属于合并稿这一处，留在本地。
const ABSORB_SENTENCE_DICE = 0.9

// —— F1 接口（spec §4.1）：tokenize/buildCorpus 已由 lib/text-retrieval.js 落地
//（文件头部 import）。buildCorpus 返回的是 BM25 语料（df/size），这里按 F1 的
// idfOf 同一公式折算成合并稿 MMR 用的 idf 表。
function tokensOf(text) {
  return new Set(tokenize(text))
}

function idfMapFromCorpus(corpus) {
  const idf = new Map()
  if (!corpus?.df) return idf
  for (const [term, df] of corpus.df) {
    idf.set(term, Math.log(1 + (corpus.size - df + 0.5) / (df + 0.5)))
  }
  return idf
}

// idf 语料取自当前全局索引的 active 条目（与候选簇同一口径）。
function absorbIdf(index) {
  const docs = Object.entries(index?.entries || {})
    .filter(([, entry]) => entry && entry.status === 'active')
    .map(([id, entry]) => ({ id, title: entry.title || '', content: entry.content || '' }))
  return idfMapFromCorpus(buildCorpus(docs))
}

// —— absorb 合并稿（spec §4.7）——
const SENTENCE_RE = /[^。！？!?；;\n]+[。！？!?；;]?/gu

function splitSentences(text) {
  const out = []
  for (const raw of String(text || '').match(SENTENCE_RE) || []) {
    const sentence = raw.trim()
    if (sentence) out.push(sentence)
  }
  return out
}

// token 覆盖率：source 的词元有多大比例出现在 content 里。
function tokenCoverage(sourceTokens, contentTokens) {
  if (!sourceTokens || sourceTokens.size === 0) return 1
  let hit = 0
  for (const token of sourceTokens) if (contentTokens.has(token)) hit += 1
  return hit / sourceTokens.size
}

// char 覆盖率：union 的字符 bigram 有多大比例出现在 proposed 里。
function charCoverage(unionText, proposedText) {
  const unionGrams = bigrams(unionText)
  if (unionGrams.size === 0) return 1
  const proposedGrams = bigrams(proposedText)
  let hit = 0
  for (const gram of unionGrams) if (proposedGrams.has(gram)) hit += 1
  return hit / unionGrams.size
}

function sentenceInfo(sentence, idf, coveredTokens = null) {
  let sum = 0
  for (const token of tokensOf(sentence)) {
    if (coveredTokens && coveredTokens.has(token)) continue
    sum += Number(idf?.get?.(token) ?? 1)
  }
  return sum
}

/**
 * 吸收合并稿（spec §4.7）。输入 target、sources、模型的 proposed 稿；
 * 输出 { content, mode, coverage, sourceCoverage, unionCoverage, truncated, omitted }。
 * 句级去重（charDice ≥0.90 或互含丢弃）→ union（target 在前）→ proposed 覆盖
 * ≥0.75 且不超长时用 proposed（abstractive），否则 extractive（放得下直接拼接，
 * 放不下做句子级 MMR：info − 0.7·redundancy·maxInfo 贪心，被丢关键句记 truncated）。
 * idf 由调用方通过 buildCorpus 提供（F1）；缺省按 1 计（spec 已兼容 idf=null）。
 */
export function composeAbsorbContent({ target, sources = [], proposed = '', maxChars = ABSORB_MAX_CHARS, idf = null } = {}) {
  const result = { content: '', mode: 'extractive', coverage: 0, sourceCoverage: 1, unionCoverage: 1, truncated: false, omitted: [] }
  // 1-3. 句子切分 + 句级去重；target 在前，构成 union。origin 记录每个句子的出处
  //（-1 = target，其余 = sources 下标），供关键句判定使用。
  const union = []
  const origins = []
  const keptKeys = []
  const pushSentence = (raw, origin) => {
    const sentence = String(raw || '').trim()
    const key = clean(sentence)
    if (!key) return
    for (const kept of keptKeys) {
      if (kept === key || kept.includes(key) || key.includes(kept) || dice(bigrams(key), bigrams(kept)) >= ABSORB_SENTENCE_DICE) return
    }
    keptKeys.push(key)
    union.push(sentence)
    origins.push(origin)
  }
  const sourceList = Array.isArray(sources) ? sources : []
  for (const sentence of splitSentences(target?.content)) pushSentence(sentence, -1)
  sourceList.forEach((source, index) => {
    for (const sentence of splitSentences(source?.content)) pushSentence(sentence, index)
  })
  if (!union.length) return result
  const unionText = union.join('')
  const proposedText = String(proposed || '').trim()

  // 4. proposed 覆盖足够且不超长 → abstractive。
  if (proposedText) {
    result.coverage = Math.max(charCoverage(unionText, proposedText), tokenCoverage(tokensOf(unionText), tokensOf(proposedText)))
    if (result.coverage >= ABSORB_ABSTRACTIVE_COVERAGE && proposedText.length <= maxChars) {
      result.content = proposedText
      result.mode = 'abstractive'
    }
  }

  // 5. extractive：总长放得下直接拼接；否则句子级 MMR 贪心到 maxChars。
  if (result.mode === 'extractive') {
    const infos = union.map((sentence) => sentenceInfo(sentence, idf))
    const maxInfo = infos.reduce((acc, value) => Math.max(acc, value), 0)
    const picked = []
    const covered = new Set()
    let length = 0
    const remaining = new Set(union.map((_, index) => index))
    while (remaining.size > 0) {
      let bestIndex = -1
      let bestScore = -Infinity
      for (const index of remaining) {
        let redundancy = 0
        for (const chosen of picked) redundancy = Math.max(redundancy, dice(bigrams(union[index]), bigrams(union[chosen])))
        const score = sentenceInfo(union[index], idf, covered) - 0.7 * redundancy * maxInfo
        if (score > bestScore) { bestScore = score; bestIndex = index }
      }
      remaining.delete(bestIndex)
      if (length + union[bestIndex].length > maxChars) continue
      picked.push(bestIndex)
      length += union[bestIndex].length
      for (const token of tokensOf(union[bestIndex])) covered.add(token)
    }
    if (!picked.length && union.length) picked.push(0)
    // 关键句：target 全部句子 + 每条 source 的 info 前 3 句；被 MMR 丢掉即 truncated。
    const byOrigin = new Map()
    union.forEach((_, index) => {
      if (!byOrigin.has(origins[index])) byOrigin.set(origins[index], [])
      byOrigin.get(origins[index]).push(index)
    })
    const keyIndices = new Set(byOrigin.get(-1) || [])
    for (const [origin, indices] of byOrigin) {
      if (origin === -1) continue
      for (const index of [...indices].sort((a, b) => infos[b] - infos[a]).slice(0, 3)) keyIndices.add(index)
    }
    const missingKeys = [...keyIndices].filter((index) => !picked.includes(index)).sort((a, b) => a - b)
    if (missingKeys.length) {
      result.truncated = true
      result.omitted = missingKeys.slice(0, 10).map((index) => union[index])
    }
    result.content = picked.sort((a, b) => a - b).map((index) => union[index]).join('')
  }

  // 6. 覆盖率：sourceCoverage = 每条 source 的 token 覆盖率取最小；unionCoverage = 全部
  // source 词元并集的覆盖率。coverage 是 proposed 对 union 的覆盖（§4.7.4）。
  const contentTokens = tokensOf(result.content)
  const presentSources = sourceList.filter((source) => String(source?.content || '').trim())
  if (presentSources.length) {
    result.sourceCoverage = Math.min(...presentSources.map((source) => tokenCoverage(tokensOf(String(source.content || '')), contentTokens)))
    const unionSourceTokens = new Set()
    for (const source of presentSources) {
      for (const token of tokensOf(String(source.content || ''))) unionSourceTokens.add(token)
    }
    result.unionCoverage = tokenCoverage(unionSourceTokens, contentTokens)
  }
  return result
}

// absorbOpId（spec §3.1）：sha1('absorb|' + sortedIds + '|' + clean(content)).slice(0,16)。
// 内容用脱敏后的合并稿，保证从已存条目重算能得到同一个 opId（幂等门靠它对账）。
function absorbOpIdOf(sortedIds, content) {
  return createHash('sha1').update('absorb|' + [...sortedIds].sort().join(',') + '|' + clean(content)).digest('hex').slice(0, 16)
}

function appliesToSubset(sourceApplies, targetApplies) {
  const target = Array.isArray(targetApplies) ? targetApplies.filter(Boolean) : []
  if (target.length === 0) return true // target 不限 ⇒ 更宽，任何 source 都算子集
  const source = Array.isArray(sourceApplies) ? sourceApplies.filter(Boolean) : []
  return source.every((item) => target.includes(item) || target.includes('all'))
}

const round4 = (value) => Math.round(Number(value) * 10000) / 10000

/**
 * absorb 的索引单事务（spec §4.11 auto absorb 步骤 3b-3f）。在 updateGlobalIndex 的
 * 同步 mutator 里运行；expectedUpdatedAt 任一不匹配时不做任何修改并返回
 * { landed:false, changed }（调用方决定 held clone 还是抛 'review changed'）。
 * 匹配时：merged 入索引（含出边并入 + absorbSnapshot）、target superseded +
 * absorbedInto、sources archived + absorbedBy、簇外入边改指 mergedId。
 */
export function applyAbsorbIndexTransaction(fresh, { mergedId, merged, targetId, sourceIds = [], expectedUpdatedAt = {}, now }) {
  const entries = fresh.entries
  const memberIds = [targetId, ...sourceIds].filter(Boolean)
  const changed = []
  for (const memberId of memberIds) {
    const current = entries[memberId]
    const expected = expectedUpdatedAt[memberId]
    if (!current || current.status !== 'active' || (expected !== undefined && current.updatedAt !== expected)) {
      changed.push(memberId || '(missing id)')
    }
  }
  if (changed.length) return { landed: false, changed }

  const target = entries[targetId]
  const sourceRefs = sourceIds.map((id) => ({ id, entry: entries[id] }))
  const clusterIds = new Set(memberIds)
  const linksOf = (entry) => (Array.isArray(entry?.links) ? entry.links : [])

  // 吸收前状态快照（§4.11 f）：rewired 存簇外条目的完整 links，撤销整体恢复。
  const rewired = []
  for (const [otherId, other] of Object.entries(entries)) {
    if (clusterIds.has(otherId) || otherId === mergedId) continue
    if (linksOf(other).some((link) => clusterIds.has(link?.to))) {
      rewired.push({ id: otherId, links: structuredClone(linksOf(other)) })
    }
  }
  // 出边并入 merged：target/sources 自己的 links 按 (to,kind) 去重、cap 20；
  // 指向簇内的边在吸收后是悬挂边，改指 mergedId，自环直接丢。
  const outbound = []
  const seenPairs = new Set()
  for (const member of [target, ...sourceRefs.map((ref) => ref.entry)]) {
    for (const link of linksOf(member)) {
      if (!link || !link.to) continue
      const key = `${link.to}|${link.kind || 'related'}`
      if (seenPairs.has(key)) continue
      seenPairs.add(key)
      outbound.push(structuredClone(link))
    }
  }
  const mergedLinks = outbound
    .map((link) => (clusterIds.has(link.to) ? { ...link, to: mergedId } : link))
    .filter((link) => link.to !== mergedId)
    .slice(0, CURATOR_MAX_LINK_ABSORB)

  const mergedEntry = {
    ...merged,
    links: mergedLinks,
    updatedAt: now,
    absorbSnapshot: {
      target: { id: targetId, status: target.status, links: structuredClone(linksOf(target)), updatedAt: target.updatedAt },
      sources: sourceRefs.map(({ id, entry }) => ({ id, status: entry.status, links: structuredClone(linksOf(entry)), updatedAt: entry.updatedAt })),
      rewired,
      mergedLinks: structuredClone(mergedLinks),
      at: now,
    },
  }

  entries[mergedId] = mergedEntry
  target.status = 'superseded'
  target.supersededBy = mergedId
  target.absorbedInto = mergedId
  target.validTo = now
  target.updatedAt = now
  const audit = { op: 'absorb', at: now, mergedId, targetId, sourceIds: [...sourceIds] }
  appendAudit(mergedEntry, audit)
  appendAudit(target, audit)
  for (const { entry } of sourceRefs) {
    entry.status = 'archived'
    entry.absorbedBy = mergedId
    entry.absorbedAt = now
    entry.validTo = now
    entry.updatedAt = now
    appendAudit(entry, audit)
  }
  for (const { id } of rewired) {
    entries[id].links = entries[id].links.map((link) => (clusterIds.has(link?.to) ? { ...link, to: mergedId } : link))
  }
  return { landed: true, at: now }
}

/**
 * absorb 计划提交（spec §6.7 + §4.7 + §4.10 + §4.11）。输入 curator 输出，只处理
 * op === 'absorb' 的条目；每条走完 协议校验 → 降级（domain/appliesTo）→ medoid →
 * 合并稿 → 覆盖率分段 → 重复门 → 风险门，auto 直接落 §4.11 事务，其余生成
 * §3.3 pendingAbsorb 提案（只进索引，不进向量库）。
 * 并发变化：不落 active，held pending clone，已提交向量行锁外 best-effort forget。
 */
export async function commitCuratorPlans(output, { job } = {}) {
  const memories = Array.isArray(output?.memories) ? output.memories : []
  const plans = memories.filter((m) => m && m.op === 'absorb')
  const result = { absorbed: 0, pending: 0, held: 0, skipped: [], demoted: [] }
  if (!plans.length) return result
  const index = loadGlobalIndex()
  // 模式只在循环外读一次（§4.10）。
  const mode = getSettings().curatorReviewMode || 'auto'
  const now = new Date().toISOString()
  const confOf = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0.6)
  const pendingEntries = []
  const autoCommits = []
  const heldNames = []

  for (const plan of plans) {
    const label = String(plan?.title || plan?.target_id || '(absorb)')
    // —— 协议校验（§6.7）：target active；source 1–5；target 不在 source_ids。——
    const targetId = String(plan?.target_id || '').trim()
    const target = targetId ? index.entries[targetId] : null
    if (!target || target.status !== 'active') {
      result.skipped.push({ title: label, reason: `absorb target not found or not active: ${targetId || '(empty)'}` })
      continue
    }
    const requestedSources = [...new Set((Array.isArray(plan?.source_ids) ? plan.source_ids : [])
      .map((id) => String(id || '').trim()).filter(Boolean))]
    if (requestedSources.length < 1 || requestedSources.length > ABSORB_MAX_SOURCES) {
      result.skipped.push({ title: label, reason: `absorb needs 1-${ABSORB_MAX_SOURCES} distinct source ids, got ${requestedSources.length}` })
      continue
    }
    if (requestedSources.includes(targetId)) {
      result.skipped.push({ title: label, reason: 'absorb target must not appear in source_ids' })
      continue
    }
    // —— 降级（§4.7.11）：source 的 appliesTo 必须是 target 子集；最终只允许同 domain。
    // 不满足的 source 不 absorb，降级 link（link 落地由 F1 的 commitCuratorOutput link 分支做）。
    const sourceRefs = []
    for (const sourceId of requestedSources) {
      const source = index.entries[sourceId]
      if (!source || source.status !== 'active') {
        result.demoted.push({ targetId, sourceId, reason: 'source not found or not active' })
        continue
      }
      if ((source.track || 'memory') !== (target.track || 'memory')) {
        result.demoted.push({ targetId, sourceId, reason: 'track differs' })
        continue
      }
      if ((source.domain || 'unknown') !== (target.domain || 'unknown')) {
        result.demoted.push({ targetId, sourceId, reason: 'domain differs; absorb is same-domain only (link candidate)' })
        continue
      }
      if (!appliesToSubset(source.appliesTo, target.appliesTo)) {
        result.demoted.push({ targetId, sourceId, reason: 'source appliesTo is not a subset of target; demoted to link candidate' })
        continue
      }
      sourceRefs.push({ id: sourceId, entry: source })
    }
    if (!sourceRefs.length) {
      result.skipped.push({ title: label, reason: 'no eligible source left after domain/appliesTo demotion' })
      continue
    }
    const sources = sourceRefs.map((ref) => ({ ...ref.entry, id: ref.id }))

    // —— medoid/representative（C4）：算 medoid，模型 target 只作 provenance，
    // medoid 平均相似度 <0.55 整簇跳过。——
    const members = [{ id: targetId, entry: target }, ...sourceRefs.map((ref) => ({ id: ref.id, entry: ref.entry }))]
    const memberText = new Map(members.map((member) => [member.id, `${member.entry.title || ''} ${member.entry.content || ''}`]))
    let medoid = null
    for (const member of members) {
      let sum = 0
      for (const other of members) {
        if (other.id === member.id) continue
        sum += similarTexts(memberText.get(member.id), memberText.get(other.id))
      }
      const avg = sum / Math.max(1, members.length - 1)
      if (!medoid || avg > medoid.avg) medoid = { id: member.id, avg }
    }
    if (!medoid || medoid.avg < CLUSTER_MIN_PAIR) {
      result.skipped.push({ title: label, reason: `medoid average similarity ${medoid ? medoid.avg.toFixed(2) : 'n/a'} is below the pair floor` })
      continue
    }
    const representativeId = medoid.id

    // —— evidence（§4.6/§4.7.8）：plan 证据（带 sourceId）优先，簇内既有证据并集，
    // 去重 ≤20；每条 source 至少一条 plan 证据覆盖，否则只进复核。——
    const planEvidence = (Array.isArray(plan?.evidence) ? plan.evidence : [])
      .filter((item) => typeof item?.session_id === 'string' && item.session_id && typeof item?.quote === 'string' && item.quote.trim())
      .map((item) => ({
        sessionId: item.session_id,
        quote: truncate(item.quote, 500),
        sourceId: typeof item?.source_id === 'string' && item.source_id.trim() ? item.source_id.trim() : null,
      }))
      .slice(0, 20)
    const clusterEvidence = []
    const seenEvidence = new Set()
    for (const item of [...planEvidence, ...members.flatMap((member) => (Array.isArray(member.entry.evidence) ? member.entry.evidence : [])
      .map((e) => ({ sessionId: e?.sessionId, quote: e?.quote, sourceId: member.id })))] ) {
      if (clusterEvidence.length >= 20) break
      const sessionId = typeof item?.sessionId === 'string' ? item.sessionId : null
      const quote = typeof item?.quote === 'string' ? item.quote : ''
      if (!sessionId || !quote.trim()) continue
      const key = `${sessionId}|${clean(quote)}|${item.sourceId || ''}`
      if (seenEvidence.has(key)) continue
      seenEvidence.add(key)
      clusterEvidence.push({ sessionId, quote: truncate(quote, 500), sourceId: item.sourceId || null })
    }
    const uncoveredSources = sourceRefs.filter((ref) => !planEvidence.some((item) => item.sourceId === ref.id))

    // —— 合并稿 + 覆盖率分段（§4.7.6）。——
    const idf = absorbIdf(index)
    const composed = composeAbsorbContent({ target, sources, proposed: plan?.content, maxChars: ABSORB_MAX_CHARS, idf })
    const mergedContent = redactSecrets(composed.content)
    if (!mergedContent.trim()) {
      result.skipped.push({ title: label, reason: 'absorb produced an empty merged draft' })
      continue
    }
    if (composed.sourceCoverage < ABSORB_REVIEW_SOURCE_COVERAGE || composed.unionCoverage < ABSORB_REVIEW_UNION_COVERAGE) {
      result.skipped.push({ title: label, reason: `absorb coverage below floor (source ${composed.sourceCoverage.toFixed(2)} / union ${composed.unionCoverage.toFixed(2)})` })
      continue
    }
    const longestSource = Math.max(0, ...sourceRefs.map((ref) => String(ref.entry.content || '').length))
    const belowLengthFloor = mergedContent.length < ABSORB_MIN_LENGTH_RATIO * longestSource

    // —— 幂等门（§6.7）：同 opId 的提案/合并稿已存在 → skip。——
    const memberIdsSorted = [targetId, ...sourceRefs.map((ref) => ref.id)].sort()
    const opId = absorbOpIdOf(memberIdsSorted, mergedContent)
    if (Object.values(index.entries).some((e) => e?.absorbOpId === opId || e?.pendingAbsorb?.opId === opId)) {
      result.skipped.push({ title: label, reason: `duplicate absorb opId ${opId}; already proposed or absorbed` })
      continue
    }

    // —— title（§4.7.7）与重复门（§6.7）：与簇外 active 条目 similarTexts ≥0.90 →
    // pending 'absorb duplicate of <id>'；0.55–0.90 → 新条目打 duplicateOf。——
    const titleCandidate = String(target.title || '').trim()
      || String(plan?.title || '').trim()
      || String(index.entries[representativeId]?.title || '').trim()
    const title = truncate(titleCandidate || label, 180)
    let absorbDuplicate = null
    for (const [otherId, other] of Object.entries(index.entries || {})) {
      if (memberIdsSorted.includes(otherId)) continue
      if (other?.status !== 'active') continue
      const similarity = similarTexts(`${title} ${mergedContent}`, `${other.title || ''} ${other.content || ''}`)
      if (similarity > (absorbDuplicate?.similarity ?? 0)) absorbDuplicate = { id: otherId, similarity }
    }

    // —— 风险分（§4.10）：写到所有条目（active 也写）。——
    const decision = reviewDecision({ m: plan, op: 'absorb', evidence: planEvidence, targetId, index, mode })

    let reviewReason = null
    if (composed.sourceCoverage < ABSORB_AUTO_SOURCE_COVERAGE || composed.unionCoverage < ABSORB_AUTO_UNION_COVERAGE
      || belowLengthFloor || (composed.truncated && composed.omitted.length)) {
      reviewReason = 'absorb coverage'
    } else if (absorbDuplicate && absorbDuplicate.similarity >= DUP_REJECT_DICE) {
      reviewReason = `absorb duplicate of ${absorbDuplicate.id}`
    } else if (uncoveredSources.length || !planEvidence.length) {
      reviewReason = decision.hard ? decision.reasons[0] : 'evidence not grounded'
    } else if (decision.review) {
      reviewReason = decision.hard ? decision.reasons[0] : (String(plan?.review_reason || '').trim() || 'risk threshold')
    }

    const confidence = Math.min(0.95, Math.max(confOf(target.confidence), ...sourceRefs.map((ref) => confOf(ref.entry.confidence)), confOf(plan?.confidence)))
    const clusterCreatedAt = members.map((member) => member.entry.createdAt).filter(Boolean).sort()[0] || now
    const expectedUpdatedAt = {
      [targetId]: target.updatedAt,
      ...Object.fromEntries(sourceRefs.map((ref) => [ref.id, ref.entry.updatedAt])),
    }
    const reviewRiskReasons = reviewReason === 'absorb coverage' ? [...decision.reasons, 'absorb coverage'] : decision.reasons
    const entryBase = {
      track: target.track || 'memory',
      domain: target.domain || 'general',
      appliesTo: Array.isArray(target.appliesTo) ? structuredClone(target.appliesTo).slice(0, 20) : [],
      title,
      content: mergedContent,
      confidence,
      evidence: clusterEvidence,
      status: 'active',
      absorbedFrom: memberIdsSorted,
      absorbedAt: now,
      absorbOpId: opId,
      representativeId,
      mergeMode: composed.mode,
      mergeCoverage: round4(composed.coverage),
      sourceCoverage: round4(composed.sourceCoverage),
      unionCoverage: round4(composed.unionCoverage),
      reviewRisk: decision.risk,
      reviewRiskReasons,
      createdAt: clusterCreatedAt,
      updatedAt: now,
    }
    if (absorbDuplicate && absorbDuplicate.similarity >= TOPIC_DICE && absorbDuplicate.similarity < DUP_REJECT_DICE) {
      entryBase.duplicateOf = absorbDuplicate.id
    }

    if (reviewReason) {
      // pending absorb（§3.3）：只进索引，绝不进向量库；accept 时才提交提案 id 本身。
      pendingEntries.push({
        id: newMemoryId('gmem'),
        entry: {
          ...entryBase,
          status: 'pending_review',
          reviewReason,
          conflictingWith: targetId,
          pendingAbsorb: { targetId, sourceIds: sourceRefs.map((ref) => ref.id), opId, representativeId, expectedUpdatedAt },
          source: 'curator',
        },
      })
      result.pending += 1
      continue
    }
    autoCommits.push({
      mergedId: newMemoryId('gmem'),
      entry: entryBase,
      targetId,
      sourceIds: sourceRefs.map((ref) => ref.id),
      expectedUpdatedAt,
    })
  }

  if (pendingEntries.length) {
    if (job) job.step = `writing ${pendingEntries.length} pending absorb proposals`
    await withManagedCuratorWrite(() => retryStoreWrite(() => updateGlobalIndex((fresh) => {
      for (const { id, entry } of pendingEntries) fresh.entries[id] = entry
    })))
  }

  if (autoCommits.length) {
    if (job) job.step = `committing ${autoCommits.length} absorb merges`
    await withManagedCuratorWrite(async () => {
      const route = engineRoute()
      const committedNames = []
      try {
        // 先向量后索引（§4.11 auto absorb 步骤 2→3）：索引失败时能补偿已提交行。
        if (route !== 'lexical') {
          await commit({
            payload: {
              recall_files: autoCommits.map(({ mergedId, entry }) => ({ name: mergedId, track: entry.track, description: entry.title, content: entry.content })),
              resource: [],
              user: {},
            },
            route,
            db: globalDbPath(),
          })
          for (const c of autoCommits) committedNames.push(c.mergedId)
          const vector = activeEntryStamp(route)
          if (vector) for (const c of autoCommits) c.entry.vector = vector
        }
        await retryStoreWrite(() => updateGlobalIndex((fresh) => {
          for (const c of autoCommits) {
            const outcome = applyAbsorbIndexTransaction(fresh, {
              mergedId: c.mergedId, merged: c.entry, targetId: c.targetId,
              sourceIds: c.sourceIds, expectedUpdatedAt: c.expectedUpdatedAt, now,
            })
            if (!outcome.landed) {
              // 并发变化（§4.11 步骤 5）：不落 active，生成 held pending clone；
              // expectedUpdatedAt 刷新为当前值，人审时再做快照校验。
              const heldId = newMemoryId('gmem')
              const refreshed = {}
              for (const memberId of [c.targetId, ...c.sourceIds]) {
                refreshed[memberId] = fresh.entries[memberId]?.updatedAt || c.expectedUpdatedAt[memberId]
              }
              const held = {
                ...c.entry,
                status: 'pending_review',
                reviewReason: 'cluster changed while curator was running',
                conflictingWith: c.targetId,
                pendingAbsorb: { targetId: c.targetId, sourceIds: c.sourceIds, opId: c.entry.absorbOpId, representativeId: c.entry.representativeId, expectedUpdatedAt: refreshed },
                updatedAt: now,
              }
              // 已提交向量库的是 mergedId 这一行；held 克隆从未进过向量库，
              // 绝不能继承"提交成功即落戳"的 entry.vector（同 curator-commit 的坑）。
              delete held.vector
              fresh.entries[heldId] = held
              heldNames.push(c.mergedId)
              result.held += 1
              continue
            }
            result.absorbed += 1
          }
        }))
      } catch (error) {
        if (committedNames.length) await compensateCuratorCommit(error, { files: committedNames.map((name) => ({ name })), route })
        throw error
      }
      // held clone 的已提交行 best-effort forget（锁外 await，修 D11）；只在向量路由
      // 真的提交过行时才需要。删不掉必须可见。
      if (route !== 'lexical') {
        for (const name of heldNames) {
          try {
            await forget({ db: globalDbPath(), name })
          } catch (forgetError) {
            record({
              kind: 'curate', scope: 'global', ok: false, level: 'error',
              message: `集合吸收并发保护：held clone 已生成，但向量行 ${name} 撤销失败（引擎库残留孤儿行，需手动清理）`,
              detail: { op: 'absorb', heldForgetFailed: true, name, error: String(forgetError?.message || forgetError) },
              refs: [name],
            })
          }
        }
      }
    })
  }

  if (result.absorbed || result.pending || result.held || result.skipped.length || result.demoted.length) {
    record({
      kind: 'curate',
      scope: 'global',
      ok: true,
      message: `集合吸收：合并 ${result.absorbed} / 待复核 ${result.pending}`
        + (result.held ? ` / 并发暂扣 ${result.held}` : '')
        + (result.skipped.length ? ` / 跳过 ${result.skipped.length}` : '')
        + (result.demoted.length ? ` / 降级 link ${result.demoted.length}` : ''),
      detail: { op: 'absorb', ...result, skipped: result.skipped.slice(0, 20), demoted: result.demoted.slice(0, 20) },
      refs: autoCommits.map((c) => c.mergedId).slice(0, 20),
    })
  }
  return result
}

/**
 * 撤销集合吸收（spec §4.11 undo-absorb）。merged 必须 active 且带 absorbSnapshot；
 * 同一事务恢复 target/sources/rewired，merged 归档（保留正文）。吸收后又被人工改过
 * （updatedAt > absorbedAt）的成员拒绝整体撤销并返回可读错误——部分恢复比不恢复更
 * 难对账。不删除、不写向量。
 */
export async function undoGlobalAbsorb({ id } = {}) {
  const mergedId = String(id || '').trim()
  if (!mergedId) throw new Error('undo-absorb needs the merged entry id')
  const index = loadGlobalIndex()
  const merged = index.entries[mergedId]
  if (!merged || merged.status !== 'active' || !merged.absorbSnapshot) {
    throw new Error('undo-absorb needs an active merged entry with an absorb snapshot')
  }
  const snapshot = merged.absorbSnapshot
  const memberRefs = [snapshot.target, ...(Array.isArray(snapshot.sources) ? snapshot.sources : [])].filter(Boolean)
  const changedMembers = []
  for (const member of memberRefs) {
    const current = index.entries[member.id]
    if (!current) continue
    const absorbedAt = Date.parse(current.absorbedAt || '') || Date.parse(snapshot.at || '') || 0
    if ((Date.parse(current.updatedAt || '') || 0) > absorbedAt) changedMembers.push(member.id)
  }
  if (changedMembers.length) {
    throw new Error(`absorb undo refused: ${changedMembers.join(', ')} changed after absorption; restore them manually or resolve each edit first`)
  }
  await retryStoreWrite(() => updateGlobalIndex((fresh) => {
    if (JSON.stringify(fresh.entries[mergedId]) !== JSON.stringify(merged)) throw new Error('absorb entry changed; reload and retry')
    const at = new Date().toISOString()
    const targetSnap = snapshot.target
    const currentTarget = targetSnap?.id ? fresh.entries[targetSnap.id] : null
    if (currentTarget && currentTarget.status === 'superseded' && currentTarget.supersededBy === mergedId) {
      currentTarget.status = targetSnap.status || 'active'
      if (Array.isArray(targetSnap.links)) currentTarget.links = structuredClone(targetSnap.links)
      delete currentTarget.supersededBy
      delete currentTarget.absorbedInto
      delete currentTarget.validTo
      currentTarget.updatedAt = at
    }
    for (const sourceSnap of Array.isArray(snapshot.sources) ? snapshot.sources : []) {
      const current = fresh.entries[sourceSnap.id]
      if (!current || current.status !== 'archived' || current.absorbedBy !== mergedId) continue
      current.status = sourceSnap.status || 'active'
      if (Array.isArray(sourceSnap.links)) current.links = structuredClone(sourceSnap.links)
      delete current.absorbedBy
      delete current.absorbedAt
      delete current.validTo
      current.updatedAt = at
    }
    for (const rewiredSnap of Array.isArray(snapshot.rewired) ? snapshot.rewired : []) {
      const current = fresh.entries[rewiredSnap.id]
      if (current && Array.isArray(rewiredSnap.links)) current.links = structuredClone(rewiredSnap.links)
    }
    const stored = fresh.entries[mergedId]
    stored.status = 'archived'
    stored.absorbUndoneAt = at
    stored.updatedAt = at
    const audit = { op: 'undo-absorb', at, mergedId }
    appendAudit(currentTarget, audit)
    for (const sourceSnap of Array.isArray(snapshot.sources) ? snapshot.sources : []) {
      appendAudit(fresh.entries[sourceSnap.id], audit)
    }
    appendAudit(stored, audit)
  }))
  // 活动日志 CURATOR_ABSORB_UNDO（§4.11 撤销 4）：以 detail.op 标记，kind 仍是 curate。
  record({
    kind: 'curate',
    scope: 'global',
    ok: true,
    message: `撤销集合吸收 ${mergedId}：target 与来源记忆已恢复，merged 已归档`,
    detail: { op: 'undo-absorb', id: mergedId, snapshotAt: snapshot.at || null },
    refs: [mergedId],
  })
  return { id: mergedId, status: 'archived', undone: true }
}

export function startGlobalCuration(ctx, { sessionIds, parentSessionId, model } = {}) {
  const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).filter((s) => typeof s === 'string' && s.trim()))]
  const jobId = `curate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const abort = new AbortController()
  const job = {
    id: jobId,
    status: 'running',
    step: 'queued',
    logs: [],
    createdAt: new Date().toISOString(),
    endedAt: null,
    error: null,
    result: null,
    abort,
  }
  jobs.set(jobId, job)
  const log = (line) => {
    job.logs.push(`[${new Date().toISOString()}] ${line}`)
    if (job.logs.length > 200) job.logs.splice(0, job.logs.length - 200)
  }

  void (async () => {
    try {
      if (ids.length === 0) throw new Error('select at least one conversation')
      if (ids.length > MAX_SESSIONS) throw new Error(`at most ${MAX_SESSIONS} conversations per curation`)
      const sessionQuery = ctx.get?.('sessionQuery')
      if (!sessionQuery) throw new Error('sessionQuery is unavailable')
      const agents = ctx.get?.('agents')
      const parent = agents?.get?.(parentSessionId)
      if (!parent) throw new Error('the current conversation is not live; open a live conversation and retry')
      const subagents = ctx.get?.('subagents')
      if (!subagents?.startActivation) throw new Error('subagents service is unavailable')

      job.step = 'reading sessions'
      log(`reading ${ids.length} session(s)`)
      const meta = await readSessionMeta(sessionQuery, ids)
      const sessions = []
      let total = 0
      let transcriptTokens = 0
      for (const id of ids) {
        if (abort.signal.aborted) throw new Error('cancelled by user')
        const snapshot = await readSession(sessionQuery, id)
        const record = meta.get(id)
        const header = snapshot.header || record?.header || {}
        const remaining = Math.max(2000, Math.min(MAX_SESSION_CHARS, MAX_TOTAL_CHARS - total))
        // C2：token 预算跨会话累计（30k），与字符预算同时生效；先停谁算谁。
        const tokenRemaining = Math.max(500, MAX_TRANSCRIPT_TOKENS - transcriptTokens)
        const transcript = condenseEvents(snapshot.events, remaining, { maxTokens: tokenRemaining })
        total += transcript.length
        transcriptTokens += estTokens(transcript)
        sessions.push({
          id,
          title: record?.title || record?.displayTitle || header.title || '',
          createdAt: header.createdAt || null,
          cwd: header.cwd || '',
          agentPreset: header.agentPreset || '',
          live: record?.live === true,
          transcript,
        })
        if (total >= MAX_TOTAL_CHARS || transcriptTokens >= MAX_TRANSCRIPT_TOKENS) break
      }

      // —— §4.5/§6.6（包 F1）：相关性打包索引（4000 tokens）+ 候选簇（2000 tokens），
      // 取代旧 compactGlobalIndex 的"插入顺序前 200 条"平铺。sessionCorpus 同步构建，
      // 提交层证据落地（§4.6）用同一份转录做回放校验。
      const globalIndex = loadGlobalIndex()
      const sessionText = sessions.map((s) => s.transcript).join('\n')
      const packedIndex = packCuratorIndexContext({ index: globalIndex, sessionText })
      const packedClusters = packCuratorClusterContext(buildCandidateClusters(globalIndex))
      const input = JSON.stringify({
        sessions,
        existing_global_index: packedIndex.entries,
        index_truncated: packedIndex.omitted > 0,
        candidate_clusters: packedClusters.clusters,
        clusters_truncated: packedClusters.truncated,
      })
      const prompt = loadPrompt('global-curator', { input }).text
      job.step = 'curator running'
      log('starting non-main curator subagent')
      const activation = await subagents.startActivation({
        provider: 'spawn',
        label: 'dsh-memu-memory global curator',
        delivery: 'caller',
        signal: abort.signal,
        request: {
          parent,
          cwd: parent.session?.header?.cwd,
          prompt: [{ type: 'text', text: prompt }],
          ...(agentOptionsFor(model || getSettings().curatorModel)
            ? { agentOptions: agentOptionsFor(model || getSettings().curatorModel) }
            : {}),
        },
      })
      let result
      try {
        result = await activation.result
      } finally {
        try { await activation.dispose() } catch {}
      }
      if (result?.stopReason !== 'completed') {
        throw new Error(`curator stopped: ${result?.stopReason || 'unknown'}`)
      }
      const text = textOf(result.output)
      const output = parseJsonObject(text)
      if (!output || !Array.isArray(output.memories)) {
        throw new Error(`curator did not return valid JSON: ${truncate(text, 800)}`)
      }
      job.step = 'committing'
      // 生产调用必须传会话语料（§4.6.6）：证据 quote 要能在本次策划的转录里回放，
      // 否则一律 pending。transcripts 已在 condenseEvents 里脱敏。
      const committed = await commitCuratorOutput(output, {
        job,
        sessionCorpus: buildEvidenceCorpus(sessions.map((s) => ({ id: s.id, transcript: s.transcript }))),
      })
      job.status = 'completed'
      job.endedAt = new Date().toISOString()
      job.result = {
        sessions: output.sessions || [],
        domainSummary: output.domain_summary || {},
        created: committed.created,
        merged: committed.merged,
        superseded: committed.superseded,
        linked: committed.linked || 0,
        skipped: committed.skipped,
      }
      log(`done: ${committed.created} created, ${committed.merged} merged, ${committed.superseded} superseded, ${committed.linked || 0} linked`)
    } catch (error) {
      const aborted = abort.signal.aborted || /cancelled by user/.test(String(error?.message || ''))
      job.status = aborted ? 'cancelled' : 'error'
      job.error = String(error?.message || error)
      job.endedAt = new Date().toISOString()
      log(`${job.status}: ${job.error}`)
    }
  })()

  return getCurationJob(jobId)
}

export { readSession as readSessionSnapshot }
