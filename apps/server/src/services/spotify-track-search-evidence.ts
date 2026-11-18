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
import { plainKey } from '@/lib/lastfm-album-matching'
import { trackBaseKey, trackVersionKey } from '@/lib/track-matching'
import { spotifyAlbumReleaseIds } from './album-library-tracks'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export function spotifySearchArtistNames(id: SQL) {
  return sql<string[]>`array(select a.name from media_credit c
    join artist a on a.id = c.artist_id
    where c.media_item_id = ${id} and c.role = 'artist'
    order by c.billing_order, a.id)`
}

const RecordingEvidenceSchema = z.object({
  title: z.string(),
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
      union
      select l.track_key, l.artist_key, l.strategy = 'manual', l.username
      from lastfm_track_link l where l.track_media_item_id = ${id}
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
    select title, ${spotifySearchArtistNames(sql`recording.id`)} as artists, spotify_url, isrc,
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
  { standaloneSource = false }: { standaloneSource?: boolean } = {},
) {
  const albums = [
    ...recording.album_names,
    ...recording.scrobbled_albums,
  ].filter((name) => albumNameKey(name))
  return (
    sameName(candidate.title, recording.title) &&
    sameSpotifySearchArtists(recording.artists, candidate.artists) &&
    recording.position_titles.every((title) =>
      sameName(candidate.title, title),
    ) &&
    recording.track_ids.every((id) => id === candidate.spotifyTrackId) &&
    recording.album_ids.every((id) => id === candidate.spotifyAlbumId) &&
    (!albums.length ||
      (standaloneSource && recording.standalone_lastfm
        ? albums.some((name) => sameName(candidate.albumName, name))
        : albums.every((name) => sameName(candidate.albumName, name))))
  )
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

export function spotifySearchConsistentRecording(
  recording: RecordingEvidence,
  candidate: SpotifyTrackSearchCandidate,
) {
  const normalizedIsrc = (value: string) =>
    value.trim().toUpperCase().replaceAll('-', '')
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
      (duration) => duration === candidate.durationSec,
    ) &&
    recording.scrobbles.every(
      ({ title, artist, manual }) =>
        !manual &&
        sameName(candidate.title, title) &&
        sameName(candidate.artists.join(', '), artist),
    )
  )
}
