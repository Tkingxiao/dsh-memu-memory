// 移植入口（lib/port-surface.js）的契约测试。
//
// 这里模拟的是「没有宿主」的调用方（MCP server / CLI）：没有 ctx、没有会话、没有
// 注入钩子，只有 libraryId 和工具规格。任何一条挂掉都意味着移植方会踩坑，而这些
// 坑在宿主内是测不到的。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-port-'))
process.env.DSH_MEMU_HOME = home

// 只从公开入口取能力：适配器就该这么用，测试顺带证明入口自洽。
const port = await import('../lib/port-surface.js')
const { createLibrary, ensureSession, loadPrivateIndex, savePrivateIndex, setWorkspacePolicy } = await import('../lib/state.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function seed(libraryId, id, entry) {
  const index = loadPrivateIndex(libraryId)
  index.entries[id] = {
    layer: 'long_term', title: id, content: `body of ${id}`, status: 'active',
    createdAt: '2026-11-01T00:00:00.000Z', ...entry,
  }
  savePrivateIndex(libraryId, index)
}

test('collectToolSpecs hands out every hosted tool as plain data', () => {
  const specs = port.collectToolSpecs()
  // 宿主实际挂的就是这 14 个（私有读写 + 词典 + 全局 + status）；这个数字变了
  // 说明工具面本身变了，移植方需要重新核对，所以守住它。
  assert.ok(specs.length >= 14, `expected the full tool set, got ${specs.length}`)
  const names = new Set(specs.map((spec) => spec.name))
  for (const required of ['memu_private_recall', 'memu_private_remember', 'memu_private_list', 'memu_status']) {
    assert.ok(names.has(required), `${required} must be part of the surface`)
  }
  for (const spec of specs) {
    assert.equal(typeof spec.name, 'string')
    assert.ok(spec.name.startsWith('memu_'), `unexpected tool name ${spec.name}`)
    assert.equal(typeof spec.description, 'string')
    assert.ok(spec.description.length > 0, `${spec.name} must carry a description`)
    assert.equal(typeof spec.parameters, 'object')
    assert.equal(typeof spec.execute, 'function')
  }
  // 幂等：再问一次不该多也不该少（内部会重跑一遍 registerTools）。
  assert.equal(port.collectToolSpecs().length, specs.length, 'asking twice must not change the set')
})

test('toInputSchema lifts host required flags into a JSON Schema array', () => {
  const specs = port.collectToolSpecs()
  const recall = specs.find((spec) => spec.name === 'memu_private_recall')
  assert.ok(recall, 'memu_private_recall must be part of the surface')
  const schema = port.toInputSchema(recall.parameters)
  assert.equal(schema.type, 'object')
  assert.ok(Array.isArray(schema.required), 'required must be an array')
  assert.ok(schema.required.includes('query'), 'query is a required parameter in the host DSL')
  assert.equal(schema.properties.query.type, 'string')
  // 宿主方言的 required 是属性上的布尔，不能漏进 JSON Schema。
  assert.equal(schema.properties.query.required, undefined, 'per-property required must not survive')
})

test('privateRecall serves an explicit library with no session at all', async () => {
  const lib = createLibrary({ name: 'port-recall', cwd: path.join(home, 'port-recall') })
  seed(lib.id, 'mem-port-1', { title: '主题偏好', content: '用户偏好深色主题，讨厌弹窗。' })
  const result = await port.privateRecall({ libraryId: lib.id, query: '深色主题' })
  assert.ok(result && Array.isArray(result.files), 'recall must return a files array')
  assert.ok(result.files.some((file) => file.name === 'mem-port-1'), 'the seeded memory must be recalled')
})

test('privateRecall without a session and without a library still refuses', async () => {
  await assert.rejects(() => port.privateRecall({ query: 'x' }), /no bound session/)
})

test('an unknown libraryId is rejected instead of silently returning nothing', async () => {
  // loadPrivateIndex 对未知库给的是空索引，不校验就会变成「静默零命中」——
  // 对一个拼错的 libraryId 来说，安静的空结果比报错更难查。
  await assert.rejects(
    () => port.privateRecall({ libraryId: 'lib-does-not-exist', query: 'x' }),
    /unknown library/,
  )
})

test('an explicit library never pulls in a sibling library', async () => {
  const a = createLibrary({ name: 'port-own-a', cwd: path.join(home, 'port-own-a') })
  const b = createLibrary({ name: 'port-own-b', cwd: path.join(home, 'port-own-b') })
  seed(a.id, 'mem-own', { content: '只在 A 库里的锚点词 蓝色钥匙' })
  seed(b.id, 'mem-foreign', { content: '只在 B 库里的锚点词 蓝色钥匙' })
  const result = await port.privateRecall({ libraryId: a.id, query: '蓝色钥匙' })
  assert.ok(result.files.length > 0, 'the owning library must still answer')
  assert.ok(
    result.files.every((file) => (file.libraryId || a.id) === a.id),
    'no cross-library rows without a session',
  )
})

test('a bound session keeps behaving as before', async () => {
  const cwd = path.join(home, 'port-bound')
  const lib = createLibrary({ name: 'port-bound', cwd })
  seed(lib.id, 'mem-bound', { content: '会话里的锚点词 红色雨伞' })
  ensureSession('port-session-1', { cwd, libraryId: lib.id })
  const exec = { agent: { session: { header: { id: 'port-session-1', cwd } } } }
  const result = await port.privateRecall({ exec, query: '红色雨伞' })
  assert.ok(result.files.some((file) => file.name === 'mem-bound'), 'the bound session path must be unchanged')
})

test('privateRemember writes with only a libraryId', async () => {
  const lib = createLibrary({ name: 'port-write', cwd: path.join(home, 'port-write') })
  await port.privateRemember({ libraryId: lib.id, content: '无会话也能写，但必须显式给库。', title: '无会话写入' })
  const listed = await port.privateList({ libraryId: lib.id })
  // privateList 返回的是原始行（标题在 entry 里）；privateListView 才做顶层投影。
  assert.ok(
    (listed.files || []).some((file) => (file.entry?.title || file.title) === '无会话写入'),
    'the written memory must be listed from the same library',
  )
})

test('a folder that turned private memory off stays off for session-less callers', async () => {
  const lib = createLibrary({ name: 'port-disabled', cwd: path.join(home, 'port-disabled') })
  setWorkspacePolicy(lib.scopeKey, { useLibrary: false })
  try {
    await assert.rejects(
      () => port.privateRemember({ libraryId: lib.id, content: 'x', title: 'x' }),
      /disabled for this folder/,
      'a disabled folder must not accept writes just because the caller has no session',
    )
    await assert.rejects(
      () => port.privateRecall({ libraryId: lib.id, query: 'x' }),
      /disabled for this folder/,
      'a disabled folder must not serve reads either',
    )
  } finally {
    setWorkspacePolicy(lib.scopeKey, { useLibrary: true })
  }
})
