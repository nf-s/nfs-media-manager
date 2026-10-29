import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { type SQL } from 'drizzle-orm'

const mocks = vi.hoisted(() => {
  const database = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
  }
  return {
    database,
    transaction: vi.fn(async (fn: (tx: typeof database) => Promise<unknown>) =>
      fn(database),
    ),
    values: vi.fn(),
    where: vi.fn(),
    apply: vi.fn(),
    start: vi.fn(),
    validate: vi.fn(),
    confirmation: vi.fn(),
    enrichment: vi.fn(),
  }
})
vi.mock('@/lib/db', () => ({
  db: { ...mocks.database, transaction: mocks.transaction },
}))
vi.mock('@/services/provider-state', () => ({
  applyProviderResultInTransaction: mocks.apply,
}))
vi.mock('@/services/imports', () => ({ startManagedImport: mocks.start }))
vi.mock('@/services/film-enrichment', () => ({
  validateMediaProviders: mocks.validate,
  requireEnrichmentConfirmation: mocks.confirmation,
  queueMediaEnrichment: mocks.enrichment,
}))
import {
  collectAlbumCsv,
  albumImportId,
  type AlbumImportCandidate,
} from '@/lib/album-import-candidates'
import {
  commitAlbumImportRecord,
  confirmAlbumImport,
  matchAlbumCandidates,
  prepareAlbumCandidates,
} from '../album-imports'

function query(rows: unknown[]) {
  const result = Object.assign(Promise.resolve(rows), {
    from: vi.fn(),
    where: vi.fn((condition: SQL) => {
      mocks.where(condition)
      return result
    }),
    innerJoin: vi.fn(),
    returning: vi.fn(),
    values: mocks.values,
    set: vi.fn(),
    onConflictDoNothing: vi.fn(),
  })
  for (const method of [
    result.from,
    result.innerJoin,
    result.returning,
    result.set,
    result.onConflictDoNothing,
  ])
    method.mockReturnValue(result)
  return result
}
function candidate(title: string): AlbumImportCandidate {
  const record = collectAlbumCsv({
    format: 'album-csv',
    fileName: 'albums.csv',
    content: `title,artist\n${title},Artist`,
  }).records[0]
  if (!record) throw new Error('Missing test candidate')
  return record
}
function stored(
  records: Array<AlbumImportCandidate & { action: 'new' | 'unchanged' }>,
) {
  return {
    id: 'preview',
    kind: 'album-csv',
    source: 'albums.csv',
    requestedByUserId: 'user-1',
    claimed: false,
    expiresAt: new Date(Date.now() + 3600000),
    records: { mediaType: 'album', records },
  }
}
describe('album preview and commit policies (mock persistence only)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Live requests forbidden')
      }),
    )
    const empty = query([])
    mocks.database.select.mockReturnValue(empty)
    mocks.database.insert.mockReturnValue(empty)
    mocks.database.update.mockReturnValue(query([{ id: 'preview' }]))
    mocks.values.mockReturnValue(empty)
    mocks.enrichment.mockResolvedValue({ queued: 1, skipped: 0, warnings: [] })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('recognizes legacy Spotify album and padded UPC references across provider namespaces', async () => {
    const item = candidate('Album')
    item.provider = 'spotify'
    item.result.normalized.references = [
      {
        referenceType: 'album',
        externalId: '1234567890abcdefghijkl',
        isPrimary: true,
      },
      { referenceType: 'upc', externalId: '012345678901', isPrimary: false },
    ]
    mocks.database.select.mockReturnValueOnce(
      query([
        {
          id: 'legacy-id',
          provider: 'spotify',
          type: 'album',
          externalId: '1234567890abcdefghijkl',
        },
        {
          id: 'legacy-id',
          provider: 'other',
          type: 'ean',
          externalId: '0012345678901',
        },
      ]),
    )
    expect(await matchAlbumCandidates([item])).toEqual([
      { id: 'legacy-id', error: null },
    ])
  })

  it('reports ambiguity rather than merging conflicting identifiers', async () => {
    const item = candidate('Album')
    item.result.normalized.references = [
      {
        referenceType: 'spotify',
        externalId: '1234567890abcdefghijkl',
        isPrimary: true,
      },
      { referenceType: 'upc', externalId: '012345678901', isPrimary: false },
    ]
    mocks.database.select.mockReturnValueOnce(
      query([
        {
          id: 'one',
          provider: 'spotify',
          type: 'album',
          externalId: '1234567890abcdefghijkl',
        },
        {
          id: 'two',
          provider: 'other',
          type: 'upc',
          externalId: '012345678901',
        },
      ]),
    )
    expect((await matchAlbumCandidates([item]))[0]?.error).toContain(
      'Ambiguous',
    )
  })

  it('stages an owner-bound expiring preview without canonical writes or enrichment', async () => {
    const item = candidate('Album')
    const result = await prepareAlbumCandidates(
      { records: [item, item], skipped: 0, warnings: [] },
      'user-1',
      { kind: 'csv', source: 'albums.csv' },
    )
    expect(result.items).toHaveLength(1)
    expect(result.skipped).toBe(1)
    expect(result.items[0]?.action).toBe('new')
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedByUserId: 'user-1',
        kind: 'album-csv',
        expiresAt: expect.any(Date),
      }),
    )
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(mocks.enrichment).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects unavailable/expired/foreign previews with owner, expiry and album-kind predicates', async () => {
    await expect(
      confirmAlbumImport(
        {
          previewId: 'preview',
          rows: [0],
          providers: [],
          confirmBroadRun: false,
        },
        'other-user',
      ),
    ).rejects.toThrow('expired or unavailable')
    const condition = mocks.where.mock.calls[0]?.[0]
    if (!condition) throw new Error('Missing query predicate')
    const params = new PgDialect().sqlToQuery(condition).params
    expect(params).toEqual(
      expect.arrayContaining([
        'preview',
        'other-user',
        'album-csv',
        'spotify-saved',
      ]),
    )
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('skips existing records without any canonical, snapshot or reference mutation', async () => {
    mocks.database.select.mockReturnValueOnce(
      query([{ id: 'existing', title: 'Album', artist: 'Artist' }]),
    )
    expect(
      await commitAlbumImportRecord({ ...candidate('Album'), action: 'new' }),
    ).toEqual({ id: 'existing', created: false })
    expect(mocks.database.insert).not.toHaveBeenCalled()
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it('never recreates a previously-existing album deleted after preview', async () => {
    await expect(
      commitAlbumImportRecord({ ...candidate('Album'), action: 'unchanged' }),
    ).rejects.toThrow('disappeared')
    expect(mocks.database.insert).not.toHaveBeenCalled()
  })

  it('creates an internal canonical ID and persists through the existing provider transaction', async () => {
    const item = candidate('New Album')
    mocks.values.mockReturnValue(query([{ id: albumImportId(item) }]))
    const result = await commitAlbumImportRecord({ ...item, action: 'new' })
    expect(result).toEqual({ id: albumImportId(item), created: true })
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({ id: albumImportId(item), mediaType: 'album' }),
    )
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaItemId: albumImportId(item),
        mediaType: 'album',
        source: 'file-import',
      }),
      expect.anything(),
    )
  })

  it('claims a preview once and dispatches only newly-created album IDs to the mocked enrichment boundary', async () => {
    const old = candidate('Existing')
    const fresh = candidate('New')
    mocks.database.select
      .mockReturnValueOnce(
        query([
          stored([
            { ...old, action: 'new' },
            { ...fresh, action: 'new' },
          ]),
        ]),
      )
      .mockReturnValueOnce(
        query([{ id: 'existing', title: 'Existing', artist: 'Artist' }]),
      )
      .mockReturnValueOnce(query([]))
    mocks.values.mockReturnValue(query([{ id: albumImportId(fresh) }]))
    mocks.start.mockImplementation(
      async (
        _userId: string,
        execute: (progress: () => Promise<void>) => Promise<unknown>,
      ) => execute(async () => undefined),
    )
    const result = await confirmAlbumImport(
      {
        previewId: 'preview',
        rows: [0, 1, 1],
        providers: ['spotify'],
        confirmBroadRun: false,
      },
      'user-1',
    )
    expect(result).toMatchObject({ created: 1, unchanged: 1, updated: 0 })
    expect(mocks.enrichment).toHaveBeenCalledWith(
      [{ mediaItemId: albumImportId(fresh), provider: 'spotify' }],
      'user-1',
      expect.objectContaining({ mediaType: 'album', missingOnly: true }),
    )
    expect(mocks.start).toHaveBeenCalledWith(
      'user-1',
      expect.any(Function),
      'album',
    )
    expect(mocks.confirmation).toHaveBeenCalledWith(2, false)
    mocks.database.select.mockReturnValueOnce(
      query([stored([{ ...old, action: 'new' }])]),
    )
    mocks.database.update.mockReturnValueOnce(query([]))
    await expect(
      confirmAlbumImport(
        {
          previewId: 'preview',
          rows: [0],
          providers: [],
          confirmBroadRun: false,
        },
        'user-1',
      ),
    ).rejects.toThrow('already used')
  })

  it('rejects out-of-range selections before claiming a preview', async () => {
    mocks.database.select.mockReturnValueOnce(
      query([stored([{ ...candidate('Album'), action: 'new' }])]),
    )
    await expect(
      confirmAlbumImport(
        {
          previewId: 'preview',
          rows: [99],
          providers: [],
          confirmBroadRun: false,
        },
        'user-1',
      ),
    ).rejects.toThrow('Selection')
    expect(mocks.database.update).not.toHaveBeenCalled()
  })
})
