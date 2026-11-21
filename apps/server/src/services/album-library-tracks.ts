import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { PluginNormalizedResult } from '@repo/media-plugin-sdk'
import { z } from 'zod'
import { albumNameKey } from '@/lib/album-import-candidates'
import type { db } from '@/lib/db'
import { createStableId } from '@/lib/media-utils'
import { SpotifyIdSchema } from '@/lib/spotify-api'
import {
  album,
  libraryTrack,
  mediaCredit,
  mediaItem,
  track,
} from '@/schemas/db'
import { writeArtistCredits } from './artist-names'
import { reconcileLastfmAlbumTrackAliases } from './lastfm-library-tracks'
import { refreshTrackAddedDates } from './spotify-playlists'
import { refreshTrackListeningTotals } from './track-links'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
const WRITE_BATCH = 500

const ResolvedTracksSchema = z.array(
  z.object({ entry_id: z.string(), recording_id: z.string() }),
)
const DuplicateTracksSchema = z.array(
  z.object({
    source_id: z.string(),
    target_id: z.string(),
    album_id: z.string(),
    spotify_id: z.string(),
  }),
)
const SpotifyReleaseIdsSchema = z.array(z.object({ spotify_id: z.string() }))

export function isCompilationFallbackArtist(name: string) {
  return albumNameKey(name) === 'various artists'
}

export const AlbumFallbackArtistCreditCorrectionSchema = z.object({
  albumId: z.string().min(1),
  position: z.number().int().positive(),
  previousArtist: z.string().refine(isCompilationFallbackArtist),
  spotifyTrackId: SpotifyIdSchema,
})
export type AlbumFallbackArtistCreditCorrection = z.infer<
  typeof AlbumFallbackArtistCreditCorrectionSchema
>

/** Share the library-track writer lock with imports, retention and merges. */
export async function lockLibraryTrackWrites(database: Transaction) {
  // The worker holds 614105 for its entire session on a separate connection.
  await database.execute(sql`select pg_advisory_xact_lock(614106)`)
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
    return id && entry.artists.length
      ? [{ id, externalId: entry.external_id, artists: entry.artists }]
      : []
  })
  if (creditedRecordings.length) {
    // Playlist and Last.fm imports own their credits. Only replace album
    // fallback credits when this list supplies native track-level artists.
    const owned = await database
      .select({
        id: mediaItem.id,
        spotifyTrackId: libraryTrack.spotifyTrackId,
        creditCorrection: sql<unknown>`${mediaItem.metadata}->'albumFallbackArtistCreditCorrection'`,
      })
      .from(mediaItem)
      .innerJoin(libraryTrack, eq(libraryTrack.mediaItemId, mediaItem.id))
      .where(
        and(
          inArray(
            mediaItem.id,
            creditedRecordings.map((recording) => recording.id),
          ),
          eq(mediaItem.sourceLabel, 'album'),
        ),
      )
    const ownedTracks = new Map(owned.map((item) => [item.id, item]))
    const credits = creditedRecordings
      .filter((recording) => {
        const saved = ownedTracks.get(recording.id)
        if (!saved) return false
        if (!recording.artists.every(isCompilationFallbackArtist)) return true
        const correction = AlbumFallbackArtistCreditCorrectionSchema.safeParse(
          saved.creditCorrection,
        )
        // Album billing cannot replace verified artists on the same Spotify track.
        return (
          !correction.success ||
          correction.data.spotifyTrackId !== saved.spotifyTrackId ||
          (SpotifyIdSchema.safeParse(recording.externalId).success &&
            correction.data.spotifyTrackId !== recording.externalId)
        )
      })
      .flatMap((recording) =>
        [...new Set(recording.artists)].map((name, billingOrder) => ({
          mediaItemId: recording.id,
          name,
          role: 'artist',
          billingOrder,
        })),
      )
    if (credits.length) {
      await database
        .delete(mediaCredit)
        .where(
          and(
            inArray(mediaCredit.mediaItemId, [
              ...new Set(credits.map(({ mediaItemId }) => mediaItemId)),
            ]),
            eq(mediaCredit.role, 'artist'),
          ),
        )
      await writeArtistCredits(database, credits)
    }
  }

  await database.execute(sql`select merge_album_track_history(${albumId})`)
  await reconcileSpotifyAlbumRecordings(database, albumId)
  await reconcileLastfmAlbumTrackAliases(database, { albumId })

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

export function spotifyAlbumReleaseIds(albumId?: string) {
  const albumScope =
    albumId === undefined ? sql`` : sql`and release.media_item_id = ${albumId}`
  return sql`
    select release.media_item_id as album_id, release.external_id as spotify_id
    from provider_reference release join album a on a.media_item_id = release.media_item_id
    where (release.reference_type = 'spotify' or (release.provider = 'spotify' and release.reference_type = 'album'))
      and release.external_id ~ '^[A-Za-z0-9]{22}$'
      ${albumScope}
    union
    select release.media_item_id, (regexp_match(release.spotify_url, '/album/([A-Za-z0-9]{22})([/?#]|$)'))[1]
    from album release where release.spotify_url is not null ${albumScope}`
}

/** Data owned by the recording that cannot be moved with its release and listening memberships. */
export function independentTrackData(id: SQL) {
  return sql`exists (
              select 1 from media_credit where media_item_id = ${id} and role <> 'artist'
              union all select 1 from media_item_tag where media_item_id = ${id}
              union all select 1 from tag_occurrence where media_item_id = ${id}
              union all select 1 from external_link where media_item_id = ${id}
              union all select 1 from provider_reference where media_item_id = ${id}
              union all select 1 from provider_snapshot where media_item_id = ${id}
              union all select 1 from provider_current_state where media_item_id = ${id}
              union all select 1 from scrape_job_item where media_item_id = ${id}
              union all select 1 from media_override where media_item_id = ${id}
              union all select 1 from provider_reference_override where media_item_id = ${id}
            )`
}

/** Repairs split album positions when one imported track matches the exact release. */
export async function reconcileSpotifyAlbumRecordings(
  database: Transaction,
  albumId?: string,
) {
  let pairs = DuplicateTracksSchema.parse(
    (
      await database.execute(sql`
        with release_ids as (
          select min(album_id) as album_id, spotify_id
          from (${spotifyAlbumReleaseIds(albumId)}) releases
          where spotify_id is not null
          group by spotify_id having count(*) = 1
        ), candidates as (
          select source.media_item_id as source_id, target.media_item_id as target_id,
            t.album_media_item_id as album_id, r.spotify_id,
            count(*) over (partition by source.media_item_id) as source_matches,
            count(*) over (partition by target.media_item_id) as target_matches
          from release_ids r
          join media_item release on release.id = r.album_id
          join library_track target on target.spotify_album_id = r.spotify_id
          join media_item imported on imported.id = target.media_item_id
          join track t on t.album_media_item_id = r.album_id
            and lower(regexp_replace(trim(t.title), '[[:space:]]+', ' ', 'g'))
              = lower(regexp_replace(trim(coalesce(imported.metadata#>>'{spotifyTrackSearch,title}', imported.title)), '[[:space:]]+', ' ', 'g'))
          join library_track source on source.media_item_id = t.track_media_item_id
          join media_item legacy on legacy.id = source.media_item_id
          -- A generated album recording has no independent media metadata.
          where legacy.source_label = 'album' and legacy.slug = legacy.id
            and legacy.release_date is null and legacy.artwork_url is null
            and legacy.summary is null and legacy.original_title is null
            and coalesce(legacy.metadata, '{}'::jsonb) = '{}'::jsonb
            and lower(regexp_replace(trim(legacy.title), '[[:space:]]+', ' ', 'g'))
              = lower(regexp_replace(trim(t.title), '[[:space:]]+', ' ', 'g'))
            and source.spotify_track_id is null and source.isrc is null and source.spotify_url is null
            and source.spotify_album_id is null and source.album_name is null
            and (source.duration_sec is null or source.duration_sec = target.duration_sec)
            and imported.source_label in ('spotify', 'spotify-search') and target.spotify_track_id is not null
            and imported.metadata->>'legacyHidden' is distinct from 'true'
            and release.metadata->>'legacyHidden' is distinct from 'true'
            and (target.album_media_item_id is null or target.album_media_item_id = r.album_id)
            and (t.duration_sec is null or target.duration_sec is null or t.duration_sec = target.duration_sec)
            and (t.external_id is null or t.external_id !~ '^[A-Za-z0-9]{22}$'
              or t.external_id = target.spotify_track_id)
            and not exists (select 1 from track other
              where other.id <> t.id and (
                other.track_media_item_id in (source.media_item_id, target.media_item_id)
                or (other.album_media_item_id = t.album_media_item_id
                  and lower(regexp_replace(trim(other.title), '[[:space:]]+', ' ', 'g'))
                    = lower(regexp_replace(trim(t.title), '[[:space:]]+', ' ', 'g')))))
            and not exists (select 1 from lastfm_track_source s
              where s.track_media_item_id = source.media_item_id and s.manually_matched)
            and exists (select 1 from media_credit c
              where c.media_item_id = source.media_item_id and c.role = 'artist')
            and array(select c.artist_id from media_credit c
              where c.media_item_id = source.media_item_id and c.role = 'artist'
              order by c.billing_order, c.artist_id)
              = array(select c.artist_id from media_credit c
                where c.media_item_id = target.media_item_id and c.role = 'artist'
                order by c.billing_order, c.artist_id)
            and not ${independentTrackData(sql`legacy.id`)}
        )
        select source_id, target_id, album_id, spotify_id from candidates
        where source_matches = 1 and target_matches = 1`)
    ).rows,
  )
  if (!pairs.length) return

  if (albumId !== undefined) {
    // Only check the rest of the catalog if this album produced a match.
    const releaseIds = [...new Set(pairs.map((pair) => pair.spotify_id))]
    const unique = SpotifyReleaseIdsSchema.parse(
      (
        await database.execute(sql`
          select spotify_id from (${spotifyAlbumReleaseIds()}) releases
          where spotify_id in (
            select jsonb_array_elements_text(${JSON.stringify(releaseIds)}::jsonb)
          )
          group by spotify_id having count(*) = 1`)
      ).rows,
    )
    const verifiedIds = new Set(unique.map((release) => release.spotify_id))
    pairs = pairs.filter((pair) => verifiedIds.has(pair.spotify_id))
  }

  for (let start = 0; start < pairs.length; start += WRITE_BATCH) {
    await mergeSpotifyAlbumRecordings(
      database,
      pairs.slice(start, start + WRITE_BATCH),
    )
  }
}

async function mergeSpotifyAlbumRecordings(
  database: Transaction,
  pairs: z.infer<typeof DuplicateTracksSchema>,
) {
  const rows = sql`jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb)
    as pair(source_id text, target_id text, album_id text)`
  await database.execute(sql`
    update track t set track_media_item_id = pair.target_id
    from ${rows} where t.track_media_item_id = pair.source_id`)
  await database.execute(sql`
    update library_track lt set album_media_item_id = pair.album_id, album_link_strategy = 'album-track-list'
    from ${rows} where lt.media_item_id = pair.target_id`)
  await database.execute(sql`
    insert into playlist_item (playlist_id, media_item_id, position, added_at)
    select p.playlist_id, pair.target_id, p.position, p.added_at
    from playlist_item p join ${rows} on p.media_item_id = pair.source_id
    on conflict (playlist_id, media_item_id) do update
      set position = least(playlist_item.position, excluded.position),
        added_at = least(playlist_item.added_at, excluded.added_at)`)
  await database.execute(sql`
    delete from playlist_item p using ${rows} where p.media_item_id = pair.source_id`)
  await database.execute(sql`
    update lastfm_track_source s set track_media_item_id = pair.target_id
    from ${rows} where s.track_media_item_id = pair.source_id`)
  await database.execute(sql`
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
    select l.username, l.artist_key, l.track_key, pair.target_id, l.strategy
    from lastfm_track_link l join ${rows} on l.track_media_item_id = pair.source_id
    on conflict do nothing`)
  await removeOrphanTracks(
    database,
    pairs.map((pair) => pair.source_id),
  )
  const targetIds = pairs.map((pair) => pair.target_id)
  await refreshTrackAddedDates(database, targetIds)
  await refreshTrackListeningTotals(database, targetIds)
}

/** A recording explicitly kept from catalog search survives removal of its final membership. */
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
      and not coalesce(mi.metadata ? 'spotifyTrackSearch', false)
      and not exists (select 1 from track t where t.track_media_item_id = mi.id)
      and not exists (select 1 from playlist_item pi where pi.media_item_id = mi.id)
      and not exists (select 1 from lastfm_track_source s where s.track_media_item_id = mi.id)`)
  return removed.rowCount ?? 0
}
