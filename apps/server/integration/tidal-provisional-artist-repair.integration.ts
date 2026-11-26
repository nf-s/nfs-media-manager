import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { SpotifyCodeMatch, TidalSuggestion } from '@repo/schemas/tidal'
import { env } from '@/env'
import { createStableId } from '@/lib/media-utils'
import * as schema from '@/schemas/db'

const database = 'tidal_scoped_artist_' + randomUUID().replaceAll('-', '')
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

import { repairStoredSimilarArtists } from '@/services/catalog-artist-reconciliation'
import { provisionalCatalogArtistId } from '@/services/catalog-discoveries'
import { getArtist } from '@/services/creators'
import { storeKeptSeparate } from '@/services/keep-separate-effects'
import { observeTidalSuggestion } from '@/services/music-catalog-observations'
import { undoLibraryChange } from '@/services/library-changes'
import { backfillTidalSimilarDiscoveries } from '@/services/tidal-similar'

const seedId = 'scoped-artist-fixture-seed'
const jobId = 'scoped-artist-fixture-job'
const receiptId = 'scoped-artist-fixture-receipt'
const code = 'USZZZ2600200'
const name = 'Fixture Russet'
const title = 'Fixture Recording'
const spotifyTrackId = 'T'.repeat(22)
const spotifyArtistId = 'A'.repeat(22)
const tidalTrackId = '57001'
const tidalArtistId = '72001'
const spotifyOwner = createStableId(
  'catalog-artist',
  JSON.stringify(['spotify', spotifyArtistId]),
)
const nativeTidal = createStableId(
  'catalog-artist',
  JSON.stringify(['tidal', tidalArtistId]),
)
const suggestion: TidalSuggestion = {
  tidalId: tidalTrackId,
  title,
  code,
  artists: [name],
  durationSec: 200,
  version: null,
  releaseDate: null,
  url: 'https://tidal.com/track/' + tidalTrackId,
}
const match: SpotifyCodeMatch = {
  spotifyId: spotifyTrackId,
  title,
  artists: [name],
  artistCredits: [{ id: spotifyArtistId, name }],
  durationSec: 200,
  url: 'https://open.spotify.com/track/' + spotifyTrackId,
  albumName: null,
  spotifyAlbumId: null,
  artworkUrl: null,
  trackCount: null,
}
const text = JSON.stringify({
  data: [{ type: 'tracks', id: tidalTrackId }],
  included: [
    {
      type: 'tracks',
      id: tidalTrackId,
      attributes: { title, isrc: code, duration: 'PT3M20S' },
      relationships: {
        artists: { data: [{ type: 'artists', id: tidalArtistId }] },
      },
    },
    { type: 'artists', id: tidalArtistId, attributes: { name } },
  ],
})

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', async () => {
    throw new Error('Unexpected provider request')
  })
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
})

beforeEach(async () => {
  await fixture.execute(
    sql`truncate library_change, artist, scrape_job, provider_response, spotify_code_lookup, media_item cascade`,
  )
  await fixture.insert(schema.mediaItem).values({
    id: seedId,
    slug: seedId,
    title: 'Fixture Seed',
    mediaType: 'track',
  })
  await fixture.insert(schema.scrapeJob).values({
    id: jobId,
    status: 'succeeded',
    provider: 'tidal',
    scope: {},
    options: { task: 'tidal-similar', itemId: seedId },
  })
  await fixture.insert(schema.providerResponse).values({
    id: receiptId,
    jobId,
    provider: 'tidal',
    attempt: 1,
    ordinal: 1,
    phase: 'task',
    method: 'GET',
    status: 200,
    requestUrl:
      'https://openapi.tidal.com/v2/tracks/999/relationships/similarTracks',
    bodyState: 'captured',
    body: { state: 'captured', text },
    retainedBytes: Buffer.byteLength(text),
  })
  await fixture.insert(schema.artist).values({
    id: spotifyOwner,
    name,
    catalogProvider: 'spotify',
    catalogExternalId: spotifyArtistId,
  })
  await fixture.insert(schema.spotifyCodeLookup).values({
    codeType: 'isrc',
    code,
    spotifyId: spotifyTrackId,
    source: 'spotify',
    result: match,
    searchedAt: new Date(),
  })
})

async function saveNamesOnlySuggestion(item = suggestion, position = 1) {
  return fixture.transaction(async (tx) => {
    const track = await observeTidalSuggestion(tx, 'track', item, {
      operation: 'similar',
      key: jobId,
      subjectKind: 'track',
      subjectId: seedId,
      page: 1,
      position,
      jobId,
      responseId: receiptId,
    })
    return {
      track,
      provisional: provisionalCatalogArtistId(
        'tidal',
        track,
        'artist',
        0,
        name,
      ),
    }
  })
}

async function recordingArtist(track: string) {
  const [credit] = await fixture
    .select({ id: schema.mediaCredit.artistId })
    .from(schema.mediaCredit)
    .where(
      and(
        eq(schema.mediaCredit.mediaItemId, track),
        eq(schema.mediaCredit.role, 'artist'),
      ),
    )
  return credit?.id
}

async function findArtist(id: string) {
  const [artist] = await fixture
    .select()
    .from(schema.artist)
    .where(eq(schema.artist.id, id))
  return artist
}

it('redirects the names-only saved credit after exact TIDAL and Spotify receipt replay', async () => {
  const { track, provisional } = await saveNamesOnlySuggestion()
  await fixture.insert(schema.tidalSimilar).values({
    mediaItemId: seedId,
    kind: 'track',
    items: [{ ...suggestion, catalogMediaItemId: track }],
    scrapeJobId: jobId,
    readAt: new Date(),
  })
  const unrelated = await saveNamesOnlySuggestion(
    {
      ...suggestion,
      tidalId: '57002',
      title: 'Fixture Unrelated Recording',
      code: 'USZZZ2600201',
    },
    2,
  )
  expect(await recordingArtist(track)).toBe(provisional)
  expect(await findArtist(nativeTidal)).toBeUndefined()
  expect(await repairStoredSimilarArtists(false, fixture)).toBe(2)
  expect(await findArtist(nativeTidal)).toBeUndefined()
  expect(await recordingArtist(track)).toBe(provisional)
  expect(await repairStoredSimilarArtists(true, fixture)).toBe(2)
  expect(await recordingArtist(track)).toBe(spotifyOwner)
  expect((await getArtist(provisional)).id).toBe(spotifyOwner)
  expect(await recordingArtist(unrelated.track)).toBe(unrelated.provisional)
  const changes = await fixture.select().from(schema.libraryChange)
  const matched = changes.find(({ target }) => target?.id === spotifyOwner)
  if (!matched) throw new Error('Expected the cross-catalog artist merge')
  await undoLibraryChange(matched.id)
  expect(await repairStoredSimilarArtists(true, fixture)).toBe(0)
  await backfillTidalSimilarDiscoveries({ apply: true, limit: 1 })
  expect(await recordingArtist(track)).toBe(nativeTidal)
})

it('does not mint the retained TIDAL artist when the scoped credit is absent', async () => {
  const { track } = await saveNamesOnlySuggestion()
  await fixture
    .delete(schema.mediaCredit)
    .where(eq(schema.mediaCredit.mediaItemId, track))
  expect(await repairStoredSimilarArtists(true, fixture)).toBe(0)
  expect(await findArtist(nativeTidal)).toBeUndefined()
})

it('requires the saved artist slot to still be the active credit position', async () => {
  const { track, provisional } = await saveNamesOnlySuggestion()
  await fixture
    .update(schema.mediaCredit)
    .set({ billingOrder: 1 })
    .where(eq(schema.mediaCredit.mediaItemId, track))
  expect(await repairStoredSimilarArtists(true, fixture)).toBe(0)
  expect(await findArtist(nativeTidal)).toBeUndefined()
  expect(await recordingArtist(track)).toBe(provisional)
})

it('respects a previously kept-separate Spotify artist and recording-scoped TIDAL credit', async () => {
  const { track, provisional } = await saveNamesOnlySuggestion()
  const changeId = 'fixture-keep-artists-separate'
  await fixture.transaction(async (tx) => {
    await tx.insert(schema.libraryChange).values({
      id: changeId,
      kind: 'artist',
      action: 'keep-separate',
      actor: 'owner',
    })
    await storeKeptSeparate(tx, 'artist', [provisional, spotifyOwner], changeId)
  })
  expect(await repairStoredSimilarArtists(true, fixture)).toBe(0)
  expect(await findArtist(nativeTidal)).toBeUndefined()
  expect(await recordingArtist(track)).toBe(provisional)
})
