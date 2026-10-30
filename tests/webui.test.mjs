import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-webui-'))
process.env.DSH_MEMU_HOME = home
const state = await import('../lib/state.js')
const { registerRpc, dispatch } = await import('../lib/rpc.js')
const { webUiHtml, standaloneHtml, standaloneAsset } = await import('../lib/webui.js')
test.after(() => { state.flushState(); fs.rmSync(home, { recursive: true, force: true }) })
function handler(rejection) {
  const routes = []
  registerRpc({ inject: (_deps, callback) => callback({
    effect: fn => fn(), webServer: { register: spec => { routes.push(spec); return () => {} } },
    connection: { requestRejection: () => rejection }, logger: {},
  }) })
  assert.deepEqual(routes.map(route => route.path), ['/dsh-memu-memory', '/dsh-memu'])
  return routes[0].handler
}
async function request(url, method = 'GET', body, rejection) {
  const req = { method, url, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) } }
  const res = { status: 0, headers: {}, body: '', writeHead(code, headers) { this.status = code; this.headers = headers || {} }, end(data) { this.body = data ? String(data) : '' } }
  await handler(rejection)(req, res)
  return res
}
test('wall and shared settings are served behind the same authenticated route', async () => {
  for (const url of ['/dsh-memu-memory/ui', '/dsh-memu-memory/ui/', '/dsh-memu-memory/settings']) {
    const res = await request(url)
    assert.equal(res.status, 200)
    assert.match(res.body, /<!doctype html>/i)
    assert.match(res.body, /dsh-memu-memory/)
    assert.equal((await request(url, 'GET', null, 403)).status, 403)
  }
})
test('standalone settings load the exact client component with local React assets', async () => {
  const html = standaloneHtml()
  assert.match(html, /ui-assets\/client.js/)
  assert.match(html, /ui-assets\/react-dom.js/)
  assert.equal(standaloneAsset('/dsh-memu-memory/ui-assets/client.js'), fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
  for (const name of ['react.js', 'react-dom.js', 'standalone.js', 'client.js', 'graph-view.js']) {
    const res = await request('/dsh-memu-memory/ui-assets/' + name)
    assert.equal(res.status, 200)
    assert.match(res.headers['Content-Type'], /javascript/)
    assert.equal((await request('/dsh-memu-memory/ui-assets/' + name, 'GET', null, 401)).status, 401)
  }
  assert.equal((await request('/dsh-memu-memory/ui-assets/../../../state.json')).status, 405)
})
test('all standalone scripts parse and neither shell defines a second settings editor', () => {
  const wall = webUiHtml()
  assert.equal(wall, standaloneHtml(), 'wall and settings must be exactly the same shell')
  assert.doesNotThrow(() => new Function(standaloneAsset('/dsh-memu-memory/ui-assets/standalone.js')))
  assert.doesNotThrow(() => new Function(standaloneAsset('/dsh-memu-memory/ui-assets/graph-view.js')))
  assert.ok(!wall.includes('function renderSettings'))
  assert.ok(!wall.includes('function renderPrompts'))
  assert.ok(!wall.includes('href="/dsh-memu-memory/ui"'), 'standalone header must not split MemU into another destination')
  assert.match(wall, /ui-assets\/client.js/)
})
test('the wall uses one bounded preview RPC, not N full-body requests', async () => {
  const library = state.createLibrary({ name: 'wall', cwd: path.join(home, 'wall') })
  state.updatePrivateIndex(library.id, index => {
    for (let i = 0; i < 500; i++) index.entries['mem-' + i] = { title: 't' + i, content: 'x'.repeat(1000), status: 'active', source: 'imagined' }
  })
  const response = await dispatch({}, 'browseWall', {})
  assert.equal(response.total, 500)
  assert.equal(response.items.length, 300)
  assert.ok(response.items.every(item => item.preview.length <= 180 && !Object.hasOwn(item, 'content')))
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /call\('browseWall'/)
  assert.match(source, /function MemoryWallPanel/)
})
test('wall pools include review and inactive states; anchor is a view, not a fourth stored layer', () => {
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /\['active', 'browseActiveTab'\]/)
  assert.match(source, /\['review', 'poolReview'\]/)
  assert.match(source, /\['all', 'must_remember', 'long_term', 'short_term', 'anchor'\]/)
  assert.match(source, /value === 'anchor' \? item.layer === 'must_remember'/)
  assert.match(source, /item\.libraryName/)
  assert.match(source, /item\.source/)
})
test('the wall drawer reads exactly one memory', async () => {
  const library = state.createLibrary({ name: 'drawer', cwd: path.join(home, 'drawer') })
  state.updatePrivateIndex(library.id, (index) => {
    index.entries['mem-drawer'] = {
      title: 'drawer one',
      content: 'full body that the wall preview does not carry',
      status: 'active',
      layer: 'long_term',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attachments: [{ sha256: 'a'.repeat(64), name: 'drawer.png', mediaType: 'image/png' }],
    }
    index.entries['mem-sealed'] = {
      title: 'sealed', content: 'secret body', status: 'active', visibility: 'secret',
      attachments: [{ sha256: 'b'.repeat(64) }],
    }
  })
  const one = await dispatch({}, 'getMemory', { libraryId: library.id, id: 'mem-drawer' })
  assert.equal(one.entry.content, 'full body that the wall preview does not carry')
  assert.equal(one.attachments.length, 1)
  assert.equal(one.attachments[0].sha256, 'a'.repeat(64))
  const sealed = await dispatch({}, 'getMemory', { libraryId: library.id, id: 'mem-sealed' })
  assert.equal(sealed.attachments[0].hidden, true)
  assert.equal(sealed.attachments[0].url, undefined, 'a secret attachment must never carry a pixel URL')
  const wall = await dispatch({}, 'browseWall', { libraryId: library.id })
  assert.equal(wall.items.find(item => item.id === 'mem-drawer').attachments[0].sha256, 'a'.repeat(64))
  assert.equal(wall.items.find(item => item.id === 'mem-sealed').attachments[0].hidden, true)
  await assert.rejects(
    async () => { await dispatch({}, 'getMemory', { libraryId: library.id, id: 'missing' }) },
    /unknown memory/,
  )
  await assert.rejects(
    async () => { await dispatch({}, 'getMemory', { id: 'mem-drawer' }) },
    /requires a libraryId/,
  )
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /call\('getMemory'/, 'the drawer fetches one entry')
  assert.match(source, /className: 'dshm-drawer'/, 'the wall renders an in-place drawer')
  assert.match(source, /h\(MemoryAttachments, \{ items: detail\.file\.attachments/, 'the drawer opens the gallery')
  assert.match(source, /function WallCover/, 'cards use the first usable attachment as a cover')
  assert.match(source, /className: 'dshm-wall-cover'/)
  assert.match(source, /detail\.file\?\.status === 'archived'/, 'delete is offered only for archived memories')
  assert.match(source, /call\('deleteMemory', \{ libraryId: current\.item\.libraryId/)
  assert.match(source, /t\('confirmDelete'\)/, 'deleting takes a second click')
  assert.match(source, /current\.file\.status !== 'archived'/, 'the delete handler refuses live memories')
})

test('wall heartbeat retries failed paints, pauses hidden and shares the metadata channel', () => {
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /getSidebarState", \{ revisionOnly: true \}/)
  assert.match(source, /document\.visibilityState === "hidden"/)
  assert.match(source, /visibilitychange/)
  assert.match(source, /result !== false/)
  assert.match(source, /data\.type === "memory-write"/)
})
test('the settings button preserves the host SPA and links to individual pages', () => {
  const client = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // libraryId 选项：整理失败提醒的跳转按钮按库深链（?libraryId=…#/settings/browser）。
  assert.match(client, /function openWebUiPage\(page = null, \{ libraryId = null \} = \{\}\)/)
  assert.match(client, /\/dsh-memu-memory\/ui' \+ query \+ '#\/settings\//)
  assert.match(client, /toggleWebUiOverlay\(url\)/)
  assert.ok(!/window\.location(?:\.href)?\s*=/.test(client))
  // The host ctx is a Cordis service proxy: reading an unknown property such as
  // `ctx.standalone` throws during render and blanked the whole settings pane.
  // The standalone page must opt in through a prop instead.
  assert.ok(!client.includes('ctx.standalone'), 'the shared component must not read ctx.standalone')
  assert.match(client, /function SettingsPage\(\{ ctx, t, embedded, standalone = false \}\)/)
  assert.match(client, /h\(SettingsPage, \{ ctx, t, embedded: false, standalone: true \}\)/)
  assert.match(client, /mountStandalone/)
})
test('RPC still uses stable envelopes and rejects non-UI GETs', async () => {
  const res = await request('/dsh-memu-memory/listLibraries', 'POST', { type: 'client-request', rpcId: 'wall-test', method: 'listLibraries', payload: {} })
  assert.equal(res.status, 200)
  const envelope = JSON.parse(res.body)
  assert.equal(envelope.result.ok, true)
  assert.equal(envelope.rpcId, 'wall-test')
  assert.equal((await request('/dsh-memu-memory/listLibraries')).status, 405)
})

test('old bookmarks and RPC URLs stay compatible after the package rename', async () => {
  assert.equal((await request('/dsh-memu/ui')).body, standaloneHtml())
  const res = await request('/dsh-memu/listLibraries', 'POST', { type: 'client-request', rpcId: 'legacy', method: 'listLibraries', payload: {} })
  assert.equal(JSON.parse(res.body).result.ok, true)
  assert.equal((await request('/dsh-memu-memory/ui-assets/icon.png')).headers['Content-Type'], 'image/png')
})
