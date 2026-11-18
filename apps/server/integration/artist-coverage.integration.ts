import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { z } from 'zod'
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
import {
  ARTIST_ENRICHMENT_TASK,
  QueueArtistSelectionSchema,
} from '@repo/schemas/artist-profiles'
import { env } from '@/env'
import { createCatalogEntryFromPlugin } from '@/lib/provider-catalog'
import * as schema from '@/schemas/db'

const database = `artist_coverage_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const logQuery = vi.fn<(query: string, params: unknown[]) => void>()
const databaseClient = drizzle(pool, { schema, logger: { logQuery } })
const execute = vi.fn<NonNullable<MediaProviderPlugin['scrapeMediaItem']>>()
const plugin = (
  id: string,
  options: Partial<MediaProviderPlugin['manifest']> = {},
): MediaProviderPlugin => ({
  manifest: {
    id,
    displayName: `Fixture ${id}`,
    description: '',
    mediaTypes: ['album'],
    identifierTypes: ['album'],
    secrets: [],
    rateLimit: { maxConcurrent: 1, minTimeMs: 2000 },
    maxItemsPerJob: 1,
    requireExplicitSelection: true,
    ...options,
  },
  scrapeMediaItem: execute,
})
// musicbrainz and lastfm enrich artists; lastfm lacks its credential.
// fixture-album only scrapes albums, so artist coverage leaves it out.
const plugins = [
  plugin('fixture-album', { supportsNameLookup: true }),
  plugin('musicbrainz'),
  plugin('lastfm', {
    secrets: [
      { key: 'fixtureToken', label: 'Token', required: true, envVars: [] },
    ],
  }),
]
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  listArtistEnrichmentProviderIds: async () => ['musicbrainz', 'lastfm'],
  listLoadedScrapePlugins: async () => plugins,
  getScrapePlugin: async (id: string) =>
    plugins.find((item) => item.manifest.id === id) ?? null,
  listProviderCatalog: async () =>
    plugins.map((item) => createCatalogEntryFromPlugin(item, null)),
}))

const DAY = 86400000
const PLAYLIST = 'playlist-artists'
const PlanRowsSchema = z.array(z.object({ 'QUERY PLAN': z.string() }))

let created = false
beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No network in artist coverage tests')
    }),
  )
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.playlist)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.artist)
  logQuery.mockClear()
})
afterAll(async () => {
  expect(fetch).not.toHaveBeenCalled()
  expect(execute).not.toHaveBeenCalled()
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

async function artist(id: string, name: string) {
  await databaseClient
    .insert(schema.artist)
    .values({ id, name })
    .onConflictDoNothing()
}

async function credit(mediaItemId: string, artistId: string) {
  await databaseClient
    .insert(schema.mediaCredit)
    .values({ mediaItemId, artistId, role: 'artist' })
}

async function album(id: string, artistId: string, hidden = false) {
  await databaseClient.insert(schema.mediaItem).values({
    id,
    slug: id,
    title: `Title ${id}`,
    mediaType: 'album',
    metadata: hidden ? { legacyHidden: true } : null,
  })
  await databaseClient.insert(schema.album).values({ mediaItemId: id })
  await credit(id, artistId)
}

async function libraryTrack(
  id: string,
  artistId: string,
  albumId: string | null,
) {
  await databaseClient.insert(schema.mediaItem).values({
    id,
    slug: id,
    title: `Title ${id}`,
    mediaType: 'track',
  })
  await databaseClient
    .insert(schema.libraryTrack)
    .values({ mediaItemId: id, albumMediaItemId: albumId })
  await credit(id, artistId)
}

async function playlist(id: string, members: string[]) {
  await databaseClient.insert(schema.playlist).values({
    id,
    name: `Playlist ${id}`,
    kind: 'playlist',
    source: 'spotify',
  })
  if (members.length)
    await databaseClient
      .insert(schema.playlistItem)
      .values(members.map((mediaItemId) => ({ playlistId: id, mediaItemId })))
}

async function profiled(artistId: string, at: Date) {
  const id = `snapshot-${artistId}`
  await databaseClient.insert(schema.artistProviderSnapshot).values({
    id,
    artistId,
    provider: 'musicbrainz',
    createdAt: at,
    normalizedData: { tags: [] },
    payload: {},
  })
  await databaseClient.insert(schema.artistProviderCurrentState).values({
    artistId,
    provider: 'musicbrainz',
    latestSnapshotId: id,
  })
}

/**
 * A playlist of two tracks and one album entry:
 * - track-1 is credited to Fresh (current MusicBrainz profile) and is on
 *   album-of-track, credited to Album Artist (no profile)
 * - album-entry is credited to Stale (MusicBrainz profile 400 days old)
 * - track-2 is credited to Zed (no profile) and is on a hidden album, whose
 *   only artist coverage leaves out
 * - Outside is credited on a track in another playlist only
 */
async function seed() {
  for (const [id, name] of [
    ['artist-fresh', 'Fresh'],
    ['artist-album', 'Album Artist'],
    ['artist-stale', 'Stale'],
    ['artist-zed', 'Zed'],
    ['artist-hidden', 'Hidden Only'],
    ['artist-outside', 'Outside'],
  ])
    await artist(id, name)
  await album('album-of-track', 'artist-album')
  await album('album-entry', 'artist-stale')
  await album('album-hidden', 'artist-hidden', true)
  await libraryTrack('track-1', 'artist-fresh', 'album-of-track')
  await libraryTrack('track-2', 'artist-zed', 'album-hidden')
  await libraryTrack('track-outside', 'artist-outside', null)
  await playlist(PLAYLIST, ['track-1', 'album-entry', 'track-2'])
  await playlist('playlist-other', ['track-outside'])
  await profiled('artist-fresh', new Date())
  await profiled('artist-stale', new Date(Date.now() - 400 * DAY))
  await profiled('artist-outside', new Date(Date.now() - 400 * DAY))
}

describe('playlist artist coverage', () => {
  it('counts current, stale and missing profiles per artist provider', async () => {
    const { getPlaylistArtistCoverage } =
      await import('@/services/metadata-coverage')
    await seed()
    const coverage = await getPlaylistArtistCoverage(PLAYLIST, {
      olderThanDays: 180,
    })
    expect(coverage.total).toBe(4)
    expect(coverage.providers.map((row) => row.provider)).toEqual([
      'musicbrainz',
      'lastfm',
    ])
    expect(coverage.providers[0]).toEqual({
      provider: 'musicbrainz',
      displayName: 'Fixture musicbrainz',
      eligible: 4,
      covered: 1,
      stale: 1,
      missing: 2,
      unavailableReason: null,
      missingItemIds: ['artist-album', 'artist-zed'],
      staleItemIds: ['artist-stale'],
    })
    expect(coverage.providers[1]).toMatchObject({
      provider: 'lastfm',
      eligible: 4,
      covered: 0,
      stale: 0,
      missing: 4,
      unavailableReason: 'credentials-missing',
      missingItemIds: [
        'artist-album',
        'artist-fresh',
        'artist-stale',
        'artist-zed',
      ],
    })

    const longer = await getPlaylistArtistCoverage(PLAYLIST, {
      olderThanDays: 500,
    })
    expect(longer.providers[0]).toMatchObject({
      covered: 2,
      stale: 0,
      missing: 2,
      staleItemIds: [],
    })
  })

  it('matches the Metadata page playlist filter', async () => {
    const { getPlaylistArtistCoverage } =
      await import('@/services/metadata-coverage')
    const { listArtistMetadata } = await import('@/services/creators')
    const { ArtistMetadataQuerySchema } = await import('@repo/schemas/creators')
    await seed()
    const coverage = await getPlaylistArtistCoverage(PLAYLIST, {
      olderThanDays: 180,
    })
    const matching = async (freshness: unknown) =>
      (
        await listArtistMetadata(
          ArtistMetadataQuerySchema.parse({
            playlistIds: [PLAYLIST],
            freshness,
          }),
        )
      ).items
        .map((row) => row.id)
        .sort()
    expect((await matching([])).length).toBe(coverage.total)
    expect(
      await matching([{ provider: 'musicbrainz', mode: 'unscraped' }]),
    ).toEqual(coverage.providers[0]?.missingItemIds)
    // The Metadata page's older filter also lists the never fetched.
    expect(
      await matching([
        { provider: 'musicbrainz', mode: 'older', olderThanDays: 180 },
      ]),
    ).toEqual(['artist-album', 'artist-stale', 'artist-zed'])
  })

  it('queues only artists through the artist queue, which skips active jobs and rechecks freshness', async () => {
    const { getPlaylistArtistCoverage } =
      await import('@/services/metadata-coverage')
    const { queueArtistSelection } = await import('@/services/artist-selection')
    await seed()
    const coverage = await getPlaylistArtistCoverage(PLAYLIST, {
      olderThanDays: 180,
    })
    const provider = coverage.providers[0]
    expect(provider?.provider).toBe('musicbrainz')
    const missing = await queueArtistSelection(
      QueueArtistSelectionSchema.parse({
        artistIds: provider?.missingItemIds,
        providers: ['musicbrainz'],
        freshness: [{ provider: 'musicbrainz', mode: 'unscraped' }],
      }),
      null,
    )
    expect(missing.jobs.map((job) => job.options.artistId).sort()).toEqual([
      'artist-album',
      'artist-zed',
    ])
    expect(missing.skipped).toEqual([])

    const stale = await queueArtistSelection(
      QueueArtistSelectionSchema.parse({
        // A stale ID that was refreshed since no longer matches.
        artistIds: [...(provider?.staleItemIds ?? []), 'artist-fresh'],
        providers: ['musicbrainz'],
        freshness: [
          { provider: 'musicbrainz', mode: 'older', olderThanDays: 180 },
        ],
      }),
      null,
    )
    expect(stale.jobs.map((job) => job.options.artistId)).toEqual([
      'artist-stale',
    ])
    expect(stale.skipped).toEqual([
      {
        artistId: 'artist-fresh',
        provider: 'musicbrainz',
        reason: 'No longer matches the freshness filter.',
      },
    ])

    const again = await queueArtistSelection(
      QueueArtistSelectionSchema.parse({
        artistIds: provider?.missingItemIds,
        providers: ['musicbrainz'],
        freshness: [{ provider: 'musicbrainz', mode: 'unscraped' }],
      }),
      null,
    )
    expect(again.jobs).toEqual([])
    expect(again.skipped.map((row) => row.reason)).toEqual([
      'An artist job is already queued or running.',
      'An artist job is already queued or running.',
    ])

    // Only artist jobs exist; no album was queued.
    expect(
      [...missing.jobs, ...stale.jobs].every(
        (job) => job.scope.mediaType === null && job.items.length === 0,
      ),
    ).toBe(true)
    const jobs = await databaseClient.select().from(schema.scrapeJob)
    expect(jobs.map((job) => job.options.task)).toEqual([
      ARTIST_ENRICHMENT_TASK,
      ARTIST_ENRICHMENT_TASK,
      ARTIST_ENRICHMENT_TASK,
    ])
    // Queueing changes no stored profile, so the counts stay until jobs run.
    expect(
      (await getPlaylistArtistCoverage(PLAYLIST, { olderThanDays: 180 }))
        .providers[0],
    ).toMatchObject({ covered: 1, stale: 1, missing: 2 })
  })

  it('reports an empty playlist and refuses an unknown one', async () => {
    const { getPlaylistArtistCoverage } =
      await import('@/services/metadata-coverage')
    await playlist('playlist-empty', [])
    const coverage = await getPlaylistArtistCoverage('playlist-empty', {
      olderThanDays: 180,
    })
    expect(coverage.total).toBe(0)
    expect(coverage.providers).toEqual([
      expect.objectContaining({
        provider: 'musicbrainz',
        eligible: 0,
        covered: 0,
        stale: 0,
        missing: 0,
        missingItemIds: [],
        staleItemIds: [],
      }),
      expect.objectContaining({ provider: 'lastfm', eligible: 0 }),
    ])
    await expect(
      getPlaylistArtistCoverage('playlist-unknown', { olderThanDays: 180 }),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
  })

  it('counts every artist but returns the first 100 IDs, with one aggregate over the playlist', async () => {
    const { getPlaylistArtistCoverage } =
      await import('@/services/metadata-coverage')
    // 105 artists in the playlist and 2,000 tracks in 40 other playlists.
    await pool.query(`
      insert into artist (id, name)
      select 'artist-' || lpad(n::text, 4, '0'), 'Name ' || lpad(n::text, 4, '0')
      from generate_series(1, 2000) n`)
    await pool.query(`
      insert into media_item (id, slug, title, media_type)
      select 'track-' || n, 'track-' || n, 'Track ' || n, 'track'
      from generate_series(1, 2000) n`)
    await pool.query(`
      insert into library_track (media_item_id)
      select 'track-' || n from generate_series(1, 2000) n`)
    await pool.query(`
      insert into media_credit (media_item_id, artist_id, role)
      select 'track-' || n, 'artist-' || lpad(n::text, 4, '0'), 'artist'
      from generate_series(1, 2000) n`)
    await pool.query(`
      insert into playlist (id, name, kind, source)
      select 'playlist-' || n, 'Playlist ' || n, 'playlist', 'spotify'
      from generate_series(0, 39) n`)
    await pool.query(`
      insert into playlist_item (playlist_id, media_item_id)
      select 'playlist-' || (case when n <= 105 then 0 else n % 39 + 1 end), 'track-' || n
      from generate_series(1, 2000) n`)
    await pool.query('analyze')
    logQuery.mockClear()

    const coverage = await getPlaylistArtistCoverage('playlist-0', {
      olderThanDays: 180,
    })
    expect(coverage.total).toBe(105)
    expect(coverage.providers[0]).toMatchObject({ missing: 105, covered: 0 })
    expect(coverage.providers[0]?.missingItemIds).toHaveLength(100)
    expect(coverage.providers[0]?.missingItemIds.slice(0, 2)).toEqual([
      'artist-0001',
      'artist-0002',
    ])

    const aggregates = logQuery.mock.calls.filter(([query]) =>
      query.includes('json_build_array'),
    )
    expect(aggregates).toHaveLength(1)
    const [query, params] = aggregates[0] ?? ['', []]
    const plan = PlanRowsSchema.parse(
      (await pool.query(`explain (analyze, format text) ${query}`, params))
        .rows,
    )
      .map((row) => row['QUERY PLAN'])
      .join('\n')
    // The playlist's members are read through its key, not every playlist.
    expect(plan).toMatch(
      /(Index (Only )?Scan using|Bitmap Index Scan on) playlist_item_playlist_id_media_item_id_pk/,
    )
    expect(plan).not.toMatch(/Seq Scan on playlist_item member \(/)
  })
})
