import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// H1 audit item: the published tarball used to carry no tests/ at all, so
// `npm test` inside an installed package reported "tests 0 / pass 0" and exited
// 0 while `npm run check` died with ENOENT on the missing tests/ directory.
// These assertions pin both halves of the fix: tests/ ships, and check-all.mjs
// treats a legitimately absent directory as skip instead of a crash.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))

// A directory may only be skipped when the file that would have been read is
// really absent; every shipped directory must still be syntax-checked.
function fakeInstall({ dirs }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-shipping-'))
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  for (const name of ['check-all.mjs', 'check-doc-drift.mjs', 'check-i18n.mjs']) {
    fs.copyFileSync(path.join(REPO, 'scripts', name), path.join(root, 'scripts', name))
  }
  for (const [rel, body] of Object.entries(dirs)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }
  // Bounds check reads these two before it reaches the i18n stage; they must
  // exist for the run to get past the syntax loop at all.
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# index\n')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fake-install', version: '0.0.0' }))
  return root
}

function runCheckAll(root) {
  return spawnSync(process.execPath, [path.join('scripts', 'check-all.mjs')], { cwd: root, encoding: 'utf8' })
}

test('package.json ships tests/ so the packaged suite is not silently empty', () => {
  assert.ok(Array.isArray(pkg.files), 'package.json needs a files whitelist')
  assert.ok(pkg.files.includes('tests'), 'files must include "tests" or npm test finds 0 test files')
  // The suite is only runnable if its harness (loader + stubs) travels with it.
  for (const rel of ['loader-register.mjs', 'loader.mjs', 'stubs/dsh-llm.js']) {
    assert.ok(fs.existsSync(path.join(REPO, 'tests', rel)), 'tests/' + rel + ' must ship with the package')
  }
})

test('npm test glob still points at the shipped test files', () => {
  assert.match(String(pkg.scripts?.test || ''), /tests\/\*\.test\.mjs/, 'test script must target tests/*.test.mjs')
})

test('check-all.mjs skips a missing tests/ directory instead of crashing', () => {
  const root = fakeInstall({ dirs: { 'lib/probe.js': 'export const ok = 1\n' } })
  try {
    const result = runCheckAll(root)
    const stdout = String(result.stdout || '')
    const stderr = String(result.stderr || '')
    assert.ok(!/ENOENT/.test(stderr), 'a missing tests/ directory must not surface as ENOENT: ' + stderr.slice(0, 400))
    assert.ok(!/at file:\/\//.test(stderr), 'check-all.mjs must not die with a stack trace: ' + stderr.slice(0, 400))
    assert.match(stdout, /skip tests\//, 'the absent directory must be reported as skipped')
    assert.match(stdout, /ok {3}lib\/probe\.js/, 'syntax checking must still run for the directories that exist')
    // Reaching a later stage proves the loop did not abort the whole script.
    assert.match(stdout, /i18n/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('check-all.mjs still checks lib/ and scripts/ when tests/ is present', () => {
  const root = fakeInstall({ dirs: { 'lib/probe.js': 'export const ok = 1\n', 'tests/probe.test.mjs': '// x\n' } })
  try {
    const result = runCheckAll(root)
    const stdout = String(result.stdout || '')
    assert.match(stdout, /ok {3}lib\/probe\.js/)
    assert.match(stdout, /ok {3}scripts\/check-all\.mjs/)
    assert.doesNotMatch(stdout, /skip tests\//)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
