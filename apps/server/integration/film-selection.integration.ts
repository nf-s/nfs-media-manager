import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  PluginResultSchema,
  type MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import {
  FilmSelectionPageSchema,
  FilmSelectionQuerySchema,
  QueueFilmSelectionSchema,
} from '@repo/schemas/film-selection'
import { JobScopeSchema, type Job } from '@repo/schemas/job'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { createCatalogEntryFromPlugin } from '@/lib/provider-catalog'

const database = `film_selection_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
const execute = vi.fn<NonNullable<MediaProviderPlugin['scrapeMediaItem']>>()
const plugins: MediaProviderPlugin[] = ['fixture-a', 'fixture-b'].map((id) => ({
  manifest: {
    id,
    displayName: id,
    description: '',
    mediaTypes: ['film'],
    identifierTypes: ['imdb'],
    secrets: [],
    rateLimit: { maxConcurrent: 1, minTimeMs: 2000 },
    maxItemsPerJob: 1,
    requireExplicitSelection: true,
  },
  scrapeMediaItem: execute,
}))
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => plugins,
  getScrapePlugin: async (id: string) =>
    plugins.find((plugin) => plugin.manifest.id === id) ?? null,
  listProviderCatalog: async () =>
    plugins.map((plugin) => createCatalogEntryFromPlugin(plugin, null)),
}))
let created = false
beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No network in selection tests')
    }),
  )
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.providerSnapshot)
  for (let i = 0; i < 8; i++) {
    const id = `film-${i}`
    await databaseClient.insert(schema.mediaItem).values({
      id,
      slug: id,
      title: `Film ${i}`,
      mediaType: 'film',
      metadata: { browse: { country: i % 2 ? ['France'] : ['Japan'] } },
    })
    await databaseClient
      .insert(schema.film)
      .values({ mediaItemId: id, dateAdded: new Date(`2020-01-0${i + 1}`) })
    if (i !== 7)
      await databaseClient.insert(schema.providerReference).values({
        id,
        mediaItemId: id,
        provider: 'imdb',
        referenceType: 'imdb',
        externalId: `tt123456${i}`,
      })
  }
})
afterAll(async () => {
  expect(execute).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})
async function state(id: string, provider: string, date: Date | null) {
  await databaseClient.insert(schema.providerCurrentState).values({
    id: `${id}-${provider}`,
    mediaItemId: id,
    provider,
    checksum: 'fixture',
    payload: {},
    status: 'succeeded',
    lastSuccessfulAt: new Date(),
    lastScrapedAt: date,
  })
}

async function attempt(
  jobId: string,
  mediaItemId: string,
  status: Job['status'],
  startedAt: Date | null,
  provider = 'fixture-a',
  mediaType: 'album' | 'film' = 'film',
) {
  const finishedAt =
    status === 'queued' || status === 'running'
      ? null
      : new Date((startedAt?.getTime() ?? Date.UTC(2024, 5, 1)) + 1000)
  await databaseClient.insert(schema.scrapeJob).values({
    id: jobId,
    provider,
    status,
    scope: { mediaType, mediaItemIds: [mediaItemId], limit: 1 },
    options: {},
    startedAt,
    finishedAt,
    errorMessage: 'Job-level message is not the item error',
  })
  await databaseClient.insert(schema.scrapeJobItem).values({
    id: `${jobId}-item`,
    jobId,
    mediaItemId,
    provider,
    status,
    startedAt,
    finishedAt,
    message: `${jobId} message`,
  })
}

describe('film selection and safe scheduling', () => {
  it('shows the latest started failure without replacing prior success or another provider', async () => {
    const { listFilmSelection } = await import('@/services/film-selection')
    await state('film-0', 'fixture-a', new Date('2024-02-01'))
    await attempt('success', 'film-0', 'succeeded', new Date('2024-02-01'))
    await attempt('latest-failure', 'film-0', 'failed', new Date('2024-03-01'))
    await attempt('older-failure', 'film-0', 'failed', new Date('2024-02-15'))
    await attempt('queued-retry', 'film-0', 'queued', null)
    await attempt(
      'queued-with-start-date',
      'film-0',
      'queued',
      new Date('2024-05-01'),
    )
    await attempt('cancelled-before-start', 'film-0', 'cancelled', null)
    await state('film-0', 'fixture-b', new Date('2024-04-01'))
    await attempt(
      'other-provider',
      'film-0',
      'succeeded',
      new Date('2024-04-01'),
      'fixture-b',
    )

    const result = FilmSelectionPageSchema.parse(
      await listFilmSelection(
        FilmSelectionQuerySchema.parse({ provider: 'fixture-a', q: 'Film 0' }),
      ),
    )
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.lastScrapedAt).toBe('2024-02-01T00:00:00.000Z')
    expect(result.items[0]?.providerFreshness).toEqual({
      'fixture-a': {
        lastScrapedAt: '2024-02-01T00:00:00.000Z',
        hasProviderIdentifier: true,
        lastAttempt: {
          status: 'failed',
          startedAt: '2024-03-01T00:00:00.000Z',
          finishedAt: '2024-03-01T00:00:01.000Z',
          error: 'latest-failure message',
          jobId: 'latest-failure',
        },
      },
      'fixture-b': {
        lastScrapedAt: '2024-04-01T00:00:00.000Z',
        hasProviderIdentifier: true,
        lastAttempt: {
          status: 'succeeded',
          startedAt: '2024-04-01T00:00:00.000Z',
          finishedAt: '2024-04-01T00:00:01.000Z',
          error: null,
          jobId: 'other-provider',
        },
      },
    })
    const failed = await listFilmSelection(
      FilmSelectionQuerySchema.parse({
        freshness: [{ provider: 'fixture-a', mode: 'failed' }],
      }),
    )
    expect(failed.items.map((item) => item.id)).toEqual(['film-0'])
  })
  it.each(['running', 'succeeded', 'cancelled'] satisfies Job['status'][])(
    'stops matching failed after a newer %s attempt',
    async (status) => {
      const { listFilmSelection } = await import('@/services/film-selection')
      const query = FilmSelectionQuerySchema.parse({
        freshness: [{ provider: 'fixture-a', mode: 'failed' }],
      })
      await attempt('failure', 'film-0', 'failed', new Date('2024-02-01'))
      expect(
        (await listFilmSelection(query)).items.map((item) => item.id),
      ).toEqual(['film-0'])
      await attempt('retry', 'film-0', status, new Date('2024-03-01'))
      if (status === 'succeeded')
        await state('film-0', 'fixture-a', new Date('2024-03-01'))
      expect((await listFilmSelection(query)).totalCount).toBe(0)
      const result = await listFilmSelection(
        FilmSelectionQuerySchema.parse({ provider: 'fixture-a', q: 'Film 0' }),
      )
      expect(
        result.items[0]?.providerFreshness['fixture-a']?.lastAttempt,
      ).toEqual({
        status,
        startedAt: '2024-03-01T00:00:00.000Z',
        finishedAt: status === 'running' ? null : '2024-03-01T00:00:01.000Z',
        error: status === 'cancelled' ? 'retry message' : null,
        jobId: 'retry',
      })
      expect(result.items[0]?.lastScrapedAt).toBe(
        status === 'succeeded' ? '2024-03-01T00:00:00.000Z' : null,
      )
    },
  )
  it('distinguishes never attempted from unscraped, ignoring queued work and import-only state', async () => {
    const { listFilmSelection } = await import('@/services/film-selection')
    const { applyProviderResult } = await import('@/services/provider-state')
    for (const [index, status] of (
      ['failed', 'running', 'cancelled', 'succeeded'] satisfies Job['status'][]
    ).entries())
      await attempt(
        `started-${status}`,
        `film-${index}`,
        status,
        new Date('2024-02-01'),
      )
    await attempt('queued', 'film-4', 'queued', null)
    await attempt('cancelled-unstarted', 'film-5', 'cancelled', null)
    await applyProviderResult({
      mediaItemId: 'film-6',
      mediaType: 'film',
      provider: 'fixture-a',
      source: 'legacy-import',
      ...PluginResultSchema.parse({
        payload: { imported: true },
        normalized: {},
      }),
    })
    await state('film-7', 'fixture-a', new Date('2024-02-01'))
    const never = await listFilmSelection(
      FilmSelectionQuerySchema.parse({
        freshness: [{ provider: 'fixture-a', mode: 'never' }],
      }),
    )
    expect(never.items.map((item) => item.id).sort()).toEqual([
      'film-4',
      'film-5',
      'film-6',
    ])
    for (const item of never.items)
      expect(item.providerFreshness['fixture-a']).toMatchObject({
        lastScrapedAt: null,
        lastAttempt: null,
      })
    const unscraped = await listFilmSelection(
      FilmSelectionQuerySchema.parse({
        freshness: [{ provider: 'fixture-a', mode: 'unscraped' }],
      }),
    )
    expect(unscraped.items.map((item) => item.id).sort()).toEqual(
      Array.from({ length: 7 }, (_, index) => `film-${index}`),
    )
    const otherProvider = await listFilmSelection(
      FilmSelectionQuerySchema.parse({
        freshness: [{ provider: 'fixture-b', mode: 'never' }],
      }),
    )
    expect(otherProvider.totalCount).toBe(8)
  })
  it('filters failed and unscraped per provider before pagination and excludes albums', async () => {
    const { listFilmSelection, queueFilmSelection } =
      await import('@/services/film-selection')
    await databaseClient.insert(schema.mediaItem).values({
      id: 'other-album',
      slug: 'other-album',
      title: 'Other album',
      mediaType: 'album',
    })
    await databaseClient
      .insert(schema.album)
      .values({ mediaItemId: 'other-album' })
    await attempt(
      'album-failure',
      'other-album',
      'failed',
      new Date('2024-02-01'),
      'fixture-a',
      'album',
    )
    await attempt('first-failure', 'film-0', 'failed', new Date('2024-02-01'))
    await state('film-0', 'fixture-b', new Date('2024-02-01'))
    await attempt(
      'provider-b-failure',
      'film-1',
      'failed',
      new Date('2024-02-01'),
      'fixture-b',
    )
    await attempt('second-failure', 'film-2', 'failed', new Date('2024-03-01'))
    await state('film-2', 'fixture-a', new Date('2024-02-01'))

    const query = FilmSelectionQuerySchema.parse({
      freshness: [{ provider: 'fixture-a', mode: 'failed' }],
      sortBy: 'title',
      direction: 'asc',
      size: 1,
    })
    const first = await listFilmSelection(query)
    expect(first.totalCount).toBe(2)
    expect(first.pageCount).toBe(2)
    expect(first.items.map((item) => item.id)).toEqual(['film-0'])
    expect(
      (await listFilmSelection({ ...query, page: 2 })).items.map(
        (item) => item.id,
      ),
    ).toEqual(['film-2'])
    const second = await listFilmSelection(
      FilmSelectionQuerySchema.parse({
        freshness: [{ provider: 'fixture-b', mode: 'failed' }],
      }),
    )
    expect(second.items.map((item) => item.id)).toEqual(['film-1'])
    for (const [provider, excluded] of [
      ['fixture-a', 'film-2'],
      ['fixture-b', 'film-0'],
    ]) {
      const result = await listFilmSelection(
        FilmSelectionQuerySchema.parse({
          freshness: [{ provider, mode: 'unscraped' }],
        }),
      )
      expect(result.totalCount).toBe(7)
      expect(result.items.map((item) => item.id).sort()).toEqual(
        Array.from({ length: 8 }, (_, index) => `film-${index}`).filter(
          (id) => id !== excluded,
        ),
      )
    }
    const combined = await listFilmSelection(
      FilmSelectionQuerySchema.parse({
        freshness: [
          { provider: 'fixture-a', mode: 'failed' },
          { provider: 'fixture-b', mode: 'unscraped' },
        ],
      }),
    )
    expect(combined.items.map((item) => item.id)).toEqual(['film-2'])
    await expect(
      queueFilmSelection(
        QueueFilmSelectionSchema.parse({
          providers: ['fixture-a'],
          mediaItemIds: ['other-album'],
          freshness: [{ provider: 'fixture-a', mode: 'failed' }],
          batchId: randomUUID(),
        }),
        null,
      ),
    ).rejects.toThrow()
    expect(
      await databaseClient
        .select()
        .from(schema.scrapeJob)
        .where(eq(schema.scrapeJob.status, 'queued')),
    ).toHaveLength(0)
  })
  it.each([
    { mode: 'never', expected: ['film-3', 'film-4', 'film-6'] },
    { mode: 'failed', expected: ['film-0', 'film-5'] },
    {
      mode: 'unscraped',
      expected: ['film-0', 'film-1', 'film-3', 'film-4', 'film-6'],
    },
  ])(
    'queues only matching $mode provider pairs',
    async ({ mode, expected }) => {
      const { queueFilmSelection } = await import('@/services/film-selection')
      await attempt('failed', 'film-0', 'failed', new Date('2024-02-01'))
      await attempt(
        'cancelled-started',
        'film-1',
        'cancelled',
        new Date('2024-02-01'),
      )
      await attempt('succeeded', 'film-2', 'succeeded', new Date('2024-02-01'))
      await state('film-2', 'fixture-a', new Date('2024-02-01'))
      await attempt('cancelled-unstarted', 'film-3', 'cancelled', null)
      await state('film-4', 'fixture-a', null)
      await state('film-5', 'fixture-a', new Date('2024-02-01'))
      await attempt(
        'failed-after-success',
        'film-5',
        'failed',
        new Date('2024-03-01'),
      )
      const result = await queueFilmSelection(
        QueueFilmSelectionSchema.parse({
          providers: ['fixture-a'],
          mediaItemIds: Array.from(
            { length: 7 },
            (_, index) => `film-${index}`,
          ),
          freshness: [{ provider: 'fixture-a', mode }],
          confirmBroadRun: true,
          batchId: randomUUID(),
        }),
        null,
      )
      expect(result.queued).toBe(expected.length)
      expect(result.skipped).toBe(7 - expected.length)
      const queued = await databaseClient
        .select()
        .from(schema.scrapeJobItem)
        .where(eq(schema.scrapeJobItem.status, 'queued'))
      expect(queued.map((item) => item.mediaItemId).sort()).toEqual(expected)
      expect(queued.every((item) => item.provider === 'fixture-a')).toBe(true)
    },
  )
  it.each(['never', 'failed', 'unscraped'])(
    'rechecks %s freshness after preview independently for each provider',
    async (mode) => {
      const { listFilmSelection, queueFilmSelection } =
        await import('@/services/film-selection')
      if (mode === 'failed') {
        await attempt('failed-a', 'film-0', 'failed', new Date('2024-02-01'))
        await attempt(
          'failed-b',
          'film-0',
          'failed',
          new Date('2024-02-01'),
          'fixture-b',
        )
      }
      const freshness = ['fixture-a', 'fixture-b'].map((provider) => ({
        provider,
        mode,
      }))
      const preview = await listFilmSelection(
        FilmSelectionQuerySchema.parse({ q: 'Film 0', freshness }),
      )
      expect(preview.items.map((item) => item.id)).toEqual(['film-0'])
      await attempt(
        'after-preview',
        'film-0',
        mode === 'never' ? 'failed' : 'succeeded',
        new Date('2024-03-01'),
      )
      if (mode !== 'never')
        await state('film-0', 'fixture-a', new Date('2024-03-01'))
      const result = await queueFilmSelection(
        QueueFilmSelectionSchema.parse({
          providers: ['fixture-a', 'fixture-b'],
          mediaItemIds: preview.items.map((item) => item.id),
          freshness,
          batchId: randomUUID(),
        }),
        null,
      )
      expect(result).toMatchObject({ queued: 1, skipped: 1 })
      const queued = await databaseClient
        .select()
        .from(schema.scrapeJobItem)
        .where(eq(schema.scrapeJobItem.status, 'queued'))
      expect(queued).toHaveLength(1)
      expect(queued[0]).toMatchObject({
        mediaItemId: 'film-0',
        provider: 'fixture-b',
      })
    },
  )
  it('uses successful scrape dates only and keeps freshness provider-specific', async () => {
    const { listFilmSelection } = await import('@/services/film-selection')
    await state('film-0', 'fixture-a', new Date('2020-02-01'))
    await state('film-1', 'fixture-a', null)
    await state('film-0', 'fixture-b', new Date('2024-02-01'))
    const first = await listFilmSelection(
      FilmSelectionQuerySchema.parse({
        provider: 'fixture-a',
        sortBy: 'lastScrapedAt',
        direction: 'asc',
      }),
    )
    expect(first.items[0]?.lastScrapedAt).toBeNull()
    expect(first.items.at(-1)?.id).toBe('film-0')
    expect(
      first.items.find((item) => item.id === 'film-1')?.lastScrapedAt,
    ).toBeNull()
    const second = await listFilmSelection(
      FilmSelectionQuerySchema.parse({ provider: 'fixture-b' }),
    )
    expect(
      second.items.find((item) => item.id === 'film-0')?.lastScrapedAt,
    ).toBe('2024-02-01T00:00:00.000Z')
  })
  it('preserves scrape freshness when an import updates provider state', async () => {
    const { applyProviderResult } = await import('@/services/provider-state')
    const { listFilmSelection } = await import('@/services/film-selection')
    await state('film-0', 'fixture-a', new Date('2020-02-01'))
    await applyProviderResult({
      mediaItemId: 'film-0',
      mediaType: 'film',
      provider: 'fixture-a',
      source: 'legacy-import',
      ...PluginResultSchema.parse({
        payload: { imported: true },
        normalized: {},
      }),
    })
    const result = await listFilmSelection(
      FilmSelectionQuerySchema.parse({ provider: 'fixture-a' }),
    )
    expect(
      result.items.find((item) => item.id === 'film-0')?.lastScrapedAt,
    ).toBe('2020-02-01T00:00:00.000Z')
  })
  it('supports browse filtering, Added sorting, search and pagination with missing IDs marked', async () => {
    const { listFilmSelection } = await import('@/services/film-selection')
    const result = await listFilmSelection(
      FilmSelectionQuerySchema.parse({
        provider: 'fixture-a',
        filters: JSON.stringify([
          { field: 'country', value: 'France', mode: 'required' },
        ]),
        size: 2,
        sortBy: 'dateAdded',
        direction: 'desc',
      }),
    )
    expect(result.totalCount).toBe(4)
    expect(result.items.map((item) => item.id)).toEqual(['film-7', 'film-5'])
    expect(result.items[0]?.hasProviderIdentifier).toBe(false)
    expect(result.items[1]?.hasProviderIdentifier).toBe(true)
    const searched = await listFilmSelection(
      FilmSelectionQuerySchema.parse({ provider: 'fixture-a', q: 'Film 2' }),
    )
    expect(searched.items.map((item) => item.id)).toEqual(['film-2'])
  })
  it('shows Never and stale films, without filtering on imports or another provider', async () => {
    const { listFilmSelection } = await import('@/services/film-selection')
    await state('film-0', 'fixture-a', new Date())
    await state('film-1', 'fixture-b', new Date())
    const result = await listFilmSelection(
      FilmSelectionQuerySchema.parse({
        provider: 'fixture-a',
        olderThanDays: 180,
      }),
    )
    expect(result.items.map((item) => item.id)).not.toContain('film-0')
    expect(result.items.map((item) => item.id)).toContain('film-1')
  })
  it('requires confirmation before any queue writes and queues only explicit films in one-item jobs', async () => {
    const { queueFilmSelection } = await import('@/services/film-selection')
    const request = QueueFilmSelectionSchema.parse({
      providers: ['fixture-a'],
      mediaItemIds: Array.from({ length: 6 }, (_, i) => `film-${i}`),
      batchId: randomUUID(),
    })
    await expect(queueFilmSelection(request, null)).rejects.toThrow()
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(0)
    const result = await queueFilmSelection(
      { ...request, confirmBroadRun: true },
      null,
    )
    expect(result.queued).toBe(6)
    const jobs = await databaseClient.select().from(schema.scrapeJob)
    expect(
      jobs.every((job) => {
        const scope = JobScopeSchema.parse(job.scope)
        return scope.limit === 1 && scope.mediaItemIds.length === 1
      }),
    ).toBe(true)
    expect(
      await databaseClient.select().from(schema.scrapeJobItem),
    ).toHaveLength(6)
  })
  it('refreshes stale pairs independently and skips current, missing-ID and already queued work', async () => {
    const { queueFilmSelection } = await import('@/services/film-selection')
    await state('film-0', 'fixture-a', new Date())
    const input = QueueFilmSelectionSchema.parse({
      providers: ['fixture-a', 'fixture-b'],
      mediaItemIds: ['film-0', 'film-7'],
      olderThanDays: 180,
      batchId: randomUUID(),
    })
    const result = await queueFilmSelection(input, null)
    expect(result.queued).toBe(1)
    expect(result.skipped).toBe(3)
    const jobs = await databaseClient.select().from(schema.scrapeJob)
    expect(jobs[0]?.provider).toBe('fixture-b')
    expect((await queueFilmSelection(input, null)).queued).toBe(0)
  })
  it('rejects invalid provider, missing or archived selections without queue writes', async () => {
    const { queueFilmSelection, listFilmSelection } =
      await import('@/services/film-selection')
    await expect(
      listFilmSelection(FilmSelectionQuerySchema.parse({ provider: 'absent' })),
    ).rejects.toThrow()
    await databaseClient
      .update(schema.mediaItem)
      .set({ metadata: { legacyHidden: true } })
      .where(eq(schema.mediaItem.id, 'film-0'))
    for (const id of ['absent', 'film-0'])
      await expect(
        queueFilmSelection(
          QueueFilmSelectionSchema.parse({
            providers: ['fixture-a'],
            mediaItemIds: [id],
            batchId: randomUUID(),
          }),
          null,
        ),
      ).rejects.toThrow()
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(0)
  })
})
