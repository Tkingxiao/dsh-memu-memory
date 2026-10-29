import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-engine-'))
process.env.DSH_MEMU_HOME = home

const engine = await import('../lib/engine.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

test('version history reads the memu-cli distribution, not the memu game package', () => {
  const html = [
    '<a href="../../packages/memu_cli-0.11.0b3-py3-none-any.whl#sha256=x">memu_cli-0.11.0b3-py3-none-any.whl</a>',
    '<a href="../../packages/memu_cli-0.11.0b2.tar.gz#sha256=y">memu_cli-0.11.0b2.tar.gz</a>',
    '<a href="../../packages/memu-2.1.4.tar.gz#sha256=z">memu-2.1.4.tar.gz</a>',
  ].join('\n')
  assert.deepEqual(engine.parseSimpleVersions(html).sort(), ['0.11.0b2', '0.11.0b3'])
})

test('sdist suffixes never leak into a version number', () => {
  assert.equal(engine.normalizeVersion('0.11.0b3.tar'), '0.11.0b3')
  assert.equal(engine.normalizeVersion('0.10.0'), '0.10.0')
  assert.equal(engine.normalizeVersion('not-a-version'), null)
})

test('a release sorts above its pre-releases', () => {
  assert.ok(engine.compareVersions('0.11.0', '0.11.0b3') > 0)
  assert.ok(engine.compareVersions('0.11.0b3', '0.11.0b2') > 0)
  assert.ok(engine.compareVersions('0.11.0b1', '0.10.0') > 0)
})
