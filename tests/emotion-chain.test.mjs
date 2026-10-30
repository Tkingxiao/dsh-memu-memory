// 情绪模型的跨模块链路：这三条不在 mood.js 的单元测试范围里，但任何一条断了都
// 会让情绪「写进去、存得住、展示不出」或者「整理时把当前心情当成事件情绪」。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-emotion-chain-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const rpc = await import('../lib/rpc.js')
const remote = await import('../lib/remote-summary.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function setup(name) {
  const cwd = path.join(home, 'proj-' + name)
  const sessionId = 'chain-' + name
  state.ensureSession(sessionId, { cwd, agentPreset: 'rp' })
  return { cwd, sessionId, exec: { agent: { session: { header: { id: sessionId, cwd, agentPreset: 'rp' } } } } }
}

test('the rpc projection carries the composition, the control axis and the source', async () => {
  const { exec } = setup('projection')
  const saved = await memory.privateRemember({
    exec,
    content: '他把伞朝我这边偏了偏。',
    title: '伞',
    emotion: { joy: 0.2, anger: 0, sorrow: 0.6, fear: 0.2 },
    dominance: 0.55,
    arousal: 0.72,
  })
  const binding = state.getSessionBinding(exec.agent.session.header.id)
  // The wall and the drawer read through these two endpoints; a field missing here is
  // a field the user can never see, even though it is stored correctly.
  const listed = await rpc.dispatch(null, 'browseLibrary', { libraryId: binding.libraryId })
  const file = (listed.files || []).find(item => item.id === saved.id)
  assert.ok(file, 'the written entry must appear in the library listing')
  assert.equal(Math.round(file.emotion.sorrow * 100) / 100, 0.6)
  assert.equal(file.dominance, 0.55)
  assert.equal(file.emotionSource, 'model')

  const detail = await rpc.dispatch(null, 'getMemory', { libraryId: binding.libraryId, id: saved.id })
  assert.equal(Math.round(detail.entry.emotion.fear * 100) / 100, 0.2)
})

test('remote output keeps a valid composition, rejects a broken one, and invents nothing', () => {
  const problems = []
  const cleaned = remote.cleanMemories([
    { title: 'ok', content: 'a', emotion: { joy: 0, anger: 1, sorrow: 0, fear: 0 }, dominance: -0.2, arousal: 0.8 },
    { title: 'broken', content: 'b', emotion: { joy: 1, anger: -1, sorrow: 0, fear: 0 } },
    { title: 'silent', content: 'c' },
  ], problems)
  const good = cleaned.find(item => item.title === 'ok')
  assert.ok(good && good.emotion)
  assert.equal(good.emotion.anger, 1)
  assert.equal(good.dominance, -0.2)
  // A remote model that returns an illegal share must be refused loudly: silently
  // clamping it would put a fabricated composition into the library forever.
  assert.equal(cleaned.some(item => item.title === 'broken'), false, 'an illegal composition is dropped, not repaired')
  assert.ok(problems.some(problem => /emotion/.test(problem.error || '')), 'the rejection must be diagnosable')
  // Omitted is not neutral: the entry keeps no composition rather than a made-up one.
  const silent = cleaned.find(item => item.title === 'silent')
  assert.ok(silent)
  assert.equal(silent.emotion, null)
})

test('the consolidation fork does not inherit the parent conversation mood', () => {
  // Shape guard: the child binding is built inside requestPrivateConsolidation, which
  // needs a live host agent to run. The one thing that must not silently disappear is
  // the explicit `mood: null` — without it the fork inherits nothing and every entry it
  // writes falls back to neutral, which is the exact bug this guard exists for.
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'private.js'), 'utf8')
  const start = source.indexOf('setSessionBinding(childId')
  assert.ok(start > 0, 'the child binding block moved; update this guard')
  const block = source.slice(start, start + 1200)
  assert.match(block, /mood:\s*null/, 'the fork must declare "no present mood" instead of inheriting the parent one')
})
