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
  AlbumSelectionPageSchema,
  AlbumSelectionQuerySchema,
  QueueAlbumSelectionSchema,
} from '@repo/schemas/album-selection'
import { JobScopeSchema, type Job } from '@repo/schemas/job'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { createCatalogEntryFromPlugin } from '@/lib/provider-catalog'

const database = `album_selection_${randomUUID().replaceAll('-', '')}`
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
    mediaTypes: ['album'],
    identifierTypes: ['album'],
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
  execute.mockReset()
  for (const plugin of plugins) plugin.manifest.supportsNameLookup = false
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.providerSnapshot)
  await databaseClient.delete(schema.artist)
  for (let i = 0; i < 8; i++) {
    const id = `album-${i}`
    await databaseClient.insert(schema.mediaItem).values({
      id,
      slug: id,
      title: `Album ${i}`,
      mediaType: 'album',
      metadata: { browse: { country: i % 2 ? ['France'] : ['Japan'] } },
    })
    await databaseClient
      .insert(schema.album)
      .values({ mediaItemId: id, dateAdded: new Date(`2020-01-0${i + 1}`) })
    if (i !== 7)
      await databaseClient.insert(schema.providerReference).values(
        ['fixture-a', 'fixture-b'].map((provider) => ({
          id: `${id}-${provider}`,
          mediaItemId: id,
          provider,
          referenceType: 'album',
          externalId: `external-${i}`,
        })),
      )
  }
})
afterAll(async () => {
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
  mediaType: 'film' | 'album' = 'album',
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

describe('album selection and safe scheduling', () => {
  it('shows the latest started failure without replacing prior success or another provider', async () => {
    const { listAlbumSelection } = await import('@/services/album-selection')
    await state('album-0', 'fixture-a', new Date('2024-02-01'))
    await attempt('success', 'album-0', 'succeeded', new Date('2024-02-01'))
    await attempt('latest-failure', 'album-0', 'failed', new Date('2024-03-01'))
    await attempt('older-failure', 'album-0', 'failed', new Date('2024-02-15'))
    await attempt('queued-retry', 'album-0', 'queued', null)
    await attempt(
      'queued-with-start-date',
      'album-0',
      'queued',
      new Date('2024-05-01'),
    )
    await attempt('cancelled-before-start', 'album-0', 'cancelled', null)
    await state('album-0', 'fixture-b', new Date('2024-04-01'))
    await attempt(
      'other-provider',
      'album-0',
      'succeeded',
      new Date('2024-04-01'),
      'fixture-b',
    )

    const result = AlbumSelectionPageSchema.parse(
      await listAlbumSelection(
        AlbumSelectionQuerySchema.parse({
          provider: 'fixture-a',
          q: 'Album 0',
        }),
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
    const failed = await listAlbumSelection(
      AlbumSelectionQuerySchema.parse({
        freshness: [{ provider: 'fixture-a', mode: 'failed' }],
      }),
    )
    expect(failed.items.map((item) => item.id)).toEqual(['album-0'])
  })
  it.each(['running', 'succeeded', 'cancelled'] satisfies Job['status'][])(
    'stops matching failed after a newer %s attempt',
    async (status) => {
      const { listAlbumSelection } = await import('@/services/album-selection')
      const query = AlbumSelectionQuerySchema.parse({
        freshness: [{ provider: 'fixture-a', mode: 'failed' }],
      })
      await attempt('failure', 'album-0', 'failed', new Date('2024-02-01'))
      expect(
        (await listAlbumSelection(query)).items.map((item) => item.id),
      ).toEqual(['album-0'])
      await attempt('retry', 'album-0', status, new Date('2024-03-01'))
      if (status === 'succeeded')
        await state('album-0', 'fixture-a', new Date('2024-03-01'))
      expect((await listAlbumSelection(query)).totalCount).toBe(0)
      const result = await listAlbumSelection(
        AlbumSelectionQuerySchema.parse({
          provider: 'fixture-a',
          q: 'Album 0',
        }),
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
    const { listAlbumSelection } = await import('@/services/album-selection')
    const { applyProviderResult } = await import('@/services/provider-state')
    for (const [index, status] of (
      ['failed', 'running', 'cancelled', 'succeeded'] satisfies Job['status'][]
    ).entries())
      await attempt(
        `started-${status}`,
        `album-${index}`,
        status,
        new Date('2024-02-01'),
      )
    await attempt('queued', 'album-4', 'queued', null)
    await attempt('cancelled-unstarted', 'album-5', 'cancelled', null)
    await applyProviderResult({
      mediaItemId: 'album-6',
      mediaType: 'album',
      provider: 'fixture-a',
      source: 'legacy-import',
      ...PluginResultSchema.parse({
        payload: { imported: true },
        normalized: {},
      }),
    })
    await state('album-7', 'fixture-a', new Date('2024-02-01'))
    const never = await listAlbumSelection(
      AlbumSelectionQuerySchema.parse({
        freshness: [{ provider: 'fixture-a', mode: 'never' }],
      }),
    )
    expect(never.items.map((item) => item.id).sort()).toEqual([
      'album-4',
      'album-5',
      'album-6',
    ])
    for (const item of never.items)
      expect(item.providerFreshness['fixture-a']).toMatchObject({
        lastScrapedAt: null,
        lastAttempt: null,
      })
    const unscraped = await listAlbumSelection(
      AlbumSelectionQuerySchema.parse({
        freshness: [{ provider: 'fixture-a', mode: 'unscraped' }],
      }),
    )
    expect(unscraped.items.map((item) => item.id).sort()).toEqual(
      Array.from({ length: 7 }, (_, index) => `album-${index}`),
    )
    const otherProvider = await listAlbumSelection(
      AlbumSelectionQuerySchema.parse({
        freshness: [{ provider: 'fixture-b', mode: 'never' }],
      }),
    )
    expect(otherProvider.totalCount).toBe(8)
  })
  it('filters failed and unscraped per provider before pagination and excludes films', async () => {
    const { listAlbumSelection, queueAlbumSelection } =
      await import('@/services/album-selection')
    await databaseClient.insert(schema.mediaItem).values({
      id: 'other-film',
      slug: 'other-film',
      title: 'Other film',
      mediaType: 'film',
    })
    await databaseClient
      .insert(schema.film)
      .values({ mediaItemId: 'other-film' })
    await attempt(
      'film-failure',
      'other-film',
      'failed',
      new Date('2024-02-01'),
      'fixture-a',
      'film',
    )
    await attempt('first-failure', 'album-0', 'failed', new Date('2024-02-01'))
    await state('album-0', 'fixture-b', new Date('2024-02-01'))
    await attempt(
      'provider-b-failure',
      'album-1',
      'failed',
      new Date('2024-02-01'),
      'fixture-b',
    )
    await attempt('second-failure', 'album-2', 'failed', new Date('2024-03-01'))
    await state('album-2', 'fixture-a', new Date('2024-02-01'))

    const query = AlbumSelectionQuerySchema.parse({
      freshness: [{ provider: 'fixture-a', mode: 'failed' }],
      sortBy: 'title',
      direction: 'asc',
      size: 1,
    })
    const first = await listAlbumSelection(query)
    expect(first.totalCount).toBe(2)
    expect(first.pageCount).toBe(2)
    expect(first.items.map((item) => item.id)).toEqual(['album-0'])
    expect(
      (await listAlbumSelection({ ...query, page: 2 })).items.map(
        (item) => item.id,
      ),
    ).toEqual(['album-2'])
    const second = await listAlbumSelection(
      AlbumSelectionQuerySchema.parse({
        freshness: [{ provider: 'fixture-b', mode: 'failed' }],
      }),
    )
    expect(second.items.map((item) => item.id)).toEqual(['album-1'])
    for (const [provider, excluded] of [
      ['fixture-a', 'album-2'],
      ['fixture-b', 'album-0'],
    ]) {
      const result = await listAlbumSelection(
        AlbumSelectionQuerySchema.parse({
          freshness: [{ provider, mode: 'unscraped' }],
        }),
      )
      expect(result.totalCount).toBe(7)
      expect(result.items.map((item) => item.id).sort()).toEqual(
        Array.from({ length: 8 }, (_, index) => `album-${index}`).filter(
          (id) => id !== excluded,
        ),
      )
    }
    const combined = await listAlbumSelection(
      AlbumSelectionQuerySchema.parse({
        freshness: [
          { provider: 'fixture-a', mode: 'failed' },
          { provider: 'fixture-b', mode: 'unscraped' },
        ],
      }),
    )
    expect(combined.items.map((item) => item.id)).toEqual(['album-2'])
    await expect(
      queueAlbumSelection(
        QueueAlbumSelectionSchema.parse({
          providers: ['fixture-a'],
          mediaItemIds: ['other-film'],
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
    { mode: 'never', expected: ['album-3', 'album-4', 'album-6'] },
    { mode: 'failed', expected: ['album-0', 'album-5'] },
    {
      mode: 'unscraped',
      expected: ['album-0', 'album-1', 'album-3', 'album-4', 'album-6'],
    },
  ])(
    'queues only matching $mode provider pairs',
    async ({ mode, expected }) => {
      const { queueAlbumSelection } = await import('@/services/album-selection')
      await attempt('failed', 'album-0', 'failed', new Date('2024-02-01'))
      await attempt(
        'cancelled-started',
        'album-1',
        'cancelled',
        new Date('2024-02-01'),
      )
      await attempt('succeeded', 'album-2', 'succeeded', new Date('2024-02-01'))
      await state('album-2', 'fixture-a', new Date('2024-02-01'))
      await attempt('cancelled-unstarted', 'album-3', 'cancelled', null)
      await state('album-4', 'fixture-a', null)
      await state('album-5', 'fixture-a', new Date('2024-02-01'))
      await attempt(
        'failed-after-success',
        'album-5',
        'failed',
        new Date('2024-03-01'),
      )
      const result = await queueAlbumSelection(
        QueueAlbumSelectionSchema.parse({
          providers: ['fixture-a'],
          mediaItemIds: Array.from(
            { length: 7 },
            (_, index) => `album-${index}`,
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
      const { listAlbumSelection, queueAlbumSelection } =
        await import('@/services/album-selection')
      if (mode === 'failed') {
        await attempt('failed-a', 'album-0', 'failed', new Date('2024-02-01'))
        await attempt(
          'failed-b',
          'album-0',
          'failed',
          new Date('2024-02-01'),
          'fixture-b',
        )
      }
      const freshness = ['fixture-a', 'fixture-b'].map((provider) => ({
        provider,
        mode,
      }))
      const preview = await listAlbumSelection(
        AlbumSelectionQuerySchema.parse({ q: 'Album 0', freshness }),
      )
      expect(preview.items.map((item) => item.id)).toEqual(['album-0'])
      await attempt(
        'after-preview',
        'album-0',
        mode === 'never' ? 'failed' : 'succeeded',
        new Date('2024-03-01'),
      )
      if (mode !== 'never')
        await state('album-0', 'fixture-a', new Date('2024-03-01'))
      const result = await queueAlbumSelection(
        QueueAlbumSelectionSchema.parse({
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
        mediaItemId: 'album-0',
        provider: 'fixture-b',
      })
    },
  )
  it('passes album context to mocked providers and retires audio values from every persisted result', async () => {
    const { queueAlbumSelection } = await import('@/services/album-selection')
    const { processQueuedJobs } = await import('@/services/jobs')
    await databaseClient
      .insert(schema.artist)
      .values({ id: 'artist-fixture', name: 'Fixture artist' })
    await databaseClient.insert(schema.mediaCredit).values({
      mediaItemId: 'album-0',
      artistId: 'artist-fixture',
      role: 'artist',
    })
    execute.mockResolvedValue(
      PluginResultSchema.parse({
        payload: {
          title: 'Fixture',
          audioFeatures: { tempo: 120 },
          duration: 400,
        },
        normalized: {
          albumPatch: { metadata: { browse: { energy: 0.9, scrobbles: 20 } } },
        },
      }),
    )
    await queueAlbumSelection(
      QueueAlbumSelectionSchema.parse({
        providers: ['fixture-a'],
        mediaItemIds: ['album-0'],
        batchId: randomUUID(),
      }),
      null,
    )
    await processQueuedJobs()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      mediaType: 'album',
      media: { title: 'Album 0', artists: ['Fixture artist'] },
      existingReferences: expect.arrayContaining([
        expect.objectContaining({
          externalId: 'external-0',
          metadata: { sourceProvider: 'fixture-a' },
        }),
      ]),
    })
    const [job] = await databaseClient.select().from(schema.scrapeJobItem)
    expect(job?.status).toBe('succeeded')
    expect(job?.payload).toEqual({ title: 'Fixture', duration: 400 })
    const [snapshot] = await databaseClient
      .select()
      .from(schema.providerSnapshot)
    expect(snapshot?.payload).toEqual(job?.payload)
    expect(snapshot?.normalizedData).toMatchObject({
      albumPatch: { metadata: { browse: { scrobbles: 20 } } },
    })
    expect(JSON.stringify(snapshot?.normalizedData)).not.toContain('energy')
  })
  it("does not accept another provider's album identifier", async () => {
    const { listAlbumSelection, queueAlbumSelection } =
      await import('@/services/album-selection')
    await databaseClient
      .delete(schema.providerReference)
      .where(eq(schema.providerReference.id, 'album-0-fixture-a'))
    const selection = await listAlbumSelection(
      AlbumSelectionQuerySchema.parse({ provider: 'fixture-a', q: 'Album 0' }),
    )
    expect(selection.items[0]?.hasProviderIdentifier).toBe(false)
    const result = await queueAlbumSelection(
      QueueAlbumSelectionSchema.parse({
        providers: ['fixture-a'],
        mediaItemIds: ['album-0'],
        batchId: randomUUID(),
      }),
      null,
    )
    expect(result.queued).toBe(0)
    expect(result.skipped).toBe(1)
  })
  it('allows declared name lookup only with an album title and artist', async () => {
    const plugin = plugins.find((entry) => entry.manifest.id === 'fixture-a')
    if (!plugin) throw new Error('Missing fixture provider')
    plugin.manifest.supportsNameLookup = true
    const { listAlbumSelection, queueAlbumSelection } =
      await import('@/services/album-selection')
    const query = AlbumSelectionQuerySchema.parse({
      provider: 'fixture-a',
      q: 'Album 7',
    })
    expect(
      (await listAlbumSelection(query)).items[0]?.hasProviderIdentifier,
    ).toBe(false)
    await databaseClient
      .insert(schema.artist)
      .values({ id: 'artist-fixture', name: 'Fixture artist' })
    await databaseClient.insert(schema.mediaCredit).values({
      mediaItemId: 'album-7',
      artistId: 'artist-fixture',
      role: 'artist',
    })
    expect(
      (await listAlbumSelection(query)).items[0]?.hasProviderIdentifier,
    ).toBe(true)
    const result = await queueAlbumSelection(
      QueueAlbumSelectionSchema.parse({
        providers: ['fixture-a'],
        mediaItemIds: ['album-7'],
        olderThanDays: 180,
        batchId: randomUUID(),
      }),
      null,
    )
    expect(result.queued).toBe(1)
  })
  it('scopes job listings by media type, including legacy jobs without a scope type', async () => {
    const { queueAlbumSelection } = await import('@/services/album-selection')
    const { listJobs, getJobActivity } = await import('@/services/jobs')
    await queueAlbumSelection(
      QueueAlbumSelectionSchema.parse({
        providers: ['fixture-a'],
        mediaItemIds: ['album-0'],
        batchId: randomUUID(),
      }),
      null,
    )
    const [job] = await databaseClient.select().from(schema.scrapeJob)
    if (!job) throw new Error('Missing queued fixture job')
    await databaseClient
      .update(schema.scrapeJob)
      .set({ scope: { ...job.scope, mediaType: null } })
      .where(eq(schema.scrapeJob.id, job.id))
    await databaseClient.insert(schema.scrapeJob).values({
      id: 'film-job',
      provider: 'fixture-film',
      scope: { mediaType: 'film', mediaItemIds: [], limit: 1 },
      options: {},
    })
    const albums = await listJobs({ mediaType: 'album' })
    const films = await listJobs({ mediaType: 'film' })
    expect(albums.items.map((item) => item.id)).toEqual([job.id])
    expect(films.items.map((item) => item.id)).toEqual(['film-job'])
    const activity = await getJobActivity()
    expect(activity.queued).toBe(2)
    expect(activity.libraries).toEqual([
      { mediaType: 'album', queued: 1, running: 0, failed: 0, imports: 0 },
      { mediaType: 'film', queued: 1, running: 0, failed: 0, imports: 0 },
    ])
  })
  it('uses successful scrape dates only and keeps freshness provider-specific', async () => {
    const { listAlbumSelection } = await import('@/services/album-selection')
    await state('album-0', 'fixture-a', new Date('2020-02-01'))
    await state('album-1', 'fixture-a', null)
    await state('album-0', 'fixture-b', new Date('2024-02-01'))
    const first = await listAlbumSelection(
      AlbumSelectionQuerySchema.parse({
        provider: 'fixture-a',
        sortBy: 'lastScrapedAt',
        direction: 'asc',
      }),
    )
    expect(first.items[0]?.lastScrapedAt).toBeNull()
    expect(first.items.at(-1)?.id).toBe('album-0')
    expect(
      first.items.find((item) => item.id === 'album-1')?.lastScrapedAt,
    ).toBeNull()
    const second = await listAlbumSelection(
      AlbumSelectionQuerySchema.parse({ provider: 'fixture-b' }),
    )
    expect(
      second.items.find((item) => item.id === 'album-0')?.lastScrapedAt,
    ).toBe('2024-02-01T00:00:00.000Z')
  })
  it('preserves scrape freshness when an import updates provider state', async () => {
    const { applyProviderResult } = await import('@/services/provider-state')
    const { listAlbumSelection } = await import('@/services/album-selection')
    await state('album-0', 'fixture-a', new Date('2020-02-01'))
    await applyProviderResult({
      mediaItemId: 'album-0',
      mediaType: 'album',
      provider: 'fixture-a',
      source: 'legacy-import',
      ...PluginResultSchema.parse({
        payload: { imported: true },
        normalized: {},
      }),
    })
    const result = await listAlbumSelection(
      AlbumSelectionQuerySchema.parse({ provider: 'fixture-a' }),
    )
    expect(
      result.items.find((item) => item.id === 'album-0')?.lastScrapedAt,
    ).toBe('2020-02-01T00:00:00.000Z')
  })
  it('supports browse filtering, Added sorting, search and pagination with missing IDs marked', async () => {
    const { listAlbumSelection } = await import('@/services/album-selection')
    const result = await listAlbumSelection(
      AlbumSelectionQuerySchema.parse({
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
    expect(result.items.map((item) => item.id)).toEqual(['album-7', 'album-5'])
    expect(result.items[0]?.hasProviderIdentifier).toBe(false)
    expect(result.items[1]?.hasProviderIdentifier).toBe(true)
    const searched = await listAlbumSelection(
      AlbumSelectionQuerySchema.parse({ provider: 'fixture-a', q: 'Album 2' }),
    )
    expect(searched.items.map((item) => item.id)).toEqual(['album-2'])
  })
  it('shows Never and stale albums, without filtering on imports or another provider', async () => {
    const { listAlbumSelection } = await import('@/services/album-selection')
    await state('album-0', 'fixture-a', new Date())
    await state('album-1', 'fixture-b', new Date())
    const result = await listAlbumSelection(
      AlbumSelectionQuerySchema.parse({
        provider: 'fixture-a',
        olderThanDays: 180,
      }),
    )
    expect(result.items.map((item) => item.id)).not.toContain('album-0')
    expect(result.items.map((item) => item.id)).toContain('album-1')
  })
  it('requires confirmation before any queue writes and queues only explicit albums in one-item jobs', async () => {
    const { queueAlbumSelection } = await import('@/services/album-selection')
    const request = QueueAlbumSelectionSchema.parse({
      providers: ['fixture-a'],
      mediaItemIds: Array.from({ length: 6 }, (_, i) => `album-${i}`),
      batchId: randomUUID(),
    })
    await expect(queueAlbumSelection(request, null)).rejects.toThrow()
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(0)
    const result = await queueAlbumSelection(
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
    const { queueAlbumSelection } = await import('@/services/album-selection')
    await state('album-0', 'fixture-a', new Date())
    const input = QueueAlbumSelectionSchema.parse({
      providers: ['fixture-a', 'fixture-b'],
      mediaItemIds: ['album-0', 'album-7'],
      olderThanDays: 180,
      batchId: randomUUID(),
    })
    const result = await queueAlbumSelection(input, null)
    expect(result.queued).toBe(1)
    expect(result.skipped).toBe(3)
    const jobs = await databaseClient.select().from(schema.scrapeJob)
    expect(jobs[0]?.provider).toBe('fixture-b')
    expect((await queueAlbumSelection(input, null)).queued).toBe(0)
  })
  it('rejects invalid provider, missing or archived selections without queue writes', async () => {
    const { queueAlbumSelection, listAlbumSelection } =
      await import('@/services/album-selection')
    await expect(
      listAlbumSelection(
        AlbumSelectionQuerySchema.parse({ provider: 'absent' }),
      ),
    ).rejects.toThrow()
    await databaseClient
      .update(schema.mediaItem)
      .set({ metadata: { legacyHidden: true } })
      .where(eq(schema.mediaItem.id, 'album-0'))
    for (const id of ['absent', 'album-0'])
      await expect(
        queueAlbumSelection(
          QueueAlbumSelectionSchema.parse({
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
