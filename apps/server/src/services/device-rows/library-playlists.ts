import { and, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { LibraryPlaylistLibrarySchema } from '@repo/schemas/browse'
import { db } from '@/lib/db'
import { libraryPlaylist } from '@/schemas/db'
import { entryItem, listedEntry } from '../library-playlist-entries'
import { ensureLegacySavedViews } from '../library-playlist-legacy-views'
import {
  summary as libraryPlaylistSummary,
  summaryColumns as libraryPlaylistSummaryColumns,
} from '../library-playlists'
import {
  DirectoryRowsSchema,
  isoTimestamp,
  libraryCountColumn,
  librarySortColumn,
  librarySummary,
} from '../playlist-directory'
import {
  anyId,
  epochMicroseconds,
  idAfter,
  readProjection,
  textValues,
  toJson,
  type JsonObject,
} from './projection'

/**
 * Library playlist rows: the Playlists directory's row of each library
 * playlist and the playlist list's summary, with the directory's projections.
 * In SQL, `lp` is a library_playlist that is not deleted.
 */

const IdRowsSchema = z.array(z.object({ id: z.string() }))
const DirectoryRowSchema = DirectoryRowsSchema.element

const published = sql`lp.deleted_at is null`

/**
 * Every library's playlists that are not deleted, in ID order. The first
 * page inserts the legacy Albums smart playlists (PL-05) first, as the
 * Albums directory's first read does.
 */
export async function listLibraryPlaylistIds(
  afterId: string | null,
  limit: number,
) {
  if (afterId === null) await ensureLegacySavedViews()
  const result = await db.execute(sql`select lp.id from library_playlist lp
    where ${published} and ${idAfter(sql`lp.id`, afterId)}
    order by lp.id limit ${limit}`)
  return IdRowsSchema.parse(result.rows).map((row) => row.id)
}

/** entryItem of the row's own library, on `e`. */
const rowEntryItem = sql`case lp.library ${sql.join(
  LibraryPlaylistLibrarySchema.options.map(
    (library) => sql`when ${library} then ${entryItem(library)}`,
  ),
  sql` `,
)} end`

// The directory's values without a count range: no smart count.
const noSmartCount = sql`null::int`

export async function renderLibraryPlaylists(
  ids: string[],
): Promise<Map<string, JsonObject>> {
  const batch = anyId(ids)
  const [projections, summaries] = await Promise.all([
    readProjection(
      {
        id: sql`lp.id`,
        from: sql`from library_playlist lp`,
        where: sql`lp.id = ${batch} and ${published}`,
        scalars: [
          // The directory's row as listDirectoryPage reads it; replaced by
          // its summary below.
          [
            'item',
            sql`jsonb_build_object('origin', 'library', 'id', lp.id,
              'name', lp.name, 'library', lp.library, 'type', lp.type,
              'view', lp.view,
              'created_at', ${isoTimestamp(sql`lp.created_at`)},
              'updated_at', ${isoTimestamp(sql`lp.updated_at`)},
              'entry_count', ${libraryCountColumn(noSmartCount)})`,
          ],
          ['search.name', sql`jsonb_build_array(lp.name)`],
          ['num.count', libraryCountColumn(noSmartCount)],
          [
            'num.updated',
            epochMicroseconds(librarySortColumn('updated', noSmartCount)),
          ],
          [
            'num.added',
            epochMicroseconds(librarySortColumn('added', noSmartCount)),
          ],
          ['sort.name', librarySortColumn('name', noSmartCount)],
          ['extra.library', sql`lp.library`],
          ['extra.type', sql`lp.type`],
          ['extra.hasView', sql`lp.view is not null`],
        ],
        parts: [
          {
            path: 'extra.members',
            rows: textValues(
              sql`select lp.id, ${rowEntryItem} as value
                from library_playlist lp
                join library_playlist_entry e on ${listedEntry(sql`lp.id`)}
                where lp.id = ${batch} and ${published}`,
              batch,
            ),
          },
        ],
      },
      () => ({ text: {}, extra: { members: [] } }),
    ),
    db
      .select(libraryPlaylistSummaryColumns)
      .from(libraryPlaylist)
      .where(
        and(
          inArray(libraryPlaylist.id, ids),
          isNull(libraryPlaylist.deletedAt),
        ),
      ),
  ])
  const summaryById = new Map(
    summaries.map((row) => [row.id, libraryPlaylistSummary(row)]),
  )
  const payloads = new Map<string, JsonObject>()
  for (const [id, projection] of projections) {
    const listSummary = summaryById.get(id)
    const row = DirectoryRowSchema.parse(projection.item)
    if (!listSummary || !row.library) continue
    payloads.set(id, {
      ...projection,
      item: toJson(librarySummary(row, row.library)),
      summary: toJson(listSummary),
    })
  }
  return payloads
}
