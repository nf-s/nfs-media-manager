'use client'

import type { TrackListItem } from '@repo/schemas/tracks'
import {
  AddToPlaylist,
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
      <AddToPlaylist
        mediaType="track"
        id={trackId}
        playlists={playlists}
        additions={additionList}
      />
      {additions.isError && (
        <p role="alert" className="quiet mt-2">
          Could not load playlist additions.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => additions.refetch()}
          >
            Retry
          </button>
        </p>
      )}
      {additionList.length > 0 && (
        <ul className="mt-2 grid gap-1 text-sm" aria-label="Additions">
          {additionList.map((addition) => (
            <AdditionState
              mediaType="track"
              key={addition.job.jobId}
              addition={addition}
              name={names.get(addition.playlistId) ?? 'Playlist'}
            />
          ))}
        </ul>
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
      <p className="quiet mt-2">
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
