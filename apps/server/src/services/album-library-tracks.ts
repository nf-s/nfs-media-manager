import { and, eq, inArray, sql } from 'drizzle-orm'
import type { PluginNormalizedResult } from '@repo/media-plugin-sdk'
import { z } from 'zod'
import type { db } from '@/lib/db'
import { createStableId } from '@/lib/media-utils'
import { album, artist, mediaCredit, mediaItem, track } from '@/schemas/db'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

const ResolvedTracksSchema = z.array(
  z.object({ entry_id: z.string(), recording_id: z.string() }),
)

/** Share the library-track writer lock with imports, retention and merges. */
export async function lockLibraryTrackWrites(database: Transaction) {
  await database.execute(sql`select pg_advisory_xact_lock(614105)`)
}

/** Replaces a complete list while retaining any matching library recordings. */
export async function replaceAlbumTracks(
  database: Transaction,
  albumId: string,
  tracks: PluginNormalizedResult['tracks'],
) {
  if (!tracks.length) return
  await lockLibraryTrackWrites(database)

  const entries = tracks.map((item) => ({
    id: createStableId(
      'track',
      `${albumId}:${item.position}:${item.title}:${item.externalId ?? ''}`,
    ),
    title: item.title,
    position: item.position,
    external_id: item.externalId ?? null,
    durationSec: item.durationSec ?? null,
    artists: item.artists ?? [],
  }))
  const resolved = ResolvedTracksSchema.parse(
    (
      await database.execute(sql`
        select entry_id, recording_id
        from resolve_album_library_tracks(${albumId}, ${JSON.stringify(entries)}::jsonb)`)
    ).rows,
  )
  const recordings = new Map(
    resolved.map(({ entry_id, recording_id }) => [entry_id, recording_id]),
  )
  const previous = await database
    .delete(track)
    .where(eq(track.albumMediaItemId, albumId))
    .returning({ id: track.trackMediaItemId })

  await database.insert(track).values(
    entries.map((entry) => {
      const recordingId = recordings.get(entry.id)
      if (!recordingId)
        throw new Error('Album track recording was not resolved')
      return {
        id: entry.id,
        albumMediaItemId: albumId,
        trackMediaItemId: recordingId,
        externalId: entry.external_id,
        title: entry.title,
        position: entry.position,
        durationSec: entry.durationSec,
        metadata: {},
      }
    }),
  )

  const creditedRecordings = entries.flatMap((entry) => {
    const id = recordings.get(entry.id)
    return id && entry.artists.length ? [{ id, artists: entry.artists }] : []
  })
  if (creditedRecordings.length) {
    // Playlist and Last.fm imports own their credits. Only replace album
    // fallback credits when this list supplies native track-level artists.
    const owned = await database
      .select({ id: mediaItem.id })
      .from(mediaItem)
      .where(
        and(
          inArray(
            mediaItem.id,
            creditedRecordings.map((recording) => recording.id),
          ),
          eq(mediaItem.sourceLabel, 'album'),
        ),
      )
    const ownedIds = new Set(owned.map((item) => item.id))
    const credits = creditedRecordings
      .filter((recording) => ownedIds.has(recording.id))
      .flatMap((recording) =>
        [...new Set(recording.artists)].map((name, billingOrder) => ({
          track_id: recording.id,
          artist_id: createStableId('artist', name.toLowerCase()),
          artist_name: name,
          billing_order: billingOrder,
        })),
      )
    if (credits.length) {
      const artists = new Map(
        credits.map((credit) => [credit.artist_id, credit.artist_name]),
      )
      await database
        .insert(artist)
        .values(
          [...artists].map(([id, name]) => ({ id, name, sortName: name })),
        )
        .onConflictDoNothing()
      await database
        .delete(mediaCredit)
        .where(
          and(
            inArray(mediaCredit.mediaItemId, [...ownedIds]),
            eq(mediaCredit.role, 'artist'),
          ),
        )
      await database.execute(sql`
        insert into media_credit (media_item_id, artist_id, role, billing_order)
        select r.track_id, a.id, 'artist', r.billing_order
        from jsonb_to_recordset(${JSON.stringify(credits)}::jsonb)
          as r(track_id text, artist_id text, artist_name text, billing_order int)
        join lateral (select id from artist where id = r.artist_id or name = r.artist_name
          order by case when name = r.artist_name then 0 else 1 end limit 1) a on true
        order by r.track_id, r.billing_order
        on conflict do nothing`)
    }
  }

  await database.execute(sql`select merge_album_track_history(${albumId})`)

  if (previous.length) {
    const previousIds = sql.join(
      previous.map((row) => sql`${row.id}`),
      sql`, `,
    )
    await database.execute(sql`
      update library_track lt
      set album_media_item_id = remaining.album_id,
        album_link_strategy = case when remaining.album_id is not null then 'album-track-list' end
      from (
        select previous.media_item_id, min(t.album_media_item_id) as album_id
        from library_track previous
        left join track t on t.track_media_item_id = previous.media_item_id
        where previous.media_item_id in (${previousIds})
        group by previous.media_item_id
      ) remaining
      where lt.media_item_id = remaining.media_item_id
        and lt.album_media_item_id = ${albumId}
        and lt.album_link_strategy = 'album-track-list'
        and not exists (select 1 from track t
          where t.track_media_item_id = lt.media_item_id and t.album_media_item_id = ${albumId})`)
    await removeOrphanTracks(
      database,
      previous.map((row) => row.id),
    )
  }

  await database
    .update(album)
    .set({ trackCount: entries.length, updatedAt: new Date() })
    .where(eq(album.mediaItemId, albumId))
}

/** Deletes recordings that have no album, playlist or Last.fm membership. */
export async function removeOrphanTracks(
  database: Transaction,
  ids?: string[],
) {
  if (ids?.length === 0) return 0
  const candidates = ids
    ? sql`and mi.id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql``
  const removed = await database.execute(sql`
    delete from media_item mi where mi.media_type = 'track' ${candidates}
      and not exists (select 1 from track t where t.track_media_item_id = mi.id)
      and not exists (select 1 from playlist_item pi where pi.media_item_id = mi.id)
      and not exists (select 1 from lastfm_track_source s where s.track_media_item_id = mi.id)`)
  return removed.rowCount ?? 0
}
