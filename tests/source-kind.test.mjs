// Guards the message-source format that v4 of the host accepts. A v3 source
// (`{ kind: 'plugin', plugin: 'dsh-memu-memory' }`) is rejected at runtime with
// "format v4 message requires a producer-owned source kind" and the visible
// symptom is a conversation that will not open, so this must never reach a build.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib')
const files = fs.readdirSync(root).filter((name) => name.endsWith('.js'))

// Mirrors the host's KNOWN_FORMS.
const KNOWN_FORMS = new Set(['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'])

test('no v3 plugin source kind survives anywhere in lib/', () => {
  for (const name of files) {
    const text = fs.readFileSync(path.join(root, name), 'utf8')
    assert.doesNotMatch(text, /kind\s*:\s*['"]plugin['"]/, `${name} still builds a v3 source kind`)
    assert.doesNotMatch(text, /kind\s*:\s*['"]plugin['"]\s*,\s*plugin\s*:/, `${name} still passes a bare plugin name`)
  }
})

test('every emitted source kind is producer-owned', () => {
  for (const name of files) {
    const text = fs.readFileSync(path.join(root, name), 'utf8').replaceAll('plugin:${PLUGIN}', 'plugin:dsh-memu-memory')
    for (const match of text.matchAll(/kind\s*:\s*[`'"]([^`'"]+)[`'"]/g)) {
      const kind = match[1]
      // Only source kinds are producer-owned; other `kind` fields (decisions,
      // tool results) are unrelated and never contain a colon.
      if (!kind.includes(':') && kind !== 'plugin') continue
      assert.match(kind, /^plugin:[a-z0-9-]+$/, `${name} emits a source kind that is not producer-owned: ${kind}`)
    }
  }
})

test('every injected message uses a form the host knows', () => {
  for (const name of files) {
    const text = fs.readFileSync(path.join(root, name), 'utf8')
    for (const match of text.matchAll(/form\s*:\s*['"]([^'"]+)['"]/g)) {
      assert.ok(KNOWN_FORMS.has(match[1]), `${name} uses unknown message form: ${match[1]}`)
    }
  }
})

test('the plugin name is the one the source kind advertises', () => {
  const inject = fs.readFileSync(path.join(root, 'inject.js'), 'utf8')
  const privateHalf = fs.readFileSync(path.join(root, 'private.js'), 'utf8')
  assert.match(inject, /const PLUGIN = 'dsh-memu-memory'/)
  assert.match(privateHalf, /kind: 'plugin:dsh-memu-memory'/)
})
