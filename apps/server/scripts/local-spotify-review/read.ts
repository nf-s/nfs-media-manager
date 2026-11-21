import { inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { spotifyIdPattern } from '@repo/schemas/playback'
import {
  SpotifyTrackAuditItemSchema,
  type SpotifyTrackAuditItem,
  type SpotifyTrackAuditReason,
  type SpotifyTrackAuditAssessment,
  type SpotifyTrackSearchCandidate,
} from '@repo/schemas/spotify-track-search'
import { db } from '@/lib/db'
import { artistKeys } from '@/lib/lastfm-album-matching'
import { trackBaseKey } from '@/lib/track-matching'
import { libraryTrack } from '@/schemas/db'
import { spotifyAlbumReleaseIds } from '@/services/album-library-tracks'
import { playableSpotifyId } from '@/services/recording-groups'
import { resolveSpotifyTrackIds } from '@/services/spotify-playlists'
import {
  readSpotifyTrackSearchForAutomaticMatch,
  readSpotifySearchHistory,
} from '@/services/spotify-track-search'
import {
  checkSpotifySearchDestination,
  libraryRecording,
  newRecordingTarget,
  spotifyRecordingTransferConflict,
} from '@/services/spotify-track-search-acceptance'
import {
  type RecordingEvidence,
  spotifySearchRecordingEvidence,
  spotifySearchDestinationReasons,
  spotifySearchSourceReasons,
} from '@/services/spotify-track-search-evidence'
import { listTracksNeedingSpotifyMatch } from '@/services/track-match-diagnostics'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
const assessmentOrder = { likely: 0, review: 1, unlikely: 2 }

function assessRecording(
  source: RecordingEvidence,
  candidate: SpotifyTrackSearchCandidate,
  reasons: SpotifyTrackAuditReason[],
): SpotifyTrackAuditAssessment {
  const codes = new Set(reasons.map((reason) => reason.code))
  const artists = new Set(source.artists.flatMap(artistKeys).filter(Boolean))
  const artistOverlap = candidate.artists
    .flatMap(artistKeys)
    .some((name) => artists.has(name))
  const titleMatches = !codes.has('source-title')
  const artistsMatch =
    source.artists.length > 0 && !codes.has('source-artist-credit')
  if (titleMatches && artistsMatch) {
    if (
      [
        'source-isrc',
        'source-duration',
        'source-alternate-version',
        'source-spotify-track-id',
        'source-spotify-track-link',
        'source-spotify-artist-id',
        'source-position-title',
        'source-scrobble-title',
        'source-position-artist-credit',
        'source-scrobble-artist-credit',
      ].some((code) => codes.has(code))
    )
      return 'review'
    return 'likely'
  }
  if (titleMatches && (artistOverlap || !source.artists.length)) return 'review'
  if (
    artistOverlap &&
    trackBaseKey(source.title) === trackBaseKey(candidate.title)
  )
    return 'review'
  return 'unlikely'
}

const latestSearchReason: SpotifyTrackAuditReason = {
  code: 'historical-search',
  explanation: 'A newer search superseded this result for automatic matching.',
  library: 'Newer search on record',
  spotify: 'Earlier saved result',
}
function jobReason(
  code: string,
  explanation: string,
  library: string,
  spotify: string,
) {
  return { code, explanation, library, spotify }
}

async function savedCandidates(
  tx: Transaction,
  trackId: string,
  ownerId: string,
) {
  const { job: latest, searches } = await readSpotifySearchHistory(
    tx,
    trackId,
    ownerId,
  )
  const items = []
  for (const { job, query, candidates, peers } of searches) {
    const historical = job.id !== latest?.id
    const reasons: SpotifyTrackAuditReason[] = []
    if (historical) reasons.push(latestSearchReason)
    if (job.options.reviewOnly)
      reasons.push(
        jobReason(
          'review-only',
          'This search was run for manual selection.',
          'Manual selection requested',
          'Saved candidate',
        ),
      )
    if (job.options.acceptedTrackId || job.options.acceptedSpotifyTrackId)
      reasons.push(
        jobReason(
          'previously-used',
          'This search has already been used to confirm a recording.',
          'Previous selection',
          'Saved candidate',
        ),
      )
    if (
      !reasons.length &&
      !(await readSpotifyTrackSearchForAutomaticMatch(tx, {
        jobId: job.id,
        trackId,
        userId: ownerId,
      }))
    )
      reasons.push(
        jobReason(
          'search-state',
          'The saved search is no longer eligible for automatic matching against the current track.',
          'Current track or search state differs',
          'Saved search',
        ),
      )
    for (const candidate of candidates)
      items.push({
        candidate,
        peers,
        query,
        reasons,
        historical,
        searchedAt: (job.finishedAt ?? job.createdAt).toISOString(),
      })
  }
  return items
}

async function albumLabels(tx: Transaction, trackId: string, ids: string[]) {
  const labels = new Map<string, string[]>()
  if (!ids.length) return labels
  const result = await tx.execute(sql`
    select r.spotify_id, mi.title from (${spotifyAlbumReleaseIds()}) r
    join media_item mi on mi.id = r.album_id
    where ${inArray(sql`r.spotify_id`, ids)}
    union select spotify_album_id, album_name from ${libraryTrack}
      where media_item_id = ${trackId} and spotify_album_id is not null and album_name is not null
    order by title`)
  for (const row of z
    .array(z.object({ spotify_id: z.string(), title: z.string() }))
    .parse(result.rows)) {
    const previous = labels.get(row.spotify_id) ?? []
    previous.push(row.title)
    labels.set(row.spotify_id, previous)
  }
  return labels
}

/** Reassess the owner's retained catalog results using the current library evidence. */
async function reviewTrack(tx: Transaction, trackId: string, ownerId: string) {
  const subject = await libraryRecording(tx, trackId)
  const saved =
    subject &&
    !subject.hidden &&
    !spotifyIdPattern.test(subject.spotifyId ?? '')
      ? await savedCandidates(tx, trackId, ownerId)
      : []
  const source = saved.length
    ? await spotifySearchRecordingEvidence(tx, trackId)
    : undefined
  if (!subject || !source) return null

  const covered = !(await listTracksNeedingSpotifyMatch(tx, [trackId])).length
  const comparisons = saved.map((item) => ({
    ...item,
    sourceReasons: spotifySearchSourceReasons(
      source,
      item.candidate,
      item.peers,
    ),
  }))
  const eligible = comparisons.filter((item) => !item.sourceReasons.length)
  const targets = await resolveSpotifyTrackIds(
    tx,
    eligible.map((item) => item.candidate),
    { choosingOneCandidate: true },
  )
  const candidates = []
  for (const {
    candidate,
    sourceReasons,
    reasons: jobReasons,
    query,
    searchedAt,
    historical,
  } of comparisons) {
    const reasons = [...sourceReasons]
    if (!sourceReasons.length) {
      const targetId =
        targets.get(candidate.spotifyTrackId) ??
        newRecordingTarget(subject, candidate)
      const destination = await checkSpotifySearchDestination(
        tx,
        trackId,
        targetId,
        candidate,
      )
      if (!destination.compatible) {
        if (destination.evidence)
          reasons.push(
            ...spotifySearchDestinationReasons(destination.evidence, candidate),
          )
        else
          reasons.push(
            jobReason(
              'destination-hidden',
              'The library recording that would receive this match is hidden.',
              'Hidden destination',
              candidate.title,
            ),
          )
      } else {
        const conflict = await spotifyRecordingTransferConflict(
          tx,
          subject,
          targetId,
          candidate,
        )
        if (conflict === 'position')
          reasons.push(
            jobReason(
              'transfer-position',
              'Linking this result would conflict with a saved album position.',
              'Existing release or track position',
              candidate.albumName ?? 'No Spotify album',
            ),
          )
        if (conflict === 'metadata')
          reasons.push(
            jobReason(
              'transfer-metadata',
              'Merging into this Spotify recording would affect independently saved track metadata.',
              'Independent track metadata',
              candidate.title,
            ),
          )
      }
    }
    if (covered)
      reasons.push(
        jobReason(
          'alternate-coverage',
          'The library already provides a playable alternate for this track.',
          'Playable alternate',
          candidate.title,
        ),
      )
    reasons.push(...jobReasons)
    const assessment = assessRecording(source, candidate, reasons)
    candidates.push({
      ...candidate,
      query,
      searchedAt,
      historical,
      assessment,
      reasons,
      summary:
        reasons[0]?.explanation ??
        'This candidate passes the current automatic matching checks.',
    })
  }
  candidates.sort(
    (a, b) =>
      assessmentOrder[a.assessment] - assessmentOrder[b.assessment] ||
      a.reasons.length - b.reasons.length,
  )
  const first = candidates[0]
  if (!first) throw new Error('Missing saved candidate for audit')
  // Display both the release name and the ID when different editions share a title.
  const releaseReasons = candidates.flatMap((candidate) =>
    candidate.reasons
      .filter((reason) => reason.code.endsWith('-spotify-album-id'))
      .map((reason) => ({ reason, spotifyName: candidate.albumName })),
  )
  const labels = await albumLabels(tx, trackId, [
    ...new Set([
      ...source.album_ids,
      ...releaseReasons.map(({ reason }) => reason.library),
    ]),
  ])
  const albums = [
    ...new Set([
      ...source.album_names,
      ...source.scrobbled_albums,
      ...source.album_ids.flatMap((id) => labels.get(id) ?? []),
    ]),
  ].sort()
  for (const { reason, spotifyName } of releaseReasons) {
    const libraryNames = labels.get(reason.library)
    if (libraryNames?.length)
      reason.library = libraryNames.join(' / ') + ' · ' + reason.library
    if (spotifyName) reason.spotify = spotifyName + ' · ' + reason.spotify
  }
  return SpotifyTrackAuditItemSchema.parse({
    trackId,
    title: source.title,
    artists: source.artists,
    albums,
    durations: source.durations,
    assessment: first.assessment,
    summary: first.summary,
    candidates,
  })
}

const SubjectSchema = z.object({ track_id: z.string(), owner_id: z.string() })

/** Keep the selected search history and library evidence in one read-only snapshot. */
export function readLocalSpotifyReview(ownerId?: string) {
  return db.transaction(
    async (tx) => {
      const rows =
        await tx.execute(sql`select distinct j.requested_by_user_id as owner_id, t.media_item_id as track_id
      from scrape_job j join library_track t on t.media_item_id in (j.options->>'trackId',j.options->>'acceptedTrackId')
      join media_item m on m.id=t.media_item_id
      where j.provider='spotify' and j.options->>'task'='spotify-track-search' and j.status='succeeded'
        and j.requested_by_user_id is not null and m.media_type='track' and m.metadata->>'legacyHidden' is distinct from 'true'
        and not ${playableSpotifyId(sql`t.spotify_track_id`)}
        ${ownerId === undefined ? sql`` : sql`and j.requested_by_user_id=${ownerId}`}
        and exists (select 1 from scrape_job_log l where l.job_id=j.id and jsonb_path_exists(l.metadata, '$.diagnostics[*] ? (@.kind == "spotify-track-search").candidates[0]'))
      order by track_id`)
      const subjects = SubjectSchema.array().parse(rows.rows)
      if (new Set(subjects.map((row) => row.owner_id)).size > 1)
        throw new Error('Choose one search owner with --owner-id.')
      const items: SpotifyTrackAuditItem[] = []
      for (const subject of subjects) {
        const item = await reviewTrack(tx, subject.track_id, subject.owner_id)
        if (item) items.push(item)
      }
      return items
    },
    { accessMode: 'read only', isolationLevel: 'repeatable read' },
  )
}
