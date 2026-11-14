'use client'

import type { AlbumDetail } from '@repo/schemas/media'
import { SecondaryDataTable } from './secondary-table'
import { TrackPlayButton, TrackQueueButton } from './play-controls'
import ExternalLink from './external-link'

export default function AlbumTracksTable({
  album,
  scrobbles,
}: {
  album: AlbumDetail
  scrobbles: Map<number, number> | null
}) {
  return (
    <SecondaryDataTable
      id="album-tracks"
      label="Album tracks"
      rows={album.tracks}
      rowKey={(track) => track.position}
      defaultSort={{ key: 'position', direction: 'asc' }}
      empty="No imported tracks."
      columns={[
        {
          key: 'position',
          label: '#',
          className: 'numeric',
          value: (track) => track.position,
          render: (track) => <TrackPlayButton album={album} track={track} />,
        },
        {
          key: 'title',
          label: 'Track',
          value: (track) => track.title,
          render: (track) => (
            <>
              {track.externalId ? (
                <ExternalLink
                  href={`https://open.spotify.com/track/${encodeURIComponent(track.externalId)}`}
                >
                  {track.title}
                </ExternalLink>
              ) : (
                track.title
              )}
              <TrackQueueButton album={album} track={track} />
            </>
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
