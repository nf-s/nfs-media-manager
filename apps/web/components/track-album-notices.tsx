'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { CatalogMembershipInput } from '@repo/schemas/manual-add'
import type { TrackDetail } from '@repo/schemas/tracks'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { LibraryAction } from '@repo/ui/components/ds/library-action'
import { useCatalogMembership } from '@/hooks/use-catalog-membership'
import {
  addManualMediaItem,
  invalidateManualMediaAddition,
} from '@/utils/manual-media-add'
import {
  describeScrobbledAlbum,
  describeUnlistedAlbum,
  missingTrackAlbum,
} from '@/utils/track-album-notices'
import {
  AlbumReferenceSearchDialog,
  invalidateAlbumReferences,
} from './album-reference-search'
import { DetailLink } from './detail-link'
import { errorMessage } from './lastfm-sync'
import { useConfig } from './providers'
import ServiceIconLinks from './service-icon-links'

/** Overview and Sources share the add result while the track detail stays open. */
export function useTrackAlbumAddition(item: TrackDetail) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const missing = missingTrackAlbum(item)
  const exactId = missing?.kind === 'id' ? missing.spotifyAlbumId : null
  const identities: CatalogMembershipInput['items'] = exactId
    ? [{ mediaType: 'album', externalId: exactId }]
    : []
  const membership = useCatalogMembership(identities)
  const exact = membership.data?.items.find(
    (entry) => entry.mediaType === 'album' && entry.externalId === exactId,
  )
  const [searchQuery, setSearchQuery] = useState<string | null>(null)
  const add = useMutation({
    retry: false,
    mutationFn: async (spotifyAlbumId: string) => {
      const albumId = await addManualMediaItem(apiBaseUrl, 'album', {
        externalId: spotifyAlbumId,
        mediaItemId: null,
      })
      await Promise.all([
        invalidateManualMediaAddition(client, 'album'),
        invalidateAlbumReferences(client),
      ])
      return albumId
    },
  })
  const addedId =
    add.isSuccess && add.variables === item.spotifyAlbumId ? add.data : null
  const unlisted = item.album ? null : (addedId ?? exact?.mediaItemId ?? null)
  const confirmation = missing?.kind === 'search' || Boolean(exact?.ambiguous)
  const query = missing?.query
  const saved = Boolean(unlisted || (addedId && item.album?.id === addedId))
  const error = add.isError
    ? errorMessage(add.error, 'Could not add album.')
    : exact?.ambiguous && !query
      ? 'More than one library album uses this Spotify release ID.'
      : null
  function addOrFind() {
    if (confirmation) {
      if (query) setSearchQuery(query)
    } else if (exactId) add.mutate(exactId)
  }
  const canAct = confirmation
    ? Boolean(query)
    : Boolean(exactId && !membership.isPending)
  const name = item.album?.title ?? missing?.name
  const libraryAction =
    name && (saved || missing) ? (
      <LibraryAction
        name={name}
        kind="album"
        saved={saved}
        pending={add.isPending}
        action={confirmation ? 'find' : 'add'}
        onAdd={canAct ? addOrFind : undefined}
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
  return { missing, unlisted, action, error, dialog }
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
      {unlisted && (
        <Notice tone="attention" action={action}>
          {unlistedText.before}
          <DetailLink
            kind="album"
            id={unlisted}
            title="Open the library album with the same Spotify release ID"
          >
            {unlistedText.title}
          </DetailLink>
          {unlistedText.after}
        </Notice>
      )}
      {missing && !unlisted && (
        <Notice action={action}>{missing.message}</Notice>
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
