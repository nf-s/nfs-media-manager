import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  page: vi.fn(),
  count: vi.fn(),
  detail: vi.fn(),
  albumPage: vi.fn(),
  albumCount: vi.fn(),
  albumDetail: vi.fn(),
}))
vi.mock('@/env', () => ({ env: { NODE_ENV: 'test' } }))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.session } } }))
vi.mock('@/services/collections', () => ({
  listFilmCollectionBrowsePage: mocks.page,
  countFilmCollections: mocks.count,
  getFilmCollection: mocks.detail,
  listAlbumCollectionBrowsePage: mocks.albumPage,
  countAlbumCollections: mocks.albumCount,
  getAlbumCollection: mocks.albumDetail,
}))
import { ServerError } from '@/lib/error'
import { albumCollections, filmCollections } from '../collections'

const app = new Hono()
app.route('/', filmCollections)
app.route('/album-collections', albumCollections)
app.onError((error, c) =>
  error instanceof ServerError
    ? c.json(error.response, error.response.statusCode)
    : c.json({ message: 'Failed' }, 500),
)

describe('film collections API', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.session.mockResolvedValue({
      user: { id: 'user-1', email: 'owner@example.test', role: 'admin' },
      session: { id: 'session-1', userId: 'user-1' },
    })
  })
  it('requires authentication before reading lists or members', async () => {
    mocks.session.mockResolvedValue(null)
    for (const path of ['/', '/browse-page', '/browse-count', '/example'])
      expect((await app.request(path)).status).toBe(401)
    expect(mocks.page).not.toHaveBeenCalled()
    expect(mocks.count).not.toHaveBeenCalled()
    expect(mocks.detail).not.toHaveBeenCalled()
  })
  it('validates the directory query before invoking a service', async () => {
    for (const path of ['/', '/browse-page', '/browse-count'])
      for (const query of [
        'sortBy=source',
        'direction=sideways',
        'page=0',
        'size=101',
        'includeSources=unknown',
        `q=${'x'.repeat(201)}`,
      ])
        expect((await app.request(`${path}?${query}`)).status).toBe(422)
    expect(mocks.page).not.toHaveBeenCalled()
    expect(mocks.count).not.toHaveBeenCalled()
  })
  it('keeps the legacy directory response as a bounded array', async () => {
    mocks.page.mockResolvedValue({
      page: 1,
      size: 100,
      hasMore: true,
      items: [],
    })
    const response = await app.request('/')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: [] })
    expect(mocks.page).toHaveBeenCalledExactlyOnceWith({
      page: 1,
      size: 100,
      direction: 'asc',
      sortBy: 'name',
      includeSources: 'true',
    })
  })
  it('serves directory rows and counts separately using the validated query', async () => {
    const page = { page: 2, size: 15, hasMore: true, items: [] }
    const count = { totalCount: 90 }
    mocks.page.mockResolvedValue(page)
    mocks.count.mockResolvedValue(count)
    const query = '?q=+Fixture+&page=2&size=15&sortBy=filmCount&direction=desc'
    const parsed = {
      q: 'Fixture',
      page: 2,
      size: 15,
      sortBy: 'filmCount',
      direction: 'desc',
    }
    const rowsResponse = await app.request(`/browse-page${query}`)
    expect(rowsResponse.status).toBe(200)
    expect(await rowsResponse.json()).toMatchObject({ data: page })
    expect(mocks.page).toHaveBeenCalledExactlyOnceWith(parsed)
    expect(mocks.count).not.toHaveBeenCalled()

    const countResponse = await app.request(`/browse-count${query}`)
    expect(countResponse.status).toBe(200)
    expect(await countResponse.json()).toMatchObject({ data: count })
    expect(mocks.count).toHaveBeenCalledExactlyOnceWith(parsed)
    expect(mocks.page).toHaveBeenCalledTimes(1)
    expect(mocks.detail).not.toHaveBeenCalled()
  })
  it('validates sort and paging before service calls', async () => {
    for (const query of [
      'sortBy=unknown',
      'direction=sideways',
      'page=0',
      'size=101',
      'watched=unknown',
      'watchedStates=invalid',
      'watchedStates=%5B%22unknown%22%5D',
      'includeSources=unknown',
      `q=${'x'.repeat(201)}`,
    ])
      expect((await app.request(`/example?${query}`)).status).toBe(422)
    expect(mocks.detail).not.toHaveBeenCalled()
  })
  it('passes validated defaults and selected ordering to read-only services', async () => {
    mocks.detail.mockResolvedValue({ id: 'example' })
    expect((await app.request('/example')).status).toBe(200)
    expect(mocks.detail).toHaveBeenLastCalledWith('example', {
      page: 1,
      size: 100,
      sortBy: 'position',
      direction: 'asc',
    })
    expect(
      (
        await app.request(
          '/example?page=2&size=10&sortBy=releaseDate&direction=desc',
        )
      ).status,
    ).toBe(200)
    expect(mocks.detail).toHaveBeenLastCalledWith('example', {
      page: 2,
      size: 10,
      sortBy: 'releaseDate',
      direction: 'desc',
    })
  })
  it('validates multiple watched states', async () => {
    mocks.detail.mockResolvedValue({ id: 'example' })
    const params = new URLSearchParams({
      watchedStates: JSON.stringify(['watched', 'unwatched']),
    })
    expect((await app.request(`/example?${params}`)).status).toBe(200)
    expect(mocks.detail).toHaveBeenCalledWith(
      'example',
      expect.objectContaining({ watchedStates: ['watched', 'unwatched'] }),
    )
  })
  it('keeps missing collection responses as 404', async () => {
    mocks.detail.mockRejectedValue(
      new ServerError({ statusCode: 404, message: 'Collection not found' }),
    )
    expect((await app.request('/missing')).status).toBe(404)
  })
  it('forwards title and watched filters with pagination', async () => {
    mocks.detail.mockResolvedValue({ id: 'example' })
    expect(
      (
        await app.request(
          '/example?q=Film&watched=unwatched&page=2&size=1&includeSources=false',
        )
      ).status,
    ).toBe(200)
    expect(mocks.detail).toHaveBeenCalledExactlyOnceWith('example', {
      q: 'Film',
      watched: 'unwatched',
      page: 2,
      size: 1,
      sortBy: 'position',
      direction: 'asc',
      includeSources: 'false',
    })
  })
})

describe('album collections API', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.session.mockResolvedValue({
      user: { id: 'user-1', email: 'owner@example.test', role: 'admin' },
      session: { id: 'session-1', userId: 'user-1' },
    })
  })

  it('requires authentication for each album collection route', async () => {
    mocks.session.mockResolvedValue(null)
    for (const path of ['browse-page', 'browse-count', 'example'])
      expect((await app.request(`/album-collections/${path}`)).status).toBe(401)
    for (const service of [
      mocks.albumPage,
      mocks.albumCount,
      mocks.albumDetail,
    ])
      expect(service).not.toHaveBeenCalled()
  })

  it('validates album-specific ordering and passes the requested page to the album service', async () => {
    const id = 'example'
    for (const path of [
      'browse-page?sortBy=filmCount',
      'browse-count?size=101',
      `${id}?sortBy=watched`,
    ])
      expect((await app.request(`/album-collections/${path}`)).status).toBe(422)
    for (const service of [
      mocks.albumPage,
      mocks.albumCount,
      mocks.albumDetail,
    ])
      expect(service).not.toHaveBeenCalled()

    const detail = { id, albumCount: 0 }
    mocks.albumDetail.mockResolvedValue(detail)
    const response = await app.request(
      `/album-collections/${id}?sortBy=artists&direction=desc&size=10&page=2&includeSources=false`,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: detail })
    expect(mocks.albumDetail).toHaveBeenCalledExactlyOnceWith(id, {
      sortBy: 'artists',
      direction: 'desc',
      size: 10,
      page: 2,
      includeSources: 'false',
    })
    expect(mocks.detail).not.toHaveBeenCalled()
  })
})
