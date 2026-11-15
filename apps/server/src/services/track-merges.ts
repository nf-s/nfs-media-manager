import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  TrackMergeInputSchema,
  type TrackMergeInput,
  type TrackMergeResult,
} from '@repo/schemas/tracks'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { refreshTrackAddedDates } from './spotify-playlists'
import {
  lockLibraryTrackWrites,
  removeOrphanTracks,
} from './album-library-tracks'
import { refreshTrackListeningTotals } from './track-links'

const MergeTracksSchema = z.array(
  z.object({
    id: z.string(),
    spotify_track_id: z.string().nullable(),
    lastfm_source: z.boolean(),
    imported_spotify: z.boolean(),
  }),
)

/** Keeps an explicitly chosen imported Spotify identity and its recorded evidence. */
export async function mergeLastfmTrack(
  sourceId: string,
  input: TrackMergeInput,
): Promise<TrackMergeResult> {
  const { targetId } = TrackMergeInputSchema.parse(input)
  if (sourceId === targetId)
    throw new ServerError({
      statusCode: 409,
      message: 'Choose a different track to merge into.',
    })
  return db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    const records = MergeTracksSchema.parse(
      (
        await tx.execute(sql`
          select lt.media_item_id as id, lt.spotify_track_id,
            (mi.source_label is not distinct from 'spotify') as imported_spotify,
            exists (select 1 from lastfm_track_source s
              where s.track_media_item_id = lt.media_item_id) as lastfm_source
          from library_track lt join media_item mi on mi.id = lt.media_item_id
          where lt.media_item_id in (${sourceId}, ${targetId})
            and mi.media_type = 'track'
            and mi.metadata->>'legacyHidden' is distinct from 'true'
          for update of lt`)
      ).rows,
    )
    const source = records.find((row) => row.id === sourceId)
    const target = records.find((row) => row.id === targetId)
    if (!source || !target)
      throw new ServerError({ statusCode: 404, message: 'Track not found' })
    if (source.imported_spotify || !source.lastfm_source)
      throw new ServerError({
        statusCode: 409,
        message:
          'Only a Last.fm track without an imported Spotify identity can be merged.',
      })
    if (target.spotify_track_id === null || !target.imported_spotify)
      throw new ServerError({
        statusCode: 409,
        message: 'Choose a track imported from Spotify.',
      })

    // Shared playlists keep the earliest position and Added date, as imports do.
    await tx.execute(sql`
      insert into playlist_item (playlist_id, media_item_id, position, added_at)
      select playlist_id, ${targetId}, position, added_at
      from playlist_item where media_item_id = ${sourceId}
      on conflict (playlist_id, media_item_id) do update
        set position = least(playlist_item.position, excluded.position),
          added_at = least(playlist_item.added_at, excluded.added_at)`)
    await tx.execute(sql`
      update lastfm_track_source
      set track_media_item_id = ${targetId}, manually_matched = true
      where track_media_item_id = ${sourceId}`)

    // A manual identity overrides every automatic listening match for that name.
    // Rebuild these links rather than adding summary counts that may overlap.
    await tx.execute(sql`
      delete from lastfm_track_link l using lastfm_track_source s
      where s.track_media_item_id = ${targetId} and s.manually_matched
        and l.username = s.username and l.artist_key = s.artist_key
        and l.track_key = s.track_key`)
    await tx.execute(sql`
      insert into lastfm_track_link
        (username, artist_key, track_key, track_media_item_id, strategy)
      select username, artist_key, track_key, track_media_item_id, 'manual'
      from lastfm_track_source
      where track_media_item_id = ${targetId} and manually_matched
      on conflict (username, artist_key, track_key, track_media_item_id)
        do update set strategy = excluded.strategy`)
    if (source.spotify_track_id === null) {
      await tx.execute(sql`
        update track set track_media_item_id = ${targetId}
        where track_media_item_id = ${sourceId}`)
      await tx.execute(sql`
        update library_track target
        set album_media_item_id = source.album_media_item_id,
          album_link_strategy = 'album-track-list'
        from library_track source
        where target.media_item_id = ${targetId} and source.media_item_id = ${sourceId}
          and target.album_media_item_id is null and exists (
            select 1 from track t where t.track_media_item_id = target.media_item_id
              and t.album_media_item_id = source.album_media_item_id)`)
    }
    await tx.execute(
      sql`delete from playlist_item where media_item_id = ${sourceId}`,
    )
    await removeOrphanTracks(tx, [sourceId])
    await refreshTrackAddedDates(tx)
    await refreshTrackListeningTotals(tx)
    return { targetId }
  })
}
