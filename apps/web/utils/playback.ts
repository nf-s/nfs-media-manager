import type { AlbumListItem } from '@repo/schemas/media'
import type { TrackListItem } from '@repo/schemas/tracks'
import type {
  PlayableItem,
  PlaybackSnapshot,
  QueueEntry,
  SourceDescriptor,
} from '@repo/schemas/playback'
import { albumSpotifyUri, spotifyTrackUri } from './album-links'

export type {
  PlayableItem,
  PlaybackSnapshot,
  QueueEntry,
} from '@repo/schemas/playback'

/** A captured view whose entries can still be read after navigating away. */
export type PlaybackSource = {
  label: string
  href: string
  length: number
  startIndex: number
  /**
   * An album starts in order whatever the remembered shuffle setting is;
   * a list of tracks or a playlist starts with that setting.
   */
  kind: 'album' | 'list'
  /** One track row, or an album expanded to its playable tracks. */
  load: (index: number) => Promise<PlayableItem[]>
  /**
   * The same for entries spread over the source, read together and answered
   * in the order asked. Shuffled playback uses it where a source has it.
   */
  loadScattered?: (indexes: number[]) => Promise<PlayableItem[][]>
  /**
   * What the entries are read from, so the source can be saved with the
   * shared session and read again after a reload or on another device.
   */
  descriptor?: SourceDescriptor
}

/** A track from the track library, with a Spotify ID only when matched. */
export type LibraryTrackSource = Pick<
  TrackListItem,
  'spotifyTrackId' | 'title' | 'artists' | 'album' | 'albumName' | 'artworkUrl'
> &
  Partial<Pick<TrackListItem, 'id' | 'artistCredits'>>

export type AlbumSource = Pick<
  AlbumListItem,
  | 'id'
  | 'title'
  | 'artworkUrl'
  | 'credits'
  | 'trackCount'
  | 'spotifyUrl'
  | 'links'
  | 'providerReferences'
>
type TrackSource = { externalId: string | null; title: string }

function albumCredits(album: AlbumSource) {
  return album.credits
    .filter((credit) => credit.role === 'artist')
    .map(({ id, name }) => ({ id, name }))
}

function albumArtist(album: AlbumSource): string {
  return albumCredits(album)
    .map((credit) => credit.name)
    .join(', ')
}

/** The album as a playable item, optionally starting at one of its tracks. */
export function albumPlayable(
  album: AlbumSource,
  startTrack?: TrackSource,
): PlayableItem | null {
  const uri = albumSpotifyUri(album)
  if (!uri) return null
  const startUri = spotifyTrackUri(startTrack?.externalId)
  if (startTrack && !startUri) return null
  return {
    kind: 'album',
    uri,
    ...(startUri ? { startUri } : {}),
    title: album.title,
    artist: albumArtist(album),
    albumId: album.id,
    albumTitle: album.title,
    artworkUrl: album.artworkUrl,
    trackCount: album.trackCount,
    credits: albumCredits(album),
  }
}

export function trackPlayable(
  album: AlbumSource,
  track: TrackSource,
): PlayableItem | null {
  const uri = spotifyTrackUri(track.externalId)
  if (!uri) return null
  return {
    kind: 'track',
    uri,
    title: track.title,
    artist: albumArtist(album),
    albumId: album.id,
    albumTitle: album.title,
    artworkUrl: album.artworkUrl,
    trackCount: 1,
    credits: albumCredits(album),
  }
}

/** A library track as a single-track item; its album is the linked library album, if any. */
export function libraryTrackPlayable(
  track: LibraryTrackSource,
): PlayableItem | null {
  const uri = spotifyTrackUri(track.spotifyTrackId)
  if (!uri) return null
  return {
    kind: 'track',
    uri,
    title: track.title,
    artist: track.artists.join(', '),
    albumId: track.album?.id ?? null,
    albumTitle: track.album?.title ?? track.albumName ?? '',
    artworkUrl: track.artworkUrl,
    trackCount: 1,
    ...(track.id ? { trackId: track.id } : {}),
    credits: track.artists.map((name) => ({
      id:
        track.artistCredits?.find((credit) => credit.name === name)?.id ?? null,
      name,
    })),
  }
}

/**
 * Request body for Spotify's start-playback endpoint. The tracks that follow
 * a track go with it, so Spotify keeps playing them on whichever device has
 * the playback.
 */
export function playRequest(
  item: PlayableItem,
  following: readonly PlayableItem[] = [],
  positionMs = 0,
) {
  const from = positionMs > 0 ? { position_ms: Math.round(positionMs) } : {}
  if (item.kind === 'track')
    return { uris: [item.uri, ...following.map((next) => next.uri)], ...from }
  return item.startUri
    ? { context_uri: item.uri, offset: { uri: item.startUri }, ...from }
    : { context_uri: item.uri, ...from }
}

/** The open.spotify.com page for an album, artist or track URI. */
export function spotifyWebUrl(uri: string | null): string | null {
  const match = /^spotify:(album|artist|track):([A-Za-z0-9]{22})$/.exec(
    uri ?? '',
  )
  return match ? `https://open.spotify.com/${match[1]}/${match[2]}` : null
}

export function moveEntry<T>(list: readonly T[], from: number, to: number) {
  const next = [...list]
  const [moved] = next.splice(from, 1)
  if (moved === undefined || to < 0 || to >= list.length) return [...list]
  next.splice(to, 0, moved)
  return next
}

export function queueSummary(queue: readonly QueueEntry[]): string {
  const albums = queue.filter((entry) => entry.item.kind === 'album').length
  const tracks = queue.length - albums
  return [
    albums ? `${albums} ${albums === 1 ? 'album' : 'albums'}` : '',
    tracks ? `${tracks} ${tracks === 1 ? 'track' : 'tracks'}` : '',
  ]
    .filter(Boolean)
    .join(', ')
}

export function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function positionAt(snapshot: PlaybackSnapshot, now: number): number {
  if (snapshot.paused) return snapshot.positionMs
  const position = snapshot.positionMs + Math.max(0, now - snapshot.at)
  return snapshot.durationMs > 0
    ? Math.min(position, snapshot.durationMs)
    : position
}

/** The item this app started, followed until it finishes or something else takes over. */
export type PlaybackSession = {
  item: PlayableItem
  phase: 'starting' | 'playing'
  startedAt: number
  /** For a track item, the URI Spotify actually played for it. */
  anchorUri: string | null
  /** The tracks Spotify was given in one request; `item` is `sent[index]`. */
  sent: PlayableItem[]
  index: number
  /** The track the device was on when another item's start was requested. */
  replacedUri?: string | null
  /** The start was sent a second time because the device ignored the first. */
  resent?: boolean
}
export type SessionEvent = 'none' | 'finished' | 'left'

const START_GRACE_MS = 10_000
const RELINK_GRACE_MS = 3_000
const END_TOLERANCE_MS = 3_000
const SKIP_WINDOW_MS = 6_000
/** How far before the saved position a device may report the same track. */
const REJOIN_BACK_MS = 5_000

export function startSession(
  item: PlayableItem,
  now: number,
  replacedUri: string | null = null,
): PlaybackSession {
  return {
    item,
    phase: 'starting',
    startedAt: now,
    anchorUri: null,
    sent: [item],
    index: 0,
    replacedUri,
  }
}

/** A track that began after the start was requested, once it has had time. */
function beganAfterStart(session: PlaybackSession, after: PlaybackSnapshot) {
  const sinceStart = after.at - session.startedAt
  return (
    !after.paused &&
    sinceStart >= RELINK_GRACE_MS &&
    after.positionMs <= sinceStart + 2_000
  )
}

/**
 * Whether the device answered a start by playing what it already had from its
 * beginning: the request was accepted and then not acted on.
 */
export function startIgnored(
  session: PlaybackSession,
  after: PlaybackSnapshot,
): boolean {
  return (
    session.phase === 'starting' &&
    !!session.replacedUri &&
    after.trackUri === session.replacedUri &&
    beganAfterStart(session, after)
  )
}

export function sessionContains(
  session: PlaybackSession,
  snapshot: PlaybackSnapshot,
): boolean {
  return session.item.kind === 'album'
    ? snapshot.contextUri === session.item.uri
    : snapshot.trackUri !== null && snapshot.trackUri === session.anchorUri
}

function ranOutOrSkipped(
  before: PlaybackSnapshot | null,
  after: PlaybackSnapshot,
  skippedAt: number | null,
): boolean {
  if (!before || before.paused) return false
  const ranOut =
    before.durationMs > 0 &&
    before.positionMs + (after.at - before.at) >=
      before.durationMs - END_TOLERANCE_MS
  const skipped =
    skippedAt !== null &&
    after.at >= skippedAt &&
    after.at - skippedAt <= SKIP_WINDOW_MS
  return ranOut || skipped
}

/**
 * What a saved session finds on its device when the app is opened again:
 * `rejoined` when the device still plays the tracks it was given, on the
 * saved one at or past the saved position or on a later one; `ended` when
 * nothing is loaded any more or the tracks ran out and went back to the
 * start; `changed` when the device plays or holds something else.
 */
export type RejoinVerdict =
  | { verdict: 'rejoined'; index: number }
  | { verdict: 'ended' | 'changed' }

export function rejoinVerdict(
  session: Pick<PlaybackSession, 'item' | 'sent' | 'index' | 'anchorUri'>,
  saved: PlaybackSnapshot | null,
  after: PlaybackSnapshot | null,
  /** The device reports that it is stopped, with nothing to resume. */
  idle: boolean,
): RejoinVerdict {
  if (!after || idle) return { verdict: 'ended' }
  // The app plays tracks and albums only, never a playlist.
  if (after.contextUri?.startsWith('spotify:playlist:'))
    return { verdict: 'changed' }
  const reset = after.paused && after.positionMs <= END_TOLERANCE_MS
  const sameTrack =
    saved !== null &&
    saved.trackUri !== null &&
    saved.trackUri === after.trackUri
  const wentBack =
    sameTrack && after.positionMs + REJOIN_BACK_MS < saved.positionMs
  const { item } = session
  if (item.kind === 'album') {
    if (after.contextUri !== item.uri) return { verdict: 'changed' }
    // A finished album stops at the start of its first track.
    const restarted =
      !sameTrack &&
      reset &&
      after.trackNumber === 1 &&
      (after.discNumber ?? 1) === 1
    if (wentBack || restarted) return { verdict: reset ? 'ended' : 'changed' }
    return { verdict: 'rejoined', index: session.index }
  }
  const playing = (sent: PlayableItem) =>
    sent.uri === after.trackUri || sent.uri === after.linkedFromUri
  let index = session.sent.findIndex(
    (sent, at) => at >= session.index && playing(sent),
  )
  // Spotify may have played another recording of the current track.
  if (index < 0 && after.trackUri && after.trackUri === session.anchorUri)
    index = session.index
  if (index < 0) {
    // A finished list returns to one of its earlier tracks and stops there.
    const earlier = session.sent.some(playing)
    return { verdict: earlier && reset ? 'ended' : 'changed' }
  }
  if (index === session.index && wentBack)
    return { verdict: reset ? 'ended' : 'changed' }
  return { verdict: 'rejoined', index }
}

/**
 * Advances a session with a new observation. `finished` means the item played
 * to its end (the queue may continue); `left` means other playback replaced it.
 */
export function stepSession(
  session: PlaybackSession,
  before: PlaybackSnapshot | null,
  after: PlaybackSnapshot,
  skippedAt: number | null = null,
): { session: PlaybackSession; event: SessionEvent } {
  const { item } = session
  if (session.phase === 'starting') {
    const sinceStart = after.at - session.startedAt
    if (item.kind === 'album' && after.contextUri === item.uri)
      return { session: { ...session, phase: 'playing' }, event: 'none' }
    if (item.kind === 'track' && after.trackUri) {
      const requested =
        after.trackUri === item.uri || after.linkedFromUri === item.uri
      // Spotify may play another recording of the requested track. Accept a
      // track that began after the request once the direct match has had time,
      // unless it is the track the device was already on: that is the earlier
      // playback starting again, not the requested track.
      const substituted =
        beganAfterStart(session, after) &&
        after.trackUri !== session.replacedUri
      if (requested || substituted)
        return {
          session: { ...session, phase: 'playing', anchorUri: after.trackUri },
          event: 'none',
        }
    }
    return { session, event: sinceStart > START_GRACE_MS ? 'left' : 'none' }
  }
  const ended = ranOutOrSkipped(before, after, skippedAt)
  if (!sessionContains(session, after))
    return { session, event: ended ? 'finished' : 'left' }
  if (!before || before.paused || !after.paused || after.positionMs !== 0)
    return { session, event: 'none' }
  // A finished context stops at the start of its first track. Stopping there
  // from another track is the end of the album however it was reached, such
  // as a skip made on another device.
  const first = after.trackNumber === 1 && (after.discNumber ?? 1) === 1
  const reset =
    item.kind === 'album' &&
    after.trackUri !== before.trackUri &&
    (before.hasNext === false || (before.hasNext === null && first))
  if (reset) return { session, event: 'finished' }
  // The same track stopped at its start only ends the item if it ran out.
  const wasLastTrack =
    item.kind === 'track' ||
    before.hasNext === false ||
    (before.hasNext === null && first && item.trackCount === 1)
  return { session, event: ended && wasLastTrack ? 'finished' : 'none' }
}
