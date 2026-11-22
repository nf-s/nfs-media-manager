import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq, sql } from 'drizzle-orm'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { spotifyPlugin } from '@/plugins/builtin/spotify'
import { tmdbPlugin } from '@/plugins/builtin/tmdb'
import {
  spotifyAlbumFixture,
  spotifyAlbumId,
  spotifyTrackId,
  spotifyTokenFixture,
} from '@/plugins/builtin/__tests__/fixtures/spotify'
import { createCatalogEntryFromPlugin } from '@/lib/provider-catalog'

const database = `manual_add_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
const plugins = [spotifyPlugin, tmdbPlugin]
const shorterPageTrackId = 'AAAAAAAAAAAAAAAAAAAAAA'
/** A longer release with the title and artist of the fixture album. */
const extendedAlbumId = 'CCCCCCCCCCCCCCCCCCCCCC'
const extendedTrackId = 'DDDDDDDDDDDDDDDDDDDDDD'
const extendedAlbum = {
  ...spotifyAlbumFixture(),
  id: extendedAlbumId,
  external_ids: { upc: '012345678918' },
  total_tracks: 2,
  tracks: {
    offset: 0,
    total: 2,
    next: null,
    items: [
      ...spotifyAlbumFixture().tracks.items,
      {
        id: extendedTrackId,
        name: 'Second',
        disc_number: 1,
        track_number: 2,
        duration_ms: 181000,
        artists: [{ name: 'Example Artist' }],
      },
    ],
  },
}
const extendedTrack = {
  id: extendedTrackId,
  name: 'Second',
  artists: [{ id: 'BBBBBBBBBBBBBBBBBBBBBB', name: 'Example Artist' }],
  duration_ms: 181000,
  type: 'track',
  album: extendedAlbum,
}
const catalogTrack = {
  id: spotifyTrackId,
  name: 'Opening',
  artists: [{ id: 'BBBBBBBBBBBBBBBBBBBBBB', name: 'Example Artist' }],
  duration_ms: 120500,
  type: 'track',
  album: spotifyAlbumFixture(),
}
const request = vi.fn(async (input: string | URL) => {
  const url = new URL(input)
  if (url.hostname === 'accounts.spotify.com')
    return Response.json(spotifyTokenFixture)
  if (url.pathname === `/v1/albums/${spotifyAlbumId}`)
    return Response.json(spotifyAlbumFixture())
  if (url.pathname === `/v1/albums/${extendedAlbumId}`)
    return Response.json(extendedAlbum)
  if (url.pathname === `/v1/tracks/${extendedTrackId}`)
    return Response.json(extendedTrack)
  if (
    url.pathname === '/v1/search' &&
    url.searchParams.get('type') === 'track'
  ) {
    expect(url.searchParams.get('market')).toBe('AU')
    expect(url.searchParams.get('limit')).toBe('10')
    const offset = Number(url.searchParams.get('offset'))
    return Response.json({
      tracks: {
        offset,
        total: 11,
        items:
          offset === 0
            ? [{ ...catalogTrack, id: shorterPageTrackId, is_local: true }]
            : [catalogTrack, catalogTrack],
      },
    })
  }
  if (url.pathname === `/v1/tracks/${spotifyTrackId}`)
    return Response.json(catalogTrack)
  if (url.pathname === `/v1/tracks/${shorterPageTrackId}`)
    return Response.json(catalogTrack)
  const filmId = /^\/3\/movie\/(\d+)$/.exec(url.pathname)?.[1]
  if (filmId)
    return Response.json({
      id: Number(filmId),
      title: 'Example Film',
      imdb_id: 'tt1234567',
      release_date: '2021-01-02',
      credits: { cast: [], crew: [] },
      keywords: { keywords: [] },
    })
  throw new Error('Unexpected mocked request')
})
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => plugins,
  getScrapePlugin: async (id: string) =>
    plugins.find((plugin) => plugin.manifest.id === id) ?? null,
  listProviderCatalog: async () =>
    plugins.map((plugin) => createCatalogEntryFromPlugin(plugin, null)),
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({
    clientId: 'test-client',
    clientSecret: 'test-secret',
    apiKey: 'test-key',
    market: 'AU',
  }),
}))
vi.mock('@/services/provider-requests', () => ({
  createProviderRequest: () => request,
  recordProviderFailure: async () => {},
  recordProviderSuccess: async () => {},
}))
import { addManualMedia, searchManualMedia } from '@/services/manual-add'
import { removeOrphanTracks } from '@/services/album-library-tracks'
import { refreshTrackAddedDates } from '@/services/spotify-playlists'
import { trackSourcesExpression } from '@/services/track-values'

let created = false
beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Live requests forbidden')
    }),
  )
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  await databaseClient.delete(schema.mediaItem)
  request.mockClear()
})
afterAll(async () => {
  expect(fetch).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
})

describe('manual additions through the canonical persistence path', () => {
  it('serializes concurrent album additions and retains original metadata on repeat', async () => {
    const results = await Promise.all([
      addManualMedia({ mediaType: 'album', externalId: spotifyAlbumId }),
      addManualMedia({ mediaType: 'album', externalId: spotifyAlbumId }),
    ])
    const first = results[0]
    if (!first) throw new Error('Missing add result')
    expect(results.map((result) => result.mediaItemId)).toEqual([
      first.mediaItemId,
      first.mediaItemId,
    ])
    expect(results.filter((result) => result.created)).toHaveLength(1)
    const items = await databaseClient.select().from(schema.mediaItem)
    expect(items.map((item) => item.mediaType).sort()).toEqual([
      'album',
      'track',
    ])
    const [storedAlbum] = await databaseClient.select().from(schema.album)
    expect(storedAlbum?.dateAdded).toBeInstanceOf(Date)
    const snapshots = await databaseClient
      .select()
      .from(schema.providerSnapshot)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.source).toBe('manual-add')
    const [albumEntry] = await databaseClient.select().from(schema.track)
    expect(albumEntry?.trackMediaItemId).toBe(
      items.find((item) => item.mediaType === 'track')?.id,
    )
    await databaseClient
      .update(schema.mediaItem)
      .set({ title: 'Corrected title' })
      .where(eq(schema.mediaItem.id, first.mediaItemId))
    request.mockClear()
    expect(
      await addManualMedia({ mediaType: 'album', externalId: spotifyAlbumId }),
    ).toEqual({ mediaItemId: first.mediaItemId, created: false })
    expect(request).not.toHaveBeenCalled()
    const [item] = await databaseClient
      .select()
      .from(schema.mediaItem)
      .where(eq(schema.mediaItem.id, first.mediaItemId))
    expect(item?.title).toBe('Corrected title')
    expect(await databaseClient.select().from(schema.providerSnapshot)).toEqual(
      snapshots,
    )
    expect(
      (await databaseClient.select().from(schema.album))[0]?.dateAdded,
    ).toEqual(storedAlbum?.dateAdded)
  })

  it('reconciles a film by its shared IMDb identifier and never overwrites existing state', async () => {
    const first = await addManualMedia({ mediaType: 'film', externalId: '701' })
    expect(first.created).toBe(true)
    await databaseClient
      .update(schema.mediaItem)
      .set({ title: 'Corrected title' })
      .where(eq(schema.mediaItem.id, first.mediaItemId))
    await databaseClient
      .update(schema.film)
      .set({ watched: true })
      .where(eq(schema.film.mediaItemId, first.mediaItemId))
    const beforeFilm = await databaseClient.select().from(schema.film)
    const snapshots = await databaseClient
      .select()
      .from(schema.providerSnapshot)
    expect(snapshots[0]?.source).toBe('manual-add')
    expect(
      await addManualMedia({ mediaType: 'film', externalId: '702' }),
    ).toEqual({ mediaItemId: first.mediaItemId, created: false })
    expect(await databaseClient.select().from(schema.mediaItem)).toHaveLength(1)
    expect(
      (await databaseClient.select().from(schema.mediaItem))[0]?.title,
    ).toBe('Corrected title')
    expect(await databaseClient.select().from(schema.film)).toEqual(beforeFilm)
    expect(await databaseClient.select().from(schema.providerSnapshot)).toEqual(
      snapshots,
    )
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(0)
  })
})

describe('manual Spotify tracks', () => {
  it('pages through catalog results and uses exact library IDs', async () => {
    const search = { mediaType: 'track', q: 'Opening' } satisfies Parameters<
      typeof searchManualMedia
    >[0]
    expect(await searchManualMedia(search)).toEqual({
      items: [],
      page: 1,
      hasMore: true,
    })
    const expectedItem = {
      externalId: spotifyTrackId,
      title: 'Opening',
      subtitle: 'Example Artist · Example Album',
      releaseDate: '2020-05',
      artworkUrl: 'https://i.scdn.co/image/example',
      url: `https://open.spotify.com/track/${spotifyTrackId}`,
      mediaItemId: null,
    }
    expect(await searchManualMedia({ ...search, page: 2 })).toEqual({
      items: [expectedItem],
      page: 2,
      hasMore: false,
    })
    await addManualMedia({ mediaType: 'album', externalId: spotifyAlbumId })
    const [albumTrack] = await databaseClient.select().from(schema.libraryTrack)
    expect(albumTrack?.spotifyTrackId).toBe(spotifyTrackId)
    expect((await searchManualMedia({ ...search, page: 2 })).items).toEqual([
      { ...expectedItem, mediaItemId: albumTrack?.mediaItemId },
    ])
    request.mockClear()
    expect(
      await addManualMedia({ mediaType: 'track', externalId: spotifyTrackId }),
    ).toEqual({ mediaItemId: albumTrack?.mediaItemId, created: false })
    expect(request).not.toHaveBeenCalled()
  })

  it('stores one track under concurrent adds and preserves it during membership cleanup', async () => {
    const input = {
      mediaType: 'track',
      externalId: spotifyTrackId,
    } satisfies Parameters<typeof addManualMedia>[0]
    const outcomes = await Promise.all([
      addManualMedia(input),
      addManualMedia(input),
    ])
    const [first] = outcomes
    if (!first) throw new Error('Missing track outcome')
    expect(outcomes.filter((result) => result.created)).toHaveLength(1)
    expect(
      outcomes.every((result) => result.mediaItemId === first.mediaItemId),
    ).toBe(true)
    const [stored] = await databaseClient.select().from(schema.libraryTrack)
    expect(stored).toMatchObject({
      mediaItemId: first.mediaItemId,
      spotifyTrackId,
      spotifyAlbumId,
      albumName: 'Example Album',
      durationSec: 121,
      dateAdded: expect.any(Date),
    })
    expect(await databaseClient.select().from(schema.mediaCredit)).toHaveLength(
      1,
    )
    expect(await databaseClient.select().from(schema.album)).toHaveLength(0)
    expect(
      await databaseClient.select().from(schema.playlistItem),
    ).toHaveLength(0)
    const [item] = await databaseClient
      .select({
        title: schema.mediaItem.title,
        releaseDate: schema.mediaItem.releaseDate,
        sources: trackSourcesExpression(
          sql`media_item.id`,
          sql`media_item.metadata`,
        ),
      })
      .from(schema.mediaItem)
    expect(item).toMatchObject({
      title: 'Opening',
      releaseDate: new Date('2020-05-01'),
      sources: ['spotify-search'],
    })
    const removeAndRefresh = () =>
      databaseClient.transaction(async (tx) => {
        await removeOrphanTracks(tx)
        await refreshTrackAddedDates(tx)
      })
    const playlistId = 'example-playlist'
    await databaseClient.insert(schema.playlist).values({
      id: playlistId,
      kind: 'playlist',
      source: 'spotify',
      name: 'Example playlist',
    })
    const playlistDate = new Date('2021-01-01')
    await databaseClient.insert(schema.playlistItem).values({
      playlistId,
      mediaItemId: first.mediaItemId,
      position: 1,
      addedAt: playlistDate,
    })
    await removeAndRefresh()
    expect(
      (await databaseClient.select().from(schema.libraryTrack))[0]?.dateAdded,
    ).toEqual(playlistDate)
    await databaseClient.delete(schema.playlist)
    await removeAndRefresh()
    expect(await databaseClient.select().from(schema.libraryTrack)).toEqual([
      stored,
    ])
    request.mockClear()
    expect(await addManualMedia(input)).toEqual({
      mediaItemId: first.mediaItemId,
      created: false,
    })
    expect(request).not.toHaveBeenCalled()
    await databaseClient
      .update(schema.mediaItem)
      .set({
        metadata: { legacyHidden: true },
      })
      .where(eq(schema.mediaItem.id, first.mediaItemId))
    await expect(addManualMedia(input)).rejects.toMatchObject({
      response: { statusCode: 409 },
    })
    expect(request).not.toHaveBeenCalled()
  })

  it.each([null, new Date('2021-01-01')])(
    'reuses an unambiguous recording on the corresponding library album with added date %s',
    async (previousDate) => {
      await addManualMedia({ mediaType: 'album', externalId: spotifyAlbumId })
      const [albumTrack] = await databaseClient
        .select()
        .from(schema.libraryTrack)
      if (!albumTrack) throw new Error('Missing album track')
      await databaseClient
        .update(schema.libraryTrack)
        .set({
          spotifyTrackId: null,
          spotifyUrl: null,
          dateAdded: previousDate,
        })
        .where(eq(schema.libraryTrack.mediaItemId, albumTrack.mediaItemId))
      const beforeCredits = await databaseClient
        .select()
        .from(schema.mediaCredit)
      expect(
        await addManualMedia({
          mediaType: 'track',
          externalId: spotifyTrackId,
        }),
      ).toEqual({
        mediaItemId: albumTrack.mediaItemId,
        created: false,
      })
      const tracks = await databaseClient.select().from(schema.libraryTrack)
      expect(tracks).toHaveLength(1)
      expect(tracks[0]).toMatchObject({
        mediaItemId: albumTrack.mediaItemId,
        spotifyTrackId,
        dateAdded: previousDate ?? expect.any(Date),
      })
      const [recording] = await databaseClient
        .select()
        .from(schema.mediaItem)
        .where(eq(schema.mediaItem.id, albumTrack.mediaItemId))
      expect(recording?.releaseDate).toEqual(new Date('2020-05-01'))
      expect(await databaseClient.select().from(schema.mediaCredit)).toEqual(
        beforeCredits,
      )
      expect(
        (await databaseClient.select().from(schema.track))[0]?.trackMediaItemId,
      ).toBe(albumTrack.mediaItemId)
    },
  )

  it('links an imported track to its Spotify album when the album is added', async () => {
    const added = await addManualMedia({
      mediaType: 'track',
      externalId: spotifyTrackId,
    })
    const [before] = await databaseClient.select().from(schema.libraryTrack)
    expect(before).toMatchObject({
      mediaItemId: added.mediaItemId,
      spotifyAlbumId,
      albumMediaItemId: null,
    })
    const albumAdded = await addManualMedia({
      mediaType: 'album',
      externalId: spotifyAlbumId,
    })
    expect(albumAdded.created).toBe(true)
    const tracks = await databaseClient.select().from(schema.libraryTrack)
    expect(tracks).toHaveLength(1)
    expect(tracks[0]).toMatchObject({
      mediaItemId: added.mediaItemId,
      albumMediaItemId: albumAdded.mediaItemId,
      albumLinkStrategy: 'album-track-list',
    })
    expect(
      (await databaseClient.select().from(schema.track)).map((row) => ({
        album: row.albumMediaItemId,
        track: row.trackMediaItemId,
      })),
    ).toEqual([{ album: albumAdded.mediaItemId, track: added.mediaItemId }])
  })

  it('adds a release as its own album when the library has another release of the same name', async () => {
    const single = await addManualMedia({
      mediaType: 'album',
      externalId: spotifyAlbumId,
    })
    const added = await addManualMedia({
      mediaType: 'track',
      externalId: extendedTrackId,
    })
    expect(
      (await databaseClient.select().from(schema.libraryTrack)).find(
        (row) => row.mediaItemId === added.mediaItemId,
      ),
    ).toMatchObject({
      spotifyAlbumId: extendedAlbumId,
      albumName: 'Example Album',
      albumMediaItemId: null,
    })
    const extended = await addManualMedia({
      mediaType: 'album',
      externalId: extendedAlbumId,
    })
    expect(extended.created).toBe(true)
    expect(extended.mediaItemId).not.toBe(single.mediaItemId)
    expect(
      (await databaseClient.select().from(schema.libraryTrack)).find(
        (row) => row.mediaItemId === added.mediaItemId,
      ),
    ).toMatchObject({
      albumMediaItemId: extended.mediaItemId,
      albumLinkStrategy: 'album-track-list',
    })
    const references = await databaseClient
      .select({
        album: schema.providerReference.mediaItemId,
        externalId: schema.providerReference.externalId,
      })
      .from(schema.providerReference)
      .where(eq(schema.providerReference.referenceType, 'album'))
    expect(
      references.sort((a, b) => a.externalId.localeCompare(b.externalId)),
    ).toEqual([
      { album: single.mediaItemId, externalId: spotifyAlbumId },
      { album: extended.mediaItemId, externalId: extendedAlbumId },
    ])
    request.mockClear()
    expect(
      await addManualMedia({ mediaType: 'album', externalId: extendedAlbumId }),
    ).toEqual({ mediaItemId: extended.mediaItemId, created: false })
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects a provider response with a different track ID', async () => {
    await expect(
      addManualMedia({
        mediaType: 'track',
        externalId: shorterPageTrackId,
      }),
    ).rejects.toMatchObject({ response: { statusCode: 422 } })
    expect(
      await databaseClient.select().from(schema.libraryTrack),
    ).toHaveLength(0)
  })
})
