import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-runtime-'))
process.env.DSH_MEMU_HOME = home
const { ensureManagedPython, verifyRuntimeArchive, UV_VERSION, MANAGED_PYTHON } = await import('../lib/managed-runtime.js')
test.after(() => fs.rmSync(home, { recursive: true, force: true }))
test('runtime downloads cannot execute unless their pinned SHA256 matches', () => {
  const data = Buffer.from('not a trusted runtime')
  assert.throws(() => verifyRuntimeArchive(data, '0'.repeat(64)), /checksum mismatch/)
  assert.doesNotThrow(() => verifyRuntimeArchive(data, crypto.createHash('sha256').update(data).digest('hex')))
})
test('managed Python discovery is pinned and all write directories stay inside engine', async () => {
  const binary = path.join(home, 'engine', 'runtime', `uv-${UV_VERSION}`, process.platform === 'win32' ? 'uv.exe' : 'uv')
  fs.mkdirSync(path.dirname(binary), { recursive: true })
  fs.writeFileSync(binary, 'fixture; never executed')
  const python = path.join(home, 'engine', 'runtime', 'python', 'python.exe')
  fs.mkdirSync(path.dirname(python), { recursive: true })
  fs.writeFileSync(python, 'fixture')
  const calls = []
  const result = await ensureManagedPython({
    run: async (cmd, args, options) => {
      calls.push({ cmd, args, options })
      return { code: 0, stdout: args[0] === '--version' ? `uv ${UV_VERSION}\n` : args[1] === 'find' ? python + '\n' : '' }
    },
    fetcher: async () => { throw new Error('must reuse the managed runtime') },
  })
  assert.equal(result.version.raw, MANAGED_PYTHON)
  assert.equal(result.hasPip, false)
  for (const call of calls) for (const key of ['UV_PYTHON_INSTALL_DIR', 'UV_CACHE_DIR', 'UV_PYTHON_BIN_DIR']) assert.ok(call.options.env[key].startsWith(path.join(home, 'engine')))
  assert.ok(calls.some(call => call.options.env.UV_PYTHON_PREFERENCE === 'only-managed' && call.args.includes('--no-python-downloads')))
})
test('a discovered interpreter outside the plugin directory is refused', async () => {
  await assert.rejects(ensureManagedPython({
    run: async (_cmd, args) => ({ code: 0, stdout: args[0] === '--version' ? `uv ${UV_VERSION}` : 'C:/outside/python.exe' }),
  }), /escaped/)
})
