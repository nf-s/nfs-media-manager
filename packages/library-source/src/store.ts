import { z } from 'zod'
import { DeviceEntitySchema } from '@repo/schemas/device'
import type { SqliteDriver, SqliteExecutor } from './driver'
import { STORE_SCHEMA, STORE_SCHEMA_VERSION } from './schema'

const UserVersionSchema = z.object({ user_version: z.number().int() })

const SyncStateRowSchema = z.object({
  /** New on every schema build; see `sync_state` in schema.ts. */
  generation: z.string().min(1),
  phase: z.enum(['empty', 'filling', 'ready']),
  epoch: z.string().nullable(),
  row_version: z.number().int().nullable(),
  snapshot_seq: z.number().int().nullable(),
  fill_entity: DeviceEntitySchema.nullable(),
  fill_after: z.number().int().nullable(),
  cursor: z.number().int().nullable(),
  filled_at: z.number().nullable(),
  synced_at: z.number().nullable(),
})
export type SyncStateRow = z.infer<typeof SyncStateRowSchema>

const SchemaObjectSchema = z.object({
  type: z.string(),
  name: z.string(),
  sql: z.string().nullable(),
})

/** What a host shows and what a source checks before it answers. */
export type StoreStatus = {
  /** True once a first fill has completed and until the store is cleared or refilled. */
  ready: boolean
  phase: SyncStateRow['phase']
  epoch: string | null
  rowVersion: number | null
  /** The next `since` of the changes feed. */
  cursor: number | null
  /** The snapshot position of an unfinished fill. */
  fill: { entity: z.infer<typeof DeviceEntitySchema>; after: number } | null
  /** Epoch milliseconds, from the device clock. */
  filledAt: number | null
  syncedAt: number | null
}

/**
 * Creates the schema on an empty database, or drops and recreates it when the
 * stored schema version differs or the sync state is missing or unreadable.
 * Call once after opening a driver.
 */
export async function openStore(driver: SqliteDriver): Promise<void> {
  await prepareStore(driver)
}

/** `openStore`, returning the generation of the store it leaves. */
export function prepareStore(driver: SqliteDriver): Promise<string> {
  return driver.transaction(async (tx) => {
    const [row] = await tx.all('PRAGMA user_version')
    const version = UserVersionSchema.parse(row).user_version
    const state =
      version === STORE_SCHEMA_VERSION ? await readUsableSyncState(tx) : null
    if (state !== null) return state.generation
    await rebuildSchema(tx)
    return (await readSyncState(tx)).generation
  })
}

/**
 * The sync state of a store with the current schema version, or null when
 * its row is missing or does not parse, or its table cannot be read: such a
 * store is rebuilt empty and filled as a first fill.
 */
async function readUsableSyncState(
  tx: SqliteExecutor,
): Promise<SyncStateRow | null> {
  let rows: Record<string, unknown>[]
  try {
    rows = await tx.all(SYNC_STATE_SELECT)
  } catch {
    return null
  }
  const parsed = SyncStateRowSchema.safeParse(rows[0])
  return parsed.success ? parsed.data : null
}

/**
 * Removes every row and the cursor (DEVICE-30), then compacts the file so
 * the removed rows leave no pages behind. The schema gets a new generation,
 * so a sync running on this or another connection writes nothing more and
 * ends with `cleared`.
 */
export async function clearStore(driver: SqliteDriver): Promise<void> {
  await driver.transaction((tx) => rebuildSchema(tx))
  await driver.run('VACUUM')
}

export async function readStoreStatus(
  executor: SqliteExecutor,
): Promise<StoreStatus> {
  const state = await readSyncState(executor)
  return {
    ready: state.phase === 'ready',
    phase: state.phase,
    epoch: state.epoch,
    rowVersion: state.row_version,
    cursor: state.cursor,
    fill:
      state.phase === 'filling' &&
      state.fill_entity !== null &&
      state.fill_after !== null
        ? { entity: state.fill_entity, after: state.fill_after }
        : null,
    filledAt: state.filled_at,
    syncedAt: state.synced_at,
  }
}

const SYNC_STATE_SELECT = `SELECT generation, phase, epoch, row_version,
    snapshot_seq, fill_entity, fill_after, cursor, filled_at, synced_at
  FROM sync_state WHERE id = 1`

export async function readSyncState(
  executor: SqliteExecutor,
): Promise<SyncStateRow> {
  const [row] = await executor.all(SYNC_STATE_SELECT)
  return SyncStateRowSchema.parse(row)
}

/** Writes every column but `generation`, which only a schema build sets. */
export async function writeSyncState(
  executor: SqliteExecutor,
  state: SyncStateRow,
): Promise<void> {
  await executor.run(
    `UPDATE sync_state SET phase = ?, epoch = ?, row_version = ?,
       snapshot_seq = ?, fill_entity = ?, fill_after = ?, cursor = ?,
       filled_at = ?, synced_at = ?
     WHERE id = 1`,
    [
      state.phase,
      state.epoch,
      state.row_version,
      state.snapshot_seq,
      state.fill_entity,
      state.fill_after,
      state.cursor,
      state.filled_at,
      state.synced_at,
    ],
  )
}

/** Drops every table, index, trigger and FTS table, then creates the schema. */
export async function rebuildSchema(tx: SqliteExecutor): Promise<void> {
  const objects = await listSchemaObjects(tx)
  for (const object of objects.filter((entry) => entry.type === 'trigger')) {
    await tx.run(`DROP TRIGGER IF EXISTS ${quoteName(object.name)}`)
  }
  for (const object of objects.filter((entry) => entry.type === 'view')) {
    await tx.run(`DROP VIEW IF EXISTS ${quoteName(object.name)}`)
  }
  const virtual = objects.filter(
    (entry) =>
      entry.type === 'table' &&
      entry.sql !== null &&
      /^CREATE VIRTUAL TABLE/i.test(entry.sql),
  )
  for (const object of virtual) {
    await tx.run(`DROP TABLE IF EXISTS ${quoteName(object.name)}`)
  }
  const tables = (await listSchemaObjects(tx)).filter(
    (entry) => entry.type === 'table',
  )
  for (const object of tables) {
    await tx.run(`DROP TABLE IF EXISTS ${quoteName(object.name)}`)
  }
  for (const statement of STORE_SCHEMA) await tx.run(statement)
  await tx.run(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`)
}

async function listSchemaObjects(tx: SqliteExecutor) {
  const rows = await tx.all(
    `SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`,
  )
  return rows.map((row) => SchemaObjectSchema.parse(row))
}

function quoteName(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}
