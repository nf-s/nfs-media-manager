import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  describeScrobbledAlbum,
  describeUnlistedAlbum,
  trackAlbumReference,
} from './track-album-notices'

const spotifyTrackId = '1234567890ABCDEFGHIJKL'
const spotifyAlbumId = 'ABCDEFGHIJKL1234567890'
const album = { id: 'album-1', title: 'Harbour Lights' }

test('an exact release takes precedence over a name-based library link', () => {
  assert.deepEqual(
    trackAlbumReference({
      album,
      albumLinkStrategy: 'album-title',
      spotifyAlbumId,
      spotifyTrackId,
      spotifyMatch: 'spotify-import',
    }),
    { album: null, exactId: spotifyAlbumId, openBySpotify: true },
  )
})

test('uses the same exact release for a Spotify album ID, URI or URL', () => {
  for (const reference of [
    spotifyAlbumId,
    `spotify:album:${spotifyAlbumId}`,
    `https://open.spotify.com/album/${spotifyAlbumId}`,
  ]) {
    assert.deepEqual(
      trackAlbumReference({
        album: null,
        albumLinkStrategy: null,
        spotifyAlbumId: reference,
        spotifyTrackId,
        spotifyMatch: 'spotify-import',
      }),
      { album: null, exactId: spotifyAlbumId, openBySpotify: true },
    )
  }
})

test('uses the matched track identity when the release ID is absent', () => {
  assert.deepEqual(
    trackAlbumReference({
      album: null,
      albumLinkStrategy: null,
      spotifyAlbumId: null,
      spotifyTrackId,
      spotifyMatch: 'spotify-search',
    }),
    { album: null, exactId: null, openBySpotify: true },
  )
  assert.deepEqual(
    trackAlbumReference({
      album,
      albumLinkStrategy: 'spotify-track',
      spotifyAlbumId: null,
      spotifyTrackId,
      spotifyMatch: 'spotify-search',
    }),
    { album, exactId: null, openBySpotify: false },
  )
  assert.deepEqual(
    trackAlbumReference({
      album,
      albumLinkStrategy: 'spotify-album',
      spotifyTrackId,
      spotifyMatch: 'spotify-search',
    }),
    { album, exactId: null, openBySpotify: false },
  )
})

test('does not resolve an unlinked release when there is no Spotify identity', () => {
  assert.deepEqual(
    trackAlbumReference({
      album: null,
      albumLinkStrategy: null,
      spotifyAlbumId: 'malformed',
      spotifyTrackId: null,
      spotifyMatch: 'unmatched',
    }),
    { album: null, exactId: null, openBySpotify: false },
  )
})

test('an exact linked album outside the library still resolves by Spotify', () => {
  const outside = { ...album, inLibrary: false }
  for (const release of [spotifyAlbumId, null]) {
    assert.deepEqual(
      trackAlbumReference({
        album: outside,
        albumLinkStrategy: 'spotify-album',
        spotifyAlbumId: release,
        spotifyTrackId,
        spotifyMatch: 'spotify-import',
      }),
      { album: outside, exactId: release, openBySpotify: true },
    )
  }
})

test('counts the plays on an album that does not list the track', () => {
  assert.deepEqual(describeScrobbledAlbum(1150), {
    before: '1,150 plays of this track are counted on “',
    after: '”, which does not list it.',
  })
  assert.equal(
    describeScrobbledAlbum(1).before,
    '1 play of this track is counted on “',
  )
})

test('says the added album does not list the track', () => {
  assert.deepEqual(describeUnlistedAlbum('Harbour Lights'), {
    before: '“',
    title: 'Harbour Lights',
    after: '” is in the library but does not list this track.',
  })
  assert.deepEqual(describeUnlistedAlbum(null), {
    before: '',
    title: 'The album',
    after: ' is in the library but does not list this track.',
  })
})
