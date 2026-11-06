import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-chain-'))
process.env.DSH_MEMU_HOME = home

const { registerTools } = await import('../lib/tools.js')
const state = await import('../lib/state.js')
const inject = await import('../lib/inject.js')
const { dispatch } = await import('../lib/rpc.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function registeredTools() {
  const tools = new Map()
  registerTools({
    tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
    logger: { warn() {} },
  })
  return tools
}

function idsIn(text) {
  return [...String(text || '').matchAll(/mem-[a-z0-9]+-[a-z0-9]+/gi)].map((match) => match[0])
}

test('the real tool → recall → injection chain is reachable and carries S1–S6 fields', async () => {
  const tools = registeredTools()
  for (const name of ['memu_private_remember', 'memu_private_recall', 'memu_private_update', 'memu_status']) {
    assert.ok(tools.has(name), `missing tool ${name}`)
  }

  state.updateSettings({ randomCueChance: 0, habitsInjection: false, dedupeTurns: 0 })
  const cwd = path.join(home, 'project-chain')
  const sessionId = 'chain-session'
  state.ensureSession(sessionId, { cwd, agentPreset: 'rp' })
  state.setSessionBinding(sessionId, { sceneTime: '2026-11-06T04:00:00.000Z' })
  const exec = { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'rp' } } } }

  // 1. A user fact written through the actual model-facing tool.
  const userReply = await tools.get('memu_private_remember').execute({
    content: '明天下午三点在码头见面，别迟到。',
    title: '明天码头见面',
    source: 'user_said',
    speaker_id: 'user',
  }, exec)
  const [userFactId] = idsIn(userReply)
  assert.ok(userFactId, userReply)
  const userEntry = state.loadPrivateIndex(state.getSessionBinding(sessionId).libraryId).entries[userFactId]
  assert.equal(userEntry.absolute_date, '2026-11-07')
  assert.equal(userEntry.speaker_id, 'user')
  assert.equal(userEntry.source_kind, 'user_said')

  // 2. An assistant promise, written as assistant_said with a commitment.
  const promiseReply = await tools.get('memu_private_remember').execute({
    content: '我答应明天提前去码头占位置。',
    title: '答应提前去码头占位',
    source_kind: 'assistant_said',
    commitment: { counterparty: 'user', action: '提前去码头占位', due_at: '2026-11-07', status: 'open' },
  }, exec)
  const [promiseId] = idsIn(promiseReply)
  assert.ok(promiseId, promiseReply)
  const promiseEntry = state.loadPrivateIndex(state.getSessionBinding(sessionId).libraryId).entries[promiseId]
  assert.equal(promiseEntry.source_kind, 'assistant_said')
  assert.equal(promiseEntry.speaker_id, 'assistant')
  assert.equal(promiseEntry.commitment.status, 'open')
  assert.equal(promiseEntry.openLoop, true)

  // 3. Two conflicting versions of one fact, then a conflict card in the real recall.
  const floorA = idsIn(await tools.get('memu_private_remember').execute({
    content: '客厅地板是木色的。', title: '客厅地板木色', fact_key: 'home:living_floor_color',
  }, exec))[0]
  const floorB = idsIn(await tools.get('memu_private_remember').execute({
    content: '客厅地板不是木色，是灰色瓷砖。', title: '客厅地板灰色', fact_key: 'home:living_floor_color',
  }, exec))[0]
  assert.ok(floorA && floorB)

  // 4. The explicit recall tool sees both the dated fact and the conflict pair.
  const recallReply = await tools.get('memu_private_recall').execute({ query: '明天码头', topK: 10 }, exec)
  assert.ok(recallReply.includes(userFactId), recallReply)
  assert.ok(recallReply.includes(promiseId))
  const floorReply = await tools.get('memu_private_recall').execute({ query: '客厅地板颜色', topK: 10 }, exec)
  assert.ok(floorReply.includes(floorA) && floorReply.includes(floorB), floorReply)

  // 5. The real pre-step injection path emits one plugin message carrying the fields
  //    the model needs to answer: resolved date, speaker and the conflict card.
  const agent = { session: { header: { id: sessionId, cwd, agentPreset: 'rp', origin: 'user' } } }
  const dateUser = {
    id: 'chain-u1', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: '明天下午我们在码头几点见面？' }],
  }
  const dated = await inject.injectForStep({
    agent,
    decision: { kind: 'enter', messages: [dateUser] },
    turn: 1,
    step: 1,
    signal: { aborted: false },
  })
  const datedText = dated.messages
    .filter((message) => message?.source?.kind === 'plugin:dsh-memu-memory')
    .map((message) => String(message?.content?.[0]?.text || ''))
    .join('\n')
  assert.ok(datedText.includes(userFactId), datedText)
  assert.match(datedText, /date=2026-11-07/, 'the resolved absolute date reaches the prompt')
  assert.match(datedText, /source=assistant_said/)
  assert.match(datedText, /speaker=assistant/)
  // The user message is untouched and the plugin message comes before it.
  assert.equal(dated.messages.at(-1).source.kind, 'user')
  assert.equal(dated.messages.at(-1).content[0].text, dateUser.content[0].text)

  const floorUser = {
    id: 'chain-u2', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: '客厅地板到底是什么颜色，前后说法不一样。' }],
  }
  const conflicted = await inject.injectForStep({
    agent,
    decision: { kind: 'enter', messages: [floorUser] },
    turn: 2,
    step: 1,
    signal: { aborted: false },
  })
  const conflictText = conflicted.messages
    .filter((message) => message?.source?.kind === 'plugin:dsh-memu-memory')
    .map((message) => String(message?.content?.[0]?.text || ''))
    .join('\n')
  assert.match(conflictText, /冲突 · home:living_floor_color/, conflictText)
  assert.ok(conflictText.includes(floorA) && conflictText.includes(floorB))

  // 6. Observability: getState exposes the recall cache counters, including staleSkipped.
  const view = await dispatch({}, 'getState', { sessionId })
  assert.equal(typeof view.recallCache, 'object')
  for (const key of ['hits', 'misses', 'evictions', 'errors', 'staleSkipped']) {
    assert.equal(typeof view.recallCache[key], 'number', key)
  }
})
