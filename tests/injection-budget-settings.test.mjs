import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-injection-budget-settings-'))
process.env.DSH_MEMU_HOME = home

const rpc = await import('../lib/rpc.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

test('the settings RPC stores, clamps, and resets injectionTotalTokens', async () => {
  const byDefault = await rpc.dispatch({}, 'getState', {})
  assert.equal(byDefault.settings.injectionTotalTokens, 2000)

  const saved = await rpc.dispatch({}, 'setSettings', { patch: { injectionTotalTokens: 2400 } })
  assert.equal(saved.injectionTotalTokens, 2400)

  const clamped = await rpc.dispatch({}, 'setSettings', { patch: { injectionTotalTokens: 0 } })
  assert.equal(clamped.injectionTotalTokens, 160)

  const reset = await rpc.dispatch({}, 'resetSettings', {})
  assert.equal(reset.injectionTotalTokens, 2000)
})

test('the settings RPC rejects a non-numeric injectionTotalTokens', async () => {
  await assert.rejects(
    rpc.dispatch({}, 'setSettings', { patch: { injectionTotalTokens: '2400' } }),
    /injectionTotalTokens must be a finite number/,
  )
})
