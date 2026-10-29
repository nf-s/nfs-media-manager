import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  status: vi.fn(),
  authorize: vi.fn(),
  destination: vi.fn(),
  callback: vi.fn(),
  disconnect: vi.fn(),
  preview: vi.fn(),
  csv: vi.fn(),
  commit: vi.fn(),
}))
vi.mock('@/env', () => ({
  env: {
    APP_URL: 'http://localhost:3001',
    AUTH_BASE_URL: 'http://localhost:4001',
    TRUSTED_ORIGINS: ['http://localhost:3001', 'http://localhost:4001'],
  },
}))
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.session } } }))
vi.mock('@/services/spotify-oauth', () => ({
  getSpotifyAccountStatus: mocks.status,
  authorizeSpotify: mocks.authorize,
  spotifyCallbackDestination: mocks.destination,
  finishSpotifyAuthorization: mocks.callback,
  disconnectSpotify: mocks.disconnect,
}))
vi.mock('@/services/spotify-imports', () => ({
  previewSpotifyAlbums: mocks.preview,
}))
vi.mock('@/services/album-imports', () => ({
  prepareAlbumCsv: mocks.csv,
  confirmAlbumImport: mocks.commit,
  albumImportFormats: [],
}))
import spotify from '../spotify'
import albumImports from '../album-imports'

function post(path: string, body: unknown, origin = 'http://localhost:3001') {
  return new Request(`http://localhost:4001${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin },
    body: JSON.stringify(body),
  })
}
describe('Spotify and album import API security', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Live requests forbidden')
      }),
    )
    mocks.session.mockResolvedValue({
      user: { id: 'user-1' },
      session: { id: 'session-1' },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('requires the admin session on completion and private OAuth/discovery/import endpoints', async () => {
    mocks.session.mockResolvedValue(null)
    for (const path of [
      '/status',
      `/complete?state=${'a'.repeat(43)}&code=code`,
    ])
      expect(
        (await spotify.request(`http://localhost:4001${path}`)).status,
      ).toBe(401)
    for (const path of ['/authorize', '/preview'])
      expect((await spotify.request(post(path, {}))).status).toBe(401)
    expect(
      (
        await spotify.request('http://localhost:4001/account', {
          method: 'DELETE',
        })
      ).status,
    ).toBe(401)
    expect(
      (await albumImports.request('http://localhost:4001/formats')).status,
    ).toBe(401)
    for (const path of ['/preview', '/commit'])
      expect((await albumImports.request(post(path, {}))).status).toBe(401)
    for (const fn of [
      mocks.status,
      mocks.authorize,
      mocks.destination,
      mocks.callback,
      mocks.disconnect,
      mocks.preview,
      mocks.csv,
      mocks.commit,
    ])
      expect(fn).not.toHaveBeenCalled()
  })

  it('rejects cross-site connection mutations before any service work', async () => {
    expect(
      (await spotify.request(post('/authorize', {}, 'https://evil.invalid')))
        .status,
    ).toBe(403)
    expect(mocks.authorize).not.toHaveBeenCalled()
  })

  it('binds authorization to authenticated user/session and browser origin', async () => {
    mocks.authorize.mockResolvedValue({
      url: 'https://accounts.spotify.com/authorize',
      expiresAt: new Date().toISOString(),
    })
    const response = await spotify.request(post('/authorize', {}))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(mocks.authorize).toHaveBeenCalledWith(
      'user-1',
      'session-1',
      'http://localhost:3001',
    )
  })

  it('relays an unauthenticated callback to the service destination with only validated fields', async () => {
    mocks.session.mockResolvedValue(null)
    const state = 'a'.repeat(43)
    const destination = `http://localhost:4001/api/v1/spotify/complete?state=${state}&code=secret-code`
    mocks.destination.mockReturnValue(destination)
    const response = await spotify.request(
      `http://127.0.0.1:4001/callback?state=${state}&code=secret-code&returnTo=https://evil.invalid&redirect_uri=https://evil.invalid&error_description=private-detail`,
      {
        headers: {
          host: 'evil.invalid',
          'x-forwarded-host': 'evil.invalid',
          'x-forwarded-proto': 'https',
          origin: 'https://evil.invalid',
          'sec-fetch-site': 'cross-site',
        },
      },
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(destination)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(mocks.destination).toHaveBeenCalledExactlyOnceWith({
      state,
      code: 'secret-code',
    })
    expect(mocks.callback).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('relays denial without consuming state or invoking authenticated completion', async () => {
    const state = 'a'.repeat(43)
    const destination = `http://localhost:4001/api/v1/spotify/complete?state=${state}&error=access_denied`
    mocks.destination.mockReturnValue(destination)
    const response = await spotify.request(
      `http://127.0.0.1:4001/callback?state=${state}&error=access_denied`,
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(destination)
    expect(mocks.destination).toHaveBeenCalledExactlyOnceWith({
      state,
      error: 'access_denied',
    })
    expect(mocks.callback).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects malformed callback and completion queries before service work', async () => {
    const state = 'a'.repeat(43)
    for (const path of ['/callback', '/complete']) {
      for (const query of [
        'code=code',
        'state=invalid&code=code',
        `state=${state}`,
        `state=${state}&code=`,
        `state=${state}&code=code&error=access_denied`,
        `state=${state}&code=${'x'.repeat(4097)}`,
        `state=${state}&error=${'x'.repeat(257)}`,
      ]) {
        const response = await spotify.request(
          `http://localhost:4001${path}?${query}`,
        )
        expect(response.status).toBe(422)
        expect(response.headers.get('location')).toBeNull()
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      }
    }
    expect(mocks.destination).not.toHaveBeenCalled()
    expect(mocks.callback).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects broad discovery, server file paths and arbitrary commit payloads', async () => {
    expect(
      (await spotify.request(post('/preview', { limit: 100 }))).status,
    ).toBe(422)
    expect(
      (
        await albumImports.request(
          post('/preview', {
            format: 'album-csv',
            fileName: 'file.csv',
            content: 'title,artist\nAlbum,Artist',
            path: '/private',
          }),
        )
      ).status,
    ).toBe(422)
    expect(
      (
        await albumImports.request(
          post('/commit', { previewId: 'p', rows: [] }),
        )
      ).status,
    ).toBe(422)
    expect(mocks.preview).not.toHaveBeenCalled()
    expect(mocks.csv).not.toHaveBeenCalled()
    expect(mocks.commit).not.toHaveBeenCalled()
  })

  it('completes with the original actor and redirects to the fixed import path without OAuth secrets', async () => {
    mocks.callback.mockResolvedValue({
      connected: true,
      returnOrigin: 'http://localhost:3001',
    })
    const response = await spotify.request(
      `http://localhost:4001/complete?state=${'a'.repeat(43)}&code=secret-code&returnTo=https://evil.invalid`,
      { headers: { 'sec-fetch-site': 'cross-site' } },
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      'http://localhost:3001/imports/spotify?mediaType=album&spotify=connected',
    )
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('location')).not.toContain('secret-code')
    expect(response.headers.get('location')).not.toContain('state=')
    expect(mocks.callback).toHaveBeenCalledExactlyOnceWith(
      { state: 'a'.repeat(43), code: 'secret-code' },
      'user-1',
      'session-1',
    )
    expect(mocks.destination).not.toHaveBeenCalled()
  })

  it('completes denial with the authenticated actor and returns only a sanitized outcome', async () => {
    mocks.callback.mockResolvedValue({
      connected: false,
      returnOrigin: 'http://localhost:3001',
    })
    const state = 'a'.repeat(43)
    const response = await spotify.request(
      `http://localhost:4001/complete?state=${state}&error=access_denied`,
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      'http://localhost:3001/imports/spotify?mediaType=album&spotify=error',
    )
    expect(mocks.callback).toHaveBeenCalledExactlyOnceWith(
      { state, error: 'access_denied' },
      'user-1',
      'session-1',
    )
    expect(mocks.destination).not.toHaveBeenCalled()
  })

  it('does not leak token/provider errors in responses or failure redirects', async () => {
    mocks.callback.mockRejectedValue(new Error('fake-sensitive-token'))
    const response = await spotify.request(
      `http://localhost:4001/complete?state=${'a'.repeat(43)}&code=code`,
    )
    expect(response.headers.get('location')).toBe(
      'http://localhost:3001/imports/spotify?mediaType=album&spotify=error',
    )
    mocks.status.mockRejectedValue(new Error('fake-sensitive-token'))
    expect(
      await (await spotify.request('http://localhost:4001/status')).text(),
    ).not.toContain('fake-sensitive-token')
    expect(fetch).not.toHaveBeenCalled()
  })
})
