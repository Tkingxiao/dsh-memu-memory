import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-consolidation-feed-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const state = await import('../lib/state.js')
const { record, resetActivityLogCache, listEvents, clearEvents } = await import('../lib/activity-log.js')
const { dispatch } = await import('../lib/rpc.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

// 侧边栏"整理提醒"与日志页的数据链路：跨会话取整理事件，服务端把会话标题与文件夹名
// 拼进每一行（客户端只回退到裸 id）。标题走宿主 readTitleSnapshots（批量一次）。
const ctx = {
  get: (name) => {
    if (name === 'sessionQuery') {
      return {
        readTitleSnapshots: async (ids) => ids.map((id) => ({
          sessionId: id,
          status: id === 'session-titled' ? 'fulfilled' : 'rejected',
          ...(id === 'session-titled' ? { value: { title: { title: ' princess 的深夜备份会话 ' } } } : {}),
        })),
      }
    }
    return undefined
  },
}

test('getConsolidationFeed splits failures and successes, decorates titles, caps each column', async () => {
  const library = state.createLibrary({ cwd: path.join(home, 'feed-proj'), name: '夜备份工作区' })
  resetActivityLogCache()
  // 8 条失败 + 8 条成功，交错落盘；另有别的 kind 的失败（不得混进来）。
  for (let index = 0; index < 8; index += 1) {
    record({ kind: 'consolidate', scope: 'private', ok: false, level: 'error', sessionId: index === 7 ? 'session-titled' : 'session-plain-' + index, libraryId: library.id, message: '整理失败 · 空闲 · case-' + index, detail: { reasonCode: 'fork-turn-failed' } })
    record({ kind: 'consolidate', scope: 'private', ok: true, sessionId: 'session-titled', libraryId: library.id, message: '整理完成 · 空闲', detail: { count: index } })
  }
  record({ kind: 'recall', scope: 'private', ok: false, sessionId: 'session-titled', message: '召回失败不进整理提醒' })

  const feed = await dispatch(ctx, 'getConsolidationFeed', { limit: 6 })
  assert.equal(feed.failures.length, 6, 'failures capped at the requested column size')
  assert.equal(feed.successes.length, 6, 'successes capped at the requested column size')
  assert.ok(feed.failures.every(row => row.ok === false), 'the failure column holds only failures')
  assert.ok(feed.successes.every(row => row.ok !== false), 'the success column holds only successes')
  // 最新在前：失败列第一条是最后落盘的那条失败。
  assert.match(feed.failures[0].message, /case-7/)
  // 会话标题 + 文件夹名由服务端拼好；查不到标题的行回退 null（客户端用短 id）。
  assert.equal(feed.failures[0].sessionTitle, 'princess 的深夜备份会话')
  assert.equal(feed.failures[0].libraryName, '夜备份工作区')
  const plain = feed.failures.find(row => row.sessionId === 'session-plain-6')
  assert.equal(plain.sessionTitle, null)
  // 行已瘦身：回执 detail 不整包透传，只留提醒需要的字段。
  assert.equal(feed.failures[0].reasonCode, 'fork-turn-failed')
  assert.equal(feed.failures[0].detail, undefined)
})

test('getActivityLog decorates consolidation rows with session title and library name', async () => {
  const library = state.createLibrary({ cwd: path.join(home, 'feed-proj-2'), name: '第二个工作区' })
  resetActivityLogCache()
  record({ kind: 'consolidate', scope: 'private', ok: false, level: 'error', sessionId: 'session-titled', libraryId: library.id, message: '整理失败 · 空闲 · worker-tools-ptc-only', detail: { reasonCode: 'worker-tools-ptc-only', toolSurface: ['run_code'] } })

  const data = await dispatch(ctx, 'getActivityLog', { kind: 'consolidate', limit: 10 })
  const row = data.events.find(item => item.message.includes('worker-tools-ptc-only'))
  assert.ok(row, 'the consolidation row is returned')
  assert.equal(row.sessionTitle, 'princess 的深夜备份会话')
  assert.equal(row.libraryName, '第二个工作区')
})

test('clearConsolidationFailures deletes only failed consolidate rows, everything else stays', async () => {
  const library = state.createLibrary({ cwd: path.join(home, 'feed-clear'), name: '清除测试区' })
  resetActivityLogCache()
  // 同一个临时 home 累积了前面用例的日志：先全清，种进去的才是本用例的全部世界。
  clearEvents()
  record({ kind: 'consolidate', scope: 'private', ok: false, level: 'error', sessionId: 'session-titled', libraryId: library.id, message: '整理失败 · 其一', detail: { reasonCode: 'timeout' } })
  record({ kind: 'consolidate', scope: 'private', ok: false, level: 'error', sessionId: 'session-titled', libraryId: library.id, message: '整理失败 · 其二', detail: { reasonCode: 'timeout' } })
  record({ kind: 'consolidate', scope: 'private', ok: true, sessionId: 'session-titled', libraryId: library.id, message: '整理完成' })
  record({ kind: 'recall', scope: 'private', ok: false, sessionId: 'session-titled', message: '召回失败不是整理失败' })

  const result = await dispatch(ctx, 'clearConsolidationFailures', { limit: 6 })
  assert.equal(result.cleared, 2, 'exactly the two failed consolidate rows are removed')
  assert.equal((result.feed.failures || []).length, 0, 'the failure column comes back empty')
  assert.equal((result.feed.successes || []).length, 1, 'the success flow survives')
  // 其它 kind 的失败行与成功行都不受影响。
  const kinds = listEvents({ limit: 50 })
  assert.ok(kinds.some(r => r.kind === 'recall' && r.ok === false), 'non-consolidate failures stay')
  assert.ok(kinds.some(r => r.kind === 'consolidate' && r.ok !== false), 'consolidate successes stay')
  // 落盘一致：重读缓存后计数不变（rewrite 是权威，不是只在内存里删）。
  resetActivityLogCache()
  assert.equal(listEvents({ kind: 'consolidate', level: 'error', limit: 50 }).length, 0, 'the rewrite reached disk')
})
