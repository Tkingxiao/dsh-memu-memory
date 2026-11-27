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

test('the macOS library-validation dlopen error is recognized for the signing repair', () => {
  // Verbatim shape from GitHub issue #1 (macOS one-click install failure).
  const issue = "ImportError: dlopen(/Users/best/.dsh/dsh-memu-memory/engine/0.11.0b3/venv.tmp-47668/lib/python3.12/site-packages/pydantic_core/_pydantic_core.cpython-312-darwin.so, 0x0002): code signature in <path> not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs"
  assert.ok(engine.isMacOSLibraryValidationError(issue))
  assert.ok(engine.isMacOSLibraryValidationError('list-files smoke failed: library validation failed to load _pydantic_core'))
  assert.ok(engine.isMacOSLibraryValidationError('pip install failed: SignatureInvalid'))
  // Unrelated failures must not trigger an interpreter re-sign.
  assert.equal(engine.isMacOSLibraryValidationError('ImportError: No module named memu'), false)
  assert.equal(engine.isMacOSLibraryValidationError('verify failed: memu-cli version mismatch'), false)
  assert.equal(engine.isMacOSLibraryValidationError(''), false)
  assert.equal(engine.isMacOSLibraryValidationError(null), false)
})

// ---- 中断安装的自愈（2026-11-28：rc.5 home 卡在 installing 两天） ----

function writeEngineState(patch) {
  const dir = path.join(home, 'engine')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(patch), 'utf8')
  return dir
}

const DEAD_INSTALL = {
  status: 'installing',
  version: '0.11.0b3',
  step: 'installing-deps:python',
  error: null,
  startedAt: '2026-11-26T06:33:02.636Z',
  updatedAt: '2026-11-26T06:33:05.838Z',
}

test('a dead install becomes failed and its venv.tmp is cleaned up', () => {
  const dir = writeEngineState(DEAD_INSTALL)
  const aborted = path.join(dir, '0.11.0b3', 'venv.tmp-37076-1795674785559')
  const finished = path.join(dir, '0.11.0b3', 'venv-real')
  fs.mkdirSync(aborted, { recursive: true })
  fs.mkdirSync(finished, { recursive: true })

  const status = engine.engineStatus()
  assert.equal(status.status, 'failed', 'a stale installing state must not stay installing forever')
  assert.equal(status.installed, false)
  assert.equal(status.state.step, 'interrupted')
  assert.match(String(status.state.error), /中断/, 'the reason must be readable in the UI')
  assert.ok(!fs.existsSync(aborted), 'the aborted venv must be removed')
  assert.ok(fs.existsSync(finished), 'a finished venv must never be touched')
})

test('a fresh install is left running', () => {
  const now = new Date().toISOString()
  writeEngineState({ ...DEAD_INSTALL, startedAt: now, updatedAt: now })
  assert.equal(engine.engineStatus().status, 'installing', 'a live install must not be reconciled away')
})

test('a held lock means an install is still in flight', () => {
  const dir = writeEngineState(DEAD_INSTALL)
  fs.writeFileSync(path.join(dir, 'install.lock'), JSON.stringify({ pid: 1, startedAt: DEAD_INSTALL.startedAt }), 'utf8')
  try {
    assert.equal(engine.engineStatus().status, 'installing', 'the cross-process lock must veto reconciliation')
  } finally {
    fs.rmSync(path.join(dir, 'install.lock'), { force: true })
  }
})

test('reconciliation is idempotent and leaves a ready engine alone', () => {
  const dir = writeEngineState({ status: 'ready', version: '0.11.0b3', step: 'ready', error: null, updatedAt: '2026-11-26T06:33:05.838Z' })
  fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ version: '0.11.0b3', venv: 'x', python: 'y' }), 'utf8')
  try {
    assert.equal(engine.engineStatus().status, 'ready', 'a ready engine must never be demoted')
  } finally {
    fs.rmSync(path.join(dir, 'current.json'), { force: true })
  }
})
