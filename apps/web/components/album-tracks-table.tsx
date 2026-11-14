'use client'

import type { AlbumDetail } from '@repo/schemas/media'
import { useSearchParams } from 'next/navigation'
import { SecondaryCell, SecondaryDataTable } from './secondary-table'
import { TrackPlayButton, TrackQueueButton } from './play-controls'
import ExternalLink from './external-link'
import {
  albumTrackView,
  albumTrackViewHref,
  createAlbumPlaybackSource,
} from '@/utils/playback-source'

export default function AlbumTracksTable({
  album,
  scrobbles,
}: {
  album: AlbumDetail
  scrobbles: Map<number, number> | null
}) {
  const searchParams = useSearchParams()
  const view = albumTrackView(
    searchParams?.get('albumTrackView') ?? null,
    album.id,
  )
  return (
    <SecondaryDataTable
      id="album-tracks"
      label="Album tracks"
      rows={album.tracks}
      search={{
        label: 'Search album tracks',
        placeholder: 'Search tracks',
        maxLength: 200,
        value: (track) => track.title,
      }}
      countLabel="tracks"
      rowKey={(track) => track.position}
      defaultSort={{ key: 'position', direction: 'asc' }}
      view={{
        sort: { key: view.sortBy, direction: view.direction },
        query: view.q,
        onChange: ({ sort, query }) => {
          const next = albumTrackView(
            JSON.stringify({
              id: album.id,
              q: query,
              sortBy: sort.key,
              direction: sort.direction,
            }),
            album.id,
          )
          window.history.replaceState(
            null,
            '',
            albumTrackViewHref(
              window.location.pathname,
              new URLSearchParams(window.location.search),
              next,
            ),
          )
        },
      }}
      empty="No imported tracks."
      columns={[
        {
          key: 'position',
          label: '#',
          className: 'numeric',
          value: (track) => track.position,
          render: (track, ordered) => (
            <TrackPlayButton
              album={album}
              track={track}
              source={() =>
                createAlbumPlaybackSource(
                  album,
                  albumTrackViewHref(
                    window.location.pathname,
                    new URLSearchParams(window.location.search),
                    view,
                  ),
                  ordered,
                )
              }
            />
          ),
        },
        {
          key: 'title',
          label: 'Track',
          value: (track) => track.title,
          render: (track) => (
            <div className="secondary-cell-actions">
              <SecondaryCell text={track.title}>
                {track.externalId ? (
                  <ExternalLink
                    href={`https://open.spotify.com/track/${encodeURIComponent(track.externalId)}`}
                  >
                    {track.title}
                  </ExternalLink>
                ) : (
                  track.title
                )}
              </SecondaryCell>
              <span title={`Add ${track.title} to queue`}>
                <TrackQueueButton album={album} track={track} />
              </span>
            </div>
          ),
        },
        {
          key: 'duration',
          label: 'Duration',
          className: 'numeric',
          value: (track) => track.durationSec,
          render: (track) =>
            track.durationSec === null
              ? '-'
              : `${Math.floor(track.durationSec / 60)}:${String(track.durationSec % 60).padStart(2, '0')}`,
        },
        {
          key: 'scrobbles',
          label: 'Scrobbles',
          className: 'numeric',
          value: (track) => scrobbles?.get(track.position),
          render: (track) =>
            scrobbles?.get(track.position)?.toLocaleString() ?? '-',
        },
        {
          key: 'externalId',
          label: 'Spotify ID',
          defaultVisible: false,
          value: (track) => track.externalId,
        },
      ]}
    />
  )
}
