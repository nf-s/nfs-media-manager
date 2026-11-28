import { z } from 'zod'

/**
 * Messages between a tab and the store's dedicated Worker. Each side parses
 * what it receives with these schemas; nothing crosses `postMessage`
 * unchecked.
 */

const RequestId = z.number().int().nonnegative()

/**
 * Why the store could not open or sync, as the setting states it. The Worker
 * sends a category, never an exception's text.
 */
export const StoreErrorSchema = z.enum([
  /** The feed's rows or pages do not match this page's schemas. */
  'newer-version',
  /** The SQLite WebAssembly or the Worker's code did not load. */
  'not-loaded',
  /** The browser refused the store's OPFS pool. */
  'storage-unavailable',
  'storage-full',
  /** The copy's file could not be read. */
  'unreadable',
  /** The feed request failed or the server answered with an error. */
  'unreachable',
  'failed',
])
export type StoreError = z.infer<typeof StoreErrorSchema>

export const HostMessageSchema = z.discriminatedUnion('type', [
  /** Opens the copy on OPFS. `apiBaseUrl` prefixes the feed paths. */
  z.object({ type: z.literal('open'), apiBaseUrl: z.string() }),
  /** One `GET` path with its query string, as `fetchApiData` received it. */
  z.object({ type: z.literal('read'), id: RequestId, path: z.string() }),
  z.object({ type: z.literal('sync'), id: RequestId }),
  /** Closes the copy and deletes its file. */
  z.object({ type: z.literal('destroy'), id: RequestId }),
])
export type HostMessage = z.infer<typeof HostMessageSchema>

const SyncOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('synced'),
    rowsApplied: z.number().int().nonnegative(),
    refilled: z.boolean(),
    /** The last `changes` page said dirty marks remain on the server. */
    pending: z.boolean(),
  }),
  z.object({ outcome: z.literal('feed-not-ready') }),
  /** The feed answered 401 or 403. */
  z.object({ outcome: z.literal('unauthorized') }),
  z.object({ outcome: z.literal('failed'), error: StoreErrorSchema }),
])
export type SyncOutcome = z.infer<typeof SyncOutcomeSchema>

export const WorkerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('opened'),
    ready: z.boolean(),
    syncedAt: z.number().nullable(),
  }),
  z.object({
    type: z.literal('open-failed'),
    /** True when this browser lacks what the store needs, rather than a fault. */
    unavailable: z.boolean(),
    error: StoreErrorSchema,
  }),
  z.object({
    type: z.literal('read'),
    id: RequestId,
    result: z.discriminatedUnion('served', [
      z.object({ served: z.literal(true), data: z.unknown() }),
      z.object({ served: z.literal(false), reason: z.string() }),
    ]),
  }),
  z.object({ type: z.literal('read-failed'), id: RequestId }),
  /** The feed answered this Worker's first request: the session may read the library. */
  z.object({ type: z.literal('verified') }),
  z.object({
    type: z.literal('progress'),
    phase: z.enum(['snapshot', 'changes']),
    rows: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('synced'),
    id: RequestId,
    result: SyncOutcomeSchema,
  }),
  z.object({ type: z.literal('destroyed'), id: RequestId }),
])
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>

/** The OPFS directory of the store's SQLite pool, removed whole when the copy is deleted. */
export const STORE_DIRECTORY = 'media-device-store'
export const STORE_FILENAME = '/library.sqlite3'
/** The Web Lock that one tab holds while its Worker owns the pool. */
export const STORE_LOCK = 'media-device-store'
