import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { TrackScrobbleNameKey } from '@repo/schemas/tracks'
import type { db } from '@/lib/db'
import { slugifyParts } from '@/lib/media-utils'
import { standaloneLastfmTrackId } from '@/lib/track-matching'
import { libraryTrack, mediaItem } from '@/schemas/db'
import { writeArtistCredits } from './artist-names'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export const ScrobbledRowsSchema = z.array(
  z.object({
    artist_key: z.string(),
    track_key: z.string(),
    artist_name: z.string(),
    track_name: z.string(),
    album_names: z.array(z.string()),
    album_ids: z.array(z.string()),
    has_unlinked_album: z.boolean(),
  }),
)
/** The scrobbles of one artist and track name, as the matching rules read them. */
export type ScrobbledName = z.infer<typeof ScrobbledRowsSchema>[number]

/** The columns of `ScrobbledRowsSchema`, over `lastfm_scrobble s`. */
export const scrobbledColumns = sql`
  max(s.artist_name) as artist_name, max(s.track_name) as track_name,
  coalesce(array_agg(distinct s.album_name order by s.album_name)
    filter (where nullif(trim(s.album_name), '') is not null), '{}') as album_names,
  bool_or(nullif(trim(s.album_name), '') is not null and s.album_media_item_id is null) as has_unlinked_album,
  coalesce(array_agg(distinct s.album_media_item_id)
    filter (where s.album_media_item_id is not null), '{}') as album_ids`

/** The library album a name's own track links to: its one linked album. */
export function scrobbledAlbumId(group: ScrobbledName) {
  return !group.has_unlinked_album && group.album_ids.length === 1
    ? (group.album_ids[0] ?? null)
    : null
}

/**
 * Writes the Last.fm-only tracks of scrobbled names: the title, album and
 * artist they were scrobbled with.
 */
export async function writeStandaloneTracks(
  tx: Transaction,
  tracks: { id: string; group: ScrobbledName; albumId: string | null }[],
) {
  if (!tracks.length) return
  const items: Array<typeof mediaItem.$inferInsert> = tracks.map(
    ({ id, group }) => ({
      id,
      mediaType: 'track',
      slug: slugifyParts(group.track_name, id),
      title: group.track_name,
      sourceLabel: 'lastfm',
    }),
  )
  await tx
    .insert(mediaItem)
    .values(items)
    .onConflictDoUpdate({
      target: mediaItem.id,
      set: { title: sql`excluded.title` },
    })
  await tx
    .insert(libraryTrack)
    .values(
      tracks.map(({ id, group, albumId }) => ({
        mediaItemId: id,
        albumName: group.album_names.length === 1 ? group.album_names[0] : null,
        albumMediaItemId: albumId,
        albumLinkStrategy: albumId ? 'lastfm' : null,
      })),
    )
    .onConflictDoUpdate({
      target: libraryTrack.mediaItemId,
      set: {
        albumName: sql`excluded.album_name`,
        albumMediaItemId: sql`excluded.album_media_item_id`,
        albumLinkStrategy: sql`excluded.album_link_strategy`,
      },
    })
  await tx.execute(
    sql`delete from media_credit where role = 'artist' and media_item_id in (${sql.join(
      tracks.map(({ id }) => sql`${id}`),
      sql`, `,
    )})`,
  )
  await writeArtistCredits(
    tx,
    tracks.map(({ id, group }) => ({
      mediaItemId: id,
      name: group.artist_name,
      role: 'artist',
      billingOrder: 0,
    })),
  )
}

const IdRowsSchema = z.array(z.object({ id: z.string() }))

/**
 * Makes the Last.fm-only track of each given name of an account that has none,
 * as an import would. Returns the IDs of the tracks it made.
 */
export async function createStandaloneTracks(
  tx: Transaction,
  username: string,
  names: TrackScrobbleNameKey[],
) {
  if (!names.length) return []
  const ids = new Map(
    names.map((name) => [standaloneLastfmTrackId(username, name), name]),
  )
  const present = new Set(
    IdRowsSchema.parse(
      (
        await tx.execute(sql`
          select media_item_id as id from library_track
          where media_item_id in (${sql.join(
            [...ids.keys()].map((id) => sql`${id}`),
            sql`, `,
          )})`)
      ).rows,
    ).map((row) => row.id),
  )
  const missing = [...ids].filter(([id]) => !present.has(id))
  if (!missing.length) return []
  const groups = ScrobbledRowsSchema.parse(
    (
      await tx.execute(sql`
        select s.artist_key, s.track_key, ${scrobbledColumns}
        from lastfm_scrobble s
        join jsonb_to_recordset(${JSON.stringify(
          missing.map(([, name]) => ({
            artist_key: name.artistKey,
            track_key: name.trackKey,
          })),
        )}::jsonb) as r(artist_key text, track_key text)
          on s.artist_key = r.artist_key and s.track_key = r.track_key
        where s.username = ${username}
        group by s.artist_key, s.track_key`)
    ).rows,
  )
  const tracks = groups.map((group) => ({
    id: standaloneLastfmTrackId(username, {
      artistKey: group.artist_key,
      trackKey: group.track_key,
    }),
    group,
    albumId: scrobbledAlbumId(group),
  }))
  await writeStandaloneTracks(tx, tracks)
  return tracks.map((track) => track.id)
}
