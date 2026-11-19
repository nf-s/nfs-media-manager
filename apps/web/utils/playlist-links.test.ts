import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PlaylistEntrySort } from '@repo/schemas/tracks'
import {
  parsePlaylistTab,
  collectionBrowseHref,
  collectionItemsHref,
  playlistAlbumsHref,
  playlistBrowseHref,
  playlistDrawerParams,
  playlistFilter,
  playlistHref,
  playlistTracksHref,
  trackHref,
  playlistEntryView,
  playlistEntryViewParam,
} from './playlist-links'

const name = 'Evening mix & "favourites" #2'
const unmatchedSorts: PlaylistEntrySort[] = [
  'position',
  'added',
  'source',
  'kind',
]

test('playlist playback links restore search, sort and type filters only for their playlist', () => {
  const value = playlistEntryViewParam('playlist-1', {
    ...playlistEntryView(null, 'playlist-1'),
    sortBy: 'artists',
    direction: 'desc',
    q: 'Example ',
    kinds: ['track'],
  })
  const restored = playlistEntryView(value, 'playlist-1')
  assert.equal(restored.sortBy, 'artists')
  assert.equal(restored.direction, 'desc')
  assert.equal(restored.q, 'Example ')
  assert.deepEqual(restored.kinds, ['track'])
  for (const invalid of [null, '{', '{"id":"playlist-1","sortBy":"invalid"}'])
    assert.equal(playlistEntryView(invalid, 'playlist-1').sortBy, 'position')
  assert.equal(playlistEntryView(value, 'playlist-2').sortBy, 'position')
})

test('playlist links filter tracks and albums by the required playlist name', () => {
  for (const { href, path } of [
    { href: playlistTracksHref(name), path: '/tracks' },
    { href: playlistAlbumsHref(name), path: '/albums' },
  ]) {
    const url = new URL(href, 'http://localhost')
    assert.equal(url.pathname, path)
    assert.equal([...url.searchParams].length, 1)
    assert.deepEqual(JSON.parse(url.searchParams.get('filters') ?? ''), [
      { field: 'playlist', value: name, mode: 'required' },
    ])
  }
})

test('Show in Tracks carries the playlist list search, order and view', () => {
  const url = new URL(
    playlistBrowseHref('tracks', name, {
      q: '  night ',
      sortBy: 'lastListened',
      direction: 'desc',
      view: 'grid',
    }),
    'http://localhost',
  )
  assert.equal(url.pathname, '/tracks')
  assert.deepEqual(JSON.parse(url.searchParams.get('filters') ?? ''), [
    { field: 'playlist', value: name, mode: 'required' },
  ])
  assert.equal(url.searchParams.get('q'), 'night')
  assert.equal(url.searchParams.get('sortBy'), 'lastListenedAt')
  assert.equal(url.searchParams.get('direction'), 'desc')
  assert.equal(url.searchParams.get('view'), 'grid')
})

test('an order Browse does not have is left out of Show in Browse', () => {
  // Playlist position and the date added to the playlist exist only there.
  for (const sortBy of unmatchedSorts) {
    const url = new URL(
      playlistBrowseHref('tracks', name, {
        sortBy,
        direction: 'asc',
        view: 'table',
      }),
      'http://localhost',
    )
    assert.deepEqual([...url.searchParams.keys()], ['filters', 'view'], sortBy)
  }
  // Albums has no Album column to sort by.
  const albums = new URL(
    playlistBrowseHref('albums', name, {
      sortBy: 'album',
      direction: 'asc',
      view: 'grid',
    }),
    'http://localhost',
  )
  assert.equal(albums.pathname, '/albums')
  assert.equal(albums.searchParams.has('sortBy'), false)
  const byArtist = new URL(
    playlistBrowseHref('albums', name, {
      sortBy: 'artists',
      direction: 'desc',
      view: 'grid',
    }),
    'http://localhost',
  )
  assert.equal(byArtist.searchParams.get('sortBy'), 'artist')
  assert.equal(byArtist.searchParams.get('direction'), 'desc')
})

test('track links encode the track ID as one path segment', () => {
  assert.equal(trackHref('track-1'), '/tracks/track-1')
  assert.equal(trackHref('a/b?c'), '/tracks/a%2Fb%3Fc')
})

test('playlist drawer links open the Playlists page on a tab', () => {
  assert.equal(playlistHref('playlist-1'), '/playlists?playlist=playlist-1')
  assert.equal(
    playlistHref('playlist-1', 'sources'),
    '/playlists?playlist=playlist-1&tab=sources',
  )
  const url = new URL(playlistHref('a/b&c', 'listening'), 'http://localhost')
  assert.equal(url.searchParams.get('playlist'), 'a/b&c')
  assert.equal(url.searchParams.get('tab'), 'listening')
  assert.deepEqual(playlistDrawerParams('p1'), { playlist: 'p1', tab: null })
  assert.deepEqual(playlistDrawerParams('p1', 'sources'), {
    playlist: 'p1',
    tab: 'sources',
  })
})

test('an unknown or missing drawer tab reads as Overview, and old tabs still open', () => {
  assert.equal(parsePlaylistTab('sources'), 'sources')
  assert.equal(parsePlaylistTab('listening'), 'listening')
  assert.equal(parsePlaylistTab('coverage'), 'coverage')
  assert.equal(parsePlaylistTab('sync'), 'sources')
  assert.equal(parsePlaylistTab('tracks'), 'overview')
  assert.equal(parsePlaylistTab(null), 'overview')
  assert.equal(parsePlaylistTab('history'), 'overview')
})

test('the playlist filter is required, as the playlist links apply it', () => {
  assert.deepEqual(playlistFilter(name), {
    field: 'playlist',
    value: name,
    mode: 'required',
  })
})

test('collection links apply the required collection filter in their library', () => {
  for (const mediaType of ['album', 'film'] satisfies ('album' | 'film')[]) {
    const url = new URL(
      collectionItemsHref(mediaType, name),
      'https://example.test',
    )
    assert.equal(url.pathname, `/${mediaType}s`)
    assert.deepEqual(JSON.parse(url.searchParams.get('filters') ?? ''), [
      { field: 'collection', value: name, mode: 'required' },
    ])
  }
})

test('Show in Films carries the collection list search, watched filter, order and view', () => {
  const url = new URL(
    collectionBrowseHref('film', name, {
      q: ' coast ',
      watchedStates: ['unwatched'],
      sortBy: 'runtimeMinutes',
      direction: 'desc',
      view: 'list',
    }),
    'https://example.test',
  )
  assert.equal(url.pathname, '/films')
  assert.deepEqual(JSON.parse(url.searchParams.get('filters') ?? ''), [
    { field: 'collection', value: name, mode: 'required' },
    { field: 'watched', value: 'No', mode: 'required' },
  ])
  assert.equal(url.searchParams.get('q'), 'coast')
  assert.equal(url.searchParams.get('sortBy'), 'runtimeMinutes')
  assert.equal(url.searchParams.get('direction'), 'desc')
  assert.equal(url.searchParams.get('view'), 'list')
})

test('Show in Albums leaves out what Browse cannot match', () => {
  // Collection position has no Browse order; both watched states are no filter.
  const url = new URL(
    collectionBrowseHref('album', name, {
      watchedStates: ['watched', 'unwatched'],
      sortBy: 'position',
      direction: 'asc',
      view: 'grid',
    }),
    'https://example.test',
  )
  assert.equal(url.pathname, '/albums')
  assert.deepEqual([...url.searchParams.keys()], ['filters', 'view'])
  assert.deepEqual(JSON.parse(url.searchParams.get('filters') ?? ''), [
    { field: 'collection', value: name, mode: 'required' },
  ])
  const byArtist = new URL(
    collectionBrowseHref('album', name, {
      sortBy: 'artists',
      direction: 'asc',
      view: 'table',
    }),
    'https://example.test',
  )
  assert.equal(byArtist.searchParams.get('sortBy'), 'artist')
})
