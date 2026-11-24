import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { and, eq, isNotNull } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { env } from '@/env'
import { spotifyTokenFixture } from '@/plugins/builtin/__tests__/fixtures/spotify'
import { spotifyPlugin } from '@/plugins/builtin/spotify'
import * as schema from '@/schemas/db'

const database = `spotify_artist_albums_${randomUUID().replaceAll('-', '')}`
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
const ownerId = 'fixture-owner'
const artistId = 'fixture-artist'
const artistName = 'Artist Fixture'
const spotifyArtistId = 'fixtureartist'.padEnd(22, '0')
const otherSpotifyArtistId = 'anotherartist'.padEnd(22, '0')
const existingAlbumId = 'existingalbum'.padEnd(22, '0')
const outsideAlbumId = 'outsidealbum'.padEnd(22, '0')
const appearanceAlbumId = 'appearancealbum'.padEnd(22, '0')
const listingPath = `/v1/artists/${spotifyArtistId}/albums`

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
    clientId: 'fixture-client',
    clientSecret: 'fixture-client-secret',
    market: 'AU',
  }),
}))

import { processQueuedJobs } from '@/services/jobs'
import { getMediaSources } from '@/services/history'
import { openSpotifyAlbumReference } from '@/services/spotify-album-reference'
import {
  getJobProviderResponse,
  listJobProviderResponses,
} from '@/services/provider-response-history'
import {
  getSpotifyArtistAlbumListing,
  queueSpotifyArtistAlbums,
} from '@/services/spotify-artist-albums'

const credits = [{ id: spotifyArtistId, name: artistName }]
const existingAlbum = {
  id: existingAlbumId,
  name: 'Previously added',
  album_type: 'album',
  artists: credits,
}
const outsideAlbum = {
  id: outsideAlbumId,
  name: 'New release',
  album_type: 'single',
  artists: credits,
  release_date: '2026-11',
}
const appearanceAlbum = {
  id: appearanceAlbumId,
  name: 'Guest appearance',
  album_type: 'compilation',
  album_group: 'appears_on',
  artists: [{ id: otherSpotifyArtistId, name: 'Another Artist' }],
}
const firstPage = {
  items: [existingAlbum, outsideAlbum],
  total: 3,
  offset: 0,
  next: `https://api.spotify.com${listingPath}?offset=2&limit=10`,
}
const lastPage = {
  items: [appearanceAlbum],
  total: 3,
  offset: 2,
  next: null,
}

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
  await fixture.insert(schema.user).values({
    id: ownerId,
    name: 'Fixture Owner',
    email: 'owner@example.test',
  })
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

it('resolves the artist, retains pages and relationships, resumes once and serves a completed listing from storage', async () => {
  await fixture.insert(schema.artist).values({ id: artistId, name: artistName })
  await fixture.insert(schema.mediaItem).values({
    id: 'member-album',
    mediaType: 'album',
    title: existingAlbum.name,
    slug: 'member-album',
  })
  await fixture.insert(schema.album).values({
    mediaItemId: 'member-album',
    spotifyUrl: `https://open.spotify.com/album/${existingAlbumId}`,
  })
  await fixture.insert(schema.mediaCredit).values({
    mediaItemId: 'member-album',
    artistId,
    role: 'artist',
  })
  let blocked = true
  request.mockImplementation(async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'accounts.spotify.com')
      return Response.json(spotifyTokenFixture)
    if (url.pathname === '/v1/search') {
      expect(url.searchParams.get('type')).toBe('artist')
      return Response.json({
        artists: {
          items: credits.map((credit) => ({ ...credit, type: 'artist' })),
          total: 1,
        },
      })
    }
    if (url.pathname === `/v1/artists/${spotifyArtistId}`)
      return Response.json({
        id: spotifyArtistId,
        name: artistName,
        type: 'artist',
      })
    if (url.pathname === listingPath) {
      expect(url.searchParams.get('market')).toBe('AU')
      expect(url.searchParams.get('limit')).toBe('10')
      expect(url.searchParams.get('include_groups')).toBe(
        'album,single,compilation,appears_on',
      )
      if (url.searchParams.get('offset') === '0')
        return Response.json(firstPage)
      if (url.searchParams.get('offset') === '2')
        return blocked
          ? Response.json(
              { error: 'Fixture rate limit' },
              {
                status: 429,
                headers: { 'Retry-After': '60' },
              },
            )
          : Response.json(lastPage)
    }
    throw new Error('Unexpected offline provider request')
  })

  const queued = await Promise.all([
    queueSpotifyArtistAlbums(artistId, ownerId),
    queueSpotifyArtistAlbums(artistId, ownerId),
  ])
  const firstJobId = queued[0]?.job?.jobId
  if (!firstJobId) throw new Error('Expected a listing job')
  expect(queued[1]?.job?.jobId).toBe(firstJobId)
  expect(request).not.toHaveBeenCalled()
  await processQueuedJobs()
  const partial = await getSpotifyArtistAlbumListing(artistId)
  expect(partial.job?.errorMessage).toMatch(/429|rate limit/i)
  expect(partial).toMatchObject({
    artistUrl: `https://open.spotify.com/artist/${spotifyArtistId}`,
    market: 'AU',
    pagesSaved: 1,
    releasesSeen: 2,
    expectedTotal: 3,
    completedAt: null,
    job: { status: 'failed' },
  })
  expect(partial.retryAt).toBeTruthy()
  const firstDiscoveries = await fixture
    .select()
    .from(schema.catalogObservation)
    .where(
      and(
        eq(schema.catalogObservation.operation, 'artist-albums'),
        isNotNull(schema.catalogObservation.mediaItemId),
      ),
    )
  expect(firstDiscoveries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        mediaItemId: 'member-album',
        subjectId: artistId,
        page: 1,
        position: 1,
      }),
      expect.objectContaining({
        relationshipRole: 'single',
        page: 1,
        position: 2,
      }),
    ]),
  )
  expect(firstDiscoveries).toHaveLength(2)
  const responseId = firstDiscoveries[0]?.responseId
  if (!responseId) throw new Error('Expected discovery response evidence')
  const response = await getJobProviderResponse(firstJobId, responseId)
  expect(response.body).toMatchObject({
    state: 'captured',
    text: JSON.stringify(firstPage),
  })
  const responseList = await listJobProviderResponses(firstJobId, {
    page: 1,
    size: 10,
  })
  expect(responseList.totalCount).toBe(4)
  expect(
    await fixture.$count(
      schema.mediaItem,
      eq(schema.mediaItem.inLibrary, true),
    ),
  ).toBe(1)
  expect(
    await fixture.$count(
      schema.mediaItem,
      eq(schema.mediaItem.inLibrary, false),
    ),
  ).toBe(1)

  // Advance past the simulated provider cooldown without sending real requests.
  await fixture.delete(schema.providerRequestState)
  blocked = false
  request.mockClear()
  const resumed = await queueSpotifyArtistAlbums(artistId, ownerId)
  expect(resumed.job?.jobId).not.toBe(firstJobId)
  await processQueuedJobs()
  const complete = await getSpotifyArtistAlbumListing(artistId)
  expect(complete).toMatchObject({
    pagesSaved: 2,
    releasesSeen: 3,
    expectedTotal: 3,
    completedAt: expect.any(String),
    job: { status: 'succeeded' },
  })
  expect(
    request.mock.calls.map(([input]) => {
      const url = new URL(String(input))
      return [url.pathname, url.searchParams.get('offset')]
    }),
  ).toEqual([
    ['/api/token', null],
    [listingPath, '2'],
  ])
  expect(
    await fixture.$count(
      schema.mediaItem,
      eq(schema.mediaItem.inLibrary, true),
    ),
  ).toBe(1)
  expect(
    await fixture.$count(
      schema.mediaItem,
      eq(schema.mediaItem.inLibrary, false),
    ),
  ).toBe(2)
  expect(
    await fixture
      .select()
      .from(schema.catalogObservation)
      .where(eq(schema.catalogObservation.operation, 'artist-albums')),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        relationshipRole: 'appears_on',
        subjectId: artistId,
        page: 2,
        position: 3,
      }),
    ]),
  )
  request.mockClear()
  expect(await queueSpotifyArtistAlbums(artistId, ownerId)).toEqual(complete)
  expect(request).not.toHaveBeenCalled()
  expect(await fixture.$count(schema.scrapeJob)).toBe(2)
}, 30_000)

it('opens an exact recorded parent once, reuses its cached details and adds only that album', async () => {
  await fixture.delete(schema.providerRequestState)
  const trackId = 'track-with-unlisted-parent'
  const parentId = 'unlistedparent'.padEnd(22, '0')
  const childId = 'catalogchildtrack'.padEnd(22, '0')
  const reference = { trackId, spotifyAlbumId: parentId }
  const parentPath = `/v1/albums/${parentId}`
  await fixture.insert(schema.mediaItem).values({
    id: trackId,
    slug: trackId,
    title: 'Recorded track',
    mediaType: 'track',
  })
  await fixture.insert(schema.libraryTrack).values({
    mediaItemId: trackId,
    spotifyAlbumId: parentId,
    albumName: 'Recorded parent',
  })
  request.mockClear()
  request.mockImplementation(async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'accounts.spotify.com')
      return Response.json(spotifyTokenFixture)
    if (url.pathname === parentPath)
      return Response.json({
        id: parentId,
        name: 'Recorded parent',
        artists: credits,
        album_type: 'album',
        genres: ['Fixture tag'],
        total_tracks: 1,
        tracks: {
          offset: 0,
          total: 1,
          next: null,
          items: [
            {
              id: childId,
              name: 'Discovered child',
              artists: credits,
              disc_number: 1,
              track_number: 1,
              duration_ms: 90000,
            },
          ],
        },
      })
    throw new Error('Unexpected offline provider request')
  })
  await expect(
    openSpotifyAlbumReference(
      { ...reference, spotifyAlbumId: existingAlbumId },
      ownerId,
    ),
  ).rejects.toMatchObject({ response: { statusCode: 404 } })
  const [first, second] = await Promise.all([
    openSpotifyAlbumReference(reference, ownerId),
    openSpotifyAlbumReference(reference, ownerId),
  ])
  expect(second).toEqual(first)
  expect(first.jobId).toBeTruthy()
  expect(request).not.toHaveBeenCalled()
  const readParent = () =>
    fixture.query.mediaItem.findFirst({
      where: eq(schema.mediaItem.id, first.mediaItemId),
    })
  expect(await readParent()).toMatchObject({ inLibrary: false })

  const added = await openSpotifyAlbumReference(
    { ...reference, add: true },
    ownerId,
  )
  expect(added).toEqual({ mediaItemId: first.mediaItemId })
  expect(request).not.toHaveBeenCalled()
  expect(await readParent()).toMatchObject({ inLibrary: true })
  await processQueuedJobs()
  expect(
    request.mock.calls.map(([input]) => new URL(String(input)).pathname),
  ).toEqual(['/api/token', parentPath])
  expect((await getMediaSources(first.mediaItemId)).providers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'spotify',
        latestSnapshot: expect.objectContaining({ jobId: first.jobId }),
        latestAttempt: expect.objectContaining({ status: 'succeeded' }),
        returnedTags: ['Fixture tag'],
        returnedTrackList: true,
      }),
    ]),
  )
  expect(
    await fixture.query.mediaItem.findFirst({
      where: eq(schema.mediaItem.title, 'Discovered child'),
    }),
  ).toMatchObject({ inLibrary: false })
  request.mockClear()
  expect(await openSpotifyAlbumReference(reference, ownerId)).toEqual(added)
  expect(request).not.toHaveBeenCalled()
  expect(
    await fixture.$count(
      schema.catalogAddition,
      eq(schema.catalogAddition.mediaItemId, first.mediaItemId),
    ),
  ).toBe(1)
}, 20_000)

it('keeps a withdrawn exact parent accessible and reuses the failed lookup', async () => {
  await fixture.delete(schema.providerRequestState)
  const trackId = 'track-with-withdrawn-parent'
  const spotifyAlbumId = 'withdrawnparent'.padEnd(22, '0')
  const reference = { trackId, spotifyAlbumId }
  await fixture.insert(schema.mediaItem).values({
    id: trackId,
    slug: trackId,
    title: 'Recorded track with withdrawn parent',
    mediaType: 'track',
  })
  await fixture.insert(schema.libraryTrack).values({
    mediaItemId: trackId,
    spotifyAlbumId,
    albumName: 'Withdrawn album',
  })
  request.mockClear()
  request.mockImplementation(async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'accounts.spotify.com')
      return Response.json(spotifyTokenFixture)
    if (url.pathname === `/v1/albums/${spotifyAlbumId}`)
      return Response.json({ error: 'Not found' }, { status: 404 })
    throw new Error('Unexpected offline provider request')
  })
  const opened = await openSpotifyAlbumReference(reference, ownerId)
  if (!opened.jobId) throw new Error('Expected an exact-parent job')
  await processQueuedJobs()
  const sources = await getMediaSources(opened.mediaItemId)
  expect(sources.providers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'spotify',
        latestSnapshot: null,
        latestAttempt: {
          jobId: opened.jobId,
          status: 'failed',
          createdAt: expect.any(String),
          finishedAt: expect.any(String),
        },
      }),
    ]),
  )
  expect(
    (await listJobProviderResponses(opened.jobId, { page: 1, size: 1 }))
      .totalCount,
  ).toBe(1)
  request.mockClear()
  expect(await openSpotifyAlbumReference(reference, ownerId)).toEqual(opened)
  expect(request).not.toHaveBeenCalled()
}, 20_000)
