import { trackBrowseFields, type BrowseField } from '@repo/schemas/browse'
import type { DeviceEntity, DeviceRow } from '@repo/schemas/device'
import {
  TrackPositionsQuerySchema,
  TrackQuerySchema,
  type TrackPositionsQuery,
  type TrackQuery,
} from '@repo/schemas/tracks'
import { applyRows } from '../src/apply'
import { createDeviceLibrarySource } from '../src/device/source'
import type { SqlValue, SqliteDriver, SqliteExecutor } from '../src/driver'
import { openBetterSqliteDriver } from '../src/drivers/better-sqlite3'
import type { LibrarySource, SourceResult } from '../src/source'
import { openStore } from '../src/store'
import { live } from './fixtures'

/** Synthetic rows only. */

export type StoreRow = { entity: DeviceEntity; id: string; payload: unknown }

export type DeviceStore = {
  driver: SqliteDriver
  source: LibrarySource
  /** Statements the source ran, in order, with their parameters. */
  statements: { sql: string; params: readonly SqlValue[] }[]
  close(): Promise<void>
}

export type StoreOptions = {
  /** The clock the source reads once per call. */
  now?: Date
  /** Leaves the store in its empty phase, as before a first fill. */
  ready?: boolean
  /** The `fields:track` row; left out when null. */
  trackFields?: BrowseField[] | null
}

export const FIXED_NOW = new Date('2024-06-15T12:00:00.000Z')

/** A store filled with the rows (and the Tracks field list) and marked ready. */
export async function openDeviceStore(
  rows: readonly StoreRow[],
  options: StoreOptions = {},
): Promise<DeviceStore> {
  const driver = openBetterSqliteDriver()
  await openStore(driver)
  let seq = 0
  const feed: DeviceRow[] = rows.map((row) => {
    seq += 1
    return live(row.entity, row.id, seq, row.payload)
  })
  const fields =
    options.trackFields === undefined ? trackBrowseFields : options.trackFields
  if (fields !== null) {
    seq += 1
    feed.push(
      live('meta', 'fields:track', seq, {
        kind: 'fields',
        library: 'track',
        fields,
      }),
    )
  }
  await driver.transaction((tx) => applyRows(tx, feed))
  if (options.ready !== false) {
    await driver.run(
      `UPDATE sync_state SET phase = 'ready', epoch = 'epoch-1', row_version = 1,
         cursor = ?, filled_at = 0, synced_at = 0 WHERE id = 1`,
      [seq],
    )
  }
  const statements: DeviceStore['statements'] = []
  const recording: SqliteDriver = {
    ...driver,
    transaction: (work) =>
      driver.transaction((tx) => work(recordingExecutor(tx, statements))),
  }
  const now = options.now ?? FIXED_NOW
  return {
    driver,
    source: createDeviceLibrarySource(recording, { now: () => now }),
    statements,
    close: () => driver.close(),
  }
}

function recordingExecutor(
  tx: SqliteExecutor,
  statements: DeviceStore['statements'],
): SqliteExecutor {
  return {
    run: (sql, params = []) => {
      statements.push({ sql, params })
      return tx.run(sql, params)
    },
    all: (sql, params = []) => {
      statements.push({ sql, params })
      return tx.all(sql, params)
    },
  }
}

export function trackQuery(input: Record<string, unknown> = {}): TrackQuery {
  return TrackQuerySchema.parse(input)
}

export function positionsQuery(
  input: Record<string, unknown>,
): TrackPositionsQuery {
  return TrackPositionsQuerySchema.parse(input)
}

/** The data of a served result; fails the test with the reason otherwise. */
export function served<T>(result: SourceResult<T>): T {
  if (!result.served)
    throw new Error(`The read was not served: ${result.reason}`)
  return result.data
}

export function reason<T>(result: SourceResult<T>): string | null {
  return result.served ? null : result.reason
}

/** The IDs of a served Tracks page. */
export async function pageIds(
  store: DeviceStore,
  input: Record<string, unknown> = {},
): Promise<string[]> {
  const page = served(
    await store.source.trackPage(trackQuery({ size: 100, ...input })),
  )
  return page.items.map((item) => item.id)
}

export async function totalCount(
  store: DeviceStore,
  input: Record<string, unknown> = {},
): Promise<number> {
  return served(await store.source.trackCount(trackQuery(input))).totalCount
}
