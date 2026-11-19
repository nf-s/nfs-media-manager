import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'
import { getJobDismissal, type Job } from '@repo/schemas/job'
import { ARTIST_ENRICHMENT_TASK } from '@repo/schemas/artist-profiles'
import { LASTFM_SCROBBLE_SYNC_TASK } from '@repo/schemas/lastfm'
import {
  MIX_STATION_SYNC_TASKS,
  SPOTIFY_PODCAST_SYNC_TASK,
} from '@repo/schemas/subscriptions'
import { YOUTUBE_SYNC_TASK } from '@repo/schemas/youtube'
import { env } from '@/env'
import * as schema from '@/schemas/db'

vi.mock('@/lib/load-workspace-env', () => ({ loadWorkspaceEnv: () => {} }))

const database = `media_history_test_${randomUUID().replaceAll('-', '')}`
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
const network = vi.fn(() => {
  throw new Error('Network forbidden in history tests')
})
const plugin: MediaProviderPlugin = {
  manifest: {
    id: 'fixture-provider',
    displayName: 'Fixture provider',
    description: '',
    mediaTypes: ['film'],
    secrets: [],
    rateLimit: { maxConcurrent: 1, minTimeMs: 2000 },
  },
  scrapeMediaItem: execute,
}
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async (provider: string) =>
    provider === 'lastfm'
      ? (await import('@/plugins/builtin/lastfm')).lastfmPlugin
      : plugin,
  listLoadedScrapePlugins: async () => [plugin],
}))
// Queueing a sync needs no connected account here; the sync itself never runs.
vi.mock('@/services/youtube-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/youtube-sync')>()),
  prepareYoutubeSyncRun: async () => {},
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
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.insert(schema.mediaItem).values([
    {
      id: 'film-1',
      mediaType: 'film',
      slug: 'fixture-film',
      title: 'Fixture film',
    },
    {
      id: 'film-2',
      mediaType: 'film',
      slug: 'other-film',
      title: 'Other film',
    },
  ])
  execute.mockClear()
  network.mockClear()
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

async function seedJob(
  id: string,
  status: Job['status'],
  mediaItemId = 'film-1',
  withItem = true,
) {
  await databaseClient.insert(schema.scrapeJob).values({
    id,
    provider: plugin.manifest.id,
    status,
    scope: { mediaItemIds: [mediaItemId], mediaType: 'film', limit: 1 },
    options: { batchId: 'fixture-batch' },
    errorMessage: 'Original error',
  })
  if (withItem)
    await databaseClient.insert(schema.scrapeJobItem).values({
      id: `${id}-item`,
      jobId: id,
      mediaItemId,
      provider: plugin.manifest.id,
      status,
      message: 'Original item error',
    })
  await databaseClient.insert(schema.scrapeJobLog).values({
    id: `${id}-log`,
    jobId: id,
    level: 'error',
    message: 'Original error',
    metadata: {
      error: {
        name: 'Error',
        message: 'Original error',
        stack: 'fixture stack',
        causes: [],
      },
    },
  })
}

describe('media job history and dismissal', () => {
  it('retains the exact ordered HTTP evidence through failures and replays without eager bodies', async () => {
    const { getJobData } = await import('@/services/job-data')
    const {
      getJobProviderResponse,
      listJobProviderResponses,
      readProviderResponseAttempt,
      saveProviderResponseCapture,
    } = await import('@/services/provider-response-history')
    const { ProviderResponsePageSchema, ProviderResponseSchema } =
      await import('@repo/schemas/provider-response')
    const provider = plugin.manifest.id
    await seedJob('response-job', 'failed')
    await seedJob('response-other', 'failed')
    await databaseClient
      .update(schema.scrapeJobItem)
      .set({ attemptCount: 1 })
      .where(eq(schema.scrapeJobItem.id, 'response-job-item'))

    const first = {
      ordinal: 1,
      phase: 'media',
      request: {
        method: 'GET',
        url: 'https://example.invalid/search',
        key: 'a'.repeat(64),
      },
      response: {
        status: 200,
        receivedAt: '2025-01-01T00:00:00.000Z',
        contentType: 'application/json',
        body: { state: 'captured', text: '{"marker":"saved-response"}' },
      },
    } satisfies import('@repo/schemas/provider-response').ProviderResponseCapture
    const scope = {
      jobId: 'response-job',
      jobItemId: 'response-job-item',
      attempt: 1,
      provider,
    }

    await saveProviderResponseCapture({ ...scope, capture: first })
    await saveProviderResponseCapture({
      ...scope,
      capture: {
        ...first,
        response: {
          ...first.response,
          body: { state: 'captured', text: 'replacement' },
        },
      },
    })
    await saveProviderResponseCapture({
      ...scope,
      capture: {
        ...first,
        ordinal: 2,
        response: {
          ...first.response,
          status: 429,
          body: { state: 'unavailable', reason: 'byte-limit' },
        },
      },
    })
    await expect(
      saveProviderResponseCapture({
        ...scope,
        jobId: 'response-other',
        capture: first,
      }),
    ).rejects.toThrow(/scope does not match/)

    const page = ProviderResponsePageSchema.parse(
      await listJobProviderResponses(scope.jobId, { page: 1, size: 1 }),
    )
    expect(page).toMatchObject({
      totalCount: 2,
      pageCount: 2,
      items: [{ ordinal: 1, bodyState: 'captured' }],
    })
    expect(page.items[0]).not.toHaveProperty('body')
    expect(page.items[0]).not.toHaveProperty('requestKey')
    const summary = page.items[0]
    if (!summary) throw new Error('Missing provider response summary')
    const full = ProviderResponseSchema.parse(
      await getJobProviderResponse(scope.jobId, summary.id),
    )
    expect(full.body).toEqual(first.response.body)
    expect(full.requestKey).toBe(first.request.key)
    expect(await readProviderResponseAttempt(scope)).toMatchObject([
      {
        capture: {
          ordinal: 1,
          request: { key: first.request.key },
          response: { status: 200 },
        },
      },
      { capture: { ordinal: 2, response: { status: 429 } } },
    ])
    expect(await readProviderResponseAttempt({ ...scope, attempt: 2 })).toEqual(
      [],
    )
    await expect(
      getJobProviderResponse('response-other', summary.id),
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(
      await listJobProviderResponses('response-other', { page: 1, size: 100 }),
    ).toMatchObject({ totalCount: 0 })
    expect(JSON.stringify(await getJobData(scope.jobId))).not.toContain(
      'saved-response',
    )

    const second = await listJobProviderResponses(scope.jobId, {
      page: 2,
      size: 1,
    })
    expect(second.items).toMatchObject([
      { ordinal: 2, status: 429, bodyState: 'unavailable', retainedBytes: 0 },
    ])
    await databaseClient
      .delete(schema.scrapeJob)
      .where(eq(schema.scrapeJob.id, scope.jobId))
    expect(await databaseClient.select().from(schema.providerResponse)).toEqual(
      [],
    )
  })

  it('replays a saved job with current job-bound lookup fields and detects a changed reference', async () => {
    const { runProviderReplayCommand } =
      await import('../scripts/replay-provider-response')
    const { createProviderResponseRecorder } =
      await import('@/lib/provider-response-history')
    const { saveProviderResponseCapture } =
      await import('@/services/provider-response-history')
    const { lastFmSparseAlbumFixture } =
      await import('@/plugins/builtin/__tests__/fixtures/lastfm')
    const jobId = 'offline-fixture-job'
    const jobItemId = 'offline-fixture-item'
    const mediaItemId = 'offline-fixture-album'
    const artistId = 'offline-fixture-artist'
    const provider = 'lastfm'
    const attempt = 1
    await databaseClient.insert(schema.mediaItem).values({
      id: mediaItemId,
      mediaType: 'album',
      slug: 'offline-fixture-album',
      title: 'Example Album',
    })
    await databaseClient
      .insert(schema.artist)
      .values({ id: artistId, name: 'Example Artist' })
    try {
      await databaseClient.insert(schema.mediaCredit).values({
        mediaItemId,
        artistId,
        role: 'artist',
        billingOrder: 0,
      })
      await databaseClient.insert(schema.scrapeJob).values({
        id: jobId,
        provider,
        status: 'failed',
        options: {},
        scope: { mediaItemIds: [mediaItemId], mediaType: 'album', limit: 1 },
      })
      await databaseClient.insert(schema.scrapeJobItem).values({
        id: jobItemId,
        jobId,
        mediaItemId,
        provider,
        attemptCount: attempt,
        status: 'failed',
      })
      const store = createProviderResponseRecorder(
        (capture) =>
          saveProviderResponseCapture({
            jobId,
            jobItemId,
            provider,
            attempt,
            capture,
          }),
        [],
      )
      const url = new URL('https://ws.audioscrobbler.com/2.0/')
      url.search = new URLSearchParams({
        method: 'album.getInfo',
        format: 'json',
        api_key: 'placeholder-fixture',
        autocorrect: '1',
        artist: 'Example Artist',
        album: 'Example Album',
      }).toString()
      const record = store('media')(url)
      if (!record) throw new Error('Missing recorded success fixture')
      await record({
        status: 200,
        receivedAt: '2025-01-01T00:00:00.000Z',
        contentType: 'application/json',
        body: {
          state: 'captured',
          text: JSON.stringify(lastFmSparseAlbumFixture),
        },
      })

      const directory = await mkdtemp(
        join(tmpdir(), 'provider-replay-integration-'),
      )
      try {
        const jobArguments = [
          '--job',
          jobId,
          '--item',
          jobItemId,
          '--attempt',
          String(attempt),
          '--output',
        ]
        const report = join(directory, 'report.json')
        await runProviderReplayCommand(['replay', ...jobArguments, report])
        expect(JSON.parse(await readFile(report, 'utf8'))).toMatchObject({
          contextSource: 'current-library',
          result: [
            {
              normalized: {
                tracks: [{ title: 'Track 1' }, { title: 'Track 2' }],
              },
            },
          ],
        })
        expect(
          await databaseClient.select().from(schema.providerSnapshot),
        ).toEqual([])
        await databaseClient
          .update(schema.mediaItem)
          .set({ title: 'Revised release title' })
          .where(eq(schema.mediaItem.id, mediaItemId))
        await expect(
          runProviderReplayCommand([
            'replay',
            ...jobArguments,
            join(directory, 'mismatch.json'),
          ]),
        ).rejects.toThrow(/differs from the recorded request/)
        await runProviderReplayCommand([
          'export',
          ...jobArguments,
          join(directory, 'export.json'),
        ])
        expect(
          JSON.parse(await readFile(join(directory, 'export.json'), 'utf8')),
        ).toMatchObject({
          context: {
            inputs: [
              { context: { media: { title: 'Revised release title' } } },
            ],
          },
          responses: [{ capture: { response: { status: 200 } } }],
        })
        expect(network).not.toHaveBeenCalled()
      } finally {
        await rm(directory, { recursive: true })
      }
    } finally {
      await databaseClient
        .delete(schema.mediaCredit)
        .where(eq(schema.mediaCredit.mediaItemId, mediaItemId))
      await databaseClient
        .delete(schema.artist)
        .where(eq(schema.artist.id, artistId))
    }
  })

  it('supports task-level artist evidence with an opaque local reference', async () => {
    const {
      getJobProviderResponse,
      listJobProviderResponses,
      saveProviderResponseCapture,
    } = await import('@/services/provider-response-history')
    await seedJob('artist-response-job', 'failed', 'film-1', false)
    const artistId = 'fixture-response-artist'
    await databaseClient
      .insert(schema.artist)
      .values({ id: artistId, name: 'Fixture response artist' })
    try {
      await saveProviderResponseCapture({
        jobId: 'artist-response-job',
        provider: plugin.manifest.id,
        artistId,
        attempt: 1,
        capture: {
          ordinal: 1,
          phase: 'artist',
          request: { method: 'GET', url: null },
          response: {
            status: 200,
            receivedAt: '2025-01-01T00:00:00.000Z',
            contentType: 'application/json',
            body: {
              state: 'local',
              reference: 'opaque_fixture_ref',
              retainedBytes: 16 * 1024 * 1024,
            },
          },
        },
      })
      const { items } = await listJobProviderResponses('artist-response-job', {
        page: 1,
        size: 100,
      })
      expect(items).toMatchObject([
        {
          artistId,
          jobItemId: null,
          phase: 'artist',
          bodyState: 'local',
          retainedBytes: 16 * 1024 * 1024,
        },
      ])
      const summary = items[0]
      if (!summary) throw new Error('Missing task response summary')
      expect(
        (await getJobProviderResponse('artist-response-job', summary.id)).body,
      ).toEqual({
        state: 'local',
        reference: 'opaque_fixture_ref',
        retainedBytes: 16 * 1024 * 1024,
      })
    } finally {
      await databaseClient
        .delete(schema.artist)
        .where(eq(schema.artist.id, artistId))
    }
    const { items } = await listJobProviderResponses('artist-response-job', {
      page: 1,
      size: 100,
    })
    expect(items).toMatchObject([{ artistId: null, phase: 'artist' }])
  })

  it('exposes exact-job snapshots without substituting other attempts or imports', async () => {
    const { getJobData } = await import('@/services/job-data')
    const { JobDataSchema } = await import('@repo/schemas/job')
    await seedJob('json-success', 'succeeded')
    await seedJob('json-failure', 'failed')
    await databaseClient.insert(schema.providerSnapshot).values([
      {
        id: 'json-own',
        mediaItemId: 'film-1',
        provider: plugin.manifest.id,
        checksum: 'own',
        payload: { response: 'own' },
        source: 'scrape-job',
        scrapeJobId: 'json-success',
      },
      {
        id: 'json-import',
        mediaItemId: 'film-1',
        provider: plugin.manifest.id,
        checksum: 'import',
        payload: { response: 'imported' },
        source: 'legacy-import',
      },
    ])
    await databaseClient
      .update(schema.scrapeJobItem)
      .set({ payload: { response: 'own' } })
      .where(eq(schema.scrapeJobItem.id, 'json-success-item'))
    const success = JobDataSchema.parse(await getJobData('json-success'))
    expect(success.snapshots.map((snapshot) => snapshot.id)).toEqual([
      'json-own',
    ])
    expect(success.itemPayloads).toEqual([])
    expect(await getJobData('json-failure')).toEqual({
      jobId: 'json-failure',
      snapshots: [],
      diagnostics: [],
      itemPayloads: [],
    })
    expect(execute).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
  })

  it('returns failure response diagnostics including empty JSON results', async () => {
    const { getJobData } = await import('@/services/job-data')
    const { listJobs } = await import('@/services/jobs')
    await seedJob('json-diagnostic', 'failed')
    await seedJob('json-other-diagnostic', 'failed')
    const diagnostics = [
      { stage: 'serply.response', evidence: { response: { results: [] } } },
    ]
    await databaseClient
      .update(schema.scrapeJobLog)
      .set({ metadata: { diagnostics } })
      .where(eq(schema.scrapeJobLog.id, 'json-diagnostic-log'))
    const data = await getJobData('json-diagnostic')
    expect(data.diagnostics).toEqual([
      {
        id: 'json-diagnostic-log',
        createdAt: expect.any(String),
        data: diagnostics,
      },
    ])
    expect((await getJobData('json-other-diagnostic')).diagnostics).toEqual([])
    const list = await listJobs({ q: 'json-diagnostic' })
    expect(list.items[0]?.logs[0]?.metadata).toEqual({})
    expect(network).not.toHaveBeenCalled()
  })

  it('returns legacy success item JSON when no snapshot was linked, including deleted media', async () => {
    const { getJobData } = await import('@/services/job-data')
    await seedJob('json-legacy', 'succeeded')
    await databaseClient
      .update(schema.scrapeJobItem)
      .set({ mediaItemId: null, payload: { original: [1, 2] } })
      .where(eq(schema.scrapeJobItem.id, 'json-legacy-item'))
    expect((await getJobData('json-legacy')).itemPayloads).toEqual([
      {
        id: 'json-legacy-item',
        mediaItemId: null,
        provider: plugin.manifest.id,
        payload: { original: [1, 2] },
      },
    ])
    await expect(getJobData('json-missing')).rejects.toHaveProperty(
      'response.statusCode',
      404,
    )
    expect(network).not.toHaveBeenCalled()
  })

  it('keeps resolved attempts in history but removes them from attention without dismissing them', async () => {
    const { getJobActivity, listJobs, getJob } = await import('@/services/jobs')
    await seedJob('old-failure', 'failed')
    await seedJob('new-failure', 'failed')
    await seedJob('other-film', 'failed', 'film-2')
    await databaseClient
      .update(schema.scrapeJob)
      .set({
        createdAt: new Date('2020-01-01'),
        finishedAt: new Date('2020-01-02'),
      })
      .where(eq(schema.scrapeJob.id, 'old-failure'))
    await databaseClient.insert(schema.providerCurrentState).values({
      id: 'later-success',
      mediaItemId: 'film-1',
      provider: plugin.manifest.id,
      checksum: 'fixture',
      payload: {},
      status: 'succeeded',
      lastScrapedAt: new Date('2021-01-01'),
    })
    expect(
      (await listJobs({ status: 'attention' })).items
        .map((job) => job.id)
        .sort(),
    ).toEqual(['new-failure', 'other-film'])
    expect((await getJobActivity()).failed).toBe(2)
    expect((await listJobs({ status: 'failed' })).totalCount).toBe(3)
    expect((await getJob('old-failure'))?.options.dismissal).toBeUndefined()
  })

  it('does not resolve failures using another provider or import-only state', async () => {
    const { getJobActivity } = await import('@/services/jobs')
    await seedJob('unresolved', 'failed')
    await databaseClient.insert(schema.providerCurrentState).values([
      {
        id: 'other-provider',
        mediaItemId: 'film-1',
        provider: 'different',
        checksum: 'a',
        payload: {},
        status: 'succeeded',
        lastScrapedAt: new Date('2099-01-01'),
      },
      {
        id: 'import-only',
        mediaItemId: 'film-1',
        provider: plugin.manifest.id,
        checksum: 'b',
        payload: {},
        status: 'succeeded',
        lastSuccessfulAt: new Date('2099-01-01'),
      },
    ])
    expect((await getJobActivity()).failed).toBe(1)
  })
  it('retains the exact snapshot job link through the history response contract', async () => {
    const {
      getMediaHistory,
      getMediaSources,
      getMediaSourceSnapshot,
      listMediaSourceSnapshots,
    } = await import('@/services/history')
    const { MediaHistorySchema } = await import('@repo/schemas/media')
    await seedJob('snapshot-origin', 'succeeded')
    await seedJob('different-job', 'failed')
    await databaseClient.insert(schema.providerSnapshot).values([
      {
        id: 'linked-snapshot',
        mediaItemId: 'film-1',
        provider: plugin.manifest.id,
        checksum: 'scraped-checksum',
        payload: { title: 'Fixture film' },
        source: 'scrape',
        scrapeJobId: 'snapshot-origin',
      },
      {
        id: 'imported-snapshot',
        mediaItemId: 'film-1',
        provider: plugin.manifest.id,
        checksum: 'imported-checksum',
        payload: { title: 'Fixture film' },
        source: 'legacy-import',
      },
    ])
    const history = MediaHistorySchema.parse(await getMediaHistory('film-1'))
    expect(
      history.events.find((event) => event.id === 'linked-snapshot'),
    ).toMatchObject({
      type: 'snapshot',
      jobId: 'snapshot-origin',
    })
    expect(
      history.events.find((event) => event.id === 'imported-snapshot'),
    ).toMatchObject({
      type: 'snapshot',
      jobId: null,
    })
    await databaseClient.insert(schema.providerCurrentState).values({
      id: 'current-linked',
      mediaItemId: 'film-1',
      provider: plugin.manifest.id,
      latestSnapshotId: 'linked-snapshot',
      checksum: 'scraped-checksum',
      payload: { title: 'Fixture film' },
      status: 'succeeded',
    })
    expect(await getMediaSources('film-1')).toMatchObject({
      providers: [
        {
          id: plugin.manifest.id,
          latestSnapshot: { id: 'linked-snapshot', jobId: 'snapshot-origin' },
        },
      ],
    })
    const historyPage = await listMediaSourceSnapshots(
      'film-1',
      plugin.manifest.id,
      { page: 1, size: 20 },
    )
    expect(historyPage.totalCount).toBe(2)
    expect(historyPage.items.every((snapshot) => !('data' in snapshot))).toBe(
      true,
    )
    await expect(
      getMediaSourceSnapshot('film-1', plugin.manifest.id, 'linked-snapshot'),
    ).resolves.toMatchObject({ data: { title: 'Fixture film' } })
    await expect(
      getMediaSourceSnapshot(
        'other-film',
        plugin.manifest.id,
        'linked-snapshot',
      ),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    await expect(
      getMediaSourceSnapshot('film-1', 'other-provider', 'linked-snapshot'),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    await databaseClient
      .delete(schema.scrapeJob)
      .where(eq(schema.scrapeJob.id, 'snapshot-origin'))
    const afterDeletion = MediaHistorySchema.parse(
      await getMediaHistory('film-1'),
    )
    expect(
      afterDeletion.events.find((event) => event.id === 'linked-snapshot'),
    ).toMatchObject({
      type: 'snapshot',
      jobId: null,
    })
    expect(execute).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
  })

  it('includes failed, cancelled and scoped jobs without snapshots; filters before paginating', async () => {
    const { listJobs } = await import('@/services/jobs')
    await seedJob('failed-job', 'failed')
    await seedJob('cancelled-job', 'cancelled', 'film-1', false)
    await seedJob('success-job', 'succeeded')
    await seedJob('other-job', 'failed', 'film-2')
    // Legacy jobs may identify the film only through their item records.
    await databaseClient
      .update(schema.scrapeJob)
      .set({ scope: { mediaItemIds: [] } })
      .where(eq(schema.scrapeJob.id, 'failed-job'))
    const history = await listJobs({ mediaItemId: 'film-1', size: 2 })
    const next = await listJobs({ mediaItemId: 'film-1', size: 2, page: 2 })
    expect(history.totalCount).toBe(3)
    expect(history.pageCount).toBe(2)
    expect(history.items).toHaveLength(2)
    expect(next.items).toHaveLength(1)
    expect(
      [...history.items, ...next.items].map((job) => job.id).sort(),
    ).toEqual(['cancelled-job', 'failed-job', 'success-job'])
    expect(
      (await listJobs({ mediaItemId: 'film-1', status: 'failed' })).items.map(
        (job) => job.id,
      ),
    ).toEqual(['failed-job'])
    expect((await listJobs({ mediaItemId: 'missing-film' })).totalCount).toBe(0)
    const filtered = {
      mediaItemId: 'film-1',
      statuses: ['failed', 'cancelled'],
      providers: ['fixture-provider', 'unused-provider'],
      size: 1,
    }
    const firstFiltered = await listJobs(filtered)
    const secondFiltered = await listJobs({ ...filtered, page: 2 })
    expect(firstFiltered.totalCount).toBe(2)
    expect(firstFiltered.pageCount).toBe(2)
    expect(
      [...firstFiltered.items, ...secondFiltered.items]
        .map((job) => job.id)
        .sort(),
    ).toEqual(['cancelled-job', 'failed-job'])
    expect(
      (await listJobs({ ...filtered, providers: ['unused-provider'] }))
        .totalCount,
    ).toBe(0)
    expect(execute).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
  })

  it.each(['failed', 'cancelled'])(
    'dismisses %s jobs without changing errors, history, or provider safety',
    async (status) => {
      const { dismissJob, getJobActivity, listJobs, getJob } =
        await import('@/services/jobs')
      const { JobStatusSchema } = await import('@repo/schemas/job')
      await seedJob('dismiss-me', JobStatusSchema.parse(status))
      await seedJob('keep-attention', 'failed')
      await databaseClient.insert(schema.providerRequestState).values({
        provider: plugin.manifest.id,
        halted: true,
        failureCount: 3,
        cooldownUntil: new Date(Date.now() + 3600000),
        nextAllowedAt: new Date(Date.now() + 2000),
        requests: [Date.now()],
        lastError: 'Too many requests',
      })
      const safetyBefore = await databaseClient
        .select()
        .from(schema.providerRequestState)
      const before = await getJob('dismiss-me')
      expect((await getJobActivity()).failed).toBe(2)
      const dismissed = await dismissJob('dismiss-me', 'reviewer')
      const dismissal = getJobDismissal(dismissed.options)
      expect(dismissal).toEqual({
        dismissedAt: expect.any(String),
        userId: 'reviewer',
      })
      expect(dismissed.status).toBe(status)
      expect(dismissed.errorMessage).toBe(before?.errorMessage)
      expect(dismissed.items).toEqual(before?.items)
      expect(dismissed.logs).toEqual(before?.logs)
      expect(dismissed.options.batchId).toBe('fixture-batch')
      expect((await getJobActivity()).failed).toBe(1)
      expect(
        (await listJobs({ status: 'attention' })).items.map((job) => job.id),
      ).toEqual(['keep-attention'])
      expect((await listJobs({ mediaItemId: 'film-1' })).totalCount).toBe(2)
      expect(
        getJobDismissal(
          (await dismissJob('dismiss-me', 'another-reviewer')).options,
        ),
      ).toEqual(dismissal)
      expect(
        await databaseClient.select().from(schema.providerRequestState),
      ).toEqual(safetyBefore)
      expect(execute).not.toHaveBeenCalled()
      expect(network).not.toHaveBeenCalled()
    },
  )

  it('rejects missing and non-failed jobs', async () => {
    const { dismissJob } = await import('@/services/jobs')
    await expect(dismissJob('missing', 'reviewer')).rejects.toHaveProperty(
      'response.statusCode',
      404,
    )
    for (const status of ['queued', 'running', 'succeeded']) {
      const { JobStatusSchema } = await import('@repo/schemas/job')
      await seedJob(status, JobStatusSchema.parse(status))
      await expect(dismissJob(status, 'reviewer')).rejects.toHaveProperty(
        'response.statusCode',
        409,
      )
    }
    expect(execute).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
  })

  it('dismisses the original failed scrape and requires attention if its replacement fails', async () => {
    const { getJob, retryJob, listJobs, getJobActivity } =
      await import('@/services/jobs')
    await seedJob('original', 'failed')
    const before = await getJob('original')
    const retry = await retryJob('original', null, false)
    const original = await getJob('original')
    expect(getJobDismissal(original?.options ?? {})).toEqual({
      dismissedAt: expect.any(String),
      userId: null,
    })
    expect(original).toMatchObject({
      status: 'failed',
      errorMessage: before?.errorMessage,
      items: before?.items,
      logs: expect.arrayContaining(before?.logs ?? []),
      options: { batchId: 'fixture-batch', retryJobId: retry.id },
    })
    expect(retry.status).toBe('queued')
    expect(getJobDismissal(retry.options)).toBeNull()
    expect(retry.options.retryOf).toBe('original')
    expect(retry.options.benignReviewed).toBe(false)
    await databaseClient
      .update(schema.scrapeJob)
      .set({ status: 'failed' })
      .where(eq(schema.scrapeJob.id, retry.id))
    expect((await getJobActivity()).failed).toBe(1)
    expect(
      (await listJobs({ status: 'attention' })).items.map((job) => job.id),
    ).toEqual([retry.id])
    expect(execute).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
  })

  it('keeps an existing dismissal when retrying a failed job', async () => {
    const { dismissJob, getJob, retryJob } = await import('@/services/jobs')
    await seedJob('original', 'failed')
    const dismissed = await dismissJob('original', 'reviewer')
    await retryJob('original', null, false)
    expect((await getJob('original'))?.options.dismissal).toEqual(
      dismissed.options.dismissal,
    )
  })

  it('dismisses a failed task job when a replacement is queued', async () => {
    const { createTaskJob, getJob, retryJob } = await import('@/services/jobs')
    const userId = 'fixture-reviewer'
    await databaseClient.insert(schema.user).values({
      id: userId,
      name: 'Fixture reviewer',
      email: 'reviewer@example.com',
    })
    const original = await createTaskJob(YOUTUBE_SYNC_TASK, null)
    await databaseClient
      .update(schema.scrapeJob)
      .set({ status: 'failed', errorMessage: 'Original error' })
      .where(eq(schema.scrapeJob.id, original.id))
    const retry = await retryJob(original.id, userId, false)
    const dismissed = await getJob(original.id)
    expect(dismissed).toMatchObject({
      status: 'failed',
      errorMessage: 'Original error',
      options: { retryJobId: retry.id },
    })
    expect(getJobDismissal(dismissed?.options ?? {})).toEqual({
      dismissedAt: expect.any(String),
      userId,
    })
    expect(retry).toMatchObject({
      status: 'queued',
      options: { task: YOUTUBE_SYNC_TASK, retryOf: original.id },
    })
    expect(getJobDismissal(retry.options)).toBeNull()
    expect(network).not.toHaveBeenCalled()
  })

  it('does not inherit intentional cancellation when a new retry fails', async () => {
    const { bulkCancelJobs, getJob, retryJob, getJobActivity } =
      await import('@/services/jobs')
    await seedJob('cancelled-before-start', 'queued')
    await bulkCancelJobs(
      { jobIds: ['cancelled-before-start'], confirmRunning: false },
      'reviewer',
    )
    expect((await getJobActivity()).failed).toBe(0)
    const retry = await retryJob('cancelled-before-start', null, false)
    expect(
      (await getJob('cancelled-before-start'))?.options.dismissal,
    ).toBeUndefined()
    expect(retry.options.cancellation).toBeNull()
    await databaseClient
      .update(schema.scrapeJob)
      .set({ status: 'failed' })
      .where(eq(schema.scrapeJob.id, retry.id))
    expect((await getJobActivity()).failed).toBe(1)
  })

  it('continues excluding reviewed benign failures from attention without dismissing them', async () => {
    const { getJobActivity, listJobs } = await import('@/services/jobs')
    await seedJob('reviewed', 'failed')
    await databaseClient
      .update(schema.scrapeJob)
      .set({ options: { benignReviewed: true } })
      .where(eq(schema.scrapeJob.id, 'reviewed'))
    expect((await getJobActivity()).failed).toBe(0)
    expect((await listJobs({ status: 'attention' })).totalCount).toBe(0)
    const history = await listJobs({ mediaItemId: 'film-1' })
    expect(history.totalCount).toBe(1)
    expect(history.items[0]?.options.dismissal).toBeUndefined()
  })

  it('lists subscription syncs only in the Subscriptions library and mix syncs only in Mixes', async () => {
    const { createTaskJob, getJobActivity, listJobs } =
      await import('@/services/jobs')
    await seedJob('film-job', 'failed')
    const taskJob = (
      id: string,
      provider: string,
      task: string,
      status: Job['status'],
      mediaType: 'album' | null,
    ) => ({
      id,
      provider,
      status,
      scope: { mediaItemIds: [], mediaType, limit: 1 },
      options: { task },
    })
    await databaseClient.insert(schema.scrapeJob).values([
      taskJob(
        'scrobbles',
        'lastfm',
        LASTFM_SCROBBLE_SYNC_TASK,
        'running',
        'album',
      ),
      // Queued before the Subscriptions library existed.
      taskJob('old-youtube', 'youtube', YOUTUBE_SYNC_TASK, 'failed', 'album'),
      taskJob(
        'podcasts',
        'spotify',
        SPOTIFY_PODCAST_SYNC_TASK,
        'running',
        null,
      ),
      taskJob(
        'rinse-mixes',
        'rinse',
        MIX_STATION_SYNC_TASKS.rinse,
        'failed',
        null,
      ),
      taskJob('nts-mixes', 'nts', MIX_STATION_SYNC_TASKS.nts, 'queued', null),
    ])
    const queued = await createTaskJob(YOUTUBE_SYNC_TASK, null)
    expect(queued.scope.mediaType).toBeNull()

    const ids = async (mediaType: 'album' | 'film' | 'subscription' | 'mix') =>
      (await listJobs({ mediaType })).items.map((job) => job.id).sort()
    expect(await ids('subscription')).toEqual(
      [queued.id, 'old-youtube', 'podcasts'].sort(),
    )
    expect(await ids('mix')).toEqual(['nts-mixes', 'rinse-mixes'])
    expect(await ids('album')).toEqual(['scrobbles'])
    expect(await ids('film')).toEqual(['film-job'])
    expect(
      (
        await listJobs({ mediaType: 'subscription', status: 'attention' })
      ).items.map((job) => job.id),
    ).toEqual(['old-youtube'])

    const activity = await getJobActivity()
    expect(activity.libraries).toEqual([
      { mediaType: 'album', queued: 0, running: 1, failed: 0, imports: 0 },
      { mediaType: 'film', queued: 0, running: 0, failed: 1, imports: 0 },
      { mediaType: 'artist', queued: 0, running: 0, failed: 0, imports: 0 },
      { mediaType: 'track', queued: 0, running: 0, failed: 0, imports: 0 },
      {
        mediaType: 'subscription',
        queued: 1,
        running: 1,
        failed: 1,
        imports: 0,
      },
      { mediaType: 'mix', queued: 1, running: 0, failed: 1, imports: 0 },
    ])
  })

  it('lists legacy and current artist enrichment only in Artists and separates activity counts', async () => {
    const { getJobActivity, listJobs } = await import('@/services/jobs')
    await seedJob('film-job', 'failed')
    await databaseClient.insert(schema.scrapeJob).values([
      {
        id: 'legacy-artist',
        provider: 'spotify',
        status: 'failed',
        scope: { mediaType: 'album', mediaItemIds: [], limit: 1 },
        options: {
          task: ARTIST_ENRICHMENT_TASK,
          artistId: 'fixture-artist',
          artistName: 'Fixture artist',
        },
      },
      {
        id: 'current-artist',
        provider: 'lastfm',
        status: 'queued',
        scope: { mediaType: null, mediaItemIds: [], limit: 1 },
        options: {
          task: ARTIST_ENRICHMENT_TASK,
          artistId: 'other-artist',
          artistName: 'Other artist',
        },
      },
      {
        id: 'album-task',
        provider: 'lastfm',
        status: 'running',
        scope: { mediaType: 'album', mediaItemIds: [], limit: 1 },
        options: { task: LASTFM_SCROBBLE_SYNC_TASK },
      },
    ])
    expect(
      (await listJobs({ mediaType: 'artist' })).items
        .map((job) => job.id)
        .sort(),
    ).toEqual(['current-artist', 'legacy-artist'])
    expect(
      (await listJobs({ mediaType: 'album' })).items.map((job) => job.id),
    ).toEqual(['album-task'])
    expect(
      (await listJobs({ mediaType: 'film' })).items.map((job) => job.id),
    ).toEqual(['film-job'])
    expect(
      (
        await listJobs({
          mediaType: 'artist',
          artistId: 'fixture-artist',
          provider: 'spotify',
          status: 'attention',
        })
      ).items.map((job) => job.id),
    ).toEqual(['legacy-artist'])
    expect(
      (await listJobs({ mediaType: 'artist', q: 'Other' })).items.map(
        (job) => job.id,
      ),
    ).toEqual(['current-artist'])
    const activity = await getJobActivity()
    expect(
      activity.libraries.find((library) => library.mediaType === 'artist'),
    ).toEqual({
      mediaType: 'artist',
      queued: 1,
      running: 0,
      failed: 1,
      imports: 0,
    })
    expect(
      activity.libraries.find((library) => library.mediaType === 'album'),
    ).toEqual({
      mediaType: 'album',
      queued: 0,
      running: 1,
      failed: 0,
      imports: 0,
    })
    expect(network).not.toHaveBeenCalled()
  })
})

it('sorts every job column before pagination and uses the visible result for each view', async () => {
  const { listJobs } = await import('@/services/jobs')
  await seedJob('sort-a', 'failed', 'film-1')
  await seedJob('sort-z', 'succeeded', 'film-2')
  await databaseClient
    .update(schema.scrapeJob)
    .set({
      provider: 'z-provider',
      createdAt: new Date('2026-02-01'),
      startedAt: new Date('2026-02-02'),
      finishedAt: new Date('2026-02-03'),
      errorMessage: 'Zulu job error',
    })
    .where(eq(schema.scrapeJob.id, 'sort-a'))
  await databaseClient
    .update(schema.scrapeJob)
    .set({
      provider: 'a-provider',
      createdAt: new Date('2026-01-01'),
      startedAt: new Date('2026-01-02'),
      finishedAt: new Date('2026-01-03'),
      errorMessage: 'Alpha job error',
    })
    .where(eq(schema.scrapeJob.id, 'sort-z'))
  await databaseClient
    .update(schema.scrapeJobItem)
    .set({ message: 'Alpha item result' })
    .where(eq(schema.scrapeJobItem.jobId, 'sort-a'))
  await databaseClient
    .update(schema.scrapeJobItem)
    .set({ message: 'Zulu item result' })
    .where(eq(schema.scrapeJobItem.jobId, 'sort-z'))
  const expected = {
    provider: 'sort-z',
    title: 'sort-a',
    status: 'sort-a',
    createdAt: 'sort-z',
    startedAt: 'sort-z',
    finishedAt: 'sort-z',
    result: 'sort-z',
  }
  const { JobSortKeySchema } = await import('@repo/schemas/job')
  for (const sortBy of JobSortKeySchema.options) {
    const first = await listJobs({ sortBy, direction: 'asc', size: 1 })
    const second = await listJobs({
      sortBy,
      direction: 'asc',
      size: 1,
      page: 2,
    })
    expect(first.items[0]?.id).toBe(expected[sortBy])
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id)
    expect(first.totalCount).toBe(2)
  }
  const history = await listJobs({
    sortBy: 'result',
    direction: 'asc',
    mediaItemId: 'film-1',
  })
  expect(history.items[0]?.items[0]?.message).toBe('Alpha item result')
  expect(network).not.toHaveBeenCalled()
})
