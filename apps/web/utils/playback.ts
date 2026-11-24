import type { AlbumListItem } from '@repo/schemas/media'
import type { TrackDetail, TrackListItem } from '@repo/schemas/tracks'
import { spotifyIdPattern } from '@repo/schemas/playback'
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

/** A captured track list whose exact extent is still being read. */
export type PendingPlaybackSource = Omit<PlaybackSource, 'length'> & {
  resolve: () => Promise<PlaybackSource>
  withLength: (length: number) => PlaybackSource
  readPageEnd: (index: number) => Promise<{ end: number; hasMore: boolean }>
}

/** A track from the track library, with a Spotify ID only when matched. */
export type LibraryTrackSource = Pick<
  TrackListItem,
  'spotifyTrackId' | 'title' | 'artists' | 'album' | 'albumName' | 'artworkUrl'
> &
  Partial<
    Pick<TrackListItem, 'id' | 'artistCredits'> &
      Pick<TrackDetail, 'spotifyAlbumId'>
  >

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
  const albumUri = albumSpotifyUri(album)
  return {
    kind: 'track',
    uri,
    title: track.title,
    artist: albumArtist(album),
    albumId: album.id,
    ...(albumUri ? { albumUri } : {}),
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
  const albumUri =
    track.spotifyAlbumId && spotifyIdPattern.test(track.spotifyAlbumId)
      ? `spotify:album:${track.spotifyAlbumId}`
      : undefined
  return {
    kind: 'track',
    uri,
    title: track.title,
    artist: track.artists.join(', '),
    albumId: track.album?.id ?? null,
    ...(albumUri ? { albumUri } : {}),
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

export function playbackReportsTrack(
  snapshot: PlaybackSnapshot,
  uri: string | null | undefined,
) {
  return (
    uri != null &&
    (uri === snapshot.trackUri ||
      uri === snapshot.linkedFromUri ||
      uri === snapshot.relinkedTrackUri ||
      uri === snapshot.verifiedRequestedTrackUri)
  )
}

export function withVerifiedPlaybackTrack(
  snapshot: PlaybackSnapshot,
  item: PlayableItem | null,
  verifiedRecordingUri: string | undefined,
): PlaybackSnapshot {
  if (
    item?.kind !== 'track' ||
    !verifiedRecordingUri ||
    verifiedRecordingUri !== snapshot.trackUri ||
    snapshot.isLocal ||
    (snapshot.linkedFromUri && snapshot.linkedFromUri !== item.uri)
  )
    return snapshot
  return { ...snapshot, verifiedRequestedTrackUri: item.uri }
}

/** The item this app started, followed until it finishes or something else takes over. */
export type PlaybackSession = {
  item: PlayableItem
  phase: 'starting' | 'playing'
  startedAt: number
  /** For a track item, the URI Spotify actually played for it. */
  anchorUri: string | null
  /** The exact recording Spotify reported independently of a same-title start. */
  verifiedRecordingUri?: string
  /** The device's sequence of tracks; `item` is `sent[index]`. */
  sent: PlayableItem[]
  index: number
  /** Last index queued ahead of the Spotify playback context, if any remain. */
  queuedThrough?: number
  /** The track the device was on when another item's start was requested. */
  replacedUri?: string | null
  /**
   * For a track item, the recording Spotify plays for it here, once Spotify
   * was asked; null when it plays none or could not say.
   */
  playsAs?: string | null
}
export type SessionEvent = 'none' | 'finished' | 'left'

const START_GRACE_MS = 10_000
const RELINK_GRACE_MS = 3_000
const END_TOLERANCE_MS = 3_000
const SKIP_WINDOW_MS = 6_000
/** How far before the saved position a device may report the same track. */
const REJOIN_BACK_MS = 5_000
/**
 * How long ago a device may last have been read for the page to know what it
 * has played since. Past this, as after the computer slept, the device is
 * picked up like a saved session's.
 */
export const WATCHED_MS = 90_000
/** Other music that began this soon after the last read began as the item ran out. */
const WATCHED_CLOSELY_MS = 10_000

/** Two recordings of one track carry the same name. */
export function sameName(one: string, other: string) {
  const name = one.trim().toLowerCase()
  return name !== '' && name === other.trim().toLowerCase()
}

/**
 * Where a device's track is among the tracks it was given, from `from` on;
 * -1 when it is none of them. Spotify can play another recording of a track
 * than the one asked for, so a track of the same name is taken for it when
 * no URI matches.
 */
export function givenIndex(
  sent: readonly PlayableItem[],
  from: number,
  shown: Pick<PlaybackSnapshot, 'trackUri' | 'linkedFromUri' | 'trackName'>,
): number {
  if (!shown.trackUri) return -1
  const exact = sent.findIndex(
    (item, at) =>
      at >= from &&
      (item.uri === shown.trackUri || item.uri === shown.linkedFromUri),
  )
  if (exact >= 0) return exact
  return sent.findIndex(
    (item, at) =>
      at >= from &&
      item.kind === 'track' &&
      sameName(item.title, shown.trackName),
  )
}

/** A track the account played, from Spotify's play history. */
export type PlayedTrack = { uri: string; name: string; playedAt: number }

/**
 * How far the tracks a device was given were played while no page followed
 * it: the index of the one due after the last of them in the account's play
 * history since `since`, or `from` when none was played. Tracks skipped on
 * the way are passed over with it.
 */
export function playedThrough(
  sent: readonly PlayableItem[],
  from: number,
  history: readonly PlayedTrack[],
  since: number,
): number {
  let due = from
  const played = history
    .filter((entry) => entry.playedAt > since)
    .sort((one, other) => one.playedAt - other.playedAt)
  for (const entry of played) {
    const index = givenIndex(sent, due, {
      trackUri: entry.uri,
      linkedFromUri: null,
      trackName: entry.name,
    })
    if (index >= 0) due = index + 1
  }
  return due
}

/**
 * Whether the queue goes on by itself once an item has finished. It does
 * when the device has stopped at the end of what it was given, and when
 * other music began as the last of it ran out while this page was reading
 * the device, which is Spotify carrying on with music of its own choice.
 * Other music found playing was chosen by someone and is left alone: nothing
 * is started over it.
 */
export function queueContinues(
  session: Pick<PlaybackSession, 'item' | 'sent' | 'index'>,
  before: PlaybackSnapshot | null,
  after: PlaybackSnapshot,
): boolean {
  if (!before) return false
  const unread = after.at - before.at
  if (unread > WATCHED_MS) return false
  if (after.paused) return after.positionMs <= END_TOLERANCE_MS
  const last =
    session.item.kind === 'album' || session.index >= session.sent.length - 1
  return last && unread <= WATCHED_CLOSELY_MS
}

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

/** The device plays the track item being started, or its recording here. */
function requestedTrack(session: PlaybackSession, after: PlaybackSnapshot) {
  const { uri } = session.item
  return (
    after.trackUri === uri ||
    after.linkedFromUri === uri ||
    (!!session.playsAs && after.trackUri === session.playsAs)
  )
}

/**
 * Whether the device answered a start by beginning something else, such as
 * the track it already had from its beginning: the request was accepted and
 * then not acted on. That track is known when the device was heard on it
 * before. Otherwise an album is told by its context, and a track once Spotify
 * has said which recording it plays for the item.
 */
export function startIgnored(
  session: PlaybackSession,
  after: PlaybackSnapshot,
): boolean {
  if (
    session.phase !== 'starting' ||
    !after.trackUri ||
    !beganAfterStart(session, after)
  )
    return false
  const earlier = after.trackUri === session.replacedUri
  if (session.item.kind === 'album')
    return earlier || after.contextUri !== session.item.uri
  if (requestedTrack(session, after)) return false
  return earlier || typeof session.playsAs === 'string'
}

/**
 * Whether a track that began after a track item's start needs Spotify's word
 * on what it is: another recording of the item, a track sent after one that
 * cannot be played, or the start being ignored.
 */
export function startUnverified(
  session: PlaybackSession,
  after: PlaybackSnapshot,
): boolean {
  return (
    session.phase === 'starting' &&
    session.item.kind === 'track' &&
    session.playsAs === undefined &&
    !!after.trackUri &&
    after.trackUri !== session.replacedUri &&
    !requestedTrack(session, after) &&
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
  /** `finished` when the device is known to have played all it was given. */
  | { verdict: 'ended'; finished: boolean }
  | { verdict: 'changed' }

export function rejoinVerdict(
  session: Pick<PlaybackSession, 'item' | 'sent' | 'index' | 'anchorUri'>,
  saved: PlaybackSnapshot | null,
  after: PlaybackSnapshot | null,
  /** The device reports that it is stopped, with nothing to resume. */
  idle: boolean,
): RejoinVerdict {
  if (!after || idle) return { verdict: 'ended', finished: false }
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
  /** Earlier in the queue: stopped at a start it has ended, otherwise it changed. */
  const back = (finished: boolean): RejoinVerdict =>
    reset ? { verdict: 'ended', finished } : { verdict: 'changed' }
  const { item } = session
  if (item.kind === 'album') {
    if (after.contextUri !== item.uri) return { verdict: 'changed' }
    // A finished album stops at the start of its first track.
    const restarted =
      !sameTrack &&
      reset &&
      after.trackNumber === 1 &&
      (after.discNumber ?? 1) === 1
    if (restarted) return { verdict: 'ended', finished: true }
    if (wentBack) return back(false)
    return { verdict: 'rejoined', index: session.index }
  }
  let index = givenIndex(session.sent, session.index, after)
  // Spotify may have played another recording of the current track.
  if (index < 0 && after.trackUri && after.trackUri === session.anchorUri)
    index = session.index
  if (index < 0) {
    // A finished list returns to one of its earlier tracks and stops there.
    const earlier = givenIndex(session.sent, 0, after) >= 0
    return earlier ? back(true) : { verdict: 'changed' }
  }
  if (index === session.index && wentBack) return back(false)
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
      // Spotify may play another recording of the requested track, or go on
      // to the next track sent when it cannot be played. Accept a track that
      // began after the request once the direct match has had time, unless it
      // is the track the device was already on, or Spotify has named the
      // recording it plays for the item: that is the earlier playback
      // starting again, not the requested track.
      const substituted =
        beganAfterStart(session, after) &&
        after.trackUri !== session.replacedUri &&
        typeof session.playsAs !== 'string'
      if (requestedTrack(session, after) || substituted)
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
