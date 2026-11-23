import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ArchivableBrowseFacetQuerySchema } from '@repo/schemas/browse'
import {
  AlbumListItemSchema,
  AlbumQuerySchema,
  FilmQuerySchema,
} from '@repo/schemas/media'
import { getBrowseValues } from '@repo/schemas/browse'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const database = `browse_filter_fields_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const fixture = drizzle(pool, { schema })

vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))
vi.mock('@/lib/db', () => ({
  get db() {
    return fixture
  },
}))

const archived = { legacyHidden: true }

let created = false
beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network requests are forbidden in integration tests')
    }),
  )
  await admin.connect()
  // The identifier is generated locally from a UUID, never from user input.
  await admin.query(`create database ${database}`)
  created = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
  // Invented albums: a record with one edition, a single album and an
  // archived album; two films, one archived.
  await fixture.insert(schema.mediaItem).values([
    {
      id: 'album-first',
      slug: 'album-first',
      title: 'Alder',
      mediaType: 'album',
    },
    {
      id: 'album-other',
      slug: 'album-other',
      title: 'Birch',
      mediaType: 'album',
    },
    {
      id: 'album-solo',
      slug: 'album-solo',
      title: 'Cedar',
      mediaType: 'album',
    },
    {
      id: 'album-archived',
      slug: 'album-archived',
      title: 'Dogwood',
      mediaType: 'album',
      metadata: archived,
    },
    { id: 'film-shown', slug: 'film-shown', title: 'Elm', mediaType: 'film' },
    {
      id: 'film-archived',
      slug: 'film-archived',
      title: 'Fir',
      mediaType: 'film',
      metadata: archived,
    },
  ])
  await fixture
    .insert(schema.album)
    .values([
      { mediaItemId: 'album-first' },
      { mediaItemId: 'album-other', editionOfId: 'album-first' },
      { mediaItemId: 'album-solo' },
      { mediaItemId: 'album-archived' },
    ])
  await fixture
    .insert(schema.film)
    .values([{ mediaItemId: 'film-shown' }, { mediaItemId: 'film-archived' }])
  await fixture.insert(schema.providerReference).values([
    {
      id: 'reference-album',
      mediaItemId: 'album-archived',
      provider: 'fixture-archive',
      referenceType: 'fixture-id',
      externalId: '1',
    },
    {
      id: 'reference-film',
      mediaItemId: 'film-archived',
      provider: 'fixture-archive',
      referenceType: 'fixture-id',
      externalId: '2',
    },
    {
      id: 'reference-lastfm',
      mediaItemId: 'album-solo',
      provider: 'lastfm',
      referenceType: 'lastfm-url',
      externalId: '3',
    },
    {
      id: 'reference-tmdb',
      mediaItemId: 'film-shown',
      provider: 'tmdb',
      referenceType: 'tmdb',
      externalId: '4',
    },
  ])
  await fixture
    .insert(schema.tag)
    .values({ id: 'tag-archive', mediaType: 'album', name: 'Archive Tide' })
  await fixture
    .insert(schema.mediaItemTag)
    .values({ mediaItemId: 'album-archived', tagId: 'tag-archive' })
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

async function albums(input: Record<string, unknown>) {
  const { listAlbums } = await import('@/services/media')
  return (
    await listAlbums(
      AlbumQuerySchema.parse({
        sortBy: 'title',
        direction: 'asc',
        ...input,
        ...('filters' in input
          ? { filters: JSON.stringify(input.filters) }
          : {}),
      }),
    )
  ).items
}
const albumIds = async (input: Record<string, unknown> = {}) =>
  (await albums(input)).map((item) => item.id)
const edition = (value: string, mode?: string) => [
  { field: 'edition', value, ...(mode ? { mode } : {}) },
]

describe('the Albums Edition field', () => {
  it('lists editions only when asked for, as rows or by the filter', async () => {
    expect(await albumIds()).toEqual(['album-first', 'album-solo'])
    expect(
      await albumIds({ filters: edition('Edition of another album') }),
    ).toEqual(['album-other'])
    expect(
      await albumIds({ filters: edition('not an edition', 'required') }),
    ).toEqual(['album-first', 'album-solo'])
    expect(
      await albumIds({
        filters: edition('Edition of another album', 'exclude'),
      }),
    ).toEqual(['album-first', 'album-solo'])
    expect(await albumIds({ filters: edition('Edition') })).toEqual([])
    expect(
      await albumIds({
        filters: edition('Not an edition'),
        includeArchived: 'true',
      }),
    ).toEqual(['album-first', 'album-solo', 'album-archived'])
  })

  it('sorts by its value and shows it as a column', async () => {
    const sorted = await albums({
      editions: 'true',
      sortBy: 'edition',
      direction: 'asc',
    })
    expect(sorted.map((item) => item.id)).toEqual([
      'album-other',
      'album-first',
      'album-solo',
    ])
    expect(
      sorted.map(
        (item) => getBrowseValues(AlbumListItemSchema.parse(item)).edition,
      ),
    ).toEqual(['Edition of another album', 'Not an edition', 'Not an edition'])
  })

  it('is not matched by the ordinary words of a free-text search', async () => {
    expect(await albumIds({ q: 'edition', editions: 'true' })).toEqual([])
    expect(await albumIds({ q: 'another', editions: 'true' })).toEqual([])
  })

  it('suggests both values with whole-library counts, editions included', async () => {
    const { listAlbumFilterOptions } = await import('@/services/media')
    const options = await listAlbumFilterOptions(
      ArchivableBrowseFacetQuerySchema.parse({ q: 'edition' }),
    )
    expect(
      options
        .filter((option) => option.field === 'edition')
        .map(({ value, count, label }) => ({ value, count, label })),
    ).toEqual([
      { value: 'Not an edition', count: 2, label: 'Edition: Not an edition' },
      {
        value: 'Edition of another album',
        count: 1,
        label: 'Edition: Edition of another album',
      },
    ])
  })
})

describe('archived items in suggestions', () => {
  const suggestions = async (
    mediaType: 'album' | 'film',
    input: Record<string, string>,
  ) => {
    const { listAlbumFilterOptions, listFilmFilterOptions } =
      await import('@/services/media')
    const list =
      mediaType === 'album' ? listAlbumFilterOptions : listFilmFilterOptions
    return (await list(ArchivableBrowseFacetQuerySchema.parse(input))).map(
      ({ field, value, count }) => ({ field, value, count }),
    )
  }

  it.each(['album', 'film'] as const)(
    'counts %s values found only on archived items with Include archived',
    async (mediaType) => {
      const provider = { field: 'provider', value: 'fixture-archive', count: 1 }
      expect(
        await suggestions(mediaType, { q: 'fixture-archive' }),
      ).not.toContainEqual(provider)
      expect(
        await suggestions(mediaType, {
          q: 'fixture-archive',
          includeArchived: 'true',
        }),
      ).toContainEqual(provider)
      expect(
        await suggestions(mediaType, {
          q: 'fixture-archive',
          includeArchived: 'false',
        }),
      ).not.toContainEqual(provider)
    },
  )

  it('counts archived albums in tag and edition suggestions', async () => {
    const tag = { field: 'genre', value: 'archive tide', count: 1 }
    expect(
      await suggestions('album', { q: 'archive tide' }),
    ).not.toContainEqual(tag)
    expect(
      await suggestions('album', {
        q: 'archive tide',
        includeArchived: 'true',
      }),
    ).toContainEqual(tag)
    expect(
      await suggestions('album', { q: 'not an', includeArchived: 'true' }),
    ).toContainEqual({ field: 'edition', value: 'Not an edition', count: 3 })
  })

  it('lists the archived item the suggestion counts', async () => {
    const { listFilms } = await import('@/services/media')
    const films = await listFilms(
      FilmQuerySchema.parse({
        includeArchived: 'true',
        filters: JSON.stringify([
          { field: 'provider', value: 'fixture-archive' },
        ]),
      }),
    )
    expect(films.items.map((item) => item.id)).toEqual(['film-archived'])
  })
})

describe('provider display names in suggestions', () => {
  const providers = async (mediaType: 'album' | 'film', q: string) => {
    const { listAlbumFilterOptions, listFilmFilterOptions } =
      await import('@/services/media')
    const list =
      mediaType === 'album' ? listAlbumFilterOptions : listFilmFilterOptions
    return (await list(ArchivableBrowseFacetQuerySchema.parse({ q }))).filter(
      (option) => option.field === 'provider',
    )
  }

  it.each([
    ['album', 'last.fm', 'lastfm', 'Last.fm'],
    ['album', 'LASTFM', 'lastfm', 'Last.fm'],
    ['film', 'tmdb', 'tmdb', 'TMDb'],
  ] as const)(
    'labels a %s provider found by "%s" with its display name',
    async (mediaType, q, value, name) => {
      expect(await providers(mediaType, q)).toEqual([
        { field: 'provider', value, count: 1, label: `Provider: ${name}` },
      ])
    },
  )

  it('keeps the ID as the filter value and the ID of an unlisted provider as its name', async () => {
    expect(
      await albumIds({ filters: [{ field: 'provider', value: 'lastfm' }] }),
    ).toEqual(['album-solo'])
    expect(
      await providers('album', 'fixture-archive').then((rows) =>
        rows.map((row) => row.label),
      ),
    ).toEqual([])
    const { listFilmFilterOptions } = await import('@/services/media')
    expect(
      (
        await listFilmFilterOptions(
          ArchivableBrowseFacetQuerySchema.parse({
            q: 'fixture',
            includeArchived: 'true',
          }),
        )
      ).find((option) => option.field === 'provider')?.label,
    ).toBe('Provider: fixture-archive')
  })
})
