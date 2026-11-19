import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  items: vi.fn(),
  item: vi.fn(),
  watched: vi.fn(),
  facets: vi.fn(),
  sources: vi.fn(),
  source: vi.fn(),
  counts: vi.fn(),
  diagnostics: vi.fn(),
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
  setSubscriptionItemWatched: mocks.watched,
  listSubscriptionFacets: mocks.facets,
  listSubscriptionSources: mocks.sources,
  getSubscriptionSource: mocks.source,
  subscriptionBrowseCounts: mocks.counts,
  listSubscriptionMatchDiagnostics: mocks.diagnostics,
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
const MIX = 'nts.synthetic-show-2026-03-01'
const MIX_SHOW = 'nts.synthetic-show'
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

  it('returns the filtered and the unfiltered count for Browse', async () => {
    mocks.session.mockResolvedValueOnce(null)
    expect((await send('GET', '/browse-count')).status).toBe(401)
    expect((await send('GET', '/browse-count?filters=invalid')).status).toBe(
      422,
    )
    expect(mocks.counts).not.toHaveBeenCalled()
    mocks.counts.mockResolvedValueOnce({ totalCount: 2, unfilteredCount: 64 })
    const response = await send('GET', '/browse-count?q=bread')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: { totalCount: 2, unfilteredCount: 64 },
    })
    expect(mocks.counts).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'bread' }),
    )
  })

  it('requires a session for every endpoint', async () => {
    mocks.session.mockResolvedValue(null)
    const requests: Array<[string, string, unknown]> = [
      ['GET', '/', undefined],
      ['GET', '/?library=mixes', undefined],
      ['GET', '/fields', undefined],
      ['GET', '/fields?library=mixes', undefined],
      ['GET', '/facets?q=orbit', undefined],
      ['GET', '/match-diagnostics', undefined],
      ['GET', '/sources', undefined],
      ['GET', `/sources/${EPISODE}`, undefined],
      ['GET', `/${EPISODE}`, undefined],
      ['GET', `/${MIX}`, undefined],
      ['PATCH', `/${MIX}`, { watchedAt: null }],
      ['GET', '/sync/youtube', undefined],
      ['POST', '/sync/youtube', {}],
      ['PUT', '/sync/youtube/settings', { schedule: 'daily' }],
    ]
    for (const [method, path, body] of requests)
      expect((await send(method, path, body)).status).toBe(401)
    for (const fn of Object.values(mocks).filter((fn) => fn !== mocks.session))
      expect(fn).not.toHaveBeenCalled()
  })

  it('routes paginated diagnostics before subscription item IDs', async () => {
    const diagnostics = {
      items: [],
      providers: [],
      totalCount: 0,
      pageCount: 0,
    }
    mocks.diagnostics.mockResolvedValue(diagnostics)
    const response = await send(
      'GET',
      '/match-diagnostics?page=2&size=20&sortBy=youtube&direction=desc&q=orbit',
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: diagnostics })
    expect(mocks.diagnostics).toHaveBeenCalledExactlyOnceWith({
      page: 2,
      size: 20,
      sortBy: 'youtube',
      direction: 'desc',
      q: 'orbit',
    })
    expect(mocks.item).not.toHaveBeenCalled()
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
      { sourceId: 'invalid' },
      { size: '101' },
      { page: '0' },
    ]
    for (const params of invalid)
      expect((await send('GET', query(params))).status).toBe(422)
    expect((await send('GET', '/facets?limitPerField=51')).status).toBe(422)
    expect((await send('GET', '/sources?type=film')).status).toBe(422)
    expect((await send('GET', '/sources/invalid')).status).toBe(422)
    expect((await send('GET', `/sources/${EPISODE}?size=101`)).status).toBe(422)
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

  it('passes the source ID and validated item query to channel detail', async () => {
    mocks.source.mockResolvedValue({
      source: { id: EPISODE },
      items: { items: [] },
    })
    expect(
      (await send('GET', `/sources/${EPISODE}?page=2&size=12&q=orbit`)).status,
    ).toBe(200)
    expect(mocks.source).toHaveBeenCalledWith(EPISODE, {
      library: 'subscriptions',
      q: 'orbit',
      fields: 'all',
      direction: 'desc',
      page: 2,
      size: 12,
      filters: [],
      ranges: [],
    })
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
        sourceId: EPISODE,
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
      library: 'subscriptions',
      q: 'orbit',
      sourceId: EPISODE,
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
    expect(mocks.facets).toHaveBeenCalledWith({
      q: 'orbit',
      limitPerField: 25,
      library: 'subscriptions',
    })
    mocks.sources.mockResolvedValue({ items: [] })
    expect((await send('GET', '/sources?type=spotify')).status).toBe(200)
    expect(mocks.sources).toHaveBeenCalledWith({
      library: 'subscriptions',
      type: 'spotify',
    })

    const fields = await send('GET', '/fields')
    expect(fields.status).toBe(200)
    const keys = (
      (await fields.json()) as { data: Array<{ key: string }> }
    ).data.map((field) => field.key)
    expect(keys).toContain('durationSec')
    expect(keys).toContain('viewCount')
    expect(keys).not.toContain('artist')
  })

  it('passes the Mixes library to every list, facet, field and source read', async () => {
    const page = { items: [], totalCount: 0, page: 1, size: 24, pageCount: 0 }
    mocks.items.mockResolvedValue(page)
    const filters = [
      { field: 'artist', value: 'Synthetic DJ', mode: 'required' },
      { field: 'type', value: 'NTS', mode: 'any' },
    ]
    const ranges = [{ field: 'durationSec', min: 3600, includeMissing: true }]
    expect(
      (
        await send(
          'GET',
          query({
            library: 'mixes',
            filters: JSON.stringify(filters),
            ranges: JSON.stringify(ranges),
            sortBy: 'durationSec',
          }),
        )
      ).status,
    ).toBe(200)
    expect(mocks.items).toHaveBeenCalledWith({
      library: 'mixes',
      fields: 'all',
      filters,
      ranges,
      sortBy: 'durationSec',
      direction: 'desc',
      page: 1,
      size: 24,
    })
    mocks.counts.mockResolvedValue({ totalCount: 0, unfilteredCount: 0 })
    expect((await send('GET', '/browse-count?library=mixes')).status).toBe(200)
    expect(mocks.counts).toHaveBeenCalledWith(
      expect.objectContaining({ library: 'mixes' }),
    )
    mocks.facets.mockResolvedValue([])
    expect((await send('GET', '/facets?library=mixes&q=house')).status).toBe(
      200,
    )
    expect(mocks.facets).toHaveBeenCalledWith({
      q: 'house',
      limitPerField: 25,
      library: 'mixes',
    })
    mocks.sources.mockResolvedValue({ items: [] })
    expect((await send('GET', '/sources?library=mixes&type=nts')).status).toBe(
      200,
    )
    expect(mocks.sources).toHaveBeenCalledWith({
      library: 'mixes',
      type: 'nts',
    })
    mocks.source.mockResolvedValue({ source: { id: MIX_SHOW }, items: {} })
    expect((await send('GET', `/sources/${MIX_SHOW}`)).status).toBe(200)
    expect(mocks.source).toHaveBeenCalledWith(
      MIX_SHOW,
      expect.objectContaining({ library: 'subscriptions' }),
    )

    const fields = await send('GET', '/fields?library=mixes')
    expect(fields.status).toBe(200)
    expect(
      ((await fields.json()) as { data: Array<{ key: string; label: string }> })
        .data,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'artist', label: 'Artist' }),
        expect.objectContaining({ key: 'source', label: 'Show' }),
        expect.objectContaining({ key: 'type', label: 'Station' }),
      ]),
    )
    expect(
      (
        (await (await send('GET', '/fields?library=mixes')).json()) as {
          data: Array<{ key: string }>
        }
      ).data.map((field) => field.key),
    ).not.toContain('viewCount')
  })

  it('rejects fields of the other library with 422 before service work', async () => {
    const invalid: Array<Record<string, string>> = [
      { filters: JSON.stringify([{ field: 'artist', value: 'Synthetic DJ' }]) },
      {
        library: 'subscriptions',
        filters: JSON.stringify([{ field: 'artist', value: 'Synthetic DJ' }]),
      },
      { library: 'mixes', ranges: JSON.stringify([{ field: 'viewCount' }]) },
      { library: 'mixes', ranges: JSON.stringify([{ field: 'likeCount' }]) },
      { library: 'mixes', ranges: JSON.stringify([{ field: 'commentCount' }]) },
      { library: 'mixes', sortBy: 'viewCount' },
      { library: 'films' },
    ]
    for (const params of invalid) {
      expect((await send('GET', query(params))).status).toBe(422)
      expect(
        (await send('GET', `/browse-page?${new URLSearchParams(params)}`))
          .status,
      ).toBe(422)
    }
    expect((await send('GET', '/fields?library=films')).status).toBe(422)
    expect((await send('GET', '/facets?library=films')).status).toBe(422)
    expect((await send('GET', '/sources?type=nts')).status).toBe(422)
    expect(
      (await send('GET', '/sources?library=mixes&type=youtube')).status,
    ).toBe(422)
    for (const fn of Object.values(mocks).filter((fn) => fn !== mocks.session))
      expect(fn).not.toHaveBeenCalled()
  })

  it('reads and marks one mix by ID without a library parameter', async () => {
    mocks.item.mockResolvedValue({ id: MIX, type: 'nts' })
    expect((await send('GET', `/${MIX}`)).status).toBe(200)
    expect(mocks.item).toHaveBeenCalledWith(MIX)
    const watchedAt = '2026-09-21T18:30:00.000Z'
    mocks.watched.mockResolvedValue({ id: MIX, watchedAt })
    expect((await send('PATCH', `/${MIX}`, { watchedAt })).status).toBe(200)
    expect(mocks.watched).toHaveBeenCalledWith(MIX, { watchedAt })
  })

  it('answers 404 for an item outside the library', async () => {
    mocks.item.mockResolvedValue(null)
    expect((await send('GET', `/${EPISODE}`)).status).toBe(404)
    expect(mocks.item).toHaveBeenCalledWith(EPISODE)
    mocks.item.mockResolvedValue({ id: EPISODE })
    expect((await send('GET', `/${EPISODE}`)).status).toBe(200)
  })

  it('sets and clears the watched date through the library service', async () => {
    const watchedAt = '2026-09-21T18:30:00.000Z'
    mocks.session.mockResolvedValueOnce(null)
    expect((await send('PATCH', `/${EPISODE}`, { watchedAt })).status).toBe(401)
    for (const body of [
      {},
      { watchedAt: 'yesterday' },
      { watchedAt, title: 'Changed' },
    ])
      expect((await send('PATCH', `/${EPISODE}`, body)).status).toBe(422)
    expect(
      (await send('PATCH', '/not-an-id', { watchedAt: null })).status,
    ).toBe(422)
    expect(
      (
        await send(
          'PATCH',
          `/${EPISODE}`,
          { watchedAt },
          'https://evil.invalid',
        )
      ).status,
    ).toBe(403)
    expect(mocks.watched).not.toHaveBeenCalled()
    mocks.watched.mockResolvedValue({ id: EPISODE, watchedAt })
    const set = await send('PATCH', `/${EPISODE}`, { watchedAt })
    expect(set.status).toBe(200)
    expect(await set.json()).toMatchObject({ data: { watchedAt } })
    expect(mocks.watched).toHaveBeenLastCalledWith(EPISODE, { watchedAt })
    expect(
      (await send('PATCH', `/${EPISODE}`, { watchedAt: null })).status,
    ).toBe(200)
    expect(mocks.watched).toHaveBeenLastCalledWith(EPISODE, {
      watchedAt: null,
    })
    mocks.watched.mockRejectedValue(
      new ServerError({ statusCode: 404, message: 'Item not found' }),
    )
    expect(
      (await send('PATCH', `/${EPISODE}`, { watchedAt: null })).status,
    ).toBe(404)
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
