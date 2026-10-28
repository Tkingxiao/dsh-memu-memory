import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

// Run against scripts/preview.mjs. All stress data is intercepted in this browser;
// no memories or relationships are written to the running server.
const url = process.argv[2] || 'http://127.0.0.1:7792/dsh-memu-memory/ui#/settings/memories'
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-graph-browser-'))
console.log(`Screenshots: ${output}`)
const browser = await chromium.launch({ headless: true, channel: process.env.GRAPH_BROWSER_CHANNEL || undefined })
const errors = [], requests = []
const fixture = {
  nodes: Array.from({ length: 200 }, (_, i) => ({
    id: `node-${String(i).padStart(3, '0')}`,
    title: ['雨夜的车站', '周五的约定', '修好的相机', '河边的书店', '群里的旧话题', '未完成的旅行'][i % 6] + ` · ${i + 1}`,
    kind: i % 17 === 0 ? 'person' : 'memory', layer: i % 11 === 0 ? 'must_remember' : 'long_term', strength: (i % 9) / 9,
  })),
  edges: Array.from({ length: 144 }, (_, i) => {
    const group = Math.floor(i / 24), member = i % 24 + 1
    return { from: `node-${String(group * 25).padStart(3, '0')}`, to: `node-${String(group * 25 + member).padStart(3, '0')}`,
      kind: 'event', confidence: .8, note: '同一段经历中的人物、场景与后续约定。' }
  }),
}
const telemetry = async page => page.locator('canvas.dshm-graph-canvas').evaluate(canvas => {
  const context = canvas.getContext('2d'), data = context.getImageData(0, 0, canvas.width, canvas.height).data
  let painted = 0
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++
  return { arcs: canvas.__arcs || [], labels: canvas.__labels || [], painted,
    width: canvas.clientWidth, height: canvas.clientHeight }
})

try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, locale: 'zh-CN', deviceScaleFactor: 2, reducedMotion: 'reduce' })
    const page = await context.newPage()
    let revisionBump = ''
    page.on('pageerror', error => errors.push(String(error)))
    await page.addInitScript(recordCanvas)
    for (const endpoint of ['getSettingsState', 'getSidebarState']) await page.route(`**/dsh-memu-memory/${endpoint}`, async route => {
      const response = await route.fetch(), json = await response.json()
      if (revisionBump && json.result?.value) json.result.value.stamp += revisionBump
      await route.fulfill({ response, json })
    })
    await page.route('**/dsh-memu-memory/getGraph', async route => {
      requests.push(route.request().postDataJSON().payload)
      await route.fulfill({ json: { type: 'server-response', result: { ok: true, value: fixture } } })
    })
    await page.goto(url)
    await page.getByRole('tab', { name: '关系', exact: true }).click()
    const canvas = page.locator('canvas.dshm-graph-canvas')
    await canvas.waitFor()
    await page.waitForFunction(() => document.querySelector('canvas.dshm-graph-canvas')?.__arcs?.length === 200)
    await page.locator('#boot').waitFor({ state: 'hidden' })
    await canvas.scrollIntoViewIfNeeded()
    const initial = await telemetry(page)
    await page.locator('.dshm-graph-viewport').screenshot({ path: path.join(output, `graph-${viewport.width}.png`) })
    console.log(`${viewport.width}px initial: ${initial.arcs.length} nodes, ${initial.labels.length} labels, ${initial.width}x${initial.height}`)
    assert.equal(initial.arcs.length, 200)
    assert.ok(initial.painted > 1000, 'canvas pixels must be nonblank')
    assert.ok(initial.labels.length > 0 && initial.labels.length < 200)
    for (const p of initial.arcs) assert.ok(p.x > 10 && p.x < initial.width - 10 && p.y > 10 && p.y < initial.height - 10)
    for (let i = 0; i < initial.labels.length; i++) {
      const a = initial.labels[i]
      for (const b of initial.labels.slice(i + 1)) assert.ok(
        a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + 16 <= b.y || b.y + 16 <= a.y,
        'visible labels must not overlap',
      )
    }
    const box = await canvas.boundingBox(), node = initial.arcs.at(-1)
    const beforeDrag = requests.length
    await page.mouse.move(box.x + node.x, box.y + node.y)
    await page.mouse.down()
    await page.mouse.move(box.x + node.x + 25, box.y + node.y + 15, { steps: 8 })
    await page.mouse.up()
    await page.mouse.move(box.x - 5, box.y - 5)
    await page.waitForTimeout(120)
    assert.equal(requests.length, beforeDrag, 'drag must not focus/refetch')
    const dragged = (await telemetry(page)).arcs.at(-1)
    assert.ok(Math.abs(dragged.x - node.x - 25) < 1 && Math.abs(dragged.y - node.y - 15) < 1)
    const beforeRefresh = (await telemetry(page)).arcs
    const refreshed = page.waitForResponse(response => response.url().endsWith('/getGraph'), { timeout: 10000 })
    revisionBump = '-graph-refresh-test'
    await refreshed
    await page.waitForTimeout(100)
    assert.deepEqual((await telemetry(page)).arcs, beforeRefresh, 'a full heartbeat RPC refresh must preserve dragged positions and camera')

    const beforePan = await telemetry(page)
    await page.mouse.move(box.x + 5, box.y + 5); await page.mouse.down()
    await page.mouse.move(box.x + 30, box.y + 20, { steps: 6 }); await page.mouse.up()
    await page.waitForTimeout(60)
    const panned = await telemetry(page)
    assert.ok(Math.abs(panned.arcs[0].x - beforePan.arcs[0].x - 25) < 1)
    assert.ok(Math.abs(panned.arcs[0].y - beforePan.arcs[0].y - 15) < 1)

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -120); await page.waitForTimeout(100)
    const wheel = await telemetry(page)
    assert.ok(wheel.arcs.some((p, i) => Math.abs(p.x - panned.arcs[i]?.x) > 1), 'wheel must zoom')
    await page.getByRole('button', { name: '适应全图', exact: true }).click()
    await page.getByRole('button', { name: '图谱设置', exact: true }).click()
    await page.getByRole('checkbox', { name: '动态布局', exact: true }).uncheck()
    await page.getByRole('checkbox', { name: '显示标签', exact: true }).uncheck()
    await page.waitForTimeout(60)
    assert.equal((await telemetry(page)).labels.length, 0)
    await page.getByRole('checkbox', { name: '显示标签', exact: true }).check()
    await page.getByRole('button', { name: '图谱设置', exact: true }).click()
    await page.waitForTimeout(60)
    const fitted = await telemetry(page), selected = fitted.arcs.at(-1)
    const currentBox = await canvas.boundingBox()
    const beforeClick = requests.length
    await page.mouse.click(currentBox.x + selected.x, currentBox.y + selected.y)
    await page.waitForTimeout(120)
    assert.equal(requests.length, beforeClick + 1, 'a real click must focus exactly once')
    await page.mouse.move(currentBox.x - 5, currentBox.y - 5)
    await canvas.press('Escape'); await page.waitForTimeout(100)
    assert.equal(requests.at(-1).focusId, null)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'page must not overflow horizontally')
    console.log(`${viewport.width}px: ${initial.arcs.length} nodes, ${initial.labels.length} non-overlapping labels, ${initial.painted} painted pixels; drag/pan/zoom/click/settings passed`)
    await context.close()
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(String(error)))
  await page.addInitScript(recordCanvas)
  await page.route('**/ui-assets/graph-view.js', route => route.abort('failed'))
  await page.goto(url)
  await page.getByRole('tab', { name: '关系', exact: true }).click()
  const retry = page.getByRole('button', { name: '图谱加载失败，请重试', exact: true })
  await retry.waitFor()
  await page.unroute('**/ui-assets/graph-view.js')
  await retry.click()
  await page.waitForFunction(() => document.querySelector('canvas.dshm-graph-canvas')?.__arcs?.length > 0)
  await page.locator('#boot').waitFor({ state: 'hidden' })
  const actual = await telemetry(page)
  assert.ok(actual.painted > 100 && actual.labels.length > 0)
  await page.locator('.dshm-graph-viewport').screenshot({ path: path.join(output, 'graph-real-light.png') })
  await page.locator('#theme').click()
  await page.waitForTimeout(100)
  await page.locator('.dshm-graph-viewport').screenshot({ path: path.join(output, 'graph-real-dark.png') })
  const settled = (await telemetry(page)).arcs
  await page.waitForTimeout(2800)
  assert.deepEqual((await telemetry(page)).arcs, settled, 'a heartbeat/re-render must not restart or jump the settled layout')
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
  const canvas = page.locator('canvas.dshm-graph-canvas'), box = await canvas.boundingBox()
  const selected = settled.at(-1)
  await page.mouse.move(box.x + selected.x, box.y + selected.y)
  await page.mouse.down()
  await page.mouse.move(box.x + selected.x + 40, box.y + selected.y - 20, { steps: 10 })
  await page.waitForTimeout(100)
  const pinned = (await telemetry(page)).arcs[settled.length - 1]
  assert.ok(Math.abs(pinned.x - selected.x - 40) < 1 && Math.abs(pinned.y - selected.y + 20) < 1,
    'live physics must not displace the node under the pointer')
  await page.mouse.up()
  await page.waitForTimeout(100)
  assert.ok((await telemetry(page)).arcs.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)))
  console.log(`Real data: ${actual.arcs.length} nodes; module failure/retry, light/dark and heartbeat stability passed`)
  await context.close()
  assert.deepEqual(errors, [])
  console.log(`Screenshots: ${output}`)
} finally {
  await browser.close()
}

function recordCanvas() {
  const proto = CanvasRenderingContext2D.prototype
  const clear = proto.clearRect, arc = proto.arc, text = proto.fillText
  proto.clearRect = function (...args) { this.canvas.__arcs = []; this.canvas.__labels = []; return clear.apply(this, args) }
  proto.arc = function (x, y, radius, ...args) {
    ;(this.canvas.__arcs ||= []).push({ x, y, radius })
    return arc.call(this, x, y, radius, ...args)
  }
  proto.fillText = function (value, x, y, ...args) {
    ;(this.canvas.__labels ||= []).push({ value, x, y, width: this.measureText(value).width })
    return text.call(this, value, x, y, ...args)
  }
}
