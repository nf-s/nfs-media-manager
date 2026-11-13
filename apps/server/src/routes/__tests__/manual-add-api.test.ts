import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  search: vi.fn(),
  add: vi.fn(),
}))
vi.mock('@/env', () => ({
  env: {
    TRUSTED_ORIGINS: ['http://localhost:3001'],
    APP_URL: 'http://localhost:3001',
  },
}))
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.session } } }))
vi.mock('@/services/manual-add', () => ({
  searchManualMedia: mocks.search,
  addManualMedia: mocks.add,
}))
import manualAdd from '../manual-add'

function post(path: string, body: unknown, origin = 'http://localhost:3001') {
  return new Request(`http://localhost:4001${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin },
    body: JSON.stringify(body),
  })
}

describe('manual additions API', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.session.mockResolvedValue({
      user: { id: 'owner', email: 'owner@example.com', role: 'admin' },
      session: { id: 'session', userId: 'owner' },
    })
  })

  it('requires an authenticated owner and trusted mutation origin', async () => {
    mocks.session.mockResolvedValue(null)
    expect(
      (
        await manualAdd.request(
          post('/search', { mediaType: 'album', q: 'Example' }),
        )
      ).status,
    ).toBe(401)
    expect(
      (
        await manualAdd.request(
          post('/add', { mediaType: 'film', externalId: '701' }),
        )
      ).status,
    ).toBe(401)
    expect(
      (
        await manualAdd.request(
          post('/search', {}, 'https://untrusted.invalid'),
        )
      ).status,
    ).toBe(403)
    expect(mocks.search).not.toHaveBeenCalled()
    expect(mocks.add).not.toHaveBeenCalled()
  })

  it('validates search and identifier input before invoking services', async () => {
    for (const input of [
      { mediaType: 'film', q: '' },
      { mediaType: 'film', q: 'Movie', page: 51 },
      { mediaType: 'film', q: 'Movie', url: 'https://untrusted.invalid' },
    ])
      expect((await manualAdd.request(post('/search', input))).status).toBe(422)
    for (const input of [
      { mediaType: 'album', externalId: 'bad' },
      { mediaType: 'film', externalId: '701', title: 'Untrusted title' },
    ])
      expect((await manualAdd.request(post('/add', input))).status).toBe(422)
    expect(mocks.search).not.toHaveBeenCalled()
    expect(mocks.add).not.toHaveBeenCalled()
  })

  it('returns validated search and add envelopes', async () => {
    mocks.search.mockResolvedValue({ items: [], page: 1, hasMore: false })
    mocks.add.mockResolvedValue({ mediaItemId: 'film-one', created: true })
    const search = await manualAdd.request(
      post('/search', { mediaType: 'film', q: ' Example ' }),
    )
    expect(search.status).toBe(200)
    expect(mocks.search).toHaveBeenCalledWith({
      mediaType: 'film',
      q: 'Example',
      page: 1,
    })
    const response = await manualAdd.request(
      post('/add', { mediaType: 'film', externalId: '701' }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: { mediaItemId: 'film-one', created: true },
    })
  })

  it('does not disclose unexpected persistence or provider errors', async () => {
    mocks.add.mockRejectedValue(new Error('private details'))
    const response = await manualAdd.request(
      post('/add', { mediaType: 'film', externalId: '701' }),
    )
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('private details')
  })
})
