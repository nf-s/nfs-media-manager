import { sql, type SQL } from 'drizzle-orm'
import { trackSourceLabels } from '@repo/schemas/tracks'

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
    select ${labels ? trackSourceLabels.lastfm : 'lastfm'}::text
    where exists (select 1 from lastfm_track_source s where s.track_media_item_id = ${id})
  ) s), '[]'::jsonb)`
}

/** Only an exact, unique title on the linked album supplies recording fields. */
export function linkedTrackFieldExpression(
  field: 'external_id' | 'duration_sec',
  albumId: SQL,
  title: SQL,
) {
  const column =
    field === 'external_id' ? sql`t.external_id` : sql`t.duration_sec`
  return sql`(select case when count(*) = 1 then min(${column}) end
    from track t where t.album_media_item_id = ${albumId}
      and lower(regexp_replace(trim(t.title), '[[:space:]]+', ' ', 'g')) =
        lower(regexp_replace(trim(${title}), '[[:space:]]+', ' ', 'g')))`
}
