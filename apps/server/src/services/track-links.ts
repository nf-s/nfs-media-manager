import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  TrackAlbumLinkStrategySchema,
  TrackScrobbleLinkStrategySchema,
} from '@repo/schemas/tracks'
import { db } from '@/lib/db'
import { importLastfmLibraryTracks } from './lastfm-library-tracks'
import { spotifyAlbumId } from '@/lib/spotify-api'
import {
  createScrobbleTrackMatcher,
  createTrackAlbumMatcher,
} from '@/lib/track-matching'

const WRITE_BATCH = 1000

const AlbumRowsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    release_date: z.string().nullable(),
    spotify_url: z.string().nullable(),
    artists: z.array(z.string()),
    spotify_album_ids: z.array(z.string()),
    tracks: z.array(
      z.object({ title: z.string(), externalId: z.string().nullable() }),
    ),
  }),
)
const TrackRowsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    spotify_track_id: z.string().nullable(),
    source_label: z.string().nullable(),
    spotify_album_id: z.string().nullable(),
    album_name: z.string().nullable(),
    album_id: z.string().nullable(),
    strategy: TrackAlbumLinkStrategySchema.nullable(),
    artists: z.array(z.string()),
  }),
)
const ScrobbledRowsSchema = z.array(
  z.object({
    artist_key: z.string(),
    track_key: z.string(),
    artist_name: z.string(),
    track_name: z.string(),
    album_ids: z.array(z.string()),
  }),
)
const LinkRowsSchema = z.array(
  z.object({
    artist_key: z.string(),
    track_key: z.string(),
    track_id: z.string(),
    strategy: TrackScrobbleLinkStrategySchema,
  }),
)

async function libraryTracks() {
  return TrackRowsSchema.parse(
    (
      await db.execute(sql`
        select lt.media_item_id as id, mi.title, mi.source_label, lt.spotify_track_id,
          lt.spotify_album_id, lt.album_name,
          lt.album_media_item_id as album_id,
          lt.album_link_strategy as strategy,
          coalesce((
            select array_agg(a.name order by c.billing_order)
            from media_credit c join artist a on a.id = c.artist_id
            where c.media_item_id = lt.media_item_id and c.role = 'artist'), '{}') as artists
        from library_track lt join media_item mi on mi.id = lt.media_item_id`)
    ).rows,
  )
}

/**
 * Recomputes the library album of every track from the albums' Spotify IDs,
 * titles, credited artists and track lists. Albums added later pick up their
 * tracks; a track whose album left the library is unlinked.
 */
export async function linkTracksToAlbums() {
  const tracks = await libraryTracks()
  if (!tracks.length) return
  const albums = AlbumRowsSchema.parse(
    (
      await db.execute(sql`
        select mi.id, mi.title,
          to_char(mi.release_date, 'YYYY-MM-DD') as release_date,
          al.spotify_url,
          coalesce((
            select array_agg(a.name order by c.billing_order)
            from media_credit c join artist a on a.id = c.artist_id
            where c.media_item_id = mi.id and c.role = 'artist'), '{}') as artists,
          coalesce((
            select array_agg(r.external_id) from provider_reference r
            where r.media_item_id = mi.id and (r.reference_type = 'spotify'
              or (r.provider = 'spotify' and r.reference_type = 'album'))), '{}') as spotify_album_ids,
          coalesce((
            select jsonb_agg(jsonb_build_object(
              'title', t.title, 'externalId', t.external_id))
            from track t where t.album_media_item_id = mi.id), '[]'::jsonb) as tracks
        from media_item mi join album al on al.media_item_id = mi.id
        where mi.media_type = 'album'
          and mi.metadata->>'legacyHidden' is distinct from 'true'`)
    ).rows,
  )
  const match = createTrackAlbumMatcher(
    albums.map((album) => {
      const linked = album.spotify_url
        ? spotifyAlbumId(album.spotify_url)
        : null
      return {
        id: album.id,
        title: album.title,
        releaseDate: album.release_date,
        artists: album.artists,
        spotifyAlbumIds: [
          ...album.spotify_album_ids,
          ...(linked ? [linked] : []),
        ],
        tracks: album.tracks,
      }
    }),
  )
  const changes = tracks
    .filter((track) => track.source_label !== 'lastfm')
    .flatMap((track) => {
      const result = match({
        spotifyTrackId: track.spotify_track_id,
        spotifyAlbumId: track.spotify_album_id,
        title: track.title,
        albumName: track.album_name,
        artists: track.artists,
      })
      const albumId = result?.albumId ?? null
      const strategy = result?.strategy ?? null
      return albumId === track.album_id && strategy === track.strategy
        ? []
        : [{ id: track.id, album_id: albumId, strategy }]
    })
  for (let start = 0; start < changes.length; start += WRITE_BATCH) {
    // An album deleted since it was read is skipped; the next relink unlinks it.
    await db.execute(sql`
      update library_track lt
      set album_media_item_id = r.album_id, album_link_strategy = r.strategy,
        updated_at = now()
      from jsonb_to_recordset(${JSON.stringify(
        changes.slice(start, start + WRITE_BATCH),
      )}::jsonb) as r(id text, album_id text, strategy text)
      where lt.media_item_id = r.id and (r.album_id is null or exists (
        select 1 from album a where a.media_item_id = r.album_id))`)
  }
}

const linkKey = (row: {
  artist_key: string
  track_key: string
  track_id: string
}) => JSON.stringify([row.artist_key, row.track_key, row.track_id])

/**
 * Recomputes which scrobbled artist and track names count towards each
 * library track, then each track's scrobble count and last listen. Only
 * changed links are written.
 */
export async function linkScrobblesToTracks(account: string) {
  const tracks = await libraryTracks()
  const scrobbled = tracks.length
    ? ScrobbledRowsSchema.parse(
        (
          await db.execute(sql`
            select s.artist_key, s.track_key,
              max(s.artist_name) as artist_name,
              max(s.track_name) as track_name,
              coalesce(array_agg(distinct s.album_media_item_id)
                filter (where s.album_media_item_id is not null), '{}') as album_ids
            from lastfm_scrobble s where s.username = ${account}
            group by s.artist_key, s.track_key`)
        ).rows,
      )
    : []
  const match = createScrobbleTrackMatcher(
    tracks
      .filter((track) => track.source_label !== 'lastfm')
      .map((track) => ({
        id: track.id,
        title: track.title,
        artists: track.artists,
        albumId: track.album_id,
      })),
  )
  const wanted = new Map(
    scrobbled.flatMap((row) => {
      const result = match({
        artistName: row.artist_name,
        trackName: row.track_name,
        albumIds: row.album_ids,
      })
      return (result?.trackIds ?? []).map((trackId) => {
        const link = {
          artist_key: row.artist_key,
          track_key: row.track_key,
          track_id: trackId,
          strategy: result?.strategy ?? 'exact',
        }
        return [linkKey(link), link]
      })
    }),
  )
  // Imported Last.fm identities always retain their own history, even when
  // broader listening rules also count that name towards Spotify editions.
  const sources = LinkRowsSchema.parse(
    (
      await db.execute(sql`
    select artist_key, track_key, track_media_item_id as track_id, 'exact' as strategy
    from lastfm_track_source where username = ${account}`)
    ).rows,
  )
  for (const source of sources) wanted.set(linkKey(source), source)
  const stored = LinkRowsSchema.parse(
    (
      await db.execute(sql`
        select artist_key, track_key, track_media_item_id as track_id, strategy
        from lastfm_track_link where username = ${account}`)
    ).rows,
  )
  const current = new Map(stored.map((row) => [linkKey(row), row]))
  const removed = stored.filter(
    (row) => wanted.get(linkKey(row))?.strategy !== row.strategy,
  )
  const added = [...wanted.values()].filter(
    (row) => current.get(linkKey(row))?.strategy !== row.strategy,
  )
  await db.transaction(async (tx) => {
    for (let start = 0; start < removed.length; start += WRITE_BATCH)
      await tx.execute(sql`
        delete from lastfm_track_link l
        using jsonb_to_recordset(${JSON.stringify(
          removed.slice(start, start + WRITE_BATCH),
        )}::jsonb) as r(artist_key text, track_key text, track_id text)
        where l.username = ${account} and l.artist_key = r.artist_key
          and l.track_key = r.track_key and l.track_media_item_id = r.track_id`)
    for (let start = 0; start < added.length; start += WRITE_BATCH)
      // A track removed since it was read is skipped, not a failed relink.
      await tx.execute(sql`
        insert into lastfm_track_link (username, artist_key, track_key,
          track_media_item_id, strategy)
        select ${account}, r.artist_key, r.track_key, r.track_id, r.strategy
        from jsonb_to_recordset(${JSON.stringify(
          added.slice(start, start + WRITE_BATCH),
        )}::jsonb) as r(artist_key text, track_key text, track_id text,
          strategy text)
        where exists (
          select 1 from library_track lt where lt.media_item_id = r.track_id)
        on conflict do nothing`)
    await tx.execute(sql`
      update library_track lt
      set scrobble_count = coalesce(c.count, 0), last_listened_at = c.last
      from library_track base
      left join (
        select l.track_media_item_id as id, count(*)::int as count,
          max(s.listened_at) as last
        from lastfm_track_link l
        join lastfm_scrobble s on s.username = l.username
          and s.artist_key = l.artist_key and s.track_key = l.track_key
        group by l.track_media_item_id
      ) c on c.id = base.media_item_id
      where lt.media_item_id = base.media_item_id
        and (lt.scrobble_count <> coalesce(c.count, 0)
          or lt.last_listened_at is distinct from c.last)`)
  })
}

/**
 * Relinks tracks to albums, then scrobbles to tracks. `account` is the
 * configured Last.fm account, or null to leave listening untouched.
 */
export async function refreshTrackLinks(account: string | null) {
  await linkTracksToAlbums()
  if (account) {
    await importLastfmLibraryTracks(account)
    await linkScrobblesToTracks(account)
  }
}
