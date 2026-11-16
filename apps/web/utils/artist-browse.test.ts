import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  artistTitleSuggestions,
  parseArtistFilters,
  withArtistFilter,
} from './artist-browse'
import { browseSuggestions, matchingTitleFilters } from './browse-suggestions'

test('artist filters preserve modes and playlist selections intersect like Tracks', () => {
  const first = withArtistFilter([], { field: 'playlist', value: 'Morning' })
  const filters = withArtistFilter(first, {
    field: 'playlist',
    value: 'Evening',
  })
  assert.deepEqual(filters, [
    { field: 'playlist', value: 'Morning', mode: 'required' },
    { field: 'playlist', value: 'Evening', mode: 'required' },
  ])
  assert.equal(
    withArtistFilter(filters, { field: 'playlist', value: 'Morning' }),
    filters,
  )
  const excluded = withArtistFilter(filters, {
    field: 'genre',
    value: 'Rock',
    mode: 'exclude',
  })
  assert.deepEqual(parseArtistFilters(JSON.stringify(excluded)), excluded)
  assert.deepEqual(parseArtistFilters('{invalid'), [])
  assert.deepEqual(
    parseArtistFilters(JSON.stringify([{ field: 'durationSec', value: '20' }])),
    [],
  )
})

test('artist name suggestions use the shared multiword matching and ranking', () => {
  const options = [
    {
      field: 'name',
      value: 'New Example Artist',
      label: 'Artist: New Example Artist',
      count: 1,
    },
    {
      field: 'name',
      value: 'Example Artist',
      label: 'Artist: Example Artist',
      count: 1,
    },
    {
      field: 'name',
      value: 'Another Example',
      label: 'Artist: Another Example',
      count: 1,
    },
    {
      field: 'playlist',
      value: 'Example Artist Mix',
      label: 'Playlist: Example Artist Mix',
      count: 2,
    },
  ]
  assert.deepEqual(matchingTitleFilters(options, 'artist example', 'name'), [
    { field: 'name', value: 'Example Artist' },
    { field: 'name', value: 'New Example Artist' },
  ])
  const items = artistTitleSuggestions([
    { id: '2', name: 'New Example Artist' },
    { id: '1', name: 'Example Artist' },
  ])
  assert.deepEqual(
    browseSuggestions([], items, 'example artist').map(
      (option) => option.kind === 'item' && option.item.id,
    ),
    ['1', '2'],
  )
})
