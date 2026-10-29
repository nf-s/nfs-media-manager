import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AlbumQuerySchema, FilmQuerySchema } from '@repo/schemas/media'
import { PluginResultSchema } from '@repo/media-plugin-sdk'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import {
  LegacyBrowseRecordSchema,
  normalizeLegacyBrowse,
} from '@/lib/legacy-browse'

const database = `media_parity_test_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
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
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('temporary Postgres browse and import integration', () => {
  it('recovers film added dates offline, sorts and filters them, and preserves manual corrections', async () => {
    const { applyProviderResult } = await import('@/services/provider-state')
    const { getFilmDetail, patchFilm } = await import('@/services/media')
    const { queryBrowseIds } = await import('@/services/browse')
    const { backfillFilmAddedDates } =
      await import('../scripts/backfill-film-added')
    for (const id of ['added-a', 'added-b', 'added-c']) {
      await databaseClient.insert(schema.mediaItem).values({
        id,
        title: id,
        slug: id,
        mediaType: 'film',
        createdAt: new Date('2025-01-01'),
      })
      await databaseClient.insert(schema.film).values({ mediaItemId: id })
    }
    await applyProviderResult({
      mediaItemId: 'added-a',
      mediaType: 'film',
      provider: 'legacy-record',
      source: 'legacy-import',
      ...PluginResultSchema.parse({
        payload: { imdb: { myWatchlist: { date: '2012-04-22' } } },
      }),
    })
    expect((await backfillFilmAddedDates()).recoverable).toBe(1)
    expect((await getFilmDetail('added-a'))?.dateAdded).toBe(
      '2025-01-01T00:00:00.000Z',
    )
    expect((await backfillFilmAddedDates(true)).updated).toBe(1)
    expect((await backfillFilmAddedDates(true)).updated).toBe(0)
    expect((await getFilmDetail('added-a'))?.dateAdded).toBe(
      '2012-04-22T00:00:00.000Z',
    )
    expect((await getFilmDetail('added-c'))?.dateAddedSource).toBe(
      'Library import (original date unknown)',
    )
    const imported = (
      dateAdded: string,
    ): Parameters<typeof applyProviderResult>[0] => ({
      mediaItemId: 'added-b',
      mediaType: 'film',
      provider: 'fixture',
      source: 'file-import',
      ...PluginResultSchema.parse({
        payload: { dateAdded },
        normalized: {
          filmPatch: { dateAdded, dateAddedSource: 'Fixture date' },
        },
      }),
    })
    await applyProviderResult(imported('2010-01-01T00:00:00.000Z'))
    await applyProviderResult(imported('2020-01-01T00:00:00.000Z'))
    expect((await getFilmDetail('added-b'))?.dateAdded).toBe(
      '2010-01-01T00:00:00.000Z',
    )
    const query = (direction: 'asc' | 'desc') =>
      queryBrowseIds(
        'film',
        FilmQuerySchema.parse({ q: 'added-', sortBy: 'dateAdded', direction }),
      )
    expect((await query('asc')).ids).toEqual(['added-b', 'added-a', 'added-c'])
    expect((await query('desc')).ids).toEqual(['added-c', 'added-a', 'added-b'])
    expect(
      (
        await queryBrowseIds(
          'film',
          FilmQuerySchema.parse({
            q: 'added-',
            ranges: JSON.stringify([
              { field: 'dateAdded', max: Date.parse('2011-01-01') },
            ]),
          }),
        )
      ).ids,
    ).toEqual(['added-b'])
    await applyProviderResult({
      ...imported('2000-01-01T00:00:00.000Z'),
      source: 'scrape',
    })
    expect((await getFilmDetail('added-b'))?.dateAdded).toBe(
      '2010-01-01T00:00:00.000Z',
    )
    await patchFilm('added-b', { dateAdded: '2015-01-01' }, null)
    await applyProviderResult(imported('2000-01-01T00:00:00.000Z'))
    expect((await getFilmDetail('added-b'))?.dateAddedSource).toBe('Manual')
    expect((await getFilmDetail('added-b'))?.dateAdded).toBe(
      '2015-01-01T00:00:00.000Z',
    )
    await patchFilm('added-a', { dateAdded: null }, null)
    expect((await backfillFilmAddedDates(true)).updated).toBe(0)
    expect((await getFilmDetail('added-a'))?.dateAdded).toBe(
      '2025-01-01T00:00:00.000Z',
    )
    await applyProviderResult({
      mediaItemId: 'added-c',
      mediaType: 'film',
      provider: 'imdb-watchlist',
      source: 'file-import',
      ...PluginResultSchema.parse({
        payload: {
          file: '/fixture.csv',
          data: { Title: 'Film', Created: '2014-01-01' },
        },
      }),
    })
    expect((await backfillFilmAddedDates(true)).updated).toBe(1)
    expect((await getFilmDetail('added-c'))?.dateAdded).toBe(
      '2014-01-01T00:00:00.000Z',
    )
    expect((await backfillFilmAddedDates(true)).updated).toBe(0)
    for (const id of ['added-a', 'added-b', 'added-c'])
      await databaseClient
        .delete(schema.mediaItem)
        .where(eq(schema.mediaItem.id, id))
    expect(fetch).not.toHaveBeenCalled()
  })
  it('imports film files idempotently, matches external identities and preserves rich data', async () => {
    const { importFilmRecord } = await import('@/services/file-imports')
    const { normalizeNfo, normalizeImdbCsv } =
      await import('@/lib/film-file-normalizers')
    const { getFilmDetail } = await import('@/services/media')
    const nfo = normalizeNfo(
      '<movie><title>File fixture</title><uniqueid type="imdb">tt9999999</uniqueid><uniqueid type="tmdb">9999999</uniqueid><plot>Rich summary</plot><actor><name>Fixture Actor</name></actor><watched>false</watched></movie>',
    )
    const ratings = normalizeImdbCsv(
      {
        Const: 'tt9999999',
        Title: 'CSV title',
        'Your Rating': '8',
        'Date Rated': '2025-01-01',
        Directors: 'Fixture Director',
      },
      'imdb-ratings',
    )
    const watchlist = normalizeImdbCsv(
      { Const: 'tt9999999', Title: 'CSV title' },
      'imdb-watchlist',
    )
    if (!ratings || !watchlist) throw new Error('Invalid fixture')
    for (const candidate of [
      { provider: 'nfo', result: nfo, source: '/fixture/movie.nfo' },
      {
        provider: 'imdb-ratings',
        result: ratings,
        source: '/fixture/ratings.csv',
      },
      {
        provider: 'imdb-watchlist',
        result: watchlist,
        source: '/fixture/watchlist.csv',
      },
      { provider: 'nfo', result: nfo, source: '/fixture/movie.nfo' },
    ])
      await importFilmRecord(candidate)
    const rows = await databaseClient
      .select()
      .from(schema.providerReference)
      .where(eq(schema.providerReference.externalId, 'tt9999999'))
    expect(new Set(rows.map((row) => row.mediaItemId)).size).toBe(1)
    const id = rows[0]?.mediaItemId
    if (!id) throw new Error('Missing imported fixture')
    const item = await getFilmDetail(id)
    expect(item?.title).toBe('File fixture')
    expect(item?.summary).toBe('Rich summary')
    expect(item?.watched).toBe(true)
    expect(item?.sourceLabel).toBe('File')
    expect(item?.sourceKind).toBe('file')
    expect(item?.metadata['browse']).toMatchObject({ ratingImdbPersonal: 8 })
    const { queryBrowseIds } = await import('@/services/browse')
    expect(
      (
        await queryBrowseIds(
          'film',
          FilmQuerySchema.parse({
            ranges: JSON.stringify([
              {
                field: 'ratingImdbPersonalDate',
                min: Date.parse('2025-01-01'),
                max: Date.parse('2025-01-02'),
              },
            ]),
          }),
        )
      ).ids,
    ).toContain(id)
    const credits = await databaseClient
      .select()
      .from(schema.mediaCredit)
      .where(eq(schema.mediaCredit.mediaItemId, id))
    // CSV credits are bootstrap hints, not replacements/additions on existing films.
    expect(credits.map((credit) => credit.role).sort()).toEqual(['actor'])
    const snapshots = await databaseClient
      .select()
      .from(schema.providerSnapshot)
      .where(eq(schema.providerSnapshot.mediaItemId, id))
    expect(snapshots).toHaveLength(3)
    expect(fetch).not.toHaveBeenCalled()
    await databaseClient
      .delete(schema.mediaItem)
      .where(eq(schema.mediaItem.id, id))
  })
  it('migrates, imports fixtures, queries all fields and preserves overrides/history', async () => {
    const { applyProviderResult } = await import('@/services/provider-state')
    const { queryBrowseIds, listBrowseFacets } =
      await import('@/services/browse')
    const { getAlbumDetail, patchAlbum } = await import('@/services/media')
    const fixtures = [
      {
        id: 'a',
        title: 'Alpha',
        artists: ['Artist One'],
        genres: ['ambient', 'jazz'],
        scrobbles: 0,
        popularitySpotify: 80,
      },
      {
        id: 'b',
        title: 'Beta',
        artists: ['Artist Two'],
        genres: ['jazz'],
        scrobbles: 10,
        popularitySpotify: 10,
      },
      {
        id: 'c',
        title: 'Gamma',
        artists: ['Artist Three'],
        genres: ['rock'],
        scrobbles: 5,
      },
    ]
    for (const fixture of fixtures) {
      await databaseClient.insert(schema.mediaItem).values({
        id: fixture.id,
        title: fixture.title,
        slug: fixture.id,
        mediaType: 'album',
      })
      await databaseClient
        .insert(schema.album)
        .values({ mediaItemId: fixture.id })
      const result = normalizeLegacyBrowse(
        LegacyBrowseRecordSchema.parse(fixture),
        'album',
      )
      await applyProviderResult({
        mediaItemId: fixture.id,
        mediaType: 'album',
        provider: 'fixture',
        source: 'legacy-import',
        ...result,
      })
    }
    const query = (value: unknown) =>
      queryBrowseIds('album', AlbumQuerySchema.parse(value))
    expect(
      (await query({ sortBy: 'scrobbles', direction: 'asc' })).ids,
    ).toEqual(['a', 'c', 'b'])
    expect(
      (await query({ sortBy: 'popularitySpotify', direction: 'desc' })).ids,
    ).toEqual(['a', 'b', 'c'])
    expect(
      (await query({ sortBy: 'popularitySpotify', direction: 'asc' })).ids,
    ).toEqual(['b', 'a', 'c'])
    expect(
      (
        await query({
          filters: JSON.stringify([
            { field: 'genre', value: 'ambient' },
            { field: 'artist', value: 'Artist Two' },
          ]),
        })
      ).totalCount,
    ).toBe(2)
    expect(
      (
        await query({
          filters: JSON.stringify([
            { field: 'genre', value: 'jazz' },
            { field: 'genre', value: 'ambient', mode: 'exclude' },
          ]),
        })
      ).ids,
    ).toEqual(['b'])
    expect(
      (
        await query({
          filters: JSON.stringify([
            { field: 'genre', value: 'jazz', mode: 'required' },
            { field: 'genre', value: 'ambient', mode: 'required' },
          ]),
        })
      ).ids,
    ).toEqual(['a'])
    expect(
      (
        await query({
          ranges: JSON.stringify([
            { field: 'popularitySpotify', min: 50, includeMissing: true },
          ]),
        })
      ).totalCount,
    ).toBe(2)
    expect(
      (
        await query({
          ranges: JSON.stringify([
            { field: 'popularitySpotify', min: 50 },
            { field: 'scrobbles', min: 1 },
          ]),
        })
      ).totalCount,
    ).toBe(0)
    expect((await query({ q: 'Artist Three' })).ids).toEqual(['c'])
    expect((await query({ q: '%' })).ids).toEqual([])
    expect((await query({ limitResults: 1 })).ids).toHaveLength(1)
    await expect(query({ sortBy: 'invalid' })).rejects.toThrow()
    const facets = await listBrowseFacets('album')
    expect(
      facets.find((facet) => facet.field === 'genre' && facet.value === 'jazz')
        ?.count,
    ).toBe(2)
    const first = PluginResultSchema.parse({
      payload: { version: 1 },
      normalized: {
        mediaPatch: { title: 'Provider title' },
        references: [{ referenceType: 'album', externalId: 'original' }],
      },
    })
    const second = PluginResultSchema.parse({
      payload: { version: 2 },
      normalized: {
        mediaPatch: { title: 'Next title' },
        references: [{ referenceType: 'album', externalId: 'original' }],
      },
    })
    for (const result of [first, second, first, first])
      await applyProviderResult({
        mediaItemId: 'a',
        mediaType: 'album',
        provider: 'history-fixture',
        source: 'legacy-import',
        ...result,
      })
    expect(
      await databaseClient
        .select()
        .from(schema.providerSnapshot)
        .where(eq(schema.providerSnapshot.provider, 'history-fixture')),
    ).toHaveLength(2)
    await patchAlbum(
      'a',
      {
        title: 'My title',
        referenceOverrides: [
          {
            provider: 'history-fixture',
            referenceType: 'album',
            externalId: 'corrected',
          },
        ],
      },
      null,
    )
    await applyProviderResult({
      mediaItemId: 'a',
      mediaType: 'album',
      provider: 'history-fixture',
      source: 'legacy-import',
      ...second,
    })
    const detail = await getAlbumDetail('a')
    expect(detail?.title).toBe('My title')
    expect(
      detail?.providerReferences.find(
        (ref) => ref.provider === 'history-fixture',
      )?.externalId,
    ).toBe('corrected')
    await applyProviderResult({
      mediaItemId: 'a',
      mediaType: 'album',
      provider: 'history-fixture',
      source: 'legacy-import',
      ...PluginResultSchema.parse({
        payload: { version: 3 },
        normalized: {
          references: [{ referenceType: 'release', externalId: 'new-release' }],
        },
      }),
    })
    const corrected = await getAlbumDetail('a')
    expect(
      corrected?.providerReferences.find(
        (ref) =>
          ref.provider === 'history-fixture' && ref.referenceType === 'album',
      )?.externalId,
    ).toBe('corrected')
    await databaseClient
      .update(schema.mediaItem)
      .set({ metadata: { legacyHidden: true } })
      .where(eq(schema.mediaItem.id, 'c'))
    expect((await query({})).totalCount).toBe(2)
    expect((await query({ includeArchived: 'true' })).totalCount).toBe(3)
    await databaseClient.insert(schema.mediaItem).values({
      id: 'film-fixture',
      title: 'Film',
      slug: 'film-fixture',
      mediaType: 'film',
      sourceLabel: 'Blu-ray',
      metadata: {
        browse: {
          country: ['France', 'Canada'],
          language: ['French'],
          productionCompany: ['Studio'],
          ratingImdbValue: 8,
        },
      },
    })
    await databaseClient
      .insert(schema.film)
      .values({ mediaItemId: 'film-fixture', sourceKind: 'bluray' })
    expect(
      (
        await queryBrowseIds(
          'film',
          FilmQuerySchema.parse({ sourceKind: 'bluray' }),
        )
      ).ids,
    ).toEqual(['film-fixture'])
    for (const [field, value] of [
      ['country', 'france'],
      ['language', 'French'],
      ['productionCompany', 'Studio'],
    ]) {
      expect(
        (
          await queryBrowseIds(
            'film',
            FilmQuerySchema.parse({
              filters: JSON.stringify([{ field, value }]),
            }),
          )
        ).ids,
      ).toEqual(['film-fixture'])
    }
    expect(
      (
        await queryBrowseIds(
          'film',
          FilmQuerySchema.parse({
            ranges: JSON.stringify([{ field: 'ratingImdbValue', min: 7 }]),
            sortBy: 'country',
          }),
        )
      ).ids,
    ).toEqual(['film-fixture'])
    expect(fetch).not.toHaveBeenCalled()
  })
})
