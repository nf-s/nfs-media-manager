import { albumNameKey } from '@/lib/album-import-candidates'
import type {
  SonovaultResolveResult,
  SonovaultTrack,
} from '@/lib/sonovault-api'
import { trackVersionKey } from '@/lib/track-matching'

/** Durations within this many seconds agree (SONO-24). */
const DURATION_TOLERANCE_SEC = 5
const spotifyTrackIdPattern = /^[A-Za-z0-9]{22}$/

/** A record's performing artists: its primary artists, or all but remixers. */
export function sonovaultCandidateArtists(record: SonovaultTrack) {
  const credited = record.artists.filter((artist) => !artist.is_remixer)
  const primary = credited.filter((artist) => artist.is_primary)
  return (primary.length ? primary : credited).map((artist) => artist.name)
}

const artistKeys = (names: string[]) =>
  [...new Set(names.map(albumNameKey).filter(Boolean))].sort()

/**
 * SONO-24: a candidate is accepted automatically only when the artist is
 * equal, the title is equal including its version text, and the durations
 * agree within five seconds. A track with no stored duration is never
 * accepted automatically.
 */
export function sonovaultCandidateIsAutomatic(
  library: { title: string; artists: string[]; durationSec: number | null },
  record: SonovaultTrack,
) {
  if (library.durationSec === null || record.duration === null) return false
  if (Math.abs(library.durationSec - record.duration) > DURATION_TOLERANCE_SEC)
    return false
  const ours = artistKeys(library.artists)
  const theirs = artistKeys(sonovaultCandidateArtists(record))
  return (
    ours.length > 0 &&
    ours.length === theirs.length &&
    ours.every((key, index) => key === theirs[index]) &&
    trackVersionKey(library.title) === trackVersionKey(record.title)
  )
}

export const sonovaultSpotifyLink = (result: SonovaultResolveResult) =>
  result.links.find((link) => link.source === 'spotify') ?? null

/** The Spotify track ID a result links to, when it is a valid one. */
export function sonovaultCandidateSpotifyId(result: SonovaultResolveResult) {
  const id = sonovaultSpotifyLink(result)?.external_id.trim() ?? ''
  return spotifyTrackIdPattern.test(id) ? id : null
}
