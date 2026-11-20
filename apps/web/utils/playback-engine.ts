import {
  givenIndex,
  moveEntry,
  playRequest,
  playedThrough,
  positionAt,
  queueContinues,
  rejoinVerdict,
  sameName,
  startIgnored,
  startSession,
  startUnverified,
  stepSession,
  WATCHED_MS,
  type PendingPlaybackSource,
  type PlayableItem,
  type PlayedTrack,
  type PlaybackSource,
  type PlaybackSession,
  type PlaybackSnapshot,
  type QueueEntry,
  type SessionEvent,
} from './playback'
import {
  playbackFailure,
  SdkFailure,
  type PlaybackFailure,
} from './playback-failure'
import {
  httpsUrl,
  PlaybackApiError,
  type PlaybackDevice,
  type PlayerApi,
  type TrackDetails,
} from './spotify-player-api'
import {
  sdkDeviceId,
  sdkErrorEvents,
  sdkPlayback,
  type SpotifySdk,
  type SpotifySdkPlayer,
} from './spotify-sdk'
import type {
  SonosCommand,
  SonosContentInput,
  SonosGroupControl,
  SonosGroupState,
} from '@repo/schemas/sonos'
import type { SonosControlApi } from './sonos-player-api'
import {
  earlierPlays,
  finishedPlays,
  hearRoom,
  listenDue,
  type RoomPlay,
  type Sighting,
} from './room-listen'
import type { LastfmPlay } from '@repo/schemas/lastfm'
import type {
  PlaybackListen,
  SavedPlayback,
  SavedSource,
  SavedTarget,
  SharedSonosObservation,
} from '@repo/schemas/playback'

/** A Sonos group, with the household whose Spotify account it plays with. */
export type SonosRoomRef = { id: string; name: string; household: string }
export type PlaybackTarget =
  | { kind: 'local' }
  | { kind: 'remote'; device: PlaybackDevice }
  /** A device Spotify does not let apps control: its playback is shown only. */
  | { kind: 'restricted'; name: string; type: string }
  /** A restricted Sonos group, controlled through the Sonos connection instead. */
  | { kind: 'sonos'; name: string; type: string; group: SonosGroupControl }
  /**
   * A Sonos group played through Sonos itself: Sonos loads the Spotify tracks
   * into the group's own queue and reports what it plays.
   */
  | { kind: 'room'; room: SonosRoomRef }
/** A target playback can be started on or moved to. */
export type SelectableTarget = Exclude<
  PlaybackTarget,
  { kind: 'restricted' | 'sonos' }
>
/** A device followed through Spotify's report of the account's playback. */
type FollowedTarget = Exclude<PlaybackTarget, { kind: 'local' | 'room' }>
type RoomTarget = Extract<PlaybackTarget, { kind: 'room' }>
type SonosTarget = Extract<PlaybackTarget, { kind: 'room' | 'sonos' }>
/** A device Spotify reports but accepts no app commands for. */
type ObservedTarget = Extract<PlaybackTarget, { kind: 'restricted' | 'sonos' }>
type RemoteState = Awaited<ReturnType<PlayerApi['state']>>

/** How this page takes part in the account's shared session. */
export type PlaybackSharing = {
  /**
   * The driver runs the queue: it follows the device and gives it the tracks
   * due next. A follower shows the driver's queue and takes over when it is
   * used here or the driver goes away.
   */
  role: 'driver' | 'follower'
  /** The client running the queue, when it is not this page. */
  driverName: string | null
}

/** What became of a saved session's playback when this page took it over. */
export type PlaybackRejoin = {
  /**
   * `checking` while the device is read; `rejoined` when it still plays the
   * queue it was given; `changed` when it plays or holds something else;
   * `ended` when nothing is loaded on it any more; `unreadable` when it could
   * not be read.
   */
  status: 'checking' | 'rejoined' | 'changed' | 'ended' | 'unreadable'
  /** The room or device the session played on; null until it is known. */
  device: string | null
}

export type PlaybackState = {
  /**
   * The account is playing something, or something was played or queued here,
   * so the player is shown.
   */
  active: boolean
  /** The queue item this app started and is following; null for other playback. */
  current: PlayableItem | null
  /** What the target device is playing. */
  snapshot: PlaybackSnapshot | null
  queue: QueueEntry[]
  source: Pick<PlaybackSource, 'label' | 'href'> | null
  /**
   * The next source tracks, after the manual queue. A key names its track in
   * the source for as long as the source plays.
   */
  upcoming: QueueEntry[]
  shuffle: boolean
  sourceLoading: boolean
  target: PlaybackTarget
  /** Other Spotify devices; this browser is not listed. */
  devices: PlaybackDevice[]
  devicesStatus: 'idle' | 'loading' | 'error'
  /** The Sonos group behind a restricted device is being looked up. */
  findingSonos: boolean
  /** 0 to 1, or null when the target device's volume cannot be set from here. */
  volume: number | null
  starting: boolean
  failure: PlaybackFailure | null
  /** Latest queue change, for assistive technology. */
  announcement: string
  /** Set by the session sync; the engine alone always runs its own queue. */
  sharing: PlaybackSharing
  /** Taking over a saved session's device, and its outcome. */
  rejoin: PlaybackRejoin | null
}

export const idlePlaybackState: PlaybackState = {
  active: false,
  current: null,
  snapshot: null,
  queue: [],
  source: null,
  upcoming: [],
  shuffle: false,
  sourceLoading: false,
  target: { kind: 'local' },
  devices: [],
  devicesStatus: 'idle',
  findingSonos: false,
  volume: null,
  starting: false,
  failure: null,
  announcement: '',
  sharing: { role: 'driver', driverName: null },
  rejoin: null,
}

export type PlaybackEngineOptions = {
  api: PlayerApi
  token: (refresh?: boolean) => Promise<string>
  loadSdk: () => Promise<SpotifySdk>
  playerName: string
  initialVolume: number
  onLocalVolume?: (volume: number) => void
  /** The shuffle setting remembered for lists and playlists. */
  initialShuffle?: boolean
  onShuffle?: (shuffle: boolean) => void
  now?: () => number
  random?: () => number
  /** Whether the page is visible; idle remote polling stops while hidden. */
  visible?: () => boolean
  /** Plays on and controls Sonos groups through the Sonos connection. */
  sonos?: SonosControlApi
  /** The Sonos group chosen as the device last time. */
  initialRoom?: SonosRoomRef | null
  onRoom?: (room: SonosRoomRef | null) => void
  /**
   * Names this browser tab, the same after a reload, so a saved session can
   * tell whether the browser it played in was this one.
   */
  browserId?: string
  /** Reads a saved source's entries again; null when it cannot be read. */
  restoreSource?: (saved: SavedSource) => PlaybackSource | null
  /**
   * Takes the tracks played on a Sonos room that this app loaded there, for
   * scrobbling. Nothing is counted while `enabled` answers false.
   */
  scrobbles?: {
    enabled: () => boolean
    report: (plays: LastfmPlay[]) => void
  }
}

const LOCAL_POLL_MS = 1_000
const REMOTE_POLL_MS = 3_000
const IDLE_POLL_MS = 5_000
const FOLLOW_UP_MS = 700
const TRANSFER_SETTLE_MS = 5_000
const READY_TIMEOUT_MS = 15_000
const START_TIMEOUT_MS = 15_000
const DEVICE_RETRY_MS = 700
const REJOIN_NOTICE_MS = 10_000
const DEVICE_RETRIES = 6
const VOLUME_DEBOUNCE_MS = 250
const REMOTE_QUEUE_DEBOUNCE_MS = 200
const RESTART_AFTER_MS = 3_000
const MISSING_STATES = 3
/** How long a start waits for the tracks that follow, so they go with it. */
const FOLLOWING_WAIT_MS = 500
const FOLLOWING_LIMIT = 50
/** A track that began this recently after the last one ended is its successor. */
const SUCCESSOR_WITHIN_MS = 5_000
const SONOS_TRIES = 3
const SONOS_RETRY_MS = 2_000
const ROOM_PLAYING_POLL_MS = 15_000
const ROOM_IDLE_POLL_MS = 30_000
/**
 * Tracks kept in a Sonos group's queue after the current one. Sonos takes
 * about a second for each track added, so they are added one at a time and a
 * skip never waits behind more than one of them.
 */
const ROOM_AHEAD = 10
const ROOM_VOLUME_EVERY = 5
/** How long the group's queue is left alone after Sonos refused a change to it. */
const ROOM_RETRY_MS = 15_000
/** How long a Sonos group may keep reporting the track before the one it was told to play. */
const ROOM_EXPECT_MS = 6_000
/** Source tracks saved either side of the current one. */
const SAVED_TRACKS = 50
/** Tracks given to a device that are saved with a session. */
const SAVED_SENT = 150
const LOCAL: Extract<PlaybackTarget, { kind: 'local' }> = { kind: 'local' }
/** How a device is checked that this page stopped following without closing. */
const UNFOLLOWED = {
  idle: false,
  unreadable: false,
  announce: false,
  device: null,
}
const NOT_STARTED: PlaybackFailure = {
  status: 'error',
  message: 'Playback did not start. Try again or choose a device.',
}

type Waiter = { resolve: (id: string) => void; reject: (error: Error) => void }

type SourceTrack = { index: number; position: number; item: PlayableItem }
/** A track due to play after the current one, from the queue or the source. */
type Planned =
  | { from: 'queue'; item: PlayableItem; entry: QueueEntry }
  | { from: 'source'; item: PlayableItem; entry: SourceTrack }
type SourceSession = {
  definition: Omit<PlaybackSource, 'length'> & { length: number | undefined }
  ordered?: {
    nextIndex: number
    readPageEnd: PendingPlaybackSource['readPageEnd']
    terminal?: number
    complete: (end: number) => void
  }
  tracks: Map<number, Promise<PlayableItem[]>>
  remaining: number[]
  /** Tracks played, and those moved to the queue or removed by hand. */
  played: Set<string>
  /** Tracks passed over; a shuffle may still draw them. */
  skipped: Set<string>
  exhausted: Set<number>
  upcoming: SourceTrack[]
  history: SourceTrack[]
  initializing: boolean
  revision: number
  filling: Promise<void> | null
  /**
   * Random picks drawn ahead for a shuffled fill: the entry, then the track in
   * it. A pick read together with others names its entry outright.
   */
  draws: Array<{ entry: number; track: number; index?: number }>
}

/** Source tracks resolved ahead: shown as upcoming and sent to Spotify with a track. */
const SOURCE_AHEAD_SIZE = 30
/** Holds a whole round of shuffled picks beside the entries still in use. */
const SOURCE_CACHE_SIZE = 60
/** Source entries of a shuffled list loaded at the same time. */
const SOURCE_PARALLEL = 6

function sourceTrackKey(index: number, position: number) {
  return `${index}:${position}`
}

/** Source tracks as they are shown: each under the key of its place in the source. */
export function upcomingEntries(tracks: readonly SourceTrack[]): QueueEntry[] {
  return tracks.map(({ index, position, item }) => ({
    key: sourceTrackKey(index, position),
    item,
  }))
}

/** Ascending indexes as `[from, to)` ranges, and back. */
function indexRanges(indexes: readonly number[]) {
  const ranges: Array<[number, number]> = []
  for (const index of [...indexes].sort((a, b) => a - b)) {
    const last = ranges.at(-1)
    if (last && last[1] === index) last[1] = index + 1
    else if (!last || index > last[1]) ranges.push([index, index + 1])
  }
  return ranges
}

function rangeIndexes(ranges: ReadonlyArray<readonly [number, number]>) {
  return ranges.flatMap(([from, to]) =>
    Array.from(
      { length: Math.max(0, to - from) },
      (_, offset) => from + offset,
    ),
  )
}

function isObserved(target: PlaybackTarget): target is ObservedTarget {
  return target.kind === 'restricted' || target.kind === 'sonos'
}

function isSonosTarget(target: PlaybackTarget): target is SonosTarget {
  return target.kind === 'room' || target.kind === 'sonos'
}

function sameDevice(a: PlaybackTarget, b: PlaybackTarget) {
  if (a.kind === 'remote' && b.kind === 'remote')
    return a.device.id === b.device.id
  if (a.kind === 'room' && b.kind === 'room') return a.room.id === b.room.id
  if (isObserved(a) && isObserved(b))
    return a.name === b.name && a.type === b.type
  return a.kind === b.kind && a.kind === 'local'
}

function targetVolume(target: FollowedTarget) {
  if (target.kind === 'remote') return target.device.volume
  return target.kind === 'sonos' ? target.group.volume : null
}

function sameShown(shown: PlaybackSnapshot | null, after: PlaybackSnapshot) {
  return (
    shown !== null &&
    shown.trackUri === after.trackUri &&
    shown.paused === after.paused &&
    shown.durationMs === after.durationMs &&
    shown.contextUri === after.contextUri &&
    shown.trackName === after.trackName &&
    shown.artworkUrl === after.artworkUrl &&
    Math.abs(positionAt(shown, after.at) - after.positionMs) < 1_500
  )
}

/** What a Sonos group reports, in the shape the player follows. */
function roomSnapshot(
  reported: SonosGroupState,
  at: number,
): PlaybackSnapshot | null {
  const track = reported.track
  if (!track) return null
  return {
    trackUri: track.uri,
    linkedFromUri: null,
    trackName: track.name ?? '',
    artists: track.artist ?? '',
    albumName: track.album ?? '',
    albumUri: reported.containerUri?.startsWith('spotify:album:')
      ? reported.containerUri
      : null,
    artistLinks: [],
    // Sonos serves artwork from the speaker's own address on the home network.
    artworkUrl: httpsUrl(track.artworkUrl),
    durationMs: track.durationMs ?? 0,
    positionMs: reported.positionMs,
    paused: reported.state !== 'playing' && reported.state !== 'buffering',
    contextUri: reported.containerUri,
    hasNext: reported.hasNext,
    trackNumber: null,
    discNumber: null,
    at,
  }
}

/** A track the account plays that this app did not start, as an item to start elsewhere. */
function shownTrack(shown: PlaybackSnapshot): PlayableItem | null {
  if (!shown.trackUri) return null
  return {
    kind: 'track',
    uri: shown.trackUri,
    title: shown.trackName,
    artist: shown.artists,
    albumId: null,
    albumTitle: shown.albumName,
    artworkUrl: shown.artworkUrl,
    trackCount: 1,
  }
}

/** Resolves when the work settles or the wait is over, whichever is first. */
function briefly(pending: Promise<unknown>, wait: number) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, wait)
    const done = () => {
      clearTimeout(timeout)
      resolve()
    }
    pending.then(done, done)
  })
}

/**
 * Plays queue items on this browser or another Spotify device and follows the
 * device's playback. A track goes to Spotify together with the tracks due
 * after it, so they keep playing wherever the playback is moved, including
 * devices this app cannot start playback on. A Sonos group is played through
 * Sonos: the tracks go into the group's own queue. It can also show and
 * control playback the account started elsewhere.
 */
export function createPlaybackEngine(options: PlaybackEngineOptions) {
  const now = options.now ?? Date.now
  const visible = options.visible ?? (() => true)
  const random = options.random ?? Math.random
  const { api } = options
  const listeners = new Set<() => void>()
  const waiters = new Set<Waiter>()
  let preferredShuffle = options.initialShuffle ?? false
  let state: PlaybackState = {
    ...idlePlaybackState,
    shuffle: preferredShuffle,
    ...(options.initialRoom && options.sonos
      ? { target: { kind: 'room', room: options.initialRoom }, volume: null }
      : { volume: options.initialVolume }),
  }
  let player: SpotifySdkPlayer | null = null
  let loading: Promise<SpotifySdkPlayer> | null = null
  let connected = false
  let localId: string | null = null
  let localVolume = options.initialVolume
  let session: PlaybackSession | null = null
  let source: SourceSession | null = null
  let sourceStarting = false
  let currentFromSource = false
  let latest: PlaybackSnapshot | null = null
  let skippedAt: number | null = null
  /** The last track a device reported outside a start, and the item it was. */
  let heard: string | null = null
  let heardFor: string | null = null
  /** The start for which Spotify was asked which recording it plays. */
  let verifying = 0
  let sawLocalState = false
  let missing = 0
  /** When the device was first read and found quiet. */
  let quietAt: number | null = null
  let pollErrors = 0
  let run = 0
  // Spotify starts a new URI list to change what follows a Connect track.
  // Transport commands must not overtake that write, or an old list can win.
  let remoteCommand: Promise<void> | null = null
  let remoteCommandRevision = 0
  let pendingRemoteQueue: {
    active: PlaybackSession
    sent: PlayableItem[]
  } | null = null
  let remoteQueueEdited = false
  let remoteSourceUnavailable = false
  let rejectedRemoteTrack: PlayableItem | null = null
  let sequence = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let volumeTimer: ReturnType<typeof setTimeout> | null = null
  let rejoinTimer: ReturnType<typeof setTimeout> | null = null
  let ticking = false
  let disposed = false
  let watching = false
  /** Something was played or queued here, so the player stays once playback stops. */
  let used = false
  /** The target to return to when a device playback was followed to goes quiet. */
  let fallback: Exclude<SelectableTarget, RoomTarget> | null = null
  /** Until then Spotify may still report the device playback was moved from. */
  let settlesAt = 0
  let sonosPolling = true
  let followingSonos = false
  /** Invalidates work that started under an earlier Sonos lease. */
  let sonosLease = 0
  /** The restricted device and track last looked up as a Sonos group. */
  let sonosChecked: string | null = null
  let sonosTries = 0
  let sonosRetryAt = 0
  let lookingElsewhere = false
  /** A device left by choice that Spotify still reports playing. */
  let left: ObservedTarget | null = null
  /** Changes to a Sonos group's queue, sent one at a time in order. */
  let roomWork: Promise<unknown> = Promise.resolve()
  let roomBusy = 0
  /** Counts the queues started on a group, so late answers for an earlier one are ignored. */
  let roomRun = 0
  let roomPolls = 0
  let roomRetryAt = 0
  /** Sonos commands sent and not yet answered. */
  let sonosPending = 0
  /** Changes with each Sonos command sent or answered; a report read across one may predate it. */
  let sonosEpoch = 0
  /** The track a Sonos group was told to play, until it reports that track. */
  let roomExpected: { uri: string; until: number } | null = null
  /** Spotify's details of tracks a Sonos group plays; null once asked for. */
  const roomTracks = new Map<string, TrackDetails | null>()
  const describingRoomTracks = new Set<string>()
  /**
   * The item a session was on when nothing is playing it any more, and where
   * in it to start again. `given` is that session: its device may still hold
   * the tracks and play on through them, started again from another app.
   * `since` is when the device was last known to be on the item.
   */
  let resume: {
    item: PlayableItem
    positionMs: number
    given: PlaybackSession | null
    since: number
  } | null = null
  /**
   * The run of a restore still reading the device. A Sonos group's queue is
   * left alone until it is known to be the one the session gave it.
   */
  let rejoining: number | null = null
  /** Counts restores, so a device report read across one is dropped. */
  let restores = 0
  /** How much of the track a Sonos group is on has been heard, for scrobbling. */
  let listen: PlaybackListen | null = null
  let reportingListen: PlaybackListen | null = null
  /** Where the group was in its tracks when it was last read. */
  let sighted: Sighting | null = null

  /** A control used here answers the note about rejoining a saved session. */
  function acted() {
    if (state.rejoin && state.rejoin.status !== 'checking')
      set({ rejoin: null })
  }

  function set(patch: Partial<PlaybackState>, rememberRoom = true) {
    if (disposed) return
    const before = state.target
    state = { ...state, ...patch }
    if (patch.rejoin !== undefined) {
      if (rejoinTimer) clearTimeout(rejoinTimer)
      rejoinTimer =
        patch.rejoin?.status === 'rejoined'
          ? setTimeout(() => set({ rejoin: null }), REJOIN_NOTICE_MS)
          : null
    }
    if (rememberRoom && patch.target && !sameDevice(before, patch.target))
      options.onRoom?.(patch.target.kind === 'room' ? patch.target.room : null)
    for (const listener of listeners) listener()
  }

  function schedule(delay: number) {
    if (disposed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void tick()
    }, delay)
  }

  function stop() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  function holdsSonosLease(lease = sonosLease) {
    return sonosPolling && lease === sonosLease && !disposed
  }

  function canControl(target: PlaybackTarget) {
    return !isSonosTarget(target) || holdsSonosLease()
  }

  function detach() {
    session = null
    skippedAt = null
  }

  /** Counts a read that found the device quiet. */
  function missed() {
    if (missing === 0) quietAt = now()
    missing += 1
  }

  function fail(error: unknown) {
    const failure = playbackFailure(error)
    if (failure.status === 'expired') {
      detach()
      stop()
    }
    set({ failure, starting: session?.phase === 'starting' })
  }

  function guard(action: Promise<unknown> | undefined) {
    action?.catch(fail)
  }

  function rejectWaiters(error: Error) {
    for (const waiter of [...waiters]) waiter.reject(error)
  }

  function sdkFailed(kind: string) {
    const error = new SdkFailure(kind)
    if (kind !== 'playback_error') rejectWaiters(error)
    fail(error)
  }

  function loadPlayer(): Promise<SpotifySdkPlayer> {
    loading ??= options.loadSdk().then(
      (sdk) => {
        if (disposed) throw new SdkFailure('disposed')
        const created = new sdk.Player({
          name: options.playerName,
          getOAuthToken: (callback) => {
            options.token().then(callback, fail)
          },
          volume: localVolume,
          enableMediaSession: true,
        })
        created.addListener('ready', (payload) => {
          const id = sdkDeviceId(payload)
          if (!id) return
          localId = id
          for (const waiter of [...waiters]) waiter.resolve(id)
        })
        created.addListener('not_ready', () => {
          localId = null
        })
        created.addListener('player_state_changed', (payload) => {
          if (state.target.kind !== 'local' || observeLocal(payload)) return
          // This browser went quiet: the playback may have been moved.
          if (sawLocalState) void lookElsewhere()
        })
        created.addListener('autoplay_failed', () =>
          set({
            failure: {
              status: 'error',
              message: 'The browser blocked playback. Press play to start.',
            },
          }),
        )
        for (const kind of sdkErrorEvents)
          created.addListener(kind, () => sdkFailed(kind))
        player = created
        return created
      },
      () => {
        loading = null
        throw new SdkFailure('load')
      },
    )
    return loading
  }

  /** Registers this browser as a Spotify device and resolves its device ID. */
  async function ensureLocal(): Promise<string> {
    if (localId) return localId
    const created = await loadPlayer()
    if (localId) return localId
    const ready = new Promise<string>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: (id) => {
          clearTimeout(timeout)
          waiters.delete(waiter)
          resolve(id)
        },
        reject: (error) => {
          clearTimeout(timeout)
          waiters.delete(waiter)
          reject(error)
        },
      }
      const timeout = setTimeout(
        () => waiter.reject(new SdkFailure('timeout')),
        READY_TIMEOUT_MS,
      )
      waiters.add(waiter)
    })
    if (!connected) {
      connected = true
      created.connect().then(
        (accepted) => {
          if (accepted) return
          connected = false
          rejectWaiters(new SdkFailure('connect'))
        },
        () => {
          connected = false
          rejectWaiters(new SdkFailure('connect'))
        },
      )
    }
    return ready
  }

  /**
   * Browsers only allow audio that a user gesture unlocked. `target` is the
   * device about to play, when it is not the current one yet.
   */
  function activate(target: PlaybackTarget = state.target) {
    if (target.kind === 'local')
      player?.activateElement().catch(() => undefined)
  }

  /**
   * Spotify can take a few seconds to list a device that has just registered,
   * as a browser does the first time it is chosen under Play on.
   */
  async function onDevice(local: boolean, command: () => Promise<void>) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await command()
        return
      } catch (error) {
        const retry =
          local &&
          attempt < DEVICE_RETRIES &&
          error instanceof PlaybackApiError &&
          error.status === 404
        if (!retry) throw error
        await new Promise((resolve) => setTimeout(resolve, DEVICE_RETRY_MS))
      }
    }
  }

  /**
   * The Sonos group behind a restricted device, when Sonos can start Spotify
   * content on it.
   */
  function roomBehind(target: PlaybackTarget): RoomTarget | null {
    if (target.kind !== 'sonos' || !target.group.playable || !options.sonos)
      return null
    const { id, name, household } = target.group
    return { kind: 'room', room: { id, name, household } }
  }

  /** Whether new playback can be started on the target. */
  function startable(target: PlaybackTarget) {
    return !isObserved(target) || roomBehind(target) !== null
  }

  /**
   * Spotify accepts no start of playback on these devices, and starting it
   * elsewhere would take the music off them, so the request is refused unless
   * Sonos can start it there.
   */
  function refused(): boolean {
    const target = state.target
    if (!canControl(target)) return true
    if (!isObserved(target) || roomBehind(target)) return false
    set({
      starting: false,
      failure: {
        status: 'error',
        message: `Spotify does not let this app start playback on ${target.name}. Start it from the Spotify app, or choose another device under Play on.`,
      },
    })
    return true
  }

  /** A Spotify track list ends at an album. Recovery can look beyond it. */
  function planned(includeAfterAlbum = false): Planned[] {
    const tracks: Planned[] = []
    for (const entry of state.queue) {
      if (!includeAfterAlbum && entry.item.kind !== 'track') return tracks
      tracks.push({ from: 'queue', item: entry.item, entry })
    }
    for (const entry of source?.upcoming ?? []) {
      if (!includeAfterAlbum && entry.item.kind !== 'track') break
      tracks.push({ from: 'source', item: entry.item, entry })
    }
    return tracks
  }

  /** The tracks sent to Spotify after a track; a repeated track gets its own start. */
  function followingFor(item: PlayableItem): PlayableItem[] {
    if (item.kind !== 'track') return []
    const sent = new Set([item.uri])
    const following: PlayableItem[] = []
    for (const next of planned().slice(0, FOLLOWING_LIMIT)) {
      if (sent.has(next.item.uri)) break
      sent.add(next.item.uri)
      following.push(next.item)
    }
    return following
  }

  function clearSource() {
    source = null
    sourceStarting = false
    currentFromSource = false
    set({
      source: null,
      upcoming: [],
      sourceLoading: false,
      shuffle: preferredShuffle,
    })
  }

  function loadSourceEntry(active: SourceSession, index: number) {
    const cached = active.tracks.get(index)
    if (cached) {
      active.tracks.delete(index)
      active.tracks.set(index, cached)
      return cached
    }
    const scattered =
      state.shuffle && active.definition.length !== undefined
        ? active.definition.loadScattered
        : undefined
    return rememberSourceEntry(
      active,
      index,
      scattered
        ? scattered([index]).then(([tracks]) => tracks ?? [])
        : active.definition.load(index),
    )
  }

  function rememberSourceEntry(
    active: SourceSession,
    index: number,
    load: Promise<PlayableItem[]>,
  ) {
    const loading: Promise<PlayableItem[]> = load.catch((error: unknown) => {
      if (active.tracks.get(index) === loading) active.tracks.delete(index)
      throw error
    })
    active.tracks.set(index, loading)
    while (active.tracks.size > SOURCE_CACHE_SIZE) {
      const oldest = active.tracks.keys().next().value
      if (oldest === undefined) break
      active.tracks.delete(oldest)
    }
    return loading
  }

  /** Reads entries spread over a shuffled source in one request. */
  function loadSourceEntries(
    active: SourceSession,
    scattered: NonNullable<PlaybackSource['loadScattered']>,
    indexes: number[],
  ) {
    const missing = [...new Set(indexes)].filter(
      (index) => !active.tracks.has(index),
    )
    if (!missing.length) return
    const batch = scattered(missing)
    missing.forEach((index, at) => {
      rememberSourceEntry(
        active,
        index,
        batch.then((entries) => entries[at] ?? []),
      ).catch(() => undefined)
    })
  }

  /** Builds only the small preview; source pages are retained by their loader. */
  function fillSource(active: SourceSession): Promise<void> {
    if (active.filling) return active.filling
    const revision = active.revision
    const shuffled = state.shuffle && active.definition.length !== undefined
    const scattered = shuffled ? active.definition.loadScattered : undefined
    const upcoming = [...active.upcoming]
    let shown = upcoming.length
    /** Shows the tracks resolved so far and passes them on to a Sonos group. */
    const show = () => {
      if (source !== active || revision !== active.revision || disposed) return
      active.upcoming = [...upcoming]
      set({ upcoming: upcomingEntries(upcoming) })
      shown = upcoming.length
      maintainRoom()
    }
    set({ sourceLoading: true })
    const filling = (async () => {
      const used = new Set([...active.played, ...active.skipped])
      for (const entry of upcoming)
        used.add(sourceTrackKey(entry.index, entry.position))
      let candidates = [...active.remaining]
      while (upcoming.length < SOURCE_AHEAD_SIZE) {
        if (candidates.length === 0) {
          const ordered = active.ordered
          if (!ordered || ordered.terminal !== undefined) break
          const from = ordered.nextIndex
          if (shown !== upcoming.length) show()
          const { end, hasMore } = await ordered.readPageEnd(from)
          if (source !== active || revision !== active.revision || disposed)
            return
          candidates = Array.from(
            { length: Math.max(0, end - from) },
            (_, offset) => from + offset,
          )
          active.remaining.push(...candidates)
          if (hasMore && end > from) ordered.nextIndex = end
          else if (
            !hasMore &&
            end >= from &&
            end > active.definition.startIndex
          )
            ordered.terminal = end
          else active.ordered = undefined
          if (candidates.length === 0) break
        }
        const pick = (draw: number) =>
          candidates[shuffled ? Math.floor(draw * candidates.length) : 0]
        if (scattered && !active.draws.length) {
          // Every track still wanted is drawn at once, each from a different
          // entry, and the round is read in one request.
          const pool = [...candidates]
          const wanted = SOURCE_AHEAD_SIZE - upcoming.length
          while (active.draws.length < wanted && pool.length) {
            const [index] = pool.splice(Math.floor(random() * pool.length), 1)
            active.draws.push({ entry: 0, track: random(), index })
          }
          loadSourceEntries(
            active,
            scattered,
            active.draws.flatMap(({ index }) =>
              index === undefined ? [] : [index],
            ),
          )
        } else if (!scattered) {
          // Shuffled entries are spread over the source, so the next few are
          // loaded together instead of one request after another.
          while (shuffled && active.draws.length < SOURCE_PARALLEL)
            active.draws.push({ entry: random(), track: random() })
          for (const draw of active.draws) {
            const ahead = pick(draw.entry)
            if (ahead !== undefined)
              loadSourceEntry(active, ahead).catch(() => undefined)
          }
        }
        const draw = active.draws.shift()
        const index =
          (shuffled ? draw?.index : undefined) ?? pick(draw?.entry ?? 0)
        if (index === undefined) break
        // An entry drawn earlier may have been used up since.
        if (!candidates.includes(index)) continue
        // Tracks already resolved are shown when the next one has to be
        // waited for; an entry that is already loaded answers first.
        const early =
          shown === upcoming.length ? undefined : setTimeout(show, 0)
        const tracks = await loadSourceEntry(active, index).finally(() =>
          clearTimeout(early),
        )
        if (source !== active || revision !== active.revision || disposed) {
          // The draw is kept for the fill that replaced this one.
          if (draw && source === active) active.draws.unshift(draw)
          return
        }
        const available = tracks
          .map((item, position) => ({ index, position, item }))
          .filter((entry) => !used.has(sourceTrackKey(index, entry.position)))
        const entry =
          available[
            shuffled ? Math.floor((draw?.track ?? 0) * available.length) : 0
          ]
        if (!entry) {
          candidates = candidates.filter((candidate) => candidate !== index)
          if (
            tracks.every((_, position) => {
              const key = sourceTrackKey(index, position)
              return active.played.has(key) || active.skipped.has(key)
            })
          ) {
            if (
              tracks.every((_, position) =>
                active.played.has(sourceTrackKey(index, position)),
              )
            )
              active.exhausted.add(index)
            active.remaining = active.remaining.filter(
              (candidate) => candidate !== index,
            )
          }
          continue
        }
        upcoming.push(entry)
        used.add(sourceTrackKey(index, entry.position))
        // A start made meanwhile sends the tracks resolved so far.
        active.upcoming = [...upcoming]
      }
      show()
    })()
      .catch((error: unknown) => {
        if (source === active && revision === active.revision && !disposed) {
          // A failed later page must not hold back tracks already resolved.
          show()
          throw error
        }
      })
      .finally(() => {
        if (source === active && revision === active.revision) {
          active.filling = null
          set({ sourceLoading: false })
          const ordered = active.ordered
          if (ordered?.terminal !== undefined)
            ordered.complete(ordered.terminal)
        }
      })
    active.filling = filling
    return filling
  }

  function previewSource(active: SourceSession) {
    void fillSource(active).catch((error: unknown) => {
      if (source === active) fail(error)
    })
  }

  /** Marks a source track as the one playing and resolves the tracks after it. */
  function takeSource(active: SourceSession, entry: SourceTrack) {
    active.upcoming = active.upcoming.filter((next) => next !== entry)
    active.played.add(sourceTrackKey(entry.index, entry.position))
    active.history.push(entry)
    active.revision += 1
    active.filling = null
    sourceStarting = false
    currentFromSource = true
    set({ upcoming: upcomingEntries(active.upcoming) })
    previewSource(active)
  }

  /** The source track shown under a key, with the source it is in. */
  function upcomingTrack(key: string) {
    const active = source
    const entry = active?.upcoming.find(
      (next) => sourceTrackKey(next.index, next.position) === key,
    )
    return active && entry ? { active, entry } : null
  }

  /**
   * The upcoming tracks were changed by hand. A fill under way worked from
   * the earlier list, so it is replaced by one that continues from this one.
   */
  function rearrangeSource(
    active: SourceSession,
    upcoming: SourceTrack[],
    patch: Partial<PlaybackState>,
  ) {
    active.upcoming = upcoming
    active.revision += 1
    active.filling = null
    set({ ...patch, upcoming: upcomingEntries(upcoming) })
    previewSource(active)
    refreshDeviceQueue()
  }

  /** Takes a track out of the source for good: it is not drawn or read again. */
  function withdrawSource(active: SourceSession, entry: SourceTrack) {
    active.played.add(sourceTrackKey(entry.index, entry.position))
    return active.upcoming.filter((next) => next !== entry)
  }

  function consumeSource(active: SourceSession, entry: SourceTrack) {
    takeSource(active, entry)
    const ahead =
      active.upcoming.length === 0 && active.filling
        ? briefly(active.filling, FOLLOWING_WAIT_MS)
        : undefined
    void start(entry.item, ahead)
  }

  function startSourceNext(): boolean {
    const active = source
    if (
      !active ||
      (!active.ordered && !active.remaining.length && !active.upcoming.length)
    )
      return false
    const next = active.upcoming.shift()
    if (next) {
      consumeSource(active, next)
      return true
    }
    if (sourceStarting) return true
    sourceStarting = true
    run += 1
    const requested = run
    detach()
    set({ starting: true })
    const prepare = async () => {
      while (source === active && !disposed) {
        const revision = active.revision
        await fillSource(active)
        if (revision === active.revision) return
      }
    }
    void prepare().then(
      () => {
        if (source !== active || requested !== run || disposed) return
        sourceStarting = false
        if (state.queue.length && startNext()) return
        const entry = active.upcoming.shift()
        if (entry) consumeSource(active, entry)
        else set({ current: null, starting: false })
      },
      (error: unknown) => {
        if (source !== active || requested !== run || disposed) return
        sourceStarting = false
        if (state.queue.length || active.upcoming.length) startNext()
        fail(error)
      },
    )
    return true
  }

  function createSource(
    definition: SourceSession['definition'],
  ): SourceSession {
    return {
      definition: { ...definition },
      tracks: new Map(),
      remaining: Array.from(
        {
          length: Math.max(0, (definition.length ?? 0) - definition.startIndex),
        },
        (_, offset) => definition.startIndex + offset,
      ),
      played: new Set(),
      skipped: new Set(),
      exhausted: new Set(),
      upcoming: [],
      history: [],
      initializing: true,
      revision: 0,
      filling: null,
      draws: [],
    }
  }

  async function startSource(item: PlayableItem, definition: PlaybackSource) {
    const active = createSource(definition)
    const captured = active.definition
    source = active
    sourceStarting = true
    currentFromSource = true
    run += 1
    const requested = run
    detach()
    latest = null
    used = true
    set({
      active: true,
      current: item,
      snapshot: null,
      starting: true,
      failure: null,
      shuffle: definition.kind === 'album' ? false : preferredShuffle,
      source: { label: definition.label, href: definition.href },
      upcoming: [],
      sourceLoading: true,
    })
    try {
      const tracks = await loadSourceEntry(active, captured.startIndex)
      if (source !== active || disposed) return
      const position = Math.max(
        0,
        item.startUri
          ? tracks.findIndex((entry) => entry.uri === item.startUri)
          : 0,
      )
      if (!state.shuffle)
        for (let before = 0; before < position; before += 1)
          active.skipped.add(sourceTrackKey(captured.startIndex, before))
      sourceStarting = false
      active.initializing = false
      if (state.shuffle)
        active.remaining = Array.from(
          { length: definition.length },
          (_, index) => index,
        )
      const first = tracks[position]
      if (first) {
        const entry = {
          index: captured.startIndex,
          position,
          item:
            first.kind === 'album' && item.startUri
              ? { ...first, startUri: item.startUri }
              : first,
        }
        if (requested === run) consumeSource(active, entry)
        else {
          active.upcoming = [entry]
          previewSource(active)
        }
      } else {
        active.remaining = active.remaining.filter(
          (index) => index !== captured.startIndex,
        )
        if (requested !== run) previewSource(active)
        else if (!startSourceNext())
          set({ current: null, starting: false, sourceLoading: false })
      }
    } catch (error) {
      if (source !== active || requested !== run || disposed) return
      sourceStarting = false
      set({ sourceLoading: false })
      fail(error)
    }
  }

  function startPendingSource(
    item: PlayableItem,
    pending: PendingPlaybackSource,
  ) {
    clearSource()
    const { resolve, readPageEnd, withLength, ...definition } = pending
    const active = createSource({ ...definition, length: undefined })
    active.initializing = false
    function complete(resolved: PlaybackSource) {
      if (
        source !== active ||
        disposed ||
        active.definition.length !== undefined
      )
        return
      active.definition = resolved
      active.ordered = undefined
      active.revision += 1
      active.filling = null
      if (state.shuffle) active.upcoming = []
      active.remaining = Array.from(
        { length: resolved.length - (state.shuffle ? 0 : resolved.startIndex) },
        (_, index) => (state.shuffle ? index : resolved.startIndex + index),
      ).filter((index) => !active.exhausted.has(index))
      set({ upcoming: upcomingEntries(active.upcoming) })
      previewSource(active)
      refreshDeviceQueue()
    }
    active.ordered = {
      nextIndex: definition.startIndex,
      readPageEnd,
      complete: (end) => complete(withLength(end)),
    }
    const entry = { index: definition.startIndex, position: 0, item }
    rememberSourceEntry(active, entry.index, Promise.resolve([item]))
    source = active
    set({ source: { label: definition.label, href: definition.href } })
    takeSource(active, entry)
    void start(item)
    void resolve().then(complete, () => undefined)
  }

  /**
   * Sends one change to a Sonos group's queue. The changes reach the group
   * one at a time, in the order they were made.
   */
  function roomSend(
    room: SonosRoomRef,
    input: Omit<SonosContentInput, 'household'>,
  ): Promise<void> {
    const sonos = options.sonos
    if (!sonos) return Promise.reject(new Error('Sonos is not connected'))
    const lease = sonosLease
    roomBusy += 1
    const sent = roomWork.then(() => {
      if (holdsSonosLease(lease))
        return sonos.load(room.id, { ...input, household: room.household })
    })
    const done = () => {
      roomBusy -= 1
    }
    roomWork = sent.then(done, done)
    return sent
  }

  /**
   * Keeps a Sonos group's queue in step with the tracks due next, so the
   * group plays on by itself. Tracks are added to the end while the queue
   * still agrees with the plan; once the plan has changed, the track now due
   * is placed directly after the current one.
   */
  function maintainRoom() {
    const target = state.target
    const active = session
    if (
      !holdsSonosLease() ||
      target.kind !== 'room' ||
      !active ||
      active.item.kind !== 'track' ||
      roomBusy > 0 ||
      now() < roomRetryAt ||
      rejoining === run
    )
      return
    const plan = planned().map((next) => next.item)
    const tail = active.sent.slice(active.index + 1)
    const head = plan[0]
    const agrees = tail.every((item, at) => plan[at]?.uri === item.uri)
    let mode: 'append' | 'next' = 'append'
    const added: PlayableItem[] = []
    if (agrees) {
      const following = plan[tail.length]
      const queued = active.sent
        .slice(active.index)
        .some((item) => item.uri === following?.uri)
      if (following && !queued && tail.length < ROOM_AHEAD)
        added.push(following)
    } else if (head && tail[0]?.uri !== head.uri) {
      mode = 'next'
      added.push(head)
    }
    if (!added.length) return
    const generation = roomRun
    const sent = [...active.sent]
    if (mode === 'append') sent.push(...added)
    else sent.splice(active.index + 1, 0, ...added)
    // The queue is recorded before Sonos confirms, so a group that moves on
    // meanwhile is still followed.
    session = { ...active, sent }
    roomSend(target.room, {
      mode,
      uris: added.map((item) => item.uri),
      play: latest ? !latest.paused : true,
    }).then(
      () => {
        if (generation === roomRun) maintainRoom()
      },
      (error: unknown) => {
        if (generation !== roomRun || disposed) return
        roomRetryAt = now() + ROOM_RETRY_MS
        if (session)
          session = {
            ...session,
            sent: session.sent.filter((item) => !added.includes(item)),
          }
        fail(error)
      },
    )
  }

  function sendRemote(command: () => Promise<void>) {
    remoteCommandRevision += 1
    const sent = remoteCommand ? remoteCommand.then(command) : command()
    const done = () => {
      if (remoteCommand === finished) remoteCommand = null
    }
    const finished = sent.then(done, done)
    remoteCommand = finished
    return sent
  }

  /** Read the device promptly after an edit, coalescing changes made together. */
  function refreshDeviceQueue() {
    if (state.target.kind === 'remote' && session) {
      remoteQueueEdited = true
      rejectedRemoteTrack = null
      schedule(REMOTE_QUEUE_DEBOUNCE_MS)
    } else if (
      holdsSonosLease() &&
      state.target.kind === 'room' &&
      session &&
      latest
    )
      schedule(FOLLOW_UP_MS)
  }

  /**
   * Give Connect the edited order while it still plays the current track.
   * A normal source refill can wait until the device reaches its last sent
   * track. An explicit edit also sends additions to the end of the list.
   */
  function updateRemoteQueue(
    deviceId: string,
    snapshot: PlaybackSnapshot,
    resuming = false,
  ): Promise<void> | null {
    const active = session
    if (
      !active ||
      active.phase !== 'playing' ||
      active.item.kind !== 'track' ||
      remoteSourceUnavailable ||
      rejectedRemoteTrack === active.item ||
      remoteCommand ||
      snapshot.trackUri !== active.anchorUri ||
      !snapshot.trackUri ||
      snapshot.contextUri?.startsWith('spotify:playlist:') ||
      (snapshot.paused && !resuming) ||
      rejoining !== null ||
      (source?.filling && !source.upcoming.length && !state.queue.length)
    )
      return null
    const following = followingFor(active.item)
    const tail = active.sent.slice(active.index + 1)
    const extend =
      remoteQueueEdited || !tail.length || state.queue.length > tail.length
    remoteQueueEdited = false
    if (
      tail.every((item, at) => following[at]?.uri === item.uri) &&
      (!extend || tail.length === following.length)
    )
      return null
    const position = positionAt(snapshot, now())
    // A report at the very end can already describe the previous track.
    if (
      !resuming &&
      snapshot.durationMs > 0 &&
      position >= snapshot.durationMs - FOLLOW_UP_MS
    )
      return null
    const current = () =>
      !disposed &&
      session === active &&
      state.target.kind === 'remote' &&
      state.target.device.id === deviceId
    const pending = { active, sent: [active.item, ...following] }
    pendingRemoteQueue = pending
    // Let the shared session save both possibilities while the write is in flight.
    set({})
    return sendRemote(() =>
      api.play(deviceId, playRequest(active.item, following, position)),
    )
      .then(
        () => {
          if (!current()) return
          session = { ...active, sent: pending.sent, index: 0 }
          // A save (including the page-close save) now describes the list the
          // device actually accepted, even if no visible field changed.
          set({ failure: null })
        },
        (error: unknown) => {
          if (!current()) return
          if (!remoteQueueEdited) rejectedRemoteTrack = active.item
          if (resuming) expect({ paused: true })
          fail(error)
        },
      )
      .finally(() => {
        if (pendingRemoteQueue !== pending) return
        pendingRemoteQueue = null
        if (remoteQueueEdited && !disposed) schedule(0)
      })
  }

  /**
   * Starts an item; `ahead` is a short wait for the tracks that follow it and
   * `from` is where in its first track to start.
   */
  async function start(item: PlayableItem, ahead?: Promise<void>, from = 0) {
    let target = state.target
    if (!canControl(target)) return
    const lease = sonosLease
    if (isObserved(target)) {
      const room = roomBehind(target)
      if (!room) {
        refused()
        return
      }
      // Sonos takes over the group from the Spotify session it was playing.
      fallback = null
      set({ target: room, volume: targetVolume(target), findingSonos: false })
      target = room
    }
    run += 1
    const started = run
    remoteQueueEdited = false
    remoteSourceUnavailable = false
    rejectedRemoteTrack = null
    resume = null
    listen = null
    sighted = null
    // Starting the item the device is already on plays that same track.
    const replaced = heard !== item.uri && heardFor !== item.uri ? heard : null
    session = startSession(item, now(), replaced)
    used = true
    latest = null
    skippedAt = null
    sawLocalState = false
    missing = 0
    left = null
    set({
      active: true,
      current: item,
      snapshot: null,
      starting: true,
      failure: null,
      rejoin: null,
    })
    try {
      if (target.kind === 'room') {
        roomRun += 1
        roomRetryAt = 0
        roomExpected = null
        if (item.kind === 'track') describeRoomTrack(item.uri)
        const skip =
          item.kind === 'album' && item.startUri
            ? await api.albumTrackIndex(item.uri, item.startUri)
            : 0
        if (started !== run || !holdsSonosLease(lease)) return
        await roomSend(target.room, {
          mode: 'replace',
          uris: [item.uri],
          play: true,
          ...(skip > 0 ? { skip } : {}),
          ...(from > 0 ? { positionMs: Math.round(from) } : {}),
        })
        if (started !== run || !holdsSonosLease(lease)) return
        // Sonos has accepted the track; its own report follows a second later.
        if (item.kind === 'track') expectRoomTrack(item, from, false)
        // The tracks that follow may still be resolving; they are added as
        // they become known.
        maintainRoom()
        schedule(FOLLOW_UP_MS)
        return
      }
      const [deviceId] = await Promise.all([
        target.kind === 'local' ? ensureLocal() : target.device.id,
        ahead,
      ])
      if (started !== run || disposed) return
      const following = followingFor(item)
      if (session) session = { ...session, sent: [item, ...following] }
      const play = async () => {
        if (started === run && !disposed)
          await api.play(deviceId, playRequest(item, following, from))
      }
      if (target.kind === 'remote') await sendRemote(play)
      else await onDevice(true, play)
      if (started !== run) return
      schedule(FOLLOW_UP_MS)
    } catch (error) {
      if (
        started !== run ||
        (target.kind === 'room' && !holdsSonosLease(lease))
      )
        return
      detach()
      fail(error)
    }
  }

  function startNext(): boolean {
    const [next, ...rest] = state.queue
    if (!next) return startSourceNext()
    sourceStarting = false
    currentFromSource = false
    set({ queue: rest })
    void start(next.item)
    return true
  }

  /** A device this app cannot start playback on plays only what it was sent. */
  function continueQueue(): boolean {
    return startable(state.target) && startNext()
  }

  function take(next: Planned) {
    if (next.from === 'queue')
      set({ queue: state.queue.filter((entry) => entry !== next.entry) })
    else if (source) takeSource(source, next.entry)
  }

  /**
   * Counts the tracks a device was given as played, up to and including the
   * one at `to`, and returns how that one was planned. Only tracks the
   * device was given count: one queued after they were sent is still due.
   */
  function pass(
    active: PlaybackSession,
    to: number,
    alsoReached?: ReadonlySet<string>,
  ): Planned | null {
    const reached = new Set(
      active.sent.slice(active.index + 1, to + 1).map((sent) => sent.uri),
    )
    const last = active.sent[to]
    let found: Planned | null = null
    for (const next of planned(true)) {
      if (alsoReached && !alsoReached.has(next.item.uri)) continue
      if (!reached.delete(next.item.uri)) continue
      take(next)
      if (next.item.uri === last?.uri) found = next
    }
    return found
  }

  /**
   * The device moved to another of the tracks sent with the current one, by
   * itself or through a skip made on it. The queue follows the device, except
   * that a device this app can start gets the track now due when it moved to
   * a track the queue no longer has next.
   */
  function advanced(
    after: PlaybackSnapshot,
    event: SessionEvent,
  ): 'followed' | 'restarted' | null {
    const active = session
    if (!active || active.item.kind !== 'track' || !after.trackUri) return null
    let index = givenIndex(active.sent, active.index + 1, after)
    // Spotify may play another recording of the track that was due.
    if (
      index < 0 &&
      event === 'finished' &&
      !after.paused &&
      after.positionMs <= SUCCESSOR_WITHIN_MS &&
      active.index + 1 < active.sent.length
    )
      index = active.index + 1
    // A finished list returns to its first track, which is not a step back.
    if (index < 0 && event === 'left')
      index = givenIndex(active.sent.slice(0, active.index), 0, after)
    const item = active.sent[index]
    if (!item) return null
    const plan = planned()
    const at = plan.findIndex((next) => next.item.uri === item.uri)
    const due = plan[at]
    // The planned tracks before it are ones the device has already passed.
    const passed = new Set(
      active.sent.slice(active.index + 1, index).map((sent) => sent.uri),
    )
    const inStep =
      at >= 0 && plan.slice(0, at).every((next) => passed.has(next.item.uri))
    if (startable(state.target) && index > active.index && !inStep) {
      if (startNext()) return 'restarted'
      const target = state.target
      if (target.kind === 'room' && at < 0) {
        // Nothing is due, and the group moved on to a track that was taken
        // off the queue after it had been added to the group.
        sonosSend(target.room.id, { action: 'pause' })
        detach()
        set({ current: null })
        return 'restarted'
      }
    }
    for (const passed of plan.slice(0, at + 1)) take(passed)
    if (due) currentFromSource = due.from === 'source'
    session = { ...active, item, index, anchorUri: after.trackUri }
    skippedAt = null
    set({ current: item })
    return 'followed'
  }

  function publish(after: PlaybackSnapshot) {
    // Until the requested item starts, the device still reports what it was
    // playing before.
    if (session?.phase === 'starting' || sourceStarting) return
    if (sameShown(state.snapshot, after) && !state.starting) return
    set({ active: true, snapshot: after, starting: false })
  }

  /** The Spotify device a start is sent to; a Sonos room is not one. */
  function startDevice() {
    const target = state.target
    return target.kind === 'local'
      ? localId
      : target.kind === 'remote'
        ? target.device.id
        : null
  }

  /**
   * Asks Spotify which recording it plays for the track being started, to
   * tell that recording from other music beginning on a device this page has
   * not heard play. A track of the same name is taken for the recording.
   */
  function verifyStart(active: PlaybackSession, began: PlaybackSnapshot) {
    if (verifying === run) return
    verifying = run
    const started = run
    api
      .recording(active.item.uri)
      .then(
        (recording) =>
          recording && sameName(recording.name, began.trackName)
            ? began.trackUri
            : (recording?.uri ?? null),
        // Spotify could not say, so the track that began is taken for it.
        () => null,
      )
      .then((playsAs) => {
        if (started !== run || disposed || session?.phase !== 'starting') return
        session = { ...session, playsAs }
        if (latest) observe(latest)
      })
  }

  function observe(after: PlaybackSnapshot) {
    const before = latest
    if (
      session?.phase === 'playing' &&
      before &&
      after.at - before.at > WATCHED_MS
    ) {
      recheck(after)
      return
    }
    latest = after
    if (session && startDevice() && startUnverified(session, after)) {
      // The item is not shown as playing until Spotify has answered.
      verifyStart(session, after)
      return
    }
    if (session && startIgnored(session, after)) {
      // Spotify can accept a start and then play what the device already
      // had, from its beginning. That is reported and the music left as it
      // is: a start is only ever sent when it is asked for.
      detach()
      set({ current: null, failure: NOT_STARTED })
    }
    if (after.trackUri && session?.phase !== 'starting') {
      heard = after.trackUri
      heardFor = session?.sent[session.index]?.uri ?? null
    }
    if (resume && !session && !after.paused) {
      if (rejoinKept(after)) return
      // Something else plays now, so the kept item is no longer current.
      resume = null
      set({ current: null })
    }
    if (session) {
      const active = session
      const starting = active.phase === 'starting'
      const step = stepSession(active, before, after, skippedAt)
      session = step.session
      const moved =
        step.event === 'none' || starting ? null : advanced(after, step.event)
      if (moved === 'restarted') return
      if (moved === 'followed') {
        publish(after)
        findSonos()
        return
      }
      if (
        step.event === 'finished' &&
        queueContinues(active, before, after) &&
        continueQueue()
      )
        return
      if (step.event !== 'none') {
        // The item ended with nothing queued, or other playback replaced it.
        detach()
        if (step.event === 'left' && !starting) clearSource()
        set({
          current: null,
          failure: starting ? NOT_STARTED : state.failure,
        })
      }
    }
    publish(after)
    findSonos()
  }

  /**
   * Looks up the Sonos group behind a restricted device, once per device and
   * track, so its controls work through the Sonos connection.
   */
  function findSonos() {
    const sonos = options.sonos
    const target = state.target
    const track = latest?.trackUri
    if (!sonos || !holdsSonosLease() || !isObserved(target)) {
      sonosTries = 0
      if (state.findingSonos) set({ findingSonos: false })
      return
    }
    if (!track) return
    const key = `${target.name}\n${target.type}\n${track}`
    if (key === sonosChecked || now() < sonosRetryAt) return
    const lease = sonosLease
    sonosChecked = key
    if (target.kind === 'restricted') set({ findingSonos: true })
    /** Sonos can take a moment to report playback that has just moved to it. */
    const again = () => {
      if (sonosChecked !== key) return
      sonosTries += 1
      if (sonosTries >= SONOS_TRIES) return
      sonosChecked = null
      sonosRetryAt = now() + SONOS_RETRY_MS
    }
    sonos.find(track, target.name).then(
      (group) => {
        const current = state.target
        if (
          !holdsSonosLease(lease) ||
          sonosChecked !== key ||
          !sameDevice(current, target) ||
          !isObserved(current)
        )
          return
        const { name, type } = current
        if (group) {
          sonosTries = 0
          set({
            target: { kind: 'sonos', name, type, group },
            volume: volumeTimer ? state.volume : group.volume,
            findingSonos: false,
          })
          return
        }
        again()
        set({
          findingSonos: sonosChecked === null,
          ...(current.kind === 'sonos'
            ? { target: { kind: 'restricted', name, type }, volume: null }
            : {}),
        })
      },
      // A failed lookup leaves the device shown only; the next track tries again.
      () => {
        if (holdsSonosLease(lease) && sonosChecked === key)
          set({ findingSonos: false })
      },
    )
  }

  function groupId(target: SonosTarget) {
    return target.kind === 'room' ? target.room.id : target.group.id
  }

  /**
   * Sends a command to a Sonos group, after `after` when given. The group is
   * read again once Sonos has answered, not before: a report from before the
   * answer would undo what the command is expected to change.
   */
  function sonosCommand(
    groupId: string,
    command: SonosCommand,
    after?: Promise<unknown>,
  ): Promise<void> {
    const sonos = options.sonos
    if (!sonos || !holdsSonosLease()) return Promise.resolve()
    const lease = sonosLease
    sonosPending += 1
    sonosEpoch += 1
    const send = () => {
      if (holdsSonosLease(lease)) return sonos.command(groupId, command)
      return Promise.resolve()
    }
    const sent = after ? after.then(send) : send()
    const answered = () => {
      if (!holdsSonosLease(lease)) return
      sonosPending -= 1
      sonosEpoch += 1
      if (sonosPending === 0 && state.target.kind === 'room') schedule(0)
    }
    sent.then(answered, answered)
    return sent
  }

  function sonosSend(
    groupId: string,
    command: SonosCommand,
    after?: Promise<unknown>,
  ) {
    const lease = sonosLease
    sonosCommand(groupId, command, after).catch((error: unknown) => {
      if (!holdsSonosLease(lease)) return
      // The group may have changed; look it up again with the next report.
      sonosChecked = null
      roomExpected = null
      fail(error)
    })
  }

  /**
   * Shows the track a Sonos group was told to play before the group reports
   * it, which takes a second or more.
   */
  function expectRoomTrack(
    item: PlayableItem,
    positionMs: number,
    paused: boolean,
  ) {
    const at = now()
    roomExpected = { uri: item.uri, until: at + ROOM_EXPECT_MS }
    observe(
      roomTrack({
        trackUri: item.uri,
        linkedFromUri: null,
        trackName: '',
        artists: '',
        albumName: '',
        albumUri: null,
        artistLinks: [],
        artworkUrl: null,
        durationMs: 0,
        positionMs,
        paused,
        contextUri: null,
        hasNext: null,
        trackNumber: null,
        discNumber: null,
        at,
      }),
    )
  }

  /** Reads Spotify's details of a track a Sonos group plays, once. */
  function describeRoomTrack(uri: string) {
    if (
      !holdsSonosLease() ||
      roomTracks.has(uri) ||
      describingRoomTracks.has(uri)
    )
      return
    const lease = sonosLease
    describingRoomTracks.add(uri)
    api.track(uri).then(
      (details) => {
        if (!holdsSonosLease(lease)) return
        describingRoomTracks.delete(uri)
        roomTracks.set(uri, details)
        if (state.target.kind !== 'room' || latest?.trackUri !== uri) return
        latest = roomTrack(latest)
        publish(latest)
      },
      // The track stays as Sonos and the queue describe it.
      () => {
        if (!holdsSonosLease(lease)) return
        describingRoomTracks.delete(uri)
        roomTracks.set(uri, null)
      },
    )
  }

  /**
   * Sonos reports only the URI of a track it loaded by ID. Its name, artists,
   * artwork and length come from Spotify, and until that answers, from the
   * item this app queued.
   */
  function roomTrack(snapshot: PlaybackSnapshot): PlaybackSnapshot {
    const uri = snapshot.trackUri
    if (!uri || (snapshot.trackName && snapshot.durationMs > 0)) return snapshot
    describeRoomTrack(uri)
    const details = roomTracks.get(uri)
    if (details)
      return {
        ...snapshot,
        ...details,
        // The session follows the URI the group reports.
        trackUri: uri,
        linkedFromUri: null,
        albumUri: snapshot.albumUri ?? details.albumUri,
        artworkUrl: details.artworkUrl ?? snapshot.artworkUrl,
      }
    const item =
      session?.sent.find((sent) => sent.uri === uri) ??
      (state.current?.uri === uri ? state.current : null)
    if (!item) return snapshot
    return {
      ...snapshot,
      trackName: snapshot.trackName || item.title,
      artists: snapshot.artists || item.artist,
      albumName: snapshot.albumName || item.albumTitle,
      artworkUrl: snapshot.artworkUrl ?? item.artworkUrl,
    }
  }

  function scrobbling() {
    return holdsSonosLease() && options.scrobbles?.enabled() === true
  }

  /** Spotify's details of a track, as read for the dock where they were. */
  function trackDetails(uri: string): Promise<TrackDetails | null> {
    if (!holdsSonosLease()) return Promise.resolve(null)
    const lease = sonosLease
    const known = roomTracks.get(uri)
    if (known) return Promise.resolve(known)
    return api.track(uri).then(
      (details) => {
        if (!holdsSonosLease(lease)) return null
        roomTracks.set(uri, details)
        return details
      },
      () => null,
    )
  }

  function trackLengths(items: readonly PlayableItem[]) {
    return Promise.all(
      items
        .filter((item) => item.kind === 'track')
        .map(async ({ uri }) => ({
          uri,
          durationMs: (await trackDetails(uri))?.durationMs ?? 0,
        })),
    )
  }

  /**
   * Hands plays on for scrobbling under the names Spotify has for them, and
   * the queued item's where Spotify cannot be asked. Only the first artist is
   * named, as in Spotify's own scrobbles.
   */
  function reportPlays(plays: readonly RoomPlay[], given: PlaybackSession) {
    const scrobbles = options.scrobbles
    if (!scrobbles || plays.length === 0 || !holdsSonosLease())
      return Promise.resolve(false)
    const lease = sonosLease
    return Promise.all(
      plays.map(async ({ uri, startedAt }): Promise<LastfmPlay[]> => {
        const details = await trackDetails(uri)
        const item = given.sent.find(
          (sent) => sent.kind === 'track' && sent.uri === uri,
        )
        const track = details?.trackName || item?.title || ''
        const artist =
          details?.artistLinks[0]?.name ||
          item?.credits?.[0]?.name ||
          item?.artist ||
          ''
        if (!track || !artist) return []
        return [
          {
            trackUri: uri,
            track,
            artist,
            album: details?.albumName || item?.albumTitle || '',
            durationMs: details ? Math.round(details.durationMs) : null,
            startedAt: Math.round(startedAt),
          },
        ]
      }),
    ).then((found) => {
      const known = found.flat()
      if (!known.length || !holdsSonosLease(lease)) return false
      scrobbles.report(known)
      return true
    })
  }

  /**
   * Counts what a Sonos group has played of the tracks this app gave it
   * since it was last read, and reports each track once enough of it was
   * heard. Other music on the group is not counted.
   */
  function heardRoom(after: PlaybackSnapshot) {
    const active = session
    if (
      !scrobbling() ||
      state.target.kind !== 'room' ||
      active?.phase !== 'playing' ||
      !after.trackUri ||
      sentIndex(active, after) !== active.index
    )
      return
    const before = sighted
    const reached: Sighting = {
      uri: after.trackUri,
      index: active.index,
      positionMs: after.positionMs,
      at: after.at,
    }
    const step = hearRoom(
      listen,
      before,
      { ...reached, durationMs: after.durationMs },
      active.startedAt,
    )
    sighted = reached
    listen = step.listen
    if (before && step.earlier) {
      const lease = sonosLease
      const { listen: left, budgetMs } = step.earlier
      const passed =
        active.item.kind === 'track'
          ? active.sent.slice(before.index + 1, reached.index)
          : []
      // A track already reported with none passed since leaves nothing to add.
      if (passed.length > 0 || !left?.reported)
        void Promise.all([
          left && left.durationMs > 0
            ? left.durationMs
            : trackDetails(before.uri).then(
                (details) => details?.durationMs ?? 0,
              ),
          trackLengths(passed),
        ]).then(([beforeDurationMs, lengths]) => {
          if (!holdsSonosLease(lease)) return
          reportPlays(
            earlierPlays({
              listen: left,
              before,
              beforeDurationMs,
              passed: lengths,
              budgetMs,
              until: reached.at - reached.positionMs,
            }),
            active,
          )
        })
    }
    if (!listenDue(listen)) return
    const due = listen
    if (
      reportingListen?.uri === due.uri &&
      reportingListen.startedAt === due.startedAt
    )
      return
    reportingListen = due
    const lease = sonosLease
    void reportPlays([{ uri: due.uri, startedAt: due.startedAt }], active).then(
      (reported) => {
        if (!holdsSonosLease(lease)) return
        if (reportingListen === due) reportingListen = null
        // Do not save a play as reported if lease loss prevented the report.
        if (
          reported &&
          listen?.uri === due.uri &&
          listen.startedAt === due.startedAt
        )
          listen = { ...listen, reported: true }
      },
    )
  }

  /**
   * A Sonos group played everything it was given and stopped while it was
   * not read: the tracks from the one it was last on are counted as played,
   * as far as the time since allows.
   */
  function heardToEnd(active: PlaybackSession) {
    const before = sighted
    const left = listen?.uri === before?.uri ? listen : null
    listen = null
    sighted = null
    if (!scrobbling() || !before) return
    const lease = sonosLease
    const budgetMs = now() - before.at
    const rest =
      active.item.kind === 'track' ? active.sent.slice(before.index + 1) : []
    void Promise.all([
      left && left.durationMs > 0
        ? left.durationMs
        : trackDetails(before.uri).then((details) => details?.durationMs ?? 0),
      trackLengths(rest),
    ]).then(([beforeDurationMs, lengths]) => {
      if (!holdsSonosLease(lease)) return
      reportPlays(
        finishedPlays({
          listen: left,
          before,
          beforeDurationMs,
          rest: lengths,
          budgetMs,
        }),
        active,
      )
    })
  }

  /**
   * The tracks of a Sonos group's queue that the account's play history
   * lists since the group was last read, up to the one now `due`. Spotify
   * dates a play by its end.
   */
  function heardInHistory(
    active: PlaybackSession,
    history: readonly PlayedTrack[],
    since: number,
    due: number,
  ) {
    const left = listen
    const next = active.sent[due]
    const latest = Math.max(since, ...history.map((entry) => entry.playedAt))
    // The group is counted from the track now due, should it play on.
    listen = null
    sighted = next
      ? { uri: next.uri, index: due, positionMs: 0, at: latest }
      : null
    if (!scrobbling()) return
    const lease = sonosLease
    const played = active.sent.slice(active.index, due).flatMap((item) => {
      const entry = history.find(
        (heard) =>
          heard.playedAt > since &&
          (heard.uri === item.uri || sameName(heard.name, item.title)),
      )
      const reported = left?.uri === item.uri && left.reported
      return entry && !reported && item.kind === 'track'
        ? [{ uri: item.uri, endedAt: entry.playedAt }]
        : []
    })
    void Promise.all(
      played.map(async ({ uri, endedAt }) => ({
        uri,
        startedAt: endedAt - ((await trackDetails(uri))?.durationMs ?? 0),
      })),
    ).then((plays) => {
      if (holdsSonosLease(lease)) reportPlays(plays, active)
    })
  }

  /** Reads what a Sonos group plays and keeps its queue supplied. */
  async function pollRoom(target: RoomTarget) {
    const sonos = options.sonos
    // The answer to a command on its way starts the next read.
    if (!sonos || !holdsSonosLease() || sonosPending > 0) return
    const lease = sonosLease
    let reported: SonosGroupState
    let epoch: number
    const restored = restores
    do {
      epoch = sonosEpoch
      roomPolls += 1
      const reason = !session
        ? 'room-watching'
        : roomPlaying()
          ? 'room-playing'
          : 'room-paused'
      try {
        reported = await sonos.state(
          target.room.id,
          roomPolls % ROOM_VOLUME_EVERY === 1,
          reason,
        )
      } catch (error) {
        if (!holdsSonosLease(lease)) return
        throw error
      }
      if (
        !holdsSonosLease(lease) ||
        !sameDevice(state.target, target) ||
        restored !== restores
      )
        return
      pollErrors = 0
      // A report read across a command may predate it, so it is read again.
    } while (epoch !== sonosEpoch && sonosPending === 0)
    if (epoch !== sonosEpoch) return
    if (
      reported.volume !== undefined &&
      !volumeTimer &&
      reported.volume !== state.volume
    )
      set({ volume: reported.volume })
    const snapshot = roomSnapshot(reported, now())
    if (roomExpected) {
      if (
        snapshot?.trackUri !== roomExpected.uri &&
        now() < roomExpected.until
      ) {
        // The group has not caught up with what it was told to play.
        schedule(FOLLOW_UP_MS)
        return
      }
      roomExpected = null
    }
    if (!snapshot) {
      missed()
      if (missing === MISSING_STATES && (session || latest)) playbackStopped()
      return
    }
    missing = 0
    const shown = roomTrack(snapshot)
    observe(shown)
    heardRoom(shown)
    maintainRoom()
    // The track due next is described ahead, so a skip to it shows at once.
    const following = session?.sent[session.index + 1]
    if (following?.kind === 'track') describeRoomTrack(following.uri)
  }

  function observeLocal(payload: unknown) {
    const snapshot = sdkPlayback(payload, now())
    if (snapshot) {
      sawLocalState = true
      missing = 0
      observe(snapshot)
      if (!timer && !ticking && shouldPoll()) schedule(LOCAL_POLL_MS)
      return true
    }
    return false
  }

  /** The target once a followed device has gone quiet: the one chosen before it. */
  function quietTarget(): Partial<PlaybackState> {
    const restored = fallback ?? (isObserved(state.target) ? LOCAL : null)
    fallback = null
    if (!restored) return {}
    if (restored.kind === 'local') sawLocalState = false
    return {
      target: restored,
      volume: restored.kind === 'local' ? localVolume : restored.device.volume,
    }
  }

  /**
   * Picks the session up from what its device reports now, like a saved
   * session's device: followed where it still holds the queue, and left as
   * it is otherwise. This is for a device this page stopped following: one
   * last read too long ago to know what it played since, as after the
   * computer slept, or one that has gone quiet. Nothing is started on it.
   */
  function recheck(after: PlaybackSnapshot | null) {
    const seen = latest
    reattach(
      { snapshot: seen, current: state.current, savedAt: seen?.at ?? now() },
      after,
      UNFOLLOWED,
    )
  }

  /** The device no longer reports playback. */
  function playbackStopped() {
    if (sourceStarting) return
    const since = missing > 0 && quietAt !== null ? quietAt : now()
    const playing = session?.phase === 'playing' && latest !== null
    // A page that was not reading the device cannot tell that its track ran
    // out just now, so nothing follows by itself.
    const ended =
      playing &&
      latest !== null &&
      since - latest.at <= WATCHED_MS &&
      !latest.paused &&
      latest.durationMs > 0 &&
      positionAt(latest, now()) >= latest.durationMs
    roomExpected = null
    // A device can go quiet instead of resetting when its last track runs out.
    if (ended && continueQueue()) return
    if (playing && !ended) {
      // The item did not finish: it is kept to start again where it stopped.
      recheck(null)
      set(quietTarget())
      return
    }
    detach()
    latest = null
    set({
      active: used || state.queue.length > 0,
      snapshot: null,
      current: null,
      starting: false,
      ...quietTarget(),
    })
  }

  /**
   * Makes a device that was not chosen here the target. The earlier target
   * comes back once that device goes quiet.
   */
  function aim(target: FollowedTarget) {
    if (state.target.kind === 'local' || state.target.kind === 'remote')
      fallback ??= state.target
    missing = 0
    set({ target, volume: targetVolume(target) })
  }

  /** Follows playback on a device that was not chosen here. */
  function follow(target: FollowedTarget, snapshot: PlaybackSnapshot) {
    aim(target)
    observe(snapshot)
  }

  /**
   * The device of the item kept here is heard again. It is picked up from
   * what it reports, which may be further on in the tracks it was given.
   */
  function rejoinKept(after: PlaybackSnapshot) {
    const kept = resume
    if (!kept?.given || session) return false
    session = kept.given
    reattach(
      { snapshot: state.snapshot, current: state.current, savedAt: kept.since },
      after,
      UNFOLLOWED,
    )
    return true
  }

  /**
   * Whether a paused device has moved on from the item kept here: to a
   * later one of its tracks, past all of them, or to other music.
   */
  function keptMoved(after: PlaybackSnapshot) {
    const given = resume?.given
    if (!given) return false
    const verdict = rejoinVerdict(given, state.snapshot, after, false)
    if (verdict.verdict === 'rejoined') return verdict.index > given.index
    return verdict.verdict === 'changed' || verdict.finished
  }

  /** The device Spotify reports playback on, if any. */
  function reported(
    remote: RemoteState,
  ): Exclude<PlaybackTarget, RoomTarget> | null {
    if (remote.device)
      return remote.device.id === localId
        ? LOCAL
        : { kind: 'remote', device: remote.device }
    if (!remote.restricted) return null
    const found: ObservedTarget = { kind: 'restricted', ...remote.restricted }
    return left && sameDevice(left, found) ? null : found
  }

  /**
   * Keeps the target in step with the device Spotify reports, so commands go
   * to the device that has the playback even after another app moved it.
   */
  function retarget(target: FollowedTarget, remote: RemoteState) {
    const found = reported(remote)
    if (!found) return
    if (sameDevice(target, found)) {
      if (
        target.kind === 'remote' &&
        found.kind === 'remote' &&
        !volumeTimer &&
        (found.device.volume !== target.device.volume ||
          found.device.name !== target.device.name)
      )
        set({ target: found, volume: found.device.volume })
      return
    }
    // A start or transfer made here takes a moment to show in Spotify's report.
    if (session?.phase === 'starting' || now() < settlesAt) return
    if (found.kind === 'local') {
      fallback = null
      sawLocalState = true
      set({ target: found, volume: localVolume })
      return
    }
    if (target.kind === 'remote') fallback ??= target
    set({ target: found, volume: targetVolume(found) })
  }

  /** Follows playback at once when another device already reports it. */
  async function lookElsewhere() {
    if (lookingElsewhere) return
    lookingElsewhere = true
    try {
      const remote = await api.state()
      if (state.target.kind !== 'local' || disposed) return
      const found = reported(remote)
      if (found && found.kind !== 'local' && remote.snapshot)
        follow(found, remote.snapshot)
    } catch {
      // The regular checks decide what a failing report means.
    } finally {
      lookingElsewhere = false
    }
    if (!timer && !ticking && pollDelay() !== null) schedule(FOLLOW_UP_MS)
  }

  /** This browser stopped reporting playback; it may have moved to another device. */
  async function followElsewhere() {
    try {
      const remote = await api.state()
      if (state.target.kind !== 'local') return
      const found = reported(remote)
      if (found && found.kind !== 'local' && remote.snapshot)
        follow(found, remote.snapshot)
      else playbackStopped()
    } catch (error) {
      playbackStopped()
      if (playbackFailure(error).status === 'expired') fail(error)
    }
  }

  /** Looks for playback the account started elsewhere, so it can be shown and controlled. */
  async function findPlayback() {
    const remote = await api.state().catch((error: unknown) => {
      // A failed background check is simply repeated at the next one.
      if (!followingSonos && playbackFailure(error).status === 'expired')
        fail(error)
      return null
    })
    if (!remote || session || latest || disposed || followingSonos) return
    const found = reported(remote)
    const snapshot = remote.snapshot
    if (!found || found.kind === 'local' || !snapshot) return
    if (!snapshot.paused) {
      follow(found, snapshot)
      return
    }
    // Paused playback is left alone, unless another app moved the device on
    // from the item kept here and paused it there.
    if (!keptMoved(snapshot)) return
    aim(found)
    rejoinKept(snapshot)
  }

  function roomPlaying() {
    return session?.phase === 'starting' || latest?.paused === false
  }

  function shouldPoll() {
    if (state.failure?.status === 'expired') return false
    if (state.target.kind === 'room')
      return roomPlaying() && (session !== null || visible())
    if (session) return true
    return latest !== null && !latest.paused && visible()
  }

  /** Time to the next check: frequent while following playback, occasional while watching for it. */
  function pollDelay(): number | null {
    if (followingSonos || (!sonosPolling && state.target.kind === 'room'))
      return null
    const room = state.target.kind === 'room'
    if (shouldPoll()) {
      if (room && session?.phase !== 'starting') return ROOM_PLAYING_POLL_MS
      if (
        state.target.kind === 'remote' &&
        session?.phase === 'playing' &&
        latest &&
        !latest.paused &&
        latest.durationMs > latest.positionMs &&
        (state.queue.length || source?.upcoming.length)
      ) {
        // An edit in the final moments, an album or a repeated URI may need
        // a separate start. Read just past the boundary before acting.
        const remaining = latest.durationMs - positionAt(latest, now())
        if (remaining > 0) return Math.min(REMOTE_POLL_MS, remaining + 100)
      }
      return state.target.kind === 'local' ? LOCAL_POLL_MS : REMOTE_POLL_MS
    }
    const idle =
      (watching || (room && session !== null)) &&
      visible() &&
      state.failure?.status !== 'expired'
    if (!idle) return null
    return room ? ROOM_IDLE_POLL_MS : IDLE_POLL_MS
  }

  async function tick() {
    if (ticking || disposed || followingSonos) return
    ticking = true
    try {
      const target = state.target
      if (target.kind === 'room') {
        if (session || latest || (watching && visible())) await pollRoom(target)
      } else if (!session && !latest) {
        if (watching && visible()) await findPlayback()
      } else if (target.kind === 'local') {
        const sdk = player ? await player.getCurrentState() : null
        const found = state.target.kind === 'local' && observeLocal(sdk)
        if (!found && sawLocalState) {
          missed()
          // A paused browser player that lost its playback has usually handed
          // it to another device.
          const handedOver = watching && !session && latest?.paused === true
          if (missing === MISSING_STATES || handedOver) await followElsewhere()
          else await lookElsewhere()
        }
      } else if (!remoteCommand) {
        const generation = run
        const revision = remoteCommandRevision
        const before = latest
        const remote = await api.state()
        pollErrors = 0
        if (
          !disposed &&
          state.target === target &&
          generation === run &&
          revision === remoteCommandRevision
        ) {
          if (remote.snapshot) {
            missing = 0
            retarget(target, remote)
            observe(remote.snapshot)
            if (
              remote.device &&
              state.target.kind === 'remote' &&
              remote.device.id === state.target.device.id &&
              generation === run &&
              latest === remote.snapshot &&
              (!before || remote.snapshot.at - before.at <= WATCHED_MS)
            )
              await updateRemoteQueue(remote.device.id, remote.snapshot)
          } else {
            missed()
            if (missing === MISSING_STATES) playbackStopped()
          }
        }
      }
      if (
        session?.phase === 'starting' &&
        now() - session.startedAt > START_TIMEOUT_MS
      ) {
        detach()
        set({ starting: false, failure: NOT_STARTED })
      }
    } catch (error) {
      // One failed check is not the end of playback; repeated failures are.
      if (followingSonos) return
      pollErrors += 1
      if (
        pollErrors >= MISSING_STATES ||
        playbackFailure(error).status === 'expired'
      ) {
        pollErrors = 0
        // A Sonos group showing nothing is only being watched; its failed
        // reads are repeated quietly.
        const shown = session !== null || latest !== null
        playbackStopped()
        if (shown || state.target.kind !== 'room') fail(error)
      }
    } finally {
      ticking = false
    }
    const delay = pollDelay()
    if (!timer && delay !== null) schedule(delay)
  }

  /** Shows the expected result of a command before the device confirms it. */
  function expect(patch: Partial<PlaybackSnapshot>) {
    if (!latest) return
    const at = now()
    latest = { ...latest, positionMs: positionAt(latest, at), at, ...patch }
    if (session?.phase !== 'starting') set({ snapshot: latest })
  }

  function seek(positionMs: number) {
    const target = state.target
    if (!canControl(target)) return
    if (!latest && resume && state.snapshot) {
      // Nothing plays yet: this moves where the restored item will start.
      const position = Math.max(
        0,
        Math.min(positionMs, state.snapshot.durationMs),
      )
      resume = { ...resume, positionMs: position }
      set({ snapshot: { ...state.snapshot, positionMs: position, at: now() } })
      return
    }
    if (!latest || target.kind === 'restricted') return
    if (target.kind === 'sonos' && !target.group.actions.seek) return
    const position = Math.max(0, Math.min(positionMs, latest.durationMs))
    set({ failure: null })
    expect({ positionMs: position })
    if (target.kind === 'local') guard(player?.seek(position))
    else if (target.kind === 'remote')
      guard(sendRemote(() => api.seek(target.device.id, position)))
    else
      sonosSend(groupId(target), {
        action: 'seek',
        positionMs: Math.round(position),
      })
    schedule(FOLLOW_UP_MS)
  }

  /** Pauses the device playback is being taken from. */
  function quiet(target: PlaybackTarget) {
    const ignored = () => undefined
    if (target.kind === 'local') {
      if (localId) api.pause(localId).catch(ignored)
    } else if (target.kind === 'remote')
      sendRemote(() => api.pause(target.device.id)).catch(ignored)
    else if (isSonosTarget(target) && holdsSonosLease())
      options.sonos
        ?.command(groupId(target), { action: 'pause' })
        .catch(ignored)
  }

  function selectedVolume(next: SelectableTarget) {
    if (next.kind === 'local') return localVolume
    return next.kind === 'remote' ? next.device.volume : null
  }

  /**
   * Moves playback to or from a Sonos group. Spotify cannot move a session
   * there, so what is playing is started again on the chosen device at the
   * same position and paused where it was.
   */
  function moveTo(next: SelectableTarget) {
    const from = state.target
    if (!canControl(from) || !canControl(next)) return
    if (sameDevice(from, next)) return
    if (next.kind === 'local') player?.activateElement().catch(() => undefined)
    if (resume && !latest) {
      // Nothing plays yet: the restored item starts on the chosen device.
      roomPolls = 0
      set({
        target: next,
        volume: selectedVolume(next),
        failure: null,
        findingSonos: false,
        rejoin: null,
      })
      schedule(0)
      return
    }
    const shown = latest
    const playing = shown !== null && !shown.paused
    const position = shown ? positionAt(shown, now()) : 0
    const started = session?.item
    const item = !playing
      ? null
      : started
        ? started.kind === 'album' && shown.trackUri
          ? { ...started, startUri: shown.trackUri }
          : started
        : shownTrack(shown)
    // The group itself is taken over by the queue started on it.
    const sameGroup =
      from.kind === 'sonos' &&
      next.kind === 'room' &&
      from.group.id === next.room.id
    if (playing && !sameGroup) quiet(from)
    run += 1
    detach()
    latest = null
    roomExpected = null
    fallback = null
    // Spotify keeps reporting a device it would not let this app pause.
    left = from.kind === 'restricted' ? from : null
    sawLocalState = false
    missing = 0
    roomPolls = 0
    settlesAt = 0
    if (!started || !item) currentFromSource = false
    set({
      target: next,
      volume: selectedVolume(next),
      snapshot: null,
      current: item,
      starting: false,
      failure: null,
      findingSonos: false,
      rejoin: null,
    })
    if (item) void start(item, undefined, position)
    else schedule(0)
  }

  /** The target in terms another browser can resolve. */
  function savedTarget(): SavedTarget {
    const target = state.target
    if (target.kind === 'room') return { kind: 'room', room: target.room }
    if (target.kind === 'remote') {
      const { id, name, type, volume } = target.device
      return {
        kind: 'spotify',
        device: { id, name, type, volume },
        browser: null,
      }
    }
    if (target.kind === 'local')
      return {
        kind: 'spotify',
        device: localId
          ? {
              id: localId,
              name: options.playerName,
              type: 'computer',
              volume: localVolume,
            }
          : null,
        browser: options.browserId ?? null,
      }
    return { kind: 'spotify', device: null, browser: null }
  }

  function savedSource(): SavedSource | null {
    const active = source
    const descriptor = active?.definition.descriptor
    if (
      !active ||
      !descriptor ||
      active.initializing ||
      active.definition.length === undefined
    )
      return null
    const { label, href, length, startIndex, kind } = active.definition
    return {
      descriptor,
      label,
      href,
      length,
      startIndex,
      kind,
      remaining: indexRanges(active.remaining),
      played: [...active.played],
      skipped: [...active.skipped],
      exhausted: [...active.exhausted],
      upcoming: active.upcoming.slice(0, SAVED_TRACKS),
      history: active.history.slice(-SAVED_TRACKS),
    }
  }

  /**
   * What this app is playing and has queued, for the shared session. Null
   * when there is nothing of its own to carry on with.
   */
  function saved(): SavedPlayback | null {
    const kept = savedSource()
    // The tracks a quiet device was given are saved with the item kept, so
    // the page opened next can tell that it played on through them.
    const active = session ?? resume?.given ?? null
    if (!active && !state.current && !state.queue.length && !kept) return null
    const at = now()
    const from = active && active.sent.length > SAVED_SENT ? active.index : 0
    const pending =
      pendingRemoteQueue?.active === active ? pendingRemoteQueue.sent : null
    return {
      version: 1,
      savedAt: at,
      queue: state.queue,
      sequence,
      current: state.current,
      currentFromSource,
      session: active
        ? {
            item: active.item,
            sent: active.sent.slice(from, from + SAVED_SENT),
            index: active.index - from,
            anchorUri: active.anchorUri,
            ...(pending ? { pendingSent: pending.slice(0, SAVED_SENT) } : {}),
          }
        : null,
      snapshot: latest
        ? { ...latest, positionMs: positionAt(latest, at), at }
        : resume
          ? state.snapshot
          : null,
      shuffle: state.shuffle,
      target: savedTarget(),
      source: kept,
      listen,
    }
  }

  function restoredTarget(target: SavedTarget): SelectableTarget {
    if (target.kind === 'room')
      return options.sonos ? { kind: 'room', room: target.room } : LOCAL
    const { device, browser } = target
    // This page's own player, now or before a reload, is this browser.
    if (
      !device ||
      device.id === localId ||
      (browser !== null && browser === options.browserId)
    )
      return LOCAL
    return {
      kind: 'remote',
      device: { ...device, active: false, restricted: false },
    }
  }

  /** Where the device is in the tracks it was given: an index into them, or -1. */
  function sentIndex(active: PlaybackSession, after: PlaybackSnapshot) {
    if (active.item.kind === 'album')
      return after.contextUri === active.item.uri ? active.index : -1
    const index = givenIndex(active.sent, active.index, after)
    // Spotify may have played another recording of the current track.
    if (index < 0 && after.trackUri && after.trackUri === active.anchorUri)
      return active.index
    return index
  }

  /** A track can confirm a pending replacement only by its recording URI. */
  function observedReplacement(
    confirmed: PlaybackSession | null,
    sent: PlayableItem[] | undefined,
    before: PlaybackSnapshot | null,
    after: PlaybackSnapshot | null,
  ) {
    if (!confirmed || !sent || !after?.trackUri) return null
    const matches = (item: PlayableItem) =>
      item.uri === after.trackUri || item.uri === after.linkedFromUri
    if (sent.filter(matches).length !== 1) return null
    const replacement = { ...confirmed, sent, index: 0 }
    const verdict = rejoinVerdict(replacement, before, after, false)
    if (verdict.verdict !== 'rejoined' || verdict.index === 0) return null
    return {
      replacement,
      index: verdict.index,
      ambiguous:
        after.trackUri === confirmed.anchorUri || confirmed.sent.some(matches),
    }
  }

  function targetName(target: PlaybackTarget): string | null {
    if (target.kind === 'local') return null
    if (target.kind === 'room') return target.room.name
    return target.kind === 'remote' ? target.device.name : target.name
  }

  /**
   * Moves the queue on past the tracks the account played while no page was
   * following the device, as Spotify's play history lists them. `held` is
   * the item kept to start again, which gives way to the first track not
   * played; null when other playback is shown instead.
   */
  function catchUp(
    active: PlaybackSession,
    since: number,
    held: PlayableItem | null,
    /** The session played on a Sonos group, whose plays are scrobbled here. */
    room: boolean,
  ) {
    if (active.item.kind !== 'track' || (room && !holdsSonosLease())) return
    const checked = run
    const lease = sonosLease
    api.played(since).then(
      (history) => {
        if (
          !history ||
          checked !== run ||
          disposed ||
          session ||
          (room && !holdsSonosLease(lease))
        )
          return
        if ((resume?.item ?? null) !== held) return
        const due = playedThrough(active.sent, active.index, history, since)
        if (due <= active.index) return
        if (room) heardInHistory(active, history, since, due)
        pass(active, due - 1)
        if (!held) return
        const next = active.sent[due]
        const first = planned()[0]
        // A saved edit may put another item ahead of Spotify's next track.
        const reached = first && next?.uri === first.item.uri ? first : null
        if (reached) take(reached)
        currentFromSource = reached?.from === 'source'
        resume =
          next && reached
            ? {
                item: next,
                positionMs: 0,
                given: { ...active, item: next, index: due, anchorUri: null },
                // The history has been counted up to its latest entry.
                since: Math.max(
                  since,
                  ...history.map((entry) => entry.playedAt),
                ),
              }
            : null
        set({ current: resume?.item ?? null, snapshot: null })
      },
      // The queue stays where this page last saw it.
      () => undefined,
    )
  }

  /**
   * Picks a session up from what its device reports, after a time in which
   * no page followed it. A device still on the tracks it was given is
   * followed from the track it has reached. When nothing plays them any
   * more, the item is kept to start again where it stopped, or the queue is
   * moved on past what was played meanwhile. Nothing is sent to the device.
   *
   * With `check`, the device was not followed for a while, perhaps hours. It
   * is rejoined only when it holds the same queue further along; a Sonos
   * group that holds anything else is left alone.
   */
  function reattach(
    saved: Pick<SavedPlayback, 'snapshot' | 'current' | 'savedAt'>,
    after: PlaybackSnapshot | null,
    check: {
      idle: boolean
      unreadable: boolean
      announce: boolean
      /** The saved device's name, for a device that has gone since. */
      device: string | null
    } | null,
    pendingSent?: PlayableItem[],
  ) {
    rejoining = null
    resume = null
    const pending = observedReplacement(
      session,
      pendingSent,
      saved.snapshot,
      after,
    )
    const active = pending && !pending.ambiguous ? pending.replacement : session
    const room = state.target.kind === 'room'
    const device = targetName(state.target) ?? check?.device ?? null
    const report = (status: PlaybackRejoin['status']) => {
      if (check?.announce) set({ rejoin: { status, device } })
    }
    const verdict =
      active && check
        ? rejoinVerdict(active, saved.snapshot, after, check.idle)
        : null
    const index =
      !after || !active
        ? -1
        : !verdict
          ? sentIndex(active, after)
          : verdict.verdict === 'rejoined'
            ? verdict.index
            : -1
    if (after && active && index >= 0) {
      const item = active.sent[index]
      if (item && index > active.index) {
        // If the report fits both lists, keep anything either may not have played.
        const alsoReached = pending?.ambiguous
          ? new Set(
              pending.replacement.sent
                .slice(1, pending.index + 1)
                .map((track) => track.uri),
            )
          : undefined
        const reached = pass(active, index, alsoReached)
        if (reached) currentFromSource = reached.from === 'source'
        session = { ...active, item, index, anchorUri: after.trackUri }
        set({ current: item })
      }
      latest = after
      heard = after.trackUri
      heardFor = session?.sent[session.index]?.uri ?? null
      set({ active: true, snapshot: after, starting: false })
      report('rejoined')
      findSonos()
      maintainRoom()
      return
    }
    detach()
    /** The session the device left, when it was not being followed. */
    const unfollowed = check ? active : null
    const changed = verdict?.verdict === 'changed'
    if (changed && state.target.kind === 'room') {
      // The room plays or holds something else now. It is left alone, and
      // the queue and source are kept for whatever is played next.
      currentFromSource = false
      latest = null
      set({
        current: null,
        snapshot: null,
        starting: false,
        target: LOCAL,
        volume: localVolume,
      })
      report('changed')
      if (unfollowed) catchUp(unfollowed, saved.savedAt, null, room)
      return
    }
    if (after && (changed || !after.paused)) {
      // Other playback has taken the device, playing or paused there. It is
      // shown and controlled as it is; the queue and source are kept.
      currentFromSource = false
      latest = after
      heard = after.trackUri
      heardFor = null
      set({ current: null, snapshot: after, starting: false })
      report('changed')
      findSonos()
      if (unfollowed) catchUp(unfollowed, saved.savedAt, null, room)
      return
    }
    latest = null
    if (
      active &&
      verdict?.verdict === 'ended' &&
      verdict.finished &&
      !pending
    ) {
      // The device played all it was given, so the queue goes on after it.
      if (room) heardToEnd(active)
      pass(active, active.sent.length)
      currentFromSource = false
      set({ current: null, snapshot: null, starting: false })
      report('ended')
      return
    }
    const shown = saved.snapshot
    const item = saved.current
    resume = item
      ? {
          item:
            item.kind === 'album' && shown?.trackUri
              ? { ...item, startUri: shown.trackUri }
              : item,
          positionMs: shown?.positionMs ?? 0,
          given: active,
          since: saved.savedAt,
        }
      : null
    set({
      snapshot: shown && item ? { ...shown, paused: true, at: now() } : null,
      starting: false,
    })
    report(check?.unreadable ? 'unreadable' : 'ended')
    if (unfollowed && resume)
      catchUp(unfollowed, saved.savedAt, resume.item, room)
  }

  /**
   * Takes a saved session over: its queue, source and device, then what the
   * device is playing now. Nothing is sent to the device, also when this page
   * was the one playing and has just been reloaded. `claimed` is set when the
   * session is taken from a page that was running it a moment ago, so its
   * device is followed as it is; otherwise the device is checked for the
   * queue it was given, as when the app is opened again after every page
   * was closed.
   */
  async function restore(
    restored: SavedPlayback,
    { claimed = false }: { claimed?: boolean } = {},
  ) {
    const restoringRoom = restored.target.kind === 'room'
    if (disposed || (restoringRoom && !holdsSonosLease())) return
    const lease = sonosLease
    run += 1
    roomRun += 1
    restores += 1
    const restoring = run
    rejoining = restoring
    const current = () =>
      restoring === run &&
      !disposed &&
      (!restoringRoom || holdsSonosLease(lease))
    stop()
    const kept = restored.source
    const definition = kept ? (options.restoreSource?.(kept) ?? null) : null
    const active: SourceSession | null =
      kept && definition
        ? {
            definition,
            tracks: new Map(),
            remaining: rangeIndexes(kept.remaining),
            played: new Set(kept.played),
            skipped: new Set(kept.skipped),
            exhausted: new Set(kept.exhausted),
            upcoming: [...kept.upcoming],
            history: [...kept.history],
            initializing: false,
            revision: 0,
            filling: null,
            draws: [],
          }
        : null
    source = active
    sourceStarting = false
    // Without its source, the app cannot reconstruct the list the device has.
    remoteSourceUnavailable =
      !active && (kept !== null || restored.currentFromSource)
    remoteQueueEdited = false
    rejectedRemoteTrack = null
    currentFromSource = active !== null && restored.currentFromSource
    sequence = Math.max(sequence, restored.sequence)
    used = true
    latest = null
    skippedAt = null
    sawLocalState = false
    missing = 0
    pollErrors = 0
    fallback = null
    left = null
    settlesAt = 0
    sonosChecked = null
    roomExpected = null
    roomRetryAt = 0
    roomPolls = 0
    resume = null
    const storedSession = restored.session
    session = storedSession
      ? {
          item: storedSession.item,
          sent: storedSession.sent,
          index: storedSession.index,
          anchorUri: storedSession.anchorUri,
          phase: 'playing',
          startedAt: now(),
        }
      : null
    const shown = restored.snapshot
    listen = restored.listen ?? null
    // The group is counted from where the session was saved.
    sighted =
      restored.session && shown?.trackUri
        ? {
            uri: shown.trackUri,
            index: restored.session.index,
            positionMs: shown.positionMs,
            at: shown.at,
          }
        : null
    const target = restoredTarget(restored.target)
    const savedName =
      restored.target.kind === 'room'
        ? restored.target.room.name
        : (restored.target.device?.name ?? null)
    // Playback in a browser stops when its page closes, so there is nothing
    // to rejoin there.
    const announce =
      !claimed &&
      restored.session !== null &&
      (restored.target.kind === 'room' || restored.target.browser === null)
    set({
      active: true,
      current: restored.current,
      snapshot: null,
      queue: restored.queue,
      source: active
        ? { label: active.definition.label, href: active.definition.href }
        : null,
      upcoming: active ? upcomingEntries(active.upcoming) : [],
      shuffle: restored.shuffle,
      sourceLoading: false,
      target,
      volume: selectedVolume(target),
      starting: restored.current !== null,
      failure: null,
      findingSonos: false,
      rejoin: announce ? { status: 'checking', device: savedName } : null,
    })
    if (active) previewSource(active)
    let found: PlaybackSnapshot | null = null
    let idle = false
    let unreadable = false
    try {
      if (target.kind === 'room') {
        const reported = await options.sonos?.state(
          target.room.id,
          true,
          'room-rejoin',
        )
        if (!current()) return
        if (reported?.volume !== undefined) set({ volume: reported.volume })
        const snapshot = reported ? roomSnapshot(reported, now()) : null
        found = snapshot ? roomTrack(snapshot) : null
        idle = reported?.state === 'idle'
      } else {
        const remote = await api.state()
        if (!current()) return
        const device = reported(remote)
        if (device && remote.snapshot) {
          if (!sameDevice(state.target, device))
            set({
              target: device,
              volume:
                device.kind === 'local' ? localVolume : targetVolume(device),
            })
          if (device.kind === 'local') sawLocalState = true
          found = remote.snapshot
        } else if (target.kind === 'remote') {
          // The device may have gone since the session was saved.
          const devices = await api.devices().catch(() => null)
          if (!current()) return
          if (devices && !devices.some(({ id }) => id === target.device.id))
            set({ target: LOCAL, volume: localVolume })
        }
      }
    } catch (error) {
      if (!current()) return
      unreadable = true
      if (playbackFailure(error).status === 'expired') fail(error)
    }
    reattach(
      restored,
      found,
      claimed ? null : { idle, unreadable, announce, device: savedName },
      restored.target.kind === 'spotify' && restored.target.browser === null
        ? storedSession?.pendingSent
        : undefined,
    )
    if (!timer && pollDelay() !== null) schedule(FOLLOW_UP_MS)
  }

  /** Watches another device without touching what it plays. */
  function watchTarget(next: SelectableTarget) {
    latest = null
    missing = 0
    roomPolls = 0
    roomExpected = null
    fallback = null
    sawLocalState = false
    set(
      { target: next, volume: selectedVolume(next), snapshot: null },
      sonosPolling,
    )
    schedule(0)
  }

  /** A shared session grants Sonos observation only to the current driver. */
  function setSonosPolling(enabled: boolean) {
    if (disposed || enabled === sonosPolling) return
    sonosPolling = enabled
    sonosLease += 1
    if (enabled) {
      followingSonos = false
      if (!timer && pollDelay() !== null) schedule(0)
      return
    }
    sonosChecked = null
    sonosTries = 0
    sonosRetryAt = 0
    sonosPending = 0
    roomRun += 1
    roomExpected = null
    reportingListen = null
    describingRoomTracks.clear()
    if (isSonosTarget(state.target)) {
      // Keep the last display while the driver's shared report is arriving.
      followingSonos = latest !== null || state.target.kind === 'sonos'
      stop()
      if (volumeTimer) clearTimeout(volumeTimer)
      volumeTimer = null
    }
    if (state.findingSonos) set({ findingSonos: false })
  }

  /** Mirrors a driver's report without observing, loading or scrobbling it. */
  function followSonos(playback: SharedSonosObservation | null) {
    if (
      disposed ||
      sonosPolling ||
      !options.sonos ||
      (!playback && !followingSonos && !isSonosTarget(state.target))
    )
      return
    followingSonos = playback !== null
    stop()
    latest = playback?.snapshot ? { ...playback.snapshot, at: now() } : null
    missing = 0
    pollErrors = 0
    sawLocalState = false
    fallback = null
    set(
      {
        target: playback?.target ?? LOCAL,
        snapshot: latest,
        volume: playback ? playback.volume : localVolume,
        active: latest !== null || used || state.queue.length > 0,
        findingSonos: false,
      },
      false,
    )
    if (!timer && pollDelay() !== null) schedule(0)
  }

  return {
    getState: () => state,
    saved,
    restore,
    setSonosPolling,
    followSonos,
    /**
     * Another client has taken the session over. The queue, source and item
     * are dropped here without a command to the device, whose playback is
     * still shown and controlled.
     */
    release() {
      run += 1
      roomRun += 1
      detach()
      source = null
      sourceStarting = false
      currentFromSource = false
      resume = null
      rejoining = null
      listen = null
      sighted = null
      set({
        rejoin: null,
        queue: [],
        current: null,
        source: null,
        upcoming: [],
        sourceLoading: false,
        starting: false,
        shuffle: preferredShuffle,
        ...(latest ? {} : { snapshot: null }),
      })
      if (!timer && pollDelay() !== null) schedule(0)
    },
    /**
     * Follows the device another client's session plays on, so its playback
     * is shown here. Spotify devices are found through the account's own
     * report; a Sonos group has to be named.
     */
    watchSaved(target: SavedTarget) {
      if (followingSonos) return
      const shown = state.target
      if (target.kind === 'room') {
        if (!options.sonos) return
        if (shown.kind === 'room' && shown.room.id === target.room.id) return
        watchTarget({ kind: 'room', room: target.room })
      } else if (shown.kind === 'room') watchTarget(LOCAL)
    },
    /** Unlocks audio in this browser; call it inside the user's gesture. */
    activate,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** Loads the browser player ahead of the first click, so that click can unlock audio. */
    prepare() {
      loadPlayer().catch(() => undefined)
    },
    /** Starts noticing playback on the account that this app did not start. */
    watch() {
      watching = true
      schedule(0)
    },
    /** Checks playback again, for example when the page becomes visible. */
    refresh() {
      if (pollDelay() !== null) schedule(0)
    },
    /** Dismisses the error or the note about rejoining a saved session. */
    clearFailure() {
      if (state.failure || state.rejoin) set({ failure: null, rejoin: null })
    },
    play(
      item: PlayableItem,
      definition?: PlaybackSource | PendingPlaybackSource,
    ) {
      if (refused()) return
      activate()
      if (definition && 'resolve' in definition)
        startPendingSource(item, definition)
      else if (definition) void startSource(item, definition)
      else {
        clearSource()
        if (item.kind === 'album') set({ shuffle: false })
        void start(item)
      }
    },
    /**
     * Shuffle is remembered for lists and playlists. On an album it applies
     * to that album only, which starts in order next time.
     */
    toggleShuffle() {
      const active = source
      const shuffle = !state.shuffle
      const album = active
        ? active.definition.kind === 'album'
        : state.current?.kind === 'album'
      if (!album) {
        preferredShuffle = shuffle
        options.onShuffle?.(shuffle)
      }
      if (!active) {
        set({ shuffle })
        return
      }
      const length = active.definition.length
      if (length === undefined) {
        set({ shuffle })
        return
      }
      if (shuffle) active.skipped.clear()
      active.revision += 1
      active.filling = null
      active.upcoming = []
      active.remaining = shuffle
        ? Array.from({ length }, (_, index) => index).filter(
            (index) => !active.exhausted.has(index),
          )
        : [...active.remaining].sort((a, b) => a - b)
      set({ shuffle, upcoming: [] })
      if (!active.initializing) previewSource(active)
      refreshDeviceQueue()
    },
    enqueue(item: PlayableItem) {
      sequence += 1
      used = true
      set({
        active: true,
        queue: [...state.queue, { key: `queue-${sequence}`, item }],
        announcement: `Added to queue: ${item.title}`,
      })
      refreshDeviceQueue()
    },
    playFromQueue(key: string) {
      const entry = state.queue.find((candidate) => candidate.key === key)
      if (!entry || refused()) return
      activate()
      sourceStarting = false
      currentFromSource = false
      set({ queue: state.queue.filter((candidate) => candidate !== entry) })
      void start(entry.item)
    },
    removeFromQueue(key: string) {
      const entry = state.queue.find((candidate) => candidate.key === key)
      if (!entry) return
      set({
        queue: state.queue.filter((candidate) => candidate !== entry),
        announcement: `Removed from queue: ${entry.item.title}`,
      })
      refreshDeviceQueue()
    },
    moveInQueue(from: number, to: number) {
      const entry = state.queue[from]
      if (!entry || to < 0 || to >= state.queue.length || from === to) return
      set({
        queue: moveEntry(state.queue, from, to),
        announcement: `${entry.item.title}: position ${to + 1} of ${state.queue.length}`,
      })
      refreshDeviceQueue()
    },
    clearQueue() {
      if (!state.queue.length) return
      set({ queue: [], announcement: 'Queue cleared' })
      refreshDeviceQueue()
    },
    /**
     * Skips ahead in the source to one of its upcoming tracks. The tracks
     * before it are passed over; the manual queue is kept and plays next.
     */
    playUpcoming(key: string) {
      const found = upcomingTrack(key)
      if (!found || refused()) return
      activate()
      const { active, entry } = found
      const at = active.upcoming.indexOf(entry)
      for (const passed of active.upcoming.slice(0, at))
        active.skipped.add(sourceTrackKey(passed.index, passed.position))
      active.upcoming = active.upcoming.slice(at)
      consumeSource(active, entry)
    },
    /** Takes an upcoming track out of the source; the source goes on without it. */
    removeUpcoming(key: string) {
      const found = upcomingTrack(key)
      if (!found) return
      const { active, entry } = found
      rearrangeSource(active, withdrawSource(active, entry), {
        announcement: `Removed from upcoming tracks: ${entry.item.title}`,
      })
    },
    moveUpcoming(from: number, to: number) {
      const active = source
      const entry = active?.upcoming[from]
      if (!active || !entry || from === to) return
      if (to < 0 || to >= active.upcoming.length) return
      rearrangeSource(active, moveEntry(active.upcoming, from, to), {
        announcement: `${entry.item.title}: position ${to + 1} of upcoming tracks`,
      })
    },
    /**
     * Moves an upcoming source track into the manual queue, at `to` or at its
     * end. The source goes on without it.
     */
    queueUpcoming(key: string, to?: number) {
      const found = upcomingTrack(key)
      if (!found) return
      const { active, entry } = found
      sequence += 1
      const queue = [...state.queue]
      const at = Math.min(Math.max(0, to ?? queue.length), queue.length)
      queue.splice(at, 0, { key: `queue-${sequence}`, item: entry.item })
      rearrangeSource(active, withdrawSource(active, entry), {
        queue,
        announcement: `Moved to queue: ${entry.item.title}`,
      })
    },
    toggle() {
      if (!canControl(state.target)) return
      if (session?.phase === 'starting' || sourceStarting) return
      activate()
      acted()
      if (currentFromSource && source?.initializing && state.current) {
        const { length, ...definition } = source.definition
        if (length !== undefined)
          void startSource(state.current, { ...definition, length })
        return
      }
      if (!latest || (resume && latest.paused)) {
        // Nothing is loaded on the device: start the restored item where it
        // stopped, retry the item, or start the queue.
        if (refused()) return
        if (resume) void start(resume.item, undefined, resume.positionMs)
        else if (state.current) void start(state.current)
        else startNext()
        return
      }
      const target = state.target
      if (target.kind === 'restricted') return
      set({ failure: null })
      if (target.kind === 'local') guard(player?.togglePlay())
      else {
        const paused = latest.paused
        const updated =
          paused && target.kind === 'remote'
            ? updateRemoteQueue(target.device.id, latest, true)
            : null
        expect({ paused: !paused })
        if (target.kind === 'remote')
          guard(
            updated ??
              sendRemote(() =>
                paused
                  ? api.resume(target.device.id)
                  : api.pause(target.device.id),
              ),
          )
        else sonosSend(groupId(target), { action: paused ? 'play' : 'pause' })
      }
      schedule(FOLLOW_UP_MS)
    },
    next() {
      const target = state.target
      if (!canControl(target)) return
      acted()
      // A Sonos group skips to the next track in its queue when that is the
      // track due; otherwise the track due is started on it.
      const queued =
        session?.phase === 'playing' && session.item.kind === 'track'
          ? session.sent[session.index + 1]
          : undefined
      const due = state.queue[0]?.item ?? source?.upcoming[0]?.item
      const inStep = queued !== undefined && queued.uri === due?.uri
      const skip = (group: string, after?: Promise<unknown>) => {
        skippedAt = now()
        set({ failure: null })
        sonosSend(group, { action: 'next' }, after)
        schedule(FOLLOW_UP_MS)
      }
      if (isObserved(target)) {
        if (target.kind !== 'sonos') return
        const skips = latest !== null && target.group.actions.next
        if (skips && (inStep || !roomBehind(target)))
          return skip(groupId(target))
        if (roomBehind(target) && startNext()) return
        if (skips) skip(groupId(target))
        return
      }
      const itemEnds =
        !session ||
        session.phase === 'starting' ||
        session.item.kind === 'track' ||
        latest?.hasNext === false
      activate()
      if (target.kind === 'room') {
        if (!(inStep && latest) && itemEnds && startNext()) return
        if (!latest) return
        const paused = latest.paused
        // A queue change on its way to the group goes first, so the track
        // is there to skip to.
        skip(groupId(target), roomBusy > 0 ? roomWork : undefined)
        if (inStep && queued) expectRoomTrack(queued, 0, paused)
        return
      }
      if (itemEnds && startNext()) return
      if (!latest) return
      skippedAt = now()
      set({ failure: null })
      if (target.kind === 'local') guard(player?.nextTrack())
      else guard(sendRemote(() => api.next(target.device.id)))
      schedule(FOLLOW_UP_MS)
    },
    previous() {
      const target = state.target
      if (!latest || target.kind === 'restricted' || !canControl(target)) return
      acted()
      if (positionAt(latest, now()) > RESTART_AFTER_MS) return seek(0)
      if (target.kind === 'sonos') {
        // Sonos refuses to go back in some Spotify Connect sessions.
        if (!target.group.actions.previous) return seek(0)
        set({ failure: null })
        sonosSend(groupId(target), { action: 'previous' })
        schedule(FOLLOW_UP_MS)
        return
      }
      if (currentFromSource && source && source.history.length > 1) {
        const previous = source.history.at(-2)
        const current = source.history.pop()
        if (previous && current) {
          source.upcoming = [current, ...source.upcoming].slice(
            0,
            SOURCE_AHEAD_SIZE,
          )
          source.revision += 1
          source.filling = null
          set({ upcoming: upcomingEntries(source.upcoming) })
          void start(previous.item)
          previewSource(source)
          return
        }
      }
      set({ failure: null })
      if (target.kind === 'local') guard(player?.previousTrack())
      else if (target.kind === 'room') {
        const lease = sonosLease
        // The group's queue has nothing before the track it started with.
        sonosCommand(target.room.id, { action: 'previous' }).catch(() => {
          if (holdsSonosLease(lease)) seek(0)
        })
      } else
        sendRemote(() => api.previous(target.device.id)).catch(
          (error: unknown) => {
            // Spotify refuses to go back from the first track of a context.
            if (error instanceof PlaybackApiError && error.status === 403)
              seek(0)
            else fail(error)
          },
        )
      schedule(FOLLOW_UP_MS)
    },
    seek,
    setVolume(value: number) {
      const volume = Math.min(1, Math.max(0, value))
      const target = state.target
      if (target.kind === 'restricted' || !canControl(target)) return
      if (target.kind === 'sonos' && target.group.volume === null) return
      if (target.kind === 'room' && state.volume === null) return
      set({ volume })
      if (target.kind === 'local') {
        localVolume = volume
        options.onLocalVolume?.(volume)
        guard(player?.setVolume(volume))
        return
      }
      if (volumeTimer) clearTimeout(volumeTimer)
      const lease = sonosLease
      volumeTimer = setTimeout(() => {
        volumeTimer = null
        if (target.kind === 'remote')
          guard(api.volume(target.device.id, volume))
        else if (holdsSonosLease(lease))
          sonosSend(groupId(target), { action: 'volume', volume })
      }, VOLUME_DEBOUNCE_MS)
    },
    async refreshDevices() {
      set({ devicesStatus: 'loading' })
      try {
        const devices = await api.devices()
        set({
          devices: devices.filter((device) => device.id !== localId),
          devicesStatus: 'idle',
        })
      } catch (error) {
        set({ devicesStatus: 'error' })
        if (playbackFailure(error).status === 'expired') fail(error)
      }
    },
    /** Moves playback to this browser or another device and controls it there. */
    async selectDevice(next: SelectableTarget) {
      if (next.kind === 'room' || state.target.kind === 'room')
        return moveTo(next)
      const playing = latest !== null && !latest.paused
      const moving = latest !== null || session !== null
      const leaving = isObserved(state.target) ? state.target : null
      if (next.kind === 'local')
        player?.activateElement().catch(() => undefined)
      set({ failure: null, rejoin: null })
      try {
        if (next.kind === 'local') {
          const id = await ensureLocal()
          if (moving)
            await sendRemote(() =>
              onDevice(true, () => api.transfer(id, playing)),
            )
          set({ target: next, volume: localVolume })
        } else {
          if (moving)
            await sendRemote(() => api.transfer(next.device.id, playing))
          set({ target: next, volume: next.device.volume })
        }
        fallback = null
        sawLocalState = false
        missing = 0
        left = null
        settlesAt = moving ? now() + TRANSFER_SETTLE_MS : 0
        if (moving) schedule(FOLLOW_UP_MS)
      } catch (error) {
        const kept =
          leaving !== null &&
          error instanceof PlaybackApiError &&
          error.status === 403
        if (!kept) return fail(error)
        // Spotify would not move the playback, so it stays on that device and
        // the chosen one takes whatever is started next.
        left = leaving
        fallback = null
        detach()
        latest = null
        sawLocalState = false
        missing = 0
        set({
          target: next,
          volume: next.kind === 'local' ? localVolume : next.device.volume,
          snapshot: null,
          current: null,
          starting: false,
        })
      }
    },
    dispose() {
      disposed = true
      stop()
      if (volumeTimer) clearTimeout(volumeTimer)
      if (rejoinTimer) clearTimeout(rejoinTimer)
      rejectWaiters(new SdkFailure('disposed'))
      listeners.clear()
      player?.disconnect()
    },
  }
}

export type PlaybackEngine = ReturnType<typeof createPlaybackEngine>
