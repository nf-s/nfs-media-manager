import { z } from 'zod'
import type { LibraryPlaylistLibrary } from '@repo/schemas/browse'
import {
  DevicePlaylistItemSchema,
  DevicePlaylistJobRowSchema,
} from '@repo/schemas/device'
import {
  PlaylistColumnRangesSchema,
  PlaylistSummarySchema,
  type PlaylistBrowsePage,
  type PlaylistBrowseQuery,
  type PlaylistBrowseSort,
  type PlaylistColumnRanges,
  type PlaylistSummary,
} from '@repo/schemas/tracks'
import type { BrowseCount } from '../source'
import { valueExpression, type ValueSource } from '../compile/fields'
import {
  boundDate,
  localDates,
  readsTimeZoneAsServer,
} from '../compile/local-date'
import { isMemberScope, orderBy, orderTerm, pageWindow } from '../compile/query'
import type { QueryKeys } from '../compile/query-keys'
import { searchConditions } from '../compile/search'
import {
  and,
  EMPTY,
  FALSE,
  join,
  readRows,
  sql,
  TRUE,
  values,
  type Sql,
} from '../compile/sql'
import { unsupported } from '../compile/unsupported'
import { libraryPlaylistNameConditions } from './library-playlists'
import { readItems, type DeviceRead } from './read'
import {
  countSmartPlaylists,
  matchSavedViewText,
  type SmartPlaylist,
} from './smart-playlists'

/**
 * The Playlists directory on the device: the page and count reads. The
 * server's playlist-directory.ts defines every rule (playlistDirectoryFilter,
 * libraryDirectoryFilter, importedSortColumn, librarySortColumn,
 * libraryDirectoryRead, listPlaylistBrowsePage, listDirectoryPage,
 * countPlaylists, countDirectory); comments name the part each piece
 * reproduces. The device holds the visible member playlists of the library
 * scope and the library playlists that are not deleted.
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

type ImportedColumn = Exclude<PlaylistBrowseSort, 'type' | 'count' | 'updated'>

/** playlistSortColumns, playlist-directory.ts. Dates are stored in microseconds, which keeps their order. */
const playlistSorts: Record<ImportedColumn, Sql> = {
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
}

/**
 * directorySource: the stored `coalesce(p.source, 'library')`, and Spotify
 * for a playlist without a source that has a Spotify URL.
 */
const directorySource = sql`CASE WHEN t.source <> 'library' THEN t.source
  WHEN (SELECT json_extract(j.item, '$.spotifyUrl') FROM item_json j
    WHERE j.entity = 'playlist' AND j.rid = t.rid) IS NOT NULL THEN 'spotify'
  ELSE 'library' END`

/** sourceOrder: Library, Liked Songs, Spotify. */
const sourceOrder = (source: Sql) =>
  sql`CASE ${source} WHEN 'library' THEN 1 WHEN 'spotify-liked' THEN 2
    WHEN 'spotify' THEN 3 END`

/** importedCountColumn: tracks in Tracks, albums in Albums, none otherwise. */
function importedCount(library: PlaylistBrowseQuery['library']): Sql | null {
  if (library === 'tracks') return sortValue(numeric('tracks'))
  if (library === 'albums') return sortValue(numeric('albums'))
  return null
}

/**
 * importedSortColumn: an imported playlist is a Playlist (the first type),
 * counts its tracks or albums, and was updated when last imported.
 */
function importedSort(query: PlaylistBrowseQuery): Sql {
  const sortBy = query.sortBy
  switch (sortBy) {
    case 'type':
      return sql`1`
    case 'count':
      return importedCount(query.library) ?? sql`NULL`
    case 'source':
      return query.library ? sourceOrder(directorySource) : playlistSorts.source
    case 'updated':
      return sortValue(numeric('imported'))
    default:
      return playlistSorts[sortBy]
  }
}

/** librarySortColumn: null, ordered last, for an imported-playlist field. */
function librarySort(sortBy: PlaylistBrowseSort, count: Sql): Sql {
  switch (sortBy) {
    case 'name':
      return sql`t.sort_name`
    case 'type':
      return sql`CASE t.type WHEN 'playlist' THEN 1 WHEN 'smart' THEN 2 END`
    case 'source':
      return sql`1`
    case 'count':
      return count
    case 'updated':
      return sql`t.updated`
    case 'added':
      return sql`t.added`
    default:
      return sql`NULL`
  }
}

/**
 * DEVICE-34: the keys of a Playlists directory query, all read. The scope
 * keys are read by isMemberScope; `timeZone` sets the calendar of the date
 * ranges and of the sentences `savedViewText` reads, and `keyNotation`
 * that of their key values.
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
  owner: 'served',
  description: 'served',
  savedViewText: 'served',
  savedView: 'served',
  sortBy: 'served',
  direction: 'served',
  sources: 'served',
  types: 'served',
  schedules: 'served',
  columnRanges: 'served',
  timeZone: 'served',
  keyNotation: 'served',
  ids: 'served',
  acceptsAdditions: 'served',
  library: 'served',
}

/** The fields each text filter reads; each is one `ILIKE '%value%'` pattern, not split into words. */
const qFields = { text: [], search: ['name', 'owner', 'description'] }
const nameFields = { text: [], search: ['name'] }
const ownerFields = { text: [], search: ['owner'] }
const descriptionFields = { text: [], search: ['description'] }

/** playlistSortColumns.schedule: the position of each schedule, unknown ones as Off. */
const schedulePositions = {
  daily: 1,
  '3h': 2,
  '6h': 3,
  '1h': 4,
  off: 5,
  weekly: 6,
}

// Column ranges

const rangeFields = PlaylistColumnRangesSchema.keyof().options

/** A range column: a value of row `t`, a constant, or none (the range is skipped). */
type RangeColumn = Sql | number | null | undefined
type RangeColumns = Record<keyof PlaylistColumnRanges, RangeColumn>

function hasBound(range?: { min?: number | string; max?: number | string }) {
  return range?.min !== undefined || range?.max !== undefined
}

function holdsDateRange(query: PlaylistBrowseQuery): boolean {
  const ranges = query.columnRanges
  return rangeFields.some((key) => {
    const range = ranges?.[key]
    return typeof (range?.min ?? range?.max) === 'string'
  })
}

const DateValueRowSchema = z.object({
  rid: z.number().int(),
  value: z.number().nullable(),
})

/**
 * columnRangeConditions: inclusive bounds; a missing value fails a bound.
 * Number bounds compare the value; date bounds compare its local calendar
 * date in `timeZone`, computed for each row of `from`, since a zone's local
 * date need not grow with the time.
 */
async function columnRangeConditions(
  read: DeviceRead,
  query: PlaylistBrowseQuery,
  from: Sql,
  columns: RangeColumns,
): Promise<Sql[]> {
  const ranges = query.columnRanges
  if (!ranges) return []
  const conditions: Sql[] = []
  for (const key of rangeFields) {
    const range = ranges[key]
    const column = columns[key]
    if (!range || column === undefined || !hasBound(range)) continue
    const { min, max } = range
    if (typeof (min ?? max) === 'string') {
      const low = typeof min === 'string' ? boundDate(min) : undefined
      const high = typeof max === 'string' ? boundDate(max) : undefined
      conditions.push(
        column === null || typeof column === 'number'
          ? FALSE
          : await localDateCondition(read, query, from, column, low, high),
      )
      continue
    }
    const low = typeof min === 'number' ? min : undefined
    const high = typeof max === 'number' ? max : undefined
    if (column === null || typeof column === 'number') {
      const holds =
        column !== null &&
        (low === undefined || column >= low) &&
        (high === undefined || column <= high)
      conditions.push(holds ? TRUE : FALSE)
      continue
    }
    if (low !== undefined) conditions.push(sql`${column} >= ${low}`)
    if (high !== undefined) conditions.push(sql`${column} <= ${high}`)
  }
  return conditions
}

async function localDateCondition(
  read: DeviceRead,
  query: PlaylistBrowseQuery,
  from: Sql,
  column: Sql,
  low: number | undefined,
  high: number | undefined,
): Promise<Sql> {
  const dateOf = localDates(query.timeZone)
  const rows = await readRows(
    read.tx,
    sql`SELECT t.rid AS rid, ${column} AS value ${from}`,
  )
  const within = rows.flatMap((row) => {
    const { rid, value } = DateValueRowSchema.parse(row)
    if (value === null) return []
    const date = dateOf(value)
    return (low === undefined || date >= low) &&
      (high === undefined || date <= high)
      ? [rid]
      : []
  })
  return sql`t.rid IN ${values(within)}`
}

// Imported playlists

/** The range columns of an imported playlist, playlistDirectoryFilter. */
function importedRangeColumns(
  library: PlaylistBrowseQuery['library'],
): RangeColumns {
  return {
    count: importedCount(library),
    tracks: sortValue(numeric('tracks')),
    linkedTracks: sql`CASE WHEN ${sortValue(numeric('tracks'))} > 0
      THEN ${sortValue(numeric('linkedTracks'))} END`,
    albums: sortValue(numeric('albums')),
    // round(duration_sec::numeric / 60) of a whole number of seconds.
    duration: sql`(CAST(${sortValue(numeric('duration'))} AS INTEGER) + 30) / 60`,
    imported: sortValue(numeric('imported')),
    checked: sortValue(numeric('checked')),
    updated: sortValue(numeric('imported')),
    // playlistAdded: the store holds member playlists only.
    added: sql`t.added`,
    nextSync,
  }
}

/**
 * playlistDirectoryFilter, playlist-directory.ts, without the visibility and
 * library conditions the feed applies.
 */
async function importedConditions(
  read: DeviceRead,
  query: PlaylistBrowseQuery,
): Promise<Sql> {
  const fold = read.fold
  const conditions: Sql[] = []
  const text = [
    { value: query.q, fields: qFields },
    { value: query.name, fields: nameFields },
    { value: query.owner, fields: ownerFields },
    { value: query.description, fields: descriptionFields },
  ]
  for (const { value, fields } of text)
    if (value)
      conditions.push(...searchConditions('playlist', [value], fields, fold))
  if (query.sources?.length)
    conditions.push(
      sql`${query.library ? directorySource : sql`t.source`} IN ${values(query.sources)}`,
    )
  if (query.types?.length && !query.types.includes('playlist'))
    conditions.push(FALSE)
  if (query.savedView === 'present' || query.savedViewText)
    conditions.push(FALSE)
  if (query.schedules?.length)
    conditions.push(
      sql`t.sync_group_key IS NOT NULL`,
      sql`${sortValue(stored('schedule'))} IN ${values(
        query.schedules.map((schedule) => schedulePositions[schedule]),
      )}`,
    )
  conditions.push(
    ...(await columnRangeConditions(
      read,
      query,
      sql`FROM playlist t`,
      importedRangeColumns(query.library),
    )),
  )
  if (query.ids?.length) conditions.push(sql`t.id IN ${values(query.ids)}`)
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

// Library playlists

/** listsImportedPlaylists, library-playlist-names.ts. */
const listsImportedPlaylists = (library: LibraryPlaylistLibrary) =>
  library === 'albums' || library === 'tracks'

/**
 * libraryDirectoryFilter: a library row's source is Library, it is always
 * in the library and accepts no Spotify additions. `count` is the count
 * column, undefined to leave a count range out.
 */
async function libraryConditions(
  read: DeviceRead,
  query: PlaylistBrowseQuery,
  library: LibraryPlaylistLibrary,
  count: Sql | undefined,
  viewMatch: Sql | undefined,
): Promise<Sql> {
  const conditions: Sql[] = [
    sql`t.library = ${library}`,
    ...libraryPlaylistNameConditions(read, [query.q, query.name]),
  ]
  if (query.sources?.length && !query.sources.includes('library'))
    conditions.push(FALSE)
  if (query.types?.length)
    conditions.push(sql`t.type IN ${values(query.types)}`)
  if (query.owner || query.description || query.schedules?.length)
    conditions.push(FALSE)
  if (query.savedView)
    conditions.push(sql`t.has_view = ${query.savedView === 'present' ? 1 : 0}`)
  if (viewMatch) conditions.push(viewMatch)
  conditions.push(
    ...(await columnRangeConditions(
      read,
      query,
      sql`FROM library_playlist t WHERE t.library = ${library}`,
      {
        count,
        tracks: 0,
        linkedTracks: null,
        albums: 0,
        duration: 0,
        imported: null,
        checked: null,
        updated: sql`t.updated`,
        added: sql`t.added`,
        nextSync: null,
      },
    )),
  )
  if (query.ids?.length) conditions.push(sql`t.id IN ${values(query.ids)}`)
  if (query.acceptsAdditions === 'true') conditions.push(FALSE)
  return and(conditions)
}

/** libraryCountColumn: a playlist's listed entries, else the smart count. */
const libraryCount = (smartCount: Sql) =>
  sql`CASE WHEN t.type = 'playlist' THEN t.entry_count ELSE ${smartCount} END`

type SmartPlan = {
  /** The smart rows' count, as `s.n` of `join` or null. */
  count: Sql
  join: Sql
  /** The savedViewText condition, when the query has the text. */
  viewMatch: Sql | undefined
  /** The smart rows' counts by `rid`, when a count range reads them. */
  counts: Map<number, number> | undefined
}

const SmartRowSchema = z.object({ rid: z.number().int(), item: z.string() })

/** The smart playlists of the library that pass `where`, with their views. */
async function readSmartPlaylists(
  read: DeviceRead,
  where: Sql,
): Promise<SmartPlaylist[]> {
  const rows = await readRows(
    read.tx,
    sql`SELECT t.rid AS rid, j.item AS item FROM library_playlist t
      JOIN item_json j ON j.entity = 'library_playlist' AND j.rid = t.rid
      WHERE t.type = 'smart' AND ${where}`,
  )
  return rows.flatMap((row) => {
    const parsed = SmartRowSchema.parse(row)
    const view = PlaylistSummarySchema.parse(JSON.parse(parsed.item)).view
    return view ? [{ rid: parsed.rid, view }] : []
  })
}

/**
 * libraryDirectoryRead: resolves `savedViewText` and the smart counts of a
 * count range before the page or count. The text is matched against the
 * smart rows that pass every other filter; with a count range, every smart
 * playlist of the library whose view parses is counted (the service counts
 * those passing the other filters, which gives the same values for them).
 */
async function smartPlan(
  read: DeviceRead,
  query: PlaylistBrowseQuery,
  library: LibraryPlaylistLibrary,
): Promise<SmartPlan> {
  const filterCount = hasBound(query.columnRanges?.count)
  const viewText = query.savedViewText
  if (
    (!filterCount && !viewText) ||
    (query.types?.length && !query.types.includes('smart'))
  )
    return {
      count: sql`NULL`,
      join: EMPTY,
      viewMatch: viewText ? FALSE : undefined,
      counts: undefined,
    }
  const matching = viewText
    ? await matchSavedViewText(
        read,
        query,
        library,
        viewText,
        await readSmartPlaylists(
          read,
          await libraryConditions(read, query, library, undefined, undefined),
        ),
      )
    : undefined
  if (!filterCount)
    return {
      count: sql`NULL`,
      join: EMPTY,
      viewMatch: sql`t.rid IN ${values(matching ?? [])}`,
      counts: undefined,
    }
  const counts = await countSmartPlaylists(
    read,
    library,
    await readSmartPlaylists(read, sql`t.library = ${library}`),
  )
  return {
    count: sql`s.n`,
    join: sql`LEFT JOIN (SELECT value ->> 0 AS rid, value ->> 1 AS n
      FROM json_each(${JSON.stringify([...counts])})) s ON s.rid = t.rid`,
    // A matching view without a count is left out, as it has no count row.
    viewMatch:
      matching === undefined
        ? undefined
        : sql`t.rid IN ${values(matching.filter((rid) => counts.has(rid)))}`,
    counts,
  }
}

// The directory

type DirectoryPart = {
  origin: 'imported' | 'library'
  /** `FROM ... t` with any joins. */
  from: Sql
  where: Sql
  sort: Sql
}

type DirectoryPlan = {
  parts: DirectoryPart[]
  counts: Map<number, number> | undefined
}

/**
 * The parts of the directory: the imported playlists without `library` or
 * in Albums and Tracks, and the library's own rows with `library`. Every
 * reason to fall through is found here, before a row of the result is
 * read, except `active-import`, which the page's rows decide.
 */
async function planDirectory(
  read: DeviceRead,
  query: PlaylistBrowseQuery,
): Promise<DirectoryPlan> {
  if (!isMemberScope(query)) unsupported('catalog-scope')
  if (holdsDateRange(query) && !readsTimeZoneAsServer(query.timeZone))
    unsupported('time-zone')
  const library = query.library
  const parts: DirectoryPart[] = []
  if (library === undefined || listsImportedPlaylists(library))
    parts.push({
      origin: 'imported',
      from: sql`FROM playlist t`,
      where: await importedConditions(read, query),
      sort: importedSort(query),
    })
  if (library === undefined) return { parts, counts: undefined }
  const smart = await smartPlan(read, query, library)
  const count = libraryCount(smart.count)
  parts.push({
    origin: 'library',
    from: sql`FROM library_playlist t ${smart.join}`,
    where: await libraryConditions(
      read,
      query,
      library,
      count,
      smart.viewMatch,
    ),
    sort: librarySort(query.sortBy, count),
  })
  return { parts, counts: smart.counts }
}

const PageRowSchema = z.object({
  origin: z.enum(['imported', 'library']),
  rid: z.number().int(),
})
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

/**
 * listDirectoryPage: an imported row as on the imported-only page, marked
 * as imported, updated when imported and counted in the library's noun.
 */
function importedDirectoryItem(
  summary: PlaylistSummary,
  library: LibraryPlaylistLibrary,
): PlaylistSummary {
  return {
    ...summary,
    origin: 'imported',
    type: 'playlist',
    library: null,
    view: null,
    updatedAt: summary.importedAt,
    itemCount: library === 'albums' ? summary.albumCount : summary.trackCount,
  }
}

/**
 * librarySummary: the stored row, whose smart count is null; with a count
 * range a smart row carries its count.
 */
async function libraryItems(
  read: DeviceRead,
  rids: readonly number[],
  counts: Map<number, number> | undefined,
): Promise<Map<number, PlaylistSummary>> {
  const items = await readItems(read.tx, 'library_playlist', rids)
  return new Map(
    rids.map((rid) => {
      const item = PlaylistSummarySchema.parse(items.get(rid))
      return [
        rid,
        counts !== undefined && item.type === 'smart'
          ? { ...item, itemCount: counts.get(rid) ?? null }
          : item,
      ]
    }),
  )
}

// Reads

/**
 * `GET /playlists/browse-page`: listPlaylistBrowsePage and
 * listDirectoryPage. Ordered by the sort value, nulls last, then
 * `lower(name)` and the ID, both ascending, over both origins.
 */
export async function playlistPage(
  read: DeviceRead,
  query: PlaylistBrowseQuery,
): Promise<PlaylistBrowsePage> {
  const plan = await planDirectory(read, query)
  const window = pageWindow(query)
  const selects = plan.parts.map(
    (part) =>
      sql`SELECT ${part.origin} AS origin, t.rid AS rid, t.id AS id,
        t.sort_name AS sort_name, ${part.sort} AS sort_value
        ${part.from} WHERE ${part.where}`,
  )
  const rows =
    window === null
      ? []
      : await readRows(
          read.tx,
          sql`SELECT origin, rid FROM (${join(selects, ' UNION ALL ')})
            ${orderBy([
              orderTerm(sql`sort_value`, query.direction),
              sql`sort_name ASC`,
              sql`id ASC`,
            ])}
            LIMIT ${window.limit} OFFSET ${window.offset}`,
        )
  const page = rows.slice(0, query.size).map((row) => PageRowSchema.parse(row))
  const rids = (origin: 'imported' | 'library') =>
    page.flatMap((row) => (row.origin === origin ? [row.rid] : []))
  const importedRids = rids('imported')
  const imported = await playlistItems(read, importedRids)
  const importedByRid = new Map(
    importedRids.map((rid, index) => [rid, imported[index]]),
  )
  const library = await libraryItems(read, rids('library'), plan.counts)
  const items = page.flatMap((row): PlaylistSummary[] => {
    const item =
      row.origin === 'imported'
        ? importedByRid.get(row.rid)
        : library.get(row.rid)
    if (item === undefined) return []
    return [
      row.origin === 'imported' && query.library
        ? importedDirectoryItem(item, query.library)
        : item,
    ]
  })
  return {
    items,
    page: query.page,
    size: query.size,
    hasMore: rows.length > query.size,
  }
}

/** `GET /playlists/browse-count`: countPlaylists and countDirectory, without `unfilteredCount`. */
export async function playlistCount(
  read: DeviceRead,
  query: PlaylistBrowseQuery,
): Promise<BrowseCount> {
  const plan = await planDirectory(read, query)
  const counts = plan.parts.map(
    (part) => sql`(SELECT count(*) ${part.from} WHERE ${part.where})`,
  )
  const [row] = await readRows(
    read.tx,
    sql`SELECT ${join(counts, ' + ')} AS total`,
  )
  return { totalCount: CountRowSchema.parse(row).total }
}
