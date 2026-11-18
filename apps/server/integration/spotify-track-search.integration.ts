import '@hono/zod-openapi'
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { TrackMatchDiagnosticsQuerySchema } from '@repo/schemas/match-diagnostics'
import {
  SPOTIFY_TRACK_SEARCH_TASK,
  SpotifyTrackSearchTargetConflictSchema,
  type SpotifyTrackSearchFreshness,
} from '@repo/schemas/spotify-track-search'
import { env } from '@/env'
import { encryptSecretValue } from '@/lib/crypto'
import { spotifyPlugin } from '@/plugins/builtin/spotify'
import { spotifyTokenFixture } from '@/plugins/builtin/__tests__/fixtures/spotify'
import * as schema from '@/schemas/db'

const database = `spotify_track_search_${randomUUID().replaceAll('-', '')}`
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
const userId = 'fixture-owner'
const otherUserId = 'fixture-other'
const recordingId = 'fixture-track'
const candidateId = 'catalogtrack0000000000'
const otherCandidateId = 'catalogtrack0000000001'
const title = 'Night Signal: Live'
const artistName = 'Example Artist'
let market: string | undefined
let clientSecret: string | undefined
const catalogTrack = {
  type: 'track',
  id: candidateId,
  name: title,
  duration_ms: 174000,
  artists: [{ id: 'catalogartist000000000', name: artistName }],
  album: {
    id: 'catalogalbum0000000000',
    name: 'Example Album',
    images: [{ url: 'https://i.scdn.co/image/fixture' }],
  },
  external_ids: { isrc: 'aa-fi1-20-00001' },
}
const otherEdition = {
  ...catalogTrack,
  id: otherCandidateId,
  album: {
    ...catalogTrack.album,
    id: 'catalogalbum0000000001',
    name: 'The Other Edition',
  },
}
const searchBody = {
  tracks: { offset: 0, items: [catalogTrack, { type: 'track', id: null }] },
}

vi.mock('@/lib/db', () => ({
  get db() {
    return fixture
  },
}))
vi.mock('@/lib/auth', () => ({
  auth: {
    api: {
      async getSession({ headers }: { headers: Headers }) {
        if (!headers.has('cookie')) return null
        return {
          user: { id: userId, email: 'owner@example.test' },
          session: { userId },
        }
      },
    },
  },
}))
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async (id: string) =>
    id === 'spotify' ? spotifyPlugin : null,
  listLoadedScrapePlugins: async () => [spotifyPlugin],
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({
    clientId: 'fixture-client',
    redirectUri: 'https://fixture.example.test/api/v1/spotify/callback',
    ...(clientSecret === undefined ? {} : { clientSecret }),
    ...(market === undefined ? {} : { market }),
  }),
}))

import {
  bulkCancelJobs,
  getJob,
  getJobActivity,
  listJobs,
  processQueuedJobs,
  retryJob,
} from '@/services/jobs'
import { listJobEntries } from '@/services/job-entries'
import { refreshTrackLinks } from '@/services/track-links'
import { removeScrobbleTrackMatch } from '@/services/track-merges'
import { listTrackMatchDiagnostics } from '@/services/track-match-diagnostics'
import { getTrackDetail } from '@/services/tracks'
import {
  acceptSpotifyTrackSearch,
  reconcileSavedSpotifyTrackSearch,
} from '@/services/spotify-track-search-acceptance'
import {
  getSpotifyTrackSearch,
  listSpotifyTrackSearchStatuses,
  queueSpotifyTrackSearches,
  readSpotifyTrackSearchCandidate,
} from '@/services/spotify-track-search'

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
  await fixture.insert(schema.user).values([
    { id: userId, name: 'Fixture Owner', email: 'owner@example.test' },
    { id: otherUserId, name: 'Other Fixture', email: 'other@example.test' },
  ])
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})
beforeEach(async () => {
  market = 'AU'
  clientSecret = 'fixture-secret'
  request.mockReset()
  request.mockImplementation(async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'accounts.spotify.com')
      return Response.json(spotifyTokenFixture)
    if (
      url.origin === 'https://api.spotify.com' &&
      url.pathname === '/v1/search'
    )
      return Response.json(searchBody)
    throw new Error('Unexpected offline provider request')
  })
  await fixture.delete(schema.scrapeJob)
  await fixture.delete(schema.lastfmScrobble)
  await fixture.delete(schema.track)
  await fixture.delete(schema.mediaItem)
  await fixture.delete(schema.artist)
  await fixture.delete(schema.providerRequestState)
  await fixture.delete(schema.providerRequestEvent)
  await fixture.delete(schema.providerSecret)
  await fixture
    .insert(schema.artist)
    .values({ id: 'fixture-artist', name: artistName })
  await addTrack(recordingId, title)
})

async function addTrack(id: string, name: string, spotifyTrackId?: string) {
  await fixture.insert(schema.mediaItem).values({
    id,
    slug: id,
    title: name,
    mediaType: 'track',
    sourceLabel: 'album',
  })
  await fixture
    .insert(schema.libraryTrack)
    .values({ mediaItemId: id, spotifyTrackId })
  await fixture
    .insert(schema.mediaCredit)
    .values({ mediaItemId: id, artistId: 'fixture-artist', role: 'artist' })
}

async function queueOne(freshness?: SpotifyTrackSearchFreshness) {
  await queueSpotifyTrackSearches(
    { trackIds: [recordingId], batchId: 'fixture-batch', freshness },
    userId,
  )
  const [job] = (await listJobs({ mediaType: 'track' })).items
  if (!job) throw new Error('Expected a queued Spotify track search')
  return job
}

async function connectFixtureSpotifyAccount() {
  const ownerHash = createHash('sha256').update(userId).digest('hex')
  await fixture.insert(schema.providerSecret).values({
    id: 'fixture-spotify-tokens',
    provider: `spotify-account-${ownerHash}`,
    key: 'tokens',
    encryptedValue: encryptSecretValue(
      JSON.stringify({
        accessToken: 'fixture-owner-token',
        refreshToken: 'fixture-refresh-token',
        expiresAt: Date.now() + 3600 * 1000,
        scope: 'user-library-read',
        clientId: 'fixture-client',
      }),
    ),
    lastUpdatedByUserId: userId,
  })
}

function mockCandidates(...items: (typeof catalogTrack)[]) {
  request.mockImplementationOnce(async () => Response.json(spotifyTokenFixture))
  request.mockImplementationOnce(async () =>
    Response.json({ tracks: { items, offset: 0 } }),
  )
}

it('queues explicit tracks once across concurrent selections and keeps the batch in Tracks Jobs', async () => {
  const second = 'fixture-second'
  const covered = 'fixture-covered'
  await addTrack(second, 'Second Recording')
  await addTrack(covered, 'Already Covered', candidateId)
  const results = await Promise.all([
    queueSpotifyTrackSearches(
      {
        trackIds: [recordingId, second, covered, 'missing', recordingId],
        batchId: 'fixture-batch',
      },
      userId,
    ),
    queueSpotifyTrackSearches(
      { trackIds: [second], batchId: 'fixture-batch' },
      userId,
    ),
  ])
  expect(results.reduce((total, result) => total + result.queued, 0)).toBe(2)
  expect(results.reduce((total, result) => total + result.skipped, 0)).toBe(4)
  expect((await listJobs({ mediaType: 'album' })).items).toEqual([])
  expect(
    (await listJobs({ mediaType: 'track', q: 'night signal' })).items,
  ).toMatchObject([
    {
      scope: { mediaType: 'track', mediaItemIds: [recordingId] },
      options: { task: SPOTIFY_TRACK_SEARCH_TASK, trackId: recordingId },
      items: [],
    },
  ])
  expect((await listJobEntries({ mediaType: 'track' })).items).toMatchObject([
    { kind: 'batch', batchId: 'fixture-batch', mediaType: 'track', total: 2 },
  ])
  expect(
    (await getJobActivity()).libraries.find(
      (entry) => entry.mediaType === 'track',
    ),
  ).toMatchObject({ queued: 2, running: 0, failed: 0 })
  expect(
    (
      await listSpotifyTrackSearchStatuses(
        { trackIds: [recordingId, covered] },
        userId,
      )
    ).items,
  ).toMatchObject([
    {
      trackId: recordingId,
      job: { status: 'queued' },
      lastAttemptAt: null,
      lastSuccessfulAt: null,
    },
    { trackId: covered, job: null },
  ])
  expect(request).not.toHaveBeenCalled()
})

it('links an exact catalog result at completion and keeps the saved results', async () => {
  await fixture
    .update(schema.mediaItem)
    .set({ title: 'night  signal: LIVE' })
    .where(eq(schema.mediaItem.id, recordingId))
  const job = await queueOne()
  await processQueuedJobs()
  const url = new URL(String(request.mock.calls[1]?.[0]))
  expect(request).toHaveBeenCalledTimes(2)
  expect(url.searchParams.get('q')).toBe(
    'track:"night signal LIVE" artist:"Example Artist"',
  )
  expect(url.searchParams.get('type')).toBe('track')
  expect(url.searchParams.get('limit')).toBe('10')
  expect(url.searchParams.get('market')).toBe('AU')

  const stored = await getSpotifyTrackSearch(recordingId, userId)
  expect(stored).toMatchObject({
    job: {
      jobId: job.id,
      status: 'succeeded',
      resultCount: 1,
      acceptedTrackId: recordingId,
      matchMethod: 'automatic',
    },
    candidates: [
      {
        spotifyTrackId: candidateId,
        title,
        artists: [artistName],
        artistCredits: [{ id: 'catalogartist000000000', name: artistName }],
        albumName: 'Example Album',
        spotifyAlbumId: 'catalogalbum0000000000',
        artworkUrl: 'https://i.scdn.co/image/fixture',
        durationSec: 174,
        isrc: 'AA-FI1-20-00001',
        spotifyUrl: `https://open.spotify.com/track/${candidateId}`,
      },
    ],
  })
  expect(
    (await listSpotifyTrackSearchStatuses({ trackIds: [recordingId] }, userId))
      .items,
  ).toMatchObject([
    {
      trackId: recordingId,
      lastAttemptAt: stored.job?.startedAt,
      lastSuccessfulAt: stored.job?.finishedAt,
    },
  ])
  expect(await getSpotifyTrackSearch(recordingId, otherUserId)).toMatchObject({
    job: null,
    candidates: [],
  })
  const selection = {
    trackId: recordingId,
    jobId: job.id,
    spotifyTrackId: candidateId,
    userId,
  }
  expect(
    await fixture.transaction((tx) =>
      readSpotifyTrackSearchCandidate(tx, selection),
    ),
  ).toEqual(stored.candidates[0])
  await expect(
    fixture.transaction((tx) =>
      readSpotifyTrackSearchCandidate(tx, {
        ...selection,
        userId: otherUserId,
      }),
    ),
  ).rejects.toMatchObject({ response: { statusCode: 409 } })
  expect(
    await queueSpotifyTrackSearches(
      { trackIds: [recordingId], batchId: 'fixture-batch' },
      userId,
    ),
  ).toMatchObject({ queued: 0, skipped: 1 })
  expect(await fixture.select().from(schema.libraryTrack)).toMatchObject([
    { mediaItemId: recordingId, spotifyTrackId: candidateId },
  ])
  expect(await reconcileSavedSpotifyTrackSearch(selection)).toEqual({
    status: 'stale',
  })
  expect(await acceptSpotifyTrackSearch(selection)).toEqual({
    targetId: recordingId,
  })
  expect(
    (await getSpotifyTrackSearch(recordingId, userId)).job?.matchMethod,
  ).toBe('automatic')
  expect(request).toHaveBeenCalledTimes(2)
})

it.each([
  {
    reason: 'another artist',
    candidate: {
      ...catalogTrack,
      artists: [{ id: 'anotherartist000000000', name: 'Another Artist' }],
    },
  },
  {
    reason: 'an additional billed artist',
    candidate: {
      ...catalogTrack,
      artists: [
        ...catalogTrack.artists,
        { id: 'anotherartist000000000', name: 'Another Artist' },
      ],
    },
  },
  {
    reason: 'a radio edit',
    candidate: { ...catalogTrack, name: `${title} (Radio Edit)` },
  },
  {
    reason: 'a different punctuation mark',
    candidate: { ...catalogTrack, name: title.replace(':', '-') },
  },
])(
  'keeps a catalog result for $reason available for review',
  async ({ candidate }) => {
    mockCandidates(candidate)
    const job = await queueOne()
    await processQueuedJobs()

    expect(await getSpotifyTrackSearch(recordingId, userId)).toMatchObject({
      job: { jobId: job.id, status: 'succeeded', resultCount: 1 },
      candidates: [{ spotifyTrackId: candidateId }],
    })
    expect(
      (await getSpotifyTrackSearch(recordingId, userId)).job?.acceptedTrackId,
    ).toBeUndefined()
    expect(await fixture.select().from(schema.libraryTrack)).toMatchObject([
      { mediaItemId: recordingId, spotifyTrackId: null },
    ])
    await queueSpotifyTrackSearches({ trackIds: [recordingId] }, userId)
    const selection = {
      trackId: recordingId,
      jobId: job.id,
      spotifyTrackId: candidateId,
      userId,
    }
    await expect(
      fixture.transaction((tx) =>
        readSpotifyTrackSearchCandidate(tx, selection),
      ),
    ).rejects.toMatchObject({ response: { statusCode: 409 } })
  },
)

async function addListedRecording(spotifyTrackId?: string) {
  const albumId = 'fixture-catalog-release'
  const trackId = 'fixture-album-recording'
  await fixture.insert(schema.mediaItem).values({
    id: albumId,
    slug: albumId,
    title: catalogTrack.album.name,
    mediaType: 'album',
  })
  await fixture.insert(schema.album).values({
    mediaItemId: albumId,
    spotifyUrl: `https://open.spotify.com/album/${catalogTrack.album.id}`,
  })
  await addTrack(trackId, title, spotifyTrackId)
  await fixture
    .update(schema.libraryTrack)
    .set({
      albumMediaItemId: albumId,
      albumLinkStrategy: 'album-track-list',
      durationSec: 174,
    })
    .where(eq(schema.libraryTrack.mediaItemId, trackId))
  await fixture.insert(schema.track).values({
    id: 'fixture-release-position',
    title,
    albumMediaItemId: albumId,
    trackMediaItemId: trackId,
    position: 2,
    externalId: spotifyTrackId,
    durationSec: 174,
  })
  return { albumId, trackId }
}

async function addScrobbledRecording(
  albums: string[] = [],
  recordedTitle = title,
) {
  const username = 'fixture-listener'
  const scrobble = {
    id: 'fixture-listen',
    username,
    listenedAt: new Date('2025-01-02T00:00:00Z'),
    artistName,
    artistKey: artistName.toLowerCase(),
    trackName: recordedTitle,
    trackKey: recordedTitle.toLowerCase(),
  }
  await fixture
    .delete(schema.mediaItem)
    .where(eq(schema.mediaItem.id, recordingId))
  const scrobbles = albums.length
    ? albums.map((album, index) => ({
        ...scrobble,
        id: `fixture-listen-${index}`,
        listenedAt: new Date(scrobble.listenedAt.getTime() + index * 1000),
        albumName: album,
        albumKey: album.toLowerCase(),
      }))
    : [scrobble]
  await fixture.insert(schema.lastfmScrobble).values(scrobbles)
  await refreshTrackLinks(username)
  const [source] = await fixture.select().from(schema.lastfmTrackSource)
  if (!source) throw new Error('Expected a Last.fm recording')
  return { source, scrobble, scrobbles, username }
}

async function confirmStoredSpotifyCandidate(trackId: string) {
  const search = await getSpotifyTrackSearch(trackId, userId)
  expect(search.job).toMatchObject({ status: 'succeeded', resultCount: 1 })
  expect(search.job?.acceptedTrackId).toBeUndefined()
  const jobId = search.job?.jobId
  if (!jobId) throw new Error('Expected a saved Spotify search')
  const { default: app } = await import('@/app')
  request.mockClear()
  return app.request(`/api/v1/spotify/tracks/search/${trackId}/accept`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: 'session=fixture',
      origin: 'http://localhost:3000',
    },
    body: JSON.stringify({ jobId, spotifyTrackId: candidateId }),
  })
}

it.each([
  {
    reason: 'different recording and credits',
    targetTitle: 'Daylight Chimes',
    positionTitle: 'Daylight Chimes (Instrumental)',
    durationSec: 265,
    changeArtist: true,
  },
  { reason: 'unrelated billed artist', changeArtist: true },
  {
    reason: 'different native artist ID for the same credit',
    conflictingArtistId: 'anotherartist000000000',
  },
  {
    reason: 'different Spotify ID on the stored album position',
    positionSpotifyId: otherCandidateId,
  },
  { reason: 'different known ISRC', isrc: 'AA-FI1-20-00002' },
  {
    reason: 'radio edit position',
    positionTitle: 'Night Signal (Radio Edit)',
  },
  {
    reason: 'remix position',
    positionTitle: 'Night Signal - Example Remix',
  },
  {
    reason: 'studio title with live candidate',
    targetTitle: 'Night Signal',
  },
  {
    reason: 'missing display title',
    targetTitle: ' ',
    positionTitle: 'Daylight Chimes',
  },
  {
    reason: 'overlong display title',
    targetTitle: 'Alternate title '.repeat(40),
  },
])(
  'rejects manual confirmation with contradictory target evidence for $reason',
  async ({
    targetTitle = title,
    positionTitle = title,
    durationSec = 174,
    changeArtist,
    conflictingArtistId,
    positionSpotifyId,
    isrc,
  }) => {
    const { source } = await addScrobbledRecording([
      catalogTrack.album.name,
      catalogTrack.album.name,
    ])
    const sourceId = source.trackMediaItemId
    const { trackId: targetId } = await addListedRecording(candidateId)
    await fixture
      .update(schema.mediaItem)
      .set({
        title: targetTitle,
        ...(conflictingArtistId
          ? {
              metadata: {
                spotifyArtistCredits: [
                  { id: conflictingArtistId, name: artistName },
                ],
              },
            }
          : {}),
      })
      .where(eq(schema.mediaItem.id, targetId))
    await fixture
      .update(schema.libraryTrack)
      .set({ durationSec, isrc })
      .where(eq(schema.libraryTrack.mediaItemId, targetId))
    await fixture
      .update(schema.track)
      .set({ title: positionTitle, durationSec, externalId: positionSpotifyId })
      .where(eq(schema.track.trackMediaItemId, targetId))
    if (changeArtist) {
      await fixture
        .insert(schema.artist)
        .values({ id: 'second-fixture-artist', name: 'Second Fixture Artist' })
      await fixture
        .update(schema.mediaCredit)
        .set({ artistId: 'second-fixture-artist' })
        .where(eq(schema.mediaCredit.mediaItemId, targetId))
    }
    expect(
      await queueSpotifyTrackSearches({ trackIds: [sourceId] }, userId),
    ).toMatchObject({ queued: 1 })
    await processQueuedJobs()
    expect(request).toHaveBeenCalledTimes(2)

    const scrobbles = await fixture
      .select()
      .from(schema.lastfmScrobble)
      .orderBy(schema.lastfmScrobble.id)
    const names = await fixture.select().from(schema.lastfmTrackSource)
    const positions = await fixture.select().from(schema.track)
    const response = await confirmStoredSpotifyCandidate(sourceId)
    expect(response.status).toBe(409)
    const payload = z
      .object({ data: SpotifyTrackSearchTargetConflictSchema })
      .parse(await response.json())
    expect(payload.data).toEqual({
      code: 'spotify-track-target-conflict',
      trackId: targetId,
      title: targetTitle.trim().slice(0, 500).trimEnd() || 'Library track',
    })
    expect(
      await fixture
        .select()
        .from(schema.lastfmScrobble)
        .orderBy(schema.lastfmScrobble.id),
    ).toEqual(scrobbles)
    expect(await fixture.select().from(schema.lastfmTrackSource)).toEqual(names)
    expect(await fixture.select().from(schema.track)).toEqual(positions)
    expect(await getTrackDetail(sourceId)).toMatchObject({
      scrobbles: 2,
      spotifyTrackId: null,
    })
    expect(await getTrackDetail(targetId)).toMatchObject({
      scrobbles: 0,
      spotifyTrackId: candidateId,
    })
    expect(
      (await getSpotifyTrackSearch(sourceId, userId)).job?.acceptedTrackId,
    ).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
  },
)

it('confirms a manual alias with another stored alias, release variant and rounded duration on the retained track', async () => {
  const { source, username, scrobble } = await addScrobbledRecording(
    [catalogTrack.album.name],
    'The Signal on a Misty Night',
  )
  const { albumId, trackId: targetId } = await addListedRecording(candidateId)
  const sourceId = source.trackMediaItemId
  const targetTitle = 'Night Signal - Live (2019 Remaster)'
  await fixture
    .update(schema.mediaItem)
    .set({ title: targetTitle })
    .where(eq(schema.mediaItem.id, targetId))
  await fixture
    .update(schema.libraryTrack)
    .set({ durationSec: 175 })
    .where(eq(schema.libraryTrack.mediaItemId, targetId))
  await fixture
    .update(schema.track)
    .set({ title: targetTitle, durationSec: 175 })
    .where(eq(schema.track.trackMediaItemId, targetId))
  await fixture
    .update(schema.album)
    .set({
      spotifyUrl: `https://open.spotify.com/album/${otherEdition.album.id}`,
    })
    .where(eq(schema.album.mediaItemId, albumId))
  const priorName = {
    username,
    artistKey: scrobble.artistKey,
    trackKey: 'previous recording alias',
  }
  await fixture.insert(schema.lastfmScrobble).values({
    ...scrobble,
    ...priorName,
    id: 'previous-alias-scrobble',
    trackName: 'Previous Recording Alias',
    albumName: 'Previous Album Tag',
    albumKey: 'previous album tag',
  })
  await fixture
    .insert(schema.lastfmTrackSource)
    .values({ ...priorName, trackMediaItemId: targetId, manuallyMatched: true })
  await fixture
    .insert(schema.lastfmTrackLink)
    .values({ ...priorName, trackMediaItemId: targetId, strategy: 'manual' })
  await refreshTrackLinks(username)

  await queueSpotifyTrackSearches({ trackIds: [sourceId] }, userId)
  await processQueuedJobs()
  const scrobbles = await fixture
    .select()
    .from(schema.lastfmScrobble)
    .orderBy(schema.lastfmScrobble.id)
  const response = await confirmStoredSpotifyCandidate(sourceId)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ data: { targetId } })
  await refreshTrackLinks(username)
  expect(
    await fixture
      .select()
      .from(schema.lastfmTrackSource)
      .orderBy(schema.lastfmTrackSource.trackKey),
  ).toMatchObject([
    { ...priorName, trackMediaItemId: targetId, manuallyMatched: true },
    {
      trackKey: source.trackKey,
      trackMediaItemId: targetId,
      manuallyMatched: true,
    },
  ])
  expect(
    await fixture
      .select()
      .from(schema.lastfmScrobble)
      .orderBy(schema.lastfmScrobble.id),
  ).toEqual(scrobbles)
  expect(await getTrackDetail(targetId)).toMatchObject({
    title: targetTitle,
    scrobbles: 2,
    durationSec: 175,
    album: { id: albumId },
  })
  expect(await getTrackDetail(sourceId)).toBeNull()
  expect(request).not.toHaveBeenCalled()
})

it('links a standalone Last.fm name when one exact Spotify release supports its playback tags', async () => {
  const { source, scrobbles, username } = await addScrobbledRecording([
    catalogTrack.album.name,
    'Synthetic EP',
  ])
  await queueSpotifyTrackSearches(
    { trackIds: [source.trackMediaItemId] },
    userId,
  )
  await processQueuedJobs()
  const search = await getSpotifyTrackSearch(source.trackMediaItemId, userId)
  expect(search.job).toMatchObject({
    status: 'succeeded',
    resultCount: 1,
    matchMethod: 'automatic',
  })
  const targetId = search.job?.acceptedTrackId
  if (!targetId) throw new Error('Expected the retained Spotify recording')

  await refreshTrackLinks(username)
  expect(await fixture.select().from(schema.lastfmTrackSource)).toMatchObject([
    { trackMediaItemId: targetId, manuallyMatched: false },
  ])
  expect(await fixture.select().from(schema.libraryTrack)).toMatchObject([
    { mediaItemId: targetId, spotifyTrackId: candidateId, scrobbleCount: 2 },
  ])
  expect(await fixture.select().from(schema.lastfmScrobble)).toMatchObject(
    scrobbles,
  )
  const editedTitle = `${title} (Radio Edit)`
  await fixture.insert(schema.lastfmScrobble).values({
    id: 'fixture-radio-edit',
    username,
    artistName,
    artistKey: artistName.toLowerCase(),
    trackName: editedTitle,
    trackKey: editedTitle.toLowerCase(),
    listenedAt: new Date('2025-01-03T00:00:00Z'),
    albumName: catalogTrack.album.name,
    albumKey: catalogTrack.album.name.toLowerCase(),
  })
  await refreshTrackLinks(username)
  expect(await fixture.select().from(schema.lastfmTrackSource)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        trackKey: source.trackKey,
        trackMediaItemId: targetId,
      }),
      expect.objectContaining({
        trackKey: editedTitle.toLowerCase(),
        trackMediaItemId: expect.not.stringMatching(targetId),
      }),
    ]),
  )
  await removeScrobbleTrackMatch(targetId, {
    artistKey: source.artistKey,
    trackKey: source.trackKey,
    mode: 'separate',
  })
  await refreshTrackLinks(username)
  expect(
    await fixture
      .select()
      .from(schema.lastfmTrackSource)
      .where(eq(schema.lastfmTrackSource.trackKey, source.trackKey)),
  ).toMatchObject([
    { trackMediaItemId: source.trackMediaItemId, manuallyMatched: true },
  ])
  expect(await fixture.select().from(schema.lastfmScrobble)).toEqual(
    expect.arrayContaining(
      scrobbles.map((scrobble) => expect.objectContaining(scrobble)),
    ),
  )
  expect(request).toHaveBeenCalledTimes(2)
})

it.each([
  {
    reason: 'two observed releases with separate exact IDs',
    albums: [catalogTrack.album.name, otherEdition.album.name],
    candidates: [catalogTrack, otherEdition],
  },
  {
    reason: 'no observed release',
    albums: ['Fixture Single', 'Fixture EP'],
    candidates: [catalogTrack],
  },
  {
    reason: 'an unmatched live release',
    albums: [catalogTrack.album.name, 'Fixture Live Sessions'],
    candidates: [catalogTrack],
  },
  {
    reason: 'a different recording on the other observed release',
    albums: [catalogTrack.album.name, otherEdition.album.name],
    candidates: [catalogTrack, { ...otherEdition, name: `${title}: Acoustic` }],
  },
])(
  'keeps standalone album observations reviewable with $reason',
  async ({ albums, candidates }) => {
    const { source, scrobbles } = await addScrobbledRecording(albums)
    mockCandidates(...candidates)
    await queueSpotifyTrackSearches(
      { trackIds: [source.trackMediaItemId] },
      userId,
    )
    await processQueuedJobs()

    const search = await getSpotifyTrackSearch(source.trackMediaItemId, userId)
    expect(search.job).toMatchObject({
      status: 'succeeded',
      resultCount: candidates.length,
    })
    expect(search.job?.acceptedTrackId).toBeUndefined()
    expect(await fixture.select().from(schema.libraryTrack)).toMatchObject([
      { mediaItemId: source.trackMediaItemId, spotifyTrackId: null },
    ])
    expect(await fixture.select().from(schema.lastfmScrobble)).toMatchObject(
      scrobbles,
    )
  },
)

it('protects a concrete album association even when a raw album tag agrees with Spotify', async () => {
  const { source } = await addScrobbledRecording([
    catalogTrack.album.name,
    'Fixture EP',
  ])
  const { albumId, trackId } = await addListedRecording()
  await fixture
    .update(schema.album)
    .set({
      spotifyUrl: `https://open.spotify.com/album/${otherEdition.album.id}`,
    })
    .where(eq(schema.album.mediaItemId, albumId))
  await fixture
    .update(schema.track)
    .set({ trackMediaItemId: source.trackMediaItemId })
    .where(eq(schema.track.trackMediaItemId, trackId))
  await queueSpotifyTrackSearches(
    { trackIds: [source.trackMediaItemId] },
    userId,
  )
  await processQueuedJobs()
  expect(
    (await getSpotifyTrackSearch(source.trackMediaItemId, userId)).job
      ?.acceptedTrackId,
  ).toBeUndefined()
  expect(await fixture.select().from(schema.track)).toMatchObject([
    {
      albumMediaItemId: albumId,
      trackMediaItemId: source.trackMediaItemId,
      position: 2,
    },
  ])
})

it('keeps a retained Spotify recording with conflicting release evidence separate', async () => {
  const { source, scrobble } = await addScrobbledRecording([
    catalogTrack.album.name,
    'Fixture EP',
  ])
  const { trackId: retainedId, albumId } = await addListedRecording(candidateId)
  const username = 'other-fixture-listener'
  await fixture.insert(schema.lastfmTrackSource).values({
    username,
    artistKey: source.artistKey,
    trackKey: source.trackKey,
    trackMediaItemId: retainedId,
  })
  await fixture.insert(schema.lastfmScrobble).values({
    ...scrobble,
    username,
    albumName: 'Fixture EP',
    albumKey: 'fixture ep',
  })
  await queueSpotifyTrackSearches(
    { trackIds: [source.trackMediaItemId] },
    userId,
  )
  await processQueuedJobs()

  const { job } = await getSpotifyTrackSearch(source.trackMediaItemId, userId)
  expect(job).toMatchObject({ status: 'succeeded', resultCount: 1 })
  expect(job?.acceptedTrackId).toBeUndefined()
  expect(await fixture.select().from(schema.track)).toMatchObject([
    { albumMediaItemId: albumId, trackMediaItemId: retainedId, position: 2 },
  ])
  expect(await fixture.select().from(schema.lastfmTrackSource)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ trackMediaItemId: source.trackMediaItemId }),
      expect.objectContaining({ trackMediaItemId: retainedId }),
    ]),
  )
})

it('reconciles a saved standalone match with alternative album tags offline', async () => {
  const { source, scrobbles } = await addScrobbledRecording([
    catalogTrack.album.name,
    'Fixture EP',
  ])
  const trackId = source.trackMediaItemId
  await fixture
    .update(schema.libraryTrack)
    .set({ durationSec: 900 })
    .where(eq(schema.libraryTrack.mediaItemId, trackId))
  await queueSpotifyTrackSearches({ trackIds: [trackId] }, userId)
  await processQueuedJobs()
  const saved = (await getSpotifyTrackSearch(trackId, userId)).job
  if (!saved) throw new Error('Expected a completed Spotify search')
  expect(saved.acceptedTrackId).toBeUndefined()
  await fixture
    .update(schema.libraryTrack)
    .set({ durationSec: null })
    .where(eq(schema.libraryTrack.mediaItemId, trackId))
  request.mockClear()

  const selection = { trackId, jobId: saved.jobId, userId }
  expect(
    await reconcileSavedSpotifyTrackSearch(selection, { dryRun: true }),
  ).toMatchObject({ status: 'matched' })
  expect(await reconcileSavedSpotifyTrackSearch(selection)).toMatchObject({
    status: 'matched',
  })
  expect(await reconcileSavedSpotifyTrackSearch(selection)).toEqual({
    status: 'stale',
  })
  expect(await fixture.select().from(schema.lastfmScrobble)).toMatchObject(
    scrobbles,
  )
  expect(request).not.toHaveBeenCalled()
})

it.each([undefined, candidateId])(
  'reuses the exact album position for a Last.fm recording with existing Spotify ID %s',
  async (spotifyTrackId) => {
    const { source, scrobble, username } = await addScrobbledRecording()
    const { albumId, trackId } = await addListedRecording(spotifyTrackId)
    await queueSpotifyTrackSearches(
      { trackIds: [source.trackMediaItemId] },
      userId,
    )
    await processQueuedJobs()

    expect(
      await getSpotifyTrackSearch(source.trackMediaItemId, userId),
    ).toMatchObject({
      job: {
        status: 'succeeded',
        acceptedTrackId: trackId,
        matchMethod: 'automatic',
      },
    })
    expect(await fixture.select().from(schema.libraryTrack)).toMatchObject([
      {
        mediaItemId: trackId,
        albumMediaItemId: albumId,
        spotifyTrackId: candidateId,
        scrobbleCount: 1,
      },
    ])
    expect(await fixture.select().from(schema.track)).toMatchObject([
      { trackMediaItemId: trackId, albumMediaItemId: albumId, position: 2 },
    ])
    await refreshTrackLinks(username)
    expect(await fixture.select().from(schema.lastfmTrackSource)).toMatchObject(
      [{ trackMediaItemId: trackId, manuallyMatched: false }],
    )
    expect(await fixture.select().from(schema.lastfmScrobble)).toMatchObject([
      scrobble,
    ])
    expect(request).toHaveBeenCalledTimes(2)
  },
)

it('respects the explicit choice to keep a recorded name separate', async () => {
  const { source } = await addScrobbledRecording()
  await fixture
    .update(schema.lastfmTrackSource)
    .set({ manuallyMatched: true })
    .where(
      eq(schema.lastfmTrackSource.trackMediaItemId, source.trackMediaItemId),
    )
  await queueSpotifyTrackSearches(
    { trackIds: [source.trackMediaItemId] },
    userId,
  )
  await processQueuedJobs()

  expect(
    await getSpotifyTrackSearch(source.trackMediaItemId, userId),
  ).toMatchObject({
    job: { status: 'succeeded', resultCount: 1 },
  })
  expect(await fixture.select().from(schema.libraryTrack)).toMatchObject([
    { mediaItemId: source.trackMediaItemId, spotifyTrackId: null },
  ])
})

it('previews and applies a saved exact match offline, and respects newer searches', async () => {
  await fixture
    .update(schema.libraryTrack)
    .set({ durationSec: 144 })
    .where(eq(schema.libraryTrack.mediaItemId, recordingId))
  const job = await queueOne()
  await processQueuedJobs()
  expect(await fixture.select().from(schema.libraryTrack)).toMatchObject([
    { spotifyTrackId: null },
  ])
  await fixture
    .update(schema.libraryTrack)
    .set({ durationSec: 174 })
    .where(eq(schema.libraryTrack.mediaItemId, recordingId))
  await fixture
    .update(schema.scrapeJob)
    .set({ options: sql`${schema.scrapeJob.options} - 'trackArtists'` })
    .where(eq(schema.scrapeJob.id, job.id))
  request.mockClear()
  const selection = { trackId: recordingId, jobId: job.id, userId }
  expect(
    await reconcileSavedSpotifyTrackSearch({
      ...selection,
      userId: otherUserId,
    }),
  ).toEqual({
    status: 'stale',
  })
  expect(
    await reconcileSavedSpotifyTrackSearch(selection, { dryRun: true }),
  ).toEqual({
    status: 'matched',
    targetId: recordingId,
  })
  expect(await fixture.select().from(schema.libraryTrack)).toMatchObject([
    { spotifyTrackId: null },
  ])
  await queueSpotifyTrackSearches({ trackIds: [recordingId] }, otherUserId)
  expect(await reconcileSavedSpotifyTrackSearch(selection)).toEqual({
    status: 'stale',
  })
  expect(await fixture.select().from(schema.libraryTrack)).toMatchObject([
    { spotifyTrackId: null },
  ])
  await fixture
    .delete(schema.scrapeJob)
    .where(eq(schema.scrapeJob.requestedByUserId, otherUserId))
  expect(await reconcileSavedSpotifyTrackSearch(selection)).toEqual({
    status: 'matched',
    targetId: recordingId,
  })
  expect(await reconcileSavedSpotifyTrackSearch(selection)).toEqual({
    status: 'stale',
  })
  expect(await fixture.select().from(schema.libraryTrack)).toMatchObject([
    { spotifyTrackId: candidateId },
  ])
  expect(request).not.toHaveBeenCalled()
})

it.each([false, true])(
  'requires known release evidence to select among exact editions (known release = %s)',
  async (knownRelease) => {
    if (knownRelease)
      await fixture
        .update(schema.libraryTrack)
        .set({
          spotifyAlbumId: otherEdition.album.id,
          albumName: 'An older release title',
        })
        .where(eq(schema.libraryTrack.mediaItemId, recordingId))
    mockCandidates(catalogTrack, otherEdition)
    const job = await queueOne()
    await processQueuedJobs()

    expect(await getSpotifyTrackSearch(recordingId, userId)).toMatchObject({
      job: { jobId: job.id, status: 'succeeded', resultCount: 2 },
      candidates: [
        { spotifyTrackId: candidateId },
        { spotifyTrackId: otherCandidateId },
      ],
    })
    expect(await fixture.select().from(schema.libraryTrack)).toMatchObject([
      {
        mediaItemId: recordingId,
        spotifyTrackId: knownRelease ? otherCandidateId : null,
      },
    ])
  },
)

it('skips a recording that gains a Spotify ID while queued', async () => {
  const job = await queueOne()
  await fixture
    .update(schema.libraryTrack)
    .set({ spotifyTrackId: candidateId })
    .where(eq(schema.libraryTrack.mediaItemId, recordingId))
  await processQueuedJobs()
  expect(await getJob(job.id)).toMatchObject({
    status: 'succeeded',
    summary: { headline: expect.stringMatching(/^Search skipped/) },
  })
  expect(
    (await listSpotifyTrackSearchStatuses({ trackIds: [recordingId] }, userId))
      .items,
  ).toMatchObject([
    {
      trackId: recordingId,
      job: { status: 'succeeded', resultCount: null },
      lastAttemptAt: null,
      lastSuccessfulAt: null,
    },
  ])
  expect(request).not.toHaveBeenCalled()
})

it.each([
  ['lastfm', '02 - Night Signal (Radio Edit)', 'Night Signal (Radio Edit)'],
  ['lastfm', '99 Red Balloons', '99 Red Balloons'],
  ['lastfm', '1979 - Radio Edit', '1979 - Radio Edit'],
  ['album', '02 - Night Signal (Radio Edit)', '02 - Night Signal (Radio Edit)'],
])(
  'uses the conservative numbered-title query for %s recording %s',
  async (sourceLabel, storedTitle, searchedTitle) => {
    await fixture
      .update(schema.mediaItem)
      .set({ title: storedTitle, sourceLabel })
      .where(eq(schema.mediaItem.id, recordingId))
    const job = await queueOne()
    expect(job.options.trackTitle).toBe(storedTitle)
    await processQueuedJobs()

    const url = new URL(String(request.mock.calls[1]?.[0]))
    expect(url.searchParams.get('q')).toBe(
      `track:"${searchedTitle}" artist:"${artistName}"`,
    )
    expect(await getSpotifyTrackSearch(recordingId, userId)).toMatchObject({
      job: { jobId: job.id, status: 'succeeded', resultCount: 1 },
      candidates: [{ spotifyTrackId: candidateId }],
    })
    expect(await fixture.select().from(schema.libraryTrack)).toMatchObject([
      { mediaItemId: recordingId, spotifyTrackId: null },
    ])
  },
)

it('records a real zero-result search as a successful attempt', async () => {
  const job = await queueOne()
  request.mockImplementationOnce(async () => Response.json(spotifyTokenFixture))
  request.mockImplementationOnce(async () =>
    Response.json({ tracks: { items: [], offset: 0 } }),
  )
  await processQueuedJobs()
  expect(await getSpotifyTrackSearch(recordingId, userId)).toMatchObject({
    job: { jobId: job.id, status: 'succeeded', resultCount: 0 },
    candidates: [],
  })
  expect(await fixture.select().from(schema.libraryTrack)).toMatchObject([
    { mediaItemId: recordingId, spotifyTrackId: null },
  ])
  expect(
    (await listSpotifyTrackSearchStatuses({ trackIds: [recordingId] }, userId))
      .items,
  ).toMatchObject([
    {
      trackId: recordingId,
      lastAttemptAt: expect.any(String),
      lastSuccessfulAt: expect.any(String),
    },
  ])
  expect(request).toHaveBeenCalledTimes(2)
})

it.each([
  { is_playable: false },
  { restrictions: { reason: 'market' } },
  { restrictions: { reason: 'future-restriction' } },
])(
  'leaves an explicitly unavailable exact catalog track unlinked (%j)',
  async (availability) => {
    mockCandidates({ ...catalogTrack, ...availability })
    const job = await queueOne()
    await processQueuedJobs()

    expect(await getSpotifyTrackSearch(recordingId, userId)).toMatchObject({
      job: { jobId: job.id, status: 'succeeded', resultCount: 0 },
      candidates: [],
    })
    expect(await fixture.select().from(schema.libraryTrack)).toMatchObject([
      { mediaItemId: recordingId, spotifyTrackId: null },
    ])
  },
)

it('accepts an explicit market over the API when only app credentials are configured', async () => {
  market = undefined
  const { default: app } = await import('@/app')
  const queue = (market?: string) =>
    app.request('/api/v1/spotify/tracks/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'session=fixture',
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ trackIds: [recordingId], market }),
    })

  const missing = await queue()
  expect(missing.status).toBe(422)
  expect(await missing.json()).toMatchObject({
    message: expect.stringContaining('Set Spotify Market in Providers'),
  })
  expect((await queue('au')).status).toBe(422)
  expect(await fixture.select().from(schema.scrapeJob)).toHaveLength(0)
  expect(request).not.toHaveBeenCalled()

  const queued = await queue('AU')
  expect(queued.status).toBe(200)
  expect(await queued.json()).toMatchObject({ data: { queued: 1 } })
  const [job] = (await listJobs({ mediaType: 'track' })).items
  if (!job) throw new Error('Expected a queued Spotify track search')
  expect(job.options.market).toBe('AU')
  await bulkCancelJobs({ jobIds: [job.id], confirmRunning: false }, userId)
  const retried = await retryJob(job.id, userId, false)
  expect(retried.options.market).toBe('AU')
  expect(request).not.toHaveBeenCalled()

  await processQueuedJobs()
  expect(request).toHaveBeenCalledTimes(2)
  expect(
    new URL(String(request.mock.calls[1]?.[0])).searchParams.get('market'),
  ).toBe('AU')
  expect(await getSpotifyTrackSearch(recordingId, userId)).toMatchObject({
    job: { jobId: retried.id, status: 'succeeded', matchMethod: 'automatic' },
  })
  expect(await fixture.select().from(schema.providerSecret)).toHaveLength(0)
})

it('keeps the configured market ahead of the requested fallback', async () => {
  await queueSpotifyTrackSearches(
    { trackIds: [recordingId], market: 'NZ' },
    userId,
  )
  await processQueuedJobs()
  expect(request).toHaveBeenCalledTimes(2)
  expect(
    new URL(String(request.mock.calls[1]?.[0])).searchParams.get('market'),
  ).toBe('AU')
})

it('keeps the connected account ahead of the requested fallback market', async () => {
  market = undefined
  await connectFixtureSpotifyAccount()
  await queueSpotifyTrackSearches(
    { trackIds: [recordingId], market: 'NZ' },
    userId,
  )
  await processQueuedJobs()
  expect(request).toHaveBeenCalledTimes(1)
  const [input, init] = request.mock.calls[0] ?? []
  expect(new URL(String(input)).searchParams.get('market')).toBeNull()
  expect(new Headers(init?.headers).get('authorization')).toBe(
    'Bearer fixture-owner-token',
  )
})

it.each([undefined, 'AU'])(
  'asks for missing credentials before a search with market %s',
  async (requestedMarket) => {
    market = undefined
    clientSecret = undefined
    await expect(
      queueSpotifyTrackSearches(
        { trackIds: [recordingId], market: requestedMarket },
        userId,
      ),
    ).rejects.toMatchObject({
      response: {
        statusCode: 422,
        message: expect.stringContaining('Configure Spotify Client ID'),
      },
    })
    expect(await fixture.select().from(schema.scrapeJob)).toHaveLength(0)
    expect(request).not.toHaveBeenCalled()
  },
)

it.each([undefined, 'AU'])(
  'uses a connected Spotify account with market %s when client credentials are unavailable',
  async (configuredMarket) => {
    market = configuredMarket
    clientSecret = undefined
    await expect(
      queueSpotifyTrackSearches({ trackIds: [recordingId] }, userId),
    ).rejects.toMatchObject({
      response: {
        statusCode: 422,
        message: expect.stringContaining('Configure Spotify Client ID'),
      },
    })
    expect(await fixture.select().from(schema.scrapeJob)).toHaveLength(0)
    expect(request).not.toHaveBeenCalled()

    await connectFixtureSpotifyAccount()
    const job = await queueOne()
    expect(request).not.toHaveBeenCalled()
    await processQueuedJobs()

    expect(request).toHaveBeenCalledTimes(1)
    const [input, init] = request.mock.calls[0] ?? []
    expect(new URL(String(input)).searchParams.get('market')).toBe(
      configuredMarket ?? null,
    )
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer fixture-owner-token',
    )
    expect(await getSpotifyTrackSearch(recordingId, userId)).toMatchObject({
      job: { jobId: job.id, status: 'succeeded', resultCount: 1 },
    })
  },
)

it.each(['cancelled', 'covered'])(
  'honours a search becoming %s while the provider request is in flight',
  async (change) => {
    const job = await queueOne([{ provider: 'spotify', mode: 'never' }])
    let finishSearch: (response: Response) => void = () => {
      throw new Error('Search has not started')
    }
    const response = new Promise<Response>((resolve) => {
      finishSearch = resolve
    })
    let startSearch: () => void = () => {}
    const searching = new Promise<void>((resolve) => {
      startSearch = resolve
    })
    request.mockImplementationOnce(async () =>
      Response.json(spotifyTokenFixture),
    )
    request.mockImplementationOnce(async () => {
      startSearch()
      return response
    })
    const processing = processQueuedJobs()
    await Promise.race([
      searching,
      processing.then(() => {
        throw new Error('The job finished before the search request')
      }),
    ])
    try {
      if (change === 'cancelled')
        await bulkCancelJobs({ jobIds: [job.id], confirmRunning: true }, userId)
      else
        await fixture
          .update(schema.libraryTrack)
          .set({ spotifyTrackId: otherCandidateId })
          .where(eq(schema.libraryTrack.mediaItemId, recordingId))
    } finally {
      finishSearch(Response.json(searchBody))
      await processing
    }
    const search = await getSpotifyTrackSearch(recordingId, userId)
    expect(search.job?.acceptedTrackId).toBeUndefined()
    if (change === 'cancelled') {
      expect(search).toMatchObject({
        job: { jobId: job.id, status: 'cancelled', resultCount: null },
        candidates: [],
      })
      expect((await retryJob(job.id, userId, false)).status).toBe('queued')
    } else {
      expect(search).toMatchObject({
        job: { jobId: job.id, status: 'succeeded', resultCount: 1 },
        candidates: [{ spotifyTrackId: candidateId }],
      })
    }
    expect(await fixture.select().from(schema.libraryTrack)).toMatchObject([
      {
        mediaItemId: recordingId,
        spotifyTrackId: change === 'covered' ? otherCandidateId : null,
      },
    ])
    expect(
      await fixture.select().from(schema.providerRequestState),
    ).toMatchObject([{ failureCount: 0 }])
  },
)

it('keeps Spotify cooldowns and retries a cancelled search only once', async () => {
  market = undefined
  await queueSpotifyTrackSearches(
    { trackIds: [recordingId], market: 'AU' },
    userId,
  )
  const [original] = (await listJobs({ mediaType: 'track' })).items
  if (!original) throw new Error('Expected a queued Spotify track search')
  await bulkCancelJobs({ jobIds: [original.id], confirmRunning: false }, userId)
  const retried = await retryJob(original.id, userId, false)
  expect(retried.id).not.toBe(original.id)
  expect((await retryJob(original.id, userId, false)).id).toBe(retried.id)

  request.mockImplementationOnce(async () => Response.json(spotifyTokenFixture))
  request.mockImplementationOnce(async () =>
    Response.json(
      { error: { status: 429, message: 'Synthetic rate limit' } },
      { status: 429, headers: { 'Retry-After': '600' } },
    ),
  )
  await processQueuedJobs()
  expect(await getJob(retried.id)).toMatchObject({ status: 'failed' })
  await expect(retryJob(retried.id, userId, false)).rejects.toMatchObject({
    response: { statusCode: 429 },
  })
  expect(request).toHaveBeenCalledTimes(2)
})

it('validates and authenticates searches and status through the Spotify API', async () => {
  const { default: app } = await import('@/app')
  const path = '/api/v1/spotify/tracks/search'
  const headers = {
    'content-type': 'application/json',
    cookie: 'session=fixture',
    origin: 'http://localhost:3000',
  }
  const post = (suffix: string, body: unknown, origin = headers.origin) =>
    app.request(`${path}${suffix}`, {
      method: 'POST',
      headers: { ...headers, origin },
      body: JSON.stringify(body),
    })
  expect((await app.request(`${path}/${recordingId}`)).status).toBe(401)
  expect(
    (await post('', { trackIds: [recordingId] }, 'https://untrusted.example'))
      .status,
  ).toBe(403)
  expect(
    (await post('', { trackIds: Array.from({ length: 6 }, () => recordingId) }))
      .status,
  ).toBe(422)
  expect((await post('/status', { trackIds: [] })).status).toBe(422)
  expect(
    (
      await post('', {
        trackIds: [recordingId],
        freshness: [{ provider: 'lastfm', mode: 'never' }],
      })
    ).status,
  ).toBe(422)
  expect(
    (
      await post('', {
        trackIds: [recordingId],
        freshness: [{ provider: 'spotify', mode: 'never' }],
      })
    ).status,
  ).toBe(200)
  expect(
    await (await post('/status', { trackIds: [recordingId] })).json(),
  ).toMatchObject({
    data: { items: [{ trackId: recordingId, job: { status: 'queued' } }] },
  })
  expect(
    await (await app.request(`${path}/${recordingId}`, { headers })).json(),
  ).toMatchObject({ data: { job: { status: 'queued' }, candidates: [] } })
  expect(request).not.toHaveBeenCalled()
})

it('selects Metadata tracks by owner-scoped search freshness before sorting and capping the results', async () => {
  const older = 'older-recording'
  const zero = 'zero-results'
  const failed = 'failed-recording'
  const covered = 'covered-recording'
  await addTrack(older, 'Aged Search')
  await addTrack(zero, 'Zero Results')
  await addTrack(failed, 'Failed Search')
  await addTrack(covered, 'Already Covered', candidateId)

  function attempt(
    id: string,
    trackId: string,
    status: 'queued' | 'failed' | 'succeeded',
    daysAgo: number,
    options: { resultCount?: number; requester?: string } = {},
  ): typeof schema.scrapeJob.$inferInsert {
    const at = new Date(Date.now() - daysAgo * 86_400_000)
    return {
      id,
      provider: 'spotify',
      status,
      scope: { mediaType: 'track', mediaItemIds: [trackId], limit: 1 },
      options: {
        task: SPOTIFY_TRACK_SEARCH_TASK,
        trackId,
        ...(options.resultCount === undefined
          ? {}
          : { resultCount: options.resultCount }),
      },
      requestedByUserId: options.requester ?? userId,
      createdAt: at,
      startedAt: status === 'queued' ? null : at,
      finishedAt: status === 'queued' ? null : at,
    }
  }
  await fixture.insert(schema.scrapeJob).values([
    attempt('old-success', older, 'succeeded', 90, { resultCount: 1 }),
    attempt('newer-failure', older, 'failed', 1),
    attempt('empty-success', zero, 'succeeded', 2, { resultCount: 0 }),
    attempt('waiting-search', zero, 'queued', 0),
    attempt('only-failure', failed, 'failed', 1),
    attempt('newly-covered-skip', recordingId, 'succeeded', 1),
    attempt('other-owner-failure', recordingId, 'failed', 1, {
      requester: otherUserId,
    }),
  ])
  const view = (overrides: Record<string, unknown> = {}, requester = userId) =>
    listTrackMatchDiagnostics(
      TrackMatchDiagnosticsQuerySchema.parse({
        view: 'spotify-search-metadata',
        playability: 'unavailable',
        ...overrides,
      }),
      requester,
    )
  const ids = (page: Awaited<ReturnType<typeof view>>) =>
    page.items.map((item) => item.id)
  const withFreshness = (
    filter: { mode: string; olderThanDays?: number },
    requester?: string,
  ) => view({ freshness: [{ provider: 'spotify', ...filter }] }, requester)

  expect(ids(await view())).toEqual([older, failed, recordingId, zero])
  expect(ids(await withFreshness({ mode: 'never' }))).toEqual([recordingId])
  expect(ids(await withFreshness({ mode: 'failed' }))).toEqual([older, failed])
  expect(ids(await withFreshness({ mode: 'unscraped' }))).toEqual([
    failed,
    recordingId,
  ])
  expect(
    ids(await withFreshness({ mode: 'older', olderThanDays: 30 })),
  ).toEqual([older, failed, recordingId])
  expect(ids(await withFreshness({ mode: 'failed' }, otherUserId))).toEqual([
    recordingId,
  ])

  const order = {
    sortBy: 'spotifyLastSearch',
    direction: 'desc',
    size: 1,
    limitResults: 2,
  }
  const first = await view(order)
  expect(first).toMatchObject({ totalCount: 2, pageCount: 2, providers: [] })
  expect(ids(first)).toEqual([zero])
  expect(ids(await view({ ...order, page: 2 }))).toEqual([older])
  expect(ids(await view({ ...order, page: 3 }))).toEqual([])
  expect(request).not.toHaveBeenCalled()
})

it('skips Metadata selections whose search freshness changed before the queue request', async () => {
  const freshness: SpotifyTrackSearchFreshness = [
    { provider: 'spotify', mode: 'never' },
  ]
  const metadata = await listTrackMatchDiagnostics(
    TrackMatchDiagnosticsQuerySchema.parse({
      view: 'spotify-search-metadata',
      playability: 'unavailable',
      freshness,
    }),
    userId,
  )
  expect(metadata.items.map((item) => item.id)).toEqual([recordingId])

  const recent = await queueOne()
  await processQueuedJobs()
  expect((await getJob(recent.id))?.status).toBe('succeeded')
  request.mockClear()

  expect(
    await queueSpotifyTrackSearches(
      { trackIds: [recordingId], freshness },
      userId,
    ),
  ).toMatchObject({
    queued: 0,
    skipped: 1,
    warnings: [expect.stringContaining('freshness')],
  })
  expect(
    (await listJobs({ mediaType: 'track' })).items.map((job) => job.id),
  ).toEqual([recent.id])
  expect(request).not.toHaveBeenCalled()
})

it('reports saved search history on the retained track after acceptance changes the ID', async () => {
  mockCandidates({ ...catalogTrack, name: 'Retained Recording' })
  const original = await queueOne()
  await processQueuedJobs()
  const completed = await getSpotifyTrackSearch(recordingId, userId)
  expect(completed.job).toMatchObject({
    jobId: original.id,
    status: 'succeeded',
  })

  const retained = 'retained-recording'
  await addTrack(retained, 'Retained Recording', candidateId)
  await fixture
    .update(schema.scrapeJob)
    .set({
      options: sql`${schema.scrapeJob.options} || ${JSON.stringify({ acceptedTrackId: retained, acceptedSpotifyTrackId: candidateId })}::jsonb`,
    })
    .where(eq(schema.scrapeJob.id, original.id))
  await fixture
    .delete(schema.mediaItem)
    .where(eq(schema.mediaItem.id, recordingId))
  request.mockClear()

  const result = {
    job: { jobId: original.id, status: 'succeeded', acceptedTrackId: retained },
    candidates: completed.candidates,
  }
  expect(await getSpotifyTrackSearch(recordingId, userId)).toMatchObject(result)
  expect(await getSpotifyTrackSearch(retained, userId)).toMatchObject(result)
  const status = await listSpotifyTrackSearchStatuses(
    { trackIds: [retained, recordingId] },
    userId,
  )
  expect(status.items).toMatchObject([
    {
      trackId: retained,
      job: result.job,
      lastSuccessfulAt: completed.job?.finishedAt,
    },
    { trackId: recordingId, job: null },
  ])
  const query = TrackMatchDiagnosticsQuerySchema.parse({
    view: 'spotify-search-metadata',
    playability: 'all',
    freshness: [{ provider: 'spotify', mode: 'never' }],
  })
  expect((await listTrackMatchDiagnostics(query, userId)).items).toEqual([])
  expect(
    (await listTrackMatchDiagnostics(query, otherUserId)).items.map(
      (item) => item.id,
    ),
  ).toEqual([retained])
  await fixture.insert(schema.scrapeJob).values({
    id: 'earlier-fixture-search',
    status: 'failed',
    provider: 'spotify',
    scope: { mediaType: 'track', mediaItemIds: [recordingId], limit: 1 },
    options: { task: SPOTIFY_TRACK_SEARCH_TASK, trackId: recordingId },
    requestedByUserId: userId,
    createdAt: new Date('2024-01-01T00:00:00Z'),
  })
  expect(await getSpotifyTrackSearch(recordingId, userId)).toMatchObject(result)
  expect(request).not.toHaveBeenCalled()
})
