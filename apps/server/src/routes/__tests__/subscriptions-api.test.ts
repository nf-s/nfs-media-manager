import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  items: vi.fn(),
  item: vi.fn(),
  facets: vi.fn(),
  sources: vi.fn(),
  status: vi.fn(),
  queue: vi.fn(),
  schedule: vi.fn(),
}))
vi.mock('@/env', () => ({
  env: { TRUSTED_ORIGINS: ['http://localhost:3001'], NODE_ENV: 'test' },
}))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.session } } }))
vi.mock('@/services/subscription-library', () => ({
  listSubscriptionItems: mocks.items,
  getSubscriptionItem: mocks.item,
  listSubscriptionFacets: mocks.facets,
  listSubscriptionSources: mocks.sources,
}))
vi.mock('@/services/subscription-sync', () => ({
  getSubscriptionSyncStatus: mocks.status,
  queueSubscriptionSync: mocks.queue,
  setSubscriptionSyncSchedule: mocks.schedule,
}))
import { ServerError } from '@/lib/error'
import subscriptions from '../subscriptions'

const app = new Hono()
app.route('/', subscriptions)

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

const EPISODE = 'EpisodeFixture00000001'
const query = (params: Record<string, string>) =>
  `/?${new URLSearchParams(params)}`

describe('subscriptions API', () => {
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

  it('requires a session for every endpoint', async () => {
    mocks.session.mockResolvedValue(null)
    const requests: Array<[string, string, unknown]> = [
      ['GET', '/', undefined],
      ['GET', '/fields', undefined],
      ['GET', '/facets?q=orbit', undefined],
      ['GET', '/sources', undefined],
      ['GET', `/${EPISODE}`, undefined],
      ['GET', '/sync/youtube', undefined],
      ['POST', '/sync/youtube', {}],
      ['PUT', '/sync/youtube/settings', { schedule: 'daily' }],
    ]
    for (const [method, path, body] of requests)
      expect((await send(method, path, body)).status).toBe(401)
    for (const fn of Object.values(mocks).filter((fn) => fn !== mocks.session))
      expect(fn).not.toHaveBeenCalled()
  })

  it('rejects invalid input and other origins before service work', async () => {
    const invalid: Array<Record<string, string>> = [
      { filters: JSON.stringify([{ field: 'description', value: 'x' }]) },
      { filters: JSON.stringify([{ field: 'title', value: '' }]) },
      { ranges: JSON.stringify([{ field: 'title', min: 1 }]) },
      { ranges: JSON.stringify([{ field: 'durationSec', min: 9, max: 1 }]) },
      { sortBy: 'dateAdded' },
      { direction: 'up' },
      { fields: 'description' },
      { size: '101' },
      { page: '0' },
    ]
    for (const params of invalid)
      expect((await send('GET', query(params))).status).toBe(422)
    expect((await send('GET', '/facets?limitPerField=51')).status).toBe(422)
    expect((await send('GET', '/sources?type=film')).status).toBe(422)
    expect((await send('GET', '/not-an-item-id')).status).toBe(422)
    expect((await send('GET', '/sync/lastfm')).status).toBe(422)
    for (const body of [{ schedule: 'hourly' }, { schedule: 'daily', x: 1 }])
      expect((await send('PUT', '/sync/youtube/settings', body)).status).toBe(
        422,
      )
    expect((await send('POST', '/sync/youtube', { force: true })).status).toBe(
      422,
    )
    expect(
      (await send('POST', '/sync/youtube', {}, 'https://evil.invalid')).status,
    ).toBe(403)
    expect(
      (
        await send(
          'PUT',
          '/sync/youtube/settings',
          { schedule: 'daily' },
          'https://evil.invalid',
        )
      ).status,
    ).toBe(403)
    for (const fn of Object.values(mocks).filter((fn) => fn !== mocks.session))
      expect(fn).not.toHaveBeenCalled()
  })

  it('passes parsed browse queries to the library service', async () => {
    const page = { items: [], totalCount: 0, page: 2, size: 100, pageCount: 0 }
    mocks.items.mockResolvedValue(page)
    const filters = [{ field: 'source', value: 'Orbit Talk', mode: 'any' }]
    const ranges = [{ field: 'publishedAt', min: 0 }]
    const response = await send(
      'GET',
      query({
        q: 'orbit',
        filters: JSON.stringify(filters),
        ranges: JSON.stringify(ranges),
        sortBy: 'viewCount',
        direction: 'asc',
        page: '2',
        size: '100',
      }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: page })
    expect(mocks.items).toHaveBeenCalledWith({
      q: 'orbit',
      fields: 'all',
      filters,
      ranges: [{ ...ranges[0], includeMissing: false }],
      sortBy: 'viewCount',
      direction: 'asc',
      page: 2,
      size: 100,
    })

    mocks.facets.mockResolvedValue([])
    expect((await send('GET', '/facets?q=orbit')).status).toBe(200)
    expect(mocks.facets).toHaveBeenCalledWith({ q: 'orbit', limitPerField: 25 })
    mocks.sources.mockResolvedValue({ items: [] })
    expect((await send('GET', '/sources?type=spotify')).status).toBe(200)
    expect(mocks.sources).toHaveBeenCalledWith({ type: 'spotify' })

    const fields = await send('GET', '/fields')
    expect(fields.status).toBe(200)
    expect(
      ((await fields.json()) as { data: Array<{ key: string }> }).data.map(
        (field) => field.key,
      ),
    ).toContain('durationSec')
  })

  it('answers 404 for an item outside the library', async () => {
    mocks.item.mockResolvedValue(null)
    expect((await send('GET', `/${EPISODE}`)).status).toBe(404)
    expect(mocks.item).toHaveBeenCalledWith(EPISODE)
    mocks.item.mockResolvedValue({ id: EPISODE })
    expect((await send('GET', `/${EPISODE}`)).status).toBe(200)
  })

  it('passes the provider, user and schedule to the sync service', async () => {
    mocks.status.mockResolvedValue({ provider: 'youtube' })
    mocks.queue.mockResolvedValue({ provider: 'youtube' })
    mocks.schedule.mockResolvedValue({ provider: 'youtube' })
    expect((await send('GET', '/sync/youtube')).status).toBe(200)
    expect(mocks.status).toHaveBeenCalledWith('youtube', 'user-1')
    expect((await send('POST', '/sync/youtube', {})).status).toBe(200)
    expect(mocks.queue).toHaveBeenCalledWith('youtube', 'user-1')
    expect(
      (await send('PUT', '/sync/youtube/settings', { schedule: 'weekly' }))
        .status,
    ).toBe(200)
    expect(mocks.schedule).toHaveBeenCalledWith('youtube', 'user-1', 'weekly')

    mocks.status.mockResolvedValue({ provider: 'spotify' })
    mocks.queue.mockResolvedValue({ provider: 'spotify' })
    mocks.schedule.mockResolvedValue({ provider: 'spotify' })
    const spotify = await send('GET', '/sync/spotify')
    expect(spotify.status).toBe(200)
    expect(await spotify.json()).toMatchObject({
      data: { provider: 'spotify' },
    })
    expect(mocks.status).toHaveBeenLastCalledWith('spotify', 'user-1')
    expect((await send('POST', '/sync/spotify', {})).status).toBe(200)
    expect(mocks.queue).toHaveBeenLastCalledWith('spotify', 'user-1')
    expect(
      (await send('PUT', '/sync/spotify/settings', { schedule: 'off' })).status,
    ).toBe(200)
    expect(mocks.schedule).toHaveBeenLastCalledWith('spotify', 'user-1', 'off')
    expect(
      (await send('POST', '/sync/spotify', {}, 'https://evil.invalid')).status,
    ).toBe(403)
  })

  it('passes the refusal of a podcast sync through', async () => {
    mocks.queue.mockRejectedValue(
      new ServerError({
        statusCode: 422,
        message: 'Connect a Spotify account before syncing podcasts.',
      }),
    )
    const refused = await send('POST', '/sync/spotify', {})
    expect(refused.status).toBe(422)
    expect(await refused.json()).toMatchObject({
      message: 'Connect a Spotify account before syncing podcasts.',
    })
    mocks.queue.mockRejectedValue(
      new ServerError({
        statusCode: 429,
        message: 'Provider requests are halted after access denial',
      }),
    )
    expect((await send('POST', '/sync/spotify', {})).status).toBe(429)
  })
})
