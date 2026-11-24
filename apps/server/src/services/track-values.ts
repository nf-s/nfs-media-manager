import { sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import {
  trackSourceLabels,
  trackSpotifyMatchLabels,
} from '@repo/schemas/tracks'
import { libraryTrack, mediaItem } from '@/schemas/db'

const lastfmPlaceholderSources = sql`from lastfm_track_source s
  join library_track placeholder on placeholder.media_item_id = s.track_media_item_id
  join media_item mi on mi.id = s.track_media_item_id`

function lastfmPlaceholder(
  {
    id,
    lastfm,
    spotifyTrackId,
    albumId,
    albumName,
  }: {
    id: SQLWrapper
    lastfm: SQL
    spotifyTrackId: SQLWrapper
    albumId: SQLWrapper
    albumName: SQLWrapper
  },
  bulk = false,
) {
  const inTrackList = bulk
    ? sql`coalesce(${id} in (select track_media_item_id from track), false)`
    : sql`exists (select 1 from track t where t.track_media_item_id = ${id})`
  const inPlaylist = bulk
    ? sql`coalesce(${id} in (select media_item_id from playlist_item), false)`
    : sql`exists (select 1 from playlist_item pi where pi.media_item_id = ${id})`
  return sql`${lastfm} and ${spotifyTrackId} is null
    and ${albumId} is null and nullif(trim(${albumName}), '') is null
    and not (${inTrackList}) and not (${inPlaylist})`
}

const placeholderColumns = {
  id: sql`mi.id`,
  spotifyTrackId: sql`placeholder.spotify_track_id`,
  albumId: sql`placeholder.album_media_item_id`,
  albumName: sql`placeholder.album_name`,
}
const lastfmPlaceholderOnly = lastfmPlaceholder({
  ...placeholderColumns,
  lastfm: sql`mi.source_label = 'lastfm'`,
})

const linkedTrackIsPlayable = sql`pm.metadata->>'legacyHidden' is distinct from 'true'
  and pm.in_library
  and (peer.spotify_track_id is not null or exists (
    select 1 from track t where t.track_media_item_id = peer.media_item_id))`

const exactPlayableTrackLinks = sql`from lastfm_track_link l
  join library_track peer on peer.media_item_id = l.track_media_item_id
  join media_item pm on pm.id = peer.media_item_id`

const hasExactPlayablePeer = sql`exists (
  select 1 ${exactPlayableTrackLinks}
  where l.username = s.username and l.artist_key = s.artist_key and l.track_key = s.track_key
    and l.strategy = 'exact' and ${linkedTrackIsPlayable}
  offset 0
)`

const lastfmSourceProbeLimit = 1024
export const manyLastfmTrackSources = sql`exists (
  select 1 from lastfm_track_source offset ${lastfmSourceProbeLimit} limit 1
)`

/** The title walk already has the library track and its media item. */
export const trackTitleVisibility = sql`case when ${lastfmPlaceholder({
  id: mediaItem.id,
  lastfm: sql`${mediaItem.sourceLabel} = 'lastfm'`,
  spotifyTrackId: libraryTrack.spotifyTrackId,
  albumId: libraryTrack.albumMediaItemId,
  albumName: libraryTrack.albumName,
})} then not exists (
  select 1 from lastfm_track_source s where s.track_media_item_id = ${mediaItem.id}
  group by s.track_media_item_id
  having bool_and(case when s.manually_matched then false else ${hasExactPlayablePeer} end)
) else true end`

/** Source rows retained for match review whose history already appears in Browse. */
export function redundantLastfmTrackIds(id?: SQL, { denseSets = false } = {}) {
  if (id)
    return sql`
      select s.track_media_item_id as id
      ${lastfmPlaceholderSources}
      left join (
        select l.username, l.artist_key, l.track_key ${exactPlayableTrackLinks}
        where l.strategy = 'exact' and ${linkedTrackIsPlayable}
      ) matched using (username, artist_key, track_key)
      where s.track_media_item_id = ${id} and ${lastfmPlaceholderOnly}
      group by s.track_media_item_id
      having bool_and(not s.manually_matched and matched.track_key is not null)`

  // The source primary key makes each listener/artist/track name unique.
  // Sparse scopes can stop at the first playable peer; dense scopes check
  // matching links together after restricting them to eligible names.
  const sparseSources = sql`
      select s.track_media_item_id, s.username, s.artist_key, s.track_key, s.manually_matched
      ${lastfmPlaceholderSources} where ${lastfmPlaceholderOnly}`
  // Facet aggregation consumes the complete visibility set. Check the
  // constituent IDs together when the source relation is large.
  const sources = denseSets
    ? sql`${sparseSources} and not (select many from source_scope)
      union all
      select s.track_media_item_id, s.username, s.artist_key, s.track_key, s.manually_matched
      from lastfm_track_source s where (select many from source_scope)
        and coalesce(s.track_media_item_id in (
          select placeholder.media_item_id from library_track placeholder
          where ${lastfmPlaceholder(
            {
              ...placeholderColumns,
              id: sql`placeholder.media_item_id`,
              lastfm: sql`coalesce(placeholder.media_item_id in (
              select id from media_item where source_label = 'lastfm'
            ), false)`,
            },
            true,
          )}
        ), false)`
    : sparseSources
  const sourceScope = denseSets
    ? sql`source_scope as materialized (
        select ${manyLastfmTrackSources} as many
      ),`
    : sql``
  const wantedLinks = denseSets
    ? sql`from lastfm_track_link l
      where not (select bounded from probe_names) and l.strategy = 'exact'
        and coalesce((l.username, l.artist_key, l.track_key) in (
          select s.username, s.artist_key, s.track_key from placeholder_sources s
          where not s.manually_matched
        ), false)`
    : sql`from placeholder_sources s
      join lastfm_track_link l using (username, artist_key, track_key)
      where not (select bounded from probe_names) and not s.manually_matched
        and l.strategy = 'exact'`
  const playableLinks = denseSets
    ? sql`where coalesce(l.track_media_item_id in (
        select peer.media_item_id from library_track peer
        join media_item pm on pm.id = peer.media_item_id
        where ${linkedTrackIsPlayable}
      ), false)`
    : sql`join library_track peer on peer.media_item_id = l.track_media_item_id
      join media_item pm on pm.id = peer.media_item_id
      where ${linkedTrackIsPlayable}`
  return sql`with ${sourceScope}
    placeholder_sources as materialized (${sources}),
    probe_names as materialized (
      select count(*) <= ${lastfmSourceProbeLimit} as bounded from placeholder_sources
    ),
    wanted_links as materialized (
      select l.username, l.artist_key, l.track_key, l.track_media_item_id
      ${wantedLinks}
    ),
    matched_names as (
      select distinct l.username, l.artist_key, l.track_key
      from wanted_links l
      ${playableLinks}
    )
    select s.track_media_item_id as id from placeholder_sources s
    group by s.track_media_item_id
    having bool_and(case
      when s.manually_matched then false
      when (select bounded from probe_names) then ${hasExactPlayablePeer}
      else (s.username, s.artist_key, s.track_key) in (
        select username, artist_key, track_key from matched_names
      )
    end)`
}

/** Current library membership, independent of a recording's listening matches. */
export function trackSourcesExpression(id: SQL, metadata: SQL, labels = false) {
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
    union
    select ${labels ? trackSourceLabels['spotify-search'] : 'spotify-search'}::text
    where ${metadata} ? 'spotifyTrackSearch'
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
    when ${sourceLabel} = 'spotify-search' then ${labels ? trackSpotifyMatchLabels['spotify-search'] : 'spotify-search'}::text
    else ${labels ? trackSpotifyMatchLabels['album-track-list'] : 'album-track-list'}::text end`
}

// A provider knows a track when it has given the track an ID of its own. An
// ISRC a provider reported is a fact about the recording, not such an ID.
const trackProviderReferences = sql`from provider_reference r
  where r.reference_type <> 'isrc'`

/**
 * The providers that know a track: each provider with an ID for it, and
 * Spotify when the track has a Spotify track ID, which the track itself holds.
 */
export function trackProvidersExpression(id: SQL, spotifyTrackId: SQL) {
  return sql`coalesce((select jsonb_agg(p.value order by p.value) from (
    select r.provider as value ${trackProviderReferences} and r.media_item_id = ${id}
    union
    select 'spotify'::text where ${spotifyTrackId} is not null
  ) p), '[]'::jsonb)`
}

/** Browse values for suggestions and sorting: a row per track and provider. */
export function trackProviderRows(visible: SQL) {
  return sql`select media_item.id, r.provider as value from media_item
      join provider_reference r on r.media_item_id = media_item.id
      where ${visible} and r.reference_type <> 'isrc'
    union all
    select media_item.id, 'spotify'::text as value from media_item
      join library_track lt on lt.media_item_id = media_item.id
      where ${visible} and lt.spotify_track_id is not null`
}

/** The tracks one provider knows, as one set of IDs. */
export function trackIdsWithProvider(provider: string) {
  const name = provider.toLowerCase()
  const referenced = sql`select r.media_item_id ${trackProviderReferences}
    and lower(r.provider) = ${name}`
  return name === 'spotify'
    ? sql`${referenced} union all
      select lt.media_item_id from library_track lt where lt.spotify_track_id is not null`
    : referenced
}
