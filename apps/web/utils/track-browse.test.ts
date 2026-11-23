import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BrowseFilter } from '@repo/schemas/browse'
import { browseSuggestions } from './browse-suggestions'
import {
  defaultTrackColumns,
  formatTrackDuration,
  loadTrackTitleMatches,
  orderedTrackBrowseFields,
  orderedTrackMatchBrowseFields,
  parseTrackFilters,
  trackTitleSuggestions,
  tracksHref,
  withTrackFilter,
} from './track-browse'

test('source and match columns default to hidden while source filters still work', () => {
  assert.ok(!defaultTrackColumns.includes('source'))
  assert.ok(!defaultTrackColumns.includes('spotifyMatch'))
  const included = withTrackFilter([], { field: 'source', value: 'Last.fm' })
  const filters = withTrackFilter(included, {
    field: 'source',
    value: 'Spotify playlists',
    mode: 'exclude',
  })
  const params = new URLSearchParams(tracksHref(filters).split('?')[1])
  assert.deepEqual(parseTrackFilters(params.get('filters')), [
    { field: 'source', value: 'Last.fm' },
    { field: 'source', value: 'Spotify playlists', mode: 'exclude' },
  ])
})

test('the Provider column follows Spotify match and is hidden by default', () => {
  assert.ok(!defaultTrackColumns.includes('provider'))
  const keys = orderedTrackBrowseFields.map((field) => field.key)
  assert.equal(keys.indexOf('provider'), keys.indexOf('spotifyMatch') + 1)
  assert.deepEqual(
    orderedTrackBrowseFields.find((field) => field.key === 'provider'),
    {
      key: 'provider',
      label: 'Provider',
      type: 'text',
      filterable: true,
    },
  )
  // Matches also has Provider match, the evidence on each entry.
  assert.deepEqual(
    orderedTrackMatchBrowseFields
      .filter((field) => ['provider', 'matchProvider'].includes(field.key))
      .map((field) => field.label),
    ['Provider ID', 'Provider match'],
  )
})

test('playlist filters added from the table intersect', () => {
  const first = withTrackFilter([], { field: 'playlist', value: 'Morning' })
  const both = withTrackFilter(first, { field: 'playlist', value: 'Evening' })
  assert.deepEqual(both, [
    { field: 'playlist', value: 'Morning', mode: 'required' },
    { field: 'playlist', value: 'Evening', mode: 'required' },
  ])
  assert.equal(
    withTrackFilter(both, { field: 'playlist', value: 'Morning' }),
    both,
  )
})

test('other filters keep the default mode and an explicit mode is kept', () => {
  assert.deepEqual(
    withTrackFilter([], { field: 'artist', value: 'Artist A' }),
    [{ field: 'artist', value: 'Artist A' }],
  )
  assert.deepEqual(
    withTrackFilter([], {
      field: 'playlist',
      value: 'Morning',
      mode: 'exclude',
    }),
    [{ field: 'playlist', value: 'Morning', mode: 'exclude' }],
  )
})

test('filter links round-trip through the URL parameter', () => {
  const filters: BrowseFilter[] = [
    { field: 'playlist', value: 'Morning', mode: 'required' },
  ]
  const href = tracksHref(filters)
  assert.equal(href.startsWith('/tracks?filters='), true)
  const params = new URLSearchParams(href.slice('/tracks?'.length))
  assert.deepEqual(parseTrackFilters(params.get('filters')), filters)
  assert.equal(tracksHref([]), '/tracks')
  assert.deepEqual(parseTrackFilters('not json'), [])
  assert.deepEqual(parseTrackFilters(null), [])
})

test('durations use minutes and seconds', () => {
  assert.equal(formatTrackDuration(null), '–')
  assert.equal(formatTrackDuration(5), '0:05')
  assert.equal(formatTrackDuration(245), '4:05')
})

test('title suggestions name the artists and rank exact titles first', () => {
  const suggestions = trackTitleSuggestions([
    { id: '2', title: 'Song B Extended', artists: ['Artist A'] },
    { id: '1', title: 'Song B', artists: ['Artist A', 'Artist B'] },
    { id: '3', title: 'Song B Live', artists: [] },
  ])
  assert.deepEqual(
    browseSuggestions([], suggestions, 'song b').map(
      (option) => option.kind === 'item' && option.item.label,
    ),
    [
      'Song B · Artist A, Artist B',
      'Song B Extended · Artist A',
      'Song B Live',
    ],
  )
})

test('title lookup requests only a browse row slice within the artist scope', async (t) => {
  const filters: BrowseFilter[] = [{ field: 'title', value: 'Song & Intro' }]
  const controller = new AbortController()
  const requests: { input: RequestInfo | URL; init?: RequestInit }[] = []
  t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init })
      return Response.json({
        statusCode: 200,
        message: 'OK',
        data: { items: [], page: 1, size: 100, hasMore: false },
      })
    },
  )
  assert.deepEqual(
    await loadTrackTitleMatches(
      '',
      filters,
      { creatorId: 'artist-example' },
      controller.signal,
    ),
    { items: [], page: 1, size: 100, hasMore: false },
  )
  assert.equal(requests.length, 1)
  const request = requests[0]
  assert.ok(request)
  const url = new URL(String(request.input), 'https://media.example')
  assert.equal(url.pathname, '/api/v1/tracks/browse-page')
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    page: '1',
    size: '100',
    filters: JSON.stringify(filters),
    sortBy: 'title',
    direction: 'asc',
    creatorId: 'artist-example',
  })
  assert.equal(request.init?.signal, controller.signal)
})
