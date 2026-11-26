import { sql, type SQL } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import {
  TrackMergeCautionSchema,
  type LibraryChange,
} from '@repo/schemas/library-changes'
import {
  DuplicateReviewGroupSummarySchema,
  DuplicateReviewPageSchema,
  DuplicateReviewPairSchema,
  TrackDuplicateRuleSchema,
  type DuplicateReviewPage,
  type DuplicateReviewQuery,
  type TrackDuplicateCount,
  type TrackDuplicateCountQuery,
  type TrackDuplicateGroup,
  type TrackDuplicateLayout,
  type TrackDuplicates,
  type TrackSeparationRequest,
} from '@repo/schemas/track-duplicates'
import type { TrackMatchDiagnosticsQuery } from '@repo/schemas/match-diagnostics'
import { canReadDatabaseWithoutCache } from '@/lib/database-read-cache'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { lockLibraryTrackWrites } from './album-library-tracks'
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
import { listTrackMatchDiagnosticIds } from './track-match-diagnostics'
import { readTrackMergeSummaries } from './track-merge-plan'

const GroupRowsSchema = z.array(
  z.object({
    id: z.string(),
    rule: TrackDuplicateRuleSchema,
    evidence: z.array(z.string()),
    cautions: z.array(TrackMergeCautionSchema),
    member_count: z.number().int().min(2),
    scrobbles: z.number().int().nonnegative(),
    member_ids: z.array(z.string()),
    review_summary: DuplicateReviewGroupSummarySchema.nullish(),
    review_pairs: z.array(DuplicateReviewPairSchema).nullish(),
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

const latestDuplicateReview = sql`
  select id, reviewed_at from duplicate_review_run
  order by reviewed_at desc, id desc limit 1`

const priorReviewChanges = sql`
  jsonb_array_elements(case when jsonb_typeof(p.details->'priorChanges') = 'array'
    then p.details->'priorChanges' else '[]'::jsonb end)`

const duplicateReviewPairColumns = sql`
  p.kind, p.left_id as "leftId", p.right_id as "rightId",
  p.left_title as "leftTitle", p.right_title as "rightTitle",
  p.confidence, p.decision, p.evidence,
  case when p.details ? 'priorChanges' then
    jsonb_set(p.details, '{priorChanges}', coalesce((
      select jsonb_agg(prior.id order by prior.position) from (
        select earlier.id, min(entry.position) as position
        from ${priorReviewChanges} with ordinality as entry(value, position)
        join library_change earlier on earlier.id = (entry.value #>> '{}')
          and earlier.kind = p.kind and earlier.action = 'merge'
        where jsonb_typeof(entry.value) = 'string'
          and earlier.id is distinct from p.change_id
        group by earlier.id
      ) prior
    ), '[]'::jsonb))
  else p.details end as details,
  p.reason,
  p.target_id as "targetId",
  coalesce(
    case when c.target->>'id' = p.target_id then c.target->>'title' end,
    case p.target_id when p.left_id then p.left_title when p.right_id then p.right_title end
  ) as "targetTitle",
  p.change_id as "changeId", c.undone_at is not null as undone`

const DuplicateReviewReadSchema = DuplicateReviewPageSchema.pick({
  review: true,
  items: true,
  totalCount: true,
})

/** The latest saved review, including decisions for records that no longer exist. */
export async function readDuplicateReview({
  q,
  kind,
  decision,
  confidence,
  page,
  size,
}: DuplicateReviewQuery): Promise<DuplicateReviewPage> {
  const pattern = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : undefined
  const matches = sql.join(
    [
      kind ? sql`p.kind = ${kind}` : sql`true`,
      decision ? sql`p.decision = ${decision}` : sql`true`,
      confidence ? sql`p.confidence = ${confidence}` : sql`true`,
      pattern
        ? sql`(
            p.left_title ilike ${pattern} or p.right_title ilike ${pattern}
            or (p.details->>'leftCredits') ilike ${pattern}
            or (p.details->>'rightCredits') ilike ${pattern}
          )`
        : sql`true`,
    ],
    sql` and `,
  )
  const result = await db.execute(sql`
    with latest_review as (${latestDuplicateReview}),
    review_pairs as not materialized (
      select * from duplicate_review_pair where run_id = (select id from latest_review)
    ), merge_ids as (
      select p.kind, p.change_id as id from review_pairs p where p.change_id is not null
      union
      select p.kind, entry.value #>> '{}' as id
      from review_pairs p cross join lateral ${priorReviewChanges} as entry(value)
      where jsonb_typeof(entry.value) = 'string'
    ), totals as (
      select count(*)::int as "pairCount",
        (select count(*)::int from merge_ids m join library_change c
          on c.id = m.id and c.kind = m.kind and c.action = 'merge') as "mergeCount",
        count(*) filter (where ${matches})::int as "totalCount"
      from review_pairs p
    ), page_pairs as (
      select * from review_pairs p where ${matches}
      order by p.kind, p.left_id, p.right_id
      limit ${size} offset ${(page - 1) * size}
    ), page_rows as (
      select ${duplicateReviewPairColumns}
      from page_pairs p left join library_change c on c.id = p.change_id
    )
    select case when r.id is not null then jsonb_build_object(
      'id', r.id,
      'reviewedAt', to_char(r.reviewed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'pairCount', totals."pairCount",
      'mergeCount', totals."mergeCount"
    ) end as review,
    totals."totalCount",
    coalesce((select jsonb_agg(page_rows order by kind, "leftId", "rightId")
      from page_rows), '[]'::jsonb) as items
    from totals left join latest_review r on true
  `)
  const stored = DuplicateReviewReadSchema.parse(result.rows[0])
  return {
    ...stored,
    page,
    size,
    pageCount: Math.ceil(stored.totalCount / size),
  }
}

const duplicateGroupReviewSummary = sql`
  select group_id, jsonb_build_object(
    'pairCount', count(*)::int,
    'confidence', case when min(confidence) = max(confidence) then min(confidence) end,
    'decision', case when min(decision) = max(decision) then min(decision) end
  ) as review_summary
  from historical_pairs group by group_id`

const duplicateGroupReviewDetails = sql`
  select group_id, jsonb_agg(to_jsonb(pair_rows) - 'group_id'
    order by "leftId", "rightId") as review_pairs
  from (
    select p.group_id, ${duplicateReviewPairColumns}
    from historical_pairs p left join library_change c on c.id = p.change_id
  ) pair_rows group by group_id`

/** The groups, with what Merge would do to each, read for all of them together. */
async function readGroups(
  where: SQL,
  review: 'summary' | 'pairs',
): Promise<TrackDuplicateGroup[]> {
  const rows = GroupRowsSchema.parse(
    (
      await db.execute(sql`
        with groups as (
          select g.id, g.rule, g.evidence, g.cautions, g.member_count, g.scrobbles, g.rank,
            array(select m.track_id from track_duplicate_member m
              where m.group_id = g.id order by m.position) as member_ids
          from track_duplicate_group g where ${where}
        ), historical_pairs as (
          select l.group_id, p.*
          from duplicate_review_pair p
          join track_duplicate_member l on l.track_id = p.left_id
          join groups g on g.id = l.group_id
          join track_duplicate_member r on r.group_id = l.group_id and r.track_id = p.right_id
          where p.kind = 'track' and p.run_id = (select id from (${latestDuplicateReview}) review)
        ), review_groups as (
          ${review === 'summary' ? duplicateGroupReviewSummary : duplicateGroupReviewDetails}
        )
        select g.*, review_groups.*
        from groups g left join review_groups on review_groups.group_id = g.id
        order by g.rank`)
    ).rows,
  )
  const merges = await readTrackMergeSummaries(
    db,
    rows.map((row) => row.member_ids),
  )
  return rows.map((row, index) => ({
    id: row.id,
    rule: row.rule,
    evidence: row.evidence,
    cautions: row.cautions,
    memberCount: row.member_count,
    scrobbles: row.scrobbles,
    memberIds: row.member_ids,
    merge: merges[index] ?? null,
    ...(row.review_summary ? { reviewSummary: row.review_summary } : {}),
    ...(row.review_pairs ? { reviewPairs: row.review_pairs } : {}),
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
 * Where each group's rows are in the Possible duplicates view of a Matches
 * query, with what the group row shows. Rows are in the order the Matches page
 * returns them with `duplicates`.
 */
export async function readTrackDuplicateLayout(
  query: TrackMatchDiagnosticsQuery,
  userId?: string,
): Promise<TrackDuplicateLayout> {
  const { ids, totalCount } = await listTrackMatchDiagnosticIds(
    { ...query, duplicates: true },
    userId,
  )
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
        'summary',
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
    'pairs',
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
