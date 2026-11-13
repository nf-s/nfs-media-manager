import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parsePlaylistTab,
  playlistAlbumsHref,
  playlistDrawerParams,
  playlistFilter,
  playlistHref,
  playlistTracksHref,
  trackHref,
} from './playlist-links'

const name = 'Evening mix & "favourites" #2'

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

test('track links encode the track ID as one path segment', () => {
  assert.equal(trackHref('track-1'), '/tracks/track-1')
  assert.equal(trackHref('a/b?c'), '/tracks/a%2Fb%3Fc')
})

test('playlist drawer links open the Playlists page on a tab', () => {
  assert.equal(playlistHref('playlist-1'), '/playlists?playlist=playlist-1')
  assert.equal(
    playlistHref('playlist-1', 'sync'),
    '/playlists?playlist=playlist-1&tab=sync',
  )
  const url = new URL(playlistHref('a/b&c', 'sync'), 'http://localhost')
  assert.equal(url.searchParams.get('playlist'), 'a/b&c')
  assert.equal(url.searchParams.get('tab'), 'sync')
  assert.deepEqual(playlistDrawerParams('p1'), { playlist: 'p1', tab: null })
  assert.deepEqual(playlistDrawerParams('p1', 'sync'), {
    playlist: 'p1',
    tab: 'sync',
  })
})

test('an unknown or missing drawer tab reads as Tracks', () => {
  assert.equal(parsePlaylistTab('sync'), 'sync')
  assert.equal(parsePlaylistTab('tracks'), 'tracks')
  assert.equal(parsePlaylistTab(null), 'tracks')
  assert.equal(parsePlaylistTab('history'), 'tracks')
})

test('the playlist filter is required, as the playlist links apply it', () => {
  assert.deepEqual(playlistFilter(name), {
    field: 'playlist',
    value: name,
    mode: 'required',
  })
})
