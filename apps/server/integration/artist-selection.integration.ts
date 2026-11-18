import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
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
import { ArtistSelectionSnapshotPageQuerySchema } from '@repo/schemas/artist-selection'
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
  listArtistEnrichmentProviderIds: async () => [
    'musicbrainz',
    'spotify',
    'lastfm',
    'discogs',
  ],
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
const ownerId = 'snapshot-owner'
const otherOwnerId = 'other-owner'
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
  await databaseClient.insert(schema.user).values([
    { id: ownerId, name: 'Fixture owner', email: 'owner@example.test' },
    { id: otherOwnerId, name: 'Other owner', email: 'other@example.test' },
  ])
})
beforeEach(async () => {
  request.mockReset().mockImplementation(async () => {
    throw new Error('Network forbidden in artist selection tests')
  })
  await databaseClient.delete(schema.artistSelectionSnapshot)
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

  it('captures artist Browse filters and freshness before applying the sorted result limit', async () => {
    const { createArtistSelectionSnapshot, listArtistSelectionSnapshotPage } =
      await import('@/services/artist-bulk-selection')
    const query = ArtistMetadataQuerySchema.parse({
      q: 'fixture',
      playlistIds: ['tracks', 'albums'],
      filters: [{ field: 'name', mode: 'exclude', value: 'queued fixture' }],
      ranges: [{ field: 'albumCount', min: 1 }],
      freshness: [{ provider: 'lastfm', mode: 'never' }],
      provider: 'spotify',
      sortBy: 'lastScrapedAt',
      direction: 'desc',
      limitResults: 1,
      page: 2,
      size: 1,
    })
    const page = (id: string) =>
      listArtistSelectionSnapshotPage(id, { size: 100 }, ownerId)
    const recent = await createArtistSelectionSnapshot(query, ownerId)
    expect(recent.totalCount).toBe(1)
    expect(await page(recent.id)).toEqual({
      ids: ['recent'],
      nextCursor: null,
      totalCount: 1,
      expiresAt: recent.expiresAt,
    })
    const stale = await createArtistSelectionSnapshot(
      {
        ...query,
        freshness: [
          ...query.freshness,
          { provider: 'spotify', mode: 'older', olderThanDays: 30 },
        ],
      },
      ownerId,
    )
    expect((await page(stale.id)).ids).toEqual(['old'])
    expect(request).not.toHaveBeenCalled()
  })

  it('pages an immutable selection of more than 1,000 matches without creating jobs', async () => {
    const { createArtistSelectionSnapshot, listArtistSelectionSnapshotPage } =
      await import('@/services/artist-bulk-selection')
    const matches = Array.from({ length: 1001 }, (_, index) => ({
      id: `bulk-${String(index).padStart(4, '0')}`,
      name: `Bulk fixture artist ${index}`,
    }))
    await databaseClient.insert(schema.artist).values(matches)
    await databaseClient.insert(schema.mediaCredit).values(
      matches.map(({ id }) => ({
        artistId: id,
        mediaItemId: 'album-never',
        role: 'artist',
      })),
    )
    const originalJobs = await databaseClient.$count(schema.scrapeJob)
    const snapshot = await createArtistSelectionSnapshot(
      ArtistMetadataQuerySchema.parse({ q: 'bulk', page: 7, size: 1 }),
      ownerId,
    )
    expect(snapshot.totalCount).toBe(matches.length)

    await databaseClient
      .delete(schema.artist)
      .where(eq(schema.artist.id, 'bulk-0000'))
    await databaseClient
      .insert(schema.artist)
      .values({ id: 'bulk-new', name: 'Bulk fixture artist' })
    await databaseClient.insert(schema.mediaCredit).values({
      artistId: 'bulk-new',
      mediaItemId: 'album-never',
      role: 'artist',
    })
    const reviewed = await listArtistSelectionSnapshotPage(
      snapshot.id,
      ArtistSelectionSnapshotPageQuerySchema.parse({
        ids: JSON.stringify(['bulk-0000', 'bulk-1000', 'bulk-new']),
      }),
      ownerId,
    )
    expect(reviewed).toEqual({
      ids: ['bulk-0000', 'bulk-1000'],
      nextCursor: null,
      totalCount: matches.length,
      expiresAt: snapshot.expiresAt,
    })
    let after: string | undefined
    const selected: string[] = []
    for (let offset = 0; offset < matches.length; offset += 100) {
      const page = await listArtistSelectionSnapshotPage(
        snapshot.id,
        { after, size: 100 },
        ownerId,
      )
      expect(page.ids).toHaveLength(Math.min(100, matches.length - offset))
      expect(page.nextCursor).toBe(
        offset + 100 < matches.length ? page.ids.at(-1) : null,
      )
      selected.push(...page.ids)
      after = page.nextCursor ?? undefined
    }
    expect(selected).toEqual(matches.map(({ id }) => id))
    expect(await databaseClient.$count(schema.scrapeJob)).toBe(originalJobs)
    expect(request).not.toHaveBeenCalled()
  })

  it('restricts snapshot pages to the owner and retains only their unexpired selections', async () => {
    const { createArtistSelectionSnapshot, listArtistSelectionSnapshotPage } =
      await import('@/services/artist-bulk-selection')
    const query = ArtistMetadataQuerySchema.parse({ q: 'no artist matches' })
    const empty = await createArtistSelectionSnapshot(query, ownerId)
    expect(
      await listArtistSelectionSnapshotPage(empty.id, { size: 1 }, ownerId),
    ).toEqual({
      ids: [],
      nextCursor: null,
      totalCount: 0,
      expiresAt: empty.expiresAt,
    })
    const queryWithMembers = ArtistMetadataQuerySchema.parse({ q: 'Shared' })
    const expired = await createArtistSelectionSnapshot(
      queryWithMembers,
      ownerId,
    )
    const other = await createArtistSelectionSnapshot(
      queryWithMembers,
      otherOwnerId,
    )
    await expect(
      listArtistSelectionSnapshotPage(empty.id, { size: 1 }, otherOwnerId),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    await databaseClient
      .update(schema.artistSelectionSnapshot)
      .set({
        expiresAt: new Date(0),
      })
      .where(eq(schema.artistSelectionSnapshot.id, expired.id))
    await databaseClient
      .update(schema.artistSelectionSnapshot)
      .set({
        expiresAt: new Date(0),
      })
      .where(eq(schema.artistSelectionSnapshot.id, other.id))
    await expect(
      listArtistSelectionSnapshotPage(expired.id, { size: 1 }, ownerId),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    const fresh = await createArtistSelectionSnapshot(query, ownerId)
    const remaining = await databaseClient
      .select({ id: schema.artistSelectionSnapshot.id })
      .from(schema.artistSelectionSnapshot)
    expect(remaining.map(({ id }) => id).sort()).toEqual(
      [empty.id, fresh.id, other.id].sort(),
    )
    expect(
      await databaseClient.$count(
        schema.artistSelectionMember,
        eq(schema.artistSelectionMember.selectionId, expired.id),
      ),
    ).toBe(0)
    expect(request).not.toHaveBeenCalled()
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
    const result = await queueArtistSelection(
      QueueArtistSelectionSchema.parse({
        artistIds: ['never', 'hidden', 'missing', 'old'],
        providers: ['musicbrainz'],
      }),
      null,
    )
    expect(result.jobs).toHaveLength(2)
    expect(result.skipped).toEqual(
      ['hidden', 'missing'].map((artistId) => ({
        artistId,
        provider: 'musicbrainz',
        reason: 'Artist is missing or archived.',
      })),
    )
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

  it('skips a legacy active artist job without a group key and queues other selected artists', async () => {
    const { queueArtistSelection } = await import('@/services/artist-selection')
    await databaseClient.insert(schema.scrapeJob).values({
      id: 'legacy-active',
      provider: 'musicbrainz',
      status: 'queued',
      scope: { mediaType: 'album' },
      options: { task: ARTIST_ENRICHMENT_TASK, artistId: 'old' },
    })
    const result = await queueArtistSelection(
      QueueArtistSelectionSchema.parse({
        artistIds: ['old', 'never'],
        providers: ['musicbrainz'],
      }),
      null,
    )
    expect(result.jobs.map(({ options }) => options.artistId)).toEqual([
      'never',
    ])
    expect(result.skipped).toEqual([
      {
        artistId: 'old',
        provider: 'musicbrainz',
        reason: 'An artist job is already queued or running.',
      },
    ])
    expect(request).not.toHaveBeenCalled()
  })
})
