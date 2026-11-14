import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
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
  PlaylistDetailQuerySchema,
  PlaylistEntrySortSchema,
  SPOTIFY_PLAYLIST_ADD_ALBUM_TASK,
  SPOTIFY_PLAYLIST_IMPORT_TASK,
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
const account = vi.hoisted(() => ({ playlistChanges: true }))
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
    playlistChanges: account.playlistChanges,
  }),
  spotifyPlaylistToken: async () => 'fixture-token',
  spotifyPlaylistChangeToken: async () => 'fixture-change-token',
  spotifyOperation: async (execute: (send: typeof fetch) => Promise<unknown>) =>
    execute((input, init) => request(input, init)),
}))
import {
  getSpotifyPlaylistImports,
  queueSpotifyPlaylistImports,
} from '@/services/spotify-playlists'
import {
  getSpotifyPlaylists,
  queueSpotifyPlaylistListing,
} from '@/services/spotify-playlist-listing'
import {
  listSpotifyPlaylistAdditions,
  queueSpotifyPlaylistAddition,
} from '@/services/spotify-playlist-additions'
import { queueDueSpotifyPlaylistSyncs } from '@/services/spotify-playlist-sync'
import { getJob, processQueuedJobs, retryJob } from '@/services/jobs'
import {
  getPlaylistDetail,
  getTrackDetail,
  listPlaylists,
  listTrackFilterOptions,
  listTracks,
  removeImportedPlaylist,
  updatePlaylistSyncSchedule,
} from '@/services/tracks'
import { getAlbumPlaylists } from '@/services/album-playlists'
import { listAlbumFilterOptions, listAlbums } from '@/services/media'
import { relinkLastfmScrobbles } from '@/services/lastfm-scrobbles'

const USER_ID = 'playlist-user'
const listener = 'fixture-listener'
const spotifyId = (name: string) => name.padEnd(22, '0')
const OWNED = spotifyId('owned')
const SHARED = spotifyId('shared')
const FOLLOWED = spotifyId('followed')
const ALBUM = spotifyId('album')
const ADDED_ALBUM = spotifyId('addedalbum')
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
// Spotify's album track lists, and the tracks it can add to a playlist.
let albumTracks: Record<string, Entry[]> = {}
let catalog = new Map<string, Entry>()
// Answers an addition request: `applied` adds the tracks before the status.
let additionFailure: (call: number) => {
  status: number
  applied: boolean
} = () => ({
  status: 201,
  applied: true,
})

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

/** The track URIs sent in each addition request, in order. */
const addedUris = () =>
  request.mock.calls.flatMap(([, init]) =>
    init?.method === 'POST'
      ? [
          z
            .object({ uris: z.array(z.string()) })
            .parse(JSON.parse(String(init.body))).uris,
        ]
      : [],
  )

const playlistJson = (id: string) => {
  const item = playlists.find((playlist) => playlist.id === id)
  if (!item) return null
  const owner = z.object({ id: z.string() }).parse(item.owner)
  const readable = owner.id === 'owner' || item.collaborative === true
  return Response.json({
    ...item,
    tracks: undefined,
    items: readable ? { total: entries[id]?.length ?? 0 } : undefined,
  })
}

function albumTrack(id: string, title: string, number: number): Entry {
  const entry = {
    id,
    name: title,
    disc_number: 1,
    track_number: number,
    duration_ms: 180000,
    artists: [{ name: 'The Examples' }],
  }
  catalog.set(id, {
    added_at: '2025-02-01T00:00:00Z',
    item: {
      ...entry,
      type: 'track',
      album: { id: ADDED_ALBUM, name: 'Added Album' },
    },
  })
  return entry
}

async function addAlbum(
  id: string,
  title: string,
  options: {
    spotifyAlbumId?: string
    tracks?: string[]
    trackIds?: string[]
    tag?: string
  } = {},
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
      externalId: options.trackIds?.[index],
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
      username: listener,
      listenedAt: new Date(Date.UTC(2025, 0, 1 + index, 12)),
      artistName,
      trackName,
      artistKey: albumNameKey(artistName),
      trackKey: albumNameKey(trackName),
    })),
  )
}

async function listAll() {
  await queueSpotifyPlaylistListing(USER_ID)
  await processQueuedJobs()
  return getSpotifyPlaylists(USER_ID)
}

/** Lists the account's playlists, then imports the chosen ones. */
async function importAll(
  input: Parameters<typeof queueSpotifyPlaylistImports>[0],
) {
  await listAll()
  const result = await queueSpotifyPlaylistImports(input, USER_ID)
  await processQueuedJobs()
  return result
}

const chosen = (id: string, name: string) => ({ spotifyId: id, name })
const DAY = 24 * 60 * 60 * 1000
const detailQuery = (input: Record<string, unknown> = {}) =>
  PlaylistDetailQuerySchema.parse(input)

async function playlistId(name: string) {
  const found = (await listPlaylists()).find((item) => item.name === name)
  if (!found) throw new Error(`Missing playlist ${name}`)
  return found.id
}

const tasks = async (task: string) =>
  (await databaseClient.select().from(schema.scrapeJob)).filter(
    (row) => row.options.task === task,
  )

const entryIds = (list: Entry[]) =>
  list.flatMap((entry) => {
    const parsed = z
      .object({ item: z.object({ id: z.string() }) })
      .safeParse(entry)
    return parsed.success ? [parsed.data.item.id] : []
  })
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
  albumTracks = {}
  catalog = new Map()
  account.playlistChanges = true
  additionFailure = () => ({ status: 201, applied: true })
  let additions = 0
  request.mockReset()
  request.mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    const target = /^\/v1\/playlists\/([^/]+)$/.exec(url.pathname)?.[1]
    if (target) {
      const found = playlistJson(target)
      if (found) return found
    }
    const adding = /^\/v1\/playlists\/([^/]+)\/items$/.exec(url.pathname)?.[1]
    if (adding && init?.method === 'POST') {
      additions += 1
      const outcome = additionFailure(additions)
      if (outcome.applied) {
        const { uris } = z
          .object({ uris: z.array(z.string()).max(100) })
          .parse(JSON.parse(String(init.body)))
        for (const uri of uris) {
          const entry = catalog.get(uri.replace('spotify:track:', ''))
          if (!entry) throw new Error('Unknown track URI')
          entries[adding] = [...(entries[adding] ?? []), entry]
        }
        playlists = playlists.map((item) =>
          item.id === adding
            ? { ...item, snapshot_id: `${adding}-${additions}` }
            : item,
        )
      }
      return Response.json(
        { snapshot_id: `${adding}-${additions}` },
        { status: outcome.status },
      )
    }
    const album = /^\/v1\/albums\/([^/]+)\/tracks$/.exec(url.pathname)?.[1]
    const listedAlbum = album ? albumTracks[album] : undefined
    if (listedAlbum) return page(listedAlbum, url)
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
  await databaseClient.delete(schema.spotifyPlaylistListing)
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
  it('lists the account playlists in a job and marks the ones Spotify lets it read', async () => {
    const listed = await listAll()
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
    expect(listed.playlists[2]).toMatchObject({
      notImportableReason: expect.stringContaining('owns or collaborates'),
      spotifyUrl: `https://open.spotify.com/playlist/${FOLLOWED}`,
    })
    expect(listed.playlists[0]?.notImportableReason).toBeNull()
    expect(listed.listedAt).toEqual(expect.any(String))
    expect(listed.job).toMatchObject({
      status: 'succeeded',
      progress: { pagesRead: 1, totalPages: 1 },
    })
    // Only the listing job was created, and reading the list asks Spotify nothing.
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(1)
    request.mockClear()
    expect(await getSpotifyPlaylists(USER_ID)).toEqual(listed)
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps one listing job while one is queued, and reads no playlists before the first listing', async () => {
    expect(await getSpotifyPlaylists(USER_ID)).toMatchObject({
      playlists: [],
      total: 0,
      listedAt: null,
      job: null,
    })
    const first = await queueSpotifyPlaylistListing(USER_ID)
    const second = await queueSpotifyPlaylistListing(USER_ID)
    expect(first.job?.status).toBe('queued')
    expect(second.job?.jobId).toBe(first.job?.jobId)
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(1)
    expect(request).not.toHaveBeenCalled()
    await processQueuedJobs()
    const third = await queueSpotifyPlaylistListing(USER_ID)
    expect(third.job?.jobId).not.toBe(first.job?.jobId)
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
    expect(requestedPaths()).not.toContain(`/v1/playlists/${FOLLOWED}`)

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
    const listed = await getSpotifyPlaylists(USER_ID)
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

    const filters = JSON.stringify([
      { field: 'source', value: 'Spotify playlists', mode: 'required' },
    ])
    const items = (
      await listTracks(
        trackQuery({ filters, sortBy: 'scrobbles', direction: 'desc' }),
      )
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
      (await listTracks(trackQuery({ filters, q: 'Closing' }))).items[0]
        ?.scrobbles,
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
    const job = (await databaseClient.select().from(schema.scrapeJob)).find(
      (row) => row.options.task === SPOTIFY_PLAYLIST_IMPORT_TASK,
    )
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

  it('reports the pages an import has read while it runs', async () => {
    entries[OWNED] = Array.from({ length: 120 }, (_, index) =>
      track(`b${String(index).padStart(3, '0')}x`),
    )
    playlists[0] = { ...playlists[0], items: { total: 120 } }
    const seen: unknown[] = []
    const answer = request.getMockImplementation()
    request.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === `/v1/playlists/${OWNED}/items`) {
        const [job] = await tasks(SPOTIFY_PLAYLIST_IMPORT_TASK)
        seen.push(job?.options.progress)
      }
      if (!answer) throw new Error('Missing Spotify fixture')
      return answer(input, init)
    })
    await importAll({
      playlists: [chosen(OWNED, 'Morning')],
      likedSongs: false,
    })
    expect(seen).toEqual([
      { pagesRead: 0, totalPages: 3 },
      { pagesRead: 1, totalPages: 3 },
      { pagesRead: 2, totalPages: 3 },
    ])
    const done = { pagesRead: 3, totalPages: 3 }
    expect(
      (await getSpotifyPlaylists(USER_ID)).playlists[0]?.job,
    ).toMatchObject({ status: 'succeeded', progress: done })
    expect((await getSpotifyPlaylistImports()).jobs[OWNED]?.progress).toEqual(
      done,
    )
    const morning = await playlistId('Morning')
    expect(
      (await getPlaylistDetail(morning, detailQuery())).sync.job?.progress,
    ).toEqual(done)
  })

  it('imports a playlist again on its schedule and counts an unchanged playlist as checked', async () => {
    await importAll({ playlists: [chosen(OWNED, 'Morning')], likedSongs: true })
    const morning = await playlistId('Morning')
    // Schedules are off until set.
    expect(await queueDueSpotifyPlaylistSyncs(Date.now() + 400 * DAY)).toBe(
      false,
    )
    const summary = await updatePlaylistSyncSchedule(morning, 'daily', USER_ID)
    expect(summary.sync).toMatchObject({
      syncable: true,
      schedule: 'daily',
      job: { status: 'succeeded' },
    })
    const checkedAt = Date.parse(summary.sync.lastCheckedAt ?? '')
    const due = Date.parse(summary.sync.nextScheduledAt ?? '')
    expect(due - checkedAt).toBe(DAY)
    expect(await queueDueSpotifyPlaylistSyncs(due - 1000)).toBe(false)
    expect(await queueDueSpotifyPlaylistSyncs(due)).toBe(true)
    // A queued import is not queued again.
    expect(await queueDueSpotifyPlaylistSyncs(due)).toBe(false)
    expect(
      (await tasks(SPOTIFY_PLAYLIST_IMPORT_TASK)).filter(
        (job) => job.status === 'queued',
      ),
    ).toHaveLength(1)
    expect(
      (await getPlaylistDetail(morning, detailQuery())).sync,
    ).toMatchObject({ nextScheduledAt: null, job: { status: 'queued' } })
    await new Promise((resolve) => setTimeout(resolve, 5))
    request.mockClear()
    await processQueuedJobs()
    // Unchanged: one request for the playlist and none for its tracks.
    expect(requestedPaths()).toEqual([`/v1/playlists/${OWNED}`])
    const checked = await getPlaylistDetail(morning, detailQuery())
    expect(checked.importedAt).toBe(summary.importedAt)
    expect(Date.parse(checked.sync.lastCheckedAt ?? '')).toBeGreaterThan(
      checkedAt,
    )
    expect(await queueDueSpotifyPlaylistSyncs(due)).toBe(false)

    // A changed playlist is read again on the next due check.
    playlists[0] = { ...playlists[0], snapshot_id: 'owned-2' }
    entries[OWNED] = [track('drive', { title: 'Night Drive - Other Remix' })]
    const next = Date.parse(checked.sync.nextScheduledAt ?? '')
    expect(await queueDueSpotifyPlaylistSyncs(next)).toBe(true)
    await processQueuedJobs()
    expect((await getPlaylistDetail(morning, detailQuery())).trackCount).toBe(1)
  })

  it('queues nothing while Spotify cools down or after a failed import', async () => {
    await importAll({
      playlists: [chosen(OWNED, 'Morning')],
      likedSongs: false,
    })
    const morning = await playlistId('Morning')
    const { sync } = await updatePlaylistSyncSchedule(morning, '1h', USER_ID)
    const due = Date.parse(sync.nextScheduledAt ?? '')
    await databaseClient.insert(schema.providerRequestState).values({
      provider: 'spotify',
      cooldownUntil: new Date(Date.now() + DAY),
    })
    expect(await queueDueSpotifyPlaylistSyncs(due)).toBe(false)
    await databaseClient.delete(schema.providerRequestState)

    playlists[0] = { ...playlists[0], snapshot_id: 'owned-2' }
    reportedTotal = SPOTIFY_PLAYLIST_ITEM_LIMIT + 1
    await queueSpotifyPlaylistImports(
      { playlists: [chosen(OWNED, 'Morning')], likedSongs: false },
      USER_ID,
    )
    await processQueuedJobs()
    expect(
      (await getPlaylistDetail(morning, detailQuery())).sync,
    ).toMatchObject({ nextScheduledAt: null, job: { status: 'failed' } })
    expect(await queueDueSpotifyPlaylistSyncs(due + 365 * DAY)).toBe(false)
    await expect(
      updatePlaylistSyncSchedule('missing', 'daily', USER_ID),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
  })

  it('returns a playlist with its entries in playlist order, a page at a time', async () => {
    await addAlbum('legacy-album', 'Legacy Album')
    await databaseClient
      .insert(schema.playlist)
      .values({ id: 'legacy-morning', name: 'Morning', kind: 'playlist' })
    await databaseClient.insert(schema.playlistItem).values({
      playlistId: 'legacy-morning',
      mediaItemId: 'legacy-album',
      position: 1,
    })
    await importAll({
      playlists: [chosen(OWNED, 'Morning')],
      likedSongs: false,
    })

    const first = await getPlaylistDetail(
      'legacy-morning',
      detailQuery({ size: 2 }),
    )
    expect(first).toMatchObject({
      id: 'legacy-morning',
      source: 'spotify',
      trackCount: 3,
      albumCount: 1,
      acceptsAdditions: true,
      sync: { syncable: true, schedule: 'off', nextScheduledAt: null },
      items: { page: 1, size: 2, totalCount: 4, pageCount: 2 },
    })
    const summarize = (detail: typeof first) =>
      detail.items.items.map((entry) =>
        entry.kind === 'track'
          ? [entry.kind, entry.position, entry.track.title, entry.addedAt]
          : [entry.kind, entry.position, entry.album.title, entry.addedAt],
      )
    expect(summarize(first)).toEqual([
      ['track', 1, 'Opening', '2023-01-01T00:00:00.000Z'],
      ['track', 2, 'Night Drive - Other Remix', '2024-03-01T10:00:00.000Z'],
    ])
    expect(first.items.items[0]).toMatchObject({
      track: { spotifyTrackId: spotifyId('opening') },
    })
    const second = await getPlaylistDetail(
      'legacy-morning',
      detailQuery({ size: 2, page: 2 }),
    )
    expect(summarize(second)).toEqual([
      ['track', 3, 'Closing', '2024-03-01T10:00:00.000Z'],
      ['album', 1, 'Legacy Album', null],
    ])
    expect(second.items.items[1]).toMatchObject({
      album: { id: 'legacy-album', artists: ['The Examples'] },
    })
    expect(first.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const ascending = await getPlaylistDetail(
      'legacy-morning',
      detailQuery({ size: 1, sortBy: 'title', direction: 'asc' }),
    )
    expect(summarize(ascending)).toEqual([
      ['track', 3, 'Closing', '2024-03-01T10:00:00.000Z'],
    ])
    const nextTitle = await getPlaylistDetail(
      'legacy-morning',
      detailQuery({ size: 1, page: 2, sortBy: 'title', direction: 'asc' }),
    )
    expect(summarize(nextTitle)).toEqual([['album', 1, 'Legacy Album', null]])
    const descending = await getPlaylistDetail(
      'legacy-morning',
      detailQuery({ size: 1, sortBy: 'title', direction: 'desc' }),
    )
    expect(summarize(descending)).toEqual([
      ['track', 1, 'Opening', '2023-01-01T00:00:00.000Z'],
    ])
    for (const sortBy of PlaylistEntrySortSchema.options) {
      for (const direction of ['asc', 'desc']) {
        const sorted = await getPlaylistDetail(
          'legacy-morning',
          detailQuery({ sortBy, direction }),
        )
        expect(sorted.items.totalCount).toBe(4)
        expect(sorted.items.items).toHaveLength(4)
        if (sortBy === 'added')
          expect(sorted.items.items.at(-1)?.addedAt).toBeNull()
      }
    }
    await expect(
      getPlaylistDetail('missing', detailQuery()),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
  })

  it('adds the missing tracks of an album to a Spotify playlist, then imports the playlist again', async () => {
    await importAll({ playlists: [chosen(OWNED, 'Morning')], likedSongs: true })
    const morning = await playlistId('Morning')
    const NEW_ONE = spotifyId('newone')
    const NEW_TWO = spotifyId('newtwo')
    albumTrack(NEW_ONE, 'New One', 2)
    albumTrack(NEW_TWO, 'New Two', 3)
    // The stored track list has Spotify IDs; Opening is already in the playlist.
    await addAlbum('added-album', 'Added Album', {
      spotifyAlbumId: ADDED_ALBUM,
      tracks: ['Opening', 'New One', 'New Two'],
      trackIds: [spotifyId('opening'), NEW_ONE, NEW_TWO],
    })
    const queued = await queueSpotifyPlaylistAddition(
      morning,
      { albumId: 'added-album' },
      USER_ID,
    )
    expect(queued).toMatchObject({
      playlistId: morning,
      albumId: 'added-album',
      job: { status: 'queued', progress: null },
    })
    const again = await queueSpotifyPlaylistAddition(
      morning,
      { albumId: 'added-album' },
      USER_ID,
    )
    expect(again.job.jobId).toBe(queued.job.jobId)
    request.mockClear()
    await processQueuedJobs()

    expect(addedUris()).toEqual([
      [`spotify:track:${NEW_ONE}`, `spotify:track:${NEW_TWO}`],
    ])
    // The stored copy was current and the album's track IDs were stored, so
    // the job read only the playlist's version; the import then read it all.
    expect(
      request.mock.calls.map(
        ([input, init]) =>
          `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`,
      ),
    ).toEqual([
      `GET /v1/playlists/${OWNED}`,
      `POST /v1/playlists/${OWNED}/items`,
      `GET /v1/playlists/${OWNED}`,
      `GET /v1/playlists/${OWNED}/items`,
    ])
    const job = await getJob(queued.job.jobId)
    expect(job).toMatchObject({
      status: 'succeeded',
      options: { added: 2, alreadyPresent: 1, importJobId: expect.any(String) },
    })
    expect(job?.logs.map((log) => log.message).join(' ')).toContain(
      'Added 2 tracks of Added Album to Morning. 1 were already in the playlist.',
    )
    // The follow-on import stored what Spotify now holds.
    const detail = await getPlaylistDetail(morning, detailQuery())
    expect(
      detail.items.items.map((entry) =>
        entry.kind === 'track' ? entry.track.title : entry.album.title,
      ),
    ).toEqual([
      'Opening',
      'Night Drive - Other Remix',
      'Closing',
      'New One',
      'New Two',
    ])
    expect(await listSpotifyPlaylistAdditions('added-album')).toEqual({
      additions: [
        {
          playlistId: morning,
          albumId: 'added-album',
          job: expect.objectContaining({
            jobId: queued.job.jobId,
            status: 'succeeded',
          }),
        },
      ],
    })
    expect(await listSpotifyPlaylistAdditions('other-album')).toEqual({
      additions: [],
    })

    // Adding it again sends nothing and queues no import.
    request.mockClear()
    await queueSpotifyPlaylistAddition(
      morning,
      { albumId: 'added-album' },
      USER_ID,
    )
    await processQueuedJobs()
    expect(addedUris()).toEqual([])
    expect(requestedPaths()).toEqual([`/v1/playlists/${OWNED}`])
  })

  it('adds a long album in batches and never adds a track twice when retried after a failure', async () => {
    await importAll({
      playlists: [chosen(OWNED, 'Morning')],
      likedSongs: false,
    })
    const morning = await playlistId('Morning')
    const ids = Array.from({ length: 205 }, (_, index) =>
      spotifyId(`t${String(index).padStart(3, '0')}x`),
    )
    albumTracks[ADDED_ALBUM] = ids.map((id, index) =>
      albumTrack(id, `Track ${index + 1}`, index + 1),
    )
    // Without Spotify IDs in the stored track list, the album is read from Spotify.
    await addAlbum('long-album', 'Long Album', {
      spotifyAlbumId: ADDED_ALBUM,
      tracks: ['Track 1'],
    })
    // The second request reaches Spotify, but its answer is lost.
    additionFailure = (call) =>
      call === 2
        ? { status: 500, applied: true }
        : { status: 201, applied: true }
    const queued = await queueSpotifyPlaylistAddition(
      morning,
      { albumId: 'long-album' },
      USER_ID,
    )
    request.mockClear()
    await processQueuedJobs()
    expect(requestedPaths()).toContain(`/v1/albums/${ADDED_ALBUM}/tracks`)
    expect(addedUris().map((batch) => batch.length)).toEqual([100, 100])
    expect(await getJob(queued.job.jobId)).toMatchObject({ status: 'failed' })
    expect(await tasks(SPOTIFY_PLAYLIST_IMPORT_TASK)).toHaveLength(1)

    request.mockClear()
    const retry = await retryJob(queued.job.jobId, USER_ID, false)
    await processQueuedJobs()
    // The retry read the playlist again and sent only the last five tracks.
    expect(requestedPaths()).toContain(`/v1/playlists/${OWNED}/items`)
    expect(addedUris()).toEqual([
      ids.slice(200).map((id) => `spotify:track:${id}`),
    ])
    expect(await getJob(retry.id)).toMatchObject({
      status: 'succeeded',
      options: { added: 5, alreadyPresent: 200 },
    })
    expect(
      entryIds(entries[OWNED] ?? []).filter((id) => ids.includes(id)),
    ).toEqual(ids)
    expect(
      (await getPlaylistDetail(morning, detailQuery({ size: 1 }))).items
        .totalCount,
    ).toBe(208)
  })

  it('refuses additions the account cannot make before queueing anything', async () => {
    await databaseClient
      .insert(schema.playlist)
      .values({ id: 'legacy-only', name: 'Legacy', kind: 'playlist' })
    await addAlbum('unreferenced', 'Unreferenced')
    await addAlbum('referenced', 'Referenced', { spotifyAlbumId: ADDED_ALBUM })
    await importAll({
      playlists: [chosen(OWNED, 'Morning'), chosen(SHARED, 'Shared')],
      likedSongs: true,
    })
    const morning = await playlistId('Morning')
    const shared = await playlistId('Shared')
    const liked = await playlistId('Liked Songs')
    const add = (playlist: string, albumId: string) =>
      queueSpotifyPlaylistAddition(playlist, { albumId }, USER_ID)
    const refusal = (statusCode: number, message?: string) => ({
      response: {
        statusCode,
        ...(message ? { message: expect.stringContaining(message) } : {}),
      },
    })

    await expect(add(liked, 'referenced')).rejects.toMatchObject(
      refusal(422, 'Liked Songs'),
    )
    await expect(add('legacy-only', 'referenced')).rejects.toMatchObject(
      refusal(422, 'Only imported Spotify playlists'),
    )
    await expect(add(morning, 'unreferenced')).rejects.toMatchObject(
      refusal(422, 'no Spotify album reference'),
    )
    await expect(add(morning, 'missing')).rejects.toMatchObject(refusal(404))
    await expect(add('missing', 'referenced')).rejects.toMatchObject(
      refusal(404),
    )
    account.playlistChanges = false
    await expect(add(morning, 'referenced')).rejects.toMatchObject(
      refusal(422, 'Reconnect the Spotify account'),
    )
    account.playlistChanges = true

    // A playlist the account no longer collaborates on stops accepting albums.
    playlists[1] = { ...playlists[1], collaborative: false }
    await listAll()
    expect(
      (await listPlaylists()).map((item) => [item.name, item.acceptsAdditions]),
    ).toEqual([
      ['Liked Songs', false],
      ['Morning', true],
      ['Shared', false],
    ])
    await expect(add(shared, 'referenced')).rejects.toMatchObject(
      refusal(422, 'owns or collaborates'),
    )
    expect(await tasks(SPOTIFY_PLAYLIST_ADD_ALBUM_TASK)).toEqual([])
    expect(addedUris()).toEqual([])
  })

  it('stops an addition when Spotify no longer returns the playlist contents', async () => {
    await importAll({
      playlists: [chosen(OWNED, 'Morning')],
      likedSongs: false,
    })
    const morning = await playlistId('Morning')
    albumTrack(spotifyId('newone'), 'New One', 1)
    await addAlbum('added-album', 'Added Album', {
      spotifyAlbumId: ADDED_ALBUM,
      tracks: ['New One'],
      trackIds: [spotifyId('newone')],
    })
    await queueSpotifyPlaylistAddition(
      morning,
      { albumId: 'added-album' },
      USER_ID,
    )
    playlists[0] = { ...playlists[0], owner: { id: 'someone-else' } }
    await processQueuedJobs()
    const [job] = await tasks(SPOTIFY_PLAYLIST_ADD_ALBUM_TASK)
    expect(job).toMatchObject({ status: 'failed' })
    expect(job?.errorMessage).toContain('owns or collaborates')
    expect(addedUris()).toEqual([])
    expect(
      (await listPlaylists()).find((item) => item.id === morning)
        ?.acceptsAdditions,
    ).toBe(false)
  })
})
