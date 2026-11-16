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
    expect(a).toMatchObject({ covered: 1, stale: 1, missing: 2 })
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
})
