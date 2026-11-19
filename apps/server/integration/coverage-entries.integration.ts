import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { eq } from 'drizzle-orm'
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
import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'
import {
  CoverageEntriesQuerySchema,
  type CoverageEntries,
} from '@repo/schemas/coverage'
import { env } from '@/env'
import { createStableId } from '@/lib/media-utils'
import { createCatalogEntryFromPlugin } from '@/lib/provider-catalog'
import * as schema from '@/schemas/db'

const database = `coverage_entries_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
const execute = vi.fn<NonNullable<MediaProviderPlugin['scrapeMediaItem']>>()
const plugin = (
  id: string,
  options: Partial<MediaProviderPlugin['manifest']> = {},
): MediaProviderPlugin => ({
  manifest: {
    id,
    displayName: `Fixture ${id}`,
    description: '',
    mediaTypes: ['album'],
    identifierTypes: ['album'],
    secrets: [],
    rateLimit: { maxConcurrent: 1, minTimeMs: 2000 },
    maxItemsPerJob: 1,
    requireExplicitSelection: true,
    ...options,
  },
  scrapeMediaItem: execute,
})
// fixture-a looks albums up by name; fixture-b only by a stored identifier.
const plugins = [
  plugin('fixture-a', { supportsNameLookup: true }),
  plugin('fixture-b'),
  plugin('spotify', { displayName: 'Spotify' }),
  plugin('discogs'),
  plugin('lastfm'),
  plugin('serply'),
]
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => plugins,
  getScrapePlugin: async (id: string) =>
    plugins.find((item) => item.manifest.id === id) ?? null,
  listProviderCatalog: async () =>
    plugins.map((item) => createCatalogEntryFromPlugin(item, null)),
}))

const DAY = 86400000
const PLAYLIST = 'playlist-gaps'

let created = false
beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No network in coverage entry tests')
    }),
  )
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  await databaseClient.delete(schema.playlist)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.artist)
})
afterAll(async () => {
  expect(fetch).not.toHaveBeenCalled()
  expect(execute).not.toHaveBeenCalled()
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

async function album(id: string, options: { hidden?: boolean } = {}) {
  await databaseClient.insert(schema.mediaItem).values({
    id,
    slug: id,
    title: `Title ${id}`,
    mediaType: 'album',
    metadata: options.hidden ? { legacyHidden: true } : null,
  })
  await databaseClient.insert(schema.album).values({ mediaItemId: id })
  const artistId = createStableId('artist', 'fixture artist')
  await databaseClient
    .insert(schema.artist)
    .values({
      id: artistId,
      name: 'Fixture Artist',
      sortName: 'Fixture Artist',
    })
    .onConflictDoNothing()
  await databaseClient
    .insert(schema.mediaCredit)
    .values({ mediaItemId: id, artistId, role: 'artist' })
}

async function libraryTrack(id: string, albumId: string | null) {
  await databaseClient.insert(schema.mediaItem).values({
    id,
    slug: id,
    title: `Title ${id}`,
    mediaType: 'track',
  })
  await databaseClient
    .insert(schema.libraryTrack)
    .values({ mediaItemId: id, albumMediaItemId: albumId })
}

async function scraped(id: string, provider: string, at: Date) {
  await databaseClient.insert(schema.providerCurrentState).values({
    id: `${id}-${provider}`,
    mediaItemId: id,
    provider,
    checksum: 'fixture',
    payload: {},
    normalizedData: { mediaPatch: { summary: 'Fixture album description' } },
    status: 'ready',
    lastSuccessfulAt: at,
    lastScrapedAt: at,
  })
}

/**
 * A playlist of five tracks and one album entry:
 * - track-1 and track-2 are on album-missing (never fetched; fixture-b has its ID)
 * - track-3 is listed on album-stale (fetched 400 days ago by fixture-a)
 * - track-4 is on album-fresh (fetched today by fixture-a)
 * - track-5 is on a hidden album, which coverage leaves out
 * - album-entry is an album entry, never fetched
 */
async function seed() {
  const { replaceAlbumTracks } = await import('@/services/album-library-tracks')
  for (const id of [
    'album-missing',
    'album-stale',
    'album-fresh',
    'album-entry',
  ])
    await album(id)
  await album('album-hidden', { hidden: true })
  await album('album-outside')
  await libraryTrack('track-1', 'album-missing')
  await libraryTrack('track-2', 'album-missing')
  await libraryTrack('track-4', 'album-fresh')
  await libraryTrack('track-5', 'album-hidden')
  await libraryTrack('track-outside', 'album-outside')
  await databaseClient.transaction((tx) =>
    replaceAlbumTracks(tx, 'album-stale', [
      { title: 'Title track-3', position: 1 },
    ]),
  )
  const [listed] = await databaseClient
    .select({ id: schema.track.trackMediaItemId })
    .from(schema.track)
    .where(eq(schema.track.albumMediaItemId, 'album-stale'))
  await databaseClient.insert(schema.providerReference).values({
    id: 'album-missing-fixture-b',
    mediaItemId: 'album-missing',
    provider: 'fixture-b',
    referenceType: 'album',
    externalId: 'external-missing',
  })
  await scraped('album-stale', 'fixture-a', new Date(Date.now() - 400 * DAY))
  await scraped('album-fresh', 'fixture-a', new Date())
  await databaseClient.insert(schema.playlist).values({
    id: PLAYLIST,
    name: 'Gap playlist',
    kind: 'playlist',
    source: 'spotify',
    spotifyId: 'fixturegaps00000000000',
  })
  await databaseClient.insert(schema.playlistItem).values(
    [
      'track-1',
      'track-2',
      listed?.id ?? 'missing-track',
      'track-4',
      'track-5',
      'album-entry',
    ].map((mediaItemId, position) => ({
      playlistId: PLAYLIST,
      mediaItemId,
      position,
    })),
  )
  return listed?.id ?? 'missing-track'
}

function rows(page: CoverageEntries) {
  return page.items.map(({ entry, gaps }) => ({
    id: entry.kind === 'track' ? entry.track.id : entry.album.id,
    gaps: gaps.map((gap) => [gap.provider, ...gap.albumIds].join(' ')),
  }))
}

describe('playlist coverage entries', () => {
  it('lists the entries with gaps and names them, matching the coverage counts', async () => {
    const { getPlaylistCoverage, getPlaylistCoverageEntries } =
      await import('@/services/metadata-coverage')
    const listed = await seed()
    const query = (input: Record<string, unknown> = {}) =>
      getPlaylistCoverageEntries(
        PLAYLIST,
        CoverageEntriesQuerySchema.parse(input),
      )
    const coverage = await getPlaylistCoverage(PLAYLIST, { olderThanDays: 180 })
    const [a, b] = coverage.providers
    expect(coverage.storedAlbums).toBe(2)
    expect(a).toMatchObject({ stored: 2, covered: 1, stale: 1, missing: 2 })
    expect(b).toMatchObject({ eligible: 1, missing: 1 })

    const missing = await query()
    expect(missing).toMatchObject({
      name: 'Gap playlist',
      gap: 'missing',
      provider: null,
      olderThanDays: 180,
      totalCount: 3,
      albumCount: 2,
    })
    expect(rows(missing)).toEqual([
      {
        id: 'track-1',
        gaps: ['fixture-a album-missing', 'fixture-b album-missing'],
      },
      {
        id: 'track-2',
        gaps: ['fixture-a album-missing', 'fixture-b album-missing'],
      },
      { id: 'album-entry', gaps: ['fixture-a album-entry'] },
    ])
    expect(missing.items[0]?.gaps[0]?.displayName).toBe('Fixture fixture-a')

    const missingA = await query({ provider: 'fixture-a' })
    expect(missingA.albumCount).toBe(a?.missing)
    expect(missingA.totalCount).toBe(3)
    const missingB = await query({ provider: 'fixture-b' })
    expect(missingB.albumCount).toBe(b?.missing)
    expect(rows(missingB)).toEqual([
      { id: 'track-1', gaps: ['fixture-b album-missing'] },
      { id: 'track-2', gaps: ['fixture-b album-missing'] },
    ])
    const grouped = await query({
      groupBy: 'album',
      provider: 'fixture-a',
      size: 1,
    })
    expect(grouped).toMatchObject({
      albumCount: 2,
      totalCount: 2,
      pageCount: 2,
    })
    expect(rows(grouped)).toEqual([
      { id: 'album-missing', gaps: ['fixture-a album-missing'] },
    ])
    const groupedSecondPage = await query({
      groupBy: 'album',
      provider: 'fixture-a',
      size: 1,
      page: 2,
    })
    expect(rows(groupedSecondPage)).toEqual([
      { id: 'album-entry', gaps: ['fixture-a album-entry'] },
    ])

    const stale = await query({ gap: 'stale', provider: 'fixture-a' })
    expect(stale.albumCount).toBe(a?.stale)
    expect(rows(stale)).toEqual([
      { id: listed, gaps: ['fixture-a album-stale'] },
    ])
    const longer = await query({ gap: 'stale', olderThanDays: 500 })
    expect(longer).toMatchObject({ totalCount: 0, albumCount: 0, items: [] })

    const searched = await query({ q: 'track-2' })
    expect(rows(searched).map((row) => row.id)).toEqual(['track-2'])
    expect(searched.albumCount).toBe(2)
    const albums = await query({ kinds: '["album"]' })
    expect(rows(albums).map((row) => row.id)).toEqual(['album-entry'])
    const paged = await query({ size: 2, page: 2 })
    expect(paged).toMatchObject({ totalCount: 3, pageCount: 2 })
    expect(rows(paged).map((row) => row.id)).toEqual(['album-entry'])

    expect(await query({ provider: 'unknown' })).toMatchObject({
      totalCount: 0,
      albumCount: 0,
    })
    await expect(
      getPlaylistCoverageEntries(
        'missing-playlist',
        CoverageEntriesQuerySchema.parse({}),
      ),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
  })

  it('reports no gaps once every album is fetched', async () => {
    const { getPlaylistCoverageEntries } =
      await import('@/services/metadata-coverage')
    await seed()
    for (const id of ['album-missing', 'album-entry'])
      await scraped(id, 'fixture-a', new Date())
    await scraped('album-missing', 'fixture-b', new Date())
    const page = await getPlaylistCoverageEntries(
      PLAYLIST,
      CoverageEntriesQuerySchema.parse({}),
    )
    expect(page).toMatchObject({ totalCount: 0, albumCount: 0, items: [] })
  })

  it('counts Spotify album imports and keeps bare Spotify references eligible', async () => {
    const { getPlaylistCoverage, getPlaylistCoverageEntries } =
      await import('@/services/metadata-coverage')
    const { normalizeSpotifyAlbum } = await import('@/lib/spotify-api')
    const { applyProviderResult } = await import('@/services/provider-state')
    const listed = await seed()
    const importedAlbums = [
      { id: 'album-entry', source: 'legacy-import', spotifyId: '1'.repeat(22) },
      { id: 'album-fresh', source: 'file-import', spotifyId: '2'.repeat(22) },
    ]
    for (const { id, source, spotifyId } of importedAlbums) {
      const result = normalizeSpotifyAlbum({
        id: spotifyId,
        name: `Title ${id}`,
        artists: [{ name: 'Fixture Artist' }],
        release_date: '2025-01-01',
      })
      await applyProviderResult({
        mediaItemId: id,
        mediaType: 'album',
        provider: 'spotify',
        source,
        payload: result.payload,
        normalized: result.normalized,
      })
    }
    await databaseClient.insert(schema.providerReference).values(
      ['album-missing', 'album-stale'].map((id, index) => ({
        id: `${id}-spotify`,
        mediaItemId: id,
        provider: 'spotify',
        referenceType: 'album',
        externalId: String(index + 3).repeat(22),
      })),
    )
    await libraryTrack('track-unlinked', null)
    await databaseClient
      .update(schema.libraryTrack)
      .set({ spotifyAlbumId: '5'.repeat(22) })
      .where(eq(schema.libraryTrack.mediaItemId, 'track-unlinked'))
    await databaseClient.insert(schema.playlistItem).values({
      playlistId: PLAYLIST,
      mediaItemId: 'track-unlinked',
      position: 7,
    })

    const coverage = await getPlaylistCoverage(PLAYLIST, { olderThanDays: 180 })
    expect(coverage.total).toBe(4)
    expect(coverage.storedAlbums).toBe(3)
    expect(
      coverage.providers.find(({ provider }) => provider === 'spotify'),
    ).toMatchObject({
      eligible: 4,
      stored: 2,
      covered: 0,
      stale: 0,
      missing: 2,
      missingItemIds: ['album-missing', 'album-stale'],
    })
    const page = await getPlaylistCoverageEntries(
      PLAYLIST,
      CoverageEntriesQuerySchema.parse({ provider: 'spotify' }),
    )
    expect(page.albumCount).toBe(2)
    expect(rows(page)).toEqual([
      { id: 'track-1', gaps: ['spotify album-missing'] },
      { id: 'track-2', gaps: ['spotify album-missing'] },
      { id: listed, gaps: ['spotify album-stale'] },
    ])
  })

  it('counts canonical and legacy metadata with source attribution and excludes empty lookups', async () => {
    const { getPlaylistCoverage, getPlaylistCoverageEntries } =
      await import('@/services/metadata-coverage')
    const { applyProviderResult } = await import('@/services/provider-state')
    const { normalizeLegacyBrowse } = await import('@/lib/legacy-browse')
    await seed()
    const legacy = normalizeLegacyBrowse(
      {
        title: 'Title album-missing',
        popularityDiscogs: 0,
        ratingRymValue: 3.5,
      },
      'album',
    )
    await applyProviderResult({
      ...legacy,
      mediaItemId: 'album-missing',
      mediaType: 'album',
      provider: 'legacy-browser',
      source: 'legacy-clean-import',
    })
    await databaseClient
      .update(schema.mediaItem)
      .set({ artworkUrl: 'https://i.scdn.co/image/fixture' })
      .where(eq(schema.mediaItem.id, 'album-entry'))
    await databaseClient.insert(schema.providerReference).values(
      ['album-missing', 'album-stale', 'album-fresh', 'album-entry'].flatMap(
        (mediaItemId) =>
          ['discogs', 'lastfm', 'serply'].map((provider) => ({
            id: `${mediaItemId}-${provider}`,
            mediaItemId,
            provider,
            referenceType: 'album',
            externalId: 'fixture',
          })),
      ),
    )
    await databaseClient.insert(schema.providerCurrentState).values([
      {
        id: 'native-lastfm',
        mediaItemId: 'album-stale',
        provider: 'lastfm',
        checksum: 'fixture',
        payload: {
          name: 'Fixture release',
          artist: 'Fixture Artist',
          url: 'https://www.last.fm/music/Fixture+Artist/Fixture+Release',
          listeners: '0',
        },
        status: 'ready',
        lastSuccessfulAt: new Date(Date.now() - 400 * DAY),
      },
      {
        id: 'empty-lookup',
        mediaItemId: 'album-entry',
        provider: 'serply',
        checksum: 'fixture',
        payload: {},
        normalizedData: {
          mediaPatch: {
            metadata: {
              'plugin.serply.provenance': { matchStatus: 'identity-only' },
            },
          },
          references: [{ referenceType: 'rym-url', externalId: 'fixture' }],
        },
        status: 'ready',
        lastSuccessfulAt: new Date(),
        lastScrapedAt: new Date(),
      },
      {
        id: 'unsuccessful-fixture',
        mediaItemId: 'album-entry',
        provider: 'fixture-b',
        checksum: 'fixture',
        payload: { error: 'Fixture failure' },
        normalizedData: { mediaPatch: { summary: 'Diagnostic message' } },
        status: 'failed',
      },
    ])
    const coverage = await getPlaylistCoverage(PLAYLIST, { olderThanDays: 180 })
    expect(coverage.storedAlbums).toBe(coverage.total)
    const byProvider = new Map(
      coverage.providers.map((row) => [row.provider, row]),
    )
    expect(byProvider.get('spotify')).toMatchObject({ stored: 1, missing: 0 })
    expect(byProvider.get('discogs')).toMatchObject({ stored: 1, missing: 3 })
    expect(byProvider.get('lastfm')).toMatchObject({
      stored: 1,
      stale: 0,
      missing: 3,
    })
    expect(byProvider.get('serply')).toMatchObject({
      stored: 0,
      covered: 0,
      missing: 4,
    })
    expect(byProvider.get('fixture-b')).toMatchObject({ stored: 0, missing: 1 })
    const gaps = await getPlaylistCoverageEntries(
      PLAYLIST,
      CoverageEntriesQuerySchema.parse({
        provider: 'discogs',
        groupBy: 'album',
      }),
    )
    expect(gaps.albumCount).toBe(3)
    expect(rows(gaps).map((row) => row.id)).not.toContain('album-missing')
  })

  it('rechecks stored gaps when queueing reviewed album IDs', async () => {
    const { queueAlbumSelection } = await import('@/services/album-selection')
    const { applyProviderResult } = await import('@/services/provider-state')
    await seed()
    await applyProviderResult({
      mediaItemId: 'album-missing',
      mediaType: 'album',
      provider: 'fixture-a',
      source: 'file-import',
      payload: {},
      normalized: {
        mediaPatch: { summary: 'A saved fixture description' },
        references: [],
        links: [],
        tags: [],
        tracks: [],
        credits: [],
        playlists: [],
      },
    })
    const denied = await queueAlbumSelection(
      {
        providers: ['fixture-a'],
        mediaItemIds: ['album-missing'],
        coverageGap: { gap: 'missing', olderThanDays: 180 },
        batchId: randomUUID(),
        confirmBroadRun: false,
      },
      null,
    )
    expect(denied).toMatchObject({ queued: 0, skipped: 1 })

    const stale = await queueAlbumSelection(
      {
        providers: ['fixture-a'],
        mediaItemIds: [
          'album-stale',
          'album-fresh',
          'album-entry',
          'album-missing',
        ],
        coverageGap: { gap: 'stale', olderThanDays: 180 },
        batchId: randomUUID(),
        confirmBroadRun: false,
      },
      null,
    )
    expect(stale).toMatchObject({ queued: 1, skipped: 3 })
    expect(
      await databaseClient
        .select({ id: schema.scrapeJobItem.mediaItemId })
        .from(schema.scrapeJobItem),
    ).toEqual([{ id: 'album-stale' }])
  })
})
