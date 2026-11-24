import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import type {
  PlaybackCatalogInput,
  PlaybackCatalogItem,
  PlaybackCatalogResult,
} from '@repo/schemas/playback'
import { db } from '@/lib/db'
import { artist, libraryTrack, mediaCredit, mediaItem } from '@/schemas/db'
import { observeNamedArtistIdentities } from './catalog-artist-identities'
import { observeCatalogMedia } from './catalog-discoveries'
import { observeSpotifyTrackAndAlbum } from './music-catalog-observations'

/** Store the public catalog item only. No player commands or listening events. */
export async function observePlaybackCatalog({
  operation,
  items,
}: PlaybackCatalogInput): Promise<PlaybackCatalogResult> {
  const unique = new Map<string, PlaybackCatalogItem>()
  for (const item of items) {
    const key = `${item.kind}:${item.spotifyId}`
    const earlier = unique.get(key)
    unique.set(
      key,
      earlier
        ? {
            ...item,
            album: item.album?.spotifyId
              ? item.album
              : (earlier.album ?? item.album),
            artworkUrl: item.artworkUrl ?? earlier.artworkUrl,
            durationSec: item.durationSec ?? earlier.durationSec,
            artists: item.artists.some(({ spotifyId }) => spotifyId)
              ? item.artists
              : earlier.artists,
          }
        : item,
    )
  }
  return db.transaction(async (tx) => {
    const identities = []
    for (const item of unique.values()) {
      const { spotifyId, kind, title, artworkUrl } = item
      // A name from the device can label playback. Only provider IDs identify artists.
      const credits = item.artists.flatMap(({ spotifyId: id, name }) =>
        id ? [{ id, name }] : [],
      )
      const key = `${kind}:${spotifyId}`
      const spotifyUrl = `https://open.spotify.com/${kind}/${spotifyId}`
      if (kind === 'album') {
        const id = await observeCatalogMedia(
          tx,
          {
            kind,
            title,
            provider: 'spotify',
            referenceType: 'spotify',
            externalId: spotifyId,
            spotifyUrl,
            artworkUrl,
            credits: credits.map(({ id: externalId, name }) => ({
              externalId,
              name,
            })),
          },
          { provider: 'spotify', operation, occurrenceKey: key },
        )
        identities.push({ kind, spotifyId, id, albumId: null, credits })
        continue
      }

      const { trackId, albumId } = await observeSpotifyTrackAndAlbum(
        tx,
        {
          spotifyTrackId: spotifyId,
          title,
          durationSec: item.durationSec,
          spotifyAlbumId: item.album?.spotifyId ?? null,
          albumName: item.album?.title ?? null,
          artworkUrl: artworkUrl ?? null,
          artists: credits.map(({ name }) => name),
          artistCredits: credits,
          spotifyUrl,
        },
        { operation, key, position: 1 },
      )
      // An exact device track can supply a missing native parent reference.
      if (item.album?.spotifyId)
        await tx
          .update(libraryTrack)
          .set({ spotifyAlbumId: item.album.spotifyId })
          .where(
            and(
              eq(libraryTrack.mediaItemId, trackId),
              isNull(libraryTrack.spotifyAlbumId),
            ),
          )
      identities.push({
        kind,
        spotifyId,
        id: trackId,
        albumId: albumId ?? null,
        credits,
      })
    }

    const ids = identities.map(({ id }) => id)
    const artistIds = await observeNamedArtistIdentities(
      tx,
      'spotify',
      new Map(
        identities.flatMap(({ credits }) =>
          credits.map(({ id, name }) => [id, name]),
        ),
      ),
    )
    const [memberships, credits] = await Promise.all([
      tx
        .select({ id: mediaItem.id, inLibrary: mediaItem.inLibrary })
        .from(mediaItem)
        .where(
          inArray(mediaItem.id, [
            ...ids,
            ...identities.flatMap(({ albumId }) => (albumId ? [albumId] : [])),
          ]),
        ),
      tx
        .select({
          mediaId: mediaCredit.mediaItemId,
          name: artist.name,
          id: artist.id,
        })
        .from(mediaCredit)
        .innerJoin(artist, eq(artist.id, mediaCredit.artistId))
        .where(
          and(
            inArray(mediaCredit.mediaItemId, ids),
            eq(mediaCredit.role, 'artist'),
          ),
        )
        .orderBy(asc(mediaCredit.billingOrder)),
    ])
    const library = new Map(
      memberships.map(({ id, inLibrary }) => [id, inLibrary]),
    )
    const byMedia = new Map<string, { name: string; id: string }[]>()
    for (const { mediaId, name, id } of credits) {
      const list = byMedia.get(mediaId) ?? []
      list.push({ name, id })
      byMedia.set(mediaId, list)
    }
    const reference = (id: string) => ({
      id,
      inLibrary: library.get(id) ?? false,
    })
    return {
      items: identities.map(({ kind, spotifyId, id, albumId, credits }) => {
        const observedArtists = credits.flatMap(({ id: spotifyId, name }) => {
          const id = artistIds.get(spotifyId)
          return id ? [{ id, name, spotifyId }] : []
        })
        return {
          kind,
          spotifyId,
          item: reference(id),
          album: albumId ? reference(albumId) : null,
          artists: observedArtists.length
            ? observedArtists
            : (byMedia.get(id) ?? []),
        }
      }),
    }
  })
}
