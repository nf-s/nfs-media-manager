import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  SPOTIFY_SIMILAR_LOOKUP_TASK,
  TIDAL_SIMILAR_TASK,
  TIDAL_TRACK_MATCH_TASK,
} from '@repo/schemas/tidal'
import { env } from '@/env'
import { clearTidalTokenCache } from '@/lib/tidal-api'
import { spotifyPlugin } from '@/plugins/builtin/spotify'
import { spotifyTokenFixture } from '@/plugins/builtin/__tests__/fixtures/spotify'
import { tidalPlugin } from '@/plugins/builtin/tidal'
import * as schema from '@/schemas/db'

const database = `tidal_similar_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
const request = vi.fn<typeof fetch>()
let spotifyMarket: string | undefined
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async (id: string) =>
    id === 'tidal' ? tidalPlugin : id === 'spotify' ? spotifyPlugin : null,
  listLoadedScrapePlugins: async () => [tidalPlugin, spotifyPlugin],
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: (provider: string) =>
    provider === 'tidal'
      ? {
          clientId: 'offline-fixture-client',
          clientSecret: 'offline-fixture-secret',
        }
      : {
          clientId: 'offline-spotify-client',
          clientSecret: 'offline-spotify-secret',
          ...(spotifyMarket ? { market: spotifyMarket } : {}),
        },
}))

import { getJob, processQueuedJobs } from '@/services/jobs'
import { readProviderResponseAttempt } from '@/services/provider-response-history'
import {
  ProviderTaskReplayStepsSchema,
  replayProviderTask,
} from '@/services/provider-task-replay'
import {
  getTidalSimilar,
  refreshTidalSimilar,
  suggestionsNeedingSpotify,
} from '@/services/tidal-similar'
import {
  acceptTidalTrackMatch,
  getTidalTrackMatch,
} from '@/services/tidal-track-match'

const userId = 'fixture-owner'
const albumId = 'album-seed'
const trackId = 'track-seed'
const spotifyId = (n: number) => `fixturespotify${String(n).padStart(8, '0')}`
const isrc = (n: number) => `QZFX2${2800000 + n}`

const artist = (id: string, name: string) => ({
  id,
  type: 'artists',
  attributes: { name },
})
const link = (kind: string, id: string) => [
  {
    href: `https://tidal.com/browse/${kind}/${id}`,
    meta: { type: 'TIDAL_SHARING' },
  },
]
const tidalAlbum = (id: string, title: string, barcodeId: string | null) => ({
  id,
  type: 'albums',
  attributes: {
    title,
    ...(barcodeId ? { barcodeId } : {}),
    albumType: 'ALBUM',
    releaseDate: '2023-04-01',
    duration: 'PT40M',
    externalLinks: link('album', id),
  },
  relationships: { artists: { data: [{ id: '700001', type: 'artists' }] } },
})
const tidalTrack = (id: string, title: string, code: string) => ({
  id,
  type: 'tracks',
  attributes: {
    title,
    isrc: code,
    duration: 'PT5M48S',
    externalLinks: link('track', id),
  },
  relationships: {
    artists: {
      data: [
        { id: '700001', type: 'artists' },
        { id: '700002', type: 'artists' },
      ],
    },
  },
})
const similar = (items: { id: string; type: string }[]) => ({
  data: items.map(({ id, type }) => ({ id, type })),
  included: [
    ...items,
    artist('700001', 'Halcyon Grid'),
    artist('700002', 'Vela Rooms'),
  ],
  links: { self: '/similar' },
})

const externalAlbumGenre = {
  id: 'synthetic-album-genre',
  type: 'genres',
  attributes: { genreName: 'Ambient' },
}
const concreteBloom = tidalAlbum('810003', 'Concrete Bloom', '000000000055')
const externalAlbum = {
  ...concreteBloom,
  relationships: {
    ...concreteBloom.relationships,
    genres: { data: [{ id: externalAlbumGenre.id, type: 'genres' }] },
  },
}

// Albums: one in the library by UPC (13 digits there, 12 here), one on
// Spotify, one Spotify does not have and one without a barcode.
const albumList = similar([
  tidalAlbum('810001', 'Pressure Systems', '000000000031'),
  tidalAlbum('810002', 'Night Shift Utopia', '0000000000048'),
  externalAlbum,
  tidalAlbum('810004', 'Tunnel Vision EP', null),
])
const similarAlbums = {
  ...albumList,
  included: [...albumList.included, externalAlbumGenre],
}
// Tracks: one in the library by ISRC reference, one whose Spotify tracks
// include a library track, one on Spotify only and one Spotify lacks.
const similarTracks = similar([
  tidalTrack('820001', 'Glass Arcade', isrc(1)),
  tidalTrack('820002', 'Afterhours Telex', isrc(2)),
  tidalTrack('820003', 'Halogen', isrc(3)),
  tidalTrack('820004', 'Lantern Code', isrc(4)),
])

const spotifyTrack = (
  n: number,
  code: string,
  albumType: 'album' | 'single' | 'compilation',
  releaseDate: string,
) => ({
  type: 'track',
  id: spotifyId(n),
  name: `Spotify ${n}`,
  duration_ms: 348000,
  artists: [{ id: spotifyId(900), name: 'Halcyon Grid' }],
  album: {
    id: spotifyId(n + 100),
    name: `Release ${n}`,
    album_type: albumType,
    release_date: releaseDate,
    images: [{ url: `https://i.scdn.co/image/fixture${n}` }],
  },
  external_ids: { isrc: code },
})
const trackSearches = new Map<string, unknown[]>([
  [
    isrc(2),
    [
      spotifyTrack(21, isrc(2), 'compilation', '2019-01-01'),
      spotifyTrack(22, isrc(2), 'album', '2021-01-01'),
    ],
  ],
  [
    isrc(3),
    [
      spotifyTrack(31, isrc(3), 'compilation', '2018-01-01'),
      spotifyTrack(32, isrc(3), 'album', '2022-05-01'),
      spotifyTrack(33, isrc(3), 'single', '2021-03-01'),
      // Another recording on the same page is left out.
      spotifyTrack(34, isrc(9), 'single', '2010-01-01'),
    ],
  ],
  [isrc(4), []],
])
const albumSearches = new Map<string, unknown[]>([
  [
    '0000000000048',
    [
      {
        id: spotifyId(48),
        name: 'Night Shift Utopia',
        artists: [{ id: spotifyId(901), name: 'Vela Rooms' }],
        images: [{ url: 'https://i.scdn.co/image/fixture48' }],
        total_tracks: 9,
        genres: [' House ', 'house', 'Deep House'],
      },
    ],
  ],
  ['000000000055', []],
])

function mockProviders() {
  request.mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.href === 'https://auth.tidal.com/v1/oauth2/token')
      return Response.json({
        access_token: 'offline-fixture-token',
        expires_in: 14400,
        token_type: 'Bearer',
      })
    if (url.hostname === 'accounts.spotify.com')
      return Response.json(spotifyTokenFixture)
    // TIDAL has no album with the unmatched album's UPC.
    if (
      url.pathname === '/v2/albums' &&
      url.searchParams.get('filter[barcodeId]') === '000000000066'
    )
      return Response.json({ data: [], links: { self: '/albums' } })
    if (url.pathname === '/v2/albums/800001/relationships/similarAlbums')
      return Response.json(similarAlbums)
    if (url.pathname === '/v2/tracks/800002/relationships/similarTracks')
      return Response.json(similarTracks)
    // A TIDAL ID that no longer exists.
    if (url.pathname === '/v2/tracks/899999/relationships/similarTracks')
      return Response.json(
        { errors: [{ status: '404', code: 'NOT_FOUND' }] },
        { status: 404 },
      )
    // A track match by ISRC: TIDAL has the Sonovault track's recording as
    // 800002, two tracks for isrc(62) and nothing for isrc(61).
    if (url.pathname === '/v2/tracks' && url.searchParams.has('filter[isrc]'))
      return Response.json({
        data:
          url.searchParams.get('filter[isrc]') === isrc(60)
            ? [{ ...tidalTrack('800002', 'Signal Fade', isrc(60)) }]
            : url.searchParams.get('filter[isrc]') === isrc(62)
              ? [
                  tidalTrack('800003', 'Twin Signal', isrc(62)),
                  tidalTrack('800004', 'Twin Signal', isrc(62)),
                ]
              : [],
        included: [],
        links: { self: '/tracks' },
      })
    if (url.href.startsWith('https://api.spotify.com/v1/search')) {
      const query = url.searchParams.get('q') ?? ''
      const [field, code = ''] = query.split(':')
      if (field === 'isrc' && trackSearches.has(code))
        return Response.json({
          tracks: { items: trackSearches.get(code), offset: 0, total: 1 },
        })
      if (field === 'upc' && albumSearches.has(code))
        return Response.json({
          albums: { items: albumSearches.get(code), offset: 0, total: 1 },
        })
    }
    throw new Error(`Unexpected request ${url.href}`)
  })
}

const reference = (
  id: string,
  mediaItemId: string,
  provider: string,
  referenceType: string,
  externalId: string,
  metadata: Record<string, string> = {},
) => ({ id, mediaItemId, provider, referenceType, externalId, metadata })

/** A Sonovault record's TIDAL link, as the Sonovault lookup stores it. */
const sonovaultTidal = (
  id: string,
  mediaItemId: string,
  tidalId: string,
  verified: boolean,
  responseId = 'fixture-sonovault-response',
) => ({
  id,
  mediaItemId,
  provider: 'sonovault',
  referenceType: 'tidal-track',
  externalId: tidalId,
  metadata: {
    url: `https://tidal.com/browse/track/${tidalId}`,
    verified,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    responseId,
    jobId: 'fixture-sonovault-job',
    inputType: 'spotify_id',
  },
})

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
  await databaseClient
    .insert(schema.user)
    .values({ id: userId, name: 'Fixture Owner', email: 'owner@example.test' })
})
beforeEach(async () => {
  clearTidalTokenCache()
  spotifyMarket = 'AU'
  request.mockReset()
  mockProviders()
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.artist)
  await databaseClient.delete(schema.tag)
  await databaseClient.delete(schema.spotifyCodeLookup)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.delete(schema.providerRequestEvent)
  const albums = [
    [albumId, 'Afterglow Circuit'],
    ['album-library', 'Pressure Systems'],
    ['album-unmatched', 'Second Floor'],
  ] as const
  await databaseClient.insert(schema.mediaItem).values([
    ...albums.map(([id, title]) => ({
      id,
      slug: id,
      title,
      mediaType: 'album' as const,
    })),
    ...[
      [trackId, 'Signal Fade'],
      ['track-library', 'Glass Arcade'],
      ['track-spotify-library', 'Afterhours Telex (Album)'],
      ['track-unmatched', 'Wet Pavement'],
      ['track-sonovault', 'Signal Fade (Single)'],
    ].map(([id, title]) => ({
      id,
      slug: id,
      title,
      mediaType: 'track' as const,
    })),
  ])
  await databaseClient.insert(schema.album).values(
    albums.map(([id]) => ({
      mediaItemId: id,
      trackCount: 9,
      ...(id === 'album-library'
        ? { spotifyUrl: `https://open.spotify.com/album/${spotifyId(31)}` }
        : {}),
    })),
  )
  await databaseClient
    .insert(schema.libraryTrack)
    .values([
      { mediaItemId: trackId },
      { mediaItemId: 'track-library', spotifyTrackId: spotifyId(11) },
      { mediaItemId: 'track-spotify-library', spotifyTrackId: spotifyId(22) },
      { mediaItemId: 'track-unmatched' },
      { mediaItemId: 'track-sonovault', isrc: isrc(60) },
    ])
  await databaseClient.insert(schema.providerReference).values([
    reference('r1', albumId, 'tidal', 'album', '800001'),
    reference('r2', 'album-library', 'spotify', 'upc', '0000000000031', {
      sourceProvider: 'spotify',
    }),
    reference('r3', trackId, 'tidal', 'track', '800002'),
    reference('r4', 'track-library', 'spotify', 'isrc', isrc(1)),
  ])
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

/** Runs the queued Spotify and Sonovault lookups, waiting out each provider's spacing. */
async function runQueued() {
  for (let round = 0; round < 20; round += 1) {
    const [queued] = await databaseClient
      .select({ provider: schema.scrapeJob.provider })
      .from(schema.scrapeJob)
      .where(eq(schema.scrapeJob.status, 'queued'))
      .limit(1)
    if (!queued) return
    const [gate] = await databaseClient
      .select({ nextAllowedAt: schema.providerRequestState.nextAllowedAt })
      .from(schema.providerRequestState)
      .where(eq(schema.providerRequestState.provider, queued.provider))
    const wait = (gate?.nextAllowedAt?.getTime() ?? 0) - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait + 50))
    await processQueuedJobs()
  }
  throw new Error('Queued jobs did not finish')
}

const tidalPaths = () =>
  request.mock.calls.flatMap(([input]) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    return url.hostname === 'openapi.tidal.com'
      ? [
          `${url.pathname}${url.searchParams.has('filter[isrc]') ? `?isrc=${url.searchParams.get('filter[isrc]')}` : ''}`,
        ]
      : []
  })

const similarJobs = (task: string, itemKey: string, id: string) =>
  databaseClient
    .select({
      status: schema.scrapeJob.status,
      options: schema.scrapeJob.options,
    })
    .from(schema.scrapeJob)
    .where(
      sql`${schema.scrapeJob.options}->>'task' = ${task} and ${schema.scrapeJob.options}->>${itemKey} = ${id}`,
    )
    .orderBy(schema.scrapeJob.createdAt)

const searches = () =>
  request.mock.calls.flatMap(([input]) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    return url.pathname === '/v1/search'
      ? [url.searchParams.get('q') ?? '']
      : []
  })

describe('TIDAL similar items in the request, with offline HTTP', () => {
  it('reads similar albums, maps them to the library and Spotify, and keeps the responses', async () => {
    await databaseClient.insert(schema.tag).values([
      {
        id: 'fixture-album-genre',
        mediaType: 'album',
        name: 'Synth Pop',
        kind: 'genre',
      },
      {
        id: 'fixture-hidden-genre',
        mediaType: 'album',
        name: 'Hidden Genre',
        kind: 'genre',
        hidden: true,
      },
      {
        id: 'fixture-collection-tag',
        mediaType: 'album',
        name: 'Do not include',
        kind: 'general',
      },
    ])
    await databaseClient
      .insert(schema.mediaItemTag)
      .values(
        [
          'fixture-album-genre',
          'fixture-hidden-genre',
          'fixture-collection-tag',
        ].map((tagId) => ({ mediaItemId: 'album-library', tagId })),
      )
    const read = await refreshTidalSimilar(
      { kind: 'albums', id: albumId },
      userId,
    )
    // The TIDAL read is done; only the Spotify lookup is queued.
    expect(read).toMatchObject({
      kind: 'album',
      matched: true,
      readAt: expect.any(String),
      job: { status: 'succeeded' },
      lookupJob: { status: 'queued' },
    })
    expect(read.items).toHaveLength(4)
    expect(read.items[0]).toMatchObject({
      genres: ['Synth Pop'],
      genreSource: 'library',
    })
    expect(read.items[2]).toMatchObject({
      genres: ['Ambient'],
      genreSource: 'tidal',
    })
    expect(read.items[3]).toMatchObject({ genres: [], genreSource: null })
    await runQueued()
    const result = await getTidalSimilar({ kind: 'albums', id: albumId })
    expect(result.job?.status).toBe('succeeded')
    expect(result.lookupJob?.status).toBe('succeeded')
    expect(result.readAt).toEqual(expect.any(String))
    expect(
      result.items.map(({ tidalId, state, artists }) => ({
        tidalId,
        state,
        artists,
      })),
    ).toEqual([
      { tidalId: '810001', state: 'library', artists: ['Halcyon Grid'] },
      { tidalId: '810002', state: 'spotify', artists: ['Halcyon Grid'] },
      { tidalId: '810003', state: 'none', artists: ['Halcyon Grid'] },
      { tidalId: '810004', state: 'unsearched', artists: ['Halcyon Grid'] },
    ])
    expect(result.items[0]?.library).toEqual({
      id: 'album-library',
      title: 'Pressure Systems',
      artworkUrl: null,
      spotifyId: spotifyId(31),
      album: null,
      albumName: null,
      trackCount: 9,
    })
    expect(result.items[1]?.spotify).toEqual({
      spotifyId: spotifyId(48),
      url: `https://open.spotify.com/album/${spotifyId(48)}`,
      title: 'Night Shift Utopia',
      artists: ['Vela Rooms'],
      albumName: null,
      spotifyAlbumId: spotifyId(48),
      artworkUrl: 'https://i.scdn.co/image/fixture48',
      durationSec: null,
      trackCount: 9,
      genres: ['House', 'Deep House'],
    })
    expect(result.items[1]).toMatchObject({
      genres: ['House', 'Deep House'],
      genreSource: 'spotify',
    })
    expect(result.items[2]).toMatchObject({
      url: 'https://tidal.com/browse/album/810003',
      spotify: null,
      library: null,
    })
    // The library album and the album without a barcode are not searched;
    // a UPC is searched as TIDAL wrote it.
    expect(searches()).toEqual(['upc:0000000000048', 'upc:000000000055'])

    if (!result.job || !result.lookupJob) throw new Error('Missing jobs')
    const job = await getJob(result.job.jobId)
    expect(job?.provider).toBe('tidal')
    expect(job?.scope).toEqual({
      mediaType: 'album',
      mediaItemIds: [albumId],
      limit: 1,
    })
    const tidalResponses = await readProviderResponseAttempt({
      jobId: result.job.jobId,
      attempt: 1,
    })
    expect(tidalResponses.map(({ capture }) => capture.request.url)).toEqual([
      'https://openapi.tidal.com/v2/albums/800001/relationships/similarAlbums',
    ])
    const lookupJob = await getJob(result.lookupJob.jobId)
    expect(lookupJob?.provider).toBe('spotify')
    const spotifyResponses = await readProviderResponseAttempt({
      jobId: result.lookupJob.jobId,
      attempt: 1,
    })
    expect(spotifyResponses).toHaveLength(2)
    expect(JSON.stringify([tidalResponses, spotifyResponses])).not.toMatch(
      /offline-fixture-(secret|token)|offline-spotify-secret|fake-access-token/,
    )

    const jobs = await databaseClient
      .select({
        provider: schema.scrapeJob.provider,
        options: schema.scrapeJob.options,
      })
      .from(schema.scrapeJob)
      .where(
        inArray(schema.scrapeJob.id, [
          result.job.jobId,
          result.lookupJob.jobId,
        ]),
      )
    const tidalJob = jobs.find(({ provider }) => provider === 'tidal')
    const spotifyJob = jobs.find(({ provider }) => provider === 'spotify')
    if (!tidalJob || !spotifyJob) throw new Error('Missing jobs')
    const tidalReplay = await replayProviderTask(
      TIDAL_SIMILAR_TASK,
      'tidal',
      ProviderTaskReplayStepsSchema.parse(tidalJob.options.providerReplaySteps),
      tidalResponses.map(({ capture }) => capture),
    )
    expect(tidalReplay).toEqual([
      expect.arrayContaining([expect.objectContaining({ tidalId: '810001' })]),
    ])
    const spotifyReplay = await replayProviderTask(
      SPOTIFY_SIMILAR_LOOKUP_TASK,
      'spotify',
      ProviderTaskReplayStepsSchema.parse(
        spotifyJob.options.providerReplaySteps,
      ),
      spotifyResponses.map(({ capture }) => capture),
    )
    expect(spotifyReplay).toHaveLength(2)
  }, 30000)

  it('uses exact Spotify album membership and separately identifies artist genres', async () => {
    await databaseClient.insert(schema.artist).values({
      id: 'fixture-artist',
      name: 'Halcyon Grid',
    })
    await databaseClient.insert(schema.artistProviderSnapshot).values({
      id: 'fixture-artist-snapshot',
      artistId: 'fixture-artist',
      provider: 'fixture',
      payload: {},
      normalizedData: { tags: ['Acid House', 'Not a genre'] },
    })
    await databaseClient.insert(schema.artistProviderCurrentState).values({
      artistId: 'fixture-artist',
      provider: 'fixture',
      latestSnapshotId: 'fixture-artist-snapshot',
    })
    await databaseClient.insert(schema.tag).values([
      {
        id: 'fixture-artist-genre',
        mediaType: 'album',
        name: 'Acid House',
        kind: 'genre',
      },
      {
        id: 'fixture-artist-tag',
        mediaType: 'album',
        name: 'Not a genre',
        kind: 'general',
      },
      {
        id: 'fixture-track-genre',
        mediaType: 'album',
        name: 'Deep House',
        kind: 'subgenre',
      },
      {
        id: 'fixture-unverified-genre',
        mediaType: 'album',
        name: 'Unverified',
        kind: 'genre',
      },
    ])
    await databaseClient
      .update(schema.libraryTrack)
      .set({ spotifyAlbumId: spotifyId(48) })
      .where(eq(schema.libraryTrack.mediaItemId, 'track-library'))
    await databaseClient.insert(schema.trackTag).values([
      {
        mediaItemId: 'track-library',
        tagId: 'fixture-track-genre',
        sonovault: true,
        verified: true,
      },
      {
        mediaItemId: 'track-library',
        tagId: 'fixture-unverified-genre',
        sonovault: true,
        verified: false,
      },
    ])
    await refreshTidalSimilar({ kind: 'albums', id: albumId }, userId)
    await runQueued()
    // Lookup results saved before genre hydration have no genres property.
    await databaseClient
      .update(schema.spotifyCodeLookup)
      .set({ result: sql`${schema.spotifyCodeLookup.result} - 'genres'` })
      .where(eq(schema.spotifyCodeLookup.code, '48'))
    const result = await getTidalSimilar({ kind: 'albums', id: albumId })
    expect(result.items[1]).toMatchObject({
      state: 'spotify',
      genres: ['Deep House'],
      genreSource: 'album-tracks',
      genreArtist: null,
    })
    expect(result.items[3]).toMatchObject({
      genres: ['Acid House'],
      genreSource: 'artist',
      genreArtist: { id: 'fixture-artist', name: 'Halcyon Grid' },
    })
    // A TIDAL reference without a barcode still marks the suggestion as saved.
    await databaseClient
      .insert(schema.providerReference)
      .values(
        reference(
          'fixture-tidal-only',
          'album-unmatched',
          'tidal',
          'album',
          '810004',
        ),
      )
    const added = await getTidalSimilar({ kind: 'albums', id: albumId })
    expect(added.items[3]).toMatchObject({
      state: 'library',
      library: { id: 'album-unmatched' },
      genres: ['Acid House'],
      genreSource: 'artist',
    })
    await databaseClient
      .insert(schema.providerReference)
      .values(
        reference(
          'fixture-tidal-no-upc',
          'album-unmatched',
          'tidal',
          'album',
          '810002',
        ),
      )
    await databaseClient
      .delete(schema.spotifyCodeLookup)
      .where(eq(schema.spotifyCodeLookup.code, '48'))
    expect(
      await suggestionsNeedingSpotify(
        databaseClient,
        'album',
        result.items.filter(({ tidalId }) => tidalId === '810002'),
      ),
    ).toEqual([])
  }, 30000)

  it('chooses Spotify tracks by library, then the earliest release that is not a compilation', async () => {
    await refreshTidalSimilar({ kind: 'tracks', id: trackId }, userId)
    await runQueued()
    const result = await getTidalSimilar({ kind: 'tracks', id: trackId })
    expect(
      result.items.map(({ title, state, library, spotify }) => ({
        title,
        state,
        library: library?.id ?? null,
        spotify: spotify?.spotifyId ?? null,
      })),
    ).toEqual([
      {
        title: 'Glass Arcade',
        state: 'library',
        library: 'track-library',
        spotify: null,
      },
      {
        title: 'Afterhours Telex',
        state: 'library',
        library: 'track-spotify-library',
        spotify: spotifyId(22),
      },
      {
        title: 'Halogen',
        state: 'spotify',
        library: null,
        spotify: spotifyId(33),
      },
      {
        title: 'Lantern Code',
        state: 'none',
        library: null,
        spotify: null,
      },
    ])
    expect(result.items[1]?.artists).toEqual(['Halcyon Grid', 'Vela Rooms'])
    expect(result.items[2]?.durationSec).toBe(348)
    expect(searches()).toEqual([
      `isrc:${isrc(2)}`,
      `isrc:${isrc(3)}`,
      `isrc:${isrc(4)}`,
    ])

    // A second read searches Spotify only for what it has not searched.
    request.mockClear()
    await refreshTidalSimilar({ kind: 'tracks', id: trackId }, userId)
    await runQueued()
    expect(searches()).toEqual([])
    const again = await getTidalSimilar({ kind: 'tracks', id: trackId })
    expect(again.items.map(({ state }) => state)).toEqual([
      'library',
      'library',
      'spotify',
      'none',
    ])
  }, 30000)

  it('leaves suggestions unsearched when Spotify cannot search', async () => {
    spotifyMarket = undefined
    await refreshTidalSimilar({ kind: 'albums', id: albumId }, userId)
    await runQueued()
    const result = await getTidalSimilar({ kind: 'albums', id: albumId })
    expect(result.lookupJob).toBeNull()
    expect(result.items.map(({ state }) => state)).toEqual([
      'library',
      'unsearched',
      'unsearched',
      'unsearched',
    ])
    if (!result.job) throw new Error('Missing job')
    const [log] = await databaseClient
      .select({ message: schema.scrapeJobLog.message })
      .from(schema.scrapeJobLog)
      .where(eq(schema.scrapeJobLog.jobId, result.job.jobId))
      .orderBy(schema.scrapeJobLog.createdAt)
      .then((rows) => rows.slice(-1))
    expect(log?.message).toMatch(/Not looked up on Spotify/)
    expect(searches()).toEqual([])
  }, 30000)

  it('matches an item not matched yet in the request', async () => {
    const track = await refreshTidalSimilar(
      { kind: 'tracks', id: 'track-unmatched' },
      userId,
    ).catch((error: unknown) => error)
    // The track has no ISRC, so it cannot be matched.
    expect(track).toMatchObject({
      response: { statusCode: 409 },
    })
    await expect(
      refreshTidalSimilar({ kind: 'albums', id: 'album-unmatched' }, userId),
    ).rejects.toMatchObject({ response: { statusCode: 409 } })

    await databaseClient
      .insert(schema.providerReference)
      .values(
        reference('r5', 'album-unmatched', 'spotify', 'upc', '000000000066'),
      )
    const album = await refreshTidalSimilar(
      { kind: 'albums', id: 'album-unmatched' },
      userId,
    )
    expect(album).toMatchObject({
      matched: false,
      matchJob: {
        status: 'failed',
        errorMessage: expect.stringMatching(/no album with this UPC/),
      },
      job: null,
      items: [],
    })
    expect(
      await databaseClient
        .select({ status: schema.scrapeJob.status })
        .from(schema.scrapeJob)
        .where(eq(schema.scrapeJob.status, 'queued')),
    ).toEqual([])
    await expect(
      getTidalSimilar({ kind: 'albums', id: trackId }),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
  })
})

describe('the TIDAL ID of a similar-tracks read (SONO-27)', () => {
  it('reads with the TIDAL match and says so', async () => {
    const result = await refreshTidalSimilar(
      { kind: 'tracks', id: trackId },
      userId,
    )
    expect(result.source).toEqual({
      kind: 'tidal',
      tidalId: '800002',
      jobId: null,
    })
    expect(tidalPaths()).toEqual([
      '/v2/tracks/800002/relationships/similarTracks',
    ])
  })

  it('reads a track with a verified Sonovault TIDAL ID without matching it first', async () => {
    await databaseClient
      .insert(schema.providerReference)
      .values(sonovaultTidal('s1', 'track-sonovault', '800002', true))
    const before = await getTidalSimilar({
      kind: 'tracks',
      id: 'track-sonovault',
    })
    // The tab reads it as it does a matched track.
    expect(before).toMatchObject({ matched: true, job: null, source: null })
    const result = await refreshTidalSimilar(
      { kind: 'tracks', id: 'track-sonovault' },
      userId,
    )
    expect(tidalPaths()).toEqual([
      '/v2/tracks/800002/relationships/similarTracks',
    ])
    expect(
      await similarJobs(TIDAL_TRACK_MATCH_TASK, 'trackId', 'track-sonovault'),
    ).toEqual([])
    expect(result).toMatchObject({
      matched: true,
      matchJob: null,
      job: { status: 'succeeded' },
      source: {
        kind: 'sonovault',
        tidalId: '800002',
        jobId: 'fixture-sonovault-job',
      },
    })
    expect(result.items).toHaveLength(4)
    if (!result.job) throw new Error('Missing job')
    const responses = await readProviderResponseAttempt({
      jobId: result.job.jobId,
      attempt: 1,
    })
    expect(responses.map(({ capture }) => capture.request.url)).toEqual([
      'https://openapi.tidal.com/v2/tracks/800002/relationships/similarTracks',
    ])
    const [log] = await databaseClient
      .select({ message: schema.scrapeJobLog.message })
      .from(schema.scrapeJobLog)
      .where(eq(schema.scrapeJobLog.jobId, result.job.jobId))
      .orderBy(schema.scrapeJobLog.createdAt)
      .then((rows) => rows.slice(-1))
    expect(log?.message).toMatch(/with the TIDAL ID from Sonovault/)
  })

  it('matches first when the Sonovault record is not verified', async () => {
    await databaseClient
      .insert(schema.providerReference)
      .values(sonovaultTidal('s1', 'track-sonovault', '800002', false))
    const before = await getTidalSimilar({
      kind: 'tracks',
      id: 'track-sonovault',
    })
    expect(before.matched).toBe(false)
    const result = await refreshTidalSimilar(
      { kind: 'tracks', id: 'track-sonovault' },
      userId,
    )
    expect(tidalPaths()).toEqual([`/v2/tracks?isrc=${isrc(60)}`])
    expect(result).toMatchObject({
      matched: true,
      matchJob: { status: 'succeeded' },
      job: null,
    })
  })

  it("prefers the owner's TIDAL choice to Sonovault's", async () => {
    await databaseClient.insert(schema.providerReference).values([
      reference('r6', 'track-sonovault', 'tidal', 'track', '800002', {
        source: 'tidal-track-match',
        matchReason: 'manual',
        jobId: 'fixture-review-job',
        recordedAt: '2026-01-01T00:00:00.000Z',
      }),
      sonovaultTidal('s1', 'track-sonovault', '899999', true),
    ])
    const result = await refreshTidalSimilar(
      { kind: 'tracks', id: 'track-sonovault' },
      userId,
    )
    expect(tidalPaths()).toEqual([
      '/v2/tracks/800002/relationships/similarTracks',
    ])
    expect(result.source).toEqual({
      kind: 'tidal',
      tidalId: '800002',
      jobId: 'fixture-review-job',
    })
  })

  it('matches and reads once when TIDAL does not know the Sonovault ID, and keeps off that ID until the record changes', async () => {
    await databaseClient
      .insert(schema.providerReference)
      .values(sonovaultTidal('s1', 'track-sonovault', '899999', true))
    const result = await refreshTidalSimilar(
      { kind: 'tracks', id: 'track-sonovault' },
      userId,
    )
    expect(tidalPaths()).toEqual([
      '/v2/tracks/899999/relationships/similarTracks',
      `/v2/tracks?isrc=${isrc(60)}`,
      '/v2/tracks/800002/relationships/similarTracks',
    ])
    expect(result).toMatchObject({
      matched: true,
      matchJob: { status: 'succeeded' },
      job: { status: 'succeeded' },
      source: { kind: 'tidal', tidalId: '800002' },
    })
    expect(result.items).toHaveLength(4)
    const reads = await similarJobs(
      TIDAL_SIMILAR_TASK,
      'itemId',
      'track-sonovault',
    )
    expect(
      reads.map(({ status, options }) => [
        status,
        options.tidalId,
        options.tidalIdDead ?? null,
      ]),
    ).toEqual([
      ['succeeded', '899999', true],
      ['succeeded', '800002', null],
    ])
    // A missing ID is not a TIDAL failure.
    const [gate] = await databaseClient
      .select({ failureCount: schema.providerRequestState.failureCount })
      .from(schema.providerRequestState)
      .where(eq(schema.providerRequestState.provider, 'tidal'))
    expect(gate?.failureCount ?? 0).toBe(0)
  }, 30000)

  it('does not try a dead Sonovault ID again until its record is refreshed', async () => {
    await databaseClient
      .update(schema.libraryTrack)
      .set({ isrc: isrc(61) })
      .where(eq(schema.libraryTrack.mediaItemId, 'track-sonovault'))
    await databaseClient
      .insert(schema.providerReference)
      .values(sonovaultTidal('s1', 'track-sonovault', '899999', true))
    // TIDAL has no track for the ISRC either.
    const first = await refreshTidalSimilar(
      { kind: 'tracks', id: 'track-sonovault' },
      userId,
    )
    expect(first.matched).toBe(false)
    expect(tidalPaths()).toEqual([
      '/v2/tracks/899999/relationships/similarTracks',
      `/v2/tracks?isrc=${isrc(61)}`,
    ])
    request.mockClear()
    await refreshTidalSimilar({ kind: 'tracks', id: 'track-sonovault' }, userId)
    expect(tidalPaths()).toEqual([`/v2/tracks?isrc=${isrc(61)}`])

    // A refreshed record is a new response: its ID is tried again.
    await databaseClient
      .update(schema.providerReference)
      .set({
        metadata: sonovaultTidal(
          's1',
          'track-sonovault',
          '899999',
          true,
          'fixture-sonovault-response-2',
        ).metadata,
      })
      .where(eq(schema.providerReference.id, 's1'))
    request.mockClear()
    await refreshTidalSimilar({ kind: 'tracks', id: 'track-sonovault' }, userId)
    expect(tidalPaths()[0]).toBe(
      '/v2/tracks/899999/relationships/similarTracks',
    )
  }, 30000)
})

describe('why a track is not matched on TIDAL', () => {
  it('counts the TIDAL tracks waiting for review until the owner chooses one', async () => {
    await databaseClient.insert(schema.mediaItem).values({
      id: 'track-review',
      slug: 'track-review',
      title: 'Twin Signal',
      mediaType: 'track',
    })
    await databaseClient
      .insert(schema.libraryTrack)
      .values({ mediaItemId: 'track-review', isrc: isrc(62) })
    const result = await refreshTidalSimilar(
      { kind: 'tracks', id: 'track-review' },
      userId,
    )
    expect(tidalPaths()).toEqual([`/v2/tracks?isrc=${isrc(62)}`])
    expect(result).toMatchObject({
      matched: false,
      matchJob: { status: 'succeeded' },
      unmatched: { reason: 'review', candidateCount: 2 },
      job: null,
    })
    const review = await getTidalTrackMatch('track-review')
    if (!review.job) throw new Error('Missing match job')
    await acceptTidalTrackMatch({
      trackId: 'track-review',
      jobId: review.job.jobId,
      tidalTrackId: '800004',
    })
    // Matched and not read yet: the tab reads it next.
    expect(
      await getTidalSimilar({ kind: 'tracks', id: 'track-review' }),
    ).toMatchObject({ matched: true, unmatched: null, job: null, readAt: null })
  })

  it('says when a track has no ISRC or TIDAL has no track with it', async () => {
    expect(
      await getTidalSimilar({ kind: 'tracks', id: 'track-unmatched' }),
    ).toMatchObject({
      matched: false,
      matchJob: null,
      unmatched: { reason: 'no-isrc' },
    })
    await databaseClient
      .update(schema.libraryTrack)
      .set({ isrc: isrc(61) })
      .where(eq(schema.libraryTrack.mediaItemId, 'track-sonovault'))
    expect(
      await getTidalSimilar({ kind: 'tracks', id: 'track-sonovault' }),
    ).toMatchObject({ matched: false, matchJob: null, unmatched: null })
    const result = await refreshTidalSimilar(
      { kind: 'tracks', id: 'track-sonovault' },
      userId,
    )
    expect(result).toMatchObject({
      matched: false,
      matchJob: { status: 'failed' },
      unmatched: { reason: 'not-found', isrc: isrc(61) },
    })
    expect(
      (await getTidalSimilar({ kind: 'albums', id: 'album-unmatched' }))
        .unmatched,
    ).toBeNull()
  })
})
