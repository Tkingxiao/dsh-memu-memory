import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-private-links-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const state = await import('../lib/state.js')
const graph = await import('../lib/graph.js')
const activity = await import('../lib/activity-log.js')
const privateLinks = await import('../lib/private-links.js')
const {
  suggestPrivateLinks,
  autoLinkPrivateMemories,
  normalizeEntityName,
  inferEntityKind,
} = privateLinks

// 旧写路径的用例验证 deterministic 模式下的行为；默认的 suggest（只出候选）
// 与 off 由文件末尾的专门用例覆盖。
state.updateSettings({ autoLinkMode: 'deterministic' })

test.after(() => {
  try { state.flushState() } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

const ZERO = { linked: 0, entities: 0, suggested: 0, candidates: [], autoLinked: [] }

function entry(title, content, extra = {}) {
  return { title, content, status: 'active', visibility: 'shared', layer: 'long_term', ...extra }
}

function snapshot(entries) {
  return { version: 1, entries }
}

function bind(sessionId) {
  return state.ensureSession(sessionId, { cwd: path.join(home, 'ws', sessionId), agentPreset: 'rp' })
}

function labels(pairs) {
  return pairs.map(pair => `${pair.from}->${pair.to}`)
}

// ---- 纯函数：规范化 / 实体类型 ----

test('normalizeEntityName folds case, width, whitespace and punctuation', () => {
  assert.equal(normalizeEntityName('Yuike'), 'yuike')
  assert.equal(normalizeEntityName(' Ｙｕｉｋｅ! '), 'yuike')
  assert.equal(normalizeEntityName('yuike_01'), 'yuike01')
  assert.equal(normalizeEntityName('Yuike-Chan'), 'yuikechan')
  assert.equal(normalizeEntityName(''), '')
})

test('inferEntityKind: person cues win, Latin falls back to thing, CJK without cues stays uncertain', () => {
  assert.equal(inferEntityKind([
    { title: '猫娘yuike', content: '' },
    { title: 'yuike名字的由来', content: '' },
  ], 'yuike'), 'person')
  assert.equal(inferEntityKind([
    { title: 'nebula kickoff', content: 'a nebula survey starts at dawn' },
  ], 'nebula'), 'thing')
  assert.equal(inferEntityKind([
    { title: '星港入口', content: '深夜的星港入口很冷' },
  ], '星港'), null, 'a CJK token with no person cue must stay unresolved')
})

// ---- 纯函数：高置信直连 + 实体枢纽 ----

test('yuike: a rare name-like pair is linked and becomes a person hub reused by case-insensitive name', () => {
  const index = snapshot({
    'mem-a': entry('猫娘yuike', 'yuike 是一只住在窗台的猫娘，喜欢在午后晒太阳。'),
    'mem-b': entry('yuike名字的由来', '这个名字来自小时候养过的一只白猫，后来一直被沿用。'),
  })
  const result = suggestPrivateLinks({ index, ids: ['mem-a'] })
  assert.equal(result.autoLinks.length, 1)
  const link = result.autoLinks[0]
  assert.equal(link.from, 'mem-a')
  assert.equal(link.to, 'mem-b')
  assert.equal(link.token, 'yuike')
  assert.equal(link.nameLike, true)
  assert.ok(link.confidence >= 0.6 && link.confidence <= 0.78, 'name-like confidence lives in the 0.6–0.78 band')
  assert.deepEqual(labels(result.candidates), [], 'a resolved pair never appears in candidates')
  assert.equal(result.entityHubs.length, 1)
  const hub = result.entityHubs[0]
  assert.equal(hub.token, 'yuike')
  assert.equal(hub.name, 'yuike', 'display name keeps the original casing from the first title')
  assert.equal(hub.kind, 'person')
  assert.equal('entityId' in hub, false)
  assert.deepEqual(new Set(hub.memoryIds), new Set(['mem-a', 'mem-b']))

  const reused = suggestPrivateLinks({
    index,
    entities: [{ id: 'ent-yuike', name: 'Yuike', kind: 'person', aliases: [] }],
    ids: ['mem-a'],
  })
  assert.equal(reused.entityHubs.length, 1)
  assert.equal(reused.entityHubs[0].entityId, 'ent-yuike', 'a pre-existing Yuike entity is reused, not duplicated')
  assert.equal(reused.autoLinks.length, 1)

  const nfkc = suggestPrivateLinks({
    index,
    entities: [{ id: 'ent-yuike', name: 'Ｙｕｉｋｅ', kind: 'person', aliases: ['yuike-chan'] }],
    ids: ['mem-a'],
  })
  assert.equal(nfkc.entityHubs[0].entityId, 'ent-yuike', 'NFKC + punctuation-insensitive name matching')
})

// ---- 纯函数：资格过滤 ----

test('secret, archived, pending_review, other context, other track and invisible entries are filtered', () => {
  bind('links-pure-filter')
  const index = snapshot({
    'mem-new': entry('yuike main', 'yuike 的第一条日常记录。'),
    'mem-ok': entry('yuike friend', 'yuike 的第二条日常记录。'),
    'mem-context': entry('yuike other', '别处的记录。', { context: { characterId: 'other' } }),
    'mem-secret': entry('yuike secret', '秘密记录。', { visibility: 'secret' }),
    'mem-archived': entry('yuike archived', '旧记录。', { status: 'archived' }),
    'mem-pending': entry('yuike pending', '待复核记录。', { status: 'pending_review' }),
    'mem-known': entry('yuike known', '只有某个角色知道的记录。', { context: { knownBy: ['someone-else'] } }),
  })
  const result = suggestPrivateLinks({ index, ids: ['mem-new'], sessionId: 'links-pure-filter' })
  assert.deepEqual(labels(result.autoLinks), ['mem-new->mem-ok'])
  assert.equal(result.entityHubs.length, 1)
  assert.deepEqual(new Set(result.entityHubs[0].memoryIds), new Set(['mem-new', 'mem-ok']))
  assert.deepEqual(result.candidates, [])
  const seen = JSON.stringify(result)
  for (const excluded of ['mem-context', 'mem-secret', 'mem-archived', 'mem-pending', 'mem-known']) {
    assert.ok(!seen.includes(excluded), `${excluded} must not appear anywhere in the suggestions`)
  }
})

test('a shared token is never linked across tracks', () => {
  const index = snapshot({
    'mem-track-a': entry('yuike main', 'yuike 的第一条日常记录。'),
    'mem-track-b': entry('yuike habit', 'yuike 的习惯记录。', { track: 'habit' }),
  })
  const result = suggestPrivateLinks({ index, ids: ['mem-track-a'] })
  assert.deepEqual(result.autoLinks, [])
  assert.deepEqual(result.candidates, [])
  assert.deepEqual(result.entityHubs, [], 'groups are also partitioned by track')
})

// ---- 纯函数：重复 / 冲突 / 已有 link ----

test('pairScore >= 0.82, findConflict hits and existing relation/person links skip the pair', () => {
  // Duplicate band: identical title + body is a merge problem, not a link.
  const duplicate = snapshot({
    'mem-dup-a': entry('yuike profile', 'yuike lives by the window and naps in the afternoon sun every single day.'),
    'mem-dup-b': entry('yuike profile', 'yuike lives by the window and naps in the afternoon sun every single day.'),
  })
  const dupResult = suggestPrivateLinks({ index: duplicate, ids: ['mem-dup-a'] })
  assert.deepEqual(labels(dupResult.autoLinks), [])
  assert.deepEqual(labels(dupResult.candidates), [])

  // Conflict: same title but contradictory bodies (findConflict same_title).
  const conflict = snapshot({
    'mem-cf-a': entry('yuike setting', 'yuike 喜欢在雨天沿着河堤散步。'),
    'mem-cf-b': entry('yuike setting', 'yuike 讨厌所有甜食和奶油蛋糕。'),
  })
  const cfResult = suggestPrivateLinks({ index: conflict, ids: ['mem-cf-a'] })
  assert.deepEqual(labels(cfResult.autoLinks), [])
  assert.deepEqual(labels(cfResult.candidates), [])

  // Existing relation link from the new entry: idempotent.
  const forward = snapshot({
    'mem-lk-a': entry('yuike linked', 'yuike 的第一条记录。', {
      links: [{ to: 'mem-lk-b', kind: 'relation', note: 'already linked by an earlier pass', confidence: 0.7 }],
    }),
    'mem-lk-b': entry('yuike partner', 'yuike 的第二条记录。'),
  })
  const fwResult = suggestPrivateLinks({ index: forward, ids: ['mem-lk-a'] })
  assert.deepEqual(labels(fwResult.autoLinks), [])
  assert.deepEqual(labels(fwResult.candidates), [])

  // Existing link in the OTHER direction must also block the pair.
  const backward = snapshot({
    'mem-rv-a': entry('yuike reverse', 'yuike 的第一条记录。'),
    'mem-rv-b': entry('yuike reverse partner', 'yuike 的第二条记录。', {
      links: [{ to: 'mem-rv-a', kind: 'relation', note: 'already linked by an earlier pass', confidence: 0.7 }],
    }),
  })
  const rvResult = suggestPrivateLinks({ index: backward, ids: ['mem-rv-a'] })
  assert.deepEqual(labels(rvResult.autoLinks), [])
  assert.deepEqual(labels(rvResult.candidates), [])
})

// ---- 纯函数：停用词 ----

test('stopword-only title overlaps never auto-link and never become candidates', () => {
  const index = snapshot({
    'mem-sw-a': entry('记忆的名字', '窗台上的灰尘积了很厚。'),
    'mem-sw-b': entry('名字的记忆', '码头今天停了三艘货轮。'),
  })
  const result = suggestPrivateLinks({ index, ids: ['mem-sw-a'] })
  assert.deepEqual(result.autoLinks, [])
  assert.deepEqual(result.candidates, [])
  assert.deepEqual(result.entityHubs, [])
})

// ---- 纯函数：上限 ----

test('perEntry, total, maxCandidates and maxEntities caps hold', () => {
  const index = snapshot({
    'mem-new-1': entry('alpha bravo', 'alpha survey starts at dawn.'),
    'mem-new-2': entry('charlie delta', 'charlie survey ends at dusk.'),
    'mem-old-a': entry('alpha archive', 'archive of the alpha survey.'),
    'mem-old-b': entry('bravo archive', 'archive of the bravo survey.'),
    'mem-old-c': entry('charlie archive', 'archive of the charlie survey.'),
    'mem-old-d': entry('delta archive', 'archive of the delta survey.'),
  })
  const ids = ['mem-new-1', 'mem-new-2']
  const withDefaults = suggestPrivateLinks({ index, ids, maxEntities: 4 })
  assert.equal(withDefaults.autoLinks.length, 4)
  assert.equal(withDefaults.autoLinks.filter(link => link.from === 'mem-new-1').length, 2)
  assert.equal(withDefaults.autoLinks.filter(link => link.from === 'mem-new-2').length, 2)
  assert.equal(withDefaults.entityHubs.length, 4)

  const perEntry = suggestPrivateLinks({ index, ids, perEntry: 1, maxEntities: 4 })
  assert.equal(perEntry.autoLinks.length, 2)
  assert.equal(perEntry.autoLinks.filter(link => link.from === 'mem-new-1').length, 1)
  assert.equal(perEntry.autoLinks.filter(link => link.from === 'mem-new-2').length, 1)

  const total = suggestPrivateLinks({ index, ids, total: 3, maxEntities: 4 })
  assert.equal(total.autoLinks.length, 3)

  const entities = suggestPrivateLinks({ index, ids, maxEntities: 2 })
  assert.equal(entities.entityHubs.length, 2)

  // Candidates are capped too, highest score first. Unresolved CJK hubs are the
  // uncertain kind, so three pairs yield three candidates.
  const uncertain = snapshot({
    'mem-u1': entry('星港入口', '深夜的星港入口很冷，风从闸门缝里灌进来。'),
    'mem-u2': entry('星港记录', '档案室的旧星港记录已经泛黄，编号从三年前开始。'),
    'mem-v1': entry('雾谷入口', '清晨的雾谷入口很安静，石阶上还挂着水珠。'),
    'mem-v2': entry('雾谷记录', '旧册子里的雾谷记录被虫蛀了一角，字迹模糊。'),
    'mem-w1': entry('白塔入口', '黄昏的白塔入口被藤蔓遮住，门锁已经锈死。'),
    'mem-w2': entry('白塔记录', '白塔记录停在二十年前，最后一页没有落款。'),
  })
  const all = suggestPrivateLinks({ index: uncertain, ids: ['mem-u1', 'mem-v1', 'mem-w1'] })
  assert.equal(all.candidates.length, 3)
  assert.equal(all.autoLinks.length, 0)
  assert.equal(all.entityHubs.length, 0)
  const capped = suggestPrivateLinks({ index: uncertain, ids: ['mem-u1', 'mem-v1', 'mem-w1'], maxCandidates: 2 })
  assert.equal(capped.candidates.length, 2)
  assert.ok(capped.candidates[0].score >= capped.candidates[1].score, 'highest score is preferred')
})

// ---- 纯函数：不确定实体类型 / thing / kind 冲突 ----

test('CJK name-like token without a person cue is an uncertain candidate, not a hub', () => {
  const index = snapshot({
    'mem-a': entry('星港入口', '深夜的星港入口很冷，风从闸门缝里灌进来。'),
    'mem-b': entry('星港记录', '档案室的旧星港记录已经泛黄，编号从三年前开始。'),
  })
  const result = suggestPrivateLinks({ index, ids: ['mem-a'] })
  assert.deepEqual(result.autoLinks, [], 'an unresolved entity kind does not auto-link')
  assert.deepEqual(result.entityHubs, [], 'a CJK token without a person cue never auto-creates a hub')
  assert.equal(result.candidates.length, 1)
  const candidate = result.candidates[0]
  assert.deepEqual(Object.keys(candidate).sort(), ['from', 'preview', 'score', 'sharedToken', 'suggestedEntity', 'title', 'to'])
  assert.equal(candidate.from, 'mem-a')
  assert.equal(candidate.to, 'mem-b')
  assert.equal(candidate.sharedToken, '星港')
  assert.deepEqual(candidate.suggestedEntity, { name: '星港', kind: null })
  assert.equal(candidate.title, '星港记录', 'title/preview describe the OTHER memory')
  assert.equal(candidate.preview, '档案室的旧星港记录已经泛黄，编号从三年前开始。')
  assert.ok(candidate.title.length <= 80)
  assert.ok(candidate.preview.length <= 120)
})

test('a Latin name-like token without a person cue becomes a thing hub', () => {
  const index = snapshot({
    'mem-c': entry('nebula kickoff', 'the nebula survey starts at dawn near the outer ring.'),
    'mem-d': entry('nebula notes', 'a nebula chart was folded inside the old folder.'),
  })
  const result = suggestPrivateLinks({ index, ids: ['mem-c'] })
  assert.equal(result.autoLinks.length, 1)
  assert.equal(result.entityHubs.length, 1)
  assert.equal(result.entityHubs[0].kind, 'thing')
  assert.equal(result.entityHubs[0].name, 'nebula')
  assert.deepEqual(result.candidates, [])
})

test('an existing entity with a conflicting kind blocks the auto-link and becomes an uncertain candidate', () => {
  const index = snapshot({
    'mem-c': entry('nebula kickoff', 'the nebula survey starts at dawn near the outer ring.'),
    'mem-d': entry('nebula notes', 'a nebula chart was folded inside the old folder.'),
  })
  const result = suggestPrivateLinks({
    index,
    entities: [{ id: 'ent-nebula', name: 'NEBULA', kind: 'person', aliases: [] }],
    ids: ['mem-c'],
  })
  assert.deepEqual(result.autoLinks, [])
  assert.deepEqual(result.entityHubs, [])
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].sharedToken, 'nebula')
  assert.deepEqual(result.candidates[0].suggestedEntity, { name: 'nebula', kind: 'thing' })
})

// ---- 应用层 ----

test('deterministic mode links mentions of a confirmed entity and never writes lexical pairs', async () => {
  activity.clearEvents()
  const binding = bind('links-apply')
  const libraryId = binding.libraryId
  const yuike = graph.createEntity({ libraryId, name: 'Yuike', kind: 'person', status: 'confirmed', confirmedBy: 'user' })
  state.savePrivateIndex(libraryId, snapshot({
    'mem-a': entry('猫娘yuike', 'yuike 是一只住在窗台的猫娘，喜欢在午后晒太阳。'),
    'mem-b': entry('yuike名字的由来', '这个名字来自小时候养过的一只白猫，后来一直被沿用。'),
  }))

  const result = await autoLinkPrivateMemories({ libraryId, sessionId: 'links-apply', ids: ['mem-a', 'mem-b'] })
  assert.equal(result.linked, 0, 'the old lexical memory↔memory edge is never written')
  assert.equal(result.entities, 2, 'both memories mention the confirmed entity')
  assert.equal(result.suggested, 0)
  assert.deepEqual(result.candidates, [])
  assert.deepEqual(result.autoLinked.map(item => `${item.from}->${item.to}:${item.kind}`), [
    `mem-a->${yuike.id}:person`,
    `mem-b->${yuike.id}:person`,
  ])
  for (const item of result.autoLinked) assert.deepEqual(Object.keys(item).sort(), ['from', 'kind', 'to'])

  const index = state.loadPrivateIndex(libraryId)
  const outbound = index.entries['mem-a'].links || []
  assert.equal(outbound.some(link => link.to === 'mem-b'), false, 'no lexical pair edge survives')
  const entityLink = outbound.find(link => link.to === yuike.id)
  assert.ok(entityLink, 'the confirmed-entity mention is persisted')
  assert.equal(entityLink.kind, 'person')
  assert.equal(entityLink.source, 'auto')
  assert.equal(entityLink.confidence, 1, 'deterministic edges are confidence 1.0')
  assert.equal(entityLink.schemaVersion, 2)
  assert.equal(entityLink.evidence.rule, 'entity-mention')
  assert.equal(entityLink.evidence.entityId, yuike.id)
  assert.equal(entityLink.evidence.surface, 'Yuike')
  assert.equal(entityLink.evidence.field, 'title')
  assert.match(entityLink.note, /已确认实体/)

  const events = activity.listEvents({ kind: 'write', sessionId: 'links-apply' })
  const applyEvent = events.find(event => event.detail?.op === 'auto-link-apply' && event.ok)
  assert.ok(applyEvent, 'the deterministic write is recorded in the activity log')
  assert.equal(applyEvent.detail.added, 2)
  assert.equal(applyEvent.detail.entity, 2)

  activity.clearEvents()
  const again = await autoLinkPrivateMemories({ libraryId, sessionId: 'links-apply', ids: ['mem-a', 'mem-b'] })
  assert.equal(again.linked, 0)
  assert.equal(again.entities, 0, 'an unchanged pass is a no-op')
  assert.deepEqual(again.autoLinked, [])
  const after = state.loadPrivateIndex(libraryId)
  assert.equal((after.entries['mem-a'].links || []).filter(link => link.to === yuike.id).length, 1)
})

test('a confirmed non-person entity produces relation-kind mention edges', async () => {
  activity.clearEvents()
  const binding = bind('links-thing')
  const libraryId = binding.libraryId
  const nebula = graph.createEntity({ libraryId, name: 'nebula', kind: 'thing', status: 'confirmed', confirmedBy: 'user' })
  state.savePrivateIndex(libraryId, snapshot({
    'mem-c': entry('nebula kickoff', 'the nebula survey starts at dawn near the outer ring.'),
    'mem-d': entry('nebula notes', 'a nebula chart was folded inside the old folder.'),
  }))
  const result = await autoLinkPrivateMemories({ libraryId, sessionId: 'links-thing', ids: ['mem-c', 'mem-d'] })
  assert.equal(result.linked, 0)
  assert.equal(result.entities, 2)
  const index = state.loadPrivateIndex(libraryId)
  const link = (index.entries['mem-c'].links || []).find(item => item.to === nebula.id)
  assert.ok(link)
  assert.equal(link.kind, 'relation', 'non-person entities use kind relation')
  assert.equal(link.evidence.rule, 'entity-mention')
})

test('autoLinkPrivateMemories never throws on a missing or broken index and logs a warning path', async () => {
  activity.clearEvents()
  // Missing index: an empty library is a no-op, not a failure.
  const missing = bind('links-missing')
  assert.deepEqual(
    await autoLinkPrivateMemories({ libraryId: missing.libraryId, sessionId: 'links-missing', ids: ['mem-none'] }),
    ZERO,
  )
  // Unknown library: the top-level load must be caught.
  assert.deepEqual(
    await autoLinkPrivateMemories({ libraryId: 'no-such-library', sessionId: 'links-missing', ids: ['mem-none'] }),
    ZERO,
  )
  // Invalid library id reaches loadPrivateIndex's own guard.
  assert.deepEqual(
    await autoLinkPrivateMemories({ libraryId: '../escape', sessionId: 'links-missing', ids: ['mem-a'] }),
    ZERO,
  )
  // Corrupt entity store fails listEntities AFTER the index loaded; nothing is written.
  const broken = bind('links-broken')
  state.savePrivateIndex(broken.libraryId, snapshot({
    'mem-a': entry('yuike one', 'yuike 的第一条日常记录。'),
    'mem-b': entry('yuike two', 'yuike 的第二条日常记录。'),
  }))
  fs.mkdirSync(path.join(home, 'index'), { recursive: true })
  fs.writeFileSync(path.join(home, 'index', `${broken.libraryId}.entities.json`), '{not json', 'utf8')
  assert.deepEqual(
    await autoLinkPrivateMemories({ libraryId: broken.libraryId, sessionId: 'links-broken', ids: ['mem-a'] }),
    ZERO,
  )
  assert.equal(state.loadPrivateIndex(broken.libraryId).entries['mem-a'].links, undefined, 'a failed pass writes nothing')
  const warnings = activity.listEvents({ kind: 'write', level: 'warn' })
  assert.ok(warnings.length >= 2, 'each top-level failure leaves a warning row')
  assert.ok(warnings.some(event => event.detail?.op === 'auto-link'))
  assert.ok(warnings.some(event => /unknown library|invalid library id|cannot read entity store/.test(event.message)))
  fs.rmSync(path.join(home, 'index', `${broken.libraryId}.entities.json`), { force: true })

  // No ids: zero without writes or log noise.
  const before = activity.listEvents({ kind: 'write' }).length
  assert.deepEqual(
    await autoLinkPrivateMemories({ libraryId: broken.libraryId, sessionId: 'links-broken' }),
    ZERO,
  )
  assert.deepEqual(
    await autoLinkPrivateMemories({ libraryId: broken.libraryId, sessionId: 'links-broken', ids: [] }),
    ZERO,
  )
  assert.equal(activity.listEvents({ kind: 'write' }).length, before, 'no ids means no work and no log row')
})

test('suggest is the default mode and the only valid values are suggest/deterministic/off', () => {
  assert.equal(state.DEFAULT_SETTINGS.autoLinkMode, 'suggest', 'migration starts with the write gate closed')
  assert.equal(state.DEFAULT_SETTINGS.allowWorkerAssertion, false, 'worker assertion is reserved and off')
  assert.throws(() => state.updateSettings({ autoLinkMode: 'auto' }), /invalid setting autoLinkMode/)
  assert.throws(() => state.updateSettings({ allowWorkerAssertion: 'yes' }), /must be boolean/)
})

test('suggest mode returns candidates without writing edges or creating entities', async () => {
  state.updateSettings({ autoLinkMode: 'suggest' })
  try {
    const binding = bind('links-suggest')
    const libraryId = binding.libraryId
    state.savePrivateIndex(libraryId, snapshot({
      'mem-a': entry('星港入口', '深夜的星港入口很冷，风从卸货区一直灌进来。'),
      'mem-b': entry('星港夜班', '星港的夜班登记表还压在值班室桌上。'),
    }))
    const result = await autoLinkPrivateMemories({ libraryId, sessionId: 'links-suggest', ids: ['mem-a'] })
    assert.equal(result.linked, 0, 'suggest never writes a memory edge')
    assert.equal(result.entities, 0, 'suggest never creates or links an entity')
    assert.deepEqual(result.autoLinked, [])
    assert.equal(result.candidates.length, 1, 'the uncertain pair is still returned for adjudication')
    assert.equal(result.suggested, 1)
    const index = state.loadPrivateIndex(libraryId)
    assert.equal(index.entries['mem-a'].links, undefined, 'index is untouched')
    assert.deepEqual(Object.keys(graph.graphExport(libraryId).entities), [], 'no entity is created')
  } finally {
    state.updateSettings({ autoLinkMode: 'deterministic' })
  }
})

test('off mode skips the suggestion pass entirely', async () => {
  state.updateSettings({ autoLinkMode: 'off' })
  try {
    const binding = bind('links-off')
    const libraryId = binding.libraryId
    state.savePrivateIndex(libraryId, snapshot({
      'mem-a': entry('猫娘yuike', 'yuike 是一只住在窗台的猫娘，喜欢在午后晒太阳。'),
      'mem-b': entry('yuike名字的由来', '这个名字来自小时候养过的一只白猫，后来一直被沿用。'),
    }))
    const result = await autoLinkPrivateMemories({ libraryId, sessionId: 'links-off', ids: ['mem-a'] })
    assert.deepEqual(result, ZERO)
    assert.equal(state.loadPrivateIndex(libraryId).entries['mem-a'].links, undefined)
    assert.deepEqual(Object.keys(graph.graphExport(libraryId).entities), [])
  } finally {
    state.updateSettings({ autoLinkMode: 'deterministic' })
  }
})

test('the default export exposes the whole module surface', () => {
  assert.equal(privateLinks.default.suggestPrivateLinks, suggestPrivateLinks)
  assert.equal(privateLinks.default.autoLinkPrivateMemories, autoLinkPrivateMemories)
  assert.equal(privateLinks.default.normalizeEntityName, normalizeEntityName)
  assert.equal(privateLinks.default.inferEntityKind, inferEntityKind)
})
