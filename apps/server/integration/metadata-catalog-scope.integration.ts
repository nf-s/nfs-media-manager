import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { AlbumSelectionQuerySchema } from '@repo/schemas/album-selection'
import { FilmSelectionQuerySchema } from '@repo/schemas/film-selection'
import { ArtistMetadataQuerySchema } from '@repo/schemas/creators'
import { TrackMatchDiagnosticsQuerySchema } from '@repo/schemas/match-diagnostics'
import type { CatalogScopeQuery } from '@repo/schemas/catalog'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import {
  listAlbumSelection,
  queueAlbumSelection,
} from '@/services/album-selection'
import {
  listFilmSelection,
  queueFilmSelection,
} from '@/services/film-selection'
import { previewFilmRefresh } from '@/services/film-enrichment'
import {
  countArtistBrowse,
  listArtistMetadataBrowsePage,
  matchingArtistSelection,
} from '@/services/artist-browse'
import {
  createArtistSelectionSnapshot,
  listArtistSelectionSnapshotPage,
} from '@/services/artist-bulk-selection'
import { listTrackMatchDiagnostics } from '@/services/track-match-diagnostics'
import { queueSpotifyTrackSearches } from '@/services/spotify-track-search'
import { matchTidalTracks } from '@/services/tidal-track-match'
import { queueSonovaultTrackLookups } from '@/services/sonovault-track-lookup'
import { queueArtistSelection } from '@/services/artist-selection'

const database = `metadata_scope_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const fixture = drizzle(pool, { schema })
const owner = 'metadata-fixture-owner'
const variants = ['member', 'observed', 'other'] as const
const provider = vi.hoisted(() => ({
  id: 'fixture',
  mediaTypes: ['album', 'film'],
  supportsScrape: true,
  identifierTypes: [],
}))
let created = false

vi.mock('@/lib/db', () => ({
  get db() {
    return fixture
  },
}))
vi.mock('@/plugins/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/plugins/registry')>()),
  listProviderCatalog: async () => [provider],
  listArtistEnrichmentProviderIds: async () => ['spotify'],
}))
vi.mock('@/services/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/providers')>()),
  listProviders: async () => [provider],
}))

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Provider requests are disabled in this fixture')
    }),
  )
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
  await fixture
    .insert(schema.user)
    .values({ id: owner, name: 'Fixture Owner', email: 'owner@example.test' })
  const media = (['album', 'film', 'track'] as const).flatMap((mediaType) =>
    variants.map((variant) => ({
      id: `${mediaType}-${variant}`,
      slug: `${mediaType}-${variant}`,
      title: `Scope ${variant}`,
      mediaType,
      inLibrary: variant === 'member',
    })),
  )
  await fixture.insert(schema.mediaItem).values(media)
  await fixture
    .insert(schema.album)
    .values(variants.map((variant) => ({ mediaItemId: `album-${variant}` })))
  await fixture
    .insert(schema.film)
    .values(variants.map((variant) => ({ mediaItemId: `film-${variant}` })))
  await fixture
    .insert(schema.libraryTrack)
    .values(variants.map((variant) => ({ mediaItemId: `track-${variant}` })))
  await fixture.insert(schema.artist).values(
    variants.map((variant) => ({
      id: `artist-${variant}`,
      name: `Scope ${variant}`,
      addedToLibrary: variant === 'member',
    })),
  )
  await fixture.insert(schema.catalogObservation).values(
    ['album', 'film', 'track', 'artist'].flatMap((kind) =>
      variants.map((variant) => ({
        id: `${kind}-${variant}-discovery`,
        targetKind: kind,
        targetId: `${kind}-${variant}`,
        mediaItemId: kind === 'artist' ? null : `${kind}-${variant}`,
        provider: 'fixture',
        operation: variant === 'observed' ? 'fixture-result' : 'other-result',
      })),
    ),
  )
  await fixture.insert(schema.providerCurrentState).values(
    ['album', 'film'].map((kind) => ({
      id: `${kind}-other-state`,
      mediaItemId: `${kind}-other`,
      provider: 'fixture',
      checksum: 'fixture',
      payload: {},
      status: 'ready',
      lastScrapedAt: new Date(),
    })),
  )
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

const scopes = [
  { query: {}, expected: ['member'] },
  { query: { libraryScope: 'outside' }, expected: ['observed', 'other'] },
  { query: { libraryScope: 'all' }, expected: ['member', 'observed', 'other'] },
  {
    query: { libraryScope: 'all', discoverySources: 'fixture-result' },
    expected: ['member', 'observed'],
  },
  {
    query: {
      libraryScope: 'all',
      discoverySources: 'fixture-result',
      discoverySourceScope: 'selection',
    },
    expected: ['observed'],
  },
] satisfies { query: CatalogScopeQuery; expected: string[] }[]

it('reads the same scoped rows and totals across the four Metadata libraries and artist snapshots', async () => {
  for (const { query, expected } of scopes) {
    const album = await listAlbumSelection(
      AlbumSelectionQuerySchema.parse(query),
    )
    const film = await listFilmSelection(FilmSelectionQuerySchema.parse(query))
    const track = await listTrackMatchDiagnostics(
      TrackMatchDiagnosticsQuerySchema.parse({
        ...query,
        view: 'spotify-search-metadata',
      }),
    )
    const artistQuery = ArtistMetadataQuerySchema.parse(query)
    const [artist, count, snapshot] = await Promise.all([
      listArtistMetadataBrowsePage(artistQuery),
      countArtistBrowse(artistQuery),
      createArtistSelectionSnapshot(artistQuery, owner),
    ])
    for (const [kind, page] of [
      ['album', album],
      ['film', film],
      ['track', track],
    ] as const) {
      expect(page.totalCount).toBe(expected.length)
      expect(page.items.map(({ id }) => id).sort()).toEqual(
        expected.map((variant) => `${kind}-${variant}`),
      )
    }
    const artistIds = expected.map((variant) => `artist-${variant}`)
    expect(count.totalCount).toBe(expected.length)
    expect(snapshot.totalCount).toBe(expected.length)
    expect(artist.items.map(({ id }) => id).sort()).toEqual(artistIds)
    expect(
      (await listArtistSelectionSnapshotPage(snapshot.id, { size: 100 }, owner))
        .ids,
    ).toEqual(artistIds)
    expect(
      (
        await matchingArtistSelection(
          variants.map((variant) => `artist-${variant}`),
          query,
        )
      ).sort(),
    ).toEqual(artistIds)
  }
  const ordinaryMatches = await listTrackMatchDiagnostics(
    TrackMatchDiagnosticsQuerySchema.parse({ libraryScope: 'all' }),
  )
  expect(ordinaryMatches.items.map(({ id }) => id)).toEqual(['track-member'])
})

it('intersects freshness and refresh limits with scope and rejects stale selections before starting jobs', async () => {
  const freshness = [{ provider: 'fixture', mode: 'unscraped' }]
  const scope = { libraryScope: 'outside' }
  const album = await listAlbumSelection(
    AlbumSelectionQuerySchema.parse({ ...scope, freshness }),
  )
  const film = await listFilmSelection(
    FilmSelectionQuerySchema.parse({ ...scope, freshness }),
  )
  expect(album.items.map(({ id }) => id)).toEqual(['album-observed'])
  expect(film.items.map(({ id }) => id)).toEqual(['film-observed'])
  const refresh = { providers: ['fixture'], olderThanDays: 1, limit: 5 }
  expect((await previewFilmRefresh(refresh)).items.map(({ id }) => id)).toEqual(
    ['film-member'],
  )
  expect(
    (
      await previewFilmRefresh({ ...refresh, libraryScope: 'outside' })
    ).items.map(({ id }) => id),
  ).toEqual(['film-observed'])
  const queueInput = {
    providers: ['fixture'],
    confirmBroadRun: false,
    batchId: randomUUID(),
  }
  for (const action of [
    () =>
      queueAlbumSelection(
        { ...queueInput, mediaItemIds: ['album-observed'] },
        owner,
      ),
    () =>
      queueFilmSelection(
        {
          ...queueInput,
          mediaItemIds: ['film-member'],
          libraryScope: 'outside',
        },
        owner,
      ),
    () =>
      queueSpotifyTrackSearches(
        { trackIds: ['track-observed'], catalogScope: {} },
        owner,
      ),
    () =>
      matchTidalTracks(
        {
          trackIds: ['track-member'],
          catalogScope: { libraryScope: 'outside' },
        },
        owner,
      ),
    () =>
      queueSonovaultTrackLookups(
        {
          trackIds: ['track-other'],
          catalogScope: {
            libraryScope: 'outside',
            discoverySources: 'fixture-result',
          },
        },
        owner,
      ),
  ])
    await expect(action()).rejects.toThrow('outside the current scope')
  expect(
    await queueArtistSelection(
      {
        artistIds: ['artist-observed', 'artist-missing'],
        providers: ['spotify'],
        confirmBroadRun: false,
      },
      owner,
    ),
  ).toEqual({
    jobs: [],
    skipped: [
      {
        artistId: 'artist-observed',
        provider: 'spotify',
        reason: 'Artist is outside the current scope.',
      },
      {
        artistId: 'artist-missing',
        provider: 'spotify',
        reason: 'Artist is missing or archived.',
      },
    ],
  })
  expect(await fixture.$count(schema.scrapeJob)).toBe(0)
  expect(fetch).not.toHaveBeenCalled()
})
