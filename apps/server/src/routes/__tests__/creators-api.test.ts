import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  enqueue: vi.fn(),
  artist: vi.fn(),
  history: vi.fn(),
  person: vi.fn(),
  albums: vi.fn(),
  playlists: vi.fn(),
  artists: vi.fn(),
  metadata: vi.fn(),
  browse: vi.fn(),
  count: vi.fn(),
  facets: vi.fn(),
  metadataBrowse: vi.fn(),
  selection: vi.fn(),
  createSnapshot: vi.fn(),
  listSnapshotPage: vi.fn(),
  tracks: vi.fn(),
  people: vi.fn(),
  films: vi.fn(),
}))
vi.mock('@/env', () => ({ env: { NODE_ENV: 'test' } }))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.session } } }))
vi.mock('@/services/artist-enrichment', () => ({
  enqueueArtistEnrichment: mocks.enqueue,
}))
vi.mock('@/services/artist-selection', () => ({
  queueArtistSelection: mocks.selection,
}))
vi.mock('@/services/artist-bulk-selection', () => ({
  createArtistSelectionSnapshot: mocks.createSnapshot,
  listArtistSelectionSnapshotPage: mocks.listSnapshotPage,
}))
vi.mock('@/services/artist-browse', () => ({
  listArtistBrowsePage: mocks.browse,
  countArtistBrowse: mocks.count,
  listArtistBrowseFacets: mocks.facets,
  listArtistMetadataBrowsePage: mocks.metadataBrowse,
}))
vi.mock('@/services/creators', () => ({
  getArtist: mocks.artist,
  getArtistHistory: mocks.history,
  getPerson: mocks.person,
  listArtistAlbums: mocks.albums,
  listArtistPlaylists: mocks.playlists,
  listArtists: mocks.artists,
  listArtistMetadata: mocks.metadata,
  listArtistTracks: mocks.tracks,
  listPeople: mocks.people,
  listPersonFilms: mocks.films,
}))
import { artists, people } from '../creators'
import { ServerError } from '@/lib/error'

const app = new Hono().route('/artists', artists).route('/people', people)
app.onError((error, c) =>
  error instanceof ServerError
    ? c.json(error.response, error.response.statusCode)
    : c.json({ message: 'Failed' }, 500),
)

function enqueue(body: unknown) {
  return app.request('/artists/fixture/enrichment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function createSelection(body: unknown) {
  return app.request('/artists/metadata/selections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('creator API', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.session.mockResolvedValue({
      user: { id: 'user-1', email: 'owner@example.test', role: 'admin' },
      session: { id: 'session-1', userId: 'user-1' },
    })
  })

  it('authenticates both directories, related pages, and enrichment', async () => {
    mocks.session.mockResolvedValue(null)
    for (const path of [
      '/artists',
      '/artists/metadata',
      '/artists/fields',
      '/artists/facets',
      '/artists/browse-page',
      '/artists/browse-count',
      '/artists/metadata/browse-page',
      '/artists/metadata/browse-count',
      '/artists/metadata/selections/fixture-selection',
      '/artists/fixture',
      '/artists/fixture/albums',
      '/artists/fixture/tracks',
      '/artists/fixture/playlists',
      '/artists/fixture/history',
      '/people',
      '/people/fixture',
      '/people/fixture/films',
    ])
      expect((await app.request(path)).status).toBe(401)
    expect((await enqueue({ provider: 'spotify' })).status).toBe(401)
    expect((await createSelection({ query: {} })).status).toBe(401)
    expect(
      (
        await app.request('/artists/enrichment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            artistIds: ['fixture'],
            providers: ['spotify'],
          }),
        })
      ).status,
    ).toBe(401)
    for (const mock of Object.values(mocks).filter(
      (mock) => mock !== mocks.session,
    ))
      expect(mock).not.toHaveBeenCalled()
  })

  it('validates metadata filters and routes the directory before artist IDs', async () => {
    for (const query of [
      'sortBy=lastScrapedAt',
      'provider=youtube',
      'playlistIds=invalid',
      `freshness=${encodeURIComponent(JSON.stringify([{ provider: 'youtube', mode: 'never' }]))}`,
    ])
      expect((await app.request(`/artists/metadata?${query}`)).status).toBe(422)
    mocks.metadata.mockResolvedValue({ items: [] })
    const params = new URLSearchParams({
      playlistIds: JSON.stringify(['playlist-a', 'playlist-b']),
      freshness: JSON.stringify([{ provider: 'spotify', mode: 'never' }]),
      provider: 'spotify',
      sortBy: 'lastScrapedAt',
      size: '2',
    })
    expect((await app.request(`/artists/metadata?${params}`)).status).toBe(200)
    expect(mocks.artist).not.toHaveBeenCalled()
    expect(mocks.metadata).toHaveBeenCalledExactlyOnceWith({
      filters: [],
      ranges: [],
      playlistIds: ['playlist-a', 'playlist-b'],
      freshness: [{ provider: 'spotify', mode: 'never' }],
      provider: 'spotify',
      sortBy: 'lastScrapedAt',
      size: 2,
      page: 1,
      direction: 'asc',
    })
  })

  it('validates shared artist search and routes split pages before artist IDs', async () => {
    mocks.browse.mockResolvedValue({
      items: [],
      page: 1,
      size: 50,
      hasMore: false,
    })
    mocks.metadataBrowse.mockResolvedValue({
      items: [],
      page: 1,
      size: 50,
      hasMore: false,
    })
    mocks.count.mockResolvedValue({ totalCount: 0 })
    mocks.facets.mockResolvedValue([])
    for (const path of [
      '/fields',
      '/facets',
      '/browse-page',
      '/browse-count',
      '/metadata/browse-page',
      '/metadata/browse-count',
    ])
      expect((await app.request('/artists' + path)).status).toBe(200)
    expect(mocks.artist).not.toHaveBeenCalled()
    for (const path of [
      '/browse-page',
      '/browse-count',
      '/metadata/browse-page',
      '/metadata/browse-count',
    ]) {
      for (const input of [
        { filters: [{ field: 'watched', value: 'yes' }] },
        { ranges: [{ field: 'rating', min: 1 }] },
        { limitResults: 0 },
        { sortBy: 'watched' },
      ]) {
        const params = new URLSearchParams(
          Object.entries(input).map(([key, value]) => [
            key,
            typeof value === 'object' ? JSON.stringify(value) : String(value),
          ]),
        )
        expect(
          (await app.request('/artists' + path + '?' + params)).status,
        ).toBe(422)
      }
    }
    const filters = [
      { field: 'playlist', value: 'Fixture favorites', mode: 'required' },
    ]
    const ranges = [{ field: 'albumCount', min: 2, includeMissing: false }]
    const params = new URLSearchParams({
      filters: JSON.stringify(filters),
      ranges: JSON.stringify(ranges),
      limitResults: '10',
    })
    expect((await app.request('/artists/browse-page?' + params)).status).toBe(
      200,
    )
    expect(mocks.browse).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters, ranges, limitResults: 10 }),
    )
  })

  it('requires bounded explicit artist and provider selections', async () => {
    const request = (body: unknown) =>
      app.request('/artists/enrichment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    for (const body of [
      { artistIds: [], providers: ['spotify'] },
      { artistIds: ['fixture'], providers: ['youtube'] },
      {
        artistIds: Array.from({ length: 101 }, (_, i) => `artist-${i}`),
        providers: ['spotify'],
      },
      { artistIds: ['fixture'], providers: ['spotify'], all: true },
    ])
      expect((await request(body)).status).toBe(422)
    expect(mocks.selection).not.toHaveBeenCalled()
    mocks.selection.mockResolvedValue({ jobs: [], skipped: [] })
    expect(
      (await request({ artistIds: ['fixture'], providers: ['spotify'] }))
        .status,
    ).toBe(200)
    expect(mocks.selection).toHaveBeenCalledExactlyOnceWith(
      {
        artistIds: ['fixture'],
        providers: ['spotify'],
        confirmBroadRun: false,
      },
      'user-1',
    )
  })

  it('validates artist selection snapshot requests and binds them to the owner', async () => {
    for (const body of [
      {},
      { query: { sortBy: 'lastScrapedAt' } },
      { query: { ranges: [{ field: 'rating', min: 1 }] } },
      { query: {}, providers: ['spotify'] },
    ])
      expect((await createSelection(body)).status).toBe(422)
    expect(mocks.createSnapshot).not.toHaveBeenCalled()
    const snapshot = {
      id: 'fixture-selection',
      totalCount: 200,
      expiresAt: '2027-01-01T00:00:00.000Z',
    }
    mocks.createSnapshot.mockResolvedValue(snapshot)
    const created = await createSelection({
      query: { playlistIds: ['fixture'] },
    })
    expect(created.status).toBe(200)
    expect(await created.json()).toMatchObject({ data: snapshot })
    expect(mocks.createSnapshot).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ playlistIds: ['fixture'] }),
      'user-1',
    )

    const path = '/artists/metadata/selections/fixture-selection'
    expect((await app.request(`${path}?size=101`)).status).toBe(422)
    expect((await app.request(`${path}?ids=invalid`)).status).toBe(422)
    const ids = ['artist-2', 'artist-3']
    const query = new URLSearchParams({ ids: JSON.stringify(ids) })
    expect((await app.request(`${path}?after=artist-1&${query}`)).status).toBe(
      422,
    )
    expect(mocks.listSnapshotPage).not.toHaveBeenCalled()
    const page = {
      ids: ['artist-2'],
      nextCursor: 'artist-2',
      totalCount: snapshot.totalCount,
      expiresAt: snapshot.expiresAt,
    }
    mocks.listSnapshotPage.mockResolvedValue(page)
    const read = await app.request(`${path}?after=artist-1&size=1`)
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ data: page })
    expect(mocks.listSnapshotPage).toHaveBeenCalledExactlyOnceWith(
      'fixture-selection',
      { after: 'artist-1', size: 1 },
      'user-1',
    )
    const intersection = { ...page, nextCursor: null }
    mocks.listSnapshotPage.mockResolvedValue(intersection)
    const selected = await app.request(`${path}?${query}`)
    expect(selected.status).toBe(200)
    expect(await selected.json()).toMatchObject({ data: intersection })
    expect(mocks.listSnapshotPage).toHaveBeenLastCalledWith(
      'fixture-selection',
      { ids, size: 100 },
      'user-1',
    )
    expect(mocks.selection).not.toHaveBeenCalled()
  })

  it('validates the film role and uses scoped directory query defaults', async () => {
    expect(
      (await app.request('/people/fixture/films?role=writer')).status,
    ).toBe(422)
    expect(mocks.films).not.toHaveBeenCalled()
    mocks.films.mockResolvedValue({ items: [] })
    expect(
      (await app.request('/people/fixture/films?role=director&size=3')).status,
    ).toBe(200)
    expect(mocks.films).toHaveBeenCalledWith('fixture', {
      role: 'director',
      page: 1,
      size: 3,
      sortBy: 'title',
      direction: 'asc',
    })
  })

  it('queues only a single provider for the selected artist and owner', async () => {
    for (const body of [
      { provider: 'youtube' },
      { provider: 'spotify', force: true },
    ])
      expect((await enqueue(body)).status).toBe(422)
    expect(mocks.enqueue).not.toHaveBeenCalled()
    mocks.enqueue.mockResolvedValue({ id: 'fixture-job' })
    expect(
      (
        await enqueue({
          provider: 'spotify',
          providerArtistId: ' fixture-provider-id ',
        })
      ).status,
    ).toBe(200)
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith(
      {
        artistId: 'fixture',
        provider: 'spotify',
        providerArtistId: 'fixture-provider-id',
      },
      'user-1',
    )
  })
})
