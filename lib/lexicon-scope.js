// ── 词典读取作用域（§8.13 / §8.15）：一个会话读哪几本词典 ──────────────────────────
// 记忆侧的跨库召回（`crossLibraryRecall`）只管 `privateRecall` / `privateList`，词典
// 走的是另一条链（锚点摘要、B 通道匹配、模型检索）。两条链必须回答同一个「我看得见
// 哪些词条」，否则同一个开关下记忆跨库、词典不跨库，用户读到的是半套同步。
//
// 三份数据、三种过滤，全部沿用记忆侧已有的尺子：
//   * 当前绑定库：主源，条目**不**按 domain 过滤（保持旧行为，§8.15「当前绑定库始终参与」）。
//   * 其它同领域库：只有 `settings.crossLibraryRecall === true` 才进候选，资格判定直接
//     复用 memory.js 的 `crossLibrarySources`（同领域、非整理 fork、文件夹没关私有记忆、
//     未归档），条目再按 `entry.domain` 过滤——旧词条没有 domain 时放行。
//   * 全局词典：与全局记忆同构（`global.json` 的词条版）。不看跨库开关，只受
//     `useGlobal` 天花板约束；条目过滤复用 `appliesToDomain`（universal/personal 恒可见，
//     其余要等于当前领域）。
//
// 写入不在本模块：模型与整理链路只写当前绑定库，全局词典只有用户能从管理面写
// （§1 硬规则二「主 agent 只读全局」）。
//
// 失败口径：主源读失败继续抛（调用方按 §1.10 fail-open 留可观测信号）；辅源（同域库、
// 全局）读失败只降级成 `errors`，一本坏掉的词典不该把整段词典注入带走。
import {
  getSettings, getLibrary, effectiveScope,
} from './state.js'
import { appliesToDomain, crossLibrarySources, domainOf } from './memory.js'
import {
  GLOBAL_LEXICON_ID, matchLexiconHits, rankLexiconHits, searchLexicon, visibleLexiconTerms,
} from './lexicon.js'

// 同域其它库的条目过滤：与 memory.js domainScopedIndex 同口径——没有 domain 的旧词条
// 依赖「该库的绑定会话领域已匹配」放行，带 domain 的必须等于当前领域。
function privateEntryVisible(entry, domain, { primary }) {
  if (primary) return true
  return !entry?.domain || entry.domain === domain
}

// 全局词条的过滤与全局记忆同一条尺（universal / personal / project:<name> / appliesTo）。
// 没有 domain 的词条按「通用」处理：全局词典由用户在管理面手写，不写领域，
// 拿全局记忆的 `unknown → 不可见` 直接套上去会把既有词条全隐藏掉。
function globalEntryVisible(entry, binding) {
  if (!entry?.domain) return true
  return appliesToDomain(entry, binding)
}

/**
 * 这个会话到底读不读词典。私有记忆关掉时全局词典仍然要读（全局记忆同理），
 * 所以不能沿用 `binding.libraryId && useLibrary` 那把旧尺。
 */
export function lexiconScopeAllowed(binding) {
  return lexiconSources(binding).length > 0
}

/**
 * 这个会话看得见哪几本词典。顺序即优先级：当前库 → 同域其它库 → 全局词典
 * （「私有优先、全局补充」）。`primary` 只给当前绑定库——它是唯一不参与
 * domain 过滤的来源，也是唯一可写的库。
 */
export function lexiconSources(binding, { settings = getSettings() } = {}) {
  const domain = domainOf(binding)
  const scope = effectiveScope(binding)
  const hasPrivate = Boolean(binding?.libraryId) && scope.useLibrary !== false
  const candidates = !hasPrivate
    ? []
    : (settings.crossLibraryRecall === true
      ? crossLibrarySources(binding, domain)
      : [{ libraryId: binding.libraryId, primary: true }])
  const sources = candidates.map((source) => ({
    libraryId: source.libraryId,
    scope: 'private',
    primary: source.primary === true,
    name: getLibrary(source.libraryId)?.name || source.libraryId,
  }))
  if (scope.useGlobal !== false) {
    sources.push({ libraryId: GLOBAL_LEXICON_ID, scope: 'global', primary: false, name: null })
  }
  return sources
}

/**
 * 逐源读取的公共骨架：按优先级读每本词典 → 作用域过滤 → 打来源标 → 按词面去重。
 * `read(source)` 返回该源的可见行（带 termId），去重保留第一个来源的副本，所以同词面
 * 在私有库与全局词典里各有一份时，私有那份胜出（与记忆侧的冲突口径一致）。
 */
function eachSource(binding, sources, read) {
  const domain = domainOf(binding)
  const rows = []
  const errors = []
  const seen = new Set()
  // 单源不换路：一本词典内部本来允许同词面跨 scope 共存（findScopeCollision 只在
  // sameFactContext 内判重），去重只有跨源才有意义。
  const dedupe = sources.length > 1
  for (const source of sources) {
    let found = []
    try {
      found = read(source) || []
    } catch (error) {
      if (source.primary) throw error
      errors.push(`${source.libraryId}: ${error?.message || error}`)
      continue
    }
    const keep = source.scope === 'global'
      ? (entry) => globalEntryVisible(entry, binding)
      : (entry) => privateEntryVisible(entry, domain, { primary: source.primary })
    for (const entry of found) {
      if (!keep(entry)) continue
      const surface = entry?.normalizedTerm || entry?.term
      if (dedupe && surface) {
        if (seen.has(surface)) continue
        seen.add(surface)
      }
      rows.push({ ...entry, libraryId: source.libraryId, lexiconScope: source.scope, libraryName: source.name })
    }
  }
  return { rows, errors }
}

/** 锚点摘要的数据面：本会话可见的全部词条（active、context 可见、按源去重）。 */
export function lexiconVisibleTerms(binding, { includeArchived = false } = {}) {
  const sources = lexiconSources(binding)
  const { rows, errors } = eachSource(binding, sources, (source) => visibleLexiconTerms(source.libraryId, binding?.memoryContext || {}, { includeArchived }))
  return { terms: rows, errors, sources }
}

/**
 * B 通道匹配面：跨源命中用核心的 `rankLexiconHits` 重排——排序尺子只有一把，
 * 在核心里，合并方不自定顺序。
 */
export function lexiconMatch(binding, text) {
  const sources = lexiconSources(binding)
  const { rows, errors } = eachSource(binding, sources, (source) => matchLexiconHits(source.libraryId, text, binding?.memoryContext || {}))
  return { hits: rankLexiconHits(rows), errors, sources }
}

/** 模型检索面（memu_lexicon_search）：核心已按 matchedBy 排过，合并只保留优先级序。 */
export function lexiconSearch(binding, query, { includeArchived = false } = {}) {
  const sources = lexiconSources(binding)
  const { rows, errors } = eachSource(binding, sources,
    (source) => searchLexicon({ libraryId: source.libraryId, query, memoryContext: binding?.memoryContext || {} }, { includeArchived }))
  return { items: rows, errors, sources }
}

/** 这一条命中/候选属于哪本词典：计数必须落在词条所在的库，不能全记到当前库。 */
export function lexiconHitLibraryId(hit, fallback) {
  return hit?.libraryId || fallback || null
}
