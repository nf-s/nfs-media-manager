import {
  ProviderRequestError,
  type MediaPluginTestContext,
} from '@repo/media-plugin-sdk'
import { expect, it, vi } from 'vitest'
import {
  lookupArtistProvider,
  verifySavedArtistRecordings,
} from '../artist-providers'

const name = 'Fixture Artist'
const spotifyId = '0123456789abcdefghijkl'
const otherSpotifyId = '0123456789abcdefghijkm'
const first = {
  spotifyTrackId: '0123456789abcdefghijkn',
  title: 'First Fixture Track',
}
const second = {
  spotifyTrackId: '0123456789abcdefghijko',
  title: 'Second Fixture Track',
}
const release = 'Fixture Release'
const artist = { id: spotifyId, name, type: 'artist' }
const token = {
  access_token: 'fixture-token',
  token_type: 'Bearer',
  expires_in: 3600,
}
const mbid = '11111111-1111-4111-8111-111111111111'
const otherMbid = '22222222-2222-4222-8222-222222222222'
const lastFmUrl = 'https://www.last.fm/music/Fixture+Artist'

function fixture(...payloads: unknown[]) {
  return {
    secrets: {
      clientId: 'fixture-client',
      clientSecret: 'fixture-secret',
      apiKey: 'fixture-key',
    },
    request: vi.fn<MediaPluginTestContext['request']>(async () => {
      if (!payloads.length) throw new Error('Exceeded mocked request bound')
      return Response.json(payloads.shift())
    }),
    recordDiagnostic: vi.fn(),
    searched: vi.fn(async () => undefined),
  }
}

function spotifyTrack(recording: typeof first, artistId = spotifyId) {
  return {
    id: recording.spotifyTrackId,
    name: recording.title,
    artists: [{ id: artistId, name }],
    album: {
      name: release,
      album_type: 'album',
      artists: [{ id: artistId, name }],
    },
  }
}

function lastFmTrack(artistMbid = mbid) {
  return {
    track: {
      name: first.title,
      artist: { name, mbid: artistMbid, url: lastFmUrl },
      album: { title: release, artist: name },
    },
  }
}

it('independently verifies a saved unique Spotify search without fetching another artist profile', async () => {
  const original = fixture(
    token,
    { artists: { total: 1, items: [artist] } },
    artist,
  )
  const saved = await lookupArtistProvider('spotify', name, null, original)
  expect(saved.payload).toHaveProperty('search')
  expect(saved.payload).not.toHaveProperty('recordingVerification')
  const read = fixture(token, spotifyTrack(first), spotifyTrack(second))
  await expect(
    verifySavedArtistRecordings('spotify', name, saved.profile, {
      ...read,
      spotifyRecordings: [first, second],
    }),
  ).resolves.toMatchObject({
    verdict: 'verified',
    evidenceCount: 2,
  })
  expect(
    read.request.mock.calls.map(([url]) => new URL(String(url)).pathname),
  ).toEqual([
    '/api/token',
    '/v1/tracks/' + first.spotifyTrackId,
    '/v1/tracks/' + second.spotifyTrackId,
  ])
})

it('reports a reliable competing Spotify identity without selecting it', async () => {
  const read = fixture(token, spotifyTrack(first, otherSpotifyId))
  await expect(
    verifySavedArtistRecordings(
      'spotify',
      name,
      { externalId: spotifyId },
      { ...read, spotifyRecordings: [first] },
    ),
  ).resolves.toMatchObject({ verdict: 'conflict', evidenceCount: 1 })
  expect(read.request).toHaveBeenCalledTimes(2)
})

it('retains Last.fm recording credit as a conflict when the saved MBID differs', async () => {
  const read = fixture(lastFmTrack(otherMbid))
  await expect(
    verifySavedArtistRecordings(
      'lastfm',
      name,
      { externalId: mbid, url: lastFmUrl },
      {
        ...read,
        loadLastfmRecordings: async () => [
          { title: first.title, albumName: release },
        ],
      },
    ),
  ).resolves.toMatchObject({ verdict: 'conflict', evidenceCount: 1 })
  expect(read.request).toHaveBeenCalledOnce()
})

it('uses bounded Spotify catalog credits to compare an existing ID', async () => {
  const page = (recording: typeof first) => ({
    tracks: {
      offset: 0,
      next: null,
      total: 1,
      items: [spotifyTrack(recording)],
    },
  })
  const read = fixture(token, page(first), page(second))
  await expect(
    verifySavedArtistRecordings(
      'spotify',
      name,
      { externalId: otherSpotifyId },
      {
        ...read,
        loadSpotifyCatalogRecordings: async () =>
          [first, second].map(({ title }) => ({ title, albumName: release })),
      },
    ),
  ).resolves.toMatchObject({
    verdict: 'conflict',
    evidenceCount: 2,
    evidence: {
      method: 'spotify-catalog-recordings',
      expectedId: otherSpotifyId,
      recordings: [first, second].map((recording) => ({
        ...recording,
        release,
        artistId: spotifyId,
      })),
    },
  })
  expect(read.request).toHaveBeenCalledTimes(3)
})

it('reports incompatible Spotify IDs from distinct native tracks', async () => {
  const read = fixture(
    token,
    spotifyTrack(first),
    spotifyTrack(second, otherSpotifyId),
  )
  await expect(
    verifySavedArtistRecordings(
      'spotify',
      name,
      { externalId: spotifyId },
      {
        ...read,
        spotifyRecordings: [first, second],
      },
    ),
  ).resolves.toMatchObject({
    verdict: 'conflict',
    evidenceCount: 2,
    evidence: {
      conflict: { title: second.title, artistIds: [otherSpotifyId] },
    },
  })
})

it('does not obtain a token when a single unlinked Spotify title cannot verify the artist', async () => {
  const read = fixture()
  await expect(
    verifySavedArtistRecordings(
      'spotify',
      name,
      { externalId: spotifyId },
      {
        ...read,
        loadSpotifyCatalogRecordings: async () => [
          { title: first.title, albumName: release },
        ],
      },
    ),
  ).resolves.toMatchObject({ verdict: 'insufficient', evidenceCount: 0 })
  expect(read.request).not.toHaveBeenCalled()
})

it('verifies a saved Last.fm URL even when the recording has no artist MBID', async () => {
  const read = fixture(lastFmTrack(''))
  await expect(
    verifySavedArtistRecordings(
      'lastfm',
      name,
      { externalId: 'http://last.fm/music/Fixture%20Artist/' },
      {
        ...read,
        loadLastfmRecordings: async () => [
          { title: first.title, albumName: release },
        ],
      },
    ),
  ).resolves.toMatchObject({
    verdict: 'verified',
    evidenceCount: 1,
    evidence: {
      expectedId: lastFmUrl,
      artistUrl: lastFmUrl,
      recordings: [{ title: first.title, release }],
    },
  })
  expect(read.request).toHaveBeenCalledOnce()
})

it('does not use a matching URL as proof of a saved Last.fm MBID absent from the recording', async () => {
  const read = fixture(lastFmTrack(''))
  await expect(
    verifySavedArtistRecordings(
      'lastfm',
      name,
      { externalId: mbid, url: lastFmUrl },
      {
        ...read,
        loadLastfmRecordings: async () => [
          { title: first.title, albumName: release },
        ],
      },
    ),
  ).resolves.toMatchObject({ verdict: 'insufficient', evidenceCount: 0 })
})

it('propagates gated provider failures', async () => {
  const read = fixture(token)
  const limited = new ProviderRequestError('Fixture rate limit', 'rate-limit')
  read.request.mockRejectedValueOnce(limited)
  await expect(
    verifySavedArtistRecordings(
      'spotify',
      name,
      { externalId: spotifyId },
      {
        ...read,
        spotifyRecordings: [first],
      },
    ),
  ).rejects.toBe(limited)
})
