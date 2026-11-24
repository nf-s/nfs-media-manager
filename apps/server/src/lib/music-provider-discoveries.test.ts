import { expect, it } from 'vitest'
import {
  musicResponseEndpoint,
  readMusicDiscoveries,
} from './music-provider-discoveries'

it('keeps Discogs editions and track mentions separate without inventing recording IDs', () => {
  const endpoint = musicResponseEndpoint({
    provider: 'discogs',
    method: 'GET',
    phase: 'media',
    status: 200,
    requestUrl: 'https://api.discogs.com/masters/123',
  })
  if (!endpoint) throw new Error('Expected the Discogs endpoint')
  const [result] = readMusicDiscoveries(endpoint, {
    id: 123,
    title: 'Fixture Master',
    main_release: 456,
    artists: [{ id: 78, name: 'Fixture Artist' }],
    tracklist: [
      { title: 'Disc One', type_: 'heading', position: '' },
      { title: 'Track A', type_: 'track', position: 'A1' },
      { title: 'Track A', type_: 'track', position: 'A2' },
    ],
  })
  expect(result).toMatchObject({
    referenceType: 'master',
    externalId: '123',
    children: [
      {
        referenceType: 'release',
        externalId: '456',
        relationship: 'main_release',
      },
      { kind: 'track', ordinal: 1, details: { nativePosition: 'A1' } },
      { kind: 'track', ordinal: 2, details: { nativePosition: 'A2' } },
    ],
  })
  expect(result?.children?.[1]?.externalId).toBeUndefined()
})

it('excludes private Spotify and Last.fm paths before decoding catalog data', () => {
  expect(
    musicResponseEndpoint({
      provider: 'lastfm',
      method: 'GET',
      phase: 'task',
      status: 200,
      requestUrl:
        'https://ws.audioscrobbler.com/2.0/?method=user.getRecentTracks',
    }),
  ).toBeUndefined()
  expect(
    musicResponseEndpoint({
      provider: 'spotify',
      method: 'GET',
      phase: 'task',
      status: 200,
      requestUrl: 'https://api.spotify.com/v1/me/albums',
    }),
  ).toBeUndefined()
})
