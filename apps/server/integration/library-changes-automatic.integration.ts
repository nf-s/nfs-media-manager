import '@hono/zod-openapi'
import { createHash, randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { LibraryChangeListQuerySchema } from '@repo/schemas/library-changes'
import {
  SPOTIFY_TRACK_SEARCH_TASK,
  type SpotifyTrackSearchCandidate,
} from '@repo/schemas/spotify-track-search'
import { env } from '@/env'
import { albumNameKey } from '@/lib/album-import-candidates'
import { createStableId, slugifyParts } from '@/lib/media-utils'
import { standaloneLastfmTrackId } from '@/lib/track-matching'
import * as schema from '@/schemas/db'

const database = 'library_automatic_' + randomUUID().replaceAll('-', '')
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

import {
  mergeAlbumTrackHistory,
  replaceAlbumTracks,
} from '@/services/album-library-tracks'
import {
  listCatalogObservations,
  observeCatalogOccurrence,
  setCatalogMediaAlias,
} from '@/services/catalog-discoveries'
import { importLastfmLibraryTracks } from '@/services/lastfm-library-tracks'
import {
  getLibraryChange,
  listLibraryChanges,
  openChangeBatch,
  redoLibraryChange,
  undoLibraryChange,
} from '@/services/library-changes'
import {
  acceptSpotifyTrackSearch,
  reconcileSavedSpotifyTrackSearch,
} from '@/services/spotify-track-search-acceptance'
import { spotifyTrackItemId } from '@/services/spotify-playlists'
import { refreshTrackLinks } from '@/services/track-links'
import { removeScrobbleTrackMatch } from '@/services/track-merges'

const account = 'fixture-automatic'
const ARTIST = 'Fixture Artist'
const artistId = 'fixture-artist'
const userId = 'fixture-owner'
const NAMES_MOVED = 'A later change moved these names. Undo that change first.'

const spotifyId = (value: string) =>
  value.replace(/[^A-Za-z0-9]/g, '').padEnd(22, '0')

function nameOf(trackName: string, artistName = ARTIST) {
  const key = {
    artistKey: albumNameKey(artistName),
    trackKey: albumNameKey(trackName),
  }
  return {
    ...key,
    artistName,
    trackName,
    standaloneId: standaloneLastfmTrackId(account, key),
  }
}
type Name = ReturnType<typeof nameOf>

async function scrobble(
  name: Name,
  count: number,
  { albumId, album }: { albumId?: string; album?: string } = {},
) {
  await fixture.insert(schema.lastfmScrobble).values(
    Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      username: account,
      artistName: name.artistName,
      artistKey: name.artistKey,
      trackName: name.trackName,
      trackKey: name.trackKey,
      albumName: album ?? null,
      albumKey: album ? albumNameKey(album) : null,
      albumMediaItemId: albumId ?? null,
      listenedAt: new Date(Date.UTC(2023, 0, 1 + index)),
    })),
  )
}

async function credit(mediaItemId: string) {
  await fixture
    .insert(schema.mediaCredit)
    .values({ mediaItemId, artistId, role: 'artist' })
}

let importedPosition = 0
async function spotifyTrack(
  id: string,
  title: string,
  {
    albumId = null,
    spotifyAlbumId = null,
    spotifyTrackId = spotifyId(id),
  }: {
    albumId?: string | null
    spotifyAlbumId?: string | null
    spotifyTrackId?: string
  } = {},
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
    spotifyTrackId,
    spotifyUrl: `https://open.spotify.com/track/${spotifyTrackId}`,
    albumMediaItemId: albumId,
    spotifyAlbumId,
    durationSec: 180,
    dateAdded: new Date('2022-01-01T00:00:00Z'),
  })
  await credit(id)
  // Imported tracks stay in the library through their playlist entries.
  await fixture
    .insert(schema.playlist)
    .values({ id: 'imported', name: 'Imported', kind: 'playlist' })
    .onConflictDoNothing()
  await fixture.insert(schema.playlistItem).values({
    playlistId: 'imported',
    mediaItemId: id,
    position: importedPosition++,
    addedAt: new Date('2022-01-01T00:00:00Z'),
  })
}

async function album(id: string, { spotify = false } = {}) {
  await fixture.insert(schema.mediaItem).values({
    id,
    slug: id,
    title: `Album ${id}`,
    mediaType: 'album',
  })
  await fixture.insert(schema.album).values({
    mediaItemId: id,
    spotifyUrl: spotify
      ? `https://open.spotify.com/album/${spotifyId(id)}`
      : null,
  })
  await credit(id)
  return { albumId: id, album: `Album ${id}` }
}

const replaceList = (
  albumId: string,
  tracks: { title: string; position: number; externalId?: string }[],
) => fixture.transaction((tx) => replaceAlbumTracks(tx, albumId, tracks))

/** The recording an album list entry gets when nothing in the library matches it. */
function albumRecordingId(
  albumId: string,
  {
    title,
    position,
    externalId,
  }: { title: string; position: number; externalId?: string },
) {
  const entry = createStableId(
    'track',
    `${albumId}:${position}:${title}:${externalId ?? ''}`,
  )
  return `library-track_${createHash('md5').update(entry).digest('hex').slice(0, 20)}`
}

async function ownerOf(name: Name) {
  const [row] = await fixture
    .select({
      trackId: schema.lastfmTrackSource.trackMediaItemId,
      manual: schema.lastfmTrackSource.manuallyMatched,
    })
    .from(schema.lastfmTrackSource)
    .where(
      and(
        eq(schema.lastfmTrackSource.username, account),
        eq(schema.lastfmTrackSource.artistKey, name.artistKey),
        eq(schema.lastfmTrackSource.trackKey, name.trackKey),
      ),
    )
  return row
}

async function creditedTracks(name: Name) {
  return (
    await fixture
      .select({ id: schema.lastfmTrackLink.trackMediaItemId })
      .from(schema.lastfmTrackLink)
      .where(
        and(
          eq(schema.lastfmTrackLink.username, account),
          eq(schema.lastfmTrackLink.artistKey, name.artistKey),
          eq(schema.lastfmTrackLink.trackKey, name.trackKey),
        ),
      )
      .orderBy(asc(schema.lastfmTrackLink.trackMediaItemId))
  ).map((row) => row.id)
}

const rejections = () =>
  fixture
    .select({
      trackKey: schema.libraryMatchRejection.trackKey,
      recordId: schema.libraryMatchRejection.recordId,
      reason: schema.libraryMatchRejection.reason,
      rule: schema.libraryMatchRejection.rule,
      changeId: schema.libraryMatchRejection.changeId,
    })
    .from(schema.libraryMatchRejection)
    .orderBy(asc(schema.libraryMatchRejection.recordId))

async function trackRow(id: string) {
  const [row] = await fixture
    .select()
    .from(schema.libraryTrack)
    .innerJoin(
      schema.mediaItem,
      eq(schema.mediaItem.id, schema.libraryTrack.mediaItemId),
    )
    .where(eq(schema.libraryTrack.mediaItemId, id))
  return row
}

const positions = (albumId: string) =>
  fixture
    .select({
      id: schema.track.id,
      trackId: schema.track.trackMediaItemId,
      position: schema.track.position,
    })
    .from(schema.track)
    .where(eq(schema.track.albumMediaItemId, albumId))
    .orderBy(asc(schema.track.position))

const playlistEntries = () =>
  fixture
    .select()
    .from(schema.playlistItem)
    .orderBy(
      asc(schema.playlistItem.playlistId),
      asc(schema.playlistItem.mediaItemId),
    )

const automatic = (query: Record<string, unknown> = {}) =>
  listLibraryChanges(
    LibraryChangeListQuerySchema.parse({ actor: 'automatic', ...query }),
  )

async function onlyChange(query: Record<string, unknown> = {}) {
  const page = await automatic(query)
  expect(page.totalCount).toBe(1)
  const [change] = page.items
  if (!change) throw new Error('Expected one automatic change')
  return change
}

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', () => {
    throw new Error('Network forbidden')
  })
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
  await fixture.delete(schema.libraryChangeBatch)
  await fixture.delete(schema.libraryMatchRejection)
  await fixture.delete(schema.libraryKeepSeparate)
  await fixture.delete(schema.scrapeJob)
  await fixture.delete(schema.playlist)
  await fixture.delete(schema.lastfmScrobble)
  await fixture.delete(schema.track)
  await fixture.delete(schema.mediaItem)
  await fixture.delete(schema.artist)
  await fixture.delete(schema.tag)
  await fixture.insert(schema.artist).values({ id: artistId, name: ARTIST })
  await fixture
    .insert(schema.user)
    .values({ id: userId, name: 'Fixture Owner', email: 'owner@example.test' })
    .onConflictDoNothing()
})

it('records a first-import match, undoes it onto the name’s own track and does not make it again', async () => {
  const signal = nameOf('Signal')
  await spotifyTrack('spotify-signal', 'Signal')
  await scrobble(signal, 3)
  await refreshTrackLinks(account, 'lastfm-sync')

  expect(await ownerOf(signal)).toEqual({
    trackId: 'spotify-signal',
    manual: false,
  })
  expect(await trackRow(signal.standaloneId)).toBeUndefined()
  const batches = await fixture.select().from(schema.libraryChangeBatch)
  expect(batches).toMatchObject([
    { trigger: 'lastfm-sync', changeCount: 1, nameCount: 1, scrobbles: 3 },
  ])
  const batchId = batches[0]?.id
  const change = await onlyChange({ batchId })
  expect(change).toMatchObject({
    kind: 'track',
    action: 'move',
    actor: 'automatic',
    rule: 'lastfm-exact-name',
    batchId,
    target: { id: 'spotify-signal', exists: true },
    names: [{ artistName: ARTIST, trackName: 'Signal', scrobbles: 3 }],
    nameCount: 1,
    scrobbles: 3,
    canUndo: true,
    blocked: null,
  })
  expect((await automatic({ batchId: 'another-run' })).totalCount).toBe(0)

  expect(await undoLibraryChange(change.id)).toMatchObject({
    canUndo: false,
    canRedo: true,
  })
  expect(await ownerOf(signal)).toEqual({
    trackId: signal.standaloneId,
    manual: false,
  })
  expect(await trackRow(signal.standaloneId)).toMatchObject({
    media_item: { title: 'Signal', sourceLabel: 'lastfm' },
    library_track: { scrobbleCount: 3 },
  })
  expect(await rejections()).toEqual([
    {
      trackKey: signal.trackKey,
      recordId: 'spotify-signal',
      reason: 'undo',
      rule: 'lastfm-exact-name',
      changeId: change.id,
    },
  ])
  expect(await creditedTracks(signal)).toEqual([signal.standaloneId])
  expect(await trackRow('spotify-signal')).toMatchObject({
    library_track: { scrobbleCount: 0 },
  })

  // The next sync leaves the name where Undo put it.
  await refreshTrackLinks(account, 'lastfm-sync')
  expect(await ownerOf(signal)).toEqual({
    trackId: signal.standaloneId,
    manual: false,
  })
  expect(await creditedTracks(signal)).toEqual([signal.standaloneId])
  expect(await trackRow('spotify-signal')).toMatchObject({
    library_track: { scrobbleCount: 0 },
  })
  expect((await automatic()).totalCount).toBe(1)
  expect(await fixture.select().from(schema.libraryChangeBatch)).toHaveLength(1)

  expect(await redoLibraryChange(change.id)).toMatchObject({ canUndo: true })
  expect(await ownerOf(signal)).toEqual({
    trackId: 'spotify-signal',
    manual: false,
  })
  expect(await trackRow(signal.standaloneId)).toBeUndefined()
  expect(await rejections()).toEqual([])
  expect(await creditedTracks(signal)).toEqual(['spotify-signal'])
  expect(await trackRow('spotify-signal')).toMatchObject({
    library_track: { scrobbleCount: 3 },
  })
})

it('records a relink as one change per track and restores an archived Last.fm track on Undo', async () => {
  const night = nameOf('Night Drive')
  const morning = nameOf('Morning')
  await scrobble(night, 2)
  await scrobble(morning, 1)
  await refreshTrackLinks(account)
  expect((await automatic()).totalCount).toBe(0)
  await fixture
    .insert(schema.tag)
    .values({ id: 'fixture-tag', mediaType: 'track', name: 'night' })
  await fixture
    .insert(schema.mediaItemTag)
    .values({ mediaItemId: night.standaloneId, tagId: 'fixture-tag' })
  await fixture.insert(schema.providerReference).values({
    id: 'fixture-reference',
    mediaItemId: night.standaloneId,
    provider: 'musicbrainz',
    referenceType: 'recording',
    externalId: 'fixture-recording',
  })
  const archived = async () => ({
    track: await trackRow(night.standaloneId),
    tags: await fixture
      .select()
      .from(schema.mediaItemTag)
      .where(eq(schema.mediaItemTag.mediaItemId, night.standaloneId)),
    references: await fixture
      .select()
      .from(schema.providerReference)
      .where(eq(schema.providerReference.mediaItemId, night.standaloneId)),
    credits: await fixture
      .select()
      .from(schema.mediaCredit)
      .where(eq(schema.mediaCredit.mediaItemId, night.standaloneId)),
  })
  const before = await archived()

  await spotifyTrack('spotify-night', 'Night Drive')
  await spotifyTrack('spotify-morning', 'Morning')
  await refreshTrackLinks(account, 'relink')
  const page = await automatic()
  expect(page.totalCount).toBe(2)
  expect(
    page.items.map((change) => ({
      action: change.action,
      rule: change.rule,
      target: change.target?.id,
      sources: change.sources.map((source) => [source.id, source.exists]),
    })),
  ).toEqual(
    expect.arrayContaining([
      {
        action: 'merge',
        rule: 'lastfm-exact-name',
        target: 'spotify-night',
        sources: [[night.standaloneId, false]],
      },
      {
        action: 'merge',
        rule: 'lastfm-exact-name',
        target: 'spotify-morning',
        sources: [[morning.standaloneId, false]],
      },
    ]),
  )
  const [batch] = await fixture.select().from(schema.libraryChangeBatch)
  expect(batch).toMatchObject({
    trigger: 'relink',
    changeCount: 2,
    nameCount: 2,
    scrobbles: 3,
  })
  const nightChange = page.items.find(
    (change) => change.target?.id === 'spotify-night',
  )
  if (!nightChange) throw new Error('Expected the Night Drive change')

  await undoLibraryChange(nightChange.id)
  expect(await archived()).toEqual(before)
  expect(await ownerOf(night)).toEqual({
    trackId: night.standaloneId,
    manual: false,
  })
  expect(await ownerOf(morning)).toEqual({
    trackId: 'spotify-morning',
    manual: false,
  })

  await redoLibraryChange(nightChange.id)
  expect(await trackRow(night.standaloneId)).toBeUndefined()
  expect(await ownerOf(night)).toEqual({
    trackId: 'spotify-night',
    manual: false,
  })
})

it('blocks Undo of an automatic change while a later automatic change holds its names', async () => {
  const signal = nameOf('Signal')
  await spotifyTrack('spotify-first', 'Signal')
  await scrobble(signal, 1)
  await refreshTrackLinks(account)
  const first = await onlyChange()

  // The first track no longer matches; another one does.
  await fixture
    .delete(schema.mediaCredit)
    .where(eq(schema.mediaCredit.mediaItemId, 'spotify-first'))
  await spotifyTrack('spotify-second', 'Signal')
  await refreshTrackLinks(account)
  expect(await ownerOf(signal)).toEqual({
    trackId: 'spotify-second',
    manual: false,
  })
  const page = await automatic()
  const later = page.items.find((change) => change.id !== first.id)
  expect(later).toMatchObject({
    action: 'move',
    target: { id: 'spotify-second' },
    sources: [{ id: 'spotify-first', exists: true }],
  })
  if (!later) throw new Error('Expected the later change')

  expect(await getLibraryChange(first.id)).toMatchObject({
    canUndo: false,
    blocked: NAMES_MOVED,
  })
  await expect(undoLibraryChange(first.id)).rejects.toMatchObject({
    statusCode: 409,
    message: NAMES_MOVED,
  })
  await undoLibraryChange(later.id)
  expect(await getLibraryChange(first.id)).toMatchObject({ canUndo: true })
  await undoLibraryChange(first.id)
  expect(await ownerOf(signal)).toEqual({
    trackId: signal.standaloneId,
    manual: false,
  })
})

it('never moves a name between tracks the owner keeps separate', async () => {
  const signal = nameOf('Signal')
  await scrobble(signal, 2)
  await refreshTrackLinks(account)
  await spotifyTrack('spotify-signal', 'Signal')
  const [lowId, highId] = [signal.standaloneId, 'spotify-signal'].sort()
  if (!lowId || !highId) throw new Error('Expected two tracks')
  await fixture
    .insert(schema.libraryKeepSeparate)
    .values({ kind: 'track', lowId, highId })
  await refreshTrackLinks(account)
  expect(await ownerOf(signal)).toEqual({
    trackId: signal.standaloneId,
    manual: false,
  })

  // Album aliases respect the decision too.
  const release = await album('alias-album')
  const alias = nameOf('02 - Signal')
  await scrobble(alias, 1, release)
  await refreshTrackLinks(account)
  const entry = {
    title: 'Signal',
    position: 2,
    externalId: spotifyId('alias-signal'),
  }
  const recordingId = albumRecordingId(release.albumId, entry)
  const pair = [alias.standaloneId, recordingId].sort()
  await fixture.insert(schema.libraryKeepSeparate).values({
    kind: 'track',
    lowId: pair[0] ?? '',
    highId: pair[1] ?? '',
  })
  await replaceList(release.albumId, [{ title: 'Opening', position: 1 }, entry])
  expect(
    (await positions(release.albumId)).map((row) => row.trackId),
  ).toContain(recordingId)
  expect(await ownerOf(alias)).toEqual({
    trackId: alias.standaloneId,
    manual: false,
  })
  await refreshTrackLinks(account)
  expect(await ownerOf(alias)).toEqual({
    trackId: alias.standaloneId,
    manual: false,
  })
  expect((await automatic()).totalCount).toBe(0)
})

it('records album alias merges from a track-list refresh and does not make an undone one again', async () => {
  const release = await album('alias-album')
  const alias = nameOf('02 - Signal')
  await scrobble(alias, 2, release)
  await refreshTrackLinks(account)
  const list = [
    { title: 'Opening', position: 1 },
    { title: 'Signal', position: 2, externalId: spotifyId('alias-signal') },
  ]
  await replaceList(release.albumId, list)
  const recordingId = albumRecordingId(release.albumId, list[1] ?? list[0])
  expect(await ownerOf(alias)).toEqual({ trackId: recordingId, manual: false })
  const change = await onlyChange()
  expect(change).toMatchObject({
    action: 'merge',
    rule: 'album-alias',
    target: { id: recordingId },
    sources: [{ id: alias.standaloneId, exists: false }],
  })
  const [batch] = await fixture.select().from(schema.libraryChangeBatch)
  expect(batch).toMatchObject({ id: change.batchId, trigger: 'album-refresh' })

  await undoLibraryChange(change.id)
  expect(await ownerOf(alias)).toEqual({
    trackId: alias.standaloneId,
    manual: false,
  })
  await replaceList(release.albumId, list)
  await refreshTrackLinks(account)
  expect(await ownerOf(alias)).toEqual({
    trackId: alias.standaloneId,
    manual: false,
  })
  expect((await automatic()).totalCount).toBe(1)
  expect(await creditedTracks(alias)).toEqual([alias.standaloneId])
})

/** A Last.fm track linked to an album whose listed recording has its title. */
async function historyFixture() {
  const albumId = 'history-album'
  await fixture.insert(schema.mediaItem).values([
    { id: albumId, slug: albumId, title: 'History', mediaType: 'album' },
    {
      id: 'history-target',
      slug: 'history-target',
      title: 'Signal',
      mediaType: 'track',
      sourceLabel: 'album',
    },
    ...['history-first', 'history-second', 'history-manual'].map((id) => ({
      id,
      slug: id,
      title: id === 'history-second' ? ' SIGNAL ' : 'Signal',
      mediaType: 'track' as const,
      sourceLabel: 'lastfm',
    })),
  ])
  await fixture.insert(schema.album).values({ mediaItemId: albumId })
  await fixture.insert(schema.libraryTrack).values([
    {
      mediaItemId: 'history-target',
      albumMediaItemId: albumId,
      albumLinkStrategy: 'album-track-list',
      dateAdded: new Date('2024-05-01T00:00:00Z'),
    },
    ...['history-first', 'history-second', 'history-manual'].map(
      (id, index) => ({
        mediaItemId: id,
        albumMediaItemId: albumId,
        albumLinkStrategy: 'lastfm',
        dateAdded: new Date(Date.UTC(2022, index, 1)),
      }),
    ),
  ])
  await fixture.insert(schema.track).values({
    id: 'history-position',
    albumMediaItemId: albumId,
    trackMediaItemId: 'history-target',
    title: 'Signal',
    position: 1,
    metadata: {},
  })
  for (const id of [
    albumId,
    'history-target',
    'history-first',
    'history-second',
    'history-manual',
  ])
    await credit(id)
  const names = [
    { track: 'history-first', name: nameOf('Signal'), manual: false },
    { track: 'history-second', name: nameOf('Signal!'), manual: false },
    { track: 'history-manual', name: nameOf('Signal?'), manual: true },
  ]
  for (const { track, name, manual } of names) {
    await scrobble(name, 2)
    await fixture.insert(schema.lastfmTrackSource).values({
      username: account,
      artistKey: name.artistKey,
      trackKey: name.trackKey,
      trackMediaItemId: track,
      manuallyMatched: manual,
    })
    await fixture.insert(schema.lastfmTrackLink).values({
      username: account,
      artistKey: name.artistKey,
      trackKey: name.trackKey,
      trackMediaItemId: track,
      strategy: manual ? 'manual' : 'exact',
    })
  }
  await fixture.insert(schema.playlist).values([
    { id: 'history-list', name: 'History list', kind: 'playlist' },
    { id: 'history-other', name: 'History other', kind: 'playlist' },
  ])
  await fixture.insert(schema.playlistItem).values([
    {
      playlistId: 'history-list',
      mediaItemId: 'history-target',
      position: 4,
      addedAt: new Date('2024-02-01T00:00:00Z'),
    },
    {
      playlistId: 'history-list',
      mediaItemId: 'history-first',
      position: 2,
      addedAt: new Date('2024-03-01T00:00:00Z'),
    },
    {
      playlistId: 'history-other',
      mediaItemId: 'history-first',
      position: 0,
      addedAt: new Date('2023-07-01T00:00:00Z'),
    },
  ])
  return albumId
}

async function historyState() {
  return {
    items: (
      await fixture
        .select({ id: schema.mediaItem.id })
        .from(schema.mediaItem)
        .orderBy(asc(schema.mediaItem.id))
    ).map((row) => row.id),
    tracks: await fixture
      .select({
        id: schema.libraryTrack.mediaItemId,
        dateAdded: schema.libraryTrack.dateAdded,
        scrobbles: schema.libraryTrack.scrobbleCount,
        last: schema.libraryTrack.lastListenedAt,
      })
      .from(schema.libraryTrack)
      .orderBy(asc(schema.libraryTrack.mediaItemId)),
    sources: await fixture
      .select()
      .from(schema.lastfmTrackSource)
      .orderBy(asc(schema.lastfmTrackSource.trackKey)),
    links: await fixture
      .select()
      .from(schema.lastfmTrackLink)
      .orderBy(
        asc(schema.lastfmTrackLink.trackKey),
        asc(schema.lastfmTrackLink.trackMediaItemId),
      ),
    entries: await playlistEntries(),
  }
}

it('gives album listening history to the listed recording exactly as the SQL function did', async () => {
  const migration = readMigrationFiles({ migrationsFolder: './drizzle' })
    .flatMap((file) => file.sql)
    .find((statement) =>
      statement.includes('CREATE FUNCTION merge_album_track_history'),
    )
  if (!migration) throw new Error('Expected the album history function')
  await pool.query(migration)
  try {
    const albumId = await historyFixture()
    await pool.query('select merge_album_track_history($1)', [albumId])
    const expected = await historyState()
    expect(expected.items).not.toContain('history-first')
    expect(expected.items).toContain('history-manual')

    await fixture.delete(schema.playlist)
    await fixture.delete(schema.lastfmScrobble)
    await fixture.delete(schema.track)
    await fixture.delete(schema.mediaItem)
    await historyFixture()
    await fixture.transaction((tx) => mergeAlbumTrackHistory(tx, albumId))
    expect(await historyState()).toEqual(expected)
    const change = await onlyChange()
    expect(change).toMatchObject({
      action: 'merge',
      rule: 'album-history',
      target: { id: 'history-target' },
      nameCount: 2,
      details: { counts: { 'playlist-entry': 2 } },
    })
  } finally {
    await pool.query('drop function if exists merge_album_track_history(text)')
  }
})

it('keeps an album history recording with a native provider ID separate', async () => {
  const albumId = await historyFixture()
  const reference = {
    id: 'history-tidal-reference',
    mediaItemId: 'history-first',
    provider: 'tidal',
    referenceType: 'track',
    externalId: '910001',
  }
  await fixture.insert(schema.providerReference).values(reference)

  await fixture.transaction((tx) => mergeAlbumTrackHistory(tx, albumId))
  expect(await fixture.select().from(schema.providerReference)).toEqual([
    expect.objectContaining(reference),
  ])
  const state = await historyState()
  expect(state.items).toContain('history-first')
  expect(state.items).not.toContain('history-second')
  expect(state.sources).toContainEqual(
    expect.objectContaining({ trackMediaItemId: 'history-first' }),
  )
})

it('records an album history merge from a track-list refresh, puts it back and does not make it again', async () => {
  const release = await album('history-refresh')
  const signal = nameOf('Signal')
  await scrobble(signal, 2, release)
  await refreshTrackLinks(account)
  await spotifyTrack('spotify-history', 'Signal', { albumId: release.albumId })
  await fixture.insert(schema.playlist).values([
    { id: 'history-list', name: 'History list', kind: 'playlist' },
    { id: 'history-other', name: 'History other', kind: 'playlist' },
  ])
  await fixture.insert(schema.playlistItem).values([
    {
      playlistId: 'history-list',
      mediaItemId: 'spotify-history',
      position: 3,
      addedAt: new Date('2024-02-01T00:00:00Z'),
    },
    {
      playlistId: 'history-list',
      mediaItemId: signal.standaloneId,
      position: 1,
      addedAt: new Date('2024-03-01T00:00:00Z'),
    },
    {
      playlistId: 'history-other',
      mediaItemId: signal.standaloneId,
      position: 0,
      addedAt: new Date('2023-07-01T00:00:00Z'),
    },
  ])
  const entriesBefore = await playlistEntries()
  const sourceBefore = await trackRow(signal.standaloneId)

  const list = [{ title: 'Signal', position: 1 }]
  await replaceList(release.albumId, list)
  expect(await ownerOf(signal)).toEqual({
    trackId: 'spotify-history',
    manual: false,
  })
  expect(await trackRow(signal.standaloneId)).toBeUndefined()
  const change = await onlyChange()
  expect(change).toMatchObject({
    action: 'merge',
    rule: 'album-history',
    target: { id: 'spotify-history' },
    sources: [{ id: signal.standaloneId, exists: false }],
    details: { counts: { 'playlist-entry': 2 } },
  })

  // Archives made before the catalog migration have no membership column.
  await fixture
    .update(schema.libraryChangeRemoval)
    .set({
      snapshot: sql`${schema.libraryChangeRemoval.snapshot} #- '{mediaItem,in_library}'`,
    })
    .where(eq(schema.libraryChangeRemoval.changeId, change.id))

  await undoLibraryChange(change.id)
  expect(await ownerOf(signal)).toEqual({
    trackId: signal.standaloneId,
    manual: false,
  })
  expect(await playlistEntries()).toEqual(entriesBefore)
  expect(await trackRow(signal.standaloneId)).toMatchObject({
    media_item: sourceBefore?.media_item,
    library_track: {
      ...sourceBefore?.library_track,
      updatedAt: expect.any(Date),
    },
  })

  await replaceList(release.albumId, list)
  expect(await ownerOf(signal)).toEqual({
    trackId: signal.standaloneId,
    manual: false,
  })
  expect((await automatic()).totalCount).toBe(1)

  await redoLibraryChange(change.id)
  expect(await ownerOf(signal)).toEqual({
    trackId: 'spotify-history',
    manual: false,
  })
  expect(await trackRow(signal.standaloneId)).toBeUndefined()
})

it('keeps album history discoveries and prior addresses through merge, undo and redo', async () => {
  const albumId = await historyFixture()
  const source = 'history-first'
  const target = 'history-target'
  const alias = 'earlier-address'
  await fixture.transaction((tx) => setCatalogMediaAlias(tx, alias, source))
  await fixture.insert(schema.catalogObservation).values([
    {
      id: 'prior-discovery',
      targetKind: 'track',
      targetId: alias,
      mediaItemId: source,
      provider: 'tidal',
      operation: 'similar',
    },
    {
      id: 'source-discovery',
      targetKind: 'track',
      targetId: source,
      mediaItemId: source,
      provider: 'spotify',
      operation: 'now-playing',
    },
    {
      id: 'target-discovery',
      targetKind: 'track',
      targetId: target,
      mediaItemId: target,
      provider: 'spotify',
      operation: 'album-tracks',
    },
  ])
  const sourcesAt = async (id: string) =>
    (await listCatalogObservations(id, { page: 1, size: 10 })).items
      .map((item) => item.operation)
      .sort()

  await fixture.transaction((tx) => mergeAlbumTrackHistory(tx, albumId))
  const change = await onlyChange()
  expect(await trackRow(source)).toBeUndefined()
  expect(await sourcesAt(target)).toEqual([
    'album-tracks',
    'now-playing',
    'similar',
  ])
  expect(await sourcesAt(alias)).toEqual(await sourcesAt(target))
  await fixture.transaction((tx) =>
    observeCatalogOccurrence(
      tx,
      { kind: 'track', id: source },
      {
        provider: 'fixture',
        operation: 'replayed-response',
        occurrenceKey: 'fixture-response',
      },
    ),
  )
  expect(await sourcesAt(target)).toEqual([
    'album-tracks',
    'now-playing',
    'replayed-response',
    'similar',
  ])

  await undoLibraryChange(change.id)
  expect(await sourcesAt(alias)).toEqual([
    'now-playing',
    'replayed-response',
    'similar',
  ])
  expect(await sourcesAt(source)).toEqual(await sourcesAt(alias))
  expect(await sourcesAt(target)).toEqual(['album-tracks'])

  await fixture
    .insert(schema.playlist)
    .values({ id: 'new-list', name: 'New List', kind: 'playlist' })
  await fixture
    .insert(schema.playlistItem)
    .values({ playlistId: 'new-list', mediaItemId: source })
  await expect(redoLibraryChange(change.id)).rejects.toMatchObject({
    statusCode: 409,
  })
  expect(await sourcesAt(source)).toEqual([
    'now-playing',
    'replayed-response',
    'similar',
  ])
  expect(await sourcesAt(target)).toEqual(['album-tracks'])
  await fixture
    .delete(schema.playlistItem)
    .where(eq(schema.playlistItem.playlistId, 'new-list'))

  await redoLibraryChange(change.id)
  expect(await trackRow(source)).toBeUndefined()
  expect(await sourcesAt(alias)).toEqual(await sourcesAt(target))
  expect(await sourcesAt(source)).toEqual([
    'album-tracks',
    'now-playing',
    'replayed-response',
    'similar',
  ])
})

it('keeps explicitly added tracks and never gives a member’s history to an outside track automatically', async () => {
  const albumId = await historyFixture()
  await fixture
    .insert(schema.catalogAddition)
    .values({ mediaItemId: 'history-first' })
  await fixture
    .update(schema.mediaItem)
    .set({ inLibrary: false })
    .where(eq(schema.mediaItem.id, 'history-target'))

  await fixture.transaction((tx) => mergeAlbumTrackHistory(tx, albumId))
  expect((await automatic()).totalCount).toBe(0)
  expect(await trackRow('history-first')).toBeDefined()
  expect(await trackRow('history-second')).toBeDefined()

  await fixture
    .update(schema.mediaItem)
    .set({ inLibrary: true })
    .where(eq(schema.mediaItem.id, 'history-target'))
  await fixture.transaction((tx) => mergeAlbumTrackHistory(tx, albumId))
  expect((await automatic()).totalCount).toBe(1)
  expect(await trackRow('history-first')).toBeDefined()
  expect(await trackRow('history-second')).toBeUndefined()
})

function candidate(title: string, suffix: string): SpotifyTrackSearchCandidate {
  const spotifyTrackId = 'fixturetrack'.padEnd(22, suffix)
  return {
    spotifyTrackId,
    title,
    artists: [ARTIST],
    artistCredits: [],
    albumName: 'Fixture Album',
    spotifyAlbumId: 'fixturealbum'.padEnd(22, suffix),
    durationSec: 180,
    isrc: null,
    artworkUrl: null,
    spotifyUrl: `https://open.spotify.com/track/${spotifyTrackId}`,
  }
}

/** A Last.fm-only track with a saved Spotify search for it. */
async function searchedTrack(name: Name, found: SpotifyTrackSearchCandidate) {
  const trackId = name.standaloneId
  await fixture.insert(schema.mediaItem).values({
    id: trackId,
    slug: slugifyParts(name.trackName, trackId),
    title: name.trackName,
    mediaType: 'track',
    sourceLabel: 'lastfm',
  })
  await fixture.insert(schema.libraryTrack).values({ mediaItemId: trackId })
  await credit(trackId)
  await fixture.insert(schema.lastfmTrackSource).values({
    username: account,
    artistKey: name.artistKey,
    trackKey: name.trackKey,
    trackMediaItemId: trackId,
  })
  await scrobble(name, 2)
  return { trackId, jobId: await saveSearch(trackId, name.trackName, found) }
}

async function saveSearch(
  trackId: string,
  title: string,
  found: SpotifyTrackSearchCandidate,
  createdAt = new Date('2026-01-01T00:00:00Z'),
) {
  const id = randomUUID()
  const query = `track:"${title}" artist:"${ARTIST}"`
  await fixture.insert(schema.scrapeJob).values({
    id,
    provider: 'spotify',
    status: 'succeeded',
    scope: { mediaType: 'track', mediaItemIds: [trackId] },
    options: {
      task: SPOTIFY_TRACK_SEARCH_TASK,
      trackId,
      trackTitle: title,
      query,
      resultCount: 1,
      groupKey: createStableId(
        SPOTIFY_TRACK_SEARCH_TASK,
        JSON.stringify([userId, trackId]),
      ),
    },
    createdAt,
    startedAt: createdAt,
    finishedAt: new Date(createdAt.getTime() + 60000),
    requestedByUserId: userId,
  })
  await fixture.insert(schema.scrapeJobLog).values({
    id: `${id}-log`,
    jobId: id,
    level: 'success',
    message: 'Fixture search completed',
    metadata: {
      diagnostics: [
        { kind: SPOTIFY_TRACK_SEARCH_TASK, query, candidates: [found] },
      ],
    },
  })
  return id
}

it('undoes an automatic Spotify search match, removes the track it made and does not make it again', async () => {
  const signal = nameOf('Signal')
  const found = candidate('Signal', '1')
  const { trackId, jobId } = await searchedTrack(signal, found)
  const targetId = spotifyTrackItemId(found.spotifyTrackId)
  const batchId = await fixture.transaction((tx) =>
    openChangeBatch(tx, 'spotify-search'),
  )
  expect(
    await reconcileSavedSpotifyTrackSearch(
      { trackId, jobId, userId },
      { batchId },
    ),
  ).toEqual({ status: 'matched', targetId })
  expect(await ownerOf(signal)).toEqual({ trackId: targetId, manual: false })
  const change = await onlyChange({ batchId })
  expect(change).toMatchObject({
    action: 'merge',
    actor: 'automatic',
    rule: 'spotify-search',
    target: { id: targetId, exists: true },
    sources: [{ id: trackId, exists: false }],
    canUndo: true,
  })

  await undoLibraryChange(change.id)
  expect(await trackRow(targetId)).toBeUndefined()
  expect(await ownerOf(signal)).toEqual({ trackId, manual: false })
  expect(await rejections()).toMatchObject([
    { recordId: targetId, reason: 'undo', rule: 'spotify-search' },
  ])
  await redoLibraryChange(change.id)
  expect(await trackRow(targetId)).toMatchObject({
    library_track: { spotifyTrackId: found.spotifyTrackId },
  })
  expect(await ownerOf(signal)).toEqual({ trackId: targetId, manual: false })
  expect(await trackRow(trackId)).toBeUndefined()
  await undoLibraryChange(change.id)

  // The used search, a new search with the same result and the next import
  // all leave the name where Undo put it.
  expect(
    await reconcileSavedSpotifyTrackSearch({ trackId, jobId, userId }),
  ).toEqual({ status: 'stale' })
  const again = await saveSearch(
    trackId,
    'Signal',
    found,
    new Date('2026-02-01T00:00:00Z'),
  )
  expect(
    await reconcileSavedSpotifyTrackSearch({ trackId, jobId: again, userId }),
  ).toEqual({ status: 'unmatched' })
  await importLastfmLibraryTracks(account)
  expect(await ownerOf(signal)).toEqual({ trackId, manual: false })
  expect(await trackRow(targetId)).toBeUndefined()
  expect((await automatic()).totalCount).toBe(1)
})

it('undoes an automatic Spotify search match onto an existing track and puts its identity back', async () => {
  const signal = nameOf('Signal')
  const found = candidate('Signal', '2')
  await spotifyTrack('spotify-existing', 'Signal', {
    spotifyTrackId: found.spotifyTrackId,
  })
  const { trackId, jobId } = await searchedTrack(signal, found)
  const before = await trackRow('spotify-existing')
  expect(
    await reconcileSavedSpotifyTrackSearch({ trackId, jobId, userId }),
  ).toEqual({ status: 'matched', targetId: 'spotify-existing' })
  const change = await onlyChange()
  expect(change.target?.id).toBe('spotify-existing')

  await undoLibraryChange(change.id)
  const after = await trackRow('spotify-existing')
  expect({
    ...after?.media_item,
    updatedAt: before?.media_item.updatedAt,
  }).toEqual(before?.media_item)
  expect({
    ...after?.library_track,
    updatedAt: before?.library_track.updatedAt,
  }).toEqual(before?.library_track)
  await importLastfmLibraryTracks(account)
  expect(await ownerOf(signal)).toEqual({ trackId, manual: false })
  expect(await creditedTracks(signal)).toEqual([trackId])
})

it('undoes an accepted Spotify search with the album position and playlist entry it moved', async () => {
  const signal = nameOf('Signal')
  const found = candidate('Signal', '3')
  const { trackId, jobId } = await searchedTrack(signal, found)
  const release = await album('accepted-album')
  await fixture.insert(schema.track).values({
    id: 'accepted-position',
    albumMediaItemId: release.albumId,
    trackMediaItemId: trackId,
    title: 'Signal',
    position: 1,
    metadata: {},
  })
  await fixture
    .insert(schema.playlist)
    .values({ id: 'accepted-list', name: 'Accepted', kind: 'playlist' })
  await fixture.insert(schema.playlistItem).values({
    playlistId: 'accepted-list',
    mediaItemId: trackId,
    position: 0,
    addedAt: new Date('2024-01-01T00:00:00Z'),
  })
  await refreshTrackLinks(account)
  const before = {
    track: await trackRow(trackId),
    positions: await positions(release.albumId),
    entries: await playlistEntries(),
  }
  const targetId = spotifyTrackItemId(found.spotifyTrackId)

  expect(
    await acceptSpotifyTrackSearch({
      trackId,
      jobId,
      spotifyTrackId: found.spotifyTrackId,
      userId,
    }),
  ).toEqual({ targetId })
  expect(await positions(release.albumId)).toMatchObject([
    { id: 'accepted-position', trackId: targetId },
  ])
  expect(await playlistEntries()).toMatchObject([{ mediaItemId: targetId }])
  expect(await ownerOf(signal)).toEqual({ trackId: targetId, manual: true })
  const page = await listLibraryChanges(
    LibraryChangeListQuerySchema.parse({ actor: 'owner' }),
  )
  expect(page.items).toMatchObject([
    {
      action: 'merge',
      actor: 'owner',
      rule: null,
      target: { id: targetId },
      sources: [{ id: trackId, exists: false }],
      details: { counts: { position: 1, 'playlist-entry': 1 } },
      canUndo: true,
    },
  ])
  const changeId = page.items[0]?.id ?? ''

  await undoLibraryChange(changeId)
  expect({
    track: await trackRow(trackId),
    positions: await positions(release.albumId),
    entries: await playlistEntries(),
  }).toEqual(before)
  expect(await trackRow(targetId)).toBeUndefined()
  expect(await ownerOf(signal)).toEqual({ trackId, manual: false })
  const [job] = await fixture
    .select({ options: schema.scrapeJob.options })
    .from(schema.scrapeJob)
    .where(eq(schema.scrapeJob.id, jobId))
  expect(job?.options).not.toHaveProperty('acceptedTrackId')
  expect(await rejections()).toEqual([])

  await redoLibraryChange(changeId)
  expect(await positions(release.albumId)).toMatchObject([
    { id: 'accepted-position', trackId: targetId },
  ])
  expect(await ownerOf(signal)).toEqual({ trackId: targetId, manual: true })
  expect(await trackRow(trackId)).toBeUndefined()
})

it('remembers a separated automatic match and forgets it when the name returns to automatic matching', async () => {
  const signal = nameOf('Signal')
  await spotifyTrack('spotify-signal', 'Signal')
  await scrobble(signal, 2)
  await refreshTrackLinks(account)
  expect(await ownerOf(signal)).toEqual({
    trackId: 'spotify-signal',
    manual: false,
  })

  const separated = await removeScrobbleTrackMatch('spotify-signal', {
    artistKey: signal.artistKey,
    trackKey: signal.trackKey,
    mode: 'separate',
  })
  expect(await ownerOf(signal)).toEqual({
    trackId: signal.standaloneId,
    manual: true,
  })
  expect(await rejections()).toMatchObject([
    { recordId: 'spotify-signal', reason: 'separate', rule: null },
  ])
  expect(await creditedTracks(signal)).toEqual([signal.standaloneId])
  const separation = separated.changeId ?? ''
  await undoLibraryChange(separation)
  expect(await rejections()).toEqual([])
  expect(await ownerOf(signal)).toEqual({
    trackId: 'spotify-signal',
    manual: false,
  })
  await redoLibraryChange(separation)
  expect(await rejections()).toMatchObject([{ recordId: 'spotify-signal' }])

  const rematched = await removeScrobbleTrackMatch(signal.standaloneId, {
    artistKey: signal.artistKey,
    trackKey: signal.trackKey,
    mode: 'automatic',
  })
  expect(await rejections()).toEqual([])
  expect(await ownerOf(signal)).toEqual({
    trackId: 'spotify-signal',
    manual: false,
  })
  expect(await creditedTracks(signal)).toEqual(['spotify-signal'])
  await undoLibraryChange(rematched.changeId ?? '')
  expect(await rejections()).toMatchObject([{ recordId: 'spotify-signal' }])
  expect(await ownerOf(signal)).toEqual({
    trackId: signal.standaloneId,
    manual: true,
  })
})

it('records Spotify album recording merges so they can be undone, and keeps undone ones apart', async () => {
  const release = await album('spotify-release', { spotify: true })
  await replaceList(release.albumId, [
    { title: 'One', position: 1 },
    { title: 'Two', position: 2 },
  ])
  const [first, second] = await positions(release.albumId)
  if (!first || !second) throw new Error('Expected two album recordings')
  const one = nameOf('One')
  await scrobble(one, 2, release)
  await refreshTrackLinks(account)
  expect(await ownerOf(one)).toEqual({ trackId: first.trackId, manual: false })
  await fixture.delete(schema.libraryChange)

  const spotifyAlbumId = spotifyId(release.albumId)
  await spotifyTrack('spotify-one', 'One', { spotifyAlbumId })
  await spotifyTrack('spotify-two', 'Two', { spotifyAlbumId })
  const before = {
    positions: await positions(release.albumId),
    one: await trackRow(first.trackId),
    two: await trackRow(second.trackId),
  }
  await refreshTrackLinks(account)
  expect(await positions(release.albumId)).toMatchObject([
    { trackId: 'spotify-one' },
    { trackId: 'spotify-two' },
  ])
  expect(await trackRow(first.trackId)).toBeUndefined()
  expect(await trackRow(second.trackId)).toBeUndefined()
  expect(await ownerOf(one)).toEqual({ trackId: 'spotify-one', manual: false })
  const page = await automatic()
  expect(page.totalCount).toBe(2)
  expect(page.items).toEqual(
    expect.arrayContaining(
      ['spotify-one', 'spotify-two'].map((target) =>
        expect.objectContaining({
          action: 'merge',
          rule: 'spotify-album-recording',
          target: expect.objectContaining({ id: target }),
          details: { counts: { position: 1 } },
          canUndo: true,
        }),
      ),
    ),
  )

  for (const change of page.items) await undoLibraryChange(change.id)
  expect(await positions(release.albumId)).toEqual(before.positions)
  expect(await trackRow(first.trackId)).toMatchObject({
    media_item: before.one?.media_item,
  })
  expect(await trackRow(second.trackId)).toMatchObject({
    media_item: before.two?.media_item,
  })
  expect(await trackRow('spotify-one')).toMatchObject({
    library_track: { albumMediaItemId: null },
  })
  expect(await ownerOf(one)).toEqual({ trackId: first.trackId, manual: false })
  expect(await fixture.select().from(schema.libraryKeepSeparate)).toMatchObject(
    [{ kind: 'track' }],
  )
  expect(await rejections()).toMatchObject([{ recordId: 'spotify-one' }])

  for (const change of page.items) await redoLibraryChange(change.id)
  expect(await positions(release.albumId)).toMatchObject([
    { trackId: 'spotify-one' },
    { trackId: 'spotify-two' },
  ])
  expect(await trackRow(second.trackId)).toBeUndefined()
  expect(await fixture.select().from(schema.libraryKeepSeparate)).toEqual([])
  expect(await rejections()).toEqual([])

  // Undone again, the next relink does not merge them again.
  for (const change of page.items) await undoLibraryChange(change.id)
  await refreshTrackLinks(account)
  expect(await positions(release.albumId)).toEqual(before.positions)
  expect(await ownerOf(one)).toEqual({ trackId: first.trackId, manual: false })
  expect((await automatic()).totalCount).toBe(2)
})

it('restores an outside recording and its exact native artist when undoing a Spotify album merge', async () => {
  const release = await album('spotify-catalog-release', { spotify: true })
  await fixture.transaction((tx) =>
    replaceAlbumTracks(
      tx,
      release.albumId,
      [{ title: 'Signal', position: 1 }],
      { provider: 'fixture' },
    ),
  )
  const [position] = await positions(release.albumId)
  if (!position) throw new Error('Expected an album recording')
  const source = position.trackId
  // Preserve the legacy fixture: before album positions granted membership,
  // a saved album could still list a recording outside the library.
  await fixture
    .update(schema.mediaItem)
    .set({ inLibrary: false })
    .where(eq(schema.mediaItem.id, source))
  const target = 'spotify-catalog-signal'
  await spotifyTrack(target, 'Signal', {
    spotifyAlbumId: spotifyId(release.albumId),
  })
  const nativeArtistId = 'native-fixture-artist'
  await fixture.insert(schema.artist).values({
    id: nativeArtistId,
    name: ARTIST,
    catalogProvider: 'spotify',
    catalogExternalId: 'fixture-identity',
  })
  await fixture
    .update(schema.mediaCredit)
    .set({ artistId: nativeArtistId })
    .where(inArray(schema.mediaCredit.mediaItemId, [source, target]))

  await refreshTrackLinks(account)
  const change = await onlyChange()
  expect(await trackRow(source)).toBeUndefined()
  const discoveries = (id: string) =>
    listCatalogObservations(id, { page: 1, size: 10 })
  expect((await discoveries(source)).items).toMatchObject([
    { targetId: source, mediaItemId: target },
  ])

  await undoLibraryChange(change.id)
  expect(await trackRow(source)).toMatchObject({
    media_item: { inLibrary: false },
  })
  expect(
    await fixture
      .select()
      .from(schema.mediaCredit)
      .where(eq(schema.mediaCredit.mediaItemId, source)),
  ).toMatchObject([{ artistId: nativeArtistId }])
  expect((await discoveries(source)).items).toMatchObject([
    { targetId: source, mediaItemId: source },
  ])
  expect((await discoveries(target)).totalCount).toBe(0)

  await redoLibraryChange(change.id)
  expect(await trackRow(source)).toBeUndefined()
  expect((await discoveries(source)).items).toMatchObject([
    { targetId: source, mediaItemId: target },
  ])
})

it('records album recordings a track-list refresh removes, with their archive', async () => {
  const release = await album('shrinking-album')
  await replaceList(release.albumId, [
    { title: 'One', position: 1 },
    { title: 'Two', position: 2 },
  ])
  const [, second] = await positions(release.albumId)
  if (!second) throw new Error('Expected two album recordings')
  await fixture
    .insert(schema.tag)
    .values({ id: 'fixture-tag', mediaType: 'track', name: 'kept' })
  await fixture
    .insert(schema.mediaItemTag)
    .values({ mediaItemId: second.trackId, tagId: 'fixture-tag' })

  await replaceList(release.albumId, [{ title: 'One', position: 1 }])
  expect(await trackRow(second.trackId)).toBeUndefined()
  const change = await onlyChange()
  expect(change).toMatchObject({
    action: 'remove',
    rule: 'album-track-list',
    reversible: false,
    canUndo: false,
    blocked: 'This change cannot be undone.',
    sources: [{ id: second.trackId, title: 'Two', exists: false }],
  })
  const [removal] = await fixture
    .select()
    .from(schema.libraryChangeRemoval)
    .where(eq(schema.libraryChangeRemoval.changeId, change.id))
  expect(removal).toMatchObject({
    recordId: second.trackId,
    snapshot: { tagIds: ['fixture-tag'] },
  })
  await expect(undoLibraryChange(change.id)).rejects.toMatchObject({
    statusCode: 409,
  })
})

it('records a large first import with set-based writes', async () => {
  const total = 10000
  const matched = 3000
  await pool.query(
    `insert into lastfm_scrobble (id, username, listened_at, artist_name,
       track_name, artist_key, track_key)
     select 'bulk-' || n, $1, timestamp '2024-01-01' + n * interval '1 minute',
       $2, 'Bulk ' || n, $3, 'bulk ' || n
     from generate_series(1, $4::int) n`,
    [account, ARTIST, albumNameKey(ARTIST), total],
  )
  await pool.query(
    `insert into media_item (id, slug, media_type, title, source_label)
     select 'bulk-track-' || n, 'bulk-track-' || n, 'track', 'Bulk ' || n, 'spotify'
     from generate_series(1, $1::int) n`,
    [matched],
  )
  await pool.query(
    `insert into library_track (media_item_id, spotify_track_id)
     select 'bulk-track-' || n, lpad(n::text, 22, 'b')
     from generate_series(1, $1::int) n`,
    [matched],
  )
  await pool.query(
    `insert into media_credit (media_item_id, artist_id, role)
     select 'bulk-track-' || n, $2, 'artist' from generate_series(1, $1::int) n`,
    [matched, artistId],
  )
  // As autovacuum does for a stored library.
  for (const table of ['lastfm_scrobble', 'media_item', 'library_track'])
    await pool.query(`analyze ${table}`)
  const batchId = await fixture.transaction((tx) =>
    openChangeBatch(tx, 'lastfm-sync'),
  )
  const started = performance.now()
  await importLastfmLibraryTracks(account, batchId)
  const seconds = (performance.now() - started) / 1000
  const [batch] = await fixture
    .select()
    .from(schema.libraryChangeBatch)
    .where(eq(schema.libraryChangeBatch.id, batchId))
  expect(batch).toMatchObject({
    changeCount: matched,
    nameCount: matched,
    scrobbles: matched,
  })
  const counts = await pool.query<{ table: string; count: number }>(`
    select 'change' as table, count(*)::int as count from library_change
    union all select 'move', count(*)::int from library_change_move
    union all select 'effect', count(*)::int from library_change_effect
    union all select 'removal', count(*)::int from library_change_removal`)
  expect(counts.rows).toEqual([
    { table: 'change', count: matched },
    { table: 'move', count: matched },
    { table: 'effect', count: matched },
    { table: 'removal', count: 0 },
  ])
  expect(seconds).toBeGreaterThan(0)
  const owners = await fixture
    .select({ id: schema.lastfmTrackSource.trackMediaItemId })
    .from(schema.lastfmTrackSource)
    .where(
      inArray(schema.lastfmTrackSource.trackMediaItemId, [
        'bulk-track-1',
        `bulk-track-${matched}`,
      ]),
    )
  expect(owners).toHaveLength(2)
  process.stdout.write(
    `first import of ${total} names (${matched} matched): ${seconds.toFixed(1)} s\n`,
  )
}, 600000)
