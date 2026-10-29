#!/usr/bin/env node
/**
 * Reproducible recall benchmark harness (W6).
 *
 * This is a SYNTHETIC-DRAFT benchmark, not a gold set. It seeds each sample into
 * its own temporary library under os.tmpdir(), uses a fixed clock per sample and a
 * seeded PRNG, and never reads or writes the user's memory directory. The production
 * ranking code is imported and exercised read-only; no production ordering is changed.
 *
 * The local lexical backend is the only backend in this harness. Mock/lexical
 * vectors only validate the pipeline: they do not establish embedding quality.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'recall-bench')
export const CANDIDATE_FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'recall-bench-gold-candidates')
export const DEFAULT_STATUS = 'synthetic-draft-not-gold'
export const CANDIDATE_STATUS = 'gold-candidate-pending-review'
export const DATASET_STATUSES = Object.freeze([DEFAULT_STATUS, CANDIDATE_STATUS])
export const SUBCLASSES = Object.freeze([
  'paraphrase',
  'exact',
  'negation',
  'no-answer',
  'conflict',
  'boundary',
  'secret',
  'coding',
])
export const SAMPLE_FIELDS = Object.freeze([
  'id',
  'draft',
  'notGold',
  'subclass',
  'query',
  'context',
  'time',
  'expectedIds',
  'forbiddenIds',
  'noAnswer',
  'library',
])
export const RUN_CONFIG = Object.freeze({
  schemaVersion: 1,
  benchmark: 'recall-bench',
  status: DEFAULT_STATUS,
  seed: 20261029,
  candidateTopK: 20,
  privateTopK: 3,
  turnTokens: 640,
  relevanceThreshold: 0.4,
  dedupeTurns: 16,
  backend: 'local-lexical',
})

const DAY_MS = 24 * 60 * 60 * 1000

function fixtureError(message) {
  throw new Error(`recall-bench fixture: ${message}`)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertString(value, field, where, { nonEmpty = true } = {}) {
  if (typeof value !== 'string' || (nonEmpty && !value.trim())) fixtureError(`${where}: ${field} must be a non-empty string`)
  return value
}

function assertStringArray(value, field, where, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) fixtureError(`${where}: ${field} must be an array`)
  if (!allowEmpty && value.length === 0) fixtureError(`${where}: ${field} must not be empty`)
  if (value.some(item => typeof item !== 'string' || !item.trim())) fixtureError(`${where}: ${field} must contain non-empty strings`)
  const unique = new Set(value)
  if (unique.size !== value.length) fixtureError(`${where}: ${field} contains duplicate ids`)
  return value
}

export function validateSampleShape(sample, where = 'sample', options = {}) {
  if (!isPlainObject(sample)) fixtureError(`${where}: sample must be an object`)
  for (const field of SAMPLE_FIELDS) {
    if (!Object.hasOwn(sample, field)) fixtureError(`${where}: missing field ${field}`)
  }
  assertString(sample.id, 'id', where)
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(sample.id)) fixtureError(`${where}: invalid sample id ${sample.id}`)
  if (sample.draft !== true) fixtureError(`${where}: draft must be true (do not present unconfirmed samples as confirmed)`)
  if (sample.notGold !== true) fixtureError(`${where}: notGold must be true (unconfirmed samples are not a gold set)`)
  if (options.status === CANDIDATE_STATUS) {
    if (sample.status !== CANDIDATE_STATUS) fixtureError(`${where}: candidate sample status must be ${CANDIDATE_STATUS}`)
    if (sample.review !== 'pending') fixtureError(`${where}: candidate sample review must be pending`)
  }
  if (sample.gold === true) fixtureError(`${where}: gold must not be marked before human review`)
  if (!SUBCLASSES.includes(sample.subclass)) fixtureError(`${where}: unknown subclass ${sample.subclass}`)
  assertString(sample.query, 'query', where)
  if (!isPlainObject(sample.context)) fixtureError(`${where}: context must be an object`)
  assertString(sample.time, 'time', where)
  if (!Number.isFinite(Date.parse(sample.time))) fixtureError(`${where}: time must be an ISO date/time`)
  assertStringArray(sample.expectedIds, 'expectedIds', where)
  assertStringArray(sample.forbiddenIds, 'forbiddenIds', where)
  assertStringArray(sample.library, 'library', where, { allowEmpty: false })
  if (sample.library.length > 10) fixtureError(`${where}: library subset is capped at 10 entries`)
  if (typeof sample.noAnswer !== 'boolean') fixtureError(`${where}: noAnswer must be boolean`)
  if (sample.noAnswer && sample.expectedIds.length > 0) fixtureError(`${where}: noAnswer=true requires expectedIds=[]`)
  if (!sample.noAnswer && sample.expectedIds.length === 0) fixtureError(`${where}: answerable sample requires expectedIds`)
  for (const id of sample.expectedIds) {
    if (!sample.library.includes(id)) fixtureError(`${where}: expected id ${id} is outside the declared library`)
  }
  for (const id of sample.forbiddenIds) {
    if (!sample.library.includes(id)) fixtureError(`${where}: forbidden id ${id} is outside the declared library`)
    if (sample.expectedIds.includes(id)) fixtureError(`${where}: id ${id} is both expected and forbidden`)
  }
  if (sample.explicitExpectedIds !== undefined) {
    assertStringArray(sample.explicitExpectedIds, 'explicitExpectedIds', where, { allowEmpty: false })
    for (const id of sample.explicitExpectedIds) {
      if (!sample.library.includes(id)) fixtureError(`${where}: explicit expected id ${id} is outside the declared library`)
      if (!sample.expectedIds.includes(id) && sample.noAnswer !== true) {
        // Explicit recall may surface a secret that automatic recall hides, so an
        // extra id is allowed; it must still be declared in the subset.
      }
    }
    for (const id of sample.expectedIds) {
      if (!sample.explicitExpectedIds.includes(id)) fixtureError(`${where}: explicitExpectedIds must include every expectedId`)
    }
  }
  if (sample.explicitForbiddenIds !== undefined) {
    assertStringArray(sample.explicitForbiddenIds, 'explicitForbiddenIds', where)
    for (const id of sample.explicitForbiddenIds) {
      if (!sample.library.includes(id)) fixtureError(`${where}: explicit forbidden id ${id} is outside the declared library`)
      if (sample.explicitExpectedIds?.includes(id)) fixtureError(`${where}: id ${id} is both explicit expected and forbidden`)
    }
  }
  return sample
}

function validateEntry(entry, id, where) {
  if (!isPlainObject(entry)) fixtureError(`${where}: entry ${id} must be an object`)
  if (entry.id !== id) fixtureError(`${where}: entry key ${id} must equal entry.id`)
  assertString(entry.title, 'title', `${where} entry ${id}`)
  assertString(entry.content, 'content', `${where} entry ${id}`)
  if (!Number.isFinite(entry.ageDays) || entry.ageDays < 0) fixtureError(`${where} entry ${id}: ageDays must be a non-negative number`)
  if (entry.updatedDaysAgo !== undefined && (!Number.isFinite(entry.updatedDaysAgo) || entry.updatedDaysAgo < 0)) {
    fixtureError(`${where} entry ${id}: updatedDaysAgo must be a non-negative number`)
  }
  if (entry.tags !== undefined) assertStringArray(entry.tags, 'tags', `${where} entry ${id}`)
  if (entry.visibility !== undefined && !['shared', 'secret'].includes(entry.visibility)) {
    fixtureError(`${where} entry ${id}: visibility must be shared or secret`)
  }
  if (entry.status !== undefined && !['active', 'superseded', 'pending_review', 'archived', 'suppressed', 'expired'].includes(entry.status)) {
    fixtureError(`${where} entry ${id}: unknown status ${entry.status}`)
  }
  if (entry.secret === true) fixtureError(`${where} entry ${id}: secret is a config flag; use visibility=secret for memory entries`)
  return entry
}

function validateFileShape(raw, fileName) {
  if (!isPlainObject(raw)) fixtureError(`${fileName}: file must be an object`)
  if (raw.draft !== true) fixtureError(`${fileName}: draft must be true`)
  if (raw.notGold !== true) fixtureError(`${fileName}: notGold must be true`)
  if (!DATASET_STATUSES.includes(raw.status)) fixtureError(`${fileName}: status must be one of ${DATASET_STATUSES.join(', ')}`)
  if (raw.status === CANDIDATE_STATUS && raw.review !== 'pending') {
    fixtureError(`${fileName}: candidate file review must be pending`)
  }
  if (raw.gold === true) fixtureError(`${fileName}: gold must not be marked before human review`)
  assertString(raw.name, 'name', fileName)
  if (!SUBCLASSES.includes(raw.subclass)) fixtureError(`${fileName}: unknown file subclass ${raw.subclass}`)
  if (!isPlainObject(raw.entries)) fixtureError(`${fileName}: entries must be an object`)
  if (!Array.isArray(raw.samples) || raw.samples.length === 0) fixtureError(`${fileName}: samples must be a non-empty array`)
  return { status: raw.status, review: raw.status === CANDIDATE_STATUS ? 'pending' : undefined }
}

/**
 * Load and validate all synthetic fixtures. Validation is intentionally strict:
 * a typo in an expected id must fail the benchmark instead of silently becoming
 * a zero score.
 */
export function loadDataset(fixtureDir = FIXTURE_DIR) {
  const dir = path.resolve(fixtureDir)
  let names
  try {
    names = fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort()
  } catch (error) {
    fixtureError(`cannot read fixture directory ${dir}: ${error?.message || error}`)
  }
  if (names.length === 0) fixtureError(`no .json fixtures in ${dir}`)

  const entries = new Map()
  const samples = []
  const files = []
  const sampleIds = new Set()
  const statuses = new Set()
  for (const fileName of names) {
    const filePath = path.join(dir, fileName)
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch (error) {
      fixtureError(`${fileName}: invalid JSON: ${error?.message || error}`)
    }
    const fileShape = validateFileShape(raw, fileName)
    statuses.add(fileShape.status)
    for (const [id, entry] of Object.entries(raw.entries)) {
      if (entries.has(id)) fixtureError(`duplicate entry id ${id} across fixture files`)
      entries.set(id, validateEntry(entry, id, fileName))
    }
    for (let index = 0; index < raw.samples.length; index += 1) {
      const sample = validateSampleShape(raw.samples[index], `${fileName} samples[${index}]`, { status: fileShape.status })
      if (sample.subclass !== raw.subclass) fixtureError(`${fileName}: sample ${sample.id} subclass does not match file subclass`)
      if (sampleIds.has(sample.id)) fixtureError(`duplicate sample id ${sample.id}`)
      sampleIds.add(sample.id)
      samples.push(sample)
    }
    files.push({ name: fileName, sha256: sha256(fs.readFileSync(filePath)) })
  }

  for (const sample of samples) {
    for (const id of sample.library) {
      if (!entries.has(id)) fixtureError(`sample ${sample.id}: library id ${id} is not defined in any fixture file`)
    }
    for (const id of sample.expectedIds) {
      if (!sample.library.includes(id)) fixtureError(`sample ${sample.id}: expected id ${id} is outside its library`)
    }
    for (const id of sample.forbiddenIds) {
      if (!sample.library.includes(id)) fixtureError(`sample ${sample.id}: forbidden id ${id} is outside its library`)
    }
  }
  if (statuses.size !== 1) fixtureError('fixture directory mixes dataset statuses')
  const datasetStatus = [...statuses][0]
  if (samples.length < 30 || samples.length > 50) {
    fixtureError(`expected 30-50 samples, found ${samples.length}`)
  }
  for (const subclass of SUBCLASSES) {
    if (!samples.some(sample => sample.subclass === subclass)) fixtureError(`missing subclass ${subclass}`)
  }

  const digest = crypto.createHash('sha256')
  for (const file of files) {
    digest.update(file.name)
    digest.update('\0')
    digest.update(file.sha256)
    digest.update('\0')
  }
  return {
    name: datasetStatus === CANDIDATE_STATUS ? 'recall-bench-gold-candidates' : 'recall-bench-synthetic-draft',
    status: datasetStatus,
    draft: true,
    notGold: true,
    gold: false,
    review: datasetStatus === CANDIDATE_STATUS ? 'pending' : undefined,
    dir,
    files,
    sha256: digest.digest('hex'),
    entries,
    samples,
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function round(value, digits = 6) {
  const factor = 10 ** digits
  const rounded = Math.round((Number(value) + Number.EPSILON) * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}

function top3Of(ids) {
  return Array.isArray(ids) ? ids.slice(0, 3) : []
}

/**
 * Compute the benchmark metrics for one projection (candidate ids, final injected
 * ids, or explicit-probe ids).
 *
 * Definitions and empty-set rules:
 * - Recall@3 denominator = answerable samples only. A sample counts as a hit if
 *   at least one expected id is in the first three positions.
 * - MRR@3 denominator = answerable samples only. The reciprocal rank is 0 when no
 *   expected id appears in the first three positions.
 * - No-answer false-recall denominator = no-answer samples only. It is the fraction
 *   whose first three positions contain any id at all.
 * - Isolation violations = every occurrence of a forbidden id in any scored top-3.
 *   The requirement is exactly 0; the denominator is reported for transparency.
 * - If a denominator is empty, the corresponding rate is reported as 0 with an
 *   explicit emptySet flag. The harness refuses an empty overall dataset.
 */
export function computeMetrics(records) {
  let answerable = 0
  let hits = 0
  let reciprocalRankSum = 0
  let noAnswer = 0
  let noAnswerFalseRecall = 0
  let forbiddenChecked = 0
  const violations = []
  for (const record of records) {
    const top3 = top3Of(record.top3)
    if (record.noAnswer === true) {
      noAnswer += 1
      if (top3.length > 0) noAnswerFalseRecall += 1
    } else {
      answerable += 1
      let rank = 0
      for (let index = 0; index < top3.length; index += 1) {
        if (record.expectedIds?.includes(top3[index])) {
          rank = index + 1
          break
        }
      }
      if (rank > 0) {
        hits += 1
        reciprocalRankSum += 1 / rank
      }
    }
    for (const id of record.forbiddenIds || []) {
      forbiddenChecked += 1
      if (top3.includes(id)) violations.push({ sampleId: record.id, id, top3: top3.slice() })
    }
  }
  return {
    recallAt3: answerable === 0 ? 0 : round(hits / answerable),
    mrrAt3: answerable === 0 ? 0 : round(reciprocalRankSum / answerable),
    noAnswerFalseRecallRate: noAnswer === 0 ? 0 : round(noAnswerFalseRecall / noAnswer),
    isolationViolations: violations.length,
    denominators: {
      answerable,
      noAnswer,
      forbiddenChecked,
    },
    emptySet: {
      recallAt3: answerable === 0,
      mrrAt3: answerable === 0,
      noAnswerFalseRecallRate: noAnswer === 0,
      isolationViolations: forbiddenChecked === 0,
    },
    violations: violations.slice(0, 50),
  }
}

function latencyStats(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return { backend: RUN_CONFIG.backend, samples: 0, medianMs: null, p95Ms: null, method: 'no samples' }
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1)
  return {
    backend: RUN_CONFIG.backend,
    samples: sorted.length,
    medianMs: round(median, 3),
    p95Ms: round(sorted[p95Index], 3),
    method: 'wall-clock around automatic candidate + buildRecall per sample; single Node process; performance.now(); not service latency',
  }
}

function prepareRoot(workRoot) {
  const tmp = path.resolve(os.tmpdir())
  let root = workRoot ? path.resolve(workRoot) : fs.mkdtempSync(path.join(tmp, 'dsh-memu-recall-bench-'))
  const relative = path.relative(tmp, root)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`recall-bench: workRoot must be a fresh directory under os.tmpdir(): ${root}`)
  }
  if (fs.existsSync(root)) {
    if (!fs.statSync(root).isDirectory()) throw new Error(`recall-bench: workRoot is not a directory: ${root}`)
    if (fs.readdirSync(root).length > 0) throw new Error(`recall-bench: workRoot must be empty: ${root}`)
  } else {
    fs.mkdirSync(root, { recursive: true })
  }
  return root
}

function installClock(initialMs) {
  const RealDate = Date
  let now = Number(initialMs)
  class BenchDate extends RealDate {
    constructor(...args) {
      super(...(args.length === 0 ? [now] : args))
    }
    static now() {
      return now
    }
  }
  globalThis.Date = BenchDate
  return {
    set(ms) { now = Number(ms) },
    restore() { globalThis.Date = RealDate },
  }
}

function installRandom(seed) {
  const original = Math.random
  let state = Number(seed) >>> 0
  if (state === 0) state = 0x9e3779b9
  Math.random = () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { restore() { Math.random = original } }
}

function entryForSample(source, sample) {
  const { id: _id, ageDays = 7, updatedDaysAgo, ...rest } = source
  const nowMs = Date.parse(sample.time)
  const createdMs = nowMs - Number(ageDays) * DAY_MS
  const updatedMs = nowMs - Number(updatedDaysAgo ?? ageDays) * DAY_MS
  return {
    createdAt: new Date(createdMs).toISOString(),
    updatedAt: new Date(updatedMs).toISOString(),
    layer: 'long_term',
    status: 'active',
    visibility: 'shared',
    context: {},
    confidence: 0.9,
    owner: 'user',
    source: 'user_said',
    accessCount: 0,
    injectCount: 0,
    tags: [],
    ...rest,
  }
}

function seedSample(state, sample, entries, root, suffix = '') {
  const library = state.createLibrary({
    name: `bench-${sample.id}${suffix}`,
    scopeKey: path.join(root, 'scopes', `${sample.id}${suffix}`),
  })
  const index = { version: 1, entries: {} }
  for (const id of sample.library) {
    const source = entries.get(id)
    if (!source) throw new Error(`recall-bench: missing entry ${id}`)
    index.entries[id] = entryForSample(source, sample)
  }
  state.savePrivateIndex(library.id, index)
  const sessionId = `bench-session-${sample.id}${suffix}`
  state.setSessionBinding(sessionId, {
    libraryId: library.id,
    scopeKey: library.scopeKey,
    useLibrary: true,
    useGlobal: false,
    memoryContext: { ...sample.context },
    memoryOwnerSessionId: sessionId,
    domain: sample.subclass === 'coding' ? 'coding' : 'rp',
    domainOverride: sample.subclass === 'coding' ? 'coding' : 'rp',
    injectedAt: {},
    injectedIds: [],
    recentQueries: [],
    lastInjectedTurn: 0,
  })
  state.flushState()
  return { library, sessionId }
}

function execFor(sessionId, root) {
  return {
    agent: {
      session: {
        header: {
          id: sessionId,
          cwd: path.join(root, 'cwd'),
          agentPreset: 'rp',
        },
      },
    },
  }
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim() || null
  } catch {
    return null
  }
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || null
  } catch {
    return null
  }
}

function buildProjection(records, key, expectedKey, forbiddenKey, { noAnswerEligible = true } = {}) {
  const projected = records.map(record => ({
    id: record.id,
    subclass: record.subclass,
    noAnswer: noAnswerEligible ? record.noAnswer : false,
    expectedIds: record[expectedKey] || [],
    forbiddenIds: record[forbiddenKey] || [],
    top3: top3Of(record[key]),
  }))
  return computeMetrics(projected)
}

function bySubclass(records) {
  const result = {}
  for (const subclass of SUBCLASSES) {
    const subset = records.filter(record => record.subclass === subclass)
    if (subset.length === 0) continue
    const candidate = buildProjection(subset, 'candidateTop3', 'expectedIds', 'forbiddenIds')
    const finalInjected = buildProjection(subset, 'injectedTop3', 'expectedIds', 'forbiddenIds')
    result[subclass] = {
      samples: subset.length,
      candidateRecallAt3: candidate.recallAt3,
      candidateMrrAt3: candidate.mrrAt3,
      candidateNoAnswerFalseRecallRate: candidate.noAnswerFalseRecallRate,
      candidateIsolationViolations: candidate.isolationViolations,
      finalInjectedRecallAt3: finalInjected.recallAt3,
      finalInjectedMrrAt3: finalInjected.mrrAt3,
      finalInjectedNoAnswerFalseRecallRate: finalInjected.noAnswerFalseRecallRate,
      finalInjectedIsolationViolations: finalInjected.isolationViolations,
      denominators: finalInjected.denominators,
    }
  }
  return result
}

function sumEstimate(records) {
  return records.reduce((total, record) => total + Number(record.injectedTokenEstimate || 0), 0)
}

/**
 * Run the benchmark. All state lives under a fresh os.tmpdir() root. The env
 * overrides are restored in finally, and the root is removed after the report is
 * built unless the caller supplied workRoot or --keep for inspection.
 */
export async function runBenchmark(options = {}) {
  const fixtureDir = path.resolve(options.fixtureDir || FIXTURE_DIR)
  const dataset = loadDataset(fixtureDir)
  const sampleLimit = options.sampleLimit === undefined ? dataset.samples.length : Number(options.sampleLimit)
  if (!Number.isInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > dataset.samples.length) {
    throw new Error(`recall-bench: sampleLimit must be 1..${dataset.samples.length}`)
  }
  const samples = dataset.samples.slice(0, sampleLimit)
  const root = prepareRoot(options.workRoot)
  const seed = Number.isInteger(options.seed) ? options.seed : RUN_CONFIG.seed
  const startedAt = new Date().toISOString()
  const clock = installClock(Date.parse(samples[0].time))
  const random = installRandom(seed)
  const previousHome = process.env.DSH_MEMU_HOME
  const previousMemoryHome = process.env.DSH_MEMU_MEMORY_HOME
  let state = null
  const records = []

  try {
    process.env.DSH_MEMU_HOME = path.join(root, 'dsh-memu-home')
    process.env.DSH_MEMU_MEMORY_HOME = path.join(root, 'dsh-memu-data')
    fs.mkdirSync(process.env.DSH_MEMU_HOME, { recursive: true })
    fs.mkdirSync(process.env.DSH_MEMU_MEMORY_HOME, { recursive: true })

    state = await import(pathToFileURL(path.join(ROOT, 'lib', 'state.js')).href)
    const memory = await import(pathToFileURL(path.join(ROOT, 'lib', 'memory.js')).href)
    const inject = await import(pathToFileURL(path.join(ROOT, 'lib', 'inject.js')).href)
    const budget = await import(pathToFileURL(path.join(ROOT, 'lib', 'budget.js')).href)

    for (const sample of samples) {
      const sampleNow = Date.parse(sample.time)
      clock.set(sampleNow)
      const automatic = seedSample(state, sample, dataset.entries, root, '')
      const autoExec = execFor(automatic.sessionId, root)
      const settings = {
        ...state.getSettings(),
        privateTopK: RUN_CONFIG.privateTopK,
        turnTokens: RUN_CONFIG.turnTokens,
        relevanceThreshold: RUN_CONFIG.relevanceThreshold,
        dedupeTurns: RUN_CONFIG.dedupeTurns,
        autoInject: 'smart',
        globalEveryNTurns: 0,
      }

      const started = performance.now()
      const candidate = await memory.privateRecall({
        exec: autoExec,
        query: sample.query,
        topK: RUN_CONFIG.candidateTopK,
        relevanceThreshold: RUN_CONFIG.relevanceThreshold,
        purpose: 'automatic',
      })
      const candidateIds = (candidate.files || []).map(file => file.name)
      const binding = state.getSessionBinding(automatic.sessionId)
      if (!binding) throw new Error(`recall-bench: session binding disappeared for ${sample.id}`)
      const injected = await inject.buildRecall(binding, sample.query, 1, settings, autoExec, automatic.sessionId)
      const latencyMs = performance.now() - started

      const injectedIds = Array.isArray(injected.ids) ? injected.ids.slice() : []
      const injectedText = String(injected.text || '')
      const injectedTokenEstimate = budget.estTokens(injectedText)

      let explicitIds = []
      if (Array.isArray(sample.explicitExpectedIds) && sample.explicitExpectedIds.length > 0) {
        const explicit = seedSample(state, sample, dataset.entries, root, '-explicit')
        const explicitExec = execFor(explicit.sessionId, root)
        const explicitResult = await memory.privateRecall({
          exec: explicitExec,
          query: sample.query,
          topK: RUN_CONFIG.candidateTopK,
          relevanceThreshold: RUN_CONFIG.relevanceThreshold,
          purpose: 'explicit',
        })
        explicitIds = (explicitResult.files || []).map(file => file.name)
      }

      records.push({
        id: sample.id,
        subclass: sample.subclass,
        draft: true,
        notGold: true,
        noAnswer: sample.noAnswer,
        query: sample.query,
        context: { ...sample.context },
        time: sample.time,
        expectedIds: sample.expectedIds.slice(),
        forbiddenIds: sample.forbiddenIds.slice(),
        library: sample.library.slice(),
        candidateIds,
        candidateRoute: candidate.recallRoute || null,
        candidateErrors: Array.isArray(candidate.errors) ? candidate.errors.slice() : [],
        candidateFusion: candidate.fusion || null,
        candidateTop3: top3Of(candidateIds),
        candidateCount: candidateIds.length,
        injectedIds,
        injectedTop3: top3Of(injectedIds),
        injectedOutcome: injected.outcome || null,
        injectedErrors: Array.isArray(injected.errors) ? injected.errors.slice() : [],
        injectedTextChars: injectedText.length,
        injectedTokenEstimate,
        explicitIds,
        explicitTop3: top3Of(explicitIds),
        latencyMs: round(latencyMs, 3),
      })
    }
    state.flushState()

    const candidateMetrics = buildProjection(records, 'candidateTop3', 'expectedIds', 'forbiddenIds')
    const injectedMetrics = buildProjection(records, 'injectedTop3', 'expectedIds', 'forbiddenIds')
    const explicitRecords = records.filter(record => {
      const sample = samples.find(item => item.id === record.id)
      return Array.isArray(sample?.explicitExpectedIds) && sample.explicitExpectedIds.length > 0
    })
    const explicitMetrics = buildProjection(
      explicitRecords.map(record => {
        const sample = samples.find(item => item.id === record.id)
        return {
          ...record,
          explicitExpectedIds: sample.explicitExpectedIds,
          explicitForbiddenIds: sample.explicitForbiddenIds || [],
        }
      }),
      'explicitTop3',
      'explicitExpectedIds',
      'explicitForbiddenIds',
      { noAnswerEligible: false },
    )
    const candidateViolations = candidateMetrics.violations.map(item => ({ ...item, projection: 'candidate' }))
    const injectedViolations = injectedMetrics.violations.map(item => ({ ...item, projection: 'final-injected' }))
    const explicitViolations = explicitMetrics.violations.map(item => ({ ...item, projection: 'explicit-probe' }))
    const injectedTotalEstimate = sumEstimate(records)
    const sampleCount = records.length

    return {
      schemaVersion: RUN_CONFIG.schemaVersion,
      kind: 'recall-bench',
      ok: true,
      status: dataset.status,
      gold: false,
      review: dataset.review,
      dataset: {
        name: dataset.name,
        status: dataset.status,
        draft: true,
        notGold: true,
        gold: false,
        review: dataset.review,
        sampleCount,
        fileCount: dataset.files.length,
        sha256: dataset.sha256,
        files: dataset.files,
      },
      code: {
        commit: gitCommit(),
        packageVersion: packageVersion(),
        worktree: 'dirty-or-uncommitted (recorded from current workspace; not a commit)',
      },
      run: {
        startedAt,
        root,
        clock: 'fixed per sample (Date.now overridden from sample.time)',
        randomSeed: seed,
        random: 'seeded mulberry32',
        sampleLimit,
      },
      config: {
        backend: RUN_CONFIG.backend,
        candidateTopK: RUN_CONFIG.candidateTopK,
        privateTopK: RUN_CONFIG.privateTopK,
        turnTokens: RUN_CONFIG.turnTokens,
        relevanceThreshold: RUN_CONFIG.relevanceThreshold,
        dedupeTurns: RUN_CONFIG.dedupeTurns,
        mockVectors: 'pipeline-only',
        vectorPath: 'none (local lexical only)',
        note: 'local lexical only; any mock/lexical vector path validates pipeline plumbing, not embedding quality',
      },
      metrics: {
        candidate: candidateMetrics,
        finalInjected: injectedMetrics,
        explicitProbe: explicitMetrics,
        isolation: {
          violations: candidateViolations.length + injectedViolations.length + explicitViolations.length,
          mustBeZero: true,
          candidate: candidateMetrics.isolationViolations,
          finalInjected: injectedMetrics.isolationViolations,
          explicitProbe: explicitMetrics.isolationViolations,
          forbiddenDenominator: candidateMetrics.denominators.forbiddenChecked
            + injectedMetrics.denominators.forbiddenChecked
            + explicitMetrics.denominators.forbiddenChecked,
          details: [...candidateViolations, ...injectedViolations, ...explicitViolations].slice(0, 100),
        },
        latency: latencyStats(records.map(record => record.latencyMs)),
        bySubclass: bySubclass(records),
      },
      budget: {
        estimateOnly: true,
        field: 'estimate',
        estimate: {
          injectedTokenTotal: round(injectedTotalEstimate, 3),
          injectedTokenMeanPerSample: sampleCount === 0 ? 0 : round(injectedTotalEstimate / sampleCount, 3),
          turnTokens: RUN_CONFIG.turnTokens,
          method: 'lib/budget.js estTokens; CJK ~1 token/char, Latin ~3.4 chars/token',
        },
        method: 'lib/budget.js estTokens; CJK ~1 token/char, Latin ~3.4 chars/token',
        turnTokens: RUN_CONFIG.turnTokens,
        injectedTokenEstimateTotal: round(injectedTotalEstimate, 3),
        injectedTokenEstimateMean: sampleCount === 0 ? 0 : round(injectedTotalEstimate / sampleCount, 3),
        note: 'Token estimates only. These are not actual token usage and must not be reported as consumed tokens.',
      },
      samples: records,
    }
  } finally {
    try {
      state?.flushState()
    } catch {}
    clock.restore()
    random.restore()
    if (previousHome === undefined) delete process.env.DSH_MEMU_HOME
    else process.env.DSH_MEMU_HOME = previousHome
    if (previousMemoryHome === undefined) delete process.env.DSH_MEMU_MEMORY_HOME
    else process.env.DSH_MEMU_MEMORY_HOME = previousMemoryHome
    if (!options.workRoot && !options.keep) {
      try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
    }
  }
}

export function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--out') options.out = argv[++index]
    else if (arg === '--fixture-dir') {
      const fixtureDir = argv[++index]
      if (!fixtureDir || fixtureDir.startsWith('--')) throw new Error('recall-bench: --fixture-dir requires a directory')
      options.fixtureDir = fixtureDir
    }
    else if (arg === '--work-root') options.workRoot = argv[++index]
    else if (arg === '--seed') options.seed = Number(argv[++index])
    else if (arg === '--samples') options.sampleLimit = Number(argv[++index])
    else if (arg === '--keep') options.keep = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`recall-bench: unknown argument ${arg}`)
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: node scripts/recall-bench.mjs [--fixture-dir DIR] [--out report.json] [--work-root DIR] [--seed N] [--samples N] [--keep]')
    console.log('  --fixture-dir DIR  fixture directory; default tests/fixtures/recall-bench; candidate package tests/fixtures/recall-bench-gold-candidates')
    console.log('  --samples N        run the first N samples, 1..dataset size; default all samples')
    return
  }
  const report = await runBenchmark(options)
  const json = JSON.stringify(report, null, 2)
  if (options.out) {
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true })
    fs.writeFileSync(path.resolve(options.out), json.replace(/\r?\n/g, '\r\n'), 'utf8')
    console.log(`recall-bench: wrote ${path.resolve(options.out)}`)
  } else {
    console.log(json)
  }
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url : false
if (invoked) {
  main().catch(error => {
    console.error(JSON.stringify({ ok: false, kind: 'recall-bench', error: error?.message || String(error) }, null, 2))
    process.exitCode = 1
  })
}
