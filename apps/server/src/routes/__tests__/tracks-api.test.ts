import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  merge: vi.fn(),
  matchScrobble: vi.fn(),
  addTrack: vi.fn(),
  additions: vi.fn(),
  browsePage: vi.fn(),
  browseCount: vi.fn(),
  histogram: vi.fn(),
  recordingVersions: vi.fn(),
  positions: vi.fn(),
  diagnostics: vi.fn(),
  matchFacets: vi.fn(),
  addTag: vi.fn(),
  removeTag: vi.fn(),
  resetTags: vi.fn(),
}))
vi.mock('@/env', () => ({
  env: {
    TRUSTED_ORIGINS: ['http://localhost:3001'],
    NODE_ENV: 'test',
    OWNER_EMAIL: 'owner@example.com',
  },
}))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.session } } }))
vi.mock('@/services/tracks', () => ({
  getTrackDetail: vi.fn(),
  listTrackBrowsePage: mocks.browsePage,
  listTrackFilterOptions: vi.fn(),
  listTrackRecordingVersions: mocks.recordingVersions,
  listTracks: vi.fn(),
  listTracksAtPositions: mocks.positions,
}))
vi.mock('@/services/browse', () => ({
  listBrowseFields: vi.fn(),
  queryBrowseCounts: mocks.browseCount,
  queryListeningHistogram: mocks.histogram,
}))
vi.mock('@/services/track-match-diagnostics', () => ({
  listTrackMatchDiagnostics: mocks.diagnostics,
  listTrackMatchDiagnosticsFacets: mocks.matchFacets,
}))
vi.mock('@/services/track-merges', () => ({
  matchScrobbleTrack: mocks.matchScrobble,
  mergeLastfmTrack: mocks.merge,
}))
vi.mock('@/services/track-tags', () => ({
  addTrackTag: mocks.addTag,
  removeTrackTag: mocks.removeTag,
  resetTrackTags: mocks.resetTags,
}))
vi.mock('@/services/spotify-track-playlist-additions', () => ({
  queueSpotifyTrackPlaylistAddition: mocks.addTrack,
  listSpotifyTrackPlaylistAdditions: mocks.additions,
}))
import { ServerError } from '@/lib/error'
import tracks from '../tracks'

const app = new Hono()
app.route('/', tracks)
app.onError((error, c) =>
  error instanceof ServerError
    ? c.json(error.response, error.response.statusCode)
    : c.json({ message: 'Failed' }, 500),
)

function send(
  body: unknown,
  origin = 'http://localhost:3001',
  path = '/source/merge',
) {
  return app.request(`http://localhost:4001${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin },
    body: JSON.stringify(body),
  })
}

describe('tracks API', () => {
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

  it('authorizes and validates separate browse page and count requests', async () => {
    for (const path of ['/browse-page', '/browse-count']) {
      mocks.session.mockResolvedValueOnce(null)
      expect((await app.request(path)).status).toBe(401)
      expect((await app.request(`${path}?filters=invalid`)).status).toBe(422)
    }
    expect(mocks.browsePage).not.toHaveBeenCalled()
    expect(mocks.browseCount).not.toHaveBeenCalled()

    const page = { items: [], page: 3, size: 2, hasMore: false }
    const query = '?page=3&size=2&limitResults=4&q=fixture'
    mocks.browsePage.mockResolvedValue(page)
    const response = await app.request(`/browse-page${query}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: page })
    expect(mocks.browsePage).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 3,
        size: 2,
        limitResults: 4,
        q: 'fixture',
      }),
    )
    expect(mocks.browseCount).not.toHaveBeenCalled()

    mocks.browseCount.mockResolvedValueOnce({
      totalCount: 4,
      unfilteredCount: 12,
    })
    const count = await app.request(`/browse-count${query}`)
    expect(count.status).toBe(200)
    expect(await count.json()).toMatchObject({
      data: { totalCount: 4, unfilteredCount: 12 },
    })
    expect(mocks.browseCount).toHaveBeenCalledWith(
      'track',
      expect.objectContaining({ limitResults: 4, q: 'fixture' }),
    )

    mocks.browseCount.mockRejectedValueOnce(
      new ServerError({ statusCode: 503, message: 'Count unavailable' }),
    )
    expect((await app.request(`/browse-count${query}`)).status).toBe(503)
    expect((await app.request(`/browse-page${query}`)).status).toBe(200)
  })

  it('forwards track listening rules and sort periods', async () => {
    const listening = {
      match: 'any',
      rules: [
        { period: { kind: 'rolling', amount: 2, unit: 'years' }, max: 0 },
      ],
    }
    const listeningSort = { kind: 'dates', from: '2025-01-01' }
    for (const query of [
      'listening=not-json',
      new URLSearchParams({
        listening: JSON.stringify({
          match: 'all',
          rules: [{ period: { kind: 'all' } }],
        }),
      }).toString(),
    ])
      expect((await app.request(`/browse-page?${query}`)).status).toBe(422)
    expect(mocks.browsePage).not.toHaveBeenCalled()
    mocks.browsePage.mockResolvedValue({
      items: [],
      page: 1,
      size: 24,
      hasMore: false,
    })
    const query = new URLSearchParams({
      listening: JSON.stringify(listening),
      listeningSort: JSON.stringify(listeningSort),
      sortBy: 'listeningScrobbles',
      groupRecordings: 'true',
    })
    expect((await app.request(`/browse-page?${query}`)).status).toBe(200)
    expect(mocks.browsePage).toHaveBeenCalledWith(
      expect.objectContaining({
        listening,
        listeningSort,
        sortBy: 'listeningScrobbles',
        groupRecordings: true,
      }),
    )
  })

  it('authorizes and validates a listening histogram read', async () => {
    const period = JSON.stringify({ kind: 'all' })
    mocks.session.mockResolvedValueOnce(null)
    expect(
      (await app.request(`/listening-histogram?period=${period}`)).status,
    ).toBe(401)
    for (const query of [
      '',
      'period=not-json',
      `period=${JSON.stringify({ kind: 'rolling', amount: 0, unit: 'days' })}`,
    ])
      expect((await app.request(`/listening-histogram?${query}`)).status).toBe(
        422,
      )
    expect(mocks.histogram).not.toHaveBeenCalled()

    const histogram = {
      edges: [0, 1, 2, 5, 10, 20, 50, 100],
      counts: [3, 0, 1, 0, 0, 0, 0, 1],
    }
    mocks.histogram.mockResolvedValueOnce(histogram)
    const response = await app.request(
      `/listening-histogram?${new URLSearchParams({
        period,
        q: 'fixture',
        groupRecordings: 'true',
      })}`,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: histogram })
    expect(mocks.histogram).toHaveBeenCalledWith(
      'track',
      expect.objectContaining({ q: 'fixture', groupRecordings: true }),
      { kind: 'all' },
    )
  })

  it('authorizes and validates a read of tracks at positions', async () => {
    mocks.session.mockResolvedValueOnce(null)
    expect((await app.request('/positions?positions=1')).status).toBe(401)
    const tooMany = Array.from({ length: 51 }, (_, index) => index).join(',')
    for (const positions of ['', 'one', '1,,2', '-1', '1.5', tooMany])
      expect(
        (await app.request(`/positions?positions=${positions}`)).status,
      ).toBe(422)
    expect((await app.request('/positions')).status).toBe(422)
    expect(mocks.positions).not.toHaveBeenCalled()

    mocks.positions.mockResolvedValue({ items: [] })
    const response = await app.request(
      '/positions?positions=40,3,40&q=fixture&sortBy=artist&direction=asc',
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: { items: [] } })
    expect(mocks.positions).toHaveBeenCalledWith(
      expect.objectContaining({
        positions: [40, 3],
        q: 'fixture',
        sortBy: 'artist',
        direction: 'asc',
      }),
    )
  })

  it('authorizes and validates bounded pages of recording versions', async () => {
    const path = '/fixture-track/recordings'
    mocks.session.mockResolvedValueOnce(null)
    expect((await app.request(path)).status).toBe(401)
    expect((await app.request(`${path}?size=101`)).status).toBe(422)
    expect((await app.request(`${path}?filters=invalid`)).status).toBe(422)
    expect(mocks.recordingVersions).not.toHaveBeenCalled()

    const page = { items: [], page: 2, size: 20, hasMore: false }
    mocks.recordingVersions.mockResolvedValueOnce(page)
    const response = await app.request(
      `${path}?page=2&size=20&q=fixture&groupRecordings=true`,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: page })
    expect(mocks.recordingVersions).toHaveBeenCalledWith(
      'fixture-track',
      expect.objectContaining({
        page: 2,
        size: 20,
        q: 'fixture',
        groupRecordings: true,
      }),
    )
  })

  it('validates owner-only match diagnostics before reading stored identities', async () => {
    mocks.session.mockResolvedValueOnce(null)
    expect((await app.request('/match-diagnostics')).status).toBe(401)
    expect((await app.request('/match-diagnostics?size=101')).status).toBe(422)
    expect(mocks.diagnostics).not.toHaveBeenCalled()
    mocks.diagnostics.mockResolvedValueOnce({
      items: [],
      providers: [],
      totalCount: 0,
      pageCount: 0,
    })
    expect(
      (await app.request('/match-diagnostics?q=fixture&sortBy=lastfm')).status,
    ).toBe(200)
    expect(mocks.diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'fixture', sortBy: 'lastfm' }),
      'user-1',
    )
  })

  it('exposes match-specific fields, bounded facets and combined track filters', async () => {
    for (const path of [
      '/match-diagnostics/fields',
      '/match-diagnostics/facets',
    ]) {
      mocks.session.mockResolvedValueOnce(null)
      expect((await app.request(path)).status).toBe(401)
    }
    const fields = await app.request('/match-diagnostics/fields')
    expect(await fields.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ key: 'matchProvider' }),
        expect.objectContaining({ key: 'scrobbles' }),
      ]),
    })
    expect(
      (await app.request('/match-diagnostics/facets?limitPerField=90')).status,
    ).toBe(422)
    mocks.matchFacets.mockResolvedValueOnce([])
    expect(
      (await app.request('/match-diagnostics/facets?q=artist')).status,
    ).toBe(200)
    expect(mocks.matchFacets).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'artist' }),
    )
    const filters = [
      { field: 'matchProvider', value: 'Spotify', mode: 'exclude' },
    ]
    const ranges = [{ field: 'scrobbles', min: 1, includeMissing: false }]
    mocks.diagnostics.mockResolvedValueOnce({
      items: [],
      providers: [],
      totalCount: 0,
      pageCount: 0,
    })
    const params = new URLSearchParams({
      filters: JSON.stringify(filters),
      ranges: JSON.stringify(ranges),
    })
    expect((await app.request(`/match-diagnostics?${params}`)).status).toBe(200)
    expect(mocks.diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ filters, ranges }),
      'user-1',
    )
  })

  it('requires owner authentication before merging', async () => {
    mocks.session.mockResolvedValue(null)
    expect((await send({ targetId: 'target' })).status).toBe(401)
    mocks.session.mockResolvedValue({
      user: { id: 'user-2', email: 'guest@example.com', role: 'user' },
      session: { id: 'session-2', userId: 'user-2' },
    })
    expect((await send({ targetId: 'target' })).status).toBe(403)
    expect(mocks.merge).not.toHaveBeenCalled()
  })

  it('authorizes and validates a correction of one stored Last.fm name', async () => {
    const path = '/source/scrobble-match'
    const origin = 'http://localhost:3001'
    const input = {
      artistKey: 'example artist',
      trackKey: 'example track',
      targetId: 'target',
    }
    for (const body of [
      {},
      { ...input, artistKey: '' },
      { ...input, trackKey: ' ' },
      { ...input, username: 'different-account' },
    ])
      expect((await send(body, origin, path)).status).toBe(422)
    expect((await send(input, 'https://evil.invalid', path)).status).toBe(403)
    mocks.session.mockResolvedValueOnce(null)
    expect((await send(input, origin, path)).status).toBe(401)
    mocks.session.mockResolvedValueOnce({
      user: { id: 'user-2', email: 'guest@example.com', role: 'user' },
      session: { id: 'session-2', userId: 'user-2' },
    })
    expect((await send(input, origin, path)).status).toBe(403)
    expect(mocks.matchScrobble).not.toHaveBeenCalled()

    mocks.matchScrobble.mockResolvedValueOnce({ targetId: 'target' })
    const response = await send(input, origin, path)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: { targetId: 'target' },
    })
    expect(mocks.matchScrobble).toHaveBeenCalledExactlyOnceWith('source', input)
  })

  it('authorizes and validates track tag edits before calling the service (TTAG-12)', async () => {
    const origin = 'http://localhost:3001'
    const edit = (
      method: 'POST' | 'DELETE',
      body: unknown,
      path = '/track-1/tags',
      from = origin,
    ) =>
      app.request(`http://localhost:4001${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', origin: from },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    for (const method of ['POST', 'DELETE'] as const) {
      for (const body of [
        {},
        { tagId: '' },
        { tagId: 1 },
        { tagId: 'tag-1', owner: 'added' },
      ])
        expect((await edit(method, body)).status).toBe(422)
      expect(
        (
          await edit(
            method,
            { tagId: 'tag-1' },
            '/track-1/tags',
            'https://evil.invalid',
          )
        ).status,
      ).toBe(403)
      mocks.session.mockResolvedValueOnce(null)
      expect((await edit(method, { tagId: 'tag-1' })).status).toBe(401)
    }
    mocks.session.mockResolvedValueOnce({
      user: { id: 'user-2', email: 'guest@example.com', role: 'user' },
      session: { id: 'session-2', userId: 'user-2' },
    })
    expect((await edit('POST', undefined, '/track-1/tags/reset')).status).toBe(
      403,
    )
    expect(mocks.addTag).not.toHaveBeenCalled()
    expect(mocks.removeTag).not.toHaveBeenCalled()
    expect(mocks.resetTags).not.toHaveBeenCalled()

    mocks.addTag.mockResolvedValueOnce({ tagId: 'tag-1', changed: true })
    const added = await edit('POST', { tagId: ' tag-alias ' })
    expect(added.status).toBe(200)
    expect(await added.json()).toMatchObject({
      data: { tagId: 'tag-1', changed: true },
    })
    expect(mocks.addTag).toHaveBeenCalledExactlyOnceWith('track-1', 'tag-alias')
    mocks.removeTag.mockResolvedValueOnce({ tagId: 'tag-1', changed: false })
    expect((await edit('DELETE', { tagId: 'tag-1' })).status).toBe(200)
    expect(mocks.removeTag).toHaveBeenCalledExactlyOnceWith('track-1', 'tag-1')
    mocks.resetTags.mockResolvedValueOnce({ changed: 2 })
    const reset = await edit('POST', undefined, '/track-1/tags/reset')
    expect(await reset.json()).toMatchObject({ data: { changed: 2 } })
    expect(mocks.resetTags).toHaveBeenCalledExactlyOnceWith('track-1')
    mocks.addTag.mockRejectedValueOnce(
      new ServerError({ statusCode: 404, message: 'Tag not found' }),
    )
    expect((await edit('POST', { tagId: 'missing' })).status).toBe(404)
  })

  it('rejects invalid input and cross-origin requests before service work', async () => {
    for (const body of [
      {},
      { targetId: '' },
      { targetId: 1 },
      { targetId: 'target', sourceId: 'other' },
    ])
      expect((await send(body)).status).toBe(422)
    expect(
      (await send({ targetId: 'target' }, 'https://evil.invalid')).status,
    ).toBe(403)
    expect(mocks.merge).not.toHaveBeenCalled()
  })

  it('returns the selected target and forwards service conflicts', async () => {
    mocks.merge.mockResolvedValue({ targetId: 'target' })
    const response = await send({ targetId: 'target' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: { targetId: 'target' },
    })
    expect(mocks.merge).toHaveBeenCalledExactlyOnceWith('source', {
      targetId: 'target',
    })
    mocks.merge.mockRejectedValue(
      new ServerError({ statusCode: 409, message: 'Tracks cannot be merged' }),
    )
    expect((await send({ targetId: 'target' })).status).toBe(409)
  })

  it('authorizes and validates track playlist additions before queueing', async () => {
    const path = '/source/playlist-additions'
    for (const body of [
      {},
      { playlistId: '' },
      { playlistId: 'p', trackId: 'other' },
    ])
      expect((await send(body, 'http://localhost:3001', path)).status).toBe(422)
    expect(
      (await send({ playlistId: 'p' }, 'https://evil.invalid', path)).status,
    ).toBe(403)
    mocks.session.mockResolvedValue(null)
    expect(
      (await send({ playlistId: 'p' }, 'http://localhost:3001', path)).status,
    ).toBe(401)
    expect(
      (await app.request('http://localhost:4001/source/playlist-additions'))
        .status,
    ).toBe(401)
    expect(mocks.addTrack).not.toHaveBeenCalled()
    expect(mocks.additions).not.toHaveBeenCalled()
  })

  it('returns queued track additions and their stored statuses', async () => {
    const addition = {
      trackId: 'source',
      resolvedTrackId: 'source',
      playlistId: 'p',
      job: {
        jobId: 'job',
        status: 'queued',
        errorMessage: null,
        finishedAt: null,
        progress: null,
      },
    }
    mocks.addTrack.mockResolvedValue(addition)
    mocks.additions.mockResolvedValue({ additions: [addition] })
    const queued = await send(
      { playlistId: 'p' },
      'http://localhost:3001',
      '/source/playlist-additions',
    )
    expect(queued.status).toBe(200)
    expect(await queued.json()).toMatchObject({ data: addition })
    expect(mocks.addTrack).toHaveBeenCalledExactlyOnceWith(
      'source',
      { playlistId: 'p' },
      'user-1',
    )
    const listed = await app.request(
      'http://localhost:4001/source/playlist-additions',
    )
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({
      data: { additions: [addition] },
    })
    expect(mocks.additions).toHaveBeenCalledExactlyOnceWith('source')
  })
})
