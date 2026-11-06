import test from 'node:test'
import assert from 'node:assert/strict'

import { detectQueryIntent, decomposeQuery, extractQueryEntities } from '../lib/text-retrieval.js'
import { intentTopK, recallIntentBudget, RECALL_INTENT_TOPK } from '../lib/budget.js'

const NOW = new Date('2026-11-06T04:00:00Z')

test('intent detection covers the six recall strategies', () => {
  assert.equal(detectQueryIntent('我们上次说的地板颜色到底哪个对'), 'conflict')
  assert.equal(detectQueryIntent('你答应过我什么时候查机票'), 'commitment')
  assert.equal(detectQueryIntent('那件事你别告诉别人'), 'boundary')
  assert.equal(detectQueryIntent('下周三是几号'), 'date')
  assert.equal(detectQueryIntent('今天有什么安排'), 'date')
  assert.equal(detectQueryIntent('"林眠"住在哪里'), 'entity')
  assert.equal(detectQueryIntent('窗外的雨停了'), 'general')
  assert.equal(detectQueryIntent(''), 'general')
})

test('queries are decomposed into dates, entities and an expanded search string', () => {
  const decomposed = decomposeQuery('下周三跟"林眠"约了几点', null, {
    now: NOW, knownEntities: ['林眠', 'Yuike'],
  })
  assert.equal(decomposed.intent, 'date', 'a time word outranks the quoted entity')
  assert.deepEqual(decomposed.dates, ['2026-11-11'])
  assert.deepEqual(decomposed.entities, ['林眠'])
  assert.match(decomposed.expanded, /2026-11-11/)
  assert.match(decomposed.expanded, /林眠/)

  const named = decomposeQuery('Yuike 上次提到的地点', null, { now: NOW, knownEntities: ['Yuike', '林眠'] })
  assert.equal(named.intent, 'date', '上次 makes this a time question')
  assert.deepEqual(named.entities, ['Yuike'])

  const entity = decomposeQuery('"林眠"住在哪里', null, { now: NOW })
  assert.equal(entity.intent, 'entity')
  assert.deepEqual(entity.entities, ['林眠'])

  assert.deepEqual(decomposeQuery('').dates, [])
  assert.deepEqual(decomposeQuery('', null, { now: NOW }).entities, [])
})

test('entity extraction only trusts explicit markers or a known-entity table', () => {
  assert.deepEqual(extractQueryEntities('“Yuike”和「林眠」都在'), ['Yuike', '林眠'])
  assert.deepEqual(extractQueryEntities('@yuike 说了什么'), ['yuike'])
  assert.deepEqual(extractQueryEntities('Yuike 说了什么', { knownEntities: ['Yuike'] }), ['Yuike'])
  assert.deepEqual(extractQueryEntities('一个普通句子'), [])
  assert.deepEqual(extractQueryEntities('“x”'), [], 'one character is not an entity handle')
})

test('intent budgets raise the candidate count without overriding a larger explicit topK', () => {
  assert.deepEqual(RECALL_INTENT_TOPK, { general: 5, date: 8, entity: 8, conflict: 6, commitment: 5, boundary: 5 })
  assert.equal(intentTopK('general', 3), 3)
  assert.equal(intentTopK('general', 0), 5)
  assert.equal(intentTopK('date', 3), 8)
  assert.equal(intentTopK('entity', 5), 8)
  assert.equal(intentTopK('conflict', 5), 6)
  assert.equal(intentTopK('date', 10), 10, 'a deliberate larger request is kept')
  assert.equal(intentTopK('date', 50), 20, 'but never unbounded')
  assert.equal(intentTopK('unknown', 4), 4)
  assert.deepEqual(recallIntentBudget('conflict', { privateTopK: 4 }), { intent: 'conflict', topK: 6 })
  assert.deepEqual(recallIntentBudget('nope', { privateTopK: 2 }), { intent: 'general', topK: 2 })
})
