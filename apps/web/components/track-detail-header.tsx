'use client'

import type { ReactNode } from 'react'
import { AudioLines } from 'lucide-react'
import type { AlbumListItem } from '@repo/schemas/media'
import type { TrackListItem } from '@repo/schemas/tracks'
import { DetailHeader } from '@repo/ui/components/ds/detail-header'
import { formatTrackLength } from '@repo/ui/lib/format'
import type { LibraryTrackSource } from '@/utils/playback'
import { TrackArtistLinks } from './creator-links'
import { DetailArt } from './detail-frame'
import { DetailLink } from './detail-link'
import { TrackHeaderPlay } from './detail-play'
import ServiceIconLinks, { serviceLinks } from './service-icon-links'

/** The same recording header in a track inspector and a list of recommendations. */
export function TrackDetailHeader({
  track,
  detailId,
  titleAction,
  album,
  artistHref,
  links,
  actions,
}: {
  track: LibraryTrackSource &
    Pick<TrackListItem, 'artistCredits' | 'durationSec' | 'releaseDate'>
  detailId?: string
  titleAction?: ReactNode
  album?: ReactNode
  artistHref?: (name: string) => string
  links: AlbumListItem['links']
  actions: ReactNode
}) {
  const destinations = serviceLinks(links)
  const art = (
    <DetailArt
      src={track.artworkUrl}
      fallback={<AudioLines className="ds-i" aria-hidden="true" />}
    />
  )
  return (
    <DetailHeader
      art={
        detailId ? (
          <DetailLink
            kind="track"
            id={detailId}
            aria-label={`Open details for ${track.title}`}
          >
            {art}
          </DetailLink>
        ) : (
          art
        )
      }
      kind="Track"
      title={
        <>
          {detailId ? (
            <DetailLink kind="track" id={detailId} title={track.title}>
              {track.title}
            </DetailLink>
          ) : (
            track.title
          )}
          {titleAction && <> {titleAction}</>}
        </>
      }
      by={
        <>
          {track.artists.length > 0 && (
            <>
              by <TrackArtistLinks track={track} fallbackHref={artistHref} />
            </>
          )}
          {album && (
            <>
              {track.artists.length > 0 ? ' · on ' : 'on '}
              {album}
            </>
          )}
        </>
      }
      facts={[
        track.durationSec === null
          ? null
          : formatTrackLength(track.durationSec * 1000),
        track.releaseDate?.slice(0, 4),
      ]}
      play={<TrackHeaderPlay track={track} />}
      links={
        destinations.length > 0 && (
          <ServiceIconLinks links={destinations} itemTitle={track.title} />
        )
      }
      actions={actions}
    />
  )
}
