// One ruler for "do these two memories say the same thing".
//
// 5: the recall side (candidate folding, MMR hard skip) and the
// write side (the duplicate gate) must measure with the same formula, or recall
// folds what write kept and vice versa. Everything here is deliberately
// dependency-free — two bigram sets and the Dice coefficient — and the text
// preprocessing is the one the contradiction check always used (lowercase, strip
// whitespace/punctuation/symbols), so findConflict's behaviour is unchanged by
// this extraction.

// Same fact: a recall cluster keeps one candidate, MMR hard-skips the rest.
export const DUP_DICE = 0.82
// Write-side reject: a new memory this close to an existing one is refused.
export const DUP_REJECT_DICE = 0.90
// Same topic, different fact: soft-penalty band on recall, duplicateOf tag on write.
export const TOPIC_DICE = 0.55
// Write-side pruning: skip the bigram pass when two texts differ in length by more
// than this fraction of the longer one. At this ratio Dice cannot reach the reject
// band even with zero unique bigrams on the short side.
export const LENGTH_PRUNE_RATIO = 0.5

// Length-disparate pairs (gap > LENGTH_PRUNE_RATIO) do not go through Dice — the
// ratio math makes a reject-band Dice impossible, which is exactly the hole a
// "rewrite it much longer" evader walks through. Two cheap containment probes
// close the hole without paying the full bigram pass:
//   * verbatim containment — the short cleaned text is a substring of the long one;
//   * core coverage — every character bigram of the short text occurs somewhere in
//     the long one ("核心词全含"), probed with String.includes so the long side is
//     never materialised into a bigram set and a miss fails fast on the first
//     absent gram.
// Both are strictly stronger signals than Dice ≥ DUP_REJECT_DICE (a verbatim or
// all-grams-contained overlap cannot be an accident), so they report a floor in
// the reject band instead of a made-up Dice value. Partial coverage deliberately
// reports 0: with a >0.5 length gap there is no honest way to say "same topic",
// and a false reject on the write side is worse than a rare paraphrase bypass —
// the residual risk (heavily reworded padding) is documented in 
export const CONTAINMENT_FLOOR = 0.92
export const CORE_COVER_FLOOR = DUP_REJECT_DICE
// Below this many cleaned characters the probe has too little signal (a 4-char
// string and its bigrams occur in unrelated texts all the time); above the max the
// probe budget is exceeded and both sides are substantial enough to trust the
// length prune again. Bounds keep the write-side gate O(|short|·|long|) native
// scans per pruned pair instead of O(N²) bigram-set construction.
const PROBE_MIN_CHARS = 6
const PROBE_MAX_CHARS = 240

/** The one text preprocessing every measurement here shares. */
export function clean(text) {
  return String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** Lowercase, strip whitespace/punctuation/symbols, then collect character bigrams. */
export function bigrams(text) {
  const c = clean(text)
  const out = new Set()
  for (let i = 0; i < c.length - 1; i += 1) out.add(c.slice(i, i + 2))
  return out
}

/** Dice coefficient over two bigram sets; 0 when either side is empty. */
export function dice(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  return (2 * shared) / (a.size + b.size)
}

/** |len(A)-len(B)| / max(len); 0 when both sides are empty. */
export function lengthGap(aText, bText) {
  const a = String(aText || '').length
  const b = String(bText || '').length
  return Math.abs(a - b) / Math.max(a, b, 1)
}

/**
 * Dice over raw texts with the write-side length pruning applied: pairs whose
 * lengths differ too much return 0 without paying for the bigram build (the
 * gate runs over the whole library on every write). 0 can never win a
 * max-similarity scan, so pruned pairs simply never become the best match —
 * unless they hit one of the two containment probes below, which are the only
 * way a length-disparate pair reaches the reject band.
 */
export function similarTexts(aText, bText) {
  const a = String(aText || '')
  const b = String(bText || '')
  if (lengthGap(a, b) > LENGTH_PRUNE_RATIO) {
    const aClean = clean(a)
    const bClean = clean(b)
    if (!aClean || !bClean) return 0
    const shortClean = aClean.length <= bClean.length ? aClean : bClean
    const longClean = aClean.length <= bClean.length ? bClean : aClean
    if (shortClean.length < PROBE_MIN_CHARS || shortClean.length > PROBE_MAX_CHARS) return 0
    // Probe 1: verbatim containment of the short text inside the long one.
    if (longClean.includes(shortClean)) return CONTAINMENT_FLOOR
    // Probe 2: core coverage — every bigram of the short text occurs in the long
    // one. includes() over the cleaned long text is exactly long-bigram-set
    // membership (a hit means the two characters are adjacent somewhere in the
    // long text), so no long-side set is ever built; the first absent gram ends
    // the probe.
    for (let i = 0; i < shortClean.length - 1; i += 1) {
      if (!longClean.includes(shortClean.slice(i, i + 2))) return 0
    }
    return CORE_COVER_FLOOR
  }
  return dice(bigrams(a), bigrams(b))
}
