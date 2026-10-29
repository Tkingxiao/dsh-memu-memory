import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import sharp from 'sharp'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-media-'))
process.env.DSH_MEMU_HOME = home
const state = await import('../lib/state.js')
const media = await import('../lib/media.js')
const memory = await import('../lib/memory.js')
const inject = await import('../lib/inject.js')
const rpc = await import('../lib/rpc.js')
const { registerTools } = await import('../lib/tools.js')
test.after(() => { state.flushState(); fs.rmSync(home, { recursive: true, force: true }) })
const bytes = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#339966' } }).png().toBuffer()
const sha = crypto.createHash('sha256').update(bytes).digest('hex')
const ref = { attachmentId: sha, mediaType: 'image/png', bytes: bytes.length, width: 800, height: 600, name: 'birthday.png' }
const binding = state.ensureSession('images', { cwd: path.join(home, 'rp'), agentPreset: 'rp' })
const libraryId = binding.libraryId
const session = { header: { id: 'images', cwd: path.join(home, 'rp') } }
const exec = { agent: { session } }
const ctx = { get: name => name === 'attachments' ? { readImage: async () => ({ ref, data: bytes }) } : undefined }
const event = (seq, text = '') => ({ type: 'user/message', seq, data: { source: { kind: 'user' }, content: [...(text ? [{ type: 'text', text }] : []), { type: 'image', attachment: ref }] } })

test('three image events store one verified blob and hint at a habit, not an automatic memory', async () => {
  for (let i = 0; i < 3; i++) await media.captureMediaEvent(ctx, session, event(i, '这是上次生日留下的照片。'))
  const pool = JSON.parse(fs.readFileSync(path.join(home, 'index', `${libraryId}.media.json`)))
  assert.equal(pool.totals.count, 1)
  assert.equal(pool.blobs[sha].useCount, 3)
  assert.equal(fs.readdirSync(path.join(home, 'attachments', libraryId)).length, 1)
  assert.equal(state.getSessionBinding('images').stickerHint.sha256, sha)
  assert.equal(Object.keys(state.loadPrivateIndex(libraryId).entries).length, 0)
  await media.captureMediaEvent(ctx, session, event(2))
  assert.equal(media.attachmentRefs(libraryId, [{ sha256: sha }])[0].useCount, 3, 'event replay is idempotent')
})

test('image-only turns retrieve a saved image and expose the image count in status', async () => {
  const saved = await memory.privateRemember({ exec, title: '生日照片', content: '上次生日的一张照片。', attachments: [{ sha256: sha }], layer: 'long_term' })
  const message = { role: 'user', ...event(4).data }
  const decision = await inject.injectForStep({ agent: exec.agent, decision: { kind: 'enter', messages: [message] }, turn: 2, step: 1 })
  assert.ok(decision.messages.length > 1)
  assert.ok(decision.messages[0].content[0].text.includes(saved.id))
  assert.equal(state.getSessionBinding('images').recentQueries.at(-1).imageCount, 1)
  const tools = []
  registerTools({ tools: { register: tool => { tools.push(tool); return () => {} } } })
  assert.match(await tools.find(tool => tool.name === 'memu_status').execute({}, exec), /image_turn: 1/)
})

test('ordinary images are short-lived drafts, important ones retain separate accuracy and habits aggregate', async () => {
  const draft = await memory.privateRemember({ exec, title: '普通图', content: '今天收到的图。', attachments: [{ sha256: sha }] })
  assert.equal(draft.entry.layer, 'short_term')
  assert.ok(Math.abs(Date.parse(draft.entry.expiresAt) - Date.now() - 72 * 3_600_000) < 5000)
  const important = await memory.privateRemember({ exec, title: '重要瞬间', content: '这是生日纪念。', attachments: [{ sha256: sha }], layer: 'long_term', salientDate: '10-28', arousal: .95, confidence: .9 })
  assert.ok(important.entry.accuracy < important.entry.confidence)
  const habit = await memory.privateRemember({ exec, title: '表达习惯', content: '他无语时习惯发这张图。', attachments: [{ sha256: sha }], track: 'habit' })
  assert.equal(habit.entry.track, 'habit')
  assert.equal(habit.entry.layer, 'long_term')
  const aggregate = await memory.privateRemember({ exec, title: '表达习惯', content: '他无语时经常发这张图，不必逐次复述。', attachments: [{ sha256: sha }], track: 'habit' })
  assert.equal(aggregate.id, habit.id, 'an agent write aggregates the same image habit instead of appending another')
})

test('thumbnail authorization rejects secrets, session mismatches and disabled scopes; captions respect never_say', async () => {
  const privateSession = state.ensureSession('private-image', { cwd: path.join(home, 'private') })
  await media.captureMediaEvent(ctx, { header: { id: 'private-image' } }, event(0, 'hidden caption'))
  const secret = await memory.privateRemember({ exec: { agent: { session: { header: { id: 'private-image' } } } }, content: 'secret body', title: 'secret', visibility: 'secret', attachments: [{ sha256: sha }], layer: 'long_term' })
  assert.throws(() => media.getAttachment({ libraryId: privateSession.libraryId, sha256: sha, sessionId: 'private-image' }), error => error.status === 403)
  await memory.privateUpdate({ libraryId: privateSession.libraryId, id: secret.id, visibility: 'shared', disclosure: 'never_say' })
  assert.equal(media.getAttachment({ libraryId: privateSession.libraryId, sha256: sha, sessionId: 'private-image' }).caption, null)
  assert.throws(() => media.getAttachment({ libraryId, sha256: sha, sessionId: 'unknown' }), error => error.status === 403)
  state.setSessionBinding('private-image', { useLibrary: false })
  assert.throws(() => media.getAttachment({ libraryId: privateSession.libraryId, sha256: sha, sessionId: 'private-image' }), error => error.status === 403)
  const thumb = await media.attachmentThumbnail({ libraryId, sha256: sha, sessionId: 'images' })
  const metadata = await sharp(thumb.data).metadata()
  assert.equal(metadata.width, 512)
  assert.equal(metadata.height, 384)
})

test('the size guard never reads an oversized image and still allows a missing-image memory', async () => {
  const refTooLarge = { ...ref, attachmentId: 'f'.repeat(64), bytes: 9 * 1024 * 1024 }
  let reads = 0
  const out = await media.captureMediaEvent({ get: () => ({ readImage: async () => { reads++; throw new Error('must not read') } }) }, session,
    { ...event(10), data: { source: { kind: 'user' }, content: [{ type: 'image', attachment: refTooLarge }] } })
  assert.equal(reads, 0)
  assert.equal(out[0].missing, true)
  const saved = await memory.privateRemember({ exec, content: '图太大但记得收到过。', title: '大图', attachments: [{ sha256: refTooLarge.attachmentId }] })
  assert.equal(saved.entry.attachments[0].missing, true)
})

test('an attachment archive round-trips bytes and missing files do not break memory recall', async () => {
  const exported = await rpc.dispatch({}, 'exportLibrary', { libraryId, includeAttachments: true })
  const other = state.createLibrary({ name: 'imported', cwd: path.join(home, 'imported') })
  const result = await rpc.dispatch({}, 'importMemories', { libraryId: other.id, archiveBase64: exported.base64 })
  assert.ok(result.imported > 0)
  assert.ok(fs.existsSync(path.join(home, 'attachments', other.id, `${sha}.png`)))
  fs.unlinkSync(path.join(home, 'attachments', libraryId, `${sha}.png`))
  assert.equal(media.getAttachment({ libraryId, sha256: sha, sessionId: 'images' }).missing, true)
  assert.ok((await memory.privateRecall({ exec, query: '生日', relevanceThreshold: 0 })).files.length)
})

test('GC keeps referenced images and deletes only unused month-old bytes', () => {
  const file = path.join(home, 'index', `${libraryId}.media.json`)
  const pool = JSON.parse(fs.readFileSync(file))
  const orphan = 'e'.repeat(64)
  fs.writeFileSync(path.join(home, 'attachments', libraryId, `${orphan}.png`), bytes)
  pool.blobs[orphan] = { ...pool.blobs[sha], refs: [], lastUsedAt: '2026-01-01T00:00:00Z', sha256: orphan }
  fs.writeFileSync(file, JSON.stringify(pool))
  media.reconcileMedia(libraryId, state.loadPrivateIndex(libraryId), { now: Date.parse('2026-10-28T00:00:00Z') })
  assert.ok(!fs.existsSync(path.join(home, 'attachments', libraryId, `${orphan}.png`)))
  assert.ok(Object.keys(state.loadPrivateIndex(libraryId).entries).length > 0)
})

test('streaming archives round-trip without base64 and reject zip-slip paths', async () => {
  const { zipSync } = await import('fflate')
  const source = state.createLibrary({ name: 'stream-source', cwd: path.join(home, 'stream-source') })
  state.ensureSession('stream-session', { cwd: path.join(home, 'stream-source') })
  await media.captureMediaEvent(ctx, { header: { id: 'stream-session' } }, event(0, 'verified source image'))
  await memory.privateRemember({ exec: { agent: { session: { header: { id: 'stream-session' } } } }, title: 'stream', content: 'streamed image evidence', attachments: [{ sha256: sha }], layer: 'long_term' })
  const payload = await rpc.dispatch({}, 'exportLibrary', { libraryId: source.id })
  const chunks = []
  const output = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done() } })
  output.writeHead = () => {}
  await media.streamMediaExport(source.id, payload, output)
  const dest = state.createLibrary({ name: 'stream-dest', cwd: path.join(home, 'stream-dest') })
  const archive = await media.importMediaStream(dest.id, Readable.from([Buffer.concat(chunks)]))
  assert.equal(archive.memories.length, 1)
  assert.ok(fs.existsSync(path.join(home, 'attachments', dest.id, `${sha}.png`)))
  const malicious = zipSync({ '../outside.json': Buffer.from('{}') })
  await assert.rejects(media.importMediaStream(dest.id, Readable.from([malicious])), /unsupported/)
})
