import { randomUUID } from 'node:crypto'
import { asc, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { env } from '@/env'
import { slugifyParts } from '@/lib/media-utils'
import * as schema from '@/schemas/db'

const database = `track_tags_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const fixture = drizzle(pool, { schema })
const request = vi.fn(() => {
  throw new Error('Network forbidden')
})

vi.mock('@/lib/db', () => ({
  get db() {
    return fixture
  },
}))

const jobId = 'fixture-sonovault-job'
let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
  await fixture.insert(schema.scrapeJob).values({
    id: jobId,
    mediaType: 'track',
    provider: 'sonovault',
    status: 'succeeded',
    scope: {},
    options: {},
  })
  // Album tags that exist before Sonovault: Current with Deep Current
  // beneath it, Drum and Wire (a spelling of Drum & Wire) and Harbour Bass.
  for (const [id, name] of [
    ['tag-current', 'Current'],
    ['tag-deep-current', 'Deep Current'],
    ['tag-drum-and-wire', 'Drum and Wire'],
    ['tag-harbour-bass', 'Harbour Bass'],
  ] as const) {
    await fixture.insert(schema.tag).values({
      id,
      mediaType: 'album',
      name,
      kind: 'genre',
    })
    await fixture.insert(schema.tagIdentity).values({
      mediaType: 'album',
      normalizedName: name.toLowerCase(),
      kind: 'genre',
      tagId: id,
    })
  }
  await fixture.insert(schema.tagIdentity).values({
    mediaType: 'album',
    normalizedName: 'drum & wire',
    kind: 'genre',
    tagId: 'tag-drum-and-wire',
  })
  await fixture.insert(schema.tagParent).values({
    mediaType: 'album',
    childKey: 'deep current',
    parentKey: 'current',
  })
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

async function track(id: string, title: string) {
  await fixture.insert(schema.mediaItem).values({
    id,
    slug: slugifyParts(id),
    title,
    mediaType: 'track',
    sourceLabel: 'spotify',
  })
  await fixture
    .insert(schema.libraryTrack)
    .values({ mediaItemId: id, durationSec: 200 })
}

const record = (
  id: number,
  genre: string[],
  subgenre: string[] = [],
  title = `Fixture record ${id}`,
) => ({
  id,
  title,
  releases: [],
  artists: [],
  isrc: null,
  duration: 200,
  bpm: null,
  key_alphanumeric: null,
  key_musical: null,
  key_open: null,
  keys: [],
  genre,
  subgenre,
})

let ordinal = 0
async function response(receivedAt: string, body: unknown) {
  ordinal++
  const id = `fixture-sonovault-response-${ordinal}`
  const text = JSON.stringify(body)
  await fixture.insert(schema.providerResponse).values({
    id,
    jobId,
    provider: 'sonovault',
    attempt: 1,
    ordinal,
    phase: 'task',
    method: 'POST',
    requestUrl: 'https://api.sonovault.example/v1/tracks/resolve',
    status: 200,
    receivedAt: new Date(receivedAt),
    bodyState: 'captured',
    retainedBytes: text.length,
    body: { state: 'captured', text },
  })
  return { id, fetchedAt: new Date(receivedAt) }
}

const bulk = (tracks: unknown[]) => ({
  results: tracks.map((track, index) => ({
    input: `input-${index}`,
    status: track ? 'matched' : 'not_found',
    track,
    links: [],
  })),
  partial: false,
  processed: tracks.length,
  credits_used: tracks.length,
  credits_remaining: 1000,
  message: null,
})

async function lookup(
  mediaItemId: string,
  input: {
    status: 'matched' | 'not_found'
    recordId?: number
    verified?: boolean
    response: { id: string | null; fetchedAt: Date }
    record?: ReturnType<typeof record>
  },
) {
  await fixture
    .insert(schema.sonovaultTrackLookup)
    .values({
      mediaItemId,
      inputType: 'spotify_id',
      input: `spotify-${mediaItemId}`,
      status: input.status,
      sonovaultTrackId: input.recordId ? String(input.recordId) : null,
      verified: input.status === 'matched' ? (input.verified ?? true) : null,
      scrapeJobId: jobId,
      responseId: input.response.id,
      lookedUpAt: input.response.fetchedAt,
      record: input.record
        ? { kind: 'resolve', track: input.record, links: [] }
        : null,
    })
    .onConflictDoNothing()
}

const RowsSchema = z.array(
  z.object({
    media_item_id: z.string(),
    name: z.string(),
    sonovault: z.boolean(),
    verified: z.boolean(),
    owner: z.string().nullable(),
    in_browse: z.boolean(),
  }),
)
async function rows(mediaItemId: string) {
  return RowsSchema.parse(
    (
      await fixture.execute(sql`
        select tt.media_item_id, t.name, tt.sonovault, tt.verified, tt.owner, tt.in_browse
        from track_tag tt join tag t on t.id = tt.tag_id
        where tt.media_item_id = ${mediaItemId} order by t.name`)
    ).rows,
  )
}
async function hasOwnTags(mediaItemId: string) {
  const [row] = await fixture
    .select({ value: schema.libraryTrack.hasOwnTags })
    .from(schema.libraryTrack)
    .where(eq(schema.libraryTrack.mediaItemId, mediaItemId))
  return row?.value
}
async function occurrences(mediaItemId: string) {
  return fixture
    .select({
      rawName: schema.tagOccurrence.rawName,
      kind: schema.tagOccurrence.kind,
      provider: schema.tagOccurrence.provider,
      sourceId: schema.tagOccurrence.sourceId,
      tagId: schema.tagOccurrence.tagId,
    })
    .from(schema.tagOccurrence)
    .where(eq(schema.tagOccurrence.mediaItemId, mediaItemId))
    .orderBy(asc(schema.tagOccurrence.rawName), asc(schema.tagOccurrence.kind))
}
const DirtySchema = z.array(
  z.object({ facets: z.number(), order: z.number(), duplicates: z.number() }),
)
async function dirty() {
  const [row] = DirtySchema.parse(
    (
      await fixture.execute(sql`
        select (select count(*)::int from track_facet_dirty) as facets,
          (select count(*)::int from recording_browse_order_dirty) as order,
          (select count(*)::int from track_duplicate_dirty) as duplicates`)
    ).rows,
  )
  return row
}
async function clearDirty() {
  await fixture.execute(sql`delete from track_facet_dirty`)
  await fixture.execute(sql`delete from recording_browse_order_dirty`)
  await fixture.execute(sql`delete from track_duplicate_dirty`)
}
async function snapshot() {
  return {
    tags: await fixture
      .select()
      .from(schema.trackTag)
      .orderBy(asc(schema.trackTag.mediaItemId), asc(schema.trackTag.tagId)),
    occurrences: await fixture
      .select()
      .from(schema.tagOccurrence)
      .orderBy(asc(schema.tagOccurrence.id)),
  }
}

describe('track tags from Sonovault records', () => {
  it('backfills stored records: dry run, apply, a re-run that changes nothing', async () => {
    const { applyStoredSonovaultTrackTags } =
      await import('@/services/track-tags')
    await track('track-current', 'Current fixture')
    await track('track-other-version', 'Other version fixture')
    await track('track-tide', 'Tide fixture')
    await track('track-release', 'Release fixture')
    await track('track-missing', 'Missing fixture')
    await track('track-unlooked', 'Unlooked fixture')

    const first = await response(
      '2026-11-20T01:00:00.000Z',
      bulk([
        record(101, ['Current'], ['Deep Current']),
        record(102, ['Drum & Wire']),
        record(103, ['Tide'], ['Peak Hour Tide', 'Tide']),
        null,
      ]),
    )
    // A release body lists its tracks; the album lookup stores this one.
    const release = await response('2026-11-20T02:00:00.000Z', {
      id: 900,
      title: 'Fixture release',
      tracks: [record(104, ['Current'])],
    })
    await lookup('track-current', {
      status: 'matched',
      recordId: 101,
      response: first,
    })
    await lookup('track-other-version', {
      status: 'matched',
      recordId: 102,
      verified: false,
      response: first,
    })
    await lookup('track-tide', {
      status: 'matched',
      recordId: 103,
      response: first,
    })
    await lookup('track-release', {
      status: 'matched',
      recordId: 104,
      response: release,
    })
    await lookup('track-missing', { status: 'not_found', response: first })
    // A lookup row that keeps its record needs no stored response.
    await track('track-kept', 'Kept fixture')
    await lookup('track-kept', {
      status: 'matched',
      recordId: 105,
      response: { id: null, fetchedAt: new Date('2026-11-20T03:00:00.000Z') },
      record: record(105, ['Current']),
    })

    const dryRun = await applyStoredSonovaultTrackTags(fixture)
    expect(dryRun).toMatchObject({
      apply: false,
      lookups: 6,
      fromRecords: 1,
      responses: 2,
      recordsMissing: 0,
      tracks: 6,
      tracksWithTags: 5,
      // Tide appears as a genre and a subgenre of one track: one row.
      rows: 7,
      verifiedRows: 6,
      verifiedShare: 85.7,
      inserted: 7,
      names: 5,
      namesCreated: 2,
      // Tide and Peak Hour Tide are new; Drum and Wire has no parent.
      namesOutsideHierarchy: 3,
      namesOnHiddenTags: 0,
    })
    expect(await fixture.select().from(schema.trackTag)).toEqual([])
    expect(
      await fixture
        .select()
        .from(schema.tag)
        .where(eq(schema.tag.name, 'Peak Hour Tide')),
    ).toEqual([])

    await clearDirty()
    const applied = await applyStoredSonovaultTrackTags(fixture, {
      apply: true,
    })
    expect(applied).toMatchObject({ tracks: 6, rows: 7, inserted: 7 })
    expect(await rows('track-kept')).toEqual([
      expect.objectContaining({ name: 'Current', in_browse: true }),
    ])
    expect(await rows('track-current')).toEqual([
      expect.objectContaining({ name: 'Current', in_browse: true }),
      expect.objectContaining({ name: 'Deep Current', in_browse: true }),
    ])
    // An unverified record's tags are stored, out of Browse (TTAG-05).
    expect(await rows('track-other-version')).toEqual([
      expect.objectContaining({
        name: 'Drum and Wire',
        sonovault: true,
        verified: false,
        in_browse: false,
      }),
    ])
    expect(await hasOwnTags('track-current')).toBe(true)
    expect(await hasOwnTags('track-other-version')).toBe(false)
    expect(await hasOwnTags('track-release')).toBe(true)
    expect(await hasOwnTags('track-missing')).toBe(false)
    expect(await hasOwnTags('track-unlooked')).toBe(false)
    // Each Sonovault name is an occurrence (TTAG-02), Tide twice.
    expect(await occurrences('track-tide')).toEqual([
      expect.objectContaining({
        rawName: 'Peak Hour Tide',
        kind: 'subgenre',
        provider: 'sonovault',
        sourceId: null,
      }),
      expect.objectContaining({ rawName: 'Tide', kind: 'genre' }),
      expect.objectContaining({ rawName: 'Tide', kind: 'subgenre' }),
    ])
    // A name with no tag gets a visible album tag outside the hierarchy.
    const [peak] = await fixture
      .select()
      .from(schema.tag)
      .where(eq(schema.tag.name, 'Peak Hour Tide'))
    expect(peak).toMatchObject({ mediaType: 'album', hidden: false })
    // TTAG-10: the Tracks vocabulary is marked; recording order and
    // possible duplicates are not.
    expect(await dirty()).toMatchObject({ order: 0, duplicates: 0 })
    expect((await dirty())?.facets).toBeGreaterThan(0)

    const before = await snapshot()
    await clearDirty()
    const again = await applyStoredSonovaultTrackTags(fixture, { apply: true })
    expect(again).toMatchObject({
      inserted: 0,
      updated: 0,
      cleared: 0,
      occurrences: 0,
      namesCreated: 0,
    })
    expect(await snapshot()).toEqual(before)
    expect(await dirty()).toMatchObject({ facets: 0, order: 0, duplicates: 0 })
  })

  it('keeps the owner’s additions and removals across Sonovault refreshes', async () => {
    const { addTrackTag, removeTrackTag, resetTrackTags } =
      await import('@/services/track-tags')
    const { writeSonovaultRecords } =
      await import('@/services/sonovault-track-lookup')

    // Adding an unverified record's tag makes it an owner tag.
    await addTrackTag('track-other-version', 'tag-drum-and-wire')
    expect(await rows('track-other-version')).toEqual([
      expect.objectContaining({ owner: 'added', in_browse: true }),
    ])
    expect(await hasOwnTags('track-other-version')).toBe(true)

    await removeTrackTag('track-current', 'tag-deep-current')
    await addTrackTag('track-current', 'tag-harbour-bass')
    expect(await rows('track-current')).toEqual([
      expect.objectContaining({ name: 'Current', owner: null }),
      expect.objectContaining({
        name: 'Deep Current',
        owner: 'removed',
        in_browse: false,
      }),
      expect.objectContaining({
        name: 'Harbour Bass',
        sonovault: false,
        owner: 'added',
        in_browse: true,
      }),
    ])

    // A refresh repeats Deep Current: it stays removed. The owner's Harbour
    // Bass stays although Sonovault does not give it.
    const refresh = await response(
      '2026-11-21T01:00:00.000Z',
      bulk([record(101, ['Current'], ['Deep Current'], 'Current fixture')]),
    )
    await fixture.transaction((tx) =>
      writeSonovaultRecords(tx, {
        jobId,
        inputType: 'spotify_id',
        response: refresh,
        entries: [
          {
            trackId: 'track-current',
            input: 'spotify-track-current',
            record: {
              track: record(
                101,
                ['Current'],
                ['Deep Current'],
                'Current fixture',
              ),
              links: [],
            },
            fillsPrimaryIsrc: false,
          },
        ],
      }),
    )
    expect(await rows('track-current')).toEqual([
      expect.objectContaining({ name: 'Current', in_browse: true }),
      expect.objectContaining({ name: 'Deep Current', owner: 'removed' }),
      expect.objectContaining({ name: 'Harbour Bass', owner: 'added' }),
    ])
    // Adding a removed tag again restores it.
    await addTrackTag('track-current', 'tag-deep-current')
    expect(await rows('track-current')).toContainEqual(
      expect.objectContaining({ name: 'Deep Current', owner: 'added' }),
    )

    // Reset to Sonovault drops the owner-only row and clears the marks.
    await resetTrackTags('track-current')
    expect(await rows('track-current')).toEqual([
      expect.objectContaining({
        name: 'Current',
        owner: null,
        in_browse: true,
      }),
      expect.objectContaining({
        name: 'Deep Current',
        owner: null,
        in_browse: true,
      }),
    ])
    await expect(addTrackTag('track-current', 'no-such-tag')).rejects.toThrow(
      'Tag not found',
    )
  })

  it('records a lookup’s tags and drops Sonovault’s rows for a track no longer found', async () => {
    const { writeSonovaultRecords } =
      await import('@/services/sonovault-track-lookup')
    const { addTrackTag } = await import('@/services/track-tags')
    await addTrackTag('track-release', 'tag-harbour-bass')
    const later = await response(
      '2026-11-22T01:00:00.000Z',
      bulk([record(103, ['Current'], [], 'Tide fixture'), null]),
    )
    await fixture.transaction((tx) =>
      writeSonovaultRecords(tx, {
        jobId,
        inputType: 'spotify_id',
        response: later,
        entries: [
          {
            trackId: 'track-tide',
            input: 'spotify-track-tide',
            record: {
              track: record(103, ['Current'], [], 'Tide fixture'),
              links: [],
            },
            fillsPrimaryIsrc: false,
          },
          {
            trackId: 'track-release',
            input: 'spotify-track-release',
            record: { track: null, links: [] },
            fillsPrimaryIsrc: false,
          },
        ],
      }),
    )
    // The refreshed record replaces the rows and occurrences it no longer gives.
    expect(await rows('track-tide')).toEqual([
      expect.objectContaining({ name: 'Current', in_browse: true }),
    ])
    expect(await occurrences('track-tide')).toEqual([
      expect.objectContaining({
        rawName: 'Current',
        kind: 'genre',
        sourceId: null,
      }),
    ])
    // A track no longer found keeps only the owner's rows.
    expect(await rows('track-release')).toEqual([
      expect.objectContaining({ name: 'Harbour Bass', owner: 'added' }),
    ])
    expect(await occurrences('track-release')).toEqual([])
    expect(await hasOwnTags('track-release')).toBe(true)
  })

  it('keeps has_own_tags right when a tag is hidden, shown or merged', async () => {
    const { setTagVisibility, mergeTags } = await import('@/services/tags')
    // track-tide has only Current, which is visible.
    expect(await hasOwnTags('track-tide')).toBe(true)
    await clearDirty()
    await setTagVisibility({
      mediaType: 'album',
      tagIds: ['tag-current'],
      hidden: true,
    })
    expect(await hasOwnTags('track-tide')).toBe(false)
    expect(await hasOwnTags('track-current')).toBe(true)
    // Hiding changes no track_tag row, so nothing is marked.
    expect(await dirty()).toMatchObject({ order: 0, duplicates: 0 })
    await setTagVisibility({
      mediaType: 'album',
      tagIds: ['tag-current'],
      hidden: false,
    })
    expect(await hasOwnTags('track-tide')).toBe(true)

    // Merging Deep Current into Harbour Bass moves the rows and combines
    // track-current's: Sonovault's Deep Current with no owner mark.
    await mergeTags(
      {
        mediaType: 'album',
        sourceIds: ['tag-deep-current'],
        targetId: 'tag-harbour-bass',
      },
      null,
    )
    expect(await rows('track-current')).toEqual([
      expect.objectContaining({ name: 'Current' }),
      expect.objectContaining({
        name: 'Harbour Bass',
        sonovault: true,
        verified: true,
        in_browse: true,
      }),
    ])
    const harbour = await rows('track-release')
    expect(harbour).toEqual([
      expect.objectContaining({ name: 'Harbour Bass', owner: 'added' }),
    ])
    // A later record naming Deep Current resolves to the merged tag.
    const { recordSonovaultTrackTags } = await import('@/services/track-tags')
    await fixture.transaction((tx) =>
      recordSonovaultTrackTags(tx, [
        {
          mediaItemId: 'track-unlooked',
          record: { genre: [], subgenre: ['Deep Current'] },
          verified: true,
          responseId: null,
          fetchedAt: new Date('2026-11-22T02:00:00.000Z'),
        },
      ]),
    )
    expect(await rows('track-unlooked')).toEqual([
      expect.objectContaining({ name: 'Harbour Bass', in_browse: true }),
    ])
  })

  it('resolves a name through the Sonovault name map first', async () => {
    const { recordSonovaultTrackTags } = await import('@/services/track-tags')
    await track('track-harbour', 'Harbour fixture')
    await fixture.transaction((tx) =>
      recordSonovaultTrackTags(
        tx,
        [
          {
            mediaItemId: 'track-harbour',
            record: { genre: ['Harbour'], subgenre: [] },
            verified: true,
            responseId: null,
            fetchedAt: new Date('2026-11-22T03:00:00.000Z'),
          },
        ],
        { nameMap: new Map([['harbour', 'Harbour Bass']]) },
      ),
    )
    expect(await rows('track-harbour')).toEqual([
      expect.objectContaining({ name: 'Harbour Bass' }),
    ])
    expect(await occurrences('track-harbour')).toEqual([
      expect.objectContaining({
        rawName: 'Harbour',
        tagId: 'tag-harbour-bass',
      }),
    ])
    // The provider's own map holds the one reviewed entry.
    const { sonovaultTagName } = await import('@/lib/sonovault-tags')
    expect(sonovaultTagName('Garage')).toBe('UK Garage')
    expect(sonovaultTagName('Deep Current')).toBe('Deep Current')
  })

  it('removes Sonovault’s tags and keeps the owner’s (SONO-10)', async () => {
    const { removeSonovaultData } =
      await import('@/services/sonovault-track-lookup')
    await removeSonovaultData()
    const remaining = RowsSchema.parse(
      (
        await fixture.execute(sql`
          select tt.media_item_id, t.name, tt.sonovault, tt.verified, tt.owner, tt.in_browse
          from track_tag tt join tag t on t.id = tt.tag_id
          order by tt.media_item_id, t.name`)
      ).rows,
    )
    expect(remaining).toEqual([
      expect.objectContaining({
        media_item_id: 'track-other-version',
        sonovault: false,
        owner: 'added',
      }),
      expect.objectContaining({
        media_item_id: 'track-release',
        sonovault: false,
        owner: 'added',
      }),
    ])
    expect(
      await fixture
        .select()
        .from(schema.tagOccurrence)
        .where(eq(schema.tagOccurrence.provider, 'sonovault')),
    ).toEqual([])
    expect(await hasOwnTags('track-current')).toBe(false)
    expect(await hasOwnTags('track-release')).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })
})
