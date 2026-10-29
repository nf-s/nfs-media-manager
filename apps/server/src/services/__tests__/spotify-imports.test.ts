import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderRequestError } from '@repo/media-plugin-sdk'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  token: vi.fn(),
  prepare: vi.fn(),
}))
vi.mock('@/services/spotify-oauth', () => ({
  spotifyAccountToken: mocks.token,
  spotifyOperation: (fn: (request: typeof mocks.request) => Promise<unknown>) =>
    fn(mocks.request),
}))
vi.mock('@/services/album-imports', () => ({
  prepareAlbumCandidates: mocks.prepare,
}))
import { previewSpotifyAlbums } from '../spotify-imports'
import { spotifyAlbumFixture } from '@/plugins/builtin/__tests__/fixtures/spotify'

function page(offset: number, count: number, total: number) {
  return {
    offset,
    total,
    next:
      offset + count < total ? 'https://untrusted.invalid/not-followed' : null,
    items: Array.from({ length: count }, () => ({
      added_at: '2020-01-01T00:00:00Z',
      album: spotifyAlbumFixture(),
    })),
  }
}
describe('explicit bounded Spotify discovery', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Live request forbidden')
      }),
    )
    mocks.token.mockResolvedValue('fake-token')
  })
  afterEach(() => vi.unstubAllGlobals())

  it('requests only the tiny explicit default and exposes a continuation, not an auto-run', async () => {
    mocks.request.mockResolvedValue(Response.json(page(0, 20, 300)))
    await previewSpotifyAlbums(
      { limit: 20, offset: 0, confirmBroadRun: false },
      'user-1',
    )
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(String(mocks.request.mock.calls[0]?.[0])).toBe(
      'https://api.spotify.com/v1/me/albums?limit=20&offset=0',
    )
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ records: expect.any(Array) }),
      'user-1',
      expect.objectContaining({
        discovery: expect.objectContaining({
          offset: 0,
          requested: 20,
          received: 20,
          total: 300,
          nextOffset: 20,
          scanned: 20,
          complete: false,
          order: 'dateAddedDesc',
        }),
      }),
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('bounds confirmed multi-page runs, using trusted URLs and exact final page size', async () => {
    mocks.request
      .mockResolvedValueOnce(Response.json(page(0, 50, 300)))
      .mockResolvedValueOnce(Response.json(page(50, 25, 300)))
    await previewSpotifyAlbums(
      { limit: 75, offset: 0, confirmBroadRun: true },
      'user-1',
    )
    expect(mocks.request).toHaveBeenCalledTimes(2)
    expect(String(mocks.request.mock.calls[1]?.[0])).toBe(
      'https://api.spotify.com/v1/me/albums?limit=25&offset=50',
    )
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      expect.objectContaining({
        discovery: expect.objectContaining({ received: 75, nextOffset: 75 }),
      }),
    )
  })

  it('sorts saved timestamps newest first instead of response, playback or release order', async () => {
    const dates = ['2020-01-01T00:00:00Z', '2024-06-01T12:30:00+10:00']
    mocks.request.mockResolvedValue(
      Response.json({
        ...page(0, 2, 2),
        items: dates.map((added_at) => ({
          added_at,
          played_at: '2026-01-01T00:00:00Z',
          album: { ...spotifyAlbumFixture(), release_date: '2025-01-01' },
        })),
      }),
    )
    await previewSpotifyAlbums(
      { limit: 2, offset: 0, confirmBroadRun: false },
      'user-1',
    )
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        records: [...dates].reverse().map((dateAdded) =>
          expect.objectContaining({
            result: expect.objectContaining({
              normalized: expect.objectContaining({
                albumPatch: expect.objectContaining({ dateAdded }),
              }),
            }),
          }),
        ),
      }),
      'user-1',
      expect.anything(),
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads the complete library before selecting newest additions across page boundaries', async () => {
    const first = page(0, 50, 52)
    first.items = first.items.map((item, index) => ({
      ...item,
      album: { ...item.album, id: String(index).padStart(22, '0') },
    }))
    const last = page(50, 2, 52)
    last.items = last.items.map((item, index) => ({
      ...item,
      added_at: index === 0 ? '2026-10-01T00:00:00Z' : '2026-10-27T00:00:00Z',
      album: { ...item.album, id: String(50 + index).padStart(22, '0') },
    }))
    mocks.request
      .mockResolvedValueOnce(Response.json(first))
      .mockResolvedValueOnce(Response.json(last))
    await previewSpotifyAlbums(
      { limit: 1, offset: 0, confirmBroadRun: true, scanAll: true },
      'user-1',
    )
    expect(mocks.request).toHaveBeenCalledTimes(2)
    expect(String(mocks.request.mock.calls[1]?.[0])).toBe(
      'https://api.spotify.com/v1/me/albums?limit=2&offset=50',
    )
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        warnings: [],
        records: [
          expect.objectContaining({
            result: expect.objectContaining({
              normalized: expect.objectContaining({
                albumPatch: expect.objectContaining({
                  dateAdded: '2026-10-27T00:00:00Z',
                }),
              }),
            }),
          }),
        ],
      }),
      'user-1',
      expect.objectContaining({
        discovery: expect.objectContaining({
          received: 1,
          scanned: 52,
          total: 52,
          complete: true,
          nextOffset: null,
          order: 'dateAddedDesc',
        }),
      }),
    )
  })

  it('requires separate confirmation for full-library scanning even when previewing one album', async () => {
    for (const input of [
      { limit: 1, offset: 0, confirmBroadRun: false, scanAll: true },
      { limit: 1, offset: 10, confirmBroadRun: true, scanAll: true },
    ])
      await expect(previewSpotifyAlbums(input, 'user-1')).rejects.toThrow()
    expect(mocks.token).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('does not stage duplicate, incomplete or oversized full-library scans', async () => {
    const cases = [
      page(0, 2, 2),
      { ...page(0, 1, 2), next: null },
      page(0, 1, 10001),
    ]
    for (const response of cases) {
      mocks.request.mockResolvedValueOnce(Response.json(response))
      await expect(
        previewSpotifyAlbums(
          { limit: 1, offset: 0, confirmBroadRun: true, scanAll: true },
          'user-1',
        ),
      ).rejects.toThrow()
    }
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('rejects changing library totals during a full scan', async () => {
    mocks.request
      .mockResolvedValueOnce(Response.json(page(0, 1, 2)))
      .mockResolvedValueOnce(Response.json(page(1, 1, 3)))
    await expect(
      previewSpotifyAlbums(
        { limit: 1, offset: 0, confirmBroadRun: true, scanAll: true },
        'user-1',
      ),
    ).rejects.toThrow('library changed')
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('rejects overlapping previews and releases the guard after completion', async () => {
    let release: ((response: Response) => void) | undefined
    mocks.request.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve
      }),
    )
    const input = { limit: 1, offset: 0, confirmBroadRun: false }
    const first = previewSpotifyAlbums(input, 'user-1')
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1))
    await expect(previewSpotifyAlbums(input, 'user-1')).rejects.toThrow(
      'already running',
    )
    if (!release) throw new Error('Missing test response resolver')
    release(Response.json(page(0, 1, 1)))
    await first
    mocks.request.mockResolvedValueOnce(Response.json(page(0, 1, 1)))
    await previewSpotifyAlbums(input, 'user-1')
    expect(mocks.request).toHaveBeenCalledTimes(2)
  })

  it('stops a full scan after its first error without retries or staging a partial newest list', async () => {
    mocks.request
      .mockResolvedValueOnce(Response.json(page(0, 1, 2)))
      .mockRejectedValueOnce(new ProviderRequestError('Cooldown', 'cooldown'))
    await expect(
      previewSpotifyAlbums(
        { limit: 1, offset: 0, confirmBroadRun: true, scanAll: true },
        'user-1',
      ),
    ).rejects.toThrow('Cooldown')
    expect(mocks.request).toHaveBeenCalledTimes(2)
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('validates broad confirmation before refreshing tokens or making requests', async () => {
    await expect(
      previewSpotifyAlbums(
        { limit: 51, offset: 0, confirmBroadRun: false },
        'user-1',
      ),
    ).rejects.toThrow()
    expect(mocks.token).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('stops on a cooldown and does not stage partial discovery', async () => {
    mocks.request
      .mockResolvedValueOnce(Response.json(page(0, 50, 300)))
      .mockRejectedValueOnce(
        new ProviderRequestError('Provider cooldown', 'cooldown'),
      )
    await expect(
      previewSpotifyAlbums(
        { limit: 100, offset: 0, confirmBroadRun: true },
        'user-1',
      ),
    ).rejects.toThrow('cooldown')
    expect(mocks.request).toHaveBeenCalledTimes(2)
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('rejects broken pagination instead of looping or following next links', async () => {
    mocks.request.mockResolvedValue(
      Response.json({ ...page(0, 0, 300), next: 'https://untrusted.invalid' }),
    )
    await expect(
      previewSpotifyAlbums(
        { limit: 20, offset: 0, confirmBroadRun: false },
        'user-1',
      ),
    ).rejects.toThrow('pagination')
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
})
