#!/usr/bin/env node
// Anti-drift gates for documented counts and tracked test files.
//
// Gate 1 - RPC method count:
//   Count the top-level case labels inside the dispatch() function in lib/rpc.js.
//   Other switch statements in that file must not contribute. Then require every
//   <!-- rpc-method-count: N --> marker in README*.md, AGENTS.md and docs/*.md
//   to exist and carry that same measured value.
//
// Gate 2 - test tracking:
//   Compare every tests/**/*.mjs on disk with git ls-files tests/. Files present
//   on disk but not in the index are untracked or never staged, and fail.
//   Only active in a development Git checkout; an npm package install directory
//   has no .git, so the gate is explicitly skipped / not applicable there.
//
// Gate 3 - loader and stub completeness:
//   tests/loader-register.mjs, tests/loader.mjs and the three host stubs must
//   exist and be non-empty; tests/ must contain at least one *.test.mjs.
//
// Run directly with: node scripts/check-doc-drift.mjs [--root <dir>]

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = path.resolve(import.meta.dirname, '..')
const RPC_FILE = 'lib/rpc.js'
const MARKER_RE = /<!--\s*rpc-method-count\s*:\s*(\d+)\s*-->/g
const REQUIRED_FILES = [
  'tests/loader-register.mjs',
  'tests/loader.mjs',
  'tests/stubs/dsh-llm.js',
  'tests/stubs/dsh-session.js',
  'tests/stubs/dsh-tools.js',
]

const outcome = (label, status, summary, details = []) => ({ label, status, summary, details })
const firstLine = (value) => String(value || '').trim().split(/\r?\n/)[0] || ''

// Extract only the top-level case labels of async function dispatch(...).
// The scanner walks the function body with quote/comment awareness and records
// case labels at depth 2: function body depth 1, dispatch switch body depth 2.
// Nested switches inside a case body sit deeper and are ignored.
export function extractDispatchMethods(source) {
  const head = /\basync\s+function\s+dispatch\s*\(/.exec(source)
  if (!head) throw new Error('async function dispatch(...) not found in ' + RPC_FILE)
  let index = head.index + head[0].length
  let parens = 1
  let quote = null
  for (; index < source.length; index++) {
    const ch = source[index]
    if (quote) {
      if (ch === '\\') { index++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '\u0060') { quote = ch; continue }
    if (ch === '(') parens++
    else if (ch === ')') { parens--; if (parens === 0) { index++; break } }
  }
  while (index < source.length && /\s/.test(source[index])) index++
  if (source[index] !== '{') throw new Error('dispatch() parameter list is not followed by a body')
  const names = []
  let depth = 0
  quote = null
  for (; index < source.length; index++) {
    const ch = source[index]
    if (quote) {
      if (ch === '\\') { index++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index)
      index = newline < 0 ? source.length : newline
      continue
    }
    if (ch === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2)
      index = close < 0 ? source.length : close + 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '\u0060') { quote = ch; continue }
    if (ch === '{') { depth++; continue }
    if (ch === '}') {
      depth--
      if (depth === 0) break
      continue
    }
    if (depth !== 2 || !source.startsWith('case', index)) continue
    const before = source[index - 1]
    const after = source[index + 4]
    if ((before && /[\w$]/.test(before)) || (after && /[\w$]/.test(after))) continue
    const label = /^case\s+(['"])([^'"]+)\1\s*:/.exec(source.slice(index))
    if (!label) {
      const line = source.slice(0, index).split('\n').length
      throw new Error('unparseable case label at ' + RPC_FILE + ':' + line)
    }
    names.push(label[2])
  }
  const unique = [...new Set(names)]
  if (unique.length === 0) throw new Error('no top-level case labels found in dispatch() (' + RPC_FILE + ')')
  return unique
}

// Root README*.md, AGENTS.md and docs/*.md are the only docs allowed to carry
// the marker. Keeping the list narrow means a stray marker in another doc
// cannot silently satisfy the gate.
export function docFiles(root) {
  const files = []
  let rootEntries = []
  try {
    rootEntries = fs.readdirSync(root)
  } catch {
    rootEntries = []
  }
  for (const name of rootEntries) {
    if (/^README.*\.md$/.test(name)) files.push(name)
  }
  if (rootEntries.includes('AGENTS.md')) files.push('AGENTS.md')
  try {
    const docsDir = path.join(root, 'docs')
    for (const name of fs.readdirSync(docsDir)) {
      if (name.endsWith('.md')) files.push('docs/' + name)
    }
  } catch {
    // No docs/ directory is not this gate's failure; the marker scan below
    // simply has fewer files and will report the missing marker.
  }
  return [...new Set(files)].sort()
}

export function collectTestFiles(root) {
  const testsDir = path.join(root, 'tests')
  try {
    if (!fs.statSync(testsDir).isDirectory()) return null
  } catch {
    return null
  }
  const out = []
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const nextRel = rel + '/' + entry.name
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(abs, nextRel)
      else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(nextRel)
    }
  }
  walk(testsDir, 'tests')
  return out.sort()
}

export function checkRpcMethodCount(root) {
  const label = 'rpc-method-count'
  let methods = []
  try {
    methods = extractDispatchMethods(fs.readFileSync(path.join(root, RPC_FILE), 'utf8'))
  } catch (error) {
    return outcome(label, 'fail', 'cannot measure the RPC dispatch surface', [
      String(error && error.message ? error.message : error),
      'expected: parse ' + RPC_FILE + ' dispatch()',
    ])
  }
  const expected = methods.length
  const docs = docFiles(root)
  const markers = []
  for (const rel of docs) {
    let text = ''
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8')
    } catch (error) {
      return outcome(label, 'fail', 'cannot read doc file ' + rel, [firstLine(error.message)])
    }
    for (const match of text.matchAll(new RegExp(MARKER_RE.source, 'g'))) {
      markers.push({ file: rel, value: Number(match[1]) })
    }
  }
  if (markers.length === 0) {
    return outcome(label, 'fail', 'no rpc-method-count marker found', [
      'marker: (none)',
      'expected: ' + expected + ' methods (dispatch in ' + RPC_FILE + ')',
      'scanned: ' + (docs.length > 0 ? docs.join(', ') : '(no docs)'),
      'add the marker with the measured value; doc content is owned by the W2 docs work',
    ])
  }
  const values = [...new Set(markers.map((entry) => entry.value))]
  if (values.length === 1 && values[0] === expected) {
    const docCount = new Set(markers.map((entry) => entry.file)).size
    return outcome(label, 'ok', markers.length + ' marker(s) in ' + docCount + ' doc(s) agree on ' + expected + ' RPC methods', [])
  }
  const details = ['expected: ' + expected + ' methods (dispatch in ' + RPC_FILE + ')']
  for (const entry of markers) {
    details.push(entry.file + ': marker ' + entry.value + (entry.value === expected ? ' (agrees)' : ' != expected ' + expected))
  }
  if (values.length > 1) details.push('markers disagree: ' + values.join(', ') + '; all markers must share one value')
  return outcome(label, 'fail', 'rpc-method-count marker drift', details)
}

function gitWorkTree(root) {
  const dotGit = path.join(root, '.git')
  let present = false
  try {
    const stat = fs.statSync(dotGit)
    present = stat.isDirectory() || stat.isFile()
  } catch {
    present = false
  }
  if (!present) return { active: false, reason: 'no .git at repository root' }
  try {
    const output = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    if (output !== 'true') return { active: false, reason: 'git rev-parse --is-inside-work-tree returned ' + (output || '(empty)') }
    return { active: true }
  } catch (error) {
    return { active: false, reason: 'git rev-parse --is-inside-work-tree failed: ' + firstLine(error.stderr || error.message) }
  }
}

export function checkTestTracking(root) {
  const label = 'test-tracking'
  const git = gitWorkTree(root)
  if (!git.active) {
    return outcome(label, 'skipped', git.reason + ' - skipped, not applicable (npm package install directory)', [
      'test tracking is enforced only in a development Git checkout',
      'this location is neither passed nor failed; stage the tests before they can be checked',
    ])
  }
  const disk = collectTestFiles(root)
  if (disk === null) return outcome(label, 'fail', 'tests/ directory not found', ['cannot compare disk tests with git ls-files tests/'])
  let tracked = new Set()
  try {
    const raw = execFileSync('git', ['ls-files', '-z', '--', 'tests/'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    })
    tracked = new Set(raw.split('\0').filter(Boolean).map((file) => file.split('\\').join('/')))
  } catch (error) {
    return outcome(label, 'fail', 'git ls-files tests/ failed', [firstLine(error.stderr || error.message)])
  }
  const untracked = disk.filter((file) => !tracked.has(file))
  if (untracked.length > 0) {
    const details = untracked.map((file) => 'untracked/unstaged: ' + file)
    details.push('git ls-files tests/ reports ' + tracked.size + ' tracked file(s)')
    return outcome(label, 'fail', untracked.length + ' of ' + disk.length + ' test .mjs file(s) are not tracked or staged', details)
  }
  return outcome(label, 'ok', disk.length + ' test .mjs file(s) tracked and staged', [])
}

export function checkLoaderStubs(root) {
  const label = 'loader-stubs'
  const problems = []
  for (const rel of REQUIRED_FILES) {
    const abs = path.join(root, rel)
    let stat = null
    try {
      stat = fs.statSync(abs)
    } catch {
      stat = null
    }
    if (!stat) {
      problems.push(rel + ': missing')
      continue
    }
    if (!stat.isFile()) {
      problems.push(rel + ': not a regular file')
      continue
    }
    let text = ''
    try {
      text = fs.readFileSync(abs, 'utf8')
    } catch (error) {
      problems.push(rel + ': unreadable (' + firstLine(error.message) + ')')
      continue
    }
    if (text.trim().length === 0) problems.push(rel + ': empty (' + stat.size + ' bytes)')
  }
  const tests = collectTestFiles(root)
  if (tests === null) problems.push('tests/: directory missing')
  else if (!tests.some((file) => file.endsWith('.test.mjs'))) problems.push('tests/: no *.test.mjs file')
  if (problems.length > 0) return outcome(label, 'fail', 'loader/stub completeness check failed', problems)
  const testCount = tests.filter((file) => file.endsWith('.test.mjs')).length
  return outcome(label, 'ok', REQUIRED_FILES.length + ' required loader/stub file(s) present; ' + testCount + ' *.test.mjs file(s)', [])
}

export function runChecks(root = DEFAULT_ROOT) {
  const checks = [
    ['rpc-method-count', checkRpcMethodCount],
    ['test-tracking', checkTestTracking],
    ['loader-stubs', checkLoaderStubs],
  ]
  return checks.map(([label, run]) => {
    try {
      return run(root)
    } catch (error) {
      return outcome(label, 'fail', 'check crashed', [firstLine(error && error.stack ? error.stack : error)])
    }
  })
}

export function formatCheck(check) {
  if (check.status === 'ok') return 'ok   ' + check.label + ': ' + check.summary
  if (check.status === 'skipped') return 'skip ' + check.label + ': ' + check.summary
  const lines = ['FAIL ' + check.label + ': ' + check.summary]
  for (const detail of check.details || []) lines.push('     ' + detail)
  return lines.join('\n')
}

function main() {
  const argv = process.argv.slice(2)
  let root = DEFAULT_ROOT
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/check-doc-drift.mjs [--root <dir>]')
      return
    }
    if (arg === '--root') {
      const value = argv[++i]
      if (!value) {
        console.error('--root requires a directory')
        process.exitCode = 2
        return
      }
      root = path.resolve(value)
      continue
    }
    if (arg.startsWith('--root=')) {
      root = path.resolve(arg.slice('--root='.length))
      continue
    }
    console.error('unknown argument: ' + arg)
    process.exitCode = 2
    return
  }
  const checks = runChecks(root)
  for (const check of checks) console.log(formatCheck(check))
  const failed = checks.filter((check) => check.status === 'fail')
  if (failed.length > 0) {
    console.log('\n' + failed.length + ' doc-drift check(s) failed: ' + failed.map((check) => check.label).join(', '))
    process.exitCode = 1
    return
  }
  console.log('\nall doc-drift checks passed')
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) main()
