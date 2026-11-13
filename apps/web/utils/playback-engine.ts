import {
  moveEntry,
  playRequest,
  positionAt,
  startSession,
  stepSession,
  type PlayableItem,
  type PlaybackSession,
  type PlaybackSnapshot,
  type QueueEntry,
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

export type PlaybackTarget =
  | { kind: 'local' }
  | { kind: 'remote'; device: PlaybackDevice }

export type PlaybackState = {
  /** Something has been played or queued, so the player is shown. */
  active: boolean
  /** The queue item this app started and is following. */
  current: PlayableItem | null
  /** What the target device is playing. */
  snapshot: PlaybackSnapshot | null
  queue: QueueEntry[]
  target: PlaybackTarget
  /** Other Spotify devices; this browser is not listed. */
  devices: PlaybackDevice[]
  devicesStatus: 'idle' | 'loading' | 'error'
  /** 0 to 1, or null when the target device has no adjustable volume. */
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
  target: { kind: 'local' },
  devices: [],
  devicesStatus: 'idle',
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
  now?: () => number
  /** Whether the page is visible; idle remote polling stops while hidden. */
  visible?: () => boolean
}

const LOCAL_POLL_MS = 1_000
const REMOTE_POLL_MS = 5_000
const FOLLOW_UP_MS = 700
const READY_TIMEOUT_MS = 15_000
const START_TIMEOUT_MS = 15_000
const DEVICE_RETRY_MS = 700
const DEVICE_RETRIES = 2
const VOLUME_DEBOUNCE_MS = 250
const RESTART_AFTER_MS = 3_000
const MISSING_STATES = 3
const NOT_STARTED: PlaybackFailure = {
  status: 'error',
  message: 'Playback did not start. Try again or choose a device.',
}

type Waiter = { resolve: (id: string) => void; reject: (error: Error) => void }

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

/**
 * Plays queue items one at a time on this browser or another Spotify device,
 * and follows the device's playback to know when to start the next item.
 */
export function createPlaybackEngine(options: PlaybackEngineOptions) {
  const now = options.now ?? Date.now
  const visible = options.visible ?? (() => true)
  const { api } = options
  const listeners = new Set<() => void>()
  const waiters = new Set<Waiter>()
  let state: PlaybackState = {
    ...idlePlaybackState,
    volume: options.initialVolume,
  }
  let player: SpotifySdkPlayer | null = null
  let loading: Promise<SpotifySdkPlayer> | null = null
  let connected = false
  let localId: string | null = null
  let localVolume = options.initialVolume
  let session: PlaybackSession | null = null
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

  function set(patch: Partial<PlaybackState>) {
    if (disposed) return
    state = { ...state, ...patch }
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
          if (state.target.kind === 'local') observeLocal(payload)
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

  async function start(item: PlayableItem) {
    run += 1
    const started = run
    session = startSession(item, now())
    latest = null
    skippedAt = null
    sawLocalState = false
    missing = 0
    set({
      active: true,
      current: item,
      snapshot: null,
      starting: true,
      failure: null,
    })
    try {
      const target = state.target
      const deviceId =
        target.kind === 'local' ? await ensureLocal() : target.device.id
      if (started !== run || disposed) return
      await onDevice(target.kind === 'local', () =>
        api.play(deviceId, playRequest(item)),
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
    if (!next) return false
    set({ queue: rest })
    void start(next.item)
    return true
  }

  function publish(after: PlaybackSnapshot) {
    // Until the requested item starts, the device still reports what it was
    // playing before.
    if (session?.phase === 'starting') return
    if (sameShown(state.snapshot, after) && !state.starting) return
    set({ snapshot: after, starting: false })
  }

  function observe(after: PlaybackSnapshot) {
    const before = latest
    latest = after
    if (session) {
      const starting = session.phase === 'starting'
      const step = stepSession(session, before, after, skippedAt)
      session = step.session
      if (step.event === 'finished' && startNext()) return
      if (step.event !== 'none') {
        // The item ended with nothing queued, or other playback replaced it.
        detach()
        set({
          current: null,
          failure: starting ? NOT_STARTED : state.failure,
        })
      }
    }
    publish(after)
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
    const ended =
      session?.phase === 'playing' &&
      latest !== null &&
      !latest.paused &&
      latest.durationMs > 0 &&
      positionAt(latest, now()) >= latest.durationMs
    // A device can go quiet instead of resetting when its last track runs out.
    if (ended && startNext()) return
    detach()
    latest = null
    set({ snapshot: null, current: null, starting: false })
  }

  /** This browser stopped reporting playback; it may have moved to another device. */
  async function followElsewhere() {
    try {
      const remote = await api.state()
      if (state.target.kind !== 'local') return
      if (remote.device && remote.snapshot && remote.device.id !== localId) {
        set({
          target: { kind: 'remote', device: remote.device },
          volume: remote.device.volume,
        })
        observe(remote.snapshot)
      } else playbackStopped()
    } catch (error) {
      playbackStopped()
      if (playbackFailure(error).status === 'expired') fail(error)
    }
  }

  function shouldPoll() {
    if (state.failure?.status === 'expired') return false
    if (session) return true
    return latest !== null && !latest.paused && visible()
  }

  async function tick() {
    if (ticking || disposed) return
    ticking = true
    try {
      const target = state.target
      if (target.kind === 'local') {
        const found = player
          ? observeLocal(await player.getCurrentState())
          : false
        if (!found && sawLocalState) {
          missing += 1
          if (missing === MISSING_STATES) await followElsewhere()
        }
      } else {
        const remote = await api.state()
        pollErrors = 0
        if (state.target === target) {
          if (remote.snapshot) {
            missing = 0
            const device = remote.device
            if (
              device?.id === target.device.id &&
              !volumeTimer &&
              (device.volume !== target.device.volume ||
                device.name !== target.device.name)
            )
              set({ target: { kind: 'remote', device }, volume: device.volume })
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
        playbackStopped()
        fail(error)
      }
    } finally {
      ticking = false
    }
    if (!timer && shouldPoll())
      schedule(state.target.kind === 'local' ? LOCAL_POLL_MS : REMOTE_POLL_MS)
  }

  /** Shows the expected result of a command before the device confirms it. */
  function expect(patch: Partial<PlaybackSnapshot>) {
    if (!latest) return
    const at = now()
    latest = { ...latest, positionMs: positionAt(latest, at), at, ...patch }
    if (session?.phase !== 'starting') set({ snapshot: latest })
  }

  function seek(positionMs: number) {
    if (!latest) return
    const target = state.target
    const position = Math.max(0, Math.min(positionMs, latest.durationMs))
    set({ failure: null })
    expect({ positionMs: position })
    if (target.kind === 'local') guard(player?.seek(position))
    else guard(api.seek(target.device.id, position))
    schedule(FOLLOW_UP_MS)
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
    /** Checks playback again, for example when the page becomes visible. */
    refresh() {
      if (!timer && shouldPoll()) schedule(0)
    },
    clearFailure() {
      if (state.failure) set({ failure: null })
    },
    play(item: PlayableItem) {
      activate()
      void start(item)
    },
    enqueue(item: PlayableItem) {
      sequence += 1
      set({
        active: true,
        queue: [...state.queue, { key: `queue-${sequence}`, item }],
        announcement: `Added to queue: ${item.title}`,
      })
    },
    playFromQueue(key: string) {
      const entry = state.queue.find((candidate) => candidate.key === key)
      if (!entry) return
      activate()
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
      if (session?.phase === 'starting') return
      activate()
      if (!latest) {
        // Nothing is loaded on the device: retry the item, or start the queue.
        if (state.current) void start(state.current)
        else startNext()
        return
      }
      const target = state.target
      set({ failure: null })
      if (target.kind === 'local') guard(player?.togglePlay())
      else {
        const paused = latest.paused
        expect({ paused: !paused })
        guard(
          paused ? api.resume(target.device.id) : api.pause(target.device.id),
        )
      }
      schedule(FOLLOW_UP_MS)
    },
    next() {
      const itemEnds =
        !session ||
        session.phase === 'starting' ||
        session.item.kind === 'track' ||
        latest?.hasNext === false
      activate()
      if (itemEnds && startNext()) return
      if (!latest) return
      const target = state.target
      skippedAt = now()
      set({ failure: null })
      if (target.kind === 'local') guard(player?.nextTrack())
      else guard(api.next(target.device.id))
      schedule(FOLLOW_UP_MS)
    },
    previous() {
      if (!latest) return
      const target = state.target
      if (positionAt(latest, now()) > RESTART_AFTER_MS) return seek(0)
      set({ failure: null })
      if (target.kind === 'local') guard(player?.previousTrack())
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
        guard(api.volume(target.device.id, volume))
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
    async selectDevice(next: PlaybackTarget) {
      const playing = latest !== null && !latest.paused
      const moving = latest !== null || session !== null
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
        sawLocalState = false
        missing = 0
        if (moving) schedule(FOLLOW_UP_MS)
      } catch (error) {
        fail(error)
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
