import { inArray, sql, type SQLWrapper } from 'drizzle-orm'
import type { db } from '@/lib/db'
import { mediaItem } from '@/schemas/db'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export function hasStandaloneTrackAdmission(metadata: SQLWrapper) {
  return sql`coalesce(${metadata} ?| array[
    'spotifyTrackSearch', 'spotifyTrackManualAddedAt', 'tidalSimilarTrackAddedAt'
  ], false)`
}

/** A track position on a saved album grants membership without an individual addition. */
export async function admitAlbumTrackMembers(
  database: Transaction,
  albumId: string,
  trackIds?: string[],
) {
  await database.execute(sql`
    with admitted as (
      update media_item item set in_library = true
      from album record join media_item saved on saved.id = record.media_item_id
      where saved.id = ${albumId} and saved.in_library
        and not item.in_library and item.metadata->>'legacyHidden' is distinct from 'true'
        and item.id in (select track_media_item_id from track where album_media_item_id = ${albumId})
        ${trackIds ? sql`and item.id = any(${sql.param(trackIds)}::text[])` : sql``}
      returning item.id, record.date_added
    )
    update library_track recording set date_added = admitted.date_added
    from admitted where recording.media_item_id = admitted.id
      and recording.date_added is distinct from admitted.date_added
  `)
}

/** Withdraws position-based membership where the recording has no other source. */
export async function withdrawAlbumTrackAdmission(
  database: Transaction,
  trackIds: string[],
) {
  if (!trackIds.length) return
  await database
    .update(mediaItem)
    .set({ inLibrary: false })
    .where(
      sql`${inArray(mediaItem.id, trackIds)} and ${mediaItem.inLibrary}
      and not ${hasStandaloneTrackAdmission(mediaItem.metadata)}
      and not exists (select 1 from catalog_addition a where a.media_item_id = ${mediaItem.id})
      and not exists (select 1 from playlist_item p
        where p.media_item_id = ${mediaItem.id} and p.admits_to_library)
      and not exists (select 1 from lastfm_track_source s where s.track_media_item_id = ${mediaItem.id})
      and not exists (select 1 from track t
        join media_item saved on saved.id = t.album_media_item_id and saved.in_library
        where t.track_media_item_id = ${mediaItem.id})`,
    )
}
