import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  LIBRARY_PLAYLIST_FILTER_FIELD,
  LibraryPlaylistLibrarySchema,
  LibraryPlaylistTypeSchema,
  LibraryPlaylistViewSchema,
  type LibraryPlaylistLibrary,
} from '@repo/schemas/browse'
import {
  parseLibraryBrowseView,
  type LibraryBrowseQuery,
} from '@repo/schemas/library-playlists'
import { describeSavedView } from '@repo/schemas/saved-view-sentence'
import {
  PlaylistBrowsePageSchema,
  PlaylistBrowseQuerySchema,
  PlaylistColumnRangesSchema,
  PlaylistPresentationSchema,
  PlaylistSummarySchema,
  PlaylistSyncScheduleSchema,
  SPOTIFY_PLAYLIST_IMPORT_TASK,
  type PlaylistBrowseQuery,
  type PlaylistBrowseSort,
  type PlaylistColumnRanges,
  type PlaylistPresentation,
  type PlaylistSummary,
} from '@repo/schemas/tracks'
import { createDatabaseReadCache } from '@/lib/database-read-cache'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { checksumJson } from '@/lib/media-utils'
import { playlistScheduleMinutes } from '@/lib/playlist-sync'
import { queryBrowseCount } from './browse'
import { catalogScopeCondition } from './catalog-scope'
import { listedEntry } from './library-playlist-entries'
import { ensureLegacySavedViews } from './library-playlist-legacy-views'
import { listsImportedPlaylists } from './library-playlist-names'
import {
  latestSpotifyJobs,
  LIKED_SONGS_KEY,
  PLAYLIST_KEY_PREFIX,
  playlistSync,
  storedGroupKey,
} from './spotify-playlist-state'
import { countSubscriptionBrowseItems } from './subscription-library'

const isoTimestamp = (column: SQL) =>
  sql`to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const CountRowsSchema = z.array(z.object({ count: z.coerce.number() }))

const PlaylistRowsSchema = z.array(
  z.object({
    id: z.string(),
    in_library: z.boolean(),
    name: z.string(),
    source: z.string().nullable(),
    spotify_id: z.string().nullable(),
    owner_name: z.string().nullable(),
    description: z.string().nullable(),
    artwork_url: z.string().nullable(),
    spotify_url: z.string().nullable(),
    imported_at: z.string().nullable(),
    created_at: z.string().nullable(),
    checked_at: z.string().nullable(),
    sync_schedule: z.string(),
    spotify_editable: z.boolean(),
    track_count: z.number().int(),
    linked_track_count: z.number().int(),
    album_count: z.number().int(),
    presentation: PlaylistPresentationSchema,
    presentation_override: PlaylistPresentationSchema.nullable(),
    duration_sec: z.coerce.number().int(),
  }),
)

const optionalDate = (value: string | null) => (value ? new Date(value) : null)

export const playlistAlbumMembers = sql`
  select pi.media_item_id as album_id, pi.position, pi.added_at from playlist_item pi
  join album a on a.media_item_id = pi.media_item_id
  join media_item mi on mi.id = a.media_item_id and mi.in_library
  where pi.playlist_id = p.id
  union all
  select lt.album_media_item_id, pi.position, pi.added_at from playlist_item pi
  join library_track lt on lt.media_item_id = pi.media_item_id
  join media_item mi on mi.id = lt.album_media_item_id and mi.in_library
  where pi.playlist_id = p.id and lt.album_media_item_id is not null
  union all
  select t.album_media_item_id, pi.position, pi.added_at from playlist_item pi
  join track t on t.track_media_item_id = pi.media_item_id
  join media_item mi on mi.id = t.album_media_item_id and mi.in_library
  where pi.playlist_id = p.id
`

const playlistAlbumCount = sql`(select count(distinct album_id)::int from (${playlistAlbumMembers}) albums)`

export const playlistTrackStats = sql`
  select count(*)::int as track_count,
    count(album_media.id)::int as linked_track_count,
    coalesce(sum(lt.duration_sec), 0)::int as duration_sec
  from playlist_item pi
  join library_track lt on lt.media_item_id = pi.media_item_id
  left join media_item album_media on album_media.id = lt.album_media_item_id and album_media.in_library
  where pi.playlist_id = p.id
`

// Require at least two recordings, even if every track from a single is present.
const nearCompleteAlbum = (matches: SQL, length: SQL) =>
  sql`(${matches} >= 2 and (${matches} >= ${length} - 1 or ${matches} * 5 >= ${length} * 4))`

// Stored positions and Spotify release IDs both support completeness.
// Without a known release length, its tracks must form a cluster in order.
// A direct album membership contributes its tracks or one album entry.
const automaticPlaylistPresentation = sql`case when p.source = 'spotify-liked' then 'tracks' else (
  with playlist_tracks as (
    select lt.media_item_id as track_id, lt.album_media_item_id as album_id,
      nullif(lt.spotify_album_id, '') as release_id,
      lt.album_link_strategy = 'spotify-album' as exact_release_link,
      row_number() over (order by pi.position, pi.media_item_id) as playlist_order
    from playlist_item pi join library_track lt on lt.media_item_id = pi.media_item_id
    where pi.playlist_id = p.id
  ), direct_albums as (
    select a.media_item_id as album_id
    from playlist_item pi join album a on a.media_item_id = pi.media_item_id
    where pi.playlist_id = p.id
  ), stored_members as (
    select t.album_media_item_id as album_id, t.track_media_item_id as track_id
    from playlist_tracks pt join track t on t.track_media_item_id = pt.track_id
  ), album_lengths as (
    select a.media_item_id as album_id,
      greatest(a.track_count, count(t.id)) as expected
    from album a left join track t on t.album_media_item_id = a.media_item_id
    where a.media_item_id in (
      select album_id from stored_members
      union
      select album_id from playlist_tracks where release_id is not null and exact_release_link
    )
    group by a.media_item_id
  ), qualifying_lists as (
    select m.album_id
    from stored_members m join album_lengths l using (album_id)
    group by m.album_id, l.expected
    having ${nearCompleteAlbum(sql`count(distinct m.track_id)`, sql`l.expected`)}
  ), qualifying_releases as (
    select pt.release_id
    from playlist_tracks pt
    left join album_lengths l on l.album_id = pt.album_id and pt.exact_release_link
    where pt.release_id is not null
    group by pt.release_id
    having case when max(l.expected) > 0 then ${nearCompleteAlbum(sql`count(*)`, sql`max(l.expected)`)}
      else count(*) >= 5 and count(*) * 5 >= (max(pt.playlist_order) - min(pt.playlist_order) + 1) * 4
      end
  ), covered_tracks as (
    select track_id from playlist_tracks where album_id in (select album_id from direct_albums)
    union
    select track_id from stored_members where album_id in (
      select album_id from direct_albums union select album_id from qualifying_lists
    )
    union
    select pt.track_id from playlist_tracks pt join qualifying_releases r using (release_id)
  ), direct_album_stats as (
    select count(*) as unrepresented
    from direct_albums a
    where not exists (select 1 from playlist_tracks pt where pt.album_id = a.album_id)
      and not exists (select 1 from stored_members m where m.album_id = a.album_id)
  )
  select case
    when stats.track_count + direct.unrepresented > 0
      and ((select count(*) from covered_tracks) + direct.unrepresented) * 5
        >= (stats.track_count + direct.unrepresented) * 4 then 'albums'
    else 'tracks'
  end
  from direct_album_stats direct
) end`

export const playlistMember = sql`(p.added_to_library or p.source is not null or exists (${playlistAlbumMembers}))`
export const visiblePlaylists = sql`p.kind = 'playlist' and (${playlistMember} or p.catalog_provider is not null)`
/** An imported playlist the directory lists by default, as `p`. */
export const listedImportedPlaylist = sql`(${visiblePlaylists} and ${playlistMember})`
const playlistCanAcceptAdditions = sql`(p.source = 'spotify' and p.spotify_id is not null and p.spotify_editable)`
export const playlistGroup = sql`case
  when p.source = 'spotify-liked' then ${LIKED_SONGS_KEY}
  when p.source = 'spotify' and nullif(p.spotify_id, '') is not null then ${PLAYLIST_KEY_PREFIX} || p.spotify_id
  end`
const playlistLastCheck = sql`coalesce(p.checked_at, p.imported_at)`
const playlistAdded = sql`case when ${playlistMember} then p.created_at end`
const playlistImportJobs = sql`
  left join (
    select distinct on (j.options->>'groupKey') j.options->>'groupKey' as group_key, j.status
    from scrape_job j
    where j.provider = 'spotify' and j.options->>'task' = ${SPOTIFY_PLAYLIST_IMPORT_TASK}
    order by j.options->>'groupKey', j.created_at desc, j.id desc
  ) job on job.group_key = ${playlistGroup}
`
const scheduleDelay = sql`case p.sync_schedule ${sql.join(
  Object.entries(playlistScheduleMinutes).flatMap(([schedule, minutes]) =>
    minutes === null ? [] : [sql`when ${schedule} then ${minutes}::int`],
  ),
  sql` `,
)} end`

const directorySource = sql`coalesce(p.source,
  case when p.spotify_url is not null then 'spotify' else 'library' end)`

// Sort by the labels used in the table: Library, Liked Songs, Spotify.
const sourceOrder = (source: SQL) =>
  sql`array_position(array['library', 'spotify-liked', 'spotify'], ${source})`
// Playlist, then Smart playlist.
const typeOrder = (type: SQL) =>
  sql`array_position(array['playlist', 'smart'], ${type})`

export const playlistSortColumns = {
  name: sql`lower(p.name)`,
  source: sourceOrder(sql`coalesce(p.source, 'library')`),
  owner: sql`lower(p.owner_name)`,
  tracks: sql`(select stats.track_count from (${playlistTrackStats}) stats)`,
  linkedTracks: sql`(select stats.linked_track_count from (${playlistTrackStats}) stats)`,
  albums: playlistAlbumCount,
  duration: sql`(select stats.duration_sec from (${playlistTrackStats}) stats)`,
  imported: sql`p.imported_at`,
  // Daily, Every 3 hours, Every 6 hours, Every hour, Off, Weekly.
  schedule: sql`case when (${playlistGroup}) is not null then
    coalesce(array_position(array['daily', '3h', '6h', '1h', 'off', 'weekly'], p.sync_schedule), 5)
    end`,
  checked: playlistLastCheck,
  added: sql`p.created_at`,
  description: sql`lower(p.description)`,
  nextSync: sql`case when (${playlistGroup}) is not null and coalesce(job.status, 'succeeded') = 'succeeded'
    then ${playlistLastCheck} + make_interval(mins => ${scheduleDelay}) end`,
}

/**
 * An imported playlist's value for a sort. PL-17: its type is Playlist, its
 * count is its tracks in Tracks and its albums in Albums (none without a
 * library) and it was updated when its contents were last stored.
 */
function importedSortColumn(query: PlaylistBrowseQuery): SQL {
  switch (query.sortBy) {
    case 'type':
      return typeOrder(sql`'playlist'`)
    case 'count':
      return importedCountColumn(query.library)
    case 'source':
      return query.library
        ? sourceOrder(directorySource)
        : playlistSortColumns.source
    case 'updated':
      return sql`p.imported_at`
    default:
      return playlistSortColumns[query.sortBy]
  }
}

function importedCountColumn(library: PlaylistBrowseQuery['library']) {
  if (library === 'tracks') return playlistSortColumns.tracks
  if (library === 'albums') return playlistSortColumns.albums
  return sql`null::int`
}

const escapedSubstring = (value: string) =>
  `%${value.replace(/[\\%_]/g, '\\$&')}%`

const matchesSubstring = (column: SQL, value: string) =>
  sql`${column} ilike ${escapedSubstring(value)}`

const oneOf = (column: SQL, choices: string[]) =>
  sql`${column} = any(${sql.param(choices)}::text[])`

const rangeFields = PlaylistColumnRangesSchema.keyof().options

function columnRangeConditions(
  query: PlaylistBrowseQuery,
  columns: Record<keyof PlaylistColumnRanges, SQL | undefined>,
) {
  const ranges = query.columnRanges
  if (!ranges) return []
  const timeZone = query.timeZone ?? 'UTC'
  return rangeFields.flatMap((key) => {
    const range = ranges[key]
    const column = columns[key]
    if (!range || !column) return []
    const { min, max } = range
    const isDate = typeof (min ?? max) === 'string'
    // Stored timestamps are UTC. Compare the displayed local calendar date.
    const value = isDate
      ? timeZone === 'UTC'
        ? sql`(${column})::date`
        : sql`((${column}) at time zone 'UTC' at time zone ${timeZone})::date`
      : column
    const bound = (input: string | number) =>
      typeof input === 'number' ? sql`${input}::numeric` : sql`${input}::date`
    return [
      ...(min === undefined ? [] : [sql`${value} >= ${bound(min)}`]),
      ...(max === undefined ? [] : [sql`${value} <= ${bound(max)}`]),
    ]
  })
}

/** Join the latest job when sorting or filtering by the next import. */
function importJobsJoin(query: PlaylistBrowseQuery, sorting = false) {
  return hasRange(query.columnRanges?.nextSync) ||
    (sorting && query.sortBy === 'nextSync')
    ? playlistImportJobs
    : sql``
}

function hasRange(range?: { min?: number | string; max?: number | string }) {
  return range?.min !== undefined || range?.max !== undefined
}

function playlistDirectoryFilter(query: PlaylistBrowseQuery) {
  const conditions = [
    visiblePlaylists,
    catalogScopeCondition(sql`p.id`, playlistMember, query, 'playlist'),
  ]
  if (query.q) {
    const pattern = escapedSubstring(query.q)
    conditions.push(
      sql`(p.name ilike ${pattern} or p.owner_name ilike ${pattern} or p.description ilike ${pattern})`,
    )
  }
  if (query.name) conditions.push(matchesSubstring(sql`p.name`, query.name))
  if (query.owner)
    conditions.push(matchesSubstring(sql`p.owner_name`, query.owner))
  if (query.description)
    conditions.push(matchesSubstring(sql`p.description`, query.description))
  if (query.sources?.length)
    conditions.push(
      oneOf(
        query.library ? directorySource : sql`coalesce(p.source, 'library')`,
        query.sources,
      ),
    )
  if (query.types?.length && !query.types.includes('playlist'))
    conditions.push(sql`false`)
  if (query.savedView === 'present' || query.savedViewText)
    conditions.push(sql`false`)
  if (query.schedules?.length)
    conditions.push(
      sql`(${playlistGroup}) is not null`,
      oneOf(
        sql`case when ${oneOf(sql`p.sync_schedule`, PlaylistSyncScheduleSchema.options)}
          then p.sync_schedule else 'off' end`,
        query.schedules,
      ),
    )
  conditions.push(
    ...columnRangeConditions(query, {
      ...playlistSortColumns,
      count: importedCountColumn(query.library),
      linkedTracks: sql`(select case when stats.track_count > 0 then stats.linked_track_count end
      from (${playlistTrackStats}) stats)`,
      duration: sql`round(${playlistSortColumns.duration}::numeric / 60)`,
      updated: sql`p.imported_at`,
      added: playlistAdded,
    }),
  )
  if (query.ids?.length)
    conditions.push(
      sql`p.id in (${sql.join(
        query.ids.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )
  if (query.acceptsAdditions)
    conditions.push(
      query.acceptsAdditions === 'true'
        ? sql`${playlistCanAcceptAdditions} is true`
        : sql`${playlistCanAcceptAdditions} is not true`,
    )
  return sql.join(conditions, sql` and `)
}

export async function loadPlaylistSummaries(
  ids: string[],
  knownJobs?: Awaited<ReturnType<typeof latestSpotifyJobs>>,
): Promise<PlaylistSummary[]> {
  if (!ids.length) return []
  const rows = PlaylistRowsSchema.parse(
    (
      await db.execute(sql`
        select p.id, ${playlistMember} as in_library,
          p.name, p.source, p.spotify_id, p.owner_name, p.description,
          p.artwork_url, p.spotify_url,
          ${isoTimestamp(sql`p.imported_at`)} as imported_at,
          ${isoTimestamp(playlistAdded)} as created_at,
          ${isoTimestamp(sql`p.checked_at`)} as checked_at,
          p.sync_schedule, p.spotify_editable,
          stats.track_count, stats.linked_track_count, stats.duration_sec,
          ${playlistAlbumCount} as album_count,
          coalesce(p.presentation_override, ${automaticPlaylistPresentation}) as presentation,
          p.presentation_override
        from playlist p
        cross join lateral (${playlistTrackStats}) stats
        where p.id in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )}) and ${visiblePlaylists}`)
    ).rows,
  )
  const groupKeys = rows
    .map((row) =>
      storedGroupKey({ source: row.source, spotifyId: row.spotify_id }),
    )
    .filter((key) => key !== null)
  const jobs =
    knownJobs ??
    (await latestSpotifyJobs(SPOTIFY_PLAYLIST_IMPORT_TASK, groupKeys))
  const summaries = rows.map((row) => {
    const key = storedGroupKey({
      source: row.source,
      spotifyId: row.spotify_id,
    })
    return PlaylistSummarySchema.parse({
      id: row.id,
      inLibrary: row.in_library,
      name: row.name,
      source: row.source,
      ownerName: row.owner_name,
      description: row.description,
      artworkUrl: row.artwork_url,
      spotifyUrl: row.spotify_url,
      importedAt: row.imported_at,
      createdAt: row.created_at,
      trackCount: row.track_count,
      linkedTrackCount: row.linked_track_count,
      albumCount: row.album_count,
      presentation: row.presentation,
      presentationOverride: row.presentation_override,
      durationSec: row.duration_sec,
      acceptsAdditions:
        row.source === 'spotify' &&
        row.spotify_id !== null &&
        row.spotify_editable,
      sync: playlistSync(
        {
          source: row.source,
          spotifyId: row.spotify_id,
          syncSchedule: row.sync_schedule,
          checkedAt: optionalDate(row.checked_at),
          importedAt: optionalDate(row.imported_at),
        },
        key ? (jobs.get(key)?.job ?? null) : null,
      ),
    })
  })
  const byId = new Map(summaries.map((summary) => [summary.id, summary]))
  return ids.flatMap((id) => {
    const summary = byId.get(id)
    return summary ? [summary] : []
  })
}

export async function listPlaylistBrowsePage(query: PlaylistBrowseQuery) {
  if (query.library) return listDirectoryPage(query, query.library)
  const sort = importedSortColumn(query)
  const direction = query.direction === 'asc' ? sql`asc` : sql`desc`
  const rows = z.array(z.object({ id: z.string() })).parse(
    (
      await db.execute(sql`
    select p.id
    from playlist p
    ${importJobsJoin(query, true)}
    where ${playlistDirectoryFilter(query)}
    order by ${sort} ${direction} nulls last, lower(p.name), p.id
    limit ${query.size + 1} offset ${(query.page - 1) * query.size}
  `)
    ).rows,
  )
  const items = await loadPlaylistSummaries(
    rows.slice(0, query.size).map((row) => row.id),
  )
  return PlaylistBrowsePageSchema.parse({
    items,
    page: query.page,
    size: query.size,
    hasMore: rows.length > query.size,
  })
}

export async function countPlaylists(query: PlaylistBrowseQuery) {
  if (query.library) return countDirectory(query, query.library)
  const [matching] = CountRowsSchema.parse(
    (
      await db.execute(sql`
    select count(*) as count from playlist p ${importJobsJoin(query)}
    where ${playlistDirectoryFilter(query)}
  `)
    ).rows,
  )
  return { totalCount: matching?.count ?? 0 }
}

// PL-17: the Playlists directory of one library. In SQL, `lp` is a
// library_playlist of the library that is not deleted.

const libraryEntryCount = sql`(select count(*)::int from library_playlist_entry e
  where ${listedEntry(sql`lp.id`)})`

const libraryCountColumn = (smartCount: SQL) =>
  sql`case when lp.type = 'playlist' then ${libraryEntryCount} else ${smartCount} end`

/** A library row's value for a sort; null, ordered last, for an imported-playlist field. */
function librarySortColumn(sortBy: PlaylistBrowseSort, smartCount: SQL): SQL {
  switch (sortBy) {
    case 'name':
      return sql`lower(lp.name)`
    case 'type':
      return typeOrder(sql`lp.type`)
    case 'source':
      return sourceOrder(sql`'library'`)
    case 'count':
      return libraryCountColumn(smartCount)
    case 'updated':
      return sql`lp.updated_at`
    case 'added':
      return sql`lp.created_at`
    default:
      return sql`null`
  }
}

/**
 * Library rows the query lists: a library row's source is Library, it is
 * always in the library and it accepts no Spotify additions.
 */
function libraryDirectoryFilter(
  query: PlaylistBrowseQuery,
  library: LibraryPlaylistLibrary,
  count?: SQL,
  savedViewTextMatch?: SQL,
) {
  const conditions = [
    sql`lp.library = ${library}`,
    sql`lp.deleted_at is null`,
    catalogScopeCondition(sql`lp.id`, sql`true`, query, 'playlist'),
  ]
  for (const text of [query.q, query.name])
    if (text) conditions.push(matchesSubstring(sql`lp.name`, text))
  if (query.sources?.length && !query.sources.includes('library'))
    conditions.push(sql`false`)
  if (query.types?.length) conditions.push(oneOf(sql`lp.type`, query.types))
  if (query.owner || query.description || query.schedules?.length)
    conditions.push(sql`false`)
  if (query.savedView)
    conditions.push(
      query.savedView === 'present'
        ? sql`lp.view is not null`
        : sql`lp.view is null`,
    )
  if (savedViewTextMatch) conditions.push(savedViewTextMatch)
  const missing = sql`null::timestamp`
  conditions.push(
    ...columnRangeConditions(query, {
      count,
      tracks: sql`0`,
      linkedTracks: sql`null`,
      albums: sql`0`,
      duration: sql`0`,
      imported: missing,
      checked: missing,
      updated: sql`lp.updated_at`,
      added: sql`lp.created_at`,
      nextSync: missing,
    }),
  )
  if (query.ids?.length)
    conditions.push(
      sql`lp.id in (${sql.join(
        query.ids.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )
  if (query.acceptsAdditions === 'true') conditions.push(sql`false`)
  return sql.join(conditions, sql` and `)
}

const SmartCandidateRowsSchema = z.array(
  z.object({
    id: z.string(),
    view: LibraryPlaylistViewSchema,
    updated_at: z.string(),
  }),
)
type SmartCandidate = z.infer<typeof SmartCandidateRowsSchema>[number]
const PlaylistNameRowsSchema = z.array(
  z.object({ id: z.string(), name: z.string() }),
)

async function filterSavedViewText(
  candidates: SmartCandidate[],
  library: LibraryPlaylistLibrary,
  text: string,
  {
    timeZone = 'UTC',
    keyNotation,
  }: Pick<PlaylistBrowseQuery, 'timeZone' | 'keyNotation'>,
  names: Map<string, string | null>,
) {
  const ids = new Set<string>()
  for (const { view } of candidates) {
    const parsed = parseLibraryBrowseView(library, view)
    if (!parsed.success) continue
    for (const filter of parsed.data.query.filters)
      if (
        filter.field === LIBRARY_PLAYLIST_FILTER_FIELD &&
        !names.has(filter.value)
      )
        ids.add(filter.value)
  }
  const references = [...ids]
  const batchSize = 500
  for (let start = 0; start < references.length; start += batchSize) {
    const batch = references.slice(start, start + batchSize)
    const result =
      await db.execute(sql`select lp.id, lp.name from library_playlist lp
      where ${oneOf(sql`lp.id`, batch)} and lp.deleted_at is null`)
    for (const id of batch) names.set(id, null)
    for (const row of PlaylistNameRowsSchema.parse(result.rows))
      names.set(row.id, row.name)
  }
  const playlistName = (id: string) => names.get(id) ?? null
  const needle = text.toLowerCase()
  return candidates.filter(({ view }) =>
    describeSavedView({ library, view, playlistName, timeZone, keyNotation })
      .toLowerCase()
      .includes(needle),
  )
}

async function readSmartCandidates(
  query: PlaylistBrowseQuery,
  library: LibraryPlaylistLibrary,
) {
  const candidates = sql`select lp.id, lp.view, lp.updated_at::text as updated_at
    from library_playlist lp
    where lp.type = 'smart' and ${libraryDirectoryFilter(query, library)}`
  if (!query.savedViewText)
    return SmartCandidateRowsSchema.parse((await db.execute(candidates)).rows)

  const matches: SmartCandidate[] = []
  const names = new Map<string, string | null>()
  const batchSize = 200
  let afterId: string | undefined
  do {
    const batch = SmartCandidateRowsSchema.parse(
      (
        await db.execute(sql`${candidates}
        ${afterId === undefined ? sql`` : sql`and lp.id > ${afterId}`}
        order by lp.id limit ${batchSize}`)
      ).rows,
    )
    matches.push(
      ...(await filterSavedViewText(
        batch,
        library,
        query.savedViewText,
        query,
        names,
      )),
    )
    afterId = batch.length === batchSize ? batch.at(-1)?.id : undefined
  } while (afterId !== undefined)
  return matches
}

const smartCountCache = createDatabaseReadCache<Array<[string, number | null]>>(
  {
    maxEntries: 32,
    maxValueBytes: 256_000,
  },
)

/** The filtered total used by the smart playlist's Browse count cell. */
async function smartPlaylistCount({ library, query }: LibraryBrowseQuery) {
  try {
    switch (library) {
      case 'albums':
        return (await queryBrowseCount('album', query)).totalCount
      case 'tracks':
        return (await queryBrowseCount('track', query)).totalCount
      case 'films':
        return (await queryBrowseCount('film', query)).totalCount
      case 'subscriptions':
      case 'mixes':
        return (await countSubscriptionBrowseItems(query)).totalCount
    }
  } catch (error) {
    // A saved view can refer to a field that Browse no longer supports.
    if (error instanceof ServerError && error.response.statusCode === 422)
      return null
    throw error
  }
}

async function readSmartPlaylistCounts(
  library: LibraryPlaylistLibrary,
  views: Map<string, LibraryBrowseQuery>,
) {
  if (!views.size) return new Map<string, number | null>()
  const entries = [...views]
  const load = async () => {
    const results: Array<[string, number | null]> = []
    // Leave a connection free in the Worker's four-connection pool.
    const batchSize = 3
    for (let start = 0; start < entries.length; start += batchSize) {
      const batch = entries.slice(start, start + batchSize)
      results.push(
        ...(await Promise.all(
          batch.map(
            async ([key, view]): Promise<[string, number | null]> => [
              key,
              await smartPlaylistCount(view),
            ],
          ),
        )),
      )
    }
    return results
  }
  const rolling = entries.some(
    ([, { query }]) =>
      'listening' in query &&
      query.listening?.rules.some(({ period }) => period.kind === 'rolling'),
  )
  const key = checksumJson([library, [...views.keys()].sort()])
  return new Map(rolling ? await load() : await smartCountCache(key, load))
}

async function countSmartCandidates(
  candidates: SmartCandidate[],
  library: LibraryPlaylistLibrary,
) {
  const views = new Map<string, LibraryBrowseQuery>()
  const keyedCandidates = candidates.flatMap(({ id, view, updated_at }) => {
    const criteria = { ...view }
    delete criteria.sortBy
    delete criteria.direction
    delete criteria.listeningSort
    const key = checksumJson(
      JSON.stringify(criteria, Object.keys(criteria).sort()),
    )
    if (!views.has(key)) {
      const parsed = parseLibraryBrowseView(library, criteria)
      if (!parsed.success) return []
      views.set(key, parsed.data)
    }
    return [{ id, updated_at, key }]
  })
  const countsByView = await readSmartPlaylistCounts(library, views)
  return keyedCandidates.flatMap(({ id, updated_at, key }) => {
    const count = countsByView.get(key)
    return count == null ? [] : [{ id, updated_at, item_count: count }]
  })
}

/** Resolve application-level smart view filters before the SQL page or count. */
async function libraryDirectoryRead(
  query: PlaylistBrowseQuery,
  library: LibraryPlaylistLibrary,
) {
  const filterCount = hasRange(query.columnRanges?.count)
  const viewText = query.savedViewText
  const emptyCount = sql`null::int`
  const empty = {
    join: sql``,
    count: emptyCount,
    where: libraryDirectoryFilter(
      query,
      library,
      libraryCountColumn(emptyCount),
      viewText ? sql`false` : undefined,
    ),
  }
  if (
    (!filterCount && !viewText) ||
    (query.types?.length && !query.types.includes('smart'))
  )
    return empty
  // Evaluate live Browse counts only for smart rows passing every other filter.
  const matches = await readSmartCandidates(query, library)
  const rows = filterCount
    ? await countSmartCandidates(matches, library)
    : matches.map(({ id, updated_at }) => ({ id, updated_at }))
  if (!rows.length) return empty
  const count = filterCount ? sql`smart.item_count` : emptyCount
  return {
    join: sql`left join jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      as smart(id text, updated_at timestamp, item_count int)
      on smart.id = lp.id and smart.updated_at = lp.updated_at`,
    count,
    where: libraryDirectoryFilter(
      query,
      library,
      libraryCountColumn(count),
      viewText ? sql`smart.id is not null` : undefined,
    ),
  }
}

const DirectoryRowsSchema = z.array(
  z.object({
    origin: z.enum(['imported', 'library']),
    id: z.string(),
    name: z.string(),
    library: LibraryPlaylistLibrarySchema.nullable(),
    type: LibraryPlaylistTypeSchema,
    view: LibraryPlaylistViewSchema.nullable(),
    created_at: z.string().nullable(),
    updated_at: z.string().nullable(),
    entry_count: z.number().int().nullable(),
  }),
)
type DirectoryRow = z.infer<typeof DirectoryRowsSchema>[number]

function librarySummary(
  row: DirectoryRow,
  library: LibraryPlaylistLibrary,
): PlaylistSummary {
  return PlaylistSummarySchema.parse({
    id: row.id,
    inLibrary: true,
    name: row.name,
    source: null,
    ownerName: null,
    description: null,
    artworkUrl: null,
    spotifyUrl: null,
    importedAt: null,
    createdAt: row.created_at,
    trackCount: 0,
    linkedTrackCount: 0,
    albumCount: 0,
    presentation: library === 'albums' ? 'albums' : 'tracks',
    durationSec: 0,
    origin: 'library',
    type: row.type,
    library,
    view: row.view,
    updatedAt: row.updated_at,
    itemCount: row.entry_count,
  })
}

/**
 * PL-17: imported playlists, in Albums and Tracks, and the library's
 * playlists and smart playlists as one list, searched, sorted and paged in
 * one statement. Imported rows are hydrated as on the imported-only page.
 */
async function listDirectoryPage(
  query: PlaylistBrowseQuery,
  library: LibraryPlaylistLibrary,
) {
  if (library === 'albums') await ensureLegacySavedViews()
  const smart = await libraryDirectoryRead(query, library)
  const direction = query.direction === 'asc' ? sql`asc` : sql`desc`
  const imported = listsImportedPlaylists(library)
    ? sql`select 'imported' as origin, p.id, p.name, null as library,
        'playlist' as type, null::jsonb as view, null::timestamp as created_at,
        null::timestamp as updated_at, null::int as smart_count,
        ${importedSortColumn(query)} as sort_value
      from playlist p
      ${importJobsJoin(query, true)}
      where ${playlistDirectoryFilter(query)}
      union all`
    : sql``
  const order = sql`order by sort_value ${direction} nulls last, lower(name), id`
  const rows = DirectoryRowsSchema.parse(
    (
      await db.execute(sql`
    select origin, id, name, library, type, view,
      ${isoTimestamp(sql`created_at`)} as created_at,
      ${isoTimestamp(sql`updated_at`)} as updated_at,
      case when origin = 'library' and type = 'playlist' then (
        select count(*)::int from library_playlist_entry e where ${listedEntry(sql`page.id`)}
      ) else smart_count end as entry_count
    from (
      select * from (
        ${imported}
        select 'library' as origin, lp.id, lp.name, lp.library, lp.type,
          lp.view, lp.created_at, lp.updated_at, ${smart.count} as smart_count,
          ${librarySortColumn(query.sortBy, smart.count)} as sort_value
        from library_playlist lp ${smart.join}
        where ${smart.where}
      ) directory
      ${order}
      limit ${query.size + 1} offset ${(query.page - 1) * query.size}
    ) page
    ${order}
  `)
    ).rows,
  )
  const page = rows.slice(0, query.size)
  const summaries = new Map(
    (
      await loadPlaylistSummaries(
        page.flatMap((row) => (row.origin === 'imported' ? [row.id] : [])),
      )
    ).map((summary) => [summary.id, summary]),
  )
  const items = page.flatMap((row): PlaylistSummary[] => {
    if (row.origin === 'library') return [librarySummary(row, library)]
    const summary = summaries.get(row.id)
    return summary
      ? [
          {
            ...summary,
            origin: 'imported',
            type: 'playlist',
            library: null,
            view: null,
            updatedAt: summary.importedAt,
            itemCount:
              library === 'albums' ? summary.albumCount : summary.trackCount,
          },
        ]
      : []
  })
  return PlaylistBrowsePageSchema.parse({
    items,
    page: query.page,
    size: query.size,
    hasMore: rows.length > query.size,
  })
}

/** PL-17: the count of the combined directory, in one statement. */
async function countDirectory(
  query: PlaylistBrowseQuery,
  library: LibraryPlaylistLibrary,
) {
  if (library === 'albums') await ensureLegacySavedViews()
  const smart = await libraryDirectoryRead(query, library)
  const imported = listsImportedPlaylists(library)
    ? sql`(select count(*) from playlist p ${importJobsJoin(query)}
      where ${playlistDirectoryFilter(query)})`
    : sql`0`
  const [matching] = CountRowsSchema.parse(
    (
      await db.execute(sql`select ${imported} + (
        select count(*) from library_playlist lp ${smart.join}
        where ${smart.where}
      ) as count`)
    ).rows,
  )
  return { totalCount: matching?.count ?? 0 }
}

export async function listPlaylists(
  query = PlaylistBrowseQuerySchema.parse({}),
) {
  return (await listPlaylistBrowsePage(query)).items
}

export async function getPlaylistSummary(id: string) {
  const [stored] = await loadPlaylistSummaries([id])
  if (stored) return stored
  const result = await db.execute(sql`
    select target_id as id from catalog_observation
    where target_kind = 'playlist' and subject_kind = 'playlist'
      and operation = 'playlist-identity' and subject_id = ${id} limit 1`)
  const alias = z.object({ id: z.string() }).safeParse(result.rows[0]).data
  const [summary] = await loadPlaylistSummaries(alias ? [alias.id] : [])
  if (!summary)
    throw new ServerError({ statusCode: 404, message: 'Playlist not found' })
  return summary
}

export async function updatePlaylistPresentation(
  id: string,
  presentation: PlaylistPresentation | null,
) {
  const { rows } = await db.execute(sql`
    update playlist p set presentation_override = ${presentation}, updated_at = now()
    where p.id = ${id} and ${visiblePlaylists}
    returning p.id
  `)
  if (!rows.length)
    throw new ServerError({ statusCode: 404, message: 'Playlist not found' })
  return getPlaylistSummary(id)
}
