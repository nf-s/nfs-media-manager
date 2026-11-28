import { defaultListeningPeriod } from '@repo/schemas/listening'
import {
  libraryBrowseParams,
  parseLibraryBrowseView,
  type LibraryPlaylistLibrary,
  type LibraryPlaylistView,
} from '@repo/schemas/library-playlists'
import { playlistLibraryViews, SMART_PLAYLIST_PARAM } from './library-playlists'
import { scopedHref } from './media-scope'
import { trackGroupingEnabled } from './track-browse'

/**
 * Whether a library's Browse offers smart playlists in its rail and Filters
 * drawer: every library with playlists does; Artists has none.
 */
export function browseHasSmartPlaylists(
  library: LibraryPlaylistLibrary | null,
): library is LibraryPlaylistLibrary {
  return library !== null
}

/**
 * PL-04: the view of a Browse URL, the parameters the library's Browse query
 * reads and the server keeps, with the order Browse shows. Layout, columns,
 * an open detail and the smart playlist's ID are left out, and so are empty
 * values.
 */
export function browseView(
  library: LibraryPlaylistLibrary,
  params: URLSearchParams,
  order: { sortBy: string; direction: 'asc' | 'desc' },
): LibraryPlaylistView {
  const view: LibraryPlaylistView = {}
  for (const key of libraryBrowseParams[library]) {
    const value = key === 'q' ? params.get(key)?.trim() : params.get(key)
    if (value && value !== '[]') view[key] = value
  }
  view.sortBy = order.sortBy
  view.direction = order.direction
  return view
}

/** Opens a view in Browse: its parameters replace the current view's. */
export function applyBrowseView(
  params: URLSearchParams,
  library: LibraryPlaylistLibrary,
  view: LibraryPlaylistView,
  smartPlaylistId: string | null,
) {
  for (const key of libraryBrowseParams[library]) params.delete(key)
  for (const [key, value] of Object.entries(view))
    if (libraryBrowseParams[library].includes(key)) params.set(key, value)
  if (smartPlaylistId) params.set(SMART_PLAYLIST_PARAM, smartPlaylistId)
  else params.delete(SMART_PLAYLIST_PARAM)
}

/** Close: Browse without the view and without the smart playlist's ID. */
export function clearBrowseView(
  params: URLSearchParams,
  library: LibraryPlaylistLibrary,
) {
  applyBrowseView(params, library, {}, null)
}

type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json }

/** A value with its object keys in order and undefined members left out. */
function stable(value: unknown): Json {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, member]) => member !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, member]) => [key, stable(member)]),
    )
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value
  return null
}

const sortedList = (values: readonly unknown[]) =>
  values
    .map((value) => JSON.stringify(stable(value)))
    .sort()
    .map((text) => JSON.parse(text))

/** Values each library's Browse uses when the URL leaves the parameter out. */
const absentValues: Record<string, unknown> = {
  libraryScope: 'library',
  discoverySourceMode: 'any',
  includeArchived: 'false',
  editions: 'false',
}

/**
 * One view in one canonical form: the parameters the server keeps, read with
 * the library's Browse query, so the order of values, a filter's Any mode
 * left out and parameters left at their defaults compare equal. A view the
 * library's Browse query refuses is compared as written.
 */
export function canonicalBrowseView(
  library: LibraryPlaylistLibrary,
  view: LibraryPlaylistView,
): string {
  const parsed = parseLibraryBrowseView(library, view)
  if (!parsed.success)
    return JSON.stringify(
      stable(
        Object.fromEntries(
          Object.entries(view).filter(([, value]) => value && value !== '[]'),
        ),
      ),
    )
  const query: Record<string, unknown> = { ...parsed.data.query }
  const sortBy = typeof query.sortBy === 'string' ? query.sortBy : 'dateAdded'
  const canonical: Record<string, unknown> = {}
  for (const key of libraryBrowseParams[library]) {
    const value = query[key]
    if (value === undefined || value === null || value === '') continue
    if (absentValues[key] === value) continue
    if (key === 'q') {
      const text = String(value).trim()
      if (text) canonical.q = text
    } else if (key === 'filters' && Array.isArray(value)) {
      if (value.length)
        canonical.filters = sortedList(
          value.map((filter: unknown) =>
            filter !== null && typeof filter === 'object'
              ? { mode: 'any', ...filter }
              : filter,
          ),
        )
    } else if (Array.isArray(value)) {
      if (value.length) canonical[key] = sortedList(value)
    } else if (key === 'listening' && typeof value === 'object') {
      const rules = 'rules' in value ? value.rules : undefined
      if (Array.isArray(rules) && rules.length)
        canonical.listening = { ...value, rules: sortedList(rules) }
    } else if (key === 'listeningSort') {
      if (
        JSON.stringify(stable(value)) !==
        JSON.stringify(stable(defaultListeningPeriod))
      )
        canonical.listeningSort = value
    } else if (key === 'discoverySources') {
      canonical.discoverySources = [...new Set(String(value).split(','))]
        .sort()
        .join(',')
    } else if (key === 'groupRecordings') {
      // Tracks group recordings by default when sorted by plays.
      if (
        trackGroupingEnabled(sortBy, String(value)) !==
        trackGroupingEnabled(sortBy, null)
      )
        canonical.groupRecordings = value
    } else canonical[key] = value
  }
  return JSON.stringify(stable(canonical))
}

/** PL-43: whether two views list the same items in the same order. */
export function sameBrowseView(
  library: LibraryPlaylistLibrary,
  a: LibraryPlaylistView,
  b: LibraryPlaylistView,
) {
  return canonicalBrowseView(library, a) === canonicalBrowseView(library, b)
}

/**
 * PL-40: whether a view has something to save: a search, or a filter, range,
 * listening condition, creator or limit.
 */
export function browseViewHasCriteria(
  library: LibraryPlaylistLibrary,
  view: LibraryPlaylistView,
) {
  const parsed = parseLibraryBrowseView(library, view)
  if (!parsed.success) return false
  const query: Record<string, unknown> = { ...parsed.data.query }
  const listening = query.listening
  return Boolean(
    (typeof query.q === 'string' && query.q.trim()) ||
    (Array.isArray(query.filters) && query.filters.length) ||
    (Array.isArray(query.ranges) && query.ranges.length) ||
    (listening !== null &&
      typeof listening === 'object' &&
      'rules' in listening &&
      Array.isArray(listening.rules) &&
      listening.rules.length) ||
    query.creatorId ||
    query.limitResults ||
    query.tag,
  )
}

const quote = (text: string) => `“${text}”`

/** "Saved smart playlist “Name”." */
export function savedSmartPlaylistText(name: string) {
  return `Saved smart playlist ${quote(name)}.`
}

/** "Updated “Name”." */
export function updatedSmartPlaylistText(name: string) {
  return `Updated ${quote(name)}.`
}

/** The drawer's Update button: "Update “Name”". */
export function updateSmartPlaylistLabel(name: string) {
  return `Update ${quote(name)}`
}

/** The library's Playlists page, which the result line's Playlists opens. */
export function libraryPlaylistsHref(library: LibraryPlaylistLibrary) {
  return scopedHref('/playlists', playlistLibraryViews[library])
}

/** Why Save current view is disabled. */
export const nothingToSaveReason = 'Search or add a filter first'
