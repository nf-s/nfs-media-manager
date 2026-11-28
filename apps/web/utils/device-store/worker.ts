import { z } from 'zod'
import { DeviceChangesResponseSchema } from '@repo/schemas/device'
import {
  createDeviceLibrarySource,
  openStore,
  readSource,
  readStoreStatus,
  resolveLibraryRead,
  syncStore,
  type LibraryMethod,
  type LibraryQueries,
  type LibrarySource,
} from '@repo/library-source'
import { openOpfsStore, type OpfsStore } from '@repo/library-source/sqlite-wasm'
import {
  HostMessageSchema,
  STORE_DIRECTORY,
  STORE_FILENAME,
  type SyncOutcome,
  type WorkerMessage,
} from './protocol'

/**
 * The store's dedicated Worker (DEVICE-41). It owns the SQLite pool on OPFS,
 * answers reads from the copy and fetches the feed with the tab's session
 * cookie. Only the tab holding the store's Web Lock starts it.
 */

const EnvelopeSchema = z.object({ data: z.unknown() })
/** Retries while a previous Worker of this origin still releases the pool's files. */
const OPEN_RETRY_MS = [250, 1_000, 2_000]

class FeedStatusError extends Error {
  constructor(readonly status: number) {
    super(`The feed answered ${status}.`)
  }
}

let apiBaseUrl = ''
let store: OpfsStore | undefined
let source: LibrarySource | undefined
let verified = false
let lastPending = false

function post(message: WorkerMessage) {
  postMessage(message)
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error'
}

function hasStoreSupport() {
  return (
    typeof WebAssembly === 'object' &&
    'FileSystemSyncAccessHandle' in globalThis &&
    typeof navigator.storage?.getDirectory === 'function'
  )
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function openPool(): Promise<OpfsStore> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await openOpfsStore({
        filename: STORE_FILENAME,
        directory: STORE_DIRECTORY,
      })
    } catch (error) {
      const delay = OPEN_RETRY_MS[attempt]
      if (delay === undefined) throw error
      await wait(delay)
    }
  }
}

async function open(baseUrl: string) {
  apiBaseUrl = baseUrl
  if (!hasStoreSupport()) {
    post({
      type: 'open-failed',
      unavailable: true,
      message: 'This browser has no OPFS access handles.',
    })
    return
  }
  try {
    store = await openPool()
    await openStore(store.driver)
    const status = await readStoreStatus(store.driver)
    source = createDeviceLibrarySource(store.driver, { now: () => new Date() })
    post({ type: 'opened', ready: status.ready, syncedAt: status.syncedAt })
  } catch (error) {
    post({ type: 'open-failed', unavailable: false, message: messageOf(error) })
  }
}

/** Calls the method a read names; the generic keeps its method and query together. */
function serve<Method extends LibraryMethod>(
  library: LibrarySource,
  read: { method: Method; query: LibraryQueries[Method] },
) {
  return readSource(library, read.method, read.query)
}

async function read(id: number, path: string) {
  const library = resolveLibraryRead(path)
  if (!source || !library) {
    post({ type: 'read', id, result: { served: false, reason: 'not-library' } })
    return
  }
  try {
    const result = await serve(source, library)
    post({
      type: 'read',
      id,
      result: result.served
        ? { served: true, data: result.data }
        : { served: false, reason: result.reason },
    })
  } catch {
    post({ type: 'read-failed', id })
  }
}

/** A feed `GET` with the session cookie; the store never sees credentials (DEVICE-31). */
async function transport(path: string): Promise<unknown> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new FeedStatusError(response.status)
  const { data } = EnvelopeSchema.parse(await response.json())
  if (!verified) {
    verified = true
    post({ type: 'verified' })
  }
  if (path.startsWith('/api/v1/device/changes')) {
    const page = DeviceChangesResponseSchema.safeParse(data)
    if (page.success && !page.data.reset) lastPending = page.data.pending
  }
  return data
}

async function sync(id: number) {
  const result = await runSync()
  post({ type: 'synced', id, result })
}

async function runSync(): Promise<SyncOutcome> {
  if (!store) return { outcome: 'failed', message: 'The copy is not open.' }
  lastPending = false
  try {
    const result = await syncStore(store.driver, transport, {
      onProgress: (progress) =>
        post({
          type: 'progress',
          phase: progress.phase,
          rows: progress.rowsApplied,
        }),
    })
    if (result.status === 'feed-not-ready') return { outcome: 'feed-not-ready' }
    if (result.status === 'cleared')
      return { outcome: 'failed', message: 'The copy was deleted.' }
    return {
      outcome: 'synced',
      rowsApplied: result.rowsApplied,
      refilled: result.refilled,
      pending: lastPending,
    }
  } catch (error) {
    if (
      error instanceof FeedStatusError &&
      (error.status === 401 || error.status === 403)
    )
      return { outcome: 'unauthorized' }
    return { outcome: 'failed', message: messageOf(error) }
  }
}

async function destroy(id: number) {
  const current = store
  store = undefined
  source = undefined
  try {
    await current?.destroy()
  } finally {
    post({ type: 'destroyed', id })
  }
}

addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = HostMessageSchema.safeParse(event.data)
  if (!message.success) return
  switch (message.data.type) {
    case 'open':
      void open(message.data.apiBaseUrl)
      return
    case 'read':
      void read(message.data.id, message.data.path)
      return
    case 'sync':
      void sync(message.data.id)
      return
    case 'destroy':
      void destroy(message.data.id)
      return
  }
})
