import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import {
  ArtistListeningHistogramQuerySchema,
  ArtistMetadataQuerySchema,
  ArtistQuerySchema,
} from '@repo/schemas/creators'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const name = 'artist_browse_listening_' + randomUUID().replaceAll('-', '')
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database: name })
const database = drizzle(pool, { schema })
vi.mock('@/lib/db', () => ({
  get db() {
    return database
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))
let created = false
const ownerId = 'listening-owner'
const twoYears = { kind: 'rolling', amount: 2, unit: 'years' } as const

/**
 * Scrobbles per artist, with the clock at 2026-03-31T12:00Z:
 * A all 10, two years 6, one year 4. Its track is on its album, so seven
 *   scrobbles are linked through both and count once.
 * B all 8, two years 5, one year 5 (album only).
 * C all 14, nothing since 2023 (track only, no album link); two of its
 *   scrobbles fall on 2023-05-10 and two just outside it.
 * D none. E all 1200, nothing in the last two years.
 */
beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden')
    }),
  )
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-03-31T12:00:00Z'))
  await admin.connect()
  await admin.query('create database ' + name)
  created = true
  await migrate(database, { migrationsFolder: './drizzle' })
  await pool.query(`
    insert into artist (id, name) values
      ('artist-a', 'Fixture artist A'), ('artist-b', 'Fixture artist B'),
      ('artist-c', 'Fixture artist C'), ('artist-d', 'Fixture artist D'),
      ('artist-e', 'Fixture artist E');
    insert into media_item (id, slug, media_type, title) values
      ('album-a', 'album-a', 'album', 'Fixture album A'),
      ('album-b', 'album-b', 'album', 'Fixture album B'),
      ('album-d', 'album-d', 'album', 'Fixture album D'),
      ('album-e', 'album-e', 'album', 'Fixture album E'),
      ('track-a', 'track-a', 'track', 'Fixture track A'),
      ('track-c', 'track-c', 'track', 'Fixture track C');
    insert into album (media_item_id) values
      ('album-a'), ('album-b'), ('album-d'), ('album-e');
    insert into library_track (media_item_id, album_media_item_id) values
      ('track-a', 'album-a'), ('track-c', null);
    insert into media_credit (media_item_id, artist_id, role) values
      ('album-a', 'artist-a', 'artist'), ('track-a', 'artist-a', 'artist'),
      ('album-b', 'artist-b', 'artist'), ('track-c', 'artist-c', 'artist'),
      ('album-d', 'artist-d', 'artist'), ('album-e', 'artist-e', 'artist');
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy) values
      ('listener', 'fixture artist a', 'fixture track a', 'track-a', 'exact'),
      ('listener', 'fixture artist c', 'fixture track c', 'track-c', 'exact');
    insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key, album_media_item_id)
      select 'e-' || n, 'listener', timestamp '2022-01-01' + n * interval '1 minute',
        'Fixture artist E', 'Fixture song E', 'fixture artist e', 'fixture song e', 'album-e'
      from generate_series(1, 1200) n;
  `)
  for (const [artist, track, albumId, listenedAt, count] of [
    ['a', 'fixture track a', 'album-a', '2025-06-01T00:00:00Z', 3],
    ['a', 'fixture track a', 'album-a', '2022-06-01T00:00:00Z', 4],
    ['a', 'fixture other a', 'album-a', '2026-03-01T00:00:00Z', 1],
    ['a', 'fixture other a', 'album-a', '2024-12-01T00:00:00Z', 2],
    ['b', 'fixture song b', 'album-b', '2025-06-01T00:00:00Z', 5],
    ['b', 'fixture song b', 'album-b', '2022-06-01T00:00:00Z', 3],
    ['c', 'fixture track c', null, '2022-06-01T00:00:00Z', 10],
    ['c', 'fixture track c', null, '2023-05-09T23:59:59.999Z', 1],
    ['c', 'fixture track c', null, '2023-05-10T00:00:00Z', 1],
    ['c', 'fixture track c', null, '2023-05-10T23:59:59.999Z', 1],
    ['c', 'fixture track c', null, '2023-05-11T00:00:00Z', 1],
  ] as const) {
    await database.insert(schema.lastfmScrobble).values(
      Array.from({ length: count }, (_, index) => ({
        id: randomUUID(),
        username: 'listener',
        listenedAt: new Date(Date.parse(listenedAt) + index * 1000),
        artistName: `Fixture artist ${artist.toUpperCase()}`,
        trackName: track,
        artistKey: `fixture artist ${artist}`,
        trackKey: track,
        albumMediaItemId: albumId,
      })),
    )
  }
  await database
    .insert(schema.user)
    .values({ id: ownerId, name: 'Fixture owner', email: 'owner@example.test' })
  const { refreshArtistListeningTotals } =
    await import('@/services/artist-listening')
  await refreshArtistListeningTotals(database)
}, 60000)

afterAll(async () => {
  await pool.end()
  if (created) await admin.query('drop database ' + name)
  await admin.end()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function page(input: z.input<typeof ArtistQuerySchema>) {
  const { listArtistBrowsePage } = await import('@/services/artist-browse')
  return listArtistBrowsePage(ArtistQuerySchema.parse(input))
}

async function ids(input: z.input<typeof ArtistQuerySchema>) {
  return (await page(input)).items.map((item) => item.id)
}

describe('artist listening rules', () => {
  it('counts each linked scrobble once and zero for artists without any', async () => {
    expect(
      await ids({
        listening: {
          match: 'all',
          rules: [{ period: { kind: 'all' }, max: 0 }],
        },
      }),
    ).toEqual(['artist-d'])
    expect(
      await ids({
        listening: {
          match: 'all',
          rules: [{ period: twoYears, min: 5, max: 6 }],
        },
      }),
    ).toEqual(['artist-a', 'artist-b'])
    expect(
      await ids({
        listening: { match: 'all', rules: [{ period: twoYears, min: 6 }] },
      }),
    ).toEqual(['artist-a'])
    const rows = await page({ listeningSort: { kind: 'all' }, size: 10 })
    expect(
      rows.items.map((item) => [item.id, item.listeningScrobbles]),
    ).toEqual([
      ['artist-a', 10],
      ['artist-b', 8],
      ['artist-c', 14],
      ['artist-d', 0],
      ['artist-e', 1200],
    ])
    for (const item of rows.items)
      expect(item.listeningScrobbles).toBe(item.scrobbleCount)
  })

  it('combines rules with all or any and with the other artist filters', async () => {
    const rules = [
      { period: { kind: 'all' }, min: 10 },
      { period: twoYears, max: 0 },
    ]
    expect(await ids({ listening: { match: 'all', rules } })).toEqual([
      'artist-c',
      'artist-e',
    ])
    expect(await ids({ listening: { match: 'any', rules } })).toEqual([
      'artist-a',
      'artist-c',
      'artist-d',
      'artist-e',
    ])
    expect(
      await ids({
        listening: { match: 'any', rules },
        ranges: [{ field: 'albumCount', min: 1 }],
        filters: [
          { field: 'name', value: 'Fixture artist E', mode: 'exclude' },
        ],
      }),
    ).toEqual(['artist-a', 'artist-d'])
    expect(
      await ids({ listening: { match: 'any', rules }, q: 'artist C' }),
    ).toEqual(['artist-c'])
  })

  it('includes the whole end date of a date period and nothing beside it', async () => {
    const day = { kind: 'dates', from: '2023-05-10', to: '2023-05-10' }
    expect(
      await ids({
        listening: {
          match: 'all',
          rules: [{ period: day, min: 2, max: 2 }],
        },
      }),
    ).toEqual(['artist-c'])
    expect(
      await ids({
        listening: { match: 'all', rules: [{ period: day, min: 3 }] },
      }),
    ).toEqual([])
    expect(
      await ids({
        listening: {
          match: 'all',
          rules: [{ period: { kind: 'dates', from: '2023-05-11' }, min: 1 }],
        },
        listeningSort: { kind: 'dates', to: '2023-05-10' },
        sortBy: 'listeningScrobbles',
        direction: 'desc',
      }),
    ).toEqual(['artist-c', 'artist-a', 'artist-b'])
  })

  it('counts rules as a filter in totals and in the unfiltered count', async () => {
    const { artistBrowseCounts, countArtistBrowse } =
      await import('@/services/artist-browse')
    const listening = {
      match: 'all',
      rules: [{ period: twoYears, max: 0 }],
    } as const
    expect(
      await artistBrowseCounts(ArtistQuerySchema.parse({ listening })),
    ).toEqual({ totalCount: 3, unfilteredCount: 5 })
    expect(
      await countArtistBrowse(
        ArtistQuerySchema.parse({
          listening: { match: 'all', rules: [{ period: twoYears, min: 1 }] },
        }),
      ),
    ).toEqual({ totalCount: 2 })
    expect(
      await artistBrowseCounts(
        ArtistQuerySchema.parse({
          listeningSort: twoYears,
          sortBy: 'listeningScrobbles',
        }),
      ),
    ).toEqual({ totalCount: 5, unfilteredCount: 5 })
    const { listArtists } = await import('@/services/creators')
    const listed = await listArtists(
      ArtistQuerySchema.parse({ listening, listeningSort: { kind: 'all' } }),
    )
    expect(listed.totalCount).toBe(3)
    expect(
      listed.items.map((item) => [item.id, item.listeningScrobbles]),
    ).toEqual([
      ['artist-c', 14],
      ['artist-d', 0],
      ['artist-e', 1200],
    ])
  })
})

describe('artist listening sort', () => {
  it('sorts and pages by the period count with stable IDs', async () => {
    const query = {
      listeningSort: twoYears,
      sortBy: 'listeningScrobbles',
      direction: 'desc',
      size: 2,
    } as const
    const first = await page(query)
    expect(
      first.items.map((item) => [item.id, item.listeningScrobbles]),
    ).toEqual([
      ['artist-a', 6],
      ['artist-b', 5],
    ])
    expect(first.hasMore).toBe(true)
    expect(
      (await page({ ...query, page: 2 })).items.map((item) => [
        item.id,
        item.listeningScrobbles,
      ]),
    ).toEqual([
      ['artist-c', 0],
      ['artist-d', 0],
    ])
    expect(await ids({ ...query, direction: 'asc', size: 10 })).toEqual([
      'artist-c',
      'artist-d',
      'artist-e',
      'artist-b',
      'artist-a',
    ])
  })

  it('defaults to one year and only adds period counts when a period applies', async () => {
    const sorted = await page({
      sortBy: 'listeningScrobbles',
      direction: 'desc',
      size: 2,
    })
    expect(
      sorted.items.map((item) => [item.id, item.listeningScrobbles]),
    ).toEqual([
      ['artist-b', 5],
      ['artist-a', 4],
    ])
    expect(
      (await page({ size: 1 })).items[0]?.listeningScrobbles,
    ).toBeUndefined()
  })

  it('applies rules and sorting to metadata pages, counts and selections', async () => {
    const { countArtistBrowse, listArtistMetadataBrowsePage } =
      await import('@/services/artist-browse')
    const input = {
      listening: { match: 'all', rules: [{ period: twoYears, min: 1 }] },
      sortBy: 'listeningScrobbles',
      direction: 'asc',
      listeningSort: twoYears,
    }
    const metadata = await listArtistMetadataBrowsePage(
      ArtistMetadataQuerySchema.parse(input),
    )
    expect(
      metadata.items.map((item) => [item.id, item.listeningScrobbles]),
    ).toEqual([
      ['artist-b', 5],
      ['artist-a', 6],
    ])
    expect(
      await countArtistBrowse(ArtistMetadataQuerySchema.parse(input)),
    ).toEqual({ totalCount: 2 })
    const { createArtistSelectionSnapshot } =
      await import('@/services/artist-bulk-selection')
    expect(
      (
        await createArtistSelectionSnapshot(
          ArtistMetadataQuerySchema.parse(input),
          ownerId,
        )
      ).totalCount,
    ).toBe(2)
    expect(
      (
        await createArtistSelectionSnapshot(
          ArtistMetadataQuerySchema.parse({ ...input, limitResults: 1 }),
          ownerId,
        )
      ).totalCount,
    ).toBe(1)
  })
})

describe('artist listening histogram', () => {
  it('counts the query without its listening rules into the artist bars', async () => {
    const { artistListeningHistogram } =
      await import('@/services/artist-browse')
    const histogram = (
      input: z.input<typeof ArtistListeningHistogramQuerySchema>,
    ) =>
      artistListeningHistogram(ArtistListeningHistogramQuerySchema.parse(input))
    expect(
      await histogram({
        period: twoYears,
        listening: { match: 'all', rules: [{ period: twoYears, min: 100 }] },
        size: 1,
        limitResults: 1,
        sortBy: 'listeningScrobbles',
      }),
    ).toEqual({
      edges: [0, 1, 10, 50, 100, 200, 500, 1000],
      counts: [3, 2, 0, 0, 0, 0, 0, 0],
    })
    expect((await histogram({ period: { kind: 'all' } })).counts).toEqual([
      1, 1, 2, 0, 0, 0, 0, 1,
    ])
    expect(
      (
        await histogram({
          period: { kind: 'all' },
          ranges: [{ field: 'albumCount', min: 1 }],
        })
      ).counts,
    ).toEqual([1, 1, 1, 0, 0, 0, 0, 1])
    expect(
      (
        await histogram({
          period: { kind: 'dates', from: '2023-05-10', to: '2023-05-10' },
          filters: [
            { field: 'name', value: 'Fixture artist C', mode: 'required' },
          ],
        })
      ).counts,
    ).toEqual([0, 1, 0, 0, 0, 0, 0, 0])
    expect(fetch).not.toHaveBeenCalled()
  })
})
