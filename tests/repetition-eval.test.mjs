import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CATEGORIES,
  FIXTURE_DIR,
  NECESSARY_CATEGORIES,
  aggregateMetrics,
  evaluateDialogue,
  findRepeatedPhrases,
  loadDataset,
  maskForRepetition,
  runEvaluation,
  validateDialogueShape,
} from '../scripts/repetition-eval.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SCRIPT = path.join(ROOT, 'scripts', 'repetition-eval.mjs')
const BACKTICK = String.fromCharCode(96)

function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 30000,
  })
  if (result.error) throw result.error
  return result
}

function turnsWith(assistantTexts) {
  const turns = []
  for (const text of assistantTexts) {
    turns.push({ role: 'user', text: '继续' })
    turns.push({ role: 'assistant', text })
  }
  return turns
}

function makeDialogue(overrides = {}) {
  const defaults = {
    schemaVersion: 1,
    kind: 'repetition-eval-dialogue',
    draft: true,
    notGold: true,
    id: 'math-dialogue',
    pairId: 'math-pair',
    category: 'zh-rp',
    condition: 'baseline',
    window: 4,
    turns: turnsWith([
      '林眠轻轻叹了口气，说走吧。',
      '林眠轻轻叹了口气，说走吧。',
      '林眠抬头看天，没有说话。',
    ]),
    labels: { necessaryPhrases: [], facts: [] },
  }
  return validateDialogueShape({ ...defaults, ...overrides })
}

function fixture(category) {
  return loadDataset().dialogues.find(dialogue => dialogue.category === category)
}

test('synthetic fixture set is complete and marked not-gold', () => {
  const dataset = loadDataset()
  assert.equal(dataset.name, 'repetition-eval-synthetic')
  assert.equal(dataset.status, 'synthetic')
  assert.equal(dataset.draft, true)
  assert.equal(dataset.notGold, true)
  assert.equal(dataset.files.length, 6)
  assert.equal(dataset.dialogues.length, 6)
  assert.match(dataset.sha256, /^[a-f0-9]{64}$/)

  const turns = dataset.dialogues.flatMap(dialogue => dialogue.turns)
  assert.equal(turns.length, 36)
  assert.equal(turns.filter(turn => turn.role === 'assistant').length, 18)
  assert.deepEqual([...new Set(dataset.dialogues.map(dialogue => dialogue.category))].sort(), [...CATEGORIES].sort())
  assert.ok(dataset.dialogues.every(dialogue => dialogue.condition === 'baseline'))

  const labelCategories = new Set(
    dataset.dialogues.flatMap(dialogue => dialogue.labels.necessaryPhrases.map(label => label.category)),
  )
  for (const category of NECESSARY_CATEGORIES) assert.ok(labelCategories.has(category), category)
  assert.ok(dataset.dialogues.every(dialogue => dialogue.draft === true && dialogue.notGold === true))
})

test('aggregateMetrics uses explicit denominators and rounds consistently', () => {
  const metrics = aggregateMetrics([
    {
      eligibleTurns: 3,
      repeatedTurns: 2,
      repeatedPhraseEvents: 3,
      necessaryLabels: 4,
      necessaryRetained: 3,
      factsTotal: 2,
      factsComplete: 1,
      repetitionEvents: [{ phrase: 'a' }, { phrase: 'a' }, { phrase: 'b' }],
    },
    {
      eligibleTurns: 3,
      repeatedTurns: 1,
      repeatedPhraseEvents: 2,
      necessaryLabels: 0,
      necessaryRetained: 0,
      factsTotal: 2,
      factsComplete: 2,
      repetitionEvents: [{ phrase: 'b' }],
    },
  ])
  assert.equal(metrics.phraseRepetitionRate, 0.5)
  assert.equal(metrics.repeatedTurns, 3)
  assert.equal(metrics.eligibleTurns, 6)
  assert.equal(metrics.repeatedPhraseEvents, 5)
  assert.equal(metrics.distinctRepeatedPhrases, 2)
  assert.equal(metrics.necessaryRetentionRate, 0.75)
  assert.equal(metrics.factCompleteness, 0.75)
  assert.deepEqual(metrics.denominators, { eligibleTurns: 6, necessaryLabels: 4, factsTotal: 4 })

  const third = aggregateMetrics([
    {
      eligibleTurns: 3,
      repeatedTurns: 1,
      repeatedPhraseEvents: 1,
      necessaryLabels: 0,
      necessaryRetained: 0,
      factsTotal: 0,
      factsComplete: 0,
      repetitionEvents: [{ phrase: 'only' }],
    },
  ])
  assert.equal(third.phraseRepetitionRate, 0.333333)
  assert.equal(third.emptySet.necessaryRetentionRate, true)
  assert.equal(third.emptySet.factCompleteness, true)
})

test('empty denominators are zeros with emptySet flags, not perfect scores', () => {
  const empty = aggregateMetrics([])
  assert.equal(empty.phraseRepetitionRate, 0)
  assert.equal(empty.necessaryRetentionRate, 0)
  assert.equal(empty.factCompleteness, 0)
  assert.deepEqual(empty.emptySet, {
    phraseRepetitionRate: true,
    necessaryRetentionRate: true,
    factCompleteness: true,
  })
  assert.deepEqual(empty.denominators, { eligibleTurns: 0, necessaryLabels: 0, factsTotal: 0 })

  const onlyTurn = makeDialogue({
    id: 'empty-dialogue',
    turns: [{ role: 'user', text: '你好' }, { role: 'assistant', text: '你好。' }],
  })
  const evaluated = evaluateDialogue(onlyTurn)
  assert.equal(evaluated.eligibleTurns, 0)
  assert.equal(evaluated.phraseRepetitionRate, 0)
  assert.equal(evaluated.emptySet.phraseRepetitionRate, true)
  assert.equal(evaluated.emptySet.necessaryRetentionRate, true)
  assert.equal(evaluated.emptySet.factCompleteness, true)

  const report = runEvaluation()
  assert.equal(report.metrics.humanPreference.status, 'not-collected')
  assert.equal(report.metrics.humanPreference.preferenceRate, null)
  assert.equal(report.metrics.humanPreference.denominator, 0)
  assert.equal(report.metrics.humanPreference.emptySet, true)
})

test('evaluateDialogue computes the rate on the eligible assistant turns', () => {
  const dialogue = makeDialogue({
    id: 'math-rate-dialogue',
    labels: {
      necessaryPhrases: [
        { text: '林眠', category: 'name', turn: 1 },
        { text: '林眠', category: 'name', turn: 3 },
        { text: '林眠', category: 'name', turn: 5 },
      ],
      facts: [
        { id: 'math-fact-1', turn: 1, requiredTerms: ['走吧'] },
        { id: 'math-fact-2', turn: 3, requiredTerms: ['走吧'] },
        { id: 'math-fact-3', turn: 5, requiredTerms: ['抬头'] },
      ],
    },
  })
  const evaluated = evaluateDialogue(dialogue)
  assert.equal(evaluated.assistantTurns, 3)
  assert.equal(evaluated.eligibleTurns, 2)
  assert.equal(evaluated.repeatedTurns, 1)
  assert.equal(evaluated.phraseRepetitionRate, 0.5)
  assert.equal(evaluated.necessaryLabels, 3)
  assert.equal(evaluated.necessaryRetained, 3)
  assert.equal(evaluated.necessaryRetentionRate, 1)
  assert.equal(evaluated.necessaryByCategory.name.retained, 3)
  assert.equal(evaluated.factsTotal, 3)
  assert.equal(evaluated.factsComplete, 3)
  assert.ok(evaluated.repetitionEvents.length > 0)
  assert.ok(evaluated.repetitionEvents.every(event => event.turn > event.priorTurn))
  assert.ok(!evaluated.repetitionEvents.some(event => event.phrase.includes('林眠')))
})

test('necessary retention reports missing labels and facts', () => {
  const dialogue = makeDialogue({
    id: 'missing-label-dialogue',
    turns: turnsWith(['她轻轻点头。', '她轻轻点头。', '她抬头看天。']),
    labels: {
      necessaryPhrases: [{ text: '林眠', category: 'name', turn: 1 }],
      facts: [{ id: 'missing-fact', turn: 1, requiredTerms: ['铜钥匙'] }],
    },
  })
  const evaluated = evaluateDialogue(dialogue)
  assert.equal(evaluated.necessaryRetained, 0)
  assert.equal(evaluated.necessaryRetentionRate, 0)
  assert.equal(evaluated.necessaryByCategory.name.total, 1)
  assert.equal(evaluated.factsComplete, 0)
  assert.equal(evaluated.factCompleteness, 0)
  assert.deepEqual(evaluated.facts[0].missingTerms, ['铜钥匙'])
})

test('findRepeatedPhrases detects maximal CJK and Latin spans only', () => {
  const cjk = findRepeatedPhrases('林眠轻轻叹了口气，望着窗外。', ['林眠轻轻叹了口气，没有说话。'])
  assert.ok(cjk.length > 0)
  assert.ok(cjk.every(event => event.kind === 'cjk'))
  assert.ok(cjk.some(event => event.phrase.includes('轻轻叹了口气')))

  const latin = findRepeatedPhrases('The rain kept falling on the roof.', ['The rain kept falling on the glass.'])
  assert.ok(latin.length > 0)
  assert.ok(latin.every(event => event.kind === 'latin'))
  assert.ok(latin.some(event => event.phrase.toLowerCase().includes('rain kept falling')))

  assert.deepEqual(findRepeatedPhrases('完全不同的短句。', ['另一个短句。']), [])
})

test('code spans and code-like tokens are protected from prose matching', () => {
  const fenced = BACKTICK.repeat(3) + 'js\nconst value = parseConfig(raw)\n' + BACKTICK.repeat(3)
  const maskedFence = maskForRepetition(fenced)
  assert.deepEqual(findRepeatedPhrases(maskedFence, [maskedFence]), [])

  const inline = BACKTICK + 'parseConfig' + BACKTICK + ' ' + BACKTICK + 'config.port' + BACKTICK
  const maskedInline = maskForRepetition(inline)
  assert.deepEqual(findRepeatedPhrases(maskedInline, [maskedInline]), [])

  assert.deepEqual(
    findRepeatedPhrases('Call parseConfig and sessionId now.', ['Call parseConfig and sessionId later.']),
    [],
  )

  const maskedNecessary = maskForRepetition('林眠把铜钥匙放在桌角。', ['铜钥匙'])
  assert.ok(!maskedNecessary.includes('铜钥匙'))
  assert.ok(maskedNecessary.includes('林眠'))
})

test('English and code fixtures do not flag names, quotes, or identifiers', () => {
  const english = evaluateDialogue(fixture('en'))
  assert.equal(english.phraseRepetitionRate, 0.5)
  assert.equal(english.necessaryRetentionRate, 1)
  assert.equal(english.factsTotal, 3)
  assert.equal(english.factCompleteness, 1)
  assert.ok(english.repetitionEvents.some(event => event.phrase.toLowerCase().includes('rain kept falling')))
  assert.ok(english.repetitionEvents.every(event => !/Mara|lighthouse|blue door/i.test(event.phrase)))

  const code = evaluateDialogue(fixture('code'))
  assert.equal(code.phraseRepetitionRate, 1)
  assert.equal(code.necessaryRetentionRate, 1)
  assert.equal(code.factsTotal, 3)
  assert.equal(code.factCompleteness, 1)
  assert.ok(code.repetitionEvents.some(event => event.phrase === 'As you can see'))
  assert.ok(code.repetitionEvents.every(event => !/parseConfig|ReadOnlyMap|config\.port/.test(event.phrase)))
})

test('user quotes and agreements are retained and not counted as repetition', () => {
  const quote = evaluateDialogue(fixture('user-quote'))
  assert.equal(quote.necessaryRetentionRate, 1)
  assert.equal(quote.factCompleteness, 1)
  assert.ok(quote.repetitionEvents.every(event => !event.phrase.includes('把灯留着，别关')))

  const agreement = evaluateDialogue(fixture('agreement'))
  assert.equal(agreement.necessaryRetentionRate, 1)
  assert.equal(agreement.factCompleteness, 1)
  assert.ok(agreement.repetitionEvents.every(event => !event.phrase.includes('每周三晚上一起复盘，不改时间')))
  assert.ok(agreement.repetitionEvents.some(event => event.phrase.includes('这一点很重要')))
})

test('window only looks back N assistant turns', () => {
  const texts = ['这是第一句套话内容。', '完全不同的第二句内容。', '这是第一句套话内容。']
  const narrow = evaluateDialogue(makeDialogue({ id: 'window-one', window: 1, turns: turnsWith(texts) }))
  assert.equal(narrow.eligibleTurns, 2)
  assert.equal(narrow.repeatedTurns, 0)

  const wide = evaluateDialogue(makeDialogue({ id: 'window-two', window: 2, turns: turnsWith(texts) }))
  assert.equal(wide.eligibleTurns, 2)
  assert.equal(wide.repeatedTurns, 1)
})

test('fixture validation rejects non-synthetic and unknown labels', () => {
  assert.throws(() => validateDialogueShape({ ...makeDialogue(), notGold: false }), /notGold/)
  assert.throws(
    () => validateDialogueShape({
      ...makeDialogue(),
      labels: {
        necessaryPhrases: [{ text: '某物', category: 'unknown', turn: 1 }],
        facts: [],
      },
    }),
    /unknown necessary category/,
  )
})

test('CLI exposes help, default JSON, --out, and documented exit codes', (t) => {
  const help = runCli(['--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Usage: node scripts\/repetition-eval\.mjs/)

  const defaultRun = runCli([])
  assert.equal(defaultRun.status, 0)
  const defaultReport = JSON.parse(defaultRun.stdout)
  assert.equal(defaultReport.ok, true)
  assert.equal(defaultReport.status, 'synthetic-baseline-not-validated')
  assert.equal(defaultReport.metrics.denominators.eligibleTurns, 12)
  assert.equal(defaultReport.metrics.denominators.necessaryLabels, 32)
  assert.equal(defaultReport.metrics.denominators.factsTotal, 17)

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repetition-eval-test-'))
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  const outFile = path.join(tempDir, 'report.json')
  const outRun = runCli(['--fixture-dir', FIXTURE_DIR, '--out', outFile])
  assert.equal(outRun.status, 0)
  assert.match(outRun.stdout, /wrote/)
  const body = fs.readFileSync(outFile, 'utf8')
  assert.ok(body.includes('\r\n'))
  assert.ok(!/(?<!\r)\n/.test(body))
  const outReport = JSON.parse(body)
  assert.equal(outReport.ok, true)
  assert.equal(outReport.dataset.sha256, defaultReport.dataset.sha256)
  assert.equal(outReport.metrics.phraseRepetitionRate, 0.75)
})

test('CLI returns 2 for usage errors and 1 for fixture errors', (t) => {
  const unknown = runCli(['--unknown'])
  assert.equal(unknown.status, 2)
  assert.equal(JSON.parse(unknown.stderr).ok, false)

  const missing = runCli(['--fixture-dir', path.join(os.tmpdir(), 'repetition-eval-missing-dir')])
  assert.equal(missing.status, 1)
  assert.equal(JSON.parse(missing.stderr).ok, false)

  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repetition-eval-bad-'))
  t.after(() => fs.rmSync(badDir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(badDir, 'bad.json'), '{')
  const bad = runCli(['--fixture-dir', badDir])
  assert.equal(bad.status, 1)
  assert.equal(JSON.parse(bad.stderr).ok, false)
})

test('runEvaluation and CLI output are deterministic', () => {
  const first = runEvaluation()
  const second = runEvaluation()
  assert.deepEqual(first, second)
  assert.match(first.dataset.sha256, /^[a-f0-9]{64}$/)
  assert.equal(first.metrics.phraseRepetitionRate, 0.75)
  assert.equal(first.metrics.necessaryRetentionRate, 1)
  assert.equal(first.metrics.factCompleteness, 1)

  const runA = runCli([])
  const runB = runCli([])
  assert.equal(runA.status, 0)
  assert.equal(runB.status, 0)
  assert.equal(runA.stdout, runB.stdout)
})
