import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AiSearchPlanSchema } from '@repo/schemas/ai-search'
import { albumBrowseFields } from '@repo/schemas/browse'
import { aiSearchParams, describeAiSearchPlan } from './ai-search'

const plan = AiSearchPlanSchema.parse({
  q: '',
  filters: [{ field: 'genre', value: 'rock', mode: 'required' }],
  ranges: [{ field: 'ratingRymValue', min: 4, includeMissing: false }],
  listening: {
    match: 'all',
    rules: [
      { period: { kind: 'rolling', amount: 5, unit: 'years' }, max: 10 },
      { period: { kind: 'dates', to: '2020-12-31' }, min: 100 },
    ],
  },
  listeningSort: { kind: 'rolling', amount: 5, unit: 'years' },
  sortBy: 'listeningScrobbles',
  direction: 'asc',
  limitResults: null,
})

test('AI plans replace every query constraint while preserving layout outside the update', () => {
  const params = aiSearchParams(plan)
  assert.equal(params.q, null)
  assert.equal(params.item, null)
  assert.equal(params.limitResults, null)
  assert.equal(params.listening, JSON.stringify(plan.listening))
  assert.equal(params.listeningSort, JSON.stringify(plan.listeningSort))
  assert.equal(params.sortBy, 'listeningScrobbles')
  assert.ok(!('view' in params))
  assert.ok(!('text' in params))
})

test('a new search clears listening constraints from a previous search', () => {
  const params = aiSearchParams({
    ...plan,
    filters: [],
    ranges: [],
    listening: null,
    listeningSort: null,
    sortBy: 'dateAdded',
  })
  assert.equal(params.listening, null)
  assert.equal(params.listeningSort, null)
  assert.equal(params.filters, null)
  assert.equal(params.ranges, null)
})

test('preview shows actual thresholds and listening logic independently of model explanation', () => {
  const descriptions = describeAiSearchPlan(plan, albumBrowseFields).join('\n')
  assert.match(descriptions, /Required · Tags: rock/)
  assert.match(descriptions, /RYM rating: at least 4\/5/)
  assert.match(
    descriptions,
    /all rules: at most 10 scrobbles · last 5 years; at least 100 scrobbles · through 2020-12-31/,
  )
  assert.match(descriptions, /Sort: Scrobbles · last 5 years, ascending/)
})
