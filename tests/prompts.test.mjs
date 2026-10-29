import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-prompts-'))
process.env.DSH_MEMU_HOME = home

const prompts = await import('../lib/prompts.js')
const state = await import('../lib/state.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

test('default prompt loads and renders variables', () => {
  const state = prompts.getPromptState('system-guide')
  assert.equal(state.source, 'default')
  assert.ok(state.text.includes('MemU memory'))
  const rendered = prompts.loadPrompt('system-guide', { mustRememberCap: 16 })
  assert.ok(rendered.text.includes('16'))
  assert.ok(!rendered.text.includes('{{mustRememberCap}}'))
})

test('user override wins, reset restores default', () => {
  prompts.savePromptOverride('system-guide', 'CUSTOM {{mustRememberCap}}')
  const custom = prompts.getPromptState('system-guide')
  assert.equal(custom.source, 'user')
  assert.equal(prompts.loadPrompt('system-guide', { mustRememberCap: 7 }).text, 'CUSTOM 7')
  const reset = prompts.resetPrompt('system-guide')
  assert.equal(reset.source, 'default')
  assert.ok(reset.text.includes('MemU memory'))
})

test('default version update marks a user override', () => {
  prompts.savePromptOverride('private-policy', 'CUSTOM POLICY')
  const manifestPath = path.join(home, 'prompts', 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.prompts['private-policy'].defaultHash = 'old-default-hash'
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  prompts.syncPromptDefaults()
  const state = prompts.getPromptState('private-policy')
  assert.equal(state.source, 'user')
  assert.equal(state.defaultUpdated, true)
  prompts.syncPromptDefaults()
  assert.equal(prompts.getPromptState('private-policy').defaultUpdated, true, 'a second startup must not hide an unacknowledged default update')
  assert.equal(prompts.getPromptState('private-policy').text, 'CUSTOM POLICY', 'new defaults must never overwrite custom text')
  prompts.savePromptOverride('private-policy', 'REVIEWED CUSTOM POLICY')
  assert.equal(prompts.getPromptState('private-policy').defaultUpdated, false, 'saving acknowledges the new default')
  prompts.resetPrompt('private-policy')
  assert.equal(prompts.getPromptState('private-policy').defaultUpdated, false)
})

test('unknown template variables stay literal', () => {
  assert.equal(prompts.renderTemplate('a {{known}} b {{unknown}}', { known: 'x' }), 'a x b {{unknown}}')
})

test('prompts resolve to the conversation domain and fall back to base', () => {
  const rp = prompts.loadPromptForDomain('system-guide', { mustRememberCap: 16, unpinBudget: 2 }, 'rp')
  assert.equal(rp.key, 'system-guide.rp')
  assert.match(rp.text, /角色扮演/)
  const coding = prompts.loadPromptForDomain('system-guide', {}, 'coding')
  assert.equal(coding.key, 'system-guide.coding')
  assert.match(coding.text, /code wins over memory/)

  const general = prompts.loadPromptForDomain('system-guide', {}, 'general')
  assert.equal(general.key, 'system-guide')
  assert.equal(general.fellBackToBase, true)

  // Prompts whose job is to reason across domains are never split.
  assert.equal(prompts.resolveDef('global-curator', 'rp').key, 'global-curator')
})

test('a deleted variant silently falls back to the base prompt', () => {
  const dir = prompts.DEFAULT_DIR
  const variant = path.join(dir, 'private-policy.rp.md')
  const original = fs.readFileSync(variant, 'utf8')
  fs.rmSync(variant)
  try {
    const resolved = prompts.loadPromptForDomain('private-policy', {}, 'rp')
    assert.equal(resolved.key, 'private-policy')
    assert.equal(resolved.fellBackToBase, true)
  } finally {
    fs.writeFileSync(variant, original, 'utf8')
  }
})

test('prompts carry the scope the settings sub-tabs group by', () => {
  const states = prompts.getPromptStates()
  const scopes = Object.fromEntries(states.map((s) => [s.key, s.scope]))
  assert.equal(scopes['system-guide'], 'private')
  assert.equal(scopes['system-guide.rp'], 'private', 'variants inherit their base scope')
  assert.equal(scopes['private-policy.coding'], 'private')
  assert.equal(scopes['global-curator'], 'global')
  assert.ok(states.every((s) => s.scope === 'private' || s.scope === 'global'))
})

test('adding a domain page creates its variants, seeded from the base prompt', () => {
  state.addPromptDomain('novel')
  try {
    const keys = prompts.getPromptStates().map((s) => s.key)
    assert.ok(keys.includes('system-guide.novel'))
    assert.ok(keys.includes('private-consolidation.novel'))
    // global-curator is not domain-layered, so no variant appears for it.
    assert.ok(!keys.includes('global-curator.novel'))

    // No file yet: it shows the base text so there is something to edit, and the
    // runtime keeps using the base prompt until a real file exists.
    const seeded = prompts.getPromptState('system-guide.novel')
    assert.equal(seeded.inheritedFrom, 'system-guide')
    assert.ok(seeded.text.includes('MemU memory'))
    assert.equal(prompts.resolveDef('system-guide', 'novel').key, 'system-guide')

    // Saving it stores the page separately and makes it authoritative.
    prompts.savePromptOverride('system-guide.novel', 'NOVEL GUIDE')
    assert.equal(prompts.getPromptState('system-guide.novel').source, 'user')
    assert.equal(prompts.resolveDef('system-guide', 'novel').key, 'system-guide.novel')
    assert.equal(prompts.loadPromptForDomain('system-guide', {}, 'novel').text, 'NOVEL GUIDE')
    assert.ok(prompts.getPromptState('system-guide').text.includes('MemU memory'), 'the base page is untouched')
  } finally {
    for (const key of ['system-guide.novel', 'private-policy.novel', 'private-consolidation.novel']) prompts.resetPrompt(key)
    state.removePromptDomain('novel')
  }
  assert.ok(!prompts.getPromptStates().some((s) => s.key === 'system-guide.novel'))
})

test('an explicit domain list is kept; all shipped pages are enabled by default', () => {
  const saved = state.getPromptDomains()
  assert.deepEqual(saved, ['rp', 'coding', 'mixed'])
  try {
    state.updateSettings({ promptDomains: ['rp', 'coding'] })
    assert.deepEqual(state.getPromptDomains(), ['rp', 'coding'], 'disabling a page is a deliberate list')
    state.updateSettings({ promptDomains: ['rp', 'novel'] })
    assert.deepEqual(state.getPromptDomains(), ['rp', 'novel'], 'a deliberate list is kept')
  } finally {
    state.updateSettings({ promptDomains: saved })
  }
})

test('every shipped domain has a prompt page', () => {
  // The session picker lists general + promptDomains; the prompts page lists
  // general + the domains that have variants. They must be the same list.
  const domains = state.getPromptDomains()
  assert.ok(domains.includes('mixed'), 'mixed is a session domain and needs a page')
  const pages = new Set(prompts.getPromptStates().filter((s) => s.domain).map((s) => s.domain))
  for (const domain of domains) assert.ok(pages.has(domain), `domain ${domain} has no prompt page`)
  assert.equal(prompts.resolveDef('system-guide', 'mixed').key, 'system-guide.mixed')
})

test('domain ids are validated', () => {
  assert.throws(() => state.addPromptDomain('../evil'), /domain id/)
  assert.throws(() => state.addPromptDomain('general'), /built-in/)
  assert.throws(() => state.addPromptDomain(''), /domain id/)
})

test('syncPromptDefaults keeps records for keys it does not know about', () => {
  prompts.savePromptOverride('system-guide.coding', 'MY CODING GUIDE')
  const manifestPath = path.join(home, 'prompts', 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.prompts['a-key-from-an-older-version'] = { defaultHash: 'x', userHash: 'y', defaultUpdated: true, updatedAt: '2020-01-01T00:00:00.000Z' }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  prompts.syncPromptDefaults()

  const after = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  assert.ok(after.prompts['a-key-from-an-older-version'], 'unknown keys must survive a default sync')
  assert.equal(after.prompts['system-guide.coding'].userHash, manifest.prompts['system-guide.coding'].userHash)
  assert.equal(prompts.getPromptState('system-guide.coding').source, 'user')
  prompts.resetPrompt('system-guide.coding')
})

test('domain defaults distinguish engineering evidence, character continuity and mixed boundaries', () => {
  for (const kind of ['system-guide', 'private-policy', 'private-consolidation']) {
    const coding = prompts.getPromptState(`${kind}.coding`).defaultText
    assert.match(coding, /代码块/)
    assert.match(coding, /逻辑/)
    assert.match(coding, /验证/)
    assert.match(coding, /符号/)
    assert.match(coding, /复核|review/)
    assert.doesNotMatch(coding, /最多三句、约 200 字|runs at most three sentences/)
    const rp = prompts.getPromptState(`${kind}.rp`).defaultText
    assert.match(rp, /边界|界限/)
    assert.match(rp, /承诺|约定/)
    assert.match(rp, /waiting/)
    assert.match(rp, /事实不能为了人味而记错/)
    assert.doesNotMatch(rp, /允许模糊、偏见、自欺、记混|允许模糊、偏见、自欺、记错|可以记成另一个样子/)
    const mixed = prompts.getPromptState(`${kind}.mixed`).defaultText
    assert.match(mixed, /技术侧|技术/)
    assert.match(mixed, /人物|人这一侧/)
    assert.match(mixed, /OOC|ooc/)
    assert.match(mixed, /不.*代替.*(权限|边界)|不是权限隔离/)
    assert.match(mixed, /复核/)
  }
  assert.match(prompts.getPromptState('system-guide').defaultText, /不默认进入角色扮演/)
  assert.match(prompts.getPromptState('private-policy').defaultText, /通用领域不默认角色扮演/)
  const curator = prompts.getPromptState('global-curator').defaultText
  assert.match(curator, /角色台词、虚构身份、感情和剧情承诺不是现实用户属性/)
  assert.match(curator, /前置条件、适用版本与验证边界/)
})

test('all shipped template variables are declared and fully rendered, with bounded resident guidance', () => {
  const vars = { mustRememberCap: 16, unpinBudget: 2, shortTermTtlHours: 48, anchorTokens: 700, turnTokens: 500,
    libraryName: 'test-library', domain: 'coding', input: '{"sessions":[]}' }
  for (const definition of prompts.allDefs()) {
    const text = prompts.getPromptState(definition.key).defaultText
    for (const [, variable] of text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
      assert.ok(definition.variables.includes(variable), `${definition.key} does not expose ${variable} in the editor`)
    }
    assert.doesNotMatch(prompts.loadPrompt(definition.key, vars).text, /\{\{\s*\w+\s*\}\}/)
  }
  // A size guard, not a tokenizer or a claim about model behavior.
  for (const domain of ['general', 'coding', 'rp', 'mixed']) {
    const text = ['system-guide', 'private-policy'].map(key => prompts.loadPromptForDomain(key, vars, domain).text).join('\n')
    assert.ok(text.length < 7200, `${domain} resident instructions grew too large: ${text.length}`)
  }
})

test('registered system sections follow the live domain override and render actual budgets', async () => {
  const { registerInjection } = await import('../lib/inject.js')
  const sessionId = 'prompt-routing'
  state.ensureSession(sessionId, { cwd: path.join(home, 'routing') })
  const sections = []
  registerInjection({
    inject: (_dependencies, fn) => fn({ effect: fn => fn(), systemPrompt: { section: spec => { sections.push(spec); return () => {} } } }),
    on: () => () => {},
  })
  assert.equal(sections.length, 2)
  const context = { agent: { session: { header: { id: sessionId } } } }
  const saved = state.getPromptDomains()
  state.updateSettings({ promptDomains: ['rp', 'coding', 'mixed'] })
  try {
    for (const domain of ['coding', 'rp', 'mixed', 'general']) {
      state.setSessionBinding(sessionId, { domainOverride: domain })
      for (let i = 0; i < sections.length; i++) {
        const key = i === 0 ? 'system-guide' : 'private-policy'
        const settings = state.getSettings()
        const expected = prompts.loadPromptForDomain(key, {
          mustRememberCap: settings.mustRememberCap, unpinBudget: settings.unpinBudgetPerSession,
          shortTermTtlHours: settings.shortTermTtlHours, anchorTokens: settings.anchorTokens, turnTokens: settings.turnTokens,
        }, domain).text
        assert.equal(sections[i].text(context), expected)
        assert.doesNotMatch(expected, /\{\{\s*\w+\s*\}\}/)
      }
    }
  } finally {
    state.updateSettings({ promptDomains: saved })
  }
})

test('local consolidation adds actual tools while the shared domain body stays backend-neutral', async () => {
  const { buildPrivateConsolidationPrompt } = await import('../lib/private.js')
  const sessionId = 'consolidation-routing'
  state.ensureSession(sessionId, { cwd: path.join(home, 'consolidation-routing') })
  for (const domain of ['coding', 'rp', 'mixed', 'general']) {
    state.setSessionBinding(sessionId, { domainOverride: domain })
    const text = buildPrivateConsolidationPrompt(sessionId)
    assert.ok(text.includes(prompts.CONSOLIDATION_CONTRACTS.local))
    assert.match(text, /memu_private_update/)
    assert.doesNotMatch(text, /\{\{\s*\w+\s*\}\}/)
    assert.equal(text.includes('你没有记忆工具'), false)
  }
})
