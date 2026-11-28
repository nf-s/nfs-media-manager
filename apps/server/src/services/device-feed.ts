import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { JsonValue } from '@repo/schemas/common'
import {
  DEVICE_ROW_VERSION,
  DeviceEntitySchema,
  DeviceLiveRowSchema,
  DeviceRowSchema,
  type DeviceChangesQuery,
  type DeviceChangesResponse,
  type DeviceEntity,
  type DeviceFeedState,
  type DeviceSnapshotQuery,
  type DeviceSnapshotResponse,
} from '@repo/schemas/device'
import { canReadDatabaseWithoutCache } from '@/lib/database-read-cache'
import { db } from '@/lib/db'
import {
  deviceRowHash,
  groupDeviceMarks,
  withExpandedIds,
} from '@/services/device-feed-batch'
import type { DeviceRowRenderer } from '@/services/device-renderer'

/**
 * The server side of the device feed (docs/requirements/device-store.md,
 * DEVICE-01 and 03 to 09): rows a renderer returns are hashed, numbered and
 * stored in `device_row`; triggers mark rows to render again in
 * `device_dirty`; a sweep corrects anything a trigger missed.
 */
export interface DeviceFeedRenderer extends DeviceRowRenderer {
  /**
   * Other IDs of the same entity to render with `ids`. A track mark also
   * renders the visible tracks that share its title key, because recording
   * groups depend on them. Their own marks, if any, stay for a later batch.
   */
  expand?(entity: DeviceEntity, ids: readonly string[]): Promise<string[]>
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Tombstones are kept this long (DEVICE-09). */
const tombstoneRetentionDays = 90
/** A page stops before this many payload bytes, after its first row. */
const pageByteBudget = 4 * 1024 * 1024
/** Marks read per render batch, before de-duplication. */
const maintenanceMarkBatch = 1000
const requestMarkBatch = 200
/** IDs listed per sweep batch, and at most per maintenance run. */
const sweepBatch = 500
const sweepRowsPerRun = 20_000
/** Rendering before `changes` answers; the device is told when marks remain. */
const changesRenderBudgetMs = 2_000
/** Within the five-minute maintenance invocation. */
const maintenanceRenderBudgetMs = 15_000
const maintenanceBudgetMs = 30_000
const tombstonesPrunedPerRun = 10_000

let configuredRenderer: DeviceFeedRenderer | undefined

/** The renderer the routes and maintenance use; none leaves the feed unbuilt. */
export function setDeviceFeedRenderer(
  renderer: DeviceFeedRenderer | undefined,
) {
  configuredRenderer = renderer
}

const StoredStateSchema = z.object({
  epoch: z.string().min(1),
  row_version: z.number().int(),
  min_seq: z.coerce.number().int().nonnegative(),
  seq: z.coerce.number().int().nonnegative(),
  ready: z.boolean(),
  pending: z.boolean(),
  sweep_entity: DeviceEntitySchema.nullable(),
  sweep_after: z.string().nullable(),
})
type StoredState = z.infer<typeof StoredStateSchema>

const LockRowSchema = z.object({ locked: z.boolean() })
const SeqRowsSchema = z.array(z.object({ seq: z.coerce.number().int() }))
const MarkRowsSchema = z.array(
  z.object({
    key: z.coerce.number().int(),
    entity: z.string(),
    id: z.string(),
  }),
)
const PageRowsSchema = z.array(
  z.object({
    entity: z.string(),
    id: z.string(),
    seq: z.coerce.number().int(),
    deleted: z.boolean(),
    payload: z.unknown(),
    fetched: z.coerce.number().int(),
  }),
)
const PendingRowSchema = z.object({ pending: z.boolean() })

const pendingMarks = sql`exists (select 1 from device_dirty)`

const stateColumns = sql`s.epoch, s.row_version, s.min_seq, s.ready,
  s.sweep_entity, s.sweep_after,
  greatest(s.min_seq, coalesce((select max(seq) from device_row), 0)) as seq,
  ${pendingMarks} as pending`

async function readStoredState(reader: Pick<typeof db, 'execute'> = db) {
  const result = await reader.execute(
    sql`select ${stateColumns} from device_feed_state s where s.singleton`,
  )
  return StoredStateSchema.parse(result.rows[0])
}

const isCurrent = (state: StoredState) =>
  state.row_version === DEVICE_ROW_VERSION

export async function readDeviceFeedState(): Promise<DeviceFeedState> {
  const state = await readStoredState()
  return {
    ready: state.ready && isCurrent(state),
    epoch: state.epoch,
    seq: state.seq,
    minSeq: state.min_seq,
    rowVersion: DEVICE_ROW_VERSION,
  }
}

/**
 * Runs `work` in a transaction that holds the feed's write lock (DEVICE-01),
 * so rows commit in `seq` order. Without `wait`, a held lock skips the work.
 * Returns undefined when the lock was not taken in time.
 */
async function withFeedLock<T>(
  options: { wait: boolean; deadline: number },
  work: (tx: Transaction) => Promise<T>,
): Promise<T | undefined> {
  const remainingMs = String(Math.max(1, options.deadline - Date.now()))
  try {
    return await db.transaction(async (tx) => {
      const lock = sql`hashtextextended(current_schema() || ':device_row', 0)`
      const result = await tx.execute(sql`select
        set_config('lock_timeout', ${remainingMs}, true),
        set_config('statement_timeout', ${remainingMs}, true),
        ${options.wait ? sql`pg_advisory_xact_lock(${lock}) is not null` : sql`pg_try_advisory_xact_lock(${lock})`} as locked`)
      if (!LockRowSchema.parse(result.rows[0]).locked) return undefined
      return work(tx)
    })
  } catch (error) {
    // 55P03: the lock was not granted before the deadline.
    if (
      options.wait &&
      z.object({ code: z.literal('55P03') }).safeParse(error).success
    )
      return undefined
    throw error
  }
}

/**
 * Stores the rendered rows of `ids`: a payload whose hash differs from the
 * stored one gets the next `seq`; a stored live row whose ID was not rendered
 * becomes a tombstone. Returns how many rows were written.
 */
async function writeRenderedRows(
  tx: Transaction,
  entity: DeviceEntity,
  ids: readonly string[],
  rendered: ReadonlyMap<string, JsonValue>,
) {
  const live = ids.flatMap((id) => {
    const payload = rendered.get(id)
    return payload === undefined
      ? []
      : [{ id, payload, hash: deviceRowHash(payload) }]
  })
  const absent = ids.filter((id) => !rendered.has(id))
  let written = 0
  if (live.length > 0) {
    const result = await tx.execute(sql`
      with input as (
        select row->>'id' as id, row->'payload' as payload, row->>'hash' as hash
        from jsonb_array_elements(${JSON.stringify(live)}::jsonb) row
      ), changed as (
        select input.* from input
        left join device_row stored
          on stored.entity = ${entity} and stored.id = input.id
        where stored.id is null or stored.deleted
          or stored.hash is distinct from input.hash
        order by input.id
      )
      insert into device_row (entity, id, payload, hash, seq, deleted, size, rendered_at)
      select ${entity}, id, payload, hash, nextval('device_row_seq'), false,
        octet_length(payload::text), now()
      from changed
      on conflict (entity, id) do update set payload = excluded.payload,
        hash = excluded.hash, seq = excluded.seq, deleted = false,
        size = excluded.size, rendered_at = excluded.rendered_at
      returning seq`)
    written += SeqRowsSchema.parse(result.rows).length
  }
  if (absent.length > 0)
    written += await tombstone(
      tx,
      entity,
      sql`
    id = any(${sql.param(absent)}::text[])`,
    )
  return written
}

/** Turns the stored live rows of `entity` that match `where` into tombstones. */
async function tombstone(tx: Transaction, entity: DeviceEntity, where: SQL) {
  const result = await tx.execute(sql`
    update device_row set deleted = true, payload = null, hash = null, size = 0,
      seq = nextval('device_row_seq'), rendered_at = now()
    where entity = ${entity} and not deleted and ${where}
    returning seq`)
  return SeqRowsSchema.parse(result.rows).length
}

async function renderIds(
  renderer: DeviceFeedRenderer,
  entity: DeviceEntity,
  ids: readonly string[],
) {
  const all = renderer.expand
    ? withExpandedIds(ids, await renderer.expand(entity, ids))
    : [...ids]
  return { ids: all, rendered: await renderer.render(entity, all) }
}

/**
 * One render batch (DEVICE-04): reads up to `limit` marks, renders their
 * rows, writes what changed and deletes only the marks it read, so a mark
 * made while it renders stays. Undefined when another writer holds the lock.
 */
async function renderDirtyBatch(
  renderer: DeviceFeedRenderer,
  options: { wait: boolean; deadline: number; limit: number },
) {
  return withFeedLock(options, async (tx) => {
    if (!isCurrent(await readStoredState(tx))) return { read: 0, written: 0 }
    const marks = MarkRowsSchema.parse(
      (
        await tx.execute(sql`select key, entity, id from device_dirty
          order by key limit ${options.limit}`)
      ).rows,
    )
    const batch = groupDeviceMarks(marks)
    let written = 0
    for (const { entity, ids } of batch.entities) {
      const result = await renderIds(renderer, entity, ids)
      written += await writeRenderedRows(
        tx,
        entity,
        result.ids,
        result.rendered,
      )
    }
    if (batch.keys.length > 0)
      await tx.execute(sql`delete from device_dirty
        where key = any(${sql.param(batch.keys)}::bigint[])`)
    return { read: marks.length, written }
  })
}

/**
 * Renders marked rows in batches until none remain or `deadline` passes.
 * `busy` says another writer held the lock.
 */
export async function renderDirtyDeviceRows(
  renderer: DeviceFeedRenderer,
  options: { wait: boolean; deadline: number; limit?: number },
) {
  const limit = options.limit ?? maintenanceMarkBatch
  let written = 0
  while (Date.now() < options.deadline) {
    const batch = await renderDirtyBatch(renderer, { ...options, limit })
    if (!batch) return { written, busy: true }
    written += batch.written
    if (batch.read < limit) break
  }
  return { written, busy: false }
}

/** The entity a sweep walks after `entity`; the first one after null. */
function sweptAfter(entity: DeviceEntity | null): DeviceEntity | undefined {
  const order: readonly DeviceEntity[] = DeviceEntitySchema.options
  return order[entity === null ? 0 : order.indexOf(entity) + 1]
}

/**
 * One sweep batch (DEVICE-05): lists the next IDs of the entity at the
 * cursor, renders them, writes rows whose hash differs and tombstones stored
 * rows in the listed range that were not listed. Completing the last entity
 * marks the feed ready and starts the next sweep.
 */
async function sweepBatchUnderLock(
  renderer: DeviceFeedRenderer,
  options: { wait: boolean; deadline: number; limit: number },
) {
  return withFeedLock(options, async (tx) => {
    const state = await readStoredState(tx)
    // A feed of another row version is restarted before it is swept.
    const entity = state.sweep_entity ?? sweptAfter(null)
    if (!isCurrent(state) || !entity) return undefined
    const after = state.sweep_entity ? state.sweep_after : null
    const listed = await renderer.listIds(entity, after, options.limit)
    const rendered =
      listed.length > 0
        ? await renderer.render(entity, listed)
        : new Map<string, JsonValue>()
    let written = await writeRenderedRows(tx, entity, listed, rendered)
    const last = listed.length < options.limit ? undefined : listed.at(-1)
    written += await tombstone(
      tx,
      entity,
      sql`(${after}::text is null or id > ${after})
        and (${last ?? null}::text is null or id <= ${last ?? null})
        and id <> all(${sql.param(listed)}::text[])`,
    )
    const next = last
      ? { entity, after: last }
      : { entity: sweptAfter(entity), after: null }
    const complete = next.entity === undefined
    await tx.execute(sql`update device_feed_state set
      sweep_entity = ${next.entity ?? null}, sweep_after = ${next.after},
      ready = ready or ${complete},
      swept_at = case when ${complete} then now() else swept_at end
      where singleton`)
    return { listed: listed.length, written, complete }
  })
}

/** Sweeps up to `maxRows` IDs before `deadline`; `complete` when a sweep finished. */
export async function sweepDeviceFeed(
  renderer: DeviceFeedRenderer,
  options: {
    wait: boolean
    deadline: number
    maxRows?: number
    limit?: number
  },
) {
  const maxRows = options.maxRows ?? sweepRowsPerRun
  const limit = options.limit ?? sweepBatch
  let listed = 0
  let written = 0
  let complete = false
  while (!complete && listed < maxRows && Date.now() < options.deadline) {
    const batch = await sweepBatchUnderLock(renderer, { ...options, limit })
    if (!batch) break
    listed += batch.listed
    written += batch.written
    complete = batch.complete
  }
  return { written, complete }
}

/**
 * Starts the feed again from nothing when the stored row version differs
 * from DEVICE_ROW_VERSION: a new epoch, no rows, not ready, a new sweep.
 * Devices holding the old epoch are told to reset.
 */
export async function startCurrentDeviceFeed(deadline: number) {
  if (isCurrent(await readStoredState())) return false
  const restarted = await withFeedLock({ wait: true, deadline }, async (tx) => {
    if (isCurrent(await readStoredState(tx))) return false
    await tx.execute(sql`
      with removed as (delete from device_row returning seq)
      update device_feed_state set epoch = gen_random_uuid()::text,
        row_version = ${DEVICE_ROW_VERSION}, ready = false,
        sweep_entity = null, sweep_after = null, swept_at = null,
        rebuilt_at = now(),
        min_seq = greatest(min_seq, coalesce((select max(seq) from removed), 0))
      where singleton`)
    return true
  })
  return restarted ?? false
}

/**
 * Removes tombstones older than the retention period and raises `minSeq` past
 * them, so a device that last read before them is told to reset.
 */
export async function pruneDeviceTombstones(deadline: number) {
  const pruned = await withFeedLock({ wait: true, deadline }, async (tx) => {
    const result = await tx.execute(sql`
      with removed as (
        delete from device_row where ctid in (
          select ctid from device_row
          where deleted
            and rendered_at < now() - make_interval(days => ${tombstoneRetentionDays})
          limit ${tombstonesPrunedPerRun})
        returning seq
      ), raised as (
        update device_feed_state
        set min_seq = greatest(min_seq, (select max(seq) from removed))
        where singleton and exists (select 1 from removed)
      )
      select seq from removed`)
    return SeqRowsSchema.parse(result.rows).length
  })
  return pruned ?? 0
}

/**
 * The five-minute maintenance task: restarts the feed for a new row
 * version, renders marked rows, continues the sweep and prunes old
 * tombstones. Returns whether it changed the feed. Without a renderer it does
 * nothing.
 */
export async function refreshDeviceFeedForMaintenance(
  renderer: DeviceFeedRenderer | undefined = configuredRenderer,
): Promise<boolean> {
  if (!renderer) return false
  const start = Date.now()
  try {
    const restarted = await startCurrentDeviceFeed(start + maintenanceBudgetMs)
    const render = await renderDirtyDeviceRows(renderer, {
      wait: true,
      deadline: start + maintenanceRenderBudgetMs,
    })
    const sweep = await sweepDeviceFeed(renderer, {
      wait: true,
      deadline: start + maintenanceBudgetMs,
    })
    const pruned = await pruneDeviceTombstones(start + maintenanceBudgetMs)
    return restarted || render.written + sweep.written + pruned > 0
  } catch (error) {
    // Lock waits, timeouts and tables not yet migrated leave the work to the
    // next tick.
    if (canReadDatabaseWithoutCache(error)) return false
    throw error
  }
}

function needsReset(state: StoredState, epoch: string) {
  return !isCurrent(state) || state.epoch !== epoch
}

/**
 * One page of `device_row` matching `where`, in `seq` order, bounded by rows
 * and by payload bytes. `hasMore` says the rows read went past the page.
 */
async function readPage(where: SQL, limit: number) {
  const result = await db.execute(sql`
    select entity, id, seq, deleted, payload, fetched from (
      select page.*, count(*) over () as fetched,
        sum(size) over (order by seq) - size as before
      from (
        select entity, id, seq, deleted, payload, size from device_row
        where ${where} order by seq limit ${limit + 1}
      ) page
    ) sized
    where before < ${pageByteBudget}
    order by seq limit ${limit}`)
  const rows = PageRowsSchema.parse(result.rows)
  return {
    rows: rows.map(({ entity, id, seq, deleted, payload }) => ({
      entity,
      id,
      seq,
      deleted,
      payload,
    })),
    hasMore: (rows[0]?.fetched ?? 0) > rows.length,
  }
}

/** Live rows of one entity after `after`, in `seq` order (DEVICE-07). */
export async function readDeviceSnapshot(
  query: DeviceSnapshotQuery,
): Promise<DeviceSnapshotResponse> {
  const state = await readStoredState()
  if (needsReset(state, query.epoch)) return { reset: true }
  const page = await readPage(
    sql`entity = ${query.entity} and not deleted and seq > ${query.after}`,
    query.limit,
  )
  const rows = page.rows.map((row) => DeviceLiveRowSchema.parse(row))
  return {
    reset: false,
    rows,
    seq: rows.at(-1)?.seq ?? query.after,
    hasMore: page.hasMore,
  }
}

/**
 * Rows and tombstones of every entity after `since`, in `seq` order
 * (DEVICE-07). Marked rows are rendered first, within a time budget, when no
 * other writer is rendering; `pending` says marks remain.
 */
export async function readDeviceChanges(
  query: DeviceChangesQuery,
  renderer: DeviceFeedRenderer | undefined = configuredRenderer,
): Promise<DeviceChangesResponse> {
  const state = await readStoredState()
  if (needsReset(state, query.epoch) || query.since < state.min_seq)
    return { reset: true }
  let pending = state.pending
  if (pending && renderer) {
    try {
      await renderDirtyDeviceRows(renderer, {
        wait: false,
        deadline: Date.now() + changesRenderBudgetMs,
        limit: requestMarkBatch,
      })
    } catch (error) {
      // A timeout leaves the marks to maintenance; the page still answers.
      if (!canReadDatabaseWithoutCache(error)) throw error
    }
    pending = PendingRowSchema.parse(
      (await db.execute(sql`select ${pendingMarks} as pending`)).rows[0],
    ).pending
  }
  const page = await readPage(sql`seq > ${query.since}`, query.limit)
  const rows = page.rows.map((row) => DeviceRowSchema.parse(row))
  return {
    reset: false,
    rows,
    seq: rows.at(-1)?.seq ?? query.since,
    hasMore: page.hasMore,
    pending,
  }
}
