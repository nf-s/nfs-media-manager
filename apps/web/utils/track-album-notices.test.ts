import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  describeScrobbledAlbum,
  describeUnlistedAlbum,
  missingTrackAlbum,
} from './track-album-notices'

test('offers an exact release while describing the missing track link', () => {
  const artists = ['Example artist']
  assert.deepEqual(
    missingTrackAlbum({
      album: null,
      albumName: 'Harbour Lights',
      artists,
      spotifyAlbumId: '1234567890ABCDEFGHIJKL',
    }),
    {
      kind: 'id',
      spotifyAlbumId: '1234567890ABCDEFGHIJKL',
      name: 'Harbour Lights',
      query: 'Example artist Harbour Lights',
      message: '“Harbour Lights” has no linked library album.',
    },
  )
  assert.equal(
    missingTrackAlbum({
      album: null,
      albumName: null,
      artists,
      spotifyAlbumId: '1234567890ABCDEFGHIJKL',
    })?.message,
    'This track has no linked library album.',
  )
  assert.equal(
    missingTrackAlbum({
      album: { id: 'album-1', title: 'Harbour Lights' },
      albumName: 'Harbour Lights',
      artists,
      spotifyAlbumId: '1234567890ABCDEFGHIJKL',
    }),
    null,
  )
})

test('uses the artist and album name for a search when no Spotify release ID is known', () => {
  assert.deepEqual(
    missingTrackAlbum({
      album: null,
      albumName: 'Recorded album',
      artists: ['Example artist'],
      spotifyAlbumId: null,
    }),
    {
      kind: 'search',
      name: 'Recorded album',
      query: 'Example artist Recorded album',
      message: '“Recorded album” has no linked library album.',
    },
  )
  assert.equal(
    missingTrackAlbum({
      album: null,
      albumName: 'Recorded album',
      artists: [],
      spotifyAlbumId: 'malformed',
    })?.kind,
    'search',
  )
  assert.equal(
    missingTrackAlbum({
      album: null,
      albumName: 'Recorded album',
      artists: [],
      spotifyAlbumId: null,
    })?.kind,
    'search',
  )
  assert.equal(
    missingTrackAlbum({
      album: null,
      albumName: null,
      artists: ['Example artist'],
      spotifyAlbumId: null,
    }),
    null,
  )
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
