import test from 'node:test'
import assert from 'node:assert/strict'

const { migrationCommitPayload } = await import('../lib/local-vector-service.js')

// 现场事故（2026-10-29）：重建时每条记忆都报 VECTOR_READBACK_FAILED，影子库只有 61KB
// 空 schema。原因不是 embedding，而是迁移器把 `{ name, description, ...entry }` 裸对象
// 当成 commit 载荷 —— MemU 只认 `{ recall_files, resource, user }`，于是"提交成功"却一行
// 没写。这组用例钉住信封形状。

test('the migration commit uses the recall_files envelope MemU expects', () => {
  const payload = migrationCommitPayload({
    id: 'mem-abc',
    text: '标题 正文',
    entry: { title: '标题', content: '正文' },
  })
  assert.deepEqual(payload, {
    recall_files: [{ name: 'mem-abc', track: 'memory', description: '标题', content: '正文' }],
    resource: [],
    user: {},
  })
})

test('a snapshot without an entry falls back to the snapshot text', () => {
  const payload = migrationCommitPayload({ id: 'mem-1', text: 'fallback text' })
  assert.equal(payload.recall_files[0].name, 'mem-1')
  assert.equal(payload.recall_files[0].description, 'fallback text')
  assert.equal(payload.recall_files[0].content, 'fallback text')
})

test('the payload is never the bare object that silently commits nothing', () => {
  const payload = migrationCommitPayload({ id: 'mem-2', entry: {} })
  assert.ok(Array.isArray(payload.recall_files), 'MemU needs a recall_files array')
  assert.equal(payload.name, undefined, 'a top-level name is the old broken shape')
  assert.equal(payload.recall_files[0].content, '')
})

test('long titles are clamped to the description budget', () => {
  const payload = migrationCommitPayload({ id: 'mem-3', entry: { title: 'x'.repeat(400), content: 'body' } })
  assert.equal(payload.recall_files[0].description.length, 180)
  assert.equal(payload.recall_files[0].content, 'body')
})
