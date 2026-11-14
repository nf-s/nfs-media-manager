import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  list: vi.fn(),
  detail: vi.fn(),
}))
vi.mock('@/env', () => ({ env: { NODE_ENV: 'test' } }))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.session } } }))
vi.mock('@/services/film-collections', () => ({
  listFilmCollections: mocks.list,
  getFilmCollection: mocks.detail,
}))
import { ServerError } from '@/lib/error'
import collections from '../film-collections'

const app = new Hono()
app.route('/', collections)
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
    for (const path of ['/', '/example'])
      expect((await app.request(path)).status).toBe(401)
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.detail).not.toHaveBeenCalled()
  })
  it('validates sort and paging before service calls', async () => {
    for (const query of [
      'sortBy=unknown',
      'direction=sideways',
      'page=0',
      'size=101',
    ])
      expect((await app.request(`/example?${query}`)).status).toBe(422)
    expect(mocks.detail).not.toHaveBeenCalled()
  })
  it('passes validated defaults and selected ordering to read-only services', async () => {
    mocks.list.mockResolvedValue([])
    expect((await app.request('/')).status).toBe(200)
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
  it('keeps missing collection responses as 404', async () => {
    mocks.detail.mockRejectedValue(
      new ServerError({ statusCode: 404, message: 'Collection not found' }),
    )
    expect((await app.request('/missing')).status).toBe(404)
  })
})
