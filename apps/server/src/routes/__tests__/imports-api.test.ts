import { afterEach, describe, expect, it, vi } from 'vitest'

const getImportStatus = vi.fn()
const startLibraryImport = vi.fn()
const listSavedViews = vi.fn()
const startFileImport = vi.fn()
const previewFileImport = vi.fn()
const prepareFilmImport = vi.fn()
const confirmFilmImport = vi.fn()

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
  vi.doMock('@/services/imports', () => ({
    getImportStatus,
    startLibraryImport,
    listSavedViews,
  }))
  vi.doMock('@/services/file-imports', () => ({
    startFileImport,
    previewFileImport,
    listFileImportFormats: vi.fn(async () => []),
  }))
  vi.doMock('@/services/film-imports', () => ({
    prepareFilmImport,
    confirmFilmImport,
    getNfoSource: vi.fn(async () => ({ path: null, available: false })),
  }))
}

describe('local imports api', () => {
  afterEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
  })

  it('validates and forwards the requested import library', async () => {
    mockAppSession(true)
    getImportStatus.mockResolvedValue({ sources: [], runs: [] })
    const { default: app } = await import('@/app')
    expect(
      (await app.request('http://localhost/api/v1/imports?mediaType=album'))
        .status,
    ).toBe(200)
    expect(getImportStatus).toHaveBeenCalledWith({ mediaType: 'album' })
    getImportStatus.mockClear()
    expect(
      (await app.request('http://localhost/api/v1/imports?mediaType=book'))
        .status,
    ).toBe(422)
    expect(getImportStatus).not.toHaveBeenCalled()
  })

  it('requires authentication for listing, starting imports and saved views', async () => {
    mockAppSession(false)
    const { default: app } = await import('@/app')
    for (const path of [
      '/api/v1/imports',
      '/api/v1/imports/saved-views',
      '/api/v1/imports/formats',
      '/api/v1/imports/nfo-source',
      '/api/v1/scrape/jobs/activity',
    ])
      expect((await app.request(`http://localhost${path}`)).status).toBe(401)
    expect(
      (
        await app.request('http://localhost/api/v1/imports', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(401)
    expect(startLibraryImport).not.toHaveBeenCalled()
    for (const path of ['files', 'preview', 'film-preview', 'film-import'])
      expect(
        (
          await app.request(`http://localhost/api/v1/imports/${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ format: 'nfo', path: '/fixture' }),
          })
        ).status,
      ).toBe(401)
    expect(startFileImport).not.toHaveBeenCalled()
    expect(previewFileImport).not.toHaveBeenCalled()
    expect(prepareFilmImport).not.toHaveBeenCalled()
    expect(confirmFilmImport).not.toHaveBeenCalled()
  })

  it('rejects browser NFO paths, invalid uploads and empty selections', async () => {
    mockAppSession(true)
    const { default: app } = await import('@/app')
    for (const [path, body] of [
      ['film-preview', { kind: 'nfo', path: '/not-allowed' }],
      [
        'film-preview',
        {
          kind: 'csv',
          format: 'imdb-ratings',
          fileName: 'file.xml',
          content: 'test',
        },
      ],
      ['film-import', { previewId: 'preview', rows: [] }],
    ])
      expect(
        (
          await app.request(`http://localhost/api/v1/imports/${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(422)
    expect(prepareFilmImport).not.toHaveBeenCalled()
    expect(confirmFilmImport).not.toHaveBeenCalled()
  })

  it('rejects oversized file subsets and missing paths before reading files', async () => {
    mockAppSession(true)
    const { default: app } = await import('@/app')
    for (const body of [
      { format: 'nfo', path: '/fixture', limit: 100 },
      { format: 'nfo' },
    ])
      expect(
        (
          await app.request('http://localhost/api/v1/imports/files', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(422)
    expect(startFileImport).not.toHaveBeenCalled()
  })

  it('rejects oversized implicit subsets without invoking an importer', async () => {
    mockAppSession(true)
    const { default: app } = await import('@/app')
    const response = await app.request('http://localhost/api/v1/imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ albumLimit: 100 }),
    })
    expect(response.status).toBe(422)
    expect(startLibraryImport).not.toHaveBeenCalled()
  })

  it('starts only the default tiny subset and attributes the initiating user', async () => {
    mockAppSession(true)
    startLibraryImport.mockResolvedValue({
      id: 'test-import',
      status: 'running',
      stage: 'Starting',
      processed: 0,
      total: 0,
      errorMessage: null,
      result: null,
      createdAt: '2026-10-27T00:00:00.000Z',
      finishedAt: null,
    })
    const { default: app } = await import('@/app')
    const response = await app.request('http://localhost/api/v1/imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(202)
    expect(startLibraryImport).toHaveBeenCalledWith(
      { fullLibrary: false, albumLimit: 2, filmLimit: 2 },
      'user-1',
    )
  })
})
