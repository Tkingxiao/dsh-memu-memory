import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-gc-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')

test.after(() => {
  state.flushState()
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

test('session-binding GC is dry-run first and skips bindings without a clock', async () => {
  state.ensureSession('gc-old', { cwd: path.join(home, 'old') })
  state.setSessionBinding('gc-old', { lastTurnAt: '2020-01-01T00:00:00.000Z' })
  state.ensureSession('gc-new', { cwd: path.join(home, 'new') })
  state.setSessionBinding('gc-new', { lastTurnAt: new Date().toISOString() })
  state.ensureSession('gc-noclock', { cwd: path.join(home, 'noclock') })

  const dry = state.pruneSessionBindings({ olderThanDays: 30 })
  assert.equal(dry.dryRun, true)
  assert.deepEqual(dry.candidates.map((item) => item.sessionId), ['gc-old'])
  assert.ok(state.getSessionBinding('gc-old'), 'dry-run must not remove')

  const applied = state.pruneSessionBindings({ olderThanDays: 30, dryRun: false })
  assert.deepEqual(applied.removed, ['gc-old'])
  assert.equal(state.getSessionBinding('gc-old'), null)
  assert.ok(state.getSessionBinding('gc-new'), 'a recent binding survives')
  assert.ok(state.getSessionBinding('gc-noclock'), 'a binding without lastTurnAt is never guessed away')
})
