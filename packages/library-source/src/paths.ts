import type { DeviceBrowseLibrary } from '@repo/schemas/device'
import type { LibraryQueries } from './reads'
import type { LibraryMethod } from './source'

/** Every library read is under this prefix, as the web client requests it. */
export const LIBRARY_API_PREFIX = '/api/v1/'

/** The API collection of each library's `fields` read. */
export const fieldCollections = {
  track: 'tracks',
  album: 'albums',
  film: 'films',
  artist: 'artists',
} as const satisfies Record<DeviceBrowseLibrary, string>

/** Parameters written comma-separated (`tagLevels=track,album`, `positions=0,5`); other arrays and objects are JSON. */
const commaParameters = new Set(['tagLevels', 'positions'])

function queryValue(key: string, value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  if (Array.isArray(value) && commaParameters.has(key))
    return value.map((item: unknown) => String(item)).join(',')
  return JSON.stringify(value)
}

/**
 * A parsed query as the web client writes it: `URLSearchParams`, JSON for
 * filters, ranges, listening rules and periods and other lists, commas for
 * tag levels and positions. Every defined value is written, defaults
 * included, so the route parses back the same query.
 */
function queryString(query: Readonly<Record<string, unknown>>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, queryValue(key, value))
  return params.toString()
}

function withQuery(
  path: string,
  query: Readonly<Record<string, unknown>>,
): string {
  const search = queryString(query)
  return `${LIBRARY_API_PREFIX}${path}${search ? `?${search}` : ''}`
}

const libraryPaths: {
  [Method in LibraryMethod]: (query: LibraryQueries[Method]) => string
} = {
  trackPage: (query) => withQuery('tracks/browse-page', query),
  trackCount: (query) => withQuery('tracks/browse-count', query),
  trackList: (query) => withQuery('tracks', query),
  trackPositions: (query) => withQuery('tracks/positions', query),
  trackRecordings: ({ id, query }) =>
    withQuery(`tracks/${encodeURIComponent(id)}/recordings`, query),
  trackFacets: (query) => withQuery('tracks/facets', query),
  trackHistogram: (query) => withQuery('tracks/listening-histogram', query),
  albumPage: (query) => withQuery('albums/browse-page', query),
  albumCount: (query) => withQuery('albums/browse-count', query),
  albumList: (query) => withQuery('albums', query),
  albumFacets: (query) => withQuery('albums/facets', query),
  albumHistogram: (query) => withQuery('albums/listening-histogram', query),
  filmPage: (query) => withQuery('films/browse-page', query),
  filmCount: (query) => withQuery('films/browse-count', query),
  filmList: (query) => withQuery('films', query),
  filmFacets: (query) => withQuery('films/facets', query),
  artistPage: (query) => withQuery('artists/browse-page', query),
  artistCount: (query) => withQuery('artists/browse-count', query),
  artistFacets: (query) => withQuery('artists/facets', query),
  artistHistogram: (query) => withQuery('artists/listening-histogram', query),
  playlistPage: (query) => withQuery('playlists/browse-page', query),
  playlistCount: (query) => withQuery('playlists/browse-count', query),
  fields: (library) =>
    `${LIBRARY_API_PREFIX}${fieldCollections[library]}/fields`,
}

/**
 * The API path and query string of one read: the inverse of
 * `resolveLibraryRead`, which returns the same method and query for it.
 */
export function libraryReadPath<Method extends LibraryMethod>(
  method: Method,
  query: LibraryQueries[Method],
): string {
  return libraryPaths[method](query)
}
