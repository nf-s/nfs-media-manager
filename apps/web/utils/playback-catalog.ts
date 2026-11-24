import {
  PlaybackCatalogInputSchema,
  PlaybackCatalogItemSchema,
  PlaybackCatalogResultSchema,
  spotifyIdPattern,
  type PlaybackCatalogInput,
  type PlaybackCatalogItem,
} from '@repo/schemas/playback'
import { fetchApiData } from './api'
import type { PlayableItem, PlaybackSnapshot } from './playback'

export function playbackSpotifyId(
  kind: 'track' | 'album' | 'artist',
  uri: string | null | undefined,
) {
  const prefix = `spotify:${kind}:`
  if (!uri?.startsWith(prefix)) return undefined
  const id = uri.slice(prefix.length)
  return spotifyIdPattern.test(id) ? id : undefined
}

/** Only send provider catalog names and identifiers from the current device item. */
export function currentPlaybackCatalog(
  snapshot: PlaybackSnapshot | null,
  current: PlayableItem | null,
) {
  if (!snapshot) return current ? queuedPlaybackCatalog(current) : null
  const albumUri =
    snapshot.albumUri ??
    (current?.kind === 'album' &&
    current.uri === snapshot.contextUri &&
    current.albumTitle === snapshot.albumName
      ? current.uri
      : undefined)
  const parsed = PlaybackCatalogItemSchema.safeParse({
    kind: 'track',
    spotifyId: playbackSpotifyId('track', snapshot.trackUri),
    title: snapshot.trackName,
    durationSec: Math.round(snapshot.durationMs / 1000) || undefined,
    album: snapshot.albumName
      ? {
          title: snapshot.albumName,
          spotifyId: playbackSpotifyId('album', albumUri),
        }
      : undefined,
    artists: snapshot.artistLinks.map(({ name, uri }) => ({
      name,
      spotifyId: playbackSpotifyId('artist', uri),
    })),
  })
  return parsed.success ? parsed.data : null
}

export function queuedPlaybackCatalog(item: PlayableItem) {
  const parsed = PlaybackCatalogItemSchema.safeParse({
    kind: item.kind,
    spotifyId: playbackSpotifyId(item.kind, item.uri),
    title: item.title,
    // A queued track may already have a local album without a Spotify link.
    // Only the device's album identity or a validated Spotify URI can add it.
    artists:
      item.credits?.map(({ name }) => ({ name })) ??
      (item.artist ? [{ name: item.artist }] : []),
  })
  return parsed.success ? parsed.data : null
}

export function recordPlaybackCatalog(
  apiBaseUrl: string,
  operation: PlaybackCatalogInput['operation'],
  items: PlaybackCatalogItem[],
  signal?: AbortSignal,
) {
  return fetchApiData(
    apiBaseUrl,
    '/api/v1/playback/catalog',
    PlaybackCatalogResultSchema,
    {
      method: 'POST',
      signal,
      body: JSON.stringify(
        PlaybackCatalogInputSchema.parse({ operation, items }),
      ),
    },
  )
}
