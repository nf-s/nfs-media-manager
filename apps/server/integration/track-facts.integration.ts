import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { TrackQuerySchema } from '@repo/schemas/tracks'
import { env } from '@/env'
import { slugifyParts } from '@/lib/media-utils'
import * as schema from '@/schemas/db'

const database = `track_facts_${randomUUID().replaceAll('-', '')}`
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
  await fixture.insert(schema.libraryTrack).values({ mediaItemId: id })
}

async function reference(
  mediaItemId: string,
  recordId: number,
  verified: boolean,
) {
  await fixture.insert(schema.providerReference).values({
    id: `fixture-ref-${mediaItemId}`,
    mediaItemId,
    provider: 'sonovault',
    referenceType: 'sonovault-track',
    externalId: String(recordId),
    metadata: { verified, fetchedAt: '2026-11-20T00:00:00.000Z' },
  })
}

const record = (
  id: number,
  bpm: number | null,
  key: [string, string, string] | null,
) => ({
  id,
  title: `Fixture record ${id}`,
  releases: [],
  artists: [],
  isrc: null,
  duration: 200,
  bpm,
  key_alphanumeric: key?.[0] ?? null,
  key_musical: key?.[1] ?? null,
  key_open: key?.[2] ?? null,
  keys: key
    ? [
        {
          key_alphanumeric: key[0],
          key_musical: key[1],
          key_open: key[2],
          source: 'fixture-analyser',
        },
      ]
    : [],
  genre: [],
  subgenre: [],
})

let ordinal = 0
async function response(receivedAt: string, results: unknown[]) {
  ordinal++
  const text = JSON.stringify({
    results,
    partial: false,
    processed: results.length,
    credits_used: results.length,
    credits_remaining: 1000,
    message: null,
  })
  await fixture.insert(schema.providerResponse).values({
    id: `fixture-sonovault-response-${ordinal}`,
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
}

const matched = (input: string, track: unknown) => ({
  input,
  status: 'matched',
  track,
  links: [],
})

it('applies stored Sonovault tempo and key, and Browse shows only verified values', async () => {
  const { applyStoredSonovaultTrackFacts, removeProviderTrackFacts } =
    await import('@/services/track-facts')
  const { listTrackBrowsePage, getTrackDetail } =
    await import('@/services/tracks')
  const { listBrowseFacets } = await import('@/services/browse')

  await track('track-slow', 'Slow fixture')
  await track('track-fast', 'Fast fixture')
  await track('track-mid', 'Middle fixture')
  await track('track-other-version', 'Other version fixture')
  await track('track-unanalysed', 'Unanalysed fixture')
  await track('track-unlooked', 'Unlooked fixture')
  await reference('track-slow', 101, true)
  await reference('track-fast', 102, true)
  await reference('track-mid', 103, true)
  await reference('track-other-version', 104, false)
  await reference('track-unanalysed', 105, true)

  await response('2026-11-20T01:00:00.000Z', [
    matched('a', record(101, 90.5, ['8A', 'Am', '1m'])),
    matched('b', record(102, 174, ['12B', 'E', '5d'])),
    matched('c', record(103, 100, ['1A', 'Abm', '6m'])),
    { input: 'd', status: 'not_found', track: null, links: [] },
  ])
  await response('2026-11-21T01:00:00.000Z', [
    // A later response replaces the earlier record of the same track.
    matched('c', record(103, 124, ['1B', 'B', '6d'])),
    matched('e', record(104, 128, ['9A', 'Em', '2m'])),
    matched('f', record(105, null, null)),
    { input: 'g', status: 'skipped_no_credits', track: null, links: [] },
  ])

  const dryRun = await applyStoredSonovaultTrackFacts(fixture)
  expect(dryRun).toMatchObject({
    apply: false,
    references: 5,
    responses: 2,
    tracks: 5,
    withTempo: 4,
    withKey: 4,
    verified: 4,
    written: 0,
  })
  expect(await fixture.select().from(schema.trackFact)).toEqual([])

  expect(
    await applyStoredSonovaultTrackFacts(fixture, { apply: true }),
  ).toMatchObject({ written: 5 })
  // A second run changes nothing.
  const before = await fixture.select().from(schema.trackFact)
  await applyStoredSonovaultTrackFacts(fixture, { apply: true })
  expect(await fixture.select().from(schema.trackFact)).toEqual(before)

  const mid = before.find((row) => row.mediaItemId === 'track-mid')
  expect(mid).toMatchObject({
    provider: 'sonovault',
    bpm: 124,
    keyCamelot: '1B',
    keyMusical: 'B',
    keyOpen: '6d',
    keySource: 'fixture-analyser',
    verified: true,
    responseId: 'fixture-sonovault-response-2',
    fetchedAt: new Date('2026-11-21T01:00:00.000Z'),
  })

  const page = async (input: Record<string, unknown>) =>
    (await listTrackBrowsePage(TrackQuerySchema.parse(input))).items.map(
      (item) => [item.id, item.bpm, item.musicalKey],
    )

  expect(await page({ sortBy: 'bpm', direction: 'asc' })).toEqual([
    ['track-slow', 90.5, '8A'],
    ['track-mid', 124, '1B'],
    ['track-fast', 174, '12B'],
    // The unverified record's tempo is not shown or sorted in Browse.
    ...[
      ['track-other-version', null, null],
      ['track-unanalysed', null, null],
      ['track-unlooked', null, null],
    ].sort(),
  ])
  expect(
    (await page({ sortBy: 'bpm', direction: 'desc' })).slice(0, 3),
  ).toEqual([
    ['track-fast', 174, '12B'],
    ['track-mid', 124, '1B'],
    ['track-slow', 90.5, '8A'],
  ])
  // Keys sort along the Camelot wheel: 1B before 8A before 12B.
  expect(
    (await page({ sortBy: 'musicalKey', direction: 'asc' })).slice(0, 3),
  ).toEqual([
    ['track-mid', 124, '1B'],
    ['track-slow', 90.5, '8A'],
    ['track-fast', 174, '12B'],
  ])
  // Grouped recordings and an artist's tracks read the same order.
  expect(
    (
      await page({ sortBy: 'bpm', direction: 'asc', groupRecordings: true })
    ).slice(0, 3),
  ).toEqual([
    ['track-slow', 90.5, '8A'],
    ['track-mid', 124, '1B'],
    ['track-fast', 174, '12B'],
  ])
  await fixture
    .insert(schema.artist)
    .values({ id: 'artist-fixture', name: 'Fixture artist' })
  await fixture.insert(schema.mediaCredit).values(
    ['track-fast', 'track-slow', 'track-unlooked'].map((mediaItemId) => ({
      mediaItemId,
      artistId: 'artist-fixture',
      role: 'artist',
    })),
  )
  expect(
    await page({
      creatorId: 'artist-fixture',
      sortBy: 'musicalKey',
      direction: 'asc',
    }),
  ).toEqual([
    ['track-slow', 90.5, '8A'],
    ['track-fast', 174, '12B'],
    ['track-unlooked', null, null],
  ])
  expect(
    await page({
      sortBy: 'bpm',
      ranges: JSON.stringify([{ field: 'bpm', min: 100, max: 130 }]),
    }),
  ).toEqual([['track-mid', 124, '1B']])
  expect(
    (
      await page({
        sortBy: 'title',
        direction: 'asc',
        ranges: JSON.stringify([
          { field: 'bpm', min: 100, includeMissing: true },
        ]),
      })
    ).map(([id]) => id),
  ).toEqual([
    'track-fast',
    'track-mid',
    'track-other-version',
    'track-unanalysed',
    'track-unlooked',
  ])
  // A key filter matches the key in any notation.
  for (const value of ['8A', 'Am', '1m'])
    expect(
      await page({
        sortBy: 'title',
        direction: 'asc',
        filters: JSON.stringify([{ field: 'musicalKey', value }]),
      }),
    ).toEqual([['track-slow', 90.5, '8A']])
  expect(
    await page({
      sortBy: 'title',
      filters: JSON.stringify([{ field: 'musicalKey', value: '9A' }]),
    }),
  ).toEqual([])

  const facets = await listBrowseFacets('track', { q: 'Am' })
  expect(facets.filter((row) => row.field === 'musicalKey')).toEqual([
    { field: 'musicalKey', value: '8A', label: 'Key: 8A', count: 1 },
  ])

  // Track details list the unverified record, marked.
  expect((await getTrackDetail('track-other-version'))?.facts).toEqual([
    {
      provider: 'sonovault',
      bpm: 128,
      keyCamelot: '9A',
      keyMusical: 'Em',
      keyOpen: '2m',
      verified: false,
      fetchedAt: '2026-11-21T01:00:00.000Z',
    },
  ])
  expect((await getTrackDetail('track-unanalysed'))?.facts).toEqual([])
  expect((await getTrackDetail('track-unlooked'))?.facts).toEqual([])

  expect(await removeProviderTrackFacts(fixture, 'sonovault')).toBe(5)
  expect(await fixture.select().from(schema.trackFact)).toEqual([])
  expect(await page({ sortBy: 'bpm' })).toHaveLength(6)
  expect(request).not.toHaveBeenCalled()
})
