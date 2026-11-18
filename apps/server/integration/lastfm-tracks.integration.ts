import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { eq, inArray } from 'drizzle-orm'
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
import { TrackQuerySchema, getTrackBrowseValues } from '@repo/schemas/tracks'
import { BrowseFacetQuerySchema } from '@repo/schemas/browse'
import {
  MatchDiagnosticsQuerySchema,
  TrackMatchDiagnosticsQuerySchema,
  trackMatchProviderLabels,
} from '@repo/schemas/match-diagnostics'
import { env } from '@/env'
import { albumNameKey } from '@/lib/album-import-candidates'
import { createStableId } from '@/lib/media-utils'
import * as schema from '@/schemas/db'

const database = `lastfm_tracks_${randomUUID().replaceAll('-', '')}`
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
  listLoadedScrapePlugins: async () => [],
}))

import { refreshTrackLinks } from '@/services/track-links'
import { replaceAlbumTracks } from '@/services/album-library-tracks'
import { mergeLastfmTrack } from '@/services/track-merges'
import {
  listTrackMatchDiagnostics,
  listTrackMatchDiagnosticsFacets,
} from '@/services/track-match-diagnostics'
import { getAlbumDetail } from '@/services/media'
import { queryBrowseCounts } from '@/services/browse'
import {
  getTrackDetail,
  listTrackBrowsePage,
  listTrackFilterOptions,
  listTracks,
  listTracksAtPositions,
  removeImportedPlaylist,
} from '@/services/tracks'

const LISTENER = 'fixture-listener'
const ARTIST = 'Example Artist'
const FIRST_LISTEN = '2020-02-01T12:00:00.000Z'
const LAST_LISTEN = '2024-03-02T13:00:00.000Z'
const spotifyId = (value: string) => value.padEnd(22, '0')
const query = (input: Record<string, unknown> = {}) =>
  TrackQuerySchema.parse({ sortBy: 'title', direction: 'asc', ...input })
const allTracks = async () => (await listTracks(query())).items
const lastfmSourceQuery = () =>
  query({
    filters: JSON.stringify([
      { field: 'source', value: 'Last.fm', mode: 'required' },
    ]),
  })

async function credit(mediaItemId: string, name = ARTIST) {
  const artistId = createStableId('artist', name.toLowerCase())
  await databaseClient
    .insert(schema.artist)
    .values({ id: artistId, name, sortName: name })
    .onConflictDoNothing()
  await databaseClient.insert(schema.mediaCredit).values({
    mediaItemId,
    artistId,
    role: 'artist',
  })
}

async function scrobble(
  title: string,
  options: {
    artist?: string
    album?: string
    albumId?: string
    at?: string
    username?: string
  } = {},
) {
  const artist = options.artist ?? ARTIST
  await databaseClient.insert(schema.lastfmScrobble).values({
    id: randomUUID(),
    username: options.username ?? LISTENER,
    artistName: artist,
    artistKey: albumNameKey(artist),
    trackName: title,
    trackKey: albumNameKey(title),
    albumName: options.album ?? null,
    albumKey: options.album ? albumNameKey(options.album) : null,
    albumMediaItemId: options.albumId ?? null,
    listenedAt: new Date(options.at ?? FIRST_LISTEN),
  })
}

async function spotifyTrack(
  id: string,
  title: string,
  options: { album?: string; artist?: string; albumId?: string } = {},
) {
  await databaseClient.insert(schema.mediaItem).values({
    id,
    slug: id,
    title,
    mediaType: 'track',
    sourceLabel: 'spotify',
  })
  await databaseClient.insert(schema.libraryTrack).values({
    mediaItemId: id,
    spotifyTrackId: spotifyId(id),
    spotifyUrl: `https://open.spotify.com/track/${spotifyId(id)}`,
    albumName: options.album ?? null,
    albumMediaItemId: options.albumId ?? null,
    durationSec: 180,
  })
  await credit(id, options.artist)
}

async function playlist(
  id: string,
  trackIds: string[],
  source: 'spotify' | 'spotify-liked' = 'spotify',
  addedAt = '2023-01-01T00:00:00.000Z',
) {
  await databaseClient.insert(schema.playlist).values({
    id,
    name: id,
    kind: 'playlist',
    source,
    spotifyId: source === 'spotify' ? spotifyId(id) : null,
  })
  if (trackIds.length)
    await databaseClient.insert(schema.playlistItem).values(
      trackIds.map((mediaItemId, position) => ({
        playlistId: id,
        mediaItemId,
        position,
        addedAt: new Date(addedAt),
      })),
    )
}

async function album(
  id: string,
  title: string,
  tracks: Array<{ title: string; spotifyId?: string; durationSec?: number }>,
) {
  await databaseClient.insert(schema.mediaItem).values({
    id,
    slug: id,
    title,
    mediaType: 'album',
    artworkUrl: 'https://example.com/album-artwork.jpg',
    releaseDate: new Date('2019-04-05T00:00:00.000Z'),
  })
  await databaseClient.insert(schema.album).values({
    mediaItemId: id,
    spotifyUrl: `https://open.spotify.com/album/${spotifyId(id)}`,
  })
  await credit(id)
  await databaseClient.transaction((tx) =>
    replaceAlbumTracks(
      tx,
      id,
      tracks.map((track, index) => ({
        title: track.title,
        externalId: track.spotifyId,
        durationSec: track.durationSec,
        position: index + 1,
      })),
    ),
  )
  const tagId = 'electronic-fixture-tag'
  await databaseClient
    .insert(schema.tag)
    .values({
      id: tagId,
      name: 'Electronic',
      mediaType: 'album',
    })
    .onConflictDoNothing()
  await databaseClient.insert(schema.mediaItemTag).values({
    mediaItemId: id,
    tagId,
  })
}

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  request.mockReset()
  request.mockImplementation(async () => {
    throw new Error('Unexpected provider request during stored-track import')
  })
  await databaseClient.delete(schema.lastfmScrobble)
  await databaseClient.delete(schema.playlist)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.artist)
  await databaseClient.delete(schema.tag)
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('Last.fm tracks library', () => {
  it('filters and counts track matches across Browse fields, provider evidence and retained Last.fm rows', async () => {
    await spotifyTrack('imported-recording', 'Shared Song', {
      album: 'Playlist Edition',
    })
    await spotifyTrack('variant-recording', 'Shared Song', {
      album: 'Other Edition',
    })
    await playlist('saved-recordings', ['imported-recording'])
    await playlist('other-recordings', ['variant-recording'])
    await album('catalogue-release', 'Original Release', [
      { title: 'Context only', durationSec: 121 },
      { title: 'No source', durationSec: 245 },
      { title: 'Zed no source', durationSec: 56 },
    ])
    await scrobble('SHARED SONG')
    await refreshTrackLinks(LISTENER)
    await databaseClient.insert(schema.providerCurrentState).values({
      id: 'discogs-track-evidence',
      mediaItemId: 'catalogue-release',
      provider: 'discogs',
      status: 'ready',
      checksum: 'fixture',
      payload: {
        release: {
          tracklist: [
            {
              title: 'Context only',
              type_: 'track',
              artists: [{ name: 'Guest%Producer' }],
            },
          ],
        },
      },
    })
    const inspect = (input: Record<string, unknown> = {}) =>
      listTrackMatchDiagnostics(TrackMatchDiagnosticsQuerySchema.parse(input))
    const match = (
      value: string,
      mode: 'required' | 'exclude' = 'required',
    ) => ({ field: 'matchProvider', value, mode })
    const titles = (page: Awaited<ReturnType<typeof inspect>>) =>
      page.items.map((item) => item.name)

    const { noRecording, noEvidence, spotify, lastfm, discogs } =
      trackMatchProviderLabels
    const all = await inspect()
    expect(all.totalCount).toBe(6)
    const standalone = all.items.find((item) => item.id === item.mergeSourceId)
    if (!standalone) throw new Error('Expected a standalone Last.fm row')
    expect((await allTracks()).map((item) => item.id)).not.toContain(
      standalone.id,
    )
    expect(standalone.track?.sources).toContain('lastfm')

    const withoutRecording = { filters: JSON.stringify([match(noRecording)]) }
    expect(titles(await inspect(withoutRecording))).toEqual([
      'Context only',
      'No source',
      'Zed no source',
    ])
    const withoutEvidence = { filters: JSON.stringify([match(noEvidence)]) }
    expect(titles(await inspect(withoutEvidence))).toEqual([
      'No source',
      'Zed no source',
    ])
    expect(
      await inspect({ ...withoutEvidence, size: 1, page: 2 }),
    ).toMatchObject({
      totalCount: 2,
      pageCount: 2,
      items: [{ name: 'Zed no source', matches: [] }],
    })
    expect(titles(await inspect({ size: 3, page: 2 }))).toEqual([
      'SHARED SONG',
      'Shared Song',
      'Zed no source',
    ])
    expect(
      titles(await inspect({ filters: JSON.stringify([match(discogs)]) })),
    ).toEqual(['Context only'])
    expect(
      titles(
        await inspect({
          filters: JSON.stringify([match(spotify, 'exclude'), match(lastfm)]),
        }),
      ),
    ).toEqual(['SHARED SONG'])
    expect(
      (
        await inspect({
          filters: JSON.stringify([
            { field: 'lastfmName', value: 'shared song' },
          ]),
        })
      ).items
        .map((item) => item.id)
        .sort(),
    ).toEqual([standalone.id, 'imported-recording', 'variant-recording'].sort())
    expect(
      titles(
        await inspect({
          filters: JSON.stringify([
            { field: 'spotifyName', value: 'Shared Song' },
            { field: 'title', value: 'No source' },
          ]),
        }),
      ),
    ).toEqual(['No source', 'Shared Song', 'Shared Song'])
    expect(
      await inspect({
        filters: JSON.stringify([
          {
            field: 'spotifyId',
            value: spotifyId('imported-recording'),
            mode: 'exclude',
          },
        ]),
        sortBy: 'spotifyId',
        size: 1,
      }),
    ).toMatchObject({
      totalCount: 5,
      items: [{ id: 'variant-recording' }],
    })
    const browseFilters = [
      { field: 'source', value: 'Album track list', mode: 'required' },
      { field: 'albumTag', value: 'Electronic', mode: 'required' },
    ]
    const browseRanges = [{ field: 'durationSec', min: 121 }]
    const sorted = {
      filters: JSON.stringify(browseFilters),
      ranges: JSON.stringify(browseRanges),
      sortBy: 'durationSec',
      direction: 'desc',
    }
    expect((await inspect(sorted)).items.map((item) => item.id)).toEqual(
      (await listTracks(query(sorted))).items.map((item) => item.id),
    )
    expect(await inspect({ ...sorted, page: 2, size: 1 })).toMatchObject({
      totalCount: 2,
      pageCount: 2,
      items: [{ name: 'Context only', track: { durationSec: 121 } }],
    })
    expect(
      await inspect({ ...sorted, page: 2, size: 1, limitResults: 1 }),
    ).toMatchObject({ totalCount: 1, pageCount: 1, items: [] })
    expect(
      await inspect({
        creatorId: createStableId('artist', ARTIST.toLowerCase()),
      }),
    ).toMatchObject({ totalCount: 6 })
    expect(titles(await inspect({ q: 'Electronic Guest%Producer' }))).toEqual([
      'Context only',
    ])
    expect(titles(await inspect({ q: 'Electronic Guest_Producer' }))).toEqual(
      [],
    )
    const mbid = '11111111-1111-4111-8111-111111111111'
    await databaseClient.update(schema.lastfmScrobble).set({ trackMbid: mbid })
    expect(titles(await inspect({ q: `saved-recordings ${mbid}` }))).toEqual([
      'Shared Song',
    ])

    const facets = await listTrackMatchDiagnosticsFacets(
      BrowseFacetQuerySchema.parse({}),
    )
    expect(facets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'title',
          value: 'SHARED SONG',
          count: 1,
        }),
        expect.objectContaining({
          field: 'lastfmName',
          value: 'SHARED SONG',
          count: 3,
        }),
        expect.objectContaining({
          field: 'matchProvider',
          value: lastfm,
          count: 3,
        }),
        expect.objectContaining({
          field: 'matchProvider',
          value: noRecording,
          count: 3,
        }),
        expect.objectContaining({
          field: 'matchProvider',
          value: noEvidence,
          count: 2,
        }),
      ]),
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('compares imported, scrobbled and album-position names and keeps separate sources available to merge', async () => {
    await spotifyTrack('imported-recording', 'Studio Song', {
      album: 'Other Edition',
    })
    await playlist('saved-recordings', ['imported-recording'])
    await album('catalogue-release', 'Original Release', [
      { title: 'Studio Song', spotifyId: spotifyId('albumrecording') },
    ])
    await scrobble('STUDIO SONG')
    await refreshTrackLinks(LISTENER)
    await databaseClient.insert(schema.providerCurrentState).values({
      id: 'discogs-track-evidence',
      mediaItemId: 'catalogue-release',
      provider: 'discogs',
      status: 'ready',
      checksum: 'fixture',
      payload: {
        release: {
          tracklist: [
            { title: 'Disc one', type_: 'heading' },
            {
              title: 'Catalogue spelling',
              type_: 'track',
              artists: [{ name: 'Credited guest' }],
            },
          ],
        },
      },
    })

    const inspect = (input: Record<string, unknown> = {}) =>
      listTrackMatchDiagnostics(MatchDiagnosticsQuerySchema.parse(input))
    const page = await inspect()
    expect(page.totalCount).toBe(3)
    const standalone = page.items.find((item) => item.id === item.mergeSourceId)
    if (!standalone) throw new Error('Expected a separate scrobble source')
    const imported = page.items.find((item) => item.id === 'imported-recording')
    expect(imported).toMatchObject({
      name: 'Studio Song',
      creator: ARTIST,
      albumName: 'Other Edition',
      mergeSourceId: standalone.id,
    })
    expect(
      (await inspect({ q: 'Other Edition', sortBy: 'album' })).items.map(
        (item) => item.id,
      ),
    ).toEqual(['imported-recording'])
    expect(imported?.matches).toEqual(
      expect.arrayContaining([
        {
          provider: 'lastfm',
          name: 'STUDIO SONG',
          creator: ARTIST,
          identifier: null,
          artistKey: albumNameKey(ARTIST),
          trackKey: albumNameKey('STUDIO SONG'),
        },
        {
          provider: 'spotify',
          name: 'Studio Song',
          creator: ARTIST,
          identifier: spotifyId('imported-recording'),
        },
      ]),
    )
    const searched = await inspect({ q: 'catalogue guest', size: 1 })
    expect(searched).toMatchObject({
      totalCount: 1,
      items: [
        {
          matches: expect.arrayContaining([
            {
              provider: 'discogs',
              name: 'Catalogue spelling',
              creator: 'Credited guest',
              identifier: null,
              albumId: 'catalogue-release',
            },
            {
              provider: 'spotify',
              name: null,
              creator: null,
              identifier: spotifyId('albumrecording'),
            },
          ]),
        },
      ],
    })
    expect((await inspect({ sortBy: 'discogs', size: 1 })).items[0]?.id).toBe(
      searched.items[0]?.id,
    )
    expect(
      await inspect({ q: 'catalogue guest', size: 1, page: 2 }),
    ).toMatchObject({ totalCount: 1, items: [] })
    expect((await inspect({ q: '%' })).totalCount).toBe(0)
    expect(request).not.toHaveBeenCalled()
  })

  it('reads the last stored Spotify track list after a partial album import', async () => {
    const mediaItemId = 'partial-release'
    const externalId = spotifyId('savedposition')
    await album(mediaItemId, 'Partial Release', [
      { title: 'Library title', spotifyId: externalId },
    ])
    const evidence = {
      mediaItemId,
      provider: 'spotify',
      payload: {},
      checksum: 'fixture',
    }
    await databaseClient.insert(schema.providerSnapshot).values({
      ...evidence,
      id: 'full-spotify',
      source: 'scrape',
      normalizedData: {
        tracks: [
          { externalId, title: 'Provider title', artists: ['Provider credit'] },
        ],
      },
    })
    await databaseClient.insert(schema.providerCurrentState).values({
      ...evidence,
      id: 'partial-spotify',
      status: 'ready',
      normalizedData: { tracks: [] },
    })
    const compare = () =>
      listTrackMatchDiagnostics(
        MatchDiagnosticsQuerySchema.parse({ sortBy: 'spotify' }),
      )
    expect((await compare()).items[0]?.matches).toEqual([
      {
        provider: 'spotify',
        name: 'Provider title',
        creator: 'Provider credit',
        identifier: externalId,
      },
    ])
    await databaseClient
      .update(schema.providerCurrentState)
      .set({
        normalizedData: {
          tracks: [
            { externalId: spotifyId('different'), title: 'Other title' },
          ],
        },
      })
      .where(eq(schema.providerCurrentState.id, 'partial-spotify'))
    expect((await compare()).items[0]?.matches).toEqual([
      {
        provider: 'spotify',
        name: null,
        creator: null,
        identifier: externalId,
      },
    ])
  })

  it('imports stored names once with listening history and no invented metadata', async () => {
    await scrobble('Uncatalogued Song', { album: 'Uncatalogued Album' })
    await scrobble('Uncatalogued Song', {
      album: 'Uncatalogued Album',
      at: LAST_LISTEN,
    })
    await scrobble('Uncatalogued Song', { username: 'other-fixture-listener' })

    await refreshTrackLinks(LISTENER)
    const items = await allTracks()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      title: 'Uncatalogued Song',
      artists: [ARTIST],
      albumName: 'Uncatalogued Album',
      album: null,
      artworkUrl: null,
      releaseDate: null,
      durationSec: null,
      spotifyTrackId: null,
      spotifyMatch: 'unmatched',
      spotifyUrl: null,
      isrc: null,
      albumTags: [],
      playlists: [],
      sources: ['lastfm'],
      scrobbles: 2,
      dateAdded: FIRST_LISTEN,
      lastListenedAt: LAST_LISTEN,
    })
    expect((await getTrackDetail(items[0]?.id ?? ''))?.listening).toMatchObject(
      {
        total: 2,
        firstListenedAt: FIRST_LISTEN,
        lastListenedAt: LAST_LISTEN,
        months: [
          { month: '2020-02', count: 1 },
          { month: '2024-03', count: 1 },
        ],
      },
    )
    expect((await getTrackDetail(items[0]?.id ?? ''))?.lastfmSources).toEqual([
      {
        artistName: ARTIST,
        trackName: 'Uncatalogued Song',
        albumNames: ['Uncatalogued Album'],
        count: 2,
        manuallyMatched: false,
      },
    ])
    await refreshTrackLinks(LISTENER)
    expect(await allTracks()).toEqual(items)
    expect(request).not.toHaveBeenCalled()
  })

  it('groups case and spacing variants without collapsing live or remix titles', async () => {
    await scrobble('Opening')
    await scrobble(' OPENING ', {
      artist: ' example   artist ',
      at: LAST_LISTEN,
    })
    await scrobble('Opening (Live)')
    await scrobble('Opening (Club Remix)')
    await refreshTrackLinks(LISTENER)
    const items = await allTracks()
    expect(items).toHaveLength(3)
    expect(items.map((item) => item.scrobbles).sort()).toEqual([1, 1, 2])
    expect(items.every((item) => item.spotifyTrackId === null)).toBe(true)
  })

  it('credits an existing legacy artist whose ID differs from the stable import ID', async () => {
    await databaseClient.insert(schema.artist).values({
      id: 'legacy-artist-fixture',
      name: ARTIST,
    })
    await scrobble('Legacy Artist Song')
    await refreshTrackLinks(LISTENER)

    const items = await allTracks()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      title: 'Legacy Artist Song',
      artists: [ARTIST],
      scrobbles: 1,
    })
    const credits = await databaseClient
      .select({ artistId: schema.mediaCredit.artistId })
      .from(schema.mediaCredit)
      .where(eq(schema.mediaCredit.mediaItemId, items[0]?.id ?? ''))
    expect(credits).toEqual([{ artistId: 'legacy-artist-fixture' }])
  })

  it('shares an unambiguous Spotify track across Last.fm, playlists and Liked Songs', async () => {
    await spotifyTrack('shared', 'Shared Song', { album: 'Shared Album' })
    await playlist('playlist-one', ['shared'])
    await playlist('liked', ['shared'], 'spotify-liked')
    await scrobble('Shared Song', { album: 'Shared Album' })
    await refreshTrackLinks(LISTENER)
    const items = await allTracks()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'shared',
      spotifyTrackId: spotifyId('shared'),
      spotifyMatch: 'spotify-import',
      dateAdded: FIRST_LISTEN,
      scrobbles: 1,
    })
    expect([...(items[0]?.sources ?? [])].sort()).toEqual([
      'lastfm',
      'spotify',
      'spotify-liked',
    ])
  })

  it('keeps ambiguous Spotify editions and different albums separate', async () => {
    await spotifyTrack('editiona', 'Ambiguous Song', { album: 'Shared Album' })
    await spotifyTrack('editionb', 'Ambiguous Song', { album: 'Shared Album' })
    await spotifyTrack('elsewhere', 'Different Song', { album: 'Other Album' })
    await playlist('editions', ['editiona', 'editionb', 'elsewhere'])
    await scrobble('Ambiguous Song', { album: 'Shared Album' })
    await scrobble('Different Song', { album: 'Scrobbled Album' })
    await refreshTrackLinks(LISTENER)
    const items = await allTracks()
    expect(items).toHaveLength(5)
    const unmatched = items.filter((item) => item.spotifyTrackId === null)
    expect(unmatched.map((item) => item.title)).toEqual([
      'Ambiguous Song',
      'Different Song',
    ])
    expect(unmatched.every((item) => item.scrobbles === 1)).toBe(true)
    const edition = await getTrackDetail('editiona')
    expect(edition?.listening.total).toBe(1)
    expect(edition?.lastfmSources).toEqual([])
    const standalone = unmatched.find((item) => item.title === 'Ambiguous Song')
    expect((await getTrackDetail(standalone?.id ?? ''))?.lastfmSources).toEqual(
      [
        {
          artistName: ARTIST,
          trackName: 'Ambiguous Song',
          albumNames: ['Shared Album'],
          count: 1,
          manuallyMatched: false,
        },
      ],
    )
  })

  it('hides an albumless listening-only row once its exact history appears on a release', async () => {
    const title = 'Shared Single'
    await scrobble(title)
    await refreshTrackLinks(LISTENER)
    const [original] = await allTracks()
    if (!original) throw new Error('Expected the original Last.fm track')
    await album('fixture-ep', 'First EP', [
      { title, spotifyId: spotifyId('eprecording') },
    ])
    await album('fixture-lp', 'Second Album', [
      { title, spotifyId: spotifyId('lprecording') },
    ])
    await refreshTrackLinks(LISTENER)

    const browse = await listTracks(query({ sortBy: 'artist' }))
    expect(browse.items.map((item) => item.album?.id)).toEqual([
      'fixture-ep',
      'fixture-lp',
    ])
    expect(browse.items.map((item) => item.scrobbles)).toEqual([1, 1])
    expect(await queryBrowseCounts('track', query())).toEqual({
      totalCount: 2,
      unfilteredCount: 2,
    })
    const secondPage = await listTrackBrowsePage(query({ page: 2, size: 1 }))
    expect(secondPage).toMatchObject({
      items: [{ id: browse.items[1]?.id }],
      hasMore: false,
    })
    const positions = await listTracksAtPositions({
      ...query(),
      positions: [0, 1, 2],
    })
    expect(positions.items.map((row) => row.item.id)).toEqual(
      browse.items.map((item) => item.id),
    )
    const facets = await listTrackFilterOptions({ q: title })
    expect(facets).toContainEqual(
      expect.objectContaining({ field: 'title', value: title, count: 2 }),
    )
    const source = await listTracks(lastfmSourceQuery())
    expect(source.items.map((item) => item.id)).toEqual([original.id])
    expect(await queryBrowseCounts('track', lastfmSourceQuery())).toEqual({
      totalCount: 1,
      unfilteredCount: 3,
    })
    expect(await listTrackFilterOptions({ q: 'source' })).toContainEqual(
      expect.objectContaining({ field: 'source', value: 'Last.fm', count: 1 }),
    )
    expect((await getTrackDetail(original.id))?.listening.total).toBe(1)

    await playlist('placeholder-membership', [original.id])
    expect((await allTracks()).map((item) => item.id)).toContain(original.id)
    await removeImportedPlaylist('placeholder-membership')
    expect((await allTracks()).map((item) => item.id)).not.toContain(
      original.id,
    )

    await databaseClient
      .update(schema.mediaItem)
      .set({ metadata: { legacyHidden: true } })
      .where(
        inArray(
          schema.mediaItem.id,
          browse.items.map((item) => item.id),
        ),
      )
    expect((await allTracks()).map((item) => item.id)).toEqual([original.id])
  })

  it('keeps an albumless source when only a broader listening match shares its scrobbles', async () => {
    await album('fixture-remaster', 'Remastered Album', [
      { title: 'Opening (Remastered)', spotifyId: spotifyId('remastered') },
    ])
    await scrobble('Opening')
    await refreshTrackLinks(LISTENER)
    expect(
      (await allTracks()).map((item) => [item.title, item.scrobbles]),
    ).toEqual([
      ['Opening', 1],
      ['Opening (Remastered)', 1],
    ])
  })

  it('keeps mixed linked and unlinked album evidence separate from a Spotify edition', async () => {
    await album('linkededition', 'Linked Edition', [
      { title: 'Mixed Song', spotifyId: spotifyId('mixedrecording') },
    ])
    await spotifyTrack('mixedspotify', 'Mixed Song', {
      album: 'Linked Edition',
      albumId: 'linkededition',
    })
    await playlist('mixed-edition-playlist', ['mixedspotify'])
    await scrobble('Mixed Song', {
      album: 'Linked Edition',
      albumId: 'linkededition',
    })
    await scrobble('Mixed Song', {
      album: 'Unlinked Edition',
      at: LAST_LISTEN,
    })
    await refreshTrackLinks(LISTENER)

    const items = await allTracks()
    expect(items).toHaveLength(2)
    expect(items.find((item) => item.sources.includes('album'))).toMatchObject({
      title: 'Mixed Song',
      spotifyTrackId: spotifyId('mixedrecording'),
    })
    expect(items.find((item) => item.id === 'mixedspotify')?.sources).toEqual([
      'spotify',
    ])
    const [standalone] = (await listTracks(lastfmSourceQuery())).items
    expect(standalone).toMatchObject({
      title: 'Mixed Song',
      sources: ['lastfm'],
      albumName: null,
      album: null,
      artworkUrl: null,
      spotifyTrackId: null,
      spotifyUrl: null,
      durationSec: null,
      scrobbles: 2,
    })
  })

  it('reconciles a later Spotify import without leaving a duplicate Last.fm row', async () => {
    await scrobble('Later Song', { album: 'Later Album' })
    await refreshTrackLinks(LISTENER)
    const original = await allTracks()
    expect(original).toHaveLength(1)
    expect(original[0]?.spotifyTrackId).toBeNull()

    await spotifyTrack('later', 'Later Song', { album: 'Later Album' })
    await playlist('later-playlist', ['later'])
    await refreshTrackLinks(LISTENER)
    const reconciled = await allTracks()
    expect(reconciled).toHaveLength(1)
    expect(reconciled[0]).toMatchObject({
      id: 'later',
      sources: ['lastfm', 'spotify'],
      scrobbles: 1,
      dateAdded: FIRST_LISTEN,
    })
    expect((await getTrackDetail('later'))?.listening.total).toBe(1)
    await refreshTrackLinks(LISTENER)
    expect(await allTracks()).toEqual(reconciled)
  })

  it('inherits linked album metadata and a unique stored Spotify track identity', async () => {
    await album('linkedalbum', 'Linked Album', [
      { title: 'Known Song', spotifyId: spotifyId('known'), durationSec: 205 },
    ])
    await scrobble('Known Song', {
      album: 'Linked Album',
      albumId: 'linkedalbum',
    })
    await refreshTrackLinks(LISTENER)
    expect((await allTracks())[0]).toMatchObject({
      title: 'Known Song',
      sources: ['album', 'lastfm'],
      album: { id: 'linkedalbum', title: 'Linked Album' },
      albumTags: ['Electronic'],
      artworkUrl: 'https://example.com/album-artwork.jpg',
      releaseDate: '2019-04-05T00:00:00.000Z',
      spotifyTrackId: spotifyId('known'),
      spotifyMatch: 'album-track-list',
      spotifyUrl: `https://open.spotify.com/track/${spotifyId('known')}`,
      durationSec: 205,
      isrc: null,
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('does not infer playback from ambiguous album titles or a different recording version', async () => {
    await album('ambiguousalbum', 'Ambiguous Album', [
      { title: 'Repeated Song', spotifyId: spotifyId('first') },
      { title: 'Repeated Song', spotifyId: spotifyId('second') },
      { title: 'Versioned Song (Live)', spotifyId: spotifyId('live') },
    ])
    await scrobble('Repeated Song', {
      album: 'Ambiguous Album',
      albumId: 'ambiguousalbum',
    })
    await scrobble('Versioned Song', {
      album: 'Ambiguous Album',
      albumId: 'ambiguousalbum',
    })
    await refreshTrackLinks(LISTENER)
    const items = await allTracks()
    expect(items).toHaveLength(5)
    const lastfmTracks = items.filter((item) => item.sources.includes('lastfm'))
    expect(lastfmTracks.map((item) => item.title)).toEqual([
      'Repeated Song',
      'Versioned Song',
    ])
    expect(lastfmTracks.every((item) => item.spotifyTrackId === null)).toBe(
      true,
    )
    expect(lastfmTracks.every((item) => item.durationSec === null)).toBe(true)
  })

  it('reuses canonical tracks across album pages, source filters and list refreshes', async () => {
    await album('refresh-album', 'Refresh Album', [
      {
        title: 'Retained Recording',
        spotifyId: spotifyId('retained'),
        durationSec: 205,
      },
      { title: 'Removed Recording' },
    ])
    const initial = await getAlbumDetail('refresh-album')
    const [retained, removed] = initial?.tracks ?? []
    if (!retained || !removed)
      throw new Error('Expected initial album track fixtures')
    expect(retained).toMatchObject({
      position: 1,
      track: {
        title: 'Retained Recording',
        durationSec: 205,
        sources: ['album'],
      },
    })
    await playlist('retention-playlist', [removed.track.id])
    await databaseClient.transaction((tx) =>
      replaceAlbumTracks(tx, 'refresh-album', [
        { title: 'New Recording', position: 1 },
        {
          title: retained.track.title,
          externalId: spotifyId('retained'),
          durationSec: 210,
          position: 2,
        },
      ]),
    )
    const refreshed = await getAlbumDetail('refresh-album')
    expect(
      refreshed?.tracks.map(({ position, track }) => [position, track.title]),
    ).toEqual([
      [1, 'New Recording'],
      [2, 'Retained Recording'],
    ])
    expect(refreshed?.tracks[1]?.track).toMatchObject({
      id: retained.track.id,
      durationSec: 210,
    })
    const source = await listTracks(
      query({
        filters: JSON.stringify([
          { field: 'source', value: 'Album track list', mode: 'required' },
        ]),
      }),
    )
    expect(source.items.map((item) => item.title)).toEqual([
      'New Recording',
      'Retained Recording',
    ])
    expect((await getTrackDetail(removed.track.id))?.sources).toEqual([
      'spotify',
    ])
    await removeImportedPlaylist('retention-playlist')
    expect(await getTrackDetail(removed.track.id)).toBeNull()
    expect(await getTrackDetail(retained.track.id)).toMatchObject({
      sources: ['album'],
    })
  })

  it('attributes a scrobble to a shared recording through a secondary album', async () => {
    const spotifyTrackId = spotifyId('sharedrecording')
    const list = [{ title: 'Shared Recording', spotifyId: spotifyTrackId }]
    await album('primary-album', 'Primary Album', list)
    await album('secondary-album', 'Secondary Album', list)
    await scrobble('Shared Recording', {
      artist: 'Scrobbled Artist',
      album: 'Secondary Album',
      albumId: 'secondary-album',
    })

    await refreshTrackLinks(LISTENER)

    const items = await allTracks()
    expect(items.filter((track) => track.sources.includes('album'))).toEqual([
      expect.objectContaining({
        spotifyTrackId,
        album: { id: 'primary-album', title: 'Primary Album' },
        sources: ['album'],
        scrobbles: 1,
      }),
    ])
    expect(
      items.find((track) => track.sources.includes('lastfm'))?.spotifyTrackId,
    ).toBeNull()
  })

  it('ignores non-Spotify album track identifiers for playback', async () => {
    await album('otherprovider', 'Other Provider Album', [
      { title: 'Other Provider Song', spotifyId: 'fixture-musicbrainz-id' },
    ])
    await scrobble('Other Provider Song', {
      album: 'Other Provider Album',
      albumId: 'otherprovider',
    })
    await refreshTrackLinks(LISTENER)
    expect((await allTracks())[0]).toMatchObject({
      spotifyTrackId: null,
      spotifyMatch: 'unmatched',
      spotifyUrl: null,
      album: { id: 'otherprovider' },
    })
  })

  it('uses the effective Spotify identity for match filters, facets and pagination', async () => {
    await album('matchalbum', 'Match Album', [
      { title: 'Derived Song', spotifyId: spotifyId('derived') },
      { title: 'Imported Song', spotifyId: spotifyId('alternative') },
      { title: 'Ambiguous Song', spotifyId: spotifyId('first') },
      { title: 'Ambiguous Song', spotifyId: spotifyId('second') },
      { title: 'Invalid ID', spotifyId: 'invalid-provider-id' },
    ])
    await spotifyTrack('imported', 'Imported Song', { album: 'Match Album' })
    await playlist('match-playlist', ['imported'])
    for (const title of [
      'Derived Song',
      'Imported Song',
      'Ambiguous Song',
      'Invalid ID',
    ])
      await scrobble(title, { album: 'Match Album', albumId: 'matchalbum' })
    await scrobble('Unknown Song')
    await refreshTrackLinks(LISTENER)

    const items = await allTracks()
    expect(
      items
        .filter((item) => item.sources.includes('lastfm'))
        .map((item) => [item.title, item.spotifyMatch]),
    ).toEqual([
      ['Ambiguous Song', 'unmatched'],
      ['Derived Song', 'album-track-list'],
      ['Imported Song', 'unmatched'],
      ['Invalid ID', 'unmatched'],
      ['Unknown Song', 'unmatched'],
    ])
    expect(items.find((item) => item.id === 'imported')?.spotifyTrackId).toBe(
      spotifyId('imported'),
    )
    const derived = items.find((item) => item.title === 'Derived Song')
    expect(derived?.spotifyTrackId).toBe(spotifyId('derived'))
    if (!derived) throw new Error('Expected derived fixture track')
    expect(getTrackBrowseValues(derived).spotifyMatch).toBe('Album track list')

    const requiredSource = {
      field: 'source',
      value: 'Last.fm',
      mode: 'required',
    }
    const unmatched = await listTracks(
      query({
        size: 1,
        page: 2,
        filters: JSON.stringify([
          requiredSource,
          { field: 'spotifyMatch', value: 'Unmatched', mode: 'required' },
        ]),
      }),
    )
    expect(unmatched).toMatchObject({ totalCount: 4, pageCount: 4 })
    expect(unmatched.items.map((item) => item.title)).toEqual(['Imported Song'])
    const matched = await listTracks(
      query({
        size: 1,
        page: 1,
        filters: JSON.stringify([
          requiredSource,
          { field: 'spotifyMatch', value: 'Unmatched', mode: 'exclude' },
        ]),
      }),
    )
    expect(matched).toMatchObject({ totalCount: 1, pageCount: 1 })
    expect(matched.items.map((item) => item.id)).toEqual([derived.id])
    const albumMatches = await listTracks(
      query({
        filters: JSON.stringify([
          { field: 'spotifyMatch', value: 'Album track list', mode: 'any' },
        ]),
      }),
    )
    expect(albumMatches.totalCount).toBe(4)
    expect(albumMatches.items.map((item) => item.spotifyTrackId)).toEqual(
      expect.arrayContaining([
        spotifyId('first'),
        spotifyId('second'),
        spotifyId('derived'),
        spotifyId('alternative'),
      ]),
    )
    const facets = await listTrackFilterOptions({ q: 'Spotify match' })
    expect(
      facets
        .filter((facet) => facet.field === 'spotifyMatch')
        .map((facet) => [facet.value, facet.count]),
    ).toEqual([
      ['Album track list', 4],
      ['Unmatched', 4],
      ['Spotify import', 1],
    ])
  })

  it('preserves recorded Last.fm name variants without mixing in broader listening matches', async () => {
    await scrobble('Recorded Song', { album: 'Original Album' })
    await scrobble('Recorded Song', { album: 'Another Album', at: LAST_LISTEN })
    await scrobble(' RECORDED SONG ', { artist: ' example artist ' })
    await refreshTrackLinks(LISTENER)
    const [item] = await allTracks()
    const detail = await getTrackDetail(item?.id ?? '')
    expect(detail?.lastfmSources).toEqual([
      {
        artistName: ARTIST,
        trackName: 'Recorded Song',
        albumNames: ['Another Album', 'Original Album'],
        count: 2,
        manuallyMatched: false,
      },
      {
        artistName: ' example artist ',
        trackName: ' RECORDED SONG ',
        albumNames: [],
        count: 1,
        manuallyMatched: false,
      },
    ])
    expect(JSON.stringify(detail?.lastfmSources)).not.toContain(LISTENER)
    expect(request).not.toHaveBeenCalled()
  })

  it('offers additive source facets and filters sources in or out', async () => {
    await spotifyTrack('both', 'Both')
    await spotifyTrack('spotifyonly', 'Spotify Only')
    await playlist('mixed', ['both', 'spotifyonly'])
    await scrobble('Both')
    await scrobble('Last.fm Only')
    await refreshTrackLinks(LISTENER)
    const filter = (mode: 'required' | 'exclude', value: string) => ({
      field: 'source',
      mode,
      value,
    })
    const matchingTitles = async (filters: ReturnType<typeof filter>[]) =>
      (await listTracks(query({ filters: JSON.stringify(filters) }))).items.map(
        (item) => item.title,
      )
    expect(await matchingTitles([filter('required', 'Last.fm')])).toEqual([
      'Both',
      'Last.fm Only',
    ])
    expect(await matchingTitles([filter('exclude', 'Last.fm')])).toEqual([
      'Spotify Only',
    ])
    expect(
      await matchingTitles([
        filter('required', 'Last.fm'),
        filter('exclude', 'Spotify playlists'),
      ]),
    ).toEqual(['Last.fm Only'])
    const facets = await listTrackFilterOptions({ q: 'source' })
    expect(
      facets
        .filter((facet) => facet.field === 'source')
        .map((facet) => [facet.value, facet.count]),
    ).toEqual([
      ['Last.fm', 2],
      ['Spotify playlists', 2],
    ])
  })

  it('merges differing album evidence without double-counting history and preserves the manual choice', async () => {
    await spotifyTrack('merge-target', 'Shared Recording', {
      album: 'Spotify Album',
    })
    await playlist('original-playlist', ['merge-target'])
    await scrobble('Shared Recording', { album: 'Scrobbled Release' })
    await scrobble('Shared Recording', {
      album: 'Another Release',
      at: LAST_LISTEN,
    })
    await refreshTrackLinks(LISTENER)
    const before = await allTracks()
    expect(before).toHaveLength(1)
    const [source] = (await listTracks(lastfmSourceQuery())).items
    if (!source) throw new Error('Expected duplicate Last.fm fixture')
    expect(before.find((item) => item.id === 'merge-target')?.scrobbles).toBe(2)
    await playlist('source-playlist', [source.id])
    await databaseClient.insert(schema.playlistItem).values({
      playlistId: 'original-playlist',
      mediaItemId: source.id,
      position: 5,
      addedAt: new Date('2019-01-01T00:00:00.000Z'),
    })

    expect(
      await mergeLastfmTrack(source.id, { targetId: 'merge-target' }),
    ).toEqual({
      targetId: 'merge-target',
    })
    expect(await getTrackDetail(source.id)).toBeNull()
    const merged = await getTrackDetail('merge-target')
    expect(merged).toMatchObject({
      id: 'merge-target',
      title: 'Shared Recording',
      albumName: 'Spotify Album',
      spotifyTrackId: spotifyId('merge-target'),
      spotifyMatch: 'spotify-import',
      durationSec: 180,
      scrobbles: 2,
      dateAdded: '2019-01-01T00:00:00.000Z',
      listening: { total: 2, sources: [{ strategy: 'manual', count: 2 }] },
      lastfmSources: [
        {
          artistName: ARTIST,
          trackName: 'Shared Recording',
          albumNames: ['Another Release', 'Scrobbled Release'],
          count: 2,
          manuallyMatched: true,
        },
      ],
    })
    expect(merged?.playlists.map((item) => item.id)).toEqual([
      'original-playlist',
      'source-playlist',
    ])
    expect(
      await databaseClient
        .select({
          position: schema.playlistItem.position,
          addedAt: schema.playlistItem.addedAt,
        })
        .from(schema.playlistItem)
        .where(eq(schema.playlistItem.playlistId, 'original-playlist')),
    ).toEqual([{ position: 0, addedAt: new Date('2019-01-01T00:00:00.000Z') }])
    for (let pass = 0; pass < 2; pass++) await refreshTrackLinks(LISTENER)
    expect(await allTracks()).toHaveLength(1)
    expect(await getTrackDetail('merge-target')).toEqual(merged)
    expect(request).not.toHaveBeenCalled()
  })

  it('honors manual choices when recorded names differ and removes overlapping automatic attribution', async () => {
    await spotifyTrack('chosen', 'Chosen Recording', { album: 'Chosen Album' })
    await spotifyTrack('other-edition', 'Recorded Title', {
      album: 'Other Album',
    })
    await playlist('choices', ['chosen', 'other-edition'])
    await scrobble('Chosen Recording')
    await scrobble('Recorded Title', {
      album: 'Recorded Album',
      at: LAST_LISTEN,
    })
    await refreshTrackLinks(LISTENER)
    const source = (await allTracks()).find(
      (item) => item.spotifyMatch === 'unmatched',
    )
    if (!source) throw new Error('Expected unmatched recorded name')
    await Promise.all([
      refreshTrackLinks(LISTENER),
      mergeLastfmTrack(source.id, { targetId: 'chosen' }),
    ])
    await refreshTrackLinks(LISTENER)
    const items = await allTracks()
    expect(items).toHaveLength(2)
    expect(items.find((item) => item.id === 'chosen')?.scrobbles).toBe(2)
    expect(items.find((item) => item.id === 'other-edition')?.scrobbles).toBe(0)
    const detail = await getTrackDetail('chosen')
    expect(detail?.lastfmSources).toEqual([
      {
        artistName: ARTIST,
        trackName: 'Chosen Recording',
        albumNames: [],
        count: 1,
        manuallyMatched: false,
      },
      {
        artistName: ARTIST,
        trackName: 'Recorded Title',
        albumNames: ['Recorded Album'],
        count: 1,
        manuallyMatched: true,
      },
    ])
    expect(detail?.listening.total).toBe(2)
    expect(
      detail?.listening.sources.map((source) => source.strategy).sort(),
    ).toEqual(['exact', 'manual'])
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects invalid merge identities without changing stored memberships', async () => {
    await spotifyTrack('target', 'Target')
    await spotifyTrack('other-target', 'Other Target')
    await playlist('valid-targets', ['target', 'other-target'])
    await scrobble('Unmatched One')
    await scrobble('Unmatched Two')
    await refreshTrackLinks(LISTENER)
    const sources = (await allTracks()).filter(
      (item) => item.spotifyMatch === 'unmatched',
    )
    const source = sources[0]
    const other = sources[1]
    if (!source || !other) throw new Error('Expected unmatched fixtures')
    await databaseClient.insert(schema.mediaItem).values({
      id: 'no-source',
      slug: 'no-source',
      title: 'No Source',
      mediaType: 'track',
    })
    await databaseClient
      .insert(schema.libraryTrack)
      .values({ mediaItemId: 'no-source' })
    const before = await allTracks()
    const cases: Array<[string, string, number]> = [
      [source.id, source.id, 409],
      ['missing', 'target', 404],
      [source.id, 'missing', 404],
      [source.id, other.id, 409],
      ['target', 'other-target', 409],
      ['no-source', 'target', 409],
    ]
    for (const [sourceId, targetId, statusCode] of cases) {
      await expect(
        mergeLastfmTrack(sourceId, { targetId }),
      ).rejects.toMatchObject({
        response: { statusCode },
      })
    }
    expect(await allTracks()).toEqual(before)
    expect(request).not.toHaveBeenCalled()
  })

  it('retains Last.fm history when its last playlist is removed', async () => {
    await spotifyTrack('retained', 'Retained')
    await spotifyTrack('removed', 'Removed')
    await playlist('remove-me', ['retained', 'removed'])
    await scrobble('Retained')
    await refreshTrackLinks(LISTENER)
    expect(await removeImportedPlaylist('remove-me')).toEqual({
      removedTracks: 1,
    })
    const items = await allTracks()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'retained',
      sources: ['lastfm'],
      spotifyMatch: 'spotify-import',
      dateAdded: FIRST_LISTEN,
      scrobbles: 1,
      playlists: [],
    })
    await refreshTrackLinks(LISTENER)
    expect(await allTracks()).toEqual(items)
  })

  it('preserves another listener’s track summaries when refreshing an account', async () => {
    await scrobble('First Listener Song')
    await scrobble('First Listener Song', { at: LAST_LISTEN })
    await refreshTrackLinks(LISTENER)
    const firstTrack = (await allTracks())[0]
    expect(firstTrack?.scrobbles).toBe(2)

    await scrobble('Second Listener Song', {
      username: 'second-fixture-listener',
      at: LAST_LISTEN,
    })
    await refreshTrackLinks('second-fixture-listener')

    const items = await allTracks()
    expect(items).toHaveLength(2)
    const summary = items.find((item) => item.id === firstTrack?.id)
    const detail = await getTrackDetail(firstTrack?.id ?? '')
    expect(summary).toMatchObject({
      scrobbles: 2,
      lastListenedAt: LAST_LISTEN,
      dateAdded: FIRST_LISTEN,
    })
    expect(summary?.scrobbles).toBe(detail?.listening.total)
    expect(summary?.lastListenedAt).toBe(detail?.listening.lastListenedAt)
  })

  it('uses an earlier playlist date and updates metadata when its album is removed', async () => {
    await album('datedalbum', 'Dated Album', [{ title: 'Dated Song' }])
    await spotifyTrack('dated', 'Dated Song', { album: 'Dated Album' })
    await playlist(
      'old-playlist',
      ['dated'],
      'spotify',
      '2010-01-01T00:00:00.000Z',
    )
    await scrobble('Dated Song', {
      album: 'Dated Album',
      albumId: 'datedalbum',
    })
    await refreshTrackLinks(LISTENER)
    expect(
      (await allTracks()).find((item) => item.id === 'dated'),
    ).toMatchObject({
      album: { id: 'datedalbum' },
      dateAdded: '2010-01-01T00:00:00.000Z',
      albumTags: ['Electronic'],
    })
    await databaseClient
      .delete(schema.mediaItem)
      .where(eq(schema.mediaItem.id, 'datedalbum'))
    await refreshTrackLinks(LISTENER)
    expect(
      (await allTracks()).find((item) => item.id === 'dated'),
    ).toMatchObject({
      id: 'dated',
      album: null,
      albumTags: [],
      scrobbles: 1,
    })
  })
})
