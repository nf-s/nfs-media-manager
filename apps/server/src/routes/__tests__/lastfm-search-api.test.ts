import { afterEach, describe, expect, it, vi } from 'vitest'

const queue = vi.fn()
const stored = vi.fn()
function mockSession(authenticated: boolean) {
  vi.doMock('@/env', () => ({
    env: { TRUSTED_ORIGINS: ['http://localhost:3000'], NODE_ENV: 'test' },
  }))
  vi.doMock('@/lib/db', () => ({ db: {} }))
  vi.doMock('@/lib/auth', () => ({
    auth: {
      api: {
        getSession: vi.fn().mockResolvedValue(
          authenticated
            ? {
                user: {
                  id: 'fixture-user',
                  email: 'fixture@example.com',
                  name: 'Fixture',
                },
                session: { id: 'fixture-session', userId: 'fixture-user' },
              }
            : null,
        ),
      },
      handler: vi.fn(),
    },
  }))
  vi.doMock('@/services/lastfm-spotify-search', () => ({
    queueLastfmSpotifySearches: queue,
    getLastfmSpotifySearch: stored,
  }))
  vi.doMock('@/services/lastfm-scrobbles', () => ({
    getLastfmLinkReport: vi.fn(),
    getLastfmSyncStatus: vi.fn(),
    relinkLastfmScrobbles: vi.fn(),
    setLastfmAlbumLink: vi.fn(),
    setLastfmSyncSchedule: vi.fn(),
  }))
  vi.doMock('@/services/lastfm-sync-jobs', () => ({ queueLastfmSync: vi.fn() }))
}
afterEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
})
const group = { artistName: 'Example Artist', albumName: 'Example Album' }
async function request(body: unknown, origin?: string) {
  const { default: app } = await import('../lastfm')
  return app.request('/links/spotify-search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe('Last.fm Spotify search endpoints', () => {
  it('requires authentication and rejects cross-origin queueing', async () => {
    mockSession(false)
    expect((await request({ groups: [group] })).status).toBe(401)
    expect(queue).not.toHaveBeenCalled()
    vi.resetModules()
    mockSession(true)
    expect(
      (await request({ groups: [group] }, 'https://untrusted.example')).status,
    ).toBe(403)
    expect(queue).not.toHaveBeenCalled()
  })
  it.each([
    {},
    { groups: [] },
    { groups: [{ ...group, albumName: null }] },
    { groups: [{ ...group, artistName: '' }] },
    { groups: [group], unexpected: true },
    { groups: Array.from({ length: 6 }, () => group) },
    { groups: Array.from({ length: 101 }, () => group), confirmBroadRun: true },
  ])(
    'rejects invalid/unconfirmed selections before service invocation: %j',
    async (body) => {
      mockSession(true)
      expect((await request(body)).status).toBe(422)
      expect(queue).not.toHaveBeenCalled()
    },
  )
  it('passes the explicit groups and authenticated actor to the queue', async () => {
    mockSession(true)
    queue.mockResolvedValue({
      batchId: 'fixture-batch',
      queued: 1,
      skipped: 0,
      warnings: [],
    })
    expect(
      (await request({ groups: [group], batchId: 'fixture-batch' })).status,
    ).toBe(200)
    expect(queue).toHaveBeenCalledWith(
      { groups: [group], batchId: 'fixture-batch', confirmBroadRun: false },
      'fixture-user',
    )
  })
  it('reads saved search data without queueing work', async () => {
    mockSession(true)
    stored.mockResolvedValue({
      job: null,
      query: 'Example Artist Example Album',
      result: null,
    })
    const { default: app } = await import('../lastfm')
    expect(
      (await app.request(`/links/spotify-search?${new URLSearchParams(group)}`))
        .status,
    ).toBe(200)
    expect(stored).toHaveBeenCalledWith(group)
    expect(queue).not.toHaveBeenCalled()
  })
})
