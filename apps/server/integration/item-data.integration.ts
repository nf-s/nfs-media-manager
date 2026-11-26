import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import pg from 'pg'
import { and, eq } from 'drizzle-orm'
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
  PluginResultSchema,
  type MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import { LISTENING_SERIES_DAYS } from '@repo/schemas/lastfm'
import { env } from '@/env'
import { albumNameKey } from '@/lib/album-import-candidates'
import { createStableId } from '@/lib/media-utils'
import { createCatalogEntryFromPlugin } from '@/lib/provider-catalog'
import * as schema from '@/schemas/db'

const database = `item_data_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
const legacyFiles = vi.hoisted(() => new Map<string, unknown>())
const legacyDirectory = resolve('integration/fixtures')
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    readFile: async (path: string, options: BufferEncoding) => {
      const synthetic = legacyFiles.get(path)
      return synthetic === undefined
        ? fs.readFile(path, options)
        : JSON.stringify(synthetic)
    },
  }
})
vi.mock('@/env', async (importOriginal) => {
  const { env } = await importOriginal<typeof import('@/env')>()
  return {
    env: { ...env, LEGACY_SERVER_DATA_DIR: resolve('integration/fixtures') },
  }
})
const execute = vi.fn<NonNullable<MediaProviderPlugin['scrapeMediaItem']>>()
const plugin = (
  id: string,
  options: Partial<MediaProviderPlugin['manifest']> = {},
): MediaProviderPlugin => ({
  manifest: {
    id,
    displayName: `Fixture ${id}`,
    description: '',
    mediaTypes: ['album', 'film'],
    identifierTypes: ['album'],
    secrets: [],
    rateLimit: { maxConcurrent: 1, minTimeMs: 2000 },
    maxItemsPerJob: 1,
    requireExplicitSelection: true,
    ...options,
  },
  scrapeMediaItem: execute,
})
const plugins = [
  plugin('fixture-a', { supportsNameLookup: true }),
  plugin('fixture-b', {
    secrets: [{ key: 'token', label: 'Token', required: true }],
  }),
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

const LISTENER = 'fixture-listener'
const NOW = new Date('2026-11-16T10:00:00.000Z')
const DAY = 86400000

let created = false
beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No network in item data tests')
    }),
  )
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  legacyFiles.clear()
  execute.mockReset()
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.lastfmScrobble)
  await databaseClient.delete(schema.playlist)
  await databaseClient.delete(schema.providerSnapshot)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.artist)
})
afterAll(async () => {
  expect(fetch).not.toHaveBeenCalled()
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

async function credit(mediaItemId: string, name: string) {
  const artistId = createStableId('artist', name.toLowerCase())
  await databaseClient
    .insert(schema.artist)
    .values({ id: artistId, name, sortName: name })
    .onConflictDoNothing()
  await databaseClient
    .insert(schema.mediaCredit)
    .values({ mediaItemId, artistId, role: 'artist' })
  return artistId
}

async function album(
  id: string,
  options: { title?: string; artist?: string; hidden?: boolean } = {},
) {
  await databaseClient.insert(schema.mediaItem).values({
    id,
    slug: id,
    title: options.title ?? `Title ${id}`,
    mediaType: 'album',
    metadata: options.hidden ? { legacyHidden: true } : null,
  })
  await databaseClient.insert(schema.album).values({ mediaItemId: id })
  return options.artist ? credit(id, options.artist) : null
}

async function libraryTrack(
  id: string,
  options: { artist?: string; albumId?: string } = {},
) {
  await databaseClient.insert(schema.mediaItem).values({
    id,
    slug: id,
    title: `Title ${id}`,
    mediaType: 'track',
  })
  await databaseClient.insert(schema.libraryTrack).values({
    mediaItemId: id,
    albumMediaItemId: options.albumId ?? null,
  })
  if (options.artist) await credit(id, options.artist)
}

it('keeps metadata for the exact overridden reference and provider', async () => {
  const mediaItemId = 'reference-override-fixture'
  const provider = 'fixture-a'
  await album(mediaItemId)
  const exact = [
    {
      referenceType: 'album',
      externalId: 'chosen-album',
      provider,
      metadata: { url: 'https://example.test/old-album' },
    },
    {
      referenceType: 'master',
      externalId: 'chosen-master',
      provider,
      metadata: { url: 'https://example.test/chosen-master' },
    },
    {
      referenceType: 'release',
      externalId: 'chosen-release',
      provider: 'fixture-b',
      metadata: { url: 'https://example.test/foreign-release' },
    },
  ]
  await databaseClient.insert(schema.providerReference).values(
    exact.map((reference) => ({
      ...reference,
      id: `existing-${reference.referenceType}`,
      mediaItemId,
      isPrimary: true,
    })),
  )
  await databaseClient.insert(schema.providerReferenceOverride).values(
    exact.map(({ referenceType, externalId }) => ({
      id: `override-${referenceType}`,
      mediaItemId,
      provider,
      referenceType,
      externalId,
    })),
  )
  const { applyProviderResult } = await import('@/services/provider-state')
  await applyProviderResult({
    mediaItemId,
    mediaType: 'album',
    provider,
    source: 'fixture',
    ...PluginResultSchema.parse({
      payload: {},
      normalized: {
        references: [
          {
            referenceType: 'album',
            externalId: 'chosen-album',
            isPrimary: true,
            metadata: { url: 'https://example.test/chosen-album' },
          },
          ...exact.map(({ referenceType }) => ({
            referenceType,
            externalId: `different-${referenceType}`,
            metadata: {
              url: `https://example.test/different-${referenceType}`,
            },
          })),
          {
            referenceType: 'album',
            externalId: 'chosen-album',
            isPrimary: true,
          },
        ],
      },
    }),
  })

  expect(
    await databaseClient
      .select({
        referenceType: schema.providerReference.referenceType,
        externalId: schema.providerReference.externalId,
        metadata: schema.providerReference.metadata,
      })
      .from(schema.providerReference)
      .where(
        and(
          eq(schema.providerReference.mediaItemId, mediaItemId),
          eq(schema.providerReference.provider, provider),
        ),
      )
      .orderBy(schema.providerReference.referenceType),
  ).toEqual([
    {
      referenceType: 'album',
      externalId: 'chosen-album',
      metadata: { url: 'https://example.test/chosen-album' },
    },
    {
      referenceType: 'master',
      externalId: 'chosen-master',
      metadata: { url: 'https://example.test/chosen-master' },
    },
    { referenceType: 'release', externalId: 'chosen-release', metadata: null },
  ])
})

// One scrobbled artist and track name counted towards a library track.
async function trackLink(trackId: string, artist: string, title: string) {
  await databaseClient.insert(schema.lastfmTrackLink).values({
    username: LISTENER,
    artistKey: albumNameKey(artist),
    trackKey: albumNameKey(title),
    trackMediaItemId: trackId,
    strategy: 'exact',
  })
}

function scrobbleRow(
  at: string | Date,
  options: { artist?: string; track?: string; albumId?: string } = {},
) {
  const artist = options.artist ?? 'Fixture Artist'
  const track = options.track ?? 'Fixture Song'
  return {
    id: randomUUID(),
    username: LISTENER,
    artistName: artist,
    artistKey: albumNameKey(artist),
    trackName: track,
    trackKey: albumNameKey(track),
    albumName: options.albumId ? 'Fixture Album Name' : null,
    albumKey: options.albumId ? albumNameKey('Fixture Album Name') : null,
    albumMediaItemId: options.albumId ?? null,
    listenedAt: new Date(at),
  }
}

async function scrobbles(rows: Array<ReturnType<typeof scrobbleRow>>) {
  for (let index = 0; index < rows.length; index += 500)
    await databaseClient
      .insert(schema.lastfmScrobble)
      .values(rows.slice(index, index + 500))
}

describe('listening series', () => {
  it('returns an empty series with the daily window for an album without scrobbles', async () => {
    const { getAlbumListeningSeries } =
      await import('@/services/listening-series')
    await album('album-empty')
    expect(await getAlbumListeningSeries('album-empty', NOW)).toEqual({
      total: 0,
      firstDate: null,
      lastDate: null,
      historyFrom: null,
      daysFrom: '2021-11-16',
      daysTo: '2026-11-16',
      days: [],
      months: [],
    })
  })

  it('returns sparse days inside five years and all-time months that agree with the album report', async () => {
    const { getAlbumListeningSeries } =
      await import('@/services/listening-series')
    const { getAlbumListening } = await import('@/services/lastfm-scrobbles')
    await album('album-sparse')
    await scrobbles([
      scrobbleRow('2015-05-10T08:00:00.000Z', { albumId: 'album-sparse' }),
      scrobbleRow('2015-05-31T23:59:59.000Z', { albumId: 'album-sparse' }),
      scrobbleRow('2021-11-15T23:59:59.000Z', { albumId: 'album-sparse' }),
      scrobbleRow('2021-11-16T00:00:00.000Z', { albumId: 'album-sparse' }),
      ...Array.from({ length: 30 }, (_, index) =>
        scrobbleRow(new Date(Date.UTC(2026, 10, 10, 9, index)), {
          albumId: 'album-sparse',
        }),
      ),
      scrobbleRow('2026-11-16T09:00:00.000Z', { albumId: 'album-sparse' }),
    ])
    const series = await getAlbumListeningSeries('album-sparse', NOW)
    expect(series).toMatchObject({
      total: 35,
      firstDate: '2015-05-10',
      lastDate: '2026-11-16',
      historyFrom: '2015-05-10',
      daysFrom: '2021-11-16',
      daysTo: '2026-11-16',
      days: [
        { date: '2021-11-16', count: 1 },
        { date: '2026-11-10', count: 30 },
        { date: '2026-11-16', count: 1 },
      ],
      months: [
        { month: '2015-05', count: 2 },
        { month: '2021-11', count: 2 },
        { month: '2026-11', count: 31 },
      ],
    })
    const report = await getAlbumListening('album-sparse')
    expect(series.months).toEqual(report.months)
    expect(series.total).toBe(report.total)
  })

  it('bounds dense daily counts to five years', async () => {
    const { getAlbumListeningSeries } =
      await import('@/services/listening-series')
    await album('album-daily')
    const today = Date.UTC(2026, 10, 16, 12)
    await scrobbles(
      Array.from({ length: 2000 }, (_, index) =>
        scrobbleRow(new Date(today - index * DAY), { albumId: 'album-daily' }),
      ),
    )
    const series = await getAlbumListeningSeries('album-daily', NOW)
    expect(series.total).toBe(2000)
    expect(series.days).toHaveLength(LISTENING_SERIES_DAYS)
    expect(series.days[0]).toEqual({ date: series.daysFrom, count: 1 })
    expect(series.days.at(-1)).toEqual({ date: series.daysTo, count: 1 })
    expect(series.months.reduce((sum, month) => sum + month.count, 0)).toBe(
      2000,
    )
  })

  it('uses the track detail links for a track', async () => {
    const { getTrackListeningSeries } =
      await import('@/services/listening-series')
    const { getTrackDetail } = await import('@/services/tracks')
    await libraryTrack('track-linked', { artist: 'Fixture Artist' })
    await trackLink('track-linked', 'Fixture Artist', 'Fixture Song')
    await trackLink(
      'track-linked',
      'Fixture Artist',
      'Fixture Song - Remastered',
    )
    await scrobbles([
      scrobbleRow('2024-01-02T00:00:00.000Z'),
      scrobbleRow('2024-01-03T00:00:00.000Z', {
        track: 'Fixture Song - Remastered',
      }),
      scrobbleRow('2026-11-01T00:00:00.000Z'),
      scrobbleRow('2026-11-01T00:00:00.000Z', { track: 'Unlinked Song' }),
      scrobbleRow('2019-06-01T00:00:00.000Z', { track: 'Unlinked Song' }),
    ])
    const series = await getTrackListeningSeries('track-linked', NOW)
    const detail = await getTrackDetail('track-linked')
    expect(series.total).toBe(3)
    // The history starts at the earliest scrobble of anything, linked or not.
    expect(series).toMatchObject({
      firstDate: '2024-01-02',
      historyFrom: '2019-06-01',
    })
    expect(series.months).toEqual(detail?.listening.months)
    expect(series.days).toEqual([
      { date: '2024-01-02', count: 1 },
      { date: '2024-01-03', count: 1 },
      { date: '2026-11-01', count: 1 },
    ])
  })

  it('counts an artist through credited albums and tracks once each', async () => {
    const { getArtistListeningSeries } =
      await import('@/services/listening-series')
    const artistId = await album('album-credited', { artist: 'Fixture Artist' })
    await album('album-hidden', { artist: 'Fixture Artist', hidden: true })
    await album('album-other', { artist: 'Other Artist' })
    await libraryTrack('track-credited', {
      artist: 'Fixture Artist',
      albumId: 'album-credited',
    })
    await trackLink('track-credited', 'Fixture Artist', 'Fixture Song')
    await scrobbles([
      // Linked to the album and counted towards the track: counted once.
      scrobbleRow('2026-10-01T00:00:00.000Z', { albumId: 'album-credited' }),
      // Album only.
      scrobbleRow('2026-10-02T00:00:00.000Z', {
        albumId: 'album-credited',
        track: 'Album Only Song',
      }),
      // Track only: scrobbled without an album name.
      scrobbleRow('2026-10-03T00:00:00.000Z'),
      scrobbleRow('2026-10-04T00:00:00.000Z', {
        albumId: 'album-hidden',
        track: 'Hidden Song',
      }),
      scrobbleRow('2026-10-05T00:00:00.000Z', {
        albumId: 'album-other',
        artist: 'Other Artist',
        track: 'Other Song',
      }),
    ])
    const series = await getArtistListeningSeries(
      artistId ?? 'missing-artist',
      NOW,
    )
    expect(series.total).toBe(3)
    expect(series.days.map((day) => day.date)).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ])
  })

  it('counts a playlist through its track entries and album entries once each', async () => {
    const { getPlaylistListeningSeries } =
      await import('@/services/listening-series')
    await album('album-of-track')
    await album('album-entry')
    await libraryTrack('track-entry', { albumId: 'album-of-track' })
    await trackLink('track-entry', 'Fixture Artist', 'Fixture Song')
    await databaseClient.insert(schema.playlist).values({
      id: 'playlist-1',
      name: 'Fixture playlist',
      kind: 'playlist',
      source: 'spotify',
      spotifyId: 'fixtureplaylist0000000',
    })
    await databaseClient.insert(schema.playlistItem).values([
      { playlistId: 'playlist-1', mediaItemId: 'track-entry', position: 0 },
      { playlistId: 'playlist-1', mediaItemId: 'album-entry', position: 1 },
    ])
    await scrobbles([
      scrobbleRow('2026-09-01T00:00:00.000Z', { albumId: 'album-of-track' }),
      // Another track of the entry's album does not count.
      scrobbleRow('2026-09-02T00:00:00.000Z', {
        albumId: 'album-of-track',
        track: 'Other Song',
      }),
      scrobbleRow('2026-09-03T00:00:00.000Z', {
        albumId: 'album-entry',
        track: 'Fixture Song',
      }),
      scrobbleRow('2026-09-04T00:00:00.000Z', {
        albumId: 'album-entry',
        track: 'Entry Album Song',
      }),
    ])
    const series = await getPlaylistListeningSeries('playlist-1', NOW)
    expect(series.total).toBe(3)
    expect(series.days.map((day) => day.date)).toEqual([
      '2026-09-01',
      '2026-09-03',
      '2026-09-04',
    ])
  })

  it('reports a missing album, track, artist or playlist as not found', async () => {
    const series = await import('@/services/listening-series')
    await libraryTrack('track-only')
    await expect(
      series.getAlbumListeningSeries('track-only', NOW),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    await expect(
      series.getTrackListeningSeries('missing', NOW),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    await expect(
      series.getArtistListeningSeries('missing', NOW),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    await expect(
      series.getPlaylistListeningSeries('missing', NOW),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
  })
})

describe('album tracklist provider priority', () => {
  const savedEdition = 'FixtureSavedEdition001'
  const otherEdition = 'FixtureOtherEdition001'
  const savedTrack = 'FixtureSavedRecording1'
  const albumId = 'fixture-tracklist-priority'
  const rawSpotifyAlbum = {
    id: savedEdition,
    name: 'Fixture Album',
    artists: [{ name: 'Fixture Artist' }],
    total_tracks: 1,
    tracks: {
      offset: 0,
      total: 1,
      next: null,
      items: [
        {
          id: savedTrack,
          name: 'Fixture Song (Concert)',
          disc_number: 1,
          track_number: 1,
          duration_ms: 152000,
          artists: [{ name: 'Fixture Artist' }],
        },
      ],
    },
  }

  async function applyAlbumProvider(
    provider: string,
    source: string,
    result: unknown,
    mediaItemId = albumId,
  ) {
    const { applyProviderResult } = await import('@/services/provider-state')
    await applyProviderResult({
      mediaItemId,
      mediaType: 'album',
      provider,
      source,
      ...PluginResultSchema.parse(result),
    })
  }

  async function albumTracks(mediaItemId = albumId) {
    return databaseClient
      .select({
        externalId: schema.track.externalId,
        title: schema.track.title,
      })
      .from(schema.track)
      .where(eq(schema.track.albumMediaItemId, mediaItemId))
      .orderBy(schema.track.position)
  }

  const discogsResult = {
    payload: { release: { id: 101 } },
    normalized: {
      tracks: [{ title: 'Fixture Song (Studio)', position: 1 }],
    },
  }

  it('retains the saved edition when its legacy receipt has only a raw tracklist', async () => {
    await album(albumId)
    await applyAlbumProvider('spotify', 'legacy-import', {
      payload: { spotify: rawSpotifyAlbum },
      normalized: {
        references: [{ referenceType: 'album', externalId: savedEdition }],
      },
    })
    await libraryTrack('existing-saved-recording', { albumId })
    await databaseClient.insert(schema.track).values({
      id: 'existing-saved-position',
      albumMediaItemId: albumId,
      trackMediaItemId: 'existing-saved-recording',
      externalId: savedTrack,
      title: 'Fixture Song (Concert)',
      durationSec: 152,
      position: 1,
    })

    await applyAlbumProvider('discogs', 'scrape-job', discogsResult)

    expect(await albumTracks()).toEqual([
      { externalId: savedTrack, title: 'Fixture Song (Concert)' },
    ])
    const discogs = await databaseClient.query.providerCurrentState.findFirst({
      where: (state, { eq, and }) =>
        and(eq(state.mediaItemId, albumId), eq(state.provider, 'discogs')),
    })
    expect(discogs?.normalizedData?.tracks).toEqual(
      discogsResult.normalized.tracks,
    )
  })

  it.each(['partial', 'different edition', 'ambiguous release'])(
    'allows the fallback when the legacy Spotify evidence identifies a %s',
    async (condition) => {
      await album(albumId)
      const release =
        condition === 'partial'
          ? {
              ...rawSpotifyAlbum,
              total_tracks: 2,
              tracks: {
                ...rawSpotifyAlbum.tracks,
                total: 2,
                next: 'https://example.test/next-page',
              },
            }
          : rawSpotifyAlbum
      const reference = {
        referenceType: 'album',
        externalId:
          condition === 'different edition' ? otherEdition : savedEdition,
      }
      await applyAlbumProvider('spotify', 'legacy-import', {
        payload: { spotify: release },
        normalized: {
          references:
            condition === 'ambiguous release'
              ? [reference, { ...reference, externalId: otherEdition }]
              : [reference],
          // An older importer could have projected just the partial first page.
          tracks:
            condition === 'partial'
              ? [{ title: 'Incomplete list', position: 1 }]
              : [],
        },
      })

      await applyAlbumProvider('discogs', 'scrape-job', discogsResult)
      expect(await albumTracks()).toEqual([
        { externalId: null, title: 'Fixture Song (Studio)' },
      ])
    },
  )

  it('keeps the modern complete Spotify list when the later Spotify state is partial', async () => {
    const { normalizeSpotifyAlbum } = await import('@/lib/spotify-api')
    await album(albumId)
    await applyAlbumProvider(
      'spotify',
      'scrape-job',
      normalizeSpotifyAlbum(rawSpotifyAlbum),
    )
    await applyAlbumProvider(
      'spotify',
      'file-import',
      normalizeSpotifyAlbum({
        ...rawSpotifyAlbum,
        total_tracks: 2,
        tracks: {
          ...rawSpotifyAlbum.tracks,
          total: 2,
          next: 'https://example.test/next-page',
        },
      }),
    )

    await applyAlbumProvider('discogs', 'scrape-job', discogsResult)
    expect(await albumTracks()).toEqual([
      { externalId: savedTrack, title: 'Fixture Song (Concert)' },
    ])
  })

  it('keeps the explicit modern Spotify edition when a different legacy edition is replayed', async () => {
    const { normalizeSpotifyAlbum } = await import('@/lib/spotify-api')
    const { patchAlbum } = await import('@/services/media')
    const legacy = normalizeSpotifyAlbum(rawSpotifyAlbum)
    const wrappedLegacy = { ...legacy, payload: { spotify: legacy.payload } }
    const [oldTrack] = rawSpotifyAlbum.tracks.items
    if (!oldTrack) throw new Error('Missing fixture track')
    const modernTrack = 'FixtureOtherRecording1'
    const modern = normalizeSpotifyAlbum({
      ...rawSpotifyAlbum,
      id: otherEdition,
      name: 'Fixture Album (Selected Edition)',
      tracks: {
        ...rawSpotifyAlbum.tracks,
        items: [
          { ...oldTrack, id: modernTrack, name: 'Fixture Song (Studio)' },
        ],
      },
    })
    await album(albumId)
    await applyAlbumProvider('spotify', 'legacy-import', wrappedLegacy)
    await patchAlbum(
      albumId,
      {
        providerReference: {
          provider: 'spotify',
          referenceType: 'album',
          externalId: otherEdition,
        },
      },
      null,
    )
    await applyAlbumProvider('spotify', 'scrape-job', modern)
    await applyAlbumProvider('spotify', 'legacy-import', wrappedLegacy)

    expect(await albumTracks()).toEqual([
      { externalId: modernTrack, title: 'Fixture Song (Studio)' },
    ])
    const [item, state] = await Promise.all([
      databaseClient.query.mediaItem.findFirst({
        where: (table, { eq }) => eq(table.id, albumId),
        with: { album: true },
      }),
      databaseClient.query.providerCurrentState.findFirst({
        where: (table, { and, eq }) =>
          and(eq(table.mediaItemId, albumId), eq(table.provider, 'spotify')),
      }),
    ])
    expect(item?.title).toBe('Fixture Album (Selected Edition)')
    expect(item?.album?.spotifyUrl).toBe(
      `https://open.spotify.com/album/${otherEdition}`,
    )
    expect(state?.payload).toMatchObject({ id: otherEdition })
  })

  it('keeps modern metadata when a partial direct legacy receipt is replayed for the same edition', async () => {
    const { normalizeSpotifyAlbum } = await import('@/lib/spotify-api')
    await album(albumId)
    await applyAlbumProvider(
      'spotify',
      'album-open',
      normalizeSpotifyAlbum(rawSpotifyAlbum),
    )
    const partial = normalizeSpotifyAlbum({
      ...rawSpotifyAlbum,
      name: 'Older Title',
      total_tracks: 2,
      tracks: { ...rawSpotifyAlbum.tracks, total: 2, next: 'next-page' },
    })
    await applyAlbumProvider('spotify', 'legacy-import', partial)

    expect(await albumTracks()).toEqual([
      { externalId: savedTrack, title: 'Fixture Song (Concert)' },
    ])
    const state = await databaseClient.query.providerCurrentState.findFirst({
      where: (table, { and, eq }) =>
        and(eq(table.mediaItemId, albumId), eq(table.provider, 'spotify')),
    })
    expect(state?.payload).toMatchObject({ name: rawSpotifyAlbum.name })
    const retained = await databaseClient.query.providerSnapshot.findFirst({
      where: (table, { and, eq }) =>
        and(eq(table.mediaItemId, albumId), eq(table.source, 'legacy-import')),
    })
    expect(retained?.payload).toEqual(partial.payload)
  })

  it('keeps the modern Spotify album through the raw and cleaned legacy import stages', async () => {
    const { normalizeSpotifyAlbum } = await import('@/lib/spotify-api')
    const { runLegacyImport } = await import('../scripts/import-legacy')
    const selectedId = createStableId('album', `album:spotify:${savedEdition}`)
    const mismatchedId = createStableId(
      'album',
      `album:spotify:${otherEdition}`,
    )
    const wrongKey = 'FixtureThirdEdition001'
    const opaqueEdition = 'FixtureOpaqueEdition01'
    const opaqueTrack = 'FixtureNewRecording001'
    const opaqueId = createStableId('album', `album:spotify:${opaqueEdition}`)
    const [originalTrack] = rawSpotifyAlbum.tracks.items
    if (!originalTrack) throw new Error('Missing fixture track')
    await album(selectedId)
    await applyAlbumProvider(
      'spotify',
      'scrape-job',
      normalizeSpotifyAlbum({
        ...rawSpotifyAlbum,
        name: 'Newer Title',
        release_date: '2025-03-02',
        artists: [{ name: 'Verified Artist' }],
        images: [{ url: 'https://example.test/verified.jpg' }],
        popularity: 73,
      }),
      selectedId,
    )
    await databaseClient.insert(schema.playlist).values({
      id: 'existing-library-playlist',
      name: 'Existing library playlist',
      kind: 'playlist',
    })
    await databaseClient.insert(schema.playlistItem).values({
      playlistId: 'existing-library-playlist',
      mediaItemId: selectedId,
      position: 0,
    })

    legacyFiles.set(resolve(legacyDirectory, 'lib-music.json'), {
      albums: {
        [savedEdition]: {
          id: { spotify: savedEdition },
          spotify: { ...rawSpotifyAlbum, name: 'Old Spotify Title' },
          discogs: {
            release: {
              id: 101,
              title: 'Old Discogs Title',
              artists: [{ name: 'Old Discogs Artist' }],
              genres: ['Synthetic genre'],
            },
          },
        },
        [wrongKey]: {
          id: { spotify: wrongKey },
          spotify: { ...rawSpotifyAlbum, id: otherEdition },
        },
        'opaque-archive-key': {
          id: { spotify: opaqueEdition },
          spotify: {
            ...rawSpotifyAlbum,
            id: opaqueEdition,
            tracks: {
              ...rawSpotifyAlbum.tracks,
              items: [{ ...originalTrack, id: opaqueTrack }],
            },
          },
        },
      },
    })
    legacyFiles.set(resolve(legacyDirectory, 'lib.json'), { movies: {} })
    legacyFiles.set(resolve('../../apps/web/public/data/lib-music.json'), {
      albums: {
        [savedEdition]: {
          id: { spotify: savedEdition },
          title: 'Old Browse Title',
          artists: ['Old Browse Artist'],
          durationSec: 42,
          popularitySpotify: 1,
          playlists: ['Legacy playlist'],
          links: {
            spotify: { href: `https://open.spotify.com/album/${savedEdition}` },
          },
        },
      },
    })
    legacyFiles.set(resolve('../../apps/web/public/data/lib-movie.json'), [])

    await runLegacyImport({ albumLimit: 3, filmLimit: 0 })

    const media = await databaseClient.query.mediaItem.findFirst({
      where: (table, { eq }) => eq(table.id, selectedId),
      with: { album: true, credits: { with: { artist: true } } },
    })
    expect(media).toMatchObject({
      title: 'Newer Title',
      artworkUrl: 'https://example.test/verified.jpg',
      metadata: { browse: { popularitySpotify: 73 } },
      album: {
        spotifyUrl: `https://open.spotify.com/album/${savedEdition}`,
        durationSec: 152,
      },
      credits: [{ artist: { name: 'Verified Artist' }, role: 'artist' }],
    })
    expect(media?.releaseDate?.toISOString()).toBe('2025-03-02T00:00:00.000Z')
    expect(await albumTracks(selectedId)).toEqual([
      { externalId: savedTrack, title: 'Fixture Song (Concert)' },
    ])
    const memberships = await databaseClient
      .select({ name: schema.playlist.name })
      .from(schema.playlistItem)
      .innerJoin(
        schema.playlist,
        eq(schema.playlist.id, schema.playlistItem.playlistId),
      )
      .where(eq(schema.playlistItem.mediaItemId, selectedId))
      .orderBy(schema.playlist.name)
    expect(memberships).toEqual([
      { name: 'Existing library playlist' },
      { name: 'Legacy playlist' },
    ])
    expect(
      await databaseClient.query.providerReference.findFirst({
        where: (table, { and, eq }) =>
          and(eq(table.mediaItemId, selectedId), eq(table.provider, 'discogs')),
      }),
    ).toMatchObject({ externalId: '101' })
    expect(
      await databaseClient.query.mediaItem.findFirst({
        where: (table, { eq }) => eq(table.id, mismatchedId),
      }),
    ).toBeUndefined()
    expect(await albumTracks(opaqueId)).toEqual([
      { externalId: opaqueTrack, title: 'Fixture Song (Concert)' },
    ])
  })
})

describe('field provenance', () => {
  it('lists every provider that supplies a field, with the manual override and stored value', async () => {
    const { applyProviderResult } = await import('@/services/provider-state')
    const { patchAlbum } = await import('@/services/media')
    const { getMediaProvenance } = await import('@/services/media-provenance')
    await album('album-provenance', { title: 'Fixture Title' })
    await databaseClient.insert(schema.scrapeJob).values({
      id: 'job-a',
      provider: 'fixture-a',
      status: 'succeeded',
      scope: { mediaType: 'album', mediaItemIds: ['album-provenance'] },
      options: {},
    })
    await applyProviderResult({
      mediaItemId: 'album-provenance',
      mediaType: 'album',
      provider: 'fixture-a',
      source: 'scrape-job',
      scrapeJobId: 'job-a',
      ...PluginResultSchema.parse({
        payload: { marker: 'payload-only-marker' },
        normalized: {
          mediaPatch: {
            title: 'Fixture Title',
            releaseDate: '2019-03-08',
            metadata: { browse: { ratingDiscogsValue: 4.1 } },
          },
          credits: [{ name: 'Fixture Artist', role: 'artist' }],
        },
      }),
    })
    await databaseClient
      .update(schema.providerSnapshot)
      .set({ createdAt: new Date('2020-01-01T00:00:00.000Z') })
      .where(eq(schema.providerSnapshot.provider, 'fixture-a'))
    await applyProviderResult({
      mediaItemId: 'album-provenance',
      mediaType: 'album',
      provider: 'fixture-b',
      source: 'scrape-job',
      ...PluginResultSchema.parse({
        payload: { marker: 'payload-only-marker' },
        normalized: {
          mediaPatch: {
            title: 'Fixture Title (Deluxe)',
            releaseDate: '2019-03-01',
            metadata: { browse: { ratingDiscogsValue: 4.4 } },
          },
          albumPatch: { durationSec: 2400 },
        },
      }),
    })
    await patchAlbum('album-provenance', { title: 'Fixture Title' }, null)

    const provenance = await getMediaProvenance('album-provenance')
    expect(JSON.stringify(provenance)).not.toContain('payload-only-marker')
    const field = (key: string) =>
      provenance.fields.find((item) => item.key === key)
    const [newer] = await databaseClient
      .select()
      .from(schema.providerSnapshot)
      .where(eq(schema.providerSnapshot.provider, 'fixture-b'))
    const [older] = await databaseClient
      .select()
      .from(schema.providerSnapshot)
      .where(eq(schema.providerSnapshot.provider, 'fixture-a'))

    expect(field('title')).toMatchObject({
      label: 'Title',
      value: 'Fixture Title',
      override: { by: null, note: null },
      sources: [
        {
          provider: 'fixture-b',
          snapshotId: newer?.id,
          snapshotSource: 'scrape-job',
          jobId: null,
          value: 'Fixture Title (Deluxe)',
          matchesCurrent: false,
        },
        {
          provider: 'fixture-a',
          scrapedAt: '2020-01-01T00:00:00.000Z',
          snapshotId: older?.id,
          jobId: 'job-a',
          value: 'Fixture Title',
          matchesCurrent: true,
        },
      ],
    })
    expect(field('releaseDate')).toMatchObject({
      value: '2019-03-01T00:00:00.000Z',
      override: null,
      sources: [
        { provider: 'fixture-b', value: '2019-03-01', matchesCurrent: true },
        { provider: 'fixture-a', value: '2019-03-08', matchesCurrent: false },
      ],
    })
    expect(field('browse.ratingDiscogsValue')).toMatchObject({
      label: 'Discogs rating',
      value: 4.4,
      sources: [
        { provider: 'fixture-b', value: 4.4, matchesCurrent: true },
        { provider: 'fixture-a', value: 4.1, matchesCurrent: false },
      ],
    })
    expect(field('durationSec')).toMatchObject({
      value: 2400,
      sources: [{ provider: 'fixture-b', matchesCurrent: true }],
    })
    expect(field('credits.artist')).toMatchObject({
      label: 'Artists',
      value: ['Fixture Artist'],
      sources: [
        {
          provider: 'fixture-a',
          value: ['Fixture Artist'],
          matchesCurrent: true,
        },
      ],
    })
    expect(field('summary')).toBeUndefined()
  })

  it('reads films and refuses other items', async () => {
    const { applyProviderResult } = await import('@/services/provider-state')
    const { getMediaProvenance } = await import('@/services/media-provenance')
    await databaseClient.insert(schema.mediaItem).values({
      id: 'film-provenance',
      slug: 'film-provenance',
      title: 'Fixture Film',
      mediaType: 'film',
    })
    await databaseClient
      .insert(schema.film)
      .values({ mediaItemId: 'film-provenance' })
    await applyProviderResult({
      mediaItemId: 'film-provenance',
      mediaType: 'film',
      provider: 'fixture-a',
      source: 'scrape-job',
      ...PluginResultSchema.parse({
        payload: {},
        normalized: { filmPatch: { runtimeMinutes: 101 } },
      }),
    })
    const provenance = await getMediaProvenance('film-provenance')
    expect(provenance.mediaType).toBe('film')
    expect(
      provenance.fields.find((item) => item.key === 'runtimeMinutes'),
    ).toMatchObject({
      value: 101,
      sources: [{ provider: 'fixture-a', value: 101, matchesCurrent: true }],
    })
    await libraryTrack('track-provenance')
    await expect(getMediaProvenance('track-provenance')).rejects.toMatchObject({
      response: { statusCode: 404 },
    })
    await expect(getMediaProvenance('missing')).rejects.toMatchObject({
      response: { statusCode: 404 },
    })
  })
})

describe('coverage', () => {
  async function scraped(
    id: string,
    provider: string,
    at: Date,
    summary?: string,
  ) {
    await databaseClient.insert(schema.providerCurrentState).values({
      id: `${id}-${provider}`,
      mediaItemId: id,
      provider,
      checksum: 'fixture',
      payload: {},
      normalizedData: summary ? { mediaPatch: { summary } } : undefined,
      status: 'ready',
      lastSuccessfulAt: at,
      lastScrapedAt: at,
    })
  }

  it('counts covered, stale and missing albums for an artist and bounds the IDs', async () => {
    const { getArtistCoverage } = await import('@/services/metadata-coverage')
    const ids = Array.from(
      { length: 105 },
      (_, index) => `album-${String(index).padStart(3, '0')}`,
    )
    let artistId: string | null = null
    for (const id of ids)
      artistId = await album(id, {
        artist: 'Coverage Artist',
        hidden: id === 'album-002',
      })
    await album('album-elsewhere', { artist: 'Other Artist' })
    await scraped('album-000', 'fixture-a', new Date())
    await scraped('album-001', 'fixture-a', new Date(Date.now() - 400 * DAY))
    await scraped('album-001', 'fixture-b', new Date())
    await databaseClient.insert(schema.providerReference).values({
      id: 'album-000-fixture-b',
      mediaItemId: 'album-000',
      provider: 'fixture-b',
      referenceType: 'album',
      externalId: 'external-000',
    })

    const coverage = await getArtistCoverage(artistId ?? 'missing-artist', {
      olderThanDays: 180,
    })
    expect(coverage.total).toBe(104)
    const [a, b] = coverage.providers
    expect(a).toMatchObject({
      provider: 'fixture-a',
      eligible: 104,
      covered: 1,
      stale: 1,
      missing: 102,
      unavailableReason: null,
      staleItemIds: ['album-001'],
    })
    expect(a?.missingItemIds).toHaveLength(100)
    expect(a?.missingItemIds.slice(0, 2)).toEqual(['album-003', 'album-004'])
    expect(b).toMatchObject({
      provider: 'fixture-b',
      eligible: 2,
      covered: 1,
      stale: 0,
      missing: 1,
      unavailableReason: 'credentials-missing',
      missingItemIds: ['album-000'],
      staleItemIds: [],
    })

    const longer = await getArtistCoverage(artistId ?? 'missing-artist', {
      olderThanDays: 500,
    })
    expect(longer.providers[0]).toMatchObject({ covered: 2, stale: 0 })
    await expect(
      getArtistCoverage('missing', { olderThanDays: 180 }),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
  })

  it('covers a playlist through album entries and the albums of its tracks, and its IDs go through the reviewed album queue', async () => {
    const { getPlaylistCoverage } = await import('@/services/metadata-coverage')
    const { queueAlbumSelection } = await import('@/services/album-selection')
    const { replaceAlbumTracks } =
      await import('@/services/album-library-tracks')
    await album('album-entry', { artist: 'Fixture Artist' })
    await album('album-of-track', { artist: 'Fixture Artist' })
    await album('album-listing', { artist: 'Fixture Artist' })
    await album('album-unrelated', { artist: 'Fixture Artist' })
    await libraryTrack('track-entry', { albumId: 'album-of-track' })
    await databaseClient.transaction((tx) =>
      replaceAlbumTracks(tx, 'album-listing', [
        { title: 'Listed Song', position: 1 },
      ]),
    )
    const [listed] = await databaseClient
      .select({ id: schema.track.trackMediaItemId })
      .from(schema.track)
      .where(eq(schema.track.albumMediaItemId, 'album-listing'))
    await databaseClient.insert(schema.playlist).values({
      id: 'playlist-coverage',
      name: 'Coverage playlist',
      kind: 'playlist',
      source: 'spotify',
      spotifyId: 'fixturecoverage0000000',
    })
    await databaseClient.insert(schema.playlistItem).values([
      { playlistId: 'playlist-coverage', mediaItemId: 'album-entry' },
      { playlistId: 'playlist-coverage', mediaItemId: 'track-entry' },
      {
        playlistId: 'playlist-coverage',
        mediaItemId: listed?.id ?? 'missing-track',
      },
    ])
    await scraped(
      'album-entry',
      'fixture-a',
      new Date(),
      'Fixture album summary',
    )

    const coverage = await getPlaylistCoverage('playlist-coverage', {
      olderThanDays: 180,
    })
    expect(coverage.total).toBe(3)
    expect(coverage.providers[0]).toMatchObject({
      provider: 'fixture-a',
      eligible: 3,
      covered: 1,
      missing: 2,
      missingItemIds: ['album-listing', 'album-of-track'],
    })

    const missingItemIds = coverage.providers[0]?.missingItemIds ?? []
    const freshness = [{ provider: 'fixture-a', mode: 'unscraped' as const }]
    const queued = await queueAlbumSelection(
      {
        providers: ['fixture-a'],
        mediaItemIds: missingItemIds,
        freshness,
        confirmBroadRun: false,
        batchId: randomUUID(),
      },
      null,
    )
    expect(queued).toMatchObject({ queued: 2, skipped: 0 })
    const again = await queueAlbumSelection(
      {
        providers: ['fixture-a'],
        mediaItemIds: missingItemIds,
        freshness,
        confirmBroadRun: false,
        batchId: randomUUID(),
      },
      null,
    )
    expect(again).toMatchObject({ queued: 0, skipped: 2 })
    expect(execute).not.toHaveBeenCalled()
    expect(
      (await getPlaylistCoverage('playlist-coverage', { olderThanDays: 180 }))
        .providers[0],
    ).toMatchObject({ covered: 1, missing: 2 })
  })

  it('requires confirmation before queueing more than five coverage jobs', async () => {
    const { getArtistCoverage } = await import('@/services/metadata-coverage')
    const { queueAlbumSelection } = await import('@/services/album-selection')
    let artistId: string | null = null
    for (const index of [1, 2, 3, 4, 5, 6])
      artistId = await album(`album-broad-${index}`, { artist: 'Broad Artist' })
    const coverage = await getArtistCoverage(artistId ?? 'missing-artist', {
      olderThanDays: 180,
    })
    await expect(
      queueAlbumSelection(
        {
          providers: ['fixture-a'],
          mediaItemIds: coverage.providers[0]?.missingItemIds ?? [],
          confirmBroadRun: false,
          batchId: randomUUID(),
        },
        null,
      ),
    ).rejects.toMatchObject({ response: { statusCode: 422 } })
  })
})
