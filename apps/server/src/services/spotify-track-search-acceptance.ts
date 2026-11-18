import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  SpotifyTrackSearchTargetConflictSchema,
  type SpotifyTrackSearchCandidate,
} from '@repo/schemas/spotify-track-search'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { slugifyParts } from '@/lib/media-utils'
import { SpotifyIdSchema } from '@/lib/spotify-api'
import { libraryTrack, mediaItem, scrapeJob } from '@/schemas/db'
import {
  independentTrackData,
  lockLibraryTrackWrites,
  removeOrphanTracks,
  spotifyAlbumReleaseIds,
} from './album-library-tracks'
import {
  readSpotifyTrackSearchCandidate,
  readSpotifyTrackSearchForAutomaticMatch,
} from './spotify-track-search'
import {
  spotifySearchConsistentRecording,
  spotifySearchExactRelease,
  spotifySearchHasAlternateVersion,
  spotifySearchMatchesDestination,
  spotifySearchRecordingEvidence,
  spotifySearchTargetConflicts,
} from './spotify-track-search-evidence'
import {
  replaceSpotifyTrackCredits,
  resolveSpotifyTrackIds,
  spotifyTrackItemId,
} from './spotify-playlists'
import { listTracksNeedingSpotifyMatch } from './track-match-diagnostics'
import {
  moveTrackScrobbleNames,
  transferTrackMemberships,
} from './track-merges'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type MatchMethod = 'automatic' | 'manual'
type SearchScope = { trackId: string; jobId: string; userId: string | null }
type ReconciliationResult =
  | { status: 'matched'; targetId: string }
  | { status: 'unmatched' | 'stale' }

/** Confirming a recording must preserve independently recorded release positions and annotations. */
async function checkRecordingTransfer(
  tx: Transaction,
  source: { id: string; title: string },
  targetId: string,
  candidate: SpotifyTrackSearchCandidate,
) {
  const sourceId = source.id
  const result = await tx.execute(sql`
    select exists (
      select 1 from track t join library_track lt on lt.media_item_id = t.track_media_item_id
      where (t.track_media_item_id = ${sourceId}
        or (t.track_media_item_id = ${targetId} and lt.spotify_track_id is distinct from ${candidate.spotifyTrackId})) and (
        (t.external_id ~ '^[A-Za-z0-9]{22}$' and t.external_id <> ${candidate.spotifyTrackId})
        or exists (select 1 from (${spotifyAlbumReleaseIds()}) r where r.album_id = t.album_media_item_id
          and r.spotify_id is not null and r.spotify_id is distinct from ${candidate.spotifyAlbumId}::text)
        or (t.track_media_item_id = ${sourceId} and ${sourceId}::text <> ${targetId}::text and exists (
          select 1 from track other where other.album_media_item_id = t.album_media_item_id
            and other.track_media_item_id = ${targetId} and other.position <> t.position))
      )
    ) as conflicting_release,
    exists (select 1 from media_item mi join library_track lt on lt.media_item_id = mi.id
      where mi.id = ${sourceId} and ${sourceId}::text <> ${targetId}::text and (
      coalesce(mi.source_label,'') not in ('album','lastfm')
      or (mi.source_label = 'album' and (mi.slug <> mi.id or exists (
        select 1 from track t where t.track_media_item_id = mi.id and lower(trim(t.title)) <> lower(trim(mi.title)))))
      or (mi.source_label = 'lastfm' and mi.slug <> ${slugifyParts(source.title, sourceId)})
      or (lt.isrc is not null and lt.isrc is distinct from ${candidate.isrc}::text)
      or (lt.spotify_url is not null and lt.spotify_url <> ${candidate.spotifyUrl})
      or (lt.duration_sec is not null and lt.duration_sec <> ${candidate.durationSec})
      or mi.summary is not null or mi.original_title is not null or mi.release_date is not null
      or mi.artwork_url is not null or coalesce(mi.metadata, '{}'::jsonb) <> '{}'::jsonb
      or ${independentTrackData(sql`mi.id`)}
    )) as has_annotations`)
  const flags = z
    .object({ conflicting_release: z.boolean(), has_annotations: z.boolean() })
    .parse(result.rows[0])
  if (flags.conflicting_release)
    throw new ServerError({
      statusCode: 409,
      message:
        'This Spotify version conflicts with the stored album position. Choose the version on that release.',
    })
  if (flags.has_annotations)
    throw new ServerError({
      statusCode: 409,
      message:
        'This track has independently saved metadata. Use Sources to link its scrobbled names individually.',
    })
}

async function libraryRecording(tx: Transaction, id: string) {
  const [row] = await tx
    .select({
      id: mediaItem.id,
      title: mediaItem.title,
      source: mediaItem.sourceLabel,
      spotifyId: libraryTrack.spotifyTrackId,
      hasArtists: sql<boolean>`exists (select 1 from media_credit c where c.media_item_id = ${mediaItem.id} and c.role = 'artist')`,
      hidden: sql<boolean>`coalesce(${mediaItem.metadata}->>'legacyHidden' = 'true', false)`,
    })
    .from(mediaItem)
    .innerJoin(libraryTrack, eq(libraryTrack.mediaItemId, mediaItem.id))
    .where(eq(mediaItem.id, id))
  return row
}

async function storeConfirmedRecording(
  tx: Transaction,
  targetId: string,
  candidate: SpotifyTrackSearchCandidate,
  jobId: string,
  matchMethod: MatchMethod,
) {
  const existing = await libraryRecording(tx, targetId)
  if (existing?.hidden)
    throw new ServerError({
      statusCode: 409,
      message: 'The selected Spotify recording is hidden in the library.',
    })
  const metadata = {
    spotifyTrackSearch: {
      title: candidate.title,
      artists: candidate.artists,
      spotifyTrackId: candidate.spotifyTrackId,
      matchMethod,
    },
    ...(candidate.artistCredits.length
      ? {
          spotifyArtistCredits: candidate.artistCredits,
          spotifyArtistCreditsSource: { source: 'spotify-search', jobId },
        }
      : {}),
  }
  await tx
    .insert(mediaItem)
    .values({
      id: targetId,
      mediaType: 'track',
      slug: slugifyParts(candidate.title, targetId),
      title: candidate.title,
      artworkUrl: candidate.artworkUrl,
      sourceLabel: 'spotify-search',
      metadata,
    })
    .onConflictDoUpdate({
      target: mediaItem.id,
      set: {
        sourceLabel:
          existing?.spotifyId === candidate.spotifyTrackId
            ? existing.source
            : 'spotify-search',
        artworkUrl: sql`coalesce(${mediaItem.artworkUrl}, excluded.artwork_url)`,
        metadata: sql`coalesce(${mediaItem.metadata}, '{}'::jsonb) ||
          case when ${matchMethod} = 'automatic' and ${mediaItem.metadata} ? 'spotifyTrackSearch'
            then excluded.metadata - 'spotifyTrackSearch' else excluded.metadata end`,
        updatedAt: new Date(),
      },
    })
  await tx
    .insert(libraryTrack)
    .values({
      mediaItemId: targetId,
      spotifyTrackId: candidate.spotifyTrackId,
      spotifyUrl: candidate.spotifyUrl,
      durationSec: candidate.durationSec,
      isrc: candidate.isrc,
      spotifyAlbumId: candidate.spotifyAlbumId,
      albumName: candidate.albumName,
    })
    .onConflictDoUpdate({
      target: libraryTrack.mediaItemId,
      set: {
        spotifyTrackId: candidate.spotifyTrackId,
        spotifyUrl: candidate.spotifyUrl,
        durationSec: sql`coalesce(${libraryTrack.durationSec}, excluded.duration_sec)`,
        isrc: sql`coalesce(${libraryTrack.isrc}, excluded.isrc)`,
        spotifyAlbumId: sql`coalesce(excluded.spotify_album_id, ${libraryTrack.spotifyAlbumId})`,
        albumName:
          matchMethod === 'automatic'
            ? sql`coalesce(${libraryTrack.albumName}, excluded.album_name)`
            : sql`coalesce(excluded.album_name, ${libraryTrack.albumName})`,
        updatedAt: new Date(),
      },
    })
  if (!existing?.hasArtists)
    await replaceSpotifyTrackCredits(tx, [
      { id: targetId, artists: candidate.artists },
    ])
  if (candidate.spotifyAlbumId)
    await tx.execute(sql`
    update library_track set album_media_item_id = matched.id, album_link_strategy = 'spotify-album'
    from (select min(r.album_id) as id from (${spotifyAlbumReleaseIds()}) r
      join media_item album on album.id = r.album_id where r.spotify_id = ${candidate.spotifyAlbumId}
        and album.metadata->>'legacyHidden' is distinct from 'true' having count(distinct r.album_id) = 1) matched
    where media_item_id = ${targetId} and not exists (
      select 1 from track position where position.track_media_item_id = library_track.media_item_id
        and position.album_media_item_id = library_track.album_media_item_id)`)
}

const AcceptedSchema = z.object({
  acceptedTrackId: z.string(),
  acceptedSpotifyTrackId: z.string(),
})

async function resolveRecordingTarget(
  tx: Transaction,
  source: { id: string; source: string | null },
  candidate: SpotifyTrackSearchCandidate,
) {
  const resolved = await resolveSpotifyTrackIds(tx, [candidate])
  return (
    resolved.get(candidate.spotifyTrackId) ??
    (source.source === 'lastfm'
      ? spotifyTrackItemId(candidate.spotifyTrackId)
      : source.id)
  )
}

async function linkSpotifyRecording(
  tx: Transaction,
  { trackId, jobId }: SearchScope,
  targetId: string,
  candidate: SpotifyTrackSearchCandidate,
  matchMethod: MatchMethod,
  reusedSpotifyTrackId = false,
) {
  await storeConfirmedRecording(tx, targetId, candidate, jobId, matchMethod)
  if (targetId !== trackId)
    await transferTrackMemberships(tx, trackId, targetId, true)
  await moveTrackScrobbleNames(
    tx,
    trackId,
    targetId,
    false,
    trackId !== targetId,
    matchMethod === 'manual' ? 'manual' : 'exact',
  )
  if (targetId !== trackId) await removeOrphanTracks(tx, [trackId])
  await tx
    .update(scrapeJob)
    .set({
      options: sql`${scrapeJob.options} || ${JSON.stringify({
        acceptedTrackId: targetId,
        acceptedSpotifyTrackId: candidate.spotifyTrackId,
        matchMethod,
        ...(matchMethod === 'automatic' && reusedSpotifyTrackId
          ? {
              matchedExistingSpotifyTrackId: SpotifyIdSchema.parse(
                candidate.spotifyTrackId,
              ),
            }
          : {}),
      })}::jsonb`,
    })
    .where(eq(scrapeJob.id, jobId))
}

/** The worker calls this after saving the candidates, within its cancellation fence. */
export async function reconcileSpotifyTrackSearchInTransaction(
  tx: Transaction,
  input: SearchScope,
  dryRun = false,
): Promise<ReconciliationResult> {
  await lockLibraryTrackWrites(tx)
  const candidates = await readSpotifyTrackSearchForAutomaticMatch(tx, input)
  if (
    !candidates ||
    !(await listTracksNeedingSpotifyMatch(tx, [input.trackId])).length
  )
    return { status: 'stale' }
  if (!candidates.length) return { status: 'unmatched' }

  const source = await libraryRecording(tx, input.trackId)
  const evidence = await spotifySearchRecordingEvidence(tx, input.trackId)
  if (!source || !evidence || source.spotifyId !== null)
    return { status: 'stale' }

  // Different Spotify IDs stay reviewable when the release cannot distinguish them.
  const exact = new Map(
    candidates
      .filter((candidate) =>
        spotifySearchExactRelease(evidence, candidate, {
          standaloneSource: true,
        }),
      )
      .map((candidate) => [candidate.spotifyTrackId, candidate]),
  )
  const [candidate] = exact.values()
  if (
    exact.size !== 1 ||
    !candidate ||
    spotifySearchHasAlternateVersion(evidence, candidate, candidates) ||
    !spotifySearchConsistentRecording(evidence, candidate)
  )
    return { status: 'unmatched' }

  const targetId = await resolveRecordingTarget(tx, source, candidate)
  let reusedSpotifyTrackId = false
  if (targetId !== source.id) {
    const target = await libraryRecording(tx, targetId)
    const targetEvidence =
      target && (await spotifySearchRecordingEvidence(tx, targetId))
    if (
      target &&
      (!targetEvidence ||
        !spotifySearchMatchesDestination(targetEvidence, candidate))
    )
      return { status: 'unmatched' }
    reusedSpotifyTrackId = target?.spotifyId === candidate.spotifyTrackId
  }
  try {
    await checkRecordingTransfer(tx, source, targetId, candidate)
  } catch (error) {
    if (error instanceof ServerError && error.response.statusCode === 409)
      return { status: 'unmatched' }
    throw error
  }
  if (!dryRun)
    await linkSpotifyRecording(
      tx,
      input,
      targetId,
      candidate,
      'automatic',
      reusedSpotifyTrackId,
    )
  return { status: 'matched', targetId }
}

/** Apply or preview a past search using its retained results without another Spotify request. */
export function reconcileSavedSpotifyTrackSearch(
  input: SearchScope,
  { dryRun = false }: { dryRun?: boolean } = {},
) {
  return db.transaction((tx) =>
    reconcileSpotifyTrackSearchInTransaction(tx, input, dryRun),
  )
}

/** A reviewed catalog identity can reuse a Spotify or corroborated album recording. */
export async function acceptSpotifyTrackSearch(input: {
  trackId: string
  jobId: string
  spotifyTrackId: string
  userId: string
}) {
  return db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    const { trackId, jobId, spotifyTrackId } = input
    const candidate = await readSpotifyTrackSearchCandidate(tx, input)
    const [job] = await tx
      .select({ options: scrapeJob.options })
      .from(scrapeJob)
      .where(eq(scrapeJob.id, jobId))
    const previous = AcceptedSchema.safeParse(job?.options)
    if (previous.success) {
      const kept = await libraryRecording(tx, previous.data.acceptedTrackId)
      if (
        previous.data.acceptedSpotifyTrackId === spotifyTrackId &&
        kept?.spotifyId === spotifyTrackId &&
        !kept.hidden
      )
        return { targetId: kept.id }
      throw new ServerError({
        statusCode: 409,
        message:
          'This search was already used. Review the current track match.',
      })
    }
    const source = await libraryRecording(tx, trackId)
    if (!source || source.hidden)
      throw new ServerError({
        statusCode: 404,
        message: 'Library track not found.',
      })
    if (
      source.spotifyId !== spotifyTrackId &&
      !(await listTracksNeedingSpotifyMatch(tx, [trackId])).length
    )
      throw new ServerError({
        statusCode: 409,
        message:
          'This recording already has a Spotify match. Refresh the track to review it.',
      })
    const targetId = await resolveRecordingTarget(tx, source, candidate)
    await checkRecordingTransfer(tx, source, targetId, candidate)
    if (targetId !== trackId) {
      const target = await spotifySearchRecordingEvidence(tx, targetId, {
        includeScrobbles: false,
      })
      if (target && spotifySearchTargetConflicts(target, candidate))
        throw new ServerError({
          statusCode: 409,
          message:
            'This Spotify result conflicts with the library recording that would receive these scrobbles.',
          data: SpotifyTrackSearchTargetConflictSchema.parse({
            code: 'spotify-track-target-conflict',
            trackId: targetId,
            title:
              target.title.trim().slice(0, 500).trimEnd() || 'Library track',
          }),
        })
    }
    await linkSpotifyRecording(tx, input, targetId, candidate, 'manual')
    return { targetId }
  })
}
