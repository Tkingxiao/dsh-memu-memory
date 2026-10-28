#!/usr/bin/env node
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import sharp from 'sharp'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-preview-'))
process.env.DSH_MEMU_HOME = home
process.env.MEMU_CONFIG = path.join(home, 'config.env')
const state = await import('../lib/state.js')
const memory = await import('../lib/memory.js')
const graph = await import('../lib/graph.js')
const { captureMediaEvent } = await import('../lib/media.js')
const { registerRpc } = await import('../lib/rpc.js')
state.updateSettings({ autoInstallEngine: false, sleepConsolidation: false, randomCueChance: 0 })
const cwd = path.join(home, 'Story Workshop')
const binding = state.ensureSession('preview-session', { cwd, agentPreset: 'rp' })
state.setSessionBinding('preview-session', { title: '雨夜之后' })
const session = { header: { id: 'preview-session', cwd, agentPreset: 'rp' } }
const exec = { agent: { session } }
const a = await memory.privateRemember({ exec, title: '周五的约定', content: '她答应周五把修好的相机带来；我们约在车站旁的书店见。', openLoop: true, source: 'user_said', layer: 'must_remember', pinSource: 'user_explicit', pinReason: '她明确说不要忘记这个约定。' })
const b = await memory.privateRemember({ exec, title: '雨夜的车站', content: '车站屋檐下有一小块干地，她把伞朝我这边偏了偏。', source: 'inferred', moodValence: .6 })
const c = await memory.privateRemember({ exec, title: '待确认的路线', content: '也许周五会改走河边的小路，还没有说定。', layer: 'short_term', confidence: .4 })
graph.linkEntries({ libraryId: binding.libraryId, fromId: a.id, toId: b.id, kind: 'event', note: '同一次会面留下的场景与后续约定。' })
graph.linkEntries({ libraryId: binding.libraryId, fromId: a.id, toId: c.id, kind: 'commitment', note: '去书店的路线仍需要下一次确认。' })
const entity = graph.createEntity({ libraryId: binding.libraryId, name: '小周' })
graph.linkEntries({ libraryId: binding.libraryId, fromId: b.id, toId: entity.id, kind: 'person', note: '雨夜把伞偏过来的那个人就是小周。' })
const bytes = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#3b8b75' } }).png().toBuffer()
const sha = crypto.createHash('sha256').update(bytes).digest('hex')
const ref = { attachmentId: sha, mediaType: 'image/png', bytes: bytes.length, width: 640, height: 480, name: 'color-study.png' }
const attachmentService = { readImage: async () => ({ ref, data: bytes }) }
const services = {
  attachments: attachmentService,
  sessionQuery: {
    listSessions: async () => [{ header: session.header, live: true }],
    readTitleSnapshots: async () => [{ sessionId: 'preview-session', status: 'fulfilled', value: { title: { title: '雨夜之后' } } }],
  },
}
await captureMediaEvent({ get: key => services[key] }, session, { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这是一张绿色色卡，用来测试图片附件。' }, { type: 'image', attachment: ref }] } })
await memory.privateRemember({ exec, title: '绿色色卡', content: '对方发来一张用于测试附件的绿色色卡。', attachments: [{ sha256: sha }], layer: 'long_term', source: 'user_said' })
state.flushState()
let handler
const ctx = { get: key => services[key], logger: console,
  inject: (_deps, callback) => callback({
    connection: { requestRejection: req => {
      const origin = req.headers.origin
      return origin && origin !== `http://${req.headers.host}` ? 403 : undefined
    } },
    webServer: { register: spec => { handler = spec.handler; return () => {} } },
    effect: fn => fn(), logger: console,
  }) }
registerRpc(ctx)
const portIndex = process.argv.indexOf('--port')
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 7789
const server = http.createServer((req, res) => { void handler(req, res).catch(error => { console.error(error); if (!res.headersSent) res.writeHead(500); res.end('preview error') }) })
server.listen(port, '127.0.0.1', () => console.log(`Preview (isolated example data): http://127.0.0.1:${server.address().port}/dsh-memu-memory/ui#/settings/memories`))
