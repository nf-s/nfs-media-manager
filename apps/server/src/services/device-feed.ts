import { DrizzleQueryError, sql, type SQL } from 'drizzle-orm'
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
import { recordDeviceRenderFailures } from '@/lib/request-log'
import {
  deviceRowHash,
  groupDeviceMarks,
  withExpandedIds,
} from '@/services/device-feed-batch'
import type { DeviceRowRenderer } from '@/services/device-renderer'
import { deviceRowRenderer } from '@/services/device-rows'

/**
 * The server side of the device feed (docs/requirements/device-store.md,
 * DEVICE-01 and 03 to 09): rows a renderer returns are hashed, numbered and
 * stored in `device_row`; triggers mark rows to render again in
 * `device_dirty`; a sweep corrects anything a trigger missed.
 */
export interface DeviceFeedRenderer extends DeviceRowRenderer {
  /**
   * Other IDs of the same entity to render with `ids`, read before any of
   * them is written, so the stored rows still hold what was published. A
   * track mark also renders the tracks whose recording group can change with
   * it. Their own marks, if any, stay for a later batch.
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
/**
 * A completed sweep rests this long before the next one starts (DEVICE-05).
 * The first sweep, and one after a row-version change, runs in every
 * maintenance run until it completes.
 */
export const SWEEP_REST_HOURS = 24
/** Rendering before `changes` answers; the device is told when marks remain. */
const changesRenderBudgetMs = 2_000
/** Within the five-minute maintenance invocation. */
const maintenanceRenderBudgetMs = 15_000
const maintenanceBudgetMs = 30_000
const tombstonesPrunedPerRun = 10_000

let configuredRenderer: DeviceFeedRenderer = deviceRowRenderer

/**
 * The renderer the routes and maintenance use: the device row renderer
 * unless a test replaces it. No argument restores it.
 */
export function setDeviceFeedRenderer(
  renderer: DeviceFeedRenderer = deviceRowRenderer,
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
  sweep_due: z.boolean(),
})
type StoredState = z.infer<typeof StoredStateSchema>

const MaintenanceStateSchema = StoredStateSchema.extend({
  prunable: z.boolean(),
})

const LockRowSchema = z.object({ locked: z.boolean() })
const SeqRowsSchema = z.array(z.object({ seq: z.coerce.number().int() }))
const MarkRowsSchema = z.array(
  z.object({
    key: z.coerce.number().int(),
    entity: z.string(),
    id: z.string(),
  }),
)
const PageRowSchema = z.object({
  epoch: z.string().min(1),
  row_version: z.number().int(),
  min_seq: z.coerce.number().int().nonnegative(),
  pending: z.boolean(),
  entity: z.string().nullable(),
  id: z.string().nullable(),
  seq: z.coerce.number().int().nullable(),
  deleted: z.boolean().nullable(),
  payload: z.unknown(),
  fetched: z.coerce.number().int().nullable(),
})
/** A page's rows with the state they were read in: one row of nulls when the page is empty. */
const PageRowsSchema = z.tuple([PageRowSchema], PageRowSchema)

const pendingMarks = sql`exists (select 1 from device_dirty)`

// A sweep is due while the feed is being built or a sweep is under way, and
// once the last completed sweep has rested.
const stateColumns = sql`s.epoch, s.row_version, s.min_seq, s.ready,
  s.sweep_entity, s.sweep_after,
  greatest(s.min_seq, coalesce((select max(seq) from device_row), 0)) as seq,
  ${pendingMarks} as pending,
  (not s.ready or s.sweep_entity is not null or s.swept_at is null
    or s.swept_at <= now() - make_interval(hours => ${SWEEP_REST_HOURS})) as sweep_due`

async function readStoredState(reader: Pick<typeof db, 'execute'> = db) {
  const result = await reader.execute(
    sql`select ${stateColumns} from device_feed_state s where s.singleton`,
  )
  return StoredStateSchema.parse(result.rows[0])
}

/** The state, and whether tombstones are old enough to prune, in one read. */
async function readMaintenanceState() {
  const result = await db.execute(sql`select ${stateColumns},
      exists (select 1 from device_row where deleted
        and rendered_at < now() - make_interval(days => ${tombstoneRetentionDays})) as prunable
    from device_feed_state s where s.singleton`)
  return MaintenanceStateSchema.parse(result.rows[0])
}

const isCurrent = (state: Pick<StoredState, 'row_version'>) =>
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

/** Rows that could not be rendered, counted by entity, with no ID or content. */
export type DeviceRenderFailures = Partial<Record<DeviceEntity, number>>

function addFailures(
  failures: DeviceRenderFailures,
  more: DeviceRenderFailures,
) {
  for (const entity of DeviceEntitySchema.options) {
    const count = more[entity]
    if (count) failures[entity] = (failures[entity] ?? 0) + count
  }
}

const ErrorCodeSchema = z.object({ code: z.string() })

/** An error of the database or its connection, not of one row's data. */
function isDatabaseError(error: unknown) {
  return (
    error instanceof DrizzleQueryError ||
    ErrorCodeSchema.safeParse(error).success ||
    (error instanceof Error && ErrorCodeSchema.safeParse(error.cause).success)
  )
}

/**
 * Renders `ids`, setting aside the rows that cannot be rendered (DEVICE-04).
 * When a render throws anything but a database error, the IDs are halved
 * until each failing ID is alone; past `deadline`, a failing part is set
 * aside whole. A set-aside row keeps its stored row; the sweep renders it
 * again.
 */
async function renderSettingAside(
  renderer: DeviceRowRenderer,
  entity: DeviceEntity,
  ids: readonly string[],
  deadline: number,
): Promise<{ rendered: Map<string, JsonValue>; failed: string[] }> {
  try {
    return { rendered: await renderer.render(entity, ids), failed: [] }
  } catch (error) {
    if (isDatabaseError(error)) throw error
    if (ids.length === 1 || Date.now() >= deadline)
      return { rendered: new Map(), failed: [...ids] }
    const middle = Math.ceil(ids.length / 2)
    const first = await renderSettingAside(
      renderer,
      entity,
      ids.slice(0, middle),
      deadline,
    )
    const second = await renderSettingAside(
      renderer,
      entity,
      ids.slice(middle),
      deadline,
    )
    return {
      rendered: new Map([...first.rendered, ...second.rendered]),
      failed: [...first.failed, ...second.failed],
    }
  }
}

/**
 * Renders `ids` and writes what changed: a stored row whose ID rendered
 * nothing becomes a tombstone, and a row set aside stays as it is.
 */
async function renderAndWrite(
  tx: Transaction,
  renderer: DeviceRowRenderer,
  entity: DeviceEntity,
  ids: readonly string[],
  deadline: number,
) {
  const { rendered, failed } = await renderSettingAside(
    renderer,
    entity,
    ids,
    deadline,
  )
  const setAside = new Set(failed)
  const written = await writeRenderedRows(
    tx,
    entity,
    ids.filter((id) => !setAside.has(id)),
    rendered,
  )
  const failures: DeviceRenderFailures = failed.length
    ? { [entity]: failed.length }
    : {}
  return { written, failures }
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
    const failed: DeviceRenderFailures = {}
    if (!isCurrent(await readStoredState(tx)))
      return { read: 0, written: 0, failed }
    const marks = MarkRowsSchema.parse(
      (
        await tx.execute(sql`select key, entity, id from device_dirty
          order by key limit ${options.limit}`)
      ).rows,
    )
    const batch = groupDeviceMarks(marks)
    let written = 0
    for (const { entity, ids } of batch.entities) {
      const all = renderer.expand
        ? withExpandedIds(ids, await renderer.expand(entity, ids))
        : ids
      const result = await renderAndWrite(
        tx,
        renderer,
        entity,
        all,
        options.deadline,
      )
      written += result.written
      addFailures(failed, result.failures)
    }
    if (batch.keys.length > 0)
      await tx.execute(sql`delete from device_dirty
        where key = any(${sql.param(batch.keys)}::bigint[])`)
    return { read: marks.length, written, failed }
  })
}

/**
 * Renders marked rows in batches until none remain or `deadline` passes.
 * `busy` says another writer held the lock; `failed` counts the rows set
 * aside.
 */
export async function renderDirtyDeviceRows(
  renderer: DeviceFeedRenderer,
  options: { wait: boolean; deadline: number; limit?: number },
) {
  const limit = options.limit ?? maintenanceMarkBatch
  let written = 0
  const failed: DeviceRenderFailures = {}
  while (Date.now() < options.deadline) {
    const batch = await renderDirtyBatch(renderer, { ...options, limit })
    if (!batch) return { written, busy: true, failed }
    written += batch.written
    addFailures(failed, batch.failed)
    if (batch.read < limit) break
  }
  return { written, busy: false, failed }
}

/** The entity a sweep walks after `entity`; the first one after null. */
function sweptAfter(entity: DeviceEntity | null): DeviceEntity | undefined {
  const order: readonly DeviceEntity[] = DeviceEntitySchema.options
  return order[entity === null ? 0 : order.indexOf(entity) + 1]
}

type SweepOptions = {
  wait: boolean
  deadline: number
  /** Start a sweep only when one is due: not within the rest after the last. */
  onlyWhenDue?: boolean
}

/**
 * One sweep batch (DEVICE-05): lists the next IDs of the entity at the
 * cursor, renders them, writes rows whose hash differs and tombstones stored
 * rows in the listed range that were not listed. Every ID comparison happens
 * here in SQL, in the collation `listIds` orders by. Completing the last
 * entity marks the feed ready.
 */
async function sweepBatchUnderLock(
  renderer: DeviceFeedRenderer,
  options: SweepOptions & { limit: number },
) {
  return withFeedLock(options, async (tx) => {
    const state = await readStoredState(tx)
    // A feed of another row version is restarted before it is swept.
    const entity = state.sweep_entity ?? sweptAfter(null)
    if (!isCurrent(state) || !entity) return undefined
    if (options.onlyWhenDue && !state.sweep_due) return undefined
    const after = state.sweep_entity ? state.sweep_after : null
    const listed = await renderer.listIds(entity, after, options.limit)
    const result =
      listed.length > 0
        ? await renderAndWrite(tx, renderer, entity, listed, options.deadline)
        : { written: 0, failures: {} }
    let written = result.written
    const last = listed.length < options.limit ? undefined : listed.at(-1)
    // A listed row set aside is in `listed`, so it is not tombstoned.
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
    return {
      listed: listed.length,
      written,
      complete,
      failed: result.failures,
    }
  })
}

/**
 * Sweeps up to `maxRows` IDs before `deadline`; `complete` when a sweep
 * finished, `failed` counting the rows set aside.
 */
export async function sweepDeviceFeed(
  renderer: DeviceFeedRenderer,
  options: SweepOptions & { maxRows?: number; limit?: number },
) {
  const maxRows = options.maxRows ?? sweepRowsPerRun
  const limit = options.limit ?? sweepBatch
  let listed = 0
  let written = 0
  let complete = false
  const failed: DeviceRenderFailures = {}
  while (!complete && listed < maxRows && Date.now() < options.deadline) {
    const batch = await sweepBatchUnderLock(renderer, { ...options, limit })
    if (!batch) break
    listed += batch.listed
    written += batch.written
    complete = batch.complete
    addFailures(failed, batch.failed)
  }
  return { written, complete, failed }
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
 * version, renders marked rows, continues a due sweep and prunes old
 * tombstones. One read decides which of them has work, so a run with none
 * is one statement. `published` says whether it changed the feed;
 * `renderFailures` counts the rows set aside.
 */
export async function refreshDeviceFeedForMaintenance(
  renderer: DeviceFeedRenderer = configuredRenderer,
): Promise<{ published: boolean; renderFailures: DeviceRenderFailures }> {
  const start = Date.now()
  const renderFailures: DeviceRenderFailures = {}
  try {
    const state = await readMaintenanceState()
    const restarted =
      !isCurrent(state) &&
      (await startCurrentDeviceFeed(start + maintenanceBudgetMs))
    const render = state.pending
      ? await renderDirtyDeviceRows(renderer, {
          wait: true,
          deadline: start + maintenanceRenderBudgetMs,
        })
      : { written: 0, failed: {} }
    addFailures(renderFailures, render.failed)
    const sweep =
      restarted || state.sweep_due
        ? await sweepDeviceFeed(renderer, {
            wait: true,
            deadline: start + maintenanceBudgetMs,
            onlyWhenDue: true,
          })
        : { written: 0, failed: {} }
    addFailures(renderFailures, sweep.failed)
    const pruned = state.prunable
      ? await pruneDeviceTombstones(start + maintenanceBudgetMs)
      : 0
    return {
      published: restarted || render.written + sweep.written + pruned > 0,
      renderFailures,
    }
  } catch (error) {
    // Lock waits, timeouts and tables not yet migrated leave the work to the
    // next tick.
    if (canReadDatabaseWithoutCache(error))
      return { published: false, renderFailures }
    throw error
  }
}

function needsReset(
  state: Pick<StoredState, 'epoch' | 'row_version'>,
  epoch: string,
) {
  return !isCurrent(state) || state.epoch !== epoch
}

/**
 * One page of `device_row` matching `where`, in `seq` order, bounded by rows
 * and by payload bytes, with the feed state it was read in: one statement,
 * so a restart or a prune lands wholly before or after the page.
 * `hasMore` says the rows read went past the page.
 */
async function readPage(where: SQL, limit: number) {
  const result = await db.execute(sql`
    with state as (
      select s.epoch, s.row_version, s.min_seq, ${pendingMarks} as pending
      from device_feed_state s where s.singleton
    ), page as (
      select entity, id, seq, deleted, payload, fetched from (
        select page.*, count(*) over () as fetched,
          sum(size) over (order by seq) - size as before
        from (
          select entity, id, seq, deleted, payload, size from device_row
          where ${where} order by seq limit ${limit + 1}
        ) page
      ) sized
      where before < ${pageByteBudget}
      order by seq limit ${limit}
    )
    select state.*, page.* from state left join page on true
    order by page.seq`)
  const rows = PageRowsSchema.parse(result.rows)
  const [{ epoch, row_version, min_seq, pending, fetched }] = rows
  const pageRows = rows.flatMap(({ entity, id, seq, deleted, payload }) =>
    entity === null || id === null || seq === null || deleted === null
      ? []
      : [{ entity, id, seq, deleted, payload }],
  )
  return {
    state: { epoch, row_version, min_seq, pending },
    rows: pageRows,
    hasMore: (fetched ?? 0) > pageRows.length,
  }
}

/** Live rows of one entity after `after`, in `seq` order (DEVICE-07). */
export async function readDeviceSnapshot(
  query: DeviceSnapshotQuery,
): Promise<DeviceSnapshotResponse> {
  const page = await readPage(
    sql`entity = ${query.entity} and not deleted and seq > ${query.after}`,
    query.limit,
  )
  if (needsReset(page.state, query.epoch)) return { reset: true }
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
 * other writer is rendering; `pending` says marks remain. The page is
 * checked against the state it was read in, so a device whose epoch ended
 * or whose tombstones were pruned meanwhile is told to reset.
 */
export async function readDeviceChanges(
  query: DeviceChangesQuery,
  renderer: DeviceFeedRenderer = configuredRenderer,
): Promise<DeviceChangesResponse> {
  const resets = (
    state: Pick<StoredState, 'epoch' | 'row_version' | 'min_seq'>,
  ) => needsReset(state, query.epoch) || query.since < state.min_seq
  const state = await readStoredState()
  if (resets(state)) return { reset: true }
  if (state.pending) {
    try {
      const render = await renderDirtyDeviceRows(renderer, {
        wait: false,
        deadline: Date.now() + changesRenderBudgetMs,
        limit: requestMarkBatch,
      })
      recordDeviceRenderFailures(render.failed)
    } catch (error) {
      // A timeout leaves the marks to maintenance; the page still answers.
      if (!canReadDatabaseWithoutCache(error)) throw error
    }
  }
  const page = await readPage(sql`seq > ${query.since}`, query.limit)
  if (resets(page.state)) return { reset: true }
  const rows = page.rows.map((row) => DeviceRowSchema.parse(row))
  return {
    reset: false,
    rows,
    seq: rows.at(-1)?.seq ?? query.since,
    hasMore: page.hasMore,
    pending: page.state.pending,
  }
}
