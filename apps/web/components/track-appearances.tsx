'use client'

import { ReadButton } from '@/components/read-button'
import { useQuery } from '@tanstack/react-query'
import { Disc3, ListMusic, Music2 } from 'lucide-react'
import { TrackAppearancesSchema } from '@repo/schemas/catalog'
import type { TrackDetail } from '@repo/schemas/tracks'
import { Thumb } from '@repo/ui/components/ds/artwork'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { List, ListRow, RowTitle } from '@repo/ui/components/ds/list-row'
import { fetchApiData } from '@/utils/api'
import { DetailLink } from './detail-link'
import { useConfig } from './providers'
import {
  TrackAlbumReferenceLink,
  type useTrackAlbumAddition,
} from './track-album-notices'
import TrackAppearanceSection from './track-playlist-additions'

const relationships = {
  album: { label: 'Album', icon: Disc3 },
  playlist: { label: 'Playlist', icon: ListMusic },
  similar: { label: 'Similar tracks', icon: Music2 },
}

export default function TrackAppearances({
  item,
  albumAddition,
  onResolved,
}: {
  item: TrackDetail
  albumAddition: ReturnType<typeof useTrackAlbumAddition>
  onResolved: (id: string) => void
}) {
  const { apiBaseUrl } = useConfig()
  const query = useQuery({
    queryKey: ['track', item.id, 'appearances'],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/catalog/${encodeURIComponent(item.id)}/appearances`,
        TrackAppearancesSchema,
        { signal },
      ),
  })
  const rows = query.data?.items ?? []
  const primary = rows.find(
    (row) =>
      row.kind === 'album' &&
      (row.id === albumAddition.catalogId ||
        (albumAddition.exactId &&
          row.spotifyAlbumId === albumAddition.exactId)),
  )
  const recordedRelease = !primary &&
    albumAddition.openBySpotify &&
    albumAddition.name && (
      <List compact>
        <ListRow
          thumb={
            <Thumb size={40}>
              <Disc3 className="ds-i" aria-hidden="true" />
            </Thumb>
          }
          title={
            <RowTitle>
              <TrackAlbumReferenceLink item={item} addition={albumAddition}>
                {albumAddition.name}
              </TrackAlbumReferenceLink>
            </RowTitle>
          }
          by="Recorded album"
          action={albumAddition.action}
        />
      </List>
    )
  return (
    <>
      <TrackAppearanceSection track={item} onResolved={onResolved}>
        {albumAddition.exactId && recordedRelease}
        {rows.length > 0 && (
          <List compact>
            {rows.map((row) => {
              const { label, icon: Icon } = relationships[row.relationship]
              return (
                <ListRow
                  key={`${row.kind}:${row.id}`}
                  thumb={
                    <Thumb size={40}>
                      {row === primary && item.artworkUrl ? (
                        <img
                          className="ds-artimg"
                          src={item.artworkUrl}
                          alt=""
                        />
                      ) : (
                        <Icon className="ds-i" aria-hidden="true" />
                      )}
                    </Thumb>
                  }
                  title={
                    <RowTitle>
                      <DetailLink
                        kind={row.kind}
                        id={row.id}
                        tab={
                          row.relationship === 'similar' ? 'similar' : undefined
                        }
                      >
                        {row.title}
                      </DetailLink>
                    </RowTitle>
                  }
                  by={label}
                  action={row === primary ? albumAddition.action : undefined}
                />
              )
            })}
          </List>
        )}
        {query.isPending && <Skeleton />}
        {query.isSuccess &&
          rows.length === 0 &&
          !(recordedRelease && albumAddition.exactId) && (
            <p className="ds-help">No known appearances.</p>
          )}
        {query.isError && (
          <Notice
            tone="danger"
            action={
              <ReadButton variant="link" size="xs" read={() => query.refetch()}>
                Retry
              </ReadButton>
            }
          >
            Could not load track appearances.
          </Notice>
        )}
      </TrackAppearanceSection>
      {!albumAddition.exactId && recordedRelease}
      {albumAddition.error && (
        <Notice tone="danger">{albumAddition.error}</Notice>
      )}
    </>
  )
}
