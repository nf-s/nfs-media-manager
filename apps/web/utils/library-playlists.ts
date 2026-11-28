import type { QueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import {
  formatBrowseFilterValue,
  isTagBrowseField,
  type BrowseFilter,
} from '@repo/schemas/browse'
import {
  CreateLibraryPlaylistSchema,
  LibraryPlaylistAdditionUndoneSchema,
  LibraryPlaylistCreatedSchema,
  LibraryPlaylistDetailSchema,
  LibraryPlaylistEntryAdditionInputSchema,
  LibraryPlaylistEntryAdditionSchema,
  LibraryPlaylistEntryCheckInputSchema,
  LibraryPlaylistEntryCheckSchema,
  LibraryPlaylistEntryRemovalInputSchema,
  LibraryPlaylistEntryRemovalSchema,
  LibraryPlaylistEntryRestoreInputSchema,
  LibraryPlaylistEntryRestoreSchema,
  LibraryPlaylistListQuerySchema,
  LibraryPlaylistNameSchema,
  LibraryPlaylistPageSchema,
  type CreateLibraryPlaylist,
  type LibraryPlaylistDuplicates,
  type LibraryPlaylistEntryAddition,
  type LibraryPlaylistEntryCheck,
  type LibraryPlaylistEntryRemovalInput,
  type LibraryPlaylistLibrary,
  type LibraryPlaylistListQuery,
  type LibraryPlaylistSelection,
} from '@repo/schemas/library-playlists'
import { formatCount, formatItemCount } from '@repo/ui/lib/format'
import { fetchApiData } from './api'

type Noun = { one: string; other: string }

/** The noun for one library's items, in counts such as "40 tracks". */
export const libraryPlaylistNouns: Record<LibraryPlaylistLibrary, Noun> = {
  albums: { one: 'album', other: 'albums' },
  tracks: { one: 'track', other: 'tracks' },
  films: { one: 'film', other: 'films' },
  subscriptions: { one: 'item', other: 'items' },
  mixes: { one: 'mix', other: 'mixes' },
}

/** "40 tracks", "1 album", or "6 of 40 tracks" with a total. */
export function libraryItemCount(
  library: LibraryPlaylistLibrary,
  count: number,
  total?: number,
) {
  return formatItemCount(count, libraryPlaylistNouns[library], total)
}

/** The detail kind that opens one of a library's items. */
export const libraryDetailKinds = {
  albums: 'album',
  tracks: 'track',
  films: 'film',
  subscriptions: 'subscription',
  mixes: 'mix',
} as const satisfies Record<LibraryPlaylistLibrary, string>

/**
 * What an Add to playlist action adds: chosen IDs now, or every match of a
 * Browse query less some IDs once Select all matching passes one.
 */
export type PlaylistSubject = {
  library: LibraryPlaylistLibrary
  selection: LibraryPlaylistSelection
  /** How many items the selection holds. */
  count: number
  /** The item's title when the selection is one known item. */
  title: string | null
}

/** The subject for one item, as a row's More menu adds it. */
export function itemSubject(
  library: LibraryPlaylistLibrary,
  item: { id: string; title: string },
): PlaylistSubject {
  return { library, selection: { ids: [item.id] }, count: 1, title: item.title }
}

/** The one item's title, when the subject is a single named item. */
export function singleTitle(subject: PlaylistSubject) {
  return subject.count === 1 ? subject.title : null
}

/** The one item's ID, for showing which playlists already hold it. */
export function singleItemId(subject: PlaylistSubject) {
  return subject.count === 1 &&
    'ids' in subject.selection &&
    subject.selection.ids.length === 1
    ? subject.selection.ids[0]
    : undefined
}

const quote = (text: string) => `“${text}”`

function subjectName(subject: PlaylistSubject, count = subject.count) {
  const title = singleTitle(subject)
  return title === null
    ? libraryItemCount(subject.library, count)
    : quote(title)
}

/** The picker's heading: "Add 40 tracks to a playlist". */
export function pickerHeading(subject: PlaylistSubject) {
  return `Add ${subjectName(subject)} to a playlist`
}

/** The New playlist step's button: "Create and add 40". */
export function createButtonLabel(subject: PlaylistSubject) {
  return singleTitle(subject) === null
    ? `Create and add ${formatCount(subject.count)}`
    : 'Create and add'
}

/** Whether every selected item is already in the playlist. */
export function allPresent(
  subject: PlaylistSubject,
  check: LibraryPlaylistEntryCheck | null,
) {
  return singleTitle(subject) !== null || !check || check.present >= check.total
}

/**
 * The line that says how much of the selection a playlist already holds.
 * `check` is null for one item already known to be there.
 */
export function duplicatesLine(
  subject: PlaylistSubject,
  check: LibraryPlaylistEntryCheck | null,
) {
  const title = singleTitle(subject)
  if (title !== null) return `${quote(title)} is already in this playlist.`
  const total = check?.total ?? subject.count
  if (allPresent(subject, check))
    return `All ${libraryItemCount(subject.library, total)} are already in this playlist.`
  return `${libraryItemCount(subject.library, check?.present ?? 0, total)} are already in this playlist.`
}

/** One present item as evidence: "Title · Artist". */
export function duplicateEvidence(item: {
  title: string
  creator: string | null
}) {
  return item.creator ? `${item.title} · ${item.creator}` : item.title
}

/** "+1 more" for present items beyond the five shown. */
export function duplicatesMore(check: LibraryPlaylistEntryCheck) {
  const rest = check.present - check.sample.length
  return rest > 0 ? `+${formatCount(rest)} more` : null
}

/** The result line after an addition. */
export function additionResultText(
  subject: PlaylistSubject,
  playlistName: string,
  addition: Pick<
    LibraryPlaylistEntryAddition,
    'added' | 'skipped' | 'repeated'
  >,
) {
  const single = singleTitle(subject) !== null
  const text = `Added ${subjectName(subject, addition.added)} to ${quote(playlistName)}.`
  if (single) return addition.repeated ? `${text} It is now in it twice.` : text
  return [
    text,
    addition.skipped
      ? `Skipped ${formatCount(addition.skipped)} already there.`
      : '',
    addition.repeated
      ? `${formatCount(addition.repeated)} were already there and are now in it twice.`
      : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/** The result line after New playlist: "Created “Name” with 40 tracks." */
export function createdResultText(
  subject: PlaylistSubject,
  playlistName: string,
  added: number,
) {
  return `Created ${quote(playlistName)} with ${subjectName(subject, added)}.`
}

/** The result line after Remove from this playlist. */
export function removedResultText(title: string, playlistName: string) {
  return `Removed ${quote(title)} from ${quote(playlistName)}.`
}

/** The result line after Undo. */
export function undoneResultText(text: string) {
  return `Undone: ${text}`
}

/**
 * A name for a playlist made from a Browse view: the tag values it filters by,
 * then its search text.
 */
export function suggestedPlaylistName(
  filters: readonly BrowseFilter[],
  search: string,
) {
  const parts = filters
    .filter(
      (filter) => isTagBrowseField(filter.field) && filter.mode !== 'exclude',
    )
    .map((filter) => formatBrowseFilterValue(filter.field, filter.value))
  const text = search.trim()
  const name = [...new Set([...parts, ...(text ? [text] : [])])].join(', ')
  const parsed = LibraryPlaylistNameSchema.safeParse(name.slice(0, 200))
  return parsed.success ? parsed.data : ''
}

const NameTakenErrorSchema = z.object({ statusCode: z.literal(409) })

/** Whether a create or rename failed because the name is taken. */
export function playlistNameTaken(error: unknown) {
  return NameTakenErrorSchema.safeParse(error).success
}

/** Every library playlist read starts with this key. */
export const libraryPlaylistsKey = ['library-playlists'] as const

/** A picker's pages: one library's playlists matching `q`. */
export function libraryPlaylistPickerKey(
  library: LibraryPlaylistLibrary,
  q: string,
  itemId: string | undefined,
) {
  return [...libraryPlaylistsKey, 'picker', library, q, itemId ?? null]
}

const browseCollections = new Set([
  'albums',
  'tracks',
  'films',
  'subscriptions',
  'mixes',
])

/**
 * Refreshes library playlists, the Playlists directory, and Browse reads
 * filtered by the changed playlist, whose ID is in their key.
 */
export function invalidateLibraryPlaylists(
  client: QueryClient,
  playlistId?: string,
) {
  return client.invalidateQueries({
    predicate: ({ queryKey }) => {
      const [head] = queryKey
      if (head === libraryPlaylistsKey[0] || head === 'playlists') return true
      return (
        playlistId !== undefined &&
        browseCollections.has(String(head)) &&
        JSON.stringify(queryKey).includes(playlistId)
      )
    },
  })
}

const base = '/api/v1/library-playlists'
const path = (id: string, rest = '') =>
  `${base}/${encodeURIComponent(id)}${rest}`

/** PL-10: a page of one library's playlists for a picker. */
export function fetchLibraryPlaylistPage(
  apiBaseUrl: string,
  query: Partial<LibraryPlaylistListQuery> &
    Pick<LibraryPlaylistListQuery, 'library'>,
  signal?: AbortSignal,
) {
  const parsed = LibraryPlaylistListQuerySchema.parse(query)
  const params = new URLSearchParams({
    library: parsed.library,
    page: String(parsed.page),
    size: String(parsed.size),
    ...(parsed.type ? { type: parsed.type } : {}),
    ...(parsed.q ? { q: parsed.q } : {}),
    ...(parsed.itemId ? { itemId: parsed.itemId } : {}),
  })
  return fetchApiData(
    apiBaseUrl,
    `${base}?${params}`,
    LibraryPlaylistPageSchema,
    {
      signal,
    },
  )
}

/** PL-11: a new playlist, with what its selection added. */
export function createLibraryPlaylist(
  apiBaseUrl: string,
  input: CreateLibraryPlaylist,
) {
  return fetchApiData(apiBaseUrl, base, LibraryPlaylistCreatedSchema, {
    method: 'POST',
    body: JSON.stringify(CreateLibraryPlaylistSchema.parse(input)),
  })
}

/** PL-11: deletes a playlist; it can be restored for 24 hours. */
export function deleteLibraryPlaylist(apiBaseUrl: string, id: string) {
  return fetchApiData(apiBaseUrl, path(id), LibraryPlaylistDetailSchema, {
    method: 'DELETE',
  })
}

export function restoreLibraryPlaylist(apiBaseUrl: string, id: string) {
  return fetchApiData(
    apiBaseUrl,
    path(id, '/restore'),
    LibraryPlaylistDetailSchema,
    { method: 'POST' },
  )
}

/** PL-14: how much of a selection the playlist already holds. */
export function checkLibraryPlaylistEntries(
  apiBaseUrl: string,
  id: string,
  selection: LibraryPlaylistSelection,
) {
  return fetchApiData(
    apiBaseUrl,
    path(id, '/entries/check'),
    LibraryPlaylistEntryCheckSchema,
    {
      method: 'POST',
      body: JSON.stringify(
        LibraryPlaylistEntryCheckInputSchema.parse({ selection }),
      ),
    },
  )
}

/** PL-14: appends a selection, skipping or repeating items already there. */
export function addLibraryPlaylistEntries(
  apiBaseUrl: string,
  id: string,
  selection: LibraryPlaylistSelection,
  duplicates: LibraryPlaylistDuplicates,
) {
  return fetchApiData(
    apiBaseUrl,
    path(id, '/entries'),
    LibraryPlaylistEntryAdditionSchema,
    {
      method: 'POST',
      body: JSON.stringify(
        LibraryPlaylistEntryAdditionInputSchema.parse({
          selection,
          duplicates,
        }),
      ),
    },
  )
}

/** PL-14: removes what one addition added. */
export function undoLibraryPlaylistAddition(
  apiBaseUrl: string,
  id: string,
  batchId: string,
) {
  return fetchApiData(
    apiBaseUrl,
    path(id, `/entries/batches/${encodeURIComponent(batchId)}`),
    LibraryPlaylistAdditionUndoneSchema,
    { method: 'DELETE' },
  )
}

/** PL-15: removes entries; the batch puts them back. */
export function removeLibraryPlaylistEntries(
  apiBaseUrl: string,
  id: string,
  input: LibraryPlaylistEntryRemovalInput,
) {
  return fetchApiData(
    apiBaseUrl,
    path(id, '/entries/remove'),
    LibraryPlaylistEntryRemovalSchema,
    {
      method: 'POST',
      body: JSON.stringify(LibraryPlaylistEntryRemovalInputSchema.parse(input)),
    },
  )
}

export function restoreLibraryPlaylistEntries(
  apiBaseUrl: string,
  id: string,
  batchId: string,
) {
  return fetchApiData(
    apiBaseUrl,
    path(id, '/entries/restore'),
    LibraryPlaylistEntryRestoreSchema,
    {
      method: 'POST',
      body: JSON.stringify(
        LibraryPlaylistEntryRestoreInputSchema.parse({ batchId }),
      ),
    },
  )
}
