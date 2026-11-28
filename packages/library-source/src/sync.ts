import {
  DEVICE_PAGE_DEFAULT_ROWS,
  DEVICE_ROW_VERSION,
  DeviceChangesResponseSchema,
  DeviceEntitySchema,
  DeviceFeedStateSchema,
  DeviceSnapshotResponseSchema,
  type DeviceEntity,
  type DeviceFeedState,
} from '@repo/schemas/device'
import { applyRows } from './apply'
import type { SqliteDriver } from './driver'
import {
  openStore,
  readSyncState,
  rebuildSchema,
  writeSyncState,
  type SyncStateRow,
} from './store'

/**
 * Performs a `GET` of a feed path (`/api/v1/device/state`, `.../snapshot?…`
 * or `.../changes?…`) and returns the parsed JSON body. The host adds the
 * base URL and credentials; the store never sees them (DEVICE-31). A failed
 * request rejects.
 */
export type FeedTransport = (path: string) => Promise<unknown>

export type SyncProgress = {
  /** `snapshot` while a fill pages entities, `changes` while it reads the change feed. */
  phase: 'snapshot' | 'changes'
  /** The entity being paged; null in the change feed, which mixes entities. */
  entity: DeviceEntity | null
  /** Rows applied by this call so far. */
  rowsApplied: number
  done: boolean
}

export type SyncOptions = {
  onProgress?: (progress: SyncProgress) => void
  /** Rows per page; the server's default when omitted. */
  pageSize?: number
  /** The device clock in epoch milliseconds, for `filledAt` and `syncedAt`. */
  now?: () => number
}

export type SyncResult =
  /** The store is filled and up to date with the feed. */
  | { status: 'synced'; refilled: boolean; rowsApplied: number; seq: number }
  /** The server has not built its feed yet; the store is unchanged. */
  | { status: 'feed-not-ready' }

/** Entities in the order a fill pages them. */
export const FILL_ORDER: readonly DeviceEntity[] = DeviceEntitySchema.options

const FEED_PATH = '/api/v1/device'
/** A reset that keeps recurring within one call is a fault, not a race. */
const MAX_RESTARTS = 3

const running = new WeakMap<SqliteDriver, Promise<SyncResult>>()

/**
 * Brings the store up to date with the server feed (DEVICE-08, DEVICE-28).
 *
 * A first fill reads the state, pages every entity's snapshot, then reads
 * changes from the state's `seq`; the store is ready when that completes.
 * Later calls read changes from the cursor. Each page is validated, then
 * applied with its derived rows and the cursor in one transaction, so a
 * reader sees the previous complete state or the next. A `reset`, another
 * epoch or another row version clears the store and fills it again. A
 * failure leaves the last committed page in place and rejects; the next
 * call resumes from there.
 *
 * Calls for the same driver while one is running share its result.
 */
export function syncStore(
  driver: SqliteDriver,
  transport: FeedTransport,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const current = running.get(driver)
  if (current !== undefined) return current
  const sync = runSync(driver, transport, options).finally(() =>
    running.delete(driver),
  )
  running.set(driver, sync)
  return sync
}

export class FeedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeedError'
  }
}

async function runSync(
  driver: SqliteDriver,
  transport: FeedTransport,
  options: SyncOptions,
): Promise<SyncResult> {
  const now = options.now ?? Date.now
  const pageSize = options.pageSize ?? DEVICE_PAGE_DEFAULT_ROWS
  const report = options.onProgress ?? (() => undefined)
  let rowsApplied = 0
  let refilled = false
  await openStore(driver)

  for (let attempt = 0; attempt <= MAX_RESTARTS; attempt += 1) {
    const feed = DeviceFeedStateSchema.parse(
      await transport(`${FEED_PATH}/state`),
    )
    if (!feed.ready) return { status: 'feed-not-ready' }
    if (feed.rowVersion !== DEVICE_ROW_VERSION) {
      await driver.transaction((tx) => rebuildSchema(tx))
      throw new FeedError(
        `The feed sends row version ${feed.rowVersion}; this store reads ${DEVICE_ROW_VERSION}.`,
      )
    }

    let state = await readSyncState(driver)
    if (needsRefill(state, feed)) {
      state = await startFill(driver, feed)
      refilled = true
    }

    if (state.phase === 'filling') {
      const filled = await pageSnapshots(driver, transport, state, {
        pageSize,
        report: (entity, applied) => {
          rowsApplied += applied
          report({ phase: 'snapshot', entity, rowsApplied, done: false })
        },
      })
      if (filled === 'reset') {
        await driver.transaction((tx) => rebuildSchema(tx))
        continue
      }
      state = filled
    }

    const caughtUp = await pageChanges(driver, transport, state, {
      pageSize,
      now,
      report: (applied) => {
        rowsApplied += applied
        report({ phase: 'changes', entity: null, rowsApplied, done: false })
      },
    })
    if (caughtUp === 'reset') {
      await driver.transaction((tx) => rebuildSchema(tx))
      continue
    }
    report({ phase: 'changes', entity: null, rowsApplied, done: true })
    return {
      status: 'synced',
      refilled,
      rowsApplied,
      seq: caughtUp.cursor ?? feed.seq,
    }
  }
  throw new FeedError('The feed kept asking for a reset.')
}

function needsRefill(state: SyncStateRow, feed: DeviceFeedState): boolean {
  if (state.phase === 'empty') return true
  return (
    state.epoch !== feed.epoch ||
    state.row_version !== feed.rowVersion ||
    state.row_version !== DEVICE_ROW_VERSION
  )
}

async function startFill(
  driver: SqliteDriver,
  feed: DeviceFeedState,
): Promise<SyncStateRow> {
  const first = FILL_ORDER[0]
  if (first === undefined) throw new FeedError('No entities to fill.')
  const state: SyncStateRow = {
    phase: 'filling',
    epoch: feed.epoch,
    row_version: feed.rowVersion,
    snapshot_seq: feed.seq,
    fill_entity: first,
    fill_after: 0,
    cursor: feed.seq,
    filled_at: null,
    synced_at: null,
  }
  await driver.transaction(async (tx) => {
    await rebuildSchema(tx)
    await writeSyncState(tx, state)
  })
  return state
}

async function pageSnapshots(
  driver: SqliteDriver,
  transport: FeedTransport,
  start: SyncStateRow,
  options: {
    pageSize: number
    report: (entity: DeviceEntity, applied: number) => void
  },
): Promise<SyncStateRow | 'reset'> {
  const epoch = start.epoch
  if (epoch === null || start.fill_entity === null) {
    throw new FeedError('The fill has no epoch or entity.')
  }
  let state = start
  let index = FILL_ORDER.indexOf(start.fill_entity)
  let after = start.fill_after ?? 0
  while (index < FILL_ORDER.length) {
    const entity = FILL_ORDER[index]
    if (entity === undefined) break
    const query = new URLSearchParams({
      epoch,
      entity,
      after: String(after),
      limit: String(options.pageSize),
    })
    const page = DeviceSnapshotResponseSchema.parse(
      await transport(`${FEED_PATH}/snapshot?${query}`),
    )
    if (page.reset) return 'reset'
    for (const row of page.rows) {
      if (row.entity !== entity) {
        throw new FeedError(`The ${entity} snapshot holds a ${row.entity} row.`)
      }
    }
    const next = FILL_ORDER[index + 1]
    const finished = !page.hasMore
    const nextState: SyncStateRow = {
      ...state,
      fill_entity: finished ? (next ?? null) : entity,
      fill_after: finished ? 0 : page.seq,
    }
    await driver.transaction(async (tx) => {
      await applyRows(tx, page.rows)
      await writeSyncState(tx, nextState)
    })
    state = nextState
    options.report(entity, page.rows.length)
    if (finished) {
      index += 1
      after = 0
    } else {
      if (page.seq <= after) {
        throw new FeedError(`The ${entity} snapshot did not advance.`)
      }
      after = page.seq
    }
  }
  return state
}

async function pageChanges(
  driver: SqliteDriver,
  transport: FeedTransport,
  start: SyncStateRow,
  options: {
    pageSize: number
    now: () => number
    report: (applied: number) => void
  },
): Promise<SyncStateRow | 'reset'> {
  const epoch = start.epoch
  if (epoch === null || start.cursor === null) {
    throw new FeedError('The store has no epoch or cursor.')
  }
  let state = start
  let since = start.cursor
  for (;;) {
    const query = new URLSearchParams({
      epoch,
      since: String(since),
      limit: String(options.pageSize),
    })
    const page = DeviceChangesResponseSchema.parse(
      await transport(`${FEED_PATH}/changes?${query}`),
    )
    if (page.reset) return 'reset'
    const finished = !page.hasMore
    const time = options.now()
    const nextState: SyncStateRow = {
      ...state,
      cursor: page.seq,
      ...(finished
        ? {
            phase: 'ready',
            fill_entity: null,
            fill_after: null,
            filled_at: state.filled_at ?? time,
            synced_at: time,
          }
        : {}),
    }
    await driver.transaction(async (tx) => {
      await applyRows(tx, page.rows)
      await writeSyncState(tx, nextState)
    })
    state = nextState
    options.report(page.rows.length)
    if (finished) return state
    if (page.seq <= since) {
      throw new FeedError('The change feed did not advance.')
    }
    since = page.seq
  }
}
