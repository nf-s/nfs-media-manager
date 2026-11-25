import { sql } from 'drizzle-orm'
import type { db } from '@/lib/db'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** A track position on a saved album grants membership without an individual addition. */
export async function admitAlbumTrackMembers(
  database: Transaction,
  albumId: string,
) {
  await database.execute(sql`
    with admitted as (
      update media_item item set in_library = true
      from album record join media_item saved on saved.id = record.media_item_id
      where saved.id = ${albumId} and saved.in_library
        and not item.in_library and item.metadata->>'legacyHidden' is distinct from 'true'
        and item.id in (select track_media_item_id from track where album_media_item_id = ${albumId})
      returning item.id, record.date_added
    )
    update library_track recording set date_added = admitted.date_added
    from admitted where recording.media_item_id = admitted.id
      and recording.date_added is distinct from admitted.date_added
  `)
}
