// 审计第三批的回归用例：只看「这次改动是否真的生效」，不重复既有的行为覆盖。
//
// 每条都对应审查报告里的一个编号，失败信息里写清楚要复现什么症状——这些用例的
// 价值在于它们**能失败**：改动前跑一遍都会红。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-audit3-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const graph = await import('../lib/graph.js')

test.after(() => { try { fs.rmSync(home, { recursive: true, force: true }) } catch {} })

function world(sessionId, { preset = 'coding' } = {}) {
  const cwd = path.join(home, `ws-${sessionId}`)
  state.ensureSession(sessionId, { cwd, agentPreset: preset })
  const binding = state.getSessionBinding(sessionId)
  return {
    sessionId,
    binding,
    libraryId: binding.libraryId,
    exec: { agent: { session: { header: { id: sessionId, cwd, agentPreset: preset } } } },
  }
}

function seed(libraryId, entries) {
  const index = state.loadPrivateIndex(libraryId)
  const now = new Date().toISOString()
  for (const [id, entry] of Object.entries(entries)) {
    index.entries[id] = {
      status: 'active', layer: 'long_term', createdAt: now, updatedAt: now,
      title: entry.title || id, content: entry.content || '', ...entry,
    }
  }
  state.savePrivateIndex(libraryId, index)
  return index.entries
}

// ---------------------------------------------------------------- A-3

test('A-3: injection bookkeeping does not invalidate recall caches', async () => {
  const { exec, libraryId } = world('audit-a3')
  await memory.privateRemember({ exec, title: '缓存键', content: '注入记账不应改变召回缓存键。' })
  const first = await memory.privateRecall({ exec, query: '缓存键', topK: 3, relevanceThreshold: 0 })
  const id = first.files[0]?.name
  assert.ok(id, 'the fixture memory must be recallable first')

  const before = state.memoryRevision()
  // 这正是每一轮的固定节奏：召回 → 注入 → 写索引。旧实现无条件 bump，于是下一轮
  // 的语料缓存与召回缓存必然同时 miss（60s/120s TTL 形同虚设）。
  memory.noteInjected({ libraryId, ids: [id] })
  assert.equal(state.memoryRevision(), before, 'noteInjected must not bump the revision')

  // 真正的写入仍然要让缓存失效，否则就是另一个方向的错误。
  await memory.privateRemember({ exec, title: '新内容', content: '这条写入必须让 revision 前进。' })
  assert.ok(state.memoryRevision() > before, 'a real content write still bumps the revision')
})

// ---------------------------------------------------------------- A-4

test('A-4: a date-only match never outranks a document that matched the query text', async () => {
  const { exec, libraryId } = world('audit-a4')
  seed(libraryId, {
    'mem-work': {
      title: '灰度发布计划',
      content: '灰度发布分三批，第一批只放内部流量，回滚窗口十五分钟。',
    },
    'mem-meeting': {
      title: '无关的会议记录',
      content: '与会者讨论了茶歇与座位安排，没有别的内容。',
      absolute_date: '2026-11-08',
    },
  })
  const result = await memory.privateRecall({ exec, query: '2026-11-08 灰度发布', topK: 3, relevanceThreshold: 0 })
  const names = result.files.map((file) => file.name)
  assert.equal(names[0], 'mem-work', `the document that matched the text must rank first, got ${names.join(',')}`)
  // 旧的 +4 绝对加分足够把 mem-meeting 送进候选并排到前面：BM25 的 IDF 在 N=2/df=1
  // 时约 0.98，一次命中只值不到 1 分，而日期加分是 4。
  assert.ok(names.indexOf('mem-meeting') === -1 || names.indexOf('mem-meeting') > 0,
    'a date-only match is a tie-breaker, not a leader')
})

// ---------------------------------------------------------------- A-2

test('A-2: an empty query returns a page, not the whole library', async () => {
  const { exec, libraryId } = world('audit-a2')
  const entries = {}
  for (let i = 1; i <= 260; i += 1) entries[`mem-bulk${i}`] = { title: `条目 ${i}`, content: `第 ${i} 条记录。` }
  seed(libraryId, entries)
  // 纯标点：分词后没有任何 query term，走的就是「空查询」那条分支。
  const result = await memory.privateRecall({ exec, query: '——', topK: 2, relevanceThreshold: 0 })
  assert.ok(result.files.length <= 40,
    `an empty query must be capped at the candidate cap, got ${result.files.length}`)
})

// ---------------------------------------------------------------- A-5

test('A-5: global recall reports a retrieval share in (0,1], not a raw BM25 score', async () => {
  const { binding, libraryId } = world('audit-a5', { preset: 'rp' })
  const index = state.loadGlobalIndex()
  const now = new Date().toISOString()
  // domain 必须写：全局索引的 domain 缺省是 unknown，会先被 appliesToDomain 滤掉，
  // 那样这条用例测的就不是归一化而是「筛掉了」。
  index.entries['mem-g1'] = { title: '旅店的猫', content: '旅店里有一只三花的猫，常在窗台上睡觉。', domain: 'universal', status: 'active', layer: 'long_term', createdAt: now, updatedAt: now }
  index.entries['mem-g2'] = { title: '旅店的钥匙', content: '旅店的钥匙是铜的，挂在门口的木板上。', domain: 'universal', status: 'active', layer: 'long_term', createdAt: now, updatedAt: now }
  state.saveGlobalIndex(index)
  const exec = { agent: { session: { header: { id: 'audit-a5', cwd: path.join(home, 'ws-audit-a5'), agentPreset: 'rp' } } } }
  const out = await memory.globalRecall({ exec, query: '旅店', topK: 3, relevanceThreshold: 0 })
  void binding
  void libraryId
  assert.ok(out.files.length >= 2, 'both旅店 memories should match')
  for (const file of out.files) {
    assert.ok(Number(file.retrieval) > 0 && Number(file.retrieval) <= 1,
      `retrieval must be a share in (0,1], got ${file.retrieval} for ${file.name}`)
  }
  // 同一把尺：私有层的 retrievalShare 以 1/(rank+1) 起算，global 归一化后首条应接近 1。
  assert.ok(out.files[0].retrieval >= out.files[1].retrieval, 'normalised shares keep the ranking')
})

// ---------------------------------------------------------------- A-6

test('A-6: a negation in an unrelated clause is not a contradiction', () => {
  const entries = {
    'mem-tea': { title: '喝茶', content: '他喜欢喝茶', status: 'active' },
  }
  const clash = memory.findConflict(entries, { title: '喝茶（复述）', content: '他喜欢喝茶，别忘了' })
  assert.equal(clash, null, 'a trailing 别忘了 must not turn a restatement into a conflict')
})

test('A-6: a short claim contained in a long rewrite still detects the contradiction', () => {
  // 长度差 0.9 → dice 恒为 0，只有逐字包含探针能把这对待检对送到 negation 判断。
  // 标题必须不同：同标题会先命中 same_title 分支，测不到这里。
  const shortBody = '周五提交这份报告'
  const longBody = '他先说明自己这周的工作安排，又提到评审会和排期，最后他说他不准备周五提交这份报告，'
    + '因为上游依赖还没合并，需要等下周一起看，并且已经把这件事记在了待办里，提醒自己别忘了。'
  const entries = { 'mem-long': { title: '周报初稿', content: longBody, status: 'active' } }
  const clash = memory.findConflict(entries, { title: '周报（复述）', content: shortBody })
  assert.ok(clash, 'containment must carry a length-disparate pair to the negation test')
  assert.equal(clash.reason, 'negation')
  // 反过来再确认一次：包含关系本身不是冲突。同一段长文本去掉否定词后，
  // similarityDetail 的结论一模一样，只有极性测试能把它放过去——这条断言就是
  // 在证明上面那个 negation 不是「包含即冲突」的副作用。
  const restated = memory.findConflict(
    { 'mem-pos': { title: '周报初稿', content: longBody.replace('他不准备', '他准备'), status: 'active' } },
    { title: '周报（复述）', content: shortBody },
  )
  assert.equal(restated, null, 'containment with the same polarity must not be a contradiction')
})

// ---------------------------------------------------------------- G-1-2

test('G-1-2: a conflict pair takes a seat instead of growing the block past topK', async () => {
  const { exec, libraryId } = world('audit-g12')
  seed(libraryId, {
    'mem-a': { title: '部署窗口', content: '部署窗口定在周四凌晨两点。', conflicts_with: 'mem-b' },
    'mem-b': { title: '部署窗口（另一版）', content: '部署窗口定在周五凌晨两点。', conflicts_with: 'mem-a' },
    'mem-c': { title: '茶歇', content: '茶歇有红茶和饼干，放在走廊尽头。' },
  })
  const result = await memory.privateRecall({ exec, query: '部署窗口', topK: 2, relevanceThreshold: 0 })
  const names = result.files.map((file) => file.name)
  assert.ok(names.includes('mem-a') && names.includes('mem-b'), `both halves must survive, got ${names.join(',')}`)
  assert.equal(result.files.length, 2,
    `the block must stay within topK by giving up an unpaird seat, got ${names.join(',')}`)
})

// ---------------------------------------------------------------- G-1-3

test('G-1-3: reverting an import batch removes what the package created and nothing else', async () => {
  const { libraryId } = world('audit-g13')
  // 导入前的存量：一条记忆 + 它引用的实体。撤销导入绝不能碰它们。
  const own = graph.createEntity({ libraryId, name: '李四', kind: 'person' })
  seed(libraryId, {
    'mem-own': { title: '存量条目', content: '李四负责前端。', links: [{ to: own.id, kind: 'mentions' }] },
    // 包里的记忆先落盘，links 指向包里的旧实体 id，由 restoreGraphData 重映射。
    'mem-imp-1': { title: '导入条目', content: '张三负责发布。', links: [{ to: 'ent-old', kind: 'mentions' }] },
  })
  const restored = graph.restoreGraphData(libraryId, {
    entities: { 'ent-old': { name: '张三', kind: 'person' } },
    relationships: {},
  }, { 'mem-old-1': 'mem-imp-1' }, { origin: 'bnd-test-1' })
  assert.equal(restored.createdEntityIds.length, 1, 'restoreGraphData must report what it created')
  // 实体没有记忆/关系引用时会被 orphan prune 立刻收走——这也是为什么上面的
  // mem-imp-1 必须带 link：否则这条用例看到的是一个空 store，什么都测不到。
  memory.recordImportBatch({ libraryId, batchId: 'bnd-test-1', entities: restored.createdEntityIds })
  const entities = () => graph.listEntities({ libraryId }).items
  assert.ok(entities().some((entity) => entity.name === '张三'), 'the imported entity is there before the revert')

  const reverted = await memory.revertImportBatch({ libraryId, batchId: 'bnd-test-1' })
  assert.deepEqual(reverted.entities, restored.createdEntityIds)
  assert.ok(!entities().some((entity) => entity.name === '张三'), 'the imported entity is gone')
  assert.ok(entities().some((entity) => entity.id === own.id), 'the user\u2019s own entity survives')
  assert.deepEqual(reverted.entityFailures, [], 'a clean revert reports no per-entity failure')
})

// ---------------------------------------------------------------- G-1-4

test('G-1-4: session pruning refuses a zero-day window and skips a live lease', () => {
  assert.throws(() => state.pruneSessionBindings({ olderThanDays: 0, dryRun: true }),
    /positive number of days/, '0 is not "all" — it must not be a wipe command')

  const sessionId = 'audit-g14'
  const cwd = path.join(home, 'ws-audit-g14')
  state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  state.setSessionBinding(sessionId, { lastTurnAt: new Date(Date.now() - 90 * 86_400_000).toISOString() })

  const busy = state.pruneSessionBindings({ olderThanDays: 30, dryRun: true, isBusy: () => true })
  assert.equal(busy.candidates.length, 0, 'a session with a live lease is not a candidate')
  assert.equal(busy.skipped.length, 1)
  assert.match(busy.skipped[0].reason, /consolidation lease/)

  const idle = state.pruneSessionBindings({ olderThanDays: 30, dryRun: true, isBusy: () => false })
  assert.equal(idle.candidates.length, 1)
  assert.equal(idle.removed.length, 0, 'a dry run never deletes')
})

// ---------------------------------------------------------------- S-10

test('S-10: a flush that hits a busy lock re-arms itself instead of stranding the batch', async () => {
  // updateState 排的是一次 50ms 后的 flush；flushState 先把 timer 清空再抢锁，
  // 抢不到就抛 DSH_MEMU_STORE_BUSY。旧实现在这条路径上不再排下一次，
  // 于是 pending 记账一直留在内存里，直到下一次无关写入把它捎带出去。
  state.updateState((draft) => { draft.__flushProbe = 'pending'; return draft })
  const stateFile = path.join(home, 'state.json')
  const lockFile = stateFile + '.lock'
  fs.writeFileSync(lockFile, String(process.pid))
  try {
    await new Promise((resolve) => setTimeout(resolve, 700))
    assert.throws(() => state.flushState(), /busy|BUSY|store/i, 'the lock is still held at this point')
  } finally {
    fs.rmSync(lockFile, { force: true })
  }
  // 锁释放后，重排的那次 flush 必须把这条记账落盘。
  const deadline = Date.now() + 3000
  let persisted = false
  while (Date.now() < deadline) {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    if (raw.__flushProbe === 'pending') { persisted = true; break }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(persisted, 'the failed flush must be retried and land the pending write')
})
