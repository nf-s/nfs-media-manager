import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import {
  SPOTIFY_TRACK_SEARCH_TASK,
  type SpotifyTrackSearchCandidate,
} from '@repo/schemas/spotify-track-search'
import { env } from '@/env'
import { createStableId, slugifyParts } from '@/lib/media-utils'
import * as schema from '@/schemas/db'
import { backfillSpotifyTrackSearches } from '../scripts/backfill-spotify-track-searches'

const database = `spotify_search_backfill_${randomUUID().replaceAll('-', '')}`
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
const userId = 'fixture-owner'
const otherUserId = 'fixture-second-owner'
const artistName = 'Fixture Artist'
const artistId = 'fixture-artist'
const username = 'fixture-listener'
const createdAt = new Date('2026-01-01T00:00:00Z')
const finishedAt = new Date('2026-01-01T00:01:00Z')

vi.mock('@/lib/db', () => ({
  get db() {
    return fixture
  },
}))

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
  await fixture.insert(schema.user).values([
    { id: userId, name: 'Fixture Owner', email: 'owner@example.test' },
    { id: otherUserId, name: 'Second Fixture', email: 'second@example.test' },
  ])
  await fixture.insert(schema.artist).values({ id: artistId, name: artistName })
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

beforeEach(async () => {
  request.mockClear()
  await fixture.delete(schema.scrapeJob)
  await fixture.delete(schema.mediaItem)
  await fixture.delete(schema.lastfmScrobble)
})

function catalogCandidate(
  title: string,
  suffix: string,
): SpotifyTrackSearchCandidate {
  const spotifyTrackId = 'fixturetrack'.padEnd(22, suffix)
  return {
    spotifyTrackId,
    title,
    artists: [artistName],
    artistCredits: [],
    albumName: 'Fixture Album',
    spotifyAlbumId: 'fixturealbum'.padEnd(22, suffix),
    durationSec: 180,
    isrc: null,
    artworkUrl: null,
    spotifyUrl: `https://open.spotify.com/track/${spotifyTrackId}`,
  }
}

async function lastfmTrack(
  trackId: string,
  title: string,
  manuallyMatched = false,
) {
  await fixture.insert(schema.mediaItem).values({
    id: trackId,
    slug: slugifyParts(title, trackId),
    title,
    mediaType: 'track',
    sourceLabel: 'lastfm',
  })
  await fixture.insert(schema.libraryTrack).values({ mediaItemId: trackId })
  await fixture.insert(schema.mediaCredit).values({
    mediaItemId: trackId,
    artistId,
    role: 'artist',
  })
  const source = {
    username,
    artistKey: artistName.toLowerCase(),
    trackKey: title.toLowerCase(),
  }
  await fixture.insert(schema.lastfmTrackSource).values({
    ...source,
    trackMediaItemId: trackId,
    manuallyMatched,
  })
  await fixture.insert(schema.lastfmScrobble).values({
    ...source,
    id: `${trackId}-scrobble`,
    listenedAt: createdAt,
    artistName,
    trackName: title,
  })
}

function savedSearch(
  trackId: string,
  title: string,
  id = `${trackId}-search`,
): typeof schema.scrapeJob.$inferInsert {
  return {
    id,
    provider: 'spotify',
    status: 'succeeded',
    scope: { mediaType: 'track', mediaItemIds: [trackId] },
    options: {
      task: SPOTIFY_TRACK_SEARCH_TASK,
      trackId,
      trackTitle: title,
      query: `track:"${title}" artist:"${artistName}"`,
      resultCount: 1,
      groupKey: createStableId(
        SPOTIFY_TRACK_SEARCH_TASK,
        JSON.stringify([userId, trackId]),
      ),
    },
    createdAt,
    startedAt: createdAt,
    finishedAt,
    requestedByUserId: userId,
  }
}

async function storeSearch(
  trackId: string,
  title: string,
  candidates: SpotifyTrackSearchCandidate[],
) {
  const search = savedSearch(trackId, title)
  await fixture.insert(schema.scrapeJob).values({
    ...search,
    options: { ...search.options, resultCount: candidates.length },
  })
  await fixture.insert(schema.scrapeJobLog).values({
    id: `${search.id}-log`,
    jobId: search.id,
    level: 'success',
    message: 'Fixture search completed',
    metadata: {
      diagnostics: [
        {
          kind: SPOTIFY_TRACK_SEARCH_TASK,
          query: search.options.query ?? '',
          candidates,
        },
      ],
    },
  })
}

it('previews and links the first eligible saved Spotify results offline and preserves manual choices on replay', async () => {
  await lastfmTrack('exact', 'Fixture Recording')
  await lastfmTrack('ranked', 'Fixture Versions')
  await lastfmTrack('manual', 'Fixture Split', true)
  const exact = catalogCandidate('Fixture Recording', '1')
  const firstExact = catalogCandidate('Fixture Versions', '9')
  const laterExact = catalogCandidate('Fixture Versions', '2')
  await storeSearch('exact', exact.title, [exact])
  await storeSearch('ranked', firstExact.title, [
    catalogCandidate('Fixture Versions (Live)', '3'),
    firstExact,
    laterExact,
  ])
  await storeSearch('manual', 'Fixture Split', [
    catalogCandidate('Fixture Split', '4'),
  ])
  await storeSearch('missing', 'Fixture Removed', [
    catalogCandidate('Fixture Removed', '5'),
  ])

  const preview = await backfillSpotifyTrackSearches()
  expect(preview).toMatchObject({
    apply: false,
    scanned: 4,
    wouldMatch: 2,
    linked: 0,
    stale: 1,
  })
  expect(preview.unmatched).toBe(1)
  const tracksAfterPreview = await fixture.select().from(schema.libraryTrack)
  expect(tracksAfterPreview).toHaveLength(3)
  expect(
    tracksAfterPreview.every((track) => track.spotifyTrackId === null),
  ).toBe(true)
  const jobsAfterPreview = await fixture.select().from(schema.scrapeJob)
  expect(
    jobsAfterPreview.every(
      (job) => job.options.acceptedSpotifyTrackId === undefined,
    ),
  ).toBe(true)

  expect(await backfillSpotifyTrackSearches(true)).toEqual({
    ...preview,
    apply: true,
    wouldMatch: 0,
    linked: 2,
  })
  const [accepted] = await fixture
    .select()
    .from(schema.scrapeJob)
    .where(eq(schema.scrapeJob.id, 'exact-search'))
  expect(accepted?.options.acceptedSpotifyTrackId).toBe(exact.spotifyTrackId)
  expect(accepted?.options.matchMethod).toBe('automatic')
  const [linkedTrack] = await fixture
    .select()
    .from(schema.libraryTrack)
    .where(eq(schema.libraryTrack.spotifyTrackId, exact.spotifyTrackId))
  expect(accepted?.options.acceptedTrackId).toBe(linkedTrack?.mediaItemId)
  const [ranked] = await fixture
    .select()
    .from(schema.scrapeJob)
    .where(eq(schema.scrapeJob.id, 'ranked-search'))
  const [rankedTrack] = await fixture
    .select()
    .from(schema.libraryTrack)
    .where(eq(schema.libraryTrack.spotifyTrackId, firstExact.spotifyTrackId))
  expect(ranked?.options).toMatchObject({
    acceptedSpotifyTrackId: firstExact.spotifyTrackId,
    acceptedTrackId: rankedTrack?.mediaItemId,
    matchMethod: 'automatic',
  })
  expect(rankedTrack).toBeDefined()
  expect(await fixture.select().from(schema.lastfmTrackSource)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        trackKey: exact.title.toLowerCase(),
        trackMediaItemId: linkedTrack?.mediaItemId,
      }),
      expect.objectContaining({
        trackKey: firstExact.title.toLowerCase(),
        trackMediaItemId: rankedTrack?.mediaItemId,
      }),
      expect.objectContaining({
        trackMediaItemId: 'manual',
        manuallyMatched: true,
      }),
    ]),
  )

  expect(await backfillSpotifyTrackSearches(true)).toEqual({
    ...preview,
    apply: true,
    scanned: 2,
    wouldMatch: 0,
  })
  const jobsAfterReplay = await fixture.select().from(schema.scrapeJob)
  expect(jobsAfterReplay).toHaveLength(4)
  expect(jobsAfterReplay.find(({ id }) => id === 'ranked-search')).toEqual(
    ranked,
  )
  const tracksAfterReplay = await fixture.select().from(schema.libraryTrack)
  expect(tracksAfterReplay.map(({ spotifyTrackId }) => spotifyTrackId)).toEqual(
    expect.arrayContaining([
      exact.spotifyTrackId,
      firstExact.spotifyTrackId,
      null,
    ]),
  )
  expect(tracksAfterReplay).toHaveLength(3)
  expect(request).not.toHaveBeenCalled()
})

it('pages over latest owner jobs and lets newer queued, failed or accepted searches supersede older results', async () => {
  await lastfmTrack('superseded-queued', 'Queued Fixture')
  await storeSearch('superseded-queued', 'Queued Fixture', [
    catalogCandidate('Queued Fixture', '6'),
  ])
  const jobs = Array.from({ length: 101 }, (_, index) =>
    savedSearch(
      `missing-${index.toString().padStart(3, '0')}`,
      'Missing Fixture',
    ),
  )
  const queued = savedSearch('superseded-queued', 'Queued Fixture', 'zz-queued')
  const failed = savedSearch('superseded-failed', 'Failed Fixture', 'zz-failed')
  const accepted = savedSearch(
    'superseded-accepted',
    'Accepted Fixture',
    'zz-accepted',
  )
  await fixture.insert(schema.scrapeJob).values([
    ...jobs,
    savedSearch('superseded-failed', 'Failed Fixture'),
    savedSearch('superseded-accepted', 'Accepted Fixture'),
    {
      ...queued,
      requestedByUserId: otherUserId,
      status: 'queued',
      finishedAt: null,
    },
    { ...failed, status: 'failed' },
    {
      ...accepted,
      options: { ...accepted.options, acceptedTrackId: 'retained-fixture' },
    },
    {
      ...savedSearch('anonymous', 'Anonymous Fixture'),
      requestedByUserId: null,
    },
    {
      ...savedSearch('other-provider', 'Other Provider Fixture'),
      provider: 'lastfm',
    },
  ])
  const { reconcileSavedSpotifyTrackSearch } =
    await import('@/services/spotify-track-search-acceptance')
  expect(
    await reconcileSavedSpotifyTrackSearch({
      jobId: 'superseded-queued-search',
      trackId: 'superseded-queued',
      userId,
    }),
  ).toEqual({ status: 'stale' })
  expect(await backfillSpotifyTrackSearches()).toEqual({
    apply: false,
    scanned: 101,
    stale: 101,
    unmatched: 0,
    wouldMatch: 0,
    linked: 0,
  })
  expect(request).not.toHaveBeenCalled()
})
