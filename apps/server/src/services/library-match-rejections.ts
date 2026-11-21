import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { libraryMatchRejection } from '@/schemas/db'
import {
  defineChangeEffect,
  type ChangeEffectEntry,
  type ChangeEffectHandler,
  type ChangeReader,
  type ChangeTransaction,
} from './library-change-effect'

/** A scrobbled artist and track name of one account. */
export type RejectedName = { artistKey: string; trackKey: string }

const RejectionSchema = z.object({
  username: z.string(),
  artistKey: z.string(),
  trackKey: z.string(),
  recordId: z.string(),
  rule: z.string().nullable(),
  reason: z.string(),
  changeId: z.string().nullable(),
})
type Rejection = z.infer<typeof RejectionSchema>
const RejectionRowsSchema = z.array(
  z.object({
    username: z.string(),
    artist_key: z.string(),
    track_key: z.string(),
    record_id: z.string(),
    rule: z.string().nullable(),
    reason: z.string(),
    change_id: z.string().nullable(),
  }),
)

const nameKey = (artistKey: string, trackKey: string) =>
  JSON.stringify([artistKey, trackKey])

const rejectionsInput = (rows: Rejection[]) =>
  sql`jsonb_to_recordset(${JSON.stringify(
    rows.map((row) => ({
      username: row.username,
      artist_key: row.artistKey,
      track_key: row.trackKey,
      record_id: row.recordId,
      rule: row.rule,
      reason: row.reason,
      change_id: row.changeId,
    })),
  )}::jsonb) as r(username text, artist_key text, track_key text,
    record_id text, rule text, reason text, change_id text)`

async function readRows(
  reader: ChangeReader,
  username: string,
  names?: RejectedName[],
): Promise<Rejection[]> {
  if (names?.length === 0) return []
  const filter = names
    ? sql`and (artist_key, track_key) in (${sql.join(
        names.map(
          ({ artistKey, trackKey }) => sql`(${artistKey}, ${trackKey})`,
        ),
        sql`, `,
      )})`
    : sql``
  return RejectionRowsSchema.parse(
    (
      await reader.execute(sql`
        select username, artist_key, track_key, record_id, rule, reason,
          change_id
        from library_match_rejection where username = ${username} ${filter}`)
    ).rows,
  ).map((row) => ({
    username: row.username,
    artistKey: row.artist_key,
    trackKey: row.track_key,
    recordId: row.record_id,
    rule: row.rule,
    reason: row.reason,
    changeId: row.change_id,
  }))
}

/**
 * The tracks each scrobbled name of an account must not be matched to again,
 * by the name's `[artistKey, trackKey]` as JSON: matches the owner undid or
 * separated.
 */
export async function readRejections(
  reader: ChangeReader,
  username: string,
): Promise<Map<string, Set<string>>> {
  const rejected = new Map<string, Set<string>>()
  for (const row of await readRows(reader, username)) {
    const key = nameKey(row.artistKey, row.trackKey)
    rejected.set(key, (rejected.get(key) ?? new Set()).add(row.recordId))
  }
  return rejected
}

/**
 * Whether a scrobbled name of the account must not be matched to a track,
 * from one read. For the automatic rules: read once, then ask per match.
 */
export async function readRejectionTest(
  reader: ChangeReader,
  username: string,
): Promise<(artistKey: string, trackKey: string, trackId: string) => boolean> {
  const rejected = await readRejections(reader, username)
  return (artistKey, trackKey, trackId) =>
    rejected.get(nameKey(artistKey, trackKey))?.has(trackId) ?? false
}

async function insertRejections(tx: ChangeTransaction, rows: Rejection[]) {
  if (!rows.length) return
  // The change that stored a rejection can have been deleted since.
  await tx.execute(sql`
    insert into library_match_rejection (username, artist_key, track_key,
      record_id, rule, reason, change_id)
    select r.username, r.artist_key, r.track_key, r.record_id, r.rule,
      r.reason, (select c.id from library_change c where c.id = r.change_id)
    from ${rejectionsInput(rows)}
    on conflict do nothing`)
}

async function deleteRejections(tx: ChangeTransaction, rows: Rejection[]) {
  if (!rows.length) return
  await tx.execute(sql`
    delete from library_match_rejection x using ${rejectionsInput(rows)}
    where x.username = r.username and x.artist_key = r.artist_key
      and x.track_key = r.track_key and x.record_id = r.record_id`)
}

const matchRejections = defineChangeEffect({
  type: 'match-rejections',
  payload: z.object({
    rows: z.array(RejectionSchema),
    /** The change stored the rejections. False when it removed them. */
    stored: z.boolean(),
  }),
  blocker: async () => null,
  async apply(tx, { rows, stored }, direction) {
    if (stored === (direction === 'redo')) await insertRejections(tx, rows)
    else await deleteRejections(tx, rows)
    return null
  },
})

/**
 * Remembers that the owner separated a scrobbled name from the given tracks,
 * so no automatic rule matches it to them again. Returns the effect to record
 * with the change, or null when every rejection was stored already.
 */
export async function storeSeparatedMatches(
  tx: ChangeTransaction,
  {
    username,
    artistKey,
    trackKey,
    recordIds,
  }: RejectedName & { username: string; recordIds: string[] },
): Promise<ChangeEffectEntry | null> {
  if (!recordIds.length) return null
  const stored = await tx
    .insert(libraryMatchRejection)
    .values(
      [...new Set(recordIds)].map((recordId) => ({
        username,
        artistKey,
        trackKey,
        recordId,
        reason: 'separate',
      })),
    )
    .onConflictDoNothing()
    .returning({ recordId: libraryMatchRejection.recordId })
  return stored.length
    ? matchRejections.entry(
        {
          rows: stored.map(({ recordId }) => ({
            username,
            artistKey,
            trackKey,
            recordId,
            rule: null,
            reason: 'separate',
            changeId: null,
          })),
          stored: true,
        },
        stored.map(({ recordId }) => recordId),
      )
    : null
}

/**
 * Forgets every match the owner undid or separated for the given names of an
 * account, as returning them to automatic matching does. Returns the effect to
 * record with the change, or null when there was none.
 */
export async function clearRejections(
  tx: ChangeTransaction,
  username: string,
  names: RejectedName[],
): Promise<ChangeEffectEntry | null> {
  const rows = await readRows(tx, username, names)
  if (!rows.length) return null
  await deleteRejections(tx, rows)
  return matchRejections.entry(
    { rows, stored: false },
    rows.map((row) => row.recordId),
  )
}

/** Stored decisions that automatic matching reads. */
export const matchRejectionEffects: ChangeEffectHandler[] = [
  matchRejections.handler,
]
