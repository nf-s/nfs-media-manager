import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderRequestError } from '@repo/media-plugin-sdk'

const mocks = vi.hoisted(() => ({
  secrets: vi.fn(),
  request: vi.fn(),
  requestFactory: vi.fn(),
  success: vi.fn(),
  failure: vi.fn(),
  plugin: vi.fn(),
  media: vi.fn(),
  overrides: vi.fn(),
  references: vi.fn(),
  artist: vi.fn(),
  releaseHints: vi.fn(),
  rejections: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => [] }) }),
    query: {
      mediaItem: { findFirst: mocks.media },
      providerReferenceOverride: { findMany: mocks.overrides },
      providerReference: { findMany: mocks.references },
    },
  },
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: mocks.secrets,
}))
vi.mock('@/plugins/registry', () => ({ getScrapePlugin: mocks.plugin }))
vi.mock('@/services/provider-requests', () => ({
  createProviderRequest: mocks.requestFactory,
  recordProviderSuccess: mocks.success,
  recordProviderFailure: mocks.failure,
}))
vi.mock('@/services/artist-profiles', () => ({
  loadArtistProviderTarget: mocks.artist,
}))
vi.mock('@/services/album-imports', () => ({}))
vi.mock('@/services/album-release-hints', () => ({
  getAlbumReleaseHints: mocks.releaseHints,
}))
vi.mock('@/services/album-match-rejections', () => ({
  readAlbumMatchRejections: mocks.rejections,
}))
vi.mock('@/services/file-imports', () => ({}))

import { ServerError } from '@/lib/error'
import { discogsPlugin } from '@/plugins/builtin/discogs'
import { lastfmPlugin } from '@/plugins/builtin/lastfm'
import { musicbrainzPlugin } from '@/plugins/builtin/musicbrainz'
import { serplyPlugin } from '@/plugins/builtin/serply'
import { tmdbPlugin } from '@/plugins/builtin/tmdb'
import { searchMatchCandidates } from '../find-match'

const artistMbid = '22222222-2222-4222-8222-222222222222'
const otherMbid = '33333333-3333-4333-8333-333333333333'

const discogsResults = (id: number, type: 'master' | 'release') => ({
  pagination: { items: 1 },
  results: [{ id, type, title: `Example Artist - Example Album ${id}` }],
})

async function refusal(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught)
  if (!(error instanceof ServerError)) throw new Error('Expected a refusal')
  return error.response
}

describe('find match', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Live requests forbidden')
      }),
    )
    mocks.requestFactory.mockReturnValue(mocks.request)
    mocks.plugin.mockImplementation(async (provider: string) =>
      [
        discogsPlugin,
        lastfmPlugin,
        musicbrainzPlugin,
        serplyPlugin,
        tmdbPlugin,
      ].find((plugin) => plugin.manifest.id === provider),
    )
    mocks.secrets.mockReturnValue({
      token: 'fixture-token',
      apiKey: 'fixture-key',
      appName: 'FixtureApp',
      appVersion: '1.0',
      contact: 'offline@example.test',
    })
    mocks.media.mockResolvedValue({
      id: 'album-1',
      mediaType: 'album',
      title: 'Example Album',
      releaseDate: null,
      credits: [
        {
          role: 'artist',
          billingOrder: 0,
          artist: { name: 'Example Artist' },
        },
      ],
    })
    mocks.overrides.mockResolvedValue([])
    mocks.references.mockResolvedValue([])
    mocks.rejections.mockResolvedValue([])
  })
  afterEach(() => vi.unstubAllGlobals())

  it('supplies stored release evidence to an opted-in album match search', async () => {
    const releaseHints = [
      { source: 'musicbrainz', title: 'Fixture release group' },
    ]
    mocks.releaseHints.mockResolvedValue(releaseHints)
    const search = vi.fn().mockResolvedValue([])
    mocks.plugin.mockResolvedValue({
      ...discogsPlugin,
      manifest: { ...discogsPlugin.manifest, albumReleaseHints: true },
      searchMatchCandidates: search,
    })
    await searchMatchCandidates({
      kind: 'album',
      id: 'album-1',
      provider: 'discogs',
    })
    expect(mocks.releaseHints).toHaveBeenCalledWith('album-1', [])
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        media: expect.objectContaining({ releaseHints }),
      }),
    )
  })

  it('omits a rejected identity while keeping a distinct candidate with the same ID', async () => {
    mocks.rejections.mockResolvedValue([
      {
        provider: 'discogs',
        sourceProvider: 'discogs',
        referenceType: 'master',
        identifier: '22',
        aliases: [],
      },
    ])
    mocks.request
      .mockResolvedValueOnce(Response.json(discogsResults(22, 'master')))
      .mockResolvedValueOnce(Response.json(discogsResults(22, 'release')))
    const result = await searchMatchCandidates({
      kind: 'album',
      id: 'album-1',
      provider: 'discogs',
    })
    expect(result.items).toEqual([
      expect.objectContaining({ referenceType: 'release', externalId: '22' }),
    ])
  })

  it('searches an album provider through its request policy and marks the stored record', async () => {
    mocks.request
      .mockResolvedValueOnce(Response.json(discogsResults(11, 'master')))
      .mockResolvedValueOnce(Response.json(discogsResults(22, 'release')))
    mocks.overrides.mockResolvedValue([
      { referenceType: 'release', externalId: '99' },
      { referenceType: 'release', externalId: '22' },
    ])
    mocks.references.mockResolvedValue([
      { provider: 'discogs', referenceType: 'master', externalId: '10' },
      { provider: 'spotify', referenceType: 'release', externalId: '11' },
    ])
    const result = await searchMatchCandidates({
      kind: 'album',
      id: 'album-1',
      provider: 'discogs',
    })
    expect(result.query).toBe('Example Artist Example Album')
    expect(
      result.items.map(({ externalId, referenceType, current }) => ({
        externalId,
        referenceType,
        current,
      })),
    ).toEqual([
      { externalId: '11', referenceType: 'master', current: false },
      { externalId: '22', referenceType: 'release', current: true },
    ])
    expect(result.items[0]).toMatchObject({
      title: 'Example Album 11',
      subtitle: 'Example Artist',
      releaseDate: null,
      artworkUrl: null,
      url: 'https://www.discogs.com/master/11',
    })
    expect(mocks.requestFactory).toHaveBeenCalledWith(discogsPlugin, undefined)
    expect(mocks.request).toHaveBeenCalledTimes(2)
    expect(mocks.success).toHaveBeenCalledWith('discogs')
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.releaseHints).not.toHaveBeenCalled()
  })

  it('searches the text the owner typed', async () => {
    mocks.request.mockResolvedValue(
      Response.json({ count: 0, 'release-groups': [] }),
    )
    const result = await searchMatchCandidates({
      kind: 'album',
      id: 'album-1',
      provider: 'musicbrainz',
      q: ' Typed words ',
    })
    expect(result).toEqual({
      provider: 'musicbrainz',
      query: 'Typed words',
      items: [],
    })
    expect(
      new URL(String(mocks.request.mock.calls[0]?.[0])).searchParams.get(
        'query',
      ),
    ).toBe('Typed words')
  })

  it('escapes query syntax in the text sent to MusicBrainz', async () => {
    mocks.request.mockImplementation(async () =>
      Response.json({ count: 0, 'release-groups': [] }),
    )
    const query = () =>
      new URL(String(mocks.request.mock.calls.at(-1)?.[0])).searchParams.get(
        'query',
      )
    const typed = await searchMatchCandidates({
      kind: 'album',
      id: 'album-1',
      provider: 'musicbrainz',
      q: 'Help! (Deluxe) "Live',
    })
    expect(typed.query).toBe('Help! (Deluxe) "Live')
    expect(query()).toBe('Help\\! \\(Deluxe\\) \\"Live')
    mocks.media.mockResolvedValue({
      id: 'album-1',
      mediaType: 'album',
      title: 'Help!',
      releaseDate: null,
      credits: [],
    })
    await searchMatchCandidates({
      kind: 'album',
      id: 'album-1',
      provider: 'musicbrainz',
    })
    expect(query()).toBe('Help\\!')
    mocks.request.mockImplementation(async () =>
      Response.json({ count: 0, artists: [] }),
    )
    mocks.artist.mockResolvedValue({
      name: 'Example Artist',
      providerArtistId: null,
    })
    await searchMatchCandidates({
      kind: 'artist',
      id: 'artist-1',
      provider: 'musicbrainz',
      q: 'AC/DC',
    })
    expect(query()).toBe('AC\\/DC')
  })

  it('refuses cleanly when the request policy blocks the provider', async () => {
    mocks.request.mockRejectedValue(
      new ProviderRequestError(
        'Provider cooldown is active',
        'cooldown',
        Date.now() + 60000,
        true,
      ),
    )
    expect(
      await refusal(
        searchMatchCandidates({
          kind: 'album',
          id: 'album-1',
          provider: 'musicbrainz',
        }),
      ),
    ).toMatchObject({ statusCode: 422, message: 'Provider cooldown is active' })
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.success).not.toHaveBeenCalled()
  })

  it('refuses providers without match search, missing items and missing credentials before any request', async () => {
    expect(
      await refusal(
        searchMatchCandidates({
          kind: 'album',
          id: 'album-1',
          provider: 'serply',
        }),
      ),
    ).toMatchObject({
      statusCode: 422,
      message: 'Find match is not available for this provider.',
    })
    expect(
      await refusal(
        searchMatchCandidates({
          kind: 'film',
          id: 'album-1',
          provider: 'tmdb',
        }),
      ),
    ).toMatchObject({ statusCode: 404, message: 'Film not found.' })
    mocks.secrets.mockReturnValue({})
    expect(
      await refusal(
        searchMatchCandidates({
          kind: 'album',
          id: 'album-1',
          provider: 'musicbrainz',
        }),
      ),
    ).toMatchObject({
      statusCode: 422,
      message:
        'Configure MusicBrainz credentials in Providers before searching.',
    })
    // A local-worker provider with no connected worker needs its own token.
    expect(
      await refusal(
        searchMatchCandidates({
          kind: 'album',
          id: 'album-1',
          provider: 'discogs',
        }),
      ),
    ).toMatchObject({
      statusCode: 422,
      message: 'Configure Discogs credentials in Providers before searching.',
    })
    await expect(
      searchMatchCandidates({ kind: 'album', id: 'album-1', provider: '' }),
    ).rejects.toThrow()
    expect(mocks.requestFactory).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('treats the film identifiers TMDb shares as stored', async () => {
    mocks.media.mockResolvedValue({
      id: 'film-1',
      mediaType: 'film',
      title: 'Example Film',
      releaseDate: new Date('2021-01-02T00:00:00Z'),
      credits: [],
    })
    mocks.references.mockResolvedValue([
      { provider: 'nfo', referenceType: 'tmdb', externalId: '701' },
    ])
    mocks.request.mockResolvedValue(
      Response.json({
        page: 1,
        total_pages: 1,
        results: [{ id: 701, title: 'Example Film' }],
      }),
    )
    const result = await searchMatchCandidates({
      kind: 'film',
      id: 'film-1',
      provider: 'tmdb',
    })
    expect(result.query).toBe('Example Film')
    expect(result.items).toEqual([
      {
        referenceType: 'tmdb',
        externalId: '701',
        title: 'Example Film',
        subtitle: null,
        releaseDate: null,
        artworkUrl: null,
        url: 'https://www.themoviedb.org/movie/701',
        current: true,
      },
    ])
  })

  it('searches an artist provider by the artist name and marks the confirmed ID', async () => {
    mocks.artist.mockResolvedValue({
      name: 'Example Artist',
      providerArtistId: artistMbid.toUpperCase(),
    })
    mocks.request.mockResolvedValue(
      Response.json({
        count: 2,
        artists: [
          { id: artistMbid, name: 'Example Artist', disambiguation: 'Band' },
          { id: otherMbid, name: 'Example Artist' },
        ],
      }),
    )
    const result = await searchMatchCandidates({
      kind: 'artist',
      id: 'artist-1',
      provider: 'musicbrainz',
    })
    expect(mocks.artist).toHaveBeenCalledWith('artist-1', 'musicbrainz')
    expect(result).toEqual({
      provider: 'musicbrainz',
      query: 'Example Artist',
      items: [
        {
          referenceType: 'artist',
          externalId: artistMbid,
          title: 'Example Artist',
          subtitle: 'Band',
          releaseDate: null,
          artworkUrl: null,
          url: `https://musicbrainz.org/artist/${artistMbid}`,
          current: true,
        },
        {
          referenceType: 'artist',
          externalId: otherMbid,
          title: 'Example Artist',
          subtitle: null,
          releaseDate: null,
          artworkUrl: null,
          url: `https://musicbrainz.org/artist/${otherMbid}`,
          current: false,
        },
      ],
    })
    expect(mocks.requestFactory).toHaveBeenCalledWith(
      musicbrainzPlugin,
      undefined,
    )
  })

  it('refuses unknown artist providers and missing artists', async () => {
    expect(
      await refusal(
        searchMatchCandidates({
          kind: 'artist',
          id: 'artist-1',
          provider: 'tmdb',
        }),
      ),
    ).toMatchObject({ statusCode: 422 })
    mocks.artist.mockResolvedValue(null)
    expect(
      await refusal(
        searchMatchCandidates({
          kind: 'artist',
          id: 'artist-1',
          provider: 'discogs',
        }),
      ),
    ).toMatchObject({ statusCode: 404, message: 'Artist not found.' })
    expect(mocks.request).not.toHaveBeenCalled()
  })
})
