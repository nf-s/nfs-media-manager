import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { SPOTIFY_TRACK_ALBUM_LOOKUP_TASK } from '@repo/schemas/spotify-album-reference'
import { SPOTIFY_TRACK_SEARCH_TASK } from '@repo/schemas/spotify-track-search'
import { env } from '@/env'
import { parseSpotifyArtistAlbumPage } from '@/lib/spotify-artist-albums'
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
let statements: number | undefined
const fixture = drizzle(pool, {
  schema,
  logger: {
    logQuery() {
      if (statements !== undefined) statements++
    },
  },
})
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

import { processQueuedJobById, processQueuedJobs } from '@/services/jobs'
import { getMediaSources } from '@/services/history'
import { openSpotifyAlbumReference } from '@/services/spotify-album-reference'
import { loadTracks } from '@/services/tracks'
import { observeSpotifyArtistAlbumPage } from '@/services/spotify-artist-album-discoveries'
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

it('writes a new and repeated 20-entry artist release page in bounded database work', async () => {
  const sourceId = 'artist-page-writer'
  await fixture
    .insert(schema.artist)
    .values({ id: sourceId, name: 'Artist Page Fixture' })
  const releases = Array.from({ length: 20 }, (_, index) => ({
    externalId: `writerRelease${index}`.padEnd(22, '0'),
    title: `Fixture release ${index}`,
    primary: index % 2 === 0,
    position: index + 1,
    relationshipRole: index % 2 === 0 ? 'album' : 'appears_on',
    credits:
      index % 2 === 0
        ? [{ externalId: spotifyArtistId, name: artistName }]
        : [{ externalId: otherSpotifyArtistId, name: 'Another Artist' }],
    artworkUrl: undefined,
    releaseDate: undefined,
    trackCount: undefined,
  })).map((release) => ({
    ...release,
    spotifyUrl: `https://open.spotify.com/album/${release.externalId}`,
  }))
  for (const limit of [13, 12]) {
    statements = 0
    try {
      await fixture.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
        await observeSpotifyArtistAlbumPage(tx, releases, {
          artistId: sourceId,
          occurrencePrefix: 'fixture-catalogue',
          page: 1,
        })
      })
      expect(statements).toBeLessThanOrEqual(limit)
    } finally {
      statements = undefined
    }
  }
  expect(
    await fixture.$count(
      schema.catalogObservation,
      and(
        eq(schema.catalogObservation.subjectId, sourceId),
        isNotNull(schema.catalogObservation.mediaItemId),
      ),
    ),
  ).toBe(20)
})

it('preserves ambiguous album identities and duplicate response positions', async () => {
  const sourceId = 'artist-page-ambiguous'
  const externalId = 'ambiguousAlbum'.padEnd(22, '0')
  await fixture
    .insert(schema.artist)
    .values({ id: sourceId, name: 'Ambiguity Fixture' })
  const members = ['confirmed-album-one', 'confirmed-album-two']
  await fixture.insert(schema.mediaItem).values(
    members.map((id): typeof schema.mediaItem.$inferInsert => ({
      id,
      title: id,
      slug: id,
      mediaType: 'album',
    })),
  )
  await fixture
    .insert(schema.album)
    .values(members.map((id) => ({ mediaItemId: id })))
  await fixture.insert(schema.providerReference).values(
    members.map((id) => ({
      id: 'spotify-' + id,
      mediaItemId: id,
      provider: 'spotify',
      referenceType: 'album',
      externalId,
    })),
  )
  const response = parseSpotifyArtistAlbumPage(
    {
      offset: 0,
      total: 2,
      next: null,
      items: [
        { ...outsideAlbum, id: externalId },
        { ...appearanceAlbum, id: externalId },
      ],
    },
    spotifyArtistId,
    0,
  )
  const save = () =>
    fixture.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
      await observeSpotifyArtistAlbumPage(tx, response.releases, {
        artistId: sourceId,
        occurrencePrefix: 'fixture-ambiguous',
        page: 1,
      })
    })
  await Promise.all([save(), save()])
  const discoveries = await fixture
    .select()
    .from(schema.catalogObservation)
    .where(eq(schema.catalogObservation.subjectId, sourceId))
    .orderBy(schema.catalogObservation.position)
  const localId = discoveries[0]?.mediaItemId
  if (!localId) throw new Error('Missing provisional album identity')
  expect(members).not.toContain(localId)
  expect(
    discoveries.map(({ mediaItemId, position, relationshipRole }) => ({
      mediaItemId,
      position,
      relationshipRole,
    })),
  ).toEqual([
    { mediaItemId: localId, position: 1, relationshipRole: 'single' },
    { mediaItemId: localId, position: 2, relationshipRole: 'appears_on' },
  ])
  expect(
    await fixture.query.mediaItem.findFirst({
      where: eq(schema.mediaItem.id, localId),
    }),
  ).toMatchObject({ inLibrary: false, title: outsideAlbum.name })
  for (const id of members) {
    expect(
      await fixture.query.mediaItem.findFirst({
        where: eq(schema.mediaItem.id, id),
      }),
    ).toMatchObject({ inLibrary: true, title: id })
  }
})

it('keeps a failed exact parent accessible and retries that release by ID', async () => {
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
  await fixture.delete(schema.providerRequestState)
  request.mockClear()
  request.mockImplementation(albumRequest(spotifyAlbumId, 'Returned release'))
  const retry = await openSpotifyAlbumReference(reference, ownerId)
  expect(retry.mediaItemId).toBe(opened.mediaItemId)
  expect(retry.jobId).toBeTruthy()
  expect(retry.jobId).not.toBe(opened.jobId)
  await processQueuedJobs()
  expect(
    request.mock.calls.map(([input]) => new URL(String(input)).pathname),
  ).toEqual(['/api/token', `/v1/albums/${spotifyAlbumId}`])
  expect(await openSpotifyAlbumReference(reference, ownerId)).toEqual({
    mediaItemId: opened.mediaItemId,
  })
}, 20_000)

async function seedParentTrack(
  id: string,
  data: Partial<typeof schema.libraryTrack.$inferInsert> = {},
) {
  await fixture
    .insert(schema.mediaItem)
    .values({ id, slug: id, title: id, mediaType: 'track' })
  await fixture.insert(schema.libraryTrack).values({ ...data, mediaItemId: id })
  return id
}

async function seedParentAlbum(
  id: string,
  spotifyAlbumId?: string,
  inLibrary = true,
) {
  await fixture
    .insert(schema.mediaItem)
    .values({ id, slug: id, title: id, mediaType: 'album', inLibrary })
  await fixture.insert(schema.album).values({
    mediaItemId: id,
    spotifyUrl: spotifyAlbumId
      ? `https://open.spotify.com/album/${spotifyAlbumId}`
      : undefined,
  })
  return id
}

function albumRequest(spotifyAlbumId: string, name: string): typeof fetch {
  return async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'accounts.spotify.com')
      return Response.json(spotifyTokenFixture)
    if (url.pathname === `/v1/albums/${spotifyAlbumId}`)
      return Response.json({
        id: spotifyAlbumId,
        name,
        artists: credits,
        total_tracks: 0,
        tracks: { items: [], total: 0, offset: 0, next: null },
      })
    throw new Error('Unexpected offline provider request')
  }
}

it('opens a linked local album and prefers a different exact known edition over a title link', async () => {
  const localId = await seedParentAlbum('local-album-for-parent')
  const localTrack = await seedParentTrack('local-album-track', {
    albumMediaItemId: localId,
    albumLinkStrategy: 'album-track-list',
  })
  const spotifyAlbumId = 'exactreleasedifferent'.padEnd(22, '0')
  const exactId = await seedParentAlbum('exact-known-release', spotifyAlbumId)
  const exactTrack = await seedParentTrack('other-edition-track', {
    albumMediaItemId: localId,
    albumLinkStrategy: 'album-title',
    spotifyAlbumId: `spotify:album:${spotifyAlbumId}`,
  })
  request.mockClear()
  expect(await loadTracks([exactTrack])).toMatchObject([{ spotifyAlbumId }])
  expect(
    await openSpotifyAlbumReference({ trackId: localTrack }, ownerId),
  ).toEqual({ mediaItemId: localId })
  expect(
    await openSpotifyAlbumReference(
      { trackId: exactTrack, spotifyAlbumId },
      ownerId,
    ),
  ).toEqual({ mediaItemId: exactId })
  expect(request).not.toHaveBeenCalled()
})

it('hydrates a linked outside release using its stored identity without rereading the legacy track', async () => {
  await fixture.delete(schema.providerRequestState)
  const spotifyAlbumId = 'linkedoutsidealbum'.padEnd(22, '0')
  const linked = await seedParentAlbum(
    'linked-outside-release',
    spotifyAlbumId,
    false,
  )
  const trackId = await seedParentTrack('track-with-linked-outside-release', {
    albumMediaItemId: linked,
    albumLinkStrategy: 'spotify-album',
    spotifyTrackId: 'tracklinkedoutside'.padEnd(22, '0'),
  })
  expect(await loadTracks([trackId])).toMatchObject([
    { album: { id: linked, inLibrary: false } },
  ])
  request.mockClear()
  request.mockImplementation(
    albumRequest(spotifyAlbumId, 'Hydrated outside release'),
  )
  const opened = await openSpotifyAlbumReference({ trackId }, ownerId)
  expect(opened.mediaItemId).toBe(linked)
  if (!opened.jobId) throw new Error('Expected an exact-album job')
  await processQueuedJobs()
  expect(
    request.mock.calls.map(([input]) => new URL(String(input)).pathname),
  ).toEqual(['/api/token', `/v1/albums/${spotifyAlbumId}`])
  expect(
    await fixture.query.mediaItem.findFirst({
      where: eq(schema.mediaItem.id, linked),
    }),
  ).toMatchObject({ inLibrary: false })
  request.mockClear()
  expect(await openSpotifyAlbumReference({ trackId }, ownerId)).toEqual({
    mediaItemId: linked,
  })
  expect(request).not.toHaveBeenCalled()
}, 20_000)

async function seedParentEvidence(
  trackId: string,
  spotifyTrackId: string,
  albumIds: string[],
) {
  const jobId = `${trackId}-match-job`
  const id = `${jobId}-response`
  const text = JSON.stringify({
    tracks: {
      items: albumIds.map((albumId) => ({
        id: spotifyTrackId,
        album: { id: albumId, name: 'Saved release evidence' },
      })),
    },
  })
  await fixture.insert(schema.scrapeJob).values({
    id: jobId,
    provider: 'spotify',
    status: 'succeeded',
    requestedByUserId: ownerId,
    scope: { mediaType: 'track', mediaItemIds: [trackId], limit: 1 },
    options: {
      task: SPOTIFY_TRACK_SEARCH_TASK,
      trackId,
      acceptedSpotifyTrackId: spotifyTrackId,
    },
  })
  await fixture.insert(schema.providerResponse).values({
    id,
    jobId,
    provider: 'spotify',
    attempt: 1,
    ordinal: 1,
    status: 200,
    phase: 'task',
    method: 'GET',
    requestUrl: 'https://api.spotify.com/v1/search?type=track',
    bodyState: 'captured',
    retainedBytes: Buffer.byteLength(text),
    body: { state: 'captured', text, relayed: false },
  })
  return { jobId, responseId: id }
}

it('uses retained raw evidence for the selected track without reading it from Spotify', async () => {
  const spotifyTrackId = 'storedlegacytrack'.padEnd(22, '0')
  const spotifyAlbumId = 'storedlegacyalbum'.padEnd(22, '0')
  const trackId = await seedParentTrack('stored-legacy-track', {
    spotifyTrackId,
  })
  const albumId = await seedParentAlbum('stored-legacy-release', spotifyAlbumId)
  const evidence = await seedParentEvidence(trackId, spotifyTrackId, [
    spotifyAlbumId,
  ])
  request.mockClear()
  expect(await openSpotifyAlbumReference({ trackId }, ownerId)).toEqual({
    mediaItemId: albumId,
  })
  expect(await loadTracks([trackId])).toMatchObject([{ spotifyAlbumId }])
  expect(
    await fixture.query.catalogObservation.findFirst({
      where: eq(schema.catalogObservation.responseId, evidence.responseId),
    }),
  ).toMatchObject({ mediaItemId: albumId, subjectId: trackId, ...evidence })
  expect(request).not.toHaveBeenCalled()
})

it('reports a legacy track failure, then reads and caches one exact track and album without promoting either', async () => {
  await fixture.delete(schema.providerRequestState)
  const spotifyTrackId = 'lookuptrackbyid'.padEnd(22, '0')
  const spotifyAlbumId = 'lookupitsalbum'.padEnd(22, '0')
  const trackId = await seedParentTrack('lookup-track', {
    spotifyTrackId,
    albumName: 'Legacy release spelling',
  })
  const reference = { trackId, spotifyAlbumId }
  const trackPath = `/v1/tracks/${spotifyTrackId}`
  const albumPath = `/v1/albums/${spotifyAlbumId}`
  const releaseTitle = 'Exact release title'
  let available = false
  const readAlbum = albumRequest(spotifyAlbumId, releaseTitle)
  request.mockClear()
  request.mockImplementation(async (input) => {
    if (new URL(String(input)).pathname === trackPath)
      return available
        ? Response.json({
            id: spotifyTrackId,
            album: { id: spotifyAlbumId, name: releaseTitle },
          })
        : Response.json({ error: 'Not found' }, { status: 404 })
    return readAlbum(input)
  })
  await expect(
    openSpotifyAlbumReference(reference, ownerId),
  ).rejects.toMatchObject({ response: { statusCode: 502 } })
  expect(await loadTracks([trackId])).toMatchObject([{ spotifyAlbumId: null }])
  await fixture.delete(schema.providerRequestState)
  available = true
  const opened = await openSpotifyAlbumReference(reference, ownerId)
  if (!opened.jobId) throw new Error('Expected an exact-album job')
  await processQueuedJobById(opened.jobId, 'spotify', {
    canContinue: async () => true,
    recordOutcome: async () => {},
  })
  expect(
    request.mock.calls.map(([input]) => new URL(String(input)).pathname),
  ).toEqual([
    '/api/token',
    trackPath,
    '/api/token',
    trackPath,
    '/api/token',
    albumPath,
  ])
  expect(await loadTracks([trackId])).toMatchObject([{ spotifyAlbumId }])
  expect(
    await fixture.query.mediaItem.findFirst({
      where: eq(schema.mediaItem.id, opened.mediaItemId),
    }),
  ).toMatchObject({
    title: releaseTitle,
    inLibrary: false,
  })
  expect(
    await fixture.$count(
      schema.catalogAddition,
      eq(schema.catalogAddition.mediaItemId, opened.mediaItemId),
    ),
  ).toBe(0)
  const jobs = await fixture.query.scrapeJob.findMany({
    where: sql`${schema.scrapeJob.options}->>'task' = ${SPOTIFY_TRACK_ALBUM_LOOKUP_TASK} and ${schema.scrapeJob.options}->>'trackId' = ${trackId}`,
  })
  expect(jobs.map(({ status }) => status).sort()).toEqual([
    'failed',
    'succeeded',
  ])
  for (const { id } of jobs) {
    expect(
      await listJobProviderResponses(id, { page: 1, size: 1 }),
    ).toMatchObject({ totalCount: 1 })
  }
  const success = jobs.find(({ status }) => status === 'succeeded')
  if (!success) throw new Error('Expected a successful legacy lookup')
  expect(
    await fixture.query.catalogObservation.findFirst({
      where: eq(schema.catalogObservation.jobId, success.id),
    }),
  ).toMatchObject({
    mediaItemId: opened.mediaItemId,
    responseId: expect.any(String),
    subjectId: trackId,
  })
  request.mockClear()
  expect(await openSpotifyAlbumReference(reference, ownerId)).toEqual({
    mediaItemId: opened.mediaItemId,
  })
  const anotherTrack = await seedParentTrack('other-track-same-shadow-album', {
    spotifyAlbumId,
  })
  expect(
    await openSpotifyAlbumReference({ trackId: anotherTrack }, ownerId),
  ).toEqual({ mediaItemId: opened.mediaItemId })
  expect(request).not.toHaveBeenCalled()
}, 25_000)

it('verifies the expected player release against the legacy Spotify track before opening', async () => {
  await fixture.delete(schema.providerRequestState)
  const spotifyTrackId = 'expectedreleaselegacy'.padEnd(22, '0')
  const returnedRelease = 'confirmedlegacyalbum'.padEnd(22, '0')
  const staleRelease = 'staleplayerrelease'.padEnd(22, '0')
  const trackId = await seedParentTrack('legacy-player-track', {
    spotifyTrackId,
  })
  const actualAlbum = await seedParentAlbum(
    'legacy-player-actual-album',
    returnedRelease,
  )
  await seedParentAlbum('legacy-player-stale-album', staleRelease)
  const trackPath = `/v1/tracks/${spotifyTrackId}`
  request.mockClear()
  request.mockImplementation(async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'accounts.spotify.com')
      return Response.json(spotifyTokenFixture)
    if (url.pathname === trackPath)
      return Response.json({
        id: spotifyTrackId,
        album: { id: returnedRelease, name: 'Confirmed release' },
      })
    throw new Error('Unexpected offline provider request')
  })

  const staleReference = { trackId, spotifyAlbumId: staleRelease }
  await expect(
    openSpotifyAlbumReference(staleReference, ownerId),
  ).rejects.toMatchObject({ response: { statusCode: 404 } })
  expect(
    request.mock.calls.map(([input]) => new URL(String(input)).pathname),
  ).toEqual(['/api/token', trackPath])
  expect(
    await fixture.$count(
      schema.catalogObservation,
      eq(schema.catalogObservation.subjectId, trackId),
    ),
  ).toBe(0)

  request.mockClear()
  await expect(
    openSpotifyAlbumReference(staleReference, ownerId),
  ).rejects.toMatchObject({ response: { statusCode: 404 } })
  expect(
    await openSpotifyAlbumReference(
      { trackId, spotifyAlbumId: returnedRelease },
      ownerId,
    ),
  ).toEqual({ mediaItemId: actualAlbum })
  expect(request).not.toHaveBeenCalled()
}, 20_000)

it('refuses missing identifiers, conflicting retained evidence and duplicate album mappings', async () => {
  const missing = await seedParentTrack('album-missing-track', {
    albumName: 'Same title',
  })
  const spotifyTrackId = 'conflictingtrack'.padEnd(22, '0')
  const conflicting = await seedParentTrack('album-conflicting-track', {
    spotifyTrackId,
    albumName: 'Same title',
  })
  const spotifyAlbumId = 'conflictingalbum'.padEnd(22, '0')
  await seedParentEvidence(conflicting, spotifyTrackId, [
    spotifyAlbumId,
    'otheralbumconflict'.padEnd(22, '0'),
  ])
  const duplicate = await seedParentTrack('album-duplicate-track', {
    spotifyAlbumId,
  })
  await seedParentAlbum('duplicate-exact-edition-one', spotifyAlbumId)
  await seedParentAlbum('duplicate-exact-edition-two', spotifyAlbumId)
  request.mockClear()
  for (const trackId of [missing, conflicting, duplicate]) {
    await expect(
      openSpotifyAlbumReference({ trackId }, ownerId),
    ).rejects.toMatchObject({ response: { statusCode: 409 } })
  }
  expect(request).not.toHaveBeenCalled()
  expect(
    await fixture.$count(
      schema.catalogObservation,
      eq(schema.catalogObservation.subjectId, duplicate),
    ),
  ).toBe(0)
  await fixture.delete(schema.providerRequestState)
  const legacySpotifyId = 'duplicatedlegacytrack'.padEnd(22, '0')
  const legacyTrack = await seedParentTrack(
    'legacy-track-with-duplicate-albums',
    { spotifyTrackId: legacySpotifyId },
  )
  const trackPath = `/v1/tracks/${legacySpotifyId}`
  request.mockImplementation(async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'accounts.spotify.com')
      return Response.json(spotifyTokenFixture)
    if (url.pathname === trackPath)
      return Response.json({
        id: legacySpotifyId,
        album: { id: spotifyAlbumId, name: 'Duplicate release' },
      })
    throw new Error('Unexpected offline provider request')
  })
  for (const trackId of [legacyTrack, legacyTrack])
    await expect(
      openSpotifyAlbumReference({ trackId }, ownerId),
    ).rejects.toMatchObject({ response: { statusCode: 409 } })
  expect(await loadTracks([legacyTrack])).toMatchObject([{ spotifyAlbumId }])
  expect(
    request.mock.calls.map(([input]) => new URL(String(input)).pathname),
  ).toEqual(['/api/token', trackPath])
}, 20_000)
