import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lastfmTrackUrl, trackServiceLinks } from './track-links'

test('Last.fm track destinations preserve reserved characters in recorded names', () => {
  const url = lastfmTrackUrl('A&B / Ensemble', 'Part #1?')
  assert.equal(
    url,
    'https://www.last.fm/music/A%26B%20%2F%20Ensemble/_/Part%20%231%3F',
  )
  assert.equal(lastfmTrackUrl('', 'Unknown artist'), null)
})

test('merged track links keep recorded Last.fm identity beside the retained Spotify link', () => {
  const links = trackServiceLinks({
    title: 'Spotify title',
    artists: ['Spotify artist'],
    spotifyUrl: 'https://open.spotify.com/track/1234567890ABCDEFGHIJKL',
    lastfmSources: [
      {
        artistName: 'Recorded artist',
        trackName: 'Recorded title',
        albumNames: [],
        count: 2,
        manuallyMatched: true,
      },
    ],
  })
  assert.deepEqual(
    links.map((link) => link.provider),
    ['spotify', 'lastfm'],
  )
  assert.equal(
    links[1]?.url,
    'https://www.last.fm/music/Recorded%20artist/_/Recorded%20title',
  )
})
