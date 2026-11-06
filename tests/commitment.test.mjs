import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-commitment-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const inject = await import('../lib/inject.js')
const commitment = await import('../lib/commitment.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

const NOW = new Date('2026-11-06T12:00:00+08:00')

let seq = 0
function session(name, sceneTime = '2026-11-06T04:00:00.000Z') {
  seq += 1
  const cwd = path.join(home, 'ws', `${name}-${seq}`)
  const sessionId = `${name}-${seq}`
  state.ensureSession(sessionId, { cwd, agentPreset: 'rp' })
  state.setSessionBinding(sessionId, { sceneTime })
  return {
    sessionId,
    exec: { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'rp' } } } },
  }
}

test('an explicit commitment is normalized and kept in sync with open_loop', async () => {
  const { exec } = session('commit-write')
  const result = await memory.privateRemember({
    exec, title: '答应帮林查机票', content: '我答应明天帮林查去冰岛的机票。',
    sourceKind: 'assistant_said',
    commitment: { counterparty: 'character:lin', action: '查去冰岛的机票', due_at: '2026-11-07', status: 'open' },
  })
  assert.equal(result.entry.openLoop, true)
  assert.deepEqual(result.entry.commitment, {
    counterparty: 'character:lin', action: '查去冰岛的机票', due_at: '2026-11-07',
    status: 'open', closed_by: null, evidence_seq: null,
  })

  const done = await memory.privateUpdate({
    exec, id: result.id,
    commitment: { ...result.entry.commitment, status: 'done', closed_by: 'turn:12', evidence_seq: 12 },
  })
  assert.equal(done.entry.openLoop, false)
  assert.equal(done.entry.commitment.status, 'done')
  assert.equal(done.entry.commitment.closed_by, 'turn:12')
})

test('open_loop=true derives a commitment; close it through either field', async () => {
  const { exec } = session('commit-legacy')
  const opened = await memory.privateRemember({
    exec, title: '答应回电话', content: '答应了昨天回电话。', openLoop: true,
    salientDate: '2026-11-05',
  })
  assert.equal(opened.entry.commitment.status, 'open')
  assert.equal(opened.entry.commitment.due_at, '2026-11-05')
  assert.equal(opened.entry.commitment.action, '答应回电话')

  const closed = await memory.privateUpdate({ exec, id: opened.id, openLoop: false })
  assert.equal(closed.entry.commitment.status, 'done', 'the legacy boolean closes the authoritative object')
  assert.equal(closed.entry.openLoop, false)
})

test('invalid commitments are refused before anything is written', async () => {
  const { exec } = session('commit-invalid')
  await assert.rejects(
    () => memory.privateRemember({ exec, title: '坏承诺', content: '测试。', commitment: { action: 'x', status: 'later' } }),
    /commitment\.status/,
  )
  await assert.rejects(
    () => memory.privateRemember({ exec, title: '坏日期', content: '测试。', commitment: { action: 'x', due_at: '2026-02-30' } }),
    /commitment\.due_at/,
  )
  await assert.rejects(
    () => memory.privateRemember({ exec, title: '没动作', content: '测试。', commitment: { due_at: '2026-11-07' } }),
    /commitment\.action/,
  )
})

test('dueCommitments returns overdue, today and tomorrow only, ordered by due date', async () => {
  const { exec, sessionId } = session('commit-due')
  const overdue = await memory.privateRemember({
    exec, title: '逾期的事', content: '欠着一件事。',
    commitment: { counterparty: 'user', action: '回电话', due_at: '2026-11-04', status: 'open' },
  })
  const today = await memory.privateRemember({
    exec, title: '今天到期', content: '今天要交周报。',
    commitment: { counterparty: 'user', action: '交周报', due_at: '2026-11-06', status: 'open' },
  })
  const tomorrow = await memory.privateRemember({
    exec, title: '明天到期', content: '明天要带伞。',
    commitment: { counterparty: 'user', action: '带伞', due_at: '2026-11-07', status: 'open' },
  })
  const distant = await memory.privateRemember({
    exec, title: '远期约定', content: '下个月再说。',
    commitment: { counterparty: 'user', action: '下月见面', due_at: '2026-12-20', status: 'open' },
  })
  const done = await memory.privateRemember({
    exec, title: '已经兑现', content: '已经做完了。',
    commitment: { counterparty: 'user', action: '已经做完', due_at: '2026-11-04', status: 'done' },
  })
  const binding = state.getSessionBinding(sessionId)
  const due = memory.dueCommitments({ libraryId: binding.libraryId, now: NOW.getTime(), sessionId, limit: 3 })
  assert.deepEqual(due.map((item) => item.id), [overdue.id, today.id, tomorrow.id])
  assert.deepEqual(due.map((item) => item.daysUntil), [-2, 0, 1])
  assert.ok(!due.some((item) => item.id === distant.id), 'a distant promise does not spend the per-turn budget')
  assert.ok(!due.some((item) => item.id === done.id), 'a done commitment is not a reminder')

  const nudge = inject.buildCommitmentNudge(binding, state.getSettings(), sessionId, { now: NOW })
  assert.match(nudge.text, /\[commitment\]/)
  assert.match(nudge.text, /已逾期 2 天/)
  assert.match(nudge.text, /今天到期/)
  assert.match(nudge.text, /明天到期/)
  assert.equal(nudge.ids.length, 3)
  assert.equal(nudge.text.includes(distant.id), false)
})

test('commitment.status outranks the legacy open_loop flag in dueOpenLoops', async () => {
  const { exec, sessionId } = session('commit-authority')
  const { id } = await memory.privateRemember({
    exec, title: '旧布尔值', content: '答应过的事。', openLoop: true, salientDate: '2026-11-01',
  })
  const binding = state.getSessionBinding(sessionId)
  state.updatePrivateIndex(binding.libraryId, (index) => {
    index.entries[id].openLoop = true
    index.entries[id].commitment = {
      counterparty: null, action: '答应过的事', due_at: '2026-11-01',
      status: 'done', closed_by: 'turn:9', evidence_seq: 9,
    }
  })
  const due = memory.dueOpenLoops({
    libraryId: binding.libraryId, now: NOW.getTime(), days: 1, limit: 5,
    includeOverdueDated: true, sessionId,
  })
  assert.equal(due.some((item) => item.id === id), false, 'a done commitment must not resurface as an overdue loop')
  assert.equal(commitment.isOpenThread(state.loadPrivateIndex(binding.libraryId).entries[id]), false)
})
