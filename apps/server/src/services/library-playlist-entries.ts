import { sql, type SQL } from 'drizzle-orm'
import type { LibraryPlaylistLibrary } from '@repo/schemas/library-playlists'

// In SQL, `e` is a library_playlist_entry. Browse and the playlist service
// read entries through these, so a listed entry means the same everywhere.

export const usesMediaItems = (library: LibraryPlaylistLibrary) =>
  library === 'albums' || library === 'tracks' || library === 'films'

/** The entry column that holds the library's items, on `e`. */
export const entryItem = (library: LibraryPlaylistLibrary) =>
  usesMediaItems(library) ? sql`e.media_item_id` : sql`e.subscription_item_id`

/** PL-02: an entry of playlist `playlistId` that a removal has not taken out. */
export const listedEntry = (playlistId: SQL | string) =>
  sql`e.playlist_id = ${playlistId} and e.removed_batch_id is null`

/** A listed entry of playlist `playlistId` holding item `id`. */
export const listedEntryOf = (
  library: LibraryPlaylistLibrary,
  playlistId: SQL | string,
  id: SQL | string,
) => sql`exists (select 1 from library_playlist_entry e
  where ${listedEntry(playlistId)} and ${entryItem(library)} = ${id})`

/**
 * PL-18: whether `id` has a listed entry in playlist `playlistId` of the
 * library that is not deleted. The entries are one hashed set, read through
 * the playlist's position index; a playlist of another library, a smart
 * playlist or an unknown ID is an empty set, so it matches nothing and
 * excludes nothing.
 */
export function inLibraryPlaylist(
  library: LibraryPlaylistLibrary,
  playlistId: string,
  id: SQL,
) {
  return sql`coalesce(${id} in (
    select ${entryItem(library)} from library_playlist_entry e
    join library_playlist lp on lp.id = e.playlist_id
    where ${listedEntry(sql`${playlistId}::text`)} and lp.library = ${library}
      and lp.deleted_at is null
  ), false)`
}
