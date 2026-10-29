import test from 'node:test'
import assert from 'node:assert/strict'

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
  assert.equal(registered.length, 10, `registered ${registered.join(', ')}`)
  dispose()
})
