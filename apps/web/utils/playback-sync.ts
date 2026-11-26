import { z } from 'zod'
import {
  PLAYBACK_LEASE_MS,
  PlaybackReleaseInputSchema,
  PlaybackReleaseResultSchema,
  PlaybackSyncInputSchema,
  PlaybackSyncResultSchema,
  SharedSonosObservationSchema,
  type PlaybackClient,
  type PlaybackReleaseInput,
  type PlaybackSyncInput,
  type PlaybackSyncResult,
  type SavedPlayback,
  type SharedSonosObservation,
} from '@repo/schemas/playback'
import type { SonosRooms } from '@repo/schemas/sonos'
import { createPlaybackSonosRooms } from './playback-sonos-rooms'
import type { PlaybackTrace } from './playback-diagnostics'
import { fetchApiData } from './api'
import {
  positionAt,
  withVerifiedPlaybackTrack,
  type PendingPlaybackSource,
  type PlayableItem,
  type PlaybackSource,
} from './playback'
import {
  upcomingEntries,
  type PlaybackEngine,
  type PlaybackSharing,
  type PlaybackState,
  type SelectableTarget,
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
  /** Only a confirmed driver calls Sonos to fulfil room list requests. */
  readSonosRooms?: () => Promise<SonosRooms>
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

const LegacySessionErrorSchema = z.object({
  statusCode: z.literal(422),
  data: z.object({
    issues: z
      .array(
        z.object({
          code: z.literal('unrecognized_keys'),
          path: z.literal('(root)'),
        }),
      )
      .min(1),
  }),
})

export function createSessionApi(apiBaseUrl: string): SessionApi {
  let legacyServer = false
  const send = (input: PlaybackSyncInput) =>
    fetchApiData(
      apiBaseUrl,
      '/api/v1/playback/session',
      PlaybackSyncResultSchema,
      {
        method: 'POST',
        signal: AbortSignal.timeout(PLAYBACK_LEASE_MS),
        body: JSON.stringify(input),
        errorData: { status: 422, schema: LegacySessionErrorSchema.shape.data },
      },
    )
  return {
    async sync(input) {
      const validated = PlaybackSyncInputSchema.parse(input)
      if (!legacyServer) {
        try {
          return await send(validated)
        } catch (error) {
          // Older APIs reject the new fields before changing any state.
          if (
            !validated.sonosManaged ||
            !LegacySessionErrorSchema.safeParse(error).success
          )
            throw error
        }
      }
      const { clientId, clientName, revision, claim, state } = validated
      const result = await send({
        clientId,
        clientName,
        revision,
        claim,
        state,
      })
      legacyServer = result.sonosManaged === undefined
      return legacyServer ? result : { ...result, sonosManaged: false }
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
    // What was heard grows all the time, like the position.
    listen: state.listen && { ...state.listen, heardMs: 0, durationMs: 0 },
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
  let syncUnavailable = false
  /** Whether this page last ran its queue without an answer from the server. */
  let alone = false
  let busy: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  /** Whether the pending exchange was timed for something playing. */
  let paced = false
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let hasSonosLease = false
  let leaseTimer: ReturnType<typeof setTimeout> | null = null
  let observationSent: string | undefined
  let mirrored: string | undefined
  let closed = false
  let generation = 0
  engine.setSonosPolling(false)
  const rooms = createPlaybackSonosRooms(
    options.readSonosRooms ??
      (() => Promise.reject(new Error('Sonos rooms unavailable'))),
    () => {
      // A menu can open, or a room read finish, during another exchange.
      void Promise.resolve(busy).then(() => {
        if (!disposed && !closed) void exchange()
      })
    },
    now,
  )
  let shown = compose()

  function stopSonos() {
    if (leaseTimer) clearTimeout(leaseTimer)
    leaseTimer = null
    hasSonosLease = false
    engine.setSonosPolling(false)
    observationSent = undefined
    rooms.cancelRead()
  }

  function updateSonosLease(granted: boolean, requestedAt: number) {
    const remaining = requestedAt + PLAYBACK_LEASE_MS - now()
    if (!granted || remaining <= 0) {
      stopSonos()
      return
    }
    if (leaseTimer) clearTimeout(leaseTimer)
    leaseTimer = setTimeout(stopSonos, remaining)
    if (!hasSonosLease) {
      hasSonosLease = true
      engine.setSonosPolling(true)
    }
  }

  function sonosObservation(): SharedSonosObservation | null {
    const { target, snapshot, volume } = engine.getState()
    if (target.kind !== 'room' && target.kind !== 'sonos') return null
    const parsed = SharedSonosObservationSchema.safeParse({
      target,
      snapshot,
      volume,
    })
    return parsed.success ? parsed.data : null
  }

  function compose(): PlaybackState {
    const state = engine.getState()
    if (role !== 'follower') {
      const queue = stored?.queue ?? []
      const sameQueue =
        state.queue.length === queue.length &&
        state.queue.every(
          (entry, index) =>
            entry.key === queue[index]?.key &&
            entry.item.uri === queue[index]?.item.uri,
        )
      const upcoming = stored?.source
        ? upcomingEntries(stored.source.upcoming)
        : []
      const sameUpcoming =
        state.upcoming.length === upcoming.length &&
        state.upcoming.every(
          (entry, index) =>
            entry.key === upcoming[index]?.key &&
            entry.item.uri === upcoming[index]?.item.uri,
        )
      const differs =
        !sameQueue ||
        !sameUpcoming ||
        state.shuffle !== (stored?.shuffle ?? false)
      return {
        ...state,
        queueSync: differs
          ? syncUnavailable
            ? 'unconfirmed'
            : 'pending'
          : 'saved',
      }
    }
    const sharing: PlaybackSharing = {
      role: 'follower',
      driverName: driver?.name ?? null,
    }
    if (!stored) return { ...state, sharing, queueSync: 'saved' }
    const source = stored.source
    const snapshot = state.snapshot
    const session = stored.session
    const sameDevice =
      state.target.kind === 'remote' &&
      stored.target.kind === 'spotify' &&
      state.target.device.id === stored.target.device?.id
    const savedSnapshot = stored.snapshot
    return {
      ...state,
      active: true,
      current: stored.current,
      queue: stored.queue,
      upcoming: source ? upcomingEntries(source.upcoming) : [],
      source: source ? { label: source.label, href: source.href } : null,
      shuffle: stored.shuffle,
      // Until this page sees the device itself, the driver's last report.
      snapshot:
        (snapshot &&
        sameDevice &&
        savedSnapshot &&
        snapshot.trackUri === savedSnapshot.trackUri &&
        snapshot.contextUri === savedSnapshot.contextUri &&
        stored.current?.uri === session?.item.uri
          ? withVerifiedPlaybackTrack(
              snapshot,
              stored.current,
              session?.verifiedRecordingUri,
            )
          : snapshot) ??
        (stored.snapshot && stored.current
          ? { ...stored.snapshot, at: storedAt }
          : null),
      sharing,
      queueSync: 'saved',
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
    requestedAt: number,
    observationKey: string | undefined,
  ) {
    const version = generation
    if (disposed || closed) return
    syncUnavailable = false
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
    const regaining = !hasSonosLease
    const granted = role === 'driver' && result.sonosManaged === true
    if (granted && !hasSonosLease && result.sonosObservation)
      engine.followSonos(result.sonosObservation)
    updateSonosLease(granted, requestedAt)
    if (hasSonosLease) {
      mirrored = undefined
      if (observationKey !== undefined) observationSent = observationKey
    }
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
      } else if (before === 'driver') engine.release()
    } else if (
      role === 'driver' &&
      (before === 'follower' ||
        (granted &&
          regaining &&
          engine.getState().rejoin?.status === 'checking'))
    ) {
      // The driver went away: its session carries on here.
      savedAs = undefined
      if (stored) await engine.restore(stored, { claimed: command })
    } else if (role === 'follower' && before === 'driver') engine.release()
    if (disposed || closed || generation !== version) return
    if (role === 'follower') {
      const observation = result.sonosObservation ?? null
      const key = JSON.stringify(observation)
      if (mirrored !== key) {
        mirrored = key
        engine.followSonos(observation)
      }
      if (!observation && stored) engine.watchSaved(stored.target)
    }
    if (!result.sonosManaged) rooms.unavailable()
    else rooms.apply(result.sonosRooms, hasSonosLease)
    publish()
  }

  /** Spotify can run locally during a sync outage. Sonos requires a live lease. */
  async function standAlone(claim: boolean, command: boolean) {
    if (disposed || closed) return
    syncUnavailable = true
    stopSonos()
    rooms.unavailable()
    if (role !== null && !claim) {
      publish()
      return
    }
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
    if (disposed || closed) return Promise.resolve()
    if (busy)
      return busy.then(() =>
        claim && (role !== 'driver' || !hasSonosLease)
          ? exchange(true, command)
          : undefined,
      )
    const version = generation
    const sending = claim ? null : unsaved()
    const sent = sending ? { ...sending, revision } : null
    const requestedAt = now()
    const observation = hasSonosLease && !claim ? sonosObservation() : undefined
    const observationKey = JSON.stringify(observation)
    // Rebase the playing position on this heartbeat before it crosses clocks.
    const snapshot = observation?.snapshot
    const report =
      observation && snapshot && !snapshot.paused
        ? {
            ...observation,
            snapshot: {
              ...snapshot,
              at: requestedAt,
              positionMs: positionAt(snapshot, requestedAt),
            },
          }
        : observation
    const exchanged = api
      .sync({
        clientId,
        clientName,
        revision,
        claim,
        sonosManaged: true,
        sonosObservation: report,
        ...rooms.input(),
        ...(sending ? { state: sending.state } : {}),
      })
      .then(
        (result) =>
          version === generation
            ? apply(result, sent, command, requestedAt, observationKey)
            : undefined,
        () => (version === generation ? standAlone(claim, command) : undefined),
      )
      .finally(() => {
        if (version === generation) {
          busy = null
          plan()
        }
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
    if (disposed || closed) return
    paced = playing()
    // A hidden driver observing someone else's room yields to a visible page.
    const keepHidden =
      role === 'driver' &&
      paced &&
      (!onSonos() || Boolean(engine.saved()?.session))
    if (!rooms.waiting() && !visible() && !keepHidden) return
    timer = setTimeout(
      () => {
        timer = null
        void exchange()
      },
      rooms.waiting() ? 1000 : paced ? PLAYING_MS : QUIET_MS,
    )
  }

  function saveSoon() {
    if (saveTimer || role !== 'driver' || disposed || closed) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      if (
        unsaved() ||
        (hasSonosLease &&
          JSON.stringify(sonosObservation()) !== observationSent)
      )
        void exchange()
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
  function drive<A extends unknown[]>(
    command: (...args: A) => void,
    request?: (...args: A) => PlaybackTrace | undefined,
  ) {
    return (...args: A) => {
      if (disposed || closed) return
      const report = request?.(...args)
      const execute = () => {
        if (report) engine.followAttempt(report)
        command(...args)
      }
      if (role === 'driver' && (!onSonos() || hasSonosLease)) {
        execute()
        return
      }
      engine.activate(undefined, report)
      void exchange(true, true).then(() => {
        if (
          !disposed &&
          !closed &&
          role === 'driver' &&
          (!onSonos() || hasSonosLease)
        )
          execute()
        else report?.('failed', { reason: 'lease-denied' })
      })
    }
  }

  function onSonos() {
    const { target } = engine.getState()
    return target.kind === 'room' || target.kind === 'sonos'
  }

  return {
    getState: () => shown,
    activate: () => engine.activate(),
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** Joins the session: as its driver when no other page is running it. */
    start() {
      closed = false
      void exchange(options.resuming === true)
    },
    /** Asks again at once, for example when the page becomes visible. */
    refresh() {
      closed = false
      void exchange()
    },
    /**
     * The page is closing: another page can take the session over at once.
     * Returns whether this page was running the queue.
     */
    close() {
      if (closed) return false
      closed = true
      generation += 1
      busy = null
      stopSonos()
      rooms.unavailable()
      if (role !== 'driver') return false
      api.release({ clientId, revision, state: engine.saved() })
      return true
    },
    dispose() {
      disposed = true
      stopSonos()
      rooms.unavailable()
      if (timer) clearTimeout(timer)
      if (saveTimer) clearTimeout(saveTimer)
      unsubscribe()
      listeners.clear()
    },
    play: drive(
      (
        item: PlayableItem,
        definition?: PlaybackSource | PendingPlaybackSource,
      ) => engine.play(item, definition),
      (
        item: PlayableItem,
        definition?: PlaybackSource | PendingPlaybackSource,
      ) => engine.request('play', item, definition),
    ),
    enqueue(item: PlayableItem) {
      const report = engine.request('enqueue', item)
      drive(() => {
        engine.enqueue(item)
        report?.('command', {
          reason: 'queue',
          queued: engine.getState().queue.length,
        })
      })()
    },
    playFromQueue: drive(engine.playFromQueue, (key) =>
      engine.request(
        'play-queue',
        shown.queue.find((entry) => entry.key === key)?.item,
      ),
    ),
    removeFromQueue: drive(engine.removeFromQueue),
    moveInQueue: drive(engine.moveInQueue),
    clearQueue: drive(engine.clearQueue),
    playUpcoming: drive(engine.playUpcoming, (key) =>
      engine.request(
        'play-upcoming',
        shown.upcoming.find((entry) => entry.key === key)?.item,
      ),
    ),
    removeUpcoming: drive(engine.removeUpcoming),
    moveUpcoming: drive(engine.moveUpcoming),
    queueUpcoming: drive(engine.queueUpcoming),
    toggleShuffle: drive(engine.toggleShuffle),
    next: drive(engine.next, () => engine.request('next')),
    previous: drive(engine.previous, () => engine.request('previous')),
    /**
     * Spotify devices can be controlled from a follower. Sonos operations
     * and starting a queue require the playback driver.
     */
    toggle() {
      const report = engine.request('toggle')
      if (shown.starting) report?.('command', { reason: 'pending' })
      const toggle = () => {
        if (!engine.getState().starting && report) engine.followAttempt(report)
        engine.toggle()
      }
      if (onSonos() || (role !== 'driver' && !engine.getState().snapshot))
        drive(toggle)()
      else toggle()
    },
    seek(position: number) {
      if (onSonos()) drive(engine.seek)(position)
      else engine.seek(position)
    },
    setVolume(volume: number) {
      if (onSonos()) drive(engine.setVolume)(volume)
      else engine.setVolume(volume)
    },
    loadSonosRooms() {
      return closed || disposed
        ? Promise.reject(new Error('Playback is unavailable.'))
        : rooms.load()
    },
    refreshDevices: engine.refreshDevices,
    clearFailure: engine.clearFailure,
    async selectDevice(next: SelectableTarget) {
      const report = engine.request('device', undefined, undefined, next)
      if (
        role !== 'driver' ||
        ((next.kind === 'room' || onSonos()) && !hasSonosLease)
      ) {
        // Audio is unlocked inside the click, for the device about to play:
        // by the time the session has been taken over, the click is over.
        engine.activate(next, report)
        await exchange(true, true)
      }
      if (
        disposed ||
        closed ||
        role !== 'driver' ||
        ((next.kind === 'room' || onSonos()) && !hasSonosLease)
      ) {
        report?.('failed', { reason: 'lease-denied' })
        return
      }
      if (report) engine.followAttempt(report)
      await engine.selectDevice(next)
    },
  }
}

export type PlaybackSync = ReturnType<typeof createPlaybackSync>
