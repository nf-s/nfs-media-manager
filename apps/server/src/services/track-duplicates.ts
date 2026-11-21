import { sql, type SQL } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import {
  TrackMergeCautionSchema,
  type LibraryChange,
} from '@repo/schemas/library-changes'
import {
  TrackDuplicateRuleSchema,
  type TrackDuplicateCount,
  type TrackDuplicateCountQuery,
  type TrackDuplicateGroup,
  type TrackDuplicateLayout,
  type TrackDuplicates,
  type TrackSeparationRequest,
} from '@repo/schemas/track-duplicates'
import type { TrackQuery } from '@repo/schemas/tracks'
import { canReadDatabaseWithoutCache } from '@/lib/database-read-cache'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { lockLibraryTrackWrites } from './album-library-tracks'
import { queryBrowseIds } from './browse'
import { keptSeparateEntry, storeKeptSeparate } from './keep-separate-effects'
import {
  getLibraryChange,
  readChangeRecords,
  recordChange,
} from './library-changes'
import { existingTrackIds } from './track-archive'
import {
  lockTrackDuplicates,
  refreshTrackDuplicates,
  trackDuplicateBuilder,
} from './track-duplicate-refresh'

const GroupRowsSchema = z.array(
  z.object({
    id: z.string(),
    rule: TrackDuplicateRuleSchema,
    evidence: z.array(z.string()),
    cautions: z.array(TrackMergeCautionSchema),
    member_count: z.number().int().min(2),
    scrobbles: z.number().int().nonnegative(),
    member_ids: z.array(z.string()),
  }),
)
const MemberRowsSchema = z.array(
  z.object({ track_id: z.string(), group_id: z.string() }),
)
const CountRowSchema = z.object({
  group_count: z.number().int().nonnegative().nullable(),
  artist_count: z.number().int().nonnegative().nullable(),
})
const ClaimRowSchema = z.object({ lease: z.string() })
const ReadyRowSchema = z.object({ ready: z.boolean() })

async function readGroups(where: SQL): Promise<TrackDuplicateGroup[]> {
  return GroupRowsSchema.parse(
    (
      await db.execute(sql`
        select g.id, g.rule, g.evidence, g.cautions, g.member_count, g.scrobbles,
          array(select m.track_id from track_duplicate_member m
            where m.group_id = g.id order by m.position) as member_ids
        from track_duplicate_group g where ${where}
        order by g.rank`)
    ).rows,
  ).map((row) => ({
    id: row.id,
    rule: row.rule,
    evidence: row.evidence,
    cautions: row.cautions,
    memberCount: row.member_count,
    scrobbles: row.scrobbles,
    memberIds: row.member_ids,
  }))
}

/**
 * The number on the Possible duplicates button, read from the stored groups.
 * With `creatorId`, the groups with a track credited to that artist, or to
 * the artist it was merged into.
 */
export async function countTrackDuplicateGroups({
  creatorId,
}: TrackDuplicateCountQuery): Promise<TrackDuplicateCount> {
  const row = CountRowSchema.parse(
    (
      await db.execute(sql`
        select (select group_count from track_duplicate_state where singleton)
            as group_count,
          ${
            creatorId
              ? sql`(select count(distinct m.group_id)::int
                  from track_duplicate_member m
                  join media_credit c on c.media_item_id = m.track_id
                  where c.role = 'artist' and c.artist_id = (
                    select coalesce(a.merged_into_id, a.id) from artist a
                    where a.id = ${creatorId}))`
              : sql`null::int`
          } as artist_count`)
    ).rows[0],
  )
  return {
    count: (creatorId ? row.artist_count : row.group_count) ?? 0,
    ready: row.group_count !== null,
  }
}

/**
 * Where each group's rows are in the Possible duplicates view of a browse
 * query, with what the group row shows. Rows are in the order the browse page
 * returns them with `duplicates`.
 */
export async function readTrackDuplicateLayout(
  query: TrackQuery,
): Promise<TrackDuplicateLayout> {
  const { ids, totalCount } = await queryBrowseIds('track', {
    ...query,
    duplicates: true,
    groupRecordings: false,
    limitResults: undefined,
    page: 1,
    size: Number.MAX_SAFE_INTEGER,
  })
  if (!ids.length) return { totalRows: totalCount, groups: [] }
  const memberOf = new Map(
    MemberRowsSchema.parse(
      (
        await db.execute(sql`
          select track_id, group_id from track_duplicate_member
          where track_id = any(${sql.param(ids)}::text[])`)
      ).rows,
    ).map((row) => [row.track_id, row.group_id]),
  )
  const runs: { groupId: string; offset: number; rowCount: number }[] = []
  ids.forEach((id, offset) => {
    const groupId = memberOf.get(id)
    if (!groupId) return
    const last = runs.at(-1)
    if (last?.groupId === groupId && last.offset + last.rowCount === offset)
      last.rowCount += 1
    else runs.push({ groupId, offset, rowCount: 1 })
  })
  const groups = new Map(
    (
      await readGroups(
        sql`g.id = any(${sql.param([...new Set(runs.map((run) => run.groupId))])}::text[])`,
      )
    ).map((group) => [group.id, group]),
  )
  return {
    totalRows: totalCount,
    groups: runs.flatMap(({ groupId, offset, rowCount }) => {
      const group = groups.get(groupId)
      return group ? [{ ...group, offset, rowCount }] : []
    }),
  }
}

/** The groups a track is in, with the other members, for its page. */
export async function listTrackDuplicates(
  trackId: string,
): Promise<TrackDuplicates> {
  const groups = await readGroups(
    sql`g.id in (select group_id from track_duplicate_member
      where track_id = ${trackId})`,
  )
  const records = new Map(
    (
      await readChangeRecords(db, 'track', [
        ...new Set(groups.flatMap((group) => group.memberIds)),
      ])
    ).map((record) => [record.id, record]),
  )
  return {
    items: groups.map((group) => ({
      ...group,
      others: group.memberIds.flatMap((id) => {
        const record = records.get(id)
        return id !== trackId && record ? [record] : []
      }),
    })),
  }
}

/**
 * Stores that the given tracks are different, as a change History lists and
 * Undo removes. Their group is no longer suggested.
 */
export async function keepTracksSeparate({
  trackIds,
}: TrackSeparationRequest): Promise<LibraryChange> {
  return db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    const present = await existingTrackIds(tx, trackIds)
    if (trackIds.some((id) => !present.has(id)))
      throw new ServerError({ statusCode: 404, message: 'Track not found.' })
    const effect = await keptSeparateEntry(tx, 'track', trackIds)
    if (!effect)
      throw new ServerError({
        statusCode: 409,
        message: 'These tracks are already kept separate.',
      })
    const records = new Map(
      (await readChangeRecords(tx, 'track', trackIds)).map((record) => [
        record.id,
        record,
      ]),
    )
    const id = nanoid()
    await recordChange(
      tx,
      {
        id,
        kind: 'track',
        action: 'keep-separate',
        target: null,
        sources: trackIds.flatMap((trackId) => {
          const record = records.get(trackId)
          return record ? [record] : []
        }),
      },
      { effects: [effect] },
    )
    await storeKeptSeparate(tx, 'track', trackIds, id)
    await refreshTrackDuplicates(tx, { trackIds })
    return getLibraryChange(id, tx)
  })
}

const staleState = sql`(track_duplicate_state.group_count is null
  or track_duplicate_state.builder <> ${trackDuplicateBuilder}
  or exists (select 1 from track_duplicate_dirty))`

/** A lease on the rebuild when the groups are out of date, else undefined. */
async function claimTrackDuplicateRebuild() {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '100ms'`)
    const row = (
      await tx.execute(sql`
        insert into track_duplicate_state (singleton, builder, retry_after)
        values (true, ${trackDuplicateBuilder},
          statement_timestamp() + interval '120 seconds')
        on conflict (singleton) do update set retry_after = excluded.retry_after
        where track_duplicate_state.retry_after <= statement_timestamp()
          and ${staleState}
        returning retry_after::text as lease`)
    ).rows[0]
    return row ? ClaimRowSchema.parse(row).lease : undefined
  })
}

/**
 * Rebuilds every possible duplicate group when a write since the last build
 * asked for it. Runs on the maintenance tick, off the request path. Returns
 * whether it published.
 */
export async function refreshTrackDuplicatesForMaintenance(): Promise<boolean> {
  try {
    const lease = await claimTrackDuplicateRebuild()
    if (!lease) return false
    return await db.transaction(async (tx) => {
      const guard = await tx.execute(sql`
        select set_config('lock_timeout', '5s', true),
          set_config('statement_timeout', '60s', true),
          pg_try_advisory_xact_lock(${lockTrackDuplicates})
            and exists (select 1 from track_duplicate_state
              where singleton and retry_after = ${lease}::timestamptz) as ready`)
      if (!ReadyRowSchema.parse(guard.rows[0]).ready) return false
      // Claim visible markers first. Later writes leave their own markers.
      await tx.execute(sql`
        delete from track_duplicate_dirty where transaction_id in (
          select transaction_id from track_duplicate_dirty
          for update skip locked)`)
      await refreshTrackDuplicates(tx)
      await tx.execute(sql`
        update track_duplicate_state
        set retry_after = clock_timestamp() + interval '5 seconds'
        where singleton`)
      return true
    })
  } catch (error) {
    // Lock waits, timeouts and tables not yet migrated leave the rebuild to
    // the next tick.
    if (canReadDatabaseWithoutCache(error)) return false
    throw error
  }
}
