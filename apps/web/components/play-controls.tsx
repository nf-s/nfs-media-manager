'use client'

import { AudioLines, ListPlus, Pause, Play } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import { usePlayback, usePlaybackControls } from './playback-provider'
import { spotifyTrackUri } from '@/utils/album-links'
import {
  albumPlayable,
  libraryTrackPlayable,
  trackPlayable,
  type AlbumSource,
  type LibraryTrackSource,
} from '@/utils/playback'

type Track = { position: number; externalId: string | null; title: string }

/** The album's playable form and whether the player is on it. Null while playback is off. */
function useAlbumPlayback(album: AlbumSource) {
  const view = usePlayback()
  const controls = usePlaybackControls()
  const item = view.enabled ? albumPlayable(album) : null
  if (!item) return null
  const current = view.current?.albumId === album.id
  return {
    item,
    current,
    playing: current && view.snapshot !== null && !view.snapshot.paused,
    controls,
  }
}

/** Play and queue buttons over a grid tile's artwork. */
export function TilePlayControls({ album }: { album: AlbumSource }) {
  const playback = useAlbumPlayback(album)
  if (!playback) return null
  const { item, current, playing, controls } = playback
  return (
    <div className="tile-play" data-current={current}>
      <button
        type="button"
        aria-label={`${playing ? 'Pause' : 'Play'} ${album.title}`}
        onClick={() => (current ? controls.toggle() : controls.play(item))}
      >
        {playing ? (
          <>
            <AudioLines
              size={14}
              aria-hidden="true"
              className="tile-play-marker"
            />
            <Pause size={14} aria-hidden="true" className="tile-play-action" />
          </>
        ) : (
          <Play size={14} aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        aria-label={`Add ${album.title} to queue`}
        onClick={() => controls.enqueue(item)}
      >
        <ListPlus size={14} aria-hidden="true" />
      </button>
    </div>
  )
}

/** Play and queue buttons in the album drawer's heading. */
export function AlbumPlayButtons({ album }: { album: AlbumSource }) {
  const playback = useAlbumPlayback(album)
  if (!playback) return null
  const { item, current, playing, controls } = playback
  return (
    <div className="detail-play">
      <Button
        type="button"
        size="sm"
        onClick={() => (current ? controls.toggle() : controls.play(item))}
      >
        {playing ? (
          <Pause size={14} aria-hidden="true" />
        ) : (
          <Play size={14} aria-hidden="true" />
        )}
        {playing ? 'Pause' : 'Play'}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => controls.enqueue(item)}
      >
        <ListPlus size={14} aria-hidden="true" />
        Add to queue
      </Button>
    </div>
  )
}

/** A track's number, which plays the album from that track when playback is on. */
export function TrackPlayButton({
  album,
  track,
}: {
  album: AlbumSource
  track: Track
}) {
  const view = usePlayback()
  const controls = usePlaybackControls()
  const item = view.enabled ? albumPlayable(album, track) : null
  if (!item) return <>{track.position}</>
  const uri = spotifyTrackUri(track.externalId)
  const { snapshot } = view
  const current =
    snapshot !== null &&
    (snapshot.trackUri === uri || snapshot.linkedFromUri === uri)
  const playing = current && !snapshot.paused
  return (
    <button
      type="button"
      className="track-play"
      data-current={current}
      aria-label={`${playing ? 'Pause' : 'Play'} ${track.title}`}
      onClick={() => (current ? controls.toggle() : controls.play(item))}
    >
      <span className="track-number">{track.position}</span>
      {playing ? (
        <Pause size={12} aria-hidden="true" />
      ) : (
        <Play size={12} aria-hidden="true" />
      )}
    </button>
  )
}

export function TrackQueueButton({
  album,
  track,
}: {
  album: AlbumSource
  track: Track
}) {
  const view = usePlayback()
  const controls = usePlaybackControls()
  const item = view.enabled ? trackPlayable(album, track) : null
  if (!item) return null
  return (
    <button
      type="button"
      className="track-queue"
      aria-label={`Add ${track.title} to queue`}
      onClick={() => controls.enqueue(item)}
    >
      <ListPlus size={14} aria-hidden="true" />
    </button>
  )
}

/** A library track's playable form and whether Spotify is playing it. Null while playback is off. */
function useLibraryTrackPlayback(track: LibraryTrackSource) {
  const view = usePlayback()
  const controls = usePlaybackControls()
  const item = view.enabled ? libraryTrackPlayable(track) : null
  if (!item) return null
  const { snapshot } = view
  const current =
    snapshot !== null &&
    (snapshot.trackUri === item.uri || snapshot.linkedFromUri === item.uri)
  return {
    item,
    current,
    playing: current && !snapshot.paused,
    controls,
  }
}

/**
 * Plays one library track. With a position it is the track number of a
 * playlist row, which shows the play icon while its row (a `group`) is
 * hovered, as in the album drawer; without one the icon is always shown.
 */
export function LibraryTrackPlayButton({
  track,
  position,
}: {
  track: LibraryTrackSource
  position?: number
}) {
  const playback = useLibraryTrackPlayback(track)
  if (!playback) return position === undefined ? null : <>{position}</>
  const { item, current, playing, controls } = playback
  const Icon = playing ? Pause : Play
  const label = `${playing ? 'Pause' : 'Play'} ${track.title}`
  const onClick = () => (current ? controls.toggle() : controls.play(item))
  if (position === undefined)
    return (
      <button
        type="button"
        className="inline-flex size-5 items-center justify-center rounded-[5px] align-middle hover:bg-[var(--chip)] data-[current=true]:bg-[var(--chip)]"
        data-current={current}
        aria-label={label}
        onClick={onClick}
      >
        <Icon size={12} aria-hidden="true" />
      </button>
    )
  return (
    <button
      type="button"
      className="track-play"
      data-current={current}
      aria-label={label}
      onClick={onClick}
    >
      <span className="track-number group-hover:hidden">{position}</span>
      <Icon size={12} aria-hidden="true" className="group-hover:block" />
    </button>
  )
}

/** Adds one library track to the queue; shown while its row (a `group`) is hovered. */
export function LibraryTrackQueueButton({
  track,
}: {
  track: LibraryTrackSource
}) {
  const playback = useLibraryTrackPlayback(track)
  if (!playback) return null
  const { item, controls } = playback
  return (
    <button
      type="button"
      className="track-queue group-hover:opacity-100"
      aria-label={`Add ${track.title} to queue`}
      onClick={() => controls.enqueue(item)}
    >
      <ListPlus size={14} aria-hidden="true" />
    </button>
  )
}

/** Play and queue buttons in the track drawer's heading. */
export function LibraryTrackPlayButtons({
  track,
}: {
  track: LibraryTrackSource
}) {
  const playback = useLibraryTrackPlayback(track)
  if (!playback) return null
  const { item, current, playing, controls } = playback
  return (
    <div className="detail-play">
      <Button
        type="button"
        size="sm"
        onClick={() => (current ? controls.toggle() : controls.play(item))}
      >
        {playing ? (
          <Pause size={14} aria-hidden="true" />
        ) : (
          <Play size={14} aria-hidden="true" />
        )}
        {playing ? 'Pause' : 'Play'}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => controls.enqueue(item)}
      >
        <ListPlus size={14} aria-hidden="true" />
        Add to queue
      </Button>
    </div>
  )
}
