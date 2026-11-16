'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlbumDetailSchema } from '@repo/schemas/media'
import { PlayHeaderButtons, PlayPair } from '@repo/ui/components/ds/play'
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

/** Why a play pair is disabled, in the words shown on the buttons. */
export function unavailableReason(available: boolean, enabled: boolean) {
  return !available
    ? 'No Spotify recording is available.'
    : !enabled
      ? 'Connect Spotify playback in the player.'
      : 'No playable tracks are available.'
}

/** A row number shown before a row's play pair. */
function Position({ value }: { value?: number }) {
  return value === undefined ? null : (
    <span className="browse-play-position">{value}</span>
  )
}

/**
 * A disabled play pair that says why the item cannot be played. `compact`
 * is the row pair; otherwise the labelled header buttons.
 */
function UnavailablePlayButton({
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
  const reason = unavailableReason(available, playback.enabled)
  if (!compact)
    return (
      <PlayHeaderButtons
        title={title}
        disabled
        disabledReason={reason}
        onPlay={() => undefined}
        onQueue={() => undefined}
      />
    )
  return (
    <>
      <Position value={position} />
      <PlayPair
        place="row"
        title={title}
        disabled
        disabledReason={reason}
        onPlay={() => undefined}
        onQueue={() => undefined}
      />
    </>
  )
}

/** Play and queue at the end of an album's title in a row or table cell. */
export function AlbumInlinePlayButton({
  album,
  source,
}: {
  album: AlbumSource
  source?: PlaybackSourceFactory
}) {
  return <AlbumPair album={album} source={source} place="row" />
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
  return (
    <>
      <PlayPair
        place="row"
        title={title}
        playing={playing}
        disabled={playback.isPending}
        disabledReason="Loading album playback."
        onPlay={() =>
          current && !source ? controls.toggle() : playback.mutate('play')
        }
        onQueue={() => playback.mutate('queue')}
      />
      {playback.isError && (
        <span className="sr-only" role="status">
          Could not load album playback. Try again.
        </span>
      )}
    </>
  )
}

/**
 * Pauses what is playing, resumes the same source, or starts this item from
 * `source`. Only the latest request starts once a source resolves.
 */
export function playFromView(
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

function AlbumPair({
  album,
  source,
  place,
}: {
  album: AlbumSource
  source?: PlaybackSourceFactory
  place: 'tile' | 'row'
}) {
  const view = usePlayback()
  const playback = useAlbumPlayback(album)
  if (!playback)
    return (
      <PlayPair
        place={place}
        title={album.title}
        disabled
        disabledReason={unavailableReason(
          albumPlayable(album) !== null,
          view.enabled,
        )}
        onPlay={() => undefined}
        onQueue={() => undefined}
      />
    )
  const { item, playing, controls, play } = playback
  return (
    <PlayPair
      place={place}
      title={album.title}
      playing={playing}
      onPlay={() => play(source)}
      onQueue={() => controls.enqueue(item)}
    />
  )
}

/** Play and queue on a grid card's artwork. */
export function TilePlayControls({
  album,
  source,
}: {
  album: AlbumSource
  source?: PlaybackSourceFactory
}) {
  return <AlbumPair album={album} source={source} place="tile" />
}

/** Play and queue in the album drawer's heading. */
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
      <UnavailablePlayButton
        title={album.title}
        available={albumPlayable(album) !== null}
        compact={false}
      />
    )
  const { item, playing, controls, play } = playback
  return (
    <PlayHeaderButtons
      title={album.title}
      playing={playing}
      onPlay={() => play(source)}
      onQueue={() => controls.enqueue(item)}
    />
  )
}

/**
 * A track's number followed by its play pair. Play starts the album from
 * this track; Add to queue queues the track alone.
 */
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
  const queued = view.enabled ? trackPlayable(album, track) : null
  if (!item || !queued)
    return (
      <UnavailablePlayButton
        title={track.title}
        available={
          albumPlayable(album, track) !== null &&
          trackPlayable(album, track) !== null
        }
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
    <>
      <Position value={track.position} />
      <PlayPair
        place="row"
        title={track.title}
        playing={playing}
        onPlay={() => playFromView(controls, view, item, current, source)}
        onQueue={() => controls.enqueue(queued)}
      />
    </>
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
 * Play and queue for one library track. With a position, the row number
 * comes first, as in a playlist. `place="tile"` floats the pair on a card's
 * artwork.
 */
export function LibraryTrackPlayButton({
  track,
  position,
  source,
  place = 'row',
}: {
  track: LibraryTrackSource
  position?: number
  source?: PlaybackSourceFactory
  place?: 'tile' | 'row'
}) {
  const view = usePlayback()
  const playback = useLibraryTrackPlayback(track)
  if (!playback)
    return (
      <>
        <Position value={position} />
        <PlayPair
          place={place}
          title={track.title}
          disabled
          disabledReason={unavailableReason(
            libraryTrackPlayable(track) !== null,
            view.enabled,
          )}
          onPlay={() => undefined}
          onQueue={() => undefined}
        />
      </>
    )
  const { item, playing, controls, play } = playback
  return (
    <>
      <Position value={position} />
      <PlayPair
        place={place}
        title={track.title}
        playing={playing}
        onPlay={() => play(source)}
        onQueue={() => controls.enqueue(item)}
      />
    </>
  )
}

/** Play and queue for one library track in rows and related-item lists. */
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
    <LibraryTrackPlayButton track={track} position={position} source={source} />
  )
}

/** Play and queue in the track drawer's heading. */
export function LibraryTrackPlayButtons({
  track,
}: {
  track: LibraryTrackSource
}) {
  const playback = useLibraryTrackPlayback(track)
  if (!playback)
    return (
      <UnavailablePlayButton
        title={track.title}
        available={libraryTrackPlayable(track) !== null}
        compact={false}
      />
    )
  const { item, current, playing, controls } = playback
  return (
    <PlayHeaderButtons
      title={track.title}
      playing={playing}
      onPlay={() => (current ? controls.toggle() : controls.play(item))}
      onQueue={() => controls.enqueue(item)}
    />
  )
}
