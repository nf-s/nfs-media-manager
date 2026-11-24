'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Search } from 'lucide-react'
import type { TrackListItem } from '@repo/schemas/tracks'
import { Button } from '@repo/ui/components/ui/button'
import { SpotifyTrackSearchReview } from './spotify-track-search'

export function TrackSpotifyMatchAction({
  track,
  hasAlternate,
  onMatched,
}: {
  track: TrackListItem
  hasAlternate?: boolean
  onMatched?: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (
    track.inLibrary === false ||
    track.spotifyTrackId ||
    track.spotifyMatch !== 'unmatched' ||
    hasAlternate
  )
    return null
  const label = `Match ${track.title} to Spotify`
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        icon
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        onClick={(event) => {
          event.stopPropagation()
          setOpen(true)
        }}
      >
        <Search className="ds-i" aria-hidden />
      </Button>
      {open &&
        createPortal(
          <SpotifyTrackSearchReview
            track={track}
            searchMode="edit-query"
            onClose={() => setOpen(false)}
            onMatched={(id) => onMatched?.(id)}
          />,
          document.body,
        )}
    </>
  )
}
