/**
 * 主动记忆判定：一次闲时检查值不值得花 token。
 *
 * 三条输入都是"结构性"的，不做关键词判定：
 *   H 真人回合数（只算 source.kind === 'user' 的消息）
 *   C 新增证据量（真人文字 + 助手结论 + 去重后的工具结果，按字符估算）
 *   U 有效工具工作单元（去重的成功工具结果；轮询、空输出、重复错误只算一次）
 *
 * 触发规则（可被 settings 覆盖）：
 *   - 会话空闲 < activeMemoryStarvationMinutes：分数必须 >= minScore；
 *   - 空闲 >= 饥饿阈值：小会话无条件检查（保证不会永远轮不到）；
 *   - 大 transcript（>= largeTranscriptEvents）不吃饥饿豁免：真机回放里
 *     5913 条事件的会话，一个"继续"回合只有 0.14~0.43 分，却会把整段
 *     26MB 转录重新种进 fork；这种薄回合必须等分数达标；
 *   - 近期刚整理过 / 刚注入过记忆：直接抑制，避免"记忆后立刻再 fork 一次"。
 *
 * 纯函数，无 IO，便于回放标定与单测。
 */

export const ACTIVE_MEMORY_VERSION = 1

export const ACTIVE_MEMORY_POLICY = Object.freeze({
  version: ACTIVE_MEMORY_VERSION,
  minScore: 0.8,
  starvationMinutes: 15,
  consolidatedCooldownMinutes: 60,
  recallCooldownMinutes: 15,
  humanTurnsCap: 3,
  evidenceCharsCap: 4000,
  toolUnitsCap: 20,
  partCap: 2,
  // 超过这个规模，fork 的种子成本随整段转录增长，饥饿不再单独构成理由。
  largeTranscriptEvents: 2000,
  // 大 transcript 的守卫只该推迟一次检查，不该无限推迟。待整理区间一旦超过这个规模，
  // 无论分数多低都要整理一次：游标不前移，那段内容就一直躺在 pending 里等着，
  // 「省 token」和「永远不记」之间的差别是延迟上界，不是覆盖上界。
  // 600 事件大约相当于一次中等长度的会话；20k 事件的首轮整理本来就贵，但那是内容
  // 本身的价格，不是规则造成的浪费。
  maxPendingEvents: 600,
  weights: Object.freeze({ human: 0.35, content: 0.45, tool: 0.2 }),
  // 单个工具结果计入证据量的上限；整段工具日志不能挤掉真人说的话。
  toolResultCharsCap: 2000,
})

function textOfContent(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join(' ')
    .trim()
}

/**
 * 从一个事件窗口里收集证据。窗口应当只包含"上次检查之后"的事件；
 * 调用方负责裁剪，这里不猜测边界。
 */
export function collectEvidence(events, policy = ACTIVE_MEMORY_POLICY) {
  const evidence = {
    humanTurns: 0,
    humanChars: 0,
    assistantChars: 0,
    toolChars: 0,
    toolUnits: 0,
    toolCalls: 0,
    lastHumanText: '',
  }
  const seenUnits = new Set()
  for (const event of events || []) {
    const type = event?.type
    if (type === 'user/message') {
      if (event.data?.source?.kind !== 'user') continue
      const text = textOfContent(event.data?.content)
      if (!text) continue
      evidence.humanTurns += 1
      evidence.humanChars += text.length
      evidence.lastHumanText = text
      continue
    }
    if (type === 'assistant/message') {
      const blocks = event.data?.message?.content
      if (!Array.isArray(blocks)) continue
      for (const block of blocks) {
        if (block?.type === 'tool-call') evidence.toolCalls += 1
        else if (block?.type === 'text' && typeof block.text === 'string') evidence.assistantChars += block.text.trim().length
      }
      continue
    }
    if (type === 'tool/call') {
      evidence.toolCalls += 1
      continue
    }
    if (type === 'tool/result') {
      const message = event.data?.message || {}
      if (message.isError === true) continue
      const text = textOfContent(message.content)
      if (!text) continue
      // 同一份结果重复出现（轮询、重读、重试）只算一次工作单元。
      const key = text.slice(0, 160) + '|' + text.length
      if (seenUnits.has(key)) continue
      seenUnits.add(key)
      evidence.toolUnits += 1
      evidence.toolChars += Math.min(text.length, policy.toolResultCharsCap)
    }
  }
  return evidence
}

/** 可解释评分：每个分项封顶，避免"只刷工具次数"把分数拉满。 */
export function scoreEvidence(evidence, policy = ACTIVE_MEMORY_POLICY) {
  const human = Number(evidence?.humanTurns) || 0
  const contentChars = (Number(evidence?.humanChars) || 0) + (Number(evidence?.assistantChars) || 0) + (Number(evidence?.toolChars) || 0)
  const units = Number(evidence?.toolUnits) || 0
  const h = Math.min(human / policy.humanTurnsCap, policy.partCap)
  const c = Math.min(contentChars / policy.evidenceCharsCap, policy.partCap)
  const u = Math.min(units / policy.toolUnitsCap, policy.partCap)
  const score = policy.weights.human * h + policy.weights.content * c + policy.weights.tool * u
  return {
    score: Math.round(score * 1000) / 1000,
    parts: { human: h, content: c, tool: u, humanTurns: human, contentChars, toolUnits: units },
  }
}

/**
 * 是否唤醒检查。真人回合是硬门槛（纯工具轮询不构成检查理由），
 * 其余交给分数；`starved` 由调用方按空闲时长传入。
 * `transcriptEvents` 是整段会话的事件数，用来决定饥饿豁免是否还有成本意义。
 */
export function assessWake({ evidence, starved = false, transcriptEvents = 0, pendingEvents = 0, policy = ACTIVE_MEMORY_POLICY } = {}) {
  const scored = scoreEvidence(evidence, policy)
  if ((Number(evidence?.humanTurns) || 0) === 0) {
    return { wake: false, reason: 'no-human-turn', ...scored }
  }
  // 积压优先于守卫：守卫的理由是「为一句轻话重种整段转录不划算」，但当整段转录本身
  // 还没整理过时，那不是重种，是欠着。没有这条，一个大 transcript 只要每轮都是轻话，
  // 就永远等不到检查——延迟没有上界，长会话的早期决定再也进不了记忆。
  if (Number(pendingEvents) >= Number(policy.maxPendingEvents || Infinity)) {
    return { wake: true, reason: 'backlog', ...scored }
  }
  const large = (Number(transcriptEvents) || 0) >= policy.largeTranscriptEvents
  if (starved && !large) return { wake: true, reason: 'starved', ...scored }
  if (scored.score < policy.minScore) {
    return { wake: false, reason: large && starved ? 'large-transcript-thin' : 'low-score', ...scored }
  }
  return { wake: true, reason: 'score', ...scored }
}

/**
 * 抑制原因：近期整理过（避免记忆后马上再 fork）或近期注入过记忆。
 * 返回 null 表示不抑制。
 */
export function suppressionReason({
  now = Date.now(),
  lastSleepAt = null,
  lastInjectedAt = null,
  consolidatedCooldownMinutes = ACTIVE_MEMORY_POLICY.consolidatedCooldownMinutes,
  recallCooldownMinutes = ACTIVE_MEMORY_POLICY.recallCooldownMinutes,
} = {}) {
  const sleep = Date.parse(lastSleepAt || '') || 0
  if (sleep && now - sleep < consolidatedCooldownMinutes * 60_000) return 'recent-consolidation'
  const recalled = Date.parse(lastInjectedAt || '') || 0
  if (recalled && now - recalled < recallCooldownMinutes * 60_000) return 'recent-recall'
  return null
}
