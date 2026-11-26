import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import {
  LibraryChangeListQuerySchema,
  type TrackMergeCaution,
} from '@repo/schemas/library-changes'
import { TrackMatchDiagnosticsQuerySchema } from '@repo/schemas/match-diagnostics'
import { DuplicateReviewQuerySchema } from '@repo/schemas/track-duplicates'
import { env } from '@/env'
import { albumNameKey } from '@/lib/album-import-candidates'
import { standaloneLastfmTrackId } from '@/lib/track-matching'
import * as schema from '@/schemas/db'
import { removeOrphanTracks } from '@/services/album-library-tracks'

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
import { TRACK_DUPLICATE_PLAN_LIMIT } from '@/services/track-duplicate-refresh'
import { linkScrobblesToTracks } from '@/services/track-links'
import { readTrackMergePlan } from '@/services/track-merge-plan'
import { mergeTracks } from '@/services/track-merges'
import {
  countTrackDuplicateGroups,
  keepTracksSeparate,
  listTrackDuplicates,
  readDuplicateReview,
  readTrackDuplicateLayout,
  refreshTrackDuplicatesForMaintenance,
} from '@/services/track-duplicates'
import { listTrackMatchDiagnostics } from '@/services/track-match-diagnostics'

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
const matches = (query: Record<string, unknown> = {}) =>
  TrackMatchDiagnosticsQuerySchema.parse({
    duplicates: 'true',
    size: 100,
    ...query,
  })

/** The rows a Matches page lists with the layout of the same query. */
async function listed(query: Record<string, unknown> = {}) {
  const page = await listTrackMatchDiagnostics(matches(query))
  const layout = await readTrackDuplicateLayout(matches(query))
  const ids = page.items.map((item) => item.id)
  expect(layout.totalRows).toBe(page.totalCount)
  expect(layout.totalRows).toBe(ids.length)
  // The groups follow one another without gaps, each over its own rows.
  let offset = 0
  for (const group of layout.groups) {
    expect(group.offset).toBe(offset)
    const rows = ids.slice(group.offset, group.offset + group.rowCount)
    expect(rows.every((id) => group.memberIds.includes(id))).toBe(true)
    offset += group.rowCount
  }
  expect(offset).toBe(ids.length)
  return { ids, layout }
}

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
  await fixture.delete(schema.duplicateReviewRun)
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

it('lists only grouped tracks in Matches, in group order, with a matching layout', async () => {
  const { ids, layout } = await listed()
  expect(ids).toHaveLength(2 + 2 + 2 + 12 + 2)
  expect(ids).not.toContain(stranger.id)
  expect(ids).not.toContain('meridian-a')
  for (const group of layout.groups)
    expect(
      ids.slice(group.offset, group.offset + group.rowCount).sort(),
    ).toEqual([...group.memberIds].sort())
  // Groups in rank order, the most played first.
  const ranked = await fixture
    .select({ id: schema.trackDuplicateGroup.id })
    .from(schema.trackDuplicateGroup)
    .orderBy(schema.trackDuplicateGroup.rank)
  expect(layout.groups.map((group) => group.id)).toEqual(
    ranked.map((group) => group.id),
  )
  expect(layout.groups[0]?.memberIds).toContain(remaster.id)

  // Without `duplicates`, Matches lists every track.
  const all = await listTrackMatchDiagnostics(
    TrackMatchDiagnosticsQuerySchema.parse({ size: 100 }),
  )
  expect(all.items.map((item) => item.id)).toContain(stranger.id)

  // Search and filters still apply, within the group order.
  const searched = await listed({ q: 'harbour' })
  expect([...searched.ids].sort()).toEqual([harbour.id, withFriend.id].sort())
  expect(searched.layout).toMatchObject({
    totalRows: 2,
    groups: [{ offset: 0, rowCount: 2, memberCount: 2 }],
  })

  // A filter that hides one member leaves its group with the other row.
  const filtered = await listed({
    filters: [{ field: 'title', value: livePlain.title, mode: 'exclude' }],
  })
  expect(filtered.ids).toHaveLength(ids.length - 1)
  expect(filtered.ids).not.toContain(livePlain.id)
  const live = filtered.layout.groups.find((group) =>
    group.memberIds.includes(liveDash.id),
  )
  expect(live).toMatchObject({ rowCount: 1, memberCount: 2 })
  expect(live && filtered.ids[live.offset]).toBe(liveDash.id)
  expect(filtered.layout.groups).toHaveLength(layout.groups.length)

  // A limit on the results applies to the layout as it does to the page.
  const limited = await listed({ limitResults: 3 })
  expect(limited.ids).toEqual(ids.slice(0, 3))
  expect(limited.layout.totalRows).toBe(3)
})

it('pages the latest review, retains historical evidence and reflects the journal', async () => {
  const query = DuplicateReviewQuerySchema.parse
  expect(await readDuplicateReview(query({}))).toEqual({
    review: null,
    items: [],
    page: 1,
    size: 25,
    totalCount: 0,
    pageCount: 0,
  })
  const merged = await mergeTracks({
    targetId: nightDrive.id,
    trackIds: [nightDrive.id, remaster.id],
    reviewed: true,
  })
  await fixture.insert(schema.libraryChange).values([
    {
      id: 'previous-fixture-merge',
      kind: 'track',
      action: 'merge',
      actor: 'owner',
    },
    {
      id: 'fixture-separation',
      kind: 'track',
      action: 'separate',
      actor: 'owner',
    },
  ])
  const reviewedAt = '2025-01-02T03:04:05.000Z'
  await fixture.insert(schema.duplicateReviewRun).values([
    { id: 'earlier-review', reviewedAt: new Date('2024-01-01') },
    { id: 'latest-review', reviewedAt: new Date(reviewedAt) },
  ])
  const pair = {
    runId: 'latest-review',
    leftTitle: 'First saved title',
    rightTitle: 'Second saved title',
    confidence: 'high',
    decision: 'applied',
    evidence: ['Shared recording identifier'],
    details: {
      leftDurationSec: 200,
      rightDurationSec: 201,
      leftCredits: 'Fixture Chorus',
      rightCredits: 'Right Ensemble',
      priorChanges: [
        'previous-fixture-merge',
        'missing-fixture-merge',
        merged.id,
        'fixture-separation',
        'previous-fixture-merge',
        null,
      ],
    },
  } satisfies Omit<
    typeof schema.duplicateReviewPair.$inferInsert,
    'kind' | 'leftId' | 'rightId'
  >
  await fixture.insert(schema.duplicateReviewPair).values([
    {
      ...pair,
      kind: 'track',
      leftId: 'removed-fixture-one',
      rightId: 'removed-fixture-two',
      targetId: nightDrive.id,
      changeId: merged.id,
    },
    {
      ...pair,
      kind: 'track',
      leftId: nightDrive.id,
      rightId: remaster.id,
      rightTitle: 'Mix 100%_ live',
      targetId: nightDrive.id,
      changeId: merged.id,
    },
    {
      ...pair,
      kind: 'album',
      leftId: 'album-one',
      rightId: 'album-two',
      rightTitle: 'Mix 100xy live',
      confidence: 'medium',
      decision: 'held',
      reason: 'Different track lists',
    },
    {
      ...pair,
      kind: 'artist',
      leftId: 'artist-one',
      rightId: 'artist-two',
      rightTitle: 'Other historical name',
      confidence: 'low',
      decision: 'grouped',
      targetId: 'artist-one',
    },
    {
      ...pair,
      runId: 'earlier-review',
      kind: 'track',
      leftId: 'old-a',
      rightId: 'old-b',
    },
  ])

  const review = {
    id: 'latest-review',
    reviewedAt,
    pairCount: 4,
    mergeCount: 2,
  }
  const first = await readDuplicateReview(query({ size: 2 }))
  expect(first).toMatchObject({ review, totalCount: 4, pageCount: 2 })
  expect(first.items.map((item) => item.kind)).toEqual(['album', 'artist'])
  expect(first.items[0]?.reason).toBe('Different track lists')
  expect(first.items[1]?.targetTitle).toBe('First saved title')

  for (const q of ['fIXtUrE cHoRuS', 'RIGHT Ensemble']) {
    const filtered = await readDuplicateReview(
      query({ q, decision: 'applied' }),
    )
    expect(filtered).toMatchObject({ review, totalCount: 2, pageCount: 1 })
    expect(filtered.items.map((item) => item.leftId)).toEqual([
      nightDrive.id,
      'removed-fixture-one',
    ])
  }
  const literal = await readDuplicateReview(query({ q: '100%_' }))
  expect(literal).toMatchObject({ review, totalCount: 1, pageCount: 1 })
  expect(literal.items[0]?.rightTitle).toBe('Mix 100%_ live')
  for (const q of ['first saved title', 'historical name']) {
    const artist = await readDuplicateReview(query({ kind: 'artist', q }))
    expect(artist).toMatchObject({ review, totalCount: 1, pageCount: 1 })
    expect(artist.items[0]?.rightId).toBe('artist-two')
  }

  const applied = query({
    kind: 'track',
    decision: 'applied',
    confidence: 'high',
    page: 2,
    size: 1,
  })
  const second = await readDuplicateReview(applied)
  expect(second).toMatchObject({ review, totalCount: 2, pageCount: 2 })
  expect(second.items).toMatchObject([
    {
      leftId: 'removed-fixture-one',
      leftTitle: pair.leftTitle,
      evidence: pair.evidence,
      details: { ...pair.details, priorChanges: ['previous-fixture-merge'] },
      targetId: nightDrive.id,
      targetTitle: nightDrive.title,
      changeId: merged.id,
      undone: false,
    },
  ])
  expect(
    await readDuplicateReview(query({ ...applied, confidence: 'excluded' })),
  ).toMatchObject({
    review,
    items: [],
    totalCount: 0,
    pageCount: 0,
  })
  expect(
    await readDuplicateReview(query({ ...applied, page: 3 })),
  ).toMatchObject({
    review,
    items: [],
    totalCount: 2,
    pageCount: 2,
  })

  await undoLibraryChange(merged.id)
  expect((await readDuplicateReview(applied)).items[0]?.undone).toBe(true)
  await redoLibraryChange(merged.id)
  expect((await readDuplicateReview(applied)).items[0]?.undone).toBe(false)
  await fixture
    .delete(schema.libraryChange)
    .where(eq(schema.libraryChange.id, merged.id))
  expect(await readDuplicateReview(applied)).toMatchObject({
    review: { ...review, mergeCount: 1 },
    items: [
      {
        decision: 'applied',
        changeId: null,
        targetId: nightDrive.id,
        details: { priorChanges: ['previous-fixture-merge'] },
      },
    ],
  })
  await fixture
    .delete(schema.libraryChange)
    .where(eq(schema.libraryChange.id, 'previous-fixture-merge'))
  expect(await readDuplicateReview(applied)).toMatchObject({
    review: { ...review, mergeCount: 0 },
    items: [{ details: { priorChanges: [] } }],
  })
})

it('summarizes exact live pairs in layout and returns their evidence on demand', async () => {
  const anchor = interludes[0]?.id
  if (!anchor) throw new Error('Missing duplicate fixture')
  const group = await groupOf(anchor)
  const [leftId, rightId, thirdId] = group?.memberIds ?? []
  if (!leftId || !rightId || !thirdId)
    throw new Error('Missing members in duplicate fixture')

  const count = await countTrackDuplicateGroups({})
  const initial = await readTrackDuplicateLayout(matches())
  const runId = 'fixture-group-review'
  await fixture.insert(schema.duplicateReviewRun).values({
    id: runId,
    reviewedAt: new Date('2025-01-02'),
  })
  const pair = {
    runId,
    kind: 'track',
    leftId,
    rightId,
    leftTitle: 'First title at review',
    rightTitle: 'Second title at review',
    confidence: 'medium',
    decision: 'held',
    evidence: ['Different listed credits'],
  } satisfies typeof schema.duplicateReviewPair.$inferInsert
  await fixture
    .insert(schema.duplicateReviewPair)
    .values([
      pair,
      { ...pair, rightId: thirdId, confidence: 'excluded' },
      { ...pair, rightId: liveDash.id },
      { ...pair, rightId: 'historical-track' },
      { ...pair, kind: 'album' },
    ])

  const layout = await readTrackDuplicateLayout(matches())
  expect(layout.totalRows).toBe(initial.totalRows)
  expect(layout.groups).toHaveLength(initial.groups.length)
  expect(await countTrackDuplicateGroups({})).toEqual(count)
  const summary = layout.groups.find(({ id }) => id === group?.id)
  expect(summary?.reviewSummary).toEqual({
    pairCount: 2,
    confidence: null,
    decision: 'held',
  })
  expect(summary?.reviewPairs).toBeUndefined()
  const reopened = await groupOf(anchor)
  expect(reopened?.reviewPairs?.map((item) => item.rightId).sort()).toEqual(
    [rightId, thirdId].sort(),
  )
  expect(reopened?.reviewPairs).toContainEqual(
    expect.objectContaining({ leftId, rightId, evidence: pair.evidence }),
  )
  expect((await groupOf(liveDash.id))?.reviewPairs).toBeUndefined()
})

it('says what Merge does to each group, as the merge plan does', async () => {
  const { layout } = await listed()
  const linked = layout.groups.find((group) =>
    group.memberIds.includes(remaster.id),
  )
  // A Spotify track and a Last.fm-only track with scrobbled names.
  expect(linked?.merge).toEqual({
    keep: { id: nightDrive.id, title: 'Night Drive', by: 'Fixture Artist' },
    versions: 0,
    removed: 1,
    removedRecords: 1,
  })
  // Two Spotify tracks.
  expect(
    layout.groups.find((group) => group.memberIds.includes(liveDash.id))?.merge,
  ).toMatchObject({ versions: 1, removed: 0, removedRecords: 0 })
  expect((await groupOf(nightDrive.id))?.merge).toEqual(linked?.merge)

  for (const group of layout.groups) {
    const plan = await readTrackMergePlan(fixture, {
      trackIds: group.memberIds,
      targetId: group.memberIds[0],
    })
    const [kept] = plan.tracks
    expect(group.merge).toEqual({
      keep: { id: plan.targetId, title: kept?.title, by: kept?.by },
      versions: plan.tracks.filter((track) => track.outcome === 'version')
        .length,
      removed: plan.tracks.filter((track) => track.outcome === 'merge').length,
      removedRecords: plan.tracks.filter(
        (track) => track.outcome === 'merge' && track.identity === null,
      ).length,
    })
  }

  // A member that can no longer be read leaves the group without a summary.
  await fixture
    .update(schema.mediaItem)
    .set({ metadata: { legacyHidden: 'true' } })
    .where(eq(schema.mediaItem.id, remaster.id))
  expect((await groupOf(nightDrive.id))?.merge).toBeNull()
})

it('omits outside tracks and drops a published group when its retained peer leaves the library', async () => {
  const name = 'Scoped duplicate fixture'
  const member = 'duplicate-scope-member'
  const observed = 'duplicate-scope-observed'
  const ids = [member, observed]
  await fixture.insert(schema.mediaItem).values(
    ids.map((id) => ({
      id,
      slug: id,
      title: name,
      mediaType: 'track',
      inLibrary: id === member,
    })),
  )
  await fixture
    .insert(schema.libraryTrack)
    .values(ids.map((mediaItemId) => ({ mediaItemId, durationSec: 200 })))
  await fixture
    .insert(schema.mediaCredit)
    .values(
      ids.map((mediaItemId) => ({ mediaItemId, artistId, role: 'artist' })),
    )
  await fixture.insert(schema.catalogObservation).values({
    id: 'duplicate-scope-observation',
    mediaItemId: observed,
    targetKind: 'track',
    targetId: observed,
    provider: 'spotify',
    operation: 'playback',
  })
  expect(await rebuild()).toBe(true)
  const initial = await countTrackDuplicateGroups({})
  const matching = await listTrackMatchDiagnostics(
    matches({ duplicates: false, q: name }),
  )
  expect(matching.items.map(({ id }) => id)).toEqual([member])
  expect((await listTrackDuplicates(member)).items).toEqual([])

  await fixture
    .update(schema.mediaItem)
    .set({ inLibrary: true })
    .where(eq(schema.mediaItem.id, observed))
  expect(await rebuild()).toBe(true)
  expect((await countTrackDuplicateGroups({})).count).toBe(initial.count + 1)
  expect((await groupOf(member))?.memberIds).toEqual(ids)

  expect(
    await fixture.transaction((tx) => removeOrphanTracks(tx, [observed])),
  ).toBe(1)
  expect(await countTrackDuplicateGroups({})).toEqual(initial)
  expect((await listTrackDuplicates(member)).items).toEqual([])
  const retained = await fixture.query.mediaItem.findFirst({
    where: eq(schema.mediaItem.id, observed),
  })
  expect(retained?.inLibrary).toBe(false)
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

it('plans a bounded number of new groups in one rebuild and the rest in the next', async () => {
  const before = (await countTrackDuplicateGroups({})).count
  // Each pair is two Spotify tracks with one title: one new group.
  const pairCount = TRACK_DUPLICATE_PLAN_LIMIT + 10
  const pairs = Array.from({ length: pairCount }, (_, pair) =>
    ['a', 'b'].map((side) => ({
      id: `tidewater-${pair}-${side}`,
      title: `Tidewater ${pair}`,
    })),
  ).flat()
  await fixture.insert(schema.mediaItem).values(
    pairs.map(({ id, title }) => ({
      id,
      slug: id,
      title,
      mediaType: 'track',
      sourceLabel: 'spotify',
    })),
  )
  await fixture.insert(schema.libraryTrack).values(
    pairs.map(({ id }) => ({
      mediaItemId: id,
      spotifyTrackId: id.padEnd(22, '0'),
      durationSec: 200,
    })),
  )
  await fixture
    .insert(schema.mediaCredit)
    .values(
      pairs.map(({ id }) => ({ mediaItemId: id, artistId, role: 'artist' })),
    )

  expect(await rebuild()).toBe(true)
  expect(await countTrackDuplicateGroups({})).toEqual({
    count: before + TRACK_DUPLICATE_PLAN_LIMIT,
    ready: true,
  })
  // The groups already planned keep their plans; the rest are planned now.
  expect(await rebuild()).toBe(true)
  expect(await countTrackDuplicateGroups({})).toEqual({
    count: before + pairCount,
    ready: true,
  })
  expect(await rebuild()).toBe(false)
})

it('stores for each group the kept track and the cautions of its merge plan', async () => {
  // Two tracks of one group become positions on one album.
  const albumId = 'fixture-album'
  await fixture.insert(schema.mediaItem).values({
    id: albumId,
    slug: albumId,
    title: 'Low Lanterns',
    mediaType: 'album',
  })
  await fixture.insert(schema.album).values({ mediaItemId: albumId })
  await fixture.insert(schema.track).values(
    [liveDash, livePlain].map(({ id, title }, index) => ({
      id: `fixture-position-${index}`,
      albumMediaItemId: albumId,
      trackMediaItemId: id,
      title,
      position: index + 1,
    })),
  )
  // Every group is planned again.
  await fixture.delete(schema.trackDuplicateGroup)
  await fixture.execute(
    sql`update track_duplicate_state set group_count = null`,
  )
  expect(await rebuild()).toBe(true)

  // The words of a version caution follow the order the tracks are read in.
  const comparable = (cautions: TrackMergeCaution[]) =>
    cautions.map((caution) =>
      caution.code === 'version'
        ? { ...caution, words: [...caution.words].sort() }
        : caution,
    )
  const { groups } = await readTrackDuplicateLayout(matches())
  expect(groups.length).toBeGreaterThan(3)
  for (const group of groups) {
    const plan = await readTrackMergePlan(fixture, {
      trackIds: group.memberIds,
    })
    expect(group.memberIds[0]).toBe(plan.targetId)
    expect(comparable(group.cautions)).toEqual(comparable(plan.cautions))
  }
  expect((await groupOf(liveDash.id))?.cautions).toContainEqual({
    code: 'same-album',
    albums: ['Low Lanterns'],
  })

  // Matches lists the groups nothing speaks against, or only the others.
  const everything = await listed()
  const clear = await listed({ duplicateCautions: 'none' })
  const check = await listed({ duplicateCautions: 'some' })
  expect(clear.layout.groups.length).toBeGreaterThan(0)
  expect(check.layout.groups.length).toBeGreaterThan(0)
  expect(clear.layout.groups.every((group) => !group.cautions.length)).toBe(
    true,
  )
  expect(check.layout.groups.every((group) => group.cautions.length)).toBe(true)
  expect(check.ids).toContain(liveDash.id)
  expect([...clear.ids, ...check.ids].sort()).toEqual(
    [...everything.ids].sort(),
  )
  expect((await listed({ duplicateCautions: 'all' })).ids).toEqual(
    everything.ids,
  )
})
