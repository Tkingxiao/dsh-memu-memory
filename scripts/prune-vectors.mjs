#!/usr/bin/env node
// P2-5 vector generation GC. Dry-run by default. --apply deletes only
// generation files that are not referenced by the active/pending manifest,
// older than --keep generations, and older than the retention window.
import { pruneVectorArtifacts } from '../lib/vector-profile.js'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const valueOf = (name, fallback) => {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const value = Number(args[index + 1])
  if (!Number.isFinite(value) || value < 0) {
    console.error(`prune-vectors: ${name} must be a non-negative number`)
    process.exit(2)
  }
  return value
}
const result = pruneVectorArtifacts({
  apply,
  keepGenerations: valueOf('--keep', 2),
  olderThanDays: valueOf('--days', 7),
})
console.log(JSON.stringify(result, null, 2))
