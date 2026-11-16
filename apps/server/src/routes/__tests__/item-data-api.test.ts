import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  albumSeries: vi.fn(),
  trackSeries: vi.fn(),
  artistSeries: vi.fn(),
  playlistSeries: vi.fn(),
  provenance: vi.fn(),
  playlistCoverage: vi.fn(),
  artistCoverage: vi.fn(),
  playlistCoverageEntries: vi.fn(),
}))
vi.mock('@/env', () => ({
  env: {
    TRUSTED_ORIGINS: ['http://localhost:3000'],
    NODE_ENV: 'test',
    OWNER_EMAIL: 'owner@example.com',
  },
}))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: mocks.session }, handler: vi.fn() },
}))
vi.mock('@/services/listening-series', () => ({
  getAlbumListeningSeries: mocks.albumSeries,
  getTrackListeningSeries: mocks.trackSeries,
  getArtistListeningSeries: mocks.artistSeries,
  getPlaylistListeningSeries: mocks.playlistSeries,
}))
vi.mock('@/services/media-provenance', () => ({
  getMediaProvenance: mocks.provenance,
}))
vi.mock('@/services/metadata-coverage', () => ({
  getPlaylistCoverage: mocks.playlistCoverage,
  getArtistCoverage: mocks.artistCoverage,
  getPlaylistCoverageEntries: mocks.playlistCoverageEntries,
}))

const series = {
  total: 1,
  firstDate: '2026-11-01',
  lastDate: '2026-11-01',
  daysFrom: '2021-11-16',
  daysTo: '2026-11-16',
  days: [{ date: '2026-11-01', count: 1 }],
  months: [{ month: '2026-11', count: 1 }],
}
const coverage = { total: 0, olderThanDays: 180, providers: [] }
const coverageEntries = {
  page: 1,
  size: 100,
  totalCount: 0,
  pageCount: 0,
  items: [],
  name: 'Fixture playlist',
  gap: 'missing',
  provider: null,
  olderThanDays: 180,
  albumCount: 0,
}
const provenance = { mediaItemId: 'album-1', mediaType: 'album', fields: [] }

const endpoints = [
  '/api/v1/albums/album-1/listening/series',
  '/api/v1/tracks/track-1/listening/series',
  '/api/v1/artists/artist-1/listening/series',
  '/api/v1/playlists/playlist-1/listening/series',
  '/api/v1/media/album-1/provenance',
  '/api/v1/playlists/playlist-1/coverage',
  '/api/v1/artists/artist-1/coverage',
  '/api/v1/playlists/playlist-1/coverage/entries',
]

async function get(path: string) {
  const { default: app } = await import('@/app')
  return app.request(`http://localhost${path}`)
}

function owner(email = 'owner@example.com') {
  mocks.session.mockResolvedValue({
    user: { id: 'user-1', email, name: 'Owner', role: 'admin' },
    session: { id: 'session-1', userId: 'user-1' },
  })
}

describe('item data api', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Live requests forbidden')
      }),
    )
    mocks.albumSeries.mockResolvedValue(series)
    mocks.trackSeries.mockResolvedValue(series)
    mocks.artistSeries.mockResolvedValue(series)
    mocks.playlistSeries.mockResolvedValue(series)
    mocks.provenance.mockResolvedValue(provenance)
    mocks.playlistCoverage.mockResolvedValue(coverage)
    mocks.artistCoverage.mockResolvedValue(coverage)
    mocks.playlistCoverageEntries.mockResolvedValue(coverageEntries)
  })
  afterEach(() => {
    vi.resetAllMocks()
    vi.unstubAllGlobals()
  })

  it('requires a session for every endpoint', async () => {
    mocks.session.mockResolvedValue(null)
    for (const path of endpoints) {
      const response = await get(path)
      expect(response.status, path).toBe(401)
    }
    for (const mock of Object.values(mocks).filter(
      (mock) => mock !== mocks.session,
    ))
      expect(mock).not.toHaveBeenCalled()
  })

  it('refuses a session that is not the owner', async () => {
    owner('someone@example.com')
    for (const path of endpoints) {
      const response = await get(path)
      expect(response.status, path).toBe(403)
    }
    expect(mocks.provenance).not.toHaveBeenCalled()
  })

  it('returns each item series from its service', async () => {
    owner()
    for (const path of endpoints.slice(0, 4)) {
      const response = await get(path)
      expect(response.status, path).toBe(200)
      expect((await response.json()).data).toEqual(series)
    }
    expect(mocks.albumSeries).toHaveBeenCalledWith('album-1')
    expect(mocks.trackSeries).toHaveBeenCalledWith('track-1')
    expect(mocks.artistSeries).toHaveBeenCalledWith('artist-1')
    expect(mocks.playlistSeries).toHaveBeenCalledWith('playlist-1')
  })

  it('returns field provenance for a media item', async () => {
    owner()
    const response = await get('/api/v1/media/album-1/provenance')
    expect(response.status).toBe(200)
    expect((await response.json()).data).toEqual(provenance)
    expect(mocks.provenance).toHaveBeenCalledWith('album-1')
  })

  it('validates and forwards the coverage freshness period', async () => {
    owner()
    expect((await get('/api/v1/playlists/playlist-1/coverage')).status).toBe(
      200,
    )
    expect(mocks.playlistCoverage).toHaveBeenCalledWith('playlist-1', {
      olderThanDays: 180,
    })
    expect(
      (await get('/api/v1/artists/artist-1/coverage?olderThanDays=30')).status,
    ).toBe(200)
    expect(mocks.artistCoverage).toHaveBeenCalledWith('artist-1', {
      olderThanDays: 30,
    })
    for (const value of ['0', '3651', 'soon']) {
      const response = await get(
        `/api/v1/artists/artist-1/coverage?olderThanDays=${value}`,
      )
      expect(response.status, value).toBe(422)
    }
    expect(mocks.artistCoverage).toHaveBeenCalledTimes(1)
  })

  it('validates and forwards the gap filter of the coverage entries', async () => {
    owner()
    const response = await get('/api/v1/playlists/playlist-1/coverage/entries')
    expect(response.status).toBe(200)
    expect((await response.json()).data).toEqual(coverageEntries)
    expect(mocks.playlistCoverageEntries).toHaveBeenLastCalledWith(
      'playlist-1',
      expect.objectContaining({
        gap: 'missing',
        olderThanDays: 180,
        page: 1,
        size: 100,
        sortBy: 'position',
        direction: 'asc',
      }),
    )
    expect(
      (
        await get(
          '/api/v1/playlists/playlist-1/coverage/entries?gap=stale&provider=fixture-a&olderThanDays=30&q=song&page=2&size=50',
        )
      ).status,
    ).toBe(200)
    expect(mocks.playlistCoverageEntries).toHaveBeenLastCalledWith(
      'playlist-1',
      expect.objectContaining({
        gap: 'stale',
        provider: 'fixture-a',
        olderThanDays: 30,
        q: 'song',
        page: 2,
        size: 50,
      }),
    )
    for (const query of ['gap=old', 'provider=', 'olderThanDays=0', 'size=101'])
      expect(
        (await get(`/api/v1/playlists/playlist-1/coverage/entries?${query}`))
          .status,
        query,
      ).toBe(422)
    expect(mocks.playlistCoverageEntries).toHaveBeenCalledTimes(2)
  })
})
