import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  list: vi.fn(),
  detail: vi.fn(),
  schedule: vi.fn(),
  remove: vi.fn(),
  add: vi.fn(),
  additions: vi.fn(),
}))
vi.mock('@/env', () => ({
  env: { TRUSTED_ORIGINS: ['http://localhost:3001'], NODE_ENV: 'test' },
}))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.session } } }))
vi.mock('@/services/tracks', () => ({
  listPlaylists: mocks.list,
  getPlaylistDetail: mocks.detail,
  updatePlaylistSyncSchedule: mocks.schedule,
  removeImportedPlaylist: mocks.remove,
}))
vi.mock('@/services/spotify-playlist-additions', () => ({
  queueSpotifyPlaylistAddition: mocks.add,
  listSpotifyPlaylistAdditions: mocks.additions,
}))
import { ServerError } from '@/lib/error'
import playlists from '../playlists'

const app = new Hono()
app.route('/', playlists)
app.onError((error, c) =>
  error instanceof ServerError
    ? c.json(error.response, error.response.statusCode)
    : c.json({ message: 'Failed' }, 500),
)

function send(
  method: string,
  path: string,
  body?: unknown,
  origin = 'http://localhost:3001',
) {
  return app.request(`http://localhost:4001${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

const job = {
  jobId: 'job-1',
  status: 'queued',
  errorMessage: null,
  finishedAt: null,
  progress: null,
}

describe('playlist API', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Live requests forbidden')
      }),
    )
    mocks.session.mockResolvedValue({
      user: { id: 'user-1', email: 'owner@example.com', role: 'admin' },
      session: { id: 'session-1', userId: 'user-1' },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('requires a session for every playlist endpoint', async () => {
    mocks.session.mockResolvedValue(null)
    const requests: Array<[string, string, unknown]> = [
      ['GET', '/', undefined],
      ['GET', '/playlist-1', undefined],
      ['GET', '/additions?albumId=album-1', undefined],
      ['PUT', '/playlist-1/sync-schedule', { schedule: 'daily' }],
      ['POST', '/playlist-1/additions', { albumId: 'album-1' }],
      ['DELETE', '/playlist-1', undefined],
    ]
    for (const [method, path, body] of requests)
      expect((await send(method, path, body)).status).toBe(401)
    for (const fn of Object.values(mocks).filter((fn) => fn !== mocks.session))
      expect(fn).not.toHaveBeenCalled()
  })

  it('rejects invalid input and other origins before service work', async () => {
    for (const body of [
      {},
      { schedule: 'hourly' },
      { schedule: 'daily', x: 1 },
    ])
      expect((await send('PUT', '/p/sync-schedule', body)).status).toBe(422)
    for (const body of [{}, { albumId: '' }, { albumId: 'a', playlistId: 'b' }])
      expect((await send('POST', '/p/additions', body)).status).toBe(422)
    expect((await send('GET', '/additions')).status).toBe(422)
    expect((await send('GET', '/p?size=101')).status).toBe(422)
    expect(
      (
        await send(
          'POST',
          '/p/additions',
          { albumId: 'a' },
          'https://evil.invalid',
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await send(
          'PUT',
          '/p/sync-schedule',
          { schedule: 'daily' },
          'https://evil.invalid',
        )
      ).status,
    ).toBe(403)
    expect(mocks.schedule).not.toHaveBeenCalled()
    expect(mocks.add).not.toHaveBeenCalled()
    expect(mocks.additions).not.toHaveBeenCalled()
    expect(mocks.detail).not.toHaveBeenCalled()
  })

  it('passes the playlist, page, schedule and album to the services', async () => {
    mocks.detail.mockResolvedValue({ id: 'p' })
    expect((await send('GET', '/p?page=2&size=50')).status).toBe(200)
    expect(mocks.detail).toHaveBeenCalledWith('p', { page: 2, size: 50 })
    expect((await send('GET', '/p')).status).toBe(200)
    expect(mocks.detail).toHaveBeenLastCalledWith('p', { page: 1, size: 100 })

    mocks.schedule.mockResolvedValue({ id: 'p' })
    expect(
      (await send('PUT', '/p/sync-schedule', { schedule: 'weekly' })).status,
    ).toBe(200)
    expect(mocks.schedule).toHaveBeenCalledWith('p', 'weekly', 'user-1')

    const addition = { playlistId: 'p', albumId: 'a', job }
    mocks.add.mockResolvedValue(addition)
    const added = await send('POST', '/p/additions', { albumId: 'a' })
    expect(added.status).toBe(200)
    expect(await added.json()).toMatchObject({ data: addition })
    expect(mocks.add).toHaveBeenCalledWith('p', { albumId: 'a' }, 'user-1')

    mocks.additions.mockResolvedValue({ additions: [addition] })
    expect((await send('GET', '/additions?albumId=a')).status).toBe(200)
    expect(mocks.additions).toHaveBeenCalledWith('a')
    expect(mocks.detail).toHaveBeenCalledTimes(2)
  })

  it('returns service refusals with their status', async () => {
    mocks.add.mockRejectedValue(
      new ServerError({ statusCode: 422, message: 'Albums cannot be added' }),
    )
    const refused = await send('POST', '/p/additions', { albumId: 'a' })
    expect(refused.status).toBe(422)
    expect(await refused.text()).toContain('Albums cannot be added')
    expect(fetch).not.toHaveBeenCalled()
  })
})
