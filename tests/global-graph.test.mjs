import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-global-graph-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const { getGlobalGraph } = await import('../lib/global-graph.js')
const { dispatch } = await import('../lib/rpc.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function seed() {
  state.saveGlobalIndex({
    entries: {
      g1: {
        title: '部署窗口', domain: 'coding', status: 'active', confidence: 0.9,
        links: [{ id: 'lnk_1', opId: 'op1', to: 'g2', kind: 'related', note: '同一发布约定', confidence: 0.8 }],
      },
      g2: {
        title: '回滚规则', domain: 'coding', status: 'active', confidence: 0.7,
        links: [{ id: 'lnk_1', opId: 'op1', to: 'g1', kind: 'related', note: '同一发布约定', confidence: 0.8 }],
      },
      g3: {
        title: '已压制', domain: 'coding', status: 'suppressed', confidence: 0.5,
        links: [],
      },
      g4: {
        title: '指向已归档', domain: 'coding', status: 'active', confidence: 0.6,
        links: [{ id: 'lnk_2', opId: 'op2', to: 'g5', kind: 'refines', note: '更细的规则', confidence: 0.7 }],
      },
      g5: { title: '归档条目', domain: 'coding', status: 'archived', confidence: 0.5, links: [] },
    },
  })
}

test('global graph exposes global entries and their links without private entities', () => {
  seed()
  const graph = getGlobalGraph({ limit: 200 })
  assert.deepEqual(graph.nodes.map((node) => node.id).sort(), ['g1', 'g2', 'g4', 'g5'])
  assert.ok(!graph.nodes.some((node) => node.id === 'g3'), 'suppressed entries are hidden')
  assert.equal(graph.scope, 'global')
  for (const node of graph.nodes) {
    assert.equal(node.kind, 'global')
    assert.equal(node.missing, false)
  }
  assert.deepEqual(
    graph.edges.map((edge) => [edge.from, edge.to, edge.kind]).sort(),
    [['g1', 'g2', 'related'], ['g4', 'g5', 'refines']],
  )
  assert.equal(graph.nodes.find((node) => node.id === 'g1').degree, 1)
})

test('focus and depth bound the global graph, and a dangling target stays as a placeholder', () => {
  seed()
  const focused = getGlobalGraph({ focusId: 'g4', depth: 0 })
  assert.deepEqual(focused.nodes.map((node) => node.id), ['g4'])
  assert.deepEqual(focused.edges, [])

  state.saveGlobalIndex({
    entries: {
      only: {
        title: '只剩来源', domain: 'coding', status: 'active',
        links: [{ id: 'lnk_gone', to: 'gone', kind: 'supports', note: '目标已删', confidence: 0.6 }],
      },
    },
  })
  const dangling = getGlobalGraph({})
  assert.deepEqual(dangling.nodes.map((node) => [node.id, node.missing]).sort(), [['gone', true], ['only', false]])
  assert.equal(dangling.nodes.find((node) => node.id === 'gone').title, '[deleted]')
  assert.equal(dangling.edges.length, 1)
})

test('getGraph routes scope=global through the RPC without adding a new method', async () => {
  seed()
  const graph = await dispatch({}, 'getGraph', { scope: 'global', depth: 1, limit: 200 })
  assert.equal(graph.scope, 'global')
  assert.ok(graph.nodes.some((node) => node.id === 'g1'))
  assert.ok(graph.edges.length > 0)
})

test('an unknown global focus is rejected instead of returning an empty graph', () => {
  seed()
  assert.throws(() => getGlobalGraph({ focusId: 'nonexistent' }), /unknown or inaccessible global graph focus/)
})
