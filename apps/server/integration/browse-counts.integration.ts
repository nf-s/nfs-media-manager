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
vi.mock('@/lib/db', () => ({
  get db() {
    return database
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
    await listTrackBrowsePage(query)
    logQuery.mockClear()
    expect(await listTrackBrowsePage(query)).toMatchObject({ items: [grouped] })
    expect(
      logQuery.mock.calls.some(([sql]) => sql.includes('recording_matches')),
    ).toBe(false)

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
  const { listTrackBrowsePage, listTrackRecordingVersions } =
    await import('@/services/tracks')
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
  ).toEqual(['guard-a', 'guard-b'])
})
