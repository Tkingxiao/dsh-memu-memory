import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { once } from 'node:events'
import {
  getLibrary, getSessionBinding, setSessionBinding, listSessionBindings,
  effectiveScope, loadPrivateIndex, onPrivateIndexWrite, getSettings,
} from './state.js'
import { dataDir, indexDir, isSafeId, ensureDir, readJsonStrict, writeJson, withFileLock, warn, stamp } from './paths.js'
import { isMemoryEligible, visibleToSession } from './memory.js'
import { getVisionConfig } from './memu-config.js'
import { loadPrompt } from './prompts.js'
import { zipSync, unzipSync, Zip, ZipPassThrough, Unzip, UnzipInflate } from 'fflate'

const FILE_LIMIT = 8 * 1024 * 1024
const LIBRARY_LIMIT = 500 * 1024 * 1024
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const SHA = /^[a-f0-9]{64}$/
const captures = new Map()
let activeCaptions = 0
function poolFile(libraryId) {
  if (!isSafeId(libraryId)) throw new Error('invalid library id')
  return path.join(indexDir(), `${libraryId}.media.json`)
}
function blobFile(libraryId, sha, ext) {
  if (!isSafeId(libraryId) || !SHA.test(sha) || !Object.values(MIME_EXT).includes(ext)) throw new Error('invalid attachment reference')
  return path.join(dataDir(), 'attachments', libraryId, `${sha}.${ext}`)
}
function loadPool(libraryId) {
  const result = readJsonStrict(poolFile(libraryId))
  if (result.ok && result.value?.blobs && typeof result.value.blobs === 'object' && !Array.isArray(result.value.blobs)) return result.value
  if (result.missing) return { version: 1, blobs: {}, totals: { bytes: 0, count: 0 } }
  throw new Error(`media metadata unavailable: ${result.error?.message || 'invalid shape'}`)
}
function savePool(libraryId, pool) {
  const stored = Object.values(pool.blobs).filter(blob => !blob.missing)
  pool.totals = { bytes: stored.reduce((sum, blob) => sum + blob.bytes, 0), count: stored.length }
  writeJson(poolFile(libraryId), pool)
}

export function imageTurn(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const images = blocks.filter(block => block?.type === 'image' && block.attachment)
  const text = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join(' ').trim()
  const metadata = images.map(block => {
    const ref = block.attachment
    return `[图片] ${String(ref.name || '').slice(0, 120)} ${ref.width || '?'}x${ref.height || '?'} ${ref.mediaType || ''}`
  }).join(' ')
  return { text, imageCount: images.length, images, query: text || metadata }
}

async function captureImage(ctx, libraryId, ref, contextText, now) {
  const mime = ref.mediaType
  if (!MIME_EXT[mime]) return null
  let bytes = null
  let missingReason = ''
  if (!(ref.bytes > 0) || ref.bytes > FILE_LIMIT) missingReason = 'image exceeds the 8 MB limit or has no verified byte length'
  else {
    try {
      const service = ctx.get?.('attachments') || ctx.attachments
      if (!service?.readImage) throw new Error('host attachments.readImage is unavailable')
      const stored = await service.readImage(ref)
      if (!(stored?.data instanceof Uint8Array) || stored.data.byteLength > FILE_LIMIT) throw new Error('invalid image bytes or 8 MB limit exceeded')
      bytes = Buffer.from(stored.data)
    } catch (error) { missingReason = String(error?.message || error) }
  }
  const sha256 = bytes ? crypto.createHash('sha256').update(bytes).digest('hex') : SHA.test(String(ref.attachmentId)) ? ref.attachmentId : crypto.createHash('sha256').update(String(ref.attachmentId || JSON.stringify(ref))).digest('hex')
  return withFileLock(poolFile(libraryId), () => {
    const pool = loadPool(libraryId)
    const previous = pool.blobs[sha256]
    const ext = MIME_EXT[mime]
    const file = blobFile(libraryId, sha256, ext)
    let stored = !!previous && fs.existsSync(file)
    const wasStored = stored
    if (!stored && bytes) {
      if ((pool.totals.bytes || 0) + bytes.length > LIBRARY_LIMIT) missingReason = 'library image storage exceeds the 500 MB limit'
      else {
        ensureDir(path.dirname(file))
        const temporary = `${file}.tmp-${crypto.randomUUID()}`
        try {
          fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
          fs.renameSync(temporary, file)
          stored = true
        } finally { try { fs.rmSync(temporary, { force: true }) } catch {} }
      }
    }
    const at = new Date(now).toISOString()
    const blob = {
      ...previous, sha256, bytes: bytes?.length || ref.bytes || 0, ext, mime,
      w: ref.width || null, h: ref.height || null, firstSeenAt: previous?.firstSeenAt || at,
      lastUsedAt: at, useCount: Number(previous?.useCount || 0) + 1, refs: previous?.refs || [],
      caption: contextText ? contextText.slice(0, 160) : previous?.caption || (ref.name ? String(ref.name).slice(0, 160) : '[图片]'),
      captionBy: contextText ? 'context' : previous?.captionBy || (ref.name ? 'exif' : 'none'),
      missing: !stored, missingReason: stored ? null : missingReason || 'image unavailable',
    }
    pool.blobs[sha256] = blob
    try { savePool(libraryId, pool) } catch (error) {
      if (stored && !wasStored) { try { fs.unlinkSync(file) } catch {} }
      throw error
    }
    if (blob.missing) warn(`image not saved for ${libraryId}: ${blob.missingReason}`)
    return blob
  })
}

export function captureMediaEvent(ctx, session, event, { now = Date.now() } = {}) {
  const sessionId = session?.header?.id
  if (!sessionId || session?.header?.origin === 'subagent' || event?.type !== 'user/message' || event.data?.source?.kind !== 'user') return Promise.resolve([])
  return captureMessageMedia(ctx, session, event.data, {
    now, eventKey: event.seq !== undefined ? `seq:${event.seq}` : event.data.id ? `id:${event.data.id}` : null,
  })
}

/** Shared byte collection, without disguising tool results as user events. */
export function captureMessageMedia(ctx, session, message, { now = Date.now(), eventKey = null } = {}) {
  const sessionId = session?.header?.id
  if (!sessionId || session.header.origin === 'subagent') return Promise.resolve([])
  const binding = getSessionBinding(sessionId)
  if (!binding?.libraryId || !effectiveScope(binding).useLibrary) return Promise.resolve([])
  const turn = imageTurn(message)
  if (!turn.imageCount) return Promise.resolve([])
  const previous = captures.get(sessionId) || Promise.resolve()
  const task = previous.catch(() => {}).then(async () => {
    const current = getSessionBinding(sessionId)
    if (!current?.libraryId || current.libraryId !== binding.libraryId || !effectiveScope(current).useLibrary) return []
    if (eventKey && (current.mediaEvents || []).includes(eventKey)) return []
    const received = []
    for (const block of turn.images.slice(0, 8)) {
      const blob = await captureImage(ctx, binding.libraryId, block.attachment, turn.text, now)
      if (blob) received.push({ ...blob, sourceAttachmentId: block.attachment.attachmentId, contextText: turn.text.slice(0, 160), addedAt: stamp() })
    }
    const fresh = getSessionBinding(sessionId)
    if (!fresh || fresh.libraryId !== binding.libraryId || !effectiveScope(fresh).useLibrary) return []
    const pending = [...(fresh.pendingMedia || []), ...received].slice(-8)
    const hint = received.find(blob => blob.useCount >= 3)
    const index = hint ? loadPrivateIndex(binding.libraryId) : null
    const hasHabit = hint && Object.values(index.entries).some(entry => entry.track === 'habit' && (entry.attachments || []).some(item => item.sha256 === hint.sha256))
    setSessionBinding(sessionId, {
      pendingMedia: pending, lastImageCount: turn.imageCount,
      mediaEvents: eventKey ? [...(fresh.mediaEvents || []), eventKey].slice(-128) : fresh.mediaEvents || [],
      stickerHint: hint && !hasHabit ? { sha256: hint.sha256, useCount: hint.useCount } : fresh.stickerHint || null,
    })
    for (const blob of received) {
      if (blob.captionBy === 'none' && !blob.missing && getSettings().visionCaptionEnabled === true) {
        void captionImage(binding.libraryId, blob.sha256).catch(() => warn('optional image description failed; original metadata retained'))
      }
    }
    return received
  })
  captures.set(sessionId, task)
  void task.finally(() => { if (captures.get(sessionId) === task) captures.delete(sessionId) }).catch(() => {})
  return task
}

export function attachmentRefs(libraryId, refs) {
  if (refs === undefined) return []
  if (!Array.isArray(refs) || refs.length > 8) throw new Error('attachments must contain at most 8 sha256 references')
  const pool = loadPool(libraryId)
  return [...new Set(refs.map(ref => ref?.sha256))].map(sha => {
    if (!SHA.test(String(sha))) throw new Error('attachment sha256 must be 64 lowercase hex characters')
    const blob = pool.blobs[sha]
    if (!blob) throw new Error('attachment was not received in this library')
    return {
      kind: blob.useCount >= 3 && Math.max(blob.w || 0, blob.h || 0) < 512 ? 'sticker' : 'image',
      sha256: sha, bytes: blob.bytes, w: blob.w, h: blob.h, mime: blob.mime,
      caption: blob.caption, captionBy: blob.captionBy, addedAt: blob.firstSeenAt,
      lastUsedAt: blob.lastUsedAt, useCount: blob.useCount,
      missing: blob.missing || !fs.existsSync(blobFile(libraryId, sha, blob.ext)),
    }
  })
}

export function reconcileMedia(libraryId, index, { now = Date.now() } = {}) {
  const file = poolFile(libraryId)
  if (!fs.existsSync(file)) return
  withFileLock(file, () => {
    const pool = loadPool(libraryId)
    const refs = new Map()
    for (const [id, entry] of Object.entries(index.entries || {})) {
      if (!isMemoryEligible(entry, { now })) continue
      for (const item of entry.attachments || []) {
        if (!refs.has(item.sha256)) refs.set(item.sha256, [])
        refs.get(item.sha256).push(id)
      }
    }
    let changed = false
    for (const [sha, blob] of Object.entries(pool.blobs)) {
      const next = refs.get(sha) || []
      if (JSON.stringify(blob.refs) !== JSON.stringify(next)) { blob.refs = next; changed = true }
      if (!next.length && now - Date.parse(blob.lastUsedAt || blob.firstSeenAt) > 30 * 86_400_000) {
        try { fs.rmSync(blobFile(libraryId, sha, blob.ext), { force: true }) } catch (error) { warn(`image cleanup deferred: ${error.code || 'IO error'}`); continue }
        delete pool.blobs[sha]
        changed = true
      }
    }
    if (changed) savePool(libraryId, pool)
  })
}
onPrivateIndexWrite((libraryId, index) => reconcileMedia(libraryId, index))

function authorize(libraryId, sha256, sessionId) {
  if (!getLibrary(libraryId) || !SHA.test(String(sha256))) throw Object.assign(new Error('attachment not found'), { status: 404 })
  const binding = getSessionBinding(sessionId)
  if (!binding || binding.libraryId !== libraryId || !effectiveScope(binding).useLibrary) throw Object.assign(new Error('attachment scope denied'), { status: 403 })
  const entries = Object.values(loadPrivateIndex(libraryId).entries)
  const matching = entries.filter(entry => isMemoryEligible(entry) && entry.visibility !== 'secret'
    && visibleToSession(entry, sessionId) && (entry.attachments || []).some(item => item.sha256 === sha256))
  if (!matching.length) throw Object.assign(new Error('attachment visibility denied'), { status: 403 })
  return matching
}

export function getAttachment({ libraryId, sha256, sessionId }) {
  const entries = authorize(libraryId, sha256, sessionId)
  const blob = loadPool(libraryId).blobs[sha256]
  if (!blob) return { sha256, missing: true }
  const allowCaption = entries.every(entry => entry.disclosure !== 'never_say')
  return {
    sha256, bytes: blob.bytes, w: blob.w, h: blob.h, mime: blob.mime,
    caption: allowCaption ? blob.caption : null, captionBy: allowCaption ? blob.captionBy : null,
    useCount: blob.useCount, missing: blob.missing || !fs.existsSync(blobFile(libraryId, sha256, blob.ext)),
  }
}

export async function attachmentThumbnail(args) {
  const info = getAttachment(args)
  if (info.missing) return null
  const blob = loadPool(args.libraryId).blobs[args.sha256]
  const { default: sharp } = await import('sharp')
  const data = await sharp(blobFile(args.libraryId, args.sha256, blob.ext), { limitInputPixels: 40_000_000, animated: false })
    .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer()
  return { data, mime: 'image/webp' }
}

export function attachmentPreview(libraryId, entry) {
  if (entry.visibility === 'secret' || entry.disclosure === 'never_say') return (entry.attachments || []).map(item => ({ sha256: item.sha256, missing: item.missing, hidden: true }))
  const binding = listSessionBindings().find(binding => binding.libraryId === libraryId && effectiveScope(binding).useLibrary && visibleToSession(entry, binding.sessionId))
  return (entry.attachments || []).map(item => ({
    ...item, url: binding ? `/dsh-memu-memory/attachment/${encodeURIComponent(libraryId)}/${item.sha256}?sessionId=${encodeURIComponent(binding.sessionId)}` : null,
  }))
}

export async function captionImage(libraryId, sha256) {
  if (activeCaptions >= 2) return null
  const config = getVisionConfig({ withKey: true })
  if (!config.ready || getSettings().visionCaptionEnabled !== true) return null
  const blob = loadPool(libraryId).blobs[sha256]
  if (!blob || blob.missing || !['none', 'exif'].includes(blob.captionBy)) return null
  const index = loadPrivateIndex(libraryId)
  const linked = Object.values(index.entries).filter(entry => (entry.attachments || []).some(item => item.sha256 === sha256))
  if (linked.some(entry => entry.visibility === 'secret' || entry.disclosure === 'never_say')) return null
  const data = fs.readFileSync(blobFile(libraryId, sha256, blob.ext))
  if (data.length > FILE_LIMIT) return null
  const reserved = withFileLock(poolFile(libraryId), () => {
    const pool = loadPool(libraryId)
    const now = Date.now()
    const budget = pool.visionBudget || {}
    const hour = Math.floor(now / 3_600_000)
    const count = budget.hour === hour ? Number(budget.count || 0) : 0
    if (now - Number(budget.lastAt || 0) < 60_000 || count >= 10) return false
    pool.visionBudget = { hour, count: count + 1, lastAt: now }
    savePool(libraryId, pool)
    return true
  })
  if (!reserved) return null
  activeCaptions += 1
  try {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ model: config.model, max_tokens: 100, temperature: 0,
      messages: [{ role: 'user', content: [
        { type: 'text', text: loadPrompt('image-caption').text },
        { type: 'image_url', image_url: { url: `data:${blob.mime};base64,${data.toString('base64')}` } },
      ] }] }),
  })
  if (!response.ok) throw new Error(`vision service returned HTTP ${response.status}`)
  const result = await response.json()
  const caption = String(result?.choices?.[0]?.message?.content || '').trim().slice(0, 40)
  if (!caption) return null
  withFileLock(poolFile(libraryId), () => {
    const pool = loadPool(libraryId)
    const current = pool.blobs[sha256]
    if (!current || current.captionBy === 'context') return
    current.caption = caption; current.captionBy = 'vision'
    savePool(libraryId, pool)
  })
  return caption
  } finally { activeCaptions -= 1 }
}

export function exportMediaBundle(libraryId, payload) {
  const pool = loadPool(libraryId)
  const files = {}
  const manifest = { format: 'dsh-memu-memory-media@1', blobs: {} }
  const wanted = new Set(payload.memories.flatMap(entry => (entry.attachments || []).map(item => item.sha256)))
  for (const sha of wanted) {
    const blob = pool.blobs[sha]
    if (!blob || blob.missing) continue
    const file = blobFile(libraryId, sha, blob.ext)
    if (!fs.existsSync(file)) continue
    const data = fs.readFileSync(file)
    if (data.length > FILE_LIMIT || crypto.createHash('sha256').update(data).digest('hex') !== sha) throw new Error('attachment integrity check failed')
    const name = `attachments/${sha}.${blob.ext}`
    files[name] = data
    manifest.blobs[sha] = { ...blob, file: name }
  }
  files['memories.json'] = Buffer.from(JSON.stringify(payload))
  files['manifest.json'] = Buffer.from(JSON.stringify(manifest))
  return Buffer.from(zipSync(files, { level: 0 }))
}

export function importMediaBundle(libraryId, archive) {
  if (!getLibrary(libraryId)) throw new Error('library not found')
  if (!(archive instanceof Uint8Array) || archive.length > LIBRARY_LIMIT + 10 * 1024 * 1024) throw new Error('archive is too large')
  let total = 0
  const files = unzipSync(archive, { filter: file => {
    if (file.originalSize > FILE_LIMIT || (total += file.originalSize) > LIBRARY_LIMIT + FILE_LIMIT) throw new Error('archive expansion exceeds attachment limits')
    if (file.name !== 'memories.json' && file.name !== 'manifest.json' && !/^attachments\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(file.name)) throw new Error('archive contains an unsupported path')
    return true
  } })
  const manifest = JSON.parse(Buffer.from(files['manifest.json'] || []).toString('utf8'))
  const payload = JSON.parse(Buffer.from(files['memories.json'] || []).toString('utf8'))
  if (!['dsh-memu-memory-media@1', 'dsh-memu-media@1'].includes(manifest.format) || !Array.isArray(payload.memories)) throw new Error('invalid memory archive')
  let missing = 0
  withFileLock(poolFile(libraryId), () => {
    const pool = loadPool(libraryId)
    let used = pool.totals.bytes
    for (const [sha, blob] of Object.entries(manifest.blobs || {})) {
      if (!SHA.test(sha) || !MIME_EXT[blob.mime] || blob.ext !== MIME_EXT[blob.mime]) throw new Error('invalid attachment manifest')
      const bytes = files[`attachments/${sha}.${blob.ext}`]
      if (!bytes) { missing += 1; continue }
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== sha) throw new Error('attachment checksum mismatch')
      const target = blobFile(libraryId, sha, blob.ext)
      if (!fs.existsSync(target)) {
        if (used + bytes.length > LIBRARY_LIMIT) { missing += 1; continue }
        ensureDir(path.dirname(target))
        fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 })
        used += bytes.length
      }
      pool.blobs[sha] = { ...blob, sha256: sha, bytes: bytes.length, refs: [], missing: false }
    }
    savePool(libraryId, pool)
  })
  return { memories: payload.memories, graph: payload.graph || null, missing }
}

/** Stream the original images; never materialize a 500 MB library as base64. */
export async function streamMediaExport(libraryId, payload, response) {
  const pool = loadPool(libraryId)
  let failure
  const zip = new Zip((error, chunk, final) => {
    if (error) { failure = error; response.destroy(error); return }
    if (chunk.length) response.write(chunk)
    if (final) response.end()
  })
  const manifest = { format: 'dsh-memu-memory-media@1', blobs: {} }
  const push = async (name, source) => {
    const entry = new ZipPassThrough(name)
    zip.add(entry)
    for await (const chunk of source) {
      if (failure || response.destroyed) throw failure || new Error('download closed')
      entry.push(chunk)
      if (response.writableNeedDrain) await once(response, 'drain')
    }
    entry.push(new Uint8Array(), true)
  }
  const wanted = new Set(payload.memories.flatMap(entry => (entry.attachments || []).map(item => item.sha256)))
  response.writeHead(200, {
    'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${libraryId}.zip"`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  })
  try {
    for (const sha of wanted) {
      const blob = pool.blobs[sha]
      if (!blob || blob.missing) continue
      const file = blobFile(libraryId, sha, blob.ext)
      let info
      try { info = fs.statSync(file) } catch { continue }
      if (info.size > FILE_LIMIT) throw new Error('attachment exceeds export limit')
      const name = `attachments/${sha}.${blob.ext}`
      await push(name, fs.createReadStream(file, { highWaterMark: 64 * 1024 }))
      manifest.blobs[sha] = { ...blob, file: name }
    }
    await push('memories.json', [Buffer.from(JSON.stringify(payload))])
    await push('manifest.json', [Buffer.from(JSON.stringify(manifest))])
    zip.end()
  } catch (error) {
    zip.terminate()
    response.destroy(error)
    throw error
  }
}

export async function importMediaStream(libraryId, request) {
  if (!getLibrary(libraryId)) throw new Error('library not found')
  const staging = ensureDir(path.join(dataDir(), 'tmp', `import-${crypto.randomUUID()}`))
  const files = new Map()
  const descriptors = new Set()
  let expanded = 0, received = 0, failure
  const unzip = new Unzip(file => {
    try {
      const valid = file.name === 'memories.json' || file.name === 'manifest.json' || /^attachments\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(file.name)
      if (!valid || files.has(file.name) || files.size >= 2500) throw new Error('unsupported or duplicate attachment archive path')
      const local = path.join(staging, crypto.randomUUID())
      const fd = fs.openSync(local, 'wx', 0o600)
      descriptors.add(fd)
      const item = { file: local, bytes: 0, complete: false }
      files.set(file.name, item)
      file.ondata = (error, chunk, final) => {
        if (failure) return
        try {
          if (error) throw error
          item.bytes += chunk.length; expanded += chunk.length
          if (item.bytes > FILE_LIMIT || expanded > LIBRARY_LIMIT + 2 * FILE_LIMIT) throw new Error('archive expansion exceeds storage limits')
          fs.writeSync(fd, chunk)
          if (final) { fs.closeSync(fd); descriptors.delete(fd); item.complete = true }
        } catch (error) { failure = error; file.terminate() }
      }
      file.start()
    } catch (error) { failure = error; file.terminate() }
  })
  unzip.register(UnzipInflate)
  try {
    for await (const chunk of request) {
      received += chunk.length
      if (received > LIBRARY_LIMIT + 2 * FILE_LIMIT) throw new Error('archive exceeds upload limit')
      unzip.push(chunk)
      if (failure) throw failure
    }
    unzip.push(new Uint8Array(), true)
    if (failure) throw failure
    if ([...files.values()].some(item => !item.complete) || !files.has('manifest.json') || !files.has('memories.json')) throw new Error('incomplete memory archive')
    const payload = JSON.parse(fs.readFileSync(files.get('memories.json').file, 'utf8'))
    const manifest = JSON.parse(fs.readFileSync(files.get('manifest.json').file, 'utf8'))
    if (!['dsh-memu-memory-media@1', 'dsh-memu-media@1'].includes(manifest.format) || !Array.isArray(payload.memories)) throw new Error('invalid memory archive')
    let missing = 0
    withFileLock(poolFile(libraryId), () => {
      const pool = loadPool(libraryId)
      let bytesUsed = pool.totals.bytes
      const created = []
      try {
        for (const [sha, blob] of Object.entries(manifest.blobs || {})) {
          if (!SHA.test(sha) || !MIME_EXT[blob.mime] || blob.ext !== MIME_EXT[blob.mime]) throw new Error('invalid attachment metadata')
          const item = files.get(`attachments/${sha}.${blob.ext}`)
          if (!item) { missing++; continue }
          const bytes = fs.readFileSync(item.file)
          if (crypto.createHash('sha256').update(bytes).digest('hex') !== sha) throw new Error('attachment checksum mismatch')
          const target = blobFile(libraryId, sha, blob.ext)
          if (!fs.existsSync(target)) {
            if (bytesUsed + bytes.length > LIBRARY_LIMIT) { missing++; continue }
            ensureDir(path.dirname(target))
            fs.copyFileSync(item.file, target, fs.constants.COPYFILE_EXCL)
            created.push(target); bytesUsed += bytes.length
          }
          pool.blobs[sha] = { ...blob, sha256: sha, bytes: bytes.length, refs: [], missing: false }
        }
        savePool(libraryId, pool)
      } catch (error) {
        for (const file of created) { try { fs.unlinkSync(file) } catch {} }
        throw error
      }
    })
    return { memories: payload.memories, graph: payload.graph, missing }
  } finally {
    for (const fd of descriptors) { try { fs.closeSync(fd) } catch {} }
    if (!path.resolve(staging).startsWith(path.resolve(dataDir(), 'tmp') + path.sep)) throw new Error('invalid archive staging directory')
    fs.rmSync(staging, { recursive: true, force: true })
  }
}
