import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-sidebar-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const { dispatch } = await import('../lib/rpc.js')

test.after(() => {
  try { state.flushState() } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

test('the sidebar first screen never lists conversations', async () => {
  const cwd = path.join(home, 'proj')
  const binding = state.ensureSession('sidebar-1', { cwd, agentPreset: 'coding' })
  state.updatePrivateIndex(binding.libraryId, (index) => {
    for (let i = 0; i < 40; i++) {
      index.entries[`mem-${i}`] = {
        id: `mem-${i}`, title: `记忆 ${i}`, content: 'x'.repeat(400),
        layer: 'long_term', status: 'active', updatedAt: '2026-10-02T00:00:00.000Z',
      }
    }
  })

  // Listing sessions reads every session and its title snapshots — the thing that
  // made opening the sidebar take seconds. It must not be called here at all.
  let called = false
  const ctx = {
    get: (name) => (name === 'sessionQuery'
      ? { listSessions: async () => { called = true; throw new Error('must not be called') } }
      : undefined),
  }

  const started = Date.now()
  const view = await dispatch(ctx, 'getSidebarState', { sessionId: 'sidebar-1' })
  const elapsed = Date.now() - started

  assert.equal(called, false, 'getSidebarState must not list conversations')
  assert.ok(elapsed < 500, `first screen took ${elapsed}ms`)
  assert.equal(view.private.active, 40)
  assert.equal(view.private.items.length, 40)
  // Previews are truncated: shipping full bodies is what made the panel heavy.
  assert.ok(view.private.items[0].preview.length <= 160)
  assert.equal(view.sessions, undefined)
  assert.equal(view.libraries, undefined)
})

test('a large library still returns a bounded first screen', async () => {
  const cwd = path.join(home, 'proj-big')
  const binding = state.ensureSession('sidebar-2', { cwd })
  state.updatePrivateIndex(binding.libraryId, (index) => {
    for (let i = 0; i < 500; i++) {
      index.entries[`big-${i}`] = {
        id: `big-${i}`, title: `big ${i}`, content: 'y'.repeat(300),
        layer: 'long_term', status: 'active', updatedAt: '2026-10-02T00:00:00.000Z',
      }
    }
  })
  const started = Date.now()
  const view = await dispatch({}, 'getSidebarState', { sessionId: 'sidebar-2', limit: 100 })
  const elapsed = Date.now() - started
  // 1500ms，不是 500ms：这条守的是「首屏不能退化成列会话 / 全量扫描」那种**秒级**形状
  // （原始投诉就是打开侧边栏要几秒），不是精细性能基线。同一份代码在本机空载单跑 378–448ms，
  // `npm test` 并行整包跑过 1286–1808ms——500 的预算测的是当时那台机器的空闲程度，
  // 会在别人的机器和更大的测试集上闪红。真正 O(n²) 的实现远超这里，仍然拦得住。
  assert.ok(elapsed < 1500, `500-entry library took ${elapsed}ms`)
  assert.equal(view.private.active, 500)
  assert.equal(view.private.items.length, 100, 'the payload is capped, the count is not')
})
