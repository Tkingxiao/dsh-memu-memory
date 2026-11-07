import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-bm25-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')

test.after(() => {
  delete process.env.DSH_MEMU_RECALL_LEXICAL
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function fixture() {
  const sessionId = 'bm25-session'
  const cwd = path.join(home, 'ws-bm25')
  state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const binding = state.getSessionBinding(sessionId)
  const index = state.loadPrivateIndex(binding.libraryId)
  const now = new Date().toISOString()
  // "版本" is common across the corpus; "灰度" exists only in the target. The
  // legacy includes scorer weights the title of every decoy above the target's body.
  for (let i = 1; i <= 20; i += 1) {
    index.entries[`mem-decoy${i}`] = {
      title: `版本记录 ${i}`,
      content: `这是第 ${i} 次版本记录，只记录版本号和变更人，没有别的说明。`,
      status: 'active', layer: 'long_term', createdAt: now, updatedAt: now,
    }
  }
  index.entries['mem-target'] = {
    title: '发布说明',
    content: '本次版本更新包含灰度发布，灰度只允许在变更窗口内执行。',
    status: 'active', layer: 'long_term', createdAt: now, updatedAt: now,
  }
  state.savePrivateIndex(binding.libraryId, index)
  return {
    sessionId,
    exec: { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding' } } } },
  }
}

async function recall(exec, mode) {
  if (mode === 'includes') process.env.DSH_MEMU_RECALL_LEXICAL = 'includes'
  else delete process.env.DSH_MEMU_RECALL_LEXICAL
  return memory.privateRecall({ exec, query: '版本 灰度', topK: 5, relevanceThreshold: 0 })
}

function rankOf(result, id) {
  const index = result.files.findIndex((file) => file.name === id)
  return index < 0 ? Infinity : index + 1
}

test('BM25 ranks the rare-term target first where includes-count does not', async () => {
  const { exec } = fixture()
  const legacy = await recall(exec, 'includes')
  const bm25 = await recall(exec, 'bm25')

  const legacyRank = rankOf(legacy, 'mem-target')
  const bm25Rank = rankOf(bm25, 'mem-target')
  assert.equal(bm25Rank, 1, 'BM25 must put the only 灰度 memory first')
  assert.ok(legacyRank > 5, `includes-count must miss Recall@5, got rank ${legacyRank}`)
  assert.ok(1 / bm25Rank > 1 / legacyRank, 'MRR must improve')

  const target = bm25.files[0]
  // A-2：query 里的「版本」出现在全部 21 条记忆里（df=N），按 df 闸门整条不参与
  // 打分，decoys 因此拿不到任何 lexical 分数、进不了候选池。旧实现会给每个
  // decoy 一个极小的正分，把全库一起拉进来——这正是要修的行为。
  const decoy = bm25.files.find((file) => file.name.startsWith('mem-decoy'))
  assert.equal(decoy, undefined, 'the corpus-wide term must no longer pull every decoy into the pool')
  assert.ok(target.lexical > 0, 'the rare term still scores the target')
})

test('the lexical corpus cache is invalidated by a write', async () => {
  const { exec } = fixture()
  await recall(exec, 'bm25')
  const written = await memory.privateRemember({
    exec, title: '新的灰度记录',
    content: '灰度发布新增了一条回滚检查，必须在变更窗口内完成。',
  })
  const after = await memory.privateRecall({ exec, query: '灰度', topK: 10, relevanceThreshold: 0 })
  assert.ok(after.files.some((file) => file.name === written.id), 'a write must invalidate the cached corpus')
})

test('BM25 improves MRR and Recall@5 across eight rare-term queries', async () => {
  const sessionId = 'bm25-multi'
  const cwd = path.join(home, 'ws-bm25-multi')
  state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const binding = state.getSessionBinding(sessionId)
  const index = state.loadPrivateIndex(binding.libraryId)
  const now = new Date().toISOString()
  const rares = ['灰度', '熔断', '幂等', '分片', '回填', '限流', '审计', '快照']
  const common = ['版本', '发布', '接口', '缓存', '部署', '回滚', '日志', '监控']
  for (let group = 0; group < 8; group += 1) {
    index.entries[`mem-target-${group}`] = {
      title: `发布说明 ${group}`,
      content: `本次${common[group]}更新包含${rares[group]}策略，${rares[group]}只允许在变更窗口内执行。`,
      status: 'active', layer: 'long_term', createdAt: now, updatedAt: now,
    }
    for (let i = 0; i < 20; i += 1) {
      index.entries[`mem-decoy-${group}-${i}`] = {
        title: `${common[group]}记录 ${group}-${i}`,
        content: `这是第 ${i} 次${common[group]}记录，只记录${common[group]}号和变更人，没有别的说明。`,
        status: 'active', layer: 'long_term', createdAt: now, updatedAt: now,
      }
    }
  }
  state.savePrivateIndex(binding.libraryId, index)
  const exec = { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding' } } } }

  async function measure(mode) {
    if (mode === 'includes') process.env.DSH_MEMU_RECALL_LEXICAL = 'includes'
    else delete process.env.DSH_MEMU_RECALL_LEXICAL
    let mrr = 0
    let recall = 0
    for (let group = 0; group < 8; group += 1) {
      const result = await memory.privateRecall({
        exec, query: `${common[group]} ${rares[group]}`, topK: 5, relevanceThreshold: 0,
      })
      const rank = result.files.findIndex((file) => file.name === `mem-target-${group}`) + 1
      if (rank > 0) {
        mrr += 1 / rank
        if (rank <= 5) recall += 1
      }
    }
    return { mrr: mrr / 8, recall5: recall }
  }

  const legacy = await measure('includes')
  const bm25 = await measure('bm25')
  delete process.env.DSH_MEMU_RECALL_LEXICAL
  assert.ok(bm25.mrr > legacy.mrr, `MRR must improve: ${legacy.mrr} -> ${bm25.mrr}`)
  assert.ok(bm25.recall5 > legacy.recall5, `Recall@5 must improve: ${legacy.recall5}/8 -> ${bm25.recall5}/8`)
  assert.equal(bm25.recall5, 8, 'every rare-term target must enter the top five')
})

test('the includes fallback remains byte-for-byte available', async () => {
  const { exec } = fixture()
  const result = await recall(exec, 'includes')
  assert.ok(result.files.length > 0)
  assert.ok(result.files.every((file) => Number.isFinite(file.lexical)))
  delete process.env.DSH_MEMU_RECALL_LEXICAL
})

test('tags and attachment captions still participate in the BM25 corpus', async () => {
  const sessionId = 'bm25-fields'
  const cwd = path.join(home, 'ws-bm25-fields')
  state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const binding = state.getSessionBinding(sessionId)
  const index = state.loadPrivateIndex(binding.libraryId)
  const now = new Date().toISOString()
  index.entries['mem-tagged'] = {
    title: '一条普通记录', content: '正文里没有检索词。', tags: ['灰度', '发布'],
    status: 'active', layer: 'long_term', createdAt: now, updatedAt: now,
  }
  index.entries['mem-captioned'] = {
    title: '另一条记录', content: '正文也很干净。',
    attachments: [{ sha256: 'a'.repeat(64), caption: '灰度截图' }],
    status: 'active', layer: 'long_term', createdAt: now, updatedAt: now,
  }
  state.savePrivateIndex(binding.libraryId, index)
  const exec = { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding' } } } }
  delete process.env.DSH_MEMU_RECALL_LEXICAL
  const tagged = await memory.privateRecall({ exec, query: '灰度', topK: 5, relevanceThreshold: 0 })
  const ids = tagged.files.map((file) => file.name)
  assert.ok(ids.includes('mem-tagged'), 'a query term in tags must still match')
  assert.ok(ids.includes('mem-captioned'), 'a query term in an attachment caption must still match')
})
