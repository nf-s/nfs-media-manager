import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
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
  ARTIST_ENRICHMENT_TASK,
  QueueArtistSelectionSchema,
} from '@repo/schemas/artist-profiles'
import {
  ArtistMetadataQuerySchema,
  ArtistQuerySchema,
} from '@repo/schemas/creators'
import type { Job } from '@repo/schemas/job'
import { env } from '@/env'
import { musicbrainzPlugin } from '@/plugins/builtin/musicbrainz'
import * as schema from '@/schemas/db'

const database = 'artist_selection_' + randomUUID().replaceAll('-', '')
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
const request = vi.fn<typeof fetch>()
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async (id: string) =>
    id === 'musicbrainz' ? musicbrainzPlugin : null,
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({
    appName: 'OfflineFixture',
    appVersion: '2.0',
    contact: 'offline@example.test',
  }),
}))

const now = Date.now()
const oldDate = new Date(now - 100 * 86400000)
const recentDate = new Date(now - 86400000)
const started = new Date(now - 3600000)
const ids = ['never', 'recent', 'old', 'failed', 'queued', 'hidden']
let created = false

async function job(
  id: string,
  artistId: string,
  status: Job['status'],
  date: Date,
  startedAt: Date | null,
  provider = 'spotify',
) {
  await databaseClient.insert(schema.scrapeJob).values({
    id,
    provider,
    status,
    createdAt: date,
    startedAt,
    finishedAt: status === 'queued' || status === 'running' ? null : date,
    scope: { mediaType: 'album' },
    options: { task: ARTIST_ENRICHMENT_TASK, artistId, groupKey: artistId },
  })
}

beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query('create database ' + database)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  request.mockReset().mockImplementation(async () => {
    throw new Error('Network forbidden in artist selection tests')
  })
  await databaseClient.delete(schema.artistProviderCurrentState)
  await databaseClient.delete(schema.artistProviderSnapshot)
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.playlist)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.artist)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.insert(schema.artist).values(
    ids.map((id) => ({
      id,
      name:
        id === 'recent'
          ? 'shared fixture'
          : id === 'old'
            ? 'Shared fixture'
            : `${id} fixture`,
    })),
  )
  await databaseClient.insert(schema.mediaItem).values(
    ids.map((id) => ({
      id: `album-${id}`,
      slug: `album-${id}`,
      title: `Album ${id}`,
      mediaType: 'album',
      metadata: id === 'hidden' ? { legacyHidden: true } : {},
    })),
  )
  await databaseClient
    .insert(schema.album)
    .values(ids.map((id) => ({ mediaItemId: `album-${id}` })))
  await databaseClient.insert(schema.mediaCredit).values(
    ids.map((id) => ({
      artistId: id,
      mediaItemId: `album-${id}`,
      role: 'artist',
    })),
  )
  await databaseClient.insert(schema.mediaItem).values([
    {
      id: 'track-linked',
      slug: 'track-linked',
      title: 'Linked track',
      mediaType: 'track',
    },
    {
      id: 'track-canonical',
      slug: 'track-canonical',
      title: 'Canonical track',
      mediaType: 'track',
    },
  ])
  await databaseClient
    .insert(schema.libraryTrack)
    .values([
      { mediaItemId: 'track-linked', albumMediaItemId: 'album-old' },
      { mediaItemId: 'track-canonical' },
    ])
  await databaseClient.insert(schema.track).values({
    id: 'canonical-entry',
    albumMediaItemId: 'album-never',
    trackMediaItemId: 'track-canonical',
    title: 'Canonical track',
    position: 1,
  })
  await databaseClient.insert(schema.mediaCredit).values([
    { mediaItemId: 'track-linked', artistId: 'queued', role: 'artist' },
    { mediaItemId: 'track-canonical', artistId: 'recent', role: 'artist' },
  ])
  await databaseClient.insert(schema.playlist).values([
    {
      id: 'tracks',
      name: 'Track fixture',
      kind: 'playlist',
      source: 'spotify',
    },
    { id: 'albums', name: 'Album fixture', kind: 'playlist' },
    { id: 'canonical', name: 'Canonical fixture', kind: 'playlist' },
    { id: 'collection', name: 'Collection fixture', kind: 'collection' },
  ])
  await databaseClient.insert(schema.playlistItem).values([
    { playlistId: 'tracks', mediaItemId: 'track-linked' },
    { playlistId: 'tracks', mediaItemId: 'album-hidden' },
    { playlistId: 'albums', mediaItemId: 'album-recent' },
    { playlistId: 'canonical', mediaItemId: 'track-canonical' },
    { playlistId: 'collection', mediaItemId: 'album-failed' },
  ])
  for (const { artistId, date } of [
    { artistId: 'old', date: oldDate },
    { artistId: 'recent', date: recentDate },
  ]) {
    const jobId = `success-${artistId}`
    await job(jobId, artistId, 'succeeded', date, date)
    await databaseClient.insert(schema.artistProviderSnapshot).values({
      id: `snapshot-${artistId}`,
      artistId,
      provider: 'spotify',
      createdAt: date,
      normalizedData: { tags: [] },
      payload: {},
      scrapeJobId: jobId,
    })
    await databaseClient.insert(schema.artistProviderCurrentState).values({
      artistId,
      provider: 'spotify',
      latestSnapshotId: `snapshot-${artistId}`,
    })
  }
  await job('failure', 'failed', 'failed', started, started)
  await job('failure-requeued', 'failed', 'queued', new Date(now), null)
  await job('only-queued', 'queued', 'queued', new Date(now), null)
  await job('other-provider', 'never', 'failed', started, started, 'lastfm')
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query('drop database ' + database)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('artist selection', () => {
  it('filters playlist memberships before sorting, counting and paging', async () => {
    const { listArtists, listArtistMetadata } =
      await import('@/services/creators')
    const first = await listArtists(
      ArtistQuerySchema.parse({ playlistIds: ['tracks'], size: 1 }),
    )
    const second = await listArtists(
      ArtistQuerySchema.parse({ playlistIds: ['tracks'], size: 1, page: 2 }),
    )
    expect(first.totalCount).toBe(2)
    expect(
      [...first.items, ...second.items].map((row) => row.id).sort(),
    ).toEqual(['old', 'queued'])
    expect(
      (
        await listArtists(
          ArtistQuerySchema.parse({ playlistIds: ['canonical'] }),
        )
      ).items
        .map((row) => row.id)
        .sort(),
    ).toEqual(['never', 'recent'])
    expect(
      (
        await listArtists(
          ArtistQuerySchema.parse({ playlistIds: ['tracks', 'albums'] }),
        )
      ).totalCount,
    ).toBe(3)
    expect(
      (
        await listArtists(
          ArtistQuerySchema.parse({ playlistIds: ['collection'] }),
        )
      ).totalCount,
    ).toBe(0)
    expect(
      (
        await listArtistMetadata(
          ArtistMetadataQuerySchema.parse({
            playlistIds: ['albums'],
            q: 'Shared',
          }),
        )
      ).items.map((row) => row.id),
    ).toEqual(['recent'])
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps success dates, actual attempts and latest queued statuses distinct', async () => {
    const { listArtistMetadata } = await import('@/services/creators')
    const result = await listArtistMetadata(ArtistMetadataQuerySchema.parse({}))
    expect(result.totalCount).toBe(5)
    expect(
      result.items.find((row) => row.id === 'old')?.providers,
    ).toContainEqual({
      provider: 'spotify',
      lastScrapedAt: oldDate.toISOString(),
      lastAttemptAt: oldDate.toISOString(),
      lastJobStatus: 'succeeded',
    })
    expect(
      result.items.find((row) => row.id === 'failed')?.providers,
    ).toContainEqual({
      provider: 'spotify',
      lastScrapedAt: null,
      lastAttemptAt: started.toISOString(),
      lastJobStatus: 'queued',
    })
    expect(
      result.items.find((row) => row.id === 'queued')?.providers,
    ).toContainEqual({
      provider: 'spotify',
      lastScrapedAt: null,
      lastAttemptAt: null,
      lastJobStatus: 'queued',
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('combines freshness modes with OR per provider and AND across providers', async () => {
    const { listArtistMetadata } = await import('@/services/creators')
    const matching = async (freshness: unknown) =>
      (
        await listArtistMetadata(ArtistMetadataQuerySchema.parse({ freshness }))
      ).items
        .map((row) => row.id)
        .sort()
    expect(await matching([{ provider: 'spotify', mode: 'never' }])).toEqual([
      'never',
      'queued',
    ])
    expect(await matching([{ provider: 'spotify', mode: 'failed' }])).toEqual([
      'failed',
    ])
    expect(
      await matching([{ provider: 'spotify', mode: 'unscraped' }]),
    ).toEqual(['failed', 'never', 'queued'])
    expect(
      await matching([
        { provider: 'spotify', mode: 'older', olderThanDays: 30 },
      ]),
    ).toEqual(['failed', 'never', 'old', 'queued'])
    expect(
      await matching([
        { provider: 'spotify', mode: 'never' },
        { provider: 'spotify', mode: 'failed' },
      ]),
    ).toEqual(['failed', 'never', 'queued'])
    expect(
      await matching([
        { provider: 'spotify', mode: 'never' },
        { provider: 'lastfm', mode: 'failed' },
      ]),
    ).toEqual(['never'])
    expect(
      await matching([
        { provider: 'spotify', mode: 'all' },
        { provider: 'spotify', mode: 'failed' },
      ]),
    ).toHaveLength(5)
  })

  it('sorts freshness with never scraped first ascending and stable name ties', async () => {
    const { listArtistMetadata } = await import('@/services/creators')
    const ascending = await listArtistMetadata(
      ArtistMetadataQuerySchema.parse({
        provider: 'spotify',
        sortBy: 'lastScrapedAt',
        size: 2,
      }),
    )
    const descending = await listArtistMetadata(
      ArtistMetadataQuerySchema.parse({
        provider: 'spotify',
        sortBy: 'lastScrapedAt',
        direction: 'desc',
        size: 2,
      }),
    )
    expect(ascending.items.map((row) => row.id)).toEqual(['failed', 'never'])
    expect(descending.items.map((row) => row.id)).toEqual(['recent', 'old'])
    const first = await listArtistMetadata(
      ArtistMetadataQuerySchema.parse({ q: 'Shared', size: 1 }),
    )
    const second = await listArtistMetadata(
      ArtistMetadataQuerySchema.parse({ q: 'Shared', size: 1, page: 2 }),
    )
    expect([first.items[0]?.id, second.items[0]?.id]).toEqual(['old', 'recent'])
  })

  it('requires confirmation, excludes hidden artists and queues only explicit eligible pairs', async () => {
    const { queueArtistSelection } = await import('@/services/artist-selection')
    await expect(
      queueArtistSelection(
        QueueArtistSelectionSchema.parse({
          artistIds: ['never', 'old'],
          providers: ['spotify', 'lastfm', 'discogs'],
        }),
        null,
      ),
    ).rejects.toMatchObject({ response: { statusCode: 422 } })
    await expect(
      queueArtistSelection(
        QueueArtistSelectionSchema.parse({
          artistIds: ['hidden'],
          providers: ['musicbrainz'],
        }),
        null,
      ),
    ).rejects.toMatchObject({ response: { statusCode: 422 } })
    const result = await queueArtistSelection(
      QueueArtistSelectionSchema.parse({
        artistIds: ['never', 'old'],
        providers: ['musicbrainz'],
      }),
      null,
    )
    expect(result.jobs).toHaveLength(2)
    expect(result.skipped).toEqual([])
    expect(result.jobs.map((job) => job.options.artistId).sort()).toEqual([
      'never',
      'old',
    ])
    expect(
      result.jobs.every(
        (job) => job.scope.mediaType === null && job.items.length === 0,
      ),
    ).toBe(true)
    const repeated = await queueArtistSelection(
      QueueArtistSelectionSchema.parse({
        artistIds: ['never'],
        providers: ['musicbrainz'],
      }),
      null,
    )
    expect(repeated.jobs).toEqual([])
    expect(repeated.skipped).toMatchObject([
      { artistId: 'never', provider: 'musicbrainz' },
    ])
    const refreshed = await queueArtistSelection(
      QueueArtistSelectionSchema.parse({
        artistIds: ['recent'],
        providers: ['spotify'],
        freshness: [{ provider: 'spotify', mode: 'unscraped' }],
      }),
      null,
    )
    expect(refreshed.jobs).toEqual([])
    expect(refreshed.skipped[0]?.reason).toMatch(/freshness/)
    await expect(
      queueArtistSelection(
        QueueArtistSelectionSchema.parse({
          artistIds: ['recent'],
          providers: ['musicbrainz'],
          freshness: [{ provider: 'spotify', mode: 'never' }],
        }),
        null,
      ),
    ).rejects.toMatchObject({ response: { statusCode: 422 } })
    const partial = await queueArtistSelection(
      QueueArtistSelectionSchema.parse({
        artistIds: ['recent'],
        providers: ['spotify', 'musicbrainz'],
      }),
      null,
    )
    expect(partial.jobs).toHaveLength(1)
    expect(partial.jobs[0]?.provider).toBe('musicbrainz')
    expect(partial.skipped).toMatchObject([
      { artistId: 'recent', provider: 'spotify' },
    ])
    const confirmed = await queueArtistSelection(
      QueueArtistSelectionSchema.parse({
        artistIds: ['never', 'old'],
        providers: ['spotify', 'lastfm', 'discogs'],
        confirmBroadRun: true,
      }),
      null,
    )
    expect(confirmed.skipped).toHaveLength(6)
    expect(request).not.toHaveBeenCalled()
  })
})
