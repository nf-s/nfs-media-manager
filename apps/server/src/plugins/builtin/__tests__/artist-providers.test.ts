import { describe, expect, it, vi } from 'vitest'
import {
  ProviderItemNotFoundError,
  ProviderRequestError,
  type MediaPluginTestContext,
} from '@repo/media-plugin-sdk'
import {
  ArtistSearchAmbiguousError,
  lookupArtistProvider,
  normalizeArtistProviderId,
} from '../artist-providers'

const artistName = 'Artist Fixture'
const spotifyId = '0123456789abcdefghijkl'
const competingSpotifyId = '0123456789abcdefghijkm'
const spotifyTrack = {
  spotifyTrackId: '0123456789abcdefghijkn',
  title: 'Fixture Recording',
}
const secondSpotifyTrack = {
  spotifyTrackId: '0123456789abcdefghijko',
  title: 'Second Recording',
}
const mbid = '11111111-1111-4111-8111-111111111111'
const lastFmUrl = 'https://www.last.fm/music/Artist+Fixture'
const lastFmKey = 'fixture-lastfm-key'

function responses(...payloads: unknown[]) {
  const request = vi.fn<MediaPluginTestContext['request']>(async () => {
    if (!payloads.length) throw new Error('Exceeded mocked request bound')
    return Response.json(payloads.shift())
  })
  return {
    request,
    secrets: {
      clientId: 'fixture-client',
      clientSecret: 'fixture-client-secret',
      apiKey: lastFmKey,
      token: 'fixture-discogs-token',
      appName: 'FixtureApp',
      appVersion: '1.7',
      contact: 'offline@example.test',
    },
    recordDiagnostic: vi.fn(),
    searched: vi.fn(async () => undefined),
  }
}

describe('artist provider lookups', () => {
  it('reads Spotify artist metadata without requiring genres and redacts the access token', async () => {
    const token = 'fixture-access-token'
    const context = responses(
      { access_token: token, token_type: 'Bearer', expires_in: 3600 },
      {
        id: spotifyId,
        name: artistName,
        type: 'artist',
        images: [
          { url: 'https://user:password@images.example.test/private.jpg' },
          { url: 'https://images.example.test/artist.jpg?token=' + token },
        ],
        echo: token,
        authorization: 'some unexpected data',
      },
    )
    const result = await lookupArtistProvider(
      'spotify',
      'Local name',
      spotifyId,
      context,
    )
    expect(result.profile).toMatchObject({
      externalId: spotifyId,
      name: artistName,
      url: 'https://open.spotify.com/artist/' + spotifyId,
      artworkUrl: 'https://images.example.test/artist.jpg',
      tags: [],
    })
    expect(result.payload).toMatchObject({ artist: { echo: '[REDACTED]' } })
    expect(JSON.stringify(result)).not.toContain(token)
    expect(JSON.stringify(result.profile)).not.toContain('private.jpg')
    expect(JSON.stringify(result.payload)).not.toContain('password')
    expect(JSON.stringify(result.payload)).not.toContain('authorization')
    expect(context.request).toHaveBeenCalledTimes(2)
    expect(new URL(String(context.request.mock.calls[1]?.[0])).pathname).toBe(
      '/v1/artists/' + spotifyId,
    )
    expect(context.searched).not.toHaveBeenCalled()
  })

  const spotifyToken = {
    access_token: 'fixture-token',
    token_type: 'Bearer',
    expires_in: 3600,
  }
  const spotifyArtist = { id: spotifyId, name: artistName, type: 'artist' }
  const competingSpotifyArtist = { ...spotifyArtist, id: competingSpotifyId }
  const spotifyRecording = {
    id: spotifyTrack.spotifyTrackId,
    name: spotifyTrack.title,
    artists: [spotifyArtist],
  }
  const mockPaths = (context: ReturnType<typeof responses>) =>
    context.request.mock.calls.map(([url]) => new URL(String(url)).pathname)

  it.each([
    {
      recordings: [
        {
          ...spotifyRecording,
          artists: [spotifyArtist, competingSpotifyArtist],
        },
      ],
    },
    {
      recordings: [
        spotifyRecording,
        {
          id: secondSpotifyTrack.spotifyTrackId,
          name: secondSpotifyTrack.title,
          artists: [competingSpotifyArtist],
        },
      ],
    },
  ])(
    'declines conflicting exact Spotify credits from recordings %#',
    async ({ recordings }) => {
      const context = {
        ...responses(spotifyToken, ...recordings),
        spotifyRecordings: [spotifyTrack, secondSpotifyTrack],
      }
      await expect(
        lookupArtistProvider('spotify', artistName, null, context),
      ).rejects.toBeInstanceOf(ArtistSearchAmbiguousError)
      expect(mockPaths(context)).toEqual([
        '/api/token',
        ...context.spotifyRecordings
          .slice(0, recordings.length)
          .map(({ spotifyTrackId }) => '/v1/tracks/' + spotifyTrackId),
      ])
      expect(context.recordDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'artist.recording-conflict' }),
      )
    },
  )

  it.each([
    { ...spotifyRecording, id: secondSpotifyTrack.spotifyTrackId },
    { ...spotifyRecording, name: 'A different recording' },
    {
      ...spotifyRecording,
      artists: [{ ...spotifyArtist, name: 'Fixture Collaborator' }],
    },
  ])(
    'uses ordinary name search when a Spotify recording fails verification %#',
    async (recording) => {
      const context = {
        ...responses(
          spotifyToken,
          recording,
          { artists: { total: 1, items: [competingSpotifyArtist] } },
          competingSpotifyArtist,
        ),
        spotifyRecordings: [spotifyTrack],
      }
      const result = await lookupArtistProvider(
        'spotify',
        artistName,
        null,
        context,
      )
      expect(result.profile.externalId).toBe(competingSpotifyId)
      expect(result.payload).not.toHaveProperty('recordingVerification')
      expect(mockPaths(context)).toEqual([
        '/api/token',
        '/v1/tracks/' + spotifyTrack.spotifyTrackId,
        '/v1/search',
        '/v1/artists/' + competingSpotifyId,
      ])
    },
  )

  it('uses two release credits to resolve an ambiguous Spotify artist search', async () => {
    const recorded = [spotifyTrack, secondSpotifyTrack].map((track) => ({
      ...track,
      albumName: 'Fixture album',
    }))
    const pages = recorded.map(({ title, albumName, spotifyTrackId }) => ({
      tracks: {
        offset: 0,
        next: null,
        total: 1,
        items: [
          {
            id: spotifyTrackId,
            name: title,
            artists: [spotifyArtist],
            album: {
              name: albumName,
              album_type: 'album',
              artists: [spotifyArtist],
            },
          },
        ],
      },
    }))
    const context = {
      ...responses(
        spotifyToken,
        {
          artists: {
            total: 20,
            items: [spotifyArtist, competingSpotifyArtist],
          },
        },
        ...pages,
        spotifyArtist,
      ),
      loadSpotifyCatalogRecordings: vi.fn(async () => recorded),
    }
    const result = await lookupArtistProvider(
      'spotify',
      artistName,
      null,
      context,
    )
    expect(result.profile.externalId).toBe(spotifyId)
    expect(result.payload).toMatchObject({
      catalogRecordingVerification: recorded.map(
        ({ title, albumName, spotifyTrackId }) => ({
          title,
          release: albumName,
          spotifyTrackId,
          artistId: spotifyId,
        }),
      ),
    })
    expect(context.loadSpotifyCatalogRecordings).toHaveBeenCalledOnce()
    expect(mockPaths(context)).toEqual([
      '/api/token',
      '/v1/search',
      '/v1/search',
      '/v1/search',
      '/v1/artists/' + spotifyId,
    ])
  })

  it('keeps an explicit Spotify artist ID authoritative and checks the profile ID', async () => {
    const context = {
      ...responses(spotifyToken, spotifyArtist),
      spotifyRecordings: [spotifyTrack],
    }
    await expect(
      lookupArtistProvider('spotify', artistName, competingSpotifyId, context),
    ).rejects.toThrow('Provider returned a different artist than requested.')
    expect(mockPaths(context)).toEqual([
      '/api/token',
      '/v1/artists/' + competingSpotifyId,
    ])
  })

  it('retains the canonical Last.fm artist URL when the artist has no MBID', async () => {
    const artist = { name: artistName, url: lastFmUrl, mbid: '' }
    const context = responses(
      {
        results: {
          'opensearch:totalResults': '1',
          artistmatches: { artist: [artist] },
        },
      },
      {
        artist: {
          ...artist,
          bio: {
            summary:
              'Fixture biography. <a href="https://www.last.fm">Read more</a>',
          },
          tags: { tag: [{ name: 'Ambient' }] },
        },
      },
    )
    expect(
      await lookupArtistProvider('lastfm', artistName, null, context),
    ).toMatchObject({
      profile: {
        externalId: lastFmUrl,
        url: lastFmUrl,
        tags: ['Ambient'],
        summary: 'Fixture biography.',
      },
      payload: { search: { results: {} }, artist: { artist } },
    })
    const search = new URL(String(context.request.mock.calls[0]?.[0]))
    const detail = new URL(String(context.request.mock.calls[1]?.[0]))
    expect(search.searchParams.get('method')).toBe('artist.search')
    expect(search.searchParams.get('limit')).toBe('5')
    expect(detail.searchParams.get('method')).toBe('artist.getInfo')
    expect(detail.searchParams.get('artist')).toBe(artistName)
    expect(detail.searchParams.get('autocorrect')).toBe('0')
    expect(context.request).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])(
    'verifies a truncated Last.fm search against recordings and the final profile (changed ID: %s)',
    async (changedId) => {
      const artist = { name: artistName, mbid, url: lastFmUrl }
      const titles = ['Fixture Recording', 'Another Recording']
      const context = {
        ...responses(
          {
            results: {
              'opensearch:totalResults': '30',
              artistmatches: { artist: [artist] },
            },
          },
          { toptracks: { track: titles.map((name) => ({ name, artist })) } },
          {
            artist: {
              ...artist,
              url: changedId ? lastFmUrl + '+Alternative' : lastFmUrl,
            },
          },
        ),
        loadLastfmRecordings: vi.fn(async () =>
          titles.map((title) => ({ title, albumName: null })),
        ),
      }
      const result = lookupArtistProvider('lastfm', artistName, null, context)
      if (changedId)
        await expect(result).rejects.toThrow('different artist than requested')
      else
        await expect(result).resolves.toMatchObject({
          profile: { externalId: mbid },
          payload: {
            recordingVerification: {
              matchedTitles: titles,
              artistMbid: mbid,
              artistUrl: lastFmUrl,
            },
          },
        })
      expect(context.loadLastfmRecordings).toHaveBeenCalledOnce()
      expect(context.request).toHaveBeenCalledTimes(3)
    },
  )

  it.each([true, false])(
    'rechecks a stale Last.fm MBID only when inferred (inferred: %s)',
    async (inferred) => {
      const stale = '22222222-2222-4222-8222-222222222222'
      const artist = { name: artistName, mbid, url: lastFmUrl }
      const titles = ['Fixture Recording', 'Another Recording']
      const context = {
        ...responses(
          { error: 6, message: 'The artist you supplied could not be found' },
          {
            results: {
              'opensearch:totalResults': '1',
              artistmatches: { artist: [artist] },
            },
          },
          { toptracks: { track: titles.map((name) => ({ name, artist })) } },
          { artist },
        ),
        inferredLastfmMbid: inferred,
        loadLastfmRecordings: async () =>
          titles.map((title) => ({ title, albumName: null })),
      }
      const result = lookupArtistProvider('lastfm', artistName, stale, context)
      if (inferred) {
        await expect(result).resolves.toMatchObject({
          profile: { externalId: mbid },
          payload: {
            rejectedInferredId: stale,
            recordingVerification: { matchedTitles: titles },
          },
        })
        expect(context.request).toHaveBeenCalledTimes(4)
      } else {
        await expect(result).rejects.toBeInstanceOf(ProviderItemNotFoundError)
        expect(context.request).toHaveBeenCalledOnce()
      }
    },
  )

  it('retains the numeric Last.fm error code without the upstream message', async () => {
    const context = responses({
      error: 6,
      message: `Fixture invalid artist input for ${lastFmKey}`,
      api_key: lastFmKey,
    })
    await expect(
      lookupArtistProvider('lastfm', artistName, mbid, context),
    ).rejects.toHaveProperty(
      'message',
      'Last.fm returned a service error (code 6).',
    )
    expect(context.request).toHaveBeenCalledTimes(1)
    expect(context.recordDiagnostic).toHaveBeenCalledExactlyOnceWith({
      stage: 'last.fm.response',
      evidence: {
        path: '/2.0/',
        query: { method: 'artist.getInfo' },
        status: 200,
        response: {
          error: 6,
          message: 'Fixture invalid artist input for [REDACTED]',
          api_key: '[REDACTED]',
        },
      },
    })
  })

  it.each([
    { upstreamCode: 10, code: 'access-denied' },
    { upstreamCode: 29, code: 'rate-limit' },
  ])('preserves Last.fm $code errors', async ({ upstreamCode, code }) => {
    const context = responses({
      error: upstreamCode,
      message: 'Fixture API error',
    })
    await expect(
      lookupArtistProvider('lastfm', artistName, mbid, context),
    ).rejects.toMatchObject({ name: ProviderRequestError.name, code })
    expect(context.request).toHaveBeenCalledTimes(1)
  })

  it.each(['Artist not found', 'The artist you supplied could not be found'])(
    'classifies Last.fm artist.getInfo error 6 with message %j as not found',
    async (message) => {
      const context = responses({ error: 6, message })
      await expect(
        lookupArtistProvider('lastfm', artistName, mbid, context),
      ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
      expect(context.request).toHaveBeenCalledTimes(1)
    },
  )

  it('rejects Discogs numeric suffix ambiguities without reading any artist details', async () => {
    const context = responses({
      pagination: { items: 2 },
      results: [
        { id: 10, title: artistName, type: 'artist' },
        { id: 11, title: artistName + ' (2)', type: 'artist' },
      ],
    })
    await expect(
      lookupArtistProvider('discogs', artistName, null, context),
    ).rejects.toBeInstanceOf(ArtistSearchAmbiguousError)
    expect(context.request).toHaveBeenCalledTimes(1)
    expect(context.recordDiagnostic).toHaveBeenCalledWith({
      stage: 'artist.candidates',
      evidence: {
        total: 2,
        candidates: [
          { id: '10', name: artistName },
          { id: '11', name: artistName + ' (2)' },
        ],
      },
    })
    expect(
      new URL(String(context.request.mock.calls[0]?.[0])).searchParams.get(
        'type',
      ),
    ).toBe('artist')
  })

  it('uses a Discogs artist ID without visiting release, master or discography endpoints', async () => {
    const context = responses({
      id: 10,
      name: artistName,
      profile: 'Fixture profile',
    })
    expect(
      await lookupArtistProvider('discogs', artistName, '10', context),
    ).toMatchObject({
      profile: {
        name: artistName,
        externalId: '10',
        summary: 'Fixture profile',
        tags: [],
      },
    })
    expect(context.request).toHaveBeenCalledTimes(1)
    expect(new URL(String(context.request.mock.calls[0]?.[0])).pathname).toBe(
      '/artists/10',
    )
  })

  it('reads MusicBrainz artist genres and tags without release-group data', async () => {
    const artist = { id: mbid, name: artistName, country: null, type: 'Group' }
    const context = responses(
      { count: 1, artists: [artist] },
      {
        ...artist,
        genres: [{ name: 'Ambient' }],
        tags: [{ name: 'Ambient' }, { name: 'Dreamy' }],
      },
    )
    expect(
      await lookupArtistProvider('musicbrainz', artistName, null, context),
    ).toMatchObject({
      profile: { externalId: mbid, tags: ['Ambient', 'Dreamy'], type: 'Group' },
    })
    expect(context.request).toHaveBeenCalledTimes(2)
    const detail = new URL(String(context.request.mock.calls[1]?.[0]))
    expect(detail.pathname).toBe('/ws/2/artist/' + mbid)
    expect(detail.searchParams.get('inc')).toBe('tags+genres')
  })

  it('requires a direct ID if the full search cannot fit in the bounded page', async () => {
    const context = responses({
      count: 8,
      artists: [{ id: mbid, name: artistName }],
    })
    await expect(
      lookupArtistProvider('musicbrainz', artistName, null, context),
    ).rejects.toBeInstanceOf(ArtistSearchAmbiguousError)
    expect(context.request).toHaveBeenCalledTimes(1)
  })

  it('rejects an artist profile that changes identity after an exact name search', async () => {
    const context = responses(
      { count: 1, artists: [{ id: mbid, name: artistName }] },
      { id: mbid, name: artistName + ' (different)', tags: [] },
    )
    await expect(
      lookupArtistProvider('musicbrainz', artistName, null, context),
    ).rejects.toThrow('Provider returned a different artist than requested.')
  })

  it('rejects Last.fm album and external URLs as explicit artist IDs', () => {
    expect(
      normalizeArtistProviderId('lastfm', lastFmUrl + '/Album+Fixture'),
    ).toBeNull()
    expect(
      normalizeArtistProviderId(
        'lastfm',
        'https://other.example.test/music/Artist+Fixture',
      ),
    ).toBeNull()
    expect(
      normalizeArtistProviderId(
        'lastfm',
        'https://user:pass@www.last.fm/music/Artist+Fixture',
      ),
    ).toBeNull()
  })
})
