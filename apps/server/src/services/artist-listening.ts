import { sql } from 'drizzle-orm'
import type { db } from '@/lib/db'

type Executor = Pick<typeof db, 'execute'>

/**
 * Stores each artist's scrobble count: every scrobble linked to a library
 * album or library track credited to the artist, counted once, as in the
 * artist's listening chart. Scrobbles are grouped by scrobbled name and album
 * link first, because every scrobble of a group has the same links; a group
 * linked through both its album and a track still counts once. Only changed
 * artists are written.
 */
export async function refreshArtistListeningTotals(database: Executor) {
  await database.execute(sql`
    with plays as materialized (
      select row_number() over () as id, named.* from (
        select username, artist_key, track_key, album_media_item_id,
          count(*)::int as plays
        from lastfm_scrobble
        group by username, artist_key, track_key, album_media_item_id
      ) named
    ), credited as materialized (
      select c.media_item_id, c.artist_id, m.media_type
      from media_credit c join media_item m on m.id = c.media_item_id
      where c.role = 'artist' and m.media_type in ('album', 'track')
        and m.metadata->>'legacyHidden' is distinct from 'true'
    ), totals as (
      select artist_id, sum(plays)::int as count from (
        select credited.artist_id, plays.id, plays.plays
        from plays join credited
          on credited.media_item_id = plays.album_media_item_id
          and credited.media_type = 'album'
        union
        select credited.artist_id, plays.id, plays.plays
        from plays join lastfm_track_link l on l.username = plays.username
          and l.artist_key = plays.artist_key and l.track_key = plays.track_key
        join credited on credited.media_item_id = l.track_media_item_id
          and credited.media_type = 'track'
      ) linked group by artist_id
    )
    update artist a set scrobble_count = coalesce(totals.count, 0)
    from artist base left join totals on totals.artist_id = base.id
    where a.id = base.id and a.scrobble_count <> coalesce(totals.count, 0)`)
}
