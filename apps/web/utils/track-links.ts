import type { TrackDetail, TrackListItem } from '@repo/schemas/tracks'

/** Last.fm's public track page, using the recorded artist and track name. */
export function lastfmTrackUrl(artist: string, title: string) {
  if (!artist.trim() || !title.trim()) return null
  return `https://www.last.fm/music/${encodeURIComponent(artist)}/_/${encodeURIComponent(title)}`
}

/** Keep the recorded Last.fm name when a merge changed the library identity. */
export function trackServiceLinks(
  track: Pick<TrackListItem, 'title' | 'artists' | 'spotifyUrl'> &
    Partial<Pick<TrackDetail, 'lastfmSources'>>,
) {
  const source = track.lastfmSources?.[0]
  const lastfm = lastfmTrackUrl(
    source?.artistName ?? track.artists[0] ?? '',
    source?.trackName ?? track.title,
  )
  return [
    ...(track.spotifyUrl
      ? [{ provider: 'spotify', label: 'Spotify', url: track.spotifyUrl }]
      : []),
    ...(lastfm ? [{ provider: 'lastfm', label: 'Last.fm', url: lastfm }] : []),
  ]
}
