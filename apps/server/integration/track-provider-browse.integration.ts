import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BrowseFacetQuerySchema } from '@repo/schemas/browse'
import { TrackMatchDiagnosticsQuerySchema } from '@repo/schemas/match-diagnostics'
import { TrackQuerySchema } from '@repo/schemas/tracks'
import { env } from '@/env'
import { slugifyParts } from '@/lib/media-utils'
import * as schema from '@/schemas/db'

const database = `track_provider_browse_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const fixture = drizzle(pool, { schema })

vi.mock('@/lib/db', () => ({
  get db() {
    return fixture
  },
}))
vi.mock('@/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/env')>()
  return {
    env: {
      ...actual.env,
      APP_URL: 'https://web.example.test',
      AUTH_BASE_URL: 'https://api.example.test',
      TRUSTED_ORIGINS: ['https://web.example.test', 'https://api.example.test'],
    },
  }
})
vi.mock('@/lib/auth', () => ({
  auth: {
    api: {
      async getSession({ headers }: { headers: Headers }) {
        if (!headers.has('cookie')) return null
        return {
          user: { id: 'fixture-owner', email: 'owner@example.test' },
          session: { userId: 'fixture-owner' },
        }
      },
    },
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))

// track-1: a TIDAL track ID. track-2: a Sonovault match, verified or not.
// track-3: a Spotify track ID, also stored as a reference. track-4: only an
// ISRC that TIDAL reported. track-5: nothing. The album's TIDAL ID is not a
// track's.
const tracks = [
  ['track-1', 'Alpha fixture'],
  ['track-2', 'Bravo fixture'],
  ['track-3', 'Charlie fixture'],
  ['track-4', 'Delta fixture'],
  ['track-5', 'Echo fixture'],
] as const

let created = false
beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden')
    }),
  )
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
  await fixture.insert(schema.mediaItem).values({
    id: 'album-1',
    slug: 'album-1',
    title: 'Fixture album',
    mediaType: 'album',
  })
  await fixture.insert(schema.album).values({ mediaItemId: 'album-1' })
  for (const [index, [id, title]] of tracks.entries()) {
    await fixture.insert(schema.mediaItem).values({
      id,
      slug: slugifyParts(id),
      title,
      mediaType: 'track',
      sourceLabel: 'spotify',
    })
    await fixture.insert(schema.libraryTrack).values({
      mediaItemId: id,
      durationSec: 200,
      spotifyTrackId: id === 'track-3' ? 'fixture0spotify0track0' : null,
      dateAdded: new Date(Date.UTC(2026, 0, index + 1)),
    })
  }
  await fixture.insert(schema.providerReference).values([
    {
      id: 'reference-1',
      mediaItemId: 'track-1',
      provider: 'tidal',
      referenceType: 'track',
      externalId: '1000001',
    },
    {
      id: 'reference-2',
      mediaItemId: 'track-2',
      provider: 'sonovault',
      referenceType: 'sonovault-track',
      externalId: 'sv-fixture-2',
    },
    {
      id: 'reference-3',
      mediaItemId: 'track-3',
      provider: 'spotify',
      referenceType: 'track',
      externalId: 'fixture0spotify0track0',
    },
    {
      id: 'reference-4',
      mediaItemId: 'track-4',
      provider: 'tidal',
      referenceType: 'isrc',
      externalId: 'XX0000000004',
    },
    {
      id: 'reference-album',
      mediaItemId: 'album-1',
      provider: 'tidal',
      referenceType: 'album',
      externalId: '2000001',
    },
  ])
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

async function page(input: Record<string, unknown>) {
  const { listTrackBrowsePage } = await import('@/services/tracks')
  return listTrackBrowsePage(
    TrackQuerySchema.parse({
      size: 50,
      sortBy: 'title',
      direction: 'asc',
      ...input,
    }),
  )
}
const ids = (result: { items: { id: string }[] }) =>
  result.items.map((item) => item.id)
const providerFilter = (value: string, mode?: string) =>
  JSON.stringify([{ field: 'provider', value, ...(mode ? { mode } : {}) }])

async function suggestions(q: string) {
  const { default: app } = await import('@/app')
  const response = await app.request(
    `/api/v1/tracks/facets?${new URLSearchParams({ q })}`,
    {
      headers: {
        cookie: 'session=fixture',
        origin: 'https://web.example.test',
      },
    },
  )
  expect(response.status).toBe(200)
  const body: {
    data: { field: string; value: string; count: number; label: string }[]
  } = await response.json()
  return body.data
    .filter((row) => row.field === 'provider')
    .map(({ value, count, label }) => ({ value, count, label }))
}

describe('the Provider field on Tracks', () => {
  it('filters on the providers with an ID for each track', async () => {
    for (const sortBy of ['title', 'dateAdded']) {
      const filtered = async (value: string, mode?: string) =>
        ids(await page({ sortBy, filters: providerFilter(value, mode) })).sort()
      expect(await filtered('tidal')).toEqual(['track-1'])
      expect(await filtered('TIDAL', 'required')).toEqual(['track-1'])
      // An unverified match is still an ID Sonovault gave the track.
      expect(await filtered('sonovault')).toEqual(['track-2'])
      expect(await filtered('spotify')).toEqual(['track-3'])
      expect(await filtered('tidal', 'exclude')).toEqual([
        'track-2',
        'track-3',
        'track-4',
        'track-5',
      ])
      expect(await filtered('spotify', 'exclude')).toEqual([
        'track-1',
        'track-2',
        'track-4',
        'track-5',
      ])
      expect(await filtered('discogs')).toEqual([])
    }
    const { queryBrowseCount } = await import('@/services/browse')
    expect(
      await queryBrowseCount(
        'track',
        TrackQuerySchema.parse({ filters: providerFilter('tidal', 'exclude') }),
      ),
    ).toEqual({ totalCount: 4 })
  })

  it('reads Spotify from the track’s own Spotify ID', async () => {
    await pool.query(
      "update library_track set spotify_track_id = 'fixture0spotify0track5' where media_item_id = 'track-5'",
    )
    try {
      expect(
        ids(await page({ filters: providerFilter('spotify') })).sort(),
      ).toEqual(['track-3', 'track-5'])
    } finally {
      await pool.query(
        "update library_track set spotify_track_id = null where media_item_id = 'track-5'",
      )
    }
  })

  it('sorts by provider with tracks without one last', async () => {
    const sorted = async (direction: string) =>
      ids(await page({ sortBy: 'provider', direction }))
    const ascending = await sorted('asc')
    expect(ascending.slice(0, 3)).toEqual(['track-2', 'track-3', 'track-1'])
    expect(ascending.slice(3).sort()).toEqual(['track-4', 'track-5'])
    const descending = await sorted('desc')
    expect(descending.slice(0, 3)).toEqual(['track-1', 'track-3', 'track-2'])
    expect(descending.slice(3).sort()).toEqual(['track-4', 'track-5'])
  })

  it('lists each row’s providers once', async () => {
    const rows = await page({})
    expect(
      Object.fromEntries(rows.items.map((item) => [item.id, item.providers])),
    ).toEqual({
      'track-1': ['tidal'],
      'track-2': ['sonovault'],
      'track-3': ['spotify'],
      'track-4': [],
      'track-5': [],
    })
  })

  it('does not match a provider’s name as search text', async () => {
    expect(ids(await page({ q: 'tidal' }))).toEqual([])
    expect(ids(await page({ q: 'sonovault' }))).toEqual([])
  })

  it('suggests providers with whole-library counts, live and stored', async () => {
    // The value is the ID; the label names the provider as the catalog does,
    // and typing the display name finds it.
    const expected = {
      tidal: [{ value: 'tidal', count: 1, label: 'Provider: TIDAL' }],
      Sonovault: [
        { value: 'sonovault', count: 1, label: 'Provider: Sonovault' },
      ],
      spotify: [{ value: 'spotify', count: 1, label: 'Provider: Spotify' }],
    }
    // The stored vocabulary is not built yet, so these are read live.
    for (const [q, rows] of Object.entries(expected))
      expect(await suggestions(q)).toEqual(rows)
    const { refreshTrackFacetVocabularyForMaintenance } =
      await import('@/services/browse')
    await pool.query(`insert into track_facet_state (singleton, builder, retry_after)
      values (true, 'fixture', '-infinity')`)
    expect(await refreshTrackFacetVocabularyForMaintenance()).toBe(true)
    expect(
      (
        await pool.query(
          "select value, count from track_facet_value where field = 'provider' order by value",
        )
      ).rows,
    ).toEqual([
      { value: 'sonovault', count: 1 },
      { value: 'spotify', count: 1 },
      { value: 'tidal', count: 1 },
    ])
    for (const [q, rows] of Object.entries(expected))
      expect(await suggestions(q)).toEqual(rows)
    expect(
      (await pool.query('select ready from track_facet_state')).rows,
    ).toEqual([{ ready: true }])
  })

  it('filters the Matches worklist and suggests providers there', async () => {
    const { listTrackMatchDiagnosticIds, listTrackMatchDiagnosticsFacets } =
      await import('@/services/track-match-diagnostics')
    const matched = await listTrackMatchDiagnosticIds(
      TrackMatchDiagnosticsQuerySchema.parse({
        view: 'providers',
        filters: providerFilter('tidal', 'exclude'),
      }),
    )
    expect(matched.ids.sort()).toEqual([
      'track-2',
      'track-3',
      'track-4',
      'track-5',
    ])
    const facets = await listTrackMatchDiagnosticsFacets(
      BrowseFacetQuerySchema.parse({ q: 'sonovault' }),
    )
    expect(
      facets
        .filter((row) => row.field === 'provider')
        .map(({ value, count, label }) => ({ value, count, label })),
    ).toEqual([
      { value: 'sonovault', count: 1, label: 'Provider ID: Sonovault' },
    ])
  })
})
