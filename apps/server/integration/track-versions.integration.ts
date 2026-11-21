import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { asc, eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { TrackQuerySchema } from '@repo/schemas/tracks'
import { env } from '@/env'
import { albumNameKey } from '@/lib/album-import-candidates'
import { standaloneLastfmTrackId } from '@/lib/track-matching'
import * as schema from '@/schemas/db'

const database = 'track_versions_' + randomUUID().replaceAll('-', '')
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
  listLoadedScrapePlugins: async () => [],
}))

import { importLastfmLibraryTracks } from '@/services/lastfm-library-tracks'
import {
  redoLibraryChange,
  undoLibraryChange,
} from '@/services/library-changes'
import { refreshTrackAddedDates } from '@/services/spotify-playlists'
import { linkScrobblesToTracks } from '@/services/track-links'
import { planTrackMerge } from '@/services/track-merge-plan'
import { mergeTracks } from '@/services/track-merges'
import {
  listTrackBrowsePage,
  listTrackRecordingVersions,
} from '@/services/tracks'
import {
  readAlbumUnlistedNames,
  readTrackParts,
  separateTrackVersion,
  showTrackVersion,
} from '@/services/track-versions'

const account = 'fixture-versions'
const artistId = 'versions-artist'
const albumId = 'versions-album'
const playlistId = 'versions-playlist'
const first = 'versions-first'
const reissue = 'versions-reissue'

function scrobbledName(
  trackName: string,
  count: number,
  album: string | null = null,
) {
  const key = {
    artistKey: albumNameKey('Fixture Artist'),
    trackKey: albumNameKey(trackName),
  }
  return {
    ...key,
    trackName,
    count,
    album,
    id: standaloneLastfmTrackId(account, key),
  }
}
// Owned by the two Spotify tracks.
const firstName = scrobbledName('Glass Meridian', 3)
const reissueName = scrobbledName('Glass Meridian - Remastered', 2)
// Last.fm-only tracks: one on the album and a playlist, one not on the album.
const lastfmName = scrobbledName('Glas Meridian', 4, albumId)
const looseName = scrobbledName('Low Lanterns', 2, albumId)
const names = [firstName, reissueName, lastfmName, looseName]
const lastfmTrack = lastfmName.id

const tracksOf = (ids: string[]) =>
  fixture
    .select()
    .from(schema.libraryTrack)
    .where(inArray(schema.libraryTrack.mediaItemId, ids))
    .orderBy(asc(schema.libraryTrack.mediaItemId))
const versionsOf = async (ids: string[]) =>
  (await tracksOf(ids)).map((row) => ({
    id: row.mediaItemId,
    group: row.versionGroupId,
    shown: row.versionShown,
    scrobbles: row.scrobbleCount,
  }))

/** Everything a merge of the Last.fm track can touch, as full rows. */
const memberships = async () => ({
  tracks: await tracksOf([first, reissue, lastfmTrack]),
  media: await fixture
    .select()
    .from(schema.mediaItem)
    .where(eq(schema.mediaItem.id, lastfmTrack)),
  positions: await fixture
    .select()
    .from(schema.track)
    .orderBy(asc(schema.track.id)),
  entries: await fixture
    .select()
    .from(schema.playlistItem)
    .orderBy(asc(schema.playlistItem.mediaItemId)),
  sources: await fixture
    .select()
    .from(schema.lastfmTrackSource)
    .orderBy(asc(schema.lastfmTrackSource.trackKey)),
  credits: await fixture
    .select()
    .from(schema.mediaCredit)
    .where(eq(schema.mediaCredit.mediaItemId, lastfmTrack)),
})

const groupedRows = async () =>
  (
    await listTrackBrowsePage(
      TrackQuerySchema.parse({
        groupRecordings: true,
        q: 'Glass Meridian',
        sortBy: 'title',
      }),
    )
  ).items
    .map((item) => ({
      id: item.id,
      versions: item.recordingGroup?.versionCount ?? 1,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))

let created = false
beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => {
      throw new Error('Unexpected provider request')
    }),
  )
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
  await fixture.delete(schema.playlist)
  await fixture.delete(schema.lastfmScrobble)
  await fixture.delete(schema.track)
  await fixture.delete(schema.mediaItem)
  await fixture.delete(schema.artist)
  await fixture.insert(schema.mediaItem).values([
    {
      id: first,
      slug: first,
      title: 'Glass Meridian',
      mediaType: 'track',
      sourceLabel: 'spotify',
    },
    {
      id: reissue,
      slug: reissue,
      title: 'Glass Meridian - Remastered',
      mediaType: 'track',
      sourceLabel: 'spotify',
    },
    {
      id: albumId,
      slug: albumId,
      title: 'Harbour Lights',
      mediaType: 'album',
    },
  ])
  await fixture.insert(schema.album).values({ mediaItemId: albumId })
  await fixture.insert(schema.libraryTrack).values([
    {
      mediaItemId: first,
      spotifyTrackId: 'GlassMeridian'.padEnd(22, '0'),
      durationSec: 200,
    },
    {
      mediaItemId: reissue,
      spotifyTrackId: 'GlassReissue'.padEnd(22, '0'),
      durationSec: 203,
    },
  ])
  await fixture.insert(schema.artist).values({
    id: artistId,
    name: 'Fixture Artist',
  })
  await fixture.insert(schema.mediaCredit).values(
    [first, reissue, albumId].map((mediaItemId) => ({
      mediaItemId,
      artistId,
      role: 'artist',
    })),
  )
  await fixture.insert(schema.lastfmScrobble).values(
    names.flatMap((name) =>
      Array.from({ length: name.count }, (_, index) => ({
        id: `${name.id}-${index}`,
        username: account,
        artistName: 'Fixture Artist',
        artistKey: name.artistKey,
        trackName: name.trackName,
        trackKey: name.trackKey,
        albumMediaItemId: name.album,
        listenedAt: new Date(Date.UTC(2023, 0, 1 + index)),
      })),
    ),
  )
  await fixture.insert(schema.lastfmTrackSource).values(
    [
      { name: firstName, trackId: first },
      { name: reissueName, trackId: reissue },
    ].map(({ name, trackId }) => ({
      username: account,
      artistKey: name.artistKey,
      trackKey: name.trackKey,
      trackMediaItemId: trackId,
      manuallyMatched: true,
    })),
  )
  await importLastfmLibraryTracks(account)
  await fixture.insert(schema.track).values({
    id: 'versions-position',
    albumMediaItemId: albumId,
    trackMediaItemId: lastfmTrack,
    title: 'Glas Meridian',
    position: 2,
  })
  await fixture
    .insert(schema.playlist)
    .values({ id: playlistId, name: 'Fixture', kind: 'playlist' })
  await fixture.insert(schema.playlistItem).values([
    {
      playlistId,
      mediaItemId: first,
      position: 7,
      addedAt: new Date('2024-05-01T10:00:00.123456Z'),
    },
    {
      playlistId,
      mediaItemId: lastfmTrack,
      position: 3,
      addedAt: new Date('2024-02-01T10:00:00Z'),
    },
  ])
  await linkScrobblesToTracks(account)
  await fixture.transaction((tx) => refreshTrackAddedDates(tx))
})

it('joins two Spotify tracks as versions of one record', async () => {
  const before = await tracksOf([first, reissue])
  const plan = await planTrackMerge({ trackIds: [reissue, first] })
  expect(plan).toMatchObject({
    targetId: first,
    blocked: false,
    cautions: [],
    names: [],
    scrobbles: { target: 3, added: 2, total: 5 },
  })
  expect(plan.tracks.map(({ id, outcome }) => ({ id, outcome }))).toEqual([
    { id: first, outcome: 'keep' },
    { id: reissue, outcome: 'version' },
  ])
  expect(await groupedRows()).toEqual([
    { id: first, versions: 1 },
    { id: reissue, versions: 1 },
  ])

  const merged = await mergeTracks({
    trackIds: [reissue, first],
    reviewed: false,
  })
  expect(merged).toMatchObject({
    action: 'merge',
    target: { id: first, exists: true },
    sources: [{ id: reissue, title: 'Glass Meridian - Remastered' }],
    nameCount: 0,
    details: {
      counts: { version: 1 },
      labels: ['Glass Meridian - Remastered'],
    },
    reversible: true,
    canUndo: true,
  })
  const [joined] = await versionsOf([first])
  expect(joined?.group).not.toBeNull()
  expect(await versionsOf([first, reissue])).toEqual([
    { id: first, group: joined?.group, shown: true, scrobbles: 5 },
    { id: reissue, group: joined?.group, shown: false, scrobbles: 5 },
  ])
  // The record is one row with both versions and plays each counted once.
  expect(await groupedRows()).toEqual([{ id: first, versions: 2 }])
  const listed = await listTrackRecordingVersions(
    first,
    TrackQuerySchema.parse({ groupRecordings: true, sortBy: 'title' }),
  )
  expect(listed.items.map(({ id }) => id).sort()).toEqual([first, reissue])
  expect(await readTrackParts(reissue)).toMatchObject({
    shownId: first,
    stored: true,
    scrobbles: 5,
    versions: [
      { id: first, type: 'spotify', shown: true, scrobbles: 3 },
      { id: reissue, type: 'spotify', shown: false, scrobbles: 2 },
    ],
    names: [
      { trackId: first, trackName: 'Glass Meridian', scrobbles: 3 },
      {
        trackId: reissue,
        trackName: 'Glass Meridian - Remastered',
        scrobbles: 2,
      },
    ],
  })

  await undoLibraryChange(merged.id)
  expect(await tracksOf([first, reissue])).toEqual(before)
  expect(await groupedRows()).toHaveLength(2)

  await redoLibraryChange(merged.id)
  expect(await versionsOf([first, reissue])).toEqual([
    { id: first, group: joined?.group, shown: true, scrobbles: 5 },
    { id: reissue, group: joined?.group, shown: false, scrobbles: 5 },
  ])
})

it('moves a merged track’s album position and playlist entry and puts them back', async () => {
  const before = await memberships()
  const merged = await mergeTracks({
    trackIds: [lastfmTrack, first],
    reviewed: true,
  })
  expect(merged).toMatchObject({
    target: { id: first },
    sources: [{ id: lastfmTrack, exists: false }],
    nameCount: 1,
    details: { counts: { position: 1, 'playlist-entry': 1 } },
    canUndo: true,
  })
  const after = await memberships()
  expect(after.media).toEqual([])
  expect(after.positions).toMatchObject([
    { id: 'versions-position', trackMediaItemId: first },
  ])
  expect(after.entries).toEqual([
    {
      playlistId,
      mediaItemId: first,
      position: 3,
      addedAt: new Date('2024-02-01T10:00:00Z'),
    },
  ])
  expect(after.tracks.find((row) => row.mediaItemId === first)).toMatchObject({
    albumMediaItemId: albumId,
    albumLinkStrategy: 'album-track-list',
    scrobbleCount: 7,
  })

  await undoLibraryChange(merged.id)
  expect(await memberships()).toEqual(before)

  await redoLibraryChange(merged.id)
  expect(await memberships()).toEqual(after)
})

it('separates a version, then undoes and makes it again', async () => {
  const joined = await mergeTracks({
    trackIds: [first, reissue],
    reviewed: false,
  })
  const [record] = await versionsOf([first])
  const separated = await separateTrackVersion(reissue)
  expect(separated).toMatchObject({
    action: 'separate',
    target: { id: reissue },
    sources: [{ id: first }],
    details: { counts: { version: 1 } },
    canUndo: true,
  })
  const [alone] = await versionsOf([reissue])
  expect(alone?.group).not.toBeNull()
  expect(alone?.group).not.toBe(record?.group)
  expect(await versionsOf([first, reissue])).toEqual([
    { id: first, group: record?.group, shown: true, scrobbles: 3 },
    { id: reissue, group: alone?.group, shown: false, scrobbles: 2 },
  ])
  expect(await groupedRows()).toHaveLength(2)
  await expect(separateTrackVersion(reissue)).rejects.toMatchObject({
    response: { statusCode: 409 },
  })

  // The join cannot be undone while the separation holds a version.
  await expect(undoLibraryChange(joined.id)).rejects.toMatchObject({
    response: {
      statusCode: 409,
      message: 'A later change moved these versions. Undo that change first.',
    },
  })

  await undoLibraryChange(separated.id)
  expect(await versionsOf([first, reissue])).toEqual([
    { id: first, group: record?.group, shown: true, scrobbles: 5 },
    { id: reissue, group: record?.group, shown: false, scrobbles: 5 },
  ])
  await redoLibraryChange(separated.id)
  expect(await versionsOf([reissue])).toEqual([
    { id: reissue, group: alone?.group, shown: false, scrobbles: 2 },
  ])
  await undoLibraryChange(separated.id)
  await undoLibraryChange(joined.id)
  expect(await versionsOf([first, reissue])).toEqual([
    { id: first, group: null, shown: false, scrobbles: 3 },
    { id: reissue, group: null, shown: false, scrobbles: 2 },
  ])
})

it('shows a record as another version', async () => {
  await mergeTracks({ trackIds: [first, reissue], reviewed: false })
  const shown = await showTrackVersion(reissue)
  expect(shown).toMatchObject({
    action: 'show',
    target: { id: reissue },
    sources: [{ id: first }],
    canUndo: true,
  })
  expect(
    (await versionsOf([first, reissue])).map(({ id, shown }) => ({
      id,
      shown,
    })),
  ).toEqual([
    { id: first, shown: false },
    { id: reissue, shown: true },
  ])
  expect(await groupedRows()).toEqual([{ id: reissue, versions: 2 }])
  expect((await readTrackParts(first)).shownId).toBe(reissue)
  await expect(showTrackVersion(reissue)).rejects.toMatchObject({
    response: { statusCode: 409 },
  })

  await undoLibraryChange(shown.id)
  expect(await groupedRows()).toEqual([{ id: first, versions: 2 }])
  await redoLibraryChange(shown.id)
  expect(await groupedRows()).toEqual([{ id: reissue, versions: 2 }])
})

it('undoes a merge of a scrobbled name that was worked out as a version', async () => {
  // Two Spotify tracks share the title the scrobbled name's own track has.
  const twins = ['versions-twin-a', 'versions-twin-b']
  const [credit] = await fixture
    .select()
    .from(schema.mediaCredit)
    .where(eq(schema.mediaCredit.mediaItemId, looseName.id))
  if (!credit) throw new Error('The scrobbled name has no artist credit.')
  await fixture.insert(schema.mediaItem).values(
    twins.map((id) => ({
      id,
      slug: id,
      title: 'Low Lanterns',
      mediaType: 'track',
      sourceLabel: 'spotify',
    })),
  )
  await fixture.insert(schema.libraryTrack).values(
    twins.map((mediaItemId, index) => ({
      mediaItemId,
      spotifyTrackId: `LowLanterns${index}`.padEnd(22, '0'),
      durationSec: 180 + index,
    })),
  )
  await fixture.insert(schema.mediaCredit).values(
    twins.map((mediaItemId) => ({
      mediaItemId,
      artistId: credit.artistId,
      role: 'artist',
    })),
  )
  await linkScrobblesToTracks(account)
  const trackIds = [...twins, looseName.id]
  const byId = (left: { id: string }, right: { id: string }) =>
    left.id.localeCompare(right.id)
  const before = await tracksOf(trackIds)
  const plan = await planTrackMerge({ trackIds })
  expect(
    plan.tracks.map(({ id, outcome }) => ({ id, outcome })).sort(byId),
  ).toEqual(
    [
      ...twins.map((id) => ({
        id,
        outcome: id === plan.targetId ? 'keep' : 'version',
      })),
      { id: looseName.id, outcome: 'merge' },
    ].sort(byId),
  )

  const merged = await mergeTracks({ trackIds, reviewed: true })
  expect(merged).toMatchObject({ canUndo: true, blocked: null })
  expect(await tracksOf([looseName.id])).toEqual([])

  await undoLibraryChange(merged.id)
  expect(await tracksOf(trackIds)).toEqual(before)
  expect(await redoLibraryChange(merged.id)).toMatchObject({ canUndo: true })
  expect(await tracksOf([looseName.id])).toEqual([])
})

it('asks for a review when tracks were kept separate, and forgets it', async () => {
  const [lowId = '', highId = ''] = [first, reissue].sort()
  await fixture
    .insert(schema.libraryKeepSeparate)
    .values({ kind: 'track', lowId, highId })
  const kept = () =>
    fixture
      .select({
        lowId: schema.libraryKeepSeparate.lowId,
        highId: schema.libraryKeepSeparate.highId,
      })
      .from(schema.libraryKeepSeparate)
  const selection = { trackIds: [first, reissue] }
  expect((await planTrackMerge(selection)).cautions).toEqual([
    { code: 'separate', trackIds: [lowId, highId] },
  ])
  await expect(
    mergeTracks({ ...selection, reviewed: false }),
  ).rejects.toMatchObject({ response: { statusCode: 409 } })

  const merged = await mergeTracks({ ...selection, reviewed: true })
  expect(await kept()).toEqual([])
  await undoLibraryChange(merged.id)
  expect(await kept()).toEqual([{ lowId, highId }])
  await redoLibraryChange(merged.id)
  expect(await kept()).toEqual([])
})

it('asks for a review when two tracks are positions on one album', async () => {
  await fixture.insert(schema.track).values({
    id: 'versions-first-position',
    albumMediaItemId: albumId,
    trackMediaItemId: first,
    title: 'Glass Meridian',
    position: 1,
  })
  expect(
    (await planTrackMerge({ trackIds: [lastfmTrack, first] })).cautions,
  ).toEqual([{ code: 'same-album', albums: ['Harbour Lights'] }])
})

it('lists names scrobbled under an album that are not on its track list', async () => {
  expect(await readAlbumUnlistedNames(albumId)).toEqual({
    names: [
      {
        trackId: looseName.id,
        artistKey: looseName.artistKey,
        trackKey: looseName.trackKey,
        artistName: 'Fixture Artist',
        trackName: 'Low Lanterns',
        scrobbles: 2,
      },
    ],
  })
  await expect(readAlbumUnlistedNames('missing-album')).rejects.toMatchObject({
    response: { statusCode: 404 },
  })
})

it('reads a track without other versions as a record of one', async () => {
  expect(await readTrackParts(first)).toMatchObject({
    shownId: first,
    stored: false,
    scrobbles: 3,
    versions: [{ id: first, shown: true }],
  })
  await expect(separateTrackVersion(first)).rejects.toMatchObject({
    response: { statusCode: 409 },
  })
})
