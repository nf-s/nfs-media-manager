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
      APP_URL: 'https://web.example.test',
      AUTH_BASE_URL: 'https://api.example.test',
      INTERNAL_BACKEND_URL: undefined,
      TRUSTED_ORIGINS: ['https://web.example.test', 'https://api.example.test'],
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
    clearHalt: vi.fn(),
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
  clearProviderAccessHalt: mocks.clearHalt,
  createProviderRequest: () => mocks.request,
  recordProviderFailure: mocks.failure,
  recordProviderSuccess: mocks.success,
}))

import { decryptSecretValue, encryptSecretValue } from '@/lib/crypto'
import {
  authorizeSonos,
  disconnectSonos,
  finishSonosAuthorization,
  getSonosAccountStatus,
  getSonosRooms,
  loadSonosContent,
  sendSonosCommand,
  sonosCallbackDestination,
} from '../sonos-oauth'

const REDIRECT = 'https://api.example.test/api/v1/sonos/callback'
const tokenFixture = {
  access_token: 'fake-access-token',
  token_type: 'Bearer',
  expires_in: 86400,
  refresh_token: 'fake-refresh-token',
  scope: 'playback-control-all',
}

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
const savedSchema = z.record(z.string(), z.unknown())

async function begin() {
  const response = await authorizeSonos(
    'user-1',
    'session-1',
    'https://web.example.test',
  )
  const state = new URL(response.url).searchParams.get('state')
  if (!state) throw new Error('Missing state')
  const saved = secretSchema.parse(mocks.values.mock.calls.at(-1)?.[0])
  return {
    url: new URL(response.url),
    state,
    saved: { ...saved, id: 'state-row' },
  }
}

function mockCompletion(
  saved: { id: string; encryptedValue: string },
  stored = true,
) {
  mocks.database.select
    .mockReturnValueOnce(query([]))
    .mockReturnValueOnce(query([saved]))
  // The pending state is only rechecked when the token response is accepted.
  if (stored)
    mocks.database.select.mockImplementationOnce(() =>
      query([
        {
          id: 'state-row',
          encryptedValue: z
            .object({ encryptedValue: z.string() })
            .parse(mocks.set.mock.calls.at(-1)?.[0]).encryptedValue,
        },
      ]),
    )
}

function storedTokens(values: Record<string, unknown> = {}) {
  return query([
    {
      id: 'tokens',
      encryptedValue: encryptSecretValue(
        JSON.stringify({
          accessToken: 'fake-access-token',
          refreshToken: 'fake-refresh-token',
          expiresAt: Date.now() + 3600000,
          scope: 'playback-control-all',
          clientId: 'fixture-key',
          ...values,
        }),
      ),
    },
  ])
}

function storedSpotify(accounts: Record<string, unknown>) {
  return query([
    {
      id: 'spotify',
      encryptedValue: encryptSecretValue(JSON.stringify(accounts)),
    },
  ])
}

const API = 'https://api.ws.sonos.com/control/api/v1'
/** One household whose only room last played a Spotify track. */
function respondWithSpotifyRoom(accountId: string) {
  const responses: Record<string, unknown> = {
    [`${API}/households`]: { households: [{ id: 'home' }] },
    [`${API}/households/home/groups`]: {
      groups: [
        {
          id: 'A',
          name: 'Lounge',
          coordinatorId: 'A',
          playerIds: ['A'],
        },
      ],
    },
    [`${API}/groups/A/playback`]: {},
    [`${API}/groups/A/playbackMetadata`]: {
      currentItem: {
        track: {
          id: {
            serviceId: '12',
            objectId: 'spotify:track:ABCDEFGHIJKLMNOPQRSTUV',
            accountId,
          },
        },
      },
    },
  }
  mocks.request.mockImplementation(async (url: string) => {
    const body = responses[url]
    if (body === undefined) throw new Error(`Unexpected request ${url}`)
    return Response.json(body)
  })
}

describe('Sonos owner/session-bound OAuth (mock database and gate)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resetEnvironment()
    mocks.secrets.mockReturnValue({
      clientId: 'fixture-key',
      clientSecret: 'fixture-secret',
      redirectUri: REDIRECT,
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
    mocks.request.mockResolvedValue(Response.json(tokenFixture))
  })
  afterEach(() => {
    mocks.resetEnvironment()
    vi.unstubAllGlobals()
  })

  it('reports an unconfigured integration when the redirect URI is not HTTPS', async () => {
    mocks.secrets.mockReturnValue({
      clientId: 'fixture-key',
      clientSecret: 'fixture-secret',
      redirectUri: 'http://127.0.0.1:4001/api/v1/sonos/callback',
    })
    expect(await getSonosAccountStatus('user-1')).toEqual({
      configured: false,
      connected: false,
      redirectUri: null,
    })
    await expect(
      authorizeSonos('user-1', 'session-1', 'https://web.example.test'),
    ).rejects.toThrow('Configure the Sonos integration')
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('refuses untrusted origins before storing state', async () => {
    await expect(
      authorizeSonos('user-1', 'session-1', 'https://evil.invalid'),
    ).rejects.toThrow('trusted app origin')
    expect(mocks.values).not.toHaveBeenCalled()
  })

  it('sends the owner to the Sonos login with a hashed, session-bound state', async () => {
    const { url, state, saved } = await begin()
    expect(url.origin + url.pathname).toBe(
      'https://api.sonos.com/login/v3/oauth',
    )
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'fixture-key',
      response_type: 'code',
      scope: 'playback-control-all',
      redirect_uri: REDIRECT,
    })
    const stored = savedSchema.parse(
      JSON.parse(decryptSecretValue(saved.encryptedValue)),
    )
    expect(stored['stateHash']).not.toBe(state)
    expect(stored['returnOrigin']).toBe('https://web.example.test')
    expect(JSON.stringify(stored)).not.toContain('fixture-secret')
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('relays only validated callback fields to the fixed completion URL', () => {
    const destination = new URL(
      sonosCallbackDestination({ state: 'a'.repeat(43), code: 'fixture-code' }),
    )
    expect(destination.origin).toBe('https://api.example.test')
    expect(destination.pathname).toBe('/api/v1/sonos/complete')
    expect([...destination.searchParams]).toEqual([
      ['state', 'a'.repeat(43)],
      ['code', 'fixture-code'],
    ])
    expect(() =>
      sonosCallbackDestination({ state: 'bad', code: 'fixture' }),
    ).toThrow()
  })

  it('exchanges the code with the integration credentials and stores the tokens', async () => {
    const { state, saved } = await begin()
    mockCompletion(saved)
    const result = await finishSonosAuthorization(
      { state, code: 'fixture-code' },
      'user-1',
      'session-1',
    )
    expect(result).toEqual({
      connected: true,
      returnOrigin: 'https://web.example.test',
    })
    const [url, init] = mocks.request.mock.calls[0] ?? []
    expect(url).toBe('https://api.sonos.com/login/v3/oauth/access')
    const request = z
      .object({ headers: z.record(z.string(), z.string()), body: z.string() })
      .parse(init)
    expect(request.headers['Authorization']).toBe(
      `Basic ${Buffer.from('fixture-key:fixture-secret').toString('base64')}`,
    )
    expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'fixture-code',
      redirect_uri: REDIRECT,
    })
    const tokens = secretSchema.parse(mocks.values.mock.calls.at(-1)?.[0])
    expect(tokens.key).toBe('tokens')
    expect(
      savedSchema.parse(JSON.parse(decryptSecretValue(tokens.encryptedValue))),
    ).toMatchObject({
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      scope: 'playback-control-all',
      clientId: 'fixture-key',
    })
    expect(mocks.clearHalt).toHaveBeenCalledWith('sonos')
  })

  it('rejects a state from another session without contacting Sonos', async () => {
    const { state, saved } = await begin()
    mockCompletion(saved, false)
    await expect(
      finishSonosAuthorization(
        { state, code: 'fixture-code' },
        'user-1',
        'session-2',
      ),
    ).rejects.toThrow('does not match this session')
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('drops the pending state when the owner declines', async () => {
    const { state, saved } = await begin()
    mockCompletion(saved, false)
    const result = await finishSonosAuthorization(
      { state, error: 'access_denied' },
      'user-1',
      'session-1',
    )
    expect(result.connected).toBe(false)
    expect(mocks.database.delete).toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('lists rooms with a current token and asks for a new sign-in when Sonos rejects it', async () => {
    mocks.database.select
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(storedTokens())
    mocks.request.mockResolvedValueOnce(Response.json({ households: [] }))
    expect(await getSonosRooms('user-1')).toEqual({ households: [] })
    expect(mocks.request.mock.calls[0]?.[0]).toBe(
      'https://api.ws.sonos.com/control/api/v1/households',
    )

    mocks.database.select
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(storedTokens())
    mocks.request.mockRejectedValueOnce(
      new ProviderRequestError(
        'Provider request failed (HTTP 401)',
        'access-denied',
        null,
        true,
      ),
    )
    await expect(getSonosRooms('user-1')).rejects.toThrow(
      'Sonos rejected the saved sign-in',
    )
  })

  it('refreshes an expiring token before listing rooms', async () => {
    mocks.database.select
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(storedTokens({ expiresAt: Date.now() + 1000 }))
    mocks.request
      .mockResolvedValueOnce(
        Response.json({ ...tokenFixture, access_token: 'fake-new-token' }),
      )
      .mockResolvedValueOnce(Response.json({ households: [] }))
    await getSonosRooms('user-1')
    const body = z
      .object({ body: z.string() })
      .parse(mocks.request.mock.calls[0]?.[1]).body
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'fake-refresh-token',
    })
    const rooms = z
      .object({ headers: z.record(z.string(), z.string()) })
      .parse(mocks.request.mock.calls[1]?.[1])
    expect(rooms.headers['Authorization']).toBe('Bearer fake-new-token')
  })

  it('reports a command Sonos refuses without asking for a new sign-in', async () => {
    mocks.database.select
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(storedTokens())
    mocks.request.mockRejectedValueOnce(
      new ProviderRequestError(
        'Provider request failed (HTTP 400)',
        'request-failed',
        null,
        true,
      ),
    )
    await expect(
      sendSonosCommand('user-1', 'RINCON_A:1', { action: 'next' }),
    ).rejects.toThrow('Sonos did not accept that.')

    mocks.database.select
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(storedTokens())
    mocks.request.mockResolvedValueOnce(Response.json({}))
    expect(
      await sendSonosCommand('user-1', 'RINCON_A:1', { action: 'pause' }),
    ).toEqual({ done: true })
    expect(mocks.request.mock.calls.at(-1)?.[0]).toBe(
      'https://api.ws.sonos.com/control/api/v1/groups/RINCON_A%3A1/playback/pause',
    )
  })

  it('remembers a household Spotify account only when it is new or changed', async () => {
    respondWithSpotifyRoom('sn_1')
    mocks.database.select
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(storedTokens())
    const rooms = await getSonosRooms('user-1')
    expect(rooms.households[0]?.rooms[0]?.playable).toBe(true)
    expect(mocks.values).toHaveBeenCalledTimes(1)
    const saved = secretSchema.parse(mocks.values.mock.calls[0]?.[0])
    expect(saved.key).toBe('spotify')
    expect(JSON.parse(decryptSecretValue(saved.encryptedValue))).toEqual({
      home: { serviceId: '12', accountId: 'sn_1' },
    })

    mocks.database.select
      .mockReturnValueOnce(
        storedSpotify({ home: { serviceId: '12', accountId: 'sn_1' } }),
      )
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(storedTokens())
    await getSonosRooms('user-1')
    expect(mocks.values).toHaveBeenCalledTimes(1)

    respondWithSpotifyRoom('sn_2')
    mocks.database.select
      .mockReturnValueOnce(
        storedSpotify({
          home: { serviceId: '12', accountId: 'sn_1' },
          other: { serviceId: '12', accountId: 'sn_9' },
        }),
      )
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(storedTokens())
    await getSonosRooms('user-1')
    expect(mocks.values).toHaveBeenCalledTimes(2)
    const changed = secretSchema.parse(mocks.values.mock.calls[1]?.[0])
    expect(JSON.parse(decryptSecretValue(changed.encryptedValue))).toEqual({
      home: { serviceId: '12', accountId: 'sn_2' },
      other: { serviceId: '12', accountId: 'sn_9' },
    })
  })

  it('loads Spotify content with the household Spotify account', async () => {
    mocks.database.select
      .mockReturnValueOnce(
        storedSpotify({ home: { serviceId: '12', accountId: 'sn_1' } }),
      )
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(storedTokens())
    mocks.request.mockResolvedValueOnce(Response.json({}))
    expect(
      await loadSonosContent('user-1', 'RINCON_A:1', {
        household: 'home',
        mode: 'append',
        uris: ['spotify:track:ABCDEFGHIJKLMNOPQRSTUV'],
        play: false,
      }),
    ).toEqual({ done: true })
    const [url, init] = mocks.request.mock.calls[0] ?? []
    expect(url).toBe(`${API}/groups/RINCON_A%3A1/playback/content`)
    expect(JSON.parse(z.object({ body: z.string() }).parse(init).body)).toEqual(
      {
        type: 'TRACK',
        id: {
          serviceId: '12',
          objectId: 'spotify:track:ABCDEFGHIJKLMNOPQRSTUV',
          accountId: 'sn_1',
        },
        queueAction: 'APPEND',
      },
    )
  })

  it('refuses to load content before the household Spotify account is known', async () => {
    mocks.database.select.mockReturnValueOnce(
      storedSpotify({ other: { serviceId: '12', accountId: 'sn_1' } }),
    )
    await expect(
      loadSonosContent('user-1', 'RINCON_A:1', {
        household: 'home',
        mode: 'replace',
        uris: ['spotify:album:ABCDEFGHIJKLMNOPQRSTUV'],
        play: true,
      }),
    ).rejects.toMatchObject({
      response: {
        statusCode: 409,
        message:
          'Play Spotify on this room once from a Spotify app, so its Spotify account is known.',
      },
    })
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('needs a connection before listing rooms', async () => {
    await expect(getSonosRooms('user-1')).rejects.toThrow(
      'Connect Sonos in the player, under Play on, first.',
    )
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('deletes only this owner’s Sonos secrets on disconnect', async () => {
    expect(await disconnectSonos('user-1')).toEqual({ disconnected: true })
    expect(mocks.database.delete).toHaveBeenCalledTimes(1)
  })
})
