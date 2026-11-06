import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-injection-intent-budget-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const inject = await import('../lib/inject.js')
const { estTokens } = await import('../lib/budget.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

let seq = 0
function session(name) {
  seq += 1
  const cwd = path.join(home, 'ws', `${name}-${seq}`)
  const sessionId = `${name}-${seq}`
  state.ensureSession(sessionId, { cwd, agentPreset: 'rp' })
  return {
    sessionId,
    exec: { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'rp' } } } },
  }
}

test('a boundary question injects only_if_asked, never never_say, and stays inside turnTokens', async () => {
  const { exec, sessionId } = session('budget-boundary')
  const open = await memory.privateRemember({
    exec, title: '账本放在书房', content: '账本放在书房第二个抽屉。',
  })
  const ask = await memory.privateRemember({
    exec, title: '账本里有一笔旧账', content: '账本里记着一笔旧账。', disclosure: 'only_if_asked',
  })
  const never = await memory.privateRemember({
    exec, title: '账本的来历', content: '账本是他父亲留下的。', disclosure: 'never_say',
  })
  const binding = state.getSessionBinding(sessionId)
  const settings = { ...state.getSettings(), privateTopK: 5, relevanceThreshold: 0, turnTokens: 180 }

  const boundary = await inject.buildRecall(binding, '账本的秘密是什么', 1, settings, exec, sessionId)
  assert.deepEqual(boundary.errors, [])
  assert.ok(boundary.text.includes(`[${ask.id}]`), 'only_if_asked is released by a boundary question')
  assert.equal(boundary.text.includes(never.id), false, 'never_say stays out of automatic injection')
  assert.ok(boundary.text.includes(`[${open.id}]`))
  assert.ok(estTokens(boundary.text) <= settings.turnTokens, 'the block respects its own budget')

  const general = await inject.buildRecall(binding, '账本', 2, settings, exec, sessionId)
  assert.ok(general.text.includes(`[${open.id}]`))
  assert.equal(general.text.includes(ask.id), false, 'a general question does not release only_if_asked')
  assert.equal(general.text.includes(never.id), false)
  assert.ok(estTokens(general.text) <= settings.turnTokens)
})

test('a time question orders the injected timeline by absolute_date, newest first', async () => {
  const { exec, sessionId } = session('budget-date-order')
  const older = await memory.privateRemember({
    exec, title: '旅行的旧计划', content: '旅行原计划十一月一号出发。', absoluteDate: '2026-11-01',
  })
  const newer = await memory.privateRemember({
    exec, title: '旅行的新计划', content: '旅行改到十一月五号出发。', absoluteDate: '2026-11-05',
  })
  const binding = state.getSessionBinding(sessionId)
  const recall = await inject.buildRecall(binding, '旅行什么时候出发', 1, {
    ...state.getSettings(), privateTopK: 5, relevanceThreshold: 0, turnTokens: 400,
  }, exec, sessionId)
  assert.deepEqual(recall.errors, [])
  const olderAt = recall.text.indexOf(`[${older.id}]`)
  const newerAt = recall.text.indexOf(`[${newer.id}]`)
  assert.ok(olderAt >= 0 && newerAt >= 0, 'both plans are injected')
  assert.ok(newerAt < olderAt, 'the most recent absolute date comes first')
  assert.ok(estTokens(recall.text) <= 400)
})

test('a commitment question uses the commitment budget and keeps due commitments', async () => {
  const { exec, sessionId } = session('budget-commitment')
  const promised = await memory.privateRemember({
    exec, title: '答应查机票', content: '答应明天帮他查机票。',
    commitment: { counterparty: 'user', action: '查机票', due_at: '2026-11-07', status: 'open' },
  })
  const binding = state.getSessionBinding(sessionId)
  const recall = await inject.buildRecall(binding, '你答应过什么时候查机票', 1, {
    ...state.getSettings(), privateTopK: 3, relevanceThreshold: 0, turnTokens: 400,
  }, exec, sessionId)
  assert.deepEqual(recall.errors, [])
  assert.ok(recall.text.includes(`[${promised.id}]`))
  assert.ok(estTokens(recall.text) <= 400)
})
