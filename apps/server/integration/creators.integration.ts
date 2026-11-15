import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ArtistAlbumQuerySchema,
  ArtistHistoryQuerySchema,
  ArtistPlaylistQuerySchema,
  ArtistQuerySchema,
  ArtistTrackQuerySchema,
  PersonFilmQuerySchema,
  PersonQuerySchema,
} from '@repo/schemas/creators'
import { AlbumQuerySchema, FilmQuerySchema } from '@repo/schemas/media'
import { TrackQuerySchema } from '@repo/schemas/tracks'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const database = `creators_${randomUUID().replaceAll('-', '')}`
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

import {
  loadArtistProviderTarget,
  saveArtistProviderResult,
} from '@/services/artist-profiles'
import { queryBrowseIds } from '@/services/browse'
import {
  getArtist,
  getArtistHistory,
  getPerson,
  listArtistAlbums,
  listArtistPlaylists,
  listArtists,
  listArtistTracks,
  listPeople,
  listPersonFilms,
} from '@/services/creators'

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', () => {
    throw new Error('Network forbidden in creator tests')
  })
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
  await databaseClient.insert(schema.artist).values([
    { id: 'dual', name: 'Delta Fixture', sortName: 'Fixture, Delta' },
    { id: 'music', name: 'Acoustic Fixture' },
    { id: 'actor', name: 'Screen Fixture' },
    { id: 'writer', name: 'Writer Fixture' },
    { id: 'hidden', name: 'Hidden Fixture' },
  ])
  const fixtures: (typeof schema.mediaItem.$inferInsert)[] = [
    { id: 'one', slug: 'one', title: 'Zeta release', mediaType: 'album' },
    { id: 'two', slug: 'two', title: 'Beta release', mediaType: 'album' },
    {
      id: 'other',
      slug: 'other',
      title: 'Another release',
      mediaType: 'album',
    },
    {
      id: 'hidden-album',
      slug: 'hidden-album',
      title: 'Hidden release',
      mediaType: 'album',
      metadata: { legacyHidden: true },
    },
    { id: 'track', slug: 'track', title: 'A song', mediaType: 'track' },
    {
      id: 'track-two',
      slug: 'track-two',
      title: 'Zeta song',
      mediaType: 'track',
    },
    {
      id: 'track-other',
      slug: 'track-other',
      title: 'Guest song',
      mediaType: 'track',
    },
    {
      id: 'film-one',
      slug: 'film-one',
      title: 'Studio story',
      mediaType: 'film',
    },
    {
      id: 'film-two',
      slug: 'film-two',
      title: 'Actor story',
      mediaType: 'film',
    },
    {
      id: 'hidden-film',
      slug: 'hidden-film',
      title: 'Hidden film',
      mediaType: 'film',
      metadata: { legacyHidden: true },
    },
  ]
  await databaseClient.insert(schema.mediaItem).values(fixtures)
  const subtype = (type: 'album' | 'film') =>
    fixtures
      .filter((item) => item.mediaType === type)
      .map(({ id }) => ({ mediaItemId: id }))
  await databaseClient.insert(schema.album).values(subtype('album'))
  await databaseClient.insert(schema.film).values(subtype('film'))
  await databaseClient
    .insert(schema.libraryTrack)
    .values([
      { mediaItemId: 'track', albumMediaItemId: 'one' },
      { mediaItemId: 'track-two', albumMediaItemId: 'one' },
      { mediaItemId: 'track-other' },
    ])
  await databaseClient.insert(schema.track).values([
    {
      id: 'entry-one',
      albumMediaItemId: 'one',
      trackMediaItemId: 'track',
      title: 'A song',
      position: 1,
    },
    {
      id: 'entry-two',
      albumMediaItemId: 'one',
      trackMediaItemId: 'track',
      title: 'A song (reprise)',
      position: 2,
    },
    {
      id: 'entry-three',
      albumMediaItemId: 'two',
      trackMediaItemId: 'track-other',
      title: 'Guest song',
      position: 1,
    },
  ])
  await databaseClient.insert(schema.mediaCredit).values([
    { artistId: 'dual', mediaItemId: 'one', role: 'artist' },
    { artistId: 'dual', mediaItemId: 'two', role: 'artist' },
    { artistId: 'dual', mediaItemId: 'track', role: 'artist' },
    { artistId: 'dual', mediaItemId: 'track-two', role: 'artist' },
    { artistId: 'music', mediaItemId: 'track-other', role: 'artist' },
    { artistId: 'dual', mediaItemId: 'hidden-album', role: 'artist' },
    { artistId: 'music', mediaItemId: 'other', role: 'artist' },
    { artistId: 'hidden', mediaItemId: 'hidden-album', role: 'artist' },
    { artistId: 'dual', mediaItemId: 'film-one', role: 'director' },
    { artistId: 'dual', mediaItemId: 'film-one', role: 'actor' },
    { artistId: 'dual', mediaItemId: 'film-two', role: 'actor' },
    { artistId: 'dual', mediaItemId: 'hidden-film', role: 'director' },
    { artistId: 'actor', mediaItemId: 'film-two', role: 'actor' },
    { artistId: 'writer', mediaItemId: 'film-one', role: 'writer' },
  ])
  await databaseClient.insert(schema.playlist).values([
    { id: 'mix', name: 'Fixture mix', kind: 'playlist' },
    {
      id: 'favorites',
      name: 'Fixture favorites',
      kind: 'playlist',
      source: 'spotify',
    },
    { id: 'collection', name: 'Fixture collection', kind: 'collection' },
    { id: 'canonical', name: 'Fixture guest playlist', kind: 'playlist' },
  ])
  await databaseClient.insert(schema.playlistItem).values([
    { playlistId: 'mix', mediaItemId: 'one' },
    { playlistId: 'mix', mediaItemId: 'track' },
    { playlistId: 'mix', mediaItemId: 'other' },
    { playlistId: 'favorites', mediaItemId: 'track' },
    { playlistId: 'favorites', mediaItemId: 'track-two' },
    { playlistId: 'favorites', mediaItemId: 'hidden-album' },
    { playlistId: 'collection', mediaItemId: 'track' },
    { playlistId: 'canonical', mediaItemId: 'track-other' },
  ])
  await databaseClient.insert(schema.scrapeJob).values([
    {
      id: 'older-job',
      provider: 'spotify',
      status: 'succeeded',
      scope: {},
      options: {},
    },
    {
      id: 'newer-job',
      provider: 'spotify',
      status: 'succeeded',
      scope: {},
      options: {},
    },
    {
      id: 'catalog-job',
      provider: 'musicbrainz',
      status: 'succeeded',
      scope: {},
      options: {},
    },
  ])
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('creator directories and related library items', () => {
  it('pages music artists, searching and sorting before paging', async () => {
    const first = await listArtists(
      ArtistQuerySchema.parse({
        sortBy: 'albumCount',
        direction: 'desc',
        size: 1,
      }),
    )
    expect(first).toMatchObject({
      totalCount: 2,
      pageCount: 2,
      items: [{ id: 'dual', albumCount: 2, trackCount: 2, playlistCount: 3 }],
    })
    expect(
      (
        await listArtists(ArtistQuerySchema.parse({ q: 'fixture, delta' }))
      ).items.map((row) => row.id),
    ).toEqual(['dual'])
    expect(
      await listArtists(ArtistQuerySchema.parse({ q: '%', page: 2 })),
    ).toMatchObject({ totalCount: 0, items: [] })
    await expect(getArtist('actor')).rejects.toMatchObject({
      response: { statusCode: 404 },
    })
    await expect(getArtist('hidden')).rejects.toMatchObject({
      response: { statusCode: 404 },
    })
  })

  it('counts credited tracks and distinct credited albums reached through playlists', async () => {
    expect(
      await listArtistAlbums(
        'dual',
        ArtistAlbumQuerySchema.parse({ size: 1, page: 2 }),
      ),
    ).toMatchObject({ totalCount: 2, items: [{ id: 'one' }] })
    expect(
      await listArtistTracks('dual', ArtistTrackQuerySchema.parse({})),
    ).toMatchObject({
      totalCount: 2,
      items: [{ id: 'track', album: { id: 'one' } }, { id: 'track-two' }],
    })
    expect(
      await listArtistPlaylists(
        'dual',
        ArtistPlaylistQuerySchema.parse({
          sortBy: 'albumCount',
          direction: 'desc',
        }),
      ),
    ).toMatchObject({
      totalCount: 3,
      items: [
        { id: 'favorites', albumCount: 1, trackCount: 2 },
        { id: 'canonical', albumCount: 1, trackCount: 0 },
        { id: 'mix', albumCount: 1, trackCount: 1 },
      ],
    })
    expect(
      await listArtistPlaylists(
        'music',
        ArtistPlaylistQuerySchema.parse({ q: 'guest' }),
      ),
    ).toMatchObject({
      totalCount: 1,
      items: [{ id: 'canonical', albumCount: 0, trackCount: 1 }],
    })
  })

  it('shares the creator identity, deduplicates films, and filters by supported film roles', async () => {
    expect(
      await listPeople(PersonQuerySchema.parse({ role: 'director' })),
    ).toMatchObject({
      totalCount: 1,
      items: [
        {
          id: 'dual',
          filmCount: 2,
          directorCount: 1,
          actorCount: 2,
          roles: ['director', 'actor'],
        },
      ],
    })
    expect(await getPerson('dual')).toMatchObject({
      id: (await getArtist('dual')).id,
      filmCount: 2,
    })
    expect(
      await listPersonFilms(
        'dual',
        PersonFilmQuerySchema.parse({ role: 'director' }),
      ),
    ).toMatchObject({ totalCount: 1, items: [{ id: 'film-one' }] })
    expect(
      await listPersonFilms('dual', PersonFilmQuerySchema.parse({})),
    ).toMatchObject({
      totalCount: 2,
      items: [{ id: 'film-two' }, { id: 'film-one' }],
    })
    await expect(getPerson('writer')).rejects.toMatchObject({
      response: { statusCode: 404 },
    })
  })

  it('keeps provider history and moves only that provider’s current state', async () => {
    expect(await loadArtistProviderTarget('dual', 'spotify')).toEqual({
      name: 'Delta Fixture',
      providerArtistId: null,
    })
    expect(await loadArtistProviderTarget('actor', 'spotify')).toBeNull()
    await saveArtistProviderResult('dual', 'spotify', {
      profile: { externalId: 'first-id', tags: ['Earlier genre'] },
      payload: { title: 'First provider fixture' },
      scrapeJobId: 'older-job',
    })
    await saveArtistProviderResult('dual', 'spotify', {
      profile: {
        externalId: 'latest-id',
        artworkUrl: 'https://example.test/profile.png',
        tags: ['  Art   Rock', 'art rock'],
      },
      payload: { title: 'Second provider fixture' },
      scrapeJobId: 'newer-job',
    })
    await saveArtistProviderResult('dual', 'musicbrainz', {
      profile: { summary: 'A test profile', tags: ['Art Rock', 'Jazz'] },
      payload: { title: 'Catalog fixture' },
      scrapeJobId: 'catalog-job',
    })
    expect(await loadArtistProviderTarget('dual', 'spotify')).toMatchObject({
      providerArtistId: 'latest-id',
    })
    const detail = await getArtist('dual')
    expect(detail).toMatchObject({
      artworkUrl: 'https://example.test/profile.png',
      profile: { summary: 'A test profile', tags: ['Art Rock', 'Jazz'] },
    })
    expect(detail.providers.map((profile) => profile.scrapeJobId)).toEqual([
      'catalog-job',
      'newer-job',
    ])
    expect(detail.history.map((profile) => profile.scrapeJobId)).toEqual([
      'catalog-job',
      'newer-job',
      'older-job',
    ])
    expect(
      await getArtistHistory(
        'dual',
        ArtistHistoryQuerySchema.parse({
          provider: 'spotify',
          size: 1,
          page: 2,
        }),
      ),
    ).toMatchObject({
      totalCount: 2,
      items: [
        { scrapeJobId: 'older-job', profile: { externalId: 'first-id' } },
      ],
    })
    expect(await databaseClient.select().from(schema.mediaItemTag)).toEqual([])
  })

  it('scopes Browse to an exact creator ID and the selected film role', async () => {
    await databaseClient.insert(schema.artist).values({
      id: 'case-variant',
      name: 'delta fixture',
    })
    await databaseClient.insert(schema.mediaCredit).values([
      { artistId: 'case-variant', mediaItemId: 'other', role: 'artist' },
      { artistId: 'case-variant', mediaItemId: 'track-other', role: 'artist' },
      { artistId: 'case-variant', mediaItemId: 'film-two', role: 'director' },
    ])
    const exact = { creatorId: 'dual' }
    expect(
      (await queryBrowseIds('album', AlbumQuerySchema.parse(exact))).ids.sort(),
    ).toEqual(['one', 'two'])
    expect(
      (await queryBrowseIds('track', TrackQuerySchema.parse(exact))).ids.sort(),
    ).toEqual(['track', 'track-two'])
    expect(
      (
        await queryBrowseIds(
          'film',
          FilmQuerySchema.parse({ ...exact, creatorRole: 'director' }),
        )
      ).ids,
    ).toEqual(['film-one'])
    expect(
      (
        await queryBrowseIds(
          'film',
          FilmQuerySchema.parse({ ...exact, creatorRole: 'actor' }),
        )
      ).ids.sort(),
    ).toEqual(['film-one', 'film-two'])
    expect(
      FilmQuerySchema.safeParse({ ...exact, creatorRole: 'writer' }).success,
    ).toBe(false)

    const filter = {
      field: 'director',
      value: 'Delta Fixture',
      mode: 'required',
    }
    const oldQuery = FilmQuerySchema.parse({
      filters: JSON.stringify([filter]),
    })
    expect((await queryBrowseIds('film', oldQuery)).ids.sort()).toEqual([
      'film-one',
      'film-two',
    ])
  })
})
