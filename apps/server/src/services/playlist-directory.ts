import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  PlaylistBrowsePageSchema,
  PlaylistBrowseQuerySchema,
  PlaylistSummarySchema,
  SPOTIFY_PLAYLIST_IMPORT_TASK,
  type PlaylistBrowseQuery,
  type PlaylistSummary,
} from '@repo/schemas/tracks'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { playlistScheduleMinutes } from '@/lib/playlist-sync'
import {
  latestSpotifyJobs,
  LIKED_SONGS_KEY,
  PLAYLIST_KEY_PREFIX,
  playlistSync,
  storedGroupKey,
} from './spotify-playlist-state'

const isoTimestamp = (column: SQL) =>
  sql`to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const CountRowsSchema = z.array(z.object({ count: z.coerce.number() }))

const PlaylistRowsSchema = z.array(
  z.object({
    id: z.string(),
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
    duration_sec: z.coerce.number().int(),
  }),
)

const optionalDate = (value: string | null) => (value ? new Date(value) : null)

const playlistAlbumMembers = sql`
  select pi.media_item_id as album_id from playlist_item pi
  join album a on a.media_item_id = pi.media_item_id
  where pi.playlist_id = p.id
  union all
  select lt.album_media_item_id from playlist_item pi
  join library_track lt on lt.media_item_id = pi.media_item_id
  where pi.playlist_id = p.id and lt.album_media_item_id is not null
  union all
  select t.album_media_item_id from playlist_item pi
  join track t on t.track_media_item_id = pi.media_item_id
  where pi.playlist_id = p.id
`

const playlistAlbumCount = sql`(select count(distinct album_id)::int from (${playlistAlbumMembers}) albums)`

const playlistTrackStats = sql`
  select count(*)::int as track_count,
    count(lt.album_media_item_id)::int as linked_track_count,
    coalesce(sum(lt.duration_sec), 0)::int as duration_sec
  from playlist_item pi
  join library_track lt on lt.media_item_id = pi.media_item_id
  where pi.playlist_id = p.id
`

const visiblePlaylists = sql`p.kind = 'playlist' and (p.source is not null or exists (${playlistAlbumMembers}))`
const playlistCanAcceptAdditions = sql`(p.source = 'spotify' and p.spotify_id is not null and p.spotify_editable)`
const playlistGroup = sql`case
  when p.source = 'spotify-liked' then ${LIKED_SONGS_KEY}
  when p.source = 'spotify' and nullif(p.spotify_id, '') is not null then ${PLAYLIST_KEY_PREFIX} || p.spotify_id
  end`
const playlistLastCheck = sql`coalesce(p.checked_at, p.imported_at)`
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

const playlistSortColumns = {
  name: sql`lower(p.name)`,
  // Sort by the labels used in the table: Library, Liked Songs, Spotify.
  source: sql`array_position(array['library', 'spotify-liked', 'spotify'], coalesce(p.source, 'library'))`,
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

function playlistDirectoryFilter(query: PlaylistBrowseQuery) {
  const conditions = [visiblePlaylists]
  if (query.q) {
    const pattern = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`
    conditions.push(
      sql`(p.name ilike ${pattern} or p.owner_name ilike ${pattern} or p.description ilike ${pattern})`,
    )
  }
  if (query.name) {
    const pattern = `%${query.name.replace(/[\\%_]/g, '\\$&')}%`
    conditions.push(sql`p.name ilike ${pattern}`)
  }
  if (query.sources?.length)
    conditions.push(
      sql`coalesce(p.source, 'library') in (${sql.join(
        query.sources.map((source) => sql`${source}`),
        sql`, `,
      )})`,
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
        select p.id, p.name, p.source, p.spotify_id, p.owner_name, p.description,
          p.artwork_url, p.spotify_url,
          ${isoTimestamp(sql`p.imported_at`)} as imported_at,
          ${isoTimestamp(sql`p.created_at`)} as created_at,
          ${isoTimestamp(sql`p.checked_at`)} as checked_at,
          p.sync_schedule, p.spotify_editable,
          stats.track_count, stats.linked_track_count, stats.duration_sec,
          ${playlistAlbumCount} as album_count
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
  const sort = playlistSortColumns[query.sortBy]
  const direction = query.direction === 'asc' ? sql`asc` : sql`desc`
  const rows = z.array(z.object({ id: z.string() })).parse(
    (
      await db.execute(sql`
    select p.id
    from playlist p
    ${query.sortBy === 'nextSync' ? playlistImportJobs : sql``}
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
  const [matching] = CountRowsSchema.parse(
    (
      await db.execute(sql`
    select count(*) as count from playlist p where ${playlistDirectoryFilter(query)}
  `)
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
  const [summary] = await loadPlaylistSummaries([id])
  if (!summary)
    throw new ServerError({ statusCode: 404, message: 'Playlist not found' })
  return summary
}
