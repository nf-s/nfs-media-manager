import { z } from 'zod'
import {
  DevicePlaylistItemSchema,
  DevicePlaylistJobRowSchema,
} from '@repo/schemas/device'
import {
  PlaylistSummarySchema,
  type PlaylistBrowsePage,
  type PlaylistBrowseQuery,
  type PlaylistBrowseSort,
  type PlaylistSummary,
} from '@repo/schemas/tracks'
import type { TextFold } from '../fold'
import type { BrowseCount } from '../source'
import { valueExpression, type ValueSource } from '../compile/fields'
import { isMemberScope, orderBy, orderTerm, pageWindow } from '../compile/query'
import type { QueryKeys } from '../compile/query-keys'
import { searchConditions } from '../compile/search'
import { and, readRows, sql, values, type Sql } from '../compile/sql'
import { unsupported } from '../compile/unsupported'
import { readItems, type DeviceRead } from './read'

/**
 * The Playlists directory on the device: the page and count reads. The
 * server's playlist-directory.ts defines every rule (playlistDirectoryFilter,
 * playlistSortColumns, listPlaylistBrowsePage, countPlaylists); comments
 * name the part each piece reproduces. The device holds the visible member
 * playlists of the library scope only.
 */

const stored = (field: string): ValueSource => ({ kind: 'sort', field })
const numeric = (field: string): ValueSource => ({ kind: 'num', field })
const sortValue = (source: ValueSource) => valueExpression('playlist', source)

/**
 * playlistSortColumns.nextSync: the next sync as it is with no job, null
 * when the group's latest job has not succeeded.
 */
const nextSync = sql`CASE WHEN EXISTS (SELECT 1 FROM playlist_job j
    WHERE j.id = t.sync_group_key AND j.status <> 'succeeded') THEN NULL
  ELSE ${sortValue(stored('nextSync'))} END`

/** playlistSortColumns, playlist-directory.ts. Dates are stored in microseconds, which keeps their order. */
const playlistSorts: Record<PlaylistBrowseSort, Sql> = {
  name: sql`t.sort_name`,
  source: sortValue(stored('source')),
  owner: sortValue(stored('owner')),
  tracks: sortValue(numeric('tracks')),
  linkedTracks: sortValue(numeric('linkedTracks')),
  albums: sortValue(numeric('albums')),
  duration: sortValue(numeric('duration')),
  imported: sortValue(numeric('imported')),
  schedule: sortValue(stored('schedule')),
  checked: sortValue(numeric('checked')),
  added: sql`t.added`,
  description: sortValue(stored('description')),
  nextSync,
  // importedSortColumn without `library`: every row is a Playlist with no
  // count, so these two order by the tie-break alone. A text constant, as
  // SQLite reads an integer in ORDER BY as a column number.
  type: sql`'playlist'`,
  count: sql`NULL`,
  updated: sortValue(numeric('imported')),
}

/**
 * DEVICE-34: the keys of a Playlists directory query. The scope keys are
 * read by isMemberScope, and `library` is `library-playlist`. The column
 * filters are not implemented: without `library`, playlistDirectoryFilter
 * applies `owner`, `description`, `schedules` and `columnRanges` (`timeZone`
 * sets the calendar of its date ranges), answers nothing for `savedViewText`,
 * `savedView: 'present'` and `types` without `playlist`, and reads
 * `keyNotation` only with `library`.
 */
export const playlistQueryKeys: QueryKeys<PlaylistBrowseQuery> = {
  page: 'served',
  size: 'served',
  libraryScope: 'served',
  discoverySources: 'served',
  discoverySourceMode: 'served',
  discoverySourceScope: 'served',
  q: 'served',
  name: 'served',
  owner: 'api',
  description: 'api',
  savedViewText: 'api',
  savedView: 'api',
  sortBy: 'served',
  direction: 'served',
  sources: 'served',
  types: 'api',
  schedules: 'api',
  columnRanges: 'api',
  timeZone: 'api',
  keyNotation: 'api',
  ids: 'served',
  acceptsAdditions: 'served',
  library: 'served',
}

/** The fields `q` and `name` read, as playlistDirectoryFilter matches them. */
const qFields = { text: [], search: ['name', 'owner', 'description'] }
const nameFields = { text: [], search: ['name'] }

/**
 * playlistDirectoryFilter, playlist-directory.ts, without the visibility and
 * library conditions the feed applies. `q` and `name` are each one
 * `ILIKE '%value%'` pattern, not split into words. A read with `library` is
 * listDirectoryPage or countDirectory, which the device leaves to the API.
 */
function playlistConditions(query: PlaylistBrowseQuery, fold: TextFold): Sql {
  if (!isMemberScope(query)) unsupported('catalog-scope')
  // PL-17: `library` adds that library's playlists, which the store does not hold.
  if (query.library !== undefined) unsupported('library-playlist')
  const conditions: Sql[] = []
  if (query.q)
    conditions.push(...searchConditions('playlist', [query.q], qFields, fold))
  if (query.name)
    conditions.push(
      ...searchConditions('playlist', [query.name], nameFields, fold),
    )
  if (query.sources !== undefined && query.sources.length > 0)
    conditions.push(sql`t.source IN ${values(query.sources)}`)
  if (query.ids !== undefined && query.ids.length > 0)
    conditions.push(sql`t.id IN ${values(query.ids)}`)
  if (query.acceptsAdditions !== undefined) {
    // playlistCanAcceptAdditions, which the item's `acceptsAdditions` equals.
    const accepts = sql`t.rid IN (SELECT rid FROM item_json
      WHERE entity = 'playlist' AND json_extract(item, '$.acceptsAdditions') = 1)`
    conditions.push(
      query.acceptsAdditions === 'true' ? accepts : sql`NOT (${accepts})`,
    )
  }
  return and(conditions)
}

const PageRowSchema = z.object({ rid: z.number().int() })
const CountRowSchema = z.object({ total: z.number().int().nonnegative() })
const JobRowSchema = z.object({
  rid: z.number().int(),
  job: z.string().nullable(),
})

/**
 * The list items of the rows, in order, as loadPlaylistSummaries returns
 * them: the stored summary with `sync.job` from the group's `playlist_job`
 * row, and `sync.nextScheduledAt` null when that job has not succeeded. A
 * queued or running job is not served: the API has its progress.
 */
async function playlistItems(
  read: DeviceRead,
  rids: readonly number[],
): Promise<PlaylistSummary[]> {
  if (rids.length === 0) return []
  const jobRows = await readRows(
    read.tx,
    sql`SELECT t.rid AS rid, j.job AS job FROM playlist t
      LEFT JOIN playlist_job j ON j.id = t.sync_group_key
      WHERE t.rid IN ${values(rids)}`,
  )
  const jobs = new Map(
    jobRows.map((row) => {
      const parsed = JobRowSchema.parse(row)
      const job =
        parsed.job === null
          ? null
          : DevicePlaylistJobRowSchema.parse(JSON.parse(parsed.job))
      return [parsed.rid, job]
    }),
  )
  for (const job of jobs.values()) {
    if (job?.status === 'queued' || job?.status === 'running')
      unsupported('active-import')
  }
  const items = await readItems(read.tx, 'playlist', rids)
  return rids.map((rid) => {
    const item = DevicePlaylistItemSchema.parse(items.get(rid))
    const job = jobs.get(rid) ?? null
    return PlaylistSummarySchema.parse({
      ...item,
      sync: {
        ...item.sync,
        nextScheduledAt:
          job !== null && job.status !== 'succeeded'
            ? null
            : item.sync.nextScheduledAt,
        job,
      },
    })
  })
}

// Reads

/**
 * `GET /playlists/browse-page`: listPlaylistBrowsePage. Ordered by the sort
 * value, nulls last, then `lower(name)` and the ID, both ascending.
 */
export async function playlistPage(
  read: DeviceRead,
  query: PlaylistBrowseQuery,
): Promise<PlaylistBrowsePage> {
  const where = playlistConditions(query, read.fold)
  const window = pageWindow(query)
  const rows =
    window === null
      ? []
      : await readRows(
          read.tx,
          sql`SELECT t.rid AS rid FROM playlist t WHERE ${where}
            ${orderBy([
              orderTerm(playlistSorts[query.sortBy], query.direction),
              sql`t.sort_name ASC`,
              sql`t.id ASC`,
            ])}
            LIMIT ${window.limit} OFFSET ${window.offset}`,
        )
  const rids = rows.map((row) => PageRowSchema.parse(row).rid)
  return {
    items: await playlistItems(read, rids.slice(0, query.size)),
    page: query.page,
    size: query.size,
    hasMore: rids.length > query.size,
  }
}

/** `GET /playlists/browse-count`: countPlaylists, without `unfilteredCount`. */
export async function playlistCount(
  read: DeviceRead,
  query: PlaylistBrowseQuery,
): Promise<BrowseCount> {
  const where = playlistConditions(query, read.fold)
  const [row] = await readRows(
    read.tx,
    sql`SELECT count(*) AS total FROM playlist t WHERE ${where}`,
  )
  return { totalCount: CountRowSchema.parse(row).total }
}
