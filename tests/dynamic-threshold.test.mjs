import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-percentile-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')

test.after(() => {
  delete process.env.DSH_MEMU_RECALL_PERCENTILE
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function fixture() {
  const sessionId = 'percentile'
  const cwd = path.join(home, 'ws-percentile')
  state.ensureSession(sessionId, { cwd, agentPreset: 'coding' })
  const binding = state.getSessionBinding(sessionId)
  const index = state.loadPrivateIndex(binding.libraryId)
  const now = new Date().toISOString()
  const topics = ['预算', '排期', '招聘', '客户投诉', '机房迁移', '季度目标', '培训', '安全审计', '值班表', '产品路线']
  for (const [i, topic] of topics.entries()) {
    index.entries[`mem-p${i}`] = {
      title: `会议记录 ${i}`,
      content: `会议主要讨论${topic}，结论是下周继续跟进，负责人单独确认。`,
      status: 'active', layer: 'long_term', createdAt: now, updatedAt: now,
    }
  }
  state.savePrivateIndex(binding.libraryId, index)
  return { exec: { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'coding' } } } } }
}

test('percentile cut is off by default and never pads a minimum result count', async () => {
  const { exec } = fixture()
  delete process.env.DSH_MEMU_RECALL_PERCENTILE
  const normal = await memory.privateRecall({ exec, query: '会议', topK: 10, relevanceThreshold: 0 })
  assert.equal(normal.files.length, 10, 'default keeps the requested topK')

  process.env.DSH_MEMU_RECALL_PERCENTILE = '1'
  const narrowed = await memory.privateRecall({ exec, query: '会议', topK: 10, relevanceThreshold: 0 })
  assert.ok(narrowed.files.length > 0 && narrowed.files.length < normal.files.length, 'percentile must narrow, not pad')
  assert.equal(narrowed.files.length, Math.ceil(normal.files.length * 0.25))
  assert.equal(narrowed.files[0].name, normal.files[0].name, 'the best hit is preserved')
  delete process.env.DSH_MEMU_RECALL_PERCENTILE

  const none = await memory.privateRecall({ exec, query: 'qqqqzzzz', topK: 10, relevanceThreshold: 0 })
  assert.equal(none.files.length, 0, 'a no-match stays empty')
})
