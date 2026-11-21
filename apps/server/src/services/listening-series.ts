import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  LISTENING_SERIES_DAYS,
  ListeningSeriesSchema,
  type ListeningSeries,
} from '@repo/schemas/lastfm'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { requireCreator } from './creators'
import { getPlaylistSummary } from './playlist-directory'

const DAY_MS = 86400000

const SeriesRowsSchema = z
  .array(
    z.object({
      total: z.coerce.number(),
      first_date: z.string().nullable(),
      last_date: z.string().nullable(),
      history_from: z.string().nullable(),
      days: z.array(z.object({ date: z.string(), count: z.number() })),
      months: z.array(z.object({ month: z.string(), count: z.number() })),
    }),
  )
  .length(1)

const isoDate = (time: number) => new Date(time).toISOString().slice(0, 10)

/**
 * UTC date of the earliest stored scrobble of anything, linked or not. Every
 * listening chart and sparkline starts here, so they all cover one period.
 * It steps through the listeners and takes each one's first scrobble, both
 * from the listener and time index; a plain minimum reads every scrobble.
 */
export const listeningHistoryStart = sql`(
  with recursive listeners as (
    (select username from lastfm_scrobble order by username limit 1)
    union all
    select (
      select s.username from lastfm_scrobble s
      where s.username > listeners.username order by s.username limit 1
    ) from listeners where listeners.username is not null
  )
  select to_char(min((
    select min(s.listened_at) from lastfm_scrobble s
    where s.username = listeners.username
  )), 'YYYY-MM-DD')
  from listeners where listeners.username is not null
)`

/**
 * Counts the scrobbles `linked` selects, one `listened_at` row per scrobble.
 * Months use the same UTC bucketing as the album and track listening reports.
 */
async function listeningSeries(
  linked: SQL,
  now: Date,
): Promise<ListeningSeries> {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  )
  const daysFrom = isoDate(today - (LISTENING_SERIES_DAYS - 1) * DAY_MS)
  const daysTo = isoDate(today)
  const dayAfter = isoDate(today + DAY_MS)
  const [row] = SeriesRowsSchema.parse(
    (
      await db.execute(sql`
        with linked as materialized (${linked})
        select
          (select count(*) from linked) as total,
          (select to_char(min(listened_at), 'YYYY-MM-DD') from linked) as first_date,
          (select to_char(max(listened_at), 'YYYY-MM-DD') from linked) as last_date,
          ${listeningHistoryStart} as history_from,
          coalesce((
            select json_agg(json_build_object('date', day, 'count', count) order by day)
            from (
              select to_char(listened_at, 'YYYY-MM-DD') as day, count(*)::int as count
              from linked
              where listened_at >= ${daysFrom}::timestamp
                and listened_at < ${dayAfter}::timestamp
              group by 1
            ) days
          ), '[]'::json) as days,
          coalesce((
            select json_agg(json_build_object('month', month, 'count', count) order by month)
            from (
              select to_char(date_trunc('month', listened_at), 'YYYY-MM') as month,
                count(*)::int as count
              from linked group by 1
            ) months
          ), '[]'::json) as months`)
    ).rows,
  )
  return ListeningSeriesSchema.parse({
    total: row?.total ?? 0,
    firstDate: row?.first_date ?? null,
    lastDate: row?.last_date ?? null,
    historyFrom: row?.history_from ?? null,
    daysFrom,
    daysTo,
    days: row?.days ?? [],
    months: row?.months ?? [],
  })
}

async function requireMediaItem(
  id: string,
  mediaType: 'album' | 'track',
  message: string,
) {
  const found = await db.execute(
    sql`select 1 from media_item where id = ${id} and media_type = ${mediaType}`,
  )
  if (!found.rows.length) throw new ServerError({ statusCode: 404, message })
}

// The same link as the album listening report: scrobbled names linked to the album.
export async function getAlbumListeningSeries(id: string, now = new Date()) {
  await requireMediaItem(id, 'album', 'Album not found')
  return listeningSeries(
    sql`select listened_at from lastfm_scrobble where album_media_item_id = ${id}`,
    now,
  )
}

// The same link as track details: scrobbled names counted towards the track.
export async function getTrackListeningSeries(id: string, now = new Date()) {
  await requireMediaItem(id, 'track', 'Track not found')
  return listeningSeries(
    sql`select s.listened_at from lastfm_track_link l
      join lastfm_scrobble s on s.username = l.username
        and s.artist_key = l.artist_key and s.track_key = l.track_key
      where l.track_media_item_id = ${id}`,
    now,
  )
}

/**
 * An artist's listening is every scrobble linked to a library album or
 * library track credited to the artist, counted once. These are the albums
 * and tracks the artist page lists; scrobbled artist names are not matched
 * directly, so unlinked scrobbles do not count.
 */
export async function getArtistListeningSeries(
  requestedId: string,
  now = new Date(),
) {
  const id = await requireCreator(requestedId, 'artist')
  const credited = sql`from media_credit c
    join media_item m on m.id = c.media_item_id
    where c.artist_id = ${id} and c.role = 'artist'
      and m.metadata->>'legacyHidden' is distinct from 'true'`
  return listeningSeries(
    sql`select listened_at from (
      select s.id, s.listened_at from lastfm_scrobble s
      where s.album_media_item_id = any(array(
        select c.media_item_id ${credited} and m.media_type = 'album'))
      union
      select s.id, s.listened_at from lastfm_track_link l
      join lastfm_scrobble s on s.username = l.username
        and s.artist_key = l.artist_key and s.track_key = l.track_key
      where l.track_media_item_id = any(array(
        select c.media_item_id ${credited} and m.media_type = 'track'))
    ) linked`,
    now,
  )
}

/**
 * A playlist's listening is every scrobble linked to one of its track
 * entries, as on track details, plus for an album entry every scrobble
 * linked to that album, counted once. A track entry does not bring in the
 * rest of its album.
 */
export async function getPlaylistListeningSeries(id: string, now = new Date()) {
  await getPlaylistSummary(id)
  // An array keeps the entry lookups on the scrobble and link indexes.
  const entries = sql`select media_item_id from playlist_item where playlist_id = ${id}`
  return listeningSeries(
    sql`select listened_at from (
      select s.id, s.listened_at from lastfm_track_link l
      join lastfm_scrobble s on s.username = l.username
        and s.artist_key = l.artist_key and s.track_key = l.track_key
      where l.track_media_item_id = any(array(${entries}))
      union
      select s.id, s.listened_at from lastfm_scrobble s
      where s.album_media_item_id = any(array(${entries}))
    ) linked`,
    now,
  )
}
