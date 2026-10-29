import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dataDir } from '../lib/paths.js'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-rename-'))
const previous = { DSH_HOME: process.env.DSH_HOME, DSH_MEMU_HOME: process.env.DSH_MEMU_HOME, DSH_MEMU_MEMORY_HOME: process.env.DSH_MEMU_MEMORY_HOME }
process.env.DSH_HOME = home
delete process.env.DSH_MEMU_HOME
delete process.env.DSH_MEMU_MEMORY_HOME
test.after(() => {
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  fs.rmSync(home, { recursive: true, force: true })
})
test('fresh installations use the new name but existing memories remain in their original directory', () => {
  assert.equal(dataDir(), path.join(home, 'dsh-memu-memory'))
  fs.mkdirSync(path.join(home, 'dsh-memu'))
  assert.equal(dataDir(), path.join(home, 'dsh-memu'))
  fs.mkdirSync(path.join(home, 'dsh-memu-memory'))
  assert.equal(dataDir(), path.join(home, 'dsh-memu'), 'an empty new directory must not shadow existing memories')
  fs.writeFileSync(path.join(home, 'dsh-memu-memory', 'state.json'), '{}')
  assert.equal(dataDir(), path.join(home, 'dsh-memu-memory'))
})
test('both the new and the previous explicit data-root overrides stay supported', () => {
  process.env.DSH_MEMU_HOME = path.join(home, 'old-override')
  assert.equal(dataDir(), process.env.DSH_MEMU_HOME)
  process.env.DSH_MEMU_MEMORY_HOME = path.join(home, 'new-override')
  assert.equal(dataDir(), process.env.DSH_MEMU_MEMORY_HOME)
})
