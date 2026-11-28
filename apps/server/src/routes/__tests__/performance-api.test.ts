import { describe, expect, it, vi } from 'vitest'

const { getSession, writeRequestLog } = vi.hoisted(() => ({
  getSession: vi.fn(),
  writeRequestLog: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ auth: { api: { getSession } } }))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/env', () => ({
  env: { NODE_ENV: 'test', TRUSTED_ORIGINS: ['https://example.test'] },
}))
vi.mock('@/lib/request-log', async (load) => ({
  ...(await load<typeof import('@/lib/request-log')>()),
  writeRequestLog,
}))

const report = {
  screen: 'albums',
  action: 'open',
  outcome: 'rows',
  durationMs: 120,
}
const ownerSession = {
  user: {
    id: 'example-owner',
    email: 'owner@example.test',
    name: 'Example',
  },
  session: { id: 'example-session', userId: 'example-owner' },
}

async function submit(body: unknown, origin = 'https://example.test') {
  const { default: app } = await import('@/app')
  return app.request('/api/v1/performance/browse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  })
}

describe('browser Browse timings', () => {
  it('accepts only bounded telemetry from an owner browser session', async () => {
    getSession.mockResolvedValue(null)
    expect((await submit(report)).status).toBe(401)
    getSession.mockResolvedValue(ownerSession)
    expect((await submit(report, 'https://other.example')).status).toBe(403)
    for (const body of [
      { ...report, screen: '/albums/example' },
      { ...report, path: '/albums/example' },
      { ...report, durationMs: -1 },
      { ...report, durationMs: 300_001 },
    ])
      expect((await submit(body)).status).toBe(422)
    expect((await submit({ ...report, path: 'x'.repeat(1024) })).status).toBe(
      413,
    )
    expect(writeRequestLog).not.toHaveBeenCalled()
    const response = await submit(report)
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(writeRequestLog).toHaveBeenCalledExactlyOnceWith({
      event: 'browser.browse',
      ...report,
    })
  })

  it('logs which source answered the visible rows', async () => {
    writeRequestLog.mockClear()
    getSession.mockResolvedValue(ownerSession)
    for (const rowSource of ['local', 'cache', 1])
      expect((await submit({ ...report, rowSource })).status).toBe(422)
    expect(writeRequestLog).not.toHaveBeenCalled()
    for (const rowSource of ['device', 'api']) {
      expect((await submit({ ...report, rowSource })).status).toBe(204)
      expect(writeRequestLog).toHaveBeenLastCalledWith({
        event: 'browser.browse',
        ...report,
        rowSource,
      })
    }
  })

  it('logs only consistent phase timings for slow Tracks filter changes with rows', async () => {
    writeRequestLog.mockClear()
    getSession.mockResolvedValue(ownerSession)
    const phased = {
      screen: 'tracks',
      action: 'change',
      outcome: 'rows',
      durationMs: 2_285,
      phases: {
        source: 'request',
        waitMs: 2_000,
        loadMs: 210,
        commitMs: 50,
        paintMs: 25,
      },
    }
    for (const invalid of [
      { ...phased, screen: 'albums' },
      { ...phased, outcome: 'empty' },
      { ...phased, action: 'open' },
      { ...phased, durationMs: 2_300 },
      { ...phased, phases: { ...phased.phases, path: '/tracks' } },
      { ...phased, phases: { ...phased.phases, waitMs: -1 } },
    ])
      expect((await submit(invalid)).status).toBe(422)
    expect(writeRequestLog).not.toHaveBeenCalled()
    expect((await submit(phased)).status).toBe(204)
    expect(writeRequestLog).toHaveBeenCalledExactlyOnceWith({
      event: 'browser.browse',
      ...phased,
    })
  })

  it('accepts bounded document phases on slow row completions', async () => {
    writeRequestLog.mockClear()
    getSession.mockResolvedValue(ownerSession)
    const documentPhases = {
      firstByteMs: 1_900,
      beforePageRequestMs: 3_500,
      pageLoadMs: 550,
      commitMs: 110,
      paintMs: 30,
      firstContentfulPaintMs: 3_250,
    }
    const phased = {
      ...report,
      action: 'document',
      durationMs: 6_090,
      documentPhases,
    }
    for (const invalid of [
      { ...phased, action: 'open' },
      { ...phased, outcome: 'empty' },
      { ...phased, durationMs: 6_100 },
      {
        ...phased,
        durationMs: 100,
        documentPhases: {
          firstByteMs: 10,
          beforePageRequestMs: 30,
          pageLoadMs: 40,
          commitMs: 10,
          paintMs: 10,
        },
      },
      {
        ...phased,
        documentPhases: { ...documentPhases, url: '/albums?q=example' },
      },
      {
        ...phased,
        documentPhases: { ...documentPhases, firstContentfulPaintMs: 6_091 },
      },
    ])
      expect((await submit(invalid)).status).toBe(422)
    expect(writeRequestLog).not.toHaveBeenCalled()
    expect((await submit(phased)).status).toBe(204)
    expect(writeRequestLog).toHaveBeenCalledExactlyOnceWith({
      event: 'browser.browse',
      ...phased,
    })
  })
})
