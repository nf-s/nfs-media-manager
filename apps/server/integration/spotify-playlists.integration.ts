import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
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
import {
  SPOTIFY_PLAYLIST_ITEM_LIMIT,
  TrackQuerySchema,
} from '@repo/schemas/tracks'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { spotifyPlugin } from '@/plugins/builtin/spotify'
import { lastfmPlugin } from '@/plugins/builtin/lastfm'
import { albumNameKey } from '@/lib/album-import-candidates'
import { createStableId } from '@/lib/media-utils'

const database = `spotify_playlists_${randomUUID().replaceAll('-', '')}`
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
  getScrapePlugin: async (id: string) =>
    id === 'spotify' ? spotifyPlugin : id === 'lastfm' ? lastfmPlugin : null,
  listLoadedScrapePlugins: async () => [],
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({
    apiKey: 'fixture-key',
    username: 'Fixture-Listener',
  }),
}))
// The account connection and the request gate have their own tests; this
// suite reads Spotify through the mocked fetch without request spacing.
vi.mock('@/services/spotify-oauth', () => ({
  getSpotifyAccountStatus: async () => ({
    configured: true,
    connected: true,
    playlists: true,
  }),
  spotifyPlaylistToken: async () => 'fixture-token',
  spotifyOperation: async (execute: (send: typeof fetch) => Promise<unknown>) =>
    execute((input, init) => request(input, init)),
}))
import {
  getSpotifyPlaylistImports,
  listSpotifyPlaylists,
  queueSpotifyPlaylistImports,
} from '@/services/spotify-playlists'
import { getJob, processQueuedJobs } from '@/services/jobs'
import {
  getTrackDetail,
  listPlaylists,
  listTrackFilterOptions,
  listTracks,
  removeImportedPlaylist,
} from '@/services/tracks'
import { getAlbumPlaylists } from '@/services/album-playlists'
import { listAlbumFilterOptions, listAlbums } from '@/services/media'
import { relinkLastfmScrobbles } from '@/services/lastfm-scrobbles'

const USER_ID = 'playlist-user'
const account = 'fixture-listener'
const spotifyId = (name: string) => name.padEnd(22, '0')
const OWNED = spotifyId('owned')
const SHARED = spotifyId('shared')
const FOLLOWED = spotifyId('followed')
const ALBUM = spotifyId('album')
// The ID every writer derives for this artist name.
const ARTIST_ID = createStableId('artist', 'the examples')

type Entry = Record<string, unknown>
const track = (
  name: string,
  options: {
    title?: string
    artists?: string[]
    album?: string
    albumId?: string
    addedAt?: string
  } = {},
): Entry => ({
  added_at: options.addedAt ?? '2024-03-01T10:00:00Z',
  item: {
    type: 'track',
    id: spotifyId(name),
    name: options.title ?? name,
    duration_ms: 200400,
    artists: (options.artists ?? ['The Examples']).map((artist) => ({
      name: artist,
    })),
    album: {
      id: options.albumId ?? spotifyId(`${name}album`),
      name: options.album ?? `${name} single`,
      images: [{ url: 'https://i.scdn.co/image/example' }],
      release_date: '2020-05-01',
    },
    external_ids: { isrc: 'aa-bb1-20-00001' },
  },
})

let playlists: Array<Record<string, unknown>> = []
let entries: Record<string, Entry[]> = {}
let liked: Entry[] = []
let reportedTotal: number | null = null

function page(items: Entry[], url: URL) {
  const offset = Number(url.searchParams.get('offset'))
  const limit = Number(url.searchParams.get('limit'))
  const slice = items.slice(offset, offset + limit)
  return Response.json({
    items: slice,
    total: reportedTotal ?? items.length,
    offset,
    next: offset + slice.length < items.length ? 'next' : null,
  })
}

const requestedPaths = () =>
  request.mock.calls.map(([input]) => new URL(String(input)).pathname)

async function addAlbum(
  id: string,
  title: string,
  options: { spotifyAlbumId?: string; tracks?: string[]; tag?: string } = {},
) {
  await databaseClient
    .insert(schema.mediaItem)
    .values({ id, slug: id, title, mediaType: 'album' })
  await databaseClient.insert(schema.album).values({ mediaItemId: id })
  await databaseClient
    .insert(schema.artist)
    .values({ id: ARTIST_ID, name: 'The Examples' })
    .onConflictDoNothing()
  await databaseClient.insert(schema.mediaCredit).values({
    mediaItemId: id,
    artistId: ARTIST_ID,
    role: 'artist',
  })
  if (options.spotifyAlbumId)
    await databaseClient.insert(schema.providerReference).values({
      id: randomUUID(),
      mediaItemId: id,
      provider: 'spotify',
      referenceType: 'album',
      externalId: options.spotifyAlbumId,
    })
  for (const [index, name] of (options.tracks ?? []).entries())
    await databaseClient.insert(schema.track).values({
      id: randomUUID(),
      albumMediaItemId: id,
      title: name,
      position: index + 1,
    })
  if (options.tag) {
    await databaseClient
      .insert(schema.tag)
      .values({ id: `tag-${id}`, mediaType: 'album', name: options.tag })
    await databaseClient
      .insert(schema.mediaItemTag)
      .values({ mediaItemId: id, tagId: `tag-${id}` })
  }
}

async function addScrobbles(artistName: string, trackName: string, count = 1) {
  await databaseClient.insert(schema.lastfmScrobble).values(
    Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      username: account,
      listenedAt: new Date(Date.UTC(2025, 0, 1 + index, 12)),
      artistName,
      trackName,
      artistKey: albumNameKey(artistName),
      trackKey: albumNameKey(trackName),
    })),
  )
}

async function importAll(
  input: Parameters<typeof queueSpotifyPlaylistImports>[0],
) {
  const result = await queueSpotifyPlaylistImports(input, USER_ID)
  await processQueuedJobs()
  return result
}

const chosen = (id: string, name: string) => ({ spotifyId: id, name })
const trackQuery = (input: Record<string, unknown> = {}) =>
  TrackQuerySchema.parse({ sortBy: 'title', direction: 'asc', ...input })
const required = (...names: string[]) =>
  JSON.stringify(
    names.map((value) => ({ field: 'playlist', value, mode: 'required' })),
  )
const titles = async (input: Record<string, unknown> = {}) =>
  (await listTracks(trackQuery(input))).items.map((item) => item.title)

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
  await databaseClient.insert(schema.user).values({
    id: USER_ID,
    name: 'Playlist owner',
    email: 'playlists@example.com',
  })
})
beforeEach(async () => {
  reportedTotal = null
  playlists = [
    {
      id: OWNED,
      name: 'Morning',
      snapshot_id: 'owned-1',
      owner: { id: 'owner', display_name: 'Owner' },
      items: { total: 3 },
      images: [{ url: 'https://i.scdn.co/image/morning' }],
    },
    {
      id: SHARED,
      name: 'Shared',
      snapshot_id: 'shared-1',
      collaborative: true,
      owner: { id: 'friend', display_name: 'Friend' },
      tracks: { total: 2 },
    },
    {
      id: FOLLOWED,
      name: 'Editorial',
      snapshot_id: 'followed-1',
      owner: { id: 'editor', display_name: 'Editor' },
      items: { total: 100 },
    },
  ]
  entries = {
    [OWNED]: [
      track('opening', {
        title: 'Opening',
        album: 'Example Album',
        albumId: ALBUM,
        addedAt: '2024-03-01T10:00:00Z',
      }),
      track('drive', { title: 'Night Drive - Other Remix' }),
      track('closing', { title: 'Closing', album: 'Second Album (Deluxe)' }),
      { added_at: '2024-03-02T10:00:00Z', is_local: true, item: null },
      { added_at: '2024-03-02T10:00:00Z', item: { type: 'episode', id: 'e' } },
      track('opening', { title: 'Opening', addedAt: '2023-01-01T00:00:00Z' }),
    ],
    [SHARED]: [
      track('opening', {
        title: 'Opening',
        album: 'Example Album',
        albumId: ALBUM,
        addedAt: '2022-06-01T00:00:00Z',
      }),
      track('other', { title: 'Elsewhere', artists: ['Someone Else'] }),
    ],
  }
  liked = [
    {
      added_at: '2021-01-01T00:00:00Z',
      track: track('closing', { title: 'Closing' }).item,
    },
  ]
  request.mockReset()
  request.mockImplementation(async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/v1/me') return Response.json({ id: 'owner' })
    if (url.pathname === '/v1/me/playlists')
      return Response.json({
        items: playlists,
        total: playlists.length,
        offset: 0,
        next: null,
      })
    if (url.pathname === '/v1/me/tracks') return page(liked, url)
    const playlistId = /^\/v1\/playlists\/([^/]+)\/items$/.exec(
      url.pathname,
    )?.[1]
    const listed = playlistId ? entries[playlistId] : undefined
    if (listed) return page(listed, url)
    throw new Error('Unexpected offline provider request')
  })
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.lastfmScrobble)
  await databaseClient.delete(schema.playlist)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.tag)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.delete(schema.providerRequestEvent)
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('Spotify playlist imports', () => {
  it('lists the account playlists and marks the ones Spotify lets it read', async () => {
    const listed = await listSpotifyPlaylists(USER_ID)
    expect(listed.total).toBe(3)
    expect(
      listed.playlists.map((item) => [
        item.name,
        item.importable,
        item.trackTotal,
        item.stored,
      ]),
    ).toEqual([
      ['Morning', true, 3, null],
      ['Shared', true, 2, null],
      ['Editorial', false, 100, null],
    ])
    expect(await databaseClient.select().from(schema.scrapeJob)).toEqual([])
  })

  it('imports playlists and Liked Songs as separate sources, never requesting a playlist it cannot read', async () => {
    const result = await importAll({
      playlists: [
        chosen(OWNED, 'Morning'),
        chosen(SHARED, 'Shared'),
        chosen(FOLLOWED, 'Editorial'),
        chosen(spotifyId('gone'), 'Gone'),
      ],
      likedSongs: true,
    })
    expect(result).toMatchObject({ queued: 3, skipped: 2 })
    expect(result.warnings).toHaveLength(2)
    expect(requestedPaths()).not.toContain(`/v1/playlists/${FOLLOWED}/items`)

    expect(await titles()).toEqual([
      'Closing',
      'Elsewhere',
      'Night Drive - Other Remix',
      'Opening',
    ])
    const summaries = await listPlaylists()
    expect(
      summaries.map((item) => [item.name, item.source, item.trackCount]),
    ).toEqual([
      ['Liked Songs', 'spotify-liked', 1],
      ['Morning', 'spotify', 3],
      ['Shared', 'spotify', 2],
    ])
    const [opening] = (await listTracks(trackQuery({ q: 'Opening' }))).items
    expect(opening).toMatchObject({
      artists: ['The Examples'],
      albumName: 'Example Album',
      durationSec: 200,
      isrc: 'AA-BB1-20-00001',
      // The earliest date across both playlists and the repeated entry.
      dateAdded: '2022-06-01T00:00:00.000Z',
      playlists: [
        { name: 'Morning', id: expect.any(String) },
        { name: 'Shared', id: expect.any(String) },
      ],
    })

    const state = await getSpotifyPlaylistImports()
    expect(state.likedSongs.stored?.trackCount).toBe(1)
    expect(state.jobs[OWNED]?.status).toBe('succeeded')
    const job = await getJob(state.jobs[OWNED]?.jobId ?? '')
    expect(job?.logs.map((log) => log.message).join(' ')).toContain(
      'Imported 3 tracks from Morning. 2 entries were skipped',
    )
    const listed = await listSpotifyPlaylists(USER_ID)
    expect(listed.playlists[0]).toMatchObject({
      current: true,
      stored: { trackCount: 3 },
    })
  })

  it('filters tracks by the intersection of playlists', async () => {
    await importAll({
      playlists: [chosen(OWNED, 'Morning'), chosen(SHARED, 'Shared')],
      likedSongs: true,
    })
    expect(await titles({ filters: required('Morning', 'Shared') })).toEqual([
      'Opening',
    ])
    expect(
      await titles({ filters: required('Morning', 'Liked Songs') }),
    ).toEqual(['Closing'])
    expect(
      await titles({
        filters: JSON.stringify([
          { field: 'playlist', value: 'Shared', mode: 'any' },
          { field: 'playlist', value: 'Liked Songs', mode: 'any' },
          { field: 'playlist', value: 'Morning', mode: 'exclude' },
        ]),
      }),
    ).toEqual(['Elsewhere'])
    const facets = await listTrackFilterOptions({ q: 'playlists' })
    expect(
      facets
        .filter((facet) => facet.field === 'playlist')
        .map((facet) => [facet.value, facet.count]),
    ).toEqual([
      ['Morning', 3],
      ['Shared', 2],
      ['Liked Songs', 1],
    ])
  })

  it('links tracks to library albums in both directions and shows the album tags', async () => {
    await addAlbum('album-by-id', 'Example Album (Remastered)', {
      spotifyAlbumId: ALBUM,
      tag: 'Dream Pop',
    })
    await addAlbum('album-by-title', 'Second Album', { tracks: ['Closing'] })
    await addAlbum('album-unrelated', 'Unrelated')
    await importAll({
      playlists: [chosen(OWNED, 'Morning'), chosen(SHARED, 'Shared')],
      likedSongs: false,
    })

    const items = (await listTracks(trackQuery())).items
    expect(
      items.map((item) => [
        item.title,
        item.album?.id ?? null,
        item.albumLinkStrategy,
      ]),
    ).toEqual([
      ['Closing', 'album-by-title', 'album-title'],
      ['Elsewhere', null, null],
      ['Night Drive - Other Remix', null, null],
      ['Opening', 'album-by-id', 'spotify-album'],
    ])
    expect(items[3]?.albumTags).toEqual(['Dream Pop'])
    expect(
      await titles({
        filters: JSON.stringify([
          { field: 'genre', value: 'Dream Pop', mode: 'required' },
        ]),
      }),
    ).toEqual(['Opening'])
    expect(
      await titles({
        filters: JSON.stringify([
          { field: 'albumLink', value: 'Not in library', mode: 'required' },
        ]),
      }),
    ).toEqual(['Elsewhere', 'Night Drive - Other Remix'])

    const albums = await listAlbums(
      AlbumQuerySchema.parse({
        filters: required('Shared'),
        sortBy: 'title',
        direction: 'asc',
      }),
    )
    expect(albums.items.map((item) => item.id)).toEqual(['album-by-id'])
    expect(albums.items[0]?.playlists.map((item) => item.name)).toEqual([
      'Morning',
      'Shared',
    ])
    expect(
      (await listAlbumFilterOptions({ q: 'playlist' }))
        .filter((facet) => facet.field === 'playlist')
        .map((facet) => [facet.value, facet.count]),
    ).toEqual([
      ['Morning', 2],
      ['Shared', 1],
    ])
    expect(await getAlbumPlaylists('album-by-id')).toEqual({
      playlists: [
        { id: expect.any(String), name: 'Morning', trackCount: 1 },
        { id: expect.any(String), name: 'Shared', trackCount: 1 },
      ],
      tracks: [
        {
          id: expect.any(String),
          title: 'Opening',
          spotifyTrackId: spotifyId('opening'),
          playlists: ['Morning', 'Shared'],
        },
      ],
    })
    expect(
      (await listPlaylists()).map((item) => [
        item.name,
        item.linkedTrackCount,
        item.albumCount,
      ]),
    ).toEqual([
      ['Morning', 2, 2],
      ['Shared', 1, 1],
    ])

    // An album added after the import picks up its tracks on the next relink.
    await addAlbum('album-later', 'Night Drive', {
      tracks: ['Night Drive (Other Remix)'],
    })
    await relinkLastfmScrobbles()
    const [remix] = (await listTracks(trackQuery({ q: 'Night Drive' }))).items
    expect(remix?.album?.id).toBe('album-later')
  })

  it('counts scrobbles towards tracks by artist and title', async () => {
    await addScrobbles('the examples', 'opening', 3)
    await addScrobbles('Examples', 'Night Drive (Other Remix)', 2)
    await addScrobbles('The Examples', 'Night Drive', 4)
    await addScrobbles('Different Band', 'Closing', 5)
    await importAll({
      playlists: [chosen(OWNED, 'Morning')],
      likedSongs: false,
    })

    const items = (
      await listTracks(trackQuery({ sortBy: 'scrobbles', direction: 'desc' }))
    ).items
    expect(items.map((item) => [item.title, item.scrobbles])).toEqual([
      ['Opening', 3],
      ['Night Drive - Other Remix', 2],
      ['Closing', 0],
    ])
    const detail = await getTrackDetail(items[0]?.id ?? '')
    expect(detail?.listening).toMatchObject({
      total: 3,
      firstListenedAt: '2025-01-01T12:00:00.000Z',
      lastListenedAt: '2025-01-03T12:00:00.000Z',
      months: [{ month: '2025-01', count: 3 }],
      sources: [
        {
          artistName: 'the examples',
          trackName: 'opening',
          count: 3,
          strategy: 'exact',
        },
      ],
    })

    // Scrobbles synced after the import are counted on the next relink.
    await addScrobbles('The Examples', 'Closing', 2)
    await relinkLastfmScrobbles()
    expect(
      (await listTracks(trackQuery({ q: 'Closing' }))).items[0]?.scrobbles,
    ).toBe(2)
  })

  it('skips an unchanged playlist and replaces a changed one, dropping tracks left in no playlist', async () => {
    await importAll({
      playlists: [chosen(OWNED, 'Morning'), chosen(SHARED, 'Shared')],
      likedSongs: false,
    })
    request.mockClear()
    await importAll({
      playlists: [chosen(OWNED, 'Morning')],
      likedSongs: false,
    })
    expect(requestedPaths()).not.toContain(`/v1/playlists/${OWNED}/items`)

    playlists[0] = { ...playlists[0], snapshot_id: 'owned-2', name: 'Mornings' }
    entries[OWNED] = [track('drive', { title: 'Night Drive - Other Remix' })]
    await importAll({
      playlists: [chosen(OWNED, 'Morning')],
      likedSongs: false,
    })
    // "Opening" stays through the other playlist; "Closing" is in none.
    expect(await titles()).toEqual([
      'Elsewhere',
      'Night Drive - Other Remix',
      'Opening',
    ])
    expect(
      (await listPlaylists()).map((item) => [item.name, item.trackCount]),
    ).toEqual([
      ['Mornings', 1],
      ['Shared', 2],
    ])
  })

  it('keeps the album members of a legacy playlist with the same name', async () => {
    await addAlbum('legacy-album', 'Legacy Album')
    await databaseClient
      .insert(schema.playlist)
      .values({ id: 'legacy-morning', name: 'Morning', kind: 'playlist' })
    await databaseClient
      .insert(schema.playlistItem)
      .values({ playlistId: 'legacy-morning', mediaItemId: 'legacy-album' })
    await importAll({
      playlists: [chosen(OWNED, 'Morning')],
      likedSongs: false,
    })

    const [morning] = await listPlaylists()
    expect(morning).toMatchObject({
      id: 'legacy-morning',
      source: 'spotify',
      trackCount: 3,
      albumCount: 1,
    })
    expect(await removeImportedPlaylist('legacy-morning')).toEqual({
      removedTracks: 3,
    })
    expect(await listPlaylists()).toMatchObject([
      { id: 'legacy-morning', source: null, trackCount: 0, albumCount: 1 },
    ])
    expect(await titles()).toEqual([])
  })

  it('removes an imported playlist and only the tracks in no other playlist', async () => {
    await importAll({
      playlists: [chosen(OWNED, 'Morning'), chosen(SHARED, 'Shared')],
      likedSongs: false,
    })
    const morning = (await listPlaylists()).find(
      (item) => item.name === 'Morning',
    )
    expect(await removeImportedPlaylist(morning?.id ?? '')).toEqual({
      removedTracks: 2,
    })
    expect(await titles()).toEqual(['Elsewhere', 'Opening'])
    await expect(removeImportedPlaylist('missing')).rejects.toMatchObject({
      response: { statusCode: 404 },
    })
  })

  it('stores nothing when a playlist is larger than one import reads', async () => {
    reportedTotal = SPOTIFY_PLAYLIST_ITEM_LIMIT + 1
    await importAll({
      playlists: [chosen(OWNED, 'Morning')],
      likedSongs: false,
    })
    const [job] = await databaseClient.select().from(schema.scrapeJob)
    expect(job).toMatchObject({ status: 'failed' })
    expect(job?.errorMessage).toContain('more than 10,000 tracks')
    expect(await databaseClient.select().from(schema.playlist)).toEqual([])
    expect(
      await databaseClient
        .select()
        .from(schema.mediaItem)
        .where(eq(schema.mediaItem.mediaType, 'track')),
    ).toEqual([])
  })
})
