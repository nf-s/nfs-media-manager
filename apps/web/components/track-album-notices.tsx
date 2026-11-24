'use client'

import { useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { CatalogMembershipInput } from '@repo/schemas/manual-add'
import type { TrackDetail } from '@repo/schemas/tracks'
import { SpotifyAlbumReferenceResultSchema } from '@repo/schemas/spotify-album-reference'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { LibraryAction } from '@repo/ui/components/ds/library-action'
import { useCatalogMembership } from '@/hooks/use-catalog-membership'
import { fetchApiData } from '@/utils/api'
import {
  invalidateManualMediaAddition,
  rememberManualMediaAddition,
} from '@/utils/manual-media-add'
import {
  describeScrobbledAlbum,
  describeUnlistedAlbum,
  missingTrackAlbum,
} from '@/utils/track-album-notices'
import { AlbumReferenceSearchDialog } from './album-reference-search'
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
  const missing = missingTrackAlbum(item)
  const exactId =
    missing?.kind === 'id'
      ? missing.spotifyAlbumId
      : item.albumLinkStrategy === 'spotify-album'
        ? item.spotifyAlbumId
        : null
  const identities: CatalogMembershipInput['items'] = exactId
    ? [{ mediaType: 'album', externalId: exactId }]
    : []
  const membership = useCatalogMembership(identities)
  const exact = membership.data?.items.find(
    (entry) => entry.mediaType === 'album' && entry.externalId === exactId,
  )
  const name = item.album?.title ?? missing?.name
  const [searchQuery, setSearchQuery] = useState<string | null>(null)
  const add = useMutation({
    retry: false,
    mutationFn: async (spotifyAlbumId: string) => {
      const { mediaItemId } = await fetchApiData(
        apiBaseUrl,
        '/api/v1/catalog/spotify-album-reference',
        SpotifyAlbumReferenceResultSchema,
        {
          method: 'POST',
          body: JSON.stringify({ trackId: item.id, spotifyAlbumId, add: true }),
        },
      )
      return mediaItemId
    },
    onSuccess: (id, externalId) => {
      rememberManualMediaAddition(client, 'album', externalId, id)
      if (name) announceAddition('album', name)
      void invalidateManualMediaAddition(client, 'album')
    },
  })
  const addedId =
    add.isSuccess && add.variables === item.spotifyAlbumId ? add.data : null
  const unlisted = item.album ? null : (addedId ?? exact?.mediaItemId ?? null)
  const query = missing?.kind === 'search' ? missing.query : null
  const saved = Boolean(addedId || exact?.mediaItemId)
  const error = add.isError
    ? errorMessage(add.error, 'Could not add album.')
    : exact?.ambiguous
      ? 'This Spotify release could not be matched to one visible library album.'
      : null
  const canAdd =
    membership.isSuccess &&
    !membership.isFetching &&
    exact?.mediaItemId === null &&
    !exact.ambiguous
  function addOrFind() {
    if (query) setSearchQuery(query)
    else if (canAdd && exactId) add.mutate(exactId)
  }
  const libraryAction =
    name && (saved || query || canAdd || add.isPending) ? (
      <LibraryAction
        name={name}
        kind="album"
        saved={saved}
        pending={add.isPending}
        action={query ? 'find' : 'add'}
        onAdd={addOrFind}
      />
    ) : undefined
  const action =
    exactId && name ? (
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
  const dialog = searchQuery !== null && (
    <AlbumReferenceSearchDialog
      query={searchQuery}
      onClose={() => setSearchQuery(null)}
    />
  )
  return {
    missing,
    unlisted,
    exactId: exact?.ambiguous ? null : exactId,
    action,
    error,
    dialog,
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
  const albumId = item.album?.id ?? addition.unlisted
  if (addition.exactId)
    return (
      <SpotifyAlbumReferenceLink
        trackId={item.id}
        spotifyAlbumId={addition.exactId}
        catalogId={albumId}
      >
        {children}
      </SpotifyAlbumReferenceLink>
    )
  return albumId ? (
    <DetailLink kind="album" id={albumId}>
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
  const { missing, unlisted, action, error } = addition
  const unlistedText = describeUnlistedAlbum(item.albumName)
  if (!missing && !error && item.scrobbledAlbums.length === 0) return null
  return (
    <Section title="Album">
      {(missing || unlisted) && (
        <Notice tone={unlisted ? 'attention' : undefined} action={action}>
          {unlisted ? (
            <>
              {unlistedText.before}
              <DetailLink
                kind="album"
                id={unlisted}
                title="Open the library album with the same Spotify release ID"
              >
                {unlistedText.title}
              </DetailLink>
              {unlistedText.after}
            </>
          ) : missing && addition.exactId ? (
            <TrackAlbumReferenceLink item={item} addition={addition}>
              {missing.name}
            </TrackAlbumReferenceLink>
          ) : (
            missing?.message
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
