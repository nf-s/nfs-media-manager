import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  merge: vi.fn(),
  addTrack: vi.fn(),
  additions: vi.fn(),
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
  listTrackFilterOptions: vi.fn(),
  listTracks: vi.fn(),
}))
vi.mock('@/services/browse', () => ({ listBrowseFields: vi.fn() }))
vi.mock('@/services/track-merges', () => ({ mergeLastfmTrack: mocks.merge }))
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
