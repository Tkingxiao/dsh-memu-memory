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
const { dataDir } = await import('../lib/paths.js')
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

test('fullscreen wall avoids the WebView2 compositor traps that dropped cards', () => {
  const client = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // The overlay is a full-viewport iframe over the host app. A backdrop-filter on
  // that wrapper (and a transparent iframe background) made WebView2 re-blur the
  // whole host on every repaint; at fullscreen it started dropping wall tiles.
  const overlay = client.slice(client.indexOf('function toggleWebUiOverlay'), client.indexOf('function glyph'))
  assert.ok(!/backdrop-filter\s*:/.test(overlay), 'the overlay wrapper must not blur the host behind the iframe')
  assert.match(overlay, /background:var\(--dsw-alias-bg-base, #f4f5f9\)/, 'the iframe stays opaque while its page paints')
  // Late replies must not repaint the wall/browser after a newer library was picked.
  assert.match(client, /const requestId = \+\+browseRequest\.current/)
  assert.match(client, /const requestId = \+\+browseLibraryRequest\.current/)
  assert.match(client, /const requestId = \+\+statsRequest\.current/)
  assert.match(client, /const requestId = \+\+reviewsRequest\.current/)
  assert.match(client, /if \(!current\(\)\) return/, 'stale browseWall replies are dropped')

  const css = fs.readFileSync(new URL('../lib/webui/standalone.css', import.meta.url), 'utf8')
  const start = css.indexOf('html[data-standalone] .dshm-wall-item {')
  const wall = css.slice(start, css.indexOf('html[data-standalone] .dshm-wall-item:hover'))
  assert.ok(!/backdrop-filter\s*:/.test(wall), 'wall cards must not stack dozens of blur layers on screen')
  assert.match(wall, /content-visibility: auto/, 'off-screen wall rows stay out of the paint path')

  const standalone = fs.readFileSync(new URL('../lib/webui/standalone.js', import.meta.url), 'utf8')
  assert.match(standalone, /var spot = document\.querySelector\('\.ambient-spot'\)/)
  assert.match(standalone, /\(spot \|\| document\.documentElement\)\.style/, 'pointer moves only invalidate the spotlight element')
  assert.match(standalone, /if \(!framed && !reduceMotion/, 'the iframe overlay does not repaint a full-screen spotlight')
})

test('single-library browseWall still carries global rows and F1/F2 metadata', async () => {
  const library = state.createLibrary({ name: 'wall-global-merge', cwd: path.join(home, 'wall-global-merge') })
  state.updatePrivateIndex(library.id, (index) => {
    index.entries['mem-private-merge'] = {
      title: 'private row', content: 'private row body', status: 'active', layer: 'long_term',
      visibility: 'shared', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
  })
  state.saveGlobalIndex({
    version: 1,
    entries: {
      'gmem-linked': {
        title: 'global row', content: 'global row body', status: 'active', domain: 'general', track: 'memory',
        links: [{ id: 'lnk-probe', opId: 'op-probe', to: 'gmem-other', kind: 'related', note: '这两条讲同一件事，必须一起看。', confidence: 0.7, evidence: [], createdAt: new Date().toISOString() }],
        absorbedFrom: ['gmem-a', 'gmem-b'],
        updatedAt: new Date().toISOString(),
      },
    },
  })
  state.flushState()

  const wall = await dispatch({}, 'browseWall', { libraryId: library.id })
  assert.ok(wall.items.some((item) => item.id === 'mem-private-merge'), 'the authorized private row is present')
  const globalRow = wall.items.find((item) => item.id === 'gmem-linked')
  assert.ok(globalRow, 'a single-library wall must keep the shared global scope')
  assert.equal(globalRow.libraryId, null)
  assert.equal(globalRow.links.length, 1)
  assert.deepEqual(globalRow.absorbedFrom, ['gmem-a', 'gmem-b'])

  const listed = await dispatch({}, 'listGlobal', {})
  const globalFile = listed.files.find((file) => file.id === 'gmem-linked')
  assert.ok(globalFile, 'the global page lists the same row')
  assert.equal(globalFile.links.length, 1)
  assert.deepEqual(globalFile.absorbedFrom, ['gmem-a', 'gmem-b'])

  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /wallAllBlocked/, 'the single-library fallback explains itself')
  assert.match(source, /browseWall', \{ libraryId: firstLibraryId/, 'the wall retries the first library after an all-libraries 403')
  assert.match(source, /setMultiBlocked\(true\)/, 'the fallback disables the all-libraries option')
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
test('the shell keeps no always-on compositor drivers', () => {
  // GPU 占用高的根因不是算力，是「空闲期仍在持续产帧」：无限 CSS 动画让合成器
  // 永远不睡（1.3.3 实测空闲 ~99fps），全屏 backdrop-filter 再每帧重算模糊。
  // 守卫用 scripts/check-idle-compositing.mjs 真机数帧；这里静态拦复发。
  const css = fs.readFileSync(new URL('../lib/webui/standalone.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '') // 注释里会引用旧写法（will-change / infinite），不能算声明
  const client = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const infinite = [...css.matchAll(/animation:[^;]*infinite[^;]*/g)].map(m => m[0])
  assert.ok(infinite.every(rule => /boot-ring|boot-shimmer/.test(rule)),
    `always-on animation outside the boot veil: ${infinite.join(' | ')}`)
  const ambient = css.slice(css.indexOf('.ambient i {'), css.indexOf('}', css.indexOf('.ambient i {')))
  assert.ok(!/will-change|animation/.test(ambient), 'the ambient blobs must stay static, unlayered')
  const blurred = css.split('}').filter(block => /backdrop-filter:/.test(block))
  assert.ok(blurred.every(block => /\.topbar\s*\{|\.boot-card\s*\{/.test(block)),
    'blur belongs to small chrome only, never to the rail, cards or drawer')
  assert.ok(!/backdrop-filter:/.test(client), 'the shared UI must not blur full-screen surfaces')
  assert.ok(!/const timer = setInterval\(paint/.test(client), 'the minimap is driven by onPaint, not a poll')
  assert.match(client, /notifyRef\.current = paint/)
})
test('RPC still uses stable envelopes and rejects non-UI GETs', async () => {
  const res = await request('/dsh-memu-memory/listLibraries', 'POST', { type: 'client-request', rpcId: 'wall-test', method: 'listLibraries', payload: {} })
  assert.equal(res.status, 200)
  const envelope = JSON.parse(res.body)
  assert.equal(envelope.result.ok, true)
  assert.equal(envelope.rpcId, 'wall-test')
  assert.equal((await request('/dsh-memu-memory/listLibraries')).status, 405)
})

// ── 词典 RPC（§2.3 / §2.5）：公开两态 active/archived，没有 pending/review ──
function lexiconFile(libraryId) {
  return path.join(dataDir(), 'lexicon', libraryId + '.json')
}
function writeLexiconEntries(libraryId, entries) {
  const file = lexiconFile(libraryId)
  const store = JSON.parse(fs.readFileSync(file, 'utf8'))
  Object.assign(store.terms, entries)
  // 直接写盘模拟 legacy/手工数据；条目数变化保证 mtime+size 缓存必然失效。
  fs.writeFileSync(file, JSON.stringify(store))
}

test('lexicon RPC: archive/restore lifecycle, active/archived tabs, stable statusCounts and archived-aware search', async () => {
  const library = state.createLibrary({ name: 'lexicon-rpc', cwd: path.join(home, 'lexicon-rpc') })
  const first = await dispatch({}, 'lexiconAdd', { libraryId: library.id, term: '糖刀', kind: 'meme', meaning: '表面发糖、实际虐心的剧情' })
  assert.equal(first.term.status, 'active', 'the management panel writes as the user → active, never pending')
  await new Promise((resolve) => setTimeout(resolve, 6))
  const second = await dispatch({}, 'lexiconAdd', { libraryId: library.id, term: '红牌', kind: 'trigger', sensitivity: 'sensitive', meaning: '角色行为的红线信号' })
  const knifeId = first.term.termId
  const redId = second.term.termId

  const activeView = await dispatch({}, 'lexiconList', { libraryId: library.id })
  assert.equal(activeView.total, 2)
  assert.deepEqual(activeView.items.map((item) => item.id), [redId, knifeId], 'updatedAt desc: the newest term first')
  assert.ok(activeView.items.every((item) => item.status === 'active'), 'the default tab is active only')
  assert.deepEqual(activeView.statusCounts, { active: 2, archived: 0 })
  assert.deepEqual(activeView.counts, { slang: 0, meme: 1, trigger: 1, term: 0 })

  const archived = await dispatch({}, 'lexiconArchive', { libraryId: library.id, termId: knifeId })
  assert.equal(archived.libraryId, library.id)
  assert.equal(archived.termId, knifeId)
  assert.equal(archived.action, 'archive')
  assert.equal(archived.term.status, 'archived')

  const afterArchive = await dispatch({}, 'lexiconList', { libraryId: library.id })
  assert.deepEqual(afterArchive.items.map((item) => item.id), [redId], 'archived rows leave the active tab')
  assert.deepEqual(afterArchive.statusCounts, { active: 1, archived: 1 }, 'tab counts are computed before status/kind/search filters')
  assert.deepEqual(afterArchive.counts, { slang: 0, meme: 0, trigger: 1, term: 0 }, 'kind counts follow the rows currently selected')

  const archivedTab = await dispatch({}, 'lexiconList', { libraryId: library.id, status: 'archived' })
  assert.deepEqual(archivedTab.items.map((item) => item.id), [knifeId])
  assert.deepEqual(archivedTab.counts, { slang: 0, meme: 1, trigger: 0, term: 0 })
  assert.deepEqual(archivedTab.statusCounts, { active: 1, archived: 1 })

  const both = await dispatch({}, 'lexiconList', { libraryId: library.id, includeArchived: true })
  assert.deepEqual(both.items.map((item) => item.id).sort(), [knifeId, redId].sort())
  assert.equal(both.total, 2)
  assert.deepEqual(both.statusCounts, { active: 1, archived: 1 })

  const explicitWins = await dispatch({}, 'lexiconList', { libraryId: library.id, includeArchived: true, status: 'active' })
  assert.deepEqual(explicitWins.items.map((item) => item.id), [redId], 'an explicit status outranks includeArchived')

  // search 默认只搜 active；未激活的 includeArchived 才包含归档；旧的 includePending 没有任何语义。
  assert.equal((await dispatch({}, 'lexiconSearch', { libraryId: library.id, q: '糖刀' })).items.length, 0)
  const archivedSearch = await dispatch({}, 'lexiconSearch', { libraryId: library.id, q: '糖刀', includeArchived: true })
  assert.equal(archivedSearch.items.length, 1)
  assert.equal(archivedSearch.items[0].status, 'archived')
  assert.equal((await dispatch({}, 'lexiconSearch', { libraryId: library.id, q: '糖刀', includePending: true })).items.length, 0, 'includePending is gone')
  assert.equal((await dispatch({}, 'lexiconSearch', { libraryId: library.id, q: '红牌' })).items.length, 1)

  const restored = await dispatch({}, 'lexiconRestore', { libraryId: library.id, termId: knifeId })
  assert.equal(restored.action, 'restore')
  assert.equal(restored.termId, knifeId)
  assert.equal(restored.term.status, 'active')
  assert.equal((await dispatch({}, 'lexiconList', { libraryId: library.id })).total, 2)

  await assert.rejects(() => dispatch({}, 'lexiconRestore', { libraryId: library.id, termId: knifeId }), /only archived terms can be restored/)
  await assert.rejects(() => dispatch({}, 'lexiconArchive', { libraryId: library.id, termId: 'lex-nope' }), /does not exist/)
  await assert.rejects(() => dispatch({}, 'lexiconArchive', { libraryId: library.id }), /termId is required/)
  await assert.rejects(() => dispatch({}, 'lexiconRestore', { libraryId: library.id }), /termId is required/)
  // status 只认公开两态：legacy pending / rejected 明确报错，不静默当成“全都要”。
  for (const status of ['pending', 'rejected', 'deleted']) {
    await assert.rejects(() => dispatch({}, 'lexiconList', { libraryId: library.id, status }), /unknown lexicon status/)
  }
  // 旧方法彻底消失：lexiconReview 不再是 dispatch 的入口。
  await assert.rejects(() => dispatch({}, 'lexiconReview', { libraryId: library.id, termId: knifeId, action: 'approve' }), /unknown endpoint/)
})

test('lexiconList never returns pending/rejected tombstones; ordering ties break by id', async () => {
  const library = state.createLibrary({ name: 'lexicon-tombstones', cwd: path.join(home, 'lexicon-tombstones') })
  await dispatch({}, 'lexiconAdd', { libraryId: library.id, term: '归档条', kind: 'term', meaning: '会被归档的词' })
  const archivedView = await dispatch({}, 'lexiconList', { libraryId: library.id })
  const archivedId = archivedView.items.find((item) => item.term === '归档条').id
  await dispatch({}, 'lexiconArchive', { libraryId: library.id, termId: archivedId })
  const stamp = new Date().toISOString()
  const base = { kind: 'term', meaning: 'legacy/手工数据', usage: '', aliases: [], normalizedAliases: [], examples: [], context: {}, visibility: 'shared', sensitivity: 'normal', source: 'model-proposal', createdAt: stamp, updatedAt: stamp }
  // 同一时间戳的两条 active + 一条 rejected 墓碑 + 一条 legacy pending：
  // 列表只出 active/archived，排序在时间戳相同处按 id 稳定兜底。
  writeLexiconEntries(library.id, {
    'lex-bbb': { ...base, term: '乙条', normalizedTerm: '乙条', status: 'active' },
    'lex-aaa': { ...base, term: '甲条', normalizedTerm: '甲条', status: 'active' },
    'lex-tombstone': { ...base, term: '墓碑词', normalizedTerm: '墓碑词', status: 'rejected', fingerprint: 'deadbeef' },
    'lex-legacy-pending': { ...base, term: '老待审', normalizedTerm: '老待审', status: 'pending' },
  })
  const listed = await dispatch({}, 'lexiconList', { libraryId: library.id, includeArchived: true })
  assert.deepEqual(listed.items.map((item) => item.term), ['甲条', '乙条', '归档条'], 'ties break by id; only active/archived rows are listed')
  assert.deepEqual(listed.statusCounts, { active: 2, archived: 1 }, 'tombstones never count toward the tabs')
  assert.ok(listed.items.every((item) => item.status === 'active' || item.status === 'archived'))
  const activeOnly = await dispatch({}, 'lexiconList', { libraryId: library.id })
  assert.deepEqual(activeOnly.items.map((item) => item.term), ['甲条', '乙条'])
  assert.deepEqual(activeOnly.statusCounts, { active: 2, archived: 1 }, 'tab counts stay stable when the active tab is selected')
  assert.equal((await dispatch({}, 'lexiconSearch', { libraryId: library.id, q: '墓碑词', includeArchived: true })).items.length, 0)
  assert.equal((await dispatch({}, 'lexiconSearch', { libraryId: library.id, q: '老待审', includeArchived: true })).items.length, 0)
  assert.equal((await dispatch({}, 'lexiconSearch', { libraryId: library.id, q: '甲条' })).items.length, 1)
})

test('importMemories lexicon merge: rejected tombstones are never resurrected, legacy pending follows the migration mapping', async () => {
  const library = state.createLibrary({ name: 'lexicon-import', cwd: path.join(home, 'lexicon-import') })
  await dispatch({}, 'lexiconAdd', { libraryId: library.id, term: '目标条', kind: 'term', meaning: '现有 active 释义' })
  const stamp = new Date().toISOString()
  const base = { kind: 'term', meaning: 'x', usage: '', aliases: [], normalizedAliases: [], examples: [], context: {}, visibility: 'shared', sensitivity: 'normal', source: 'model-proposal', createdAt: stamp, updatedAt: stamp }
  writeLexiconEntries(library.id, {
    'lex-tombstone': { ...base, term: '墓碑词', normalizedTerm: '墓碑词', status: 'rejected', fingerprint: 'deadbeef' },
  })
  const memories = [{ id: 'mem-import-anchor', title: 'anchor', content: '让记忆导入有内容可写', status: 'active' }]
  const report = await dispatch({}, 'importMemories', {
    libraryId: library.id,
    memories,
    lexicon: { version: 1, terms: [
      { term: '墓碑词', kind: 'term', meaning: '背包里的墓碑，不许复活', status: 'rejected' },
      { term: '墓碑词', kind: 'term', meaning: '撞上库里的墓碑也不许复活', status: 'active' },
      { term: '目标条', kind: 'term', meaning: 'legacy 草稿试图覆盖正条', status: 'pending', revisionOf: 'lex-anything' },
      { term: '老提案', kind: 'term', meaning: 'legacy pending 提案', status: 'pending' },
      { term: '老草稿', kind: 'term', meaning: 'legacy revision 草稿', status: 'pending', revisionOf: 'lex-missing' },
      { term: '老敏感红牌', kind: 'trigger', meaning: 'legacy pending 敏感词', status: 'pending' },
    ] },
  })
  assert.equal(report.lexicon.skipped.length, 3, 'two rejected rows and the legacy draft over an active target are skipped')
  assert.ok(report.lexicon.skipped.every((entry) => /tombstone|rejected|legacy pending draft/.test(entry.reason)))
  assert.equal(report.lexicon.added, 3)
  assert.equal(report.lexicon.failed.length, 0)

  const listed = await dispatch({}, 'lexiconList', { libraryId: library.id, includeArchived: true })
  const byTerm = new Map(listed.items.map((item) => [item.term, item]))
  assert.equal(byTerm.has('墓碑词'), false, 'a rejected tombstone stays hidden and stays rejected')
  assert.equal(byTerm.get('目标条').status, 'active', 'the active target keeps its own text')
  assert.equal(byTerm.get('目标条').meaning, '现有 active 释义')
  assert.equal(byTerm.get('老提案').status, 'active', 'legacy new proposal → active')
  assert.equal(byTerm.get('老草稿').status, 'archived', 'legacy revision draft → archived')
  assert.equal(byTerm.get('老敏感红牌').status, 'archived', 'legacy sensitive proposal → archived')
  assert.deepEqual(listed.statusCounts, { active: 2, archived: 2 })
  const raw = JSON.parse(fs.readFileSync(lexiconFile(library.id), 'utf8'))
  assert.equal(raw.terms['lex-tombstone'].status, 'rejected', 'the tombstone row is untouched')
  assert.equal(Object.values(raw.terms).some((entry) => entry.term === '墓碑词' && entry.status === 'active'), false)
})

test('old bookmarks and RPC URLs stay compatible after the package rename', async () => {
  assert.equal((await request('/dsh-memu/ui')).body, standaloneHtml())
  const res = await request('/dsh-memu/listLibraries', 'POST', { type: 'client-request', rpcId: 'legacy', method: 'listLibraries', payload: {} })
  assert.equal(JSON.parse(res.body).result.ok, true)
  assert.equal((await request('/dsh-memu-memory/ui-assets/icon.png')).headers['Content-Type'], 'image/png')
})
