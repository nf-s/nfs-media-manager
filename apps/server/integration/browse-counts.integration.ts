import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { ArtistQuerySchema } from '@repo/schemas/creators'
import { AlbumQuerySchema } from '@repo/schemas/media'
import {
  TrackPositionsQuerySchema,
  TrackQuerySchema,
} from '@repo/schemas/tracks'
import { SubscriptionItemQuerySchema } from '@repo/schemas/subscriptions'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const name = 'browse_counts_' + randomUUID().replaceAll('-', '')
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database: name })
const logQuery = vi.fn<(query: string, params: unknown[]) => void>()
const database = drizzle(pool, { schema, logger: { logQuery } })
let requestDatabase = database
vi.mock('@/lib/db', () => ({
  get db() {
    return requestDatabase
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))
let created = false
const channel = (key: string) => `UC${key.padEnd(22, '0')}`
const video = (key: string) => key.padEnd(11, '0')
const FIXTURE = channel('fixture')
const SECOND = channel('second')
const RETIRED = channel('retired')

const now = new Date()
/** One second into the current and the previous UTC month. */
const thisMonth = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 1),
)
const lastMonth = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 1),
)
const twoYearsAgo = new Date(
  Date.UTC(now.getUTCFullYear() - 2, now.getUTCMonth(), 1, 0, 0, 1),
)

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden')
    }),
  )
  await admin.connect()
  await admin.query('create database ' + name)
  created = true
  await migrate(database, { migrationsFolder: './drizzle' })
  await pool.query(`
    insert into artist (id, name) values
      ('artist-a', 'Fixture artist A'),
      ('artist-b', 'Fixture artist B'),
      ('artist-c', 'Fixture artist without music');
    insert into media_item (id, slug, media_type, title, metadata) values
      ('album-1', 'album-1', 'album', 'Fixture album one', '{}'),
      ('album-2', 'album-2', 'album', 'Fixture album two', '{}'),
      ('album-3', 'album-3', 'album', 'Fixture album three', '{"legacyHidden": "true"}'),
      ('track-1', 'track-1', 'track', 'Fixture track one', '{}'),
      ('track-2', 'track-2', 'track', 'Fixture track two', '{}');
    insert into album (media_item_id) values ('album-1'), ('album-2'), ('album-3');
    insert into library_track (media_item_id, album_media_item_id) values
      ('track-1', 'album-1'), ('track-2', null);
    insert into media_credit (media_item_id, artist_id, role) values
      ('album-1', 'artist-a', 'artist'),
      ('track-1', 'artist-a', 'artist'),
      ('album-2', 'artist-b', 'artist'),
      ('album-3', 'artist-b', 'artist'),
      ('track-2', 'artist-b', 'artist');
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy) values
      ('listener', 'fixture artist a', 'fixture track one', 'track-1', 'exact'),
      ('listener', 'fixture artist b', 'fixture track two', 'track-2', 'exact');
  `)
  const scrobble = (
    id: string,
    listenedAt: Date,
    artist: string,
    track: string,
    albumId: string | null,
  ) =>
    pool.query(
      `insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key, album_media_item_id)
       values ($1, 'listener', $2, $3, $4, lower($3), lower($4), $5)`,
      [id, listenedAt.toISOString(), artist, track, albumId],
    )
  // A scrobble linked through both the album and the track counts once.
  await scrobble(
    's1',
    thisMonth,
    'Fixture artist A',
    'Fixture track one',
    'album-1',
  )
  await scrobble('s2', thisMonth, 'Fixture artist A', 'Other song', 'album-1')
  await scrobble('s3', lastMonth, 'Fixture artist A', 'Other song', 'album-1')
  await scrobble('s4', thisMonth, 'Fixture artist B', 'Fixture track two', null)
  await scrobble('s5', twoYearsAgo, 'Fixture artist B', 'Old song', 'album-2')
  // A scrobble of a hidden album does not count towards its artist.
  await scrobble('s6', thisMonth, 'Fixture artist B', 'Hidden song', 'album-3')
  const { refreshArtistListeningTotals } =
    await import('@/services/artist-listening')
  await refreshArtistListeningTotals(database)
  await database.insert(schema.subscriptionSource).values([
    { id: FIXTURE, type: 'youtube', title: 'Fixture channel' },
    { id: SECOND, type: 'youtube', title: 'Second channel' },
    {
      id: RETIRED,
      type: 'youtube',
      title: 'Unsubscribed channel',
      subscribed: false,
    },
  ])
  await database.insert(schema.subscriptionItem).values(
    [
      [video('orbits'), FIXTURE, 'Fixture video about orbits'],
      [video('bread'), FIXTURE, 'Fixture video about bread'],
      [video('second'), SECOND, 'Second channel video'],
      [video('retired'), RETIRED, 'Unsubscribed video'],
    ].map(([id, sourceId, title]) => ({
      id,
      sourceId,
      type: 'youtube',
      title,
      publishedAt: thisMonth,
      search: sql`to_tsvector('simple', ${title}::text)`,
    })),
  )
}, 60000)

afterAll(async () => {
  await pool.end()
  if (created) await admin.query('drop database ' + name)
  await admin.end()
  vi.unstubAllGlobals()
})

it('counts each library once when only a result cap changes the displayed total', async () => {
  const { queryBrowseCounts } = await import('@/services/browse')
  const { artistBrowseCounts } = await import('@/services/artist-browse')
  const counts = { totalCount: 1, unfilteredCount: 2 }
  logQuery.mockClear()
  expect(
    await queryBrowseCounts(
      'track',
      TrackQuerySchema.parse({
        groupRecordings: true,
        limitResults: 1,
      }),
    ),
  ).toEqual(counts)
  expect(
    logQuery.mock.calls.filter(([query]) =>
      query.includes('recording_matches as materialized'),
    ),
  ).toHaveLength(1)
  logQuery.mockClear()
  expect(
    await artistBrowseCounts(ArtistQuerySchema.parse({ limitResults: 1 })),
  ).toEqual(counts)
  expect(
    logQuery.mock.calls.filter(([query]) =>
      query.includes('select count(*)::int as count'),
    ),
  ).toHaveLength(1)
})

it('returns the unfiltered album and track totals in the same scope', async () => {
  const { queryBrowseCounts } = await import('@/services/browse')
  expect(await queryBrowseCounts('album', AlbumQuerySchema.parse({}))).toEqual({
    totalCount: 2,
    unfilteredCount: 2,
  })
  expect(
    await queryBrowseCounts('album', AlbumQuerySchema.parse({ q: 'one' })),
  ).toEqual({ totalCount: 1, unfilteredCount: 2 })
  expect(
    await queryBrowseCounts(
      'album',
      AlbumQuerySchema.parse({ q: 'one', includeArchived: 'true' }),
    ),
  ).toEqual({ totalCount: 1, unfilteredCount: 3 })
  expect(
    await queryBrowseCounts(
      'album',
      AlbumQuerySchema.parse({ creatorId: 'artist-b', limitResults: 1 }),
    ),
  ).toEqual({ totalCount: 1, unfilteredCount: 2 })
  expect(
    await queryBrowseCounts(
      'track',
      TrackQuerySchema.parse({ creatorId: 'artist-b' }),
    ),
  ).toEqual({ totalCount: 1, unfilteredCount: 2 })
  expect(
    await queryBrowseCounts(
      'track',
      TrackQuerySchema.parse({
        filters: JSON.stringify([
          { field: 'title', value: 'Fixture track two', mode: 'exclude' },
        ]),
      }),
    ),
  ).toEqual({ totalCount: 1, unfilteredCount: 2 })
})

it('returns the unfiltered artist total without search, filters or ranges', async () => {
  const { artistBrowseCounts } = await import('@/services/artist-browse')
  expect(await artistBrowseCounts(ArtistQuerySchema.parse({}))).toEqual({
    totalCount: 2,
    unfilteredCount: 2,
  })
  expect(
    await artistBrowseCounts(ArtistQuerySchema.parse({ q: 'artist B' })),
  ).toEqual({ totalCount: 1, unfilteredCount: 2 })
  expect(
    await artistBrowseCounts(
      ArtistQuerySchema.parse({
        ranges: JSON.stringify([{ field: 'scrobbles', min: 3 }]),
      }),
    ),
  ).toEqual({ totalCount: 1, unfilteredCount: 2 })
})

it('sorts artists by the stored scrobble count and reads monthly scrobbles once', async () => {
  const { listArtistBrowsePage } = await import('@/services/artist-browse')
  const { getArtistListeningSeries } =
    await import('@/services/listening-series')
  logQuery.mockClear()
  const page = await listArtistBrowsePage(
    ArtistQuerySchema.parse({ sortBy: 'scrobbles', direction: 'desc' }),
  )
  expect(page.items.map((item) => item.id)).toEqual(['artist-a', 'artist-b'])
  // Only the monthly read touches scrobbles; the order uses the stored count.
  expect(
    logQuery.mock.calls.filter(([query]) => query.includes('lastfm_scrobble')),
  ).toHaveLength(1)
  const [first, second] = page.items
  // Both cover the months since the earliest stored scrobble, two years ago.
  expect(first?.scrobbleCount).toBe(3)
  expect(first?.listeningMonths).toHaveLength(25)
  expect(first?.listeningMonths?.slice(-2)).toEqual([1, 2])
  expect(first?.listeningMonths?.reduce((sum, count) => sum + count)).toBe(3)
  expect(second?.scrobbleCount).toBe(2)
  expect(second?.listeningMonths).toHaveLength(25)
  expect(second?.listeningMonths?.[0]).toBe(1)
  expect(second?.listeningMonths?.at(-1)).toBe(1)
  expect(second?.listeningMonths?.reduce((sum, count) => sum + count)).toBe(2)
  for (const item of page.items)
    expect(item.scrobbleCount).toBe(
      (await getArtistListeningSeries(item.id, now)).total,
    )
  const ascending = await listArtistBrowsePage(
    ArtistQuerySchema.parse({ sortBy: 'scrobbles', direction: 'asc' }),
  )
  expect(ascending.items.map((item) => item.id)).toEqual([
    'artist-b',
    'artist-a',
  ])
})

it('recounts stored artist scrobbles when links or credits change', async () => {
  const { refreshArtistListeningTotals } =
    await import('@/services/artist-listening')
  const stored = async () =>
    Object.fromEntries(
      (
        await pool.query<{ id: string; scrobble_count: number }>(
          'select id, scrobble_count from artist order by id',
        )
      ).rows.map((row) => [row.id, row.scrobble_count]),
    )
  expect(await stored()).toEqual({
    'artist-a': 3,
    'artist-b': 2,
    'artist-c': 0,
  })
  await pool.query(`begin;
    -- One scrobbled name counted towards two tracks of the same artist, and
    -- an album credited to two artists.
    insert into media_item (id, slug, media_type, title, metadata) values
      ('track-3', 'track-3', 'track', 'Fixture track one again', '{}');
    insert into library_track (media_item_id) values ('track-3');
    insert into media_credit (media_item_id, artist_id, role) values
      ('track-3', 'artist-a', 'artist'), ('album-1', 'artist-c', 'artist');
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy) values
      ('listener', 'fixture artist a', 'fixture track one', 'track-3', 'exact');
    delete from lastfm_track_link where track_media_item_id = 'track-2';
    commit;`)
  try {
    await refreshArtistListeningTotals(database)
    expect(await stored()).toEqual({
      'artist-a': 3,
      'artist-b': 1,
      'artist-c': 3,
    })
    const { getArtistListeningSeries } =
      await import('@/services/listening-series')
    for (const [id, count] of Object.entries(await stored()))
      expect((await getArtistListeningSeries(id, now)).total).toBe(count)
  } finally {
    await pool.query(`begin;
      delete from media_item where id = 'track-3';
      delete from media_credit where media_item_id = 'album-1' and artist_id = 'artist-c';
      insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy) values
        ('listener', 'fixture artist b', 'fixture track two', 'track-2', 'exact');
      commit;`)
    await refreshArtistListeningTotals(database)
  }
  expect(await stored()).toEqual({
    'artist-a': 3,
    'artist-b': 2,
    'artist-c': 0,
  })
})

it('returns the unfiltered subscription total of subscribed sources', async () => {
  const { subscriptionBrowseCounts } =
    await import('@/services/subscription-library')
  expect(
    await subscriptionBrowseCounts(SubscriptionItemQuerySchema.parse({})),
  ).toEqual({ totalCount: 3, unfilteredCount: 3 })
  expect(
    await subscriptionBrowseCounts(
      SubscriptionItemQuerySchema.parse({ sourceId: FIXTURE }),
    ),
  ).toEqual({ totalCount: 2, unfilteredCount: 3 })
  expect(
    await subscriptionBrowseCounts(
      SubscriptionItemQuerySchema.parse({ q: 'bread' }),
    ),
  ).toEqual({ totalCount: 1, unfilteredCount: 3 })
})

it('deduplicates linked listening across editions and applies grouped ranges before pagination', async () => {
  const {
    listTrackBrowsePage,
    listTrackRecordingVersions,
    listTracksAtPositions,
  } = await import('@/services/tracks')
  const { queryBrowseCounts } = await import('@/services/browse')
  const { refreshTrackListeningTotals } = await import('@/services/track-links')
  await pool.query(`
    insert into media_item (id, slug, media_type, title) values
      ('edition-album', 'edition-album', 'track', 'Fixture recording'),
      ('edition-ep', 'edition-ep', 'track', 'Fixture recording'),
      ('edition-edit', 'edition-edit', 'track', 'Fixture recording (Radio Edit)'),
      ('edition-remix', 'edition-remix', 'track', 'Fixture recording (Remix)');
    insert into library_track (media_item_id, album_media_item_id, spotify_track_id, isrc, duration_sec, date_added) values
      ('edition-album', 'album-1', '0000000000000000000001', 'USABC2600001', 180, '2026-01-02'),
      ('edition-ep', 'album-2', null, 'USABC2600001', 179, '2026-01-01'),
      ('edition-edit', null, null, 'USABC2600001', 180, '2026-01-03'),
      ('edition-remix', null, null, 'USABC2600001', 180, '2026-01-03');
    insert into media_credit (media_item_id, artist_id, role)
    select id, 'artist-a', 'artist' from media_item where id like 'edition-%';
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy) values
      ('listener', 'fixture artist a', 'fixture recording', 'edition-album', 'exact'),
      ('listener', 'fixture artist a', 'fixture recording', 'edition-ep', 'exact'),
      ('listener', 'fixture artist a', 'fixture recording album name', 'edition-album', 'normalized'),
      ('listener', 'fixture artist a', 'fixture recording ep name', 'edition-ep', 'normalized');
    insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key) values
      ('edition-event-1', 'listener', '2026-02-01T03:04:05.123', 'Fixture artist A', 'Fixture recording', 'fixture artist a', 'fixture recording'),
      ('edition-event-2', 'listener', '2026-02-02T03:04:05.123', 'Fixture artist A', 'Fixture recording album name', 'fixture artist a', 'fixture recording album name'),
      ('edition-event-3', 'listener', '2026-02-03T03:04:05.123', 'Fixture artist A', 'Fixture recording ep name', 'fixture artist a', 'fixture recording ep name');
  `)
  await database.transaction(async (tx) => refreshTrackListeningTotals(tx))

  const query = TrackQuerySchema.parse({
    groupRecordings: true,
    q: 'fixture recording',
    sortBy: 'scrobbles',
    size: 1,
  })
  const grouped = {
    id: 'edition-album',
    scrobbles: 3,
    dateAdded: '2026-01-01T00:00:00.000Z',
    lastListenedAt: '2026-02-03T03:04:05.123Z',
    recordingGroup: { versionCount: 2 },
  }
  expect(await listTrackBrowsePage(query)).toMatchObject({
    items: [grouped],
    hasMore: true,
  })
  expect(
    await listTrackBrowsePage({ ...query, sortBy: 'lastListenedAt' }),
  ).toMatchObject({
    items: [grouped],
    hasMore: true,
  })
  expect(await queryBrowseCounts('track', query)).toEqual({
    totalCount: 3,
    unfilteredCount: 5,
  })
  expect(
    await listTracksAtPositions(
      TrackPositionsQuerySchema.parse({
        ...query,
        positions: '0,1,2',
        limitResults: 1,
      }),
    ),
  ).toMatchObject({ items: [{ position: 0, item: grouped }] })

  const recordingRange = TrackQuerySchema.parse({
    ...query,
    ranges: [{ field: 'scrobbles', min: 3 }],
  })
  expect(await queryBrowseCounts('track', recordingRange)).toEqual({
    totalCount: 1,
    unfilteredCount: 5,
  })
  const first = await listTrackRecordingVersions(
    'edition-album',
    recordingRange,
  )
  const second = await listTrackRecordingVersions('edition-album', {
    ...recordingRange,
    page: 2,
  })
  expect(first).toMatchObject({
    items: [{ id: 'edition-album', scrobbles: 2 }],
    hasMore: true,
  })
  expect(second).toMatchObject({
    items: [{ id: 'edition-ep', scrobbles: 2 }],
    hasMore: false,
  })
  expect(first.items[0]?.recordingGroup).toBeUndefined()

  const filtered = TrackQuerySchema.parse({
    ...query,
    filters: [{ field: 'album', value: 'Fixture album two', mode: 'required' }],
  })
  expect(await listTrackBrowsePage(filtered)).toMatchObject({
    items: [{ id: 'edition-ep', scrobbles: 2 }],
    hasMore: false,
  })
  expect(
    await listTrackRecordingVersions('edition-ep', filtered),
  ).toMatchObject({
    items: [{ id: 'edition-ep' }],
    hasMore: false,
  })

  const dateRange = TrackQuerySchema.parse({
    ...query,
    ranges: [{ field: 'dateAdded', max: Date.parse('2026-01-01') }],
  })
  expect(await queryBrowseCounts('track', dateRange)).toEqual({
    totalCount: 1,
    unfilteredCount: 5,
  })
  expect(
    await listTrackRecordingVersions('edition-album', dateRange),
  ).toMatchObject({ items: [{ id: 'edition-album' }], hasMore: true })

  const writer = await pool.connect()
  try {
    // Another database in the test cluster can invalidate the snapshot cache.
    // Check for a hit only when the version stayed the same across both reads.
    const snapshot = async () =>
      JSON.stringify(
        (await pool.query('select pg_current_snapshot()::text as version'))
          .rows,
      )
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const before = await snapshot()
      await listTrackBrowsePage(query)
      logQuery.mockClear()
      expect(await listTrackBrowsePage(query)).toMatchObject({
        items: [grouped],
      })
      if ((await snapshot()) === before) {
        expect(
          logQuery.mock.calls.some(([sql]) =>
            sql.includes('recording_matches'),
          ),
        ).toBe(false)
        break
      }
    }

    // A different duration separates the versions, even across DB sessions.
    await writer.query(
      `update library_track set duration_sec = 360 where media_item_id = 'edition-ep'`,
    )
    const updated = await listTrackBrowsePage(query)
    expect(updated.items).toMatchObject([{ id: 'edition-album', scrobbles: 2 }])
    expect(updated.items[0]?.recordingGroup).toBeUndefined()
  } finally {
    writer.release()
  }
  expect(await queryBrowseCounts('track', query)).toEqual({
    totalCount: 4,
    unfilteredCount: 6,
  })
  expect(
    await listTrackRecordingVersions('edition-album', query),
  ).toMatchObject({
    items: [{ id: 'edition-album' }],
    hasMore: false,
  })

  await pool.query(`
    update library_track set duration_sec = 180, isrc = 'unknown'
      where media_item_id in ('edition-album', 'edition-ep');
    update lastfm_track_link set username = 'second-listener'
      where track_media_item_id = 'edition-ep' and strategy = 'exact';
  `)
  expect(await queryBrowseCounts('track', query)).toEqual({
    totalCount: 4,
    unfilteredCount: 6,
  })
})

it('uses conflicting recording evidence from editions excluded by filters', async () => {
  const {
    listTrackBrowsePage,
    listTrackRecordingVersions,
    listTracksAtPositions,
  } = await import('@/services/tracks')
  await pool.query(`
    insert into media_item (id, slug, media_type, title) values
      ('guard-a', 'guard-a', 'track', 'Fixture guard'),
      ('guard-b', 'guard-b', 'track', 'Fixture guard'),
      ('guard-c', 'guard-c', 'track', 'Fixture guard');
    insert into library_track (media_item_id, album_media_item_id, isrc) values
      ('guard-a', 'album-1', null),
      ('guard-b', 'album-1', 'USABC2600002'),
      ('guard-c', 'album-2', 'USABC2600003');
    insert into media_credit (media_item_id, artist_id, role)
    select id, 'artist-a', 'artist' from media_item where id like 'guard-%';
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
    select 'listener', 'fixture artist a', 'fixture guard', id, 'exact'
    from media_item where id like 'guard-%';
  `)
  const query = TrackQuerySchema.parse({
    groupRecordings: true,
    q: 'fixture guard',
    filters: [{ field: 'album', value: 'Fixture album one', mode: 'required' }],
    sortBy: 'scrobbles',
  })
  const split = await listTrackBrowsePage(query)
  expect(
    split.items.map(({ id, recordingGroup }) => [id, recordingGroup]),
  ).toEqual([
    ['guard-a', undefined],
    ['guard-b', undefined],
  ])
  expect(
    (await listTrackRecordingVersions('guard-a', query)).items.map(
      ({ id }) => id,
    ),
  ).toEqual(['guard-a'])

  await pool.query(`
    update library_track set isrc = 'USABC2600002' where media_item_id = 'guard-a';
  `)
  expect(await listTrackBrowsePage(query)).toMatchObject({
    items: [{ id: 'guard-a', recordingGroup: { versionCount: 2 } }],
  })
  await pool.query(`
    update library_track set isrc = null where media_item_id = 'guard-a';
  `)

  await pool.query(`
    insert into track (id, album_media_item_id, track_media_item_id, title, position) values
      ('guard-position-a', 'album-1', 'guard-a', 'Fixture guard', 2),
      ('guard-position-b', 'album-1', 'guard-b', 'Fixture guard', 1);
  `)
  const titleOrder = TrackQuerySchema.parse({
    ...query,
    sortBy: 'title',
    size: 1,
  })
  expect(await listTrackBrowsePage(titleOrder)).toMatchObject({
    items: [{ id: 'guard-b' }],
    hasMore: true,
  })
  expect(
    await listTracksAtPositions(
      TrackPositionsQuerySchema.parse({ ...titleOrder, positions: '0' }),
    ),
  ).toMatchObject({ items: [{ position: 0, item: { id: 'guard-b' } }] })

  await pool.query(
    `delete from lastfm_track_link where track_media_item_id = 'guard-c'`,
  )
  expect(await listTrackBrowsePage(query)).toMatchObject({
    items: [{ id: 'guard-a', recordingGroup: { versionCount: 2 } }],
  })
  expect(
    (await listTrackRecordingVersions('guard-a', query)).items.map(
      ({ id }) => id,
    ),
  ).toEqual(['guard-b', 'guard-a'])
})

it('reuses one exact grouped order for opposite sorts, deep pages, positions and totals', async () => {
  const {
    queryBrowseCount,
    queryBrowsePageIds,
    queryBrowsePositions,
    refreshRecordingBrowseOrderForMaintenance,
  } = await import('@/services/browse')
  const query = TrackQuerySchema.parse({
    groupRecordings: true,
    sortBy: 'scrobbles',
    size: 2,
  })
  await pool.query('delete from recording_browse_order_state')
  expect(await refreshRecordingBrowseOrderForMaintenance()).toBe(false)
  await pool.query(`
    insert into media_item (id, slug, media_type, title) values
      ('cached-recording-a', 'cached-recording-a', 'track', 'Fixture cached recording'),
      ('cached-recording-b', 'cached-recording-b', 'track', 'Fixture cached recording');
    insert into library_track (media_item_id, album_media_item_id, duration_sec, isrc, scrobble_count, last_listened_at) values
      ('cached-recording-a', 'album-1', 160, 'USABC2700001', 1, '2026-07-01'),
      ('cached-recording-b', 'album-2', 161, null, 1, '2026-07-01');
    insert into media_credit (media_item_id, artist_id, role)
    select id, 'artist-a', 'artist' from media_item where id like 'cached-recording-%';
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
    select 'listener', 'fixture artist a', 'fixture cached recording', id, 'exact'
    from media_item where id like 'cached-recording-%';
    insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key)
      values ('cached-recording-event', 'listener', '2026-07-01', 'Fixture artist A',
        'Fixture cached recording', 'fixture artist a', 'fixture cached recording');
    insert into recording_browse_order_state (singleton, builder, retry_after)
    values (true, current_user, statement_timestamp() + interval '1 minute')
    on conflict (singleton) do update set retry_after = excluded.retry_after;
  `)
  const pagesAndPositions = () =>
    Promise.all([
      queryBrowsePageIds('track', query),
      queryBrowsePageIds('track', { ...query, direction: 'asc', page: 2 }),
      queryBrowsePageIds('track', { ...query, page: 999 }),
      queryBrowsePositions('track', query, [0, 1, 3, 999]),
      queryBrowsePositions(
        'track',
        { ...query, direction: 'asc', limitResults: 3 },
        [2, 4, 0, 0],
      ),
      queryBrowseCount('track', query),
    ])
  const live = await pagesAndPositions()
  await pool.query(`
    update recording_browse_order_state set retry_after = statement_timestamp();
  `)
  await queryBrowsePageIds('track', query)
  await pool.query(
    'update recording_browse_order_state set retry_after = statement_timestamp()',
  )
  expect(await refreshRecordingBrowseOrderForMaintenance()).toBe(false)
  logQuery.mockClear()
  expect(await pagesAndPositions()).toEqual(live)
  expect(
    await queryBrowseCount('track', { ...query, limitResults: 1 }),
  ).toEqual({
    totalCount: 1,
  })
  expect(
    logQuery.mock.calls.some(([query]) => query.includes('recording_matches')),
  ).toBe(false)
  expect(
    logQuery.mock.calls.some(([query]) =>
      query.includes('recording_browse_order g'),
    ),
  ).toBe(true)
  expect(
    await queryBrowseCount('track', query, { conditions: [sql`false`] }),
  ).toEqual({ totalCount: 0 })

  await pool.query(`
    update artist set scrobble_count = scrobble_count + 1 where id = 'artist-a'
  `)
  logQuery.mockClear()
  expect(await pagesAndPositions()).toEqual(live)
  expect(
    logQuery.mock.calls.some(([query]) => query.includes('recording_matches')),
  ).toBe(false)
})

it('publishes grouped ranks atomically around concurrent writes and older snapshots', async () => {
  const { queryBrowsePageIds, refreshRecordingBrowseOrderForMaintenance } =
    await import('@/services/browse')
  const query = TrackQuerySchema.parse({
    groupRecordings: true,
    sortBy: 'scrobbles',
    size: 1,
  })
  const first = () => queryBrowsePageIds('track', query)
  await pool.query(`
    update recording_browse_order_state set retry_after = statement_timestamp()
  `)
  const before = await first()
  const oldReader = await pool.connect()
  const oldWriter = await pool.connect()
  const publishLock = await pool.connect()
  const firstReadyRank = `select (
    select g.id from recording_browse_order g
    where descending_rank = 1 and not exists (select 1 from recording_browse_order_dirty)
  ) as id`
  try {
    await oldReader.query('begin isolation level repeatable read')
    const firstRank = await oldReader.query(firstReadyRank)
    expect(firstRank.rows).toEqual([{ id: before.ids[0] }])

    await oldWriter.query('begin')
    await oldWriter.query(
      `update library_track set scrobble_count = 400 where media_item_id = 'track-1'`,
    )
    expect(await first()).toEqual(before)
    await pool.query(`
      update recording_browse_order_state set total_count = null, retry_after = statement_timestamp();
      create function fixture_pause_recording_order() returns trigger language plpgsql as $$
      begin
        while not pg_try_advisory_xact_lock(381026193) loop
          perform pg_sleep(0.005);
        end loop;
        return null;
      end;
      $$;
      create trigger fixture_pause_recording_order before insert on recording_browse_order
      for each statement execute function fixture_pause_recording_order();
    `)
    await publishLock.query('select pg_advisory_lock(381026193)')
    logQuery.mockClear()
    const build = first()
    try {
      await vi.waitFor(() =>
        expect(
          logQuery.mock.calls.some(([statement]) =>
            statement.includes('insert into recording_browse_order\n'),
          ),
        ).toBe(true),
      )
      expect(await refreshRecordingBrowseOrderForMaintenance()).toBe(false)
      await pool.query(`
        update library_track set scrobble_count = 200 where media_item_id = 'track-2';
      `)
    } finally {
      await publishLock.query('select pg_advisory_unlock(381026193)')
    }
    expect(await build).toEqual(before)
    await oldWriter.query('rollback')

    expect((await oldReader.query(firstReadyRank)).rows).toEqual(firstRank.rows)
    expect((await pool.query(firstReadyRank)).rows).toEqual([{ id: null }])
    expect((await first()).ids).toEqual(['track-2'])

    // The legacy INSERT/UPDATE statement path still invalidates a built order.
    await pool.query(`
      insert into library_track (media_item_id, scrobble_count) values ('track-1', 300)
      on conflict (media_item_id) do update set scrobble_count = excluded.scrobble_count
    `)
    expect((await pool.query(firstReadyRank)).rows).toEqual([{ id: null }])
    expect((await first()).ids).toEqual(['track-1'])
    await pool.query('truncate lastfm_track_source')
    expect((await pool.query(firstReadyRank)).rows).toEqual([{ id: null }])
  } finally {
    await oldWriter.query('rollback')
    await oldReader.query('rollback')
    await pool.query(`
      drop trigger if exists fixture_pause_recording_order on recording_browse_order;
      drop function if exists fixture_pause_recording_order();
    `)
    publishLock.release()
    oldWriter.release()
    oldReader.release()
  }
})

it.each(['canceled', 'timed-out'])(
  'keeps exact live rows and schedules maintenance after a %s order publication',
  async (outcome) => {
    const { queryBrowsePageIds, refreshRecordingBrowseOrderForMaintenance } =
      await import('@/services/browse')
    const query = TrackQuerySchema.parse({
      groupRecordings: true,
      sortBy: 'scrobbles',
      size: 1,
    })
    const first = () => queryBrowsePageIds('track', query)
    await pool.query(`
      update recording_browse_order_state set
        maintenance_only = false, retry_after = statement_timestamp();
    `)
    await first()
    const failure =
      outcome === 'canceled'
        ? "raise exception 'Fixture statement canceled' using errcode = '57014';"
        : 'perform pg_sleep(4);'
    const scrobbles = outcome === 'canceled' ? 998 : 999
    await pool.query(`
      update library_track set scrobble_count = ${scrobbles} where media_item_id = 'track-2';
      update recording_browse_order_state set retry_after = statement_timestamp();
      create function fixture_slow_recording_order() returns trigger language plpgsql as $$
      begin
        ${failure}
        return null;
      end;
      $$;
      create trigger fixture_slow_recording_order before insert on recording_browse_order
      for each statement execute function fixture_slow_recording_order();
    `)
    try {
      expect((await first()).ids).toEqual(['track-2'])
      expect(
        (
          await pool.query(
            'select maintenance_only from recording_browse_order_state',
          )
        ).rows,
      ).toEqual([{ maintenance_only: true }])
      expect(
        (
          await pool.query(
            'select count(*)::int as total from recording_browse_order_dirty',
          )
        ).rows,
      ).toEqual([{ total: 1 }])
      await pool.query(
        'update recording_browse_order_state set retry_after = statement_timestamp()',
      )
      logQuery.mockClear()
      expect((await first()).ids).toEqual(['track-2'])
      expect(
        logQuery.mock.calls.some(([statement]) =>
          statement.includes('insert into recording_browse_order_state'),
        ),
      ).toBe(false)

      // A genuine four-second publication only fits in the maintenance budget.
      expect(await refreshRecordingBrowseOrderForMaintenance()).toBe(
        outcome === 'timed-out',
      )
    } finally {
      await pool.query(`
        drop trigger fixture_slow_recording_order on recording_browse_order;
        drop function fixture_slow_recording_order();
      `)
    }
    if (outcome === 'canceled') {
      await pool.query(
        'update recording_browse_order_state set retry_after = statement_timestamp()',
      )
      expect(await refreshRecordingBrowseOrderForMaintenance()).toBe(true)
    }
    logQuery.mockClear()
    expect((await first()).ids).toEqual(['track-2'])
    expect(
      logQuery.mock.calls.some(([statement]) =>
        statement.includes('recording_matches'),
      ),
    ).toBe(false)
    expect(
      (
        await pool.query(
          'select maintenance_only from recording_browse_order_state',
        )
      ).rows,
    ).toEqual([{ maintenance_only: true }])
  },
)

it('keeps grouped Browse exact before the rank-maintenance migration', async () => {
  const { queryBrowsePageIds, refreshRecordingBrowseOrderForMaintenance } =
    await import('@/services/browse')
  const query = TrackQuerySchema.parse({
    groupRecordings: true,
    sortBy: 'scrobbles',
    size: 1,
  })
  await pool.query(`
    update recording_browse_order_state set retry_after = statement_timestamp();
  `)
  const before = await queryBrowsePageIds('track', query)
  await pool.query(
    'alter table recording_browse_order_state drop column maintenance_only',
  )
  try {
    expect(await queryBrowsePageIds('track', query)).toEqual(before)
    await pool.query(`
      delete from recording_browse_order_state;
      update library_track set scrobble_count = 1001 where media_item_id = 'track-1';
    `)
    expect((await queryBrowsePageIds('track', query)).ids).toEqual(['track-1'])
    expect(await refreshRecordingBrowseOrderForMaintenance()).toBe(false)
  } finally {
    await pool.query(`
      alter table recording_browse_order_state add column maintenance_only boolean not null default false
    `)
  }
})

it('falls back to live grouped rows over a read-only connection', async () => {
  const { queryBrowsePageIds, refreshRecordingBrowseOrderForMaintenance } =
    await import('@/services/browse')
  const query = TrackQuerySchema.parse({
    groupRecordings: true,
    sortBy: 'scrobbles',
    size: 1,
  })
  await pool.query(`
    insert into recording_browse_order_state
      (singleton, builder, retry_after)
    values (true, current_user, '-infinity')
    on conflict (singleton) do update set
      builder = excluded.builder, maintenance_only = false, retry_after = excluded.retry_after;
    update library_track set scrobble_count = 1002 where media_item_id = 'track-2';
  `)
  const readerPool = new pg.Pool({
    ...connection,
    database: name,
    options: '-c default_transaction_read_only=on',
  })
  requestDatabase = drizzle(readerPool, { schema, logger: { logQuery } })
  try {
    expect((await queryBrowsePageIds('track', query)).ids).toEqual(['track-2'])
    expect(await refreshRecordingBrowseOrderForMaintenance()).toBe(false)
  } finally {
    requestDatabase = database
    await readerPool.end()
  }
})
