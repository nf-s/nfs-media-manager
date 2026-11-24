import {
  PlaybackCatalogArtworkSchema,
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

export function playbackCatalogArtwork(url: string | null | undefined) {
  return PlaybackCatalogArtworkSchema.safeParse(url).data
}

export function playbackAlbumUri(
  snapshot: PlaybackSnapshot,
  current: PlayableItem | null,
) {
  if (snapshot.albumUri) return snapshot.albumUri
  if (!current || current.albumTitle !== snapshot.albumName) return null
  if (current.kind === 'album' && current.uri === snapshot.contextUri)
    return current.uri
  if (
    current.kind === 'track' &&
    current.uri === (snapshot.relinkedTrackUri ?? snapshot.trackUri)
  )
    return current.albumUri ?? null
  return null
}

/** Only send catalog metadata for the current device item. */
export function currentPlaybackCatalog(
  snapshot: PlaybackSnapshot | null,
  current: PlayableItem | null,
) {
  if (!snapshot) return current ? queuedPlaybackCatalog(current) : null
  if (snapshot.isLocal || snapshot.trackUri?.startsWith('spotify:local:'))
    return null
  const albumUri = playbackAlbumUri(snapshot, current)
  const trackUri = snapshot.relinkedTrackUri ?? snapshot.trackUri
  const sameItem =
    current?.uri === (current?.kind === 'album' ? albumUri : trackUri)
  const parsed = PlaybackCatalogItemSchema.safeParse({
    kind: 'track',
    spotifyId: playbackSpotifyId('track', trackUri),
    title: snapshot.trackName,
    ...(snapshot.isrc ? { isrc: snapshot.isrc } : {}),
    artworkUrl: playbackCatalogArtwork(
      snapshot.artworkUrl ?? (sameItem ? current?.artworkUrl : undefined),
    ),
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
  const spotifyAlbumId = playbackSpotifyId('album', item.albumUri)
  const parsed = PlaybackCatalogItemSchema.safeParse({
    kind: item.kind,
    spotifyId: playbackSpotifyId(item.kind, item.uri),
    title: item.title,
    artworkUrl: playbackCatalogArtwork(item.artworkUrl),
    ...(item.kind === 'track' && item.albumTitle && spotifyAlbumId
      ? { album: { title: item.albumTitle, spotifyId: spotifyAlbumId } }
      : {}),
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
