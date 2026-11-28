import {
  LIBRARY_PLAYLIST_SELECTION_MAX,
  parseLibraryBrowseView,
  type LibraryBrowseQuery,
  type LibraryPlaylistLibrary,
  type LibraryPlaylistSelection,
  type LibraryPlaylistView,
} from '@repo/schemas/library-playlists'
import { ServerError } from '@/lib/error'
import { queryBrowseSelectionIds } from './browse'
import { querySubscriptionSelectionIds } from './subscription-library'

/** PL-04: a view or selection query parsed with the library's Browse query; 422 otherwise. */
export function parseLibraryPlaylistView(
  library: LibraryPlaylistLibrary,
  view: LibraryPlaylistView,
): LibraryBrowseQuery {
  const parsed = parseLibraryBrowseView(library, view)
  if (!parsed.success)
    throw new ServerError({
      statusCode: 422,
      message: 'The view is not a Browse view of this library.',
      data: { issues: parsed.issues },
    })
  return parsed.data
}

/** PL-02: the reason a selection holds an item that cannot be added. */
export const onlyInLibraryMessage =
  'Only items in the library can be added to a playlist.'

/**
 * PL-02: a query selection adds the rows of the query that are in the
 * library, so it resolves at the In library scope. At the Outside scope the
 * view shows none of them, and the selection is refused.
 */
function readBrowseIds({ library, query }: LibraryBrowseQuery, limit: number) {
  const libraryScope = 'library'
  switch (library) {
    case 'albums':
      return queryBrowseSelectionIds('album', { ...query, libraryScope }, limit)
    case 'tracks':
      return queryBrowseSelectionIds('track', { ...query, libraryScope }, limit)
    case 'films':
      return queryBrowseSelectionIds('film', { ...query, libraryScope }, limit)
    case 'subscriptions':
    case 'mixes':
      return querySubscriptionSelectionIds({ ...query, libraryScope }, limit)
  }
}

/**
 * PL-13: the items of a selection in selection order, each once. A query is
 * resolved from its filters on the server in Browse order, in one page read
 * whatever its size, less `excludeIds`. More than 10,000 items, or a query at
 * the Outside scope, is a 422.
 */
export async function resolveLibraryPlaylistSelection(
  library: LibraryPlaylistLibrary,
  selection: LibraryPlaylistSelection,
) {
  if ('ids' in selection) return [...new Set(selection.ids)]
  const excluded = new Set(selection.excludeIds)
  const query = parseLibraryPlaylistView(library, selection.query)
  if (query.query.libraryScope === 'outside')
    throw new ServerError({ statusCode: 422, message: onlyInLibraryMessage })
  const ids = await readBrowseIds(
    query,
    LIBRARY_PLAYLIST_SELECTION_MAX + excluded.size + 1,
  )
  const selected = [...new Set(ids.filter((id) => !excluded.has(id)))]
  if (selected.length > LIBRARY_PLAYLIST_SELECTION_MAX)
    throw new ServerError({
      statusCode: 422,
      message: `The selection holds more than ${LIBRARY_PLAYLIST_SELECTION_MAX.toLocaleString('en-US')} items. Narrow the search or filters.`,
    })
  return selected
}
