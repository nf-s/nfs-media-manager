import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { spotifyIdPattern } from '@repo/schemas/playback'
import type {
  SpotifyTrackAuditReason,
  SpotifyTrackSearchCandidate,
} from '@repo/schemas/spotify-track-search'
import { albumNameKey } from '@/lib/album-import-candidates'
import {
  hasTrackVersionQualifier,
  hasUnmatchedVersionAlbum,
  splitScrobbleCredit,
  titleCredit,
} from '@/lib/album-track-aliases'
import type { db } from '@/lib/db'
import { isrcPattern, normalizedIsrc } from '@/lib/isrc'
import {
  artistKeys,
  artistNameKey,
  plainKey,
  splitArtistCredit,
} from '@/lib/lastfm-album-matching'
import { trackBaseKey, trackVersionKey } from '@/lib/track-matching'
import {
  AlbumFallbackArtistCreditCorrectionSchema,
  independentTrackData,
  isCompilationFallbackArtist,
  spotifyAlbumReleaseIds,
} from './album-library-tracks'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export function spotifySearchArtistNames(id: SQL) {
  return sql<string[]>`array(select a.name from media_credit c
    join artist a on a.id = c.artist_id
    where c.media_item_id = ${id} and c.role = 'artist'
    order by c.billing_order, a.id)`
}

const RecordingEvidenceSchema = z.object({
  title: z.string(),
  spotify_track_id: z.string().nullable(),
  has_manual_overrides: z.boolean(),
  artists: z.array(z.string()),
  artist_credits: z.array(z.object({ id: z.string(), name: z.string() })),
  track_ids: z.array(z.string()),
  spotify_url: z.string().nullable(),
  isrc: z.string().nullable(),
  durations: z.array(z.number()),
  position_titles: z.array(z.string()),
  album_ids: z.array(z.string()),
  album_names: z.array(z.string()),
  scrobbled_albums: z.array(z.string()),
  standalone_lastfm: z.boolean(),
  scrobbles: z.array(
    z.object({
      title: z.string(),
      artist: z.string(),
      manual: z.boolean(),
    }),
  ),
})
export type RecordingEvidence = z.infer<typeof RecordingEvidenceSchema>

type RecordingAudit = {
  side: 'source' | 'destination'
  reasons: SpotifyTrackAuditReason[]
}

// Returning true lets an audit collect the remaining mismatches. Live checks
// stop at the failed condition without building or formatting audit evidence.
function addMatchingReason(
  audit: RecordingAudit,
  code: string,
  detail: string,
  library: string,
  spotify: string,
) {
  const subject =
    audit.side === 'source' ? 'The searched track' : 'The retained track'
  audit.reasons.push({
    code: audit.side + '-' + code,
    explanation: subject + ' ' + detail,
    library: library || 'Unavailable',
    spotify: spotify || 'Unavailable',
  })
  return true
}

function evidenceList(values: Iterable<string>) {
  return [...new Set(values)].join(', ')
}

function spotifyTrackIdFromLink(link: string | null) {
  return /^(?:https:\/\/open\.spotify\.com\/track\/|spotify:track:)([A-Za-z0-9]{22})(?:[/?#]|$)/.exec(
    link ?? '',
  )?.[1]
}

function displaySpotifyId(id: string) {
  return spotifyIdPattern.test(id) ? id : 'Unrecognised Spotify ID'
}

export async function spotifySearchRecordingEvidence(
  tx: Transaction,
  id: string,
  { includeScrobbles = true }: { includeScrobbles?: boolean } = {},
) {
  const { rows } = await tx.execute(sql`
    with positions as (
      select title, external_id, duration_sec, album_media_item_id
      from track where track_media_item_id = ${id}
    ), recording as (
      select mi.id, mi.title, mi.metadata, mi.source_label, lt.spotify_track_id, lt.spotify_album_id,
        lt.album_media_item_id, lt.album_name, lt.duration_sec, lt.isrc, lt.spotify_url
      from media_item mi join library_track lt on lt.media_item_id = mi.id
      where mi.id = ${id} and mi.media_type = 'track'
        and mi.metadata->>'legacyHidden' is distinct from 'true'
    ), recorded_names as (
      select s.track_key, s.artist_key, s.manually_matched, s.username
      from lastfm_track_source s where s.track_media_item_id = ${id}
        ${includeScrobbles ? sql`` : sql`and false`}
      union
      select l.track_key, l.artist_key, l.strategy = 'manual', l.username
      from lastfm_track_link l where l.track_media_item_id = ${id}
        ${includeScrobbles ? sql`` : sql`and false`}
    ), scrobbles as (
      select distinct s.track_name, s.artist_name, n.manually_matched, s.album_name, s.album_media_item_id
      from recorded_names n join lastfm_scrobble s using (username, artist_key, track_key)
    ), releases as (
      select album_media_item_id from recording
      union select album_media_item_id from positions
      union select album_media_item_id from scrobbles
    ), spotify_releases as (
      select r.album_id, r.spotify_id
      from (${spotifyAlbumReleaseIds()}) r join releases on releases.album_media_item_id = r.album_id
      where r.spotify_id is not null
    )
    select title, ${spotifySearchArtistNames(sql`recording.id`)} as artists, spotify_url, isrc, spotify_track_id,
      exists (select 1 from media_override where media_item_id = recording.id
        union all select 1 from provider_reference_override where media_item_id = recording.id) as has_manual_overrides,
      (
        source_label is not distinct from 'lastfm' and spotify_album_id is null and spotify_track_id is null
        and not coalesce(metadata ? 'spotifyTrackSearch', false)
        and not exists (select 1 from positions)
        and not exists (select 1 from releases where album_media_item_id is not null)
      ) as standalone_lastfm,
      coalesce((select jsonb_agg(credit) from jsonb_path_query(metadata,
        '$.spotifyArtistCredits[*] ? (@.id.type() == "string" && @.name.type() == "string")'
      ) credit), '[]'::jsonb) as artist_credits,
      array(select * from (select spotify_track_id where spotify_track_id is not null
        union select metadata#>>'{spotifyTrackSearch,spotifyTrackId}'
          where jsonb_typeof(metadata#>'{spotifyTrackSearch,spotifyTrackId}') = 'string'
        union select external_id from positions where external_id collate "C" ~ ${spotifyIdPattern.source}) ids) as track_ids,
      array(select duration_sec where duration_sec > 0
        union select position.duration_sec from positions position where position.duration_sec > 0) as durations,
      array(select title from positions) as position_titles,
      array(select spotify_album_id where spotify_album_id is not null
        union select spotify_id from spotify_releases) as album_ids,
      array(select album_name where album_name is not null and spotify_album_id is null and not exists (select 1 from spotify_releases)
        union select m.title from releases join media_item m on m.id = releases.album_media_item_id
          where not exists (select 1 from spotify_releases r where r.album_id = m.id)
      ) as album_names,
      array(select distinct s.album_name from scrobbles s
          where s.album_name is not null and not exists (
            select 1 from spotify_releases r where r.album_id = s.album_media_item_id
          )) as scrobbled_albums,
      coalesce((select jsonb_agg(jsonb_build_object(
        'title', n.track_key, 'artist', n.artist_key, 'manual', n.manually_matched
      )) from recorded_names n), '[]'::jsonb) as scrobbles
    from recording`)
  return rows.length ? RecordingEvidenceSchema.parse(rows[0]) : undefined
}

export function sameSpotifySearchArtists(first: string[], second: string[]) {
  return (
    first.length > 0 &&
    first.length === second.length &&
    first.every((name, index) => {
      const other = second[index]
      return other !== undefined && albumNameKey(name) === albumNameKey(other)
    })
  )
}

function sameName(value: string | null, name: string) {
  return value !== null && albumNameKey(value) === albumNameKey(name)
}

function albumNames(recording: RecordingEvidence) {
  return [...recording.album_names, ...recording.scrobbled_albums].filter(
    (name) => albumNameKey(name),
  )
}

function spotifySearchReleaseIdsAgree(
  recording: RecordingEvidence,
  candidate: SpotifyTrackSearchCandidate,
  audit?: RecordingAudit,
) {
  return (
    recording.track_ids.every(
      (id) =>
        id === candidate.spotifyTrackId ||
        (audit !== undefined &&
          addMatchingReason(
            audit,
            'spotify-track-id',
            'has a different Spotify track ID.',
            displaySpotifyId(id),
            candidate.spotifyTrackId,
          )),
    ) &&
    recording.album_ids.every(
      (id) =>
        id === candidate.spotifyAlbumId ||
        (audit !== undefined &&
          addMatchingReason(
            audit,
            'spotify-album-id',
            'has a Spotify release ID that the result does not share.',
            displaySpotifyId(id),
            candidate.spotifyAlbumId ?? '',
          )),
    )
  )
}

function spotifySearchReleaseNamesAgree(
  recording: RecordingEvidence,
  candidate: SpotifyTrackSearchCandidate,
  namesMatch: typeof sameName,
  audit?: RecordingAudit,
) {
  return albumNames(recording).every(
    (name) =>
      namesMatch(candidate.albumName, name) ||
      (audit !== undefined &&
        addMatchingReason(
          audit,
          'album-name',
          'has a stored release name that differs from the Spotify release.',
          name,
          candidate.albumName ?? '',
        )),
  )
}

function spotifySearchExactRelease(
  recording: RecordingEvidence,
  candidate: SpotifyTrackSearchCandidate,
  {
    allowTargetTitleDiacritics = false,
  }: { allowTargetTitleDiacritics?: boolean } = {},
  audit?: RecordingAudit,
) {
  const titleKey = allowTargetTitleDiacritics
    ? diacriticInsensitiveTitleKey
    : albumNameKey
  const candidateTitle = titleKey(candidate.title)
  return (
    (candidateTitle === titleKey(recording.title) ||
      (audit !== undefined &&
        addMatchingReason(
          audit,
          'title',
          'has a title that differs from the Spotify title.',
          recording.title,
          candidate.title,
        ))) &&
    (sameSpotifySearchArtists(recording.artists, candidate.artists) ||
      (audit !== undefined &&
        addMatchingReason(
          audit,
          'artist-credit',
          'has different artist billing from the Spotify result.',
          evidenceList(recording.artists),
          evidenceList(candidate.artists),
        ))) &&
    recording.position_titles.every(
      (title) =>
        candidateTitle === titleKey(title) ||
        (audit !== undefined &&
          addMatchingReason(
            audit,
            'position-title',
            'has an album position title that differs from the Spotify title.',
            title,
            candidate.title,
          )),
    ) &&
    spotifySearchReleaseIdsAgree(recording, candidate, audit) &&
    spotifySearchReleaseNamesAgree(recording, candidate, sameName, audit)
  )
}

function diacriticInsensitiveTitleKey(title: string) {
  const key = albumNameKey(title)
  return key.normalize('NFD').replace(/\p{M}/gu, '') || key
}

function sameSourceName(first: string | null, second: string) {
  return first !== null && plainKey(first) === plainKey(second)
}

/** A standalone recording can have several original, unlinked album tags. */
export function spotifySearchMatchesObservedAlbum(
  recording: RecordingEvidence,
  candidate: SpotifyTrackSearchCandidate,
) {
  return (
    recording.standalone_lastfm &&
    albumNames(recording).some((album) =>
      sameSourceName(candidate.albumName, album),
    )
  )
}

function spotifySearchSourceBillingMatches(
  artists: string[],
  candidate: SpotifyTrackSearchCandidate,
  titleGuest?: string,
) {
  const [lead, ...guests] = artists
  const [candidateLead, ...candidateGuests] = candidate.artists
  if (!lead || !candidateLead) return false

  const candidateTitleGuest = titleCredit(candidate.title).guest
  if (
    titleGuest &&
    candidateTitleGuest &&
    !sameSourceName(titleGuest, candidateTitleGuest)
  )
    return false
  const knownGuests = candidateTitleGuest
    ? [...candidateGuests, candidateTitleGuest]
    : candidateGuests
  const guestMatches = (guest: string) =>
    knownGuests.some((known) => sameSourceName(guest, known)) ||
    sameSourceName(guest, candidateGuests.join(', ')) ||
    sameSourceName(guest, candidateGuests.join(' & '))

  if (titleGuest && !guestMatches(titleGuest)) return false
  if (sameSourceName(lead, candidateLead)) return guests.every(guestMatches)
  if (!guests.length) {
    if (sameName(lead, candidate.artists.join(', '))) return true
    const billing = splitArtistCredit(lead)
    if (
      billing.length > 1 &&
      billing.length === candidate.artists.length &&
      candidate.artists.every((artist, index) =>
        sameSourceName(billing[index] ?? null, artist),
      )
    )
      return true
  }
  // Treat a compound recorded credit as a lead and named guests when Spotify
  // bills that lead separately. Keep a full artist name that already matches.
  const compound = splitScrobbleCredit(lead)
  return (
    compound !== undefined &&
    sameSourceName(compound.primary, candidateLead) &&
    [compound.guest, ...guests].every(guestMatches)
  )
}

const COMPATIBLE_TITLE_SUFFIX =
  / (?:original (?:mix|version)|(?:\d{4} (?:digital )?remaster(?:ed)?|(?:digital )?remaster(?:ed)?(?: \d{4})?)(?: version)?)$/

function sourceTitleKey(title: string) {
  return plainKey(titleCredit(title).title)
}

function sameVersionOrUnlabelled(first: string, second: string) {
  if (first === second) return true
  const firstBase = first.replace(COMPATIBLE_TITLE_SUFFIX, '')
  const secondBase = second.replace(COMPATIBLE_TITLE_SUFFIX, '')
  return (
    (first === firstBase || second === secondBase) && firstBase === secondBase
  )
}

/** Prefer the source's stated title version when several candidates qualify. */
export function spotifySearchMatchesTitleVersion(
  recording: RecordingEvidence,
  candidate: SpotifyTrackSearchCandidate,
) {
  return sourceTitleKey(recording.title) === sourceTitleKey(candidate.title)
}

/** Check the stored source identity before considering where its matches are stored. */
export function spotifySearchMatchesSource(
  recording: RecordingEvidence,
  candidate: SpotifyTrackSearchCandidate,
) {
  return checkSpotifySearchSource(recording, candidate)
}

function checkSpotifySearchSource(
  recording: RecordingEvidence,
  candidate: SpotifyTrackSearchCandidate,
  audit?: RecordingAudit,
) {
  const candidateTitle = sourceTitleKey(candidate.title)
  const labelledTitles = new Set(
    [
      recording.title,
      ...recording.scrobbles.map(({ title }) => title),
      candidate.title,
    ]
      .map(sourceTitleKey)
      .filter((title) => COMPATIBLE_TITLE_SUFFIX.test(title)),
  )
  const allowUnlabelled =
    recording.standalone_lastfm &&
    !recording.position_titles.length &&
    labelledTitles.size <= 1
  const nameMatches = (
    title: string,
    artists: string[],
    from: '' | 'position-' | 'scrobble-',
  ) => {
    const credit = titleCredit(title)
    const titleKey = plainKey(credit.title)
    return (
      (titleKey === candidateTitle ||
        (allowUnlabelled &&
          sameVersionOrUnlabelled(titleKey, candidateTitle)) ||
        (audit !== undefined &&
          addMatchingReason(
            audit,
            from + 'title',
            from === 'position-'
              ? 'has an album position title that differs from the Spotify title.'
              : from === 'scrobble-'
                ? 'has a scrobbled title that differs from the Spotify title.'
                : 'has a title that differs from the Spotify title.',
            title,
            candidate.title,
          ))) &&
      (spotifySearchSourceBillingMatches(artists, candidate, credit.guest) ||
        (audit !== undefined &&
          addMatchingReason(
            audit,
            from + 'artist-credit',
            from === 'position-'
              ? 'has artist billing at an album position that differs from the Spotify result.'
              : from === 'scrobble-'
                ? 'has a scrobbled artist credit that differs from the Spotify result.'
                : 'has different artist billing from the Spotify result.',
            billingEvidence(artists, credit.guest),
            billingEvidence(
              candidate.artists,
              titleCredit(candidate.title).guest,
            ),
          )))
    )
  }
  return (
    (!recording.has_manual_overrides ||
      (audit !== undefined &&
        addMatchingReason(
          audit,
          'manual-override',
          'has a manual override that prevents an automatic match.',
          'Manual override',
          candidate.title,
        ))) &&
    spotifySearchReleaseIdsAgree(recording, candidate, audit) &&
    (recording.standalone_lastfm ||
      spotifySearchReleaseNamesAgree(
        recording,
        candidate,
        sameSourceName,
        audit,
      )) &&
    nameMatches(recording.title, recording.artists, '') &&
    recording.position_titles.every((title) =>
      nameMatches(title, recording.artists, 'position-'),
    ) &&
    spotifySearchConsistentMetadata(recording, candidate, plainKey, 1, audit) &&
    recording.scrobbles.every(
      ({ title, artist, manual }) =>
        scrobbledNameCanMatch(candidate, title, artist, manual, audit) &&
        nameMatches(title, [artist], 'scrobble-'),
    )
  )
}

function billingEvidence(artists: string[], featured: string | undefined) {
  const credits = evidenceList(artists)
  return featured ? credits + ' · Featuring ' + featured : credits
}

function scrobbledNameCanMatch(
  candidate: SpotifyTrackSearchCandidate,
  title: string,
  artist: string,
  manual: boolean,
  audit?: RecordingAudit,
) {
  return (
    !manual ||
    (audit !== undefined &&
      addMatchingReason(
        audit,
        'manual-scrobble',
        'has a scrobbled name with a manual match decision.',
        title + ' · ' + artist,
        candidate.title + ' · ' + evidenceList(candidate.artists),
      ))
  )
}

function haveDifferentVersions(first: string, second: string) {
  const a = sourceTitleKey(first)
  const b = sourceTitleKey(second)
  if (sameVersionOrUnlabelled(a, b)) return false
  if (trackBaseKey(first) === trackBaseKey(second)) return true
  // Also catch plain suffixes and colons outside the usual bracket/dash forms.
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a]
  return (
    longer.startsWith(`${shorter} `) &&
    hasTrackVersionQualifier(longer.slice(shorter.length + 1))
  )
}

/** Unmatched scrobbled album names can still signal a distinct version. */
export function spotifySearchHasAlternateVersion(
  recording: RecordingEvidence,
  chosen: SpotifyTrackSearchCandidate,
  candidates: SpotifyTrackSearchCandidate[],
) {
  return checkSpotifySearchAlternateVersion(recording, chosen, candidates)
}

function checkSpotifySearchAlternateVersion(
  recording: RecordingEvidence,
  chosen: SpotifyTrackSearchCandidate,
  candidates: SpotifyTrackSearchCandidate[],
  audit?: RecordingAudit,
) {
  const matchedAlbum = chosen.albumName
  if (!recording.standalone_lastfm) return false
  const albums = albumNames(recording).filter(
    (album) => !sameSourceName(matchedAlbum, album),
  )
  if (hasUnmatchedVersionAlbum(albums, matchedAlbum ?? '')) {
    if (audit) {
      const versionAlbum = albums.find((album) =>
        hasUnmatchedVersionAlbum([album], matchedAlbum ?? ''),
      )
      addMatchingReason(
        audit,
        'alternate-version',
        'has another scrobbled release whose name indicates a different version.',
        versionAlbum ?? '',
        matchedAlbum ?? '',
      )
    }
    return true
  }
  const alternate = candidates.find(
    (candidate) =>
      albums.some((album) => sameSourceName(candidate.albumName, album)) &&
      spotifySearchSourceBillingMatches(recording.artists, candidate) &&
      haveDifferentVersions(candidate.title, recording.title),
  )
  if (alternate && audit) {
    const observedAlbum = albums.find((album) =>
      sameSourceName(alternate.albumName, album),
    )
    addMatchingReason(
      audit,
      'alternate-version',
      'has a scrobbled release that matches another Spotify result for a different version.',
      observedAlbum ?? '',
      alternate.title + ' · ' + (alternate.albumName ?? ''),
    )
  }
  return alternate !== undefined
}

/** Explain both gates that compare a saved Spotify result with the searched track. */
export function spotifySearchSourceReasons(
  recording: RecordingEvidence,
  candidate: SpotifyTrackSearchCandidate,
  candidates: SpotifyTrackSearchCandidate[],
) {
  const audit: RecordingAudit = { side: 'source', reasons: [] }
  checkSpotifySearchSource(recording, candidate, audit)
  checkSpotifySearchAlternateVersion(recording, candidate, candidates, audit)
  return audit.reasons
}

function displayIsrc(value: string | null) {
  if (!value) return ''
  return isrcPattern.test(normalizedIsrc(value)) ? value : 'Unrecognised ISRC'
}

/** Check the retained library recording's own evidence during an explicit match. */
export function spotifySearchTargetConflicts(
  recording: RecordingEvidence,
  candidate: SpotifyTrackSearchCandidate,
) {
  const title = trackVersionKey(candidate.title)
  if (
    [recording.title, ...recording.position_titles].some(
      (stored) => stored.trim() && trackVersionKey(stored) !== title,
    )
  )
    return true

  const urlId = spotifyTrackIdFromLink(recording.spotify_url)
  if (
    [...recording.track_ids, urlId].some(
      (id) =>
        id && spotifyIdPattern.test(id) && id !== candidate.spotifyTrackId,
    )
  )
    return true

  const currentIsrc = normalizedIsrc(recording.isrc ?? '')
  const candidateIsrc = normalizedIsrc(candidate.isrc ?? '')
  if (
    currentIsrc !== candidateIsrc &&
    isrcPattern.test(currentIsrc) &&
    isrcPattern.test(candidateIsrc)
  )
    return true

  const currentArtists = new Set(
    recording.artists.flatMap(artistKeys).filter(Boolean),
  )
  const candidateArtists = new Set(
    candidate.artists.flatMap(artistKeys).filter(Boolean),
  )
  if (
    currentArtists.size &&
    candidateArtists.size &&
    ![...currentArtists].some((artist) => candidateArtists.has(artist))
  )
    return true
  if (
    recording.artist_credits.some((credit) => {
      if (!spotifyIdPattern.test(credit.id)) return false
      const known = candidate.artistCredits.filter(
        ({ name }) => artistNameKey(name) === artistNameKey(credit.name),
      )
      return known.length > 0 && known.every(({ id }) => id !== credit.id)
    })
  )
    return true

  // A partial billing difference needs corroboration. Give rounded lengths
  // the same five seconds of leeway as recording groups.
  return (
    candidate.durationSec > 0 &&
    recording.durations.length > 0 &&
    recording.durations.every(
      (seconds) => Math.abs(seconds - candidate.durationSec) > 5,
    ) &&
    [...currentArtists].some((artist) => !candidateArtists.has(artist)) &&
    [...candidateArtists].some((artist) => !currentArtists.has(artist))
  )
}

function spotifySearchConsistentMetadata(
  recording: RecordingEvidence,
  candidate: SpotifyTrackSearchCandidate,
  artistKey: (name: string) => string,
  maximumDurationDifference: number,
  audit?: RecordingAudit,
) {
  const durationTolerance =
    candidate.durationSec > 0 ? maximumDurationDifference : 0
  return (
    (!recording.spotify_url ||
      recording.spotify_url === candidate.spotifyUrl ||
      (audit !== undefined &&
        addMatchingReason(
          audit,
          'spotify-track-link',
          'has a stored Spotify link that differs from the result’s link.',
          displaySpotifyTrackLink(
            recording.spotify_url,
            candidate.spotifyTrackId,
          ),
          candidate.spotifyTrackId,
        ))) &&
    (!recording.isrc ||
      (candidate.isrc !== null &&
        normalizedIsrc(recording.isrc) === normalizedIsrc(candidate.isrc)) ||
      (audit !== undefined &&
        addMatchingReason(
          audit,
          'isrc',
          'has a stored recording code that the Spotify result does not share.',
          displayIsrc(recording.isrc),
          displayIsrc(candidate.isrc),
        ))) &&
    recording.artist_credits.every(
      ({ id, name }) =>
        candidate.artistCredits.some(
          (credit) =>
            credit.id === id && artistKey(credit.name) === artistKey(name),
        ) ||
        (audit !== undefined &&
          addMatchingReason(
            audit,
            'spotify-artist-id',
            'has a Spotify artist credit whose name and ID do not both appear in the result.',
            displaySpotifyArtistCredit({ id, name }),
            candidateArtistCreditEvidence(candidate, artistKey, name),
          )),
    ) &&
    recording.durations.every(
      (duration) =>
        Math.abs(duration - candidate.durationSec) <= durationTolerance ||
        (audit !== undefined &&
          addMatchingReason(
            audit,
            'duration',
            candidate.durationSec === 0
              ? 'has a stored duration and the Spotify result has no duration.'
              : durationTolerance > 0
                ? 'has a stored duration that differs by more than one second.'
                : 'has a stored duration that differs from the Spotify duration.',
            duration + ' seconds',
            candidate.durationSec > 0 ? candidate.durationSec + ' seconds' : '',
          )),
    )
  )
}

function displaySpotifyTrackLink(link: string, candidateId: string) {
  const id = spotifyTrackIdFromLink(link)
  if (!id) return 'Unrecognised Spotify link'
  return id === candidateId ? id + ' in a different link format' : id
}

function displaySpotifyArtistCredit({
  name,
  id,
}: {
  name: string
  id: string
}) {
  return name + ' (' + displaySpotifyId(id) + ')'
}

function candidateArtistCreditEvidence(
  candidate: SpotifyTrackSearchCandidate,
  artistKey: (name: string) => string,
  name: string,
) {
  const sameNameCredits = candidate.artistCredits.filter(
    (credit) => artistKey(credit.name) === artistKey(name),
  )
  return evidenceList(
    (sameNameCredits.length ? sameNameCredits : candidate.artistCredits).map(
      displaySpotifyArtistCredit,
    ),
  )
}

function spotifySearchConsistentRecording(
  recording: RecordingEvidence,
  candidate: SpotifyTrackSearchCandidate,
  {
    allowTargetDurationRounding = false,
  }: { allowTargetDurationRounding?: boolean } = {},
  audit?: RecordingAudit,
) {
  return (
    spotifySearchConsistentMetadata(
      recording,
      candidate,
      albumNameKey,
      allowTargetDurationRounding ? 1 : 0,
      audit,
    ) &&
    recording.scrobbles.every(
      ({ title, artist, manual }) =>
        scrobbledNameCanMatch(candidate, title, artist, manual, audit) &&
        (sameName(candidate.title, title) ||
          (audit !== undefined &&
            addMatchingReason(
              audit,
              'scrobble-title',
              'has a scrobbled title that differs from the Spotify title.',
              title,
              candidate.title,
            ))) &&
        (sameName(candidate.artists.join(', '), artist) ||
          (audit !== undefined &&
            addMatchingReason(
              audit,
              'scrobble-artist-credit',
              'has a scrobbled artist credit that differs from the Spotify result.',
              artist,
              evidenceList(candidate.artists),
            ))),
    )
  )
}

/** A distinct, preidentified destination may differ only in title diacritics and one second of duration. */
export function spotifySearchMatchesDestination(
  recording: RecordingEvidence,
  candidate: SpotifyTrackSearchCandidate,
) {
  return checkSpotifySearchDestination(recording, candidate)
}

function checkSpotifySearchDestination(
  recording: RecordingEvidence,
  candidate: SpotifyTrackSearchCandidate,
  audit?: RecordingAudit,
) {
  const allowTolerance =
    recording.spotify_track_id === candidate.spotifyTrackId &&
    !recording.has_manual_overrides
  return (
    spotifySearchExactRelease(
      recording,
      candidate,
      {
        allowTargetTitleDiacritics: allowTolerance,
      },
      audit,
    ) &&
    spotifySearchConsistentRecording(
      recording,
      candidate,
      {
        allowTargetDurationRounding: allowTolerance,
      },
      audit,
    )
  )
}

/** Explain the ordinary automatic match gate for a distinct retained track. */
export function spotifySearchDestinationReasons(
  recording: RecordingEvidence,
  candidate: SpotifyTrackSearchCandidate,
) {
  const audit: RecordingAudit = { side: 'destination', reasons: [] }
  checkSpotifySearchDestination(recording, candidate, audit)
  return audit.reasons
}

/** Prove that an existing track's generic billing came from its one exact Spotify release. */
export async function readSpotifyAlbumFallbackArtistCreditCorrection(
  tx: Transaction,
  targetId: string,
  candidate: SpotifyTrackSearchCandidate,
  recording: RecordingEvidence,
  {
    recordingIncludesScrobbles = true,
  }: { recordingIncludesScrobbles?: boolean } = {},
) {
  const [previousArtist] = recording.artists
  if (
    !previousArtist ||
    recording.artists.length !== 1 ||
    !isCompilationFallbackArtist(previousArtist) ||
    recording.spotify_track_id !== candidate.spotifyTrackId ||
    recording.has_manual_overrides ||
    candidate.spotifyAlbumId === null ||
    candidate.durationSec <= 0 ||
    candidate.artists.some(isCompilationFallbackArtist) ||
    !sameSpotifySearchArtists(
      candidate.artistCredits.map(({ name }) => name),
      candidate.artists,
    ) ||
    new Set(candidate.artistCredits.map(({ id }) => id)).size !==
      candidate.artistCredits.length ||
    !spotifySearchExactRelease(
      { ...recording, artists: candidate.artists },
      candidate,
    ) ||
    !spotifySearchConsistentRecording(recording, candidate)
  )
    return undefined

  const { rows } = await tx.execute(sql`
    select listed.album_media_item_id as "albumId", listed.position,
      ${previousArtist}::text as "previousArtist", stored.spotify_track_id as "spotifyTrackId"
    from media_item item join library_track stored on stored.media_item_id = item.id
    join track listed on listed.track_media_item_id = item.id
      and listed.album_media_item_id = stored.album_media_item_id
    join media_item release on release.id = listed.album_media_item_id
    where item.id = ${targetId} and item.source_label = 'album' and item.slug = item.id
      and item.release_date is null and item.artwork_url is null
      and item.summary is null and item.original_title is null
      and coalesce(item.metadata, '{}'::jsonb) = '{}'::jsonb
      and release.media_type = 'album' and release.metadata->>'legacyHidden' is distinct from 'true'
      and stored.spotify_track_id = ${candidate.spotifyTrackId} and listed.external_id = stored.spotify_track_id
      and listed.position > 0 and listed.duration_sec = ${candidate.durationSec}
      and (stored.duration_sec is null or stored.duration_sec = listed.duration_sec)
      and (select count(*) from track where track_media_item_id = item.id) = 1
      and exists (select 1 from (${spotifyAlbumReleaseIds()}) r
        where r.album_id = release.id and r.spotify_id = ${candidate.spotifyAlbumId})
      and array(select c.artist_id from media_credit c where c.media_item_id = release.id and c.role = 'artist')
        = array(select c.artist_id from media_credit c where c.media_item_id = item.id and c.role = 'artist')
      and not ${independentTrackData(sql`item.id`)}`)
  if (!rows.length) return undefined

  // Manual review normally omits target listening evidence. This repair must also respect it.
  if (!recordingIncludesScrobbles) {
    const full = await spotifySearchRecordingEvidence(tx, targetId)
    if (
      !full ||
      !spotifySearchExactRelease(
        { ...full, artists: candidate.artists },
        candidate,
      ) ||
      !spotifySearchConsistentRecording(full, candidate)
    )
      return undefined
  }
  return AlbumFallbackArtistCreditCorrectionSchema.parse(rows[0])
}
