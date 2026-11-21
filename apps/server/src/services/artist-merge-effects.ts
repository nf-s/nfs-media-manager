import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { refreshArtistListeningTotals } from './artist-listening'
import {
  defineChangeEffect,
  type ChangeEffectEntry,
  type ChangeEffectHandler,
  type ChangeReader,
  type ChangeTransaction,
} from './library-change-effect'

const CreditKeySchema = z.object({
  mediaItemId: z.string(),
  role: z.string(),
})
const MovedCreditSchema = CreditKeySchema.extend({
  /** The name shown with the credit before the merge. */
  creditedAs: z.string().nullable(),
})
const SharedCreditSchema = MovedCreditSchema.extend({
  billingOrder: z.number().int(),
  /** The kept artist's billing on the item before the merge. */
  targetBillingOrder: z.number().int(),
})
const MergePayloadSchema = z.object({
  sourceId: z.string(),
  sourceName: z.string(),
  targetId: z.string(),
  /** Names merged into the source before, which now point at the target. */
  names: z.array(z.string()),
  /** Credits of the source given to the target. */
  moved: z.array(MovedCreditSchema),
  /**
   * Credits of the source on an item and role the target was credited on.
   * They were removed; the target kept the earlier billing.
   */
  shared: z.array(SharedCreditSchema),
})
type MergePayload = z.infer<typeof MergePayloadSchema>

const ArtistRowsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    merged_into_id: z.string().nullable(),
  }),
)
type ArtistRow = z.infer<typeof ArtistRowsSchema>[number]
const IdRowsSchema = z.array(z.object({ id: z.string() }))
const MovedRowsSchema = z.array(
  z.object({
    media_item_id: z.string(),
    role: z.string(),
    credited_as: z.string().nullable(),
  }),
)
const SharedRowsSchema = z.array(
  z.object({
    media_item_id: z.string(),
    role: z.string(),
    credited_as: z.string().nullable(),
    billing_order: z.number().int(),
    target_billing_order: z.number().int(),
  }),
)
const CountRowsSchema = z.array(z.object({ count: z.number().int() }))

const ARTIST_GONE = 'An artist in this change is no longer in the library.'
const NAMES_MOVED =
  'A later change moved these artist names. Undo that change first.'
const TARGET_MERGED =
  'The artist kept was merged into another artist since. Undo that change first.'
const MERGED_SINCE =
  'An artist in this change was merged into another since. Undo that change first.'
const FILM_SINCE = 'An artist in this change now has film credits.'
const SHARED_SINCE =
  'Both artists have been credited on the same track or album since.'

/** Credits on items that are not albums or tracks: a film person's. */
const nonMusicCredits = (artistId: string) => sql`
  select 1 from media_credit c join media_item m on m.id = c.media_item_id
  where c.artist_id = ${artistId} and m.media_type not in ('album', 'track')`

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )

async function readArtists(reader: ChangeReader, ids: string[]) {
  return new Map<string, ArtistRow>(
    ArtistRowsSchema.parse(
      (
        await reader.execute(sql`
          select id, name, merged_into_id from artist
          where id in (${idList(ids)})`)
      ).rows,
    ).map((row) => [row.id, row]),
  )
}

/**
 * Makes the source a name the target keeps: names merged into the source
 * point at the target, every credit of the source goes to the target with the
 * name it was given, and a credit the target already has on the item is
 * removed, the target keeping the earlier billing.
 */
async function moveArtist(
  tx: ChangeTransaction,
  sourceId: string,
  targetId: string,
) {
  const names = IdRowsSchema.parse(
    (
      await tx.execute(sql`
        update artist set merged_into_id = ${targetId}
        where merged_into_id = ${sourceId} returning id`)
    ).rows,
  ).map((row) => row.id)
  const shared = SharedRowsSchema.parse(
    (
      await tx.execute(sql`
        select s.media_item_id, s.role, s.credited_as, s.billing_order,
          t.billing_order as target_billing_order
        from media_credit s join media_credit t
          on t.media_item_id = s.media_item_id and t.role = s.role
            and t.artist_id = ${targetId}
        where s.artist_id = ${sourceId}
        order by s.media_item_id, s.role`)
    ).rows,
  )
  if (shared.length) {
    await tx.execute(sql`
      update media_credit t set billing_order = s.billing_order
      from media_credit s
      where s.artist_id = ${sourceId} and t.artist_id = ${targetId}
        and t.media_item_id = s.media_item_id and t.role = s.role
        and s.billing_order < t.billing_order`)
    await tx.execute(sql`
      delete from media_credit s using media_credit t
      where s.artist_id = ${sourceId} and t.artist_id = ${targetId}
        and t.media_item_id = s.media_item_id and t.role = s.role`)
  }
  const moved = MovedRowsSchema.parse(
    (
      await tx.execute(sql`
        select media_item_id, role, credited_as from media_credit
        where artist_id = ${sourceId} order by media_item_id, role`)
    ).rows,
  )
  await tx.execute(sql`
    update media_credit c set artist_id = ${targetId},
      credited_as = coalesce(c.credited_as, a.name)
    from artist a
    where a.id = ${sourceId} and c.artist_id = ${sourceId}`)
  await tx.execute(sql`
    update artist set merged_into_id = ${targetId} where id = ${sourceId}`)
  return { names, shared, moved }
}

const recount = (tx: ChangeTransaction, ids: string[]) => async () =>
  refreshArtistListeningTotals(tx, ids)

async function undoMerge(tx: ChangeTransaction, payload: MergePayload) {
  const { sourceId, targetId, names, moved, shared } = payload
  await tx.execute(sql`
    update artist set merged_into_id = null
    where id = ${sourceId} and merged_into_id = ${targetId}`)
  if (names.length)
    await tx.execute(sql`
      update artist set merged_into_id = ${sourceId}
      where id in (${idList(names)}) and merged_into_id = ${targetId}`)
  await tx.execute(sql`
    update media_credit c set artist_id = ${sourceId}, credited_as = r."creditedAs"
    from jsonb_to_recordset(${JSON.stringify(moved)}::jsonb)
      as r("mediaItemId" text, role text, "creditedAs" text), artist source
    where source.id = ${sourceId} and c.artist_id = ${targetId}
      and c.media_item_id = r."mediaItemId" and c.role = r.role
      and c.credited_as is not distinct from coalesce(r."creditedAs", source.name)
      and not exists (select 1 from media_credit o
        where o.media_item_id = c.media_item_id and o.role = c.role
          and o.artist_id = ${sourceId})`)
  // A credit an import gave under one of the source's names since returns
  // too; the source's own name is shown without a credited name.
  await tx.execute(sql`
    update media_credit c set artist_id = ${sourceId},
      credited_as = case when lower(c.credited_as) = lower(source.name)
        then null else c.credited_as end
    from artist source
    where source.id = ${sourceId} and c.artist_id = ${targetId}
      and lower(c.credited_as) in (
        select lower(n.name) from artist n
        where n.id in (${idList([sourceId, ...names])}))
      and not exists (select 1 from media_credit o
        where o.media_item_id = c.media_item_id and o.role = c.role
          and o.artist_id = ${sourceId})`)
  if (shared.length) {
    const rows = JSON.stringify(shared)
    const input = sql`jsonb_to_recordset(${rows}::jsonb) as r("mediaItemId" text,
      role text, "creditedAs" text, "billingOrder" int,
      "targetBillingOrder" int)`
    await tx.execute(sql`
      update media_credit t set billing_order = r."targetBillingOrder"
      from ${input}
      where t.artist_id = ${targetId} and t.media_item_id = r."mediaItemId"
        and t.role = r.role
        and t.billing_order = least(r."billingOrder", r."targetBillingOrder")`)
    await tx.execute(sql`
      insert into media_credit
        (media_item_id, artist_id, role, billing_order, credited_as)
      select r."mediaItemId", ${sourceId}, r.role, r."billingOrder",
        r."creditedAs"
      from ${input}
      where exists (select 1 from media_item m where m.id = r."mediaItemId")
      on conflict do nothing`)
  }
}

const artistMerge = defineChangeEffect({
  type: 'artist-merge',
  payload: MergePayloadSchema,
  async blocker(reader, { sourceId, targetId, names, shared }, direction) {
    const rows = await readArtists(reader, [sourceId, targetId, ...names])
    const source = rows.get(sourceId)
    const target = rows.get(targetId)
    if (!source || !target) return ARTIST_GONE
    const kept = names.flatMap((id) => {
      const row = rows.get(id)
      return row ? [row] : []
    })
    if (direction === 'undo') {
      if (target.merged_into_id !== null) return TARGET_MERGED
      if (source.merged_into_id !== targetId) return NAMES_MOVED
      if (kept.some((row) => row.merged_into_id !== targetId))
        return NAMES_MOVED
      return null
    }
    if (source.merged_into_id !== null || target.merged_into_id !== null)
      return MERGED_SINCE
    if (kept.some((row) => row.merged_into_id !== sourceId)) return NAMES_MOVED
    const [others] = CountRowsSchema.parse(
      (
        await reader.execute(sql`
          select count(*)::int as count from artist
          where merged_into_id = ${sourceId}
            ${names.length ? sql`and id not in (${idList(names)})` : sql``}`)
      ).rows,
    )
    if (others?.count) return NAMES_MOVED
    const [film] = CountRowsSchema.parse(
      (
        await reader.execute(
          sql`select count(*)::int as count from (${nonMusicCredits(sourceId)}) film`,
        )
      ).rows,
    )
    if (film?.count) return FILM_SINCE
    const recorded = JSON.stringify(
      shared.map(({ mediaItemId, role }) => ({ mediaItemId, role })),
    )
    const [unrecorded] = CountRowsSchema.parse(
      (
        await reader.execute(sql`
          select count(*)::int as count
          from media_credit s join media_credit t
            on t.media_item_id = s.media_item_id and t.role = s.role
              and t.artist_id = ${targetId}
          where s.artist_id = ${sourceId} and not exists (
            select 1 from jsonb_to_recordset(${recorded}::jsonb)
              as r("mediaItemId" text, role text)
            where r."mediaItemId" = s.media_item_id and r.role = s.role)`)
      ).rows,
    )
    return unrecorded?.count ? SHARED_SINCE : null
  },
  async apply(tx, payload, direction) {
    if (direction === 'undo') await undoMerge(tx, payload)
    else await moveArtist(tx, payload.sourceId, payload.targetId)
    return recount(tx, [payload.sourceId, payload.targetId])
  },
})

/**
 * Merges one artist into another, as described at `moveArtist`, and returns
 * the effect to record with the change and what moved.
 */
export async function mergeArtistInto(
  tx: ChangeTransaction,
  source: { id: string; name: string },
  targetId: string,
): Promise<{
  entry: ChangeEffectEntry
  credits: number
  names: number
}> {
  const { names, shared, moved } = await moveArtist(tx, source.id, targetId)
  const payload: MergePayload = {
    sourceId: source.id,
    sourceName: source.name,
    targetId,
    names,
    moved: moved.map((row) => ({
      mediaItemId: row.media_item_id,
      role: row.role,
      creditedAs: row.credited_as,
    })),
    shared: shared.map((row) => ({
      mediaItemId: row.media_item_id,
      role: row.role,
      creditedAs: row.credited_as,
      billingOrder: row.billing_order,
      targetBillingOrder: row.target_billing_order,
    })),
  }
  return {
    entry: artistMerge.entry(payload, [source.id, targetId, ...names]),
    credits: moved.length + shared.length,
    names: names.length + 1,
  }
}

/** Merging artist names and moving their credits. */
export const artistMergeEffects: ChangeEffectHandler[] = [artistMerge.handler]
