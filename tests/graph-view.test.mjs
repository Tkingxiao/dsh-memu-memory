import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import fs from 'node:fs'
import { createLayout, createGraphView, fitCamera, zoomCamera, placeLabels } from '../lib/webui/graph-view.js'

const graph = (count, connected = true) => ({
  nodes: Array.from({ length: count }, (_, i) => ({ id: `n${String(i).padStart(3, '0')}`, title: `Memory ${i}`, kind: 'memory', strength: .5 })),
  edges: connected ? Array.from({ length: count - 1 }, (_, i) => ({ from: `n${String(i).padStart(3, '0')}`, to: `n${String(i + 1).padStart(3, '0')}` })) : [],
})

test('layout preserves object identity, positions and cooling on equivalent refreshed snapshots', () => {
  const data = graph(30), before = structuredClone(data), layout = createLayout()
  layout.update(data); layout.settle()
  const node = layout.nodes[0], position = { x: node.x, y: node.y }, alpha = layout.simulation.alpha()
  assert.equal(layout.update(structuredClone(data)), false)
  assert.equal(layout.nodes[0], node)
  assert.equal(node.x, position.x); assert.equal(node.y, position.y)
  assert.equal(layout.simulation.alpha(), alpha)
  assert.deepEqual(data, before)
  layout.update({ nodes: data.nodes.slice(0, 4), edges: data.edges.slice(0, 3) })
  layout.update(data)
  assert.equal(layout.nodes[0], node)
  assert.equal(node.x, position.x)
  layout.dispose()
})

test('disconnected 200-node layout stays finite, separated and framed without boundary clamping', () => {
  const layout = createLayout()
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
  const a = createLayout(), b = createLayout()
  a.update(data)
  b.update({ nodes: [...data.nodes.slice(0, 200)].reverse(), edges: [] })
  assert.equal(a.nodes.length, 200); assert.equal(a.edges.length, 0)
  a.settle(); b.settle()
  assert.deepEqual(a.nodes.map(n => [n.id, n.x, n.y]), b.nodes.map(n => [n.id, n.x, n.y]))
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

function harness(reducedMotion = true) {
  const handlers = new Map(), windowHandlers = new Map(), frames = new Map(), arcs = [], focuses = []
  let id = 0
  const ctx = new Proxy({
    arc(x, y, radius) { arcs.push({ x, y, radius }) },
    measureText(text) { return { width: text.length * 7 } },
    clearRect() { arcs.length = 0 },
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
  return { view, flush, emit, arcs, frames, focuses, handlers, windowHandlers }
}

test('dragging after cooling pins the node without click/refocus, and refresh keeps pixel position', () => {
  const h = harness()
  h.view.update(graph(1)); h.flush()
  const p = { ...h.arcs[0] }
  h.emit('pointerdown', p.x, p.y)
  h.emit('pointermove', p.x + 70, p.y + 25)
  h.view.update(graph(1))
  h.flush()
  assert.equal(h.arcs[0].x, p.x + 70); assert.equal(h.arcs[0].y, p.y + 25)
  h.emit('pointerup', p.x + 70, p.y + 25); h.flush()
  assert.deepEqual(h.focuses, [])
  h.emit('pointerdown', p.x + 70, p.y + 25)
  h.emit('pointerup', p.x + 70, p.y + 25)
  assert.deepEqual(h.focuses, ['n000'])
  h.view.dispose()
  assert.equal(h.handlers.size, 0); assert.equal(h.frames.size, 0); assert.equal(h.windowHandlers.size, 0)
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
  assert.equal(h.frames.size, 0)
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
  assert.equal(paused.frames.size, 0)
  paused.view.dispose()
})

test('shipped browser bundle exposes the controller with no runtime npm imports', () => {
  const source = fs.readFileSync(new URL('../lib/webui/graph-view.bundle.js', import.meta.url), 'utf8')
  const scope = { setTimeout, clearTimeout, setInterval, clearInterval, performance }
  vm.runInNewContext(source, scope)
  assert.equal(typeof scope.DshMemuGraph.createGraphView, 'function')
  assert.equal(typeof scope.DshMemuGraph.createLayout, 'function')
})
