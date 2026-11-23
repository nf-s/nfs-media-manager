'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { TrackDetail } from '@repo/schemas/tracks'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Button } from '@repo/ui/components/ui/button'
import {
  addManualMediaItem,
  invalidateManualMediaAddition,
} from '@/utils/manual-media-add'
import {
  describeScrobbledAlbum,
  describeUnlistedAlbum,
  missingTrackAlbum,
} from '@/utils/track-album-notices'
import { DetailLink } from './detail-link'
import { useDetailInspector } from './detail-inspector-context'
import { errorMessage } from './lastfm-sync'
import ManualMediaAdd from './manual-media-add'
import { useConfig } from './providers'

/** Overview and Sources share the add result while the track detail stays open. */
export function useTrackAlbumAddition(item: TrackDetail) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const inspector = useDetailInspector()
  const missing = missingTrackAlbum(item)
  const [searchQuery, setSearchQuery] = useState<string | null>(null)
  const refreshTrackAlbums = () =>
    Promise.all(
      ['track', 'tracks', 'album'].map((key) =>
        client.invalidateQueries({ queryKey: [key] }),
      ),
    )
  const add = useMutation({
    retry: false,
    mutationFn: async (spotifyAlbumId: string) => {
      const albumId = await addManualMediaItem(apiBaseUrl, 'album', {
        externalId: spotifyAlbumId,
        mediaItemId: null,
      })
      await Promise.all([
        invalidateManualMediaAddition(client, 'album'),
        refreshTrackAlbums(),
      ])
      return albumId
    },
  })
  const unlisted =
    missing?.kind === 'id' &&
    add.isSuccess &&
    add.variables === missing.spotifyAlbumId
      ? add.data
      : null
  const error = add.isError
    ? errorMessage(add.error, 'Could not add album.')
    : null
  const action =
    missing && !unlisted ? (
      <Button
        type="button"
        size="xs"
        disabled={add.isPending}
        aria-haspopup={missing.kind === 'search' ? 'dialog' : undefined}
        onClick={() => {
          if (missing.kind === 'id') add.mutate(missing.spotifyAlbumId)
          else setSearchQuery(missing.query)
        }}
      >
        {add.isPending ? 'Adding…' : 'Add to Library'}
      </Button>
    ) : undefined
  const dialog = searchQuery !== null && (
    <ManualMediaAdd
      mediaType="album"
      initialQuery={searchQuery}
      onClose={() => setSearchQuery(null)}
      onAdded={async (id) => {
        await refreshTrackAlbums()
        setSearchQuery(null)
        if (inspector) inspector.open({ kind: 'album', id })
        else window.location.assign(`/albums/${encodeURIComponent(id)}`)
      }}
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
        <Notice tone="attention">
          {unlistedText.before}
          <DetailLink kind="album" id={unlisted}>
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
