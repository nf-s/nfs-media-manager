import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  secrets: vi.fn(),
  request: vi.fn(),
  requestFactory: vi.fn(),
  success: vi.fn(),
  failure: vi.fn(),
  albumMatches: vi.fn(),
  filmMatches: vi.fn(),
  addAlbum: vi.fn(),
  addFilm: vi.fn(),
  plugin: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  db: { select: () => ({ from: () => ({ where: async () => [] }) }) },
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
vi.mock('@/services/album-imports', () => ({
  matchAlbumCandidates: mocks.albumMatches,
  commitAlbumImportRecord: mocks.addAlbum,
}))
vi.mock('@/services/file-imports', () => ({
  matchFilmCandidates: mocks.filmMatches,
  commitFilmImportRecord: mocks.addFilm,
}))

import { spotifyPlugin } from '@/plugins/builtin/spotify'
import { tmdbPlugin } from '@/plugins/builtin/tmdb'
import {
  spotifyAlbumFixture,
  spotifyAlbumId,
  spotifyTokenFixture,
} from '@/plugins/builtin/__tests__/fixtures/spotify'
import { addManualMedia, searchManualMedia } from '../manual-add'

describe('manual provider search and library additions', () => {
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
      provider === 'spotify' ? spotifyPlugin : tmdbPlugin,
    )
    mocks.secrets.mockReturnValue({
      clientId: 'test-client',
      clientSecret: 'test-secret',
      apiKey: 'test-key',
      market: 'AU',
    })
    mocks.albumMatches.mockResolvedValue([{ id: null, error: null }])
    mocks.filmMatches.mockResolvedValue([{ id: null, error: null }])
    mocks.addAlbum.mockResolvedValue({ id: 'new-album', created: true })
    mocks.addFilm.mockResolvedValue({
      id: 'new-film',
      action: 'new',
      changes: [],
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('checks cancellation before searching without recording a provider failure', async () => {
    const assertActive = vi.fn(async () => {
      throw new Error('Cancelled')
    })
    await expect(
      searchManualMedia({ mediaType: 'album', q: 'Example' }, assertActive),
    ).rejects.toThrow('Cancelled')
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.failure).not.toHaveBeenCalled()
  })

  it('searches one bounded Spotify page and returns enough metadata to choose an edition', async () => {
    mocks.request
      .mockResolvedValueOnce(Response.json(spotifyTokenFixture))
      .mockResolvedValueOnce(
        Response.json({
          albums: { items: [spotifyAlbumFixture()], total: 31, offset: 10 },
        }),
      )
    mocks.albumMatches.mockResolvedValue([
      { id: 'existing-album', error: null },
    ])
    const result = await searchManualMedia({
      mediaType: 'album',
      q: ' Example Artist Example Album ',
      page: 2,
    })
    expect(result).toEqual({
      page: 2,
      hasMore: true,
      items: [
        {
          externalId: spotifyAlbumId,
          title: 'Example Album',
          subtitle: 'Example Artist',
          releaseDate: '2020-05',
          artworkUrl: 'https://i.scdn.co/image/example',
          url: `https://open.spotify.com/album/${spotifyAlbumId}`,
          mediaItemId: 'existing-album',
        },
      ],
    })
    const url = new URL(String(mocks.request.mock.calls[1]?.[0]))
    expect(url.pathname).toBe('/v1/search')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'Example Artist Example Album',
      type: 'album',
      limit: '10',
      offset: '10',
      market: 'AU',
    })
    expect(mocks.request).toHaveBeenCalledTimes(2)
    expect(mocks.requestFactory).toHaveBeenCalledWith(spotifyPlugin, undefined)
    expect(mocks.addAlbum).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('searches only films and exposes a bounded explicit next page', async () => {
    mocks.request.mockResolvedValue(
      Response.json({
        page: 1,
        total_pages: 2,
        results: [
          {
            id: 701,
            title: 'Example Film',
            original_title: 'Original Film',
            release_date: '2021-01-02',
            poster_path: '/example.jpg',
          },
        ],
      }),
    )
    const result = await searchManualMedia({
      mediaType: 'film',
      q: 'Example Film',
    })
    expect(result.items[0]).toEqual({
      externalId: '701',
      title: 'Example Film',
      subtitle: 'Original Film',
      releaseDate: '2021-01-02',
      artworkUrl: 'https://image.tmdb.org/t/p/w185/example.jpg',
      url: 'https://www.themoviedb.org/movie/701',
      mediaItemId: null,
    })
    expect(result.hasMore).toBe(true)
    const url = new URL(String(mocks.request.mock.calls[0]?.[0]))
    expect(url.pathname).toBe('/3/search/movie')
    expect(url.searchParams.get('query')).toBe('Example Film')
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.requestFactory).toHaveBeenCalledWith(tmdbPlugin, undefined)
    expect(mocks.addFilm).not.toHaveBeenCalled()
  })

  it('does not make requests when credentials or search input are invalid', async () => {
    mocks.secrets.mockReturnValue({})
    await expect(
      searchManualMedia({ mediaType: 'album', q: 'Album' }),
    ).rejects.toThrow('Configure Spotify credentials')
    await expect(
      searchManualMedia({ mediaType: 'film', q: 'Film' }),
    ).rejects.toThrow('Configure TMDb credentials')
    await expect(
      searchManualMedia({ mediaType: 'film', q: ' ' }),
    ).rejects.toThrow()
    await expect(
      searchManualMedia({ mediaType: 'album', q: 'Album', page: 51 }),
    ).rejects.toThrow()
    await expect(
      addManualMedia({ mediaType: 'album', externalId: 'invalid' }),
    ).rejects.toThrow()
    await expect(
      addManualMedia({ mediaType: 'film', externalId: '../other' }),
    ).rejects.toThrow()
    expect(mocks.requestFactory).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('returns existing items without fetching or overwriting them', async () => {
    mocks.albumMatches.mockResolvedValue([
      { id: 'existing-album', error: null },
    ])
    mocks.filmMatches.mockResolvedValue([{ id: 'existing-film', error: null }])
    expect(
      await addManualMedia({ mediaType: 'album', externalId: spotifyAlbumId }),
    ).toEqual({ mediaItemId: 'existing-album', created: false })
    expect(
      await addManualMedia({ mediaType: 'film', externalId: '701' }),
    ).toEqual({ mediaItemId: 'existing-film', created: false })
    expect(mocks.requestFactory).not.toHaveBeenCalled()
    expect(mocks.addAlbum).not.toHaveBeenCalled()
    expect(mocks.addFilm).not.toHaveBeenCalled()
  })

  it('fetches the selected Spotify album including tracks and uses the atomic import writer', async () => {
    mocks.request
      .mockResolvedValueOnce(Response.json(spotifyTokenFixture))
      .mockResolvedValueOnce(Response.json(spotifyAlbumFixture()))
    expect(
      await addManualMedia({ mediaType: 'album', externalId: spotifyAlbumId }),
    ).toEqual({ mediaItemId: 'new-album', created: true })
    expect(new URL(String(mocks.request.mock.calls[1]?.[0])).pathname).toBe(
      `/v1/albums/${spotifyAlbumId}`,
    )
    expect(mocks.addAlbum).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'spotify',
        action: 'new',
        result: expect.objectContaining({
          normalized: expect.objectContaining({
            mediaPatch: expect.objectContaining({ title: 'Example Album' }),
            albumPatch: expect.objectContaining({
              dateAdded: expect.any(String),
            }),
            tracks: [expect.objectContaining({ title: 'Opening' })],
          }),
        }),
      }),
      undefined,
      { snapshotSource: 'manual-add' },
    )
    expect(mocks.request).toHaveBeenCalledTimes(2)
  })

  it('resolves the definitive film identifiers and preserves a concurrent existing match', async () => {
    mocks.request.mockResolvedValue(
      Response.json({
        id: 701,
        title: 'Example Film',
        imdb_id: 'tt1234567',
        release_date: '2021-01-02',
        credits: { cast: [], crew: [] },
        keywords: { keywords: [] },
      }),
    )
    mocks.addFilm.mockResolvedValue({
      id: 'existing-film',
      action: 'unchanged',
      changes: [],
    })
    expect(
      await addManualMedia({ mediaType: 'film', externalId: '701' }),
    ).toEqual({ mediaItemId: 'existing-film', created: false })
    expect(new URL(String(mocks.request.mock.calls[0]?.[0])).pathname).toBe(
      '/3/movie/701',
    )
    expect(mocks.addFilm).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'tmdb',
        result: expect.objectContaining({
          normalized: expect.objectContaining({
            references: expect.arrayContaining([
              expect.objectContaining({
                referenceType: 'imdb',
                externalId: 'tt1234567',
              }),
            ]),
            filmPatch: expect.objectContaining({
              dateAdded: expect.any(String),
              dateAddedSource: 'Manual addition',
            }),
          }),
        }),
      }),
      { newOnly: true, snapshotSource: 'manual-add' },
    )
  })

  it('rejects ambiguous identities and incorrect provider metadata before persisting', async () => {
    mocks.albumMatches.mockResolvedValueOnce([
      { id: 'one', error: 'Ambiguous album identity' },
    ])
    await expect(
      addManualMedia({ mediaType: 'album', externalId: spotifyAlbumId }),
    ).rejects.toThrow('Ambiguous album identity')
    expect(mocks.request).not.toHaveBeenCalled()
    mocks.request.mockResolvedValue(
      Response.json({ id: 702, title: 'Different Film' }),
    )
    await expect(
      addManualMedia({ mediaType: 'film', externalId: '701' }),
    ).rejects.toThrow('TMDb request failed or returned invalid data')
    expect(mocks.addAlbum).not.toHaveBeenCalled()
    expect(mocks.addFilm).not.toHaveBeenCalled()
    expect(mocks.failure).toHaveBeenCalledTimes(1)
  })

  it('stops on malformed responses or provider errors with no retry', async () => {
    mocks.request.mockResolvedValueOnce(Response.json({ invalid: true }))
    await expect(
      searchManualMedia({ mediaType: 'film', q: 'Film' }),
    ).rejects.toThrow('TMDb request failed or returned invalid data')
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.failure).toHaveBeenCalledTimes(1)
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.addFilm).not.toHaveBeenCalled()
  })
})
