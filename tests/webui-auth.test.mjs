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
const auth = { decision: undefined, calls: 0 }
registerRpc({
  inject: (_deps, build) => build({
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    webServer: { register: (spec) => { routeSpecs.push(spec); return () => {} } },
    connection: { requestRejection: () => { auth.calls += 1; return auth.decision } },
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
