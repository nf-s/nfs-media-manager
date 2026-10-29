import { afterEach, describe, expect, it, vi } from 'vitest'

const listTags = vi.fn()
const mergeTags = vi.fn()
const getTagProvenance = vi.fn()
const getTagDetail = vi.fn()
const setTagVisibility = vi.fn()

async function loadApp() {
  const { default: tags } = await import('@/routes/tags')
  const { createOpenAPIApp } = await import('@/lib/openapi')
  const { ServerError } = await import('@/lib/error')
  const app = createOpenAPIApp({ strict: false }).route('/api/v1/tags', tags)
  app.onError((error, context) => {
    if (error instanceof ServerError)
      return context.json(error.response, error.response.statusCode)
    throw error
  })
  return app
}

function mockAppSession(authenticated: boolean) {
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
                  id: 'user-1',
                  email: 'admin@example.com',
                  name: 'Admin',
                },
                session: { id: 'session-1', userId: 'user-1' },
              }
            : null,
        ),
      },
      handler: vi.fn(),
    },
  }))
  vi.doMock('@/services/tags', () => ({
    listTags,
    mergeTags,
    getTagProvenance,
    getTagDetail,
    setTagVisibility,
  }))
}

describe('tag administration API', () => {
  afterEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
  })

  it('requires authentication for listing and merging', async () => {
    mockAppSession(false)
    const app = await loadApp()
    expect((await app.request('/api/v1/tags')).status).toBe(401)
    expect((await app.request('/api/v1/tags/tag-id')).status).toBe(401)
    expect(
      (
        await app.request('/api/v1/tags/visibility', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mediaType: 'film',
            tagIds: ['a'],
            hidden: true,
          }),
        })
      ).status,
    ).toBe(401)
    expect(
      (await app.request('/api/v1/tags/provenance?mediaId=film&name=history'))
        .status,
    ).toBe(401)
    expect(
      (
        await app.request('/api/v1/tags/merge', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mediaType: 'film',
            sourceIds: ['a'],
            targetId: 'b',
          }),
        })
      ).status,
    ).toBe(401)
    expect(listTags).not.toHaveBeenCalled()
    expect(mergeTags).not.toHaveBeenCalled()
    expect(getTagProvenance).not.toHaveBeenCalled()
    expect(getTagDetail).not.toHaveBeenCalled()
    expect(setTagVisibility).not.toHaveBeenCalled()
  })

  it('validates and forwards pagination/search and returns bounded provenance', async () => {
    mockAppSession(true)
    const app = await loadApp()
    const page = {
      items: [
        {
          id: 'a',
          name: 'history of spain',
          kind: 'keyword',
          mediaCount: 2,
          sourceCount: 1,
          sources: [
            {
              provider: 'mdblist',
              source: 'imdb',
              rawName: 'imdb.history-of-spain',
              kind: 'keyword',
            },
          ],
        },
      ],
      totalCount: 1,
      pageCount: 1,
      page: 1,
      size: 25,
    }
    listTags.mockResolvedValue(page)
    const response = await app.request(
      '/api/v1/tags?q=imdb.history-of-spain&page=1&size=25',
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: page })
    expect(listTags).toHaveBeenCalledWith({
      mediaType: 'film',
      q: 'imdb.history-of-spain',
      visibility: 'visible',
      page: 1,
      size: 25,
    })
    listTags.mockClear()
    for (const query of [
      'mediaType=music',
      'size=101',
      'page=0',
      'size=bad',
      'visibility=invalid',
      `q=${'x'.repeat(201)}`,
    ])
      expect((await app.request(`/api/v1/tags?${query}`)).status).toBe(422)
    expect(listTags).not.toHaveBeenCalled()
  })

  it('forwards hidden lists, ID detail pagination and validated reversible visibility changes', async () => {
    mockAppSession(true)
    const app = await loadApp()
    listTags.mockResolvedValue({
      items: [],
      totalCount: 0,
      page: 1,
      size: 25,
      pageCount: 0,
    })
    expect((await app.request('/api/v1/tags?visibility=hidden')).status).toBe(
      200,
    )
    expect(listTags).toHaveBeenCalledWith({
      mediaType: 'film',
      page: 1,
      size: 25,
      visibility: 'hidden',
    })
    getTagDetail.mockResolvedValue({
      tag: { id: 'a', hidden: true },
      aliases: [],
      provenance: { items: [] },
    })
    expect(
      (await app.request('/api/v1/tags/a?mediaType=album&page=2&size=10'))
        .status,
    ).toBe(200)
    expect(getTagDetail).toHaveBeenCalledWith('a', {
      mediaType: 'album',
      page: 2,
      size: 10,
    })
    getTagDetail.mockClear()
    expect((await app.request('/api/v1/tags/a?size=101')).status).toBe(422)
    expect(getTagDetail).not.toHaveBeenCalled()
    const request = (body: unknown) =>
      app.request('/api/v1/tags/visibility', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    for (const body of [
      { mediaType: 'film', tagIds: [], hidden: true },
      { mediaType: 'film', tagIds: ['a', 'a'], hidden: true },
      { mediaType: 'film', tagIds: ['a'], hidden: 'false' },
    ])
      expect((await request(body)).status).toBe(422)
    expect(setTagVisibility).not.toHaveBeenCalled()
    for (const hidden of [true, false]) {
      setTagVisibility.mockResolvedValue({ updated: 1, hidden })
      const response = await request({
        mediaType: 'film',
        tagIds: ['a'],
        hidden,
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        data: { updated: 1, hidden },
      })
      expect(setTagVisibility).toHaveBeenLastCalledWith({
        mediaType: 'film',
        tagIds: ['a'],
        hidden,
      })
    }
    const { ServerError: AppServerError } = await import('@/lib/error')
    for (const statusCode of [404, 409]) {
      setTagVisibility.mockRejectedValue(
        new AppServerError({
          statusCode: statusCode === 404 ? 404 : 409,
          message: 'Tag unavailable',
        }),
      )
      expect(
        (await request({ mediaType: 'film', tagIds: ['a'], hidden: true }))
          .status,
      ).toBe(statusCode)
    }
  })

  it('validates exact item/tag provenance queries and forwards all source pages', async () => {
    mockAppSession(true)
    const app = await loadApp()
    const data = { items: [], totalCount: 0, page: 2, size: 25, pageCount: 0 }
    getTagProvenance.mockResolvedValue(data)
    const response = await app.request(
      '/api/v1/tags/provenance?mediaId=film-1&name=History%20of%20Spain&page=2',
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data })
    expect(getTagProvenance).toHaveBeenCalledWith({
      mediaId: 'film-1',
      name: 'History of Spain',
      page: 2,
      size: 25,
    })
    expect(
      (
        await app.request(
          '/api/v1/tags/provenance?mediaType=album&name=History&page=3',
        )
      ).status,
    ).toBe(200)
    expect(getTagProvenance).toHaveBeenLastCalledWith({
      mediaType: 'album',
      name: 'History',
      page: 3,
      size: 25,
    })
    getTagProvenance.mockClear()
    for (const query of [
      'name=History',
      'mediaType=music&name=History',
      'mediaId=film',
      'mediaId=&name=History',
      'mediaId=film&name=',
      'mediaId=film&name=History&size=101',
    ])
      expect(
        (await app.request(`/api/v1/tags/provenance?${query}`)).status,
      ).toBe(422)
    expect(getTagProvenance).not.toHaveBeenCalled()
  })

  it('rejects empty, duplicate, self and oversized selections before calling the service', async () => {
    mockAppSession(true)
    const app = await loadApp()
    for (const body of [
      {},
      { mediaType: 'film', sourceIds: [], targetId: 'b' },
      { mediaType: 'film', sourceIds: ['a', 'a'], targetId: 'b' },
      { mediaType: 'film', sourceIds: ['a'], targetId: 'a' },
      { mediaType: 'film', sourceIds: [''], targetId: 'b' },
      {
        sourceIds: Array.from({ length: 101 }, (_, index) => String(index)),
        targetId: 'b',
      },
    ])
      expect(
        (
          await app.request('/api/v1/tags/merge', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(422)
    expect(mergeTags).not.toHaveBeenCalled()
  })

  it('uses the authenticated actor and reports domain failures without hiding them', async () => {
    mockAppSession(true)
    const app = await loadApp()
    mergeTags.mockResolvedValue({ merged: 1, targetId: 'b' })
    const request = () =>
      app.request('/api/v1/tags/merge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mediaType: 'film',
          sourceIds: ['a'],
          targetId: 'b',
          userId: 'forged',
        }),
      })
    const response = await request()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: { merged: 1, targetId: 'b' },
    })
    expect(mergeTags).toHaveBeenCalledWith(
      { mediaType: 'film', sourceIds: ['a'], targetId: 'b' },
      'user-1',
    )
    const { ServerError: AppServerError } = await import('@/lib/error')
    for (const statusCode of [404, 409]) {
      mergeTags.mockRejectedValue(
        new AppServerError({
          statusCode: statusCode === 404 ? 404 : 409,
          message: 'Tag cannot be merged',
        }),
      )
      expect((await request()).status).toBe(statusCode)
    }
  })
})
