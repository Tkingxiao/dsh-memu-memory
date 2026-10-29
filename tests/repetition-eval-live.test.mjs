import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const live = await import('../scripts/repetition-eval-live.mjs')
const base = await import('../scripts/repetition-eval.mjs')
const snapshot = await import('../scripts/repetition-detector-snapshot.mjs')
const scenarios = await import('../scripts/repetition-ab-scenarios.mjs')
const fixtures = base.loadDataset()
const roots = []

test.after(() => {
  for (const root of roots.splice(0)) {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  }
})

function freshRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-repetition-live-'))
  roots.push(root)
  return root
}

function fixture(id) {
  return fixtures.dialogues.find(dialogue => dialogue.id === id)
}

test('buildRepetitionHint uses the frozen evaluation snapshot without fixture-label filtering', () => {
  const dialogue = fixture('zh-rp-baseline')
  const assistantTexts = dialogue.turns.filter(turn => turn.role === 'assistant').map(turn => turn.text)
  const hint = live.buildRepetitionHint(assistantTexts, dialogue.labels)
  assert.match(hint, /<repetition-hint>/)
  assert.match(hint, /轻轻叹了口气/)
  // The frozen snapshot has no gold labels at runtime. The A/B scorer, not
  // the detector, measures whether necessary names/facts were harmed.
  assert.equal(typeof hint, 'string')
  assert.equal(hint, snapshot.buildRepetitionHint({ assistantTexts }))
  assert.equal(hint, live.buildRepetitionHint(assistantTexts, { necessaryPhrases: [], facts: [] }))
  assert.equal(live.buildRepetitionHint(['only one'], dialogue.labels), '')
})

test('generateSample uses the original prefix and adds a hint only in the candidate condition', async () => {
  const dialogue = fixture('zh-rp-baseline')
  const calls = []
  const fakeChat = async ({ messages }) => {
    calls.push(messages)
    return '林眠轻轻叹了口气，看着窗外的雨。'
  }
  const candidate = await live.generateSample({
    fixture: dialogue,
    condition: 'candidate',
    chat: fakeChat,
    config: { ready: true, model: 'fake', baseUrl: 'http://127.0.0.1' },
  })
  assert.equal(candidate.kind, 'repetition-eval-live-sample')
  assert.equal(candidate.condition, 'candidate')
  assert.equal(candidate.prefixTurns.filter(turn => turn.role === 'user').length, 3)
  assert.equal(candidate.prefixTurns.filter(turn => turn.role === 'assistant').length, 2)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].some(message => message.role === 'assistant' && message.content.includes('桌角')))
  assert.ok(calls[0].some(message => message.role === 'user'
    && message.source?.kind === 'plugin:dsh-memu-memory'
    && message.content?.[0]?.text?.includes('<repetition-hint>')))
  assert.equal(candidate.hintApplied, true)
  const pluginIndex = calls[0].findIndex(message => message.source?.kind === 'plugin:dsh-memu-memory')
  assert.equal(pluginIndex, calls[0].length - 2)
  assert.equal(calls[0].filter(message => message.role === 'system').length, 1)
  assert.doesNotMatch(String(calls[0].find(message => message.role === 'system').content), /character names|user quotes|agreements|established facts/i)

  calls.length = 0
  const baseline = await live.generateSample({
    fixture: dialogue,
    condition: 'baseline',
    chat: fakeChat,
    config: { ready: true, model: 'fake', baseUrl: 'http://127.0.0.1' },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].some(message => message.source?.kind === 'plugin:dsh-memu-memory'), false)
  assert.equal(baseline.hintApplied, false)
})

test('only labels for the generated target are scored, not every earlier answer', async () => {
  const dialogue = fixture('agreement-baseline')
  const target = live.targetAssistantIndex(dialogue)
  const sample = await live.generateSample({
    fixture: dialogue, condition: 'baseline',
    chat: async () => dialogue.turns[target].text,
  })
  assert.equal(sample.labels.facts.length, 1)
  assert.equal(sample.evaluation.factCompleteness, 1)
  assert.equal(sample.evaluation.necessaryRetentionRate, 1)
})

test('the A/B pack contains twenty unique scenarios and self-consistent target labels', () => {
  const dataset = scenarios.loadAbDataset()
  const ab = dataset.dialogues.filter(dialogue => dialogue.id.startsWith('ab-'))
  assert.equal(ab.length, 14)
  assert.equal(new Set(ab.map(dialogue => dialogue.pairId)).size, 14)
  for (const dialogue of ab) {
    base.validateDialogueShape(dialogue)
    const target = live.targetAssistantIndex(dialogue)
    const evaluation = base.evaluateAssistantTurn({
      text: dialogue.turns[target].text,
      priorAssistantTexts: [],
      labels: {
        necessaryPhrases: dialogue.labels.necessaryPhrases.filter(label => label.turn === target),
        facts: dialogue.labels.facts.filter(label => label.turn === target),
      },
    })
    assert.equal(evaluation.factsTotal === 0 || evaluation.factCompleteness === 1, true, dialogue.id)
    assert.equal(evaluation.necessaryRetentionRate, 1, dialogue.id)
  }
})

test('twenty scenarios and three repeats use exactly 120 calls with paired outputs', async () => {
  let calls = 0
  const report = await live.runLivePilot({
    ab: true, repeats: 3, concurrency: 4, outDir: freshRoot(),
    config: { ready: true, model: 'fake', baseUrl: 'https://example.test' },
    chat: async () => { calls += 1; return '这是一条合成测试输出。' },
  })
  assert.equal(calls, 120)
  assert.equal(report.config.attempts, 120)
  assert.equal(report.config.automaticRetries, 0)
  assert.equal(report.failures.length, 0)
  assert.equal(report.dialogues.length, 120)
})

test('an over-budget plan is rejected before any generation call', async () => {
  let calls = 0
  await assert.rejects(() => live.runLivePilot({
    ab: true, repeats: 4, outDir: freshRoot(),
    config: { ready: true },
    chat: async () => { calls += 1; return 'not reached' },
  }), /120-attempt limit/)
  assert.equal(calls, 0)
})

test('a failed provider is not retried and details or credentials are not reported', async () => {
  let calls = 0
  const report = await live.runLivePilot({
    outDir: freshRoot(), config: { ready: true, model: 'fake', baseUrl: 'https://example.test', apiKey: 'unit-secret' },
    chat: async () => { calls += 1; throw new Error('unit-secret provider-body') },
  })
  assert.equal(calls, 4)
  assert.equal(report.ok, false)
  assert.equal(report.config.stoppedEarly, true)
  assert.equal(report.failures.length, 4)
  assert.equal(JSON.stringify(report).includes('unit-secret'), false)
  assert.equal(JSON.stringify(report).includes('provider-body'), false)
})

test('runLivePilot writes twelve samples and reports both conditions without claiming gold', async () => {
  const outDir = freshRoot()
  const report = await live.runLivePilot({
    outDir,
    config: { ready: true, model: 'fake-model', baseUrl: 'http://127.0.0.1', apiKey: 'not-used' },
    chat: async () => '我会继续，但不会重复刚才的套话。',
  })
  assert.equal(report.status, 'live-pilot-not-validated')
  assert.equal(report.draft, true)
  assert.equal(report.notGold, true)
  assert.equal(report.dataset.dialogueCount, 12)
  assert.equal(report.dataset.fileCount, 12)
  assert.equal(report.dialogues.length, 12)
  assert.equal(report.metrics.byCondition.baseline.emptySet.phraseRepetitionRate, false)
  assert.equal(report.metrics.byCondition.candidate.emptySet.phraseRepetitionRate, false)
  assert.equal(report.metrics.humanPreference.status, 'not-collected')
  assert.ok(fs.existsSync(path.join(outDir, 'report.json')))
  assert.equal(fs.readdirSync(outDir).filter(name => name.endsWith('.json')).length, 13)
  assert.match(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8'), /\r\n/)
  const sample = JSON.parse(fs.readFileSync(path.join(outDir, '1-zh-rp-baseline-live-candidate.json'), 'utf8'))
  assert.equal(sample.kind, 'repetition-eval-live-sample')
  assert.equal(sample.prefixTurns.length, 5)
})
