import { afterEach, describe, expect, it, vi } from 'vitest'

const listAlbums = vi.fn()
const listAlbumFilterOptions = vi.fn()

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
    listAlbums,
    listAlbumFilterOptions,
    getAlbumDetail: vi.fn(),
    patchAlbum: vi.fn(),
    listFilms: vi.fn(),
    listFilmFilterOptions: vi.fn(),
    getFilmDetail: vi.fn(),
    patchFilm: vi.fn(),
  }))
}

describe('albums api', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    listAlbums.mockReset()
    listAlbumFilterOptions.mockReset()
  })

  it('returns 401 when album list is unauthenticated', async () => {
    mockAppSession(false)

    const { default: app } = await import('@/app')
    const response = await app.request('http://localhost/api/v1/albums')
    const payload = await response.json()

    expect(response.status).toBe(401)
    expect(payload).toMatchObject({
      statusCode: 401,
      message: 'Unauthorized',
    })
    expect(listAlbums).not.toHaveBeenCalled()
  })

  it('returns 422 when the filters query is invalid', async () => {
    mockAppSession(true)

    const { default: app } = await import('@/app')
    const response = await app.request(
      'http://localhost/api/v1/albums?filters=not-json',
    )

    expect(response.status).toBe(422)
    expect(listAlbums).not.toHaveBeenCalled()
  })

  it('parses filters for the album list route', async () => {
    listAlbums.mockResolvedValue({
      items: [],
      totalCount: 0,
      pageCount: 0,
    })

    mockAppSession(true)

    const filters = encodeURIComponent(
      JSON.stringify([{ field: 'artist', value: 'David Bowie' }]),
    )

    const { default: app } = await import('@/app')
    const response = await app.request(
      `http://localhost/api/v1/albums?page=1&size=24&filters=${filters}`,
    )

    expect(response.status).toBe(200)
    expect(listAlbums).toHaveBeenCalledWith({
      page: 1,
      size: 24,
      q: undefined,
      tag: undefined,
      filters: [{ field: 'artist', value: 'David Bowie' }],
      ranges: [],
      sortBy: 'dateAdded',
      direction: 'desc',
    })
  })

  it('validates listening periods and forwards rules with zero bounds', async () => {
    mockAppSession(true)
    listAlbums.mockResolvedValue({ items: [], totalCount: 0, pageCount: 0 })
    const { default: app } = await import('@/app')
    for (const query of [
      'listening=not-json',
      'listeningSort=not-json',
      new URLSearchParams({
        listening: JSON.stringify({
          match: 'all',
          rules: [{ period: { kind: 'all' } }],
        }),
      }).toString(),
      new URLSearchParams({
        listeningSort: JSON.stringify({ kind: 'dates', from: '2025-02-29' }),
      }).toString(),
    ]) {
      expect((await app.request(`/api/v1/albums?${query}`)).status).toBe(422)
    }
    expect(listAlbums).not.toHaveBeenCalled()
    const listening = {
      match: 'all',
      rules: [
        { period: { kind: 'rolling', amount: 2, unit: 'years' }, max: 0 },
      ],
    }
    const listeningSort = { kind: 'all' }
    const query = new URLSearchParams({
      listening: JSON.stringify(listening),
      listeningSort: JSON.stringify(listeningSort),
      sortBy: 'listeningScrobbles',
    })
    expect((await app.request(`/api/v1/albums?${query}`)).status).toBe(200)
    expect(listAlbums).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        listening,
        listeningSort,
        sortBy: 'listeningScrobbles',
      }),
    )
  })

  it('returns album filter options for an authenticated request', async () => {
    listAlbumFilterOptions.mockResolvedValue([
      {
        field: 'genre',
        value: 'Art Rock',
        label: 'Genre: Art Rock',
        count: 12,
      },
    ])

    mockAppSession(true)

    const { default: app } = await import('@/app')
    const response = await app.request('http://localhost/api/v1/albums/facets')
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      statusCode: 200,
      data: [
        {
          field: 'genre',
          value: 'Art Rock',
        },
      ],
    })
    expect(listAlbumFilterOptions).toHaveBeenCalledExactlyOnceWith({
      limitPerField: 25,
    })
  })

  it('validates and forwards bounded facet searches', async () => {
    mockAppSession(true)
    listAlbumFilterOptions.mockResolvedValue([])
    const { default: app } = await import('@/app')
    expect(
      (
        await app.request(
          '/api/v1/albums/facets?q=rare%20artist&limitPerField=50',
        )
      ).status,
    ).toBe(200)
    expect(listAlbumFilterOptions).toHaveBeenCalledExactlyOnceWith({
      q: 'rare artist',
      limitPerField: 50,
    })
    expect(
      (await app.request(`/api/v1/albums/facets?q=${'x'.repeat(201)}`)).status,
    ).toBe(422)
    expect(
      (await app.request('/api/v1/albums/facets?limitPerField=0')).status,
    ).toBe(422)
    expect(listAlbumFilterOptions).toHaveBeenCalledTimes(1)
  })
})
