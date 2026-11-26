'use client'

import type { ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { CatalogMembershipInput } from '@repo/schemas/manual-add'
import type { TrackDetail } from '@repo/schemas/tracks'
import { SpotifyAlbumReferenceResultSchema } from '@repo/schemas/spotify-album-reference'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { LibraryAction } from '@repo/ui/components/ds/library-action'
import { useCatalogMembership } from '@/hooks/use-catalog-membership'
import {
  libraryAdditionUnavailable,
  saveLibraryAddition,
  useLibraryAddition,
} from '@/hooks/use-library-addition'
import { fetchApiData } from '@/utils/api'
import {
  invalidateManualMediaAddition,
  rememberManualMediaAddition,
} from '@/utils/manual-media-add'
import {
  describeScrobbledAlbum,
  describeUnlistedAlbum,
  trackAlbumReference,
} from '@/utils/track-album-notices'
import { DetailLink } from './detail-link'
import { errorMessage } from './lastfm-sync'
import { useAnnounceLibraryAddition, useConfig } from './providers'
import ServiceIconLinks from './service-icon-links'
import { SpotifyAlbumReferenceLink } from './spotify-album-reference-link'

/** Overview and Sources share the add result while the track detail stays open. */
export function useTrackAlbumAddition(item: TrackDetail) {
  const { apiBaseUrl } = useConfig()
  const announceAddition = useAnnounceLibraryAddition()
  const client = useQueryClient()
  const { exactId, album, openBySpotify } = trackAlbumReference(item)
  const target = { kind: 'album', catalogId: album?.id, externalId: exactId }
  const receipt = useLibraryAddition(target, album?.inLibrary)
  const feedback = receipt?.feedback
  const identities: CatalogMembershipInput['items'] = exactId
    ? [{ mediaType: 'album', externalId: exactId }]
    : []
  const membership = useCatalogMembership(identities)
  const exact = membership.data?.items.find(
    (entry) => entry.mediaType === 'album' && entry.externalId === exactId,
  )
  const recordedName = item.albumName?.trim() || null
  const name = album?.title ?? recordedName ?? (openBySpotify ? 'Album' : null)
  const add = useMutation({
    retry: false,
    mutationFn: (spotifyAlbumId: string) =>
      saveLibraryAddition(
        client,
        target,
        async () =>
          (
            await fetchApiData(
              apiBaseUrl,
              '/api/v1/catalog/spotify-album-reference',
              SpotifyAlbumReferenceResultSchema,
              {
                method: 'POST',
                body: JSON.stringify({
                  trackId: item.id,
                  spotifyAlbumId,
                  add: true,
                }),
              },
            )
          ).mediaItemId,
      ),
    onSuccess: (id, externalId) => {
      rememberManualMediaAddition(client, 'album', externalId, id)
      if (name) announceAddition('album', name, id)
      void invalidateManualMediaAddition(client, 'album')
    },
  })
  const addedId = add.isSuccess && add.variables === exactId ? add.data : null
  const savedId =
    addedId ??
    receipt?.committedId ??
    exact?.mediaItemId ??
    (album?.inLibrary === false ? null : (album?.id ?? null))
  const unlisted = album?.id === savedId ? null : savedId
  const catalogId = savedId ?? album?.id ?? null
  const saved = Boolean(savedId)
  const error = add.isError
    ? errorMessage(add.error, 'Could not add album.')
    : exact?.ambiguous
      ? 'More than one catalog record matches this Spotify release.'
      : null
  const canAdd =
    membership.isSuccess &&
    !membership.isFetching &&
    !saved &&
    exact?.mediaItemId === null &&
    !exact.ambiguous
  const libraryAction =
    name && (saved || canAdd || add.isPending) ? (
      <LibraryAction
        name={name}
        kind="album"
        saved={saved}
        feedback={feedback}
        receiptId={receipt?.committedId}
        onAdd={() => {
          if (canAdd && exactId && !libraryAdditionUnavailable(client, target))
            add.mutate(exactId)
        }}
      />
    ) : undefined
  const action =
    exactId && name && (!album || album.inLibrary === false) ? (
      <span className="ds-actions">
        <ServiceIconLinks
          itemTitle={name}
          links={[
            {
              provider: 'spotify',
              label: 'Spotify',
              url: `https://open.spotify.com/album/${exactId}`,
            },
          ]}
        />
        {libraryAction}
      </span>
    ) : (
      libraryAction
    )
  return {
    album,
    name,
    unlisted,
    catalogId,
    savedId,
    exactId,
    openBySpotify,
    action,
    showingReceipt: feedback?.phase === 'done',
    error,
  }
}

export function TrackAlbumReferenceLink({
  item,
  addition,
  children,
}: {
  item: TrackDetail
  addition: ReturnType<typeof useTrackAlbumAddition>
  children: ReactNode
}) {
  if (addition.openBySpotify)
    return (
      <SpotifyAlbumReferenceLink
        trackId={item.id}
        spotifyAlbumId={addition.exactId}
        catalogId={addition.savedId}
      >
        {children}
      </SpotifyAlbumReferenceLink>
    )
  return addition.catalogId ? (
    <DetailLink kind="album" id={addition.catalogId}>
      {children}
    </DetailLink>
  ) : (
    children
  )
}

/** Shows the release and any library albums counting scrobbles from this track. */
export function TrackAlbumNotices({
  item,
  addition,
}: {
  item: TrackDetail
  addition: ReturnType<typeof useTrackAlbumAddition>
}) {
  const {
    album,
    name,
    unlisted,
    action,
    error,
    openBySpotify,
    catalogId,
    savedId,
    showingReceipt,
  } = addition
  const unlistedText = describeUnlistedAlbum(name)
  const showRelease =
    Boolean(name) && (showingReceipt || !album || album.id !== savedId)
  if (!showRelease && !error && item.scrobbledAlbums.length === 0) return null
  return (
    <Section title="Album">
      {showRelease && (
        <Notice tone={unlisted ? 'attention' : undefined} action={action}>
          {unlisted ? (
            <>
              {unlistedText.before}
              <TrackAlbumReferenceLink item={item} addition={addition}>
                {unlistedText.title}
              </TrackAlbumReferenceLink>
              {unlistedText.after}
            </>
          ) : openBySpotify || catalogId ? (
            <TrackAlbumReferenceLink item={item} addition={addition}>
              {name}
            </TrackAlbumReferenceLink>
          ) : (
            `“${name}” has no linked library album.`
          )}
        </Notice>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {item.scrobbledAlbums.map((album) => {
        const text = describeScrobbledAlbum(album.scrobbles)
        return (
          <Notice key={album.id} tone="attention">
            {text.before}
            <DetailLink kind="album" id={album.id}>
              {album.title}
            </DetailLink>
            {text.after}
          </Notice>
        )
      })}
    </Section>
  )
}
