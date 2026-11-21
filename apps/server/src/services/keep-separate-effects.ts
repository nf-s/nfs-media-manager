import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  LibraryChangeKindSchema,
  type LibraryChangeKind,
} from '@repo/schemas/library-changes'
import { libraryKeepSeparate } from '@/schemas/db'
import {
  defineChangeEffect,
  type ChangeEffectEntry,
  type ChangeEffectHandler,
  type ChangeReader,
  type ChangeTransaction,
} from './library-change-effect'
import { refreshTrackDuplicates } from './track-duplicate-refresh'

const PairSchema = z.object({ lowId: z.string(), highId: z.string() })
/** Two records the owner said are different, in a fixed order. */
export type SeparatePair = z.infer<typeof PairSchema>
const PairsSchema = z.array(PairSchema)

/** Every pair of the given records. */
export function recordPairs(ids: string[]): SeparatePair[] {
  const sorted = [...new Set(ids)].sort()
  return sorted.flatMap((lowId, index) =>
    sorted.slice(index + 1).map((highId) => ({ lowId, highId })),
  )
}

const idArray = (ids: string[]) =>
  sql`array[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]`

const pairsInput = (pairs: SeparatePair[]) =>
  sql`jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb)
    as r("lowId" text, "highId" text)`

/**
 * The pairs among the given records that the owner keeps separate. With
 * `others`, also the pairs of a given record with any other record.
 */
export async function readKeptSeparate(
  reader: ChangeReader,
  kind: LibraryChangeKind,
  ids: string[],
  { others = false }: { others?: boolean } = {},
): Promise<SeparatePair[]> {
  if (!ids.length) return []
  const given = idArray(ids)
  return PairsSchema.parse(
    (
      await reader.execute(sql`
        select low_id as "lowId", high_id as "highId"
        from library_keep_separate
        where kind = ${kind} and ${
          others
            ? sql`(low_id = any(${given}) or high_id = any(${given}))`
            : sql`low_id = any(${given}) and high_id = any(${given})`
        }`)
    ).rows,
  )
}

/**
 * Whether two of the given records are kept separate, from one read. For the
 * automatic rules: pass every record a run may join, then ask per pair.
 */
export async function readKeptSeparateTest(
  reader: ChangeReader,
  kind: LibraryChangeKind,
  ids: string[],
): Promise<(left: string, right: string) => boolean> {
  const pairs = new Set(
    (await readKeptSeparate(reader, kind, ids)).map(({ lowId, highId }) =>
      JSON.stringify([lowId, highId]),
    ),
  )
  return (left, right) =>
    pairs.has(JSON.stringify(left < right ? [left, right] : [right, left]))
}

/** The possible duplicates around the records of a decision, worked out again. */
const refreshDuplicates =
  (tx: ChangeTransaction, kind: LibraryChangeKind, pairs: SeparatePair[]) =>
  async () => {
    if (kind === 'track')
      await refreshTrackDuplicates(tx, {
        trackIds: [
          ...new Set(pairs.flatMap(({ lowId, highId }) => [lowId, highId])),
        ],
      })
  }

const keepSeparate = defineChangeEffect({
  type: 'keep-separate',
  payload: z.object({
    kind: LibraryChangeKindSchema,
    pairs: PairsSchema,
    /** The change stored the decisions. False when it removed them. */
    stored: z.boolean(),
  }),
  blocker: async () => null,
  async apply(tx, { kind, pairs, stored }, direction, { changeId }) {
    if (!pairs.length) return null
    if (stored === (direction === 'redo'))
      await tx
        .insert(libraryKeepSeparate)
        .values(
          pairs.map((pair) => ({
            ...pair,
            kind,
            changeId: stored ? changeId : null,
          })),
        )
        .onConflictDoNothing()
    else
      await tx.execute(sql`
        delete from library_keep_separate k using ${pairsInput(pairs)}
        where k.kind = ${kind} and k.low_id = r."lowId"
          and k.high_id = r."highId"`)
    return refreshDuplicates(tx, kind, pairs)
  },
})

/**
 * The effect `storeKeptSeparate` will record for the given records, without
 * storing anything yet, or null when every pair is stored already. The
 * decision refers to its change, so record the change with this effect
 * first, then store the decision with the change's ID.
 */
export async function keptSeparateEntry(
  reader: ChangeReader,
  kind: LibraryChangeKind,
  ids: string[],
): Promise<ChangeEffectEntry | null> {
  const stored = new Set(
    (await readKeptSeparate(reader, kind, ids)).map(({ lowId, highId }) =>
      JSON.stringify([lowId, highId]),
    ),
  )
  const pairs = recordPairs(ids).filter(
    ({ lowId, highId }) => !stored.has(JSON.stringify([lowId, highId])),
  )
  return pairs.length
    ? keepSeparate.entry({ kind, pairs, stored: true }, ids)
    : null
}

/**
 * Stores that the given records are different from each other. Returns the
 * effect to record with the change, or null when every pair was stored
 * already. Pass the change's ID as `recordChange` will be given it.
 */
export async function storeKeptSeparate(
  tx: ChangeTransaction,
  kind: LibraryChangeKind,
  ids: string[],
  changeId: string,
): Promise<ChangeEffectEntry | null> {
  const pairs = recordPairs(ids)
  if (!pairs.length) return null
  const stored = await tx
    .insert(libraryKeepSeparate)
    .values(pairs.map((pair) => ({ ...pair, kind, changeId })))
    .onConflictDoNothing()
    .returning({
      lowId: libraryKeepSeparate.lowId,
      highId: libraryKeepSeparate.highId,
    })
  return stored.length
    ? keepSeparate.entry({ kind, pairs: stored, stored: true }, ids)
    : null
}

/**
 * Forgets that the given records are different from each other, as a merge
 * of them does. Returns the effect to record with the change, or null when
 * no pair was stored.
 */
export async function clearKeptSeparate(
  tx: ChangeTransaction,
  kind: LibraryChangeKind,
  ids: string[],
): Promise<ChangeEffectEntry | null> {
  const pairs = await readKeptSeparate(tx, kind, ids)
  if (!pairs.length) return null
  await tx.execute(sql`
    delete from library_keep_separate k using ${pairsInput(pairs)}
    where k.kind = ${kind} and k.low_id = r."lowId"
      and k.high_id = r."highId"`)
  return keepSeparate.entry({ kind, pairs, stored: false }, ids)
}

export const keepSeparateEffects: ChangeEffectHandler[] = [keepSeparate.handler]
