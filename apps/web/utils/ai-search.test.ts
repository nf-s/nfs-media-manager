import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AiMixPlanSchema,
  AiSearchPlanSchema,
  AiSubscriptionPlanSchema,
  type AiMixPlan,
  type AiSubscriptionPlan,
} from '@repo/schemas/ai-search'
import { albumBrowseFields, trackBrowseFields } from '@repo/schemas/browse'
import { artistBrowseFields } from '@repo/schemas/artist-browse'
import { trackMatchDiagnosticFields } from '@repo/schemas/match-diagnostics'
import {
  aiMixSearchParams,
  aiSearchParams,
  aiSubscriptionSearchParams,
  describeAiMixPlan,
  describeAiSearchPlan,
  describeAiSubscriptionPlan,
  mediaAiSearchTarget,
  mixAiSearchTarget,
  subscriptionAiSearchTarget,
} from './ai-search'
import { trackMatchDiagnosticsQuery } from './match-diagnostics'
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
  assert.match(descriptions, /Required · Tags: Rock/)
  assert.match(descriptions, /RYM rating: at least 4\/5/)
  assert.match(
    descriptions,
    /all conditions: At most 10 track plays · last 5 years; At least 100 track plays · through 2020-12-31/,
  )
  assert.match(descriptions, /Sort: Scrobbles · last 5 years, ascending/)
})

test('a track preview counts plays and an artist preview track plays', () => {
  const listening = AiSearchPlanSchema.parse({
    ...plan,
    filters: [],
    ranges: [],
    listening: {
      match: 'any',
      rules: [
        { period: { kind: 'rolling', amount: 1, unit: 'years' }, max: 0 },
      ],
    },
  })
  assert.match(
    describeAiSearchPlan(listening, trackBrowseFields, 'track').join('\n'),
    /Listening · any condition: No plays · last year/,
  )
  assert.match(
    describeAiSearchPlan(listening, artistBrowseFields, 'artist').join('\n'),
    /Listening · any condition: No track plays · last year/,
  )
  assert.deepEqual(
    mediaAiSearchTarget('track', trackBrowseFields).describe(listening),
    describeAiSearchPlan(listening, trackBrowseFields, 'track'),
  )
})

test('track plans use the album URL parameters and clear unused listening state', () => {
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

test('Tracks Matches applies AI playability and keeps older evidence-only plans independent', () => {
  const evidenceOnly = AiSearchPlanSchema.parse({
    ...plan,
    filters: [{ field: 'matchProvider', value: 'Spotify', mode: 'exclude' }],
    ranges: [],
    listening: null,
    listeningSort: null,
    sortBy: 'title',
  })
  const playableAlternate = AiSearchPlanSchema.parse({
    ...evidenceOnly,
    playability: 'alternate',
  })
  const target = mediaAiSearchTarget(
    'track',
    trackMatchDiagnosticFields,
    'matches',
  )
  assert.ok(
    target.describe(playableAlternate).includes('Playable via another version'),
  )
  for (const search of [evidenceOnly, playableAlternate]) {
    const params = new URLSearchParams({ playability: 'unavailable' })
    for (const [key, value] of Object.entries(
      aiSearchParams(search, target.context),
    )) {
      if (value === null) params.delete(key)
      else params.set(key, value)
    }
    const query = trackMatchDiagnosticsQuery(params)
    assert.equal(query.playability, search.playability ?? 'all')
    assert.deepEqual(query.filters, evidenceOnly.filters)
  }
  assert.ok(!('playability' in aiSearchParams(playableAlternate)))
})

test('artist plans use the shared search parameters and describe every applied condition', () => {
  const artistPlan = AiSearchPlanSchema.parse({
    q: '',
    filters: [
      { field: 'playlist', value: 'Example favorites', mode: 'required' },
    ],
    ranges: [{ field: 'albumCount', min: 2, includeMissing: false }],
    sortBy: 'trackCount',
    direction: 'desc',
    limitResults: 25,
    listening: null,
    listeningSort: null,
  })
  const target = mediaAiSearchTarget('artist', artistBrowseFields)
  assert.equal(target.mediaType, 'artist')
  assert.deepEqual(aiSearchParams(artistPlan), {
    q: null,
    filters: JSON.stringify(artistPlan.filters),
    ranges: JSON.stringify(artistPlan.ranges),
    listening: null,
    listeningSort: null,
    sortBy: 'trackCount',
    direction: 'desc',
    limitResults: '25',
    item: null,
  })
  assert.deepEqual(target.describe(artistPlan), [
    'Required · Playlists: Example favorites',
    'Albums: at least 2',
    'Sort: Tracks, descending',
    'Limit: 25 results',
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

function mixPlan(overrides: Partial<AiMixPlan> = {}) {
  return AiMixPlanSchema.parse({
    q: '',
    fields: 'all',
    sources: [],
    stations: [],
    filters: [],
    publishedFrom: null,
    publishedTo: null,
    durationMinSec: null,
    durationMaxSec: null,
    sortBy: 'publishedAt',
    direction: 'desc',
    ...overrides,
  })
}

test('Mixes plans set shows, stations, artists and tags on the Mixes URL and are reviewed in its words', () => {
  const plan = mixPlan({
    q: 'garage',
    sources: [
      {
        id: 'rinse.example-breakfast',
        type: 'rinse',
        title: 'Example Breakfast',
      },
    ],
    stations: ['rinse'],
    filters: [{ field: 'artist', value: 'Guest Selector', mode: 'required' }],
    publishedFrom: '2026-06-01',
    durationMinSec: 3600,
    sortBy: 'watchedAt',
    direction: 'asc',
  })
  const search = updateSubscriptionSearch(
    'view=list&item=rinse.old',
    aiMixSearchParams(plan),
  )
  const state = parseSubscriptionBrowseState(search, 'mixes')
  assert.equal(state.q, 'garage')
  assert.equal(state.view, 'list')
  assert.equal(search.has('item'), false)
  assert.deepEqual(state.filters, [
    { field: 'source', value: 'Example Breakfast', mode: 'any' },
    { field: 'type', value: 'Rinse FM', mode: 'required' },
    { field: 'artist', value: 'Guest Selector', mode: 'required' },
  ])
  assert.equal(state.sortBy, 'watchedAt')
  assert.equal(state.direction, 'asc')
  assert.deepEqual(describeAiMixPlan(plan), [
    'Search: garage',
    'Shows: Example Breakfast',
    'Station: Rinse FM',
    'Required · Artist: Guest Selector',
    'Broadcast: 2026-06-01 to *',
    'Duration: 1:00:00 to *',
    'Sort: Listened, ascending',
  ])
  assert.equal(mixAiSearchTarget.mediaType, 'mix')
  assert.equal(
    mixAiSearchTarget.responseSchema.safeParse({
      plan,
      explanation: 'Mixes of one show.',
      assumptions: [],
      warnings: [],
    }).success,
    true,
  )
  assert.deepEqual(describeAiMixPlan(mixPlan({ sortBy: 'relevance' })), [
    'Sort: Relevance',
  ])
})
