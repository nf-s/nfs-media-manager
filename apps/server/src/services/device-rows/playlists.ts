import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { SPOTIFY_PLAYLIST_IMPORT_TASK } from '@repo/schemas/tracks'
import { db } from '@/lib/db'
import {
  loadPlaylistSummaries,
  playlistGroup,
  playlistMember,
  playlistSortColumns,
  playlistTrackStats,
  visiblePlaylists,
} from '../playlist-directory'
import { latestSpotifyJobs } from '../spotify-playlist-state'
import {
  anyId,
  epochMicroseconds,
  idAfter,
  isJsonObject,
  readProjection,
  toJson,
  type JsonObject,
} from './projection'

/**
 * Playlist rows (the directory summary without its job) and the latest
 * import job of each sync group.
 */

const IdRowsSchema = z.array(z.object({ id: z.string() }))

const publishedPlaylist = sql`${visiblePlaylists} and ${playlistMember}`

export async function listPlaylistIds(afterId: string | null, limit: number) {
  const result = await db.execute(sql`select p.id from playlist p
    where ${publishedPlaylist} and ${idAfter(sql`p.id`, afterId)}
    order by p.id limit ${limit}`)
  return IdRowsSchema.parse(result.rows).map((row) => row.id)
}

const texts = (value: SQL) => sql`to_jsonb(array_remove(array[${value}], null))`

export async function renderPlaylists(
  ids: string[],
): Promise<Map<string, JsonObject>> {
  const batch = anyId(ids)
  const columns = playlistSortColumns
  const [projections, items] = await Promise.all([
    readProjection(
      {
        id: sql`p.id`,
        // The sort values as they are with no import job; the track
        // statistics of playlistSortColumns, read once per playlist.
        from: sql`from playlist p cross join (select null::text as status) job
          cross join lateral (${playlistTrackStats}) stats`,
        where: sql`p.id = ${batch} and ${publishedPlaylist}`,
        scalars: [
          ['search.name', texts(sql`p.name`)],
          ['search.owner', texts(sql`p.owner_name`)],
          ['search.description', texts(sql`p.description`)],
          ['num.tracks', sql`stats.track_count`],
          ['num.linkedTracks', sql`stats.linked_track_count`],
          ['num.albums', columns.albums],
          ['num.duration', sql`stats.duration_sec`],
          ['num.imported', epochMicroseconds(columns.imported)],
          ['num.checked', epochMicroseconds(columns.checked)],
          ['num.added', epochMicroseconds(columns.added)],
          ['sort.name', columns.name],
          ['sort.source', columns.source],
          ['sort.owner', columns.owner],
          ['sort.description', columns.description],
          ['sort.schedule', columns.schedule],
          ['sort.nextSync', epochMicroseconds(columns.nextSync)],
          ['extra.source', sql`coalesce(p.source, 'library')`],
          ['extra.syncGroupKey', playlistGroup],
        ],
        parts: [],
      },
      () => ({ text: {} }),
    ),
    loadPlaylistSummaries(ids, new Map()),
  ])
  const payloads = new Map<string, JsonObject>()
  for (const item of items) {
    const projection = projections.get(item.id)
    if (projection) payloads.set(item.id, { ...projection, item: toJson(item) })
  }
  return payloads
}

const playlistImportJobs = sql`scrape_job j
  where j.provider = 'spotify' and j.options->>'task' = ${SPOTIFY_PLAYLIST_IMPORT_TASK}
    and j.options->>'groupKey' is not null`

export async function listPlaylistJobIds(
  afterId: string | null,
  limit: number,
) {
  const result = await db.execute(sql`select id from (
      select distinct j.options->>'groupKey' as id from ${playlistImportJobs}
    ) groups where ${idAfter(sql`id`, afterId)}
    order by id limit ${limit}`)
  return IdRowsSchema.parse(result.rows).map((row) => row.id)
}

/** A queued or running job carries its status only, so progress writes leave the row alone. */
export async function renderPlaylistJobs(
  ids: string[],
): Promise<Map<string, JsonObject>> {
  const jobs = await latestSpotifyJobs(SPOTIFY_PLAYLIST_IMPORT_TASK, ids)
  const payloads = new Map<string, JsonObject>()
  for (const [key, { job }] of jobs) {
    const active = job.status === 'queued' || job.status === 'running'
    const row = toJson(
      active ? { ...job, progress: null, activity: null } : job,
    )
    if (isJsonObject(row)) payloads.set(key, row)
  }
  return payloads
}
