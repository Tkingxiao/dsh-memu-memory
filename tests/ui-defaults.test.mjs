import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// L3 audit item: the settings page in lib/client.js renders a hard-coded
// fallback for every numeric field (`settings.x ?? N`). The browser bundle
// cannot import lib/state.js, so those literals are the only client-side copy
// of DEFAULT_SETTINGS. They had drifted (privateTopK 4 vs 5, globalTopK 3 vs 5,
// dedupeTurns 8 vs 16, ...), and because the fallback paints before the first
// getState reply, saving in that window persisted the wrong value.
// This gate keeps the two lists equal.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const state = await import(new URL('../lib/state.js', import.meta.url).href)
const clientSource = fs.readFileSync(path.join(REPO, 'lib', 'client.js'), 'utf8')

function clientFallbacks() {
  const found = new Map()
  for (const match of clientSource.matchAll(/settings\.([A-Za-z0-9_]+)\s*\?\?\s*(-?\d+(?:\.\d+)?)/g)) {
    const key = match[1]
    const value = Number(match[2])
    assert.ok(!found.has(key), 'settings.' + key + ' has more than one fallback literal in lib/client.js')
    found.set(key, value)
  }
  return found
}

test('every client-side settings fallback equals its DEFAULT_SETTINGS value', () => {
  const fallbacks = clientFallbacks()
  assert.ok(fallbacks.size >= 10, 'expected the settings grid fallbacks to be discoverable, found ' + fallbacks.size)
  const drift = []
  for (const [key, value] of fallbacks) {
    const expected = state.DEFAULT_SETTINGS[key]
    if (typeof expected !== 'number') continue
    if (expected !== value) drift.push('settings.' + key + ' ?? ' + value + ' but DEFAULT_SETTINGS.' + key + ' is ' + expected)
  }
  assert.deepEqual(drift, [], 'client fallbacks drifted from DEFAULT_SETTINGS: ' + drift.join('; '))
})

test('the audited numeric fields are covered by that gate', () => {
  const fallbacks = clientFallbacks()
  for (const [key, expected] of [
    ['privateTopK', 5],
    ['globalTopK', 5],
    ['mustRememberCap', 12],
    ['dedupeTurns', 16],
    ['globalEveryNTurns', 6],
    ['randomCueChance', 0.02],
    ['sleepAfterIdleMinutes', 3],
  ]) {
    assert.equal(fallbacks.get(key), expected, 'settings.' + key + ' fallback')
    assert.equal(state.DEFAULT_SETTINGS[key], expected, 'DEFAULT_SETTINGS.' + key)
  }
})
