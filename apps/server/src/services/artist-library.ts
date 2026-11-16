import { sql, type SQLWrapper } from 'drizzle-orm'
import { db } from '@/lib/db'
import { playlist } from '@/schemas/db'

// Match the playlists accessible from the existing playlist workspace.
export const visiblePlaylist = sql`${playlist.kind} = 'playlist' and (
  ${playlist.source} is not null or exists (
    select 1 from playlist_item member
    left join album a on a.media_item_id = member.media_item_id
    left join library_track t on t.media_item_id = member.media_item_id
    where member.playlist_id = ${playlist.id}
      and (a.media_item_id is not null or t.album_media_item_id is not null
        or exists (select 1 from track entry where entry.track_media_item_id = member.media_item_id))
  )
)`

export function artistPlaylistCredits(artistId?: string | SQLWrapper) {
  const selectedArtist =
    artistId === undefined ? sql`` : sql`and credit.artist_id = ${artistId}`
  return sql`
    select credit.artist_id, member.playlist_id, recording.media_item_id, 'track' as kind
    from media_credit credit
    join library_track recording on recording.media_item_id = credit.media_item_id
    join media_item item on item.id = recording.media_item_id
    join playlist_item member on member.media_item_id = recording.media_item_id
    where credit.role = 'artist' ${selectedArtist}
      and item.media_type = 'track' and item.metadata->>'legacyHidden' is distinct from 'true'
    union all
    select credit.artist_id, member.playlist_id, release.media_item_id, 'album' as kind
    from media_credit credit
    join album release on release.media_item_id = credit.media_item_id
    join media_item item on item.id = release.media_item_id
    join (
      select media_item_id as album_id, media_item_id from album
      union all
      select album_media_item_id as album_id, media_item_id from library_track
      where album_media_item_id is not null
      union all
      select album_media_item_id as album_id, track_media_item_id as media_item_id from track
      where track_media_item_id is not null
    ) related on related.album_id = release.media_item_id
    join playlist_item member on member.media_item_id = related.media_item_id
    join media_item linked_item on linked_item.id = member.media_item_id
    where credit.role = 'artist' ${selectedArtist}
      and item.media_type = 'album' and item.metadata->>'legacyHidden' is distinct from 'true'
      and linked_item.metadata->>'legacyHidden' is distinct from 'true'`
}

export function artistPlaylistMembership(artistId: string | SQLWrapper) {
  return db
    .select({
      id: playlist.id,
      name: playlist.name,
      artworkUrl: playlist.artworkUrl,
      spotifyUrl: playlist.spotifyUrl,
      createdAt: playlist.createdAt,
      albumCount:
        sql<number>`count(distinct memberships.media_item_id) filter (where memberships.kind = 'album')::int`.as(
          'album_count',
        ),
      trackCount:
        sql<number>`count(distinct memberships.media_item_id) filter (where memberships.kind = 'track')::int`.as(
          'track_count',
        ),
    })
    .from(playlist)
    .innerJoin(
      sql`(${artistPlaylistCredits(artistId)}) as memberships`,
      sql`memberships.playlist_id = ${playlist.id}`,
    )
    .where(visiblePlaylist)
    .groupBy(playlist.id)
}

export function artistArtwork(id: SQLWrapper) {
  return sql<string | null>`(
    select s.normalized_data->>'artworkUrl'
    from artist_provider_current_state state
    join artist_provider_snapshot s on s.id = state.latest_snapshot_id
    where state.artist_id = ${id} and s.normalized_data->>'artworkUrl' is not null
    order by s.created_at desc, s.id desc limit 1
  )`
}

export function artistPlaylistCount(id: SQLWrapper) {
  return sql<number>`(select count(*)::int from (${artistPlaylistMembership(id)}) memberships)`
}

/** Sorting by playlist count needs every count, so build them in one pass. */
export function artistPlaylistCounts() {
  const artistId = sql<string>`memberships.artist_id`
  return db
    .select({
      artistId: artistId.as('artist_id'),
      count: sql<number>`count(distinct ${playlist.id})::int`.as(
        'playlist_count',
      ),
    })
    .from(sql`(${artistPlaylistCredits()}) memberships`)
    .innerJoin(playlist, sql`${playlist.id} = memberships.playlist_id`)
    .where(visiblePlaylist)
    .groupBy(artistId)
}
