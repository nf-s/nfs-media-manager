'use client'

import type { ReactNode } from 'react'
import type { TrackListItem } from '@repo/schemas/tracks'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Button } from '@repo/ui/components/ui/button'
import {
  AdditionList,
  AdditionState,
  useAddToPlaylist,
  usePlaylistAdditions,
} from './playlist-addition-controls'

const TITLE = 'Appears in'

function MatchedTrack({
  trackId,
  onResolved,
  children,
}: {
  trackId: string
  onResolved: (id: string) => void
  children: ReactNode
}) {
  const { additions, additionList, playlists } = usePlaylistAdditions(
    'track',
    trackId,
    onResolved,
  )
  const adding = useAddToPlaylist('track', trackId, additionList)
  const names = new Map(
    (playlists.data ?? []).map((playlist) => [playlist.id, playlist.name]),
  )
  return (
    <Section title={TITLE} aside={adding.action}>
      {children}
      {adding.notice}
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
    </Section>
  )
}

/**
 * Keep the playlist action alongside the places that contain the track.
 */
export default function TrackAppearanceSection({
  track,
  onResolved,
  children,
}: {
  track: Pick<TrackListItem, 'id' | 'spotifyTrackId'>
  onResolved: (id: string) => void
  children: ReactNode
}) {
  if (!track.spotifyTrackId)
    return (
      <Section title={TITLE}>
        {children}
        <p className="ds-help">
          Match this track to Spotify to add it to a playlist.
        </p>
      </Section>
    )
  return (
    <MatchedTrack key={track.id} trackId={track.id} onResolved={onResolved}>
      {children}
    </MatchedTrack>
  )
}
