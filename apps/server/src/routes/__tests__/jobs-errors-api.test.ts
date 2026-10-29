import { afterEach, describe, expect, it, vi } from 'vitest'

const markJobErrorBenign = vi.fn()

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
    createJob: vi.fn(),
    createRescrapeJob: vi.fn(),
    getJob: vi.fn(),
    listJobs: vi.fn(),
    getJobActivity: vi.fn(),
    retryJob: vi.fn(),
    markJobErrorBenign,
  }))
}

describe('job error reviews api', () => {
  afterEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
  })

  it('requires authentication before reviewing an error', async () => {
    mockAppSession(false)
    const { default: app } = await import('@/app')
    const response = await app.request(
      'http://localhost/api/v1/scrape/jobs/job/logs/log/benign',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      },
    )
    expect(response.status).toBe(401)
    expect(markJobErrorBenign).not.toHaveBeenCalled()
  })
  it('requires confirmation and passes only the selected log and authenticated actor to the service', async () => {
    mockAppSession(true)
    const { default: app } = await import('@/app')
    for (const body of [{}, { confirm: false }]) {
      const response = await app.request(
        'http://localhost/api/v1/scrape/jobs/job/logs/log/benign',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      expect(response.status).toBe(422)
    }
    expect(markJobErrorBenign).not.toHaveBeenCalled()
    markJobErrorBenign.mockResolvedValue({ id: 'job' })
    const response = await app.request(
      'http://localhost/api/v1/scrape/jobs/job/logs/log/benign',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true, userId: 'forged' }),
      },
    )
    expect(response.status).toBe(200)
    expect(markJobErrorBenign).toHaveBeenCalledWith('job', 'log', 'user-1')
  })
})
