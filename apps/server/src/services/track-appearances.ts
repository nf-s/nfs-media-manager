import { sql } from 'drizzle-orm'
import {
  TrackAppearancesSchema,
  type TrackAppearances,
} from '@repo/schemas/catalog'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { spotifyAlbumReleaseIds } from './album-library-tracks'

/** Current memberships and retained provider relationships for a recording. */
export async function listTrackAppearances(
  id: string,
): Promise<TrackAppearances> {
  const { rows } = await db.execute(sql`
    with subject as materialized (
      select lt.media_item_id, lt.spotify_album_id
      from library_track lt
      join media_item m on m.id = lt.media_item_id and m.media_type = 'track'
      where m.id = coalesce(
        (select media_item_id from catalog_media_alias where alias_id = ${id}),
        ${id}::text
      )
    ), addresses as materialized (
      select media_item_id as id from subject
      union all
      select a.alias_id from catalog_media_alias a
      join subject s on s.media_item_id = a.media_item_id
    ), album_links as (
      select lt.album_media_item_id as id
      from addresses a join library_track lt on lt.media_item_id = a.id
      where lt.album_link_strategy in ('album-track-list', 'spotify-track', 'spotify-album')
      union
      select t.album_media_item_id from addresses a
      join track t on t.track_media_item_id = a.id
      union
      select o.media_item_id from addresses a
      join catalog_observation o on o.subject_id = a.id
      where o.subject_kind = 'track' and o.target_kind = 'album'
        and ((o.provider = 'spotify' and o.operation = 'parent-reference' and o.relationship_role = 'album')
          or (o.provider = 'tidal' and o.operation = 'similar' and o.relationship_role = 'release'))
      union
      select o.subject_id from subject s
      join catalog_observation o on o.media_item_id = s.media_item_id
      where o.target_kind = 'track' and o.subject_kind = 'album'
        and o.operation in ('provider-result', 'import') and o.relationship_role = 'track_on_edition'
    ), albums as (
      select distinct m.id, m.title
      from album_links l
      left join catalog_media_alias a on a.alias_id = l.id
      join media_item m on m.id = coalesce(a.media_item_id, l.id)
      where m.media_type = 'album' and m.metadata->>'legacyHidden' is distinct from 'true'
    ), playlist_candidates as (
      select p.playlist_id as id, null::text as version, true as legacy
      from addresses a join playlist_item p on p.media_item_id = a.id
      union
      select o.subject_id, o.details->>'version', false
      from subject s join catalog_observation o on o.media_item_id = s.media_item_id
      where o.target_kind = 'track' and o.subject_kind = 'playlist'
        and o.operation = 'playlist-contents' and o.relationship_role = 'playlist_entry'
        and o.position is not null
    ), playlists as (
      select distinct p.id, p.name as title from playlist_candidates candidate
      join playlist p on p.id = candidate.id and p.kind = 'playlist'
      left join lateral (
        select details->>'version' as version, true as complete
        from catalog_observation
        where target_kind = 'playlist' and target_id = p.id
          and operation = 'playlist-contents' and details->'complete' = 'true'::jsonb
        order by observed_at desc, id desc limit 1
      ) latest on true
      where (candidate.legacy and latest.complete is null) or candidate.version = latest.version
    ), similar_seeds as (
      select distinct o.subject_id as id
      from subject s join catalog_observation o on o.media_item_id = s.media_item_id
      where o.target_kind = 'track' and o.subject_kind = 'track'
        and o.operation = 'similar' and o.provider = 'tidal'
    ), similar_tracks as (
      select distinct m.id, m.title
      from similar_seeds s
      left join catalog_media_alias a on a.alias_id = s.id
      join media_item m on m.id = coalesce(a.media_item_id, s.id)
      where m.media_type = 'track' and m.metadata->>'legacyHidden' is distinct from 'true'
        and m.id <> (select media_item_id from subject)
    ), appearances as (
      select 'album' as kind, m.id, m.title, 'album' as relationship, release.spotify_id
      from albums m
      left join lateral (
        select r.spotify_id from (${spotifyAlbumReleaseIds(sql`m.id`)}) r
        where r.spotify_id ~ '^[A-Za-z0-9]{22}$'
        order by (r.spotify_id = (select spotify_album_id from subject)) desc nulls last, r.spotify_id
        limit 1
      ) release on true
      union all
      select 'playlist', id, title, 'playlist', null from playlists
      union all
      select 'track', id, title, 'similar', null from similar_tracks
    )
    select coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'kind', kind, 'id', id, 'title', title, 'relationship', relationship, 'spotifyAlbumId', spotify_id
      )) order by kind, lower(title), id) from appearances
    ), '[]'::jsonb) as items from subject
  `)
  const result = rows[0]
  if (!result)
    throw new ServerError({ statusCode: 404, message: 'Track not found' })
  return TrackAppearancesSchema.parse(result)
}
