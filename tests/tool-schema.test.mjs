import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-tool-schema-'))
process.env.DSH_MEMU_HOME = home
test.after(async () => {
  const state = await import('../lib/state.js')
  state.flushState()
  fs.rmSync(home, { recursive: true, force: true })
})

import { defineTool } from './stubs/dsh-tools.js'

// The stub compiles tool schemas with the host's value-schema DSL rules. These
// cases pin the two shapes that the real host refused in production — the reason
// all ten memu tools were missing from the tool surface while every test passed:
// the old stub was `return spec`, so nothing was ever compiled.

const good = (parameters) => ({
  name: 'probe',
  description: 'probe',
  parameters,
  output: { schema: { type: 'string' } },
  timeoutMs: 1000,
  execute: async () => 'ok',
})

test('an object node without an explicit additionalProperties is refused', () => {
  assert.throws(
    () => defineTool(good({
      entity: { type: 'object', properties: { name: { type: 'string' } } },
    })),
    /parameters\.entity\.additionalProperties must be explicitly true or false/,
  )
})

test('array-form required inside array items is refused', () => {
  assert.throws(
    () => defineTool(good({
      attachments: {
        type: 'array',
        items: { type: 'object', properties: { sha256: { type: 'string' } }, required: ['sha256'], additionalProperties: true },
      },
    })),
    /parameters\.attachments\.items\.required is not supported by the value schema DSL/,
  )
})

test('nested required must be the literal true', () => {
  assert.throws(
    () => defineTool(good({
      attachments: {
        type: 'array',
        items: { type: 'object', additionalProperties: true, properties: { sha256: { type: 'string', required: false } } },
      },
    })),
    /required must be true when present/,
  )
  const tool = defineTool(good({
    attachments: {
      type: 'array',
      items: { type: 'object', additionalProperties: true, properties: { sha256: { type: 'string', required: true } } },
    },
  }))
  assert.equal(tool.name, 'probe')
})

test('a non-positive timeout is refused', () => {
  assert.throws(() => defineTool({ ...good({}), timeoutMs: 0 }), /timeoutMs/)
})

test('the shipped tool surface compiles under the host rules', async () => {
  const { registerTools } = await import('../lib/tools.js')
  const registered = []
  const dispose = registerTools({
    tools: { register: (tool) => { registered.push(tool.name); return () => {} } },
    logger: { warn: (message) => { throw new Error(`unexpected registration warning: ${message}`) } },
  })
  assert.equal(registered.length, 14, `registered ${registered.join(', ')}`)
  assert.ok(registered.includes('memu_private_remember_batch'), 'the batch write tool compiles under the host rules')
  dispose()
})

test('recall schemas retain required query, supported enums and integer paging; all 14 outputs stay string', async () => {
  const { registerTools } = await import('../lib/tools.js')
  const tools = []
  const dispose = registerTools({ tools: { register: (tool) => { tools.push(tool); return () => {} } }, logger: { warn() {} } })
  try {
    assert.equal(tools.length, 14)
    for (const tool of tools) {
      assert.deepEqual(tool.output.schema, { type: 'string' })
      assert.deepEqual(tool.output.render({}, 'receipt'), [{ type: 'text', text: 'receipt' }])
    }
    for (const name of ['memu_private_recall', 'memu_global_recall']) {
      const tool = tools.find((item) => item.name === name)
      const p = tool.parameters
      assert.equal(p.query.type, 'string')
      assert.equal(p.query.required, true)
      assert.equal(p.view.type, 'string')
      assert.deepEqual(p.view.enum, ['auto', 'snippet', 'full'])
      assert.equal(p.view.default, 'auto')
      assert.equal(p.offset.type, 'integer')
      assert.equal(p.limitChars.type, 'integer')
      assert.equal(p.revision.type, 'string')
      assert.equal(p.topK.type, 'integer')
      assert.match(p.topK.description, /1\.\.20/)
      assert.match(p.offset.description, /code points/)
      assert.match(p.revision.description, /MEMORY_CHANGED/)
      assert.equal(Object.hasOwn(p, 'libraryId'), name === 'memu_private_recall')
      if (p.libraryId) assert.equal(p.libraryId.type, 'string')
      for (const property of Object.values(p)) {
        assert.equal(Object.hasOwn(property, 'minimum'), false)
        assert.equal(Object.hasOwn(property, 'maximum'), false)
      }
    }
  } finally { dispose() }
})

test('host DSL rejects numeric bounds: recall ranges must stay in execute validation', () => {
  for (const bound of ['minimum', 'maximum']) {
    assert.throws(() => defineTool(good({ offset: { type: 'integer', [bound]: 0 } })), /not supported by the value schema DSL/)
  }
})
