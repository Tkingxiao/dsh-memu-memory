// One-time upgrade: memories written by an older version with `visibility: 'session'`
// become `shared` in the folder they live in. `context` is never touched, so a memory
// that was scoped to one character or one branch stays scoped after the upgrade — the
// upgrade only drops the dimension that made no sense (the owning conversation).
//
// Reading is already correct without this pass (`lib/state.js` normalizes on load), so
// the pass exists to rewrite the files: a library nobody writes to again would otherwise
// keep the dead `sessionId` fields on disk forever, and an auditor reading the JSON would
// have to know about a level the code no longer has.
import fs from 'node:fs'
import path from 'node:path'
import { indexDir, readJson, stamp } from './paths.js'
import { listLibrariesAll, updatePrivateIndex } from './state.js'
import { countLegacyInRaw, migrateEntryVisibility } from './visibility.js'

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

export function runVisibilityMigrationPass({ now = stamp(), log = () => {} } = {}) {
  const reports = migrateLibraries({ now })
  for (const report of reports) {
    if (report.error) log(`visibility migration failed for ${report.libraryId}: ${report.error}`)
    else if (report.migrated > 0) log(`migrated ${report.migrated} legacy memory/memories to shared in ${report.libraryId}`)
  }
  return { reports }
}
