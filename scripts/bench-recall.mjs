// 召回基准台（1.3.0 P1-3）：对比 HEAD 基线与施工后 lib 的检索质量与延迟。
//
// 用法：
//   node scripts/bench-recall.mjs                     # 测当前仓库 lib
//   node scripts/bench-recall.mjs --lib <路径>/lib    # 测指定 lib（如 HEAD 基线 worktree）
//
// 设计：
// - 完全确定性：语料与查询由固定种子 LCG 生成，两次运行同输入同输出，前后版本可比。
// - 指标：rankPairCandidates 延迟（N=300 精确两两 / N=2000 blocking 两档）、
//   buildCandidateClusters 延迟、Recall@10 / MRR（查询 → 目标条目是否进前 10）。
// - 不引入任何依赖；被测导出（buildCorpus/rankPairCandidates/buildCandidateClusters）
//   是 curator.js/global-graph.js 的既有公共面，任何施工都不应改动其签名。

import { pathToFileURL, fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

function parseLibArg(argv) {
  const i = argv.indexOf('--lib')
  if (i >= 0 && argv[i + 1]) return String(argv[i + 1]).replace(/[\\/]+$/, '')
  return fileURLToPath(new URL('../lib', import.meta.url)).replace(/[\\/]+$/, '')
}

// —— 确定性随机（mulberry32 风格，无 clock/全局态）——
function lcg(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// —— 合成语料：中英混合的记忆条目 ——
const CN_TOPICS = ['缓存策略', '部署流程', '数据库备份', '通知偏好', '角色设定', '会话管理', '向量检索', '日志轮转', '权限边界', '情绪记忆']
const CN_DETAIL = ['统一走内存队列', '保留 14 天后轮转', '每天凌晨三点执行', '失败时只发一次告警', '按库串行化写入', '先回应当下再回扣过去', '召回前先查旧条目', '到期前升级为长期', '跨域只 link 不吸收', '冲突进入待复核']
const EN_TOKENS = ['redis', 'postgres', 'bm25', 'embedding', 'workspace', 'session', 'curator', 'checkpoint', 'rollback', 'throttle']
const DOMAINS = ['coding', 'rp', 'general']

function makeEntry(rand, id) {
  const topic = CN_TOPICS[Math.floor(rand() * CN_TOPICS.length)]
  const detail = CN_DETAIL[Math.floor(rand() * CN_DETAIL.length)]
  const en = EN_TOKENS[Math.floor(rand() * EN_TOKENS.length)]
  const domain = DOMAINS[Math.floor(rand() * DOMAINS.length)]
  return {
    id: `mem-${String(id).padStart(4, '0')}`,
    title: `${topic}（${en}）`,
    content: `${topic}${detail}，${en} 相关配置在 2026-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)} 调整过，适用域 ${domain}。`,
    track: 'memory',
    domain,
    appliesTo: rand() < 0.4 ? [`entity-${Math.floor(rand() * 8)}`] : [],
    updatedAt: `2026-11-${String(1 + Math.floor(rand() * 27)).padStart(2, '0')}T10:00:00Z`,
    status: 'active',
  }
}

function buildEntries(n, seed = 20261106) {
  const rand = lcg(seed)
  return Array.from({ length: n }, (_, i) => makeEntry(rand, i))
}

// —— 评测查询：目标条目的换序改写（测试「换个说法还能不能找回」）——
function buildQueries(entries, rand) {
  return entries.map((entry) => {
    const en = (entry.title.match(/[a-z0-9]+/i) || ['memory'])[0]
    const topic = entry.title.split(/（/)[0]
    const query = rand() < 0.5
      ? `之前关于${topic}和 ${en} 的那条记忆`
      : `${en} ${topic} 是怎么定的来着`
    return { query, target: entry.id }
  })
}

function recallAtK(results, target, k = 10) {
  return results.slice(0, k).some((r) => r.id === target) ? 1 : 0
}

function mrr(results, target) {
  const i = results.findIndex((r) => r.id === target)
  return i < 0 ? 0 : 1 / (i + 1)
}

function bench(name, fn, runs = 5) {
  // 预热一次再计时，取中位数，避免首跑 JIT/IO 噪声。
  fn()
  const samples = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  samples.sort((a, b) => a - b)
  return { name, median: samples[Math.floor(runs / 2)], min: samples[0] }
}

async function main() {
  const libPath = parseLibArg(process.argv)
  const mod = await import(pathToFileURL(`${libPath}/text-retrieval.js`).href)
  const { buildCorpus, rankPairCandidates, buildCandidateClusters } = mod
  console.log(`被测 lib: ${libPath}`)
  if (typeof mod.tokenize === 'function') {
    const probe = JSON.stringify([...new Set(mod.tokenize('向量检索与缓存策略'))])
    console.log(`tokenize 探针: ${probe.slice(0, 120)}`)
  }

  // —— 延迟：N=300（精确两两档）与 N=2000（blocking 档）——
  for (const n of [300, 2000]) {
    const entries = buildEntries(n)
    const corpus = buildCorpus(entries.map((e) => ({ ...e })))
    const proposal = entries[Math.floor(n / 2)]
    const r1 = bench(`rankPairCandidates N=${n}`, () => rankPairCandidates({ corpus, proposal, limit: 20 }))
    console.log(`${r1.name.padEnd(34)} median=${r1.median.toFixed(2)}ms  min=${r1.min.toFixed(2)}ms`)
  }

  // —— 延迟：候选簇（§4.4）——
  {
    const entries = buildEntries(500)
    const index = Object.fromEntries(entries.map((e) => [e.id, e]))
    const r2 = bench('buildCandidateClusters N=500', () => buildCandidateClusters(index), 3)
    console.log(`${r2.name.padEnd(34)} median=${r2.median.toFixed(2)}ms  min=${r2.min.toFixed(2)}ms`)
  }

  // —— 质量：Recall@10 / MRR ——
  {
    const entries = buildEntries(400)
    const rand = lcg(99)
    const queries = buildQueries(entries, rand)
    const corpus = buildCorpus(entries.map((e) => ({ ...e })))
    let hit10 = 0
    let rrSum = 0
    for (const { query, target } of queries) {
      const results = rankPairCandidates({ corpus, proposal: { title: query, content: '', track: 'memory', domain: 'general' }, limit: 20 })
      hit10 += recallAtK(results, target)
      rrSum += mrr(results, target)
    }
    const n = queries.length
    console.log(`Recall@10 = ${(hit10 / n).toFixed(4)}  MRR = ${(rrSum / n).toFixed(4)}  (queries=${n})`)
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
