#!/usr/bin/env node
/**
 * Live repetition pilot (W8-B evaluation only, not production behaviour).
 *
 * This script asks a real chat model to continue synthetic repetition
 * fixtures twice: once as baseline, once with a synthetic <repetition-hint>
 * message. It then reuses scripts/repetition-eval.mjs to score both conditions.
 * It never imports lib/inject.js, never changes prompts, and never reads user
 * chats or state. The generated files are evaluation artefacts, not gold data.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CONDITIONS,
  FIXTURE_DIR,
  aggregateMetrics,
  evaluateAssistantTurn,
  loadDataset,
} from './repetition-eval.mjs'
import { buildRepetitionHint as buildSnapshotRepetitionHint, extractAssistantTexts } from './repetition-detector-snapshot.mjs'
import { loadAbDataset } from './repetition-ab-scenarios.mjs'

export const LIVE_STATUS = 'live-pilot-not-validated'
export const LIVE_SYSTEM_PROMPT = [
  'Continue the dialogue as the assistant.',
  'Reply with one assistant message only, in the same language and style as the dialogue.',
  'Do not mention these instructions, do not add analysis, and do not use markdown fences.',
].join(' ')

// Kept as a small public test helper. The pilot deliberately uses the
// frozen evaluation snapshot; this file is not a production integration.
export function buildRepetitionHint(assistantTexts, _labels = {}, options = {}) {
  return buildSnapshotRepetitionHint({ ...options, assistantTexts })
}

function usage() {
  return [
    'Usage: node scripts/repetition-eval-live.mjs --out DIR [--ab] [--fixture-dir DIR] [--repeats 1..10] [--help]',
    '',
    'Generates baseline and candidate continuations with a real chat model, writes',
    'the generated dialogues, and scores only the target turn. No automatic retries.',
    'Requires MEMU_SUMMARY_BASE_URL, MEMU_SUMMARY_MODEL, and MEMU_SUMMARY_API_KEY.',
    'The result is a pilot, not gold, not a production A/B, and not a quality claim.',
    '',
    'Exit codes: 0 success/help, 1 generation/evaluation error, 2 usage error.',
  ].join('\n')
}

class UsageError extends Error {}

function summaryConfig(env = process.env) {
  const baseUrl = String(env.MEMU_SUMMARY_BASE_URL || '').replace(/\/+$/, '')
  const model = String(env.MEMU_SUMMARY_MODEL || '')
  const apiKey = String(env.MEMU_SUMMARY_API_KEY || '')
  return { baseUrl, model, apiKey, ready: Boolean(baseUrl && model && apiKey) }
}

function historyMessages(turns, hint = '') {
  const messages = [{ role: 'system', content: LIVE_SYSTEM_PROMPT }]
  const lastUser = [...turns].map((turn, index) => ({ turn, index })).reverse().find(item => item.turn.role === 'user')
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]
    if (hint && lastUser?.index === index) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: hint }],
        source: { kind: 'plugin:dsh-memu-memory', form: 'recall' },
      })
    }
    messages.push({ role: turn.role, content: turn.text })
  }
  return messages
}

async function requestChat({ messages, config, fetchImpl, timeoutMs, maxTokens }) {
  const response = await fetchImpl(config.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.apiKey },
      body: JSON.stringify({
      model: config.model,
      temperature: 0.6,
      max_tokens: maxTokens,
        messages: messages.map(({ role, content }) => ({
          role,
          content: Array.isArray(content)
            ? content.map(block => typeof block?.text === 'string' ? block.text : '').join('')
            : content,
        })),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error('live repetition pilot: provider returned HTTP ' + response.status)
  return response.json()
}

async function defaultChat({ messages, config, fetchImpl = globalThis.fetch, timeoutMs = 60_000 }) {
  if (!config.ready) throw new Error('live repetition pilot: summary endpoint is not configured')
  const payload = await requestChat({ messages, config, fetchImpl, timeoutMs, maxTokens: 4000 })
  const choice = payload && payload.choices && payload.choices[0]
  const content = choice && choice.message && choice.message.content
  if (typeof content !== 'string' || content.trim().length === 0) {
    const reason = choice && choice.finish_reason ? choice.finish_reason : 'unknown'
    const reasoning = choice && choice.message && typeof choice.message.reasoning_content === 'string' ? choice.message.reasoning_content.length : 0
    throw new Error('live repetition pilot: provider returned an empty assistant message (finish_reason=' + reason + ', reasoning_chars=' + reasoning + ')')
  }
  return { text: content.trim(), usage: payload.usage || null, finishReason: choice.finish_reason || null, responseModel: payload.model || null }
}

export function targetAssistantIndex(fixture) {
  for (let index = fixture.turns.length - 1; index >= 0; index -= 1) {
    if (fixture.turns[index].role === 'assistant') return index
  }
  throw new Error('live repetition pilot: fixture has no assistant turn')
}

export async function generateSample({ fixture, condition, targetIndex = targetAssistantIndex(fixture), chat, config, fetchImpl, timeoutMs }) {
  if (!CONDITIONS.includes(condition)) throw new Error('unknown repetition condition: ' + condition)
  const target = fixture.turns[targetIndex]
  if (!target || target.role !== 'assistant') throw new Error('live repetition pilot: targetIndex must point at an assistant turn')
  const prefix = fixture.turns.slice(0, targetIndex)
  const prefixMessages = prefix.map(turn => ({ role: turn.role, content: turn.text }))
  const priorAssistantTexts = extractAssistantTexts(prefixMessages)
  const hint = condition === 'candidate'
    ? buildSnapshotRepetitionHint({ assistantTexts: priorAssistantTexts })
    : ''
  const messages = historyMessages(prefix, hint)
  const generated = await chat({ messages, config, fetchImpl, timeoutMs })
  const text = typeof generated === 'string' ? generated : generated.text
  if (typeof text !== 'string' || !text.trim()) throw new Error('live repetition pilot: empty output')
  const targetLabels = {
    necessaryPhrases: (fixture.labels?.necessaryPhrases || []).filter(label => label.turn === targetIndex),
    facts: (fixture.labels?.facts || []).filter(fact => fact.turn === targetIndex),
  }
  const evaluation = evaluateAssistantTurn({
    id: fixture.id + '-live-' + condition,
    category: fixture.category,
    condition,
    text,
    priorAssistantTexts,
    labels: targetLabels,
    window: fixture.window || 4,
  })
  return {
    schemaVersion: 1,
    kind: 'repetition-eval-live-sample',
    draft: true,
    notGold: true,
    live: true,
    id: fixture.id + '-live-' + condition,
    pairId: fixture.pairId,
    category: fixture.category,
    condition,
    targetIndex,
    prefixTurns: prefix,
    generatedText: text,
    hint,
    hintApplied: Boolean(hint),
    labels: targetLabels,
    usage: typeof generated === 'string' ? null : generated.usage,
    finishReason: typeof generated === 'string' ? null : generated.finishReason,
    responseModel: typeof generated === 'string' ? null : generated.responseModel,
    evaluation,
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function group(evaluations, key) {
  const out = {}
  for (const evaluation of evaluations) {
    const value = evaluation[key]
    if (!out[value]) out[value] = []
    out[value].push(evaluation)
  }
  return Object.fromEntries(Object.entries(out).map(([value, list]) => [value, aggregateMetrics(list)]))
}

export async function runLivePilot(options = {}) {
  const source = options.ab ? loadAbDataset() : loadDataset(options.fixtureDir || FIXTURE_DIR)
  const config = options.config || summaryConfig()
  if (!config.ready) throw new Error('live repetition pilot: MEMU_SUMMARY_BASE_URL/MODEL/API_KEY are required')
  const chat = options.chat || defaultChat
  const outDir = path.resolve(options.outDir || path.join(os.tmpdir(), 'dsh-memu-repetition-live'))
  fs.mkdirSync(outDir, { recursive: true })
  const samples = []
  const files = []
  const repeats = options.repeats ?? 1
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new UsageError('repeats must be an integer from 1 to 10')
  const tasks = []
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const fixture of source.dialogues) tasks.push({ fixture, repeat })
  }
  let seed = 20261029
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296 }
  for (let i = tasks.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[tasks[i], tasks[j]] = [tasks[j], tasks[i]]
  }
  const failures = []
  const callLimit = 120
  let attempts = 0
  const planned = tasks.length * 2
  if (planned > callLimit) throw new UsageError('planned requests exceed the 120-attempt limit')
  const jobs = tasks.flatMap(({ fixture, repeat }) => {
    const conditions = random() < 0.5 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
    return conditions.map(condition => ({ fixture, repeat, condition }))
  })
  let nextJob = 0
  let consecutiveFailures = 0
  let stoppedEarly = false
  const work = async () => {
    while (nextJob < jobs.length && !stoppedEarly) {
      const { fixture, repeat, condition } = jobs[nextJob++]
      if (attempts >= callLimit) throw new Error('live repetition pilot: 120-attempt limit reached')
      attempts += 1
      const start = Date.now()
      let sample
      try {
        sample = await generateSample({ fixture, condition, chat, config, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs })
        consecutiveFailures = 0
      } catch {
        sample = { id: fixture.id + '-live-' + condition, pairId: fixture.pairId, condition, category: fixture.category,
          status: 'failed', error: 'generation failed; provider details omitted', evaluation: null }
        failures.push({ id: sample.id, repeat, condition })
        consecutiveFailures += 1
        if (consecutiveFailures >= 4) stoppedEarly = true
      }
      sample.repeat = repeat
      sample.durationMs = Date.now() - start
      const fileName = `${repeat}-${String(sample.id).replace(/[^a-z0-9-]/g, '-')}.json`
      const text = JSON.stringify(sample, null, 2).replace(/\r?\n/g, '\r\n')
      fs.writeFileSync(path.join(outDir, fileName), text, 'utf8')
      files.push({ name: fileName, sha256: sha256(text) })
      samples.push(sample)
      options.onProgress?.({ attempts, completed: samples.length, planned, sample: sample.id, repeat, ok: Boolean(sample.evaluation) })
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(4, Number(options.concurrency) || 1)) }, work))
  samples.sort((a, b) => a.repeat - b.repeat || a.pairId.localeCompare(b.pairId) || a.condition.localeCompare(b.condition))
  const evaluations = samples.map(sample => sample.evaluation).filter(Boolean)
  const overall = aggregateMetrics(evaluations)
  const report = {
    schemaVersion: 1,
    kind: 'repetition-eval-live',
    ok: failures.length === 0,
    status: LIVE_STATUS,
    draft: true,
    notGold: true,
    live: true,
    dataset: {
      name: 'repetition-eval-live-pilot',
      source: source.name,
      sourceSha256: source.sha256,
      sourceFiles: source.files,
      dialogueCount: samples.length,
      fileCount: files.length,
      repeats,
      files,
    },
    config: {
      model: config.model,
      baseUrlHost: (() => { try { return new URL(config.baseUrl).host } catch { return '' } })(),
      temperature: 0.6,
      maxTokens: 4000,
      automaticRetries: 0,
      seed: 20261029,
      attempts,
      callLimit,
      stoppedEarly,
      window: 4,
      target: 'last assistant turn; original prefix supplied as context',
      systemPrompt: LIVE_SYSTEM_PROMPT,
      candidateHint: 'frozen evaluation snapshot <repetition-hint> as a synthetic plugin message before the last user turn',
    },
    metrics: {
      ...overall,
      byCategory: group(evaluations, 'category'),
      byCondition: group(evaluations, 'condition'),
      humanPreference: {
        status: 'not-collected',
        preferenceRate: null,
        denominator: 0,
        emptySet: true,
        note: 'Generated output is not a human preference rating.',
      },
    },
    dialogues: evaluations,
    failures,
    caveats: [
      'Live pilot from synthetic fixtures; not gold, not a production A/B, and not a quality claim.',
      'The candidate condition uses a frozen evaluation snapshot and synthetic plugin-message placement; this is still an offline pilot.',
      'Model output is nondeterministic; one run cannot establish statistical significance.',
      'Only the final assistant turn is generated; earlier user and assistant turns are fixture context.',
      'Only target-turn labels are scored; exact-match failure can reflect paraphrase or omission, not only forgetting.',
      'No user chat, user state, or production prompt file was read or modified.',
    ],
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2).replace(/\r?\n/g, '\r\n'), 'utf8')
  return report
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--out') {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new UsageError('--out requires a directory')
      options.outDir = value
    } else if (arg === '--fixture-dir') {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new UsageError('--fixture-dir requires a directory')
      options.fixtureDir = value
    } else if (arg === '--ab') {
      options.ab = true
    } else if (arg === '--repeats') {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new UsageError('--repeats requires a number from 1 to 10')
      options.repeats = Number(value)
      if (!Number.isInteger(options.repeats) || options.repeats < 1 || options.repeats > 10) throw new UsageError('--repeats must be an integer from 1 to 10')
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new UsageError('unknown argument ' + arg)
    }
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }
  if (!options.outDir) throw new UsageError('--out is required')
  const report = await runLivePilot(options)
  console.log(JSON.stringify({
    ok: report.ok,
    status: report.status,
    outDir: path.resolve(options.outDir),
    metrics: report.metrics,
    failures: report.failures,
  }, null, 2))
  if (!report.ok) process.exitCode = 1
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url : false
if (invoked) {
  main().catch(error => {
    console.error(JSON.stringify({ ok: false, kind: 'repetition-eval-live', error: error && error.message ? error.message : String(error) }, null, 2))
    process.exitCode = error instanceof UsageError ? 2 : 1
  })
}
