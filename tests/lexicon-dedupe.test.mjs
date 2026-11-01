// 历史重复词条迁移工具（scripts/lexicon-dedupe.mjs）的端到端测试：
// 通过子进程跑真实 CLI（dry-run / --apply 两条路径），fixture 直接写
// data/lexicon/<id>.json，覆盖：可合并重复组、active+sensitive 跳过、
// 跨作用域同词不合并、pending revision 草稿不当作重复。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const scriptPath = path.join(here, '..', 'scripts', 'lexicon-dedupe.mjs')

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-lexicon-dedupe-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const paths = await import('../lib/paths.js')
const lexicon = await import('../lib/lexicon.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function runCli(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_MEMU_HOME: home },
    timeout: 60_000,
  })
}

function entryOf(overrides, termId, extra = {}) {
  return {
    term: overrides.term,
    normalizedTerm: lexicon.normalizeLexeme(overrides.term),
    normalizedAliases: (overrides.aliases || []).map(a => lexicon.normalizeLexeme(a)),
    kind: 'term',
    meaning: overrides.meaning || '',
    usage: overrides.usage || '',
    aliases: overrides.aliases || [],
    examples: overrides.examples || [],
    context: overrides.context || {},
    knownBy: overrides.knownBy,
    visibility: 'shared',
    sensitivity: overrides.sensitivity || 'normal',
    strength: overrides.strength ?? 0.5,
    confidence: overrides.confidence ?? 0.7,
    status: overrides.status || 'active',
    source: 'user',
    evidence: overrides.evidence || [],
    fingerprint: `fp-${termId}`,
    createdAt: overrides.createdAt || '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-01-01T00:00:00.000Z',
    hitCounts: overrides.hitCounts || { candidate: 0, injection: 0, query: 0 },
    lastInjectedAt: null,
    ...extra,
  }
}

// ---- fixture：一本含四种形态的词典 ----
const library = state.createLibrary({ name: 'dedupe-fixture', cwd: path.join(home, 'dedupe') })
const lexFile = path.join(home, 'lexicon', `${library.id}.json`)

const A1 = 'lex-dup-a1', A2 = 'lex-dup-a2', A3 = 'lex-dup-a3', DRAFT = 'lex-dup-draft'
const S1 = 'lex-dup-s1', S2 = 'lex-dup-s2'
const C1 = 'lex-dup-c1', C2 = 'lex-dup-c2'

const fixture = {
  version: 1,
  revision: 7,
  libraryId: library.id,
  rejected: {
    'fp-lex-dup-a3': { termId: A3, reason: '历史驳回记录', at: '2026-03-01T00:00:00.000Z' },
  },
  terms: {
    // 组 A：同词同作用域三条（active 旧 / active 新 / rejected）+ 一条 active 的待审修订草稿。
    [A1]: entryOf({ term: '糖刀', meaning: '短义', aliases: ['糖里藏刀'], strength: 0.3, status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' }, A1),
    [A2]: entryOf({ term: '糖刀', meaning: '较长的保留条目含义', aliases: [], examples: ['保留条目的例句'], strength: 0.9, status: 'active', updatedAt: '2026-02-01T00:00:00.000Z' }, A2),
    [A3]: entryOf({
      term: '糖刀',
      meaning: '被驳回条目里最长的含义文本，合并时应当胜出成为保留条目的含义',
      aliases: ['刀里藏糖'],
      examples: ['驳回条目的例句'],
      strength: 0.5,
      status: 'rejected',
      evidence: [{ kind: 'message', id: 'm-1', quote: '这条留言是证据' }],
      hitCounts: { candidate: 4, injection: 1, query: 2 },
      updatedAt: '2026-03-01T00:00:00.000Z',
    }, A3),
    // 待审修订草稿（revisionOf 指向 A2）：不是重复，必须原样保留。
    [DRAFT]: entryOf({ term: '糖刀', meaning: '草稿含义', status: 'pending', updatedAt: '2026-04-01T00:00:00.000Z' }, DRAFT, { revisionOf: A2, previousRevision: 6 }),
    // 组 S：active+sensitive 与其 pending 重复 → 整组跳过。
    [S1]: entryOf({ term: '红牌', meaning: '敏感触发词', kind: 'trigger', sensitivity: 'sensitive', status: 'active' }, S1),
    [S2]: entryOf({ term: '红牌', meaning: '重复的敏感触发词', kind: 'trigger', sensitivity: 'sensitive', status: 'pending' }, S2),
    // 组 C：同词跨作用域 → 不是重复。
    [C1]: entryOf({ term: '月引', meaning: 'w1 的月引', context: { worldId: 'w1' } }, C1),
    [C2]: entryOf({ term: '月引', meaning: 'w2 的月引', context: { worldId: 'w2' } }, C2),
  },
}
paths.writeJson(lexFile, fixture)

const readStore = () => JSON.parse(fs.readFileSync(lexFile, 'utf8'))

test('dry-run reports duplicate groups without touching a single byte', () => {
  const before = fs.readFileSync(lexFile)
  const run = runCli([])
  assert.equal(run.status, 0, `dry-run exits 0: ${run.stderr}`)
  const out = run.stdout
  assert.match(out, /dry-run/)
  assert.match(out, /重复组 2 组/, '组 A 与组 S 是重复组；组 C 跨作用域不算')
  assert.match(out, new RegExp(`保留 ${A2}`), '组 A 保留 active 且 updatedAt 新的 A2')
  assert.match(out, new RegExp(`并入并删除: ${A1}, ${A3}`))
  assert.match(out, /active\+sensitive/, '组 S 因 active+sensitive 被跳过')
  assert.match(out, /mergedFrom 记入: \[lex-dup-a1, lex-dup-a3\]/)
  assert.deepEqual(fs.readFileSync(lexFile), before, 'dry-run must not modify the file')
})

test('--apply merges duplicate groups, keeps sensitive/cross-scope entries and the revision draft', () => {
  const run = runCli(['--apply'])
  assert.equal(run.status, 0, `apply exits 0: ${run.stderr}`)
  const store = readStore()

  // 组 A：只剩保留条目 + 待审草稿。
  assert.equal(store.terms[A1], undefined, 'A1 merged away')
  assert.equal(store.terms[A3], undefined, 'A3 merged away')
  const kept = store.terms[A2]
  assert.ok(kept, 'A2 kept')
  assert.deepEqual(kept.mergedFrom, [A1, A3], 'mergedFrom records the removed ids for audit')
  assert.equal(kept.meaning, fixture.terms[A3].meaning, 'meaning takes the longest across the group')
  assert.deepEqual([...kept.aliases].sort(), ['刀里藏糖', '糖里藏刀'], 'aliases are the deduplicated union')
  assert.deepEqual(kept.examples.sort(), ['保留条目的例句', '驳回条目的例句'].sort())
  assert.equal(kept.strength, 0.9, 'strength takes the max')
  assert.equal(kept.status, 'active')
  assert.equal(kept.evidence.length, 1, 'evidence merged from the rejected member')
  assert.deepEqual(kept.hitCounts, { candidate: 4, injection: 1, query: 2 }, 'hit counts sum across the group')
  // 拒绝指纹改指保留条目。
  assert.equal(store.rejected['fp-lex-dup-a3'].termId, A2, 'the rejected fingerprint now points at the kept entry')
  // 草稿、敏感组、跨作用域都原样。
  assert.equal(store.terms[DRAFT].status, 'pending', 'the active term\'s revision draft is not a duplicate')
  assert.equal(store.terms[DRAFT].revisionOf, A2)
  assert.ok(store.terms[S1] && store.terms[S2], 'the active+sensitive group is untouched')
  assert.equal(store.terms[S1].meaning, '敏感触发词')
  assert.ok(store.terms[C1] && store.terms[C2], 'cross-scope same word is not a duplicate')
  assert.ok(store.revision > 7, 'the revision advanced')
  // 结果仍然是一本可严格读取的词典：8 条 − 2 条被并 = 6 条。
  const loaded = lexicon.loadLexicon(library.id)
  assert.ok(loaded.terms[A2])
  assert.equal(Object.keys(loaded.terms).length, 6)
})

test('the merged library still enforces write-side uniqueness (no re-creation of duplicates)', () => {
  // 非敏感字段（usage）原地更新：撞上的是保留条目 A2，绝不会新建重复词条。
  const keptMeaning = readStore().terms[A2].meaning
  const upsert = lexicon.upsertLexiconTerm({ libraryId: library.id, term: '糖刀', kind: 'term', meaning: keptMeaning, usage: '再次直接写入' })
  assert.equal(upsert.created, false)
  assert.equal(upsert.term.termId, A2, 'the kept entry is the collision target, exactly like a never-duplicated term')
})

test('--library narrows the scan; unsafe ids are a typed usage error', () => {
  const run = runCli(['--library', library.id])
  assert.equal(run.status, 0)
  assert.match(run.stdout, /重复组 1 组/, 'only the skipped active+sensitive group remains')
  assert.match(run.stdout, /active\+sensitive/, 'reported as skipped, never touched')
  assert.match(run.stdout, /dry-run 未写入/)
  const bad = runCli(['--library', '../escape'])
  assert.equal(bad.status, 2, 'bad --library is a usage error, not a crash')
  assert.match(bad.stderr, /invalid library id/)
})
