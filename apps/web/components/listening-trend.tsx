'use client'

export type ListeningTrendKind = 'album' | 'track' | 'artist' | 'playlist'

/** The scrobble trend for one album, track, artist or playlist. */
export function ListeningTrend({
  kind,
  id,
}: {
  kind: ListeningTrendKind
  id: string
}) {
  return <div hidden data-kind={kind} data-id={id} />
}
