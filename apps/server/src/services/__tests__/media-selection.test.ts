import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { and, type SQL } from 'drizzle-orm'
import { FilmListItemSchema } from '@repo/schemas/media'
import { ProviderSummarySchema } from '@repo/schemas/provider'
import {
  FilmSelectionQuerySchema,
  QueueFilmSelectionSchema,
} from '@repo/schemas/film-selection'

const mocks = vi.hoisted(() => ({
  rows: vi.fn(),
  legacyRows: vi.fn(),
  attempts: vi.fn(),
  attemptQuery: vi.fn<(query: SQL) => void>(),
  providers: vi.fn(),
  queue: vi.fn(),
  validate: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  db: {
    select: (fields: Record<string, unknown>) => ({
      from: () => ({
        where: 'hasLegacyImport' in fields ? mocks.legacyRows : mocks.rows,
      }),
    }),
    execute: async (query: SQL) => {
      mocks.attemptQuery(query)
      return { rows: await mocks.attempts() }
    },
  },
}))
vi.mock('../providers', () => ({ listProviders: mocks.providers }))
vi.mock('../film-enrichment', async (original) => {
  const actual = await original<typeof import('../film-enrichment')>()
  return {
    ...actual,
    queueMediaEnrichment: mocks.queue,
    validateMediaProviders: mocks.validate,
  }
})
import {
  annotateSelection,
  listSelectionProviders,
  queueMediaSelection,
  selectionBrowseOptions,
} from '../media-selection'

const providers = ['one', 'two'].map((id) =>
  ProviderSummarySchema.parse({
    id,
    displayName: id,
    description: '',
    surface: 'provider',
    mediaTypes: ['film'],
    identifierTypes: [id === 'one' ? 'imdb' : 'tmdb'],
    rateLimit: { minTimeMs: 1000, maxConcurrent: 1 },
    supportsScrape: true,
    supportsLegacyImport: false,
    secrets:
      id === 'two'
        ? [
            {
              key: 'token',
              label: 'Token',
              required: true,
              configured: false,
              helpText: null,
              placeholder: null,
            },
          ]
        : [],
    pluginPath: null,
  }),
)
const film = FilmListItemSchema.parse({
  id: 'film-1',
  mediaType: 'film',
  slug: 'one',
  title: 'One',
  originalTitle: null,
  summary: null,
  artworkUrl: null,
  releaseDate: null,
  sourceLabel: null,
  metadata: null,
  tags: [],
  credits: [],
  links: [],
  playlists: [],
  providerReferences: [
    {
      provider: 'imdb',
      referenceType: 'imdb',
      externalId: 'tt1234567',
      url: null,
      isPrimary: true,
      metadata: null,
    },
  ],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  runtimeMinutes: null,
  budget: null,
  boxOffice: null,
  watched: false,
  sourceKind: null,
  dateAdded: '2026-01-01T00:00:00Z',
})
const request = QueueFilmSelectionSchema.parse({
  providers: ['one', 'two'],
  mediaItemIds: ['film-1', 'film-2'],
  batchId: '97d0dc00-0294-4232-9de1-a5178280c332',
  freshness: [
    { provider: 'one', mode: 'never' },
    { provider: 'two', mode: 'older', olderThanDays: 30 },
  ],
})

beforeEach(() => {
  mocks.attempts.mockResolvedValue([])
  mocks.legacyRows.mockResolvedValue([])
})

afterEach(() => {
  vi.resetAllMocks()
  vi.useRealTimers()
})

describe('unified metadata selection', () => {
  it('annotates legacy import evidence in a single batch without scraping providers', async () => {
    const items = [film, { ...film, id: 'film-2' }]
    mocks.legacyRows.mockResolvedValue([
      { id: film.id, hasLegacyImport: true },
      { id: 'film-2', hasLegacyImport: false },
    ])
    const result = await annotateSelection(
      { items, totalCount: items.length, pageCount: 1 },
      { page: 1, size: 50 },
      [],
    )
    expect(result.items.map((item) => item.hasLegacyImport)).toEqual([
      true,
      false,
    ])
    expect(mocks.legacyRows).toHaveBeenCalledTimes(1)
    expect(mocks.rows).not.toHaveBeenCalled()
    expect(mocks.attempts).not.toHaveBeenCalled()
    expect(mocks.queue).not.toHaveBeenCalled()
  })

  it.each(['yes', 'no'])(
    'combines legacy import %s with provider freshness using a null-safe predicate',
    (legacyImport) => {
      const options = selectionBrowseOptions(
        FilmSelectionQuerySchema.parse({
          legacyImport,
          freshness: [{ provider: 'one', mode: 'unscraped' }],
        }),
      )
      expect(options.conditions).toHaveLength(2)
      const predicate = and(...options.conditions)
      if (!predicate) throw new Error('Expected selection conditions')
      const query = new PgDialect().sqlToQuery(predicate)
      expect(query.sql).toContain(' and ')
      expect(query.sql).toContain('last_scraped_at')
      expect(query.sql).toContain('coalesce(')
      expect(query.sql).toContain("->>'legacyImport'")
      expect(query.params).toEqual(['one', legacyImport === 'yes'])
    },
  )

  it('loads all eligible providers, including ones awaiting credentials, and rejects foreign filters', async () => {
    mocks.providers.mockResolvedValue([
      ...providers,
      { ...providers[0], id: 'album-only', mediaTypes: ['album'] },
      { ...providers[0], id: 'import-only', supportsScrape: false },
    ])
    expect(
      await listSelectionProviders(FilmSelectionQuerySchema.parse({}), 'film'),
    ).toEqual(providers)
    await expect(
      listSelectionProviders(
        FilmSelectionQuerySchema.parse({
          freshness: [{ provider: 'album-only', mode: 'never' }],
        }),
        'film',
      ),
    ).rejects.toThrow()
    expect(mocks.rows).not.toHaveBeenCalled()
    expect(mocks.queue).not.toHaveBeenCalled()
  })

  it('annotates provider dates and attempts in batches and preserves import-only Never', async () => {
    mocks.rows.mockResolvedValue([
      { id: 'film-1', provider: 'one', date: new Date('2020-02-01') },
      { id: 'film-1', provider: 'two', date: null },
      { id: 'film-2', provider: 'two', date: new Date('2024-02-01') },
    ])
    const result = await annotateSelection(
      { items: [film, { ...film, id: 'film-2' }], totalCount: 2, pageCount: 1 },
      { page: 1, size: 50 },
      providers,
    )
    expect(mocks.rows).toHaveBeenCalledTimes(1)
    expect(result.items[0]?.providerFreshness).toEqual({
      one: {
        lastScrapedAt: '2020-02-01T00:00:00.000Z',
        hasProviderIdentifier: true,
        lastAttempt: null,
      },
      two: {
        lastScrapedAt: null,
        hasProviderIdentifier: false,
        lastAttempt: null,
      },
    })
    expect(result.items[1]?.providerFreshness.one?.lastScrapedAt).toBeNull()
    expect(result.items[1]?.providerFreshness.two?.lastScrapedAt).toBe(
      '2024-02-01T00:00:00.000Z',
    )
    expect(film).not.toHaveProperty('providerFreshness')
    expect(mocks.queue).not.toHaveBeenCalled()
  })

  it('does not issue freshness queries for empty results or no providers', async () => {
    await annotateSelection(
      { items: [], totalCount: 0, pageCount: 0 },
      { page: 1, size: 50 },
      providers,
    )
    expect(mocks.legacyRows).not.toHaveBeenCalled()
    await annotateSelection(
      { items: [film], totalCount: 1, pageCount: 1 },
      { page: 1, size: 50 },
      [],
    )
    expect(mocks.rows).not.toHaveBeenCalled()
    expect(mocks.attempts).not.toHaveBeenCalled()
  })

  it('builds AND predicates on successful scrape timestamps and sorts missing dates first only ascending', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-31T00:00:00Z'))
    const options = selectionBrowseOptions(
      FilmSelectionQuerySchema.parse({
        provider: 'two',
        sortBy: 'lastScrapedAt',
        direction: 'asc',
        freshness: request.freshness,
      }),
    )
    expect(options.conditions).toHaveLength(2)
    const predicate = and(...options.conditions)
    if (!predicate) throw new Error('Expected freshness conditions')
    const dialect = new PgDialect()
    const query = dialect.sqlToQuery(predicate)
    expect(query.sql).toContain(' and ')
    expect(query.sql).toContain('last_scraped_at')
    expect(query.sql).not.toMatch(/updated_at|last_successful_at/)
    expect(query.params).toEqual([
      'one',
      'one',
      'two',
      'two',
      '2026-01-01T00:00:00.000Z',
    ])
    expect(options.sort?.missingFirst).toBe(true)
    if (!options.sort) throw new Error('Expected provider sort')
    expect(dialect.sqlToQuery(options.sort.expression).params).toEqual(['two'])
    expect(
      selectionBrowseOptions(
        FilmSelectionQuerySchema.parse({ provider: 'one', direction: 'desc' }),
      ).sort?.missingFirst,
    ).toBe(false)
    expect(
      selectionBrowseOptions(
        FilmSelectionQuerySchema.parse({
          freshness: [{ provider: 'one', mode: 'all' }],
        }),
      ).conditions,
    ).toEqual([])
  })

  it('includes the latest failed attempt without replacing the last successful date', async () => {
    mocks.rows.mockResolvedValue([
      { id: film.id, provider: 'one', date: new Date('2026-01-01') },
    ])
    mocks.attempts.mockResolvedValue([
      {
        id: film.id,
        provider: 'one',
        status: 'failed',
        startedAt: new Date('2026-02-01'),
        finishedAt: new Date('2026-02-01T00:00:01Z'),
        message: 'Provider has no matching item (HTTP 404)',
        jobId: 'failed-job',
      },
    ])
    const result = await annotateSelection(
      { items: [film], totalCount: 1, pageCount: 1 },
      { page: 1, size: 50 },
      providers,
    )
    expect(result.items[0]?.providerFreshness.one).toMatchObject({
      lastScrapedAt: '2026-01-01T00:00:00.000Z',
      lastAttempt: {
        status: 'failed',
        error: 'Provider has no matching item (HTTP 404)',
        jobId: 'failed-job',
        startedAt: '2026-02-01T00:00:00.000Z',
      },
    })
    expect(mocks.attempts).toHaveBeenCalledTimes(1)
    const query = mocks.attemptQuery.mock.calls[0]?.[0]
    if (!query) throw new Error('Expected latest-attempt query')
    const compiled = new PgDialect().sqlToQuery(query)
    expect(compiled.sql).toContain('cross join lateral')
    expect(compiled.sql).toContain('limit 1')
    expect(compiled.sql).toContain("latest.started_at at time zone 'UTC'")
    expect(compiled.sql).toContain("latest.finished_at at time zone 'UTC'")
    expect(compiled.sql).toContain(
      'i.started_at desc nulls last, i.created_at desc nulls last, i.id desc nulls last',
    )
    expect(compiled.sql).toContain("i.status <> 'queued'")
    expect(compiled.sql).not.toContain('payload')
    expect(compiled.params).toEqual([[film.id], ['one', 'two']])
  })

  it('filters failures by the latest started attempt, not any historical failure', () => {
    const options = selectionBrowseOptions(
      FilmSelectionQuerySchema.parse({
        freshness: [{ provider: 'one', mode: 'failed' }],
      }),
    )
    const predicate = and(...options.conditions)
    if (!predicate) throw new Error('Expected failure predicate')
    const query = new PgDialect().sqlToQuery(predicate)
    expect(query.sql).toContain('i.media_item_id = "media_item"."id"')
    expect(query.sql).toContain('i.started_at is not null')
    expect(query.sql).toContain('limit 1')
    expect(query.sql).toMatch(/\) = 'failed'/)
    expect(query.sql).not.toContain('distinct on')
    expect(query.params).toEqual(['one'])
  })

  it('rechecks failed selections and skips a provider whose latest attempt recovered', async () => {
    mocks.rows
      .mockResolvedValueOnce([{ id: 'film-1' }, { id: 'film-2' }])
      .mockResolvedValueOnce([])
    mocks.attempts.mockResolvedValue([
      ...['failed', 'succeeded'].map((status, index) => ({
        id: `film-${index + 1}`,
        provider: 'one',
        status,
        startedAt: new Date('2026-02-01'),
        finishedAt: new Date('2026-02-01T00:00:01Z'),
        message: status === 'failed' ? 'Not found' : 'Completed successfully',
        jobId: `job-${index}`,
      })),
    ])
    mocks.queue.mockResolvedValue({ queued: 1, skipped: 0, warnings: [] })
    await queueMediaSelection(
      {
        ...request,
        providers: ['one'],
        freshness: [{ provider: 'one', mode: 'failed' }],
      },
      'film',
      'actor',
    )
    expect(mocks.queue).toHaveBeenCalledWith(
      [{ mediaItemId: 'film-1', provider: 'one' }],
      'actor',
      expect.any(Object),
    )
  })

  it('rechecks each selected provider in one batch and skips newly fresh pairs', async () => {
    mocks.rows
      .mockResolvedValueOnce([{ id: 'film-1' }, { id: 'film-2' }])
      .mockResolvedValueOnce([
        { id: 'film-1', provider: 'one', date: new Date() },
        { id: 'film-1', provider: 'two', date: new Date('2020-01-01') },
        { id: 'film-2', provider: 'two', date: new Date() },
      ])
    mocks.queue.mockResolvedValue({
      batchId: request.batchId,
      queued: 2,
      skipped: 0,
      warnings: [],
    })
    const result = await queueMediaSelection(request, 'film', 'actor')
    expect(mocks.rows).toHaveBeenCalledTimes(2)
    expect(mocks.queue).toHaveBeenCalledWith(
      [
        { mediaItemId: 'film-1', provider: 'two' },
        { mediaItemId: 'film-2', provider: 'one' },
      ],
      'actor',
      {
        batchId: request.batchId,
        missingOnly: false,
        confirmBroadRun: false,
        mediaType: 'film',
      },
    )
    expect(result.queued).toBe(2)
    expect(result.skipped).toBe(2)
  })

  it('requires broad confirmation before any database access or scheduling', async () => {
    await expect(
      queueMediaSelection(
        { ...request, mediaItemIds: ['one', 'two', 'three'] },
        'film',
        'actor',
      ),
    ).rejects.toThrow(/Confirm queueing/)
    expect(mocks.rows).not.toHaveBeenCalled()
    expect(mocks.queue).not.toHaveBeenCalled()
  })

  it('does not schedule any work when selected provider timestamps are now fresh', async () => {
    mocks.rows
      .mockResolvedValueOnce([{ id: 'film-1' }, { id: 'film-2' }])
      .mockResolvedValueOnce(
        ['film-1', 'film-2'].flatMap((id) =>
          ['one', 'two'].map((provider) => ({
            id,
            provider,
            date: new Date(),
          })),
        ),
      )
    const result = await queueMediaSelection(request, 'film', null)
    expect(result.queued).toBe(0)
    expect(result.skipped).toBe(4)
    expect(mocks.queue).not.toHaveBeenCalled()
  })

  it('All dates is an explicit rescrape without an unnecessary freshness lookup', async () => {
    mocks.rows.mockResolvedValue([{ id: 'film-1' }, { id: 'film-2' }])
    mocks.queue.mockResolvedValue({
      batchId: request.batchId,
      queued: 4,
      skipped: 0,
      warnings: [],
    })
    const result = await queueMediaSelection(
      { ...request, freshness: [{ provider: 'one', mode: 'all' }] },
      'album',
      'actor',
    )
    expect(result.queued).toBe(4)
    expect(mocks.rows).toHaveBeenCalledTimes(1)
    expect(mocks.queue).toHaveBeenCalledWith(
      expect.arrayContaining([
        { mediaItemId: 'film-1', provider: 'one' },
        { mediaItemId: 'film-1', provider: 'two' },
      ]),
      'actor',
      expect.objectContaining({ mediaType: 'album' }),
    )
  })
})
