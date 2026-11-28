import { z } from 'zod'
import type { SqliteDriver, SqliteExecutor } from '../driver'
import type { ItemEntity } from '../schema'
import { readStoreStatus } from '../store'
import type { SourceResult } from '../source'
import { readRows, sql, values } from '../compile/sql'
import { UnsupportedQuery, unsupported } from '../compile/unsupported'

/** What one read of the device source works with: one transaction and one "now". */
export type DeviceRead = {
  tx: SqliteExecutor
  /** Taken once per call, so rules and sort periods agree. */
  now: Date
}

/**
 * Runs one read in a transaction, so it sees one complete sync state. The
 * store must have completed a fill; a query the device does not serve
 * exactly answers its reason; any other failure is `store-error`.
 */
export async function serveRead<T>(
  driver: SqliteDriver,
  now: () => Date,
  work: (read: DeviceRead) => Promise<T>,
): Promise<SourceResult<T>> {
  try {
    const data = await driver.transaction(async (tx) => {
      const status = await readStoreStatus(tx)
      if (!status.ready) return unsupported('not-ready')
      return work({ tx, now: now() })
    })
    return { served: true, data }
  } catch (error) {
    if (error instanceof UnsupportedQuery)
      return { served: false, reason: error.reason }
    return { served: false, reason: 'store-error' }
  }
}

const ItemRowSchema = z.object({ rid: z.number().int(), item: z.string() })

/** The stored list items of the rows, by `rid`. A missing item is a corrupt store. */
export async function readItems(
  tx: SqliteExecutor,
  entity: ItemEntity,
  rids: readonly number[],
): Promise<Map<number, unknown>> {
  if (rids.length === 0) return new Map()
  const rows = await readRows(
    tx,
    sql`SELECT rid, item FROM item_json WHERE entity = ${entity} AND rid IN ${values(rids)}`,
  )
  const items = new Map<number, unknown>()
  for (const row of rows) {
    const parsed = ItemRowSchema.parse(row)
    const item: unknown = JSON.parse(parsed.item)
    items.set(parsed.rid, item)
  }
  for (const rid of rids) {
    if (!items.has(rid))
      throw new Error(`The store has no item for row ${rid}.`)
  }
  return items
}

/**
 * A stored timestamp in whole microseconds as the API formats it:
 * `to_char(value, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`, which truncates to
 * milliseconds.
 */
export function formatTimestamp(microseconds: number): string {
  return new Date(Math.floor(microseconds / 1000)).toISOString()
}
