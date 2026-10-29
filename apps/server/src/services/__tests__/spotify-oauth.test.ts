import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ProviderRequestError } from '@repo/media-plugin-sdk'

const mocks = vi.hoisted(() => {
  function defaultEnvironment(): {
    APP_URL: string
    AUTH_BASE_URL: string | undefined
    INTERNAL_BACKEND_URL: string | undefined
    TRUSTED_ORIGINS: string[]
    MEDIA_ENCRYPTION_KEY: string
  } {
    return {
      APP_URL: 'http://127.0.0.1:3001',
      AUTH_BASE_URL: 'http://localhost:4001',
      INTERNAL_BACKEND_URL: undefined,
      TRUSTED_ORIGINS: [
        'http://127.0.0.1:3001',
        'http://localhost:3001',
        'http://localhost:4001',
      ],
      MEDIA_ENCRYPTION_KEY: 'test-encryption-key-long-enough-for-test',
    }
  }
  const env = defaultEnvironment()
  const database = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  }
  return {
    env,
    resetEnvironment: () => Object.assign(env, defaultEnvironment()),
    secrets: vi.fn(),
    database,
    transaction: vi.fn(async (fn: (tx: typeof database) => Promise<unknown>) =>
      fn(database),
    ),
    values: vi.fn(),
    set: vi.fn(),
    request: vi.fn(),
    success: vi.fn(),
    failure: vi.fn(),
  }
})
vi.mock('@/lib/db', () => ({
  db: { ...mocks.database, transaction: mocks.transaction },
}))
vi.mock('@/env', () => ({ env: mocks.env }))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: mocks.secrets,
}))
vi.mock('@/services/provider-requests', () => ({
  createProviderRequest: () => mocks.request,
  recordProviderFailure: mocks.failure,
  recordProviderSuccess: mocks.success,
}))

import { decryptSecretValue, encryptSecretValue } from '@/lib/crypto'
import {
  authorizeSpotify,
  disconnectSpotify,
  finishSpotifyAuthorization,
  getSpotifyAccountStatus,
  spotifyAccountToken,
  spotifyOperation,
  spotifyCallbackDestination,
} from '../spotify-oauth'
import { spotifyTokenFixture } from '@/plugins/builtin/__tests__/fixtures/spotify'

function query(rows: unknown[]) {
  const result = Object.assign(Promise.resolve(rows), {
    from: vi.fn(),
    where: vi.fn(),
    for: vi.fn(),
    values: mocks.values,
    set: mocks.set,
    onConflictDoUpdate: vi.fn(),
  })
  result.from.mockReturnValue(result)
  result.where.mockReturnValue(result)
  result.for.mockReturnValue(result)
  result.onConflictDoUpdate.mockReturnValue(result)
  return result
}
const secretSchema = z.object({
  encryptedValue: z.string(),
  provider: z.string(),
  key: z.string(),
  lastUpdatedByUserId: z.string(),
})
async function begin(browserOrigin = 'http://127.0.0.1:3001') {
  const response = await authorizeSpotify('user-1', 'session-1', browserOrigin)
  const state = new URL(response.url).searchParams.get('state')
  if (!state) throw new Error('Missing state')
  const saved = secretSchema.parse(mocks.values.mock.calls.at(-1)?.[0])
  return { state, saved: { ...saved, id: 'state-row' } }
}

describe('Spotify owner/session-bound OAuth (mock database and gate)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resetEnvironment()
    mocks.secrets.mockReturnValue({
      clientId: 'fixture-client',
      redirectUri: 'http://127.0.0.1:4001/api/v1/spotify/callback',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Live requests forbidden')
      }),
    )
    const empty = query([])
    mocks.database.select.mockReturnValue(empty)
    mocks.database.insert.mockReturnValue(empty)
    mocks.database.update.mockReturnValue(empty)
    mocks.database.delete.mockReturnValue(empty)
    mocks.values.mockReturnValue(empty)
    mocks.set.mockReturnValue(empty)
    mocks.request.mockResolvedValue(Response.json(spotifyTokenFixture))
  })
  afterEach(() => {
    mocks.resetEnvironment()
    vi.unstubAllGlobals()
  })

  it('refuses untrusted origins before storing state or calling Spotify', async () => {
    await expect(
      authorizeSpotify('user-1', 'session-1', 'https://evil.invalid'),
    ).rejects.toThrow('trusted app origin')
    expect(mocks.values).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('supports a signed-in localhost app with a loopback callback without contacting Spotify', async () => {
    const result = await authorizeSpotify(
      'user-1',
      'session-1',
      'http://localhost:3001',
    )
    const authorization = new URL(result.url)
    expect(authorization.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:4001/api/v1/spotify/callback',
    )
    const saved = secretSchema.parse(mocks.values.mock.calls.at(-1)?.[0])
    expect(JSON.parse(decryptSecretValue(saved.encryptedValue))).toMatchObject({
      returnOrigin: 'http://localhost:3001',
    })
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('relays only validated callback fields to the fixed auth origin', () => {
    const destination = new URL(
      spotifyCallbackDestination({
        state: 'a'.repeat(43),
        code: 'fixture-code',
      }),
    )
    expect(destination.origin).toBe('http://localhost:4001')
    expect(destination.pathname).toBe('/api/v1/spotify/complete')
    expect(destination.searchParams.get('code')).toBe('fixture-code')
    expect(() =>
      spotifyCallbackDestination({ state: 'bad', code: 'fixture' }),
    ).toThrow()
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'AUTH_BASE_URL before the backend and app URLs',
      authUrl: 'https://auth.example.test/api/auth?ignored=yes#ignored',
      backendUrl: 'https://backend.example.test',
      expectedOrigin: 'https://auth.example.test',
    },
    {
      name: 'INTERNAL_BACKEND_URL when AUTH_BASE_URL is absent',
      authUrl: undefined,
      backendUrl: 'https://backend.example.test/internal?ignored=yes#ignored',
      expectedOrigin: 'https://backend.example.test',
    },
    {
      name: 'APP_URL when both API URLs are absent',
      authUrl: undefined,
      backendUrl: undefined,
      expectedOrigin: 'https://web.example.test',
    },
  ])(
    'uses $name for the fixed completion destination',
    ({ authUrl, backendUrl, expectedOrigin }) => {
      mocks.env.APP_URL = 'https://web.example.test'
      mocks.env.AUTH_BASE_URL = authUrl
      mocks.env.INTERNAL_BACKEND_URL = backendUrl
      mocks.env.TRUSTED_ORIGINS = [expectedOrigin]
      const input = {
        state: 'a'.repeat(43),
        code: 'code+with&reserved=characters/#?',
        returnTo: 'https://evil.invalid',
        redirect_uri: 'https://evil.invalid',
      }
      const destination = new URL(spotifyCallbackDestination(input))
      expect(destination.origin).toBe(expectedOrigin)
      expect(destination.pathname).toBe('/api/v1/spotify/complete')
      expect(destination.hash).toBe('')
      expect([...destination.searchParams]).toEqual([
        ['state', input.state],
        ['code', input.code],
      ])
      expect(mocks.database.select).not.toHaveBeenCalled()
      expect(mocks.values).not.toHaveBeenCalled()
      expect(mocks.request).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each([
    {
      target: 'http://remote.example.test',
      trustedOrigin: 'http://remote.example.test',
    },
    {
      target: 'http://127.0.0.1.evil.invalid',
      trustedOrigin: 'http://127.0.0.1.evil.invalid',
    },
    {
      target: 'http://localhost.evil.invalid',
      trustedOrigin: 'http://localhost.evil.invalid',
    },
    { target: 'ftp://localhost:4001', trustedOrigin: 'ftp://localhost:4001' },
    {
      target: 'https://user:secret@api.example.test',
      trustedOrigin: 'https://api.example.test',
    },
    {
      target: 'https://untrusted.example.test',
      trustedOrigin: 'https://api.example.test',
    },
    { target: 'http://localhost:4999', trustedOrigin: 'http://localhost:4001' },
  ])(
    'rejects unsafe or untrusted relay target $target without falling back',
    async ({ target, trustedOrigin }) => {
      mocks.env.AUTH_BASE_URL = target
      mocks.env.INTERNAL_BACKEND_URL = 'http://localhost:4001'
      mocks.env.TRUSTED_ORIGINS.push(trustedOrigin)
      expect(() =>
        spotifyCallbackDestination({
          state: 'a'.repeat(43),
          code: 'fixture-code',
        }),
      ).toThrow('trusted browser-facing API/auth URL')
      await expect(
        authorizeSpotify('user-1', 'session-1', 'http://localhost:3001'),
      ).rejects.toThrow('trusted browser-facing API/auth URL')
      expect(mocks.values).not.toHaveBeenCalled()
      expect(mocks.request).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it('supports distinct trusted HTTPS web and API origins with a fixed API completion URL', async () => {
    mocks.env.APP_URL = 'https://web.example.test'
    mocks.env.AUTH_BASE_URL = 'https://api.example.test'
    mocks.env.TRUSTED_ORIGINS = [mocks.env.APP_URL, mocks.env.AUTH_BASE_URL]
    const redirectUri = 'https://api.example.test/api/v1/spotify/callback'
    mocks.secrets.mockReturnValue({ clientId: 'fixture-client', redirectUri })
    const result = await authorizeSpotify(
      'user-1',
      'session-1',
      mocks.env.APP_URL,
    )
    expect(new URL(result.url).searchParams.get('redirect_uri')).toBe(
      redirectUri,
    )
    const saved = secretSchema.parse(mocks.values.mock.calls.at(-1)?.[0])
    expect(JSON.parse(decryptSecretValue(saved.encryptedValue))).toMatchObject({
      returnOrigin: 'https://web.example.test',
      redirectUri,
    })
    const destination = new URL(
      spotifyCallbackDestination({
        state: 'a'.repeat(43),
        error: 'access_denied',
      }),
    )
    expect(destination.origin).toBe('https://api.example.test')
    expect(destination.pathname).toBe('/api/v1/spotify/complete')
    expect([...destination.searchParams]).toEqual([
      ['state', 'a'.repeat(43)],
      ['error', 'access_denied'],
    ])
    expect(mocks.request).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('accepts same-host different web/API ports and encrypts state/verifier', async () => {
    const started = await begin()
    expect(started.saved.provider).toMatch(/^spotify-account-/)
    expect(started.saved.lastUpdatedByUserId).toBe('user-1')
    expect(started.saved.encryptedValue).not.toContain(started.state)
    expect(decryptSecretValue(started.saved.encryptedValue)).not.toContain(
      started.state,
    )
    expect(
      JSON.parse(decryptSecretValue(started.saved.encryptedValue)),
    ).toMatchObject({ returnOrigin: 'http://127.0.0.1:3001' })
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('rejects a different session, wrong state, expiry and replay before token exchange', async () => {
    const started = await begin()
    const original = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(decryptSecretValue(started.saved.encryptedValue)))
    for (const input of [
      { state: started.state, session: 'another-session', changes: {} },
      { state: 'x'.repeat(43), session: 'session-1', changes: {} },
      { state: started.state, session: 'session-1', changes: { expiresAt: 1 } },
      {
        state: started.state,
        session: 'session-1',
        changes: { consumed: true },
      },
    ]) {
      mocks.database.select.mockReturnValueOnce(query([])).mockReturnValueOnce(
        query([
          {
            ...started.saved,
            encryptedValue: encryptSecretValue(
              JSON.stringify({ ...original, ...input.changes }),
            ),
          },
        ]),
      )
      await expect(
        finishSpotifyAuthorization(
          { state: input.state, code: 'fixture-code' },
          'user-1',
          input.session,
        ),
      ).rejects.toThrow('authorization')
    }
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it.each(['http://127.0.0.1:3001', 'http://localhost:3001'])(
    'consumes valid authorization, encrypts tokens, and returns to %s with the original exchange redirect',
    async (browserOrigin) => {
      const started = await begin(browserOrigin)
      mocks.database.select
        .mockReturnValueOnce(query([]))
        .mockReturnValueOnce(query([started.saved]))
        .mockImplementationOnce(() =>
          query([
            {
              id: 'state-row',
              encryptedValue: z
                .object({ encryptedValue: z.string() })
                .parse(mocks.set.mock.calls.at(-1)?.[0]).encryptedValue,
            },
          ]),
        )
      expect(
        await finishSpotifyAuthorization(
          { state: started.state, code: 'fixture-code' },
          'user-1',
          'session-1',
        ),
      ).toEqual({ connected: true, returnOrigin: browserOrigin })
      const tokens = secretSchema.parse(mocks.values.mock.calls.at(-1)?.[0])
      expect(tokens.key).toBe('tokens')
      expect(tokens.encryptedValue).not.toContain('fake-access-token')
      expect(
        JSON.parse(decryptSecretValue(tokens.encryptedValue)),
      ).toMatchObject({
        accessToken: 'fake-access-token',
        refreshToken: 'fake-refresh-token',
      })
      expect(mocks.request).toHaveBeenCalledTimes(1)
      const request = z
        .tuple([
          z.literal('https://accounts.spotify.com/api/token'),
          z.object({ method: z.literal('POST'), body: z.string() }),
        ])
        .parse(mocks.request.mock.calls[0])
      const body = new URLSearchParams(request[1].body)
      const saved = z
        .object({ verifier: z.string() })
        .parse(JSON.parse(decryptSecretValue(started.saved.encryptedValue)))
      expect([...body]).toEqual([
        ['grant_type', 'authorization_code'],
        ['code', 'fixture-code'],
        ['redirect_uri', 'http://127.0.0.1:4001/api/v1/spotify/callback'],
        ['client_id', 'fixture-client'],
        ['code_verifier', saved.verifier],
      ])
      expect(fetch).not.toHaveBeenCalled()
      expect(mocks.success).toHaveBeenCalledWith('spotify')
      expect(mocks.database.delete).toHaveBeenCalled()
    },
  )

  it('does not resurrect credentials when disconnected during token exchange', async () => {
    const started = await begin()
    mocks.database.select
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(query([started.saved]))
      .mockReturnValueOnce(query([]))
    await expect(
      finishSpotifyAuthorization(
        { state: started.state, code: 'fixture-code' },
        'user-1',
        'session-1',
      ),
    ).rejects.toThrow('disconnected')
    expect(mocks.values).toHaveBeenCalledTimes(1)
  })

  it('denial consumes state without token exchange or changing the connected account', async () => {
    const started = await begin()
    mocks.database.select
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(query([started.saved]))
    expect(
      await finishSpotifyAuthorization(
        { state: started.state, error: 'access_denied' },
        'user-1',
        'session-1',
      ),
    ).toMatchObject({ connected: false })
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.values).toHaveBeenCalledTimes(1)
  })

  it('refreshes through the gate and retains the old refresh token when omitted', async () => {
    const encryptedValue = encryptSecretValue(
      JSON.stringify({
        accessToken: 'expired',
        refreshToken: 'retained-refresh',
        expiresAt: 1,
        scope: 'user-library-read',
        clientId: 'fixture-client',
      }),
    )
    mocks.database.select
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(query([{ id: 'tokens', encryptedValue }]))
    mocks.request.mockResolvedValue(
      Response.json({
        access_token: 'renewed',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    )
    expect(await spotifyAccountToken('user-1', mocks.request)).toBe('renewed')
    const stored = secretSchema.parse(mocks.values.mock.calls.at(-1)?.[0])
    expect(JSON.parse(decryptSecretValue(stored.encryptedValue))).toMatchObject(
      { refreshToken: 'retained-refresh', accessToken: 'renewed' },
    )
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })

  it('status and disconnect remain local and expose no tokens', async () => {
    expect(await getSpotifyAccountStatus('user-1')).toMatchObject({
      configured: true,
      connected: false,
    })
    expect(await disconnectSpotify('user-1')).toEqual({ disconnected: true })
    expect(mocks.request).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('records and sanitizes failure without retries or clearing cooldowns', async () => {
    const error = new ProviderRequestError(
      'Provider rate limit reached',
      'rate-limit',
      null,
      true,
    )
    mocks.request.mockRejectedValue(error)
    await expect(
      spotifyOperation((request) =>
        request('https://api.spotify.com/v1/me/albums'),
      ),
    ).rejects.toThrow('Provider rate limit reached')
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.failure).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({ id: 'spotify' }),
      }),
      error,
    )
    expect(mocks.success).not.toHaveBeenCalled()
  })
})
