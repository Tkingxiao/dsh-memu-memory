// P1-1 召回缓存。
//
// 设计偏离说明：设计稿用 `lru-cache` npm 依赖，本仓库依赖极少且无构建步骤，
// 改为内置手写 LRU（Map 删除再插入实现新鲜度），不新增依赖。
//
// 失效模型（三层，见 lib/memory.js managedRecall 的接线注释）：
//   1. TTL（默认 120s）：兜底一切漏网——跨进程写入、expiresAt 到点、外部编辑。
//   2. 键内 revision/generation：调用方把 state.js memoryRevision()（所有索引/状态
//      写入在 saveXxxIndex/saveState 收敛处自增）和 captureGeneration() 的向量代数
//      token 传进 recallCacheKey，任一变化键即变，旧条目自然失联。
//   3. bumpGeneration()：缓存内部代数 +1，全部旧键立即失联——测试与运维的手动闸。
//
// fail-open 纪律（AGENTS.md §1 规则 10）：缓存自身出错绝不影响召回。所有公开方法
// 内部 try/catch，出错按「未命中」处理并 errors++ 留痕；本模块不持有 logger，
// 通过 onError 回调（setErrorHandler，由 memory.js 接 warn）和 stats() 的
// errors/lastError 把真实故障暴露给调用方，绝不静默吞掉。

const SEP = '\u0000'

function cloneValue(value) {
  // 缓存值必须是可 structuredClone 的纯数据（召回结果本就跨 RPC 序列化，满足）。
  // 每次写入/读取都深拷贝：同一份缓存结果会被多个回合共享，克隆隔离调用方的就地
  // 变异，避免一次变异污染后续所有命中。
  return structuredClone(value)
}

export function createRecallCache({ max = 256, ttlMs = 120000, now = () => Date.now(), onError = null } = {}) {
  const limit = Math.max(1, Math.floor(Number(max)) || 1)
  const ttl = Math.max(0, Math.floor(Number(ttlMs)) || 0)
  const clock = typeof now === 'function' ? now : () => Date.now()
  const map = new Map() // key: gen + SEP + key → { value, expiresAt, query, gen }
  const inflight = new Map() // key: gen + SEP + key → Promise（同 key 在途合并，防击穿）
  let gen = 0
  let hits = 0
  let misses = 0
  let evictions = 0
  let errors = 0
  let lastError = null

  const fail = (op, error, key = null) => {
    errors += 1
    const message = String(error?.message || error)
    lastError = op + ': ' + message
    try { if (typeof onError === 'function') onError({ op, key, message }) } catch {}
  }

  const ckey = (key) => gen + SEP + String(key)

  // 过期即删即逐出（计入 evictions），不参与命中。
  const expired = (entry) => clock() >= entry.expiresAt

  const peek = (ck) => {
    const entry = map.get(ck)
    if (!entry) return null
    if (expired(entry)) {
      map.delete(ck)
      evictions += 1
      return null
    }
    // LRU 新鲜度：命中即挪到 Map 尾部（删除再插入）。
    map.delete(ck)
    map.set(ck, entry)
    return entry
  }

  const evictOverflow = () => {
    while (map.size > limit) {
      const oldest = map.keys().next().value
      map.delete(oldest)
      evictions += 1
    }
  }

  const store = (ck, value) => {
    if (value === undefined) return // undefined 视为「没有结果」，不缓存
    const snapshot = cloneValue(value)
    map.delete(ck)
    // 条目归属的代数取自复合键前缀：在途 producer 在 bump 之后落地时，仍记旧代，
    // 下一次 bump 会被清理，也永远不会被新代命中。
    map.set(ck, { value: snapshot, expiresAt: clock() + ttl, gen: Number(ck.slice(0, ck.indexOf(SEP))) })
    evictOverflow()
  }

  const cache = {
    /** 命中返回深拷贝（可计数），未命中返回 null。 */
    get(key) {
      try {
        const entry = peek(ckey(key))
        if (!entry) { misses += 1; return null }
        const value = cloneValue(entry.value)
        hits += 1
        return value
      } catch (error) { fail('get', error, key); return null }
    },
    /** 写入失败（值不可克隆等）只计数不抛出；undefined 不缓存。 */
    set(key, value) {
      try { store(ckey(key), value) } catch (error) { fail('set', error, key) }
    },
    /** 全局代数 +1：旧代条目全部失联并清理，在途请求落回旧代键（无害失联）。 */
    bumpGeneration() {
      try {
        gen += 1
        for (const [ck, entry] of map) {
          if (entry.gen !== gen) { map.delete(ck); evictions += 1 }
        }
      } catch (error) { fail('bumpGeneration', error) }
    },
    /** 按 query 精确失效。键是 recallCacheKey 的 JSON 串，解析出规范化 query 比对；
     *  非 JSON 键跳过。返回失效条数。 */
    invalidate(query) {
      try {
        const normalized = String(query ?? '').normalize('NFKC').trim().toLowerCase()
        let removed = 0
        for (const [ck, entry] of map) {
          try {
            if (JSON.parse(ck.slice(ck.indexOf(SEP) + 1)).query === normalized) {
              map.delete(ck)
              removed += 1
              evictions += 1
            }
          } catch {}
        }
        return removed
      } catch (error) { fail('invalidate', error, query); return 0 }
    },
    /** 清空 = 代数 +1 + 清理：在途 producer 落回旧代键，不会把旧值写进新代。 */
    clear() {
      try { cache.bumpGeneration() } catch (error) { fail('clear', error) }
    },
    /**
     * 命中直接返回缓存值；未命中调 producer（可 async）并缓存；同 key 在途请求合并
     * （promise 去重，防击穿，计入 hits）。producer 抛错不缓存、原样透传。
     * 代数在进入 wrap 时捕获：在途期间发生 bump/clear，结果落回旧代键，不会污染新代。
     */
    wrap(key, producer) {
      let ck = null
      try {
        ck = ckey(key)
        const entry = peek(ck)
        if (entry) {
          const value = cloneValue(entry.value)
          hits += 1
          return value
        }
      } catch (error) { fail('wrap.get', error, key) }
      if (ck !== null) {
        const pending = inflight.get(ck)
        if (pending) { hits += 1; return pending } // 在途合并：与命中同计
      }
      misses += 1
      const run = (async () => {
        const value = await producer()
        if (ck !== null) {
          try { store(ck, value) } catch (error) { fail('wrap.set', error, key) }
        }
        return value
      })()
      if (ck !== null) {
        inflight.set(ck, run)
        const settle = () => { inflight.delete(ck) }
        run.then(settle, settle)
      }
      return run
    },
    stats() {
      return { size: map.size, hits, misses, evictions, generations: gen, errors, lastError, inflight: inflight.size }
    },
    /** 接错误观察者（memory.js 接 warn，规则 10 的可观测信号）。 */
    setErrorHandler(handler) {
      try { onError = typeof handler === 'function' ? handler : null } catch (error) { fail('setErrorHandler', error) }
    },
  }
  return cache
}

/**
 * 缓存键：query 做 NFKC + trim + lowercase 规范化，其余字段定序 JSON.stringify。
 * 除任务规定的 query/topK/libraryId/byId/route/generation 外，另含四个能改变融合
 * 结果的输入（缺失记 null，保证同参同键）：
 *   · revision  — state.js memoryRevision()，索引/状态写入的进程内单调计数（写路径失效）
 *   · domain    — globalRecall 按域预过滤、cross-library 按域裁剪索引
 *   · sessionId — fuseRecallCandidates 的 visibleToSession 按会话过滤
 *   · context   — 绑定的 memoryContext（knownBy/characterId 改绑不改写索引，revision 不动）
 *   · automatic — fuseRecallCandidates 的 isMemoryEligible/secret 规则随它翻转
 */
export function recallCacheKey({ query, topK, libraryId, byId, route, generation, revision, domain, automatic, sessionId, context } = {}) {
  return JSON.stringify({
    v: 1,
    generation: generation ?? null,
    revision: revision ?? null,
    route: route ?? null,
    libraryId: libraryId ?? null,
    topK: Number(topK) || 0,
    domain: domain ?? null,
    automatic: automatic === true,
    byId: byId === true,
    sessionId: sessionId ?? null,
    context: context ?? null,
    query: String(query ?? '').normalize('NFKC').trim().toLowerCase(),
  })
}

/** 模块级默认单例：memory.js 直接使用。 */
export const recallCache = createRecallCache()
