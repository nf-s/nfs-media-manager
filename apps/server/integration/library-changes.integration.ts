import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { LibraryChangeListQuerySchema } from '@repo/schemas/library-changes'
import { env } from '@/env'
import { albumNameKey } from '@/lib/album-import-candidates'
import { standaloneLastfmTrackId } from '@/lib/track-matching'
import * as schema from '@/schemas/db'

const database = 'library_changes_' + randomUUID().replaceAll('-', '')
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
import { planTrackMerge } from '@/services/track-merge-plan'
import {
  matchScrobbleTrack,
  mergeLastfmTrack,
  mergeTracks,
  removeScrobbleTrackMatch,
} from '@/services/track-merges'

const account = 'fixture-history'
const spotifyTrack = 'spotify-track'
const liveTrack = 'spotify-live-track'
const tagId = 'fixture-tag'

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
// Each name is one Last.fm-only track until it is merged.
const misspelt = scrobbledName('Fixture Artist', 'Nite Drive', 2)
const remaster = scrobbledName('Fixture Artist', 'Night Drive - Remastered', 3)
const demo = scrobbledName('Fixture Artist', 'Night Drive (Demo)', 1)
const stranger = scrobbledName('Other Band', 'Night Drive', 4)
const names = [misspelt, remaster, demo, stranger]

const sourceOf = (name: (typeof names)[number]) =>
  fixture
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

async function trackRow(id: string) {
  const [row] = await fixture
    .select({
      title: schema.mediaItem.title,
      scrobbles: schema.libraryTrack.scrobbleCount,
    })
    .from(schema.libraryTrack)
    .innerJoin(
      schema.mediaItem,
      eq(schema.mediaItem.id, schema.libraryTrack.mediaItemId),
    )
    .where(eq(schema.libraryTrack.mediaItemId, id))
  return row
}

const changes = () => listLibraryChanges(LibraryChangeListQuerySchema.parse({}))

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
  await fixture.delete(schema.playlist)
  await fixture.delete(schema.lastfmScrobble)
  await fixture.delete(schema.track)
  await fixture.delete(schema.mediaItem)
  await fixture.delete(schema.artist)
  await fixture.delete(schema.tag)
  await fixture.insert(schema.mediaItem).values([
    {
      id: spotifyTrack,
      slug: spotifyTrack,
      title: 'Night Drive',
      mediaType: 'track',
      sourceLabel: 'spotify',
    },
    {
      id: liveTrack,
      slug: liveTrack,
      title: 'Night Drive (Live)',
      mediaType: 'track',
      sourceLabel: 'spotify',
    },
  ])
  await fixture.insert(schema.libraryTrack).values([
    {
      mediaItemId: spotifyTrack,
      spotifyTrackId: 'NightDrive'.padEnd(22, '0'),
      durationSec: 200,
    },
    {
      mediaItemId: liveTrack,
      spotifyTrackId: 'NightDriveLive'.padEnd(22, '0'),
      durationSec: 260,
    },
  ])
  await fixture
    .insert(schema.artist)
    .values({ id: 'fixture-artist', name: 'Fixture Artist' })
  await fixture.insert(schema.mediaCredit).values([
    { mediaItemId: spotifyTrack, artistId: 'fixture-artist', role: 'artist' },
    { mediaItemId: liveTrack, artistId: 'fixture-artist', role: 'artist' },
  ])
  await fixture
    .insert(schema.playlist)
    .values({ id: 'fixture-playlist', name: 'Fixture', kind: 'playlist' })
  await fixture.insert(schema.playlistItem).values(
    [spotifyTrack, liveTrack].map((mediaItemId, position) => ({
      playlistId: 'fixture-playlist',
      mediaItemId,
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
  await fixture
    .insert(schema.tag)
    .values({ id: tagId, mediaType: 'track', name: 'night' })
  await fixture
    .insert(schema.mediaItemTag)
    .values({ mediaItemId: misspelt.id, tagId })
})

it('plans a merge into the track with its own identity', async () => {
  const before = await trackRow(spotifyTrack)
  const plan = await planTrackMerge({
    trackIds: [misspelt.id, spotifyTrack],
  })
  expect(plan).toMatchObject({
    targetId: spotifyTrack,
    blocked: false,
    cautions: [],
    names: [
      {
        trackId: misspelt.id,
        artistName: 'Fixture Artist',
        trackName: 'Nite Drive',
        count: 2,
        counted: false,
      },
    ],
    scrobbles: {
      target: before?.scrobbles,
      added: 2,
      total: (before?.scrobbles ?? 0) + 2,
    },
  })
  expect(plan.tracks.map(({ id, blocked }) => ({ id, blocked }))).toEqual([
    { id: spotifyTrack, blocked: null },
    { id: misspelt.id, blocked: null },
  ])
})

it('merges at once, then undoes and makes the change again', async () => {
  const before = await trackRow(spotifyTrack)
  const merged = await mergeTracks({
    trackIds: [misspelt.id, spotifyTrack],
    reviewed: false,
  })
  expect(merged).toMatchObject({
    kind: 'track',
    action: 'merge',
    actor: 'owner',
    target: { id: spotifyTrack, title: 'Night Drive', exists: true },
    sources: [
      {
        id: misspelt.id,
        title: 'Nite Drive',
        by: 'Fixture Artist',
        exists: false,
      },
    ],
    names: [
      { artistName: 'Fixture Artist', trackName: 'Nite Drive', scrobbles: 2 },
    ],
    nameCount: 1,
    scrobbles: 2,
    undoneAt: null,
    reversible: true,
    canUndo: true,
    canRedo: false,
  })
  expect(await trackRow(misspelt.id)).toBeUndefined()
  expect(await sourceOf(misspelt)).toEqual([
    { trackId: spotifyTrack, manual: true },
  ])
  expect((await trackRow(spotifyTrack))?.scrobbles).toBe(
    (before?.scrobbles ?? 0) + 2,
  )

  const undone = await undoLibraryChange(merged.id)
  expect(undone).toMatchObject({
    id: merged.id,
    canUndo: false,
    canRedo: true,
    sources: [{ id: misspelt.id, exists: true }],
  })
  expect(undone.undoneAt).not.toBeNull()
  expect(await trackRow(misspelt.id)).toEqual({
    title: 'Nite Drive',
    scrobbles: 2,
  })
  expect(await sourceOf(misspelt)).toEqual([
    { trackId: misspelt.id, manual: false },
  ])
  expect((await trackRow(spotifyTrack))?.scrobbles).toBe(before?.scrobbles)
  // The removed track returns with its credits and tags.
  expect(
    await fixture
      .select({ tagId: schema.mediaItemTag.tagId })
      .from(schema.mediaItemTag)
      .where(eq(schema.mediaItemTag.mediaItemId, misspelt.id)),
  ).toEqual([{ tagId }])
  expect(
    await fixture
      .select({ artistId: schema.mediaCredit.artistId })
      .from(schema.mediaCredit)
      .where(eq(schema.mediaCredit.mediaItemId, misspelt.id)),
  ).toHaveLength(1)

  const redone = await redoLibraryChange(merged.id)
  expect(redone).toMatchObject({
    undoneAt: null,
    canUndo: true,
    canRedo: false,
  })
  expect(await trackRow(misspelt.id)).toBeUndefined()
  expect(await sourceOf(misspelt)).toEqual([
    { trackId: spotifyTrack, manual: true },
  ])

  await undoLibraryChange(merged.id)
  expect(await trackRow(misspelt.id)).toEqual({
    title: 'Nite Drive',
    scrobbles: 2,
  })
  await expect(undoLibraryChange(merged.id)).rejects.toMatchObject({
    response: { statusCode: 409 },
  })
})

it('lets an interactive merge retry after the library writer releases its lock', async () => {
  const request = { trackIds: [misspelt.id, spotifyTrack], reviewed: false }
  const blocker = await pool.connect()
  try {
    await blocker.query('begin')
    await blocker.query('select pg_advisory_xact_lock(614106)')
    const busy = {
      response: {
        statusCode: 503,
        message: 'The library is busy. Try the merge again.',
        data: { reason: 'library-busy' },
      },
    }
    await Promise.all([
      expect(mergeTracks(request, { interactive: true })).rejects.toMatchObject(
        busy,
      ),
      expect(
        mergeLastfmTrack(
          misspelt.id,
          { targetId: spotifyTrack },
          { interactive: true },
        ),
      ).rejects.toMatchObject(busy),
    ])
    expect((await changes()).totalCount).toBe(0)
    expect(await sourceOf(misspelt)).toEqual([
      { trackId: misspelt.id, manual: false },
    ])
  } finally {
    await blocker.query('rollback')
    blocker.release()
  }
  const merged = await mergeTracks(request, { interactive: true })
  expect(merged.target?.id).toBe(spotifyTrack)
  expect(await sourceOf(misspelt)).toEqual([
    { trackId: spotifyTrack, manual: true },
  ])
})

it('returns a removed track with its provider data, links and edits', async () => {
  const mediaItemId = misspelt.id
  const provider = 'fixture-provider'
  await fixture.insert(schema.providerSnapshot).values({
    id: 'fixture-snapshot',
    mediaItemId,
    provider,
    checksum: 'a',
    payload: { title: 'Nite Drive' },
    source: 'scrape',
  })
  await fixture.insert(schema.providerCurrentState).values({
    id: 'fixture-state',
    mediaItemId,
    provider,
    latestSnapshotId: 'fixture-snapshot',
    checksum: 'a',
    payload: { title: 'Nite Drive' },
    status: 'ok',
  })
  await fixture.insert(schema.providerReference).values({
    id: 'fixture-reference',
    mediaItemId,
    provider,
    referenceType: 'recording',
    externalId: 'recording-1',
    isPrimary: true,
    metadata: { score: 1 },
  })
  await fixture.insert(schema.providerReferenceOverride).values({
    id: 'fixture-reference-override',
    mediaItemId,
    provider,
    referenceType: 'recording',
    externalId: 'recording-1',
  })
  await fixture.insert(schema.externalLink).values({
    id: 'fixture-link',
    mediaItemId,
    provider,
    label: 'Fixture',
    url: 'https://example.com/nite-drive',
  })
  await fixture.insert(schema.mediaOverride).values({
    id: 'fixture-override',
    mediaItemId,
    field: 'title',
    value: 'Nite Drive',
  })
  await fixture.insert(schema.tagOccurrence).values({
    id: 'fixture-occurrence',
    mediaItemId,
    tagId,
    provider,
    rawName: 'Night',
    kind: 'genre',
  })
  const attached = async () => ({
    snapshot: await fixture
      .select({ mediaItemId: schema.providerSnapshot.mediaItemId })
      .from(schema.providerSnapshot),
    state: await fixture
      .select({
        id: schema.providerCurrentState.id,
        latestSnapshotId: schema.providerCurrentState.latestSnapshotId,
        payload: schema.providerCurrentState.payload,
      })
      .from(schema.providerCurrentState),
    reference: await fixture
      .select({
        id: schema.providerReference.id,
        isPrimary: schema.providerReference.isPrimary,
        metadata: schema.providerReference.metadata,
      })
      .from(schema.providerReference),
    referenceOverride: await fixture
      .select({ id: schema.providerReferenceOverride.id })
      .from(schema.providerReferenceOverride),
    link: await fixture
      .select({ id: schema.externalLink.id, url: schema.externalLink.url })
      .from(schema.externalLink),
    override: await fixture
      .select({
        id: schema.mediaOverride.id,
        value: schema.mediaOverride.value,
      })
      .from(schema.mediaOverride),
    occurrence: await fixture
      .select({
        id: schema.tagOccurrence.id,
        tagId: schema.tagOccurrence.tagId,
        createdAt: schema.tagOccurrence.createdAt,
      })
      .from(schema.tagOccurrence),
  })
  const before = await attached()

  const merged = await mergeTracks({
    trackIds: [misspelt.id, spotifyTrack],
    reviewed: false,
  })
  expect(await attached()).toMatchObject({
    snapshot: [{ mediaItemId: null }],
    state: [],
    reference: [],
    referenceOverride: [],
    link: [],
    override: [],
    occurrence: [],
  })

  await undoLibraryChange(merged.id)
  expect(await attached()).toEqual(before)
})

it('does not count scrobbles the kept track already counts', async () => {
  const plan = await planTrackMerge({ trackIds: [remaster.id, spotifyTrack] })
  expect(plan.names).toMatchObject([{ trackId: remaster.id, counted: true }])
  expect(plan.scrobbles.added).toBe(0)
})

it('asks for a review when a version word is in some titles only', async () => {
  const selection = { trackIds: [demo.id, spotifyTrack] }
  expect((await planTrackMerge(selection)).cautions).toEqual([
    { code: 'version', words: ['Demo'] },
  ])
  await expect(
    mergeTracks({ ...selection, reviewed: false }),
  ).rejects.toMatchObject({ response: { statusCode: 409 } })
  expect(await trackRow(demo.id)).toBeDefined()

  const merged = await mergeTracks({ ...selection, reviewed: true })
  expect(merged.sources).toMatchObject([{ id: demo.id, exists: false }])
})

it('asks for a review when the artists differ', async () => {
  const plan = await planTrackMerge({ trackIds: [stranger.id, spotifyTrack] })
  expect(plan.cautions).toEqual([
    { code: 'artists', names: ['Fixture Artist', 'Other Band'] },
  ])
})

it('keeps a track with its own Spotify identity as a version', async () => {
  const selection = { trackIds: [spotifyTrack, liveTrack] }
  const plan = await planTrackMerge(selection)
  expect(plan.blocked).toBe(false)
  expect(
    plan.tracks.map(({ id, outcome, blocked }) => ({ id, outcome, blocked })),
  ).toEqual([
    { id: spotifyTrack, outcome: 'keep', blocked: null },
    { id: liveTrack, outcome: 'version', blocked: null },
  ])
  await expect(
    mergeTracks({ ...selection, reviewed: false }),
  ).rejects.toMatchObject({ response: { statusCode: 409 } })
  expect((await changes()).totalCount).toBe(0)
  const merged = await mergeTracks({ ...selection, reviewed: true })
  expect(merged).toMatchObject({
    action: 'merge',
    target: { id: spotifyTrack, exists: true },
    sources: [{ id: liveTrack, exists: true }],
    nameCount: 0,
    canUndo: true,
  })
  expect(await trackRow(liveTrack)).toBeDefined()
})

it('keeps the chosen track when every track is made of scrobbles', async () => {
  const plan = await planTrackMerge({ trackIds: [misspelt.id, remaster.id] })
  expect(plan.targetId).toBe(remaster.id)
  const chosen = await mergeTracks({
    trackIds: [misspelt.id, remaster.id],
    targetId: misspelt.id,
    reviewed: true,
  })
  expect(chosen.target?.id).toBe(misspelt.id)
  expect(await trackRow(remaster.id)).toBeUndefined()
})

it('undoes a later change before an earlier one', async () => {
  const first = await mergeTracks({
    trackIds: [misspelt.id, remaster.id],
    reviewed: true,
  })
  expect(first.target?.id).toBe(remaster.id)
  const second = await mergeTracks({
    trackIds: [remaster.id, spotifyTrack],
    reviewed: true,
  })
  expect(second).toMatchObject({ nameCount: 2, target: { id: spotifyTrack } })
  expect(await trackRow(remaster.id)).toBeUndefined()

  await expect(undoLibraryChange(first.id)).rejects.toMatchObject({
    response: {
      statusCode: 409,
      message: 'A later change moved these names. Undo that change first.',
    },
  })
  expect(
    (await changes()).items.map(({ id, canUndo }) => ({ id, canUndo })),
  ).toEqual([
    { id: second.id, canUndo: true },
    { id: first.id, canUndo: false },
  ])

  await undoLibraryChange(second.id)
  expect(await sourceOf(misspelt)).toEqual([
    { trackId: remaster.id, manual: true },
  ])
  expect(await sourceOf(remaster)).toEqual([
    { trackId: remaster.id, manual: false },
  ])
  expect((await trackRow(remaster.id))?.scrobbles).toBe(5)

  expect(
    (await changes()).items.find(({ id }) => id === first.id),
  ).toMatchObject({ canUndo: true })
  await undoLibraryChange(first.id)
  expect(await trackRow(misspelt.id)).toEqual({
    title: 'Nite Drive',
    scrobbles: 2,
  })
  expect((await trackRow(remaster.id))?.scrobbles).toBe(3)
})

it('records and undoes a name matched from the track page', async () => {
  const matched = await matchScrobbleTrack(misspelt.id, {
    artistKey: misspelt.artistKey,
    trackKey: misspelt.trackKey,
    targetId: spotifyTrack,
  })
  expect(matched).toMatchObject({ targetId: spotifyTrack, sourceRemoved: true })
  const [moved] = (await changes()).items
  expect(moved).toMatchObject({
    id: matched.changeId,
    action: 'move',
    target: { id: spotifyTrack },
    sources: [{ id: misspelt.id, exists: false }],
    canUndo: true,
  })

  const separated = await removeScrobbleTrackMatch(spotifyTrack, {
    artistKey: misspelt.artistKey,
    trackKey: misspelt.trackKey,
    mode: 'separate',
  })
  const [separation] = (await changes()).items
  expect(separation).toMatchObject({
    id: separated.changeId,
    action: 'separate',
    target: { id: misspelt.id, exists: true },
    sources: [{ id: spotifyTrack }],
    canUndo: true,
  })
  expect(await sourceOf(misspelt)).toEqual([
    { trackId: misspelt.id, manual: true },
  ])

  await undoLibraryChange(separation?.id ?? '')
  expect(await sourceOf(misspelt)).toEqual([
    { trackId: spotifyTrack, manual: true },
  ])
  expect(await trackRow(misspelt.id)).toBeUndefined()

  await undoLibraryChange(moved?.id ?? '')
  expect(await sourceOf(misspelt)).toEqual([
    { trackId: misspelt.id, manual: false },
  ])
  expect(await trackRow(misspelt.id)).toEqual({
    title: 'Nite Drive',
    scrobbles: 2,
  })
})

it('records a name returned to automatic matching', async () => {
  await mergeTracks({ trackIds: [misspelt.id, spotifyTrack], reviewed: false })
  const rematched = await removeScrobbleTrackMatch(spotifyTrack, {
    artistKey: misspelt.artistKey,
    trackKey: misspelt.trackKey,
    mode: 'automatic',
  })
  const [change] = (await changes()).items
  expect(change).toMatchObject({
    id: rematched.changeId,
    action: 'rematch',
    target: { id: misspelt.id },
    sources: [{ id: spotifyTrack }],
  })
  expect(await sourceOf(misspelt)).toEqual([
    { trackId: misspelt.id, manual: false },
  ])
})

it('undoes a merge that moved playlist entries', async () => {
  await fixture.insert(schema.playlistItem).values({
    playlistId: 'fixture-playlist',
    mediaItemId: misspelt.id,
    position: 5,
    addedAt: new Date('2024-03-01'),
  })
  const entries = () =>
    fixture
      .select()
      .from(schema.playlistItem)
      .orderBy(schema.playlistItem.position)
  const before = await entries()
  const merged = await mergeLastfmTrack(misspelt.id, { targetId: spotifyTrack })
  const [change] = (await changes()).items
  expect(change).toMatchObject({
    id: merged.changeId,
    action: 'merge',
    reversible: true,
    canUndo: true,
    details: { counts: { 'playlist-entry': 1 } },
  })
  expect(await trackRow(misspelt.id)).toBeUndefined()
  await undoLibraryChange(change?.id ?? '')
  expect(await entries()).toEqual(before)
  expect(await trackRow(misspelt.id)).toEqual({
    title: 'Nite Drive',
    scrobbles: 2,
  })
})

it('lists the changes that moved a name into or out of a track', async () => {
  const merged = await mergeTracks({
    trackIds: [misspelt.id, spotifyTrack],
    reviewed: false,
  })
  await mergeTracks({ trackIds: [demo.id, liveTrack], reviewed: true })
  const query = (recordId: string) =>
    listLibraryChanges(LibraryChangeListQuerySchema.parse({ recordId }))
  expect((await query(spotifyTrack)).items.map(({ id }) => id)).toEqual([
    merged.id,
  ])
  expect((await query(misspelt.id)).items.map(({ id }) => id)).toEqual([
    merged.id,
  ])
  expect((await changes()).totalCount).toBe(2)
})
