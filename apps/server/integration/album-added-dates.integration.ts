import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { AlbumQuerySchema } from '@repo/schemas/media'
import { getBrowseValues } from '@repo/schemas/browse'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const database = `album_dates_${randomUUID().replaceAll('-', '')}`
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
beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No network in album date tests')
    }),
  )
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  await databaseClient.delete(schema.lastfmScrobble)
  await databaseClient.delete(schema.mediaItem)
})
afterAll(async () => {
  expect(fetch).not.toHaveBeenCalled()
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

async function album(id: string, dateAdded: string | null) {
  await databaseClient.insert(schema.mediaItem).values({
    id,
    slug: id,
    title: id,
    mediaType: 'album',
    metadata: { browse: { dateAdded: Date.UTC(2099, 0, 1) } },
  })
  await databaseClient.insert(schema.album).values({
    mediaItemId: id,
    dateAdded: dateAdded === null ? null : new Date(dateAdded),
  })
}

async function scrobble(id: string, albumId: string | null, date: string) {
  await databaseClient.insert(schema.lastfmScrobble).values({
    id,
    username: 'fixture',
    listenedAt: new Date(date),
    artistName: 'Fixture artist',
    albumName: 'Fixture album',
    trackName: 'Fixture track',
    artistKey: 'fixture artist',
    albumKey: 'fixture album',
    trackKey: 'fixture track',
    albumMediaItemId: albumId,
  })
}

describe('album Added dates from retained listening history', () => {
  it('uses the earliest linked listen in display, sorting and ranges without changing the source date', async () => {
    const { listAlbums, getAlbumDetail } = await import('@/services/media')
    await album('listened', '2024-01-01')
    await album('stored', '2020-01-01')
    await scrobble('later', 'listened', '2025-01-01')
    await scrobble('first', 'listened', '2010-01-01')
    await scrobble('unlinked', null, '2005-01-01')

    const listed = await listAlbums(
      AlbumQuerySchema.parse({ direction: 'asc' }),
    )
    expect(listed.items.map((item) => item.id)).toEqual(['listened', 'stored'])
    expect(listed.items[0]?.dateAdded).toBe('2010-01-01T00:00:00.000Z')
    const detail = await getAlbumDetail('listened')
    expect(detail).toMatchObject({
      dateAdded: '2010-01-01T00:00:00.000Z',
      dateAddedSource: 'First Last.fm scrobble',
      storedDateAdded: '2024-01-01T00:00:00.000Z',
    })
    if (!detail) throw new Error('Expected album detail')
    expect(getBrowseValues(detail).dateAdded).toBe(Date.UTC(2010, 0, 1))
    const ranged = await listAlbums(
      AlbumQuerySchema.parse({
        ranges: JSON.stringify([
          { field: 'dateAdded', max: Date.UTC(2015, 0, 1) },
        ]),
      }),
    )
    expect(ranged.items.map((item) => item.id)).toEqual(['listened'])
    expect(ranged.totalCount).toBe(1)
    const source = await databaseClient.query.album.findFirst({
      where: eq(schema.album.mediaItemId, 'listened'),
    })
    expect(source?.dateAdded?.toISOString()).toBe('2024-01-01T00:00:00.000Z')
  })

  it('preserves earlier stored dates and handles absent dates and scrobbles', async () => {
    const { listAlbums } = await import('@/services/media')
    await album('earlier', '2008-01-01')
    await album('only-listen', null)
    await album('unknown', null)
    await scrobble('later', 'earlier', '2010-01-01')
    await scrobble('only', 'only-listen', '2011-01-01')
    const listed = await listAlbums(
      AlbumQuerySchema.parse({ direction: 'asc' }),
    )
    expect(listed.items.map((item) => [item.id, item.dateAdded])).toEqual([
      ['earlier', '2008-01-01T00:00:00.000Z'],
      ['only-listen', '2011-01-01T00:00:00.000Z'],
      ['unknown', null],
    ])
    expect(listed.items[0]?.dateAddedSource).toBe('Stored library date')
  })

  it('reflects unlinking and relinking immediately and leaves both source dates intact', async () => {
    const { getAlbumDetail, listAlbums } = await import('@/services/media')
    await album('first-album', '2020-01-01')
    await album('second-album', '2021-01-01')
    await scrobble('link', 'first-album', '2009-01-01')
    const query = AlbumQuerySchema.parse({
      ranges: JSON.stringify([
        { field: 'dateAdded', max: Date.UTC(2010, 0, 1) },
      ]),
    })
    expect((await listAlbums(query)).totalCount).toBe(1)
    await databaseClient
      .update(schema.lastfmScrobble)
      .set({ albumMediaItemId: null })
      .where(eq(schema.lastfmScrobble.id, 'link'))
    expect((await getAlbumDetail('first-album'))?.dateAdded).toBe(
      '2020-01-01T00:00:00.000Z',
    )
    expect((await listAlbums(query)).totalCount).toBe(0)
    await databaseClient
      .update(schema.lastfmScrobble)
      .set({ albumMediaItemId: 'second-album' })
      .where(eq(schema.lastfmScrobble.id, 'link'))
    expect((await getAlbumDetail('second-album'))?.dateAdded).toBe(
      '2009-01-01T00:00:00.000Z',
    )
    expect((await listAlbums(query)).items.map((item) => item.id)).toEqual([
      'second-album',
    ])
    expect(
      (
        await databaseClient
          .select()
          .from(schema.album)
          .orderBy(schema.album.mediaItemId)
      ).map((item) => item.dateAdded?.toISOString()),
    ).toEqual(['2020-01-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z'])
  })
})
