import { afterEach, describe, expect, it, vi } from 'vitest'

const listAlbums = vi.fn()
const listAlbumFilterOptions = vi.fn()
const listMediaMatchDiagnostics = vi.fn()
const rejectAlbumMatch = vi.fn()
const listAlbumMatchRejections = vi.fn()
const correctAlbumMetacriticMatch = vi.fn()

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
  vi.doMock('@/services/media-match-diagnostics', () => ({
    listMediaMatchDiagnostics,
  }))
  vi.doMock('@/services/album-match-rejections', () => ({
    rejectAlbumMatch,
    listAlbumMatchRejections,
  }))
  vi.doMock('@/services/album-metacritic-corrections', () => ({
    correctAlbumMetacriticMatch,
  }))
}

describe('albums api', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    listAlbums.mockReset()
    listAlbumFilterOptions.mockReset()
    listMediaMatchDiagnostics.mockReset()
    rejectAlbumMatch.mockReset()
    listAlbumMatchRejections.mockReset()
    correctAlbumMetacriticMatch.mockReset()
  })

  const rejectionEndpoint = '/api/v1/albums/album-fixture/match-rejections'
  const rejectionTarget = {
    provider: 'google-custom-search',
    sourceProvider: 'legacy-browser',
    snapshotId: 'snapshot-fixture',
    referenceType: 'rym-url',
    identifier: 'https://rateyourmusic.com/release/album/fixture/record/',
  }

  function rejectRequest(body: object) {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  }

  it('requires authorization and an observed Metacritic release URL for a correction', async () => {
    const endpoint = '/api/v1/albums/album-fixture/metacritic-correction'
    const url = 'https://www.metacritic.com/music/fixture-record'
    const correction = {
      rejected: {
        ...rejectionTarget,
        referenceType: 'metacritic-url',
        identifier: 'https://www.metacritic.com/music/rejected-record',
      },
      replacement: { url, title: 'Fixture Record', artist: 'Fixture Artist' },
      evidence: [
        {
          source: 'wikidata',
          sourceUrl: 'https://www.wikidata.org/wiki/Q42',
          observedUrl: url,
          observedAt: '2025-01-01T00:00:00Z',
        },
      ],
    }
    mockAppSession(false)
    const { default: unauthenticated } = await import('@/app')
    expect(
      (await unauthenticated.request(endpoint, rejectRequest(correction)))
        .status,
    ).toBe(401)
    vi.resetModules()
    mockAppSession(true)
    const { default: app } = await import('@/app')
    expect(
      (
        await app.request(
          endpoint,
          rejectRequest({
            ...correction,
            replacement: {
              ...correction.replacement,
              url: 'https://metacritic.com.example.test/music/fixture-record',
            },
          }),
        )
      ).status,
    ).toBe(422)
    expect(
      (
        await app.request(
          endpoint,
          rejectRequest({
            ...correction,
            evidence: [
              {
                ...correction.evidence[0],
                observedUrl:
                  'https://www.metacritic.com/music/different-record',
              },
            ],
          }),
        )
      ).status,
    ).toBe(422)
    expect(correctAlbumMetacriticMatch).not.toHaveBeenCalled()
    correctAlbumMetacriticMatch.mockResolvedValue({
      snapshotId: 'fixture-corrected',
      url,
    })
    expect(
      (await app.request(endpoint, rejectRequest(correction))).status,
    ).toBe(200)
    expect(correctAlbumMetacriticMatch).toHaveBeenCalledExactlyOnceWith(
      'album-fixture',
      correction,
      'user-1',
    )
  })

  it('requires authentication to record or review album match rejections', async () => {
    mockAppSession(false)
    const { default: app } = await import('@/app')
    expect((await app.request(rejectionEndpoint)).status).toBe(401)
    expect(
      (await app.request(rejectionEndpoint, rejectRequest(rejectionTarget)))
        .status,
    ).toBe(401)
    expect(rejectAlbumMatch).not.toHaveBeenCalled()
    expect(listAlbumMatchRejections).not.toHaveBeenCalled()
  })

  it('validates and records the selected match and reads the requested history page', async () => {
    mockAppSession(true)
    const rejected = { ...rejectionTarget, rejectedAt: '2025-01-01T00:00:00Z' }
    const page = {
      items: [rejected],
      totalCount: 6,
      page: 2,
      size: 5,
      pageCount: 2,
    }
    rejectAlbumMatch.mockResolvedValue(rejected)
    listAlbumMatchRejections.mockResolvedValue(page)
    const { default: app } = await import('@/app')

    expect(
      (await app.request(rejectionEndpoint, rejectRequest({}))).status,
    ).toBe(422)
    const response = await app.request(
      rejectionEndpoint,
      rejectRequest(rejectionTarget),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: rejected })
    expect(rejectAlbumMatch).toHaveBeenCalledExactlyOnceWith(
      'album-fixture',
      rejectionTarget,
      'user-1',
    )

    const history = await app.request(`${rejectionEndpoint}?page=2&size=5`)
    expect(history.status).toBe(200)
    expect(await history.json()).toMatchObject({ data: page })
    expect(listAlbumMatchRejections).toHaveBeenCalledExactlyOnceWith(
      'album-fixture',
      { page: 2, size: 5 },
    )
  })

  it('requires authentication to read stored matches', async () => {
    mockAppSession(false)
    const { default: app } = await import('@/app')
    expect((await app.request('/api/v1/albums/match-diagnostics')).status).toBe(
      401,
    )
    expect((await app.request('/api/v1/films/match-diagnostics')).status).toBe(
      401,
    )
    expect(listMediaMatchDiagnostics).not.toHaveBeenCalled()
  })

  it.each([
    ['albums', 'album'],
    ['films', 'film'],
  ])(
    'validates and scopes the diagnostics query for %s',
    async (path, kind) => {
      mockAppSession(true)
      const page = { providers: [], items: [], totalCount: 0, pageCount: 0 }
      listMediaMatchDiagnostics.mockResolvedValue(page)
      const { default: app } = await import('@/app')
      const endpoint = `/api/v1/${path}/match-diagnostics`
      expect((await app.request(`${endpoint}?size=101`)).status).toBe(422)

      const response = await app.request(
        `${endpoint}?q=Example&sortBy=creator&direction=desc&page=3&size=20`,
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ data: page })
      expect(listMediaMatchDiagnostics).toHaveBeenCalledExactlyOnceWith(kind, {
        q: 'Example',
        sortBy: 'creator',
        direction: 'desc',
        page: 3,
        size: 20,
      })
    },
  )

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

  it('validates the album listening histogram period and forwards the query', async () => {
    mockAppSession(true)
    const histogram = {
      edges: [0, 1, 5, 10, 20, 50, 100, 200],
      counts: [2, 0, 1, 0, 0, 0, 0, 0],
    }
    const queryListeningHistogram = vi.fn().mockResolvedValue(histogram)
    vi.doMock('@/services/browse', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/services/browse')>()),
      queryListeningHistogram,
    }))
    const { default: app } = await import('@/app')
    for (const query of [
      '',
      'period=not-json',
      new URLSearchParams({
        period: JSON.stringify({ kind: 'dates' }),
      }).toString(),
    ])
      expect(
        (await app.request(`/api/v1/albums/listening-histogram?${query}`))
          .status,
      ).toBe(422)
    expect(queryListeningHistogram).not.toHaveBeenCalled()
    const listening = {
      match: 'all',
      rules: [{ period: { kind: 'all' }, max: 0 }],
    }
    const response = await app.request(
      `/api/v1/albums/listening-histogram?${new URLSearchParams({
        period: JSON.stringify({ kind: 'rolling', amount: 1, unit: 'years' }),
        listening: JSON.stringify(listening),
        q: 'fixture',
      })}`,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: histogram })
    expect(queryListeningHistogram).toHaveBeenCalledExactlyOnceWith(
      'album',
      expect.objectContaining({ q: 'fixture', listening }),
      { kind: 'rolling', amount: 1, unit: 'years' },
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
