import { describe, expect, it, vi } from 'vitest'
import {
  PluginMatchCandidatesSchema,
  isMediaProviderPlugin,
  type MediaPluginMatchSearchContext,
  type MediaPluginTestContext,
} from '@repo/media-plugin-sdk'
import { listBuiltinScrapePlugins } from '../index'
import { discogsPlugin } from '../discogs'
import { lastfmPlugin } from '../lastfm'
import { musicbrainzPlugin } from '../musicbrainz'
import { spotifyPlugin } from '../spotify'
import { tmdbPlugin } from '../tmdb'
import { searchArtistCandidates } from '../artist-providers'
import {
  spotifyAlbumFixture,
  spotifyAlbumId,
  spotifyTokenFixture,
} from './fixtures/spotify'

const groupId = '11111111-1111-4111-8111-111111111111'
const artistMbid = '22222222-2222-4222-8222-222222222222'

function replies(...payloads: unknown[]) {
  const queue = [...payloads]
  return vi.fn<MediaPluginTestContext['request']>(async () => {
    const next = queue.shift()
    if (next === undefined) throw new Error('Exceeded mocked request bound')
    return Response.json(next)
  })
}

function context(
  request: MediaPluginTestContext['request'],
  overrides: Partial<MediaPluginMatchSearchContext> = {},
): MediaPluginMatchSearchContext {
  return {
    mediaType: 'album',
    media: { title: 'Example Album', artists: ['Example Artist'] },
    secrets: {
      clientId: 'fixture-client',
      clientSecret: 'fixture-secret',
      apiKey: 'fixture-key',
      token: 'fixture-token',
      appName: 'FixtureApp',
      appVersion: '1.0',
      contact: 'offline@example.test',
    },
    request,
    ...overrides,
  }
}

function requestUrl(request: ReturnType<typeof replies>, index: number) {
  return new URL(String(request.mock.calls[index]?.[0]))
}

describe('provider match candidates', () => {
  it('is offered by providers with catalog candidate searches', () => {
    expect(
      listBuiltinScrapePlugins()
        .filter((plugin) => plugin.searchMatchCandidates)
        .map((plugin) => plugin.manifest.id)
        .sort(),
    ).toEqual(['discogs', 'lastfm', 'musicbrainz', 'spotify', 'tmdb'])
    expect(isMediaProviderPlugin(spotifyPlugin)).toBe(true)
    expect(
      isMediaProviderPlugin({
        ...spotifyPlugin,
        searchMatchCandidates: 'not a function',
      }),
    ).toBe(false)
  })

  it('lists Spotify albums from the scrape search, or the owner text', async () => {
    const request = replies(spotifyTokenFixture, {
      albums: { items: [spotifyAlbumFixture()], total: 1 },
    })
    const candidates = await spotifyPlugin.searchMatchCandidates?.(
      context(request, {
        secrets: { ...context(request).secrets, market: 'AU' },
      }),
    )
    expect(PluginMatchCandidatesSchema.parse(candidates)).toEqual([
      {
        referenceType: 'album',
        externalId: spotifyAlbumId,
        title: 'Example Album',
        subtitle: 'Example Artist',
        releaseDate: '2020-05',
        artworkUrl: 'https://i.scdn.co/image/example',
        upc: '012345678901',
        url: `https://open.spotify.com/album/${spotifyAlbumId}`,
      },
    ])
    expect(Object.fromEntries(requestUrl(request, 1).searchParams)).toEqual({
      market: 'AU',
      q: 'album:"Example Album" artist:"Example Artist"',
      type: 'album',
      limit: '10',
    })

    const typed = replies(spotifyTokenFixture, {
      albums: { items: [], total: 0 },
    })
    expect(
      await spotifyPlugin.searchMatchCandidates?.(
        context(typed, { query: 'Other words' }),
      ),
    ).toEqual([])
    expect(requestUrl(typed, 1).searchParams.get('q')).toBe('Other words')
    expect(typed).toHaveBeenCalledTimes(2)
  })

  it('searches Last.fm album titles without sending the account username', async () => {
    const url = 'https://www.last.fm/music/Example+Artist/Example+Album'
    const request = replies({
      results: {
        albummatches: {
          album: [
            { name: 'Example Album', artist: 'Example Artist', url, mbid: '' },
          ],
        },
      },
    })
    const search = context(request)
    search.secrets = { ...search.secrets, username: 'fixture-account' }
    expect(await lastfmPlugin.searchMatchCandidates?.(search)).toEqual([
      {
        referenceType: 'url',
        externalId: url,
        title: 'Example Album',
        subtitle: 'Example Artist',
        url,
      },
    ])
    const params = requestUrl(request, 0).searchParams
    expect(params.get('method')).toBe('album.search')
    expect(params.get('album')).toBe('Example Album')
    expect(params.get('limit')).toBe('10')
    expect(params.has('username')).toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('preserves the URL alongside the Last.fm release MBID for rejection checks', async () => {
    const url = 'https://www.last.fm/music/Example+Artist/Example+Album'
    const request = replies({
      results: {
        albummatches: {
          album: [
            {
              name: 'Example Album',
              artist: 'Example Artist',
              url,
              mbid: groupId,
            },
          ],
        },
      },
    })
    expect(
      await lastfmPlugin.searchMatchCandidates?.(context(request)),
    ).toMatchObject([{ referenceType: 'mbid', externalId: groupId, url }])
  })

  it('handles an empty Last.fm search and sends an edited search term', async () => {
    const request = replies({ results: { albummatches: { album: [] } } })
    expect(
      await lastfmPlugin.searchMatchCandidates?.(
        context(request, { query: 'Alternate title' }),
      ),
    ).toEqual([])
    expect(requestUrl(request, 0).searchParams.get('album')).toBe(
      'Alternate title',
    )
  })

  it('lists MusicBrainz release groups with their artists and first release', async () => {
    const request = replies({
      count: 1,
      'release-groups': [
        {
          id: groupId,
          title: 'Example Album',
          'first-release-date': '2001-02-03',
          'artist-credit': [
            {
              name: 'Example Artist',
              artist: { id: artistMbid, name: 'Example Artist' },
            },
          ],
        },
      ],
    })
    expect(
      await musicbrainzPlugin.searchMatchCandidates?.(context(request)),
    ).toEqual([
      {
        referenceType: 'release-group',
        externalId: groupId,
        title: 'Example Album',
        subtitle: 'Example Artist',
        releaseDate: '2001-02-03',
        url: `https://musicbrainz.org/release-group/${groupId}`,
      },
    ])
    expect(requestUrl(request, 0).searchParams.get('query')).toBe(
      'releasegroup:"Example Album" AND artist:"Example Artist"',
    )
    expect(requestUrl(request, 0).searchParams.get('limit')).toBe('5')
  })

  it('lists Discogs masters then releases, splitting artist and title', async () => {
    const request = replies(
      {
        pagination: { items: 1 },
        results: [
          {
            id: 11,
            type: 'master',
            title: 'Example Artist - Example Album',
            year: '2001',
            thumb: 'https://img.example.test/master.jpg',
          },
        ],
      },
      {
        pagination: { items: 1 },
        results: [
          {
            id: 22,
            type: 'release',
            title: 'Untitled',
            year: 2002,
            thumb: '',
          },
        ],
      },
    )
    expect(
      await discogsPlugin.searchMatchCandidates?.(context(request)),
    ).toEqual([
      {
        referenceType: 'master',
        externalId: '11',
        title: 'Example Album',
        subtitle: 'Example Artist',
        releaseDate: '2001',
        artworkUrl: 'https://img.example.test/master.jpg',
        url: 'https://www.discogs.com/master/11',
      },
      {
        referenceType: 'release',
        externalId: '22',
        title: 'Untitled',
        subtitle: undefined,
        releaseDate: '2002',
        artworkUrl: undefined,
        url: 'https://www.discogs.com/release/22',
      },
    ])
    expect(Object.fromEntries(requestUrl(request, 0).searchParams)).toEqual({
      type: 'master',
      artist: 'Example Artist',
      release_title: 'Example Album',
      per_page: '5',
      page: '1',
    })
    const typed = replies(
      { pagination: { items: 0 }, results: [] },
      { pagination: { items: 0 }, results: [] },
    )
    await discogsPlugin.searchMatchCandidates?.(
      context(typed, { query: 'Typed text' }),
    )
    expect(requestUrl(typed, 1).searchParams.get('q')).toBe('Typed text')
    expect(requestUrl(typed, 1).searchParams.get('type')).toBe('release')
  })

  it('lists TMDb films with poster and original title', async () => {
    const request = replies({
      page: 1,
      total_pages: 1,
      results: [
        {
          id: 701,
          title: 'Example Film',
          original_title: 'Original Film',
          release_date: '2021-01-02',
          poster_path: '/poster.jpg',
        },
        { id: 702, title: 'Second Film', release_date: '' },
      ],
    })
    expect(
      await tmdbPlugin.searchMatchCandidates?.(
        context(request, {
          mediaType: 'film',
          media: { title: 'Example Film', artists: [] },
        }),
      ),
    ).toEqual([
      {
        referenceType: 'tmdb',
        externalId: '701',
        title: 'Example Film',
        subtitle: 'Original Film',
        releaseDate: '2021-01-02',
        artworkUrl: 'https://image.tmdb.org/t/p/w185/poster.jpg',
        url: 'https://www.themoviedb.org/movie/701',
      },
      {
        referenceType: 'tmdb',
        externalId: '702',
        title: 'Second Film',
        subtitle: undefined,
        releaseDate: undefined,
        artworkUrl: undefined,
        url: 'https://www.themoviedb.org/movie/702',
      },
    ])
    expect(requestUrl(request, 0).pathname).toBe('/3/search/movie')
    expect(requestUrl(request, 0).searchParams.get('query')).toBe(
      'Example Film',
    )
  })

  it('refuses a media type the provider does not cover without a request', async () => {
    const request = replies()
    await expect(
      tmdbPlugin.searchMatchCandidates?.(context(request)),
    ).rejects.toThrow('only supports films')
    await expect(
      discogsPlugin.searchMatchCandidates?.(
        context(request, { mediaType: 'film' }),
      ),
    ).rejects.toThrow('only supports albums')
    expect(request).not.toHaveBeenCalled()
  })

  it('lists artists from the lookup search, keeping disambiguation and artwork', async () => {
    const musicbrainz = replies({
      count: 2,
      artists: [
        {
          id: artistMbid.toUpperCase(),
          name: 'Example Artist',
          disambiguation: 'Band',
        },
        { id: groupId, name: 'Example Artist' },
      ],
    })
    expect(
      await searchArtistCandidates(
        'musicbrainz',
        'Example Artist',
        undefined,
        context(musicbrainz),
      ),
    ).toEqual([
      { id: artistMbid, name: 'Example Artist', details: 'Band' },
      { id: groupId, name: 'Example Artist' },
    ])
    expect(requestUrl(musicbrainz, 0).searchParams.get('query')).toBe(
      'artist:"Example Artist"',
    )

    const spotify = replies(spotifyTokenFixture, {
      artists: {
        total: 1,
        items: [
          {
            id: spotifyAlbumId,
            name: 'Example Artist',
            type: 'artist',
            images: [{ url: 'https://i.scdn.co/image/artist?size=1' }],
          },
        ],
      },
    })
    expect(
      await searchArtistCandidates(
        'spotify',
        'Example Artist',
        'Typed artist',
        context(spotify),
      ),
    ).toEqual([
      {
        id: spotifyAlbumId,
        name: 'Example Artist',
        artworkUrl: 'https://i.scdn.co/image/artist',
      },
    ])
    expect(requestUrl(spotify, 1).searchParams.get('q')).toBe('Typed artist')
  })
})
