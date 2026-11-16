'use client'

import { AudioLines, ListPlus, Pause, Play } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlbumDetailSchema } from '@repo/schemas/media'
import { Button } from '@repo/ui/components/ui/button'
import { fetchApiData } from '@/utils/api'
import { useConfig } from './providers'
import {
  usePlayback,
  usePlaybackControls,
  type PlaybackControls,
  type PlaybackView,
} from './playback-provider'
import { spotifyTrackUri } from '@/utils/album-links'
import {
  albumPlayable,
  libraryTrackPlayable,
  trackPlayable,
  type AlbumSource,
  type LibraryTrackSource,
  type PlaybackSource,
  type PlayableItem,
} from '@/utils/playback'

type Track = { position: number; externalId: string | null; title: string }
type PlaybackSourceFactory = () => PlaybackSource | Promise<PlaybackSource>
const playRequests = new WeakMap<PlaybackControls, object>()

export function UnavailablePlayButton({
  title,
  available,
  position,
  compact = true,
}: {
  title: string
  available: boolean
  position?: number
  compact?: boolean
}) {
  const playback = usePlayback()
  const reason = !available
    ? 'No Spotify recording is available.'
    : !playback.enabled
      ? 'Connect Spotify playback in the player.'
      : 'No playable tracks are available.'
  return (
    <button
      type="button"
      className={
        compact ? 'track-play' : 'inline-flex items-center gap-1.5 text-sm'
      }
      aria-label={`Play ${title}: ${reason}`}
      title={reason}
      disabled
    >
      {position !== undefined && (
        <span className="track-number">{position}</span>
      )}
      <Play size={compact ? 12 : 14} aria-hidden="true" />
      {!compact && 'Play'}
    </button>
  )
}

export function AlbumInlinePlayButton({
  album,
  source,
}: {
  album: AlbumSource
  source?: PlaybackSourceFactory
}) {
  const playback = useAlbumPlayback(album)
  if (!playback)
    return (
      <UnavailablePlayButton
        title={album.title}
        available={albumPlayable(album) !== null}
      />
    )
  const Icon = playback.playing ? Pause : Play
  return (
    <span className="inline-flex shrink-0 items-center">
      <button
        type="button"
        className="track-play"
        data-current={playback.current}
        aria-label={`${playback.playing ? 'Pause' : 'Play'} ${album.title}`}
        onClick={() => playback.play(source)}
      >
        <Icon size={12} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="track-queue"
        aria-label={`Add ${album.title} to queue`}
        onClick={() => playback.controls.enqueue(playback.item)}
      >
        <ListPlus size={14} aria-hidden="true" />
      </button>
    </span>
  )
}

/** Related albums expose playback without fetching each album on render. */
export function AlbumReferencePlayButton({
  id,
  title,
  source,
}: {
  id: string
  title: string
  source?: PlaybackSourceFactory
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const view = usePlayback()
  const controls = usePlaybackControls()
  const current = view.current?.albumId === id
  const playing = current && view.snapshot !== null && !view.snapshot.paused
  const playback = useMutation<PlayableItem | null, Error, 'play' | 'queue'>({
    mutationFn: async () =>
      albumPlayable(
        await client.fetchQuery({
          queryKey: ['album', id],
          queryFn: () =>
            fetchApiData(
              apiBaseUrl,
              `/api/v1/albums/${encodeURIComponent(id)}`,
              AlbumDetailSchema,
            ),
        }),
      ),
    onSuccess: (item, action) => {
      if (!item) return
      if (action === 'queue') controls.enqueue(item)
      else playFromView(controls, view, item, current, source)
    },
  })
  if (!view.enabled || playback.data === null)
    return (
      <UnavailablePlayButton title={title} available={playback.data !== null} />
    )
  const Icon = playing ? Pause : Play
  return (
    <span className="inline-flex shrink-0 items-center">
      <button
        type="button"
        className="track-play"
        disabled={playback.isPending}
        data-current={current}
        aria-label={`${playing ? 'Pause' : 'Play'} ${title}`}
        title={
          playback.isError
            ? 'Could not load album playback. Try again.'
            : undefined
        }
        onClick={() =>
          current && !source ? controls.toggle() : playback.mutate('play')
        }
      >
        <Icon size={12} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="track-queue"
        aria-label={`Add ${title} to queue`}
        disabled={playback.isPending}
        title={
          playback.isError
            ? 'Could not load album playback. Try again.'
            : undefined
        }
        onClick={() => playback.mutate('queue')}
      >
        <ListPlus size={14} aria-hidden="true" />
      </button>
    </span>
  )
}

function playFromView(
  controls: PlaybackControls,
  view: PlaybackView,
  item: PlayableItem,
  current: boolean,
  source?: PlaybackSourceFactory,
) {
  const request = {}
  playRequests.set(controls, request)
  if (current && view.snapshot && !view.snapshot.paused) {
    controls.toggle()
    return
  }
  const next = source?.()
  function start(resolved: PlaybackSource | undefined) {
    if (playRequests.get(controls) !== request) return
    if (current && (!resolved || view.source?.href === resolved.href))
      controls.toggle()
    else controls.play(item, resolved)
  }
  if (next instanceof Promise) void next.then(start, () => start(undefined))
  else start(next)
}

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
    play: (source?: PlaybackSourceFactory) =>
      playFromView(controls, view, item, current, source),
  }
}

/** Play and queue buttons over a grid tile's artwork. */
export function TilePlayControls({
  album,
  source,
}: {
  album: AlbumSource
  source?: PlaybackSourceFactory
}) {
  const playback = useAlbumPlayback(album)
  if (!playback)
    return (
      <div className="tile-play">
        <UnavailablePlayButton
          title={album.title}
          available={albumPlayable(album) !== null}
        />
      </div>
    )
  const { item, current, playing, controls, play } = playback
  return (
    <div className="tile-play" data-current={current}>
      <button
        type="button"
        aria-label={`${playing ? 'Pause' : 'Play'} ${album.title}`}
        onClick={() => play(source)}
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
export function AlbumPlayButtons({
  album,
  source,
}: {
  album: AlbumSource
  source?: PlaybackSourceFactory
}) {
  const playback = useAlbumPlayback(album)
  if (!playback)
    return (
      <div className="detail-play">
        <UnavailablePlayButton
          title={album.title}
          available={albumPlayable(album) !== null}
          compact={false}
        />
      </div>
    )
  const { item, playing, controls, play } = playback
  return (
    <div className="detail-play">
      <Button variant="primary" type="button" onClick={() => play(source)}>
        {playing ? (
          <Pause size={14} aria-hidden="true" />
        ) : (
          <Play size={14} aria-hidden="true" />
        )}
        {playing ? 'Pause' : 'Play'}
      </Button>
      <Button type="button" onClick={() => controls.enqueue(item)}>
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
  source,
}: {
  album: AlbumSource
  track: Track
  source?: PlaybackSourceFactory
}) {
  const view = usePlayback()
  const controls = usePlaybackControls()
  const item = view.enabled ? albumPlayable(album, track) : null
  if (!item)
    return (
      <UnavailablePlayButton
        title={track.title}
        available={albumPlayable(album, track) !== null}
        position={track.position}
      />
    )
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
      onClick={() => playFromView(controls, view, item, current, source)}
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
    play: (source?: PlaybackSourceFactory) =>
      playFromView(controls, view, item, current, source),
  }
}

/**
 * Plays one library track. With a position it is the track number of a
 * playlist row. The play icon remains visible beside the position.
 */
export function LibraryTrackPlayButton({
  track,
  position,
  source,
}: {
  track: LibraryTrackSource
  position?: number
  source?: PlaybackSourceFactory
}) {
  const playback = useLibraryTrackPlayback(track)
  if (!playback)
    return (
      <UnavailablePlayButton
        title={track.title}
        available={libraryTrackPlayable(track) !== null}
        position={position}
      />
    )
  const { current, playing, play } = playback
  const Icon = playing ? Pause : Play
  const label = `${playing ? 'Pause' : 'Play'} ${track.title}`
  const onClick = () => play(source)
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
      <span className="track-number">{position}</span>
      <Icon size={12} aria-hidden="true" />
    </button>
  )
}

/** Keeps compact playback actions together in rows and related-item lists. */
export function LibraryTrackInlinePlayButtons({
  track,
  position,
  source,
}: {
  track: LibraryTrackSource
  position?: number
  source?: PlaybackSourceFactory
}) {
  return (
    <span className="inline-flex shrink-0 items-center">
      <LibraryTrackPlayButton
        track={track}
        position={position}
        source={source}
      />
      <LibraryTrackQueueButton track={track} />
    </span>
  )
}

/** Adds one library track to the queue. */
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
      className="track-queue"
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
  if (!playback)
    return (
      <div className="detail-play">
        <UnavailablePlayButton
          title={track.title}
          available={libraryTrackPlayable(track) !== null}
          compact={false}
        />
      </div>
    )
  const { item, current, playing, controls } = playback
  return (
    <div className="detail-play">
      <Button
        variant="primary"
        type="button"
        onClick={() => (current ? controls.toggle() : controls.play(item))}
      >
        {playing ? (
          <Pause size={14} aria-hidden="true" />
        ) : (
          <Play size={14} aria-hidden="true" />
        )}
        {playing ? 'Pause' : 'Play'}
      </Button>
      <Button type="button" onClick={() => controls.enqueue(item)}>
        <ListPlus size={14} aria-hidden="true" />
        Add to queue
      </Button>
    </div>
  )
}
