import {
  PlaybackReleaseInputSchema,
  PlaybackReleaseResultSchema,
  PlaybackSyncInputSchema,
  PlaybackSyncResultSchema,
  type PlaybackClient,
  type PlaybackReleaseInput,
  type PlaybackSyncInput,
  type PlaybackSyncResult,
  type SavedPlayback,
} from '@repo/schemas/playback'
import { fetchApiData } from './api'
import type { PlayableItem, PlaybackSource } from './playback'
import type {
  PlaybackEngine,
  PlaybackSharing,
  PlaybackState,
  SelectableTarget,
} from './playback-engine'

/** The server's record of the account's session. */
export type SessionApi = {
  sync(input: PlaybackSyncInput): Promise<PlaybackSyncResult>
  /** Sent as the page closes; nothing waits for its answer. */
  release(input: PlaybackReleaseInput): void
}

export type PlaybackSyncOptions = {
  engine: PlaybackEngine
  api: SessionApi
  /** Names this load of the page; two loads never share one. */
  clientId: string
  clientName: string
  /** This tab ran the queue until it was reloaded, and takes it back. */
  resuming?: boolean
  now?: () => number
  /** Whether the page is visible; a hidden page asks far less. */
  visible?: () => boolean
}

/**
 * Time between exchanges while something plays, and while nothing does. The
 * first keeps the driver's lease; the second may let it lapse, which costs
 * nothing while no queue has to be run.
 */
const PLAYING_MS = 3_000
const QUIET_MS = 8_000
/** A change is saved this soon after it is made. */
const SAVE_DELAY_MS = 400
/** While something plays, its position is saved at least this often. */
const POSITION_EVERY_MS = 10_000
/** A request sent as the page closes may not be larger than this. */
const CLOSING_BYTES = 60_000

export function createSessionApi(apiBaseUrl: string): SessionApi {
  return {
    sync(input) {
      return fetchApiData(
        apiBaseUrl,
        '/api/v1/playback/session',
        PlaybackSyncResultSchema,
        {
          method: 'POST',
          body: JSON.stringify(PlaybackSyncInputSchema.parse(input)),
        },
      )
    },
    release(input) {
      const { state, ...lease } = PlaybackReleaseInputSchema.parse(input)
      const full = JSON.stringify({ ...lease, state })
      fetchApiData(
        apiBaseUrl,
        '/api/v1/playback/session/release',
        PlaybackReleaseResultSchema,
        {
          method: 'POST',
          keepalive: true,
          // A closing page cannot send a large body; the lease is given up
          // either way and the state saved last stays.
          body: full.length <= CLOSING_BYTES ? full : JSON.stringify(lease),
        },
      ).catch(() => undefined)
    },
  }
}

/**
 * What decides whether a state has to be saved again. The playing position
 * moves all the time, so only the track and whether it is paused count.
 */
function savedKey(state: SavedPlayback | null) {
  if (!state) return 'null'
  const shown = state.snapshot
  return JSON.stringify({
    ...state,
    savedAt: 0,
    snapshot: shown && {
      trackUri: shown.trackUri,
      paused: shown.paused,
      position: shown.paused ? Math.round(shown.positionMs / 1000) : null,
    },
  })
}

/**
 * Shares one playback session between the account's open pages. One page at a
 * time, the driver, runs the engine's queue and saves it; the others show
 * that queue and the device's playback. A follower becomes the driver when a
 * queue command is used on it, or when the driver stops renewing its lease.
 */
export function createPlaybackSync(options: PlaybackSyncOptions) {
  const { engine, api, clientId, clientName } = options
  const now = options.now ?? Date.now
  const visible = options.visible ?? (() => true)
  const listeners = new Set<() => void>()
  /** Null until the server has answered once. */
  let role: PlaybackSharing['role'] | null = null
  let driver: PlaybackClient | null = null
  let revision = 0
  /** The session as the server has it, as far as this page knows. */
  let stored: SavedPlayback | null = null
  /** When `stored` was learned, to show its position without the other clock. */
  let storedAt = 0
  /** The key of the state this page saved last; undefined when it must save. */
  let savedAs: string | undefined = 'null'
  let savedAt = 0
  /** Whether this page last ran its queue without an answer from the server. */
  let alone = false
  let busy: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  /** Whether the pending exchange was timed for something playing. */
  let paced = false
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let shown = compose()

  function compose(): PlaybackState {
    const state = engine.getState()
    if (role !== 'follower') return state
    const sharing: PlaybackSharing = {
      role: 'follower',
      driverName: driver?.name ?? null,
    }
    if (!stored) return { ...state, sharing }
    const source = stored.source
    return {
      ...state,
      active: true,
      current: stored.current,
      queue: stored.queue,
      upcoming: source ? source.upcoming.map((entry) => entry.item) : [],
      source: source ? { label: source.label, href: source.href } : null,
      shuffle: stored.shuffle,
      // Until this page sees the device itself, the driver's last report.
      snapshot:
        state.snapshot ??
        (stored.snapshot && stored.current
          ? { ...stored.snapshot, at: storedAt }
          : null),
      sharing,
    }
  }

  function publish() {
    shown = compose()
    for (const listener of listeners) listener()
  }

  /** The state to save now, when it differs from what was saved last. */
  function unsaved() {
    if (role !== 'driver') return null
    const state = engine.saved()
    const key = savedKey(state)
    const playing = state?.snapshot ? !state.snapshot.paused : false
    const due = playing && now() - savedAt >= POSITION_EVERY_MS
    return key !== savedAs || due ? { state, key } : null
  }

  /**
   * `command` is set when the session was claimed to run a command here: its
   * device is then followed as the previous driver left it. Otherwise the
   * device is checked for the queue it was given, which nothing may have run
   * for hours.
   */
  async function apply(
    result: PlaybackSyncResult,
    sent: { state: SavedPlayback | null; key: string; revision: number } | null,
    command: boolean,
  ) {
    const before = role
    // What was started here while the server could not be reached replaces
    // the session the server still has.
    const keep =
      alone &&
      result.role === 'driver' &&
      result.changed &&
      engine.saved() !== null
    alone = false
    role = result.role
    driver = result.driver
    if (
      sent &&
      result.role === 'driver' &&
      !result.changed &&
      result.revision === sent.revision + 1
    ) {
      stored = sent.state
      storedAt = now()
      savedAs = sent.key
      savedAt = now()
    }
    revision = result.revision
    if (result.changed) {
      stored = result.state
      storedAt = now()
      savedAs = undefined
      if (keep) saveSoon()
      else if (role === 'driver') {
        if (stored) await engine.restore(stored, { claimed: command })
        else engine.release()
      } else {
        if (before === 'driver') engine.release()
        if (stored) engine.watchSaved(stored.target)
      }
    } else if (role === 'driver' && before === 'follower') {
      // The driver went away: its session carries on here.
      savedAs = undefined
      if (stored) await engine.restore(stored, { claimed: command })
    } else if (role === 'follower' && before !== 'follower') {
      if (before === 'driver') engine.release()
      if (stored) engine.watchSaved(stored.target)
    }
    publish()
  }

  /** Works alone when the server cannot be reached, so playback is never held up. */
  async function standAlone(claim: boolean, command: boolean) {
    if (role !== null && !claim) return
    const before = role
    alone = true
    role = 'driver'
    driver = null
    savedAs = undefined
    if (before === 'follower' && stored)
      await engine.restore(stored, { claimed: command })
    publish()
  }

  /**
   * One exchange with the server; `claim` takes the session over, and
   * `command` says that a command here is waiting for it.
   */
  function exchange(claim = false, command = false): Promise<void> {
    if (disposed) return Promise.resolve()
    if (busy)
      return busy.then(() =>
        claim && role !== 'driver' ? exchange(true, command) : undefined,
      )
    const sending = claim ? null : unsaved()
    const sent = sending ? { ...sending, revision } : null
    const exchanged = api
      .sync({
        clientId,
        clientName,
        revision,
        claim,
        ...(sending ? { state: sending.state } : {}),
      })
      .then(
        (result) => apply(result, sent, command),
        () => standAlone(claim, command),
      )
      .finally(() => {
        busy = null
        plan()
      })
    busy = exchanged
    return exchanged
  }

  function playing() {
    const { snapshot, starting } = shown
    return starting || (snapshot !== null && !snapshot.paused)
  }

  /**
   * Schedules the next exchange. A hidden page asks only while it runs a
   * queue that is playing.
   */
  function plan() {
    if (timer) clearTimeout(timer)
    timer = null
    if (disposed) return
    paced = playing()
    if (!visible() && !(role === 'driver' && paced)) return
    timer = setTimeout(
      () => {
        timer = null
        void exchange()
      },
      paced ? PLAYING_MS : QUIET_MS,
    )
  }

  function saveSoon() {
    if (saveTimer || role !== 'driver' || disposed) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      if (unsaved()) void exchange()
    }, SAVE_DELAY_MS)
  }

  const unsubscribe = engine.subscribe(() => {
    publish()
    saveSoon()
    // Playback that starts or stops changes how often the server is asked.
    if (!busy && playing() !== paced) plan()
  })

  /**
   * Runs a queue command on the driver. On a follower the session is taken
   * over first, which takes one exchange with the server and a look at the
   * device.
   */
  function drive<A extends unknown[]>(command: (...args: A) => void) {
    return (...args: A) => {
      if (role === 'driver') {
        command(...args)
        return
      }
      engine.activate()
      void exchange(true, true).then(() => {
        if (!disposed) command(...args)
      })
    }
  }

  return {
    getState: () => shown,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** Joins the session: as its driver when no other page is running it. */
    start() {
      void exchange(options.resuming === true)
    },
    /** Asks again at once, for example when the page becomes visible. */
    refresh() {
      void exchange()
    },
    /**
     * The page is closing: another page can take the session over at once.
     * Returns whether this page was running the queue.
     */
    close() {
      if (role !== 'driver') return false
      api.release({ clientId, revision, state: engine.saved() })
      return true
    },
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      if (saveTimer) clearTimeout(saveTimer)
      unsubscribe()
      listeners.clear()
    },
    play: drive((item: PlayableItem, definition?: PlaybackSource) =>
      engine.play(item, definition),
    ),
    enqueue: drive(engine.enqueue),
    playFromQueue: drive(engine.playFromQueue),
    removeFromQueue: drive(engine.removeFromQueue),
    moveInQueue: drive(engine.moveInQueue),
    clearQueue: drive(engine.clearQueue),
    toggleShuffle: drive(engine.toggleShuffle),
    next: drive(engine.next),
    previous: drive(engine.previous),
    /**
     * Pause and resume go straight to a device this page can see playing;
     * starting something needs the queue, so the session is taken over.
     */
    toggle() {
      if (role === 'driver' || engine.getState().snapshot) engine.toggle()
      else drive(engine.toggle)()
    },
    seek: engine.seek,
    setVolume: engine.setVolume,
    refreshDevices: engine.refreshDevices,
    clearFailure: engine.clearFailure,
    async selectDevice(next: SelectableTarget) {
      if (role !== 'driver') {
        engine.activate()
        await exchange(true, true)
      }
      await engine.selectDevice(next)
    },
  }
}

export type PlaybackSync = ReturnType<typeof createPlaybackSync>
