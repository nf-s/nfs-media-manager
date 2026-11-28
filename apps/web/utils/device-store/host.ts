import { resolveLibraryRead } from '@repo/library-source/resolve'
import type {
  DeviceStoreHost,
  HostEvents,
  HostOpenResult,
  HostReadAnswer,
  HostSyncOutcome,
} from './controller'
import {
  STORE_DIRECTORY,
  STORE_LOCK,
  WorkerMessageSchema,
  type HostMessage,
} from './protocol'

/**
 * The tab's side of the store's Worker, loaded only while the setting is
 * on. One tab at a time holds the store's Web Lock and runs the Worker,
 * because only one Worker can hold the OPFS pool's access handles; another
 * tab waits for the lock and reads from the API meanwhile (DEVICE-41).
 */

const DESTROY_TIMEOUT_MS = 3_000
/** The pool's files close a moment after its Worker stops. */
const REMOVE_RETRY_MS = [100, 250, 500, 1_000]

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function supportsDeviceStore() {
  return (
    typeof Worker === 'function' &&
    typeof WebAssembly === 'object' &&
    typeof navigator.locks?.request === 'function' &&
    typeof navigator.storage?.getDirectory === 'function'
  )
}

/** Deletes the pool's directory, the copy and the pool's spare files with it. */
async function removeStoreDirectory() {
  const root = await navigator.storage.getDirectory()
  for (const delay of [0, ...REMOVE_RETRY_MS]) {
    if (delay > 0) await wait(delay)
    try {
      await root.removeEntry(STORE_DIRECTORY, { recursive: true })
      return
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError')
        return
    }
  }
}

function take<Value>(map: Map<number, Value>, id: number): Value | undefined {
  const value = map.get(id)
  map.delete(id)
  return value
}

export function createWorkerHost(apiBaseUrl: string): DeviceStoreHost {
  const waiting = new AbortController()
  const reads = new Map<number, (answer: HostReadAnswer) => void>()
  const syncs = new Map<number, (outcome: HostSyncOutcome) => void>()
  const destroys = new Map<number, () => void>()
  let worker: Worker | undefined
  let release: (() => void) | undefined
  let opening: ((result: HostOpenResult) => void) | undefined
  let events: HostEvents | undefined
  let nextId = 0

  function post(target: Worker, message: HostMessage) {
    target.postMessage(message)
  }

  function failPending(message: string) {
    for (const resolve of reads.values()) resolve({ kind: 'failed' })
    reads.clear()
    for (const resolve of syncs.values())
      resolve({ outcome: 'failed', message })
    syncs.clear()
    for (const resolve of destroys.values()) resolve()
    destroys.clear()
    opening?.({ kind: 'failed', message })
    opening = undefined
  }

  function onMessage(event: MessageEvent<unknown>) {
    const parsed = WorkerMessageSchema.safeParse(event.data)
    if (!parsed.success) return
    const message = parsed.data
    switch (message.type) {
      case 'opened':
        opening?.({
          kind: 'opened',
          ready: message.ready,
          syncedAt: message.syncedAt,
        })
        opening = undefined
        return
      case 'open-failed':
        opening?.(
          message.unavailable
            ? { kind: 'unavailable' }
            : { kind: 'failed', message: message.message },
        )
        opening = undefined
        return
      case 'read':
        take(
          reads,
          message.id,
        )?.(
          message.result.served
            ? { kind: 'served', data: message.result.data }
            : { kind: 'not-served', reason: message.result.reason },
        )
        return
      case 'read-failed':
        take(reads, message.id)?.({ kind: 'failed' })
        return
      case 'verified':
        events?.verified()
        return
      case 'progress':
        events?.progress({ phase: message.phase, rows: message.rows })
        return
      case 'synced':
        take(syncs, message.id)?.(message.result)
        return
      case 'destroyed':
        take(destroys, message.id)?.()
        return
    }
  }

  /** Resolves once the lock is granted, or false when `ifAvailable` and another tab holds it. */
  function holdLock(ifAvailable: boolean) {
    return new Promise<boolean>((resolve, reject) => {
      navigator.locks
        .request(
          STORE_LOCK,
          ifAvailable ? { ifAvailable: true } : { signal: waiting.signal },
          (lock) => {
            if (!lock) {
              resolve(false)
              return undefined
            }
            resolve(true)
            return new Promise<void>((done) => {
              release = done
            })
          },
        )
        .catch(reject)
    })
  }

  function freeLock() {
    release?.()
    release = undefined
  }

  return {
    async open(handlers) {
      events = handlers
      if (!supportsDeviceStore()) return { kind: 'unavailable' }
      try {
        if (!(await holdLock(true))) {
          handlers.otherTab()
          await holdLock(false)
        }
      } catch {
        return { kind: 'stopped' }
      }
      if (waiting.signal.aborted) {
        freeLock()
        return { kind: 'stopped' }
      }
      let started: Worker
      try {
        started = new Worker(new URL('./worker.ts', import.meta.url), {
          name: 'device-store',
        })
      } catch {
        freeLock()
        return { kind: 'unavailable' }
      }
      worker = started
      started.addEventListener('message', onMessage)
      started.addEventListener('error', () =>
        failPending('The store Worker stopped.'),
      )
      const result = new Promise<HostOpenResult>((resolve) => {
        opening = resolve
      })
      post(started, { type: 'open', apiBaseUrl })
      return result
    },
    isLibraryRead(path) {
      return resolveLibraryRead(path) !== undefined
    },
    read(path) {
      const current = worker
      if (!current) return Promise.resolve({ kind: 'failed' })
      const id = nextId++
      return new Promise((resolve) => {
        reads.set(id, resolve)
        post(current, { type: 'read', id, path })
      })
    },
    sync() {
      const current = worker
      if (!current)
        return Promise.resolve({
          outcome: 'failed',
          message: 'The copy is not open.',
        })
      const id = nextId++
      return new Promise((resolve) => {
        syncs.set(id, resolve)
        post(current, { type: 'sync', id })
      })
    },
    async destroy() {
      waiting.abort()
      const current = worker
      worker = undefined
      if (current) {
        const id = nextId++
        await Promise.race([
          new Promise<void>((resolve) => {
            destroys.set(id, resolve)
            post(current, { type: 'destroy', id })
          }),
          wait(DESTROY_TIMEOUT_MS),
        ])
        current.terminate()
        failPending('The copy was deleted.')
        await removeStoreDirectory().catch(() => undefined)
      }
      freeLock()
    },
  }
}
