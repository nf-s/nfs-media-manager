import { afterEach, describe, expect, it, vi } from 'vitest'

const listFilms = vi.fn()
const listFilmFilterOptions = vi.fn()

function mockAppSession(authenticated: boolean) {
  vi.doMock('@/env', () => ({
    env: {
      TRUSTED_ORIGINS: ['http://localhost:3000'],
      NODE_ENV: 'test',
    },
  }))

  vi.doMock('@/lib/db', () => ({
    db: {},
  }))

  vi.doMock('@/lib/auth', () => ({
    auth: {
      api: {
        getSession: vi.fn().mockResolvedValue(
          authenticated
            ? {
                user: {
                  id: 'user-1',
                  email: 'admin@example.com',
                  name: 'Admin',
                },
                session: {
                  id: 'session-1',
                  userId: 'user-1',
                },
              }
            : null,
        ),
      },
      handler: vi.fn(),
    },
  }))

  vi.doMock('@/services/media', () => ({
    listAlbums: vi.fn(),
    listAlbumFilterOptions: vi.fn(),
    getAlbumDetail: vi.fn(),
    patchAlbum: vi.fn(),
    listFilms,
    listFilmFilterOptions,
    getFilmDetail: vi.fn(),
    patchFilm: vi.fn(),
  }))
}

describe('films api', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    listFilms.mockReset()
    listFilmFilterOptions.mockReset()
  })

  it('returns 401 when film facets are unauthenticated', async () => {
    mockAppSession(false)

    const { default: app } = await import('@/app')
    const response = await app.request('http://localhost/api/v1/films/facets')
    const payload = await response.json()

    expect(response.status).toBe(401)
    expect(payload).toMatchObject({
      statusCode: 401,
      message: 'Unauthorized',
    })
    expect(listFilmFilterOptions).not.toHaveBeenCalled()
  })

  it('returns 422 when the film filters query is invalid', async () => {
    mockAppSession(true)

    const { default: app } = await import('@/app')
    const response = await app.request(
      'http://localhost/api/v1/films?filters=still-not-json',
    )

    expect(response.status).toBe(422)
    expect(listFilms).not.toHaveBeenCalled()
  })

  it('parses film filters for the list route', async () => {
    listFilms.mockResolvedValue({
      items: [],
      totalCount: 0,
      pageCount: 0,
    })

    mockAppSession(true)

    const filters = encodeURIComponent(
      JSON.stringify([{ field: 'source', value: 'imdb-rating' }]),
    )

    const { default: app } = await import('@/app')
    const response = await app.request(
      `http://localhost/api/v1/films?page=1&size=24&filters=${filters}`,
    )

    expect(response.status).toBe(200)
    expect(listFilms).toHaveBeenCalledWith({
      page: 1,
      size: 24,
      q: undefined,
      tag: undefined,
      sourceKind: undefined,
      filters: [{ field: 'source', value: 'imdb-rating' }],
      ranges: [],
      sortBy: 'releaseDate',
      direction: 'desc',
    })
  })

  it('returns film filter options for an authenticated request', async () => {
    listFilmFilterOptions.mockResolvedValue([
      {
        field: 'source',
        value: 'imdb-watchlist',
        label: 'Source: IMDb Watchlist',
        count: 904,
      },
    ])

    mockAppSession(true)

    const { default: app } = await import('@/app')
    const response = await app.request('http://localhost/api/v1/films/facets')
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      statusCode: 200,
      data: [
        {
          field: 'source',
          value: 'imdb-watchlist',
        },
      ],
    })
    expect(listFilmFilterOptions).toHaveBeenCalledTimes(1)
  })
})
