import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import fs from 'node:fs'
import { createForceLayout, createGraphView, DEFAULT_OPTIONS, fitCamera, zoomCamera, placeLabels } from '../lib/webui/graph-view.js'

const graph = (count, connected = true) => ({
  nodes: Array.from({ length: count }, (_, i) => ({ id: `n${String(i).padStart(3, '0')}`, title: `Memory ${i}`, kind: 'memory', strength: .5 })),
  edges: connected ? Array.from({ length: count - 1 }, (_, i) => ({ from: `n${String(i).padStart(3, '0')}`, to: `n${String(i + 1).padStart(3, '0')}` })) : [],
})

test('layout preserves object identity, positions and cooling on equivalent refreshed snapshots', () => {
  const data = graph(30), before = structuredClone(data), layout = createForceLayout()
  layout.update(data); layout.settle()
  const node = layout.nodes[0], position = { x: node.x, y: node.y }, alpha = layout.alpha
  assert.equal(layout.update(structuredClone(data)), false)
  assert.equal(layout.nodes[0], node)
  assert.equal(node.x, position.x); assert.equal(node.y, position.y)
  assert.equal(layout.alpha, alpha)
  assert.equal(layout.active, false, 'a settled layout must stop integrating')
  assert.deepEqual(data, before, 'the RPC snapshot must never be mutated')
  layout.update({ nodes: data.nodes.slice(0, 4), edges: data.edges.slice(0, 3) })
  layout.update(data)
  assert.equal(layout.nodes[0], node, 'positions live in the cache, not in the snapshot objects')
  layout.dispose()
})

test('disconnected 200-node layout stays finite, separated and framed without boundary clamping', () => {
  const layout = createForceLayout()
  layout.update(graph(200, false)); layout.settle(300)
  const camera = fitCamera(layout.nodes, 340, 380)
  for (const n of layout.nodes) {
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y))
    const x = n.x * camera.k + camera.x, y = n.y * camera.k + camera.y
    assert.ok(x > 30 && x < 310 && y > 30 && y < 350)
  }
  for (let i = 0; i < layout.nodes.length; i++) for (let j = i + 1; j < layout.nodes.length; j++) {
    const a = layout.nodes[i], b = layout.nodes[j]
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > a.radius + b.radius, 'nodes must not overlap')
  }
  layout.dispose()
})

test('invalid/self edges are ignored, input bounded, node order deterministic', () => {
  const data = graph(250, false)
  data.edges.push({ from: 'missing', to: 'n000' }, { from: 'n000', to: 'n000' })
  const a = createForceLayout(), b = createForceLayout()
  a.update(data)
  b.update({ nodes: [...data.nodes.slice(0, 200)].reverse(), edges: [] })
  assert.equal(a.nodes.length, 200); assert.equal(a.edges.length, 0)
  a.settle(); b.settle()
  assert.deepEqual(a.nodes.map(n => [n.id, n.x, n.y]), b.nodes.map(n => [n.id, n.x, n.y]),
    'the jitter must be deterministic, never Math.random')
  a.dispose(); b.dispose()
})

test('zoom keeps the cursor world point fixed and clamps extreme scales', () => {
  const camera = { x: 100, y: 80, k: .8 }, point = { x: 350, y: 210 }
  for (const factor of [.0001, .8, 1.25, 10000]) {
    const next = zoomCamera(camera, factor, point)
    assert.ok(Math.abs((point.x - camera.x) / camera.k - (point.x - next.x) / next.k) < 1e-8)
    assert.ok(Math.abs((point.y - camera.y) / camera.k - (point.y - next.y) / next.k) < 1e-8)
    assert.ok(next.k >= .06 && next.k <= 5)
  }
})

test('labels neither overlap each other nor node obstacles and remain inside canvas', () => {
  const candidates = Array.from({ length: 50 }, (_, i) => ({
    x: 40 + i % 8 * 40, y: 40 + Math.floor(i / 8) * 40, radius: 5, textWidth: 90,
  }))
  const obstacles = candidates.map(c => ({ x: c.x - 7, y: c.y - 7, width: 14, height: 14 }))
  const labels = placeLabels(candidates, obstacles, 360, 360)
  assert.ok(labels.length > 0 && labels.length < candidates.length)
  const intersect = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  for (let i = 0; i < labels.length; i++) {
    const a = labels[i].box
    assert.ok(a.x >= 5 && a.x + a.width <= 355 && a.y >= 5 && a.y + a.height <= 355)
    for (const b of obstacles) assert.equal(intersect(a, b), false)
    for (const b of labels.slice(i + 1)) assert.equal(intersect(a, b.box), false)
  }
})

test('pin/unpin/relayout/unpinAll keep the physics state coherent', () => {
  const layout = createForceLayout()
  const data = graph(12)
  layout.update(data); layout.settle(120)
  layout.pin('n000', 321, 123)
  assert.equal(layout.nodes[0].fx, 321); assert.equal(layout.nodes[0].x, 321)
  assert.equal(layout.nodes[0].fy, 123); assert.equal(layout.nodes[0].y, 123)
  layout.tick()
  assert.equal(layout.nodes[0].x, 321, 'a pinned node is never moved by forces')
  layout.update(structuredClone(data))
  assert.equal(layout.nodes[0].x, 321, 'a heartbeat refresh must not drop the pin')
  layout.unpin('n000')
  assert.equal(layout.nodes[0].fx, null); assert.equal(layout.nodes[0].fy, null)
  layout.pin('n001', 10, 10); layout.pin('n002', 20, 20)
  layout.unpinAll()
  assert.ok(layout.nodes.every(node => node.fx == null && node.fy == null))
  layout.relayout(); layout.settle(120)
  assert.ok(layout.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y) && node.fx == null))
  assert.equal(layout.edges.length, 11)
  layout.dispose()
})

test('relayout cools down and separates instead of shoving nodes forever', () => {
  // 「缩到最小 → 重新布局 → 打架」的回归：硬分离阈值以前写成 24 / viewScale，
  // k≈.06 时等于要求 400 世界像素间距，每帧互推、永不收敛。现在只看半径，
  // 物理也拿不到相机（setScale 已删），缩放再小也不会改变力的量级。
  assert.equal('setScale' in createForceLayout(), false, 'the physics must never be handed the camera scale')
  const layout = createForceLayout()
  layout.update(graph(60))
  layout.relayout()
  let previous = Infinity
  for (let window = 0; window < 6; window++) {
    const before = layout.nodes.map(node => [node.x, node.y])
    for (let i = 0; i < 20; i++) layout.tick()
    let maxMove = 0
    layout.nodes.forEach((node, i) => { maxMove = Math.max(maxMove, Math.hypot(node.x - before[i][0], node.y - before[i][1])) })
    assert.ok(maxMove < previous, `window ${window} must move less than the one before (${maxMove} >= ${previous})`)
    previous = maxMove
  }
  assert.ok(previous < 4, `a cooled relayout must stop shoving, saw ${previous}px per window`)
  for (let i = 0; i < layout.nodes.length; i++) for (let j = i + 1; j < layout.nodes.length; j++) {
    const a = layout.nodes[i], b = layout.nodes[j]
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > a.radius + b.radius, 'relayout must not leave nodes overlapping')
  }
  layout.dispose()
})

test('configure maps all three force sliders and reheats without ever going non-finite', () => {
  assert.equal(DEFAULT_OPTIONS.center, 0, 'center force is off by default')
  assert.equal(DEFAULT_OPTIONS.clusterScope, true)
  const layout = createForceLayout()
  layout.update(graph(40)); layout.settle(80)
  const cooled = layout.alpha
  layout.configure({ repulsion: 300, distance: 180, center: 2 })
  assert.ok(layout.alpha > cooled)
  for (let i = 0; i < 200; i++) layout.tick()
  assert.ok(layout.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)))
  layout.dispose()
})

test('drag scope freezes other clusters and repels the dragged one from them', () => {
  // 两簇各 12 节点，链状相连；A 在左，B 在右，互不连通。
  const nodes = [], edges = []
  for (let group = 0; group < 2; group++) for (let i = 0; i < 12; i++) {
    const id = `${group}-${String(i).padStart(2, '0')}`
    nodes.push({ id, title: id, kind: 'memory' })
    if (i) edges.push({ from: `${group}-${String(i - 1).padStart(2, '0')}`, to: id })
  }
  const layout = createForceLayout()
  layout.update({ nodes, edges })
  // 手动把两簇分开（布局原长由首次见到的距离决定，这里覆盖成稳定值）。
  layout.nodes.forEach((node, i) => { node.x = i < 12 ? -260 + i * 8 : 260 + (i - 12) * 8; node.y = i < 12 ? 0 : 40; node.fx = null; node.fy = null })
  layout.edges.forEach(edge => { edge.baseLen = 12 })
  layout.settle(80)
  const frozen = layout.nodes.slice(12).map(node => ({ id: node.id, x: node.x, y: node.y }))
  const dragged = layout.nodes[0]
  const scope = layout.startDragScope(dragged.id)
  assert.ok(scope?.ids.size === 12, 'the drag scope is exactly one connected component')
  assert.ok(!scope.ids.has(layout.nodes[12].id))
  const centerX = frozen.reduce((sum, n) => sum + n.x, 0) / frozen.length
  const centerY = frozen.reduce((sum, n) => sum + n.y, 0) / frozen.length
  // 把整簇硬塞到冻结簇中心：靠单向斥力把活动簇推开，冻结簇自身只当障碍。
  layout.reheat(.9)
  for (let i = 0; i < scope.members.length; i++) {
    const member = scope.members[i]
    if (member === dragged) continue
    member.x = centerX + (i % 4) * 4 - 6
    member.y = centerY + Math.floor(i / 4) * 4 - 6
    member.vx = 0; member.vy = 0
  }
  // 落点放在冻结簇包围盒之外：pin 节点优先跟手，不能被硬分离挪动。
  layout.pin(dragged.id, Math.max(...frozen.map(n => n.x)) + 60, centerY)
  for (let i = 0; i < 80; i++) layout.tick()
  layout.setDragging(false)
  for (let i = 0; i < 20; i++) layout.tick()
  // 100 ticks 内 alpha 仍高于 .05，作用域未解除，其他簇必须一像素都不动。
  for (const before of frozen) {
    const after = layout.nodeById(before.id)
    assert.equal(after.x, before.x, 'frozen clusters must not move at all')
    assert.equal(after.y, before.y)
  }
  let min = Infinity
  for (const a of scope.members) for (const b of frozen) min = Math.min(min, Math.hypot(a.x - b.x, a.y - b.y))
  assert.ok(min > 12, `clusters must not overlap (min distance ${min.toFixed(1)} world px)`)
  layout.dispose()
})

function harness(reducedMotion = true) {
  const handlers = new Map(), windowHandlers = new Map(), frames = new Map(), arcs = [], focuses = [], texts = []
  let id = 0, paints = 0
  const ctx = new Proxy({
    arc(x, y, radius) { arcs.push({ x, y, radius }) },
    measureText(text) { return { width: text.length * 7 } },
    clearRect() { paints++; arcs.length = 0; texts.length = 0 },
    fillText(text) { texts.push(String(text)) },
  }, { get(target, key) { return key in target ? target[key] : () => {} } })
  const win = {
    requestAnimationFrame(fn) { frames.set(++id, fn); return id },
    cancelAnimationFrame(id) { frames.delete(id) },
    addEventListener(type, fn) { windowHandlers.set(type, fn) },
    removeEventListener(type) { windowHandlers.delete(type) },
    getComputedStyle: () => ({ color: '#202020', getPropertyValue: () => '#ffffff' }),
    devicePixelRatio: 2,
  }
  const captures = new Set()
  const canvas = {
    style: {}, ownerDocument: { defaultView: win, documentElement: {} },
    getContext: () => ctx, getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 400 }),
    focus() {},
    setPointerCapture(id) { captures.add(id) },
    hasPointerCapture: id => captures.has(id),
    releasePointerCapture(id) { captures.delete(id) },
    addEventListener(type, fn) { handlers.set(type, fn) },
    removeEventListener(type) { handlers.delete(type) },
  }
  const view = createGraphView(canvas, { onFocus: id => focuses.push(id), reducedMotion })
  const flush = () => {
    const pending = [...frames.values()]; frames.clear()
    for (const fn of pending) fn(1000)
  }
  const emit = (type, x, y, extra = {}) => handlers.get(type)?.({
    type, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', preventDefault() {}, ...extra,
  })
  return { view, flush, emit, arcs, texts, frames, focuses, handlers, windowHandlers, getPaints: () => paints }
}

test('the detailed layer actually paints labels and the label switch silences them', () => {
  const h = harness()
  h.view.update(graph(10)); h.flush()
  assert.ok(h.texts.length > 0, 'labels must reach fillText (radius/textWidth must be finite)')
  assert.ok(h.texts.length <= 10, 'labels must never be painted more often than there are nodes')
  h.view.configure({ labels: false }); h.flush()
  assert.equal(h.texts.length, 0)
  h.view.dispose()
})

test('left drag never locks the node; right click toggles the pin; refresh preserves position', () => {
  const h = harness()
  h.view.update(graph(1)); h.flush()
  const p = { ...h.arcs[0] }
  h.emit('pointerdown', p.x, p.y)
  h.emit('pointermove', p.x + 70, p.y + 25)
  h.view.update(graph(1))
  h.flush()
  assert.equal(h.arcs[0].x, p.x + 70); assert.equal(h.arcs[0].y, p.y + 25)
  h.emit('pointerup', p.x + 70, p.y + 25); h.flush()
  assert.deepEqual(h.focuses, [], 'a drag must never focus/refetch')
  assert.equal(h.view.isPinned('n000'), false, 'a left drag must not pin the node')
  // 松手后位置留在落点，心跳刷新不把它拽回。
  for (let i = 0; i < 3; i++) { h.view.update(graph(1)); h.flush() }
  assert.equal(h.arcs[0].x, p.x + 70); assert.equal(h.arcs[0].y, p.y + 25)
  h.emit('pointerdown', p.x + 70, p.y + 25)
  h.emit('pointerup', p.x + 70, p.y + 25)
  assert.deepEqual(h.focuses, ['n000'], 'a click without movement still focuses')
  // 右键 = 锁定 / 解除，左键从不产生固定点。
  h.emit('contextmenu', p.x + 70, p.y + 25); h.flush()
  assert.equal(h.view.isPinned('n000'), true, 'right click pins the node')
  assert.equal(h.view.pinnedCount(), 1)
  assert.equal(h.arcs[0].x, p.x + 70, 'pinning must not teleport the node')
  h.emit('contextmenu', p.x + 70, p.y + 25); h.flush()
  assert.equal(h.view.isPinned('n000'), false, 'right click again unpins')
  assert.equal(h.view.pinnedCount(), 0)
  h.view.dispose()
  assert.equal(h.handlers.size, 0); assert.equal(h.frames.size, 0); assert.equal(h.windowHandlers.size, 0)
})

test('dragging an already pinned node keeps the lock at the new position', () => {
  const h = harness()
  h.view.update(graph(1)); h.flush()
  const p = { ...h.arcs[0] }
  h.emit('contextmenu', p.x, p.y); h.flush()
  assert.equal(h.view.isPinned('n000'), true)
  h.emit('pointerdown', p.x, p.y)
  h.emit('pointermove', p.x + 40, p.y + 10)
  h.emit('pointerup', p.x + 40, p.y + 10); h.flush()
  assert.equal(h.view.isPinned('n000'), true, 'an existing lock survives a left drag')
  assert.equal(h.arcs[0].x, p.x + 40)
  h.view.dispose()
})

test('pan/zoom and equivalent refresh never re-fit the camera; cancelled pointer never clicks', () => {
  const h = harness()
  h.view.update(graph(1)); h.flush()
  const before = { ...h.arcs[0] }
  h.emit('pointerdown', 30, 30); h.emit('pointermove', 70, 60); h.emit('pointerup', 70, 60); h.flush()
  assert.equal(h.arcs[0].x, before.x + 40); assert.equal(h.arcs[0].y, before.y + 30)
  h.view.zoom(.8); h.flush()
  const zoomed = { ...h.arcs[0] }
  h.view.update(graph(1)); h.flush()
  assert.deepEqual(h.arcs[0], zoomed)
  h.emit('pointerdown', zoomed.x, zoomed.y); h.emit('pointercancel', zoomed.x, zoomed.y)
  assert.deepEqual(h.focuses, [])
  h.view.dispose()
})

test('dense hit targets choose the closest node, not the last node in draw order', () => {
  const h = harness()
  h.view.update(graph(2)); h.view.zoom(.04); h.flush()
  const p = h.arcs[0], other = h.arcs[1]
  assert.ok(Math.hypot(other.x - p.x, other.y - p.y) < 10)
  h.emit('pointerdown', p.x, p.y); h.emit('pointerup', p.x, p.y)
  assert.deepEqual(h.focuses, ['n000'])
  h.view.dispose()
})

test('pinch does not trigger focus and reduced-motion/paused views do not run an idle animation loop', () => {
  const h = harness()
  h.view.update(graph(10)); h.flush()
  assert.equal(h.frames.size, 0, 'reduced motion must not keep a rAF loop alive')
  const p = h.arcs[0]
  h.emit('pointerdown', p.x, p.y, { pointerType: 'touch' })
  h.emit('pointerdown', p.x + 40, p.y, { pointerType: 'touch', pointerId: 2 })
  h.emit('pointermove', p.x + 80, p.y, { pointerType: 'touch', pointerId: 2 })
  h.emit('pointerup', p.x, p.y)
  h.emit('pointerup', p.x + 80, p.y, { pointerId: 2 })
  assert.deepEqual(h.focuses, [])
  h.view.dispose()
  const paused = harness(false)
  paused.view.configure({ motion: false }); paused.view.update(graph(10)); paused.flush()
  assert.equal(paused.frames.size, 0, 'paused motion must not keep a rAF loop alive')
  paused.view.dispose()
})

// GPU 守卫：动效开着也不能在冷却后空转重绘（曾经的实现是 30fps 永久整幅重绘）。
test('a cooled layout stops requesting frames even while motion is enabled', () => {
  const h = harness(false)
  h.view.update(graph(60))
  for (let i = 0; i < 900 && h.frames.size; i++) h.flush()
  assert.equal(h.frames.size, 0, 'a settled layout must not keep a rAF loop alive')
  const painted = h.getPaints()
  for (let i = 0; i < 200; i++) h.flush()
  assert.equal(h.getPaints(), painted, 'idle time must not repaint the canvas')
  h.view.zoom(1.2)
  assert.equal(h.frames.size, 1, 'an interaction schedules exactly one repaint')
  h.flush()
  assert.equal(h.frames.size, 0, 'that repaint must not restart the loop')
  h.view.dispose()
})

// 极小缩放下两颗节点可能只差 2-3px：纯最近邻会随鼠标 1px 抖动来回换人，
// 高亮反复切换就是用户看到的「节点互相打架闪现」。
test('hover keeps its target through 1px jitter at minimum zoom', () => {
  const h = harness()
  h.view.update(graph(2)); h.flush()
  h.view.zoom(.05); h.flush()
  const p = { ...h.arcs[0] }
  const before = h.getPaints()
  h.emit('pointermove', p.x, p.y); h.flush()
  const first = h.getPaints()
  assert.ok(first > before, 'hovering a node must repaint once')
  h.emit('pointermove', p.x + 1, p.y + 1); h.flush()
  assert.equal(h.getPaints(), first, 'a 1px nudge must not flip the hover target')
  h.view.dispose()
})

test('Escape cancels a drag and clears the focus; toolbar actions do not throw', () => {
  const h = harness()
  h.view.update(graph(3)); h.flush()
  const p = { ...h.arcs[0] }
  h.emit('pointerdown', p.x, p.y)
  h.emit('pointermove', p.x + 50, p.y + 30)
  h.emit('keydown', p.x, p.y, { key: 'Escape' })
  h.flush()
  assert.deepEqual(h.focuses, [''])
  h.view.unpinAll(); h.view.relayout(); h.view.configure({ center: 1, repulsion: 200, distance: 140 })
  h.flush()
  assert.ok(h.arcs.every(arc => Number.isFinite(arc.x) && Number.isFinite(arc.y)))
  h.view.dispose()
})

test('shipped browser bundle exposes the controller with no runtime npm imports', () => {
  const source = fs.readFileSync(new URL('../lib/webui/graph-view.bundle.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /d3-force|forceSimulation|forceManyBody|require\(/)
  const scope = { setTimeout, clearTimeout, setInterval, clearInterval, performance, Date, Math, Map, Set, JSON, console }
  vm.runInNewContext(source, scope)
  const api = scope.DshMemuGraph
  assert.equal(typeof api.createGraphView, 'function')
  assert.equal(typeof api.createForceLayout, 'function')
  assert.equal(typeof api.fitCamera, 'function')
  assert.equal(typeof api.zoomCamera, 'function')
  assert.equal(typeof api.placeLabels, 'function')
  assert.equal(api.DEFAULT_OPTIONS.center, 0)
  assert.equal(api.DEFAULT_OPTIONS.clusterScope, true)
})
