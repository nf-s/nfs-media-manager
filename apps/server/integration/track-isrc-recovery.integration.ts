import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { env } from '@/env'
import { slugifyParts } from '@/lib/media-utils'
import * as schema from '@/schemas/db'

const database = `track_isrc_recovery_${randomUUID().replaceAll('-', '')}`
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

const spotifyId = (suffix: string) => 'fixturetrack'.padEnd(22, suffix)
const jobId = 'fixture-artist-job'
const searchJobId = 'fixture-search-job'

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
  await fixture.insert(schema.scrapeJob).values([
    {
      id: jobId,
      mediaType: 'album',
      provider: 'spotify',
      status: 'succeeded',
      scope: {},
      options: {},
    },
    {
      id: searchJobId,
      mediaType: 'track',
      provider: 'spotify',
      status: 'succeeded',
      scope: {},
      options: {},
    },
  ])
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

async function track(id: string, spotify: string | null, isrc: string | null) {
  await fixture.insert(schema.mediaItem).values({
    id,
    slug: slugifyParts(id),
    title: id,
    mediaType: 'track',
    sourceLabel: 'spotify',
  })
  await fixture
    .insert(schema.libraryTrack)
    .values({ mediaItemId: id, spotifyTrackId: spotify, isrc })
}

let ordinal = 0
async function response(url: string, body: unknown) {
  ordinal++
  const text = JSON.stringify(body)
  await fixture.insert(schema.providerResponse).values({
    id: `fixture-response-${ordinal}`,
    jobId,
    provider: 'spotify',
    attempt: 1,
    ordinal,
    phase: 'artist',
    method: 'GET',
    requestUrl: url,
    status: 200,
    bodyState: 'captured',
    retainedBytes: text.length,
    body: { state: 'captured', text },
  })
}

const isrcReferences = (mediaItemId: string) =>
  fixture
    .select({
      provider: schema.providerReference.provider,
      isrc: schema.providerReference.externalId,
      metadata: schema.providerReference.metadata,
    })
    .from(schema.providerReference)
    .where(
      and(
        eq(schema.providerReference.mediaItemId, mediaItemId),
        eq(schema.providerReference.referenceType, 'isrc'),
      ),
    )

const primary = async (mediaItemId: string) =>
  (
    await fixture
      .select({ isrc: schema.libraryTrack.isrc })
      .from(schema.libraryTrack)
      .where(eq(schema.libraryTrack.mediaItemId, mediaItemId))
  )[0]?.isrc

it('records stored Spotify ISRCs as references and fills empty primary values once', async () => {
  const { recoverStoredTrackIsrcs } =
    await import('@/services/track-isrc-recovery')
  await track('track-lookup', spotifyId('a'), null)
  await track('track-search-response', spotifyId('b'), null)
  await track('track-search-log', spotifyId('c'), null)
  await track('track-existing', spotifyId('d'), 'ZZ-AAA-26-00004')
  await track('track-conflict', spotifyId('e'), null)
  await track('track-invalid', spotifyId('f'), null)
  await track('track-searched-for', null, null)
  await response(`https://api.spotify.com/v1/tracks/${spotifyId('a')}`, {
    id: spotifyId('a'),
    external_ids: { isrc: 'zzaaa2600001' },
  })
  await response('https://api.spotify.com/v1/search?q=fixture&type=track', {
    tracks: {
      items: [
        { id: spotifyId('b'), external_ids: { isrc: 'ZZAAA2600002' } },
        { id: spotifyId('e'), external_ids: { isrc: 'ZZAAA2600005' } },
        { id: spotifyId('f'), external_ids: { isrc: 'not an isrc' } },
        {
          id: 'fixtureunknown'.padEnd(22, 'z'),
          external_ids: { isrc: 'ZZAAA2600009' },
        },
      ],
    },
  })
  await response(`https://api.spotify.com/v1/tracks/${spotifyId('e')}`, {
    id: spotifyId('e'),
    external_ids: { isrc: 'ZZAAA2600006' },
  })
  await fixture.insert(schema.scrapeJobLog).values({
    id: 'fixture-search-log',
    jobId: searchJobId,
    level: 'info',
    message: 'Search finished',
    metadata: {
      diagnostics: [
        {
          kind: 'spotify-track-search',
          candidates: [
            { spotifyTrackId: spotifyId('c'), isrc: 'ZZAAA2600003' },
          ],
        },
      ],
    },
  })

  expect(await recoverStoredTrackIsrcs(fixture)).toMatchObject({
    apply: false,
    tracks: 5,
    tracksWithSeveralIsrcs: 1,
    references: 0,
  })
  expect(await isrcReferences('track-lookup')).toEqual([])

  const applied = await recoverStoredTrackIsrcs(fixture, { apply: true })
  expect(applied).toMatchObject({ references: 6, primaryFilled: 3 })
  expect(await isrcReferences('track-lookup')).toEqual([
    {
      provider: 'spotify',
      isrc: 'ZZAAA2600001',
      metadata: expect.objectContaining({
        source: 'spotify-track-lookup',
        responseId: 'fixture-response-1',
      }),
    },
  ])
  expect(await isrcReferences('track-search-log')).toEqual([
    expect.objectContaining({
      isrc: 'ZZAAA2600003',
      metadata: expect.objectContaining({
        source: 'spotify-track-search',
        jobId: searchJobId,
      }),
    }),
  ])
  expect(await primary('track-lookup')).toBe('ZZAAA2600001')
  expect(await primary('track-search-response')).toBe('ZZAAA2600002')
  expect(await primary('track-search-log')).toBe('ZZAAA2600003')
  // A stored value is kept as it was and gains its reference.
  expect(await primary('track-existing')).toBe('ZZ-AAA-26-00004')
  expect(await isrcReferences('track-existing')).toEqual([
    expect.objectContaining({
      isrc: 'ZZAAA2600004',
      metadata: expect.objectContaining({ source: 'library-track' }),
    }),
  ])
  // Two codes keep both references and leave the primary value empty.
  expect(
    (await isrcReferences('track-conflict')).map((row) => row.isrc).sort(),
  ).toEqual(['ZZAAA2600005', 'ZZAAA2600006'])
  expect(await primary('track-conflict')).toBeNull()
  expect(await isrcReferences('track-invalid')).toEqual([])
  expect(await isrcReferences('track-searched-for')).toEqual([])

  expect(await recoverStoredTrackIsrcs(fixture, { apply: true })).toMatchObject(
    {
      primaryFilled: 0,
    },
  )
  const references = await fixture
    .select({ id: schema.providerReference.id })
    .from(schema.providerReference)
  expect(references).toHaveLength(6)
  expect(request).not.toHaveBeenCalled()
})

it('stores raw legacy playlist files once and recovers their ISRCs', async () => {
  const [{ preserveLegacyRawPlaylists }, { recoverStoredTrackIsrcs }] =
    await Promise.all([
      import('@/services/legacy-playlist-snapshots'),
      import('@/services/track-isrc-recovery'),
    ])
  await track('track-playlist', spotifyId('g'), null)
  await track('track-playlist-conflict', spotifyId('h'), 'ZZAAA2600008')
  const directory = await mkdtemp(join(tmpdir(), 'legacy-playlists-'))
  try {
    await writeFile(
      join(directory, 'fixture-raw.json'),
      JSON.stringify([
        {
          added_at: '2021-01-01T00:00:00Z',
          track: { id: spotifyId('g'), external_ids: { isrc: 'ZZAAA2600007' } },
          audioFeatures: { tempo: 120 },
        },
        {
          added_at: '2021-01-02T00:00:00Z',
          track: { id: spotifyId('h'), external_ids: { isrc: 'ZZAAA2600010' } },
        },
        { added_at: '2021-01-03T00:00:00Z', track: null },
      ]),
    )
    await writeFile(join(directory, 'fixture.json'), '[]')

    expect(
      await preserveLegacyRawPlaylists(fixture, directory, { apply: false }),
    ).toEqual({
      apply: false,
      files: 1,
      items: 3,
      tracksWithIsrc: 2,
      stored: 0,
      created: 0,
    })
    expect(await preserveLegacyRawPlaylists(fixture, directory)).toMatchObject({
      created: 1,
      stored: 0,
    })
    expect(await preserveLegacyRawPlaylists(fixture, directory)).toMatchObject({
      created: 0,
      stored: 1,
    })
  } finally {
    await rm(directory, { recursive: true })
  }
  const snapshots = await fixture
    .select({
      source: schema.providerSnapshot.source,
      payload: schema.providerSnapshot.payload,
    })
    .from(schema.providerSnapshot)
    .where(eq(schema.providerSnapshot.source, 'legacy-import:fixture-raw.json'))
  expect(snapshots).toHaveLength(1)
  expect(JSON.stringify(snapshots[0]?.payload)).not.toContain('tempo')

  const applied = await recoverStoredTrackIsrcs(fixture, { apply: true })
  expect(applied).toMatchObject({ primaryFilled: 1 })
  expect(await isrcReferences('track-playlist')).toEqual([
    expect.objectContaining({
      provider: 'spotify',
      isrc: 'ZZAAA2600007',
      metadata: expect.objectContaining({
        source: 'legacy-playlist-import',
        snapshotId: expect.any(String),
      }),
    }),
  ])
  expect(await primary('track-playlist')).toBe('ZZAAA2600007')
  // A stored primary value is kept; the differing code is listed beside it.
  expect(await primary('track-playlist-conflict')).toBe('ZZAAA2600008')
  expect(
    (await isrcReferences('track-playlist-conflict'))
      .map((row) => row.isrc)
      .sort(),
  ).toEqual(['ZZAAA2600008', 'ZZAAA2600010'])
  expect(request).not.toHaveBeenCalled()
})
