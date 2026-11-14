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
import { TrackQuerySchema } from '@repo/schemas/tracks'
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
import {
  getTrackDetail,
  listTrackFilterOptions,
  listTracks,
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
  for (const [index, track] of tracks.entries())
    await databaseClient.insert(schema.track).values({
      id: `${id}-track-${index}`,
      albumMediaItemId: id,
      title: track.title,
      externalId: track.spotifyId ?? null,
      durationSec: track.durationSec ?? null,
      position: index + 1,
    })
  await databaseClient.insert(schema.tag).values({
    id: `${id}-tag`,
    name: 'Electronic',
    mediaType: 'album',
  })
  await databaseClient.insert(schema.mediaItemTag).values({
    mediaItemId: id,
    tagId: `${id}-tag`,
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
    expect(items.find((item) => item.id === 'mixedspotify')?.sources).toEqual([
      'spotify',
    ])
    const standalone = items.find((item) => item.id !== 'mixedspotify')
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
      sources: ['lastfm'],
      album: { id: 'linkedalbum', title: 'Linked Album' },
      albumTags: ['Electronic'],
      artworkUrl: 'https://example.com/album-artwork.jpg',
      releaseDate: '2019-04-05T00:00:00.000Z',
      spotifyTrackId: spotifyId('known'),
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
    expect(items).toHaveLength(2)
    expect(items.every((item) => item.spotifyTrackId === null)).toBe(true)
    expect(items.every((item) => item.durationSec === null)).toBe(true)
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
      spotifyUrl: null,
      album: { id: 'otherprovider' },
    })
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
    expect((await allTracks())[0]).toMatchObject({
      album: { id: 'datedalbum' },
      dateAdded: '2010-01-01T00:00:00.000Z',
      albumTags: ['Electronic'],
    })
    await databaseClient
      .delete(schema.mediaItem)
      .where(eq(schema.mediaItem.id, 'datedalbum'))
    await refreshTrackLinks(LISTENER)
    expect((await allTracks())[0]).toMatchObject({
      id: 'dated',
      album: null,
      albumTags: [],
      scrobbles: 1,
    })
  })
})
