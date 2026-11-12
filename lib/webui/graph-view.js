// 自研力导向关系图引擎：零第三方运行时依赖。
// 数据契约沿用 getGraph：{ nodes:[{id,title,kind,layer,strength,missing,status}], edges:[{from,to,...}] }。
// 物理：空间网格近程斥力 + 连线弹簧 + 可选向心力；fx/fy 非空 = 固定点（pin）。
// 拖动时只模拟「被拖节点的连通簇」，其他簇冻结但作为斥力障碍，避免重合。

const TAU = Math.PI * 2
const GOLDEN_ANGLE = 2.399963229728653
const INPUT_LIMIT = 200 // 与 getGraph 的 limit 对齐
const CACHE_LIMIT = 800
const PHYSICS_KEYS = new Set(['x', 'y', 'vx', 'vy', 'fx', 'fy'])
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

export const DEFAULT_OPTIONS = Object.freeze({
  repulsion: 120, // 斥力滑杆 30..350 -> SIM.repel * repulsion/120
  distance: 100,  // 连线距离滑杆 40..220 -> baseLen * distance/100
  center: 0,      // 向心力滑杆 0..3，默认关闭（避免小簇被吸到质心）
  labels: true,
  motion: true,
  grid: true,         // 画布背景网格点（Graph Studio 侧栏开关）
  clusterScope: true, // 拖动只模拟连通簇，UI 不暴露
})

const SIM = Object.freeze({
  cell: 120, range: 150, repel: 900, link: .9, centerForce: .012,
  vDecay: .6, alphaDecay: .025, alphaTarget: .02,
})

// 明暗主题下均可读的固定色板；激活色另取宿主 token。
const NODE_COLORS = Object.freeze({
  memory: '#618fcd', must: '#d97768', short: '#8a93a6', entity: '#36a582',
  provisional: '#b9963f', global: '#8b7bd8', missing: '#92959c',
})
// evidence.rule 的固定色板（明暗都可读），与 graph-studio 的 paper 主题一致。
const EDGE_RULES = Object.freeze({
  'entity-mention': '#4f6bdb', conflict: '#d9705f', supersede: '#c08a49',
  'fact-key': '#7a8fbc', 'worker-quote': '#8a7cc0',
})
const edgeColor = (edge, foreground, accent) =>
  edge.rule && EDGE_RULES[edge.rule] ? EDGE_RULES[edge.rule] : edge.manual ? accent : foreground

const nodeColor = node => node.missing ? NODE_COLORS.missing
  : node.kind === 'global' ? NODE_COLORS.global
    : node.kind !== 'memory' ? (node.status === 'provisional' ? NODE_COLORS.provisional : NODE_COLORS.entity)
      : node.layer === 'must_remember' ? NODE_COLORS.must
        : node.layer === 'short_term' ? NODE_COLORS.short : NODE_COLORS.memory

const hashId = value => {
  let hash = 2166136261
  const text = String(value)
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619) }
  return hash >>> 0
}
const cellKey = (x, y) => `${Math.floor(x / SIM.cell)},${Math.floor(y / SIM.cell)}`

// ---- 纯布局：不碰 DOM，供单测直接驱动 ------------------------------------
export function createForceLayout(initialOptions = {}) {
  const cache = new Map()
  const edgeLengths = new Map()
  let nodes = [], edges = [], adjacency = new Map(), components = null
  let signature = '', alpha = 1, options = { ...DEFAULT_OPTIONS, ...initialOptions }
  let dragComp = null, dragging = false, settling = false, viewScale = 1
  let layoutInitialized = false

  const factors = () => ({
    repel: clamp(options.repulsion, 1, 1000) / 120,
    linkDist: clamp(options.distance, 1, 1000) / 100,
    center: clamp(options.center, 0, 20),
  })
  const baseLenOf = (source, target) => clamp(Math.hypot(source.x - target.x, source.y - target.y) || 56, 48, 160)

  const buildAdjacency = () => {
    const map = new Map()
    for (const edge of edges) {
      if (!map.has(edge.from)) map.set(edge.from, new Set())
      if (!map.has(edge.to)) map.set(edge.to, new Set())
      map.get(edge.from).add(edge.to)
      map.get(edge.to).add(edge.from)
    }
    return map
  }
  // 连通分量按 id 建表，成员引用 cache 里的物理对象；对象身份跨 update 不变。
  const buildComponents = () => {
    const map = new Map()
    for (const node of nodes) {
      if (map.has(node.id)) continue
      const ids = new Set([node.id]), queue = [node.id], members = []
      for (let i = 0; i < queue.length; i++) {
        const id = queue[i], state = cache.get(id)
        if (state) members.push(state)
        for (const next of adjacency.get(id) || []) if (!ids.has(next)) { ids.add(next); queue.push(next) }
      }
      const comp = { ids, members }
      for (const id of ids) map.set(id, comp)
    }
    return map
  }

  const reheat = value => { alpha = Math.max(alpha, value) }
  const componentOf = id => options.clusterScope && components ? components.get(id) : null

  // ---- 花瓣向心布局：从 graph-studio 的 layoutFlower / packDisc / wrapRim 移植 ----
  // 最大簇居中、其余同心环贴着外沿铺开；簇少时把外围簇的节点摊到外圆周上，
  // 所以整体轮廓收成一个圆，而不是散开的螺旋。力模拟只在这个形状上做微调。
  const RING_GAP = 18
  const densityScale = count => clamp(Math.sqrt(900 / Math.max(900, count)), .56, 1)

  const buildGroups = () => {
    const groups = [], seen = new Set()
    for (const node of nodes) {
      if (seen.has(node.id)) continue
      const comp = components?.get(node.id)
      const ids = comp ? [...comp.ids] : [node.id]
      for (const id of ids) seen.add(id)
      const adj = new Map(ids.map(id => [id, []]))
      for (const edge of edges) {
        if (!adj.has(edge.from) || !adj.has(edge.to)) continue
        adj.get(edge.from).push(edge.to)
        adj.get(edge.to).push(edge.from)
      }
      // 根：度数最大；同度时实体优先，再按 id 稳定排序。
      let root = ids[0], bestScore = -1
      for (const id of ids) {
        const nd = cache.get(id)
        const score = (adj.get(id)?.length || 0) * 10 + (nd?.kind === 'memory' ? 0 : 3)
        if (score > bestScore || (score === bestScore && id < root)) { root = id; bestScore = score }
      }
      const parent = new Map([[root, null]])
      const kids = new Map([[root, []]])
      const level = new Map([[root, 0]])
      const order = [root]
      for (let i = 0; i < order.length; i++) {
        const id = order[i]
        for (const next of adj.get(id) || []) {
          if (parent.has(next)) continue
          parent.set(next, id); kids.set(next, []); level.set(next, level.get(id) + 1)
          kids.get(id).push(next); order.push(next)
        }
      }
      // 子树体量：重枝分到更宽的扇区，兄弟之间才不会挤在一起。
      const weight = new Map()
      for (let i = order.length - 1; i >= 0; i--) {
        const id = order[i]
        let w = 0
        for (const k of kids.get(id) || []) w += weight.get(k)
        weight.set(id, w || 1)
      }
      groups.push({ ids, root, kids, weight })
    }
    groups.sort((a, b) => b.ids.length - a.ids.length)
    return groups
  }

  const placeFlower = (group, ring, minChord, maxRing) => {
    const rootNode = cache.get(group.root)
    if (!rootNode) return
    rootNode.x = 0; rootNode.y = 0
    const stack = [{ id: group.root, x: 0, y: 0, dir: -Math.PI / 2, span: Math.PI * 2 }]
    while (stack.length) {
      const cur = stack.pop()
      const list = group.kids.get(cur.id)
      if (!list || !list.length) continue
      const arr = list.length > 1 ? list.slice().sort((a, b) => group.weight.get(b) - group.weight.get(a)) : list
      let total = 0
      for (const k of arr) total += group.weight.get(k)
      let minShare = Infinity
      for (const k of arr) minShare = Math.min(minShare, cur.span * group.weight.get(k) / total)
      let radius = ring
      if (arr.length > 1 && minShare > 1e-6) {
        radius = Math.max(ring, minChord / (2 * Math.sin(Math.min(Math.PI, minShare) / 2)))
      }
      if (radius > maxRing) radius = maxRing
      // 只有一个孩子时方向轻微偏转：一串记忆会卷成弧形，而不是一条直线。
      const curl = arr.length === 1 ? .62 : 0
      let cursor = cur.dir - cur.span / 2
      for (const k of arr) {
        const share = cur.span * group.weight.get(k) / total
        const a = cursor + share / 2 + curl
        const kn = cache.get(k)
        if (kn) { kn.x = cur.x + Math.cos(a) * radius; kn.y = cur.y + Math.sin(a) * radius }
        stack.push({ id: k, x: kn ? kn.x : cur.x, y: kn ? kn.y : cur.y, dir: a, span: share })
        cursor += share
      }
    }
  }

  // 用「分角度的最大半径」的方差当圆度评分，找方差最小的整体旋转角。
  const chooseRoundestRotation = list => {
    const BINS = 36
    const base = new Float64Array(BINS)
    const head = list[0]
    const binOf = a => Math.min(BINS - 1, Math.floor((a + Math.PI) / (Math.PI * 2) * BINS))
    for (const id of head.ids) {
      const node = cache.get(id)
      if (!node) continue
      const r = Math.hypot(node.x - (head.cx || 0), node.y - (head.cy || 0))
      const b = binOf(Math.atan2(node.y - (head.cy || 0), node.x - (head.cx || 0)))
      if (r > base[b]) base[b] = r
    }
    let bestDelta = 0, bestScore = Infinity
    for (let t = 0; t < 36; t++) {
      const delta = t / 36 * Math.PI * 2
      const prof = Float64Array.from(base)
      for (let i = 1; i < list.length; i++) {
        const g = list[i]
        const d = Math.hypot(g.ax, g.ay)
        const ang = Math.atan2(g.ay, g.ax) + delta
        const r = g.radius
        for (let b = 0; b < BINS; b++) {
          const a = -Math.PI + (b + .5) / BINS * Math.PI * 2
          let diff = a - ang
          while (diff > Math.PI) diff -= Math.PI * 2
          while (diff < -Math.PI) diff += Math.PI * 2
          const perp = d * Math.sin(diff)
          if (Math.abs(perp) >= r || Math.abs(diff) >= Math.PI / 2) continue
          const reach = d * Math.cos(diff) + Math.sqrt(r * r - perp * perp)
          if (reach > prof[b]) prof[b] = reach
        }
      }
      let mean = 0
      for (let b = 0; b < BINS; b++) mean += prof[b]
      mean /= BINS
      let score = 0
      for (let b = 0; b < BINS; b++) score += (prof[b] - mean) * (prof[b] - mean)
      if (score < bestScore) { bestScore = score; bestDelta = delta }
    }
    if (!bestDelta) return
    const cos = Math.cos(bestDelta), sin = Math.sin(bestDelta)
    for (let i = 1; i < list.length; i++) {
      const g = list[i]
      const x = g.ax, y = g.ay
      g.ax = x * cos - y * sin; g.ay = x * sin + y * cos
    }
  }

  // 圆盘排布：最大的一团居中，其余一圈圈贴着它往外铺，整环外沿落在同一个圆上。
  const packDisc = groups => {
    const list = groups.slice().sort((a, b) => b.radius - a.radius)
    if (!list.length) return
    list[0].ax = 0; list[0].ay = 0
    let cursor = list[0].radius + RING_GAP
    let i = 1, ringIdx = 1
    while (i < list.length) {
      const ring = []
      let used = 0, j = i
      while (j < list.length) {
        const c = list[j], d = cursor + c.radius
        const need = (2 * c.radius + RING_GAP) / Math.max(1, d)
        if (ring.length && used + need > Math.PI * 2) break
        ring.push({ c, d, need }); used += need; j++
      }
      let total = 0, outer = cursor
      for (const item of ring) { total += item.need; outer = Math.max(outer, item.d + item.c.radius) }
      const start = -Math.PI / 2 + ringIdx * 0.9
      let acc = 0
      for (const item of ring) {
        const need = (2 * item.c.radius + RING_GAP) / Math.max(1, item.d)
        const mid = start + ((acc + need / 2) / Math.max(1e-6, total)) * Math.PI * 2
        item.c.ax = Math.cos(mid) * item.d; item.c.ay = Math.sin(mid) * item.d
        acc += need
      }
      cursor = outer + RING_GAP; i = j; ringIdx++
    }
    if (list.length <= 12) chooseRoundestRotation(list)
  }

  // 簇少时把外围簇的节点沿外圆周摊开：局部 x 映射成角度，圆周真的被节点填满。
  // 关键约束：摊开的角跨度按「每个节点约一个 RING 弧长」反推，绝不把小簇
  // 仅有的几个节点摊满整个扇区 —— 否则同一簇里的一二级节点会被拉到几百像素外。
  const wrapRim = (groups, ring) => {
    const sats = groups.filter(g => Math.hypot(g.ax, g.ay) > 1)
    if (!sats.length) return
    let R = 0
    for (const g of sats) R = Math.max(R, Math.hypot(g.ax, g.ay) + g.radius * .5)
    const sector = Math.PI * 2 / sats.length
    sats.sort((a, b) => Math.atan2(a.ay, a.ax) - Math.atan2(b.ay, b.ax))
    for (let i = 0; i < sats.length; i++) {
      const g = sats[i]
      const list = g.ids.map(id => cache.get(id)).filter(Boolean)
      if (!list.length) continue
      let minX = Infinity, maxX = -Infinity
      for (const node of list) {
        const lx = node.x - g.ax
        if (lx < minX) minX = lx
        if (lx > maxX) maxX = lx
      }
      const span = Math.max(1, maxX - minX)
      const base = -Math.PI / 2 + (i + .5) * sector
      // 每个节点至少占 ring 的弧长；簇小的时候只占扇区的一小段。
      const spread = Math.min(sector * .94, Math.max(1, list.length) * (ring / Math.max(R, ring)))
      for (const node of list) {
        const lx = node.x - g.ax, ly = node.y - g.ay
        const t = (lx - minX) / span - .5
        const ang = base + t * spread
        // 径向只用有限的抖动，避免把簇沿半径方向拉散。
        const rr = R + clamp(ly, -ring, ring) * .28
        node.x = Math.cos(ang) * rr; node.y = Math.sin(ang) * rr
      }
    }
  }

  const layoutFlower = () => {
    if (!nodes.length) return
    const scale = densityScale(nodes.length)
    const ring = 56 * scale
    const minChord = Math.max(22, 44 * scale)
    const maxRing = ring * 2.8
    const groups = buildGroups()
    for (const group of groups) {
      placeFlower(group, ring, minChord, maxRing)
      let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity
      for (const id of group.ids) {
        const node = cache.get(id)
        if (!node) continue
        if (node.x < l) l = node.x
        if (node.x > r) r = node.x
        if (node.y < t) t = node.y
        if (node.y > b) b = node.y
      }
      // 用包围盒中心当簇心：根往往在主枝上，按根对齐会让同心环歪掉。
      group.cx = (l + r) / 2; group.cy = (t + b) / 2
      const dists = []
      for (const id of group.ids) {
        const node = cache.get(id)
        if (node) dists.push(Math.hypot(node.x - group.cx, node.y - group.cy))
      }
      dists.sort((a, b) => a - b)
      const q = dists.length ? dists[Math.min(dists.length - 1, Math.floor(dists.length * .88))] : 0
      group.radius = q + 26
      if (group.cx || group.cy) {
        for (const id of group.ids) {
          const node = cache.get(id)
          if (node) { node.x -= group.cx; node.y -= group.cy }
        }
        group.cx = 0; group.cy = 0
      }
    }
    packDisc(groups)
    for (const group of groups) {
      for (const id of group.ids) {
        const node = cache.get(id)
        if (node) { node.x += group.ax; node.y += group.ay }
      }
    }
    if (groups.length <= 12) wrapRim(groups, ring)
    for (const node of cache.values()) {
      node.vx = 0; node.vy = 0; node.fx = null; node.fy = null; node.locked = false
    }
    // 记下每条边的自然长度当弹簧原长，力模拟只做微调。
    for (const edge of edges) {
      const a = edge.source, b = edge.target
      edge.baseLen = a && b ? Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) : 56
      edgeLengths.set(JSON.stringify([edge.from, edge.to, edge.kind || '']), edge.baseLen)
    }
  }

  const update = graph => {
    const input = [...new Map((graph?.nodes || []).slice(0, INPUT_LIMIT).map(node => [node.id, node])).values()]
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    const ids = new Set(input.map(node => node.id))
    const links = (graph?.edges || []).filter(edge => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to)
    const nextSignature = JSON.stringify([input.map(node => node.id), links.map(edge => [edge.from, edge.to]).sort()])
    const changed = signature !== nextSignature
    const degree = new Map()
    for (const edge of links) {
      degree.set(edge.from, (degree.get(edge.from) || 0) + 1)
      degree.set(edge.to, (degree.get(edge.to) || 0) + 1)
    }
    // 新节点按黄金角螺旋落在邻居质心附近（沿用旧播种逻辑）。
    const fresh = input.filter(node => !cache.has(node.id))
    for (let i = 0; i < fresh.length; i++) {
      const node = fresh[i]
      const neighbors = links.filter(edge => edge.from === node.id || edge.to === node.id)
        .map(edge => cache.get(edge.from === node.id ? edge.to : edge.from)).filter(Boolean)
      const angle = i * GOLDEN_ANGLE
      const radius = neighbors.length ? 32 : 24 * Math.sqrt(i + .5)
      const x = neighbors.length ? neighbors.reduce((sum, n) => sum + n.x, 0) / neighbors.length : 0
      const y = neighbors.length ? neighbors.reduce((sum, n) => sum + n.y, 0) / neighbors.length : 0
      cache.set(node.id, { id: node.id, x: x + Math.cos(angle) * radius, y: y + Math.sin(angle) * radius,
        vx: 0, vy: 0, fx: null, fy: null, locked: false })
    }
    // 只合并数据字段，物理字段（含 pin）永远以缓存为准：心跳刷新不会冲掉摆位。
    nodes = input.map(data => {
      const state = cache.get(data.id)
      for (const [key, value] of Object.entries(data)) if (!PHYSICS_KEYS.has(key)) state[key] = value
      state.degree = degree.get(data.id) || 0
      state.radius = 4 + Math.min(3, Math.log2(1 + state.degree)) + clamp(Number(data.strength) || 0, 0, 1) * 2
      return state
    })
    edges = links.map(edge => {
      const source = cache.get(edge.from), target = cache.get(edge.to)
      const key = JSON.stringify([edge.from, edge.to, edge.kind || ''])
      let baseLen = edgeLengths.get(key)
      // 首次见到该边时按当时两端距离记录；自定义摆位后不重算。
      if (baseLen === undefined) { baseLen = baseLenOf(source, target); edgeLengths.set(key, baseLen) }
      // source/target 必须留给物理引擎当节点引用，原始来源记在 manual 上，
      // 否则 edge.source === 'auto' 永远为假（所有边都会被画成手动虚线）。
      return { ...edge, source, target, manual: edge.source !== 'auto', baseLen }
    })
    adjacency = buildAdjacency()
    if (changed) components = buildComponents()
    // 首次拿到真实图（或切库后大部分节点都换了）时用花瓣向心布局铺开：
    // 最大簇居中、外围收成圆。之前只看 signature 是否为空会漏掉「空图先到、
    // 数据后到」的场景，导致新节点按螺旋挤在中心，必须手动点一次重新布局。
    const mostlyFresh = nodes.length > 0 && fresh.length >= Math.ceil(nodes.length * .6)
    if (changed && nodes.length && (!layoutInitialized || mostlyFresh)) {
      layoutFlower()
      layoutInitialized = true
    }
    if (changed) reheat(signature ? .25 : 1)
    signature = nextSignature
    for (const id of cache.keys()) if (cache.size > CACHE_LIMIT && !ids.has(id)) cache.delete(id)
    if (edgeLengths.size > 4000) edgeLengths.clear()
    return changed
  }

  const tick = () => {
    if (!nodes.length) return
    alpha += (SIM.alphaTarget - alpha) * SIM.alphaDecay
    if (alpha < SIM.alphaTarget) alpha = SIM.alphaTarget
    const F = factors()
    // settle() 是同步收敛：期间保持作用域，否则松手那一刻会把全图轻推一遍。
    if (dragComp && !dragging && !settling && alpha < .05) dragComp = null
    const active = dragComp ? dragComp.members : nodes
    const activeIds = dragComp ? dragComp.ids : null
    // 网格装全节点：冻结簇只当障碍施力、自身不被积分，活动簇因此不会与其重合。
    const grid = new Map()
    for (const node of nodes) {
      const key = cellKey(node.x, node.y)
      let list = grid.get(key)
      if (!list) grid.set(key, list = [])
      list.push(node)
    }
    const range2 = SIM.range * SIM.range
    const rep = SIM.repel * F.repel * alpha
    for (const node of active) {
      const gx = Math.floor(node.x / SIM.cell), gy = Math.floor(node.y / SIM.cell)
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        const list = grid.get(`${gx + ox},${gy + oy}`)
        if (!list) continue
        for (const other of list) {
          if (other === node) continue
          let dx = node.x - other.x, dy = node.y - other.y, d2 = dx * dx + dy * dy
          if (d2 > range2) continue
          if (d2 < 1) {
            // 确定性抖动：重合时分开，但不引入随机数导致位置不可复现。
            const jitter = hashId(node.id) ^ hashId(other.id)
            dx = ((jitter & 1023) / 1023 - .5) || .25
            dy = ((jitter >>> 10 & 1023) / 1023 - .5) || .25
            d2 = dx * dx + dy * dy + 1
          }
          const d = Math.sqrt(d2), f = rep / (d2 + 60)
          node.vx += dx / d * f; node.vy += dy / d * f
        }
      }
    }
    const lk = SIM.link * alpha
    for (const edge of edges) {
      if (activeIds && (!activeIds.has(edge.from) || !activeIds.has(edge.to))) continue
      const p = edge.source, q = edge.target
      if (!p || !q) continue
      const dx = q.x - p.x, dy = q.y - p.y, dist = Math.hypot(dx, dy) || .01
      const f = (dist - edge.baseLen * F.linkDist) / dist * lk
      const fx = dx * f, fy = dy * f
      p.vx += fx; p.vy += fy; q.vx -= fx; q.vy -= fy
    }
    if (F.center > 0 && active.length) {
      let cx = 0, cy = 0
      for (const node of active) { cx += node.x; cy += node.y }
      cx /= active.length; cy /= active.length
      const cf = SIM.centerForce * F.center * alpha
      for (const node of active) { node.vx += (cx - node.x) * cf; node.vy += (cy - node.y) * cf }
    }
    for (const node of active) {
      node.vx = clamp(node.vx, -24, 24); node.vy = clamp(node.vy, -24, 24)
      if (node.fx != null) { node.x = node.fx; node.vx = 0 } else { node.vx *= SIM.vDecay; node.x += node.vx }
      if (node.fy != null) { node.y = node.fy; node.vy = 0 } else { node.vy *= SIM.vDecay; node.y += node.vy }
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) { node.x = 0; node.y = 0; node.vx = 0; node.vy = 0 }
      // 单向硬分离：弹簧链会把节点拉回彼此身上，纯斥力来不及挡住。只把活动节点
      // 推到最小间距外，冻结节点与 pin 节点都不动，所以拖动时跨簇永不重合。
      // 阈值按相机缩放换算：无论缩到多小，屏幕上都至少留出 18px 间距。
      // 拖动中只推自由节点（跟手优先）；松手后连「拖动落点」一起推，
      // 免得它停在别的节点身上。右键锁定的节点永远不动。
      if (node.fx == null || (!dragging && !node.locked)) {
        // 拖动中只做「别完全重合」的软约束（世界 12px），否则整簇会被锁成刚性块、
        // 弹簧拉不动邻居，拖动就只剩一条越拉越长的边。松手后才用 24px 屏幕间距。
        const minSep = dragging ? 12 : 24 / clamp(viewScale, .06, 5), minSep2 = minSep * minSep
        const gx = Math.floor(node.x / SIM.cell), gy = Math.floor(node.y / SIM.cell)
        for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
          const list = grid.get(`${gx + ox},${gy + oy}`)
          if (!list) continue
          for (const other of list) {
            if (other === node) continue
            let dx = node.x - other.x, dy = node.y - other.y, d2 = dx * dx + dy * dy
            if (d2 >= minSep2) continue
            if (d2 < .0001) { dx = 1; dy = 0; d2 = 1 }
            const d = Math.sqrt(d2), push = minSep - d
            node.x += dx / d * push; node.y += dy / d * push
          }
        }
        node.vx *= .3; node.vy *= .3
        // 固定点被推开后要把锁定坐标一起搬走，否则下一帧又被拉回旧位置。
        if (node.fx != null) { node.fx = node.x; node.fy = node.y }
      }
    }
  }

  return {
    get nodes() { return nodes },
    get edges() { return edges },
    get alpha() { return alpha },
    // 空闲时 alpha 落在地板即停止积分：心跳重绘不会让已收敛的布局漂移。
    get active() { return alpha > SIM.alphaTarget + 1e-4 || dragging },
    update,
    tick,
    settle(ticks = 200) {
      settling = true
      try { for (let i = 0; i < ticks; i++) tick() } finally { settling = false }
      alpha = SIM.alphaTarget
    },
    configure(next) {
      const distanceChanged = next?.distance !== undefined && next.distance !== options.distance
      options = { ...options, ...next }
      if (distanceChanged) {
        edgeLengths.clear()
        for (const edge of edges) {
          edge.baseLen = baseLenOf(edge.source, edge.target)
          edgeLengths.set(JSON.stringify([edge.from, edge.to, edge.kind || '']), edge.baseLen)
        }
      }
      reheat(.25)
    },
    reheat,
    setScale(value) { viewScale = Number(value) > 0 ? Number(value) : 1 },
    // pin = 用户右键锁定（计数、画标记）；hold = 拖动落点（留在原地但不计为锁定）。
    pin(id, x, y) {
      const state = cache.get(id)
      if (!state) return
      state.fx = x; state.fy = y; state.x = x; state.y = y; state.vx = 0; state.vy = 0; state.locked = true
      reheat(.3)
    },
    hold(id, x, y) {
      const state = cache.get(id)
      if (!state) return
      state.fx = x; state.fy = y; state.x = x; state.y = y; state.vx = 0; state.vy = 0
      reheat(.55)
    },
    // 松手：解除临时固定，但把相连边的自然长度改成当前距离 —— 节点留在原地不被
    // 拉回，同时仍是自由节点，之后拖别的节点还能带动它。
    release(id) {
      const state = cache.get(id)
      if (!state) return
      state.fx = null; state.fy = null; state.vx = 0; state.vy = 0
      for (const edge of edges) {
        if (edge.from !== id && edge.to !== id) continue
        edge.baseLen = Math.max(24, Math.hypot(edge.source.x - edge.target.x, edge.source.y - edge.target.y))
        edgeLengths.set(JSON.stringify([edge.from, edge.to, edge.kind || '']), edge.baseLen)
      }
      reheat(.2)
    },
    unpin(id) {
      const state = cache.get(id)
      if (!state) return
      state.fx = null; state.fy = null; state.vx = 0; state.vy = 0; state.locked = false
      reheat(.3)
    },
    unpinAll() {
      for (const state of cache.values()) {
        state.fx = null; state.fy = null; state.vx = 0; state.vy = 0; state.locked = false
      }
      reheat(.35)
    },
    relayout() {
      layoutFlower()
      dragComp = null; dragging = false; alpha = 1
    },
    componentOf,
    startDragScope(id) {
      dragging = true
      const comp = componentOf(id)
      dragComp = comp ? { ids: comp.ids, members: comp.members } : null
      reheat(.35)
      return dragComp
    },
    setDragging(value) { dragging = value },
    clearDragScope() { dragComp = null; dragging = false },
    nodeById: id => cache.get(id),
    dispose() { cache.clear(); edgeLengths.clear(); nodes = []; edges = []; components = null; adjacency = new Map() },
  }
}

export function fitCamera(nodes, width, height) {
  if (!nodes.length) return { x: width / 2, y: height / 2, k: 1 }
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity
  for (const node of nodes) {
    const r = Number(node.radius) || 4
    left = Math.min(left, node.x - r); right = Math.max(right, node.x + r)
    top = Math.min(top, node.y - r); bottom = Math.max(bottom, node.y + r)
  }
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

// ---- 画布控制器：相机、渲染、指针与键盘 ------------------------------------
export function createGraphView(canvas, { onFocus = () => {}, onZoom = () => {}, tooltip,
  reducedMotion = false, emptyLabel = '' } = {}) {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D is unavailable')
  const layout = createForceLayout()
  let width = 1, height = 1, ratio = 1, camera = { x: 0, y: 0, k: 1 }
  let options = { ...DEFAULT_OPTIONS }, focused = '', hovered = null, gesture = null
  let initialized = false, disposed = false, frame = null, lastTime = 0, accumulator = 0, idleFrame = 0
  const pointers = new Map(), cleanup = []
  const win = canvas.ownerDocument.defaultView
  const world = point => ({ x: (point.x - camera.x) / camera.k, y: (point.y - camera.y) / camera.k })
  const radius = node => clamp((Number(node.radius) || 4) * Math.sqrt(camera.k), 2.5, 22)
  const point = event => {
    const rect = canvas.getBoundingClientRect()
    return { x: (event.clientX - rect.left) * width / rect.width, y: (event.clientY - rect.top) * height / rect.height }
  }
  // 命中测试走世界网格；千级节点时避免每次 pointermove 全量扫描。
  const hit = p => {
    const nodes = layout.nodes
    if (!nodes.length) return null
    const target = world(p), reach = clamp(Math.ceil(40 / Math.max(camera.k, .06) / SIM.cell), 1, 8)
    const gx = Math.floor(target.x / SIM.cell), gy = Math.floor(target.y / SIM.cell), grid = new Map()
    for (const node of nodes) {
      const key = cellKey(node.x, node.y)
      let list = grid.get(key)
      if (!list) grid.set(key, list = [])
      list.push(node)
    }
    let closest = null, distance = Infinity
    for (let ox = -reach; ox <= reach; ox++) for (let oy = -reach; oy <= reach; oy++) {
      const list = grid.get(`${gx + ox},${gy + oy}`)
      if (!list) continue
      for (const node of list) {
        const sx = node.x * camera.k + camera.x, sy = node.y * camera.k + camera.y
        const d = Math.hypot(sx - p.x, sy - p.y)
        if (d <= Math.max(10, radius(node) + 4) && d < distance) { closest = node; distance = d }
      }
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
  const restoreGesture = current => {
    if (!current?.snapshot) return
    for (const saved of current.snapshot) {
      const state = layout.nodeById(saved.id)
      if (!state) continue
      state.fx = saved.fx; state.fy = saved.fy; state.locked = saved.locked === true
      state.x = saved.x; state.y = saved.y; state.vx = 0; state.vy = 0
    }
    layout.clearDragScope()
  }
  const drawGrid = alpha => {
    const step = 34 * camera.k
    if (step < 12) return
    const ox = ((camera.x % step) + step) % step, oy = ((camera.y % step) + step) % step
    context.fillStyle = context.strokeStyle
    context.globalAlpha = alpha
    context.beginPath()
    for (let x = ox; x < width; x += step) for (let y = oy; y < height; y += step) context.rect(x, y, 1.2, 1.2)
    context.fill()
  }
  const draw = () => {
    layout.setScale(camera.k)
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)
    const style = win.getComputedStyle(canvas)
    const foreground = style.color || '#202020'
    const background = style.getPropertyValue('--dsw-alias-bg-layer-1').trim() || '#ffffff'
    const accent = style.getPropertyValue('--dsw-alias-brand-primary').trim() || '#3b5bdb'
    const active = hovered?.id || focused
    const neighbors = new Set(active ? [active] : [])
    for (const edge of layout.edges) {
      if (edge.from === active) neighbors.add(edge.to)
      if (edge.to === active) neighbors.add(edge.from)
    }
    context.strokeStyle = foreground
    // 空闲呼吸只改网格点的透明度，不碰任何坐标：心跳重绘不会让验收截图漂移。
    const breath = options.motion && !reducedMotion ? .06 + .025 * Math.sin(Date.now() / 900) : .07
    if (options.grid !== false) drawGrid(breath)
    // 边：自动边实线、手动/worker 边虚线并按「主语 → 宾语」画箭头，两批各自一次 stroke。
    const k = camera.k, ox = camera.x, oy = camera.y
    // 按「rule 颜色 + 实/虚 + 是否簇间骨架」分组，每组一次 stroke；最多 6 色，开销可控。
    const batches = new Map()
    for (const edge of layout.edges) {
      const a = { x: edge.source.x * k + ox, y: edge.source.y * k + oy }
      const b = { x: edge.target.x * k + ox, y: edge.target.y * k + oy }
      if ((a.x < -40 && b.x < -40) || (a.x > width + 40 && b.x > width + 40)) continue
      if ((a.y < -40 && b.y < -40) || (a.y > height + 40 && b.y > height + 40)) continue
      const color = edgeColor(edge, foreground, accent)
      const skeleton = edge.source.kind !== 'memory' && edge.target.kind !== 'memory'
      const key = `${color}|${edge.manual ? 'd' : 's'}|${skeleton ? 'k' : 'n'}`
      let batch = batches.get(key)
      if (!batch) batches.set(key, batch = { color, manual: edge.manual, skeleton, list: [] })
      batch.list.push({ edge, a, b })
    }
    context.lineWidth = .8
    for (const batch of batches.values()) {
      context.strokeStyle = batch.color
      context.globalAlpha = active ? .055 : (batch.skeleton ? .1 : batch.manual ? .24 : .16)
      context.setLineDash(batch.manual ? [5, 4] : [])
      context.beginPath()
      for (const item of batch.list) { context.moveTo(item.a.x, item.a.y); context.lineTo(item.b.x, item.b.y) }
      context.stroke()
      context.setLineDash([])
      // 箭头只表示有向断言：提及/冲突是关系型证据，不画箭头（与 HTML 一致）。
      if (batch.manual && camera.k >= .3) {
        context.fillStyle = batch.color
        context.globalAlpha = active ? .22 : .4
        for (const item of batch.list) {
          if (item.edge.rule === 'entity-mention' || item.edge.rule === 'conflict') continue
          const dx = item.b.x - item.a.x, dy = item.b.y - item.a.y, d = Math.hypot(dx, dy)
          if (d <= 22) continue
          const ux = dx / d, uy = dy / d, rr = radius(item.edge.target) + 3
          const hx = item.b.x - ux * rr, hy = item.b.y - uy * rr
          context.beginPath()
          context.moveTo(hx, hy)
          context.lineTo(hx - ux * 7 - uy * 3.4, hy - uy * 7 + ux * 3.4)
          context.lineTo(hx - ux * 7 + uy * 3.4, hy - uy * 7 - ux * 3.4)
          context.closePath(); context.fill()
        }
      }
    }
    if (active) {
      context.globalAlpha = .6; context.lineWidth = 1.5; context.strokeStyle = accent
      context.beginPath()
      for (const edge of layout.edges) {
        if (edge.from !== active && edge.to !== active) continue
        context.moveTo(edge.source.x * k + ox, edge.source.y * k + oy)
        context.lineTo(edge.target.x * k + ox, edge.target.y * k + oy)
      }
      context.stroke()
    }
    context.globalAlpha = 1
    context.strokeStyle = foreground
    const visible = []
    for (const node of layout.nodes) {
      const x = node.x * k + ox, y = node.y * k + oy
      // 留足裁剪余量：拖动时硬分离会把邻簇推开，小视口下也不该让节点突然消失
      // （可见性仍由下面的点层 LOD 与标签视口裁剪兜底）。
      if (x >= -120 && x <= width + 120 && y >= -120 && y <= height + 120) visible.push({ node, x, y, r: radius(node) })
    }
    const dots = layout.nodes.length > 2400 && camera.k < .3
    if (dots) {
      // 点层 LOD：按颜色批量 2px 方点，不建每节点对象、不逐颗 arc。
      const groups = new Map()
      for (const node of layout.nodes) {
        const x = node.x * k + ox, y = node.y * k + oy
        if (x < 0 || x > width || y < 0 || y > height) continue
        const color = nodeColor(node)
        let list = groups.get(color)
        if (!list) groups.set(color, list = [])
        list.push(x, y)
      }
      context.globalAlpha = 1
      for (const [color, list] of groups) {
        context.fillStyle = color
        context.beginPath()
        for (let i = 0; i < list.length; i += 2) context.rect(list[i] - 1, list[i + 1] - 1, 2, 2)
        context.fill()
      }
    } else {
      // 详细层：按「颜色 + 是否淡出」分组，每节点仍恰好一次 ctx.arc。
      const groups = new Map()
      for (const p of visible) {
        const faded = !!active && !neighbors.has(p.node.id)
        const key = nodeColor(p.node) + (faded ? '|d' : '|n')
        let list = groups.get(key)
        if (!list) groups.set(key, list = [])
        list.push(p)
      }
      for (const [key, list] of groups) {
        const [color, mode] = key.split('|')
        context.globalAlpha = mode === 'd' ? .22 : 1
        context.fillStyle = color
        context.beginPath()
        for (const p of list) { context.moveTo(p.x + p.r, p.y); context.arc(p.x, p.y, p.r, 0, TAU) }
        context.fill()
      }
      context.globalAlpha = 1
      const queryHighlight = String(options.query || '').trim().toLowerCase()
      // 实体用圆角方覆盖圆点；arcTo 不增加 arc 计数。
      for (const p of visible) {
        if (p.node.kind === 'memory' || p.node.missing) continue
        const size = p.r * 1.75, rad = Math.min(5, size / 3), x = p.x - size / 2, y = p.y - size / 2
        context.fillStyle = nodeColor(p.node)
        context.beginPath()
        context.moveTo(x + rad, y)
        context.arcTo(x + size, y, x + size, y + size, rad)
        context.arcTo(x + size, y + size, x, y + size, rad)
        context.arcTo(x, y + size, x, y, rad)
        context.arcTo(x, y, x + size, y, rad)
        context.closePath(); context.fill()
      }
      // 临时实体虚线环 / 固定标记：环用 ellipse、标记用 rect，均不污染 arc 计数。
      for (const p of visible) {
        const node = p.node
        if (node.status === 'provisional') {
          context.strokeStyle = nodeColor(node); context.lineWidth = 1.2; context.setLineDash([3, 3])
          context.beginPath(); context.ellipse(p.x, p.y, p.r + 5, p.r + 5, 0, 0, TAU); context.stroke()
          context.setLineDash([])
        }
        if (node.locked) {
          context.fillStyle = background; context.globalAlpha = .95
          context.fillRect(p.x - 1.5, p.y - 1.5, 3, 3); context.globalAlpha = 1
        }
        if (node.id === active || node.id === hovered?.id) {
          context.strokeStyle = node.id === active ? accent : nodeColor(node); context.lineWidth = 1.5
          context.beginPath(); context.ellipse(p.x, p.y, p.r + 4, p.r + 4, 0, 0, TAU); context.stroke()
        }
        // 工作台搜索命中：与 HTML 的 query 高亮一致，不增加 arc 计数。
        if (queryHighlight && String(node.title || node.id).toLowerCase().includes(queryHighlight)) {
          context.strokeStyle = accent; context.lineWidth = 2
          context.beginPath(); context.ellipse(p.x, p.y, p.r + 4, p.r + 4, 0, 0, TAU); context.stroke()
        }
      }
    }
    context.globalAlpha = 1
    context.strokeStyle = foreground
    if (options.labels && !dots) {
      // 原版标签逻辑：按缩放决定铺多少、缩得越小字越淡、拖动/平移时只画焦点，
      // 冲突时下移一行、仍冲突就跳过；文字用背景色描边当 halo。
      context.font = '11.5px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif'
      const inView = visible.filter(p => p.x > -60 && p.x < width + 60 && p.y > -60 && p.y < height + 60)
      const showAll = (camera.k >= .55 || visible.length < 34) && inView.length <= 260
      const minDeg = inView.length > 260 ? 9999 : 3
      const zoomFade = clamp((camera.k - .3) / .35, 0, 1)
      const panning = gesture?.type === 'pan' && gesture.moved
      const draggingNode = gesture?.type === 'node' && gesture.moved
      const interactive = (draggingNode || panning) && layout.nodes.length > 400
      const candidates = interactive
        ? inView.filter(p => p.node.id === active)
        : showAll ? inView : inView.filter(p => p.node.id === active || p.node.degree >= minDeg)
      const ordered = candidates.length > 260 ? candidates.slice(0, 260) : candidates
      ordered.sort((a, b) => Number(b.node.id === active) - Number(a.node.id === active) || b.node.degree - a.node.degree)
      const placed = []
      context.textAlign = 'center'; context.textBaseline = 'top'
      for (const p of ordered) {
        if (active && !neighbors.has(p.node.id)) continue
        const must = p.node.id === active
        if (!must) {
          if (!showAll && p.node.degree < minDeg) continue
          if (zoomFade < .02) continue
        }
        const label = String(p.node.title || p.node.id)
        const w = context.measureText(label).width
        const boxOf = yy => ({ l: p.x - w / 2 - 3, t: yy - 1, r: p.x + w / 2 + 3, b: yy + 14 })
        const clash = r => placed.some(q => r.l < q.r && r.r > q.l && r.t < q.b && r.b > q.t)
        let yy = p.y + p.r + 4
        let box = boxOf(yy)
        if (clash(box)) { yy += 16; box = boxOf(yy); if (clash(box)) continue }
        if (box.l < 2 || box.r > width - 2 || box.b > height - 2) continue
        placed.push(box)
        context.globalAlpha = must ? 1 : .78 * Math.max(.35, zoomFade)
        context.lineWidth = 3.5; context.strokeStyle = background; context.lineJoin = 'round'
        context.strokeText(label, p.x, yy)
        context.fillStyle = foreground
        context.fillText(label, p.x, yy)
      }
      context.globalAlpha = 1
    } else if (options.labels && dots && active) {
      const focus = layout.nodes.find(node => node.id === active)
      if (focus) {
        context.font = '12px system-ui, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'top'
        context.fillStyle = foreground
        context.fillText(String(focus.title || focus.id), focus.x * k + ox, focus.y * k + oy + 10)
      }
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
    const stepping = options.motion && !reducedMotion && layout.active
    if (stepping) {
      accumulator += lastTime ? Math.min(64, time - lastTime) : 17
      let steps = 0
      for (; accumulator >= 1000 / 60 && steps < 4; accumulator -= 1000 / 60, steps++) layout.tick()
      lastTime = time
    } else { lastTime = 0; accumulator = 0 }
    // 空闲降到 ~30fps：只重绘不改坐标（呼吸在 drawGrid 里）。
    if (!stepping && options.motion && !reducedMotion && (idleFrame++ % 2)) { requestDraw(); return }
    draw()
    if (stepping || (options.motion && !reducedMotion)) requestDraw()
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
  const startPinch = () => {
    restoreGesture(gesture)
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
    const w = world(p)
    const component = node ? layout.componentOf(node.id) : null
    const mode = node && event.shiftKey && component ? 'rigid' : 'node'
    const members = mode === 'rigid' ? component.members : (node ? [node] : [])
    gesture = { type: node ? 'node' : 'pan', node, mode, members, start: p, camera: { ...camera }, moved: false,
      offset: node ? { x: node.x - w.x, y: node.y - w.y } : null,
      snapshot: members.map(m => ({ id: m.id, x: m.x, y: m.y, fx: m.fx, fy: m.fy, locked: m.locked })) }
    if (node) {
      // 拖动期间只临时钉住，不算"锁定"；锁定只由右键产生。
      for (const m of members) layout.hold(m.id, m.x, m.y)
      layout.startDragScope(node.id)
      layout.setDragging(true)
    }
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
        if (gesture.mode === 'rigid') {
          const nx = w.x + gesture.offset.x, ny = w.y + gesture.offset.y
          const dx = nx - node.fx, dy = ny - node.fy
          for (const m of gesture.members) layout.hold(m.id, m.fx + dx, m.fy + dy)
        } else layout.hold(node.id, w.x + gesture.offset.x, w.y + gesture.offset.y)
        // 每次指针移动都同步推进两帧：邻居像珠子链一样立刻跟过来，
        // 不会等 rAF（小图缩放时 rAF 一帧的位移远小于指针）。
        layout.settle(2)
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
    const click = !cancelled && !gesture?.moved && gesture?.type !== 'pinch' && (event.detail ?? 1) < 2
    if (click || cancelled) {
      // 单击不留下临时 pin；取消/Esc 恢复按下前的摆位。
      restoreGesture(gesture)
    } else if (selected) {
      // 松手：原本锁定的节点把锁定点更新到落点；自由节点则 release —— 留在原地
      // 但不再固定，后续拖别的节点能带动它，右键一次即可（它本来就没被锁）。
      for (const saved of gesture.snapshot) {
        const state = layout.nodeById(saved.id)
        if (!state) continue
        if (saved.locked || saved.fx != null) {
          state.fx = state.x; state.fy = state.y; state.locked = true
          state.vx = 0; state.vy = 0
        } else {
          layout.release(saved.id)
        }
      }
      layout.setDragging(false)
      // 多收敛几帧，让「松手落点」也被安全间距推开，不会停在别的节点身上。
      if (reducedMotion || !options.motion) { layout.settle(120); layout.clearDragScope() }
      else layout.reheat(.3)
    }
    pointers.delete(event.pointerId)
    gesture = null
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
  // 右键 = 锁定 / 解除：左键只负责显示单链与拖动，不再产生固定点。
  listen(canvas, 'contextmenu', event => {
    event.preventDefault()
    const node = hit(point(event))
    if (!node) return
    const state = layout.nodeById(node.id)
    if (!state) return
    // 有任何固定点（含拖动残留）就先解开，再点一次才锁定 —— 不会出现要点两次。
    if (state.fx != null) layout.unpin(node.id)
    else layout.pin(node.id, state.x, state.y)
    layout.setDragging(false)
    if (reducedMotion || !options.motion) layout.settle(20)
    requestDraw()
  })
  // 双击聚焦：第二次 pointerup 的 detail>=2 已在 up 里跳过，避免重复取数。
  listen(canvas, 'dblclick', event => { onFocus(hit(point(event))?.id || '') })
  listen(canvas, 'wheel', event => { event.preventDefault(); zoom(Math.exp(-clamp(event.deltaY, -160, 160) * .0025), point(event)) }, { passive: false })
  listen(canvas, 'keydown', event => {
    if (event.key === '+' || event.key === '=') zoom(1.25)
    else if (event.key === '-') zoom(.8)
    else if (event.key === '0' || event.key === 'Home') fit()
    else if (event.key === 'Escape') {
      restoreGesture(gesture); gesture = null; pointers.clear(); onFocus(''); hideTooltip(); requestDraw()
    } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      const step = event.shiftKey ? 90 : 30
      camera.x += event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0
      camera.y += event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0
      requestDraw()
    } else return
    event.preventDefault()
  })
  listen(win, 'blur', () => {
    restoreGesture(gesture); gesture = null; pointers.clear(); hovered = null; hideTooltip(); requestDraw()
  })
  const observer = win.ResizeObserver ? new win.ResizeObserver(resize) : null
  observer?.observe(canvas)
  listen(win, 'resize', resize)
  const themeObserver = win.MutationObserver ? new win.MutationObserver(requestDraw) : null
  themeObserver?.observe(canvas.ownerDocument.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
  if (canvas.ownerDocument.body) themeObserver?.observe(canvas.ownerDocument.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
  resize()
  return {
    update(graph, focus = '') {
      if (gesture?.node && !graph.nodes.some(node => node.id === gesture.node.id)) {
        restoreGesture(gesture); gesture = null; pointers.clear()
      }
      const changed = layout.update(graph)
      focused = focus
      if (hovered && !layout.nodes.includes(hovered)) { hovered = null; hideTooltip() }
      if (!initialized && layout.nodes.length) {
        layout.settle(220); initialized = true; fit()
      } else if (changed && (reducedMotion || !options.motion)) layout.settle(180)
      requestDraw()
    },
    configure(next) {
      const forceChanged = ['repulsion', 'distance', 'center'].some(key => next[key] !== undefined && next[key] !== options[key])
      options = { ...options, ...next }
      if (forceChanged) {
        layout.configure(next)
        if (reducedMotion || !options.motion) layout.settle(160)
      }
      requestDraw()
    },
    fit, zoom,
    isPinned(id) { return layout.nodeById(id)?.locked === true },
    pinnedCount() { return layout.nodes.reduce((count, node) => count + (node.locked ? 1 : 0), 0) },
    // 只读快照（屏幕坐标 + id）：验收按 id 追节点，不依赖绘制顺序。
    snapshot() {
      return layout.nodes.map(node => ({
        id: node.id, x: node.x * camera.k + camera.x, y: node.y * camera.k + camera.y,
        r: radius(node), pinned: node.locked === true, degree: node.degree || 0,
      }))
    },
    unpinAll() {
      layout.unpinAll(); layout.clearDragScope()
      if (reducedMotion || !options.motion) layout.settle(120)
      requestDraw()
    },
    relayout() {
      restoreGesture(gesture); gesture = null; pointers.clear()
      layout.relayout()
      if (reducedMotion || !options.motion) layout.settle(220)
      requestDraw()
    },
    dispose() {
      disposed = true
      restoreGesture(gesture); gesture = null; pointers.clear()
      if (frame !== null) win.cancelAnimationFrame(frame)
      for (const remove of cleanup) remove()
      observer?.disconnect(); themeObserver?.disconnect(); layout.dispose(); hideTooltip()
    },
  }
}
