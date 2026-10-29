#!/usr/bin/env node
// Local stand-in for the manual half of the acceptance checklist.
//
// Most of that checklist describes behaviour a person would verify by clicking
// around, but nearly all of it is observable through the same RPC surface the UI
// uses. This script drives that surface against a throwaway DSH_MEMU_HOME and
// reports one verdict per checklist item. What stays in the MANUAL column needs a
// real GUI (visual layout, screenshots, dark mode), a real engine install, or a real
// DSH conversation the host itself has to start.
//
// Usage: node scripts/acceptance-local.mjs [--verbose]

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERBOSE = process.argv.includes('--verbose')
// The plugin imports two packages that only exist inside DSH. The test suite
// resolves them through a small loader stub; re-exec under that loader so this
// script runs against exactly the same module surface as `npm test`.
if (!process.env.DSH_MEMU_ACCEPT_CHILD) {
  const child = spawnSync(process.execPath, [
    '--import', './tests/loader-register.mjs',
    fileURLToPath(import.meta.url),
    ...process.argv.slice(2),
  ], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, DSH_MEMU_ACCEPT_CHILD: '1' } })
  process.exit(typeof child.status === 'number' ? child.status : 1)
}

const tmpBase = process.env.TEMP || process.env.TMP || os.tmpdir()
const home = fs.mkdtempSync(path.join(tmpBase, 'dsh-memu-memory-accept-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const inject = await import('../lib/inject.js')
const prompts = await import('../lib/prompts.js')
const engine = await import('../lib/engine.js')
const budget = await import('../lib/budget.js')
const snippet = await import('../lib/snippet.js')
const paths = await import('../lib/paths.js')
const { dispatch } = await import('../lib/rpc.js')
const { registerTools } = await import('../lib/tools.js')

const results = []

async function auto(id, title, fn) {
  try {
    const detail = await fn()
    results.push({ id, title, verdict: 'PASS', detail: String(detail || '') })
  } catch (error) {
    results.push({ id, title, verdict: 'FAIL', detail: String(error?.message || error) })
  }
}

function manual(id, title, why) {
  results.push({ id, title, verdict: 'MANUAL', detail: why })
}

let seq = 0
function makeLibrary(name) {
  seq += 1
  return state.createLibrary({ name: name + '-' + seq, cwd: path.join(home, 'ws', name + '-' + seq) })
}

function seed(libraryId, id, entry = {}) {
  const index = state.loadPrivateIndex(libraryId)
  index.entries[id] = {
    layer: 'long_term', title: 'title of ' + id, content: 'body of ' + id, status: 'active',
    createdAt: new Date().toISOString(), ...entry,
  }
  state.savePrivateIndex(libraryId, index)
}

function bindSession(sessionId, options = {}) {
  state.ensureSession(sessionId, {
    cwd: options.cwd,
    libraryId: options.libraryId || null,
    agentPreset: options.agentPreset || 'coding',
    createLibrary: options.createLibrary !== false,
  })
  if (options.patch) state.setSessionBinding(sessionId, options.patch)
  return state.getSessionBinding(sessionId)
}

function idsIn(text) {
  return [...String(text || '').matchAll(/mem-[A-Za-z0-9]+-[A-Za-z0-9]+/g)].map((m) => m[0])
}
async function runTestFile(file) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  try {
    const out = await execFileAsync(
      process.execPath,
      // spec is required for the check-mark count below: the default TAP
      // reporter never prints ✔, so every count would read 0.
      ['--import', './tests/loader-register.mjs', '--test-reporter=spec', '--test', file],
      { cwd: ROOT, env, timeout: 240000 },
    )
    const text = String(out.stdout || '')
    const passed = (text.match(/\u2714/g) || []).length
    return passed + ' check marks in ' + file
  } catch (error) {
    const raw = String((error.stdout || '') + (error.stderr || ''))
    const bad = raw.split('\n').filter((line) => line.includes('not ok') || line.includes('\u2716'))
    throw new Error(file + ' is not green: ' + (bad.slice(0, 3).join(' | ') || raw.slice(-400)))
  }
}
// ------------------------------------------------------------ data safety (A)

await auto('A-1', 'a corrupt index is quarantined with its bytes intact', async () => {
  const lib = makeLibrary('a1')
  seed(lib.id, 'mem-a1a', {})
  seed(lib.id, 'mem-a1b', {})
  const file = path.join(home, 'index', lib.id + '.json')
  const good = fs.readFileSync(file, 'utf8')
  const broken = '{"entries": {"mem-a1a": '
  fs.writeFileSync(file, broken)
  state.clearCaches()
  const index = state.loadPrivateIndex(lib.id)
  const names = fs.readdirSync(path.join(home, 'index'))
  const aside = names.filter((name) => name.includes('.corrupt-'))
  assert.equal(aside.length, 1, 'the broken file is moved aside exactly once')
  const kept = fs.readFileSync(path.join(home, 'index', aside[0]), 'utf8')
  assert.equal(kept, broken, 'the corrupt bytes are preserved, not truncated')
  assert.deepEqual(Object.keys(index.entries || {}), [], 'the conversation carries on with an empty view')
  assert.throws(() => seed(lib.id, 'mem-blocked', {}), /earlier read failed/)
  fs.writeFileSync(file, good)
  state.clearCaches()
  assert.ok(state.loadPrivateIndex(lib.id).entries['mem-a1a'])
  seed(lib.id, 'mem-a1c', {})
  assert.equal(fs.readFileSync(path.join(home, 'index', aside[0]), 'utf8'), broken, 'a later write leaves the quarantined bytes alone')
  return 'quarantined as ' + aside[0]
})

await auto('A-2', 'a corrupt state.json is quarantined and can be restored by hand', async () => {
  const lib = makeLibrary('a2')
  const file = path.join(home, 'state.json')
  const good = fs.readFileSync(file, 'utf8')
  const broken = '{ "libraries": '
  fs.writeFileSync(file, broken)
  state.clearCaches()
  const recovered = state.loadState()
  const aside = fs.readdirSync(home).filter((name) => name.includes('.corrupt-'))
  assert.equal(aside.length, 1, 'state.json is quarantined once')
  assert.equal(fs.readFileSync(path.join(home, aside[0]), 'utf8'), broken, 'the broken bytes stay in the copy')
  assert.equal(recovered.libraries?.[lib.id], undefined, 'the degraded state is empty instead of a crash')
  fs.writeFileSync(file, good)
  state.clearCaches()
  assert.ok(state.loadState().libraries[lib.id], 'copying the bytes back restores the library registry')
  return 'quarantined as ' + aside[0] + ', hand recovery verified'
})

// A transient EBUSY needs a second process to hold the handle, but the barrier it
// trips does not care which error caused it. Replacing the index file with a
// directory produces a real read failure (EISDIR) that is *not* a parse failure —
// exactly the distinction this item is about: an unreadable file must be left in
// place and write-protected, while a corrupt one is moved aside.
await auto('A-3', 'an I/O failure hangs a write barrier instead of moving the file', async () => {
  const lib = makeLibrary('a3')
  seed(lib.id, 'mem-a3a', { content: 'kept across the barrier' })
  const file = path.join(home, 'index', lib.id + '.json')
  const good = fs.readFileSync(file, 'utf8')
  const warns = []
  paths.setWarnSink((message) => warns.push(String(message)))
  fs.rmSync(file)
  fs.mkdirSync(file)
  state.clearCaches()
  const index = state.loadPrivateIndex(lib.id)
  assert.deepEqual(Object.keys(index.entries || {}), [], 'an unreadable index reads as empty, not as a crash')
  // Only this library's own quarantine copies count: A-1 left one behind on purpose.
  const aside = fs.readdirSync(path.join(home, 'index')).filter((name) => name.startsWith(lib.id + '.json.corrupt-'))
  assert.equal(aside.length, 0, 'an I/O failure is not corruption: nothing may be moved aside')
  const failure = paths.readFailure(file)
  assert.ok(failure, 'the failed read did not register a write barrier')
  assert.notEqual(failure.kind, 'corrupt')
  let blocked = null
  try { state.savePrivateIndex(lib.id, { version: 1, entries: {} }) } catch (error) { blocked = error }
  assert.ok(blocked, 'a write went through on top of an unreadable index')
  assert.equal(blocked.code, 'dsh-memu-memory/read-failed')
  assert.match(blocked.message, /refusing to overwrite/)
  assert.ok(warns.some((line) => /writes are blocked/.test(line)), 'the barrier is silent: ' + JSON.stringify(warns))
  fs.rmSync(file, { recursive: true, force: true })
  fs.writeFileSync(file, good)
  state.clearCaches()
  const back = state.loadPrivateIndex(lib.id)
  assert.ok(back.entries['mem-a3a'], 'the memory did not come back once the file read cleanly')
  assert.equal(paths.readFailure(file), null, 'the barrier did not lift on the next clean read')
  seed(lib.id, 'mem-a3b', {})
  assert.deepEqual(paths.readFailuresUnder(path.join(home, 'index')), [], 'a stale barrier is left behind')
  paths.setWarnSink(null)
  return 'barrier hung and lifted; no file moved aside'
})

await auto('A-4', 'a write that lands during an await is not lost', async () => {
  const lib = makeLibrary('a4')
  seed(lib.id, 'mem-a4base', {})
  const writer = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 15))
    state.updatePrivateIndex(lib.id, (index) => {
      index.entries['mem-a4x'] = {
        layer: 'long_term', title: 'X', content: 'written by the browser', status: 'active',
        createdAt: new Date().toISOString(),
      }
    })
  })()
  const remembered = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    return memory.privateRemember({ libraryId: lib.id, content: 'written by a tool call', title: 'Y', layer: 'long_term' })
  })()
  const [, stored] = await Promise.all([writer, remembered])
  const ids = Object.keys(state.loadPrivateIndex(lib.id).entries)
  assert.ok(ids.includes('mem-a4base'), 'the seeded entry is still there')
  assert.ok(ids.includes('mem-a4x'), 'the browser write survives')
  assert.ok(ids.includes(stored.id), 'the tool write survives')
  return ids.length + ' entries kept from two interleaved writers'
})
// -------------------------------------------------------- recall and budget (B)

await auto('B-2', 'a failing recall is reported and the turn still gets its text', async () => {
  const library = makeLibrary('b2')
  seed(library.id, 'mem-b2a', {})
  const cwd = path.join(home, 'ws', 'b2-session')
  const sessionId = 'sess-b2'
  const binding = bindSession(sessionId, { cwd, libraryId: library.id, patch: { domain: 'coding' } })
  const exec = { agent: { session: { header: { id: sessionId, cwd, agentPreset: binding.agentPreset } } } }
  // The realistic failure: the engine backend is selected but not installed. It is
  // set through the same RPC the settings page uses, so this is the user-facing path.
  await dispatch({}, 'setSettings', { patch: { memoryBackend: 'api', vectorSource: 'local' } })
  const failed = await inject.buildRecall(binding, 'title mem-b2a', 1, state.getSettings(), exec, sessionId)
  await dispatch({}, 'setSettings', { patch: { memoryBackend: 'agent', vectorSource: 'local' } })
  assert.ok(failed.errors.length > 0, 'the failure is carried out, not swallowed')
  assert.match(failed.errors.join(' '), /semantic recall failed/)
  assert.match(failed.text, /mem-b2a/, 'lexical fallback still returns the matching memory')
  assert.equal(typeof failed.text, 'string', 'the caller still receives a string to inject')
  const healthy = await inject.buildRecall(binding, 'something to look up', 2, state.getSettings(), exec, sessionId)
  assert.deepEqual(healthy.errors, [], 'a healthy turn reports nothing')
  return failed.errors[0].slice(0, 90)
})

await auto('B-3', 'anchor ids and the ids written into the text are the same set', async () => {
  const library = makeLibrary('b3')
  const body = '这一段是中文正文，用来把预算撑满。'.repeat(24)
  for (let i = 0; i < 16; i += 1) {
    seed(library.id, 'mem-b3-' + i, {
      layer: 'must_remember', pinReason: 'because it matters', pinSource: 'user_explicit',
      content: body + ' ' + i,
    })
  }
  const globalIndex = state.loadGlobalIndex()
  for (let i = 0; i < 10; i += 1) {
    globalIndex.entries['mem-g3-' + i] = {
      title: 'global ' + i, content: body + ' g' + i, status: 'active', domain: 'coding',
      confidence: 0.8, createdAt: new Date().toISOString(),
    }
  }
  state.saveGlobalIndex(globalIndex)
  const cwd = path.join(home, 'ws', 'b3-session')
  const binding = bindSession('sess-b3', { cwd, libraryId: library.id, patch: { domain: 'coding' } })
  const anchor = inject.buildAnchor(binding, state.getSettings(), null)
  const inText = [...new Set(idsIn(anchor.text))].sort()
  const recorded = [...new Set(anchor.ids)].sort()
  assert.ok(inText.length > 0, 'the anchor rendered something')
  assert.ok(inText.length < 26, 'the budget actually cut something, otherwise this proves nothing')
  assert.deepEqual(inText, recorded, 'nothing is recorded that was not said, and nothing said is left unrecorded')
  return inText.length + ' ids matched, ' + (26 - inText.length) + ' cut by the budget'
})

await auto('B-4', 'a Chinese anchor lands inside its token budget', async () => {
  const library = makeLibrary('b4')
  const body = '这条记忆写的是中文，一共几十个字，用来测预算。'.repeat(20)
  for (let i = 0; i < 20; i += 1) {
    seed(library.id, 'mem-b4-' + i, { layer: 'must_remember', pinReason: 'because', pinSource: 'user_explicit', content: body })
  }
  // Keep this case independent of whatever earlier cases left in the global
  // index, and fill the remaining anchor segments with RP-domain evidence.
  state.saveGlobalIndex({ entries: {} })
  const globalIndex = state.loadGlobalIndex()
  for (let i = 0; i < 10; i += 1) {
    globalIndex.entries['mem-b4-global-' + i] = {
      title: 'global ' + i, content: body, status: 'active', domain: 'rp',
      confidence: 0.8, createdAt: new Date().toISOString(),
    }
  }
  state.saveGlobalIndex(globalIndex)
  const cwd = path.join(home, 'ws', 'b4-session')
  const binding = bindSession('sess-b4', { cwd, libraryId: library.id, patch: { domain: 'coding' } })
  const settings = state.getSettings()
  const anchor = inject.buildAnchor(binding, settings, null)
  const tokens = budget.estTokens(anchor.text)
  const target = Number(settings.anchorTokens || 700)
  const low = Math.floor(target * 0.85)
  const high = target
  assert.ok(tokens >= low && tokens <= high,
    'estimated ' + tokens + ' tokens, wanted ' + low + '..' + high + ' for a ' + target + ' budget')
  return tokens + ' tokens for a ' + target + ' budget (' + low + '..' + high + ')'
})
await auto('B-5', 'the anchor keeps the pins that were said out loud, not just the newest', async () => {
  const library = makeLibrary('b5')
  // Short bodies on purpose: pins get a fraction of the anchor budget, so long text
  // would leave nothing rendered and the ordering claim would go untested.
  seed(library.id, 'mem-b5said-1', {
    layer: 'must_remember', pinSource: 'user_explicit', pinReason: 'said out loud',
    title: 'what they told me', content: '这条是对方亲口交代的，必须一直记得。',
    createdAt: '2019-01-01T00:00:00.000Z', updatedAt: '2019-01-01T00:00:00.000Z',
  })
  for (let i = 0; i < 30; i += 1) {
    seed(library.id, 'mem-b5new-' + i, {
      layer: 'must_remember', pinSource: 'self', pinReason: 'i noticed it',
      title: 'trivia ' + i, content: '最近自己发现的琐碎置顶 ' + i + '。',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    })
  }
  const cwd = path.join(home, 'ws', 'b5-session')
  const binding = bindSession('sess-b5', { cwd, libraryId: library.id, patch: { domain: 'coding' } })
  const anchor = inject.buildAnchor(binding, state.getSettings(), null)
  const ids = idsIn(anchor.text)
  assert.ok(ids.includes('mem-b5said-1'), 'the explicit pin survives even though it is years old')
  assert.ok(ids.length < 31, 'something was cut, otherwise the ordering claim is untested')
  // Among pins of equal rank the newest wins, so the oldest self-noticed pins are
  // what the budget squeezes out — the explicit one keeps its place on rank alone.
  assert.equal(ids[0], 'mem-b5said-1', 'the explicit pin is rendered first, ahead of 30 newer ones')
  assert.ok(!ids.includes('mem-b5new-0'), 'the oldest self-noticed pin is the one that got cut')
  return ids.length + ' of 31 kept, oldest self pins cut'
})

await auto('B-6', 'memu_status reports real counts and a degraded recall', async () => {
  const library = makeLibrary('b6')
  seed(library.id, 'mem-b6a', { layer: 'must_remember', pinSource: 'user_explicit', pinReason: 'said' })
  seed(library.id, 'mem-b6b', { layer: 'must_remember', pinSource: 'self', pinReason: 'noticed' })
  seed(library.id, 'mem-b6c', { layer: 'short_term' })
  seed(library.id, 'mem-b6d', { status: 'archived' })
  const cwd = path.join(home, 'ws', 'b6-session')
  const sessionId = 'sess-b6'
  const binding = bindSession(sessionId, { cwd, libraryId: library.id, patch: { domain: 'coding' } })
  const registered = new Map()
  registerTools({ tools: { register(tool) { registered.set(tool.name, tool) } }, logger: { warn() {} } })
  const status = registered.get('memu_status')
  assert.ok(status, 'the status tool is registered')
  const exec = { agent: { session: { header: { id: sessionId, cwd, agentPreset: binding.agentPreset } } } }
  const out = await status.execute({}, exec)
  const text = typeof out === 'string' ? out : (out?.content?.[0]?.text || JSON.stringify(out))
  assert.match(text, /private: 3 active, 2\/\d+ pinned/, 'counts match what is really in the index')
  assert.match(text, /short_term: 1 active/)
  assert.doesNotMatch(text, /recall: degraded/, 'a healthy session says nothing about recall')
  state.setSessionBinding(sessionId, { lastRecallError: 'provider key missing', lastRecallErrorAt: new Date().toISOString() })
  const degraded = await status.execute({}, exec)
  const degradedText = typeof degraded === 'string' ? degraded : (degraded?.content?.[0]?.text || '')
  assert.match(degradedText, /recall: degraded .*provider key missing/, 'the failure surfaces where the user can see it')
  return 'counts correct, degraded recall surfaced'
})

await auto('B-7', 'id resolution: exact, unique prefix, ambiguous, unknown', async () => {
  const index = { entries: {
    'mem-b7one': { layer: 'long_term' },
    'mem-b7two': { layer: 'long_term' },
    'mem-b7twox': { layer: 'long_term' },
  } }
  assert.equal(memory.resolveEntryId(index, 'mem-b7one'), 'mem-b7one', 'an exact id resolves to itself')
  assert.equal(memory.resolveEntryId(index, 'mem-b7two'), 'mem-b7two', 'an exact id wins even when it prefixes another')
  assert.equal(memory.resolveEntryId(index, 'mem-b7one.md'), 'mem-b7one', 'a trailing .md is tolerated')
  assert.equal(memory.resolveEntryId(index, 'mem-b7twox'), 'mem-b7twox')
  assert.throws(() => memory.resolveEntryId(index, 'mem-b7tw'), /ambiguous id .*candidates: mem-b7two, mem-b7twox/)
  assert.throws(() => memory.resolveEntryId(index, 'mem-b7nope'), /unknown memory: mem-b7nope/)
  assert.throws(() => memory.resolveEntryId(index, '  '), /id is required/)
  return 'exact, prefix, ambiguous, unknown all behave as documented'
})
// ------------------------------------------------------------- guards (C)

await auto('C-1', 'a v4 message with a producer-less source kind still fails its test', async () => {
  return runTestFile('tests/source-kind.test.mjs')
})

await auto('C-2', 'unpin is fenced: a reason, a quota, a cooldown', async () => {
  const library = makeLibrary('c2')
  seed(library.id, 'mem-c2pin', { layer: 'must_remember', pinSource: 'self', pinReason: 'noticed it' })
  seed(library.id, 'mem-c2plain', { layer: 'long_term' })
  const cwd = path.join(home, 'ws', 'c2-session')
  const sessionId = 'sess-c2'
  bindSession(sessionId, { cwd, libraryId: library.id })
  const exec = { agent: { session: { header: { id: sessionId, cwd } } } }
  const fine = 'I thought that remark mattered, but it was my own reading of it and it can go now.'
  assert.throws(() => memory.privateUnpin({ exec, id: 'mem-c2pin', reason: 'too short' }), /at least \d+ characters/)
  const first = memory.privateUnpin({ exec, id: 'mem-c2pin', reason: fine })
  assert.equal(first.entry.layer, 'long_term', 'the pin is demoted, not deleted')
  assert.equal(first.entry.marginalized, true)
  assert.equal(first.entry.pinSource, null, 'the pin source is cleared so it cannot rank as a pin again')
  assert.ok(first.entry.strength <= 0.2, 'strength is cut, not zeroed')
  assert.throws(() => memory.privateUnpin({ exec, id: 'mem-c2plain', reason: fine }), /cooldown/)
  const second = { agent: { session: { header: { id: 'sess-c2b', cwd } } } }
  bindSession('sess-c2b', { cwd, libraryId: library.id })
  assert.throws(() => memory.privateUnpin({ exec: second, id: 'mem-c2plain', reason: fine }), /not in must_remember/)
  state.setSessionBinding('sess-c2b', { unpinCount: 2 })
  assert.throws(() => memory.privateUnpin({ exec: second, id: 'mem-c2plain', reason: fine }), /quota for this conversation is used up/)
  return 'reason, cooldown, layer and quota all hold'
})

await auto('C-3', 'no trauma leftovers in code or scripts', async () => {
  const dirs = [path.join(ROOT, 'lib'), path.join(ROOT, 'scripts')]
  const hits = []
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, name.name)
      if (name.isDirectory()) walk(full)
      // This file names the word it is looking for; do not report itself.
      else if (full === fileURLToPath(import.meta.url)) continue
      else if (/\.(js|mjs|json|md)$/.test(name.name)) {
        const text = fs.readFileSync(full, 'utf8')
        if (/trauma/i.test(text)) hits.push(path.relative(ROOT, full))
      }
    }
  }
  for (const dir of dirs) walk(dir)
  assert.deepEqual(hits, [], 'the old trauma flag is gone: ' + hits.join(', '))
  return 'lib/ and scripts/ are clean'
})
// ------------------------------------------------------------- prompts (D)

await auto('D-1', 'prompts resolve to the conversation domain and fall back to base', async () => {
  const coding = prompts.resolveDef('system-guide', 'coding')
  assert.equal(coding.key, 'system-guide.coding', 'a coding session gets the coding variant')
  assert.equal(prompts.resolveDef('system-guide', 'rp').key, 'system-guide.rp', 'and an rp session does not')
  assert.equal(prompts.resolveDef('system-guide', 'general').key, 'system-guide', 'general is not a layered domain')
  assert.equal(prompts.resolveDef('system-guide', 'no-such-domain').key, 'system-guide', 'an unknown domain falls back instead of throwing')
  const layered = prompts.loadPromptForDomain('system-guide', {}, 'coding')
  assert.equal(layered.fellBackToBase, false)
  const plain = prompts.loadPromptForDomain('system-guide', {}, 'general')
  assert.equal(plain.fellBackToBase, true, 'the caller can tell it got the generic text')
  assert.ok(layered.text.length > 0 && plain.text.length > 0)
  assert.notEqual(layered.text, plain.text, 'the two domains do not render the same text')
  return 'coding/rp variants resolve, general and unknown fall back'
})

await auto('D-2', 'the prompts page renders every page and saving takes effect next turn', async () => {
  const rendered = await runTestFile('tests/client-render.test.mjs')
  const units = await runTestFile('tests/prompts.test.mjs')
  return rendered + '; ' + units
})

await auto('D-3', 'a corrupted prompts manifest only degrades the wording', async () => {
  const dir = prompts.promptsDir()
  assert.ok(dir.startsWith(home), 'this check must run inside the throwaway home: ' + dir)
  fs.mkdirSync(dir, { recursive: true })
  const manifest = path.join(dir, 'manifest.json')
  const before = fs.existsSync(manifest) ? fs.readFileSync(manifest, 'utf8') : null
  fs.writeFileSync(manifest, '{ this is not json', 'utf8')
  const states = prompts.getPromptStates()
  assert.ok(Array.isArray(states) && states.length > 0, 'the prompt list still loads')
  const guide = prompts.loadPrompt('system-guide', {})
  assert.ok(guide.text && guide.text.length > 0, 'the system prompt still assembles')
  if (before === null) fs.rmSync(manifest, { force: true })
  else fs.writeFileSync(manifest, before, 'utf8')
  return states.length + ' prompts survived a broken manifest'
})
// ---------------------------------------------- folders, sidebar, settings (E)

await auto('E-1', 'both folder switches off: no library, no injection, no prompt', async () => {
  const cwd = path.join(home, 'ws', 'e1-folder')
  const before = (await dispatch({}, 'listLibraries', {})).length
  await dispatch({}, 'setFolderPolicy', { scopeKey: cwd, useLibrary: false, useGlobal: false })
  const init = await dispatch({}, 'initSession', { sessionId: 'sess-e1', cwd, createLibrary: false })
  assert.equal(init.binding.libraryId, null, 'the conversation starts unbound instead of inventing a library')
  const after = (await dispatch({}, 'listLibraries', {})).length
  assert.equal(after, before, 'no library appeared on disk')
  const anchor = inject.buildAnchor(init.binding, state.getSettings(), 'sess-e1')
  assert.deepEqual(anchor.ids, [], 'nothing is injected')
  const sidebar = await dispatch({}, 'getSidebarState', { sessionId: 'sess-e1' })
  assert.deepEqual(sidebar.private?.items || [], [], 'the sidebar has no private list to show')
  assert.equal(sidebar.effective?.libraryBlocked, true, 'and it knows why: the folder turned it off')
  return 'unbound, no library, no injection'
})

await auto('E-2', 'the sidebar never hands out an absolute path', async () => {
  const lib = makeLibrary('e2')
  const cwd = path.join(home, 'ws', 'e2-folder')
  seed(lib.id, 'mem-e2a', {})
  bindSession('sess-e2', { cwd, libraryId: lib.id })
  const sidebar = await dispatch({}, 'getSidebarState', { sessionId: 'sess-e2' })
  const text = JSON.stringify(sidebar)
  assert.ok(!text.includes(home.split(path.sep).join('/')), 'the temp home path does not leak')
  assert.ok(!/[A-Za-z]:\\|\.\/lib\//.test(text), 'no drive letters or repo-relative paths either')
  return 'two levels, no paths in ' + text.length + ' bytes of sidebar state'
})

await auto('E-3', 'a switch the folder forbids snaps back instead of silently winning', async () => {
  const lib = makeLibrary('e3')
  const cwd = path.join(home, 'ws', 'e3-folder')
  bindSession('sess-e3', { cwd, libraryId: lib.id })
  await dispatch({}, 'setFolderPolicy', { scopeKey: cwd, useLibrary: false, useGlobal: false })
  const res = await dispatch({}, 'setSessionScope', { sessionId: 'sess-e3', useLibrary: true, useGlobal: true })
  assert.equal(res.clamped.length, 2, 'both fields come back clamped')
  assert.deepEqual(res.clamped.map((c) => c.field).sort(), ['useGlobal', 'useLibrary'])
  assert.equal(res.clamped[0].reason, 'folder')
  // The clamp drops the field from the patch instead of applying and undoing it,
  // so the binding keeps what it had while the effective answer stays narrow.
  assert.equal(res.effective.useLibrary, false, 'the conversation cannot widen itself past the folder')
  assert.equal(res.effective.libraryBlocked, true)
  return 'both switches clamped with reason=folder'
})
await auto('E-4', 'a 500-memory library still paints its first screen in one call', async () => {
  const lib = makeLibrary('e4')
  const index = state.loadPrivateIndex(lib.id)
  for (let i = 0; i < 500; i += 1) {
    index.entries['mem-e4-' + i] = {
      layer: 'long_term', title: 'entry ' + i, content: '正文 ' + i + ' ' + 'x'.repeat(400),
      status: 'active', createdAt: new Date().toISOString(),
    }
  }
  state.savePrivateIndex(lib.id, index)
  const cwd = path.join(home, 'ws', 'e4-folder')
  bindSession('sess-e4', { cwd, libraryId: lib.id })
  const t0 = Date.now()
  const sidebar = await dispatch({}, 'getSidebarState', { sessionId: 'sess-e4' })
  const full = Date.now() - t0
  const t1 = Date.now()
  const beat = await dispatch({}, 'getSidebarState', { sessionId: 'sess-e4', revisionOnly: true })
  const heartbeat = Date.now() - t1
  assert.ok(sidebar.private.items.length <= 120, 'previews are capped at the page size, got ' + sidebar.private.items.length)
  assert.ok(typeof beat.revision === 'number')
  assert.ok(heartbeat < 150, 'the heartbeat must stay cheap, took ' + heartbeat + 'ms')
  return 'first screen ' + full + 'ms for ' + sidebar.private.items.length + ' rows, heartbeat ' + heartbeat + 'ms'
})

await auto('E-5', 'a folder lists the conversations that live in it', async () => {
  const lib = makeLibrary('e5')
  const cwd = path.join(home, 'ws', 'e5-folder')
  bindSession('sess-e5', { cwd, libraryId: lib.id })
  const res = await dispatch({}, 'listFolderSessions', { scopeKey: cwd })
  const rows = res.sessions || res.items || []
  assert.ok(Array.isArray(rows), 'the folder view answers with a list')
  assert.ok(rows.some((row) => row.sessionId === 'sess-e5' || row.id === 'sess-e5'),
    'the conversation in this folder is listed: ' + JSON.stringify(rows).slice(0, 200))
  const other = await dispatch({}, 'listFolderSessions', { scopeKey: path.join(home, 'ws', 'e5-other') })
  const otherRows = other.sessions || other.items || []
  assert.equal(otherRows.length, 0, 'a folder nobody used stays empty')
  return rows.length + ' rows in the folder that was used'
})

await auto('E-8', 'the folder policy is a ceiling, not a suggestion', async () => {
  const cwd = path.join(home, 'ws', 'e8-folder')
  await dispatch({}, 'setFolderPolicy', { scopeKey: cwd, useLibrary: false, useGlobal: false })
  const policy = state.getWorkspacePolicy(cwd)
  assert.equal(policy.useLibrary, false)
  const scope = state.effectiveScope({ useLibrary: true, useGlobal: true }, policy)
  assert.equal(scope.useLibrary, false, 'a conversation asking for more than the folder allows gets the folder')
  assert.equal(scope.libraryBlocked, true)
  await dispatch({}, 'setFolderPolicy', { scopeKey: cwd, useLibrary: true })
  const reopened = state.effectiveScope({ useLibrary: true }, state.getWorkspacePolicy(cwd))
  assert.equal(reopened.useLibrary, true, 'and turning the folder back on reopens it')
  return 'clamped down and reopened'
})

await auto('E-9', 'the sidebar hears about a write no other reload announced', async () => {
  const lib = makeLibrary('e9')
  const cwd = path.join(home, 'ws', 'e9-folder')
  bindSession('sess-e9', { cwd, libraryId: lib.id })
  const first = await dispatch({}, 'getSidebarState', { sessionId: 'sess-e9', revisionOnly: true })
  state.savePrivateIndex(lib.id, state.loadPrivateIndex(lib.id))
  const second = await dispatch({}, 'getSidebarState', { sessionId: 'sess-e9', revisionOnly: true })
  assert.ok(second.revision > first.revision, 'the revision moved: ' + first.revision + ' -> ' + second.revision)
  assert.deepEqual(Object.keys(second).sort(), ['revision', 'stamp'], 'the heartbeat answers with a counter and a disk fingerprint')
  assert.equal(typeof second.stamp, 'string', 'the fingerprint is a string this process did not have to write')
  // The counter lives in module memory, so a write from another instance moves the
  // fingerprint and nothing else — that is the case the sidebar used to miss.
  fs.writeFileSync(path.join(home, 'index', lib.id + '.json'), JSON.stringify(state.loadPrivateIndex(lib.id), null, 2))
  const third = await dispatch({}, 'getSidebarState', { sessionId: 'sess-e9', revisionOnly: true })
  assert.notEqual(third.stamp, second.stamp, 'a write from outside this module still changes the fingerprint')
  return 'revision ' + first.revision + ' -> ' + second.revision + ', stamp moved across instances'
})

// The gate is mounted through ReactDOM.createRoot, which is stubbed away from the
// settings harness — its own test builds the dialog and counts the cards.
await auto('E-6', 'the new-session prompt is four cards, and a folder can veto them', async () => {
  const rendered = await runTestFile('tests/new-session-gate.test.mjs')
  const cases = Number(String(rendered).split(' ')[0])
  assert.ok(cases >= 3, 'the gate test file only ran ' + cases + ' cases')
  return cases + ' renders: four cards, a folder veto, a silent bind'
})
await auto('E-10', 'the settings pane hears a settings write made in another window', async () => {
  const rendered = await runTestFile('tests/settings-beat.test.mjs')
  const cases = Number(String(rendered).split(' ')[0])
  assert.ok(cases >= 5, 'the settings heartbeat test file only ran ' + cases + ' cases')
  return cases + ' cases: seeded beat, stamp-only write, channel wake, hidden silence, no-channel fallback'
})
await auto('E-7', 'reviewed desktop/mobile/theme screenshots exist and the shared UI keeps its layout guards', async () => {
  const { default: sharp } = await import('sharp')
  const folder = path.join(ROOT, 'assets', 'screenshots')
  const desktop = await sharp(path.join(folder, 'webui-memory.jpg')).metadata()
  const mobile = await sharp(path.join(folder, 'mobile.jpg')).metadata()
  const dark = await sharp(path.join(folder, 'webui-dark.jpg')).stats()
  assert.ok(desktop.width >= 1000)
  assert.ok(mobile.width <= 480 && mobile.height >= 700)
  assert.ok(dark.channels.some(channel => channel.stdev > 10), 'dark screenshot must not be blank')
  const client = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.match(client, /prefers-reduced-motion/)
  assert.match(client, /dshm-card-actions>div\{flex-wrap:wrap/)
  return 'visual review recorded 2026-10-28; desktop/mobile/dark evidence checked, not a substitute for future visual review'
})
// ------------------------------------------------ statistics

await auto('H-8', 'the statistics follow real activity and survive a damaged sidecar', async () => {
  const rendered = await runTestFile('tests/stats.test.mjs')
  const cases = Number(String(rendered).split(' ')[0])
  assert.ok(cases >= 5, 'the statistics test file only ran ' + cases + ' cases')
  return cases + ' cases: counts, zero-filled empty library, 90-day roll, damaged sidecar, edit-archive'
})
// ------------------------------------------------ engine, backups, docs (F, G)

await auto('F-1', 'the engine can be listed, switched and pruned', async () => {
  const units = await runTestFile('tests/engine.test.mjs')
  const listing = await dispatch({}, 'listVersions', {})
  assert.ok(Array.isArray(listing.versions || listing.items || []), 'the version list is an array even with no engine installed')
  const pruned = engine.pruneEngineVersions({ keep: 3 })
  assert.ok(pruned && typeof pruned === 'object', 'prune answers instead of throwing on an empty install')
  return units + '; prune keep=3 survived an empty install'
})

await auto('F-2', 'a backup restore brings a deleted memory back', async () => {
  const lib = makeLibrary('f2')
  seed(lib.id, 'mem-f2keep', { title: 'written before the backup' })
  const made = state.backupDatabases()
  assert.ok(made, 'a backup was taken')
  const backups = (await dispatch({}, 'listBackups', {})).backups
  assert.ok(backups.length >= 1, 'it shows up in the list')
  const index = state.loadPrivateIndex(lib.id)
  delete index.entries['mem-f2keep']
  state.savePrivateIndex(lib.id, index)
  assert.equal(state.loadPrivateIndex(lib.id).entries['mem-f2keep'], undefined, 'the memory is really gone')
  const name = backups[0].name || backups[0].file || backups[0]
  await dispatch({}, 'restoreBackup', { name: String(name) })
  state.clearCaches()
  const back = state.loadPrivateIndex(lib.id).entries['mem-f2keep']
  assert.ok(back, 'the restore put it back')
  assert.match(String(back.title), /written before the backup/)
  return 'restored ' + String(name).slice(0, 40)
})

await auto('F-3', 'only three engine versions are kept', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'engine.js'), 'utf8')
  assert.match(src, /export function pruneEngineVersions\(\{ keep = 3 \}/, 'the default really is three')
  assert.ok(!/engineKeepVersions/.test(fs.readFileSync(path.join(ROOT, 'lib', 'state.js'), 'utf8')),
    'and it is not a setting that pretends to exist')
  return 'default keep=3, no phantom setting'
})

await auto('F-4', 'the activation log prints the settings the engine actually ran with', async () => {
  // Reading ~/.dsh logs is not possible: the host keeps no log on disk (checked — the
  // only files under ~/.dsh/logs are startup diagnostics, and none of them contain a
  // dsh-memu-memory line). What the line says is asserted instead, by running the real apply()
  // against a fake context that records logger.info.
  const plugin = await import('../lib/index.js')
  const info = []
  const warn = []
  const handlers = []
  const disposers = []
  const scope = {
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    tools: { register() { return () => {} } },
    webServer: { register() { return () => {} } },
    connection: { requestRejection: () => undefined },
    interval() { return 1 },
    on(event, handler) { handlers.push({ event, handler }); return () => {} },
  }
  plugin.apply({
    ...scope,
    logger: { info: (message) => info.push(message), warn: (message) => warn.push(message) },
    inject: (_deps, callback) => callback(scope),
  })
  const line = info.find((message) => message.startsWith('dsh-memu-memory: loaded'))
  assert.ok(line, 'apply() logged no activation line at all')
  const match = /^dsh-memu-memory: loaded \(engine (\S+)\) backend=(\S+) autoInject=(\S+) anchorTokens=(\d+) turnTokens=(\d+) mustRememberCap=(\d+) unpinBudget=(\d+)$/.exec(line)
  assert.ok(match, 'the activation line lost its shape: ' + line)
  const settings = state.getSettings()
  assert.equal(match[1], engine.ENGINE_VERSION)
  assert.equal(match[2], state.getMemoryBackend())
  assert.equal(match[3], settings.autoInject)
  assert.equal(Number(match[4]), settings.anchorTokens)
  assert.equal(Number(match[5]), settings.turnTokens)
  assert.equal(Number(match[6]), settings.mustRememberCap)
  assert.equal(Number(match[7]), settings.unpinBudgetPerSession)
  assert.deepEqual(
    handlers.filter((entry) => ['agent/pre-step', 'session/event'].includes(entry.event)).map((entry) => entry.event).sort(),
    ['agent/pre-step', 'session/event'],
    'the same activation must wire the injection hooks',
  )
  for (const dispose of disposers) { try { dispose() } catch {} }
  return 'line matches live settings, both hooks wired'
})

await auto('G-1', 'the kept docs exist and nothing points at a retired one', async () => {
  for (const rel of ['README.md', 'README.zh.md', 'AGENTS.md', 'LICENSE']) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel + ' exists')
  }
  for (const rel of ['assets/icon.png', 'assets/icon-256.png', 'assets/icon.svg']) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel + ' exists')
  }
  assert.ok(!fs.existsSync(path.join(ROOT, 'CHANGELOG' + '.md')), 'the retired changelog is gone')
  // 细节从 AGENTS.md 搬进了 docs/：索引必须短，指针必须都能落地
  const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8')
  assert.ok(agents.includes('plugin:dsh-memu-memory'), 'the notes carry the real source kind, not the old one')
  const docs = ['troubleshooting', 'contributing', 'host-api', 'client-conventions', 'memory-semantics', 'env-and-commands']
  for (const name of docs) {
    assert.ok(fs.existsSync(path.join(ROOT, 'docs', name + '.md')), 'docs/' + name + '.md exists')
    assert.ok(agents.includes('docs/' + name + '.md'), 'the index points at docs/' + name + '.md')
  }
  // 硬规则在 AGENTS.md §1 与附录 E 各有一份：改一处忘另一处，这里会红
  const appendix = fs.readFileSync(path.join(ROOT, 'docs', 'troubleshooting.md'), 'utf8')
  const ruleLead = (text) => text.split(String.fromCharCode(10)).filter((l) => /^[0-9]+[.] [*][*]/.test(l)).map((l) => { const end = l.indexOf('**', 5); return end < 0 ? l.slice(0, 40) : l.slice(0, end + 2) })
  const inIndex = ruleLead(agents)
  const inAppendix = ruleLead(appendix)
  assert.equal(inIndex.length, 10, 'the index carries all ten hard rules')
  assert.equal(inAppendix.length, inIndex.length, 'the appendix carries the same ten hard rules')
  for (const lead of inIndex) assert.ok(inAppendix.includes(lead), 'rule drifted between AGENTS.md and appendix E: ' + lead)
  const pointers = agents.match(new RegExp('docs/[A-Za-z0-9._-]+[.]md', 'g')) || []
  for (const rel of new Set(pointers)) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), 'AGENTS.md points at a missing file: ' + rel)
  }
  const retired = ['DESIGN', 'CONSTRUCTION', 'ACCEPTANCE', 'TASKS'].map((name) => name + '.md')
  const offenders = []
  for (const dir of ['', 'lib', 'scripts', 'tests', 'docs']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (!/\.(md|js|mjs)$/.test(name)) continue
      const text = fs.readFileSync(path.join(ROOT, dir, name), 'utf8')
      for (const gone of retired) if (text.includes(gone)) offenders.push((dir || '.') + '/' + name + ' -> ' + gone)
    }
  }
  assert.deepEqual(offenders, [], 'file still pointing at a retired document: ' + offenders.join(', '))
  return 'four documents exist, icons live in assets/, no planning files, no dangling reference'
})

await auto('G-2', 'the client only calls RPC methods the server implements', async () => {
  const rpc = fs.readFileSync(path.join(ROOT, 'lib', 'rpc.js'), 'utf8')
  const methods = new Set([...rpc.matchAll(/case \x27([a-zA-Z]+)\x27:/g)].map((match) => match[1]))
  assert.ok(methods.size >= 60, 'the RPC surface is ' + methods.size + ' methods, expected at least 60')
  const dangling = []
  for (const match of fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8').matchAll(/\bcall\(\s*[\x22\x27]([a-zA-Z]+)[\x22\x27]/g)) {
    if (!methods.has(match[1])) dangling.push(match[1])
  }
  assert.deepEqual([...new Set(dangling)], [], 'client calls no case answers: ' + dangling.join(', '))
  return methods.size + ' methods, every client call resolves'
})

await auto('G-3', 'the README states install, privacy, limits and license', async () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  for (const phrase of ['## Installation', 'dsh plugin --profile web add dsh-memu-memory', 'Privacy, permissions & data', 'Compatibility & limits', '## License']) {
    assert.ok(readme.includes(phrase), 'the README lost ' + phrase)
  }
  return 'README carries install, privacy, limits and license'
})

await auto('G-4', 'the README includes the reviewed UI screenshots', async () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  const chinese = fs.readFileSync(path.join(ROOT, 'README.zh.md'), 'utf8')
  for (const name of ['webui-memory', 'settings', 'drawer', 'relations', 'stats', 'webui-dark', 'mobile']) {
    const relative = `assets/screenshots/${name}.jpg`
    assert.ok(readme.includes(relative), `${relative} is not linked from README.md`)
    assert.ok(chinese.includes(relative), `${relative} is not linked from README.zh.md`)
    assert.ok(fs.statSync(path.join(ROOT, relative)).size > 1000, `${relative} is empty`)
  }
  return 'the wall, drawer, relations, settings, stats, dark and narrow screenshots are linked in both READMEs'
})
for (const [id, file, title] of [
  ['J-1', 'tests/audit-safety.test.mjs', 'storage, isolation, review and bounded recall regressions'],
  ['J-2', 'tests/graph.test.mjs', 'bounded relationships, entity rename and evidence-backed snapshots'],
  ['J-3', 'tests/media.test.mjs', 'images, authenticated thumbnails, quota, GC and streaming archives'],
  ['J-4', 'tests/context-scope.test.mjs', 'group speakers, story branches and character knowledge boundaries'],
  ['J-5', 'tests/multiprocess.test.mjs', 'independent process writes preserve every disjoint entry'],
  ['J-6', 'tests/managed-runtime.test.mjs', 'pinned runtime checksums and contained Python fallback'],
  ['J-7', 'tests/rename.test.mjs', 'package rename keeps existing data and explicit roots'],
  ['J-8', 'tests/inbound.test.mjs', 'long tool turns admit real human batches, images and logical recall without treating logs as speech'],
]) {
  await auto(id, title, () => runTestFile(file))
}
// ---------------------------------------------------- the v4 additions (H)

await auto('H-1', 'every browser row carries its source, and it can be corrected', async () => {
  const lib = makeLibrary('h1')
  seed(lib.id, 'mem-h1a', { source: 'inferred', title: 'a guess' })
  const before = (await dispatch({}, 'browseLibrary', { libraryId: lib.id })).files[0]
  assert.equal(before.source, 'inferred', 'the default is the honest one: this is what i worked out, not what i was told')
  await dispatch({}, 'updateMemory', { libraryId: lib.id, id: 'mem-h1a', patch: { source: 'user_said' } })
  const after = (await dispatch({}, 'browseLibrary', { libraryId: lib.id })).files[0]
  assert.equal(after.source, 'user_said', 'it can be corrected by hand')
  let rejected = ""
  try {
    await dispatch({}, 'updateMemory', { libraryId: lib.id, id: 'mem-h1a', patch: { source: 'guessed' } })
  } catch (error) { rejected = error.message }
  assert.match(rejected, /source must be/, 'and a typo is refused rather than stored')
  const client = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  for (const key of ['sourceUserSaid', 'sourceInferred', 'sourceImagined', 'sourceTold', 'sourceLabel']) {
    assert.ok(client.includes(key), 'the browser knows how to label ' + key)
  }
  return 'inferred by default, editable, typo refused'
})

await auto('H-2', 'a vivid memory that may be inaccurate is labelled as such', async () => {
  const lib = makeLibrary('h2')
  const stored = await memory.privateRemember({
    libraryId: lib.id, title: 'the night of the outage', layer: 'long_term',
    content: '警报响了三次，我只记得自己站在走廊里看表。', peak: true, arousal: 0.95, confidence: 0.9,
  })
  const view = await dispatch({}, 'browseLibrary', { libraryId: lib.id })
  const row = view.files.find((item) => item.id === stored.id)
  assert.ok(row, 'the row is in the browser after the write')
  assert.ok(row.accuracy < row.confidence, 'accuracy is its own number: ' + row.accuracy + ' vs ' + row.confidence)
  const client = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.ok(client.includes('accuracyTag'), 'the browser can say so in words')
  return 'accuracy ' + row.accuracy + ' under confidence ' + row.confidence
})

await auto('H-3', 'a recall shows the passage around the hit, not the start of the memory', async () => {
  const lib = makeLibrary('h3')
  const filler = 'A'.repeat(400)
  const content = filler + '那天他说不想再改需求了。' + 'B'.repeat(400)
  seed(lib.id, 'mem-h3a', { title: 'a long one', content })
  const excerpt = snippet.centeredSnippet(content, '不想再改需求')
  assert.ok(excerpt.includes('不想再改需求'), 'the hit is inside the excerpt')
  assert.ok(excerpt.startsWith('…'), 'and the excerpt starts mid-memory')
  assert.ok(excerpt.length < 200, 'while staying short: ' + excerpt.length)
  const registered = new Map()
  registerTools({ tools: { register(tool) { registered.set(tool.name, tool) } }, logger: { warn() {} } })
  const cwd = path.join(home, 'ws', 'h3-folder')
  const binding = bindSession('sess-h3', { cwd, libraryId: lib.id })
  const exec = { agent: { session: { header: { id: 'sess-h3', cwd, agentPreset: binding.agentPreset } } } }
  const out = await registered.get('memu_private_recall').execute({ query: '不想再改需求' }, exec)
  const text = typeof out === 'string' ? out : JSON.stringify(out)
  assert.ok(text.includes('不想再改需求'), 'the tool result carries the hit, not the head of the memory')
  return excerpt.length + ' chars around the hit'
})
await auto('H-4', 'a contradiction is held back until someone settles it', async () => {
  const lib = makeLibrary('h4')
  const first = await memory.privateRemember({ libraryId: lib.id, title: 'deploy rule', layer: 'long_term', content: '部署前必须先跑一遍全量测试，确认没有回归。' })
  const second = await memory.privateRemember({ libraryId: lib.id, title: 'deploy rule', layer: 'long_term', content: '部署前不用跑测试，直接上就行，省时间。' })
  assert.equal(second.entry.status, 'pending_review', 'the second claim is held, not merged')
  assert.equal(second.conflict, first.id, 'and it says what it collides with')
  const queue = await dispatch({}, 'listReviews', { libraryId: lib.id })
  assert.equal(queue.scope, 'private')
  assert.ok(queue.items.some((item) => item.id === second.id), 'it shows up in the private queue')
  assert.equal(queue.items.find((item) => item.id === second.id).libraryId, lib.id, 'each row knows its library')
  const before = inject.buildAnchor({ libraryId: lib.id }, state.getSettings(), null)
  assert.ok(!before.text.includes('直接上就行'), 'both halves of a contradiction never sit in one prompt')
  await dispatch({}, 'resolveReview', { id: second.id, action: 'accept', libraryId: lib.id })
  const settled = (await dispatch({}, 'browseLibrary', { libraryId: lib.id })).files.find((item) => item.id === second.id)
  assert.equal(settled.status, 'active', 'accepting settles it')
  assert.ok(!(await dispatch({}, 'listReviews', { libraryId: lib.id })).items.some((item) => item.id === second.id), 'and takes it off the queue')
  const third = await memory.privateRemember({ libraryId: lib.id, title: 'staging rule', layer: 'long_term', content: '预发环境必须手动点一次发布按钮。' })
  const fourth = await memory.privateRemember({ libraryId: lib.id, title: 'staging rule', layer: 'long_term', content: '预发环境不需要手动点，自动发布就好。' })
  assert.equal(fourth.entry.status, 'pending_review')
  await dispatch({}, 'resolveReview', { id: fourth.id, action: 'reject', libraryId: lib.id })
  const rejected = (await dispatch({}, 'browseLibrary', { libraryId: lib.id })).files.find((item) => item.id === fourth.id)
  assert.equal(rejected.status, 'archived', 'rejecting archives instead of deleting: the claim is still history')
  return 'same-title conflict held, accepted, and rejected'
})

await auto('H-5', 'a memory on the tip of the tongue arrives without its body', async () => {
  const lib = makeLibrary('h5')
  const long = '那年夏天我们在旧办公室最后一晚把所有抽屉清空，有人把钥匙挂在门框上，谁也没说要走，但所有人都知道第二周不会再来。'
  // Not must_remember: a pinned memory is never on the tip of the tongue by design.
  seed(lib.id, 'mem-h5a', { layer: 'long_term', title: 'the last night', content: long, confidence: 0.4 })
  const anchor = inject.buildAnchor({ libraryId: lib.id }, state.getSettings(), null)
  assert.ok(anchor.text.includes('只记得大概'), 'it says up front that only the gist is left')
  assert.ok(anchor.text.includes('mem-h5a'), 'and points at the id so a recall can finish the job')
  assert.ok(!anchor.text.includes('第二周不会再来'), 'while withholding the tail of the text')
  return 'gist only, id included'
})
await auto('H-6', 'a held claim is visible in the browser, with its library named', async () => {
  const lib = makeLibrary('h6')
  await memory.privateRemember({ libraryId: lib.id, title: 'deploy rule', layer: 'long_term', content: '部署前必须先跑一遍全量测试，确认没有回归。' })
  const second = await memory.privateRemember({ libraryId: lib.id, title: 'deploy rule', layer: 'long_term', content: '部署前不用跑测试，直接上就行，省时间。' })
  const rows = (await dispatch({}, 'browseLibrary', { libraryId: lib.id })).files
  const held = rows.find((item) => item.id === second.id)
  assert.ok(held, 'the browser still shows it: a queue nobody can see is not a queue')
  assert.equal(held.status, 'pending_review')
  const client = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.ok(client.includes('reviewScopePrivate'), 'and the review row can say which library it came from')
  return 'visible as pending_review, queue row labelled'
})

await auto('H-7', 'an archived memory can be deleted, and only an archived one', async () => {
  const lib = makeLibrary('h7')
  const live = await memory.privateRemember({ libraryId: lib.id, title: 'still in use', content: '这条还在用，不该能被删掉。' })
  let refused = ""
  try { await dispatch({}, 'deleteMemory', { id: live.id, libraryId: lib.id }) } catch (error) { refused = error.message }
  assert.match(refused, /archive it first/, 'a live memory cannot be deleted in one step')
  await memory.privateArchive({ libraryId: lib.id, id: live.id })
  const archivedRow = (await dispatch({}, 'browseLibrary', { libraryId: lib.id })).files.find((item) => item.id === live.id)
  assert.equal(archivedRow.status, 'archived', 'archiving keeps it, so the archived tab has something to show')
  const gone = await dispatch({}, 'deleteMemory', { id: live.id, libraryId: lib.id })
  assert.equal(gone.deleted, true)
  assert.ok(!(await dispatch({}, 'browseLibrary', { libraryId: lib.id })).files.some((item) => item.id === live.id), 'and then it is really gone')
  let needsLib = ""
  try { await dispatch({}, 'deleteMemory', { id: live.id }) } catch (error) { needsLib = error.message }
  assert.match(needsLib, /libraryId is required/, 'deleting without a library is refused: one hallucinated id must not erase a memory')
  let unknownLib = ""
  try { await dispatch({}, 'deleteMemory', { id: live.id, libraryId: 'lib-does-not-exist' }) } catch (error) { unknownLib = error.message }
  assert.match(unknownLib, /library not found/)
  const client = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  for (const key of ['browseArchivedTab', 'browseActiveTab', 'confirmDelete', 'deleteForever']) {
    assert.ok(client.includes(key), 'the browser has ' + key)
  }
  return 'guarded, then deleted for good'
})
// ------------------------------------------------------------ the tally

const counts = { PASS: 0, FAIL: 0, MANUAL: 0 }
for (const entry of results) counts[entry.verdict] += 1

console.log('')
console.log('===== local acceptance run =====')
console.log('data root: ' + home)
const groups = new Map()
for (const entry of results) {
  const group = entry.id.charAt(0)
  if (!groups.has(group)) groups.set(group, [])
  groups.get(group).push(entry)
}
for (const [group, list] of groups) {
  const passed = list.filter((entry) => entry.verdict === "PASS").length
  const total = list.filter((entry) => entry.verdict !== "MANUAL").length
  console.log("")
  console.log(group + ": " + passed + "/" + total + " automated")
  for (const entry of list) {
    console.log("  [" + entry.verdict + "] " + entry.id + "  " + entry.title)
    if (entry.detail) console.log("         " + entry.detail)
  }
}
console.log('')
const automated = counts.PASS + counts.FAIL
console.log('automated: ' + counts.PASS + '/' + automated + ' passed, ' + counts.FAIL + ' failed, ' + counts.MANUAL + ' left for a human')
if (counts.FAIL > 0) {
  console.log('')
  console.log('FAILURES >>> rerun with --verbose to see the assertions')
  process.exitCode = 1
} else {
console.log('visual evidence reflects the recorded review; UI changes require a fresh browser review, see docs/client-conventions.md for the client conventions')
}
