import { z } from 'zod'
import { DEVICE_ROW_VERSION } from '@repo/schemas/device'
import type { SqliteDriver, SqliteExecutor } from '../driver'
import { parseTextFold, type TextFold } from '../fold'
import { STORE_SCHEMA_VERSION, type ItemEntity } from '../schema'
import { readSyncState } from '../store'
import type { SourceResult } from '../source'
import { unservedQueryKey, type QueryKeyCheck } from '../compile/query-keys'
import { readRows, sql, values } from '../compile/sql'
import { UnsupportedQuery, unsupported } from '../compile/unsupported'

/** What one read of the device source works with: one transaction, one "now" and the server's fold. */
export type DeviceRead = {
  tx: SqliteExecutor
  /** Taken once per call, so rules and sort periods agree. */
  now: Date
  /** The `meta` row `fold`: how the server's database lower-cases text. */
  fold: TextFold
}

const UserVersionSchema = z.object({ user_version: z.number().int() })
const StoredFoldSchema = z.object({
  epoch: z.string().nullable(),
  seq: z.number().int(),
  value: z.string(),
})

/** The parsed fold of each driver, keyed by the epoch and `seq` of its row. */
const folds = new WeakMap<SqliteDriver, { key: string; fold: TextFold }>()

/**
 * Whether the store answers reads: a completed fill for this package's row
 * and schema versions, holding the fold. Returns the fold, parsed once per
 * row version for each driver; a sync that writes the row changes its `seq`.
 */
async function readReadyFold(
  driver: SqliteDriver,
  tx: SqliteExecutor,
): Promise<TextFold> {
  const [version] = await tx.all('PRAGMA user_version')
  if (UserVersionSchema.parse(version).user_version !== STORE_SCHEMA_VERSION)
    return unsupported('not-ready')
  const state = await readSyncState(tx)
  if (state.phase !== 'ready' || state.row_version !== DEVICE_ROW_VERSION)
    return unsupported('not-ready')
  const [row] = await tx.all(
    `SELECT s.epoch, m.seq, m.value FROM meta m, sync_state s
     WHERE m.id = 'fold' AND s.id = 1`,
  )
  if (row === undefined) return unsupported('not-ready')
  const stored = StoredFoldSchema.parse(row)
  const key = `${stored.epoch ?? ''}:${stored.seq}`
  const cached = folds.get(driver)
  if (cached?.key === key) return cached.fold
  const fold = parseTextFold(stored.value)
  folds.set(driver, { key, fold })
  return fold
}

/** Whether a string of the parsed query holds U+0000, which PostgreSQL text cannot hold. */
export function holdsNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\u0000')
  if (Array.isArray(value)) return value.some(holdsNul)
  if (typeof value === 'object' && value !== null)
    return Object.values(value).some(holdsNul)
  return false
}

/**
 * Runs one read in a transaction, so it sees one complete sync state. A
 * query holding U+0000 is `nul-text`, whatever the API answers; then a
 * query holding a value for a key its table does not mark `served` is
 * `unimplemented-field` (DEVICE-34), before the store is read. The store
 * must have completed a fill for this package's row and schema versions
 * and hold the fold, or the read is `not-ready`; a query the device does
 * not serve exactly answers its reason; any other failure is `store-error`.
 */
export async function serveRead<T>(
  driver: SqliteDriver,
  now: () => Date,
  query: unknown,
  checks: readonly QueryKeyCheck[],
  work: (read: DeviceRead) => Promise<T>,
): Promise<SourceResult<T>> {
  if (holdsNul(query)) return { served: false, reason: 'nul-text' }
  if (unservedQueryKey(checks) !== undefined)
    return { served: false, reason: 'unimplemented-field' }
  try {
    const data = await driver.transaction(async (tx) => {
      const fold = await readReadyFold(driver, tx)
      return work({ tx, now: now(), fold })
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
