import { afterEach, describe, expect, it, vi } from 'vitest'

const bulkRetryJobs = vi.fn()
const bulkDismissJobs = vi.fn()
const bulkCancelJobs = vi.fn()
const createJob = vi.fn()

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
  vi.doMock('@/services/jobs', () => ({
    createJob,
    createRescrapeJob: vi.fn(),
    getJob: vi.fn(),
    listJobs: vi.fn(),
    getJobActivity: vi.fn(),
    retryJob: vi.fn(),
    markJobErrorBenign: vi.fn(),
    dismissJob: vi.fn(),
    bulkRetryJobs,
    bulkDismissJobs,
    bulkCancelJobs,
  }))
}

afterEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
})

describe('single-item job creation', () => {
  it.each([
    { mediaItemIds: [] },
    { mediaItemIds: ['film-1', 'film-2'] },
    { mediaItemIds: ['film-1'], limit: 2 },
    { mediaType: 'film' },
  ])(
    'rejects implicit or multi-item scopes even with broad confirmation: %j',
    async (scope) => {
      mockAppSession(true)
      const { default: app } = await import('@/app')
      const response = await app.request('/api/v1/scrape/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'mock',
          scope,
          confirmBroadRun: true,
        }),
      })
      expect(response.status).toBe(422)
      expect(createJob).not.toHaveBeenCalled()
    },
  )

  it('defaults an explicit one-item scope to limit one', async () => {
    mockAppSession(true)
    createJob.mockResolvedValue({ id: 'created-job' })
    const { default: app } = await import('@/app')
    const response = await app.request('/api/v1/scrape/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'mock',
        scope: { mediaItemIds: ['film-1'], mediaType: 'film' },
      }),
    })
    expect(response.status).toBe(200)
    expect(createJob).toHaveBeenCalledWith(
      {
        provider: 'mock',
        scope: { mediaItemIds: ['film-1'], mediaType: 'film', limit: 1 },
        options: {},
        confirmBroadRun: false,
      },
      'user-1',
    )
  })
})

describe.each(['retry', 'dismiss', 'cancel'])('bulk jobs %s api', (action) => {
  const path = `/api/v1/scrape/jobs/${action}`

  it('requires authentication before invoking a bulk service', async () => {
    mockAppSession(false)
    const { default: app } = await import('@/app')
    const response = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobIds: ['job-1'] }),
    })
    expect(response.status).toBe(401)
    expect(bulkRetryJobs).not.toHaveBeenCalled()
    expect(bulkDismissJobs).not.toHaveBeenCalled()
    expect(bulkCancelJobs).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { jobIds: [] },
    { jobIds: [''] },
    { jobIds: ['job-1', 'job-1'] },
    { jobIds: [123] },
    { jobIds: Array.from({ length: 101 }, (_, index) => `job-${index}`) },
  ])(
    'rejects invalid selections before invoking a service: %j',
    async (input) => {
      mockAppSession(true)
      const { default: app } = await import('@/app')
      const response = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...input,
          ...(action === 'cancel' ? { confirmRunning: true } : {}),
        }),
      })
      expect(response.status).toBe(422)
      expect(bulkRetryJobs).not.toHaveBeenCalled()
      expect(bulkDismissJobs).not.toHaveBeenCalled()
      expect(bulkCancelJobs).not.toHaveBeenCalled()
    },
  )

  it('uses the session actor, strips unrelated fields and returns per-job outcomes', async () => {
    mockAppSession(true)
    const retryResult = {
      queued: 1,
      skipped: 1,
      results: [
        { jobId: 'job-1', status: 'queued', retryJobId: 'retry-1' },
        { jobId: 'job-2', status: 'skipped', message: 'Already handled.' },
        {
          jobId: 'job-3',
          status: 'failed',
          message: 'Provider is cooling down.',
        },
      ],
    }
    const dismissResult = {
      dismissed: 1,
      skipped: 1,
      results: [
        { jobId: 'job-1', status: 'dismissed' },
        { jobId: 'job-2', status: 'skipped', message: 'Already handled.' },
        {
          jobId: 'job-3',
          status: 'failed',
          message: 'Unable to update this job.',
        },
      ],
    }
    bulkRetryJobs.mockResolvedValue(retryResult)
    bulkDismissJobs.mockResolvedValue(dismissResult)
    const cancelResult = {
      cancelled: 1,
      skipped: 1,
      results: [
        { jobId: 'job-1', status: 'cancelled' },
        { jobId: 'job-2', status: 'skipped' },
        { jobId: 'job-3', status: 'failed', message: 'Unable to update.' },
      ],
    }
    bulkCancelJobs.mockResolvedValue(cancelResult)
    const { default: app } = await import('@/app')
    const jobIds = ['job-1', 'job-2', 'job-3']
    const response = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobIds,
        userId: 'forged-user',
        provider: 'unrelated-provider',
        ...(action === 'cancel' ? { confirmRunning: true } : {}),
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data:
        action === 'retry'
          ? retryResult
          : action === 'cancel'
            ? cancelResult
            : dismissResult,
    })
    if (action === 'retry') {
      expect(bulkRetryJobs).toHaveBeenCalledExactlyOnceWith(
        { jobIds, confirmBroadRun: false },
        'user-1',
      )
      expect(bulkDismissJobs).not.toHaveBeenCalled()
    } else if (action === 'cancel') {
      expect(bulkCancelJobs).toHaveBeenCalledExactlyOnceWith(
        { jobIds, confirmRunning: true },
        'user-1',
      )
      expect(bulkRetryJobs).not.toHaveBeenCalled()
      expect(bulkDismissJobs).not.toHaveBeenCalled()
    } else {
      expect(bulkDismissJobs).toHaveBeenCalledExactlyOnceWith(
        { jobIds },
        'user-1',
      )
      expect(bulkRetryJobs).not.toHaveBeenCalled()
    }
  })

  it('accepts exactly 100 IDs as a transport chunk', async () => {
    mockAppSession(true)
    bulkRetryJobs.mockResolvedValue({ queued: 0, skipped: 0, results: [] })
    bulkDismissJobs.mockResolvedValue({ dismissed: 0, skipped: 0, results: [] })
    bulkCancelJobs.mockResolvedValue({ cancelled: 0, skipped: 0, results: [] })
    const { default: app } = await import('@/app')
    const jobIds = Array.from({ length: 100 }, (_, index) => `job-${index}`)
    const response = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobIds,
        confirmBroadRun: true,
        ...(action === 'cancel' ? { confirmRunning: true } : {}),
      }),
    })
    expect(response.status).toBe(200)
    if (action === 'retry')
      expect(bulkRetryJobs).toHaveBeenCalledExactlyOnceWith(
        { jobIds, confirmBroadRun: true },
        'user-1',
      )
    else if (action === 'cancel')
      expect(bulkCancelJobs).toHaveBeenCalledExactlyOnceWith(
        { jobIds, confirmRunning: true },
        'user-1',
      )
    else
      expect(bulkDismissJobs).toHaveBeenCalledExactlyOnceWith(
        { jobIds },
        'user-1',
      )
  })
})

describe('bulk retry confirmation', () => {
  it('forwards explicit running confirmation only for selected retries', async () => {
    mockAppSession(true)
    bulkRetryJobs.mockResolvedValue({ queued: 1, skipped: 0, results: [] })
    const { default: app } = await import('@/app')
    const response = await app.request('/api/v1/scrape/jobs/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobIds: ['job-1'], confirmRunning: true }),
    })
    expect(response.status).toBe(200)
    expect(bulkRetryJobs).toHaveBeenCalledExactlyOnceWith(
      { jobIds: ['job-1'], confirmBroadRun: false, confirmRunning: true },
      'user-1',
    )
  })

  it.each(['true', 1])(
    'rejects non-boolean cancellation confirmation: %j',
    async (confirmRunning) => {
      mockAppSession(true)
      const { default: app } = await import('@/app')
      const response = await app.request('/api/v1/scrape/jobs/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobIds: ['job-1'], confirmRunning }),
      })
      expect(response.status).toBe(422)
      expect(bulkCancelJobs).not.toHaveBeenCalled()
    },
  )

  it.each([undefined, false])(
    'passes queued cancellation without running confirmation: %j',
    async (confirmRunning) => {
      mockAppSession(true)
      bulkCancelJobs.mockResolvedValue({
        cancelled: 1,
        skipped: 0,
        results: [{ jobId: 'queued-job', status: 'cancelled' }],
      })
      const { default: app } = await import('@/app')
      const response = await app.request('/api/v1/scrape/jobs/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobIds: ['queued-job'], confirmRunning }),
      })
      expect(response.status).toBe(200)
      expect(bulkCancelJobs).toHaveBeenCalledWith(
        { jobIds: ['queued-job'], confirmRunning: false },
        'user-1',
      )
    },
  )

  it('propagates the preflight confirmation failure as HTTP 422', async () => {
    mockAppSession(true)
    const { ServerError: CurrentServerError } = await import('@/lib/error')
    bulkRetryJobs.mockRejectedValue(
      new CurrentServerError({
        statusCode: 422,
        message: 'Broad scraping must be confirmed',
      }),
    )
    const { default: app } = await import('@/app')
    const response = await app.request('/api/v1/scrape/jobs/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobIds: ['job-1', 'job-2'] }),
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      message: 'Broad scraping must be confirmed',
    })
  })

  it('rejects non-boolean confirmation', async () => {
    mockAppSession(true)
    const { default: app } = await import('@/app')
    const response = await app.request('/api/v1/scrape/jobs/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobIds: ['job-1'], confirmBroadRun: 'true' }),
    })
    expect(response.status).toBe(422)
    expect(bulkRetryJobs).not.toHaveBeenCalled()
  })
})
