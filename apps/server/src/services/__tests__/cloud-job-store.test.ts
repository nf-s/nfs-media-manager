import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getOperators, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { scrapeJob } from '@/schemas/db'
import {
  cloudProviderStartsPaused,
  getCloudProviderDispatchPolicy,
  listCloudQueuedJobIds,
} from '@/services/cloud-job-store'

const mocks = vi.hoisted(() => ({
  plugin: vi.fn(),
  state: vi.fn(),
  budget: vi.fn(),
  queued: vi.fn(),
  fixedUsage: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ groupBy: mocks.fixedUsage }) }),
    }),
    query: {
      providerRequestState: { findFirst: mocks.state },
      scrapeJob: { findMany: mocks.queued },
    },
  },
}))
vi.mock('@/plugins/registry', () => ({ getScrapePlugin: mocks.plugin }))
vi.mock('@/services/provider-requests', () => ({
  getProviderBudgetStatus: mocks.budget,
}))

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  mocks.plugin.mockResolvedValue({
    manifest: { rateLimit: { concurrentRequests: true, maxConcurrent: 3 } },
    scrapeMediaItem: vi.fn(),
  })
  mocks.state.mockResolvedValue(undefined)
  mocks.budget.mockResolvedValue(undefined)
  mocks.queued.mockResolvedValue([{ id: 'job' }])
  mocks.fixedUsage.mockResolvedValue([])
})
afterEach(() => vi.useRealTimers())

describe('cloud dispatch preflight', () => {
  it.each([
    { selection: ['selected'], restricted: true },
    { selection: [], restricted: true },
    { selection: null, restricted: false },
    { selection: undefined, restricted: false },
  ])(
    'applies selection $selection inside SQL before the limit',
    async ({ selection, restricted }) => {
      let captured: SQL | undefined
      mocks.queued.mockImplementationOnce(
        async (options: {
          where: (
            table: typeof scrapeJob,
            operators: ReturnType<typeof getOperators>,
          ) => SQL | undefined
        }) => {
          captured = options.where(scrapeJob, getOperators())
          return []
        },
      )
      await listCloudQueuedJobIds('fixture', ['active'], 2, selection)
      if (!captured) throw new Error('Expected queued-job filter')
      const query = new PgDialect().sqlToQuery(captured)
      expect(query.sql).toContain('"scrape_job"."provider" =')
      expect(query.sql).toContain('"scrape_job"."status" =')
      expect(query.sql).toContain('"scrape_job"."id" not in')
      expect(query.params).toEqual(
        selection?.length
          ? ['fixture', 'queued', 'selected', 'active']
          : ['fixture', 'queued', 'active'],
      )
      if (restricted) {
        expect(query.sql).toContain(
          selection?.length ? '"scrape_job"."id" in' : 'false',
        )
      } else {
        expect(query.sql).not.toContain('"scrape_job"."id" in')
        expect(query.sql).not.toContain('false')
      }
      expect(mocks.queued).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 2 }),
      )
    },
  )

  it('uses declared concurrency only for opted-in providers', async () => {
    expect(await getCloudProviderDispatchPolicy('fixture')).toEqual({
      maxConcurrent: 3,
      blocked: false,
      wakeAt: null,
    })
    mocks.plugin.mockResolvedValue({
      manifest: { rateLimit: { maxConcurrent: 3 } },
      scrapeMediaItem: vi.fn(),
    })
    expect(
      (await getCloudProviderDispatchPolicy('fixture')).maxConcurrent,
    ).toBe(1)
  })

  it('does not schedule unsupported providers or clear access halts', async () => {
    mocks.plugin.mockResolvedValueOnce(null)
    expect(await getCloudProviderDispatchPolicy('fixture')).toMatchObject({
      blocked: true,
      wakeAt: null,
    })
    mocks.state.mockResolvedValue({ halted: true })
    expect(await getCloudProviderDispatchPolicy('fixture')).toMatchObject({
      blocked: true,
      wakeAt: null,
    })
    expect(mocks.budget).not.toHaveBeenCalled()
  })

  it('dispatches account-level providers without an item scraper and blocks other task-only plugins', async () => {
    mocks.plugin.mockResolvedValue({
      manifest: { mediaTypes: [], rateLimit: { maxConcurrent: 1 } },
    })
    expect(await getCloudProviderDispatchPolicy('fixture')).toEqual({
      maxConcurrent: 1,
      blocked: false,
      wakeAt: null,
    })
    mocks.state.mockResolvedValue({ halted: true })
    expect(await getCloudProviderDispatchPolicy('fixture')).toMatchObject({
      blocked: true,
      wakeAt: null,
    })
    mocks.state.mockResolvedValue(undefined)
    mocks.plugin.mockResolvedValue({
      manifest: { mediaTypes: ['album'], rateLimit: { maxConcurrent: 1 } },
    })
    expect(await getCloudProviderDispatchPolicy('fixture')).toMatchObject({
      blocked: true,
      wakeAt: null,
    })
  })

  it('starts only account-level providers unpaused', async () => {
    mocks.plugin.mockResolvedValue({ manifest: { mediaTypes: [] } })
    expect(await cloudProviderStartsPaused('fixture')).toBe(false)
    mocks.plugin.mockResolvedValue({
      manifest: { mediaTypes: ['film'] },
      scrapeMediaItem: vi.fn(),
    })
    expect(await cloudProviderStartsPaused('fixture')).toBe(true)
    mocks.plugin.mockResolvedValue(null)
    expect(await cloudProviderStartsPaused('fixture')).toBe(true)
  })

  it('waits for the latest lease, cooldown, or spacing boundary without polling budgets', async () => {
    mocks.state.mockResolvedValue({
      halted: false,
      leaseUntil: new Date(2000),
      cooldownUntil: new Date(3000),
      nextAllowedAt: new Date(4000),
    })
    expect(await getCloudProviderDispatchPolicy('fixture')).toMatchObject({
      blocked: true,
      wakeAt: 4000,
    })
    expect(mocks.budget).not.toHaveBeenCalled()
  })

  it('defers exhausted budgets until their durable reset instead of executing the job', async () => {
    mocks.budget.mockResolvedValue({
      budget: { limit: 100, period: 'day' },
      used: 100,
      resetsAt: new Date(5000).toISOString(),
    })
    expect(await getCloudProviderDispatchPolicy('fixture')).toMatchObject({
      blocked: true,
      wakeAt: 5000,
    })
    mocks.budget.mockResolvedValue({
      budget: { limit: 100, period: 'day' },
      used: 99,
      resetsAt: new Date(5000).toISOString(),
    })
    expect((await getCloudProviderDispatchPolicy('fixture')).blocked).toBe(
      false,
    )
  })

  it('bounds queued-job reads', async () => {
    expect(await listCloudQueuedJobIds('fixture', ['active'], 2)).toEqual([
      'job',
    ])
    expect(mocks.queued).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 2, columns: { id: true } }),
    )
    await expect(listCloudQueuedJobIds('fixture', [], 101)).rejects.toThrow()
    expect(mocks.queued).toHaveBeenCalledOnce()
  })

  it('defers a hard rolling-hour cap without claiming or failing a job', async () => {
    mocks.plugin.mockResolvedValue({
      manifest: { rateLimit: { maxConcurrent: 1, maxRequestsPerHour: 2 } },
      scrapeMediaItem: vi.fn(),
    })
    mocks.state.mockResolvedValue({ requests: [500, 900] })
    expect(await getCloudProviderDispatchPolicy('fixture')).toEqual({
      maxConcurrent: 1,
      blocked: true,
      wakeAt: 3600500,
    })
    expect(mocks.budget).not.toHaveBeenCalled()
    vi.setSystemTime(3600500)
    expect((await getCloudProviderDispatchPolicy('fixture')).blocked).toBe(
      false,
    )
  })

  it.each(['read', 'write'])(
    'defers an exhausted fixed-window %s cap until reset',
    async (requestClass) => {
      mocks.plugin.mockResolvedValue({
        manifest: {
          rateLimit: {
            maxConcurrent: 3,
            concurrentRequests: true,
            fixedWindow: { durationMs: 300000, reads: 1000, writes: 300 },
          },
        },
        scrapeMediaItem: vi.fn(),
      })
      mocks.fixedUsage.mockResolvedValue([
        { requestClass, used: requestClass === 'read' ? 1000 : 300 },
      ])
      expect(await getCloudProviderDispatchPolicy('fixture')).toEqual({
        maxConcurrent: 3,
        blocked: true,
        wakeAt: 300000,
      })
      expect(mocks.budget).not.toHaveBeenCalled()
      mocks.fixedUsage.mockResolvedValue([])
      expect((await getCloudProviderDispatchPolicy('fixture')).blocked).toBe(
        false,
      )
    },
  )
})
