import { afterEach, describe, expect, it, vi } from 'vitest'

const listJobs = vi.fn()
const dismissJob = vi.fn()
const getJobData = vi.fn()
const listJobProviderResponses = vi.fn()
const getJobProviderResponse = vi.fn()
const listJobEntries = vi.fn()

function mockAppSession(authenticated: boolean) {
  vi.doMock('@/services/job-data', () => ({ getJobData }))
  vi.doMock('@/services/provider-response-history', () => ({
    listJobProviderResponses,
    getJobProviderResponse,
  }))
  vi.doMock('@/services/job-entries', () => ({ listJobEntries }))
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
  vi.doMock('@/services/jobs', () => ({
    createJob: vi.fn(),
    createRescrapeJob: vi.fn(),
    getJob: vi.fn(),
    listJobs,
    getJobActivity: vi.fn(),
    retryJob: vi.fn(),
    markJobErrorBenign: vi.fn(),
    dismissJob,
  }))
}

describe('media job history api', () => {
  afterEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
  })

  it('requires authentication before reading job JSON', async () => {
    mockAppSession(false)
    const { default: app } = await import('@/app')
    const response = await app.request('/api/v1/scrape/jobs/job-1/data')
    expect(response.status).toBe(401)
    expect(getJobData).not.toHaveBeenCalled()
  })

  it('returns saved JSON only for the requested job', async () => {
    mockAppSession(true)
    const data = {
      jobId: 'job-1',
      snapshots: [],
      diagnostics: [],
      itemPayloads: [],
    }
    getJobData.mockResolvedValue(data)
    const { default: app } = await import('@/app')
    const response = await app.request('/api/v1/scrape/jobs/job-1/data')
    expect(response.status).toBe(200)
    expect(getJobData).toHaveBeenCalledExactlyOnceWith('job-1')
    expect(await response.json()).toMatchObject({ data })
  })

  it('returns not found for an unknown job JSON request', async () => {
    mockAppSession(true)
    const { ServerError } = await import('@/lib/error')
    getJobData.mockRejectedValue(
      new ServerError({ statusCode: 404, message: 'Job not found' }),
    )
    const { default: app } = await import('@/app')
    const response = await app.request('/api/v1/scrape/jobs/missing/data')
    expect(response.status).toBe(404)
  })

  it('requires authentication for stored response summaries and bodies', async () => {
    mockAppSession(false)
    const { default: app } = await import('@/app')
    const list = await app.request('/api/v1/scrape/jobs/job-1/data/responses')
    const detail = await app.request(
      '/api/v1/scrape/jobs/job-1/data/responses/response-1',
    )
    expect(list.status).toBe(401)
    expect(detail.status).toBe(401)
    expect(listJobProviderResponses).not.toHaveBeenCalled()
    expect(getJobProviderResponse).not.toHaveBeenCalled()
  })

  it('reads response summaries and only the requested scoped body', async () => {
    mockAppSession(true)
    const summary = {
      id: 'response-1',
      jobId: 'job-1',
      jobItemId: 'item-1',
      artistId: null,
      provider: 'fixture-provider',
      phase: 'media',
      ordinal: 1,
      attempt: 1,
      method: 'GET',
      requestUrl: 'https://example.invalid/release',
      status: 200,
      receivedAt: '2020-01-01T00:00:00.000Z',
      contentType: 'application/json',
      retry: null,
      notFound: false,
      bodyState: 'captured',
      retainedBytes: 2,
    }
    listJobProviderResponses.mockResolvedValue({
      items: [summary],
      page: 2,
      size: 1,
      totalCount: 2,
      pageCount: 2,
    })
    const body = { state: 'captured', text: '{}' }
    getJobProviderResponse.mockResolvedValue({
      ...summary,
      body,
      requestKey: 'a'.repeat(64),
    })
    const { default: app } = await import('@/app')
    const list = await app.request(
      '/api/v1/scrape/jobs/job-1/data/responses?page=2&size=1',
    )
    expect(list.status).toBe(200)
    expect(list.headers.get('cache-control')).toContain('no-store')
    expect(listJobProviderResponses).toHaveBeenCalledExactlyOnceWith('job-1', {
      page: 2,
      size: 1,
    })
    expect(getJobProviderResponse).not.toHaveBeenCalled()
    expect((await list.json()).data.items).toEqual([summary])
    const detail = await app.request(
      '/api/v1/scrape/jobs/job-1/data/responses/response-1',
    )
    expect(detail.status).toBe(200)
    expect(detail.headers.get('cache-control')).toContain('no-store')
    expect(getJobProviderResponse).toHaveBeenCalledExactlyOnceWith(
      'job-1',
      'response-1',
    )
    expect((await detail.json()).data).toMatchObject({
      body,
      requestKey: 'a'.repeat(64),
    })
    expect(getJobData).not.toHaveBeenCalled()
  })

  it('requires authentication for media-specific jobs', async () => {
    mockAppSession(false)
    const { default: app } = await import('@/app')
    const response = await app.request('/api/v1/scrape/jobs?mediaItemId=film-1')
    expect(response.status).toBe(401)
    expect(listJobs).not.toHaveBeenCalled()
  })

  it('validates the media identifier instead of returning the whole library', async () => {
    mockAppSession(true)
    const { default: app } = await import('@/app')
    const response = await app.request('/api/v1/scrape/jobs?mediaItemId=')
    expect(response.status).toBe(422)
    expect(listJobs).not.toHaveBeenCalled()
  })

  it('passes the media filter and pagination without restricting job status', async () => {
    mockAppSession(true)
    listJobs.mockResolvedValue({
      items: [],
      totalCount: 0,
      page: 2,
      size: 25,
      pageCount: 0,
    })
    const { default: app } = await import('@/app')
    const response = await app.request(
      '/api/v1/scrape/jobs?mediaItemId=film-1&page=2',
    )
    expect(response.status).toBe(200)
    expect(listJobs).toHaveBeenCalledWith({
      mediaItemId: 'film-1',
      page: 2,
      size: 25,
      sortBy: 'createdAt',
      direction: 'desc',
      statuses: [],
      providers: [],
    })
  })

  it('forwards explicit job sorting and rejects unsupported sort input', async () => {
    mockAppSession(true)
    listJobs.mockResolvedValue({ items: [], totalCount: 0, pageCount: 0 })
    const { default: app } = await import('@/app')
    expect(
      (await app.request('/api/v1/scrape/jobs?sortBy=provider&direction=asc'))
        .status,
    ).toBe(200)
    expect(listJobs).toHaveBeenCalledExactlyOnceWith({
      page: 1,
      size: 25,
      sortBy: 'provider',
      direction: 'asc',
      statuses: [],
      providers: [],
    })
    listJobs.mockClear()
    for (const query of ['sortBy=unknown', 'direction=reverse'])
      expect((await app.request(`/api/v1/scrape/jobs?${query}`)).status).toBe(
        422,
      )
    expect(listJobs).not.toHaveBeenCalled()
  })

  it('requires authentication before dismissing a job', async () => {
    mockAppSession(false)
    const { default: app } = await import('@/app')
    const response = await app.request('/api/v1/scrape/jobs/job-1/dismiss', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(401)
    expect(dismissJob).not.toHaveBeenCalled()
  })

  it('lists grouped job entries with the jobs list filters', async () => {
    mockAppSession(false)
    const { default: unauthenticated } = await import('@/app')
    expect(
      (await unauthenticated.request('/api/v1/scrape/jobs/entries')).status,
    ).toBe(401)
    expect(listJobEntries).not.toHaveBeenCalled()
    vi.resetModules()
    mockAppSession(true)
    listJobEntries.mockResolvedValue({
      items: [],
      totalCount: 0,
      page: 1,
      size: 50,
      pageCount: 0,
    })
    const { default: app } = await import('@/app')
    expect(
      (
        await app.request(
          '/api/v1/scrape/jobs/entries?statuses=["active"]&size=50&sortBy=status',
        )
      ).status,
    ).toBe(200)
    expect(listJobEntries).toHaveBeenCalledExactlyOnceWith({
      page: 1,
      size: 50,
      sortBy: 'status',
      direction: 'desc',
      statuses: ['active'],
      providers: [],
    })
    expect(
      (await app.request('/api/v1/scrape/jobs/entries?sortBy=batch')).status,
    ).toBe(422)
    expect(listJobEntries).toHaveBeenCalledTimes(1)
  })

  it('dismisses only the selected job using the authenticated actor', async () => {
    mockAppSession(true)
    dismissJob.mockResolvedValue({ id: 'job-1', status: 'failed' })
    const { default: app } = await import('@/app')
    const response = await app.request('/api/v1/scrape/jobs/job-1/dismiss', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'forged-user',
        provider: 'another-provider',
      }),
    })
    expect(response.status).toBe(200)
    expect(dismissJob).toHaveBeenCalledExactlyOnceWith('job-1', 'user-1')
  })

  it('validates dismissal requests before calling the service', async () => {
    mockAppSession(true)
    const { default: app } = await import('@/app')
    const response = await app.request('/api/v1/scrape/jobs/job-1/dismiss', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    })
    expect(response.status).toBe(422)
    expect(dismissJob).not.toHaveBeenCalled()
  })
})
