import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  playlistAlbumsHref,
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
