import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 逾期与过时的收尾：过期草稿的保留期归档、逾期承诺的周期提示，
// 以及整理任务书里的欠账清单。三者都只做"标出来"，不替人裁决事实。

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-stale-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const cycle = await import('../lib/cycle.js')
const activity = await import('../lib/activity-log.js')
const privateMod = await import('../lib/private.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function dayKey(offsetDays) {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

function bindingFor(sessionId, folder) {
  return state.ensureSession(sessionId, { cwd: path.join(home, folder), agentPreset: 'coding' })
}

function putEntry(binding, id, patch = {}) {
  const index = state.loadPrivateIndex(binding.libraryId)
  index.entries[id] = {
    track: 'memory',
    layer: 'long_term',
    title: id,
    content: 'body of ' + id,
    status: 'active',
    createdAt: isoDaysAgo(20),
    updatedAt: isoDaysAgo(20),
    ...patch,
  }
  state.savePrivateIndex(binding.libraryId, index)
}

function entryOf(binding, id) {
  return state.loadPrivateIndex(binding.libraryId).entries[id]
}

test('expired drafts are archived after the retention window, never deleted', () => {
  const binding = bindingFor('stale-archive', 'proj-archive')
  putEntry(binding, 'draft-old', { layer: 'short_term', status: 'expired', expiredAt: isoDaysAgo(40), expiresAt: isoDaysAgo(40) })
  putEntry(binding, 'draft-legacy', { layer: 'short_term', status: 'expired', expiresAt: isoDaysAgo(45) })
  putEntry(binding, 'draft-fresh', { layer: 'short_term', status: 'expired', expiredAt: isoDaysAgo(5), expiresAt: isoDaysAgo(5) })
  putEntry(binding, 'still-active', { layer: 'short_term', expiresAt: isoDaysAgo(1) })

  const sweep = memory.archiveExpiredDrafts()
  const archived = new Set(sweep.archived.map((row) => row.id))
  assert.ok(archived.has('draft-old'), 'past the retention window → archived')
  assert.ok(archived.has('draft-legacy'), 'legacy expired rows fall back to expiresAt')
  assert.equal(archived.has('draft-fresh'), false, 'inside the retention window → left for promotion')
  assert.equal(archived.has('still-active'), false, 'a live draft is not touched')

  const old = entryOf(binding, 'draft-old')
  assert.equal(old.status, 'archived')
  assert.ok(old.archivedAt)
  assert.ok(old.content.includes('body of draft-old'), 'archiving keeps the text')
  assert.equal(entryOf(binding, 'draft-fresh').status, 'expired', 'status is unchanged while inside the window')
})

test('overdueOpenCommitments only returns open commitments past due by the threshold', () => {
  const binding = bindingFor('stale-overdue', 'proj-overdue')
  putEntry(binding, 'owes-10d', { commitment: { action: '陪复习', counterparty: '主人', due_at: dayKey(-10), status: 'open' } })
  putEntry(binding, 'owes-2d', { commitment: { action: '买猫粮', due_at: dayKey(-2), status: 'open' } })
  putEntry(binding, 'due-tomorrow', { commitment: { action: '交周报', due_at: dayKey(1), status: 'open' } })
  putEntry(binding, 'already-done', { commitment: { action: '回消息', due_at: dayKey(-9), status: 'done' } })
  putEntry(binding, 'marginal', { marginalized: true, commitment: { action: '旧账', due_at: dayKey(-9), status: 'open' } })

  const rows = memory.overdueOpenCommitments({ libraryId: binding.libraryId, minOverdueDays: 7 })
  const ids = rows.map((row) => row.id)
  assert.deepEqual(ids, ['owes-10d'])
  assert.equal(rows[0].daysOverdue, 10)

  const loose = memory.overdueOpenCommitments({ libraryId: binding.libraryId, minOverdueDays: 0 }).map((row) => row.id)
  assert.ok(loose.includes('owes-2d'), 'minOverdueDays=0 lists every overdue promise')
  assert.equal(loose.includes('due-tomorrow'), false)
  assert.equal(loose.includes('already-done'), false)
  assert.equal(loose.includes('marginal'), false)
})

test('the cycle notes overdue promises once per week and never closes them itself', () => {
  const binding = bindingFor('stale-pass', 'proj-pass')
  putEntry(binding, 'promise-1', { title: '陪主人复习', commitment: { action: '陪复习', counterparty: '主人', due_at: dayKey(-12), status: 'open' } })
  putEntry(binding, 'promise-2', { title: '寄相册', commitment: { action: '寄相册', due_at: dayKey(-8), status: 'open' } })

  const first = cycle.runOverdueReviewPass(null, { now: Date.now() })
  assert.ok(first.noted >= 2, 'both promises are past the threshold')
  const entry = activity.listEvents({ kind: 'check', limit: 50 }).find((row) => String(row.message).includes('欠账待结案'))
  assert.ok(entry, 'a check entry is written to the activity log')
  assert.ok(entry.detail.ids.includes('promise-1'))

  const second = cycle.runOverdueReviewPass(null, { now: Date.now() })
  assert.equal(second.noted, 0, 'the same week must not repeat the note')

  const later = cycle.runOverdueReviewPass(null, { now: Date.now() + 8 * 86_400_000 })
  assert.ok(later.noted >= 2, 'after the repeat window it comes back')

  assert.equal(entryOf(binding, 'promise-1').commitment.status, 'open', 'status is evidence-driven, never auto-closed')
})

test('the consolidation catalog lists overdue promises so the worker can close them with evidence', () => {
  const binding = bindingFor('stale-catalog', 'proj-catalog')
  putEntry(binding, 'catalog-owe', {
    title: '答应陪主人复习',
    commitment: { action: '陪复习', counterparty: '主人', due_at: dayKey(-5), status: 'open' },
  })
  const event = privateMod.memoryCatalogEvent({ ...binding, sessionId: 'stale-catalog' })
  assert.ok(event, 'the catalog event is produced')
  const text = String(event.data?.content?.[0]?.text || '')
  assert.ok(text.includes('欠账'), 'the catalog carries an overdue section')
  assert.ok(text.includes('[catalog-owe]'))
  assert.ok(text.includes('已逾期 5 天'))
  assert.ok(text.includes('对 主人：陪复习'))
  assert.ok(text.includes('done'), 'the instruction names the closing statuses')
})