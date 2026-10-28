#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const rootFlag = process.argv.indexOf('--home')
const home = rootFlag >= 0 ? path.resolve(process.argv[rootFlag + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-engine-smoke-'))
fs.mkdirSync(home, { recursive: true })
process.env.DSH_MEMU_HOME = home
process.env.MEMU_CONFIG = path.join(home, 'config.env')
process.env.MEMU_HOME = path.join(home, 'memu')
process.env.DSH_MEMU_PYTHON ||= path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
const state = await import('../lib/state.js')
const engine = await import('../lib/engine.js')
const memu = await import('../lib/memu.js')
const { saveMemuConfig } = await import('../lib/memu-config.js')
state.updateSettings({ memoryBackend: 'api', autoInstallEngine: false, pipIndexes: ['https://pypi.org/simple'] })
state.flushState()
const resultFile = path.join(home, 'smoke-result.json')
console.log(`Isolated engine smoke directory: ${home}`)
let server
try {
  const installed = await engine.ensureEngine({ log: line => console.log(line), beforeSwitch: state.backupDatabases })
  assert.equal(installed.ok, true)
  const current = engine.readCurrent()
  const { stdout } = await promisify(execFile)(current.python, ['-c', 'import importlib.util; print(importlib.util.find_spec("pip") is None)'], { windowsHide: true })
  assert.match(stdout, /True/)
  let requests = 0
  server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const inputs = Array.isArray(body.input) ? body.input : [body.input]
    requests += 1
    const data = inputs.map((text, index) => {
      const digest = crypto.createHash('sha256').update(String(text)).digest()
      const embedding = Array.from({ length: 32 }, (_, i) => (digest[i] - 127) / 128)
      return { object: 'embedding', index, embedding }
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data, model: 'smoke-deterministic', usage: { prompt_tokens: 1, total_tokens: 1 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  saveMemuConfig({ provider: 'openai', model: 'smoke-deterministic', baseUrl, apiKey: 'local-smoke-only' })
  Object.assign(process.env, { MEMU_BASE_URL: baseUrl, MEMU_EMBED_MODEL: 'smoke-deterministic', MEMU_API_KEY: 'local-smoke-only', MEMU_EMBED_PROVIDER: 'openai' })
  const db = path.join(home, 'libraries', 'smoke.sqlite3')
  const name = 'smoke-memory'
  await memu.commit({ db, payload: { recall_files: [{ name, track: 'memory', description: 'Smoke test memory', content: 'A camera is waiting in the station bookshop.' }], resource: [], user: {} } })
  const listed = await memu.listFiles({ db })
  assert.ok(JSON.stringify(listed).includes(name))
  const recalled = await memu.retrieve({ db, query: 'camera in the station bookshop' })
  assert.ok(JSON.stringify(recalled).includes(name))
  assert.ok(requests > 0, 'real CLI called the local embedding endpoint')
  fs.writeFileSync(resultFile, JSON.stringify({ ok: true, version: current.version, noVenvPip: true, commit: true, list: true, retrieve: true, embeddingRequests: requests, at: new Date().toISOString(), note: 'Real pinned CLI; deterministic local embedding verifies the contract, not semantic quality.' }, null, 2))
  console.log(`PASS: real pinned engine install, no-pip venv, commit/list/retrieve; evidence ${resultFile}`)
} catch (error) {
  fs.writeFileSync(resultFile, JSON.stringify({ ok: false, error: error.message, at: new Date().toISOString() }, null, 2))
  console.error(error)
  process.exitCode = 1
} finally {
  server?.close()
  state.flushState()
}
