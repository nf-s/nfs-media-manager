import { afterEach, describe, expect, it, vi } from 'vitest'

const listLibraryChanges = vi.fn()
const undoLibraryChange = vi.fn()
const redoLibraryChange = vi.fn()
const planTrackMerge = vi.fn()
const mergeTracks = vi.fn()

const change = {
  id: 'change-1',
  kind: 'track',
  action: 'merge',
  actor: 'owner',
  rule: null,
  target: { id: 'kept', title: 'Night Drive', by: 'Fixture', exists: true },
  sources: [
    { id: 'merged', title: 'Nite Drive', by: 'Fixture', exists: false },
  ],
  names: [{ artistName: 'Fixture', trackName: 'Nite Drive', scrobbles: 2 }],
  nameCount: 1,
  scrobbles: 2,
  createdAt: '2024-01-01T00:00:00.000Z',
  undoneAt: null,
  reversible: true,
  canUndo: true,
  canRedo: false,
}

async function loadApp() {
  const { default: libraryChanges } = await import('@/routes/library-changes')
  const { createOpenAPIApp } = await import('@/lib/openapi')
  const { ServerError } = await import('@/lib/error')
  const app = createOpenAPIApp({ strict: false }).route(
    '/api/v1/library-changes',
    libraryChanges,
  )
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
  vi.doMock('@/services/library-changes', () => ({
    listLibraryChanges,
    undoLibraryChange,
    redoLibraryChange,
  }))
  vi.doMock('@/services/track-merge-plan', () => ({ planTrackMerge }))
  vi.doMock('@/services/track-merges', () => ({ mergeTracks }))
}

function post(body?: unknown, origin = 'http://localhost:3000') {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
}

describe('library changes API', () => {
  afterEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
  })

  it('requires authentication', async () => {
    mockAppSession(false)
    const app = await loadApp()
    expect((await app.request('/api/v1/library-changes')).status).toBe(401)
    expect(
      (
        await app.request(
          '/api/v1/library-changes/track-merges',
          post({ trackIds: ['a', 'b'] }),
        )
      ).status,
    ).toBe(401)
    expect(
      (await app.request('/api/v1/library-changes/change-1/undo', post()))
        .status,
    ).toBe(401)
    expect(mergeTracks).not.toHaveBeenCalled()
    expect(undoLibraryChange).not.toHaveBeenCalled()
  })

  it('lists track changes by default', async () => {
    mockAppSession(true)
    listLibraryChanges.mockResolvedValue({
      page: 1,
      size: 24,
      totalCount: 1,
      pageCount: 1,
      items: [change],
    })
    const app = await loadApp()
    const response = await app.request(
      '/api/v1/library-changes?recordId=kept&actor=owner',
    )
    expect(response.status).toBe(200)
    expect(listLibraryChanges).toHaveBeenCalledWith({
      page: 1,
      size: 24,
      kind: 'track',
      actor: 'owner',
      recordId: 'kept',
    })
    expect(await response.json()).toMatchObject({
      data: { items: [{ id: 'change-1', canUndo: true }] },
    })
  })

  it('validates a merge selection before planning or merging', async () => {
    mockAppSession(true)
    const app = await loadApp()
    for (const body of [
      { trackIds: ['a'] },
      { trackIds: ['a', 'a'] },
      { trackIds: ['a', 'b'], targetId: 'c' },
      { trackIds: ['a', 'b'], other: true },
    ]) {
      expect(
        (
          await app.request(
            '/api/v1/library-changes/track-merges/plan',
            post(body),
          )
        ).status,
      ).toBe(422)
      expect(
        (await app.request('/api/v1/library-changes/track-merges', post(body)))
          .status,
      ).toBe(422)
    }
    expect(planTrackMerge).not.toHaveBeenCalled()
    expect(mergeTracks).not.toHaveBeenCalled()
  })

  it('merges unreviewed unless the request says otherwise', async () => {
    mockAppSession(true)
    mergeTracks.mockResolvedValue(change)
    const app = await loadApp()
    const response = await app.request(
      '/api/v1/library-changes/track-merges',
      post({ trackIds: ['merged', 'kept'], targetId: 'kept' }),
    )
    expect(response.status).toBe(200)
    expect(mergeTracks).toHaveBeenCalledWith({
      trackIds: ['merged', 'kept'],
      targetId: 'kept',
      follow: true,
      reviewed: false,
    })
  })

  it('rejects a merge from another origin', async () => {
    mockAppSession(true)
    const app = await loadApp()
    const response = await app.request(
      '/api/v1/library-changes/track-merges',
      post({ trackIds: ['merged', 'kept'] }, 'https://elsewhere.example'),
    )
    expect(response.status).toBe(403)
    expect(mergeTracks).not.toHaveBeenCalled()
  })

  it('undoes and makes a change again', async () => {
    mockAppSession(true)
    undoLibraryChange.mockResolvedValue({ ...change, canUndo: false })
    redoLibraryChange.mockResolvedValue(change)
    const app = await loadApp()
    expect(
      (await app.request('/api/v1/library-changes/change-1/undo', post()))
        .status,
    ).toBe(200)
    expect(undoLibraryChange).toHaveBeenCalledWith('change-1')
    expect(
      (await app.request('/api/v1/library-changes/change-1/redo', post()))
        .status,
    ).toBe(200)
    expect(redoLibraryChange).toHaveBeenCalledWith('change-1')
  })

  it('reports a change that a later change has superseded', async () => {
    mockAppSession(true)
    const { ServerError } = await import('@/lib/error')
    undoLibraryChange.mockRejectedValue(
      new ServerError({
        statusCode: 409,
        message: 'A later change moved these names. Undo that change first.',
      }),
    )
    const app = await loadApp()
    const response = await app.request(
      '/api/v1/library-changes/change-1/undo',
      post(),
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      message: 'A later change moved these names. Undo that change first.',
    })
  })
})
