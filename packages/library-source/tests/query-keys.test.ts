import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ArchivableBrowseFacetQuerySchema,
  BrowseFacetQuerySchema,
} from '@repo/schemas/browse'
import {
  ArtistListeningHistogramQuerySchema,
  ArtistQuerySchema,
} from '@repo/schemas/creators'
import {
  AlbumListeningHistogramQuerySchema,
  AlbumQuerySchema,
  FilmQuerySchema,
} from '@repo/schemas/media'
import {
  PlaylistBrowseQuerySchema,
  TrackListeningHistogramQuerySchema,
  TrackPositionsQuerySchema,
  TrackQuerySchema,
} from '@repo/schemas/tracks'
import {
  queryKeyCheck,
  unservedQueryKey,
  type QueryKeys,
} from '../src/compile/query-keys'
import { deviceQueryKeys } from '../src/device/source'
import type { LibraryMethod } from '../src/source'

type Schema = { readonly shape: object; parse: (input: unknown) => unknown }

/**
 * Each read's query schema, with the least input it parses: for
 * `trackRecordings`, the schema of its `query`; `fields` takes a library
 * name, which has no keys.
 */
const schemas: Record<
  LibraryMethod,
  { schema: Schema; input: Record<string, unknown> } | null
> = {
  trackPage: { schema: TrackQuerySchema, input: {} },
  trackCount: { schema: TrackQuerySchema, input: {} },
  trackList: { schema: TrackQuerySchema, input: {} },
  trackPositions: {
    schema: TrackPositionsQuerySchema,
    input: { positions: '0' },
  },
  trackRecordings: { schema: TrackQuerySchema, input: {} },
  trackFacets: { schema: BrowseFacetQuerySchema, input: {} },
  trackHistogram: {
    schema: TrackListeningHistogramQuerySchema,
    input: { period: '{"kind":"all"}' },
  },
  albumPage: { schema: AlbumQuerySchema, input: {} },
  albumCount: { schema: AlbumQuerySchema, input: {} },
  albumList: { schema: AlbumQuerySchema, input: {} },
  albumFacets: { schema: ArchivableBrowseFacetQuerySchema, input: {} },
  albumHistogram: {
    schema: AlbumListeningHistogramQuerySchema,
    input: { period: '{"kind":"all"}' },
  },
  filmPage: { schema: FilmQuerySchema, input: {} },
  filmCount: { schema: FilmQuerySchema, input: {} },
  filmList: { schema: FilmQuerySchema, input: {} },
  filmFacets: { schema: ArchivableBrowseFacetQuerySchema, input: {} },
  artistPage: { schema: ArtistQuerySchema, input: {} },
  artistCount: { schema: ArtistQuerySchema, input: {} },
  artistFacets: { schema: BrowseFacetQuerySchema, input: {} },
  artistHistogram: {
    schema: ArtistListeningHistogramQuerySchema,
    input: { period: '{"kind":"all"}' },
  },
  playlistPage: { schema: PlaylistBrowseQuerySchema, input: {} },
  playlistCount: { schema: PlaylistBrowseQuerySchema, input: {} },
  fields: null,
}

const methods = Object.keys(deviceQueryKeys).filter(
  (method): method is LibraryMethod => method in schemas,
)

describe('query key tables (DEVICE-34)', () => {
  it('name every key of each read’s query schema and no other', () => {
    expect(methods).toHaveLength(Object.keys(schemas).length)
    for (const method of methods) {
      const keys = Object.keys(deviceQueryKeys[method]).sort()
      const entry = schemas[method]
      expect(keys, method).toEqual(
        entry === null ? [] : Object.keys(entry.schema.shape).sort(),
      )
    }
  })

  it('mark no key with a schema default api, so a plain read is served', () => {
    for (const method of methods) {
      const entry = schemas[method]
      if (entry === null) continue
      const parsed = z
        .record(z.string(), z.unknown())
        .parse(entry.schema.parse(entry.input))
      const table: Readonly<Record<string, string>> = deviceQueryKeys[method]
      const defaulted = Object.entries(parsed).filter(
        ([key, value]) => value !== undefined && !(key in entry.input),
      )
      for (const [key] of defaulted)
        expect(table[key], `${method}.${key}`).toBe('served')
    }
  })
})

describe('unservedQueryKey', () => {
  type Example = { a?: string; b?: unknown[]; c?: object; d?: string }
  const keys: QueryKeys<Example> = {
    a: 'served',
    b: 'api',
    c: 'api',
    d: 'api',
  }
  const check = (query: Example) =>
    unservedQueryKey([queryKeyCheck(query, keys)])

  it('counts every value but undefined for a key marked api', () => {
    expect(check({})).toBeUndefined()
    expect(check({ a: 'x', b: undefined, c: undefined })).toBeUndefined()
    expect(check({ b: [] })).toBe('b')
    expect(check({ c: {} })).toBe('c')
    expect(check({ d: '' })).toBe('d')
  })

  it('counts a key the table does not name as api', () => {
    expect(
      unservedQueryKey([{ query: { a: 'x', e: 1 }, keys: { a: 'served' } }]),
    ).toBe('e')
    expect(
      unservedQueryKey([
        { query: { a: 'x' }, keys: { a: 'served' } },
        { query: { e: 0 }, keys: {} },
      ]),
    ).toBe('e')
  })
})
