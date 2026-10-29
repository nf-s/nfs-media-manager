import { afterEach, describe, expect, it, vi } from 'vitest'

const listAlbumSelection = vi.fn()
const queueAlbumSelection = vi.fn()
function setup(authenticated: boolean) {
  vi.doMock('@/env', () => ({
    env: { TRUSTED_ORIGINS: ['http://localhost:3000'], NODE_ENV: 'test' },
  }))
  vi.doMock('@/lib/db', () => ({ db: {} }))
  vi.doMock('@/lib/auth', () => ({
    auth: {
      api: {
        getSession: vi.fn().mockResolvedValue(
          authenticated
            ? {
                user: {
                  id: 'actor',
                  email: 'admin@example.com',
                  name: 'Admin',
                },
                session: { id: 'session', userId: 'actor' },
              }
            : null,
        ),
      },
      handler: vi.fn(),
    },
  }))
  vi.doMock('@/services/album-selection', () => ({
    listAlbumSelection,
    queueAlbumSelection,
  }))
}
afterEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
})
const request = {
  providers: ['fixture'],
  mediaItemIds: ['album-1'],
  batchId: '97d0dc00-0294-4232-9de1-a5178280c332',
}
describe('album selection API', () => {
  it('requires authentication for read and queue', async () => {
    setup(false)
    const { default: app } = await import('@/app')
    expect(
      (await app.request('/api/v1/albums/selection?provider=fixture')).status,
    ).toBe(401)
    expect(
      (
        await app.request('/api/v1/scrape/jobs/albums', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        })
      ).status,
    ).toBe(401)
    expect(listAlbumSelection).not.toHaveBeenCalled()
    expect(queueAlbumSelection).not.toHaveBeenCalled()
  })
  it('validates browse and freshness parameters before calling the read-only service', async () => {
    setup(true)
    const { default: app } = await import('@/app')
    for (const query of [
      'sortBy=lastScrapedAt',
      'freshness=broken',
      'provider=fixture&olderThanDays=0',
      'provider=fixture&filters=broken',
    ])
      expect(
        (await app.request(`/api/v1/albums/selection?${query}`)).status,
      ).toBe(422)
    expect(listAlbumSelection).not.toHaveBeenCalled()
  })
  it('accepts an all-provider view and validates combined freshness filters without queueing', async () => {
    setup(true)
    listAlbumSelection.mockResolvedValue({
      items: [],
      totalCount: 0,
      pageCount: 0,
      page: 1,
      size: 50,
    })
    const { default: app } = await import('@/app')
    const freshness = [
      { provider: 'fixture', mode: 'never' },
      { provider: 'other', mode: 'older', olderThanDays: 30 },
      { provider: 'failed-provider', mode: 'failed' },
      { provider: 'unscraped-provider', mode: 'unscraped' },
    ]
    const response = await app.request(
      `/api/v1/albums/selection?${new URLSearchParams({ freshness: JSON.stringify(freshness) })}`,
    )
    expect(response.status).toBe(200)
    expect(listAlbumSelection).toHaveBeenCalledWith(
      expect.objectContaining({ freshness, sortBy: 'dateAdded' }),
    )
    expect(queueAlbumSelection).not.toHaveBeenCalled()
  })
  it('returns selection data without queueing', async () => {
    setup(true)
    listAlbumSelection.mockResolvedValue({
      items: [],
      totalCount: 0,
      pageCount: 0,
      page: 1,
      size: 50,
    })
    const { default: app } = await import('@/app')
    const response = await app.request(
      '/api/v1/albums/selection?provider=fixture&size=50&sortBy=lastScrapedAt&direction=asc',
    )
    expect(response.status).toBe(200)
    expect(listAlbumSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'fixture',
        sortBy: 'lastScrapedAt',
        direction: 'asc',
        size: 50,
      }),
    )
    expect(queueAlbumSelection).not.toHaveBeenCalled()
  })
  it.each([
    {},
    { ...request, mediaItemIds: [] },
    { ...request, providers: [] },
    {
      ...request,
      mediaItemIds: Array.from({ length: 101 }, (_, i) => `album-${i}`),
    },
    { ...request, confirmBroadRun: 'true' },
  ])('rejects invalid queue chunks %j', async (input) => {
    setup(true)
    const { default: app } = await import('@/app')
    expect(
      (
        await app.request('/api/v1/scrape/jobs/albums', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(422)
    expect(queueAlbumSelection).not.toHaveBeenCalled()
  })
  it('passes only explicit validated IDs and the authenticated actor to scheduling', async () => {
    setup(true)
    queueAlbumSelection.mockResolvedValue({
      batchId: request.batchId,
      queued: 1,
      skipped: 0,
      warnings: [],
    })
    const { default: app } = await import('@/app')
    const response = await app.request('/api/v1/scrape/jobs/albums', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, userId: 'forged' }),
    })
    expect(response.status).toBe(200)
    expect(queueAlbumSelection).toHaveBeenCalledWith(
      { ...request, confirmBroadRun: false },
      'actor',
    )
  })
})
