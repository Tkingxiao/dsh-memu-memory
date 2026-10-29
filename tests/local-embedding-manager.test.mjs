import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn as spawnReal } from 'node:child_process'
import { createEmbeddingWorkerManager, embeddingWorkerManager, closeEmbeddingWorkers } from '../lib/local-embedding-manager.js'

const MODEL = 'bge-small-zh-v1.5@r1+mean-l2-512'
const TOKEN_PATTERN = /^[0-9a-f]{64}$/

const PROFILE = Object.freeze({
  catalogId: 'bge-small-zh-v1.5',
  fingerprint: 'f'.repeat(64),
  dimension: 512,
  modelDir: 'D:/managed/model',
  runtimeDir: 'D:/managed/runtime',
  manifest: Object.freeze({ id: 'bge-small-zh-v1.5', revision: 'r1', protocol: 'mean-l2-512', dimension: 512, verified: true }),
})

const readyLine = (overrides = {}) => ({
  type: 'ready',
  baseUrl: 'http://127.0.0.1:45123/v1',
  url: 'http://127.0.0.1:45123/v1/embeddings',
  model: MODEL,
  dimension: 512,
  pid: 4242,
  ...overrides,
})

const tick = () => new Promise(resolve => setImmediate(resolve))
const push = (child, value) => child.stdout.emit('data', Buffer.from(JSON.stringify(value) + String.fromCharCode(10)))
const rawPush = (child, text) => child.stdout.emit('data', Buffer.from(text))
const exitChild = (child, code = 1) => child.emit('close', code)

// A stand-in for a spawned worker: real EventEmitters with the same event names, so
// the manager's lifecycle can be exercised without a native runtime on any platform.
function fakeSpawn() {
  const calls = []
  const children = []
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter()
    child.command = command
    child.args = args
    child.options = options
    child.events = []
    child.stdin = new EventEmitter()
    child.stdin.ended = false
    child.stdin.end = () => { child.events.push('stdin.end'); child.stdin.ended = true }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => { child.events.push('kill'); child.killed = true }
    calls.push({ command, args, options })
    children.push(child)
    return child
  }
  return { spawnImpl, calls, children }
}

function captureLogger() {
  const lines = []
  const record = level => message => lines.push(level + ':' + String(message))
  return { lines, logger: { log: record('log'), info: record('info'), warn: record('warn'), error: record('error') } }
}

const makeManager = (overrides = {}) => createEmbeddingWorkerManager({
  verifyProfile: () => PROFILE,
  logger: { warn: () => {}, info: () => {}, error: () => {} },
  timeoutMs: 5_000,
  ...overrides,
})

test('concurrent acquires of one profile share a single worker and a bare loopback endpoint', async () => {
  const { spawnImpl, calls, children } = fakeSpawn()
  const manager = makeManager({ spawnImpl })
  const first = manager.acquire(PROFILE)
  const second = manager.acquire(PROFILE)
  assert.equal(calls.length, 1, 'a second acquire must not spawn a second child')
  assert.deepEqual(manager.status(), { running: 0, booting: 1, closed: false, tripped: 0 })
  push(children[0], readyLine())
  const [a, b] = await Promise.all([first, second])
  assert.equal(calls.length, 1)
  assert.equal(a, b, 'both callers observe the same endpoint object')
  assert.ok(Object.isFrozen(a), 'the endpoint handed to MemU is immutable')
  assert.equal(a.baseUrl, 'http://127.0.0.1:45123/v1')
  assert.equal(a.model, MODEL, 'the ready model id is the manifest id, not the catalog id')
  assert.equal(a.dimension, 512)
  assert.match(a.token, TOKEN_PATTERN)
  assert.deepEqual(manager.status(), { running: 1, booting: 0, closed: false, tripped: 0 })
  const { args, options } = calls[0]
  assert.equal(args.length, 1)
  assert.match(args[0], /local-embedding-entry\.js$/)
  assert.equal(options.env.DSH_MEMU_EMBED_TOKEN, a.token)
  assert.equal(options.env.DSH_MEMU_EMBED_HOST, '127.0.0.1')
  assert.equal(options.env.DSH_MEMU_EMBED_PORT, '0')
  assert.equal(options.env.DSH_MEMU_EMBED_MODEL_DIR, PROFILE.modelDir)
  assert.equal(options.env.DSH_MEMU_EMBED_RUNTIME_DIR, PROFILE.runtimeDir)
  assert.equal(options.env.MEMU_TELEMETRY, '0')
  assert.equal(options.env.DO_NOT_TRACK, '1')
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(JSON.parse(options.env.DSH_MEMU_EMBED_MANIFEST).verified, true)
  assert.equal(manager.close(), 1)
  assert.deepEqual(children[0].events, ['stdin.end', 'kill'], 'stdin EOF is asked for before the kill')
  assert.deepEqual(manager.status(), { running: 0, booting: 0, closed: true, tripped: 0 })
})

test('every worker gets a fresh random token that never reaches logs, status or errors', async () => {
  const log = captureLogger()
  const { spawnImpl, children } = fakeSpawn()
  const manager = makeManager({ spawnImpl, logger: log.logger })
  const firstBoot = manager.acquire(PROFILE)
  push(children[0], readyLine())
  const endpoint = await firstBoot
  assert.match(endpoint.token, TOKEN_PATTERN)
  const other = manager.acquire({ ...PROFILE, fingerprint: 'e'.repeat(64) })
  assert.notEqual(children[1].options.env.DSH_MEMU_EMBED_TOKEN, endpoint.token, 'tokens are per worker')
  // A worker that echoes its own secret back must not get it into any message.
  push(children[1], readyLine({ baseUrl: 'http://user:' + endpoint.token + '@127.0.0.1:45124/v1' }))
  await assert.rejects(other, error => {
    assert.equal(error.code, 'LOCAL_VECTOR_BAD_READY')
    assert.equal(error.fallback, 'lexical')
    assert.ok(!String(error.message).includes(endpoint.token))
    return true
  })
  await tick()
  const surface = JSON.stringify(manager.status()) + log.lines.join(String.fromCharCode(10))
  assert.ok(!surface.includes(endpoint.token), 'no token may appear in status or logs')
  assert.ok(!surface.includes('45124'), 'no endpoint may appear in status or logs')
  manager.close()
})

test('readiness is validated against the requested profile in every direction', async () => {
  const cases = [
    ['a non-object', 'oops'],
    ['a null message', null],
    ['a wrong type', readyLine({ type: 'hello' })],
    ['another model', readyLine({ model: 'other-model@r1+mean-l2-512' })],
    ['the catalog id instead of the manifest id', readyLine({ model: PROFILE.catalogId })],
    ['another dimension', readyLine({ dimension: 384 })],
    ['a wildcard host', readyLine({ baseUrl: 'http://0.0.0.0:45123/v1', url: null })],
    ['a remote host', readyLine({ baseUrl: 'http://10.0.0.2:45123/v1', url: null })],
    ['the localhost alias', readyLine({ baseUrl: 'http://localhost:45123/v1', url: null })],
    ['https', readyLine({ baseUrl: 'https://127.0.0.1:45123/v1', url: null })],
    ['a missing port', readyLine({ baseUrl: 'http://127.0.0.1/v1', url: null })],
    ['port zero', readyLine({ baseUrl: 'http://127.0.0.1:0/v1', url: null })],
    ['embedded credentials', readyLine({ baseUrl: 'http://user:pass@127.0.0.1:45123/v1', url: null })],
    ['a query string', readyLine({ baseUrl: 'http://127.0.0.1:45123/v1?x=1', url: null })],
    ['a fragment', readyLine({ baseUrl: 'http://127.0.0.1:45123/v1#x', url: null })],
    ['another path', readyLine({ baseUrl: 'http://127.0.0.1:45123/', url: null })],
    ['an embeddings url on another base', readyLine({ url: 'http://127.0.0.1:45123/v2/embeddings' })],
  ]
  for (const [label, value] of cases) {
    const { spawnImpl, children } = fakeSpawn()
    const manager = makeManager({ spawnImpl })
    const pending = manager.acquire(PROFILE)
    if (typeof value === 'string') rawPush(children[0], value + String.fromCharCode(10))
    else push(children[0], value)
    await assert.rejects(pending, error => {
      assert.equal(error.code, 'LOCAL_VECTOR_BAD_READY', label)
      assert.equal(error.fallback, 'lexical', label)
      return true
    })
    assert.equal(children[0].stdin.ended, true, label)
    assert.equal(children[0].killed, true, label)
    assert.deepEqual(manager.status(), { running: 0, booting: 0, closed: false, tripped: 0 }, label)
    manager.close()
  }
})

test('unreadable and oversized readiness lines fail closed', async () => {
  const unreadable = fakeSpawn()
  const unreadableManager = makeManager({ spawnImpl: unreadable.spawnImpl })
  const pending = unreadableManager.acquire(PROFILE)
  rawPush(unreadable.children[0], 'not json at all' + String.fromCharCode(10))
  await assert.rejects(pending, error => error.code === 'LOCAL_VECTOR_BAD_READY')
  unreadableManager.close()

  const oversized = fakeSpawn()
  const oversizedManager = makeManager({ spawnImpl: oversized.spawnImpl })
  const chunked = oversizedManager.acquire(PROFILE)
  rawPush(oversized.children[0], 'x'.repeat(20_000))
  await assert.rejects(chunked, error => error.code === 'LOCAL_VECTOR_BAD_READY')
  assert.equal(oversized.children[0].killed, true)
  oversizedManager.close()
})

test('a worker that never reports ready times out, is stopped and stays observable', async () => {
  const log = captureLogger()
  const { spawnImpl, children } = fakeSpawn()
  const manager = makeManager({ spawnImpl, logger: log.logger, timeoutMs: 25 })
  await assert.rejects(manager.acquire(PROFILE), error => {
    assert.equal(error.code, 'LOCAL_VECTOR_START_TIMEOUT')
    assert.equal(error.fallback, 'lexical')
    return true
  })
  assert.deepEqual(children[0].events, ['stdin.end', 'kill'])
  assert.deepEqual(manager.status(), { running: 0, booting: 0, closed: false, tripped: 0 })
  manager.close()
})

test('healthy boots never count toward the fuse while an unexpected exit does', async () => {
  const { spawnImpl, calls, children } = fakeSpawn()
  const manager = makeManager({ spawnImpl, maxRestarts: 1, restartWindowMs: 60_000 })
  const first = manager.acquire(PROFILE)
  push(children[0], readyLine())
  assert.equal((await first).model, MODEL)
  const second = manager.acquire({ ...PROFILE, fingerprint: '1'.repeat(64) })
  push(children[1], readyLine())
  assert.equal((await second).model, MODEL)
  assert.deepEqual(manager.status(), { running: 2, booting: 0, closed: false, tripped: 0 })
  assert.equal(calls.length, 2)
  // An exit the manager did not ask for is counted, so that profile is fused.
  exitChild(children[0], 1)
  assert.equal(manager.status().tripped, 1)
  await assert.rejects(manager.acquire(PROFILE), error => error.code === 'LOCAL_VECTOR_RESTART_FUSED')
  assert.equal(manager.status().running, 1, 'the other profile keeps its worker')
  assert.equal(calls.length, 2)
  manager.close()
})

test('failed boots trip the fuse, block respawns, and the cooldown releases it', async () => {
  let clock = 7_000_000
  const log = captureLogger()
  const { spawnImpl, calls, children } = fakeSpawn()
  const manager = makeManager({ spawnImpl, logger: log.logger, now: () => clock, maxRestarts: 2, restartWindowMs: 60_000 })
  for (const index of [0, 1]) {
    const pending = manager.acquire(PROFILE)
    push(children[index], readyLine({ model: 'some-other-model@r1+mean' }))
    await assert.rejects(pending, error => error.code === 'LOCAL_VECTOR_BAD_READY')
    clock += 1_000
  }
  assert.equal(calls.length, 2)
  await assert.rejects(manager.acquire(PROFILE), error => {
    assert.equal(error.code, 'LOCAL_VECTOR_RESTART_FUSED')
    assert.equal(error.fallback, 'lexical')
    return true
  })
  assert.equal(calls.length, 2, 'a fused profile must not spawn again')
  assert.deepEqual(manager.status(), { running: 0, booting: 0, closed: false, tripped: 1 })
  // The fuse is per profile: another fingerprint still boots.
  const otherProfile = manager.acquire({ ...PROFILE, fingerprint: 'a'.repeat(64) })
  push(children[2], readyLine())
  assert.equal((await otherProfile).model, MODEL)
  assert.equal(manager.status().tripped, 1)
  // After the window the same profile is allowed one more attempt.
  clock += 61_000
  assert.equal(manager.status().tripped, 0)
  const retry = manager.acquire(PROFILE)
  push(children[3], readyLine())
  assert.equal((await retry).model, MODEL)
  assert.equal(manager.status().running, 2)
  manager.close()
})

test('an unexpected exit after ready is warned about and the next acquire starts a new child', async () => {
  const log = captureLogger()
  const { spawnImpl, children } = fakeSpawn()
  const manager = makeManager({ spawnImpl, logger: log.logger })
  const pending = manager.acquire(PROFILE)
  push(children[0], readyLine())
  const endpoint = await pending
  exitChild(children[0], 1)
  assert.equal(manager.status().running, 0)
  assert.ok(log.lines.some(line => line.startsWith('warn:') && line.includes('exited')), 'an exit must stay observable')
  const again = manager.acquire(PROFILE)
  push(children[1], readyLine({ baseUrl: 'http://127.0.0.1:45124/v1', url: 'http://127.0.0.1:45124/v1/embeddings' }))
  const next = await again
  assert.notEqual(next.token, endpoint.token)
  assert.notEqual(next.baseUrl, endpoint.baseUrl)
  manager.close()
})

test('close rejects an in-flight acquire promptly instead of waiting for the child', async () => {
  const log = captureLogger()
  const { spawnImpl, calls, children } = fakeSpawn()
  const manager = makeManager({ spawnImpl, logger: log.logger, timeoutMs: 120_000 })
  const pending = manager.acquire(PROFILE)
  assert.equal(manager.close(), 1)
  await assert.rejects(pending, error => {
    assert.equal(error.code, 'LOCAL_VECTOR_MANAGER_CLOSED')
    assert.equal(error.fallback, 'lexical')
    return true
  })
  assert.deepEqual(children[0].events, ['stdin.end', 'kill'])
  // The late exit of the child we killed is not a crash and is not reported.
  exitChild(children[0], 0)
  await tick()
  assert.deepEqual(log.lines, [])
  assert.equal(manager.status().closed, true)
  assert.equal(manager.close(), 0, 'close is idempotent')
  await assert.rejects(manager.acquire(PROFILE), error => error.code === 'LOCAL_VECTOR_MANAGER_CLOSED')
  assert.equal(calls.length, 1, 'a closed manager never spawns')
})

test('an EPIPE on the worker pipes degrades recall instead of crashing the host', async () => {
  const { spawnImpl, children } = fakeSpawn()
  const manager = makeManager({ spawnImpl })
  const pending = manager.acquire(PROFILE)
  const child = children[0]
  const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -4047 })
  // The child died; its pipes now emit 'error'. Without a listener this is an
  // uncaught exception in this very process.
  assert.doesNotThrow(() => child.stdin.emit('error', epipe))
  assert.doesNotThrow(() => child.stdout.emit('error', epipe))
  assert.doesNotThrow(() => child.stderr.emit('error', epipe))
  exitChild(child, 1)
  await assert.rejects(pending, error => error.code === 'LOCAL_VECTOR_WORKER_EXITED')
  assert.doesNotThrow(() => manager.close())
  assert.doesNotThrow(() => manager.close())
})

test('ambient proxies and remote credentials never reach the worker', async () => {
  const ambient = {
    HTTP_PROXY: 'http://127.0.0.1:7890',
    https_proxy: 'http://127.0.0.1:7890',
    ALL_PROXY: 'socks5://127.0.0.1:7890',
    NO_PROXY: 'localhost',
    MEMU_HTTP_PROXY: 'http://127.0.0.1:1',
    MEMU_API_KEY: 'ambient-memu-key',
    MEMU_BASE_URL: 'https://api.example.invalid/v1',
    MEMU_EMBED_PROVIDER: 'openai',
    OPENAI_API_KEY: 'ambient-openai-key',
    DSH_MEMU_EMBED_TOKEN: 'stale-token',
    DSH_MEMU_EMBED_MODEL_DIR: 'D:/stale/model',
    GOOGLE_APPLICATION_CREDENTIALS: 'C:/stale.json',
  }
  const saved = new Map()
  for (const [name, value] of Object.entries(ambient)) {
    saved.set(name, process.env[name])
    process.env[name] = value
  }
  try {
    const { spawnImpl, children } = fakeSpawn()
    const manager = makeManager({ spawnImpl })
    const pending = manager.acquire(PROFILE)
    push(children[0], readyLine())
    const endpoint = await pending
    const env = children[0].options.env
    for (const name of ['HTTP_PROXY', 'https_proxy', 'ALL_PROXY', 'NO_PROXY', 'MEMU_HTTP_PROXY', 'MEMU_API_KEY', 'MEMU_BASE_URL', 'MEMU_EMBED_PROVIDER', 'OPENAI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS']) {
      assert.equal(env[name], undefined, name + ' must not be inherited')
    }
    assert.equal(env.DSH_MEMU_EMBED_TOKEN, endpoint.token, 'the inherited token is replaced')
    assert.equal(env.DSH_MEMU_EMBED_MODEL_DIR, PROFILE.modelDir, 'the inherited model directory is replaced')
    for (const name of Object.keys(env)) {
      assert.ok(!/proxy/i.test(name), name + ' must not look like a proxy setting')
      assert.ok(!/_api_key$/i.test(name), name + ' must not carry a remote credential')
    }
    assert.equal(env.MEMU_TELEMETRY, '0')
    assert.equal(env.DO_NOT_TRACK, '1')
    assert.equal(env.MEMU_EVENTS_BASE_URL, '')
    manager.close()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('a profile that cannot work is refused before any child is spawned', async () => {
  const { spawnImpl, calls } = fakeSpawn()
  const { spawnImpl: noSpawn, calls: noCalls } = fakeSpawn()
  const manager = makeManager({ spawnImpl })
  await assert.rejects(manager.acquire({ ...PROFILE, modelDir: '' }), error => error.code === 'LOCAL_VECTOR_RUNTIME_UNAVAILABLE')
  await assert.rejects(manager.acquire({ ...PROFILE, runtimeDir: null }), error => error.code === 'LOCAL_VECTOR_RUNTIME_UNAVAILABLE')
  await assert.rejects(manager.acquire({ ...PROFILE, manifest: {} }), error => error.code === 'LOCAL_VECTOR_MANIFEST_INCOMPLETE')
  await assert.rejects(manager.acquire({ ...PROFILE, dimension: 0 }), error => error.code === 'LOCAL_VECTOR_MANIFEST_INCOMPLETE')
  assert.equal(calls.length, 0)
  assert.deepEqual(manager.status(), { running: 0, booting: 0, closed: false, tripped: 0 })
  const rejecting = makeManager({
    spawnImpl: noSpawn,
    verifyProfile: () => { throw Object.assign(new Error('profile needs repair'), { code: 'VECTOR_PROFILE_UNVERIFIED' }) },
  })
  await assert.rejects(rejecting.acquire(PROFILE), error => error.code === 'VECTOR_PROFILE_UNVERIFIED')
  assert.equal(noCalls.length, 0, 'an unverified profile never starts a worker')
  rejecting.close()
})

test('a spawn failure is a typed, observable failure rather than a hang', async () => {
  const manager = makeManager({
    spawnImpl: () => { throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) },
    maxRestarts: 1,
  })
  await assert.rejects(manager.acquire(PROFILE), error => {
    assert.equal(error.code, 'LOCAL_VECTOR_SPAWN_FAILED')
    assert.equal(error.fallback, 'lexical')
    return true
  })
  assert.deepEqual(manager.status(), { running: 0, booting: 0, closed: false, tripped: 1 }, 'a failed boot counts toward the fuse')
  await assert.rejects(manager.acquire(PROFILE), error => error.code === 'LOCAL_VECTOR_RESTART_FUSED')
  manager.close()
})

test('the process-wide manager can be disposed and rebuilt from the plugin lifecycle', () => {
  const first = embeddingWorkerManager()
  assert.equal(embeddingWorkerManager(), first, 'the singleton is stable')
  closeEmbeddingWorkers()
  assert.equal(first.status().closed, true)
  const second = embeddingWorkerManager()
  assert.notEqual(second, first)
  assert.deepEqual(second.status(), { running: 0, booting: 0, closed: false, tripped: 0 })
  closeEmbeddingWorkers()
  assert.doesNotThrow(() => closeEmbeddingWorkers(), 'disposal is idempotent')
})

test('a real child process serves the ready line and does not outlive the manager', async () => {
  const spawned = []
  const script = [
    'const line = JSON.stringify(' + JSON.stringify(readyLine()) + ')',
    'process.stdout.write(line + String.fromCharCode(10))',
    'const bye = () => process.exit(0)',
    "process.stdin.on('end', bye)",
    "process.stdin.on('close', bye)",
    'process.stdin.resume()',
    'setInterval(() => {}, 1000)',
  ].join(String.fromCharCode(10))
  const spawnImpl = (command, args, options) => {
    const child = spawnReal(process.execPath, ['-e', script], options)
    spawned.push(child)
    return child
  }
  const manager = makeManager({ spawnImpl, timeoutMs: 15_000 })
  try {
    const endpoint = await manager.acquire(PROFILE)
    assert.equal(endpoint.baseUrl, 'http://127.0.0.1:45123/v1')
    assert.match(endpoint.token, TOKEN_PATTERN)
    let guard = null
    const exited = new Promise(resolve => spawned[0].once('exit', () => resolve(true)))
    manager.close()
    const deadline = new Promise(resolve => { guard = setTimeout(() => resolve(false), 10_000) })
    const finished = await Promise.race([exited, deadline])
    clearTimeout(guard)
    assert.equal(finished, true, 'the worker child must not survive its manager')
  } finally {
    manager.close()
    for (const child of spawned) {
      try { child.kill() } catch {}
    }
  }
})
