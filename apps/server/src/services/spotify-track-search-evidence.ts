import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { spotifyIdPattern } from '@repo/schemas/playback'
import type { SpotifyTrackSearchCandidate } from '@repo/schemas/spotify-track-search'
import { albumNameKey } from '@/lib/album-import-candidates'
import {
  hasTrackVersionQualifier,
  hasUnmatchedVersionAlbum,
} from '@/lib/album-track-aliases'
import type { db } from '@/lib/db'
import {
  artistKeys,
  artistNameKey,
  plainKey,
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
type RecordingEvidence = z.infer<typeof RecordingEvidenceSchema>

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

export function spotifySearchExactRelease(
  recording: RecordingEvidence,
  candidate: SpotifyTrackSearchCandidate,
  {
    standaloneSource = false,
    allowTargetTitleDiacritics = false,
  }: { standaloneSource?: boolean; allowTargetTitleDiacritics?: boolean } = {},
) {
  const albums = [
    ...recording.album_names,
    ...recording.scrobbled_albums,
  ].filter((name) => albumNameKey(name))
  const titleKey = allowTargetTitleDiacritics
    ? diacriticInsensitiveTitleKey
    : albumNameKey
  const candidateTitle = titleKey(candidate.title)
  return (
    candidateTitle === titleKey(recording.title) &&
    sameSpotifySearchArtists(recording.artists, candidate.artists) &&
    recording.position_titles.every(
      (title) => candidateTitle === titleKey(title),
    ) &&
    recording.track_ids.every((id) => id === candidate.spotifyTrackId) &&
    recording.album_ids.every((id) => id === candidate.spotifyAlbumId) &&
    (!albums.length ||
      (standaloneSource && recording.standalone_lastfm
        ? albums.some((name) => sameName(candidate.albumName, name))
        : albums.every((name) => sameName(candidate.albumName, name))))
  )
}

function diacriticInsensitiveTitleKey(title: string) {
  const key = albumNameKey(title)
  return key.normalize('NFD').replace(/\p{M}/gu, '') || key
}

function haveDifferentVersions(first: string, second: string) {
  if (trackVersionKey(first) === trackVersionKey(second)) return false
  if (trackBaseKey(first) === trackBaseKey(second)) return true
  // Also catch plain suffixes and colons outside the usual bracket/dash forms.
  const a = plainKey(first)
  const b = plainKey(second)
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
  const matchedAlbum = chosen.albumName
  if (!recording.standalone_lastfm || !matchedAlbum) return false
  const albums = [...recording.album_names, ...recording.scrobbled_albums]
  return (
    hasUnmatchedVersionAlbum(albums, matchedAlbum) ||
    candidates.some(
      (candidate) =>
        !sameName(candidate.albumName, matchedAlbum) &&
        albums.some((album) => sameName(candidate.albumName, album)) &&
        sameSpotifySearchArtists(recording.artists, candidate.artists) &&
        haveDifferentVersions(candidate.title, recording.title),
    )
  )
}

const normalizedIsrc = (value: string) =>
  value.trim().toUpperCase().replaceAll('-', '')
const isrcPattern = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/

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

  const urlId =
    /^(?:https:\/\/open\.spotify\.com\/track\/|spotify:track:)([A-Za-z0-9]{22})(?:[/?#]|$)/.exec(
      recording.spotify_url ?? '',
    )?.[1]
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

export function spotifySearchConsistentRecording(
  recording: RecordingEvidence,
  candidate: SpotifyTrackSearchCandidate,
  {
    allowTargetDurationRounding = false,
  }: { allowTargetDurationRounding?: boolean } = {},
) {
  const durationTolerance =
    allowTargetDurationRounding && candidate.durationSec > 0 ? 1 : 0
  return (
    (!recording.spotify_url ||
      recording.spotify_url === candidate.spotifyUrl) &&
    (!recording.isrc ||
      (candidate.isrc !== null &&
        normalizedIsrc(recording.isrc) === normalizedIsrc(candidate.isrc))) &&
    recording.artist_credits.every(({ id, name }) =>
      candidate.artistCredits.some(
        (credit) => credit.id === id && sameName(credit.name, name),
      ),
    ) &&
    recording.durations.every(
      (duration) =>
        Math.abs(duration - candidate.durationSec) <= durationTolerance,
    ) &&
    recording.scrobbles.every(
      ({ title, artist, manual }) =>
        !manual &&
        sameName(candidate.title, title) &&
        sameName(candidate.artists.join(', '), artist),
    )
  )
}

/** A distinct, preidentified destination may differ only in title diacritics and one second of duration. */
export function spotifySearchMatchesDestination(
  recording: RecordingEvidence,
  candidate: SpotifyTrackSearchCandidate,
) {
  const allowTolerance =
    recording.spotify_track_id === candidate.spotifyTrackId &&
    !recording.has_manual_overrides
  return (
    spotifySearchExactRelease(recording, candidate, {
      allowTargetTitleDiacritics: allowTolerance,
    }) &&
    spotifySearchConsistentRecording(recording, candidate, {
      allowTargetDurationRounding: allowTolerance,
    })
  )
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
