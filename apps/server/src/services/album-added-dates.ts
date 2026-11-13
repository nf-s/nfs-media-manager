import { inArray, sql, type SQLWrapper } from 'drizzle-orm'
import { db } from '@/lib/db'
import { toIsoString } from '@/lib/media-utils'
import { album, lastfmScrobble } from '@/schemas/db'

function firstScrobbleDate(mediaItemId: SQLWrapper) {
  // The album/time index makes this a bounded lookup, including for old syncs.
  return sql<Date | null>`(select s.listened_at from lastfm_scrobble s
    where s.album_media_item_id = ${mediaItemId}
    order by s.listened_at limit 1)`
}

export const albumAddedDateExpression = sql`least(${album.dateAdded}, ${firstScrobbleDate(album.mediaItemId)})`

/** Reads current links without changing the stored library date or snapshots. */
export async function albumAddedDates(ids: string[]) {
  const rows = await db
    .select({
      id: album.mediaItemId,
      stored: album.dateAdded,
      first: firstScrobbleDate(album.mediaItemId).mapWith(
        lastfmScrobble.listenedAt,
      ),
    })
    .from(album)
    .where(inArray(album.mediaItemId, ids))
  return new Map(
    rows.map((row) => {
      const useScrobble =
        row.first !== null && (row.stored === null || row.first < row.stored)
      return [
        row.id,
        {
          dateAdded: toIsoString(useScrobble ? row.first : row.stored),
          dateAddedSource: useScrobble
            ? 'First Last.fm scrobble'
            : row.stored
              ? 'Stored library date'
              : undefined,
        },
      ]
    }),
  )
}
