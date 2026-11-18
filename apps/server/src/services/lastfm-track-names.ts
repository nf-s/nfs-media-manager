import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type {
  TrackScrobbleNamesPage,
  TrackScrobbleNamesQuery,
  TrackScrobbledName,
} from '@repo/schemas/tracks'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { albumNameKey } from '@/lib/album-import-candidates'
import { standaloneLastfmTrackId } from '@/lib/track-matching'

const LastfmTrackNameRowsSchema = z.array(
  z.object({
    username: z.string(),
    track_id: z.string(),
    artist_key: z.string(),
    track_key: z.string(),
    artist_name: z.string(),
    track_name: z.string(),
    album_names: z.array(z.string()),
    count: z.coerce.number().int().positive(),
    manually_matched: z.boolean(),
  }),
)
const CountRowsSchema = z.array(z.object({ count: z.coerce.number() }))
const recordedScrobbles = sql`
  join lastfm_scrobble s on s.username = l.username
    and s.artist_key = l.artist_key and s.track_key = l.track_key`
const nameColumns = sql`
  l.username, l.artist_key, l.track_key, l.track_media_item_id as track_id,
  count(*) as count, l.manually_matched,
  coalesce(array_agg(distinct s.album_name order by s.album_name)
    filter (where nullif(trim(s.album_name), '') is not null), '{}') as album_names`

function readNames(rows: unknown): TrackScrobbledName[] {
  return LastfmTrackNameRowsSchema.parse(rows).map((row) => ({
    trackId: row.track_id,
    artistKey: row.artist_key,
    trackKey: row.track_key,
    artistName: row.artist_name,
    trackName: row.track_name,
    albumNames: row.album_names,
    count: row.count,
    manuallyMatched: row.manually_matched,
    keptSeparate:
      row.manually_matched &&
      row.track_id ===
        standaloneLastfmTrackId(row.username, {
          artistKey: row.artist_key,
          trackKey: row.track_key,
        }),
  }))
}

/** Returns the recorded spelling variants that belong to this track. */
export async function getLastfmTrackNames(trackId: string) {
  const { rows } = await db.execute(sql`
    select ${nameColumns}, s.artist_name, s.track_name
    from lastfm_track_source l ${recordedScrobbles}
    where l.track_media_item_id = ${trackId}
    group by l.username, l.artist_key, l.track_key, s.artist_name, s.track_name
    order by count(*) desc, s.artist_name, s.track_name, l.username limit 50`)
  return readNames(rows)
}

/** Searches imported name groups and identifies their current library track. */
export async function listLastfmTrackNames(
  trackId: string,
  { q, page, size }: TrackScrobbleNamesQuery,
): Promise<TrackScrobbleNamesPage> {
  const visibleTrack = await db.execute(sql`
    select 1 from library_track lt join media_item mi on mi.id = lt.media_item_id
    where lt.media_item_id = ${trackId}
      and mi.metadata->>'legacyHidden' is distinct from 'true'`)
  if (!visibleTrack.rows.length)
    throw new ServerError({ statusCode: 404, message: 'Track not found.' })

  const words = q ? albumNameKey(q).split(' ').filter(Boolean) : []
  const filter = sql`where mi.metadata->>'legacyHidden' is distinct from 'true' ${sql.join(
    words.map(
      (word) =>
        sql`and strpos(l.artist_key || ' ' || l.track_key, ${word}) > 0`,
    ),
    sql` `,
  )}`
  const existing = sql`
    from lastfm_track_source l
    join media_item mi on mi.id = l.track_media_item_id
    ${filter}
      and exists (
        select 1 from lastfm_scrobble s where s.username = l.username
          and s.artist_key = l.artist_key and s.track_key = l.track_key)`
  const [countResult, rowsResult] = await Promise.all([
    db.execute(sql`select count(*) as count ${existing}`),
    db.execute(sql`
      with selected as (
        select l.username, l.artist_key, l.track_key, l.track_media_item_id, l.manually_matched
        ${existing}
        order by l.artist_key, l.track_key, l.username
        limit ${size} offset ${(page - 1) * size}
      )
      select ${nameColumns},
        (array_agg(s.artist_name order by s.listened_at desc, s.id))[1] as artist_name,
        (array_agg(s.track_name order by s.listened_at desc, s.id))[1] as track_name
      from selected l ${recordedScrobbles}
      group by l.username, l.artist_key, l.track_key, l.track_media_item_id, l.manually_matched
      order by l.artist_key, l.track_key, l.username`),
  ])
  const totalCount = CountRowsSchema.parse(countResult.rows)[0]?.count ?? 0
  return {
    page,
    size,
    totalCount,
    pageCount: Math.ceil(totalCount / size),
    items: readNames(rowsResult.rows),
  }
}
