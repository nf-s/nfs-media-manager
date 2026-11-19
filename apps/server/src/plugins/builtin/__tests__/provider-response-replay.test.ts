import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  MediaPluginTestContext,
  PluginReference,
} from '@repo/media-plugin-sdk'
import {
  createProviderResponseRecorder,
  type ProviderResponseCapture,
} from '@/lib/provider-response-history'
import { replayScrapeProvider } from '@/services/provider-response-replay'
import { getBuiltinScrapePlugin } from '..'
import { lookupArtistProvider } from '../artist-providers'
import { mdblistMovieFixture } from './fixtures/film-keywords'
import {
  spotifyAlbumFixture,
  spotifyAlbumId,
  spotifyTokenFixture,
} from './fixtures/spotify'

const artistName = 'Example Artist'
const albumTitle = 'Example Album'
const mbid = '11111111-1111-4111-8111-111111111111'
const spotifyArtistId = '0123456789abcdefghijkl'
const artistUrl = 'https://www.last.fm/music/Example+Artist'
const sharedSecrets = {
  apiKey: 'fixture-api-key',
  clientId: 'fixture-client-id',
  clientSecret: 'fixture-client-secret',
  token: 'fixture-discogs-token',
  appName: 'FixtureTest',
  appVersion: '9.0',
  contact: 'fixture@example.test',
}
const log = async () => undefined
const ref = (
  referenceType: string,
  externalId: string,
  sourceProvider?: string,
): PluginReference => ({
  referenceType,
  externalId,
  isPrimary: true,
  metadata: sourceProvider ? { sourceProvider } : undefined,
})

function archiveRequests(phase: 'media' | 'artist', payloads: unknown[]) {
  const archive: ProviderResponseCapture[] = []
  const begin = createProviderResponseRecorder(async (entry) => {
    archive.push(entry)
  }, Object.values(sharedSecrets))(phase)
  const queue = [...payloads]
  const request: MediaPluginTestContext['request'] = async (...parameters) => {
    if (!queue.length) throw new Error('Fixture has no next response')
    const response = Response.json(queue.shift())
    await begin(...parameters)?.({
      status: response.status,
      body: { state: 'captured', text: await response.clone().text() },
      contentType: 'application/json',
      receivedAt: new Date().toISOString(),
    })
    return response
  }
  return { request, archive }
}

describe('replay using current built-in normalizers', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Network disabled')
      }),
    )
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const film: 'film' = 'film'
  const album: 'album' = 'album'
  it.each([
    {
      provider: 'omdb',
      mediaType: film,
      references: [ref('imdb', 'tt0000001')],
      payloads: [
        { Response: 'True', Title: 'Fixture Film', imdbID: 'tt0000001' },
      ],
    },
    {
      provider: 'tmdb',
      mediaType: film,
      references: [ref('imdb', 'tt0000001')],
      payloads: [
        { movie_results: [{ id: 603 }] },
        { id: 603, title: 'Fixture Film' },
      ],
    },
    {
      provider: 'mdblist',
      mediaType: film,
      references: [ref('imdb', 'tt0133093')],
      payloads: [mdblistMovieFixture],
    },
    {
      provider: 'spotify',
      mediaType: album,
      references: [ref('spotify', spotifyAlbumId)],
      payloads: [spotifyTokenFixture, spotifyAlbumFixture()],
    },
    {
      provider: 'musicbrainz',
      mediaType: album,
      references: [ref('release-group', mbid, 'musicbrainz')],
      payloads: [
        {
          id: mbid,
          title: albumTitle,
          'first-release-date': '2003',
          'artist-credit': [
            { name: artistName, artist: { id: mbid, name: artistName } },
          ],
        },
      ],
    },
    {
      provider: 'lastfm',
      mediaType: album,
      references: [ref('mbid', mbid, 'lastfm')],
      payloads: [
        {
          album: {
            mbid,
            name: albumTitle,
            artist: artistName,
            url: 'https://www.last.fm/music/Example+Artist/Example+Album',
          },
        },
      ],
    },
    {
      provider: 'discogs',
      mediaType: album,
      references: [ref('release', '22', 'discogs')],
      payloads: [
        { id: 22, title: albumTitle, artists: [{ id: 10, name: artistName }] },
      ],
    },
    {
      provider: 'serply',
      mediaType: album,
      references: [],
      payloads: Array.from({ length: 6 }, () => ({
        results: [
          {
            title: 'Example Album by Example Artist (Album, Ambient)',
            link: 'https://rateyourmusic.com/release/album/example-artist/example-album/',
            description:
              'Example Album, an Album by Example Artist. Genres: Ambient.',
          },
        ],
      })),
    },
  ])(
    'replays the $provider $mediaType adapter',
    async ({ provider, mediaType, references, payloads }) => {
      const { request, archive } = archiveRequests('media', payloads)
      const context = {
        mediaItemId: 'fixture-media',
        mediaType,
        media: { title: albumTitle, artists: [artistName] },
        existingReferences: references,
        secrets: sharedSecrets,
        log,
      }
      const scrape = getBuiltinScrapePlugin(provider)?.scrapeMediaItem
      if (!scrape) throw new Error('Missing fixture normalizer')
      const expected = await scrape({ ...context, request })
      expect(archive.length).toBeGreaterThan(0)
      const actual = await replayScrapeProvider(provider, archive, [
        { phase: 'media', context },
      ])
      expect(actual[0]).toEqual(expected)
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each([
    {
      provider: 'spotify',
      id: spotifyArtistId,
      payloads: [
        spotifyTokenFixture,
        { id: spotifyArtistId, name: artistName, type: 'artist' },
      ],
    },
    {
      provider: 'lastfm',
      id: artistUrl,
      payloads: [{ artist: { url: artistUrl, name: artistName, mbid: '' } }],
    },
    { provider: 'discogs', id: '10', payloads: [{ id: 10, name: artistName }] },
    {
      provider: 'musicbrainz',
      id: mbid,
      payloads: [{ id: mbid, name: artistName }],
    },
  ])(
    'replays the $provider artist adapter',
    async ({ provider, id, payloads }) => {
      if (
        provider !== 'spotify' &&
        provider !== 'lastfm' &&
        provider !== 'discogs' &&
        provider !== 'musicbrainz'
      )
        throw new Error('Unknown fixture artist provider')
      const { request, archive } = archiveRequests('artist', payloads)
      const expected = await lookupArtistProvider(provider, artistName, id, {
        request,
        secrets: sharedSecrets,
        searched: log,
        recordDiagnostic: vi.fn(),
      })
      expect(archive.length).toBeGreaterThan(0)
      const actual = await replayScrapeProvider(provider, archive, [
        {
          phase: 'artist',
          context: {
            artist: { id: 'fixture-artist', name: artistName },
            providerArtistId: id,
            secrets: sharedSecrets,
          },
        },
      ])
      expect(actual[0]).toEqual(expected)
      expect(fetch).not.toHaveBeenCalled()
    },
  )
  it('replays Spotify recording evidence before the artist profile', async () => {
    const spotifyTrackId = '1111111111abcdefghijkl'
    const title = 'Synthetic Recording'
    const profile = { id: spotifyArtistId, name: artistName, type: 'artist' }
    const recordings = { spotifyRecordings: [{ spotifyTrackId, title }] }
    const { archive, request } = archiveRequests('artist', [
      spotifyTokenFixture,
      { id: spotifyTrackId, name: title, artists: [profile] },
      profile,
    ])
    await lookupArtistProvider('spotify', artistName, null, {
      request,
      secrets: sharedSecrets,
      searched: log,
      recordDiagnostic: vi.fn(),
      ...recordings,
    })
    const input = {
      phase: 'artist',
      context: {
        artist: { id: 'synthetic-artist', name: artistName },
        providerArtistId: null,
        secrets: sharedSecrets,
      },
    } satisfies Parameters<typeof replayScrapeProvider>[2][number]
    await expect(
      replayScrapeProvider('spotify', archive, [{ ...input, recordings }]),
    ).resolves.toMatchObject([
      { payload: { recordingVerification: [{ spotifyTrackId, title }] } },
    ])
    await expect(
      replayScrapeProvider('spotify', archive, [input]),
    ).rejects.toThrow('differs')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('replays Last.fm top-track corroboration using scoped recording input in memory', async () => {
    const artist = { name: artistName, mbid, url: artistUrl }
    const titles = ['Synthetic Recording', 'Another Synthetic Recording']
    const recordings = { loadLastfmRecordings: vi.fn(async () => titles) }
    const { archive, request } = archiveRequests('artist', [
      {
        results: {
          'opensearch:totalResults': '30',
          artistmatches: { artist: [artist] },
        },
      },
      { toptracks: { track: titles.map((name) => ({ name, artist })) } },
      { artist },
    ])
    const options = {
      request,
      secrets: sharedSecrets,
      searched: log,
      recordDiagnostic: vi.fn(),
    }
    await lookupArtistProvider('lastfm', artistName, null, {
      ...options,
      ...recordings,
    })
    const input = {
      phase: 'artist',
      context: {
        artist: { id: 'synthetic-artist', name: artistName },
        providerArtistId: null,
        secrets: sharedSecrets,
      },
    } satisfies Parameters<typeof replayScrapeProvider>[2][number]
    await expect(
      replayScrapeProvider('lastfm', archive, [{ ...input, recordings }]),
    ).resolves.toMatchObject([
      { payload: { recordingVerification: { matchedTitles: titles } } },
    ])
    await expect(
      replayScrapeProvider('lastfm', archive, [input]),
    ).rejects.toThrow('complete')
    expect(fetch).not.toHaveBeenCalled()
  })
})
