import { afterEach, describe, expect, it, vi } from 'vitest'

const scrobble = vi.fn()
const finish = vi.fn()
const authorize = vi.fn()
const disconnect = vi.fn()
const status = vi.fn()
function mockSession(authenticated: boolean) {
  vi.doMock('@/env', () => ({
    env: {
      APP_URL: 'http://localhost:3000',
      TRUSTED_ORIGINS: ['http://localhost:3000'],
      NODE_ENV: 'test',
    },
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
  vi.doMock('@/services/lastfm-scrobbling', () => ({
    authorizeLastfmScrobbling: authorize,
    disconnectLastfmScrobbling: disconnect,
    finishLastfmScrobbling: finish,
    getLastfmScrobblingStatus: status,
    scrobbleLastfmPlays: scrobble,
  }))
  vi.doMock('@/services/lastfm-spotify-search', () => ({
    queueLastfmSpotifySearches: vi.fn(),
    getLastfmSpotifySearch: vi.fn(),
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

const STATE = 'a'.repeat(43)
const TOKEN = 'fixturetoken0123456789abcdef01'
const play = {
  trackUri: 'spotify:track:ABCDEFGHIJKLMNOPQRSTUV',
  track: 'Fixture Track',
  artist: 'Fixture Artist',
  album: '',
  durationMs: 200000,
  startedAt: 1763460000000,
}
async function report(body: unknown, origin?: string) {
  const { default: app } = await import('../lastfm')
  return app.request('/scrobbles', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe('Last.fm scrobbling endpoints', () => {
  it('requires a browser session and a same-origin request to report plays', async () => {
    mockSession(false)
    expect((await report({ plays: [play] })).status).toBe(401)
    vi.resetModules()
    mockSession(true)
    expect(
      (await report({ plays: [play] }, 'https://untrusted.example')).status,
    ).toBe(403)
    expect(scrobble).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { plays: [] },
    { plays: Array.from({ length: 51 }, () => play) },
    { plays: [{ ...play, trackUri: 'spotify:album:ABCDEFGHIJKLMNOPQRSTUV' }] },
    { plays: [{ ...play, artist: ' ' }] },
    { plays: [{ ...play, startedAt: -1 }] },
    { plays: [{ ...play, unexpected: true }] },
  ])('rejects invalid reports before the service: %j', async (body) => {
    mockSession(true)
    expect((await report(body)).status).toBe(422)
    expect(scrobble).not.toHaveBeenCalled()
  })

  it('passes the plays and the signed-in user to the service, uncached', async () => {
    mockSession(true)
    scrobble.mockResolvedValue({
      connected: true,
      accepted: 1,
      scrobbled: 1,
      waiting: 0,
    })
    const response = await report({ plays: [play] }, 'http://localhost:3000')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(scrobble).toHaveBeenCalledWith('fixture-user', { plays: [play] })
  })

  it('starts sign-in with the session and request origin', async () => {
    mockSession(true)
    authorize.mockResolvedValue({
      url: 'https://www.last.fm/api/auth/?api_key=k',
      expiresAt: new Date().toISOString(),
    })
    const { default: app } = await import('../lastfm')
    const response = await app.request('/scrobbling/authorize', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
      },
      body: '{}',
    })
    expect(response.status).toBe(200)
    expect(authorize).toHaveBeenCalledWith(
      'fixture-user',
      'fixture-session',
      'http://localhost:3000',
    )
  })

  it('returns to the app after sign-in without the token in the redirect', async () => {
    mockSession(true)
    finish.mockResolvedValue({
      connected: true,
      returnOrigin: 'http://localhost:3000',
    })
    const { default: app } = await import('../lastfm')
    const response = await app.request(
      `/scrobbling/callback/${STATE}?token=${TOKEN}`,
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/albums?player=lastfm-connected',
    )
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(finish).toHaveBeenCalledWith(
      STATE,
      { token: TOKEN },
      'fixture-user',
      'fixture-session',
    )
  })

  it('reports a failed sign-in without detail', async () => {
    mockSession(true)
    finish.mockRejectedValue(new Error(`Last.fm said no to ${TOKEN}`))
    const { default: app } = await import('../lastfm')
    const response = await app.request(
      `/scrobbling/callback/${STATE}?token=${TOKEN}`,
    )
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/albums?player=lastfm-error',
    )
  })

  it('accepts the callback with a trailing slash under the API app', async () => {
    mockSession(true)
    finish.mockResolvedValue({
      connected: true,
      returnOrigin: 'http://localhost:3000',
    })
    const { default: lastfm } = await import('../lastfm')
    const { createOpenAPIApp } = await import('@/lib/openapi')
    const api = createOpenAPIApp({ strict: false }).route('/lastfm', lastfm)
    const response = await api.request(
      `/lastfm/scrobbling/callback/${STATE}/?token=${TOKEN}`,
    )
    expect(response.status).toBe(302)
    expect(finish).toHaveBeenCalledWith(
      STATE,
      { token: TOKEN },
      'fixture-user',
      'fixture-session',
    )
  })

  it('rejects a malformed state before the service', async () => {
    mockSession(true)
    const { default: app } = await import('../lastfm')
    expect((await app.request('/scrobbling/callback/short')).status).toBe(422)
    expect(finish).not.toHaveBeenCalled()
  })

  it('disconnects only from the same origin', async () => {
    mockSession(true)
    disconnect.mockResolvedValue({ disconnected: true })
    const { default: app } = await import('../lastfm')
    expect(
      (
        await app.request('/scrobbling/account', {
          method: 'DELETE',
          headers: { 'sec-fetch-site': 'cross-site' },
        })
      ).status,
    ).toBe(403)
    expect(
      (await app.request('/scrobbling/account', { method: 'DELETE' })).status,
    ).toBe(200)
    expect(disconnect).toHaveBeenCalledOnce()
    expect(disconnect).toHaveBeenCalledWith('fixture-user')
  })

  it('reads the local status for any signed-in owner', async () => {
    mockSession(true)
    status.mockResolvedValue({
      configured: true,
      connected: false,
      account: null,
    })
    const { default: app } = await import('../lastfm')
    const response = await app.request('/scrobbling')
    expect(response.status).toBe(200)
    expect(status).toHaveBeenCalledWith('fixture-user')
  })
})
