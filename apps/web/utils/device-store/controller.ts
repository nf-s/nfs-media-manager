import type { DeviceAnswer, DeviceSeam } from './seam'
import type { DeviceStoreStatus } from './status'

/** How often a visible tab syncs (DEVICE-43). */
export const SYNC_INTERVAL_MS = 60_000
/** A device read slower than this goes to the API. */
export const READ_TIMEOUT_MS = 5_000
/** How long reads at page start wait for the copy to open before going to the API. */
export const START_WAIT_MS = 1_500
/** The first retry after a failed sync; each further failure doubles it. */
export const RETRY_BASE_MS = 2_000
export const RETRY_MAX_MS = 5 * 60_000
/** The first retry while the server still has marks to render after a write. */
export const PENDING_RETRY_MS = 500
/** Refresh waits this long for its sync before reading from the API. */
export const REFRESH_SYNC_TIMEOUT_MS = 10_000

export type SyncReason =
  | 'start'
  | 'interval'
  | 'visible'
  | 'online'
  | 'refresh'
  | 'write'
  | 'retry'

export type HostOpenResult =
  | { kind: 'opened'; ready: boolean; syncedAt: number | null }
  | { kind: 'unavailable' }
  | { kind: 'failed'; message: string }
  | { kind: 'stopped' }

export type HostReadAnswer =
  | { kind: 'served'; data: unknown }
  | { kind: 'not-served'; reason: string }
  | { kind: 'failed' }

export type HostSyncOutcome =
  | {
      outcome: 'synced'
      rowsApplied: number
      refilled: boolean
      pending: boolean
    }
  | { outcome: 'feed-not-ready' }
  | { outcome: 'unauthorized' }
  | { outcome: 'failed'; message: string }

export type HostEvents = {
  /** Another tab holds the copy; `open` resolves once this tab takes it over. */
  otherTab(): void
  /** The feed answered: this session may read the library. */
  verified(): void
  progress(progress: { phase: 'snapshot' | 'changes'; rows: number }): void
}

/** The Worker side as the controller sees it; tests give a fake. */
export interface DeviceStoreHost {
  /** Takes the store's lock, waiting while another tab holds it, then opens the copy. */
  open(events: HostEvents): Promise<HostOpenResult>
  /** Whether the API path is a read the copy can be asked for. */
  isLibraryRead(path: string): boolean
  read(path: string): Promise<HostReadAnswer>
  /** Never rejects. */
  sync(): Promise<HostSyncOutcome>
  /** Stops waiting for the lock, or deletes the copy, stops the Worker and frees the lock. */
  destroy(): Promise<void>
}

export type DeviceControllerOptions = {
  loadHost: () => Promise<DeviceStoreHost>
  publish: (status: DeviceStoreStatus) => void
  /** Refreshes mounted library reads after a sync changed rows. */
  refreshLibraryQueries: () => void
  isVisible: () => boolean
  now?: () => number
  /** When the page started; reads wait at most `START_WAIT_MS` from it. */
  startedAt?: number
}

export interface DeviceController extends DeviceSeam {
  start(): Promise<void>
  /** True once stopped, by the setting, sign-out or a 401. */
  isStopped(): boolean
  /** Stops syncing and deletes the copy (DEVICE-42, DEVICE-45). */
  stop(status?: DeviceStoreStatus): Promise<void>
  requestSync(reason: SyncReason): Promise<boolean>
  /** Refresh: sync first; if that fails, reads go to the API until a sync succeeds. */
  syncBeforeRefresh(): Promise<void>
  /** Retry after an error: sync now, or start again when the copy did not open. */
  retry(): void
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | null | undefined,
): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T) {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    void promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

/**
 * The device store in one tab: when reads may use the copy, the sync
 * schedule, writes, sign-out and the status the setting shows.
 */
export function createDeviceController(
  options: DeviceControllerOptions,
): DeviceController {
  const now = options.now ?? Date.now
  const startedAt = options.startedAt ?? now()
  let host: DeviceStoreHost | undefined
  let stopped = false
  let opened = false
  let ready = false
  let filling = false
  let verified = false
  let syncedAt: number | null = null
  let lastFailure: string | undefined
  let pendingWrites = 0
  let writeGeneration = 0
  let caughtUpGeneration = 0
  let refreshBehind = false
  let failures = 0
  let running: Promise<void> | undefined
  let again: (Deferred<boolean> & { reasons: Set<SyncReason> }) | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  const gate = deferred<void>()
  const gateTimer = setTimeout(
    () => gate.resolve(),
    Math.max(0, START_WAIT_MS - (now() - startedAt)),
  )
  let status: DeviceStoreStatus = { state: 'starting' }

  function publish(next: DeviceStoreStatus) {
    status = next
    options.publish(next)
  }

  function behind() {
    return (
      pendingWrites > 0 || caughtUpGeneration < writeGeneration || refreshBehind
    )
  }

  function serving() {
    return !stopped && opened && ready && !filling && verified && !behind()
  }

  function openGate() {
    clearTimeout(gateTimer)
    gate.resolve()
  }

  function publishReady() {
    publish(
      lastFailure === undefined
        ? { state: 'ready', syncedAt }
        : { state: 'ready', syncedAt, failed: lastFailure },
    )
  }

  function scheduleRetry(delay: number) {
    if (stopped) return
    clearTimeout(retryTimer)
    retryTimer = setTimeout(() => void requestSync('retry'), delay)
  }

  function failureDelay() {
    return Math.min(
      RETRY_BASE_MS * 2 ** Math.max(0, failures - 1),
      RETRY_MAX_MS,
    )
  }

  async function runSync(reasons: Set<SyncReason>): Promise<boolean> {
    const current = host
    if (!current || stopped || !opened) return false
    clearTimeout(retryTimer)
    const generation = writeGeneration
    const wasServing = serving()
    const outcome = await current.sync()
    if (stopped) return false
    switch (outcome.outcome) {
      case 'synced': {
        ready = true
        filling = false
        verified = true
        failures = 0
        lastFailure = undefined
        refreshBehind = false
        syncedAt = now()
        if (!outcome.pending && pendingWrites === 0)
          caughtUpGeneration = generation
        if (
          wasServing &&
          outcome.rowsApplied > 0 &&
          !outcome.refilled &&
          !reasons.has('write') &&
          !reasons.has('refresh')
        )
          options.refreshLibraryQueries()
        publishReady()
        openGate()
        if (outcome.pending && behind()) {
          failures += 1
          scheduleRetry(
            Math.min(PENDING_RETRY_MS * 2 ** (failures - 1), RETRY_MAX_MS),
          )
        }
        return true
      }
      case 'feed-not-ready':
        ready = false
        failures += 1
        publish({ state: 'waiting-for-feed' })
        openGate()
        scheduleRetry(failureDelay())
        return false
      case 'unauthorized':
        openGate()
        await stop({ state: 'signed-out' })
        return false
      case 'failed':
        failures += 1
        lastFailure = outcome.message
        filling = false
        if (ready) publishReady()
        else publish({ state: 'error', message: outcome.message })
        openGate()
        scheduleRetry(failureDelay())
        return false
    }
  }

  function startSync(reasons: Set<SyncReason>): Promise<boolean> {
    const result = runSync(reasons)
    running = result.then(() => {
      running = undefined
      const next = again
      again = undefined
      if (!next) return
      if (stopped) next.resolve(false)
      else void startSync(next.reasons).then(next.resolve)
    })
    return result
  }

  function requestSync(reason: SyncReason): Promise<boolean> {
    if (stopped || !opened) return Promise.resolve(false)
    if (running) {
      again ??= { ...deferred<boolean>(), reasons: new Set() }
      again.reasons.add(reason)
      return again.promise
    }
    return startSync(new Set([reason]))
  }

  const events: HostEvents = {
    otherTab() {
      if (stopped) return
      publish({ state: 'other-tab' })
      openGate()
    },
    verified() {
      verified = true
      openGate()
    },
    progress({ phase, rows }) {
      if (stopped) return
      if (phase === 'snapshot') {
        filling = true
        ready = false
      }
      if (filling) publish({ state: 'filling', rows })
    },
  }

  async function start() {
    publish({ state: 'starting' })
    let loaded: DeviceStoreHost
    try {
      loaded = await options.loadHost()
    } catch {
      if (!stopped) publish({ state: 'unavailable' })
      openGate()
      return
    }
    if (stopped) return
    host = loaded
    const result = await loaded.open(events)
    if (stopped) return
    switch (result.kind) {
      case 'opened':
        opened = true
        ready = result.ready
        syncedAt = result.syncedAt
        if (ready) publishReady()
        else {
          publish({ state: 'filling', rows: 0 })
          openGate()
        }
        interval = setInterval(() => {
          if (options.isVisible()) void requestSync('interval')
        }, SYNC_INTERVAL_MS)
        void requestSync('start')
        return
      case 'unavailable':
        publish({ state: 'unavailable' })
        openGate()
        return
      case 'failed':
        publish({ state: 'error', message: result.message })
        openGate()
        return
      case 'stopped':
        return
    }
  }

  async function stop(final: DeviceStoreStatus = { state: 'off' }) {
    if (stopped) return
    stopped = true
    clearTimeout(retryTimer)
    clearInterval(interval)
    openGate()
    again?.resolve(false)
    again = undefined
    const current = host
    host = undefined
    opened = false
    ready = false
    // A copy left by a failed delete serves again only after the feed accepts the session.
    await current?.destroy().catch(() => undefined)
    publish(final)
  }

  return {
    async read(path, signal): Promise<DeviceAnswer> {
      if (stopped) return undefined
      if (signal?.aborted) throw signal.reason
      await abortable(gate.promise, signal)
      const current = host
      if (!current || !serving() || !current.isLibraryRead(path))
        return undefined
      const answer = await abortable(
        withTimeout<HostReadAnswer>(current.read(path), READ_TIMEOUT_MS, {
          kind: 'failed',
        }),
        signal,
      )
      return answer.kind === 'served' && serving()
        ? { data: answer.data }
        : undefined
    },
    beginWrite() {
      pendingWrites += 1
      let settled = false
      return () => {
        if (settled) return
        settled = true
        pendingWrites -= 1
        writeGeneration += 1
        void requestSync('write')
      }
    },
    unauthorized() {
      void stop({ state: 'signed-out' })
    },
    start,
    isStopped: () => stopped,
    stop,
    requestSync,
    async syncBeforeRefresh() {
      if (stopped || !opened) return
      const synced = await withTimeout(
        requestSync('refresh'),
        REFRESH_SYNC_TIMEOUT_MS,
        false,
      )
      if (!synced && !stopped) refreshBehind = true
    },
    retry() {
      if (stopped) return
      if (opened) {
        failures = 0
        void requestSync('retry')
      } else if (status.state === 'error' && host) {
        const current = host
        void current.destroy().then(() => {
          if (stopped) return
          host = undefined
          void start()
        })
      }
    },
  }
}
