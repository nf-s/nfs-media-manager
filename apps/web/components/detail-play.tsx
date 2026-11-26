'use client'

import { PlayHeaderButtons, PlayPair } from '@repo/ui/components/ds/play'
import {
  albumPlayable,
  libraryTrackPlayable,
  playbackReportsTrack,
  type AlbumSource,
  type LibraryTrackSource,
  type PlaybackSource,
} from '@/utils/playback'
import {
  usePlaybackControls,
  usePlaybackForPlayButton,
} from './playback-provider'
import {
  isDifferentPlaybackSource,
  playFromView,
  unavailableReason,
} from './play-controls'

/** A library track's playable form and whether the player is on it. */
export function useTrackPlayback(
  track: LibraryTrackSource,
  source?: PlaybackSource,
) {
  const view = usePlaybackForPlayButton()
  const controls = usePlaybackControls()
  const available = libraryTrackPlayable(track)
  const item = view.enabled ? available : null
  const snapshot = view.snapshot
  const current =
    item !== null &&
    snapshot !== null &&
    playbackReportsTrack(snapshot, item.uri)
  return {
    item,
    current,
    playing:
      current &&
      snapshot !== null &&
      !snapshot.paused &&
      !isDifferentPlaybackSource(view, source),
    reason: unavailableReason(available !== null, view),
    play: (from?: () => PlaybackSource) =>
      item && playFromView(controls, view, item, current, from ?? source),
    queue: () => item && controls.enqueue(item),
  }
}

/** An album's playable form and whether the player is on it. */
function useAlbumPlayback(album: AlbumSource) {
  const view = usePlaybackForPlayButton()
  const controls = usePlaybackControls()
  const available = albumPlayable(album)
  const item = view.enabled ? available : null
  const current = view.current?.albumId === album.id
  return {
    item,
    playing: current && view.snapshot !== null && !view.snapshot.paused,
    reason: unavailableReason(available !== null, view),
    play: (source?: () => PlaybackSource) =>
      item && playFromView(controls, view, item, current, source),
    queue: () => item && controls.enqueue(item),
  }
}

/** Play and Queue in an album's detail header. */
export function AlbumHeaderPlay({
  album,
  source,
}: {
  album: AlbumSource
  /** Where the player returns to and which tracks it plays. */
  source: () => PlaybackSource
}) {
  const playback = useAlbumPlayback(album)
  return (
    <PlayHeaderButtons
      title={album.title}
      playing={playback.playing}
      disabled={!playback.item}
      disabledReason={playback.reason}
      onPlay={() => playback.play(source)}
      onQueue={playback.queue}
    />
  )
}

/** The play pair of an album card or row inside another item's detail. */
export function AlbumPlay({
  album,
  place,
}: {
  album: AlbumSource
  place: 'tile' | 'row'
}) {
  const playback = useAlbumPlayback(album)
  return (
    <PlayPair
      place={place}
      title={album.title}
      playing={playback.playing}
      disabled={!playback.item}
      disabledReason={playback.reason}
      onPlay={() => playback.play()}
      onQueue={playback.queue}
    />
  )
}

/** Play and Queue in a library track's detail header. */
export function TrackHeaderPlay({
  track,
  source,
}: {
  track: LibraryTrackSource
  source?: PlaybackSource
}) {
  const playback = useTrackPlayback(track, source)
  return (
    <PlayHeaderButtons
      title={track.title}
      playing={playback.playing}
      disabled={!playback.item}
      disabledReason={playback.reason}
      onPlay={() => playback.play()}
      onQueue={playback.queue}
    />
  )
}

/** The play pair at the end of a track's title cell. */
export function TrackRowPlay({
  track,
  source,
}: {
  track: LibraryTrackSource
  /** Plays the track within its album or playlist. */
  source?: () => PlaybackSource
}) {
  const playback = useTrackPlayback(track)
  return (
    <PlayPair
      place="row"
      title={track.title}
      playing={playback.playing}
      disabled={!playback.item}
      disabledReason={playback.reason}
      onPlay={() => playback.play(source)}
      onQueue={playback.queue}
    />
  )
}
