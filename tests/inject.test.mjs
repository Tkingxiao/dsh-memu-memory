import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-inject-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const inject = await import('../lib/inject.js')
const budget = await import('../lib/budget.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

test('anchor shows a pinned memory as a title card, without its body', () => {
  const cwd = path.join(home, 'project-anchor')
  const binding = state.ensureSession('inject-anchor', { cwd, agentPreset: 'rp' })
  const index = state.loadPrivateIndex(binding.libraryId)
  index.entries['mem-test'] = {
    track: 'memory',
    layer: 'must_remember',
    title: '凉茶',
    content: '今天他走的时候没看我。',
    status: 'active',
    pinReason: '我不想忘记。',
    pinSource: 'user_explicit',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  state.savePrivateIndex(binding.libraryId, index)
  const anchor = inject.buildAnchor(binding, { ...state.getSettings(), anchorTokens: 700 })
  assert.ok(anchor.text.includes('[mem-test]'), 'the id is the handle the model quotes back')
  assert.ok(anchor.text.includes('凉茶'))
  assert.equal(anchor.text.includes('今天他走的时候没看我'), false, 'the anchor is a directory; the body stays out')
  assert.ok(anchor.ids.includes('mem-test'))
})

test('the rule is a preface: before the private header, and it names the recall path', () => {
  const cwd = path.join(home, 'project-rule')
  const binding = state.ensureSession('inject-rule', { cwd, agentPreset: 'rp' })
  const index = state.loadPrivateIndex(binding.libraryId)
  index.entries['mem-rule'] = {
    track: 'memory',
    layer: 'must_remember',
    title: '规则之下的记忆',
    content: '这段正文不该出现在锚点里。',
    status: 'active',
    pinSource: 'user_explicit',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  state.savePrivateIndex(binding.libraryId, index)
  const anchor = inject.buildAnchor(binding, { ...state.getSettings(), anchorTokens: 700 })
  const headerAt = anchor.text.indexOf('===== memory anchor =====')
  const ruleAt = anchor.text.indexOf('[rule]')
  const privateAt = anchor.text.indexOf('[private ·')
  assert.ok(headerAt >= 0, 'the anchor starts with its header')
  assert.ok(anchor.text.startsWith('===== memory anchor =====\n\n[rule]'), 'the header and rule are separated by a blank line')
  assert.ok(ruleAt > headerAt && privateAt > ruleAt, 'the rule is read before the memories it governs')
  assert.match(anchor.text, /\[rule\][^\n]*\n\n\[private ·/, 'the rule and the private section are separated by a blank line')
  assert.ok(anchor.text.indexOf('[mem-rule]') > privateAt)
  assert.ok(anchor.text.includes('标题即目录'), 'the rule says the anchor is a table of contents')
  assert.ok(anchor.text.includes('memu_private_recall 按标题关键词查'), 'and how to get the original text back')
})

test('an empty title falls back to the first 40 characters of the content', () => {
  const cwd = path.join(home, 'project-fallback')
  const binding = state.ensureSession('inject-fallback', { cwd, agentPreset: 'rp' })
  const content = '他答应过要在雨停之前回来，可是到了第二天早上门口还是空的，只有那把伞靠在墙边。'
  const now = new Date().toISOString()
  const index = state.loadPrivateIndex(binding.libraryId)
  index.entries['mem-fallback'] = {
    track: 'memory',
    layer: 'long_term',
    content,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }
  state.savePrivateIndex(binding.libraryId, index)
  const anchor = inject.buildAnchor(binding, { ...state.getSettings(), anchorTokens: 700 })
  assert.ok(anchor.text.includes('[mem-fallback]'), 'the core segment is a title card too')
  assert.ok(anchor.text.includes(content.slice(0, 40)), 'a card with no title is still searchable by its opening words')
  assert.equal(anchor.text.includes('(untitled)'), false, 'content exists, so the row is never anonymous')
})

test('title-card lines keep source, disclosure, accuracy and the attachment count', () => {
  const cwd = path.join(home, 'project-labels')
  const binding = state.ensureSession('inject-labels', { cwd, agentPreset: 'rp' })
  const now = new Date().toISOString()
  const index = state.loadPrivateIndex(binding.libraryId)
  index.entries['mem-labels'] = {
    track: 'memory',
    layer: 'must_remember',
    title: '他编的那个故事',
    content: '他说那是真的，但那只是他想出来的。',
    source: 'imagined',
    disclosure: 'can_tell',
    accuracy: 0.3,
    confidence: 0.9,
    attachments: [
      { sha256: 'a'.repeat(64) },
      { sha256: 'b'.repeat(64), caption: 'CAPTION-MUST-NOT-EXPAND' },
    ],
    status: 'active',
    pinSource: 'self',
    createdAt: now,
    updatedAt: now,
  }
  state.savePrivateIndex(binding.libraryId, index)
  const anchor = inject.buildAnchor(binding, { ...state.getSettings(), anchorTokens: 700 })
  const line = anchor.text.split('\n').find((row) => row.includes('[mem-labels]'))
  assert.ok(line, 'the title card exists')
  assert.ok(line.includes('source=imagined'), 'an imagined memory must not read as a fact')
  assert.equal(line.includes('别直接说出口'), false, 'can_tell carries no disclosure suffix')
  assert.ok(line.includes('细节未必准'), 'accuracy still rides on the line')
  assert.ok(line.includes('附件2'), 'attachments are counted')
  assert.equal(anchor.text.includes('CAPTION-MUST-NOT-EXPAND'), false, 'captions are expanded only by the full renderer')
})

test('with the same anchorTokens, title cards expose at least as many ids as full text', () => {
  const cwd = path.join(home, 'project-compare')
  const binding = state.ensureSession('inject-compare', { cwd, agentPreset: 'rp' })
  const now = new Date().toISOString()
  const index = state.loadPrivateIndex(binding.libraryId)
  const items = []
  const body = '这是一段用来占满预算的中文记忆正文，重复几遍让长度足够触发截断。'.repeat(3)
  for (let i = 0; i < 16; i++) {
    const id = `mem-cmp-${i}`
    index.entries[id] = {
      track: 'memory',
      layer: 'must_remember',
      title: `对比记忆 ${i}`,
      content: `${body} BODY-${i}`,
      status: 'active',
      pinSource: 'self',
      strength: 1 - i / 20,
      createdAt: now,
      updatedAt: new Date(Date.now() - i * 60000).toISOString(),
    }
    items.push([id, index.entries[id]])
  }
  state.savePrivateIndex(binding.libraryId, index)
  const anchorTokens = 600
  const anchor = inject.buildAnchor(binding, { ...state.getSettings(), anchorTokens })
  // The old shape was the same head plus the body the card now omits. Pack it into the
  // *whole* anchor budget (no section headers charged), which is more room than the
  // full-text anchor ever actually got — so this comparison is deliberately unfair to
  // the title cards.
  const legacy = budget.packToBudget(items, anchorTokens, (entry, id) =>
    `- [${id}] source=${entry.source || 'inferred'} · ${entry.title} · ${entry.layer || 'long_term'}`
    + (entry.content ? `\n  ${entry.content}` : ''))
  assert.ok(anchor.ids.length >= legacy.ids.length,
    `title cards exposed ${anchor.ids.length} ids, full text ${legacy.ids.length}`)
})

test('pre-step inserts a plugin message before the user message', async () => {
  const cwd = path.join(home, 'project-step')
  const binding = state.ensureSession('inject-step', { cwd, agentPreset: 'coding' })
  const index = state.loadPrivateIndex(binding.libraryId)
  index.entries['mem-step'] = {
    track: 'memory',
    layer: 'must_remember',
    title: 'Step memory',
    content: 'A pinned detail.',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  // A non-pinned entry that only per-turn retrieval can surface. Without the
  // recall path running, the message still exists (the anchor alone creates it),
  // so the assertion has to be on this id.
  index.entries['mem-recall'] = {
    track: 'memory',
    layer: 'long_term',
    title: 'Deploy convention',
    content: 'The deploy script lives in tools/deploy.ps1 and needs the staging token.',
    status: 'active',
    confidence: 0.9,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  state.savePrivateIndex(binding.libraryId, index)

  const user = {
    id: 'u1',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Where does the deploy script live and what token does it need?' }],
  }
  const decision = { kind: 'enter', messages: [user] }
  // The host Agent shape has no `.agent` of its own; a stub that adds one would
  // hide the very bug this test guards (P0-1).
  const agent = { session: { header: { id: 'inject-step', cwd, agentPreset: 'coding', origin: 'user' } } }
  const out = await inject.injectForStep({ agent, decision, turn: 1, step: 1, signal: { aborted: false } })
  assert.equal(out.messages.length, 2)
  assert.equal(out.messages[0].role, 'user')
  assert.equal(out.messages[0].source.kind, 'plugin:dsh-memu-memory')
  assert.equal(out.messages[0].source.plugin, undefined)
  assert.equal(out.messages[0].source.form, 'recall')
  assert.equal(out.messages[1].source.kind, 'user')

  const injected = out.messages[0].content[0].text
  assert.ok(injected.includes('[mem-recall]'), 'per-turn recall must surface the matching entry by id')
  assert.ok(injected.includes('Deploy convention'), 'the title is what reaches the prompt')
  assert.equal(injected.includes('The deploy script lives in tools/deploy.ps1'), false,
    'the turn block is a title card; the body stays behind memu_private_recall')
  assert.ok(state.getSessionBinding('inject-step').injectedIds.includes('mem-recall'))
  assert.equal(state.getSessionBinding('inject-step').lastRecallError, undefined)

  const skipped = await inject.injectForStep({ agent, decision, turn: 1, step: 2, signal: { aborted: false } })
  assert.equal(skipped, decision)
})

test('buildRecall injects the title card, not the body', async () => {
  const cwd = path.join(home, 'project-recall-title')
  const binding = state.ensureSession('inject-recall-title', { cwd, agentPreset: 'coding' })
  const now = new Date().toISOString()
  const index = state.loadPrivateIndex(binding.libraryId)
  index.entries['mem-recall-title'] = {
    track: 'memory',
    layer: 'long_term',
    title: '部署脚本的位置',
    content: 'RECALL-BODY-ONLY 部署脚本放在 tools/deploy.ps1，需要 staging token。',
    status: 'active',
    confidence: 0.9,
    createdAt: now,
    updatedAt: now,
  }
  state.savePrivateIndex(binding.libraryId, index)
  const exec = { agent: { session: { header: { id: 'inject-recall-title', cwd, agentPreset: 'coding' } } } }
  const recall = await inject.buildRecall(binding, '部署脚本的位置', 1,
    { ...state.getSettings(), relevanceThreshold: 0 }, exec, 'inject-recall-title')
  assert.deepEqual(recall.errors, [])
  assert.ok(recall.ids.includes('mem-recall-title'))
  assert.ok(recall.text.includes('部署脚本的位置'), 'the title is the card')
  assert.ok(recall.text.includes('[mem-recall-title]'), 'the id stays quotable')
  assert.match(recall.text, /条目是标题卡/, 'the block tells the model how to use a title card')
  assert.ok(recall.text.includes('memu_private_recall'), 'and which tool returns the body')
  assert.equal(recall.text.includes('RECALL-BODY-ONLY'), false,
    'memu_private_recall still returns full text; the turn block does not')
})

test('a failing recall is recorded instead of disappearing', async () => {
  const cwd = path.join(home, 'project-recall-error')
  const binding = state.ensureSession('inject-recall-error', { cwd, agentPreset: 'coding' })
  const user = {
    id: 'u9', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'Please continue with the earlier context of this task.' }],
  }
  const decision = { kind: 'enter', messages: [user] }
  const agent = { session: { header: { id: 'inject-recall-error', cwd, origin: 'user' } } }

  // A ToolExecution-like exec with no identifiable session is exactly the shape
  // that used to fail silently inside buildRecall.
  const broken = await inject.buildRecall(binding, 'earlier context', 1, state.getSettings(), { agent: {} })
  assert.equal(broken.text, '')
  assert.ok(broken.errors.length > 0, 'recall with an unidentifiable session must report an error')
  assert.match(broken.errors[0], /private recall failed: no bound session/)

  const out = await inject.injectForStep({ agent, decision, turn: 1, step: 1, signal: { aborted: false } })
  assert.ok(Array.isArray(out.messages), 'injection stays fail-open')
  assert.ok(!out.messages.some((m) => String(m?.content?.[0]?.text || '').includes('<memory-context')), 'nothing was recalled')
  assert.equal(state.getSessionBinding('inject-recall-error').lastRecallError, undefined)
})

test('recall errors stick to the binding until a healthy turn clears them', () => {
  state.ensureSession('inject-sticky', { cwd: path.join(home, 'project-sticky') })
  state.setRecallError('inject-sticky', 'private recall failed: engine down')
  assert.match(state.getSessionBinding('inject-sticky').lastRecallError, /engine down/)
  assert.ok(state.getSessionBinding('inject-sticky').lastRecallErrorAt)
  state.setRecallError('inject-sticky', null)
  assert.equal(state.getSessionBinding('inject-sticky').lastRecallError, undefined)
  assert.equal(state.getSessionBinding('inject-sticky').lastRecallErrorAt, undefined)
})

test('anchor never records ids that were cut from the text', () => {
  const cwd = path.join(home, 'project-budget')
  const binding = state.ensureSession('inject-budget', { cwd, agentPreset: 'rp' })
  const index = state.loadPrivateIndex(binding.libraryId)
  // 16 pins, each long enough that the anchor cannot hold all of them.
  for (let i = 0; i < 16; i++) {
    index.entries[`mem-pin-${i}`] = {
      track: 'memory',
      layer: 'must_remember',
      title: `永久记忆 ${i}`,
      content: '这是一段用来占满预算的中文记忆正文，重复几遍让长度足够触发截断。'.repeat(3),
      status: 'active',
      pinSource: i === 15 ? 'user_explicit' : 'self',
      strength: 1 - i / 20,
      createdAt: new Date().toISOString(),
      updatedAt: new Date(Date.now() - i * 60000).toISOString(),
    }
  }
  state.savePrivateIndex(binding.libraryId, index)

  const anchor = inject.buildAnchor(binding, { ...state.getSettings(), anchorTokens: 300 })
  const idsInText = [...anchor.text.matchAll(/\[(mem-pin-\d+)\]/g)].map((m) => m[1])
  assert.deepEqual([...anchor.ids].sort(), [...new Set(idsInText)].sort(), 'ids must match what the text actually contains')
  assert.ok(anchor.ids.length < 16, 'some pins were left out at this budget')
  assert.match(anchor.text, /另有 \d+ 条永久记忆未展开/)
  // A user-pinned memory outranks self-pinned ones regardless of recency.
  assert.ok(anchor.ids.includes('mem-pin-15'))
})

test('a Chinese anchor stays inside its token budget', () => {
  const cwd = path.join(home, 'project-cjk')
  const binding = state.ensureSession('inject-cjk', { cwd, agentPreset: 'rp' })
  const index = state.loadPrivateIndex(binding.libraryId)
  for (let i = 0; i < 12; i++) {
    index.entries[`mem-cjk-${i}`] = {
      track: 'memory',
      layer: 'must_remember',
      title: `中文条目 ${i}`,
      content: '他说那句话的时候窗外正在下雨，我没有回头看他，只是把杯子往桌角挪了一点。'.repeat(4),
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }
  state.savePrivateIndex(binding.libraryId, index)
  const anchor = inject.buildAnchor(binding, { ...state.getSettings(), anchorTokens: 400 })
  assert.ok(budget.estTokens(anchor.text) <= 420, `anchor used ${budget.estTokens(anchor.text)} tokens for a 400 budget`)
})

test('subagent turns are skipped', async () => {
  const user = {
    id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello world this is a long message' }],
  }
  const decision = { kind: 'enter', messages: [user] }
  const agent = { session: { header: { id: 'inject-sub', origin: 'subagent' } } }
  const out = await inject.injectForStep({ agent, decision, turn: 1, step: 1, signal: { aborted: false } })
  assert.equal(out, decision)
})
test('per-turn mode reads the global layer every turn instead of on the cadence', async () => {
  const cwd = path.join(home, 'project-per-turn')
  state.ensureSession('inject-per-turn', { cwd, agentPreset: 'coding' })
  state.setSessionBinding('inject-per-turn', { domainOverride: 'coding' })
  const binding = state.getSessionBinding('inject-per-turn')
  const gi = state.loadGlobalIndex()
  gi.entries['mem-global-deploy'] = {
    track: 'memory',
    layer: 'long_term',
    domain: 'coding',
    title: 'Staging token rotation',
    content: 'The staging deploy token is rotated every Monday by the platform team.',
    status: 'active',
    confidence: 0.9,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  state.saveGlobalIndex(gi)

  const exec = { agent: { session: { header: { id: 'inject-per-turn', cwd, agentPreset: 'coding' } } } }
  const query = 'staging deploy token rotation'
  const base = state.getSettings()

  // smart keeps the cadence: turn 2 is not a global turn while globalEveryNTurns is 6,
  // and waiting for the cadence is exactly what per-turn exists to opt out of.
  const smart = await inject.buildRecall(binding, query, 2, { ...base, autoInject: 'smart' }, exec)
  assert.deepEqual(smart.errors, [])
  assert.ok(!smart.ids.includes('mem-global-deploy'), 'smart must not pull the global layer off-cadence')

  const perTurn2 = await inject.buildRecall(binding, query, 2, { ...base, autoInject: 'per-turn' }, exec)
  assert.ok(perTurn2.ids.includes('mem-global-deploy'), 'per-turn recalls the global layer on a plain turn')
  assert.ok(perTurn2.text.includes('Staging token rotation'), 'the global title card arrives')
  assert.equal(perTurn2.text.includes('rotated every Monday'), false, 'but not its body')

  const perTurn5 = await inject.buildRecall(binding, query, 5, { ...base, autoInject: 'per-turn' }, exec)
  assert.ok(perTurn5.ids.includes('mem-global-deploy'), 'and again on the next turn, not only every Nth turn')
})
