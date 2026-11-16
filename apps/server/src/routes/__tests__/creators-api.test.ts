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
  selection: vi.fn(),
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
      playlistIds: ['playlist-a', 'playlist-b'],
      freshness: [{ provider: 'spotify', mode: 'never' }],
      provider: 'spotify',
      sortBy: 'lastScrapedAt',
      size: 2,
      page: 1,
      direction: 'asc',
    })
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
