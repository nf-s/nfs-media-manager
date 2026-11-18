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
import { reconcileLastfmAlbumTrackAliases } from '@/services/lastfm-library-tracks'
import { acceptSpotifyTrackSearch } from '@/services/spotify-track-search-acceptance'
import { SPOTIFY_TRACK_SEARCH_TASK } from '@repo/schemas/spotify-track-search'
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
const spotifyId = (value: string) =>
  value.replace(/[^A-Za-z0-9]/g, '').padEnd(22, '0')
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
  options: {
    album?: string
    artist?: string
    albumId?: string
    durationSec?: number
  } = {},
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
    durationSec: options.durationSec ?? 180,
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
async function savedSpotifyCandidate(
  trackId: string,
  title: string,
  recording: string,
  release = 'catalog-release',
) {
  const userId = 'catalog-fixture-owner'
  await databaseClient
    .insert(schema.user)
    .values({ id: userId, name: 'Test Owner', email: 'catalog@example.test' })
    .onConflictDoNothing()
  const jobId = randomUUID()
  const spotifyTrackId = spotifyId(recording)
  await databaseClient.insert(schema.scrapeJob).values({
    id: jobId,
    provider: 'spotify',
    status: 'succeeded',
    requestedByUserId: userId,
    scope: { mediaType: 'track', mediaItemIds: [trackId] },
    options: {
      task: SPOTIFY_TRACK_SEARCH_TASK,
      trackId,
      query: title,
      resultCount: 1,
    },
  })
  await databaseClient.insert(schema.scrapeJobLog).values({
    id: randomUUID(),
    jobId,
    level: 'info',
    message: 'Stored catalog fixture',
    metadata: {
      diagnostics: [
        {
          kind: SPOTIFY_TRACK_SEARCH_TASK,
          query: title,
          candidates: [
            {
              title,
              spotifyTrackId,
              artists: [ARTIST],
              spotifyAlbumId: spotifyId(release),
              albumName: 'Catalog Release',
              spotifyUrl: `https://open.spotify.com/track/${spotifyTrackId}`,
              isrc: null,
              durationSec: 186,
              artworkUrl: null,
            },
          ],
        },
      ],
    },
  })
  return { trackId, jobId, userId, spotifyTrackId }
}

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
  it('keeps an albumless scrobble as a playable catalog recording, then reuses it on a later release', async () => {
    await scrobble('02 - Test Recording')
    await scrobble('02 - Test Recording', { at: LAST_LISTEN })
    await refreshTrackLinks(LISTENER)
    const [source] = await allTracks()
    if (!source) throw new Error('Missing scrobble fixture')
    const selection = await listTrackMatchDiagnostics(
      {
        page: 1,
        size: 1,
        view: 'spotify-search-metadata',
        playability: 'unavailable',
        sortBy: 'listeningScrobbles',
        direction: 'desc',
        listeningSort: { kind: 'dates', from: '2024-01-01' },
        listening: {
          match: 'all',
          rules: [{ period: { kind: 'all' }, min: 2 }],
        },
      },
      'catalog-fixture-owner',
    )
    expect(selection).toMatchObject({
      totalCount: 1,
      items: [{ id: source.id, track: { listeningScrobbles: 1 } }],
    })
    const choice = await savedSpotifyCandidate(
      source.id,
      'Test Recording',
      'catalog-recording',
    )
    await expect(
      acceptSpotifyTrackSearch({
        ...choice,
        spotifyTrackId: spotifyId('not-in-results'),
      }),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    const result = await acceptSpotifyTrackSearch(choice)
    expect(result.targetId).not.toBe(source.id)
    expect(await acceptSpotifyTrackSearch(choice)).toEqual(result)
    await refreshTrackLinks(LISTENER)
    const kept = await getTrackDetail(result.targetId)
    expect(kept).toMatchObject({
      title: 'Test Recording',
      spotifyMatch: 'spotify-search',
      sources: ['lastfm', 'spotify-search'],
      scrobbles: 2,
      lastfmSources: [
        expect.objectContaining({
          trackName: '02 - Test Recording',
          manuallyMatched: true,
        }),
      ],
    })
    expect(await getTrackDetail(source.id)).toBeNull()
    const diagnostics = await listTrackMatchDiagnostics({
      page: 1,
      size: 10,
      sortBy: 'name',
      direction: 'asc',
    })
    expect(diagnostics.items[0]?.matches).toContainEqual(
      expect.objectContaining({
        provider: 'spotify',
        name: 'Test Recording',
        creator: ARTIST,
        identifier: choice.spotifyTrackId,
      }),
    )
    await album('catalog-release', 'Catalog Release', [
      { title: 'Intro' },
      { title: 'Test Recording', spotifyId: choice.spotifyTrackId },
    ])
    await refreshTrackLinks(LISTENER)
    expect(await getTrackDetail(result.targetId)).toMatchObject({
      album: { id: 'catalog-release' },
      scrobbles: 2,
      spotifyMatch: 'spotify-search',
    })
    expect(
      (
        await databaseClient
          .select()
          .from(schema.track)
          .where(eq(schema.track.trackMediaItemId, result.targetId))
      ).map((row) => row.position),
    ).toEqual([2])
    expect(request).not.toHaveBeenCalled()
  })

  it('links a reviewed stray name to an existing Spotify album track and keeps playlist and release order', async () => {
    const id = spotifyId('known-recording')
    await album('catalog-release', 'Catalog Release', [
      { title: 'Intro' },
      { title: 'Test Recording', spotifyId: id },
    ])
    const [known] = (await allTracks()).filter(
      (item) => item.spotifyTrackId === id,
    )
    if (!known) throw new Error('Expected playable album track')
    await playlist('fixture-playlist', [known.id])
    await scrobble('Unrelated imported name')
    await refreshTrackLinks(LISTENER)
    const [stray] = (await allTracks()).filter(
      (item) => item.title === 'Unrelated imported name',
    )
    if (!stray) throw new Error('Expected a separate Last.fm track')
    const choice = await savedSpotifyCandidate(
      stray.id,
      'Test Recording',
      'known-recording',
    )
    expect(await acceptSpotifyTrackSearch(choice)).toEqual({
      targetId: known.id,
    })
    await refreshTrackLinks(LISTENER)
    expect(await getTrackDetail(known.id)).toMatchObject({
      spotifyMatch: 'album-track-list',
      scrobbles: 1,
      sources: expect.arrayContaining([
        'lastfm',
        'album',
        'spotify',
        'spotify-search',
      ]),
    })
    expect(
      await databaseClient.select().from(schema.playlistItem),
    ).toMatchObject([{ mediaItemId: known.id, position: 0 }])
    expect(
      await databaseClient
        .select()
        .from(schema.track)
        .where(eq(schema.track.trackMediaItemId, known.id)),
    ).toMatchObject([{ position: 2 }])
  })

  it('reuses an ID-less album position and preserves listening links from other scrobbled names', async () => {
    await album('catalog-release', 'Catalog Release', [
      { title: 'Intro' },
      { title: 'Test Recording' },
    ])
    await scrobble('Different source name')
    await refreshTrackLinks(LISTENER)
    const tracks = await allTracks()
    const source = tracks.find((item) => item.title === 'Different source name')
    const stored = tracks.find((item) => item.title === 'Test Recording')
    if (!source || !stored)
      throw new Error('Expected a separate source and album position')
    await scrobble('Listening attribution', { at: LAST_LISTEN })
    await databaseClient.insert(schema.lastfmTrackLink).values({
      username: LISTENER,
      artistKey: albumNameKey(ARTIST),
      trackKey: albumNameKey('Listening attribution'),
      trackMediaItemId: source.id,
      strategy: 'normalized',
    })
    const choice = await savedSpotifyCandidate(
      source.id,
      'Test Recording',
      'catalog-recording',
    )
    expect(await acceptSpotifyTrackSearch(choice)).toEqual({
      targetId: stored.id,
    })
    expect(await getTrackDetail(stored.id)).toMatchObject({
      scrobbles: 2,
      albumLinkStrategy: 'album-track-list',
      spotifyMatch: 'spotify-search',
    })
    expect(
      await databaseClient
        .select()
        .from(schema.lastfmTrackLink)
        .where(eq(schema.lastfmTrackLink.trackMediaItemId, stored.id)),
    ).toHaveLength(2)
  })

  it('keeps a release position and separate annotations intact when the catalog choice would discard them', async () => {
    await album('original-release', 'Original Release', [
      { title: 'Test Recording' },
    ])
    const [original] = await allTracks()
    if (!original) throw new Error('Expected an album track')
    const choice = await savedSpotifyCandidate(
      original.id,
      'Test Recording',
      'different-recording',
      'different-release',
    )
    await expect(acceptSpotifyTrackSearch(choice)).rejects.toMatchObject({
      response: { statusCode: 409 },
    })
    expect(await getTrackDetail(original.id)).toMatchObject({
      album: { id: 'original-release' },
      spotifyMatch: 'unmatched',
    })
    await scrobble('Annotated name')
    await refreshTrackLinks(LISTENER)
    const [stray] = (await allTracks()).filter(
      (item) => item.title === 'Annotated name',
    )
    if (!stray) throw new Error('Expected a separate name')
    await databaseClient
      .update(schema.mediaItem)
      .set({ summary: 'Retain this annotation' })
      .where(eq(schema.mediaItem.id, stray.id))
    const annotated = await savedSpotifyCandidate(
      stray.id,
      'Test Recording',
      'catalog-recording',
    )
    await expect(acceptSpotifyTrackSearch(annotated)).rejects.toMatchObject({
      response: { statusCode: 409 },
    })
    expect(await getTrackDetail(stray.id)).toMatchObject({
      spotifyMatch: 'unmatched',
      scrobbles: 1,
    })
    expect(
      await databaseClient
        .select()
        .from(schema.mediaItem)
        .where(eq(schema.mediaItem.id, stray.id)),
    ).toMatchObject([{ summary: 'Retain this annotation' }])
  })

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
    expect(await inspect({ playability: 'all' })).toEqual(all)
    const standalone = all.items.find((item) => item.id === item.mergeSourceId)
    if (!standalone) throw new Error('Expected a standalone Last.fm row')
    expect((await allTracks()).map((item) => item.id)).not.toContain(
      standalone.id,
    )
    expect(standalone.track?.sources).toContain('lastfm')
    expect(standalone).toMatchObject({
      spotifyAlternate: {
        trackId: 'imported-recording',
        name: 'Shared Song',
        albumName: 'Playlist Edition',
        identifier: spotifyId('imported-recording'),
      },
      track: { spotifyTrackId: null, spotifyMatch: 'unmatched' },
      matches: [{ provider: 'lastfm', name: 'SHARED SONG' }],
    })
    expect(await getTrackDetail(standalone.id)).toMatchObject({
      spotifyTrackId: null,
      spotifyAlternate: standalone.spotifyAlternate,
    })
    const directDetail = await getTrackDetail('imported-recording')
    expect(directDetail).toMatchObject({
      spotifyTrackId: spotifyId('imported-recording'),
    })
    expect(directDetail).not.toHaveProperty('spotifyAlternate')
    const missing = all.items.find((item) => item.name === 'No source')
    if (!missing) throw new Error('Expected an unmatched album track')
    const missingDetail = await getTrackDetail(missing.id)
    expect(missingDetail).toMatchObject({ spotifyTrackId: null })
    expect(missingDetail).not.toHaveProperty('spotifyAlternate')
    expect(
      all.items.find((item) => item.id === 'imported-recording'),
    ).not.toHaveProperty('spotifyAlternate')
    const bySpotify = await inspect({ sortBy: 'spotify', size: 3 })
    expect(new Set(bySpotify.items.map((item) => item.id))).toEqual(
      new Set([standalone.id, 'imported-recording', 'variant-recording']),
    )

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
    const missingSpotify = {
      filters: JSON.stringify([match(spotify, 'exclude'), match(lastfm)]),
    }
    expect(titles(await inspect(missingSpotify))).toEqual(['SHARED SONG'])
    expect(
      await inspect({ ...missingSpotify, playability: 'unavailable' }),
    ).toMatchObject({ items: [], totalCount: 0 })
    expect(await inspect({ playability: 'alternate' })).toMatchObject({
      items: [{ id: standalone.id }],
      totalCount: 1,
    })
    const direct = await inspect({ playability: 'direct' })
    expect(new Set(direct.items.map((item) => item.id))).toEqual(
      new Set(['imported-recording', 'variant-recording']),
    )
    const playable = await inspect({ playability: 'playable' })
    expect(new Set(playable.items.map((item) => item.id))).toEqual(
      new Set([standalone.id, 'imported-recording', 'variant-recording']),
    )
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
          value: spotify,
          count: 2,
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
    expect(
      await listTrackMatchDiagnosticsFacets(
        BrowseFacetQuerySchema.parse({
          q: 'Spotify match on this entry Unmatched',
        }),
      ),
    ).toContainEqual({
      field: 'spotifyMatch',
      value: 'Unmatched',
      label: 'Spotify match on this entry: Unmatched',
      count: 4,
    })
    await databaseClient
      .update(schema.lastfmTrackSource)
      .set({ manuallyMatched: true })
      .where(eq(schema.lastfmTrackSource.trackMediaItemId, standalone.id))
    const manualDetail = await getTrackDetail(standalone.id)
    expect(manualDetail).toMatchObject({
      lastfmSources: [{ manuallyMatched: true }],
    })
    expect(manualDetail).not.toHaveProperty('spotifyAlternate')
    expect(await inspect({ playability: 'alternate' })).toMatchObject({
      items: [],
      totalCount: 0,
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('filters unavailable scrobbles after checking recording evidence outside the selected source', async () => {
    const albumId = 'original-edition'
    const albumName = 'Original Edition'
    const titles = [
      'Covered Song',
      'Missing Song',
      'Edited Song (Radio Edit)',
      'Ambiguous Song',
    ]
    await album(
      albumId,
      albumName,
      titles.map((title, index) => ({ title, durationSec: 180 + index })),
    )
    for (const title of titles)
      await scrobble(title, { album: albumName, albumId })
    await refreshTrackLinks(LISTENER)

    const { spotify, lastfm } = trackMatchProviderLabels
    const scope = [
      { field: 'matchProvider', value: lastfm, mode: 'required' },
      { field: 'source', value: 'Album track list', mode: 'required' },
    ]
    const missingSpotify = JSON.stringify([
      ...scope,
      { field: 'matchProvider', value: spotify, mode: 'exclude' },
    ])
    const inspect = (input: Record<string, unknown> = {}) =>
      listTrackMatchDiagnostics(
        TrackMatchDiagnosticsQuerySchema.parse({
          creatorId: createStableId('artist', ARTIST.toLowerCase()),
          filters: JSON.stringify(scope),
          ranges: JSON.stringify([{ field: 'scrobbles', min: 1 }]),
          sortBy: 'durationSec',
          direction: 'desc',
          ...input,
        }),
      )
    const unavailable = { playability: 'unavailable' }
    expect((await inspect(unavailable)).items.map((item) => item.name)).toEqual(
      [...titles].reverse(),
    )

    await spotifyTrack('covered-edition', 'Covered Song', {
      album: 'Later Edition',
    })
    await spotifyTrack('studio-edition', 'Edited Song', {
      album: 'Studio Edition',
    })
    await spotifyTrack('short-edition', 'Ambiguous Song', {
      album: 'Short Edition',
    })
    await spotifyTrack('long-edition', 'Ambiguous Song', {
      album: 'Long Edition',
      durationSec: 210,
    })
    await playlist('new-editions', [
      'covered-edition',
      'studio-edition',
      'short-edition',
      'long-edition',
    ])
    await refreshTrackLinks(LISTENER)

    const missing = await inspect({ ...unavailable, page: 1, size: 2 })
    expect(missing).toMatchObject({ totalCount: 3, pageCount: 2 })
    expect(missing.items.map((item) => item.name)).toEqual([
      'Ambiguous Song',
      'Edited Song (Radio Edit)',
    ])
    expect(
      await inspect({
        ...unavailable,
        filters: missingSpotify,
        page: 2,
        size: 2,
      }),
    ).toMatchObject({
      totalCount: 3,
      pageCount: 2,
      items: [{ name: 'Missing Song' }],
    })
    expect(
      await inspect({
        playability: 'alternate',
        filters: missingSpotify,
        q: 'Original Edition',
      }),
    ).toMatchObject({
      totalCount: 1,
      items: [
        {
          name: 'Covered Song',
          spotifyAlternate: {
            trackId: 'covered-edition',
            name: 'Covered Song',
            albumName: 'Later Edition',
            identifier: spotifyId('covered-edition'),
          },
          matches: [{ provider: 'lastfm', name: 'Covered Song' }],
          track: { spotifyTrackId: null, scrobbles: 1 },
        },
      ],
    })
    expect(
      (
        await inspect({ playability: 'alternate', q: 'Later Edition' })
      ).items.map((item) => item.name),
    ).toEqual(['Covered Song'])
    await removeImportedPlaylist('new-editions')
    expect((await inspect(unavailable)).items.map((item) => item.name)).toEqual(
      [...titles].reverse(),
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('filters the Last.fm import worklist by Spotify recording coverage before sorting and paging', async () => {
    await album('original', 'Original Release', [
      { title: 'Third Song', spotifyId: spotifyId('direct') },
      { title: 'Second Song', durationSec: 180 },
    ])
    await album('other', 'Other Release', [])
    await spotifyTrack('other-recording', 'Second Song', {
      album: 'Other Release',
      albumId: 'other',
    })
    await spotifyTrack('playlist-recording', 'First Song')
    await playlist('songs', ['playlist-recording', 'other-recording'])
    for (const title of ['Third Song', 'Second Song'])
      await scrobble(title, { album: 'Original Release', albumId: 'original' })
    await scrobble('First Song')
    await scrobble('Missing Song')
    await refreshTrackLinks(LISTENER)

    const inspect = (options: Record<string, unknown>) =>
      listTrackMatchDiagnostics(
        TrackMatchDiagnosticsQuerySchema.parse({
          filters: JSON.stringify([
            { field: 'source', value: 'Last.fm', mode: 'required' },
          ]),
          view: 'spotify-coverage',
          sortBy: 'spotifyCoverage',
          direction: 'asc',
          ...options,
        }),
      )
    const all = await inspect({})
    expect(all.items.map((row) => row.name)).toEqual([
      'Third Song',
      'Second Song',
      'First Song',
      'Missing Song',
    ])
    expect(all.items.every((row) => row.matches.length === 0)).toBe(true)
    expect(all.items[1]?.spotifyAlternate?.trackId).toBe('other-recording')
    expect(
      await inspect({ playability: 'unavailable', size: 1 }),
    ).toMatchObject({ items: [{ name: 'Missing Song' }], totalCount: 1 })
    expect(
      await inspect({ playability: 'playable', size: 1, page: 3 }),
    ).toMatchObject({ items: [{ name: 'First Song' }], totalCount: 3 })
    expect(
      await inspect({ q: 'Second Other', playability: 'playable' }),
    ).toMatchObject({ items: [{ name: 'Second Song' }], totalCount: 1 })
    expect(request).not.toHaveBeenCalled()
  })

  it('uses a shared recording identifier for playability while preserving direct provider evidence', async () => {
    const title = 'Catalogue Song'
    const isrc = 'ZZABC2000001'
    await album('catalogue-original', 'Catalogue Original', [
      { title, durationSec: 181 },
    ])
    const [original] = await allTracks()
    if (!original) throw new Error('Expected an album track position')
    await album('catalogue-alternate', 'Catalogue Alternate', [])
    await spotifyTrack('catalogue-spotify', title, {
      album: 'Catalogue Alternate',
      albumId: 'catalogue-alternate',
    })
    await playlist('catalogue-playlist', ['catalogue-spotify'])

    const { noRecording, noEvidence, spotify } = trackMatchProviderLabels
    const inspect = (input: Record<string, unknown>) =>
      listTrackMatchDiagnostics(TrackMatchDiagnosticsQuerySchema.parse(input))
    const withProvider = (value: string) =>
      inspect({
        filters: JSON.stringify([
          { field: 'matchProvider', value, mode: 'required' },
        ]),
      })
    const facetCounts = async () =>
      (await listTrackMatchDiagnosticsFacets(BrowseFacetQuerySchema.parse({})))
        .filter((facet) => facet.field === 'matchProvider')
        .map(({ value, count }) => ({ value, count }))
    const withoutEvidence = {
      items: [{ id: original.id, matches: [] }],
      totalCount: 1,
    }
    expect(await inspect({ playability: 'unavailable' })).toMatchObject(
      withoutEvidence,
    )
    const facets = await facetCounts()
    expect(facets).toEqual(
      expect.arrayContaining([
        { value: noRecording, count: 1 },
        { value: noEvidence, count: 1 },
        { value: spotify, count: 1 },
      ]),
    )

    await databaseClient
      .update(schema.libraryTrack)
      .set({ isrc })
      .where(
        inArray(schema.libraryTrack.mediaItemId, [
          original.id,
          'catalogue-spotify',
        ]),
      )
    expect(await inspect({ playability: 'unavailable' })).toMatchObject({
      items: [],
      totalCount: 0,
    })
    expect(await inspect({ playability: 'alternate' })).toMatchObject({
      items: [
        {
          id: original.id,
          spotifyAlternate: {
            trackId: 'catalogue-spotify',
            album: { id: 'catalogue-alternate', title: 'Catalogue Alternate' },
            artworkUrl: 'https://example.com/album-artwork.jpg',
          },
        },
      ],
      totalCount: 1,
    })
    expect(await withProvider(noRecording)).toMatchObject(withoutEvidence)
    expect(await withProvider(noEvidence)).toMatchObject(withoutEvidence)
    expect(await facetCounts()).toEqual(facets)

    await databaseClient
      .update(schema.mediaItem)
      .set({ metadata: { legacyHidden: true } })
      .where(eq(schema.mediaItem.id, 'catalogue-spotify'))
    expect(await inspect({ playability: 'unavailable' })).toMatchObject(
      withoutEvidence,
    )
    expect(await withProvider(spotify)).toMatchObject({
      items: [],
      totalCount: 0,
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('preserves malformed Spotify identifiers as evidence while requiring a valid ID to play', async () => {
    await spotifyTrack('legacy-version', 'Shared Recording')
    await spotifyTrack('valid-version', 'Shared Recording')
    await spotifyTrack('legacy-standalone', 'Standalone Recording')
    await playlist('legacy-playlist', [
      'legacy-version',
      'valid-version',
      'legacy-standalone',
    ])
    await databaseClient
      .update(schema.libraryTrack)
      .set({ isrc: 'ZZABC2000002' })
      .where(
        inArray(schema.libraryTrack.mediaItemId, [
          'legacy-version',
          'valid-version',
        ]),
      )
    const invalidCharacter = `${spotifyId('legacy-version').slice(0, 21)}-`
    const shortIdentifier = 'legacylocaltrack'
    await databaseClient
      .update(schema.libraryTrack)
      .set({ spotifyTrackId: invalidCharacter, spotifyUrl: null })
      .where(eq(schema.libraryTrack.mediaItemId, 'legacy-version'))
    await databaseClient
      .update(schema.libraryTrack)
      .set({ spotifyTrackId: shortIdentifier, spotifyUrl: null })
      .where(eq(schema.libraryTrack.mediaItemId, 'legacy-standalone'))

    const inspect = (input: Record<string, unknown>) =>
      listTrackMatchDiagnostics(TrackMatchDiagnosticsQuerySchema.parse(input))
    expect(await inspect({ playability: 'direct' })).toMatchObject({
      items: [{ id: 'valid-version' }],
      totalCount: 1,
    })
    const alternates = await inspect({ playability: 'alternate' })
    expect(alternates).toMatchObject({
      items: [
        {
          id: 'legacy-version',
          matches: [{ provider: 'spotify', identifier: invalidCharacter }],
          spotifyAlternate: {
            trackId: 'valid-version',
            identifier: spotifyId('valid-version'),
          },
        },
      ],
      totalCount: 1,
    })
    expect(await getTrackDetail('legacy-version')).toMatchObject({
      spotifyTrackId: invalidCharacter,
      spotifyAlternate: alternates.items[0]?.spotifyAlternate,
    })
    const unavailableDetail = await getTrackDetail('legacy-standalone')
    expect(unavailableDetail).toMatchObject({ spotifyTrackId: shortIdentifier })
    expect(unavailableDetail).not.toHaveProperty('spotifyAlternate')
    expect(await inspect({ playability: 'unavailable' })).toMatchObject({
      items: [
        {
          id: 'legacy-standalone',
          matches: [{ provider: 'spotify', identifier: shortIdentifier }],
        },
      ],
      totalCount: 1,
    })
    expect(
      await inspect({
        filters: JSON.stringify([
          {
            field: 'matchProvider',
            value: trackMatchProviderLabels.spotify,
            mode: 'required',
          },
        ]),
      }),
    ).toMatchObject({ totalCount: 3 })
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
    ).toEqual(['imported-recording', standalone.id])
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
        artistKey: albumNameKey(ARTIST),
        trackKey: 'uncatalogued song',
        artistName: ARTIST,
        trackName: 'Uncatalogued Song',
        albumNames: ['Uncatalogued Album'],
        count: 2,
        manuallyMatched: false,
        keptSeparate: false,
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
          artistKey: albumNameKey(ARTIST),
          trackKey: 'ambiguous song',
          artistName: ARTIST,
          trackName: 'Ambiguous Song',
          albumNames: ['Shared Album'],
          count: 1,
          manuallyMatched: false,
          keptSeparate: false,
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

  it('reconciles numbered and featured scrobble names through a unique confirmed album position', async () => {
    const albumId = 'alias-release'
    const release = 'Fixture Release'
    const options = { album: release }
    const names: [string, string][] = [
      ['02 - Signal', ARTIST],
      ['Signal (feat. Guest Singer)', ARTIST],
      ['Signal', ARTIST + ', Guest Singer'],
    ]
    for (const [title, artist] of names)
      await scrobble(title, { ...options, artist })
    await scrobble('Signal', options)
    await refreshTrackLinks(LISTENER)
    // A subsequent metadata import supplies the actual recording.
    await album(albumId, release, [
      { title: 'Intro' },
      { title: 'Signal', spotifyId: spotifyId('signal') },
    ])
    await databaseClient
      .update(schema.lastfmScrobble)
      .set({ albumMediaItemId: albumId })
    await refreshTrackLinks(LISTENER)
    const resolve = async () =>
      (await allTracks()).filter((track) => track.sources.includes('lastfm'))
    expect(await resolve()).toMatchObject([
      { title: 'Signal', spotifyTrackId: spotifyId('signal'), scrobbles: 4 },
    ])
    await refreshTrackLinks(LISTENER)
    expect(await resolve()).toHaveLength(1)
    expect(
      await databaseClient.select().from(schema.lastfmScrobble),
    ).toHaveLength(4)
    expect(
      await databaseClient.select().from(schema.lastfmTrackSource),
    ).toHaveLength(4)
  })

  it('matches previously imported aliases as soon as an album track list supplies their positions', async () => {
    const albumId = 'late-album-positions'
    const release = 'Late Positions'
    const options = { albumId, album: release }
    await album(albumId, release, [])
    await scrobble('02 - Signal', options)
    await scrobble('Signal (feat. Guest Singer)', options)
    await scrobble('Signal', { ...options, artist: ARTIST + ', Guest Singer' })
    await scrobble('03 - Playlist Track', options)
    await scrobble('04 - Already Known', options)
    await scrobble('05 - Conflicting History', options)
    await scrobble('05 - Conflicting History', { album: 'Unknown Release' })
    await refreshTrackLinks(LISTENER)

    const before = await databaseClient.select().from(schema.lastfmTrackSource)
    const inPlaylist = before.find(
      (row) => row.trackKey === '03 - playlist track',
    )
    const alreadyKnown = before.find(
      (row) => row.trackKey === '04 - already known',
    )
    const conflicting = before.find(
      (row) => row.trackKey === '05 - conflicting history',
    )
    if (!inPlaylist || !alreadyKnown || !conflicting)
      throw new Error('Expected standalone Last.fm fixtures')
    await playlist('alias-playlist', [inPlaylist.trackMediaItemId])
    await spotifyTrack('exact-release-track', '04 - Already Known', options)

    await databaseClient.transaction((tx) =>
      replaceAlbumTracks(tx, albumId, [
        { title: 'Opening', position: 1 },
        { title: 'Signal', position: 2, externalId: spotifyId('late-signal') },
        { title: 'Playlist Track', position: 3 },
        { title: 'Already Known', position: 4 },
        { title: 'Conflicting History', position: 5 },
      ]),
    )

    const listed = (await getAlbumDetail(albumId))?.tracks[1]?.track
    expect(listed).toMatchObject({
      title: 'Signal',
      spotifyTrackId: spotifyId('late-signal'),
      scrobbles: 3,
      sources: ['album', 'lastfm'],
    })
    const after = await databaseClient.select().from(schema.lastfmTrackSource)
    expect(
      after.filter((row) => row.trackMediaItemId === listed?.id),
    ).toHaveLength(3)
    expect(after).toEqual(
      expect.arrayContaining([inPlaylist, alreadyKnown, conflicting]),
    )
    expect(
      await databaseClient.select().from(schema.lastfmScrobble),
    ).toHaveLength(7)
    expect(request).not.toHaveBeenCalled()
  })

  it('previews and reconciles stored aliases without changing explicit choices or duplicating scrobbles', async () => {
    const albumId = 'pending-alias-release'
    const release = 'Pending Aliases'
    await album(albumId, release, [])
    await scrobble('01 - First Signal', { albumId, album: release })
    await scrobble('02 - Second Signal', { albumId, album: release })
    await refreshTrackLinks(LISTENER)
    await databaseClient
      .update(schema.lastfmTrackSource)
      .set({ manuallyMatched: true })
      .where(eq(schema.lastfmTrackSource.trackKey, '02 - second signal'))
    const before = await databaseClient.select().from(schema.lastfmTrackSource)
    const manual = before.find((row) => row.manuallyMatched)
    if (!manual) throw new Error('Expected a manual source fixture')

    // As if the track list was stored before automatic alias reconciliation.
    for (const [index, title] of ['First Signal', 'Second Signal'].entries()) {
      const id = `pending-alias-track-${index}`
      await spotifyTrack(id, title, { albumId, album: release })
      await databaseClient.insert(schema.track).values({
        id,
        albumMediaItemId: albumId,
        trackMediaItemId: id,
        position: index + 1,
        title,
      })
    }
    const guest = 'Fixture Guest'
    const guestId = createStableId('artist', guest.toLowerCase())
    await databaseClient
      .insert(schema.artist)
      .values({ id: guestId, name: guest })
    await databaseClient.insert(schema.mediaCredit).values({
      mediaItemId: 'pending-alias-track-0',
      artistId: guestId,
      role: 'artist',
      billingOrder: 1,
    })
    await databaseClient.insert(schema.lastfmTrackLink).values({
      username: LISTENER,
      artistKey: albumNameKey(ARTIST),
      trackKey: '01 - first signal',
      trackMediaItemId: 'pending-alias-track-0',
      strategy: 'version',
    })
    const check = (dryRun = false) =>
      databaseClient.transaction((tx) =>
        reconcileLastfmAlbumTrackAliases(tx, { dryRun }),
      )
    expect(await check(true)).toBe(1)
    expect(
      await databaseClient.select().from(schema.lastfmTrackSource),
    ).toEqual(expect.arrayContaining(before))
    expect(await check()).toBe(1)
    expect(await check()).toBe(0)
    const after = await databaseClient.select().from(schema.lastfmTrackSource)
    expect(after).toEqual(
      expect.arrayContaining([
        manual,
        expect.objectContaining({
          trackKey: '01 - first signal',
          trackMediaItemId: 'pending-alias-track-0',
        }),
      ]),
    )
    expect(
      await databaseClient.select().from(schema.lastfmScrobble),
    ).toHaveLength(2)
    expect((await getAlbumDetail(albumId))?.tracks[0]?.track).toMatchObject({
      title: 'First Signal',
      scrobbles: 1,
      dateAdded: FIRST_LISTEN,
    })
    const [link] = await databaseClient
      .select()
      .from(schema.lastfmTrackLink)
      .where(
        eq(schema.lastfmTrackLink.trackMediaItemId, 'pending-alias-track-0'),
      )
    expect(link?.strategy).toBe('exact')
    const [artist] = await databaseClient
      .select()
      .from(schema.artist)
      .where(eq(schema.artist.id, guestId))
    expect(artist?.scrobbleCount).toBe(1)
    expect(request).not.toHaveBeenCalled()
  })

  it('requires the release position and corroborated artist credits and preserves version labels', async () => {
    const albumId = 'ambiguous-alias-release'
    const options = { albumId, album: 'Alias Release' }
    await album(albumId, options.album, [
      { title: 'Opening' },
      { title: 'Signal', spotifyId: spotifyId('studio') },
      { title: 'Signal (Radio Edit)', spotifyId: spotifyId('edit') },
      { title: 'Twice (feat. A)', spotifyId: spotifyId('guest-a') },
      { title: 'Twice (feat. B)', spotifyId: spotifyId('guest-b') },
    ])
    for (const title of [
      '01 - Signal',
      '02 - Signal (Remix)',
      '02 - Signal (Radio Edit)',
      'Signal feat. Guest - Radio Edit',
      'Twice (feat. C)',
      'Signal (feat. A)',
      'Signal (feat. B)',
    ])
      await scrobble(title, options)
    await scrobble('Signal', { ...options, artist: ARTIST + ', Unknown' })
    await scrobble('02 - Opening', { ...options, artist: 'Different Artist' })
    await scrobble('02 - Mixed', options)
    await scrobble('02 - Mixed', { album: 'Unknown Release', at: LAST_LISTEN })
    await refreshTrackLinks(LISTENER)
    const sources = await databaseClient
      .select({ id: schema.lastfmTrackSource.trackMediaItemId })
      .from(schema.lastfmTrackSource)
    const tracks = await allTracks()
    expect(sources).toHaveLength(10)
    expect(
      sources.every(
        (source) =>
          tracks.find((item) => item.id === source.id)?.spotifyTrackId === null,
      ),
    ).toBe(true)
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
      ['Spotify playlist / Liked Songs', 1],
    ])
    const legacy = await listTracks(
      query({
        filters: [
          { field: 'spotifyMatch', value: 'Spotify import', mode: 'required' },
        ],
      }),
    )
    expect(legacy.items.map((item) => item.spotifyMatch)).toEqual([
      'spotify-import',
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
        artistKey: albumNameKey(ARTIST),
        trackKey: 'recorded song',
        artistName: ARTIST,
        trackName: 'Recorded Song',
        albumNames: ['Another Album', 'Original Album'],
        count: 2,
        manuallyMatched: false,
        keptSeparate: false,
      },
      {
        artistKey: albumNameKey(ARTIST),
        trackKey: 'recorded song',
        artistName: ' example artist ',
        trackName: ' RECORDED SONG ',
        albumNames: [],
        count: 1,
        manuallyMatched: false,
        keptSeparate: false,
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
          artistKey: albumNameKey(ARTIST),
          trackKey: 'shared recording',
          artistName: ARTIST,
          trackName: 'Shared Recording',
          albumNames: ['Another Release', 'Scrobbled Release'],
          count: 2,
          manuallyMatched: true,
          keptSeparate: false,
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
        artistKey: albumNameKey(ARTIST),
        trackKey: 'chosen recording',
        artistName: ARTIST,
        trackName: 'Chosen Recording',
        albumNames: [],
        count: 1,
        manuallyMatched: false,
        keptSeparate: false,
      },
      {
        artistKey: albumNameKey(ARTIST),
        trackKey: 'recorded title',
        artistName: ARTIST,
        trackName: 'Recorded Title',
        albumNames: ['Recorded Album'],
        count: 1,
        manuallyMatched: true,
        keptSeparate: false,
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
