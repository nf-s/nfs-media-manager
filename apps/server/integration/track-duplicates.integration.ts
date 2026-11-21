import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { LibraryChangeListQuerySchema } from '@repo/schemas/library-changes'
import { TrackQuerySchema } from '@repo/schemas/tracks'
import { env } from '@/env'
import { albumNameKey } from '@/lib/album-import-candidates'
import { standaloneLastfmTrackId } from '@/lib/track-matching'
import * as schema from '@/schemas/db'

const database = 'track_duplicates_' + randomUUID().replaceAll('-', '')
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

import { importLastfmLibraryTracks } from '@/services/lastfm-library-tracks'
import {
  listLibraryChanges,
  redoLibraryChange,
  undoLibraryChange,
} from '@/services/library-changes'
import { linkScrobblesToTracks } from '@/services/track-links'
import { mergeTracks } from '@/services/track-merges'
import {
  countTrackDuplicateGroups,
  keepTracksSeparate,
  listTrackDuplicates,
  readTrackDuplicateLayout,
  refreshTrackDuplicatesForMaintenance,
} from '@/services/track-duplicates'
import { listTrackBrowsePage } from '@/services/tracks'

const account = 'fixture-duplicates'
const artistId = 'fixture-artist'

function scrobbledName(artistName: string, trackName: string, count: number) {
  const key = {
    artistKey: albumNameKey(artistName),
    trackKey: albumNameKey(trackName),
  }
  return {
    ...key,
    artistName,
    trackName,
    count,
    id: standaloneLastfmTrackId(account, key),
  }
}
// Each name is one Last.fm-only track.
const remaster = scrobbledName(
  'Fixture Artist',
  'Night Drive - Remastered 2011',
  3,
)
const withFriend = scrobbledName('Fixture Artist & Friend', 'Harbour Lights', 2)
const stranger = scrobbledName('Other Band', 'Night Drive', 4)
const names = [remaster, withFriend, stranger]

type SpotifyTrack = {
  id: string
  title: string
  durationSec?: number
  versionGroupId?: string
  versionShown?: boolean
  scrobbles?: number
}
const nightDrive: SpotifyTrack = { id: 'night-drive', title: 'Night Drive' }
const harbour: SpotifyTrack = { id: 'harbour', title: 'Harbour Lights' }
const liveDash: SpotifyTrack = {
  id: 'live-dash',
  title: 'Low Lanterns - Live',
  durationSec: 300,
  scrobbles: 1,
}
const livePlain: SpotifyTrack = {
  id: 'live-plain',
  title: 'Low Lanterns Live',
  durationSec: 200,
}
const versions: SpotifyTrack[] = [
  {
    id: 'meridian-a',
    title: 'Glass Meridian',
    versionGroupId: 'meridian',
    versionShown: true,
  },
  { id: 'meridian-b', title: 'Glass Meridian', versionGroupId: 'meridian' },
]
const interludes: SpotifyTrack[] = Array.from({ length: 14 }, (_, index) => ({
  id: `interlude-${String(index).padStart(2, '0')}`,
  title: 'Interlude',
}))
const spotifyTracks = [
  nightDrive,
  harbour,
  liveDash,
  livePlain,
  ...versions,
  ...interludes,
]

const changes = () => listLibraryChanges(LibraryChangeListQuerySchema.parse({}))
const browse = (query: Record<string, unknown> = {}) =>
  TrackQuerySchema.parse({ duplicates: 'true', size: 100, ...query })

/** Lets the maintenance tick claim a rebuild at once. */
const allowRebuild = () =>
  fixture.execute(sql`update track_duplicate_state
    set retry_after = statement_timestamp() - interval '1 second'`)

async function rebuild() {
  await allowRebuild()
  return refreshTrackDuplicatesForMaintenance()
}

async function groupOf(trackId: string) {
  const [group] = (await listTrackDuplicates(trackId)).items
  return group
}

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
  await fixture.delete(schema.libraryKeepSeparate)
  await fixture.delete(schema.libraryChange)
  await fixture.delete(schema.trackDuplicateGroup)
  await fixture.delete(schema.trackDuplicateState)
  await fixture.delete(schema.playlist)
  await fixture.delete(schema.lastfmScrobble)
  await fixture.delete(schema.track)
  await fixture.delete(schema.mediaItem)
  await fixture.delete(schema.artist)
  await fixture.insert(schema.mediaItem).values(
    spotifyTracks.map(({ id, title }) => ({
      id,
      slug: id,
      title,
      mediaType: 'track',
      sourceLabel: 'spotify',
    })),
  )
  await fixture.insert(schema.libraryTrack).values(
    spotifyTracks.map((track) => ({
      mediaItemId: track.id,
      spotifyTrackId: track.id.padEnd(22, '0'),
      durationSec: track.durationSec ?? 200,
      scrobbleCount: track.scrobbles ?? 0,
      versionGroupId: track.versionGroupId ?? null,
      versionShown: track.versionShown ?? false,
    })),
  )
  await fixture
    .insert(schema.artist)
    .values({ id: artistId, name: 'Fixture Artist' })
  await fixture.insert(schema.mediaCredit).values(
    spotifyTracks.map(({ id }) => ({
      mediaItemId: id,
      artistId,
      role: 'artist',
    })),
  )
  // A playlist entry keeps a Spotify track in the library.
  await fixture
    .insert(schema.playlist)
    .values({ id: 'fixture-playlist', name: 'Fixture', kind: 'playlist' })
  await fixture.insert(schema.playlistItem).values(
    spotifyTracks.map(({ id }, position) => ({
      playlistId: 'fixture-playlist',
      mediaItemId: id,
      position,
      addedAt: new Date('2024-01-01'),
    })),
  )
  await fixture.insert(schema.lastfmScrobble).values(
    names.flatMap((name) =>
      Array.from({ length: name.count }, (_, index) => ({
        id: `${name.id}-${index}`,
        username: account,
        artistName: name.artistName,
        artistKey: name.artistKey,
        trackName: name.trackName,
        trackKey: name.trackKey,
        listenedAt: new Date(Date.UTC(2023, 0, 1 + index)),
      })),
    ),
  )
  await importLastfmLibraryTracks(account)
  await linkScrobblesToTracks(account)
  expect(await refreshTrackDuplicatesForMaintenance()).toBe(true)
})

it('groups the same title and artist, and a name linked to another track', async () => {
  const keyed = await groupOf(nightDrive.id)
  expect(keyed).toMatchObject({
    rule: 'link',
    memberCount: 2,
    scrobbles: 3,
    cautions: [],
  })
  expect(keyed?.memberIds.sort()).toEqual([nightDrive.id, remaster.id].sort())
  expect(keyed?.evidence).toContain('Same title without “Remastered 2011”')
  expect(keyed?.others).toEqual([
    expect.objectContaining({ id: expect.any(String) }),
  ])

  // Only the scrobble matcher's link joins these: the artists differ.
  expect(await groupOf(harbour.id)).toMatchObject({
    rule: 'link',
    evidence: ['Scrobbles of “Harbour Lights” count towards both'],
    memberIds: expect.arrayContaining([harbour.id, withFriend.id]),
  })

  // The same title once punctuation is ignored, but a version word in one
  // title only.
  const live = await groupOf(liveDash.id)
  expect(live).toMatchObject({
    rule: 'key',
    evidence: ['Same title and artist'],
    cautions: expect.arrayContaining([
      { code: 'version', words: ['Live'] },
      { code: 'duration', seconds: 100 },
    ]),
  })
  expect(live?.memberIds.sort()).toEqual([liveDash.id, livePlain.id].sort())
})

it('leaves other artists, versions of one record and large clusters apart', async () => {
  expect(await groupOf(stranger.id)).toBeUndefined()
  expect(await groupOf('meridian-a')).toBeUndefined()
  const sizes = await Promise.all(
    interludes.map(async ({ id }) => (await groupOf(id))?.memberCount),
  )
  expect(sizes.filter((size) => size === 12)).toHaveLength(12)
  expect(sizes.filter((size) => size === 2)).toHaveLength(2)

  // Joining two members as versions of one record ends their group at once.
  await fixture
    .update(schema.libraryTrack)
    .set({ versionGroupId: 'harbour' })
    .where(
      inArray(schema.libraryTrack.mediaItemId, [harbour.id, withFriend.id]),
    )
  expect(await groupOf(harbour.id)).toBeUndefined()
  expect(await rebuild()).toBe(true)
  expect(await groupOf(harbour.id)).toBeUndefined()
})

it('lists only grouped tracks in group order, with a matching layout', async () => {
  const page = await listTrackBrowsePage(browse())
  const layout = await readTrackDuplicateLayout(browse())
  const ids = page.items.map((item) => item.id)
  expect(layout.totalRows).toBe(ids.length)
  expect(ids).toHaveLength(2 + 2 + 2 + 12 + 2)
  expect(ids).not.toContain(stranger.id)
  expect(layout.groups.map((group) => group.offset)).toEqual(
    layout.groups.reduce<number[]>(
      (offsets, group, index) => [
        ...offsets,
        index
          ? (offsets.at(-1) ?? 0) + (layout.groups[index - 1]?.rowCount ?? 0)
          : 0,
      ],
      [],
    ),
  )
  for (const group of layout.groups)
    expect(
      ids.slice(group.offset, group.offset + group.rowCount).sort(),
    ).toEqual([...group.memberIds].sort())
  // Most played group first.
  expect(layout.groups[0]?.memberIds).toContain(remaster.id)

  // Search and filters still apply, within the group order.
  const searched = await listTrackBrowsePage(browse({ q: 'harbour' }))
  expect(searched.items.map((item) => item.id).sort()).toEqual(
    [harbour.id, withFriend.id].sort(),
  )
  const searchedLayout = await readTrackDuplicateLayout(
    browse({ q: 'harbour' }),
  )
  expect(searchedLayout).toMatchObject({
    totalRows: 2,
    groups: [{ offset: 0, rowCount: 2, memberCount: 2 }],
  })
})

it('counts groups from stored state', async () => {
  const count = await countTrackDuplicateGroups({})
  expect(count).toEqual({ count: 5, ready: true })
  // The count is the stored number, not worked out on read.
  await fixture
    .update(schema.trackDuplicateState)
    .set({ groupCount: 99 })
    .where(eq(schema.trackDuplicateState.singleton, true))
  expect(await countTrackDuplicateGroups({})).toEqual({
    count: 99,
    ready: true,
  })
  expect(await countTrackDuplicateGroups({ creatorId: artistId })).toEqual({
    count: 5,
    ready: true,
  })
  await fixture.delete(schema.trackDuplicateState)
  expect(await countTrackDuplicateGroups({})).toEqual({
    count: 0,
    ready: false,
  })
})

it('keeps a group separate, and undoes and makes that again', async () => {
  const group = await groupOf(nightDrive.id)
  const trackIds = [nightDrive.id, remaster.id]
  const kept = await keepTracksSeparate({ trackIds })
  expect(kept).toMatchObject({
    kind: 'track',
    action: 'keep-separate',
    actor: 'owner',
    target: null,
    sources: [
      { id: nightDrive.id, title: 'Night Drive', exists: true },
      { id: remaster.id, exists: true },
    ],
    names: [],
    nameCount: 0,
    canUndo: true,
    canRedo: false,
  })
  expect(await groupOf(nightDrive.id)).toBeUndefined()
  expect(await countTrackDuplicateGroups({})).toEqual({ count: 4, ready: true })
  expect((await changes()).items.map((change) => change.id)).toEqual([kept.id])
  expect(
    (
      await listLibraryChanges(
        LibraryChangeListQuerySchema.parse({ recordId: remaster.id }),
      )
    ).items.map((change) => change.action),
  ).toEqual(['keep-separate'])
  await expect(keepTracksSeparate({ trackIds })).rejects.toMatchObject({
    response: { statusCode: 409 },
  })
  // The maintenance rebuild respects the decision too.
  expect(await rebuild()).toBe(true)
  expect(await groupOf(nightDrive.id)).toBeUndefined()

  const undone = await undoLibraryChange(kept.id)
  expect(undone).toMatchObject({ canUndo: false, canRedo: true })
  expect(await groupOf(nightDrive.id)).toEqual(group)
  expect(await countTrackDuplicateGroups({})).toEqual({ count: 5, ready: true })

  const redone = await redoLibraryChange(kept.id)
  expect(redone).toMatchObject({ canUndo: true, canRedo: false })
  expect(await groupOf(nightDrive.id)).toBeUndefined()
  expect(await countTrackDuplicateGroups({})).toEqual({ count: 4, ready: true })
})

it('removes a group when it is merged', async () => {
  const merged = await mergeTracks({
    trackIds: [nightDrive.id, remaster.id],
    reviewed: true,
  })
  expect(await groupOf(nightDrive.id)).toBeUndefined()
  expect(await countTrackDuplicateGroups({})).toEqual({ count: 4, ready: true })
  expect(await rebuild()).toBe(true)
  expect(await groupOf(nightDrive.id)).toBeUndefined()

  // Undo returns the track; the next rebuild suggests the pair again.
  await undoLibraryChange(merged.id)
  expect(await rebuild()).toBe(true)
  expect((await groupOf(nightDrive.id))?.memberCount).toBe(2)
})

it('rebuilds on the maintenance tick only after a change', async () => {
  expect(await rebuild()).toBe(false)
  // A write the groups do not read asks for nothing.
  await fixture
    .update(schema.libraryTrack)
    .set({ scrobbleCount: 50 })
    .where(eq(schema.libraryTrack.mediaItemId, livePlain.id))
  expect(await rebuild()).toBe(false)
  await fixture
    .update(schema.mediaItem)
    .set({ title: 'Harbour Lights (feat. Guest)' })
    .where(eq(schema.mediaItem.id, harbour.id))
  expect(await rebuild()).toBe(true)
  expect(await rebuild()).toBe(false)
  expect((await groupOf(harbour.id))?.memberIds.sort()).toEqual(
    [harbour.id, withFriend.id].sort(),
  )
})
