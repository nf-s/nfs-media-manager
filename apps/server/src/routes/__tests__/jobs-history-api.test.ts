import { afterEach, describe, expect, it, vi } from 'vitest'

const listJobs = vi.fn()
const dismissJob = vi.fn()
const getJobData = vi.fn()

function mockAppSession(authenticated: boolean) {
  vi.doMock('@/services/job-data', () => ({ getJobData }))
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
    })
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
