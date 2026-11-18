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
    execute: vi.fn(),
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
    direct: vi.fn(),
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
  createDirectProviderRequest: mocks.direct,
  recordProviderFailure: mocks.failure,
}))

import { decryptSecretValue, encryptSecretValue } from '@/lib/crypto'
import {
  authorizeLastfmScrobbling,
  disconnectLastfmScrobbling,
  finishLastfmScrobbling,
  getLastfmScrobblingStatus,
  newLastfmPlays,
  scrobbleLastfmPlays,
} from '../lastfm-scrobbling'

const TOKEN = 'fixturetoken0123456789abcdef01'

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
  const response = await authorizeLastfmScrobbling(
    'user-1',
    'session-1',
    'https://web.example.test',
  )
  const url = new URL(response.url)
  const callback = new URL(url.searchParams.get('cb') ?? '')
  const state = callback.pathname.split('/').at(-1) ?? ''
  const saved = secretSchema.parse(mocks.values.mock.calls.at(-1)?.[0])
  return { url, callback, state, saved: { ...saved, id: 'state-row' } }
}

function mockCompletion(
  saved: { id: string; encryptedValue: string },
  stored = true,
) {
  mocks.database.select
    .mockReturnValueOnce(query([]))
    .mockReturnValueOnce(query([saved]))
  // The pending state is only rechecked when Last.fm confirms the sign-in.
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

function storedSession(values: Record<string, unknown> = {}) {
  return query([
    {
      id: 'session-row',
      encryptedValue: encryptSecretValue(
        JSON.stringify({
          sessionKey: 'fixture-session-key',
          name: 'fixture-listener',
          apiKey: 'fixture-key',
          ...values,
        }),
      ),
    },
  ])
}

describe('Last.fm scrobbling sign-in (mock database and requests)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resetEnvironment()
    mocks.secrets.mockReturnValue({
      apiKey: 'fixture-key',
      apiSecret: 'fixture-secret',
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
    mocks.request.mockResolvedValue(
      Response.json({
        session: { name: 'fixture-listener', key: 'fixture-session-key' },
      }),
    )
    mocks.direct.mockReturnValue(mocks.request)
  })
  afterEach(() => {
    mocks.resetEnvironment()
    vi.unstubAllGlobals()
  })

  it('needs the shared secret as well as the API key', async () => {
    mocks.secrets.mockReturnValue({ apiKey: 'fixture-key', username: 'x' })
    expect(await getLastfmScrobblingStatus('user-1')).toEqual({
      configured: false,
      connected: false,
      account: null,
    })
    await expect(
      authorizeLastfmScrobbling(
        'user-1',
        'session-1',
        'https://web.example.test',
      ),
    ).rejects.toThrow('shared secret')
    expect(mocks.values).not.toHaveBeenCalled()
  })

  it('reports a session only for the API key it was issued for', async () => {
    mocks.database.select
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(storedSession())
    expect(await getLastfmScrobblingStatus('user-1')).toEqual({
      configured: true,
      connected: true,
      account: 'fixture-listener',
    })
    mocks.database.select
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(storedSession({ apiKey: 'replaced-key' }))
    expect(await getLastfmScrobblingStatus('user-1')).toEqual({
      configured: true,
      connected: false,
      account: null,
    })
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('refuses untrusted origins before storing state', async () => {
    await expect(
      authorizeLastfmScrobbling('user-1', 'session-1', 'https://evil.invalid'),
    ).rejects.toThrow('trusted app origin')
    mocks.env.AUTH_BASE_URL = 'http://api.example.test'
    mocks.env.TRUSTED_ORIGINS.push('http://api.example.test')
    await expect(
      authorizeLastfmScrobbling(
        'user-1',
        'session-1',
        'https://web.example.test',
      ),
    ).rejects.toThrow('trusted browser-facing API')
    expect(mocks.values).not.toHaveBeenCalled()
  })

  it('sends the owner to Last.fm with the state in the callback path, hashed and session-bound', async () => {
    const { url, callback, state, saved } = await begin()
    expect(url.origin + url.pathname).toBe('https://www.last.fm/api/auth/')
    expect(url.searchParams.get('api_key')).toBe('fixture-key')
    expect(callback.origin).toBe('https://api.example.test')
    expect(callback.pathname).toBe(
      `/api/v1/lastfm/scrobbling/callback/${state}`,
    )
    expect(callback.search).toBe('')
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url.toString()).not.toContain('fixture-secret')
    expect(saved.key).toBe('state')
    expect(saved.provider).toMatch(/^lastfm-account-[0-9a-f]{64}$/)
    expect(saved.provider).not.toContain('user-1')
    const stored = savedSchema.parse(
      JSON.parse(decryptSecretValue(saved.encryptedValue)),
    )
    expect(stored['stateHash']).not.toBe(state)
    expect(stored['sessionHash']).not.toBe('session-1')
    expect(stored).toMatchObject({
      apiKey: 'fixture-key',
      returnOrigin: 'https://web.example.test',
    })
    expect(JSON.stringify(stored)).not.toContain('fixture-secret')
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('accepts a local HTTP callback in development', async () => {
    mocks.env.AUTH_BASE_URL = 'http://localhost:4000'
    mocks.env.TRUSTED_ORIGINS.push('http://localhost:4000')
    const { callback } = await begin()
    expect(callback.origin).toBe('http://localhost:4000')
  })

  it('exchanges the token with a signed POST and stores the session encrypted', async () => {
    const { state, saved } = await begin()
    mockCompletion(saved)
    expect(
      await finishLastfmScrobbling(
        state,
        { token: TOKEN },
        'user-1',
        'session-1',
      ),
    ).toEqual({ connected: true, returnOrigin: 'https://web.example.test' })
    const [url, init] = mocks.request.mock.calls[0] ?? []
    expect(url).toBe('https://ws.audioscrobbler.com/2.0/')
    const request = z
      .object({
        method: z.literal('POST'),
        headers: z.record(z.string(), z.string()),
        body: z.instanceof(URLSearchParams),
      })
      .parse(init)
    expect(request.headers['User-Agent']).toBe('media-manager-lastfm-sync/1.0')
    expect(Object.fromEntries(request.body)).toEqual({
      method: 'auth.getSession',
      api_key: 'fixture-key',
      token: TOKEN,
      format: 'json',
      api_sig: expect.stringMatching(/^[0-9a-f]{32}$/),
    })
    expect(mocks.direct).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({ id: 'lastfm' }),
      }),
      [400, 401, 403],
    )
    const session = secretSchema.parse(mocks.values.mock.calls.at(-1)?.[0])
    expect(session.key).toBe('session')
    expect(session.encryptedValue).not.toContain('fixture-session-key')
    expect(
      savedSchema.parse(JSON.parse(decryptSecretValue(session.encryptedValue))),
    ).toEqual({
      sessionKey: 'fixture-session-key',
      name: 'fixture-listener',
      apiKey: 'fixture-key',
    })
    expect(mocks.clearHalt).toHaveBeenCalledWith('lastfm')
    expect(mocks.failure).not.toHaveBeenCalled()
  })

  it('rejects a state from another session or a changed API key without contacting Last.fm', async () => {
    const { state, saved } = await begin()
    mockCompletion(saved, false)
    await expect(
      finishLastfmScrobbling(state, { token: TOKEN }, 'user-1', 'session-2'),
    ).rejects.toThrow('does not match this session')
    mockCompletion(saved, false)
    await expect(
      finishLastfmScrobbling(
        'b'.repeat(43),
        { token: TOKEN },
        'user-1',
        'session-1',
      ),
    ).rejects.toThrow('does not match this session')
    mocks.secrets.mockReturnValue({
      apiKey: 'replaced-key',
      apiSecret: 'fixture-secret',
    })
    mockCompletion(saved, false)
    await expect(
      finishLastfmScrobbling(state, { token: TOKEN }, 'user-1', 'session-1'),
    ).rejects.toThrow('does not match this session')
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('rejects an expired or already used state', async () => {
    const { state, saved } = await begin()
    const value = savedSchema.parse(
      JSON.parse(decryptSecretValue(saved.encryptedValue)),
    )
    for (const change of [{ expiresAt: Date.now() - 1 }, { consumed: true }]) {
      mockCompletion(
        {
          id: 'state-row',
          encryptedValue: encryptSecretValue(
            JSON.stringify({ ...value, ...change }),
          ),
        },
        false,
      )
      await expect(
        finishLastfmScrobbling(state, { token: TOKEN }, 'user-1', 'session-1'),
      ).rejects.toThrow('Connect again')
    }
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('drops the pending state when the owner does not allow the app', async () => {
    const { state, saved } = await begin()
    mockCompletion(saved, false)
    expect(
      await finishLastfmScrobbling(state, {}, 'user-1', 'session-1'),
    ).toEqual({ connected: false, returnOrigin: 'https://web.example.test' })
    expect(mocks.database.delete).toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('stores nothing when Last.fm refuses the token, and records no provider failure for it', async () => {
    const { state, saved } = await begin()
    mockCompletion(saved, false)
    mocks.request.mockResolvedValueOnce(
      Response.json(
        { error: 14, message: 'Unauthorized Token' },
        { status: 403 },
      ),
    )
    await expect(
      finishLastfmScrobbling(state, { token: TOKEN }, 'user-1', 'session-1'),
    ).rejects.toThrow('did not confirm')
    expect(mocks.failure).not.toHaveBeenCalled()
    expect(mocks.clearHalt).not.toHaveBeenCalled()
    expect(
      mocks.values.mock.calls.some(
        ([value]) => secretSchema.safeParse(value).data?.key === 'session',
      ),
    ).toBe(false)
  })

  it('records a refused API key as the provider access denial the history sync records', async () => {
    const { state, saved } = await begin()
    mockCompletion(saved, false)
    mocks.request.mockResolvedValueOnce(
      Response.json(
        { error: 26, message: 'Suspended API key' },
        { status: 403 },
      ),
    )
    await expect(
      finishLastfmScrobbling(state, { token: TOKEN }, 'user-1', 'session-1'),
    ).rejects.toThrow('did not confirm')
    const error = mocks.failure.mock.calls[0]?.[1]
    expect(error).toBeInstanceOf(ProviderRequestError)
    expect(error).toMatchObject({ code: 'access-denied' })
  })

  it('records a rate limit with its retry time', async () => {
    const { state, saved } = await begin()
    mockCompletion(saved, false)
    mocks.request.mockResolvedValueOnce(
      Response.json({ error: 29, message: 'Rate limit exceeded' }),
    )
    await expect(
      finishLastfmScrobbling(state, { token: TOKEN }, 'user-1', 'session-1'),
    ).rejects.toThrow('did not confirm')
    const error = mocks.failure.mock.calls[0]?.[1]
    expect(error).toMatchObject({ code: 'rate-limit' })
    expect(error).toHaveProperty('retryAt', expect.any(Number))
  })

  it('reports not connected for a scrobble report without a session and keeps nothing', async () => {
    expect(
      await scrobbleLastfmPlays('user-1', {
        plays: [
          {
            trackUri: 'spotify:track:ABCDEFGHIJKLMNOPQRSTUV',
            track: 'Fixture Track',
            artist: 'Fixture Artist',
            album: '',
            durationMs: 200000,
            startedAt: Date.now() - 60000,
          },
        ],
      }),
    ).toEqual({ connected: false, accepted: 0, scrobbled: 0, waiting: 0 })
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.database.insert).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('disconnects by deleting the account secrets and waiting plays', async () => {
    expect(await disconnectLastfmScrobbling('user-1')).toEqual({
      disconnected: true,
    })
    expect(mocks.database.delete).toHaveBeenCalledTimes(2)
  })
})

describe('which reported plays are kept', () => {
  const now = Date.UTC(2026, 10, 18, 12)
  const play = (
    startedAt: number,
    durationMs: number | null = 200000,
    trackUri = 'spotify:track:ABCDEFGHIJKLMNOPQRSTUV',
  ) => ({
    trackUri,
    track: 'Fixture Track',
    artist: 'Fixture Artist',
    album: 'Fixture Album',
    durationMs,
    startedAt,
  })

  it('drops plays more than five minutes ahead or fourteen days behind', () => {
    const day = 24 * 60 * 60 * 1000
    expect(
      newLastfmPlays(
        [
          play(now + 5 * 60 * 1000 + 1),
          play(now + 5 * 60 * 1000),
          play(
            now - 14 * day - 1,
            null,
            'spotify:track:BBBBBBBBBBBBBBBBBBBBBB',
          ),
          play(
            now - 14 * day + 1000,
            null,
            'spotify:track:CCCCCCCCCCCCCCCCCCCCCC',
          ),
        ],
        [],
        now,
      ).map((kept) => kept.startedAt),
    ).toEqual([now - 14 * day + 1000, now + 5 * 60 * 1000])
  })

  it('drops a play within the longer duration, less ten seconds, of a known play of the same track', () => {
    const known = [{ ...play(now - 600000), durationMs: 200000 }]
    expect(newLastfmPlays([play(now - 600000 + 189999)], known, now)).toEqual(
      [],
    )
    // A repeat read as starting just before the first ended is a new play.
    expect(
      newLastfmPlays([play(now - 600000 + 190000)], known, now),
    ).toHaveLength(1)
    // The longer of the two durations applies.
    expect(
      newLastfmPlays([play(now - 600000 + 250000, 300000)], known, now),
    ).toEqual([])
    // Another track at the same time is kept.
    expect(
      newLastfmPlays(
        [play(now - 600000, 200000, 'spotify:track:BBBBBBBBBBBBBBBBBBBBBB')],
        known,
        now,
      ),
    ).toHaveLength(1)
  })

  it('uses at least 30 seconds when durations are short or unknown', () => {
    const known = [{ ...play(now - 600000), durationMs: null }]
    expect(
      newLastfmPlays([play(now - 600000 + 29999, null)], known, now),
    ).toEqual([])
    expect(
      newLastfmPlays([play(now - 600000 + 30000, 1000)], known, now),
    ).toHaveLength(1)
  })

  it('de-duplicates inside one report, keeping the earliest', () => {
    expect(
      newLastfmPlays(
        [play(now - 100000), play(now - 300000), play(now - 295000)],
        [],
        now,
      ).map((kept) => kept.startedAt),
    ).toEqual([now - 300000, now - 100000])
  })
})
