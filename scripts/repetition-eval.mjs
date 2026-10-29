#!/usr/bin/env node
/**
 * Synthetic assistant-repetition evaluation harness (W8 first step).
 *
 * Reads handwritten synthetic dialogue fixtures and computes rule-checkable
 * baseline metrics. It never calls a model, uses the network, or reads a real
 * user conversation. The output is evidence about the fixtures and metric
 * definitions, not about production model behaviour.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'repetition-eval')
export const CATEGORIES = Object.freeze(['zh-rp', 'en', 'code', 'names', 'user-quote', 'agreement'])
export const CONDITIONS = Object.freeze(['baseline', 'candidate'])
export const NECESSARY_CATEGORIES = Object.freeze(['name', 'agreement', 'user-quote', 'fact', 'code-identifier'])
export const CONFIG = Object.freeze({
  schemaVersion: 1,
  window: 4,
  cjkNgram: 4,
  latinNgram: 3,
  maxWindow: 10,
})

const BACKTICK = String.fromCharCode(96)
const CODE_FENCE = new RegExp(BACKTICK + BACKTICK + BACKTICK + '[\\s\\S]*?' + BACKTICK + BACKTICK + BACKTICK, 'g')
const INLINE_CODE = new RegExp(BACKTICK + '[^' + BACKTICK + '\\r\\n]*' + BACKTICK, 'g')
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu
const LATIN_WORD_RE = /[A-Za-z][A-Za-z0-9_'\u2019-]*/g
const STOPWORDS = new Set('a an and are as at be but by for from had has have he her his i if in is it its me my not of on or our she so that the their them there they this to was we were what when where which who why will with you your'.split(' '))

function fixtureError(message) {
  throw new Error('repetition-eval fixture: ' + message)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertString(value, field, where, options = {}) {
  const nonEmpty = options.nonEmpty !== false
  if (typeof value !== 'string' || (nonEmpty && !value.trim())) {
    fixtureError(where + ': ' + field + ' must be a non-empty string')
  }
  return value
}

function assertStringArray(value, field, where, options = {}) {
  const allowEmpty = options.allowEmpty !== false
  if (!Array.isArray(value)) fixtureError(where + ': ' + field + ' must be an array')
  if (!allowEmpty && value.length === 0) fixtureError(where + ': ' + field + ' must not be empty')
  if (value.some(item => typeof item !== 'string' || !item.trim())) fixtureError(where + ': ' + field + ' must contain non-empty strings')
  if (new Set(value).size !== value.length) fixtureError(where + ': ' + field + ' contains duplicates')
  return value
}

function assertAssistantTurn(turn, field, where, turns) {
  if (!Number.isInteger(turn) || turn < 0 || turn >= turns.length) fixtureError(where + ': ' + field + ' must be an index into turns')
  if (turns[turn].role !== 'assistant') fixtureError(where + ': ' + field + ' must point at an assistant turn')
}

/** Validate one synthetic dialogue. Strict so a typo fails rather than changing a denominator. */
export function validateDialogueShape(dialogue, where = 'dialogue') {
  if (!isPlainObject(dialogue)) fixtureError(where + ': dialogue must be an object')
  if (dialogue.schemaVersion !== CONFIG.schemaVersion) fixtureError(where + ': schemaVersion must be ' + CONFIG.schemaVersion)
  if (dialogue.kind !== 'repetition-eval-dialogue') fixtureError(where + ': kind must be repetition-eval-dialogue')
  assertString(dialogue.id, 'id', where)
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(dialogue.id)) fixtureError(where + ': invalid id ' + dialogue.id)
  assertString(dialogue.pairId, 'pairId', where)
  if (!CATEGORIES.includes(dialogue.category)) fixtureError(where + ': unknown category ' + dialogue.category)
  if (!CONDITIONS.includes(dialogue.condition)) fixtureError(where + ': unknown condition ' + dialogue.condition)
  if (dialogue.draft !== true) fixtureError(where + ': draft must be true')
  if (dialogue.notGold !== true) fixtureError(where + ': notGold must be true (synthetic samples are not a gold set)')
  if (dialogue.window !== undefined && (!Number.isInteger(dialogue.window) || dialogue.window < 1 || dialogue.window > CONFIG.maxWindow)) {
    fixtureError(where + ': window must be an integer 1..' + CONFIG.maxWindow)
  }

  if (!Array.isArray(dialogue.turns) || dialogue.turns.length < 2) fixtureError(where + ': turns must contain at least two entries')
  let users = 0
  let assistants = 0
  for (let index = 0; index < dialogue.turns.length; index += 1) {
    const turn = dialogue.turns[index]
    const turnWhere = where + ' turns[' + index + ']'
    if (!isPlainObject(turn)) fixtureError(turnWhere + ': turn must be an object')
    if (turn.role !== 'user' && turn.role !== 'assistant') fixtureError(turnWhere + ': role must be user or assistant')
    assertString(turn.text, 'text', turnWhere)
    if (turn.role === 'user') users += 1
    else assistants += 1
  }
  if (users === 0 || assistants === 0) fixtureError(where + ': dialogue needs at least one user and one assistant turn')

  if (!isPlainObject(dialogue.labels)) fixtureError(where + ': labels must be an object')
  if (!Array.isArray(dialogue.labels.necessaryPhrases)) fixtureError(where + ': labels.necessaryPhrases must be an array')
  if (!Array.isArray(dialogue.labels.facts)) fixtureError(where + ': labels.facts must be an array')

  const phraseKeys = new Set()
  for (let index = 0; index < dialogue.labels.necessaryPhrases.length; index += 1) {
    const label = dialogue.labels.necessaryPhrases[index]
    const labelWhere = where + ' labels.necessaryPhrases[' + index + ']'
    if (!isPlainObject(label)) fixtureError(labelWhere + ': label must be an object')
    assertString(label.text, 'text', labelWhere)
    if (!NECESSARY_CATEGORIES.includes(label.category)) fixtureError(labelWhere + ': unknown necessary category ' + label.category)
    assertAssistantTurn(label.turn, 'turn', labelWhere, dialogue.turns)
    const key = label.turn + '|' + label.text
    if (phraseKeys.has(key)) fixtureError(labelWhere + ': duplicate necessary phrase for the same turn')
    phraseKeys.add(key)
  }

  const factIds = new Set()
  for (let index = 0; index < dialogue.labels.facts.length; index += 1) {
    const fact = dialogue.labels.facts[index]
    const factWhere = where + ' labels.facts[' + index + ']'
    if (!isPlainObject(fact)) fixtureError(factWhere + ': fact must be an object')
    assertString(fact.id, 'id', factWhere)
    if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(fact.id)) fixtureError(factWhere + ': invalid fact id ' + fact.id)
    if (factIds.has(fact.id)) fixtureError(factWhere + ': duplicate fact id ' + fact.id)
    factIds.add(fact.id)
    assertAssistantTurn(fact.turn, 'turn', factWhere, dialogue.turns)
    assertStringArray(fact.requiredTerms, 'requiredTerms', factWhere, { allowEmpty: false })
  }
  return dialogue
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/** Load every .json fixture in sorted filename order and hash the exact input set. */
export function loadDataset(fixtureDir = FIXTURE_DIR) {
  const dir = path.resolve(fixtureDir)
  let names
  try {
    names = fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort()
  } catch (error) {
    fixtureError('cannot read fixture directory ' + dir + ': ' + (error && error.message ? error.message : error))
  }
  if (names.length === 0) fixtureError('no .json fixtures in ' + dir)

  const files = []
  const dialogues = []
  const ids = new Set()
  const pairConditions = new Set()
  for (const fileName of names) {
    const filePath = path.join(dir, fileName)
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch (error) {
      fixtureError(fileName + ': invalid JSON: ' + (error && error.message ? error.message : error))
    }
    validateDialogueShape(raw, fileName)
    if (ids.has(raw.id)) fixtureError('duplicate dialogue id ' + raw.id)
    ids.add(raw.id)
    const pairKey = raw.pairId + '|' + raw.condition
    if (pairConditions.has(pairKey)) fixtureError('duplicate pairId+condition ' + pairKey)
    pairConditions.add(pairKey)
    dialogues.push(raw)
    files.push({ name: fileName, sha256: sha256(fs.readFileSync(filePath)) })
  }

  if (dialogues.length < 6) fixtureError('expected at least 6 synthetic dialogues, found ' + dialogues.length)
  for (const category of CATEGORIES) {
    if (!dialogues.some(dialogue => dialogue.category === category)) fixtureError('missing category ' + category)
  }
  if (!dialogues.some(dialogue => dialogue.condition === 'baseline')) fixtureError('at least one baseline dialogue is required')

  const digest = crypto.createHash('sha256')
  for (const file of files) {
    digest.update(file.name)
    digest.update('\0')
    digest.update(file.sha256)
    digest.update('\0')
  }
  return {
    name: 'repetition-eval-synthetic',
    status: 'synthetic',
    draft: true,
    notGold: true,
    dir,
    files,
    sha256: digest.digest('hex'),
    dialogues,
  }
}

function round(value, digits = 6) {
  const factor = 10 ** digits
  const rounded = Math.round((Number(value) + Number.EPSILON) * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : round(numerator / denominator)
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/[{}]/g, '\\$&')
}

function maskSpan(match) {
  return ' '.repeat(match.length)
}

/**
 * Remove code spans and protected phrases before lexical repetition matching.
 * Protected phrases are necessary phrases plus fact terms: repeating a name,
 * a user quote, an agreed convention or a fact is not a repetition defect.
 */
export function maskForRepetition(text, protectedPhrases = []) {
  let masked = String(text || '')
  masked = masked.replace(CODE_FENCE, maskSpan)
  masked = masked.replace(INLINE_CODE, maskSpan)
  const phrases = [...new Set(protectedPhrases.filter(phrase => typeof phrase === 'string' && phrase.trim()))]
    .sort((a, b) => b.length - a.length)
  for (const phrase of phrases) {
    masked = masked.replace(new RegExp(escapeRegExp(phrase), 'gi'), maskSpan)
  }
  return masked
}

function cjkRuns(text) {
  const runs = []
  for (const match of text.matchAll(CJK_RE)) runs.push({ text: match[0], index: match.index })
  return runs
}

function isCodeLikeToken(raw) {
  return /[a-z][A-Z]/.test(raw) || raw.includes('_') || /\d/.test(raw)
}

function latinTokens(text) {
  const tokens = []
  for (const match of String(text || '').matchAll(LATIN_WORD_RE)) {
    const raw = match[0]
    if (isCodeLikeToken(raw)) continue
    tokens.push({ raw, norm: raw.toLowerCase(), index: match.index })
  }
  return tokens
}

function allStopwords(tokens) {
  return tokens.every(token => STOPWORDS.has(token.norm))
}

function paddedLatinTokens(text) {
  return ' ' + latinTokens(text).map(token => token.norm).join(' ') + ' '
}

function priorContainsPhrase(priorText, phrase, kind) {
  if (kind === 'cjk') return priorText.includes(phrase)
  return paddedLatinTokens(priorText).includes(' ' + latinTokens(phrase).map(token => token.norm).join(' ') + ' ')
}

/**
 * Find maximal non-overlapping repeated spans in the current masked text.
 * CJK spans are character n-grams (minimum 4); Latin spans are word n-grams
 * (minimum 3). Stopword-only Latin spans and code-like tokens are ignored.
 */
export function findRepeatedPhrases(text, priorTexts, options = {}) {
  const cjkNgram = Number(options.cjkNgram || CONFIG.cjkNgram)
  const latinNgram = Number(options.latinNgram || CONFIG.latinNgram)
  const prior = priorTexts.map(value => String(value || ''))
  const events = []

  for (const run of cjkRuns(String(text || ''))) {
    let index = 0
    while (index + cjkNgram <= run.text.length) {
      const seed = run.text.slice(index, index + cjkNgram)
      if (!prior.some(value => value.includes(seed))) {
        index += 1
        continue
      }
      let end = index + cjkNgram
      while (end < run.text.length && prior.some(value => value.includes(run.text.slice(index, end + 1)))) {
        end += 1
      }
      events.push({ phrase: run.text.slice(index, end), kind: 'cjk' })
      index = end
    }
  }

  const tokens = latinTokens(text)
  const priorPadded = prior.map(paddedLatinTokens)
  let index = 0
  while (index + latinNgram <= tokens.length) {
    const seedTokens = tokens.slice(index, index + latinNgram)
    if (allStopwords(seedTokens)) {
      index += 1
      continue
    }
    const seed = seedTokens.map(token => token.norm).join(' ')
    if (!priorPadded.some(value => value.includes(' ' + seed + ' '))) {
      index += 1
      continue
    }
    let end = index + latinNgram
    while (end < tokens.length) {
      const candidate = tokens.slice(index, end + 1).map(token => token.norm).join(' ')
      if (!priorPadded.some(value => value.includes(' ' + candidate + ' '))) break
      end += 1
    }
    const trimmed = trimLatinArticleEdges(tokens.slice(index, end), latinNgram)
    if (trimmed) events.push({ phrase: trimmed.map(token => token.raw).join(' '), kind: 'latin' })
    index = end
  }
  return events
}

const LATIN_EDGE_ARTICLES = new Set(['a', 'an', 'the'])

function trimLatinArticleEdges(tokens, minimum) {
  let start = 0
  let end = tokens.length
  while (start < end && LATIN_EDGE_ARTICLES.has(tokens[start].norm)) start += 1
  while (end > start && LATIN_EDGE_ARTICLES.has(tokens[end - 1].norm)) end -= 1
  if (end - start < minimum) return tokens
  return tokens.slice(start, end)
}

function findPriorTurn(maskedTexts, priorIndices, phrase, kind) {
  for (let index = priorIndices.length - 1; index >= 0; index -= 1) {
    const turn = priorIndices[index]
    if (priorContainsPhrase(maskedTexts[turn], phrase, kind)) return turn
  }
  return null
}

function normalizeProse(text) {
  return String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

function normalizeCode(text) {
  return String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function labelPresent(turnText, phrase, category) {
  const haystack = category === 'code-identifier' ? normalizeCode(turnText) : normalizeProse(turnText)
  const needle = category === 'code-identifier' ? normalizeCode(phrase) : normalizeProse(phrase)
  return needle.length > 0 && haystack.includes(needle)
}

function termPresent(turnText, term) {
  const haystack = normalizeProse(turnText)
  const needle = normalizeProse(term)
  return needle.length > 0 && haystack.includes(needle)
}

function effectiveWindow(dialogue, options) {
  const requested = dialogue.window !== undefined ? dialogue.window : options.window
  const value = requested === undefined ? CONFIG.window : Number(requested)
  if (!Number.isInteger(value) || value < 1 || value > CONFIG.maxWindow) return CONFIG.window
  return value
}

/**
 * Evaluate one generated assistant turn against earlier assistant texts.
 * This is for live continuation pilots where the prefix is supplied by the
 * fixture and only the final assistant turn is generated. It applies the same
 * exact-match rules as evaluateDialogue, but does not pretend the prefix is
 * generated output.
 */
export function evaluateAssistantTurn({ id = 'assistant-turn', category = '', condition = '', text = '', priorAssistantTexts = [], labels = {}, window = CONFIG.window } = {}) {
  const necessaryPhrases = labels.necessaryPhrases || []
  const facts = labels.facts || []
  const protectedPhrases = necessaryPhrases.map(label => label.text)
  const effectiveWindowValue = Number.isInteger(Number(window)) && Number(window) >= 1 && Number(window) <= CONFIG.maxWindow ? Number(window) : CONFIG.window
  const maskedText = maskForRepetition(text, protectedPhrases)
  const maskedPrior = priorAssistantTexts.slice(-effectiveWindowValue).map(item => maskForRepetition(item, protectedPhrases))
  const events = maskedPrior.length === 0 ? [] : findRepeatedPhrases(maskedText, maskedPrior)

  const necessaryByCategory = {}
  let necessaryRetained = 0
  for (const label of necessaryPhrases) {
    const bucket = necessaryByCategory[label.category] || { retained: 0, total: 0 }
    bucket.total += 1
    if (labelPresent(text, label.text, label.category)) {
      bucket.retained += 1
      necessaryRetained += 1
    }
    necessaryByCategory[label.category] = bucket
  }
  for (const bucket of Object.values(necessaryByCategory)) bucket.rate = ratio(bucket.retained, bucket.total)

  const factItems = facts.map(fact => {
    const missingTerms = fact.requiredTerms.filter(term => !termPresent(text, term))
    return { id: fact.id, turn: fact.turn, complete: missingTerms.length === 0, missingTerms }
  })
  const factsComplete = factItems.filter(item => item.complete).length
  const factsTotal = factItems.length

  return {
    id,
    category,
    condition,
    window: effectiveWindowValue,
    turns: 1,
    assistantTurns: 1,
    eligibleTurns: maskedPrior.length === 0 ? 0 : 1,
    repeatedTurns: events.length === 0 ? 0 : 1,
    phraseRepetitionRate: ratio(events.length === 0 ? 0 : 1, maskedPrior.length === 0 ? 0 : 1),
    repeatedPhraseEvents: events.length,
    distinctRepeatedPhrases: new Set(events.map(event => event.phrase)).size,
    repetitionEvents: events,
    necessaryRetentionRate: ratio(necessaryRetained, necessaryPhrases.length),
    necessaryRetained,
    necessaryLabels: necessaryPhrases.length,
    necessaryByCategory,
    factCompleteness: ratio(factsComplete, factsTotal),
    factsComplete,
    factsTotal,
    facts: factItems,
    emptySet: {
      phraseRepetitionRate: maskedPrior.length === 0,
      necessaryRetentionRate: necessaryPhrases.length === 0,
      factCompleteness: factsTotal === 0,
    },
  }
}

/**
 * Evaluate one dialogue. Label turns are absolute indexes into turns[].
 * phraseRepetitionRate denominator = assistant turns with at least one earlier
 * assistant turn in the window; the first assistant turn is not eligible.
 */
export function evaluateDialogue(dialogue, options = {}) {
  const turns = dialogue.turns
  const window = effectiveWindow(dialogue, options)
  const necessaryPhrases = dialogue.labels.necessaryPhrases
  const facts = dialogue.labels.facts
  // Only labeled necessary phrases are masked. Fact requiredTerms are
  // completeness anchors, not automatically exempt phrases: masking a single
  // keyword such as "rain" would punch holes in the repetition matcher.
  const protectedPhrases = necessaryPhrases.map(label => label.text)
  const masked = turns.map(turn => maskForRepetition(turn.text, protectedPhrases))
  const assistantIndices = []
  for (let index = 0; index < turns.length; index += 1) {
    if (turns[index].role === 'assistant') assistantIndices.push(index)
  }

  const events = []
  let eligibleTurns = 0
  let repeatedTurns = 0
  for (const index of assistantIndices) {
    const prior = assistantIndices.filter(candidate => candidate < index).slice(-window)
    if (prior.length === 0) continue
    eligibleTurns += 1
    const repeated = findRepeatedPhrases(masked[index], prior.map(candidate => masked[candidate]))
    if (repeated.length === 0) continue
    repeatedTurns += 1
    for (const item of repeated) {
      events.push({
        turn: index,
        priorTurn: findPriorTurn(masked, prior, item.phrase, item.kind),
        phrase: item.phrase,
        kind: item.kind,
      })
    }
  }

  const necessaryByCategory = {}
  let necessaryRetained = 0
  for (const label of necessaryPhrases) {
    const bucket = necessaryByCategory[label.category] || { retained: 0, total: 0 }
    bucket.total += 1
    if (labelPresent(turns[label.turn].text, label.text, label.category)) {
      bucket.retained += 1
      necessaryRetained += 1
    }
    necessaryByCategory[label.category] = bucket
  }
  for (const bucket of Object.values(necessaryByCategory)) bucket.rate = ratio(bucket.retained, bucket.total)
  const necessaryTotal = necessaryPhrases.length

  const factItems = facts.map(fact => {
    const missingTerms = fact.requiredTerms.filter(term => !termPresent(turns[fact.turn].text, term))
    return { id: fact.id, turn: fact.turn, complete: missingTerms.length === 0, missingTerms }
  })
  const factsComplete = factItems.filter(item => item.complete).length
  const factsTotal = factItems.length

  return {
    id: dialogue.id,
    pairId: dialogue.pairId,
    category: dialogue.category,
    condition: dialogue.condition,
    window,
    turns: turns.length,
    assistantTurns: assistantIndices.length,
    eligibleTurns,
    repeatedTurns,
    phraseRepetitionRate: ratio(repeatedTurns, eligibleTurns),
    repeatedPhraseEvents: events.length,
    distinctRepeatedPhrases: new Set(events.map(event => event.phrase)).size,
    repetitionEvents: events,
    necessaryRetentionRate: ratio(necessaryRetained, necessaryTotal),
    necessaryRetained,
    necessaryLabels: necessaryTotal,
    necessaryByCategory,
    factCompleteness: ratio(factsComplete, factsTotal),
    factsComplete,
    factsTotal,
    facts: factItems,
    emptySet: {
      phraseRepetitionRate: eligibleTurns === 0,
      necessaryRetentionRate: necessaryTotal === 0,
      factCompleteness: factsTotal === 0,
    },
  }
}

/** Aggregate already-evaluated dialogues with explicit denominators. */
export function aggregateMetrics(evaluations) {
  let eligibleTurns = 0
  let repeatedTurns = 0
  let repeatedPhraseEvents = 0
  let necessaryLabels = 0
  let necessaryRetained = 0
  let factsTotal = 0
  let factsComplete = 0
  const distinctPhrases = new Set()
  for (const evaluation of evaluations) {
    eligibleTurns += evaluation.eligibleTurns
    repeatedTurns += evaluation.repeatedTurns
    repeatedPhraseEvents += evaluation.repeatedPhraseEvents
    necessaryLabels += evaluation.necessaryLabels
    necessaryRetained += evaluation.necessaryRetained
    factsTotal += evaluation.factsTotal
    factsComplete += evaluation.factsComplete
    for (const event of evaluation.repetitionEvents) distinctPhrases.add(event.phrase)
  }
  return {
    phraseRepetitionRate: ratio(repeatedTurns, eligibleTurns),
    repeatedTurns,
    eligibleTurns,
    repeatedPhraseEvents,
    distinctRepeatedPhrases: distinctPhrases.size,
    necessaryRetentionRate: ratio(necessaryRetained, necessaryLabels),
    necessaryRetained,
    necessaryLabels,
    factCompleteness: ratio(factsComplete, factsTotal),
    factsComplete,
    factsTotal,
    emptySet: {
      phraseRepetitionRate: eligibleTurns === 0,
      necessaryRetentionRate: necessaryLabels === 0,
      factCompleteness: factsTotal === 0,
    },
    denominators: { eligibleTurns, necessaryLabels, factsTotal },
  }
}

function groupEvaluations(evaluations, key, order) {
  const groups = new Map()
  for (const evaluation of evaluations) {
    const value = evaluation[key]
    if (!groups.has(value)) groups.set(value, [])
    groups.get(value).push(evaluation)
  }
  const result = {}
  for (const value of order) {
    if (groups.has(value)) result[value] = aggregateMetrics(groups.get(value))
  }
  return result
}

function datasetSummary(dataset) {
  let turnCount = 0
  let assistantTurnCount = 0
  for (const dialogue of dataset.dialogues) {
    turnCount += dialogue.turns.length
    assistantTurnCount += dialogue.turns.filter(turn => turn.role === 'assistant').length
  }
  return {
    dialogueCount: dataset.dialogues.length,
    fileCount: dataset.files.length,
    turnCount,
    assistantTurnCount,
    categories: CATEGORIES.filter(category => dataset.dialogues.some(dialogue => dialogue.category === category)),
    conditions: CONDITIONS.filter(condition => dataset.dialogues.some(dialogue => dialogue.condition === condition)),
  }
}

/** Run the synthetic evaluation. No model, network, clock or random source is used. */
export function runEvaluation(options = {}) {
  const fixtureDir = path.resolve(options.fixtureDir || FIXTURE_DIR)
  const dataset = loadDataset(fixtureDir)
  const evaluations = dataset.dialogues.map(dialogue => evaluateDialogue(dialogue, options))
  const overall = aggregateMetrics(evaluations)
  const summary = datasetSummary(dataset)
  const status = summary.conditions.includes('candidate')
    ? 'synthetic-comparison-not-validated'
    : 'synthetic-baseline-not-validated'
  return {
    schemaVersion: CONFIG.schemaVersion,
    kind: 'repetition-eval',
    ok: true,
    status,
    draft: true,
    notGold: true,
    dataset: {
      name: dataset.name,
      sha256: dataset.sha256,
      files: dataset.files,
      ...summary,
    },
    config: {
      window: CONFIG.window,
      maxWindow: CONFIG.maxWindow,
      cjkNgram: CONFIG.cjkNgram,
      latinNgram: CONFIG.latinNgram,
      phraseRule: 'maximal repeated CJK span >= 4 chars or Latin span >= 3 words, within the previous N assistant turns',
      matching: 'NFKC; Latin lowercase; code spans and necessary phrases masked; fact requiredTerms are completeness anchors only; Latin stopword-only spans ignored',
      codeProtection: 'fenced and inline code masked; code-like Latin tokens excluded from prose n-grams',
    },
    metrics: {
      ...overall,
      byCategory: groupEvaluations(evaluations, 'category', CATEGORIES),
      byCondition: groupEvaluations(evaluations, 'condition', CONDITIONS),
      humanPreference: {
        status: 'not-collected',
        preferenceRate: null,
        denominator: 0,
        emptySet: true,
        note: 'Blind A/B human ratings are a separate step; this script does not synthesize them.',
      },
    },
    dialogues: evaluations,
    caveats: [
      'Synthetic handwritten fixtures only; no real model output and no user chat was read.',
      'Baseline metrics describe these fixtures, not production model behaviour.',
      'No A/B or human preference data exists yet; do not claim that repetition was reduced.',
      'Lexical n-gram matching does not detect paraphrase or semantic repetition.',
    ],
  }
}

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--fixture-dir') {
      const value = argv[++index]
      if (!value) throw new UsageError('--fixture-dir requires a directory')
      options.fixtureDir = value
    } else if (arg === '--out') {
      const value = argv[++index]
      if (!value) throw new UsageError('--out requires a file path')
      options.out = value
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new UsageError('unknown argument ' + arg)
    }
  }
  return options
}

function usage() {
  return [
    'Usage: node scripts/repetition-eval.mjs [--fixture-dir DIR] [--out FILE] [--help]',
    '',
    'Reads synthetic repetition-eval fixtures and prints machine-readable JSON.',
    'No real model, network, user chat or production state is used.',
    '',
    'Exit codes: 0 success/help, 1 fixture or evaluation error, 2 usage error.',
  ].join('\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }
  const report = runEvaluation(options)
  const json = JSON.stringify(report, null, 2)
  if (options.out) {
    const out = path.resolve(options.out)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, json.replace(/\r?\n/g, '\r\n'), 'utf8')
    console.log('repetition-eval: wrote ' + out)
  } else {
    console.log(json)
  }
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url : false
if (invoked) {
  main().catch(error => {
    console.error(JSON.stringify({
      ok: false,
      kind: 'repetition-eval',
      error: error && error.message ? error.message : String(error),
    }, null, 2))
    process.exitCode = error instanceof UsageError ? 2 : 1
  })
}
