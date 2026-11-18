import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import type { ListeningFilter, ListeningPeriod } from '@repo/schemas/listening'
import { AlbumQuerySchema } from '@repo/schemas/media'
import {
  TrackPositionsQuerySchema,
  TrackQuerySchema,
} from '@repo/schemas/tracks'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const database = `browse_listening_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))
let created = false

async function addScrobbles(
  albumId: string | null,
  date: string,
  count: number,
) {
  await databaseClient.insert(schema.lastfmScrobble).values(
    Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      username: 'fixture-listener',
      listenedAt: new Date(date),
      artistName: 'Fixture artist',
      albumName: 'Fixture album',
      trackName: `Fixture track ${index}`,
      artistKey: 'fixture artist',
      albumKey: 'fixture album',
      trackKey: `fixture track ${index}`,
      albumMediaItemId: albumId,
    })),
  )
}

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network requests are forbidden in integration tests')
    }),
  )
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-03-31T12:00:00Z'))
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
  for (const id of ['a', 'b', 'c', 'd']) {
    await databaseClient.insert(schema.mediaItem).values({
      id,
      slug: id,
      mediaType: 'album',
      title: `Album ${id}`,
      metadata: {
        browse: { scrobbles: 999, popularitySpotify: id === 'd' ? 75 : 20 },
      },
    })
    await databaseClient.insert(schema.album).values({ mediaItemId: id })
  }
  await addScrobbles('a', '2022-06-01T00:00:00Z', 5)
  await addScrobbles('a', '2025-06-01T00:00:00Z', 2)
  await addScrobbles('a', '2024-03-31T12:00:00Z', 1)
  await addScrobbles('a', '2024-03-31T11:59:59.999Z', 1)
  await addScrobbles('a', '2026-03-31T12:00:00Z', 1)
  await addScrobbles('a', '2026-03-31T12:00:00.001Z', 1)
  await addScrobbles('b', '2022-06-01T00:00:00Z', 3)
  await addScrobbles('b', '2025-06-01T00:00:00Z', 6)
  await addScrobbles('d', '2022-06-01T00:00:00Z', 10)
  await addScrobbles(null, '2025-06-01T00:00:00Z', 20)
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function query(input: z.input<typeof AlbumQuerySchema>) {
  const { queryBrowseIds } = await import('@/services/browse')
  return queryBrowseIds(
    'album',
    AlbumQuerySchema.parse({ sortBy: 'title', direction: 'asc', ...input }),
  )
}

describe('album listening browse queries', () => {
  it('counts zero linked plays without falling back to provider totals', async () => {
    expect(
      (
        await query({
          listening: {
            match: 'all',
            rules: [{ period: { kind: 'all' }, max: 0 }],
          },
        })
      ).ids,
    ).toEqual(['c'])
    expect(
      (
        await query({
          listening: {
            match: 'all',
            rules: [
              {
                period: { kind: 'rolling', amount: 2, unit: 'years' },
                min: 4,
                max: 6,
              },
            ],
          },
        })
      ).ids,
    ).toEqual(['a', 'b'])
  })

  it('combines different periods with all or any and ANDs other browse filters', async () => {
    const rules = [
      { period: { kind: 'all' }, min: 10 },
      { period: { kind: 'rolling', amount: 2, unit: 'years' }, max: 0 },
    ]
    expect((await query({ listening: { match: 'all', rules } })).ids).toEqual([
      'd',
    ])
    expect((await query({ listening: { match: 'any', rules } })).ids).toEqual([
      'a',
      'c',
      'd',
    ])
    expect(
      (
        await query({
          listening: { match: 'any', rules },
          ranges: [{ field: 'popularitySpotify', min: 70 }],
        })
      ).ids,
    ).toEqual(['d'])
    expect(
      (
        await query({
          listening: { match: 'all', rules },
          filters: JSON.stringify([
            { field: 'title', value: 'Album d', mode: 'exclude' },
          ]),
        })
      ).ids,
    ).toEqual([])
  })

  it('uses inclusive UTC dates and keeps different periods separate in the count cache', async () => {
    expect(
      (
        await query({
          listening: {
            match: 'all',
            rules: [
              {
                period: { kind: 'dates', from: '2024-03-31', to: '2024-03-31' },
                min: 2,
                max: 2,
              },
            ],
          },
        })
      ).ids,
    ).toEqual(['a'])
    const first = await query({
      listening: {
        match: 'all',
        rules: [{ period: { kind: 'dates', to: '2023-01-01' }, min: 6 }],
      },
    })
    const second = await query({
      listening: {
        match: 'all',
        rules: [{ period: { kind: 'dates', from: '2025-01-01' }, min: 6 }],
      },
    })
    expect(first.ids).toEqual(['d'])
    expect(first.totalCount).toBe(1)
    expect(second.ids).toEqual(['b'])
    expect(second.totalCount).toBe(1)
    expect(
      (
        await query({
          listening: {
            match: 'all',
            rules: [{ period: { kind: 'all' }, min: 6 }],
          },
        })
      ).totalCount,
    ).toBe(3)
  })

  it('sorts and paginates counts with stable IDs and returns the displayed values', async () => {
    const listeningSort = { kind: 'rolling', amount: 2, unit: 'years' }
    const first = await query({
      listeningSort,
      sortBy: 'listeningScrobbles',
      direction: 'desc',
      size: 2,
    })
    const second = await query({
      listeningSort,
      sortBy: 'listeningScrobbles',
      direction: 'desc',
      size: 2,
      page: 2,
    })
    expect(first).toMatchObject({
      ids: ['b', 'a'],
      totalCount: 4,
      pageCount: 2,
    })
    expect([...(first.listeningScrobbles ?? [])]).toEqual([
      ['b', 6],
      ['a', 4],
    ])
    expect(second.ids).toEqual(['c', 'd'])
    expect(
      (
        await query({
          listeningSort,
          sortBy: 'listeningScrobbles',
          direction: 'asc',
        })
      ).ids,
    ).toEqual(['c', 'd', 'a', 'b'])
    const { listAlbums } = await import('@/services/media')
    const albums = await listAlbums(
      AlbumQuerySchema.parse({
        listeningSort,
        sortBy: 'title',
        direction: 'asc',
      }),
    )
    expect(
      albums.items.map((item) => [item.id, item.listeningScrobbles]),
    ).toEqual([
      ['a', 4],
      ['b', 6],
      ['c', 0],
      ['d', 0],
    ])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('defaults custom count sorting to one year and rejects film listening controls', async () => {
    expect(
      (await query({ sortBy: 'listeningScrobbles', direction: 'desc' })).ids,
    ).toEqual(['b', 'a', 'c', 'd'])
    const { queryBrowseIds } = await import('@/services/browse')
    await expect(
      queryBrowseIds(
        'film',
        AlbumQuerySchema.parse({ listeningSort: { kind: 'all' } }),
      ),
    ).rejects.toThrow('Listening controls are not available for films')
  })

  it('includes both ends of a UTC calendar day while excluding adjacent days', async () => {
    await databaseClient.insert(schema.mediaItem).values({
      id: 'date-edges',
      slug: 'date-edges',
      mediaType: 'album',
      title: 'Date edge fixture',
    })
    await databaseClient
      .insert(schema.album)
      .values({ mediaItemId: 'date-edges' })
    for (const date of [
      '2024-02-28T23:59:59.999Z',
      '2024-02-29T00:00:00Z',
      '2024-02-29T23:59:59.999Z',
      '2024-03-01T00:00:00Z',
    ]) {
      await addScrobbles('date-edges', date, 1)
    }
    expect(
      (
        await query({
          listening: {
            match: 'all',
            rules: [
              {
                period: { kind: 'dates', from: '2024-02-29', to: '2024-02-29' },
                min: 2,
                max: 2,
              },
            ],
          },
        })
      ).ids,
    ).toEqual(['date-edges'])
  })

  it('counts albums per bar without the query listening rules or result cap', async () => {
    const { queryListeningHistogram } = await import('@/services/browse')
    const histogram = (input: z.input<typeof AlbumQuerySchema>) =>
      queryListeningHistogram('album', AlbumQuerySchema.parse(input), {
        kind: 'all',
      })
    // a 11, b 9, c 0, d 10, date-edges 4.
    const all = {
      edges: [0, 1, 5, 10, 20, 50, 100, 200],
      counts: [1, 1, 1, 2, 0, 0, 0, 0],
    }
    expect(await histogram({})).toEqual(all)
    expect(
      await histogram({
        listening: {
          match: 'all',
          rules: [{ period: { kind: 'all' }, max: 0 }],
        },
        limitResults: 1,
        sortBy: 'title',
        page: 3,
      }),
    ).toEqual(all)
    expect(
      await histogram({ ranges: [{ field: 'popularitySpotify', min: 70 }] }),
    ).toEqual({ edges: all.edges, counts: [0, 0, 0, 1, 0, 0, 0, 0] })
    // a 4, b 6, others 0 in the last two years.
    expect(
      await queryListeningHistogram('album', AlbumQuerySchema.parse({}), {
        kind: 'rolling',
        amount: 2,
        unit: 'years',
      }),
    ).toEqual({ edges: all.edges, counts: [3, 1, 1, 0, 0, 0, 0, 0] })
  })
})

async function addTrack(
  id: string,
  title: string,
  options: { isrc?: string; spotifyTrackId?: string } = {},
) {
  await databaseClient.insert(schema.mediaItem).values({
    id,
    slug: id,
    mediaType: 'track',
    title,
  })
  await databaseClient.insert(schema.libraryTrack).values({
    mediaItemId: id,
    isrc: options.isrc,
    spotifyTrackId: options.spotifyTrackId,
    durationSec: 180,
  })
  await databaseClient
    .insert(schema.mediaCredit)
    .values({ mediaItemId: id, artistId: 'track-artist', role: 'artist' })
}

async function linkName(trackKey: string, trackId: string, strategy = 'exact') {
  await databaseClient.insert(schema.lastfmTrackLink).values({
    username: 'fixture-listener',
    artistKey: 'track artist',
    trackKey,
    trackMediaItemId: trackId,
    strategy,
  })
}

async function scrobbleName(trackKey: string, date: string, count: number) {
  await databaseClient.insert(schema.lastfmScrobble).values(
    Array.from({ length: count }, () => ({
      id: randomUUID(),
      username: 'fixture-listener',
      listenedAt: new Date(date),
      artistName: 'Track artist',
      trackName: trackKey,
      artistKey: 'track artist',
      trackKey,
    })),
  )
}

async function trackQuery(input: z.input<typeof TrackQuerySchema>) {
  const { queryBrowseIds } = await import('@/services/browse')
  return queryBrowseIds(
    'track',
    TrackQuerySchema.parse({ sortBy: 'title', direction: 'asc', ...input }),
  )
}

const twoYears: ListeningPeriod = { kind: 'rolling', amount: 2, unit: 'years' }

describe('track listening browse queries', () => {
  beforeAll(async () => {
    await databaseClient
      .insert(schema.artist)
      .values({ id: 'track-artist', name: 'Track artist' })
    // Ungrouped tracks. All time / last two years: one 5/2, two 5/5,
    // three 0/0, four 10/0.
    await addTrack('t1', 'Song one')
    await addTrack('t2', 'Song two')
    await addTrack('t3', 'Song three')
    await addTrack('t4', 'Song four')
    await linkName('song one', 't1', 'normalized')
    await linkName('song two', 't2', 'normalized')
    await linkName('song two live', 't2', 'normalized')
    await linkName('song four', 't4', 'normalized')
    await scrobbleName('song one', '2022-06-01T00:00:00Z', 3)
    await scrobbleName('song one', '2025-06-01T00:00:00Z', 2)
    await scrobbleName('song two', '2025-06-01T00:00:00Z', 1)
    await scrobbleName('song two live', '2025-07-01T00:00:00Z', 4)
    await scrobbleName('song four', '2022-06-01T00:00:00Z', 10)
    // Two editions of one recording that share a scrobbled name. Edition one
    // 3/2, edition two 5/5, the recording 6/5 with the shared name once.
    await addTrack('edition-1', 'Grouped song', {
      isrc: 'USABC2600001',
      spotifyTrackId: '0000000000000000000001',
    })
    await addTrack('edition-2', 'Grouped song', { isrc: 'USABC2600001' })
    await linkName('grouped song', 'edition-1')
    await linkName('grouped song', 'edition-2')
    await linkName('grouped song album', 'edition-1', 'normalized')
    await linkName('grouped song ep', 'edition-2', 'normalized')
    await scrobbleName('grouped song', '2025-06-01T00:00:00Z', 2)
    await scrobbleName('grouped song album', '2022-06-01T00:00:00Z', 1)
    await scrobbleName('grouped song ep', '2025-07-01T00:00:00Z', 3)
    const { refreshTrackListeningTotals } =
      await import('@/services/track-links')
    await databaseClient.transaction((tx) => refreshTrackListeningTotals(tx))
  })

  it('applies all and any rules with zero bounds, rolling and date periods', async () => {
    const q = 'song'
    expect(
      (
        await trackQuery({
          q,
          listening: {
            match: 'all',
            rules: [{ period: { kind: 'all' }, max: 0 }],
          },
        })
      ).ids,
    ).toEqual(['t3'])
    expect(
      (
        await trackQuery({
          q,
          listening: {
            match: 'all',
            rules: [{ period: twoYears, min: 2, max: 5 }],
          },
        })
      ).ids,
    ).toEqual(['edition-1', 'edition-2', 't1', 't2'])
    const rules = [
      { period: { kind: 'all' }, min: 10 },
      { period: twoYears, max: 0 },
    ]
    expect(
      (await trackQuery({ listening: { match: 'all', rules } })).ids,
    ).toEqual(['t4'])
    expect(
      (await trackQuery({ listening: { match: 'any', rules } })).ids,
    ).toEqual(['t4', 't3'])
    expect(
      (
        await trackQuery({
          q: 'two',
          listening: {
            match: 'all',
            rules: [
              {
                period: { kind: 'dates', from: '2025-07-01', to: '2025-07-01' },
                min: 4,
                max: 4,
              },
            ],
          },
        })
      ).ids,
    ).toEqual(['t2'])
    const { queryBrowseCounts } = await import('@/services/browse')
    expect(
      await queryBrowseCounts(
        'track',
        TrackQuerySchema.parse({ listening: { match: 'any', rules } }),
      ),
    ).toEqual({ totalCount: 2, unfilteredCount: 6 })
  })

  it('sorts by a period count and returns it on rows, equal to scrobbles for all time', async () => {
    const descending = await trackQuery({
      listeningSort: twoYears,
      sortBy: 'listeningScrobbles',
      direction: 'desc',
      size: 3,
    })
    expect(descending.ids).toEqual(['edition-2', 't2', 'edition-1'])
    expect([...(descending.listeningScrobbles ?? [])]).toEqual([
      ['edition-2', 5],
      ['t2', 5],
      ['edition-1', 2],
    ])
    // The sort period defaults to the last year.
    expect(
      (await trackQuery({ sortBy: 'listeningScrobbles', direction: 'desc' }))
        .ids,
    ).toEqual(['edition-2', 't2', 'edition-1', 't1', 't4', 't3'])
    const { listTrackBrowsePage, listTracks, listTracksAtPositions } =
      await import('@/services/tracks')
    const all = await listTracks(
      TrackQuerySchema.parse({ listeningSort: { kind: 'all' } }),
    )
    expect(all.items).toHaveLength(6)
    for (const item of all.items)
      expect(item.listeningScrobbles).toBe(item.scrobbles)
    const page = await listTrackBrowsePage(
      TrackQuerySchema.parse({ q: 'three', listeningSort: twoYears }),
    )
    expect(page.items.map((item) => item.listeningScrobbles)).toEqual([0])
    expect(
      (await listTrackBrowsePage(TrackQuerySchema.parse({ q: 'three' })))
        .items[0]?.listeningScrobbles,
    ).toBeUndefined()
    const positions = await listTracksAtPositions(
      TrackPositionsQuerySchema.parse({
        listening: {
          match: 'all',
          rules: [{ period: twoYears, min: 1 }],
        },
        listeningSort: twoYears,
        sortBy: 'listeningScrobbles',
        direction: 'asc',
        positions: '0,3,4',
      }),
    )
    expect(
      positions.items.map(({ position, item }) => [
        position,
        item.id,
        item.listeningScrobbles,
      ]),
    ).toEqual([
      [0, 'edition-1', 2],
      [3, 't2', 5],
    ])
  })

  it('evaluates rules, sorting and counts per recording group', async () => {
    const grouped = { groupRecordings: true, q: 'grouped' } as const
    const atLeastSix: ListeningFilter = {
      match: 'all',
      rules: [{ period: { kind: 'all' }, min: 6 }],
    }
    expect(
      (await trackQuery({ ...grouped, listening: atLeastSix })).ids,
    ).toEqual(['edition-1'])
    expect(
      (await trackQuery({ q: 'grouped', listening: atLeastSix })).ids,
    ).toEqual([])
    expect(
      (
        await trackQuery({
          ...grouped,
          listening: {
            match: 'all',
            rules: [{ period: twoYears, min: 5, max: 5 }],
          },
        })
      ).ids,
    ).toEqual(['edition-1'])
    const { queryBrowseCounts } = await import('@/services/browse')
    const ungroupedTotal = (
      await queryBrowseCounts(
        'track',
        TrackQuerySchema.parse({ groupRecordings: true }),
      )
    ).totalCount
    expect(ungroupedTotal).toBe(5)
    expect(
      await queryBrowseCounts(
        'track',
        TrackQuerySchema.parse({ ...grouped, listening: atLeastSix }),
      ),
    ).toEqual({ totalCount: 1, unfilteredCount: 5 })
    expect(
      await queryBrowseCounts(
        'track',
        TrackQuerySchema.parse({
          groupRecordings: true,
          listening: atLeastSix,
          ranges: [{ field: 'scrobbles', max: 6 }],
        }),
      ),
    ).toEqual({ totalCount: 1, unfilteredCount: 5 })

    const {
      listTrackBrowsePage,
      listTrackRecordingVersions,
      listTracksAtPositions,
    } = await import('@/services/tracks')
    const sorted = TrackQuerySchema.parse({
      groupRecordings: true,
      listening: { match: 'all', rules: [{ period: { kind: 'all' }, min: 1 }] },
      listeningSort: { kind: 'all' },
      sortBy: 'listeningScrobbles',
      direction: 'desc',
    })
    const page = await listTrackBrowsePage(sorted)
    expect(
      page.items.map((item) => [
        item.id,
        item.listeningScrobbles,
        item.scrobbles,
        item.recordingGroup?.versionCount,
      ]),
    ).toEqual([
      ['t4', 10, 10, undefined],
      ['edition-1', 6, 6, 2],
      ['t1', 5, 5, undefined],
      ['t2', 5, 5, undefined],
    ])
    expect(
      (
        await listTracksAtPositions(
          TrackPositionsQuerySchema.parse({ ...sorted, positions: '1' }),
        )
      ).items.map(({ item }) => [item.id, item.listeningScrobbles]),
    ).toEqual([['edition-1', 6]])
    // Versions carry and sort by their own counts within an eligible group.
    const versions = await listTrackRecordingVersions('edition-1', sorted)
    expect(
      versions.items.map((item) => [item.id, item.listeningScrobbles]),
    ).toEqual([
      ['edition-2', 5],
      ['edition-1', 3],
    ])
    expect(
      (
        await listTrackRecordingVersions('edition-1', {
          ...sorted,
          listening: {
            match: 'all',
            rules: [{ period: { kind: 'all' }, min: 7 }],
          },
        })
      ).items,
    ).toEqual([])
  })

  it('counts tracks or recording groups per bar without the query listening rules', async () => {
    const { queryListeningHistogram } = await import('@/services/browse')
    const histogram = (
      input: z.input<typeof TrackQuerySchema>,
      period: ListeningPeriod = { kind: 'all' },
    ) => queryListeningHistogram('track', TrackQuerySchema.parse(input), period)
    const edges = [0, 1, 2, 5, 10, 20, 50, 100]
    const ignored: z.input<typeof TrackQuerySchema> = {
      listening: { match: 'all', rules: [{ period: { kind: 'all' }, max: 0 }] },
      limitResults: 1,
      sortBy: 'title',
    }
    // Tracks: three 0, edition one 3, one, two and edition two 5, four 10.
    expect(await histogram({})).toEqual({
      edges,
      counts: [1, 0, 1, 3, 1, 0, 0, 0],
    })
    expect(await histogram(ignored)).toEqual(await histogram({}))
    expect(await histogram({ q: 'grouped' })).toEqual({
      edges,
      counts: [0, 0, 1, 1, 0, 0, 0, 0],
    })
    expect(await histogram({}, twoYears)).toEqual({
      edges,
      counts: [2, 0, 2, 2, 0, 0, 0, 0],
    })
    // Recording groups: three 0, one, two and the recording 5 or 6, four 10.
    expect(await histogram({ ...ignored, groupRecordings: true })).toEqual({
      edges,
      counts: [1, 0, 0, 3, 1, 0, 0, 0],
    })
    expect(
      await histogram({
        groupRecordings: true,
        ranges: [{ field: 'scrobbles', min: 1 }],
      }),
    ).toEqual({ edges, counts: [0, 0, 0, 3, 1, 0, 0, 0] })
    expect(await histogram({ groupRecordings: true }, twoYears)).toEqual({
      edges,
      counts: [2, 0, 1, 2, 0, 0, 0, 0],
    })
  })
})
