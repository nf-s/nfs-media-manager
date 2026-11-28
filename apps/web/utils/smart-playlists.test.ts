import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LibraryPlaylistView } from '@repo/schemas/library-playlists'
import { defaultListeningPeriod } from '@repo/schemas/listening'
import {
  applyBrowseView,
  browseHasSmartPlaylists,
  browseView,
  browseViewHasCriteria,
  canonicalBrowseView,
  clearBrowseView,
  libraryPlaylistsHref,
  nothingToSaveReason,
  sameBrowseView,
  savedSmartPlaylistText,
  updatedSmartPlaylistText,
  updateSmartPlaylistLabel,
} from './smart-playlists'

const filters = (...list: object[]) => JSON.stringify(list)
const ambient = { field: 'genre', value: 'ambient', mode: 'any' }
const jazz = { field: 'genre', value: 'jazz', mode: 'any' }

test('every library with playlists offers smart playlists in Browse; Artists does not', () => {
  assert.equal(browseHasSmartPlaylists('albums'), true)
  assert.equal(browseHasSmartPlaylists('tracks'), true)
  assert.equal(browseHasSmartPlaylists('films'), true)
  assert.equal(browseHasSmartPlaylists('subscriptions'), true)
  assert.equal(browseHasSmartPlaylists('mixes'), true)
  assert.equal(browseHasSmartPlaylists(null), false)
})

test('a Subscriptions or Mixes view leaves out the library its Browse sends', () => {
  const params = new URLSearchParams({
    library: 'mixes',
    filters: filters({ field: 'genre', value: 'dub', mode: 'any' }),
    ranges: '[]',
    libraryScope: 'all',
    view: 'table',
  })
  const view = browseView('mixes', params, {
    sortBy: 'durationSec',
    direction: 'asc',
  })
  assert.deepEqual(view, {
    filters: filters({ field: 'genre', value: 'dub', mode: 'any' }),
    libraryScope: 'all',
    sortBy: 'durationSec',
    direction: 'asc',
  })
  assert.equal(browseViewHasCriteria('mixes', view), true)
  assert.equal(
    sameBrowseView('mixes', view, { ...view, libraryScope: 'all' }),
    true,
  )
  assert.equal(
    libraryPlaylistsHref('subscriptions'),
    '/playlists?mediaType=subscription',
  )
})

test('a view keeps the parameters the server keeps, with the order Browse shows', () => {
  const params = new URLSearchParams({
    q: '  rain ',
    filters: filters(ambient),
    ranges: '[]',
    tagLevels: 'track,album',
    listening: '',
    libraryScope: 'all',
    groupRecordings: 'true',
    view: 'table',
    density: 'roomy',
    columns: 'title,artist',
    columnOrder: 'artist',
    overlays: 'tags',
    smartPlaylist: 'smart-1',
    inspector: 'track:t1',
    page: '2',
  })
  assert.deepEqual(
    browseView('tracks', params, { sortBy: 'title', direction: 'asc' }),
    {
      libraryScope: 'all',
      groupRecordings: 'true',
      q: 'rain',
      filters: filters(ambient),
      tagLevels: 'track,album',
      sortBy: 'title',
      direction: 'asc',
    },
  )
  // Albums keep their archived and edition switches; Tracks have none.
  const albums = new URLSearchParams({
    includeArchived: 'true',
    editions: 'true',
    limitResults: '50',
  })
  assert.deepEqual(
    browseView('albums', albums, { sortBy: 'dateAdded', direction: 'desc' }),
    {
      includeArchived: 'true',
      editions: 'true',
      limitResults: '50',
      sortBy: 'dateAdded',
      direction: 'desc',
    },
  )
  assert.deepEqual(
    browseView('tracks', albums, { sortBy: 'dateAdded', direction: 'desc' }),
    { limitResults: '50', sortBy: 'dateAdded', direction: 'desc' },
  )
})

test('the order of values, Any left out and defaults left out do not change a view', () => {
  const saved = {
    filters: filters(ambient, jazz),
    sortBy: 'dateAdded',
    direction: 'desc',
  }
  assert.equal(
    sameBrowseView('tracks', saved, {
      filters: filters(
        { field: 'genre', value: 'jazz' },
        { field: 'genre', value: 'ambient' },
      ),
    }),
    true,
  )
  assert.equal(
    sameBrowseView(
      'albums',
      {
        q: 'rain',
        libraryScope: 'library',
        discoverySources: 'spotify,lastfm',
        discoverySourceMode: 'any',
        includeArchived: 'false',
        editions: 'false',
        listeningSort: JSON.stringify(defaultListeningPeriod),
        ranges: '[]',
      },
      { q: ' rain ', discoverySources: 'lastfm,spotify' },
    ),
    true,
  )
  // Tracks group recordings by default when sorted by scrobbles.
  assert.equal(
    sameBrowseView(
      'tracks',
      { sortBy: 'scrobbles', groupRecordings: 'true' },
      { sortBy: 'scrobbles' },
    ),
    true,
  )
  assert.equal(
    sameBrowseView(
      'tracks',
      { sortBy: 'scrobbles', groupRecordings: 'false' },
      { sortBy: 'scrobbles' },
    ),
    false,
  )
  assert.equal(
    canonicalBrowseView('tracks', {
      filters: filters(jazz, ambient),
      direction: 'desc',
    }),
    canonicalBrowseView('tracks', { filters: filters(ambient, jazz) }),
  )
})

test('another value, mode, order or switch changes a view', () => {
  const saved = { filters: filters(ambient), sortBy: 'dateAdded' }
  const changes: LibraryPlaylistView[] = [
    { filters: filters(ambient, jazz), sortBy: 'dateAdded' },
    { filters: filters({ ...ambient, mode: 'exclude' }) },
    { filters: filters(ambient), sortBy: 'title' },
    { filters: filters(ambient), direction: 'asc' },
    { filters: filters(ambient), q: 'rain' },
    { filters: filters(ambient), libraryScope: 'all' },
    {
      filters: filters(ambient),
      ranges: JSON.stringify([{ field: 'durationSec', min: 60 }]),
    },
    { filters: filters(ambient), tagLevels: 'track' },
    {},
  ]
  for (const change of changes)
    assert.equal(
      sameBrowseView('tracks', saved, change),
      false,
      JSON.stringify(change),
    )
  assert.equal(
    sameBrowseView(
      'albums',
      { includeArchived: 'true' },
      { includeArchived: 'false' },
    ),
    false,
  )
})

test('a view the Browse query refuses is compared as written', () => {
  const broken = { filters: 'not json' }
  assert.equal(sameBrowseView('tracks', broken, { filters: 'not json' }), true)
  assert.equal(sameBrowseView('tracks', broken, {}), false)
})

test('a view has something to save with a search, filter, range, condition or limit', () => {
  const none: LibraryPlaylistView[] = [
    {},
    { sortBy: 'title', direction: 'asc' },
    { q: '  ' },
  ]
  for (const view of none)
    assert.equal(browseViewHasCriteria('tracks', view), false)
  const some: LibraryPlaylistView[] = [
    { q: 'rain' },
    { filters: filters(ambient) },
    { ranges: JSON.stringify([{ field: 'durationSec', min: 60 }]) },
    {
      listening: JSON.stringify({
        match: 'all',
        rules: [{ period: { kind: 'all' }, min: 5 }],
      }),
    },
    { creatorId: 'artist-1' },
    { limitResults: '25' },
  ]
  for (const view of some)
    assert.equal(
      browseViewHasCriteria('tracks', view),
      true,
      JSON.stringify(view),
    )
  assert.equal(browseViewHasCriteria('albums', { tag: 'jazz' }), true)
  assert.equal(browseViewHasCriteria('tracks', { filters: 'not json' }), false)
})

test('opening a view replaces the current one and names the smart playlist', () => {
  const params = new URLSearchParams({
    q: 'old',
    ranges: JSON.stringify([{ field: 'year', min: 1990 }]),
    view: 'table',
    columns: 'title',
  })
  applyBrowseView(
    params,
    'tracks',
    { filters: filters(ambient), sortBy: 'title', direction: 'asc' },
    'smart-1',
  )
  assert.deepEqual(Object.fromEntries(params), {
    view: 'table',
    columns: 'title',
    filters: filters(ambient),
    sortBy: 'title',
    direction: 'asc',
    smartPlaylist: 'smart-1',
  })
  clearBrowseView(params, 'tracks')
  assert.deepEqual(Object.fromEntries(params), {
    view: 'table',
    columns: 'title',
  })
})

test('the wording of save, update and their place', () => {
  assert.equal(
    savedSmartPlaylistText('Ambient'),
    'Saved smart playlist “Ambient”.',
  )
  assert.equal(updatedSmartPlaylistText('Ambient'), 'Updated “Ambient”.')
  assert.equal(updateSmartPlaylistLabel('Ambient'), 'Update “Ambient”')
  assert.equal(nothingToSaveReason, 'Search or add a filter first')
  assert.equal(libraryPlaylistsHref('tracks'), '/playlists?mediaType=track')
  assert.equal(libraryPlaylistsHref('albums'), '/playlists?mediaType=album')
})
