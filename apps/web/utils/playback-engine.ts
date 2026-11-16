import {
  moveEntry,
  playRequest,
  positionAt,
  startSession,
  stepSession,
  type PlayableItem,
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
  PlaybackApiError,
  type PlaybackDevice,
  type PlayerApi,
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
/** A device Spotify reports but accepts no app commands for. */
type ObservedTarget = Extract<PlaybackTarget, { kind: 'restricted' | 'sonos' }>
type RemoteState = Awaited<ReturnType<PlayerApi['state']>>

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
  /** The next source tracks, after the manual queue. */
  upcoming: PlayableItem[]
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
}

const LOCAL_POLL_MS = 1_000
const REMOTE_POLL_MS = 3_000
const IDLE_POLL_MS = 5_000
const FOLLOW_UP_MS = 700
const TRANSFER_SETTLE_MS = 5_000
const READY_TIMEOUT_MS = 15_000
const START_TIMEOUT_MS = 15_000
const DEVICE_RETRY_MS = 700
const DEVICE_RETRIES = 2
const VOLUME_DEBOUNCE_MS = 250
const RESTART_AFTER_MS = 3_000
const MISSING_STATES = 3
/** How long a start waits for the tracks that follow, so they go with it. */
const FOLLOWING_WAIT_MS = 500
const FOLLOWING_LIMIT = 50
/** A track that began this recently after the last one ended is its successor. */
const SUCCESSOR_WITHIN_MS = 5_000
const SONOS_TRIES = 3
const SONOS_RETRY_MS = 2_000
const ROOM_IDLE_POLL_MS = 10_000
/** Tracks kept in a Sonos group's queue after the current one. */
const ROOM_AHEAD = 20
const ROOM_CHUNK = 10
const ROOM_VOLUME_EVERY = 5
/** How long the group's queue is left alone after Sonos refused a change to it. */
const ROOM_RETRY_MS = 15_000
const LOCAL: Extract<PlaybackTarget, { kind: 'local' }> = { kind: 'local' }
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
  definition: PlaybackSource
  tracks: Map<number, Promise<PlayableItem[]>>
  remaining: number[]
  played: Set<string>
  skipped: Set<string>
  exhausted: Set<number>
  upcoming: SourceTrack[]
  history: SourceTrack[]
  initializing: boolean
  revision: number
  filling: Promise<void> | null
  /** Random picks drawn ahead for a shuffled fill: the entry, then the track in it. */
  draws: Array<{ entry: number; track: number }>
}

/** Source tracks resolved ahead: shown as upcoming and sent to Spotify with a track. */
const SOURCE_AHEAD_SIZE = 30
const SOURCE_CACHE_SIZE = 20
/** Source entries of a shuffled list loaded at the same time. */
const SOURCE_PARALLEL = 6

function sourceTrackKey(index: number, position: number) {
  return `${index}:${position}`
}

function isObserved(target: PlaybackTarget): target is ObservedTarget {
  return target.kind === 'restricted' || target.kind === 'sonos'
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
    artworkUrl: track.artworkUrl,
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
  let sawLocalState = false
  let missing = 0
  let pollErrors = 0
  let run = 0
  let sequence = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let volumeTimer: ReturnType<typeof setTimeout> | null = null
  let ticking = false
  let disposed = false
  let watching = false
  /** Something was played or queued here, so the player stays once playback stops. */
  let used = false
  /** The target to return to when a device playback was followed to goes quiet. */
  let fallback: Exclude<SelectableTarget, RoomTarget> | null = null
  /** Until then Spotify may still report the device playback was moved from. */
  let settlesAt = 0
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

  function set(patch: Partial<PlaybackState>) {
    if (disposed) return
    const before = state.target
    state = { ...state, ...patch }
    if (patch.target && !sameDevice(before, patch.target))
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

  function detach() {
    session = null
    skippedAt = null
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

  /** Browsers only allow audio that a user gesture unlocked. */
  function activate() {
    if (state.target.kind === 'local')
      player?.activateElement().catch(() => undefined)
  }

  /** Spotify can take a moment to list a device that has just registered. */
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

  /** The tracks due after the current one, while no album comes between. */
  function planned(): Planned[] {
    const tracks: Planned[] = []
    for (const entry of state.queue) {
      if (entry.item.kind !== 'track') return tracks
      tracks.push({ from: 'queue', item: entry.item, entry })
    }
    for (const entry of source?.upcoming ?? []) {
      if (entry.item.kind !== 'track') break
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
    const loading: Promise<PlayableItem[]> = active.definition
      .load(index)
      .catch((error: unknown) => {
        if (active.tracks.get(index) === loading) active.tracks.delete(index)
        throw error
      })
    active.tracks.set(index, loading)
    if (active.tracks.size > SOURCE_CACHE_SIZE) {
      const oldest = active.tracks.keys().next().value
      if (oldest !== undefined) active.tracks.delete(oldest)
    }
    return loading
  }

  /** Builds only the small preview; source pages are retained by their loader. */
  function fillSource(active: SourceSession): Promise<void> {
    if (active.filling) return active.filling
    const revision = active.revision
    const shuffled = state.shuffle
    const upcoming = [...active.upcoming]
    set({ sourceLoading: true })
    const filling = (async () => {
      const used = new Set([...active.played, ...active.skipped])
      for (const entry of upcoming)
        used.add(sourceTrackKey(entry.index, entry.position))
      let candidates = [...active.remaining]
      while (upcoming.length < SOURCE_AHEAD_SIZE && candidates.length) {
        // Shuffled entries are spread over the source, so the next few are
        // loaded together instead of one request after another.
        while (shuffled && active.draws.length < SOURCE_PARALLEL)
          active.draws.push({ entry: random(), track: random() })
        const pick = (draw: number) =>
          candidates[shuffled ? Math.floor(draw * candidates.length) : 0]
        for (const draw of active.draws) {
          const ahead = pick(draw.entry)
          if (ahead !== undefined)
            loadSourceEntry(active, ahead).catch(() => undefined)
        }
        const draw = active.draws.shift()
        const index = pick(draw?.entry ?? 0)
        if (index === undefined) break
        const tracks = await loadSourceEntry(active, index)
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
      if (source !== active || revision !== active.revision || disposed) return
      active.upcoming = upcoming
      set({ upcoming: upcoming.map((entry) => entry.item) })
    })()
      .catch((error: unknown) => {
        if (source === active && revision === active.revision && !disposed) {
          // A failed later page must not hold back tracks already resolved.
          active.upcoming = upcoming
          set({ upcoming: upcoming.map((entry) => entry.item) })
          throw error
        }
      })
      .finally(() => {
        if (source === active && revision === active.revision) {
          active.filling = null
          set({ sourceLoading: false })
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
    set({ upcoming: active.upcoming.map((next) => next.item) })
    previewSource(active)
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
    if (!active || (!active.remaining.length && !active.upcoming.length))
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

  async function startSource(item: PlayableItem, definition: PlaybackSource) {
    const active: SourceSession = {
      definition: { ...definition },
      tracks: new Map(),
      remaining: Array.from(
        { length: Math.max(0, definition.length - definition.startIndex) },
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
          { length: captured.length },
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
    roomBusy += 1
    const sent = roomWork.then(() =>
      sonos.load(room.id, { ...input, household: room.household }),
    )
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
      target.kind !== 'room' ||
      !active ||
      active.item.kind !== 'track' ||
      roomBusy > 0 ||
      now() < roomRetryAt
    )
      return
    const plan = planned().map((next) => next.item)
    const tail = active.sent.slice(active.index + 1)
    const head = plan[0]
    const agrees = tail.every((item, at) => plan[at]?.uri === item.uri)
    let mode: 'append' | 'next' = 'append'
    const added: PlayableItem[] = []
    if (agrees) {
      const queued = new Set(
        active.sent.slice(active.index).map((item) => item.uri),
      )
      for (const item of plan.slice(tail.length)) {
        if (
          queued.has(item.uri) ||
          tail.length + added.length >= ROOM_AHEAD ||
          added.length >= ROOM_CHUNK
        )
          break
        queued.add(item.uri)
        added.push(item)
      }
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

  /**
   * Starts an item; `ahead` is a short wait for the tracks that follow it and
   * `from` is where in its first track to start.
   */
  async function start(item: PlayableItem, ahead?: Promise<void>, from = 0) {
    let target = state.target
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
    session = startSession(item, now())
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
    })
    try {
      if (target.kind === 'room') {
        roomRun += 1
        roomRetryAt = 0
        const skip =
          item.kind === 'album' && item.startUri
            ? await api.albumTrackIndex(item.uri, item.startUri)
            : 0
        if (started !== run || disposed) return
        await roomSend(target.room, {
          mode: 'replace',
          uris: [item.uri],
          play: true,
          ...(skip > 0 ? { skip } : {}),
          ...(from > 0 ? { positionMs: Math.round(from) } : {}),
        })
        if (started !== run) return
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
      await onDevice(target.kind === 'local', () =>
        api.play(deviceId, playRequest(item, following, from)),
      )
      if (started !== run) return
      schedule(FOLLOW_UP_MS)
    } catch (error) {
      if (started !== run) return
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
    const playing = (item: PlayableItem) =>
      item.uri === after.trackUri || item.uri === after.linkedFromUri
    let index = active.sent.findIndex(
      (item, at) => at > active.index && playing(item),
    )
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
      index = active.sent.findIndex(
        (item, at) => at < active.index && playing(item),
      )
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

  function observe(after: PlaybackSnapshot) {
    const before = latest
    latest = after
    if (session) {
      const starting = session.phase === 'starting'
      const step = stepSession(session, before, after, skippedAt)
      session = step.session
      const moved =
        step.event === 'none' || starting ? null : advanced(after, step.event)
      if (moved === 'restarted') return
      if (moved === 'followed') {
        publish(after)
        findSonos()
        return
      }
      if (step.event === 'finished' && continueQueue()) return
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
    if (!sonos || !isObserved(target)) {
      sonosTries = 0
      if (state.findingSonos) set({ findingSonos: false })
      return
    }
    if (!track) return
    const key = `${target.name}\n${target.type}\n${track}`
    if (key === sonosChecked || now() < sonosRetryAt) return
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
        if (disposed || !isObserved(current) || !sameDevice(current, target))
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
        if (!disposed) set({ findingSonos: false })
      },
    )
  }

  function groupId(
    target: Extract<PlaybackTarget, { kind: 'sonos' | 'room' }>,
  ) {
    return target.kind === 'room' ? target.room.id : target.group.id
  }

  function sonosSend(groupId: string, command: SonosCommand) {
    options.sonos?.command(groupId, command).catch((error: unknown) => {
      // The group may have changed; look it up again with the next report.
      sonosChecked = null
      fail(error)
    })
  }

  /** Reads what a Sonos group plays and keeps its queue supplied. */
  async function pollRoom(target: RoomTarget) {
    const sonos = options.sonos
    if (!sonos) return
    roomPolls += 1
    const reported = await sonos.state(
      target.room.id,
      roomPolls % ROOM_VOLUME_EVERY === 1,
    )
    pollErrors = 0
    if (!sameDevice(state.target, target) || disposed) return
    if (
      reported.volume !== undefined &&
      !volumeTimer &&
      reported.volume !== state.volume
    )
      set({ volume: reported.volume })
    const snapshot = roomSnapshot(reported, now())
    if (!snapshot) {
      missing += 1
      if (missing === MISSING_STATES && (session || latest)) playbackStopped()
      return
    }
    missing = 0
    observe(snapshot)
    maintainRoom()
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

  /** The device no longer reports playback. */
  function playbackStopped() {
    if (sourceStarting) return
    const ended =
      session?.phase === 'playing' &&
      latest !== null &&
      !latest.paused &&
      latest.durationMs > 0 &&
      positionAt(latest, now()) >= latest.durationMs
    // A device can go quiet instead of resetting when its last track runs out.
    if (ended && continueQueue()) return
    detach()
    latest = null
    const restored = fallback ?? (isObserved(state.target) ? LOCAL : null)
    fallback = null
    if (restored?.kind === 'local') sawLocalState = false
    set({
      active: used || state.queue.length > 0,
      snapshot: null,
      current: null,
      starting: false,
      ...(restored
        ? {
            target: restored,
            volume:
              restored.kind === 'local' ? localVolume : restored.device.volume,
          }
        : {}),
    })
  }

  /**
   * Follows playback on a device that was not chosen here. The earlier target
   * comes back once that device goes quiet.
   */
  function follow(target: FollowedTarget, snapshot: PlaybackSnapshot) {
    if (state.target.kind === 'local' || state.target.kind === 'remote')
      fallback ??= state.target
    missing = 0
    set({ target, volume: targetVolume(target) })
    observe(snapshot)
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
      if (playbackFailure(error).status === 'expired') fail(error)
      return null
    })
    if (!remote || session || latest || disposed) return
    const found = reported(remote)
    if (
      found &&
      found.kind !== 'local' &&
      remote.snapshot &&
      !remote.snapshot.paused
    )
      follow(found, remote.snapshot)
  }

  function shouldPoll() {
    if (state.failure?.status === 'expired') return false
    if (session) return true
    return latest !== null && !latest.paused && visible()
  }

  /** Time to the next check: frequent while following playback, occasional while watching for it. */
  function pollDelay(): number | null {
    if (shouldPoll())
      return state.target.kind === 'local' ? LOCAL_POLL_MS : REMOTE_POLL_MS
    const idle = watching && visible() && state.failure?.status !== 'expired'
    if (!idle) return null
    return state.target.kind === 'room' ? ROOM_IDLE_POLL_MS : IDLE_POLL_MS
  }

  async function tick() {
    if (ticking || disposed) return
    ticking = true
    try {
      const target = state.target
      if (target.kind === 'room') {
        if (session || latest || (watching && visible())) await pollRoom(target)
      } else if (!session && !latest) {
        if (watching && visible()) await findPlayback()
      } else if (target.kind === 'local') {
        const found = player
          ? observeLocal(await player.getCurrentState())
          : false
        if (!found && sawLocalState) {
          missing += 1
          // A paused browser player that lost its playback has usually handed
          // it to another device.
          const handedOver = watching && !session && latest?.paused === true
          if (missing === MISSING_STATES || handedOver) await followElsewhere()
          else await lookElsewhere()
        }
      } else {
        const remote = await api.state()
        pollErrors = 0
        if (state.target === target) {
          if (remote.snapshot) {
            missing = 0
            retarget(target, remote)
            observe(remote.snapshot)
          } else {
            missing += 1
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
    if (!latest || target.kind === 'restricted') return
    if (target.kind === 'sonos' && !target.group.actions.seek) return
    const position = Math.max(0, Math.min(positionMs, latest.durationMs))
    set({ failure: null })
    expect({ positionMs: position })
    if (target.kind === 'local') guard(player?.seek(position))
    else if (target.kind === 'remote')
      guard(api.seek(target.device.id, position))
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
      api.pause(target.device.id).catch(ignored)
    else if (target.kind !== 'restricted')
      options.sonos
        ?.command(groupId(target), { action: 'pause' })
        .catch(ignored)
  }

  /**
   * Moves playback to or from a Sonos group. Spotify cannot move a session
   * there, so what is playing is started again on the chosen device at the
   * same position and paused where it was.
   */
  function moveTo(next: SelectableTarget) {
    const from = state.target
    if (sameDevice(from, next)) return
    if (next.kind === 'local') player?.activateElement().catch(() => undefined)
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
      volume:
        next.kind === 'local'
          ? localVolume
          : next.kind === 'remote'
            ? next.device.volume
            : null,
      snapshot: null,
      current: item,
      starting: false,
      failure: null,
      findingSonos: false,
    })
    if (item) void start(item, undefined, position)
    else schedule(0)
  }

  return {
    getState: () => state,
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
    clearFailure() {
      if (state.failure) set({ failure: null })
    },
    play(item: PlayableItem, definition?: PlaybackSource) {
      if (refused()) return
      activate()
      if (definition) void startSource(item, definition)
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
      if (shuffle) active.skipped.clear()
      active.revision += 1
      active.filling = null
      active.upcoming = []
      active.remaining = shuffle
        ? Array.from(
            { length: active.definition.length },
            (_, index) => index,
          ).filter((index) => !active.exhausted.has(index))
        : [...active.remaining].sort((a, b) => a - b)
      set({ shuffle, upcoming: [] })
      if (!active.initializing) previewSource(active)
    },
    enqueue(item: PlayableItem) {
      sequence += 1
      used = true
      set({
        active: true,
        queue: [...state.queue, { key: `queue-${sequence}`, item }],
        announcement: `Added to queue: ${item.title}`,
      })
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
    },
    moveInQueue(from: number, to: number) {
      const entry = state.queue[from]
      if (!entry || to < 0 || to >= state.queue.length || from === to) return
      set({
        queue: moveEntry(state.queue, from, to),
        announcement: `${entry.item.title}: position ${to + 1} of ${state.queue.length}`,
      })
    },
    clearQueue() {
      if (state.queue.length) set({ queue: [], announcement: 'Queue cleared' })
    },
    toggle() {
      if (session?.phase === 'starting' || sourceStarting) return
      activate()
      if (currentFromSource && source?.initializing && state.current) {
        void startSource(state.current, source.definition)
        return
      }
      if (!latest) {
        // Nothing is loaded on the device: retry the item, or start the queue.
        if (refused()) return
        if (state.current) void start(state.current)
        else startNext()
        return
      }
      const target = state.target
      if (target.kind === 'restricted') return
      set({ failure: null })
      if (target.kind === 'local') guard(player?.togglePlay())
      else {
        const paused = latest.paused
        expect({ paused: !paused })
        if (target.kind === 'remote')
          guard(
            paused ? api.resume(target.device.id) : api.pause(target.device.id),
          )
        else sonosSend(groupId(target), { action: paused ? 'play' : 'pause' })
      }
      schedule(FOLLOW_UP_MS)
    },
    next() {
      const target = state.target
      // A Sonos group skips to the next track in its queue when that is the
      // track due; otherwise the track due is started on it.
      const queued =
        session?.phase === 'playing' && session.item.kind === 'track'
          ? session.sent[session.index + 1]
          : undefined
      const due = state.queue[0]?.item ?? source?.upcoming[0]?.item
      const inStep = queued !== undefined && queued.uri === due?.uri
      const skip = (group: string) => {
        skippedAt = now()
        set({ failure: null })
        sonosSend(group, { action: 'next' })
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
        if (latest) skip(groupId(target))
        return
      }
      if (itemEnds && startNext()) return
      if (!latest) return
      skippedAt = now()
      set({ failure: null })
      if (target.kind === 'local') guard(player?.nextTrack())
      else guard(api.next(target.device.id))
      schedule(FOLLOW_UP_MS)
    },
    previous() {
      const target = state.target
      if (!latest || target.kind === 'restricted') return
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
          set({ upcoming: source.upcoming.map((entry) => entry.item) })
          void start(previous.item)
          previewSource(source)
          return
        }
      }
      set({ failure: null })
      if (target.kind === 'local') guard(player?.previousTrack())
      else if (target.kind === 'room')
        // The group's queue has nothing before the track it started with.
        options.sonos
          ?.command(target.room.id, { action: 'previous' })
          .catch(() => seek(0))
      else
        api.previous(target.device.id).catch((error: unknown) => {
          // Spotify refuses to go back from the first track of a context.
          if (error instanceof PlaybackApiError && error.status === 403) seek(0)
          else fail(error)
        })
      schedule(FOLLOW_UP_MS)
    },
    seek,
    setVolume(value: number) {
      const volume = Math.min(1, Math.max(0, value))
      const target = state.target
      if (target.kind === 'restricted') return
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
      volumeTimer = setTimeout(() => {
        volumeTimer = null
        if (target.kind === 'remote')
          guard(api.volume(target.device.id, volume))
        else sonosSend(groupId(target), { action: 'volume', volume })
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
      set({ failure: null })
      try {
        if (next.kind === 'local') {
          const id = await ensureLocal()
          if (moving) await onDevice(true, () => api.transfer(id, playing))
          set({ target: next, volume: localVolume })
        } else {
          if (moving) await api.transfer(next.device.id, playing)
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
      rejectWaiters(new SdkFailure('disposed'))
      listeners.clear()
      player?.disconnect()
    },
  }
}

export type PlaybackEngine = ReturnType<typeof createPlaybackEngine>
