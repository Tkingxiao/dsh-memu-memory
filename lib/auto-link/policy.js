// Versioned constants for the auto-link pipeline. They are nomination/ranking
// bounds and write caps — never a "should this edge exist" threshold. Whether an
// edge is written is decided only by the deterministic rule table, so tuning
// these numbers cannot turn a lexical coincidence into a fact.
//
// Online code reads this frozen table; calibration happens offline and ships as
// a new table version.

export const AUTOLINK_POLICY_VERSION = 3
export const AUTOLINK_SCHEMA_VERSION = 2

export const AUTOLINK_POLICY_V3 = Object.freeze({
  version: AUTOLINK_POLICY_VERSION,
  schemaVersion: AUTOLINK_SCHEMA_VERSION,

  // Nomination (S1): CJK n-grams and boundary-safe Latin tokens.
  ngramCjkMin: 2,
  ngramCjkMax: 4,
  latinMin: 3,
  latinMax: 24,
  minDf: 2,
  maxDfRatio: 0.35,
  minAvEachSide: 2,
  minLLR: 10.83,
  minCohesion: 3.0,
  minFreedom: 1.0,
  minTitleDf: 2,
  minCues: 2,
  tier1Max: 40,
  tier2Max: 100,
  vectorLocalTopM: 200,

  // Writes. entity-mention is a fact index and is not capped per memory; these
  // caps bound optional related edges and the review queue.
  maxAutoEdgesPerMemory: 6,
  maxPerConsolidation: 3,
  maxMentionEdgesPerEntity: 200,
})

export const EVIDENCE_RULES = Object.freeze(['entity-mention', 'conflict', 'supersede', 'fact-key', 'worker-quote'])

export const ENTITY_STATUS = Object.freeze(['provisional', 'confirmed', 'archived'])
