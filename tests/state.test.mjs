import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-state-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

test('same cwd auto-binds to the same library', () => {
  const cwd = path.join(home, 'project-a')
  const a = state.ensureSession('state-a', { cwd, agentPreset: 'coding' })
  const b = state.ensureSession('state-b', { cwd, agentPreset: 'coding' })
  assert.equal(a.libraryId, b.libraryId)
  assert.equal(a.domain, 'coding')
})

test('different cwd gets a different library', () => {
  const a = state.ensureSession('state-c', { cwd: path.join(home, 'project-b') })
  const b = state.ensureSession('state-d', { cwd: path.join(home, 'project-c') })
  assert.notEqual(a.libraryId, b.libraryId)
})

test('a new memory binding defaults its domain selection to RP, and an explicit choice sticks', () => {
  const cwd = path.join(home, 'project-domain-default')
  const binding = state.ensureSession('state-domain-default', { cwd, agentPreset: 'coding' })
  assert.equal(binding.domain, 'coding', 'the detected domain stays as metadata')
  assert.equal(binding.domainOverride, 'rp', 'the selector starts on RP')
  state.setSessionBinding('state-domain-default', { domainOverride: 'general' })
  const rebound = state.ensureSession('state-domain-default', { cwd, agentPreset: 'coding' })
  assert.equal(rebound.domainOverride, 'general', 'general is a real explicit choice')
})

test('deleting a session binding keeps the library', () => {
  const cwd = path.join(home, 'project-keep')
  const binding = state.ensureSession('state-keep', { cwd })
  assert.ok(state.getLibrary(binding.libraryId))
  state.deleteSessionBinding('state-keep')
  assert.equal(state.getSessionBinding('state-keep'), null)
  assert.ok(state.getLibrary(binding.libraryId))
})

test('the unpin marker is gone from session bindings', () => {
  const cwd = path.join(home, 'project-trauma')
  const binding = state.ensureSession('state-trauma', { cwd })
  // Unpin is the model's own call now; nothing user-side arms it any more.
  assert.equal(binding.traumaArmed, undefined)
  assert.equal(binding.traumaArmedAt, undefined)
  assert.equal(typeof state.armTrauma, 'undefined')
  assert.equal(typeof state.consumeTrauma, 'undefined')
})

test('backup creates a timestamped directory', () => {
  const dest = state.backupDatabases()
  assert.ok(fs.existsSync(dest))
  assert.ok(fs.existsSync(path.join(dest, 'index')))
})

test('memory ids are path-safe', () => {
  const id = state.newMemoryId('mem')
  assert.match(id, /^mem-[a-z0-9]+-[a-f0-9]+$/)
})

test('the no-workspace placeholder stays a key, never a resolved path', () => {
  assert.equal(state.normalizeCwd('__default__'), '__default__')
  const lib = state.ensureLibraryForCwd('__default__')
  assert.equal(lib.scopeKey, '__default__')
  // Re-asking with nothing at all must land on the same library, not a second one.
  assert.equal(state.ensureLibraryForCwd(undefined).id, lib.id)
  assert.equal(state.createLibrary({ scopeKey: '__default__' }).id, lib.id)
})

test('createLibrary:false binds the session without creating a library', () => {
  const cwd = path.join(home, 'project-opt-out')
  const before = state.listLibraries().length
  const binding = state.ensureSession('state-opt-out', { cwd, createLibrary: false })
  assert.equal(binding.libraryId, null)
  assert.equal(binding.useLibrary, true)
  assert.equal(state.listLibraries().length, before)
})

test('a folder switch off suppresses auto-creation and is inherited by later sessions', () => {
  const cwd = path.join(home, 'project-policy')
  state.setWorkspacePolicy(cwd, { useLibrary: false, useGlobal: false })
  const binding = state.ensureSession('state-policy', { cwd })
  assert.equal(binding.libraryId, null)
  assert.equal(state.effectiveScope(binding).useLibrary, false)
  assert.equal(state.effectiveScope(binding).useGlobal, false)
  const policy = state.listWorkspacePolicies().find((item) => item.scopeKey === binding.scopeKey)
  assert.deepEqual({ useLibrary: policy.useLibrary, useGlobal: policy.useGlobal }, { useLibrary: false, useGlobal: false })
})

test('a folder switch clamps conversations without rewriting their own choice', () => {
  const cwd = path.join(home, 'project-policy-existing')
  const binding = state.ensureSession('state-policy-existing', { cwd })
  assert.ok(binding.libraryId)
  assert.equal(binding.useLibrary, true)

  state.setWorkspacePolicy(cwd, { useLibrary: false, useGlobal: false })
  const after = state.getSessionBinding('state-policy-existing')
  // The stored wish is untouched — the folder is a ceiling, not an edit.
  assert.equal(after.useLibrary, true)
  assert.equal(state.effectiveScope(after).useLibrary, false)
  assert.equal(state.effectiveScope(after).useGlobal, false)

  // Re-enabling the folder restores each conversation's own choice, not a default.
  state.setSessionBinding('state-policy-existing', { useLibrary: false })
  state.setWorkspacePolicy(cwd, { useLibrary: true, useGlobal: true })
  const restored = state.getSessionBinding('state-policy-existing')
  assert.equal(state.effectiveScope(restored).useLibrary, false, 'the conversation that opted out stays out')
})

test('re-binding a session does not reset its switches', () => {
  const cwd = path.join(home, 'project-sticky-switch')
  state.ensureSession('state-sticky', { cwd })
  state.setSessionBinding('state-sticky', { useGlobal: false })
  // ensureSession runs on every step of every turn.
  const rebound = state.ensureSession('state-sticky', { cwd, createLibrary: false })
  assert.equal(rebound.useGlobal, false)
  assert.equal(rebound.useLibrary, true)
})

test('an old Default/__default__ binding is renamed to the conversation folder', () => {
  const cwd = path.join(home, 'project-adopted')
  const legacy = state.ensureLibraryForCwd('__default__')
  state.setSessionBinding('state-adopt', { libraryId: legacy.id, scopeKey: '__default__' })
  const binding = state.ensureSession('state-adopt', { cwd })
  assert.equal(binding.libraryId, legacy.id)
  const library = state.getLibrary(legacy.id)
  assert.equal(library.scopeKey, state.normalizeCwd(cwd))
  assert.equal(library.name, 'project-adopted')
})

test('a fresh install starts with the four conveniences enabled', () => {
  const settings = state.getSettings()
  assert.equal(settings.autoInstallEngine, true)
  assert.equal(settings.newSessionPromptDismissed, false)
  assert.equal(settings.habitsInjection, true)
  assert.equal(settings.sleepConsolidation, true)
})

test('vision descriptions are enabled by default and stay inert until an endpoint is configured', () => {
  assert.equal(state.getSettings().visionCaptionEnabled, true)
})
