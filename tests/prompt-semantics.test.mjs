import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-prompt-128-'))
process.env.DSH_MEMU_HOME = home

const prompts = await import('../lib/prompts.js')
const { buildWorkerBrief } = await import('../lib/consolidation-worker.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

const policyVars = { shortTermTtlHours: 72, mustRememberCap: 12, unpinBudget: 2, anchorTokens: 800 }
const guideVars = { mustRememberCap: 12, unpinBudget: 2, shortTermTtlHours: 72, anchorTokens: 800, turnTokens: 800 }

test('the RP guide asks for scene-time dates, two versions and speaker separation', () => {
  const text = prompts.loadPromptForDomain('system-guide', guideVars, 'rp').text
  assert.match(text, /相对日期先按这一轮的时间换算/)
  assert.match(text, /记忆里有两版说法时/)
  assert.match(text, /分清是谁说的/)
})

test('the RP policy teaches the S1–S4 write fields', () => {
  const text = prompts.loadPromptForDomain('private-policy', policyVars, 'rp').text
  assert.match(text, /absolute_date/)
  assert.match(text, /date_precision=unknown/)
  assert.match(text, /conflicts_with/)
  assert.match(text, /supersedes/)
  assert.match(text, /commitment/)
  assert.match(text, /assistant_said/)
})

test('the consolidation page and worker brief carry the same field contract', () => {
  const text = prompts.loadPromptForDomain('private-consolidation', {
    libraryName: '测试库', domain: 'rp', mustRememberCap: 12,
  }, 'rp').text
  for (const needle of ['speaker_id', 'source_kind', 'absolute_date', 'conflicts_with', 'commitment']) {
    assert.ok(text.includes(needle), `consolidation prompt is missing ${needle}`)
  }
  const brief = buildWorkerBrief({
    snapshot: { fromSeq: 1, throughSeq: 2, eventCount: 2, hash: 'prompt-128' },
    probe: { tools: ['memu_private_remember', 'memu_private_update'] },
  })
  for (const needle of ['speaker_id', 'source_kind', 'absolute_date', 'conflicts_with', 'supersedes', 'commitment', 'assistant_said', '每窗最多新增 10 条']) {
    assert.ok(brief.includes(needle), `worker brief is missing ${needle}`)
  }
})
