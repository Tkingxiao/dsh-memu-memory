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
  const assets = {
    'win32-x64': ['uv-x86_64-pc-windows-msvc.zip', 'a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f'],
    'win32-arm64': ['uv-aarch64-pc-windows-msvc.zip', 'c2426c0c8e28b53d8c440e47a18d96ad4db51e159866c0e81435b196d7f0081c'],
    'linux-x64': ['uv-x86_64-unknown-linux-gnu.tar.gz', 'f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645'],
    'linux-arm64': ['uv-aarch64-unknown-linux-gnu.tar.gz', '229e194255c7958d86d56e8790d969a6f74736592133f0dfd0076f754c642c1d'],
    'darwin-x64': ['uv-x86_64-apple-darwin.tar.gz', '63ba17fdda55ad1a230d4b37fc6017ffa10c23688c83818bd3bfdf914c652a02'],
    'darwin-arm64': ['uv-aarch64-apple-darwin.tar.gz', '60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472'],
  }
  const asset = assets[process.platform + '-' + process.arch]
  const fingerprint = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex')
  fs.writeFileSync(path.join(path.dirname(binary), 'verified.json'), JSON.stringify({ version: UV_VERSION, archive: asset[0], archiveSha256: asset[1], executableBytes: fs.statSync(binary).size, executableSha256: fingerprint }))
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
test('tampered or legacy uv metadata is never executed', async () => {
  const previousHome = process.env.DSH_MEMU_HOME
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-runtime-tamper-'))
  process.env.DSH_MEMU_HOME = isolated
  try {
    const binary = path.join(isolated, 'engine', 'runtime', `uv-${UV_VERSION}`, process.platform === 'win32' ? 'uv.exe' : 'uv')
    fs.mkdirSync(path.dirname(binary), { recursive: true })
    fs.writeFileSync(binary, 'trusted fixture')
    fs.writeFileSync(path.join(path.dirname(binary), 'verified.json'), JSON.stringify({ version: UV_VERSION, archive: 'legacy', sha256: '0'.repeat(64) }))
    let executed = false
    await assert.rejects(ensureManagedPython({
      run: async () => { executed = true; return { code: 0, stdout: `uv ${UV_VERSION}` } },
      fetcher: async () => { throw new Error('replacement required') },
    }), /replacement required/)
    assert.equal(executed, false)
  } finally {
    process.env.DSH_MEMU_HOME = previousHome
    fs.rmSync(isolated, { recursive: true, force: true })
  }
})

test('a discovered interpreter outside the plugin directory is refused', async () => {
  await assert.rejects(ensureManagedPython({
    run: async (_cmd, args) => ({ code: 0, stdout: args[0] === '--version' ? `uv ${UV_VERSION}` : 'C:/outside/python.exe' }),
  }), /escaped/)
})
