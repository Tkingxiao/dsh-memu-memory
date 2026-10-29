import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-mood-'))
process.env.DSH_MEMU_HOME = home

const state = await import('../lib/state.js')
const mood = await import('../lib/mood.js')
const { normalizeSalientDate } = await import('../lib/memory.js')
const inject = await import('../lib/inject.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

test('readMood signs the present state without reading meaning', () => {
  assert.ok(mood.readMood('今天太开心了，测试全部通过').valence > 0)
  assert.ok(mood.readMood('我很难受，一点都跑不起来').valence < 0)
  assert.equal(mood.readMood('把 index.js 里的 import 改成相对路径').valence, 0)
})

test('mood congruence pulls same-signed memories up and pushes opposites down', () => {
  assert.ok(mood.moodCongruence(-0.8, -0.6) > 0)
  assert.ok(mood.moodCongruence(0.8, -0.6) < 0)
  assert.equal(mood.moodCongruence(0.8, 0), 0)
})

test('mood fades to neutral instead of holding all day', () => {
  const now = Date.now()
  const fresh = mood.moodDecay({ valence: -0.8, arousal: 0.9, at: now }, now)
  const later = mood.moodDecay({ valence: -0.8, arousal: 0.9, at: now }, now + 6 * 60 * 60 * 1000)
  assert.ok(Math.abs(later.valence) < Math.abs(fresh.valence))
  assert.ok(later.arousal < fresh.arousal && later.arousal >= 0.35)
  assert.equal(mood.moodDecay(null, now).valence, 0)
})

test('salient dates keep the year when one is given and refuse anything unparseable', () => {
  assert.equal(normalizeSalientDate('3-05'), '03-05')
  // A full date keeps its year: it is one day, not an anniversary that recurs.
  assert.equal(normalizeSalientDate('2026-03-05T00:00:00.000Z'), '2026-03-05')
  assert.equal(normalizeSalientDate('下次再说'), null)
  assert.equal(normalizeSalientDate('13-40'), null)
  assert.equal(normalizeSalientDate(null), null)
})

test('an anniversary fires once per day and not again', () => {
  const binding = state.ensureSession('mood-anniv', { cwd: path.join(home, 'p-anniv'), agentPreset: 'rp' })
  const now = new Date()
  const md = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const index = state.loadPrivateIndex(binding.libraryId)
  index.entries['mem-anniv'] = {
    track: 'memory', layer: 'long_term', title: '第一次一起看海', content: '那天下着小雨。',
    status: 'active', salientDate: md, createdAt: now.toISOString(), updatedAt: now.toISOString(),
  }
  state.savePrivateIndex(binding.libraryId, index)

  const first = inject.buildAnniversary('mood-anniv', binding, now)
  assert.match(first.text, /memory-anniversary/)
  assert.match(first.text, /第一次一起看海/)
  assert.deepEqual(first.ids, ['mem-anniv'])

  state.markAnniversaryShown('mood-anniv', 'mem-anniv', first.dayKey)
  const second = inject.buildAnniversary('mood-anniv', binding, now)
  assert.equal(second.text, '')
})

test('an anniversary on a different day stays silent', () => {
  const binding = state.ensureSession('mood-anniv2', { cwd: path.join(home, 'p-anniv2'), agentPreset: 'rp' })
  const index = state.loadPrivateIndex(binding.libraryId)
  index.entries['mem-someday'] = {
    track: 'memory', layer: 'long_term', title: '某个九月', content: '', status: 'active',
    salientDate: '09-21', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
  state.savePrivateIndex(binding.libraryId, index)
  const out = inject.buildAnniversary('mood-anniv2', binding, new Date('2026-03-05T12:00:00'))
  assert.equal(out.text, '')
})

test('low-confidence memory is injected as a hedge, not a fact', () => {
  const binding = state.ensureSession('mood-fuzzy', { cwd: path.join(home, 'p-fuzzy'), agentPreset: 'rp' })
  const index = state.loadPrivateIndex(binding.libraryId)
  index.entries['mem-fuzzy'] = {
    track: 'memory', layer: 'long_term', title: '也许养过一只猫', content: '记不清了。',
    status: 'active', confidence: 0.3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
  index.entries['mem-solid'] = {
    track: 'memory', layer: 'must_remember', title: '对花生过敏', content: '确定。',
    status: 'active', confidence: 0.95, pinReason: '安全相关', pinSource: 'user_explicit',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
  state.savePrivateIndex(binding.libraryId, index)
  const anchor = inject.buildAnchor(binding, { ...state.getSettings(), anchorTokens: 1200 })
  const fuzzyLine = anchor.text.split('\n').find((l) => l.includes('mem-fuzzy'))
  const solidLine = anchor.text.split('\n').find((l) => l.includes('mem-solid'))
  assert.match(fuzzyLine, /记忆模糊/)
  assert.doesNotMatch(solidLine, /记忆模糊/)
})

test('session mood is stored on the binding and read back', () => {
  state.ensureSession('mood-store', { cwd: path.join(home, 'p-store'), agentPreset: 'rp' })
  state.setSessionMood('mood-store', { valence: -0.6, arousal: 0.8 })
  const stored = state.getSessionMood('mood-store')
  assert.equal(stored.valence, -0.6)
  assert.equal(stored.arousal, 0.8)
  assert.ok(typeof stored.at === 'number')
})
