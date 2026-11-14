import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { AlbumPlaylistsSchema, type AlbumPlaylists } from '@repo/schemas/tracks'
import { db } from '@/lib/db'

const AlbumPlaylistRowsSchema = z.array(
  z.object({ id: z.string(), name: z.string(), track_count: z.number().int() }),
)
const AlbumTrackRowsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    spotify_track_id: z.string().nullable(),
    playlists: z.array(z.string()),
  }),
)

/** The playlists an album is in, and its tracks that are in the track library. */
export async function getAlbumPlaylists(
  albumId: string,
): Promise<AlbumPlaylists> {
  const playlists = AlbumPlaylistRowsSchema.parse(
    (
      await db.execute(sql`
        select p.id, p.name, count(lt.media_item_id)::int as track_count
        from playlist p
        join playlist_item pi on pi.playlist_id = p.id
        left join library_track lt on lt.media_item_id = pi.media_item_id
        where p.kind = 'playlist'
          and (pi.media_item_id = ${albumId} or lt.album_media_item_id = ${albumId})
        group by p.id, p.name
        order by lower(p.name), p.id`)
    ).rows,
  )
  const tracks = AlbumTrackRowsSchema.parse(
    (
      await db.execute(sql`
        select mi.id, mi.title, lt.spotify_track_id,
          coalesce((
            select array_agg(p.name order by p.name)
            from playlist_item pi join playlist p on p.id = pi.playlist_id
            where pi.media_item_id = mi.id), '{}') as playlists
        from library_track lt join media_item mi on mi.id = lt.media_item_id
        where lt.album_media_item_id = ${albumId}
        order by lower(mi.title), mi.id`)
    ).rows,
  )
  return AlbumPlaylistsSchema.parse({
    playlists: playlists.map((row) => ({
      id: row.id,
      name: row.name,
      trackCount: row.track_count,
    })),
    tracks: tracks.map((row) => ({
      id: row.id,
      title: row.title,
      spotifyTrackId: row.spotify_track_id,
      playlists: row.playlists,
    })),
  })
}

const DerivedPlaylistRowsSchema = z.array(
  z.object({ album_id: z.string(), name: z.string() }),
)

/** Playlist names each album is in through a linked library track. */
export async function albumTrackPlaylistNames(albumIds: string[]) {
  const names = new Map<string, string[]>()
  if (!albumIds.length) return names
  const rows = DerivedPlaylistRowsSchema.parse(
    (
      await db.execute(sql`
        select distinct lt.album_media_item_id as album_id, p.name
        from library_track lt
        join playlist_item pi on pi.media_item_id = lt.media_item_id
        join playlist p on p.id = pi.playlist_id
        where p.kind = 'playlist' and lt.album_media_item_id in (${sql.join(
          albumIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        order by p.name`)
    ).rows,
  )
  for (const row of rows)
    names.set(row.album_id, [...(names.get(row.album_id) ?? []), row.name])
  return names
}
