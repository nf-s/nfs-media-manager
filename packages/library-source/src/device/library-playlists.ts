import { z } from 'zod'
import {
  LibraryPlaylistSummarySchema,
  type LibraryPlaylistListQuery,
  type LibraryPlaylistPage,
} from '@repo/schemas/library-playlists'
import type { QueryKeys } from '../compile/query-keys'
import { searchConditions } from '../compile/search'
import { and, readRows, sql, type Sql } from '../compile/sql'
import type { DeviceRead } from './read'

/**
 * `GET /library-playlists`: listLibraryPlaylists, library-playlists.ts
 * (PL-10). The store holds every library playlist that is not deleted, as
 * the `library_playlist` table.
 */

/** DEVICE-34: the keys of the library playlist list. Every key is read. */
export const libraryPlaylistListQueryKeys: QueryKeys<LibraryPlaylistListQuery> =
  {
    library: 'served',
    type: 'served',
    q: 'served',
    page: 'served',
    size: 'served',
    itemId: 'served',
  }

/** `q` and `name` of both lists match `lp.name` as one `ILIKE '%value%'`. */
export const libraryPlaylistNameFields = { text: [], search: ['name'] }

/** Every term matches the name of row `t` of `library_playlist`. */
export function libraryPlaylistNameConditions(
  read: DeviceRead,
  terms: readonly (string | undefined)[],
): Sql[] {
  return terms.flatMap((term) =>
    term
      ? searchConditions(
          'library_playlist',
          [term],
          libraryPlaylistNameFields,
          read.fold,
        )
      : [],
  )
}

const ListRowSchema = z.object({
  summary: z.string(),
  contains: z.number().int().nullable(),
})

export async function libraryPlaylistList(
  read: DeviceRead,
  query: LibraryPlaylistListQuery,
): Promise<LibraryPlaylistPage> {
  const where = and([
    sql`t.library = ${query.library}`,
    ...(query.type ? [sql`t.type = ${query.type}`] : []),
    ...libraryPlaylistNameConditions(read, [query.q]),
  ])
  // containsItem: listedEntryOf, a listed entry holding the item.
  const contains =
    query.itemId === undefined
      ? sql`NULL`
      : sql`EXISTS (SELECT 1 FROM library_playlist_item m
          WHERE m.rid = t.rid AND m.item_id = ${query.itemId})`
  const rows = await readRows(
    read.tx,
    sql`SELECT t.summary AS summary, ${contains} AS contains
      FROM library_playlist t WHERE ${where}
      ORDER BY t.sort_name ASC, t.id ASC
      LIMIT ${query.size + 1} OFFSET ${(query.page - 1) * query.size}`,
  )
  const items = rows.slice(0, query.size).map((row) => {
    const parsed = ListRowSchema.parse(row)
    const summary = LibraryPlaylistSummarySchema.parse(
      JSON.parse(parsed.summary),
    )
    return parsed.contains === null
      ? summary
      : { ...summary, containsItem: parsed.contains === 1 }
  })
  return {
    items,
    page: query.page,
    size: query.size,
    hasMore: rows.length > query.size,
  }
}
