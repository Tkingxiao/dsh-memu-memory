#!/usr/bin/env node
// Auto-link migration / rebuild (DESIGN §14 S1–S4, local only).
//
//   node scripts/rebuild-auto-links.mjs                 # dry run for every library
//   node scripts/rebuild-auto-links.mjs --apply         # backup -> grade -> clean -> rebuild
//   node scripts/rebuild-auto-links.mjs --library lib_x --estimate-top 10
//
// Dry run is the default on purpose: it prints what would change and writes only
// the derived anchor-candidates.json queue. --apply takes a full backup first,
// grades pre-status entities, deletes every source:'auto' edge (legacy lexical
// noise and stale deterministic edges alike), then regenerates the deterministic
// edges for already-confirmed entities. Non-auto edges, text, vectors, attachments
// and suppression tables are never touched.


import path from 'node:path'
import { pathToFileURL } from 'node:url'

const RULES = new Set(['entity-mention', 'conflict', 'supersede', 'fact-key', 'worker-quote'])

export function parseArgs(argv) {
  const args = { apply: false, json: false, library: null, home: null, estimateTop: 8, includeArchived: false }
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--apply') args.apply = true
    else if (value === '--dry-run') args.apply = false
    else if (value === '--json') args.json = true
    else if (value === '--include-archived') args.includeArchived = true
    else if (value === '--library') args.library = argv[++index] || null
    else if (value === '--home') args.home = argv[++index] || null
    else if (value === '--estimate-top') args.estimateTop = Math.max(0, Number(argv[++index]) || 0)
    else throw new Error(`unknown argument: ${value}`)
  }
  return args
}

function autoEdgesOf(index) {
  const legacy = []
  const deterministic = []
  let nonAuto = 0
  for (const [from, entry] of Object.entries(index?.entries || {})) {
    for (const link of entry?.links || []) {
      if (!link) continue
      if (link.source !== 'auto') { nonAuto += 1; continue }
      const rule = link.evidence?.rule
      const row = { from, to: link.to, kind: link.kind, rule: rule || null }
      if (rule && RULES.has(rule)) deterministic.push(row)
      else legacy.push(row)
    }
  }
  return { legacy, deterministic, nonAuto }
}

async function loadModules() {
  const state = await import('../lib/state.js')
  const graph = await import('../lib/graph.js')
  const decide = await import('../lib/auto-link/decide.js')
  const apply = await import('../lib/auto-link/apply.js')
  const suppression = await import('../lib/auto-link/suppression.js')
  const candidates = await import('../lib/auto-link/candidates.js')
  const { record } = await import('../lib/activity-log.js')
  return { state, graph, decide, apply, suppression, candidates, record }
}

function countByRule(edges) {
  const counts = {}
  for (const edge of edges) counts[edge.rule] = (counts[edge.rule] || 0) + 1
  return counts
}

// Archived libraries are frozen by default, but a dry run that silently ignores
// most of the data reads as "nothing to migrate". Count what was skipped so the
// operator can decide to pass --include-archived.
function archivedSummary(modules, allLibraries) {
  const skipped = allLibraries.filter(library => library.archived === true)
  let memories = 0
  let legacyAutoEdges = 0
  for (const library of skipped) {
    try {
      const index = modules.state.loadPrivateIndex(library.id)
      memories += Object.keys(index.entries || {}).length
      legacyAutoEdges += autoEdgesOf(index).legacy.length
    } catch {}
  }
  return { libraries: skipped.length, memories, legacyAutoEdges }
}

/** Estimated mention edges if the top N queued names were confirmed. */
function estimateMention(modules, libraryId, queue, topN) {
  if (!topN) return { estimatedMentionEdges: 0, estimatedMemories: 0 }
  const { state, graph, decide } = modules
  const index = state.loadPrivateIndex(libraryId)
  const entities = graph.listEntities({ libraryId }).items.filter(entity => entity.status === 'confirmed').slice()
  const existing = new Set(entities.map(entity => entity.name))
  let added = 0
  for (const row of [...(queue?.tiers?.tier1 || []), ...(queue?.tiers?.tier2 || [])]) {
    if (added >= topN) break
    if (row.entityStatus === 'confirmed') continue
    if (existing.has(row.term)) continue
    entities.push({ id: `estimate-${added}`, name: row.term, kind: 'person', status: 'confirmed' })
    existing.add(row.term)
    added += 1
  }
  const edges = decide.mentionEdges(decide.eligibleEntries(index), entities)
  return {
    estimatedMentionEdges: edges.length,
    estimatedMemories: new Set(edges.map(edge => edge.from)).size,
    estimateConfirmed: added,
  }
}

async function inspectLibrary(modules, libraryId, { estimateTop = 8 } = {}) {
  const { state, graph, candidates } = modules
  const index = state.loadPrivateIndex(libraryId)
  const mine = autoEdgesOf(index)
  const grading = graph.gradeLegacyEntities({ libraryId, apply: false })
  const queue = candidates.generateAnchorCandidates({ libraryId })
  return {
    libraryId,
    memories: Object.keys(index.entries || {}).length,
    autoEdges: mine.legacy.length + mine.deterministic.length,
    legacyAutoEdges: mine.legacy.length,
    deterministicAutoEdges: mine.deterministic.length,
    deterministicByRule: countByRule(mine.deterministic),
    nonAutoEdges: mine.nonAuto,
    grading: { scanned: grading.scanned, provisional: grading.provisional, confirmed: grading.confirmed },
    queue: { tier1: queue?.totals?.tier1 || 0, tier2: queue?.totals?.tier2 || 0, provisionalEntities: queue?.entities?.provisional?.length || 0 },
    ...estimateMention(modules, libraryId, queue, estimateTop),
  }
}

async function applyLibrary(modules, libraryId) {
  const { state, graph, decide, apply, suppression, record } = modules
  const graded = graph.gradeLegacyEntities({ libraryId, apply: true })
  const index = state.loadPrivateIndex(libraryId)
  const before = autoEdgesOf(index)
  const entities = graph.listEntities({ libraryId }).items
  let supp = null
  try { supp = suppression.suppressionSet(libraryId) } catch { supp = null }

  // S3: every auto edge is derived data. Remove them all in one transaction,
  // keeping manual/user/worker edges exactly as they are.
  let removed = 0
  state.updatePrivateIndex(libraryId, fresh => {
    for (const entry of Object.values(fresh.entries || {})) {
      if (!Array.isArray(entry.links)) continue
      const kept = entry.links.filter(link => {
        const drop = link && link.source === 'auto'
        if (drop) removed += 1
        return !drop
      })
      if (kept.length !== entry.links.length) entry.links = kept
    }
  })

  // S4 for rows that were already confirmed: rebuild their deterministic edges
  // now, so the graph does not go blank while the review queue waits for a human.
  const desired = decide.decideAutoLinks({ index: state.loadPrivateIndex(libraryId), entities, suppression: supp })
  const applied = apply.applyAutoEdges({ libraryId, edges: desired, entities, operation: 'auto-link-migration' })

  try {
    record({
      kind: 'write', scope: 'private', libraryId, ok: true,
      message: `自动关联迁移：清理 ${removed} 条旧边，重建 ${applied.added + applied.updated} 条确定性边`,
      detail: {
        op: 'auto-link-migration', removed, legacy: before.legacy.length,
        rebuilt: applied.added + applied.updated, rules: countByRule(desired),
        graded: { provisional: graded.provisional, confirmed: graded.confirmed, changed: graded.changed },
      },
      refs: [],
    })
  } catch {}

  const after = autoEdgesOf(state.loadPrivateIndex(libraryId))
  return {
    libraryId,
    removedAutoEdges: removed,
    legacyRemoved: before.legacy.length,
    rebuiltAutoEdges: applied.added + applied.updated,
    rebuiltByRule: countByRule(desired),
    remainingAutoEdges: after.legacy.length + after.deterministic.length,
    remainingLegacyAutoEdges: after.legacy.length,
    graded: { scanned: graded.scanned, provisional: graded.provisional, confirmed: graded.confirmed, changed: graded.changed },
  }
}

/**
 * Run the migration for one data home. `home` must be set before this process
 * imports the plugin modules; callers that already imported them share that home.
 */
export async function runRebuildAutoLinks({ home = null, libraryId = null, apply = false, estimateTop = 8, json = false, includeArchived = false, log = console.log } = {}) {
  if (home) process.env.DSH_MEMU_HOME = home
  const modules = await loadModules()
  const libraries = (includeArchived ? modules.state.listLibrariesAll() : modules.state.listLibraries())
    .filter(lib => !libraryId || lib.id === libraryId)
  if (libraryId && libraries.length === 0) throw new Error(`unknown library: ${libraryId}`)
  const report = { home: home || null, apply, generatedAt: new Date().toISOString(), libraries: [], failures: [], ok: true, backup: null, skippedArchived: null }
  if (!includeArchived) {
    report.skippedArchived = archivedSummary(modules, modules.state.listLibrariesAll())
    if (!json && report.skippedArchived.libraries) {
      log(`skipped ${report.skippedArchived.libraries} archived library(ies): ${report.skippedArchived.memories} memories / ${report.skippedArchived.legacyAutoEdges} legacy auto edges; pass --include-archived to include them`)
    }
  }

  if (apply) {
    // One backup covers every library this run may touch.
    report.backup = await modules.state.backupDatabases()
    if (!json) log(`backup: ${report.backup}`)
  }

  for (const library of libraries) {
    let info
    try {
      info = apply ? await applyLibrary(modules, library.id) : await inspectLibrary(modules, library.id, { estimateTop })
    } catch (error) {
      // One corrupt store must not stop the rest; the failure is reported and the
      // exit code is non-zero so a scheduled run is visibly not a success.
      const failure = { libraryId: library.id, archived: library.archived === true, error: String(error?.message || error) }
      report.failures.push(failure)
      report.ok = false
      if (!json) log(`FAILED ${library.id} (${library.name || library.scopeKey || ''}): ${failure.error}`)
      continue
    }
    report.libraries.push(info)
    if (!json) {
      log(`${apply ? 'apply' : 'dry-run'} ${library.id} (${library.name || library.scopeKey || ''})${library.archived === true ? ' · archived' : ''}`)
      if (!apply) {
        log(`  memories ${info.memories} · auto ${info.autoEdges} (legacy ${info.legacyAutoEdges} / deterministic ${info.deterministicAutoEdges}) · non-auto ${info.nonAutoEdges}`)
        log(`  grading: ${info.grading.provisional} provisional / ${info.grading.confirmed} confirmed (no writes)`)
        log(`  queue: tier1 ${info.queue.tier1} · tier2 ${info.queue.tier2} · provisional entities ${info.queue.provisionalEntities}`)
        log(`  if the top ${info.estimateConfirmed || 0} queued names are confirmed: ~${info.estimatedMentionEdges} mention edges over ${info.estimatedMemories} memories`)
      } else {
        log(`  removed ${info.removedAutoEdges} auto edges (legacy ${info.legacyRemoved}) · rebuilt ${info.rebuiltAutoEdges} deterministic edges`)
        log(`  remaining auto ${info.remainingAutoEdges} (legacy ${info.remainingLegacyAutoEdges}) · graded ${info.graded.changed} entities`)
      }
    }
  }
  if (json) log(JSON.stringify(report, null, 2))
  return report
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  try {
    const args = parseArgs(process.argv)
    const report = await runRebuildAutoLinks(args)
    if (!report.ok) process.exitCode = 1
  } catch (error) {
    console.error(`rebuild-auto-links failed: ${error?.message || error}`)
    process.exitCode = 1
  }
}
