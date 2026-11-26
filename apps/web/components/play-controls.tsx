'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlbumDetailSchema } from '@repo/schemas/media'
import { PlayHeaderButtons, PlayPair } from '@repo/ui/components/ds/play'
import { mutationFeedback } from '@repo/ui/components/ui/button'
import {
  playbackItemFeedbackKey,
  usePlaybackPair,
} from './playback-button-feedback'
import { fetchApiData } from '@/utils/api'
import { useConfig } from './providers'
import {
  usePlaybackControls,
  usePlaybackForPlayButton,
  type PlaybackControls,
  type PlaybackView,
} from './playback-provider'
import { spotifyTrackUri } from '@/utils/album-links'
import {
  albumPlayable,
  libraryTrackPlayable,
  playbackReportsTrack,
  trackPlayable,
  type AlbumSource,
  type LibraryTrackSource,
  type PendingPlaybackSource,
  type PlaybackSource,
  type PlayableItem,
} from '@/utils/playback'

type Track = { position: number; externalId: string | null; title: string }
type PlaybackSourceFactory = () =>
  | PlaybackSource
  | PendingPlaybackSource
  | Promise<PlaybackSource>
type PlaybackSourceInput = PlaybackSource | PlaybackSourceFactory
type ViewPlayControls = Pick<PlaybackControls, 'play' | 'toggle'> &
  Partial<Pick<PlaybackControls, 'activate'>>
const playRequests = new WeakMap<ViewPlayControls, object>()

/** Why a play pair is disabled, in the words shown on the buttons. */
export function unavailableReason(available: boolean, view: PlaybackView) {
  if (!available) return 'No Spotify recording is available.'
  if (view.target.kind === 'local' && view.localPlayerLoading)
    return 'Loading the browser player.'
  if (!view.enabled) return 'Connect Spotify playback in the player.'
  return 'No playable tracks are available.'
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
  place = 'row',
}: {
  title: string
  available: boolean
  position?: number
  compact?: boolean
  place?: 'row' | 'tile'
}) {
  const playback = usePlaybackForPlayButton()
  const reason = unavailableReason(available, playback)
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
        place={place}
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
  place = 'row',
}: {
  id: string
  title: string
  source?: PlaybackSourceFactory
  place?: 'row' | 'tile'
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const view = usePlaybackForPlayButton()
  const controls = usePlaybackControls()
  const current = view.current?.albumId === id
  const playing = current && view.snapshot !== null && !view.snapshot.paused
  const pair = usePlaybackPair(`album:${id}`)
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
      if (action === 'queue') pair.enqueue(item, () => controls.enqueue(item))
      else
        pair.start(item, playing, () =>
          playFromView(controls, view, item, current, source),
        )
    },
  })
  const loading = mutationFeedback(playback, {
    pending: 'Loading tracks…',
    success: playback.data ? 'Tracks loaded' : 'No playable tracks',
    error: 'Could not load tracks · retry',
  })
  const loadingFeedback =
    playback.isPending || playback.isError || playback.data === null
      ? loading
      : undefined
  if (!view.enabled)
    return (
      <UnavailablePlayButton
        title={title}
        available={playback.data !== null}
        place={place}
      />
    )
  return (
    <>
      <PlayPair
        place={place}
        title={title}
        playing={playing}
        playDisabled={
          pair.play.pending ||
          (playback.isPending && playback.variables === 'play')
        }
        queueDisabled={playback.isPending && playback.variables === 'queue'}
        playFeedback={
          playback.variables === 'play' && loadingFeedback
            ? loadingFeedback
            : pair.play.feedback
        }
        queueFeedback={
          playback.variables === 'queue' && loadingFeedback
            ? loadingFeedback
            : pair.queue.feedback
        }
        onPlay={() => {
          if (current && !source && view.current)
            pair.start(view.current, playing, controls.toggle)
          else {
            controls.activate?.()
            playback.mutate('play')
          }
        }}
        onQueue={() => playback.mutate('queue')}
      />
    </>
  )
}

/** A captured source has a known destination before Play is pressed. */
export function isDifferentPlaybackSource(
  view: PlaybackView,
  source?: PlaybackSourceInput,
) {
  return typeof source === 'object' && view.source?.href !== source.href
}

/**
 * Pauses what is playing, resumes the same source, or starts this item from
 * `source`. Only the latest request starts once a source resolves.
 */
export function playFromView(
  controls: ViewPlayControls,
  view: PlaybackView,
  item: PlayableItem,
  current: boolean,
  source?: PlaybackSourceInput,
) {
  const request = {}
  playRequests.set(controls, request)
  if (
    current &&
    view.snapshot &&
    !view.snapshot.paused &&
    !isDifferentPlaybackSource(view, source)
  ) {
    controls.toggle()
    return
  }
  const next = typeof source === 'function' ? source() : source
  function start(resolved: PlaybackSource | PendingPlaybackSource | undefined) {
    if (playRequests.get(controls) !== request) return
    const startingCurrent =
      resolved &&
      ('resolve' in resolved || typeof source === 'object') &&
      view.starting &&
      view.current?.uri === item.uri
    if (
      (current || startingCurrent) &&
      (!resolved || view.source?.href === resolved.href)
    )
      controls.toggle()
    else controls.play(item, resolved)
  }
  if (next instanceof Promise) {
    controls.activate?.()
    void next.then(start, () => start(undefined))
  } else start(next)
}

/** The album's playable form and whether the player is on it. Null while playback is off. */
function useAlbumPlayback(album: AlbumSource) {
  const view = usePlaybackForPlayButton()
  const controls = usePlaybackControls()
  const item = view.enabled ? albumPlayable(album) : null
  const pair = usePlaybackPair(playbackItemFeedbackKey(item))
  if (!item) return null
  const current = view.current?.albumId === album.id
  const playing = current && view.snapshot !== null && !view.snapshot.paused
  return {
    item,
    current,
    playing,
    buttons: pair.buttons,
    play: (source?: PlaybackSourceFactory) =>
      pair.start(item, playing, () =>
        playFromView(controls, view, item, current, source),
      ),
    queue: () => pair.enqueue(item, () => controls.enqueue(item)),
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
  const view = usePlaybackForPlayButton()
  const playback = useAlbumPlayback(album)
  if (!playback)
    return (
      <PlayPair
        place={place}
        title={album.title}
        disabled
        disabledReason={unavailableReason(albumPlayable(album) !== null, view)}
        onPlay={() => undefined}
        onQueue={() => undefined}
      />
    )
  const { playing, buttons, play, queue } = playback
  return (
    <PlayPair
      place={place}
      title={album.title}
      playing={playing}
      {...buttons}
      onPlay={() => play(source)}
      onQueue={queue}
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
  const { playing, buttons, play, queue } = playback
  return (
    <PlayHeaderButtons
      title={album.title}
      playing={playing}
      {...buttons}
      onPlay={() => play(source)}
      onQueue={queue}
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
  const view = usePlaybackForPlayButton()
  const controls = usePlaybackControls()
  const item = view.enabled ? albumPlayable(album, track) : null
  const queued = view.enabled ? trackPlayable(album, track) : null
  const pair = usePlaybackPair(
    playbackItemFeedbackKey(item),
    playbackItemFeedbackKey(queued),
  )
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
  const current = snapshot !== null && playbackReportsTrack(snapshot, uri)
  const playing = current && !snapshot.paused
  return (
    <>
      <Position value={track.position} />
      <PlayPair
        place="row"
        title={track.title}
        playing={playing}
        {...pair.buttons}
        onPlay={() =>
          pair.start(item, playing, () =>
            playFromView(controls, view, item, current, source),
          )
        }
        onQueue={() => pair.enqueue(queued, () => controls.enqueue(queued))}
      />
    </>
  )
}

/** A library track's playable form and whether Spotify is playing it. Null while playback is off. */
function useLibraryTrackPlayback(track: LibraryTrackSource) {
  const view = usePlaybackForPlayButton()
  const controls = usePlaybackControls()
  const item = view.enabled ? libraryTrackPlayable(track) : null
  const pair = usePlaybackPair(playbackItemFeedbackKey(item))
  if (!item) return null
  const { snapshot } = view
  const current = snapshot !== null && playbackReportsTrack(snapshot, item.uri)
  const playing = current && !snapshot.paused
  return {
    item,
    current,
    playing,
    buttons: pair.buttons,
    play: (source?: PlaybackSourceInput) =>
      pair.start(
        item,
        playing && !isDifferentPlaybackSource(view, source),
        () => playFromView(controls, view, item, current, source),
      ),
    queue: () => pair.enqueue(item, () => controls.enqueue(item)),
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
  source?: PlaybackSourceInput
  place?: 'tile' | 'row'
}) {
  const view = usePlaybackForPlayButton()
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
            view,
          )}
          onPlay={() => undefined}
          onQueue={() => undefined}
        />
      </>
    )
  const { playing, buttons, play, queue } = playback
  return (
    <>
      <Position value={position} />
      <PlayPair
        place={place}
        title={track.title}
        playing={playing && !isDifferentPlaybackSource(view, source)}
        {...buttons}
        onPlay={() => play(source)}
        onQueue={queue}
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
  const { playing, buttons, play, queue } = playback
  return (
    <PlayHeaderButtons
      title={track.title}
      playing={playing}
      {...buttons}
      onPlay={() => play()}
      onQueue={queue}
    />
  )
}
