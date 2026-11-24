import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { SPOTIFY_SIMILAR_LOOKUP_TASK } from '@repo/schemas/tidal'
import { env } from '@/env'
import { spotifyPlugin } from '@/plugins/builtin/spotify'
import { spotifyTokenFixture } from '@/plugins/builtin/__tests__/fixtures/spotify'
import * as schema from '@/schemas/db'

const database = `spotify_similar_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const fixture = drizzle(pool, { schema })
const request = vi.fn<typeof fetch>()

vi.mock('@/lib/db', () => ({
  get db() {
    return fixture
  },
}))
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async (id: string) =>
    id === 'spotify' ? spotifyPlugin : null,
  listLoadedScrapePlugins: async () => [spotifyPlugin],
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({
    clientId: 'offline-spotify-client',
    clientSecret: 'offline-spotify-secret',
    market: 'AU',
  }),
}))

import {
  observeCatalogMedia,
  promoteCatalogMediaInTransaction,
} from '@/services/catalog-discoveries'
import { SpotifySavedPageSchema } from '@/lib/spotify-api'
import { observeSpotifySavedAlbumPage } from '@/services/album-import-observations'
import { createTaskJob, getJob, processQueuedJobs } from '@/services/jobs'
import { recoverStoredSpotifyAlbumUpcs } from '@/services/spotify-album-upc-recovery'
import { searchMatchCandidates } from '@/services/find-match'

const spotifyId = (n: number) => `fixturespotify${String(n).padStart(8, '0')}`
const searchedUpc = '0000000000048'
const returnedUpc = '000000000048'
const searchedIsrc = 'QZFX22800001'
const differentIsrc = 'QZFX22800002'
const releaseArtist = { id: spotifyId(100), name: 'Fixture Release Ensemble' }
const trackArtist = { id: spotifyId(101), name: 'Fixture Track Ensemble' }
const spotifyAlbum = (n: number) => ({
  id: spotifyId(n),
  name: `Fixture Album ${n}`,
  artists: [releaseArtist],
})
const spotifyTrack = (n: number, isrc: string) => ({
  id: spotifyId(n),
  type: 'track',
  name: `Fixture Track ${n}`,
  artists: [trackArtist],
  album: spotifyAlbum(20 + n),
  duration_ms: 180000,
  external_ids: { isrc },
})

let created = false
beforeAll(async () => {
  request.mockImplementation(async (input) => {
    const url = new URL(String(input))
    if (url.origin === 'https://accounts.spotify.com')
      return Response.json(spotifyTokenFixture)
    if (
      url.origin === 'https://api.spotify.com' &&
      url.pathname === '/v1/search'
    ) {
      if (url.searchParams.get('q') === 'Fixture Album Seed')
        return Response.json({
          albums: {
            items: [
              { ...spotifyAlbum(13), external_ids: { upc: returnedUpc } },
            ],
            total: 1,
          },
        })
      if (url.searchParams.get('q') === `upc:${searchedUpc}`)
        return Response.json({
          albums: {
            items: [
              { ...spotifyAlbum(10), external_ids: { upc: returnedUpc } },
              spotifyAlbum(11),
            ],
          },
        })
      if (url.searchParams.get('q') === `isrc:${searchedIsrc}`)
        return Response.json({
          tracks: {
            items: [
              spotifyTrack(1, searchedIsrc),
              spotifyTrack(2, differentIsrc),
            ],
          },
        })
    }
    throw new Error('Unexpected provider request')
  })
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
  await fixture.insert(schema.mediaItem).values([
    {
      id: 'album-seed',
      mediaType: 'album',
      slug: 'album-seed',
      title: 'Fixture Album Seed',
    },
    {
      id: 'track-seed',
      mediaType: 'track',
      slug: 'track-seed',
      title: 'Fixture Track Seed',
    },
  ])
  await fixture.insert(schema.album).values({ mediaItemId: 'album-seed' })
  await fixture
    .insert(schema.libraryTrack)
    .values({ mediaItemId: 'track-seed' })
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

beforeEach(async () => {
  await fixture.delete(schema.providerRequestState)
})

async function references(kind: 'album' | 'track', candidate: number) {
  const [native] = await fixture
    .select({ id: schema.providerReference.mediaItemId })
    .from(schema.providerReference)
    .where(
      and(
        eq(schema.providerReference.provider, 'spotify'),
        eq(
          schema.providerReference.referenceType,
          kind === 'album' ? 'spotify' : kind,
        ),
        eq(schema.providerReference.externalId, spotifyId(candidate)),
      ),
    )
  if (!native) throw new Error('Missing Spotify catalog record')
  return {
    id: native.id,
    references: await fixture
      .select({
        referenceType: schema.providerReference.referenceType,
        externalId: schema.providerReference.externalId,
        metadata: schema.providerReference.metadata,
      })
      .from(schema.providerReference)
      .where(eq(schema.providerReference.mediaItemId, native.id)),
  }
}

async function artistIds(itemId: string) {
  return (
    await fixture
      .select({ externalId: schema.artist.catalogExternalId })
      .from(schema.mediaCredit)
      .innerJoin(
        schema.artist,
        eq(schema.artist.id, schema.mediaCredit.artistId),
      )
      .where(eq(schema.mediaCredit.mediaItemId, itemId))
  ).map(({ externalId }) => externalId)
}

async function lookup(kind: 'album' | 'track', code: string) {
  const job = await createTaskJob(SPOTIFY_SIMILAR_LOOKUP_TASK, null, {
    taskOptions: { kind, itemId: `${kind}-seed`, codes: [code] },
  })
  await processQueuedJobs()
  expect(await getJob(job.id)).toMatchObject({ status: 'succeeded' })
  return job.id
}

it('records the returned UPC and artist ID on the Spotify album edition', async () => {
  const jobId = await lookup('album', searchedUpc)
  const found = await references('album', 10)
  const unknown = await references('album', 11)
  expect(found.references).toContainEqual({
    referenceType: 'upc',
    externalId: returnedUpc,
    metadata: {
      source: 'spotify-code-search',
      jobId,
      responseId: expect.any(String),
    },
  })
  expect(unknown.references.map(({ referenceType }) => referenceType)).toEqual([
    'spotify',
  ])
  expect(await artistIds(found.id)).toEqual([releaseArtist.id])
  await fixture.transaction((tx) =>
    promoteCatalogMediaInTransaction(tx, found.id),
  )
  expect((await references('album', 10)).references).toEqual(found.references)
})

it('retains the UPC of a saved Spotify album preview with its exact edition', async () => {
  await observeSpotifySavedAlbumPage(
    fixture,
    SpotifySavedPageSchema.parse({
      offset: 0,
      total: 1,
      next: null,
      items: [
        {
          added_at: '2026-01-01T00:00:00Z',
          album: { ...spotifyAlbum(12), external_ids: { upc: returnedUpc } },
        },
      ],
    }),
    'fixture-preview',
  )
  expect((await references('album', 12)).references).toContainEqual({
    referenceType: 'upc',
    externalId: returnedUpc,
    metadata: { source: 'album-import-preview', importId: 'fixture-preview' },
  })
})

it('keeps a Find match UPC on the exact Spotify result with its saved response', async () => {
  const result = await searchMatchCandidates({
    kind: 'album',
    provider: 'spotify',
    id: 'album-seed',
  })
  const native = await references('album', 13)
  expect(result.items).toMatchObject([{ catalogMediaItemId: native.id }])
  const snapshot = await fixture.query.providerSnapshot.findFirst({
    where: and(
      eq(schema.providerSnapshot.mediaItemId, 'album-seed'),
      eq(schema.providerSnapshot.provider, 'spotify'),
    ),
  })
  expect(snapshot).toMatchObject({
    payload: {
      request: { url: 'https://api.spotify.com/v1/search' },
      response: { status: 200, body: { state: 'captured' } },
    },
  })
  expect(native.references).toContainEqual({
    referenceType: 'upc',
    externalId: returnedUpc,
    metadata: { source: 'match-search', snapshotId: snapshot?.id },
  })
  expect(
    await fixture.$count(
      schema.providerReference,
      and(
        eq(schema.providerReference.mediaItemId, 'album-seed'),
        eq(schema.providerReference.referenceType, 'upc'),
      ),
    ),
  ).toBe(0)
})

it('records each returned ISRC only on its own Spotify track and preserves release credits', async () => {
  await lookup('track', searchedIsrc)
  const matching = await references('track', 1)
  const other = await references('track', 2)
  const release = await references('album', 21)
  for (const { result, code } of [
    { result: matching, code: searchedIsrc },
    { result: other, code: differentIsrc },
  ]) {
    expect(
      result.references.filter(({ referenceType }) => referenceType === 'isrc'),
    ).toEqual([
      expect.objectContaining({
        externalId: code,
        metadata: expect.objectContaining({
          source: 'spotify-search-response',
          responseId: expect.any(String),
        }),
      }),
    ])
  }
  expect(await artistIds(matching.id)).toEqual([trackArtist.id])
  expect(await artistIds(release.id)).toEqual([releaseArtist.id])
  await fixture.transaction((tx) =>
    promoteCatalogMediaInTransaction(tx, matching.id),
  )
  expect((await references('track', 1)).references).toEqual(matching.references)
})

it('recovers UPCs by exact Spotify album ID from a bounded retained response', async () => {
  const albumId = await fixture.transaction((tx) =>
    observeCatalogMedia(
      tx,
      {
        kind: 'album',
        title: 'Fixture Older Spotify Album',
        provider: 'spotify',
        referenceType: 'spotify',
        externalId: spotifyId(30),
      },
      {
        provider: 'spotify',
        operation: 'fixture',
        occurrenceKey: 'fixture-upc',
      },
    ),
  )
  const jobId = 'fixture-older-upc-job'
  const responseId = 'zz-fixture-older-upc-response'
  await fixture.insert(schema.scrapeJob).values({
    id: jobId,
    provider: 'spotify',
    status: 'succeeded',
    scope: {},
    options: {},
  })
  const text = JSON.stringify({
    albums: {
      items: [
        { ...spotifyAlbum(30), external_ids: { upc: returnedUpc } },
        { ...spotifyAlbum(31), external_ids: { upc: '0000000000049' } },
      ],
    },
  })
  await fixture.insert(schema.providerResponse).values({
    id: responseId,
    jobId,
    provider: 'spotify',
    attempt: 1,
    ordinal: 1,
    phase: 'task',
    requestUrl: 'https://api.spotify.com/v1/search',
    method: 'GET',
    status: 200,
    bodyState: 'captured',
    retainedBytes: Buffer.byteLength(text),
    body: { state: 'captured', text },
  })
  const batch = { after: 'response:zz-fixture', limit: 1 }
  const counts = {
    inspected: 1,
    candidates: 2,
    pendingReferences: 1,
    next: `response:${responseId}`,
  }
  expect(await recoverStoredSpotifyAlbumUpcs(fixture, batch)).toEqual({
    ...counts,
    references: 0,
  })
  expect((await references('album', 30)).references).toHaveLength(1)
  expect(
    await recoverStoredSpotifyAlbumUpcs(fixture, { ...batch, apply: true }),
  ).toEqual({ ...counts, references: 1 })
  expect(
    await recoverStoredSpotifyAlbumUpcs(fixture, { ...batch, apply: true }),
  ).toMatchObject({ pendingReferences: 0, references: 0 })
  expect(await references('album', 30)).toMatchObject({
    id: albumId,
    references: expect.arrayContaining([
      {
        referenceType: 'upc',
        externalId: returnedUpc,
        metadata: { source: 'spotify-upc-recovery', responseId, jobId },
      },
    ]),
  })
  expect((await references('album', 30)).references).toHaveLength(2)
  expect(
    await fixture.$count(
      schema.providerReference,
      eq(schema.providerReference.externalId, spotifyId(31)),
    ),
  ).toBe(0)
})
