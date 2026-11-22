import { eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  SpotifyTrackSearchTargetConflictSchema,
  type SpotifyTrackSearchCandidate,
} from '@repo/schemas/spotify-track-search'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { slugifyParts } from '@/lib/media-utils'
import { SpotifyIdSchema } from '@/lib/spotify-api'
import { scrapeJob } from '@/schemas/db'
import {
  independentTrackData,
  lockLibraryTrackWrites,
  removeOrphanTracks,
  spotifyAlbumReleaseIds,
  type AlbumFallbackArtistCreditCorrection,
} from './album-library-tracks'
import {
  createdTracksEntry,
  membershipDetails,
  readJobOptions,
  readTrackRowImage,
  removedTracksEntry,
  searchAcceptanceEntry,
  trackRowStateEntry,
} from './automatic-match-effects'
import { readKeptSeparateTest } from './keep-separate-effects'
import type { ChangeEffectEntry } from './library-change-effect'
import {
  beginTrackChange,
  readChangeRecords,
  recordTrackChange,
} from './library-changes'
import { readRejectionTest } from './library-match-rejections'
import {
  readSpotifyTrackSearchCandidate,
  readSpotifyTrackSearchForAutomaticMatch,
} from './spotify-track-search'
import {
  type RecordingEvidence,
  readSpotifyAlbumFallbackArtistCreditCorrection,
  sameSpotifySearchArtists,
  spotifySearchMatchesObservedAlbum,
  spotifySearchMatchesSource,
  spotifySearchMatchesTitleVersion,
  spotifySearchHasAlternateVersion,
  spotifySearchMatchesDestination,
  spotifySearchRecordingEvidence,
  spotifySearchTargetConflicts,
} from './spotify-track-search-evidence'
import { resolveSpotifyTrackIds, spotifyTrackItemId } from './spotify-playlists'
import {
  libraryRecording,
  storeConfirmedRecording,
} from './spotify-track-recordings'
export { libraryRecording } from './spotify-track-recordings'
import { archiveTracks } from './track-archive'
import { listTracksNeedingSpotifyMatch } from './track-match-diagnostics'
import {
  moveTrackScrobbleNames,
  transferTrackMemberships,
} from './track-merges'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type MatchMethod = 'automatic' | 'manual'
type SearchScope = { trackId: string; jobId: string; userId: string | null }
type ReconciliationResult =
  | {
      status: 'matched'
      targetId: string
      albumFallbackArtistCreditCorrection?: AlbumFallbackArtistCreditCorrection
    }
  | { status: 'unmatched' | 'stale' }

/** Confirming a recording must preserve independently recorded release positions and annotations. */
export async function spotifyRecordingTransferConflict(
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
  if (flags.conflicting_release) return 'position'
  if (flags.has_annotations) return 'metadata'
  return undefined
}

const AcceptedSchema = z.object({
  acceptedTrackId: z.string(),
  acceptedSpotifyTrackId: z.string(),
})

export function newRecordingTarget(
  source: { id: string; source: string | null },
  candidate: SpotifyTrackSearchCandidate,
) {
  return source.source === 'lastfm'
    ? spotifyTrackItemId(candidate.spotifyTrackId)
    : source.id
}

async function rankSpotifySearchCandidates(
  tx: Transaction,
  source: RecordingEvidence,
  candidates: SpotifyTrackSearchCandidate[],
) {
  const targets = await resolveSpotifyTrackIds(tx, candidates, {
    choosingOneCandidate: true,
  })
  const albumIds = [
    ...new Set(
      candidates.flatMap(({ spotifyAlbumId }) =>
        spotifyAlbumId ? [spotifyAlbumId] : [],
      ),
    ),
  ]
  const libraryReleases = new Set<string>()
  if (candidates.length > 1 && albumIds.length) {
    const result = await tx.execute(sql`
      select r.spotify_id from (${spotifyAlbumReleaseIds()}) r
      join media_item album on album.id = r.album_id
      where ${inArray(sql`r.spotify_id`, albumIds)}
        and album.metadata->>'legacyHidden' is distinct from 'true'
      group by r.spotify_id having count(distinct r.album_id) = 1`)
    for (const row of z
      .array(z.object({ spotify_id: z.string() }))
      .parse(result.rows))
      libraryReleases.add(row.spotify_id)
  }
  return candidates
    .map((candidate) => ({
      candidate,
      targetId: targets.get(candidate.spotifyTrackId),
      exactVersion: spotifySearchMatchesTitleVersion(source, candidate),
      observedAlbum: spotifySearchMatchesObservedAlbum(source, candidate),
      libraryAlbum:
        candidate.spotifyAlbumId !== null &&
        libraryReleases.has(candidate.spotifyAlbumId),
      exactCredits: sameSpotifySearchArtists(source.artists, candidate.artists),
    }))
    .sort(
      (a, b) =>
        Number(b.exactVersion) - Number(a.exactVersion) ||
        Number(b.observedAlbum) - Number(a.observedAlbum) ||
        Number(b.libraryAlbum) - Number(a.libraryAlbum) ||
        Number(!!b.targetId) - Number(!!a.targetId) ||
        Number(b.exactCredits) - Number(a.exactCredits) ||
        (b.candidate.popularity ?? -1) - (a.candidate.popularity ?? -1),
    )
}

/** The options a confirmed search writes on its job. */
const ACCEPTANCE_KEYS = [
  'acceptedTrackId',
  'acceptedSpotifyTrackId',
  'matchMethod',
  'albumFallbackArtistCreditCorrection',
  'matchedExistingSpotifyTrackId',
]

/**
 * Gives the searched track's names, album positions and playlist entries to
 * the confirmed Spotify recording and records the change: automatic for a
 * search the app matched, the owner's for an accepted one.
 */
async function linkSpotifyRecording(
  tx: Transaction,
  { trackId, jobId }: SearchScope,
  targetId: string,
  candidate: SpotifyTrackSearchCandidate,
  matchMethod: MatchMethod,
  {
    reusedSpotifyTrackId = false,
    albumFallbackArtistCreditCorrection,
    batchId = null,
  }: {
    reusedSpotifyTrackId?: boolean
    albumFallbackArtistCreditCorrection?: AlbumFallbackArtistCreditCorrection
    batchId?: string | null
  } = {},
) {
  const automatic = matchMethod === 'automatic'
  const merged = targetId !== trackId
  const draft = await beginTrackChange(tx, { trackIds: [trackId] })
  const sources = merged ? await readChangeRecords(tx, 'track', [trackId]) : []
  // A source without names is put back by its own effect, not with names.
  const unnamed =
    merged && !draft.before.length ? await archiveTracks(tx, [trackId]) : []
  const before = await readTrackRowImage(tx, targetId)
  const jobBefore = automatic
    ? {}
    : await readJobOptions(tx, jobId, ACCEPTANCE_KEYS)
  await storeConfirmedRecording(tx, targetId, candidate, {
    jobId,
    matchMethod,
    albumFallbackArtistCreditCorrection,
  })
  const effects: ChangeEffectEntry[] = []
  const after = before && (await readTrackRowImage(tx, targetId))
  const changed = before && after && trackRowStateEntry(targetId, before, after)
  if (!before) effects.push(createdTracksEntry([targetId]))
  else if (changed) effects.push(changed)
  // A track the change made takes the album of the positions it receives
  // with it, so Redo makes it again as the move left it.
  if (merged && !before)
    await tx.execute(sql`
      update library_track target
      set album_media_item_id = source.album_media_item_id,
        album_link_strategy = 'album-track-list'
      from library_track source
      where target.media_item_id = ${targetId} and source.media_item_id = ${trackId}
        and (target.album_media_item_id is null
          or target.album_media_item_id = source.album_media_item_id)
        and exists (select 1 from track t where t.track_media_item_id = ${trackId}
          and t.album_media_item_id = source.album_media_item_id)`)
  if (merged)
    effects.push(
      ...(await transferTrackMemberships(tx, trackId, targetId, true)),
    )
  await moveTrackScrobbleNames(
    tx,
    trackId,
    targetId,
    false,
    trackId !== targetId,
    matchMethod === 'manual' ? 'manual' : 'exact',
  )
  if (merged) await removeOrphanTracks(tx, [trackId])
  if (unnamed.length) effects.push(removedTracksEntry([trackId]))
  await tx
    .update(scrapeJob)
    .set({
      options: sql`${scrapeJob.options} || ${JSON.stringify({
        acceptedTrackId: targetId,
        acceptedSpotifyTrackId: candidate.spotifyTrackId,
        matchMethod,
        ...(albumFallbackArtistCreditCorrection
          ? { albumFallbackArtistCreditCorrection }
          : {}),
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
  // An undone automatic match leaves its search marked as used, so the same
  // search is not applied again.
  if (!automatic)
    effects.push(
      searchAcceptanceEntry(
        jobId,
        ACCEPTANCE_KEYS,
        jobBefore,
        await readJobOptions(tx, jobId, ACCEPTANCE_KEYS),
        [trackId, targetId],
      ),
    )
  const [target] = await readChangeRecords(tx, 'track', [targetId])
  await recordTrackChange(
    tx,
    { ...draft, archived: [...draft.archived, ...unnamed] },
    {
      action: merged ? 'merge' : 'move',
      actor: automatic ? 'automatic' : 'owner',
      rule: automatic ? 'spotify-search' : null,
      batchId,
      target: target ?? null,
      sources,
      details: membershipDetails(effects),
      effects,
    },
  )
}

/** Resolve the same retained-recording checks for automatic matches and their explanations. */
export async function checkSpotifySearchDestination(
  tx: Transaction,
  sourceId: string,
  targetId: string,
  candidate: SpotifyTrackSearchCandidate,
) {
  if (targetId === sourceId) return { compatible: true }
  const target = await libraryRecording(tx, targetId)
  if (!target) return { compatible: true }
  const evidence = await spotifySearchRecordingEvidence(tx, targetId)
  if (!evidence) return { compatible: false }
  const matches = spotifySearchMatchesDestination(evidence, candidate)
  const albumFallbackArtistCreditCorrection = matches
    ? undefined
    : await readSpotifyAlbumFallbackArtistCreditCorrection(
        tx,
        targetId,
        candidate,
        evidence,
      )
  return {
    compatible: matches || Boolean(albumFallbackArtistCreditCorrection),
    evidence,
    reusedSpotifyTrackId: target.spotifyId === candidate.spotifyTrackId,
    albumFallbackArtistCreditCorrection,
  }
}

const NameRowsSchema = z.array(
  z.object({
    username: z.string(),
    artist_key: z.string(),
    track_key: z.string(),
  }),
)

/**
 * Whether an automatic match must not give the source's names to a target:
 * the owner undid or separated that match, or keeps the two tracks separate.
 */
async function readForbiddenTargets(
  tx: Transaction,
  sourceId: string,
  targetIds: string[],
) {
  const names = NameRowsSchema.parse(
    (
      await tx.execute(sql`
        select username, artist_key, track_key from lastfm_track_source
        where track_media_item_id = ${sourceId}`)
    ).rows,
  )
  const rejected = new Map<
    string,
    Awaited<ReturnType<typeof readRejectionTest>>
  >()
  for (const username of new Set(names.map((name) => name.username)))
    rejected.set(username, await readRejectionTest(tx, username))
  const kept = await readKeptSeparateTest(tx, 'track', [sourceId, ...targetIds])
  return (targetId: string) =>
    targetId !== sourceId &&
    (kept(sourceId, targetId) ||
      names.some((name) =>
        rejected.get(name.username)?.(
          name.artist_key,
          name.track_key,
          targetId,
        ),
      ))
}

/** The worker calls this after saving the candidates, within its cancellation fence. */
export async function reconcileSpotifyTrackSearchInTransaction(
  tx: Transaction,
  input: SearchScope,
  dryRun = false,
  batchId: string | null = null,
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

  const eligible = candidates.filter(
    (candidate) =>
      spotifySearchMatchesSource(evidence, candidate) &&
      !spotifySearchHasAlternateVersion(evidence, candidate, candidates),
  )
  const ranked = await rankSpotifySearchCandidates(tx, evidence, eligible)
  const forbidden = await readForbiddenTargets(
    tx,
    source.id,
    ranked.map(
      (choice) =>
        choice.targetId ?? newRecordingTarget(source, choice.candidate),
    ),
  )
  for (const choice of ranked) {
    const { candidate } = choice
    const targetId = choice.targetId ?? newRecordingTarget(source, candidate)
    if (forbidden(targetId)) continue
    const destination = await checkSpotifySearchDestination(
      tx,
      source.id,
      targetId,
      candidate,
    )
    if (!destination.compatible) continue
    const { reusedSpotifyTrackId, albumFallbackArtistCreditCorrection } =
      destination
    if (await spotifyRecordingTransferConflict(tx, source, targetId, candidate))
      continue
    if (!dryRun)
      await linkSpotifyRecording(tx, input, targetId, candidate, 'automatic', {
        reusedSpotifyTrackId,
        albumFallbackArtistCreditCorrection,
        batchId,
      })
    return {
      status: 'matched',
      targetId,
      ...(albumFallbackArtistCreditCorrection
        ? { albumFallbackArtistCreditCorrection }
        : {}),
    }
  }
  return { status: 'unmatched' }
}

/** Apply or preview a past search using its retained results without another Spotify request. */
export function reconcileSavedSpotifyTrackSearch(
  input: SearchScope,
  {
    dryRun = false,
    batchId = null,
  }: { dryRun?: boolean; batchId?: string | null } = {},
) {
  return db.transaction((tx) =>
    reconcileSpotifyTrackSearchInTransaction(tx, input, dryRun, batchId),
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
    const targets = await resolveSpotifyTrackIds(tx, [candidate])
    const targetId =
      targets.get(spotifyTrackId) ?? newRecordingTarget(source, candidate)
    const conflict = await spotifyRecordingTransferConflict(
      tx,
      source,
      targetId,
      candidate,
    )
    if (conflict)
      throw new ServerError({
        statusCode: 409,
        message:
          conflict === 'position'
            ? 'This Spotify version conflicts with the stored album position. Choose the version on that release.'
            : 'This track has independently saved metadata. Use Sources to link its scrobbled names individually.',
      })
    let albumFallbackArtistCreditCorrection:
      | AlbumFallbackArtistCreditCorrection
      | undefined
    if (targetId !== trackId) {
      const target = await spotifySearchRecordingEvidence(tx, targetId, {
        includeScrobbles: false,
      })
      if (target && spotifySearchTargetConflicts(target, candidate)) {
        albumFallbackArtistCreditCorrection =
          await readSpotifyAlbumFallbackArtistCreditCorrection(
            tx,
            targetId,
            candidate,
            target,
            { recordingIncludesScrobbles: false },
          )
        if (!albumFallbackArtistCreditCorrection)
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
    }
    await linkSpotifyRecording(tx, input, targetId, candidate, 'manual', {
      albumFallbackArtistCreditCorrection,
    })
    return { targetId }
  })
}
