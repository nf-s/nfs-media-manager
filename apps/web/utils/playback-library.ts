import { spotifyIdPattern } from '@repo/schemas/playback'
import type {
  CatalogMembershipInput,
  CatalogMembershipResult,
} from '@repo/schemas/manual-add'
import type { PlayableItem, PlaybackSnapshot } from './playback'

type CatalogItem = CatalogMembershipInput['items'][number]
type CatalogKind = CatalogItem['mediaType']

export type PlaybackLibraryItem = {
  kind: CatalogKind
  title: string
  artist: string
  uri: string | null
  mediaItemId: string | null
  catalog: CatalogItem[]
}

function playbackLibraryItem(
  kind: CatalogKind,
  title: string,
  artist: string,
  uri: string | null,
  mediaItemId: string | null,
  alternateUri?: string | null,
): PlaybackLibraryItem {
  const prefix = `spotify:${kind}:`
  const catalog = [uri, alternateUri].flatMap((value) => {
    if (!value?.startsWith(prefix)) return []
    const externalId = value.slice(prefix.length)
    return spotifyIdPattern.test(externalId)
      ? [{ mediaType: kind, externalId }]
      : []
  })
  return { kind, title, artist, uri, mediaItemId, catalog }
}

export function queuedLibraryItem(item: PlayableItem): PlaybackLibraryItem {
  return playbackLibraryItem(
    item.kind,
    item.title,
    item.artist,
    item.uri,
    item.kind === 'track' ? (item.trackId ?? null) : item.albumId,
  )
}

/** A queue entry can be retained when the device moves to another recording. */
export function playingLibraryItems(
  snapshot: PlaybackSnapshot | null,
  current: PlayableItem | null,
) {
  if (snapshot) {
    const trackId =
      current?.kind === 'track' &&
      (current.uri === snapshot.trackUri ||
        current.uri === snapshot.linkedFromUri)
        ? (current.trackId ?? null)
        : null
    const albumUri =
      snapshot.albumUri ??
      (current?.kind === 'album' &&
      current.uri === snapshot.contextUri &&
      current.albumTitle === snapshot.albumName
        ? snapshot.contextUri
        : null)
    const albumId =
      current?.kind === 'album' && current.uri === albumUri
        ? current.albumId
        : null
    return {
      track: snapshot.trackName
        ? playbackLibraryItem(
            'track',
            snapshot.trackName,
            snapshot.artists,
            snapshot.trackUri,
            trackId,
            snapshot.linkedFromUri,
          )
        : null,
      album: snapshot.albumName
        ? playbackLibraryItem(
            'album',
            snapshot.albumName,
            snapshot.artists,
            albumUri,
            albumId,
          )
        : null,
    }
  }
  return {
    track: current?.kind === 'track' ? queuedLibraryItem(current) : null,
    album:
      current?.kind === 'album'
        ? queuedLibraryItem(current)
        : current?.albumTitle
          ? playbackLibraryItem(
              'album',
              current.albumTitle,
              current.artist,
              null,
              current.albumId,
            )
          : null,
  }
}

export function catalogLookups(items: readonly (PlaybackLibraryItem | null)[]) {
  return items.flatMap((item) =>
    item && !item.mediaItemId ? item.catalog : [],
  )
}

export function playbackItemMembership(
  item: PlaybackLibraryItem,
  membership: CatalogMembershipResult | undefined,
) {
  if (item.mediaItemId)
    return { mediaItemId: item.mediaItemId, ambiguous: false }
  const found = new Set<string>()
  let ambiguous = false
  for (const key of item.catalog) {
    const row = membership?.items.find(
      (row) =>
        row.mediaType === key.mediaType && row.externalId === key.externalId,
    )
    if (row?.mediaItemId) found.add(row.mediaItemId)
    if (row?.ambiguous) ambiguous = true
  }
  const [only] = found
  return {
    mediaItemId: found.size === 1 && !ambiguous ? (only ?? null) : null,
    ambiguous: ambiguous || found.size > 1,
  }
}
