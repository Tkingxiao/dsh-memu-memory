import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

// Run against scripts/preview.mjs. All stress data is intercepted in this browser;
// no memories or relationships are written to the running server.
// 关系图谱现在是复刻 Graph Studio 的独立工作台页（#/settings/graph）。
const url = process.argv[2] || 'http://127.0.0.1:7792/dsh-memu-memory/ui#/settings/graph'
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
const railButton = (page, name) => page.locator('.dshm-gs-rail').getByRole('button', { name, exact: true })
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const nearestPoint = (points, target) => points.reduce((best, p) => distance(p, target) < distance(best, target) ? p : best, points[0])
const pinnedCount = page => page.evaluate(() => document.querySelector('canvas.dshm-graph-canvas')?.__dshmGraphView?.pinnedCount?.() ?? -1)
const snapshot = page => page.evaluate(() => document.querySelector('canvas.dshm-graph-canvas')?.__dshmGraphView?.snapshot?.() ?? [])

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
    await page.locator('#boot').waitFor({ state: 'hidden' })
    const canvas = page.locator('canvas.dshm-graph-canvas')
    await canvas.waitFor()
    await page.waitForFunction(() => document.querySelector('canvas.dshm-graph-canvas')?.__arcs?.length === 200)
    await canvas.scrollIntoViewIfNeeded()
    // 复刻界面的骨架必须都在：顶栏 / 竖排工具 / 检视面板 / 状态栏。
    for (const selector of ['.dshm-gs-topbar', '.dshm-gs-rail', '.dshm-gs-inspector', '.dshm-gs-status']) {
      assert.equal(await page.locator(selector).count(), 1, `${selector} is missing`)
    }
    const initial = await telemetry(page)
    await page.locator('.dshm-gs-stage').screenshot({ path: path.join(output, `graph-${viewport.width}.png`) })
    console.log(`${viewport.width}px initial: ${initial.arcs.length} nodes, ${initial.labels.length} labels, ${initial.width}x${initial.height}`)
    assert.equal(initial.arcs.length, 200)
    assert.ok(initial.painted > 1000, 'canvas pixels must be nonblank')
    // 缩得很小时原版也只给高度数节点铺标签，甚至一个都不铺（zoomFade 归零）；
    // 标签是否真的出现放到放大之后再断言。
    assert.ok(initial.labels.length < 200)
    for (const p of initial.arcs) assert.ok(p.x > 10 && p.x < initial.width - 10 && p.y > 10 && p.y < initial.height - 10)
    // 标签是 textAlign:center 画的：x 是文字中心，左右边缘要各减/加半个宽度。
    for (let i = 0; i < initial.labels.length; i++) {
      const a = initial.labels[i]
      for (const b of initial.labels.slice(i + 1)) assert.ok(
        a.x + a.width / 2 <= b.x - b.width / 2 || b.x + b.width / 2 <= a.x - a.width / 2 ||
        a.y + 14 <= b.y || b.y + 14 <= a.y,
        'visible labels must not overlap',
      )
    }
    const box = await canvas.boundingBox()
    const initialNodes = await snapshot(page)
    // 取画布左侧的节点：窄屏检视面板若被展开会覆盖右侧，左侧永远可命中。
    const node = initialNodes.reduce((best, item) => item.x < best.x ? item : best, initialNodes[0])
    const beforeDrag = requests.length
    const expected = { x: node.x + 25, y: node.y + 15 }
    await page.mouse.move(box.x + node.x, box.y + node.y)
    await page.mouse.down()
    await page.mouse.move(box.x + expected.x, box.y + expected.y, { steps: 8 })
    // 按住时 1:1 跟手；松手后节点会被物理收敛（左键不锁定），所以落点断言只要求"没弹回原处"。
    const draggedNode = (await snapshot(page)).find(item => item.id === node.id)
    assert.ok(draggedNode && distance(draggedNode, expected) < 1, 'the dragged node must follow the pointer 1:1')
    await page.mouse.up()
    await page.mouse.move(box.x - 5, box.y - 5)
    await page.waitForTimeout(120)
    assert.equal(requests.length, beforeDrag, 'drag must not focus/refetch')
    assert.equal(await pinnedCount(page), 0, 'a left drag must not lock the node')
    await page.waitForTimeout(320)
    const released = (await snapshot(page)).find(item => item.id === node.id)
    // 松手后整簇会跟着收敛，落点会有小幅漂移，但绝不会弹回原处。
    assert.ok(released && distance(released, expected) < 120, 'a left-dragged node must stay near the drop point')
    assert.ok(released && distance(released, node) > 20, 'a left-dragged node must not spring back to its origin')
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
    await railButton(page, '适应全图').click()
    // 放大后再验证标签开关：缩得太小时原版本来就把标签渐隐到 0。
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -400); await page.waitForTimeout(100)
    await page.mouse.wheel(0, -400); await page.waitForTimeout(100)
    assert.ok((await telemetry(page)).labels.length > 0, 'labels must appear once zoomed in')
    await railButton(page, '图谱设置').click()
    await page.getByRole('switch', { name: '动态布局', exact: true }).click()
    await page.getByRole('switch', { name: '显示标签', exact: true }).click()
    await page.waitForTimeout(60)
    assert.equal((await telemetry(page)).labels.length, 0)
    await page.getByRole('switch', { name: '显示标签', exact: true }).click()
    await page.waitForTimeout(60)
    assert.ok((await telemetry(page)).labels.length > 0, 'the label switch must turn labels back on')
    await page.getByRole('switch', { name: '动态布局', exact: true }).click()
    await railButton(page, '图谱设置').click()
    await page.waitForTimeout(60)
    const fitted = await telemetry(page)
    // 放大后要用视口内、离边缘有距离的节点，否则点击会落在空白处不触发 focus。
    const clickable = (await snapshot(page)).filter(n =>
      n.x > 60 && n.x < initial.width - 60 && n.y > 60 && n.y < initial.height - 60)
    const selected = clickable[0] || fitted.arcs[0]
    const currentBox = await canvas.boundingBox()
    const beforeClick = requests.length
    await page.mouse.click(currentBox.x + selected.x, currentBox.y + selected.y)
    await page.waitForTimeout(120)
    assert.equal(requests.length, beforeClick + 1, 'a real click must focus exactly once')
    await page.mouse.move(currentBox.x - 5, currentBox.y - 5)
    await canvas.press('Escape'); await page.waitForTimeout(100)
    assert.equal(requests.at(-1).focusId, null)

    // 右键 = 锁定 / 解除；左键只做显示与拖动，不产生固定点。
    // 放大后部分节点在视口外，右键必须点视口内的节点才命中。
    const pinCandidates = (await snapshot(page)).filter(n =>
      n.x > 20 && n.x < initial.width - 20 && n.y > 20 && n.y < initial.height - 20)
    const pinTarget = pinCandidates[0] || (await snapshot(page))[0]
    await page.mouse.click(currentBox.x + pinTarget.x, currentBox.y + pinTarget.y, { button: 'right' })
    await page.waitForTimeout(80)
    assert.equal(await pinnedCount(page), 1, 'right click must pin the node')
    await page.mouse.click(currentBox.x + pinTarget.x, currentBox.y + pinTarget.y, { button: 'right' })
    await page.waitForTimeout(80)
    assert.equal(await pinnedCount(page), 0, 'right click again must unpin')

    // 拖一簇穿过另一簇：只有被拖的连通簇会动，其他簇一像素都不动且不重合。
    const crossBefore = await snapshot(page)
    assert.equal(crossBefore.length, 200)
    const center = { x: initial.width / 2, y: initial.height / 2 }
    let anchor = crossBefore[0], best = Infinity
    for (const p of crossBefore) {
      const d = distance(p, center)
      if (d < best) { best = d; anchor = p }
    }
    const from = crossBefore[0]
    const dragBox = await canvas.boundingBox()
    await page.mouse.move(dragBox.x + from.x, dragBox.y + from.y)
    await page.mouse.down()
    await page.mouse.move(dragBox.x + anchor.x + 58, dragBox.y + anchor.y + 38, { steps: 6 })
    await page.mouse.up()
    await page.mouse.move(dragBox.x - 5, dragBox.y - 5)
    await page.waitForTimeout(150)
    const crossAfter = await snapshot(page)
    assert.equal(crossAfter.length, crossBefore.length, 'dragging must not drop nodes')
    const moved = crossAfter.filter(item => {
      const before = crossBefore.find(p => p.id === item.id)
      return !before || distance(item, before) > .5
    })
    assert.ok(moved.length > 0, 'the dragged node must move')
    assert.ok(crossBefore.length - moved.length >= crossBefore.length - 30,
      `clusters outside the dragged one must stay frozen (${moved.length} moved)`)
    const movingIds = new Set(moved.map(item => item.id))
    let min = Infinity
    for (const item of moved) for (const other of crossAfter) {
      if (movingIds.has(other.id)) continue
      // 用节点圆之间的净间距判断「不重合」，比固定 12px 更贴近实际观感。
      min = Math.min(min, distance(item, other) - item.r - other.r)
    }
    assert.ok(min > 0, `node circles must not overlap (gap ${min.toFixed(1)}px)`)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'page must not overflow horizontally')
    console.log(`${viewport.width}px: ${initial.arcs.length} nodes, ${initial.labels.length} non-overlapping labels, ${initial.painted} painted pixels; pin/frozen clusters/min gap ${min.toFixed(1)}px passed`)
    await context.close()
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(String(error)))
  await page.addInitScript(recordCanvas)
  await page.route('**/ui-assets/graph-view.js', route => route.abort('failed'))
  await page.goto(url)
  const retry = page.getByRole('button', { name: '图谱加载失败，请重试', exact: true })
  await retry.waitFor()
  await page.unroute('**/ui-assets/graph-view.js')
  await retry.click()
  await page.waitForFunction(() => document.querySelector('canvas.dshm-graph-canvas')?.__arcs?.length > 0)
  await page.locator('#boot').waitFor({ state: 'hidden' })
  const actual = await telemetry(page)
  assert.ok(actual.painted > 100 && actual.labels.length > 0)
  await page.locator('.dshm-gs-stage').screenshot({ path: path.join(output, 'graph-real-light.png') })
  await page.locator('#theme').click()
  await page.waitForTimeout(100)
  await page.locator('.dshm-gs-stage').screenshot({ path: path.join(output, 'graph-real-dark.png') })
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
  await page.waitForTimeout(420)
  assert.equal(await pinnedCount(page), 0, 'a left drag must not pin the node')
  assert.ok((await telemetry(page)).arcs.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)))
  console.log(`Real data: ${actual.arcs.length} nodes; module failure/retry, light/dark, heartbeat stability and left-drag-no-lock passed`)
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
