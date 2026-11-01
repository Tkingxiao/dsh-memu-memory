// One-time upgrade: memories written by an older version with `visibility: 'session'`
// become `shared` in the folder they live in. `context` is never touched, so a memory
// that was scoped to one character or one branch stays scoped after the upgrade — the
// upgrade only drops the dimension that made no sense (the owning conversation).
//
// Reading is already correct without this pass (`lib/state.js` normalizes on load), so
// the pass exists to rewrite the files: a library nobody writes to again would otherwise
// keep the dead `sessionId` fields on disk forever, and an auditor reading the JSON would
// have to know about a level the code no longer has.
//
// The lexicon half (§2.1 of the construction spec) is the same shape: older builds
// wrote `pending` proposals and revision drafts; the current lifecycle has only active/archived. The rewrite rule
// lives in `lib/lexicon.js` (`migrateLegacyLexiconStatuses`); this file only finds the
// files and runs it, one library at a time, so a single corrupt lexicon cannot take the
// sweep — or startup — down with it.
import fs from 'node:fs'
import path from 'node:path'
import { dataDir, indexDir, isSafeId, readJson, readJsonStrict, stamp } from './paths.js'
import { listLibrariesAll, updatePrivateIndex } from './state.js'
import { countLegacyInRaw, migrateEntryVisibility } from './visibility.js'
import { migrateLegacyLexiconStatuses } from './lexicon.js'

const DEFAULT_MIN_INTERVAL_MS = 60_000
const lastRun = { at: 0 }

// `<libraryId>.json` is the memory index; the same directory also holds
// `<libraryId>.entities.json`, `.media.json`, `.stats.json` and `global.json`, none of
// which carry entries of their own.
function indexLibraryIds() {
  let names = []
  try { names = fs.readdirSync(indexDir()) } catch { return [] }
  return names
    .filter((name) => {
      if (!name.endsWith('.json')) return false
      const id = name.slice(0, -'.json'.length)
      // `lib_x.entities.json` and friends share the prefix; only the bare id is an index.
      return id !== 'global' && !id.includes('.')
    })
    .map((name) => name.slice(0, -'.json'.length))
    .sort()
}

function indexFile(libraryId) {
  return path.join(indexDir(), `${libraryId}.json`)
}

function legacyCount(libraryId) {
  return countLegacyInRaw(readJson(indexFile(libraryId), null))
}

/**
 * Libraries that still store the removed `session` level, counted on the raw file.
 * Public because the repair script has to answer "is there anything to do?" before it
 * takes a backup.
 */
export function scanLegacyLibraries() {
  return indexLibraryIds()
    .map((libraryId) => ({ libraryId, legacy: legacyCount(libraryId) }))
    .filter((report) => report.legacy > 0)
}

/**
 * Rewrite every library that still carries the removed level.
 *
 * `dryRun` reports without touching a file. Each report carries `before` / `after` so a
 * caller can prove the rewrite landed instead of trusting that the write "should" have
 * worked: the load path normalizes in memory, which means an in-memory count is always
 * one step ahead of the disk.
 */
export function migrateLibraries({ dryRun = false, now = stamp() } = {}) {
  const names = new Map(listLibrariesAll().map((library) => [library.id, library.name]))
  const reports = []
  for (const { libraryId, legacy } of scanLegacyLibraries()) {
    const report = {
      libraryId,
      name: names.get(libraryId) || null,
      before: legacy,
      after: legacy,
      migrated: 0,
    }
    if (!dryRun) {
      try {
        let migrated = 0
        // The load path already normalizes in memory, so this loop usually finds nothing
        // to count — but it is the step that makes the write carry the result, and it
        // costs nothing to keep the rule in one place (`lib/visibility.js`).
        updatePrivateIndex(libraryId, (index) => {
          for (const entry of Object.values(index.entries || {})) {
            if (migrateEntryVisibility(entry, now)) migrated += 1
          }
        })
        report.migrated = migrated
        report.after = legacyCount(libraryId)
        // The mutator sees an already-normalized index (the load path did the work), so
        // its own count is usually 0. What matters is the difference on disk.
        report.migrated = Math.max(0, report.before - report.after)
      } catch (error) {
        report.error = String(error?.message || error)
      }
    }
    reports.push(report)
  }
  return reports
}

/**
 * Throttled version for the hot paths (sidebar poll, cycle tick). `lastRun.at` is
 * stamped before the scan: a library that keeps failing to rewrite must not turn every
 * poll into a full directory read.
 */
export function maybeMigrateLibraries({ minIntervalMs = DEFAULT_MIN_INTERVAL_MS, now = stamp() } = {}) {
  const ms = Date.parse(now) || Date.now()
  if (ms - lastRun.at < minIntervalMs) return []
  lastRun.at = ms
  if (scanLegacyLibraries().length === 0) return []
  return migrateLibraries({ now })
}

// ── lexicon lifecycle (§2.1): pending → active/archived ─────────────────────────
// The directory holds exactly `<libraryId>.json`; a name that does not pass `isSafeId`
// is skipped rather than guessed at, the same path boundary `lib/lexicon.js` enforces
// before it builds a filename.

function lexiconDir() {
  return path.join(dataDir(), 'lexicon')
}

/** Library ids that own a lexicon file. Sorted, safe names only. */
export function scanLexiconLibraries() {
  let names = []
  try { names = fs.readdirSync(lexiconDir()) } catch { return [] }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((id) => isSafeId(id))
    .sort()
}

// Counted on the raw file, before any load-time interpretation, so a sweep can tell a
// library that still needs the rewrite from one that is already migrated. `readJsonStrict`
// (not `readJson`) on purpose: a scan must not move files, and `readJson` quarantines a
// corrupt one as a side effect. A file that does not parse counts 0 — it cannot hold
// statuses to migrate, and `lib/lexicon.js` already blocks writes to it until restored.
function legacyLexiconCount(libraryId) {
  const result = readJsonStrict(path.join(lexiconDir(), `${libraryId}.json`))
  if (!result.ok) return 0
  const terms = result.value?.terms
  if (!terms || typeof terms !== 'object') return 0
  return Object.values(terms).filter((entry) => entry && entry.status === 'pending').length
}

/** Lexicon files that still hold legacy `pending` entries. */
export function scanLegacyLexiconLibraries() {
  return scanLexiconLibraries()
    .map((libraryId) => ({ libraryId, legacy: legacyLexiconCount(libraryId) }))
    .filter((report) => report.legacy > 0)
}

/**
 * Rewrite every lexicon that still carries `pending` entries.
 *
 * Per-library try/catch is the point: a single corrupt or write-protected lexicon must
 * not stop the others, and must never abort startup (the pass runs from the cycle tick).
 * A library with nothing to do is not written at all — `migrateLegacyLexiconStatuses`
 * skips the write (and the revision bump) when no entry changed.
 */
export function migrateLexiconLibraries() {
  const reports = []
  for (const { libraryId, legacy } of scanLegacyLexiconLibraries()) {
    try {
      const result = migrateLegacyLexiconStatuses(libraryId)
      reports.push({
        libraryId,
        before: legacy,
        migrated: result.migrated,
        ...(result.details ? { details: result.details } : {}),
      })
    } catch (error) {
      reports.push({ libraryId, before: legacy, migrated: 0, error: String(error?.message || error) })
    }
  }
  return reports
}

export function runVisibilityMigrationPass({ now = stamp(), log = () => {} } = {}) {
  const reports = migrateLibraries({ now })
  for (const report of reports) {
    if (report.error) log(`visibility migration failed for ${report.libraryId}: ${report.error}`)
    else if (report.migrated > 0) log(`migrated ${report.migrated} legacy memory/memories to shared in ${report.libraryId}`)
  }
  // §2.1: legacy lexicons may still carry pending proposals/revision drafts. The rewrite is
  // idempotent and only writes files that change, so running it on every cycle tick
  // costs a directory read plus one JSON parse per file that still has pending entries.
  const lexicon = migrateLexiconLibraries()
  for (const report of lexicon) {
    if (report.error) log(`lexicon lifecycle migration failed for ${report.libraryId}: ${report.error}`)
    else if (report.migrated > 0) log(`migrated ${report.migrated} legacy lexicon term(s) to the active/archived lifecycle in ${report.libraryId}`)
  }
  return { reports, lexicon }
}
