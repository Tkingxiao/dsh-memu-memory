import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-curator-'))
process.env.DSH_MEMU_HOME = home

const enginePython = process.env.DSH_MEMU_TEST_ENGINE_PYTHON || ''
if (enginePython) {
  const engineDir = path.join(home, 'engine')
  fs.mkdirSync(engineDir, { recursive: true })
  fs.writeFileSync(path.join(engineDir, 'current.json'), JSON.stringify({
    version: '0.11.0b3',
    venv: path.dirname(path.dirname(enginePython)),
    python: enginePython,
    commands: ['retrieve', 'list-files', 'commit'],
    installedAt: new Date().toISOString(),
  }, null, 2))
}

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
const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
if (enginePython) state.updateSettings({ memoryBackend: 'api' })

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function fakeContext() {
  const parent = { id: 'parent', session: { header: { cwd: path.join(home, 'project') } } }
  const curatorOutput = {
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
  return {
    get(name) {
      if (name === 'agents') return { get: (id) => id === 'parent' ? parent : undefined }
      if (name === 'subagents') {
        return {
          startActivation: async (spec) => {
            assert.equal(spec.request.parent, parent)
            return {
              result: Promise.resolve({
                stopReason: 'completed',
                output: [{ type: 'text', text: JSON.stringify(curatorOutput) }],
              }),
              dispose: async () => {},
            }
          },
        }
      }
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
      return null
    },
  }
}

async function waitJob(id) {
  for (let i = 0; i < 100; i++) {
    const job = getCurationJob(id)
    if (job && job.status !== 'running') return job
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return getCurationJob(id)
}

test('global curator writes a validated memory', { skip: !enginePython }, async () => {
  const ctx = fakeContext()
  const job = startGlobalCuration(ctx, { sessionIds: ['s1'], parentSessionId: 'parent' })
  assert.equal(job.status, 'running')
  const done = await waitJob(job.id)
  assert.equal(done.status, 'completed', done.error || '')
  const index = state.loadGlobalIndex()
  const entries = Object.values(index.entries)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].domain, 'coding')
  assert.ok(entries[0].content.includes('conclusion'))
  const listed = await memory.globalList({ exec: { agent: null } })
  assert.ok(listed.files.some((f) => f.entry && f.entry.domain === 'coding'))
})
