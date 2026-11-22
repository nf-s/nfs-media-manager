'use client'

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
import { errorMessage } from './lastfm-sync'
import { useConfig } from './providers'

/**
 * The track's Spotify album when it is not in the library, with Add album,
 * and the library albums its scrobbles are counted on that do not list it.
 * When Add album answers with an album the track is still not on, the notice
 * names that album in place of offering the same add again.
 */
export function TrackAlbumNotices({
  item,
}: {
  item: Pick<
    TrackDetail,
    'album' | 'albumName' | 'spotifyAlbumId' | 'scrobbledAlbums'
  >
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const missing = missingTrackAlbum(item)
  const add = useMutation({
    retry: false,
    mutationFn: async (spotifyAlbumId: string) => {
      const albumId = await addManualMediaItem(apiBaseUrl, 'album', {
        externalId: spotifyAlbumId,
        mediaItemId: null,
      })
      await Promise.all([
        invalidateManualMediaAddition(client, 'album'),
        ...['track', 'tracks', 'album'].map((key) =>
          client.invalidateQueries({ queryKey: [key] }),
        ),
      ])
      return albumId
    },
  })
  const unlisted = missing && add.isSuccess ? add.data : null
  const unlistedText = describeUnlistedAlbum(item.albumName)
  if (!missing && !add.isError && item.scrobbledAlbums.length === 0) return null
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
        <Notice
          action={
            <Button
              size="xs"
              disabled={add.isPending}
              onClick={() => add.mutate(missing.spotifyAlbumId)}
            >
              {add.isPending ? 'Adding…' : 'Add album'}
            </Button>
          }
        >
          {missing.message}
        </Notice>
      )}
      {add.isError && (
        <Notice tone="danger">
          {errorMessage(add.error, 'Could not add album.')}
        </Notice>
      )}
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
