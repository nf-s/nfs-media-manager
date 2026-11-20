import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type {
  MediaPluginManifest,
  MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import {
  JobEntryPageSchema,
  JobListQuerySchema,
  JobPageSchema,
  JobSchema,
  type Job,
} from '@repo/schemas/job'
import type { JsonValue } from '@repo/schemas/common'
import { ProviderOverviewSchema } from '@repo/schemas/provider'
import { env } from '@/env'
import { encryptSecretValue } from '@/lib/crypto'
import type { ProviderCatalogEntry } from '@/lib/provider-catalog'
import { fixedRequestWindow, HOUR_MS } from '@/lib/request-policy'
import * as schema from '@/schemas/db'

vi.mock('@/lib/load-workspace-env', () => ({ loadWorkspaceEnv: () => {} }))

const database = `media_job_ops_test_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
const network = vi.fn(() => {
  throw new Error('Network forbidden in job operation tests')
})

function manifest(
  id: string,
  overrides: Partial<MediaPluginManifest> = {},
): MediaPluginManifest {
  return {
    id,
    displayName: id.replace('fixture-', 'Fixture '),
    description: 'Synthetic provider',
    mediaTypes: ['album'],
    secrets: [],
    rateLimit: { maxConcurrent: 1, minTimeMs: 1000 },
    ...overrides,
  }
}
const scrape = vi.fn<NonNullable<MediaProviderPlugin['scrapeMediaItem']>>()
const plugins = new Map<string, MediaProviderPlugin>(
  [
    manifest('fixture-healthy', {
      secrets: [{ key: 'apiKey', label: 'API key', required: true }],
    }),
    manifest('fixture-keyless', {
      secrets: [{ key: 'apiKey', label: 'API key', required: true }],
    }),
    manifest('fixture-open'),
    manifest('fixture-cooling'),
    manifest('fixture-halted'),
    manifest('fixture-stopped'),
    manifest('fixture-paused'),
    manifest('fixture-selected'),
    manifest('fixture-worker'),
    manifest('fixture-busy'),
    manifest('fixture-budget', {
      rateLimit: {
        maxConcurrent: 1,
        minTimeMs: 1000,
        requestBudget: { period: 'day', limit: 2 },
      },
    }),
    manifest('fixture-hourly', {
      rateLimit: { maxConcurrent: 1, minTimeMs: 1000, maxRequestsPerHour: 1 },
    }),
    manifest('fixture-window', {
      rateLimit: {
        maxConcurrent: 1,
        minTimeMs: 1000,
        fixedWindow: { durationMs: HOUR_MS, reads: 1, writes: 1 },
      },
    }),
    manifest('fixture-account', { mediaTypes: [] }),
  ].map((entry) => [entry.id, { manifest: entry, scrapeMediaItem: scrape }]),
)
function catalogEntry(id: string): ProviderCatalogEntry {
  const plugin = plugins.get(id)
  if (!plugin) throw new Error(`Unknown fixture provider ${id}`)
  return {
    ...plugin.manifest,
    surface: 'provider',
    subscriptions: false,
    mixes: false,
    supportsScrape: true,
    supportsLegacyImport: false,
    pluginPath: null,
  }
}
const catalog = vi.fn<() => Promise<ProviderCatalogEntry[]>>()
const account = vi.fn()

vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async (id: string) => plugins.get(id) ?? null,
  listLoadedScrapePlugins: async () => [...plugins.values()],
  listProviderCatalog: () => catalog(),
}))
vi.mock('@/services/provider-connections', () => ({
  hasAccountSignIn: (id: string) => id === 'fixture-account',
  isAccountProvider: (id: string, mediaTypes: readonly string[]) =>
    id === 'fixture-account' || mediaTypes.length === 0,
  readAccountConnection: (...args: unknown[]) => account(...args),
}))

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', network)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.delete(schema.providerRequestEvent)
  await databaseClient.delete(schema.providerSecret)
  await databaseClient.delete(schema.libraryImport)
  catalog.mockResolvedValue([])
  account.mockReset()
  network.mockClear()
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

const base = Date.parse('2026-11-16T10:00:00.000Z')
async function seedJob(
  id: string,
  provider: string,
  status: Job['status'],
  values: {
    batchId?: string
    createdAt?: number
    finishedAt?: number
    mediaType?: 'album' | 'film'
    options?: Record<string, JsonValue>
  } = {},
) {
  await databaseClient.insert(schema.scrapeJob).values({
    id,
    provider,
    status,
    scope: {
      mediaItemIds: [],
      mediaType: values.mediaType ?? 'album',
      limit: 1,
    },
    options: {
      ...(values.batchId ? { batchId: values.batchId } : {}),
      ...values.options,
    },
    createdAt: new Date(values.createdAt ?? base),
    startedAt:
      status === 'queued' ? null : new Date((values.createdAt ?? base) + 1000),
    finishedAt:
      values.finishedAt !== undefined
        ? new Date(values.finishedAt)
        : status === 'succeeded' ||
            status === 'failed' ||
            status === 'cancelled'
          ? new Date((values.createdAt ?? base) + 2000)
          : null,
  })
}

async function waitingFor(provider: string) {
  const { listJobs } = await import('@/services/jobs')
  const page = JobPageSchema.parse(
    await listJobs({ providers: [provider], statuses: ['queued'] }),
  )
  return page.items[0]?.waiting
}

describe('why queued jobs wait', () => {
  it('reports a healthy provider as queued and leaves other statuses empty', async () => {
    await seedJob('queued-job', 'fixture-healthy', 'queued')
    await seedJob('done-job', 'fixture-healthy', 'succeeded', {
      createdAt: base - 1000,
    })
    const { listJobs } = await import('@/services/jobs')
    const page = JobPageSchema.parse(
      await listJobs({ providers: ['fixture-healthy'] }),
    )
    expect(page.items.map((job) => [job.id, job.waiting])).toEqual([
      [
        'queued-job',
        {
          reason: 'queued',
          until: null,
          detail: 'Queued; nothing is blocking this provider',
        },
      ],
      ['done-job', null],
    ])
  })

  it('derives each provider-state reason from stored request state', async () => {
    const now = Date.now()
    const cooldownUntil = new Date(now + 30 * 60000)
    await databaseClient.insert(schema.providerRequestState).values([
      {
        provider: 'fixture-cooling',
        cooldownUntil,
        lastError: 'Provider rate limit reached (HTTP 429)',
      },
      { provider: 'fixture-halted', halted: true },
      { provider: 'fixture-hourly', requests: [now - 60000] },
    ])
    await databaseClient.insert(schema.providerRequestEvent).values([
      {
        id: 'budget-1',
        provider: 'fixture-budget',
        requestedAt: new Date(now - 1000),
      },
      {
        id: 'budget-2',
        provider: 'fixture-budget',
        requestedAt: new Date(now - 500),
      },
      {
        id: 'window-1',
        provider: 'fixture-window',
        requestedAt: new Date(fixedRequestWindow(HOUR_MS, now).from),
      },
    ])
    for (const provider of [
      'fixture-cooling',
      'fixture-halted',
      'fixture-budget',
      'fixture-hourly',
      'fixture-window',
      'fixture-busy',
      'fixture-missing',
    ])
      await seedJob(`${provider}-queued`, provider, 'queued')
    await seedJob('busy-running', 'fixture-busy', 'running')

    expect(await waitingFor('fixture-cooling')).toEqual({
      reason: 'cooldown',
      until: cooldownUntil.toISOString(),
      detail: 'Cooling down: Provider rate limit reached (HTTP 429)',
    })
    expect(await waitingFor('fixture-halted')).toMatchObject({
      reason: 'access-denied',
      until: null,
    })
    const budget = await waitingFor('fixture-budget')
    expect(budget).toMatchObject({
      reason: 'budget',
      detail: 'Daily request budget used',
    })
    expect(budget?.until?.endsWith('T00:00:00.000Z')).toBe(true)
    expect(await waitingFor('fixture-hourly')).toEqual({
      reason: 'rate-limit',
      until: new Date(now - 60000 + HOUR_MS).toISOString(),
      detail: 'Hourly request limit reached',
    })
    expect(await waitingFor('fixture-window')).toEqual({
      reason: 'rate-limit',
      until: new Date(fixedRequestWindow(HOUR_MS, now).resetsAt).toISOString(),
      detail: 'Request window limit reached',
    })
    expect(await waitingFor('fixture-busy')).toEqual({
      reason: 'concurrency',
      until: null,
      detail: 'Waiting for 1 running job',
    })
    expect(await waitingFor('fixture-missing')).toMatchObject({
      reason: 'not-configured',
      until: null,
    })
  })

  it('reports dispatcher pauses, stops, selections and offline workers', async () => {
    for (const provider of [
      'fixture-stopped',
      'fixture-paused',
      'fixture-worker',
    ])
      await seedJob(`${provider}-queued`, provider, 'queued')
    await seedJob('selected-in', 'fixture-selected', 'queued')
    await seedJob('selected-out', 'fixture-selected', 'queued', {
      createdAt: base + 1000,
    })
    const dispatch = (provider: string) => ({
      provider,
      paused: provider === 'fixture-paused',
      allowedJobIds: provider === 'fixture-selected' ? ['selected-in'] : null,
      stopped: provider === 'fixture-stopped',
      failures: provider === 'fixture-stopped' ? 5 : 0,
      infrastructureFailures: 0,
      slots: [],
    })
    const { withDispatchStatusReader } =
      await import('@/services/dispatch-status')
    const { listJobs } = await import('@/services/jobs')
    const page = JobPageSchema.parse(
      await withDispatchStatusReader(
        async (provider) => ({
          dispatch: dispatch(provider),
          worker:
            provider === 'fixture-worker'
              ? { mode: 'local', paired: true, online: false, blocked: false }
              : null,
        }),
        () => listJobs({ statuses: ['queued'], sortBy: 'createdAt' }),
      ),
    )
    expect(
      Object.fromEntries(page.items.map((job) => [job.id, job.waiting])),
    ).toEqual({
      'fixture-stopped-queued': {
        reason: 'stopped',
        until: null,
        detail: 'Stopped after 5 failed jobs in a row',
      },
      'fixture-paused-queued': {
        reason: 'paused',
        until: null,
        detail: 'Queue paused',
      },
      'fixture-worker-queued': {
        reason: 'worker-offline',
        until: null,
        detail: 'The local worker is offline',
      },
      'selected-in': {
        reason: 'queued',
        until: null,
        detail: 'Queued; nothing is blocking this provider',
      },
      'selected-out': {
        reason: 'paused',
        until: null,
        detail: 'Not in the jobs selected to run',
      },
    })
  })

  it('normalizes task progress and leaves ordinary jobs without progress', async () => {
    await seedJob('task-job', 'fixture-account', 'running', {
      options: {
        task: 'fixture-account-sync',
        progress: { pagesRead: 3, totalPages: null },
      },
    })
    await seedJob('item-job', 'fixture-healthy', 'succeeded', {
      createdAt: base - 1000,
    })
    const { listJobs } = await import('@/services/jobs')
    const page = JobPageSchema.parse(await listJobs({}))
    expect(page.items.map((job) => [job.id, job.progress])).toEqual([
      ['task-job', { done: 3, total: null }],
      ['item-job', null],
    ])
  })

  it('leads job detail with a summary derived from the stored error and provider state', async () => {
    await databaseClient.insert(schema.providerRequestState).values({
      provider: 'fixture-cooling',
      cooldownUntil: new Date(Date.now() + 60000),
      lastError: 'Provider rate limit reached (HTTP 429)',
    })
    await seedJob('limited', 'fixture-cooling', 'failed')
    await databaseClient.insert(schema.scrapeJobLog).values({
      id: 'limited-log',
      jobId: 'limited',
      level: 'error',
      message: 'ProviderRequestError: Provider rate limit reached (HTTP 429)',
      metadata: {
        error: {
          name: 'ProviderRequestError',
          message: 'Provider rate limit reached (HTTP 429)',
          stack: null,
          code: 'rate-limit',
          retryAt: Date.parse('2026-11-16T14:20:00.000Z'),
          causes: [],
        },
      },
    })
    const { getJob } = await import('@/services/jobs')
    const job = JobSchema.parse(await getJob('limited'))
    expect(job.summary).toEqual({
      headline: 'The provider rate limited this request',
      code: 'rate-limit',
      retryAt: '2026-11-16T14:20:00.000Z',
      actions: ['resume-provider', 'open-provider'],
    })
    expect(job.waiting).toBeNull()
  })
})

describe('job entries', () => {
  async function seedBatches() {
    // Batch of three on one provider: one queued, nothing running.
    await seedJob('a-1', 'fixture-healthy', 'succeeded', {
      batchId: 'batch-a',
      createdAt: base,
    })
    await seedJob('a-2', 'fixture-healthy', 'failed', {
      batchId: 'batch-a',
      createdAt: base + 1000,
    })
    await seedJob('a-3', 'fixture-healthy', 'queued', {
      batchId: 'batch-a',
      createdAt: base + 2000,
    })
    // Batch across two providers, one running, films.
    await seedJob('b-1', 'fixture-open', 'running', {
      batchId: 'batch-b',
      createdAt: base + 5000,
      mediaType: 'film',
    })
    await seedJob('b-2', 'fixture-cooling', 'queued', {
      batchId: 'batch-b',
      createdAt: base + 6000,
      mediaType: 'film',
    })
    // A batch of one stays a job row.
    await seedJob('solo', 'fixture-open', 'failed', {
      batchId: 'batch-solo',
      createdAt: base + 3000,
    })
    await seedJob('plain', 'fixture-open', 'succeeded', {
      createdAt: base + 4000,
    })
  }
  const keys = (page: ReturnType<typeof JobEntryPageSchema.parse>) =>
    page.items.map((entry) =>
      entry.kind === 'job' ? entry.job.id : entry.batchId,
    )

  it('groups batches of several jobs and keeps a batch of one as a job', async () => {
    await seedBatches()
    await databaseClient.insert(schema.libraryImport).values({
      id: 'import-a',
      status: 'succeeded',
      stage: 'Done',
      result: { albums: 3, films: 0, jobBatchId: 'batch-a' },
    })
    const { listJobEntries } = await import('@/services/job-entries')
    const page = JobEntryPageSchema.parse(await listJobEntries({}))
    expect(keys(page)).toEqual(['batch-b', 'plain', 'solo', 'batch-a'])
    expect(page.totalCount).toBe(4)
    const batchA = page.items.find(
      (entry) => entry.kind === 'batch' && entry.batchId === 'batch-a',
    )
    expect(batchA).toEqual({
      kind: 'batch',
      batchId: 'batch-a',
      provider: 'fixture-healthy',
      providers: ['fixture-healthy'],
      mediaType: 'album',
      label: 'Library import',
      importId: 'import-a',
      total: 3,
      matching: 3,
      queued: 1,
      running: 0,
      succeeded: 1,
      failed: 1,
      cancelled: 0,
      createdAt: new Date(base).toISOString(),
      startedAt: new Date(base + 1000).toISOString(),
      finishedAt: null,
      waiting: {
        reason: 'queued',
        until: null,
        detail: 'Queued; nothing is blocking this provider',
      },
    })
    const batchB = page.items.find(
      (entry) => entry.kind === 'batch' && entry.batchId === 'batch-b',
    )
    expect(batchB).toMatchObject({
      provider: null,
      providers: ['fixture-cooling', 'fixture-open'],
      mediaType: 'film',
      running: 1,
      waiting: null,
    })
    const solo = page.items.find(
      (entry) => entry.kind === 'job' && entry.job.id === 'solo',
    )
    expect(solo?.kind === 'job' && solo.job.options.batchId).toBe('batch-solo')
  })

  it('applies filters before grouping and paginating', async () => {
    await seedBatches()
    const { listJobEntries } = await import('@/services/job-entries')
    const failed = JobEntryPageSchema.parse(
      await listJobEntries({ statuses: ['failed'] }),
    )
    expect(keys(failed)).toEqual(['solo', 'batch-a'])
    expect(failed.items[1]).toMatchObject({ total: 3, matching: 1 })
    const films = JobEntryPageSchema.parse(
      await listJobEntries({ mediaType: 'film' }),
    )
    expect(keys(films)).toEqual(['batch-b'])
    const provider = JobEntryPageSchema.parse(
      await listJobEntries({ providers: ['fixture-cooling'] }),
    )
    expect(keys(provider)).toEqual(['batch-b'])
    expect(provider.items[0]).toMatchObject({ total: 2, matching: 1 })
    const search = JobEntryPageSchema.parse(await listJobEntries({ q: 'sol' }))
    expect(keys(search)).toEqual(['solo'])
    const active = JobEntryPageSchema.parse(
      await listJobEntries({ statuses: ['active'], size: 1, page: 2 }),
    )
    expect(active.totalCount).toBe(2)
    expect(keys(active)).toEqual(['batch-a'])
  })

  it('sorts batch rows by their aggregate value in both directions', async () => {
    await seedBatches()
    const { listJobEntries } = await import('@/services/job-entries')
    const byStatus = JobEntryPageSchema.parse(
      await listJobEntries({ sortBy: 'status', direction: 'asc' }),
    )
    // failed (solo), queued (batch-a), running (batch-b), succeeded (plain)
    expect(keys(byStatus)).toEqual(['solo', 'batch-a', 'batch-b', 'plain'])
    const byCreated = JobEntryPageSchema.parse(
      await listJobEntries({ sortBy: 'createdAt', direction: 'asc' }),
    )
    expect(keys(byCreated)).toEqual(['batch-a', 'solo', 'plain', 'batch-b'])
  })

  it('keeps single-job batches in job order and counts entries past the last page', async () => {
    await seedJob('active-solo', 'fixture-open', 'queued', {
      batchId: 'solo-batch',
      finishedAt: base + 5000,
    })
    await seedJob('active-batch-member', 'fixture-open', 'queued', {
      batchId: 'active-batch',
    })
    await seedJob('finished-batch-member', 'fixture-open', 'succeeded', {
      batchId: 'active-batch',
      finishedAt: base + 6000,
    })
    await seedJob('ordinary-job', 'fixture-open', 'succeeded')
    const { listJobEntries } = await import('@/services/job-entries')
    const input = JobListQuerySchema.parse({ sortBy: 'finishedAt', size: 2 })
    const first = JobEntryPageSchema.parse(await listJobEntries(input))
    expect(keys(first)).toEqual(['active-solo', 'ordinary-job'])
    const second = JobEntryPageSchema.parse(
      await listJobEntries({ ...input, page: 2 }),
    )
    expect(second.items).toMatchObject([
      { kind: 'batch', batchId: 'active-batch', total: 2, matching: 2 },
    ])
    expect(await listJobEntries({ ...input, page: 3 })).toMatchObject({
      items: [],
      totalCount: 3,
      pageCount: 2,
    })
  })

  it('breaks ties on the entry key across a page boundary', async () => {
    for (const id of ['tie-a', 'tie-b', 'tie-c'])
      await seedJob(id, 'fixture-open', 'succeeded', { createdAt: base })
    await seedJob('tie-batch-1', 'fixture-open', 'succeeded', {
      batchId: 'tie-batch',
      createdAt: base,
    })
    await seedJob('tie-batch-2', 'fixture-open', 'succeeded', {
      batchId: 'tie-batch',
      createdAt: base + 1000,
    })
    const { listJobEntries } = await import('@/services/job-entries')
    const directions: ('asc' | 'desc')[] = ['asc', 'desc']
    for (const direction of directions) {
      const pages = await Promise.all(
        [1, 2].map(async (page) =>
          keys(
            JobEntryPageSchema.parse(
              await listJobEntries({
                sortBy: 'createdAt',
                direction,
                size: 2,
                page,
              }),
            ),
          ),
        ),
      )
      const expected = ['tie-a', 'tie-b', 'tie-batch', 'tie-c']
      expect(pages.flat()).toEqual(
        direction === 'asc' ? expected : [...expected].reverse(),
      )
    }
  })
})

describe('providers overview', () => {
  it('composes connection, queue, jobs, budget and hourly requests without secrets', async () => {
    const now = Date.now()
    catalog.mockResolvedValue(
      [
        'fixture-account',
        'fixture-budget',
        'fixture-cooling',
        'fixture-healthy',
        'fixture-keyless',
        'fixture-open',
        'fixture-paused',
      ].map(catalogEntry),
    )
    account.mockResolvedValue({ configured: true, connected: false })
    const secretValue = 'synthetic-secret-value-1234'
    await databaseClient.insert(schema.providerSecret).values({
      id: 'secret-healthy',
      provider: 'fixture-healthy',
      key: 'apiKey',
      encryptedValue: encryptSecretValue(secretValue),
    })
    const cooldownUntil = new Date(now + 20 * 60000)
    await databaseClient.insert(schema.providerRequestState).values({
      provider: 'fixture-cooling',
      cooldownUntil,
      lastError: 'Provider rate limit reached (HTTP 429)',
    })
    await databaseClient.insert(schema.providerRequestEvent).values([
      {
        id: 'event-old',
        provider: 'fixture-healthy',
        requestedAt: new Date(now - 25 * HOUR_MS),
      },
      {
        id: 'event-first',
        provider: 'fixture-healthy',
        requestedAt: new Date(now - 24 * HOUR_MS + 60000),
      },
      {
        id: 'event-last-1',
        provider: 'fixture-healthy',
        requestedAt: new Date(now - 60000),
      },
      {
        id: 'event-last-2',
        provider: 'fixture-healthy',
        requestedAt: new Date(now - 30000),
      },
      {
        id: 'event-budget',
        provider: 'fixture-budget',
        requestedAt: new Date(now - 1000),
      },
    ])
    await seedJob('healthy-done', 'fixture-healthy', 'succeeded', {
      finishedAt: base + 9000,
    })
    await seedJob('healthy-failed', 'fixture-healthy', 'failed')
    await seedJob('healthy-running', 'fixture-healthy', 'running')
    await seedJob('cooling-queued', 'fixture-cooling', 'queued')

    const { withDispatchStatusReader } =
      await import('@/services/dispatch-status')
    const { getProvidersOverview } =
      await import('@/services/providers-overview')
    const response = await withDispatchStatusReader(
      async (provider) => ({
        dispatch: {
          provider,
          paused: provider === 'fixture-paused',
          allowedJobIds: null,
          stopped: false,
          failures: 0,
          infrastructureFailures: 0,
          slots: [],
        },
        worker: null,
      }),
      () => getProvidersOverview({}, 'user-1'),
    )
    const overview = ProviderOverviewSchema.parse(response)
    const byId = new Map(overview.providers.map((item) => [item.id, item]))

    const healthy = byId.get('fixture-healthy')
    expect(healthy).toMatchObject({
      group: 'metadata',
      roles: ['album'],
      connection: { state: 'connected', method: 'key', detail: 'Key set' },
      queue: { state: 'running', reason: null, until: null, detail: null },
      jobs: { queued: 0, running: 1, failed: 1, attention: 1 },
      lastSuccessAt: new Date(base + 9000).toISOString(),
      budget: null,
      runsOn: 'server',
      worker: null,
      concurrency: 1,
    })
    expect(healthy?.requests24h).toHaveLength(24)
    expect(healthy?.requests24h[0]).toBe(1)
    expect(healthy?.requests24h[23]).toBe(2)
    expect(healthy?.requests24h.reduce((sum, count) => sum + count, 0)).toBe(3)

    expect(byId.get('fixture-keyless')?.connection).toEqual({
      state: 'needs-key',
      method: 'key',
      detail: 'Add the required credentials',
    })
    expect(byId.get('fixture-open')?.connection.state).toBe('not-required')
    expect(byId.get('fixture-account')).toMatchObject({
      group: 'account',
      roles: ['account'],
      connection: {
        state: 'needs-sign-in',
        method: 'account',
        detail: 'Not signed in',
      },
    })
    expect(account).toHaveBeenCalledWith('fixture-account', 'user-1')
    expect(byId.get('fixture-paused')?.queue).toEqual({
      state: 'paused',
      reason: 'paused',
      until: null,
      detail: 'Queue paused',
    })
    expect(byId.get('fixture-cooling')).toMatchObject({
      queue: {
        state: 'waiting',
        reason: 'cooldown',
        until: cooldownUntil.toISOString(),
        detail: 'Cooling down: Provider rate limit reached (HTTP 429)',
      },
      jobs: { queued: 1, running: 0, failed: 0, attention: 0 },
    })
    expect(byId.get('fixture-budget')?.budget).toMatchObject({
      used: 1,
      limit: 2,
      period: 'day',
    })

    const text = JSON.stringify(overview)
    const [stored] = await databaseClient.select().from(schema.providerSecret)
    expect(text).not.toContain(secretValue)
    expect(text).not.toContain(secretValue.slice(-8))
    expect(stored && text.includes(stored.encryptedValue)).toBe(false)
    expect(network).not.toHaveBeenCalled()
  })

  it('scopes providers to a library like the Providers page', async () => {
    catalog.mockResolvedValue(
      ['fixture-account', 'fixture-healthy'].map(catalogEntry),
    )
    const { getProvidersOverview } =
      await import('@/services/providers-overview')
    const films = ProviderOverviewSchema.parse(
      await getProvidersOverview({ mediaType: 'film' }, null),
    )
    expect(films.providers.map((item) => item.id)).toEqual(['fixture-account'])
    expect(films.providers[0]?.connection.state).toBe('unavailable')
    const albums = ProviderOverviewSchema.parse(
      await getProvidersOverview({ mediaType: 'album' }, null),
    )
    expect(albums.providers.map((item) => item.id)).toEqual([
      'fixture-account',
      'fixture-healthy',
    ])
  })
})
