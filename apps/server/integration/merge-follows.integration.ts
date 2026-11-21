import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { ArtistMergePlanRequestSchema } from '@repo/schemas/artist-merges'
import { ArtistMergeRequestSchema } from '@repo/schemas/artist-merges'
import {
  TrackMergePlanRequestSchema,
  TrackMergeRequestSchema,
} from '@repo/schemas/library-changes'
import { TrackQuerySchema } from '@repo/schemas/tracks'
import { env } from '@/env'
import { albumNameKey } from '@/lib/album-import-candidates'
import { standaloneLastfmTrackId } from '@/lib/track-matching'
import * as schema from '@/schemas/db'

const database = 'merge_follows_' + randomUUID().replaceAll('-', '')
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const fixture = drizzle(pool, { schema })

vi.mock('@/lib/db', () => ({
  get db() {
    return fixture
  },
}))
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async () => null,
  listLoadedScrapePlugins: async () => [],
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({
    apiKey: 'offline-fixture-key',
    username: 'Fixture-Listener',
  }),
}))

import { mergeArtists } from '@/services/artist-merges'
import { planArtistMerge } from '@/services/artist-merge-plan'
import { refreshArtistListeningTotals } from '@/services/artist-listening'
import { queryBrowseIds } from '@/services/browse'
import { refreshAlbumListening } from '@/services/lastfm-album-links'
import { refreshTrackAddedDates } from '@/services/spotify-playlists'
import {
  redoLibraryChange,
  undoLibraryChange,
} from '@/services/library-changes'
import { listTrackDuplicates } from '@/services/track-duplicates'
import { refreshTrackDuplicates } from '@/services/track-duplicate-refresh'
import { linkScrobblesToTracks } from '@/services/track-links'
import { planTrackMerge } from '@/services/track-merge-plan'
import { mergeTracks } from '@/services/track-merges'

const account = 'fixture-listener'
const band = 'Fixture Band'
const bandId = 'fixture-band'
const misspelt = 'Fixture Bnad'
const misspeltId = 'fixture-bnad'
const albumId = 'album-night'
const albumTitle = 'Night Harbour'
const scrobbledAlbum = 'Nite Harbour'
const titles = ['Low Tide', 'Lanterns', 'Undertow', 'Breakwater', 'Quay Lights']
const spotify = (position: number) => `night-${position}`
const lastfm = (title: string, artist = band) =>
  standaloneLastfmTrackId(account, {
    artistKey: albumNameKey(artist),
    trackKey: albumNameKey(title),
  })
const jam = 'Rehearsal Jam'

/** Scrobbles of each Last.fm title under the one album name. */
const plays: [string, number][] = [
  ['Low Tide', 5],
  ['Lanterns', 4],
  ['Undertow', 3],
  ['Breakwater', 2],
  ['Quay Lights', 1],
  [jam, 1],
]

const scrobbles = (
  artist: string,
  track: string,
  count: number,
  album: string | null,
) =>
  Array.from({ length: count }, (_, index) => ({
    id: `${albumNameKey(artist)}-${albumNameKey(track)}-${index}`,
    username: account,
    listenedAt: new Date(Date.UTC(2025, 0, 1 + index)),
    artistName: artist,
    artistKey: albumNameKey(artist),
    albumName: album,
    albumKey: album === null ? null : albumNameKey(album),
    trackName: track,
    trackKey: albumNameKey(track),
  }))

async function insertSpotifyTrack(
  id: string,
  title: string,
  artistId: string,
  album: { id: string; position: number } | null,
) {
  await fixture.insert(schema.mediaItem).values({
    id,
    slug: id,
    title,
    mediaType: 'track',
    sourceLabel: 'spotify',
  })
  await fixture.insert(schema.libraryTrack).values({
    mediaItemId: id,
    spotifyTrackId: id.replace(/\W/g, '').padEnd(22, '0').slice(-22),
    albumMediaItemId: album?.id ?? null,
    albumLinkStrategy: album ? 'album-track-list' : null,
  })
  await fixture
    .insert(schema.mediaCredit)
    .values({ mediaItemId: id, artistId, role: 'artist' })
  if (album)
    await fixture.insert(schema.track).values({
      id: `${id}-position`,
      albumMediaItemId: album.id,
      trackMediaItemId: id,
      title,
      position: album.position,
    })
}

/** A Last.fm-only track owning its one scrobbled name. */
async function insertLastfmTrack(
  title: string,
  artist: string,
  artistId: string,
) {
  const id = lastfm(title, artist)
  await fixture.insert(schema.mediaItem).values({
    id,
    slug: id,
    title,
    mediaType: 'track',
    sourceLabel: 'lastfm',
  })
  await fixture.insert(schema.libraryTrack).values({ mediaItemId: id })
  await fixture
    .insert(schema.mediaCredit)
    .values({ mediaItemId: id, artistId, role: 'artist' })
  await fixture.insert(schema.lastfmTrackSource).values({
    username: account,
    artistKey: albumNameKey(artist),
    trackKey: albumNameKey(title),
    trackMediaItemId: id,
  })
}

/** Everything a merge with follows can touch, as rows in a stable order. */
async function state() {
  const read = async (query: string) => (await pool.query(query)).rows
  return {
    media: await read('select * from media_item order by id'),
    tracks: await read('select * from library_track order by media_item_id'),
    positions: await read('select * from track order by id'),
    credits: await read(
      'select * from media_credit order by media_item_id, artist_id, role',
    ),
    artists: await read(
      'select id, name, merged_into_id, scrobble_count from artist order by id',
    ),
    sources: await read(
      'select * from lastfm_track_source order by username, artist_key, track_key',
    ),
    trackLinks: await read(
      `select username, artist_key, track_key, track_media_item_id, strategy
        from lastfm_track_link order by 1, 2, 3, 4`,
    ),
    albumLinks: await read(
      `select username, artist_key, album_key, album_media_item_id, source,
        strategy, candidate_ids, created_at from lastfm_album_link
        order by 1, 2, 3`,
    ),
    pointers: await read(
      'select id, album_media_item_id from lastfm_scrobble order by id',
    ),
    kept: await read(
      'select kind, low_id, high_id from library_keep_separate order by 1, 2, 3',
    ),
  }
}

async function owner(title: string, artist = band) {
  const { rows } = await pool.query(
    `select track_media_item_id as id from lastfm_track_source
      where artist_key = $1 and track_key = $2`,
    [albumNameKey(artist), albumNameKey(title)],
  )
  return rows[0]?.id
}

/** The duplicates group each track is in, as its sorted member IDs. */
async function duplicateGroups(ids: string[]) {
  return Promise.all(
    ids.map(async (id) => {
      const [group] = (await listTrackDuplicates(id)).items
      return group ? [...group.memberIds].sort() : null
    }),
  )
}

const trackPlan = (input: Record<string, unknown>) =>
  planTrackMerge(TrackMergePlanRequestSchema.parse(input))
const trackMerge = (input: Record<string, unknown>) =>
  mergeTracks(TrackMergeRequestSchema.parse(input))
const lowTide = { trackIds: [lastfm('Low Tide'), spotify(1)] }
const followed = titles.slice(1).map((title, index) => ({
  artistName: band,
  trackName: title,
  scrobbles: plays[index + 1]?.[1],
  fromTrackId: lastfm(title),
  toTrackId: spotify(index + 2),
  toTitle: title,
}))

const mockFetch = vi.fn<typeof fetch>(async () => {
  throw new Error('Unexpected provider request')
})
let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', mockFetch)
  await admin.connect()
  await admin.query('create database ' + database)
  created = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query('drop database ' + database)
  await admin.end()
  vi.unstubAllGlobals()
})

beforeEach(async () => {
  await fixture.delete(schema.libraryChange)
  await fixture.delete(schema.libraryKeepSeparate)
  await fixture.delete(schema.libraryMatchRejection)
  await fixture.delete(schema.lastfmAlbumLink)
  await fixture.delete(schema.lastfmScrobble)
  await fixture.delete(schema.lastfmTrackSource)
  await fixture.delete(schema.track)
  await fixture.delete(schema.mediaItem)
  await fixture.execute('update artist set merged_into_id = null')
  await fixture.delete(schema.artist)
  await fixture.insert(schema.artist).values([
    { id: bandId, name: band, sortName: band },
    { id: misspeltId, name: misspelt, sortName: misspelt },
  ])
  await fixture.insert(schema.mediaItem).values({
    id: albumId,
    slug: albumId,
    title: albumTitle,
    mediaType: 'album',
    sourceLabel: 'spotify',
  })
  await fixture.insert(schema.album).values({
    mediaItemId: albumId,
    spotifyUrl: `https://open.spotify.com/album/${albumId.padEnd(22, '0')}`,
    trackCount: titles.length,
    dateAdded: new Date(Date.UTC(2024, 0, 1)),
  })
  await fixture
    .insert(schema.mediaCredit)
    .values({ mediaItemId: albumId, artistId: bandId, role: 'artist' })
  for (const [index, title] of titles.entries())
    await insertSpotifyTrack(spotify(index + 1), title, bandId, {
      id: albumId,
      position: index + 1,
    })
  // The same album as Last.fm scrobbled it, under a misspelt album name.
  for (const [title, count] of plays) {
    await insertLastfmTrack(title, band, bandId)
    await fixture
      .insert(schema.lastfmScrobble)
      .values(scrobbles(band, title, count, scrobbledAlbum))
  }
  await linkScrobblesToTracks(account)
  await refreshTrackAddedDates(fixture)
  await refreshAlbumListening(fixture)
  await refreshArtistListeningTotals(fixture)
  await fixture.transaction((tx) => refreshTrackDuplicates(tx))
})

it('merges the album name and the titles that follow one merged title, and undoes it exactly', async () => {
  const before = await state()
  const spotifyIds = titles.map((_, index) => spotify(index + 1))
  const groupsBefore = await duplicateGroups(spotifyIds)
  // Each Last.fm title is a possible duplicate of its Spotify track.
  expect(groupsBefore).toEqual(
    titles.map((title, index) => [lastfm(title), spotify(index + 1)].sort()),
  )

  const plan = await trackPlan(lowTide)
  expect(plan.targetId).toBe(spotify(1))
  expect(plan.tracks.map((track) => track.outcome)).toEqual(['keep', 'merge'])
  expect(plan.also).toEqual({
    albumNames: [
      {
        artistName: band,
        albumName: scrobbledAlbum,
        scrobbles: 16,
        toAlbumId: albumId,
        toAlbumTitle: albumTitle,
      },
    ],
    titles: followed,
  })
  // Follows alone need no review.
  expect(plan.cautions).toEqual([])

  const change = await trackMerge(lowTide)
  expect(change).toMatchObject({
    kind: 'track',
    action: 'merge',
    target: { id: spotify(1) },
    nameCount: 5,
    details: {
      counts: { 'album-name': 1, title: 4 },
      labels: [scrobbledAlbum],
    },
    canUndo: true,
  })
  for (const [index, title] of titles.entries())
    expect(await owner(title)).toBe(spotify(index + 1))
  // A title with no matching track stays.
  expect(await owner(jam)).toBe(lastfm(jam))
  const after = await state()
  const remaining = after.tracks.map((row) => row.media_item_id)
  for (const title of titles) expect(remaining).not.toContain(lastfm(title))
  expect(remaining).toContain(lastfm(jam))
  expect(
    new Set(
      after.pointers
        .filter((row) => row.id.includes(albumNameKey('Lanterns')))
        .map((row) => row.album_media_item_id),
    ),
  ).toEqual(new Set([albumId]))
  expect(after.albumLinks).toMatchObject([
    { album_key: albumNameKey(scrobbledAlbum), album_media_item_id: albumId },
  ])
  // Possible duplicates are right at once.
  expect(await duplicateGroups(spotifyIds)).toEqual(spotifyIds.map(() => null))

  await undoLibraryChange(change.id)
  expect(await state()).toEqual(before)
  expect(await duplicateGroups(spotifyIds)).toEqual(groupsBefore)

  await redoLibraryChange(change.id)
  expect(await state()).toEqual(after)
})

it('merges only the selected title without follow', async () => {
  const before = await state()
  const plan = await trackPlan({ ...lowTide, follow: false })
  expect(plan.also).toEqual({ albumNames: [], titles: [] })
  const change = await trackMerge({ ...lowTide, follow: false })
  expect(change.nameCount).toBe(1)
  expect(change.details?.counts).toEqual({})
  const after = await state()
  expect(after.albumLinks).toEqual(before.albumLinks)
  expect(after.pointers).toEqual(before.pointers)
  for (const title of titles.slice(1))
    expect(await owner(title)).toBe(lastfm(title))
  // A direct call without follow follows nothing either.
  await undoLibraryChange(change.id)
  expect(await state()).toEqual(before)
  const direct = await mergeTracks({ ...lowTide, reviewed: false })
  expect(direct.nameCount).toBe(1)
})

it('does not move a title onto a track kept separate from it or rejected for it', async () => {
  const [low, high] = [lastfm('Lanterns'), spotify(2)].sort()
  if (!low || !high) throw new Error('Missing pair')
  await fixture
    .insert(schema.libraryKeepSeparate)
    .values({ kind: 'track', lowId: low, highId: high })
  await fixture.insert(schema.libraryMatchRejection).values({
    username: account,
    artistKey: albumNameKey(band),
    trackKey: albumNameKey('Undertow'),
    recordId: spotify(3),
    reason: 'separate',
  })
  const plan = await trackPlan(lowTide)
  expect(plan.also.titles.map((name) => name.trackName)).toEqual([
    'Breakwater',
    'Quay Lights',
  ])
  const change = await trackMerge(lowTide)
  expect(change.details?.counts).toEqual({ 'album-name': 1, title: 2 })
  expect(await owner('Lanterns')).toBe(lastfm('Lanterns'))
  expect(await owner('Undertow')).toBe(lastfm('Undertow'))
  expect(await owner('Breakwater')).toBe(spotify(4))
})

it('cautions when a title that follows is on another album or matches two tracks', async () => {
  await fixture.insert(schema.mediaItem).values({
    id: 'album-other',
    slug: 'album-other',
    title: 'Harbour Compilation',
    mediaType: 'album',
  })
  await fixture.insert(schema.album).values({ mediaItemId: 'album-other' })
  await fixture.insert(schema.track).values({
    id: 'other-position',
    albumMediaItemId: 'album-other',
    trackMediaItemId: lastfm('Quay Lights'),
    title: 'Quay Lights',
    position: 1,
  })
  for (const position of [6, 7])
    await insertSpotifyTrack(spotify(position), 'Interlude', bandId, {
      id: albumId,
      position,
    })
  await insertLastfmTrack('Interlude', band, bandId)
  await fixture
    .insert(schema.lastfmScrobble)
    .values(scrobbles(band, 'Interlude', 1, scrobbledAlbum))

  const plan = await trackPlan(lowTide)
  expect(plan.cautions).toEqual([
    {
      code: 'elsewhere',
      count: 1,
      names: [
        {
          artistName: band,
          trackName: 'Quay Lights',
          albumTitle: 'Harbour Compilation',
        },
      ],
    },
    {
      code: 'ambiguous',
      count: 1,
      names: [{ artistName: band, trackName: 'Interlude' }],
    },
  ])
  await expect(trackMerge(lowTide)).rejects.toMatchObject({
    response: { statusCode: 409 },
  })
  await trackMerge({ ...lowTide, reviewed: true })
  expect(await owner('Quay Lights')).toBe(spotify(5))
  expect(await owner('Interlude')).toBe(lastfm('Interlude'))
})

it('makes matching Last.fm titles follow an artist merge and undoes it exactly', async () => {
  // A second Lanterns of the kept artist makes that title ambiguous.
  await insertSpotifyTrack('single-lanterns', 'Lanterns', bandId, null)
  await insertSpotifyTrack('misspelt-undertow', 'Undertow', misspeltId, null)
  for (const [title, count] of [
    ['Low Tide', 2],
    ['Lanterns', 1],
    ['Solo Song', 1],
  ] as const) {
    await insertLastfmTrack(title, misspelt, misspeltId)
    await fixture
      .insert(schema.lastfmScrobble)
      .values(scrobbles(misspelt, title, count, null))
  }
  await linkScrobblesToTracks(account)
  await refreshTrackAddedDates(fixture)
  await refreshArtistListeningTotals(fixture)
  const before = await state()
  const selection = { artistIds: [misspeltId, bandId], targetId: bandId }

  const plan = await planArtistMerge(
    ArtistMergePlanRequestSchema.parse(selection),
  )
  expect(plan.also).toEqual([
    {
      artistName: misspelt,
      trackName: 'Low Tide',
      scrobbles: 2,
      fromTrackId: lastfm('Low Tide', misspelt),
      toTrackId: spotify(1),
      toTitle: 'Low Tide',
    },
  ])
  const merged = await mergeArtists(
    ArtistMergeRequestSchema.parse({ ...selection, reviewed: true }),
  )
  expect(merged).toMatchObject({
    kind: 'artist',
    action: 'merge',
    nameCount: 1,
    details: { counts: { 'artist-name': 1, title: 1 } },
  })
  expect(await owner('Low Tide', misspelt)).toBe(spotify(1))
  expect(await owner('Lanterns', misspelt)).toBe(lastfm('Lanterns', misspelt))
  expect(await owner('Solo Song', misspelt)).toBe(lastfm('Solo Song', misspelt))
  const after = await state()
  const remaining = after.tracks.map((row) => row.media_item_id)
  expect(remaining).not.toContain(lastfm('Low Tide', misspelt))
  expect(remaining).toContain('misspelt-undertow')
  // Browse by the merged name reads as the artist kept.
  const byName = await queryBrowseIds(
    'track',
    TrackQuerySchema.parse({ creatorId: misspeltId, size: 100 }),
  )
  const byArtist = await queryBrowseIds(
    'track',
    TrackQuerySchema.parse({ creatorId: bandId, size: 100 }),
  )
  expect(byName.ids).toEqual(byArtist.ids)
  expect(byName.ids).toContain('misspelt-undertow')

  await undoLibraryChange(merged.id)
  expect(await state()).toEqual(before)
  await redoLibraryChange(merged.id)
  expect(await state()).toEqual(after)
  await undoLibraryChange(merged.id)
  expect(await state()).toEqual(before)

  // Without follow only the credits move.
  const plain = await mergeArtists({ ...selection, reviewed: true })
  expect(plain.nameCount).toBe(0)
  expect(await owner('Low Tide', misspelt)).toBe(lastfm('Low Tide', misspelt))
})
