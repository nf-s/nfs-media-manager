import type {
  CatalogMembershipInput,
  CatalogMembershipResult,
} from '@repo/schemas/manual-add'
import type { PlayableItem, PlaybackSnapshot } from './playback'
import { playbackAlbumUri, playbackSpotifyId } from './playback-catalog'

type CatalogItem = Extract<
  CatalogMembershipInput['items'][number],
  { mediaType: 'album' | 'track' }
>
type CatalogKind = CatalogItem['mediaType']

export type PlaybackLibraryItem = {
  kind: CatalogKind
  title: string
  uri: string | null
  mediaItemId: string | null
  catalog: CatalogItem[]
}

type PlaybackItemMembership =
  | { status: 'saved'; mediaItemId: string }
  | { status: 'missing'; catalogItem: CatalogItem }
  | { status: 'unresolved' }

function playbackLibraryItem(
  kind: CatalogKind,
  title: string,
  uri: string | null,
  mediaItemId: string | null,
  ...alternateUris: (string | null | undefined)[]
): PlaybackLibraryItem {
  const catalog = [...new Set([uri, ...alternateUris])].flatMap((value) => {
    const externalId = playbackSpotifyId(kind, value)
    return externalId ? [{ mediaType: kind, externalId }] : []
  })
  return { kind, title, uri, mediaItemId, catalog }
}

function playingTrack(
  snapshot: PlaybackSnapshot,
  trackId: string | null,
  albumUri: string | null,
) {
  if (!snapshot.trackName) return null
  if (snapshot.isLocal || snapshot.trackUri?.startsWith('spotify:local:'))
    return playbackLibraryItem('track', snapshot.trackName, null, trackId)
  const item = playbackLibraryItem(
    'track',
    snapshot.trackName,
    snapshot.relinkedTrackUri ?? snapshot.trackUri,
    trackId,
    snapshot.trackUri,
    snapshot.linkedFromUri,
  )
  const [first, ...aliases] = item.catalog
  const spotifyAlbumId = playbackSpotifyId('album', albumUri)
  const title = snapshot.trackName.trim()
  const artists = (
    snapshot.artistLinks.length
      ? snapshot.artistLinks.map(({ name }) => name)
      : [snapshot.artists]
  )
    .map((name) => name.trim())
    .filter(Boolean)
  if (
    first?.mediaType !== 'track' ||
    !spotifyAlbumId ||
    !title ||
    !artists.length
  )
    return item
  return {
    ...item,
    catalog: [
      {
        ...first,
        recording: {
          spotifyAlbumId,
          title,
          artists,
          albumName: snapshot.albumName,
        },
      },
      ...aliases,
    ],
  }
}

export function queuedLibraryItem(item: PlayableItem): PlaybackLibraryItem {
  return playbackLibraryItem(
    item.kind,
    item.title,
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
    const currentTrack =
      current?.kind === 'track' &&
      (current.uri === snapshot.trackUri ||
        current.uri === snapshot.linkedFromUri ||
        current.uri === snapshot.relinkedTrackUri)
        ? current
        : null
    const trackId = currentTrack?.trackId ?? null
    const potentialAlbumUri = snapshot.albumUri ?? snapshot.contextUri
    const currentAlbum =
      current?.kind === 'album' &&
      current.uri === potentialAlbumUri &&
      (snapshot.albumUri !== null || current.albumTitle === snapshot.albumName)
        ? current
        : null
    const albumUri = playbackAlbumUri(snapshot, current)
    const albumId =
      currentAlbum?.albumId ??
      (currentTrack?.uri === snapshot.trackUri &&
      (!albumUri || albumUri === currentTrack.albumUri) &&
      currentTrack.albumTitle === snapshot.albumName
        ? currentTrack.albumId
        : null)
    return {
      track: playingTrack(snapshot, trackId, albumUri),
      album: snapshot.albumName
        ? playbackLibraryItem('album', snapshot.albumName, albumUri, albumId)
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
              current.albumUri ?? null,
              current.albumId,
            )
          : null,
  }
}

export function catalogLookups(items: readonly (PlaybackLibraryItem | null)[]) {
  return items.flatMap((item) => item?.catalog ?? [])
}

export function playbackItemMembership(
  item: PlaybackLibraryItem,
  membership: CatalogMembershipResult | undefined,
): PlaybackItemMembership {
  const [catalogItem] = item.catalog
  if (!catalogItem || !membership) return { status: 'unresolved' }
  const found = new Set<string>()
  let complete = true
  for (const key of item.catalog) {
    const row = membership.items.find(
      (row) =>
        row.mediaType === key.mediaType && row.externalId === key.externalId,
    )
    if (row?.ambiguous) return { status: 'unresolved' }
    if (row?.mediaItemId) found.add(row.mediaItemId)
    if (!row) complete = false
  }
  const [only] = found
  if (found.size === 1 && only) return { status: 'saved', mediaItemId: only }
  return complete && found.size === 0
    ? { status: 'missing', catalogItem }
    : { status: 'unresolved' }
}
