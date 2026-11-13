import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AiSearchPlanSchema,
  AiSubscriptionPlanSchema,
  type AiSubscriptionPlan,
} from '@repo/schemas/ai-search'
import { albumBrowseFields, trackBrowseFields } from '@repo/schemas/browse'
import {
  aiSearchParams,
  aiSubscriptionSearchParams,
  describeAiSearchPlan,
  describeAiSubscriptionPlan,
  mediaAiSearchTarget,
  subscriptionAiSearchTarget,
} from './ai-search'
import {
  parseSubscriptionBrowseState,
  updateSubscriptionSearch,
} from './subscriptions'

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

test('track plans use the album URL parameters and clear album-only listening state', () => {
  const trackPlan = AiSearchPlanSchema.parse({
    q: 'live',
    filters: [{ field: 'playlist', value: 'Road trip', mode: 'required' }],
    ranges: [{ field: 'scrobbles', min: 1, max: 10, includeMissing: false }],
    sortBy: 'scrobbles',
    direction: 'desc',
    limitResults: null,
    listening: null,
    listeningSort: null,
  })
  assert.deepEqual(aiSearchParams(trackPlan), {
    q: 'live',
    filters: JSON.stringify(trackPlan.filters),
    ranges: JSON.stringify(trackPlan.ranges),
    listening: null,
    listeningSort: null,
    sortBy: 'scrobbles',
    direction: 'desc',
    limitResults: null,
    item: null,
  })
  const target = mediaAiSearchTarget('track', trackBrowseFields)
  assert.equal(target.mediaType, 'track')
  assert.deepEqual(target.describe(trackPlan), [
    'Search: live',
    'Required · Playlists: Road trip',
    'Scrobbles: at least 1, at most 10',
    'Sort: Scrobbles, descending',
  ])
})

const channel = { id: `UC${'c'.repeat(22)}`, title: 'Example Cooking' }
const podcast = {
  id: 'a'.repeat(22),
  type: 'spotify' as const,
  title: 'Example Science Hour',
}
function subscriptionPlan(overrides: Partial<AiSubscriptionPlan> = {}) {
  return AiSubscriptionPlanSchema.parse({
    q: '',
    fields: 'all',
    sources: [],
    types: [],
    publishedFrom: null,
    publishedTo: null,
    durationMinSec: null,
    durationMaxSec: null,
    sortBy: 'publishedAt',
    direction: 'desc',
    ...overrides,
  })
}

test('Subscriptions plans replace every search parameter, keep the view and close the drawer', () => {
  const plan = subscriptionPlan({
    q: 'orbit',
    fields: 'title',
    sources: [podcast, { ...channel, type: 'youtube' }],
    types: ['spotify'],
    publishedFrom: '2026-10-01',
    publishedTo: '2026-10-31',
    durationMinSec: 240,
    durationMaxSec: 1200,
    sortBy: 'durationSec',
    direction: 'asc',
  })
  const search = updateSubscriptionSearch(
    `q=old&filters=${encodeURIComponent('[{"field":"genre","value":"old"}]')}&view=list&columns=title,type&item=abcdefghijk`,
    aiSubscriptionSearchParams(plan),
  )
  assert.equal(search.get('item'), null)
  assert.deepEqual(parseSubscriptionBrowseState(search), {
    q: 'orbit',
    fields: 'title',
    filters: [
      { field: 'source', value: 'Example Science Hour', mode: 'any' },
      { field: 'source', value: 'Example Cooking', mode: 'any' },
      { field: 'type', value: 'Podcast', mode: 'required' },
    ],
    ranges: [
      {
        field: 'publishedAt',
        min: Date.parse('2026-10-01T00:00:00.000Z'),
        max: Date.parse('2026-10-31T23:59:59.999Z'),
        includeMissing: false,
      },
      { field: 'durationSec', min: 240, max: 1200, includeMissing: false },
    ],
    sortBy: 'durationSec',
    direction: 'asc',
    view: 'list',
    columns: ['title', 'type'],
  })
})

test('an empty Subscriptions plan clears previous filters and leaves relevance without a direction', () => {
  const search = updateSubscriptionSearch(
    `q=old&fields=title&ranges=${encodeURIComponent('[{"field":"viewCount","min":1}]')}&direction=asc`,
    aiSubscriptionSearchParams(subscriptionPlan({ sortBy: 'relevance' })),
  )
  assert.equal(search.toString(), 'sortBy=relevance')
  assert.equal(
    updateSubscriptionSearch(
      'q=old',
      aiSubscriptionSearchParams(subscriptionPlan({ fields: 'title' })),
    ).toString(),
    'sortBy=publishedAt&direction=desc',
  )
})

test('Subscriptions plan review lists sources, type, dates, durations and sort', () => {
  assert.deepEqual(
    describeAiSubscriptionPlan(
      subscriptionPlan({
        q: 'orbit',
        fields: 'title',
        sources: [podcast],
        types: ['youtube'],
        publishedFrom: '2026-10-01',
        durationMinSec: 1201,
        sortBy: 'viewCount',
      }),
    ),
    [
      'Search: orbit (titles only)',
      'Channels: Example Science Hour',
      'Type: YouTube',
      'Published: 2026-10-01 to *',
      'Duration: 20:01 to *',
      'Sort: Views, descending',
    ],
  )
  assert.deepEqual(
    describeAiSubscriptionPlan(
      subscriptionPlan({ types: ['youtube', 'spotify'], sortBy: 'relevance' }),
    ),
    ['Sort: Relevance'],
  )
  assert.equal(subscriptionAiSearchTarget.mediaType, 'subscription')
  assert.equal(
    subscriptionAiSearchTarget.responseSchema.safeParse({
      plan: subscriptionPlan({ sources: [podcast] }),
      explanation: 'Episodes of one podcast.',
      assumptions: [],
      warnings: [],
    }).success,
    true,
  )
  assert.equal(
    subscriptionAiSearchTarget.responseSchema.safeParse({
      plan: { ...subscriptionPlan(), sourceNames: ['Example Science Hour'] },
      explanation: 'Unresolved source names are not a plan.',
      assumptions: [],
      warnings: [],
    }).success,
    false,
  )
})
