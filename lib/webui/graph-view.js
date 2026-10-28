import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY } from 'd3-force'

const LIMIT = 200
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
export const DEFAULT_OPTIONS = Object.freeze({ repulsion: 120, distance: 100, labels: true, motion: true })

// D3 owns mutable physics objects; never let it mutate an RPC snapshot.
export function createLayout() {
  const cache = new Map()
  let nodes = [], edges = [], signature = ''
  let options = { ...DEFAULT_OPTIONS }
  const simulation = forceSimulation().stop().alphaDecay(.035).velocityDecay(.48)
    .force('charge', forceManyBody().strength(-options.repulsion).distanceMax(1400))
    .force('collision', forceCollide(node => node.radius + 12).iterations(2))
    .force('x', forceX(0).strength(.025))
    .force('y', forceY(0).strength(.025))
  const update = graph => {
    const input = [...new Map((graph.nodes || []).slice(0, LIMIT).map(node => [node.id, node])).values()]
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    const ids = new Set(input.map(node => node.id))
    const links = (graph.edges || []).filter(edge => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to)
    const nextSignature = JSON.stringify([input.map(node => node.id), links.map(edge => [edge.from, edge.to]).sort()])
    const changed = signature !== nextSignature
    const degree = new Map()
    for (const edge of links) {
      degree.set(edge.from, (degree.get(edge.from) || 0) + 1)
      degree.set(edge.to, (degree.get(edge.to) || 0) + 1)
    }
    const fresh = input.filter(node => !cache.has(node.id))
    for (let i = 0; i < fresh.length; i++) {
      const node = fresh[i]
      const neighbors = links.filter(edge => edge.from === node.id || edge.to === node.id)
        .map(edge => cache.get(edge.from === node.id ? edge.to : edge.from)).filter(Boolean)
      const angle = i * 2.399963229728653
      const radius = neighbors.length ? 32 : 24 * Math.sqrt(i + .5)
      const x = neighbors.length ? neighbors.reduce((sum, n) => sum + n.x, 0) / neighbors.length : 0
      const y = neighbors.length ? neighbors.reduce((sum, n) => sum + n.y, 0) / neighbors.length : 0
      cache.set(node.id, { id: node.id, x: x + Math.cos(angle) * radius, y: y + Math.sin(angle) * radius, vx: 0, vy: 0 })
    }
    nodes = input.map(data => Object.assign(cache.get(data.id), data, {
      degree: degree.get(data.id) || 0,
      radius: 4 + Math.min(3, Math.log2(1 + (degree.get(data.id) || 0))) + clamp(Number(data.strength) || 0, 0, 1) * 2,
    }))
    edges = links.map(edge => ({ ...edge, source: cache.get(edge.from), target: cache.get(edge.to) }))
    if (changed) {
      simulation.nodes(nodes).force('link', forceLink(edges).id(node => node.id).distance(options.distance).strength(.18))
      simulation.alpha(signature ? .25 : 1)
    }
    signature = nextSignature
    // Keep positions across local-focus changes, but bound the cache for long-lived panes.
    for (const id of cache.keys()) if (cache.size > 800 && !ids.has(id)) cache.delete(id)
    return changed
  }
  return {
    simulation, update,
    get nodes() { return nodes },
    get edges() { return edges },
    configure(next) {
      options = { ...options, ...next }
      simulation.force('charge').strength(-options.repulsion)
      simulation.force('link')?.distance(options.distance)
      simulation.alpha(Math.max(.25, simulation.alpha()))
    },
    settle(ticks = 200) { simulation.tick(ticks) },
    dispose() { simulation.stop(); cache.clear() },
  }
}

export function fitCamera(nodes, width, height) {
  if (!nodes.length) return { x: width / 2, y: height / 2, k: 1 }
  const left = Math.min(...nodes.map(node => node.x - node.radius))
  const right = Math.max(...nodes.map(node => node.x + node.radius))
  const top = Math.min(...nodes.map(node => node.y - node.radius))
  const bottom = Math.max(...nodes.map(node => node.y + node.radius))
  const k = clamp(Math.min(Math.max(32, width - 100) / Math.max(120, right - left),
    Math.max(32, height - 96) / Math.max(120, bottom - top)), .06, 1.6)
  return { x: width / 2 - (left + right) * k / 2, y: height / 2 - (top + bottom) * k / 2, k }
}

export function zoomCamera(camera, factor, point) {
  const k = clamp(camera.k * factor, .06, 5)
  return { k, x: point.x - (point.x - camera.x) * k / camera.k, y: point.y - (point.y - camera.y) * k / camera.k }
}

const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

export function placeLabels(candidates, obstacles, width, height) {
  const occupied = [...obstacles], labels = []
  for (const candidate of candidates) {
    const { x, y, radius, textWidth } = candidate
    const positions = [
      { x: x - textWidth / 2, y: y + radius + 5 },
      { x: x - textWidth / 2, y: y - radius - 21 },
      { x: x + radius + 6, y: y - 8 },
      { x: x - radius - textWidth - 6, y: y - 8 },
    ]
    if (candidate.priority) for (const offset of [28, 48, 72]) positions.push(
      { x: x - textWidth / 2, y: y + radius + offset },
      { x: x - textWidth / 2, y: y - radius - 16 - offset },
      { x: x + radius + offset, y: y - 8 },
      { x: x - radius - textWidth - offset, y: y - 8 },
    )
    const box = positions.map(p => ({ ...p, width: textWidth, height: 16 }))
      .find(box => box.x >= 5 && box.y >= 5 && box.x + box.width <= width - 5 && box.y + box.height <= height - 5 &&
        !occupied.some(other => overlaps(box, other)))
    if (!box) continue
    occupied.push({ x: box.x - 3, y: box.y - 2, width: box.width + 6, height: box.height + 4 })
    labels.push({ ...candidate, box })
  }
  return labels
}

export function createGraphView(canvas, { onFocus = () => {}, onZoom = () => {}, tooltip, reducedMotion = false, emptyLabel = '' } = {}) {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D is unavailable')
  const layout = createLayout()
  let width = 1, height = 1, ratio = 1, camera = { x: 0, y: 0, k: 1 }
  let options = { ...DEFAULT_OPTIONS }, focused = '', hovered = null, gesture = null
  let initialized = false, disposed = false, frame = null, lastTime = 0, accumulator = 0
  const pointers = new Map(), cleanup = []
  const win = canvas.ownerDocument.defaultView
  const world = point => ({ x: (point.x - camera.x) / camera.k, y: (point.y - camera.y) / camera.k })
  const screen = node => ({ x: node.x * camera.k + camera.x, y: node.y * camera.k + camera.y })
  const radius = node => clamp(node.radius * Math.sqrt(camera.k), 2.5, 22)
  const point = event => {
    const rect = canvas.getBoundingClientRect()
    return { x: (event.clientX - rect.left) * width / rect.width, y: (event.clientY - rect.top) * height / rect.height }
  }
  const hit = p => {
    let closest = null, distance = Infinity
    for (const node of layout.nodes) {
      const s = screen(node), d = Math.hypot(s.x - p.x, s.y - p.y)
      if (d <= Math.max(10, radius(node) + 4) && d < distance) { closest = node; distance = d }
    }
    return closest
  }
  const hideTooltip = () => { if (tooltip) tooltip.hidden = true }
  const setHover = (node, p) => {
    if (hovered !== node) { hovered = node; requestDraw() }
    canvas.style.cursor = gesture ? 'grabbing' : node ? 'pointer' : 'grab'
    if (!tooltip) return
    tooltip.hidden = !node || !!gesture
    if (!node || gesture) return
    tooltip.textContent = String(node.title || node.id)
    tooltip.style.left = `${clamp(p.x + 14, 6, Math.max(6, width - Math.min(260, width - 12)))}px`
    tooltip.style.top = `${(canvas.offsetTop || 0) + clamp(p.y + 16, 6, height - 60)}px`
  }
  const draw = () => {
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)
    const style = win.getComputedStyle(canvas)
    const foreground = style.color
    const background = style.getPropertyValue('--dsw-alias-bg-layer-1').trim() || '#ffffff'
    const active = hovered?.id || focused
    const neighbors = new Set(active ? [active] : [])
    for (const edge of layout.edges) {
      if (edge.from === active) neighbors.add(edge.to)
      if (edge.to === active) neighbors.add(edge.from)
    }
    context.strokeStyle = foreground
    for (const edge of layout.edges) {
      const a = screen(edge.source), b = screen(edge.target)
      const highlighted = active && (edge.from === active || edge.to === active)
      context.globalAlpha = highlighted ? .6 : active ? .055 : .16
      context.lineWidth = highlighted ? 1.5 : .8
      context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke()
    }
    const visible = layout.nodes.map(node => ({ node, ...screen(node), radius: radius(node) }))
      .filter(p => p.x >= -30 && p.x <= width + 30 && p.y >= -30 && p.y <= height + 30)
    for (const p of visible) {
      const node = p.node
      const color = node.missing ? '#92959c' : node.kind !== 'memory' ? '#36a582' : node.layer === 'must_remember' ? '#d97768' : '#618fcd'
      context.globalAlpha = active && !neighbors.has(node.id) ? .22 : 1
      context.fillStyle = color
      context.beginPath(); context.arc(p.x, p.y, p.radius, 0, Math.PI * 2); context.fill()
      if (node.id === active) {
        context.strokeStyle = color; context.lineWidth = 1.5
        context.beginPath(); context.arc(p.x, p.y, p.radius + 4, 0, Math.PI * 2); context.stroke()
      }
    }
    context.globalAlpha = 1
    if (options.labels) {
      context.font = '12px system-ui, sans-serif'
      const candidates = visible.filter(p => !active || neighbors.has(p.node.id))
        .filter(p => camera.k >= .45 || p.node.id === active || p.node.degree >= 3 || layout.nodes.length < 30)
        .sort((a, b) => Number(b.node.id === active) - Number(a.node.id === active) || b.node.degree - a.node.degree ||
          String(a.node.id).localeCompare(String(b.node.id)))
        .map(p => {
          const title = String(p.node.title || p.node.id)
          let text = title
          while (text.length > 1 && context.measureText(text).width > Math.min(136, width - 24)) text = text.slice(0, -1)
          if (text !== title) text = text.slice(0, -2) + '...'
          return { ...p, text, textWidth: context.measureText(text).width + 4, priority: p.node.degree >= 3 || p.node.id === active }
        })
      const labels = placeLabels(candidates, visible.map(p => ({
        x: p.x - p.radius - 2, y: p.y - p.radius - 2, width: p.radius * 2 + 4, height: p.radius * 2 + 4,
      })), width, height)
      context.textAlign = 'left'; context.textBaseline = 'top'
      for (const label of labels) {
        const anchor = { x: clamp(label.x, label.box.x, label.box.x + label.box.width),
          y: clamp(label.y, label.box.y, label.box.y + label.box.height) }
        if (Math.hypot(anchor.x - label.x, anchor.y - label.y) > label.radius + 18) {
          context.globalAlpha = .25; context.strokeStyle = foreground; context.lineWidth = .7
          context.beginPath(); context.moveTo(label.x, label.y); context.lineTo(anchor.x, anchor.y); context.stroke()
        }
        context.fillStyle = background
        context.globalAlpha = .88
        context.fillRect(label.box.x - 1, label.box.y, label.box.width + 2, label.box.height)
        context.globalAlpha = label.node.id === active ? 1 : .78
        context.fillStyle = foreground
        context.fillText(label.text, label.box.x + 2, label.box.y + 1)
      }
      context.globalAlpha = 1
    }
    if (!layout.nodes.length && emptyLabel) {
      context.font = '13px system-ui, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'
      context.fillStyle = foreground; context.globalAlpha = .55
      context.fillText(emptyLabel, width / 2, height / 2); context.globalAlpha = 1
    }
  }
  const animate = time => {
    frame = null
    if (disposed) return
    if (options.motion && !reducedMotion && layout.simulation.alpha() > layout.simulation.alphaMin()) {
      accumulator += lastTime ? Math.min(64, time - lastTime) : 17
      for (; accumulator >= 1000 / 60; accumulator -= 1000 / 60) layout.simulation.tick()
      lastTime = time
      requestDraw()
    } else { lastTime = 0; accumulator = 0 }
    draw()
  }
  function requestDraw() {
    if (!disposed && frame === null) frame = win.requestAnimationFrame(animate)
  }
  const notifyCamera = () => { onZoom(camera.k); requestDraw() }
  const fit = () => { camera = fitCamera(layout.nodes, width, height); hideTooltip(); notifyCamera() }
  const zoom = (factor, p = { x: width / 2, y: height / 2 }) => { camera = zoomCamera(camera, factor, p); hideTooltip(); notifyCamera() }
  const resize = () => {
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const nextWidth = rect.width, nextHeight = rect.height
    camera.x += (nextWidth - width) / 2; camera.y += (nextHeight - height) / 2
    width = nextWidth; height = nextHeight; ratio = Math.min(2, win.devicePixelRatio || 1)
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio)
    requestDraw()
  }
  const releaseNode = () => {
    if (gesture?.node) {
      gesture.node.fx = null; gesture.node.fy = null
      gesture.node.vx = 0; gesture.node.vy = 0
    }
  }
  const startPinch = () => {
    releaseNode()
    const [a, b] = [...pointers.values()]
    gesture = { type: 'pinch', distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), camera: { ...camera },
      center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, moved: true }
  }
  const down = event => {
    if (event.button !== 0 && event.pointerType !== 'touch') return
    event.preventDefault()
    canvas.focus({ preventScroll: true })
    const p = point(event)
    pointers.set(event.pointerId, p)
    canvas.setPointerCapture?.(event.pointerId)
    if (pointers.size >= 2) { startPinch(); hideTooltip(); return }
    const node = hit(p)
    gesture = { type: node ? 'node' : 'pan', node, start: p, camera: { ...camera }, moved: false,
      offset: node ? { x: node.x - world(p).x, y: node.y - world(p).y } : null }
    if (node) { node.fx = node.x; node.fy = node.y; node.vx = 0; node.vy = 0 }
    hideTooltip()
    canvas.style.cursor = 'grabbing'
  }
  const move = event => {
    const p = point(event)
    if (!pointers.has(event.pointerId) || !gesture) { setHover(hit(p), p); return }
    pointers.set(event.pointerId, p)
    if (gesture.type === 'pinch') {
      if (pointers.size < 2) return
      const [a, b] = [...pointers.values()]
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      camera = zoomCamera(gesture.camera, Math.hypot(b.x - a.x, b.y - a.y) / gesture.distance, gesture.center)
      camera.x += center.x - gesture.center.x; camera.y += center.y - gesture.center.y
      notifyCamera()
    } else {
      gesture.moved ||= Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y) > 5
      if (!gesture.moved) return
      if (gesture.node) {
        const w = world(p), node = gesture.node
        node.x = node.fx = w.x + gesture.offset.x; node.y = node.fy = w.y + gesture.offset.y
        node.vx = 0; node.vy = 0
        layout.simulation.alpha(Math.max(.08, layout.simulation.alpha()))
      } else {
        camera.x = gesture.camera.x + p.x - gesture.start.x; camera.y = gesture.camera.y + p.y - gesture.start.y
      }
      requestDraw()
    }
  }
  const up = event => {
    if (!pointers.has(event.pointerId)) return
    const cancelled = event.type !== 'pointerup'
    const selected = gesture?.node
    const click = !cancelled && !gesture?.moved && gesture?.type !== 'pinch'
    releaseNode()
    pointers.delete(event.pointerId)
    gesture = null
    // A remaining finger may pan, but must never turn a pinch into a node click.
    if (pointers.size) {
      const p = [...pointers.values()][0]
      gesture = { type: 'pan', start: p, camera: { ...camera }, moved: true }
    }
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    if (click) onFocus(selected?.id || '')
    hovered = null; canvas.style.cursor = 'grab'; hideTooltip(); requestDraw()
  }
  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts)
    cleanup.push(() => target.removeEventListener(type, fn, opts))
  }
  listen(canvas, 'pointerdown', down)
  listen(canvas, 'pointermove', move)
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(canvas, type, up)
  listen(canvas, 'pointerleave', () => { if (!gesture) { hovered = null; hideTooltip(); requestDraw() } })
  listen(canvas, 'wheel', event => { event.preventDefault(); zoom(Math.exp(-clamp(event.deltaY, -160, 160) * .0025), point(event)) }, { passive: false })
  listen(canvas, 'keydown', event => {
    if (event.key === '+' || event.key === '=') zoom(1.25)
    else if (event.key === '-') zoom(.8)
    else if (event.key === '0' || event.key === 'Home') fit()
    else if (event.key === 'Escape') { releaseNode(); gesture = null; pointers.clear(); onFocus(''); hideTooltip(); requestDraw() }
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      const step = event.shiftKey ? 90 : 30
      camera.x += event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0
      camera.y += event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0
      requestDraw()
    } else return
    event.preventDefault()
  })
  listen(win, 'blur', () => { releaseNode(); gesture = null; pointers.clear(); hovered = null; hideTooltip(); requestDraw() })
  const observer = win.ResizeObserver ? new win.ResizeObserver(resize) : null
  observer?.observe(canvas)
  listen(win, 'resize', resize)
  const themeObserver = win.MutationObserver ? new win.MutationObserver(requestDraw) : null
  themeObserver?.observe(canvas.ownerDocument.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
  if (canvas.ownerDocument.body) themeObserver?.observe(canvas.ownerDocument.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
  resize()
  return {
    update(graph, focus = '') {
      // A response may arrive mid-drag. End only gestures whose node disappeared.
      if (gesture?.node && !graph.nodes.some(node => node.id === gesture.node.id)) {
        releaseNode(); gesture = null; pointers.clear()
      }
      const changed = layout.update(graph)
      focused = focus
      if (hovered && !layout.nodes.includes(hovered)) { hovered = null; hideTooltip() }
      if (!initialized && layout.nodes.length) {
        layout.settle(220); initialized = true; fit()
      } else if (changed && reducedMotion) layout.settle(180)
      requestDraw()
    },
    configure(next) {
      const forcesChanged = next.repulsion !== undefined && next.repulsion !== options.repulsion ||
        next.distance !== undefined && next.distance !== options.distance
      options = { ...options, ...next }
      if (forcesChanged) {
        layout.configure(options)
        if (reducedMotion) layout.settle(180)
      }
      requestDraw()
    },
    fit, zoom,
    dispose() {
      disposed = true; releaseNode()
      if (frame !== null) win.cancelAnimationFrame(frame)
      for (const remove of cleanup) remove()
      observer?.disconnect(); themeObserver?.disconnect(); layout.dispose(); hideTooltip()
    },
  }
}
