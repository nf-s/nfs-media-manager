import type { z } from 'zod'
import {
  ArchivableBrowseFacetQuerySchema,
  BrowseFacetQuerySchema,
} from '@repo/schemas/browse'
import { CreatorIdSchema } from '@repo/schemas/common'
import {
  ArtistListeningHistogramQuerySchema,
  ArtistQuerySchema,
} from '@repo/schemas/creators'
import { LibraryPlaylistListQuerySchema } from '@repo/schemas/library-playlists'
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
  isLibraryReadRoute,
  LIBRARY_API_PREFIX,
  type LibraryReadRoute,
} from './paths'
import type { LibraryRead } from './source'

/** Query parameters as the API's validator receives them: one string, or every value of a repeated name. */
type QueryInput = Record<string, string | string[]>

/** `+` is a space, then percent-decoding; `undefined` when an escape is malformed. */
function decodeComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value.replaceAll('+', ' '))
  } catch {
    return undefined
  }
}

/**
 * The query string as Hono's query validator reads it (`c.req.queries()`,
 * a single value unwrapped): names without a value read `''`, empty names
 * are skipped. A malformed escape, which Hono decodes only in part, returns
 * `undefined` so the API answers.
 */
function readQueryInput(search: string): QueryInput | undefined {
  const values = new Map<string, string[]>()
  for (const part of search ? search.split('&') : []) {
    const equals = part.indexOf('=')
    const name = decodeComponent(equals === -1 ? part : part.slice(0, equals))
    const value = equals === -1 ? '' : decodeComponent(part.slice(equals + 1))
    if (name === undefined || value === undefined) return undefined
    if (name === '') continue
    values.set(name, [...(values.get(name) ?? []), value])
  }
  return Object.fromEntries(
    [...values].map(([name, all]): [string, string | string[]] => {
      const [only, ...rest] = all
      return [name, only !== undefined && rest.length === 0 ? only : all]
    }),
  )
}

/** The read for a query the route's schema accepts; `undefined` when the API would answer 422. */
function parsed<Query>(
  schema: z.ZodType<Query>,
  input: QueryInput | undefined,
  read: (query: Query) => LibraryRead,
): LibraryRead | undefined {
  if (input === undefined) return undefined
  const result = schema.safeParse(input)
  return result.success ? read(result.data) : undefined
}

type RouteRead = (input: QueryInput | undefined) => LibraryRead | undefined

/**
 * Static GET routes under `/api/v1/`, with the query schema each route
 * validates with (`apps/server/src/routes/`). `fields` routes take no query.
 * Keyed by `LIBRARY_READ_ROUTES`, which `mayBeLibraryRead` tests against.
 */
const staticRoutes: Record<LibraryReadRoute, RouteRead> = {
  tracks: (input) =>
    parsed(TrackQuerySchema, input, (query) => ({
      method: 'trackList',
      query,
    })),
  'tracks/browse-page': (input) =>
    parsed(TrackQuerySchema, input, (query) => ({
      method: 'trackPage',
      query,
    })),
  'tracks/browse-count': (input) =>
    parsed(TrackQuerySchema, input, (query) => ({
      method: 'trackCount',
      query,
    })),
  'tracks/positions': (input) =>
    parsed(TrackPositionsQuerySchema, input, (query) => ({
      method: 'trackPositions',
      query,
    })),
  'tracks/facets': (input) =>
    parsed(BrowseFacetQuerySchema, input, (query) => ({
      method: 'trackFacets',
      query,
    })),
  'tracks/listening-histogram': (input) =>
    parsed(TrackListeningHistogramQuerySchema, input, (query) => ({
      method: 'trackHistogram',
      query,
    })),
  'tracks/fields': () => ({ method: 'fields', query: 'track' }),
  albums: (input) =>
    parsed(AlbumQuerySchema, input, (query) => ({
      method: 'albumList',
      query,
    })),
  'albums/browse-page': (input) =>
    parsed(AlbumQuerySchema, input, (query) => ({
      method: 'albumPage',
      query,
    })),
  'albums/browse-count': (input) =>
    parsed(AlbumQuerySchema, input, (query) => ({
      method: 'albumCount',
      query,
    })),
  'albums/facets': (input) =>
    parsed(ArchivableBrowseFacetQuerySchema, input, (query) => ({
      method: 'albumFacets',
      query,
    })),
  'albums/listening-histogram': (input) =>
    parsed(AlbumListeningHistogramQuerySchema, input, (query) => ({
      method: 'albumHistogram',
      query,
    })),
  'albums/fields': () => ({ method: 'fields', query: 'album' }),
  films: (input) =>
    parsed(FilmQuerySchema, input, (query) => ({
      method: 'filmList',
      query,
    })),
  'films/browse-page': (input) =>
    parsed(FilmQuerySchema, input, (query) => ({
      method: 'filmPage',
      query,
    })),
  'films/browse-count': (input) =>
    parsed(FilmQuerySchema, input, (query) => ({
      method: 'filmCount',
      query,
    })),
  'films/facets': (input) =>
    parsed(ArchivableBrowseFacetQuerySchema, input, (query) => ({
      method: 'filmFacets',
      query,
    })),
  'films/fields': () => ({ method: 'fields', query: 'film' }),
  'artists/browse-page': (input) =>
    parsed(ArtistQuerySchema, input, (query) => ({
      method: 'artistPage',
      query,
    })),
  'artists/browse-count': (input) =>
    parsed(ArtistQuerySchema, input, (query) => ({
      method: 'artistCount',
      query,
    })),
  'artists/facets': (input) =>
    parsed(BrowseFacetQuerySchema, input, (query) => ({
      method: 'artistFacets',
      query,
    })),
  'artists/listening-histogram': (input) =>
    parsed(ArtistListeningHistogramQuerySchema, input, (query) => ({
      method: 'artistHistogram',
      query,
    })),
  'artists/fields': () => ({ method: 'fields', query: 'artist' }),
  'playlists/browse-page': (input) =>
    parsed(PlaylistBrowseQuerySchema, input, (query) => ({
      method: 'playlistPage',
      query,
    })),
  'playlists/browse-count': (input) =>
    parsed(PlaylistBrowseQuerySchema, input, (query) => ({
      method: 'playlistCount',
      query,
    })),
  // The list only: `/library-playlists/:id`, its entries and memberships are no read.
  'library-playlists': (input) =>
    parsed(LibraryPlaylistListQuerySchema, input, (query) => ({
      method: 'libraryPlaylistList',
      query,
    })),
}

/**
 * `/tracks/:id/recordings`. The route's `id` schema (`z.string().min(1).max(200)`,
 * inline in the server route) is the same as the shared `CreatorIdSchema`.
 */
function recordingsRead(
  id: string,
  input: QueryInput | undefined,
): LibraryRead | undefined {
  const trackId = CreatorIdSchema.safeParse(id)
  if (!trackId.success) return undefined
  return parsed(TrackQuerySchema, input, (query) => ({
    method: 'trackRecordings',
    query: { id: trackId.data, query },
  }))
}

/** Percent-decoding of a path segment, where `+` is itself. */
function decodeSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

/**
 * The path's segments under `/api/v1/`, each percent-decoded as the router
 * matches them; one trailing slash is ignored, as the API is not strict.
 */
function pathSegments(pathname: string): string[] | undefined {
  if (!pathname.startsWith(LIBRARY_API_PREFIX)) return undefined
  const rest = pathname.slice(LIBRARY_API_PREFIX.length)
  const segments: string[] = []
  for (const segment of (rest.endsWith('/') ? rest.slice(0, -1) : rest).split(
    '/',
  )) {
    const decoded = decodeSegment(segment)
    if (decoded === undefined) return undefined
    segments.push(decoded)
  }
  return segments
}

/**
 * The `LibrarySource` read an API path asks for (a `GET` with the query
 * string as the web client builds it), parsed with the route's own query
 * schema, so the query equals what the route passes to its service.
 * `undefined` when the path is not a Browse read of `LibrarySource` (a
 * detail, a write, another endpoint or prefix), or when the route would
 * reject its query; the API then answers.
 */
export function resolveLibraryRead(path: string): LibraryRead | undefined {
  const [target = ''] = path.split('#', 1)
  const queryAt = target.indexOf('?')
  const pathname = queryAt === -1 ? target : target.slice(0, queryAt)
  const search = queryAt === -1 ? '' : target.slice(queryAt + 1)
  const segments = pathSegments(pathname)
  if (!segments) return undefined
  const input = readQueryInput(search)
  const [collection, id, child, ...rest] = segments
  if (
    collection === 'tracks' &&
    id !== undefined &&
    child === 'recordings' &&
    rest.length === 0
  )
    return recordingsRead(id, input)
  // A decoded `/` is part of a segment, which no static route matches.
  if (segments.some((segment) => segment.includes('/'))) return undefined
  const route = segments.join('/')
  return isLibraryReadRoute(route) ? staticRoutes[route](input) : undefined
}
