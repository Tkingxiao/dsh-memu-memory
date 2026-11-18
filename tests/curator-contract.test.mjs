// Issue #3（dsh-memu-memory#3）：宿主 0.2.2-rc.2 把 SubagentActivationSpec 扁平化
// （parent/cwd/prompt/agentOptions 平铺顶层，无 request 外层），旧契约
// （0.2.1-rc.5 / 0.2.2-rc.1）把任务字段装在 request 信封里。这里用两种形态的
// mock 宿主各跑一遍完整的 startGlobalCuration 链路（选形态 → startActivation →
// 回执 → commit），并验证 TypeError 零副作用回退与失败日志落地。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-curator-contract-'))
process.env.DSH_MEMU_HOME = home

// commit → embedding 的最小桩（与 curator.test.mjs 同款）。
function vector(text) {
  const h = crypto.createHash('sha256').update(String(text)).digest()
  const out = []
  for (let i = 0; i < 8; i++) out.push((h[i] / 255) * 2 - 1)
  const norm = Math.sqrt(out.reduce((a, b) => a + b * b, 0)) || 1
  return out.map((x) => x / norm)
}
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    try {
      const data = JSON.parse(body || '{}')
      const inputs = Array.isArray(data.input) ? data.input : [data.input]
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        object: 'list',
        data: inputs.map((text, index) => ({ object: 'embedding', index, embedding: vector(text) })),
        model: data.model || 'test-embed',
        usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
      }))
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: String(error) } }))
    }
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
process.env.MEMU_EMBED_PROVIDER = 'openai'
process.env.MEMU_EMBED_MODEL = 'test-embed'
process.env.MEMU_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`
process.env.MEMU_API_KEY = 'test-key'
process.env.OPENAI_API_KEY = 'test-key'

const { startGlobalCuration, getCurationJob } = await import('../lib/curator.js')
const activityLog = await import('../lib/activity-log.js')

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function ctxFor({ markers = false, mode = 'accept', onSpec = () => {} } = {}) {
  // markers: true → mock 带新版树内省方法（flat 探测命中）；false → 极简 mock
  //（只能靠 TypeError 回退兜底）。mode: 'accept' 两种形态都收；'reject-request'
  // 收 flat 拒 nested（老宿主）；'reject-flat' 收 nested 拒 flat（模拟探测失灵）。
  const parent = { id: 'parent', session: { header: { cwd: path.join(home, 'project') } } }
  const calls = []
  const subagents = {
    ...(markers ? { rootOf: () => { throw new Error('not used by the plugin') } } : {}),
    startActivation: async (spec) => {
      calls.push(spec)
      onSpec(spec)
      const flat = !('request' in spec)
      if (mode === 'reject-request' && !flat) throw new TypeError('Cannot read properties of undefined (reading \'maxDepth\')')
      if (mode === 'reject-flat' && flat) throw new TypeError('Cannot read properties of undefined (reading \'id\')')
      return {
        result: Promise.resolve({
          stopReason: 'completed',
          output: [{ type: 'text', text: JSON.stringify(curatorOutput()) }],
        }),
        dispose: async () => {},
      }
    },
  }
  return {
    parent,
    calls,
    get(name) {
      if (name === 'agents') return { get: (id) => (id === 'parent' ? parent : undefined) }
      if (name === 'subagents') return subagents
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => [{
            header: { id: 's1', cwd: path.join(home, 'project'), createdAt: Date.now(), agentPreset: 'coding' },
            live: false,
            persisted: true,
          }],
          readTitleSnapshots: async () => [],
          readSession: async () => ({
            session: { id: 's1', cwd: path.join(home, 'project'), agentPreset: 'coding' },
            inheritedEventCount: 0,
            events: [
              { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'I prefer conclusions first.' }] } },
              { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Understood.' }] } } },
            ],
          }),
        }
      }
      return undefined
    },
  }
}

function curatorOutput() {
  return {
    sessions: [{ id: 's1', domain: 'coding', reason: 'code and tool calls' }],
    memories: [{
      op: 'create',
      track: 'memory',
      domain: 'coding',
      applies_to: ['coding'],
      title: 'Prefers conclusion first',
      content: 'The user prefers a conclusion before details in coding tasks.',
      confidence: 0.9,
      evidence: [{ session_id: 's1', quote: 'I prefer conclusions first.' }],
      reason: 'cross-session style',
    }],
    domain_summary: { coding: 'coding preference' },
    skipped: [],
  }
}

async function waitJob(id) {
  for (let i = 0; i < 200; i += 1) {
    const job = getCurationJob(id)
    if (job && job.status !== 'running') return job
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('curation job did not settle')
}

test('a flat host (0.2.2-rc.2+) receives the task fields at the top level', async () => {
  const ctx = ctxFor({ markers: true })
  const queued = startGlobalCuration(ctx, { sessionIds: ['s1'], parentSessionId: 'parent' })
  const job = await waitJob(queued.id)
  assert.equal(job.status, 'completed', job.error || '')
  assert.equal(ctx.calls.length, 1)
  const spec = ctx.calls[0]
  assert.equal(spec.parent, ctx.parent, 'parent is flat at the top level')
  assert.equal(spec.prompt[0].type, 'text')
  assert.equal(spec.cwd, path.join(home, 'project'))
  assert.ok(!('request' in spec), 'no request envelope on the flat contract')
})

test('a flat-shaped rejection falls back to the nested envelope (future host without the flat path)', async () => {
  const ctx = ctxFor({ markers: true, mode: 'reject-flat' })
  const queued = startGlobalCuration(ctx, { sessionIds: ['s1'], parentSessionId: 'parent' })
  const job = await waitJob(queued.id)
  assert.equal(job.status, 'completed', job.error || '')
  assert.equal(ctx.calls.length, 2, 'one TypeError fallback retry')
  assert.ok(!('request' in ctx.calls[0]), 'first attempt followed the flat detection')
  assert.ok('request' in ctx.calls[1], 'retry used the nested envelope and was accepted')
  assert.equal(ctx.calls[1].request.parent, ctx.parent)
})

test('a bare mock that rejects the nested shape falls back to flat (issue #3 crash path)', async () => {
  const ctx = ctxFor({ markers: false, mode: 'reject-request' })
  const queued = startGlobalCuration(ctx, { sessionIds: ['s1'], parentSessionId: 'parent' })
  const job = await waitJob(queued.id)
  assert.equal(job.status, 'completed', job.error || '')
  assert.equal(ctx.calls.length, 2)
  assert.ok('request' in ctx.calls[0], 'bare mock → nested first (old contract)')
  assert.ok(!('request' in ctx.calls[1]), 'TypeError fallback switched to the flat shape')
})

test('a non-TypeError failure is not retried and lands in activity.jsonl', async () => {
  const parent = { id: 'parent', session: { header: { cwd: path.join(home, 'project') } } }
  const ctx = {
    get(name) {
      if (name === 'agents') return { get: (id) => (id === 'parent' ? parent : undefined) }
      if (name === 'subagents') return { startActivation: async () => { throw new Error('provider spawn is not registered') } }
      if (name === 'sessionQuery') return ctxFor().get('sessionQuery')
      return undefined
    },
  }
  const queued = startGlobalCuration(ctx, { sessionIds: ['s1'], parentSessionId: 'parent' })
  const job = await waitJob(queued.id)
  assert.equal(job.status, 'error')
  assert.match(job.error, /provider spawn is not registered/)
  const events = activityLog.listEvents({ kind: 'curate', limit: 10 })
  const failure = events.find((entry) => entry.ok === false && /provider spawn is not registered/.test(entry.message || ''))
  assert.ok(failure, 'the failure is recorded in activity.jsonl, not only in the in-memory job')
})
