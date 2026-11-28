import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  list: vi.fn(),
  page: vi.fn(),
  count: vi.fn(),
  detail: vi.fn(),
  presentation: vi.fn(),
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
vi.mock('@/services/playlist-directory', () => ({
  listPlaylists: mocks.list,
  listPlaylistBrowsePage: mocks.page,
  countPlaylists: mocks.count,
  updatePlaylistPresentation: mocks.presentation,
}))
vi.mock('@/services/tracks', () => ({
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
      ['GET', '/browse-page', undefined],
      ['GET', '/browse-count', undefined],
      ['GET', '/playlist-1', undefined],
      ['GET', '/additions?albumId=album-1', undefined],
      ['PUT', '/playlist-1/presentation', { presentation: null }],
      ['PUT', '/playlist-1/sync-schedule', { schedule: 'daily' }],
      ['POST', '/playlist-1/additions', { albumId: 'album-1' }],
      ['DELETE', '/playlist-1', undefined],
    ]
    for (const [method, path, body] of requests)
      expect((await send(method, path, body)).status).toBe(401)
    for (const fn of Object.values(mocks).filter((fn) => fn !== mocks.session))
      expect(fn).not.toHaveBeenCalled()
  })

  it('shares validated playlist directory filters between independently loaded rows and counts', async () => {
    const params = new URLSearchParams({
      q: ' Mix ',
      name: 'Favorite',
      owner: ' Synthetic ',
      description: 'fixture',
      sources: JSON.stringify(['spotify', 'library']),
      types: '["smart"]',
      schedules: '["daily"]',
      savedView: 'present',
      savedViewText: ' jazz ',
      columnRanges: '{"count":{"min":0},"updated":{"max":"2025-05-01"}}',
      timeZone: 'Australia/Hobart',
      keyNotation: 'camelot',
      acceptsAdditions: 'true',
      ids: JSON.stringify(['playlist-1']),
      sortBy: 'nextSync',
      direction: 'desc',
      page: '2',
      size: '20',
    })
    const parsed = {
      q: 'Mix',
      name: 'Favorite',
      owner: 'Synthetic',
      description: 'fixture',
      sources: ['spotify', 'library'],
      types: ['smart'],
      schedules: ['daily'],
      savedView: 'present',
      savedViewText: 'jazz',
      columnRanges: { count: { min: 0 }, updated: { max: '2025-05-01' } },
      timeZone: 'Australia/Hobart',
      keyNotation: 'camelot',
      acceptsAdditions: 'true',
      ids: ['playlist-1'],
      sortBy: 'nextSync',
      direction: 'desc',
      page: 2,
      size: 20,
    }
    const page = { items: [], page: 2, size: 20, hasMore: false }
    mocks.page.mockResolvedValue(page)
    mocks.count.mockResolvedValue({ totalCount: 1 })
    mocks.list.mockResolvedValue([])
    expect((await send('GET', `/browse-page?${params}`)).status).toBe(200)
    expect(mocks.page).toHaveBeenCalledExactlyOnceWith(parsed)
    expect(mocks.count).not.toHaveBeenCalled()
    expect((await send('GET', `/browse-count?${params}`)).status).toBe(200)
    expect(mocks.count).toHaveBeenCalledExactlyOnceWith(parsed)
    expect(mocks.page).toHaveBeenCalledTimes(1)
    const legacy = await send('GET', '/')
    expect(legacy.status).toBe(200)
    expect(await legacy.json()).toMatchObject({ data: [] })
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith({
      sortBy: 'name',
      direction: 'asc',
      page: 1,
      size: 100,
    })
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
    for (const query of [
      'size=101',
      'sortBy=unknown',
      'sources=malformed',
      'types=malformed',
      'columnRanges=%7B%22updated%22%3A%7B%22min%22%3A%222025-02-29%22%7D%7D',
      'ids=%5B%5D',
      'acceptsAdditions=yes',
    ])
      for (const path of ['/', '/browse-page', '/browse-count'])
        expect((await send('GET', `${path}?${query}`)).status).toBe(422)
    for (const query of [
      'sortBy=unknown',
      'direction=reverse',
      'kind=unknown',
      'kinds=invalid',
      'kinds=%5B%22unknown%22%5D',
      `q=${'x'.repeat(201)}`,
    ])
      expect((await send('GET', `/p?${query}`)).status).toBe(422)
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
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.page).not.toHaveBeenCalled()
    expect(mocks.count).not.toHaveBeenCalled()
  })

  it('passes the playlist, page, schedule and album to the services', async () => {
    mocks.detail.mockResolvedValue({ id: 'p' })
    expect((await send('GET', '/p?page=2&size=50')).status).toBe(200)
    expect(mocks.detail).toHaveBeenCalledWith('p', {
      page: 2,
      size: 50,
      sortBy: 'position',
      direction: 'asc',
    })
    expect((await send('GET', '/p')).status).toBe(200)
    expect(mocks.detail).toHaveBeenLastCalledWith('p', {
      page: 1,
      size: 100,
      sortBy: 'position',
      direction: 'asc',
    })

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

  it('validates and saves the playlist presentation from a trusted origin', async () => {
    const path = '/p/presentation'
    for (const body of [
      {},
      { presentation: 'automatic' },
      { presentation: 'albums', extra: true },
    ])
      expect((await send('PUT', path, body)).status).toBe(422)

    expect(
      (
        await send(
          'PUT',
          path,
          { presentation: 'albums' },
          'https://evil.invalid',
        )
      ).status,
    ).toBe(403)
    expect(mocks.presentation).not.toHaveBeenCalled()

    const summary = {
      id: 'p',
      presentation: 'albums',
      presentationOverride: 'albums',
    }
    mocks.presentation.mockResolvedValue(summary)
    const saved = await send('PUT', path, { presentation: 'albums' })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ data: summary })
    expect(mocks.presentation).toHaveBeenCalledExactlyOnceWith('p', 'albums')

    mocks.presentation.mockResolvedValue({
      id: 'p',
      presentation: 'tracks',
      presentationOverride: null,
    })
    const automatic = await send('PUT', path, { presentation: null })
    expect(automatic.status).toBe(200)
    expect(mocks.presentation).toHaveBeenLastCalledWith('p', null)
  })

  it('forwards explicit playlist entry sorting alongside pagination', async () => {
    mocks.detail.mockResolvedValue({ id: 'p' })
    expect(
      (await send('GET', '/p?page=2&size=50&sortBy=title&direction=desc'))
        .status,
    ).toBe(200)
    expect(mocks.detail).toHaveBeenCalledExactlyOnceWith('p', {
      page: 2,
      size: 50,
      sortBy: 'title',
      direction: 'desc',
    })
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
  it('forwards playlist search and entry type before pagination', async () => {
    mocks.detail.mockResolvedValue({ id: 'p' })
    expect(
      (await send('GET', '/p?q=Album&kind=album&page=2&size=1')).status,
    ).toBe(200)
    expect(mocks.detail).toHaveBeenCalledExactlyOnceWith('p', {
      q: 'Album',
      kind: 'album',
      page: 2,
      size: 1,
      sortBy: 'position',
      direction: 'asc',
    })
  })
  it('passes multiple entry types to the service', async () => {
    mocks.detail.mockResolvedValue({ id: 'p' })
    const params = new URLSearchParams({
      kinds: JSON.stringify(['track', 'album']),
    })
    expect((await send('GET', `/p?${params}`)).status).toBe(200)
    expect(mocks.detail).toHaveBeenCalledWith(
      'p',
      expect.objectContaining({ kinds: ['track', 'album'] }),
    )
  })
})
