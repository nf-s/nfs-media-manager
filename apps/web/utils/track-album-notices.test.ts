import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  describeScrobbledAlbum,
  missingTrackAlbum,
} from './track-album-notices'

test('names the missing Spotify album only when the track has no library album', () => {
  assert.deepEqual(
    missingTrackAlbum({
      album: null,
      albumName: 'Harbour Lights',
      spotifyAlbumId: '1234567890ABCDEFGHIJKL',
    }),
    {
      spotifyAlbumId: '1234567890ABCDEFGHIJKL',
      message: '“Harbour Lights” is not in the library.',
    },
  )
  assert.equal(
    missingTrackAlbum({
      album: null,
      albumName: null,
      spotifyAlbumId: '1234567890ABCDEFGHIJKL',
    })?.message,
    'The album is not in the library.',
  )
  assert.equal(
    missingTrackAlbum({
      album: { id: 'album-1', title: 'Harbour Lights' },
      albumName: 'Harbour Lights',
      spotifyAlbumId: '1234567890ABCDEFGHIJKL',
    }),
    null,
  )
  assert.equal(
    missingTrackAlbum({
      album: null,
      albumName: 'Recorded',
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
