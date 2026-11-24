import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ProviderResponseSchema } from '@repo/schemas/provider-response'
import {
  SPOTIFY_PLAYLIST_IMPORT_TASK,
  SPOTIFY_PLAYLIST_LISTING_TASK,
  PlaylistBrowseQuerySchema,
  PlaylistDetailQuerySchema,
} from '@repo/schemas/tracks'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { spotifyPlugin } from '@/plugins/builtin/spotify'

const database = `spotify_playlist_responses_${randomUUID().replaceAll('-', '')}`
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
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
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
    redirectUri: 'http://127.0.0.1:3000/api/v1/spotify/callback',
  }),
}))
// Only the account token is replaced: the Spotify operation, its request
// gate and its response recorder are the ones the jobs use.
vi.mock('@/services/spotify-oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/spotify-oauth')>()),
  getSpotifyAccountStatus: async () => ({
    configured: true,
    connected: true,
    playlists: true,
    playlistChanges: true,
  }),
  spotifyPlaylistToken: async () => 'fixture-access-token',
}))
import { processQueuedJobs } from '@/services/jobs'
import {
  getJobProviderResponse,
  listJobProviderResponses,
} from '@/services/provider-response-history'
import { queueSpotifyPlaylistListing } from '@/services/spotify-playlist-listing'
import { queueSpotifyPlaylistImports } from '@/services/spotify-playlists'
import { listPlaylistBrowsePage } from '@/services/playlist-directory'
import { getPlaylistDetail } from '@/services/tracks'
import { observePlaybackCatalog } from '@/services/playback-catalog'
import { backfillMusicCatalog } from '@/services/music-catalog-backfill'
import { promoteCatalogMedia } from '@/services/catalog-discoveries'
import { PlaybackCatalogInputSchema } from '@repo/schemas/playback'

const USER_ID = 'response-user'
const PLAYLIST = 'responses'.padEnd(22, '0')
const playlist = {
  id: PLAYLIST,
  name: 'Fixture Mix',
  snapshot_id: 'snapshot-1',
  owner: { id: 'owner', display_name: 'Owner' },
  items: { total: 3 },
}
const entry = {
  added_at: '2024-03-01T10:00:00Z',
  added_by: { id: 'fixture-adder' },
  item: {
    type: 'track',
    id: 'fixturetrack'.padEnd(22, '0'),
    name: 'Fixture Track',
    duration_ms: 200400,
    artists: [{ name: 'The Examples' }],
    album: { id: 'fixturealbum'.padEnd(22, '0'), name: 'Fixture Album' },
  },
}

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  request.mockImplementation(async (input) => {
    const { pathname } = new URL(String(input))
    if (pathname === '/v1/me') return Response.json({ id: 'owner' })
    if (pathname === '/v1/me/playlists')
      return Response.json({
        items: [playlist],
        total: 1,
        offset: 0,
        next: null,
      })
    if (pathname === `/v1/playlists/${PLAYLIST}`) return Response.json(playlist)
    if (pathname === `/v1/playlists/${PLAYLIST}/items`)
      return Response.json({
        items: [
          entry,
          entry,
          {
            item: {
              type: 'track',
              name: 'No identifier',
              artists: [{ name: 'The Examples' }],
            },
          },
        ],
        total: 3,
        offset: 0,
        next: null,
      })
    throw new Error('Unexpected offline provider request')
  })
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
  await databaseClient.insert(schema.user).values({
    id: USER_ID,
    name: 'Playlist owner',
    email: 'responses@example.com',
  })
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

const jobFor = async (task: string) => {
  const jobs = await databaseClient.select().from(schema.scrapeJob)
  const job = jobs.find((row) => row.options.task === task)
  if (!job) throw new Error(`Missing ${task} job`)
  return job
}

describe('Spotify playlist job responses', () => {
  it('stores catalogue responses on the import job and leaves out account reads', async () => {
    await queueSpotifyPlaylistListing(USER_ID)
    await processQueuedJobs()
    const listing = await jobFor(SPOTIFY_PLAYLIST_LISTING_TASK)
    expect(listing.status).toBe('succeeded')
    expect(
      (await listJobProviderResponses(listing.id, { page: 1, size: 10 }))
        .totalCount,
    ).toBe(0)
    expect(
      (await listPlaylistBrowsePage(PlaylistBrowseQuerySchema.parse({}))).items,
    ).toEqual([])
    const observed = await listPlaylistBrowsePage(
      PlaylistBrowseQuerySchema.parse({
        libraryScope: 'outside',
        discoverySources: 'playlist-listing',
      }),
    )
    expect(observed.items).toMatchObject([
      { name: 'Fixture Mix', inLibrary: false },
    ])
    const id = observed.items[0]?.id ?? ''
    expect(
      (await getPlaylistDetail(id, PlaylistDetailQuerySchema.parse({})))
        .inLibrary,
    ).toBe(false)

    // The listing's request spacing would otherwise hold the import back.
    await databaseClient.delete(schema.providerRequestState)
    await queueSpotifyPlaylistImports(
      { playlists: [{ spotifyId: PLAYLIST, name: 'Fixture Mix' }] },
      USER_ID,
    )
    await processQueuedJobs()
    const imported = await jobFor(SPOTIFY_PLAYLIST_IMPORT_TASK)
    expect(imported.status).toBe('succeeded')
    const page = await listJobProviderResponses(imported.id, {
      page: 1,
      size: 10,
    })
    expect(
      page.items.map(({ phase, requestUrl, status, bodyState }) => ({
        phase,
        requestUrl,
        status,
        bodyState,
      })),
    ).toEqual([
      {
        phase: 'task',
        requestUrl: `https://api.spotify.com/v1/playlists/${PLAYLIST}`,
        status: 200,
        bodyState: 'captured',
      },
      {
        phase: 'task',
        requestUrl: `https://api.spotify.com/v1/playlists/${PLAYLIST}/items`,
        status: 200,
        bodyState: 'captured',
      },
    ])
    const [details, items] = await Promise.all(
      page.items.map(async ({ id }) =>
        ProviderResponseSchema.parse(
          await getJobProviderResponse(imported.id, id),
        ),
      ),
    )
    if (details?.body.state !== 'captured' || items?.body.state !== 'captured')
      throw new Error('Missing stored playlist responses')
    expect(JSON.parse(details.body.text)).toMatchObject({
      id: PLAYLIST,
      name: 'Fixture Mix',
      snapshot_id: 'snapshot-1',
    })
    expect(JSON.parse(items.body.text)).toMatchObject({
      total: 3,
      items: [
        { added_at: entry.added_at, item: { name: 'Fixture Track' } },
        { added_at: entry.added_at, item: { name: 'Fixture Track' } },
        { item: { name: 'No identifier' } },
      ],
    })
    for (const text of [details.body.text, items.body.text]) {
      expect(text).not.toContain('fixture-access-token')
      expect(text).not.toContain('fixture-adder')
      expect(text).not.toContain('"owner"')
    }
    const stored = await getPlaylistDetail(
      id,
      PlaylistDetailQuerySchema.parse({}),
    )
    expect(stored.inLibrary).toBe(true)
    expect(stored.items.items).toMatchObject([
      { position: 1, track: { title: 'Fixture Track', inLibrary: true } },
      { position: 2, track: { title: 'Fixture Track', inLibrary: true } },
      { position: 3, track: { title: 'No identifier', inLibrary: false } },
    ])
    const calls = request.mock.calls.length
    const before = await databaseClient.$count(schema.catalogObservation)
    expect(await backfillMusicCatalog()).toMatchObject({
      apply: false,
      spotifyPlaylistPages: { candidates: 3, skipped: 0 },
    })
    expect(await databaseClient.$count(schema.catalogObservation)).toBe(before)
    await backfillMusicCatalog(true)
    const applied = await databaseClient.$count(schema.catalogObservation)
    await backfillMusicCatalog(true)
    expect(await databaseClient.$count(schema.catalogObservation)).toBe(applied)
    expect(request.mock.calls).toHaveLength(calls)
  })

  it('opens the observed recording, album and artist and promotes only that recording', async () => {
    const observation = PlaybackCatalogInputSchema.parse({
      operation: 'playback',
      items: [
        {
          kind: 'track',
          spotifyId: 'playing'.padEnd(22, '0'),
          title: 'Playing track',
          artists: [
            { name: 'Playing artist', spotifyId: 'artist'.padEnd(22, '0') },
          ],
          album: {
            title: 'Playing album',
            spotifyId: 'release'.padEnd(22, '0'),
          },
        },
      ],
    })
    const calls = request.mock.calls.length
    const [first, again] = await Promise.all([
      observePlaybackCatalog(observation),
      observePlaybackCatalog(observation),
    ])
    expect(again).toEqual(first)
    const item = first.items[0]
    if (!item) throw new Error('Expected an observed track')
    expect(item).toMatchObject({
      item: { id: expect.any(String), inLibrary: false },
      album: { id: expect.any(String), inLibrary: false },
      artists: [{ id: expect.any(String), name: 'Playing artist' }],
    })
    await promoteCatalogMedia(item.item.id, USER_ID)
    const next = await observePlaybackCatalog({
      ...observation,
      operation: 'playback-queue',
    })
    expect(next.items[0]).toMatchObject({
      item: { id: item.item.id, inLibrary: true },
      album: { id: item.album?.id, inLibrary: false },
    })
    const evidence = await databaseClient
      .select()
      .from(schema.catalogObservation)
    expect(
      evidence
        .filter(({ targetId }) => targetId === item.item.id)
        .map(({ operation }) => operation)
        .sort(),
    ).toEqual(['playback', 'playback-queue'])
    expect(request.mock.calls).toHaveLength(calls)
  })
})
