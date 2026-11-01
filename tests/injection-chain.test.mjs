import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-chain-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const inject = await import('../lib/inject.js')
const budget = await import('../lib/budget.js')

test.after(() => {
  try { state.flushState() } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

const local = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0)

// ---------------------------------------------------------------- A: no library
// The anniversary block used to throw on a binding without a library, and because
// it sits inside the pre-step it took ordinary recall down with it: the session
// recorded "injection failed: invalid library id" and remembered nothing.

test('an anniversary block on a binding with no library is empty, not fatal', () => {
  assert.doesNotThrow(() => inject.buildAnniversary('chain-none', { useLibrary: true, libraryId: null }))
  const empty = inject.buildAnniversary('chain-none', { useLibrary: true, libraryId: null })
  assert.equal(empty.text, '')
  assert.deepEqual(empty.ids, [])
  assert.equal(inject.buildAnniversary('chain-none', null).text, '')
})

test('a step with no library still injects and records no recall error', async () => {
  const cwd = path.join(home, 'project-no-library')
  const binding = state.ensureSession('chain-no-lib', { cwd, agentPreset: 'coding', createLibrary: false })
  assert.equal(binding.libraryId, null, 'createLibrary:false must not leave a library behind')

  const user = {
    id: 'u1',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'What is the plan for today?' }],
  }
  const decision = { kind: 'enter', messages: [user] }
  const agent = { session: { header: { id: 'chain-no-lib', cwd, agentPreset: 'coding', origin: 'user' } } }
  const out = await inject.injectForStep({ agent, decision, turn: 1, step: 1, signal: { aborted: false } })
  assert.ok(Array.isArray(out.messages))
  assert.equal(state.getSessionBinding('chain-no-lib').lastRecallError, undefined,
    'a missing library is not a recall failure')
})

// ------------------------------------------------------- B: folder library reuse
// A folder that already owns a library must hand it to every new conversation.
// Only creating one needs `createLibrary`; re-using one never did.

test('a new conversation adopts the library its folder already has', () => {
  const cwd = path.join(home, 'project-adopt')
  const first = state.ensureSession('chain-first', { cwd, agentPreset: 'coding' })
  assert.ok(first.libraryId, 'the first conversation creates the folder library')
  const count = Object.keys(state.loadState().libraries).length

  const second = state.ensureSession('chain-second', { cwd, agentPreset: 'coding', createLibrary: false })
  assert.equal(second.libraryId, first.libraryId, 'createLibrary:false still reads the folder library')
  assert.equal(Object.keys(state.loadState().libraries).length, count, 'adoption must not create a second library')
})

test('adoption is scoped to the folder, not to the caller', () => {
  const withLibrary = path.join(home, 'project-scoped-a')
  const withoutLibrary = path.join(home, 'project-scoped-b')
  const owned = state.ensureSession('chain-scoped-a', { cwd: withLibrary })
  const empty = state.ensureSession('chain-scoped-b', { cwd: withoutLibrary, createLibrary: false })
  assert.equal(empty.libraryId, null, 'a folder with no library stays unbound')
  assert.notEqual(empty.libraryId, owned.libraryId)
})

test('an archived library is not silently revived by a new conversation', () => {
  const cwd = path.join(home, 'project-archived')
  const owned = state.ensureSession('chain-archived-a', { cwd })
  state.archiveLibrary(owned.libraryId)
  const later = state.ensureSession('chain-archived-b', { cwd, createLibrary: false })
  assert.equal(later.libraryId, null, 'reviving a library is a deliberate act, not a side effect')
})

// --------------------------------------------- C: 明天 is one day, not every year
// The extractor resolved 明天 to 10-29 and handed back MM-DD, so the appointment
// became an anniversary that resurfaced every 29 October.

test('a relative day with a matching month-day becomes one specific date', () => {
  assert.equal(memory.reconcileSalientDate('10-29', '明天要去考驾照', local(2026, 10, 28)), '2026-10-29')
  assert.equal(memory.reconcileSalientDate('11-01', '后天加班', local(2026, 10, 30)), '2026-11-01')
  assert.equal(memory.reconcileSalientDate('10-30', 'today the exam happens', local(2026, 10, 30)), '2026-10-30')
  assert.equal(memory.reconcileSalientDate('01-01', 'tomorrow is the new year', local(2026, 12, 31)), '2027-01-01')
})

test('an explicit date in the text settles the year without guessing', () => {
  assert.equal(memory.reconcileSalientDate('10-29', '明天（2026-10-29）要去考驾照', local(2020, 1, 1)), '2026-10-29')
})

test('a real anniversary is left alone', () => {
  assert.equal(memory.reconcileSalientDate('10-28', '我的生日是10月28日', local(2026, 10, 29)), '10-28')
  assert.equal(memory.reconcileSalientDate('10-28', '他的生日', local(2026, 10, 29)), '10-28')
  // A relative word whose month-day does not match it came from somewhere else.
  assert.equal(memory.reconcileSalientDate('10-28', '明天要去考驾照', local(2026, 10, 29)), '10-28')
  assert.equal(memory.reconcileSalientDate('2026-10-29', '明天要去考驾照', local(2026, 10, 28)), '2026-10-29')
  assert.equal(memory.reconcileSalientDate(null, '明天要去考驾照', local(2026, 10, 28)), null)
})

test('the write path stores the dated form, so injection announces a due date', async () => {
  const cwd = path.join(home, 'project-write')
  const binding = state.ensureSession('chain-write', { cwd, agentPreset: 'coding' })
  const result = await memory.privateRemember({
    exec: { agent: { session: { header: { id: 'chain-write', cwd } } } },
    libraryId: binding.libraryId,
    title: '考驾照',
    content: '明天（2099-10-29）要去考驾照',
    layer: 'long_term',
    source: 'user_said',
    salientDate: '10-29',
  })
  const index = state.loadPrivateIndex(binding.libraryId)
  const entries = Object.values(index.entries)
  const entry = result?.id ? index.entries[result.id] : entries[entries.length - 1]
  assert.ok(entry, 'the memory was written')
  assert.equal(entry.salientDate, '2099-10-29', 'a resolved appointment is dated, not annual')
  assert.equal(memory.isDatedSalientDate(entry.salientDate), true)
  assert.equal(memory.salientDateFires(entry.salientDate, local(2099, 10, 28)), true)
  assert.equal(memory.salientDateFires(entry.salientDate, local(2100, 10, 29)), false, 'and it does not recur')
})

// ------------------------------------------------- C on the other write paths
// The write side settles a relative day, but three other paths can file a date:
// re-dating an existing entry, importing entries (consolidation included), and the
// consolidation prompts themselves never describing the field at all.

test('re-dating an entry settles the year the same way a fresh write does', async () => {
  const cwd = path.join(home, 'project-update')
  const binding = state.ensureSession('chain-update', { cwd, agentPreset: 'coding' })
  const exec = { agent: { session: { header: { id: 'chain-update', cwd } } } }
  const written = await memory.privateRemember({
    exec,
    libraryId: binding.libraryId,
    title: '考驾照',
    content: '明天（2098-10-29）要去考驾照',
    layer: 'long_term',
    source: 'user_said',
  })
  const redated = await memory.privateUpdate({ exec, libraryId: binding.libraryId, id: written.id, salientDate: '10-29' })
  assert.equal(redated.entry.salientDate, '2098-10-29', 'a repair must not re-file the year-less form')

  const birthday = await memory.privateRemember({
    exec,
    libraryId: binding.libraryId,
    title: '生日',
    content: '她的生日是10月28日',
    layer: 'long_term',
    source: 'user_said',
  })
  const kept = await memory.privateUpdate({ exec, libraryId: binding.libraryId, id: birthday.id, salientDate: '10-28' })
  assert.equal(kept.entry.salientDate, '10-28', 'a real anniversary keeps its annual form when re-dated')
})

test('an imported entry is settled on the way in', async () => {
  const cwd = path.join(home, 'project-import')
  const binding = state.ensureSession('chain-import', { cwd, agentPreset: 'coding' })
  await memory.importMemories({
    libraryId: binding.libraryId,
    memories: [{ title: '考驾照', content: '明天（2098-10-29）要去考驾照', salientDate: '10-29', layer: 'long_term' }],
  })
  const entries = Object.values(state.loadPrivateIndex(binding.libraryId).entries)
  const entry = entries.find((e) => (e.title || '').includes('考驾照'))
  assert.ok(entry, 'the imported memory exists')
  assert.equal(entry.salientDate, '2098-10-29', 'import must not carry an unsettled MM-DD in')
})

test('every consolidation prompt tells the model how to write the field', () => {
  const dir = fileURLToPath(new URL('../lib/prompts/', import.meta.url))
  for (const name of ['private-consolidation.md', 'private-consolidation.rp.md', 'private-consolidation.coding.md', 'private-consolidation.mixed.md']) {
    const body = fs.readFileSync(path.join(dir, name), 'utf8')
    assert.ok(body.includes('salient_date'), name + ' must describe salient_date')
    assert.ok(body.includes('MM-DD') && body.includes('YYYY-MM-DD'), name + ' must state both forms')
    assert.ok(/明天/.test(body), name + ' must say a relative day has to be resolved')
  }
})

test('the remember tool tells the model to resolve a relative day', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../lib/tools.js', import.meta.url)), 'utf8')
  assert.ok(source.includes('A relative day'), 'the tool description must mention relative days')
  assert.ok(source.includes('turns one appointment into a yearly reminder'), 'and why it matters')
})

// ------------------------------------- D: freshness hint is conditional and bounded
// The hint is a footnote to a recall that already succeeded: it must appear once,
// after every closed <memory-context> block, and must never turn a normal turn into
// a hint-only or failed turn.

const DAY_MS = 86_400_000

function seedRecallEntry(binding, id, patch = {}) {
  const now = new Date().toISOString()
  const index = state.loadPrivateIndex(binding.libraryId)
  index.entries[id] = {
    track: 'memory',
    layer: 'long_term',
    title: '部署脚本的位置',
    content: '部署脚本放在 tools/deploy.ps1，先跑 staging smoke。',
    status: 'active',
    confidence: 0.9,
    createdAt: now,
    updatedAt: now,
    ...patch,
  }
  state.savePrivateIndex(binding.libraryId, index)
}

async function recallFor(sessionId, binding, query, patch = {}) {
  const exec = { agent: { session: { header: { id: sessionId, agentPreset: 'coding' } } } }
  return inject.buildRecall(binding, query, 1, {
    ...state.getSettings(),
    relevanceThreshold: 0,
    ...patch,
  }, exec, sessionId)
}

test('a stale recalled memory appends exactly one freshness hint after the closed blocks', async () => {
  const cwd = path.join(home, 'project-freshness-stale')
  const binding = state.ensureSession('chain-freshness-stale', { cwd, agentPreset: 'coding' })
  const old = new Date(Date.now() - 45 * DAY_MS).toISOString()
  seedRecallEntry(binding, 'mem-fresh-deploy', { updatedAt: old })
  seedRecallEntry(binding, 'mem-fresh-release', {
    title: '发布流程的审批',
    content: '发布流程需要提前一天审批。',
    updatedAt: old,
  })

  const recall = await recallFor('chain-freshness-stale', binding, '部署脚本和发布流程')
  assert.deepEqual(recall.errors, [])
  assert.ok(recall.ids.includes('mem-fresh-deploy'))
  assert.ok(recall.ids.includes('mem-fresh-release'))
  assert.equal((recall.text.match(/<memory-freshness>/g) || []).length, 1, 'the hint appears exactly once')
  assert.ok(recall.text.includes('上面有 2 条记忆带时间敏感信号'), 'N counts the unique stale entries')
  assert.ok(recall.text.indexOf('<memory-freshness>') > recall.text.lastIndexOf('</memory-context>'),
    'the hint follows the last closed context block')
  assert.equal((recall.text.match(/<memory-context\b/g) || []).length, 1, 'recall still has one context block')
  assert.equal((recall.text.match(/<\/memory-context>/g) || []).length, 1)
  assert.ok(recall.text.endsWith('</memory-freshness>'))

  // The age leg obeys freshnessDays: 45-day-old entries are fresh at 100 days.
  const lenient = await recallFor('chain-freshness-stale', binding, '部署脚本和发布流程', { freshnessDays: 100 })
  assert.ok(lenient.text.includes('</memory-context>'))
  assert.equal(lenient.text.includes('<memory-freshness>'), false)
})

test('a fresh recalled memory adds no freshness hint', async () => {
  const cwd = path.join(home, 'project-freshness-fresh')
  const binding = state.ensureSession('chain-freshness-fresh', { cwd, agentPreset: 'coding' })
  seedRecallEntry(binding, 'mem-fresh-now')

  const recall = await recallFor('chain-freshness-fresh', binding, '部署脚本放在哪里')
  assert.ok(recall.ids.includes('mem-fresh-now'))
  assert.ok(recall.text.includes('</memory-context>'))
  assert.equal(recall.text.includes('<memory-freshness>'), false)
})

test('the hint ships in the same plugin message as the recall block', async () => {
  state.updateSettings({ randomCueChance: 0 })
  const cwd = path.join(home, 'project-freshness-message')
  const binding = state.ensureSession('chain-freshness-message', { cwd, agentPreset: 'coding' })
  seedRecallEntry(binding, 'mem-fresh-message', { updatedAt: new Date(Date.now() - 45 * DAY_MS).toISOString() })

  const user = {
    id: 'u-freshness', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: '部署脚本放在哪里' }],
  }
  const agent = { session: { header: { id: 'chain-freshness-message', cwd, agentPreset: 'coding', origin: 'user' } } }
  const out = await inject.injectForStep({ agent, decision: { kind: 'enter', messages: [user] }, turn: 1, step: 1, signal: { aborted: false } })

  assert.equal(out.messages.length, 2)
  assert.equal(out.messages[0].source.kind, 'plugin:dsh-memu-memory')
  const text = out.messages[0].content[0].text
  assert.ok(text.includes('[mem-fresh-message]'))
  assert.equal((text.match(/<memory-freshness>/g) || []).length, 1)
  assert.ok(text.indexOf('<memory-freshness>') > text.lastIndexOf('</memory-context>'))
  assert.equal(state.getSessionBinding('chain-freshness-message').lastRecallError, undefined)
})

test('anchor-only and autoInject off never append the freshness hint', async () => {
  const cwd = path.join(home, 'project-freshness-modes')
  const binding = state.ensureSession('chain-freshness-modes', { cwd, agentPreset: 'coding' })
  seedRecallEntry(binding, 'mem-fresh-modes', { updatedAt: new Date(Date.now() - 90 * DAY_MS).toISOString() })

  const anchorOnly = await recallFor('chain-freshness-modes', binding, '部署脚本放在哪里', { autoInject: 'anchor-only' })
  assert.ok(anchorOnly.text.includes('</memory-context>'))
  assert.equal(anchorOnly.text.includes('<memory-freshness>'), false)

  // buildRecall itself is not the off switch; the caller is. The hint still must
  // not appear if a future caller forgets that.
  const off = await recallFor('chain-freshness-modes', binding, '部署脚本放在哪里', { autoInject: 'off' })
  assert.ok(off.text.includes('</memory-context>'))
  assert.equal(off.text.includes('<memory-freshness>'), false)
})

test('a query shorter than minUserChars gets the recall but no freshness hint', async () => {
  const cwd = path.join(home, 'project-freshness-short')
  const binding = state.ensureSession('chain-freshness-short', { cwd, agentPreset: 'coding' })
  seedRecallEntry(binding, 'mem-fresh-short', {
    title: '最新的部署方式',
    content: '最新的部署方式放在 tools/deploy.ps1。',
  })

  const recall = await recallFor('chain-freshness-short', binding, '最新')
  assert.ok(recall.ids.includes('mem-fresh-short'))
  assert.ok(recall.text.includes('</memory-context>'))
  assert.equal(recall.text.includes('<memory-freshness>'), false)
})

test('freshnessHint false suppresses the freshness hint', async () => {
  const cwd = path.join(home, 'project-freshness-switch')
  const binding = state.ensureSession('chain-freshness-switch', { cwd, agentPreset: 'coding' })
  seedRecallEntry(binding, 'mem-fresh-switch', { updatedAt: new Date(Date.now() - 45 * DAY_MS).toISOString() })

  const recall = await recallFor('chain-freshness-switch', binding, '部署脚本放在哪里', { freshnessHint: false })
  assert.ok(recall.ids.includes('mem-fresh-switch'))
  assert.ok(recall.text.includes('</memory-context>'))
  assert.equal(recall.text.includes('<memory-freshness>'), false)
})

test('the hint is dropped when turnTokens cannot fit it, and the recall still succeeds', async () => {
  const cwd = path.join(home, 'project-freshness-budget')
  const binding = state.ensureSession('chain-freshness-budget', { cwd, agentPreset: 'coding' })
  seedRecallEntry(binding, 'mem-fresh-budget', { updatedAt: new Date(Date.now() - 45 * DAY_MS).toISOString() })

  const full = await recallFor('chain-freshness-budget', binding, '部署脚本放在哪里', { turnTokens: 800 })
  const marker = '\n\n<memory-freshness>'
  const at = full.text.indexOf(marker)
  assert.ok(at > 0, 'with room the hint appears')
  const hint = full.text.slice(at)
  const base = full.text.slice(0, at)
  const needed = budget.estTokens(base)
  assert.ok(budget.estTokens(base + hint) > needed, 'the hint itself costs something')

  // The smallest budget that still fits the card cannot also fit the footnote.
  let squeezed = null
  for (let extra = 0; extra <= 12 && !squeezed; extra += 1) {
    const turnTokens = needed + extra
    const attempt = await recallFor('chain-freshness-budget', binding, '部署脚本放在哪里', { turnTokens })
    if (attempt.text) squeezed = { attempt, turnTokens }
  }
  assert.ok(squeezed, 'a budget near the base size still fits one card')
  assert.ok(squeezed.attempt.text.includes('[mem-fresh-budget]'))
  assert.ok(squeezed.attempt.text.includes('</memory-context>'))
  assert.equal(squeezed.attempt.text.includes('<memory-freshness>'), false)
  assert.ok(budget.estTokens(squeezed.attempt.text) <= squeezed.turnTokens)
})

test('no recall means no freshness hint', async () => {
  const cwd = path.join(home, 'project-freshness-none')
  const binding = state.ensureSession('chain-freshness-none', { cwd, agentPreset: 'coding' })
  seedRecallEntry(binding, 'mem-fresh-none', { updatedAt: new Date(Date.now() - 45 * DAY_MS).toISOString() })

  const recall = await recallFor('chain-freshness-none', binding, 'zzz-unrelated-token-zzz')
  assert.equal(recall.text, '')
  assert.deepEqual(recall.ids, [])
  assert.equal(recall.text.includes('<memory-freshness>'), false)
})
