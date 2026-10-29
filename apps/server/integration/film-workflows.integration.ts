import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { and, eq } from 'drizzle-orm'
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
import { ConfirmFilmImportSchema } from '@repo/schemas/imports'
import { CreateJobSchema, RefreshFilmsSchema } from '@repo/schemas/job'
import { FilmPatchSchema, FilmQuerySchema } from '@repo/schemas/media'
import { filmIdentificationStatus } from '@repo/schemas/browse'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { createCatalogEntryFromPlugin } from '@/lib/provider-catalog'

const database = `media_workflow_test_${randomUUID().replaceAll('-', '')}`
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
const plugins: MediaProviderPlugin[] = ['fixture-one', 'fixture-two'].map(
  (id) => ({
    manifest: {
      id,
      displayName: id,
      description: '',
      mediaTypes: ['film'],
      identifierTypes: ['imdb'],
      secrets: [],
      rateLimit: { maxConcurrent: 1, minTimeMs: 1 },
    },
    scrapeMediaItem: execute,
  }),
)
plugins.push({
  manifest: {
    id: 'fixture-bookmarks',
    displayName: 'Fixture bookmarks',
    description: '',
    mediaTypes: ['film'],
    secrets: [],
    rateLimit: { maxConcurrent: 1, minTimeMs: 1 },
    fileImports: [
      {
        id: 'bookmarks',
        label: 'Fixture bookmarks CSV',
        kind: 'csv',
        requiredColumns: ['ID', 'Title', 'Bookmarked'],
      },
    ],
  },
  async importFileRecord({ row }) {
    return PluginResultSchema.parse({
      payload: row,
      normalized: {
        mediaPatch: {
          title: row.Title,
          metadata: { bookmarked: true, bookmarkDate: row.Bookmarked },
        },
        references: [
          ...(row.IMDb
            ? [{ referenceType: 'imdb', externalId: row.IMDb }]
            : []),
          { referenceType: 'group', externalId: row.ID },
        ],
      },
    })
  },
  readStoredPersonalState({ payload, sourceKind }) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const bookmark = payload.savedBookmark
      if (bookmark && typeof bookmark === 'object' && !Array.isArray(bookmark))
        return {
          bookmarked: true,
          ...(typeof bookmark.date === 'string'
            ? { bookmarkDate: bookmark.date }
            : {}),
        }
    }
    return sourceKind === 'fixture-bookmark' ? { bookmarked: true } : null
  },
})
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/env')>()
  return {
    env: { ...actual.env, SCAN_DIR: resolve('integration/fixtures/films') },
  }
})
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => plugins,
  getScrapePlugin: async (id: string) =>
    plugins.find((plugin) => plugin.manifest.id === id) ?? null,
  listProviderCatalog: async () =>
    plugins.map((plugin) => createCatalogEntryFromPlugin(plugin, null)),
}))
let created = false
beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden in workflow tests')
    }),
  )
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.delete(schema.providerSnapshot)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.filmImportPreview)
  await databaseClient.delete(schema.libraryImport)
  execute.mockReset()
  execute.mockResolvedValue(
    PluginResultSchema.parse({ payload: { fixture: true }, normalized: {} }),
  )
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})
async function previewCsv(
  content = 'Const,Title,Created\ntt9999901,Identified fixture,2026-01-01\n,Unidentified fixture,2026-01-01',
) {
  const { prepareFilmImport } = await import('@/services/film-imports')
  return prepareFilmImport(
    { kind: 'csv', format: 'imdb-watchlist', fileName: 'fixture.csv', content },
    null,
  )
}
async function finishImport(id: string) {
  await vi.waitFor(async () => {
    const run = await databaseClient.query.libraryImport.findFirst({
      where: eq(schema.libraryImport.id, id),
    })
    expect(run?.status).toBe('succeeded')
  })
  // Wait for the asynchronous import's advisory-lock cleanup too.
  await vi.waitFor(async () => {
    const client = await pool.connect()
    try {
      const lock = await client.query(
        'select pg_try_advisory_lock(614103) as locked',
      )
      expect(lock.rows[0]?.locked).toBe(true)
      await client.query('select pg_advisory_unlock(614103)')
    } finally {
      client.release()
    }
  })
}

describe('media-scoped import history', () => {
  it('filters before the history limit and retains genuinely mixed legacy imports', async () => {
    const { getImportStatus } = await import('@/services/imports')
    await databaseClient.insert(schema.libraryImport).values(
      Array.from({ length: 25 }, (_, index) => ({
        id: `recent-film-${index}`,
        status: 'succeeded',
        stage: 'Complete',
        result: { albums: 0, films: 1 },
        createdAt: new Date('2026-02-01'),
      })),
    )
    await databaseClient.insert(schema.libraryImport).values([
      {
        id: 'old-album',
        status: 'succeeded',
        stage: 'Complete',
        result: { albums: 2, films: 0 },
        createdAt: new Date('2026-01-01'),
      },
      {
        id: 'mixed-legacy',
        status: 'succeeded',
        stage: 'Complete',
        result: { albums: 2, films: 2 },
        createdAt: new Date('2026-01-01'),
      },
      {
        id: 'running-album',
        status: 'running',
        stage: 'Starting',
        result: { albums: 0, films: 0, mediaType: 'album' },
      },
    ])
    const result = await getImportStatus({ mediaType: 'album' })
    expect(result.runs.map((run) => run.id).sort()).toEqual([
      'mixed-legacy',
      'old-album',
      'running-album',
    ])
    expect(
      result.runs.find((run) => run.id === 'running-album')?.mediaType,
    ).toBe('album')
    const { getJobActivity } = await import('@/services/jobs')
    const activity = await getJobActivity()
    expect(activity.imports).toBe(1)
    expect(
      activity.libraries.find((library) => library.mediaType === 'album')
        ?.imports,
    ).toBe(1)
    expect(
      activity.libraries.find((library) => library.mediaType === 'film')
        ?.imports,
    ).toBe(0)
  })
})

describe('reviewed film import and enrichment', () => {
  it('recognizes retained legacy bookmark membership and dates without rewriting equivalent canonical fields', async () => {
    const { prepareFilmImport, confirmFilmImport } =
      await import('@/services/film-imports')
    const { importFilmRecord, FilmImportCandidateSchema } =
      await import('@/services/file-imports')
    const id = await importFilmRecord(
      FilmImportCandidateSchema.parse({
        provider: 'fixture-bookmarks',
        source: 'legacy.json',
        result: {
          payload: {},
          normalized: {
            mediaPatch: { title: 'Legacy bookmark' },
            filmPatch: { sourceKind: 'fixture-bookmark' },
            references: [{ referenceType: 'group', externalId: '123' }],
          },
        },
      }),
    )
    await databaseClient.insert(schema.providerSnapshot).values({
      id: 'legacy-personal-fixture',
      mediaItemId: id,
      provider: 'legacy-record',
      source: 'legacy',
      checksum: 'fixture',
      payload: { savedBookmark: { date: '2026-01-01T00:00:00.000Z' } },
      normalizedData: {},
    })
    const before = await databaseClient.select().from(schema.mediaItem)
    const preview = await prepareFilmImport(
      {
        kind: 'csv',
        format: 'fixture-bookmarks:bookmarks',
        fileName: 'bookmarks.csv',
        content: 'ID,Title,Bookmarked\n123,Legacy bookmark,2026-01-01',
      },
      null,
    )
    expect(preview.items[0]).toMatchObject({ action: 'unchanged', changes: [] })
    await finishImport(
      (
        await confirmFilmImport(
          ConfirmFilmImportSchema.parse({
            previewId: preview.id,
            rows: [0],
            providers: ['fixture-one'],
          }),
          null,
        )
      ).id,
    )
    expect(await databaseClient.select().from(schema.mediaItem)).toEqual(before)
    expect(
      await databaseClient.select().from(schema.providerSnapshot),
    ).toHaveLength(2)
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(0)
    const changed = await prepareFilmImport(
      {
        kind: 'csv',
        format: 'fixture-bookmarks:bookmarks',
        fileName: 'bookmarks.csv',
        content: 'ID,Title,Bookmarked\n123,Legacy bookmark,2026-02-01',
      },
      null,
    )
    expect(changed.items[0]?.changes).toEqual([
      {
        field: 'metadata.bookmarkDate',
        label: 'Bookmark date',
        before: '2026-01-01T00:00:00.000Z',
        after: '2026-02-01T00:00:00.000Z',
      },
    ])
  })
  it('treats CSV descriptive metadata as new-film hints and preserves existing sources and overrides', async () => {
    const { prepareFilmImport, confirmFilmImport } =
      await import('@/services/film-imports')
    const header =
      'Const,Title,Your Rating,Date Rated,IMDb Rating,Num Votes,Year,Genres,Directors'
    const original = await prepareFilmImport(
      {
        kind: 'csv',
        format: 'imdb-ratings',
        fileName: 'ratings.csv',
        content: `${header}\ntt9999901,Original title,8,2025-01-01,7.5,100,2000,Drama,Original Director`,
      },
      null,
    )
    await finishImport(
      (
        await confirmFilmImport(
          ConfirmFilmImportSchema.parse({ previewId: original.id, rows: [0] }),
          null,
        )
      ).id,
    )
    const [item] = await databaseClient.select().from(schema.mediaItem)
    if (!item) throw new Error('Missing fixture')
    await databaseClient
      .update(schema.mediaItem)
      .set({
        sourceLabel: 'File',
        summary: 'Rich summary',
        artworkUrl: 'https://example.com/poster.jpg',
      })
      .where(eq(schema.mediaItem.id, item.id))
    await databaseClient
      .update(schema.film)
      .set({ sourceKind: 'file', watched: false })
      .where(eq(schema.film.mediaItemId, item.id))
    await databaseClient.insert(schema.mediaOverride).values({
      id: 'override-fixture',
      mediaItemId: item.id,
      field: 'watched',
      value: false,
    })
    const before = await databaseClient.select().from(schema.mediaItem)
    const preview = await prepareFilmImport(
      {
        kind: 'csv',
        format: 'imdb-ratings',
        fileName: 'ratings-new.csv',
        content: `${header}\ntt9999901,Different title spelling,8,2025-01-01,9.5,999,2001,Comedy,Replacement Director`,
      },
      null,
    )
    expect(preview.items[0]).toMatchObject({ action: 'unchanged', changes: [] })
    await finishImport(
      (
        await confirmFilmImport(
          ConfirmFilmImportSchema.parse({
            previewId: preview.id,
            rows: [0],
            providers: ['fixture-one'],
          }),
          null,
        )
      ).id,
    )
    expect(await databaseClient.select().from(schema.mediaItem)).toEqual(before)
    expect((await databaseClient.select().from(schema.film))[0]).toMatchObject({
      sourceKind: 'file',
      watched: false,
    })
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(0)
  })
  it('reports personal rating changes, preserves history and never enriches an existing film', async () => {
    const { prepareFilmImport, confirmFilmImport } =
      await import('@/services/film-imports')
    const previewRating = (rating: number) =>
      prepareFilmImport(
        {
          kind: 'csv',
          format: 'imdb-ratings',
          fileName: 'ratings.csv',
          content: `Const,Title,Your Rating,Date Rated\ntt9999901,Rated fixture,${rating},2026-01-01`,
        },
        null,
      )
    const seed = await previewRating(6)
    await finishImport(
      (
        await confirmFilmImport(
          ConfirmFilmImportSchema.parse({ previewId: seed.id, rows: [0] }),
          null,
        )
      ).id,
    )
    const updated = await previewRating(8)
    expect(updated.items[0]?.action).toBe('update')
    expect(updated.items[0]?.changes).toEqual([
      {
        field: 'metadata.browse.ratingImdbPersonal',
        label: 'Your IMDb rating',
        before: 6,
        after: 8,
      },
    ])
    const run = await confirmFilmImport(
      ConfirmFilmImportSchema.parse({
        previewId: updated.id,
        rows: [0],
        providers: ['fixture-one'],
      }),
      null,
    )
    await finishImport(run.id)
    expect(
      (
        await databaseClient.query.libraryImport.findFirst({
          where: eq(schema.libraryImport.id, run.id),
        })
      )?.result,
    ).toMatchObject({ created: 0, updated: 1, unchanged: 0, queuedJobs: 0 })
    expect(
      await databaseClient.select().from(schema.providerSnapshot),
    ).toHaveLength(2)
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(0)
    expect((await previewRating(8)).items[0]?.action).toBe('unchanged')
  })
  it('compares plugin bookmarks semantically and matches provider IDs without shared IDs', async () => {
    const { prepareFilmImport, confirmFilmImport } =
      await import('@/services/film-imports')
    const bookmarks = (date: string, fileName = 'bookmarks.csv') =>
      prepareFilmImport(
        {
          kind: 'csv',
          format: 'fixture-bookmarks:bookmarks',
          fileName,
          content: `ID,Title,Bookmarked\n123,Bookmark fixture,${date}`,
        },
        null,
      )
    const seed = await bookmarks('2026-01-01')
    await finishImport(
      (
        await confirmFilmImport(
          ConfirmFilmImportSchema.parse({ previewId: seed.id, rows: [0] }),
          null,
        )
      ).id,
    )
    const repeated = await bookmarks('2026-01-01', 'renamed.csv')
    expect(repeated.items[0]).toMatchObject({
      action: 'unchanged',
      changes: [],
    })
    expect((await bookmarks('')).items[0]).toMatchObject({
      action: 'unchanged',
      changes: [],
    })
    expect((await bookmarks('not a date')).items[0]).toMatchObject({
      action: 'unchanged',
      changes: [],
    })
    expect(
      (await bookmarks('2026-01-01T00:00:00.000Z')).items[0],
    ).toMatchObject({ action: 'unchanged', changes: [] })
    const changed = await bookmarks('2026-02-01')
    expect(changed.items[0]?.changes).toEqual([
      {
        field: 'metadata.bookmarkDate',
        label: 'Bookmark date',
        before: '2026-01-01',
        after: '2026-02-01T00:00:00.000Z',
      },
    ])
    await finishImport(
      (
        await confirmFilmImport(
          ConfirmFilmImportSchema.parse({
            previewId: repeated.id,
            rows: [0],
            providers: ['fixture-one'],
          }),
          null,
        )
      ).id,
    )
    expect(await databaseClient.select().from(schema.mediaItem)).toHaveLength(1)
    expect(
      await databaseClient.select().from(schema.providerSnapshot),
    ).toHaveLength(1)
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(0)
  })
  it('adds a missing shared identifier without losing a provider identifier or enriching an existing film', async () => {
    const { prepareFilmImport, confirmFilmImport } =
      await import('@/services/film-imports')
    const preview = (imdb: string) =>
      prepareFilmImport(
        {
          kind: 'csv',
          format: 'fixture-bookmarks:bookmarks',
          fileName: 'fixture.csv',
          content: `ID,IMDb,Title,Bookmarked\n123,${imdb},Bookmark fixture,2026-01-01`,
        },
        null,
      )
    const first = await preview('')
    await finishImport(
      (
        await confirmFilmImport(
          ConfirmFilmImportSchema.parse({ previewId: first.id, rows: [0] }),
          null,
        )
      ).id,
    )
    const identified = await preview('tt9999901')
    expect(identified.items[0]?.changes).toEqual([
      {
        field: 'reference.imdb',
        label: 'IMDb identifier',
        before: [],
        after: ['tt9999901'],
      },
    ])
    await finishImport(
      (
        await confirmFilmImport(
          ConfirmFilmImportSchema.parse({
            previewId: identified.id,
            rows: [0],
            providers: ['fixture-one'],
          }),
          null,
        )
      ).id,
    )
    const refs = await databaseClient.select().from(schema.providerReference)
    expect(refs.map((ref) => ref.referenceType).sort()).toEqual([
      'group',
      'imdb',
    ])
    expect((await preview('tt9999901')).items[0]?.action).toBe('unchanged')
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(0)
  })
  it('rechecks new rows at execution and reports actual results without enriching intervening inserts', async () => {
    const { confirmFilmImport } = await import('@/services/film-imports')
    const content =
      'Const,Title,Created\ntt9999901,Intervening fixture,2026-01-01'
    const stale = await previewCsv(content)
    const other = await previewCsv(content)
    await finishImport(
      (
        await confirmFilmImport(
          ConfirmFilmImportSchema.parse({ previewId: other.id, rows: [0] }),
          null,
        )
      ).id,
    )
    const run = await confirmFilmImport(
      ConfirmFilmImportSchema.parse({
        previewId: stale.id,
        rows: [0],
        providers: ['fixture-one'],
      }),
      null,
    )
    await finishImport(run.id)
    expect(
      (
        await databaseClient.query.libraryImport.findFirst({
          where: eq(schema.libraryImport.id, run.id),
        })
      )?.result,
    ).toMatchObject({ created: 0, updated: 0, unchanged: 1, queuedJobs: 0 })
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(0)
  })
  it('atomically decides creation for concurrent imports with overlapping identifiers', async () => {
    const { commitFilmImportRecord, FilmImportCandidateSchema } =
      await import('@/services/file-imports')
    const candidate = FilmImportCandidateSchema.parse({
      provider: 'fixture-one',
      source: 'fixture.csv',
      result: {
        payload: {},
        normalized: {
          mediaPatch: { title: 'Concurrent fixture' },
          references: [{ referenceType: 'imdb', externalId: 'tt9999901' }],
        },
      },
    })
    const results = await Promise.all([
      commitFilmImportRecord(candidate),
      commitFilmImportRecord(candidate),
    ])
    expect(results.map((result) => result.action).sort()).toEqual([
      'new',
      'unchanged',
    ])
    expect(new Set(results.map((result) => result.id)).size).toBe(1)
    expect(
      await databaseClient.select().from(schema.providerSnapshot),
    ).toHaveLength(1)
  })
  it('does not require broad enrichment confirmation for existing-only updates', async () => {
    const { confirmFilmImport } = await import('@/services/film-imports')
    const content =
      'Const,Title,Created\ntt9999901,One,2026-01-01\ntt9999902,Two,2026-01-01\ntt9999903,Three,2026-01-01'
    const seed = await previewCsv(content)
    await finishImport(
      (
        await confirmFilmImport(
          ConfirmFilmImportSchema.parse({
            previewId: seed.id,
            rows: [0, 1, 2],
          }),
          null,
        )
      ).id,
    )
    const repeat = await previewCsv(content)
    await finishImport(
      (
        await confirmFilmImport(
          ConfirmFilmImportSchema.parse({
            previewId: repeat.id,
            rows: [0, 1, 2],
            providers: ['fixture-one', 'fixture-two'],
          }),
          null,
        )
      ).id,
    )
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(0)
  })
  it('adds watchlist state to an existing rated film without replacing its source or enqueueing metadata', async () => {
    const { prepareFilmImport, confirmFilmImport } =
      await import('@/services/film-imports')
    const ratings = await prepareFilmImport(
      {
        kind: 'csv',
        format: 'imdb-ratings',
        fileName: 'ratings.csv',
        content:
          'Const,Title,Your Rating,Date Rated\ntt9999901,Rated fixture,8,2025-01-01',
      },
      null,
    )
    await finishImport(
      (
        await confirmFilmImport(
          ConfirmFilmImportSchema.parse({ previewId: ratings.id, rows: [0] }),
          null,
        )
      ).id,
    )
    const watchlist = await previewCsv(
      'Const,Title,Created\ntt9999901,Rated fixture,2026-01-01',
    )
    expect(watchlist.items[0]?.changes).toEqual([
      {
        field: 'metadata.watchlist',
        label: 'Watchlist status',
        before: null,
        after: true,
      },
    ])
    await finishImport(
      (
        await confirmFilmImport(
          ConfirmFilmImportSchema.parse({
            previewId: watchlist.id,
            rows: [0],
            providers: ['fixture-one'],
          }),
          null,
        )
      ).id,
    )
    expect(
      (await databaseClient.select().from(schema.mediaItem))[0]?.sourceLabel,
    ).toBe('IMDb Watched')
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(0)
  })
  it('does not silently recreate a film deleted after its existing-row preview', async () => {
    const { confirmFilmImport } = await import('@/services/film-imports')
    const content = 'Const,Title,Created\ntt9999901,Deleted fixture,2026-01-01'
    const seed = await previewCsv(content)
    await finishImport(
      (
        await confirmFilmImport(
          ConfirmFilmImportSchema.parse({ previewId: seed.id, rows: [0] }),
          null,
        )
      ).id,
    )
    const existing = await previewCsv(content)
    await databaseClient.delete(schema.mediaItem)
    const run = await confirmFilmImport(
      ConfirmFilmImportSchema.parse({
        previewId: existing.id,
        rows: [0],
        providers: ['fixture-one'],
      }),
      null,
    )
    await vi.waitFor(async () => {
      const completed = await databaseClient.query.libraryImport.findFirst({
        where: eq(schema.libraryImport.id, run.id),
      })
      expect(completed?.status).toBe('failed')
      expect(completed?.result).toMatchObject({
        created: 0,
        failed: 1,
        queuedJobs: 0,
      })
    })
    expect(await databaseClient.select().from(schema.mediaItem)).toHaveLength(0)
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(0)
  })
  it('classifies identical CSV rows as unchanged without timestamp or snapshot churn', async () => {
    const { confirmFilmImport } = await import('@/services/film-imports')
    const content = 'Const,Title,Created\ntt9999901,Existing fixture,2026-01-01'
    const first = await previewCsv(content)
    const run = await confirmFilmImport(
      ConfirmFilmImportSchema.parse({ previewId: first.id, rows: [0] }),
      null,
    )
    await finishImport(run.id)
    const before = await databaseClient.select().from(schema.mediaItem)
    const snapshots = await databaseClient
      .select()
      .from(schema.providerSnapshot)
    const current = await databaseClient
      .select()
      .from(schema.providerCurrentState)
    const filmRows = await databaseClient.select().from(schema.film)
    const again = await previewCsv(content)
    expect(again.items[0]?.action).toBe('unchanged')
    const repeat = await confirmFilmImport(
      ConfirmFilmImportSchema.parse({
        previewId: again.id,
        rows: [0],
        providers: ['fixture-one'],
      }),
      null,
    )
    await finishImport(repeat.id)
    expect(await databaseClient.select().from(schema.mediaItem)).toEqual(before)
    expect(await databaseClient.select().from(schema.providerSnapshot)).toEqual(
      snapshots,
    )
    expect(
      await databaseClient.select().from(schema.providerCurrentState),
    ).toEqual(current)
    expect(await databaseClient.select().from(schema.film)).toEqual(filmRows)
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(0)
  })
  it('queues enrichment only for newly created films, not existing films missing metadata', async () => {
    const { confirmFilmImport } = await import('@/services/film-imports')
    const first = await previewCsv(
      'Const,Title,Created\ntt9999901,Existing fixture,2026-01-01',
    )
    await finishImport(
      (
        await confirmFilmImport(
          ConfirmFilmImportSchema.parse({ previewId: first.id, rows: [0] }),
          null,
        )
      ).id,
    )
    const next = await previewCsv(
      'Const,Title,Created\ntt9999901,Existing fixture,2026-01-01\ntt9999902,New fixture,2026-01-01',
    )
    await finishImport(
      (
        await confirmFilmImport(
          ConfirmFilmImportSchema.parse({
            previewId: next.id,
            rows: [0, 1],
            providers: ['fixture-one'],
          }),
          null,
        )
      ).id,
    )
    const jobs = await databaseClient.select().from(schema.scrapeJobItem)
    const films = await databaseClient.select().from(schema.mediaItem)
    expect(jobs.map((job) => job.mediaItemId)).toEqual([
      films.find((film) => film.title === 'New fixture')?.id,
    ])
    expect(fetch).not.toHaveBeenCalled()
  })
  it('waits through cooldowns without attempting work, and pages/searches jobs', async () => {
    const { confirmFilmImport } = await import('@/services/film-imports')
    const { queueFilmEnrichment } = await import('@/services/film-enrichment')
    const { processQueuedJobs, listJobs, getJobActivity } =
      await import('@/services/jobs')
    const preview = await previewCsv(
      'Const,Title,Created\ntt9999901,Cooldown fixture,2026-01-01',
    )
    const run = await confirmFilmImport(
      ConfirmFilmImportSchema.parse({ previewId: preview.id, rows: [0] }),
      null,
    )
    await finishImport(run.id)
    const [film] = await databaseClient.select().from(schema.mediaItem)
    if (!film) throw new Error('Missing fixture')
    await databaseClient.insert(schema.providerRequestState).values({
      provider: 'fixture-one',
      cooldownUntil: new Date(Date.now() + 3600000),
    })
    const pairs = [{ mediaItemId: film.id, provider: 'fixture-one' }]
    expect(
      (
        await queueFilmEnrichment(pairs, null, {
          batchId: 'batch',
          missingOnly: true,
          confirmBroadRun: false,
        })
      ).queued,
    ).toBe(1)
    expect(
      (
        await queueFilmEnrichment(pairs, null, {
          batchId: 'batch',
          missingOnly: true,
          confirmBroadRun: false,
        })
      ).skipped,
    ).toBe(1)
    await processQueuedJobs()
    expect(execute).not.toHaveBeenCalled()
    expect((await getJobActivity()).queued).toBe(1)
    expect(
      (
        await listJobs({
          q: 'Cooldown',
          batchId: 'batch',
          status: 'active',
          size: 1,
        })
      ).totalCount,
    ).toBe(1)
    expect((await listJobs({ q: '%' })).totalCount).toBe(0)
    expect(
      (await listJobs({ q: 'Cooldown', page: 2, size: 1 })).items,
    ).toHaveLength(0)
    await databaseClient.delete(schema.providerRequestState)
    await processQueuedJobs()
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('retries an unsuccessful one-film job and enforces provider cooldown on retry', async () => {
    const { confirmFilmImport } = await import('@/services/film-imports')
    const { createJob, processQueuedJobs, getJob, retryJob } =
      await import('@/services/jobs')
    const preview = await previewCsv(
      'Const,Title,Created\ntt9999901,One,2026-01-01\ntt9999902,Two,2026-01-01',
    )
    const run = await confirmFilmImport(
      ConfirmFilmImportSchema.parse({
        previewId: preview.id,
        rows: [0, 1],
      }),
      null,
    )
    await finishImport(run.id)
    const films = await databaseClient.select().from(schema.mediaItem)
    const jobs = []
    for (const film of films)
      jobs.push(
        await createJob(
          CreateJobSchema.parse({
            provider: 'fixture-one',
            scope: { mediaItemIds: [film.id] },
            options: { batchId: 'retry-batch' },
          }),
          null,
        ),
      )
    execute
      .mockResolvedValueOnce(
        PluginResultSchema.parse({ payload: {}, normalized: {} }),
      )
      .mockRejectedValueOnce(new Error('Fixture error one'))
    await processQueuedJobs()
    const [successful, original] = jobs
    if (!successful || !original) throw new Error('Missing fixture jobs')
    expect((await getJob(successful.id))?.status).toBe('succeeded')
    const failed = await getJob(original.id)
    expect(failed?.items.map((item) => item.status)).toEqual(['failed'])
    await databaseClient
      .update(schema.providerRequestState)
      .set({ cooldownUntil: new Date(Date.now() + 3600000) })
      .where(eq(schema.providerRequestState.provider, 'fixture-one'))
    await expect(retryJob(original.id, null, false)).rejects.toThrow(
      /cooling down/,
    )
    await databaseClient.delete(schema.providerRequestState)
    const retry = await retryJob(original.id, null, false)
    expect(retry.items).toHaveLength(1)
    expect(retry.items[0]?.mediaItemId).toBe(failed?.items[0]?.mediaItemId)
    await expect(retryJob(successful.id, null, false)).rejects.toThrow()
    expect((await retryJob(original.id, null, false)).id).toBe(retry.id)
    await processQueuedJobs()
    expect((await getJob(retry.id))?.status).toBe('succeeded')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('cancels remaining provider jobs after repeated failures across separate jobs', async () => {
    const { confirmFilmImport } = await import('@/services/film-imports')
    const { queueFilmEnrichment } = await import('@/services/film-enrichment')
    const { processQueuedJobs, listJobs } = await import('@/services/jobs')
    const preview = await previewCsv(
      'Const,Title,Created\ntt9999901,One,2026-01-01\ntt9999902,Two,2026-01-01\ntt9999903,Three,2026-01-01',
    )
    const run = await confirmFilmImport(
      ConfirmFilmImportSchema.parse({ previewId: preview.id, rows: [0, 1, 2] }),
      null,
    )
    await finishImport(run.id)
    const films = await databaseClient.select().from(schema.mediaItem)
    await queueFilmEnrichment(
      films.map((film) => ({ mediaItemId: film.id, provider: 'fixture-one' })),
      null,
      { batchId: 'failure-batch', missingOnly: true, confirmBroadRun: false },
    )
    execute.mockRejectedValue(new Error('Fixture failure'))
    await processQueuedJobs()
    await processQueuedJobs()
    await processQueuedJobs()
    expect(execute).toHaveBeenCalledTimes(2)
    expect(
      (await listJobs({ batchId: 'failure-batch' })).items
        .map((job) => job.status)
        .sort(),
    ).toEqual(['cancelled', 'failed', 'failed'])
  })
  it('stages previews without library writes, retains missing IDs and imports exact reviewed rows once', async () => {
    const { confirmFilmImport } = await import('@/services/film-imports')
    const preview = await previewCsv()
    expect(preview.items.map((item) => item.needsIdentification)).toEqual([
      false,
      true,
    ])
    expect(await databaseClient.select().from(schema.mediaItem)).toHaveLength(0)
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(0)
    await expect(
      confirmFilmImport(
        ConfirmFilmImportSchema.parse({ previewId: preview.id, rows: [9] }),
        null,
      ),
    ).rejects.toThrow(/Selection/)
    const input = ConfirmFilmImportSchema.parse({
      previewId: preview.id,
      rows: [0, 1],
      providers: ['fixture-one', 'fixture-two'],
    })
    const run = await confirmFilmImport(input, null)
    await finishImport(run.id)
    expect(await databaseClient.select().from(schema.mediaItem)).toHaveLength(2)
    const jobs = await databaseClient.select().from(schema.scrapeJob)
    expect(jobs).toHaveLength(2)
    expect(jobs.every((job) => job.options['batchId'] === preview.id)).toBe(
      true,
    )
    const { processQueuedJobs } = await import('@/services/jobs')
    await processQueuedJobs()
    await processQueuedJobs()
    expect(execute).toHaveBeenCalledTimes(2)
    expect(
      execute.mock.calls.every(([context]) =>
        context.existingReferences.some(
          (ref) =>
            ref.referenceType === 'imdb' && ref.externalId === 'tt9999901',
        ),
      ),
    ).toBe(true)
    await expect(confirmFilmImport(input, null)).rejects.toThrow(/already/)
    const again = await previewCsv()
    const secondRun = await confirmFilmImport(
      ConfirmFilmImportSchema.parse({
        previewId: again.id,
        rows: [0, 1],
        providers: ['fixture-one', 'fixture-two'],
      }),
      null,
    )
    await finishImport(secondRun.id)
    expect(await databaseClient.select().from(schema.mediaItem)).toHaveLength(2)
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(2)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects broad runs, expired previews and previews owned by another user', async () => {
    const { confirmFilmImport } = await import('@/services/film-imports')
    const preview = await previewCsv(
      'Const,Title,Created\ntt9999901,One,2026-01-01\ntt9999902,Two,2026-01-01\ntt9999903,Three,2026-01-01',
    )
    const input = ConfirmFilmImportSchema.parse({
      previewId: preview.id,
      rows: [0, 1, 2],
      providers: ['fixture-one', 'fixture-two'],
    })
    await expect(confirmFilmImport(input, null)).rejects.toThrow(
      /Confirm queueing/,
    )
    await expect(
      confirmFilmImport({ ...input, confirmBroadRun: true }, 'another-user'),
    ).rejects.toThrow(/unavailable/)
    await databaseClient
      .update(schema.filmImportPreview)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.filmImportPreview.id, preview.id))
    await expect(
      confirmFilmImport({ ...input, confirmBroadRun: true }, null),
    ).rejects.toThrow(/expired/)
    expect(await databaseClient.select().from(schema.mediaItem)).toHaveLength(0)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('previews only new NFO films from the server directory, including unidentified films', async () => {
    const { prepareFilmImport, confirmFilmImport } =
      await import('@/services/film-imports')
    const seed = await previewCsv(
      'Const,Title,Created\ntt9999901,Existing,2026-01-01',
    )
    const run = await confirmFilmImport(
      ConfirmFilmImportSchema.parse({ previewId: seed.id, rows: [0] }),
      null,
    )
    await finishImport(run.id)
    const preview = await prepareFilmImport({ kind: 'nfo' }, null)
    expect(preview.existing).toBe(1)
    expect(preview.items).toHaveLength(2)
    expect(preview.items.some((item) => item.needsIdentification)).toBe(true)
    expect(await databaseClient.select().from(schema.mediaItem)).toHaveLength(1)
    const imported = await confirmFilmImport(
      ConfirmFilmImportSchema.parse({
        previewId: preview.id,
        rows: preview.items.map((item) => item.row),
      }),
      null,
    )
    await finishImport(imported.id)
    expect(await databaseClient.select().from(schema.mediaItem)).toHaveLength(3)
    expect((await prepareFilmImport({ kind: 'nfo' }, null)).items).toHaveLength(
      0,
    )
    expect(fetch).not.toHaveBeenCalled()
  })
  it('marks missing IDs, normalizes edits, shares corrections and rejects identity conflicts', async () => {
    const { confirmFilmImport } = await import('@/services/film-imports')
    const { queryBrowseIds } = await import('@/services/browse')
    const { patchFilm, getFilmDetail } = await import('@/services/media')
    const { createJob, processQueuedJobs } = await import('@/services/jobs')
    const { applyProviderResult } = await import('@/services/provider-state')
    const preview = await previewCsv()
    const run = await confirmFilmImport(
      ConfirmFilmImportSchema.parse({ previewId: preview.id, rows: [0, 1] }),
      null,
    )
    await finishImport(run.id)
    const missing = await queryBrowseIds(
      'film',
      FilmQuerySchema.parse({
        filters: JSON.stringify([
          { field: 'identification', value: 'Needs ID' },
        ]),
      }),
    )
    expect(missing.ids).toHaveLength(1)
    const id = missing.ids[0]
    if (!id) throw new Error('Missing fixture')
    const job = CreateJobSchema.parse({
      provider: 'fixture-one',
      scope: { mediaItemIds: [id] },
    })
    await expect(createJob(job, null)).rejects.toThrow(/Needs imdb ID/)
    await expect(
      patchFilm(
        id,
        {
          referenceOverrides: [
            {
              provider: 'imdb',
              referenceType: 'imdb',
              externalId: 'tt9999901',
            },
          ],
        },
        null,
      ),
    ).rejects.toThrow(/already/)
    await patchFilm(
      id,
      FilmPatchSchema.parse({
        referenceOverrides: [
          {
            provider: 'imdb',
            referenceType: 'imdb',
            externalId: 'https://www.imdb.com/title/tt9999998/',
          },
        ],
      }),
      null,
    )
    await applyProviderResult({
      mediaItemId: id,
      mediaType: 'film',
      provider: 'fixture-one',
      source: 'file-import',
      ...PluginResultSchema.parse({
        payload: {},
        normalized: {
          references: [{ referenceType: 'imdb', externalId: 'tt0000001' }],
        },
      }),
    })
    const detail = await getFilmDetail(id)
    expect(filmIdentificationStatus(detail?.providerReferences ?? [])).toBe(
      'Identified',
    )
    expect(
      detail?.providerReferences.every((ref) => ref.externalId === 'tt9999998'),
    ).toBe(true)
    await createJob(job, null)
    await processQueuedJobs()
    expect(
      execute.mock.calls[0]?.[0].existingReferences.find(
        (ref) => ref.referenceType === 'imdb',
      )?.externalId,
    ).toBe('tt9999998')
  })
  it('refreshes provider-specific stale data without treating imports as live scrapes', async () => {
    const { confirmFilmImport } = await import('@/services/film-imports')
    const { previewFilmRefresh } = await import('@/services/film-enrichment')
    const { applyProviderResult } = await import('@/services/provider-state')
    const preview = await previewCsv(
      'Const,Title,Created\ntt9999901,Identified,2026-01-01',
    )
    const run = await confirmFilmImport(
      ConfirmFilmImportSchema.parse({ previewId: preview.id, rows: [0] }),
      null,
    )
    await finishImport(run.id)
    const [film] = await databaseClient.select().from(schema.mediaItem)
    if (!film) throw new Error('Missing fixture')
    const request = RefreshFilmsSchema.parse({
      providers: ['fixture-one', 'fixture-two'],
    })
    expect((await previewFilmRefresh(request)).jobs).toBe(2)
    const result = PluginResultSchema.parse({
      payload: { version: 1 },
      normalized: {},
    })
    await applyProviderResult({
      mediaItemId: film.id,
      mediaType: 'film',
      provider: 'fixture-one',
      source: 'scrape-job',
      ...result,
    })
    expect(
      (await previewFilmRefresh(request)).items[0]?.providers.map(
        (item) => item.provider,
      ),
    ).toEqual(['fixture-two'])
    const old = new Date('2020-01-01')
    await databaseClient
      .update(schema.providerCurrentState)
      .set({ lastScrapedAt: old })
      .where(
        and(
          eq(schema.providerCurrentState.mediaItemId, film.id),
          eq(schema.providerCurrentState.provider, 'fixture-one'),
        ),
      )
    await applyProviderResult({
      mediaItemId: film.id,
      mediaType: 'film',
      provider: 'fixture-one',
      source: 'file-import',
      ...result,
    })
    expect((await previewFilmRefresh(request)).jobs).toBe(2)
    expect(fetch).not.toHaveBeenCalled()
  })
})
