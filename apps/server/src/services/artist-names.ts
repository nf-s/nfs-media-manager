import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { db } from '@/lib/db'
import { createStableId } from '@/lib/media-utils'
import { artist } from '@/schemas/db'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Reader = Pick<typeof db, 'execute'>

const WRITE_BATCH = 500

/** Explicit additions and discoveries stay on the identity that received them so undo restores its membership. */
export function artistFamilyAdded(id: SQL) {
  return sql`(${id} in (select n.id from artist n where n.added_to_library)
    or ${id} in (select n.merged_into_id from artist n where n.merged_into_id is not null and n.added_to_library))`
}

export function artistFamilyObserved(id: SQL) {
  return sql`(exists (select 1 from catalog_observation o where o.target_kind = 'artist' and o.target_id = ${id})
    or ${id} in (select n.merged_into_id from artist n where n.merged_into_id is not null and
      exists (select 1 from catalog_observation o where o.target_kind = 'artist' and o.target_id = n.id)))`
}

const ResolvedRowsSchema = z.array(
  z.object({
    name: z.string(),
    id: z.string(),
    credited_as: z.string().nullable(),
  }),
)
const CurrentRowsSchema = z.array(z.object({ id: z.string() }))
const KeptNameRowsSchema = z.array(
  z.object({ id: z.string(), name: z.string() }),
)

/** The artist an import credits for a name, and the name to show with it. */
export type ResolvedArtist = {
  artistId: string
  /** The name, when it is a name merged into the artist; otherwise null. */
  creditedAs: string | null
}

/**
 * The artist to credit for each name, creating an artist for a new name. A
 * name merged into another artist resolves to that artist. An existing
 * artist of the same name is used even when its ID was made differently.
 */
export async function resolveArtistIds(
  tx: Transaction,
  names: string[],
): Promise<Map<string, ResolvedArtist>> {
  const input = [...new Set(names)].map((name) => ({
    name,
    id: createStableId('artist', name.toLowerCase()),
  }))
  if (!input.length) return new Map()
  for (let start = 0; start < input.length; start += WRITE_BATCH)
    await tx
      .insert(artist)
      .values(
        input
          .slice(start, start + WRITE_BATCH)
          .map(({ id, name }) => ({ id, name, sortName: name })),
      )
      .onConflictDoNothing()
  const rows = ResolvedRowsSchema.parse(
    (
      await tx.execute(sql`
        select r.name, coalesce(a.merged_into_id, a.id) as id,
          case when a.merged_into_id is null then null else r.name end
            as credited_as
        from jsonb_to_recordset(${JSON.stringify(input)}::jsonb)
          as r(name text, id text)
        join lateral (select id, merged_into_id from artist
          where catalog_provider is null and (id = r.id or name = r.name)
          order by case when name = r.name then 0 else 1 end limit 1) a on true`)
    ).rows,
  )
  return new Map(
    rows.map((row) => [
      row.name,
      { artistId: row.id, creditedAs: row.credited_as },
    ]),
  )
}

export type ArtistCreditInput = {
  mediaItemId: string
  /** The name the source gave. */
  name: string
  role: string
  billingOrder: number
  /** Kept from an earlier credit, in place of the resolved name. */
  creditedAs?: string | null
}

/**
 * Credits the artists the names resolve to. Where two names resolve to one
 * artist in the same role on an item, the first in billing order is kept.
 * Existing credits of the items are left; callers delete what they replace.
 */
export async function writeArtistCredits(
  tx: Transaction,
  credits: ArtistCreditInput[],
) {
  if (!credits.length) return
  const resolved = await resolveArtistIds(
    tx,
    credits.map((credit) => credit.name),
  )
  const rows = credits
    .flatMap((credit) => {
      const target = resolved.get(credit.name)
      return target
        ? [
            {
              media_item_id: credit.mediaItemId,
              artist_id: target.artistId,
              role: credit.role,
              billing_order: credit.billingOrder,
              credited_as: credit.creditedAs ?? target.creditedAs,
            },
          ]
        : []
    })
    .sort(
      (left, right) =>
        left.media_item_id.localeCompare(right.media_item_id) ||
        left.role.localeCompare(right.role) ||
        left.billing_order - right.billing_order,
    )
  for (let start = 0; start < rows.length; start += WRITE_BATCH)
    await tx.execute(sql`
      insert into media_credit
        (media_item_id, artist_id, role, billing_order, credited_as)
      select r.media_item_id, r.artist_id, r.role, r.billing_order,
        r.credited_as
      from jsonb_to_recordset(${JSON.stringify(
        rows.slice(start, start + WRITE_BATCH),
      )}::jsonb) as r(media_item_id text, artist_id text, role text,
        billing_order int, credited_as text)
      order by r.media_item_id, r.role, r.billing_order
      on conflict do nothing`)
}

/**
 * The artist an artist ID reads as: the artist a merged name was merged
 * into, else the ID itself.
 */
export async function currentArtistId(reader: Reader, id: string) {
  const [row] = CurrentRowsSchema.parse(
    (
      await reader.execute(sql`
        select coalesce(merged_into_id, id) as id from artist where id = ${id}`)
    ).rows,
  )
  return row?.id ?? id
}

/** The names merged into an artist, which the artist keeps. */
export async function listKeptArtistNames(reader: Reader, artistId: string) {
  return KeptNameRowsSchema.parse(
    (
      await reader.execute(sql`
        select id, name from artist where merged_into_id = ${artistId}
        order by lower(name), id`)
    ).rows,
  )
}
