import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-embed-runtime-'))
process.env.DSH_MEMU_HOME = home
delete process.env.DSH_MEMU_EMBED_RUNTIME_DIR

const runtime = await import('../lib/embedding-runtime.js')
const { getEmbeddingModel } = await import('../lib/embedding-catalog.js')
const service = await import('../lib/local-vector-service.js')
const { profileFromCatalog, setRequestedProfile } = await import('../lib/vector-profile.js')

test.after(() => fs.rmSync(home, { recursive: true, force: true }))

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const utf8 = text => Buffer.from(text, 'utf8')

// A fake registry payload: the pinned facts below are the test's own, computed from the
// same bytes, so this fixture proves the *mechanism* (pin, verify, extract, smoke) rather
// than pretending to be a real artifact. Nothing here is ever executed.
const PKG_JSON = utf8('{"name":"onnxruntime-node","version":"9.9.9"}')
const NATIVE_BYTES = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x66, 0x61, 0x6b, 0x65])
const JS_BYTES = utf8('module.exports = 42\n')
const TARBALL = Buffer.from('fake pinned runtime archive')

function fixtureEntry(overrides = {}) {
  return {
    id: 'fixture-model',
    availability: 'available',
    runtime: {
      engine: 'onnxruntime-node',
      version: '9.9.9',
      abi: 'napi-v6',
      os: 'win32',
      arch: 'x64',
      artifacts: [
        {
          name: 'onnxruntime-node',
          version: '9.9.9',
          url: 'https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-9.9.9.tgz',
          bytes: TARBALL.length,
          sha256: sha256(TARBALL),
          extract: ['package.json', 'lib', 'bin/napi-v6/<platform>'],
        },
      ],
      packageFiles: [{ package: 'onnxruntime-node', bytes: PKG_JSON.length, sha256: sha256(PKG_JSON) }],
      native: {
        'win32-x64': [
          {
            path: 'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node',
            bytes: NATIVE_BYTES.length,
            sha256: sha256(NATIVE_BYTES),
          },
        ],
      },
      ...overrides,
    },
  }
}

function fakeExtract({ cwd }) {
  fs.writeFileSync(path.join(cwd, 'package.json'), PKG_JSON)
  fs.mkdirSync(path.join(cwd, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'lib', 'index.js'), JS_BYTES)
  const dir = path.join(cwd, 'bin', 'napi-v6', 'win32', 'x64')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'onnxruntime_binding.node'), NATIVE_BYTES)
}

function fakeFetch({ bytes = TARBALL, calls = [] } = {}) {
  const fetchImpl = async url => {
    calls.push(String(url))
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: (async function* () { yield bytes })(),
    }
  }
  return { fetchImpl, calls }
}

const okSmoke = async () => ({ ok: true, ortVersion: '9.9.9', tokenizer: true, checks: ['smoke:fixture'] })

function makeInstaller(root, options = {}) {
  const entry = options.entry || fixtureEntry()
  const fetch = options.fetch || fakeFetch()
  return {
    entry,
    fetch,
    installer: runtime.createEmbeddingRuntimeInstaller({
      root,
      platform: 'win32-x64',
      resolveEntry: () => entry,
      fetchImpl: fetch.fetchImpl,
      extract: options.extract === null ? undefined : (options.extract || fakeExtract),
      smoke: options.smoke || okSmoke,
      logger: { warn: () => {} },
    }),
  }
}

test('a pending catalog model pins no runtime and is refused before any download', () => {
  const plan = runtime.runtimePlan(getEmbeddingModel('all-minilm-l6-v2-int8'), 'win32-x64')
  assert.equal(plan.ok, false)
  assert.ok(plan.errors.some(item => item.code === 'RUNTIME_ENTRY_NOT_AVAILABLE'))
  assert.ok(plan.errors.some(item => item.code === 'RUNTIME_ARTIFACTS_MISSING'))
})

test('a platform with no pinned native binaries fails closed instead of guessing', () => {
  const entry = getEmbeddingModel('bge-small-zh-v1.5-int8')
  const plan = runtime.runtimePlan(entry, 'darwin-x64')
  assert.equal(plan.ok, false)
  assert.deepEqual(plan.errors.map(item => item.code), ['RUNTIME_NATIVE_MISSING'])
})

test('the verified BGE entry pins a complete runtime for every shipped platform', () => {
  const entry = getEmbeddingModel('bge-small-zh-v1.5-int8')
  for (const platform of ['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'darwin-arm64']) {
    const plan = runtime.runtimePlan(entry, platform)
    assert.equal(plan.ok, true, platform + ': ' + JSON.stringify(plan.errors))
    assert.equal(plan.artifacts.length, 3)
    for (const artifact of plan.artifacts) {
      assert.match(artifact.sha256, /^[0-9a-f]{64}$/)
      assert.equal(artifact.url.startsWith('https://'), true)
      assert.ok(artifact.bytes > 0)
    }
    assert.ok(plan.native.length >= 2)
  }
})

test('guessed or missing hashes are rejected: no artifact installs without bytes and sha256', () => {
  const missingHash = runtime.runtimePlan(fixtureEntry({ version: null }), 'win32-x64')
  assert.equal(missingHash.ok, false)
  assert.ok(missingHash.errors.some(item => item.code === 'RUNTIME_VERSION_UNPINNED'))

  const guessed = fixtureEntry()
  guessed.runtime.artifacts[0].sha256 = 'deadbeef'
  const plan = runtime.runtimePlan(guessed, 'win32-x64')
  assert.equal(plan.ok, false)
  assert.ok(plan.errors.some(item => item.code === 'RUNTIME_ARTIFACT_SHA256_INVALID'))

  const noBytes = fixtureEntry()
  noBytes.runtime.artifacts[0].bytes = 0
  assert.ok(runtime.runtimePlan(noBytes, 'win32-x64').errors.some(item => item.code === 'RUNTIME_ARTIFACT_BYTES_INVALID'))

  assert.throws(() => runtime.verifyRuntimeArtifact(TARBALL, { name: 'x', bytes: TARBALL.length }), /no pinned sha256/)
  assert.throws(() => runtime.verifyRuntimeArtifact(TARBALL, { name: 'x', bytes: TARBALL.length, sha256: '0'.repeat(64) }), /hash_mismatch|does not match the pinned/i)
  assert.throws(() => runtime.verifyRuntimeArtifact(TARBALL, { name: 'x', bytes: TARBALL.length + 1, sha256: sha256(TARBALL) }), /expects|expected/i)
  assert.equal(runtime.verifyRuntimeArtifact(TARBALL, { name: 'x', bytes: TARBALL.length, sha256: sha256(TARBALL) }), sha256(TARBALL))
})

test('the extraction allow-list carries <platform> and never widens to another platform', () => {
  const entry = getEmbeddingModel('bge-small-zh-v1.5-int8')
  const plan = runtime.runtimePlan(entry, 'win32-x64')
  const list = runtime.extractAllowList(plan.artifacts[0], 'win32-x64')
  assert.ok(list.includes('bin/napi-v6/win32/x64'))
  assert.equal(list.some(item => item.includes('<platform>')), false)
  const allows = rel => list.some(prefix => rel === prefix || rel.startsWith(prefix + '/'))
  assert.equal(allows('bin/napi-v6/win32/x64/onnxruntime.dll'), true)
  assert.equal(allows('bin/napi-v6/linux/x64/libonnxruntime.so.1'), false)
  assert.equal(allows('script/install.js'), false)
  assert.equal(allows('package.json'), true)
})

test('install needs explicit confirmation and never touches the network before it', async () => {
  const root = path.join(home, 'no-confirm')
  const { installer, fetch } = makeInstaller(root)
  await assert.rejects(installer.ensure({}), /confirmation|explicit/i)
  assert.deepEqual(fetch.calls, [])
  assert.equal(installer.getStatus().status, 'absent')
  assert.equal(fs.existsSync(path.join(root, 'active.json')), false)
})

test('install verifies bytes, extracts, smokes and publishes an atomic active pointer', async () => {
  const root = path.join(home, 'happy')
  const { installer, fetch } = makeInstaller(root)
  const result = await installer.ensure({ confirmed: true })
  assert.equal(result.status, 'installed')
  assert.equal(result.ready, true)
  assert.equal(result.reused, false)
  assert.equal(fetch.calls.length, 1)
  assert.equal(fs.existsSync(path.join(result.path, 'installed.json')), true)
  assert.equal(fs.existsSync(path.join(result.path, 'node_modules', 'onnxruntime-node', 'package.json')), true)
  const native = path.join(result.path, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64', 'onnxruntime_binding.node')
  assert.deepEqual(fs.readFileSync(native), NATIVE_BYTES)
  const active = JSON.parse(fs.readFileSync(path.join(root, 'active.json'), 'utf8'))
  assert.equal(active.key, result.key)
  assert.equal(active.dir, result.path)
  assert.equal(active.platform, 'win32-x64')
  const record = JSON.parse(fs.readFileSync(path.join(result.path, 'installed.json'), 'utf8'))
  assert.equal(record.postinstall, 'never-run')
  assert.equal(record.smoke.ok, true)
  assert.equal(record.artifacts[0].sha256, sha256(TARBALL))
  assert.ok(record.files.some(file => file.path.endsWith('onnxruntime_binding.node')))
  // 安装物不能留下 tarball：受管目录只放解包后的运行时。
  assert.equal(fs.existsSync(path.join(result.path, '.artifacts')), false)
})

test('a restart reuses the verified runtime instead of downloading 115 MB again', async () => {
  const root = path.join(home, 'reuse')
  const first = makeInstaller(root)
  const installed = await first.installer.ensure({ confirmed: true })
  assert.equal(first.fetch.calls.length, 1)

  const second = makeInstaller(root)
  assert.equal(second.installer.getStatus().status, 'installed')
  const reused = await second.installer.ensure({})
  assert.equal(reused.reused, true)
  assert.equal(reused.path, installed.path)
  assert.deepEqual(second.fetch.calls, [])
  const deep = second.installer.getStatus({ deep: true })
  assert.equal(deep.status, 'installed')
  assert.equal(deep.ready, true)
})

test('concurrent first-use installs share one download and stay idempotent', async () => {
  const root = path.join(home, 'concurrent')
  const { installer, fetch } = makeInstaller(root)
  const [a, b] = await Promise.all([installer.ensure({ confirmed: true }), installer.ensure({ confirmed: true })])
  assert.equal(a.path, b.path)
  assert.equal(fetch.calls.length, 1)
  const again = await installer.ensure({})
  assert.equal(again.reused, true)
})

test('a live install lock from another process is reported, not fought over', async () => {
  const root = path.join(home, 'locked')
  const staging = path.join(root, '.staging')
  fs.mkdirSync(staging, { recursive: true })
  fs.writeFileSync(path.join(staging, 'install.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }))
  const { installer, fetch } = makeInstaller(root)
  await assert.rejects(installer.ensure({ confirmed: true }), /already installing|BUSY|another process/i)
  assert.deepEqual(fetch.calls, [])
})

test('a hash mismatch leaves no active pointer and no staging leftovers', async () => {
  const root = path.join(home, 'bad-hash')
  // 同长度、不同内容：这样命中的是 sha256 校验，而不是长度校验。
  const tampered = Buffer.from('FAKE PINNED RUNTIME ARCHIVE')
  const { installer, fetch } = makeInstaller(root, { fetch: fakeFetch({ bytes: tampered }) })
  assert.equal(tampered.length, TARBALL.length)
  await assert.rejects(installer.ensure({ confirmed: true }), /hash|sha256|checksum/i)
  assert.equal(fetch.calls.length, 1)
  assert.equal(fs.existsSync(path.join(root, 'active.json')), false)
  assert.equal(installer.getStatus().status, 'failed')
  const leftovers = fs.existsSync(path.join(root, '.staging')) ? fs.readdirSync(path.join(root, '.staging')).filter(name => name.startsWith('install-')) : []
  assert.deepEqual(leftovers, [])
})

test('a native smoke failure never becomes an installed runtime', async () => {
  const root = path.join(home, 'smoke-fail')
  const { installer } = makeInstaller(root, { smoke: async () => ({ ok: false, message: 'cannot load onnxruntime_binding.node' }) })
  await assert.rejects(installer.ensure({ confirmed: true }), /cannot load onnxruntime_binding.node/)
  assert.equal(fs.existsSync(path.join(root, 'active.json')), false)
  const status = installer.getStatus()
  assert.equal(status.status, 'failed')
  assert.match(status.error.message, /cannot load/)
})

test('a tampered runtime on disk is not reused as ready', async () => {
  const root = path.join(home, 'tamper')
  const { installer, fetch } = makeInstaller(root)
  const installed = await installer.ensure({ confirmed: true })
  const native = path.join(installed.path, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64', 'onnxruntime_binding.node')
  fs.writeFileSync(native, Buffer.from([1, 2, 3]))
  assert.equal(installer.getStatus().status, 'absent')
  await assert.rejects(installer.ensure({ reuseOnly: true }), /not installed yet/)
  const repair = await installer.ensure({ confirmed: true })
  assert.equal(repair.status, 'installed')
  assert.equal(fetch.calls.length, 2)
})

test('the real tarball extractor drops everything the allow-list did not pin', async () => {
  const root = path.join(home, 'real-extract')
  const stage = path.join(home, 'real-extract-source')
  fs.mkdirSync(path.join(stage, 'package', 'bin', 'napi-v6', 'win32', 'x64'), { recursive: true })
  fs.mkdirSync(path.join(stage, 'package', 'bin', 'napi-v6', 'linux', 'x64'), { recursive: true })
  fs.mkdirSync(path.join(stage, 'package', 'script'), { recursive: true })
  fs.writeFileSync(path.join(stage, 'package', 'package.json'), PKG_JSON)
  fs.writeFileSync(path.join(stage, 'package', 'bin', 'napi-v6', 'win32', 'x64', 'onnxruntime_binding.node'), NATIVE_BYTES)
  fs.writeFileSync(path.join(stage, 'package', 'bin', 'napi-v6', 'linux', 'x64', 'libonnxruntime.so.1'), Buffer.from('linux'))
  fs.writeFileSync(path.join(stage, 'package', 'script', 'install.js'), Buffer.from('postinstall'))

  const { c } = await import('tar')
  const archive = path.join(home, 'real-extract.tgz')
  await c({ gzip: true, file: archive, cwd: stage }, ['package'])
  const bytes = fs.readFileSync(archive)

  const entry = fixtureEntry()
  entry.runtime.artifacts[0].bytes = bytes.length
  entry.runtime.artifacts[0].sha256 = sha256(bytes)
  const { installer } = makeInstaller(root, { entry, extract: null, fetch: fakeFetch({ bytes }) })
  const installed = await installer.ensure({ confirmed: true })
  const nodeModules = path.join(installed.path, 'node_modules', 'onnxruntime-node')
  assert.deepEqual(fs.readFileSync(path.join(nodeModules, 'package.json')), PKG_JSON)
  assert.deepEqual(fs.readFileSync(path.join(nodeModules, 'bin', 'napi-v6', 'win32', 'x64', 'onnxruntime_binding.node')), NATIVE_BYTES)
  assert.equal(fs.existsSync(path.join(nodeModules, 'bin', 'napi-v6', 'linux')), false)
  assert.equal(fs.existsSync(path.join(nodeModules, 'script')), false)
})

test('service status reports a missing runtime truthfully and bootstrap never invents one', async () => {
  const status = service.localVectorRuntimeStatus()
  assert.equal(status.ready, false)
  assert.notEqual(status.status, 'configured')
  // 一个设置了但没有运行时的 env 目录不算 ready（不会被当成「配置好了」）。
  const emptyDir = path.join(home, 'empty-runtime')
  fs.mkdirSync(emptyDir, { recursive: true })
  process.env.DSH_MEMU_EMBED_RUNTIME_DIR = emptyDir
  try {
    assert.equal(service.hasEmbeddingRuntimePackages(emptyDir), false)
    const withEnv = service.localVectorRuntimeStatus()
    assert.equal(withEnv.ready, false)
    assert.equal(withEnv.envIgnored, true)
  } finally {
    delete process.env.DSH_MEMU_EMBED_RUNTIME_DIR
  }
  assert.equal(service.hasEmbeddingRuntimePackages(path.join(home, 'nope')), false)
})

test('bootstrap fails closed with a lexical fallback signal instead of a cloud fallback', async () => {
  const profile = profileFromCatalog('bge-small-zh-v1.5-int8', { modelDir: path.join(home, 'model'), runtimeDir: null })
  setRequestedProfile(profile, { status: 'requested' })
  await assert.rejects(service.bootstrapLocalVector({ confirmed: false }), error => {
    assert.match(String(error?.code || ''), /^LOCAL_VECTOR_RUNTIME_/)
    assert.equal(error?.fallback, 'lexical')
    return true
  })
})
test('missing exact bytes are refused by the artifact verification API', () => {
  assert.throws(() => runtime.verifyRuntimeArtifact(TARBALL, { name: 'x', sha256: sha256(TARBALL) }), error => error.code === 'LOCAL_VECTOR_RUNTIME_UNVERIFIED')
})

test('same-size native tampering is rejected before reuse without explicit download confirmation', async () => {
  const root = path.join(home, 'same-size-tamper')
  const first = makeInstaller(root)
  const installed = await first.installer.ensure({ confirmed: true })
  const native = path.join(installed.path, ...fixtureEntry().runtime.native['win32-x64'][0].path.split('/'))
  fs.writeFileSync(native, Buffer.alloc(NATIVE_BYTES.length, 0))
  const second = makeInstaller(root)
  await assert.rejects(second.installer.ensure({ reuseOnly: true }), error => error.code === 'LOCAL_VECTOR_RUNTIME_ABSENT')
  assert.deepEqual(second.fetch.calls, [])
})

test('an active-pointer commit failure preserves the previous generation byte-for-byte', async t => {
  const root = path.join(home, 'atomic-pointer-fail')
  const first = makeInstaller(root)
  const installed = await first.installer.ensure({ confirmed: true })
  const activeFile = path.join(root, 'active.json')
  const activeBefore = fs.readFileSync(activeFile)
  const native = path.join(installed.path, ...fixtureEntry().runtime.native['win32-x64'][0].path.split('/'))
  const entry = fixtureEntry()
  entry.runtime.artifacts[0].url += '?metadata-refresh'
  const next = makeInstaller(root, { entry })
  const originalRename = fs.renameSync
  const mocked = t.mock.method(fs, 'renameSync', (source, target) => {
    if (path.resolve(target) === path.resolve(activeFile)) throw Object.assign(new Error('simulated active pointer write failure'), { code: 'EIO' })
    return originalRename(source, target)
  })
  try {
    await assert.rejects(next.installer.ensure({ confirmed: true }), /cannot publish.*active pointer/)
  } finally {
    mocked.mock.restore()
  }
  assert.deepEqual(fs.readFileSync(activeFile), activeBefore)
  assert.deepEqual(fs.readFileSync(native), NATIVE_BYTES)
  const previous = makeInstaller(root)
  assert.equal(previous.installer.getStatus({ deep: true }).ready, true)
  const reused = await previous.installer.ensure({ reuseOnly: true })
  assert.equal(reused.path, installed.path)
  assert.deepEqual(previous.fetch.calls, [])
  assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith(installed.key)), [path.basename(installed.path)])
})

test('a failed upgrade smoke preserves the previous active runtime', async () => {
  const root = path.join(home, 'atomic-smoke-fail')
  const first = makeInstaller(root)
  const installed = await first.installer.ensure({ confirmed: true })
  const activeFile = path.join(root, 'active.json')
  const activeBefore = fs.readFileSync(activeFile)
  const next = makeInstaller(root, { entry: fixtureEntry({ version: '9.9.10' }), smoke: async () => ({ ok: false, message: 'upgrade smoke failed' }) })
  await assert.rejects(next.installer.ensure({ confirmed: true }), /upgrade smoke failed/)
  assert.deepEqual(fs.readFileSync(activeFile), activeBefore)
  assert.equal((await first.installer.ensure({ reuseOnly: true })).path, installed.path)
})
