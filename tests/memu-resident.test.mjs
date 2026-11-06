import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-resident-'))
process.env.DSH_MEMU_HOME = home

const memu = await import('../lib/memu.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

test('the resident singleton is declared before its first executable use', () => {
  const source = fs.readFileSync(new URL('../lib/memu.js', import.meta.url), 'utf8')
  const declaration = /^let residentRecord = null$/m.exec(source)
  assert.ok(declaration, 'lib/memu.js must declare `let residentRecord = null`')
  // Comments may mention the name before the declaration; the first executable use
  // (stopResident) must sit after it, or ESM strict mode throws ReferenceError.
  const firstCodeUse = source.indexOf('residentRecord === record')
  assert.ok(firstCodeUse > declaration.index, 'the first executable use must come after the declaration')
})

test('closing and prewarming the resident engine does not throw ReferenceError', async () => {
  assert.equal(typeof memu.closeMemuResident, 'function')
  assert.equal(memu.closeMemuResident(), 0, 'closing a non-existent resident is a no-op')
  assert.equal(memu.closeMemuResident(), 0, 'close is idempotent')
  // Default route is lexical, so prewarm returns false without spawning. The point is
  // that the function body runs and the module-level singleton is reachable.
  assert.equal(await memu.prewarmMemuResident(), false)
})
