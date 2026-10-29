#! /usr/bin/env node
// Read-only binding lifecycle CLI (W9).
//
// It prints a diagnostic report and refuses every write: no delete, no unbind, no library
// creation, no state rewrite, no timestamp bump. The only side effect is stdout/stderr.
//
// Exit codes are about the report, never about "fixing" anything:
//   0  report produced, nothing filed for inspection
//   1  report produced, inspection candidates present (a to-do list for a human, not a queue)
//   2  usage error (unknown flag, unreadable --now)
//   3  no report: state.json is missing, corrupt or unreadable

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { diagnoseBindings, defaultStateFile, INSPECTION_DAYS, SCHEMA } from '../lib/binding-diagnostics.js'

export const EXIT = Object.freeze({ clean: 0, candidates: 1, usage: 2, unreadable: 3 })

const USAGE = [
  'usage: node scripts/diagnose-bindings.mjs [options]',
  '',
  'Read-only binding lifecycle report. Reads state.json once, never writes, never creates',
  'a directory, never unbinds or deletes anything, and re-hashes the file afterwards so the',
  'report can prove it left the bytes and the mtime alone.',
  '',
  'options:',
  '  --state <file>   state.json to read (default: the plugin data directory)',
  '  --json           print the machine-readable report instead of the summary',
  '  --redact         pseudonymise session ids (titles and paths are never printed either way)',
  '  --now <iso>      evaluate the ' + INSPECTION_DAYS + '-day inspection threshold at an instant, for tests',
  '  --help, -h       print this text',
  '',
  'exit codes:',
  '  0  report produced, no inspection candidates',
  '  1  report produced, inspection candidates present (inspection only, nothing was changed)',
  '  2  usage error',
  '  3  state.json missing, corrupt or unreadable — nothing was created or repaired',
  '',
  'The ' + INSPECTION_DAYS + '-day mark is a threshold for looking, never an age at which a binding, a',
  'library or a message is dropped. There is no --delete, --gc or --unbind flag, by design.',
].join('\n')

function usage (message) {
  if (message) process.stderr.write('error: ' + message + '\n\n')
  process.stderr.write(USAGE + '\n')
  process.exitCode = EXIT.usage
}

export function parseArgs (argv) {
  const options = { json: false, redact: false, stateFile: null, now: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (arg === '--json') { options.json = true; continue }
    if (arg === '--redact') { options.redact = true; continue }
    if (arg === '--state' || arg.startsWith('--state=')) {
      const value = arg === '--state' ? argv[++index] : arg.slice('--state='.length)
      if (!value) return { error: '--state requires a file' }
      options.stateFile = path.resolve(value)
      continue
    }
    if (arg === '--now' || arg.startsWith('--now=')) {
      const value = arg === '--now' ? argv[++index] : arg.slice('--now='.length)
      const parsed = Date.parse(String(value || ''))
      if (!value || !Number.isFinite(parsed)) return { error: '--now requires an ISO timestamp' }
      options.now = parsed
      continue
    }
    return { error: 'unknown argument: ' + arg }
  }
  return { options }
}

function short (hash) {
  return typeof hash === 'string' && hash.length > 12 ? hash.slice(0, 12) + '…' : String(hash || '-')
}

function render (report) {
  const lines = []
  lines.push('dsh-memu-memory binding diagnostic — read-only (' + SCHEMA + ')')
  lines.push('state: ' + report.state.file)
  if (report.state.status === 'ok') {
    lines.push('       ' + report.state.bytes + ' bytes, sha256 ' + short(report.state.sha256) + ', mtime ' + new Date(report.state.mtimeMs).toISOString())
  } else {
    lines.push('       status: ' + report.state.status)
  }
  lines.push('generated: ' + report.generatedAt)
  if (report.readOnlyProof) {
    lines.push('read-only proof: ' + (report.readOnlyProof.unchanged
      ? 'bytes and mtime identical before/after (' + short(report.readOnlyProof.sha256Before) + ')'
      : 'CHANGED during the report — investigate, this tool does not write'))
  }
  if (!report.analysis) {
    lines.push('')
    lines.push('no analysis: the state file could not be read. Nothing was created, renamed or repaired.')
    for (const unknown of report.unknowns) lines.push('  unknown ' + unknown.code + ': ' + unknown.detail)
    return lines.join('\n')
  }
  const summary = report.analysis.summary
  lines.push('')
  lines.push('bindings: ' + summary.bindings + ' persistent binding(s)')
  lines.push('host: ' + summary.host.status + ' / ' + summary.host.source + ' / ' + summary.host.sessions + ' session(s)' + (summary.host.complete ? ' (complete)' : ' (incomplete — absence is not inferred)'))
  lines.push('candidates: ' + summary.candidates.total + (summary.candidates.total ? ' — ' + Object.entries(summary.candidates.byKind).map(([kind, count]) => kind + ' ' + count).join(', ') : ''))
  lines.push('unfinished: ' + summary.unfinished.pendingMessages + ' pending message(s) in ' + summary.unfinished.pendingSessions + ' session(s), ' +
    summary.unfinished.reinjectPending + ' reinject, ' + summary.unfinished.sleepRetryDue + ' sleep retry due, ' + summary.unfinished.sessionGone + ' session gone')
  lines.push('switches: ' + summary.switches.libraryDisabled + ' library off, ' + summary.switches.globalDisabled + ' global off, ' +
    summary.switches.folderBlockedLibrary + ' folder-blocked library, ' + summary.switches.folderBlockedGlobal + ' folder-blocked global')
  lines.push('libraries: ' + summary.libraries.bound + ' bound, ' + summary.libraries.enabledButUnbound + ' enabled-but-unbound, ' +
    summary.libraries.missing + ' missing, ' + summary.libraries.archived + ' archived')
  if (report.analysis.candidates.length > 0) {
    lines.push('')
    lines.push('inspection candidates (a prompt to look, never a deletion queue):')
    for (const candidate of report.analysis.candidates.slice(0, 20)) {
      lines.push('  ' + candidate.kind.padEnd(28) + ' ' + candidate.sessionId)
    }
    if (report.analysis.candidates.length > 20) lines.push('  … ' + (report.analysis.candidates.length - 20) + ' more (use --json)')
  }
  if (report.unknowns.length > 0) {
    lines.push('')
    lines.push('unknowns (kept, not assumed away):')
    for (const unknown of report.unknowns) lines.push('  ' + unknown.code + ': ' + unknown.detail)
  }
  lines.push('')
  const runtime = report.analysis.runtime || { status: 'unknown', layers: [] }
  const runtimeLabel = runtime.status === 'provided'
    ? 'runtime layers supplied in-process: '
    : 'runtime layers not readable from this process: '
  lines.push(runtimeLabel + runtime.layers.length + ' declared (' + runtime.status + ')')
  lines.push('threshold: ' + INSPECTION_DAYS + ' days marks what to inspect; it never triggers deletion. No gc, no unbind, no write.')
  return lines.join('\n')
}

function main () {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.error) {
    usage(parsed.error)
    return
  }
  const options = parsed.options
  if (options.help) {
    process.stdout.write(USAGE + '\n')
    return
  }
  let report
  try {
    report = diagnoseBindings({
      stateFile: options.stateFile || defaultStateFile(),
      now: options.now === null ? undefined : options.now,
      redactIds: options.redact,
    })
  } catch (error) {
    process.stderr.write('error: the diagnostic failed without touching the state file: ' + String((error && error.message) || error) + '\n')
    process.exitCode = EXIT.unreadable
    return
  }
  try {
    if (options.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    } else {
      process.stdout.write(render(report) + '\n')
    }
  } catch (error) {
    // A rendering bug must not masquerade as exit 1 ("candidates present"): no report was produced.
    process.stderr.write('error: the report could not be rendered: ' + String((error && error.message) || error) + '\n')
    process.exitCode = EXIT.unreadable
    return
  }
  if (!report.analysis) {
    process.exitCode = EXIT.unreadable
    return
  }
  process.exitCode = report.analysis.candidates.length > 0 ? EXIT.candidates : EXIT.clean
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) main()
