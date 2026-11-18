import { sql, type SQL } from 'drizzle-orm'
import {
  trackSourceLabels,
  trackSpotifyMatchLabels,
} from '@repo/schemas/tracks'

/** Source rows retained for match review whose history already appears in Browse. */
export function redundantLastfmTrackIds(id?: SQL) {
  return sql`
  select s.track_media_item_id as id
  from lastfm_track_source s
  join library_track placeholder on placeholder.media_item_id = s.track_media_item_id
  join media_item mi on mi.id = s.track_media_item_id
  where mi.source_label = 'lastfm' and placeholder.spotify_track_id is null
    ${id ? sql`and s.track_media_item_id = ${id}` : sql``}
    and placeholder.album_media_item_id is null and nullif(trim(placeholder.album_name), '') is null
    and not exists (select 1 from track t where t.track_media_item_id = mi.id)
    and not exists (select 1 from playlist_item pi where pi.media_item_id = mi.id)
  group by s.track_media_item_id
  having bool_and(not s.manually_matched and exists (
    select 1 from lastfm_track_link l
    join library_track peer on peer.media_item_id = l.track_media_item_id
    join media_item pm on pm.id = peer.media_item_id
    where l.username = s.username and l.artist_key = s.artist_key and l.track_key = s.track_key
      and l.track_media_item_id <> s.track_media_item_id and l.strategy = 'exact'
      and pm.metadata->>'legacyHidden' is distinct from 'true'
      and (peer.spotify_track_id is not null or exists (
        select 1 from track t where t.track_media_item_id = peer.media_item_id))))`
}

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
