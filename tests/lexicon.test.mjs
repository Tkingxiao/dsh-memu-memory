import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-lexicon-'))
process.env.DSH_MEMU_HOME = home

const paths = await import('../lib/paths.js')
const lexicon = await import('../lib/lexicon.js')
const state = await import('../lib/state.js')
const curator = await import('../lib/curator.js')
const migrate = await import('../lib/migrate.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function lexFile(libraryId) {
  return path.join(home, 'lexicon', `${libraryId}.json`)
}

let serial = 0
function newLibrary() {
  serial += 1
  const { id } = state.createLibrary({ name: `lexicon-test-${serial}`, scopeKey: path.join(home, `lexicon-project-${serial}`) })
  return id
}

// ---- P0 存储：路径边界 ----

test('loadLexicon on a missing library returns the empty structure, not null', () => {
  const empty = lexicon.loadLexicon('lex-never-created')
  assert.deepEqual(
    { version: empty.version, revision: empty.revision, terms: empty.terms },
    { version: 1, revision: 0, terms: {} },
  )
})

test('libraryId must pass isSafeId: absolute paths, .. and separators are rejected', () => {
  for (const bad of ['..', '.', 'a/b', 'a\\b', 'C:\\tmp\\x', '/etc/passwd', 'lib x', '']) {
    assert.throws(() => lexicon.loadLexicon(bad), (error) => error.code === 'LEXICON_INVALID_LIBRARY_ID', `expected typed rejection for ${bad}`)
  }
  // 拒绝发生在路径拼接之前：什么文件都没被创建出来。
  assert.equal(fs.existsSync(path.join(home, 'lexicon')), false, 'no lexicon directory may appear for rejected ids')
})

test('a corrupt lexicon file raises a typed error and is never treated as empty', () => {
  const libraryId = newLibrary()
  fs.mkdirSync(path.dirname(lexFile(libraryId)), { recursive: true })
  fs.writeFileSync(lexFile(libraryId), '{ this is not json')
  assert.throws(() => lexicon.loadLexicon(libraryId), (error) => {
    assert.equal(error.code, 'LEXICON_CORRUPT')
    assert.match(error.message, /invalid JSON/)
    return true
  })
  // 写路径同样被挡住：upsert 不允许把损坏文件当空库覆盖。
  assert.throws(() => lexicon.upsertLexiconTerm({ libraryId, term: '糖刀', kind: 'meme', meaning: 'x' }),
    (error) => error.code === 'LEXICON_CORRUPT')
  // 磁盘上的坏字节原样保留——绝没有被"空结构 + 一次写"洗掉。
  assert.equal(fs.readFileSync(lexFile(libraryId), 'utf8'), '{ this is not json')
})

test('valid JSON with a foreign shape is also corrupt, not empty', () => {
  const libraryId = newLibrary()
  fs.mkdirSync(path.dirname(lexFile(libraryId)), { recursive: true })
  fs.writeFileSync(lexFile(libraryId), JSON.stringify({ version: 1, entries: {} }))
  assert.throws(() => lexicon.loadLexicon(libraryId), (error) => error.code === 'LEXICON_CORRUPT')
  const other = newLibrary()
  fs.writeFileSync(lexFile(other), '[]')
  assert.throws(() => lexicon.loadLexicon(other), (error) => error.code === 'LEXICON_CORRUPT')
})

// ---- P0 存储：normalize ----

test('normalizeLexeme does NFKC + case folding + strips whitespace/punctuation/symbols', () => {
  assert.equal(lexicon.normalizeLexeme('糖 刀！'), '糖刀')
  assert.equal(lexicon.normalizeLexeme('Ｔｅａ, Time!'), 'teatime')
  assert.equal(lexicon.normalizeLexeme('Tea-time…'), 'teatime')
  assert.equal(lexicon.normalizeLexeme('  ') , '')
  assert.equal(lexicon.normalizeLexeme('!!!'), '')
})

// ---- P0 存储：写入、revision CAS、原子替换 ----

test('upsert writes the §1.2 record shape and bumps the revision', () => {
  const libraryId = newLibrary()
  const { term, created } = lexicon.upsertLexiconTerm({
    libraryId, term: '糖刀', kind: 'meme', meaning: '表面发糖、实际虐心', usage: '描述剧情',
    aliases: ['糖里藏刀'], examples: ['这段也太糖刀了'], evidence: [{ kind: 'message', id: 'm1', quote: '这段也太糖刀了' }],
    source: 'user',
  })
  assert.equal(created, true)
  assert.ok(term.termId.startsWith('lex-'))
  assert.equal(term.normalizedTerm, '糖刀')
  assert.deepEqual(term.normalizedAliases, ['糖里藏刀'])
  assert.equal(term.status, 'active')
  assert.equal(term.sensitivity, 'normal')
  assert.deepEqual(term.hitCounts, { candidate: 0, injection: 0, query: 0 })
  assert.equal(term.lastInjectedAt, null)
  assert.ok(term.createdAt && term.updatedAt)
  const lex = lexicon.loadLexicon(libraryId)
  assert.equal(lex.revision, 1)
  assert.equal(lex.terms[term.termId].meaning, '表面发糖、实际虐心')
  // evidence 只存短证据：超长 quote 被截断，而不是整段转录复制进来。
  const long = lexicon.upsertLexiconTerm({
    libraryId, term: '长证据', kind: 'term', meaning: 'm',
    evidence: [{ kind: 'message', id: 'e'.repeat(300), quote: 'q'.repeat(500) }],
  })
  assert.equal(long.term.evidence[0].quote.length, 200)
  assert.equal(long.term.evidence[0].id.length, 160)
})

test('re-upserting the same normalized term updates in place instead of creating', () => {
  const libraryId = newLibrary()
  // 非敏感字段（usage）变化：原地更新，不新建条目。
  const first = lexicon.upsertLexiconTerm({ libraryId, term: '糖刀', kind: 'meme', meaning: '同一个含义' })
  const second = lexicon.upsertLexiconTerm({ libraryId, term: '糖刀', kind: 'meme', meaning: '同一个含义', usage: '描述剧情走向' })
  assert.equal(second.created, false)
  assert.equal(second.term.termId, first.term.termId)
  const lex = lexicon.loadLexicon(libraryId)
  assert.equal(Object.keys(lex.terms).length, 1)
  assert.equal(lex.terms[first.term.termId].usage, '描述剧情走向')
  assert.equal(lex.revision, 2)
})

test('normalized variants (case, width, punctuation) collapse onto one entry', () => {
  const libraryId = newLibrary()
  const first = lexicon.upsertLexiconTerm({ libraryId, term: 'Tea Time!', kind: 'term', meaning: '喝茶时间' })
  const second = lexicon.upsertLexiconTerm({ libraryId, term: 'ｔｅａ ｔｉｍｅ～', kind: 'term', meaning: '喝茶时间' })
  assert.equal(second.created, false)
  assert.equal(second.term.termId, first.term.termId)
  assert.equal(Object.keys(lexicon.loadLexicon(libraryId).terms).length, 1)
})

test('every write re-reads the latest revision inside the lock (CAS); a stale copy cannot clobber', () => {
  const libraryId = newLibrary()
  lexicon.upsertLexiconTerm({ libraryId, term: '旧词', kind: 'term', meaning: 'm' })
  const stale = lexicon.loadLexicon(libraryId) // 调用方手里的陈旧副本（revision 1）
  // 模拟另一个进程先写：绕开本进程直接改磁盘（revision 41 + 外来词条）。
  const onDisk = JSON.parse(fs.readFileSync(lexFile(libraryId), 'utf8'))
  onDisk.revision = 41
  onDisk.terms['lex-foreign'] = { term: '外来词条', normalizedTerm: '外来词条', kind: 'term', status: 'active', context: {} }
  fs.writeFileSync(lexFile(libraryId), JSON.stringify(onDisk))
  lexicon.upsertLexiconTerm({ libraryId, term: '新词', kind: 'term', meaning: 'm' })
  const after = lexicon.loadLexicon(libraryId)
  // 如果写函数用了陈旧副本，revision 会退回 2 且外来词条丢失。
  assert.equal(after.revision, 42)
  assert.ok(after.terms['lex-foreign'], 'the concurrent foreign write must survive')
  assert.ok(after.terms[Object.keys(stale.terms)[0]], 'the stale snapshot term is still there')
})

test('writes are atomic: no temp files survive and the file always parses', () => {
  const libraryId = newLibrary()
  for (let i = 0; i < 3; i++) lexicon.upsertLexiconTerm({ libraryId, term: `词${i}`, kind: 'term', meaning: 'm' })
  const dir = path.join(home, 'lexicon')
  const leftovers = fs.readdirSync(dir).filter(name => name.includes('.tmp-') || name.endsWith('.lock'))
  assert.deepEqual(leftovers, [])
  const parsed = JSON.parse(fs.readFileSync(lexFile(libraryId), 'utf8'))
  assert.equal(parsed.revision, 3)
  assert.equal(Object.keys(parsed.terms).length, 3)
})

test('LEXICON_CAP is enforced on creation but never on update', () => {
  const libraryId = newLibrary()
  fs.mkdirSync(path.dirname(lexFile(libraryId)), { recursive: true })
  const terms = {}
  for (let i = 0; i < lexicon.LEXICON_CAP; i++) {
    terms[`lex-fill-${i}`] = { term: `fill${i}`, normalizedTerm: `fill${i}`, kind: 'term', meaning: '容量占位', sensitivity: 'normal', status: 'active', context: {} }
  }
  paths.writeJson(lexFile(libraryId), { version: 1, revision: 7, libraryId, terms, rejected: {} })
  assert.throws(() => lexicon.upsertLexiconTerm({ libraryId, term: '超限词', kind: 'term', meaning: 'm' }),
    (error) => error.code === 'LEXICON_CAP_REACHED')
  // 更新既有条目不受容量限制（非敏感字段变化 → 原地更新）。
  const updated = lexicon.upsertLexiconTerm({ libraryId, term: 'fill0', kind: 'term', meaning: '容量占位', usage: '新用法' })
  assert.equal(updated.created, false)
  assert.equal(lexicon.loadLexicon(libraryId).terms['lex-fill-0'].usage, '新用法')
})

test('recordHit accumulates candidate/injection/query separately; unknown kinds and terms are typed errors', () => {
  const libraryId = newLibrary()
  const { term } = lexicon.upsertLexiconTerm({ libraryId, term: '计数词', kind: 'term', meaning: 'm' })
  lexicon.lexiconRecordHit(libraryId, term.termId, 'candidate')
  lexicon.lexiconRecordHit(libraryId, term.termId, 'candidate')
  lexicon.lexiconRecordHit(libraryId, term.termId, 'injection')
  const counts = lexicon.lexiconRecordHit(libraryId, term.termId, 'query')
  assert.deepEqual(counts.hitCounts, { candidate: 2, injection: 1, query: 1 })
  const entry = lexicon.loadLexicon(libraryId).terms[term.termId]
  assert.ok(entry.lastInjectedAt, 'injection stamps lastInjectedAt')
  assert.throws(() => lexicon.lexiconRecordHit(libraryId, term.termId, 'search'), (error) => error.code === 'LEXICON_INVALID_HIT_KIND')
  assert.throws(() => lexicon.lexiconRecordHit(libraryId, 'lex-none', 'query'), (error) => error.code === 'LEXICON_NOT_FOUND')
})

test('delete is a management operation: it works by id and clears rejected fingerprints', () => {
  const libraryId = newLibrary()
  // 当前版本不再产出 rejected（人审已删除），墓碑只能来自 legacy 数据——直接写一条。
  const legacy = lexicon.loadLexicon(libraryId)
  legacy.terms['lex-old-reject'] = legacyEntry('待删词', { status: 'rejected', source: 'model-proposal' })
  legacy.rejected[paths.shortHash('待删词')] = { termId: 'lex-old-reject', reason: '历史驳回', at: '2026-01-01T00:00:00.000Z' }
  paths.writeJson(lexFile(libraryId), legacy)
  assert.equal(lexicon.deleteLexiconTerm({ libraryId, termId: 'lex-old-reject' }).deleted, true)
  assert.equal(Object.keys(lexicon.loadLexicon(libraryId).terms).length, 0)
  const lex = lexicon.loadLexicon(libraryId)
  assert.equal(Object.keys(lex.rejected).length, 0, 'fingerprint map entry goes away with the term')
  assert.throws(() => lexicon.deleteLexiconTerm({ libraryId, termId: 'lex-none' }), (error) => error.code === 'LEXICON_NOT_FOUND')
})

// 直接写盘的旧词条骨架（status/source 可覆盖）：legacy 数据只能这样造——新写路径
// 不再产出 pending/rejected（§2.1），但它们仍然必须被正确读取。
function legacyEntry(term, overrides = {}) {
  const now = '2026-01-01T00:00:00.000Z'
  return {
    term,
    normalizedTerm: lexicon.normalizeLexeme(term),
    normalizedAliases: [],
    kind: 'term',
    meaning: '历史含义',
    usage: '',
    aliases: [],
    examples: [],
    context: {},
    visibility: 'shared',
    sensitivity: 'normal',
    strength: 0.5,
    confidence: 0.7,
    status: 'active',
    source: 'user',
    evidence: [],
    fingerprint: paths.shortHash(lexicon.normalizeLexeme(term)),
    createdAt: now,
    updatedAt: now,
    hitCounts: { candidate: 0, injection: 0, query: 0 },
    lastInjectedAt: null,
    ...overrides,
  }
}

// ---- 可见性（§1.3，contextVisible 对齐） ----

test('term context is filtered by the same contextVisible rule as memories', () => {
  const libraryId = newLibrary()
  lexicon.upsertLexiconTerm({ libraryId, term: '世界词', kind: 'term', meaning: 'm', context: { worldId: 'w1' } })
  lexicon.upsertLexiconTerm({ libraryId, term: '专属词', kind: 'term', meaning: 'm', context: { knownBy: ['char-a'] } })
  lexicon.upsertLexiconTerm({ libraryId, term: '公共词', kind: 'term', meaning: 'm' })
  // 三条 strength/updatedAt 相同，顺序由 termId 决定——断言集合而不依赖遍历序。
  const termsIn = (ctx) => lexicon.visibleLexiconTerms(libraryId, ctx).map(t => t.term).sort()
  assert.deepEqual(termsIn({ worldId: 'w1' }), ['公共词', '世界词'].sort())
  assert.deepEqual(termsIn({ worldId: 'w2' }), ['公共词'])
  assert.deepEqual(termsIn({ worldId: 'w1', characterId: 'char-a' }), ['公共词', '世界词', '专属词'].sort())
  // 与 lib/context.js 逐条对齐：过滤失败的条目绝不出现在结果里。
  for (const current of [{ worldId: 'w1' }, { worldId: 'w2' }, { worldId: 'w1', characterId: 'char-a' }]) {
    const expected = Object.values(lexicon.loadLexicon(libraryId).terms)
      .filter(entry => entry.status === 'active')
      .filter(entry => contextVisibleOf(entry, current))
      .length
    assert.equal(lexicon.visibleLexiconTerms(libraryId, current).length, expected)
  }
})

function contextVisibleOf(entry, current) {
  for (const key of ['channelId', 'characterId', 'worldId', 'branchId']) {
    if (entry.context?.[key] && entry.context[key] !== current?.[key]) return false
  }
  if (Array.isArray(entry.context?.knownBy) && entry.context.knownBy.length && !entry.context.knownBy.includes(current?.characterId)) return false
  return true
}

test('the same normalized term can live in two scopes without colliding, and never crosses', () => {
  const libraryId = newLibrary()
  const a = lexicon.upsertLexiconTerm({ libraryId, term: '糖刀', kind: 'meme', meaning: 'w1 的含义', context: { worldId: 'w1' } })
  const b = lexicon.upsertLexiconTerm({ libraryId, term: '糖刀', kind: 'meme', meaning: 'w2 的含义', context: { worldId: 'w2' } })
  assert.equal(a.created, true)
  assert.equal(b.created, true)
  assert.notEqual(a.term.termId, b.term.termId)
  const hitsW1 = lexicon.matchLexiconHits(libraryId, '这段太糖刀了', { worldId: 'w1' })
  assert.deepEqual(hitsW1.map(hit => hit.meaning), ['w1 的含义'])
})

// ---- P2 审核（§2.3） ----

// ---- 生命周期（§2.1）：公开 active/archived，写入即生效 ----

test('model proposals and curator writes land active immediately; sensitive triggers need the user', () => {
  const libraryId = newLibrary()
  const proposal = lexicon.upsertLexiconTerm({ libraryId, term: '提案词', kind: 'term', meaning: '模型猜的', source: 'model-proposal' })
  assert.equal(proposal.created, true)
  assert.equal(proposal.term.status, 'active', 'no pending state, no human review')
  assert.equal(proposal.term.source, 'model-proposal')
  assert.equal(proposal.term.reviewReason, null)
  // 立刻进入可见 / 匹配 / 锚点 / 检索。
  assert.deepEqual(lexicon.visibleLexiconTerms(libraryId, {}).map(t => t.term), ['提案词'])
  assert.equal(lexicon.matchLexiconHits(libraryId, '来点提案词', {}).length, 1)
  assert.equal(lexicon.searchLexicon({ libraryId, query: '提案词' }, {}).length, 1)
  assert.match(lexicon.lexiconAnchorSummary(libraryId, {}).lines[0], /提案词/)
  // 同词重放（敏感字段不变）= 原地更新，不新建。
  const replay = lexicon.upsertLexiconTerm({ libraryId, term: '提案词', kind: 'term', meaning: '模型猜的', source: 'model-proposal' })
  assert.equal(replay.created, false)
  assert.equal(Object.keys(lexicon.loadLexicon(libraryId).terms).length, 1)
  // sensitive trigger：模型与 curator 都只能是 typed 拒绝（含显式 sensitivity）。
  for (const source of ['model-proposal', 'curator']) {
    assert.throws(() => lexicon.upsertLexiconTerm({ libraryId, term: `敏感触发-${source}`, kind: 'trigger', meaning: 'm', source }),
      (error) => error.code === 'LEXICON_SENSITIVE_FORBIDDEN')
    assert.throws(() => lexicon.upsertLexiconTerm({ libraryId, term: `敏感触发二-${source}`, kind: 'trigger', sensitivity: 'sensitive', meaning: 'm', source }),
      (error) => error.code === 'LEXICON_SENSITIVE_FORBIDDEN')
  }
  // 用户行：trigger 默认 sensitive，直接 active。
  const userTrigger = lexicon.upsertLexiconTerm({ libraryId, term: '用户触发', kind: 'trigger', source: 'user' })
  assert.equal(userTrigger.term.status, 'active')
  assert.equal(userTrigger.term.sensitivity, 'sensitive')
  // 显式 normal 的 trigger 不是敏感词，模型/curator 可以提。
  const normalTrigger = lexicon.upsertLexiconTerm({ libraryId, term: '普通触发', kind: 'trigger', sensitivity: 'normal', source: 'model-proposal' })
  assert.equal(normalTrigger.term.status, 'active')
  assert.equal(normalTrigger.term.sensitivity, 'normal')
  assert.equal(Object.keys(lexicon.loadLexicon(libraryId).terms).length, 3)
})

test('curator writes without needs_review go straight to active too', () => {
  const libraryId = newLibrary()
  const created = lexicon.upsertLexiconTerm({ libraryId, term: '整理词', kind: 'meme', meaning: '整理出来的含义', source: 'curator' })
  assert.equal(created.created, true)
  assert.equal(created.term.status, 'active')
  assert.equal(created.term.source, 'curator')
  // curator 显式传 pending（needs_review 时代的写法）也只能收口成 active。
  const coerced = lexicon.upsertLexiconTerm({ libraryId, term: '整理词二', kind: 'meme', meaning: 'm', source: 'curator', status: 'pending' })
  assert.equal(coerced.term.status, 'active')
})

test('new callers cannot set pending or rejected; archived is an explicit user choice', () => {
  const libraryId = newLibrary()
  const coercedPending = lexicon.upsertLexiconTerm({ libraryId, term: '强迫待审', kind: 'term', meaning: 'm', status: 'pending' })
  assert.equal(coercedPending.term.status, 'active')
  const coercedRejected = lexicon.upsertLexiconTerm({ libraryId, term: '强迫驳回', kind: 'term', meaning: 'm', status: 'rejected' })
  assert.equal(coercedRejected.term.status, 'active')
  const archivedAtBirth = lexicon.upsertLexiconTerm({ libraryId, term: '出生归档', kind: 'term', meaning: 'm', status: 'archived' })
  assert.equal(archivedAtBirth.term.status, 'archived')
  assert.deepEqual(lexicon.visibleLexiconTerms(libraryId, {}).map(t => t.term).sort(), ['强迫待审', '强迫驳回'].sort())
  assert.deepEqual(lexicon.visibleLexiconTerms(libraryId, {}, { includeArchived: true }).map(t => t.term).sort(), ['出生归档', '强迫待审', '强迫驳回'].sort())
})

test('non-user updates: sensitive fields are refused with a typed error, ordinary fields update in place', () => {
  const libraryId = newLibrary()
  const active = lexicon.upsertLexiconTerm({ libraryId, term: '糖刀', kind: 'meme', meaning: '含义 A', source: 'user' })
  // 非敏感字段（usage）by model-proposal：原地更新，不产生任何草稿。
  const usageOnly = lexicon.upsertLexiconTerm({ libraryId, term: '糖刀', kind: 'meme', meaning: '含义 A', usage: '新用法', source: 'model-proposal' })
  assert.equal(usageOnly.created, false)
  assert.equal(usageOnly.term.status, 'active')
  assert.equal(usageOnly.term.usage, '新用法')
  assert.equal(Object.keys(lexicon.loadLexicon(libraryId).terms).length, 1, 'no pending revision is ever created')
  // 敏感字段（meaning/kind/sensitivity）任何一个变化 → typed 拒绝。
  const cases = [
    { label: 'meaning', args: { meaning: '含义 B' } },
    { label: 'kind', args: { meaning: '含义 A', kind: 'slang' } },
    { label: 'sensitivity', args: { meaning: '含义 A', sensitivity: 'sensitive' } },
  ]
  for (const { label, args } of cases) {
    for (const source of ['model-proposal', 'curator']) {
      assert.throws(() => lexicon.upsertLexiconTerm({ libraryId, term: '糖刀', kind: 'meme', usage: '新用法', source, ...args }),
        (error) => error.code === 'LEXICON_SENSITIVE_FIELDS_FORBIDDEN', `${source} must not change ${label}`)
    }
  }
  // context 也是敏感字段：同作用域里 knownBy 可见性边界的变化同样拒绝（同身份组才撞线）。
  const bounded = lexicon.upsertLexiconTerm({ libraryId, term: '边界词', kind: 'term', meaning: 'm', knownBy: ['char-a'], source: 'user' })
  for (const source of ['model-proposal', 'curator']) {
    assert.throws(() => lexicon.upsertLexiconTerm({ libraryId, term: '边界词', kind: 'term', meaning: 'm', source }),
      (error) => error.code === 'LEXICON_SENSITIVE_FIELDS_FORBIDDEN', `${source} must not drop the knownBy boundary`)
  }
  assert.deepEqual(lexicon.loadLexicon(libraryId).terms[bounded.term.termId].context.knownBy, ['char-a'])
  // visibility 不在非敏感名单里：secret 词条不能被非用户更新洗成 shared（披露边界）。
  const secret = lexicon.upsertLexiconTerm({ libraryId, term: '秘密词', kind: 'term', meaning: 'm', visibility: 'secret', source: 'user' })
  for (const source of ['model-proposal', 'curator']) {
    assert.throws(() => lexicon.upsertLexiconTerm({ libraryId, term: '秘密词', kind: 'term', meaning: 'm', visibility: 'shared', source }),
      (error) => error.code === 'LEXICON_SENSITIVE_FIELDS_FORBIDDEN', `${source} must not disclose a secret term`)
  }
  assert.equal(lexicon.loadLexicon(libraryId).terms[secret.term.termId].visibility, 'secret')
  // 用户自己可以把 visibility 改回来。
  const disclosed = lexicon.upsertLexiconTerm({ libraryId, term: '秘密词', kind: 'term', meaning: 'm', visibility: 'shared', source: 'user' })
  assert.equal(disclosed.term.visibility, 'shared')
  const lex = lexicon.loadLexicon(libraryId)
  assert.equal(lex.terms[active.term.termId].meaning, '含义 A')
  assert.equal(Object.keys(lex.terms).length, 3, 'rejections leave no drafts behind')
  // 用户改敏感字段：直接生效。
  const userUpdate = lexicon.upsertLexiconTerm({ libraryId, term: '糖刀', kind: 'meme', meaning: '用户改的含义', source: 'user' })
  assert.equal(userUpdate.created, false)
  assert.equal(userUpdate.term.status, 'active')
  assert.equal(lexicon.loadLexicon(libraryId).terms[active.term.termId].meaning, '用户改的含义')
})

test('sensitive triggers are user-managed: every non-user update is refused', () => {
  const libraryId = newLibrary()
  const trigger = lexicon.upsertLexiconTerm({ libraryId, term: '红牌', kind: 'trigger', meaning: '触发', source: 'user' })
  assert.equal(trigger.term.sensitivity, 'sensitive')
  for (const source of ['model-proposal', 'curator']) {
    // 带着敏感档位来：连"建 sensitive trigger"的创建守卫都会先拦（同一个安全口径）。
    assert.throws(() => lexicon.upsertLexiconTerm({ libraryId, term: '红牌', kind: 'trigger', meaning: '触发', usage: '新用法', source }),
      (error) => error.code === 'LEXICON_SENSITIVE_FORBIDDEN', `${source} must not touch a sensitive trigger at all`)
    // 想把它降成 normal（改敏感字段）也拒绝：既有 sensitive trigger 的任何更新都不给非用户。
    assert.throws(() => lexicon.upsertLexiconTerm({ libraryId, term: '红牌', kind: 'trigger', sensitivity: 'normal', meaning: '触发', usage: '新用法', source }),
      (error) => error.code === 'LEXICON_SENSITIVE_FIELDS_FORBIDDEN', `${source} must not downgrade a sensitive trigger`)
  }
  assert.equal(lexicon.loadLexicon(libraryId).terms[trigger.term.termId].usage, '')
  assert.equal(lexicon.loadLexicon(libraryId).terms[trigger.term.termId].sensitivity, 'sensitive')
  const updated = lexicon.upsertLexiconTerm({ libraryId, term: '红牌', kind: 'trigger', meaning: '用户改的触发', source: 'user' })
  assert.equal(updated.term.meaning, '用户改的触发')
})

test('archive takes a term out of visibility/matching/search; restore puts it back', () => {
  const libraryId = newLibrary()
  const { term } = lexicon.upsertLexiconTerm({ libraryId, term: '归档词', kind: 'term', meaning: '要归档的含义' })
  const archived = lexicon.archiveLexiconTerm({ libraryId, termId: term.termId })
  assert.equal(archived.term.status, 'archived')
  assert.equal(archived.action, 'archive')
  // 归档后：不列出、不匹配、不检索、不进锚点——也就是不注入。
  assert.deepEqual(lexicon.visibleLexiconTerms(libraryId, {}), [])
  assert.deepEqual(lexicon.matchLexiconHits(libraryId, '来点归档词', {}), [])
  assert.deepEqual(lexicon.searchLexicon({ libraryId, query: '归档词' }, {}), [])
  assert.deepEqual(lexicon.lexiconAnchorSummary(libraryId, {}), { lines: [], sensitiveTriggers: [] })
  // 管理面显式 includeArchived 才看得到。
  assert.deepEqual(lexicon.visibleLexiconTerms(libraryId, {}, { includeArchived: true }).map(t => t.term), ['归档词'])
  assert.equal(lexicon.searchLexicon({ libraryId, query: '归档词' }, { includeArchived: true }).length, 1)
  assert.equal(lexicon.loadLexicon(libraryId).terms[term.termId].hitCounts.query, 0, 'browsing archived terms does not count as a query hit')
  // 归档不写 rejected 墓碑（归档是可恢复的退场，不是拒绝）。
  assert.deepEqual(Object.keys(lexicon.loadLexicon(libraryId).rejected), [])
  // 状态机是硬的：重复归档、恢复未知 id 都是 typed error。
  assert.throws(() => lexicon.archiveLexiconTerm({ libraryId, termId: term.termId }), (error) => error.code === 'LEXICON_INVALID_STATUS')
  assert.throws(() => lexicon.restoreLexiconTerm({ libraryId, termId: 'lex-none' }), (error) => error.code === 'LEXICON_NOT_FOUND')
  const restored = lexicon.restoreLexiconTerm({ libraryId, termId: term.termId })
  assert.equal(restored.term.status, 'active')
  assert.equal(restored.action, 'restore')
  assert.deepEqual(lexicon.visibleLexiconTerms(libraryId, {}).map(t => t.term), ['归档词'])
  assert.equal(lexicon.matchLexiconHits(libraryId, '来点归档词', {}).length, 1)
  assert.equal(lexicon.searchLexicon({ libraryId, query: '归档词' }, {}).length, 1)
  assert.throws(() => lexicon.restoreLexiconTerm({ libraryId, termId: term.termId }), (error) => error.code === 'LEXICON_INVALID_STATUS')
})

test('restore refuses legacy revision drafts and would-be alias conflicts', () => {
  const libraryId = newLibrary()
  const target = lexicon.upsertLexiconTerm({ libraryId, term: '钉子', kind: 'term', meaning: '原义' })
  // 迁移后的修订草稿形态：archived + revisionOf 指向仍 active 的目标。
  const lex = lexicon.loadLexicon(libraryId)
  lex.terms['lex-legacy-draft'] = {
    ...legacyEntry('钉子草稿'),
    term: '钉子',
    normalizedTerm: '钉子',
    meaning: '草稿义',
    status: 'archived',
    revisionOf: target.term.termId,
    previousRevision: 1,
  }
  paths.writeJson(lexFile(libraryId), lex)
  assert.throws(() => lexicon.restoreLexiconTerm({ libraryId, termId: 'lex-legacy-draft' }),
    (error) => error.code === 'LEXICON_REVISION_IMMUTABLE')
  assert.equal(lexicon.loadLexicon(libraryId).terms['lex-legacy-draft'].status, 'archived')
  // 别名撞线：归档词条 月引，另一条 active 词条把「月引」当别名占着。
  const yue = lexicon.upsertLexiconTerm({ libraryId, term: '月引', kind: 'term', meaning: 'w1 的月引' })
  lexicon.archiveLexiconTerm({ libraryId, termId: yue.term.termId })
  lexicon.upsertLexiconTerm({ libraryId, term: '引子', kind: 'term', meaning: '另一条', aliases: ['月引'] })
  assert.throws(() => lexicon.restoreLexiconTerm({ libraryId, termId: yue.term.termId }),
    (error) => error.code === 'LEXICON_ALIAS_CONFLICT')
  assert.equal(lexicon.loadLexicon(libraryId).terms[yue.term.termId].status, 'archived')
})

test('a collision with an archived term is not revived by model/curator; the user revives it', () => {
  const libraryId = newLibrary()
  const created = lexicon.upsertLexiconTerm({ libraryId, term: '复活词', kind: 'term', meaning: '旧含义' })
  lexicon.archiveLexiconTerm({ libraryId, termId: created.term.termId })
  for (const source of ['model-proposal', 'curator']) {
    const result = lexicon.upsertLexiconTerm({ libraryId, term: '复活词', kind: 'term', meaning: '旧含义', usage: '新用法', source })
    assert.equal(result.created, false)
    assert.equal(result.notOwned, true, `${source} must not own an archived term`)
    assert.equal(result.term.status, 'archived')
  }
  assert.equal(Object.keys(lexicon.loadLexicon(libraryId).terms).length, 1, 'no duplicate is created next to the archived entry either')
  assert.equal(lexicon.loadLexicon(libraryId).terms[created.term.termId].usage, '')
  const edited = lexicon.upsertLexiconTerm({ libraryId, term: '复活词', kind: 'term', meaning: '归档时改的含义', source: 'user' })
  assert.equal(edited.created, false)
  assert.equal(edited.term.status, 'archived', 'editing an archived term is not an implicit restore')
  assert.equal(edited.term.meaning, '归档时改的含义')
  assert.deepEqual(lexicon.visibleLexiconTerms(libraryId, {}), [])
  const revived = lexicon.upsertLexiconTerm({ libraryId, term: '复活词', kind: 'term', meaning: '用户改的新含义', source: 'user', status: 'active' })
  assert.equal(revived.created, false)
  assert.equal(revived.revived, true)
  assert.equal(revived.term.status, 'active')
  assert.equal(revived.term.meaning, '用户改的新含义')
  assert.deepEqual(lexicon.visibleLexiconTerms(libraryId, {}).map(t => t.term), ['复活词'])
})

test('a rejected tombstone blocks model replays and is never revived by non-user writes', () => {
  const libraryId = newLibrary()
  // 当前版本不再产出 rejected（人审已删除）：墓碑只能来自 legacy 数据。
  const lex = lexicon.loadLexicon(libraryId)
  lex.terms['lex-old-reject'] = legacyEntry('错词', { status: 'rejected', source: 'model-proposal' })
  lex.rejected[paths.shortHash('错词')] = { termId: 'lex-old-reject', reason: '模型猜的', at: '2026-01-01T00:00:00.000Z' }
  paths.writeJson(lexFile(libraryId), lex)
  assert.deepEqual(lexicon.visibleLexiconTerms(libraryId, {}), [])
  assert.deepEqual(lexicon.visibleLexiconTerms(libraryId, {}, { includeArchived: true }), [], 'tombstones never surface in any list')
  // 同 fingerprint 的 model-proposal 直接拒绝（大写/标点变体一样，因为指纹是规范化词面）。
  assert.throws(() => lexicon.upsertLexiconTerm({ libraryId, term: '错词', kind: 'term', meaning: 'again', source: 'model-proposal' }),
    (error) => error.code === 'LEXICON_PROPOSAL_REJECTED')
  assert.throws(() => lexicon.upsertLexiconTerm({ libraryId, term: '错词！', kind: 'term', meaning: 'again', source: 'model-proposal' }),
    (error) => error.code === 'LEXICON_PROPOSAL_REJECTED')
  // curator 同样不得复活墓碑：拿回既有条目 + notOwned，正文不动。
  const curatorTry = lexicon.upsertLexiconTerm({ libraryId, term: '错词', kind: 'term', meaning: 'curator 想改', source: 'curator' })
  assert.equal(curatorTry.created, false)
  assert.equal(curatorTry.notOwned, true)
  assert.equal(curatorTry.term.status, 'rejected')
  assert.equal(lexicon.loadLexicon(libraryId).terms['lex-old-reject'].meaning, '历史含义')
  // 用户显式写入 = 翻案：active 并清掉拒绝指纹。
  const revived = lexicon.upsertLexiconTerm({ libraryId, term: '错词', kind: 'term', meaning: '用户确认的含义', source: 'user' })
  assert.equal(revived.created, false)
  assert.equal(revived.revived, true)
  assert.equal(revived.term.status, 'active')
  assert.equal(revived.term.meaning, '用户确认的含义')
  assert.deepEqual(Object.keys(lexicon.loadLexicon(libraryId).rejected), [])
})

test('legacy pending terms before migration: user writes apply directly, non-user writes never create revisions', () => {
  const libraryId = newLibrary()
  const lex = lexicon.loadLexicon(libraryId)
  lex.terms['lex-legacy-pending'] = legacyEntry('旧提案', { status: 'pending', source: 'model-proposal', meaning: '旧含义' })
  lex.terms['lex-legacy-pending-2'] = legacyEntry('旧提案二', { status: 'pending', source: 'model-proposal', meaning: '旧含义二' })
  paths.writeJson(lexFile(libraryId), lex)
  // 迁移前 legacy pending 不参与注入（active-only）。
  assert.deepEqual(lexicon.visibleLexiconTerms(libraryId, {}), [])
  // 非用户只改非敏感字段：原地更新并收口为 active，不建 revision。
  const curatorUpdate = lexicon.upsertLexiconTerm({ libraryId, term: '旧提案', kind: 'term', meaning: '旧含义', usage: '新用法', source: 'curator' })
  assert.equal(curatorUpdate.created, false)
  assert.equal(curatorUpdate.term.status, 'active')
  assert.equal(curatorUpdate.term.usage, '新用法')
  assert.equal(Object.keys(lexicon.loadLexicon(libraryId).terms).length, 2, 'no revision draft is created')
  // 非用户改敏感字段：typed 拒绝，条目保持原样（仍然是 legacy pending）。
  assert.throws(() => lexicon.upsertLexiconTerm({ libraryId, term: '旧提案二', kind: 'term', meaning: '模型改的', source: 'model-proposal' }),
    (error) => error.code === 'LEXICON_SENSITIVE_FIELDS_FORBIDDEN')
  assert.equal(lexicon.loadLexicon(libraryId).terms['lex-legacy-pending-2'].status, 'pending')
  assert.equal(lexicon.loadLexicon(libraryId).terms['lex-legacy-pending-2'].meaning, '旧含义二')
  // 用户写同词：直接应用（含敏感字段），条目转 active。
  const userWrite = lexicon.upsertLexiconTerm({ libraryId, term: '旧提案二', kind: 'term', meaning: '用户改的', source: 'user' })
  assert.equal(userWrite.term.status, 'active')
  assert.equal(userWrite.term.meaning, '用户改的')
})

test('legacy revision drafts are never revived by non-user writes', () => {
  const libraryId = newLibrary()
  const lex = lexicon.loadLexicon(libraryId)
  lex.terms['lex-orphan-draft'] = legacyEntry('孤草稿', { status: 'pending', meaning: '草稿义' })
  lex.terms['lex-orphan-draft'].revisionOf = 'lex-gone-target'
  paths.writeJson(lexFile(libraryId), lex)
  for (const source of ['model-proposal', 'curator']) {
    const attempt = lexicon.upsertLexiconTerm({ libraryId, term: '孤草稿', kind: 'term', meaning: '草稿义', source })
    assert.equal(attempt.created, false)
    assert.equal(attempt.notOwned, true, `${source} must not turn a draft into a term`)
    assert.equal(attempt.term.status, 'pending')
  }
  assert.equal(lexicon.loadLexicon(libraryId).terms['lex-orphan-draft'].status, 'pending')
})

test('migrateLegacyLexiconStatuses: proposals → active, sensitive/revision → archived, rejected preserved', () => {
  const libraryId = newLibrary()
  paths.writeJson(lexFile(libraryId), {
    version: 1,
    revision: 4,
    libraryId,
    rejected: { [paths.shortHash('墓碑')]: { termId: 'lex-m-rej', reason: '历史驳回', at: '2026-01-01T00:00:00.000Z' } },
    terms: {
      'lex-m-new': legacyEntry('新提案', { status: 'pending', source: 'model-proposal' }),
      'lex-m-sensitive': legacyEntry('敏感提案', { status: 'pending', kind: 'trigger', sensitivity: 'sensitive' }),
      // legacy 数据可能没写 sensitivity：trigger 缺省就是 sensitive（§1.2）。
      'lex-m-trigger-default': legacyEntry('旧触发', { status: 'pending', kind: 'trigger', sensitivity: undefined }),
      'lex-m-draft': { ...legacyEntry('待审草稿', { status: 'pending' }), revisionOf: 'lex-m-new', previousRevision: 3 },
      'lex-m-active': legacyEntry('既有'),
      'lex-m-rej': legacyEntry('墓碑', { status: 'rejected', source: 'model-proposal' }),
    },
  })
  const first = lexicon.migrateLegacyLexiconStatuses(libraryId)
  assert.equal(first.libraryId, libraryId)
  assert.equal(first.migrated, 4)
  assert.deepEqual(first.details.map(item => [item.termId, item.status]).sort(), [
    ['lex-m-draft', 'archived'],
    ['lex-m-new', 'active'],
    ['lex-m-sensitive', 'archived'],
    ['lex-m-trigger-default', 'archived'],
  ])
  const lex = lexicon.loadLexicon(libraryId)
  assert.equal(lex.revision, 5, 'one write, one revision bump')
  assert.equal(lex.terms['lex-m-new'].status, 'active')
  assert.equal(lex.terms['lex-m-new'].migratedFromStatus, 'pending')
  assert.equal(lex.terms['lex-m-sensitive'].status, 'archived')
  assert.equal(lex.terms['lex-m-trigger-default'].status, 'archived')
  assert.equal(lex.terms['lex-m-draft'].status, 'archived', 'revision drafts keep their audit trail as archived')
  assert.equal(lex.terms['lex-m-draft'].revisionOf, 'lex-m-new')
  assert.equal(lex.terms['lex-m-active'].status, 'active')
  assert.equal(lex.terms['lex-m-rej'].status, 'rejected')
  assert.ok(lex.rejected[paths.shortHash('墓碑')], 'the tombstone fingerprint is preserved')
  // 第二遍：没有 pending → 不写盘、不 bump revision。
  const second = lexicon.migrateLegacyLexiconStatuses(libraryId)
  assert.equal(second.migrated, 0)
  assert.equal(second.details, undefined)
  assert.equal(lexicon.loadLexicon(libraryId).revision, 5, 'a no-op migration never writes')
  // 迁移后的可见面：新提案 active；草稿/敏感/墓碑都不注入。
  assert.deepEqual(lexicon.visibleLexiconTerms(libraryId, {}).map(t => t.term).sort(), ['新提案', '既有'].sort())
  assert.deepEqual(lexicon.visibleLexiconTerms(libraryId, {}, { includeArchived: true }).map(t => t.term).sort(),
    ['敏感提案', '旧触发', '新提案', '既有', '待审草稿'].sort())
  assert.deepEqual(lexicon.searchLexicon({ libraryId, query: '墓碑' }, {}), [])
  // 空库 / 不存在的库：不产生文件。
  assert.deepEqual(lexicon.migrateLegacyLexiconStatuses('lex-never-created'), { libraryId: 'lex-never-created', migrated: 0 })
  assert.equal(fs.existsSync(lexFile('lex-never-created')), false)
})

test('lexiconTurnLine clips the term to 40 and the short meaning to 80', () => {
  const line = lexicon.lexiconTurnLine({ term: 't'.repeat(60), meaning: 'm'.repeat(200) })
  assert.equal(line, `「${'t'.repeat(40)}」：${'m'.repeat(80)}`)
  assert.ok(!line.includes('m'.repeat(81)), 'the short meaning is clipped to 80, not 120')
  // usage 兜底同一把尺；两个都没有时只留 term 标题。
  assert.equal(lexicon.lexiconTurnLine({ term: '词', usage: 'u'.repeat(100) }), `「词」：${'u'.repeat(80)}`)
  assert.equal(lexicon.lexiconTurnLine({ term: '词' }), '「词」')
})

test('lib/migrate.js scans lexicon files, migrates them per library and survives a corrupt one', () => {
  // 一本正常的 legacy 词典 + 一本"能扫到但读不进去"的坏词典（version 不合法）。
  const libraryId = newLibrary()
  paths.writeJson(lexFile(libraryId), {
    version: 1,
    revision: 2,
    libraryId,
    rejected: {},
    terms: { 'lex-mig-a': legacyEntry('迁移甲', { status: 'pending' }) },
  })
  const brokenId = newLibrary()
  paths.writeJson(lexFile(brokenId), {
    version: 2,
    revision: 1,
    libraryId: brokenId,
    rejected: {},
    terms: { 'lex-bad-a': { status: 'pending' } },
  })
  const scan = migrate.scanLegacyLexiconLibraries()
  assert.ok(scan.some(item => item.libraryId === libraryId && item.legacy === 1), 'the pending lexicon is scanned')
  assert.ok(scan.some(item => item.libraryId === brokenId && item.legacy === 1), 'a corrupt lexicon is still scanned (it must not be silently skipped)')
  const logs = []
  const pass = migrate.runVisibilityMigrationPass({ log: message => logs.push(String(message)) })
  assert.ok(Array.isArray(pass.reports), 'the existing visibility report shape survives')
  const myReports = pass.lexicon.filter(item => item.libraryId === libraryId || item.libraryId === brokenId)
  const good = myReports.find(item => item.libraryId === libraryId)
  const bad = myReports.find(item => item.libraryId === brokenId)
  assert.equal(good.migrated, 1)
  assert.equal(good.before, 1)
  assert.ok(good.details.some(item => item.termId === 'lex-mig-a' && item.status === 'active'))
  assert.match(bad.error, /LEXICON_CORRUPT|could not be read|invalid data shape/)
  assert.equal(bad.migrated, 0, 'one broken lexicon does not stop the sweep')
  assert.ok(logs.some(message => message.includes('migrated 1 legacy lexicon term(s)') && message.includes(libraryId)))
  assert.ok(logs.some(message => message.includes('lexicon lifecycle migration failed') && message.includes(brokenId)))
  const migratedLex = lexicon.loadLexicon(libraryId)
  assert.equal(migratedLex.revision, 3, 'the migration writes exactly once')
  assert.equal(migratedLex.terms['lex-mig-a'].status, 'active')
  // 第二遍：没有待迁移的词典 → 不再写、不再记日志。
  const secondLogs = []
  const second = migrate.runVisibilityMigrationPass({ log: message => secondLogs.push(String(message)) })
  assert.deepEqual(second.lexicon.filter(item => item.libraryId === libraryId), [])
  assert.equal(lexicon.loadLexicon(libraryId).revision, 3, 'a no-op pass never bumps the revision')
  assert.ok(!secondLogs.some(message => message.includes('migrated 1 legacy lexicon term(s)')))
})

test('schema validation rejects junk with typed errors', () => {
  const libraryId = newLibrary()
  assert.throws(() => lexicon.upsertLexiconTerm({ libraryId, term: '', kind: 'term' }), (error) => error.code === 'LEXICON_INVALID_TERM')
  assert.throws(() => lexicon.upsertLexiconTerm({ libraryId, term: 'x'.repeat(81), kind: 'term' }), (error) => error.code === 'LEXICON_INVALID_TERM')
  assert.throws(() => lexicon.upsertLexiconTerm({ libraryId, term: '词', kind: 'banana' }), (error) => error.code === 'LEXICON_INVALID_KIND')
  assert.throws(() => lexicon.upsertLexiconTerm({ libraryId, term: '词', kind: 'term', visibility: 'public' }), (error) => error.code === 'LEXICON_INVALID_VISIBILITY')
  assert.throws(() => lexicon.upsertLexiconTerm({ libraryId, term: '词', kind: 'term', sensitivity: 'hyper' }), (error) => error.code === 'LEXICON_INVALID_SENSITIVITY')
  assert.throws(() => lexicon.upsertLexiconTerm({ libraryId, term: '词', kind: 'term', source: 'whisper' }), (error) => error.code === 'LEXICON_INVALID_SOURCE')
  assert.throws(() => lexicon.upsertLexiconTerm({ libraryId, term: '词', kind: 'term', aliases: 'not-an-array' }), (error) => error.code === 'LEXICON_INVALID_ALIASES')
  // alias 撞了别的词条：typed 拒绝，不静默合并。
  lexicon.upsertLexiconTerm({ libraryId, term: '本名', kind: 'term', meaning: 'm' })
  assert.throws(() => lexicon.upsertLexiconTerm({ libraryId, term: '另一个', kind: 'term', meaning: 'm', aliases: ['本名'] }),
    (error) => error.code === 'LEXICON_ALIAS_CONFLICT')
})

// ---- P2 curator 写入 op（§2.1-§2.2） ----

function lexOp(extra = {}) {
  return {
    op: 'lexicon', action: 'upsert', term: '整理词', kind: 'meme', meaning: '整理出来的含义',
    evidence: [{ kind: 'message', id: 'session-1', quote: '这个词出现了两次' }], ...extra,
  }
}

test('the global curator rejects lexicon ops (and anything carrying a libraryId)', async () => {
  const job = { step: '', abort: new AbortController() }
  const result = await curator.commitCuratorOutput({ memories: [lexOp()] }, { job })
  assert.equal(result.created, 0)
  assert.equal(result.skipped.length, 1)
  assert.match(result.skipped[0].reason, /lexicon op rejected/)
  // 带 libraryId 的普通记忆条目同样拒绝——私有目标不属于全局 curator。
  const mixed = await curator.commitCuratorOutput({
    memories: [{ op: 'create', domain: 'coding', title: 't', content: 'c', evidence: [{ session_id: 's', quote: 'q' }], libraryId: 'lib_somewhere' }],
  }, { job })
  assert.equal(mixed.skipped.length, 1)
  assert.match(mixed.skipped[0].reason, /lexicon op rejected/)
  // 什么都没写进全局索引。
  assert.deepEqual(state.loadGlobalIndex().entries, {})
})

test('the private chain commits validated lexicon ops with evidence into the bound library', async () => {
  const libraryId = newLibrary()
  const result = await curator.commitPrivateLexiconOps([lexOp()], { libraryId })
  assert.equal(result.committed.length, 1)
  assert.equal(result.committed[0].status, 'active')
  assert.equal(result.committed[0].created, true)
  const entries = Object.values(lexicon.loadLexicon(libraryId).terms)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].source, 'curator')
  assert.equal(entries[0].meaning, '整理出来的含义')
})

test('needs_review proposals land active too (no review queue exists anymore); evidence-less ops are rejected', async () => {
  const libraryId = newLibrary()
  const held = await curator.commitPrivateLexiconOps([lexOp({ needs_review: true, term: '待复核词' })], { libraryId })
  assert.equal(held.committed[0].status, 'active', 'needs_review no longer parks a term in pending')
  assert.equal(held.committed[0].pendingRevision, false)
  const noEvidence = await curator.commitPrivateLexiconOps([
    lexOp({ term: '没证据', evidence: [] }),
    lexOp({ term: '空证据', evidence: [{ kind: 'message', id: '   ', quote: '   ' }] }),
  ], { libraryId })
  assert.deepEqual(noEvidence.committed, [])
  assert.equal(noEvidence.rejected.length, 2)
  assert.ok(noEvidence.rejected.every(item => item.code === 'LEXICON_EVIDENCE_REQUIRED'))
  assert.equal(Object.keys(lexicon.loadLexicon(libraryId).terms).length, 1)
})

test('delete actions, foreign libraryIds and sensitive triggers are rejected in the op whitelist', async () => {
  const libraryId = newLibrary()
  const result = await curator.commitPrivateLexiconOps([
    lexOp({ term: '要删词', action: 'delete' }),
    lexOp({ term: '越权词', libraryId: 'lib_other' }),
    lexOp({ term: '模型触发', kind: 'trigger' }),
    { op: 'memory', action: 'upsert', term: '不是词典' },
  ], { libraryId })
  assert.deepEqual(result.committed, [])
  assert.deepEqual(result.rejected.map(item => item.code), [
    'LEXICON_ACTION_FORBIDDEN', 'LEXICON_LIBRARY_MISMATCH', 'LEXICON_SENSITIVE_FORBIDDEN',
  ])
  assert.equal(result.skipped.length, 1, 'non-lexicon ops are skipped, not executed')
  const rejected = await curator.commitPrivateLexiconOps([lexOp({ term: 'x' })], { libraryId: '../escape' })
  assert.equal(rejected.rejected.length, 1)
  assert.equal(rejected.rejected[0].code, 'LEXICON_INVALID_LIBRARY_ID')
  assert.equal(Object.keys(lexicon.loadLexicon(libraryId).terms).length, 0)
})

test('a curator op colliding with an active term cannot rewrite its sensitive fields', async () => {
  const libraryId = newLibrary()
  lexicon.upsertLexiconTerm({ libraryId, term: '整理词', kind: 'meme', meaning: '既有含义', source: 'user' })
  const result = await curator.commitPrivateLexiconOps([lexOp({ meaning: '整理出来的含义' })], { libraryId })
  assert.deepEqual(result.committed, [])
  assert.equal(result.rejected.length, 1)
  assert.equal(result.rejected[0].code, 'LEXICON_SENSITIVE_FIELDS_FORBIDDEN')
  assert.equal(Object.values(lexicon.loadLexicon(libraryId).terms)[0].meaning, '既有含义')
  // 同样的含义 + 只改非敏感字段：原地更新成功。
  const applied = await curator.commitPrivateLexiconOps([lexOp({ meaning: '既有含义', usage: '整理补充的用法' })], { libraryId })
  assert.equal(applied.committed.length, 1)
  assert.equal(applied.committed[0].created, false)
  assert.equal(applied.committed[0].status, 'active')
  assert.equal(Object.values(lexicon.loadLexicon(libraryId).terms)[0].usage, '整理补充的用法')
})

// ---- 精确层检索（§2.2 searchLexicon / §3.3 通道 C 的数据面） ----

test('searchLexicon: normalized equality on term and aliases plus containment, query counts recorded once', () => {
  const libraryId = newLibrary()
  const { term } = lexicon.upsertLexiconTerm({
    libraryId, term: '糖刀', kind: 'meme', meaning: '表面发糖、实际虐心', aliases: ['糖里藏刀'],
  })
  // 等值（含大小写/标点归一）、alias 等值、包含（长 query 含词条）三层都命中。
  assert.equal(lexicon.searchLexicon({ libraryId, query: '糖刀！' }, {}).length, 1)
  assert.equal(lexicon.searchLexicon({ libraryId, query: '糖里藏刀' }, {})[0].matchedBy, 'alias')
  assert.equal(lexicon.searchLexicon({ libraryId, query: '这个糖刀梗什么意思' }, {})[0].matchedBy, 'contains')
  // 空查询不检索也不记账。
  assert.deepEqual(lexicon.searchLexicon({ libraryId, query: '   ' }, {}), [])
  // 跨 scope 不可见：词条绑定 w1 时，w2 的查询拿不到。
  const scoped = newLibrary()
  lexicon.upsertLexiconTerm({ libraryId: scoped, term: '界词', kind: 'term', meaning: 'm', context: { worldId: 'w1' } })
  assert.deepEqual(lexicon.searchLexicon({ libraryId: scoped, query: '界词', memoryContext: { worldId: 'w2' } }, {}), [])
  // 归档词条只有显式 includeArchived 才可见；pending/rejected 任何模式都不可见。
  const archivedLibrary = newLibrary()
  const archived = lexicon.upsertLexiconTerm({ libraryId: archivedLibrary, term: '检索归档', kind: 'term', meaning: 'm' })
  lexicon.archiveLexiconTerm({ libraryId: archivedLibrary, termId: archived.term.termId })
  assert.deepEqual(lexicon.searchLexicon({ libraryId: archivedLibrary, query: '检索归档' }, {}), [])
  assert.equal(lexicon.searchLexicon({ libraryId: archivedLibrary, query: '检索归档' }, { includeArchived: true }).length, 1)
  const legacyLibrary = newLibrary()
  const legacy = lexicon.loadLexicon(legacyLibrary)
  legacy.terms['lex-legacy-search'] = legacyEntry('检索旧提案', { status: 'pending' })
  paths.writeJson(lexFile(legacyLibrary), legacy)
  assert.deepEqual(lexicon.searchLexicon({ libraryId: legacyLibrary, query: '检索旧提案' }, {}), [])
  assert.deepEqual(lexicon.searchLexicon({ libraryId: legacyLibrary, query: '检索旧提案' }, { includeArchived: true }), [], 'pending never shows up, not even through includeArchived')
  // 三次可见命中各记一次 query 计数（与 candidate/injection 分开），最后一次显式
  // 记账再 +1。
  const counts = lexicon.lexiconRecordHit(libraryId, term.termId, 'query')
  assert.deepEqual(counts.hitCounts, { candidate: 0, injection: 0, query: 4 })
})

// ---- 锚点摘要（§3.3 通道 A 的数据面） ----

test('lexiconAnchorSummary: top 8 by strength, sensitive triggers listed separately with cap 2', () => {
  const libraryId = newLibrary()
  for (let i = 0; i < 10; i++) {
    lexicon.upsertLexiconTerm({ libraryId, term: `普通词${i}`, kind: 'term', meaning: `含义${i}` })
  }
  // 手工拉开 strength 梯度（写入函数统一给 0.6）。
  const lex = lexicon.loadLexicon(libraryId)
  const ids = Object.keys(lex.terms)
  ids.forEach((id, i) => { lex.terms[id].strength = (i + 1) / 10 })
  paths.writeJson(lexFile(libraryId), lex)
  for (let i = 0; i < 3; i++) {
    lexicon.upsertLexiconTerm({ libraryId, term: `敏感词${i}`, kind: 'trigger', meaning: `触发${i}` })
  }
  const lex2 = lexicon.loadLexicon(libraryId)
  for (const [id, entry] of Object.entries(lex2.terms)) {
    if (entry.kind === 'trigger') entry.strength = 0.95 - (entry.term === '敏感词0' ? 0 : entry.term === '敏感词1' ? 0.1 : 0.2)
  }
  paths.writeJson(lexFile(libraryId), lex2)
  const summary = lexicon.lexiconAnchorSummary(libraryId, {})
  assert.equal(summary.lines.length, 8)
  assert.equal(summary.sensitiveTriggers.length, 2)
  // top8 按 strength 降序：最强（1.0 → 普通词9）在前，最弱的两条（0.1/0.2）被挤掉。
  assert.match(summary.lines[0], /普通词9/)
  assert.ok(!summary.lines.some(line => line.includes('普通词0')))
  assert.ok(!summary.lines.some(line => line.includes('普通词1')), 'the two weakest terms are the ones dropped')
  assert.ok(!summary.lines.some(line => line.includes('敏感')), 'sensitive triggers never mix into the main lines')
  assert.match(summary.sensitiveTriggers[0], /敏感词0/)
  // 敏感词不满足 contextVisible 时不出现。
  const scoped = newLibrary()
  lexicon.upsertLexiconTerm({ libraryId: scoped, term: '别界触发', kind: 'trigger', meaning: 'm', context: { worldId: 'w9' } })
  assert.deepEqual(lexicon.lexiconAnchorSummary(scoped, { worldId: 'w1' }).sensitiveTriggers, [])
})

// ---- P1 revision-keyed 缓存：外部写必须被看见（docs/lexicon-design.md §10） ----

test('the revision-keyed cache never serves stale data after an out-of-process file write', () => {
  const libraryId = newLibrary()
  lexicon.upsertLexiconTerm({ libraryId, term: '缓存词', kind: 'term', meaning: 'v1' })
  assert.equal(Object.values(lexicon.loadLexicon(libraryId).terms)[0].meaning, 'v1', 'cache is warm')
  // 绕过本进程直写（模拟另一个进程/备份恢复/手工修复）：revision + 外来词条。
  const onDisk = JSON.parse(fs.readFileSync(lexFile(libraryId), 'utf8'))
  onDisk.revision = 99
  onDisk.terms['lex-external'] = { term: '外来词', normalizedTerm: '外来词', kind: 'term', meaning: '外部写入', status: 'active', context: {} }
  fs.writeFileSync(lexFile(libraryId), JSON.stringify(onDisk))
  // 强制把 mtime 拨到未来：即便文件系统 mtime 粒度粗，下一条断言也必须成立。
  const future = new Date(Date.now() + 5000)
  fs.utimesSync(lexFile(libraryId), future, future)
  const after = lexicon.loadLexicon(libraryId)
  assert.equal(after.revision, 99, 'stat(mtime+size) mismatch must force a re-read')
  assert.ok(after.terms['lex-external'], 'the external term is visible on the next read')
  assert.equal(Object.values(lexicon.loadLexicon(libraryId).terms).length, 2)
  // 外部删除（文件消失）：绝不能拿缓存里的旧库当答案。
  fs.rmSync(lexFile(libraryId))
  const emptied = lexicon.loadLexicon(libraryId)
  assert.deepEqual({ revision: emptied.revision, terms: emptied.terms }, { revision: 0, terms: {} })
})

test('in-process writes keep the cache fresh without a re-read (mutateLexicon rebuilds the snapshot)', () => {
  const libraryId = newLibrary()
  const { term } = lexicon.upsertLexiconTerm({ libraryId, term: '重建词', kind: 'term', meaning: 'v1' })
  lexicon.upsertLexiconTerm({ libraryId, term: '重建词', kind: 'term', meaning: 'v1', usage: 'v2-usage' })
  const after = lexicon.loadLexicon(libraryId)
  assert.equal(after.revision, 2)
  assert.equal(after.terms[term.termId].usage, 'v2-usage', 'the write path rebuilds the cached snapshot')
  // 返回的 terms 表是浅拷贝：调用方增删键不得污染缓存。
  after.terms['lex-hijack'] = { term: '劫持', normalizedTerm: '劫持', kind: 'term', status: 'active', context: {} }
  assert.equal(Object.keys(lexicon.loadLexicon(libraryId).terms).length, 1)
})

// ---- P1 语义统一（§8.3 / §10）：敏感排序、作用域具体度、visibility 对齐 ----

test('sensitive ranking is unified: sensitivity=sensitive outranks exact normal terms regardless of kind', () => {
  const libraryId = newLibrary()
  lexicon.upsertLexiconTerm({ libraryId, term: '敏感普通词', kind: 'term', meaning: '非触发词的敏感词条', sensitivity: 'sensitive' })
  lexicon.upsertLexiconTerm({ libraryId, term: '普通词条', kind: 'meme', meaning: '普通含义' })
  // 抹平 strength/confidence/updatedAt：顺序只能由敏感优先决定。
  const lex = lexicon.loadLexicon(libraryId)
  for (const entry of Object.values(lex.terms)) {
    entry.strength = 0.5
    entry.confidence = 0.5
    entry.updatedAt = '2026-01-01T00:00:00.000Z'
  }
  paths.writeJson(lexFile(libraryId), lex)
  const hits = lexicon.matchLexiconHits(libraryId, '敏感普通词和普通词条都在这句话里', {})
  assert.equal(hits.length, 2)
  assert.deepEqual(hits.map(hit => hit.term), ['敏感普通词', '普通词条'],
    'both are exact-term hits; the sensitive one (kind=term) must come first under the unified rule')
})

test('scope specificity is pinned: more defined identity fields rank first among otherwise equal hits', () => {
  const libraryId = newLibrary()
  lexicon.upsertLexiconTerm({ libraryId, term: '场景词甲', kind: 'term', meaning: '限定在本世界', context: { worldId: 'w1', characterId: 'c1' } })
  lexicon.upsertLexiconTerm({ libraryId, term: '全局词乙', kind: 'term', meaning: '全场景共享' })
  const lex = lexicon.loadLexicon(libraryId)
  for (const entry of Object.values(lex.terms)) {
    entry.strength = 0.5
    entry.confidence = 0.5
    entry.updatedAt = '2026-01-01T00:00:00.000Z'
  }
  paths.writeJson(lexFile(libraryId), lex)
  // 同敏感档、同 exact-term、同权重：作用域具体度（IDENTITIES 非空数，2 vs 0）决定先后。
  const hits = lexicon.matchLexiconHits(libraryId, '场景词甲和全局词乙都在这句话里', { worldId: 'w1', characterId: 'c1' })
  assert.equal(hits.length, 2)
  assert.deepEqual(hits.map(hit => hit.term), ['场景词甲', '全局词乙'])
  // 空白 current context 看不到带 worldId 的词条，只剩全局词（与 contextVisible 一致）。
  const blind = lexicon.matchLexiconHits(libraryId, '场景词甲和全局词乙都在这句话里', {})
  assert.deepEqual(blind.map(hit => hit.term), ['全局词乙'])
})

test('anchor summary never surfaces visibility=secret terms; the B channel still explains them when named', () => {
  const libraryId = newLibrary()
  lexicon.upsertLexiconTerm({ libraryId, term: '私语词', kind: 'term', meaning: '不主动浮出的词条', visibility: 'secret' })
  lexicon.upsertLexiconTerm({ libraryId, term: '公开词', kind: 'term', meaning: '常规词条' })
  const summary = lexicon.lexiconAnchorSummary(libraryId, {})
  const joined = [...summary.lines, ...summary.sensitiveTriggers].join('\n')
  assert.ok(joined.includes('公开词'))
  assert.ok(!joined.includes('私语词'), 'secret vocabulary stays out of the anchor, like secret memories')
  // 与 lib/memory.js 的 visibility 语义一致：secret 只是不主动浮出，被词面点名时仍然可见。
  const hits = lexicon.matchLexiconHits(libraryId, '有人刚刚提到了私语词', {})
  assert.deepEqual(hits.map(hit => hit.term), ['私语词'])
})
