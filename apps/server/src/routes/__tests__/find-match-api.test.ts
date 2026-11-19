import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  search: vi.fn(),
  unresolved: vi.fn(),
  preview: vi.fn(),
}))
vi.mock('@/env', () => ({
  env: {
    TRUSTED_ORIGINS: ['http://localhost:3001'],
    APP_URL: 'http://localhost:3001',
  },
}))
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.session } } }))
vi.mock('@/services/find-match', () => ({
  searchMatchCandidates: mocks.search,
  listUnresolvedMatches: mocks.unresolved,
}))
vi.mock('@/services/album-candidate-preview', () => ({
  previewAlbumCandidate: mocks.preview,
}))
import { ServerError } from '@/lib/error'
import findMatch from '../find-match'

function post(body: unknown, origin = 'http://localhost:3001') {
  return new Request('http://localhost:4001/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin },
    body: JSON.stringify(body),
  })
}

describe('find match API', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.session.mockResolvedValue({
      user: { id: 'owner', email: 'owner@example.com', role: 'admin' },
      session: { id: 'session', userId: 'owner' },
    })
  })

  it('requires an authenticated owner and a trusted mutation origin', async () => {
    mocks.session.mockResolvedValue(null)
    const input = { kind: 'album', id: 'album-1', provider: 'discogs' }
    expect((await findMatch.request(post(input))).status).toBe(401)
    expect(
      (await findMatch.request('/unresolved?kind=album&id=album-1')).status,
    ).toBe(401)
    mocks.session.mockResolvedValue({
      user: { id: 'owner', email: 'owner@example.com', role: 'admin' },
      session: { id: 'session', userId: 'owner' },
    })
    expect(
      (await findMatch.request(post(input, 'https://untrusted.invalid')))
        .status,
    ).toBe(403)
    expect(mocks.search).not.toHaveBeenCalled()
    expect(mocks.unresolved).not.toHaveBeenCalled()
  })

  it('validates input before calling the service', async () => {
    for (const input of [
      { kind: 'track', id: 'track-1', provider: 'spotify' },
      { kind: 'album', id: 'album-1', provider: 'discogs', q: ' ' },
      { kind: 'album', id: 'album-1', provider: 'discogs', page: 2 },
    ])
      expect((await findMatch.request(post(input))).status).toBe(422)
    expect(
      (await findMatch.request('/unresolved?kind=playlist&id=one')).status,
    ).toBe(422)
    expect(mocks.search).not.toHaveBeenCalled()
    expect(mocks.unresolved).not.toHaveBeenCalled()
  })

  it('previews tracks for an explicit album candidate without choosing it', async () => {
    const input = {
      albumId: 'album-1',
      provider: 'discogs',
      referenceType: 'master',
      externalId: '12',
    }
    mocks.preview.mockResolvedValue({
      title: 'Example Album',
      artists: ['Example Artist'],
      url: 'https://www.discogs.com/master/12',
      tracks: [],
      trackCount: 0,
    })
    const call = (body: unknown) =>
      findMatch.request('/preview', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          origin: 'http://localhost:3001',
        },
        body: JSON.stringify(body),
      })
    expect((await call({ ...input, externalId: 'invalid' })).status).toBe(422)
    expect(mocks.preview).not.toHaveBeenCalled()
    expect((await call(input)).status).toBe(200)
    expect(mocks.preview).toHaveBeenCalledWith(input)
  })

  it('returns candidates and unresolved lookups in the response envelope', async () => {
    mocks.search.mockResolvedValue({
      provider: 'discogs',
      query: 'Typed',
      items: [],
    })
    mocks.unresolved.mockResolvedValue({ items: [] })
    const search = await findMatch.request(
      post({ kind: 'film', id: 'film-1', provider: 'tmdb', q: ' Typed ' }),
    )
    expect(search.status).toBe(200)
    expect(mocks.search).toHaveBeenCalledWith({
      kind: 'film',
      id: 'film-1',
      provider: 'tmdb',
      q: 'Typed',
    })
    expect(await search.json()).toMatchObject({
      data: { provider: 'discogs', query: 'Typed', items: [] },
    })
    const unresolved = await findMatch.request(
      '/unresolved?kind=artist&id=artist-1',
    )
    expect(unresolved.status).toBe(200)
    expect(mocks.unresolved).toHaveBeenCalledWith({
      kind: 'artist',
      id: 'artist-1',
    })
  })

  it('passes policy refusals through and hides unexpected errors', async () => {
    mocks.search.mockRejectedValueOnce(
      new ServerError({
        statusCode: 422,
        message: 'Provider cooldown is active',
      }),
    )
    const refused = await findMatch.request(
      post({ kind: 'album', id: 'album-1', provider: 'discogs' }),
    )
    expect(refused.status).toBe(422)
    expect(await refused.json()).toMatchObject({
      message: 'Provider cooldown is active',
    })
    mocks.search.mockRejectedValueOnce(new Error('private details'))
    const failed = await findMatch.request(
      post({ kind: 'album', id: 'album-1', provider: 'discogs' }),
    )
    expect(failed.status).toBe(500)
    expect(await failed.text()).not.toContain('private details')
  })
})
