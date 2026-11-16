import type { ListeningMonth } from '@repo/schemas/lastfm'

export type ListeningSeriesKind = 'album' | 'track' | 'artist' | 'playlist'

const resources: Record<ListeningSeriesKind, string> = {
  album: 'albums',
  track: 'tracks',
  artist: 'artists',
  playlist: 'playlists',
}

/** Album listening with names and tracks, optionally for one scrobbled track. */
export function albumListeningPath(albumId: string, track: string) {
  const query = track ? `?${new URLSearchParams({ track })}` : ''
  return `/api/v1/albums/${albumId}/listening${query}`
}

export function listeningSeriesPath(kind: ListeningSeriesKind, id: string) {
  return `/api/v1/${resources[kind]}/${encodeURIComponent(id)}/listening/series`
}

/**
 * Starts with the item's own key so scrobble relinking, which invalidates
 * albums, tracks and playlists, also refreshes their charts. Relinking
 * matches an artist's chart by this key's shape.
 */
export function listeningSeriesKey(kind: ListeningSeriesKind, id: string) {
  return [kind, id, 'listening-series']
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** `2020-03` as `Mar 2020`. */
export function formatListeningMonth(month: string) {
  const name = MONTH_NAMES[Number(month.slice(5, 7)) - 1]
  return name ? `${name} ${month.slice(0, 4)}` : month
}

/** The month with the most scrobbles; the earliest wins a tie. */
export function busiestMonth(months: readonly ListeningMonth[]) {
  let best: ListeningMonth | undefined
  for (const month of months)
    if (!best || month.count > best.count) best = month
  return best
}
