import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-browser-'))
process.env.DSH_MEMU_HOME = home

const { createLibrary, ensureSession, loadPrivateIndex, savePrivateIndex, listLibraries, getSessionBinding } = await import('../lib/state.js')
const { privateRemember, privateRecall, privateUpdate, privateArchive, globalList, globalRecall } = await import('../lib/memory.js')
const { dispatch } = await import('../lib/rpc.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function seed(libraryId, id, entry) {
  const index = loadPrivateIndex(libraryId)
  index.entries[id] = {
    layer: 'long_term', title: id, content: `body of ${id}`, status: 'active',
    createdAt: '2026-10-01T00:00:00.000Z', ...entry,
  }
  savePrivateIndex(libraryId, index)
}

test('library-scoped archive works with no session bound', async () => {
  const lib = createLibrary({ name: 'browser-a', cwd: path.join(home, 'browser-a') })
  seed(lib.id, 'mem-1', {})
  const result = await privateArchive({ libraryId: lib.id, id: 'mem-1' })
  assert.equal(result.entry.status, 'archived')
  assert.equal(loadPrivateIndex(lib.id).entries['mem-1'].status, 'archived')
})

test('library-scoped update touches only the index when content is unchanged', async () => {
  const lib = createLibrary({ name: 'browser-b', cwd: path.join(home, 'browser-b') })
  seed(lib.id, 'mem-2', { tags: ['old'] })
  const result = await privateUpdate({ libraryId: lib.id, id: 'mem-2', title: 'renamed', tags: ['new'] })
  assert.equal(result.entry.title, 'renamed')
  assert.deepEqual(result.entry.tags, ['new'])
  assert.equal(result.entry.content, 'body of mem-2')
})

test('an unknown library id is rejected instead of falling back to a binding', () => {
  assert.throws(
    () => privateArchive({ libraryId: 'lib-nope', id: 'mem-x' }),
    /unknown library/,
  )
})

test('browseLibrary degrades to the index while the engine is missing', async () => {
  const lib = createLibrary({ name: 'browser-c', cwd: path.join(home, 'browser-c') })
  seed(lib.id, 'mem-3', { layer: 'must_remember', marginalized: true, tags: ['keep'] })
  const view = await dispatch({}, 'browseLibrary', { libraryId: lib.id })
  assert.equal(view.source, 'index')
  assert.equal(view.libraryId, lib.id)
  assert.equal(view.files.length, 1)
  const [item] = view.files
  assert.equal(item.id, 'mem-3')
  assert.equal(item.layer, 'must_remember')
  assert.equal(item.marginalized, true)
  assert.deepEqual(item.tags, ['keep'])
  assert.match(item.content, /body of mem-3/)
})

test('local agent backend writes and recalls memory without an engine', async () => {
  const cwd = path.join(home, 'browser-local')
  const lib = createLibrary({ name: 'browser-local', cwd })
  ensureSession('browser-local-session', { cwd, libraryId: lib.id })
  const exec = { agent: { session: { header: { id: 'browser-local-session', cwd, agentPreset: 'coding' } } } }
  const saved = await privateRemember({
    exec, content: '用户喜欢在周五下午整理下周计划', title: '周五整理计划', tags: ['习惯'],
  })
  assert.equal(saved.result.backend, 'lexical')
  assert.ok(saved.id)
  const recalled = await privateRecall({ exec, query: '周五 计划', topK: 3 })
  assert.equal(recalled.files.length, 1)
  assert.match(recalled.files[0].content, /周五下午/)
})

test('exportLibrary emits a re-importable payload', async () => {
  const lib = createLibrary({ name: 'browser-d', cwd: path.join(home, 'browser-d') })
  seed(lib.id, 'mem-4', {})
  const out = await dispatch({}, 'exportLibrary', { libraryId: lib.id })
  assert.equal(out.format, 'dsh-memu-memory-library@1')
  assert.equal(out.library.id, lib.id)
  assert.equal(out.memories.length, 1)
  assert.equal(out.memories[0].id, 'mem-4')
})

test('reading global memory never creates a library for an unbound session', async () => {
  const before = listLibraries().length
  const exec = { agent: { session: { header: { id: 'never-seen-session', cwd: '', agentPreset: null } } } }
  // Local agent mode reads the JSON index directly, so this must succeed without
  // an engine; what matters is that neither read leaves a placeholder library.
  const listed = await globalList({ exec })
  assert.equal(listed.source, 'index')
  const recalled = await globalRecall({ exec, query: 'anything', topK: 3 })
  assert.equal(recalled.domain, 'general')
  assert.equal(listLibraries().length, before, 'reads must not materialize a placeholder library')
  assert.equal(getSessionBinding('never-seen-session'), null, 'reads must not create a binding')
})

test('initializing a session with no workspace folder is refused, not bucketed', async () => {
  const before = listLibraries().length
  await assert.rejects(() => dispatch({}, 'initSession', { sessionId: 'no-folder-session' }), /no workspace folder/)
  await assert.rejects(() => dispatch({}, 'initSession', { sessionId: 'no-folder-session', cwd: '__default__' }), /no workspace folder/)
  assert.equal(listLibraries().length, before, 'a refused init must not create a library')
  assert.equal(getSessionBinding('no-folder-session'), null)
})

test('the new-session prompt check is read-only', async () => {
  const before = listLibraries().length
  const out = await dispatch({}, 'getSessionPromptState', { sessionId: 'prompt-read-only' })
  assert.equal(out.binding, null)
  assert.ok(Array.isArray(out.libraries))
  assert.deepEqual(out.domains, ['rp', 'coding', 'general', 'mixed'], 'the prompt must offer the memory domains setDomain accepts')
  assert.equal(listLibraries().length, before)
  assert.equal(getSessionBinding('prompt-read-only'), null)
})

test('setDomain writes Coding and rejects an unknown domain', async () => {
  const cwd = path.join(home, 'browser-domain')
  await dispatch({}, 'initSession', { sessionId: 'browser-domain-session', cwd, createLibrary: false })
  const out = await dispatch({}, 'setDomain', { sessionId: 'browser-domain-session', domain: 'coding' })
  assert.equal(out.domainOverride, 'coding')
  assert.equal(getSessionBinding('browser-domain-session').domainOverride, 'coding')
  await assert.rejects(
    () => dispatch({}, 'setDomain', { sessionId: 'browser-domain-session', domain: 'not-a-domain' }),
    /invalid domain/,
  )
  assert.equal(getSessionBinding('browser-domain-session').domainOverride, 'coding', 'a rejected value must not overwrite the stored domain')
})

test('initSession with createLibrary:false leaves no library behind', async () => {
  const cwd = path.join(home, 'browser-opt-out')
  const before = listLibraries().length
  const out = await dispatch({}, 'initSession', { sessionId: 'browser-opt-out', cwd, createLibrary: false })
  assert.equal(out.binding.libraryId, null)
  assert.equal(listLibraries().length, before)
})

test('switching to a version that is not installed is refused', async () => {
  const { switchEngineVersion, listEngineVersions } = await import('../lib/engine.js')
  const out = await switchEngineVersion('9.9.9-nope')
  assert.equal(out.ok, false)
  assert.match(out.error, /not installed/)
  // Nothing may claim to be in use when no runtime exists.
  assert.ok(listEngineVersions().every((v) => !v.current || v.installed))
})

test('an install without history.json is backfilled from current.json', async () => {
  const engineHome = path.join(home, 'engine')
  const version = '9.9.9-backfill'
  const venv = path.join(engineHome, version, 'venv')
  fs.mkdirSync(venv, { recursive: true })
  fs.writeFileSync(path.join(engineHome, 'current.json'), JSON.stringify({
    version,
    venv,
    python: path.join(venv, 'Scripts', 'python.exe'),
    commands: ['list-files'],
    mirror: 'https://example.invalid/simple',
    installedAt: '2026-01-02T03:04:05.000Z',
  }), 'utf8')
  const { listEngineVersions } = await import('../lib/engine.js')
  const row = listEngineVersions().find((v) => v.version === version)
  assert.ok(row, 'the installed version must appear in the history list')
  assert.equal(row.installedAt, '2026-01-02T03:04:05.000Z')
  assert.equal(row.mirror, 'https://example.invalid/simple')
  const history = JSON.parse(fs.readFileSync(path.join(engineHome, 'history.json'), 'utf8'))
  assert.equal(history[version].installedAt, '2026-01-02T03:04:05.000Z')
})

test('updateMemory and archiveMemory route by libraryId', async () => {
  const lib = createLibrary({ name: 'browser-e', cwd: path.join(home, 'browser-e') })
  seed(lib.id, 'mem-5', {})
  await dispatch({}, 'updateMemory', { libraryId: lib.id, id: 'mem-5', patch: { title: 'edited', status: 'suppressed' } })
  assert.equal(loadPrivateIndex(lib.id).entries['mem-5'].title, 'edited')
  assert.equal(loadPrivateIndex(lib.id).entries['mem-5'].status, 'suppressed')
  await dispatch({}, 'archiveMemory', { libraryId: lib.id, id: 'mem-5' })
  assert.equal(loadPrivateIndex(lib.id).entries['mem-5'].status, 'archived')
})

// The documented set is enforced, not filtered. A key outside it used to be dropped
// in silence, so a browser that tried to pin a memory got a cheerful success and an
// unchanged entry; refusing the whole patch also guarantees nothing half-applied.
test('updateMemory edits the documented set and refuses anything else', async () => {
  const lib = createLibrary({ name: 'browser-f', cwd: path.join(home, 'browser-f') })
  seed(lib.id, 'mem-6', { layer: 'long_term' })
  const before = { ...loadPrivateIndex(lib.id).entries['mem-6'] }
  await assert.rejects(
    () => dispatch({}, 'updateMemory', {
      libraryId: lib.id,
      id: 'mem-6',
      patch: {
        title: 'ok',
        pinReason: 'sneaky',
        pinSource: 'user_explicit',
      },
    }),
    /unknown memory field: pinReason, pinSource/,
    'pinReason and pinSource decide the anchor rank, so they stay server-side',
  )
  assert.deepEqual(
    { ...loadPrivateIndex(lib.id).entries['mem-6'] },
    before,
    'a refused patch leaves the entry exactly as it was',
  )
  await dispatch({}, 'updateMemory', {
    libraryId: lib.id,
    id: 'mem-6',
    patch: { title: 'ok', layer: 'short_term', owner: 'about_user', visibility: 'secret' },
  })
  const entry = loadPrivateIndex(lib.id).entries['mem-6']
  assert.equal(entry.title, 'ok')
  // The browser may demote a memory to a draft instead of only promoting it, and it
  // may say whose fact it is and how far it may travel.
  assert.equal(entry.layer, 'short_term')
  assert.equal(entry.owner, 'about_user')
  assert.equal(entry.visibility, 'secret')
  assert.ok(!entry.pinReason, 'pinReason must not be writable from the browser')
  assert.ok(!entry.pinSource, 'pinSource decides the anchor rank, so it stays server-side')
})

test('folder sessions use host titles and hide archived or deleted conversations', async () => {
  const cwd = path.join(home, 'browser-folder-list')
  ensureSession('folder-visible', { cwd })
  ensureSession('folder-archived', { cwd })
  ensureSession('folder-deleted', { cwd })
  const ctx = {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => [
            { header: { id: 'folder-visible', cwd }, live: true, persisted: true },
            { header: { id: 'folder-archived', cwd }, live: false, persisted: true },
            { header: { id: 'folder-deleted', cwd }, live: false, persisted: true },
          ],
          readTitleSnapshots: async (ids) => ids.map((sessionId) => ({
            sessionId,
            status: 'fulfilled',
            value: { title: { title: sessionId === 'folder-visible' ? '可见对话' : '' } },
          })),
        }
      }
      if (name === 'workspaceRegistry') {
        return {
          archivedSessionIds: ['folder-archived'],
          list: () => [{ path: cwd, sessionIds: ['folder-visible', 'folder-archived'] }],
        }
      }
      return null
    },
  }
  const out = await dispatch(ctx, 'listFolderSessions', { scopeKey: cwd })
  assert.deepEqual(out.sessions.map((s) => s.sessionId), ['folder-visible'])
  assert.equal(out.sessions[0].title, '可见对话')
})

// ---- provenance in the browser, and the private review queue ----

test('the browser shows where a memory came from, and lets it be corrected', async () => {
  const lib = createLibrary({ name: 'browser-src', cwd: path.join(home, 'browser-src') })
  seed(lib.id, 'mem-src', { source: 'inferred', confidence: 0.8 })
  const view = await dispatch({}, 'browseLibrary', { libraryId: lib.id })
  assert.equal(view.files[0].source, 'inferred', 'provenance is visible without opening the editor')
  assert.equal(view.files[0].accuracy, null, 'an entry written before accuracy existed reads as unknown, not zero')

  await dispatch({}, 'updateMemory', { libraryId: lib.id, id: 'mem-src', patch: { source: 'user_said' } })
  assert.equal(loadPrivateIndex(lib.id).entries['mem-src'].source, 'user_said')
  await assert.rejects(
    () => dispatch({}, 'updateMemory', { libraryId: lib.id, id: 'mem-src', patch: { source: 'they-said' } }),
    /source must be/,
  )
})

test('a private contradiction waits in the same queue as the global one', async () => {
  const lib = createLibrary({ name: 'browser-review', cwd: path.join(home, 'browser-review') })
  seed(lib.id, 'mem-a', {})
  seed(lib.id, 'mem-b', {
    status: 'pending_review',
    reviewReason: '与已有记忆「mem-a」同题但内容不同',
    conflictingWith: 'mem-a',
  })

  const queue = await dispatch({}, 'listReviews', { libraryId: lib.id })
  assert.equal(queue.scope, 'private')
  assert.equal(queue.libraryId, lib.id)
  assert.equal(queue.items.length, 1)
  assert.equal(queue.items[0].id, 'mem-b')
  assert.equal(queue.items[0].libraryId, lib.id, 'each row knows which library to resolve against')
  assert.match(queue.items[0].reviewReason, /同题/)

  await dispatch({}, 'resolveReview', { libraryId: lib.id, id: 'mem-b', action: 'accept' })
  const entry = loadPrivateIndex(lib.id).entries['mem-b']
  assert.equal(entry.status, 'active')
  assert.equal(entry.reviewReason, undefined, 'the reason goes away once the question is answered')
  assert.ok(entry.reviewedAt)
})

test('rejecting a private review archives it instead of deleting it', async () => {
  const lib = createLibrary({ name: 'browser-reject', cwd: path.join(home, 'browser-reject') })
  seed(lib.id, 'mem-c', { status: 'pending_review', reviewReason: '说法相反', conflictingWith: 'mem-a' })
  await dispatch({}, 'resolveReview', { libraryId: lib.id, id: 'mem-c', action: 'reject' })
  const entry = loadPrivateIndex(lib.id).entries['mem-c']
  assert.equal(entry.status, 'archived', 'a discarded claim is kept on record, not erased')
})

test('the global queue is still the default, and an unknown library is refused', async () => {
  const out = await dispatch({}, 'listReviews', {})
  assert.equal(out.scope, 'global')
  assert.equal(out.libraryId, null)
  await assert.rejects(() => dispatch({}, 'listReviews', { libraryId: 'lib-nope' }), /library not found/)
  await assert.rejects(
    () => dispatch({}, 'resolveReview', { libraryId: 'lib-nope', id: 'x', action: 'accept' }),
    /library not found/,
  )
})

// ---- permanent deletion of archived memories ----

test('an archived memory can be deleted for good, and leaves the browser', async () => {
  const lib = createLibrary({ name: 'browser-del', cwd: path.join(home, 'browser-del') })
  seed(lib.id, 'mem-live', {})
  seed(lib.id, 'mem-gone', { status: 'archived' })
  const before = await dispatch({}, 'browseLibrary', { libraryId: lib.id })
  assert.equal(before.files.length, 2)

  const out = await dispatch({}, 'deleteMemory', { libraryId: lib.id, id: 'mem-gone' })
  assert.equal(out.deleted, true)
  assert.equal(out.libraryId, lib.id)

  const index = loadPrivateIndex(lib.id)
  assert.equal(index.entries['mem-gone'], undefined, 'the entry is gone from the index, not just relabelled')
  assert.ok(index.entries['mem-live'], 'the live neighbour is untouched')
  const after = await dispatch({}, 'browseLibrary', { libraryId: lib.id })
  assert.deepEqual(after.files.map((f) => f.id), ['mem-live'])
})

test('a live memory cannot be deleted without archiving it first', async () => {
  const lib = createLibrary({ name: 'browser-del-live', cwd: path.join(home, 'browser-del-live') })
  seed(lib.id, 'mem-safe', {})
  await assert.rejects(
    () => dispatch({}, 'deleteMemory', { libraryId: lib.id, id: 'mem-safe' }),
    /archive it first/,
  )
  assert.ok(loadPrivateIndex(lib.id).entries['mem-safe'], 'the refusal leaves the entry in place')
})

test('deleting needs a library id, and an unknown one is refused', async () => {
  const lib = createLibrary({ name: 'browser-del-args', cwd: path.join(home, 'browser-del-args') })
  seed(lib.id, 'mem-x', { status: 'archived' })
  await assert.rejects(() => dispatch({}, 'deleteMemory', { id: 'mem-x' }), /libraryId is required/)
  await assert.rejects(() => dispatch({}, 'deleteMemory', { libraryId: 'lib-nope', id: 'mem-x' }), /library not found/)
  await assert.rejects(() => dispatch({}, 'deleteMemory', { libraryId: lib.id }), /memory id is required/)
  assert.ok(loadPrivateIndex(lib.id).entries['mem-x'], 'all three refusals are no-ops')
})

test('forgetting a name the engine never had is not an error', async () => {
  const { forget } = await import('../lib/memu.js')
  const missingDb = path.join(home, 'no-such-engine', 'library.sqlite3')
  const out = await forget({ db: missingDb, name: 'mem-never' })
  assert.equal(out.deleted, 0)
  assert.equal(out.missing, true, 'a missing db is reported instead of being created empty')
  assert.equal(fs.existsSync(missingDb), false)
})
