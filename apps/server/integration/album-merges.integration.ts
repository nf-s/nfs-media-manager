import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import {
  AlbumMergePlanRequestSchema,
  AlbumMergeRequestSchema,
  AlbumNameMoveRequestSchema,
} from '@repo/schemas/album-merges'
import { LibraryChangeListQuerySchema } from '@repo/schemas/library-changes'
import { AlbumQuerySchema } from '@repo/schemas/media'
import { env } from '@/env'
import { albumNameKey } from '@/lib/album-import-candidates'
import { standaloneLastfmTrackId } from '@/lib/track-matching'
import * as schema from '@/schemas/db'

const database = 'album_merges_' + randomUUID().replaceAll('-', '')
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

import {
  mergeAlbums,
  moveAlbumName,
  planAlbumMerge,
  planAlbumNameMove,
  separateAlbumEdition,
} from '@/services/album-merges'
import { refreshAlbumListening } from '@/services/lastfm-album-links'
import { setLastfmAlbumLink } from '@/services/lastfm-scrobbles'
import {
  getLibraryChange,
  listLibraryChanges,
  redoLibraryChange,
  undoLibraryChange,
} from '@/services/library-changes'
import { getAlbumDetail, listAlbums } from '@/services/media'
import { linkScrobblesToTracks } from '@/services/track-links'

const account = 'fixture-listener'
const band = 'Fixture Band'
const standard = 'album-standard'
const deluxe = 'album-deluxe'
const other = 'album-other'
const remaster = 'album-remaster'
const allAlbums = [standard, deluxe, other, remaster].sort()

type AlbumFixture = {
  id: string
  title: string
  artist: string
  tracks: string[]
}
const albums: AlbumFixture[] = [
  {
    id: standard,
    title: 'Harbour Lights',
    artist: band,
    tracks: ['Low Tide', 'Lanterns', 'Undertow'],
  },
  {
    id: deluxe,
    title: 'Harbour Lights (Deluxe Edition)',
    artist: band,
    tracks: ['Low Tide', 'Lanterns', 'Undertow', 'Bonus Light'],
  },
  {
    id: other,
    title: 'Paper Coast',
    artist: 'Other Artist',
    tracks: ['Dry Dock', 'Gulls'],
  },
  {
    id: remaster,
    title: 'Harbour Lights',
    artist: band,
    tracks: ['Low Tide', 'Lanterns', 'Undertow'],
  },
]
const trackId = (albumId: string, position: number) =>
  `${albumId}-track-${position}`

const sessions = { artistName: band, albumName: 'Harbour Lights - Sessions' }
const lastfmOnly = (trackName: string) =>
  standaloneLastfmTrackId(account, {
    artistKey: albumNameKey(band),
    trackKey: albumNameKey(trackName),
  })
const undertowName = lastfmOnly('Undertow')
const jamName = lastfmOnly('Rehearsal Jam')

/** Scrobbles of one track name under one album name, and who owns the name. */
const scrobbled = [
  {
    album: 'Harbour Lights',
    track: 'Low Tide',
    count: 3,
    owner: trackId(standard, 1),
  },
  {
    album: 'Harbour Lights',
    track: 'Lanterns',
    count: 2,
    owner: trackId(standard, 2),
  },
  {
    album: 'Harbour Lights (Deluxe Edition)',
    track: 'Bonus Light',
    count: 2,
    owner: trackId(deluxe, 4),
  },
  { album: 'Paper Coast', track: 'Gulls', count: 1, owner: trackId(other, 2) },
  {
    album: sessions.albumName,
    track: 'Undertow',
    count: 2,
    owner: undertowName,
  },
  {
    album: sessions.albumName,
    track: 'Rehearsal Jam',
    count: 1,
    owner: jamName,
  },
]
const linked: Record<string, string | null> = {
  'Harbour Lights': standard,
  'Harbour Lights (Deluxe Edition)': deluxe,
  'Paper Coast': other,
  [sessions.albumName]: null,
}

async function insertAlbum(
  { id, title, artist, tracks }: AlbumFixture,
  day: number,
) {
  const artistId = albumNameKey(artist).replaceAll(' ', '-')
  await fixture
    .insert(schema.artist)
    .values({ id: artistId, name: artist })
    .onConflictDoNothing()
  await fixture.insert(schema.mediaItem).values({
    id,
    slug: id,
    title,
    mediaType: 'album',
    sourceLabel: 'spotify',
  })
  await fixture.insert(schema.album).values({
    mediaItemId: id,
    spotifyUrl: `https://open.spotify.com/album/${id.padEnd(22, '0')}`,
    trackCount: tracks.length,
    dateAdded: new Date(Date.UTC(2024, 0, day)),
  })
  await fixture
    .insert(schema.mediaCredit)
    .values({ mediaItemId: id, artistId, role: 'artist' })
  for (const [index, trackTitle] of tracks.entries()) {
    const track = trackId(id, index + 1)
    await fixture.insert(schema.mediaItem).values({
      id: track,
      slug: track,
      title: trackTitle,
      mediaType: 'track',
      sourceLabel: 'spotify',
    })
    await fixture.insert(schema.libraryTrack).values({
      mediaItemId: track,
      spotifyTrackId: track.padEnd(22, '0').slice(-22),
      albumMediaItemId: id,
      albumLinkStrategy: 'album-track-list',
    })
    await fixture
      .insert(schema.mediaCredit)
      .values({ mediaItemId: track, artistId, role: 'artist' })
    await fixture.insert(schema.track).values({
      id: `${track}-position`,
      albumMediaItemId: id,
      trackMediaItemId: track,
      title: trackTitle,
      position: index + 1,
    })
  }
}

async function insertLastfmTrack(id: string, title: string) {
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
    .values({ mediaItemId: id, artistId: 'fixture-band', role: 'artist' })
}

/** Everything a change to albums can touch, in a stable order. */
async function state() {
  const read = async (query: string) => (await pool.query(query)).rows
  return {
    albums: await read(
      'select media_item_id, edition_of_id from album order by 1',
    ),
    browse: await read(
      "select id, metadata->'browse' as browse from media_item where media_type = 'album' order by 1",
    ),
    links: await read(
      `select username, artist_key, album_key, album_media_item_id, source,
        strategy, candidate_ids, created_at from lastfm_album_link order by 1, 2, 3`,
    ),
    pointers: await read(
      'select id, album_media_item_id from lastfm_scrobble order by 1',
    ),
    sources: await read(
      `select artist_key, track_key, track_media_item_id, manually_matched
        from lastfm_track_source order by 1, 2`,
    ),
    trackLinks: await read(
      `select artist_key, track_key, track_media_item_id, strategy
        from lastfm_track_link order by 1, 2, 3`,
    ),
    tracks: await read(
      'select media_item_id, scrobble_count from library_track order by 1',
    ),
    kept: await read(
      'select kind, low_id, high_id from library_keep_separate order by 1, 2, 3',
    ),
    overrides: await read(
      'select id, media_item_id, field, value from media_override order by 1',
    ),
  }
}

async function editionOf(id: string) {
  const [row] = await fixture
    .select({ editionOf: schema.album.editionOfId })
    .from(schema.album)
    .where(eq(schema.album.mediaItemId, id))
  return row?.editionOf
}

async function browseScrobbles(id: string) {
  const { rows } = await pool.query(
    "select (metadata->'browse'->>'scrobbles')::int as scrobbles from media_item where id = $1",
    [id],
  )
  return rows[0]?.scrobbles ?? null
}

async function nameOwner(trackName: string) {
  const { rows } = await pool.query(
    'select track_media_item_id as id, manually_matched as manual from lastfm_track_source where track_key = $1',
    [albumNameKey(trackName)],
  )
  return rows[0]
}

const browseIds = async (query: Record<string, string> = {}) =>
  (await listAlbums(AlbumQuerySchema.parse(query))).items
    .map((item) => item.id)
    .sort()
const albumChanges = () =>
  listLibraryChanges(LibraryChangeListQuerySchema.parse({ kind: 'album' }))
const merge = (input: Record<string, unknown>) =>
  mergeAlbums(AlbumMergeRequestSchema.parse(input))
const plan = (input: Record<string, unknown>) =>
  planAlbumMerge(AlbumMergePlanRequestSchema.parse(input))
const moveName = (input: Record<string, unknown>) =>
  moveAlbumName(AlbumNameMoveRequestSchema.parse({ ...sessions, ...input }))

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
  await fixture.delete(schema.lastfmAlbumLink)
  await fixture.delete(schema.lastfmScrobble)
  await fixture.delete(schema.track)
  await fixture.delete(schema.mediaItem)
  await fixture.delete(schema.artist)
  for (const [index, album] of albums.entries())
    await insertAlbum(album, index + 1)
  await insertLastfmTrack(undertowName, 'Undertow')
  await insertLastfmTrack(jamName, 'Rehearsal Jam')
  await fixture.insert(schema.lastfmScrobble).values(
    scrobbled.flatMap((row) =>
      Array.from({ length: row.count }, (_, index) => ({
        id: `${albumNameKey(row.album)}-${albumNameKey(row.track)}-${index}`,
        username: account,
        listenedAt: new Date(Date.UTC(2025, 0, 1 + index)),
        artistName: band,
        artistKey: albumNameKey(band),
        albumName: row.album,
        albumKey: albumNameKey(row.album),
        trackName: row.track,
        trackKey: albumNameKey(row.track),
        albumMediaItemId: linked[row.album] ?? null,
      })),
    ),
  )
  await fixture.insert(schema.lastfmTrackSource).values(
    [...new Map(scrobbled.map((row) => [row.track, row])).values()].map(
      (row) => ({
        username: account,
        artistKey: albumNameKey(band),
        trackKey: albumNameKey(row.track),
        trackMediaItemId: row.owner,
      }),
    ),
  )
  await fixture.insert(schema.lastfmAlbumLink).values(
    Object.entries(linked).flatMap(([albumName, albumId]) =>
      albumId
        ? [
            {
              username: account,
              artistKey: albumNameKey(band),
              albumKey: albumNameKey(albumName),
              albumMediaItemId: albumId,
              source: 'auto',
              strategy: 'exact',
            },
          ]
        : [],
    ),
  )
  await linkScrobblesToTracks(account)
  await refreshAlbumListening(fixture)
})

it('makes a Spotify album an edition of another, deleting nothing, and undoes it exactly', async () => {
  const before = await state()
  expect(await browseIds()).toEqual(allAlbums)
  const reading = await plan({ albumIds: [standard, deluxe] })
  // Both have a Spotify album; the deluxe edition has more tracks.
  expect(reading.targetId).toBe(deluxe)
  expect(reading.cautions).toEqual([
    { code: 'version', words: ['Deluxe Edition'] },
  ])
  await expect(
    merge({ albumIds: [standard, deluxe], targetId: standard }),
  ).rejects.toMatchObject({ response: { statusCode: 409 } })

  const change = await merge({
    albumIds: [standard, deluxe],
    targetId: standard,
    reviewed: true,
  })
  expect(change).toMatchObject({
    kind: 'album',
    action: 'merge',
    target: { id: standard, title: 'Harbour Lights' },
    sources: [{ id: deluxe }],
    details: { counts: { edition: 1 } },
    canUndo: true,
  })
  expect(await editionOf(deluxe)).toBe(standard)
  expect(await editionOf(standard)).toBeNull()
  const after = await state()
  expect(after.albums).toHaveLength(4)
  expect(after.tracks).toEqual(before.tracks)
  expect(after.pointers).toEqual(before.pointers)
  expect(await browseIds()).toEqual([standard, remaster, other].sort())
  expect(await browseScrobbles(standard)).toBe(7)
  expect(await browseScrobbles(deluxe)).toBe(2)
  expect(await browseIds({ editions: 'true' })).toEqual(allAlbums)
  const detail = await getAlbumDetail(standard)
  expect(detail?.editions?.map((edition) => edition.id)).toEqual([deluxe])
  expect((await getAlbumDetail(deluxe))?.editionOf?.id).toBe(standard)

  const undone = await undoLibraryChange(change.id)
  expect(undone.canRedo).toBe(true)
  expect(await state()).toEqual(before)
  expect(await browseIds()).toEqual(allAlbums)

  await redoLibraryChange(change.id)
  expect(await state()).toEqual(after)
  expect((await albumChanges()).items.map((item) => item.id)).toEqual([
    change.id,
  ])
})

it('leaves no chain when merging into an edition or merging a first album with editions', async () => {
  const first = await merge({
    albumIds: [standard, deluxe],
    targetId: standard,
    reviewed: true,
  })
  const intoEdition = await merge({
    albumIds: [deluxe, other],
    targetId: deluxe,
    reviewed: true,
  })
  expect(intoEdition.target?.id).toBe(standard)
  expect(await editionOf(other)).toBe(standard)
  const before = await state()
  const moved = await merge({
    albumIds: [remaster, standard],
    targetId: remaster,
    reviewed: true,
  })
  expect(moved.details?.counts).toEqual({ edition: 3 })
  for (const id of [standard, deluxe, other])
    expect(await editionOf(id)).toBe(remaster)
  expect(await editionOf(remaster)).toBeNull()
  expect(await browseIds()).toEqual([remaster])
  expect(await browseScrobbles(remaster)).toBe(8)

  // The first merge's editions were regrouped by the last one.
  expect((await getLibraryChange(first.id)).blocked).toBe(
    'An edition was regrouped since. Undo that change first.',
  )
  await expect(undoLibraryChange(first.id)).rejects.toMatchObject({
    response: { statusCode: 409 },
  })
  await undoLibraryChange(moved.id)
  expect(await state()).toEqual(before)
})

it('refuses an undo when an album of the change is gone', async () => {
  const change = await merge({
    albumIds: [standard, deluxe],
    targetId: standard,
    reviewed: true,
  })
  await fixture.delete(schema.mediaItem).where(eq(schema.mediaItem.id, deluxe))
  expect((await getLibraryChange(change.id)).blocked).toBe(
    'An album in this change is no longer in the library.',
  )
})

it('moves an album name with its scrobbles and the track names that follow', async () => {
  const before = await state()
  const reading = await planAlbumNameMove({
    ...sessions,
    albumId: standard,
    follow: true,
  })
  expect(reading.names).toEqual([{ ...sessions, scrobbles: 3, albumId: null }])
  expect(reading.also).toEqual([
    {
      artistName: band,
      trackName: 'Undertow',
      scrobbles: 2,
      fromTrackId: undertowName,
      toTrackId: trackId(standard, 3),
      toTitle: 'Undertow',
    },
  ])
  expect(reading.unmatched).toEqual([
    {
      artistName: band,
      trackName: 'Rehearsal Jam',
      scrobbles: 1,
      trackId: jamName,
    },
  ])
  expect(reading.scrobbles).toEqual({ target: 5, added: 3, total: 8 })
  expect(reading.cautions).toEqual([{ code: 'version', words: ['Sessions'] }])
  await expect(moveName({ albumId: standard })).rejects.toMatchObject({
    response: { statusCode: 409 },
  })

  const change = await moveName({ albumId: standard, reviewed: true })
  expect(change).toMatchObject({
    kind: 'album',
    action: 'move',
    target: { id: standard },
    names: [{ trackName: 'Undertow', scrobbles: 2 }],
    details: { counts: { 'album-name': 1, title: 1 } },
  })
  const { rows: pointers } = await pool.query(
    'select distinct album_media_item_id as id from lastfm_scrobble where album_key = $1',
    [albumNameKey(sessions.albumName)],
  )
  expect(pointers).toEqual([{ id: standard }])
  expect(await nameOwner('Undertow')).toEqual({
    id: trackId(standard, 3),
    manual: true,
  })
  expect(await nameOwner('Rehearsal Jam')).toEqual({
    id: jamName,
    manual: false,
  })
  const after = await state()
  expect(after.tracks.map((row) => row.media_item_id)).not.toContain(
    undertowName,
  )
  expect(await browseScrobbles(standard)).toBe(8)

  await undoLibraryChange(change.id)
  expect(await state()).toEqual(before)
  await redoLibraryChange(change.id)
  expect(await state()).toEqual(after)
})

it('moves only the album name without follow', async () => {
  const before = await state()
  const change = await moveName({
    albumId: standard,
    follow: false,
    reviewed: true,
  })
  expect(change.nameCount).toBe(0)
  expect(change.details?.counts).toEqual({ 'album-name': 1 })
  expect((await state()).sources).toEqual(before.sources)
  await undoLibraryChange(change.id)
  expect(await state()).toEqual(before)
})

it('raises each caution and clears a kept-separate decision', async () => {
  // Names under Harbour Lights belong to the standard album's tracks.
  const elsewhere = await planAlbumNameMove({
    artistName: band,
    albumName: 'Harbour Lights',
    albumId: deluxe,
    follow: true,
  })
  expect(elsewhere.also.map((name) => name.toTrackId)).toEqual([
    trackId(deluxe, 1),
    trackId(deluxe, 2),
  ])
  expect(elsewhere.cautions).toContainEqual({
    code: 'elsewhere',
    count: 2,
    names: [
      { artistName: band, trackName: 'Low Tide', albumTitle: 'Harbour Lights' },
      { artistName: band, trackName: 'Lanterns', albumTitle: 'Harbour Lights' },
    ],
  })

  await fixture
    .insert(schema.libraryKeepSeparate)
    .values({ kind: 'album', lowId: other, highId: standard })
  const before = await state()
  const reading = await plan({
    albumIds: [standard, other],
    targetId: standard,
  })
  expect(reading.cautions).toEqual([
    { code: 'artists', names: [band, 'Other Artist'] },
    { code: 'tracks', albums: [{ albumId: other, shared: 0, listed: 2 }] },
    { code: 'separate', albumIds: [other, standard] },
  ])
  await expect(
    merge({ albumIds: [standard, other], targetId: standard }),
  ).rejects.toMatchObject({ response: { statusCode: 409 } })
  const change = await merge({
    albumIds: [standard, other],
    targetId: standard,
    reviewed: true,
  })
  expect((await state()).kept).toEqual([])
  await undoLibraryChange(change.id)
  expect(await state()).toEqual(before)

  // Nothing speaks against two releases of the same album.
  expect(
    (await plan({ albumIds: [standard, remaster], targetId: standard }))
      .cautions,
  ).toEqual([])
  await expect(
    merge({ albumIds: [standard, remaster], targetId: standard }),
  ).resolves.toMatchObject({ action: 'merge' })
})

it('blocks hidden albums, one record, and an undo after a later move of the name', async () => {
  await pool.query(
    `update media_item set metadata = '{"legacyHidden": true}' where id = $1`,
    [remaster],
  )
  expect((await plan({ albumIds: [standard, remaster] })).blocked).toBe(
    'hidden',
  )
  await expect(
    merge({ albumIds: [standard, remaster], reviewed: true }),
  ).rejects.toMatchObject({ response: { statusCode: 409 } })

  await merge({
    albumIds: [standard, deluxe],
    targetId: standard,
    reviewed: true,
  })
  expect((await plan({ albumIds: [standard, deluxe] })).blocked).toBe(
    'same-record',
  )
  await expect(
    merge({ albumIds: [deluxe, standard], reviewed: true }),
  ).rejects.toMatchObject({ response: { statusCode: 409 } })

  const first = await moveName({
    albumId: standard,
    follow: false,
    reviewed: true,
  })
  await moveName({ albumId: other, follow: false, reviewed: true })
  expect((await getLibraryChange(first.id)).blocked).toBe(
    'A later change moved this album name. Undo that change first.',
  )
  await expect(undoLibraryChange(first.id)).rejects.toMatchObject({
    response: { statusCode: 409 },
  })
})

it('separates an edition from its record and undoes it', async () => {
  await merge({
    albumIds: [standard, deluxe],
    targetId: standard,
    reviewed: true,
  })
  await expect(
    separateAlbumEdition({ albumId: standard }),
  ).rejects.toMatchObject({ response: { statusCode: 409 } })
  const before = await state()
  const change = await separateAlbumEdition({ albumId: deluxe })
  expect(change).toMatchObject({
    action: 'separate',
    target: { id: deluxe },
    sources: [{ id: standard }],
  })
  expect(await editionOf(deluxe)).toBeNull()
  expect(await browseIds()).toEqual(allAlbums)
  expect(await browseScrobbles(standard)).toBe(5)
  const after = await state()
  await undoLibraryChange(change.id)
  expect(await state()).toEqual(before)
  await redoLibraryChange(change.id)
  expect(await state()).toEqual(after)
})

it('records the legacy album link as a change that can be undone', async () => {
  const before = await state()
  await setLastfmAlbumLink({ action: 'link', ...sessions, albumId: standard })
  const [linkedChange] = (await albumChanges()).items
  expect(linkedChange).toMatchObject({
    action: 'move',
    target: { id: standard },
    nameCount: 0,
  })
  expect(await browseScrobbles(standard)).toBe(8)
  if (!linkedChange) throw new Error('Missing change')
  await undoLibraryChange(linkedChange.id)
  expect(await state()).toEqual(before)

  await setLastfmAlbumLink({
    action: 'unlink',
    artistName: band,
    albumName: 'Harbour Lights',
  })
  const [unlinked] = (await albumChanges()).items
  expect(unlinked).toMatchObject({
    action: 'separate',
    target: null,
    sources: [{ id: standard }],
  })
  expect((await state()).overrides).toHaveLength(1)
  if (!unlinked) throw new Error('Missing change')
  await undoLibraryChange(unlinked.id)
  expect(await state()).toEqual(before)
})
