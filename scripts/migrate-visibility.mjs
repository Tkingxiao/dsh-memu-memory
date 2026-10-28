#!/usr/bin/env node
// Rewrite libraries that still store the removed `visibility: 'session'` level.
//
// Reading never needs this: `loadPrivateIndex` already serves those entries as `shared`
// (see lib/visibility.js). The script exists for the disk — a library nobody writes to
// again would otherwise keep the dead level and its `sessionId` forever, and anyone
// reading the JSON would have to know about a level the code no longer has.
//
//   node scripts/migrate-visibility.mjs            # report only
//   node scripts/migrate-visibility.mjs --apply    # back up, then rewrite
//
// Exit codes: 0 nothing to do or already applied, 3 changes found but not applied,
//             1 the migration itself failed.
import path from 'node:path'
import { dataDir } from '../lib/paths.js'
import * as state from '../lib/state.js'
import { scanLegacyLibraries, migrateLibraries } from '../lib/migrate.js'

const HELP = `Usage: node scripts/migrate-visibility.mjs [--apply] [--json]

  --apply   rewrite the libraries (takes a backup first)
  --json    machine-readable report
  --help    this text

Memories stored as visibility "session" by an older version become "shared" in the folder
they live in. Their context (channel / character / world / branch) is kept untouched, so
a memory scoped to one character stays scoped to that character.`
const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(HELP)
  process.exit(0)
}
const apply = argv.includes('--apply')
const json = argv.includes('--json')

function main() {
  const pending = scanLegacyLibraries()
  const report = { ok: true, applied: false, dataDir: dataDir(), pending, backup: null, libraries: [] }

  if (pending.length === 0) {
    report.libraries = migrateLibraries({ dryRun: true })
    return report
  }
  if (apply) {
    // A rewrite that cannot be undone is not a repair; the same backup the panel's
    // maintenance button takes, with a manifest the restore path understands.
    report.backup = state.backupDatabases()
    report.applied = true
    report.libraries = migrateLibraries()
    state.flushState()
  } else {
    report.libraries = migrateLibraries({ dryRun: true })
  }
  return report
}

let report
try {
  report = main()
} catch (error) {
  const failed = { ok: false, error: String(error?.message || error) }
  if (json) console.log(JSON.stringify(failed, null, 2))
  else console.error(`migration failed: ${failed.error}`)
  process.exit(1)
}

const leftovers = report.libraries.filter((lib) => lib.after > 0)
if (leftovers.length) report.ok = false

if (json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`data: ${report.dataDir}`)
  if (!report.libraries.length) {
    console.log('no library stores the removed "session" level.')
  }
  for (const lib of report.libraries) {
    const where = lib.name ? `${lib.libraryId} (${lib.name})` : lib.libraryId
    if (lib.error) console.log(`  ${where}: FAILED ${lib.error}`)
    else if (lib.before === 0) console.log(`  ${where}: clean`)
    else console.log(`  ${where}: ${lib.before} legacy ${plural(lib.before)} -> shared, dead session id removed (context kept)`)
  }
  if (report.backup) console.log(`backup: ${path.resolve(report.backup)}`)
  if (!apply && report.libraries.some((lib) => lib.before > 0)) {
    console.log('nothing written; re-run with --apply to rewrite (a backup is taken first).')
  }
  if (report.ok && report.applied) console.log('done.')
}

function plural(n) {
  return n === 1 ? 'memory' : 'memories'
}

if (!report.ok) process.exit(report.applied ? 1 : 3)
