import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { registerHooks } from 'node:module'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-resident-route-'))
process.env.DSH_MEMU_HOME = home

// A recorded engine pointer is enough: the fake child replaces the interpreter,
// but currentEngine() still has to see a python/venv pair.
const engineDir = path.join(home, 'engine')
fs.mkdirSync(engineDir, { recursive: true })
fs.writeFileSync(path.join(engineDir, 'current.json'), JSON.stringify({
  version: '0.11.0b3', venv: path.join(home, 'venv'), python: path.join(home, 'venv', 'python.exe'),
}))

const stub = new URL('./stubs/child-process-spy.mjs', import.meta.url)
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'node:child_process' && String(context.parentURL || '').endsWith('/lib/memu.js')) {
      return { url: stub.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
})

const spawns = []
const requests = []

function createFakeResident() {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = () => {
    child.killed = true
    child.emit('close', 0)
    return true
  }
  let buffer = ''
  child.stdin.on('data', (chunk) => {
    buffer += chunk.toString()
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      const request = JSON.parse(line)
      requests.push(request)
      if (request.op === 'shutdown') continue
      const failed = request.argv[1] === 'boom'
      const stdout = failed ? '' : JSON.stringify({ recall_files: [{ name: 'probe' }], command: request.argv[0] })
      child.stdout.write(JSON.stringify({
        id: request.id,
        code: failed ? 1 : 0,
        stdout,
        stderr: failed ? 'retrieve exploded' : '',
      }) + '\n')
    }
  })
  process.nextTick(() => child.stdout.write(JSON.stringify({ ready: true }) + '\n'))
  return child
}

globalThis.__dshMemuSpawnSpy = () => {
  spawns.push(1)
  return createFakeResident()
}

const memu = await import('../lib/memu.js')

test.after(() => {
  delete globalThis.__dshMemuSpawnSpy
  memu.closeMemuResident()
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

const common = {
  route: 'remote-api',
  db: path.join(home, 'libraries', 'lib_test.sqlite3'),
  provider: 'openai',
  embedModel: 'text-embedding-3-small',
  baseUrl: 'https://example.invalid/v1',
  apiKey: 'sk-probe',
}

test('the remote API vector route reuses one resident interpreter across commands', async () => {
  const first = await memu.retrieve({ query: '码头', ...common })
  const second = await memu.retrieve({ query: '雨伞', ...common })
  const listed = await memu.listFiles({ ...common })

  assert.equal(first.recall_files?.[0]?.name, 'probe')
  assert.equal(second.recall_files?.[0]?.name, 'probe')
  assert.equal(listed.recall_files?.[0]?.name, 'probe')
  assert.equal(spawns.length, 1, 'three commands share one warm interpreter; one-process-per-command would be three spawns')
  assert.equal(requests.length, 3, 'every command reached the resident worker')
  assert.equal(requests[0].argv[0], 'retrieve')
  assert.equal(requests[0].argv[1], '码头')
  assert.equal(requests[2].argv[0], 'list-files')
  // The API route's env travels per command, so reuse never pins the wrong key,
  // model or database into the long-lived interpreter.
  for (const request of requests) {
    assert.equal(request.env.MEMU_BASE_URL, common.baseUrl)
    assert.equal(request.env.MEMU_API_KEY, common.apiKey)
    assert.equal(request.env.MEMU_EMBED_MODEL, common.embedModel)
    assert.equal(request.env.MEMU_DB, common.db)
    assert.equal(request.env.MEMU_MEMORY_MODE, 'local')
  }
})

test('a failing API command rejects with the resident stderr instead of hanging', async () => {
  await assert.rejects(
    () => memu.retrieve({ query: 'boom', ...common }),
    (error) => {
      assert.equal(error.code, 'MEMU_COMMAND_FAILED')
      assert.match(error.message, /retrieve exploded/)
      return true
    },
  )
  // The failed command must not take the interpreter down: the next one is served
  // by the same warm process.
  const after = await memu.retrieve({ query: '码头', ...common })
  assert.equal(after.recall_files?.[0]?.name, 'probe')
  assert.equal(spawns.length, 1)
})
