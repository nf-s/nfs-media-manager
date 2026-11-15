import { sql, type SQL } from 'drizzle-orm'
import {
  trackSourceLabels,
  trackSpotifyMatchLabels,
} from '@repo/schemas/tracks'

/** Current library membership, independent of a recording's listening matches. */
export function trackSourcesExpression(id: SQL, labels = false) {
  return sql`coalesce((select jsonb_agg(s.value order by s.value) from (
    select distinct case p.source
      when 'spotify' then ${labels ? trackSourceLabels.spotify : 'spotify'}::text
      when 'spotify-liked' then ${labels ? trackSourceLabels['spotify-liked'] : 'spotify-liked'}::text
      end as value
    from playlist_item pi join playlist p on p.id = pi.playlist_id
    where pi.media_item_id = ${id} and p.source in ('spotify', 'spotify-liked')
    union
    select ${labels ? trackSourceLabels.album : 'album'}::text
    where exists (select 1 from track t where t.track_media_item_id = ${id})
    union
    select ${labels ? trackSourceLabels.lastfm : 'lastfm'}::text
    where exists (select 1 from lastfm_track_source s where s.track_media_item_id = ${id})
  ) s), '[]'::jsonb)`
}

export function albumTrackDurationExpression(trackId: SQL, albumId: SQL) {
  return sql`(select t.duration_sec from track t
    where t.track_media_item_id = ${trackId} and t.duration_sec is not null
    order by (t.album_media_item_id = ${albumId}) desc nulls last, t.album_media_item_id, t.position
    limit 1)`
}

export function trackSpotifyMatchExpression(
  storedId: SQL,
  sourceLabel: SQL,
  labels = false,
) {
  return sql`case
    when ${storedId} is null then ${labels ? trackSpotifyMatchLabels.unmatched : 'unmatched'}::text
    when ${sourceLabel} = 'spotify' then ${labels ? trackSpotifyMatchLabels['spotify-import'] : 'spotify-import'}::text
    else ${labels ? trackSpotifyMatchLabels['album-track-list'] : 'album-track-list'}::text end`
}
