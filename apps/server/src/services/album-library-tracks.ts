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
import {
  membershipDetails,
  removedTracksEntry,
} from './automatic-match-effects'
import { readKeptSeparateTest } from './keep-separate-effects'
import { reconcileLastfmAlbumTrackAliases } from './lastfm-library-tracks'
import type { ChangeEffectEntry } from './library-change-effect'
import {
  closeChangeBatch,
  openChangeBatch,
  readChangeRecords,
  recordChange,
  recordNameMoves,
  recordRemovedTracks,
  type RecordedNameMove,
} from './library-changes'
import { readRejectionTest } from './library-match-rejections'
import { refreshTrackAddedDates } from './spotify-playlists'
import { archiveTracks } from './track-archive'
import { refreshTrackListeningTotals } from './track-links'
import { moveTrackMemberships } from './track-version-effects'

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
const HistoryPairsSchema = z.array(
  z.object({ source_id: z.string(), target_id: z.string() }),
)
const OwnedNamesSchema = z.array(
  z.object({
    username: z.string(),
    artist_key: z.string(),
    track_key: z.string(),
    track_id: z.string(),
  }),
)
const MovedNamesSchema = z.array(
  z.object({
    username: z.string(),
    artist_key: z.string(),
    track_key: z.string(),
    manual: z.boolean(),
  }),
)
const PairNamesSchema = z.array(
  MovedNamesSchema.element.extend({ from_id: z.string(), to_id: z.string() }),
)

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

/**
 * Replaces a complete list while retaining any matching library recordings.
 * The merges it makes are recorded as one automatic run.
 */
export async function replaceAlbumTracks(
  database: Transaction,
  albumId: string,
  tracks: PluginNormalizedResult['tracks'],
) {
  if (!tracks.length) return
  await lockLibraryTrackWrites(database)
  const batchId = await openChangeBatch(database, 'album-refresh')

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

  await mergeAlbumTrackHistory(database, albumId, batchId)
  await reconcileSpotifyAlbumRecordings(database, albumId, batchId)
  await reconcileLastfmAlbumTrackAliases(database, { albumId, batchId })

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
    // A recording that lost its last position is removed; keep its archive.
    const recordingIds = [...new Set(previous.map((row) => row.id))]
    const archived = await archiveTracks(database, recordingIds)
    await removeOrphanTracks(database, recordingIds)
    await recordRemovedTracks(database, {
      archived,
      rule: 'album-track-list',
      batchId,
    })
  }

  await database
    .update(album)
    .set({ trackCount: entries.length, updatedAt: new Date() })
    .where(eq(album.mediaItemId, albumId))
  await closeChangeBatch(database, batchId)
}

/**
 * The pairs an automatic merge may join: not kept separate by the owner, and
 * not giving a source's name to a target the owner undid or separated it from.
 */
async function allowedMerges<
  Pair extends { source_id: string; target_id: string },
>(database: Transaction, pairs: Pair[]) {
  if (!pairs.length) return []
  const owned = OwnedNamesSchema.parse(
    (
      await database.execute(sql`
        select username, artist_key, track_key, track_media_item_id as track_id
        from lastfm_track_source
        where ${inArray(
          sql`track_media_item_id`,
          pairs.map((pair) => pair.source_id),
        )}`)
    ).rows,
  )
  const rejected = new Map<
    string,
    Awaited<ReturnType<typeof readRejectionTest>>
  >()
  for (const username of new Set(owned.map((name) => name.username)))
    rejected.set(username, await readRejectionTest(database, username))
  const kept = await readKeptSeparateTest(
    database,
    'track',
    pairs.flatMap((pair) => [pair.source_id, pair.target_id]),
  )
  return pairs.filter(
    (pair) =>
      !kept(pair.source_id, pair.target_id) &&
      !owned.some(
        (name) =>
          name.track_id === pair.source_id &&
          rejected.get(name.username)?.(
            name.artist_key,
            name.track_key,
            pair.target_id,
          ),
      ),
  )
}

/**
 * Gives the scrobbled names and playlist entries of a Last.fm-only track
 * linked to the album to the one listed recording with its title and artist,
 * then removes it. A pair whose names the owner rejected, or that the owner
 * keeps separate, is left alone. Recorded as automatic changes.
 */
export async function mergeAlbumTrackHistory(
  database: Transaction,
  albumId: string,
  batchId: string | null = null,
) {
  // A pre-existing Last.fm row may duplicate an exact Spotify match. Keep
  // all evidence when the scrobble group and the list select one recording.
  const pairs = HistoryPairsSchema.parse(
    (
      await database.execute(sql`
        select source.media_item_id as source_id, min(t.track_media_item_id) as target_id
        from library_track source
        join media_item source_item on source_item.id = source.media_item_id
        join track t on t.album_media_item_id = ${albumId}
          and lower(regexp_replace(trim(t.title), '[[:space:]]+', ' ', 'g'))
            = lower(regexp_replace(trim(source_item.title), '[[:space:]]+', ' ', 'g'))
        where source.album_media_item_id = ${albumId} and source.spotify_track_id is null
          and source_item.source_label = 'lastfm'
          and not exists (select 1 from track listed where listed.track_media_item_id = source.media_item_id)
          and exists (select 1 from lastfm_track_source s where s.track_media_item_id = source.media_item_id)
          and not exists (select 1 from lastfm_track_source s
            where s.track_media_item_id = source.media_item_id and s.manually_matched)
          and not exists (select 1 from library_track conflicting
            join media_item m on m.id = conflicting.media_item_id
            where conflicting.album_media_item_id = ${albumId} and conflicting.spotify_track_id is not null
              and conflicting.media_item_id <> t.track_media_item_id
              and lower(regexp_replace(trim(m.title), '[[:space:]]+', ' ', 'g'))
                = lower(regexp_replace(trim(source_item.title), '[[:space:]]+', ' ', 'g')))
        group by source.media_item_id
        having count(distinct t.track_media_item_id) = 1
          and bool_or(exists (select 1 from media_credit sc
            join media_credit tc on tc.artist_id = sc.artist_id
            where sc.media_item_id = source.media_item_id and tc.media_item_id = t.track_media_item_id
              and sc.role = 'artist' and tc.role = 'artist'))`)
    ).rows,
  )
  if (!pairs.length) return
  const allowed = await allowedMerges(database, pairs)
  if (!allowed.length) return

  const archived = await archiveTracks(
    database,
    allowed.map((pair) => pair.source_id),
  )
  const effects = new Map<string, ChangeEffectEntry[]>()
  const moves: RecordedNameMove[] = []
  for (const { source_id, target_id } of allowed) {
    effects.set(target_id, [
      ...(effects.get(target_id) ?? []),
      ...(await moveTrackMemberships(database, source_id, target_id, false)),
    ])
    const moved = MovedNamesSchema.parse(
      (
        await database.execute(sql`
          update lastfm_track_source s set track_media_item_id = ${target_id}
          where s.track_media_item_id = ${source_id}
          returning s.username, s.artist_key, s.track_key,
            s.manually_matched as manual`)
      ).rows,
    )
    moves.push(
      ...moved.map((name) => ({
        username: name.username,
        artistKey: name.artist_key,
        trackKey: name.track_key,
        fromId: source_id,
        fromManual: name.manual,
        toId: target_id,
        toManual: name.manual,
      })),
    )
    await database.execute(sql`
      insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
      select username, artist_key, track_key, ${target_id}, strategy
      from lastfm_track_link where track_media_item_id = ${source_id}
      on conflict do nothing`)
    await database.execute(sql`
      update library_track target
      set date_added = least(target.date_added, source.date_added),
        scrobble_count = stats.total, last_listened_at = stats.last
      from library_track source, (
        select count(*)::int as total, max(s.listened_at) as last
        from lastfm_track_link l
        join lastfm_scrobble s using (username, artist_key, track_key)
        where l.track_media_item_id = ${target_id}
      ) stats
      where target.media_item_id = ${target_id} and source.media_item_id = ${source_id}`)
    await database.execute(sql`delete from media_item where id = ${source_id}`)
  }
  await recordNameMoves(database, {
    moves,
    rule: 'album-history',
    batchId,
    archived,
    effects: (toId) => effects.get(toId) ?? [],
    details: (toId) => membershipDetails(effects.get(toId) ?? []),
  })
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
  batchId: string | null = null,
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
  pairs = await allowedMerges(database, pairs)

  for (let start = 0; start < pairs.length; start += WRITE_BATCH) {
    await mergeSpotifyAlbumRecordings(
      database,
      pairs.slice(start, start + WRITE_BATCH),
      batchId,
    )
  }
}

/**
 * Gives a generated album recording's positions, playlist entries and names
 * to the imported Spotify track of the same release, then removes it.
 * Recorded as one automatic change for each pair.
 */
async function mergeSpotifyAlbumRecordings(
  database: Transaction,
  pairs: z.infer<typeof DuplicateTracksSchema>,
  batchId: string | null,
) {
  const records = new Map(
    (
      await readChangeRecords(
        database,
        'track',
        pairs.flatMap((pair) => [pair.source_id, pair.target_id]),
      )
    ).map((record) => [record.id, record]),
  )
  const archived = await archiveTracks(
    database,
    pairs.map((pair) => pair.source_id),
  )
  const effects = new Map<string, ChangeEffectEntry[]>()
  for (const pair of pairs)
    effects.set(
      pair.target_id,
      await moveTrackMemberships(
        database,
        pair.source_id,
        pair.target_id,
        true,
      ),
    )
  const rows = sql`jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb)
    as pair(source_id text, target_id text, album_id text)`
  const moved = PairNamesSchema.parse(
    (
      await database.execute(sql`
          update lastfm_track_source s set track_media_item_id = pair.target_id
          from ${rows} where s.track_media_item_id = pair.source_id
          returning s.username, s.artist_key, s.track_key,
            s.manually_matched as manual, pair.source_id as from_id,
            pair.target_id as to_id`)
    ).rows,
  )
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

  const rule = 'spotify-album-recording'
  await recordNameMoves(database, {
    moves: moved.map((name) => ({
      username: name.username,
      artistKey: name.artist_key,
      trackKey: name.track_key,
      fromId: name.from_id,
      fromManual: name.manual,
      toId: name.to_id,
      toManual: name.manual,
    })),
    rule,
    batchId,
    archived,
    effects: (toId) => effects.get(toId) ?? [],
    details: (toId) => membershipDetails(effects.get(toId) ?? []),
  })
  // A recording without names is put back by its own effect.
  const named = new Set(moved.map((name) => name.from_id))
  for (const pair of pairs) {
    if (named.has(pair.source_id)) continue
    const moves = effects.get(pair.target_id) ?? []
    const source = records.get(pair.source_id)
    await recordChange(
      database,
      {
        kind: 'track',
        action: 'merge',
        actor: 'automatic',
        rule,
        batchId,
        target: records.get(pair.target_id) ?? null,
        sources: source ? [source] : [],
        details: membershipDetails(moves),
      },
      {
        draft: {
          before: [],
          records: [],
          archived: archived.filter((track) => track.id === pair.source_id),
        },
        // Undoing it keeps the two separate, so it is not made again.
        effects: [
          ...moves,
          removedTracksEntry([pair.source_id], pair.target_id),
        ],
      },
    )
  }
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
