'use client'

import type { TrackListItem } from '@repo/schemas/tracks'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Button } from '@repo/ui/components/ui/button'
import {
  AddToPlaylist,
  AdditionList,
  AdditionState,
  usePlaylistAdditions,
} from './playlist-addition-controls'

function MatchedTrackAdditions({
  trackId,
  onResolved,
}: {
  trackId: string
  onResolved: (id: string) => void
}) {
  const { additions, additionList, playlists } = usePlaylistAdditions(
    'track',
    trackId,
    onResolved,
  )
  const names = new Map(
    (playlists.data ?? []).map((playlist) => [playlist.id, playlist.name]),
  )
  return (
    <>
      <AddToPlaylist mediaType="track" id={trackId} additions={additionList} />
      {additions.isError && (
        <Notice
          tone="danger"
          action={
            <Button size="xs" onClick={() => additions.refetch()}>
              Retry
            </Button>
          }
        >
          Could not load playlist additions.
        </Notice>
      )}
      {additionList.length > 0 && (
        <AdditionList>
          {additionList.map((addition) => (
            <AdditionState
              key={addition.job.jobId}
              addition={addition}
              name={names.get(addition.playlistId) ?? 'Playlist'}
            />
          ))}
        </AdditionList>
      )}
    </>
  )
}

export default function TrackPlaylistAdditions({
  track,
  onResolved,
}: {
  track: Pick<TrackListItem, 'id' | 'spotifyTrackId'>
  onResolved: (id: string) => void
}) {
  if (!track.spotifyTrackId)
    return (
      <p className="ds-help">
        Match this track to Spotify to add it to a playlist.
      </p>
    )
  return (
    <MatchedTrackAdditions
      key={track.id}
      trackId={track.id}
      onResolved={onResolved}
    />
  )
}
