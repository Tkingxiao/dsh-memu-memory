import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { zipSync, unzipSync } from 'fflate'

// W4: every browser-facing entry of this plugin goes through one handler mounted
// twice (current and legacy prefix). The tests below drive each registered route
// separately and prove that a 401/403 is decided before body parsing, index or
// attachment reads, state writes, and imports.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-webui-auth-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const { registerRpc } = await import('../lib/rpc.js')
const { standaloneHtml, standaloneAsset } = await import('../lib/webui.js')

test.after(() => { state.flushState(); fs.rmSync(home, { recursive: true, force: true }) })

const html = standaloneHtml()
const clientJs = standaloneAsset('/dsh-memu-memory/ui-assets/client.js')
const iconPng = standaloneAsset('/dsh-memu-memory/ui-assets/icon.png')

const routeSpecs = []
// callbackMode: 'present' | 'throw' | 'absent' — 'absent' models a host that
// does not implement authorizeLibrary at all (typeof check must fail).
const auth = { decision: undefined, calls: 0, libraryDecision: true, libraryCalls: 0, libraryRequests: [], callbackMode: 'present' }
registerRpc({
  inject: (_deps, build) => build({
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    webServer: { register: (spec) => { routeSpecs.push(spec); return () => {} } },
    connection: {
      requestRejection: () => { auth.calls += 1; return auth.decision },
      get authorizeLibrary() {
        if (auth.callbackMode === 'absent') return undefined
        return async (req, details) => {
          auth.libraryCalls += 1
          auth.libraryRequests.push({ req, ...details })
          if (auth.callbackMode === 'throw') throw new Error('host authorization unavailable')
          return auth.libraryDecision
        }
      },
    },
    logger: {},
  }),
})
assert.deepEqual(routeSpecs.map((spec) => spec.path), ['/dsh-memu-memory', '/dsh-memu'])
assert.equal(typeof routeSpecs[0].handler, 'function')
assert.equal(typeof routeSpecs[1].handler, 'function')
const prefixes = [
  { name: 'formal', route: routeSpecs[0], base: '/dsh-memu-memory' },
  { name: 'legacy', route: routeSpecs[1], base: '/dsh-memu' },
]

const homeRoot = path.resolve(home)
const probe = { active: false, reads: [], writes: [] }
const originals = new Map()
function inHome(file) {
  if (typeof file !== 'string') return false
  const resolved = path.resolve(file)
  return resolved === homeRoot || resolved.startsWith(homeRoot + path.sep)
}
function relative(file) { return path.relative(homeRoot, path.resolve(file)).replace(/\\/g, '/') }
function wrap(name, mode) {
  const original = fs[name]
  originals.set(name, original)
  fs[name] = function (file, ...args) {
    if (probe.active && inHome(file)) (mode === 'write' ? probe.writes : probe.reads).push(relative(file))
    return original.call(this, file, ...args)
  }
}
for (const name of ['readFileSync', 'readdirSync', 'existsSync', 'statSync', 'lstatSync', 'createReadStream']) wrap(name, 'read')
for (const name of ['writeFileSync', 'appendFileSync', 'renameSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'copyFileSync']) wrap(name, 'write')
{
  const openSync = fs.openSync
  originals.set('openSync', openSync)
  fs.openSync = function (file, flags, ...args) {
    if (probe.active && inHome(file)) {
      const text = typeof flags === 'string' ? flags : 'r'
      const write = /[wa+]/.test(text)
      ;(write ? probe.writes : probe.reads).push(relative(file))
    }
    return openSync.call(this, file, flags, ...args)
  }
}
function resetProbe() { probe.reads.length = 0; probe.writes.length = 0 }

function makeResponse() {
  const chunks = []
  let finish
  const done = new Promise((resolve, reject) => {
    finish = resolve
    const timer = setTimeout(() => reject(new Error('response did not end')), 3000)
    timer.unref?.()
  })
  return {
    status: 0,
    headers: {},
    destroyed: false,
    done,
    writeHead(code, headers) { this.status = code; this.headers = headers || {}; return this },
    write(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); return true },
    end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); finish() },
    destroy(error) { this.destroyed = true; this.error = error; finish() },
    get buffer() { return Buffer.concat(chunks) },
    get text() { return Buffer.concat(chunks).toString('utf8') },
  }
}

async function send(route, url, { method = 'GET', body, rejection, poison = false } = {}) {
  auth.decision = rejection
  auth.calls = 0
  resetProbe()
  probe.active = true
  const pulls = []
  const req = {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      pulls.push(auth.calls)
      if (poison) throw new Error('the body was read before authentication')
      if (body !== undefined) yield Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    },
  }
  const res = makeResponse()
  try {
    await route.handler(req, res)
    await res.done
  } finally {
    probe.active = false
  }
  return { res, pulls, authCalls: auth.calls, reads: [...probe.reads], writes: [...probe.writes] }
}

function envelope(method, payload = {}, rpcId = 'auth-test') {
  return { type: 'client-request', rpcId, method, payload }
}

function assertRejected(result, code) {
  assert.equal(result.res.status, code)
  assert.equal(result.res.text, code === 401 ? 'unauthorized' : 'forbidden')
  assert.equal(result.pulls.length, 0, 'request body must not be iterated before requestRejection')
  assert.equal(result.authCalls, 1, 'requestRejection must run exactly once')
  assert.deepEqual(result.reads, [], 'rejected request must not read anything under DSH_MEMU_HOME')
  assert.deepEqual(result.writes, [], 'rejected request must not write anything under DSH_MEMU_HOME')
}

function snapshotTree(root) {
  const files = {}
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(root, full).replace(/\\/g, '/')
      if (entry.isDirectory()) { files[rel + '/'] = true; walk(full) }
      else { const data = fs.readFileSync(full); files[rel] = data.length + ':' + crypto.createHash('sha256').update(data).digest('hex') }
    }
  }
  walk(root)
  return files
}

const SENTINEL = 'AUTH-SENTINEL-7f3c2a'
const IMPORT_SENTINEL = 'IMPORT-SENTINEL-91b0d4'
const RPC_IMPORT_SENTINEL = 'RPC-IMPORT-SENTINEL-4c8e11'

const library = state.createLibrary({ name: 'auth-matrix', cwd: path.join(home, 'auth-matrix') })
const sessionId = 'auth-session'
state.setSessionBinding(sessionId, { libraryId: library.id, useLibrary: true, scopeKey: library.scopeKey })
state.updatePrivateIndex(library.id, (index) => {
  index.entries['mem-auth-sentinel'] = {
    title: 'auth sentinel', content: SENTINEL, status: 'active', layer: 'long_term',
    visibility: 'shared', disclosure: 'can_tell', source: 'user_said',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
})
state.flushState()

test('UI and assets: both registered prefixes authorize, and 401/403 never serve or read', async () => {
  const cases = [
    { route: '/ui', expected: html, type: /text\/html/ },
    { route: '/settings', expected: html, type: /text\/html/ },
    { route: '/ui-assets/client.js', expected: clientJs, type: /javascript/ },
    { route: '/ui-assets/icon.png', expected: iconPng, type: /image\/png/ },
  ]
  for (const prefix of prefixes) {
    for (const item of cases) {
      const url = prefix.base + item.route
      const allowed = await send(prefix.route, url)
      assert.equal(allowed.res.status, 200, prefix.name + ' ' + item.route)
      assert.match(allowed.res.headers['Content-Type'], item.type)
      assert.deepEqual(allowed.res.buffer, Buffer.from(item.expected))
      for (const code of [401, 403]) {
        assertRejected(await send(prefix.route, url, { rejection: code }), code)
      }
    }
  }
})

test('POST RPC: requestRejection runs before body parsing and before any write', async () => {
  for (const prefix of prefixes) {
    for (const code of [401, 403]) {
      state.flushState()
      const baseline = snapshotTree(home)
      const name = 'denied-' + prefix.name + '-' + code
      const result = await send(prefix.route, prefix.base + '/createLibrary', {
        method: 'POST', poison: true, rejection: code,
        body: envelope('createLibrary', { name, cwd: path.join(home, name) }),
      })
      assertRejected(result, code)
      assert.equal(state.listLibraries().some((item) => item.name === name), false)
      assert.deepEqual(snapshotTree(home), baseline, 'a rejected createLibrary must not touch state.json')
    }
    const name = 'allowed-' + prefix.name
    const result = await send(prefix.route, prefix.base + '/createLibrary', {
      method: 'POST', body: envelope('createLibrary', { name, cwd: path.join(home, name) }),
    })
    assert.equal(result.res.status, 200)
    const json = JSON.parse(result.res.text)
    assert.equal(json.result.ok, true)
    assert.equal(json.result.value.name, name)
    assert.equal(result.authCalls, 1)
    assert.equal(result.pulls.length, 1)
    assert.equal(result.pulls[0], 1, 'authorized body iteration must happen after requestRejection')
    assert.ok(result.writes.length > 0, 'authorized createLibrary must write the library')
  }
})

test('GET-side RPC reads: 401/403 return before the private index is read', async () => {
  const urlFor = (prefix) => prefix.base + '/getMemory'
  for (const prefix of prefixes) {
    for (const code of [401, 403]) {
      state.flushState()
      state.clearCaches()
      const baseline = snapshotTree(home)
      const denied = await send(prefix.route, urlFor(prefix), {
        method: 'POST', poison: true, rejection: code,
        body: envelope('getMemory', { libraryId: library.id, id: 'mem-auth-sentinel' }),
      })
      assertRejected(denied, code)
      assert.equal(denied.res.text.includes(SENTINEL), false)
      assert.deepEqual(snapshotTree(home), baseline)
    }
    state.flushState()
    state.clearCaches()
    const allowed = await send(prefix.route, urlFor(prefix), {
      method: 'POST', body: envelope('getMemory', { libraryId: library.id, id: 'mem-auth-sentinel' }),
    })
    assert.equal(allowed.res.status, 200)
    assert.match(allowed.res.text, new RegExp(SENTINEL))
    assert.ok(allowed.reads.length > 0, 'authorized getMemory must read the private index from disk')
    assert.equal(allowed.pulls[0], 1)
  }
})

test('library authorization: session A cannot address library B, and standalone callback fails closed', async () => {
  const other = state.createLibrary({ name: 'auth-other', cwd: path.join(home, 'auth-other') })
  state.setSessionBinding('auth-session-other', { libraryId: other.id, useLibrary: true, scopeKey: other.scopeKey })
  for (const prefix of prefixes) {
    auth.callbackMode = 'present'
    auth.libraryDecision = true
    auth.libraryCalls = 0
    auth.libraryRequests.length = 0
    const cross = await send(prefix.route, prefix.base + '/getMemory', {
      method: 'POST',
      body: envelope('getMemory', { libraryId: other.id, sessionId, id: 'mem-auth-sentinel' }),
    })
    assert.equal(cross.res.status, 403)
    assert.equal(cross.res.text, JSON.stringify({ ok: false, error: { code: 'dsh-memu-memory/forbidden', message: 'forbidden', details: {} } }))
    assert.equal(cross.pulls.length, 1, 'JSON body may be parsed before route authorization')
    assert.equal(auth.libraryCalls, 0, 'bound sessions must not fall back to host callback')
    assert.deepEqual(cross.reads, [])
    assert.deepEqual(cross.writes, [])

    auth.libraryDecision = false
    auth.libraryCalls = 0
    const denied = await send(prefix.route, prefix.base + '/getMemory', {
      method: 'POST',
      body: envelope('getMemory', { libraryId: other.id }),
    })
    assert.equal(denied.res.status, 403)
    assert.equal(auth.libraryCalls, 1)
    assert.equal(denied.reads.length, 0)
    assert.equal(denied.writes.length, 0)

    auth.libraryDecision = true
    auth.callbackMode = 'throw'
    auth.libraryCalls = 0
    const thrown = await send(prefix.route, prefix.base + '/getMemory', {
      method: 'POST', poison: false,
      body: envelope('getMemory', { libraryId: other.id }),
    })
    assert.equal(thrown.res.status, 403)
    assert.equal(auth.libraryCalls, 1)
    assert.equal(thrown.reads.length, 0)
    assert.equal(thrown.writes.length, 0)

    auth.callbackMode = 'present'
    auth.libraryDecision = true
  }
})

test('attachment thumbnails: 401/403 precede authorization and attachment-pool reads', async () => {
  const attachmentLibrary = state.createLibrary({ name: 'auth-attachment', cwd: path.join(home, 'auth-attachment') })
  const attachmentSession = 'auth-attachment-session'
  state.setSessionBinding(attachmentSession, { libraryId: attachmentLibrary.id, useLibrary: true, scopeKey: attachmentLibrary.scopeKey })
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } }).png().toBuffer()
  const sha = crypto.createHash('sha256').update(png).digest('hex')
  const blobPath = path.join(home, 'attachments', attachmentLibrary.id, sha + '.png')
  fs.mkdirSync(path.dirname(blobPath), { recursive: true })
  fs.writeFileSync(blobPath, png)
  const poolPath = path.join(home, 'index', attachmentLibrary.id + '.media.json')
  const pool = {
    version: 1,
    blobs: { [sha]: { sha256: sha, bytes: png.length, ext: 'png', mime: 'image/png', w: 8, h: 8, useCount: 1, refs: [], missing: false, captionBy: 'none' } },
    totals: { bytes: png.length, count: 1 },
  }
  fs.writeFileSync(poolPath, JSON.stringify(pool))
  state.updatePrivateIndex(attachmentLibrary.id, (index) => {
    index.entries['mem-auth-image'] = {
      title: 'auth image', content: 'attachment sentinel ' + SENTINEL, status: 'active', layer: 'long_term',
      visibility: 'shared', disclosure: 'can_tell', source: 'user_said',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      attachments: [{ sha256: sha, name: 'auth.png', mediaType: 'image/png', bytes: png.length }],
    }
  })
  state.flushState()
  const url = (prefix) => prefix.base + '/attachment/' + encodeURIComponent(attachmentLibrary.id) + '/' + sha + '?sessionId=' + encodeURIComponent(attachmentSession)
  for (const prefix of prefixes) {
    state.flushState()
    state.clearCaches()
    const allowed = await send(prefix.route, url(prefix))
    assert.equal(allowed.res.status, 200)
    assert.match(allowed.res.headers['Content-Type'], /image\/webp/)
    assert.ok(allowed.res.buffer.length > 0)
    assert.ok(allowed.reads.some((item) => item.endsWith('.media.json')), 'authorized thumbnail reads the media pool')
  }
  for (const prefix of prefixes) {
    for (const code of [401, 403]) {
      state.flushState()
      state.clearCaches()
      const baseline = snapshotTree(home)
      const denied = await send(prefix.route, url(prefix), { rejection: code })
      assertRejected(denied, code)
      assert.equal(denied.res.text.includes('attachment unavailable'), false)
      assert.deepEqual(snapshotTree(home), baseline)
    }
  }
  for (const prefix of prefixes) {
    const rpcPayload = { libraryId: attachmentLibrary.id, sha256: sha, sessionId: attachmentSession }
    for (const code of [401, 403]) {
      state.flushState()
      state.clearCaches()
      const baseline = snapshotTree(home)
      const denied = await send(prefix.route, prefix.base + '/getAttachment', {
        method: 'POST', poison: true, rejection: code, body: envelope('getAttachment', rpcPayload),
      })
      assertRejected(denied, code)
      assert.equal(denied.res.text.includes(sha), false)
      assert.deepEqual(snapshotTree(home), baseline)
    }
    state.flushState()
    state.clearCaches()
    const allowed = await send(prefix.route, prefix.base + '/getAttachment', {
      method: 'POST', body: envelope('getAttachment', rpcPayload),
    })
    assert.equal(allowed.res.status, 200)
    const json = JSON.parse(allowed.res.text)
    assert.equal(json.result.ok, true)
    assert.equal(json.result.value.sha256, sha)
    assert.equal(allowed.pulls[0], 1)
  }
  // Tripwire: a corrupt pool makes an authorized thumbnail fail inside the media
  // path, so a 401/403 instead of that failure proves rejection happened first.
  fs.writeFileSync(poolPath, '{not valid json')
  for (const prefix of prefixes) {
    state.flushState()
    state.clearCaches()
    const tripwire = await send(prefix.route, url(prefix))
    assert.equal(tripwire.res.status, 503)
    assert.equal(tripwire.res.text, 'attachment unavailable')
    for (const code of [401, 403]) {
      const denied = await send(prefix.route, url(prefix), { rejection: code })
      assertRejected(denied, code)
    }
  }
  fs.writeFileSync(poolPath, JSON.stringify(pool))
})

test('export ZIP: 401/403 precede export dispatch, index reads and ZIP construction', async () => {
  for (const prefix of prefixes) {
    for (const code of [401, 403]) {
      state.flushState()
      state.clearCaches()
      const baseline = snapshotTree(home)
      const denied = await send(prefix.route, prefix.base + '/export/' + library.id + '.zip', { rejection: code })
      assertRejected(denied, code)
      assert.equal(denied.res.text.includes(SENTINEL), false)
      assert.equal(denied.res.text.startsWith('PK'), false)
      assert.deepEqual(snapshotTree(home), baseline)
    }
    state.flushState()
    state.clearCaches()
    const allowed = await send(prefix.route, prefix.base + '/export/' + library.id + '.zip')
    assert.equal(allowed.res.status, 200)
    assert.match(allowed.res.headers['Content-Type'], /application\/zip/)
    assert.equal(allowed.res.buffer.subarray(0, 2).toString('utf8'), 'PK')
    const files = unzipSync(new Uint8Array(allowed.res.buffer))
    assert.ok(files['memories.json'])
    const exported = JSON.parse(Buffer.from(files['memories.json']).toString('utf8'))
    assert.ok(exported.memories.some((item) => String(item.content).includes(SENTINEL)))
    assert.ok(allowed.reads.length > 0, 'authorized export reads the private index')
    const rpcUrl = prefix.base + '/exportLibrary'
    const rpcPayload = { libraryId: library.id, includeAttachments: true }
    for (const code of [401, 403]) {
      state.flushState()
      state.clearCaches()
      const baseline = snapshotTree(home)
      const denied = await send(prefix.route, rpcUrl, {
        method: 'POST', poison: true, rejection: code, body: envelope('exportLibrary', rpcPayload),
      })
      assertRejected(denied, code)
      assert.equal(denied.res.text.includes(SENTINEL), false)
      assert.deepEqual(snapshotTree(home), baseline)
    }
    state.flushState()
    state.clearCaches()
    const rpcAllowed = await send(prefix.route, rpcUrl, {
      method: 'POST', body: envelope('exportLibrary', rpcPayload),
    })
    assert.equal(rpcAllowed.res.status, 200)
    const rpcJson = JSON.parse(rpcAllowed.res.text)
    assert.equal(rpcJson.result.ok, true)
    const rpcZip = unzipSync(new Uint8Array(Buffer.from(rpcJson.result.value.base64, 'base64')))
    const rpcExported = JSON.parse(Buffer.from(rpcZip['memories.json']).toString('utf8'))
    assert.ok(rpcExported.memories.some((item) => String(item.content).includes(SENTINEL)))
    assert.equal(rpcAllowed.pulls[0], 1)
  }
})

test('import ZIP: 401/403 precede body reads, staging and library writes', async () => {
  const destinations = {}
  for (const prefix of prefixes) destinations[prefix.name] = state.createLibrary({ name: 'auth-import-' + prefix.name, cwd: path.join(home, 'auth-import-' + prefix.name) })
  const archive = Buffer.from(zipSync({
    'memories.json': Buffer.from(JSON.stringify({ format: 'dsh-memu-memory-library@1', memories: [{ id: 'mem-imported', title: 'imported', content: IMPORT_SENTINEL, layer: 'long_term', status: 'active' }] })),
    'manifest.json': Buffer.from(JSON.stringify({ format: 'dsh-memu-memory-media@1', blobs: {} })),
  }))
  for (const prefix of prefixes) {
    const destination = destinations[prefix.name]
    const importUrl = prefix.base + '/import/' + destination.id + '.zip'
    for (const code of [401, 403]) {
      state.flushState()
      state.clearCaches()
      const baseline = snapshotTree(home)
      const denied = await send(prefix.route, importUrl, { method: 'POST', body: archive, poison: true, rejection: code })
      assertRejected(denied, code)
      assert.equal(JSON.stringify(state.loadPrivateIndex(destination.id)).includes(IMPORT_SENTINEL), false)
      assert.deepEqual(snapshotTree(home), baseline, 'a rejected import must not create staging files or touch the library')
    }
    state.flushState()
    state.clearCaches()
    const allowed = await send(prefix.route, importUrl, { method: 'POST', body: archive })
    assert.equal(allowed.res.status, 200)
    assert.equal(JSON.parse(allowed.res.text).ok, true)
    assert.equal(allowed.pulls[0], 1, 'authorized ZIP body is consumed after requestRejection')
    assert.ok(allowed.writes.length > 0, 'authorized import writes the library')
    assert.equal(JSON.stringify(state.loadPrivateIndex(destination.id)).includes(IMPORT_SENTINEL), true)
  }
})

test('importMemories RPC: 401/403 precede JSON parsing and import writes', async () => {
  const destinations = {}
  for (const prefix of prefixes) destinations[prefix.name] = state.createLibrary({ name: 'auth-rpc-import-' + prefix.name, cwd: path.join(home, 'auth-rpc-import-' + prefix.name) })
  for (const prefix of prefixes) {
    const destination = destinations[prefix.name]
    const payload = { libraryId: destination.id, memories: [{ content: RPC_IMPORT_SENTINEL, title: 'rpc imported' }] }
    for (const code of [401, 403]) {
      state.flushState()
      state.clearCaches()
      const baseline = snapshotTree(home)
      const denied = await send(prefix.route, prefix.base + '/importMemories', {
        method: 'POST', poison: true, rejection: code, body: envelope('importMemories', payload),
      })
      assertRejected(denied, code)
      assert.equal(JSON.stringify(state.loadPrivateIndex(destination.id)).includes(RPC_IMPORT_SENTINEL), false)
      assert.deepEqual(snapshotTree(home), baseline)
    }
    state.flushState()
    state.clearCaches()
    const allowed = await send(prefix.route, prefix.base + '/importMemories', {
      method: 'POST', body: envelope('importMemories', payload),
    })
    assert.equal(allowed.res.status, 200)
    const json = JSON.parse(allowed.res.text)
    assert.equal(json.result.ok, true)
    assert.equal(json.result.value.imported, 1)
    assert.equal(allowed.pulls[0], 1)
    assert.equal(JSON.stringify(state.loadPrivateIndex(destination.id)).includes(RPC_IMPORT_SENTINEL), true)
  }
})

test('unsupported methods still authenticate first: 401/403 before 405', async () => {
  for (const prefix of prefixes) {
    for (const code of [401, 403]) {
      assertRejected(await send(prefix.route, prefix.base + '/ui', { method: 'DELETE', rejection: code }), code)
      assertRejected(await send(prefix.route, prefix.base + '/listLibraries', { method: 'GET', rejection: code }), code)
    }
    assert.equal((await send(prefix.route, prefix.base + '/ui', { method: 'DELETE' })).res.status, 405)
    assert.equal((await send(prefix.route, prefix.base + '/listLibraries', { method: 'GET' })).res.status, 405)
  }
})

// §10 P0: one representative per audited operation category. The table drives
// every variant, so a new endpoint added to LIBRARY_ROUTE_OPERATIONS with the
// wrong operation (or none) fails here instead of shipping unverified.
const MATRIX_SHA = 'a'.repeat(64)
const matrixRows = [
  { endpoint: 'getMemory', operation: 'read', payload: (lib) => ({ libraryId: lib.id, id: 'mem-matrix-scratch' }) },
  { endpoint: 'browseWall', operation: 'read', payload: (lib) => ({ libraryId: lib.id }) },
  { endpoint: 'getStats', operation: 'read', payload: (lib) => ({ libraryId: lib.id }) },
  // 工单 F：实体合并的读写面。合并矩阵只验证路由授权：不存在的实体在 200
  // 业务信封里报 unknown entity，403 必须在 dispatch 之前发生。
  { endpoint: 'suggestEntityMerges', operation: 'read', payload: (lib) => ({ libraryId: lib.id }) },
  { endpoint: 'mergeEntities', operation: 'write', payload: (lib) => ({ libraryId: lib.id, targetId: 'ent-matrix-target', sourceIds: ['ent-matrix-source'] }) },
  { endpoint: 'addMemory', operation: 'write', payload: (lib) => ({ libraryId: lib.id, content: 'matrix write body' }) },
  { endpoint: 'updateMemory', operation: 'write', payload: (lib) => ({ libraryId: lib.id, id: 'mem-matrix-scratch', patch: { title: 'matrix retitled' } }) },
  { endpoint: 'archiveMemory', operation: 'archive', payload: (lib) => ({ libraryId: lib.id, id: 'mem-matrix-scratch' }) },
  { endpoint: 'deleteMemory', operation: 'delete', payload: (lib) => ({ libraryId: lib.id, id: 'mem-matrix-scratch' }) },
  { endpoint: 'renameLibrary', operation: 'rename', payload: (lib) => ({ libraryId: lib.id, name: 'matrix rename' }) },
  { endpoint: 'restoreLibrary', operation: 'restore', payload: (lib) => ({ libraryId: lib.id }) },
  { endpoint: 'importMemories', operation: 'import', payload: (lib) => ({ libraryId: lib.id, memories: [] }) },
  { endpoint: 'exportLibrary', operation: 'export', payload: (lib) => ({ libraryId: lib.id }) },
  { endpoint: 'getAttachment', operation: 'attachment.read', payload: (lib) => ({ libraryId: lib.id, sha256: MATRIX_SHA }) },
  { endpoint: 'listReviews', operation: 'read', payload: (lib) => ({ libraryId: lib.id }) },
  { endpoint: 'resolveReview', operation: 'write', payload: (lib) => ({ libraryId: lib.id, id: 'mem-matrix-scratch', action: 'reject' }) },
  { endpoint: 'lexiconList', operation: 'read', payload: (lib) => ({ libraryId: lib.id }) },
  { endpoint: 'lexiconAdd', operation: 'write', payload: (lib) => ({ libraryId: lib.id, term: 'matrix term', kind: 'term', meaning: 'matrix meaning' }) },
  // §2.3：lexiconReview 删除，lifecycle 变成 archive / restore 两个普通 write；
  // 授权模型不动（会话绑定优先、standalone 走 host callback）。
  { endpoint: 'lexiconArchive', operation: 'write', payload: (lib) => ({ libraryId: lib.id, termId: 'lex-matrix-scratch' }) },
  { endpoint: 'lexiconRestore', operation: 'write', payload: (lib) => ({ libraryId: lib.id, termId: 'lex-matrix-scratch' }) },
]

function seedMatrixScratch() {
  state.updatePrivateIndex(library.id, (index) => {
    index.entries['mem-matrix-scratch'] = {
      title: 'matrix scratch', content: 'matrix scratch body', status: 'active', layer: 'long_term',
      visibility: 'shared', disclosure: 'can_tell', source: 'user_said',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
  })
  state.flushState()
}

test('operation matrix: every library route denies A→B, allows A→A, and gates standalone on the host callback', async () => {
  const libB = state.createLibrary({ name: 'auth-matrix-b', cwd: path.join(home, 'auth-matrix-b') })
  for (const prefix of prefixes) {
    seedMatrixScratch()
    for (const row of matrixRows) {
      const post = (payload) => send(prefix.route, prefix.base + '/' + row.endpoint, { method: 'POST', body: envelope(row.endpoint, payload) })

      // Session A → library B: 403, the host callback is never consulted, and
      // the body (already parsed) is the only thing touched before the denial.
      auth.callbackMode = 'present'
      auth.libraryDecision = true
      auth.libraryCalls = 0
      const cross = await post({ ...row.payload(libB), sessionId })
      assert.equal(cross.res.status, 403, `${prefix.name} ${row.endpoint}: session A must not address library B`)
      assert.equal(cross.res.text, JSON.stringify({ ok: false, error: { code: 'dsh-memu-memory/forbidden', message: 'forbidden', details: {} } }))
      assert.equal(cross.pulls.length, 1, 'route authorization happens after the envelope parse')
      assert.equal(auth.libraryCalls, 0, `${row.endpoint}: a bound session must not fall back to the host callback`)

      // Session A → library A: past the route gate. Business errors, when the
      // payload is not worth making valid, still come back inside a 200.
      const own = await post({ ...row.payload(library), sessionId })
      assert.equal(own.res.status, 200, `${prefix.name} ${row.endpoint}: session A on its own library must pass the route gate`)
      assert.equal(auth.libraryCalls, 0)

      // Standalone (no session): exactly one authorizeLibrary call that carries
      // the audited operation and the target library; only strict true passes.
      auth.libraryRequests.length = 0
      auth.libraryDecision = true
      auth.libraryCalls = 0
      const granted = await post(row.payload(libB))
      assert.equal(granted.res.status, 200, `${prefix.name} ${row.endpoint}: host callback true must grant the standalone request`)
      assert.equal(auth.libraryCalls, 1)
      const request = auth.libraryRequests.at(-1)
      assert.equal(request.libraryId, libB.id, `${row.endpoint}: callback must see the target library`)
      assert.equal(request.operation, row.operation, `${row.endpoint}: callback must see the audited operation`)

      auth.libraryDecision = false
      auth.libraryCalls = 0
      const denied = await post(row.payload(libB))
      assert.equal(denied.res.status, 403, `${prefix.name} ${row.endpoint}: callback false must deny`)
      assert.equal(auth.libraryCalls, 1)

      auth.callbackMode = 'throw'
      auth.libraryDecision = true
      auth.libraryCalls = 0
      const thrown = await post(row.payload(libB))
      assert.equal(thrown.res.status, 403, `${prefix.name} ${row.endpoint}: a thrown callback must deny`)

      auth.callbackMode = 'absent'
      auth.libraryCalls = 0
      const absent = await post(row.payload(libB))
      assert.equal(absent.res.status, 200, `${prefix.name} ${row.endpoint}: a host without the callback falls back to the HTTP boundary (2026-11-01 flip)`)
      assert.equal(auth.libraryCalls, 0)
      auth.callbackMode = 'present'
    }
  }
})

// 全局词典（lib/lexicon.js 的 GLOBAL_LEXICON_ID）不是私有库：宿主不该被叫去授权一本
// 根本不存在的库，绑定中的会话也不该因为点名「全局」而不是自己的库就被判成越权。
// 会话侧仍要认凭证（会话存在 + 全局层没被天花板关掉）；standalone 与 listGlobal 一样
// 只由 HTTP 边界把关。
test('the global lexicon is a shared store, not a library route', async () => {
  const { GLOBAL_LEXICON_ID } = await import('../lib/lexicon.js')
  for (const prefix of prefixes) {
    const post = (payload) => send(prefix.route, prefix.base + '/lexiconList', { method: 'POST', body: envelope('lexiconList', payload) })
    auth.callbackMode = 'present'
    auth.libraryDecision = false
    auth.libraryCalls = 0
    const bound = await post({ libraryId: GLOBAL_LEXICON_ID, sessionId })
    assert.equal(bound.res.status, 200, `${prefix.name}: a bound session may address the global lexicon`)
    assert.equal(auth.libraryCalls, 0, `${prefix.name}: the host must not be asked about a library that does not exist`)
    const ghost = await post({ libraryId: GLOBAL_LEXICON_ID, sessionId: 'auth-session-ghost' })
    assert.equal(ghost.res.status, 403, `${prefix.name}: a dangling session id is never a credential`)
    state.setSessionBinding(sessionId, { useGlobal: false })
    const blocked = await post({ libraryId: GLOBAL_LEXICON_ID, sessionId })
    state.setSessionBinding(sessionId, { useGlobal: true })
    assert.equal(blocked.res.status, 403, `${prefix.name}: useGlobal=false means there is no global lexicon for that conversation`)
    auth.libraryDecision = false
    auth.libraryCalls = 0
    const solo = await post({ libraryId: GLOBAL_LEXICON_ID })
    assert.equal(solo.res.status, 200, `${prefix.name}: the management plane is governed by the HTTP boundary`)
    assert.equal(auth.libraryCalls, 0)
  }
})

test('removed lexiconReview is no longer a library route and does not dispatch', async () => {
  for (const prefix of prefixes) {
    auth.callbackMode = 'present'
    auth.libraryDecision = true
    auth.libraryCalls = 0
    const res = await send(prefix.route, prefix.base + '/lexiconReview', {
      method: 'POST',
      body: envelope('lexiconReview', { libraryId: library.id, termId: 'lex-matrix-scratch', action: 'approve' }),
    })
    assert.equal(res.res.status, 200, 'an unknown method is answered as a business error, not routed')
    assert.equal(auth.libraryCalls, 0, 'lexiconReview must not be authorized as a library route anymore')
    const json = JSON.parse(res.res.text)
    assert.equal(json.result.ok, false)
    assert.match(json.result.error.message, /unknown endpoint/)
  }
  // 401/403 仍然先于方法存在性：被拒的 review 请求连 dispatch 都到不了。
  for (const prefix of prefixes) {
    for (const code of [401, 403]) {
      assertRejected(await send(prefix.route, prefix.base + '/lexiconReview', {
        method: 'POST', poison: true, rejection: code,
        body: envelope('lexiconReview', { libraryId: library.id, termId: 'lex-matrix-scratch', action: 'approve' }),
      }), code)
    }
  }
})

test('session-bound resolution: write/archive without an explicit libraryId resolve from the persisted binding', async () => {
  const rows = [
    { endpoint: 'updateMemory', payload: (session) => ({ sessionId: session, id: 'mem-matrix-scratch', patch: { title: 'fallback retitled' } }) },
    { endpoint: 'archiveMemory', payload: (session) => ({ sessionId: session, id: 'mem-matrix-scratch' }) },
  ]
  for (const prefix of prefixes) {
    seedMatrixScratch()
    for (const row of rows) {
      const post = (payload) => send(prefix.route, prefix.base + '/' + row.endpoint, { method: 'POST', body: envelope(row.endpoint, payload) })
      auth.callbackMode = 'present'
      auth.libraryDecision = true
      auth.libraryCalls = 0
      const own = await post(row.payload(sessionId))
      assert.equal(own.res.status, 200, `${prefix.name} ${row.endpoint}: the bound session resolves its own library`)
      assert.equal(auth.libraryCalls, 0)
      for (const bad of ['', 'ghost-session', 42]) {
        const denied = await post(row.payload(bad))
        assert.equal(denied.res.status, 403, `${prefix.name} ${row.endpoint}: sessionId=${JSON.stringify(bad)} must not resolve to a target`)
        assert.equal(denied.res.text, JSON.stringify({ ok: false, error: { code: 'dsh-memu-memory/forbidden', message: 'forbidden', details: {} } }))
      }
    }
  }
})

test('global review queue: embedded sessions may read, writes need a live binding, standalone needs review.manage', async () => {
  const seedGlobalReview = () => {
    state.updateGlobalIndex((index) => {
      index.entries['mem-global-review'] = {
        title: 'global review', content: 'global pending body', status: 'pending_review', layer: 'long_term',
        domain: 'general', visibility: 'shared', disclosure: 'can_tell', source: 'inferred',
        reviewReason: 'matrix conflict', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }
    })
    state.flushState()
  }
  const post = (prefix, endpoint, payload) => send(prefix.route, prefix.base + '/' + endpoint, { method: 'POST', body: envelope(endpoint, payload) })

  for (const prefix of prefixes) {
    seedGlobalReview()
    auth.callbackMode = 'present'
    auth.libraryDecision = true
    auth.libraryCalls = 0

    // Embedded read: a well-formed session reads the global queue without any
    // host callback — the queue is conversation-visible by design.
    const read = await post(prefix, 'listReviews', { sessionId })
    assert.equal(read.res.status, 200)
    const readJson = JSON.parse(read.res.text)
    assert.equal(readJson.result.ok, true)
    assert.equal(readJson.result.value.scope, 'global')
    assert.ok(readJson.result.value.items.some((item) => item.id === 'mem-global-review'))
    assert.equal(auth.libraryCalls, 0, 'embedded reads never consult the host callback')

    // Embedded write: only a session whose binding still exists may resolve.
    const resolved = await post(prefix, 'resolveReview', { sessionId, id: 'mem-global-review', action: 'reject', resolution: 'replace' })
    assert.equal(resolved.res.status, 200)
    assert.equal(JSON.parse(resolved.res.text).result.ok, true)
    assert.equal(state.loadGlobalIndex().entries['mem-global-review'].status, 'archived')

    for (const bad of ['', 'ghost-session']) {
      seedGlobalReview()
      auth.libraryCalls = 0
      const denied = await post(prefix, 'resolveReview', { sessionId: bad, id: 'mem-global-review', action: 'reject' })
      assert.equal(denied.res.status, 403, `${prefix.name} resolveReview with sessionId=${JSON.stringify(bad)} must fail closed`)
      assert.equal(state.loadGlobalIndex().entries['mem-global-review'].status, 'pending_review', 'a denied review write must not touch the queue')
      const readDenied = await post(prefix, 'listReviews', { sessionId: bad })
      assert.equal(readDenied.res.status, 403, `${prefix.name} listReviews with sessionId=${JSON.stringify(bad)} must fail closed`)
    }

    // Standalone management plane: the global queue authorizes with
    // libraryId null and the dedicated review.manage operation, and a host
    // that does not implement it fails closed.
    const standalone = async (endpoint, payload) => {
      seedGlobalReview()
      auth.callbackMode = 'present'
      auth.libraryDecision = true
      auth.libraryCalls = 0
      auth.libraryRequests.length = 0
      const granted = await post(prefix, endpoint, payload)
      assert.equal(granted.res.status, 200, `${prefix.name} ${endpoint}: review.manage true must grant the standalone request`)
      assert.equal(auth.libraryCalls, 1)
      const request = auth.libraryRequests.at(-1)
      assert.equal(request.libraryId, null, 'the global queue authorizes with libraryId null')
      assert.equal(request.operation, 'review.manage')

      auth.libraryDecision = false
      auth.libraryCalls = 0
      assert.equal((await post(prefix, endpoint, payload)).res.status, 403, `${prefix.name} ${endpoint}: review.manage false must deny`)
      assert.equal(auth.libraryCalls, 1)

      auth.callbackMode = 'throw'
      auth.libraryDecision = true
      assert.equal((await post(prefix, endpoint, payload)).res.status, 403, `${prefix.name} ${endpoint}: a thrown callback must deny`)

      auth.callbackMode = 'absent'
      assert.equal((await post(prefix, endpoint, payload)).res.status, 200, `${prefix.name} ${endpoint}: a host without the callback falls back to the HTTP boundary (2026-11-01 flip)`)
      auth.callbackMode = 'present'
    }
    await standalone('listReviews', {})
    await standalone('resolveReview', { id: 'mem-global-review', action: 'reject' })

    // The private branch keeps its library checks: a bound session cannot
    // address another library's queue, and a granted standalone private read is
    // a plain library read, not review.manage.
    const privateLib = state.createLibrary({ name: 'auth-review-private', cwd: path.join(home, 'auth-review-private') })
    auth.libraryDecision = true
    assert.equal((await post(prefix, 'listReviews', { libraryId: privateLib.id, sessionId })).res.status, 403)
    assert.equal((await post(prefix, 'resolveReview', { libraryId: privateLib.id, sessionId, id: 'mem-global-review', action: 'reject' })).res.status, 403)
    auth.libraryRequests.length = 0
    auth.libraryCalls = 0
    const standalonePrivate = await post(prefix, 'listReviews', { libraryId: privateLib.id })
    assert.equal(standalonePrivate.res.status, 200)
    assert.equal(auth.libraryRequests.at(-1).operation, 'read', 'a private-queue read is a plain library read')
  }
})


// ---- 2026-11-01 现场（Unexpected token "forbidden" / Invalid RPC response: 403）----
// 无 libraryId 的 browseWall（"全部记忆库"视图）曾被硬拒 403：capability 缺席的宿主
// 上整个记忆墙挂掉。契约：无 libraryId 走同一 capability 模型——缺席回退放行、实现
// 了回调的宿主由 callback 决定；403 响应必须是 JSON 信封（standalone fetch 会
// response.json()，裸文本抛 SyntaxError）。

test('browseWall all-libraries view: absent capability allows, present callback decides, envelope on 403', async () => {
  state.updateSettings({ memoryBackend: 'agent', vectorSource: 'local' })
  const lib = state.createLibrary({ name: 'auth-wall-all', cwd: path.join(home, 'auth-wall-all') })
  state.updatePrivateIndex(lib.id, (index) => {
    index.entries['mem-wall-all'] = { title: 'wall all body', content: 'wall all body', status: 'active', layer: 'long_term', visibility: 'shared', disclosure: 'can_tell', source: 'user_said', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  })
  state.flushState()

  for (const prefix of prefixes) {
    // capability 缺席（当前版本宿主）：跨库视图放行——记忆墙的核心视图不能 403。
    auth.libraryCalls = 0
    const allowed = await send(prefix.route, prefix.base + '/browseWall', { method: 'POST', body: envelope('browseWall', { libraryId: '' }) })
    assert.equal(allowed.res.status, 200, `${prefix.name} browseWall(''): absent capability falls back to the HTTP boundary`)
    const payload = JSON.parse(allowed.res.text)
    assert.ok(payload.result.value.items.length >= 1, 'the wall returns entries across libraries')

    // 实现了 capability 的宿主：多库枚举由回调决定（deny → 403 JSON 信封）。
    auth.libraryDecision = false
    auth.libraryCalls = 0
    const denied = await send(prefix.route, prefix.base + '/browseWall', { method: 'POST', body: envelope('browseWall', { libraryId: '' }) })
    assert.equal(denied.res.status, 403, 'a host that implements the capability may deny the multi-library read')
    assert.equal(auth.libraryCalls, 1, 'present capability is consulted for the multi-library read')

    // 403 响应体必须是 JSON 信封：standalone fetch 客户端 response.json() 之后再读
    // error.message——裸 "forbidden" 在客户端抛 SyntaxError（现场事故）。
    assert.equal(denied.res.headers['content-type'] || denied.res.headers['Content-Type'], 'application/json')
    const parsed = JSON.parse(denied.res.text)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.error.code, 'dsh-memu-memory/forbidden')
    assert.equal(typeof parsed.error.message, 'string')
    auth.libraryDecision = true
  }
})

// standalone fetch 包装器：403 信封透传 error.message，而不是只报状态码
// （现场：Unexpected token "forbidden" → Invalid RPC response: 403，都看不到为什么）。
test('standalone rpc wrapper surfaces the server error message instead of the status code', () => {
  const client = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /envelope\.error\?\.message \|\| \('Invalid RPC response: ' \+ response\.status\)/)
})
