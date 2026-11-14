import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BrowseFilter } from '@repo/schemas/browse'
import { browseSuggestions } from './browse-suggestions'
import {
  defaultTrackColumns,
  formatTrackDuration,
  parseTrackFilters,
  trackTitleSuggestions,
  tracksHref,
  withTrackFilter,
} from './track-browse'

test('source is visible by default and can be included or excluded in saved filters', () => {
  assert.ok(defaultTrackColumns.includes('source'))
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
  assert.equal(formatTrackDuration(null), '-')
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
