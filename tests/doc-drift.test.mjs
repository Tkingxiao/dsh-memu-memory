import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const GATE = path.join(REPO, 'scripts', 'check-doc-drift.mjs')
const gate = await import(pathToFileURL(GATE).href)

const tempRoots = []
after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true })
  tempRoots.length = 0
})

function tempDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-drift-test-'))
  tempRoots.push(root)
  return root
}

function write(root, rel, body) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

const MARKER = (value) => '<!-- rpc-method-count: ' + value + ' -->'

// Three real dispatch cases plus decoys: a nested switch case (depth 3), two
// commented-out case labels, and a case in a completely different switch.
const RPC_FIXTURE = "export async function dispatch(ctx, endpoint, payload = {}) {\n"
  + "  switch (endpoint) {\n"
  + "    case 'alpha': {\n"
  + "      // case 'commentedOut': not a dispatch method\n"
  + "      /* case 'blockCommented': not one either */\n"
  + "      switch (endpoint) {\n"
  + "        case 'nestedIgnored': return 1\n"
  + "        default: return 2\n"
  + "      }\n"
  + "    }\n"
  + "    case 'beta': return 3\n"
  + "    case 'gamma': return 4\n"
  + "    default: return null\n"
  + "  }\n"
  + "}\n"
  + "\n"
  + "function otherSwitch(kind) {\n"
  + "  switch (kind) {\n"
  + "    case 'notCounted': return 1\n"
  + "    default: return 0\n"
  + "  }\n"
  + "}\n"

function makeFixture(options = {}) {
  const root = tempDir()
  write(root, 'lib/rpc.js', RPC_FIXTURE)
  if (options.marker !== null) {
    const value = options.marker === undefined ? 3 : options.marker
    write(root, 'README.md', '# Fixture\n\n' + MARKER(value) + '\n')
  }
  write(root, 'tests/loader-register.mjs', "export const registered = true\n")
  write(root, 'tests/loader.mjs', "export const loaded = true\n")
  write(root, 'tests/stubs/dsh-llm.js', "export const llm = true\n")
  write(root, 'tests/stubs/dsh-session.js', "export const session = true\n")
  write(root, 'tests/stubs/dsh-tools.js', "export const tools = true\n")
  write(root, 'tests/sample.test.mjs', "import test from 'node:test'\ntest('fixture', () => {})\n")
  for (const [rel, body] of Object.entries(options.docs || {})) write(root, rel, body)
  return root
}

function initGit(root) {
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'pipe' })
}

let gitAvailable = true
try {
  execFileSync('git', ['--version'], { stdio: 'pipe' })
} catch {
  gitAvailable = false
}

const detailText = (result) => (result.details || []).join('\n')

test('extractDispatchMethods counts only top-level cases of dispatch()', () => {
  assert.deepEqual(gate.extractDispatchMethods(RPC_FIXTURE), ['alpha', 'beta', 'gamma'])
})

test('doc discovery covers README*.md, AGENTS.md and docs/*.md only', () => {
  const root = makeFixture({ docs: { 'AGENTS.md': '# agents\n', 'docs/notes.md': '# notes\n', 'other.md': '# ignored\n' } })
  assert.deepEqual(gate.docFiles(root), ['AGENTS.md', 'README.md', 'docs/notes.md'])
})

test('missing rpc-method-count marker fails with expected value', () => {
  const root = makeFixture({ marker: null })
  write(root, 'README.md', '# Fixture\n\nNo marker here.\n')
  const result = gate.checkRpcMethodCount(root)
  assert.equal(result.status, 'fail')
  assert.match(result.summary, /no rpc-method-count marker/)
  assert.match(detailText(result), /marker: \(none\)/)
  assert.match(detailText(result), /expected: 3 methods/)
  assert.match(detailText(result), /README\.md/)
})

test('drifted rpc-method-count marker fails and names file, marker and expected', () => {
  const root = makeFixture({ marker: 4 })
  const result = gate.checkRpcMethodCount(root)
  assert.equal(result.status, 'fail')
  const text = detailText(result)
  assert.match(text, /README\.md: marker 4 != expected 3/)
  assert.match(text, /expected: 3 methods/)
})

test('conflicting markers fail even when one value matches', () => {
  const root = makeFixture({ marker: 3, docs: { 'docs/other.md': MARKER(4) + '\n' } })
  const result = gate.checkRpcMethodCount(root)
  assert.equal(result.status, 'fail')
  const text = detailText(result)
  assert.match(text, /README\.md: marker 3/)
  assert.match(text, /docs\/other\.md: marker 4 != expected 3/)
  assert.match(text, /markers disagree: 3, 4/)
})

test('matching marker passes', () => {
  const root = makeFixture({ marker: 3 })
  const result = gate.checkRpcMethodCount(root)
  assert.equal(result.status, 'ok')
  assert.match(result.summary, /3 RPC methods/)
})

test('agreeing markers in several docs pass', () => {
  const root = makeFixture({ marker: 3, docs: { 'docs/a.md': MARKER(3) + '\n', 'docs/b.md': MARKER(3) + '\n' } })
  assert.equal(gate.checkRpcMethodCount(root).status, 'ok')
})

test('no .git means test tracking is skipped, not failed', () => {
  const root = makeFixture()
  const result = gate.checkTestTracking(root)
  assert.equal(result.status, 'skipped')
  assert.match(result.summary, /not applicable/)
  assert.match(result.summary, /npm package install directory/)
  assert.notEqual(result.status, 'fail')
})

test('temp git repo with all tests staged passes test tracking', (t) => {
  if (!gitAvailable) return t.skip('git not available')
  const root = makeFixture()
  initGit(root)
  const result = gate.checkTestTracking(root)
  assert.equal(result.status, 'ok')
  assert.match(result.summary, /3 test \.mjs file\(s\) tracked and staged/)
})

test('untracked test file on disk in a git repo fails test tracking', (t) => {
  if (!gitAvailable) return t.skip('git not available')
  const root = makeFixture()
  initGit(root)
  write(root, 'tests/leaked.test.mjs', "import test from 'node:test'\ntest('leak', () => {})\n")
  const result = gate.checkTestTracking(root)
  assert.equal(result.status, 'fail')
  const text = detailText(result)
  assert.match(text, /untracked\/unstaged: tests\/leaked\.test\.mjs/)
  assert.doesNotMatch(text, /tests\/sample\.test\.mjs/)
  assert.match(result.summary, /1 of 4 test \.mjs file\(s\) are not tracked or staged/)
})

test('loader and stub completeness passes when every required file is non-empty', () => {
  const root = makeFixture()
  const result = gate.checkLoaderStubs(root)
  assert.equal(result.status, 'ok')
  assert.match(result.summary, /5 required loader\/stub file\(s\) present/)
})

test('missing stub fails and is named', () => {
  const root = makeFixture()
  fs.rmSync(path.join(root, 'tests/stubs/dsh-tools.js'))
  const result = gate.checkLoaderStubs(root)
  assert.equal(result.status, 'fail')
  assert.match(detailText(result), /tests\/stubs\/dsh-tools\.js: missing/)
})

test('empty loader fails and reports zero bytes', () => {
  const root = makeFixture()
  write(root, 'tests/loader.mjs', '')
  const result = gate.checkLoaderStubs(root)
  assert.equal(result.status, 'fail')
  assert.match(detailText(result), /tests\/loader\.mjs: empty/)
})

test('suite without any *.test.mjs fails loader/stub completeness', () => {
  const root = makeFixture()
  fs.rmSync(path.join(root, 'tests/sample.test.mjs'))
  const result = gate.checkLoaderStubs(root)
  assert.equal(result.status, 'fail')
  assert.match(detailText(result), /tests\/: no \*\.test\.mjs file/)
})

test('runChecks returns the three gates in order', () => {
  const root = makeFixture()
  assert.deepEqual(gate.runChecks(root).map((entry) => entry.label), ['rpc-method-count', 'test-tracking', 'loader-stubs'])
})

test('CLI exits 1 and prints FAIL/skip when a gate fails', () => {
  const root = makeFixture({ marker: null })
  const result = spawnSync(process.execPath, [GATE, '--root', root], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /FAIL rpc-method-count/)
  assert.match(result.stdout, /skip test-tracking/)
  assert.match(result.stdout, /1 doc-drift check\(s\) failed: rpc-method-count/)
})

test('CLI exits 0 when all gates pass', () => {
  const root = makeFixture()
  const result = spawnSync(process.execPath, [GATE, '--root', root], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /all doc-drift checks passed/)
})
